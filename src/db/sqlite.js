const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.resolve(__dirname, "../../data");
const DB_PATH = path.join(DATA_DIR, "harmony.sqlite");

/** @type {import("node:sqlite").DatabaseSync | null} */
let db = null;

/**
 * Open (or return) the shared SQLite connection.
 * Uses Node's built-in node:sqlite — no native npm package required.
 */
function getDb() {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  migrate(db);

  return db;
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      platform      TEXT    NOT NULL,
      media_id      TEXT    NOT NULL,
      creator       TEXT,
      shared_by     TEXT    NOT NULL,
      shared_by_id  TEXT,
      shared_at     TEXT    NOT NULL,
      message_id    TEXT,
      channel_id    TEXT,
      guild_id      TEXT,
      url           TEXT,
      UNIQUE (platform, media_id)
    );

    CREATE INDEX IF NOT EXISTS idx_shares_platform_media
      ON shares (platform, media_id);

    CREATE TABLE IF NOT EXISTS greeting_settings (
      guild_id          TEXT PRIMARY KEY,
      channel_id        TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      entrance_message  TEXT NOT NULL,
      exit_message      TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS welcome_pass_settings (
      guild_id    TEXT PRIMARY KEY,
      role_id     TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS welcome_pass_links (
      code         TEXT PRIMARY KEY,
      guild_id     TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      linked_at    TEXT NOT NULL,
      assigned_at  TEXT,
      UNIQUE (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS welcome_pass_approvals (
      code           TEXT PRIMARY KEY,
      approver_name  TEXT NOT NULL,
      approved_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_welcome_pass_links_member
      ON welcome_pass_links (guild_id, user_id);

    CREATE INDEX IF NOT EXISTS idx_shares_guild_time
      ON shares (guild_id, shared_at);

    CREATE INDEX IF NOT EXISTS idx_shares_guild_user_time
      ON shares (guild_id, shared_by_id, shared_at);

    CREATE TABLE IF NOT EXISTS collection_settings (
      guild_id            TEXT PRIMARY KEY,
      channel_id          TEXT NOT NULL,
      milestones_enabled  INTEGER NOT NULL DEFAULT 1,
      schedule_enabled    INTEGER NOT NULL DEFAULT 0,
      weekday             INTEGER NOT NULL DEFAULT 0,
      hour                INTEGER NOT NULL DEFAULT 10,
      timezone            TEXT NOT NULL DEFAULT 'America/New_York',
      last_weekly_key     TEXT,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_milestones (
      guild_id      TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      milestone     INTEGER NOT NULL,
      announced_at  TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id, milestone)
    );

    CREATE TABLE IF NOT EXISTS message_log_settings (
      guild_id    TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_log_exclusions (
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS message_snapshots (
      message_id   TEXT PRIMARY KEY,
      guild_id     TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      username     TEXT NOT NULL,
      content      TEXT,
      attachments  TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_message_snapshots_expiry
      ON message_snapshots (expires_at);

    CREATE TABLE IF NOT EXISTS message_log_posts (
      message_id  TEXT PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      delete_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_message_log_posts_delete
      ON message_log_posts (delete_at);

    CREATE TABLE IF NOT EXISTS community_guard_settings (
      guild_id    TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS community_guard_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      rule_type  TEXT NOT NULL CHECK (rule_type IN ('domain', 'url', 'phrase')),
      pattern    TEXT NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('flag', 'remove')),
      category   TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_community_guard_rules_guild
      ON community_guard_rules (guild_id, enabled);

    CREATE TABLE IF NOT EXISTS community_guard_safe_messages (
      guild_id    TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      marked_by   TEXT NOT NULL,
      marked_at   TEXT NOT NULL,
      PRIMARY KEY (guild_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS community_guard_actions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id      TEXT NOT NULL,
      message_id    TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      category      TEXT NOT NULL,
      source        TEXT NOT NULL,
      rule_id       INTEGER,
      admin_id      TEXT,
      dm_delivered  INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_community_guard_actions_guild_time
      ON community_guard_actions (guild_id, created_at);
  `);

  const settingColumns = new Set(
    database.prepare("PRAGMA table_info(welcome_pass_settings)").all()
      .map((column) => column.name)
  );
  if (!settingColumns.has("release_channel_id")) {
    database.exec(
      "ALTER TABLE welcome_pass_settings ADD COLUMN release_channel_id TEXT"
    );
  }
  if (!settingColumns.has("release_message")) {
    database.exec(
      "ALTER TABLE welcome_pass_settings ADD COLUMN release_message TEXT"
    );
  }
  if (!settingColumns.has("grant_mode")) {
    database.exec(
      "ALTER TABLE welcome_pass_settings ADD COLUMN grant_mode TEXT NOT NULL DEFAULT 'automatic'"
    );
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  closeDb,
  DB_PATH,
};
