const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { classifyAuthenticatedProviderFailure } = require("../../services/socialAuthEvidence");

const execFileAsync = promisify(execFile);

const TEMP_ROOT = path.resolve(__dirname, "../../temp");
const INSTAGRAM_GALLERY_TIMEOUT_MS = 45000;
const INSTAGRAM_RETRY_PAUSE_MS = 350;
const YTDLP_FORMATS_PREFIX = "HARMONY_FORMATS:";
const YTDLP_FILE_PREFIX = "HARMONY_FILE:";

const IMAGE_EXT = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
]);

const VIDEO_EXT = new Set([
  "mp4",
  "mov",
  "webm",
  "mkv",
]);

/**
 * @typedef {object} MediaFile
 * @property {string} path
 * @property {string} mime
 * @property {boolean} isImage
 * @property {boolean} isVideo
 */

/**
 * @typedef {object} DownloadResult
 * @property {MediaFile[]} files
 * @property {string} rawDir
 * @property {string} platform
 */

/**
 * Converts a downloaded file path into a MediaFile object.
 *
 * @param {string} filePath
 * @returns {MediaFile}
 */
function probeFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();

  const isImage = IMAGE_EXT.has(ext);
  const isVideo = VIDEO_EXT.has(ext);

  let mime = "application/octet-stream";

  if (isImage) {
    mime = ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : `image/${ext}`;
  } else if (isVideo) {
    mime = ext === "mp4"
      ? "video/mp4"
      : `video/${ext}`;
  }

  return {
    path: filePath,
    mime,
    isImage,
    isVideo,
  };
}

