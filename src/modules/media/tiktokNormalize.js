/**
 * Resolves shortened TikTok URLs to their final URL.
 *
 * Full TikTok URLs are returned unchanged.
 *
 * Supports:
 * - tiktok.com
 * - www.tiktok.com
 * - vm.tiktok.com
 * - vt.tiktok.com
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function normalizeTikTokUrl(url) {
  if (!url) {
    throw new Error("TikTok URL is missing.");
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid TikTok URL.");
  }

  const hostname = parsed.hostname.toLowerCase();

  const isShortUrl =
  hostname === "vm.tiktok.com" ||
  hostname === "vt.tiktok.com" ||
  (
    (hostname === "tiktok.com" ||
      hostname === "www.tiktok.com") &&
    parsed.pathname.startsWith("/t/")
  );
 
  // Normal TikTok URLs do not need resolving.
  if (!isShortUrl) {
    return url;
  }

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });

    if (response.url) {
      return response.url;
    }
  } catch {
    // Some TikTok redirects do not cooperate with HEAD.
    // Fall through to GET.
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });

  if (!response.url) {
    throw new Error(
      "Harmony could not resolve this shortened TikTok link."
    );
  }

  return response.url;
}

module.exports = {
  normalizeTikTokUrl,
};
