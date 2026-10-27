Warning: truncated output (original token count: 63147)
Total output lines: 4277

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
  Events,
} = require("discord.js");
const store = require("../stores/eventSchedulerStore");
const { enrichCalendarCandidate } = require("./calendarCandidateEnrichment");
const birthdayStore = require("../stores/birthdayStore");
const { handleBirthdayManagerInteraction } = require("./birthdayManagerService");
const LOCATION_TIMEZONES = require("../data/locationTimezones.json");
const { randomUUID } = require("node:crypto");
const { MAX_RECURRENCE_OCCURRENCES, RECURRENCE_TYPES, normalizeRecurrenceRule, generateRecurringOccurrences, generateDiscordRecurringOccurrences } = require("./recurrenceService");
const { YOUTIFUL_TIMEZONE_OPTIONS } = require("../data/youtifulTimezones");

const CHECK_INTERVAL_MS = 30 * 1000;
const NATIVE_DELETE_MARKER_TTL_MS = 5 * 60 * 1000;
const MAX_ANNOUNCEMENTS = 12;
const NATIVE_RECURRENCE_MODE = 2;
const NATIVE_DESCRIPTION_PAGE_SIZE = 4;
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
const SKZ_TIMEZONE_OPTIONS = [
  ...YOUTIFUL_TIMEZONE_OPTIONS.slice(0, -1),
  { label: "China / Beijing Time", value: "Asia/Shanghai" },
  YOUTIFUL_TIMEZONE_OPTIONS.at(-1),
];
// Community calendar presentation defaults to the existing Eastern Time
// option. Individual calendar events continue to use their persisted IANA
// timezone when one is available.
const DEFAULT_YOUTIFUL_TIMEZONE = YOUTIFUL_TIMEZONE_OPTIONS[0].value;

function calendarLabel(calendarType) {
  return calendarType === "stray_kids" ? "STRAY KIDS" : "YOUTIFUL STAYS";
}

function managerPanelContent(calendarType) {
  const label = calendarLabel(calendarType);
  const icon = calendarType === "stray_kids" ? "⭐" : "❤️";
  return `${icon} **${label} SCHEDULE MANAGER**\nUse the admin controls below to manage this calendar. Calendar events do not require an announcement.\nDiscord Scheduled Event reconciliation also requires Harmony to have **View Channel** permission for each associated voice or stage channel.`;
}

function managerPanelComponents(calendarType, guildId = null) {
  const prefix = `harmony-manager:${calendarType}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:add`).setLabel("➕ Add Event").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}:view`).setLabel("👀 View / Preview").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}:edit`).setLabel("✏️ Edit Event").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}:cancel`).setLabel("❌ Cancel Event").setStyle(ButtonStyle.Danger)
  );
  if (calendarType === "community") {
    return [row, new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}:findnative`).setLabel("🔎 Find Discord Event").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${prefix}:birthdays`).setLabel("🎂 Birthdays").setStyle(ButtonStyle.Primary),
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-status:open").setLabel("🩺 Status / Health").setStyle(ButtonStyle.Secondary),
    )];
  }
  if (calendarType === "stray_kids") {
    return [row, new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}:discovery-check`).setLabel("🔍 Check Now").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${prefix}:discovery-toggle`).setLabel(store.isCalendarDiscoveryEnabled(guildId) ? "⏸️ Turn Discovery Off" : "⏱️ Turn Discovery On").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${prefix}:candidate-inbox`).setLabel("📋 Review Discovered Events").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${prefix}:discovery-status`).setLabel("📊 Discovery Status").setStyle(ButtonStyle.Secondary),
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-status:open").setLabel("🩺 Status / Health").setStyle(ButtonStyle.Secondary),
    )];
  }
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
  const timezone = hasExplicitTimezone
    ? (legacyTimezone && validTimezone(legacyTimezone) ? legacyTimezone : null)
    : calendarType === "community"
      ? ((legacyTimezone && validTimezone(legacyTimezone) ? legacyTimezone : null)
        || (resolveLocationTimezone(location))
        || (fields.fallbackTimezone && validTimezone(fields.fallbackTimezone) ? fields.fallbackTimezone : null))
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
  const fields = [
    { id: "title", label: "Event name", required: true, maxLength: 120, value: event.title },
    { id: "event-date", label: "Event date (YYYY-MM-DD)", required: true, maxLength: 10, value: event.event_date },
    { id: "event-time", label: "Event time HH:MM, blank = all-day", maxLength: 5, value: eventLocalTime(event) },
    { id: "description", label: "Description + Link (optional)", maxLength: 4000, paragraph: true, value: [event.description, event.link].filter(Boolean).join("\n") },
  ];
  if (Number(event.recurrence_native_enabled) === NATIVE_RECURRENCE_MODE && event.recurrence_series_id) {
    fields.push({ id: "recurrence-end-date", label: "Last Harmony occurrence YYYY-MM-DD", maxLength: 10, value: event.recurrence_end_date || "" });
  }
  return fields;
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

function youtifulChannelMenu(action = "yschannel", eventId = "new") {
  const suffix = eventId === "new" ? "" : ":" + eventId;
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId("harmony-manager:community:" + action + suffix)
    .setPlaceholder("Choose the Discord channel")
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice);
  return [new ActionRowBuilder().addComponents(menu)];
}

function youtifulEditPanel(event) {
  const timezoneValue = event.event_timezone || event.timezone;
  const timezone = YOUTIFUL_TIMEZONE_OPTIONS.find((option) => option.value === timezoneValue)?.label || timezoneValue || "No timezone";
  const channel = event.event_channel_id ? `<#${event.event_channel_id}>` : "No channel";
  const type = YOUTIFUL_EVENT_TYPE_LABELS[event.calendar_event_type] || "Other / Custom";
  const content = [
    `✏️ **EDIT EVENT**`,
    `**${event.title}**`,
    `${event.event_date || "Date pending"}${event.all_day ? " • All Day" : ` • ${eventLocalTime(event)}`}`,
    `Time zone: ${timezone}`,
    `Type: ${type}`,
    `Channel: ${channel}`,
    event.description ? `Description: ${event.description}` : null,
  ].filter(Boolean).join("\n");
  return {
    content,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`harmony-manager:community:editdetails:${event.id}`).setLabel("📝 Details").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`harmony-manager:community:edittzpick:${event.id}`).setLabel("🕐 Time Zone").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`harmony-manager:community:edittypepick:${event.id}`).setLabel("🎨 Icon / Type").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`harmony-manager:community:editchannelpick:${event.id}`).setLabel("📍 Channel").setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`harmony-manager:community:editannouncementpick:${event.id}`).setLabel("📣 Announcements").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`harmony-manager:community:done:${event.id}`).setLabel("Done").setStyle(ButtonStyle.Success)
      ),
    ],
  };
}

function youtifulEditTypeMenu(eventId, selected) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`harmony-manager:community:edittype:${eventId}`)
    .setPlaceholder("Choose the event icon / type")
    .addOptions(YOUTIFUL_EVENT_TYPES.map((value) => {
      const match = /^<:([^:>]+):(\d+)>$/.exec(YOUTIFUL_EVENT_TYPE_ICONS[value]);
      return { label: YOUTIFUL_EVENT_TYPE_LABELS[value], value, default: value === selected, emoji: match ? { name: match[1], id: match[2] } : undefined };
    }));
  return [new ActionRowBuilder().addComponents(menu)];
}

function keepCurrentButton(calendarType, step, eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`harmony-manager:${calendarType}:editkeep:${step}:${eventId}`)
      .setLabel("Keep Current & Continue")
      .setStyle(ButtonStyle.Secondary)
  );
}

function editTimezoneComponents(calendarType, action, eventId, selected) {
  const menu = calendarType === "stray_kids"
    ? skzTimezoneMenu(action, eventId, selected)
    : youtifulTimezoneMenu(action, eventId, selected);
  return [...menu, keepCurrentButton(calendarType, "timezone", eventId)];
}

function editTypeComponents(eventId, selected) {
  return [...youtifulEditTypeMenu(eventId, selected), keepCurrentButton("community", "type", eventId)];
}

function editCategoryComponents(eventId, selected) {
  return [...categoryMenu("stray_kids", "editcategory", eventId, selected), keepCurrentButton("stray_kids", "category", eventId)];
}

function editMemberComponents(eventId, selected) {
  return [...memberMenu("stray_kids", "editmember", eventId, selected), keepCurrentButton("stray_kids", "member", eventId)];
}

function editChannelComponents(eventId) {
  return [...youtifulChannelMenu("editchannel", eventId), keepCurrentButton("community", "channel", eventId)];
}

