# Privacy controls

**Reach**: the user edits `config.toml` (README section 2); the MCP client restarts the server, which reads the config at startup.

**Set up**: edit `$RUN/data/config.toml` after Launch; the next `drive.ts` call spawns a server with the new config. Restore with a fresh `seed.ts` into a new dir rather than undoing edits by hand.

```sh
CFG=$RUN/data/config.toml
sd 'redact_jids = false' 'redact_jids = true' "$CFG"
sd 'redact_phone_numbers = false' 'redact_phone_numbers = true' "$CFG"
sd 'blocked_chat_ids = \[\]' 'blocked_chat_ids = ["1203630000000000@g.us"]' "$CFG"
# allowlist: sd 'allowed_chat_ids = \[\]' 'allowed_chat_ids = ["33600000002@s.whatsapp.net"]' "$CFG"
# per-call cap: sd 'max_messages_per_call = 100' 'max_messages_per_call = 2' "$CFG"
```

**Drive**:

```sh
bun "$S/drive.ts" call list_chats '{}' "$RUN/evidence"
bun "$S/drive.ts" call search_messages '{"query":"appelle"}' "$RUN/evidence"
RID=$(jq -r '.content[0].text' "$RUN/evidence/list_chats.json" | jq -r '.chats[0].id')
bun "$S/drive.ts" call search_messages "{\"chat_id\":\"$RID\",\"limit\":500}" "$RUN/evidence"
bun "$S/drive.ts" call search_messages '{"chat_id":"1203630000000000@g.us"}' "$RUN/evidence"
sd 'readonly = true' 'readonly = false' "$CFG"; bun "$S/drive.ts" tools "$RUN/evidence"
```

**Proof**:
- Blocklist: `list_chats` shows only Alice; searching the group exits 1 with `access to chat 1203630000000000@g.us is denied by configuration` (audit `denied`). Blocklist wins when the same chat is also allowlisted.
- JID redaction: ids look like `redacted-6f76490185@s.whatsapp.net`, the same value on every call, and that id works as `chat_id` in a follow-up call.
- Phone redaction: A2 content reads `Oui, appelle-moi au [phone-redacted]`.
- Cap: with `max_messages_per_call = 2`, a `limit` of 500 still returns at most 2 messages plus a `next_cursor`.
- `readonly = false`: exit 2, stderr `fatal: refusing to start: [whatsapp].readonly=false in …; this server is read-only by design`.

**Gotchas**: group JIDs (`@g.us`) are not phone numbers and stay unredacted. A TOML table may appear only once, so edit keys in place; appending a second `[privacy]` breaks parsing.
