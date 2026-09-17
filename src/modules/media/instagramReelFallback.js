const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { withBrowserLock } = require("./browserLock");
const exec = promisify(execFile);
const MAX_BYTES = 100 * 1024 * 1024;

function exactReelCode(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?reels?\/([A-Za-z0-9_-]+)\/?$/);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !["instagram.com", "www.instagram.com"].includes(url.hostname) || !match) {
    throw new Error("Instagram reel fallback requires an exact reel URL");
  }
  return match[1];
}

async function saveVerifiedReel(result, expectedCode, jobDir, deps = {}) {
  if (!result || result.code !== expectedCode || typeof result.video !== "string") throw new Error("Instagram reel identity mismatch");
  const url = new URL(result.video);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !/\.(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) throw new Error("Instagram reel URL rejected");
  const request = deps.fetch || fetch;
  const run = deps.exec || exec;
  const file = path.join(jobDir, "instagram-verified-reel.mp4");
  let response;
  try {
    response = await request(result.video, { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok || !/^video\//i.test(response.headers.get("content-type") || "")) throw new Error("Instagram reel response was not a video");
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Instagram reel exceeds recovery size limit");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error("Instagram reel exceeds recovery size limit");
      chunks.push(Buffer.from(chunk));
    }
    if (size < 1024) throw new Error("Instagram reel file was incomplete");
    await fs.writeFile(file, Buffer.concat(chunks));
    const { stdout } = await run(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", file], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    const streams = JSON.parse(stdout).streams || [];
    if (!streams.some(s => s.codec_type === "video") || !streams.some(s => s.codec_type === "audio")) throw new Error("Instagram reel recovery needs verified video and audio");
    return [file];
  } catch {
    await fs.rm(file, { force: true });
    // Network/probe exceptions may contain signed URLs; never propagate them.
    throw new Error("Instagram exact reel recovery could not verify a playable video with audio");
  }
}

async function downloadInstagramReel(url, jobDir) {
  const code = exactReelCode(url);
  let stdout;
  try {
    ({ stdout } = await withBrowserLock(() => exec(process.env.PYTHON_PATH || "python3", [path.join(__dirname, "instagramReelBrowser.py"), url], { timeout: 45000, maxBuffer: 1024 * 1024 })));
  } catch {
    throw new Error("Instagram browser could not verify the requested reel");
  }
  const line = stdout.split(/\r?\n/).find(x => x.startsWith("HARMONY_INSTAGRAM_REEL:"));
  if (!line) throw new Error("Instagram browser returned no verified reel");
  let result;
  try { result = JSON.parse(line.slice("HARMONY_INSTAGRAM_REEL:".length)); }
  catch { throw new Error("Instagram browser returned invalid reel metadata"); }
  const files = await saveVerifiedReel(result, code, jobDir);
  return { files, creator: result.creator };
}

module.exports = { downloadInstagramReel, saveVerifiedReel, exactReelCode };
