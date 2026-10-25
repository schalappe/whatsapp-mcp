/**
 * @module tools
 * Four read-only MCP tools: handlers + registration. Guards: access, limits, redaction, audit.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.ts";
import type { AuditLogger } from "./audit.ts";
import { type ReadOnlyDb, toMessageOut, type MessageRow } from "./db.ts";
import {
	applyRedaction,
	isRedactedJid,
	resolveRedactedJid,
	type RedactedMessage,
} from "./redact.ts";
import { isChatAllowed } from "./access.ts";
import {
	encodeCursor,
	decodeMessageCursor,
	decodeChatCursor,
} from "./cursor.ts";
import { normalizeTimestamp } from "./time.ts";

export interface ToolContext {
	db: ReadOnlyDb;
	config: Config;
	audit: AuditLogger;
}

/** Error safe to surface to MCP client. */
export class ToolError extends Error {
	constructor(
		message: string,
		readonly outcome: "denied" | "error" = "error",
	) {
		super(message);
	}
}

function requireChatAccess(ctx: ToolContext, chatId: string): string {
	let resolved = chatId;
	if (isRedactedJid(chatId)) {
		const real = resolveRedactedJid(chatId, ctx.db.allChatJids());
		if (!real) {
			throw new ToolError(`unknown chat_id: ${chatId}`);
		}
		resolved = real;
	}
	if (!isChatAllowed(resolved, ctx.config.access)) {
		throw new ToolError(
			`access to chat ${chatId} is denied by configuration`,
			"denied",
		);
	}
	return resolved;
}

function clampLimit(
	requested: number | undefined,
	max: number,
	fallback = 50,
): number {
	const base = requested ?? Math.min(fallback, max);
	return Math.max(1, Math.min(max, Math.floor(base)));
}

const MAX_MEDIA_ITEMS_PER_CALL = 3;
const MAX_MEDIA_BYTES_PER_CALL = 25 << 20;

function redact(ctx: ToolContext, row: MessageRow): RedactedMessage {
	return applyRedaction(toMessageOut(row), ctx.config.privacy);
}

interface IncludeMediaArgs {
	chat_id?: unknown;
	include_media?: unknown;
	max_media_items?: unknown;
}

async function mediaContentBlocks(
	ctx: ToolContext,
	args: IncludeMediaArgs,
	result: Record<string, unknown>,
): Promise<ContentBlock[]> {
	if (args.include_media !== true || typeof args.chat_id !== "string") {
		return [];
	}
	const chatJid = requireChatAccess(ctx, args.chat_id);
	const messages = Array.isArray(result.messages) ? result.messages : [];
	const requested =
		typeof args.max_media_items === "number" ? args.max_media_items : undefined;
	const maxItems = clampLimit(
		requested,
		MAX_MEDIA_ITEMS_PER_CALL,
		MAX_MEDIA_ITEMS_PER_CALL,
	);
	const blocks: ContentBlock[] = [];
	let itemCount = 0;
	let remainingBytes = MAX_MEDIA_BYTES_PER_CALL;

	for (const message of messages) {
		if (itemCount >= maxItems || remainingBytes <= 0) {
			break;
		}
		if (
			typeof message !== "object" ||
			message === null ||
			!("id" in message) ||
			typeof message.id !== "string"
		) {
			continue;
		}
		const row = ctx.db.getMessage(chatJid, message.id);
		const mediaType =
			row?.message_type === "image" && row.media_mime_type?.startsWith("image/")
				? "image"
				: row?.message_type === "audio" &&
						row.media_mime_type?.startsWith("audio/")
					? "audio"
					: null;
		if (
			!row?.media_file_name ||
			!row.media_mime_type ||
			!row.media_size_bytes ||
			row.media_size_bytes > remainingBytes ||
			!mediaType
		) {
			continue;
		}
		const path = ctx.db.resolveMediaPath(row.media_file_name);
		if (!path) {
			continue;
		}
		try {
			const file = Bun.file(path);
			if (
				!(await file.exists()) ||
				file.size === 0 ||
				file.size > remainingBytes
			) {
				continue;
			}
			const bytes = await file.arrayBuffer();
			if (bytes.byteLength === 0 || bytes.byteLength > remainingBytes) {
				continue;
			}
			blocks.push(
				{ type: "text", text: `Media for message ${row.id}` },
				{
					type: mediaType,
					data: Buffer.from(bytes).toString("base64"),
					mimeType: row.media_mime_type,
				},
			);
			itemCount++;
			remainingBytes -= bytes.byteLength;
		} catch {
			// [>]: stale/deleted file -> omit attachment
		}
	}
	return blocks;
}

