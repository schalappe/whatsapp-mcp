/**
 * @module tests/e2e
 * Full MCP round-trip over an in-memory transport: tool listing, calls,
 * error surfacing, audit trail.
 */
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../src/config.ts";
import {
	makeContext,
	defaultMessages,
	ALICE_CHAT,
	GROUP_CHAT,
	type FixtureMessage,
} from "./fixtures.ts";
import { registerTools } from "../src/tools.ts";

async function connectedClient(
	messages: FixtureMessage[] = defaultMessages(),
	configure?: (config: Config) => void,
) {
	const { ctx, auditEntries } = makeContext({ messages, config: configure });
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerTools(server, ctx);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, auditEntries };
}

describe("MCP end-to-end", () => {
	test("lists exactly the four read-only tools", async () => {
		const { client } = await connectedClient();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"get_chat_summary_input",
			"get_thread_context",
			"list_chats",
			"search_messages",
		]);
	});

	test("search_messages returns role-tagged messages as JSON", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({
			name: "search_messages",
			arguments: { chat_id: ALICE_CHAT },
		});
		expect(result.isError).toBeFalsy();
		const content = result.content as Array<{ type: string; text: string }>;
		const first = content[0];
		expect(first).toBeDefined();
		if (!first) throw new Error("missing text content");
		const parsed = JSON.parse(first.text) as {
			messages: Array<{ role: unknown }>;
		};
		expect(parsed.messages.length).toBe(3);
		expect(
			parsed.messages.every((m) => m.role === "me" || m.role === "other"),
		).toBe(true);
	});

	test("thread context returns opt-in image and audio blocks", async () => {
		const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
		const audio = Uint8Array.from([79, 103, 103, 83, 1, 2, 3, 4]);
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
				media: { mimeType: "image/png", data: image },
			},
			{
				id: "AUD1",
				chat: ALICE_CHAT,
				sender: ALICE_CHAT,
				fromMe: true,
				ts: "2026-07-03T10:01:00Z",
				content: "",
				type: "audio",
				media: {
					mimeType: "audio/ogg",
					data: audio,
					durationSeconds: 4,
				},
			},
		];
		const { client, auditEntries } = await connectedClient(messages);
		const args = {
			chat_id: ALICE_CHAT,
			around_message_id: "IMG1",
			limit_before: 1,
			limit_after: 1,
		};

		const defaultResult = await client.callTool({
			name: "get_thread_context",
			arguments: args,
		});
		const defaultContent = defaultResult.content as ContentBlock[];
		expect(defaultContent.map((block) => block.type)).toEqual(["text"]);

		const result = await client.callTool({
			name: "get_thread_context",
			arguments: { ...args, include_media: true, max_media_items: 2 },
		});
		const content = result.content as ContentBlock[];
		expect(content.map((block) => block.type)).toEqual([
			"text",
			"text",
			"image",
			"text",
			"audio",
		]);

		const [text, , imageBlock, , audioBlock] = content;
		if (text?.type !== "text") throw new Error("missing result metadata");
		const metadata = JSON.parse(text.text) as {
			messages: Array<{
				id: string;
				media?: { available: boolean; duration_seconds: number | null };
			}>;
		};
		expect(
			metadata.messages.find((message) => message.id === "IMG1")?.media,
		).toMatchObject({ available: true, duration_seconds: null });
		expect(
			metadata.messages.find((message) => message.id === "AUD1")?.media,
		).toMatchObject({ available: true, duration_seconds: 4 });
		expect(text.text).not.toContain("file_name");
		expect(imageBlock?.type).toBe("image");
		expect(imageBlock?.type === "image" ? imageBlock.data : null).toBe(
			Buffer.from(image).toString("base64"),
		);
		expect(audioBlock?.type).toBe("audio");
		expect(audioBlock?.type === "audio" ? audioBlock.data : null).toBe(
			Buffer.from(audio).toString("base64"),
		);
		expect(JSON.stringify(auditEntries)).not.toContain(
			Buffer.from(image).toString("base64"),
		);
	});

	test("blocked chats cannot return media blocks", async () => {
		const messages: FixtureMessage[] = [
			...defaultMessages(),
			{
				id: "BLOCKED_MEDIA",
				chat: GROUP_CHAT,
				sender: GROUP_CHAT,
				fromMe: false,
				ts: "2026-07-03T11:00:00Z",
				content: "private",
				type: "image",
				media: {
					mimeType: "image/png",
					data: Uint8Array.from([137, 80, 78, 71]),
				},
			},
		];
		const { client } = await connectedClient(messages, (config) => {
			config.access.blocked_chat_ids = [GROUP_CHAT];
		});
		const result = await client.callTool({
			name: "get_thread_context",
			arguments: {
				chat_id: GROUP_CHAT,
				around_message_id: "BLOCKED_MEDIA",
				include_media: true,
			},
		});

		expect(result.isError).toBe(true);
		const content = result.content as ContentBlock[];
		expect(content.map((block) => block.type)).toEqual(["text"]);
	});

	test("unbounded search surfaces a denial, not data", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({
			name: "search_messages",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		const content = result.content as Array<{ type: string; text: string }>;
		expect(content[0]?.text).toMatch(/too broad/);
	});

	test("audit trail records tool name, filters and outcome", async () => {
		const { client, auditEntries } = await connectedClient();
		await client.callTool({
			name: "search_messages",
			arguments: { chat_id: ALICE_CHAT, query: "merci" },
		});
		await client.callTool({ name: "search_messages", arguments: {} });
		expect(auditEntries.length).toBe(2);
		expect(auditEntries[0]?.tool).toBe("search_messages");
		expect(auditEntries[0]?.params).toMatchObject({
			chat_id: ALICE_CHAT,
			query: "merci",
		});
		expect(auditEntries[0]?.outcome).toBe("ok");
		expect(auditEntries[0]?.result_count).toBe(1);
		expect(auditEntries[1]?.outcome).toBe("denied");
	});
});
