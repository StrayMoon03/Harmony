const { platformIcon } = require("./emojiConfig");

/**
 * Builds Harmony's media card.
 *
 * @param {object} options
 * @param {string} options.platform
 * @param {string} options.mediaType
 * @param {string} options.creator
 * @param {string} options.originalUrl
 * @param {string|number|Date|null} [options.originalDate]
 * @param {string} options.sharedById
 * @param {string|null} [options.memberComment]
 * @returns {{ header: string, footer: string, buttonLabel: string, buttonUrl: string|null }}
 */
function formatMediaCard({
  platform,
  originalUrl,
  originalDate,
  sharedById,
  memberComment,
}) {
  const parsedDate = originalDate ? new Date(originalDate) : null;
  const dateText = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "Date unavailable";
  const sharedBy = sharedById ? `<@${sharedById}>` : "Unknown member";
  const icon = platformIcon(platform);
  return {
    header: icon ? `${icon} ${platform}` : platform,
    footer: [
      `Shared by ${sharedBy} • ${dateText}`,
      memberComment ? `💬 ${sharedBy}: ${memberComment}` : null,
    ].filter((line) => line !== null).join("\n"),
    buttonLabel: `View on ${platform}`,
    buttonUrl: originalUrl || null,
  };
}

function extractOriginalDate(metadata) {
  if (!metadata) return null;
  for (const raw of [metadata.timestamp, metadata.release_timestamp, metadata.epoch]) {
    const timestamp = Number(raw || 0);
    if (timestamp > 0) {
      const milliseconds = timestamp > 1e12 ? timestamp : timestamp * 1000;
      const parsed = new Date(milliseconds);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  for (const raw of [metadata.upload_date, metadata.release_date, metadata.date]) {
    const value = String(raw || "").trim();
    if (/^\d{8}$/.test(value)) {
      return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
    }
    if (/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]+)?$/.test(value)) {
      const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  const createdAt = String(metadata.created_at || metadata.createdAt || "").trim();
  if (createdAt) {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function formatXTextPost({ displayName, handle, originalDate, text, originalUrl, sharedById, memberComment }) {
  const date = originalDate ? new Date(originalDate) : null;
  const dateText = date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "Date unavailable";
  const safeHandle = String(handle || "unknown").replace(/^@/, "");
  const sharedBy = sharedById ? `<@${sharedById}>` : "Unknown member";
  return [
    "☁️ **X Post**",
    `${displayName || safeHandle} (@${safeHandle})`,
    "",
    String(text || "").trim(),
    "",
    `Shared by ${sharedBy} • ${dateText}`,
    originalUrl ? `[View on X](${originalUrl})` : null,
    memberComment ? "" : null,
    memberComment ? `💬 ${sharedBy}: ${memberComment}` : null,
  ].filter((line) => line !== null).join("\n");
}

module.exports = {
  formatMediaCard,
  extractOriginalDate,
  formatXTextPost,
};
