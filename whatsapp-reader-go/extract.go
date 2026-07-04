package main

import (
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
)

// extractContent maps a decrypted WhatsApp message onto a (content, type)
// pair for storage. Media is never downloaded (read-only, metadata only):
// for media messages only the caption and the media kind are kept.
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
