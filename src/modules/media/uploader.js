const fs = require("node:fs/promises");

/**
 * Uploads media to Discord, then deletes the temporary file.
 *
 * @param {import("discord.js").Message} message
 * @param {string} filePath
 * @param {string} cardText
 */
async function uploadMedia(message, filePath, cardText) {
  try {
    await message.reply({
      content: cardText,
      files: [filePath],
      allowedMentions: {
        repliedUser: false,
      },
    });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

module.exports = {
  uploadMedia,
};