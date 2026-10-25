package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	waCommon "go.mau.fi/whatsmeow/proto/waCommon"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

const (
	testChat   = "chat@s.whatsapp.net"
	testAuthor = "author@s.whatsapp.net"
	testFile   = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

var sentAt = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func openTestStore(t *testing.T) *MessageStore {
	t.Helper()
	store, err := OpenMessageStore(filepath.Join(t.TempDir(), "messages.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func upsertOriginal(t *testing.T, store *MessageStore, id, messageType string) bool {
	t.Helper()
	revoked, err := store.UpsertMessage(context.Background(), StoredMessage{
		ID:          id,
		ChatJID:     testChat,
		SenderJID:   testAuthor,
		Timestamp:   sentAt,
		Content:     "helo",
		MessageType: messageType,
	})
	if err != nil {
		t.Fatal(err)
	}
	return revoked
}

func saveRevision(t *testing.T, store *MessageStore, r StoredRevision) []string {
	t.Helper()
	r.ChatJID = testChat
	if r.AuthorJID == "" {
		r.AuthorJID = testAuthor
	}
	orphans, err := store.SaveRevision(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	return orphans
}

func storedMessage(t *testing.T, store *MessageStore, id string) (content, messageType, timestamp string) {
	t.Helper()
	err := store.db.QueryRow(`
		SELECT content, message_type, timestamp FROM messages WHERE id = ? AND chat_jid = ?`,
		id, testChat).Scan(&content, &messageType, &timestamp)
	if err != nil {
		t.Fatal(err)
	}
	return content, messageType, timestamp
}

func TestEditRewritesContentOnly(t *testing.T) {
	store := openTestStore(t)
	upsertOriginal(t, store, "M1", "image")
	saveRevision(t, store, StoredRevision{
		MessageID: "M1", Kind: "edit", Content: "hello", RevisedAt: sentAt.Add(time.Minute),
	})

	content, messageType, timestamp := storedMessage(t, store, "M1")
	if content != "hello" || messageType != "image" || timestamp != sentAt.Format(time.RFC3339) {
		t.Fatalf("got %q %q %q, want edited content with original type and timestamp", content, messageType, timestamp)
	}
}

func TestEditSurvivesArrivalOrderAndReplay(t *testing.T) {
	store := openTestStore(t)
	newer := StoredRevision{MessageID: "M1", Kind: "edit", Content: "hello", RevisedAt: sentAt.Add(2 * time.Minute)}
	older := StoredRevision{MessageID: "M1", Kind: "edit", Content: "helo!", RevisedAt: sentAt.Add(time.Minute)}

	saveRevision(t, store, newer)
	upsertOriginal(t, store, "M1", "text")
	saveRevision(t, store, older)
	saveRevision(t, store, newer)
	upsertOriginal(t, store, "M1", "text")

	if content, _, _ := storedMessage(t, store, "M1"); content != "hello" {
		t.Fatalf("content = %q, want newest edit", content)
	}
}

func TestEditFromAnotherSenderIsIgnored(t *testing.T) {
	store := openTestStore(t)
	upsertOriginal(t, store, "M1", "text")
	saveRevision(t, store, StoredRevision{
		MessageID: "M1", Kind: "edit", Content: "forged", AuthorJID: "intruder@s.whatsapp.net", RevisedAt: sentAt,
	})

	if content, _, _ := storedMessage(t, store, "M1"); content != "helo" {
		t.Fatalf("content = %q, want original", content)
	}
}

func TestEditMatchesAlternateSenderJID(t *testing.T) {
	store := openTestStore(t)
	upsertOriginal(t, store, "M1", "text")
	saveRevision(t, store, StoredRevision{
		MessageID: "M1", Kind: "edit", Content: "hello",
		AuthorJID: "123@lid", AuthorAltJID: testAuthor, RevisedAt: sentAt,
	})

	if content, _, _ := storedMessage(t, store, "M1"); content != "hello" {
		t.Fatalf("content = %q, want edit matched through the alternate JID", content)
	}
}

func TestRevokeClearsMessageAndMedia(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	upsertOriginal(t, store, "M1", "image")
	upsertOriginal(t, store, "M2", "image")
	for _, id := range []string{"M1", "M2"} {
		if err := store.UpsertMedia(ctx, StoredMedia{
			MessageID: id, ChatJID: testChat, MIMEType: "image/png", SizeBytes: 8, FileName: testFile,
		}); err != nil {
			t.Fatal(err)
		}
	}

	if orphans := saveRevision(t, store, StoredRevision{MessageID: "M1", Kind: "revoke", AuthorJID: "admin@s.whatsapp.net"}); len(orphans) != 0 {
		t.Fatalf("orphans = %v, want none while M2 shares the file", orphans)
	}
	orphans := saveRevision(t, store, StoredRevision{MessageID: "M2", Kind: "revoke"})
	if len(orphans) != 1 || orphans[0] != testFile {
		t.Fatalf("orphans = %v, want the shared file once unreferenced", orphans)
	}

	saveRevision(t, store, StoredRevision{MessageID: "M1", Kind: "edit", Content: "back", RevisedAt: sentAt.Add(time.Hour)})
	if !upsertOriginal(t, store, "M1", "image") {
		t.Fatal("re-upsert of a revoked message must report it revoked")
	}
	if content, messageType, _ := storedMessage(t, store, "M1"); content != "" || messageType != "revoked" {
		t.Fatalf("got %q %q, want revoked with no content", content, messageType)
	}
	var mediaRows int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM message_media`).Scan(&mediaRows); err != nil {
		t.Fatal(err)
	}
	if mediaRows != 0 {
		t.Fatalf("media rows = %d, want 0", mediaRows)
	}
}

func TestExtractRevision(t *testing.T) {
	info := types.MessageInfo{
		MessageSource: types.MessageSource{
			Chat:     types.NewJID("chat", types.DefaultUserServer),
			Sender:   types.NewJID("author", types.DefaultUserServer),
			IsFromMe: true,
		},
		ID:        "ENVELOPE",
		Timestamp: sentAt,
	}
	edit := &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{
		ProtocolMessage: &waE2E.ProtocolMessage{
			Type:          waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
			Key:           &waCommon.MessageKey{ID: proto.String("M1")},
			EditedMessage: &waE2E.Message{Conversation: proto.String("hello")},
		},
	}}}
	revoke := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_REVOKE.Enum(),
		Key:  &waCommon.MessageKey{ID: proto.String("M2")},
	}}
	keyShare := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_APP_STATE_SYNC_KEY_SHARE.Enum(),
	}}
	stubInfo := info
	stubInfo.ID = "M3"

	tests := []struct {
		name     string
		evt      *events.Message
		wantOK   bool
		wantID   string
		wantKind string
		wantText string
	}{
		{"edit", &events.Message{Info: info, RawMessage: edit}, true, "M1", "edit", "hello"},
		{"revoke", &events.Message{Info: info, RawMessage: revoke}, true, "M2", "revoke", ""},
		{"history stub revoke", &events.Message{
			Info:         stubInfo,
			SourceWebMsg: &waWeb.WebMessageInfo{MessageStubType: waWeb.WebMessageInfo_REVOKE.Enum()},
		}, true, "M3", "revoke", ""},
		{"other protocol message", &events.Message{Info: info, RawMessage: keyShare}, false, "", "", ""},
		{"plain message", &events.Message{Info: info, RawMessage: &waE2E.Message{Conversation: proto.String("hi")}}, false, "", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := extractRevision(tt.evt)
			if ok != tt.wantOK || got.MessageID != tt.wantID || got.Kind != tt.wantKind || got.Content != tt.wantText {
				t.Fatalf("got %+v ok=%v", got, ok)
			}
			if ok && (got.ChatJID != "chat@s.whatsapp.net" || got.AuthorJID != "author@s.whatsapp.net" || !got.IsFromMe) {
				t.Fatalf("unexpected source fields: %+v", got)
			}
		})
	}
}

func TestExtractSecretEdit(t *testing.T) {
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:   types.NewJID("chat", types.DefaultUserServer),
				Sender: types.NewJID("author", types.DefaultUserServer),
			},
			Timestamp: sentAt,
		},
		Message: &waE2E.Message{SecretEncryptedMessage: &waE2E.SecretEncryptedMessage{
			SecretEncType:    waE2E.SecretEncryptedMessage_MESSAGE_EDIT.Enum(),
			TargetMessageKey: &waCommon.MessageKey{ID: proto.String("M1")},
		}},
	}
	bare := &waE2E.Message{Conversation: proto.String("hello")}
	wrapped := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type:          waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
		EditedMessage: bare,
	}}
	for name, decrypted := range map[string]*waE2E.Message{"bare": bare, "protocol wrapper": wrapped} {
		t.Run(name, func(t *testing.T) {
			got, ok := extractSecretEdit(evt, decrypted)
			if !ok || got.MessageID != "M1" || got.Kind != "edit" || got.Content != "hello" || got.AuthorJID != "author@s.whatsapp.net" {
				t.Fatalf("got %+v ok=%v", got, ok)
			}
		})
	}
}
