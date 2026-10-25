package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"time"
)

// MessageStore persists synced WhatsApp data into the local SQLite database
// that the MCP server later reads. It only ever INSERTs/UPDATEs local rows;
// it has no WhatsApp write capability.
type MessageStore struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS chats (
	jid             TEXT PRIMARY KEY,
	name            TEXT,
	is_group        INTEGER NOT NULL DEFAULT 0,
	last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
	jid          TEXT PRIMARY KEY,
	display_name TEXT
);

CREATE TABLE IF NOT EXISTS messages (
	id           TEXT NOT NULL,
	chat_jid     TEXT NOT NULL,
	sender_jid   TEXT NOT NULL,
	is_from_me   INTEGER NOT NULL,
	timestamp    TEXT NOT NULL,
	content      TEXT,
	message_type TEXT NOT NULL DEFAULT 'text',
	PRIMARY KEY (id, chat_jid)
);

CREATE TABLE IF NOT EXISTS message_media (
	message_id       TEXT NOT NULL,
	chat_jid         TEXT NOT NULL,
	mime_type        TEXT NOT NULL,
	size_bytes       INTEGER NOT NULL,
	duration_seconds INTEGER,
	file_name        TEXT NOT NULL,
	PRIMARY KEY (message_id, chat_jid),
	FOREIGN KEY (message_id, chat_jid) REFERENCES messages(id, chat_jid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (timestamp);

CREATE TABLE IF NOT EXISTS sync_metadata (
	key   TEXT PRIMARY KEY,
	value TEXT
);
`

func OpenMessageStore(path string) (*MessageStore, error) {
	db, err := sql.Open("sqlite3", "file:"+path+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("open message db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	// The database holds private conversations: owner-only access.
	if err := os.Chmod(path, 0o600); err != nil {
		db.Close()
		return nil, fmt.Errorf("restrict db permissions: %w", err)
	}
	return &MessageStore{db: db}, nil
}

func (s *MessageStore) Close() error {
	return s.db.Close()
}

type StoredMessage struct {
	ID          string
	ChatJID     string
	SenderJID   string
	IsFromMe    bool
	Timestamp   time.Time
	Content     string
	MessageType string
}

type StoredMedia struct {
	MessageID       string
	ChatJID         string
	MIMEType        string
	SizeBytes       int64
	DurationSeconds uint32
	FileName        string
}

func (s *MessageStore) UpsertMedia(ctx context.Context, m StoredMedia) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO message_media (
			message_id, chat_jid, mime_type, size_bytes, duration_seconds, file_name
		)
		VALUES (?, ?, ?, ?, NULLIF(?, 0), ?)
		ON CONFLICT(message_id, chat_jid) DO UPDATE SET
			mime_type = excluded.mime_type,
			size_bytes = excluded.size_bytes,
			duration_seconds = excluded.duration_seconds,
			file_name = excluded.file_name`,
		m.MessageID, m.ChatJID, m.MIMEType, m.SizeBytes, m.DurationSeconds, m.FileName)
	return err
}

func (s *MessageStore) UpsertMessage(ctx context.Context, m StoredMessage) error {
	ts := m.Timestamp.UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO messages (id, chat_jid, sender_jid, is_from_me, timestamp, content, message_type)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id, chat_jid) DO UPDATE SET
			sender_jid = excluded.sender_jid,
			is_from_me = excluded.is_from_me,
			timestamp = excluded.timestamp,
			content = excluded.content,
			message_type = excluded.message_type`,
		m.ID, m.ChatJID, m.SenderJID, boolToInt(m.IsFromMe), ts, m.Content, m.MessageType)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, ''), ?) WHERE jid = ?`,
		ts, m.ChatJID)
	return err
}

// UpsertChat records a chat; an empty name never overwrites a known one.
func (s *MessageStore) UpsertChat(ctx context.Context, jid, name string, isGroup bool) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO chats (jid, name, is_group)
		VALUES (?, NULLIF(?, ''), ?)
		ON CONFLICT(jid) DO UPDATE SET
			name = COALESCE(NULLIF(excluded.name, ''), chats.name),
			is_group = excluded.is_group`,
		jid, name, boolToInt(isGroup))
	return err
}

func (s *MessageStore) UpsertContact(ctx context.Context, jid, displayName string) error {
	if displayName == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO contacts (jid, display_name)
		VALUES (?, ?)
		ON CONFLICT(jid) DO UPDATE SET display_name = excluded.display_name`,
		jid, displayName)
	return err
}

func (s *MessageStore) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sync_metadata (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