// ---------------------------------------------------------------- list_chats

export interface ListChatsArgs {
	query?: string;
	limit?: number;
	cursor?: string;
	include_last_message?: boolean;
}

export function handleListChats(ctx: ToolContext, args: ListChatsArgs) {
	const limit = clampLimit(
		args.limit,
		ctx.config.privacy.max_messages_per_call,
	);
	const offset = args.cursor ? decodeChatCursor(args.cursor).offset : 0;
	// [>]: chats table small -> filter access in-process; offsets stable under allow/blocklist
	const allowed = ctx.db
		.listChats({ query: args.query, limit: 1_000_000, offset: 0 })
		.filter((chat) => isChatAllowed(chat.jid, ctx.config.access));
	const page = allowed.slice(offset, offset + limit);

	const redactIds =
		ctx.config.privacy.redact_jids || ctx.config.privacy.redact_phone_numbers;
	const chats = page.map((chat) => {
		const lastRow = args.include_last_message
			? ctx.db.lastMessageForChat(chat.jid)
			: null;
		return {
			id: redactIds
				? applyRedaction(chatIdCarrier(chat.jid), ctx.config.privacy).chat_id
				: chat.jid,
			name: chat.name ?? null,
			is_group: chat.is_group === 1,
			last_message_at: chat.last_message_at ?? null,
			...(args.include_last_message
				? { last_message: lastRow ? redact(ctx, lastRow) : null }
				: {}),
		};
	});

	return {
		chats,
		next_cursor:
			offset + limit < allowed.length
				? encodeCursor({ offset: offset + limit })
				: null,
	};
}

function chatIdCarrier(jid: string): RedactedMessage {
	return {
		id: "",
		chat_id: jid,
		timestamp: "",
		role: "other",
		sender_jid: "",
		sender_display_name: "",
		content: "",
		message_type: "",
	};
}

// ----------------------------------------------------------- search_messages

export interface SearchMessagesArgs {
	chat_id?: string;
	query?: string;
	after?: string;
	before?: string;
	sender_role?: "me" | "other" | "any";
	limit?: number;
	cursor?: string;
}

export function handleSearchMessages(
	ctx: ToolContext,
	args: SearchMessagesArgs,
) {
	if (!args.chat_id && !args.query && !args.after && !args.before) {
		throw new ToolError(
			"query too broad: provide at least one of chat_id, query, after or before",
			"denied",
		);
	}
	const limit = clampLimit(
		args.limit,
		ctx.config.privacy.max_messages_per_call,
	);
	const chatJid = args.chat_id
		? requireChatAccess(ctx, args.chat_id)
		: undefined;

	const rows = ctx.db.searchMessages({
		chatJid,
		query: args.query,
		after: args.after ? normalizeTimestamp(args.after, "after") : undefined,
		before: args.before ? normalizeTimestamp(args.before, "before") : undefined,
		senderRole: args.sender_role ?? "any",
		limit: limit + 1,
		cursor: args.cursor ? decodeMessageCursor(args.cursor) : undefined,
	});

	const hasMore = rows.length > limit;
	const scanned = rows.slice(0, limit);
	// [>]: no chat filter -> access applied per row; cursor tracks last *scanned* row so pagination always advances
	const visible = chatJid
		? scanned
		: scanned.filter((row) => isChatAllowed(row.chat_jid, ctx.config.access));
	const lastScanned = scanned[scanned.length - 1];

	return {
		messages: visible.map((row) => redact(ctx, row)),
		next_cursor:
			hasMore && lastScanned
				? encodeCursor({ ts: lastScanned.timestamp, id: lastScanned.id })
				: null,
	};
}

// -------------------------------------------------------- get_thread_context

export interface GetThreadContextArgs {
	chat_id: string;
	around_message_id?: string;
	after?: string;
	before?: string;
	limit_before?: number;
	limit_after?: number;
	include_media?: boolean;
	max_media_items?: number;
}

