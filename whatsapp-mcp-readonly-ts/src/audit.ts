/**
 * @module audit
 * Local JSONL audit trail of MCP tool calls.
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";

export interface AuditLogger {
	log(entry: {
		tool: string;
		params: Record<string, unknown>;
		outcome: "ok" | "denied" | "error";
		result_count?: number;
		error?: string;
		duration_ms: number;
	}): void;
}

/**
 * One JSON line per tool call: tool, when, filters, outcome. Never message content.
 */
export function createAuditLogger(audit: Config["audit"]): AuditLogger {
	if (!audit.enabled) {
		return { log: () => {} };
	}
	const dir = dirname(audit.log_path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	return {
		log(entry) {
			const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
			try {
				appendFileSync(audit.log_path, line + "\n", { mode: 0o600 });
			} catch (err) {
				// [!]: audit failure must not break reads; stays visible on stderr
				console.error(`audit log write failed: ${err}`);
			}
		},
	};
}
