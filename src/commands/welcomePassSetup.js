const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require("discord.js");
const {
  saveWelcomePassSettings,
} = require("../stores/welcomePassStore");
const {
  assignAllApprovedWelcomePasses,
} = require("../services/welcomePassService");

const data = new SlashCommandBuilder()
  .setName("harmony-pass-setup")
  .setDescription("Choose the STAY role and private Welcome Pass alert channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addRoleOption((option) =>
    option
      .setName("role")
      .setDescription("Role Harmony grants after approval")
      .setRequired(true)
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Private channel for successful role alerts")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
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
  const channel = interaction.options.getChannel("channel", true);
  const harmony = interaction.guild.members.me;

  if (role.managed || role.id === interaction.guild.id) {
    await interaction.editReply(
      "Please choose a normal server role, not an integration role or @everyone."
    );
    return;
  }

  if (!harmony.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply(
      "Harmony needs the **Manage Roles** permission before it can grant STAY."
    );
    return;
  }

  if (harmony.roles.highest.comparePositionTo(role) <= 0) {
    await interaction.editReply(
      "Move Harmony’s bot role above **" + role.name + "** in Server Settings → Roles, then run this command again."
    );
    return;
  }

  saveWelcomePassSettings({
    guildId: interaction.guild.id,
    roleId: role.id,
    channelId: channel.id,
  });

  await assignAllApprovedWelcomePasses(interaction.client);

  await interaction.editReply({
    content: [
      "Welcome Pass role automation is ready. 💜",
      "",
      "Approved role: <@&" + role.id + ">",
      "Private alerts: <#" + channel.id + ">",
      "",
      "Members can now use `/harmony-pass` with their confirmation code.",
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

module.exports = { data, execute };
