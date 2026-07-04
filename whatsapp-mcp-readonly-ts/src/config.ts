/**
 * @module config
 * TOML config: paths, privacy caps, access lists, audit. Read-only enforced at load.
 */
import { parse as parseToml } from "smol-toml";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface Config {
  whatsapp: {
    database_path: string;
    readonly: true;
  };
  privacy: {
    redact_phone_numbers: boolean;
    redact_jids: boolean;
    max_messages_per_call: number;
  };
  access: {
    allowed_chat_ids: string[];
    blocked_chat_ids: string[];
  };
  audit: {
    enabled: boolean;
    log_path: string;
  };
}

const DATA_DIR = join(homedir(), ".local", "share", "whatsapp-reader");

export function defaultConfig(): Config {
  return {
    whatsapp: {
      database_path: join(DATA_DIR, "messages.db"),
      readonly: true,
    },
    privacy: {
      redact_phone_numbers: false,
      redact_jids: false,
      max_messages_per_call: 100,
    },
    access: {
      allowed_chat_ids: [],
      blocked_chat_ids: [],
    },
    audit: {
      enabled: true,
      log_path: join(DATA_DIR, "audit.log"),
    },
  };
}

export function configPath(): string {
  return (
    process.env.WHATSAPP_MCP_CONFIG ??
    join(homedir(), ".config", "whatsapp-mcp", "config.toml")
  );
}

/**
 * Load TOML config; safe defaults for missing keys.
 * @throws {Error} readonly=false in config -> refuse start.
 */
export function loadConfig(path: string = configPath()): Config {
  const config = defaultConfig();
  if (!existsSync(path)) {
    return config;
  }
  const raw = parseToml(readFileSync(path, "utf-8")) as Record<string, any>;

  if (raw.whatsapp?.readonly === false) {
    throw new Error(
      `refusing to start: [whatsapp].readonly=false in ${path}; this server is read-only by design`,
    );
  }
  if (typeof raw.whatsapp?.database_path === "string") {
    config.whatsapp.database_path = raw.whatsapp.database_path;
  }
  if (typeof raw.privacy?.redact_phone_numbers === "boolean") {
    config.privacy.redact_phone_numbers = raw.privacy.redact_phone_numbers;
  }
  if (typeof raw.privacy?.redact_jids === "boolean") {
    config.privacy.redact_jids = raw.privacy.redact_jids;
  }
  if (typeof raw.privacy?.max_messages_per_call === "number") {
    config.privacy.max_messages_per_call = Math.max(
      1,
      Math.min(500, Math.floor(raw.privacy.max_messages_per_call)),
    );
  }
  if (Array.isArray(raw.access?.allowed_chat_ids)) {
    config.access.allowed_chat_ids = raw.access.allowed_chat_ids.map(String);
  }
  if (Array.isArray(raw.access?.blocked_chat_ids)) {
    config.access.blocked_chat_ids = raw.access.blocked_chat_ids.map(String);
  }
  if (typeof raw.audit?.enabled === "boolean") {
    config.audit.enabled = raw.audit.enabled;
  }
  if (typeof raw.audit?.log_path === "string") {
    config.audit.log_path = raw.audit.log_path;
  }
  return config;
}
