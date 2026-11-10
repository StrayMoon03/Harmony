const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { migrate } = require("../src/db/sqlite");

test("birthday history migration preserves member rows and supports named non-member rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE birthday_announcement_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        birthday_mmdd TEXT NOT NULL,
        announced_at TEXT NOT NULL,
        UNIQUE(guild_id, user_id, announced_at)
      );
      CREATE INDEX idx_birthday_history_guild_time ON birthday_announcement_history(guild_id, announced_at);
      INSERT INTO birthday_announcement_history (guild_id, user_id, birthday_mmdd, announced_at)
      VALUES ('guild-existing', 'member-1', '10-25', '2025-10-25T13:00:00.000Z');
    `);
    migrate(db);
    const columns = db.prepare("PRAGMA table_info(birthday_announcement_history)").all();
    assert.equal(columns.find((column) => column.name === "user_id").notnull, 0);
    assert.ok(columns.some((column) => column.name === "birthday_name"));
    const legacy = db.prepare("SELECT * FROM birthday_announcement_history WHERE guild_id = ?").get("guild-existing");
    assert.equal(legacy.id, 1);
    assert.equal(legacy.user_id, "member-1");
    assert.equal(legacy.birthday_mmdd, "10-25");
    assert.equal(legacy.announced_at, "2025-10-25T13:00:00.000Z");
    db.prepare(`
      INSERT INTO birthday_announcement_history (guild_id, user_id, birthday_name, birthday_mmdd, announced_at)
      VALUES (?, NULL, ?, ?, ?)
    `).run("guild-new", "Lee Know", "10-25", "2026-10-25T00:00:00.000Z");
    assert.equal(db.prepare("SELECT birthday_name FROM birthday_announcement_history WHERE guild_id = ?").get("guild-new").birthday_name, "Lee Know");
  } finally {
    db.close();
  }
});

test("member bias migration copies legacy scalar values without changing them", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE birthday_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        welcome_pass_code TEXT UNIQUE,
        guild_id TEXT,
        user_id TEXT,
        celebration_enabled INTEGER NOT NULL DEFAULT 0,
        birthday_mmdd TEXT,
        birthday_name TEXT,
        discord_username TEXT,
        timezone TEXT,
        bias TEXT,
        custom_message TEXT,
        custom_image_url TEXT,
        last_announced_year INTEGER,
        role_remove_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (guild_id, user_id)
      );
      CREATE INDEX idx_birthday_profiles_guild_date ON birthday_profiles(guild_id, birthday_mmdd);
      CREATE INDEX idx_birthday_profiles_role_remove ON birthday_profiles(role_remove_at);
      INSERT INTO birthday_profiles (guild_id, user_id, celebration_enabled, birthday_mmdd, birthday_name, bias, created_at, updated_at)
      VALUES ('guild-1', 'member-1', 1, '01-02', 'Member', 'Han', '2024-01-01', '2024-01-01');
    `);
    migrate(db);
    const row = db.prepare("SELECT bias, biases_json FROM birthday_profiles WHERE user_id = 'member-1'").get();
    assert.equal(row.bias, "Han");
    assert.deepEqual(JSON.parse(row.biases_json), ["Han"]);
  } finally {
    db.close();
  }
});
