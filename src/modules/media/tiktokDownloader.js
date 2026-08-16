const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { probeFile } = require("./downloader");

const execFileAsync = promisify(execFile);

const TEMP_ROOT = path.resolve(__dirname, "../../temp");

/**
 * Prefer formats that include audio. Fallbacks keep TikTok working when
 * only a combined or video-only stream exists.
 *
 * Primary: best video + best audio (merge), else best single file.
 * Retry:   force a format that is not audio-free when possible.
 */
const FORMAT_PREFER_AUDIO = "bv*+ba/b";
const FORMAT_RETRY_WITH_AUDIO =
  "bestvideo[vcodec^=avc1]+bestaudio/bestvideo[vcodec^=avc]+bestaudio/best[acodec!=none]/bv*+ba/b";

/**
 * Creates a private temporary folder for one TikTok download.
 *
 * @returns {Promise<string>}
 */
async function createTikTokJobDirectory() {
  await fs.mkdir(TEMP_ROOT, {
    recursive: true,
  });

  const jobDir = path.join(
    TEMP_ROOT,
    `tiktok-${Date.now()}-${randomUUID()}`
  );

  await fs.mkdir(jobDir, {
    recursive: true,
  });

  return jobDir;
}

/**
 * Recursively finds supported visual media files.
 *
 * Audio files are intentionally ignored. TikTok photo-mode
 * posts may include a separate music/audio file, but Harmony
 * only needs the images for the Multi-Photo post.
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
 * Collects downloaded visual media and converts each path
 * into Harmony's normal probed-file format.
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
 * True if ffprobe reports at least one audio stream.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileHasAudioStream(filePath) {
  const ffprobePath =
    process.env.FFPROBE_PATH || "ffprobe";

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
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }
    );

    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Downloads a normal TikTok video with yt-dlp.
 *
 * @param {string} url
 * @param {string} jobDir
 * @param {string} [formatSelector]
 */
async function runYtDlp(url, jobDir, formatSelector) {
  const ytDlpPath =
    process.env.YTDLP_PATH || "yt-dlp";

  const outputTemplate = path.join(
    jobDir,
    "tiktok-%(id)s.%(ext)s"
  );

  /** @type {string[]} */
  const args = [
    "--no-playlist",
    "--no-warnings",
  ];

  if (formatSelector) {
    args.push(
      "-f",
      formatSelector,
      "--merge-output-format",
      "mp4"
    );
  }

  args.push(
    "-o",
    outputTemplate,
    url
  );

  await execFileAsync(
    ytDlpPath,
    args,
    {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    }
  );
}

/**
 * Removes visual media files under jobDir so a retry
 * can write a clean set of outputs.
 *
 * @param {string} jobDir
 */
async function clearJobMediaFiles(jobDir) {
  const paths = await findMediaFiles(jobDir);

  await Promise.all(
    paths.map((p) => fs.unlink(p).catch(() => {}))
  );
}

/**
 * Downloads a TikTok photo-mode post with gallery-dl.
 * Also used as a VIDEO extraction fallback when yt-dlp fails.
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
      maxBuffer: 20 * 1024 * 1024,
    }
  );
}

/**
 * Reads TikTok metadata from gallery-dl and extracts
 * the creator's display name.
 *
 * TikTok exposes:
 *
 * author.nickname  -> display name
 * author.uniqueId  -> @username
 *
 * We prefer nickname because Harmony displays the
 * creator's human-facing display name.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function getGalleryDlCreator(url) {
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

    /**
     * gallery-dl's TikTok JSON contains nested arrays
     * and objects, so recursively search for an object
     * containing TikTok's author metadata.
     */
    function findCreator(value) {
      if (!value) return null;

      if (Array.isArray(value)) {
        for (const item of value) {
          const creator = findCreator(item);

          if (creator) {
            return creator;
          }
        }

        return null;
      }

      if (typeof value === "object") {
        if (
          value.author &&
          typeof value.author === "object"
        ) {
          const nickname =
            value.author.nickname;

          const uniqueId =
            value.author.uniqueId;

          if (
            typeof nickname === "string" &&
            nickname.trim()
          ) {
            return nickname.trim();
          }

          if (
            typeof uniqueId === "string" &&
            uniqueId.trim()
          ) {
            return uniqueId.trim();
          }
        }

        for (const child of Object.values(value)) {
          const creator = findCreator(child);

          if (creator) {
            return creator;
          }
        }
      }

      return null;
    }

    return findCreator(data);
  } catch (error) {
    console.warn(
      "TikTok gallery-dl creator lookup failed:",
      error.message
    );

    return null;
  }
}

