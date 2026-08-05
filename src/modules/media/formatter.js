/**
 * Builds Harmony's clean media-card text.
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
  const title = `${platform} ${mediaType}`.trim();
  const sourceLabel = `Original ${mediaType}`.trim();

  return [
    title,
    "",
    creator,
    "",
    `**${sourceLabel}**`,
    originalUrl,
    "",
    `${heart} Shared by Harmony`,
  ].join("\n");
}

module.exports = {
  formatMediaCard,
};