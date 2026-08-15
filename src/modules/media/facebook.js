const FACEBOOK_URL_REGEX =
  /https?:\/\/(?:(?:www|m|l)\.)?(?:facebook\.com|fb\.watch)\/[^\s<>]+/gi;

/**
 * Finds supported Facebook links in a Discord message.
 * Broad match; extractFacebookId / normalize decide processability.
 *
 * @param {string} content
 * @returns {string[]}
 */
function findFacebookLinks(content) {
  if (!content) return [];

  const matches = content.match(FACEBOOK_URL_REGEX) ?? [];

  return matches.map((url) =>
    url.replace(/[)>.,!?:;]+$/g, "")
  );
}

/**
 * Extracts the strongest Facebook media ID available from a URL.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractFacebookId(url) {
  if (!url) return null;

  const patterns = [
    /[?&]v=(\d+)/i,
    /[?&]fbid=(\d+)/i,
    /[?&]story_fbid=(\d+)/i,
    // Album/pcb nested video: /videos/pcb.123/456789
    /\/videos\/pcb\.[^/]+\/(\d+)/i,
    /\/videos\/(\d+)/i,
    /\/posts\/(\d+)/i,
    /\/reels?\/([A-Za-z0-9_-]+)/i,
    /\/share\/[vrp]\/([A-Za-z0-9_-]+)/i,
    /fb\.watch\/([A-Za-z0-9_-]+)/i,
    /\/permalink\.php\?[^#]*story_fbid=(\d+)/i,
    /\/story\.php\?[^#]*story_fbid=(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

module.exports = {
  findFacebookLinks,
  extractFacebookId,
};
