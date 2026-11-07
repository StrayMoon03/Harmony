const crypto = require("node:crypto");
const requestStore = require("../stores/credentialRefreshStore");
const auditStore = require("../stores/operationsAuditStore");
const { resolveAdminCapabilities } = require("./operationsStatusService");
const { refreshWorkflow: defaultRefreshWorkflow } = require("./sessionRefreshService");
const { createSessionRefreshWorkflow } = require("./sessionRefreshWorkflow");
const { isServiceRefreshAvailable, configSnapshot, publicBaseUrl, expectedInstagramUsername } = require("./sessionRefreshConfig");

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
  instagram: "Upload a Netscape-format cookies.txt export from the dedicated Miss Harmony Instagram account. The export must include the Instagram session and CSRF cookies.",
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

const SAFE_STAGES = new Set(["https", "request", "oauth_config", "oauth_state", "oauth_exchange", "oauth_identity", "actor_authorization", "request_redemption", "web_session", "form_request", "form_body", "form_csrf", "form_origin", "routing", "callback"]);
const SAFE_REASONS = new Set(["https_required", "request_missing", "request_expired", "refresh_unavailable", "oauth_unavailable", "invalid_oauth_state", "oauth_exchange_failed", "oauth_identity_failed", "identity_mismatch", "actor_not_authorized", "redeem_failed", "web_session_invalid", "unsupported_form", "invalid_origin", "body_too_large", "body_read_failed", "session_sign_failed", "handler_failed", "route_not_found"]);
const SAFE_SERVICES = new Set(["instagram", "facebook", "threads", "youtube"]);

const SAFE_FAILURE_MESSAGES = Object.freeze({
  https_required: "Open this page using the secure HTTPS link from Discord. No cookies were processed.",
  request_missing: "This refresh request is no longer available. Start a new request from Discord Status.",
  request_expired: "This refresh request expired or was already used. Start a new request from Discord Status.",
  refresh_unavailable: "Secure refresh is not currently available for this service. No cookies were changed.",
  oauth_unavailable: "Secure Discord sign-in is not currently available. No cookies were changed.",
  invalid_oauth_state: "The secure sign-in or form session expired or could not be verified. Start a new request from Discord Status.",
  oauth_exchange_failed: "Discord sign-in could not be completed. Start a new request from Discord Status.",
  oauth_identity_failed: "Harmony could not confirm the Discord account. Start a new request from Discord Status.",
  identity_mismatch: "This request was opened by a different Discord account. Start a new request while signed in as the account that initiated it.",
  actor_not_authorized: "This Discord account is no longer authorized to manage sessions. Ask a server administrator to check access.",
  redeem_failed: "This refresh request expired or was already used. Start a new request from Discord Status.",
  web_session_invalid: "Your secure refresh session expired. Start a new request from Discord Status.",
  unsupported_form: "The secure form could not be read. Reopen it from Discord Status and try again.",
  invalid_origin: "Submit the form from the secure Harmony page opened through Discord. No cookies were processed.",
  body_too_large: "This cookies.txt export is larger than Harmony can safely process. No cookies were changed.",
  body_read_failed: "Harmony could not read the form submission. No cookies were changed. Start a new request and try again.",
  session_sign_failed: "Harmony could not start a secure web session. No cookies were changed; contact the owner.",
  handler_failed: "Harmony could not process this request. No cookies were changed; contact the owner if it continues.",
  route_not_found: "This secure page is no longer available. Start a new request from Discord Status.",
});

function safeDiagnostic(logger, { referenceId, service, stage, reason, status }) {
  const entry = {
    referenceId: /^[0-9a-f-]{36}$/i.test(String(referenceId || "")) ? referenceId : crypto.randomUUID(),
    service: SAFE_SERVICES.has(service) ? service : "unknown",
    stage: SAFE_STAGES.has(stage) ? stage : "callback",
    reason: SAFE_REASONS.has(reason) ? reason : "handler_failed",
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500,
  };
  // Keep the complete, allowlisted diagnostic in one log message. Some hosted
  // log collectors discard console's second object argument, which otherwise
  // leaves only a correlation ID and makes the failure stage impossible to find.
  try { logger?.warn?.(`session_refresh_failure ${JSON.stringify(entry)}`); } catch { /* logging cannot break the response */ }
  return entry.referenceId;
}

