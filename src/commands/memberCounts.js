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
  getMemberCountRoles,
  refreshMemberCounts,
} = require("../services/memberCountService");

const data = new SlashCommandBuilder()
  .setName("harmony-member-counts")
  .setDescription("Manage Harmony’s live server member counts")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) => subcommand
    .setName("setup")
    .setDescription("Set up public counters using the Welcome Pass Approved Role"))
  .addSubcommand((subcommand) => subcommand
    .setName("refresh")
    .setDescription("Refresh all three counters now"))
  .addSubcommand((subcommand) => subcommand
    .setName("status")
    .setDescription("Show the live-counter setup"))
  .addSubcommand((subcommand) => subcommand
    .setName("off")
    .setDescription("Stop automatic updates to the public SERVER STATS counters"));

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
      if (!getMemberCountRoles(interaction.guild).stayRoleId) {
        await interaction.editReply("Set the Approved Role in Welcome Pass before setting up SERVER STATS.");
        return;
      }
      const { category, counts, stayRoleId } = await setupMemberCounts(interaction.guild);
      await interaction.editReply([
        "📊 **Harmony’s live member counts are ready!**",
        `Category: **${category.name}**`,
        `Counting as approved: <@&${stayRoleId}>`,
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
      const description = !counts
        ? "Automatic SERVER STATS updates are off."
        : counts.stay === null
          ? `Updated: **${counts.total}** total. Set the Approved Role in Welcome Pass to refresh the STAY counters.`
          : `Updated: **${counts.total}** total, **${counts.stay}** with the Stay role, and **${counts.noRole}** without it.`;
      await interaction.editReply(description);
      return;
    }

    if (action === "status") {
      const { stayRoleId } = getMemberCountRoles(interaction.guild);
      await interaction.editReply([
        `Status: **${settings.enabled ? "On" : "Off"}**`,
        `Category: <#${settings.category_id}>`,
        `STAY role (Welcome Pass): ${stayRoleId ? `<@&${stayRoleId}>` : "Not configured"}`,
        `Total counter: <#${settings.total_channel_id}>`,
        `Stay counter: <#${settings.stay_channel_id}>`,
        `No Stay role counter: <#${settings.no_role_channel_id}>`,
      ].join("\n"));
      return;
    }

    const disabled = disableMemberCountSettings(interaction.guildId);
    await interaction.editReply(disabled
      ? "Automatic public SERVER STATS updates are off. The counter channels were left in place."
      : "Live member counts were not configured.");
  } catch (error) {
    console.error("Harmony member count command error:", error);
    await interaction.editReply(
      "Harmony couldn’t update the live counters. Check that she has **Manage Channels** and try again."
    ).catch(() => {});
  }
}

module.exports = { data, execute };
