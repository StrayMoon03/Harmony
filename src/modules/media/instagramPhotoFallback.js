const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { withBrowserLock } = require("./browserLock");
const exec = promisify(execFile);
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function mediaItems(result) {
  if (Array.isArray(result?.items) && result.items.length) return result.items;
  if (Array.isArray(result?.photos)) return result.photos.map((url) => ({ type: "image", url }));
  return [];
}

function isAllowedMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && /\.(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname);
  } catch {
    return false;
  }
}

async function saveVerifiedPhotos(result, expectedCode, jobDir, options = {}) {
  const items = mediaItems(result);
  if (result.code !== expectedCode || !items.length || items.length > 20) throw new Error("Instagram photo identity mismatch");
  const saved = [];
  const request = options.fetch || fetch;
  try {
    for (const [index, item] of items.entries()) {
      options.signal?.throwIfAborted();
      const kind = item?.type === "video" ? "video" : "image";
      if (!isAllowedMediaUrl(item?.url)) {
        if (kind === "video") continue;
        throw new Error("Instagram photo URL rejected");
      }
      const timeout = kind === "video" ? 30000 : 15000;
      const requestSignal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout);
      try {
        const response = await request(item.url, { redirect: "error", signal: requestSignal });
        if (!response.ok) throw new Error(kind === "video" ? `Instagram video request failed: HTTP ${response.status}` : `Instagram photo request failed: HTTP ${response.status}`);
        const type = response.headers.get("content-type") || "";
        if (kind === "video" ? !type.startsWith("video/") : !type.startsWith("image/")) {
          throw new Error(kind === "video" ? "Instagram video response was not a video" : "Instagram photo response was not an image");
        }
        if (kind === "video" && Number(response.headers.get("content-length")) > MAX_VIDEO_BYTES) {
          throw new Error("Instagram video exceeds recovery size limit");
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 1024) throw new Error(kind === "video" ? "Instagram video file was incomplete" : "Instagram photo file was incomplete");
        if (kind === "video" && bytes.length > MAX_VIDEO_BYTES) throw new Error("Instagram video exceeds recovery size limit");
        const ext = kind === "video"
          ? (type.includes("webm") ? "webm" : type.includes("quicktime") ? "mov" : "mp4")
          : (type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg");
        const file = path.join(jobDir, `instagram-media-${String(index).padStart(3, "0")}.${ext}`);
        await fs.writeFile(file, bytes);
        saved.push(file);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason || error;
        if (kind === "video") continue;
        throw error;
      }
    }
    if (!saved.length) throw new Error("Instagram browser returned no verified media");
    return saved;
  } catch (error) {
    await Promise.all(saved.map((file) => fs.rm(file, { force: true })));
    throw error;
  }
}

async function downloadInstagramPhotos(url, jobDir, options = {}) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?p\/([A-Za-z0-9_-]+)\/?$/);
  if (parsed.protocol !== "https:" || !match || !["instagram.com", "www.instagram.com"].includes(parsed.hostname)) throw new Error("Instagram photo fallback requires an exact post URL");
  const run = options.exec || exec;
  const env = options.env || process.env;
  const attempt = async (useSession) => {
    const args = [path.join(__dirname, "instagramPhotoBrowser.py"), url, ...(useSession ? ["--session"] : [])];
    const { stdout } = await withBrowserLock(() => run(env.PYTHON_PATH || "python3", args, { timeout: 45000, maxBuffer: 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}) }), { signal: options.signal });
    const line = String(stdout || "").split(/\r?\n/).find((x) => x.startsWith("HARMONY_INSTAGRAM_PHOTOS:"));
    if (!line) throw new Error("Instagram browser returned no verified media");
    const result = JSON.parse(line.slice("HARMONY_INSTAGRAM_PHOTOS:".length));
    options.signal?.throwIfAborted();
    const files = await saveVerifiedPhotos(result, match[1], jobDir, options);
    return { files, creator: result.creator };
  };
  try {
    return await attempt(false);
  } catch (error) {
    if (options.signal?.aborted || !env.INSTAGRAM_COOKIES) throw error;
    // Some posts (for example accounts with a viewer minimum age) only open
    // for a signed-in viewer. Retry once with Harmony's own Instagram session.
    console.log("Instagram photo browser retrying with Harmony's Instagram session.");
    try {
      return await attempt(true);
    } catch (sessionError) {
      if (options.signal?.aborted) throw sessionError;
      throw new Error(`${error.message}; session retry: ${sessionError.message}`);
    }
  }
}

module.exports = { downloadInstagramPhotos, saveVerifiedPhotos };
