const crypto = require("node:crypto");

function safeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function sanitizedErrorText(error) {
  let value = [
    error?.name,
    error?.message,
    error?.code ? `code=${error.code}` : "",
    error?.stack,
  ].filter(Boolean).join("\n");

  value = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safeUrl(url) || "[URL removed]")
    .replace(/(authorization|token|cookie|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(c_user|xs|sessionid|csrftoken|login_info|sapISID|__secure-1papISID|__secure-3papISID)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/^.*\t(?:TRUE|FALSE)\t\/\t(?:TRUE|FALSE)\t\d+\t(?:c_user|xs|sessionid|csrftoken|login_info|sapISID|__secure-1papISID|__secure-3papISID)\t.*$/gim, "[SESSION COOKIE ROW REDACTED]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[REDACTED_LONG_VALUE]");

  return value.slice(0, 3500);
}

function fingerprint(platform, errorText) {
  const stable = String(errorText || "")
    .replace(/\d{4,}/g, "#")
    .replace(/\/app\/src\/temp\/[^\s/]+/g, "/app/src/temp/[job]")
    .slice(0, 1200);
  return crypto.createHash("sha256").update(`${platform}\n${stable}`).digest("hex").slice(0, 12);
}

module.exports = { safeUrl, sanitizedErrorText, fingerprint };
