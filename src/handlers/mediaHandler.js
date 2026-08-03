const { getMediaInfo } = require("../services/ytDlp");
const { downloadMedia } = require("../modules/media/downloader");
const { formatMediaCard } = require("../modules/media/formatter");
const { uploadMedia } = require("../modules/media/uploader");
const {
  findInstagramLinks,
} = require("../modules/media/instagram");

/**
 * Handles supported social-media links in a Discord message.
 *
 * @param {import("discord.js").Message} message
 */
async function handleMediaMessage(message) {
  if (message.author.bot) return;

  const instagramLinks = findInstagramLinks(message.content);

  if (instagramLinks.length === 0) return;

  const originalUrl = instagramLinks[0];

  try {
    await message.channel.sendTyping();

    const info = await getMediaInfo(originalUrl);
    const filePath = await downloadMedia(originalUrl);

    const mediaType = originalUrl.includes("/reel/")
      ? "Reel"
      : "Post";

    const creator =
      info.uploader ||
      info.channel ||
      info.creator ||
      "Unknown creator";

    const cardText = formatMediaCard({
      platform: "Instagram",
      mediaType,
      creator,
      originalUrl,
      heart: "💗",
    });

    await uploadMedia(message, filePath, cardText);

    console.log(
      `Instagram ${mediaType.toLowerCase()} shared for ${message.author.username}`
    );
  } catch (error) {
    console.error("Harmony could not process the Instagram link:", error);

    await message
      .reply({
        content:
          "I couldn't retrieve that Instagram post, but the original link is still available above.",
        allowedMentions: {
          repliedUser: false,
        },
      })
      .catch(() => {});
  }
}

module.exports = {
  handleMediaMessage,
};