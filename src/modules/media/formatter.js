/**
 * Builds Harmony's media card.
 *
 * @param {object} options
 * @param {string} options.platform
 * @param {string} options.mediaType
 * @param {string} options.creator
 * @param {string} options.originalUrl
 * @param {string} options.heart
 * @returns {string}
 */
function formatMediaCard({
  platform,
  mediaType,
  creator,
  originalUrl,
  heart,
}) {
  const safeCreator = creator || "Unknown creator";
  const safeHeart = heart || "🤍";

  const typeIcons = {
    Photo: "📷",
    "Multi-Photo": "🖼️",
    Reel: "🎬",
    Video: "🎥",
  };

  const icon = typeIcons[mediaType] || "📎";

  const safeUrl = originalUrl
    ? `<${originalUrl}>`
    : "";

  return [
    `${icon} ${platform} ${mediaType}`,
    safeCreator,
    "",
    `Original ${mediaType}`,
    safeUrl,
    "",
    `Shared by Harmony ${safeHeart}`,
  ].join("\n");
}

module.exports = {
  formatMediaCard,
};