const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { probeFile } = require("./downloader");

const execFileAsync = promisify(execFile);
const TEMP_ROOT = path.resolve(__dirname, "../../temp");
const MAX_YOUTUBE_UPLOAD_SECONDS = 4 * 60;

/**
 * Downloads one YouTube video with bounded network retries and a hard timeout.
 * The 720p ceiling keeps the source practical for Discord's upload compressor.
 *
 * @param {string} url
 * @returns {Promise<{
 *   files: Array<object>,
 *   rawDir: string,
 *   platform: string,
 *   creator: string|null
 * }>}
 */
async function downloadYouTubeMedia(url) {
  await fs.mkdir(TEMP_ROOT, { recursive: true });

  const jobDir = path.join(
    TEMP_ROOT,
    `youtube-${Date.now()}-${randomUUID()}`
  );
  await fs.mkdir(jobDir, { recursive: true });

  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";
  const outputTemplate = path.join(
    jobDir,
    "harmony-%(id)s.%(ext)s"
  );

  const isShort = /\/shorts\//i.test(url);
  const formatSelector = isShort
    ? "b[height<=720][ext=mp4]/b[height<=720]/bv*[height<=720]+ba/b[height<=720]/b"
    : "b[height<=480][ext=mp4]/b[height<=480]/bv*[height<=480]+ba/b[height<=480]/b";

  console.log("YouTube inspection starting.");

  const ytDlpArgs = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--js-runtimes",
    "node",
    "--socket-timeout",
    "20",
    "--retries",
    "2",
    "--fragment-retries",
    "2",
    "--print",
    "before_dl:HARMONY_CREATOR:%(uploader)s",
    "--print",
    "after_move:HARMONY_FILE:%(filepath)s",
    "-f",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
  ];

  const cookiesPath = process.env.YOUTUBE_COOKIES;
  if (cookiesPath) {
    ytDlpArgs.push("--cookies", cookiesPath);
    console.log("YouTube cookies: ready.");
  } else {
    console.warn(
      "YouTube cookies: missing — Railway may be blocked as a bot."
    );
  }

  ytDlpArgs.push(url);

  try {
    const inspectArgs = [
      "--no-playlist",
      "--no-warnings",
      "--js-runtimes",
      "node",
      "--skip-download",
      "--print",
      "HARMONY_DURATION:%(duration)s",
      "--print",
      "HARMONY_CREATOR:%(uploader)s",
    ];

    if (cookiesPath) {
      inspectArgs.push("--cookies", cookiesPath);
    }
    inspectArgs.push(url);

    const { stdout: inspectStdout } = await execFileAsync(
      ytDlpPath,
      inspectArgs,
      {
        windowsHide: true,
        timeout: 60000,
        killSignal: "SIGKILL",
        maxBuffer: 5 * 1024 * 1024,
      }
    );

    const inspectLines = String(inspectStdout).split(/\r?\n/);
    const durationLine = inspectLines.find((line) =>
      line.startsWith("HARMONY_DURATION:")
    );
    const durationSeconds = durationLine
      ? Number.parseFloat(
          durationLine.slice("HARMONY_DURATION:".length).trim()
        )
      : null;
    const inspectCreatorLine = inspectLines.find((line) =>
      line.startsWith("HARMONY_CREATOR:")
    );
    const inspectCreatorValue = inspectCreatorLine
      ? inspectCreatorLine.slice("HARMONY_CREATOR:".length).trim()
      : "";
    const inspectCreator =
      inspectCreatorValue &&
      inspectCreatorValue !== "NA" &&
      inspectCreatorValue !== "None"
        ? inspectCreatorValue
        : null;

    if (
      Number.isFinite(durationSeconds) &&
      durationSeconds > MAX_YOUTUBE_UPLOAD_SECONDS
    ) {
      console.log(
        `YouTube long video detected (~${Math.ceil(
          durationSeconds / 60
        )} minutes); using YouTube streaming preview.`
      );
      await fs.rm(jobDir, {
        recursive: true,
        force: true,
      });
      return {
        files: [],
        rawDir: null,
        platform: "youtube",
        creator: inspectCreator,
        linkOnly: true,
        durationSeconds,
      };
    }

    console.log(
      `YouTube download starting (${isShort ? "Short up to 720p" : "video up to 480p"}).`
    );

    const { stdout } = await execFileAsync(
      ytDlpPath,
      ytDlpArgs,
      {
        windowsHide: true,
        timeout: 180000,
        killSignal: "SIGKILL",
        maxBuffer: 30 * 1024 * 1024,
      }
    );

    const lines = String(stdout).split(/\r?\n/);
    const creatorLine = lines.find((line) =>
      line.startsWith("HARMONY_CREATOR:")
    );
    const creatorValue = creatorLine
      ? creatorLine.slice("HARMONY_CREATOR:".length).trim()
      : "";
    const creator =
      creatorValue &&
      creatorValue !== "NA" &&
      creatorValue !== "None"
        ? creatorValue
        : null;

    const downloadedPaths = lines
      .filter((line) => line.startsWith("HARMONY_FILE:"))
      .map((line) =>
        line.slice("HARMONY_FILE:".length).trim()
      )
      .filter(Boolean);

    if (downloadedPaths.length === 0) {
      throw new Error(
        "yt-dlp finished without returning a YouTube media file."
      );
    }

    const files = downloadedPaths
      .map(probeFile)
      .filter((file) => file.isImage || file.isVideo);

    if (files.length === 0) {
      throw new Error(
        "yt-dlp did not produce a supported YouTube media file."
      );
    }

    console.log(
      `YouTube download complete (${files.length} file(s)).`
    );

    return {
      files,
      rawDir: jobDir,
      platform: "youtube",
      creator,
      durationSeconds,
    };
  } catch (error) {
    await fs.rm(jobDir, {
      recursive: true,
      force: true,
    });

    if (
      error &&
      (error.killed || error.signal === "SIGKILL")
    ) {
      throw new Error(
        "YouTube took longer than three minutes to respond."
      );
    }

    throw error;
  }
}

module.exports = {
  downloadYouTubeMedia,
  MAX_YOUTUBE_UPLOAD_SECONDS,
};
