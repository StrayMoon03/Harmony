const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-status-test-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "status.sqlite");
process.env.YOUTUBE_COOKIES = path.join(tempDir, "missing-youtube-cookies.txt");

const { PermissionFlagsBits } = require("discord.js");
const { getDb, closeDb } = require("../src/db/sqlite");
let statusService = require("../src/services/operationsStatusService");
const guardStore = require("../src/stores/communityGuardStore");
const eventStore = require("../src/stores/eventSchedulerStore");
const statusCommand = require("../src/commands/status");
const { managerPanelComponents } = require("../src/services/eventSchedulerService");

function client({ ready = true, failReady = false, listeners = 3 } = {}) {
  return {
    isReady: () => { if (failReady) throw new Error("private detail SECRET_VALUE"); return ready; },
    user: ready ? { id: "bot" } : null,
    ws: { ping: 42 },
    listenerCount: () => listeners > 0 ? 1 : 0,
  };
}

function guild(id = "guild-status") {
  return {
    id,
    ownerId: "owner-1",
    channels: { cache: new Map(), fetch: async () => null },
  };
}

function reloadStatusService() {
  closeDb();
  delete require.cache[require.resolve("../src/stores/socialHealthStore")];
  delete require.cache[require.resolve("../src/services/operationsStatusService")];
  statusService = require("../src/services/operationsStatusService");
  return statusService;
}

test.beforeEach(() => {
  getDb().prepare("DELETE FROM social_health_state").run();
  getDb().prepare("DELETE FROM social_health_verification_attempts").run();
});

test("social health signals survive a database close and status-service reload", async () => {
  const now = new Date().toISOString();
  statusService.recordSocialMaintenanceSuccess("facebook", now);
  statusService.recordSocialAuthFailure("facebook", now, "session");
  assert.equal(getDb().prepare("SELECT last_success_at FROM social_health_state WHERE platform = 'facebook'").get().last_success_at, null);
  for (const platform of ["instagram", "youtube", "threads"]) statusService.recordSocialMaintenanceSuccess(platform, now);

  statusService = reloadStatusService();
  assert.equal((await statusService.checkSocial("facebook")).status, statusService.STATUS.attention);
  assert.match((await statusService.checkSocial("facebook")).action, /Facebook cookies need to be refreshed/);
  for (const platform of ["instagram", "youtube", "threads"]) {
    assert.equal((await statusService.checkSocial(platform)).status, statusService.STATUS.healthy, platform);
  }

  statusService.recordSocialMaintenanceSuccess("facebook", new Date().toISOString());
  statusService = reloadStatusService();
  assert.equal((await statusService.checkSocial("facebook")).status, statusService.STATUS.healthy);
});

test("expired persisted success returns Unable to Verify after restart", async () => {
  const expiredAt = new Date(Date.now() - statusService.SOCIAL_SUCCESS_TTL_MS - 1).toISOString();
  statusService.recordSocialMaintenanceSuccess("instagram", expiredAt);
  statusService = reloadStatusService();
  assert.equal((await statusService.checkSocial("instagram")).status, statusService.STATUS.unknown);
});

test("legacy unclassified session failure is not presented as a cookie diagnosis", async () => {
  getDb().prepare(`INSERT INTO social_health_state (platform, state, failure_kind, last_success_at, updated_at)
    VALUES ('facebook', 'failure', 'session', NULL, '2026-11-06T00:00:00.000Z')`).run();
  statusService = reloadStatusService();
  const row = await statusService.checkSocial("facebook");
  assert.equal(row.status, statusService.STATUS.unknown);
  assert.doesNotMatch(row.action, /cookies need to be refreshed/i);
});

test("checkpoint state survives restart and ordinary success does not clear it", async () => {
  const checkpointAt = "2026-11-02T12:00:00.000Z";
  statusService.recordSocialAuthFailure("youtube", checkpointAt, "owner");
  statusService.recordSocialSuccess("youtube", new Date().toISOString(), { authenticated: true });
  statusService = reloadStatusService();
  const row = await statusService.checkSocial("youtube");
  assert.equal(row.status, statusService.STATUS.owner);
  assert.match(row.action, /Owner attention required/);
  const saved = getDb().prepare("SELECT state, failure_kind, last_success_at FROM social_health_state WHERE platform = 'youtube'").get();
  assert.equal(saved.state, "failure");
  assert.equal(saved.failure_kind, "owner");
  assert.ok(saved.last_success_at);
  assert.equal(getDb().prepare("SELECT updated_at FROM social_health_state WHERE platform = 'youtube'").get().updated_at, checkpointAt);
});

