const { getErrorMonitorSettings, setErrorMonitorEnabled } = require("../stores/errorMonitorStore");

function isErrorMonitorConfigured(env = process.env) {
  return Boolean(String(env.HARMONY_ERROR_GITHUB_TOKEN || "").trim()) &&
    /^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(String(env.HARMONY_ERROR_GITHUB_REPO || "").trim());
}

function enableErrorMonitor() {
  if (!isErrorMonitorConfigured()) return { ok: false, enabled: false, reason: "configuration_unavailable" };
  setErrorMonitorEnabled(true);
  return { ok: true, enabled: true };
}

function disableErrorMonitor() {
  setErrorMonitorEnabled(false);
  return { ok: true, enabled: false };
}

function toggleErrorMonitor() {
  return getErrorMonitorSettings()?.enabled ? disableErrorMonitor() : enableErrorMonitor();
}

module.exports = { isErrorMonitorConfigured, enableErrorMonitor, disableErrorMonitor, toggleErrorMonitor };
