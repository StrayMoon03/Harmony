const {
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const store = require("../stores/eventSchedulerStore");

const CHECK_INTERVAL_MS = 30 * 1000;
const MAX_ANNOUNCEMENTS = 12;
const HEADER = /^harmony\s+event\b/i;
const CALENDAR_CATEGORIES = ["birthday", "content", "concert", "stream", "release", "video_call", "appearance", "community", "other"];
const CALENDAR_CATEGORY_ICONS = {
  birthday: "🎂", content: "🎬", concert: "🎤", stream: "📺", release: "💿",
  video_call: "📱", appearance: "✨", community: "🎮", other: "📌",
};

const MANAGER_TYPES = ["stray_kids", "community"];

function calendarLabel(calendarType) {
  return calendarType === "stray_kids" ? "STRAY KIDS" : "YOUTIFUL STAYS";
}

function managerPanelContent(calendarType) {
  const label = calendarLabel(calendarType);
  const icon = calendarType === "stray_kids" ? "⭐" : "❤️";
  return `${icon} **${label} SCHEDULE MANAGER**\nUse the private controls below to manage this calendar. Calendar events do not require an announcement.`;
}

function managerPanelComponents(calendarType) {
  const prefix = `harmony-manager:${calendarType}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:add`).setLabel("➕ Add Event").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}:view`).setLabel("👀 View / Preview").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}:edit`).setLabel("✏️ Edit Event").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}:cancel`).setLabel("❌ Cancel Event").setStyle(ButtonStyle.Danger)
  );
  return [row];
}

function managerCalendarType(value) {
  return MANAGER_TYPES.includes(value) ? value : null;
}

function parseManagerDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function parseManagerDraft(fields, calendarType) {
  const title = fields.title.trim();
  const eventDate = fields.eventDate.trim();
  const eventTime = fields.eventTime.trim();
  const timezone = fields.timezone.trim() || "America/New_York";
  const link = fields.link.trim();
  const description = fields.description.trim() || null;
  if (!title || title.length > 120) throw new Error("Event name is required and must be 120 characters or fewer.");
  if (!validTimezone(timezone)) throw new Error("That timezone is not valid.");
  if (!parseManagerDate(eventDate) || !localToUtc(eventDate, "12:00", timezone)) throw new Error("Use a valid event date in YYYY-MM-DD format.");
  if (eventTime && !localToUtc(eventDate, eventTime, timezone)) throw new Error("Use a valid event time in HH:MM format.");
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw new Error("The link must begin with http:// or https://.");
  return {
    title, eventDate, eventTime, timezone, link, description,
    calendarType,
    allDay: !eventTime,
    eventAt: eventTime ? localToUtc(eventDate, eventTime, timezone).toISOString() : null,
    eventTimezone: timezone,
  };
}

function managerEventSelect(calendarType, action, events) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`harmony-manager:${calendarType}:${action}`)
    .setPlaceholder("Choose an upcoming event")
    .addOptions(events.slice(0, 25).map((event) => ({
      label: `#${event.id} ${event.title}`.slice(0, 100),
      value: String(event.id),
      description: `${event.event_date || "date pending"}${event.all_day ? " · all day" : ""}`.slice(0, 100),
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function managerModal(customId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  modal.addComponents(...fields.map((field) => {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(Boolean(field.required))
      .setMaxLength(field.maxLength || 100);
    if (field.value) input.setValue(String(field.value));
    return new ActionRowBuilder().addComponents(input);
  }));
  return modal;
}

function managerFields(event = {}) {
  return [
    { id: "title", label: "Event name", required: true, maxLength: 120, value: event.title },
    { id: "event-date", label: "Event date (YYYY-MM-DD)", required: true, maxLength: 10, value: event.event_date },
    { id: "event-time", label: "Event time HH:MM, blank = all-day", maxLength: 5, value: event.all_day ? "" : (event.event_at || "").slice(11, 16) },
    { id: "timezone", label: "Event timezone", maxLength: 80, value: event.event_timezone || event.timezone || "America/New_York" },
    { id: "link", label: "Link (optional)", maxLength: 500, value: event.link },
  ];
}

