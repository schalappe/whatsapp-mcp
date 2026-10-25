/**
 * @module tests/readonly
 * PRD acceptance: no WhatsApp write tool is ever exposed, and the SQLite
 * connection itself rejects writes.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContext } from "./fixtures.ts";
import { createServer } from "../src/index.ts";
import { READ_ONLY_TOOL_NAMES } from "../src/tools.ts";

const WRITE_PATTERN =
	/send|delete|write|update|upload|create|compose|forward|react|post|edit/i;

function makeConfigFile(dbPath: string, extra = ""): string {
	const dir = mkdtempSync(join(tmpdir(), "wamcp-conf-"));
	const path = join(dir, "config.toml");
	writeFileSync(path, `[whatsapp]\ndatabase_path = "${dbPath}"\n${extra}`);
	return path;
}

describe("read-only surface", () => {
	test("server exposes exactly the four read-only tools", () => {
		const { dbPath } = makeContext();
		const { toolNames } = createServer(makeConfigFile(dbPath));
		expect(toolNames.sort()).toEqual([...READ_ONLY_TOOL_NAMES].sort());
	});

	test("no tool name matches a write-like pattern", () => {
		const { dbPath } = makeContext();
		const { toolNames } = createServer(makeConfigFile(dbPath));
		for (const name of toolNames) {
			expect(name).not.toMatch(WRITE_PATTERN);
		}
	});

	test("config with readonly=false is refused", () => {
		const { dbPath } = makeContext();
		const path = makeConfigFile(dbPath, "readonly = false\n");
		expect(() => createServer(path)).toThrow(/read-only by design/);
	});

	test("the SQLite handle rejects writes", () => {
		const { dbPath } = makeContext();
		const db = new Database(dbPath, { readonly: true });
		expect(() =>
			db.run(
				"INSERT INTO messages (id, chat_jid, sender_jid, is_from_me, timestamp) VALUES ('x','x','x',0,'2026-01-01T00:00:00Z')",
			),
		).toThrow(/readonly/i);
		expect(() => db.run("DELETE FROM messages")).toThrow(/readonly/i);
		db.close();
	});
});