function youtifulTimezoneMenu(action, eventId = "new", selected = null) {
  const suffix = eventId === "new" ? "" : ":" + eventId;
  const menu = new StringSelectMenuBuilder()
    .setCustomId("harmony-manager:community:" + action + suffix)
    .setPlaceholder("Choose the event time zone")
    .addOptions(YOUTIFUL_TIMEZONE_OPTIONS.map((option) => ({ label: option.label, value: option.value, default: selected === option.value })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function skzTimezoneMenu(action, eventId = "new", selected = null) {
  const suffix = eventId === "new" ? "" : ":" + eventId;
  const menu = new StringSelectMenuBuilder()
    .setCustomId("harmony-manager:stray_kids:" + action + suffix)
    .setPlaceholder("Choose the event time zone")
    .addOptions(SKZ_TIMEZONE_OPTIONS.map((option) => ({ label: option.label, value: option.value, default: selected === option.value })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function nativeEventMenu() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-manager:community:ysnative:yes").setLabel("Create Discord Scheduled Event").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("harmony-manager:community:ysnative:no").setLabel("Harmony calendar only").setStyle(ButtonStyle.Secondary)
  )];
}

function announcementPrompt(eventId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-manager:community:ysannounce:${eventId}`).setLabel("📣 Schedule Announcements").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`harmony-manager:community:ysannounce-no:${eventId}`).setLabel("No Thanks").setStyle(ButtonStyle.Secondary),
  )];
}

function announcementEventIds(guildId, event) {
  if (!event?.recurrence_series_id) return event?.id == null ? [] : [event.id];
  const rows = store.listSeriesEvents(guildId, event.recurrence_series_id)
    .filter((item) => !item.cancelled_at)
    .sort((left, right) => Number(left.recurrence_index) - Number(right.recurrence_index));

  // Native imports can be attached to a pre-existing Harmony series whose old
  // rows are still present.  For announcement setup, the native recurrence
  // timeline (and its Harmony cutoff) is authoritative; do not expose those
  // stale rows or let their IDs drift away from the persisted occurrences.
  if (Number(event.recurrence_native_enabled) === NATIVE_RECURRENCE_MODE && parseNativeRecurrence(event)) {
    const byIndex = new Map(rows.map((item) => [Number(item.recurrence_index), item]));
    return nativeSeriesOccurrences(event)
      .map((occurrence) => byIndex.get(Number(occurrence.occurrenceIndex)))
      .filter(Boolean)
      .map((item) => item.id);
  }

  const cutoff = parseManagerDate(event.recurrence_end_date);
  return rows
    .filter((item) => !cutoff || !item.event_date || item.event_date <= event.recurrence_end_date)
    .map((item) => item.id);
}

function announcementDraftEventIds(guildId, event, draft) {
  const persistedIds = announcementEventIds(guildId, event);
  // Draft IDs are only a transient handoff snapshot.  Rebuild from the
  // bounded persisted series every time so stale IDs cannot repopulate the
  // modal or the final submit after a reconciliation.
  return persistedIds;
}

function recurrenceMenu() {
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("harmony-manager:community:ysrecurrence").setPlaceholder("Choose recurrence").addOptions(
      { label: "Doesn't repeat", value: "none" },
      { label: "Weekly", value: "weekly" },
      { label: "Every 2 weeks", value: "biweekly" },
      { label: "Monthly", value: "monthly" },
      { label: "Custom", value: "custom" },
    )
  )];
}

function recurrenceConfigFields(type) {
  const fields = [];
  if (type === "custom") {
    fields.push({ id: "recurrence-interval", label: "Every how many weeks?", required: true, maxLength: 2 });
    fields.push({ id: "recurrence-weekdays", label: "Weekdays (0 Sun - 6 Sat)", required: true, maxLength: 20 });
  }
  fields.push({ id: "recurrence-end-date", label: "End date YYYY-MM-DD (or blank)", maxLength: 10 });
  fields.push({ id: "recurrence-end-count", label: "End after occurrences (or blank)", maxLength: 3 });
  return fields;
}

function recurrenceNativeMenu() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-manager:community:ysnative:yes").setLabel("Create Discord Scheduled Event(s)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("harmony-manager:community:ysnative:no").setLabel("Harmony calendar only").setStyle(ButtonStyle.Secondary)
  )];
}

function recurrenceScopeMenu(action, eventId, nativeSeries = false) {
  const options = [
    { label: "This event", value: "this" },
    ...(nativeSeries ? [] : [{ label: "This and future events", value: "future" }]),
    { label: "Entire series", value: "series" },
  ];
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`harmony-manager:community:recurrencescope:${action}:${eventId}`).setPlaceholder("Apply changes to...").addOptions(...options)
  )];
}

function nativeAdoptionScopeMenu(nativeId, linkedId = null) {
  const prefix = linkedId == null ? "nativeaddscope" : "nativelinkscope";
  const id = linkedId == null ? nativeId : `${linkedId}:${nativeId}`;
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`harmony-manager:community:${prefix}:${id}`).setPlaceholder("Choose what to bring into Harmony")
      .addOptions(
        { label: "This event", value: "this", description: "Adopt only this occurrence" },
        { label: "Entire series", value: "series", description: "Manage the bounded recurring series" },
      )
  )];
}

function nativeHarmonySeries(event) {
  return Boolean(event?.recurrence_series_id && (
    event.discord_event_id || Number(event.recurrence_native_enabled) === NATIVE_RECURRENCE_MODE ||
    String(event.recurrence_rule || "").includes('"source":"discord"')
  ));
}

function announcementScopeMenu(eventId) {
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`harmony-manager:community:recurrencescope:announcements:${eventId}`)
      .setPlaceholder("Apply announcement changes to...")
      .addOptions(
        { label: "This event", value: "this", description: "Customize announcements for this occurrence only" },
        { label: "Entire series", value: "series", description: "Set a default and optional message per occurrence" },
      )
  )];
}

function recurrenceCancelButtons(eventId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-manager:community:cancelscope:this:${eventId}`).setLabel("This event").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`harmony-manager:community:cancelscope:future:${eventId}`).setLabel("This and future events").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`harmony-manager:community:cancelscope:series:${eventId}`).setLabel("Entire series").setStyle(ButtonStyle.Danger),
  )];
}

const managerDrafts = new Map();
const pendingNativeCreates = new Map();
const pendingNativeDeletes = new Map();
const reconciliationInProgress = new Set();

function nativeCreateKey(guildId, name, start) {
  const instant = start instanceof Date ? start.getTime() : new Date(start || 0).getTime();
  return `${guildId}:${String(name || "").trim()}:${instant}`;
}

function markPendingNativeCreate(guildId, name, start) {
  const key = nativeCreateKey(guildId, name, start);
  const timer = setTimeout(() => pendingNativeCreates.delete(key), 60_000);
  timer.unref?.();
  pendingNativeCreates.set(key, timer);
  return key;
}

function clearPendingNativeCreate(guildId, name, start) {
  const key = nativeCreateKey(guildId, name, start);
  const timer = pendingNativeCreates.get(key);
  if (timer) clearTimeout(timer);
  pendingNativeCreates.delete(key);
}

function nativeDeleteKey(guildId, eventId) {
  return `${guildId}:${eventId}`;
}

function markPendingNativeDelete(guildId, eventId) {
  const key = nativeDeleteKey(guildId, eventId);
  const previous = pendingNativeDeletes.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => pendingNativeDeletes.delete(key), NATIVE_DELETE_MARKER_TTL_MS);
  timer.unref?.();
  pendingNativeDeletes.set(key, timer);
}

function clearPendingNativeDelete(guildId, eventId) {
  const key = nativeDeleteKey(guildId, eventId);
  const timer = pendingNativeDeletes.get(key);
  if (timer) clearTimeout(timer);
  pendingNativeDeletes.delete(key);
}

function consumePendingNativeDelete(guildId, eventId) {
  const key = nativeDeleteKey(guildId, eventId);
  const timer = pendingNativeDeletes.get(key);
  if (!timer) return false;
  clearTimeout(timer);
  pendingNativeDeletes.delete(key);
  return true;
}

const CALENDAR_ANNOUNCEMENT_OPTIONS = [
  { label: "Announce now", value: "now" },
  { label: "1 week before", value: "604800" },
  { label: "3 days before", value: "259200" },
  { label: "1 day before", value: "86400" },
  { label: "1 hour before", value: "3600" },
];

function announcementOffsetsFromEvent(event) {
  try { return JSON.parse(event?.announcement_offsets || "[]").map(Number); } catch { return []; }
}

function formatAnnouncementCountdown(offsetSeconds) {
  const offset = Number(offsetSeconds);
  if (!Number.isFinite(offset)) return null;
  if (offset <= 0) return "✨ Today!";
  const hours = offset / 3600;
  if (Number.isInteger(hours) && hours < 24) {
    return `✨ ${hours} hour${hours === 1 ? "" : "s"} to go!`;
  }
  const days = offset / 86400;
  if (Number.isInteger(days)) {
    if (days === 1) return "✨ Tomorrow!";
    return `✨ ${days} day${days === 1 ? "" : "s"} to go!`;
  }
  return null;
}

function normalizeCalendarAnnouncementBody(value) {
  return String(value || "")
    .replace(/@everyone/gi, "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function effectiveCalendarAnnouncementBody(event, seriesDefault = null) {
  if (event?.announcement_message_override != null) return event.announcement_message_override;
  return seriesDefault == null ? event?.announcement_message : seriesDefault;
}

function calendarAnnouncementTimestamp(event) {
  const timestamp = event?.event_at ? new Date(event.event_at).getTime() : NaN;
  return Number.isFinite(timestamp) ? `🗓️ <t:${Math.floor(timestamp / 1000)}:F>` : null;
}

function calendarAnnouncementMessage(event, offsetSeconds = null, body = null) {
  const lines = ["@everyone"];
  if (offsetSeconds != null) lines.push(formatAnnouncementCountdown(offsetSeconds));
  const localizedDateTime = calendarAnnouncementTimestamp(event);
  if (localizedDateTime) lines.push(localizedDateTime);
  const cleanBody = normalizeCalendarAnnouncementBody(body == null ? event?.announcement_message : body);
  if (cleanBody) lines.push(cleanBody);
  else lines.push(`📅 Reminder: **${event?.title || "Calendar event"}**${event?.event_channel_id ? ` in <#${event.event_channel_id}>` : ""} is coming up.`);
  return lines.filter(Boolean).join("\n");
}

function calendarAnnouncementItems(event, offsets, now = Date.now()) {
  if (event?.all_day) return [];
  const start = event?.event_at
    ? new Date(event.event_at)
    : event?.event_date && /^\d{4}-\d{2}-\d{2}$/.test(event.event_date)
      ? new Date(`${event.event_date}T09:00:00.000Z`)
      : null;
  if (!start || Number.isNaN(start.getTime())) return [];
  return [...new Set(offsets || [])].map(Number).filter((offset) => [3600, 86400, 259200, 604800].includes(offset)).map((offset) => ({
    scheduledFor: new Date(start.getTime() - offset * 1000).toISOString(),
    message: calendarAnnouncementMessage(event, offset),
  })).filter((item) => new Date(item.scheduledFor).getTime() > now);
}

function announcementTimingMenu(action, eventId = "new", selected = []) {
  const values = selected.map(String);
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`harmony-manager:community:${action}:${eventId}`)
    .setPlaceholder("Choose optional announcements")
    .setMinValues(1).setMaxValues(CALENDAR_ANNOUNCEMENT_OPTIONS.length)
    .addOptions(CALENDAR_ANNOUNCEMENT_OPTIONS.map((option) => ({ ...option, default: values.includes(option.value) })), { label: "No announcements", value: "none", default: values.length === 0 }))];
}

