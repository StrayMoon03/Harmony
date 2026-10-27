const { getDb } = require("../db/sqlite");

const SERVICES = new Set(["instagram", "threads", "facebook", "youtube"]);

function createRequest({ requestId, tokenHash, guildId, actorId, service, createdAt, expiresAt }) {
  if (!SERVICES.has(service)) throw new Error("unsupported_service");
  getDb().prepare(`
    INSERT INTO credential_refresh_requests (
      request_id, token_hash, guild_id, actor_id, service, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(requestId, tokenHash, guildId, actorId, service, createdAt, expiresAt);
  return { requestId, guildId, actorId, service, status: "pending", createdAt, expiresAt };
}

function countRecentRequests({ guildId, actorId, since }) {
  return Number(getDb().prepare(`
    SELECT COUNT(*) AS total FROM credential_refresh_requests
    WHERE guild_id = ? AND actor_id = ? AND created_at >= ?
  `).get(guildId, actorId, since)?.total || 0);
}

function redeemRequest({ tokenHash, guildId, actorId, service, now }) {
  const db = getDb();
  const request = db.prepare("SELECT * FROM credential_refresh_requests WHERE token_hash = ?").get(tokenHash);
  if (!request) return { ok: false, reason: "invalid_request" };
  if (request.guild_id !== guildId || request.actor_id !== actorId || request.service !== service) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (request.status !== "pending") return { ok: false, reason: "already_used" };
  if (new Date(request.expires_at).getTime() <= new Date(now).getTime()) {
    db.prepare("UPDATE credential_refresh_requests SET status = 'expired' WHERE request_id = ? AND status = 'pending'").run(request.request_id);
    return { ok: false, reason: "expired" };
  }
  const changed = db.prepare(`
    UPDATE credential_refresh_requests SET status = 'consumed', redeemed_at = ?
    WHERE request_id = ? AND status = 'pending' AND expires_at > ?
  `).run(now, request.request_id, now).changes;
  if (!changed) return { ok: false, reason: "already_used" };
  return { ok: true, requestId: request.request_id, guildId, actorId, service, expiresAt: request.expires_at };
}

function completeRequest({ requestId, guildId, actorId, service, now }) {
  if (!SERVICES.has(service)) return false;
  return Number(getDb().prepare(`
    UPDATE credential_refresh_requests SET status = 'completed', completed_at = ?
    WHERE request_id = ? AND guild_id = ? AND actor_id = ? AND service = ? AND status = 'consumed'
  `).run(now, requestId, guildId, actorId, service).changes) > 0;
}

function expirePending(now) {
  return Number(getDb().prepare(`
    UPDATE credential_refresh_requests SET status = 'expired'
    WHERE status = 'pending' AND expires_at <= ?
  `).run(now).changes);
}

module.exports = { SERVICES, createRequest, countRecentRequests, redeemRequest, completeRequest, expirePending };
