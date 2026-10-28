const crypto = require("node:crypto");
const requestStore = require("../stores/credentialRefreshStore");
const auditStore = require("../stores/operationsAuditStore");
const { resolveAdminCapabilities } = require("./operationsStatusService");
const { refreshWorkflow: defaultRefreshWorkflow } = require("./sessionRefreshService");
const { createSessionRefreshWorkflow } = require("./sessionRefreshWorkflow");
const { isServiceRefreshAvailable, configSnapshot, publicBaseUrl } = require("./sessionRefreshConfig");

const MAX_FORM_BYTES = 1024 * 1024 + 8192;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const WEB_SESSION_TTL_MS = 15 * 60 * 1000;
const defaultWorkflow = createSessionRefreshWorkflow();

const PAGE_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
});

const COOKIE_GUIDANCE = Object.freeze({
  instagram: "Upload a Netscape-format cookies.txt export from the Instagram account Harmony is authorized to use. The export must include the Instagram session and CSRF cookies.",
  threads: "Upload a Netscape-format cookies.txt export from the Threads account Harmony is authorized to use. The export must include the Threads session and CSRF cookies.",
  facebook: "Upload a Netscape-format cookies.txt export from the Facebook account Harmony is authorized to use. The export must include the c_user and xs cookies.",
  youtube: "Upload a Netscape-format cookies.txt export from the YouTube account Harmony is authorized to use. Include YouTube and Google cookies, including LOGIN_INFO and a SAPISID-family cookie.",
});

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function timingSafeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function parseCookies(header = "") {
  const result = new Map();
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

function writeHtml(response, code, body, cookieHeaders = []) {
  response.writeHead(code, { ...PAGE_HEADERS, "Content-Length": Buffer.byteLength(body), "Set-Cookie": cookieHeaders });
  response.end(body);
}

function messagePage(title, message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeError(response, code = 400) {
  writeHtml(response, code, messagePage("Session refresh", "Harmony could not continue this request. Return to Discord Status and start a new refresh request."));
}

function secureRequest(request) {
  const base = publicBaseUrl();
  const host = String(request.headers.host || "").toLowerCase();
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return Boolean(base && forwardedProto === "https" && host === new URL(base).host.toLowerCase());
}

function makeCookie(name, value, { path = "/session-refresh", maxAge = 900, sameSite = "Strict" } = {}) {
  return `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

function signPayload(payload) {
  const config = configSnapshot();
  if (!config.oauthClientSecret) return null;
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = crypto.createHmac("sha256", config.oauthClientSecret).update("harmony-session-refresh-v1").digest();
  const signature = crypto.createHmac("sha256", key).update(encoded).digest("base64url");
  key.fill(0);
  return `${encoded}.${signature}`;
}

function verifyPayload(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) return null;
  const config = configSnapshot();
  if (!config.oauthClientSecret) return null;
  const key = crypto.createHmac("sha256", config.oauthClientSecret).update("harmony-session-refresh-v1").digest();
  const expectedSignature = crypto.createHmac("sha256", key).update(encoded).digest("base64url");
  key.fill(0);
  if (!timingSafeStringEqual(signature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function oauthRedirect(requestId) {
  const config = configSnapshot();
  if (!config.publicUrl || !config.oauthClientId || !config.oauthClientSecret) return null;
  const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
  const state = signPayload({ requestId, expiresAt, nonce: randomToken(18) });
  const redirectUri = `${config.publicUrl}/session-refresh/oauth/callback`;
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", config.oauthClientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);
  return { state, authorize: authorize.toString(), redirectUri };
}

async function exchangeCode(code, redirectUri, fetchImpl = fetch) {
  const config = configSnapshot();
  const body = new URLSearchParams({
    client_id: config.oauthClientId,
    client_secret: config.oauthClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const response = await fetchImpl("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("oauth_exchange_failed");
  const token = await response.json();
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("oauth_exchange_failed");
  return token.access_token;
}

async function fetchDiscordIdentity(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("oauth_identity_failed");
  const data = await response.json();
  if (typeof data.id !== "string") throw new Error("oauth_identity_failed");
  return data;
}

async function resolveAuthorizedActor(client, requestRecord, userId) {
  if (!requestRecord || requestRecord.actor_id !== userId) return null;
  let guild = client.guilds.cache.get(requestRecord.guild_id);
  if (!guild) guild = await client.guilds.fetch(requestRecord.guild_id).catch(() => null);
  if (!guild || guild.id !== requestRecord.guild_id) return null;
  const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  if (!member) return null;
  const capabilities = await resolveAdminCapabilities({ guild, member, userId });
  if (!capabilities.canManageCredentials) return null;
  return { guild, member, resolvedGuildOwnerId: capabilities.resolvedGuildOwnerId };
}

function formPage(session) {
  const csrf = session.csrf;
  const service = session.service;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refresh ${service} session</title><style>body{font:16px system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;color:#202124}textarea{box-sizing:border-box;width:100%;min-height:18rem;font:13px monospace}button{padding:.7rem 1rem;margin-top:1rem}small{color:#555}</style><body><main><h1>Refresh ${service} session</h1><p>${COOKIE_GUIDANCE[service]}</p><p>This page is protected by Discord sign-in. Harmony validates the candidate before updating the existing session. The cookie contents are sent only in this HTTPS form body; they are not saved in Harmony's database or returned in the result.</p><form method="post" action="/session-refresh/submit" enctype="application/x-www-form-urlencoded" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label for="candidate">Paste the complete cookies.txt export</label><p><textarea id="candidate" name="candidate" required autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></p><small>Do not paste this into Discord. Keep this page open until Harmony shows the result.</small><p><button type="submit">Validate and refresh session</button></p></form></main></body></html>`;
}

function resultPage(result) {
  const color = result.ok ? "#176b35" : result.reason === "owner_required" ? "#8a3d0a" : "#7a1e1e";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session refresh result</title><style>body{font:16px system-ui,sans-serif;max-width:700px;margin:3rem auto;padding:0 1rem}h1{color:${color}}</style><body><main><h1>Session refresh</h1><p>${escapeHtml(result.message)}</p><p>You can close this page and refresh Harmony Status in Discord.</p></main></body></html>`;
}

function readBody(request, maxBytes = MAX_FORM_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        for (const buffered of chunks) buffered.fill(0);
        chunk.fill(0);
        chunks.length = 0;
        size = 0;
        reject(new Error("body_too_large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      const combined = Buffer.concat(chunks, size);
      for (const buffered of chunks) buffered.fill(0);
      chunks.length = 0;
      resolve(combined);
    });
    request.on("error", () => { if (!rejected) reject(new Error("body_read_failed")); });
  });
}

function sessionForRequest(request, requests) {
  const cookie = parseCookies(request.headers.cookie).get("harmony_refresh_session");
  const session = verifyPayload(cookie);
  if (!session || typeof session.requestId !== "string" || typeof session.csrf !== "string" || session.expiresAt <= Date.now()) return null;
  const record = requests.getRequest(session.requestId);
  if (!record || record.status !== "consumed" || new Date(record.expires_at).getTime() <= Date.now()) return null;
  return {
    id: cookie,
    session: {
      requestId: record.request_id,
      guildId: record.guild_id,
      actorId: record.actor_id,
      service: record.service,
      csrf: session.csrf,
      expiresAt: session.expiresAt,
    },
  };
}

async function handleCallback(request, response, url, { client, fetchImpl, requests, audit, workflow, authorizeActor }) {
  const cookies = parseCookies(request.headers.cookie);
  const state = url.searchParams.get("state") || "";
  const stateCookie = cookies.get("harmony_refresh_oauth_state") || "";
  const saved = verifyPayload(state);
  if (!saved || saved.expiresAt <= Date.now() || !timingSafeStringEqual(state, stateCookie) || !url.searchParams.get("code")) {
    safeError(response, 401);
    return;
  }

  let requestRecord = requests.getRequest(saved.requestId);
  if (!requestRecord || requestRecord.status !== "pending" || new Date(requestRecord.expires_at).getTime() <= Date.now() || !isServiceRefreshAvailable(requestRecord.service)) {
    safeError(response, 410);
    return;
  }

  try {
    const config = configSnapshot();
    const redirectUri = `${config.publicUrl}/session-refresh/oauth/callback`;
    let accessToken = await exchangeCode(url.searchParams.get("code"), redirectUri, fetchImpl);
    let identity;
    try { identity = await fetchDiscordIdentity(accessToken, fetchImpl); }
    finally { accessToken = ""; }
    if (identity.id !== requestRecord.actor_id) {
      audit.recordCredentialRefreshEvent({ guildId: requestRecord.guild_id, actorId: identity.id, service: requestRecord.service, action: "request_redeemed", outcome: "failure" });
      safeError(response, 403);
      return;
    }
    const authorized = await authorizeActor(client, requestRecord, identity.id);
    if (!authorized) {
      audit.recordCredentialRefreshEvent({ guildId: requestRecord.guild_id, actorId: identity.id, service: requestRecord.service, action: "request_redeemed", outcome: "failure" });
      safeError(response, 403);
      return;
    }
    const redeemed = workflow.redeemRequestId({
      requestId: saved.requestId,
      guild: authorized.guild,
      member: authorized.member,
      userId: identity.id,
      service: requestRecord.service,
      resolvedGuildOwnerId: authorized.resolvedGuildOwnerId,
    });
    if (!redeemed.ok) {
      safeError(response, 410);
      return;
    }
    requestRecord = requests.getRequest(saved.requestId);
    const csrf = randomToken();
    const sessionId = signPayload({ requestId: requestRecord.request_id, csrf, expiresAt: Date.now() + WEB_SESSION_TTL_MS });
    if (!sessionId) { safeError(response, 503); return; }
    response.writeHead(303, {
      Location: "/session-refresh/form",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": [
        makeCookie("harmony_refresh_oauth_state", "", { path: "/session-refresh/oauth/callback", maxAge: 0, sameSite: "Lax" }),
        makeCookie("harmony_refresh_session", sessionId),
      ],
    });
    response.end();
  } catch {
    safeError(response, 502);
  }
}

async function handleSubmit(request, response, { client, requests, workflow, authorizeActor }) {
  const existing = sessionForRequest(request, requests);
  if (!existing) { safeError(response, 401); return; }
  const auth = await authorizeActor(client, { guild_id: existing.session.guildId, actor_id: existing.session.actorId }, existing.session.actorId);
  if (!auth) { safeError(response, 403); return; }
  if (!String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
    safeError(response, 415);
    return;
  }
  const origin = String(request.headers.origin || "");
  if (origin !== publicBaseUrl()) { safeError(response, 403); return; }

  let body;
  let candidate = "";
  try {
    body = await readBody(request);
    let encodedBody = body.toString("utf8");
    const params = new URLSearchParams(encodedBody);
    encodedBody = "";
    const csrf = params.get("csrf") || "";
    candidate = params.get("candidate") || "";
    params.set("candidate", "");
    if (!timingSafeStringEqual(csrf, existing.session.csrf)) {
      candidate = "";
      params.set("csrf", "");
      body.fill(0);
      safeError(response, 403);
      return;
    }
    params.set("csrf", "");
    body.fill(0);
    body = null;
    const result = await workflow.submit({
      requestId: existing.session.requestId,
      guildId: existing.session.guildId,
      actorId: existing.session.actorId,
      service: existing.session.service,
    }, candidate);
    candidate = "";
    writeHtml(response, result.ok ? 200 : result.reason === "owner_required" ? 409 : 422, resultPage(result), [
      makeCookie("harmony_refresh_session", "", { maxAge: 0 }),
    ]);
  } catch (error) {
    candidate = "";
    body?.fill(0);
    safeError(response, error.message === "body_too_large" ? 413 : 400);
  }
}

function createSessionRefreshHttpHandler({
  client,
  fetchImpl = fetch,
  requests = requestStore,
  audit = auditStore,
  workflow = defaultWorkflow,
  interactionWorkflow = defaultRefreshWorkflow,
  authorizeActor = resolveAuthorizedActor,
} = {}) {
  return async function handleSessionRefreshRequest(request, response) {
    let url;
    try { url = new URL(request.url, publicBaseUrl() || "https://localhost"); }
    catch { return false; }
    if (!url.pathname.startsWith("/session-refresh")) return false;
    if (!secureRequest(request)) {
      safeError(response, 400);
      return true;
    }

    const requestMatch = url.pathname.match(/^\/session-refresh\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && requestMatch) {
      const record = requests.getRequest(requestMatch[1]);
      if (!record || record.status !== "pending" || new Date(record.expires_at).getTime() <= Date.now() || !isServiceRefreshAvailable(record.service)) {
        safeError(response, 410);
        return true;
      }
      const oauth = oauthRedirect(record.request_id);
      if (!oauth) { safeError(response, 503); return true; }
      response.writeHead(303, {
        Location: oauth.authorize,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": makeCookie("harmony_refresh_oauth_state", oauth.state, { path: "/session-refresh/oauth/callback", maxAge: 600, sameSite: "Lax" }),
      });
      response.end();
      return true;
    }

    if (request.method === "GET" && url.pathname === "/session-refresh/oauth/callback") {
      await handleCallback(request, response, url, { client, fetchImpl, requests, audit, workflow: interactionWorkflow, authorizeActor });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/session-refresh/form") {
      const existing = sessionForRequest(request, requests);
      if (!existing) { safeError(response, 401); return true; }
      writeHtml(response, 200, formPage(existing.session));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/session-refresh/submit") {
      await handleSubmit(request, response, { client, requests, workflow, authorizeActor });
      return true;
    }

    safeError(response, 404);
    return true;
  };
}

function startSessionRefreshWebService(client, options = {}) {
  return createSessionRefreshHttpHandler({ client, ...options });
}

module.exports = {
  COOKIE_GUIDANCE,
  PAGE_HEADERS,
  createSessionRefreshHttpHandler,
  startSessionRefreshWebService,
};