function announcementChannelMenu(action, eventId = "new") {
  return [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
    .setCustomId(`harmony-manager:community:${action}:${eventId}`)
    .setPlaceholder("Choose the announcement channel")
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice))];
}

async function sendImmediateCalendarAnnouncement(channel, event, guildId, message) {
  if (!channel?.isTextBased?.() || !channel?.isSendable?.() || typeof channel.send !== "function") {
    console.warn(`[scheduler-announcements] immediate-unavailable event=${event?.id || "unknown"} channel=${channel?.id || "unresolved"}`);
    return false;
  }
  const botMember = channel.guild?.members?.me;
  const permissions = botMember && typeof channel.permissionsFor === "function" ? channel.permissionsFor(botMember) : null;
  const missing = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.MentionEveryone]
    .filter((permission) => permissions && !permissions.has(permission));
  if (missing.length) {
    console.warn(`[scheduler-announcements] immediate-permission-denied event=${event?.id || "unknown"} channel=${channel.id || "unknown"} missing=${missing.join(",")}`);
    return false;
  }
  const components = event.discord_event_id ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("View Event").setStyle(ButtonStyle.Link).setURL(`https://discord.com/events/${guildId}/${event.discord_event_id}`))] : [];
  try {
    const sent = await channel.send({
      content: [calendarAnnouncementMessage(event, null, message), event.event_channel_id ? `Event channel: <#${event.event_channel_id}>` : null].filter(Boolean).join("\n"),
      components,
      allowedMentions: { parse: ["everyone"] },
    });
    const sentChannelId = sent?.channelId || sent?.channel?.id || null;
    if (!sent?.id || (channel.id && sentChannelId !== channel.id)) {
      console.error(`[scheduler-announcements] immediate-unconfirmed event=${event?.id || "unknown"} expectedChannel=${channel.id || "unknown"} returnedMessage=${sent?.id || "none"} returnedChannel=${sentChannelId || "unknown"}`);
      return false;
    }
    console.log(`[scheduler-announcements] immediate-sent event=${event?.id || "unknown"} channel=${channel.id || sentChannelId} message=${sent.id}`);
    return true;
  } catch (error) {
    console.error(`Immediate calendar announcement failed for event ${event.id}:`, error);
    return false;
  }
}

function persistCalendarAnnouncements(guildId, event, offsets, channelId) {
  return store.saveEventAnnouncements(guildId, event.id, channelId, offsets, calendarAnnouncementItems(event, offsets), event.announcement_message);
}

function refreshEventAnnouncementSchedules(guildId, events) {
  for (const event of events || []) {
    const offsets = announcementOffsetsFromEvent(event);
    if (offsets.length || event.announcement_channel_id) persistCalendarAnnouncements(guildId, event, offsets, event.announcement_channel_id);
  }
}

function oneOffTimedScheduleChanged(before, after) {
  return before?.event_at !== after?.event_at || before?.event_end_at !== after?.event_end_at || before?.event_date !== after?.event_date;
}

function isOneOffTimedEdit(before, after) {
  return Boolean(!before?.recurrence_series_id && !after?.recurrence_series_id &&
    !isRecurringLinkedNativeEvent(before, null) && !isRecurringLinkedNativeEvent(after, null) &&
    !before?.all_day && !after?.all_day && before?.event_at && after?.event_at);
}

async function updateOneOffCalendarSchedule(client, before, after, { syncDiscord = false, refreshCalendar = true, now = new Date() } = {}) {
  // Both Harmony entry points use this for equivalent timed one-off edits.
  // Recurring rows and either side of timed/all-day conversion stay on their
  // existing paths so their separate product semantics are unchanged.
  if (!isOneOffTimedEdit(before, after)) return { handled: false, changed: false };
  const changed = oneOffTimedScheduleChanged(before, after);
  if (!changed) return { handled: true, changed: false };
  const offsets = announcementOffsetsFromEvent(before);
  store.rebuildGeneratedEventAnnouncements(
    before.guild_id,
    before.id,
    calendarAnnouncementItems(before, offsets, Number.NEGATIVE_INFINITY),
    calendarAnnouncementItems(after, offsets),
  );
  if (before.discord_event_id && before.discord_event_id === after.discord_event_id && before.event_at !== after.event_at) {
    store.rescheduleDiscordEventReminders(after.guild_id, after.discord_event_id, after.event_at, now);
  }
  if (syncDiscord && after.discord_event_id) {
    try { await syncNativeScheduledEvent(client, after); }
    catch (error) { console.error("Linked Discord event sync after time edit failed:", error); }
  }
  if (refreshCalendar) {
    await refreshPublishedCalendar(client, after.guild_id, after.calendar_type, before.event_date).catch(() => {});
    if (after.event_date !== before.event_date) {
      await refreshPublishedCalendar(client, after.guild_id, after.calendar_type, after.event_date).catch(() => {});
    }
  }
  return { handled: true, changed: true };
}

// Compatibility alias for callers/tests that used the original linked-only name.
const updateLinkedOneOffCalendarSchedule = updateOneOffCalendarSchedule;

async function cancelHarmonyOneOffEvent({ guildId, eventId, cancelledBy, client, guild }) {
  const event = store.getEvent(guildId, eventId);
  if (!event || isRecurringLinkedNativeEvent(event, null)) return { handled: false, changed: false, event };
  const result = store.cancelOneOffEvent(guildId, eventId, cancelledBy);
  if (!result.changed) return { handled: true, changed: false, event: result.event || event };
  if (result.event.discord_event_id) {
    const resolvedGuild = guild || client?.guilds?.cache?.get(guildId) || await client?.guilds?.fetch(guildId).catch(() => null);
    await cancelLinkedNativeEvents({ guildId, guild: resolvedGuild, client }, [result.event]);
  }
  await refreshPublishedCalendar(client, guildId, result.event.calendar_type, result.event.event_date).catch(() => {});
  return { handled: true, changed: true, event: result.event };
}

function cancellationConfirmationComponents(eventId, recurring = false) {
  if (!recurring) return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-schedule:cancelconfirm:${eventId}`).setLabel("Confirm cancellation").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`harmony-schedule:cancelno:${eventId}`).setLabel("Keep event").setStyle(ButtonStyle.Secondary),
  )];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-schedule:cancelscope:${eventId}:this`).setLabel("This occurrence").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`harmony-schedule:cancelscope:${eventId}:future`).setLabel("This and future").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`harmony-schedule:cancelscope:${eventId}:series`).setLabel("Entire series").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`harmony-schedule:cancelno:${eventId}`).setLabel("Keep event").setStyle(ButtonStyle.Secondary)),
  ];
}

function announcementTargets(guildId, event, scope) {
  const series = event.recurrence_series_id ? store.listSeriesEvents(guildId, event.recurrence_series_id) : [event];
  return scope === "series" ? series : scope === "future" ? series.filter((item) => Number(item.recurrence_index) >= Number(event.recurrence_index)) : [event];
}

function calendarPresentationTimezone(event, fallback = DEFAULT_YOUTIFUL_TIMEZONE) {
  const candidate = event?.event_timezone || event?.timezone;
  // Older adopted native rows used UTC as a storage placeholder. Their
  // absolute event_at remains authoritative, but labels use the community
  // calendar's existing Eastern Time default until an event timezone is set.
  if (event?.discord_event_origin === "adopted" && candidate === "UTC") return fallback;
  return validTimezone(candidate) ? candidate : fallback;
}

function calendarDateInTimezone(value, timezone = DEFAULT_YOUTIFUL_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || !validTimezone(timezone)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  date.setUTCHours(0, 0, 0, 0);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function calendarCutoffBoundary(cutoffDate, timezone = DEFAULT_YOUTIFUL_TIMEZONE) {
  const nextDate = nextCalendarDate(cutoffDate);
  if (!nextDate) return null;
  const nextMidnight = localToUtc(nextDate, "00:00", timezone);
  return nextMidnight ? new Date(nextMidnight.getTime() - 1) : null;
}

function announcementOccurrenceLabel(event, seriesAnchor = null) {
  const timezone = calendarPresentationTimezone(seriesAnchor || event);
  if (event?.event_at && !Number.isNaN(new Date(event.event_at).getTime())) {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" })
      .format(new Date(event.event_at));
  }
  const date = event?.event_date || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Occurrence date pending";
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" })
    .format(new Date(`${date}T12:00:00Z`));
}

const ANNOUNCEMENT_OCCURRENCES_PER_PAGE = 4;

function announcementEditorModal(eventId, draft, event, guildId = null) {
  const recurring = Boolean(event?.recurrence_series_id);
  const scope = draft?.announcementScope || (recurring ? "series" : "this");
  const targetGuildId = draft?.guildId || guildId || event?.guild_id;
  // The persisted series is authoritative at the moment the modal opens.
  // Draft event IDs can outlive an adoption/projection reconciliation and may
  // otherwise point the editor at stale or unrelated occurrence rows.
  const currentEventIds = recurring && scope === "series"
    ? announcementDraftEventIds(targetGuildId, event, draft)
    : (draft?.eventIds || [event?.id]);
  const allTargets = currentEventIds.map((id) => store.getEvent(targetGuildId, Number(id))).filter(Boolean);
  const page = Number(draft?.announcementPage || 0);
  const targets = allTargets.slice(page * ANNOUNCEMENT_OCCURRENCES_PER_PAGE, (page + 1) * ANNOUNCEMENT_OCCURRENCES_PER_PAGE);
  const seriesAnchor = recurring ? (store.listSeriesEvents(targetGuildId, event.recurrence_series_id).find((item) => Number(item.recurrence_index) === 0) || event) : event;
  const modal = new ModalBuilder()
    .setCustomId(`harmony-manager:community:ysannouncemodal:${eventId}`)
    .setTitle(scope === "this" || !recurring ? "Schedule event announcements" : `Series announcements${allTargets.length > ANNOUNCEMENT_OCCURRENCES_PER_PAGE ? ` • Page ${page + 1}` : ""}`);
  if (scope === "this" || !recurring) {
    const messageInput = new TextInputBuilder()
      .setCustomId("announcement-message")
      .setLabel("Announcement message")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1800);
    const currentBody = effectiveCalendarAnnouncementBody(event, seriesAnchor?.announcement_message);
    if (currentBody) messageInput.setValue(normalizeCalendarAnnouncementBody(currentBody).slice(0, 1800));
    modal.addComponents(new ActionRowBuilder().addComponents(messageInput));
  } else {
    if (page === 0) {
      const defaultInput = new TextInputBuilder()
        .setCustomId("announcement-message")
        .setLabel("Message for all dates")
        .setPlaceholder("Used for every occurrence unless you enter a different message for a specific date.")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1800);
      const currentBody = seriesAnchor?.announcement_message;
      if (currentBody) defaultInput.setValue(normalizeCalendarAnnouncementBody(currentBody).slice(0, 1800));
      modal.addComponents(new ActionRowBuilder().addComponents(defaultInput));
    }
    for (const target of targets) {
      const input = new TextInputBuilder()
        .setCustomId(`announcement-override-${target.id}`)
        .setLabel(announcementOccurrenceLabel(target, seriesAnchor).slice(0, 45))
        .setPlaceholder("Optional — replace the message for this date")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1800);
      const existing = draft?.announcementOverrides?.get?.(String(target.id)) ?? target.announcement_message_override;
      if (existing) input.setValue(normalizeCalendarAnnouncementBody(existing).slice(0, 1800));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
  }
  return modal;
}

