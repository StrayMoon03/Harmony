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

test("social health migration is additive and idempotent", () => {
  const database = new DatabaseSync(":memory:");
  migrate(database);
  migrate(database);
  const columns = database.prepare("PRAGMA table_info(social_health_state)").all().map((column) => column.name);
  assert.deepEqual(columns, ["platform", "state", "failure_kind", "last_success_at", "success_kind", "last_verified_at", "last_failure_at", "diagnostic_category", "updated_at"]);
  database.prepare(`
    INSERT INTO social_health_state (platform, state, failure_kind, last_success_at, updated_at)
    VALUES ('facebook', 'failure', 'session', NULL, '2026-11-02T12:00:00.000Z')
  `).run();
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM social_health_state").get().n, 1);
  assert.throws(() => database.prepare(`
    INSERT INTO social_health_state (platform, state, failure_kind, last_success_at, updated_at)
    VALUES ('unknown-platform', 'failure', 'session', NULL, '2026-11-02T12:00:00.000Z')
  `).run(), /CHECK constraint failed/);
  database.close();
});

test("social health migration preserves legacy state rows and adds verification metadata safely", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE social_health_state (
    platform TEXT PRIMARY KEY CHECK (platform IN ('instagram', 'facebook', 'youtube', 'threads', 'tiktok', 'x')),
    state TEXT NOT NULL CHECK (state IN ('success', 'failure')),
    failure_kind TEXT CHECK (failure_kind IN ('session', 'owner')),
    last_success_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK ((state = 'success' AND failure_kind IS NULL AND last_success_at IS NOT NULL) OR (state = 'failure' AND failure_kind IS NOT NULL))
  );
  INSERT INTO social_health_state VALUES ('facebook', 'failure', 'session', NULL, '2026-11-07T00:00:00.000Z');`);
  migrate(database);
  const state = database.prepare("SELECT platform, state, failure_kind, success_kind, last_failure_at FROM social_health_state WHERE platform='facebook'").get();
  assert.equal(state.platform, "facebook");
  assert.equal(state.state, "failure");
  assert.equal(state.failure_kind, "session");
  assert.equal(state.success_kind, null);
  assert.equal(state.last_failure_at, null);
  database.prepare("INSERT INTO social_health_verification_attempts VALUES ('facebook', '2026-11-07T00:05:00.000Z', 'unknown')").run();
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM social_health_verification_attempts").get().n, 1);
  database.close();
});
