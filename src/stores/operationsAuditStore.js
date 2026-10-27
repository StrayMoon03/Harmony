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

module.exports = { recordAdminOperation };