function safeError(response, code = 400, diagnostic = {}, logger = console) {
  const referenceId = safeDiagnostic(logger, { ...diagnostic, status: code });
  const message = `${SAFE_FAILURE_MESSAGES[diagnostic.reason] || SAFE_FAILURE_MESSAGES.handler_failed} Reference: ${referenceId}`;
  writeHtml(response, code, messagePage("Session refresh", message));
}

function handoffPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to secure maintenance</title><body><main><h1>Discord sign-in complete</h1><p>Continue to the secure Harmony maintenance form.</p><p><a href="/session-refresh/form">Continue to secure maintenance</a></p></main></body></html>`;
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

function isExpectedOrigin(origin) {
  if (!origin) return false;
  const expected = publicBaseUrl();
  if (!expected) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.origin === expected;
  } catch {
    return false;
  }
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
  const accountVerification = session.maintenanceType === "account_verification";
  const pageTitle = accountVerification ? `Fix ${service} account access` : `Refresh ${service} cookies`;
  const verificationNotice = accountVerification
    ? `<section><h2>Account verification required</h2><p>Harmony cannot complete a security checkpoint, identity confirmation, or other verification challenge for you. Open the official ${escapeHtml(service)} app or website, complete any requested verification there, then export a fresh session from that same account and submit it below. If the platform still shows a challenge, do not submit the export yet; Harmony will keep the current session.</p></section>`
    : "";
  const instagramIdentityNotice = service === "instagram"
    ? `<p><strong>Instagram account: Miss Harmony</strong></p><p>Export cookies from the dedicated Miss Harmony Instagram browser session${expectedInstagramUsername() ? ` (@${escapeHtml(expectedInstagramUsername())})` : ""}. Harmony verifies the signed-in username before replacing the current cookies.</p>`
    : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle}</title><style>body{font:16px system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;color:#202124}textarea{box-sizing:border-box;width:100%;min-height:18rem;font:13px monospace}button{padding:.7rem 1rem;margin-top:1rem}small{color:#555}</style><body><main><h1>${pageTitle}</h1>${verificationNotice}${instagramIdentityNotice}<p>${COOKIE_GUIDANCE[service]}</p><p>This page is protected by Discord sign-in. Harmony validates the candidate before updating the existing session. The cookie contents are sent only in this HTTPS form body; they are not saved in Harmony's database or returned in the result.</p><form method="post" action="/session-refresh/submit" enctype="application/x-www-form-urlencoded" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label for="candidate">Paste the complete cookies.txt export</label><p><textarea id="candidate" name="candidate" required autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></p><small>Do not paste this into Discord. Keep this page open until Harmony shows the result.</small><p><button type="submit">Validate and refresh cookies</button></p></form></main></body></html>`;
}

