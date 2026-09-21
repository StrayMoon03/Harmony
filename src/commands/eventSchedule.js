const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const store = require("../stores/eventSchedulerStore");
const {
  localToUtc,
  validTimezone,
  renderEventControls,
} = require("../services/eventSchedulerService");

const data = new SlashCommandBuilder()
  .setName("harmony-schedule")
  .setDescription("Schedule Harmony event announcements")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub
    .setName("create")
    .setDescription("Create an event and its first announcement")
    .addStringOption((o) => o.setName("title").setDescription("Event name").setRequired(true).setMaxLength(120))
    .addStringOption((o) => o.setName("link").setDescription("Event link Harmony will repost").setRequired(true).setMaxLength(500))
    .addChannelOption((o) => o.setName("channel").setDescription("Where Harmony should announce it").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName("date").setDescription("First announcement date: YYYY-MM-DD").setRequired(true).setMaxLength(10))
    .addStringOption((o) => o.setName("time").setDescription("First announcement time: HH:MM (24-hour)").setRequired(true).setMaxLength(5))
    .addStringOption((o) => o.setName("message").setDescription("What Harmony should say").setRequired(true).setMaxLength(1800))
    .addStringOption((o) => o.setName("timezone").setDescription("Defaults to America/New_York").setMaxLength(80)))
  .addSubcommand((sub) => sub.setName("list").setDescription("Show upcoming scheduled events"))
  .addSubcommand((sub) => sub
    .setName("cancel")
    .setDescription("Cancel an event and all remaining announcements")
    .addIntegerOption((o) => o.setName("event").setDescription("Event number shown by Harmony").setRequired(true).setMinValue(1)));

function isAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!isAdmin(interaction)) {
    await interaction.editReply("Only server admins can schedule Harmony announcements.");
    return;
  }
  const action = interaction.options.getSubcommand();
  if (action === "list") {
    const events = store.listEvents(interaction.guildId);
    await interaction.editReply(events.length
      ? events.map((event) => `#${event.id} — **${event.title}** in <#${event.destination_channel_id}> (${event.pending_count} upcoming)`).join("\n")
      : "There are no upcoming scheduled events.");
    return;
  }
  if (action === "cancel") {
    const eventId = interaction.options.getInteger("event", true);
    const removed = store.cancelEvent(interaction.guildId, eventId, interaction.user.id);
    await interaction.editReply(removed ? `Cancelled event #${eventId}.` : "I could not find that active event.");
    return;
  }

  const title = interaction.options.getString("title", true).trim();
  const link = interaction.options.getString("link", true).trim();
  const channel = interaction.options.getChannel("channel", true);
  const date = interaction.options.getString("date", true).trim();
  const time = interaction.options.getString("time", true).trim();
  const message = interaction.options.getString("message", true).trim();
  const timezone = interaction.options.getString("timezone")?.trim() || "America/New_York";
  if (!/^https?:\/\/\S+$/i.test(link)) {
    await interaction.editReply("Please enter one complete event link beginning with `http://` or `https://`.");
    return;
  }
  if (!validTimezone(timezone)) {
    await interaction.editReply("That timezone is not valid. Use `America/New_York` for Eastern Time.");
    return;
  }
  const scheduledFor = localToUtc(date, time, timezone);
  if (!scheduledFor || scheduledFor.getTime() <= Date.now()) {
    await interaction.editReply("That date or time is invalid or has already passed. Use `YYYY-MM-DD` and 24-hour `HH:MM`.");
    return;
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!channel.isTextBased() || !permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
    await interaction.editReply("Harmony cannot view and send messages in that channel.");
    return;
  }
  const eventId = store.createEvent({
    guildId: interaction.guildId,
    sourceChannelId: interaction.channelId,
    destinationChannelId: channel.id,
    title,
    link,
    timezone,
    createdBy: interaction.user.id,
    announcements: [{ scheduledFor: scheduledFor.toISOString(), message }],
  });
  await interaction.editReply(renderEventControls(interaction.guildId, eventId));
}

module.exports = { data, execute };
