function migrateRadar(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS radar_settings (
      guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
      calendar_guild_id TEXT, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      delivery_error TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS radar_sources (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, provider TEXT NOT NULL,
      account_id TEXT NOT NULL, source_url TEXT NOT NULL, authority TEXT NOT NULL,
      account_metadata TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      initialized_at TEXT, catchup_since TEXT, cursor TEXT,
      etag TEXT, last_modified TEXT, last_attempt_at TEXT, last_success_at TEXT,
      next_poll_at TEXT, result TEXT NOT NULL DEFAULT 'pending', error TEXT, limitation TEXT,
      UNIQUE(guild_id, provider, account_id)
    );
    CREATE TABLE IF NOT EXISTS radar_observations (
      id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES radar_sources(id),
      item_id TEXT NOT NULL, canonical_url TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
      title TEXT NOT NULL, summary TEXT NOT NULL, published_at TEXT, source_updated_at TEXT,
      discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL, content_hash TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}', UNIQUE(source_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS radar_discoveries (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      members TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT 'Unknown',
      confidence TEXT NOT NULL DEFAULT 'uncertain',
      review_state TEXT NOT NULL DEFAULT 'Needs Review'
        CHECK(review_state IN ('Needs Review','Watching','Ignored','Resolved')),
      correlation_key TEXT, event_date TEXT, event_at TEXT, event_timezone TEXT,
      calendar_eligibility TEXT NOT NULL DEFAULT 'Unknown'
        CHECK(calendar_eligibility IN ('Unknown','Potential','Ready')),
      eligibility_reason TEXT NOT NULL DEFAULT 'Event date and calendar details need review.',
      calendar_guild_id TEXT, calendar_candidate_id INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(guild_id, correlation_key)
    );
    CREATE TABLE IF NOT EXISTS radar_support (
      discovery_id INTEGER NOT NULL REFERENCES radar_discoveries(id),
      observation_id INTEGER NOT NULL REFERENCES radar_observations(id),
      PRIMARY KEY(discovery_id, observation_id)
    );
    CREATE TABLE IF NOT EXISTS radar_deliveries (
      discovery_id INTEGER NOT NULL REFERENCES radar_discoveries(id),
      channel_id TEXT NOT NULL, message_id TEXT, token TEXT NOT NULL,
      started_at TEXT NOT NULL, delivered_hash TEXT,
      PRIMARY KEY(discovery_id, channel_id)
    );
    CREATE INDEX IF NOT EXISTS radar_discovery_review ON radar_discoveries(guild_id, review_state, id);
    CREATE INDEX IF NOT EXISTS radar_support_observation ON radar_support(observation_id);
  `);
  // Additive upgrades also support databases initialized by an earlier Phase 1A build.
  for (const [table, columns] of Object.entries({
    radar_sources: { traversal_state: "TEXT", watch_cursor: "INTEGER NOT NULL DEFAULT 0" },
    radar_observations: { correlation_key: "TEXT" },
    radar_support: { active: "INTEGER NOT NULL DEFAULT 1", snapshot: "TEXT" },
    radar_discoveries: { handoff_request: "TEXT", handoff_result: "TEXT" },
    radar_deliveries: { checked_at: "TEXT", recovery_before: "TEXT" },
  })) {
    const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}
module.exports = { migrateRadar };
