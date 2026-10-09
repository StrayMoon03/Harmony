const MAX_RECURRENCE_OCCURRENCES = 366;

const RECURRENCE_TYPES = ["none", "weekly", "biweekly", "monthly", "custom"];

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null;
}

function dateText(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addDays(date, amount) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function normalizeRecurrenceRule(input = {}, startDate) {
  const type = String(input.type || input.frequency || "none").toLowerCase();
  if (!RECURRENCE_TYPES.includes(type)) throw new Error("Choose a supported recurrence option.");
  if (type === "none") return { type: "none" };
  const start = parseDate(startDate);
  if (!start) throw new Error("A valid start date is required for recurrence.");
  const endDate = input.endDate ? parseDate(input.endDate) : null;
  const count = input.count == null || input.count === "" ? null : Number(input.count);
  if (!endDate && !Number.isInteger(count)) throw new Error("Recurring events must end on a date or after a number of occurrences.");
  if (endDate && endDate < start) throw new Error("The recurrence end date must be on or after the event date.");
  if (count != null && (!Number.isInteger(count) || count < 1 || count > MAX_RECURRENCE_OCCURRENCES)) throw new Error(`Occurrence count must be between 1 and ${MAX_RECURRENCE_OCCURRENCES}.`);
  if (type === "custom" && (input.interval == null || input.interval === "")) throw new Error("Custom recurrence needs an interval in weeks.");
  const interval = type === "biweekly" ? 2 : Number(input.interval || 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) throw new Error("Recurrence interval must be a whole number from 1 to 52.");
  let weekdays = input.weekdays;
  if (typeof weekdays === "string") weekdays = weekdays.split(/[\s,+]+/).filter(Boolean).map((value) => {
    const names = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
    return Object.prototype.hasOwnProperty.call(names, value.toLowerCase()) ? names[value.toLowerCase()] : Number(value);
  });
  if (type === "custom" && (!Array.isArray(weekdays) || !weekdays.length)) throw new Error("Custom recurrence needs at least one weekday.");
  weekdays = Array.isArray(weekdays) && weekdays.length ? [...new Set(weekdays.map(Number))].sort((a, b) => a - b) : [start.getUTCDay()];
  if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Choose weekdays using values from 0 (Sunday) through 6 (Saturday).");
  return { type, interval, weekdays, endDate: endDate ? dateText(endDate) : null, count };
}

function generateRecurringOccurrences({ startDate, startTime = "", timezone = null, rule, localToUtc }) {
  const normalized = normalizeRecurrenceRule(rule, startDate);
  const start = parseDate(startDate);
  if (normalized.type === "none") return [{ eventDate: dateText(start), eventAt: startTime && timezone ? localToUtc(startDate, startTime, timezone)?.toISOString() || null : null, occurrenceIndex: 0 }];
  const end = normalized.endDate ? parseDate(normalized.endDate) : null;
  const output = [];
  let cursor = start;
  let safety = 0;
  while (cursor && output.length < MAX_RECURRENCE_OCCURRENCES && safety < 3700) {
    const day = cursor.getUTCDay();
    const diffDays = Math.round((cursor.getTime() - start.getTime()) / 86400000);
    const diffWeeks = Math.floor(diffDays / 7);
    const matches = normalized.type === "monthly"
      ? cursor.getUTCDate() === start.getUTCDate()
      : normalized.weekdays.includes(day) && diffWeeks % normalized.interval === 0;
    if (matches) {
      if (end && cursor > end) break;
      const eventDate = dateText(cursor);
      const eventAt = startTime && timezone ? localToUtc(eventDate, startTime, timezone) : null;
      if (startTime && timezone && !eventAt) throw new Error(`The local time for ${eventDate} could not be converted safely.`);
      output.push({ eventDate, eventAt: eventAt ? eventAt.toISOString() : null, occurrenceIndex: output.length });
      if (normalized.count && output.length >= normalized.count) break;
    }
    cursor = addDays(cursor, 1);
    safety += 1;
    if (normalized.type === "monthly" && cursor.getUTCDate() === 1) {
      // Continue day-by-day so short months are skipped rather than coerced.
    }
  }
  if (!output.length) throw new Error("The recurrence rule produced no valid occurrences.");
  return output;
}

// Discord stores a recurring Scheduled Event as one native object plus a
// recurrence rule.  discord.js does not expose expanded occurrences, so keep
// the projection deliberately local, bounded, and deterministic.
function generateDiscordRecurringOccurrences({ startAt, endAt = null, recurrenceRule, until = null, maxOccurrences = MAX_RECURRENCE_OCCURRENCES }) {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return [];
  const rule = recurrenceRule || {};
  const frequency = Number(rule.frequency);
  const interval = Math.max(1, Number(rule.interval) || 1);
  const limit = Math.min(MAX_RECURRENCE_OCCURRENCES, Math.max(1, Number(maxOccurrences) || MAX_RECURRENCE_OCCURRENCES));
  const horizon = until ? new Date(until) : new Date(Math.max(Date.now(), start.getTime()) + 180 * 24 * 60 * 60 * 1000);
  const ruleEnd = rule.endAt ? new Date(rule.endAt) : null;
  const last = ruleEnd && ruleEnd < horizon ? ruleEnd : horizon;
  const count = Number.isInteger(rule.count) && rule.count > 0 ? rule.count : null;
  const output = [];
  const duration = endAt ? Math.max(0, new Date(endAt).getTime() - start.getTime()) : null;
  const weekday = start.getUTCDay();
  const discordWeekday = (weekday + 6) % 7; // Discord uses Monday=0, Sunday=6.
  const byWeekday = Array.isArray(rule.byWeekday) && rule.byWeekday.length ? rule.byWeekday.map(Number) : [discordWeekday];
  const byMonthDay = Array.isArray(rule.byMonthDay) && rule.byMonthDay.length ? rule.byMonthDay.map(Number) : [start.getUTCDate()];
  const byMonth = Array.isArray(rule.byMonth) && rule.byMonth.length ? rule.byMonth.map(Number) : [start.getUTCMonth() + 1];
  const byNWeekday = Array.isArray(rule.byNWeekday) ? rule.byNWeekday : [];
  const seen = new Set();
  const add = (date) => {
    if (date < start || date > last || seen.has(date.toISOString())) return;
    seen.add(date.toISOString());
    output.push({ eventAt: date.toISOString(), eventEndAt: duration == null ? null : new Date(date.getTime() + duration).toISOString(), occurrenceIndex: output.length });
  };
  const cursor = new Date(start);
  let safety = 0;
  while (cursor <= last && output.length < limit && (!count || output.length < count) && safety < 20000) {
    const day = cursor.getUTCDay();
    const days = Math.floor((cursor.getTime() - start.getTime()) / 86400000);
    const weeks = Math.floor(days / 7);
    const months = (cursor.getUTCFullYear() - start.getUTCFullYear()) * 12 + cursor.getUTCMonth() - start.getUTCMonth();
    const years = cursor.getUTCFullYear() - start.getUTCFullYear();
    let matches = false;
    if (frequency === 3) matches = days % interval === 0;
    else if (frequency === 2) matches = weeks % interval === 0 && byWeekday.includes((day + 6) % 7);
    else if (frequency === 1) {
      const nthMatch = byNWeekday.some((item) => Number(item?.n) === Math.floor((cursor.getUTCDate() - 1) / 7) + 1 && Number(item?.day) === (day + 6) % 7);
      matches = months >= 0 && months % interval === 0 && (byNWeekday.length ? nthMatch : byMonthDay.includes(cursor.getUTCDate()));
    }
    else if (frequency === 0) matches = years >= 0 && years % interval === 0 && byMonth.includes(cursor.getUTCMonth() + 1) && byMonthDay.includes(cursor.getUTCDate());
    if (matches) add(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    safety += 1;
  }
  return output;
}

module.exports = { MAX_RECURRENCE_OCCURRENCES, RECURRENCE_TYPES, normalizeRecurrenceRule, generateRecurringOccurrences, generateDiscordRecurringOccurrences };
