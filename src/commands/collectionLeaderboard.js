const { SlashCommandBuilder } = require("discord.js");
const { buildLeaderboardEmbed } = require("../services/collectionService");

const PLATFORMS = [
  ["All platforms", "all"],
  ["Instagram", "instagram"],
  ["Facebook", "facebook"],
  ["TikTok", "tiktok"],
  ["X", "x"],
  ["YouTube", "youtube"],
  ["Threads", "threads"],
];

const data = new SlashCommandBuilder()
  .setName("harmony-leaderboard")
  .setDescription("See who is helping Harmony’s collection grow")
  .addStringOption((option) =>
    option
      .setName("period")
      .setDescription("Time period")
      .setRequired(true)
      .addChoices(
        { name: "This week", value: "week" },
        { name: "This month", value: "month" },
        { name: "All time", value: "all" }
      )
  )
  .addStringOption((option) => {
    option
      .setName("platform")
      .setDescription("Choose one platform or all")
      .setRequired(false);
    for (const [name, value] of PLATFORMS) {
      option.addChoices({ name, value });
    }
    return option;
  });

async function execute(interaction) {
  if (!interaction.guild) return;
  const period = interaction.options.getString("period", true);
  const platform = interaction.options.getString("platform") || "all";
  await interaction.reply({
    embeds: [
      buildLeaderboardEmbed(
        interaction.guild.id,
        period,
        platform
      ),
    ],
    allowedMentions: { parse: [] },
  });
}

module.exports = { data, execute };
