const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * Runs yt-dlp and returns information about a public media post.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function getMediaInfo(url) {
  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";

  const { stdout } = await execFileAsync(
    ytDlpPath,
    [
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      url,
    ],
    {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  return JSON.parse(stdout);
}

module.exports = {
  getMediaInfo,
};