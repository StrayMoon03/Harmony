const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-welcome-pass-server-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "welcome-pass.sqlite");
process.env.WELCOME_PASS_SHARED_SECRET = "test-welcome-pass-secret";
process.env.PORT = "0";

const { closeDb, getDb } = require("../src/db/sqlite");
const welcomePassStore = require("../src/stores/welcomePassStore");
const { saveMemberCountStaffRole } = require("../src/stores/memberCountStore");
const birthdayStore = require("../src/stores/birthdayStore");
const { startWelcomePassServer } = require("../src/services/welcomePassServer");

getDb();

function makeEnvironment(guildId = "welcome-review-guild") {
  getDb().exec("DELETE FROM welcome_pass_submission_alerts; DELETE FROM welcome_pass_links; DELETE FROM welcome_pass_approvals; DELETE FROM welcome_pass_settings;");
  const sent = [];
  const review = {
    id: "review-room",
    isTextBased: () => true,
    send: async (payload) => {
      const message = { id: `message-${sent.length + 1}` };
      sent.push({ ...payload, message });
      return message;
    },
  };
  const approved = {
    id: "approved-room",
    isTextBased: () => true,
    send: async (payload) => {
      const message = { id: `approved-${sent.length + 1}` };
      sent.push({ ...payload, message });
      return message;
    },
  };
  const role = { id: "stay-role" };
  let roleGrants = 0;
  const member = {
    id: "discord-member-1",
    displayName: "Member One",
    user: { username: "member.one", globalName: "Member One", bot: false },
    roles: {
      cache: { has: () => false },
      add: async () => { roleGrants += 1; },
    },
  };
  const members = new Map([[member.id, member]]);
  const guild = {
    id: guildId,
    name: "Youtiful STAY",
    members: {
      cache: members,
      fetch: async (id) => id ? members.get(typeof id === "object" ? id.user : id) || null : members,
      list: async () => members,
    },
    roles: {
      cache: new Map([[role.id, role]]),
      fetch: async (id) => id === role.id ? role : null,
    },
    channels: {
      cache: new Map([[review.id, review], [approved.id, approved]]),
      fetch: async (id) => id === review.id ? review : id === approved.id ? approved : null,
    },
  };
  welcomePassStore.saveWelcomePassSettings({
    guildId,
    roleId: role.id,
    channelId: review.id,
    releaseChannelId: approved.id,
    entryChannelId: "entry-room",
    releaseMessage: "Welcome {member}!",
  });
  const client = {
    guilds: {
      cache: new Map([[guildId, guild]]),
      fetch: async (id) => id === guildId ? guild : null,
    },
  };
  return { client, guild, member, sent, review, approved, get roleGrants() { return roleGrants; } };
}

async function startServer(client) {
  const server = startWelcomePassServer(client);
  await once(server, "listening");
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function post(baseUrl, pathname, payload, token = process.env.WELCOME_PASS_SHARED_SECRET) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const submittedPayload = (reference = "YS-SUBMIT01", discordUsername = "member.one") => ({
  reference,
  discordUsername,
  facebookName: "Facebook Person",
  submittedAt: "2026-10-29T15:30:00.000Z",
});

test("authenticated submission alerts review room before any approval or role/public welcome", async (t) => {
  const env = makeEnvironment("submission-only-guild");
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/submitted", submittedPayload());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "notified");
  assert.equal(env.sent.length, 1);
  assert.match(env.sent[0].content, /📌 \*\*Welcome Pass Ready for Review!\*\*/);
  assert.ok(env.sent[0].content.includes("<@discord-member-1>"));
  assert.ok(env.sent[0].content.includes("**Facebook:** Facebook Person"));
  assert.ok(env.sent[0].content.includes("<t:1793287800:F>"));
  assert.equal(env.sent[0].allowedMentions.users[0], env.member.id);
  assert.equal(welcomePassStore.getWelcomePassAssignment("YS-SUBMIT01"), null, "submission is not stored as approval");
  assert.equal(welcomePassStore.getPendingWelcomePassAssignmentForMember(env.guild.id, env.member.id), null);
  assert.equal(env.member.roles.cache.has("stay-role"), false);
  assert.equal(env.roleGrants, 0);
  assert.equal(welcomePassStore.getWelcomePassSubmissionAlert("YS-SUBMIT01").delivered_at !== null, true);
  assert.equal(env.sent.some((item) => item.content.includes("Welcome <@")), false);
});

test("duplicate submission callback is idempotent and sends only one review alert", async (t) => {
  const env = makeEnvironment("submission-dedupe-guild");
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  assert.equal((await post(baseUrl, "/welcome-pass/submitted", submittedPayload("YS-DUPLIC01"))).status, 200);
  const retry = await post(baseUrl, "/welcome-pass/submitted", submittedPayload("YS-DUPLIC01"));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).status, "already_notified");
  assert.equal(env.sent.length, 1);
});

