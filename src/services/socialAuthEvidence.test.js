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
  assert.equal(
    safeReason({ message: "provider error", socialAuthFailureKind: "session" }),
    "The platform login cookies need to be refreshed."
  );
  assert.equal(
    safeReason({ message: "provider error", socialAuthFailureKind: "owner" }),
    "The platform account needs a security check by its owner (then refresh cookies)."
  );
});

test("safeReason reports classified auth failures before audio, format, or verify wording", () => {
  const session = {
    message: "INSTAGRAM_AUDIO_MISSING | Instagram browser could not verify the requested reel",
    socialAuthFailureKind: "session",
  };
  const owner = {
    message: "requested format is not available | Instagram exact reel recovery could not verify a playable video",
    socialAuthFailureKind: "owner",
  };
  assert.equal(safeReason(session), "The platform login cookies need to be refreshed.");
  assert.equal(safeReason(owner), "The platform account needs a security check by its owner (then refresh cookies).");
});

const issue442Message = "Instagram exhausted its safe download methods: ERROR: [Instagram] DfdPSrShNtb: This content isn't available to everyone: It can't be seen by certain audiences. | [instagram][info] Waiting for 1 minutes until 05:15:11 (429 Too Many Requests) | Instagram browser could not verify the requested reel";

test("safeReason can mention cookies from a clear login or audience wall without recording health", () => {
  assert.equal(safeReason(new Error(issue442Message)), "The platform login cookies may need to be refreshed.");
  assert.equal(
    safeReason(new Error("[instagram][error] HTTP redirect to login page (https://www.instagram.com/accounts/login/)")),
    "The platform login cookies may need to be refreshed."
  );
  assert.equal(
    safeReason(new Error("login required")),
    "The platform login cookies may need to be refreshed."
  );
  assert.equal(statusService.isExplicitAuthenticationFailure(new Error(issue442Message)), false);
  assert.equal(statusService.isExplicitAuthenticationFailure(new Error("login required")), false);
  assert.doesNotMatch(safeReason(new Error("[instagram][info] Waiting for 1 minutes until 05:15:11 (429 Too Many Requests)")), /cookies/i);
  assert.doesNotMatch(safeReason(new Error("Sign in to confirm you are not a bot")), /cookies/i);
});

test("authenticated Instagram audience walls and login redirects are session evidence, but a plain 429 is not", () => {
  assert.deepEqual(
    classifyAuthenticatedProviderFailure(
      new Error("ERROR: [Instagram] DfdPSrShNtb: This content isn't available to everyone: It can't be seen by certain audiences."),
      { authenticatedRequest: true }
    ),
    { kind: "session", category: "login_required" }
  );
  assert.equal(
    classifyAuthenticatedProviderFailure(
      new Error("ERROR: [Instagram] DfdPSrShNtb: This content isn't available to everyone: It can't be seen by certain audiences.")
    ),
    null
  );
  assert.deepEqual(
    classifyAuthenticatedProviderFailure(
      new Error("[instagram][error] HTTP redirect to login page (https://www.instagram.com/accounts/login/)"),
      { authenticatedRequest: true }
    ),
    { kind: "session", category: "login_required" }
  );
  assert.equal(
    classifyAuthenticatedProviderFailure(
      new Error("[instagram][info] Waiting for 1 minutes until 05:15:11 (429 Too Many Requests)"),
      { authenticatedRequest: true }
    ),
    null
  );
});
