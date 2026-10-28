const crypto = require("node:crypto");
const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { getAdminCapabilities, resolveAdminCapabilities, checkSocial, STATUS } = require("./operationsStatusService");
const auditStore = require("../stores/operationsAuditStore");
const requestStore = require("../stores/credentialRefreshStore");
const refreshConfig = require("./sessionRefreshConfig");

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

function secureRefreshInfrastructureAvailable(service) {
  return refreshConfig.isServiceRefreshAvailable(service);
}

function capabilityFor({ guild, member, userId, resolvedGuildOwnerId }) {
  return getAdminCapabilities({ guild, member, userId, resolvedGuildOwnerId });
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
    const entry = {
      guildId: context.guild.id,
      actorId: context.userId,
      service,
      action: "refresh_requested",
      outcome,
    };
    if (audit.recordCredentialRefreshEvent) audit.recordCredentialRefreshEvent(entry);
    else audit.recordAdminOperation(entry);
  }

  function issue(context, service) {
    if (!SERVICES.has(service)) return { ok: false, reason: "invalid_request" };
    if (!authorized(context)) return { ok: false, reason: "unauthorized" };
    if (!infrastructureAvailable(service)) {
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
    // Retain the one-way token digest required by the PR #236 request schema;
    // the web flow authorizes by UUID + OAuth identity and never exposes it.
    return { ok: true, requestId, service, expiresAt };
  }

  function redeem({ token, guild, member, userId, service, resolvedGuildOwnerId }) {
    if (!SERVICES.has(service)) return { ok: false, reason: "invalid_request" };
    if (!authorized({ guild, member, userId, resolvedGuildOwnerId })) return { ok: false, reason: "unauthorized" };
    if (typeof token !== "string" || token.length < 40 || token.length > 100) return { ok: false, reason: "invalid_request" };
    const result = store.redeemRequest({
      tokenHash: tokenDigest(token),
      guildId: guild?.id,
      actorId: userId,
      service,
      now: clock().toISOString(),
    });
    if (result.ok) {
      const entry = { guildId: guild.id, actorId: userId, service, action: "request_redeemed", outcome: "success" };
      if (audit.recordCredentialRefreshEvent) audit.recordCredentialRefreshEvent(entry);
      else audit.recordAdminOperation(entry);
    }
    return result;
  }

  function redeemRequestId({ requestId, guild, member, userId, service, resolvedGuildOwnerId }) {
    if (!SERVICES.has(service)) return { ok: false, reason: "invalid_request" };
    if (!authorized({ guild, member, userId, resolvedGuildOwnerId })) return { ok: false, reason: "unauthorized" };
    const result = store.redeemRequestById({
      requestId,
      guildId: guild?.id,
      actorId: userId,
      service,
      now: clock().toISOString(),
    });
    if (result.ok) {
      const entry = { guildId: guild.id, actorId: userId, service, action: "request_redeemed", outcome: "success" };
      if (audit.recordCredentialRefreshEvent) audit.recordCredentialRefreshEvent(entry);
      else audit.recordAdminOperation(entry);
    }
    return result;
  }

  function complete({ requestId, guildId, actorId, service }) {
    if (!SERVICES.has(service)) return false;
    return store.completeRequest({ requestId, now: clock().toISOString(), guildId, actorId, service });
  }

  return { issue, redeem, redeemRequestId, complete };
}

const refreshWorkflow = createRefreshWorkflow();

async function handleRefreshInteraction(interaction) {
  if (!interaction.isButton?.()) return false;
  const match = String(interaction.customId || "").match(/^harmony-session-refresh:(instagram|threads|facebook|youtube)$/);
  if (!match) return false;
  const service = match[1];
  const context = { guild: interaction.guild, member: interaction.member, userId: interaction.user?.id };
  const capabilities = interaction.guild && context.userId
    ? await resolveAdminCapabilities(context)
    : getAdminCapabilities(context);
  const authorizedContext = { ...context, resolvedGuildOwnerId: capabilities.resolvedGuildOwnerId };
  const available = Boolean(capabilities.canManageCredentials && secureRefreshInfrastructureAvailable(service));
  const sessionStatus = available ? await checkSocial(service) : null;
  const hasExpiry = sessionStatus?.status === STATUS.attention;
  const result = !context.guild || !context.userId
    ? { ok: false, reason: "unauthorized" }
    : !capabilities.canManageCredentials
      ? { ok: false, reason: "unauthorized" }
      : !available
        ? { ok: false, reason: "secure_refresh_unavailable" }
        : !hasExpiry
          ? { ok: false, reason: "invalid_request" }
          : refreshWorkflow.issue(authorizedContext, service);
  const payload = {
    content: result.ok
      ? `A short-lived secure refresh request is ready for ${service}. Open the protected page, sign in to Discord, and submit the new cookie export there.`
      : formatRefreshOutcome(result),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
  if (result.ok) {
    const base = refreshConfig.publicBaseUrl();
    if (!base) payload.content = SAFE_RESULT_MESSAGES.secure_refresh_unavailable;
    else payload.components = [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Open Secure Refresh Page")
        .setStyle(ButtonStyle.Link)
        .setURL(new URL(`/session-refresh/${encodeURIComponent(result.requestId)}`, base).toString())
    )];
  }
  return interaction.reply(payload).then(() => true);
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
  refreshWorkflow,
  secureRefreshInfrastructureAvailable,
  formatRefreshOutcome,
  handleRefreshInteraction,
  recordRefreshStage,
};
