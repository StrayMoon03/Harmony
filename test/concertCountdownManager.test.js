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
test("concert-first creation fills both dates and venue, suggests a unique room and persists privately without Save", async () => {
  const f = fixture();
  const events = [f.event(), f.event("2027-06-19")];
  f.base.guild.channels.fetch = async (id) => id ? { id, guildId: f.g, type: ChannelType.GuildText } : new Collection([[f.c, { id: f.c, name: "chicago-concert", guildId: f.g, type: ChannelType.GuildText }]]);
  await manager.handle(f.i("add"));
  const i = f.i("choose-concert", { values: ["chicago"] });
  await manager.handle(i);
  assert.match(serialize(i.response), /Confirm Setup/);
  assert.equal(f.s.room, f.c);
  assert.equal(f.s.auto, true);
  assert.deepEqual(f.s.draft.eventIds, events);
  assert.equal(f.s.draft.venue, "Soldier Field");
  assert.equal(f.s.draft.timezone, "America/Chicago");
  assert.ok(!serialize(i.response).includes("Save configuration"));
  assert.equal(store.get(f.g, f.c), undefined);
  const preview = service.preview;
  service.preview = async () => ({ content: "", files: [{ attachment: Buffer.from("PNG"), name: "test.png" }] });
  try {
    const next = f.i("preview");
    await manager.handle(next);
    assert.match(serialize(next.response), /Approve & Publish/);
    assert.equal(store.get(f.g, f.c).message_id, null);
    assert.equal(store.get(f.g, f.c).enabled, 0);
    assert.equal(f.s.publishRevision, store.get(f.g, f.c).revision);
  } finally { service.preview = preview; }
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
function publicationFixture() {
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
  return f;
}
test("failed publication retains approval and offers a safe retry with unchanged dates and photograph", async () => {
  const f = publicationFixture();
  store.photo(f.g, f.c, Buffer.from("saved photo"), "jpeg");
  const before = store.get(f.g, f.c),
    original = service.refresh;
  let attempts = 0;
  service.refresh = async () => {
    if (++attempts === 1)
      throw Error("Missing effective room permission: Pin Messages");
    return { updated: true };
  };
  try {
    await manager.handle(f.i("publish"));
    let i = f.i("confirm-publish");
    await manager.handle(i);
    assert.equal(f.s.publishRevision, before.revision);
    assert.match(serialize(i.response), /Retry publication/);
    assert.doesNotMatch(serialize(i.response), /Configuration changed/);
    assert.deepEqual(store.get(f.g, f.c), before);
    i = f.i("confirm-publish");
    await manager.handle(i);
    assert.equal(attempts, 2);
    assert.equal(f.s.publishRevision, undefined);
    assert.match(serialize(i.response), /updated and pinned/);
    assert.deepEqual(store.get(f.g, f.c), before);
  } finally {
    service.refresh = original;
  }
});
test("deferred rate-limit publication retains approval and retry controls", async () => {
  const f = publicationFixture(),
    original = service.refresh;
  let attempts = 0;
  service.refresh = async () =>
    ++attempts === 1
      ? { deferred: true, retryAt: "2027-01-01T12:05:00Z" }
      : { updated: true };
  try {
    await manager.handle(f.i("publish"));
    let i = f.i("confirm-publish");
    await manager.handle(i);
    assert.equal(f.s.publishRevision, 0);
    assert.match(serialize(i.response), /Retry publication/);
    i = f.i("confirm-publish");
    await manager.handle(i);
    assert.equal(attempts, 2);
    assert.equal(f.s.publishRevision, undefined);
  } finally {
    service.refresh = original;
  }
});
test("a real photograph change invalidates retained approval after a failed attempt", async () => {
  const f = publicationFixture(),
    original = service.refresh;
  let attempts = 0;
  service.refresh = async () => {
    attempts++;
    throw Error("Temporary publication failure");
  };
  try {
    await manager.handle(f.i("publish"));
    await manager.handle(f.i("confirm-publish"));
    store.photo(f.g, f.c, Buffer.from("changed photo"), "jpeg");
    const i = f.i("confirm-publish");
    await manager.handle(i);
    assert.match(i.response.content, /Configuration changed/);
    assert.equal(attempts, 1);
  } finally {
    service.refresh = original;
  }
});
test("approval is scoped to its concert room even when another room has the same revision", async () => {
  const f = publicationFixture();
  await manager.handle(f.i("publish"));
  const row = store.get(f.g, f.c);
  store.save(f.g, "different-room", JSON.parse(row.config));
  f.s.room = "different-room";
  const i = f.i("confirm-publish");
  await manager.handle(i);
  assert.match(i.response.content, /Configuration changed/);
});
test("canceling publication removes approval so a stale retry cannot publish", async () => {
  const f = publicationFixture();
  await manager.handle(f.i("publish"));
  await manager.handle(f.i("back"));
  assert.equal(f.s.publishRevision, undefined);
  const i = f.i("confirm-publish");
  await manager.handle(i);
  assert.match(i.response.content, /approve publication again/);
});
test("overlapping publication clicks cannot overwrite an in-flight result or start a second attempt", async () => {
  const f = publicationFixture(),
    original = service.refresh;
  let release, entered;
  const started = new Promise((r) => (entered = r)),
    finish = new Promise((r) => (release = r));
  let calls = 0;
  service.refresh = async () => {
    calls++;
    entered();
    await finish;
    return { updated: true };
  };
  try {
    await manager.handle(f.i("publish"));
    const first = manager.handle(f.i("confirm-publish"));
    await started;
    const second = f.i("confirm-publish");
    await manager.handle(second);
    assert.match(second.response.content, /already running/);
    assert.equal(second.deferred, undefined);
    release();
    await first;
    assert.equal(calls, 1);
    assert.equal(f.s.publishRevision, undefined);
    assert.equal(f.s.publicationInFlight, undefined);
  } finally {
    release?.();
    service.refresh = original;
  }
});
test("configuration changed during interaction acknowledgement is rejected before permission checks or publication", async () => {
  const f = publicationFixture();
  await manager.handle(f.i("publish"));
  const i = f.i("confirm-publish");
  i.deferUpdate = async () => {
    i.deferred = true;
    store.save(f.g, f.c, {
      ...JSON.parse(store.get(f.g, f.c).config),
      venue: "Updated venue",
    });
  };
  await manager.handle(i);
  assert.match(i.response.content, /Configuration changed/);
  assert.equal(store.get(f.g, f.c).message_id, null);
  assert.equal(f.s.publishRevision, undefined);
});
test("Check room access is private, read-only and does not consume pending publication approval", async () => {
  const f = publicationFixture(),
    access = require("../src/services/concertCountdownPermissions"),
    original = access.inspect;
  access.inspect = async () => ({
    diagnostics: {
      channelName: "chicago",
      missing: [],
      permissions: access.REQUIRED.map((p) => ({
        name: p.name,
        allowed: true,
      })),
    },
  });
  try {
    await manager.handle(f.i("publish"));
    const before = store.get(f.g, f.c);
    const i = f.i("permissions");
    await manager.handle(i);
    assert.equal(i.deferred, true);
    assert.match(
      i.response.content,
      /All five required permissions are effective/,
    );
    assert.deepEqual(store.get(f.g, f.c), before);
    assert.equal(f.s.publishRevision, before.revision);
  } finally {
    access.inspect = original;
  }
});

async function creation({ ambiguous = false } = {}) {
  const f = fixture();
  f.event(); f.event("2027-06-19");
  const channel = { id: f.c, name: "chicago-concert", guildId: f.g, type: ChannelType.GuildText };
  const channels = new Collection([[f.c, channel]]);
  if (ambiguous) channels.set("second", { ...channel, id: "second", name: "chicago-trip" });
  f.base.guild.channels.fetch = async id => id ? channels.get(id) : channels;
  await manager.handle(f.i("add"));
  await manager.handle(f.i("choose-concert", { values: ["chicago"] }));
  return f;
}
test("home contains exactly three primary options and back, with existing configurations in their own clean list", async () => {
  const f = fixture();
  const event = f.event();
  store.save(f.g, f.c, { city: "Chicago", venue: "Soldier Field", country: "USA", timezone: "America/Chicago", eventIds: [event] });
  store.update(f.g, f.c, { message_id: "existing", enabled: 0, published_at: "before" });
  const before = store.get(f.g, f.c);
  const home = manager.home(f.s);
  assert.deepEqual(home.components.flatMap(r => r.toJSON().components.map(c => c.label)), ["Configured Countdowns", "Add Countdown", "Search for New Concerts", "Back to Control Center"]);
  const list = f.i("configured"); await manager.handle(list);
  assert.match(serialize(list.response), /Chicago — Soldier Field/);
  assert.match(serialize(list.response), /Published · Automatic updates off/);
  await manager.handle(f.i("open", { values: [f.c] }));
  assert.deepEqual(store.get(f.g, f.c), before);
  const text = serialize(manager.detail(f.s));
  for (const label of ["Edit details & dates", "Upload photograph", "Reuse photograph", "Private preview", "Publish / Repair", "Refresh Now", "Check room access", "Last successful update"]) assert.ok(text.includes(label));
});
test("ambiguous room matching leaves setup unassigned and refuses an existing configured room", async () => {
  const f = await creation({ ambiguous: true });
  assert.equal(f.s.room, null);
  assert.match(serialize(manager.setup(f.s)), /no unambiguous match/);
  const preview = f.i("preview"); await manager.handle(preview);
  assert.match(serialize(preview.response), /Choose the concert room/);
  const selected = f.i("setup-room", { values: [f.c] }); await manager.handle(selected);
  assert.equal(f.s.room, f.c);
  const other = { ...f.s.draft, city: "Other city" };
  store.save(f.g, "second", other);
  const before = store.get(f.g, "second");
  await manager.handle(f.i("setup-room", { values: ["second"] }));
  assert.equal(f.s.room, f.c);
  assert.deepEqual(store.get(f.g, "second"), before);
});
test("all announced dates at a location require approved import, and approval populates the complete setup", async () => {
  const f = fixture(); f.event();
  await manager.handle(f.i("add"));
  await manager.handle(f.i("choose-concert", { values: ["chicago"] }));
  assert.equal(f.s.missingDates, true);
  const preview = f.i("preview"); await manager.handle(preview);
  assert.match(serialize(preview.response), /approve the missing calendar dates/);
  await manager.handle(f.i("tour-review"));
  assert.equal(store.concerts(f.g).length, 1);
  await manager.handle(f.i("tour-approve"));
  assert.equal(store.concerts(f.g).length, 2);
  assert.equal(f.s.draft.eventIds.length, 2);
  assert.equal(f.s.missingDates, false);
});
test("creation preview and approval use the reviewed automatic-update preference and offer post-publication navigation", async () => {
  for (const automatic of [true, false]) {
    const f = await creation();
    const originalPreview = service.preview, originalRefresh = service.refresh;
    let calls = 0;
    service.preview = async row => { assert.equal(row.message_id, null); return { content: "", files: [{ attachment: Buffer.from("actual-fixture"), name: "countdown.png" }] }; };
    service.refresh = async (client, g, c, options) => {
      calls++;
      assert.equal(options.publish, true);
      assert.equal(options.expectedRevision, store.get(g, c).revision);
      assert.equal(store.get(g, c).enabled, automatic ? 1 : 0);
      store.update(g, c, { message_id: "published", published_at: "now" });
      return { updated: true };
    };
    try {
      if (!automatic) await manager.handle(f.i("setup-auto"));
      const preview = f.i("preview"); await manager.handle(preview);
      assert.match(serialize(preview.response), /Approve & Publish/);
      assert.equal(calls, 0);
      const confirm = f.i("confirm-publish"); await manager.handle(confirm);
      assert.equal(calls, 1);
      for (const label of ["Create Another Countdown", "Configured Countdowns", "Back to Countdown Manager"]) assert.ok(serialize(confirm.response).includes(label));
      assert.equal(store.get(f.g, f.c).enabled, automatic ? 1 : 0);
      await manager.handle(f.i("confirm-publish"));
      assert.equal(calls, 1);
    } finally { service.preview = originalPreview; service.refresh = originalRefresh; }
  }
});
test("backward navigation preserves details, dates, photograph and daily-update choice and invalidates stale approval", async () => {
  const f = await creation();
  const preview = service.preview;
  service.preview = async () => ({ content: "", files: [] });
  try {
    await manager.handle(f.i("preview"));
    store.photo(f.g, f.c, Buffer.from("saved photograph"), "jpeg");
    f.s.revision = store.get(f.g, f.c).revision;
    await manager.handle(f.i("setup-auto"));
    const before = structuredClone(f.s.draft);
    await manager.handle(f.i("creation-back"));
    await manager.handle(f.i("choose-concert", { values: ["chicago"] }));
    assert.deepEqual(f.s.draft, before);
    assert.equal(f.s.auto, false);
    assert.equal(Buffer.from(store.get(f.g, f.c).photo).toString(), "saved photograph");
    await manager.handle(f.i("preview"));
    await manager.handle(f.i("back"));
    assert.equal(f.s.publishRevision, undefined);
    const approve = f.i("confirm-publish"); await manager.handle(approve);
    assert.match(serialize(approve.response), /approve publication again/);
  } finally { service.preview = preview; }
});
test("new creation retry retains the reviewed configuration, photograph and automatic-update preference", async () => {
  const f = await creation(), preview = service.preview, refresh = service.refresh;
  service.preview = async () => ({ content: "", files: [] });
  let count = 0;
  service.refresh = async () => {
    if (!count++) throw Error("Temporary Discord permission failure");
    store.update(f.g, f.c, { message_id: "same-message", published_at: "now" });
    return { updated: true };
  };
  try {
    await manager.handle(f.i("preview"));
    const first = f.i("confirm-publish"); await manager.handle(first);
    assert.match(serialize(first.response), /Retry publication/);
    assert.ok(f.s.publishRevision !== undefined);
    const config = store.get(f.g, f.c).config;
    await manager.handle(f.i("confirm-publish"));
    assert.equal(count, 2);
    assert.equal(store.get(f.g, f.c).enabled, 1);
    assert.equal(store.get(f.g, f.c).config, config);
  } finally { service.preview = preview; service.refresh = refresh; }
});
test("source discovery stays private, requires announcement review and explicit approved calendar import", async () => {
  const f = fixture(), discovery = require("../src/services/concertCountdownDiscovery"), search = discovery.search;
  discovery.search = async () => ({ checkedAt: "2026-11-24T12:00Z", sources: [{ provider: "jype-notice", ok: true }], items: [{ title: "RUN IT Chicago additional date", summary: "Concert 2027-06-20 at Soldier Field", url: "https://straykids.jype.com/notice/123", location: require("../src/services/concertTourCalendar").bundled.locations.find(l => l.key === "chicago"), dates: ["2027-06-20"] }] });
  try {
    await manager.handle(f.i("discover"));
    const check = f.i("discovery-run"); await manager.handle(check);
    assert.match(serialize(check.response), /announcements to review/);
    assert.equal(store.concerts(f.g).length, 0);
    await manager.handle(f.i("discovery-item", { values: ["0"] }));
    const prepare = f.i("discovery-prepare"); await manager.handle(prepare);
    assert.equal(prepare.modal.toJSON().components.length, 5);
    await manager.handle(f.i("discovery-fields", { fields: { getTextInputValue: k => ({ city: "Chicago", country: "United States", venue: "Soldier Field", timezone: "America/Chicago", dates: "2027-06-20" })[k] } }));
    assert.equal(store.concerts(f.g).length, 0);
    assert.equal(f.s.importReview.plan.counts.missing, 1);
    await manager.handle(f.i("tour-approve"));
    assert.equal(store.concerts(f.g).length, 1);
    assert.equal(store.concerts(f.g)[0].link, "https://straykids.jype.com/notice/123");
    assert.equal(store.list(f.g).length, 0);
  } finally { discovery.search = search; }
});
test("new UI pages validate Discord limits, pagination, configured markers and private close navigation", async () => {
  const f = await creation();
  const pages = [manager.home(f.s), manager.configured(f.s), manager.concertPicker(f.s), manager.setup(f.s), manager.discoveryPage(f.s)];
  for (const page of pages) {
    assert.ok(page.components.length <= 5);
    for (const row of page.components) {
      const json = row.toJSON();
      assert.ok(json.components.length <= 5);
      for (const c of json.components) if (c.options) assert.ok(c.options.length <= 25);
    }
    for (const e of page.embeds) e.toJSON();
  }
  const offered = [...f.s.offeredLocations];
  await manager.handle(f.i("concert-next"));
  assert.deepEqual(f.s.offeredLocations, offered); // All bundled locations fit on the same page.
  assert.ok(offered.includes("toronto") && offered.includes("vancouver"));
  const close = f.i("close", { deleteReply: async () => {} }); await manager.handle(close);
  assert.equal(manager.authorize(f.i("add"), f.s), true); // panel access is unchanged
  const expired = f.i("add"); await manager.handle(expired);
  assert.match(expired.response.content, /expired/);
});
test("new setup uploads and reuses photographs, and reopening its private draft preserves the automatic-update preference", async () => {
  const f = await creation(), originalFetch = global.fetch;
  const bytes = require("node:child_process").spawnSync("python3", ["-c", "from PIL import Image; import sys; Image.new('RGB',(300,150),'orange').save(sys.stdout.buffer,format='PNG')"]).stdout;
  global.fetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) });
  try {
    const upload = f.i("photo-save", { fields: { getUploadedFiles: () => new Collection([["1", { url: "https://cdn.discordapp.com/attachments/fixture/photo.png", size: bytes.length }]]) } });
    await manager.handle(upload);
    assert.match(serialize(upload.response), /Confirm Setup/);
    assert.ok(store.get(f.g, f.c).photo.length);
    assert.equal(store.get(f.g, f.c).message_id, null);
    await manager.handle(f.i("setup-auto"));
    const before = Buffer.from(store.get(f.g, f.c).photo);
    const id = store.photos(f.g)[0].id;
    await manager.handle(f.i("photos"));
    await manager.handle(f.i("reuse-photo", { values: [id] }));
    assert.deepEqual(Buffer.from(store.get(f.g, f.c).photo), before);
    await manager.handle(f.i("configured"));
    await manager.handle(f.i("open", { values: [f.c] }));
    assert.equal(f.s.creating, true);
    assert.equal(f.s.auto, false);
    assert.deepEqual(Buffer.from(store.get(f.g, f.c).photo), before);
    assert.equal(store.get(f.g, f.c).enabled, 0);
    assert.equal(f.s.draft.eventIds.length, 2);
  } finally { global.fetch = originalFetch; }
});
test("location search finds city/country/venue/date and existing locations route to management without overwriting", async () => {
  const f = await creation();
  const draft = structuredClone(f.s.draft);
  store.save(f.g, f.c, draft);
  store.update(f.g, f.c, { message_id: "owner-published", enabled: 0, published_at: "before" });
  const before = store.get(f.g, f.c);
  f.s.creating = false;
  for (const query of ["Chicago", "United States", "Soldier Field", "2027-06-19"]) {
    await manager.handle(f.i("add"));
    const search = f.i("search-save", { fields: { getTextInputValue: () => query } });
    await manager.handle(search);
    assert.ok(f.s.offeredLocations.includes("chicago"));
    assert.match(serialize(search.response), /Already configured/);
  }
  const selected = f.i("choose-concert", { values: ["chicago"] });
  await manager.handle(selected);
  assert.match(serialize(selected.response), /Publish \/ Repair/);
  assert.deepEqual(store.get(f.g, f.c), before);
});
test("correcting a saved new draft's room moves its photograph and preferences without leaving another draft or touching a published room", async () => {
  const f = await creation(), preview = service.preview;
  service.preview = async () => ({ content: "", files: [] });
  try { await manager.handle(f.i("preview")); } finally { service.preview = preview; }
  store.photo(f.g, f.c, Buffer.from("photo to keep"), "jpeg");
  f.s.revision = store.get(f.g, f.c).revision;
  f.base.guild.channels.fetch = async id => ({ id, guildId: f.g, type: ChannelType.GuildText });
  const change = f.i("setup-room", { values: ["corrected-room"] }); await manager.handle(change);
  assert.equal(store.get(f.g, f.c), undefined);
  assert.equal(f.s.room, "corrected-room");
  assert.equal(Buffer.from(store.get(f.g, "corrected-room").photo).toString(), "photo to keep");
  assert.equal(JSON.parse(store.get(f.g, "corrected-room").config).setupAuto, true);
  assert.equal(store.list(f.g).length, 1);
  store.update(f.g, "corrected-room", { message_id: "existing-pin", published_at: "before" });
  const before = store.get(f.g, "corrected-room");
  assert.throws(() => store.moveDraft(f.g, "corrected-room", "another", before.revision), /cannot be moved/);
  assert.deepEqual(store.get(f.g, "corrected-room"), before);
});
test("actual private creation preview and service publication recover a failed pin in the same message", async () => {
  const f = await creation();
  const roles = new Collection([[f.g, { id: f.g, name: "@everyone" }]]);
  const bot = { id: "bot", guild: f.base.guild, roles: { cache: roles } };
  const calls = { send: 0, edit: 0 }, messages = new Collection();
  let failPin = true;
  const channel = {
    id: f.c, guildId: f.g, type: ChannelType.GuildText, name: "chicago-concert",
    overwritesFor: () => ({ roles: [] }), permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async o => o.message ? messages.get(o.message) : messages,
      fetchPins: async () => ({ items: [...messages.values()].filter(m => m.pinned).map(message => ({ message })), hasMore: false }),
    },
    send: async p => {
      calls.send++;
      const message = { id: "existing-countdown", channelId: f.c, author: { id: "bot" }, content: p.content, attachments: new Collection(p.files.map((file, i) => [String(i), { name: file.name }])), pinned: false,
        pin: async () => { if (failPin) throw Object.assign(Error("Pin refused"), { code: 50013 }); message.pinned = true; },
        edit: async p => { calls.edit++; assert.equal(p.content, ""); return message; },
      };
      messages.set(message.id, message);
      return message;
    },
  };
  f.base.guild.roles = { cache: roles, fetch: async () => roles };
  f.base.guild.members = { fetchMe: async () => bot };
  f.base.guild.channels.fetch = async () => channel;
  const client = { user: { id: "bot" }, guilds: { cache: new Collection([[f.g, f.base.guild]]), fetch: async () => f.base.guild } };
  const open = f.i("home"); await manager.open(open);
  assert.equal(open.response.flags, 64);
  const preview = f.i("preview"); await manager.handle(preview);
  assert.equal(preview.response.content, "");
  assert.equal(preview.response.files[0].attachment.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(calls.send, 0);
  const first = f.i("confirm-publish", { client }); await manager.handle(first);
  assert.match(serialize(first.response), /Retry publication/);
  assert.equal(store.get(f.g, f.c).message_id, "existing-countdown");
  assert.equal(store.get(f.g, f.c).enabled, 1);
  failPin = false;
  const retry = f.i("confirm-publish", { client }); await manager.handle(retry);
  assert.match(serialize(retry.response), /Countdown Published/);
  assert.equal(calls.send, 1);
  assert.equal(calls.edit, 1);
  assert.equal(messages.first().pinned, true);
  assert.equal(store.get(f.g, f.c).message_id, "existing-countdown");
});
test("a slow creation preview cannot be approved for a different room or a configuration edited during rendering", async () => {
  const f = await creation(), preview = service.preview;
  let release;
  service.preview = async () => { await new Promise(resolve => { release = resolve; }); return { content: "", files: [] }; };
  try {
    const first = f.i("preview"), work = manager.handle(first);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const room = f.s.room, change = f.i("setup-room", { values: ["wrong-room"] });
    await manager.handle(change);
    assert.equal(f.s.room, room);
    assert.match(serialize(change.response), /Wait for its result/);
    store.save(f.g, f.c, { ...f.s.draft, venue: "Venue changed by another admin" });
    release(); await work;
    assert.match(serialize(first.response), /Configuration changed during preview/);
    assert.equal(f.s.publishRevision, undefined);
    assert.equal(f.s.uiInFlight, undefined);
    assert.equal(store.get(f.g, f.c).message_id, null);
  } finally { service.preview = preview; if (release) release(); }
});

