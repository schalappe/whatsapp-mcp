# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Boundaries

- `whatsapp-reader-go/` collects WhatsApp history into local SQLite; `whatsapp-mcp-readonly-ts/` is a Bun/TypeScript MCP server that reads it over stdio.
- Preserve strict read-only behavior. Never add send, delete, edit, upload, reaction, or other write-capable WhatsApp/MCP tools.
- The public MCP surface is fixed to `list_chats`, `search_messages`, `get_thread_context`, and `get_chat_summary_input`; preserve the startup allowlist guard.
- Keep MCP on stdio only. Do not add HTTP listeners, network exposure, or telemetry.
- Keep the TypeScript SQLite connection read-only. Local JSONL audit logging is required, but audit records must never contain message content.
- Derive every returned message role (`me` or `other`) solely from `is_from_me`.
- Preserve bounded queries and privacy controls: limits remain clamped to 1–500, broad searches and unbounded thread requests are rejected, blocklists override allowlists, and deterministic JID redaction keeps redacted chat IDs reusable.

## Verification

Run all relevant checks after cross-component changes:

```sh
make check   # both components: format, lint, types, build, tests
make audit   # govulncheck + bun audit
```

Start locally from the repository root with `./scripts/start-collector.sh [--request-full-sync]` and `./scripts/start-mcp-server.sh`.

## TypeScript

@whatsapp-mcp-readonly-ts/AGENTS.md

TypeScript is strict ESM; `.ts` import extensions are intentional.

## Local data

- Collector data defaults to `~/.local/share/whatsapp-reader/`; MCP config defaults to `~/.config/whatsapp-mcp/config.toml` and can be overridden with `WHATSAPP_MCP_CONFIG`.
- Never commit session/message databases, WAL files, audit logs, or local config. Preserve private data-directory and database-file permissions.
