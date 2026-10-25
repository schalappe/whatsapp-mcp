# get_chat_summary_input

**Reach**: the client asks "summarize my chat with X"; the server returns a bounded structured extract and the agent writes the summary.

**Set up**: Launch seeds both chats. For truncation, pass `max_messages` below the chat size.

**Drive**:

```sh
bun "$S/drive.ts" call get_chat_summary_input '{"chat_id":"1203630000000000@g.us"}' "$RUN/evidence"
bun "$S/drive.ts" call get_chat_summary_input '{"chat_id":"33600000002@s.whatsapp.net","max_messages":2}' "$RUN/evidence"
bun "$S/drive.ts" call get_chat_summary_input '{"chat_id":"33600000002@s.whatsapp.net","include_media":true,"max_media_items":1}' "$RUN/evidence"
```

**Proof**: the group extract has `chat.name: "Team Group"`, `window.returned: 3`, `total_in_range: 3`, `truncated: false`, and `participants` Bob (other), Me (me), Alice (other) with `message_count: 1` each. `max_messages:2` on Alice gives `returned: 2`, `total_in_range: 5`, `truncated: true`. `max_media_items:1` saves exactly one media file.

**Gotchas**: `chat_id` is required; an unknown or blocked chat returns an error, not an empty extract.
