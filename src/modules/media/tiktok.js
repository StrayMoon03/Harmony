/**
 * Finds TikTok links inside Discord message text.
 *
 * Supports:
 * - Standard TikTok URLs
 * - TikTok video posts
 * - TikTok photo posts
 * - vm.tiktok.com shortened links
 * - vt.tiktok.com shortened links
 *
 * @param {string} text
 * @returns {string[]}
 */
function findTikTokLinks(text) {
  if (!text) return [];

  const matches = text.match(
    /https?:\/\/(?:(?:www\.)?tiktok\.com\/[^\s<]+|(?:vm|vt)\.tiktok\.com\/[^\s<]+)/gi
  );

  if (!matches) return [];

  return matches.map((url) =>
    url.replace(/[)>.,!?]+$/g, "")
  );
}

/**
 * Extracts a stable TikTok media ID from
 * either a video post or a photo post.
 *
 * Examples:
 *
 * /video/123456789
 * /photo/123456789
 *
 * Shortened TikTok links may not contain the ID
 * until normalizeTikTokUrl() resolves them.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractTikTokId(url) {
  if (!url) return null;

  const mediaMatch = url.match(
    /\/(?:video|photo)\/(\d+)/i
  );

  if (mediaMatch) {
    return mediaMatch[1];
  }

  return null;
}

module.exports = {
  findTikTokLinks,
  extractTikTokId,
};