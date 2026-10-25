/**
 * @module redact
 * Phone/JID masking. JIDs pseudonymized deterministically -> still usable as tool params.
 */
import { createHash } from "node:crypto";
import type { Config } from "./config.ts";

const USER_JID_RE = /^(\+?\d+)(?:[.:][\d]+)?@(s\.whatsapp\.net|lid|c\.us)$/;
// [!]: legacy groups = <creator-phone>-<timestamp>@g.us -> phone leaks; modern ids (no dash) hold none
const LEGACY_GROUP_JID_RE = /^\d+-\d+@g\.us$/;
// [>]: phone-looking digit runs in free text
const PHONE_IN_TEXT_RE = /\+?\d[\d\s().-]{5,}\d/g;

function jidHash(jid: string): string {
	return createHash("sha256").update(jid).digest("hex").slice(0, 10);
}

/**
 * Pseudonymize JID holding a phone number: phone part -> stable hash.
 * Agents correlate senders without seeing number. Modern group JIDs pass through.
 */
export function redactJid(jid: string): string {
	const match = USER_JID_RE.exec(jid);
	const user = match?.[1];
	const domain = match?.[2];
	if (user && domain) {
		return `redacted-${jidHash(`${user}@${domain}`)}@${domain}`;
	}
	if (LEGACY_GROUP_JID_RE.test(jid)) {
		return `redacted-${jidHash(jid)}@g.us`;
	}
	return jid;
}

export function isRedactedJid(jid: string): boolean {
	return jid.startsWith("redacted-");
}

/**
 * Real JID behind pseudonym via re-hash of candidates -> redacted chat_ids stay usable in follow-up calls.
 */
export function resolveRedactedJid(
	redacted: string,
	candidates: string[],
): string | undefined {
	return candidates.find((jid) => redactJid(jid) === redacted);
}

export function redactPhonesInText(text: string): string {
	return text.replace(PHONE_IN_TEXT_RE, (m) => {
		const digits = m.replace(/\D/g, "");
		return digits.length >= 7 ? "[phone-redacted]" : m;
	});
}

export interface RedactedMessage {
	id: string;
	chat_id: string;
	timestamp: string;
	role: "me" | "other";
	sender_jid: string;
	sender_display_name: string;
	content: string;
	message_type: string;
	media?: {
		available: boolean;
		mime_type: string | null;
		size_bytes: number | null;
		duration_seconds: number | null;
	};
}

export function applyRedaction(
	msg: RedactedMessage,
	privacy: Config["privacy"],
): RedactedMessage {
	const out = { ...msg };
	if (privacy.redact_jids) {
		out.chat_id = redactJid(out.chat_id);
		out.sender_jid = redactJid(out.sender_jid);
	}
	if (privacy.redact_phone_numbers) {
		out.content = redactPhonesInText(out.content);
		out.sender_display_name = redactPhonesInText(out.sender_display_name);
		if (!privacy.redact_jids) {
			// [>]: bare user JID == phone number + suffix -> mask too
			out.chat_id = redactJid(out.chat_id);
			out.sender_jid = redactJid(out.sender_jid);
		}
	}
	return out;
}
