const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-refresh-workflow-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "workflow.sqlite");
process.env.INSTAGRAM_COOKIES = path.join(tempDir, "instagram-cookies.txt");
process.env.INSTAGRAM_COOKIES_BASE64 = Buffer.from("prior-session", "utf8").toString("base64");
process.env.SESSION_REFRESH_PUBLIC_URL = "https://refresh.example";
process.env.DISCORD_OAUTH_CLIENT_ID = "mock-client-id";
process.env.DISCORD_OAUTH_CLIENT_SECRET = "mock-client-secret";
process.env.SESSION_REFRESH_RAILWAY_PROJECT_TOKEN = "mock-project-token";
process.env.SESSION_REFRESH_RAILWAY_SERVICE_ID = "mock-service-id";
fs.writeFileSync(process.env.INSTAGRAM_COOKIES, "prior-session", { mode: 0o600 });

const { getDb, closeDb } = require("../src/db/sqlite");
const { createSessionRefreshWorkflow } = require("../src/services/sessionRefreshWorkflow");
const requests = require("../src/stores/credentialRefreshStore");
const statusCommand = require("../src/commands/status");
const { STATUS } = require("../src/services/operationsStatusService");

let requestNumber = 0;
let activeRequestId = "";
function context() {
  return { requestId: activeRequestId, guildId: "guild-workflow", actorId: "owner-workflow", service: "instagram" };
}

function makeRequest(now = "2026-10-28T00:00:00.000Z") {
  activeRequestId = `request-workflow-${++requestNumber}`;
  requests.createRequest({
    requestId: context().requestId,
    tokenHash: Buffer.from(activeRequestId).toString("hex").padEnd(64, "0").slice(0, 64),
    guildId: context().guildId,
    actorId: context().actorId,
    service: context().service,
    createdAt: now,
    expiresAt: "2026-10-28T00:10:00.000Z",
  });
  requests.redeemRequestById({ ...context(), now });
}

test("successful refresh validates, rotates, atomically activates, verifies, and keeps secrets out of SQLite/audit", async () => {
  getDb();
  makeRequest();
  const events = [];
  const audit = { recordCredentialRefreshStage: (entry) => events.push({ ...entry }) };
  const candidate = "# Netscape HTTP Cookie File\nSECRET_COOKIE_VALUE_NEVER_STORE";
  let validationCalls = 0;
  let rotatedValue;
  const workflow = createSessionRefreshWorkflow({
    validator: async () => { validationCalls++; return { status: "AUTHENTICATED" }; },
    providerFactory: () => ({ rotate: async (_service, value) => { rotatedValue = value; }, restore: async () => {} }),
    audit,
    now: () => "2026-10-28T00:01:00.000Z",
  });
  const result = await workflow.submit(context(), candidate);
  assert.equal(result.ok, true);
  assert.equal(validationCalls, 2);
  assert.equal(fs.readFileSync(process.env.INSTAGRAM_COOKIES, "utf8"), candidate);
  assert.equal(process.env.INSTAGRAM_COOKIES_BASE64, Buffer.from(candidate).toString("base64"));
  assert.equal(Buffer.from(rotatedValue, "base64").toString("utf8"), candidate);
  const tableNames = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  const databaseSnapshot = tableNames.map((name) => getDb().prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
  assert.doesNotMatch(JSON.stringify(databaseSnapshot), /SECRET_COOKIE_VALUE_NEVER_STORE/);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_COOKIE_VALUE_NEVER_STORE/);
  assert.deepEqual(events.map((event) => `${event.stage}_${event.success}`), [
    "validation_true", "rotation_true", "activation_true", "verification_true",
  ]);
  assert.equal(requests.getRequest(context().requestId).status, "completed");
});

