package main

import (
	"strings"

	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// extractContent maps decrypted message to stored text and type.
func extractContent(msg *waE2E.Message) (content string, messageType string) {
	if msg == nil {
		return "", "unknown"
	}
	switch {
	case msg.GetConversation() != "":
		return msg.GetConversation(), "text"
	case msg.GetExtendedTextMessage() != nil:
		return msg.GetExtendedTextMessage().GetText(), "text"
	case msg.GetImageMessage() != nil:
		return msg.GetImageMessage().GetCaption(), "image"
	case msg.GetVideoMessage() != nil:
		return msg.GetVideoMessage().GetCaption(), "video"
	case msg.GetAudioMessage() != nil:
		return "", "audio"
	case msg.GetDocumentMessage() != nil:
		return msg.GetDocumentMessage().GetCaption(), "document"
	case msg.GetStickerMessage() != nil:
		return "", "sticker"
	case msg.GetContactMessage() != nil:
		return msg.GetContactMessage().GetDisplayName(), "contact"
	case msg.GetLocationMessage() != nil:
		return msg.GetLocationMessage().GetName(), "location"
	case msg.GetLiveLocationMessage() != nil:
		return "", "live_location"
	case msg.GetReactionMessage() != nil:
		return msg.GetReactionMessage().GetText(), "reaction"
	case msg.GetPollCreationMessageV3() != nil:
		return msg.GetPollCreationMessageV3().GetName(), "poll"
	case msg.GetPollCreationMessage() != nil:
		return msg.GetPollCreationMessage().GetName(), "poll"
	case msg.GetProtocolMessage() != nil:
		return "", "protocol"
	default:
		return "", "unknown"
	}
}

// newRevision fills the revision fields that come from the revising event.
func newRevision(evt *events.Message) StoredRevision {
	revision := StoredRevision{
		ChatJID:   evt.Info.Chat.String(),
		AuthorJID: evt.Info.Sender.ToNonAD().String(),
		IsFromMe:  evt.Info.IsFromMe,
		RevisedAt: evt.Info.Timestamp,
	}
	if !evt.Info.SenderAlt.IsEmpty() {
		revision.AuthorAltJID = evt.Info.SenderAlt.ToNonAD().String()
	}
	return revision
}

// extractRevision maps an edit or revoke event to the revision of the message it
// targets. It reads RawMessage because ParseWebMessage already rewrites
// history-sync edits into plain messages, and history sync marks revoked
// messages with a stub type instead of a protocol message.
func extractRevision(evt *events.Message) (StoredRevision, bool) {
	revision := newRevision(evt)
	raw := evt.RawMessage
	if edited := raw.GetEditedMessage().GetMessage(); edited != nil {
		raw = edited
	}
	protocol := raw.GetProtocolMessage()
	switch {
	case protocol != nil && protocol.GetType() == waE2E.ProtocolMessage_MESSAGE_EDIT:
		revision.MessageID = protocol.GetKey().GetID()
		revision.Kind = "edit"
		revision.Content, _ = extractContent(protocol.GetEditedMessage())
	case protocol != nil && protocol.Type != nil && protocol.GetType() == waE2E.ProtocolMessage_REVOKE:
		revision.MessageID = protocol.GetKey().GetID()
		revision.Kind = "revoke"
	case evt.SourceWebMsg.GetMessageStubType() == waWeb.WebMessageInfo_REVOKE:
		revision.MessageID = evt.Info.ID
		revision.Kind = "revoke"
	default:
		return StoredRevision{}, false
	}
	return revision, revision.MessageID != ""
}

// extractSecretEdit maps a decrypted SecretEncryptedMessage edit to the
// revision of its target message. The payload may be the edited message itself
// or a protocol edit wrapping it.
func extractSecretEdit(evt *events.Message, decrypted *waE2E.Message) (StoredRevision, bool) {
	revision := newRevision(evt)
	revision.MessageID = evt.Message.GetSecretEncryptedMessage().GetTargetMessageKey().GetID()
	revision.Kind = "edit"
	if edited := decrypted.GetProtocolMessage().GetEditedMessage(); edited != nil {
		decrypted = edited
	}
	revision.Content, _ = extractContent(decrypted)
	return revision, revision.MessageID != ""
}

// messageFields names the populated top-level fields of msg, never their
// values, so unknown message shapes can be diagnosed from logs.
func messageFields(msg *waE2E.Message) string {
	var fields []string
	msg.ProtoReflect().Range(func(field protoreflect.FieldDescriptor, _ protoreflect.Value) bool {
		fields = append(fields, string(field.Name()))
		return true
	})
	return strings.Join(fields, ",")
}

type extractedMedia struct {
	message         whatsmeow.DownloadableMessage
	mimeType        string
	sizeBytes       uint64
	durationSeconds uint32
	viewOnce        bool
}

func extractMedia(msg *waE2E.Message) *extractedMedia {
	if msg == nil {
		return nil
	}
	if image := msg.GetImageMessage(); image != nil {
		mimeType := image.GetMimetype()
		if mimeType == "" {
			mimeType = "image/jpeg"
		}
		return &extractedMedia{
			message:   image,
			mimeType:  mimeType,
			sizeBytes: image.GetFileLength(),
			viewOnce:  image.GetViewOnce(),
		}
	}
	if audio := msg.GetAudioMessage(); audio != nil {
		mimeType := audio.GetMimetype()
		if mimeType == "" {
			mimeType = "audio/ogg"
		}
		return &extractedMedia{
			message:         audio,
			mimeType:        mimeType,
			sizeBytes:       audio.GetFileLength(),
			durationSeconds: audio.GetSeconds(),
			viewOnce:        audio.GetViewOnce(),
		}
	}
	return nil
}