async function beginCanonicalAnnouncementFlow(interaction, event, eventIds = [event.id], scope = null) {
  const recurring = Boolean(event.recurrence_series_id);
  const announcementScope = scope || (recurring ? "series" : "this");
  managerDrafts.set(draftKey(interaction, "community", `announce-${event.id}`), {
    eventIds,
    linked: Boolean(event.discord_event_id),
    title: event.title,
    editing: true,
    guildId: interaction.guildId,
    announcementScope,
  });
  await interaction.update({
    content: `Would you like to schedule announcements for **${event.title}**?`,
    components: announcementPrompt(event.id),
  });
}

function applyAnnouncementConfig(guildId, event, scope, offsets, channelId) {
  return announcementTargets(guildId, event, scope).map((item) => {
    const body = effectiveCalendarAnnouncementBody(item, event.announcement_message);
    if (Number(item.recurrence_native_enabled) === NATIVE_RECURRENCE_MODE) {
      return store.mergeEventAnnouncements(guildId, item.id, channelId, offsets, calendarAnnouncementItems({ ...item, announcement_message: body }, offsets), scope === "series" && item.id === event.id ? event.announcement_message : undefined);
    }
    return store.saveEventAnnouncements(guildId, item.id, channelId, offsets, calendarAnnouncementItems({ ...item, announcement_message: body }, offsets), body);
  });
}

function recurrenceOccurrences(draft) {
  const rule = draft.recurrenceRule || { type: "none" };
  return generateRecurringOccurrences({
    startDate: draft.eventDate,
    startTime: draft.eventTime,
    timezone: draft.eventTimezone,
    rule,
    localToUtc,
  });
}

function createYoutifulOccurrences(guildId, calendarChannelId, draft, createdBy) {
  const occurrences = recurrenceOccurrences(draft);
  const seriesId = draft.recurrenceRule?.type && draft.recurrenceRule.type !== "none" ? randomUUID() : null;
  const created = occurrences.map((occurrence) => store.createCalendarEvent({
    guildId,
    calendarChannelId,
    title: draft.title,
    link: draft.link,
    timezone: draft.timezone,
    eventAt: occurrence.eventAt,
    eventEndAt: draft.eventEndAt && occurrence.eventAt ? new Date(new Date(occurrence.eventAt).getTime() + (new Date(draft.eventEndAt).getTime() - new Date(draft.eventAt).getTime())).toISOString() : null,
    eventDate: occurrence.eventDate,
    eventTimezone: draft.eventTimezone,
    eventLocation: draft.eventLocation,
    calendarType: "community",
    category: draft.calendarEventType,
    allDay: draft.allDay,
    description: draft.description,
    createdBy,
    calendarEventType: draft.calendarEventType,
    eventChannelId: draft.eventChannelId,
    recurrenceSeriesId: seriesId,
    recurrenceRule: seriesId ? JSON.stringify(draft.recurrenceRule) : null,
    recurrenceIndex: seriesId ? occurrence.occurrenceIndex : null,
    recurrenceEndDate: seriesId ? draft.recurrenceRule.endDate : null,
    recurrenceEndCount: seriesId ? draft.recurrenceRule.count : null,
    announcementChannelId: draft.announcementChannelId || null,
    announcementOffsets: draft.announcementOffsets || [],
  }));
  return { seriesId, occurrences: created.map((id) => store.getEvent(guildId, id)) };
}

async function refreshRecurringMonths(client, guildId, events) {
  const months = [...new Set(events.map(eventPresentationMonth).filter(Boolean))];
  for (const month of months) await refreshPublishedCalendar(client, guildId, "community", month);
}

async function saveManagerEvent(interaction, calendarType, draft, metadata = {}, responseMethod = "reply") {
  const id = store.createCalendarEvent({
    guildId: interaction.guildId,
    calendarChannelId: metadata.calendarChannelId || store.getCalendarChannels(interaction.guildId)?.[calendarType === "stray_kids" ? "stray_kids_channel_id" : "community_channel_id"] || null,
    title: draft.title,
    link: draft.link,
    timezone: draft.timezone,
    eventAt: draft.eventAt,
    eventDate: draft.eventDate,
    eventTimezone: draft.eventTimezone,
    eventLocation: draft.eventLocation,
    calendarType,
    category: metadata.category || "other",
    member: metadata.member || null,
    allDay: draft.allDay,
    description: draft.description,
    createdBy: interaction.user.id,
  });
  managerDrafts.delete(draftKey(interaction, calendarType));
  const savedResponse = { content: `✅ Event saved: **${draft.title}**`, components: [] };
  await interaction[responseMethod](responseMethod === "reply" ? { ...savedResponse, flags: 64 } : savedResponse);
  try {
    const refreshed = await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, draft.eventDate);
    if (!refreshed && responseMethod === "reply") {
      await interaction.editReply({ ...savedResponse, content: "Event saved! This month has not been published yet, so the public calendar was not changed." });
    }
  } catch (refreshError) {
    console.error("Published calendar refresh after Add Event failed:", refreshError);
    if (responseMethod === "reply") await interaction.editReply({ ...savedResponse, content: "Event saved, but the published calendar could not be refreshed. Please use View / Preview to retry." });
  }
  return store.getEvent(interaction.guildId, id);
}

async function syncChangedNativeEvents(client, events) {
  for (const event of events) {
    if (event.discord_event_id && !event.all_day) await syncNativeScheduledEvent(client, event).catch((error) => console.error("Linked recurring Discord event sync failed:", error));
  }
}

function nativeRecurrencePayload(nativeEvent, effectiveAnchorAt = null) {
  const rule = nativeEvent?.recurrenceRule;
  if (!rule) return null;
  const anchorAt = effectiveAnchorAt || nativeEvent.scheduledStartAt || rule.startAt;
  return JSON.stringify({
    source: "discord",
    // Discord's recurrence rule can describe the historical beginning of a
    // long-running series. Harmony adopts the occurrence currently selected
    // by Discord, so keep that effective anchor explicitly and never project
    // occurrences before it.
    anchorAt: anchorAt?.toISOString?.() || anchorAt || null,
    startAt: rule.startAt?.toISOString?.() || nativeEvent.scheduledStartAt?.toISOString?.() || null,
    endAt: rule.endAt?.toISOString?.() || null,
    frequency: Number(rule.frequency),
    interval: Number(rule.interval) || 1,
    byWeekday: rule.byWeekday ? [...rule.byWeekday].map(Number) : null,
    byNWeekday: rule.byNWeekday ? [...rule.byNWeekday] : null,
    byMonth: rule.byMonth ? [...rule.byMonth].map(Number) : null,
    byMonthDay: rule.byMonthDay ? [...rule.byMonthDay].map(Number) : null,
    byYearDay: rule.byYearDay ? [...rule.byYearDay].map(Number) : null,
    count: rule.count == null ? null : Number(rule.count),
  });
}

function parseNativeRecurrence(event) {
  try {
    const parsed = JSON.parse(event?.recurrence_rule || "null");
    return parsed?.source === "discord" ? parsed : null;
  } catch { return null; }
}

function nativeSeriesOccurrences(event, until = null) {
  const rule = parseNativeRecurrence(event);
  if (!rule) return [];
  const effectiveStartAt = rule.anchorAt || event.event_at || rule.startAt;
  const anchorMs = Date.parse(effectiveStartAt);
  const presentationTimezone = calendarPresentationTimezone(event);
  const configuredUntil = parseManagerDate(event.recurrence_end_date)
    ? calendarCutoffBoundary(event.recurrence_end_date, presentationTimezone)
    : null;
  const horizon = configuredUntil && until
    ? new Date(Math.min(configuredUntil.getTime(), new Date(until).getTime()))
    : configuredUntil || until || new Date(Math.max(Date.now(), anchorMs) + 180 * 24 * 60 * 60 * 1000);
  return generateDiscordRecurringOccurrences({
    startAt: effectiveStartAt,
    endAt: event.event_end_at,
    recurrenceRule: rule,
    until: horizon,
  });
}

function materializeNativeSeriesAnnouncements(guildId, anchor, occurrences) {
  const offsets = announcementOffsetsFromEvent(anchor);
  if (!offsets.length || !anchor.announcement_channel_id) return;
  for (const occurrence of occurrences) {
    const target = store.getSeriesEvent(guildId, anchor.recurrence_series_id, occurrence.occurrenceIndex);
    if (!target) continue;
    const body = effectiveCalendarAnnouncementBody(target, anchor.announcement_message);
    const items = calendarAnnouncementItems({ ...target, announcement_message: body }, offsets);
    store.mergeEventAnnouncements(guildId, target.id, anchor.announcement_channel_id, offsets, items, target.id === anchor.id ? anchor.announcement_message : undefined);
  }
}

