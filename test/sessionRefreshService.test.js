const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-session-refresh-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "refresh.sqlite");

const { PermissionFlagsBits } = require("discord.js");
const { getDb, closeDb } = require("../src/db/sqlite");
const { getAdminCapabilities, STATUS } = require("../src/services/operationsStatusService");
const refreshService = require("../src/services/sessionRefreshService");
const statusCommand = require("../src/commands/status");

function guild(id = "guild-refresh") {
  return { id, ownerId: "owner-1" };
}

function adminMember(roleIds = [], isAdmin = true) {
  return {
    permissions: { has: (permission) => isAdmin && permission === PermissionFlagsBits.Administrator },
    roles: { cache: roleIds.map((id) => ({ id })) },
  };
}

function context({ userId = "owner-1", guildId = "guild-refresh", roles = [], admin = true } = {}) {
  return { guild: guild(guildId), userId, member: adminMember(roles, admin) };
}

function workflow({ now = "2026-10-27T12:00:00.000Z", infrastructureAvailable = true, capabilities } = {}) {
  let tokenNumber = 0;
  let requestNumber = 0;
  const audit = {
    rows: [],
    recordAdminOperation(entry) { this.rows.push({ ...entry, created_at: new Date(now).toISOString() }); },
    recordCredentialRefreshStage(entry) {
      const action = `${entry.stage}_${entry.success ? "success" : "failure"}`;
      this.recordAdminOperation({ guildId: entry.guildId, actorId: entry.actorId, service: entry.service, action, outcome: action });
      return action;
    },
  };
  return {
    audit,
    service: refreshService.createRefreshWorkflow({
      infrastructureAvailable: () => infrastructureAvailable,
      clock: () => new Date(now),
      tokenGenerator: () => `test-only-unusable-token-${crypto.randomUUID()}-${++tokenNumber}`,
      requestIdGenerator: () => `request-${crypto.randomUUID()}-${++requestNumber}`,
      capabilities,
      audit,
    }),
  };
}

test("owner and configured Credential Manager can request; regular admin cannot", () => {
  const managerRoleIds = new Set(["credential-manager"]);
  const ownerCaps = getAdminCapabilities({ guild: guild(), userId: "owner-1", member: adminMember(), credentialManagerRoleIds: managerRoleIds });
  const trustedCaps = getAdminCapabilities({ guild: guild(), userId: "manager-1", member: adminMember(["credential-manager"]), credentialManagerRoleIds: managerRoleIds });
  const regularCaps = getAdminCapabilities({ guild: guild(), userId: "admin-1", member: adminMember(), credentialManagerRoleIds: managerRoleIds });
  assert.equal(ownerCaps.canManageCredentials, true);
  assert.equal(trustedCaps.canManageCredentials, true);
  assert.equal(regularCaps.canDiagnose, true);
  assert.equal(regularCaps.canManageCredentials, false);

  const testFlow = workflow({ capabilities: (candidate) => getAdminCapabilities({ ...candidate, credentialManagerRoleIds: managerRoleIds }) });
  assert.equal(testFlow.service.issue(context(), "instagram").ok, true);
  assert.equal(testFlow.service.issue(context({ userId: "manager-1", roles: ["credential-manager"] }), "threads").ok, true);
  assert.equal(testFlow.service.issue(context({ userId: "admin-1" }), "facebook").reason, "unauthorized");
});

test("credential manager role is honored by the shared capability model", () => {
  const manager = context({ userId: "manager-2", roles: ["credential-manager"] });
  assert.equal(getAdminCapabilities({ ...manager, credentialManagerRoleIds: new Set(["credential-manager"]) }).canManageCredentials, true);
});

test("production refresh remains unavailable and does not issue or persist a token", () => {
  getDb();
  const cookiePath = path.join(tempDir, "active-session.txt");
  const original = "existing-session-placeholder-do-not-change";
  fs.writeFileSync(cookiePath, original);
  const initialCount = getDb().prepare("SELECT COUNT(*) AS n FROM credential_refresh_requests").get().n;
  const testFlow = workflow({ infrastructureAvailable: false });
  const result = testFlow.service.issue(context(), "instagram");
  assert.deepEqual(result, { ok: false, reason: "secure_refresh_unavailable" });
  assert.equal(fs.readFileSync(cookiePath, "utf8"), original);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM credential_refresh_requests").get().n, initialCount);
  assert.equal(refreshService.secureRefreshInfrastructureAvailable(), false);
  assert.match(refreshService.formatRefreshOutcome(result), /not yet available/i);
});

test("request is service/guild/actor scoped, expires, and can only be consumed once", () => {
  getDb();
  const testFlow = workflow({ capabilities: () => ({ canManageCredentials: true }) });
  const issued = testFlow.service.issue(context(), "instagram");
  assert.equal(issued.ok, true);
  assert.equal(issued.service, "instagram");
  assert.equal(testFlow.service.redeem({ ...context({ guildId: "other-guild" }), service: "instagram", token: issued.token }).reason, "scope_mismatch");
  assert.equal(testFlow.service.redeem({ ...context(), service: "threads", token: issued.token }).reason, "scope_mismatch");
  assert.equal(testFlow.service.redeem({ ...context({ userId: "someone-else" }), service: "instagram", token: issued.token }).reason, "scope_mismatch");
  const redeemed = testFlow.service.redeem({ ...context(), service: "instagram", token: issued.token });
  assert.equal(redeemed.ok, true);
  assert.equal(testFlow.service.redeem({ ...context(), service: "instagram", token: issued.token }).reason, "already_used");
  assert.equal(testFlow.service.complete({ requestId: redeemed.requestId, guildId: "other-guild", actorId: "owner-1", service: "instagram" }), false);
  assert.equal(testFlow.service.complete({ requestId: redeemed.requestId, guildId: "guild-refresh", actorId: "owner-1", service: "instagram" }), true);

  const expiredFlow = workflow({ now: "2026-10-27T12:00:00.000Z", capabilities: () => ({ canManageCredentials: true }) });
  const expiredRequest = expiredFlow.service.issue(context({ guildId: "guild-expired" }), "youtube");
  const later = refreshService.createRefreshWorkflow({
    clock: () => new Date("2026-10-27T12:11:00.000Z"),
    infrastructureAvailable: () => true,
    capabilities: () => ({ canManageCredentials: true }),
  });
  assert.equal(later.redeem({ ...context({ guildId: "guild-expired" }), service: "youtube", token: expiredRequest.token }).reason, "expired");
});

