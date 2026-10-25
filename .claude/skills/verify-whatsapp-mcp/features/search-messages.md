# search_messages

**Reach**: the client searches history ("what did I say about lundi?") with `search_messages`.

**Set up**: Launch seeds the messages. Need more rows for pagination: add `FixtureMessage` entries in `scripts/seed.ts`, or pass `"limit":1`.

**Drive**:

```sh
bun "$S/drive.ts" call search_messages '{"chat_id":"33600000002@s.whatsapp.net"}' "$RUN/evidence"
bun "$S/drive.ts" call search_messages '{"query":"lundi"}' "$RUN/evidence"
bun "$S/drive.ts" call search_messages '{"query":"lundi","sender_role":"me"}' "$RUN/evidence"
bun "$S/drive.ts" call search_messages '{"after":"2026-07-02T00:00:00Z","before":"2026-07-03T00:00:00Z"}' "$RUN/evidence"
bun "$S/drive.ts" call search_messages '{}' "$RUN/evidence"              # refusal path
```

**Proof**: every message has `role` `me` or `other`, matching `is_from_me` (A2, G2, AUD1 are `me`). Results come newest first: `query:"lundi"` returns G2, G1; with `sender_role:"me"` only G2. The period search returns G3, G2, G1. `{}` exits 1 with `Error: query too broad: provide at least one of chat_id, query, after or before` and an audit line with `outcome: "denied"`.

**Gotchas**: `role` must never come from sender JID or display name. AUD1's `sender_jid` is Alice's JID yet `role` is `me`, which proves the rule; keep that fixture quirk.
