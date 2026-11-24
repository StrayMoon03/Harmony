const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
process.env.HARMONY_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "countdown-manager-")),
  "test.sqlite",
);
const { ChannelType, Collection } = require("discord.js");
const manager = require("../src/services/concertCountdownManager"),
  store = require("../src/stores/concertCountdownStore"),
  rooms = require("../src/stores/adminRoomStore"),
  calendar = require("../src/stores/eventSchedulerStore");
const { getDb } = require("../src/db/sqlite");
const service = require("../src/services/concertCountdownService");
let seq = 0;
function fixture() {
  const g = "manager" + ++seq,
    c = String(9999 + seq);
  rooms.savePanel({ guildId: g, channelId: "private", messageId: "panel" });
  const channel = { id: c, guildId: g, type: ChannelType.GuildText };
  const base = {
    guildId: g,
    channelId: "private",
    guild: {
      id: g,
      ownerId: "owner",
      channels: { fetch: async () => channel },
    },
    user: { id: "owner" },
    memberPermissions: { has: () => false },
    client: {},
    message: { id: "panel" },
  };
  const s = manager.createSession(base);
  s.locationKey = "chicago";
  function i(action, more = {}) {
    const x = {
      ...base,
      customId: `harmony-countdown:${s.token}:${action}`,
      values: [],
      ...more,
    };
    x.reply = async (p) => {
      x.response = p;
    };
    x.update = async (p) => {
      x.response = p;
    };
    x.editReply = async (p) => {
      x.response = p;
    };
    x.showModal = async (p) => {
      x.modal = p;
    };
    x.deferReply = async () => {
      x.deferred = true;
    };
    x.deferUpdate = async () => {
      x.deferred = true;
    };
    return x;
  }
  function event(date = "2027-06-18", more = {}) {
    return calendar.createCalendarEvent({
      guildId: g,
      calendarChannelId: "cal",
      title: "Chicago · Soldier Field",
      eventDate: date,
      eventTimezone: "America/Chicago",
      eventLocation: "Soldier Field",
      calendarType: "stray_kids",
      category: "concert",
      allDay: true,
      createdBy: "admin",
      ...more,
    });
  }
  return { g, c, s, i, event, base };
}
function serialize(p) {
  return JSON.stringify(p);
}
test("graphical add flow selects a room and approved events, fills metadata and saves privately", async () => {
  const f = fixture(),
    event = f.event();
  let i = f.i("add");
  await manager.handle(i);
  assert.match(serialize(i.response), /Choose a concert room/);
  i = f.i("room", { values: [f.c] });
  await manager.handle(i);
  assert.match(serialize(i.response), /Select concert dates/);
  await manager.handle(f.i("events"));
  i = f.i("select-events", { values: [String(event)] });
  await manager.handle(i);
  assert.equal(f.s.draft.venue, "Soldier Field");
  assert.equal(f.s.draft.timezone, "America/Chicago");
  i = f.i("details");
  await manager.handle(i);
  assert.ok(i.modal.toJSON());
  i = f.i("details-save", {
    fields: {
      getTextInputValue: (k) =>
        ({
          city: "Chicago",
          country: "United States",
          venue: "Soldier Field",
          timezone: "America/Chicago",
        })[k],
    },
  });
  await manager.handle(i);
  i = f.i("save");
  await manager.handle(i);
  assert.ok(store.get(f.g, f.c));
  assert.equal(store.get(f.g, f.c).message_id, null);
  assert.equal(store.get(f.g, f.c).enabled, 0);
  assert.match(serialize(i.response), /Private preview/);
});
test("unauthorized users, other users sessions, stale panels, wrong channels and expired sessions are rejected", async () => {
  const f = fixture();
  for (const more of [
    { user: { id: "intruder" } },
    { channelId: "public" },
    { guildId: "other", guild: { id: "other" } },
  ]) {
    const i = f.i("add", more);
    await manager.handle(i);
    assert.match(i.response.content, /expired|authorized/);
  }
  rooms.savePanel({
    guildId: f.g,
    channelId: "private",
    messageId: "replacement",
  });
  const i = f.i("add");
  await manager.handle(i);
  assert.match(i.response.content, /current Control Center/);
  const f2 = fixture();
  f2.s.expires = 0;
  const expired = f2.i("add");
  await manager.handle(expired);
  assert.match(expired.response.content, /expired/);
});
test("event pagination, search and multi-page selections retain stable IDs and exclude Radar candidates", async () => {
  const f = fixture();
  f.s.room = f.c;
  for (let n = 0; n < 29; n++)
    f.event("2027-07-" + String(n + 1).padStart(2, "0"));
  f.event("2027-08-01", { guildId: "other" });
  f.event("2027-08-02", { calendarType: "community" });
  calendar.createOrGetCalendarCandidate({
    guildId: f.g,
    title: "Unapproved concert",
    proposedEventDate: "2027-09-01",
    sourceUrl: "https://example.test/unapproved",
    sourceType: "member_submission",
  });
  let i = f.i("events");
  await manager.handle(i);
  const first = f.s.offered[0];
  await manager.handle(f.i("select-events", { values: [String(first)] }));
  i = f.i("event-next");
  await manager.handle(i);
  const second = f.s.offered[0];
  await manager.handle(f.i("select-events", { values: [String(second)] }));
  assert.deepEqual(f.s.draft.eventIds, [first, second]);
  assert.equal(store.concerts(f.g).length, 29);
  i = f.i("search-save", { fields: { getTextInputValue: () => "2027-07-29" } });
  await manager.handle(i);
  assert.equal(f.s.offered.length, 1);
});
test("newly approved concert dates are selectable for an existing countdown", async () => {
  const f = fixture(),
    one = f.event();
  store.save(f.g, f.c, {
    guildId: f.g,
    city: "Chicago",
    country: "USA",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: [one],
  });
  await manager.handle(f.i("open", { values: [f.c] }));
  await manager.handle(f.i("edit"));
  const two = f.event("2027-06-19");
  await manager.handle(f.i("events"));
  assert.ok(f.s.offered.includes(two));
  await manager.handle(
    f.i("select-events", { values: [String(one), String(two)] }),
  );
  await manager.handle(f.i("save"));
  assert.deepEqual(JSON.parse(store.get(f.g, f.c).config).eventIds, [one, two]);
});
test("publish requires confirmation, changed configuration invalidates approval, preview remains private", async () => {
  const f = fixture(),
    event = f.event();
  store.save(f.g, f.c, {
    guildId: f.g,
    city: "Chicago",
    country: "USA",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: [event],
  });
  f.s.room = f.c;
  let i = f.i("confirm-publish");
  await manager.handle(i);
  assert.match(i.response.content, /approve publication again/);
  i = f.i("publish");
  await manager.handle(i);
  assert.match(serialize(i.response), /Approve & publish/);
  assert.equal(store.get(f.g, f.c).message_id, null);
  const originalPreview = service.preview;
  service.preview = async () => ({ content: "private image", files: [] });
  try {
    i = f.i("preview");
    await manager.handle(i);
    assert.equal(i.deferred, true);
    assert.equal(i.response.content, "private image");
    assert.equal(store.get(f.g, f.c).message_id, null);
  } finally {
    service.preview = originalPreview;
  }
  store.save(f.g, f.c, JSON.parse(store.get(f.g, f.c).config));
  i = f.i("confirm-publish");
  await manager.handle(i);
  assert.match(i.response.content, /changed/);
});
test("toggle, refresh and repair controls use saved room configuration", async () => {
  const f = fixture(),
    event = f.event();
  store.save(f.g, f.c, {
    guildId: f.g,
    city: "Chicago",
    country: "USA",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: [event],
  });
  f.s.room = f.c;
  let i = f.i("toggle");
  await manager.handle(i);
  assert.match(i.response.content, /Publish explicitly/);
  const original = service.refresh,
    calls = [];
  service.refresh = async (...args) => {
    calls.push(args);
    store.update(f.g, f.c, { message_id: "posted", published_at: "now" });
    return {};
  };
  try {
    await manager.handle(f.i("publish"));
    await manager.handle(f.i("confirm-publish"));
    assert.equal(calls[0][3].publish, true);
    await manager.handle(f.i("toggle"));
    assert.equal(store.get(f.g, f.c).enabled, 1);
    await manager.handle(f.i("toggle"));
    assert.equal(store.get(f.g, f.c).enabled, 0);
    await manager.handle(f.i("refresh"));
    assert.equal(calls[1][3].publish, false);
  } finally {
    service.refresh = original;
  }
});
test("photo modal uses actual Discord.js file-upload component and all manager payloads validate", async () => {
  const f = fixture(),
    event = f.event();
  f.s.room = f.c;
  store.save(f.g, f.c, {
    guildId: f.g,
    city: "Chicago",
    country: "USA",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: [event],
  });
  let i = f.i("photo");
  await manager.handle(i);
  const json = i.modal.toJSON();
  assert.equal(json.components[0].component.type, 19);
  for (const payload of [
    manager.home(f.s),
    manager.detail(f.s),
    manager.draftPage(f.s),
    manager.eventPage(f.s),
  ])
    for (const row of payload.components) assert.ok(row.toJSON());
});
test("legacy schema migration is idempotent and preserves published configuration", () => {
  const { DatabaseSync } = require("node:sqlite"),
    { migrateCountdowns } = require("../src/db/concertCountdownSchema");
  const d = new DatabaseSync(":memory:");
  d.exec(
    "CREATE TABLE concert_countdowns(guild_id TEXT,channel_id TEXT,config TEXT,photo BLOB,photo_type TEXT,message_id TEXT,enabled INTEGER DEFAULT 0,fingerprint TEXT,last_success TEXT,last_error TEXT,PRIMARY KEY(guild_id,channel_id));INSERT INTO concert_countdowns(guild_id,channel_id,config,message_id) VALUES('g','c','{}','published')",
  );
  migrateCountdowns(d);
  migrateCountdowns(d);
  assert.equal(
    d.prepare("SELECT * FROM concert_countdowns").get().published_at,
    "legacy",
  );
  d.close();
});
test("replacing a photograph downloads only a bounded Discord attachment, decodes it and persists it", async () => {
  const { spawnSync } = require("node:child_process");
  const f = fixture(),
    event = f.event();
  f.s.room = f.c;
  store.save(f.g, f.c, {
    guildId: f.g,
    city: "Chicago",
    country: "USA",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: [event],
  });
  const originalFetch = global.fetch;
  try {
    for (const color of ["red", "blue"]) {
      const bytes = spawnSync("python3", [
        "-c",
        `from PIL import Image; import sys; Image.new('RGB',(300,150),'${color}').save(sys.stdout.buffer,format='PNG')`,
      ]).stdout;
      global.fetch = async () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      });
      const a = {
        url: "https://cdn.discordapp.com/attachments/fixture/photo.png",
        size: bytes.length,
      };
      const i = f.i("photo-save", {
        fields: { getUploadedFiles: () => new Collection([["1", a]]) },
      });
      await manager.handle(i);
      assert.match(serialize(i.response), /Photograph saved/);
      assert.equal(store.get(f.g, f.c).photo_type, "jpeg");
    }
    assert.equal(store.photos(f.g).length, 2);
    assert.equal(store.get(f.g, f.c).revision, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
test("canceled selections can be removed and replaced through Edit details & dates", async () => {
  const f = fixture(),
    one = f.event(),
    two = f.event("2027-06-19");
  f.s.room = f.c;
  store.save(f.g, f.c, {
    guildId: f.g,
    city: "Chicago",
    country: "USA",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: [one],
  });
  calendar.cancelEvent(f.g, one, "owner");
  await manager.handle(f.i("edit"));
  assert.deepEqual(f.s.draft.eventIds, []);
  await manager.handle(f.i("events"));
  await manager.handle(f.i("select-events", { values: [String(two)] }));
  await manager.handle(f.i("save"));
  assert.deepEqual(JSON.parse(store.get(f.g, f.c).config).eventIds, [two]);
});
test("external image hosts and oversized uploads are rejected before network access", async () => {
  const { downloadPhoto } = require("../src/services/concertCountdownPhoto");
  let called = false;
  const original = global.fetch;
  global.fetch = async () => {
    called = true;
    throw Error("Unexpected network request");
  };
  try {
    await assert.rejects(
      downloadPhoto({ size: 10, url: "https://example.test/photo.png" }),
      /Discord file upload/,
    );
    await assert.rejects(
      downloadPhoto({
        size: 5 * 1024 * 1024,
        url: "https://cdn.discordapp.com/photo.png",
      }),
      /4 MB/,
    );
    assert.equal(called, false);
  } finally {
    global.fetch = original;
  }
});
test("location picker shows every confirmed stop with pagination, including missing Chicago dates", async () => {
  const f = fixture();
  f.s.room = f.c;
  f.s.locationKey = null;
  let i = f.i("events");
  await manager.handle(i);
  assert.match(serialize(i.response), /Choose concert location/);
  assert.equal(f.s.offeredLocations.length, 25);
  assert.ok(f.s.offeredLocations.includes("chicago"));
  const first = serialize(i.response);
  assert.match(first, /missing from calendar/);
  i = f.i("location-next");
  await manager.handle(i);
  assert.ok(f.s.offeredLocations.includes("yokohama"));
  assert.equal(f.s.offeredLocations.length, 9);
  await manager.handle(
    f.i("search-save", {
      fields: { getTextInputValue: () => "United States Chicago" },
    }),
  );
  assert.equal(f.s.locationKey, "chicago");
  assert.match(serialize(f.s.draft), /eventIds/);
});
test("missing Chicago dates have an explicit private import review, then become selectable as a pair", async () => {
  const f = fixture();
  f.s.room = f.c;
  f.s.locationKey = "chicago";
  const before = getDb()
    .prepare("SELECT count(*) n FROM scheduled_events WHERE guild_id=?")
    .get(f.g).n;
  let i = f.i("tour-review");
  await manager.handle(i);
  assert.match(serialize(i.response), /Approve calendar import/);
  assert.equal(
    getDb()
      .prepare("SELECT count(*) n FROM scheduled_events WHERE guild_id=?")
      .get(f.g).n,
    before,
  );
  i = f.i("tour-approve");
  await manager.handle(i);
  assert.match(i.response.content, /2 added/);
  assert.equal(f.s.offered.length, 2);
  await manager.handle(f.i("select-location-all"));
  assert.equal(f.s.draft.eventIds.length, 2);
  assert.equal(f.s.draft.city, "Chicago");
  assert.equal(f.s.draft.country, "United States");
  assert.equal(f.s.draft.timezone, "America/Chicago");
  assert.equal(store.get(f.g, f.c), undefined);
});
test("tour imports reject unauthorized and stale sessions before any calendar writes", async () => {
  const f = fixture();
  await manager.handle(f.i("tour-audit"));
  const i = f.i("tour-approve", { user: { id: "intruder" } });
  await manager.handle(i);
  assert.match(i.response.content, /authorized/);
  assert.equal(store.concerts(f.g).length, 0);
  rooms.savePanel({
    guildId: f.g,
    channelId: "private",
    messageId: "new-panel",
  });
  const stale = f.i("tour-approve");
  await manager.handle(stale);
  assert.match(stale.response.content, /current Control Center/);
  assert.equal(store.concerts(f.g).length, 0);
});
test("approval cannot silently adopt calendar changes while paging through a tour audit", async () => {
  const f = fixture();
  await manager.handle(f.i("tour-audit"));
  const fingerprint = f.s.importReview.fingerprint;
  f.event();
  await manager.handle(f.i("tour-next"));
  assert.equal(f.s.importReview.fingerprint, fingerprint);
  const i = f.i("tour-approve");
  await manager.handle(i);
  assert.match(i.response.content, /changed/);
  assert.equal(store.concerts(f.g).length, 1);
});
test("tour JSON upload uses a file modal and never imports before the next approval", async () => {
  const f = fixture();
  let i = f.i("tour-upload");
  await manager.handle(i);
  assert.equal(i.modal.toJSON().components[0].component.type, 19);
  const original = global.fetch,
    bytes = Buffer.from(
      JSON.stringify(
        require("../src/services/concertTourCalendar").scopedManifest(
          "chicago",
        ),
      ),
    );
  try {
    global.fetch = async () => ({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    });
    i = f.i("tour-upload-save", {
      fields: {
        getUploadedFiles: () =>
          new Collection([
            [
              "1",
              {
                url: "https://cdn.discordapp.com/attachments/fixture/tour.json",
                size: bytes.length,
              },
            ],
          ]),
      },
    });
    await manager.handle(i);
    assert.match(serialize(i.response), /Approve calendar import/);
    assert.equal(store.concerts(f.g).length, 0);
    await manager.handle(f.i("tour-approve"));
    assert.equal(store.concerts(f.g).length, 2);
  } finally {
    global.fetch = original;
  }
});
test("an out-of-catalog concert with a long venue still produces a valid location menu", async () => {
  const f = fixture();
  f.event("2029-01-01", {
    title: "A concert at a future site",
    eventLocation: "A very long venue name ".repeat(10),
  });
  f.s.locationKey = null;
  const payload = manager.eventPage(f.s);
  for (const row of payload.components) assert.ok(row.toJSON());
});
test("advanced configure command shares the same confirmed-tour eligibility as the graphical picker", async () => {
  const f = fixture(),
    event = f.event("2027-06-18", {
      title: "RUN IT Chicago",
      category: "other",
    });
  const values = {
    city: "Chicago",
    country: "United States",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    events: String(event),
  };
  const i = f.i("unused", {
    options: {
      getSubcommand: () => "configure",
      getChannel: () => ({ id: f.c }),
      getString: (key) => values[key],
    },
  });
  await require("../src/commands/concertCountdown").execute(i);
  assert.match(i.response, /Saved/);
  assert.deepEqual(JSON.parse(store.get(f.g, f.c).config).eventIds, [event]);
});
