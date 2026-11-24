"use strict";
function localDate(now, timezone) {
  if (typeof timezone !== "string" || !timezone.trim())
    throw Error("Enter a valid venue time zone");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function dayIndex(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw Error("Invalid concert date");
  const ms = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date)
    throw Error("Invalid concert date");
  return ms / 86400000;
}
function concertState(date, today) {
  const days = dayIndex(date) - dayIndex(today);
  if (days < 0)
    return {
      state: "completed",
      days: 0,
      label: "THANK YOU FOR THE MEMORIES!",
    };
  if (days === 0)
    return { state: "today", days: 0, label: "IT'S D-DAY, STAY!" };
  if (days === 1) return { state: "tomorrow", days: 1, label: "TOMORROW!" };
  return { state: "upcoming", days, label: "DAYS TO GO" };
}
function validateConfig(config, events) {
  for (const [key, max] of [
    ["city", 80],
    ["country", 80],
    ["venue", 120],
  ])
    if (
      typeof config[key] !== "string" ||
      !config[key].trim() ||
      config[key].length > max
    )
      throw Error(`Enter ${key} (up to ${max} characters)`);
  localDate(new Date(), config.timezone);
  if (
    !Array.isArray(config.eventIds) ||
    !config.eventIds.length ||
    config.eventIds.length > 12
  )
    throw Error("Select 1–12 approved concert dates");
  for (const id of config.eventIds)
    if (
      !events.some(
        (e) =>
          String(e.id) === String(id) &&
          String(e.guild_id) === String(config.guildId) &&
          e.calendar_type === "stray_kids" &&
          e.category === "concert" &&
          !e.cancelled_at,
      )
    )
      throw Error(
        "A selected concert is no longer approved or active. Choose its replacement.",
      );
  buildCountdown(config, events);
  return config;
}
function buildCountdown(config, events, now = new Date()) {
  const today = localDate(now, config.timezone),
    ids = new Set(config.eventIds.map(String));
  const selected = events.filter(
    (e) =>
      ids.has(String(e.id)) &&
      String(e.guild_id) === String(config.guildId) &&
      e.calendar_type === "stray_kids" &&
      e.category === "concert" &&
      !e.cancelled_at,
  );
  const dates = [
    ...new Set(
      selected.map((e) =>
        e.all_day || !e.event_at
          ? e.event_date
          : localDate(new Date(e.event_at), config.timezone),
      ),
    ),
  ].sort();
  return {
    city: config.city,
    venue: config.venue,
    today,
    panels: dates.map((date, i) => ({
      date,
      day: i + 1,
      ...concertState(date, today),
    })),
  };
}
module.exports = {
  localDate,
  dayIndex,
  concertState,
  buildCountdown,
  validateConfig,
};
