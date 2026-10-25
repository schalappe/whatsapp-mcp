# WhatsApp read-only MCP connector

`whatsapp-reader-go/` collects WhatsApp history into a local SQLite database, and `whatsapp-mcp-readonly-ts/` is a Bun/TypeScript MCP server that reads that database over stdio. Most changes touch `src/redact.ts`, `src/db.ts`, and `src/tools.ts` in `whatsapp-mcp-readonly-ts/`. See `README.md` for setup and client configuration, and `PRD.md` for the product scope.

## Structure

- `whatsapp-reader-go/`: the Go collector. It pairs with a phone by QR code and writes `messages.db`.
- `whatsapp-mcp-readonly-ts/`: the MCP server. Its own rules live in `whatsapp-mcp-readonly-ts/AGENTS.md`.
- `scripts/`: start scripts for both components and the Betterleaks installer.
- `.claude/skills/verify-whatsapp-mcp/`: end-to-end verification of the server against a seeded fixture database.
- `config.example.toml`: the documented shape of the MCP server config.
- `docs/agents/`: issue tracker, triage label, and domain doc conventions for agent skills.

## Commands

Run these from the repository root. Both finish in a few seconds.

```sh
make check   # must pass before a task counts as done: gofmt, go vet, go build, go test; biome ci, tsc, bun test
make audit   # govulncheck + bun audit
```

Run a single Go test from `whatsapp-reader-go/`:

```sh
go test -run TestMediaMetadataPersistence ./...
```

For single TypeScript tests, see `whatsapp-mcp-readonly-ts/AGENTS.md`. To prove a server change end to end, the way an MCP client sees it, use the `verify-whatsapp-mcp` skill.

`./scripts/start-collector.sh [--request-full-sync]` and `./scripts/start-mcp-server.sh` never exit, so do not use them as checks. The collector also needs a QR pairing with a phone, which an agent cannot do.

Set up the git hooks once per clone:

```sh
uv tool install lefthook
scripts/install-betterleaks.sh 1.9.0 ~/.local/bin   # secret scanner used by the pre-commit hook
lefthook install
```

## Conventions

Domain docs are single-context: one root `GLOSSARY.md` and `docs/adr/`, created lazily. See `docs/agents/domain.md`.

## Git and PR workflow

- Write commit messages and PR titles as Conventional Commits, for example `fix(redact): hash legacy group JIDs`. The `commit-msg` hook and the `pr-title` CI job enforce the format. PRs are squash-merged, so the PR title becomes the commit.
- Branch off `develop` and open the PR against `develop`; `main` changes only through a PR from `develop`. The hooks reject commits on `main` or `develop` and pushes that update them.
- CI runs `.github/workflows/whatsapp-reader-go.yml` and `.github/workflows/whatsapp-mcp-readonly-ts.yml` only when their component changed, and `.github/workflows/security.yml` (Betterleaks on the full history, zizmor, PR title) on every PR.
- Tickets are GitHub issues on `schalappe/whatsapp-mcp`, managed with `gh`. See `docs/agents/issue-tracker.md`.
- The default triage labels are `needs-triage`, `needs-info`, `ready-for-agent`, and `wontfix`. See `docs/agents/triage-labels.md`.

## Boundaries

- Preserve strict read-only behavior. Never add send, delete, edit, upload, reaction, or other write-capable WhatsApp or MCP tools.
- The public MCP tool set is fixed to `list_chats`, `search_messages`, `get_thread_context`, and `get_chat_summary_input`. Preserve the startup allowlist guard in `whatsapp-mcp-readonly-ts/src/index.ts`.
- Keep MCP on stdio only. Do not add HTTP listeners, network exposure, or telemetry.
- Keep the TypeScript SQLite connection read-only. Local JSONL audit logging is required, but audit records must never contain message content.
- Derive every returned message role (`me` or `other`) solely from `is_from_me`.
- Preserve bounded queries and privacy controls. Limits stay clamped to 1 to 500, broad searches and unbounded thread requests are rejected, blocklists override allowlists, and deterministic JID redaction keeps redacted chat IDs reusable.
- Collector data defaults to `~/.local/share/whatsapp-reader/`. MCP config defaults to `~/.config/whatsapp-mcp/config.toml`, and `WHATSAPP_MCP_CONFIG` overrides it.
- `~/.local/share/whatsapp-reader/messages.db` is the user's real history, and a collector is usually running on it. Verify against the fixture from `.claude/skills/verify-whatsapp-mcp/scripts/seed.ts`. Never start a second collector on the real data directory, and never run `pkill -f whatsapp`.
- Never commit session or message databases, WAL files, audit logs, or local config. Preserve the private permissions on the data directory (0700) and database files (0600).

## Failure log

- In `whatsapp-mcp-readonly-ts/src/redact.ts`, redact every JID shape that embeds a phone number. Legacy group JIDs (`<creator-phone>-<timestamp>@g.us`) leaked the creator's number until `21b7200`.
- After a Biome version bump, run `bunx biome migrate --write` in `whatsapp-mcp-readonly-ts/`. Dependabot's bump in `265d31d` left the `biome.json` schema behind the CLI.