test("unresolved Discord username still creates a useful staff alert without a mention", async (t) => {
  const env = makeEnvironment("submission-unmatched-guild");
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/submitted", submittedPayload("YS-UNMATC01", "unknown.stay"));
  assert.equal(response.status, 200);
  assert.equal(env.sent.length, 1);
  assert.ok(env.sent[0].content.includes("@unknown.stay"));
  assert.deepEqual(env.sent[0].allowedMentions, { parse: [] });
});

test("submission endpoint rejects invalid authentication and malformed fields", async (t) => {
  const env = makeEnvironment("submission-validation-guild");
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  assert.equal((await post(baseUrl, "/welcome-pass/submitted", submittedPayload(), "wrong-secret")).status, 401);
  assert.equal((await post(baseUrl, "/welcome-pass/submitted", { ...submittedPayload(), facebookName: "" })).status, 400);
  assert.equal((await post(baseUrl, "/welcome-pass/submitted", { ...submittedPayload(), submittedAt: "yesterday" })).status, 400);
  assert.equal(env.sent.length, 0);
});

test("submission endpoint rejects oversized payloads", async (t) => {
  const env = makeEnvironment("submission-size-guild");
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/submitted", JSON.stringify({ ...submittedPayload(), extra: "x".repeat(17_000) }));
  assert.equal(response.status, 413);
  assert.equal(env.sent.length, 0);
});

test("existing approval callback continues to link, grant STAY, and publish approval welcome", async (t) => {
  const env = makeEnvironment("approval-still-works-guild");
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/approved", {
    code: "YS-APPROVE1",
    approverName: "Review Admin",
    discordUsername: env.member.user.username,
    birthdayOptIn: false,
  });
  assert.equal(response.status, 200);
  assert.equal(env.sent.length, 2);
  assert.equal(env.roleGrants, 1);
  assert.ok(env.sent.some((item) => item.content === "Welcome <@discord-member-1>!"));
  assert.ok(env.sent.some((item) => item.content.includes("Welcome Pass approved — STAY role granted")));
  assert.ok(welcomePassStore.getWelcomePassAssignment("YS-APPROVE1").approved_at);
  assert.equal(welcomePassStore.getWelcomePassSubmissionAlert("YS-APPROVE1"), null);
});

test("Welcome Pass bias is stored for a member who declined birthday announcements", async (t) => {
  const env = makeEnvironment("bias-independent-of-birthday-guild");
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/approved", {
    code: "YS-BIASOPT1",
    approverName: "Review Admin",
    discordUsername: env.member.user.username,
    birthdayOptIn: false,
    birthdayBiases: ["Han", "Felix"],
  });
  assert.equal(response.status, 200);
  const profile = birthdayStore.getBirthdayProfile(env.guild.id, env.member.id);
  assert.equal(profile.celebration_enabled, 0);
  assert.equal(profile.birthday_mmdd, null);
  assert.deepEqual(JSON.parse(profile.biases_json), ["Han", "Felix"]);
  assert.equal(profile.bias, "Han, Felix");
  assert.equal(env.roleGrants, 1, "the regular STAY role still grants as before");
});