/**
 * Determines whether a TikTok URL is a photo-mode post.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isTikTokPhotoPost(url) {
  return /\/photo\/\d+/i.test(url);
}

/**
 * True when yt-dlp failed before producing usable media
 * (webpage extract / unexpected response / similar).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isYtDlpExtractionFailure(err) {
  const text = `${err && err.message ? err.message : ""} ${
    err && err.stderr ? err.stderr : ""
  }`.toLowerCase();

  return (
    text.includes("unexpected response from webpage") ||
    text.includes("webpage request") ||
    text.includes("unable to extract") ||
    text.includes("no video formats") ||
    text.includes("unsupported url") ||
    text.includes("http error 4") ||
    text.includes("http error 5") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("failed to parse json") ||
    text.includes("jsondecodeerror") ||
    text.includes("empty media response") ||
    text.includes("tiktok") && text.includes("error")
  );
}

/**
 * Runs the yt-dlp A+B path for a VIDEO post:
 * prefer complete video+audio, probe, one stricter audio retry.
 *
 * Does not use gallery-dl.
 *
 * @param {string} url
 * @param {string} jobDir
 * @returns {Promise<{ hasAudio: boolean }>}
 */
async function downloadTikTokVideoWithYtDlp(url, jobDir) {
  console.log(
    `TikTok download: format selector "${FORMAT_PREFER_AUDIO}"`
  );

  await runYtDlp(url, jobDir, FORMAT_PREFER_AUDIO);

  await new Promise((resolve) =>
    setTimeout(resolve, 300)
  );

  let videoFiles = (await collectMediaFiles(jobDir))
    .filter((f) => f.isVideo);

  if (videoFiles.length === 0) {
    throw new Error(
      "yt-dlp finished but produced no TikTok video file."
    );
  }

  let hasAudio = await fileHasAudioStream(
    videoFiles[0].path
  );

  if (!hasAudio) {
    console.warn(
      "TikTok download has no audio stream. Retrying with audio-preferring selector…"
    );

    await clearJobMediaFiles(jobDir);

    try {
      await runYtDlp(
        url,
        jobDir,
        FORMAT_RETRY_WITH_AUDIO
      );
    } catch (retryErr) {
      console.warn(
        "TikTok audio retry failed:",
        retryErr.message || retryErr
      );

      await clearJobMediaFiles(jobDir);
      await runYtDlp(
        url,
        jobDir,
        FORMAT_PREFER_AUDIO
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 300)
    );

    videoFiles = (await collectMediaFiles(jobDir))
      .filter((f) => f.isVideo);

    if (videoFiles.length === 0) {
      throw new Error(
        "yt-dlp audio retry produced no TikTok video file."
      );
    }

    hasAudio = await fileHasAudioStream(
      videoFiles[0].path
    );

    if (hasAudio) {
      console.log(
        "TikTok audio retry succeeded — audio stream present."
      );
    } else {
      console.warn(
        "TikTok still has no audio stream after retry. Trying gallery-dl before accepting a silent file."
      );
      throw new Error(
        "yt-dlp produced a TikTok video without an audio stream."
      );
    }
  } else {
    console.log(
      "TikTok download includes an audio stream."
    );
  }

  return { hasAudio };
}

/**
 * gallery-dl fallback for VIDEO posts when yt-dlp extraction fails.
 * Does NOT run the yt-dlp audio-format retry.
 *
 * @param {string} url
 * @param {string} jobDir
 * @returns {Promise<{ hasAudio: boolean, creator: string|null }>}
 */
