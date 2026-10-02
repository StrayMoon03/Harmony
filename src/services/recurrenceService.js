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
  if (typeof weekdays === "string") weekdays = weekdays.split(/[\s,]+/).filter(Boolean).map(Number);
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

module.exports = { MAX_RECURRENCE_OCCURRENCES, RECURRENCE_TYPES, normalizeRecurrenceRule, generateRecurringOccurrences };
