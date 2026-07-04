#!/usr/bin/env bash
# Starts the read-only MCP server on stdio (for manual testing;
# MCP clients normally launch it themselves).
set -euo pipefail
cd "$(dirname "$0")/../whatsapp-mcp-readonly-ts"
exec bun run src/index.ts "$@"