export function handleGetThreadContext(
	ctx: ToolContext,
	args: GetThreadContextArgs,
) {
	const chatJid = requireChatAccess(ctx, args.chat_id);
	const max = ctx.config.privacy.max_messages_per_call;

	if (!args.around_message_id && !args.after && !args.before) {
		throw new ToolError(
			"query too broad: provide around_message_id, or an after/before period",
			"denied",
		);
	}

	let limitBefore = clampLimit(args.limit_before, max, 10);
	let limitAfter = clampLimit(args.limit_after, max, 10);
	// [>]: context + anchor stay within per-call budget
	if (limitBefore + limitAfter + 1 > max) {
		limitBefore = Math.min(limitBefore, Math.floor((max - 1) / 2));
		limitAfter = Math.min(limitAfter, max - 1 - limitBefore);
	}

	if (args.around_message_id) {
		const anchor = ctx.db.getMessage(chatJid, args.around_message_id);
		if (!anchor) {
			throw new ToolError(
				`message ${args.around_message_id} not found in chat`,
			);
		}
		const key = { ts: anchor.timestamp, id: anchor.id };
		const before = ctx.db.messagesBefore(chatJid, key, limitBefore);
		const after = ctx.db.messagesAfter(chatJid, key, limitAfter);
		return {
			anchor_message_id: anchor.id,
			messages: [...before, anchor, ...after].map((row) => redact(ctx, row)),
		};
	}

	const rows = ctx.db.chatRange(chatJid, {
		after: args.after ? normalizeTimestamp(args.after, "after") : undefined,
		before: args.before ? normalizeTimestamp(args.before, "before") : undefined,
		limit: Math.min(limitBefore + limitAfter, max),
	});
	return {
		anchor_message_id: null,
		messages: rows.map((row) => redact(ctx, row)),
	};
}

// ---------------------------------------------------- get_chat_summary_input

export interface GetChatSummaryInputArgs {
	chat_id: string;
	after?: string;
	before?: string;
	max_messages?: number;
	include_media?: boolean;
	max_media_items?: number;
}

export function handleGetChatSummaryInput(
	ctx: ToolContext,
	args: GetChatSummaryInputArgs,
) {
	const chatJid = requireChatAccess(ctx, args.chat_id);
	const limit = clampLimit(
		args.max_messages,
		ctx.config.privacy.max_messages_per_call,
	);
	const after = args.after
		? normalizeTimestamp(args.after, "after")
		: undefined;
	const before = args.before
		? normalizeTimestamp(args.before, "before")
		: undefined;

	const chat = ctx.db.getChat(chatJid);
	const rows = ctx.db.chatRange(chatJid, { after, before, limit });
	const total = ctx.db.chatMessageCount(chatJid, { after, before });
	const messages = rows.map((row) => redact(ctx, row));

	const participants = new Map<
		string,
		{ role: "me" | "other"; display_name: string; message_count: number }
	>();
	for (const msg of messages) {
		const key = msg.role === "me" ? "me" : msg.sender_jid;
		const existing = participants.get(key);
		if (existing) {
			existing.message_count++;
		} else {
			participants.set(key, {
				role: msg.role,
				display_name: msg.sender_display_name,
				message_count: 1,
			});
		}
	}

	return {
		chat: {
			id: messages[0]?.chat_id ?? args.chat_id,
			name: chat?.name ?? null,
			is_group: chat?.is_group === 1,
		},
		window: {
			after: after ?? null,
			before: before ?? null,
			returned: messages.length,
			total_in_range: total,
			truncated: total > messages.length,
		},
		participants: [...participants.values()],
		messages,
	};
}

// ---------------------------------------------------------------- registration

export const READ_ONLY_TOOL_NAMES = [
	"list_chats",
	"search_messages",
	"get_thread_context",
	"get_chat_summary_input",
] as const;

/**
 * Register four read-only tools.
 * [!]: no send/delete/upload capability anywhere in module; regression test enforces.
 */
