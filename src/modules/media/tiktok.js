/**
 * Finds TikTok links inside Discord message text.
 *
 * Supports:
 * - Standard TikTok video URLs
 * - TikTok photo posts
 * - tiktok.com/t shortened links
 * - vm.tiktok.com shortened links
 * - vt.tiktok.com shortened links
 *
 * Profile pages and other non-media TikTok URLs are intentionally ignored.
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

  return matches
    .map((url) => url.replace(/[)>.,!?]+$/g, ""))
    .filter((url) => {
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();

        if (/^(?:vm|vt)\.tiktok\.com$/.test(hostname)) {
          return parsed.pathname !== "/";
        }

        if (!/^(?:www\.)?tiktok\.com$/.test(hostname)) {
          return false;
        }

        return (
          /^\/t\/[^/]+\/?$/i.test(parsed.pathname) ||
          /^\/@[^/]+\/(?:video|photo)\/\d+\/?$/i.test(parsed.pathname)
        );
      } catch {
        return false;
      }
    });
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

/**
 * Returns true when a normalized TikTok URL points to a live broadcast.
 * Live broadcasts are not stable saved media and must not enter the
 * downloader or collection ownership flow.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isTikTokLiveUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return /(^|\.)tiktok\.com$/i.test(parsed.hostname) &&
      /^\/@[^/]+\/live\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

module.exports = {
  findTikTokLinks,
  extractTikTokId,
  isTikTokLiveUrl,
};