test("social health persistence stores only allowlisted state and normalized timestamps", () => {
  statusService.recordSocialAuthFailure("facebook", "private auth error COOKIE_SECRET_TOKEN", "session: raw exception");
  const savedRows = getDb().prepare("SELECT * FROM social_health_state").all();
  const saved = JSON.stringify(savedRows);
  assert.doesNotMatch(saved, /private auth error|COOKIE_SECRET|TOKEN|raw exception/);
  assert.match(saved, /session/);
  assert.doesNotMatch(saved, /private auth error/);
});

test("fresh status reports healthy Discord and database checks independently", async () => {
  const rows = await statusService.collectStatus({ client: client(), guild: guild() });
  assert.equal(rows.find((row) => row.id === "discord").status, statusService.STATUS.healthy);
  assert.equal(rows.find((row) => row.id === "database").status, statusService.STATUS.healthy);
  assert.equal(rows.find((row) => row.id === "event-sync").status, statusService.STATUS.unknown);
});

test("a failed check does not prevent other systems from rendering", async () => {
  const rows = await statusService.collectStatus({ client: client({ failReady: true }), guild: guild("independent") });
  assert.equal(rows.find((row) => row.id === "discord").status, statusService.STATUS.owner);
  assert.equal(rows.find((row) => row.id === "database").status, statusService.STATUS.healthy);
  assert.equal(rows.length, 11);
  assert.deepEqual(rows.filter((row) => row.id.startsWith("social-")).map((row) => row.id).sort(), [
    "social-facebook", "social-instagram", "social-threads", "social-tiktok", "social-x", "social-youtube",
  ]);
  assert.equal(JSON.stringify(rows).includes("SECRET_VALUE"), false);
});

test("unconfigured session is reported honestly and only structured auth evidence requests refresh", async () => {
  delete process.env.THREADS_COOKIES;
  const initial = await statusService.checkSocial("youtube");
  assert.equal(initial.status, statusService.STATUS.unknown);
  assert.match(initial.explanation, /No saved authenticated session is configured/);

  statusService.recordSocialAuthFailure("youtube", "2026-10-27T00:00:00.000Z");
  const failed = await statusService.checkSocial("youtube");
  assert.equal(failed.status, statusService.STATUS.attention);
  assert.match(failed.action, /YouTube cookies need to be refreshed/);
  statusService.recordSocialSuccess("youtube", new Date().toISOString(), { authenticated: true });
  assert.equal((await statusService.checkSocial("youtube")).status, statusService.STATUS.healthy);
  assert.equal(statusService.isExplicitAuthenticationFailure(new Error("Login required to view this post")), false);
  assert.equal(statusService.isExplicitAuthenticationFailure({ message: "Login required", socialAuthFailureKind: "session" }), true);
  assert.equal(statusService.isExplicitAuthenticationFailure(new Error("Cookie file could not be read")), false);
  statusService.recordSocialAuthFailure("threads", "2026-10-27T00:00:00.000Z", "owner");
  const checkpoint = await statusService.checkSocial("threads");
  assert.equal(checkpoint.status, statusService.STATUS.owner);
  assert.match(checkpoint.action, /Owner attention required/);
  statusService.recordSocialSuccess("threads");
  assert.equal((await statusService.checkSocial("threads")).status, statusService.STATUS.owner);
  statusService.recordSocialSuccess("threads");
});

test("anonymous Instagram success cannot clear a stale cookie failure; authenticated evidence can", async () => {
  statusService.recordSocialAuthFailure("instagram", "2026-10-28T08:00:00.000Z", "session");
  assert.equal((await statusService.checkSocial("instagram")).status, statusService.STATUS.attention);
  statusService.recordSocialSuccess("instagram", new Date().toISOString());
  assert.equal((await statusService.checkSocial("instagram")).status, statusService.STATUS.attention);
  statusService.recordSocialSuccess("instagram", new Date().toISOString(), { authenticated: true });
  const row = await statusService.checkSocial("instagram");
  assert.equal(row.status, statusService.STATUS.healthy);
  assert.match(row.explanation, /recent authenticated request succeeded/i);
});

