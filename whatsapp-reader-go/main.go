// whatsapp-reader-go is a strictly read-only WhatsApp collector.
//
// It connects to WhatsApp Web multi-device via whatsmeow, authenticates with
// a QR code, and mirrors incoming messages (live events and history syncs)
// into a local SQLite database. It never calls any send/delete API: the only
// outbound traffic is the protocol handshake, receipts and keepalives that
// whatsmeow requires to stay connected.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

type collector struct {
	client   *whatsmeow.Client
	store    *MessageStore
	mediaDir string
	log      waLog.Logger
}

const (
	maxMediaFileBytes = 25 << 20
	mediaDownloadTime = 30 * time.Second
)

func main() {
	defaultDataDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		defaultDataDir = filepath.Join(home, ".local", "share", "whatsapp-reader")
	}
	dataDir := flag.String("data-dir", defaultDataDir, "directory for session.db and messages.db")
	fullSync := flag.Bool("request-full-sync", false, "request full message history at pairing time (only affects first pairing)")
	verbose := flag.Bool("verbose", false, "enable debug logging")
	flag.Parse()

	if *dataDir == "" {
		fmt.Fprintln(os.Stderr, "error: --data-dir is required")
		os.Exit(1)
	}
	if err := run(*dataDir, *fullSync, *verbose); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(dataDir string, fullSync, verbose bool) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	mediaDir := filepath.Join(dataDir, "media")
	if err := os.MkdirAll(mediaDir, 0o700); err != nil {
		return fmt.Errorf("create media dir: %w", err)
	}
	if err := os.Chmod(mediaDir, 0o700); err != nil {
		return fmt.Errorf("restrict media dir permissions: %w", err)
	}

	logLevel := "INFO"
	if verbose {
		logLevel = "DEBUG"
	}
	log := waLog.Stdout("Reader", logLevel, true)

	if fullSync {
		store.DeviceProps.RequireFullSync = proto.Bool(true)
	}
	// Identify as a passive companion, not a full client.
	store.DeviceProps.Os = proto.String("whatsapp-reader (read-only)")

	ctx := context.Background()

	sessionPath := filepath.Join(dataDir, "session.db")
	container, err := sqlstore.New(ctx, "sqlite3", "file:"+sessionPath+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on", waLog.Stdout("Session", logLevel, true))
	if err != nil {
		return fmt.Errorf("open session store: %w", err)
	}
	defer container.Close()
	if err := os.Chmod(sessionPath, 0o600); err != nil {
		return fmt.Errorf("restrict session db permissions: %w", err)
	}

	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return fmt.Errorf("load device: %w", err)
	}

	msgStore, err := OpenMessageStore(filepath.Join(dataDir, "messages.db"))
	if err != nil {
		return err
	}
	defer msgStore.Close()

	client := whatsmeow.NewClient(device, waLog.Stdout("Client", logLevel, true))
	c := &collector{
		client:   client,
		store:    msgStore,
		mediaDir: mediaDir,
		log:      log,
	}
	client.AddEventHandler(c.handleEvent)

	if client.Store.ID == nil {
		qrChan, err := client.GetQRChannel(ctx)
		if err != nil {
			return fmt.Errorf("get QR channel: %w", err)
		}
		if err := client.Connect(); err != nil {
			return fmt.Errorf("connect: %w", err)
		}
		for item := range qrChan {
			switch item.Event {
			case "code":
				fmt.Println("\nScan this QR code with WhatsApp (Settings > Linked Devices > Link a Device):")
				qrterminal.GenerateHalfBlock(item.Code, qrterminal.L, os.Stdout)
			case "success":
				log.Infof("Paired successfully")
			default:
				log.Infof("QR channel event: %s", item.Event)
			}
		}
	} else {
		if err := client.Connect(); err != nil {
			return fmt.Errorf("connect: %w", err)
		}
	}

	log.Infof("Collector running. Messages are mirrored to %s", filepath.Join(dataDir, "messages.db"))
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Infof("Shutting down")
	client.Disconnect()
	return nil
}

func (c *collector) handleEvent(evt any) {
	ctx := context.Background()
	switch e := evt.(type) {
	case *events.Message:
		c.storeMessage(ctx, e)
	case *events.HistorySync:
		c.handleHistorySync(ctx, e.Data)
	case *events.Connected:
		go c.syncDirectory()
	case *events.LoggedOut:
		c.log.Warnf("Logged out from WhatsApp (reason: %s). Delete session.db and restart to pair again.", e.Reason)
	}
}