function editManagerFields(event = {}) {
  return [
    { id: "title", label: "Event name", required: true, maxLength: 120, value: event.title },
    { id: "event-date", label: "Event date (YYYY-MM-DD)", required: true, maxLength: 10, value: event.event_date },
    { id: "event-time", label: "Event time HH:MM, blank = all-day", maxLength: 5, value: event.all_day ? "" : (event.event_at || "").slice(11, 16) },
    { id: "timezone", label: "Event timezone", maxLength: 80, value: event.event_timezone || event.timezone || "America/New_York" },
    { id: "link", label: "Link (optional)", maxLength: 500, value: event.link },
  ];
}

function categoryMenu(calendarType, action, eventId = "new", selected = "other") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`harmony-manager:${calendarType}:${action}:${eventId}`)
    .setPlaceholder("Choose an event category")
    .addOptions(CALENDAR_CATEGORIES.map((value) => ({
      label: value.replace(/_/g, " "), value, default: value === selected,
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

const managerDrafts = new Map();

function draftKey(interaction, calendarType, eventId = "new") {
  return `${interaction.guildId}:${interaction.user.id}:${calendarType}:${eventId}`;
}

function upcomingCalendarEvents(guildId, calendarType) {
  const now = new Date();
  const start = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const end = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000).toISOString();
  return store.listCalendarEvents(guildId, calendarType, start, end);
}

async function installScheduleManagers(guild) {
  const settings = store.getCalendarChannels(guild.id);
  const managerChannelId = settings?.manager_channel_id || store.getManagerChannel(guild.id);
  if (!managerChannelId) throw new Error("Designate an admin control channel with `/harmony-schedule setup-manager` first.");
  const managerChannel = guild.channels.cache.get(managerChannelId) || await guild.channels.fetch(managerChannelId).catch(() => null);
  if (!managerChannel?.isTextBased()) throw new Error("The designated Harmony control channel is unavailable.");
  const results = [];
  for (const calendarType of MANAGER_TYPES) {
    const existing = store.getManagerPanel(guild.id, calendarType);
    if (existing?.channel_id && existing.channel_id !== managerChannel.id) {
      const oldChannel = guild.channels.cache.get(existing.channel_id) || await guild.channels.fetch(existing.channel_id).catch(() => null);
      const oldMessage = oldChannel ? await oldChannel.messages.fetch(existing.message_id).catch(() => null) : null;
      if (oldMessage) await oldMessage.delete().catch(() => {});
    }
    let message = existing?.channel_id === managerChannel.id
      ? await managerChannel.messages.fetch(existing.message_id).catch(() => null)
      : null;
    const payload = { content: managerPanelContent(calendarType), components: managerPanelComponents(calendarType), allowedMentions: { parse: [] } };
    if (message) await message.edit(payload);
    else message = await managerChannel.send(payload);
    store.saveManagerPanel(guild.id, calendarType, managerChannel.id, message.id);
    results.push({ calendarType, channelId: managerChannel.id, messageId: message.id });
  }
  return results;
}

function isAdmin(message) {
  return Boolean(
    message.member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    message.member?.permissions?.has(PermissionFlagsBits.Administrator)
  );
}

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function monthKeyFromDate(value) {
  return /^\d{4}-\d{2}$/.test(value) ? value : new Date(value).toISOString().slice(0, 7);
}

function buildCalendarMessages(calendarType, monthKey, events, now = Date.now()) {
  const title = calendarType === "stray_kids" ? "STRAY KIDS" : "YOUTIFUL STAYS";
  const lines = [`📅 ${title} • ${new Date(`${monthKey}-01T00:00:00Z`).toLocaleString("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).toUpperCase()}`, "Monthly Schedule", ""];
  if (!events.length) lines.push("No events scheduled.");
  for (const event of events) {
    const date = event.event_date || (event.event_at || "").slice(0, 10);
    const timed = !event.all_day && event.event_at;
    const label = new Intl.DateTimeFormat("en-US", { timeZone: event.event_timezone || "UTC", month: "short", day: "numeric", weekday: "long" }).format(new Date(`${date}T12:00:00Z`)).toUpperCase();
    lines.push(`${label}`, `${CALENDAR_CATEGORY_ICONS[event.category] || CALENDAR_CATEGORY_ICONS.other} ${event.description ? `${event.description} — ` : ""}**${event.title}**`);
    if (timed) lines.push(`<t:${Math.floor(new Date(event.event_at).getTime() / 1000)}:F>`);
    lines.push(event.link, "");
  }
  lines.push(`Last updated <t:${Math.floor(now / 1000)}:R>`);
  const parts = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 1900 && current) { parts.push(current); current = line; } else current = next;
  }
  if (current) parts.push(current);
  return parts;
}

async function publishMonthlyCalendar(client, guildId, calendarType, monthKey, { preview = false, interaction = null } = {}) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const settings = store.getCalendarChannels(guildId);
  const channelId = calendarType === "stray_kids" ? settings?.stray_kids_channel_id : settings?.community_channel_id;
  const channel = channelId && guild ? (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null)) : null;
  if (!channel?.isTextBased()) throw new Error("Configure that calendar channel first with `/harmony-schedule setup-calendar`.");
  const [year, month] = monthKey.split("-").map(Number);
  const start = `${monthKey}-01T00:00:00.000Z`;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  const events = store.listCalendarEvents(guildId, calendarType, start, `${next}-01T00:00:00.000Z`);
  const parts = buildCalendarMessages(calendarType, monthKey, events);
  if (preview) {
    if (interaction) {
      await interaction.editReply({ content: parts[0], allowedMentions: { parse: [] } });
      for (const part of parts.slice(1)) {
        await interaction.followUp({ content: part, flags: 64, allowedMentions: { parse: [] } });
      }
    }
    return { parts, preview: true };
  }
  const existing = store.listPublishedCalendars(guildId, calendarType, monthKey);
  const sent = [];
  for (let i = 0; i < parts.length; i += 1) {
    const old = existing[i];
    let message = null;
    if (old) message = await channel.messages.fetch(old.message_id).catch(() => null);
    if (message) await message.edit({ content: parts[i], allowedMentions: { parse: [] } });
    else message = await channel.send({ content: parts[i], allowedMentions: { parse: [] } });
    store.savePublishedCalendar(guildId, calendarType, monthKey, i, channel.id, message.id);
    sent.push(message.id);
  }
  for (const old of existing.slice(parts.length)) {
    const message = await channel.messages.fetch(old.message_id).catch(() => null);
    if (message) await message.delete().catch(() => {});
    store.removePublishedCalendarPart(guildId, calendarType, monthKey, old.part_index);
  }
  return { parts, messageIds: sent, preview: false };
}