test("Facebook authenticated exact-post media delivery failures do not mark cookies bad; explicit auth failures do", async () => {
  const { logMediaError } = require("../src/services/errorInboxService");
  await logMediaError({ content: "https://www.facebook.com/share/p/example/", client: {} },
    new Error("Facebook verified post attachment failed at CDN: image below old 30 KiB threshold"));
  assert.equal((await statusService.checkSocial("facebook")).status, statusService.STATUS.unknown);

  const loginFailure = new Error("Facebook opened a login page after an authenticated post request");
  loginFailure.socialAuthFailureKind = "session";
  loginFailure.socialAuthFailureCategory = "login_required";
  await logMediaError({ content: "https://www.facebook.com/share/p/example/", client: {} }, loginFailure);
  assert.equal((await statusService.checkSocial("facebook")).status, statusService.STATUS.attention);
  assert.match((await statusService.checkSocial("facebook")).action, /Facebook cookies need to be refreshed/);

  const instagramEvidence = statusService.classifyAuthenticatedProviderFailure(
    new Error("Instagram login required to view this media"), { authenticatedRequest: true }
  );
  assert.deepEqual(instagramEvidence, { kind: "session", category: "login_required" });
  statusService.recordSocialAuthFailure("instagram", new Date().toISOString(), instagramEvidence.kind, instagramEvidence.category);
  assert.equal((await statusService.checkSocial("instagram")).status, statusService.STATUS.attention);
  statusService.recordSocialSuccess("instagram");
  assert.equal((await statusService.checkSocial("instagram")).status, statusService.STATUS.attention);
});

test("session file presence never exposes its path or contents or claims authentication", async () => {
  statusService.recordSocialSuccess("instagram", "2020-01-01T00:00:00.000Z");
  const secretPath = path.join(tempDir, "private-cookie-file.txt");
  fs.writeFileSync(secretPath, "SESSION_COOKIE_VALUE_NEVER_OUTPUT");
  process.env.INSTAGRAM_COOKIES = secretPath;
  const row = await statusService.checkSocial("instagram");
  assert.equal(row.status, statusService.STATUS.unknown);
  assert.match(row.explanation, /has not been recently verified/);
  assert.equal(JSON.stringify(row).includes(secretPath), false);
  assert.equal(JSON.stringify(row).includes("SESSION_COOKIE_VALUE_NEVER_OUTPUT"), false);
});

test("explicit Facebook and Instagram verification persist verified healthy state across service reload", async () => {
  const now = "2026-11-07T12:00:00.000Z";
  for (const platform of ["facebook", "instagram"]) {
    const result = await statusService.verifySocialSession(platform, {
      clock: () => now,
      isConfigured: async () => true,
      readFile: async () => "SESSION_SECRET_SENTINEL",
      validator: async (service, candidate) => {
        assert.equal(candidate, "SESSION_SECRET_SENTINEL");
        return { status: "AUTHENTICATED" };
      },
    });
    assert.equal(result.state, "verified");
    assert.equal((await statusService.checkSocial(platform)).status, statusService.STATUS.healthy);
  }
  statusService = reloadStatusService();
  for (const platform of ["facebook", "instagram"]) {
    assert.equal((await statusService.checkSocial(platform)).status, statusService.STATUS.healthy);
  }
  const stored = JSON.stringify(getDb().prepare("SELECT * FROM social_health_state").all());
  assert.doesNotMatch(stored, /SESSION_SECRET_SENTINEL|cookie|token|password/i);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM social_health_verification_attempts WHERE last_result = 'verified'").get().n, 2);
});

test("indeterminate verification stays unknown and does not infer cookie failure", async () => {
  const result = await statusService.verifySocialSession("instagram", {
    clock: () => "2026-11-07T12:00:00.000Z",
    isConfigured: async () => true,
    readFile: async () => "opaque candidate",
    validator: async () => ({ status: "INCONCLUSIVE" }),
  });
  assert.equal(result.state, "unknown");
  assert.equal((await statusService.checkSocial("instagram")).status, statusService.STATUS.unknown);
  assert.equal(getDb().prepare("SELECT state FROM social_health_state WHERE platform = 'instagram'").get(), undefined);
});