async function syncDiscordRecurringSeries(guildId, anchor, until = null) {
  if (!anchor?.recurrence_series_id || Number(anchor.recurrence_native_enabled) !== NATIVE_RECURRENCE_MODE) return [];
  const occurrences = nativeSeriesOccurrences(anchor, until);
  const presentationTimezone = calendarPresentationTimezone(anchor);
  const occurrenceDate = (occurrence) => calendarDateInTimezone(occurrence.eventAt, presentationTimezone) || occurrence.eventAt.slice(0, 10);
  const anchorOccurrence = occurrences.find((item) => Number(item.occurrenceIndex) === 0);
  // A native series can be attached to an older Harmony recurrence whose
  // indexes exist but whose persisted dates are stale. Reconcile those dates
  // before rebuilding announcements so old dates cannot leak into the UI.
  if (anchorOccurrence && Number(anchor.recurrence_index) === 0 && (
    anchor.event_at !== anchorOccurrence.eventAt ||
    anchor.event_end_at !== anchorOccurrence.eventEndAt ||
    anchor.event_date !== occurrenceDate(anchorOccurrence)
  )) {
    anchor = store.updateEvent(guildId, anchor.id, {
      event_at: anchorOccurrence.eventAt,
      event_end_at: anchorOccurrence.eventEndAt,
      event_date: occurrenceDate(anchorOccurrence),
    }) || anchor;
  }
  for (const occurrence of occurrences) {
    if (Number(occurrence.occurrenceIndex) === Number(anchor.recurrence_index)) continue;
    const existing = store.getSeriesEvent(guildId, anchor.recurrence_series_id, occurrence.occurrenceIndex);
    if (existing) {
      if (existing.event_at !== occurrence.eventAt || existing.event_end_at !== occurrence.eventEndAt || existing.event_date !== occurrenceDate(occurrence)) {
        store.updateEvent(guildId, existing.id, {
          event_at: occurrence.eventAt,
          event_end_at: occurrence.eventEndAt,
          event_date: occurrenceDate(occurrence),
        });
      }
      continue;
    }
    store.createSeriesOccurrence(guildId, anchor.recurrence_series_id, { ...occurrence, eventDate: occurrenceDate(occurrence) }, anchor);
  }
  materializeNativeSeriesAnnouncements(guildId, anchor, occurrences);
  return occurrences;
}

async function syncDiscordRecurringSeriesWindow() {
  const anchors = store.listNativeRecurringSeriesAnchors();
  for (const anchor of anchors) {
    try { await syncDiscordRecurringSeries(anchor.guild_id, anchor); }
    catch (error) { console.error(`Discord recurring series projection failed for ${anchor.id}:`, error); }
  }
}

