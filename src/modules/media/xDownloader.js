const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { probeFile } = require("./downloader");

const execFileAsync = promisify(execFile);

const TEMP_ROOT = path.resolve(__dirname, "../../temp");

function decodeXEmbedText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .trim();
}

async function getXTextEmbed(url) {
  try {
    const endpoint = new URL("https://publish.twitter.com/oembed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("omit_script", "true");
    endpoint.searchParams.set("dnt", "true");
    const response = await fetch(endpoint, {
      headers: { "User-Agent": "Harmony/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;

    const data = await response.json();
    const paragraph = String(data.html || "").match(
      /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i
    )?.[1];
    const text = decodeXEmbedText(paragraph);
    if (!text) return null;

    const authorName = String(data.author_name || "").trim();
    const handle = String(data.author_url || "").match(
      /(?:x|twitter)\.com\/([^/?#]+)/i
    )?.[1];
    const creator = authorName && handle
      ? `${authorName} (@${handle})`
      : authorName || (handle ? `@${handle}` : null);
    return { text, creator };
  } catch (error) {
    console.warn(
      "X text embed lookup failed:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}


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
 * @returns {Promise<{ creator: string|null, isGif: boolean }>}
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
    const expectedStatusId = String(url).match(/\/status\/(\d+)/i)?.[1] || null;

    let creator = null;
    let isGif = false;
    let hasMedia = false;
    let postText = null;
    let exactCreator = null;

    function walk(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
        return;
      }

      if (typeof value !== "object") return;

      const identities = [
        value.tweet_id,
        value.id_str,
        value.rest_id,
        value.id,
      ].map((item) => String(item || ""));
      const isRequestedStatus =
        expectedStatusId && identities.includes(expectedStatusId);

      if (isRequestedStatus) {
        const textCandidates = [
          value.full_text,
          value.content,
          value.text,
          value.description,
        ];
        postText = textCandidates.find(
          (item) => typeof item === "string" && item.trim()
        )?.trim() || postText;

        if (value.author && typeof value.author === "object") {
          const nick = String(value.author.nick || "").trim();
          const name = String(value.author.name || "").trim();
          exactCreator = name && nick
            ? `${name} (@${nick.replace(/^@/, "")})`
            : nick || name || exactCreator;
        }
      }

      // Original X media type from gallery-dl / Twitter API.
      if (value.type === "animated_gif") {
        isGif = true;
      }
      if (["animated_gif", "video", "photo"].includes(value.type)) {
        hasMedia = true;
      }

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
      }

      for (const child of Object.values(value)) {
        walk(child);
      }
    }

    walk(data);

    return {
      creator: exactCreator || creator,
      isGif,
      hasMedia,
      postText,
    };
  } catch (error) {
    console.warn(
      "X gallery-dl metadata lookup failed:",
      error.message
    );

    return {
      creator: null,
      isGif: false,
      hasMedia: null,
      postText: null,
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
    // text-only post, not a failed media download. Preserve X's native embed
    // and do not send it through the error-reporting path.
    if (meta.hasMedia === false) {
      const textEmbed = await getXTextEmbed(url);
      await fs.rm(jobDir, { recursive: true, force: true });
      return {
        files: [],
        rawDir: null,
        platform: "x",
        creator: textEmbed?.creator || creator,
        isGif: false,
        linkOnly: true,
        postText: textEmbed?.text || meta.postText,
      };
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
};