test("approval can uniquely match Discord global name", async (t) => {
  const env = makeEnvironment("approval-global-name-guild");
  env.member.user.username = "different.username";
  env.member.user.globalName = "Tokki";
  env.member.displayName = "Different Display";
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/approved", {
    code: "YS-GLOBAL01",
    approverName: "Review Admin",
    discordUsername: "@TOKKI",
    birthdayOptIn: false,
  });
  assert.equal(response.status, 200);
  assert.equal(env.roleGrants, 1);
  assert.ok(env.sent.some((item) => item.content.includes("<@discord-member-1>")));
});

test("approval can uniquely match Discord display name", async (t) => {
  const env = makeEnvironment("approval-display-name-guild");
  env.member.user.username = "different.username";
  env.member.user.globalName = "Different Global";
  env.member.displayName = "Tokki";
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/approved", {
    code: "YS-DISPLY01",
    approverName: "Review Admin",
    discordUsername: "tokki",
    birthdayOptIn: false,
  });
  assert.equal(response.status, 200);
  assert.equal(env.roleGrants, 1);
});

test("release message without a member token gets a safe member greeting prepended", async (t) => {
  const env = makeEnvironment("approval-release-fallback-guild");
  welcomePassStore.updateWelcomePassSetting(env.guild.id, "releaseMessage", "This is our main channel!! Please check out the rules.");
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/approved", {
    code: "YS-RELEASE1",
    approverName: "Review Admin",
    discordUsername: env.member.user.username,
    birthdayOptIn: false,
  });
  assert.equal(response.status, 200);
  const release = env.sent.find((item) => item.content.includes("This is our main channel!!"));
  assert.ok(release);
  assert.equal(release.content, "Welcome <@discord-member-1>!\n\nThis is our main channel!! Please check out the rules.");
  assert.deepEqual(release.allowedMentions, { parse: [], users: ["discord-member-1"] });
});

test("staff confirmation distinguishes a member who already had STAY", async (t) => {
  const env = makeEnvironment("approval-existing-stay-guild");
  env.member.roles.cache.has = () => true;
  const { server, baseUrl } = await startServer(env.client);
  t.after(() => server.close());

  const response = await post(baseUrl, "/welcome-pass/approved", {
    code: "YS-HADSTAY1",
    approverName: "Review Admin",
    discordUsername: env.member.user.username,
    birthdayOptIn: false,
  });
  assert.equal(response.status, 200);
  assert.equal(env.roleGrants, 0);
  assert.ok(env.sent.some((item) => item.content.includes("member already had STAY")));
});


