const path = require("node:path");

/**
 * Best-effort creator name from downloaded file paths.
 * gallery-dl stores Instagram media under:
 *   <jobDir>/instagram/<username>/...
 *
 * @param {Array<{ path: string }>} files
 * @returns {string|null}
 */
function creatorFromFiles(files) {
  if (!files || files.length === 0) return null;

  for (const file of files) {
    const parts = path.normalize(file.path).split(path.sep);
    const igIndex = parts.findIndex(
      (p) => p.toLowerCase() === "instagram"
    );
    if (igIndex !== -1 && parts[igIndex + 1]) {
      const username = parts[igIndex + 1];
      // Skip junk folder names
      if (username && !username.startsWith("job-")) {
        return username;
      }
    }
  }

  return null;
}

/**
 * Resolve creator: prefer yt-dlp metadata, fall back to path, then default.
 *
 * @param {object|null} info
 * @param {Array<{ path: string }>} files
 * @returns {string}
 */
function resolveCreator(info, files) {
  return (
    info?.uploader ||
    info?.channel ||
    info?.creator ||
    creatorFromFiles(files) ||
    "Unknown creator"
  );
}

module.exports = {
  creatorFromFiles,
  resolveCreator,
};
