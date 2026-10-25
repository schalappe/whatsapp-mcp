# get_thread_context

**Reach**: after a search hit, the client asks for the surrounding conversation, optionally with the photo or voice note.

**Set up**: Launch seeds IMG1 (1x1 PNG) and AUD1 (8-byte OGG) in Alice's chat, with files in `$RUN/data/media/`.

**Drive**:

```sh
# anchor mode
bun "$S/drive.ts" call get_thread_context '{"chat_id":"33600000002@s.whatsapp.net","around_message_id":"A2","limit_before":1,"limit_after":1}' "$RUN/evidence"
# period mode
bun "$S/drive.ts" call get_thread_context '{"chat_id":"1203630000000000@g.us","after":"2026-07-02T00:00:00Z","before":"2026-07-03T00:00:00Z"}' "$RUN/evidence"
# media opt-in
bun "$S/drive.ts" call get_thread_context '{"chat_id":"33600000002@s.whatsapp.net","around_message_id":"IMG1","limit_before":1,"limit_after":1,"include_media":true}' "$RUN/evidence"
# refusals
bun "$S/drive.ts" call get_thread_context '{"chat_id":"33600000002@s.whatsapp.net"}' "$RUN/evidence"
bun "$S/drive.ts" call get_thread_context '{"chat_id":"33600000002@s.whatsapp.net","around_message_id":"NOPE"}' "$RUN/evidence"
```

**Proof**: anchor mode returns `anchor_message_id: "A2"` and A1, A2, A3 in chronological order. Period mode returns G1, G2, G3 (chronological, unlike `search_messages`). Without `include_media` the result has one text block; with it, the output prints `Media for message IMG1` then `[image image/png] …-media-1.png` and the same for AUD1 (`.ogg`); `file` on the PNG says `PNG image data, 1 x 1`. The first refusal exits 1 with `query too broad: provide around_message_id, or an after/before period` (`denied`); the second with `message NOPE not found in chat` (`error`).

**Gotchas**: media is capped at 3 items and 25 MiB per call (`max_media_items` > 3 is a schema error, exit 1). `media.available` reflects the `message_media` row, not the disk. `available: false` = an image/audio message the collector never downloaded (expired, view-once, too big): add a `FixtureMessage` with `type: "image"` and no `media` in `scripts/seed.ts`. A row whose file is gone from `$RUN/data/media/` still reports `available: true`; `include_media` then silently omits that attachment (observed 2026-10-25).
