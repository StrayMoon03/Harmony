const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

const {
  findInstagramLinks,
  extractInstagramId,
} = require("../modules/media/instagram");
const {
  findFacebookLinks,
  extractFacebookId,
} = require("../modules/media/facebook");
const {
  normalizeFacebookUrl,
} = require("../modules/media/facebookNormalize");
const {
  findTikTokLinks,
  extractTikTokId,
} = require("../modules/media/tiktok");
const {
  normalizeTikTokUrl,
} = require("../modules/media/tiktokNormalize");
const {
  findXLinks,
  extractXId,
} = require("../modules/media/x");
const {
  findYouTubeLinks,
  extractYouTubeId,
} = require("../modules/media/youtube");
const {
  findThreadsLinks,
  extractThreadsId,
} = require("../modules/media/threads");
const shareStore = require("../stores/shareStore");

const data = new SlashCommandBuilder()
  .setName("harmony-forget")
  .setDescription("Allow a previously shared social post to be shared again")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName("link")
      .setDescription("The Instagram, Facebook, TikTok, X, YouTube, or Threads link")
      .setRequired(true)
  );

async function resolveShareKey(input) {
  const instagramUrl = findInstagramLinks(input)[0];
  if (instagramUrl) {
    return {
      platform: "instagram",
      mediaId: extractInstagramId(instagramUrl),
    };
  }

  const facebookUrl = findFacebookLinks(input)[0];
  if (facebookUrl) {
    const normalizedUrl = await normalizeFacebookUrl(facebookUrl);
    return {
      platform: "facebook",
      mediaId:
        extractFacebookId(normalizedUrl) ||
        extractFacebookId(facebookUrl) ||
        `url:${normalizedUrl}`,
    };
  }

  const tiktokUrl = findTikTokLinks(input)[0];
  if (tiktokUrl) {
    const normalizedUrl = await normalizeTikTokUrl(tiktokUrl);
    return {
      platform: "tiktok",
      mediaId: extractTikTokId(normalizedUrl),
    };
  }

  const xUrl = findXLinks(input)[0];
  if (xUrl) {
    return {
      platform: "x",
      mediaId: extractXId(xUrl),
    };
  }

  const youtubeUrl = findYouTubeLinks(input)[0];
  if (youtubeUrl) {
    return {
      platform: "youtube",
      mediaId: extractYouTubeId(youtubeUrl),
    };
  }

  const threadsUrl = findThreadsLinks(input)[0];
  if (threadsUrl) {
    return {
      platform: "threads",
      mediaId: extractThreadsId(threadsUrl),
    };
  }

  return null;
}

async function execute(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const link = interaction.options.getString("link", true).trim();

  try {
    const key = await resolveShareKey(link);

    if (!key || !key.mediaId) {
      await interaction.editReply({
        content:
          "I couldn’t recognize that link. Please use an Instagram, Facebook, TikTok, X, YouTube, or Threads post link.",
      });
      return;
    }

    const removed = shareStore.remove(
      key.platform,
      key.mediaId
    );

    await interaction.editReply({
      content: removed
        ? "That post has been removed from Harmony’s memory and can be shared again."
        : "Harmony doesn’t currently have that post saved in her memory.",
    });
  } catch (error) {
    console.error("Harmony forget command error:", error);

    await interaction.editReply({
      content:
        "I couldn’t remove that post from Harmony’s memory. Please check the Railway logs.",
    }).catch(() => {});
  }
}

module.exports = {
  data,
  execute,
};
