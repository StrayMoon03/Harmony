/**
 * Finds X / Twitter links inside Discord message text.
 *
 * Supports:
 * - x.com
 * - www.x.com
 * - twitter.com
 * - www.twitter.com
 * - mobile.twitter.com
 *
 * @param {string} text
 * @returns {string[]}
 */
function findXLinks(text) {
  if (!text) return [];

  const matches = text.match(
    /https?:\/\/(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)\/[^\s<]+/gi
  );

  if (!matches) return [];

  return matches.map((url) =>
    url.replace(/[)>.,!?]+$/g, "")
  );
}

/**
 * Extracts the stable X/Twitter status ID.
 *
 * Examples:
 *
 * https://x.com/username/status/123456789
 * https://twitter.com/username/status/123456789
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractXId(url) {
  if (!url) return null;

  const match = url.match(
    /\/status\/(\d+)/i
  );

  return match ? match[1] : null;
}

module.exports = {
  findXLinks,
  extractXId,
};