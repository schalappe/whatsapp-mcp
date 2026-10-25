/**
 * @module tests/roles
 * PRD acceptance: every returned message carries role "me" or "other",
 * mapped strictly from is_from_me.
 */
import { describe, expect, test } from "bun:test";
import {
	makeContext,
	ALICE_CHAT,
	GROUP_CHAT,
	ME_JID,
	ALICE_JID,
} from "./fixtures.ts";
import {
	handleSearchMessages,
	handleGetThreadContext,
	handleGetChatSummaryInput,
} from "../src/tools.ts";

describe("me/other separation", () => {
	test("search returns role 'me' exactly for is_from_me rows", () => {
		const { ctx } = makeContext();
		const result = handleSearchMessages(ctx, { chat_id: ALICE_CHAT });
		expect(result.messages.length).toBe(3);
		for (const msg of result.messages) {
			expect(["me", "other"]).toContain(msg.role);
			if (msg.sender_jid === ME_JID) {
				expect(msg.role).toBe("me");
			} else {
				expect(msg.role).toBe("other");
			}
		}
		const mine = result.messages.filter((m) => m.role === "me");
		expect(mine.map((m) => m.id)).toEqual(["A2"]);
	});

	test("sender_role=me filter only returns the user's messages", () => {
		const { ctx } = makeContext();
		const result = handleSearchMessages(ctx, {
			chat_id: GROUP_CHAT,
			sender_role: "me",
		});
		expect(result.messages.map((m) => m.id)).toEqual(["G2"]);
		expect(result.messages.every((m) => m.role === "me")).toBe(true);
	});

	test("sender_role=other excludes the user's messages", () => {
		const { ctx } = makeContext();
		const result = handleSearchMessages(ctx, {
			chat_id: GROUP_CHAT,
			sender_role: "other",
		});
		expect(result.messages.map((m) => m.id).sort()).toEqual(["G1", "G3"]);
		expect(result.messages.every((m) => m.role === "other")).toBe(true);
	});

	test("thread context keeps roles around the anchor", () => {
		const { ctx } = makeContext();
		const result = handleGetThreadContext(ctx, {
			chat_id: ALICE_CHAT,
			around_message_id: "A2",
		});
		expect(result.messages.map((m) => `${m.id}:${m.role}`)).toEqual([
			"A1:other",
			"A2:me",
			"A3:other",
		]);
	});

	test("summary input separates participants by role", () => {
		const { ctx } = makeContext();
		const result = handleGetChatSummaryInput(ctx, { chat_id: GROUP_CHAT });
		const me = result.participants.filter((p) => p.role === "me");
		const others = result.participants.filter((p) => p.role === "other");
		expect(me.length).toBe(1);
		expect(me[0]?.message_count).toBe(1);
		expect(others.length).toBe(2);
	});

	test("display name resolves from contacts for others, 'Me' for the user", () => {
		const { ctx } = makeContext();
		const result = handleSearchMessages(ctx, { chat_id: ALICE_CHAT });
		const alice = result.messages.find((m) => m.sender_jid === ALICE_JID);
		const mine = result.messages.find((m) => m.role === "me");
		expect(alice?.sender_display_name).toBe("Alice");
		expect(mine?.sender_display_name).toBe("Me");
	});
});
