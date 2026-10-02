const {
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
} = require("discord.js");
const store = require("../stores/eventSchedulerStore");
const birthdayStore = require("../stores/birthdayStore");
const LOCATION_TIMEZONES = require("../data/locationTimezones.json");

const CHECK_INTERVAL_MS = 30 * 1000;
const MAX_ANNOUNCEMENTS = 12;
const HEADER = /^harmony\s+event\b/i;
const CALENDAR_CATEGORIES = ["birthday", "content", "concert", "stream", "release", "video_call", "appearance", "community", "shopping", "other"];
const CALENDAR_CATEGORY_ICONS = {
  birthday: "🎂", content: "🎬", concert: "🎤", stream: "📺", release: "💿",
  video_call: "📱", appearance: "✨", community: "🎮", shopping: "🛍️", other: "📌",
};
const CALENDAR_CATEGORY_LABELS = {
  birthday: "Birthday",
  content: "Content / Video",
  concert: "Concert",
  stream: "Stream / Watch",
  release: "Release",
  video_call: "Video Call",
  appearance: "Appearance",
  community: "Community / Game",
  shopping: "Shopping / Pop-Up",
  other: "Other",
};
const SKZOO_MEMBER_OPTIONS = [
  { value: "none", label: "None / OT8", emoji: "" },
  { value: "bang_chan", label: "Bang Chan", emoji: "<:Harmony_Wolfchan:1555008944127221861>" },
  { value: "lee_know", label: "Lee Know", emoji: "<:Harmony_LeeBit:1555012112571433074>" },
  { value: "changbin", label: "Changbin", emoji: "<:Harmony_Dwaekki:1555012505103892590>" },
  { value: "hyunjin", label: "Hyunjin", emoji: "<:Harmony_Jiniret:1555012684510924800>" },
  { value: "han", label: "Han", emoji: "<:Harmony_Qoukka:1555012780732588062>" },
  { value: "felix", label: "Felix", emoji: "<:Harmony_bbokari:1555014305194184834>" },
  { value: "seungmin", label: "Seungmin", emoji: "<:Harmony_puppym:1555013392098525215>" },
  { value: "i_n", label: "I.N", emoji: "<:Harmony_Foxlny:1555014818983977101>" },
];
const SKZOO_MEMBER_EMOJIS = Object.fromEntries(SKZOO_MEMBER_OPTIONS.map((option) => [option.value, option.emoji]).filter(([, emoji]) => emoji));

const MANAGER_TYPES = ["stray_kids", "community"];
const YOUTIFUL_EVENT_TYPES = ["kdrama", "chans_room", "skz_code", "chat_only", "concert_stream", "games", "birthday", "other"];
const YOUTIFUL_EVENT_TYPE_ICONS = {
  kdrama: "<:Harmony_Kdramas:1555094992475791400>",
  chans_room: "<:Harmony_Chansroom:1555096496632766474>",
  skz_code: "<:Harmony_SKZcode:1555095863594844230>",
  chat_only: "<:Harmony_ChatOnly:1555095947862614046>",
  concert_stream: "<:Harmony_Streams:1555095377051394148>",
  games: "<:Harmony_Games:1555095284902666282>",
  birthday: "<:Harmony_Birthdays:1555095112218972170>",
  other: "<:Harmony_Other:1555096018075517030>",
};
const YOUTIFUL_EVENT_TYPE_LABELS = {
  kdrama: "K-Dramas", chans_room: "Chan's Room", skz_code: "SKZ CODE", chat_only: "Chat Only",
  concert_stream: "Concert Stream", games: "Games", birthday: "Birthday", other: "Other / Custom",
};
const YOUTIFUL_TIMEZONE_OPTIONS = [
  { label: "Eastern Time", value: "America/New_York" },
  { label: "Central Time", value: "America/Chicago" },
  { label: "Mountain Time", value: "America/Denver" },
  { label: "Pacific Time", value: "America/Los_Angeles" },
  { label: "Alaska Time", value: "America/Anchorage" },
  { label: "Hawaii Time", value: "Pacific/Honolulu" },
  { label: "Korea Time", value: "Asia/Seoul" },
  { label: "Japan Time", value: "Asia/Tokyo" },
  { label: "No timezone (all-day)", value: "none" },
];

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
  const endTime = String(fields.endTime || "").trim();
  const location = String(fields.location || "").trim();
  const legacyTimezone = String(fields.timezone || "").trim();
  const hasExplicitTimezone = Object.prototype.hasOwnProperty.call(fields, "timezone");
  const timezone = calendarType === "community"
    ? (hasExplicitTimezone
      ? (legacyTimezone && validTimezone(legacyTimezone) ? legacyTimezone : null)
      : ((legacyTimezone && validTimezone(legacyTimezone) ? legacyTimezone : null)
        || (resolveLocationTimezone(location))
        || (fields.fallbackTimezone && validTimezone(fields.fallbackTimezone) ? fields.fallbackTimezone : null)))
    : (resolveLocationTimezone(location)
      || (legacyTimezone && validTimezone(legacyTimezone) ? legacyTimezone : null)
      || (fields.fallbackTimezone && validTimezone(fields.fallbackTimezone) ? fields.fallbackTimezone : null));
  const parsedDescription = splitDescriptionAndLink(fields.description || "");
  const legacyLinkField = Object.prototype.hasOwnProperty.call(fields, "link");
  const link = legacyLinkField ? String(fields.link || "").trim() : parsedDescription.link;
  const description = legacyLinkField ? String(fields.description || "").trim() || null : parsedDescription.description;
  if (!title || title.length > 120) throw new Error("Event name is required and must be 120 characters or fewer.");
  if (!parseManagerDate(eventDate) || !isValidDateOnly(eventDate)) throw new Error("Use a valid event date in YYYY-MM-DD format.");
  if (eventTime && !timezone) {
    throw new Error(calendarType === "community"
      ? "Choose a valid time zone for a timed Youtiful Stays event."
      : "I couldn't resolve that location. Please enter a more specific city and country, such as `Fukuoka, Japan`." );
  }
  if (eventTime && !localToUtc(eventDate, eventTime, timezone)) throw new Error("Use a valid event time in HH:MM format.");
  if (endTime && !eventTime) throw new Error("End Time requires a Start Time.");
  let eventEndAt = null;
  if (eventTime && endTime) {
    if (!/^\d{1,2}:\d{2}$/.test(endTime)) throw new Error("Use a valid end time in HH:MM format.");
    const [hour, minute] = endTime.split(":").map(Number);
    if (hour > 23 || minute > 59) throw new Error("Use a valid end time in HH:MM format.");
    const startParts = eventTime.split(":").map(Number);
    const endDate = hour * 60 + minute <= startParts[0] * 60 + startParts[1]
      ? addCalendarDay(eventDate)
      : eventDate;
    const end = localToUtc(endDate, endTime, timezone);
    if (!end) throw new Error("Use a valid end time in HH:MM format.");
    eventEndAt = end.toISOString();
  }
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw new Error("The link must begin with http:// or https://.");
  return {
    title, eventDate, eventTime, location, timezone, link, description,
    calendarType,
    allDay: !eventTime,
    eventAt: eventTime ? localToUtc(eventDate, eventTime, timezone).toISOString() : null,
    eventEndAt,
    eventTimezone: timezone,
    eventLocation: location,
  };
}

function addCalendarDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return value;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function nativeEventEndTime(event) {
  if (event?.event_end_at || event?.eventEndAt) return new Date(event.event_end_at || event.eventEndAt);
  return new Date(new Date(event.event_at || event.eventAt).getTime() + 60 * 60 * 1000);
}

function resolveLocationTimezone(location) {
  const normalized = normalizeLocation(location);
  return normalized ? LOCATION_TIMEZONES[normalized] || null : null;
}

function normalizeLocation(location) {
  return String(location || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isValidDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function splitDescriptionAndLink(value) {
  const text = String(value || "").trim();
  const matches = [...text.matchAll(/https?:\/\/\S+/gi)];
  if (!matches.length) return { description: text || null, link: "" };
  const match = matches[matches.length - 1];
  const link = match[0].replace(/[),.;!?]+$/, "");
  const description = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
  return { description: description || null, link };
}

function managerEventSelect(calendarType, action, events) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`harmony-manager:${calendarType}:${action}`)
    .setPlaceholder("Choose an upcoming event")
    .addOptions(events.slice(0, 25).map((event) => ({
      label: `${CALENDAR_CATEGORY_ICONS[event.category] || CALENDAR_CATEGORY_ICONS.other} ${event.title}`.slice(0, 100),
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

function eventLocalTime(event = {}) {
  if (event.all_day || !event.event_at) return "";
  const timezone = event.event_timezone || event.timezone || "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(event.event_at))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

function managerFields(event = {}) {
  return [
    { id: "title", label: "Event name", required: true, maxLength: 120, value: event.title },
    { id: "event-date", label: "Event date (YYYY-MM-DD)", required: true, maxLength: 10, value: event.event_date },
    { id: "event-time", label: "Event time HH:MM, blank = all-day", maxLength: 5, value: eventLocalTime(event) },
    { id: "location", label: "Location (city, country)", maxLength: 100, value: event.event_location || "" },
    { id: "description", label: "Description + Link (optional)", maxLength: 4000, paragraph: true, value: [event.description, event.link].filter(Boolean).join("\n") },
  ];
}

function editManagerFields(event = {}) {
  return [
    { id: "title", label: "Event name", required: true, maxLength: 120, value: event.title },
    { id: "event-date", label: "Event date (YYYY-MM-DD)", required: true, maxLength: 10, value: event.event_date },
    { id: "event-time", label: "Event time HH:MM, blank = all-day", maxLength: 5, value: eventLocalTime(event) },
    { id: "location", label: "Location (city, country)", maxLength: 100, value: event.event_location || "" },
    { id: "description", label: "Description + Link (optional)", maxLength: 4000, paragraph: true, value: [event.description, event.link].filter(Boolean).join("\n") },
  ];
}

function youtifulEditFields(event = {}) {
  return [
    { id: "title", label: "Event name", required: true, maxLength: 120, value: event.title },
    { id: "event-date", label: "Event date (YYYY-MM-DD)", required: true, maxLength: 10, value: event.event_date },
    { id: "event-time", label: "Event time HH:MM, blank = all-day", maxLength: 5, value: eventLocalTime(event) },
    { id: "description", label: "Description + Link (optional)", maxLength: 4000, paragraph: true, value: [event.description, event.link].filter(Boolean).join("\n") },
  ];
}

function eventEndLocalTime(event = {}) {
  if (event.all_day || !event.event_end_at) return "";
  const timezone = event.event_timezone || event.timezone || "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(event.event_end_at))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

function categoryMenu(calendarType, action, eventId = "new", selected = "other") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`harmony-manager:${calendarType}:${action}:${eventId}`)
    .setPlaceholder("Choose an event category")
    .addOptions(CALENDAR_CATEGORIES.map((value) => ({
      label: `${CALENDAR_CATEGORY_ICONS[value]} ${CALENDAR_CATEGORY_LABELS[value]}`, value, default: value === selected,
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function memberMenu(calendarType, action, eventId = "new", selected = null) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`harmony-manager:${calendarType}:${action}:${eventId}`)
    .setPlaceholder("Choose a Stray Kids member (optional)")
    .addOptions(SKZOO_MEMBER_OPTIONS.map((option) => ({
      label: option.label, value: option.value, default: (selected || "none") === option.value,
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function youtifulTypeMenu() {
  const menu = new StringSelectMenuBuilder().setCustomId("harmony-manager:community:ystype").setPlaceholder("Choose an event type").addOptions(
    YOUTIFUL_EVENT_TYPES.map((value) => {
      const match = /^<:([^:>]+):(\d+)>$/.exec(YOUTIFUL_EVENT_TYPE_ICONS[value]);
      return { label: YOUTIFUL_EVENT_TYPE_LABELS[value], value, emoji: match ? { name: match[1], id: match[2] } : undefined };
    })
  );
  return [new ActionRowBuilder().addComponents(menu)];
}

function youtifulTitleMenu(titles) {
  const menu = new StringSelectMenuBuilder().setCustomId("harmony-manager:community:ystitle").setPlaceholder("Choose a saved title or custom event").addOptions([
    ...titles.slice(0, 24).map((row) => ({ label: row.title, value: `title:${row.title}` })),
    { label: "Other / Custom", value: "other" },
  ]);
  return [new ActionRowBuilder().addComponents(menu)];
}

function youtifulChannelMenu() {
  const menu = new ChannelSelectMenuBuilder().setCustomId("harmony-manager:community:yschannel").setPlaceholder("Choose the Discord channel").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  return [new ActionRowBuilder().addComponents(menu)];
}

function youtifulTimezoneMenu(action, eventId = "new", selected = null) {
  const suffix = eventId === "new" ? "" : ":" + eventId;
  const menu = new StringSelectMenuBuilder()
    .setCustomId("harmony-manager:community:" + action + suffix)
    .setPlaceholder("Choose the event time zone")
    .addOptions(YOUTIFUL_TIMEZONE_OPTIONS.map((option) => ({ label: option.label, value: option.value, default: selected === option.value })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function nativeEventMenu() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-manager:community:ysnative:yes").setLabel("Create Discord Scheduled Event").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("harmony-manager:community:ysnative:no").setLabel("Harmony calendar only").setStyle(ButtonStyle.Secondary)
  )];
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
  store.ensureDefaultCalendarEventTitles(guild.id, "community");
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
  const text = String(value || "");
  if (/^\d{4}-\d{2}$/.test(text)) return text;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) return `${date[1]}-${date[2]}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 7);
}

const CALENDAR_COLORS = { stray_kids: 0xE53935, community: 0x5865F2 };
const EMBED_DESCRIPTION_LIMIT = 3900;

function calendarMonthLabel(monthKey) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" })
    .format(new Date(`${monthKey}-01T00:00:00Z`)).toUpperCase();
}

function allDayDateHeading(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

function eventCalendarBlock(event, calendarType) {
  const date = event.event_date || (event.event_at || "").slice(0, 10);
  const timestamp = !event.all_day && event.event_at ? Math.floor(new Date(event.event_at).getTime() / 1000) : null;
  const allDay = !timestamp;
  const dateLine = timestamp ? `<t:${timestamp}:D>` : allDayDateHeading(date);
  const timePrefix = timestamp ? `<t:${timestamp}:t> • ` : "";
  const icon = CALENDAR_CATEGORY_ICONS[event.category] || CALENDAR_CATEGORY_ICONS.other;
  const memberEmoji = calendarType === "stray_kids" ? (SKZOO_MEMBER_EMOJIS[event.member] || "") : "";
  const eventPrefix = memberEmoji ? `${memberEmoji} ` : "";
  const lines = [dateLine, `${timePrefix}${eventPrefix}${icon} **${event.title}**${allDay ? " • All Day" : ""}`];
  if (event.description) lines.push(event.description);
  if (event.event_location) lines.push(`📍 ${event.event_location}`);
  if (event.link) lines.push(`[Open event link](${event.link})`);
  return lines.join("\n");
}

function youtifulBirthdayEvents(guildId, monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return birthdayStore.listBirthdayProfiles(guildId)
    .filter((profile) => Number(String(profile.birthday_mmdd || "").slice(0, 2)) === month)
    .map((profile) => ({
      id: `birthday-${profile.id}`,
      title: `Happy Birthday, ${profile.birthday_name || "Youtiful STAY"}!`,
      description: profile.user_id ? `<@${profile.user_id}>` : null,
      event_date: `${year}-${profile.birthday_mmdd}`,
      event_at: null,
      event_timezone: null,
      event_location: null,
      link: null,
      category: "birthday",
      calendar_event_type: "birthday",
      all_day: 1,
      birthday_profile: true,
    }));
}

function youtifulEventBlock(event) {
  const icon = YOUTIFUL_EVENT_TYPE_ICONS[event.calendar_event_type] || YOUTIFUL_EVENT_TYPE_ICONS.other;
  const date = event.event_date || (event.event_at || "").slice(0, 10);
  const timestamp = !event.all_day && event.event_at ? Math.floor(new Date(event.event_at).getTime() / 1000) : null;
  const datePart = timestamp ? `<t:${timestamp}:D>` : allDayDateHeading(date);
  const timePart = timestamp ? ` • <t:${timestamp}:t>` : " • All Day";
  const channelPart = event.event_channel_id ? ` • <#${event.event_channel_id}>` : "";
  const lines = [`${icon} ${datePart}${timePart} • **${event.title}**${channelPart}`];
  if (event.description) lines.push(event.description);
  if (event.discord_event_id) lines.push(`[View Discord Event](https://discord.com/events/${event.guild_id}/${event.discord_event_id})`);
  return lines.join("\n");
}

function splitCalendarDescription(blocks, header) {
  const parts = [];
  let current = header;
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= EMBED_DESCRIPTION_LIMIT) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= EMBED_DESCRIPTION_LIMIT) {
      current = block;
      continue;
    }
    // Keep every character, including long descriptions, without exceeding
    // Discord's embed description limit. A long single event may span cards.
    for (let offset = 0; offset < block.length; offset += EMBED_DESCRIPTION_LIMIT) {
      const chunk = block.slice(offset, offset + EMBED_DESCRIPTION_LIMIT);
      if (offset + EMBED_DESCRIPTION_LIMIT < block.length) parts.push(chunk);
      else current = chunk;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function buildCalendarMessages(calendarType, monthKey, events, now = Date.now()) {
  const title = calendarType === "stray_kids" ? "STRAY KIDS" : "YOUTIFUL STAYS";
  const header = "Monthly Schedule";
  const blocks = events.length ? events.map((event) => eventCalendarBlock(event, calendarType)) : ["No events scheduled."];
  const descriptions = splitCalendarDescription(blocks, header);
  const footer = `Times display in your local timezone • Last updated <t:${Math.floor(now / 1000)}:R>`;
  return descriptions.map((description) => ({
    embeds: [new EmbedBuilder()
      .setColor(CALENDAR_COLORS[calendarType] || CALENDAR_COLORS.community)
      .setTitle(`📅 ${title} • ${calendarMonthLabel(monthKey)}`)
      .setDescription(description)
      .setFooter({ text: footer })
      .toJSON()],
    allowedMentions: { parse: [] },
  }));
}

function buildYoutifulCalendarMessages(monthKey, events, now = Date.now()) {
  const header = "Monthly Schedule";
  const blocks = events.length ? events.map(youtifulEventBlock) : ["No events scheduled."];
  const descriptions = splitCalendarDescription(blocks, header);
  const footer = `Times display in your local timezone • Last updated <t:${Math.floor(now / 1000)}:R>`;
  return descriptions.map((description) => ({
    embeds: [new EmbedBuilder().setColor(CALENDAR_COLORS.community)
      .setTitle(`📅 YOUTIFUL STAYS • ${calendarMonthLabel(monthKey)}`)
      .setDescription(description).setFooter({ text: footer }).toJSON()],
    allowedMentions: { parse: [] },
  }));
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
  let events = store.listCalendarEvents(guildId, calendarType, start, `${next}-01T00:00:00.000Z`);
  if (calendarType === "community") {
    events = [...events, ...youtifulBirthdayEvents(guildId, monthKey)].sort((a, b) => String(a.event_date || a.event_at).localeCompare(String(b.event_date || b.event_at)));
  }
  const parts = calendarType === "community"
    ? buildYoutifulCalendarMessages(monthKey, events)
    : buildCalendarMessages(calendarType, monthKey, events);
  if (preview) {
    if (interaction) {
      await interaction.editReply(parts[0]);
      for (const part of parts.slice(1)) {
        await interaction.followUp({ ...part, flags: 64 });
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
    if (message) await message.edit(parts[i]);
    else message = await channel.send(parts[i]);
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
  if (!monthKey) return false;
  if (!store.hasPublishedCalendar(guildId, calendarType, monthKey)) return false;
  await publishMonthlyCalendar(client, guildId, calendarType, monthKey);
  return true;
}

async function refreshEditedMonths(client, guildId, calendarType, oldDate, newDate) {
  const months = [...new Set([oldDate, newDate].map(monthKeyFromDate).filter(Boolean))];
  for (const month of months) await refreshPublishedCalendar(client, guildId, calendarType, month);
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

async function createNativeScheduledEvent(guild, draft, channelId) {
  if (!guild?.scheduledEvents?.create) throw new Error("Discord Scheduled Events are unavailable in this server.");
  const me = guild.members.me;
  if (me && !me.permissions.has(PermissionFlagsBits.ManageEvents)) throw new Error("Harmony needs Manage Events permission to create a Discord Scheduled Event.");
  if (!draft.eventAt) throw new Error("All-day events stay Harmony-only and do not create a native scheduled event.");
  const start = new Date(draft.eventAt);
  const end = nativeEventEndTime(draft);
  const channel = channelId ? (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null)) : null;
  return guild.scheduledEvents.create({
    name: draft.title,
    scheduledStartTime: start,
    scheduledEndTime: end,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType: GuildScheduledEventEntityType.External,
    // Discord channel-bound events only support voice/stage channels. The
    // manager intentionally selects text/announcement channels, so External
    // is the correct entity type and uses a human-readable location.
    entityMetadata: { location: channel ? `#${channel.name}` : "Harmony calendar" },
    description: draft.description || undefined,
  });
}

async function syncNativeScheduledEvent(client, event) {
  if (!event?.discord_event_id || !event.event_at) return false;
  const guild = client.guilds.cache.get(event.guild_id) || await client.guilds.fetch(event.guild_id).catch(() => null);
  const native = guild?.scheduledEvents?.cache?.get(event.discord_event_id) || await guild?.scheduledEvents?.fetch(event.discord_event_id).catch(() => null);
  if (!native) return false;
  await native.edit({
    name: event.title,
    scheduledStartTime: new Date(event.event_at),
    scheduledEndTime: nativeEventEndTime(event),
    description: event.description || undefined,
  });
  return true;
}

function scheduledEventLink(event) {
  return event?.guildId && event?.id ? `https://discord.com/events/${event.guildId}/${event.id}` : null;
}

function interestedStateSupport() {
  return { supported: true, reason: "discord.js exposes guildScheduledEventUserAdd/guildScheduledEventUserRemove and GuildScheduledEvent.fetchSubscribers(). Harmony requests the GuildScheduledEvents intent; a complete Interested list still requires Manage Events or event visibility." };
}

async function offerEventReminder(client, event, user) {
  if (!event?.guildId || !store.getEventByDiscordId(event.guildId, event.id)) return;
  try {
    const dm = await user.createDM();
    await dm.send({ content: `Would you like a Harmony reminder for **${event.name}**?`, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-reminder:${event.id}:86400`).setLabel("1 day before").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`harmony-reminder:${event.id}:3600`).setLabel("1 hour before").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`harmony-reminder:${event.id}:0`).setLabel("No thanks").setStyle(ButtonStyle.Secondary)
    )] });
  } catch { /* DMs are optional and must fail quietly. */ }
}

async function handleReminderInteraction(interaction) {
  const [, discordEventId, rawOffset] = interaction.customId.split(":");
  const offset = Number(rawOffset);
  if (![0, 3600, 86400].includes(offset)) return false;
  if (offset === 0) store.cancelDiscordEventReminder(discordEventId, interaction.user.id);
  else {
    const event = Array.from(interaction.client.guilds.cache.values())
      .map((guild) => guild.scheduledEvents.cache.get(discordEventId))
      .find(Boolean);
    if (!event?.scheduledStartAt) { await interaction.update({ content: "That Discord event is no longer available.", components: [] }); return true; }
    const remindAt = new Date(event.scheduledStartAt.getTime() - offset * 1000);
    if (remindAt <= new Date()) { await interaction.update({ content: "That reminder time has already passed.", components: [] }); return true; }
    store.saveDiscordEventReminder(event.guildId, discordEventId, interaction.user.id, offset, remindAt.toISOString());
  }
  await interaction.update({ content: offset === 0 ? "No Harmony reminder will be sent." : `Saved your Harmony reminder for ${offset === 86400 ? "1 day" : "1 hour"} before the event.`, components: [] });
  return true;
}

async function processDiscordEventReminders(client) {
  for (const reminder of store.dueDiscordEventReminders(new Date().toISOString())) {
    try {
      const user = await client.users.fetch(reminder.user_id);
      await user.send(`⏰ Harmony reminder: your Discord event starts soon. <https://discord.com/events/${reminder.guild_id}/${reminder.discord_event_id}>`);
      store.markDiscordEventReminderSent(reminder.discord_event_id, reminder.user_id);
    } catch { store.markDiscordEventReminderSent(reminder.discord_event_id, reminder.user_id); }
  }
}

async function fetchInterestedMembers(scheduledEvent) {
  if (!scheduledEvent?.fetchSubscribers) throw new Error("Discord Scheduled Event subscriber APIs are unavailable.");
  const subscribers = await scheduledEvent.fetchSubscribers({ withMember: true });
  return subscribers.map((entry) => entry.user || entry.member?.user || entry);
}

async function managerControlChannel(client, guildId) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const id = store.getManagerChannel(guildId);
  return id && guild ? (guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null)) : null;
}

async function handleGuildScheduledEventCreate(client, event) {
  if (!event?.guildId) return;
  const candidates = store.listUnlinkedCommunityEvents(event.guildId).filter((item) => item.title === event.name);
  const channel = await managerControlChannel(client, event.guildId);
  if (!channel?.isTextBased()) return;
  const match = candidates.length === 1 ? candidates[0] : null;
  const payload = { content: match
    ? `A native Discord Scheduled Event **${event.name}** appeared. Link it to the matching Harmony calendar event #${match.id}, or keep it separate?`
    : candidates.length > 1 ? `A native Discord Scheduled Event **${event.name}** appeared. Choose the Harmony event to link, or add it as a new calendar event.`
      : `A native Discord Scheduled Event **${event.name}** appeared. Choose whether to link it to an existing event or add it to the calendar.`, allowedMentions: { parse: [] } };
  if (match) payload.components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-manager:community:linknative:${match.id}:${event.id}`).setLabel("Link to Harmony event").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("harmony-manager:community:keepnative").setLabel("Keep separate").setStyle(ButtonStyle.Secondary)
  )];
  else if (candidates.length) payload.components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`harmony-manager:community:nativelinkselect:${event.id}`).setPlaceholder("Link to Existing").addOptions(candidates.slice(0, 25).map((item) => ({ label: item.title.slice(0, 100), value: String(item.id) }))))];
  else payload.components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-manager:community:nativeadd:${event.id}`).setLabel("Add to Calendar").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("harmony-manager:community:keepnative").setLabel("Keep Separate").setStyle(ButtonStyle.Secondary)
  )];
  await channel.send(payload);
}

async function handleGuildScheduledEventUpdate(client, oldEvent, event) {
  if (!event?.guildId) return;
  const linked = store.getEventByDiscordId(event.guildId, event.id);
  if (!linked) return;
  if (!event.scheduledStartAt) return;
  if (oldEvent && oldEvent.name === event.name && oldEvent.scheduledStartAt?.getTime() === event.scheduledStartAt.getTime() && oldEvent.scheduledEndAt?.getTime() === event.scheduledEndAt?.getTime()) return;
  const timezone = linked.event_timezone || linked.timezone;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(event.scheduledStartAt);
  const localDate = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  store.updateEvent(event.guildId, linked.id, { title: event.name, event_at: event.scheduledStartAt.toISOString(), event_end_at: event.scheduledEndAt?.toISOString() || null, event_date: `${localDate.year}-${localDate.month}-${localDate.day}` });
  await refreshPublishedCalendar(client, event.guildId, linked.calendar_type, `${localDate.year}-${localDate.month}-${localDate.day}`).catch(() => {});
}

async function handleGuildScheduledEventDelete(client, event) {
  if (!event?.guildId) return;
  const linked = store.getEventByDiscordId(event.guildId, event.id);
  if (!linked) return;
  store.updateEvent(event.guildId, linked.id, { discord_event_id: null });
  const channel = await managerControlChannel(client, event.guildId);
  if (channel?.isTextBased()) await channel.send({ content: `The linked Discord event for **${linked.title}** was deleted. The Harmony calendar entry remains intact.`, allowedMentions: { parse: [] } });
}

async function addNativeEventToCalendar(interaction, discordEventId) {
  const event = await interaction.guild.scheduledEvents.fetch(discordEventId);
  if (!event?.scheduledStartAt) throw new Error("The Discord event is no longer available.");
  if (store.getEventByDiscordId(interaction.guildId, discordEventId)) return store.getEventByDiscordId(interaction.guildId, discordEventId);
  const eventAt = event.scheduledStartAt.toISOString();
  const eventDate = eventAt.slice(0, 10);
  const id = store.createCalendarEvent({ guildId: interaction.guildId, calendarChannelId: null, title: event.name, eventAt, eventEndAt: event.scheduledEndAt?.toISOString() || null, eventDate, eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "other", calendarEventType: "other", eventChannelId: null, discordEventId, allDay: false, description: event.description || null, createdBy: interaction.user.id });
  return store.getEvent(interaction.guildId, id);
}

async function handleEventSchedulerInteraction(interaction) {
  const customId = interaction.customId || "";
  if (customId.startsWith("harmony-reminder:")) return handleReminderInteraction(interaction);
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

  if (calendarType === "community" && action === "nativelinkselect" && interaction.isStringSelectMenu()) {
    const linked = store.getEvent(interaction.guildId, Number(interaction.values[0]));
    if (!linked) { await interaction.update({ content: "That Harmony event is no longer active.", components: [] }); return; }
    const nativeId = eventId;
    if (store.getEventByDiscordId(interaction.guildId, nativeId)) { await interaction.update({ content: "That native event is already linked.", components: [] }); return; }
    store.updateEvent(interaction.guildId, linked.id, { discord_event_id: nativeId });
    await interaction.update({ content: `Linked the native event to **${linked.title}**.`, components: [] });
    return;
  }
  if (calendarType === "community" && action === "nativeadd" && interaction.isButton()) {
    try {
      const added = await addNativeEventToCalendar(interaction, eventId);
      await interaction.update({ content: `Added **${added.title}** to the Youtiful Stays calendar.`, components: [] });
      await refreshPublishedCalendar(interaction.client, interaction.guildId, "community", added.event_date).catch(() => {});
    } catch (error) { await interaction.update({ content: error.message, components: [] }); }
    return;
  }
  if (calendarType === "community" && action === "linknative" && interaction.isButton()) {
    const linked = store.getEvent(interaction.guildId, Number(eventId));
    if (!linked) { await interaction.update({ content: "That Harmony event is no longer active.", components: [] }); return; }
    if (store.getEventByDiscordId(interaction.guildId, parts[4])) { await interaction.update({ content: "That native event is already linked.", components: [] }); return; }
    store.updateEvent(interaction.guildId, linked.id, { discord_event_id: parts[4] });
    await interaction.update({ content: `Linked the native Discord event to **${linked.title}**.`, components: [] });
    return;
  }
  if (calendarType === "community" && action === "keepnative" && interaction.isButton()) {
    await interaction.update({ content: "Kept the native Discord event separate from Harmony.", components: [] });
    return;
  }

  if (calendarType === "community" && action === "add" && interaction.isButton()) {
    store.ensureDefaultCalendarEventTitles(interaction.guildId, "community");
    await interaction.reply({ content: "Choose a Youtiful Stays event type.", components: youtifulTypeMenu(), flags: 64 });
    return;
  }
  if (calendarType === "community" && action === "ystype" && interaction.isStringSelectMenu()) {
    const type = interaction.values[0];
    if (!YOUTIFUL_EVENT_TYPES.includes(type)) { await interaction.update({ content: "That event type is no longer available.", components: [] }); return; }
    managerDrafts.set(draftKey(interaction, calendarType), { calendarEventType: type });
    await interaction.update({ content: "Choose a saved title, or choose Other / Custom.", components: youtifulTitleMenu(store.ensureDefaultCalendarEventTitles(interaction.guildId, "community")) });
    return;
  }
  if (calendarType === "community" && action === "ystitle" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.update({ content: "That event draft expired. Please start again.", components: [] }); return; }
    const selected = interaction.values[0];
    managerDrafts.set(draftKey(interaction, calendarType), { ...draft, title: selected === "other" ? "" : selected.slice(6) });
    const fields = [
      ...(selected === "other" ? [{ id: "title", label: "Custom event title", required: true, maxLength: 120 }] : []),
      { id: "event-date", label: "Event date (YYYY-MM-DD)", required: true, maxLength: 10 },
      { id: "event-time", label: "Event time HH:MM, blank = all-day", maxLength: 5 },
      { id: "description", label: "Description (optional)", maxLength: 1000, paragraph: true },
    ];
    await interaction.showModal(managerModal("harmony-manager:community:ysdetails", "Add Youtiful Stays event", fields));
    return;
  }
  if (calendarType === "community" && action === "ysdetails" && interaction.isModalSubmit()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.reply({ content: "That event draft expired. Please start again.", flags: 64 }); return; }
    const title = draft.title || interaction.fields.getTextInputValue("title");
    managerDrafts.set(draftKey(interaction, calendarType), {
      ...draft,
      title,
      eventDate: interaction.fields.getTextInputValue("event-date"),
      eventTime: interaction.fields.getTextInputValue("event-time"),
      description: interaction.fields.getTextInputValue("description"),
    });
    await interaction.reply({ content: "Choose the event time zone. For an all-day event, choose No timezone.", components: youtifulTimezoneMenu("ystimezone"), flags: 64 });
    return;
  }
  if (calendarType === "community" && action === "ystimezone" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.update({ content: "That event draft expired. Please start again.", components: [] }); return; }
    try {
      const timezone = interaction.values[0] === "none" ? "" : interaction.values[0];
      const parsed = parseManagerDraft({ title: draft.title, eventDate: draft.eventDate, eventTime: draft.eventTime, timezone, description: draft.description }, calendarType);
      managerDrafts.set(draftKey(interaction, calendarType), { ...draft, ...parsed, title: draft.title });
      await interaction.update({ content: "Choose the Discord channel associated with this event.", components: youtifulChannelMenu() });
    } catch (error) {
      await interaction.update({ content: error.message, components: youtifulTimezoneMenu("ystimezone", "new", interaction.values[0]) });
    }
    return;
  }
  if (calendarType === "community" && action === "yschannel" && interaction.isChannelSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.update({ content: "That event draft expired. Please start again.", components: [] }); return; }
    managerDrafts.set(draftKey(interaction, calendarType), { ...draft, eventChannelId: interaction.values[0] });
    await interaction.update({ content: "Create a native Discord Scheduled Event too?", components: nativeEventMenu() });
    return;
  }
  if (calendarType === "community" && action === "ysnative" && interaction.isButton()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.update({ content: "That event draft expired. Please start again.", components: [] }); return; }
    try {
      const eventId = store.createCalendarEvent({ guildId: interaction.guildId, calendarChannelId, title: draft.title, link: draft.link, timezone: draft.timezone, eventAt: draft.eventAt, eventEndAt: draft.eventEndAt, eventDate: draft.eventDate, eventTimezone: draft.eventTimezone, calendarType, category: draft.calendarEventType, allDay: draft.allDay, description: draft.description, createdBy: interaction.user.id, calendarEventType: draft.calendarEventType, eventChannelId: draft.eventChannelId });
      let nativeId = null;
      let nativeWarning = "";
      if (eventId && interaction.customId.endsWith(":yes") && !draft.allDay) {
        try {
          const created = await createNativeScheduledEvent(interaction.guild, draft, draft.eventChannelId);
          nativeId = created?.id || null;
          if (nativeId) store.updateEvent(interaction.guildId, eventId, { discord_event_id: nativeId });
        } catch (error) { nativeWarning = ` Native event not created: ${error.message}`; }
      } else if (interaction.customId.endsWith(":yes")) nativeWarning = " All-day events remain Harmony-only.";
      managerDrafts.delete(draftKey(interaction, calendarType));
      await interaction.update({ content: `✅ Event saved: **${draft.title}**${nativeId ? " (Discord event linked)" : ""}${nativeWarning}`, components: [] });
      await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, draft.eventDate).catch((error) => console.error("Youtiful calendar refresh failed:", error));
    } catch (error) { await interaction.update({ content: `Event saved failed: ${error.message}`, components: [] }); }
    return;
  }

  if (action === "add" && interaction.isButton()) {
    await interaction.reply({ content: "Choose a category for this event first.", components: categoryMenu(calendarType, "addcategory"), flags: 64 });
    return;
  }
  if (action === "addcategory" && interaction.isStringSelectMenu()) {
    managerDrafts.set(draftKey(interaction, calendarType), { category: interaction.values[0] });
    if (calendarType === "stray_kids") {
      await interaction.update({ content: "Choose an optional Stray Kids member.", components: memberMenu(calendarType, "addmember") });
    } else {
      await interaction.showModal(managerModal(`harmony-manager:${calendarType}:addmodal`, "Add calendar event", managerFields()));
    }
    return;
  }
  if (action === "addmember" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.update({ content: "That event draft expired. Please start again.", components: [] }); return; }
    managerDrafts.set(draftKey(interaction, calendarType), { ...draft, member: interaction.values[0] === "none" ? null : interaction.values[0] });
    await interaction.showModal(managerModal(`harmony-manager:${calendarType}:addmodal`, "Add calendar event", managerFields()));
    return;
  }
  if (action === "addmodal" && interaction.isModalSubmit()) {
    try {
      const categoryDraft = managerDrafts.get(draftKey(interaction, calendarType));
      if (!categoryDraft?.category) {
        await interaction.reply({ content: "That event draft expired. Please start again.", flags: 64 });
        return;
      }
      const draft = parseManagerDraft({
        title: interaction.fields.getTextInputValue("title"),
        eventDate: interaction.fields.getTextInputValue("event-date"),
        eventTime: interaction.fields.getTextInputValue("event-time"),
        location: interaction.fields.getTextInputValue("location"),
        description: interaction.fields.getTextInputValue("description"),
      }, calendarType);
      const id = store.createCalendarEvent({
        guildId: interaction.guildId, calendarChannelId, title: draft.title, link: draft.link,
        timezone: draft.timezone, eventAt: draft.eventAt, eventDate: draft.eventDate,
        eventTimezone: draft.eventTimezone, eventLocation: draft.eventLocation, calendarType, category: categoryDraft.category, member: categoryDraft.member || null,
        allDay: draft.allDay, description: draft.description, createdBy: interaction.user.id,
      });
      managerDrafts.delete(draftKey(interaction, calendarType));
      const savedResponse = { content: `✅ Event saved: **${draft.title}**`, components: [], flags: 64 };
      // A calendar edit can require a Discord API round trip. Acknowledge the
      // modal first so that refresh latency cannot expire the interaction.
      await interaction.reply(savedResponse);
      try {
        const refreshed = await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, draft.eventDate);
        if (!refreshed) {
          await interaction.editReply({ ...savedResponse, content: "Event saved! This month has not been published yet, so the public calendar was not changed." });
        }
      } catch (refreshError) {
        console.error("Published calendar refresh after Add Event failed:", refreshError);
        await interaction.editReply({ ...savedResponse, content: "Event saved, but the published calendar could not be refreshed. Please use View / Preview to retry." });
      }
    } catch (error) {
      await interaction.reply({ content: error.message, flags: 64 });
    }
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
    await interaction.showModal(managerModal(`harmony-manager:${calendarType}:editmodal:${event.id}`, "Edit calendar event", calendarType === "community" ? youtifulEditFields(event) : editManagerFields(event)));
    return;
  }
  if (action === "editmodal" && interaction.isModalSubmit()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing || existing.calendar_type !== calendarType) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (calendarType !== "community") {
      try {
        const draft = parseManagerDraft({ title: interaction.fields.getTextInputValue("title"), eventDate: interaction.fields.getTextInputValue("event-date"), eventTime: interaction.fields.getTextInputValue("event-time"), location: interaction.fields.getTextInputValue("location"), description: interaction.fields.getTextInputValue("description"), fallbackTimezone: existing.event_timezone || existing.timezone }, calendarType);
        managerDrafts.set(draftKey(interaction, calendarType, eventId), draft);
        await interaction.reply({ content: "Choose a category for this event.", components: categoryMenu(calendarType, "editcategory", eventId, existing.category || "other"), flags: 64 });
      } catch (error) { await interaction.reply({ content: error.message, flags: 64 }); }
      return;
    }
    managerDrafts.set(draftKey(interaction, calendarType, eventId), {
      eventId,
      existing,
      title: interaction.fields.getTextInputValue("title"),
      eventDate: interaction.fields.getTextInputValue("event-date"),
      eventTime: interaction.fields.getTextInputValue("event-time"),
      description: interaction.fields.getTextInputValue("description"),
    });
    const legacyTimezone = existing.event_timezone || existing.timezone || resolveLocationTimezone(existing.event_location);
    await interaction.reply({ content: "Choose the event time zone. For an all-day event, choose No timezone.", components: youtifulTimezoneMenu("edittimezone", eventId, legacyTimezone || (existing.all_day ? "none" : null)), flags: 64 });
    return;
  }
  if (calendarType === "community" && action === "edittimezone" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!draft || !existing) { await interaction.update({ content: "That event edit expired.", components: [] }); return; }
    try {
      const timezone = interaction.values[0] === "none" ? "" : interaction.values[0];
      const parsed = parseManagerDraft({ title: draft.title, eventDate: draft.eventDate, eventTime: draft.eventTime, timezone, description: draft.description, fallbackTimezone: existing.event_timezone || existing.timezone || resolveLocationTimezone(existing.event_location) }, calendarType);
      managerDrafts.set(draftKey(interaction, calendarType, eventId), { ...draft, ...parsed, existing, eventId });
      const saved = store.updateEvent(interaction.guildId, Number(eventId), { title: parsed.title, event_date: parsed.eventDate, event_at: parsed.eventAt, event_timezone: parsed.eventTimezone, timezone: parsed.timezone, link: parsed.link, description: parsed.description, all_day: parsed.allDay ? 1 : 0, member: existing.member || null, event_end_at: parsed.eventEndAt });
      await interaction.update({ content: "Choose a category for this event.", components: categoryMenu(calendarType, "editcategory", eventId, existing.category || "other") });
      if (saved.discord_event_id && !saved.all_day) await syncNativeScheduledEvent(interaction.client, saved).catch((error) => console.error("Linked Discord event sync failed:", error));
      await refreshEditedMonths(interaction.client, interaction.guildId, calendarType, existing.event_date, saved.event_date).catch((refreshError) => console.error("Published calendar refresh after Edit Event failed:", refreshError));
    } catch (error) {
      await interaction.update({ content: error.message, components: youtifulTimezoneMenu("edittimezone", eventId, interaction.values[0]) });
    }
    return;
  }
  if (action === "editcategory" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!draft || !existing) { await interaction.update({ content: "That event edit expired.", components: [] }); return; }
    const updated = store.updateEvent(interaction.guildId, Number(eventId), { category: interaction.values[0] });
    if (calendarType === "stray_kids") {
      managerDrafts.set(draftKey(interaction, calendarType, eventId), { ...draft, existing, member: updated.member || null });
      await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, updated.event_date).catch((refreshError) => console.error("Published calendar refresh after category edit failed:", refreshError));
      await interaction.update({ content: "Choose an optional Stray Kids member.", components: memberMenu(calendarType, "editmember", eventId, updated.member) });
    } else {
      managerDrafts.delete(draftKey(interaction, calendarType, eventId));
      await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, updated.event_date).catch((refreshError) => console.error("Published calendar refresh after category edit failed:", refreshError));
      await interaction.update({ content: `✅ Updated calendar event **${draft.title}**.`, components: [] });
    }
    return;
  }
  if (action === "editmember" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!draft || !existing) { await interaction.update({ content: "That event edit expired.", components: [] }); return; }
    const updated = store.updateEvent(interaction.guildId, Number(eventId), { member: interaction.values[0] === "none" ? null : interaction.values[0] });
    managerDrafts.delete(draftKey(interaction, calendarType, eventId));
    await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, updated.event_date).catch((refreshError) => console.error("Published calendar refresh after member edit failed:", refreshError));
    await interaction.update({ content: `✅ Updated calendar event **${draft.title}**.`, components: [] });
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
    if (removed && event?.discord_event_id) {
      const native = interaction.guild?.scheduledEvents?.cache?.get(event.discord_event_id) || await interaction.guild?.scheduledEvents?.fetch(event.discord_event_id).catch(() => null);
      if (native) await native.edit({ status: GuildScheduledEventStatus.Canceled }).catch((error) => console.error("Linked Discord event cancellation failed:", error));
    }
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
    await interaction.deferReply({ flags: 64 });
    try {
      const preview = await publishMonthlyCalendar(interaction.client, interaction.guildId, calendarType, month, { preview: true, interaction });
      await interaction.followUp({ content: `Preview shown for ${month}. Publish or refresh the official calendar?`, components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:publish:${month}`).setLabel("Publish / Refresh").setStyle(ButtonStyle.Primary)
      )], flags: 64 });
      return preview;
    } catch (error) { await interaction.editReply({ content: error.message, components: [] }); }
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
  const utcMillis = (year, monthIndex, day, hour, minute) => {
    // Date.UTC maps years 0-99 to 1900-1999. Build the value with
    // setUTCFullYear so a four-digit input year is never rewritten.
    const date = new Date(0);
    date.setUTCFullYear(year, monthIndex, day);
    date.setUTCHours(hour, minute, 0, 0);
    return date.getTime();
  };
  let value = utcMillis(target.year, target.month - 1, target.day, target.hour, target.minute);
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
    const shown = utcMillis(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const wanted = utcMillis(target.year, target.month - 1, target.day, target.hour, target.minute);
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
  processDiscordEventReminders(client).catch((error) => console.error("Discord event reminder startup failed:", error));
  const timer = setInterval(
    () => {
      processScheduledAnnouncements(client).catch((error) => console.error("Event scheduler failed:", error));
      processDiscordEventReminders(client).catch((error) => console.error("Discord event reminders failed:", error));
    },
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
  CALENDAR_CATEGORY_LABELS,
  SKZOO_MEMBER_OPTIONS,
  SKZOO_MEMBER_EMOJIS,
  buildCalendarMessages,
  publishMonthlyCalendar,
  refreshPublishedCalendar,
  installScheduleManagers,
  managerPanelContent,
  managerPanelComponents,
  managerModal,
  parseManagerDraft,
  nativeEventEndTime,
  syncNativeScheduledEvent,
  managerCalendarType,
  MANAGER_TYPES,
  YOUTIFUL_EVENT_TYPES,
  YOUTIFUL_EVENT_TYPE_ICONS,
  YOUTIFUL_EVENT_TYPE_LABELS,
  YOUTIFUL_TIMEZONE_OPTIONS,
  buildYoutifulCalendarMessages,
  youtifulBirthdayEvents,
  interestedStateSupport,
  fetchInterestedMembers,
  scheduledEventLink,
  handleGuildScheduledEventCreate,
  handleGuildScheduledEventUpdate,
  handleGuildScheduledEventDelete,
  offerEventReminder,
  handleReminderInteraction,
  processDiscordEventReminders,
  addNativeEventToCalendar,
};
