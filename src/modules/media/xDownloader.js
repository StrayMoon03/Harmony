const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { probeFile } = require("./downloader");
const { extractXId } = require("./x");

/**
 * gallery-dl -j can exit 0 while returning an error record such as
 * [[-1, { error: "KeyError", message: "'name'" }]]. That is a failed
 * inspection, not a confirmed text-only post.
 *
 * @param {unknown} data
 * @returns {string|null}
 */
function galleryDlErrorMessage(data) {
  const records = Array.isArray(data) ? data : [data];

  for (const record of records) {
    const entry =
      Array.isArray(record) && record[0] === -1 && record[1] && typeof record[1] === "object"
        ? record[1]
        : record && typeof record === "object" && record[0] === undefined
          ? record
          : null;
    if (entry && typeof entry.error === "string" && !entry.author && !["animated_gif", "video", "photo"].includes(entry.type)) {
      return `${entry.error}${entry.message ? `: ${entry.message}` : ""}`;
    }
  }

  if (Array.isArray(data) && data[0] === -1 && data[1] && typeof data[1].error === "string") {
    return `${data[1].error}${data[1].message ? `: ${data[1].message}` : ""}`;
  }

  return null;
}

/**
 * Summarizes creator, text, date, and media flags from gallery-dl JSON.
 * hasMedia is true when a photo/video/GIF type is present, false only when
 * a tweet-like record was inspected and carried no media, and null when the
 * payload is empty or inconclusive.
 *
 * @param {unknown} data
 * @returns {{ creator: string|null, displayName: string|null, text: string|null, originalDate: string|null, isGif: boolean, hasMedia: boolean|null }}
 */
function summarizeXGalleryMetadata(data) {
  let creator = null;
  let displayName = null;
  let text = null;
  let originalDate = null;
  let isGif = false;
  let hasMedia = null;
  let sawTweetRecord = false;

  function parseMetadataDate(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = value > 1e12 ? value : value * 1000;
      const parsed = new Date(milliseconds);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    const parsed = new Date(String(value || ""));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  function walk(value) {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    if (typeof value !== "object") return;

    // Original X media type from gallery-dl / Twitter API.
    if (value.type === "animated_gif") {
      isGif = true;
    }
    if (["animated_gif", "video", "photo"].includes(value.type)) {
      hasMedia = true;
    }

    const looksLikeTweet = Boolean(
      (value.author && typeof value.author === "object") ||
      value.full_text ||
      value.rest_id ||
      value.conversation_id ||
      (typeof value.content === "string" && value.content.trim() && value.date)
    );
    if (looksLikeTweet) sawTweetRecord = true;

    if (
      !creator &&
      value.author &&
      typeof value.author === "object"
    ) {
      const nick = value.author.nick;
      const name = value.author.name;

      if (typeof nick === "string" && nick.trim()) {
        creator = nick.trim();
      } else if (
        typeof name === "string" &&
        name.trim()
      ) {
        creator = name.trim();
      }
      if (typeof name === "string" && name.trim()) displayName = name.trim();
    }

    if (!text) {
      const candidateText = value.content || value.full_text || value.text;
      if (typeof candidateText === "string" && candidateText.trim()) {
        text = candidateText.trim();
      }
    }

    if (!originalDate) {
      const candidateDate = value.date || value.created_at || value.createdAt;
      if (candidateDate) originalDate = parseMetadataDate(candidateDate);
    }

    for (const child of Object.values(value)) {
      walk(child);
    }
  }

  walk(data);

  if (hasMedia !== true && sawTweetRecord) {
    hasMedia = false;
  }

  return { creator, displayName, text, originalDate, isGif, hasMedia };
}

function isTrustedXMediaUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "pbs.twimg.com" || host === "video.twimg.com" || host.endsWith(".twimg.com");
  } catch {
    return false;
  }
}

function fxTwitterMediaItems(tweet) {
  const media = tweet?.media;
  const items = [];
  if (!media || typeof media !== "object") return items;
  const source = Array.isArray(media.all) && media.all.length
    ? media.all
    : [
        ...(Array.isArray(media.photos) ? media.photos : []),
        ...(Array.isArray(media.videos) ? media.videos : []),
        ...(media.video && typeof media.video === "object" ? [media.video] : []),
      ];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "mosaic_photo") continue;
    const url = typeof item.url === "string" ? item.url : null;
    if (!url || !isTrustedXMediaUrl(url)) continue;
    items.push(item);
  }
  return items;
}