test("live verification distinguishes rejected session from security checkpoint", async () => {
  const run = (platform, status, at) => statusService.verifySocialSession(platform, {
    clock: () => at,
    isConfigured: async () => true,
    readFile: async () => "opaque candidate",
    validator: async () => ({ status }),
  });
  assert.equal((await run("facebook", "UNAUTHENTICATED", "2026-11-07T12:00:00.000Z")).state, "session");
  assert.equal((await statusService.checkSocial("facebook")).status, statusService.STATUS.attention);
  assert.equal((await run("instagram", "OWNER_REQUIRED", "2026-11-07T12:10:00.000Z")).state, "owner");
  assert.equal((await statusService.checkSocial("instagram")).status, statusService.STATUS.owner);
  statusService = reloadStatusService();
  assert.equal((await statusService.checkSocial("facebook")).status, statusService.STATUS.attention);
  assert.equal((await statusService.checkSocial("instagram")).status, statusService.STATUS.owner);
});

test("verification cooldown prevents repeated provider checks and missing sessions remain unconfigured", async () => {
  const time = "2026-11-07T12:00:00.000Z";
  let calls = 0;
  const options = { clock: () => time, isConfigured: async () => true, readFile: async () => "candidate", validator: async () => { calls++; return { status: "INCONCLUSIVE" }; } };
  assert.equal((await statusService.verifySocialSession("facebook", options)).state, "unknown");
  assert.equal((await statusService.verifySocialSession("facebook", options)).state, "rate_limited");
  assert.equal(calls, 1);
  const absent = await statusService.verifySocialSession("youtube", { isConfigured: async () => false });
  assert.equal(absent.state, "not_configured");
});

test("secure refresh records an explicit verified checkpoint and legacy media success is not enough for cookie services", async () => {
  statusService.recordSocialSuccess("facebook", "2026-11-07T12:00:00.000Z");
  assert.equal((await statusService.checkSocial("facebook")).status, statusService.STATUS.unknown);
  statusService.recordSocialMaintenanceSuccess("facebook", "2026-11-07T12:05:00.000Z");
  const stored = getDb().prepare("SELECT success_kind, last_verified_at FROM social_health_state WHERE platform = 'facebook'").get();
  assert.equal(stored.success_kind, "refresh");
  assert.equal(stored.last_verified_at, "2026-11-07T12:05:00.000Z");
  assert.equal((await statusService.checkSocial("facebook")).status, statusService.STATUS.healthy);
});

test("Manage Server admins can refresh credentials while owner diagnostics remain owner-only", () => {
  const manageServer = { permissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild } };
  const regular = statusService.getAdminCapabilities({ guild: guild(), member: manageServer, userId: "admin-1", credentialManagerRoleIds: new Set() });
  assert.equal(regular.canDiagnose, true);
  assert.equal(regular.canManageCredentials, true);
  assert.equal(regular.canViewOwnerDiagnostics, false);

  const trusted = statusService.getAdminCapabilities({
    guild: guild(), userId: "admin-2", credentialManagerRoleIds: new Set(["trusted-role"]),
    member: { permissions: { has: () => true }, roles: { cache: [{ id: "trusted-role" }] } },
  });
  assert.equal(trusted.canViewFullStatus, true);
  assert.equal(trusted.canManageCredentials, true);
  assert.equal(trusted.credentialManagementAvailable, false);

  const owner = statusService.getAdminCapabilities({ guild: guild(), userId: "owner-1", member: { permissions: { has: () => false } } });
  assert.equal(owner.canManageCredentials, true);
  assert.equal(owner.canViewOwnerDiagnostics, true);
  assert.equal(trusted.canViewOwnerDiagnostics, false);
});

test("owner capability refreshes guild metadata when the interaction guild lacks ownerId", async () => {
  const staleGuild = { id: "guild-owner-refresh", fetch: async () => ({ id: "guild-owner-refresh", ownerId: "owner-1" }) };
  const owner = await statusService.resolveAdminCapabilities({
    guild: staleGuild,
    userId: "owner-1",
    member: { permissions: { has: () => false } },
    credentialManagerRoleIds: new Set(),
  });
  assert.equal(owner.canManageCredentials, true);
  assert.equal(owner.resolvedGuildOwnerId, "owner-1");

  const regularAdmin = await statusService.resolveAdminCapabilities({
    guild: staleGuild,
    userId: "admin-1",
    member: { permissions: { has: (permission) => permission === PermissionFlagsBits.Administrator } },
    credentialManagerRoleIds: new Set(),
  });
  assert.equal(regularAdmin.canDiagnose, true);
  assert.equal(regularAdmin.canManageCredentials, true);
});

