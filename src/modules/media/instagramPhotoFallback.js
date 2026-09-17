const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { withBrowserLock } = require("./browserLock");
const exec = promisify(execFile);

async function saveVerifiedPhotos(result, expectedCode, jobDir) {
  if (result.code !== expectedCode || !Array.isArray(result.photos) || !result.photos.length || result.photos.length > 20) throw new Error("Instagram photo identity mismatch");
  const saved = [];
  try {
    for (const [index, value] of result.photos.entries()) {
      const url = new URL(value);
      if (url.protocol !== "https:" || !/\.(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) throw new Error("Instagram photo URL rejected");
      const response = await fetch(value, { redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Instagram photo request failed: HTTP ${response.status}`);
      const type = response.headers.get("content-type") || "";
      if (!type.startsWith("image/")) throw new Error("Instagram photo response was not an image");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1024) throw new Error("Instagram photo file was incomplete");
      const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
      const file = path.join(jobDir, `instagram-photo-${String(index).padStart(3, "0")}.${ext}`);
      await fs.writeFile(file, bytes);
      saved.push(file);
    }
    return saved;
  } catch (error) {
    await Promise.all(saved.map((file) => fs.rm(file, { force: true })));
    throw error;
  }
}

async function downloadInstagramPhotos(url, jobDir) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?p\/([A-Za-z0-9_-]+)\/?$/);
  if (parsed.protocol !== "https:" || !match || !["instagram.com", "www.instagram.com"].includes(parsed.hostname)) throw new Error("Instagram photo fallback requires an exact post URL");
  const { stdout } = await withBrowserLock(() => exec(process.env.PYTHON_PATH || "python3", [path.join(__dirname, "instagramPhotoBrowser.py"), url], { timeout: 45000, maxBuffer: 1024 * 1024 }));
  const line = stdout.split(/\r?\n/).find((x) => x.startsWith("HARMONY_INSTAGRAM_PHOTOS:"));
  if (!line) throw new Error("Instagram browser returned no verified photos");
  const result = JSON.parse(line.slice("HARMONY_INSTAGRAM_PHOTOS:".length));
  const files = await saveVerifiedPhotos(result, match[1], jobDir);
  return { files, creator: result.creator };
}

module.exports = { downloadInstagramPhotos, saveVerifiedPhotos };
