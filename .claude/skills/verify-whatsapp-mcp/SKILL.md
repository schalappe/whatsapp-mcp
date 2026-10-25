---
name: verify-whatsapp-mcp
description: Prove behavior of the whatsapp-readonly MCP server (stdio, 4 read-only tools) end to end against an isolated fixture database, the way an MCP client uses it. Use when verifying a change to whatsapp-mcp-readonly-ts tools, privacy config, startup guards, or the collector schema it reads.
---

# Verify the WhatsApp read-only MCP server

**Surface**: an MCP server over stdio (`whatsapp-mcp-readonly-ts/src/index.ts`). No port, no HTTP. An MCP client spawns `bun run src/index.ts`, speaks JSON-RPC on stdin/stdout, and the server logs one ready line on stderr. `scripts/drive.ts` does exactly that.

**Secondary surface**: the Go collector (`whatsapp-reader-go`). It needs a QR pairing with a phone, so an agent cannot drive it; see `features/collector.md`.

**Privacy (hard rule)**: `~/.local/share/whatsapp-reader/messages.db` is the user's real WhatsApp history, and a real collector process is usually running on it. Always verify against the fixture built by `scripts/seed.ts`. Driving the real DB needs the user's explicit permission for that run: it appends to the real `audit.log` and the evidence then holds real message content. Never start a second collector on the real data dir. Never `pkill -f whatsapp`.

**Isolation**: any number of server instances can run side by side; each reads the config named by `WHATSAPP_MCP_CONFIG`. The collector is one per data dir (session keys are tied to one paired device).

Set once per session (absolute paths; the evidence lives outside the repo):

```sh
REPO=$(git rev-parse --show-toplevel)
S=$REPO/.claude/skills/verify-whatsapp-mcp/scripts
RUN=$(mktemp -d -t verify-whatsapp-mcp)     # $RUN/data = fixture, $RUN/evidence = proof
```

## Doctor

Read-only. Run before anything else.

```sh
bun --version                                        # 1.4+
test -d "$REPO/whatsapp-mcp-readonly-ts/node_modules" || (cd "$REPO/whatsapp-mcp-readonly-ts" && bun install)
git -C "$REPO" rev-parse --short HEAD; git -C "$REPO" status --short   # the build you are proving
```

Then Launch and confirm `drive.ts tools` prints exactly `get_chat_summary_input`, `get_thread_context`, `list_chats`, `search_messages`. Anything else means the fixed public surface changed: stop and report.

## Launch

From an empty dir: seed the fixture (collector schema copied from `tests/fixtures.ts`, plus an image and an audio message), then list tools.

```sh
export WHATSAPP_MCP_CONFIG=$(bun "$S/seed.ts" "$RUN/data")
bun "$S/drive.ts" tools "$RUN/evidence"
```

Ready signal: `$RUN/evidence/tools.stderr` contains
`whatsapp-readonly MCP server: list_chats, search_messages, get_thread_context, get_chat_summary_input (stdio)`
and the tool list prints. A `fatal: …` line in stderr with exit 2 is a startup refusal (missing DB, `readonly=false`, or a write-looking tool).

Fixture contents (all in `$RUN/data`):

| Chat | JID | Messages |
| --- | --- | --- |
| Alice (direct) | `33600000002@s.whatsapp.net` | A1 other, A2 me (contains a phone number), A3 other (2026-07-01); IMG1 image/png other, AUD1 audio/ogg me (2026-07-03) |
| Team Group | `1203630000000000@g.us` | G1 Bob, G2 me, G3 Alice (2026-07-02) |

The config is `$RUN/data/config.toml`; the audit log is `$RUN/data/audit.log`. Config loads at startup, and each `drive.ts` call spawns a fresh server, so edit the config and call again; no restart step.

## Drive

```sh
bun "$S/drive.ts" call <tool> '<json-args>' "$RUN/evidence"
```

Exit 0 = tool succeeded, 1 = tool returned `isError` (business refusal, message printed as `Error: …`), 2 = protocol or startup failure (server stderr printed). Recipes per tool are in `features/`.

## Evidence

Per call, in `$RUN/evidence`: `<tool>.json` (the raw `tools/call` result as the client saw it), `<tool>.stderr`, `<tool>-media-N.<ext>` (decoded image/audio blocks), and `server.pids`. Each call overwrites the previous `<tool>.json`; copy it (`cp "$RUN/evidence/search_messages.json" "$RUN/evidence/01-search.json"`) when you need several calls to the same tool.

Side effect to capture every time: the audit trail.

```sh
tail -n 5 "$RUN/data/audit.log"
jq -c 'select(has("content") or has("messages") or has("chats"))' "$RUN/data/audit.log"   # must print nothing
rg -F -e 'Parfait' -e 'Reunion' -e 'appelle-moi' "$RUN/data/audit.log"                  # must print nothing unless you searched that word
```

Each line has `tool`, `params`, `outcome` (`ok` / `denied` / `error`), `result_count` or `error`, and never message content.

## Cleanup

`drive.ts` kills its own server before exiting; confirm by recorded PID only.

```sh
while read -r pid; do kill -0 "$pid" 2>/dev/null && kill "$pid"; done < "$RUN/evidence/server.pids"
while read -r pid; do kill -0 "$pid" 2>/dev/null && echo "still alive: $pid"; done < "$RUN/evidence/server.pids"
rm -rf "$RUN/data"          # fixture only; keep $RUN/evidence
unset WHATSAPP_MCP_CONFIG
```

## Maintenance

1. Run Doctor first on every use. Launch fails → fix the recipe before testing anything.
2. A drive fails on a feature the code still has → stale recipe: fix it in the same PR. The code lost the feature → regression: report it, never edit the recipe to pass.
3. A PR that changes launch, routes, or seeds updates the matching feature file in the same PR.
4. A scenario blocked because you did not know how to create its data → once you find the recipe, add it to the matching feature file (or a new one) in the same PR, so the next agent is not blocked.

Repo-specific: a schema change in `whatsapp-reader-go/store.go` must reach `tests/fixtures.ts` (which `seed.ts` imports); a new fixture message goes in `seed.ts` and the table above.

## Feature map

- `features/list-chats.md`: `list_chats`
- `features/search-messages.md`: `search_messages`, roles, broad-query refusal
- `features/thread-context.md`: `get_thread_context`, anchor and period modes, `include_media`
- `features/chat-summary-input.md`: `get_chat_summary_input`
- `features/privacy-controls.md`: JID and phone redaction, allow/block lists, per-call cap, `readonly=false` refusal
- `features/collector.md`: the Go collector (not drivable by an agent)