async function downloadTikTokVideoWithGalleryDl(url, jobDir) {
  console.warn(
    "TikTok yt-dlp failed. Falling back to gallery-dl for this video…"
  );

  await clearJobMediaFiles(jobDir);
  await runGalleryDl(url, jobDir);

  await new Promise((resolve) =>
    setTimeout(resolve, 300)
  );

  const files = await collectMediaFiles(jobDir);
  const videoFiles = files.filter((f) => f.isVideo);

  if (videoFiles.length === 0 && files.length === 0) {
    throw new Error(
      "gallery-dl fallback produced no supported TikTok media files."
    );
  }

  let hasAudio = false;

  if (videoFiles.length > 0) {
    hasAudio = await fileHasAudioStream(
      videoFiles[0].path
    );
  }

  const creator = await getGalleryDlCreator(url);

  if (creator) {
    console.log(
      `TikTok creator detected (gallery-dl fallback): ${creator}`
    );
  }

  if (hasAudio) {
    console.log(
      "TikTok gallery-dl fallback includes an audio stream."
    );
  } else if (videoFiles.length > 0) {
    console.warn(
      "TikTok gallery-dl fallback video has no audio stream."
    );
    throw new Error(
      "Both TikTok download methods returned video without audio."
    );
  }

  return { hasAudio, creator };
}

/**
 * Downloads TikTok media.
 *
 * Strategy:
 *
 * - /video/ posts use yt-dlp with audio-preferring format selection (A+B).
 *   If yt-dlp extraction/download fails, fall back to gallery-dl once.
 * - /photo/ posts use gallery-dl only (unchanged; no yt-dlp, no video ladder).
 *
 * Photo posts also use gallery-dl metadata to obtain
 * the creator's TikTok display name.
 *
 * @param {string} url
 * @returns {Promise<{
 *   files: Array<object>,
 *   rawDir: string,
 *   platform: string,
 *   creator: string|null,
 *   hasAudio: boolean
 * }>}
 */
async function downloadTikTokMedia(url) {
  const jobDir =
    await createTikTokJobDirectory();

  try {
    let creator = null;
    let hasAudio = false;

    if (isTikTokPhotoPost(url)) {
      console.log(
        "TikTok photo post detected. Using gallery-dl."
      );

      await runGalleryDl(url, jobDir);

      creator =
        await getGalleryDlCreator(url);

      if (creator) {
        console.log(
          `TikTok creator detected: ${creator}`
        );
      }

      // Photo-mode: visual images only; separate music files are ignored
      // by findMediaFiles. hasAudio stays false (not a video soundtrack).
      hasAudio = false;
    } else {
      console.log(
        "TikTok video detected. Using yt-dlp."
      );

      try {
        const ytResult =
          await downloadTikTokVideoWithYtDlp(
            url,
            jobDir
          );
        hasAudio = ytResult.hasAudio;
      } catch (ytErr) {
        console.warn(
          "TikTok yt-dlp path failed:",
          ytErr.message || ytErr
        );

        if (!isYtDlpExtractionFailure(ytErr)) {
          // Unexpected non-extract failure: still try gallery-dl once
          // so public videos are not abandoned solely because of tooling.
          console.warn(
            "Treating failure as extraction-class; attempting gallery-dl video fallback."
          );
        }

        try {
          const gdlResult =
            await downloadTikTokVideoWithGalleryDl(
              url,
              jobDir
            );
          hasAudio = gdlResult.hasAudio;
          if (gdlResult.creator) {
            creator = gdlResult.creator;
          }
        } catch (gdlErr) {
          const ytMsg =
            ytErr instanceof Error
              ? ytErr.message
              : String(ytErr);
          const gdlMsg =
            gdlErr instanceof Error
              ? gdlErr.message
              : String(gdlErr);

          throw new Error(
            `TikTok video download failed (yt-dlp and gallery-dl).\n` +
              `yt-dlp: ${ytMsg}\n` +
              `gallery-dl: ${gdlMsg}`
          );
        }
      }
    }

    // Give Windows a brief moment to expose
    // all completed files.
    await new Promise((resolve) =>
      setTimeout(resolve, 300)
    );

    const files =
      await collectMediaFiles(jobDir);

    if (files.length === 0) {
      throw new Error(
        "TikTok did not produce any supported media files."
      );
    }

    console.log(
      `TikTok download succeeded (${files.length} file(s))`
    );

    return {
      files,
      rawDir: jobDir,
      platform: "tiktok",
      creator,
      hasAudio,
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
  downloadTikTokMedia,
  isTikTokPhotoPost,
  fileHasAudioStream,
  isYtDlpExtractionFailure,
  FORMAT_PREFER_AUDIO,
  FORMAT_RETRY_WITH_AUDIO,
};
