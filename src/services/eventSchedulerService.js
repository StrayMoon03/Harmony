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
const LOCATION_TIMEZONES = require("../data/locationTimezones.json");
const { randomUUID } = require("node:crypto");
const { MAX_RECURRENCE_OCCURRENCES, RECURRENCE_TYPES, normalizeRecurrenceRule, generateRecurringOccurrences } = require("./recurrenceService");

const CHECK_INTERVAL_MS = 30 * 1000;
const NATIVE_DELETE_MARKER_TTL_MS = 5 * 60 * 1000;
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
  { label: "Mexico City Time", value: "America/Mexico_City" },
  { label: "Korea Time", value: "Asia/Seoul" },
  { label: "Japan Time", value: "Asia/Tokyo" },
  { label: "No timezone (all-day)", value: "none" },
];
const SKZ_TIMEZONE_OPTIONS = [
  ...YOUTIFUL_TIMEZONE_OPTIONS.slice(0, -1),
  { label: "China / Beijing Time", value: "Asia/Shanghai" },
  YOUTIFUL_TIMEZONE_OPTIONS.at(-1),
];

function calendarLabel(calendarType) {
  return calendarType === "stray_kids" ? "STRAY KIDS" : "YOUTIFUL STAYS";
}

function managerPanelContent(calendarType) {
  const label = calendarLabel(calendarType);
  const icon = calendarType === "stray_kids" ? "⭐" : "❤️";
  return `${icon} **${label} SCHEDULE MANAGER**\nUse the private controls below to manage this calendar. Calendar events do not require an announcement.\nDiscord Scheduled Event reconciliation also requires Harmony to have **View Channel** permission for each associated voice or stage channel.`;
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

function recurrenceScopeMenu(action, eventId) {
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`harmony-manager:community:recurrencescope:${action}:${eventId}`).setPlaceholder("Apply changes to...").addOptions(
      { label: "This event", value: "this" },
      { label: "This and future events", value: "future" },
      { label: "Entire series", value: "series" },
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

function calendarAnnouncementItems(event, offsets) {
  if (event?.all_day) return [];
  const start = event?.event_at
    ? new Date(event.event_at)
    : event?.event_date && /^\d{4}-\d{2}-\d{2}$/.test(event.event_date)
      ? new Date(`${event.event_date}T09:00:00.000Z`)
      : null;
  if (!start || Number.isNaN(start.getTime())) return [];
  const now = Date.now();
  return [...new Set(offsets || [])].map(Number).filter((offset) => [3600, 86400, 259200, 604800].includes(offset)).map((offset) => ({
    scheduledFor: new Date(start.getTime() - offset * 1000).toISOString(),
    message: event.announcement_message || `📅 Reminder: **${event.title}**${event.event_channel_id ? ` in <#${event.event_channel_id}>` : ""} is coming up.`,
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
  const missing = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
    .filter((permission) => permissions && !permissions.has(permission));
  if (missing.length) {
    console.warn(`[scheduler-announcements] immediate-permission-denied event=${event?.id || "unknown"} channel=${channel.id || "unknown"} missing=${missing.join(",")}`);
    return false;
  }
  const components = event.discord_event_id ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("View Event").setStyle(ButtonStyle.Link).setURL(`https://discord.com/events/${guildId}/${event.discord_event_id}`))] : [];
  try {
    const sent = await channel.send({
      content: [message, event.event_channel_id ? `Event channel: <#${event.event_channel_id}>` : null].filter(Boolean).join("\n"),
      components,
      allowedMentions: { parse: [] },
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

function announcementTargets(guildId, event, scope) {
  const series = event.recurrence_series_id ? store.listSeriesEvents(guildId, event.recurrence_series_id) : [event];
  return scope === "series" ? series : scope === "future" ? series.filter((item) => Number(item.recurrence_index) >= Number(event.recurrence_index)) : [event];
}

async function beginCanonicalAnnouncementFlow(interaction, event, eventIds = [event.id]) {
  managerDrafts.set(draftKey(interaction, "community", `announce-${event.id}`), {
    eventIds,
    linked: Boolean(event.discord_event_id),
    title: event.title,
    editing: true,
  });
  await interaction.update({
    content: `Would you like to schedule announcements for **${event.title}**?`,
    components: announcementPrompt(event.id),
  });
}

function applyAnnouncementConfig(guildId, event, scope, offsets, channelId) {
  return announcementTargets(guildId, event, scope).map((item) => persistCalendarAnnouncements(guildId, item, offsets, channelId));
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
  const months = [...new Set(events.map((event) => monthKeyFromDate(event.event_date)).filter(Boolean))];
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

async function syncRecurringNativeEventWindow(client) {
  const now = new Date();
  const until = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
  const candidates = store.listRecurringNativeCandidates(now.toISOString(), until.toISOString(), 100);
  const linkedBySeries = new Map();
  for (const candidate of candidates) {
    const seriesKey = `${candidate.guild_id}:${candidate.recurrence_series_id}`;
    if (!linkedBySeries.has(seriesKey)) {
      const existing = store.listSeriesEvents(candidate.guild_id, candidate.recurrence_series_id);
      linkedBySeries.set(seriesKey, existing.filter((event) => event.discord_event_id).length);
    }
    const linked = linkedBySeries.get(seriesKey);
    if (linked >= 12) continue;
    const guild = client.guilds.cache.get(candidate.guild_id) || await client.guilds.fetch(candidate.guild_id).catch(() => null);
    if (!guild) continue;
    try {
      markPendingNativeCreate(candidate.guild_id, candidate.title, candidate.event_at);
      const created = await createNativeScheduledEvent(guild, { ...candidate, eventAt: candidate.event_at, eventEndAt: candidate.event_end_at }, candidate.event_channel_id);
      if (created?.id) {
        store.updateEvent(candidate.guild_id, candidate.id, { discord_event_id: created.id });
        linkedBySeries.set(seriesKey, linked + 1);
      } else clearPendingNativeCreate(candidate.guild_id, candidate.title, candidate.event_at);
    } catch (error) { console.error("Recurring native event window sync failed:", error); }
  }
}

function applyRecurringChanges(guildId, event, scope, changes) {
  const series = event.recurrence_series_id ? store.listSeriesEvents(guildId, event.recurrence_series_id) : [event];
  const eligible = scope === "series" ? series : scope === "future" ? series.filter((item) => Number(item.recurrence_index) >= Number(event.recurrence_index)) : [event];
  const updated = [];
  for (const item of eligible) {
    const next = { ...changes };
    if (scope !== "this" && item.id !== event.id) {
      delete next.event_date;
      delete next.event_at;
      delete next.event_end_at;
    }
    if (next.event_timezone && next.event_at && item.id !== event.id) {
      const localTime = eventLocalTime(event);
      const at = localToUtc(item.event_date, localTime, next.event_timezone);
      next.event_at = at ? at.toISOString() : item.event_at;
    }
    if (scope === "this" && item.recurrence_series_id) next.recurrence_exception = 1;
    updated.push(store.updateEvent(guildId, item.id, next));
  }
  return updated.filter(Boolean);
}

async function cancelRecurringEvents(interaction, event, scope) {
  const events = event.recurrence_series_id ? store.listSeriesEvents(interaction.guildId, event.recurrence_series_id) : [event];
  const targets = scope === "series" ? events : scope === "future" ? events.filter((item) => Number(item.recurrence_index) >= Number(event.recurrence_index)) : [event];
  for (const item of targets) {
    if (item.recurrence_series_id) store.cancelEvent(interaction.guildId, item.id, interaction.user.id);
    else store.cancelEvent(interaction.guildId, item.id, interaction.user.id);
  }
  return targets;
}

async function cancelLinkedNativeEvents(interaction, events) {
  for (const item of events) {
    if (!item.discord_event_id) continue;
    const native = interaction.guild?.scheduledEvents?.cache?.get(item.discord_event_id) || await interaction.guild?.scheduledEvents?.fetch(item.discord_event_id).catch(() => null);
    if (!native) continue;
    markPendingNativeDelete(interaction.guildId, item.discord_event_id);
    try {
      await native.edit({ status: GuildScheduledEventStatus.Canceled });
    } catch (error) {
      clearPendingNativeDelete(interaction.guildId, item.discord_event_id);
      console.error("Linked Discord event cancellation failed:", error);
    }
  }
}

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
  const dateLine = compactCalendarDate(date);
  const timeLabel = timestamp ? `<t:${timestamp}:t>` : "All Day";
  const icon = CALENDAR_CATEGORY_ICONS[event.category] || CALENDAR_CATEGORY_ICONS.other;
  const memberEmoji = calendarType === "stray_kids" ? (SKZOO_MEMBER_EMOJIS[event.member] || "") : "";
  const eventPrefix = memberEmoji ? `${memberEmoji} ` : "";
  const lines = [`${eventPrefix}${icon} ${dateLine} • ${timeLabel} • **${event.title}**`];
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
      description: null,
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
  const datePart = compactCalendarDate(date);
  const timePart = timestamp ? ` • <t:${timestamp}:t>` : " • All Day";
  const channelPart = event.event_channel_id ? ` • <#${event.event_channel_id}>` : "";
  const lines = [`${icon} ${datePart}${timePart} • **${event.title}**${channelPart}`];
  if (event.description) lines.push(event.description);
  if (event.discord_event_id) lines.push(`[View Discord Event](https://discord.com/events/${event.guild_id}/${event.discord_event_id})`);
  return lines.join("\n");
}

function compactCalendarDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return "Date pending";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${date}T00:00:00Z`));
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
  const payload = {
    name: event.title,
    scheduledStartTime: new Date(event.event_at),
    scheduledEndTime: nativeEventEndTime(event),
    description: event.description || undefined,
  };
  if (event.event_channel_id) {
    const channel = guild?.channels?.cache?.get(event.event_channel_id) || await guild?.channels?.fetch(event.event_channel_id).catch(() => null);
    payload.entityMetadata = { location: channel ? `#${channel.name}` : "Harmony calendar" };
  }
  await native.edit(payload);
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
    await dm.send({ content: `Would you like Harmony reminders for **${event.name}**? Choose any combination, or No reminders.`, components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`harmony-reminders:${event.id}`).setPlaceholder("Choose personal reminders").setMinValues(1).setMaxValues(3).addOptions(
        { label: "3 days before", value: "259200" },
        { label: "1 day before", value: "86400" },
        { label: "1 hour before", value: "3600" },
        { label: "No reminders", value: "none" },
      )
    )] });
  } catch { /* DMs are optional and must fail quietly. */ }
}

async function handleReminderInteraction(interaction) {
  const parts = interaction.customId.split(":");
  const discordEventId = parts[1];
  const selected = interaction.isStringSelectMenu?.() && parts[0] === "harmony-reminders"
    ? interaction.values
    : [parts[2]];
  const offsets = selected.includes("none") ? [] : selected.map(Number).filter((value) => [3600, 86400, 259200].includes(value));
  if (parts[0] === "harmony-reminder" && ![0, 3600, 86400].includes(Number(parts[2]))) return false;
  if (!offsets.length) store.cancelDiscordEventReminder(discordEventId, interaction.user.id);
  else {
    const event = Array.from(interaction.client.guilds.cache.values())
      .map((guild) => guild.scheduledEvents.cache.get(discordEventId))
      .find(Boolean);
    if (!event?.scheduledStartAt) { await interaction.update({ content: "That Discord event is no longer available.", components: [] }); return true; }
    const reminderTimes = offsets.map((offset) => ({ offset, remindAt: new Date(event.scheduledStartAt.getTime() - offset * 1000).toISOString() })).filter((item) => new Date(item.remindAt) > new Date());
    if (!reminderTimes.length) { await interaction.update({ content: "All selected reminder times have already passed.", components: [] }); return true; }
    store.saveDiscordEventReminder(event.guildId, discordEventId, interaction.user.id, reminderTimes.map((item) => item.offset), reminderTimes);
  }
  await interaction.update({ content: offsets.length ? `Saved ${offsets.length} personal Harmony reminder${offsets.length === 1 ? "" : "s"}.` : "No Harmony reminders will be sent.", components: [] });
  return true;
}

async function processDiscordEventReminders(client) {
  for (const reminder of store.dueDiscordEventReminders(new Date().toISOString())) {
    try {
      const user = await client.users.fetch(reminder.user_id);
      await user.send(`⏰ Harmony reminder: your Discord event starts soon. <https://discord.com/events/${reminder.guild_id}/${reminder.discord_event_id}>`);
      store.markDiscordEventReminderSent(reminder.discord_event_id, reminder.user_id, reminder.reminder_offset_seconds);
    } catch { store.markDiscordEventReminderSent(reminder.discord_event_id, reminder.user_id, reminder.reminder_offset_seconds); }
  }
}

async function fetchInterestedMembers(scheduledEvent) {
  if (!scheduledEvent?.fetchSubscribers) throw new Error("Discord Scheduled Event subscriber APIs are unavailable.");
  const subscribers = await scheduledEvent.fetchSubscribers({ withMember: true });
  return subscribers.map((entry) => entry.user || entry.member?.user || entry);
}

async function managerControlChannel(client, guildId) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const id = store.getReconciliationChannel(guildId);
  console.log(`[scheduler-reconciliation] configured-channel guild=${guildId} channel=${id || "none"} guild-resolved=${Boolean(guild)}`);
  if (!id || !guild) return null;
  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  console.log(`[scheduler-reconciliation] channel-resolved guild=${guildId} channel=${id} resolved=${Boolean(channel)} text-based=${Boolean(channel?.isTextBased?.())}`);
  return channel;
}

