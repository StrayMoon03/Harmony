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
  } catch (error) {
    console.warn(
      "Threads cookies could not be read:",
      error instanceof Error ? error.message : error
    );
    return "";
  }
}

function decodePageText(value) {
  return String(value || "")
    .replace(/\\u0025/gi, "%")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u003a/gi, ":")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&quot;/gi, '"');
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

function isThreadsShareUrl(url) {
  try {
    return /^\/share\//i.test(new URL(url).pathname);
  } catch {
    return false;
  }
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

  for (const userAgent of userAgents) {
    for (const method of ["HEAD", "GET"]) {
      try {
        const response = await fetch(url, {
          method,
          redirect: "manual",
          headers: {
            "User-Agent": userAgent,
            Accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(15000),
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
      } catch (error) {
        console.warn(
          `Threads share ${method} resolution attempt failed:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  return null;
}

async function inspectThreadsWithBrowser(url) {
  const pythonPath = process.env.PYTHON_PATH || "python3";
  const cookiePath = process.env.THREADS_COOKIES || "";

  console.log("Threads browser fallback starting.");

  try {
    const { stdout } = await withBrowserLock(() =>
      execFileAsync(
        pythonPath,
        [THREADS_BROWSER_HELPER, url, cookiePath],
        {
          windowsHide: true,
          timeout: 75000,
          killSignal: "SIGKILL",
          maxBuffer: 5 * 1024 * 1024,
          encoding: "utf8",
        }
      )
    );

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

    const result = JSON.parse(
      line.slice("HARMONY_THREADS_BROWSER:".length)
    );
    const candidates = Array.isArray(result.candidates)
      ? result.candidates
          .map(validCdnUrl)
          .filter(Boolean)
          .slice(0, 20)
      : [];

    console.log("Threads browser fallback complete:", {
      cookieCount: Number(result.cookieCount) || 0,
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
    };
  } catch (error) {
    if (
      error &&
      (error.killed || error.signal === "SIGKILL")
    ) {
      throw new Error(
        "Threads browser took longer than 75 seconds."
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
    const firstErrorLine = stderrText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "";

    console.error("Threads browser helper failed:", {
      exitCode: Number.isInteger(error?.code)
        ? error.code
        : null,
      signal: error?.signal || null,
      hasStructuredError: Boolean(stderr),
      firstErrorLine: firstErrorLine.slice(0, 240),
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
    } catch (error) {
      errors.push(
        `${candidate}: ${error instanceof Error ? error.message : error}`
      );
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

  try {
    console.log("Threads page inspection starting.");

    const shareUrl = isThreadsShareUrl(url);
    if (shareUrl) {
      const resolvedUrl = await resolveThreadsShareRedirect(url);
      if (!resolvedUrl) {
        throw new Error(
          "Threads share link did not resolve to one exact post."
        );
      }
      url = resolvedUrl;
    }
    let html = "";
    let sourceUrl = url;
    let status = 0;
    let finalUrl = url;
    let pageFetchFailed = false;
    let fallbackCreator = null;
    let scopedCandidates = [];

    try {
      const pageResult = await fetchThreadsPage(url);
      html = pageResult.html;
      sourceUrl = pageResult.sourceUrl;
      status = pageResult.status;
      finalUrl = pageResult.finalUrl;
      scopedCandidates = pageResult.scopedCandidates || [];
    } catch (error) {
      pageFetchFailed = true;
      console.warn(
        "Threads static page fetch failed; continuing with browser:",
        error instanceof Error ? error.message : error
      );
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
      try {
        const browserResult =
          await inspectThreadsWithBrowser(finalUrl);
        candidates = browserResult.candidates;
        finalUrl = browserResult.finalUrl || finalUrl;
      } catch (browserError) {
        const fallback = typeof options.getDiscordEmbedFallback === "function"
          ? await options.getDiscordEmbedFallback()
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
        } else {
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
      if (bytes.length < 30 * 1024) continue;

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

    const files = retained.map((item) => item.file);

    if (files.length === 0) {
      throw new Error(
        "Threads media URLs were found, but no usable photos or videos could be downloaded."
      );
    }

    console.log(
      `Threads download complete (${files.length} file(s)).`
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
    };
  } catch (error) {
    await fs.rm(jobDir, {
      recursive: true,
      force: true,
    });
    throw error;
  }
}

module.exports = {
  downloadThreadsMedia,
  collectCandidateUrls,
  collectPostScopedJsonMedia,
  exactThreadsPostUrl,
  resolveThreadsShareRedirect,
};