function numericMember(env) {
  env.guild.members.cache.clear();
  env.member.id = "1005965496505602139";
  env.member.user.username = "gothicbfly";
  env.guild.members.cache.set(env.member.id, env.member);
  return env.member.id;
}
test("matched submission then explicit approval is recorded, grants role and acknowledges; retries never replay admission", async (t) => {
  const env = makeEnvironment("full-approval-pipeline");
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  await post(baseUrl, "/welcome-pass/submitted", submittedPayload("YS-PIPE0001"));
  assert.equal(env.roleGrants, 0);
  const payload = { code: "YS-PIPE0001", discordUsername: env.member.user.username, approverName: "Kris" };
  const first = await post(baseUrl, "/welcome-pass/approved", payload);
  assert.equal(first.status, 200); assert.equal((await first.json()).recorded, true);
  const count = env.sent.length;
  const retry = await post(baseUrl, "/welcome-pass/approved", payload);
  assert.equal((await retry.json()).status, "already_assigned");
  assert.equal(env.sent.length, count); assert.equal(env.roleGrants, 1);
});
test("admin selection validates current membership without approving; corrected explicit approval uses member ID", async (t) => {
  const env = makeEnvironment("correct-member-pipeline"); const userId = numericMember(env);
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const body = { code: "YS-CORRECT1", userId };
  const selected = await post(baseUrl, "/welcome-pass/member", body);
  assert.equal(selected.status, 200); assert.equal((await selected.json()).userId, userId);
  assert.equal(welcomePassStore.getWelcomePassAssignment(body.code), null); assert.equal(env.roleGrants, 0); assert.equal(env.sent.length, 0);
  const approved = await post(baseUrl, "/welcome-pass/approved", { code: body.code, discordUsername: "TracieNew", discordMemberId: userId });
  assert.equal(approved.status, 200); assert.equal((await approved.json()).matchStatus, "admin_selected"); assert.equal(env.roleGrants, 1);
  assert.equal(welcomePassStore.getWelcomePassAssignment(body.code).user_id, userId);
});
test("leaving before correction/save or approval fails safely; bots and conflicting active/completed passes rejected", async (t) => {
  const env = makeEnvironment("selection-safety"); const userId = numericMember(env);
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const body = { code: "YS-SAFETY01", userId };
  env.guild.members.cache.clear();
  assert.equal((await post(baseUrl, "/welcome-pass/member", body)).status, 409);
  assert.equal((await post(baseUrl, "/welcome-pass/approved", { code: body.code, discordMemberId: userId })).status, 409);
  assert.equal(welcomePassStore.getWelcomePassAssignment(body.code), null);
  env.guild.members.cache.set(userId, env.member); env.member.user.bot = true;
  assert.equal((await post(baseUrl, "/welcome-pass/member", body)).status, 409); env.member.user.bot = false;
  welcomePassStore.linkWelcomePassCode({ code: "YS-OTHER001", guildId: env.guild.id, userId });
  assert.equal((await post(baseUrl, "/welcome-pass/member", body)).status, 409);
  welcomePassStore.markWelcomePassAssigned("YS-OTHER001");
  assert.equal((await post(baseUrl, "/welcome-pass/approved", { code: body.code, discordMemberId: userId })).status, 409);
  assert.equal(env.roleGrants, 0);
});
test("member endpoints require bridge authentication; roster pagination excludes bots/STAY without exposing other member data", async (t) => {
  const env = makeEnvironment("roster-pagination"); numericMember(env);
  let options;
  const page = new Map(Array.from({ length: 100 }, (_, index) => {
    const id = String(1005965496505602100n + BigInt(index)); return [id, { id, user: { username: "stay" + index, bot: index === 1, privateEmail: "never expose" }, roles: { cache: new Set(index === 2 ? ["stay-role"] : []) }, displayName: "STAY " + index }];
  }));
  env.guild.members.list = async (value) => { options = value; return value.after ? new Map() : page; };
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  assert.equal((await post(baseUrl, "/welcome-pass/members", {}, "wrong")).status, 401);
  assert.equal((await post(baseUrl, "/welcome-pass/member", { code: "YS-PAGING01", userId: env.member.id }, "wrong")).status, 401);
  const result = await (await post(baseUrl, "/welcome-pass/members", {})).json();
  assert.equal(result.members.length, 98); assert.equal(result.after, [...page.keys()].at(-1)); assert.equal(options.limit, 100); assert.doesNotMatch(JSON.stringify(result), /privateEmail|never expose/);
  const next = await (await post(baseUrl, "/welcome-pass/members", { after: result.after })).json();
  assert.equal(options.after, result.after); assert.equal(next.after, null);
});

