#!/usr/bin/env bun
/**
 * Build an isolated fixture data dir for the MCP server: messages.db (collector schema),
 * media/, and a config.toml whose paths all point inside that dir.
 *
 * Usage: bun seed.ts <empty-or-new-dir>
 * Prints the config path to pass as WHATSAPP_MCP_CONFIG.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	ALICE_CHAT,
	defaultMessages,
	seedDatabase,
	type FixtureMessage,
} from "../../../../whatsapp-mcp-readonly-ts/tests/fixtures.ts";

const dirArg = process.argv[2];
if (!dirArg) {
	console.error("usage: bun seed.ts <dir>");
	process.exit(2);
}
const dir = resolve(dirArg);
if (existsSync(dir) && readdirSync(dir).length > 0) {
	console.error(`refusing to seed: ${dir} is not empty`);
	process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });

// 1x1 PNG, so a saved media block opens in any image viewer.
const PNG = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
);
const OGG = Uint8Array.from([79, 103, 103, 83, 1, 2, 3, 4]);

const messages: FixtureMessage[] = [
	...defaultMessages(),
	{
		id: "IMG1",
		chat: ALICE_CHAT,
		sender: ALICE_CHAT,
		fromMe: false,
		ts: "2026-07-03T10:00:00Z",
		content: "photo",
		type: "image",
		media: { mimeType: "image/png", data: PNG },
	},
	{
		id: "AUD1",
		chat: ALICE_CHAT,
		sender: ALICE_CHAT,
		fromMe: true,
		ts: "2026-07-03T10:01:00Z",
		content: "",
		type: "audio",
		media: { mimeType: "audio/ogg", data: OGG, durationSeconds: 4 },
	},
];

const dbPath = join(dir, "messages.db");
seedDatabase(dbPath, messages);

const configPath = join(dir, "config.toml");
writeFileSync(
	configPath,
	`[whatsapp]
database_path = "${dbPath}"
readonly = true

[privacy]
redact_jids = false
redact_phone_numbers = false
max_messages_per_call = 100

[access]
allowed_chat_ids = []
blocked_chat_ids = []

[audit]
enabled = true
log_path = "${join(dir, "audit.log")}"
`,
	{ mode: 0o600 },
);
console.log(configPath);
