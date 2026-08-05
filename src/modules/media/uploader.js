const fs = require("node:fs/promises");
const path = require("node:path");

const TEMP_ROOT = path.resolve(__dirname, "../../temp");

/**
 * Remove a directory if it is empty. Walks upward toward TEMP_ROOT
 * so gallery-dl's nested folders (temp/instagram/username/) get cleaned.
 * Never deletes TEMP_ROOT itself.
 *
 * @param {string} dir
 */
async function removeEmptyDirsUpward(dir) {
  let current = path.resolve(dir);

  while (
    current.startsWith(TEMP_ROOT + path.sep) &&
    current !== TEMP_ROOT
  ) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length > 0) break;
      await fs.rmdir(current);
    } catch {
      // Directory gone, not empty, or permission — stop climbing.
      break;
    }
    current = path.dirname(current);
  }
}

/**
 * Uploads one or more media files to Discord, then deletes the
 * temporary files and any empty parent directories under temp/.
 *
 * @param {import("discord.js").Message} message
 * @param {Array<{ path: string }>} files
 * @param {string} cardText
 */
async function uploadMedia(message, files, cardText) {
  const paths = files.map((f) => f.path);

  try {
    await message.reply({
      content: cardText,
      files: paths,
      allowedMentions: {
        repliedUser: false,
      },
    });
  } finally {
    // Delete the media files first.
    await Promise.all(paths.map((p) => fs.unlink(p).catch(() => {})));

    // Then prune empty parent directories (gallery-dl creates
    // temp/instagram/<username>/ which would otherwise linger).
    const parentDirs = [...new Set(paths.map((p) => path.dirname(p)))];
    await Promise.all(parentDirs.map((d) => removeEmptyDirsUpward(d)));
  }
}

module.exports = {
  uploadMedia,
};
