const crypto = require("node:crypto");
const { getErrorMonitorSettings } = require("../stores/errorMonitorStore");

const recentReports = new Map();
const pendingReports = new Map();
const REPORT_DEDUPE_MS = 6 * 60 * 60 * 1000;

function repositoryParts() {
  const value = String(process.env.HARMONY_ERROR_GITHUB_REPO || "").trim();
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

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
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[REDACTED_LONG_VALUE]");

  return value.slice(0, 3500);
}

function platformFromUrl(value) {
  const url = String(value || "").toLowerCase();
  if (url.includes("instagram.com")) return "Instagram";
  if (url.includes("facebook.com") || url.includes("fb.watch")) return "Facebook";
  if (url.includes("tiktok.com")) return "TikTok";
  if (url.includes("threads.com") || url.includes("threads.net")) return "Threads";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "YouTube";
  if (url.includes("x.com") || url.includes("twitter.com")) return "X";
  return "Media";
}

function firstLink(content) {
  return String(content || "").match(/https?:\/\/[^\s<>]+/i)?.[0] || null;
}

function fingerprint(platform, errorText) {
  const stable = errorText
    .replace(/\d{4,}/g, "#")
    .replace(/\/app\/src\/temp\/[^\s/]+/g, "/app/src/temp/[job]")
    .slice(0, 1200);
  return crypto.createHash("sha256").update(`${platform}\n${stable}`).digest("hex").slice(0, 12);
}

function pruneRecent(now) {
  for (const [key, entry] of recentReports) {
    if (now - entry.timestamp >= REPORT_DEDUPE_MS) recentReports.delete(key);
  }
}

async function githubRequest(path, options = {}) {
  const token = String(process.env.HARMONY_ERROR_GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("HARMONY_ERROR_GITHUB_TOKEN is not configured.");

  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Harmony-Error-Reporter",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`GitHub error reporter returned HTTP ${response.status}.`);
  }
  return response.status === 204 ? null : response.json();
}

async function reportMediaErrorToGitHub(message, error) {
  const settings = getErrorMonitorSettings();
  if (!settings?.enabled) return false;

  const repository = repositoryParts();
  if (!repository || !process.env.HARMONY_ERROR_GITHUB_TOKEN) {
    console.warn("Harmony error monitor is on, but its GitHub variables are missing or invalid.");
    return false;
  }

  const originalUrl = firstLink(message?.content);
  const platform = platformFromUrl(originalUrl);
  const details = sanitizedErrorText(error) || "No technical error details were available.";
  const reportKey = fingerprint(platform, details);
  const dedupeKey = `${reportKey}:${safeUrl(originalUrl) || "no-link"}`;
  const now = Date.now();
  pruneRecent(now);

  if (recentReports.has(dedupeKey)) {
    console.log(`Duplicate GitHub error report suppressed: ${reportKey}`);
    return recentReports.get(dedupeKey).report;
  }
  if (pendingReports.has(dedupeKey)) return pendingReports.get(dedupeKey);

  const title = `[${platform}] Harmony media failure (${reportKey})`;
  const body = [
    "## Automatic Harmony error report",
    "",
    `- **Platform:** ${platform}`,
    `- **Occurred:** ${new Date().toISOString()}`,
    `- **Fingerprint:** \`${reportKey}\``,
    `- **Source link:** ${safeUrl(originalUrl) || "Not available"}`,
    `- **Harmony commit:** \`${String(process.env.RAILWAY_GIT_COMMIT_SHA || "unknown").slice(0, 40)}\``,
    "",
    "## Sanitized technical details",
    "",
    "~~~text",
    details,
    "~~~",
    "",
    "_Created automatically by Harmony. Credentials, cookies, user identity, Discord server/channel details, and signed URL parameters are intentionally excluded._",
  ].join("\n");

  const pending = (async () => {
    try {
      const issue = await githubRequest(
        `/repos/${repository.owner}/${repository.repo}/issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, body }),
        }
      );
      console.log(
        `Harmony created private GitHub error report #${issue.number} (${reportKey}).`
      );
      const report = {
        number: Number(issue.number),
        url: safeUrl(issue.html_url),
        fingerprint: reportKey,
      };
      recentReports.set(dedupeKey, { timestamp: Date.now(), report });
      return report;
    } catch (reportError) {
      console.error(
        "Harmony could not create the private GitHub error report:",
        reportError instanceof Error ? reportError.message : String(reportError)
      );
      return false;
    }
  })();
  pendingReports.set(dedupeKey, pending);
  try {
    return await pending;
  } finally {
    pendingReports.delete(dedupeKey);
  }
}

module.exports = { reportMediaErrorToGitHub };
