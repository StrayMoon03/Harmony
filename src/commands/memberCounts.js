const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");
const {
  getMemberCountSettings,
  disableMemberCountSettings,
} = require("../stores/memberCountStore");
const {
  setupMemberCounts,
  refreshMemberCounts,
} = require("../services/memberCountService");

const data = new SlashCommandBuilder()
  .setName("harmony-member-counts")
  .setDescription("Manage Harmony’s live server member counts")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) => subcommand
    .setName("setup")
    .setDescription("Create live member counters at the top of the server")
    .addRoleOption((option) => option
      .setName("stay-role")
      .setDescription("Role that marks an approved STAY")
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("refresh")
    .setDescription("Refresh all three counters now"))
  .addSubcommand((subcommand) => subcommand
    .setName("status")
    .setDescription("Show the live-counter setup"))
  .addSubcommand((subcommand) => subcommand
    .setName("off")
    .setDescription("Stop automatic counter updates"));

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getSubcommand();

  try {
    if (action === "setup") {
      const me = interaction.guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.editReply(
          "Harmony needs **Manage Channels** before she can create and update the live counters."
        );
        return;
      }
      const stayRole = interaction.options.getRole("stay-role", true);
      if (stayRole.id === interaction.guild.id) {
        await interaction.editReply("Please select your actual **Stay** role, not @everyone.");
        return;
      }
      const { category, counts } = await setupMemberCounts(
        interaction.guild,
        stayRole
      );
      await interaction.editReply([
        "📊 **Harmony’s live member counts are ready!**",
        `Category: **${category.name}**`,
        `Counting as approved: <@&${stayRole.id}>`,
        `Total members: **${counts.total}**`,
        `Stay role: **${counts.stay}**`,
        `No Stay role: **${counts.noRole}**`,
        "",
        "Harmony will update these when someone joins, leaves, or gains or loses the Stay role.",
      ].join("\n"));
      return;
    }

    const settings = getMemberCountSettings(interaction.guildId);
    if (!settings) {
      await interaction.editReply(
        "Live member counts are not set up yet. Use `/harmony-member-counts setup`."
      );
      return;
    }

    if (action === "refresh") {
      const counts = await refreshMemberCounts(interaction.guild);
      await interaction.editReply(
        `Updated: **${counts.total}** total, **${counts.stay}** with the Stay role, and **${counts.noRole}** without it.`
      );
      return;
    }

    if (action === "status") {
      await interaction.editReply([
        `Status: **${settings.enabled ? "On" : "Off"}**`,
        `Category: <#${settings.category_id}>`,
        `Stay role: <@&${settings.role_id}>`,
        `Total counter: <#${settings.total_channel_id}>`,
        `Stay counter: <#${settings.stay_channel_id}>`,
        `No Stay role counter: <#${settings.no_role_channel_id}>`,
      ].join("\n"));
      return;
    }

    const disabled = disableMemberCountSettings(interaction.guildId);
    await interaction.editReply(disabled
      ? "Automatic member-count updates are off. The counter channels were left in place."
      : "Live member counts were not configured.");
  } catch (error) {
    console.error("Harmony member count command error:", error);
    await interaction.editReply(
      "Harmony couldn’t update the live counters. Check that she has **Manage Channels** and try again."
    ).catch(() => {});
  }
}

module.exports = { data, execute };
