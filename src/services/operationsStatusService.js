const fs = require("node:fs/promises");
const path = require("node:path");
const { PermissionFlagsBits, Events } = require("discord.js");
const { getDb } = require("../db/sqlite");
const socialHealthStore = require("../stores/socialHealthStore");
const eventStore = require("../stores/eventSchedulerStore");
const guardStore = require("../stores/communityGuardStore");
const guardService = require("./communityGuardService");
const auditStore = require("../stores/operationsAuditStore");
const { validateSessionCookie } = require("./sessionCookieValidator");
const { classifyAuthenticatedProviderFailure } = require("./socialAuthEvidence");

const STATUS = Object.freeze({
  healthy: "healthy",
  attention: "attention",
  owner: "owner_required",
  unknown: "unknown",
});
const SOCIAL = Object.freeze({
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  threads: "Threads",
  tiktok: "TikTok",
  x: "X",
});
const COOKIE_SERVICES = new Set(["instagram", "threads", "facebook", "youtube"]);
const SOCIAL_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const SOCIAL_VERIFY_COOLDOWN_MS = 5 * 60 * 1000;

function isExplicitAuthenticationFailure(error) {
  return ["session", "owner"].includes(error?.socialAuthFailureKind);
}

function authenticationFailureKind(error) {
  return error?.socialAuthFailureKind === "owner" ? "owner" : "session";
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

function isCookieRefreshRequired(row) {
  return /^social-(instagram|threads|facebook|youtube)$/.test(row?.id || "") &&
    [STATUS.attention, STATUS.owner].includes(row.status) &&
    /(?:cookies need to be refreshed|session refresh required)/i.test(row?.action || "");
}

function isAccountVerificationRequired(row) {
  return /^social-(instagram|threads|facebook|youtube)$/.test(row?.id || "") &&
    row.status === STATUS.owner &&
    /checkpoint|challenge|account verification|security verification/i.test(`${row.explanation || ""} ${row.action || ""}`);
}

function readGuildOwnerId(guild) {
  const candidates = [guild?.ownerId, guild?.ownerID, guild?.owner_id, guild?.owner?.id];
  return candidates.find((id) => typeof id === "string" && id.length > 0) || null;
}

function getAdminCapabilities({ guild, member, userId, resolvedGuildOwnerId, credentialManagerRoleIds = parseConfiguredRoleIds() } = {}) {
  const guildOwnerId = resolvedGuildOwnerId || readGuildOwnerId(guild);
  const owner = Boolean(guildOwnerId && userId && guildOwnerId === userId);
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
    canViewOwnerDiagnostics: owner,
    isGuildOwner: owner,
    // Secure cookie refresh is an Admin Controls operation. Server admins who
    // can administer Harmony may use it; owner diagnostics remain owner-only.
    canManageCredentials: diagnose,
    credentialManagementAvailable: false,
    credentialManagerRoleConfigured: hasCredentialRole,
  };
}

async function resolveAdminCapabilities(context = {}) {
  let resolvedGuildOwnerId = readGuildOwnerId(context.guild);
  if (!resolvedGuildOwnerId && typeof context.guild?.fetch === "function") {
    const fetchedGuild = await context.guild.fetch().catch(() => null);
    resolvedGuildOwnerId = readGuildOwnerId(fetchedGuild) || readGuildOwnerId(context.guild);
  }
  return {
    ...getAdminCapabilities({ ...context, resolvedGuildOwnerId }),
    resolvedGuildOwnerId,
  };
}

function recordSocialAuthFailure(platform, at = new Date().toISOString(), kind = "session", diagnosticCategory = "provider_auth_failure") {
  const key = String(platform || "").toLowerCase();
  if (!SOCIAL[key]) return;
  try {
    socialHealthStore.recordFailure(key, kind === "owner" ? "owner" : "session", at, diagnosticCategory);
  } catch {
    // A health-signal write must not break the media failure/reporting path.
  }
}

