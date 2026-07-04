#!/usr/bin/env bash
# Starts the read-only WhatsApp collector (QR pairing on first run).
set -euo pipefail
cd "$(dirname "$0")/../whatsapp-reader-go"
exec go run . "$@"