function extensionForFxMedia(item) {
  if (item.type === "video") return "mp4";
  if (item.type === "animated_gif" || item.type === "gif") return "mp4";
  try {
    const ext = path.extname(new URL(item.url).pathname).replace(".", "").toLowerCase();
    if (["jpg", "jpeg", "png", "webp", "gif", "mp4", "mov", "webm"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  } catch {
    // Fall through to the default image extension.
  }
  return "jpg";
}

/**
 * Fetches public tweet metadata from the FxTwitter API.
 *
 * @param {string} statusId
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
async function fetchFxTwitterStatus(statusId, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`https://api.fxtwitter.com/status/${statusId}`, {
    headers: { "User-Agent": "Harmony-media-fallback" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`FxTwitter HTTP ${response.status}`);
  }
  const data = await response.json();
  if (Number(data?.code) !== 200 || !data.tweet || typeof data.tweet !== "object") {
    throw new Error(data?.message || "FxTwitter did not return a tweet");
  }
  return data.tweet;
}

function fxTwitterPostFields(tweet) {
  const author = tweet?.author && typeof tweet.author === "object" ? tweet.author : {};
  const displayName = typeof author.name === "string" && author.name.trim() ? author.name.trim() : null;
  const handle = typeof author.screen_name === "string" && author.screen_name.trim()
    ? author.screen_name.trim()
    : null;
  const text = typeof tweet?.text === "string" && tweet.text.trim() ? tweet.text.trim() : null;
  let originalDate = null;
  if (typeof tweet?.created_timestamp === "number") {
    const parsed = new Date(tweet.created_timestamp * 1000);
    if (!Number.isNaN(parsed.getTime())) originalDate = parsed.toISOString();
  } else if (tweet?.created_at) {
    const parsed = new Date(tweet.created_at);
    if (!Number.isNaN(parsed.getTime())) originalDate = parsed.toISOString();
  }
  return {
    creator: displayName || handle,
    displayName,
    text,
    originalDate,
    isGif: fxTwitterMediaItems(tweet).some((item) => item.type === "animated_gif" || item.type === "gif"),
  };
}

/**
 * Downloads X photos/videos through FxTwitter when gallery-dl metadata is
 * inconclusive or fails with an extractor error.
 *
 * @param {string} url
 * @param {string} jobDir
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
async function downloadFxTwitterMedia(url, jobDir, options = {}) {
  const statusId = extractXId(url);
  if (!statusId) {
    throw new Error("Could not extract X status id for the FxTwitter fallback.");
  }

  const tweet = await fetchFxTwitterStatus(statusId, options);
  const fields = fxTwitterPostFields(tweet);
  const items = fxTwitterMediaItems(tweet);

  if (items.length === 0) {
    if (fields.text || fields.creator) {
      return {
        files: [],
        rawDir: null,
        platform: "x",
        ...fields,
        linkOnly: true,
      };
    }
    throw new Error("FxTwitter returned this X post without media or text.");
  }

  for (const [index, item] of items.entries()) {
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(item.url, {
      headers: { "User-Agent": "Harmony-media-fallback" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`FxTwitter media HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 32) {
      throw new Error("FxTwitter media was empty.");
    }
    const filename = `x-fx-${item.id || index + 1}.${extensionForFxMedia(item)}`;
    await fs.writeFile(path.join(jobDir, filename), buffer);
  }

  const files = await collectMediaFiles(jobDir);
  if (files.length === 0) {
    throw new Error("FxTwitter did not produce any supported media files.");
  }

  return {
    files,
    rawDir: jobDir,
    platform: "x",
    ...fields,
    linkOnly: false,
  };
}


const execFileAsync = promisify(execFile);

const TEMP_ROOT = path.resolve(__dirname, "../../temp");

/**
 * Creates a private temporary folder for one X download.
 *
 * @returns {Promise<string>}
 */
async function createXJobDirectory() {
  await fs.mkdir(TEMP_ROOT, {
    recursive: true,
  });

  const jobDir = path.join(
    TEMP_ROOT,
    `x-${Date.now()}-${randomUUID()}`
  );

  await fs.mkdir(jobDir, {
    recursive: true,
  });

  return jobDir;
}

/**
 * Recursively finds supported visual media files.
 *
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
      files.push(...(await findMediaFiles(fullPath)));
      continue;
    }

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
 * Collects and validates downloaded media.
 *
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
    .filter(
      (file) => file.isImage || file.isVideo
    );
}

/**
 * Removes everything inside the job directory
 * without removing the directory itself.
 *
 * @param {string} jobDir
 */
async function clearJobDirectory(jobDir) {
  const entries = await fs.readdir(jobDir);

  await Promise.all(
    entries.map((entry) =>
      fs.rm(path.join(jobDir, entry), {
        recursive: true,
        force: true,
      })
    )
  );
}

/**
 * Attempts to download an X video with yt-dlp.
 *
 * @param {string} url
 * @param {string} jobDir
 */
async function runYtDlp(url, jobDir) {
  const ytDlpPath =
    process.env.YTDLP_PATH || "yt-dlp";

  const outputTemplate = path.join(
    jobDir,
    "x-%(id)s.%(ext)s"
  );

  await execFileAsync(
    ytDlpPath,
    [
      "--no-playlist",
      "--no-warnings",
      "-o",
      outputTemplate,
      url,
    ],
    {
      windowsHide: true,
      maxBuffer: 30 * 1024 * 1024,
    }
  );
}

/**
 * Downloads X photos with gallery-dl.
 *
 * @param {string} url
 * @param {string} jobDir
 */
async function runGalleryDl(url, jobDir) {
  const galleryDlPath =
    process.env.GALLERYDL_PATH || "gallery-dl";

  await execFileAsync(
    galleryDlPath,
    [
      "-d",
      jobDir,
      url,
    ],
    {
      windowsHide: true,
      maxBuffer: 30 * 1024 * 1024,
    }
  );
}

/**
 * Loads gallery-dl JSON for an X status.
 * Used for creator and original media type (animated_gif vs video).
 *
 * Twitter/X API media.type is the source of truth:
 * - "animated_gif" → GIF (often delivered as MP4 on disk)
 * - "video" → Video
 * - "photo" → Photo
 *
 * @param {string} url
 * @returns {Promise<{ creator: string|null, displayName: string|null, text: string|null, originalDate: string|null, isGif: boolean, hasMedia: boolean|null }>}
 */
async function getGalleryDlMeta(url) {
  const galleryDlPath =
    process.env.GALLERYDL_PATH || "gallery-dl";

  try {
    const { stdout } = await execFileAsync(
      galleryDlPath,
      [
        "-j",
        url,
      ],
      {
        windowsHide: true,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    const data = JSON.parse(stdout);
    const lookupError = galleryDlErrorMessage(data);
    if (lookupError) {
      throw new Error(lookupError);
    }

    return summarizeXGalleryMetadata(data);
  } catch (error) {
    console.warn(
      "X gallery-dl metadata lookup failed:",
      error.message
    );

    return {
      creator: null,
      displayName: null,
      text: null,
      originalDate: null,
      isGif: false,
      hasMedia: null,
    };
  }
}

/**
 * Downloads media attached to an X/Twitter status.
 *
 * Strategy:
 *
 * 1. Get creator + original media type (GIF vs video) via gallery-dl JSON.
 * 2. Try yt-dlp for video / animated GIF (X often serves GIFs as MP4).
 * 3. If yt-dlp cannot produce media, use gallery-dl for photo / multi-photo.
 *
 * isGif is true only when Twitter/X metadata reports type "animated_gif",
 * never from file extension or duration heuristics.
 *
 * @param {string} url
 * @returns {Promise<{
 *   files: Array<object>,
 *   rawDir: string,
 *   platform: string,
 *   creator: string|null,
 *   isGif: boolean
 * }>}
 */
async function downloadXMedia(url) {
  const jobDir =
    await createXJobDirectory();

  const errors = [];

  try {
    const meta = await getGalleryDlMeta(url);
    const creator = meta.creator;
    const isGif = meta.isGif;

    // A successfully inspected X status with no photo/video/GIF is a normal
    // text-only post, not a failed media download. Only take that path when
    // the inspection actually produced tweet text or a creator; an empty or
    // error payload is inconclusive and must continue to download fallbacks.
    if (meta.hasMedia === false && (meta.text || creator || meta.displayName)) {
      await fs.rm(jobDir, { recursive: true, force: true });
      return {
        files: [],
        rawDir: null,
        platform: "x",
        creator,
        displayName: meta.displayName,
        text: meta.text,
        originalDate: meta.originalDate,
        isGif: false,
        linkOnly: true,
      };
    }
    if (meta.hasMedia === false) {
      console.warn(
        "X metadata reported no media, but the post text was unavailable. Continuing with download fallbacks."
      );
    }

    if (creator) {
      console.log(
        `X creator detected: ${creator}`
      );
    }

    if (isGif) {
      console.log(
        "X media type from metadata: animated_gif"
      );
    }

    // =========================
    // Attempt 1: yt-dlp
    // =========================

    try {
      console.log(
        "X download attempt: yt-dlp"
      );

      await runYtDlp(url, jobDir);

      await new Promise((resolve) =>
        setTimeout(resolve, 300)
      );

      const files =
        await collectMediaFiles(jobDir);

      if (files.length > 0) {
        console.log(
          `X download succeeded with yt-dlp (${files.length} file(s))`
        );

        return {
          files,
          rawDir: jobDir,
          platform: "x",
          creator,
          displayName: meta.displayName,
          text: meta.text,
          originalDate: meta.originalDate,
          isGif,
        };
      }

      errors.push(
        "yt-dlp: no supported media files were produced"
      );
    } catch (error) {
      const details = [
        error.stderr || "",
        error.stdout || "",
        error.message || "",
      ]
        .join(" ")
        .trim();

      errors.push(
        `yt-dlp: ${details}`
      );

      console.warn(
        "X yt-dlp attempt did not produce usable media."
      );
    }

    // Remove anything left by yt-dlp before
    // gallery-dl downloads the photos.
    await clearJobDirectory(jobDir);

    // =========================
    // Attempt 2: gallery-dl
    // =========================

    try {
      console.log(
        "X download attempt: gallery-dl"
      );

      await runGalleryDl(url, jobDir);

      await new Promise((resolve) =>
        setTimeout(resolve, 300)
      );

      const files =
        await collectMediaFiles(jobDir);

      if (files.length > 0) {
        console.log(
          `X download succeeded with gallery-dl (${files.length} file(s))`
        );

        return {
          files,
          rawDir: jobDir,
          platform: "x",
          creator,
          displayName: meta.displayName,
          text: meta.text,
          originalDate: meta.originalDate,
          isGif,
        };
      }

      errors.push(
        "gallery-dl: no supported media files were produced"
      );
    } catch (error) {
      const details = [
        error.stderr || "",
        error.stdout || "",
        error.message || "",
      ]
        .join(" ")
        .trim();

      errors.push(
        `gallery-dl: ${details}`
      );

      console.warn(
        "X gallery-dl attempt did not produce usable media."
      );
    }

    // =========================
    // Attempt 3: FxTwitter fallback (photo posts, extractor errors)
    // =========================

    try {
      console.log(
        "X download attempt: fxtwitter fallback"
      );

      const fxResult = await downloadFxTwitterMedia(url, jobDir);

      if (fxResult.linkOnly) {
        await fs.rm(jobDir, { recursive: true, force: true });
        console.log("X text-only post recovered through the FxTwitter fallback.");
        return fxResult;
      }

      if (fxResult.files.length > 0) {
        console.log(
          `X download succeeded with fxtwitter fallback (${fxResult.files.length} file(s))`
        );
        return {
          ...fxResult,
          creator: fxResult.creator || creator,
          displayName: fxResult.displayName || meta.displayName,
          text: fxResult.text || meta.text,
          originalDate: fxResult.originalDate || meta.originalDate,
          isGif: fxResult.isGif || isGif,
        };
      }

      errors.push(
        "fxtwitter: no supported media files were produced"
      );
    } catch (error) {
      errors.push(
        `fxtwitter: ${error.message || error}`
      );

      console.warn(
        "X FxTwitter fallback did not produce usable media."
      );
    }

    throw new Error(
      "Harmony could not retrieve media from this X post.\n\n" +
        errors.join("\n")
    );
  } catch (error) {
    await fs.rm(jobDir, {
      recursive: true,
      force: true,
    });

    throw error;
  }
}

module.exports = {
  downloadXMedia,
  downloadFxTwitterMedia,
  galleryDlErrorMessage,
  summarizeXGalleryMetadata,
  isTrustedXMediaUrl,
};
