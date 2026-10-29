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
      fetch: async (id) => id ? members.get(id) || null : members,
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

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
