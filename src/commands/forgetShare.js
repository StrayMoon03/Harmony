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
const shareStore = require("../stores/shareStore");

const data = new SlashCommandBuilder()
  .setName("harmony-forget")
  .setDescription("Allow a previously shared social post to be shared again")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName("link")
      .setDescription("The Instagram, Facebook, TikTok, or X link to forget")
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

  return null;
}

async function execute(interaction) {
  const link = interaction.options.getString("link", true).trim();

  try {
    const key = await resolveShareKey(link);

    if (!key || !key.mediaId) {
      await interaction.reply({
        content:
          "I couldn’t recognize that link. Please use an Instagram, Facebook, TikTok, or X post link.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const removed = shareStore.remove(
      key.platform,
      key.mediaId
    );

    await interaction.reply({
      content: removed
        ? "That post has been removed from Harmony’s memory and can be shared again."
        : "Harmony doesn’t currently have that post saved in her memory.",
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error("Harmony forget command error:", error);

    const payload = {
      content:
        "I couldn’t remove that post from Harmony’s memory. Please check the Railway logs.",
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
}

module.exports = {
  data,
  execute,
};