function scheduledEventCreatorLabel(event) {
  return event?.creator?.tag || event?.creator?.username || event?.creatorId || "Unavailable";
}

function scheduledEventDateLabel(event) {
  const start = event?.scheduledStartAt ? new Date(event.scheduledStartAt) : null;
  return start && !Number.isNaN(start.getTime()) ? `<t:${Math.floor(start.getTime() / 1000)}:F>` : "Date/time unavailable";
}

function candidateDateLabel(candidate) {
  if (candidate?.proposed_event_at) return `<t:${Math.floor(new Date(candidate.proposed_event_at).getTime() / 1000)}:F>`;
  return candidate?.proposed_event_date || "Not provided";
}

function candidateLocalTime(candidate) {
  if (!candidate?.proposed_event_at || !validTimezone(candidate.proposed_event_timezone)) return "";
  const date = new Date(candidate.proposed_event_at);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: candidate.proposed_event_timezone, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

function candidateReviewComponents(candidate, matches) {
  const components = [];
  if (matches.length) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-manager:candidate:link:${candidate.id}`).setLabel("Link Existing").setStyle(ButtonStyle.Primary),
  ));
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-manager:candidate:add:${candidate.id}`).setLabel("Add to Calendar").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`harmony-manager:candidate:dismiss:${candidate.id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
  ));
  return components;
}

function candidateReviewPayload(candidate, matches) {
  const details = [
    `**Potential Stray Kids event #${candidate.id}**`,
    `Source: ${candidate.source_url || "Not provided"}`,
    `Submitted by: ${candidate.submitter_id ? `<@${candidate.submitter_id}>` : "Unknown"}`,
    `Harmony extracted title: ${candidate.title || "Not available"}`,
    `Harmony extracted date/time: ${candidateDateLabel(candidate)}${candidate.proposed_event_timezone ? ` (${candidate.proposed_event_timezone})` : ""}`,
    `Source/provider: ${candidate.source_provider || "Not identified"}${candidate.source_metadata ? ` (${candidate.source_metadata})` : ""}`,
    `Still missing: ${[!candidate.title && "event title", !candidate.proposed_event_date && "event date", !candidate.proposed_event_at && "event time"].filter(Boolean).join(", ") || "nothing obvious"}`,
    `Note: ${candidate.submitted_note || "None"}`,
    matches.length ? `Likely calendar matches: ${matches.map((item) => `#${item.id} ${item.title}`).join(", ")}` : "Likely calendar matches: none",
    "Choose an action; no calendar event has been created yet.",
  ].join("\n");
  return { content: details, components: candidateReviewComponents(candidate, matches), flags: 64, allowedMentions: { parse: [] } };
}

