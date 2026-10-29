const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require("discord.js");
const { DEFAULT_RELEASE_MESSAGE } = require("../stores/welcomePassStore");
const { configureWelcomePass } = require("../services/welcomePassService");

const data = new SlashCommandBuilder()
  .setName("harmony-pass-setup")
  .setDescription("Configure Welcome Pass role automation and messages")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addRoleOption((option) =>
    option
      .setName("role")
      .setDescription("Role Harmony grants after approval")
      .setRequired(true)
  )
  .addChannelOption((option) =>
    option
      .setName("private-channel")
      .setDescription("Private channel for successful role alerts")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
  )
  .addChannelOption((option) =>
    option
      .setName("member-channel")
      .setDescription("Public channel where Harmony tells the member they are free")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("member-message")
      .setDescription("Use {member}, {name}, and {server}; blank uses Harmony’s default")
      .setMaxLength(1000)
      .setRequired(false)
  );

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guild) {
    await interaction.editReply(
      "This command can only be used inside a Discord server."
    );
    return;
  }

  const role = interaction.options.getRole("role", true);
  const privateChannel = interaction.options.getChannel(
    "private-channel",
    true
  );
  const memberChannel = interaction.options.getChannel(
    "member-channel",
    true
  );
  const memberMessage =
    interaction.options.getString("member-message") ||
    DEFAULT_RELEASE_MESSAGE;
  try {
    await configureWelcomePass(interaction.client, {
      guildId: interaction.guild.id,
      roleId: role.id,
      channelId: privateChannel.id,
      releaseChannelId: memberChannel.id,
      releaseMessage: memberMessage,
    });
  } catch (error) {
    await interaction.editReply(error.message || "Harmony could not save Welcome Pass settings.");
    return;
  }

  await interaction.editReply({
    content: [
      "Welcome Pass role automation is ready. 💜",
      "",
      "Approved role: <@&" + role.id + ">",
      "Private alerts: <#" + privateChannel.id + ">",
      "Member message: <#" + memberChannel.id + ">",
      "",
      "**Message preview**",
      memberMessage
        .replaceAll("{member}", "<@" + interaction.user.id + ">")
        .replaceAll(
          "{name}",
          interaction.member?.displayName ||
            interaction.user.globalName ||
            interaction.user.username
        )
        .replaceAll("{server}", interaction.guild.name),
      "",
      "Members can use `/harmony-pass` with their confirmation code.",
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

module.exports = { data, execute };
