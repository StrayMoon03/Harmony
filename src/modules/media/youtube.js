const YOUTUBE_URL_REGEX =
  /https?:\/\/(?:(?:(?:www|m|music)\.)?youtube\.com\/(?:(?:watch\?[^\s<]*\bv=[A-Za-z0-9_-]{11})|(?:shorts|live)\/[A-Za-z0-9_-]{11})|youtu\.be\/[A-Za-z0-9_-]{11})[^\s<]*/gi;

/**
 * Finds supported YouTube video links in Discord message text.
 *
 * Supports:
 * - youtube.com/watch?v=...
 * - youtube.com/shorts/...
 * - youtube.com/live/...
 * - youtu.be/...
 * - music.youtube.com/watch?v=...
 *
 * @param {string} text
 * @returns {string[]}
 */
function findYouTubeLinks(text) {
  if (!text) return [];

  const matches = text.match(YOUTUBE_URL_REGEX) ?? [];

  return matches.map((url) =>
    url.replace(/[)>.,!?]+$/g, "")
  );
}

/**
 * Extracts the stable 11-character YouTube video ID.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractYouTubeId(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    }

    if (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com")
    ) {
      if (parsed.pathname === "/watch") {
        const id = parsed.searchParams.get("v");
        return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
      }

      const match = parsed.pathname.match(
        /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/
      );
      return match ? match[1] : null;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isYouTubeShort(url) {
  try {
    return /^\/shorts\//i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

module.exports = {
  findYouTubeLinks,
  extractYouTubeId,
  isYouTubeShort,
};
