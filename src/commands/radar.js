const { SlashCommandBuilder, ChannelType, MessageFlags, PermissionFlagsBits } = require("discord.js");
const store = require("../stores/radarStore");
const { resolveAdminCapabilities } = require("../services/operationsStatusService");
const { SOURCES, pollRadar } = require("../services/radarService");
const { syncRadarChannel } = require("../services/radarDiscord");

const data = new SlashCommandBuilder().setName("harmony-radar")
  .setDescription("Configure and review SKZ Radar in the Harmony server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub.setName("setup").setDescription("Choose the Radar destination in this Harmony server")
    .addChannelOption((option) => option.setName("channel").setDescription("Radar destination").addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand((sub) => sub.setName("calendar-target").setDescription("Choose the separate server for calendar candidate handoff")
    .addStringOption((option) => option.setName("server-id").setDescription("Calendar server ID where you are an administrator").setRequired(true)))
  .addSubcommand((sub) => sub.setName("status").setDescription("Show Radar sources, health and catch-up limits"))
  .addSubcommand((sub) => sub.setName("check").setDescription("Poll due sources and retry pending Radar deliveries"))
  .addSubcommand((sub) => sub.setName("off").setDescription("Pause Radar in this Harmony server"))
  .addSubcommand((sub) => sub.setName("on").setDescription("Resume Radar with its saved source history"))
  .addSubcommand((sub) => sub.setName("source").setDescription("Enable or pause one official source")
    .addStringOption((option) => option.setName("source").setDescription("Official Radar source").setRequired(true)
      .addChoices(...SOURCES.map((source) => ({ name: source.key, value: source.key }))))
    .addBooleanOption((option) => option.setName("enabled").setDescription("Enable polling").setRequired(true)));
async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const capabilities = await resolveAdminCapabilities({ guild: interaction.guild, member: interaction.member, userId: interaction.user.id });
  if (!interaction.guild || !capabilities.canDiagnose) return interaction.editReply("Only server owners and authorized admins can manage Radar.");
  const guildId = interaction.guild.id;
  const action = interaction.options.getSubcommand();
  const settings = store.getSettings(guildId);
  try {
    if (action === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      const bot = interaction.guild.members.me;
      const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
      if (channel.guildId !== guildId || channel.type !== ChannelType.GuildText || !channel.permissionsFor(bot)?.has(needed)) {
        return interaction.editReply("Choose a text channel Harmony can view, post embeds in and read history from.");
      }
      store.saveSettings(guildId, channel.id);
      store.ensureSources(guildId, SOURCES);
      await interaction.editReply("Radar is configured in <#" + channel.id + ">. Starting the seven-day catch-up where source history permits.");
      await pollRadar(interaction.client, guildId);
      return;
    }
    if (!settings) return interaction.editReply("Choose a Radar destination with /harmony-radar setup in the Harmony server.");
    if (action === "off") {
      store.setEnabled(guildId, false);
      return interaction.editReply("Radar is paused. Discoveries, decisions and source history are saved.");
    }
    if (action === "calendar-target") {
      const targetId = interaction.options.getString("server-id", true).trim();
      if (!/^\d{17,22}$/.test(targetId)) return interaction.editReply("Provide a valid Discord server ID.");
      const target = interaction.client.guilds.cache.get(targetId) || await interaction.client.guilds.fetch(targetId);
      const member = await target.members.fetch(interaction.user.id);
      if (!(await resolveAdminCapabilities({ guild: target, member, userId: interaction.user.id })).canDiagnose) {
        return interaction.editReply("Calendar handoff requires your admin access in the selected server.");
      }
      store.setCalendarTarget(guildId, targetId);
      return interaction.editReply("Calendar candidates will be handed to " + target.name + " only after an explicit owner/admin action.");
    }
    if (action === "source") {
      const provider = interaction.options.getString("source", true);
      const source = store.listSources(guildId).find((item) => item.provider === provider);
      if (!source) return interaction.editReply("That source is unavailable.");
      store.updateSource(source.id, { enabled: interaction.options.getBoolean("enabled", true) ? 1 : 0 });
      return interaction.editReply("Saved polling state for " + provider + ".");
    }
    if (action === "on") store.setEnabled(guildId, true);
    if (action === "check" || action === "on") {
      if (!store.getSettings(guildId).enabled) return interaction.editReply("Radar is paused. Use /harmony-radar on to resume.");
      const results = await pollRadar(interaction.client, guildId);
      return interaction.editReply("Radar check complete. " + results.map((item) => item.source + " " + (item.skipped ? "not due / backing off" : item.ok ? "checked" : "failed")).join(" · ") +
        (store.getSettings(guildId).delivery_error ? "\n" + store.getSettings(guildId).delivery_error : ""));
    }
    await syncRadarChannel(interaction.client, guildId);
    const current = store.getSettings(guildId);
    return interaction.editReply([
      "Radar " + (current.enabled ? "On" : "Off") + " · <#" + current.channel_id + "> · polls every 15 minutes",
      "Calendar server " + (current.calendar_guild_id || "not configured"),
      ...store.listSources(guildId).map((source) => [
        source.provider + " · " + source.authority + " · " + (source.enabled ? source.result : "paused"),
        "Last attempt " + (source.last_attempt_at || "none") + " · last success " + (source.last_success_at || "none"),
        source.error, source.limitation,
      ].filter(Boolean).join("\n")),
      current.delivery_error,
    ].filter(Boolean).join("\n\n").slice(0, 1900));
  } catch {
    return interaction.editReply("Radar could not complete this action. Check the configured channel and your access to the selected server.");
  }
}
module.exports = { data, execute };