test("normal picker excludes each configured STAY/Admin/Moderator role and every combination, not names or pass status", async (t) => {
  const env = makeEnvironment("picker-actual-roles");
  saveMemberCountStaffRole(env.guild.id, "admin", "topline");
  saveMemberCountStaffRole(env.guild.id, "moderator", "skijigi");
  const make = (index, roles, bot = false) => {
    const id = String(1005965496505602100n + BigInt(index));
    return { id, user: { username: "member" + index, bot }, displayName: "Member " + index, roles: { cache: new Set(roles) } };
  };
  const human = make(0, []);
  const roleSets = [["stay-role"], ["topline"], ["skijigi"], ["stay-role", "topline"], ["stay-role", "skijigi"], ["topline", "skijigi"], ["stay-role", "topline", "skijigi"]];
  const excluded = roleSets.map((roles, i) => make(i + 1, roles));
  const bot = make(8, [], true), stayBot = make(9, ["stay-role"], true);
  const unrelated = make(10, ["other-role"]);
  const roster = new Map([human, ...excluded, bot, stayBot, unrelated].map((m) => [m.id, m]));
  env.guild.members.list = async () => roster;
  // Historical pass status must not replace actual Discord role eligibility.
  welcomePassStore.recordWelcomePassApproval({ code: "YS-OLDROLE1", approverName: "Admin" });
  welcomePassStore.linkWelcomePassCode({ code: "YS-OLDROLE1", guildId: env.guild.id, userId: human.id });
  welcomePassStore.markWelcomePassAssigned("YS-OLDROLE1");
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const list = async () => (await (await post(baseUrl, "/welcome-pass/members", {})).json()).members.map((m) => m.id);
  assert.deepEqual(await list(), [human.id, unrelated.id]);
  human.roles.cache.add("stay-role"); excluded[0].roles.cache.delete("stay-role");
  assert.deepEqual(await list(), [excluded[0].id, unrelated.id]);
  // Read persisted configuration for each request, rather than stale IDs/names.
  saveMemberCountStaffRole(env.guild.id, "admin", "new-admin-role");
  unrelated.roles.cache.add("new-admin-role");
  assert.deepEqual(await list(), [excluded[0].id, excluded[1].id]);
  assert.equal(env.roleGrants, 0); assert.equal(env.sent.length, 0);
});

test("a fully filtered page retains the raw Discord cursor so eligible members on the next page remain reachable", async (t) => {
  const env = makeEnvironment("picker-filtered-page");
  saveMemberCountStaffRole(env.guild.id, "admin", "topline");
  saveMemberCountStaffRole(env.guild.id, "moderator", "skijigi");
  const page = new Map(Array.from({ length: 100 }, (_, index) => {
    const id = String(1005965496505602100n + BigInt(index));
    return [id, { id, user: { username: "stay" + index, bot: false }, roles: { cache: new Set([index % 3 === 0 ? "stay-role" : index % 3 === 1 ? "topline" : "skijigi"]) } }];
  }));
  const nextId = "450767834574880778";
  env.guild.members.list = async ({ after }) => after ? new Map([[nextId, { id: nextId, user: { username: "tracienew2714", bot: false }, roles: { cache: new Set() } }]]) : page;
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const first = await (await post(baseUrl, "/welcome-pass/members", {})).json();
  assert.deepEqual(first.members, []); assert.equal(first.after, [...page.keys()].at(-1));
  const next = await (await post(baseUrl, "/welcome-pass/members", { after: first.after })).json();
  assert.equal(next.members[0].id, nextId); assert.equal(next.after, null);
});

