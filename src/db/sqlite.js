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