test("refresh requests are rate limited and audit records contain only safe metadata", () => {
  getDb();
  const testFlow = workflow();
  const rateContext = context({ guildId: "guild-rate-limit" });
  for (let i = 0; i < refreshService.MAX_REQUESTS_PER_HOUR; i++) assert.equal(testFlow.service.issue(rateContext, "facebook").ok, true);
  assert.equal(testFlow.service.issue(rateContext, "facebook").reason, "rate_limited");
  const dbRequest = getDb().prepare("SELECT * FROM credential_refresh_requests LIMIT 1").get();
  assert.equal(dbRequest.token_hash.length, 64);
  assert.equal(JSON.stringify(dbRequest).includes("test-only-unusable-token"), false);
  assert.equal(JSON.stringify(testFlow.audit.rows).includes("test-only-unusable-token"), false);
  assert.ok(testFlow.audit.rows.every((row) => Object.keys(row).every((key) => !/cookie|token|password|secret|payload/i.test(key))));

  refreshService.recordRefreshStage({ guildId: "guild-audit", actorId: "owner-1", service: "youtube", stage: "validation", success: false });
  const auditRow = getDb().prepare("SELECT guild_id, actor_id, service, action, outcome, created_at FROM admin_operations_audit ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...auditRow }, {
    guild_id: "guild-audit", actor_id: "owner-1", service: "youtube",
    action: "validation_failure", outcome: "validation_failure", created_at: auditRow.created_at,
  });
  assert.equal(JSON.stringify(auditRow).includes("test-only-unusable-token"), false);
});

test("forged refresh components are rejected server-side and never include a credential form", async () => {
  const makeInteraction = (userId, member) => ({
    customId: "harmony-session-refresh:instagram",
    guild: guild(), user: { id: userId }, member,
    isButton: () => true,
    reply: async (payload) => { interactionPayload = payload; },
  });
  let interactionPayload;
  const forged = makeInteraction("ordinary-admin", adminMember());
  assert.equal(await refreshService.handleRefreshInteraction(forged), true);
  assert.match(interactionPayload.content, /Only the owner or a configured Credential Manager/);
  assert.equal(interactionPayload.flags, 64);
  assert.equal("components" in interactionPayload, false);
  assert.equal("files" in interactionPayload, false);

  const ownerAttempt = makeInteraction("owner-1", adminMember());
  assert.equal(await refreshService.handleRefreshInteraction(ownerAttempt), true);
  assert.match(interactionPayload.content, /not yet available/i);
  assert.equal(interactionPayload.content.includes("test-only-unusable-token"), false);
});

test("status distinguishes session expiry from security checkpoints and never offers credential entry", () => {
  const report = {
    checkedAt: "2026-10-27T12:00:00.000Z",
    rows: [
      { id: "social-instagram", name: "Instagram", status: STATUS.attention, explanation: "Sign-in required.", action: "Session refresh required; ask the owner or trusted Credential Manager." },
      { id: "social-threads", name: "Threads", status: STATUS.owner, explanation: "Security checkpoint.", action: "Owner attention required; resolve the account check with the platform." },
    ],
  };
  const payload = statusCommand.makeStatusPayload(report, { canManageCredentials: true });
  const text = JSON.stringify(payload);
  assert.match(text, /Secure session refresh is not available yet/);
  assert.match(text, /Owner attention required/);
  assert.doesNotMatch(text, /harmony-session-refresh:/);
  assert.equal(payload.components[0].components[0].data.custom_id, "harmony-status:refresh");
  const regularAdminPayload = statusCommand.makeStatusPayload(report, { canManageCredentials: false });
  assert.match(JSON.stringify(regularAdminPayload), /ask the owner or a Credential Manager/);
  assert.match(JSON.stringify(regularAdminPayload), /Owner attention required/);
});

test("failed validation audit accepts no submitted session or raw error and cannot rotate a secret", () => {
  getDb();
  const cookiePath = path.join(tempDir, "unchanged-cookie-file.txt");
  const original = "active-session-file-content";
  fs.writeFileSync(cookiePath, original);
  const initialCount = getDb().prepare("SELECT COUNT(*) AS n FROM credential_refresh_requests").get().n;
  assert.throws(() => refreshService.recordRefreshStage({ guildId: "guild-refresh", actorId: "owner-1", service: "instagram", stage: "validation", success: "failed: PRIVATE_ERROR_AND_SECRET" }), /invalid_refresh_audit_event/);
  refreshService.recordRefreshStage({ guildId: "guild-refresh", actorId: "owner-1", service: "instagram", stage: "validation", success: false });
  const sanitized = refreshService.formatRefreshOutcome({ ok: false, reason: "unexpected raw error PRIVATE_ERROR_AND_SECRET" });
  assert.doesNotMatch(sanitized, /PRIVATE_ERROR|SECRET/);
  assert.equal(fs.readFileSync(cookiePath, "utf8"), original);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM credential_refresh_requests").get().n, initialCount);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
