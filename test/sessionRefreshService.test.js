const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-session-refresh-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "refresh.sqlite");

const { PermissionFlagsBits } = require("discord.js");
const { getDb, closeDb, migrate } = require("../src/db/sqlite");
const { recordSocialAuthFailure, recordSocialSuccess } = require("../src/services/operationsStatusService");
const { getAdminCapabilities, STATUS } = require("../src/services/operationsStatusService");
const refreshService = require("../src/services/sessionRefreshService");
const statusCommand = require("../src/commands/status");

function guild(id = "guild-refresh") {
  return { id, ownerId: "owner-1" };
}

function adminMember(roleIds = [], isAdmin = true, permission = PermissionFlagsBits.Administrator) {
  return {
    permissions: { has: (requested) => isAdmin && requested === permission },
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

test("owner and authorized server admins can request; ordinary members cannot", () => {
  const managerRoleIds = new Set(["credential-manager"]);
  const ownerCaps = getAdminCapabilities({ guild: guild(), userId: "owner-1", member: adminMember(), credentialManagerRoleIds: managerRoleIds });
  const trustedCaps = getAdminCapabilities({ guild: guild(), userId: "manager-1", member: adminMember(["credential-manager"]), credentialManagerRoleIds: managerRoleIds });
  const regularCaps = getAdminCapabilities({ guild: guild(), userId: "admin-1", member: adminMember(), credentialManagerRoleIds: managerRoleIds });
  assert.equal(ownerCaps.canManageCredentials, true);
  assert.equal(trustedCaps.canManageCredentials, true);
  assert.equal(regularCaps.canDiagnose, true);
  assert.equal(regularCaps.canManageCredentials, true);
  const memberCaps = getAdminCapabilities({ guild: guild(), userId: "member-1", member: adminMember([], false), credentialManagerRoleIds: managerRoleIds });
  assert.equal(memberCaps.canManageCredentials, false);

  const testFlow = workflow({ capabilities: (candidate) => getAdminCapabilities({ ...candidate, credentialManagerRoleIds: managerRoleIds }) });
  assert.equal(testFlow.service.issue(context(), "instagram").ok, true);
  assert.equal(testFlow.service.issue(context({ userId: "manager-1", roles: ["credential-manager"] }), "threads").ok, true);
  assert.equal(testFlow.service.issue(context({ userId: "member-1", admin: false }), "facebook").reason, "unauthorized");
});

test("legacy refresh requests migrate additively to cookie-refresh purpose", () => {
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(`CREATE TABLE credential_refresh_requests (
    request_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, guild_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, service TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT, completed_at TEXT
  )`);
  legacy.prepare(`INSERT INTO credential_refresh_requests
    (request_id, token_hash, guild_id, actor_id, service, status, created_at, expires_at)
    VALUES ('legacy', 'hash', 'guild', 'actor', 'facebook', 'pending', '2026-10-01', '2026-10-02')`).run();
  migrate(legacy);
  const row = legacy.prepare("SELECT maintenance_type FROM credential_refresh_requests WHERE request_id = 'legacy'").get();
  assert.equal(row.maintenance_type, "cookie_refresh");
  legacy.close();
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
  assert.equal(testFlow.service.redeemRequestId({ ...context({ guildId: "other-guild" }), service: "instagram", requestId: issued.requestId }).reason, "scope_mismatch");
  assert.equal(testFlow.service.redeemRequestId({ ...context(), service: "threads", requestId: issued.requestId }).reason, "scope_mismatch");
  assert.equal(testFlow.service.redeemRequestId({ ...context({ userId: "someone-else" }), service: "instagram", requestId: issued.requestId }).reason, "scope_mismatch");
  const redeemed = testFlow.service.redeemRequestId({ ...context(), service: "instagram", requestId: issued.requestId });
  assert.equal(redeemed.ok, true);
  assert.equal(testFlow.service.redeemRequestId({ ...context(), service: "instagram", requestId: issued.requestId }).reason, "already_used");
  assert.equal(testFlow.service.complete({ requestId: redeemed.requestId, guildId: "other-guild", actorId: "owner-1", service: "instagram" }), false);
  assert.equal(testFlow.service.complete({ requestId: redeemed.requestId, guildId: "guild-refresh", actorId: "owner-1", service: "instagram" }), true);

  const expiredFlow = workflow({ now: "2026-10-27T12:00:00.000Z", capabilities: () => ({ canManageCredentials: true }) });
  const expiredRequest = expiredFlow.service.issue(context({ guildId: "guild-expired" }), "youtube");
  const later = refreshService.createRefreshWorkflow({
    clock: () => new Date("2026-10-27T12:11:00.000Z"),
    infrastructureAvailable: () => true,
    capabilities: () => ({ canManageCredentials: true }),
  });
  assert.equal(later.redeemRequestId({ ...context({ guildId: "guild-expired" }), service: "youtube", requestId: expiredRequest.requestId }).reason, "expired");
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
  const makeInteraction = (userId, member, guildContext = guild()) => ({
    customId: "harmony-session-refresh:instagram",
    guild: guildContext, user: { id: userId }, member,
    isButton: () => true,
    reply: async (payload) => { interactionPayload = payload; },
  });
  let interactionPayload;
  const forged = makeInteraction("ordinary-member", adminMember([], false));
  assert.equal(await refreshService.handleRefreshInteraction(forged), true);
  assert.match(interactionPayload.content, /Only the server owner or an authorized Harmony administrator/);
  assert.equal(interactionPayload.flags, 64);
  assert.equal("components" in interactionPayload, false);
  assert.equal("files" in interactionPayload, false);

  const ownerLookupGuild = { id: "guild-refresh", fetch: async () => ({ id: "guild-refresh", ownerId: "owner-1" }) };
  const forgedAgainstOwnerLookup = makeInteraction("ordinary-member", adminMember([], false), ownerLookupGuild);
  assert.equal(await refreshService.handleRefreshInteraction(forgedAgainstOwnerLookup), true);
  assert.match(interactionPayload.content, /Only the server owner or an authorized Harmony administrator/);

  const ownerAttempt = makeInteraction("owner-1", adminMember());
  assert.equal(await refreshService.handleRefreshInteraction(ownerAttempt), true);
  assert.match(interactionPayload.content, /not yet available/i);
  assert.equal(interactionPayload.content.includes("test-only-unusable-token"), false);
});

test("authorized refresh button issues an HTTPS-scoped page only for explicit expiry", async () => {
  getDb();
  const cookiePath = path.join(tempDir, "button-session.txt");
  fs.writeFileSync(cookiePath, "existing-session");
  const env = {
    SESSION_REFRESH_PUBLIC_URL: process.env.SESSION_REFRESH_PUBLIC_URL,
    DISCORD_OAUTH_CLIENT_ID: process.env.DISCORD_OAUTH_CLIENT_ID,
    DISCORD_OAUTH_CLIENT_SECRET: process.env.DISCORD_OAUTH_CLIENT_SECRET,
    SESSION_REFRESH_RAILWAY_PROJECT_TOKEN: process.env.SESSION_REFRESH_RAILWAY_PROJECT_TOKEN,
    SESSION_REFRESH_RAILWAY_SERVICE_ID: process.env.SESSION_REFRESH_RAILWAY_SERVICE_ID,
    INSTAGRAM_COOKIES_BASE64: process.env.INSTAGRAM_COOKIES_BASE64,
    INSTAGRAM_EXPECTED_USERNAME: process.env.INSTAGRAM_EXPECTED_USERNAME,
    INSTAGRAM_COOKIES: process.env.INSTAGRAM_COOKIES,
    HARMONY_CREDENTIAL_MANAGER_ROLE_IDS: process.env.HARMONY_CREDENTIAL_MANAGER_ROLE_IDS,
  };
  Object.assign(process.env, {
    SESSION_REFRESH_PUBLIC_URL: "https://refresh.example",
    DISCORD_OAUTH_CLIENT_ID: "mock-client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "mock-client-secret",
    SESSION_REFRESH_RAILWAY_PROJECT_TOKEN: "mock-project-token",
    SESSION_REFRESH_RAILWAY_SERVICE_ID: "mock-service-id",
    INSTAGRAM_COOKIES_BASE64: Buffer.from("existing-session").toString("base64"),
    INSTAGRAM_EXPECTED_USERNAME: "@MissHarmony",
    INSTAGRAM_COOKIES: cookiePath,
    HARMONY_CREDENTIAL_MANAGER_ROLE_IDS: "",
  });
  try {
    recordSocialAuthFailure("instagram", new Date().toISOString(), "session");
    let payload;
    const ownerGuildWithoutOwnerId = {
      id: "guild-refresh",
      fetch: async () => ({ id: "guild-refresh", ownerId: "owner-1" }),
    };
    const interaction = {
      customId: "harmony-session-refresh:instagram", guild: ownerGuildWithoutOwnerId, member: adminMember(), user: { id: "owner-1" },
      isButton: () => true, reply: async (message) => { payload = message; },
    };
    assert.equal(await refreshService.handleRefreshInteraction(interaction), true);
    assert.match(payload.content, /short-lived secure instagram cookie refresh request/i);
    assert.equal(payload.components[0].components[0].data.style, 5);
    assert.match(payload.components[0].components[0].data.url, /^https:\/\/refresh\.example\/session-refresh\/[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(payload), /mock-project-token|mock-client-secret|existing-session/);

    recordSocialAuthFailure("instagram", new Date().toISOString(), "session");
    const adminInteraction = {
      customId: "harmony-session-refresh:instagram", guild: ownerGuildWithoutOwnerId,
      member: adminMember(), user: { id: "server-admin" },
      isButton: () => true, reply: async (message) => { payload = message; },
    };
    await refreshService.handleRefreshInteraction(adminInteraction);
    assert.match(payload.content, /short-lived secure instagram cookie refresh request/i);
    assert.match(payload.components[0].components[0].data.url, /^https:\/\/refresh\.example\/session-refresh\//);
    assert.doesNotMatch(JSON.stringify(payload), /mock-project-token|mock-client-secret|existing-session/);

    const beforeCheckpoint = getDb().prepare("SELECT COUNT(*) AS n FROM credential_refresh_requests").get().n;
    recordSocialAuthFailure("instagram", new Date().toISOString(), "owner");
    await refreshService.handleRefreshInteraction(interaction);
    assert.match(payload.content, /invalid or has expired/i);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM credential_refresh_requests").get().n, beforeCheckpoint);
    await refreshService.handleRefreshInteraction({ ...interaction, customId: "harmony-account-maintenance:instagram" });
    assert.match(payload.content, /complete it directly with that platform/i);
    const request = getDb().prepare("SELECT service, maintenance_type FROM credential_refresh_requests ORDER BY rowid DESC LIMIT 1").get();
    assert.deepEqual({ ...request }, { service: "instagram", maintenance_type: "account_verification" });
    assert.doesNotMatch(JSON.stringify(payload), /mock-project-token|mock-client-secret|existing-session/);
    recordSocialSuccess("instagram");
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("status offers distinct cookie and account-verification maintenance to authorized admins only", () => {
  const priorEnv = { ...process.env };
  const statusCookiePath = path.join(tempDir, "status-social-session.txt");
  fs.writeFileSync(statusCookiePath, "non-secret-placeholder");
  Object.assign(process.env, {
    SESSION_REFRESH_PUBLIC_URL: "https://refresh.example",
    DISCORD_OAUTH_CLIENT_ID: "mock-client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "mock-client-secret",
    SESSION_REFRESH_RAILWAY_PROJECT_TOKEN: "mock-project-token",
    SESSION_REFRESH_RAILWAY_SERVICE_ID: "mock-service-id",
    INSTAGRAM_COOKIES_BASE64: Buffer.from("placeholder").toString("base64"),
    INSTAGRAM_EXPECTED_USERNAME: "missharmony",
    INSTAGRAM_COOKIES: statusCookiePath,
    THREADS_COOKIES_BASE64: Buffer.from("placeholder").toString("base64"),
    THREADS_COOKIES: statusCookiePath,
    FACEBOOK_COOKIES_BASE64: Buffer.from("placeholder").toString("base64"),
    FACEBOOK_COOKIES: statusCookiePath,
  });
  try {
  const report = {
    checkedAt: "2026-10-27T12:00:00.000Z",
    rows: [
      { id: "social-instagram", name: "Instagram", status: STATUS.attention, explanation: "Sign-in required.", action: "Session refresh required; ask the owner or trusted Credential Manager." },
      { id: "social-facebook", name: "Facebook", status: STATUS.owner, explanation: "Security checkpoint.", action: "Owner attention required; resolve the account check with the platform." },
    ],
  };
  const payload = statusCommand.makeStatusPayload(report, { canManageCredentials: true });
  const text = JSON.stringify(payload);
  assert.match(text, /\*\*Instagram\*\* — Cookies Need Refresh/);
  assert.match(text, /\*\*Facebook\*\* — Account Verification Required/);
  assert.match(text, /harmony-session-refresh:instagram/);
  assert.match(text, /harmony-account-maintenance:facebook/);
  assert.ok(payload.components.flatMap((row) => row.components).some((component) => component.data.custom_id === "harmony-status:refresh"));
  assert.match(text, /Refresh Instagram Cookies/);
  assert.match(text, /Fix Facebook Account/);
  const regularAdminPayload = statusCommand.makeStatusPayload(report, { canManageCredentials: false });
  assert.match(JSON.stringify(regularAdminPayload), /ask the owner or an authorized Harmony administrator/i);
  assert.match(JSON.stringify(regularAdminPayload), /\*\*Facebook\*\* — Account Verification Required/);
  assert.doesNotMatch(JSON.stringify(regularAdminPayload), /harmony-account-maintenance:|Fix Facebook Account/);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in priorEnv)) delete process.env[name];
    Object.assign(process.env, priorEnv);
  }
});

test("Manage Server admin can launch account verification; regular members cannot", async () => {
  getDb();
  const originalEnv = {
    SESSION_REFRESH_PUBLIC_URL: process.env.SESSION_REFRESH_PUBLIC_URL,
    DISCORD_OAUTH_CLIENT_ID: process.env.DISCORD_OAUTH_CLIENT_ID,
    DISCORD_OAUTH_CLIENT_SECRET: process.env.DISCORD_OAUTH_CLIENT_SECRET,
    SESSION_REFRESH_RAILWAY_PROJECT_TOKEN: process.env.SESSION_REFRESH_RAILWAY_PROJECT_TOKEN,
    SESSION_REFRESH_RAILWAY_SERVICE_ID: process.env.SESSION_REFRESH_RAILWAY_SERVICE_ID,
    INSTAGRAM_COOKIES_BASE64: process.env.INSTAGRAM_COOKIES_BASE64,
    INSTAGRAM_EXPECTED_USERNAME: process.env.INSTAGRAM_EXPECTED_USERNAME,
    INSTAGRAM_COOKIES: process.env.INSTAGRAM_COOKIES,
    FACEBOOK_COOKIES_BASE64: process.env.FACEBOOK_COOKIES_BASE64,
    FACEBOOK_COOKIES: process.env.FACEBOOK_COOKIES,
  };
  Object.assign(process.env, {
    SESSION_REFRESH_PUBLIC_URL: "https://refresh.example",
    DISCORD_OAUTH_CLIENT_ID: "mock-client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "mock-client-secret",
    SESSION_REFRESH_RAILWAY_PROJECT_TOKEN: "mock-project-token",
    SESSION_REFRESH_RAILWAY_SERVICE_ID: "mock-service-id",
    INSTAGRAM_COOKIES_BASE64: Buffer.from("existing-session").toString("base64"),
    INSTAGRAM_EXPECTED_USERNAME: "missharmony",
    INSTAGRAM_COOKIES: path.join(tempDir, "account-maintenance-cookie.txt"),
    FACEBOOK_COOKIES_BASE64: Buffer.from("existing-facebook-session").toString("base64"),
    FACEBOOK_COOKIES: path.join(tempDir, "account-maintenance-facebook.txt"),
  });
  fs.writeFileSync(process.env.INSTAGRAM_COOKIES, "existing-session");
  fs.writeFileSync(process.env.FACEBOOK_COOKIES, "existing-facebook-session");
  try {
    let payload;
    const guildContext = { id: "guild-refresh", fetch: async () => ({ id: "guild-refresh", ownerId: "owner-1" }) };
    const base = {
      customId: "harmony-account-maintenance:instagram", guild: guildContext,
      user: { id: "manage-server-admin" }, member: adminMember([], true, PermissionFlagsBits.ManageGuild), isButton: () => true,
      reply: async (value) => { payload = value; },
    };
    recordSocialAuthFailure("instagram", new Date().toISOString(), "session");
    await refreshService.handleRefreshInteraction({ ...base, customId: "harmony-session-refresh:instagram" });
    assert.match(payload.content, /cookie refresh request/i);
    recordSocialAuthFailure("facebook", new Date().toISOString(), "owner");
    const facebookButton = { ...base, customId: "harmony-account-maintenance:facebook" };
    await refreshService.handleRefreshInteraction(facebookButton);
    assert.match(payload.content, /account-maintenance request/i);
    assert.match(payload.components[0].components[0].data.url, /^https:\/\/refresh\.example\/session-refresh\//);
    assert.doesNotMatch(JSON.stringify(payload), /mock-project-token|mock-client-secret|existing-session/);
    await refreshService.handleRefreshInteraction({ ...facebookButton, user: { id: "administrator" }, member: adminMember([], true) });
    assert.match(payload.content, /account-maintenance request/i);

    await refreshService.handleRefreshInteraction({ ...base, user: { id: "member" }, member: adminMember([], false) });
    assert.match(payload.content, /Only the server owner or an authorized Harmony administrator/);
    assert.equal("components" in payload, false);
  } finally {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
