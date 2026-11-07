const { getDb } = require("../db/sqlite");

const PLATFORMS = new Set(["instagram", "facebook", "youtube", "threads", "tiktok", "x"]);
const VERIFY_PLATFORMS = new Set(["instagram", "facebook", "youtube", "threads"]);
const FAILURE_CATEGORIES = new Set([
  "login_required", "session_invalid", "checkpoint", "challenge",
  "identity_mismatch", "identity_unverified", "missing_required_cookies",
  "provider_auth_failure",
]);
const SUCCESS_KINDS = new Set(["media", "authenticated_media", "verification", "refresh"]);

function safeTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function get(platform) {
  if (!PLATFORMS.has(platform)) return null;
  return getDb().prepare(`
    SELECT platform, state, failure_kind, last_success_at, success_kind,
      last_verified_at, last_failure_at, diagnostic_category, updated_at
    FROM social_health_state WHERE platform = ?
  `).get(platform) || null;
}

function recordFailure(platform, kind, at, diagnosticCategory = "provider_auth_failure") {
  if (!PLATFORMS.has(platform) || !["session", "owner"].includes(kind)) return false;
  const timestamp = safeTimestamp(at);
  const category = FAILURE_CATEGORIES.has(diagnosticCategory) ? diagnosticCategory : "provider_auth_failure";
  getDb().prepare(`
    INSERT INTO social_health_state
      (platform, state, failure_kind, last_success_at, success_kind, last_verified_at, last_failure_at, diagnostic_category, updated_at)
    VALUES (?, 'failure', ?, NULL, NULL, NULL, ?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      state = 'failure', failure_kind = excluded.failure_kind,
      last_success_at = NULL, success_kind = NULL,
      last_failure_at = excluded.last_failure_at,
      diagnostic_category = excluded.diagnostic_category,
      updated_at = excluded.updated_at
  `).run(platform, kind, timestamp, category, timestamp);
  return true;
}

function recordSuccess(platform, at, kind = "media") {
  if (!PLATFORMS.has(platform) || !SUCCESS_KINDS.has(kind)) return false;
  const timestamp = safeTimestamp(at);
  const current = get(platform);
  if (current?.state === "failure" && current.failure_kind === "owner") {
    getDb().prepare("UPDATE social_health_state SET last_success_at = ?, success_kind = ? WHERE platform = ?")
      .run(timestamp, kind, platform);
    return true;
  }
  getDb().prepare(`
    INSERT INTO social_health_state
      (platform, state, failure_kind, last_success_at, success_kind, last_verified_at, last_failure_at, diagnostic_category, updated_at)
    VALUES (?, 'success', NULL, ?, ?, NULL, NULL, NULL, ?)
    ON CONFLICT(platform) DO UPDATE SET
      state = 'success', failure_kind = NULL,
      last_success_at = excluded.last_success_at, success_kind = excluded.success_kind,
      last_failure_at = NULL, diagnostic_category = NULL, updated_at = excluded.updated_at
  `).run(platform, timestamp, kind, timestamp);
  return true;
}

function recordVerifiedSuccess(platform, at, source = "verification") {
  if (!PLATFORMS.has(platform)) return false;
  const kind = source === "refresh" ? "refresh" : "verification";
  const timestamp = safeTimestamp(at);
  getDb().prepare(`
    INSERT INTO social_health_state
      (platform, state, failure_kind, last_success_at, success_kind, last_verified_at, last_failure_at, diagnostic_category, updated_at)
    VALUES (?, 'success', NULL, ?, ?, ?, NULL, NULL, ?)
    ON CONFLICT(platform) DO UPDATE SET
      state = 'success', failure_kind = NULL,
      last_success_at = excluded.last_success_at, success_kind = excluded.success_kind,
      last_verified_at = excluded.last_verified_at,
      last_failure_at = NULL, diagnostic_category = NULL, updated_at = excluded.updated_at
  `).run(platform, timestamp, kind, timestamp, timestamp);
  return true;
}

function getVerificationAttempt(platform) {
  if (!VERIFY_PLATFORMS.has(platform)) return null;
  return getDb().prepare("SELECT platform, last_attempt_at, last_result FROM social_health_verification_attempts WHERE platform = ?").get(platform) || null;
}

function recordVerificationAttempt(platform, at, result) {
  if (!VERIFY_PLATFORMS.has(platform) || !["verified", "session", "owner", "unknown"].includes(result)) return false;
  getDb().prepare(`
    INSERT INTO social_health_verification_attempts (platform, last_attempt_at, last_result)
    VALUES (?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_result = excluded.last_result
  `).run(platform, safeTimestamp(at), result);
  return true;
}

module.exports = {
  PLATFORMS, VERIFY_PLATFORMS, FAILURE_CATEGORIES, SUCCESS_KINDS,
  get, recordFailure, recordSuccess, recordVerifiedSuccess,
  getVerificationAttempt, recordVerificationAttempt,
};
