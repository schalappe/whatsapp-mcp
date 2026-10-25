#!/usr/bin/env bun
/**
 * Drive the real MCP server the way an MCP client does: spawn `bun run src/index.ts` over
 * stdio, initialize, then list tools or call one. Raw JSON-RPC, no SDK, so it runs from
 * anywhere.
 *
 * Usage:
 *   WHATSAPP_MCP_CONFIG=<cfg> bun drive.ts tools                      <evidence-dir>
 *   WHATSAPP_MCP_CONFIG=<cfg> bun drive.ts call <tool> '<json-args>'  <evidence-dir>
 *
 * Writes to <evidence-dir>: <step>.json (raw JSON-RPC result), <step>.stderr (server
 * stderr), <step>-media-N.<ext> (decoded image/audio blocks), server.pids (one line per spawned server).
 * Exit codes: 0 ok, 1 tool returned isError, 2 usage/protocol/startup failure.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SERVER_DIR = resolve(
	import.meta.dir,
	"../../../../whatsapp-mcp-readonly-ts",
);
const TIMEOUT_MS = 20_000;

const [mode, ...rest] = process.argv.slice(2);
const evidenceDir = rest.at(-1);
if (!process.env.WHATSAPP_MCP_CONFIG) {
	fail("WHATSAPP_MCP_CONFIG must point at a config.toml (see seed.ts)");
}
if (!evidenceDir || (mode !== "tools" && mode !== "call")) {
	fail(
		"usage: drive.ts tools <evidence-dir> | call <tool> '<json>' <evidence-dir>",
	);
}
const toolName = mode === "call" ? rest[0] : undefined;
const toolArgs = mode === "call" ? JSON.parse(rest[1] ?? "{}") : undefined;
if (mode === "call" && (!toolName || rest.length !== 3)) {
	fail("usage: drive.ts call <tool> '<json>' <evidence-dir>");
}
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const step = toolName ?? "tools";

const child = Bun.spawn(["bun", "run", "src/index.ts"], {
	cwd: SERVER_DIR,
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	env: process.env,
});
appendFileSync(join(evidenceDir, "server.pids"), `${child.pid}\n`);
console.error(`server pid ${child.pid}`);
const stderrText = new Response(child.stderr).text();

const pending = new Map<number, (msg: JsonRpcResponse) => void>();
interface JsonRpcResponse {
	id: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

(async () => {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of child.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line) {
				const msg = JSON.parse(line) as JsonRpcResponse;
				pending.get(msg.id)?.(msg);
			}
			nl = buffer.indexOf("\n");
		}
	}
})();

let nextId = 1;
function request(method: string, params: unknown): Promise<JsonRpcResponse> {
	const id = nextId++;
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
	);
	child.stdin.flush();
	return new Promise((resolveMsg, reject) => {
		pending.set(id, resolveMsg);
		setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS);
		child.exited.then((code) =>
			reject(new Error(`server exited (${code}) before answering ${method}`)),
		);
	});
}

let exitCode = 0;
try {
	const init = await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "verify-whatsapp-mcp", version: "1" },
	});
	if (init.error) throw new Error(`initialize: ${init.error.message}`);
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
	);

	const response =
		mode === "tools"
			? await request("tools/list", {})
			: await request("tools/call", { name: toolName, arguments: toolArgs });
	if (response.error) throw new Error(`${mode}: ${response.error.message}`);
	const result = response.result ?? {};
	writeFileSync(
		join(evidenceDir, `${step}.json`),
		JSON.stringify(result, null, 2),
	);

	if (mode === "tools") {
		const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
		console.log(names.sort().join("\n"));
	} else {
		const blocks = result.content as Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		let mediaIndex = 0;
		for (const block of blocks) {
			if (block.type === "text") {
				console.log(block.text);
			} else if (block.data && block.mimeType) {
				mediaIndex++;
				const ext = block.mimeType.split("/")[1] ?? "bin";
				const file = join(evidenceDir, `${step}-media-${mediaIndex}.${ext}`);
				writeFileSync(file, Buffer.from(block.data, "base64"));
				console.log(`[${block.type} ${block.mimeType}] ${file}`);
			}
		}
		if (result.isError) exitCode = 1;
	}
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	exitCode = 2;
} finally {
	child.stdin.end();
	child.kill();
	await child.exited;
	const stderr = await stderrText;
	writeFileSync(join(evidenceDir, `${step}.stderr`), stderr);
	if (exitCode === 2) console.error(stderr);
}
process.exit(exitCode);

function fail(message: string): never {
	console.error(message);
	process.exit(2);
}
