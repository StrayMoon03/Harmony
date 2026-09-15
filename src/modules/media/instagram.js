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
 * Selects the best still image exposed by yt-dlp for a link-only reel
 * fallback. Discord proxies the image when the message is sent, so the
 * temporary Instagram CDN URL is not exposed as Harmony's click target.
 *
 * @param {object|null|undefined} info
 * @returns {string|null}
 */
function findInstagramPreviewUrl(info) {
  const raw = info?._raw;
  const candidates = [
    raw?.thumbnail,
    ...(Array.isArray(raw?.thumbnails)
      ? [...raw.thumbnails]
          .reverse()
          .map((thumbnail) => thumbnail?.url)
      : []),
  ];

  return candidates.find((url) => {
    if (typeof url !== "string") return false;

    try {
      return new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  }) ?? null;
}

module.exports = {
  findInstagramLinks,
  extractInstagramId,
  findInstagramPreviewUrl,
};
