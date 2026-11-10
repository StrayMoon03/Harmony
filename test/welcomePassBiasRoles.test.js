const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-bias-role-test-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "bias.sqlite");
const { closeDb, getDb } = require("../src/db/sqlite");
const birthdayStore = require("../src/stores/birthdayStore");
const welcomePassStore = require("../src/stores/welcomePassStore");
const { syncMemberBiasRoles, reconcileGuildBiasRoles } = require("../src/services/welcomePassBiasRoleService");
const welcomePassService = require("../src/services/welcomePassService");

getDb();

function makeMember(guild, id, initial = []) {
  const assigned = new Set(initial);
  const member = {
    id,
    guild,
    user: { username: id, globalName: id, bot: false },
    displayName: id,
    roles: {
      cache: { has: (roleId) => assigned.has(roleId) },
      add: async (role) => assigned.add(typeof role === "string" ? role : role.id),
      remove: async (role) => assigned.delete(typeof role === "string" ? role : role.id),
    },
    assigned,
  };
  return member;
}

function makeGuild(id, roleList) {
  const roles = new Map(roleList.map((role) => [role.id, role]));
  const members = new Map();
  const guild = {
    id,
    roles: { cache: roles, fetch: async (roleId) => roles.get(roleId) || null },
    members: { cache: members, fetch: async (memberId) => memberId ? members.get(memberId) || null : members },
    channels: { cache: new Map(), fetch: async () => null },
  };
  return { guild, members };
}

test("bias role sync adds selected roles, removes only old mapped roles, and preserves unrelated roles", async () => {
  const guildId = `bias-sync-${Date.now()}`;
  const { guild, members } = makeGuild(guildId, [
    { id: "role-han", editable: true }, { id: "role-felix", editable: true }, { id: "role-ot8", editable: true },
  ]);
  welcomePassStore.setWelcomePassBiasRole(guildId, "Han", "role-han");
  welcomePassStore.setWelcomePassBiasRole(guildId, "Felix", "role-felix");
  welcomePassStore.setWelcomePassBiasRole(guildId, "OT8", "role-ot8");
  birthdayStore.setMemberBiases(guildId, "member-1", ["Han", "Felix"]);
  const member = makeMember(guild, "member-1", ["unrelated-role"]);
  members.set(member.id, member);

  const first = await syncMemberBiasRoles(member);
  assert.equal(first.status, "synced");
  assert.ok(member.assigned.has("role-han"));
  assert.ok(member.assigned.has("role-felix"));
  assert.ok(member.assigned.has("unrelated-role"));

  birthdayStore.setMemberBiases(guildId, member.id, ["OT8"]);
  const second = await syncMemberBiasRoles(member);
  assert.equal(second.status, "synced");
  assert.ok(!member.assigned.has("role-han"));
  assert.ok(!member.assigned.has("role-felix"));
  assert.ok(member.assigned.has("role-ot8"));
  assert.ok(member.assigned.has("unrelated-role"));
});

test("unconfigured or unmanageable bias roles report issues without throwing", async () => {
  const guildId = `bias-partial-${Date.now()}`;
  const { guild } = makeGuild(guildId, [{ id: "role-han", editable: false }]);
  welcomePassStore.setWelcomePassBiasRole(guildId, "Han", "role-han");
  birthdayStore.setMemberBiases(guildId, "member-2", ["Han", "Bang Chan"]);
  const member = makeMember(guild, "member-2");
  const result = await syncMemberBiasRoles(member);
  assert.equal(result.status, "partial");
  assert.ok(result.issues.includes("role_unavailable:Han") || result.issues.includes("role_unmanageable:Han"));
  assert.ok(result.issues.includes("role_not_configured:Bang Chan"));
  assert.equal(member.assigned.has("role-han"), false);
});

test("Still deciding is a valid no-role selection", async () => {
  const guildId = `bias-undecided-${Date.now()}`;
  const { guild } = makeGuild(guildId, []);
  birthdayStore.setMemberBiases(guildId, "member-undecided", ["Still deciding"]);
  const member = makeMember(guild, "member-undecided", ["unrelated-role"]);
  const result = await syncMemberBiasRoles(member);
  assert.equal(result.status, "synced");
  assert.deepEqual(result.issues, []);
  assert.deepEqual([...member.assigned], ["unrelated-role"]);
});

test("explicit reconciliation backfills existing member profiles without Welcome Pass resubmission", async () => {
  const guildId = `bias-reconcile-${Date.now()}`;
  const { guild, members } = makeGuild(guildId, [{ id: "role-seungmin", editable: true }]);
  welcomePassStore.setWelcomePassBiasRole(guildId, "Seungmin", "role-seungmin");
  birthdayStore.setMemberBiases(guildId, "existing-member", ["Seungmin"]);
  const member = makeMember(guild, "existing-member");
  members.set(member.id, member);
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };

  const result = await reconcileGuildBiasRoles(client, guildId);
  assert.equal(result.status, "complete");
  assert.equal(result.processed, 1);
  assert.equal(result.added, 1);
  assert.ok(member.assigned.has("role-seungmin"));
  assert.equal((await reconcileGuildBiasRoles(client, guildId)).added, 0);
});

test("missing bias-role mapping does not interrupt automatic STAY admission", async () => {
  const guildId = `bias-stay-${Date.now()}`;
  const stayRole = { id: "stay-role" };
  const roleIds = new Set();
  const member = {
    id: "new-member", guild: null, user: { username: "new-member", globalName: "New Member", bot: false }, displayName: "New Member",
    roles: { cache: { has: (id) => roleIds.has(id) }, add: async (role) => roleIds.add(role.id), remove: async (role) => roleIds.delete(role.id) },
  };
  const release = { isTextBased: () => true, send: async () => ({ id: "release" }) };
  const staff = { isTextBased: () => true, send: async () => ({ id: "staff" }) };
  const guild = {
    id: guildId, name: "Guild", members: { cache: new Map([[member.id, member]]), fetch: async (id) => id ? member : new Map([[member.id, member]]) },
    roles: { cache: new Map([[stayRole.id, stayRole]]), fetch: async () => stayRole },
    channels: { cache: new Map([["release", release], ["staff", staff]]), fetch: async (id) => id === "release" ? release : staff },
  };
  member.guild = guild;
  welcomePassStore.saveWelcomePassSettings({ guildId, roleId: stayRole.id, channelId: "staff", releaseChannelId: "release", entryChannelId: "entry", releaseMessage: "Welcome {member}" });
  welcomePassStore.recordWelcomePassApproval({ code: "YS-BIAS001", approverName: "Admin" });
  welcomePassStore.linkWelcomePassCode({ code: "YS-BIAS001", guildId, userId: member.id });
  birthdayStore.saveWelcomePassBirthdayProfile({ code: "YS-BIAS001", celebrationEnabled: false, discordUsername: "new-member", biases: ["Han"] });
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };

  const result = await welcomePassService.assignApprovedWelcomePass(client, "YS-BIAS001");
  assert.equal(result.status, "assigned");
  assert.ok(roleIds.has(stayRole.id));
  assert.equal(welcomePassStore.getWelcomePassAssignment("YS-BIAS001").assigned_at != null, true);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
