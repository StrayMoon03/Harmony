const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { probeFile } = require("./downloader");
const { extractThreadsCreator } = require("./threads");

const execFileAsync = promisify(execFile);
const TEMP_ROOT = path.resolve(__dirname, "../../temp");

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
      !host.endsWith(".fbcdn.net") &&
      !host.endsWith(".cdninstagram.com") &&
      !host.endsWith(".threads.net") &&
      !host.endsWith(".threads.com")
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

async function imageIsLargeEnough(filePath) {
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
    return Boolean(
      match &&
      Number(match[1]) >= 300 &&
      Number(match[2]) >= 300
    );
  } catch {
    return false;
  }
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

  for (const candidate of [
    canonical.toString(),
    alternate.toString(),
    original.toString(),
  ]) {
    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        errors.push(`${candidate}: HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();
      if (html.length > 1000) {
        return {
          html,
          finalUrl: response.url || candidate,
          sourceUrl: candidate,
          status: response.status,
        };
      }
    } catch (error) {
      errors.push(
        `${candidate}: ${error instanceof Error ? error.message : error}`
      );
    }
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
async function downloadThreadsMedia(url) {
  await fs.mkdir(TEMP_ROOT, { recursive: true });

  const jobDir = path.join(
    TEMP_ROOT,
    `threads-${Date.now()}-${randomUUID()}`
  );
  await fs.mkdir(jobDir, { recursive: true });

  try {
    console.log("Threads page inspection starting.");

    const { html, finalUrl, sourceUrl, status } =
      await fetchThreadsPage(url);
    const decodedHtml = decodePageText(html);
    const diagnostics = inspectThreadsPage(decodedHtml);
    const candidates = collectCandidateUrls(decodedHtml);

    console.log("Threads page diagnostics:", {
      status,
      sourceHost: new URL(sourceUrl).hostname,
      finalHost: new URL(finalUrl).hostname,
      ...diagnostics,
      candidateCount: candidates.length,
    });

    if (candidates.length === 0) {
      throw new Error(
        "Threads did not expose downloadable media on this public post page."
      );
    }

    const files = [];

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
        `threads-${String(files.length).padStart(3, "0")}${ext}`
      );
      await fs.writeFile(dest, bytes);

      if (isImage && !(await imageIsLargeEnough(dest))) {
        await fs.rm(dest, { force: true });
        continue;
      }

      files.push(probeFile(dest));
    }

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
};