test("Status exposes Refresh Session only for an explicitly expired operational service", () => {
  const report = { checkedAt: "2026-10-28T00:00:00.000Z", rows: [
    { id: "social-instagram", name: "Instagram", status: STATUS.attention, explanation: "Sign-in required.", action: "Session refresh required." },
    { id: "social-threads", name: "Threads", status: STATUS.owner, explanation: "Security checkpoint.", action: "Owner attention required." },
  ] };
  const payload = statusCommand.makeStatusPayload(report, { canManageCredentials: true });
  const buttonIds = payload.components[0].components.map((component) => component.data.custom_id);
  assert.ok(buttonIds.includes("harmony-session-refresh:instagram"));
  assert.ok(buttonIds.includes("harmony-status:refresh"));
  assert.ok(!buttonIds.includes("harmony-session-refresh:threads"));
  const regular = statusCommand.makeStatusPayload(report, { canManageCredentials: false });
  assert.ok(!regular.components[0].components.some((component) => String(component.data.custom_id).startsWith("harmony-session-refresh:")));
  assert.match(JSON.stringify(regular), /ask the owner or a Credential Manager/i);
});

test("ambiguous validation and rotation failure preserve the existing credential", async (t) => {
  const active = "existing-session-must-survive";
  const candidate = "new-session-not-validated";
  const file = process.env.INSTAGRAM_COOKIES;
  const activeEncoded = Buffer.from(active, "utf8").toString("base64");

  await t.test("ambiguous validation", async () => {
    fs.writeFileSync(file, active);
    process.env.INSTAGRAM_COOKIES_BASE64 = activeEncoded;
    makeRequest("2026-10-28T00:02:00.000Z");
    let rotations = 0;
    const workflow = createSessionRefreshWorkflow({
      validator: async () => ({ status: "INCONCLUSIVE" }),
      providerFactory: () => ({ rotate: async () => { rotations++; } }),
      audit: { recordCredentialRefreshStage() {} },
      now: () => "2026-10-28T00:03:00.000Z",
    });
    const result = await workflow.submit(context(), candidate);
    assert.equal(result.reason, "validation_unavailable");
    assert.equal(rotations, 0);
    assert.equal(fs.readFileSync(file, "utf8"), active);
    assert.equal(process.env.INSTAGRAM_COOKIES_BASE64, activeEncoded);
  });

  await t.test("rotation failure", async () => {
    fs.writeFileSync(file, active);
    process.env.INSTAGRAM_COOKIES_BASE64 = activeEncoded;
    makeRequest("2026-10-28T00:04:00.000Z");
    const workflow = createSessionRefreshWorkflow({
      validator: async () => ({ status: "AUTHENTICATED" }),
      providerFactory: () => ({ rotate: async () => { throw new Error(`provider failure ${candidate}`); }, restore: async () => {} }),
      audit: { recordCredentialRefreshStage() {} },
      now: () => "2026-10-28T00:05:00.000Z",
    });
    const result = await workflow.submit(context(), candidate);
    assert.equal(result.reason, "rotation_failure");
    assert.doesNotMatch(JSON.stringify(result), /provider failure|new-session/);
    assert.equal(fs.readFileSync(file, "utf8"), active);
    assert.equal(process.env.INSTAGRAM_COOKIES_BASE64, activeEncoded);
  });

  await t.test("post-activation verification failure rolls back runtime and provider", async () => {
    fs.writeFileSync(file, active);
    process.env.INSTAGRAM_COOKIES_BASE64 = activeEncoded;
    makeRequest("2026-10-28T00:06:00.000Z");
    let validations = 0;
    let restoredValue;
    const workflow = createSessionRefreshWorkflow({
      validator: async () => ({ status: ++validations === 1 ? "AUTHENTICATED" : "UNAUTHENTICATED" }),
      providerFactory: () => ({ rotate: async () => {}, restore: async (_service, value) => { restoredValue = value; } }),
      audit: { recordCredentialRefreshStage() {} },
      now: () => "2026-10-28T00:07:00.000Z",
    });
    const result = await workflow.submit(context(), candidate);
    assert.equal(result.reason, "activation_failure");
    assert.equal(fs.readFileSync(file, "utf8"), active);
    assert.equal(restoredValue, activeEncoded);
    assert.equal(process.env.INSTAGRAM_COOKIES_BASE64, activeEncoded);
  });
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
