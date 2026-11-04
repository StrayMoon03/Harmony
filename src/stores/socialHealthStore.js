const { getDb } = require("../db/sqlite");

const PLATFORMS = new Set(["instagram", "facebook", "youtube", "threads", "tiktok", "x"]);

function safeTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function get(platform) {
  if (!PLATFORMS.has(platform)) return null;
  return getDb().prepare("SELECT platform, state, failure_kind, last_success_at, updated_at FROM social_health_state WHERE platform = ?").get(platform) || null;
}

function recordFailure(platform, kind, at) {
  if (!PLATFORMS.has(platform) || !["session", "owner"].includes(kind)) return false;
  const timestamp = safeTimestamp(at);
  getDb().prepare(`
    INSERT INTO social_health_state (platform, state, failure_kind, last_success_at, updated_at)
    VALUES (?, 'failure', ?, NULL, ?)
    ON CONFLICT(platform) DO UPDATE SET
      state = 'failure', failure_kind = excluded.failure_kind,
      last_success_at = NULL, updated_at = excluded.updated_at
  `).run(platform, kind, timestamp);
  return true;
}

function recordSuccess(platform, at) {
  if (!PLATFORMS.has(platform)) return false;
  const timestamp = safeTimestamp(at);
  const current = get(platform);
  if (current?.state === "failure" && current.failure_kind === "owner") {
    // Keep a successful request for diagnostics while retaining the unresolved checkpoint.
    getDb().prepare("UPDATE social_health_state SET last_success_at = ? WHERE platform = ?")
      .run(timestamp, platform);
    return true;
  }
  getDb().prepare(`
    INSERT INTO social_health_state (platform, state, failure_kind, last_success_at, updated_at)
    VALUES (?, 'success', NULL, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      state = 'success', failure_kind = NULL,
      last_success_at = excluded.last_success_at, updated_at = excluded.updated_at
  `).run(platform, timestamp, timestamp);
  return true;
}

function recordVerifiedSuccess(platform, at) {
  if (!PLATFORMS.has(platform)) return false;
  const timestamp = safeTimestamp(at);
  getDb().prepare(`
    INSERT INTO social_health_state (platform, state, failure_kind, last_success_at, updated_at)
    VALUES (?, 'success', NULL, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      state = 'success', failure_kind = NULL,
      last_success_at = excluded.last_success_at, updated_at = excluded.updated_at
  `).run(platform, timestamp, timestamp);
  return true;
}

module.exports = { PLATFORMS, get, recordFailure, recordSuccess, recordVerifiedSuccess };