async function syncRecurringNativeEventWindow(client) {
  const now = new Date();
  const until = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
  const candidates = store.listRecurringNativeCandidates(now.toISOString(), until.toISOString(), 100);
  const linkedBySeries = new Map();
  for (con…33147 tokens truncated…s") && draft.allDay) nativeWarning = " All-day events remain Harmony-only.";
      managerDrafts.set(draftKey(interaction, calendarType, `announce-${createdEvents[0]?.id || "none"}`), {
        eventIds: createdEvents.map((event) => event.id),
        linked: Boolean(nativeId),
        nativeWarning,
        title: draft.title,
        guildId: interaction.guildId,
        announcementScope: createdEvents[0]?.recurrence_series_id ? "series" : "this",
      });
      const firstEvent = createdEvents[0];
      await interaction.update({ content: `✅ Event created: **${draft.title}**${nativeId ? " (Discord event linked)" : ""}${nativeWarning}\n\nWould you like to schedule announcements for this event?`, components: firstEvent ? announcementPrompt(firstEvent.id) : [] });
      await refreshRecurringMonths(interaction.client, interaction.guildId, createdEvents).catch((error) => console.error("Youtiful calendar refresh failed:", error));
    } catch (error) { await interaction.update({ content: `Event saved failed: ${error.message}`, components: [] }); }
    return;
  }
  if (calendarType === "community" && action === "ysannounce" && interaction.isButton()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, `announce-${eventId}`));
    if (!draft) { await interaction.update({ content: "That announcement setup expired. The event was saved successfully.", components: [] }); return; }
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.update({ content: "That event is no longer active.", components: [] }); return; }
    const currentDraft = event.recurrence_series_id && (draft.announcementScope || "series") === "series"
      ? { ...draft, eventIds: announcementDraftEventIds(interaction.guildId, event, draft), announcementPage: 0 }
      : draft;
    managerDrafts.set(draftKey(interaction, calendarType, `announce-${eventId}`), currentDraft);
    await interaction.showModal(announcementEditorModal(eventId, currentDraft, event, interaction.guildId));
    return;
  }
  if (calendarType === "community" && action === "ysannouncepage" && interaction.isButton()) {
    const key = draftKey(interaction, calendarType, `announce-${eventId}`);
    const draft = managerDrafts.get(key);
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!draft || !event) { await interaction.update({ content: "That announcement setup expired. The event was saved successfully.", components: [] }); return; }
    const page = Number(parts[4]);
    const currentDraft = event.recurrence_series_id && (draft.announcementScope || "series") === "series"
      ? { ...draft, eventIds: announcementDraftEventIds(interaction.guildId, event, draft), announcementPage: Number.isInteger(page) && page >= 0 ? page : 0 }
      : { ...draft, announcementPage: Number.isInteger(page) && page >= 0 ? page : 0 };
    managerDrafts.set(key, currentDraft);
    await interaction.showModal(announcementEditorModal(eventId, currentDraft, event, interaction.guildId));
    return;
  }
  if (calendarType === "community" && action === "ysannounce-no" && interaction.isButton()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, `announce-${eventId}`));
    managerDrafts.delete(draftKey(interaction, calendarType, `announce-${eventId}`));
    await interaction.update({
      content: draft?.editing ? "✅ Calendar event changes saved. No public announcements scheduled." : "✅ Event created. No public announcements scheduled.",
      components: [],
    });
    return;
  }
  if (calendarType === "community" && action === "ysannouncemodal" && interaction.isModalSubmit()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, `announce-${eventId}`));
    if (!draft) { await interaction.reply({ content: "That announcement setup expired. The event was saved successfully.", flags: 64 }); return; }
    const event = store.getEvent(interaction.guildId, Number(eventId));
    const announcementScope = draft.announcementScope || (event?.recurrence_series_id ? "series" : "this");
    const targetEventIds = event?.recurrence_series_id && announcementScope === "series"
      ? announcementDraftEventIds(interaction.guildId, event, draft)
      : (draft.eventIds || [Number(eventId)]);
    const targetEvents = targetEventIds.map((id) => store.getEvent(interaction.guildId, Number(id))).filter(Boolean);
    const page = Number(draft.announcementPage || 0);
    const pageEvents = announcementScope === "series"
      ? targetEvents.slice(page * ANNOUNCEMENT_OCCURRENCES_PER_PAGE, (page + 1) * ANNOUNCEMENT_OCCURRENCES_PER_PAGE)
      : [];
    const overrides = new Map(draft.announcementOverrides || []);
    for (const target of pageEvents) {
      const value = normalizeCalendarAnnouncementBody(interaction.fields.getTextInputValue(`announcement-override-${target.id}`)) || null;
      overrides.set(String(target.id), value);
    }
    const announcementMessage = announcementScope === "series" && page > 0
      ? normalizeCalendarAnnouncementBody(draft.announcementMessage || "")
      : normalizeCalendarAnnouncementBody(interaction.fields.getTextInputValue("announcement-message"));
    if (!announcementMessage) {
      const uncovered = targetEvents.some((target) => {
        const override = overrides.has(String(target.id)) ? overrides.get(String(target.id)) : target.announcement_message_override;
        return !normalizeCalendarAnnouncementBody(override || "");
      });
      if (uncovered) {
        await interaction.reply({ content: "Please provide a message for every occurrence, or enter a Message for all dates.", flags: 64 });
        return;
      }
    }
    const nextPage = announcementScope === "series" && (page + 1) * ANNOUNCEMENT_OCCURRENCES_PER_PAGE < targetEvents.length;
    const nextDraft = {
      ...draft,
      announcementScope,
      announcementMessage,
      announcementOverrides: overrides,
    };
    if (nextPage) {
      nextDraft.announcementPage = page + 1;
      managerDrafts.set(draftKey(interaction, calendarType, `announce-${eventId}`), nextDraft);
      await interaction.reply({
        content: `Saved occurrence page ${page + 1}. Continue to edit the next occurrences.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`harmony-manager:community:ysannouncepage:${eventId}:${page + 1}`).setLabel("Save & Continue").setStyle(ButtonStyle.Primary)
        )],
        flags: 64,
      });
      return;
    }
    managerDrafts.set(draftKey(interaction, calendarType, `announce-${eventId}`), nextDraft);
    await interaction.reply({ content: "Choose the separate announcement channel.", components: announcementChannelMenu("ysannouncechannel", eventId), flags: 64 });
    return;
  }
  if (calendarType === "community" && action === "ysannouncechannel" && interaction.isChannelSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, `announce-${eventId}`));
    if (!draft) { await interaction.update({ content: "That announcement setup expired. The event was saved successfully.", components: [] }); return; }
    managerDrafts.set(draftKey(interaction, calendarType, `announce-${eventId}`), { ...draft, announcementChannelId: interaction.values[0] });
    const scopeText = draft.announcementScope === "this" ? "this occurrence only" : "the entire recurring series";
    await interaction.update({ content: `Announcement settings apply to ${scopeText}. Choose one or more announcement timings.`, components: announcementTimingMenu("ysannouncetiming", eventId) });
    return;
  }
  if (calendarType === "community" && action === "ysannouncetiming" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, `announce-${eventId}`));
    if (!draft) { await interaction.update({ content: "That announcement setup expired. The event was saved successfully.", components: [] }); return; }
    const draftEvent = store.getEvent(interaction.guildId, Number(eventId));
    const eventIds = draftEvent?.recurrence_series_id && (draft.announcementScope || "series") === "series"
      ? announcementDraftEventIds(interaction.guildId, draftEvent, draft)
      : (draft.eventIds || [Number(eventId)]);
    const editing = Boolean(draft.editing);
    const selected = interaction.values.includes("none") ? [] : interaction.values;
    const first = store.getEvent(interaction.guildId, eventIds[0]);
    if (!first) { await interaction.update({ content: "The event is no longer active.", components: [] }); return; }
    const announcementMessage = normalizeCalendarAnnouncementBody(draft.announcementMessage);
    const announcementScope = draft.announcementScope || (first.recurrence_series_id ? "series" : "this");
    const announcementOverrides = draft.announcementOverrides || new Map();
    const offsets = selected.filter((value) => value !== "now").map(Number).filter((value) => [3600, 86400, 259200, 604800].includes(value));
    console.log(`[scheduler-announcements] timing-submit guild=${interaction.guildId} eventIds=${eventIds.join(",")} selected=${selected.join(",")} channel=${draft.announcementChannelId}`);
    // Series membership is the source of truth for announcement overrides.
    // Only the native anchor is guaranteed to carry recurrence_native_enabled;
    // projected occurrences inherit the series identity but may leave that
    // mode unset.
    const recurring = Boolean(first.recurrence_series_id);
    const seriesEvents = recurring ? store.listSeriesEvents(interaction.guildId, first.recurrence_series_id) : [];
    const seriesAnchor = recurring ? (seriesEvents.find((item) => Number(item.recurrence_index) === 0) || first) : first;
    let immediatePosted = false;
    let immediateFailed = false;
    let immediateAttempted = false;
    const targetIds = announcementScope === "this" ? [first.id] : eventIds;
    if (recurring && announcementScope !== "this") {
      store.updateEvent(interaction.guildId, seriesAnchor.id, {
        announcement_channel_id: draft.announcementChannelId,
        announcement_offsets: JSON.stringify(offsets),
        announcement_message: announcementMessage,
      });
    }
    for (const id of targetIds) {
      const event = store.getEvent(interaction.guildId, id);
      if (!event) continue;
      const override = announcementOverrides.has(String(event.id)) ? announcementOverrides.get(String(event.id)) : event.announcement_message_override;
      const body = recurring && announcementScope !== "this" ? (override != null ? override : announcementMessage) : announcementMessage;
      const items = calendarAnnouncementItems({ ...event, announcement_message: body }, offsets);
      if (recurring) {
        store.updateEvent(interaction.guildId, event.id, { announcement_message_override: announcementScope === "this" ? announcementMessage : override });
        store.mergeEventAnnouncements(interaction.guildId, event.id, draft.announcementChannelId, offsets, items);
        store.refreshPendingAnnouncementMessages(event.id, items);
      } else {
        store.saveEventAnnouncements(interaction.guildId, event.id, draft.announcementChannelId, offsets, items, announcementMessage);
      }
      if (selected.includes("now") && !immediateAttempted) {
        immediateAttempted = true;
        const channel = interaction.guild?.channels?.cache?.get(draft.announcementChannelId) || await interaction.guild?.channels?.fetch(draft.announcementChannelId).catch(() => null);
        immediatePosted = await sendImmediateCalendarAnnouncement(channel, event, interaction.guildId, announcementMessage);
        immediateFailed = !immediatePosted;
        console.log(`[scheduler-announcements] timing-immediate-result guild=${interaction.guildId} event=${event.id} channel=${draft.announcementChannelId} posted=${immediatePosted}`);
      }
    }
    managerDrafts.delete(draftKey(interaction, calendarType, `announce-${eventId}`));
    const status = selected.includes("now") && immediateFailed && !immediatePosted
      ? (offsets.length
        ? `${editing ? "✅ Calendar event changes saved" : "✅ Event saved"} and future announcements were scheduled, but Harmony could not post the announcement now.`
        : `${editing ? "✅ Calendar event changes saved" : "✅ Event saved"}, but Harmony could not post the announcement now.`)
      : editing ? "✅ Calendar event changes saved and announcements scheduled." : "✅ Event created and announcements scheduled.";
    await interaction.update({ content: status, components: [] });
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
      const fields = {
        title: interaction.fields.getTextInputValue("title"),
        eventDate: interaction.fields.getTextInputValue("event-date"),
        eventTime: interaction.fields.getTextInputValue("event-time"),
        location: interaction.fields.getTextInputValue("location"),
        description: interaction.fields.getTextInputValue("description"),
      };
      if (calendarType === "stray_kids") {
        managerDrafts.set(draftKey(interaction, calendarType), { ...categoryDraft, ...fields });
        await interaction.reply({ content: "Choose the event time zone. For an all-day event, choose No timezone.", components: skzTimezoneMenu("sktimezone"), flags: 64 });
        return;
      }
      const draft = parseManagerDraft(fields, calendarType);
      await saveManagerEvent(interaction, calendarType, draft, categoryDraft);
    } catch (error) {
      await interaction.reply({ content: error.message, flags: 64 });
    }
    return;
  }
  if (calendarType === "stray_kids" && action === "sktimezone" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.update({ content: "That event draft expired. Please start again.", components: [] }); return; }
    const timezone = interaction.values[0] === "none" ? "" : interaction.values[0];
    try {
      const parsed = parseManagerDraft({ ...draft, timezone }, calendarType);
      await saveManagerEvent(interaction, calendarType, parsed, {
        category: draft.category,
        member: draft.member,
        calendarChannelId,
      }, "update");
    } catch (error) {
      await interaction.update({ content: error.message, components: skzTimezoneMenu("sktimezone", "new", interaction.values[0]) });
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
    if (calendarType === "community") {
      await interaction.update(youtifulEditPanel(event));
    } else {
      await interaction.showModal(managerModal(`harmony-manager:${calendarType}:editmodal:${event.id}`, "Edit calendar event", editManagerFields(event)));
    }
    return;
  }
  if (calendarType === "community" && action === "recurrencescope" && interaction.isStringSelectMenu()) {
    const target = parts[3];
    const scopedEventId = parts[4];
    const event = store.getEvent(interaction.guildId, Number(scopedEventId));
    if (!event) { await interaction.update({ content: "That event is no longer available.", components: [] }); return; }
    const draft = managerDrafts.get(draftKey(interaction, calendarType, scopedEventId)) || { eventId: event.id, existing: event };
    managerDrafts.set(draftKey(interaction, calendarType, scopedEventId), { ...draft, scope: interaction.values[0], existing: event, eventId: event.id });
    if (target === "details") await interaction.showModal(managerModal(`harmony-manager:community:editdetailsmodal:${event.id}`, "Edit event details", youtifulEditFields(event)));
    else if (target === "timezone") await interaction.update({ content: "Choose the event time zone, or keep the current one.", components: editTimezoneComponents("community", "edittimezone", scopedEventId, event.event_timezone || event.timezone || (event.all_day ? "none" : null)) });
    else if (target === "type") await interaction.update({ content: "Choose the event icon / type, or keep the current one.", components: editTypeComponents(scopedEventId, event.calendar_event_type || "other") });
    else if (target === "channel") await interaction.update({ content: "Choose the Discord channel associated with this event, or keep the current one.", components: editChannelComponents(scopedEventId) });
    else if (target === "description") await interaction.showModal(managerModal(`harmony-manager:community:descriptionmodal:${event.id}:${interaction.values[0]}`, "Edit description", [{ id: "description", label: "Short description", maxLength: 300, paragraph: true, value: event.description || "" }]));
    else if (target === "announcements") {
      const targets = announcementTargets(interaction.guildId, event, interaction.values[0]);
      managerDrafts.delete(draftKey(interaction, calendarType, event.id));
      await beginCanonicalAnnouncementFlow(interaction, event, targets.map((item) => item.id), interaction.values[0]);
    }
    return;
  }
  if (action === "editkeep" && interaction.isButton()) {
    const step = parts[3];
    const selectedEventId = parts[4];
    const existing = store.getEvent(interaction.guildId, Number(selectedEventId));
    const draft = managerDrafts.get(draftKey(interaction, calendarType, selectedEventId));
    if (!existing || !draft || existing.calendar_type !== calendarType) {
      await interaction.update({ content: "That event edit expired. Please start again.", components: [] });
      return;
    }
    if (calendarType === "community") {
      await interaction.update(youtifulEditPanel(existing));
      return;
    }
    if (step === "timezone") {
      try {
        const timezone = existing.all_day ? "" : (existing.event_timezone || existing.timezone || resolveLocationTimezone(existing.event_location));
        const parsed = parseManagerDraft({ ...draft, timezone }, calendarType);
        const saved = store.updateEvent(interaction.guildId, Number(selectedEventId), {
          title: parsed.title, event_date: parsed.eventDate, event_at: parsed.eventAt,
          event_timezone: parsed.eventTimezone, timezone: parsed.timezone,
          event_location: parsed.eventLocation, link: parsed.link, description: parsed.description,
          all_day: parsed.allDay ? 1 : 0, event_end_at: parsed.eventEndAt,
        });
        managerDrafts.set(draftKey(interaction, calendarType, selectedEventId), { ...parsed, eventId: Number(selectedEventId), existing: saved });
        const oneOffSync = await updateOneOffCalendarSchedule(interaction.client, existing, saved, { syncDiscord: true, refreshCalendar: false });
        if (saved.discord_event_id && !saved.all_day && (!oneOffSync.handled || !oneOffSync.changed)) await syncNativeScheduledEvent(interaction.client, saved).catch((error) => console.error("Linked Discord event sync after edit failed:", error));
        await refreshEditedMonths(interaction.client, interaction.guildId, calendarType, existing.event_date, saved.event_date).catch((error) => console.error("Published calendar refresh after Edit Event failed:", error));
        await interaction.update({ content: "Choose a category for this event, or keep the current one.", components: editCategoryComponents(selectedEventId, saved.category || existing.category || "other") });
      } catch (error) {
        await interaction.update({ content: error.message, components: editTimezoneComponents(calendarType, "skzedittimezone", selectedEventId, existing.event_timezone || existing.timezone || (existing.all_day ? "none" : null)) });
      }
      return;
    }
    if (step === "category") {
      await interaction.update({ content: "Choose an optional Stray Kids member, or keep the current one.", components: editMemberComponents(selectedEventId, existing.member) });
      return;
    }
    if (step === "member") {
      managerDrafts.delete(draftKey(interaction, calendarType, selectedEventId));
      await interaction.update({ content: `✅ Updated calendar event **${existing.title}**.`, components: [] });
    }
    return;
  }
  if (calendarType === "community" && action === "editannouncementpick" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: "Apply announcement changes to:", components: announcementScopeMenu(event.id) });
    else {
      managerDrafts.delete(draftKey(interaction, calendarType, event.id));
      await beginCanonicalAnnouncementFlow(interaction, event);
    }
    return;
  }
  if (calendarType === "community" && action === "editdetails" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: "Apply Details changes to:", components: recurrenceScopeMenu("details", event.id, nativeHarmonySeries(event)) });
    else await interaction.showModal(managerModal(`harmony-manager:community:editdetailsmodal:${event.id}`, "Edit event details", youtifulEditFields(event)));
    return;
  }
  if (calendarType === "community" && action === "editdetailsmodal" && interaction.isModalSubmit()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    try {
      const timezone = existing.all_day ? "" : (existing.event_timezone || existing.timezone);
      const parsed = parseManagerDraft({
        title: interaction.fields.getTextInputValue("title"),
        eventDate: interaction.fields.getTextInputValue("event-date"),
        eventTime: interaction.fields.getTextInputValue("event-time"),
        timezone,
        description: interaction.fields.getTextInputValue("description"),
      }, calendarType);
      let recurrenceEndDate;
      if (Number(existing.recurrence_native_enabled) === NATIVE_RECURRENCE_MODE && interaction.fields.fields?.has?.("recurrence-end-date")) {
        recurrenceEndDate = interaction.fields.getTextInputValue("recurrence-end-date").trim() || null;
        if (recurrenceEndDate && (!parseManagerDate(recurrenceEndDate) || recurrenceEndDate < existing.event_date)) {
          throw new Error("Last Harmony occurrence must be a valid date on or after the event date.");
        }
      }
      const draftState = managerDrafts.get(draftKey(interaction, calendarType, eventId));
      const changed = applyRecurringChanges(interaction.guildId, existing, draftState?.scope || "this", {
        title: parsed.title, event_date: parsed.eventDate, event_at: parsed.eventAt,
        event_timezone: parsed.eventTimezone, timezone: parsed.timezone, link: parsed.link,
        description: parsed.description, all_day: parsed.allDay ? 1 : 0, event_end_at: parsed.eventEndAt,
        ...(recurrenceEndDate !== undefined ? { recurrence_end_date: recurrenceEndDate } : {}),
      });
      const saved = changed.find((item) => item.id === existing.id) || changed[0];
      await interaction.reply({ ...youtifulEditPanel(saved), flags: 64 });
      await syncChangedNativeEvents(interaction.client, changed);
      for (const item of changed) {
        if (Number(item.recurrence_native_enabled) === NATIVE_RECURRENCE_MODE && item.recurrence_series_id) {
          await syncDiscordRecurringSeries(interaction.guildId, item).catch((error) => console.error("Discord recurring series resync after edit failed:", error));
        }
      }
      refreshEventAnnouncementSchedules(interaction.guildId, changed);
      await refreshRecurringMonths(interaction.client, interaction.guildId, changed).catch((error) => console.error("Calendar refresh after details edit failed:", error));
    } catch (error) { await interaction.reply({ content: error.message, flags: 64 }); }
    return;
  }
  if (calendarType === "community" && action === "edittzpick" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: "Apply Time Zone changes to:", components: recurrenceScopeMenu("timezone", event.id, nativeHarmonySeries(event)) });
    else await interaction.update({ content: "Choose the event time zone, or keep the current one.", components: editTimezoneComponents("community", "edittimezone", eventId, event.event_timezone || event.timezone || (event.all_day ? "none" : null)) });
    return;
  }
  if (calendarType === "community" && action === "edittypepick" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: "Apply Icon / Type changes to:", components: recurrenceScopeMenu("type", event.id, nativeHarmonySeries(event)) });
    else await interaction.update({ content: "Choose the event icon / type, or keep the current one.", components: editTypeComponents(eventId, event.calendar_event_type || "other") });
    return;
  }
  if (calendarType === "community" && action === "edittype" && interaction.isStringSelectMenu()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing) { await interaction.update({ content: "That event is no longer available.", components: [] }); return; }
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const changed = applyRecurringChanges(interaction.guildId, existing, draft?.scope || "this", { calendar_event_type: interaction.values[0], category: interaction.values[0] });
    const saved = changed.find((item) => item.id === existing.id) || changed[0];
    await interaction.update(youtifulEditPanel(saved));
    await syncChangedNativeEvents(interaction.client, changed);
    refreshEventAnnouncementSchedules(interaction.guildId, changed);
    await refreshRecurringMonths(interaction.client, interaction.guildId, changed).catch((error) => console.error("Calendar refresh after type edit failed:", error));
    return;
  }
  if (calendarType === "community" && action === "editchannelpick" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: "Apply Channel changes to:", components: recurrenceScopeMenu("channel", event.id, nativeHarmonySeries(event)) });
    else await interaction.update({ content: "Choose the Discord channel associated with this event, or keep the current one.", components: editChannelComponents(eventId) });
    return;
  }
  if (calendarType === "community" && action === "editchannel" && interaction.isChannelSelectMenu()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing) { await interaction.update({ content: "That event is no longer available.", components: [] }); return; }
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const changed = applyRecurringChanges(interaction.guildId, existing, draft?.scope || "this", { event_channel_id: interaction.values[0] });
    const saved = changed.find((item) => item.id === existing.id) || changed[0];
    await interaction.update(youtifulEditPanel(saved));
    await syncChangedNativeEvents(interaction.client, changed);
    refreshEventAnnouncementSchedules(interaction.guildId, changed);
    await refreshRecurringMonths(interaction.client, interaction.guildId, changed).catch((error) => console.error("Calendar refresh after channel edit failed:", error));
    return;
  }
  if (action === "editmodal" && interaction.isModalSubmit()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing || existing.calendar_type !== calendarType) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (calendarType !== "community") {
      try {
        const draft = {
          eventId: Number(eventId),
          existing,
          title: interaction.fields.getTextInputValue("title"),
          eventDate: interaction.fields.getTextInputValue("event-date"),
          eventTime: interaction.fields.getTextInputValue("event-time"),
          location: interaction.fields.getTextInputValue("location"),
          description: interaction.fields.getTextInputValue("description"),
        };
        managerDrafts.set(draftKey(interaction, calendarType, eventId), draft);
        const legacyTimezone = existing.event_timezone || existing.timezone || resolveLocationTimezone(existing.event_location);
        await interaction.reply({ content: "Choose the event time zone, or keep the current one. For an all-day event, choose No timezone.", components: editTimezoneComponents("stray_kids", "skzedittimezone", eventId, legacyTimezone || (existing.all_day ? "none" : null)), flags: 64 });
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
    await interaction.reply({ content: "Choose the event time zone, or keep the current one. For an all-day event, choose No timezone.", components: editTimezoneComponents("community", "edittimezone", eventId, legacyTimezone || (existing.all_day ? "none" : null)), flags: 64 });
    return;
  }
  if (calendarType === "community" && action === "edittimezone" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!draft || !existing) { await interaction.update({ content: "That event edit expired.", components: [] }); return; }
    try {
      const timezone = interaction.values[0] === "none" ? "" : interaction.values[0];
      const parsed = parseManagerDraft({
        title: draft.title || existing.title,
        eventDate: draft.eventDate || existing.event_date,
        eventTime: draft.eventTime ?? (existing.all_day ? "" : eventLocalTime(existing)),
        timezone,
        description: draft.description ?? existing.description ?? "",
      }, calendarType);
      managerDrafts.set(draftKey(interaction, calendarType, eventId), { ...draft, ...parsed, existing, eventId });
      const savedChanges = applyRecurringChanges(interaction.guildId, existing, draft.scope || "this", { title: parsed.title, event_date: parsed.eventDate, event_at: parsed.eventAt, event_timezone: parsed.eventTimezone, timezone: parsed.timezone, link: parsed.link, description: parsed.description, all_day: parsed.allDay ? 1 : 0, member: existing.member || null, event_end_at: parsed.eventEndAt });
      const saved = savedChanges.find((item) => item.id === existing.id) || savedChanges[0];
      await interaction.update(youtifulEditPanel(saved));
      const oneOffSync = await updateOneOffCalendarSchedule(interaction.client, existing, saved, { syncDiscord: true });
      if (oneOffSync.handled && !oneOffSync.changed && existing.discord_event_id && !saved.all_day) await syncNativeScheduledEvent(interaction.client, saved).catch((error) => console.error("Linked Discord event sync after edit failed:", error));
      if (!oneOffSync.handled) {
        await syncChangedNativeEvents(interaction.client, savedChanges);
        refreshEventAnnouncementSchedules(interaction.guildId, savedChanges);
      }
      await refreshRecurringMonths(interaction.client, interaction.guildId, savedChanges).catch((refreshError) => console.error("Published calendar refresh after Edit Event failed:", refreshError));
    } catch (error) {
      await interaction.update({ content: error.message, components: editTimezoneComponents("community", "edittimezone", eventId, interaction.values[0]) });
    }
    return;
  }
  if (calendarType === "stray_kids" && action === "skzedittimezone" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!draft || !existing) { await interaction.update({ content: "That event edit expired.", components: [] }); return; }
    try {
      const timezone = interaction.values[0] === "none" ? "" : interaction.values[0];
      const parsed = parseManagerDraft({ ...draft, timezone }, calendarType);
      const saved = store.updateEvent(interaction.guildId, Number(eventId), {
        title: parsed.title,
        event_date: parsed.eventDate,
        event_at: parsed.eventAt,
        event_timezone: parsed.eventTimezone,
        timezone: parsed.timezone,
        event_location: parsed.eventLocation,
        link: parsed.link,
        description: parsed.description,
        all_day: parsed.allDay ? 1 : 0,
        event_end_at: parsed.eventEndAt,
      });
      managerDrafts.set(draftKey(interaction, calendarType, eventId), { ...parsed, eventId, existing: saved });
      const oneOffSync = await updateOneOffCalendarSchedule(interaction.client, existing, saved, { syncDiscord: true, refreshCalendar: false });
      if (oneOffSync.handled && !oneOffSync.changed && saved?.discord_event_id && !saved.all_day) await syncNativeScheduledEvent(interaction.client, saved).catch((error) => console.error("Linked Discord event sync after edit failed:", error));
      if (!oneOffSync.handled && saved?.discord_event_id && !saved.all_day) await syncNativeScheduledEvent(interaction.client, saved).catch((error) => console.error("Linked Discord event sync after edit failed:", error));
      await refreshEditedMonths(interaction.client, interaction.guildId, calendarType, existing.event_date, saved.event_date).catch((refreshError) => console.error("Published calendar refresh after Edit Event failed:", refreshError));
      await interaction.update({ content: "Choose a category for this event, or keep the current one.", components: editCategoryComponents(eventId, saved.category || existing.category || "other") });
    } catch (error) {
      await interaction.update({ content: error.message, components: editTimezoneComponents("stray_kids", "skzedittimezone", eventId, interaction.values[0]) });
    }
    return;
  }
  if (action === "editcategory" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, eventId));
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!draft || !existing) { await interaction.update({ content: "That event edit expired.", components: [] }); return; }
    const updated = store.updateEvent(interaction.guildId, Number(eventId), {
      title: draft.title,
      event_date: draft.eventDate,
      event_at: draft.eventAt,
      event_timezone: draft.eventTimezone,
      timezone: draft.timezone,
      event_location: draft.eventLocation,
      link: draft.link,
      description: draft.description,
      all_day: draft.allDay ? 1 : 0,
      event_end_at: draft.eventEndAt,
      category: interaction.values[0],
    });
    if (updated.discord_event_id && !updated.all_day) await syncNativeScheduledEvent(interaction.client, updated).catch((error) => console.error("Linked Discord event sync after edit failed:", error));
    if (calendarType === "stray_kids") {
      managerDrafts.set(draftKey(interaction, calendarType, eventId), { ...draft, existing, member: updated.member || null });
      await refreshEditedMonths(interaction.client, interaction.guildId, calendarType, existing.event_date, updated.event_date).catch((refreshError) => console.error("Published calendar refresh after category edit failed:", refreshError));
      await interaction.update({ content: "Choose an optional Stray Kids member, or keep the current one.", components: editMemberComponents(eventId, updated.member) });
    } else {
      managerDrafts.delete(draftKey(interaction, calendarType, eventId));
      await refreshEditedMonths(interaction.client, interaction.guildId, calendarType, existing.event_date, updated.event_date).catch((refreshError) => console.error("Published calendar refresh after category edit failed:", refreshError));
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
    if (calendarType === "community" && existing.recurrence_series_id) {
      await interaction.update({ content: "Apply description changes to:", components: recurrenceScopeMenu("description", existing.id, nativeHarmonySeries(existing)) });
    } else await interaction.showModal(managerModal(`harmony-manager:${calendarType}:descriptionmodal:${eventId}`, "Edit description", [{ id: "description", label: "Short description", maxLength: 300, paragraph: true, value: existing.description }]));
    return;
  }
  if (action === "descriptionmodal" && interaction.isModalSubmit()) {
    const existing = store.getEvent(interaction.guildId, Number(eventId));
    if (!existing || existing.calendar_type !== calendarType) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    const value = interaction.fields.getTextInputValue("description").trim() || null;
    const scope = parts[4] || "this";
    const changed = scope === "this" ? [store.updateEvent(interaction.guildId, Number(eventId), { description: value })] : applyRecurringChanges(interaction.guildId, existing, scope, { description: value });
    await refreshRecurringMonths(interaction.client, interaction.guildId, changed).catch(() => {});
    await interaction.reply({ content: `Updated the description for calendar event #${eventId}.`, flags: 64 });
    return;
  }
  if (action === "done" && interaction.isButton()) {
    await interaction.update({ content: "✅ Calendar event changes saved.", components: [] });
    return;
  }
  if (action === "cancelselect" && interaction.isStringSelectMenu()) {
    const selected = Number(interaction.values[0]);
    const event = store.getEvent(interaction.guildId, selected);
    if (!event || event.calendar_type !== calendarType) { await interaction.update({ content: "That event is no longer available.", components: [] }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: `Cancel **${event.title}** — choose the scope:`, components: recurrenceCancelButtons(selected) });
    else await interaction.update({ content: `Cancel **${event.title}**?`, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:cancelconfirm:${selected}`).setLabel("Confirm cancellation").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`harmony-manager:${calendarType}:cancelno`).setLabel("Keep event").setStyle(ButtonStyle.Secondary)
    )] });
    return;
  }
  if (action === "cancelscope" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(parts[4]));
    if (!event) { await interaction.update({ content: "That event is no longer active.", components: [] }); return; }
    const targets = await cancelHarmonyRecurringEvents({ guildId: interaction.guildId, event, scope: parts[3], cancelledBy: interaction.user.id, client: interaction.client, guild: interaction.guild });
    await interaction.update({ content: `Cancelled ${parts[3] === "series" ? "the entire series" : parts[3] === "future" ? "this and future occurrences" : "this occurrence"}.`, components: [] });
    return;
  }
  if (action === "cancelconfirm" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    const oneOff = await cancelHarmonyOneOffEvent({ guildId: interaction.guildId, eventId: Number(eventId), cancelledBy: interaction.user.id, client: interaction.client, guild: interaction.guild });
    let removed = oneOff.changed;
    if (!oneOff.handled) {
      removed = store.cancelEvent(interaction.guildId, Number(eventId), interaction.user.id);
      if (removed && event?.discord_event_id) await cancelLinkedNativeEvents(interaction, [event]);
      if (removed && event) await refreshPublishedCalendar(interaction.client, interaction.guildId, calendarType, event.event_date).catch(() => {});
    }
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
    const result = await cancelHarmonyOneOffEvent({ guildId: message.guild.id, eventId: Number(cancel[1]), cancelledBy: message.author.id, client: message.client, guild: message.guild });
    const removed = result.handled ? result.changed : store.cancelEvent(message.guild.id, Number(cancel[1]), message.author.id);
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
      const components = item.discord_event_id ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("View Event").setStyle(ButtonStyle.Link).setURL(`https://discord.com/events/${item.guild_id}/${item.discord_event_id}`)
      )] : [];
      const isCalendarReminder = /^@everyone\n✨ (?:Today!|Tomorrow!|\d+ (?:day|days|hour|hours) to go!)\n/.test(item.message || "");
      const botMember = channel.guild?.members?.me;
      const permissions = botMember && typeof channel.permissionsFor === "function" ? channel.permissionsFor(botMember) : null;
      if (isCalendarReminder && permissions && !permissions.has(PermissionFlagsBits.MentionEveryone)) throw new Error("Harmony is missing the Mention Everyone permission in the announcement channel.");
      const sent = await channel.send({
        content: [item.message, item.event_channel_id ? `Event channel: <#${item.event_channel_id}>` : null, item.link || null].filter(Boolean).join("\n"),
        components,
        allowedMentions: { parse: isCalendarReminder ? ["everyone"] : [] },
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
  syncDiscordRecurringSeriesWindow().catch((error) => console.error("Discord recurring series startup failed:", error));
  syncRecurringNativeEventWindow(client).catch((error) => console.error("Recurring native event startup failed:", error));
  const timer = setInterval(
    () => {
      processScheduledAnnouncements(client).catch((error) => console.error("Event scheduler failed:", error));
      processDiscordEventReminders(client).catch((error) => console.error("Discord event reminders failed:", error));
      syncDiscordRecurringSeriesWindow().catch((error) => console.error("Discord recurring series window failed:", error));
      syncRecurringNativeEventWindow(client).catch((error) => console.error("Recurring native event window failed:", error));
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
  isEventSchedulerInteraction,
  processScheduledAnnouncements,
  formatAnnouncementCountdown,
  normalizeCalendarAnnouncementBody,
  calendarAnnouncementMessage,
  calendarAnnouncementItems,
  syncDiscordRecurringSeries,
  syncDiscordRecurringSeriesWindow,
  syncRecurringNativeEventWindow,
  startEventScheduler,
  CALENDAR_CATEGORIES,
  CALENDAR_CATEGORY_LABELS,
  SKZOO_MEMBER_OPTIONS,
  SKZOO_MEMBER_EMOJIS,
  buildCalendarMessages,
  publishMonthlyCalendar,
  refreshPublishedCalendar,
  installScheduleManagers,
  refreshConfiguredScheduleManagers,
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
  calendarDateInTimezone,
  upcomingCalendarEvents,
  calendarCutoffBoundary,
  nativeCutoffDate,
  nativeDescriptionOccurrences,
  nativeSeriesOccurrences,
  SKZ_TIMEZONE_OPTIONS,
  buildYoutifulCalendarMessages,
  recurrenceOccurrences,
  createYoutifulOccurrences,
  applyRecurringChanges,
  cancelHarmonyRecurringEvents,
  cancellationConfirmationComponents,
  cancelHarmonyOneOffEvent,
  updateOneOffCalendarSchedule,
  updateLinkedOneOffCalendarSchedule,
  MAX_RECURRENCE_OCCURRENCES,
  RECURRENCE_TYPES,
  youtifulBirthdayEvents,
  interestedStateSupport,
  fetchInterestedMembers,
  scheduledEventLink,
  handleGuildScheduledEventCreate,
  handleGuildScheduledEventUpdate,
  handleGuildScheduledEventDelete,
  registerScheduledEventListeners,
  reconciliationPayload,
  reconciliationReviewPayload,
  markPendingNativeCreate,
  clearPendingNativeCreate,
  nativeCreateKey,
  markPendingNativeDelete,
  clearPendingNativeDelete,
  nativeDeleteKey,
  announcementChannelMenu,
  announcementEventIds,
  announcementEditorModal,
  sendImmediateCalendarAnnouncement,
  CALENDAR_ANNOUNCEMENT_OPTIONS,
  offerEventReminder,
  handleReminderInteraction,
  processDiscordEventReminders,
  addNativeEventToCalendar,
  submitCalendarCandidate,
  candidateReviewPayload,
  candidateNoticePayload,
  discoveredCandidatePickerPayload,
  nativeReconciliationPickerPayload,
  fetchExistingNativeEvents,
  beginNativeEventReconciliation,
};