async function refreshPublishedCalendar(client, guildId, calendarType, eventDate) {
  const monthKey = monthKeyFromDate(eventDate);
  if (!store.hasPublishedCalendar(guildId, calendarType, monthKey)) return false;
  await publishMonthlyCalendar(client, guildId, calendarType, monthKey);
  return true;
}

function renderEventControls(guildId, eventId) {
  const event = store.getEvent(guildId, eventId);
  if (!event) return { content: "That scheduled event is no longer active.", components: [] };
  const announcements = store.listAnnouncements(eventId);
  const lines = announcements.map((item) =>
    `• <t:${Math.floor(new Date(item.scheduled_for).getTime() / 1000)}:F> — ${item.message}`
  );
  return {
    content: [
      `✅ Event #${event.id}: **${event.title}**`,
      `Posting in: <#${event.destination_channel_id}>`,
      `Link: ${event.link}`,
      "",
      ...lines,
      "",
      "Use **Add another announcement** for the same event link, or choose **Finished** when you are done.",
    ].join("\n"),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-schedule:add:${event.id}`).setLabel("Add another announcement").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`harmony-schedule:done:${event.id}`).setLabel("Finished").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`harmony-schedule:cancel:${event.id}`).setLabel("Cancel event").setStyle(ButtonStyle.Danger)
    )],
    allowedMentions: { parse: [] },
  };
}

async function handleEventSchedulerInteraction(interaction) {
  const customId = interaction.customId || "";
  if (customId.startsWith("harmony-manager:")) {
    await handleManagerInteraction(interaction);
    return true;
  }
  if (!customId.startsWith("harmony-schedule:")) return false;
  const admin = Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
  if (!admin) {
    await interaction.reply({ content: "Only server admins can change scheduled events.", flags: 64 });
    return true;
  }
  const [, action, rawEventId] = customId.split(":");
  const eventId = Number(rawEventId);
  const event = store.getEvent(interaction.guildId, eventId);
  if (!event) {
    await interaction.reply({ content: "That scheduled event is no longer active.", flags: 64 });
    return true;
  }
  if (action === "add" && interaction.isButton()) {
    const modal = new ModalBuilder().setCustomId(`harmony-schedule:save:${eventId}`).setTitle("Add an event announcement");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("date").setLabel("Date (YYYY-MM-DD)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("time").setLabel("Time (24-hour HH:MM)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("message").setLabel("Announcement message").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1800))
    );
    await interaction.showModal(modal);
    return true;
  }
  if (action === "save" && interaction.isModalSubmit()) {
    const date = interaction.fields.getTextInputValue("date").trim();
    const time = interaction.fields.getTextInputValue("time").trim();
    const message = interaction.fields.getTextInputValue("message").trim();
    const scheduledFor = localToUtc(date, time, event.timezone);
    if (!scheduledFor || scheduledFor.getTime() <= Date.now()) {
      await interaction.reply({ content: "That date or time is invalid or has already passed. Use `YYYY-MM-DD` and 24-hour `HH:MM`.", flags: 64 });
      return true;
    }
    const result = store.addAnnouncement(interaction.guildId, eventId, scheduledFor.toISOString(), message);
    if (!result.ok) {
      const reason = result.reason === "limit" ? "This event already has the maximum of 12 announcements."
        : result.reason === "duplicate" ? "That exact announcement is already scheduled."
          : "That event is no longer active.";
      await interaction.reply({ content: reason, flags: 64 });
      return true;
    }
    await interaction.reply({ ...renderEventControls(interaction.guildId, eventId), flags: 64 });
    return true;
  }
  if (action === "done" && interaction.isButton()) {
    await interaction.update({
      content: `✅ Event #${eventId} is scheduled with ${event.pending_count} announcement${Number(event.pending_count) === 1 ? "" : "s"}. Use \`/harmony-schedule list\` anytime to review it.`,
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }
  if (action === "cancel" && interaction.isButton()) {
    store.cancelEvent(interaction.guildId, eventId, interaction.user.id);
    await interaction.update({ content: `Cancelled event #${eventId}.`, components: [] });
    return true;
  }
  return false;
}

