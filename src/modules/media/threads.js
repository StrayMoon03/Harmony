const THREADS_URL_REGEX =
  /https?:\/\/(?:(?:www\.)?threads\.(?:com|net))\/(?:@[^\s/]+\/post\/|t\/)[A-Za-z0-9_-]+[^\s<]*/gi;

/**
 * @param {string} text
 * @returns {string[]}
 */
function findThreadsLinks(text) {
  if (!text) return [];

  return (text.match(THREADS_URL_REGEX) ?? []).map((url) =>
    url.replace(/[)>.,!?]+$/g, "")
  );
}

/**
 * Extracts the stable Threads post shortcode.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractThreadsId(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(
      /\/(?:@[^/]+\/post|t)\/([A-Za-z0-9_-]+)(?:\/|$)/i
    );
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {string|null}
 */
function extractThreadsCreator(url) {
  if (!url) return null;

  try {
    const match = new URL(url).pathname.match(
      /^\/@([^/]+)\/post\//i
    );
    return match ? `@${match[1]}` : null;
  } catch {
    return null;
  }
}

module.exports = {
  findThreadsLinks,
  extractThreadsId,
  extractThreadsCreator,
};
