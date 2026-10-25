# Collector (whatsapp-reader-go)

**Reach**: the user runs `./scripts/start-collector.sh [--request-full-sync]`, scans a QR code from WhatsApp > Settings > Linked Devices, and the collector mirrors messages into `messages.db` and `media/`.

**Set up**: needs a phone with a WhatsApp account to pair. An agent cannot produce this state. A built binary is often already running on the real data dir (`pgrep -fl whatsapp-reader-go`); it belongs to the user, never stop it.

**Drive**: not drivable end to end by an agent. What you can verify:
- Go tests: `make -C whatsapp-reader-go check` (includes `media_test.go`).
- Schema contract: `whatsapp-reader-go/store.go` and `whatsapp-mcp-readonly-ts/tests/fixtures.ts` declare the same tables; diff them after any schema change, then run the MCP feature files against a fresh seed.
- With the user's explicit permission only: read-only checks on the real DB, e.g. `sqlite3 -readonly ~/.local/share/whatsapp-reader/messages.db 'select count(*), max(timestamp) from messages'` (counts only, no content).

**Proof**: Go tests pass; fixture and store schemas match; with permission, `max(timestamp)` advances while the collector runs.

**Gotchas**: a second collector with a fresh `--data-dir` needs its own pairing (one more linked device on the user's phone): ask first. Never point a test collector at `~/.local/share/whatsapp-reader`. Data dir must stay `0700` and databases `0600`.
