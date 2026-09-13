const { getDb } = require("../db/sqlite");

function getErrorMonitorSettings() {
  return getDb()
    .prepare("SELECT enabled, updated_at FROM error_monitor_settings WHERE id = 1")
    .get() || { enabled: 0, updated_at: null };
}

function setErrorMonitorEnabled(enabled) {
  getDb()
    .prepare(`
      INSERT INTO error_monitor_settings (id, enabled, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `)
    .run(enabled ? 1 : 0, new Date().toISOString());
}

module.exports = { getErrorMonitorSettings, setErrorMonitorEnabled };
