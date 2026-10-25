/**
 * @module tests/limits
 * PRD acceptance: broad queries are refused or bounded; per-call caps and
 * pagination hold; allow/blocklist is enforced; audit log records calls.
 */
import { describe, expect, test } from "bun:test";
import {
	makeContext,
	ALICE_CHAT,
	GROUP_CHAT,
	ME_JID,
	type FixtureMessage,
} from "./fixtures.ts";
import {
	handleListChats,
	handleSearchMessages,
	handleGetThreadContext,
	handleGetChatSummaryInput,
} from "../src/tools.ts";

function manyMessages(count: number): FixtureMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `M${String(i).padStart(4, "0")}`,
		chat: ALICE_CHAT,
		sender: i % 2 === 0 ? ALICE_CHAT : ME_JID,
		fromMe: i % 2 === 1,
		ts: `2026-06-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
		content: `message ${i}`,
	}));
}

describe("limits and pagination", () => {
	test("search without any filter is refused", () => {
		const { ctx } = makeContext();
		expect(() => handleSearchMessages(ctx, {})).toThrow(/too broad/);
	});

	test("thread context without anchor or period is refused", () => {
		const { ctx } = makeContext();
		expect(() => handleGetThreadContext(ctx, { chat_id: ALICE_CHAT })).toThrow(
			/too broad/,
		);
	});

	test("limit is clamped to max_messages_per_call", () => {
		const { ctx } = makeContext({
			messages: manyMessages(80),
			config: (c) => {
				c.privacy.max_messages_per_call = 25;
			},
		});
		const result = handleSearchMessages(ctx, {
			chat_id: ALICE_CHAT,
			limit: 9999,
		});
		expect(result.messages.length).toBe(25);
		expect(result.next_cursor).not.toBeNull();
	});

	test("summary input is bounded and reports truncation", () => {
		const { ctx } = makeContext({
			messages: manyMessages(60),
			config: (c) => {
				c.privacy.max_messages_per_call = 20;
			},
		});
		const result = handleGetChatSummaryInput(ctx, { chat_id: ALICE_CHAT });
		expect(result.messages.length).toBe(20);
		expect(result.window.total_in_range).toBe(60);
		expect(result.window.truncated).toBe(true);
	});

	test("cursor pagination walks the full set without overlap", () => {
		const { ctx } = makeContext({ messages: manyMessages(45) });
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const result = handleSearchMessages(ctx, {
				chat_id: ALICE_CHAT,
				limit: 20,
				cursor,
			});
			for (const msg of result.messages) {
				expect(seen.has(msg.id)).toBe(false);
				seen.add(msg.id);
			}
			if (!result.next_cursor) break;
			cursor = result.next_cursor;
		}
		expect(seen.size).toBe(45);
	});

	test("blocked chats are hidden from listings and refused directly", () => {
		const { ctx } = makeContext({
			config: (c) => {
				c.access.blocked_chat_ids = [GROUP_CHAT];
			},
		});
		const chats = handleListChats(ctx, {});
		expect(chats.chats.map((c) => c.id)).not.toContain(GROUP_CHAT);
		expect(() => handleSearchMessages(ctx, { chat_id: GROUP_CHAT })).toThrow(
			/denied/,
		);
	});

	test("allowlist restricts to listed chats only", () => {
		const { ctx } = makeContext({
			config: (c) => {
				c.access.allowed_chat_ids = [ALICE_CHAT];
			},
		});
		const chats = handleListChats(ctx, {});
		expect(chats.chats.map((c) => c.id)).toEqual([ALICE_CHAT]);
		expect(() =>
			handleGetChatSummaryInput(ctx, { chat_id: GROUP_CHAT }),
		).toThrow(/denied/);
		// [>]: chat-unscoped search must not leak blocked rows either
		const search = handleSearchMessages(ctx, { query: "lundi" });
		expect(search.messages.length).toBe(0);
	});
});
