const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { probeFile } = require("./downloader");
const { withBrowserLock } = require("./browserLock");

const execFileAsync = promisify(execFile);

const TEMP_ROOT = path.resolve(__dirname, "../../temp");
const FACEBOOK_BROWSER_HELPER = path.join(
  __dirname,
  "facebookBrowser.py"
);

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function findMediaFiles(dir) {
  const entries = await fs.readdir(dir, {
    withFileTypes: true,
  });

  let files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "_best") continue;
      files.push(...(await findMediaFiles(fullPath)));
      continue;
    }

    // Ignore gallery-dl json sidecars and non-visual files.
    if (
      /\.(jpg|jpeg|png|webp|gif|mp4|mov|webm|mkv)$/i.test(
        entry.name
      )
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * @returns {Promise<string>}
 */
async function createFacebookJobDirectory() {
  await fs.mkdir(TEMP_ROOT, { recursive: true });

  const jobDir = path.join(
    TEMP_ROOT,
    `facebook-${Date.now()}-${randomUUID()}`
  );

  await fs.mkdir(jobDir, { recursive: true });
  return jobDir;
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} jobDir
 * @returns {Promise<Array<object>>}
 */
async function collectMediaFiles(jobDir) {
  const paths = await findMediaFiles(jobDir);

  paths.sort((a, b) =>
    a.localeCompare(b, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

  return paths
    .map(probeFile)
    .filter((file) => file.isImage || file.isVideo);
}

/**
 * @param {string} jobDir
 */
async function clearStrategyOutputs(jobDir) {
  const entries = await fs.readdir(jobDir, {
    withFileTypes: true,
  });

  await Promise.all(
    entries.map((entry) => {
      if (entry.name === "_best") return Promise.resolve();
      return fs.rm(path.join(jobDir, entry.name), {
        recursive: true,
        force: true,
      });
    })
  );
}

/**
 * @param {string} jobDir
 * @param {Array<{ path: string }>} files
 */
async function snapshotBest(jobDir, files) {
  const bestDir = path.join(jobDir, "_best");
  const stagingDir = path.join(jobDir, "_best-staging");
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  // Stage first because a mixed-media snapshot may include files from the
  // current _best directory. Deleting _best before copying would lose them.
  let index = 0;
  for (const file of files) {
    const ext = path.extname(file.path) || ".bin";
    const dest = path.join(
      stagingDir,
      `media-${String(index).padStart(3, "0")}${ext}`
    );
    await fs.copyFile(file.path, dest);
    index += 1;
  }

  await fs.rm(bestDir, { recursive: true, force: true });
  await fs.rename(stagingDir, bestDir);
}

/**
 * @param {string} jobDir
 * @returns {Promise<Array<object>>}
 */
async function loadBestSnapshot(jobDir) {
  const bestDir = path.join(jobDir, "_best");
  if (!(await fileExists(bestDir))) return [];

  const paths = await findMediaFiles(bestDir);
  paths.sort((a, b) =>
    a.localeCompare(b, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

  return paths
    .map(probeFile)
    .filter((file) => file.isImage || file.isVideo);
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function looksLikeFacebookPhotoPost(url) {
  return (
    /[?&]fbid=\d+/i.test(url) ||
    /\/photo/i.test(url) ||
    /\/share\/p\//i.test(url) ||
    /story_fbid=/i.test(url) ||
    /\/posts\/(?:\d+|pfbid[a-z0-9]+)/i.test(url) ||
    /\/groups\/[^/]+\/(?:posts|permalink)\/\d+/i.test(url) ||
    /\/permalink\/\d+/i.test(url) ||
    /permalink\.php/i.test(url) ||
    /\/set\//i.test(url) ||
    /media_set/i.test(url) ||
    /\/pcb\./i.test(url)
  );
}

/**
 * Explicit single-photo request: /photo path + fbid=PHOTO_ID.
 * set= is context only and must not expand into an album download.
 *
 * @param {string} url
 * @returns {boolean}
 */
/**
 * A Facebook video surface must never be classified from its poster frames.
 *
 * @param {string} url
 * @returns {boolean}
 */
function looksLikeFacebookVideoPost(url) {
  if (!url) return false;
  return (
    /\/reels?\/[^/?#]+/i.test(url) ||
    /\/videos\/\d+/i.test(url) ||
    /[?&]v=\d+/i.test(url) ||
    /\/share\/(?:v|reel)\//i.test(url)
  );
}

function isExplicitSinglePhotoFbid(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const isPhotoPath =
      path === "/photo" ||
      path === "/photo/" ||
      path === "/photo.php" ||
      path.endsWith("/photo") ||
      path.endsWith("/photo/");
    const fbid = u.searchParams.get("fbid");
    return isPhotoPath && Boolean(fbid && /^\d+$/.test(fbid));
  } catch {
    return (
      /\/photo\/?\?/i.test(url) ||
      /\/photo\.php\?/i.test(url)
    ) && /[?&]fbid=\d+/i.test(url);
  }
}

/**
 * Build alternate URL forms to try for multi-photo posts.
 * Facebook often exposes the same album under several URLs.
 *
 * @param {string} url
 * @returns {string[]}
 */
function buildFacebookUrlCandidates(url) {
  const candidates = [url];

  try {
    const u = new URL(url);

    // photo.php?fbid=ID → /photo/?fbid=ID
    const fbid =
      u.searchParams.get("fbid") ||
      (url.match(/[?&]fbid=(\d+)/i) || [])[1];

    if (fbid) {
      candidates.push(
        `https://www.facebook.com/photo/?fbid=${fbid}`
      );
      candidates.push(
        `https://www.facebook.com/photo.php?fbid=${fbid}`
      );
    }

    // /posts/ID
    const posts = url.match(/\/posts\/(\d+)/i);
    if (posts) {
      candidates.push(
        `https://www.facebook.com/${posts[1]}`
      );
    }

    // set / mediaset tokens: only expand to album URLs when this is
    // NOT an explicit single-photo fbid request (A).
    if (!isExplicitSinglePhotoFbid(url)) {
      const set =
        u.searchParams.get("set") ||
        (url.match(/[?&]set=([^&]+)/i) || [])[1];
      if (set) {
        candidates.push(
          `https://www.facebook.com/media/set/?set=${set}`
        );
      }
    }
  } catch {
    // ignore
  }

  // Dedupe
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * @param {string} url
 * @param {string} jobDir
 * @param {string|null} cookiesPath
 */
async function runYtDlp(url, jobDir, cookiesPath = null) {
  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";

  const outputTemplate = path.join(
    jobDir,
    "facebook-%(id)s-%(playlist_index)s.%(ext)s"
  );

  const args = [
    "--no-warnings",
    "--yes-playlist",
    "-o",
    outputTemplate,
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
  ];

  if (cookiesPath) {
    args.push("--cookies", cookiesPath);
  }

  args.push(url);

  await execFileAsync(ytDlpPath, args, {
    windowsHide: true,
    maxBuffer: 30 * 1024 * 1024,
    timeout: 30 * 1000,
    killSignal: "SIGKILL",
  });
}

/**
 * @param {string} url
 * @param {string} jobDir
 * @param {string|null} cookiesPath
 */
async function runGalleryDl(url, jobDir, cookiesPath = null) {
  const galleryDlPath =
    process.env.GALLERYDL_PATH || "gallery-dl";

  // Directory layout under jobDir; collect recursively afterward.
  const args = [
    "-d",
    jobDir,
    // Do not stop after first image of a set.
    "--range",
    // Fetch one item beyond Harmony's accepted per-post maximum. If this
    // returns 11 files, the bulk-result guard rejects it immediately.
    "1-11",
  ];

  if (cookiesPath) {
    args.push("--cookies", cookiesPath);
  }

  args.push(url);

  await execFileAsync(galleryDlPath, args, {
    windowsHide: true,
    maxBuffer: 30 * 1024 * 1024,
    timeout: 45 * 1000,
    killSignal: "SIGKILL",
  });
}


/**
 * Reads Netscape cookies into a request Cookie header.
 *
 * @param {string|null} cookiesPath
 * @returns {Promise<string>}
 */
async function buildCookieHeader(cookiesPath) {
  if (!cookiesPath) return "";

  try {
    const text = await fs.readFile(cookiesPath, "utf8");
    return text
      .split(/\r?\n/)
      // Netscape exports prefix secure login cookies with #HttpOnly_.
      // Those are real cookies, not comments, and Facebook needs them.
      .map((line) =>
        line.startsWith("#HttpOnly_")
          ? line.slice("#HttpOnly_".length)
          : line
      )
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length >= 7)
      .map((parts) => `${parts[5]}=${parts[6]}`)
      .join("; ");
  } catch {
    return "";
  }
}

function validFacebookCdnUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === "https:" &&
      (host.endsWith(".fbcdn.net") ||
        host.endsWith(".cdninstagram.com"))
    );
  } catch {
    return false;
  }
}

async function runFacebookBrowser(url, jobDir, cookiesPath) {
  const pythonPath = process.env.PYTHON_PATH || "python3";
  console.log("Facebook exact-post browser inspection starting.");

  const { stdout } = await withBrowserLock(() =>
    execFileAsync(
      pythonPath,
      [FACEBOOK_BROWSER_HELPER, url, cookiesPath || ""],
      {
        windowsHide: true,
        timeout: 65000,
        killSignal: "SIGKILL",
        maxBuffer: 20 * 1024 * 1024,
      }
    )
  );

  const line = String(stdout)
    .split(/\r?\n/)
    .find((value) =>
      value.startsWith("HARMONY_FACEBOOK_BROWSER:")
    );
  if (!line) {
    throw new Error(
      "Facebook browser helper returned no verified post result."
    );
  }

  const result = JSON.parse(
    line.slice("HARMONY_FACEBOOK_BROWSER:".length)
  );
  const attachments = Array.isArray(result.attachments)
    ? result.attachments
        .filter((item) =>
          item &&
          (item.type === "video" || item.type === "photo") &&
          validFacebookCdnUrl(item.url)
        )
        .sort((a, b) => Number(a.order) - Number(b.order))
        .slice(0, 10)
    : [];

  if (!attachments.length) {
    throw new Error(
      "Facebook browser found no attachments bound to the requested post."
    );
  }

  const cookie = await buildCookieHeader(cookiesPath);
  let saved = 0;
  for (const attachment of attachments) {
    const response = await fetch(attachment.url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer:
          typeof result.finalUrl === "string"
            ? result.finalUrl
            : url,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) continue;

    const type = response.headers.get("content-type") || "";
    const isVideo =
      attachment.type === "video" ||
      type.startsWith("video/");
    const isImage =
      attachment.type === "photo" &&
      type.startsWith("image/");
    if (!isVideo && !isImage) continue;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < (isVideo ? 50 : 30) * 1024) continue;
    const ext = isVideo
      ? ".mp4"
      : type.includes("png")
        ? ".png"
        : type.includes("webp")
          ? ".webp"
          : ".jpg";
    const destination = path.join(
      jobDir,
      `facebook-verified-${String(saved).padStart(3, "0")}${ext}`
    );
    await fs.writeFile(destination, bytes);
    saved += 1;
  }

  if (!saved) {
    throw new Error(
      "Facebook verified the post attachments but their files could not be downloaded."
    );
  }

  console.log("Facebook exact-post browser inspection complete:", {
    cookieHealth: result.cookieHealth || "unknown",
    targetCount: Array.isArray(result.targetIds)
      ? result.targetIds.length
      : 0,
    attachmentCount: saved,
    matchScore: Number(result.matchScore) || 0,
  });

  return {
    creator:
      typeof result.creator === "string"
        ? result.creator
        : null,
  };
}

/**
 * Facebook photo posts can expose a generated slideshow MP4 to yt-dlp.
 * Read the post page itself and download only large CDN images so the
 * original photo collection wins over that preview video.
 *
 * @param {string} url
 * @param {string} jobDir
 * @param {string|null} cookiesPath
 */
async function runFacebookPhotoPage(url, jobDir, cookiesPath = null) {
  const cookie = await buildCookieHeader(cookiesPath);
  const original = new URL(url);
  const mobile = new URL(url);
  mobile.hostname = "m.facebook.com";
  const basic = new URL(url);
  basic.hostname = "mbasic.facebook.com";
  const embedded =
    "https://www.facebook.com/plugins/post.php?href=" +
    encodeURIComponent(url) +
    "&show_text=true&width=750";

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36",
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...(cookie ? { Cookie: cookie } : {}),
  };
  const documents = [];
  const errors = [];

  async function loadPage(candidate) {
    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        errors.push(`${candidate}: HTTP ${response.status}`);
        return;
      }
      documents.push({
        url: response.url || candidate,
        html: await response.text(),
      });
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  for (const candidate of [...new Set([
    original.toString(),
    mobile.toString(),
    basic.toString(),
    embedded,
  ])]) {
    await loadPage(candidate);
  }

  if (!documents.length) {
    throw new Error(
      "Facebook post pages could not be opened. " + errors.join(" | ")
    );
  }

  // Mobile Facebook often hides a post's full-size photo behind photo.php.
  // Follow only attachment links present inside this exact post page.
  const attachmentLinks = new Set();
  for (const document of documents) {
    for (const match of document.html.matchAll(/href=(?:"([^"]+)"|'([^']+)')/gi)) {
      const raw = (match[1] || match[2] || "")
        .replace(/&amp;/g, "&")
        .replace(/\\u0026/gi, "&")
        .replace(/\\\//g, "/");
      if (!/(?:photo(?:\.php|\/)|videos?\/|watch\/)/i.test(raw)) continue;
      try {
        const target = new URL(raw, document.url);
        if (!/(^|\.)facebook\.com$/i.test(target.hostname)) continue;
        attachmentLinks.add(target.toString());
      } catch {
        // Ignore malformed page links.
      }
    }
  }

  for (const attachment of [...attachmentLinks].slice(0, 10)) {
    await loadPage(attachment);
  }

  const html = documents
    .map((document) => document.html)
    .join("\n")
    .replace(/&quot;/g, '"');

  function decodeMediaUrl(raw) {
    return raw
      .replace(/\\u003A/gi, ":")
      .replace(/\\u0025/gi, "%")
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
  }

  const candidates = [];
  const imagePattern =
    /https(?:\\u003A|:)(?:\\\/|\/){2}(?:scontent|scontent-[a-z0-9-]+|lookaside)\.[^"'\\s<]+/gi;
  for (const match of html.matchAll(imagePattern)) {
    candidates.push({ url: decodeMediaUrl(match[0]), kind: "image" });
  }

  const videoPattern =
    /"(?:browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url)"\s*:\s*"([^"]+)"/gi;
  for (const match of html.matchAll(videoPattern)) {
    candidates.push({ url: decodeMediaUrl(match[1]), kind: "video" });
  }

  const unique = [
    ...new Map(candidates.map((item) => {
      try {
        const parsed = new URL(item.url);
        return [`${item.kind}:${parsed.hostname}${parsed.pathname}`, item];
      } catch {
        return [item.url, item];
      }
    })).values(),
  ].slice(0, 20);

  let saved = 0;
  for (const item of unique) {
    try {
      const response = await fetch(item.url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) continue;
      const type = response.headers.get("content-type") || "";
      const isVideo = item.kind === "video" || type.startsWith("video/");
      const isImage = !isVideo && type.startsWith("image/");
      if (!isVideo && !isImage) continue;

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < (isVideo ? 50 : 30) * 1024) continue;
      const ext = isVideo
        ? ".mp4"
        : type.includes("png")
          ? ".png"
          : type.includes("webp")
            ? ".webp"
            : ".jpg";
      const dest = path.join(
        jobDir,
        `facebook-post-${String(saved).padStart(3, "0")}${ext}`
      );
      await fs.writeFile(dest, bytes);

      if (isImage) {
        try {
          const { stdout } = await execFileAsync(
            process.env.FFPROBE_PATH || "ffprobe",
            [
              "-v", "error", "-select_streams", "v:0",
              "-show_entries", "stream=width,height",
              "-of", "csv=p=0:s=x", dest,
            ],
            { windowsHide: true, maxBuffer: 1024 * 1024 }
          );
          const dimensions = String(stdout).trim().match(/^(\d+)x(\d+)/);
          if (!dimensions ||
              Number(dimensions[1]) < 500 ||
              Number(dimensions[2]) < 500) {
            await fs.rm(dest, { force: true });
            continue;
          }
        } catch {
          await fs.rm(dest, { force: true });
          continue;
        }
      }

      saved += 1;
      if (saved >= 10) break;
    } catch {
      // Try the next exact-post media candidate.
    }
  }

  if (!saved) {
    throw new Error(
      "Facebook did not expose verified media inside this exact post."
    );
  }

  console.log(
    `Facebook exact-post extraction saved ${saved} verified attachment(s)`
  );
}

