/**
 * Builds Harmony's media card.
 *
 * @param {object} options
 * @param {string} options.platform
 * @param {string} options.mediaType
 * @param {string} options.creator
 * @param {string} options.originalUrl
 * @param {string|number|Date|null} [options.originalDate]
 * @returns {string}
 */
function formatMediaCard({
  platform,
  mediaType,
  creator,
  originalUrl,
  originalDate,
}) {
  const safeCreator = creator || "Unknown creator";
  const platformIcons = {
    Instagram: "📸",
    Facebook: "🔵",
    Threads: "⚪",
    X: "⚫",
    TikTok: "🎵",
    YouTube: "🔴",
  };
  const typeIcons = {
    Photo: "📷",
    "Multi-Photo": "🖼️",
    Carousel: "🖼️",
    Reel: "🎬",
    Video: "🎥",
    Short: "🎬",
    GIF: "🎞️",
  };
  const parsedDate = originalDate ? new Date(originalDate) : null;
  const dateText = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "Date unavailable";
  const creatorText = String(safeCreator).startsWith("@")
    ? safeCreator
    : `@${safeCreator}`;
  return [
    `${platformIcons[platform] || "🔗"} ${typeIcons[mediaType] || "📎"} **${platform} ${mediaType}**`,
    `${creatorText} • ${dateText}`,
    originalUrl ? `[View on ${platform}](${originalUrl})` : null,
  ].filter(Boolean).join("\n");
}

function extractOriginalDate(metadata) {
  if (!metadata) return null;
  const timestamp = Number(metadata.timestamp || metadata.release_timestamp || 0);
  if (timestamp > 0) return new Date(timestamp * 1000);
  const value = String(metadata.upload_date || metadata.release_date || "");
  if (/^\d{8}$/.test(value)) {
    return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  }
  return null;
}

module.exports = {
  formatMediaCard,
  extractOriginalDate,
};
