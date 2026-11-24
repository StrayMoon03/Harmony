"use strict";
// Read-only audit: does not initialize/migrate the application database or contact Discord.
const { DatabaseSync } = require("node:sqlite");
const { auditRecords } = require("../src/services/concertTourCalendar");
const args = process.argv.slice(2),
  file = args[args.indexOf("--database") + 1],
  guild = args[args.indexOf("--guild") + 1];
if (
  !args.includes("--database") ||
  !args.includes("--guild") ||
  !file ||
  !guild
) {
  console.error(
    "Usage: node scripts/audit-concert-tour.cjs --database /path/harmony.sqlite --guild SERVER_ID",
  );
  process.exitCode = 1;
} else {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const events = db
      .prepare("SELECT * FROM scheduled_events WHERE guild_id=? ORDER BY id")
      .all(guild);
    const exists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='concert_tour_events'",
      )
      .get();
    const links = exists
      ? db
          .prepare(
            "SELECT * FROM concert_tour_events WHERE guild_id=? ORDER BY stop_key",
          )
          .all(guild)
      : [];
    process.stdout.write(
      JSON.stringify(auditRecords(events, links), null, 2) + "\n",
    );
  } finally {
    db.close();
  }
}