test('Add Countdown exposes every bundled location in supported menus, including Toronto and Vancouver without paging', async () => {
  const f = fixture(), tour = require('../src/services/concertTourCalendar');
  await manager.handle(f.i('add'));
  const page = manager.concertPicker(f.s), options = page.components.flatMap(r => r.toJSON().components).flatMap(c => c.options || []);
  assert.deepEqual(options.map(o => o.value).sort(), tour.bundled.locations.map(l => l.key).sort());
  assert.equal(options.length, 34); assert.equal(new Set(options.map(o => o.value)).size, 34);
  for (const key of ['toronto', 'vancouver']) {
    const menu = page.components.map(r => r.toJSON().components[0]).find(c => c.options?.some(o => o.value === key));
    assert.equal(menu.options.length, 9); assert.match(menu.custom_id, /choose-concert-more$/);
    const chosen = f.i('choose-concert-more', { values: [key] }); await manager.handle(chosen);
    const location = tour.bundled.locations.find(l => l.key === key);
    assert.equal(f.s.draft.city, location.city); assert.equal(f.s.draft.timezone, location.timezone);
    assert.equal(f.s.auto, true); assert.equal(f.s.missingDates, true);
    // Read-only visibility does not import missing dates or publish a countdown.
    assert.equal(store.concerts(f.g).length, 0); assert.equal(store.list(f.g).length, 0);
    await manager.handle(f.i('add'));
    const search = f.i('search-save', { fields: { getTextInputValue: () => location.city } }); await manager.handle(search);
    assert.deepEqual(f.s.offeredLocations, [key]);
    await manager.handle(f.i('add'));
  }
});
test('Toronto and Vancouver reuse approved records, populate all dates, and import only after review without duplicates', async () => {
  const tour = require('../src/services/concertTourCalendar');
  for (const key of ['toronto', 'vancouver']) {
    const f = fixture(), manifest = tour.scopedManifest(key), l = manifest.locations[0];
    const existing = calendar.createCalendarEvent({ guildId: f.g, calendarChannelId: 'calendar', title: `Stray Kids World Tour RUN IT — ${l.city}`, eventLocation: l.venue, timezone: l.timezone, eventTimezone: l.timezone, eventDate: l.dates[0].date, calendarType: 'stray_kids', category: 'concert', allDay: true, createdBy: 'owner' });
    const review = tour.audit(f.g, manifest), count = store.concerts(f.g).length;
    assert.equal(count, 1); assert.equal(review.entries[0].eventId, existing);
    tour.importConfirmed(f.g, manifest, review.fingerprint, 'owner');
    const again = tour.audit(f.g, manifest); const result = tour.importConfirmed(f.g, manifest, again.fingerprint, 'owner');
    assert.equal(result.created, 0); assert.equal(store.concerts(f.g).length, l.dates.length);
    await manager.handle(f.i('add'));
    const chosen = f.i('choose-concert-more', { values: [key] }); await manager.handle(chosen);
    assert.equal(f.s.draft.eventIds.length, l.dates.length); assert.ok(f.s.draft.eventIds.includes(existing));
    assert.equal(f.s.missingDates, false); assert.equal(f.s.auto, true);
    assert.equal(store.list(f.g).length, 0);
  }
});
test('Add Countdown still paginates approved locations beyond the two native menu limit', async () => {
  const f = fixture(), tour = require('../src/services/concertTourCalendar'), original = tour.groups;
  tour.groups = () => Array.from({ length: 60 }, (_, n) => ({ key: 'fixture-' + n, city: 'City ' + n, country: 'Country', venue: 'Venue', events: [], audit: [] }));
  try {
    await manager.handle(f.i('add')); assert.equal(f.s.offeredLocations.length, 50);
    await manager.handle(f.i('concert-next')); assert.equal(f.s.offeredLocations.length, 10);
    assert.equal(f.s.offeredLocations[0], 'fixture-50');
    await manager.handle(f.i('concert-prev')); assert.equal(f.s.offeredLocations[0], 'fixture-0');
  } finally { tour.groups = original; }
});
test('optional topic errors are visible privately in the existing manager without adding primary controls', async () => {
  const f = fixture(), id = f.event();
  store.save(f.g, f.c, { guildId: f.g, city: 'Chicago', country: 'United States', venue: 'Soldier Field', timezone: 'America/Chicago', eventIds: [id] });
  store.update(f.g, f.c, { message_id: 'existing', published_at: 'before', topic_error: 'Harmony needs Manage Channels to update this topic.', topic_retry_at: '2027-01-01T12:05:00Z' });
  f.s.room = f.c;
  const view = manager.detail(f.s); assert.match(JSON.stringify(view.embeds), /Channel topic/); assert.match(JSON.stringify(view.embeds), /Manage Channels/);
  const home = manager.home(f.s); assert.equal(home.components.length, 4);
  assert.equal(view.components.flatMap(r => r.toJSON().components).filter(c => /Publish|Refresh Now|Check room access/.test(c.label)).length, 3);
  assert.deepEqual(view.allowedMentions, { parse: [] });
});