function isInstagramReelUrl(url) {
  try {
    return /^\/(?:[A-Za-z0-9._]+\/)?reels?\/[A-Za-z0-9_-]+\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function instagramReelShortcode(url) {
  try {
    return new URL(url).pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?reels?\/([A-Za-z0-9_-]+)\/?$/)?.[1] || null;
  } catch {
    return null;
  }
}

function isExactInstagramReelFile(filePath, shortcode, retry = false) {
  const name = path.basename(filePath);
  // A failed audio retry must not treat the original harmony-* file as its
  // own output. /p/ posts have no reel shortcode, so the old "accept anything"
  // fallback caused Harmony to delete the kept video and then fail at upload
  // (Harmony-Errors #441).
  if (retry) {
    if (!name.startsWith("harmony-with-audio-")) return false;
    return shortcode ? name.startsWith(`harmony-with-audio-${shortcode}.`) : true;
  }
  if (!shortcode) return true;
  return name.startsWith(`harmony-${shortcode}.`);
}

function pauseInstagramRetry(signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Instagram retrieval cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, INSTAGRAM_RETRY_PAUSE_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason || new Error("Instagram retrieval cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sanitizeInstagramFormats(formats) {
  if (!Array.isArray(formats)) return [];
  return formats.slice(0, 40).map((format) => ({
    id: String(format?.format_id || format?.id || "unknown").slice(0, 80),
    ext: String(format?.ext || "unknown").slice(0, 16),
    height: Number.isFinite(Number(format?.height)) ? Number(format.height) : null,
    video: String(format?.vcodec || format?.video || "unknown").slice(0, 64),
    audio: String(format?.acodec || format?.audio || "unknown").slice(0, 64),
  }));
}

function parseInstagramYtDlpOutput(stdout) {
  const paths = [];
  let formats = [];
  for (const line of String(stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (line.startsWith(YTDLP_FORMATS_PREFIX)) {
      try {
        formats = sanitizeInstagramFormats(JSON.parse(line.slice(YTDLP_FORMATS_PREFIX.length)));
      } catch {
        formats = [];
      }
    } else if (line.startsWith(YTDLP_FILE_PREFIX)) {
      const filePath = line.slice(YTDLP_FILE_PREFIX.length).trim();
      if (filePath) paths.push(filePath);
    }
  }
  return { paths, formats };
}

/**
 * Recursively finds media files inside a directory.
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
 * Creates a unique temporary workspace for one download.
 *
 * @returns {Promise<string>}
 */
async function createJobDirectory() {
  await fs.mkdir(TEMP_ROOT, {
    recursive: true,
  });

  const jobDir = path.join(
    TEMP_ROOT,
    `job-${Date.now()}-${randomUUID()}`
  );

  await fs.mkdir(jobDir, {
    recursive: true,
  });

  return jobDir;
}

/**
 * Downloads media from a supported URL.
 *
 * yt-dlp is attempted first.
 * Instagram prefers audio when available but keeps an exact-reel video-only
 * result when no verified audio stream can be recovered.
 *
 * Every download uses its own temporary folder.
 *
 * @param {string} url
 * @returns {Promise<DownloadResult>}
 */
async function downloadMedia(url, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const jobDir = await createJobDirectory();
  const errors = [];
  let authFailure = null;
  const isReel = isInstagramReelUrl(url);
  let silentVideoFallback = null;
  const withAuthFailure = (result) => ({
    ...result,
    rawDir: jobDir,
    ...(authFailure ? { socialAuthFailureKind: authFailure.kind, socialAuthFailureCategory: authFailure.category } : {}),
  });
  let ytDlpAttempts;
  try {
    const runAttempts = options.runInstagramYtDlpAttempts || runInstagramYtDlpAttempts;
    ytDlpAttempts = await runAttempts(url, jobDir, { signal });
  } catch (error) {
    await fs.rm(jobDir, { recursive: true, force: true });
    throw error;
  }
  for (const attempt of ytDlpAttempts.failures) {
    errors.push(attempt.error);
    if (attempt.useCookies) {
      authFailure ||= classifyAuthenticatedProviderFailure(attempt.error, { authenticatedRequest: true });
    }
  }
  const authenticatedFallbackAttempted = ytDlpAttempts.cookieAttempted || ytDlpAttempts.failures.some((attempt) => attempt.useCookies);
  if (ytDlpAttempts.result) {
    const hasVideo = ytDlpAttempts.result.files?.some((file) => file.isVideo);
    if (!isReel || (hasVideo && ytDlpAttempts.result.hasAudio !== false)) {
      return withAuthFailure(ytDlpAttempts.result);
    }
    if (hasVideo) silentVideoFallback = ytDlpAttempts.result;
  }

  try {
    if (ytDlpAttempts.result || ytDlpAttempts.failures.length) await pauseInstagramRetry(signal);
    console.log("Instagram falling back to gallery-dl for the exact post.");
    const galleryDir = path.join(jobDir, "gallery-dl");
    await fs.mkdir(galleryDir, { recursive: true });
    const getGallery = options.downloadWithGalleryDl || downloadWithGalleryDl;
    const result = await getGallery(url, galleryDir, { signal });
    const hasVideo = result.files?.some((file) => file.isVideo);
    if (!isReel || (hasVideo && result.hasAudio !== false)) {
      return withAuthFailure(result);
    }
    if (hasVideo) silentVideoFallback ||= result;
  } catch (galleryError) {
    if (signal?.aborted) {
      await fs.rm(jobDir, { recursive: true, force: true });
      throw signal.reason || galleryError;
    }
    errors.push(galleryError);
    if (authenticatedFallbackAttempted) {
      authFailure ||= classifyAuthenticatedProviderFailure(galleryError, { authenticatedRequest: true });
    }
  }

  try {
    await pauseInstagramRetry(signal);
    const browserDir = path.join(jobDir, "browser");
    await fs.mkdir(browserDir, { recursive: true });
    const getReel = options.downloadInstagramReel || require("./instagramReelFallback").downloadInstagramReel;
    const getPhotos = options.downloadInstagramPhotos || require("./instagramPhotoFallback").downloadInstagramPhotos;
    const result = isReel
      ? await getReel(url, browserDir, { signal })
      : await getPhotos(url, browserDir, { signal });
    const browserResult = { files: result.files.map(probeFile), hasAudio: result.hasAudio, creator: result.creator, platform: "instagram" };
    if (!isReel || (browserResult.files.some((file) => file.isVideo) && browserResult.hasAudio !== false)) {
      return withAuthFailure(browserResult);
    }
    if (browserResult.files.some((file) => file.isVideo)) silentVideoFallback ||= browserResult;
  } catch (browserError) {
    if (signal?.aborted) {
      await fs.rm(jobDir, { recursive: true, force: true });
      throw signal.reason || browserError;
    }
    errors.push(browserError);
    if (["session", "owner"].includes(browserError?.socialAuthFailureKind)) {
      authFailure ||= {
        kind: browserError.socialAuthFailureKind,
        category: browserError.socialAuthFailureCategory,
      };
    }
  }

  if (silentVideoFallback) return withAuthFailure(silentVideoFallback);
  await fs.rm(jobDir, { recursive: true, force: true });
  const summary = errors
    .map((error) => String(error?.stderr || error?.message || error))
    .filter(Boolean)
    .join(" | ");
  const failure = new Error(`Instagram exhausted its safe download methods: ${summary}`);
  if (authFailure) {
    failure.socialAuthFailureKind = authFailure.kind;
    failure.socialAuthFailureCategory = authFailure.category;
  }
  throw failure;
}

async function runInstagramYtDlpAttempts(url, jobDir, options = {}) {
  const signal = options.signal;
  const cookiePath = process.env.INSTAGRAM_COOKIES || path.resolve(__dirname, "../../instagram-cookies.txt");
  const download = options.download || downloadWithYtDlp;
  const failures = [];
  let bestResult = null;
  let cookieAttempted = false;

  // Reels try the configured session first, then public retrieval. Preserve
  // the existing public-first order for other Instagram media. Keep attempts
  // isolated so a failed second attempt cannot delete a usable first result.
  let attemptIndex = 0;
  const attemptOrder = isInstagramReelUrl(url) ? [true, false] : [false, true];
  for (const useCookies of attemptOrder) {
    let attemptDir = path.join(jobDir, useCookies ? "yt-dlp-cookie" : "yt-dlp-public");
    if (useCookies) {
      try {
        await fs.access(cookiePath);
      } catch {
        continue;
      }
      cookieAttempted = true;
    }

    if (attemptIndex > 0) await pauseInstagramRetry(signal);
    attemptIndex += 1;

    try {
      await fs.mkdir(attemptDir, { recursive: true });
      const result = await download(url, attemptDir, { useCookies, signal });
      if (result?.hasAudio !== false) return { result, failures, cookieAttempted };
      bestResult ||= result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      failures.push({ error, useCookies });
      console.warn(`Instagram yt-dlp ${useCookies ? "cookie" : "public fallback"} attempt failed.`);
      await fs.rm(attemptDir, { recursive: true, force: true });
    }
  }

  return { result: bestResult, failures, cookieAttempted };
}

/**
 * Downloads media using yt-dlp.
 *
 * @param {string} url
 * @param {string} jobDir
 * @returns {Promise<DownloadResult>}
 */
async function hasAudioStream(filePath) {
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

async function hasVideoStream(filePath) {
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ["-v", "error", "-select_streams", "v", "-show_entries", "stream=index", "-of", "csv=p=0", filePath],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

async function findVerifiedVideoFiles(jobDir, options = {}) {
  const checkVideo = options.hasVideoStream || hasVideoStream;
  const paths = await findMediaFiles(jobDir);
  const videos = paths.filter((filePath) => probeFile(filePath).isVideo);
  const verified = [];
  for (const filePath of videos) {
    options.signal?.throwIfAborted();
    if (await checkVideo(filePath)) verified.push(filePath);
  }
  return verified;
}

async function runInstagramYtDlp(url, outputTemplate, format, options = {}) {
  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";
  const cookiesPath =
    process.env.INSTAGRAM_COOKIES ||
    path.resolve(__dirname, "../../instagram-cookies.txt");
  const args = [
    // This helper is Instagram-only; leave every other platform's network
    // behavior unchanged while avoiding broken IPv6 routes to Instagram.
    "--force-ipv4",
    "--no-playlist",
    "--no-warnings",
    "--keep-video",
    "--print",
    `before_dl:${YTDLP_FORMATS_PREFIX}%(formats.:.{format_id,ext,height,vcodec,acodec})j`,
    "--print",
    `after_move:${YTDLP_FILE_PREFIX}%(filepath)s`,
    "-f",
    format,
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
  ];

  if (options.useCookies !== false) {
    try {
      await fs.access(cookiesPath);
      args.push("--cookies", cookiesPath);
    } catch {
      console.warn("Instagram cookies were not available for this download.");
    }
  }

  args.push(url);
  const run = options.execFileAsync || execFileAsync;
  try {
    const { stdout } = await run(ytDlpPath, args, {
      windowsHide: true,
      timeout: 120000,
      killSignal: "SIGKILL",
      maxBuffer: 20 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return parseInstagramYtDlpOutput(stdout);
  } catch (error) {
    error.instagramFormats = parseInstagramYtDlpOutput(error.stdout).formats;
    throw error;
  }
}

function logInstagramFormatList(stage, formats) {
  console.warn(`Instagram ${stage} produced video without verified audio; available formats: ${JSON.stringify(sanitizeInstagramFormats(formats))}`);
}

/**
 * Downloads Instagram video with an audio-preserving retry.
 *
 * @param {string} url
 * @param {string} jobDir
 * @returns {Promise<DownloadResult>}
 */
async function downloadWithYtDlp(url, jobDir, options = {}) {
  const shortcode = instagramReelShortcode(url);
  const firstTemplate = path.join(
    jobDir,
    "harmony-%(id)s.%(ext)s"
  );

  let initialFormats = [];
  let paths;
  try {
    const initial = await runInstagramYtDlp(url, firstTemplate, "bv+ba/b", options);
    paths = initial.paths;
    initialFormats = initial.formats;
  } catch (error) {
    initialFormats = error.instagramFormats || [];
    paths = (await findVerifiedVideoFiles(jobDir, options))
      .filter((filePath) => isExactInstagramReelFile(filePath, shortcode));
    if (!paths.length) throw error;
    console.warn("Instagram yt-dlp merge failed; preserving a verified downloaded video for recovery.");
  }

  if (paths.length === 0) {
    paths = (await findVerifiedVideoFiles(jobDir, options))
      .filter((filePath) => isExactInstagramReelFile(filePath, shortcode));
    if (paths.length === 0) {
      throw new Error("yt-dlp did not return a downloaded file path or retain a usable video.");
    }
    console.warn("Instagram yt-dlp did not report a merged path; preserving its verified video output.");
  }

  let files = paths
    .map(probeFile)
    .filter((file) => (file.isImage || file.isVideo) && isExactInstagramReelFile(file.path, shortcode));

  if (files.length === 0) {
    throw new Error(
      "yt-dlp did not produce any supported media files."
    );
  }

  const video = files.find((file) => file.isVideo);
  const checkAudio = options.hasAudioStream || hasAudioStream;
  let audioRecovered = !video || (await checkAudio(video.path));
  if (video && !audioRecovered) {
    logInstagramFormatList("initial yt-dlp attempt", initialFormats);
    await pauseInstagramRetry(options.signal);
    console.warn(
      "Instagram download had no audio stream. Retrying with separate video and audio formats..."
    );

    const retryTemplate = path.join(
      jobDir,
      "harmony-with-audio-%(id)s.%(ext)s"
    );

    try {
      let retry;
      try {
        retry = await runInstagramYtDlp(
        url,
        retryTemplate,
        "bv+ba/b[acodec!=none]",
        options
        );
      } catch (retryError) {
        const recoveredPaths = (await findVerifiedVideoFiles(jobDir, options))
          .filter((filePath) => isExactInstagramReelFile(filePath, shortcode, true));
        if (!recoveredPaths.length) throw retryError;
        retry = { paths: recoveredPaths, formats: retryError.instagramFormats || [] };
        console.warn("Instagram separate-stream merge failed; checking its retained video output.");
      }
      const retryPaths = retry.paths.filter((filePath) => isExactInstagramReelFile(filePath, shortcode, true));
      const retryFiles = retryPaths
        .map(probeFile)
        .filter((file) => file.isImage || file.isVideo);
      const retryVideo = retryFiles.find((file) => file.isVideo);
      if (retryVideo) {
        const retryHasAudio = await checkAudio(retryVideo.path);
        if (!retryHasAudio) logInstagramFormatList("separate-stream retry", retry.formats);
        const keep = new Set(retryPaths);
        await Promise.all(
          paths
            .filter((filePath) => !keep.has(filePath))
            .map((filePath) => fs.unlink(filePath).catch(() => {}))
        );
        paths = retryPaths;
        files = retryFiles;
        audioRecovered = retryHasAudio;
        console.log(retryHasAudio
          ? "Instagram audio retry succeeded; merged video contains audio."
          : "Instagram audio retry produced a usable video without audio; keeping the video.");
      } else {
        await Promise.all(
          retryPaths.map((filePath) => fs.unlink(filePath).catch(() => {}))
        );
        console.warn(
          "Instagram did not expose a usable audio stream; keeping the original video."
        );
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      console.warn("Instagram audio retry failed during media processing.");
    }
  }

  if (video && !audioRecovered) {
    console.warn("Instagram reel is usable as video, but no audio stream was verified.");
  }

  return {
    files,
    rawDir: jobDir,
    platform: "instagram",
    hasAudio: video ? audioRecovered : null,
  };
}

/**
 * Downloads media using gallery-dl.
 *
 * @param {string} url
 * @param {string} jobDir
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<DownloadResult>}
 */
async function downloadWithGalleryDl(url, jobDir, options = {}) {
  const galleryDlPath =
    process.env.GALLERYDL_PATH || "gallery-dl";

  const cookiesPath =
    process.env.INSTAGRAM_COOKIES ||
    path.resolve(
      __dirname,
      "../../instagram-cookies.txt"
    );

  const args = [
    "-o",
    // Let gallery-dl use the DASH manifest so its downloader can fetch
    // separate video and audio streams and merge them with ffmpeg.
    "extractor.instagram.videos=true",
    "-d",
    jobDir,
  ];
  try {
    await fs.access(cookiesPath);
    args.unshift("--cookies", cookiesPath);
  } catch {
    console.warn("Instagram gallery-dl is continuing without cookies.");
  }
  args.push(url);

  const run = options.execFileAsync || execFileAsync;
  await run(
    galleryDlPath,
    args,
    {
      windowsHide: true,
      // Keep this recovery stage shorter than Instagram's overall lifecycle
      // window so exact-record browser recovery still has time to run.
      timeout: INSTAGRAM_GALLERY_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 20 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    }
  );

  // Brief pause for Windows to finish exposing written files.
  await new Promise((resolve) =>
    setTimeout(resolve, 300)
  );

  const paths = await findMediaFiles(jobDir);

  if (paths.length === 0) {
    throw new Error(
      "gallery-dl did not download any media files."
    );
  }

  paths.sort((a, b) =>
    a.localeCompare(b, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

  const files = paths
    .map(probeFile)
    .filter((file) => file.isImage || file.isVideo);

  if (files.length === 0) {
    throw new Error(
      "gallery-dl did not produce any supported media files."
    );
  }

  const video = files.find((file) => file.isVideo);
  const checkAudio = options.hasAudioStream || hasAudioStream;
  const hasAudio = video ? await checkAudio(video.path) : null;

  return {
    files,
    rawDir: jobDir,
    platform: "instagram",
    hasAudio,
  };
}

module.exports = {
  downloadMedia,
  probeFile,
  runInstagramYtDlpAttempts,
  downloadWithYtDlp,
  runInstagramYtDlp,
  downloadWithGalleryDl,
  parseInstagramYtDlpOutput,
  sanitizeInstagramFormats,
};
