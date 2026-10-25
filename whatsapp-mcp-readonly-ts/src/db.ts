/**
 * @module db
 * Read-only SQLite queries over collector schema; keyset pagination.
 */
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import type { RedactedMessage } from "./redact.ts";

export interface MessageRow {
	id: string;
	chat_jid: string;
	sender_jid: string;
	is_from_me: number;
	timestamp: string;
	content: string | null;
	message_type: string;
	sender_display_name: string | null;
	chat_name: string | null;
	media_mime_type: string | null;
	media_size_bytes: number | null;
	media_duration_seconds: number | null;
	media_file_name: string | null;
}

export interface ChatRow {
	jid: string;
	name: string | null;
	is_group: number;
	last_message_at: string | null;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.chat_jid, m.sender_jid, m.is_from_me, m.timestamp,
         m.content, m.message_type,
         c.display_name AS sender_display_name,
         ch.name AS chat_name,
         mm.mime_type AS media_mime_type,
         mm.size_bytes AS media_size_bytes,
         mm.duration_seconds AS media_duration_seconds,
         mm.file_name AS media_file_name
  FROM messages m
  LEFT JOIN contacts c ON c.jid = m.sender_jid
  LEFT JOIN chats ch ON ch.jid = m.chat_jid
  LEFT JOIN message_media mm ON mm.message_id = m.id AND mm.chat_jid = m.chat_jid
`;

/** Read-only view over SQLite written by whatsapp-reader-go. */
export class ReadOnlyDb {
	private db: Database;

	constructor(private readonly path: string) {
		// [!]: readonly -> SQLite rejects writes
		this.db = new Database(path, { readonly: true });
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Resolve collector-owned media filename.
	 * @param fileName - SHA-256 hex filename.
	 * @returns Absolute path; null for invalid filename.
	 */
	resolveMediaPath(fileName: string): string | null {
		return /^[a-f0-9]{64}$/.test(fileName)
			? join(dirname(this.path), "media", fileName)
			: null;
	}

	allChatJids(): string[] {
		return this.db
			.query<{ jid: string }, []>("SELECT jid FROM chats")
			.all()
			.map((r) => r.jid);
	}

	listChats(opts: {
		query?: string;
		limit: number;
		offset: number;
	}): ChatRow[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (opts.query) {
			where.push("(ch.name LIKE ? OR co.display_name LIKE ? OR ch.jid LIKE ?)");
			const like = `%${opts.query}%`;
			params.push(like, like, like);
		}
		// [>]: DM chats often lack a name -> fall back to contact display name
		const sql = `
      SELECT ch.jid, COALESCE(ch.name, co.display_name) AS name, ch.is_group, ch.last_message_at
      FROM chats ch
      LEFT JOIN contacts co ON co.jid = ch.jid
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(ch.last_message_at, '') DESC, ch.jid ASC
      LIMIT ? OFFSET ?`;
		params.push(opts.limit, opts.offset);
		return this.db.query<ChatRow, (string | number)[]>(sql).all(...params);
	}

	lastMessageForChat(chatJid: string): MessageRow | null {
		const sql = `${MESSAGE_SELECT} WHERE m.chat_jid = ? ORDER BY m.timestamp DESC, m.id DESC LIMIT 1`;
		return this.db.query<MessageRow, [string]>(sql).get(chatJid) ?? null;
	}

	searchMessages(opts: {
		chatJid?: string;
		query?: string;
		after?: string;
		before?: string;
		senderRole: "me" | "other" | "any";
		limit: number;
		cursor?: { ts: string; id: string };
	}): MessageRow[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (opts.chatJid) {
			where.push("m.chat_jid = ?");
			params.push(opts.chatJid);
		}
		if (opts.query) {
			where.push("m.content LIKE ?");
			params.push(`%${opts.query}%`);
		}
		if (opts.after) {
			where.push("m.timestamp > ?");
			params.push(opts.after);
		}
		if (opts.before) {
			where.push("m.timestamp < ?");
			params.push(opts.before);
		}
		if (opts.senderRole === "me") {
			where.push("m.is_from_me = 1");
		} else if (opts.senderRole === "other") {
			where.push("m.is_from_me = 0");
		}
		if (opts.cursor) {
			where.push("(m.timestamp < ? OR (m.timestamp = ? AND m.id < ?))");
			params.push(opts.cursor.ts, opts.cursor.ts, opts.cursor.id);
		}
		const sql = `${MESSAGE_SELECT}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY m.timestamp DESC, m.id DESC
      LIMIT ?`;
		params.push(opts.limit);
		return this.db.query<MessageRow, (string | number)[]>(sql).all(...params);
	}

	getMessage(chatJid: string, messageId: string): MessageRow | null {
		const sql = `${MESSAGE_SELECT} WHERE m.chat_jid = ? AND m.id = ?`;
		return (
			this.db
				.query<MessageRow, [string, string]>(sql)
				.get(chatJid, messageId) ?? null
		);
	}

	/** Messages strictly before anchor, chronological. */
	messagesBefore(
		chatJid: string,
		anchor: { ts: string; id: string },
		limit: number,
	): MessageRow[] {
		const sql = `${MESSAGE_SELECT}
      WHERE m.chat_jid = ? AND (m.timestamp < ? OR (m.timestamp = ? AND m.id < ?))
      ORDER BY m.timestamp DESC, m.id DESC
      LIMIT ?`;
		return this.db
			.query<MessageRow, (string | number)[]>(sql)
			.all(chatJid, anchor.ts, anchor.ts, anchor.id, limit)
			.reverse();
	}

	/** Messages strictly after anchor, chronological. */
	messagesAfter(
		chatJid: string,
		anchor: { ts: string; id: string },
		limit: number,
	): MessageRow[] {
		const sql = `${MESSAGE_SELECT}
      WHERE m.chat_jid = ? AND (m.timestamp > ? OR (m.timestamp = ? AND m.id > ?))
      ORDER BY m.timestamp ASC, m.id ASC
      LIMIT ?`;
		return this.db
			.query<MessageRow, (string | number)[]>(sql)
			.all(chatJid, anchor.ts, anchor.ts, anchor.id, limit);
	}

	/** Chronological slice of chat within optional time range. */
	chatRange(
		chatJid: string,
		opts: { after?: string; before?: string; limit: number },
	): MessageRow[] {
		const where = ["m.chat_jid = ?"];
		const params: (string | number)[] = [chatJid];
		if (opts.after) {
			where.push("m.timestamp > ?");
			params.push(opts.after);
		}
		if (opts.before) {
			where.push("m.timestamp < ?");
			params.push(opts.before);
		}
		// [>]: most recent N of range, presented chronologically
		const sql = `${MESSAGE_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY m.timestamp DESC, m.id DESC
      LIMIT ?`;
		params.push(opts.limit);
		return this.db
			.query<MessageRow, (string | number)[]>(sql)
			.all(...params)
			.reverse();
	}

	chatMessageCount(
		chatJid: string,
		opts: { after?: string; before?: string },
	): number {
		const where = ["chat_jid = ?"];
		const params: string[] = [chatJid];
		if (opts.after) {
			where.push("timestamp > ?");
			params.push(opts.after);
		}
		if (opts.before) {
			where.push("timestamp < ?");
			params.push(opts.before);
		}
		const row = this.db
			.query<{ n: number }, string[]>(
				`SELECT COUNT(*) AS n FROM messages WHERE ${where.join(" AND ")}`,
			)
			.get(...params);
		return row?.n ?? 0;
	}

	getChat(chatJid: string): ChatRow | null {
		return (
			this.db
				.query<ChatRow, [string]>(
					`SELECT ch.jid, COALESCE(ch.name, co.display_name) AS name, ch.is_group, ch.last_message_at
           FROM chats ch LEFT JOIN contacts co ON co.jid = ch.jid WHERE ch.jid = ?`,
				)
				.get(chatJid) ?? null
		);
	}
}

/** DB row -> PRD response shape with mandatory role field. */
export function toMessageOut(row: MessageRow): RedactedMessage {
	const role = row.is_from_me === 1 ? "me" : "other";
	return {
		id: row.id,
		chat_id: row.chat_jid,
		timestamp: row.timestamp,
		role,
		sender_jid: row.sender_jid,
		sender_display_name:
			role === "me"
				? "Me"
				: (row.sender_display_name ?? row.chat_name ?? row.sender_jid),
		content: row.content ?? "",
		message_type: row.message_type,
		...(row.message_type === "image" || row.message_type === "audio"
			? {
					media: {
						available: row.media_file_name !== null,
						mime_type: row.media_mime_type,
						size_bytes: row.media_size_bytes,
						duration_seconds: row.media_duration_seconds,
					},
				}
			: {}),
	};
}
