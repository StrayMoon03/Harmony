const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { probeFile } = require("./downloader");
const { extractThreadsCreator } = require("./threads");
const { withBrowserLock } = require("./browserLock");

const execFileAsync = promisify(execFile);
const TEMP_ROOT = path.resolve(__dirname, "../../temp");
const THREADS_BROWSER_HELPER = path.join(
  __dirname,
  "threadsBrowser.py"
);
const THREADS_PLACEHOLDER_HASHES = [
  0x187cfeffff7e7c18n,
  0x187e7effff7e3e18n,
];

function logThreadsBrowserDiagnostics(stdout) {
  const keys = [
    "pageSignalsAvailable", "loginPromptVisible", "loginRoute",
    "checkpointRoute", "restrictionNoticeVisible", "unavailableNoticeVisible",
    "accountMenuVisible", "exactRecordSeen", "rootVideoDeclared",
    "attachedVideoDeclared", "exactRecordHasImageVersions",
    "exactNestedSameCodeRecordSeen",
  ];
  const line = String(stdout || "").split(/\r?\n/).find((value) =>
    value.startsWith("HARMONY_THREADS_DIAGNOSTICS:")
  );
  let data = null;
  try {
    data = line ? JSON.parse(line.slice("HARMONY_THREADS_DIAGNOSTICS:".length)) : null;
  } catch {
    // Diagnostics must never interrupt media processing.
  }
  const safe = Object.fromEntries(keys.map((key) => [key, data?.[key] === true]));
  safe.authenticationEvidence = safe.accountMenuVisible ? "authenticated_ui" : "not_confirmed";
  console.log("Threads browser diagnostics:", safe);
  return safe;
}

async function readThreadsCookieHeader(hostname) {
  const cookiesPath = process.env.THREADS_COOKIES;
  if (!cookiesPath) return "";

  try {
    const text = await fs.readFile(cookiesPath, "utf8");
    const now = Math.floor(Date.now() / 1000);
    const cookies = [];

    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("#HttpOnly_")) {
        line = line.slice("#HttpOnly_".length);
      } else if (line.startsWith("#")) {
        continue;
      }

      const parts = line.split("\t");
      if (parts.length < 7) continue;

      const [rawDomain, , , , rawExpiry, name, ...valueParts] =
        parts;
      const domain = rawDomain.replace(/^\./, "").toLowerCase();
      const requestHost = hostname.toLowerCase();
      const expiry = Number(rawExpiry);
      const alternateDomain = domain.endsWith("threads.com")
        ? domain.replace(/threads\.com$/i, "threads.net")
        : domain.endsWith("threads.net")
          ? domain.replace(/threads\.net$/i, "threads.com")
          : "";

      const hostMatches = (cookieDomain) =>
        Boolean(cookieDomain) &&
        (requestHost === cookieDomain ||
          requestHost.endsWith("." + cookieDomain));

      if (
        !name ||
        (Number.isFinite(expiry) && expiry > 0 && expiry < now) ||
        (!hostMatches(domain) && !hostMatches(alternateDomain))
      ) {
        continue;
      }

      cookies.push(name + "=" + valueParts.join("\t"));
    }

    return cookies.join("; ");
  } catch {
    console.warn("Threads session file could not be read.");
    return "";
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return match;
      }
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return match;
      }
    });
}

function decodePageText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/\\u0025/gi, "%")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u003a/gi, ":")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&quot;/gi, '"'));
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodePageText(match[1]);
  }
  return null;
}

