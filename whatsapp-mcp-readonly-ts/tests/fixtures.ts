/**
 * @module tests/fixtures
 * Builds throwaway SQLite databases mirroring the whatsapp-reader-go schema.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { defaultConfig, type Config } from "../src/config.ts";
import { ReadOnlyDb } from "../src/db.ts";
import type { ToolContext } from "../src/tools.ts";

type AuditEntry = Parameters<ToolContext["audit"]["log"]>[0];

// [!]: must stay in sync with whatsapp-reader-go/store.go
const SCHEMA = `
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT
);
CREATE TABLE contacts (
  jid TEXT PRIMARY KEY,
  display_name TEXT
);
CREATE TABLE messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  is_from_me INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  content TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  PRIMARY KEY (id, chat_jid)
);
CREATE TABLE message_media (
  message_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_seconds INTEGER,
  file_name TEXT NOT NULL,
  PRIMARY KEY (message_id, chat_jid),
  FOREIGN KEY (message_id, chat_jid)
    REFERENCES messages(id, chat_jid) ON DELETE CASCADE
);
CREATE TABLE sync_metadata (key TEXT PRIMARY KEY, value TEXT);
`;

export const ME_JID = "33600000001@s.whatsapp.net";
export const ALICE_JID = "33600000002@s.whatsapp.net";
export const BOB_JID = "2250700000003@s.whatsapp.net";
export const ALICE_CHAT = ALICE_JID;
export const GROUP_CHAT = "1203630000000000@g.us";

export interface FixtureMessage {
  id: string;
  chat: string;
  sender: string;
  fromMe: boolean;
  ts: string;
  content: string;
  type?: string;
  media?: {
    mimeType: string;
    data: Uint8Array;
    durationSeconds?: number;
  };
}

export function seedDatabase(path: string, messages: FixtureMessage[]): void {
  const db = new Database(path);
  db.run(SCHEMA);
  db.run(`
    INSERT INTO chats (jid, name, is_group, last_message_at) VALUES
      ('${ALICE_CHAT}', 'Alice', 0, NULL),
      ('${GROUP_CHAT}', 'Team Group', 1, NULL);
    INSERT INTO contacts (jid, display_name) VALUES
      ('${ALICE_JID}', 'Alice'),
      ('${BOB_JID}', 'Bob');
  `);
  const insert = db.prepare(
    `INSERT INTO messages (id, chat_jid, sender_jid, is_from_me, timestamp, content, message_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const touch = db.prepare(
    `UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, ''), ?) WHERE jid = ?`,
  );
  const insertMedia = db.prepare(
    `INSERT INTO message_media (
       message_id, chat_jid, mime_type, size_bytes, duration_seconds, file_name
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const mediaDir = join(dirname(path), "media");
  for (const m of messages) {
    insert.run(
      m.id,
      m.chat,
      m.sender,
      m.fromMe ? 1 : 0,
      m.ts,
      m.content,
      m.type ?? "text",
    );
    touch.run(m.ts, m.chat);
    if (m.media) {
      const fileName = createHash("sha256").update(m.media.data).digest("hex");
      mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(mediaDir, fileName), m.media.data, { mode: 0o600 });
      insertMedia.run(
        m.id,
        m.chat,
        m.media.mimeType,
        m.media.data.byteLength,
        m.media.durationSeconds ?? null,
        fileName,
      );
    }
  }
  db.close();
}

export function defaultMessages(): FixtureMessage[] {
  return [
    {
      id: "A1",
      chat: ALICE_CHAT,
      sender: ALICE_JID,
      fromMe: false,
      ts: "2026-07-01T10:00:00Z",
      content: "Salut, tu es dispo demain ?",
    },
    {
      id: "A2",
      chat: ALICE_CHAT,
      sender: ME_JID,
      fromMe: true,
      ts: "2026-07-01T10:05:00Z",
      content: "Oui, appelle-moi au +33 6 12 34 56 78",
    },
    {
      id: "A3",
      chat: ALICE_CHAT,
      sender: ALICE_JID,
      fromMe: false,
      ts: "2026-07-01T10:06:00Z",
      content: "Parfait, merci !",
    },
    {
      id: "G1",
      chat: GROUP_CHAT,
      sender: BOB_JID,
      fromMe: false,
      ts: "2026-07-02T09:00:00Z",
      content: "Reunion lundi",
    },
    {
      id: "G2",
      chat: GROUP_CHAT,
      sender: ME_JID,
      fromMe: true,
      ts: "2026-07-02T09:01:00Z",
      content: "Ok pour lundi",
    },
    {
      id: "G3",
      chat: GROUP_CHAT,
      sender: ALICE_JID,
      fromMe: false,
      ts: "2026-07-02T09:02:00Z",
      content: "Je serai en retard",
    },
  ];
}

export function makeContext(overrides?: {
  config?: (config: Config) => void;
  messages?: FixtureMessage[];
}): { ctx: ToolContext; dbPath: string; auditEntries: AuditEntry[] } {
  const dir = mkdtempSync(join(tmpdir(), "wamcp-test-"));
  const dbPath = join(dir, "messages.db");
  seedDatabase(dbPath, overrides?.messages ?? defaultMessages());
  const config = defaultConfig();
  config.whatsapp.database_path = dbPath;
  config.audit.enabled = false;
  overrides?.config?.(config);
  const auditEntries: AuditEntry[] = [];
  return {
    ctx: {
      db: new ReadOnlyDb(dbPath),
      config,
      audit: { log: (entry) => auditEntries.push(entry) },
    },
    dbPath,
    auditEntries,
  };
}
