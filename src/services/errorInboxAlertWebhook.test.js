const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-error-alert-webhook-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "error-alert.sqlite");
delete process.env.HARMONY_ERROR_GITHUB_TOKEN;
delete process.env.HARMONY_ERROR_GITHUB_REPO;
delete process.env.HARMONY_ERROR_WEBHOOK_URL;
delete process.env.HARMONY_ERROR_WEBHOOK_KEY;

const { getDb, closeDb } = require("../db/sqlite");
const { saveErrorInboxSettings } = require("../stores/errorInboxStore");
const { logMediaError } = require("./errorInboxService");

getDb();
saveErrorInboxSettings("guild-1", "inbox-1");

function messageFixture({ id = "msg-1", content = "see https://www.instagram.com/reel/abc123/?igsh=SECRET" } = {}) {
  const sent = [];
  const inbox = {
    id: "inbox-1",
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return { id: `inbox-${sent.length}` };
    },
  };
  const guild = {
    id: "guild-1",
    name: "Harmony Errors",
    channels: {
      cache: new Map([["inbox-1", inbox]]),
      fetch: async () => inbox,
    },
  };
  const client = {
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: async () => guild,
    },
  };
  return {
    sent,
    message: {
      id,
      content,
      client,
      guild,
      channelId: "source-1",
      channel: { name: "shares" },
      member: { displayName: "Member" },
      author: { username: "member" },
      url: "https://discord.com/channels/guild-1/source-1/msg-1",
    },
  };
}

test("logMediaError posts to the webhook after a successful inbox send", async () => {
  const originalFetch = global.fetch;
  const oldUrl = process.env.HARMONY_ERROR_WEBHOOK_URL;
  const oldKey = process.env.HARMONY_ERROR_WEBHOOK_KEY;
  process.env.HARMONY_ERROR_WEBHOOK_URL = "https://alerts.example.test/harmony-errors";
  process.env.HARMONY_ERROR_WEBHOOK_KEY = "test-automation-key";
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 204 });
  };

  try {
    const first = messageFixture({ id: "hook-msg-1" });
    assert.equal(await logMediaError(first.message, new Error("No audio stream")), true);
    assert.equal(first.sent.length, 1);
    // Fire-and-forget: give the outstanding POST a tick to start.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://alerts.example.test/harmony-errors");
    assert.equal(requests[0].options.headers.Authorization, "Bearer test-automation-key");
    assert.equal(requests[0].options.headers["X-Automation-Key"], "test-automation-key");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.platform, "Instagram");
    assert.equal(body.sourceUrl, "https://www.instagram.com/reel/abc123/");
    assert.equal(body.discordMessageLink, "https://discord.com/channels/guild-1/source-1/msg-1");
    assert.match(body.errorText, /No audio stream/);
    assert.doesNotMatch(JSON.stringify(body), /igsh=SECRET|Member|member/);

    const repeat = messageFixture({ id: "hook-msg-1" });
    assert.equal(await logMediaError(repeat.message, new Error("No audio stream")), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(repeat.sent.length, 0);
    assert.equal(requests.length, 1);
  } finally {
    global.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.HARMONY_ERROR_WEBHOOK_URL;
    else process.env.HARMONY_ERROR_WEBHOOK_URL = oldUrl;
    if (oldKey === undefined) delete process.env.HARMONY_ERROR_WEBHOOK_KEY;
    else process.env.HARMONY_ERROR_WEBHOOK_KEY = oldKey;
  }
});

test("logMediaError still reports to Discord when the webhook is unconfigured", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };
  try {
    delete process.env.HARMONY_ERROR_WEBHOOK_URL;
    delete process.env.HARMONY_ERROR_WEBHOOK_KEY;
    const f = messageFixture({ id: "hook-msg-unconfigured" });
    assert.equal(await logMediaError(f.message, new Error("requested format is not available")), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.sent.length, 1);
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test.after(() => {
  closeDb?.();
});
