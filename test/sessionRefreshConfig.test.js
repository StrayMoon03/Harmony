const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isServiceRefreshAvailable, publicBaseUrl } = require("../src/services/sessionRefreshConfig");

test("services become available independently only when their HTTPS, OAuth, rotation, and runtime inputs exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-refresh-config-"));
  try {
    const instagramPath = path.join(dir, "instagram.txt");
    fs.writeFileSync(instagramPath, "placeholder");
    const env = {
      SESSION_REFRESH_PUBLIC_URL: "https://harmony.example",
      DISCORD_OAUTH_CLIENT_ID: "id",
      DISCORD_OAUTH_CLIENT_SECRET: "server-only",
      SESSION_REFRESH_RAILWAY_PROJECT_TOKEN: "server-only",
      SESSION_REFRESH_RAILWAY_SERVICE_ID: "service-id",
      INSTAGRAM_COOKIES_BASE64: "present",
      INSTAGRAM_COOKIES: instagramPath,
    };
    assert.equal(isServiceRefreshAvailable("instagram", { env }), true);
    assert.equal(isServiceRefreshAvailable("threads", { env }), false);
    assert.equal(publicBaseUrl(env), "https://harmony.example");
    assert.equal(publicBaseUrl({ ...env, SESSION_REFRESH_PUBLIC_URL: "http://harmony.example" }), null);
    assert.equal(publicBaseUrl({ ...env, SESSION_REFRESH_PUBLIC_URL: "https://harmony.example/path" }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
