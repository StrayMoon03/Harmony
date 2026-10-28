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
const statusService = require("../src/services/operationsStatusService");
const guardStore = require("../src/stores/communityGuardStore");
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
  assert.equal(rows.length, 9);
  assert.equal(JSON.stringify(rows).includes("SECRET_VALUE"), false);
});

test("unconfigured session is reported honestly and explicit auth failure requests refresh", async () => {
  delete process.env.THREADS_COOKIES;
  const initial = await statusService.checkSocial("youtube");
  assert.equal(initial.status, statusService.STATUS.unknown);
  assert.match(initial.explanation, /No saved session is configured/);

  statusService.recordSocialAuthFailure("youtube", "2026-10-27T00:00:00.000Z");
  const failed = await statusService.checkSocial("youtube");
  assert.equal(failed.status, statusService.STATUS.attention);
  assert.match(failed.action, /Session refresh required/);
  statusService.recordSocialSuccess("youtube");
  assert.equal((await statusService.checkSocial("youtube")).status, statusService.STATUS.unknown);
  assert.equal(statusService.isExplicitAuthenticationFailure(new Error("Login required to view this post")), true);
  assert.equal(statusService.isExplicitAuthenticationFailure(new Error("Cookie file could not be read")), false);
  statusService.recordSocialAuthFailure("threads", "2026-10-27T00:00:00.000Z", "owner");
  const checkpoint = await statusService.checkSocial("threads");
  assert.equal(checkpoint.status, statusService.STATUS.owner);
  assert.match(checkpoint.action, /Owner attention required/);
  statusService.recordSocialSuccess("threads");
});

test("session file presence never exposes its path or contents or claims authentication", async () => {
  const secretPath = path.join(tempDir, "private-cookie-file.txt");
  fs.writeFileSync(secretPath, "SESSION_COOKIE_VALUE_NEVER_OUTPUT");
  process.env.INSTAGRAM_COOKIES = secretPath;
  const row = await statusService.checkSocial("instagram");
  assert.equal(row.status, statusService.STATUS.unknown);
  assert.match(row.explanation, /cannot confirm/);
  assert.equal(JSON.stringify(row).includes(secretPath), false);
  assert.equal(JSON.stringify(row).includes("SESSION_COOKIE_VALUE_NEVER_OUTPUT"), false);
});

test("permission metadata separates diagnosis from credential management", () => {
  const manageServer = { permissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild } };
  const regular = statusService.getAdminCapabilities({ guild: guild(), member: manageServer, userId: "admin-1", credentialManagerRoleIds: new Set() });
  assert.equal(regular.canDiagnose, true);
  assert.equal(regular.canManageCredentials, false);

  const trusted = statusService.getAdminCapabilities({
    guild: guild(), userId: "admin-2", credentialManagerRoleIds: new Set(["trusted-role"]),
    member: { permissions: { has: () => true }, roles: { cache: [{ id: "trusted-role" }] } },
  });
  assert.equal(trusted.canViewFullStatus, true);
  assert.equal(trusted.canManageCredentials, true);
  assert.equal(trusted.credentialManagementAvailable, false);

  const owner = statusService.getAdminCapabilities({ guild: guild(), userId: "owner-1", member: { permissions: { has: () => false } } });
  assert.equal(owner.canManageCredentials, true);
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
  assert.equal(regularAdmin.canManageCredentials, false);
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
  assert.match(interaction.response.embeds[0].data.footer.text, /Refresh Session appears/);
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
  assert.match(interaction.response.embeds[0].data.footer.text, /Refresh Session appears/);
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
    rows: [{ id: "test", name: "Test", status: statusService.STATUS.unknown, explanation: "Unable to verify.", action: "Ask owner.", lastChecked: null }],
  }, { canManageCredentials: false });
  assert.equal(payload.flags, 64);
  assert.equal(payload.components[0].components[0].data.custom_id, "harmony-status:refresh");
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