func (c *collector) storeMessage(ctx context.Context, evt *events.Message) {
	if evt.Message != nil && evt.Message.GetProtocolMessage() != nil {
		// Edits and revokes rewrite stored messages; other protocol messages carry no chat content.
		c.persistMessage(ctx, evt)
		return
	}
	if err := c.store.UpsertChat(ctx, evt.Info.Chat.String(), "", evt.Info.IsGroup); err != nil {
		c.log.Errorf("upsert chat %s: %v", evt.Info.Chat, err)
	}
	if evt.Info.PushName != "" && !evt.Info.IsFromMe {
		if err := c.store.UpsertContact(ctx, evt.Info.Sender.ToNonAD().String(), evt.Info.PushName); err != nil {
			c.log.Errorf("upsert contact %s: %v", evt.Info.Sender, err)
		}
	}
	c.persistMessage(ctx, evt)
}

func (c *collector) persistMessage(ctx context.Context, evt *events.Message) bool {
	if secret := evt.Message.GetSecretEncryptedMessage(); secret != nil {
		c.persistSecretEdit(ctx, evt, secret)
		return false
	}
	if revision, ok := extractRevision(evt); ok {
		c.persistRevision(ctx, revision)
		return false
	}
	content, msgType := extractContent(evt.Message)
	if msgType == "protocol" {
		return false
	}
	if msgType == "unknown" && evt.Message != nil {
		c.log.Infof("message %s has an unknown type (fields: %s)", evt.Info.ID, messageFields(evt.Message))
	}
	revoked, err := c.store.UpsertMessage(ctx, StoredMessage{
		ID:          evt.Info.ID,
		ChatJID:     evt.Info.Chat.String(),
		SenderJID:   evt.Info.Sender.ToNonAD().String(),
		IsFromMe:    evt.Info.IsFromMe,
		Timestamp:   evt.Info.Timestamp,
		Content:     content,
		MessageType: msgType,
	})
	if err != nil {
		c.log.Errorf("store message %s: %v", evt.Info.ID, err)
		return false
	}
	if !revoked {
		c.persistMedia(ctx, evt)
	}
	return true
}

// persistSecretEdit decrypts an edit that WhatsApp sent encrypted with the
// original message's secret. Poll and event edits are dropped: the store keeps
// no poll options or events to apply them to.
func (c *collector) persistSecretEdit(ctx context.Context, evt *events.Message, secret *waE2E.SecretEncryptedMessage) {
	if secret.GetSecretEncType() != waE2E.SecretEncryptedMessage_MESSAGE_EDIT {
		return
	}
	targetID := secret.GetTargetMessageKey().GetID()
	decrypted, err := c.client.DecryptSecretEncryptedMessage(ctx, evt)
	if err != nil {
		c.log.Warnf("decrypt edit of message %s: %v", targetID, err)
		return
	}
	revision, ok := extractSecretEdit(evt, decrypted)
	if !ok {
		c.log.Warnf("skip edit %s: no target message", evt.Info.ID)
		return
	}
	c.persistRevision(ctx, revision)
}

func (c *collector) persistRevision(ctx context.Context, revision StoredRevision) {
	orphanFiles, err := c.store.SaveRevision(ctx, revision)
	if err != nil {
		c.log.Errorf("store %s of message %s: %v", revision.Kind, revision.MessageID, err)
		return
	}
	for _, fileName := range orphanFiles {
		err := os.Remove(filepath.Join(c.mediaDir, fileName))
		if err != nil && !os.IsNotExist(err) {
			c.log.Errorf("delete media of revoked message %s: %v", revision.MessageID, err)
		}
	}
}

