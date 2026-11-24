const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const { getPanel } = require("../stores/adminRoomStore");
const { REFRESH_QUEUED_MESSAGE, refreshMemberCounts } = require("../services/memberCountService");

const data = new SlashCommandBuilder()
  .setName("harmony-member-counts")
  .setDescription("Manage the private member counter in the Harmony Admin Room")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) => subcommand
    .setName("refresh")
    .setDescription("Refresh the private member counter"))
  .addSubcommand((subcommand) => subcommand
    .setName("status")
    .setDescription("Show the private member counter location"));

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getSubcommand();

  try {
    if (action === "status") {
      const panel = getPanel(interaction.guildId);
      await interaction.editReply(panel?.enabled
        ? `Harmony Admin Room: <#${panel.channel_id}>. Open Member Counts there to manage the private counter.`
        : "Install the Harmony Admin Room to enable the private member counter.");
      return;
    }
    if (action === "refresh") {
      const result = await refreshMemberCounts(interaction.guild);
      await interaction.editReply(result.queued ? REFRESH_QUEUED_MESSAGE
        : result.privateRefreshed ? "Private member counts refreshed." : "The Admin Room is unavailable.");
      return;
    }
    await interaction.editReply("Use `/harmony-member-counts refresh` or `/harmony-member-counts status`.");
  } catch (error) {
    console.error("Harmony member count command error:", error);
    await interaction.editReply(`Private member counter: ${error.message}`).catch(() => {});
  }
}

module.exports = { data, execute };