function recordSocialSuccess(platform, at = new Date().toISOString(), evidence = {}) {
  const key = String(platform || "").toLowerCase();
  if (!SOCIAL[key]) return;
  // Anonymous retrieval says nothing about the health of an authenticated
  // cookie session. Cookie-managed services need authenticated evidence.
  if (COOKIE_SERVICES.has(key) && evidence?.authenticated !== true) return;
  try {
    socialHealthStore.recordSuccess(key, at, COOKIE_SERVICES.has(key) ? "authenticated_media" : "media");
  } catch {
    // A health-signal write must not turn a successful media request into a failure.
  }
}

function recordSocialMaintenanceSuccess(platform, at = new Date().toISOString()) {
  const key = String(platform || "").toLowerCase();
  if (!SOCIAL[key]) return;
  // Called only after a submitted session passed pre-rotation validation and
  // post-activation verification. Ordinary media success keeps checkpoint state.
  try {
    socialHealthStore.recordVerifiedSuccess(key, at, "refresh");
  } catch {
    // A health-signal write must not turn a verified refresh into a failure.
  }
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
  if (!name) return statusRow(`social-${platform}`, String(platform), STATUS.unknown, "This platform is not supported.");
  const health = socialHealthStore.get(platform);
  if (health?.state === "failure" && health.failure_kind === "owner") {
    const identityIssue = ["identity_mismatch", "identity_unverified"].includes(health.diagnostic_category);
    return statusRow(
      `social-${platform}`,
      name,
      STATUS.owner,
      identityIssue
        ? "The authenticated account identity could not be confirmed. Owner attention is required."
        : "The platform returned a security checkpoint or verification page. Harmony cannot complete that account check.",
      identityIssue
        ? "Confirm the configured account identity with the owner before continuing."
        : "Owner attention required; resolve the account check with the platform.",
      health.updated_at
    );
  }
  const confirmedSessionFailure = health?.state === "failure" && health.failure_kind === "session" &&
    ["login_required", "session_invalid", "missing_required_cookies", "provider_auth_failure"].includes(health.diagnostic_category);
  if (confirmedSessionFailure && COOKIE_SERVICES.has(platform)) return statusRow(
    `social-${platform}`,
    name,
    STATUS.attention,
    `${name} cookies need to be refreshed. An authenticated check confirmed that sign-in is required.`,
    `${name} cookies need to be refreshed.`,
    health.updated_at
  );
  if (confirmedSessionFailure) return statusRow(
    `social-${platform}`,
    name,
    STATUS.attention,
    "A media request reported an authentication problem.",
    "Try the platform again; if the problem continues, ask the owner.",
    health.updated_at
  );
  const acceptableCookieSuccess = !COOKIE_SERVICES.has(platform) ||
    ["authenticated_media", "verification", "refresh"].includes(health?.success_kind);
  const successAt = acceptableCookieSuccess ? health?.last_success_at : null;
  const successAge = successAt ? Date.now() - new Date(successAt).getTime() : Infinity;
  if (Number.isFinite(successAge) && successAge >= 0 && successAge <= SOCIAL_SUCCESS_TTL_MS) {
    return statusRow(
      `social-${platform}`,
      name,
      STATUS.healthy,
      health?.success_kind === "verification" || health?.success_kind === "refresh"
        ? "The authenticated session was explicitly verified recently."
        : "A recent authenticated request succeeded.",
      "No action needed.",
      health?.last_verified_at || successAt
    );
  }
  const configured = COOKIE_SERVICES.has(platform) ? await sessionConfigured(platform) : false;
  return statusRow(
    `social-${platform}`,
    name,
    STATUS.unknown,
    configured
      ? "The authenticated session has not been recently verified."
      : "No saved authenticated session is configured. Public media may still work.",
    configured ? `Use Verify ${name} to check the saved session.` : "No action unless authenticated content is needed.",
    socialHealthStore.getVerificationAttempt(platform)?.last_attempt_at || undefined
  );
}

function verificationRow(platform, state, explanation, action, at) {
  return { platform, state, explanation, action, checkedAt: at || null };
}