test("harmony-status resolves a guild owner before rendering session-refresh guidance", async () => {
  const incompleteGuild = {
    ...guild("status-owner-resolution"),
    ownerId: undefined,
    fetch: async () => ({ id: "status-owner-resolution", ownerId: "owner-1" }),
  };
  const interaction = {
    guild: incompleteGuild,
    member: { permissions: { has: () => false } },
    user: { id: "owner-1" },
    client: client(),
    deferred: false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { interaction.response = payload; return payload; },
  };
  await statusCommand.execute(interaction);
  assert.ok(interaction.response.components.flatMap((row) => row.components).some((button) => button.data.custom_id === "harmony-status:diagnostics"));
});

test("Status / Health button uses the same refreshed guild-owner authorization", async () => {
  const interaction = {
    customId: "harmony-status:refresh",
    isButton: () => true,
    message: {},
    guild: {
      ...guild("status-button-owner-resolution"),
      ownerId: undefined,
      fetch: async () => ({ id: "status-button-owner-resolution", ownerId: "owner-1" }),
    },
    member: { permissions: { has: () => false } },
    user: { id: "owner-1" },
    client: client(),
    update: async (payload) => { interaction.response = payload; },
  };
  assert.equal(await statusCommand.handleStatusInteraction(interaction), true);
  assert.ok(interaction.response.components.flatMap((row) => row.components).some((button) => button.data.custom_id === "harmony-status:diagnostics"));
});

test("regular-admin Status shows each platform as simple dashboard lights while owner diagnostics stay detailed", async () => {
  const report = {
    checkedAt: "2026-10-28T12:00:00.000Z",
    rows: [
      { id: "discord", name: "Harmony / Discord connection", status: statusService.STATUS.healthy, explanation: "Harmony is connected to Discord.", action: "No action needed." },
      { id: "database", name: "Database", status: statusService.STATUS.healthy, explanation: "Database reads succeed.", action: "No action needed." },
      { id: "discovery", name: "Event discovery", status: statusService.STATUS.unknown, explanation: "Automatic Stray Kids schedule checks are off for this server.", action: "No action needed." },
      { id: "event-sync", name: "Discord/event synchronization", status: statusService.STATUS.unknown, explanation: "Listeners are attached; end-to-end sync is not tracked.", action: "Use Calendar reconciliation controls." },
      { id: "social-instagram", name: "Instagram", status: statusService.STATUS.unknown, explanation: "Session validity is not actively tested.", action: "No action unless a request reports a login problem." },
      { id: "social-facebook", name: "Facebook", status: statusService.STATUS.owner, explanation: "Facebook cookies need to be refreshed after a media request reported sign-in is required. SECRET_DIAGNOSTIC", action: "Facebook cookies need to be refreshed." },
      { id: "social-youtube", name: "YouTube", status: statusService.STATUS.owner, explanation: "A security checkpoint was reported.", action: "Owner attention required; resolve the account check with the platform." },
      { id: "social-threads", name: "Threads", status: statusService.STATUS.healthy, explanation: "A recent media retrieval succeeded.", action: "No action needed." },
      { id: "social-tiktok", name: "TikTok", status: statusService.STATUS.unknown, explanation: "No verified retrieval yet.", action: "No action available." },
      { id: "social-x", name: "X", status: statusService.STATUS.unknown, explanation: "No verified retrieval yet.", action: "No action available." },
      { id: "guard", name: "Community Guard", status: statusService.STATUS.unknown, explanation: "Monitoring is off. Review Room: configured. Active rules: 4. Ordinary members appear able to view the Review Room.", action: "Turn monitoring on with /harmony-guard setup." },
    ],
  };
  const regular = statusCommand.makeStatusPayload(report, { canDiagnose: true, canManageCredentials: false });
  const adminText = JSON.stringify(regular);
  for (const expected of [
    "**Harmony** — Working", "**Discord** — Connected", "**Instagram** — Unable to Verify",
    "**Facebook** — Cookies Need Refresh", "**YouTube** — Account Verification Required",
    "**Threads** — Working", "**TikTok** — Unable to Verify", "**X** — Unable to Verify",
    "**Event Discovery** — Off", "**Community Guard** — Off",
  ]) assert.ok(adminText.includes(expected), expected);
  assert.doesNotMatch(adminText, /Social Media Links/);
  assert.match(adminText, /🟡 \*\*Facebook\*\* — Cookies Need Refresh/);
  assert.doesNotMatch(adminText, /\*\*Facebook\*\* — Owner\/Developer Required/);
  assert.doesNotMatch(adminText, /SECRET_DIAGNOSTIC|Active rules|Review Room|ordinary members|\/harmony-guard|Turn discovery on|No explicit login failure|does not actively test/);
  assert.doesNotMatch(adminText, /Database|Discord\/event synchronization|Railway|OAuth/);
  assert.doesNotMatch(adminText, /harmony-session-refresh:/);

  const owner = statusCommand.makeStatusPayload(report, { canDiagnose: true, canManageCredentials: true, canViewOwnerDiagnostics: true, isGuildOwner: true });
  assert.ok(owner.components.flatMap((row) => row.components).some((button) => button.data.custom_id === "harmony-status:diagnostics"));
  const diagnostics = statusCommand.makeOwnerDiagnosticsPayload(report);
  const diagnosticText = JSON.stringify(diagnostics);
  assert.match(diagnosticText, /Database/);
  assert.match(diagnosticText, /Discord\/event synchronization/);
  assert.match(diagnosticText, /Community Guard/);
  assert.match(diagnosticText, /Active rules: 4/);
  assert.match(diagnosticText, /Review Room/);
  assert.match(diagnosticText, /Secure Cookie Refresh Readiness/);
  assert.match(diagnosticText, /secure cookie refresh not fully configured/i);
  assert.doesNotMatch(diagnosticText, /COOKIE_VALUE|token-value|oauth-secret|private-cookie-file/);
});

