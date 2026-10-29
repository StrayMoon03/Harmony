const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-refresh-web-"));
const cookiePath = path.join(tempDir, "instagram.txt");
fs.writeFileSync(cookiePath, "existing-session", { mode: 0o600 });
Object.assign(process.env, {
  SESSION_REFRESH_PUBLIC_URL: "https://refresh.example",
  DISCORD_OAUTH_CLIENT_ID: "test-client-id",
  DISCORD_OAUTH_CLIENT_SECRET: "test-client-secret",
  SESSION_REFRESH_RAILWAY_PROJECT_TOKEN: "mock-project-token",
  SESSION_REFRESH_RAILWAY_SERVICE_ID: "mock-service-id",
  INSTAGRAM_COOKIES_BASE64: Buffer.from("existing-session").toString("base64"),
  INSTAGRAM_EXPECTED_USERNAME: "@MissHarmony",
  INSTAGRAM_COOKIES: cookiePath,
  HARMONY_CREDENTIAL_MANAGER_ROLE_IDS: "",
});

const { createSessionRefreshHttpHandler } = require("../src/services/sessionRefreshWebService");
const { createRefreshWorkflow } = require("../src/services/sessionRefreshService");

function createHarness({ actorId = "actor-1", identityId = actorId, authorized = true, expired = false, client = {}, useDefaultAuthorization = false, useRealInteractionWorkflow = false } = {}) {
  const record = {
    request_id: "550e8400-e29b-41d4-a716-446655440000",
    guild_id: "guild-1",
    actor_id: actorId,
    service: "instagram",
    status: expired ? "expired" : "pending",
    expires_at: expired ? "2000-01-01T00:00:00.000Z" : new Date(Date.now() + 60_000).toISOString(),
  };
  const events = [];
  let receivedCandidate = "";
  const requests = {
    getRequest(id) { return id === record.request_id ? { ...record } : null; },
    redeemRequestById({ requestId, guildId, actorId: submittedActor, service }) {
      if (requestId !== record.request_id || guildId !== record.guild_id || submittedActor !== record.actor_id || service !== record.service) return { ok: false, reason: "scope_mismatch" };
      if (record.status !== "pending") return { ok: false, reason: "already_used" };
      record.status = "consumed";
      return { ok: true };
    },
    completeRequest() { record.status = "completed"; return true; },
  };
  const audit = { recordCredentialRefreshEvent: (entry) => events.push({ ...entry }) };
  const workflow = {
    async submit(context, candidate) {
      receivedCandidate = candidate;
      assert.deepEqual(context, { requestId: record.request_id, guildId: record.guild_id, actorId: record.actor_id, service: record.service });
      record.status = "completed";
      return { ok: true, message: "Session refreshed. No credential is shown." };
    },
  };
  const mockedInteractionWorkflow = {
    redeemRequestId(args) {
      return requests.redeemRequestById({ requestId: args.requestId, guildId: args.guild.id, actorId: args.userId, service: args.service });
    },
  };
  const interactionWorkflow = useRealInteractionWorkflow
    ? createRefreshWorkflow({ audit, store: requests })
    : mockedInteractionWorkflow;
  const authorizeActor = async (_client, request, userId) => {
    if (!authorized || request.guild_id !== record.guild_id || request.actor_id !== userId) return null;
    return { guild: { id: record.guild_id }, member: { id: userId } };
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "oauth-access-token" }), { status: 200 });
    if (String(url).includes("/users/@me")) return new Response(JSON.stringify({ id: identityId }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  const handlerOptions = { client, fetchImpl, requests, audit, workflow, interactionWorkflow };
  if (!useDefaultAuthorization) handlerOptions.authorizeActor = authorizeActor;
  const handler = createSessionRefreshHttpHandler(handlerOptions);
  return { handler, record, events, getCandidate: () => receivedCandidate };
}

function request(server, pathName, { method = "GET", headers = {}, body } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: address.port, path: pathName, method,
      headers: { Host: "refresh.example", "X-Forwarded-Proto": "https", ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(handler, callback) {
  const server = http.createServer((req, res) => { handler(req, res).catch(() => res.writeHead(500).end()); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await callback(server); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("Discord OAuth, state/CSRF, actor/guild/service scoping, and HTTPS form complete without retaining candidate", async () => {
  const h = createHarness();
  await withServer(h.handler, async (server) => {
    const start = await request(server, `/session-refresh/${h.record.request_id}`);
    assert.equal(start.status, 303);
    const authorizeUrl = new URL(start.headers.location);
    assert.equal(authorizeUrl.origin, "https://discord.com");
    assert.equal(authorizeUrl.searchParams.get("scope"), "identify");
    assert.equal(authorizeUrl.searchParams.get("state").length > 20, true);
    assert.doesNotMatch(start.headers.location, /mock-project-token|instagram.txt/);
    const stateCookie = start.headers["set-cookie"].find((value) => value.startsWith("harmony_refresh_oauth_state="));
    const state = authorizeUrl.searchParams.get("state");
    const callback = await request(server, `/session-refresh/oauth/callback?code=oauth-code&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: stateCookie.split(";")[0] },
    });
    assert.equal(callback.status, 303);
    const sessionCookie = callback.headers["set-cookie"].find((value) => value.startsWith("harmony_refresh_session="));
    assert.match(sessionCookie, /HttpOnly; Secure; SameSite=Strict/);
    const cookie = sessionCookie.split(";")[0];

    const form = await request(server, "/session-refresh/form", { headers: { Cookie: cookie } });
    assert.equal(form.status, 200);
    assert.match(form.body, /Netscape-format/);
    assert.match(form.body, /Instagram account: Miss Harmony/);
    assert.match(form.body, /@missharmony/);
    assert.match(form.body, /dedicated Miss Harmony Instagram browser session/);
    const csrf = form.body.match(/name="csrf" value="([^"]+)"/)[1];
    const candidate = "# Netscape HTTP Cookie File\nPRIVATE_COOKIE_VALUE_NEVER_RETURNED_OR_STORED";
    const formBody = new URLSearchParams({ csrf, candidate }).toString();
    const submitted = await request(server, "/session-refresh/submit", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://refresh.example", "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(formBody) },
      body: formBody,
    });
    assert.equal(submitted.status, 200);
    assert.doesNotMatch(submitted.body, /PRIVATE_COOKIE_VALUE/);
    assert.equal(h.getCandidate(), candidate);
    assert.equal(h.record.status, "completed");
    assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE_COOKIE_VALUE|oauth-access-token/);
  });
});

test("OAuth CSRF, actor mismatch, removed capability, expired request, and HTTP entry fail closed", async () => {
  const badState = createHarness();
  const removedRole = createHarness({ authorized: false });
  const expired = createHarness({ expired: true });
  const actorMismatch = createHarness({ identityId: "different-actor" });
  await withServer(badState.handler, async (server) => {
    const start = await request(server, `/session-refresh/${badState.record.request_id}`);
    const url = new URL(start.headers.location);
    const cookie = start.headers["set-cookie"].find((value) => value.startsWith("harmony_refresh_oauth_state=")).split(";")[0];
    const failed = await request(server, `/session-refresh/oauth/callback?code=oauth-code&state=wrong`, { headers: { Cookie: cookie } });
    assert.equal(failed.status, 401);
    assert.equal(badState.record.status, "pending");
    const httpOnly = await request(server, `/session-refresh/${badState.record.request_id}`, { headers: { "X-Forwarded-Proto": "http" } });
    assert.equal(httpOnly.status, 400);
  });
  await withServer(removedRole.handler, async (server) => {
    const start = await request(server, `/session-refresh/${removedRole.record.request_id}`);
    const url = new URL(start.headers.location);
    const cookie = start.headers["set-cookie"].find((value) => value.startsWith("harmony_refresh_oauth_state=")).split(";")[0];
    const rejected = await request(server, `/session-refresh/oauth/callback?code=oauth-code&state=${url.searchParams.get("state")}`, { headers: { Cookie: cookie } });
    assert.equal(rejected.status, 403);
    assert.equal(removedRole.record.status, "pending");
  });
  await withServer(actorMismatch.handler, async (server) => {
    const start = await request(server, `/session-refresh/${actorMismatch.record.request_id}`);
    const url = new URL(start.headers.location);
    const cookie = start.headers["set-cookie"].find((value) => value.startsWith("harmony_refresh_oauth_state=")).split(";")[0];
    const rejected = await request(server, `/session-refresh/oauth/callback?code=oauth-code&state=${url.searchParams.get("state")}`, { headers: { Cookie: cookie } });
    assert.equal(rejected.status, 403);
    assert.equal(actorMismatch.record.status, "pending");
  });
  await withServer(expired.handler, async (server) => {
    const response = await request(server, `/session-refresh/${expired.record.request_id}`);
    assert.equal(response.status, 410);
  });
});

test("OAuth redemption recognizes the guild owner when the cached guild lacks ownerId", async () => {
  const guild = {
    id: "guild-1",
    fetch: async () => ({ id: "guild-1", ownerId: "actor-1" }),
    members: { fetch: async ({ user }) => ({ id: user, permissions: { has: () => false }, roles: { cache: [] } }) },
  };
  const h = createHarness({
    actorId: "actor-1",
    client: { guilds: { cache: new Map([["guild-1", guild]]) } },
    useDefaultAuthorization: true,
    useRealInteractionWorkflow: true,
  });
  await withServer(h.handler, async (server) => {
    const start = await request(server, `/session-refresh/${h.record.request_id}`);
    assert.equal(start.status, 303);
    const authorizeUrl = new URL(start.headers.location);
    const cookie = start.headers["set-cookie"].find((value) => value.startsWith("harmony_refresh_oauth_state=")).split(";")[0];
    const callback = await request(server, `/session-refresh/oauth/callback?code=oauth-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state"))}`, { headers: { Cookie: cookie } });
    assert.equal(callback.status, 303);
    assert.equal(h.record.status, "consumed");
  });
});

test("OAuth redemption rejects a regular admin without a Credential Manager role", async () => {
  const guild = {
    id: "guild-1",
    fetch: async () => ({ id: "guild-1", ownerId: "actual-owner" }),
    members: { fetch: async ({ user }) => ({ id: user, permissions: { has: () => true }, roles: { cache: [] } }) },
  };
  const h = createHarness({
    actorId: "regular-admin",
    client: { guilds: { cache: new Map([["guild-1", guild]]) } },
    useDefaultAuthorization: true,
    useRealInteractionWorkflow: true,
  });
  await withServer(h.handler, async (server) => {
    const start = await request(server, `/session-refresh/${h.record.request_id}`);
    const authorizeUrl = new URL(start.headers.location);
    const cookie = start.headers["set-cookie"].find((value) => value.startsWith("harmony_refresh_oauth_state=")).split(";")[0];
    const callback = await request(server, `/session-refresh/oauth/callback?code=oauth-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state"))}`, { headers: { Cookie: cookie } });
    assert.equal(callback.status, 403);
    assert.equal(h.record.status, "pending");
  });
});

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
