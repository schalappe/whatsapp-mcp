# list_chats

**Reach**: an MCP client asks "which conversations do I have?" and calls `list_chats`.

**Set up**: Launch (SKILL.md) seeds two chats. For more than one page, set `limit` to 1.

**Drive**:

```sh
bun "$S/drive.ts" call list_chats '{}' "$RUN/evidence"
bun "$S/drive.ts" call list_chats '{"include_last_message":true}' "$RUN/evidence"
bun "$S/drive.ts" call list_chats '{"limit":1}' "$RUN/evidence"          # then pass next_cursor back as "cursor"
bun "$S/drive.ts" call list_chats '{"query":"Team"}' "$RUN/evidence"
```

**Proof**: `chats` ordered by `last_message_at` desc: Alice (`2026-07-03T10:01:00Z`) before Team Group. With `include_last_message`, Alice's last message is AUD1 with `role: "me"` and a `media` object. `limit:1` returns one chat and a non-null `next_cursor`; the cursor call returns Team Group and `next_cursor: null`. Audit line: `tool: "list_chats"`, `outcome: "ok"`, `result_count`.

**Gotchas**: `chats.last_message_at` is maintained by the collector (and by `seedDatabase`); a hand-inserted message that skips it will not reorder chats (`db.ts` orders by `chats.last_message_at`, not by messages).
