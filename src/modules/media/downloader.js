const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * Downloads media from a supported public URL into src/temp.
 *
 * @param {string} url
 * @returns {Promise<string>} Absolute path to the downloaded file.
 */
async function downloadMedia(url) {
  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";
  const tempDir = path.resolve(__dirname, "../../temp");

  await fs.mkdir(tempDir, { recursive: true });

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

  const filePath = stdout.trim().split(/\r?\n/).pop();

  if (!filePath) {
    throw new Error("yt-dlp did not return a downloaded file path.");
  }

  return filePath;
}

module.exports = {
  downloadMedia,
};