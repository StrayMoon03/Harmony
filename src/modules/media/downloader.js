const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const TEMP_ROOT = path.resolve(__dirname, "../../temp");

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
 * Instagram photo posts and carousels fall back to gallery-dl.
 *
 * Every download uses its own temporary folder.
 *
 * @param {string} url
 * @returns {Promise<DownloadResult>}
 */
async function downloadMedia(url) {
  const jobDir = await createJobDirectory();
  const errors = [];

  for (const useCookies of [true, false]) {
    try {
      return await downloadWithYtDlp(url, jobDir, { useCookies });
    } catch (error) {
      errors.push(error);
      console.warn(
        `Instagram yt-dlp ${useCookies ? "cookie" : "public"} attempt failed; ` +
          `${useCookies ? "retrying without cookies" : "trying gallery-dl"}.`
      );
      await fs.rm(jobDir, { recursive: true, force: true });
      await fs.mkdir(jobDir, { recursive: true });
    }
  }

  try {
    console.log("Instagram falling back to gallery-dl for the exact post.");
    return await downloadWithGalleryDl(url, jobDir, {
      requireAudio: errors.some((error) =>
        String(error?.message || "").includes("INSTAGRAM_AUDIO_MISSING")
      ),
    });
  } catch (galleryError) {
    errors.push(galleryError);
    await fs.rm(jobDir, { recursive: true, force: true });
    const summary = errors
      .map((error) => String(error?.stderr || error?.message || error))
      .filter(Boolean)
      .join(" | ");
    throw new Error(`Instagram exhausted its safe download methods: ${summary}`);
  }
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

async function runInstagramYtDlp(url, outputTemplate, format, options = {}) {
  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";
  const cookiesPath =
    process.env.INSTAGRAM_COOKIES ||
    path.resolve(__dirname, "../../instagram-cookies.txt");
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--print",
    "after_move:filepath",
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
  const { stdout } = await execFileAsync(ytDlpPath, args, {
    windowsHide: true,
    timeout: 120000,
    killSignal: "SIGKILL",
    maxBuffer: 20 * 1024 * 1024,
  });

  return stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Downloads Instagram video with an audio-preserving retry.
 *
 * @param {string} url
 * @param {string} jobDir
 * @returns {Promise<DownloadResult>}
 */
async function downloadWithYtDlp(url, jobDir, options = {}) {
  const firstTemplate = path.join(
    jobDir,
    "harmony-%(id)s.%(ext)s"
  );

  let paths = await runInstagramYtDlp(
    url,
    firstTemplate,
    "bv*+ba/b",
    options
  );

  if (paths.length === 0) {
    throw new Error(
      "yt-dlp did not return a downloaded file path."
    );
  }

  let files = paths
    .map(probeFile)
    .filter((file) => file.isImage || file.isVideo);

  if (files.length === 0) {
    throw new Error(
      "yt-dlp did not produce any supported media files."
    );
  }

  const video = files.find((file) => file.isVideo);
  let audioRecovered = !video || (await hasAudioStream(video.path));
  if (video && !audioRecovered) {
    console.warn(
      "Instagram download had no audio stream. Retrying with separate video and audio formats..."
    );

    const retryTemplate = path.join(
      jobDir,
      "harmony-with-audio-%(id)s.%(ext)s"
    );

    try {
      const retryPaths = await runInstagramYtDlp(
        url,
        retryTemplate,
        "bv+ba/b[acodec!=none]",
        options
      );
      const retryFiles = retryPaths
        .map(probeFile)
        .filter((file) => file.isImage || file.isVideo);
      const retryVideo = retryFiles.find((file) => file.isVideo);

      if (retryVideo && (await hasAudioStream(retryVideo.path))) {
        await Promise.all(
          paths.map((filePath) => fs.unlink(filePath).catch(() => {}))
        );
        paths = retryPaths;
        files = retryFiles;
        audioRecovered = true;
        console.log(
          "Instagram audio retry succeeded; merged video contains audio."
        );
      } else {
        await Promise.all(
          retryPaths.map((filePath) => fs.unlink(filePath).catch(() => {}))
        );
        console.warn(
          "Instagram did not expose a usable audio stream; keeping the original video."
        );
      }
    } catch (error) {
      console.warn(
        "Instagram audio retry failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  if (video && !audioRecovered) {
    throw new Error("INSTAGRAM_AUDIO_MISSING");
  }

  return {
    files,
    rawDir: jobDir,
    platform: "instagram",
  };
}

/**
 * Downloads media using gallery-dl.
 *
 * @param {string} url
 * @param {string} jobDir
 * @param {{ requireAudio?: boolean }} [options]
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
    "extractor.instagram.videos=merged",
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

  await execFileAsync(
    galleryDlPath,
    args,
    {
      windowsHide: true,
      timeout: 120000,
      killSignal: "SIGKILL",
      maxBuffer: 20 * 1024 * 1024,
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

  if (options.requireAudio) {
    const video = files.find((file) => file.isVideo);
    if (!video || !(await hasAudioStream(video.path))) {
      throw new Error(
        "Instagram did not expose a merged video with audio."
      );
    }
    console.log(
      "Instagram gallery-dl merged fallback contains audio."
    );
  }

  return {
    files,
    rawDir: jobDir,
    platform: "instagram",
  };
}

module.exports = {
  downloadMedia,
  probeFile,
};
