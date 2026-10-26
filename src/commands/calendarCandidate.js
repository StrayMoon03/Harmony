const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { submitCalendarCandidate, discoveredCandidatePickerPayload, nativeReconciliationPickerPayload } = require("../services/eventSchedulerService");
const { runDiscovery } = require("../services/calendarDiscoveryService");

const data = new SlashCommandBuilder()
  .setName("harmony-calendar")
  .setDescription("Submit, discover, and review Stray Kids calendar events")
  .addSubcommand((sub) => sub
    .setName("submit")
    .setDescription("Send Harmony a possible event source for admin review")
    .addStringOption((o) => o.setName("link").setDescription("Complete event source link").setRequired(true).setMaxLength(500))
    .addStringOption((o) => o.setName("note").setDescription("Optional context for the admin reviewer").setMaxLength(500)))
  .addSubcommand((sub) => sub
    .setName("discover")
    .setDescription("Check the official Stray Kids schedule for new candidates"))
  .addSubcommand((sub) => sub
    .setName("review")
    .setDescription("Review open discovered and submitted calendar candidates"))
  .addSubcommand((sub) => sub
    .setName("reconcile")
    .setDescription("Review active Discord Scheduled Events for Harmony linking"));

async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand?.() || "submit";
  if (["discover", "review", "reconcile"].includes(subcommand)) {
    const allowed = Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild) || interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator));
    if (!allowed) {
      await interaction.reply({ content: "Only server admins with Manage Server or Administrator permission can use calendar discovery and review.", flags: 64 });
      return;
    }
    if (subcommand === "review") {
      await interaction.reply(discoveredCandidatePickerPayload(interaction.guildId));
      return;
    }
    if (subcommand === "reconcile") {
      await interaction.reply(await nativeReconciliationPickerPayload(interaction.guild));
      return;
    }
    await interaction.deferReply({ flags: 64 });
    const result = await runDiscovery(interaction.client, { guildIds: [interaction.guildId] });
    if (result.locked) {
      await interaction.editReply("A discovery check is already running. Please try again shortly.");
      return;
    }
    const totals = result.results.reduce((sum, item) => ({
      fetched: sum.fetched + (item.fetched || 0), newCount: sum.newCount + (item.newCount || 0), updated: sum.updated + (item.updated || 0), duplicate: sum.duplicate + (item.duplicate || 0), skipped: sum.skipped + (item.skipped || 0), failed: sum.failed + (item.ok ? 0 : 1),
    }), { fetched: 0, newCount: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 });
    await interaction.editReply(`Official schedule check complete. Fetched ${totals.fetched}; new ${totals.newCount}; updated ${totals.updated}; already known ${totals.duplicate}; skipped ${totals.skipped}${totals.failed ? `; failed ${totals.failed}` : ""}. No calendar events were created automatically.`);
    return;
  }
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
