/**
 * @module tests/redact
 * PRD acceptance: phone numbers and JIDs can be masked in every response
 * while chat_ids stay usable for follow-up calls.
 */
import { describe, expect, test } from "bun:test";
import { makeContext, ALICE_CHAT, ALICE_JID, GROUP_CHAT } from "./fixtures.ts";
import {
	redactJid,
	redactPhonesInText,
	resolveRedactedJid,
} from "../src/redact.ts";
import {
	handleSearchMessages,
	handleListChats,
	handleGetChatSummaryInput,
} from "../src/tools.ts";

describe("redaction", () => {
	test("user JIDs are pseudonymized deterministically", () => {
		const redacted = redactJid(ALICE_JID);
		expect(redacted).toMatch(/^redacted-[0-9a-f]{10}@s\.whatsapp\.net$/);
		expect(redactJid(ALICE_JID)).toBe(redacted);
		expect(redacted).not.toContain("33600000002");
	});

	test("modern group JIDs pass through (no phone number inside)", () => {
		expect(redactJid(GROUP_CHAT)).toBe(GROUP_CHAT);
	});

	test("legacy group JIDs embed creator phone and are pseudonymized", () => {
		const legacy = "22501543668-1507101586@g.us";
		const redacted = redactJid(legacy);
		expect(redacted).toMatch(/^redacted-[0-9a-f]{10}@g\.us$/);
		expect(redacted).not.toContain("22501543668");
		expect(resolveRedactedJid(redacted, [GROUP_CHAT, legacy])).toBe(legacy);
	});

	test("phone numbers in message content are masked", () => {
		expect(redactPhonesInText("appelle-moi au +33 6 12 34 56 78 ce soir")).toBe(
			"appelle-moi au [phone-redacted] ce soir",
		);
		expect(redactPhonesInText("rendez-vous a 14h30")).toBe(
			"rendez-vous a 14h30",
		);
	});

	test("redact_jids hides raw JIDs in search results", () => {
		const { ctx } = makeContext({
			config: (c) => {
				c.privacy.redact_jids = true;
			},
		});
		const result = handleSearchMessages(ctx, { chat_id: ALICE_CHAT });
		for (const msg of result.messages) {
			expect(msg.sender_jid).not.toContain("336000000");
			expect(msg.chat_id).not.toContain("336000000");
		}
	});

	test("redact_phone_numbers masks numbers in content", () => {
		const { ctx } = makeContext({
			config: (c) => {
				c.privacy.redact_phone_numbers = true;
			},
		});
		const result = handleSearchMessages(ctx, {
			chat_id: ALICE_CHAT,
			query: "appelle",
		});
		expect(result.messages[0]?.content).toContain("[phone-redacted]");
		expect(result.messages[0]?.content).not.toContain("12 34 56 78");
	});

	test("redacted chat ids remain usable in follow-up calls", () => {
		const { ctx } = makeContext({
			config: (c) => {
				c.privacy.redact_jids = true;
			},
		});
		const chats = handleListChats(ctx, {});
		const aliceRedacted = chats.chats.find((c) => c.name === "Alice")?.id;
		expect(aliceRedacted).toBeDefined();
		if (!aliceRedacted) throw new Error("missing Alice chat");
		expect(aliceRedacted.startsWith("redacted-")).toBe(true);
		const summary = handleGetChatSummaryInput(ctx, { chat_id: aliceRedacted });
		expect(summary.window.returned).toBe(3);
		expect(resolveRedactedJid(aliceRedacted, [ALICE_CHAT])).toBe(ALICE_CHAT);
	});
});
