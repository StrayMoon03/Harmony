"use strict";
// Offline review examples. No production database, user photos or Discord calls.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { render, RENDER_VERSION } = require("../src/services/concertCountdownRender");
const { buildCountdown } = require("../src/services/concertCountdownModel");
const out = path.join(__dirname, "../docs/countdown-single-date-fix");
fs.mkdirSync(out, { recursive: true });
const oldRenderer = execFileSync("git", [
  "show",
  "db049df1c7ba7eb6dd04099b5cfd0e169cdb2d6d:src/renderers/concert_countdown.py",
], { encoding: "utf8" });

function model(city, venue, timezone, dates, now) {
  return {
    ...buildCountdown({
      guildId: "fixture", city, venue, timezone,
      eventIds: dates.map((_, i) => i + 1),
    }, dates.map((date, i) => ({
      id: i + 1, guild_id: "fixture", calendar_type: "stray_kids",
      category: "concert", all_day: 1, event_date: date,
    })), new Date(now)),
    testLabel: "TEST PREVIEW • FIXTURE CLOCK • NO VENUE PHOTO",
  };
}

(async () => {
  const single = model("Milan", "San Siro Stadium", "Europe/Rome",
    ["2027-07-31"], "2026-11-24T17:00Z");
  const old = spawnSync("python3", ["-c", oldRenderer], {
    input: JSON.stringify({ action: "render", model: single }),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (old.status !== 0) throw Error(old.stderr.toString());
  fs.writeFileSync(path.join(out, "single-before.png"), old.stdout);
  const examples = {
    "single-after": single,
    "two-dates": model("Chicago", "Soldier Field", "America/Chicago",
      ["2027-06-18", "2027-06-19"], "2026-11-24T17:00Z"),
    "three-dates": model("Tokyo", "Tokyo Dome", "Asia/Tokyo",
      ["2026-11-06", "2026-11-07", "2026-11-08"], "2026-11-01T12:00Z"),
  };
  for (const [name, now] of [
    ["single-tomorrow", "2027-07-30T12:00Z"],
    ["single-d-day", "2027-07-31T12:00Z"],
    ["single-completed", "2027-08-01T12:00Z"],
  ]) examples[name] = model("Milan", "San Siro Stadium", "Europe/Rome", ["2027-07-31"], now);
  for (const [name, m] of Object.entries(examples)) {
    fs.writeFileSync(path.join(out, name + ".png"), await render(m));
  }
  fs.writeFileSync(path.join(out, "render-inputs.json"),
    JSON.stringify({ renderVersion: RENDER_VERSION, examples }, null, 2) + "\n");
  console.log("Generated before/after, multi-date and single-state cards using actual renderers.");
})().catch(error => { console.error(error); process.exitCode = 1; });
