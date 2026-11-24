"use strict";
const { getDb } = require("../db/sqlite");
const { createHash } = require("node:crypto");
const identity = require("./concertTourIdentity");
const {
  bundled,
  stops,
  matching,
  normalize,
  inferLocation,
  isCountdownConcert,
  matchesQuery,
  dateAt,
} = identity;
function validDate(s) {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s + "T00:00Z")) &&
    new Date(s + "T00:00Z").toISOString().slice(0, 10) === s
  );
}
function officialSource(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      (/(^|\.)(straykids\.jype\.com|straykidsjapan\.com|skz-stayjapan\.com|sonymusic\.co\.jp|sme\.co\.jp|app\.fans|livenationentertainment\.com)$/.test(
        u.hostname,
      ) ||
        /(^|\.)(livenation|ticketmaster)\.(com|asia|co\.uk|co\.jp|nl|de|fr|es|it|at|sg|hk|com\.tw)$/.test(
          u.hostname,
        ))
    );
  } catch {
    return false;
  }
}
function validateManifest(input) {
  if (
    !input ||
    typeof input !== "object" ||
    !/^[-a-z0-9]{1,60}$/.test(input.tourId) ||
    !validDate(input.verifiedAt) ||
    !Array.isArray(input.locations) ||
    !input.locations.length ||
    input.locations.length > 100
  )
    throw Error("Invalid confirmed-tour file");
  let count = 0;
  const keys = new Set();
  const physicalDates = new Set();
  for (const l of input.locations) {
    if (!l || !/^[-a-z0-9]{1,80}$/.test(l.key) || keys.has(l.key))
      throw Error("Location keys must be unique");
    keys.add(l.key);
    for (const [key, max] of [
      ["city", 80],
      ["country", 80],
      ["venue", 120],
      ["timezone", 80],
    ])
      if (typeof l[key] !== "string" || !l[key].trim() || l[key].length > max)
        throw Error("Invalid location " + key);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: l.timezone }).format();
    } catch {
      throw Error("Invalid venue time zone");
    }
    for (const key of ["aliases", "cityAliases", "venueAliases"])
      if (
        l[key] !== undefined &&
        (!Array.isArray(l[key]) ||
          l[key].length > 30 ||
          l[key].some((a) => typeof a !== "string" || a.length > 120))
      )
        throw Error("Invalid search aliases");
    if (!Array.isArray(l.dates) || !l.dates.length || l.dates.length > 12)
      throw Error("Each location needs 1–12 confirmed dates");
    const dates = new Set();
    for (const d of l.dates) {
      if (
        !d ||
        !validDate(d.date) ||
        dates.has(d.date) ||
        !officialSource(d.sourceUrl)
      )
        throw Error(
          "Each date needs a unique valid date and official HTTPS source",
        );
      const known = inferLocation({ title: l.city, event_location: l.venue });
      const physical =
        (known?.key || normalize(l.city + " " + l.country)) + ":" + d.date;
      if (physicalDates.has(physical))
        throw Error("Duplicate physical concert date in the import file");
      physicalDates.add(physical);
      dates.add(d.date);
      count++;
    }
  }
  if (count > 200) throw Error("Import up to 200 confirmed dates at a time");
  return JSON.parse(JSON.stringify(input));
}
function rows(g) {
  return getDb()
    .prepare("SELECT * FROM scheduled_events WHERE guild_id=? ORDER BY id")
    .all(g);
}
function links(g) {
  return getDb()
    .prepare(
      "SELECT * FROM concert_tour_events WHERE guild_id=? ORDER BY stop_key",
    )
    .all(g);
}
function sourceLocation(link) {
  return {
    key: link.location_key,
    city: link.city,
    country: link.country,
    venue: link.venue,
    timezone: link.timezone,
    aliases: JSON.parse(link.search_aliases || "[]"),
  };
}
function listConcerts(g, query = "") {
  const metadata = new Map(links(g).map((l) => [l.event_id, l]));
  return rows(g)
    .filter(isCountdownConcert)
    .map((e) => {
      const location = metadata.has(e.id)
        ? sourceLocation(metadata.get(e.id))
        : inferLocation(e);
      return { ...e, countdown_location: location };
    })
    .filter((e) => matchesQuery(e, e.countdown_location, query))
    .sort(
      (a, b) =>
        (
          dateAt(
            a,
            a.countdown_location?.timezone ||
              a.event_timezone ||
              a.timezone ||
              "UTC",
          ) || ""
        ).localeCompare(
          dateAt(
            b,
            b.countdown_location?.timezone ||
              b.event_timezone ||
              b.timezone ||
              "UTC",
          ) || "",
        ) || a.id - b.id,
    );
}
function audit(g, manifest = bundled) {
  return auditRecords(rows(g), links(g), manifest);
}
function auditRecords(all, saved, manifest = bundled) {
  const entries = [];
  for (const stop of stops(manifest)) {
    const link = saved.find((l) => l.stop_key === stop.key),
      linked = link && all.find((e) => e.id === link.event_id);
    const strong = all.filter((e) => matching(e, stop));
    const announcedDates = new Set([
      ...stop.location.dates.map((d) => d.date),
      ...bundled.locations
        .filter((l) => l.key === stop.location.key)
        .flatMap((l) => l.dates.map((d) => d.date)),
    ]);
    const potentialReschedule = (e) => {
      if (
        e.cancelled_at ||
        identity.excluded(e) ||
        saved.some((l) => l.event_id === e.id)
      )
        return false;
      const day = dateAt(e, stop.location.timezone);
      return (
        day &&
        !announcedDates.has(day) &&
        Math.abs(Date.parse(day) - Date.parse(stop.date)) <= 60 * 86400000 &&
        Object.values(identity.locationEvidence(e, stop.location)).some(
          Boolean,
        ) &&
        (normalize(e.category) === "concert" ||
          /\brun it\b/.test(normalize(e.title)))
      );
    };
    const potential = all.filter(
      (e) =>
        potentialReschedule(e) ||
        matching(e, stop, true) ||
        (!identity.excluded(e) &&
          !dateAt(e, stop.location.timezone) &&
          (e.category === "concert" || /\brun it\b/.test(normalize(e.title))) &&
          Object.values(identity.locationEvidence(e, stop.location)).some(
            Boolean,
          )) ||
        (!identity.excluded(e) &&
          dateAt(e, stop.location.timezone) === stop.date &&
          /\brun it\b/.test(normalize(e.title)) &&
          !inferLocation(e)),
    );
    let event = linked,
      status,
      reason;
    if (link && !linked) {
      status = "blocked";
      reason =
        "A previously linked calendar event was removed. Review it before replacing.";
    } else if (linked) {
      if (linked.cancelled_at) {
        status = "cancelled";
        reason =
          "Existing calendar date is canceled; it will not be recreated.";
      } else if (
        linked.calendar_type !== "stray_kids" ||
        linked.category !== "concert"
      ) {
        status = "repair";
        reason = "Reuse the linked record and correct its calendar/category.";
      } else {
        status =
          dateAt(linked, stop.location.timezone) === stop.date
            ? "ready"
            : "rescheduled";
        reason = "Keep the existing approved record and its current timing.";
      }
    } else if (strong.length === 1 && potential.length === 1) {
      event = strong[0];
      status = event.cancelled_at
        ? "cancelled"
        : event.calendar_type === "stray_kids" && event.category === "concert"
          ? "reuse"
          : "repair";
      reason =
        status === "repair"
          ? "Reuse this record; change only its calendar/category classification."
          : status === "cancelled"
            ? "Canceled date will not be recreated."
            : "Reuse this approved calendar record.";
    } else if (strong.length > 1 || potential.length) {
      status = "blocked";
      reason =
        "Ambiguous existing calendar record(s). Resolve them in Schedule Manager; no duplicate will be created.";
    } else {
      status = "missing";
      reason =
        "Create a new date-only event in the existing Stray Kids calendar.";
    }
    entries.push({
      key: stop.key,
      date: stop.date,
      location: stop.location,
      sourceUrl: stop.sourceUrl,
      status,
      reason,
      eventId: event?.id || null,
      existing: event || null,
      candidateIds: potential.map((e) => e.id),
    });
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ manifest, all, saved }))
    .digest("hex");
  return {
    manifest,
    fingerprint,
    entries,
    counts: Object.fromEntries(
      [
        "ready",
        "reuse",
        "repair",
        "missing",
        "blocked",
        "cancelled",
        "rescheduled",
      ].map((s) => [s, entries.filter((e) => e.status === s).length]),
    ),
    classifications: [
      ...all
        .reduce((map, e) => {
          const key = JSON.stringify([e.calendar_type, e.category]);
          const row = map.get(key) || {
            calendar_type: e.calendar_type,
            category: e.category,
            count: 0,
          };
          row.count++;
          map.set(key, row);
          return map;
        }, new Map())
        .values(),
    ],
  };
}
function groups(g, query = "", manifest = bundled) {
  const review = audit(g, manifest),
    concerts = listConcerts(g),
    map = new Map();
  for (const location of manifest.locations)
    map.set(location.key, {
      ...location,
      events: [],
      audit: review.entries.filter((e) => e.location.key === location.key),
    });
  for (const e of concerts) {
    const location = e.countdown_location,
      key =
        location?.key ||
        "calendar-" +
          createHash("sha256")
            .update(normalize(e.event_location || e.title))
            .digest("hex")
            .slice(0, 24);
    if (!map.has(key))
      map.set(key, {
        ...(location || {
          key,
          city: e.event_location || e.title,
          country: "",
          venue: e.event_location || e.title,
          timezone: e.event_timezone || e.timezone,
        }),
        events: [],
        audit: [],
      });
    map.get(key).events.push(e);
  }
  return [...map.values()]
    .filter(
      (l) =>
        !query ||
        l.events.some((e) => matchesQuery(e, l, query)) ||
        l.audit.some((e) =>
          matchesQuery({ event_date: e.date, all_day: 1 }, l, query),
        ),
    )
    .sort(
      (a, b) => a.city.localeCompare(b.city) || a.venue.localeCompare(b.venue),
    );
}
function scopedManifest(locationKey) {
  return {
    ...bundled,
    locations: bundled.locations.filter(
      (l) => !locationKey || l.key === locationKey,
    ),
  };
}
function importConfirmed(g, manifest, expectedFingerprint, actor) {
  const input = validateManifest(manifest),
    db = getDb();
  if (!actor) throw Error("Administrator identity is required");
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = audit(g, input);
    if (plan.fingerprint !== expectedFingerprint)
      throw Error(
        "The calendar changed. Review the import again before approving.",
      );
    const now = new Date().toISOString(),
      channel =
        db
          .prepare(
            "SELECT stray_kids_channel_id FROM calendar_settings WHERE guild_id=?",
          )
          .get(g)?.stray_kids_channel_id || "";
    const result = {
      created: 0,
      reused: 0,
      repaired: 0,
      blocked: 0,
      cancelled: 0,
      eventIds: [],
    };
    for (const item of plan.entries) {
      if (item.status === "blocked" || item.status === "cancelled") {
        result[item.status]++;
        continue;
      }
      let eventId = item.eventId;
      if (item.status === "missing") {
        eventId = Number(
          db
            .prepare(
              `INSERT INTO scheduled_events (guild_id,source_channel_id,destination_channel_id,title,link,timezone,calendar_type,event_date,event_timezone,event_location,description,category,all_day,created_by,created_at)
          VALUES(?,?,?,?,?,?,'stray_kids',?,?,?,?,'concert',1,?,?)`,
            )
            .run(
              g,
              channel,
              channel,
              `Stray Kids World Tour RUN IT — ${item.location.city}`,
              item.sourceUrl,
              item.location.timezone,
              item.date,
              item.location.timezone,
              `${item.location.venue}, ${item.location.city}, ${item.location.country}`,
              `Confirmed tour date. Source checked ${input.verifiedAt}. Imported with administrator approval.`,
              actor,
              now,
            ).lastInsertRowid,
        );
        result.created++;
      } else if (item.status === "repair") {
        db.prepare(
          "UPDATE scheduled_events SET calendar_type='stray_kids',category='concert' WHERE guild_id=? AND id=? AND cancelled_at IS NULL",
        ).run(g, eventId);
        result.repaired++;
      } else result.reused++;
      const owner = db
        .prepare(
          "SELECT stop_key FROM concert_tour_events WHERE guild_id=? AND event_id=?",
        )
        .get(g, eventId);
      if (owner && owner.stop_key !== item.key)
        throw Error("One calendar record cannot represent two concert dates");
      db.prepare(
        `INSERT INTO concert_tour_events (guild_id,stop_key,event_id,location_key,city,country,venue,timezone,search_aliases,source_url,verified_at,approved_by,linked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(guild_id,stop_key) DO UPDATE SET event_id=excluded.event_id,location_key=excluded.location_key,city=excluded.city,country=excluded.country,venue=excluded.venue,timezone=excluded.timezone,search_aliases=excluded.search_aliases,source_url=excluded.source_url,verified_at=excluded.verified_at,approved_by=excluded.approved_by,linked_at=excluded.linked_at`,
      ).run(
        g,
        item.key,
        eventId,
        item.location.key,
        item.location.city,
        item.location.country,
        item.location.venue,
        item.location.timezone,
        JSON.stringify([
          ...(item.location.aliases || []),
          ...(item.location.cityAliases || []),
          ...(item.location.venueAliases || []),
        ]),
        item.sourceUrl,
        input.verifiedAt,
        actor,
        now,
      );
      result.eventIds.push(eventId);
    }
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
module.exports = {
  bundled,
  validateManifest,
  officialSource,
  listConcerts,
  audit,
  auditRecords,
  groups,
  scopedManifest,
  importConfirmed,
};
async function readManifestAttachment(attachment) {
  if (!attachment || attachment.size > 512 * 1024)
    throw Error("Choose a confirmed-tour JSON file up to 512 KB");
  const u = new URL(attachment.url);
  if (
    u.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    throw Error("Use a Discord file upload");
  const r = await fetch(u, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Error("Could not read the uploaded tour file");
  const reader = r.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) throw Error("Tour file exceeds 512 KB");
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("Upload a valid JSON tour file");
  }
  return validateManifest(parsed);
}
module.exports.readManifestAttachment = readManifestAttachment;
