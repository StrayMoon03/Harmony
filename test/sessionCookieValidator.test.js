const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { validateSessionCookie } = require("../src/services/sessionCookieValidator");

function childReturning(payload) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stdin.on("finish", () => {
      child.stdout.write(JSON.stringify(payload));
      child.emit("close", 0);
    });
    return child;
  };
}

test("Verify diagnostics allow only bounded status and category data and do not change decisions", async () => {
  const entries = [];
  const spawnProcess = childReturning({
    status: "INCONCLUSIVE",
    diagnostics: {
      stage: "complete",
      document: "threads_com",
      evidence: "account_menu_missing",
      navigation: [[301, "threads_net"], [200, "threads_com"], [200, "https://private.example/secret"], ["secret", "external"]],
      username: "private-account",
      exception: "private body",
    },
  });
  const options = { spawnProcess, diagnosticLogger: (entry) => entries.push(entry) };
  assert.deepEqual(await validateSessionCookie("threads", "private-cookie-value", options), { status: "INCONCLUSIVE" });
  assert.deepEqual(await validateSessionCookie("facebook", "private-cookie-value", options), { status: "INCONCLUSIVE" });
  assert.deepEqual(entries, [{
    service: "threads",
    decision: "INCONCLUSIVE",
    stage: "complete",
    document: "threads_com",
    evidence: "account_menu_missing",
    navigation: [{ status: 301, category: "threads_net" }, { status: 200, category: "threads_com" }],
  }]);
});

test("an invalid Instagram identity setting emits a safe reason before any provider request", async () => {
  const entries = [];
  const result = await validateSessionCookie("instagram", "private-cookie-value", {
    env: { INSTAGRAM_EXPECTED_USERNAME: "invalid/name" },
    spawnProcess: () => assert.fail("The probe should not start"),
    diagnosticLogger: (entry) => entries.push(entry),
  });
  assert.deepEqual(result, { status: "IDENTITY_UNVERIFIABLE" });
  assert.deepEqual(entries, [{
    service: "instagram",
    decision: "IDENTITY_UNVERIFIABLE",
    stage: "expected_identity_missing_or_invalid",
  }]);
});
