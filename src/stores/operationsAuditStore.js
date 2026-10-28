const { getDb } = require("../db/sqlite");

function recordAdminOperation({ guildId, actorId, service, action, outcome }) {
  getDb().prepare(`
    INSERT INTO admin_operations_audit (
      guild_id, actor_id, service, action, outcome, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    guildId || null,
    actorId,
    service,
    action,
    outcome,
    new Date().toISOString()
  );
}

const REFRESH_STAGES = new Set(["validation", "rotation", "activation", "verification"]);
const REFRESH_SERVICES = new Set(["instagram", "threads", "facebook", "youtube"]);

function recordCredentialRefreshStage({ guildId, actorId, service, stage, success }) {
  if (!REFRESH_SERVICES.has(service) ||
      !REFRESH_STAGES.has(stage) || typeof success !== "boolean") {
    throw new Error("invalid_refresh_audit_event");
  }
  const result = success ? "success" : "failure";
  const action = `${stage}_${result}`;
  recordAdminOperation({ guildId, actorId, service, action, outcome: action });
  return action;
}

function recordCredentialRefreshEvent({ guildId, actorId, service, action, outcome }) {
  const allowed = new Map([
    ["refresh_requested", new Set(["pending", "unavailable", "rate_limited"])],
    ["request_redeemed", new Set(["success", "failure"])],
    ["activation_required", new Set(["success", "failure"])],
  ]);
  if (!REFRESH_SERVICES.has(service) || !allowed.get(action)?.has(outcome)) throw new Error("invalid_refresh_audit_event");
  recordAdminOperation({ guildId, actorId, service, action, outcome });
  return action;
}

module.exports = { recordAdminOperation, recordCredentialRefreshStage, recordCredentialRefreshEvent };
