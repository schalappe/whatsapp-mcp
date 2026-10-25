/**
 * @module cursor
 * Opaque pagination cursors: base64url JSON keyset positions.
 */

export interface MessageCursor {
	ts: string;
	id: string;
}

export interface ChatCursor {
	offset: number;
}

export function encodeCursor(value: MessageCursor | ChatCursor): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeMessageCursor(cursor: string): MessageCursor {
	const value = decode(cursor);
	if (typeof value?.ts !== "string" || typeof value?.id !== "string") {
		throw new Error("invalid cursor: not a message cursor");
	}
	return { ts: value.ts, id: value.id };
}

export function decodeChatCursor(cursor: string): ChatCursor {
	const value = decode(cursor);
	if (typeof value?.offset !== "number" || value.offset < 0) {
		throw new Error("invalid cursor: not a chat cursor");
	}
	return { offset: Math.floor(value.offset) };
}

function decode(
	cursor: string,
): { ts?: unknown; id?: unknown; offset?: unknown } | null {
	try {
		return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
			ts?: unknown;
			id?: unknown;
			offset?: unknown;
		} | null;
	} catch {
		throw new Error("invalid cursor: malformed");
	}
}
