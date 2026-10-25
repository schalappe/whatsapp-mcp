# WhatsApp Read-Only MCP Connector

Personal, strictly read-only MCP connector for your WhatsApp history. MCP-compatible agents (Claude Desktop, Codex, Cursor, …) can search and analyze your conversations — with every message explicitly tagged `role: "me"` or `role: "other"` — but can never send, edit or delete anything.

```text
WhatsApp (multi-device) ──> whatsapp-reader-go ──> SQLite (local) ──> whatsapp-mcp-readonly-ts ──> MCP client (stdio)
                            QR pairing, sync only    messages.db        4 read-only tools
```

- **No write path**: the collector never calls any send API; the MCP server opens SQLite in read-only mode and exposes zero write tools (enforced by tests and a startup check).
- **No network exposure**: MCP over stdio only; everything stays on your machine.
- **Bounded**: message calls are capped (`max_messages_per_call`), media is opt-in and capped at 3 items/25 MiB per call, unbounded searches are refused, and all calls land in a local audit log.

## Prerequisites

- Go 1.21+ (the build auto-downloads the required toolchain)
- [Bun](https://bun.sh) 1.4+
- A personal WhatsApp account on your phone

## 1. Sync your WhatsApp history

```sh
./scripts/start-collector.sh                     # add --request-full-sync before first pairing for deeper history
```

On first run a QR code is printed: scan it from your phone (WhatsApp > Settings > Linked Devices > Link a Device). The collector then mirrors incoming messages and history syncs into `~/.local/share/whatsapp-reader/messages.db` (file mode 0600). Images and audio up to 25 MiB are stored under the owner-only `media/` directory; view-once media is skipped. Leave the collector running in a terminal or under a process manager; it resumes syncing on restart.

Flags: `--data-dir DIR` (default `~/.local/share/whatsapp-reader`), `--request-full-sync`, `--verbose`.

## 2. Configure the MCP server (optional)

Defaults work out of the box. To tune privacy/access, copy [`config.example.toml`](config.example.toml) to `~/.config/whatsapp-mcp/config.toml` (or set `WHATSAPP_MCP_CONFIG=/path/to/config.toml`):

- `privacy.redact_jids` — pseudonymize phone-number JIDs (`redacted-…@s.whatsapp.net`); redacted chat ids keep working in follow-up calls
- `privacy.redact_phone_numbers` — mask numbers inside message text
- `privacy.max_messages_per_call` — hard cap per tool call (default 100)
- `access.allowed_chat_ids` / `access.blocked_chat_ids` — restrict which chats are visible
- `audit.log_path` — JSONL log of every tool call (tool, filters, outcome — never message content)

## 3. Connect an MCP client

Install dependencies once: `cd whatsapp-mcp-readonly-ts && bun install`.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp-readonly": {
      "command": "bun",
      "args": ["run", "/ABSOLUTE/PATH/TO/whatsapp-mcp/whatsapp-mcp-readonly-ts/src/index.ts"],
      "env": { "WHATSAPP_MCP_CONFIG": "/Users/me/.config/whatsapp-mcp/config.toml" }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.whatsapp-readonly]
command = "bun"
args = ["run", "/ABSOLUTE/PATH/TO/whatsapp-mcp/whatsapp-mcp-readonly-ts/src/index.ts"]
env = { WHATSAPP_MCP_CONFIG = "/Users/me/.config/whatsapp-mcp/config.toml" }
```

### Claude Code

```sh
claude mcp add whatsapp-readonly -e WHATSAPP_MCP_CONFIG=$HOME/.config/whatsapp-mcp/config.toml -- bun run /ABSOLUTE/PATH/TO/whatsapp-mcp/whatsapp-mcp-readonly-ts/src/index.ts
```

## Tools

| Tool | Purpose | Required filter |
| --- | --- | --- |
| `list_chats` | List conversations, most recent first (`query`, `cursor`, `include_last_message`) | — |
| `search_messages` | Search messages (`chat_id`, `query`, `after`, `before`, `sender_role`, `cursor`) | at least one filter |
| `get_thread_context` | Messages around a message id or within a period; optionally attach up to 3 image/audio blocks with `include_media` | anchor or period |
| `get_chat_summary_input` | Bounded structured extract; optionally attach up to 3 image/audio blocks with `include_media` | `chat_id` |

Every returned message follows the PRD shape:

```json
{
  "id": "message-id",
  "chat_id": "chat-jid",
  "timestamp": "2026-07-04T12:34:56Z",
  "role": "me",
  "sender_jid": "xxx@s.whatsapp.net",
  "sender_display_name": "Alice",
  "content": "photo caption",
  "message_type": "image",
  "media": {
    "available": true,
    "mime_type": "image/jpeg",
    "size_bytes": 284513,
    "duration_seconds": null
  }
}
```

`content` holds the latest edit, while `timestamp` keeps the original send time. A message deleted for everyone returns `"message_type": "revoked"` with empty `content`, and the collector deletes its media.

## Development

Tools: Go, [Bun](https://bun.sh), [uv](https://docs.astral.sh/uv/), and two hook tools, once per machine:

```sh
uv tool install lefthook
scripts/install-betterleaks.sh 1.9.0 ~/.local/bin   # secret scanner used by the pre-commit hook
lefthook install                                    # once per clone
```

```sh
make check   # gofmt, go vet, build, Go tests; Biome lint + format, tsc, 30 Bun tests
make audit   # govulncheck + bun audit
```

CI runs the same commands per component. `main` and `develop` change only through PRs (feature → develop → main).

## Revoking access & deleting local data

1. On your phone: WhatsApp > Settings > Linked Devices > select `whatsapp-reader (read-only)` > Log out. The collector stops receiving anything immediately.
2. Stop the collector process.
3. Delete the local data:

```sh
rm -rf ~/.local/share/whatsapp-reader     # session keys, messages.db, audit.log
rm -rf ~/.config/whatsapp-mcp             # server config, if created
```

4. Remove the server entry from your MCP client config.

## Security model (V1)

- Read-only by design: no `send_message`/`delete_message`/upload tool exists anywhere in the codebase; the server refuses to start if a write-looking tool is ever registered, and SQLite is opened `readonly`.
- Local only: stdio transport, no HTTP listener, no telemetry.
- Restrictive permissions: data dir `0700`, databases and audit log `0600`.
- Image/audio downloads are passive reads through the authenticated WhatsApp session. Files stay local (`0600`), are never named from message content, and are returned only after chat access checks. Expired history media is not re-uploaded or retried.
