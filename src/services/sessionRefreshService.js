const crypto = require("node:crypto");
const { MessageFlags } = require("discord.js");
const { getAdminCapabilities } = require("./operationsStatusService");
const auditStore = require("../stores/operationsAuditStore");
const requestStore = require("../stores/credentialRefreshStore");

const REQUEST_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 3;
const SERVICES = requestStore.SERVICES;
const SAFE_RESULT_MESSAGES = Object.freeze({
  unauthorized: "Only the owner or a configured Credential Manager can request a session refresh.",
  secure_refresh_unavailable: "Secure session refresh is not yet available. No credentials were changed.",
  rate_limited: "Too many refresh requests were made recently. Try again later.",
  invalid_request: "This refresh request is invalid or has expired.",
  scope_mismatch: "This refresh request does not match the signed-in admin or selected service.",
  already_used: "This refresh request has already been used.",
  expired: "This refresh request has expired. Start a new request.",
});

function secureRefreshInfrastructureAvailable() {
  // No secret-entry backend or narrowly scoped secret rotation API exists yet.
  return false;
}

function capabilityFor({ guild, member, userId }) {
  return getAdminCapabilities({ guild, member, userId });
}

function tokenDigest(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function formatRefreshOutcome({ ok, reason }) {
  if (ok) return "The secure refresh request was accepted.";
  return SAFE_RESULT_MESSAGES[reason] || "The secure session refresh could not be completed.";
}

function createRefreshWorkflow({
  infrastructureAvailable = secureRefreshInfrastructureAvailable,
  clock = () => new Date(),
  tokenGenerator = () => crypto.randomBytes(32).toString("base64url"),
  requestIdGenerator = () => crypto.randomUUID(),
  capabilities = capabilityFor,
  audit = auditStore,
  store = requestStore,
} = {}) {
  function authorized(context) {
    return capabilities(context).canManageCredentials;
  }

  function recordRequestOutcome(context, service, outcome) {
    audit.recordAdminOperation({
      guildId: context.guild.id,
      actorId: context.userId,
      service,
      action: "refresh_requested",
      outcome,
    });
  }

  function issue(context, service) {
    if (!SERVICES.has(service)) return { ok: false, reason: "invalid_request" };
    if (!authorized(context)) return { ok: false, reason: "unauthorized" };
    if (!infrastructureAvailable()) {
      recordRequestOutcome(context, service, "unavailable");
      return { ok: false, reason: "secure_refresh_unavailable" };
    }

    const now = clock();
    const createdAt = now.toISOString();
    const recentSince = new Date(now.getTime() - RATE_WINDOW_MS).toISOString();
    store.expirePending(createdAt);
    if (store.countRecentRequests({ guildId: context.guild.id, actorId: context.userId, since: recentSince }) >= MAX_REQUESTS_PER_HOUR) {
      recordRequestOutcome(context, service, "rate_limited");
      return { ok: false, reason: "rate_limited" };
    }

    const token = tokenGenerator();
    const requestId = requestIdGenerator();
    const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS).toISOString();
    store.createRequest({
      requestId,
      tokenHash: tokenDigest(token),
      guildId: context.guild.id,
      actorId: context.userId,
      service,
      createdAt,
      expiresAt,
    });
    recordRequestOutcome(context, service, "pending");
    // The bearer token is returned only to an internal caller. The Discord
    // handler below never creates or returns a token to an interaction.
    return { ok: true, requestId, token, service, expiresAt };
  }

  function redeem({ token, guild, member, userId, service }) {
    if (!SERVICES.has(service)) return { ok: false, reason: "invalid_request" };
    if (!authorized({ guild, member, userId })) return { ok: false, reason: "unauthorized" };
    if (typeof token !== "string" || token.length < 40 || token.length > 100) return { ok: false, reason: "invalid_request" };
    const result = store.redeemRequest({
      tokenHash: tokenDigest(token),
      guildId: guild?.id,
      actorId: userId,
      service,
      now: clock().toISOString(),
    });
    if (result.ok) {
      audit.recordAdminOperation({ guildId: guild.id, actorId: userId, service, action: "refresh_request_redeemed", outcome: "success" });
    }
    return result;
  }

  function complete({ requestId, guildId, actorId, service }) {
    if (!SERVICES.has(service)) return false;
    return store.completeRequest({ requestId, now: clock().toISOString(), guildId, actorId, service });
  }

  return { issue, redeem, complete };
}

const refreshWorkflow = createRefreshWorkflow();

function handleRefreshInteraction(interaction) {
  if (!interaction.isButton?.()) return false;
  const match = String(interaction.customId || "").match(/^harmony-session-refresh:(instagram|threads|facebook|youtube)$/);
  if (!match) return false;
  const service = match[1];
  const context = { guild: interaction.guild, member: interaction.member, userId: interaction.user?.id };
  const result = interaction.guild && context.userId
    ? refreshWorkflow.issue(context, service)
    : { ok: false, reason: "unauthorized" };
  return interaction.reply({
    content: formatRefreshOutcome(result),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  }).then(() => true);
}

function recordRefreshStage({ guildId, actorId, service, stage, success }) {
  if (!SERVICES.has(service)) throw new Error("invalid_refresh_service");
  return auditStore.recordCredentialRefreshStage({ guildId, actorId, service, stage, success });
}

module.exports = {
  REQUEST_TTL_MS,
  RATE_WINDOW_MS,
  MAX_REQUESTS_PER_HOUR,
  SERVICES,
  createRefreshWorkflow,
  secureRefreshInfrastructureAvailable,
  formatRefreshOutcome,
  handleRefreshInteraction,
  recordRefreshStage,
};