function validCdnUrl(raw) {
  try {
    const parsed = new URL(decodePageText(raw));
    const host = parsed.hostname.toLowerCase();
    if (
      host.startsWith("static.") ||
      parsed.pathname.includes("/rsrc.php/")
    ) {
      return null;
    }
    if (
      !host.endsWith(".fbcdn.net") &&
      !host.endsWith(".cdninstagram.com") &&
      !host.endsWith(".threads.net") &&
      !host.endsWith(".threads.com") &&
      host !== "media.discordapp.net" &&
      !host.endsWith(".discordapp.net")
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function firstUrlAfterKey(html, key, windowSize = 12000) {
  const results = [];
  let from = 0;

  while (from < html.length) {
    const index = html.indexOf(key, from);
    if (index === -1) break;

    const window = decodePageText(
      html.slice(index, index + windowSize)
    );
    const matches = window.match(
      /https:\/\/[^"'\\s<>}]+/gi
    ) || [];

    const found = matches
      .map(validCdnUrl)
      .find(Boolean);

    if (found) results.push(found);
    from = index + key.length;
  }

  return results;
}

function inspectThreadsPage(html) {
  const cdnMatches =
    html.match(
      /https:\/\/[^"'\\s<>}]+(?:fbcdn\.net|cdninstagram\.com)[^"'\\s<>}]*/gi
    ) || [];

  return {
    characters: html.length,
    hasOgImage: /(?:property|name)=["']og:image["']/i.test(html),
    hasOgVideo: /(?:property|name)=["']og:video(?::secure_url)?["']/i.test(html),
    hasImageVersions: html.includes('"image_versions2"'),
    hasVideoVersions: html.includes('"video_versions"'),
    hasLoginPrompt: /log in|sign up|create (?:a new )?account/i.test(html),
    cdnUrlCount: cdnMatches.length,
  };
}

function findThreadsPostRecord(value, expectedCode) {
  if (!value || typeof value !== "object") return null;

  if (
    !Array.isArray(value) &&
    String(value.code || "") === expectedCode
  ) {
    return value;
  }

  const children = Array.isArray(value)
    ? value
    : Object.values(value);
  for (const child of children) {
    const found = findThreadsPostRecord(child, expectedCode);
    if (found) return found;
  }
  return null;
}

function bestThreadsMediaCandidate(media) {
  if (!media || typeof media !== "object") return null;

  const video = Array.isArray(media.video_versions)
    ? media.video_versions
        .map((item) => validCdnUrl(item?.url))
        .find(Boolean)
    : null;
  if (video) return video;

  const images = Array.isArray(media.image_versions2?.candidates)
    ? media.image_versions2.candidates
    : [];
  return images
    .slice()
    .sort(
      (first, second) =>
        Number(second?.width || 0) * Number(second?.height || 0) -
        Number(first?.width || 0) * Number(first?.height || 0)
    )
    .map((item) => validCdnUrl(item?.url))
    .find(Boolean) || null;
}

function collectThreadsPostRecordMedia(post) {
  const candidates = [];
  const items = Array.isArray(post?.carousel_media)
    ? post.carousel_media
    : [post];

  for (const item of items) {
    const candidate = bestThreadsMediaCandidate(item);
    if (candidate) candidates.push(candidate);
  }

  // A Threads text post can quote or repost another post whose media is
  // intentionally displayed as part of the requested root post. Use it only
  // when the root post itself has no downloadable attachment.
  if (candidates.length === 0) {
    const shareInfo = post?.text_post_app_info?.share_info || {};
    const attachedPost =
      post?.text_post_app_info?.linked_inline_media ||
      shareInfo.quoted_attachment_post ||
      shareInfo.quoted_post ||
      shareInfo.reposted_post ||
      post?.reposted_post ||
      null;
    if (attachedPost) {
      const attachedItems = Array.isArray(attachedPost.carousel_media)
        ? attachedPost.carousel_media
        : [attachedPost];
      for (const item of attachedItems) {
        const candidate = bestThreadsMediaCandidate(item);
        if (candidate) candidates.push(candidate);
      }
    }
  }

  return [...new Set(candidates)];
}

function collectPostScopedJsonMedia(html, exactPostUrl) {
  let expectedCode = null;
  try {
    const match = decodeURIComponent(new URL(exactPostUrl).pathname)
      .match(/\/post\/([A-Za-z0-9_-]+)\/?$/i);
    expectedCode = match?.[1] || null;
  } catch {
    return [];
  }
  if (!expectedCode) return [];

  const scripts = String(html || "").matchAll(
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const match of scripts) {
    try {
      const data = JSON.parse(match[1]);
      const post = findThreadsPostRecord(data, expectedCode);
      if (post) return collectThreadsPostRecordMedia(post);
    } catch {
      // Ignore unrelated or incomplete script payloads.
    }
  }
  return [];
}

function collectCandidateUrls(html) {
  const videos = firstUrlAfterKey(html, '"video_versions"');
  const images = firstUrlAfterKey(html, '"image_versions2"');

  const ogVideo =
    metaContent(html, "og:video:secure_url") ||
    metaContent(html, "og:video");
  const ogImage = metaContent(html, "og:image");

  const ordered = [
    ...videos,
    ...images,
    ogVideo,
    ogImage,
  ]
    .map(validCdnUrl)
    .filter(Boolean);

  return [
    ...new Map(
      ordered.map((url) => {
        const parsed = new URL(url);
        return [`${parsed.hostname}${parsed.pathname}`, url];
      })
    ).values(),
  ].slice(0, 20);
}


function threadsExactPostShortcode(url) {
  try {
    const match = decodeURIComponent(new URL(url).pathname).match(
      /\/@[^/]+\/post\/([A-Za-z0-9_-]+)\/?$/i
    );
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function canonicalHref(html) {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match) return decodePageText(match[1]);
  }
  return null;
}

function normalizePostText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function threadsPostTextsCompatible(knownText, pageText) {
  const known = normalizePostText(knownText);
  const page = normalizePostText(pageText);
  if (!known || !page) return true;
  if (known.includes(page) || page.includes(known)) return true;
  const limit = Math.min(known.length, page.length);
  let shared = 0;
  while (shared < limit && known[shared] === page[shared]) shared += 1;
  return shared >= 40 || (shared >= 12 && shared / limit >= 0.5);
}

function exactPostDeclaresVideo(html, expectedCode) {
  const text = decodePageText(String(html || ""));
  const escaped = String(expectedCode).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`"code"\\s*:\\s*"${escaped}"`));
  if (!match || match.index == null) return false;
  const start = match.index;
  const rest = text.slice(start + match[0].length);
  const nextCode = rest.search(/"code"\s*:\s*"/);
  const window = text.slice(
    start,
    nextCode === -1 ? start + 12000 : start + match[0].length + nextCode
  );
  return (
    /"media_type"\s*:\s*2\b/.test(window) ||
    /"video_versions"\s*:\s*\[\s*\{/.test(window)
  );
}

/**
 * Last-resort Open Graph media for an exact post (or a resolved /share/ URL).
 * Requires the page's own canonical/og:url shortcode to match the requested
 * post. When a known post text and og:description are both available, they
 * must also be compatible. Never returns media from a different or nested post.
 */
function collectExactOpenGraphFallback(html, requestedPostUrl, options = {}) {
  const expectedCode = threadsExactPostShortcode(requestedPostUrl);
  if (!expectedCode) return null;

  const pageUrl = exactThreadsPostUrl(
    metaContent(html, "og:url") || canonicalHref(html),
    requestedPostUrl
  );
  if (!pageUrl) return null;
  const pageCode = threadsExactPostShortcode(pageUrl);
  if (!pageCode || pageCode.toLowerCase() !== expectedCode.toLowerCase()) {
    return null;
  }

  const description =
    metaContent(html, "og:description") ||
    metaContent(html, "description") ||
    metaContent(html, "twitter:description");
  if (
    options.knownText &&
    description &&
    !threadsPostTextsCompatible(options.knownText, description)
  ) {
    return null;
  }

  const ogVideo = validCdnUrl(
    metaContent(html, "og:video:secure_url") ||
      metaContent(html, "og:video:url") ||
      metaContent(html, "og:video")
  );
  const ogImage = validCdnUrl(
    metaContent(html, "og:image") ||
      metaContent(html, "og:image:url") ||
      metaContent(html, "twitter:image")
  );
  // Crawler HTML for a public post often embeds the exact post record (the
  // JSON object whose "code" is this post's shortcode) with its real
  // video_versions. That record is identity-checked by shortcode, so it is
  // as trustworthy as the page's own og:url and gives the real video instead
  // of only a thumbnail.
  const scopedMedia = collectPostScopedJsonMedia(html, requestedPostUrl);
  const scopedVideo = scopedMedia.find((item) => /\.mp4(?:$|[?#])/i.test(item)) || null;
  const video = scopedVideo || ogVideo;
  if (!video && !ogImage && scopedMedia.length === 0) return null;

  const candidates = video
    ? [...new Set([video, ...scopedMedia, ogVideo, ogImage].filter(Boolean))]
    : scopedMedia.length
      ? [...new Set([...scopedMedia, ogImage].filter(Boolean))]
      : [ogImage];

  return {
    canonicalUrl: pageUrl,
    video,
    image: ogImage,
    candidates,
    scopedMediaCount: scopedMedia.length,
    videoPost: Boolean(video) || exactPostDeclaresVideo(html, expectedCode),
    description,
    creator: extractThreadsCreator(pageUrl),
  };
}

async function fetchExactOpenGraphFallback(requestedPostUrl, options = {}) {
  if (!threadsExactPostShortcode(requestedPostUrl)) return null;

  const urls = [requestedPostUrl];
  try {
    const parsed = new URL(requestedPostUrl);
    const alternate = new URL(requestedPostUrl);
    alternate.hostname = parsed.hostname.endsWith("threads.com")
      ? parsed.hostname.replace(/threads\.com$/i, "threads.net")
      : parsed.hostname.replace(/threads\.net$/i, "threads.com");
    if (alternate.toString() !== parsed.toString()) {
      urls.push(alternate.toString());
    }
  } catch {
    return null;
  }

  const userAgents = [
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  ];

  // Public crawler pages do not need a session. Try them without cookies
  // first: a logged-in-but-unconfirmed session can make Threads serve a
  // stripped app shell. Fall back to the session only if anonymous fails.
  const hasCookies = Boolean(process.env.THREADS_COOKIES);
  const cookieModes = hasCookies ? [false, true] : [false];
  let imageOnly = null;

  for (const withCookies of cookieModes) {
    for (const candidate of urls) {
      for (const userAgent of userAgents) {
        const attempt = {
          host: (() => { try { return new URL(candidate).hostname; } catch { return ""; } })(),
          agent: userAgent.startsWith("facebookexternalhit") ? "facebook" : "discord",
          withCookies,
          status: 0,
          characters: 0,
          matched: false,
          hasVideo: false,
          hasImage: false,
          scopedMediaCount: 0,
        };
        try {
          const cookieHeader = withCookies
            ? await readThreadsCookieHeader(new URL(candidate).hostname)
            : "";
          const response = await fetch(candidate, {
            redirect: "follow",
            headers: {
              "User-Agent": userAgent,
              Accept: "text/html,application/xhtml+xml",
              "Accept-Language": "en-US,en;q=0.9",
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            signal: AbortSignal.timeout(8000),
          });
          attempt.status = response.status;
          // Where Threads actually sent us (a login wall shows up as /login
          // or /) and which post the page says it is. Diagnostics only.
          try { attempt.finalPath = new URL(response.url || candidate).pathname; } catch {}
          if (!response.ok) {
            console.log("Threads exact-post crawler attempt:", attempt);
            continue;
          }
          const html = await response.text();
          attempt.characters = html.length;
          try {
            const pageUrl = metaContent(html, "og:url") || canonicalHref(html);
            attempt.pageOgPath = pageUrl
              ? decodePageText(new URL(decodePageText(pageUrl), candidate).pathname)
              : null;
          } catch {
            attempt.pageOgPath = null;
          }
          const fallback = collectExactOpenGraphFallback(
            html,
            requestedPostUrl,
            { knownText: options.knownText }
          );
          attempt.matched = Boolean(fallback);
          attempt.hasVideo = Boolean(fallback?.video);
          attempt.hasImage = Boolean(fallback?.image);
          attempt.scopedMediaCount = fallback?.scopedMediaCount || 0;
          console.log("Threads exact-post crawler attempt:", attempt);
          if (fallback?.video) return fallback;
          if (fallback && !imageOnly) imageOnly = fallback;
        } catch {
          console.log("Threads exact-post crawler attempt:", { ...attempt, failed: true });
        }
      }
    }
    // An anonymous thumbnail is enough to stop; the session pass is only
    // for pages anonymous crawlers could not open at all.
    if (imageOnly) return imageOnly;
  }
  return imageOnly;
}

function isThreadsShareUrl(url) {
  try {
    return /^\/share\//i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function shouldUseScopedBrowserDirectly(wasShareUrl, url) {
  return wasShareUrl === true || isExactThreadsPostUrl(url);
}

function isExactThreadsPostUrl(url) {
  try {
    return /^\/@[^/]+\/post\/[A-Za-z0-9_-]+\/?$/i.test(
      new URL(url).pathname
    );
  } catch {
    return false;
  }
}

function exactThreadsPostUrl(raw, baseUrl) {
  try {
    const parsed = new URL(raw, baseUrl);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      !(
        host === "threads.com" ||
        host.endsWith(".threads.com") ||
        host === "threads.net" ||
        host.endsWith(".threads.net")
      ) ||
      !/^\/@[^/]+\/post\/[A-Za-z0-9_-]+\/?$/i.test(
        decodeURIComponent(parsed.pathname)
      )
    ) {
      return null;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function resolveThreadsShareRedirect(url) {
  const userAgents = [
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  ];

  const attempts = userAgents.flatMap((userAgent) =>
    ["HEAD", "GET"].map(async (method) => {
      try {
        const response = await fetch(url, {
          method,
          redirect: "manual",
          headers: {
            "User-Agent": userAgent,
            Accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(3000),
        });
        const location = response.headers.get("location");
        const redirectUrl = location
          ? exactThreadsPostUrl(location, url)
          : null;
        if (redirectUrl) {
          console.log("Threads share redirect resolved:", {
            finalPath: new URL(redirectUrl).pathname,
          });
          return redirectUrl;
        }

        if (method === "GET" && response.ok) {
          const html = await response.text();
          const ogUrl = metaContent(decodePageText(html), "og:url");
          const canonicalUrl = exactThreadsPostUrl(ogUrl, url);
          if (canonicalUrl) {
            console.log("Threads share OG identity resolved:", {
              finalPath: new URL(canonicalUrl).pathname,
            });
            return canonicalUrl;
          }
        }
      } catch {
        console.warn(`Threads share ${method} resolution attempt failed.`);
      }

      return null;
    })
  );

  const results = await Promise.all(attempts);
  const resolved = results.find(Boolean);
  if (resolved) return resolved;

  return null;
}

function logChromiumIdentity(stderr) {
  // The Python helper reports its Chromium executable and version on stderr,
  // which Node otherwise discards on success. Surface only those lines.
  for (const line of String(stderr || "").split(/\r?\n/)) {
    if (/^Harmony Chromium (executable|version):/.test(line)) {
      console.log(line.slice(0, 300));
    }
  }
}

async function inspectThreadsWithBrowser(url, browserOptions = {}) {
  const pythonPath = process.env.PYTHON_PATH || "python3";
  const cookiePath = browserOptions.withoutCookies
    ? ""
    : process.env.THREADS_COOKIES || "";
  const timeoutMs = browserOptions.timeoutMs || 75000;

  console.log(
    browserOptions.withoutCookies
      ? "Threads browser fallback starting (without cookies)."
      : "Threads browser fallback starting."
  );

  try {
    const { stdout, stderr } = await withBrowserLock(() =>
      execFileAsync(
        pythonPath,
        [THREADS_BROWSER_HELPER, url, cookiePath],
        {
          windowsHide: true,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 5 * 1024 * 1024,
          encoding: "utf8",
        }
      )
    );

    logChromiumIdentity(stderr);
    const line = String(stdout)
      .split(/\r?\n/)
      .find((value) =>
        value.startsWith("HARMONY_THREADS_BROWSER:")
      );
    if (!line) {
      throw new Error(
        "browser helper returned no result"
      );
    }

    const diagnostics = logThreadsBrowserDiagnostics(stdout);
    const result = JSON.parse(
      line.slice("HARMONY_THREADS_BROWSER:".length)
    );
    const cookieCount = Number(result.cookieCount) || 0;
    const authFailure = cookieCount > 0 && diagnostics.checkpointRoute
      ? { kind: "owner", category: "checkpoint" }
      : cookieCount > 0 && (diagnostics.loginRoute || diagnostics.loginPromptVisible)
        ? { kind: "session", category: "login_required" }
        : null;
    const candidates = Array.isArray(result.candidates)
      ? result.candidates
          .map(validCdnUrl)
          .filter(Boolean)
          .slice(0, 20)
      : [];

    console.log("Threads browser fallback complete:", {
      cookieCount,
      candidateCount: candidates.length,
      finalPath: (() => {
        try {
          return new URL(
            typeof result.finalUrl === "string" ? result.finalUrl : url
          ).pathname;
        } catch {
          return "";
        }
      })(),
    });

    return {
      candidates,
      finalUrl:
        typeof result.finalUrl === "string"
          ? result.finalUrl
          : url,
      authFailure,
      cookieCount,
    };
  } catch (error) {
    logChromiumIdentity(error?.stderr);
    logThreadsBrowserDiagnostics(error?.stdout);
    if (
      error &&
      (error.killed || error.signal === "SIGKILL")
    ) {
      throw new Error(
        `Threads browser took longer than ${Math.round(timeoutMs / 1000)} seconds.`
      );
    }

    const stderrText = String(error?.stderr || "");
    const stderr = stderrText
      .split(/\r?\n/)
      .find((line) =>
        line.startsWith(
          "HARMONY_THREADS_BROWSER_ERROR:"
        )
      ) || "";
    console.error("Threads browser helper failed:", {
      exitCode: Number.isInteger(error?.code)
        ? error.code
        : null,
      signal: error?.signal || null,
      hasStructuredError: Boolean(stderr),
    });

    throw new Error(
      stderr ||
        "Threads browser could not inspect this post."
    );
  }
}

async function getImageDimensions(filePath) {
  try {
    const { stdout } = await execFileAsync(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        filePath,
      ],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }
    );

    const match = String(stdout).trim().match(/^(\d+)x(\d+)/);
    if (!match) return null;

    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 300 || height < 300) return null;

    return { width, height, area: width * height };
  } catch {
    return null;
  }
}

async function imagePerceptualHash(filePath) {
  try {
    const { stdout } = await execFileAsync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        filePath,
        "-vf",
        "scale=8:8,format=gray",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        encoding: "buffer",
      }
    );

    const pixels = Buffer.from(stdout).subarray(0, 64);
    if (pixels.length !== 64) return null;

    const average =
      pixels.reduce((total, value) => total + value, 0) /
      pixels.length;
    let hash = 0n;
    pixels.forEach((value, index) => {
      if (value >= average) {
        hash |= 1n << BigInt(index);
      }
    });
    return hash;
  } catch {
    return null;
  }
}

function perceptualHashDistance(first, second) {
  let value = first ^ second;
  let distance = 0;
  while (value) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}

function isKnownThreadsPlaceholder(imageHash) {
  if (imageHash === null) return false;

  return THREADS_PLACEHOLDER_HASHES.some(
    (placeholderHash) =>
      perceptualHashDistance(
        imageHash,
        placeholderHash
      ) <= 10
  );
}

async function fetchThreadsPage(url) {
  const original = new URL(url);
  const canonical = new URL(url);
  canonical.pathname = canonical.pathname.replace(
    /\/media\/?$/i,
    ""
  );

  const alternate = new URL(canonical);
  alternate.hostname =
    canonical.hostname.endsWith("threads.com")
      ? "www.threads.net"
      : "www.threads.com";

  const errors = [];
  let bestPage = null;
  const hasThreadsCookies = Boolean(process.env.THREADS_COOKIES);

  console.log(
    hasThreadsCookies
      ? "Threads cookies: ready."
      : "Threads cookies: missing — public pages may return an empty app shell."
  );

  const exactPostRequest = isExactThreadsPostUrl(url);
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    ...(exactPostRequest
      ? ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"]
      : []),
  ];

  for (const candidate of [
    canonical.toString(),
    alternate.toString(),
    original.toString(),
  ]) {
    for (const userAgent of userAgents) try {
      const candidateHost = new URL(candidate).hostname;
      const cookieHeader =
        await readThreadsCookieHeader(candidateHost);
      const response = await fetch(candidate, {
        redirect: "follow",
        headers: {
          "User-Agent": userAgent,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      });

      if (!response.ok) {
        errors.push(`${candidate}: HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();
      if (html.length > 1000) {
        const decodedHtml = decodePageText(html);
        const mediaCandidateCount =
          collectCandidateUrls(decodedHtml).length;
        const scopedCandidates = exactPostRequest
          ? collectPostScopedJsonMedia(html, url)
          : [];
        const cookieCount = cookieHeader
          ? cookieHeader.split("; ").length
          : 0;
        const page = {
          html,
          finalUrl: response.url || candidate,
          sourceUrl: candidate,
          status: response.status,
          scopedCandidates,
        };

        console.log("Threads page candidate:", {
          sourceHost: candidateHost,
          finalHost: new URL(page.finalUrl).hostname,
          status: response.status,
          characters: html.length,
          cookieCount,
          mediaCandidateCount,
          scopedCandidateCount: scopedCandidates.length,
        });

        if (
          scopedCandidates.length > 0 ||
          (!exactPostRequest && mediaCandidateCount > 0)
        ) {
          return page;
        }

        if (!bestPage || html.length > bestPage.html.length) {
          bestPage = page;
        }
      }
    } catch {
      errors.push("request failed or timed out");
    }
  }

  if (bestPage) {
    return bestPage;
  }

  throw new Error(
    "Threads post page could not be opened. " +
      errors.join(" | ")
  );
}

/**
 * Downloads public media from one Threads post page.
 *
 * @param {string} url
 * @returns {Promise<{
 *   files: Array<object>,
 *   rawDir: string,
 *   platform: string,
 *   creator: string|null
 * }>}
 */
async function downloadThreadsMedia(url, options = {}) {
  await fs.mkdir(TEMP_ROOT, { recursive: true });

  const jobDir = path.join(
    TEMP_ROOT,
    `threads-${Date.now()}-${randomUUID()}`
  );
  await fs.mkdir(jobDir, { recursive: true });
  let authFailure = null;

  try {
    console.log("Threads page inspection starting.");

    const shareUrl = isThreadsShareUrl(url);
    if (shareUrl) {
      // Threads' share page often renders only a login shell in Chromium and
      // never exposes its canonical post. Resolve the public alias first, but
      // keep the attempts parallel and tightly bounded so the scoped browser
      // still has most of Harmony's retrieval window.
      const resolvedUrl = await resolveThreadsShareRedirect(url);
      if (resolvedUrl) url = resolvedUrl;
    }
    let html = "";
    let sourceUrl = url;
    let status = 0;
    let finalUrl = url;
    let pageFetchFailed = false;
    let fallbackCreator = null;
    let scopedCandidates = [];
    let openGraphFallback = null;

    if (shouldUseScopedBrowserDirectly(shareUrl, url)) {
      // Exact posts and share aliases both require the scoped browser. The
      // browser follows a share redirect and verifies the resulting root post,
      // so resolving the alias in a separate network pass only wastes the
      // public processing window.
      pageFetchFailed = true;
      console.log(
        "Threads scoped URL identified; using browser inspection directly."
      );
    } else {
      try {
        const pageResult = await fetchThreadsPage(url);
        html = pageResult.html;
        sourceUrl = pageResult.sourceUrl;
        status = pageResult.status;
        finalUrl = pageResult.finalUrl;
        scopedCandidates = pageResult.scopedCandidates || [];
      } catch {
        pageFetchFailed = true;
        console.warn("Threads static page fetch failed; continuing with browser.");
      }
    }

    const decodedHtml = decodePageText(html);
    const diagnostics = html
      ? inspectThreadsPage(decodedHtml)
      : {
          characters: 0,
          hasOgImage: false,
          hasOgVideo: false,
          hasImageVersions: false,
          hasVideoVersions: false,
          hasLoginPrompt: false,
          cdnUrlCount: 0,
        };
    const postScopedBrowserRequired =
      shareUrl ||
      pageFetchFailed ||
      isExactThreadsPostUrl(url) ||
      isExactThreadsPostUrl(finalUrl);
    let candidates = scopedCandidates.length > 0
      ? scopedCandidates
      : postScopedBrowserRequired
        ? []
        : collectCandidateUrls(decodedHtml);

    console.log("Threads page diagnostics:", {
      status,
      sourceHost: new URL(sourceUrl).hostname,
      finalHost: new URL(finalUrl).hostname,
      ...diagnostics,
      candidateCount: candidates.length,
      postScopedBrowserRequired,
    });

    // Static Threads HTML can contain media from suggested or neighboring
    // feed posts. For a share URL or an exact post URL, never trust those
    // page-wide candidates. The browser helper scopes extraction to the root
    // post article; if it cannot prove that scope, fail closed instead of
    // uploading unrelated media.
    if (candidates.length === 0) {
      const browserStartedAt = Date.now();
      let browserCookieCount = 0;
      let browserTimedOut = false;
      try {
        const browserResult =
          await inspectThreadsWithBrowser(finalUrl);
        authFailure ||= browserResult.authFailure;
        browserCookieCount = browserResult.cookieCount || 0;
        candidates = browserResult.candidates;
        finalUrl = browserResult.finalUrl || finalUrl;
        if (candidates.length === 0) {
          throw new Error(
            "Threads browser returned no media; checking the original message preview."
          );
        }
      } catch (browserError) {
        browserTimedOut = /took longer than/i.test(String(browserError?.message || ""));
        const identityUrl = isExactThreadsPostUrl(finalUrl)
          ? finalUrl
          : isExactThreadsPostUrl(url)
            ? url
            : null;

        const useOpenGraph = (openGraph, reason) => {
          candidates = openGraph.candidates;
          finalUrl = openGraph.canonicalUrl || finalUrl;
          fallbackCreator = openGraph.creator || fallbackCreator;
          openGraphFallback = openGraph;
          console.log(
            `Threads using exact-post crawler media (${reason}; video: ${Boolean(openGraph.video)}).`
          );
        };

        // 1. The public crawler page for the exact post. It is fast and
        //    often carries the real video, so try it before anything that
        //    could only give a thumbnail.
        const openGraph = identityUrl
          ? await fetchExactOpenGraphFallback(identityUrl, {
              knownText: options.knownText || null,
            })
          : null;
        if (openGraph?.video) {
          useOpenGraph(openGraph, "browser found none");
        }

        // 2. A browser session that found the exact record but no media may
        //    be a degraded logged-in view. Retry once without cookies while
        //    there is still time in the processing window.
        if (
          candidates.length === 0 &&
          browserCookieCount > 0 &&
          !browserTimedOut &&
          !authFailure &&
          Date.now() - browserStartedAt < 30000
        ) {
          try {
            const anonymous = await inspectThreadsWithBrowser(finalUrl, {
              withoutCookies: true,
              timeoutMs: 45000,
            });
            if (anonymous.candidates.length) {
              candidates = anonymous.candidates;
              finalUrl = anonymous.finalUrl || finalUrl;
              console.log(
                `Threads cookieless browser retry found ${candidates.length} media candidate(s).`
              );
            }
          } catch (retryError) {
            console.warn(
              "Threads cookieless browser retry failed:",
              retryError instanceof Error ? retryError.message : retryError
            );
          }
        }

        // 3. Discord's own embed of the exact message.
        let fallback = null;
        if (candidates.length === 0) {
          fallback = typeof options.getDiscordEmbedFallback === "function"
            ? await options.getDiscordEmbedFallback(finalUrl)
            : options.discordEmbedFallback;
          const fallbackCandidates = Array.isArray(fallback?.candidates)
            ? fallback.candidates.map(validCdnUrl).filter(Boolean)
            : [];
          if (fallbackCandidates.length) {
            candidates = fallbackCandidates;
            finalUrl = fallback.finalUrl || finalUrl;
            fallbackCreator = fallback.creator || null;
            console.log(
              `Threads using ${candidates.length} media candidate(s) from Discord's exact-message embed.`
            );
          }
        }

        // 4. The exact post's Open Graph thumbnail, labeled as a preview.
        if (candidates.length === 0 && openGraph?.candidates?.length) {
          const knownText = options.knownText || fallback?.description || null;
          if (
            !knownText ||
            !openGraph.description ||
            threadsPostTextsCompatible(knownText, openGraph.description)
          ) {
            useOpenGraph(openGraph, "browser and Discord preview found none");
          }
        }

        if (candidates.length === 0) {
          console.warn("Threads exact-post fallbacks found no media.", {
            exactIdentity: Boolean(identityUrl),
            crawlerMatched: Boolean(openGraph),
          });
          throw browserError;
        }
      }
    }

    if (
      shareUrl &&
      !isExactThreadsPostUrl(finalUrl) &&
      !isThreadsShareUrl(finalUrl)
    ) {
      throw new Error(
        "Threads share did not remain on a verifiable Threads post."
      );
    }

    if (candidates.length === 0) {
      throw new Error(
        "Threads did not expose downloadable media after browser inspection."
      );
    }

    const downloaded = [];
    const imageHashes = [];

    for (const candidate of candidates) {
      const response = await fetch(candidate, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: finalUrl,
        },
      });
      if (!response.ok) continue;

      const type =
        response.headers.get("content-type") || "";
      const isVideo = type.startsWith("video/");
      const isImage = type.startsWith("image/");
      if (!isVideo && !isImage) continue;

      const bytes = Buffer.from(
        await response.arrayBuffer()
      );
      // A compressed Threads photo can legitimately be smaller than 30 KB.
      // Images are validated below by decoding their dimensions and rejecting
      // known placeholder artwork, which is stronger evidence than file size.
      // Keep the existing minimum for videos, where no equivalent image
      // validation is available here.
      if (isVideo && bytes.length < 30 * 1024) continue;

      const ext = isVideo
        ? ".mp4"
        : type.includes("png")
          ? ".png"
          : type.includes("webp")
            ? ".webp"
            : ".jpg";
      const dest = path.join(
        jobDir,
        `threads-${String(downloaded.length).padStart(3, "0")}${ext}`
      );
      await fs.writeFile(dest, bytes);

      let dimensions = null;
      if (isImage) {
        dimensions = await getImageDimensions(dest);
        if (!dimensions) {
          await fs.rm(dest, { force: true });
          continue;
        }

        const imageHash = await imagePerceptualHash(dest);
        if (isKnownThreadsPlaceholder(imageHash)) {
          await fs.rm(dest, { force: true });
          console.log(
            "Threads placeholder artwork removed."
          );
          continue;
        }

        const isDuplicate =
          imageHash !== null &&
          imageHashes.some(
            (existingHash) =>
              perceptualHashDistance(
                imageHash,
                existingHash
              ) <= 6
          );

        if (isDuplicate) {
          await fs.rm(dest, { force: true });
          continue;
        }
        if (imageHash !== null) {
          imageHashes.push(imageHash);
        }
      }

      downloaded.push({
        file: probeFile(dest),
        bytes: bytes.length,
        dimensions,
      });
    }

    const images = downloaded.filter(
      (item) => item.file.isImage && item.dimensions
    );
    let retained = downloaded;

    if (images.length > 1) {
      const largestArea = Math.max(
        ...images.map((item) => item.dimensions.area)
      );
      const largestBytes = Math.max(
        ...images.map((item) => item.bytes)
      );
      const minimumArea = largestArea * 0.4;
      const minimumBytes = largestBytes * 0.15;

      retained = downloaded.filter(
        (item) =>
          !item.file.isImage ||
          (
            item.dimensions.area >= minimumArea &&
            item.bytes >= minimumBytes
          )
      );

      const retainedPaths = new Set(
        retained.map((item) => item.file.path)
      );
      for (const item of downloaded) {
        if (!retainedPaths.has(item.file.path)) {
          await fs.rm(item.file.path, { force: true });
        }
      }

      console.log("Threads image selection:", {
        downloadedImageCount: images.length,
        retainedImageCount: retained.filter(
          (item) => item.file.isImage
        ).length,
        largestArea,
      });
    }

    if (openGraphFallback) {
      const videos = retained.filter((item) => !item.file.isImage);
      if (videos.length > 0) {
        const dropped = retained.filter((item) => item.file.isImage);
        retained = videos;
        for (const item of dropped) {
          await fs.rm(item.file.path, { force: true });
        }
      }
    }

    const files = retained.map((item) => item.file);

    if (files.length === 0) {
      throw new Error(
        "Threads media URLs were found, but no usable photos or videos could be downloaded."
      );
    }

    console.log(
      `Threads download complete (${files.length} file(s)).`
    );

    const previewOnly = Boolean(
      openGraphFallback &&
        files.length > 0 &&
        files.every((file) => file.isImage) &&
        (openGraphFallback.videoPost || openGraphFallback.video)
    );

    return {
      files,
      rawDir: jobDir,
      platform: "threads",
      creator:
        fallbackCreator ||
        options.discordEmbedFallback?.creator ||
        extractThreadsCreator(finalUrl) ||
        extractThreadsCreator(url),
      ...(previewOnly ? { previewOnly: true } : {}),
      ...(authFailure ? { socialAuthFailureKind: authFailure.kind, socialAuthFailureCategory: authFailure.category } : {}),
    };
  } catch (error) {
    await fs.rm(jobDir, {
      recursive: true,
      force: true,
    });
    if (authFailure) {
      error.socialAuthFailureKind = authFailure.kind;
      error.socialAuthFailureCategory = authFailure.category;
    }
    throw error;
  }
}

module.exports = {
  downloadThreadsMedia,
  collectCandidateUrls,
  collectPostScopedJsonMedia,
  collectExactOpenGraphFallback,
  exactThreadsPostUrl,
  resolveThreadsShareRedirect,
  shouldUseScopedBrowserDirectly,
  logThreadsBrowserDiagnostics,
};