function candidateNoticePayload(candidate) {
  return {
    content: `A possible Stray Kids calendar event was submitted.\nTitle: ${candidate.title || "Not provided"}\nDate/time: ${candidateDateLabel(candidate)}\nSource: ${candidate.source_url || "Not provided"}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`harmony-manager:candidate:review:${candidate.id}`).setLabel("Review Candidate").setStyle(ButtonStyle.Primary))],
    allowedMentions: { parse: [] },
  };
}

async function submitCalendarCandidate(client, input) {
  let enriched = {};
  if (input.sourceUrl) {
    const enrichment = await enrichCalendarCandidate(input.sourceUrl);
    enriched = enrichment.metadata || {};
  }
  const result = store.createOrGetCalendarCandidate({ ...input, ...enriched });
  if (result.duplicate) {
    if (result.candidate?.status === "open" && !result.candidate.notice_message_id && client) {
      const channel = await managerControlChannel(client, input.guildId);
      if (channel?.isTextBased?.() && typeof channel.send === "function") {
        try {
          const notice = await channel.send(candidateNoticePayload(result.candidate));
          store.saveCalendarCandidateNotice(input.guildId, result.candidate.id, notice?.id || null);
          return { ...result, notice, noticeSent: Boolean(notice) };
        } catch { /* Keep the durable candidate open for a later retry. */ }
      }
    }
    return { ...result, notice: null, noticeSent: false };
  }
  if (!client) return { ...result, notice: null, noticeSent: false };
  const channel = await managerControlChannel(client, input.guildId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") return { ...result, notice: null, noticeSent: false };
  try {
    const notice = await channel.send(candidateNoticePayload(result.candidate));
    store.saveCalendarCandidateNotice(input.guildId, result.candidate.id, notice?.id || null);
    return { ...result, notice, noticeSent: Boolean(notice) };
  } catch {
    return { ...result, notice: null, noticeSent: false };
  }
}

function reconciliationCandidateLabel(item) {
  const when = item.event_at
    ? new Intl.DateTimeFormat("en-US", { timeZone: item.event_timezone || item.timezone || "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(item.event_at))
    : `${item.event_date || "date pending"} • All Day`;
  return `${item.title} • ${when}`.slice(0, 100);
}

function reconciliationReviewComponents(event, candidates) {
  const components = [];
  if (candidates.length > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-manager:community:nativechoose:${event.id}`).setLabel("Link Existing").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`harmony-manager:community:nativeadd:${event.id}`).setLabel("Add to Calendar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`harmony-manager:community:nativedismiss:${event.id}`).setLabel("Ignore").setStyle(ButtonStyle.Secondary)
    ));
  } else if (candidates.length === 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-manager:community:linknative:${candidates[0].id}:${event.id}`).setLabel("Link Existing").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`harmony-manager:community:nativeadd:${event.id}`).setLabel("Add to Calendar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`harmony-manager:community:nativedismiss:${event.id}`).setLabel("Ignore").setStyle(ButtonStyle.Secondary)
    ));
  } else {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-manager:community:nativeadd:${event.id}`).setLabel("Add to Calendar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`harmony-manager:community:nativedismiss:${event.id}`).setLabel("Ignore").setStyle(ButtonStyle.Secondary)
    ));
  }
  return components;
}

function reconciliationCandidateSelector(event, candidates) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`harmony-manager:community:nativelinkselect:${event.id}`)
    .setPlaceholder("Choose the existing Harmony event")
    .addOptions(candidates.slice(0, 25).map((item) => ({ label: reconciliationCandidateLabel(item), value: String(item.id) }))));
}

