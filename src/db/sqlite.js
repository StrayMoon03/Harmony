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
  `);
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
