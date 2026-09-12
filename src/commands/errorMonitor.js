const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");
const {
  getErrorMonitorSettings,
  setErrorMonitorEnabled,
} = require("../stores/errorMonitorStore");

const data = new SlashCommandBuilder()
  .setName("harmony-monitor")
  .setDescription("Turn Harmony’s private automatic error reporting on or off")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub.setName("on").setDescription("Start sending sanitized failures to the private error repository")
  )
  .addSubcommand((sub) =>
    sub.setName("off").setDescription("Stop automatic GitHub error reports")
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Show whether automatic error reporting is on")
  );

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return interaction.editReply("Use this command inside your server.");

  const action = interaction.options.getSubcommand();
  if (action === "on") {
    if (
      !String(process.env.HARMONY_ERROR_GITHUB_TOKEN || "").trim() ||
      !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(String(process.env.HARMONY_ERROR_GITHUB_REPO || "").trim())
    ) {
      return interaction.editReply(
        "I can’t turn monitoring on because the private GitHub repository variables are missing or invalid in Railway."
      );
    }
    setErrorMonitorEnabled(true);
    return interaction.editReply(
      "✅ Harmony’s private error monitor is **on**. Sanitized media failures will be filed in the private Harmony-Errors repository. Nothing will merge or deploy automatically."
    );
  }

  if (action === "off") {
    setErrorMonitorEnabled(false);
    return interaction.editReply(
      "Harmony’s private error monitor is **off**. The existing private reports were left in place."
    );
  }

  const settings = getErrorMonitorSettings();
  return interaction.editReply([
    `Status: **${settings?.enabled ? "On" : "Off"}**`,
    `Private repository: **${process.env.HARMONY_ERROR_GITHUB_REPO || "Not configured"}**`,
    "Reports: **Sanitized media failures only**",
    "Automatic merging/deployment: **Off**",
  ].join("\n"));
}

module.exports = { data, execute };