function reconciliationPayload(event) {
  const content = [`A native Discord Scheduled Event **${event.name}** was found.`, `When: ${scheduledEventDateLabel(event)}`, `Created by: ${scheduledEventCreatorLabel(event)}`].join("\n");
  return { content, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`harmony-manager:community:reviewnative:${event.id}`).setLabel("Review Event").setStyle(ButtonStyle.Primary))], allowedMentions: { parse: [] } };
}

function reconciliationReviewPayload(event, candidates) {
  return {
    content: `${reconciliationPayload(event).content}\n\nChoose what Harmony should do with this event:`,
    components: reconciliationReviewComponents(event, candidates),
    flags: 64,
    allowedMentions: { parse: [] },
  };
}

async function disableReconciliationNotice(client, guildId, discordEventId) {
  const record = store.getDiscordEventReconciliation(guildId, discordEventId);
  if (!record?.notice_message_id) return;
  const channel = await managerControlChannel(client, guildId);
  if (!channel?.messages?.fetch) return;
  const notice = await channel.messages.fetch(record.notice_message_id).catch(() => null);
  if (notice?.edit) {
    await notice.edit({
      content: "✅ This Discord Scheduled Event has been reviewed.",
      components: [],
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

async function disableCandidateNotice(client, guildId, candidateId) {
  const candidate = store.getCalendarCandidate(guildId, candidateId);
  if (!candidate?.notice_message_id) return;
  const channel = await managerControlChannel(client, guildId);
  const notice = channel?.messages?.fetch ? await channel.messages.fetch(candidate.notice_message_id).catch(() => null) : null;
  if (notice?.edit) await notice.edit({
    content: "✅ This calendar candidate has been reviewed.",
    components: [],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

async function staleReconciliationInteraction(interaction, mode = "reply") {
  const payload = { content: "This Discord Scheduled Event has already been reviewed.", components: [], flags: 64 };
  if (mode === "update") {
    delete payload.flags;
    await interaction.update(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function handleGuildScheduledEventCreate(client, event) {
  if (!event?.guildId) {
    console.warn("[scheduler-reconciliation] create-ignored reason=missing-guild-or-event");
    return;
  }
  const key = `${event.guildId}:${event.id}`;
  if (reconciliationInProgress.has(key)) {
    console.log(`[scheduler-reconciliation] create-ignored guild=${event.guildId} event=${event.id} reason=reconciliation-in-progress`);
    return;
  }
  reconciliationInProgress.add(key);
  try {
    console.log(`[scheduler-reconciliation] create-received guild=${event.guildId} event=${event.id}`);
    if (store.getEventByDiscordId(event.guildId, event.id)) {
      console.log(`[scheduler-reconciliation] create-ignored guild=${event.guildId} event=${event.id} reason=linked`);
      return;
    }
    if (pendingNativeCreates.has(nativeCreateKey(event.guildId, event.name, event.scheduledStartAt))) {
      console.log(`[scheduler-reconciliation] create-ignored guild=${event.guildId} event=${event.id} reason=pending-harmony-create`);
      return;
    }
    if (store.getDiscordEventReconciliation(event.guildId, event.id)) {
      console.log(`[scheduler-reconciliation] create-ignored guild=${event.guildId} event=${event.id} reason=already-reconciled`);
      return;
    }
    const candidates = store.listUnlinkedCommunityEvents(event.guildId).filter((item) => item.title === event.name);
    console.log(`[scheduler-reconciliation] payload-built guild=${event.guildId} event=${event.id} candidates=${candidates.length}`);
    const channel = await managerControlChannel(client, event.guildId);
    if (!channel?.isTextBased()) {
      console.warn(`[scheduler-reconciliation] create-stopped guild=${event.guildId} event=${event.id} reason=channel-unavailable`);
      return;
    }
    console.log(`[scheduler-reconciliation] send-attempt guild=${event.guildId} event=${event.id} channel=${store.getReconciliationChannel(event.guildId)}`);
    let sent;
    try {
      sent = await channel.send(reconciliationPayload(event));
    } catch (error) {
      console.error(`[scheduler-reconciliation] send-failed guild=${event.guildId} event=${event.id} channel=${store.getReconciliationChannel(event.guildId)}:`, error);
      throw error;
    }
    store.saveDiscordEventReconciliation(event.guildId, event.id, sent?.id || null, "open");
    console.log(`[scheduler-reconciliation] send-succeeded guild=${event.guildId} event=${event.id} channel=${store.getReconciliationChannel(event.guildId)} message=${sent?.id || "unknown"}`);
  } finally {
    reconciliationInProgress.delete(key);
  }
}

/**
 * Register native Discord Scheduled Event listeners in one place. Keeping the
 * wiring here makes the production path and the integration test path use the
 * same discord.js event constants and handler signatures.
 */
function registerScheduledEventListeners(client) {
  console.log(`[scheduler-reconciliation] listeners-registered create=${Events.GuildScheduledEventCreate} update=${Events.GuildScheduledEventUpdate} delete=${Events.GuildScheduledEventDelete} intents=${client.options?.intents?.bitfield ?? "unknown"}`);
  client.on(Events.GuildScheduledEventCreate, (event) => {
    return handleGuildScheduledEventCreate(client, event).catch((error) =>
      console.error(`Scheduled event create sync failed for ${event?.id || "unknown"}:`, error)
    );
  });
  client.on(Events.GuildScheduledEventUpdate, (oldEvent, event) => {
    return handleGuildScheduledEventUpdate(client, oldEvent, event).catch((error) =>
      console.error(`Scheduled event update sync failed for ${event?.id || "unknown"}:`, error)
    );
  });
  client.on(Events.GuildScheduledEventDelete, (event) => {
    return handleGuildScheduledEventDelete(client, event).catch((error) =>
      console.error(`Scheduled event delete sync failed for ${event?.id || "unknown"}:`, error)
    );
  });
  return client;
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
  const harmonyInitiated = consumePendingNativeDelete(event.guildId, event.id);
  store.updateEvent(event.guildId, linked.id, { discord_event_id: null });
  if (harmonyInitiated) return;
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
  if (customId.startsWith("harmony-reminder:") || customId.startsWith("harmony-reminders:")) return handleReminderInteraction(interaction);
  if (customId.startsWith("harmony-manager:")) {
    try {
      await handleManagerInteraction(interaction);
    } catch (error) {
      console.error("Schedule Manager interaction failed:", error);
      const payload = { content: "Harmony could not complete that scheduler action. Please try again.", flags: 64 };
      if (!interaction.replied && !interaction.deferred) await interaction.reply(payload).catch((replyError) => console.error("Could not acknowledge Schedule Manager failure:", replyError));
      else await interaction.followUp(payload).catch((followUpError) => console.error("Could not report Schedule Manager failure:", followUpError));
    }
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
  if (parts[1] === "candidate") {
    const action = parts[2];
    const candidateId = Number(parts[3]);
    const candidate = store.getCalendarCandidate(interaction.guildId, candidateId);
    if (!candidate || candidate.status !== "open") {
      await interaction.reply({ content: "This calendar candidate has already been reviewed.", flags: 64 });
      return;
    }
    const matches = store.findCandidateCalendarMatches(interaction.guildId, candidate);
    if (action === "review" && interaction.isButton()) {
      await interaction.reply(candidateReviewPayload(candidate, matches));
      return;
    }
    if (action === "dismiss" && interaction.isButton()) {
      if (!store.claimCalendarCandidate(interaction.guildId, candidateId)) {
        await interaction.reply({ content: "This calendar candidate has already been reviewed.", flags: 64 });
        return;
      }
      store.decideCalendarCandidate(interaction.guildId, candidateId, "dismissed", interaction.user.id, "Dismissed by admin");
      await disableCandidateNotice(interaction.client, interaction.guildId, candidateId);
      await interaction.update({ content: "Dismissed this candidate. No calendar event was created.", components: [] });
      return;
    }
    if (action === "link" && interaction.isButton()) {
      if (!matches.length) {
        await interaction.update({ content: "No likely Harmony calendar match is available. Choose Add to Calendar to enter the missing event details, or Dismiss.", components: candidateReviewComponents(candidate, []) });
        return;
      }
      if (matches.length === 1) {
        if (!store.claimCalendarCandidate(interaction.guildId, candidateId)) { await staleReconciliationInteraction(interaction, "update"); return; }
        store.decideCalendarCandidate(interaction.guildId, candidateId, "linked", interaction.user.id, "Linked to existing calendar event", matches[0].id);
        await disableCandidateNotice(interaction.client, interaction.guildId, candidateId);
        await interaction.update({ content: `Linked this candidate to **${matches[0].title}**. No new calendar event was created.`, components: [] });
        return;
      }
      await interaction.update({
        content: `${candidateReviewPayload(candidate, matches).content}\n\nChoose the existing Harmony event to link:`,
        components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
          .setCustomId(`harmony-manager:candidate:linkselect:${candidateId}`)
          .setPlaceholder("Choose the existing Harmony event")
          .addOptions(matches.slice(0, 25).map((item) => ({ label: `${item.title} • ${item.event_date || "date pending"}`.slice(0, 100), value: String(item.id) }))))],
      });
      return;
    }
    if (action === "linkselect" && interaction.isStringSelectMenu()) {
      if (!store.claimCalendarCandidate(interaction.guildId, candidateId)) { await staleReconciliationInteraction(interaction, "update"); return; }
      const event = store.getEvent(interaction.guildId, Number(interaction.values[0]));
      if (!event) { store.releaseCalendarCandidate(interaction.guildId, candidateId, "Selected calendar event was unavailable"); await interaction.update({ content: "That Harmony event is no longer active.", components: [] }); return; }
      store.decideCalendarCandidate(interaction.guildId, candidateId, "linked", interaction.user.id, "Linked to existing calendar event", event.id);
      await disableCandidateNotice(interaction.client, interaction.guildId, candidateId);
      await interaction.update({ content: `Linked this candidate to **${event.title}**. No new calendar event was created.`, components: [] });
      return;
    }
    if (action === "add" && interaction.isButton()) {
      const modal = new ModalBuilder().setCustomId(`harmony-manager:candidate:addmodal:${candidateId}`).setTitle("Add candidate to Stray Kids calendar");
      const fields = [
        ["title", "Event title", candidate.title || "", true, 120],
        ["event-date", "Event date YYYY-MM-DD", candidate.proposed_event_date || "", true, 10],
        ["event-time", "Event time HH:MM (blank = all-day)", candidateLocalTime(candidate), false, 5],
        ["event-timezone", "Event timezone", candidate.proposed_event_timezone || "America/New_York", true, 80],
        ["description", "Details (optional)", candidate.submitted_note || "", false, 500],
      ];
      modal.addComponents(fields.map(([id, label, value, required, maxLength]) => {
        const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(id === "description" ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(required).setMaxLength(maxLength);
        if (value) input.setValue(value.slice(0, maxLength));
        return new ActionRowBuilder().addComponents(input);
      }));
      await interaction.showModal(modal);
      return;
    }
    if (action === "addmodal" && interaction.isModalSubmit()) {
      const title = interaction.fields.getTextInputValue("title").trim();
      const eventDate = interaction.fields.getTextInputValue("event-date").trim();
      const eventTime = interaction.fields.getTextInputValue("event-time").trim();
      const eventTimezone = interaction.fields.getTextInputValue("event-timezone").trim();
      const description = interaction.fields.getTextInputValue("description").trim() || null;
      if (!parseManagerDate(eventDate) || !validTimezone(eventTimezone) || (eventTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(eventTime))) {
        await interaction.reply({ content: "Provide a valid event date, optional 24-hour time, and timezone.", flags: 64 });
        return;
      }
      if (!store.claimCalendarCandidate(interaction.guildId, candidateId)) { await interaction.reply({ content: "This calendar candidate has already been reviewed.", flags: 64 }); return; }
      try {
        const settings = store.getCalendarChannels(interaction.guildId) || {};
        const eventAt = eventTime ? localToUtc(eventDate, eventTime, eventTimezone) : null;
        if (eventTime && !eventAt) throw new Error("That event date or time is invalid.");
        const eventId = store.createCalendarEvent({ guildId: interaction.guildId, calendarChannelId: settings.stray_kids_channel_id || null, title, link: candidate.source_url || "", timezone: eventTimezone, eventAt: eventAt?.toISOString() || null, eventDate, eventTimezone, calendarType: "stray_kids", category: "other", allDay: !eventTime, description, createdBy: interaction.user.id });
        store.decideCalendarCandidate(interaction.guildId, candidateId, "added", interaction.user.id, "Added to Stray Kids calendar", eventId);
        await disableCandidateNotice(interaction.client, interaction.guildId, candidateId);
        await refreshPublishedCalendar(interaction.client, interaction.guildId, "stray_kids", eventDate).catch(() => {});
        await interaction.reply({ content: `Added **${title}** to the Stray Kids calendar. No announcements were created; configure them through the existing calendar workflow if needed.`, flags: 64 });
      } catch (error) {
        store.releaseCalendarCandidate(interaction.guildId, candidateId, `Add failed: ${error.message}`);
        await interaction.reply({ content: error.message || "Harmony could not add that candidate.", flags: 64 });
      }
      return;
    }
    return;
  }
  const calendarType = managerCalendarType(parts[1]);
  const action = parts[2];
  const eventId = parts[3];
  if (!calendarType) {
    await interaction.reply({ content: "That calendar manager is no longer available.", flags: 64 });
    return;
  }
  const settings = store.getCalendarChannels(interaction.guildId) || {};
  const calendarChannelId = calendarType === "stray_kids" ? settings.stray_kids_channel_id : settings.community_channel_id;

  if (calendarType === "community" && action === "reviewnative" && interaction.isButton()) {
    const reconciliation = store.getDiscordEventReconciliation(interaction.guildId, eventId);
    if (!reconciliation || reconciliation.status !== "open") {
      await staleReconciliationInteraction(interaction);
      return;
    }
    let native;
    try {
      native = await interaction.guild?.scheduledEvents?.fetch(eventId);
    } catch {
      native = null;
    }
    if (!native) {
      await interaction.reply({ content: "That Discord Scheduled Event is no longer available.", flags: 64 });
      return;
    }
    const candidates = store.listUnlinkedCommunityEvents(interaction.guildId).filter((item) => item.title === native.name);
    await interaction.reply(reconciliationReviewPayload(native, candidates));
    return;
  }

  if (calendarType === "community" && action === "nativechoose" && interaction.isButton()) {
    const reconciliation = store.getDiscordEventReconciliation(interaction.guildId, eventId);
    if (!reconciliation || reconciliation.status !== "open") {
      await staleReconciliationInteraction(interaction, "update");
      return;
    }
    let native;
    try {
      native = await interaction.guild?.scheduledEvents?.fetch(eventId);
    } catch {
      native = null;
    }
    if (!native) {
      await interaction.update({ content: "That Discord Scheduled Event is no longer available.", components: [] });
      return;
    }
    const candidates = store.listUnlinkedCommunityEvents(interaction.guildId).filter((item) => item.title === native.name);
    if (candidates.length < 2) {
      if (candidates.length === 1) {
        await interaction.update({ content: "That event now has one available Harmony match. Choose Link Existing again to link it.", components: reconciliationReviewComponents(native, candidates) });
      } else {
        await interaction.update({ content: "No existing Harmony event matches this Discord event. Choose Add to Calendar or Ignore.", components: reconciliationReviewComponents(native, candidates) });
      }
      return;
    }
    await interaction.update({ content: `${reconciliationPayload(native).content}\n\nChoose the existing Harmony event to link:`, components: [reconciliationCandidateSelector(native, candidates)] });
    return;
  }

  if (calendarType === "community" && action === "nativelinkselect" && interaction.isStringSelectMenu()) {
    if (!store.claimDiscordEventReconciliation(interaction.guildId, eventId)) { await staleReconciliationInteraction(interaction, "update"); return; }
    const linked = store.getEvent(interaction.guildId, Number(interaction.values[0]));
    if (!linked) { store.saveDiscordEventReconciliation(interaction.guildId, eventId, null, "open"); await interaction.update({ content: "That Harmony event is no longer active.", components: [] }); return; }
    const nativeId = eventId;
    if (store.getEventByDiscordId(interaction.guildId, nativeId)) { store.saveDiscordEventReconciliation(interaction.guildId, eventId, null, "linked"); await interaction.update({ content: "That native event is already linked.", components: [] }); return; }
    store.updateEvent(interaction.guildId, linked.id, { discord_event_id: nativeId });
    store.saveDiscordEventReconciliation(interaction.guildId, nativeId, null, "linked");
    await disableReconciliationNotice(interaction.client, interaction.guildId, nativeId);
    managerDrafts.set(draftKey(interaction, calendarType, `announce-${linked.id}`), { eventIds: [linked.id], linked: true, title: linked.title });
    await interaction.update({ content: `Linked the native event to **${linked.title}**. Would you like to schedule announcements for this event?`, components: announcementPrompt(linked.id) });
    return;
  }
  if (calendarType === "community" && action === "nativeadd" && interaction.isButton()) {
    if (!store.claimDiscordEventReconciliation(interaction.guildId, eventId)) { await staleReconciliationInteraction(interaction, "update"); return; }
    try {
      const added = await addNativeEventToCalendar(interaction, eventId);
      store.saveDiscordEventReconciliation(interaction.guildId, eventId, null, "added");
      await disableReconciliationNotice(interaction.client, interaction.guildId, eventId);
      managerDrafts.set(draftKey(interaction, calendarType, `announce-${added.id}`), { eventIds: [added.id], linked: true, title: added.title });
      await interaction.update({ content: `Added **${added.title}** to the Youtiful Stays calendar. Would you like to schedule announcements for this event?`, components: announcementPrompt(added.id) });
      await refreshPublishedCalendar(interaction.client, interaction.guildId, "community", added.event_date).catch(() => {});
    } catch (error) { store.saveDiscordEventReconciliation(interaction.guildId, eventId, null, "open"); await interaction.update({ content: error.message, components: [] }); }
    return;
  }
  if (calendarType === "community" && action === "linknative" && interaction.isButton()) {
    const nativeId = parts[4];
    if (!store.claimDiscordEventReconciliation(interaction.guildId, nativeId)) { await staleReconciliationInteraction(interaction, "update"); return; }
    const linked = store.getEvent(interaction.guildId, Number(eventId));
    if (!linked) { store.saveDiscordEventReconciliation(interaction.guildId, nativeId, null, "open"); await interaction.update({ content: "That Harmony event is no longer active.", components: [] }); return; }
    if (store.getEventByDiscordId(interaction.guildId, nativeId)) { store.saveDiscordEventReconciliation(interaction.guildId, nativeId, null, "linked"); await interaction.update({ content: "That native event is already linked.", components: [] }); return; }
    store.updateEvent(interaction.guildId, linked.id, { discord_event_id: nativeId });
    store.saveDiscordEventReconciliation(interaction.guildId, nativeId, null, "linked");
    await disableReconciliationNotice(interaction.client, interaction.guildId, nativeId);
    managerDrafts.set(draftKey(interaction, calendarType, `announce-${linked.id}`), { eventIds: [linked.id], linked: true, title: linked.title });
    await interaction.update({ content: `Linked the native Discord event to **${linked.title}**. Would you like to schedule announcements for this event?`, components: announcementPrompt(linked.id) });
    return;
  }
  if (calendarType === "community" && action === "keepnative" && interaction.isButton()) {
    if (!store.claimDiscordEventReconciliation(interaction.guildId, eventId)) { await staleReconciliationInteraction(interaction, "update"); return; }
    store.saveDiscordEventReconciliation(interaction.guildId, eventId, null, "dismissed");
    await disableReconciliationNotice(interaction.client, interaction.guildId, eventId);
    await interaction.update({ content: "Kept the native Discord event separate from Harmony.", components: [] });
    return;
  }
  if (calendarType === "community" && action === "nativedismiss" && interaction.isButton()) {
    if (!store.claimDiscordEventReconciliation(interaction.guildId, eventId)) { await staleReconciliationInteraction(interaction, "update"); return; }
    store.saveDiscordEventReconciliation(interaction.guildId, eventId, null, "dismissed");
    await disableReconciliationNotice(interaction.client, interaction.guildId, eventId);
    await interaction.update({ content: "Dismissed this reconciliation notice. The native Discord event was left unchanged.", components: [] });
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
    await interaction.update({ content: "Does this event repeat?", components: recurrenceMenu() });
    return;
  }
  if (calendarType === "community" && action === "ysrecurrence" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.update({ content: "That event draft expired. Please start again.", components: [] }); return; }
    const type = interaction.values[0];
    if (!RECURRENCE_TYPES.includes(type)) { await interaction.update({ content: "That recurrence option is no longer available.", components: [] }); return; }
    if (type === "none") {
      managerDrafts.set(draftKey(interaction, calendarType), { ...draft, recurrenceRule: { type: "none" } });
      await interaction.update({ content: "Create a native Discord Scheduled Event too?", components: nativeEventMenu() });
    } else {
      managerDrafts.set(draftKey(interaction, calendarType), { ...draft, recurrenceType: type });
      await interaction.showModal(managerModal("harmony-manager:community:ysrecurrenceconfig", "Recurring event", recurrenceConfigFields(type)));
    }
    return;
  }
  if (calendarType === "community" && action === "ysrecurrenceconfig" && interaction.isModalSubmit()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.reply({ content: "That event draft expired. Please start again.", flags: 64 }); return; }
    try {
      const readOptionalField = (id) => {
        const modalFields = interaction.fields?.fields;
        if (modalFields && typeof modalFields.has === "function" && !modalFields.has(id)) return "";
        return interaction.fields.getTextInputValue(id);
      };
      const recurrenceRule = normalizeRecurrenceRule({
        type: draft.recurrenceType,
        interval: draft.recurrenceType === "custom" ? readOptionalField("recurrence-interval") : "",
        weekdays: draft.recurrenceType === "custom" ? readOptionalField("recurrence-weekdays") : "",
        endDate: readOptionalField("recurrence-end-date"),
        count: readOptionalField("recurrence-end-count"),
      }, draft.eventDate);
      generateRecurringOccurrences({ startDate: draft.eventDate, startTime: draft.eventTime, timezone: draft.eventTimezone, rule: recurrenceRule, localToUtc });
      managerDrafts.set(draftKey(interaction, calendarType), { ...draft, recurrenceRule });
      await interaction.reply({ content: "Create a native Discord Scheduled Event too?", components: nativeEventMenu(), flags: 64 });
    } catch (error) { await interaction.reply({ content: error.message, flags: 64 }); }
    return;
  }
  // Announcement configuration is post-creation only. The native-event
  // decision above must be the next step after recurrence configuration.
  if (calendarType === "community" && action === "ysnative" && interaction.isButton()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType));
    if (!draft) { await interaction.update({ content: "That event draft expired. Please start again.", components: [] }); return; }
    try {
      const savedSeries = createYoutifulOccurrences(interaction.guildId, calendarChannelId, draft, interaction.user.id);
      const createdEvents = savedSeries.occurrences;
      let nativeId = null;
      let nativeWarning = "";
      if (createdEvents.length && interaction.customId.endsWith(":yes") && !draft.allDay) {
        try {
          if (savedSeries.seriesId) {
            for (const event of createdEvents) store.updateEvent(interaction.guildId, event.id, { recurrence_native_enabled: 1 });
          }
          for (const event of createdEvents.slice(0, 12)) {
            markPendingNativeCreate(interaction.guildId, event.title, event.event_at);
            const created = await createNativeScheduledEvent(interaction.guild, { ...draft, eventAt: event.event_at, eventEndAt: event.event_end_at, title: event.title, description: event.description }, event.event_channel_id);
            if (created?.id) {
              nativeId = nativeId || created.id;
              store.updateEvent(interaction.guildId, event.id, { discord_event_id: created.id });
            } else clearPendingNativeCreate(interaction.guildId, event.title, event.event_at);
          }
          if (createdEvents.length > 12) nativeWarning = " Native events were created for the first 12 upcoming occurrences; Harmony still owns the complete series.";
        } catch (error) { nativeWarning = ` Native event not created: ${error.message}`; }
      } else if (interaction.customId.endsWith(":yes") && draft.allDay) nativeWarning = " All-day events remain Harmony-only.";
      managerDrafts.set(draftKey(interaction, calendarType, `announce-${createdEvents[0]?.id || "none"}`), {
        eventIds: createdEvents.map((event) => event.id),
        linked: Boolean(nativeId),
        nativeWarning,
        title: draft.title,
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
    const modal = new ModalBuilder().setCustomId(`harmony-manager:community:ysannouncemodal:${eventId}`).setTitle("Schedule event announcements");
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("announcement-message").setLabel("Announcement message").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1800)));
    await interaction.showModal(modal);
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
    managerDrafts.set(draftKey(interaction, calendarType, `announce-${eventId}`), { ...draft, announcementMessage: interaction.fields.getTextInputValue("announcement-message").trim() });
    await interaction.reply({ content: "Choose the separate announcement channel.", components: announcementChannelMenu("ysannouncechannel", eventId), flags: 64 });
    return;
  }
  if (calendarType === "community" && action === "ysannouncechannel" && interaction.isChannelSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, `announce-${eventId}`));
    if (!draft) { await interaction.update({ content: "That announcement setup expired. The event was saved successfully.", components: [] }); return; }
    managerDrafts.set(draftKey(interaction, calendarType, `announce-${eventId}`), { ...draft, announcementChannelId: interaction.values[0] });
    await interaction.update({ content: "Choose one or more announcement timings.", components: announcementTimingMenu("ysannouncetiming", eventId) });
    return;
  }
  if (calendarType === "community" && action === "ysannouncetiming" && interaction.isStringSelectMenu()) {
    const draft = managerDrafts.get(draftKey(interaction, calendarType, `announce-${eventId}`));
    if (!draft) { await interaction.update({ content: "That announcement setup expired. The event was saved successfully.", components: [] }); return; }
    const eventIds = draft.eventIds || [Number(eventId)];
    const editing = Boolean(draft.editing);
    const selected = interaction.values.includes("none") ? [] : interaction.values;
    const first = store.getEvent(interaction.guildId, eventIds[0]);
    if (!first) { await interaction.update({ content: "The event is no longer active.", components: [] }); return; }
    const offsets = selected.filter((value) => value !== "now").map(Number).filter((value) => [3600, 86400, 259200, 604800].includes(value));
    console.log(`[scheduler-announcements] timing-submit guild=${interaction.guildId} eventIds=${eventIds.join(",")} selected=${selected.join(",")} channel=${draft.announcementChannelId}`);
    let immediatePosted = false;
    let immediateFailed = false;
    let immediateAttempted = false;
    for (const id of eventIds) {
      const event = store.getEvent(interaction.guildId, id);
      if (!event) continue;
      const items = calendarAnnouncementItems({ ...event, announcement_message: draft.announcementMessage }, offsets);
      store.saveEventAnnouncements(interaction.guildId, event.id, draft.announcementChannelId, offsets, items, draft.announcementMessage);
      if (selected.includes("now") && !immediateAttempted) {
        immediateAttempted = true;
        const channel = interaction.guild?.channels?.cache?.get(draft.announcementChannelId) || await interaction.guild?.channels?.fetch(draft.announcementChannelId).catch(() => null);
        immediatePosted = await sendImmediateCalendarAnnouncement(channel, event, interaction.guildId, draft.announcementMessage);
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
    else if (target === "announcements") {
      const targets = announcementTargets(interaction.guildId, event, interaction.values[0]);
      managerDrafts.delete(draftKey(interaction, calendarType, event.id));
      await beginCanonicalAnnouncementFlow(interaction, event, targets.map((item) => item.id));
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
        if (saved.discord_event_id && !saved.all_day) await syncNativeScheduledEvent(interaction.client, saved).catch((error) => console.error("Linked Discord event sync after edit failed:", error));
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
    if (event.recurrence_series_id) await interaction.update({ content: "Apply announcement changes to:", components: recurrenceScopeMenu("announcements", event.id) });
    else {
      managerDrafts.delete(draftKey(interaction, calendarType, event.id));
      await beginCanonicalAnnouncementFlow(interaction, event);
    }
    return;
  }
  if (calendarType === "community" && action === "editdetails" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: "Apply Details changes to:", components: recurrenceScopeMenu("details", event.id) });
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
      const draftState = managerDrafts.get(draftKey(interaction, calendarType, eventId));
      const changed = applyRecurringChanges(interaction.guildId, existing, draftState?.scope || "this", {
        title: parsed.title, event_date: parsed.eventDate, event_at: parsed.eventAt,
        event_timezone: parsed.eventTimezone, timezone: parsed.timezone, link: parsed.link,
        description: parsed.description, all_day: parsed.allDay ? 1 : 0, event_end_at: parsed.eventEndAt,
      });
      const saved = changed.find((item) => item.id === existing.id) || changed[0];
      await interaction.reply({ ...youtifulEditPanel(saved), flags: 64 });
      await syncChangedNativeEvents(interaction.client, changed);
      refreshEventAnnouncementSchedules(interaction.guildId, changed);
      await refreshRecurringMonths(interaction.client, interaction.guildId, changed).catch((error) => console.error("Calendar refresh after details edit failed:", error));
    } catch (error) { await interaction.reply({ content: error.message, flags: 64 }); }
    return;
  }
  if (calendarType === "community" && action === "edittzpick" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: "Apply Time Zone changes to:", components: recurrenceScopeMenu("timezone", event.id) });
    else await interaction.update({ content: "Choose the event time zone, or keep the current one.", components: editTimezoneComponents("community", "edittimezone", eventId, event.event_timezone || event.timezone || (event.all_day ? "none" : null)) });
    return;
  }
  if (calendarType === "community" && action === "edittypepick" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    if (!event) { await interaction.reply({ content: "That event is no longer available.", flags: 64 }); return; }
    if (event.recurrence_series_id) await interaction.update({ content: "Apply Icon / Type changes to:", components: recurrenceScopeMenu("type", event.id) });
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
    if (event.recurrence_series_id) await interaction.update({ content: "Apply Channel changes to:", components: recurrenceScopeMenu("channel", event.id) });
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
      await syncChangedNativeEvents(interaction.client, savedChanges);
      refreshEventAnnouncementSchedules(interaction.guildId, savedChanges);
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
      if (saved?.discord_event_id && !saved.all_day) await syncNativeScheduledEvent(interaction.client, saved).catch((error) => console.error("Linked Discord event sync after edit failed:", error));
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
    const targets = await cancelRecurringEvents(interaction, event, parts[3]);
    await interaction.update({ content: `Cancelled ${parts[3] === "series" ? "the entire series" : parts[3] === "future" ? "this and future occurrences" : "this occurrence"}.`, components: [] });
    await cancelLinkedNativeEvents(interaction, targets);
    await refreshRecurringMonths(interaction.client, interaction.guildId, targets).catch((error) => console.error("Calendar refresh after recurring cancellation failed:", error));
    return;
  }
  if (action === "cancelconfirm" && interaction.isButton()) {
    const event = store.getEvent(interaction.guildId, Number(eventId));
    const removed = store.cancelEvent(interaction.guildId, Number(eventId), interaction.user.id);
    if (removed && event?.discord_event_id) await cancelLinkedNativeEvents(interaction, [event]);
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
      const components = item.discord_event_id ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("View Event").setStyle(ButtonStyle.Link).setURL(`https://discord.com/events/${item.guild_id}/${item.discord_event_id}`)
      )] : [];
      const sent = await channel.send({
        content: [item.message, item.event_channel_id ? `Event channel: <#${item.event_channel_id}>` : null, item.link || null].filter(Boolean).join("\n"),
        components,
        allowedMentions: { parse: [] },
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
  syncRecurringNativeEventWindow(client).catch((error) => console.error("Recurring native event startup failed:", error));
  const timer = setInterval(
    () => {
      processScheduledAnnouncements(client).catch((error) => console.error("Event scheduler failed:", error));
      processDiscordEventReminders(client).catch((error) => console.error("Discord event reminders failed:", error));
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
  SKZ_TIMEZONE_OPTIONS,
  buildYoutifulCalendarMessages,
  recurrenceOccurrences,
  createYoutifulOccurrences,
  applyRecurringChanges,
  cancelRecurringEvents,
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
  sendImmediateCalendarAnnouncement,
  CALENDAR_ANNOUNCEMENT_OPTIONS,
  offerEventReminder,
  handleReminderInteraction,
  processDiscordEventReminders,
  addNativeEventToCalendar,
  submitCalendarCandidate,
  candidateReviewPayload,
  candidateNoticePayload,
};
