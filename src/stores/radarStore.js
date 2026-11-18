const { createHash, randomUUID } = require("node:crypto");
const { getDb } = require("../db/sqlite");

const STATES = new Set(["Needs Review", "Watching", "Ignored", "Resolved"]);
const CATEGORIES = ["Event", "Release", "New Content", "Merch / Sale", "Appearance", "Ticketing", "Pop-up", "Announcement", "Unknown"];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (value) => String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
function transaction(work) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function getSettings(guildId) {
  return getDb().prepare("SELECT * FROM radar_settings WHERE guild_id = ?").get(guildId) || null;
}
function listSettings() {
  return getDb().prepare("SELECT * FROM radar_settings WHERE enabled = 1").all();
}
function saveSettings(guildId, channelId, calendarGuildId = null) {
  getDb().prepare(`INSERT INTO radar_settings(guild_id, channel_id, calendar_guild_id, updated_at)
    VALUES(?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,
    calendar_guild_id=COALESCE(excluded.calendar_guild_id, radar_settings.calendar_guild_id),
    enabled=1, updated_at=excluded.updated_at`).run(guildId, channelId, calendarGuildId, new Date().toISOString());
}
function setCalendarTarget(guildId, targetId) {
  getDb().prepare("UPDATE radar_settings SET calendar_guild_id=?, updated_at=? WHERE guild_id=?")
    .run(targetId, new Date().toISOString(), guildId);
}
function setEnabled(guildId, enabled) {
  getDb().prepare("UPDATE radar_settings SET enabled = ?, updated_at = ? WHERE guild_id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), guildId);
}
function setDeliveryError(guildId, message) {
  getDb().prepare("UPDATE radar_settings SET delivery_error = ? WHERE guild_id = ?").run(message, guildId);
}
function ensureSources(guildId, definitions) {
  const insert = getDb().prepare(`INSERT INTO radar_sources(guild_id, provider, account_id, source_url, authority, account_metadata)
    VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id, provider, account_id) DO NOTHING`);
  for (const source of definitions) {
    insert.run(guildId, source.key, source.accountId, source.url, "official", JSON.stringify(source.accountMetadata || {}));
  }
}
function listSources(guildId) {
  return getDb().prepare("SELECT * FROM radar_sources WHERE guild_id = ? ORDER BY id").all(guildId);
}
function updateSource(id, patch) {
  const columns = new Set(["initialized_at", "catchup_since", "cursor", "etag", "last_modified", "last_attempt_at",
    "last_success_at", "next_poll_at", "result", "error", "limitation", "enabled"]);
  const entries = Object.entries(patch);
  if (!entries.length || entries.some(([key]) => !columns.has(key))) throw new Error("Invalid Radar source state.");
  getDb().prepare(`UPDATE radar_sources SET ${entries.map(([key]) => key + " = ?").join(",")} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), id);
}
function getDiscovery(guildId, id) {
  return getDb().prepare("SELECT * FROM radar_discoveries WHERE guild_id = ? AND id = ?").get(guildId, id) || null;
}
function listDiscoveries(guildId) {
  return getDb().prepare("SELECT * FROM radar_discoveries WHERE guild_id = ? ORDER BY id DESC").all(guildId);
}
function supportingSources(discoveryId) {
  return getDb().prepare(`SELECT o.*, s.provider, s.account_id, s.authority FROM radar_support a
    JOIN radar_observations o ON o.id=a.observation_id JOIN radar_sources s ON s.id=o.source_id
    WHERE a.discovery_id = ? ORDER BY o.id`).all(discoveryId);
}
function watchingBoundary(sourceId) {
  return getDb().prepare(`SELECT MIN(o.published_at) AS earliest FROM radar_observations o
    JOIN radar_support a ON a.observation_id=o.id JOIN radar_discoveries d ON d.id=a.discovery_id
    WHERE o.source_id=? AND d.review_state='Watching'`).get(sourceId).earliest;
}
function setReviewState(guildId, id, state) {
  if (!STATES.has(state)) throw new Error("Invalid Radar review state.");
  return getDb().prepare("UPDATE radar_discoveries SET review_state=?, updated_at=? WHERE guild_id=? AND id=?")
    .run(state, new Date().toISOString(), guildId, id).changes > 0;
}
function ingest(source, item, classification, now = new Date().toISOString()) {
  if (!item.id || !item.url) throw new Error("Radar item identity is required.");
  const title = normalize(item.title) || "Untitled announcement";
  const summary = normalize(item.summary).slice(0, 6000);
  const metadata = item.metadata || {};
  const contentHash = hash([title, summary, item.publishedAt || null, metadata]);
  return transaction((db) => {
    const incomingAliases = [...new Set([item.url, ...(item.aliases || [])])];
    const existing = db.prepare("SELECT * FROM radar_observations WHERE source_id=? AND item_id=?").get(source.id, String(item.id)) ||
      db.prepare(`SELECT DISTINCT o.* FROM radar_observations o
        WHERE o.source_id=? AND (o.canonical_url IN (SELECT value FROM json_each(?))
        OR EXISTS(SELECT 1 FROM json_each(o.aliases) a JOIN json_each(?) b ON a.value=b.value))
        ORDER BY o.id LIMIT 1`).get(source.id, JSON.stringify(incomingAliases), JSON.stringify(incomingAliases));
    const itemId = existing?.item_id || String(item.id);
    const aliases = [...new Set([...(existing ? JSON.parse(existing.aliases) : []), ...incomingAliases])].sort();
    db.prepare(`INSERT INTO radar_observations(source_id,item_id,canonical_url,aliases,title,summary,published_at,
      source_updated_at,discovered_at,updated_at,content_hash,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id,item_id) DO UPDATE SET canonical_url=excluded.canonical_url,
      aliases=excluded.aliases, title=excluded.title, summary=excluded.summary,
      published_at=excluded.published_at, source_updated_at=excluded.source_updated_at,
      updated_at=CASE WHEN content_hash != excluded.content_hash THEN excluded.updated_at ELSE updated_at END,
      content_hash=excluded.content_hash, metadata=excluded.metadata`).run(
      source.id, itemId, item.url, JSON.stringify(aliases), title, summary, item.publishedAt || null,
      item.updatedAt || null, now, now, contentHash, JSON.stringify(metadata));
    const observation = db.prepare("SELECT * FROM radar_observations WHERE source_id=? AND item_id=?").get(source.id, itemId);
    const prior = db.prepare(`SELECT d.* FROM radar_discoveries d JOIN radar_support a ON a.discovery_id=d.id
      WHERE a.observation_id=? AND d.guild_id=? ORDER BY d.id LIMIT 1`).get(observation.id, source.guild_id);
    if (!classification) return { observation, discovery: prior || null };
    let discovery = prior;
    if (!discovery && classification.correlationKey) {
      discovery = db.prepare("SELECT * FROM radar_discoveries WHERE guild_id=? AND correlation_key=?")
        .get(source.guild_id, classification.correlationKey);
    }
    if (!discovery) {
      const result = db.prepare(`INSERT INTO radar_discoveries(guild_id,title,summary,members,category,confidence,
        correlation_key,calendar_eligibility,eligibility_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(source.guild_id, title, summary, JSON.stringify(classification.members || []),
          classification.category, classification.confidence, classification.correlationKey || null,
          classification.eligibility, classification.reason, now, now);
      discovery = getDiscovery(source.guild_id, Number(result.lastInsertRowid));
    } else if (prior && existing?.content_hash !== contentHash) {
      // Edits enrich the same discovery without undoing an owner's decision or calendar handoff.
      db.prepare(`UPDATE radar_discoveries SET title=?, summary=?, members=?, category=?, confidence=?,
        calendar_eligibility=CASE WHEN calendar_candidate_id IS NULL THEN ? ELSE calendar_eligibility END,
        updated_at=? WHERE id=?`)
        .run(title, summary, JSON.stringify(classification.members || []), classification.category,
          classification.confidence, classification.eligibility, now, discovery.id);
    }
    db.prepare("INSERT OR IGNORE INTO radar_support(discovery_id,observation_id) VALUES(?,?)").run(discovery.id, observation.id);
    return { observation, discovery: getDiscovery(source.guild_id, discovery.id) };
  });
}
function saveHandoff(guildId, id, targetGuildId, candidateId, details) {
  getDb().prepare(`UPDATE radar_discoveries SET calendar_guild_id=?, calendar_candidate_id=?, event_date=?,
    event_at=?, event_timezone=?, calendar_eligibility='Ready', eligibility_reason='Owner supplied calendar details.',
    updated_at=? WHERE guild_id=? AND id=?`)
    .run(targetGuildId, candidateId, details.date, details.at, details.timezone, new Date().toISOString(), guildId, id);
}
function delivery(discoveryId, channelId) {
  getDb().prepare(`INSERT INTO radar_deliveries(discovery_id,channel_id,token,started_at) VALUES(?,?,?,?)
    ON CONFLICT(discovery_id,channel_id) DO NOTHING`)
    .run(discoveryId, channelId, randomUUID(), new Date().toISOString());
  return getDb().prepare("SELECT * FROM radar_deliveries WHERE discovery_id=? AND channel_id=?").get(discoveryId, channelId);
}
function saveDelivery(discoveryId, channelId, messageId, contentHash) {
  getDb().prepare("UPDATE radar_deliveries SET message_id=?, delivered_hash=? WHERE discovery_id=? AND channel_id=?")
    .run(messageId, contentHash, discoveryId, channelId);
}
module.exports = {
  CATEGORIES, hash, getSettings, listSettings, saveSettings, setEnabled, setDeliveryError,
  setCalendarTarget, ensureSources, listSources, updateSource, getDiscovery, listDiscoveries, supportingSources,
  watchingBoundary, setReviewState, ingest, saveHandoff, delivery, saveDelivery,
};
