const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyAuthenticatedProviderFailure } = require("./socialAuthEvidence");
const { safeReason } = require("./errorInboxService");
const statusService = require("./operationsStatusService");

test("provider text is only auth evidence when it came from an authenticated request", () => {
  assert.equal(classifyAuthenticatedProviderFailure(new Error("login required")), null);
  assert.deepEqual(classifyAuthenticatedProviderFailure(new Error("login required"), { authenticatedRequest: true }), {
    kind: "session", category: "login_required",
  });
  assert.deepEqual(classifyAuthenticatedProviderFailure(new Error("Facebook checkpoint page"), { authenticatedRequest: true }), {
    kind: "owner", category: "checkpoint",
  });
});

test("media, CDN, size, extractor, rate-limit, and anti-bot errors never become session diagnoses", () => {
  for (const message of [
    "Facebook verified attachment download failed: HTTP 403", 
    "file below media size threshold",
    "exact post identity mismatch",
    "unsupported media format",
    "extractor timeout",
    "HTTP 429 rate limit",
    "Sign in to confirm you are not a bot",
  ]) {
    assert.equal(classifyAuthenticatedProviderFailure(new Error(message), { authenticatedRequest: true }), null, message);
    assert.equal(statusService.isExplicitAuthenticationFailure(new Error(message)), false, message);
  }
  assert.equal(safeReason(new Error("Facebook CDN image below size threshold")), "The retrieved media could not be used for posting.");
  assert.doesNotMatch(safeReason(new Error("Facebook CDN image below size threshold")), /refresh|cookies/i);
});

test("error inbox uses explicit classified evidence and never guesses from generic text", () => {
  assert.equal(safeReason(new Error("Facebook cookies not present in downloader config")), "Harmony could not retrieve usable media from this link.");
  assert.match(safeReason({ message: "provider error", socialAuthFailureKind: "session" }), /session needs to be refreshed/i);
  assert.match(safeReason({ message: "provider error", socialAuthFailureKind: "owner" }), /account security check/i);
});
