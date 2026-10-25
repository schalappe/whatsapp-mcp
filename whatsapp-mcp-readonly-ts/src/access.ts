/**
 * @module access
 * Allow/blocklist evaluation for chats.
 */
import type { Config } from "./config.ts";

/**
 * Chat-level access control. Blocklist wins; non-empty allowlist -> only listed chats.
 * Hidden chats: silent in listings, explicit denial on direct access.
 */
export function isChatAllowed(
	chatJid: string,
	access: Config["access"],
): boolean {
	if (access.blocked_chat_ids.includes(chatJid)) {
		return false;
	}
	if (access.allowed_chat_ids.length > 0) {
		return access.allowed_chat_ids.includes(chatJid);
	}
	return true;
}
