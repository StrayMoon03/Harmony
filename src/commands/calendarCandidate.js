const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { submitCalendarCandidate } = require("../services/eventSchedulerService");

const data = new SlashCommandBuilder()
  .setName("harmony-calendar")
  .setDescription("Submit a possible Stray Kids calendar event")
  .addSubcommand((sub) => sub
    .setName("submit")
    .setDescription("Send Harmony a possible event source for admin review")
    .addStringOption((o) => o.setName("link").setDescription("Complete event source link").setRequired(true).setMaxLength(500))
    .addStringOption((o) => o.setName("note").setDescription("Optional context for the admin reviewer").setMaxLength(500)));

async function execute(interaction) {
  const link = interaction.options.getString("link", true).trim();
  const note = interaction.options.getString("note")?.trim() || null;
  if (!/^https?:\/\/\S+$/i.test(link)) {
    await interaction.reply({ content: "Please provide one complete event link beginning with `http://` or `https://`.", flags: 64 });
    return;
  }
  await interaction.deferReply({ flags: 64 });
  try {
    const admin = Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild) || interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator));
    const result = await submitCalendarCandidate(interaction.client, {
      guildId: interaction.guildId,
      sourceUrl: link,
      sourceType: admin ? "admin_submission" : "member_submission",
      submitterId: interaction.user.id,
      submittedNote: note,
    });
    if (result.duplicate) {
      await interaction.editReply("Harmony already has this source under review or already processed it. No duplicate review item was created.");
      return;
    }
    await interaction.editReply(result.noticeSent
      ? "✅ Thanks! I sent the possible event to the Harmony admin review queue. It will not be added to the calendar unless an admin approves it."
      : "✅ Thanks! I saved the possible event for admin review, but the reconciliation channel is not configured or available yet. It will not be added to the calendar automatically.");
  } catch (error) {
    await interaction.editReply(error.message || "Harmony could not submit that event for review.");
  }
}

module.exports = { data, execute };

