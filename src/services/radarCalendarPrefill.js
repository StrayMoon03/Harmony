const { candidateTiming } = require("./radarPresentation");
const { validTimezone } = require("./eventSchedulerService");

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}

function validInstant(value) {
  // Date.parse accepts a bare year/month and invents the remaining date/time.
  // Only a complete date + exact time + explicit offset can supply a prefill.
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:[0-5]\d)$/.test(value) &&
    validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

// Suggestions only. Never write extracted timing to Radar or calendar storage.
// Publication timestamps and translations are deliberately not input evidence.
function calendarPrefill(discovery, source) {
  const result = { date: validDate(discovery.event_date) ? discovery.event_date : "", time: "",
    timezone: discovery.event_timezone && validTimezone(discovery.event_timezone) ? discovery.event_timezone : "" };
  if (!result.date && result.timezone && validInstant(discovery.event_at)) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: result.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(discovery.event_at));
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    result.date = `${fields.year}-${fields.month}-${fields.day}`;
  }
  if (result.date) {
    if (validInstant(discovery.event_at) && result.timezone) {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: result.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(discovery.event_at));
      const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
      if (`${fields.year}-${fields.month}-${fields.day}` === result.date) result.time = `${fields.hour}:${fields.minute}`;
    }
    return result;
  }
  // Multiple independently labelled dates require the owner's choice.
  const evidence = candidateTiming((source?.title || discovery.title || "") + "\n" + (source?.summary || discovery.summary || ""));
  if (evidence.length !== 1) return result;
  const text = evidence[0];
  let match = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b|(?:(\d{4})年(\d{1,2})月(\d{1,2})日)/u);
  if (match) {
    const [year, month, day] = match[1] ? match.slice(1, 4) : match.slice(4, 7);
    result.date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  } else {
    match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
    if (match) {
      const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1].toLowerCase()) + 1;
      result.date = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
    }
  }
  if (!validDate(result.date)) return { date: "", time: "", timezone: "" };
  const time = text.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i);
  if (time) {
    let hour = Number(time[1]);
    if (time[3] && (hour < 1 || hour > 12)) return result;
    if (time[3]) hour = hour % 12 + (/pm/i.test(time[3]) ? 12 : 0);
    if (hour < 24 && Number(time[2]) < 60) result.time = `${String(hour).padStart(2, "0")}:${time[2]}`;
  }
  const zones = [...text.matchAll(/\b(JST|KST|UTC)\b/g)].map(match => ({ JST: "Asia/Tokyo", KST: "Asia/Seoul", UTC: "UTC" })[match[1]]);
  if (!result.timezone && new Set(zones).size === 1) result.timezone = zones[0];
  return result;
}

module.exports = { calendarPrefill, validDate, validInstant };
