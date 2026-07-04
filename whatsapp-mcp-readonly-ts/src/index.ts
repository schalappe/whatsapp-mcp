#!/usr/bin/env bun
/**
 * @module index
 * Stdio MCP entry. Startup guard: refuse write-looking or unexpected tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { loadConfig, configPath } from "./config.ts";
import { createAuditLogger } from "./audit.ts";
import { ReadOnlyDb } from "./db.ts";
import { registerTools, READ_ONLY_TOOL_NAMES } from "./tools.ts";

const WRITE_TOOL_PATTERN =
  /send|delete|write|update|upload|create|compose|forward|react/i;

export function createServer(configFile?: string): {
  server: McpServer;
  toolNames: string[];
} {
  const config = loadConfig(configFile);
  if (!existsSync(config.whatsapp.database_path)) {
    throw new Error(
      `message database not found at ${config.whatsapp.database_path}; run whatsapp-reader-go first`,
    );
  }
  const server = new McpServer({ name: "whatsapp-readonly", version: "0.1.0" });
  const toolNames = registerTools(server, {
    db: new ReadOnlyDb(config.whatsapp.database_path),
    config,
    audit: createAuditLogger(config.audit),
  });

  for (const name of toolNames) {
    if (WRITE_TOOL_PATTERN.test(name)) {
      throw new Error(
        `refusing to start: tool ${name} looks like a write tool`,
      );
    }
    if (!(READ_ONLY_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(`refusing to start: unexpected tool ${name}`);
    }
  }
  return { server, toolNames };
}

async function main() {
  const { server, toolNames } = createServer(configPath());
  console.error(
    `whatsapp-readonly MCP server: ${toolNames.join(", ")} (stdio)`,
  );
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
