"use strict";
// Pure metadata helpers. A source-verified import reference is not a second live calendar.
const bundled = require("../reference/strayKidsRunItTour.json");
const dateFormats = new Map();
function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function phrase(text, value) {
  const key = normalize(value);
  return key && (" " + normalize(text) + " ").includes(" " + key + " ");
}
function excluded(event) {
  return (
    /\b(presale|pre sale|ticket sale|ticketing|onsale|on sale|watch party|watchparty|listening party|livestream|live stream|restream|streaming)\b/.test(
      normalize(event.title),
    ) || ["stream", "concert_stream", "shopping"].includes(event.category)
  );
}
function dateAt(event, timezone) {
  if (event.all_day || !event.event_at) {
    const d = event.event_date;
    return typeof d === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      Number.isFinite(Date.parse(d + "T00:00Z")) &&
      new Date(d + "T00:00Z").toISOString().slice(0, 10) === d
      ? d
      : null;
  }
  try {
    if (!dateFormats.has(timezone))
      dateFormats.set(
        timezone,
        new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }),
      );
    const p = Object.fromEntries(
      dateFormats
        .get(timezone)
        .formatToParts(new Date(event.event_at))
        .map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return null;
  }
}
function locationEvidence(event, location) {
  const text = [event.title, event.event_location].join(" ");
  // Country/state abbreviations are search aliases, never identity evidence.
  const city =
    phrase(text, location.city) ||
    (location.cityAliases || []).some((a) => phrase(text, a));
  const venue = [location.venue, ...(location.venueAliases || [])].some((a) =>
    phrase(text, a),
  );
  return { city: Boolean(city), venue: Boolean(venue) };
}
function matching(event, stop, loose = false) {
  if (excluded(event) || dateAt(event, stop.location.timezone) !== stop.date)
    return false;
  const evidence = locationEvidence(event, stop.location);
  if (!evidence.city && !evidence.venue) return false;
  if (loose) return true;
  return (
    normalize(event.category) === "concert" ||
    /\brun it\b|\bworld tour\b|\bconcert\b/.test(normalize(event.title))
  );
}
function stops(manifest = bundled) {
  return manifest.locations.flatMap((location) =>
    location.dates.map((d) => ({
      ...d,
      key: `${manifest.tourId}:${location.key}:${d.date}`,
      location,
    })),
  );
}
const knownStops = stops();
function isCountdownConcert(event) {
  if (!event || event.calendar_type !== "stray_kids" || event.cancelled_at)
    return false;
  if (normalize(event.category) === "concert") return true;
  // Only confirmed venue-local dates may compensate for a mistaken legacy category.
  return knownStops.some((stop) => matching(event, stop));
}
function inferLocation(event) {
  const hits = bundled.locations.filter((l) => {
    const e = locationEvidence(event, l);
    return e.city || e.venue;
  });
  const venueHits = hits.filter((l) => locationEvidence(event, l).venue);
  if (venueHits.length === 1) return venueHits[0];
  if (hits.length === 1) return hits[0];
  const dated = hits.filter((l) =>
    l.dates.some((d) => d.date === dateAt(event, l.timezone)),
  );
  return dated.length === 1 ? dated[0] : null;
}
function searchText(event, location) {
  const date = dateAt(
    event,
    location?.timezone || event.event_timezone || event.timezone || "UTC",
  );
  let formatted = "";
  if (date && Number.isFinite(Date.parse(date + "T00:00Z"))) {
    const [year, month, day] = date.split("-");
    formatted = [
      date,
      `${Number(month)}/${Number(day)}/${year}`,
      `${day}/${month}/${year}`,
      new Intl.DateTimeFormat("en-US", {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(date + "T12:00Z")),
    ].join(" ");
  }
  return normalize(
    [
      event.title,
      event.event_location,
      date,
      formatted,
      location?.city,
      location?.country,
      location?.venue,
      ...(location?.aliases || []),
      ...(location?.cityAliases || []),
      ...(location?.venueAliases || []),
    ].join(" "),
  );
}
function matchesQuery(event, location, query) {
  let rest = String(query || "");
  let match = rest.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/),
    wanted;
  if (match)
    wanted = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  else {
    match = rest.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (match) {
      const dayFirst = Number(match[1]) > 12;
      wanted = `${match[3]}-${(dayFirst ? match[2] : match[1]).padStart(2, "0")}-${(dayFirst ? match[1] : match[2]).padStart(2, "0")}`;
    } else {
      match = rest.match(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
      );
      if (match) {
        const month =
          [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
          ].indexOf(match[1].toLowerCase()) + 1;
        wanted = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
      }
    }
  }
  if (wanted) {
    if (
      dateAt(
        event,
        location?.timezone || event.event_timezone || event.timezone || "UTC",
      ) !== wanted
    )
      return false;
    rest = rest.replace(match[0], "");
  }
  const hay = searchText(event, location);
  return normalize(rest)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) =>
      word.length <= 2
        ? (" " + hay + " ").includes(" " + word + " ")
        : hay.includes(word),
    );
}
module.exports = {
  bundled,
  normalize,
  phrase,
  excluded,
  dateAt,
  locationEvidence,
  matching,
  stops,
  isCountdownConcert,
  inferLocation,
  matchesQuery,
};
