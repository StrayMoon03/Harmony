const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv"]);

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
 * Probe a file path into a MediaFile.
 * @param {string} filePath
 * @returns {MediaFile}
 */
function probeFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const isImage = IMAGE_EXT.has(ext);
  const isVideo = VIDEO_EXT.has(ext);

  let mime = "application/octet-stream";
  if (isImage) {
    mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  } else if (isVideo) {
    mime = ext === "mp4" ? "video/mp4" : `video/${ext}`;
  }

  return {
    path: filePath,
    mime,
    isImage,
    isVideo,
  };
}

/**
 * Recursively collect media files under a directory.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function findMediaFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findMediaFiles(fullPath)));
    } else if (/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm|mkv)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Downloads media from a supported public URL into src/temp.
 *
 * Uses yt-dlp first.
 * If Instagram reports no video formats, falls back to gallery-dl.
 *
 * Always returns every media file that was produced.
 *
 * @param {string} url
 * @returns {Promise<DownloadResult>}
 */
async function downloadMedia(url) {
  const tempDir = path.resolve(__dirname, "../../temp");
  await fs.mkdir(tempDir, { recursive: true });

  try {
    return await downloadWithYtDlp(url, tempDir);
  } catch (err) {
    const errorText = `${err.stderr || ""} ${err.message || ""}`.toLowerCase();

    if (
      errorText.includes("there is no video in this post") ||
      errorText.includes("no video formats found")
    ) {
      console.log("Instagram photo/carousel detected. Falling back to gallery-dl...");
      return await downloadWithGalleryDl(url, tempDir);
    }

    throw err;
  }
}

/**
 * @param {string} url
 * @param {string} tempDir
 * @returns {Promise<DownloadResult>}
 */
async function downloadWithYtDlp(url, tempDir) {
  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";

  const outputTemplate = path.join(
    tempDir,
    `harmony-${Date.now()}-%(id)s.%(ext)s`
  );

  const { stdout } = await execFileAsync(
    ytDlpPath,
    [
      "--no-playlist",
      "--no-warnings",
      "--print",
      "after_move:filepath",
      "-o",
      outputTemplate,
      url,
    ],
    {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("yt-dlp did not return a downloaded file path.");
  }

  const files = lines.map(probeFile);

  return {
    files,
    rawDir: tempDir,
    platform: "instagram",
  };
}

/**
 * @param {string} url
 * @param {string} tempDir
 * @returns {Promise<DownloadResult>}
 */
async function downloadWithGalleryDl(url, tempDir) {
  const galleryDlPath = process.env.GALLERYDL_PATH || "gallery-dl";

  const cookiesPath = path.resolve(
    __dirname,
    "../../instagram-cookies.txt"
  );

  // Snapshot existing media so we only return newly downloaded files.
  const before = new Set(await findMediaFiles(tempDir));

  await execFileAsync(
    galleryDlPath,
    [
      "--cookies",
      cookiesPath,
      "-d",
      tempDir,
      url,
    ],
    {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  const after = await findMediaFiles(tempDir);
  const newPaths = after.filter((p) => !before.has(p));

  if (newPaths.length === 0) {
    throw new Error("gallery-dl did not download any media files.");
  }

  // Sort for stable order (gallery-dl names are usually sequential).
  newPaths.sort((a, b) => a.localeCompare(b));

  const files = newPaths.map(probeFile);

  return {
    files,
    rawDir: tempDir,
    platform: "instagram",
  };
}

module.exports = {
  downloadMedia,
  probeFile,
};
