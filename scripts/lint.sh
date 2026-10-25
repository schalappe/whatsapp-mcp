#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

(
  cd "$repo_root/whatsapp-mcp-readonly-ts"
  bun run lint
)

(
  cd "$repo_root/whatsapp-reader-go"
  go vet ./...
)