test("authorized admins receive secure cookie controls for explicit expiry, ordinary members do not", () => {
  const report = { checkedAt: new Date().toISOString(), rows: [
    { id: "social-instagram", name: "Instagram", status: statusService.STATUS.attention, explanation: "Sensitive authentication evidence.", action: "Instagram cookies need to be refreshed." },
  ] };
  const regular = statusCommand.makeStatusPayload(report, { canManageCredentials: false });
  assert.match(JSON.stringify(regular), /\*\*Instagram\*\* — Cookies Need Refresh/);
  assert.match(JSON.stringify(regular), /Ask the owner or an authorized Harmony administrator/);
  assert.doesNotMatch(JSON.stringify(regular), /harmony-session-refresh:|Refresh Instagram Cookies/);
  const oldEnv = Object.fromEntries(["INSTAGRAM_COOKIES", "INSTAGRAM_COOKIES_BASE64", "INSTAGRAM_EXPECTED_USERNAME", "SESSION_REFRESH_PUBLIC_URL", "DISCORD_OAUTH_CLIENT_ID", "DISCORD_OAUTH_CLIENT_SECRET", "SESSION_REFRESH_RAILWAY_PROJECT_TOKEN", "SESSION_REFRESH_RAILWAY_SERVICE_ID"].map((key) => [key, process.env[key]]));
  const cookieFile = path.join(tempDir, "refresh-available-cookies.txt");
  fs.writeFileSync(cookieFile, "test-cookie");
  Object.assign(process.env, {
    INSTAGRAM_COOKIES: cookieFile,
    INSTAGRAM_COOKIES_BASE64: "bm90LWEtdXNlci1zZWNyZXQ=",
    INSTAGRAM_EXPECTED_USERNAME: "MissHarmony",
    SESSION_REFRESH_PUBLIC_URL: "https://refresh.example",
    DISCORD_OAUTH_CLIENT_ID: "test-client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "test-client-secret",
    SESSION_REFRESH_RAILWAY_PROJECT_TOKEN: "test-project-token",
    SESSION_REFRESH_RAILWAY_SERVICE_ID: "test-service-id",
  });
  try {
    const authorizedAdmin = statusCommand.makeStatusPayload(report, { canManageCredentials: true });
    assert.ok(authorizedAdmin.components.flatMap((row) => row.components).some((button) => button.data.label === "Refresh Instagram Cookies"));
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("cookie expiry wording is consistent across refreshable platforms and checkpoints stay distinct", () => {
  const report = { checkedAt: new Date().toISOString(), rows: [
    ...["instagram", "facebook", "threads", "youtube"].map((platform) => ({
      id: `social-${platform}`, name: platform[0].toUpperCase() + platform.slice(1),
      status: statusService.STATUS.owner, explanation: "Private diagnostic evidence", action: `${platform} cookies need to be refreshed.`,
    })),
    { id: "social-tiktok", name: "TikTok", status: statusService.STATUS.owner,
      explanation: "Private checkpoint detail", action: "Account verification required; owner attention required." },
  ] };
  const payload = statusCommand.makeStatusPayload(report, { canManageCredentials: true });
  const text = JSON.stringify(payload);
  for (const platform of ["Instagram", "Facebook", "Threads", "Youtube"]) {
    assert.match(text, new RegExp(`\\*\\*${platform}\\*\\* — Cookies Need Refresh`, "i"));
    assert.doesNotMatch(text, new RegExp(`\\*\\*${platform}\\*\\* — Owner/Developer Required`, "i"));
  }
  assert.match(text, /TikTok.*Owner\/Developer Required/);
  assert.doesNotMatch(text, /Private diagnostic evidence|Private checkpoint detail/);
});

test("disabled discovery and Guard are neutral while enabled faults remain attention states", async () => {
  const id = "status-neutral-options";
  getDb();
  eventStore.saveCalendarDiscoveryConfig(id, { enabled: 0 });
  const discoveryOff = await statusService.checkDiscovery(id);
  assert.equal(discoveryOff.status, statusService.STATUS.unknown);

  const guardUnconfigured = await statusService.checkGuard(guild("guard-not-configured"));
  assert.equal(guardUnconfigured.status, statusService.STATUS.unknown);
  const unconfiguredPayload = statusCommand.makeStatusPayload({ checkedAt: new Date().toISOString(), rows: [guardUnconfigured] });
  assert.match(JSON.stringify(unconfiguredPayload), /Community Guard\*\* — Not Set Up/);
  const everyone = { id, permissions: { has: () => false } };
  const publicRole = { id: "member-role", permissions: { has: () => false } };
  const manager = {
    id: "guard-neutral-room",
    isTextBased: () => true,
    guild: { roles: { everyone, cache: new Map([[publicRole.id, publicRole]]) }, members: { cache: new Map() } },
    permissionOverwrites: { cache: new Map() },
    permissionsFor: () => ({ has: () => false }),
  };
  const guardGuild = { id, channels: { cache: new Map([[manager.id, manager]]), fetch: async () => manager } };
  guardStore.saveSettings(id, manager.id);
  guardStore.setMonitoringEnabled(id, false);
  const guardOff = await statusService.checkGuard(guardGuild);
  assert.equal(guardOff.status, statusService.STATUS.unknown);
  assert.match(guardOff.explanation, /Monitoring is off/);

  eventStore.saveCalendarDiscoveryConfig(id, { enabled: 1 });
  eventStore.saveCalendarDiscoveryState(id, "jype-straykids-schedule", { lastError: "source error" });
  const discoveryFault = await statusService.checkDiscovery(id);
  assert.equal(discoveryFault.status, statusService.STATUS.attention);
});

test("owner diagnostics component rejects credential managers and regular admins server-side", async () => {
  let response;
  const interaction = {
    customId: "harmony-status:diagnostics",
    isButton: () => true,
    message: {},
    guild: { id: "diagnostics-auth", ownerId: "owner-id" },
    member: { permissions: { has: (permission) => permission === PermissionFlagsBits.Administrator }, roles: { cache: [{ id: "credential-manager" }] } },
    user: { id: "trusted-manager" },
    client: client(),
    update: async (payload) => { response = payload; },
  };
  assert.equal(await statusCommand.handleStatusInteraction(interaction), true);
  assert.match(response.content, /server owner/);
  assert.doesNotMatch(JSON.stringify(response), /Database|Owner Diagnostics/);
});

test("Verify Social Sessions component rechecks admin permission server-side", async () => {
  let response;
  const interaction = {
    customId: "harmony-status:verify:facebook",
    isButton: () => true,
    message: {},
    guild: guild("verify-authorization"),
    member: { permissions: { has: () => false } },
    user: { id: "ordinary-member" },
    update: async (payload) => { response = payload; },
  };
  assert.equal(await statusCommand.handleStatusInteraction(interaction), true);
  assert.match(response.content, /Only authorized server admins/);
  assert.deepEqual(response.embeds, []);
});

test("authorized admin Verify button returns a safe unconfigured result without exposing paths or secrets", async () => {
  const oldPath = process.env.FACEBOOK_COOKIES;
  process.env.FACEBOOK_COOKIES = path.join(tempDir, "verify-button-missing-cookie-file.txt");
  let response;
  const interaction = {
    customId: "harmony-status:verify:facebook",
    isButton: () => true,
    message: {},
    guild: guild("verify-button-admin"),
    member: { permissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild } },
    user: { id: "manage-server-admin" },
    client: client(),
    update: async (payload) => { response = payload; },
  };
  try {
    assert.equal(await statusCommand.handleStatusInteraction(interaction), true);
    assert.match(response.content, /Facebook has no saved session to verify/);
    assert.doesNotMatch(JSON.stringify(response), /verify-button-missing-cookie-file|SECRET|token|cookie file path/i);
  } finally {
    if (oldPath === undefined) delete process.env.FACEBOOK_COOKIES;
    else process.env.FACEBOOK_COOKIES = oldPath;
  }
});

test("Guard status includes monitoring, active rules, and Review Room visibility", async () => {
  const id = "guard-status-test";
  const everyone = { id: id, permissions: { has: () => false } };
  const publicRole = { id: "public-role", permissions: { has: () => false } };
  const visibleChannel = {
    id: "review-room",
    guild: { roles: { everyone, cache: new Map([[publicRole.id, publicRole]]) }, members: { cache: new Map() } },
    permissionOverwrites: { cache: new Map() },
    permissionsFor: (role) => ({ has: (bit) => bit === PermissionFlagsBits.ViewChannel && role.id === publicRole.id }),
    isTextBased: () => true,
  };
  const mockGuild = {
    id,
    channels: { cache: new Map([[visibleChannel.id, visibleChannel]]), fetch: async () => visibleChannel },
  };
  getDb();
  guardStore.saveSettings(id, visibleChannel.id);
  guardStore.addRule({ guildId: id, type: "phrase", pattern: "spam", action: "flag", category: "spam" });
  const row = await statusService.checkGuard(mockGuild);
  assert.equal(row.status, statusService.STATUS.attention);
  assert.match(row.explanation, /Monitoring is on/);
  assert.match(row.explanation, /Active rules: 1/);
  assert.match(row.explanation, /ordinary members appear able/i);
});

test("status response is ephemeral and includes a fresh-check control without secrets", () => {
  const payload = statusCommand.makeStatusPayload({
    checkedAt: "2026-10-27T12:00:00.000Z",
    rows: [
      { id: "discord", name: "Harmony / Discord connection", status: statusService.STATUS.healthy, explanation: "Connected.", action: "No action." },
      { id: "social-instagram", name: "Instagram", status: statusService.STATUS.unknown, explanation: "Cannot confirm login validity.", action: "No action unless a media request reports a login issue." },
    ],
  }, { canManageCredentials: false });
  assert.equal(payload.flags, 64);
  const buttons = payload.components.flatMap((row) => row.components);
  assert.ok(buttons.some((button) => button.data.custom_id === "harmony-status:refresh"));
  for (const platform of ["instagram", "facebook", "youtube", "threads"]) {
    assert.ok(buttons.some((button) => button.data.custom_id === `harmony-status:verify:${platform}`));
  }
  assert.equal(JSON.stringify(payload).includes("COOKIE"), false);
});

test("both existing Schedule Manager panels open the shared Status / Health check", () => {
  for (const calendarType of ["stray_kids", "community"]) {
    const ids = managerPanelComponents(calendarType, "guild-status")
      .flatMap((row) => row.components.map((component) => component.data.custom_id));
    assert.ok(ids.includes("harmony-status:open"));
  }
});

test("status check audit stores actor and outcome without secret fields", async () => {
  const report = await statusService.runStatusCheck({ client: client(), guild: guild("audit-status"), actorId: "admin-auditor" });
  const row = getDb().prepare("SELECT guild_id, actor_id, service, action, outcome, created_at FROM admin_operations_audit ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.guild_id, "audit-status");
  assert.equal(row.actor_id, "admin-auditor");
  assert.equal(row.service, "harmony");
  assert.equal(row.action, "status_check");
  assert.equal(row.outcome, report.outcome);
  assert.equal(Object.keys(row).some((key) => /cookie|token|password|secret/i.test(key)), false);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