function resultPage(result) {
  const color = result.ok ? "#176b35" : result.reason === "owner_required" ? "#8a3d0a" : "#7a1e1e";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cookie refresh result</title><style>body{font:16px system-ui,sans-serif;max-width:700px;margin:3rem auto;padding:0 1rem}h1{color:${color}}</style><body><main><h1>Cookie refresh</h1><p>${escapeHtml(result.message)}</p><p>You can close this page and refresh Harmony Status in Discord.</p></main></body></html>`;
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
      maintenanceType: record.maintenance_type || "cookie_refresh",
      csrf: session.csrf,
      expiresAt: session.expiresAt,
    },
  };
}

async function handleCallback(request, response, url, { client, fetchImpl, requests, audit, workflow, authorizeActor, logger }) {
  const cookies = parseCookies(request.headers.cookie);
  const state = url.searchParams.get("state") || "";
  const stateCookie = cookies.get("harmony_refresh_oauth_state") || "";
  const saved = verifyPayload(state);
  if (!saved || saved.expiresAt <= Date.now() || !timingSafeStringEqual(state, stateCookie) || !url.searchParams.get("code")) {
    safeError(response, 401, { requestId: saved?.requestId, stage: "oauth_state", reason: "invalid_oauth_state" }, logger);
    return;
  }

  let requestRecord = requests.getRequest(saved.requestId);
  if (!requestRecord) {
    safeError(response, 410, { requestId: saved.requestId, stage: "request", reason: "request_missing" }, logger);
    return;
  }
  if (requestRecord.status !== "pending" || new Date(requestRecord.expires_at).getTime() <= Date.now()) {
    safeError(response, 410, { requestId: saved.requestId, service: requestRecord.service, stage: "request", reason: "request_expired" }, logger);
    return;
  }
  if (!isServiceRefreshAvailable(requestRecord.service)) {
    safeError(response, 410, { requestId: saved.requestId, service: requestRecord.service, stage: "request", reason: "refresh_unavailable" }, logger);
    return;
  }

  try {
    const config = configSnapshot();
    const redirectUri = `${config.publicUrl}/session-refresh/oauth/callback`;
    let accessToken;
    try { accessToken = await exchangeCode(url.searchParams.get("code"), redirectUri, fetchImpl); }
    catch {
      safeError(response, 502, { requestId: saved.requestId, service: requestRecord.service, stage: "oauth_exchange", reason: "oauth_exchange_failed" }, logger);
      return;
    }
    let identity;
    try { identity = await fetchDiscordIdentity(accessToken, fetchImpl); }
    catch {
      safeError(response, 502, { requestId: saved.requestId, service: requestRecord.service, stage: "oauth_identity", reason: "oauth_identity_failed" }, logger);
      return;
    }
    finally { accessToken = ""; }
    if (identity.id !== requestRecord.actor_id) {
      audit.recordCredentialRefreshEvent({ guildId: requestRecord.guild_id, actorId: identity.id, service: requestRecord.service, action: "request_redeemed", outcome: "failure" });
      safeError(response, 403, { requestId: saved.requestId, service: requestRecord.service, stage: "oauth_identity", reason: "identity_mismatch" }, logger);
      return;
    }
    const authorized = await authorizeActor(client, requestRecord, identity.id);
    if (!authorized) {
      audit.recordCredentialRefreshEvent({ guildId: requestRecord.guild_id, actorId: identity.id, service: requestRecord.service, action: "request_redeemed", outcome: "failure" });
      safeError(response, 403, { requestId: saved.requestId, service: requestRecord.service, stage: "actor_authorization", reason: "actor_not_authorized" }, logger);
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
      safeError(response, 410, { requestId: saved.requestId, service: requestRecord.service, stage: "request_redemption", reason: "redeem_failed" }, logger);
      return;
    }
    requestRecord = requests.getRequest(saved.requestId);
    const csrf = randomToken();
    const sessionId = signPayload({ requestId: requestRecord.request_id, csrf, expiresAt: Date.now() + WEB_SESSION_TTL_MS });
    if (!sessionId) {
      safeError(response, 503, { requestId: saved.requestId, service: requestRecord.service, stage: "web_session", reason: "session_sign_failed" }, logger);
      return;
    }
    // Do not immediately redirect from Discord's cross-site OAuth return into a
    // SameSite=Strict session. The user-initiated same-origin link below starts
    // a fresh same-site navigation while preserving Strict cookie semantics.
    writeHtml(response, 200, handoffPage(), [
      makeCookie("harmony_refresh_oauth_state", "", { path: "/session-refresh/oauth/callback", maxAge: 0, sameSite: "Lax" }),
      makeCookie("harmony_refresh_session", sessionId),
    ]);
  } catch {
    safeError(response, 502, { requestId: saved?.requestId, service: requestRecord?.service, stage: "callback", reason: "handler_failed" }, logger);
  }
}

async function handleSubmit(request, response, { client, requests, workflow, authorizeActor, logger }) {
  const existing = sessionForRequest(request, requests);
  if (!existing) { safeError(response, 401, { stage: "web_session", reason: "web_session_invalid" }, logger); return; }
  const auth = await authorizeActor(client, { guild_id: existing.session.guildId, actor_id: existing.session.actorId }, existing.session.actorId);
  if (!auth) { safeError(response, 403, { requestId: existing.session.requestId, service: existing.session.service, stage: "actor_authorization", reason: "actor_not_authorized" }, logger); return; }
  if (!String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
    safeError(response, 415, { requestId: existing.session.requestId, service: existing.session.service, stage: "form_request", reason: "unsupported_form" }, logger);
    return;
  }
  const origin = String(request.headers.origin || "");
  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  const originMatches = isExpectedOrigin(origin);
  // Some browser/webview form POSTs omit Origin despite being same-origin.
  // Accept only that narrow case when Fetch Metadata confirms same-origin;
  // the exact Host/HTTPS check and per-session CSRF token are still required.
  const sameOriginFetchWithoutOrigin = !origin && fetchSite === "same-origin";
  if (!originMatches && !sameOriginFetchWithoutOrigin) { safeError(response, 403, { requestId: existing.session.requestId, service: existing.session.service, stage: "form_origin", reason: "invalid_origin" }, logger); return; }

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
      safeError(response, 403, { requestId: existing.session.requestId, service: existing.session.service, stage: "form_csrf", reason: "invalid_oauth_state" }, logger);
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
    const tooLarge = error.message === "body_too_large";
    safeError(response, tooLarge ? 413 : 400, {
      requestId: existing?.session.requestId,
      service: existing?.session.service,
      stage: "form_body",
      reason: tooLarge ? "body_too_large" : "body_read_failed",
    }, logger);
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
  logger = console,
} = {}) {
  return async function handleSessionRefreshRequest(request, response) {
    let url;
    try { url = new URL(request.url, publicBaseUrl() || "https://localhost"); }
    catch { return false; }
    if (!url.pathname.startsWith("/session-refresh")) return false;
    const requestMatch = url.pathname.match(/^\/session-refresh\/([0-9a-f-]{36})$/i);
    const failureContext = { requestId: requestMatch?.[1] };
    try {
      if (!secureRequest(request)) {
        safeError(response, 400, { ...failureContext, stage: "https", reason: "https_required" }, logger);
        return true;
      }

      if (request.method === "GET" && requestMatch) {
        const record = requests.getRequest(requestMatch[1]);
        if (!record) {
          safeError(response, 410, { requestId: requestMatch[1], stage: "request", reason: "request_missing" }, logger);
          return true;
        }
        failureContext.requestId = record.request_id;
        failureContext.service = record.service;
        if (record.status !== "pending" || new Date(record.expires_at).getTime() <= Date.now()) {
          safeError(response, 410, { requestId: record.request_id, service: record.service, stage: "request", reason: "request_expired" }, logger);
          return true;
        }
        if (!isServiceRefreshAvailable(record.service)) {
          safeError(response, 410, { requestId: record.request_id, service: record.service, stage: "request", reason: "refresh_unavailable" }, logger);
          return true;
        }
        const oauth = oauthRedirect(record.request_id);
        if (!oauth) { safeError(response, 503, { requestId: record.request_id, service: record.service, stage: "oauth_config", reason: "oauth_unavailable" }, logger); return true; }
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
        await handleCallback(request, response, url, { client, fetchImpl, requests, audit, workflow: interactionWorkflow, authorizeActor, logger });
        return true;
      }

      if (request.method === "GET" && url.pathname === "/session-refresh/form") {
        const existing = sessionForRequest(request, requests);
        if (!existing) { safeError(response, 401, { stage: "web_session", reason: "web_session_invalid" }, logger); return true; }
        failureContext.requestId = existing.session.requestId;
        failureContext.service = existing.session.service;
        writeHtml(response, 200, formPage(existing.session));
        return true;
      }

      if (request.method === "POST" && url.pathname === "/session-refresh/submit") {
        await handleSubmit(request, response, { client, requests, workflow, authorizeActor, logger });
        return true;
      }

      safeError(response, 404, { stage: "routing", reason: "route_not_found" }, logger);
      return true;
    } catch {
      safeError(response, 500, { ...failureContext, stage: "callback", reason: "handler_failed" }, logger);
      return true;
    }
  };
}

function startSessionRefreshWebService(client, options = {}) {
  return createSessionRefreshHttpHandler({ client, ...options });
}

module.exports = {
  COOKIE_GUIDANCE,
  PAGE_HEADERS,
  isExpectedOrigin,
  createSessionRefreshHttpHandler,
  startSessionRefreshWebService,
};