async function verifySocialSession(platform, options = {}) {
  const key = String(platform || "").toLowerCase();
  const name = SOCIAL[key];
  if (!name || !COOKIE_SERVICES.has(key)) return verificationRow(key, "unknown", "This service cannot be verified here.", "No action available.");
  const clock = options.clock || (() => new Date());
  const timestamp = new Date(clock()).toISOString();
  const filePath = sessionPath(key);
  if (!filePath || !(await (options.isConfigured || sessionConfigured)(key))) {
    return verificationRow(key, "not_configured", `${name} has no saved session to verify.`, "Ask an administrator to configure the secure session.");
  }
  const priorAttempt = socialHealthStore.getVerificationAttempt(key);
  if (priorAttempt && Date.parse(timestamp) - Date.parse(priorAttempt.last_attempt_at) < SOCIAL_VERIFY_COOLDOWN_MS) {
    return verificationRow(key, "rate_limited", `${name} was checked recently.`, "Wait a few minutes before verifying again.", priorAttempt.last_attempt_at);
  }

  // Persist the start before the network call to bound simultaneous clicks and
  // avoid repeatedly contacting provider auth pages.
  socialHealthStore.recordVerificationAttempt(key, timestamp, "unknown");
  let contents = null;
  let validation = { status: "INCONCLUSIVE" };
  try {
    contents = await (options.readFile || fs.readFile)(filePath, "utf8");
    validation = await (options.validator || validateSessionCookie)(key, contents);
  } catch {
    validation = { status: "INCONCLUSIVE" };
  } finally {
    contents = null;
  }

  const result = String(validation?.status || "INCONCLUSIVE");
  let outcome = "unknown";
  let response;
  if (result === "AUTHENTICATED") {
    socialHealthStore.recordVerifiedSuccess(key, timestamp, "verification");
    outcome = "verified";
    response = verificationRow(key, "verified", `${name} authenticated session is working.`, "No action needed.", timestamp);
  } else if (["UNAUTHENTICATED", "MISSING_REQUIRED_COOKIES"].includes(result)) {
    const category = result === "MISSING_REQUIRED_COOKIES" ? "missing_required_cookies" : "login_required";
    recordSocialAuthFailure(key, timestamp, "session", category);
    outcome = "session";
    response = verificationRow(key, "session", `${name} session needs refresh.`, "Use the secure cookie refresh action.", timestamp);
  } else if (["OWNER_REQUIRED", "IDENTITY_MISMATCH", "IDENTITY_UNVERIFIABLE"].includes(result)) {
    const category = result === "IDENTITY_MISMATCH" ? "identity_mismatch"
      : result === "IDENTITY_UNVERIFIABLE" ? "identity_unverified"
        : /challenge|checkpoint/i.test(String(validation?.category || "")) ? "challenge" : "checkpoint";
    recordSocialAuthFailure(key, timestamp, "owner", category);
    outcome = "owner";
    response = verificationRow(key, "owner", `${name} requires owner attention.`, "Resolve the platform account check before retrying.", timestamp);
  } else {
    response = verificationRow(key, "unknown", `${name} session could not be verified right now.`, "Try again later; no session problem was inferred.", timestamp);
  }
  socialHealthStore.recordVerificationAttempt(key, timestamp, outcome);
  return response;
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
  if (!config?.enabled) return statusRow("discovery", "Event discovery", STATUS.unknown,
    "Automatic Stray Kids schedule checks are off for this server.", "No action needed.", state?.last_run_at || undefined);
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
  if (!settings.enabled) return statusRow("guard", "Community Guard", STATUS.unknown,
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
  COOKIE_SERVICES,
  isCookieRefreshRequired,
  isAccountVerificationRequired,
  SOCIAL_SUCCESS_TTL_MS,
  SOCIAL_VERIFY_COOLDOWN_MS,
  getAdminCapabilities,
  resolveAdminCapabilities,
  parseConfiguredRoleIds,
  recordSocialAuthFailure,
  recordSocialSuccess,
  recordSocialMaintenanceSuccess,
  verifySocialSession,
  classifyAuthenticatedProviderFailure,
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
