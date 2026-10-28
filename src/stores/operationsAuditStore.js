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

const REFRESH_STAGES = new Set(["validation", "rotation"]);

function recordCredentialRefreshStage({ guildId, actorId, service, stage, success }) {
  if (!new Set(["instagram", "threads", "facebook", "youtube"]).has(service) ||
      !REFRESH_STAGES.has(stage) || typeof success !== "boolean") {
    throw new Error("invalid_refresh_audit_event");
  }
  const result = success ? "success" : "failure";
  const action = `${stage}_${result}`;
  recordAdminOperation({ guildId, actorId, service, action, outcome: action });
  return action;
}

module.exports = { recordAdminOperation, recordCredentialRefreshStage };