/**
 * @param {string} url
 * @param {string|null} cookiesPath
 * @returns {Promise<string|null>}
 */
async function getYtDlpCreator(url, cookiesPath = null) {
  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";

  try {
    /** @type {string[]} */
    const args = [
      "--no-warnings",
      "--skip-download",
      "--print",
      "%(uploader)s\n%(channel)s\n%(creator)s\n%(uploader_id)s",
    ];

    if (cookiesPath) {
      args.push("--cookies", cookiesPath);
    }

    args.push(url);

    const { stdout } = await execFileAsync(ytDlpPath, args, {
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
    });

    for (const line of String(stdout).split(/\r?\n/)) {
      const name = line.trim();
      if (
        name &&
        name !== "NA" &&
        name !== "None" &&
        name !== "null"
      ) {
        return name;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * @param {string} url
 * @param {string|null} cookiesPath
 * @returns {Promise<string|null>}
 */
async function getGalleryDlCreator(url, cookiesPath = null) {
  const galleryDlPath =
    process.env.GALLERYDL_PATH || "gallery-dl";

  try {
    /** @type {string[]} */
    const args = ["-j"];

    if (cookiesPath) {
      args.push("--cookies", cookiesPath);
    }

    args.push(url);

    const { stdout } = await execFileAsync(
      galleryDlPath,
      args,
      {
        windowsHide: true,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    const data = JSON.parse(stdout);

    function findCreator(value) {
      if (!value) return null;

      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findCreator(item);
          if (found) return found;
        }
        return null;
      }

      if (typeof value === "object") {
        const candidates = [
          value.owner_name,
          value.username,
          value.full_name,
          value.name,
          value.author,
          value.uploader,
          value.user && value.user.name,
          value.user && value.user.username,
          value.owner && value.owner.name,
        ];

        for (const c of candidates) {
          if (typeof c === "string" && c.trim()) {
            return c.trim();
          }
        }

        for (const child of Object.values(value)) {
          const found = findCreator(child);
          if (found) return found;
        }
      }

      return null;
    }

    return findCreator(data);
  } catch (error) {
    console.warn(
      "Facebook gallery-dl creator lookup failed:",
      error.message
    );
    return null;
  }
}

/**
 * @param {Array<object>} files
 * @returns {number}
 */
function scoreFiles(files, preferPhotos = false) {
  const images = files.filter((f) => f.isImage).length;
  const videos = files.filter((f) => f.isVideo).length;

  // For a Facebook photo-post URL, original images must outrank Facebook's
  // generated slideshow/preview MP4. Genuine reels and videos use normal scoring.
  return preferPhotos
    ? images * 10 + videos
    : images + videos * 3;
}

/**
 * Downloads Facebook media with multi-photo awareness.
 *
 * For photo-like posts, tries several URL forms with gallery-dl first
 * so albums return every image, not just one.
 *
 * @param {string} url
 * @returns {Promise<{
 *   files: Array<object>,
 *   rawDir: string,
 *   platform: string,
 *   creator: string|null
 * }>}
 */
async function downloadFacebookMedia(url, originalUrl = url) {
  const jobDir = await createFacebookJobDirectory();

  const cookiesPath =
    process.env.FACEBOOK_COOKIES ||
    path.resolve(__dirname, "../../facebook-cookies.txt");

  const hasCookies = await fileExists(cookiesPath);
  let cookiesUsable = hasCookies;

  if (hasCookies) {
    try {
      const stat = await fs.stat(cookiesPath);
      // Real Facebook exports are typically many KB; tiny files are stubs.
      if (stat.size < 500) {
        console.warn(
          `Facebook cookies file is only ${stat.size} bytes — likely empty/invalid. Multi-photo and video usually need a full export.`
        );
        cookiesUsable = false;
      }
    } catch {
      cookiesUsable = false;
    }
  }

  console.log(
    `Facebook cookies: ${
      cookiesUsable
        ? "yes"
        : "NO — multi-photo/video often need a valid facebook-cookies.txt"
    }`
  );

  const videoSurface =
    looksLikeFacebookVideoPost(url) ||
    looksLikeFacebookVideoPost(originalUrl);
  const preferGalleryFirst =
    !videoSurface &&
    (looksLikeFacebookPhotoPost(url) ||
      looksLikeFacebookPhotoPost(originalUrl));
  const photoPageUrl = originalUrl || url;
  const identitySensitive =
    /\/groups\/[^/]+\/(?:posts|permalink)\//i.test(url) ||
    /\/posts\/(?:\d+|pfbid[a-z0-9]+)/i.test(url) ||
    /\/reels?\/[^/?#]+/i.test(url) ||
    /\/videos\/\d+/i.test(url) ||
    /[?&]v=\d+/i.test(url) ||
    /\/share\/[vrp]\//i.test(originalUrl);
  // Try both the canonical URL and the original /share/ URL. Facebook's
  // downloaders sometimes expose the video on only one of those forms.
  // Downloaders operate on the resolved canonical post URL. The original
  // /share/ URL remains useful for page inspection, but yt-dlp and gallery-dl
  // reject it and retrying it only delays a usable result.
  const urlCandidates = preferGalleryFirst
    ? buildFacebookUrlCandidates(url)
    : [url];

  /** @type {Array<{ name: string, run: () => Promise<void> }>} */
  const strategies = [];
  let browserCreator = null;

  // A /share/p/ or other photo-post URL may make yt-dlp return Facebook's
  // generated preview video. Try the page's original CDN images first.
  if (identitySensitive && cookiesUsable) {
    strategies.push({
      name: "facebook-browser+cookies (verified exact post)",
      run: async () => {
        const result = await runFacebookBrowser(
          photoPageUrl,
          jobDir,
          cookiesPath
        );
        browserCreator = result.creator;
      },
    });
  } else if (preferGalleryFirst && cookiesUsable) {
    strategies.push({
      name: "facebook-photo-page+cookies (primary)",
      run: () =>
        runFacebookPhotoPage(photoPageUrl, jobDir, cookiesPath),
    });
  }

  for (const candidate of urlCandidates) {
    // Exact post/permalink pages must never be handed to broad page-level
    // downloaders; they can return an unrelated feed or profile item.
    if (identitySensitive) break;

    const label =
      candidate === url ? "primary" : `alt:${candidate}`;

    if (cookiesUsable) {
      if (preferGalleryFirst) {
        strategies.push({
          name: `gallery-dl+cookies (${label})`,
          run: () => runGalleryDl(candidate, jobDir, cookiesPath),
        });
        strategies.push({
          name: `yt-dlp+cookies (${label})`,
          run: () => runYtDlp(candidate, jobDir, cookiesPath),
        });
      } else {
        strategies.push({
          name: `yt-dlp+cookies (${label})`,
          run: () => runYtDlp(candidate, jobDir, cookiesPath),
        });
        strategies.push({
          name: `gallery-dl+cookies (${label})`,
          run: () => runGalleryDl(candidate, jobDir, cookiesPath),
        });
      }
    }

    // Authenticated attempts are strictly better when valid cookies exist.
    // Do not repeat every strategy without cookies after those attempts.
    if (!cookiesUsable) {
      if (preferGalleryFirst) {
        strategies.push({
          name: `gallery-dl (${label})`,
          run: () => runGalleryDl(candidate, jobDir, null),
        });
        strategies.push({
          name: `yt-dlp (${label})`,
          run: () => runYtDlp(candidate, jobDir, null),
        });
      } else {
        strategies.push({
          name: `yt-dlp (${label})`,
          run: () => runYtDlp(candidate, jobDir, null),
        });
        strategies.push({
          name: `gallery-dl (${label})`,
          run: () => runGalleryDl(candidate, jobDir, null),
        });
      }
    }
  }

  const errors = [];
  let bestScore = -1;
  let bestStrategyName = null;

  for (const strategy of strategies) {
    try {
      console.log(
        `Facebook download attempt: ${strategy.name}`
      );

      await clearStrategyOutputs(jobDir);
      await strategy.run();

      await new Promise((resolve) => setTimeout(resolve, 400));

      const files = await collectMediaFiles(jobDir);

      if (files.length === 0) {
        errors.push(
          `${strategy.name}: no supported media files were produced`
        );
        continue;
      }

      // A specific Facebook post cannot legitimately turn into a 100-item
      // profile scrape. Never snapshot or upload a fallback batch larger than
      // Facebook's per-post media limit.
      if (files.length > 10) {
        const reason =
          `${strategy.name}: rejected suspicious bulk result (${files.length} files)`;
        errors.push(reason);
        console.warn(`Facebook ${reason}`);
        continue;
      }

      const extractedImageCount = files.filter((f) => f.isImage).length;
      const extractedVideoCount = files.filter((f) => f.isVideo).length;
      // Facebook often exposes a Reel's poster and preview frames beside the
      // actual MP4. Those images are not separate post attachments. Once a
      // verified video exists on a video surface, keep only video files so a
      // single Reel cannot become a false "Multi-Photo" collage.
      const candidateFiles =
        videoSurface && extractedVideoCount > 0
          ? files.filter((f) => f.isVideo)
          : files;
      const imageCount = candidateFiles.filter((f) => f.isImage).length;
      const videoCount = candidateFiles.filter((f) => f.isVideo).length;

      if (
        videoSurface &&
        extractedVideoCount > 0 &&
        extractedImageCount > 0
      ) {
        console.log(
          `Facebook video surface: ignored ${extractedImageCount} poster/preview image(s).`
        );
      }

      // Never assemble one Facebook post by combining output from
      // different extractors. Each strategy can see a different feed item;
      // merging their files is how unrelated photos and videos become one
      // false "multi-photo" post. A winning snapshot must come entirely from
      // one post-bound strategy.
      const score = scoreFiles(candidateFiles, preferGalleryFirst);

      console.log(
        `Facebook ${strategy.name}: ${files.length} file(s) ` +
          `(${imageCount} image, ${videoCount} video, score=${score})`
      );

      if (score > bestScore) {
        bestScore = score;
        bestStrategyName = strategy.name;
        await snapshotBest(jobDir, candidateFiles);
        console.log(
          `Facebook new best snapshot via ${strategy.name}`
        );
      }

      // B: explicit /photo + fbid already got its image — do not explore
      // further candidates (prevents later album expansion winning).
      if (isExplicitSinglePhotoFbid(url) && imageCount >= 1) {
        console.log(
          "Facebook explicit single-photo fbid satisfied; stopping candidate search."
        );
        break;
      }

      // For photo-post URLs, never stop merely because Facebook supplied
      // a generated preview MP4. Keep searching for the original images.
      if (
        (!preferGalleryFirst && videoCount > 0) ||
        (preferGalleryFirst && imageCount > 0 && videoCount > 0)
      ) {
        break;
      }
    } catch (error) {
      const details = [
        error.stderr || "",
        error.stdout || "",
        error.message || "",
      ]
        .join(" ")
        .trim();

      errors.push(`${strategy.name}: ${details}`);
      console.warn(
        `Facebook download failed with ${strategy.name}:`,
        (error && error.message) || error
      );
    }
  }

  let finalFiles = await loadBestSnapshot(jobDir);

  // Final invariant: a known Reel/video with a playable video must never
  // leave this downloader carrying Facebook's poster frames as photos.
  if (videoSurface && finalFiles.some((file) => file.isVideo)) {
    const videoFiles = finalFiles.filter((file) => file.isVideo);
    const removed = finalFiles.length - videoFiles.length;
    if (removed > 0) {
      console.log(
        `Facebook final Reel guard removed ${removed} poster/preview image(s).`
      );
    }
    finalFiles = videoFiles;
  }

  if (finalFiles.length === 0) {
    await fs.rm(jobDir, { recursive: true, force: true });

    if (identitySensitive) {
      console.warn(
        "Facebook exact-post verification failed; using safe original-link fallback."
      );
      return {
        files: [],
        rawDir: null,
        platform: "facebook",
        creator: null,
        linkOnly: true,
      };
    }

    throw new Error(
      "Harmony could not retrieve this Facebook post after trying every available download method.\n\n" +
        errors.join("\n")
    );
  }

  let creator = null;
  const cookieArg = cookiesUsable ? cookiesPath : null;
  creator = browserCreator;
  if (!creator && !identitySensitive) {
    creator =
      (await getGalleryDlCreator(url, cookieArg)) ||
      (await getYtDlpCreator(url, cookieArg));
  }

  if (creator) {
    console.log(`Facebook creator detected: ${creator}`);
  } else {
    console.warn(
      "Facebook creator not found in downloader metadata."
    );
  }

  console.log(
    `Facebook download succeeded (${finalFiles.length} file(s))` +
      (bestStrategyName ? ` via ${bestStrategyName}` : "")
  );

  return {
    files: finalFiles,
    rawDir: jobDir,
    platform: "facebook",
    creator,
  };
}

module.exports = {
  downloadFacebookMedia,
  looksLikeFacebookPhotoPost,
  isExplicitSinglePhotoFbid,
  buildFacebookUrlCandidates,
};
