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
  publishMonthlyCalendar,
  refreshPublishedCalendar,
  CALENDAR_CATEGORIES,
} = require("../services/eventSchedulerService");

const data = new SlashCommandBuilder()
  .setName("harmony-schedule")
  .setDescription("Schedule Harmony event announcements")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub
    .setName("create")
    .setDescription("Create an event and its first announcement")
    .addStringOption((o) => o.setName("title").setDescription("Event name").setRequired(true).setMaxLength(120))
    .addStringOption((o) => o.setName("calendar").setDescription("Calendar classification").setRequired(true)
      .addChoices({ name: "Stray Kids", value: "stray_kids" }, { name: "Youtiful Stays", value: "community" }))
    .addStringOption((o) => o.setName("event-date").setDescription("Actual event date: YYYY-MM-DD").setRequired(true).setMaxLength(10))
    .addStringOption((o) => o.setName("event-time").setDescription("Actual event time: HH:MM (omit for all-day)").setMaxLength(5))
    .addStringOption((o) => o.setName("event-timezone").setDescription("Timezone for the actual event").setMaxLength(80))
    .addStringOption((o) => o.setName("description").setDescription("Short calendar details").setMaxLength(300))
    .addStringOption((o) => o.setName("category").setDescription("Calendar category").addChoices(...CALENDAR_CATEGORIES.map((value) => ({ name: value.replace(/_/g, " "), value }))))
    .addBooleanOption((o) => o.setName("all-day").setDescription("Show a date without a time"))
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
    .addIntegerOption((o) => o.setName("event").setDescription("Event number shown by Harmony").setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub
    .setName("update")
    .setDescription("Update calendar details for an event")
    .addIntegerOption((o) => o.setName("event").setDescription("Event number shown by Harmony").setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName("title").setDescription("Event name").setMaxLength(120))
    .addStringOption((o) => o.setName("calendar").setDescription("Calendar classification").addChoices({ name: "Stray Kids", value: "stray_kids" }, { name: "Youtiful Stays", value: "community" }))
    .addStringOption((o) => o.setName("event-date").setDescription("Actual event date: YYYY-MM").setMaxLength(10))
    .addStringOption((o) => o.setName("event-time").setDescription("Actual event time: HH:MM; omit for all-day").setMaxLength(5))
    .addStringOption((o) => o.setName("event-timezone").setDescription("Timezone for the actual event").setMaxLength(80))
    .addStringOption((o) => o.setName("category").setDescription("Calendar category").addChoices(...CALENDAR_CATEGORIES.map((value) => ({ name: value.replace(/_/g, " "), value }))))
    .addStringOption((o) => o.setName("description").setDescription("Short calendar details").setMaxLength(300))
    .addBooleanOption((o) => o.setName("all-day").setDescription("Show a date without a time")));