test("missing/deleted Approved Role fails closed rather than returning an unfiltered roster", async (t) => {
  const env = makeEnvironment("picker-missing-role"); let listed = false;
  env.guild.roles.fetch = async () => null;
  env.guild.members.list = async () => { listed = true; return env.guild.members.cache; };
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const result = await post(baseUrl, "/welcome-pass/members", {});
  assert.equal(result.status, 500); assert.equal((await result.json()).error, "internal_error");
  assert.equal(listed, false); assert.equal(env.roleGrants, 0); assert.equal(env.sent.length, 0);
});
test("role failure does not return success and retry grants once; concurrent callbacks cannot duplicate role operations", async (t) => {
  const env = makeEnvironment("role-failure-retry");
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const add = env.member.roles.add; env.member.roles.add = async () => { throw new Error("Discord unavailable"); };
  const payload = { code: "YS-RETRY001", discordUsername: env.member.user.username };
  assert.equal((await post(baseUrl, "/welcome-pass/approved", payload)).status, 500); assert.equal(env.sent.length, 0);
  env.member.roles.add = add;
  const replies = await Promise.all([post(baseUrl, "/welcome-pass/approved", payload), post(baseUrl, "/welcome-pass/approved", payload)]);
  assert.ok(replies.some((reply) => reply.status === 200)); assert.equal(env.roleGrants, 1); assert.equal(env.sent.length, 2);
});
test("missing configured role returns a real private failure, not approval success", async (t) => {
  const env = makeEnvironment("role-missing-failure"); env.guild.roles.cache.clear(); env.guild.roles.fetch = async () => null;
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const response = await post(baseUrl, "/welcome-pass/approved", { code: "YS-MISSING1", discordUsername: env.member.user.username });
  assert.equal(response.status, 503); const body = await response.json(); assert.equal(body.ok, false); assert.equal(body.status, "role_missing");
});
test("invalid bias cannot persist approval before validation", async (t) => {
  const env = makeEnvironment("approval-field-validation");
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const response = await post(baseUrl, "/welcome-pass/approved", { code: "YS-INVALID1", biases: ["not-a-member"] });
  assert.equal(response.status, 400); assert.equal(welcomePassStore.getWelcomePassAssignment("YS-INVALID1"), null);
});
test("unmatched alert gives the approved admin-correction instructions and self-service fallback", async (t) => {
  const env = makeEnvironment("match-instructions");
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const response = await post(baseUrl, "/welcome-pass/approved", { code: "YS-NOMATCH1", discordUsername: "TracieNew" });
  assert.equal(response.status, 202); assert.equal((await response.json()).recorded, true);
  assert.match(env.sent[0].content, /Discord Member Match Needed/); assert.match(env.sent[0].content, /select the correct Discord member before approving/); assert.match(env.sent[0].content, /harmony-pass/); assert.equal(env.roleGrants, 0);
});
test("harmony-pass confirmation-code fallback still links and admits a previously unmatched approved pass", async (t) => {
  const env = makeEnvironment("self-service-fallback"); const code = "YS-SELFS001";
  welcomePassStore.recordWelcomePassApproval({ code, approverName: "Kris" });
  const command = require("../src/commands/linkWelcomePass"); const replies = [];
  await command.execute({ guild: env.guild, user: env.member.user, client: env.client, options: { getString: () => code }, deferReply: async () => {}, editReply: async (reply) => replies.push(reply),
    user: { ...env.member.user, id: env.member.id } });
  assert.equal(env.roleGrants, 1); assert.match(replies[0], /all set/);
});

test("departure archives a completed link without role/messages; returning new code admits without restoring history", async (t) => {
  const env = makeEnvironment("departure-new-pass"); const userId = numericMember(env);
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const original = { code: "YS-OLDHIST1", discordUsername: env.member.user.username, approverName: "Original admin" };
  assert.equal((await post(baseUrl, "/welcome-pass/approved", original)).status, 200);
  const old = welcomePassStore.getWelcomePassAssignment(original.code);
  const counts = { roles: env.roleGrants, messages: env.sent.length };
  assert.equal((await post(baseUrl, "/welcome-pass/departed", { code: original.code }, "wrong")).status, 401);
  const first = await post(baseUrl, "/welcome-pass/departed", { code: original.code });
  assert.equal(first.status, 200); assert.equal((await first.json()).recorded, true);
  const archived = welcomePassStore.getWelcomePassAssignment(original.code);
  assert.equal(archived.user_id, userId); assert.equal(archived.assigned_at, old.assigned_at); assert.equal(archived.approved_at, old.approved_at); assert.equal(archived.approver_name, old.approver_name); assert.ok(archived.departed_at);
  assert.equal(env.roleGrants, counts.roles); assert.equal(env.sent.length, counts.messages);
  await post(baseUrl, "/welcome-pass/departed", { code: original.code });
  assert.deepEqual(welcomePassStore.getWelcomePassAssignment(original.code), archived);
  assert.equal((await post(baseUrl, "/welcome-pass/approved", original)).status, 410);
  assert.equal(welcomePassStore.linkWelcomePassCode({ code: original.code, guildId: env.guild.id, userId }).reason, "departed");
  const newer = { ...original, code: "YS-NEWHIST1", discordMemberId: userId };
  assert.equal((await post(baseUrl, "/welcome-pass/approved", newer)).status, 200);
  assert.equal(welcomePassStore.getWelcomePassAssignment(newer.code).user_id, userId);
  assert.deepEqual(welcomePassStore.getWelcomePassAssignment(original.code), archived);
  assert.equal(welcomePassStore.listPendingWelcomePassApprovals().some((entry) => entry.code === original.code), false);
});
test("archived pending and never-linked passes cannot be linked/granted on startup or late callbacks", async (t) => {
  const env = makeEnvironment("departed-unlinked");
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const code = "YS-PENDHIS1"; welcomePassStore.recordWelcomePassApproval({ code, approverName: "Admin" });
  assert.equal((await post(baseUrl, "/welcome-pass/departed", { code })).status, 200);
  const service = require("../src/services/welcomePassService");
  await service.assignAllApprovedWelcomePasses(env.client);
  assert.equal((await service.assignApprovedWelcomePass(env.client, code)).status, "departed");
  assert.equal(env.roleGrants, 0); assert.equal(env.sent.length, 0);
});