export function registerTools(server: McpServer, ctx: ToolContext): string[] {
	const registered: string[] = [];

	const wrap = <A>(
		tool: string,
		handler: (ctx: ToolContext, args: A) => unknown,
	) => {
		return async (args: A) => {
			const started = performance.now();
			try {
				const result = handler(ctx, args) as Record<string, unknown>;
				const count = Array.isArray(result.messages)
					? result.messages.length
					: Array.isArray(result.chats)
						? result.chats.length
						: undefined;
				ctx.audit.log({
					tool,
					params: args as Record<string, unknown>,
					outcome: "ok",
					result_count: count,
					duration_ms: Math.round(performance.now() - started),
				});
				const content: ContentBlock[] = [
					{ type: "text", text: JSON.stringify(result, null, 2) },
				];
				content.push(
					...(await mediaContentBlocks(ctx, args as IncludeMediaArgs, result)),
				);
				return { content };
			} catch (err) {
				const outcome = err instanceof ToolError ? err.outcome : "error";
				const message = err instanceof Error ? err.message : String(err);
				ctx.audit.log({
					tool,
					params: args as Record<string, unknown>,
					outcome,
					error: message,
					duration_ms: Math.round(performance.now() - started),
				});
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Error: ${message}` }],
				};
			}
		};
	};

	server.registerTool(
		"list_chats",
		{
			title: "List WhatsApp chats",
			description:
				"List available WhatsApp conversations (direct chats and groups), most recently active first. Read-only.",
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe("Filter by chat name or JID substring"),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Max chats to return"),
				cursor: z
					.string()
					.optional()
					.describe("Opaque cursor from a previous call"),
				include_last_message: z
					.boolean()
					.optional()
					.describe("Include each chat's last message"),
			},
		},
		wrap("list_chats", handleListChats),
	);
	registered.push("list_chats");

	server.registerTool(
		"search_messages",
		{
			title: "Search WhatsApp messages",
			description:
				"Search synced WhatsApp messages. Requires at least one filter (chat_id, query, after or before). " +
				"Each message carries role='me' (sent by the user) or role='other'. Read-only.",
			inputSchema: {
				chat_id: z.string().optional().describe("Restrict to one chat JID"),
				query: z
					.string()
					.optional()
					.describe("Substring to search in message content"),
				after: z
					.string()
					.optional()
					.describe("ISO date: only messages after this instant"),
				before: z
					.string()
					.optional()
					.describe("ISO date: only messages before this instant"),
				sender_role: z
					.enum(["me", "other", "any"])
					.optional()
					.describe("Filter by sender role"),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Max messages to return"),
				cursor: z
					.string()
					.optional()
					.describe("Opaque cursor from a previous call"),
			},
		},
		wrap("search_messages", handleSearchMessages),
	);
	registered.push("search_messages");

	server.registerTool(
		"get_thread_context",
		{
			title: "Get WhatsApp thread context",
			description:
				"Return the messages around a given message id, or within a period, in chronological order. Read-only.",
			inputSchema: {
				chat_id: z.string().describe("Chat JID"),
				around_message_id: z
					.string()
					.optional()
					.describe("Message id to center the context on"),
				after: z
					.string()
					.optional()
					.describe("ISO date lower bound (period mode)"),
				before: z
					.string()
					.optional()
					.describe("ISO date upper bound (period mode)"),
				limit_before: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Messages before the anchor"),
				limit_after: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Messages after the anchor"),
				include_media: z
					.boolean()
					.optional()
					.describe("Attach available image/audio content blocks"),
				max_media_items: z
					.number()
					.int()
					.positive()
					.max(MAX_MEDIA_ITEMS_PER_CALL)
					.optional()
					.describe("Max media attachments; hard cap 3"),
			},
		},
		wrap("get_thread_context", handleGetThreadContext),
	);
	registered.push("get_thread_context");

	server.registerTool(
		"get_chat_summary_input",
		{
			title: "Get chat summary input",
			description:
				"Return a bounded, structured extract of one chat (participants, window stats, messages) " +
				"meant as input for the agent's own analysis or summary. Read-only.",
			inputSchema: {
				chat_id: z.string().describe("Chat JID"),
				after: z.string().optional().describe("ISO date lower bound"),
				before: z.string().optional().describe("ISO date upper bound"),
				max_messages: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Max messages to include"),
				include_media: z
					.boolean()
					.optional()
					.describe("Attach available image/audio content blocks"),
				max_media_items: z
					.number()
					.int()
					.positive()
					.max(MAX_MEDIA_ITEMS_PER_CALL)
					.optional()
					.describe("Max media attachments; hard cap 3"),
			},
		},
		wrap("get_chat_summary_input", handleGetChatSummaryInput),
	);
	registered.push("get_chat_summary_input");

	return registered;
}
