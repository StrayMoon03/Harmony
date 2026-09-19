const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { migrate } = require("./sqlite");

test("share deduplication is scoped to one Discord server", () => {
  const database = new DatabaseSync(":memory:");
  migrate(database);

  const insert = database.prepare(`
    INSERT INTO shares (
      platform, media_id, shared_by, shared_at, guild_id
    ) VALUES (?, ?, ?, ?, ?)
  `);

  insert.run("facebook", "same-post", "Amy", "2026-09-17T15:32:00.000Z", "server-a");
  insert.run("facebook", "same-post", "Amy", "2026-09-17T15:37:00.000Z", "server-b");

  assert.throws(
    () => insert.run("facebook", "same-post", "Amy", "2026-09-17T15:38:00.000Z", "server-a"),
    /UNIQUE/
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS total FROM shares").get().total,
    2
  );

  database.close();
});

test("legacy share rows survive the one-time guild-scope migration", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      media_id TEXT NOT NULL,
      creator TEXT,
      shared_by TEXT NOT NULL,
      shared_by_id TEXT,
      shared_at TEXT NOT NULL,
      message_id TEXT,
      channel_id TEXT,
      guild_id TEXT,
      url TEXT,
      UNIQUE (platform, media_id)
    );
    INSERT INTO shares (
      platform, media_id, shared_by, shared_at, guild_id, url
    ) VALUES (
      'facebook', 'kept-post', 'Amy', '2026-09-17T15:32:00.000Z',
      'server-a', 'https://www.facebook.com/share/v/example'
    );
  `);

  migrate(database);

  const kept = database.prepare(
    "SELECT * FROM shares WHERE platform = 'facebook' AND media_id = 'kept-post'"
  ).get();
  assert.equal(kept.shared_by, "Amy");
  assert.equal(kept.guild_id, "server-a");

  database.prepare(`
    INSERT INTO shares (platform, media_id, shared_by, shared_at, guild_id)
    VALUES ('facebook', 'kept-post', 'Amy', '2026-09-17T15:37:00.000Z', 'server-b')
  `).run();

  assert.equal(
    database.prepare("SELECT COUNT(*) AS total FROM shares").get().total,
    2
  );
  database.close();
});
