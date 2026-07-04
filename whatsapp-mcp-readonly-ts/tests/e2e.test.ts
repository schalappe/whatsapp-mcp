/**
 * @module tests/e2e
 * Full MCP round-trip over an in-memory transport: tool listing, calls,
 * error surfacing, audit trail.
 */
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeContext, ALICE_CHAT } from "./fixtures.ts";
import { registerTools } from "../src/tools.ts";

async function connectedClient() {
  const { ctx, auditEntries } = makeContext();
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
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.messages.length).toBe(3);
    expect(
      parsed.messages.every((m: any) => m.role === "me" || m.role === "other"),
    ).toBe(true);
  });

  test("unbounded search surfaces a denial, not data", async () => {
    const { client } = await connectedClient();
    const result = await client.callTool({
      name: "search_messages",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/too broad/);
  });

  test("audit trail records tool name, filters and outcome", async () => {
    const { client, auditEntries } = await connectedClient();
    await client.callTool({
      name: "search_messages",
      arguments: { chat_id: ALICE_CHAT, query: "merci" },
    });
    await client.callTool({ name: "search_messages", arguments: {} });
    expect(auditEntries.length).toBe(2);
    expect(auditEntries[0].tool).toBe("search_messages");
    expect(auditEntries[0].params).toMatchObject({
      chat_id: ALICE_CHAT,
      query: "merci",
    });
    expect(auditEntries[0].outcome).toBe("ok");
    expect(auditEntries[0].result_count).toBe(1);
    expect(auditEntries[1].outcome).toBe("denied");
  });
});