data.addSubcommand((sub) => sub
  .setName("setup-calendar")
  .setDescription("Configure the two monthly calendar channels")
  .addChannelOption((o) => o.setName("stray-kids-channel").setDescription("Stray Kids calendar channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
  .addChannelOption((o) => o.setName("community-channel").setDescription("Youtiful Stays calendar channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)));

data.addSubcommand((sub) => sub
  .setName("calendar")
  .setDescription("Post a monthly calendar")
  .addStringOption((o) => o.setName("calendar").setDescription("Calendar to post").setRequired(true)
    .addChoices({ name: "Stray Kids", value: "stray_kids" }, { name: "Youtiful Stays", value: "community" }))
  .addStringOption((o) => o.setName("month").setDescription("Month as YYYY-MM (defaults to this month)").setMaxLength(7))
  .addBooleanOption((o) => o.setName("preview").setDescription("Preview privately without publishing")));

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
    const existing = store.getEvent(interaction.guildId, eventId);
    const removed = store.cancelEvent(interaction.guildId, eventId, interaction.user.id);
    if (removed && existing?.event_date) await refreshPublishedCalendar(interaction.client, interaction.guildId, existing.calendar_type, existing.event_date).catch(() => {});
    await interaction.editReply(removed ? `Cancelled event #${eventId}.` : "I could not find that active event.");
    return;
  }
  if (action === "update") {
    const eventId = interaction.options.getInteger("event", true);
    const existing = store.getEvent(interaction.guildId, eventId);
    if (!existing) { await interaction.editReply("I could not find that active event."); return; }
    const eventDate = interaction.options.getString("event-date") || existing.event_date;
    const eventTimezone = interaction.options.getString("event-timezone") || existing.event_timezone || existing.timezone;
    const allDayOption = interaction.options.getBoolean("all-day");
    const allDay = allDayOption === null ? Boolean(existing.all_day) : allDayOption;
    const eventTime = interaction.options.getString("event-time");
    const eventAt = allDay ? null : (eventTime ? localToUtc(eventDate, eventTime, eventTimezone) : (existing.event_at ? new Date(existing.event_at) : null));
    if (!eventDate || !validTimezone(eventTimezone) || !localToUtc(eventDate, "12:00", eventTimezone) || (!allDay && !eventAt)) {
      await interaction.editReply("Provide a valid event date, time, and timezone."); return;
    }
    const updated = store.updateEvent(interaction.guildId, eventId, {
      title: interaction.options.getString("title") || existing.title,
      calendar_type: interaction.options.getString("calendar") || existing.calendar_type,
      event_date: eventDate,
      event_at: eventAt?.toISOString() || null,
      event_timezone: eventTimezone,
      category: interaction.options.getString("category") || existing.category || "other",
      description: interaction.options.getString("description") ?? existing.description,
      all_day: allDay ? 1 : 0,
    });
    await refreshPublishedCalendar(interaction.client, interaction.guildId, existing.calendar_type, existing.event_date).catch(() => {});
    await refreshPublishedCalendar(interaction.client, interaction.guildId, updated.calendar_type, updated.event_date).catch(() => {});
    await interaction.editReply(`Updated event #${eventId}.`);
    return;
  }

  if (action === "setup-calendar") {
    const strayKids = interaction.options.getChannel("stray-kids-channel");
    const community = interaction.options.getChannel("community-channel");
    if (!strayKids && !community) {
      await interaction.editReply("Choose at least one calendar channel to configure.");
      return;
    }
    const current = store.getCalendarChannels(interaction.guildId) || {};
    const selected = {
      strayKids: strayKids || (current.stray_kids_channel_id ? await interaction.guild.channels.fetch(current.stray_kids_channel_id).catch(() => null) : null),
      community: community || (current.community_channel_id ? await interaction.guild.channels.fetch(current.community_channel_id).catch(() => null) : null),
    };
    for (const channel of [selected.strayKids, selected.community].filter(Boolean)) {
      const permissions = channel.permissionsFor(interaction.guild.members.me);
      if (!channel.isTextBased() || !permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages) || !permissions?.has(PermissionFlagsBits.EmbedLinks)) {
        await interaction.editReply(`Harmony cannot view, send, and embed links in <#${channel.id}>.`);
        return;
      }
    }
    store.setCalendarChannels(interaction.guildId, selected.strayKids?.id, selected.community?.id);
    await interaction.editReply(`Calendar channels saved. Stray Kids: ${selected.strayKids ? `<#${selected.strayKids.id}>` : "not set"}; Youtiful Stays: ${selected.community ? `<#${selected.community.id}>` : "not set"}.`);
    return;
  }

  if (action === "calendar") {
    const calendarType = interaction.options.getString("calendar", true);
    const month = interaction.options.getString("month") || new Date().toISOString().slice(0, 7);
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
      await interaction.editReply("Month must be formatted as `YYYY-MM`.");
      return;
    }
    const preview = interaction.options.getBoolean("preview") || false;
    const settings = store.getCalendarChannels(interaction.guildId);
    const channelId = calendarType === "stray_kids" ? settings?.stray_kids_channel_id : settings?.community_channel_id;
    const channel = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
    if (!channel?.isTextBased()) {
      await interaction.editReply("Configure that calendar channel first with `/harmony-schedule setup-calendar`.");
      return;
    }
    const title = calendarType === "stray_kids" ? "STRAY KIDS" : "YOUTIFUL STAYS";
    if (preview) {
      await publishMonthlyCalendar(interaction.client, interaction.guildId, calendarType, month, { preview: true, interaction });
    } else {
      await publishMonthlyCalendar(interaction.client, interaction.guildId, calendarType, month);
      await interaction.editReply(`Posted the ${title} calendar for ${month} in <#${channel.id}>.`);
    }
    return;
  }

  const title = interaction.options.getString("title", true).trim();
  const link = interaction.options.getString("link", true).trim();
  const channel = interaction.options.getChannel("channel", true);
  const date = interaction.options.getString("date", true).trim();
  const time = interaction.options.getString("time", true).trim();
  const message = interaction.options.getString("message", true).trim();
  const timezone = interaction.options.getString("timezone")?.trim() || "America/New_York";
  const calendarType = interaction.options.getString("calendar") || "community";
  const eventDate = interaction.options.getString("event-date");
  const eventTime = interaction.options.getString("event-time");
  const eventTimezone = interaction.options.getString("event-timezone")?.trim() || timezone;
  const description = interaction.options.getString("description")?.trim() || null;
  const category = interaction.options.getString("category") || "other";
  const allDay = interaction.options.getBoolean("all-day") || !eventTime;
  if (!/^https?:\/\/\S+$/i.test(link)) {
    await interaction.editReply("Please enter one complete event link beginning with `http://` or `https://`.");
    return;
  }
  if (!validTimezone(timezone)) {
    await interaction.editReply("That timezone is not valid. Use `America/New_York` for Eastern Time.");
    return;
  }
  if (!eventDate || (!allDay && !eventTime) || !validTimezone(eventTimezone)) {
    await interaction.editReply("Provide a valid event date and event timezone; event time is optional for all-day events.");
    return;
  }
  const eventAt = allDay ? null : localToUtc(eventDate, eventTime, eventTimezone);
  const validEventDate = localToUtc(eventDate, "12:00", eventTimezone);
  if (!validEventDate || (!allDay && !eventAt)) {
    await interaction.editReply("The event date or time is invalid. Use `YYYY-MM-DD` and 24-hour `HH:MM`.");
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
    calendarType,
    eventAt: eventAt?.toISOString() || null,
    eventDate,
    eventTimezone,
    category,
    allDay,
    description,
    createdBy: interaction.user.id,
    announcements: [{ scheduledFor: scheduledFor.toISOString(), message }],
  });
  await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, eventDate).catch(() => {});
  await interaction.editReply(renderEventControls(interaction.guildId, eventId));
}

module.exports = { data, execute };
