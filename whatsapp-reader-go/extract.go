package main

import (
	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
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
