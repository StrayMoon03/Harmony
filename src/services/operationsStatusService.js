const fs = require("node:fs/promises");
const path = require("node:path");
const { PermissionFlagsBits, Events } = require("discord.js");
const { getDb } = require("../db/sqlite");
const eventStore = require("../stores/eventSchedulerStore");
const guardStore = require("../stores/communityGuardStore");
const guardService = require("./communityGuardService");
const auditStore = require("../stores/operationsAuditStore");

const STATUS = Object.freeze({
  healthy: "healthy",
  attention: "attention",
  owner: "owner_required",
  unknown: "unknown",
});
const SOCIAL = Object.freeze({ instagram: "Instagram", threads: "Threads", facebook: "Facebook", youtube: "YouTube" });
const authFailures = new Map();

function isExplicitAuthenticationFailure(error) {
  const text = [error?.message, error?.stderr, typeof error === "string" ? error : ""]
    .filter(Boolean).join(" ").toLowerCase();
  return /(?:auth_required|authentication required|session (?:has )?expired|sign[ -]?in (?:is )?required|login (?:is )?required|opened a login|login page|checkpoint (?:page|required|blocked)|\/checkpoint\/|\/challenge\/)/i.test(text);
}

function authenticationFailureKind(error) {
  const text = [error?.message, error?.stderr, typeof error === "string" ? error : ""]
    .filter(Boolean).join(" ").toLowerCase();
  return /checkpoint|challenge|security verification|suspicious login/.test(text) ? "owner" : "session";
}

function statusRow(id, name, status, explanation, action = "No action available.", lastChecked = new Date().toISOString()) {
  return { id, name, status, explanation, action, lastChecked };
}

function safeCheck(id, name, check) {
  return Promise.resolve().then(check).catch(() => statusRow(
    id,
    name,
    STATUS.owner,
    "Harmony could not verify this system.",
    "Owner/Developer attention required."
  ));
}

function parseConfiguredRoleIds(value = process.env.HARMONY_CREDENTIAL_MANAGER_ROLE_IDS || "") {
  return new Set(String(value).split(/[\s,]+/).filter((id) => /^\d{15,22}$/.test(id)));
}

function getAdminCapabilities({ guild, member, userId, credentialManagerRoleIds = parseConfiguredRoleIds() } = {}) {
  const owner = Boolean(guild?.ownerId && userId && guild.ownerId === userId);
  const permissions = member?.permissions || member?.permissionsIn?.(member?.guild?.channels?.cache?.first?.());
  const hasAdminPermission = Boolean(
    permissions?.has?.(PermissionFlagsBits.Administrator) ||
    permissions?.has?.(PermissionFlagsBits.ManageGuild)
  );
  const roleCache = member?.roles?.cache;
  const hasCredentialRole = Boolean(roleCache?.some?.((role) => credentialManagerRoleIds.has(role.id)));
  const diagnose = owner || hasAdminPermission;
  return {
    canDiagnose: diagnose,
    canViewFullStatus: diagnose,
    canManageCredentials: owner || (diagnose && hasCredentialRole),
    credentialManagementAvailable: false,
    credentialManagerRoleConfigured: hasCredentialRole,
  };
}

function recordSocialAuthFailure(platform, at = new Date().toISOString(), kind = "session") {
  const key = String(platform || "").toLowerCase();
  if (SOCIAL[key]) authFailures.set(key, { at, kind: kind === "owner" ? "owner" : "session" });
}

function recordSocialSuccess(platform) {
  authFailures.delete(String(platform || "").toLowerCase());
}

function sessionPath(platform) {
  const envKey = {
    instagram: "INSTAGRAM_COOKIES",
    threads: "THREADS_COOKIES",
    facebook: "FACEBOOK_COOKIES",
    youtube: "YOUTUBE_COOKIES",
  }[platform];
  const configured = process.env[envKey];
  if (configured) return configured;
  if (platform === "instagram") return path.resolve(__dirname, "../../instagram-cookies.txt");
  if (platform === "facebook") return path.resolve(__dirname, "../../facebook-cookies.txt");
  return null;
}