async function handleManagerInteraction(interaction) {
  const admin = Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
  if (!admin) {
    await interaction.reply({ content: "Only server admins can use the Schedule Manager.", flags: 64 });
    return;
  }
  const parts = interaction.customId.split(":");
  const calendarType = managerCalendarType(parts[1]);
  const action = parts[2];
  const eventId = parts[3];
  if (!calendarType) {
    await interaction.reply({ content: "That calendar manager is no longer available.", flags: 64 });
    return;
  }
  const settings = store.getCalendarChannels(interaction.guildId) || {};
  const calendarChannelId = calendarType === "stray_kids" ? settings.stray_kids_channel_id : settings.community_channel_id;

  if (action === "add" && interaction.isButton()) {
    await interaction.showModal(managerModal(`harmony-manager:${calendarType}:addmodal`, "Add calendar event", managerFields()));
    return;
  }
  if (action === "addmodal" && interaction.isModalSubmit()) {
    try {
      const draft = parseManagerDraft({
        title: interaction.fields.getTextInputValue("title"),
        eventDate: interaction.fields.getTextInputValue("event-date"),
        eventTime: interaction.fields.getTextInputValue("event-time"),
        timezone: interaction.fields.getTextInputValue("timezone"),
        link: interaction.fields.getTextInputValue("link"),
        description: "",
      }, calendarType);
      managerDrafts.set(draftKey(interaction, calendarType), draft);
      await interaction.reply({ content: "Choose a category for this event.", components: categoryMenu(calendarType, "addcategory"), flags: 64 });
    } catch (error) {
      await interaction.reply({ content: error.message, flags: 64 });
    }
    return;
  }
  if (action === "addcategory" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.reply({ content: "That event draft expired. Please start again.", flags: 64 }); return; }
    const id = store.createCalendarEvent({
      guildId: interaction.guildId, calendarChannelId, title: draft.title, link: draft.link,
      timezone: draft.timezone, eventAt: draft.eventAt, eventDate: draft.eventDate,
      eventTimezone: draft.eventTimezone, calendarType, category: interaction.values[0],
      allDay: draft.allDay, description: draft.description, createdBy: interaction.user.id,
    });
    managerDrafts.delete(draftKey(interaction, calendarType));
    await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, draft.eventDate).catch(() => {});
    await interaction.update({ content: `Saved calendar event #${id}. You can also add a short description.`, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:description:${id}`).setLabel("Add description").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:done`).setLabel("Done").setStyle(ButtonStyle.Success)
    )] });
    return;
  }
  if ((action === "edit" || action === "cancel") && interaction.isButton()) {
    const events = upcomingCalendarEvents(interaction.guildId, calendarType);
    if (!events.length) { await interaction.reply({ content: "There are no upcoming events in this calendar.", flags: 64 }); return; }
    await interaction.reply({ content: action === "edit" ? "Choose an event to edit." : "Choose an event to cancel.", components: managerEventSelect(calendarType, action === "edit" ? "editselect" : "cancelselect", events), flags: 64 });
    return;
  }
  if (action === "editselect" && interaction.isStringSelectMenu()) {
    const event = store.getEvent(interaction.guildId, Number(interaction.values[0]));
    if (!event || event.calendar_type !== calendarType) { await interaction.update({ content: "That event is no longer available.", components: [] }); return; }
    managerDrafts.set(draftKey(interaction, calendarType, event.id), { eventId: event.id, existing: event });
    await interaction.showModal(managerModal(`harmony-manager:${calendarType}:editmodal:${event.id}`, "Edit calendar event", editManagerFields(event)));
    return;
  }
  if (action === "editmodal" && interaction.isModalSubmit()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing || existing.calendar_type !== calendarType) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    try {
      const draft = parseManagerDraft({
        title: interaction.fields.getTextInputValue("title"),
        eventDate: interaction.fields.getTextInputValue("event-date"),
        eventTime: interaction.fields.getTextInputValue("event-time"),
        timezone: interaction.fields.getTextInputValue("timezone"),
        link: interaction.fields.getTextInputValue("link"),
        description: existing.description || "",
      }, calendarType);
      managerDrafts.set(draftKey(interaction, calendarType, eventId), draft);
      await interaction.reply({ content: "Choose a category for this event.", components: categoryMenu(calendarType, "editcategory", eventId, existing.category || "other"), flags: 64 });
    } catch (error) { await interaction.reply({ content: error.message, flags: 64 }); }
    return;
  }
  if (action === "editcategory" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!draft || !existing) { await interaction.update({ content: "That event edit expired.", components: [] }); return; }
    const updated = store.updateEvent(interaction.guildId, Number(eventId), {
      title: draft.title, event_date: draft.eventDate, event_at: draft.eventAt,
      event_timezone: draft.eventTimezone, timezone: draft.timezone, link: draft.link,
      category: interaction.values[0], all_day: draft.allDay ? 1 : 0,
    });
    managerDrafts.delete(draftKey(interaction, calendarType, eventId));
    await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, existing.event_date).catch(() => {});
    await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, updated.event_date).catch(() => {});
    await interaction.update({ content: `Updated calendar event #${eventId}. You can also change its short description.`, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:description:${eventId}`).setLabel("Edit description").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:done`).setLabel("Done").setStyle(ButtonStyle.Success)
    )] });
    return;
  }
  if (action === "description" && interaction.isButton()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing || existing.calendar_type !== calendarType) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    await interaction.showModal(managerModal(`harmony-manager:${calendarType}:descriptionmodal:${eventId}`, "Edit description", [{ id: "description", label: "Short description", maxLength: 300, paragraph: true, value: existing.description }]));
    return;
  }
  if (action === "descriptionmodal" && interaction.isModalSubmit()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing || existing.calendar_type !== calendarType) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    store.updateEvent(interaction.guildId, Number(eventId), { description: interaction.fields.getTextInputValue("description").trim() || null });
    await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, existing.event_date).catch(() => {});
    await interaction.reply({ content: `Updated the description for calendar event #${eventId}.`, flags: 64 });
    return;
  }
  if (action === "done" && interaction.isButton()) {
    await interaction.update({ content: "Calendar event changes saved.", components: [] });
    return;
  }
  if (action === "cancelselect" && interaction.isStringSelectMenu()) {
    const selected = Number(interaction.values[0]);
    const event = store.getEvent(interaction.guildId, selected);
    if (!event || event.calendar_type !== calendarType) { await interaction.update({ content: "That event is no longer available.", components: [] }); return; }
    await interaction.update({ content: `Cancel **${event.title}**?`, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:cancelconfirm:${selected}`).setLabel("Confirm cancellation").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:cancelno`).setLabel("Keep event").setStyle(ButtonStyle.Secondary)
    )] });
    return;
  }
  if (action === "cancelconfirm" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    const removed = store.cancelEvent(interaction.guildId, Number(eventId), interaction.user.id);
    if (removed && event) await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, event.event_date).catch(() => {});
    await interaction.update({ content: removed ? `Cancelled calendar event #${eventId}.` : "That event is no longer active.", components: [] });
    return;
  }
  if (action === "cancelno" && interaction.isButton()) {
    await interaction.update({ content: "Cancellation cancelled.", components: [] });
    return;
  }
  if (action === "view" && interaction.isButton()) {
    await interaction.showModal(managerModal(`harmony-manager:${calendarType}:viewmodal`, "View calendar", [{ id: "month", label: "Month YYYY-MM (blank = current)", maxLength: 7 }]));
    return;
  }
  if (action === "viewmodal" && interaction.isModalSubmit()) {
    const month = interaction.fields.getTextInputValue("month").trim() || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { await interaction.reply({ content: "Month must be formatted as YYYY-MM.", flags: 64 }); return; }
    try {
      const preview = await publishMonthlyCalendar(interaction.client, interaction.guildId, calendarType, month, { preview: true, interaction });
      await interaction.followUp({ content: `Preview shown for ${month}. Publish or refresh the official calendar?`, components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:publish:${month}`).setLabel("Publish / Refresh").setStyle(ButtonStyle.Primary)
      )], flags: 64 });
      return preview;
    } catch (error) { await interaction.reply({ content: error.message, flags: 64 }); }
    return;
  }
  if (action === "publish" && interaction.isButton()) {
    const month = eventId;
    try {
      const result = await publishMonthlyCalendar(interaction.client, interaction.guildId, calendarType, month);
      await interaction.update({ content: `Published ${calendarLabel(calendarType)} for ${month} (${result.messageIds.length} message${result.messageIds.length === 1 ? "" : "s"}).`, components: [] });
    } catch (error) { await interaction.update({ content: error.message, components: [] }); }
  }
}

function localToUtc(dateText, timeText, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(timeText);
  if (!match || !clock) return null;
  const target = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(clock[1]), minute: Number(clock[2]),
  };
  if (target.hour > 23 || target.minute > 59) return null;
  let value = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(value))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    );
    if (parts.hour === 24) parts.hour = 0;
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const wanted = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
    value += wanted - shown;
  }
  const result = new Date(value);
  const verified = Object.fromEntries(
    formatter.formatToParts(result)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  if (verified.hour === 24) verified.hour = 0;
  if (
    verified.year !== target.year || verified.month !== target.month ||
    verified.day !== target.day || verified.hour !== target.hour ||
    verified.minute !== target.minute
  ) return null;
  return result;
}

function field(lines, name) {
  const line = lines.find((item) => item.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line ? line.slice(line.indexOf(":") + 1).trim() : "";
}

function parseEvent(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = field(lines, "title");
  const link = field(lines, "link");
  const destination = field(lines, "post in");
  const timezone = field(lines, "timezone") || "America/New_York";
  const channelMatch = /<#(\d+)>/.exec(destination);
  const marker = lines.findIndex((line) => /^announcements\s*:/i.test(line));
  if (!title || title.length > 120) throw new Error("Add a Title (120 characters or fewer).");
  if (!/^https?:\/\/\S+$/i.test(link)) throw new Error("Add one complete http or https Link.");
  if (!channelMatch) throw new Error("Use a Discord channel mention after Post in.");
  if (!validTimezone(timezone)) throw new Error("That Timezone is not valid.");
  if (marker < 0) throw new Error("Add an Announcements: section.");

  const announcements = [];
  for (const line of lines.slice(marker + 1)) {
    const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*\|\s*(.+)$/.exec(line);
    if (!match) throw new Error("Each announcement must be: YYYY-MM-DD HH:MM | your message");
    const when = localToUtc(match[1], match[2], timezone);
    if (!when || Number.isNaN(when.getTime())) throw new Error("One announcement has an invalid date or time.");
    if (when.getTime() <= Date.now()) throw new Error("Every announcement time must be in the future.");
    if (match[3].length > 1800) throw new Error("Each message must be 1,800 characters or fewer.");
    announcements.push({ scheduledFor: when.toISOString(), message: match[3] });
  }
  if (!announcements.length || announcements.length > MAX_ANNOUNCEMENTS) {
    throw new Error(`Add between 1 and ${MAX_ANNOUNCEMENTS} announcements.`);
  }
  return { title, link, destinationChannelId: channelMatch[1], timezone, announcements };
}

async function handleEventSchedulerMessage(message) {
  if (!message.guild || message.author.bot || !HEADER.test(message.content || "")) return false;
  if (!isAdmin(message)) {
    await message.reply({ content: "Only server admins can schedule Harmony announcements.", allowedMentions: { repliedUser: false } });
    return true;
  }

  const cancel = /^harmony\s+event\s+cancel\s+(\d+)\s*$/i.exec(message.content.trim());
  if (cancel) {
    const removed = store.cancelEvent(message.guild.id, Number(cancel[1]), message.author.id);
    await message.reply({ content: removed ? `Cancelled event #${cancel[1]}.` : "I could not find that active event.", allowedMentions: { repliedUser: false } });
    return true;
  }

  if (/^harmony\s+event\s+list\s*$/i.test(message.content.trim())) {
    const events = store.listEvents(message.guild.id);
    const content = events.length
      ? events.map((event) => `#${event.id} — **${event.title}** (${event.pending_count} upcoming)`).join("\n")
      : "There are no upcoming scheduled events.";
    await message.reply({ content, allowedMentions: { parse: [] } });
    return true;
  }

  try {
    const parsed = parseEvent(message.content);
    const destination = message.guild.channels.cache.get(parsed.destinationChannelId) ||
      await message.guild.channels.fetch(parsed.destinationChannelId).catch(() => null);
    if (!destination?.isTextBased()) throw new Error("The Post in channel is unavailable.");
    const me = message.guild.members.me;
    const permissions = destination.permissionsFor(me);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
      throw new Error("Harmony cannot view and send messages in that Post in channel.");
    }

    const eventId = store.createEvent({
      guildId: message.guild.id,
      sourceChannelId: message.channel.id,
      destinationChannelId: parsed.destinationChannelId,
      title: parsed.title,
      link: parsed.link,
      timezone: parsed.timezone,
      createdBy: message.author.id,
      announcements: parsed.announcements,
    });
    const lines = parsed.announcements.map((item) =>
      `• <t:${Math.floor(new Date(item.scheduledFor).getTime() / 1000)}:F> — ${item.message}`
    );
    await message.reply({
      content: [
        `✅ Event #${eventId} saved: **${parsed.title}**`,
        `Destination: <#${parsed.destinationChannelId}>`,
        `Link: ${parsed.link}`,
        "",
        ...lines,
        "",
        `Cancel with: ` + "`Harmony event cancel " + eventId + "`",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
    await message.react("✅").catch(() => {});
  } catch (error) {
    await message.reply({
      content: [
        `I could not save that event: **${error.message}**`,
        "",
        "Use:",
        "`Harmony event`",
        "`Title: Rock in Rio Replay`",
        "`Link: https://example.com/event`",
        "`Post in: #your-channel`",
        "`Timezone: America/New_York`",
        "`Announcements:`",
        "`2026-10-01 20:00 | Rock in Rio is one week away!`",
        "`2026-10-08 20:00 | Rock in Rio is starting now!`",
      ].join("\n"),
      allowedMentions: { repliedUser: false },
    });
  }
  return true;
}

async function processScheduledAnnouncements(client) {
  const due = store.dueAnnouncements(new Date().toISOString());
  for (const item of due) {
    if (!store.markSending(item.id)) continue;
    try {
      const guild = client.guilds.cache.get(item.guild_id) ||
        await client.guilds.fetch(item.guild_id).catch(() => null);
      const channel = guild && (guild.channels.cache.get(item.destination_channel_id) ||
        await guild.channels.fetch(item.destination_channel_id).catch(() => null));
      if (!channel?.isTextBased()) throw new Error("Destination channel is unavailable.");
      const sent = await channel.send({
        content: `${item.message}\n\n${item.link}`,
        allowedMentions: { parse: ["everyone", "roles", "users"] },
      });
      store.markSent(item.id, sent.id);
    } catch (error) {
      store.markFailed(item.id, error.message);
      console.error(`Scheduled event announcement ${item.id} failed:`, error);
    }
  }
}

function startEventScheduler(client) {
  processScheduledAnnouncements(client).catch((error) => console.error("Event scheduler startup failed:", error));
  const timer = setInterval(
    () => processScheduledAnnouncements(client).catch((error) => console.error("Event scheduler failed:", error)),
    CHECK_INTERVAL_MS
  );
  timer.unref?.();
}

module.exports = {
  parseEvent,
  localToUtc,
  validTimezone,
  renderEventControls,
  handleEventSchedulerMessage,
  handleEventSchedulerInteraction,
  processScheduledAnnouncements,
  startEventScheduler,
  CALENDAR_CATEGORIES,
  buildCalendarMessages,
  publishMonthlyCalendar,
  refreshPublishedCalendar,
  installScheduleManagers,
  managerPanelContent,
  managerPanelComponents,
  managerModal,
  parseManagerDraft,
  managerCalendarType,
  MANAGER_TYPES,
};
