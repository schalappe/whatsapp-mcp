# whatsapp-mcp-readonly-ts

This directory holds the read-only MCP server. Repo-wide boundaries in the root `AGENTS.md` apply here too.

## Commands

Run these from `whatsapp-mcp-readonly-ts/`.

```sh
bun install                      # once per clone
bun run check                    # must pass: biome ci, tsc --noEmit, bun test
bun test tests/redact.test.ts    # one test file
bun test -t 'legacy'             # tests whose name matches a pattern
bun run audit                    # bun audit at high severity
```

`bun run start` runs the stdio server and never exits, so do not use it as a check.

## Conventions

- TypeScript is strict ESM with `allowImportingTsExtensions`, so the `.ts` extensions in imports are intentional.
- Biome is both the formatter and the linter (`biome.json`). The pre-commit hook runs `biome check --write` on staged files.
- Open SQLite only through `bun:sqlite` with `{ readonly: true }`, as `src/db.ts` does.
- Do not use `Bun.serve()` or any other listener. The server speaks MCP over stdio only.
