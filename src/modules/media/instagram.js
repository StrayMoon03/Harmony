const INSTAGRAM_URL_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?(?:\?[^\s]*)?/gi;

/**
 * Finds supported Instagram links in a Discord message.
 *
 * @param {string} content
 * @returns {string[]}
 */
function findInstagramLinks(content) {
  return content.match(INSTAGRAM_URL_REGEX) ?? [];
}

/**
 * Extracts the Instagram shortcode (media id) from a URL.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractInstagramId(url) {
  const match = url.match(
    /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i
  );
  return match ? match[1] : null;
}

/**
 * Converts a normal Instagram URL into a ddInstagram embed URL.
 *
 * @param {string} url
 * @returns {string}
 */
function createInstagramEmbedUrl(url) {
  return url.replace(
    /https?:\/\/(?:www\.)?instagram\.com/i,
    "https://ddinstagram.com"
  );
}

module.exports = {
  findInstagramLinks,
  extractInstagramId,
  createInstagramEmbedUrl,
};
