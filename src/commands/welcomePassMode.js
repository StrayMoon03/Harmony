const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");
const {
  getWelcomePassSettings,
  setWelcomePassGrantMode,
} = require("../stores/welcomePassStore");

const data = new SlashCommandBuilder()
  .setName("harmony-pass-mode")
  .setDescription("Choose automatic or manual STAY-role granting")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName("mode")
      .setDescription("How the STAY role should be granted")
      .setRequired(true)
      .addChoices(
        {
          name: "Automatic — Harmony grants STAY after approval",
          value: "automatic",
        },
        {
          name: "Manual — an admin grants STAY",
          value: "manual",
        }
      )
  );

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guild) {
    await interaction.editReply(
      "This command can only be used inside a Discord server."
    );
    return;
  }

  const settings = getWelcomePassSettings(interaction.guild.id);
  if (!settings) {
    await interaction.editReply(
      "Run `/harmony-pass-setup` before choosing a grant mode."
    );
    return;
  }

  const mode = interaction.options.getString("mode", true);
  setWelcomePassGrantMode(interaction.guild.id, mode);

  if (mode === "manual") {
    await interaction.editReply(
      "Welcome Pass mode is now **manual**. Harmony will never grant @Stay after approval. When an admin adds the configured @Stay role, Harmony will send the private confirmation and the public “you’re free” message. 💜"
    );
    return;
  }

  await interaction.editReply(
    "Welcome Pass mode is now **automatic**. After an approved pass matches one exact Discord @username, Harmony will grant @Stay and send both messages. 💜"
  );
}

module.exports = { data, execute };