async function sessionConfigured(platform) {
  const filePath = sessionPath(platform);
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function checkSocial(platform) {
  const name = SOCIAL[platform];
  const authFailure = authFailures.get(platform);
  if (authFailure?.kind === "owner") return statusRow(
    `social-${platform}`,
    name,
    STATUS.owner,
    "The platform returned a security checkpoint or verification page. Harmony cannot complete that account check.",
    "Owner attention required; resolve the account check with the platform.",
    authFailure.at
  );
  if (authFailure) return statusRow(
    `social-${platform}`,
    name,
    STATUS.attention,
    "A recent media request explicitly indicated that sign-in or refreshed session access is required.",
    "Session refresh required; ask the owner or trusted Credential Manager.",
    authFailure.at
  );
  const configured = await sessionConfigured(platform);
  return statusRow(
    `social-${platform}`,
    name,
    STATUS.unknown,
    configured
      ? "A session file is present, but Harmony cannot confirm that the platform still accepts it without a media request."
      : "No saved session is configured. Public media may still work; some content may require sign-in.",
    configured ? "No action unless a media request reports a sign-in problem." : "Owner/Developer attention only if authenticated content is needed."
  );
}

function shortDate(value) {
  if (!value) return "No successful check recorded.";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "A previous check is recorded." : date.toISOString();
}

async function checkDiscovery(guildId) {
  if (!guildId) return statusRow("discovery", "Event discovery", STATUS.unknown, "A server context is needed to check discovery settings.");
  const config = eventStore.getCalendarDiscoveryConfig(guildId);
  const state = eventStore.getCalendarDiscoveryState(guildId, "jype-straykids-schedule");
  if (!config?.enabled) return statusRow("discovery", "Event discovery", STATUS.attention,
    "Automatic Stray Kids schedule checks are off for this server.", "Turn discovery on in the Stray Kids Schedule Manager.", state?.last_run_at || undefined);
  if (state?.last_error) return statusRow("discovery", "Event discovery", STATUS.attention,
    "The latest scheduled source check did not complete successfully.", "Try Check Now in the Stray Kids Schedule Manager; if it keeps failing, ask the owner.", state.last_run_at || undefined);
  if (!state?.last_success_at) return statusRow("discovery", "Event discovery", STATUS.unknown,
    "No successful source check is recorded yet.", "Use Check Now in the Stray Kids Schedule Manager.", state?.last_run_at || undefined);
  const age = Date.now() - new Date(state.last_success_at).getTime();
  if (!Number.isFinite(age) || age > 26 * 60 * 60 * 1000) return statusRow("discovery", "Event discovery", STATUS.attention,
    "The last successful check is older than expected.", "Use Check Now; contact the owner if a fresh check fails.", state.last_success_at);
  return statusRow("discovery", "Event discovery", STATUS.healthy,
    "Automatic checks are on and the latest source check succeeded.", "No action needed.", state.last_success_at);
}

async function checkGuard(guild) {
  const settings = guardStore.getSettings(guild.id);
  const rules = guardStore.listRules(guild.id);
  if (!settings) return statusRow("guard", "Community Guard", STATUS.unknown,
    `Guard has not been configured here. Active rules: ${rules.length}.`, "Use /harmony-guard setup to choose a Review Room.");
  const channel = guild.channels.cache.get(settings.channel_id) || await guild.channels.fetch(settings.channel_id).catch(() => null);
  const roomConfigured = Boolean(channel?.isTextBased?.());
  const visibility = roomConfigured ? guardService.reviewRoomVisibilityWarning(channel) : "";
  const visibleToMembers = /appears able to view/i.test(visibility);
  const unverifiable = /could not be verified/i.test(visibility);
  const visibilitySummary = visibleToMembers
    ? "Ordinary members appear able to view the Review Room."
    : unverifiable
      ? "Review Room visibility could not be verified."
      : roomConfigured
        ? "The permission check found no ordinary-member access, but review channel permissions should be confirmed."
        : "";
  if (!settings.enabled) return statusRow("guard", "Community Guard", STATUS.attention,
    `Monitoring is off. Review Room: ${roomConfigured ? "configured" : "missing or unavailable"}. Active rules: ${rules.length}.${visibilitySummary ? ` ${visibilitySummary}` : ""}`, "Turn monitoring on with /harmony-guard setup.");
  if (!roomConfigured) return statusRow("guard", "Community Guard", STATUS.attention,
    `Monitoring is on, but the configured Review Room is unavailable. Active rules: ${rules.length}.`, "Use /harmony-guard setup to select an available room.");
  const status = visibleToMembers || unverifiable ? STATUS.attention : STATUS.healthy;
  return statusRow("guard", "Community Guard", status,
    `Monitoring is on. Review Room is configured. Active rules: ${rules.length}. ${visibilitySummary}`,
    status === STATUS.healthy ? "No action needed." : "Review the room’s channel permissions and Guard settings.");
}

async function checkSync(client) {
  const required = [Events.GuildScheduledEventCreate, Events.GuildScheduledEventUpdate, Events.GuildScheduledEventDelete];
  const attached = required.filter((eventName) => client.listenerCount(eventName) > 0);
  if (attached.length !== required.length) return statusRow("event-sync", "Discord/event synchronization", STATUS.owner,
    "One or more scheduled-event listeners are not attached.", "Owner/Developer attention required.");
  return statusRow("event-sync", "Discord/event synchronization", STATUS.unknown,
    "All scheduled-event listeners are attached. Harmony does not currently track the last successful sync for each event, so end-to-end sync cannot be confirmed here.",
    "Use Calendar reconciliation controls if an event appears out of sync.");
}

async function collectStatus({ client, guild }) {
  const checks = [
    safeCheck("discord", "Harmony / Discord connection", () => {
      const ready = Boolean(client?.isReady?.() && client?.user);
      if (!ready) return statusRow("discord", "Harmony / Discord connection", STATUS.owner,
        "Harmony is not currently reporting a ready Discord connection.", "Owner/Developer attention required.");
      const ping = Number(client.ws?.ping);
      const explanation = Number.isFinite(ping) && ping >= 0
        ? `Harmony is connected to Discord. Response time: ${Math.round(ping)} ms.`
        : "Harmony is connected to Discord.";
      return statusRow("discord", "Harmony / Discord connection", STATUS.healthy, explanation, "No action needed.");
    }),
    safeCheck("database", "Database", () => {
      getDb().prepare("SELECT 1 AS ok").get();
      return statusRow("database", "Database", STATUS.healthy, "Harmony can read from its database.", "No action needed.");
    }),
    safeCheck("discovery", "Event discovery", () => checkDiscovery(guild?.id)),
    safeCheck("event-sync", "Discord/event synchronization", () => checkSync(client)),
    ...Object.keys(SOCIAL).map((platform) => safeCheck(`social-${platform}`, SOCIAL[platform], () => checkSocial(platform))),
    safeCheck("guard", "Community Guard", () => guild ? checkGuard(guild) : statusRow("guard", "Community Guard", STATUS.unknown, "A server context is needed to check Guard settings.")),
  ];
  return Promise.all(checks);
}

function overallOutcome(rows) {
  return rows.some((row) => row.status === STATUS.owner) ? "attention" :
    rows.some((row) => row.status === STATUS.attention) ? "attention" :
      rows.some((row) => row.status === STATUS.unknown) ? "partial" : "success";
}

async function runStatusCheck({ client, guild, actorId }) {
  const rows = await collectStatus({ client, guild });
  try {
    auditStore.recordAdminOperation({ guildId: guild?.id, actorId, service: "harmony", action: "status_check", outcome: overallOutcome(rows) });
  } catch {
    // Audit failure must not prevent a health report.
  }
  return { rows, checkedAt: new Date().toISOString(), outcome: overallOutcome(rows) };
}

module.exports = {
  STATUS,
  SOCIAL,
  getAdminCapabilities,
  parseConfiguredRoleIds,
  recordSocialAuthFailure,
  recordSocialSuccess,
  isExplicitAuthenticationFailure,
  authenticationFailureKind,
  sessionConfigured,
  checkSocial,
  checkDiscovery,
  checkGuard,
  checkSync,
  collectStatus,
  runStatusCheck,
};
