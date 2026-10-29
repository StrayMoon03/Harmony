const { SESSION_PATH_ENV } = require("./runtimeSecrets");
const fs = require("node:fs");

const SECRET_VARIABLES = Object.freeze({
  instagram: "INSTAGRAM_COOKIES_BASE64",
  threads: "THREADS_COOKIES_BASE64",
  facebook: "FACEBOOK_COOKIES_BASE64",
  youtube: "YOUTUBE_COOKIES_BASE64",
});

function normalizeInstagramUsername(value) {
  const username = String(value || "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(username) ? username : null;
}

function expectedInstagramUsername(env = process.env) {
  return normalizeInstagramUsername(env.INSTAGRAM_EXPECTED_USERNAME);
}

function publicBaseUrl(env = process.env) {
  const raw = String(env.SESSION_REFRESH_PUBLIC_URL || "").trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function oauthConfigured(env = process.env) {
  return Boolean(publicBaseUrl(env) && env.DISCORD_OAUTH_CLIENT_ID && env.DISCORD_OAUTH_CLIENT_SECRET);
}

function rotationConfigured(env = process.env) {
  return Boolean(env.SESSION_REFRESH_RAILWAY_PROJECT_TOKEN && env.SESSION_REFRESH_RAILWAY_SERVICE_ID);
}

function isServiceRefreshAvailable(service, { env = process.env, fsImpl = fs } = {}) {
  const base64Name = SECRET_VARIABLES[service];
  const pathName = SESSION_PATH_ENV[service];
  const cookiePath = pathName && env[pathName];
  if (!base64Name || !pathName || !env[base64Name] || !cookiePath || !oauthConfigured(env) || !rotationConfigured(env)) return false;
  if (service === "instagram" && !expectedInstagramUsername(env)) return false;
  try {
    return fsImpl.statSync(cookiePath).isFile();
  } catch {
    return false;
  }
}

function configuredServiceName(service) {
  return SECRET_VARIABLES[service] || null;
}

function configSnapshot(env = process.env) {
  return {
    publicUrl: publicBaseUrl(env),
    oauthClientId: env.DISCORD_OAUTH_CLIENT_ID || "",
    oauthClientSecret: env.DISCORD_OAUTH_CLIENT_SECRET || "",
    railwayProjectToken: env.SESSION_REFRESH_RAILWAY_PROJECT_TOKEN || "",
    railwayServiceId: env.SESSION_REFRESH_RAILWAY_SERVICE_ID || "",
  };
}

module.exports = { SECRET_VARIABLES, normalizeInstagramUsername, expectedInstagramUsername, publicBaseUrl, oauthConfigured, rotationConfigured, isServiceRefreshAvailable, configuredServiceName, configSnapshot };