test("strict exact-ID staff admission/recovery remains available while normal roster excludes the target", async (t) => {
  const env = makeEnvironment("strict-selected-admission"); const userId = numericMember(env);
  saveMemberCountStaffRole(env.guild.id, "admin", "topline");
  saveMemberCountStaffRole(env.guild.id, "moderator", "skijigi");
  const roles = new Set(["topline", "skijigi"]); env.member.roles.cache = roles;
  const add = env.member.roles.add; env.member.roles.add = async (role) => { await add(role); roles.add(role.id); };
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const payload = { code: "YS-STRICT01", discordMemberId: userId, discordUsername: "wrong-original-name", requireAdmission: true };
  assert.deepEqual((await (await post(baseUrl, "/welcome-pass/members", {})).json()).members, []);
  assert.equal((await (await post(baseUrl, "/welcome-pass/member", { code: payload.code, userId })).json()).ok, true);
  const first = await post(baseUrl, "/welcome-pass/approved", payload);
  assert.equal(first.status, 200); const result = await first.json(); assert.equal(result.admitted, true);
  assert.deepEqual(result.discordMember, { id: userId, username: env.member.user.username, guildId: env.guild.id });
  assert.equal(welcomePassStore.getWelcomePassAssignment(payload.code).user_id, userId);
  const sent = env.sent.length;
  assert.ok(roles.has("stay-role"));
  assert.deepEqual((await (await post(baseUrl, "/welcome-pass/members", {})).json()).members, []);
  assert.equal((await (await post(baseUrl, "/welcome-pass/member", { code: payload.code, userId })).json()).ok, true);
  const recovered = await post(baseUrl, "/welcome-pass/approved", payload);
  assert.equal(recovered.status, 200);
  const recoveredBody = await recovered.json();
  assert.equal(recoveredBody.admitted, true);
  assert.equal(recoveredBody.discordMember.id, userId);
  assert.equal(env.roleGrants, 1); assert.equal(env.sent.length, sent);
  roles.clear();
  const missing = await post(baseUrl, "/welcome-pass/approved", payload);
  assert.equal(missing.status, 409); assert.notEqual((await missing.json()).admitted, true);
  assert.equal(env.roleGrants, 1); assert.equal(env.sent.length, sent);
});

test("strict manual-mode or invalid selected admission never acknowledges or records a new approval", async (t) => {
  const env = makeEnvironment("strict-manual-mode"); const userId = numericMember(env);
  welcomePassStore.setWelcomePassGrantMode(env.guild.id, "manual");
  const { server, baseUrl } = await startServer(env.client); t.after(() => server.close());
  const code = "YS-MANUAL01";
  const manual = await post(baseUrl, "/welcome-pass/approved", { code, discordMemberId: userId, requireAdmission: true });
  assert.equal(manual.status, 409); assert.equal((await manual.json()).error, "manual_role_required");
  assert.equal(welcomePassStore.getWelcomePassAssignment(code), null);
  assert.equal((await post(baseUrl, "/welcome-pass/approved", { code, requireAdmission: true })).status, 400);
  assert.equal(env.roleGrants, 0); assert.equal(env.sent.length, 0);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
