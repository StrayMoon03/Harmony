const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * Runs yt-dlp and returns soft metadata about a public media post.
 * Never decides media type — that is the job of the classifier
 * after files have actually been downloaded.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function getMediaInfo(url) {
  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";

  let stdout;

  try {
    ({ stdout } = await execFileAsync(
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
    ));
  } catch (err) {
    // Some sites still return usable JSON even when yt-dlp exits non-zero.
    if (err.stdout) {
      stdout = err.stdout;
    } else {
      throw err;
    }
  }

  const info = JSON.parse(stdout);

  return {
    uploader:
      info.uploader ||
      info.channel ||
      info.creator ||
      info.uploader_id ||
      info.channel_id ||
      null,

    creator:
      info.creator ||
      info.uploader ||
      info.channel ||
      null,

    title: info.title || null,
    description: info.description || null,
    webpage_url: info.webpage_url || url,

    // Keep the raw object available for future needs.
    _raw: info,
  };
}

module.exports = {
  getMediaInfo,
};