func (c *collector) persistMedia(ctx context.Context, evt *events.Message) {
	media := extractMedia(evt.Message)
	if media == nil || media.viewOnce || media.sizeBytes > maxMediaFileBytes {
		return
	}
	fileHash := media.message.GetFileSHA256()
	if len(fileHash) != sha256.Size {
		c.log.Warnf("skip media for message %s: invalid SHA-256", evt.Info.ID)
		return
	}
	fileName := hex.EncodeToString(fileHash)
	finalPath := filepath.Join(c.mediaDir, fileName)
	if info, err := os.Stat(finalPath); err == nil {
		if info.Size() <= 0 || info.Size() > maxMediaFileBytes {
			c.log.Warnf("skip media for message %s: invalid stored size", evt.Info.ID)
			return
		}
		c.persistMediaMetadata(ctx, evt, media, fileName, info.Size())
		return
	} else if !os.IsNotExist(err) {
		c.log.Errorf("inspect media for message %s: %v", evt.Info.ID, err)
		return
	}

	temp, err := os.CreateTemp(c.mediaDir, ".download-*")
	if err != nil {
		c.log.Errorf("create media file for message %s: %v", evt.Info.ID, err)
		return
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)

	downloadCtx, cancel := context.WithTimeout(ctx, mediaDownloadTime)
	err = c.client.DownloadToFile(downloadCtx, media.message, temp)
	cancel()
	if err != nil {
		temp.Close()
		c.log.Warnf("download media for message %s: %v", evt.Info.ID, err)
		return
	}
	info, err := temp.Stat()
	if err != nil || info.Size() > maxMediaFileBytes {
		temp.Close()
		c.log.Warnf("skip media for message %s: invalid downloaded size", evt.Info.ID)
		return
	}
	if err := temp.Close(); err != nil {
		c.log.Errorf("close media for message %s: %v", evt.Info.ID, err)
		return
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		c.log.Errorf("store media for message %s: %v", evt.Info.ID, err)
		return
	}
	if err := os.Chmod(finalPath, 0o600); err != nil {
		c.log.Errorf("restrict media for message %s: %v", evt.Info.ID, err)
		return
	}
	c.persistMediaMetadata(ctx, evt, media, fileName, info.Size())
}

func (c *collector) persistMediaMetadata(
	ctx context.Context,
	evt *events.Message,
	media *extractedMedia,
	fileName string,
	sizeBytes int64,
) {
	err := c.store.UpsertMedia(ctx, StoredMedia{
		MessageID:       evt.Info.ID,
		ChatJID:         evt.Info.Chat.String(),
		MIMEType:        media.mimeType,
		SizeBytes:       sizeBytes,
		DurationSeconds: media.durationSeconds,
		FileName:        fileName,
	})
	if err != nil {
		c.log.Errorf("store media metadata for message %s: %v", evt.Info.ID, err)
	}
}

func (c *collector) handleHistorySync(ctx context.Context, data *waHistorySync.HistorySync) {
	conversations := data.GetConversations()
	c.log.Infof("History sync: %d conversations (type %s)", len(conversations), data.GetSyncType())
	stored := 0
	for _, conv := range conversations {
		chatJID, err := types.ParseJID(conv.GetID())
		if err != nil {
			c.log.Warnf("history sync: bad chat JID %q: %v", conv.GetID(), err)
			continue
		}
		isGroup := chatJID.Server == types.GroupServer
		if err := c.store.UpsertChat(ctx, chatJID.String(), conv.GetName(), isGroup); err != nil {
			c.log.Errorf("upsert chat %s: %v", chatJID, err)
		}
		for _, historyMsg := range conv.GetMessages() {
			msgEvt, err := c.client.ParseWebMessage(chatJID, historyMsg.GetMessage())
			if err != nil {
				continue
			}
			if c.persistMessage(ctx, msgEvt) {
				stored++
			}
		}
	}
	c.log.Infof("History sync: stored %d messages", stored)
	_ = c.store.SetMeta(ctx, "last_history_sync", time.Now().UTC().Format(time.RFC3339))
}

// syncDirectory mirrors contact names and joined-group names so the MCP
// server can resolve display names. Read-only lookups.
func (c *collector) syncDirectory() {
	ctx := context.Background()
	if contacts, err := c.client.Store.Contacts.GetAllContacts(ctx); err != nil {
		c.log.Warnf("fetch contacts: %v", err)
	} else {
		for jid, info := range contacts {
			name := info.FullName
			if name == "" {
				name = info.FirstName
			}
			if name == "" {
				name = info.PushName
			}
			if err := c.store.UpsertContact(ctx, jid.ToNonAD().String(), name); err != nil {
				c.log.Errorf("upsert contact %s: %v", jid, err)
			}
		}
		c.log.Infof("Synced %d contacts", len(contacts))
	}

	if groups, err := c.client.GetJoinedGroups(ctx); err != nil {
		c.log.Warnf("fetch joined groups: %v", err)
	} else {
		for _, g := range groups {
			if err := c.store.UpsertChat(ctx, g.JID.String(), g.Name, true); err != nil {
				c.log.Errorf("upsert group %s: %v", g.JID, err)
			}
		}
		c.log.Infof("Synced %d groups", len(groups))
	}
	_ = c.store.SetMeta(ctx, "last_connected", time.Now().UTC().Format(time.RFC3339))
}
