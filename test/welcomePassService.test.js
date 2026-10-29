const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-welcome-pass-service-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "welcome-pass.sqlite");

const { getDb, closeDb } = require("../src/db/sqlite");
const store = require("../src/stores/welcomePassStore");
const service = require("../src/services/welcomePassService");

getDb();

function environment({ grantMode = "automatic", hasRole = false, userId = "member-1", guildId = "welcome-guild", releaseMessage = "Approved, {member}!" } = {}) {
  const release = { id: "approved-room", sent: [], isTextBased: () => true, send: async (payload) => release.sent.push(payload) };
  const staff = { id: "staff-room", sent: [], isTextBased: () => true, send: async (payload) => staff.sent.push(payload) };
  const role = { id: "stay-role" };
  const roleIds = new Set(hasRole ? [role.id] : []);
  const member = {
    id: userId,
    displayName: "Existing STAY",
    user: { username: "existing", globalName: "Existing STAY", bot: false },
    roles: {
      cache: { has: (id) => roleIds.has(id) },
      add: async (id) => roleIds.add(id),
    },
  };
  const staffMembers = [
    { id: "staff-daph", displayName: "Daph - Chan-From-Mars", user: { username: "daph", globalName: null, bot: false } },
    { id: "staff-kris", displayName: "Kris", user: { username: "kris", globalName: null, bot: false } },
    { id: "staff-sheri", displayName: "Sheri 셰리", user: { username: "sheri", globalName: null, bot: false } },
  ];
  const members = new Map([[member.id, member], ...staffMembers.map((staff) => [staff.id, staff])]);
  const guild = {
    id: guildId,
    name: "Youtiful Stay",
    members: {
      cache: members,
      fetch: async (id) => id ? members.get(id) || null : members,
    },
    roles: { cache: new Map([[role.id, role]]), fetch: async (id) => id === role.id ? role : null },
    channels: {
      cache: new Map([[release.id, release], [staff.id, staff]]),
      fetch: async (id) => id === release.id ? release : id === staff.id ? staff : null,
    },
  };
  member.guild = guild;
  store.saveWelcomePassSettings({
    guildId,
    roleId: role.id,
    channelId: staff.id,
    releaseChannelId: release.id,
    entryChannelId: "entry-room",
    releaseMessage,
  });
  store.setWelcomePassGrantMode(guildId, grantMode);
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async (id) => id === guildId ? guild : null } };
  return { client, guild, member, staffMembers, roleIds, release, staff, userId, guildId };
}

function addApprovedLink(code, { guildId = "welcome-guild", userId = "member-1" } = {}) {
  store.recordWelcomePassApproval({ code, approverName: "Admin" });
  assert.equal(store.linkWelcomePassCode({ code, guildId, userId }).ok, true);
}

test("startup/configuration reconciliation grants pending roles without replaying member or staff welcomes", async () => {
  const env = environment({ hasRole: true, guildId: "bulk-guild" });
  addApprovedLink("YS-EXIST001", env);

  await service.assignAllApprovedWelcomePasses(env.client);
  assert.equal(env.release.sent.length, 0, "already-admitted member gets no public welcome during reconciliation");
  assert.equal(env.staff.sent.length, 0, "reconciliation sends no staff approval alert");
  assert.ok(store.getWelcomePassAssignment("YS-EXIST001").assigned_at);

  await service.assignAllApprovedWelcomePasses(env.client);
  assert.equal(env.release.sent.length, 0);
  assert.equal(env.staff.sent.length, 0);
});

test("configuration edits reconcile eligible approvals without member or staff messages", async () => {
  const env = environment({ hasRole: true, guildId: "config-reconcile-guild" });
  addApprovedLink("YS-CONFIG01", env);

  await service.updateWelcomePassSetting(env.client, env.guildId, "releaseMessage", "Updated, {member}!");
  assert.equal(env.release.sent.length, 0);
  assert.equal(env.staff.sent.length, 0);
  assert.ok(store.getWelcomePassAssignment("YS-CONFIG01").assigned_at);
});

