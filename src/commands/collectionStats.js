const {
  SlashCommandBuilder,
  MessageFlags,
} = require("discord.js");
const { buildMemberStatsEmbed } = require("../services/collectionService");

const data = new SlashCommandBuilder()
  .setName("harmony-stats")
  .setDescription("Celebrate collection contributions")
  .addUserOption((option) =>
    option
      .setName("member")
      .setDescription("Whose collection stats to view")
      .setRequired(false)
  )
  .addStringOption((option) =>
    option
      .setName("period")
      .setDescription("Time period")
      .setRequired(false)
      .addChoices(
        { name: "This week", value: "week" },
        { name: "This month", value: "month" },
        { name: "All time", value: "all" }
      )
  );

async function execute(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Use this command inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const user = interaction.options.getUser("member") || interaction.user;
  const period = interaction.options.getString("period") || "all";
  await interaction.reply({
    embeds: [buildMemberStatsEmbed(interaction.guild.id, user, period)],
    allowedMentions: { parse: [] },
  });
}

module.exports = { data, execute };
