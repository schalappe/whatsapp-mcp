package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func TestExtractImageAndAudioMedia(t *testing.T) {
	image := extractMedia(&waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype:   proto.String("image/png"),
		FileLength: proto.Uint64(12),
	}})
	if image == nil || image.mimeType != "image/png" || image.sizeBytes != 12 {
		t.Fatalf("unexpected image metadata: %#v", image)
	}

	audio := extractMedia(&waE2E.Message{AudioMessage: &waE2E.AudioMessage{
		Mimetype:   proto.String("audio/ogg"),
		FileLength: proto.Uint64(8),
		Seconds:    proto.Uint32(4),
		ViewOnce:   proto.Bool(true),
	}})
	if audio == nil || audio.durationSeconds != 4 || !audio.viewOnce {
		t.Fatalf("unexpected audio metadata: %#v", audio)
	}
}

func TestMediaMetadataPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "messages.db")
	store, err := OpenMessageStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	ctx := context.Background()
	if _, err := store.UpsertMessage(ctx, StoredMessage{
		ID:          "M1",
		ChatJID:     "chat@s.whatsapp.net",
		SenderJID:   "sender@s.whatsapp.net",
		Timestamp:   time.Unix(0, 0),
		MessageType: "audio",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertMedia(ctx, StoredMedia{
		MessageID:       "M1",
		ChatJID:         "chat@s.whatsapp.net",
		MIMEType:        "audio/ogg",
		SizeBytes:       8,
		DurationSeconds: 4,
		FileName:        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}); err != nil {
		t.Fatal(err)
	}

	var mimeType, fileName string
	var sizeBytes, durationSeconds int64
	err = store.db.QueryRowContext(ctx, `
		SELECT mime_type, size_bytes, duration_seconds, file_name
		FROM message_media WHERE message_id = ? AND chat_jid = ?`,
		"M1", "chat@s.whatsapp.net",
	).Scan(&mimeType, &sizeBytes, &durationSeconds, &fileName)
	if err != nil {
		t.Fatal(err)
	}
	if mimeType != "audio/ogg" || sizeBytes != 8 || durationSeconds != 4 || len(fileName) != 64 {
		t.Fatalf("unexpected stored media: %q %d %d %q", mimeType, sizeBytes, durationSeconds, fileName)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("database mode = %o, want 600", info.Mode().Perm())
	}
}
