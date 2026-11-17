const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WEBHOOK_TIMEOUT_MS,
  getErrorAlertWebhookConfig,
  buildErrorAlertPayload,
  sendErrorAlertWebhook,
  notifyErrorAlertWebhook,
} = require("./errorAlertWebhook");
const { fingerprint, sanitizedErrorText, safeUrl } = require("./errorReportSanitize");

const WEBHOOK_URL = "https://alerts.example.test/harmony-errors";
const WEBHOOK_KEY = "test-automation-key";

function configuredEnv(overrides = {}) {
  return {
    HARMONY_ERROR_WEBHOOK_URL: WEBHOOK_URL,
    HARMONY_ERROR_WEBHOOK_KEY: WEBHOOK_KEY,
    ...overrides,
  };
}

test("does nothing when the webhook URL or key is unset", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };
  const details = { platform: "Instagram", sourceUrl: "https://www.instagram.com/reel/abc/", error: new Error("No media") };

  assert.equal(getErrorAlertWebhookConfig({}), null);
  assert.equal(getErrorAlertWebhookConfig({ HARMONY_ERROR_WEBHOOK_URL: WEBHOOK_URL }), null);
  assert.equal(getErrorAlertWebhookConfig({ HARMONY_ERROR_WEBHOOK_KEY: WEBHOOK_KEY }), null);
  assert.equal(await sendErrorAlertWebhook(details, { env: {}, fetchImpl }), false);
  assert.equal(await sendErrorAlertWebhook(details, { env: { HARMONY_ERROR_WEBHOOK_URL: WEBHOOK_URL }, fetchImpl }), false);
  assert.equal(await sendErrorAlertWebhook(details, { env: { HARMONY_ERROR_WEBHOOK_KEY: WEBHOOK_KEY }, fetchImpl }), false);
  assert.equal(calls, 0);
});

test("sends a redacted JSON payload with the expected auth headers when configured", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  };
  const sourceUrl = "https://www.facebook.com/share/p/post-id/?tracking=1&token=SIGNED_QUERY_SECRET";
  const jumpUrl = "https://discord.com/channels/1/2/3";
  const privateValues = "c_user=FACEBOOK_USER_SECRET xs=FACEBOOK_SESSION_SECRET https://cdn.example/image?token=SIGNED_CDN_SECRET\n.facebook.com\tTRUE\t/\tTRUE\t9999999999\txs\tNETSCAPE_SESSION_SECRET";
  const error = new Error(privateValues);
  const occurred = "2026-11-16T15:00:00.000Z";

  const sent = await sendErrorAlertWebhook({
    platform: "Facebook",
    sourceUrl,
    error,
    discordMessageLink: jumpUrl,
    timestamp: occurred,
  }, { env: configuredEnv(), fetchImpl });

  assert.equal(sent, true);
  assert.equal(request.url, WEBHOOK_URL);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.equal(request.options.headers.Authorization, `Bearer ${WEBHOOK_KEY}`);
  assert.equal(request.options.headers["X-Automation-Key"], WEBHOOK_KEY);
  assert.equal(request.options.signal.aborted, false);
  assert.equal(typeof request.options.signal, "object");

  const body = JSON.parse(request.options.body);
  assert.equal(body.platform, "Facebook");
  assert.equal(body.sourceUrl, "https://www.facebook.com/share/p/post-id/");
  assert.equal(body.discordMessageLink, jumpUrl);
  assert.equal(body.timestamp, occurred);
  assert.equal(body.fingerprint, fingerprint("Facebook", sanitizedErrorText(error)));
  assert.doesNotMatch(body.errorText, /FACEBOOK_USER_SECRET|FACEBOOK_SESSION_SECRET|SIGNED_CDN_SECRET|NETSCAPE_SESSION_SECRET|SIGNED_QUERY_SECRET/);
  assert.match(body.errorText, /c_user=\[REDACTED\]|\[SESSION COOKIE ROW REDACTED\]/);
  assert.ok(body.errorText.length <= 3500);
  assert.equal(JSON.stringify(body).includes(WEBHOOK_KEY), false);
});

test("swallows network failures and timeouts without retrying", async () => {
  const details = {
    platform: "Instagram",
    sourceUrl: "https://www.instagram.com/reel/abc/",
    error: new Error("No audio stream"),
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    let networkCalls = 0;
    const networkFailure = await sendErrorAlertWebhook(details, {
      env: configuredEnv(),
      fetchImpl: async () => {
        networkCalls += 1;
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
      },
    });
    assert.equal(networkFailure, false);
    assert.equal(networkCalls, 1);

    let timeoutCalls = 0;
    const timeoutFailure = await sendErrorAlertWebhook(details, {
      env: configuredEnv(),
      fetchImpl: async (_url, options) => {
        timeoutCalls += 1;
        assert.equal(options.signal instanceof AbortSignal, true);
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      },
    });
    assert.equal(timeoutFailure, false);
    assert.equal(timeoutCalls, 1);
    assert.equal(WEBHOOK_TIMEOUT_MS, 8000);

    let httpCalls = 0;
    const httpFailure = await sendErrorAlertWebhook(details, {
      env: configuredEnv(),
      fetchImpl: async () => {
        httpCalls += 1;
        return new Response("nope", { status: 503 });
      },
    });
    assert.equal(httpFailure, false);
    assert.equal(httpCalls, 1);

    const logged = warnings.join("\n");
    assert.match(logged, /error alert webhook failed: request failed/i);
    assert.match(logged, /error alert webhook failed: timeout/i);
    assert.match(logged, /error alert webhook returned HTTP 503/i);
    assert.doesNotMatch(logged, /alerts\.example\.test|test-automation-key|HARMONY_ERROR_WEBHOOK/);
  } finally {
    console.warn = originalWarn;
  }
});

test("notifyErrorAlertWebhook never throws into the caller", async () => {
  const result = notifyErrorAlertWebhook({
    platform: "TikTok",
    sourceUrl: "https://www.tiktok.com/@user/video/1",
    error: new Error("timeout"),
  }, {
    env: configuredEnv(),
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(await result, false);
});

test("payload uses the shared sanitizer and fingerprint helpers", () => {
  const error = new Error("requested format is not available at /app/src/temp/harmony-12345-abc.mp4");
  const payload = buildErrorAlertPayload({
    platform: "Instagram",
    sourceUrl: "https://www.instagram.com/reel/abc/?igsh=SECRET",
    error,
    timestamp: "2026-11-16T15:00:00.000Z",
  });
  assert.equal(payload.sourceUrl, safeUrl("https://www.instagram.com/reel/abc/"));
  assert.equal(payload.fingerprint, fingerprint("Instagram", payload.errorText));
  assert.doesNotMatch(payload.sourceUrl, /igsh|SECRET/);
});