test("a fresh automatic approval sends its public and staff messages once", async () => {
  const env = environment({ guildId: "auto-guild" });
  addApprovedLink("YS-NEWPASS1", env);

  assert.equal((await service.assignApprovedWelcomePass(env.client, "YS-NEWPASS1")).status, "assigned");
  assert.equal((await service.assignApprovedWelcomePass(env.client, "YS-NEWPASS1")).status, "already_assigned");
  assert.equal(env.release.sent.length, 1);
  assert.equal(env.release.sent[0].content, "Approved, <@member-1>!");
  assert.equal(env.staff.sent.length, 1);
  assert.ok(store.getWelcomePassAssignment("YS-NEWPASS1").assigned_at);
});

test("automatic release resolves configured staff names and only allows explicit user mentions", async () => {
  const env = environment({
    guildId: "auto-mentions-guild",
    releaseMessage: "Welcome {member}! Thank you @Daph - Chan-From-Mars, @Kris, and @Sheri 셰리. @everyone @here <@&role-id>.",
  });
  addApprovedLink("YS-AUTMENT1", env);

  await service.assignApprovedWelcomePass(env.client, "YS-AUTMENT1");

  const sent = env.release.sent[0];
  assert.equal(sent.content, "Welcome <@member-1>! Thank you <@staff-daph>, <@staff-kris>, and <@staff-sheri>. @everyone @here <@&role-id>.");
  assert.deepEqual(sent.allowedMentions, { parse: [], users: ["member-1", "staff-daph", "staff-kris", "staff-sheri"] });
});

test("an ambiguous Discord send result is not retried into a duplicate welcome", async () => {
  const env = environment({ guildId: "ambiguous-send-guild" });
  addApprovedLink("YS-UNCERT01", env);
  env.release.send = async (payload) => {
    env.release.sent.push(payload);
    throw new Error("simulated acknowledgement lost after Discord accepted the message");
  };

  await assert.rejects(service.assignApprovedWelcomePass(env.client, "YS-UNCERT01"), /acknowledgement lost/);
  assert.equal((await service.assignApprovedWelcomePass(env.client, "YS-UNCERT01")).status, "already_assigned");
  assert.equal(env.release.sent.length, 1);
  assert.equal(env.staff.sent.length, 0);
});

test("manual role completion requires a pending approved link and records it before announcing", async () => {
  const env = environment({ grantMode: "manual", hasRole: true, guildId: "manual-guild" });
  addApprovedLink("YS-MANUAL01", env);
  const oldMember = { ...env.member, roles: { cache: { has: () => false } } };
  const newMember = env.member;

  assert.equal((await service.handleManualWelcomePassRoleAdded(oldMember, newMember)).status, "manual_release_sent");
  assert.equal((await service.handleManualWelcomePassRoleAdded(oldMember, newMember)).status, "no_pending_approval");
  assert.equal(env.release.sent.length, 1);
  assert.equal(env.staff.sent.length, 1);
  assert.ok(store.getWelcomePassAssignment("YS-MANUAL01").assigned_at);
});

test("manual release uses the same safe configured staff mention behavior", async () => {
  const env = environment({
    grantMode: "manual",
    hasRole: true,
    guildId: "manual-mentions-guild",
    releaseMessage: "Welcome {member} and @Daph - Chan-From-Mars! @everyone @here <@&role-id>",
  });
  addApprovedLink("YS-MANMENT1", env);
  const oldMember = { ...env.member, roles: { cache: { has: () => false } } };

  await service.handleManualWelcomePassRoleAdded(oldMember, env.member);

  const sent = env.release.sent[0];
  assert.equal(sent.content, "Welcome <@member-1> and <@staff-daph>! @everyone @here <@&role-id>");
  assert.deepEqual(sent.allowedMentions, { parse: [], users: ["member-1", "staff-daph"] });
});

test("manual STAY-role changes without a pending Welcome Pass approval do not announce", async () => {
  const env = environment({ grantMode: "manual", hasRole: true, guildId: "unlinked-manual-guild" });
  const oldMember = { ...env.member, roles: { cache: { has: () => false } } };

  assert.equal((await service.handleManualWelcomePassRoleAdded(oldMember, env.member)).status, "no_pending_approval");
  assert.equal(env.release.sent.length, 0);
  assert.equal(env.staff.sent.length, 0);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
