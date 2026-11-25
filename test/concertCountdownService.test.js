const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
process.env.HARMONY_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "countdown-service-")),
  "test.sqlite",
);
const {
  Collection,
  ChannelType,
  PermissionFlagsBits: P,
} = require("discord.js");
const store = require("../src/stores/concertCountdownStore"),
  calendar = require("../src/stores/eventSchedulerStore"),
  db = require("../src/db/sqlite");
const images = require("../src/services/concertCountdownRender"),
  service = require("../src/services/concertCountdownService");
images.render = async () => Buffer.from("rendered PNG");
let seq = 1000;
function fixture() {
  const g = "g" + ++seq,
    c = String(++seq),
    messages = new Collection(),
    calls = { fetch: 0, pins: 0, send: 0, pin: 0, edit: 0 };
  const event = calendar.createCalendarEvent({
    guildId: g,
    calendarChannelId: "cal",
    title: "Chicago concert",
    timezone: "America/Chicago",
    eventDate: "2027-06-18",
    eventLocation: "Soldier Field",
    calendarType: "stray_kids",
    category: "concert",
    allDay: true,
    createdBy: "admin",
  });
  store.save(g, c, {
    guildId: g,
    city: "Chicago",
    country: "USA",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: [event],
  });
  const f = {
    g,
    c,
    event,
    messages,
    calls,
    allow: true,
    pinError: false,
    sendError: null,
    editError: null,
  };
  function message(content = "", author = "bot") {
    const m = {
      id: String(++seq),
      channelId: c,
      content,
      attachments: new Collection(),
      author: { id: author },
      pinned: false,
      edit: async (p) => {
        calls.edit++;
        if (f.editError) throw f.editError;
        m.content = p.content;
        m.attachments = new Collection(
          p.files.map((file, i) => [String(i), {
            id: String(i), name: file.name, description: file.description,
          }]),
        );
        m.lastEdit = p;
        return m;
      },
      pin: async () => {
        calls.pin++;
        if (f.pinError) throw Error("Cannot pin");
        m.pinned = true;
      },
    };
    messages.set(m.id, m);
    return m;
  }
  f.message = message;
  const channel = {
    guildId: g,
    type: ChannelType.GuildText,
    name: "chicago",
    overwritesFor: () => ({ roles: [] }),
    permissionsFor: () => ({
      has: (flag) => f.allow && !f.missingFlags?.includes(flag),
    }),
    messages: {
      fetch: async (options) => {
        calls.fetch++;
        if (options.message) {
          if (!messages.has(options.message))
            throw Object.assign(Error("Unknown Message"), { code: 10008 });
          return messages.get(options.message);
        }
        return new Collection(
          [...messages.values()]
            .filter(
              (m) => !options.before || BigInt(m.id) < BigInt(options.before),
            )
            .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
            .slice(0, options.limit)
            .map((m) => [m.id, m]),
        );
      },
      fetchPins: async () => {
        calls.pins++;
        return {
          items: [...messages.values()]
            .filter((m) => m.pinned)
            .map((m) => ({ message: m, pinnedAt: new Date() })),
          hasMore: false,
        };
      },
    },
    send: async (p) => {
      calls.send++;
      if (f.sendError === "before")
        throw Error("Connection failed before send");
      const m = message(p.content);
      m.attachments = new Collection(
        p.files.map((file, i) => [String(i), {
          id: String(i), name: file.name, description: file.description,
        }]),
      );
      m.sent = p;
      if (f.sendError === "after") throw Error("Connection failed after send");
      return m;
    },
  };
  const guild = { id: g };
  const roles = new Collection([[g, { id: g, name: "@everyone" }]]);
  const member = { id: "bot", guild, roles: { cache: roles } };
  guild.roles = { cache: roles, fetch: async () => roles };
  guild.members = { fetchMe: async () => member };
  guild.channels = { fetch: async () => channel };
  f.guild = guild;
  f.client = {
    user: { id: "bot" },
    guilds: { cache: new Map([[g, guild]]), fetch: async () => guild },
    channels: { fetch: async () => channel },
  };
  f.channel = channel;
  f.row = () => store.get(g, c);
  f.refresh = (opts) =>
    service.refresh(f.client, g, c, {
      now: new Date("2027-01-01T12:00Z"),
      ...opts,
    });
  f.retry = () => store.update(g, c, { retry_at: null });
  return f;
}
test("initial publication requires approval; private previews never call Discord", async () => {
  const f = fixture();
  await assert.rejects(f.refresh(), /requires approval/);
  assert.equal(f.calls.send, 0);
  const before = f.row();
  const p = await service.preview(before);
  assert.match(p.files[0].name, /^harmony-countdown-[a-f0-9]{64}\.png$/);
  assert.equal(p.content, "");
  assert.deepEqual(f.row(), before);
  assert.equal(f.calls.fetch, 0);
});
test("explicit publication pins one message and preserves ID across restart", async () => {
  const f = fixture();
  await f.refresh({ publish: true });
  assert.equal(f.calls.send, 1);
  assert.equal(f.calls.pin, 1);
  assert.equal(f.row().enabled, 0);
  assert.ok(f.row().published_at);
  const id = f.row().message_id;
  db.closeDb();
  assert.equal(f.row().message_id, id);
  const calls = { ...f.calls };
  await f.refresh();
  assert.deepEqual(f.calls, calls);
  assert.equal(f.calls.send, 1);
});
test("refresh edits existing attachments and does not mention members", async () => {
  const f = fixture();
  await f.refresh({ publish: true });
  await f.refresh({ force: true });
  assert.equal(f.calls.send, 1);
  assert.equal(f.calls.edit, 1);
  const m = f.messages.get(f.row().message_id);
  assert.deepEqual(m.lastEdit.attachments, []);
  assert.deepEqual(m.lastEdit.allowedMentions, { parse: [] });
  assert.ok(m.lastEdit.files[0].description);
});
test("failed pin persists message and a later repair never sends a duplicate", async () => {
  const f = fixture();
  f.pinError = true;
  await assert.rejects(f.refresh({ publish: true }), /Cannot pin/);
  const id = f.row().message_id;
  assert.ok(id);
  assert.equal(f.calls.send, 1);
  f.pinError = false;
  f.retry();
  await f.refresh({ publish: true });
  assert.equal(f.row().message_id, id);
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().last_error, null);
});
test("crash between send and ID persistence recovers unpinned message beyond last 100", async () => {
  const f = fixture();
  f.sendError = "after";
  await assert.rejects(f.refresh({ publish: true }), /after send/);
  assert.ok(f.row().delivery);
  assert.equal(f.row().message_id, null);
  for (let n = 0; n < 250; n++) f.message("chat", "member");
  f.sendError = null;
  f.retry();
  db.closeDb();
  await f.refresh({ publish: true });
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().delivery, null);
  assert.ok(f.row().message_id);
  assert.ok(f.row().last_success);
});
test("failed send before delivery can be retried with the durable intent", async () => {
  const f = fixture();
  f.sendError = "before";
  await assert.rejects(f.refresh({ publish: true }), /before send/);
  assert.ok(f.row().delivery);
  assert.equal(f.messages.size, 0);
  f.sendError = null;
  f.retry();
  await f.refresh({ publish: true });
  assert.equal(f.messages.size, 1);
});
test("deleted message is repaired once; unrelated pins are untouched", async () => {
  const f = fixture();
  await f.refresh({ publish: true });
  f.messages.delete(f.row().message_id);
  const other = f.message("unrelated", "member");
  other.pinned = true;
  await f.refresh({ force: true });
  assert.equal(f.calls.send, 2);
  assert.equal(other.pinned, true);
  assert.equal(f.messages.size, 2);
});
test("legacy/recovered pinned message is reused", async () => {
  const f = fixture();
  const m = f.message(
    "Old card\nYoutiful STAY • World Tour Countdown [" + f.c + "]",
  );
  m.pinned = true;
  await f.refresh({ publish: true });
  assert.equal(f.calls.send, 0);
  assert.equal(f.row().message_id, m.id);
});
test("concurrent updates share a lock and exactly one initial message", async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([
    f.refresh({ publish: true }),
    f.refresh({ publish: true }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(f.calls.send, 1);
});
test("database lease protects against other processes; expired lease recovers", async () => {
  const f = fixture(),
    token = store.acquire(f.g, f.c);
  await assert.rejects(f.refresh({ publish: true }), /already running/);
  assert.equal(f.calls.send, 0);
  db.getDb()
    .prepare("UPDATE concert_countdowns SET lease_until=0 WHERE guild_id=?")
    .run(f.g);
  f.retry();
  await f.refresh({ publish: true });
  assert.equal(f.calls.send, 1);
  store.release(f.g, f.c, token);
});
test("rate limits save status and honor retry delay without repeat Discord calls", async () => {
  const f = fixture();
  f.channel.send = async () => {
    f.calls.send++;
    throw Object.assign(Error("Rate limited"), {
      status: 429,
      retry_after: 90,
    });
  };
  await assert.rejects(f.refresh({ publish: true }), /Rate limited/);
  const calls = { ...f.calls };
  assert.equal((await f.refresh({ publish: true })).deferred, true);
  assert.deepEqual(f.calls, calls);
  assert.match(f.row().last_error, /Rate limited/);
});
test("missing permissions preserve draft and produce an actionable error", async () => {
  const f = fixture();
  f.allow = false;
  await assert.rejects(f.refresh({ publish: true }), /Pin Messages/);
  assert.equal(f.calls.send, 0);
  assert.equal(f.row().message_id, null);
});
test("disabled countdowns are skipped by automatic jobs; manual refresh remains available", async () => {
  const f = fixture();
  await f.refresh({ publish: true });
  assert.deepEqual(await f.refresh({ scheduled: true, force: true }), {
    skipped: true,
  });
  assert.equal(f.calls.edit, 0);
  await f.refresh({ force: true });
  assert.equal(f.calls.edit, 1);
});
test("local-day changes, missed days and approved reschedules update the same message", async () => {
  const f = fixture();
  await f.refresh({ publish: true });
  store.update(f.g, f.c, { enabled: 1 });
  await f.refresh({ scheduled: true, now: new Date("2027-06-17T12:00Z") });
  assert.match(f.messages.get(f.row().message_id).attachments.first().description, /TOMORROW!/);
  calendar.updateEvent(f.g, f.event, { event_date: "2027-06-20" });
  await f.refresh({ scheduled: true, now: new Date("2027-06-17T12:00Z") });
  assert.match(f.messages.get(f.row().message_id).attachments.first().description, /3 days to go/);
  calendar.cancelEvent(f.g, f.event, "admin");
  await f.refresh({ scheduled: true, now: new Date("2027-06-17T12:00Z") });
  assert.match(
    f.messages.get(f.row().message_id).attachments.first().description,
    /No active concert dates/,
  );
  assert.equal(f.calls.send, 1);
});
test("health check repairs unpinning without an unnecessary attachment edit", async () => {
  const f = fixture();
  await f.refresh({ publish: true });
  f.messages.get(f.row().message_id).pinned = false;
  await f.refresh({ now: new Date("2027-01-01T19:00Z") });
  assert.equal(f.calls.edit, 0);
  assert.equal(f.calls.pin, 2);
});
test("stored photograph survives reopen and can be reused only within its server", () => {
  const f = fixture();
  store.photo(f.g, f.c, Buffer.from("photo"), "jpeg");
  const id = store.photos(f.g)[0].id;
  db.closeDb();
  assert.equal(Buffer.from(f.row().photo).toString(), "photo");
  const other = fixture();
  assert.throws(
    () => store.reusePhoto(other.g, other.c, id),
    /no longer available/,
  );
  const c2 = String(++seq);
  store.save(f.g, c2, JSON.parse(f.row().config));
  store.reusePhoto(f.g, c2, id);
  assert.equal(Buffer.from(store.get(f.g, c2).photo).toString(), "photo");
});
test("configuration writes use optimistic revision and do not overwrite newer changes", () => {
  const f = fixture(),
    c = JSON.parse(f.row().config),
    revision = f.row().revision;
  store.save(f.g, f.c, { ...c, city: "New city" }, revision);
  assert.throws(() => store.save(f.g, f.c, c, revision), /changed/);
  assert.equal(JSON.parse(f.row().config).city, "New city");
});
test("paginated pin recovery uses the installed Discord.js response shape", async () => {
  const f = fixture(),
    m = f.message("card\nYoutiful STAY • World Tour Countdown [" + f.c + "]");
  let n = 0;
  f.channel.messages.fetchPins = async (options) => {
    n++;
    if (n === 1)
      return {
        items: [
          { message: f.message("other"), pinnedAt: new Date("2026-01-01") },
        ],
        hasMore: true,
      };
    assert.ok(options.before);
    return { items: [{ message: m }], hasMore: false };
  };
  await f.refresh({ publish: true });
  assert.equal(f.calls.send, 0);
  assert.equal(n, 2);
});
test("legacy unpinned sends are recovered safely during schema upgrade", async () => {
  const f = fixture();
  const m = f.message(
    "Legacy card\nYoutiful STAY • World Tour Countdown [" + f.c + "]",
  );
  store.update(f.g, f.c, { legacy_recovery: 1 });
  for (let n = 0; n < 120; n++) f.message("chat", "member");
  await f.refresh({ publish: true });
  assert.equal(f.calls.send, 0);
  assert.equal(f.row().message_id, m.id);
  assert.equal(f.row().legacy_recovery, 0);
});
test("incomplete or unavailable recovery history never authorizes a second send", async () => {
  const f = fixture();
  store.update(f.g, f.c, {
    delivery: JSON.stringify({ after: "0", nonce: "fixture" }),
  });
  f.channel.messages.fetch = async () => {
    throw Object.assign(Error("History unavailable"), { code: 50013 });
  };
  await assert.rejects(
    f.refresh({ publish: true }),
    (e) =>
      e.code === 50013 &&
      /recover a previous countdown delivery/.test(e.message) &&
      e.cause?.message === "History unavailable",
  );
  assert.equal(f.calls.send, 0);
  assert.ok(f.row().delivery);
});
test("scheduler catches up immediately on startup and exposes a stop function", async () => {
  db.getDb().prepare("UPDATE concert_countdowns SET enabled=0").run();
  const f = fixture();
  await f.refresh({ publish: true });
  store.update(f.g, f.c, { enabled: 1, fingerprint: null });
  let resolveEdit;
  const edited = new Promise((resolve) => {
    resolveEdit = resolve;
  });
  const m = f.messages.get(f.row().message_id),
    original = m.edit;
  m.edit = async (p) => {
    const result = await original(p);
    resolveEdit();
    return result;
  };
  const stop = service.start(f.client);
  try {
    await edited;
    assert.equal(f.calls.edit, 1);
    assert.equal(f.calls.send, 1);
  } finally {
    stop();
  }
});
test("manual permission retry reloads access immediately and preserves saved dates and photograph", async () => {
  const f = fixture();
  store.photo(f.g, f.c, Buffer.from("saved venue photo"), "jpeg");
  const before = f.row();
  f.missingFlags = [P.PinMessages];
  await assert.rejects(
    f.refresh({ publish: true, force: true }),
    /Missing effective room permission: Pin Messages/,
  );
  assert.equal(f.row().revision, before.revision);
  assert.equal(f.row().config, before.config);
  assert.deepEqual(f.row().photo, before.photo);
  assert.equal(f.row().retry_kind, "permission");
  assert.equal(f.calls.send, 0);
  f.missingFlags = [];
  await f.refresh({ publish: true, force: true });
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().revision, before.revision);
  assert.equal(f.row().retry_kind, null);
});
test("scheduled jobs honor permission backoff even after roles have been corrected", async () => {
  const f = fixture();
  store.update(f.g, f.c, { enabled: 1 });
  f.missingFlags = [P.PinMessages];
  await assert.rejects(
    f.refresh({ publish: true, force: true }),
    /Pin Messages/,
  );
  f.missingFlags = [];
  // Publication was never completed, so automatic jobs cannot bypass initial approval either.
  const result = await f.refresh({ publish: true, scheduled: true });
  assert.equal(result.deferred, true);
  assert.equal(f.calls.send, 0);
});
test("manual retries never bypass a persisted Discord rate limit, even after a photo/configuration change", async () => {
  const f = fixture();
  const send = f.channel.send;
  f.channel.send = async () => {
    throw Object.assign(Error("Rate limited"), {
      status: 429,
      retry_after: 90,
    });
  };
  await assert.rejects(
    f.refresh({ publish: true, force: true }),
    /Rate limited/,
  );
  const retryAt = f.row().retry_at;
  store.photo(f.g, f.c, Buffer.from("new photo"), "jpeg");
  assert.equal(f.row().retry_at, retryAt);
  store.save(f.g, f.c, JSON.parse(f.row().config));
  assert.equal(f.row().retry_at, retryAt);
  f.channel.send = send;
  assert.equal(
    (await f.refresh({ publish: true, force: true })).deferred,
    true,
  );
  assert.equal(f.calls.send, 0);
  await f.refresh({
    publish: true,
    force: true,
    now: new Date("2027-01-01T12:01:31Z"),
  });
  assert.equal(f.calls.send, 1);
});
test("fresh permission requests that are rate limited retain the cooldown through manual retries", async () => {
  const f = fixture();
  const fetch = f.guild.roles.fetch;
  f.guild.roles.fetch = async () => {
    throw Object.assign(Error("Rate limited"), {
      status: 429,
      retry_after: 90,
    });
  };
  await assert.rejects(
    f.refresh({ publish: true, force: true }),
    /could not be verified/,
  );
  assert.equal(f.row().retry_kind, "rate_limit");
  f.guild.roles.fetch = fetch;
  assert.equal(
    (await f.refresh({ publish: true, force: true })).deferred,
    true,
  );
  assert.equal(f.calls.send, 0);
});
test("retry after a live pin refusal reuses the saved message and keeps the same configuration revision", async () => {
  const f = fixture();
  const message = f.message;
  f.message = message;
  const send = f.channel.send;
  f.channel.send = async (p) => {
    const m = await send(p);
    m.pin = async () => {
      throw Object.assign(Error("Missing Permissions"), {
        code: 50013,
        status: 403,
      });
    };
    return m;
  };
  const revision = f.row().revision;
  await assert.rejects(
    f.refresh({ publish: true, force: true }),
    /pin the countdown \(50013\)/,
  );
  const id = f.row().message_id;
  assert.ok(id);
  assert.equal(f.row().retry_kind, "permission");
  f.messages.get(id).pin = async () => {
    f.messages.get(id).pinned = true;
  };
  await f.refresh({ publish: true, force: true });
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().message_id, id);
  assert.equal(f.row().revision, revision);
});
test("legacy generic permission failures can be retried without editing the configuration", async () => {
  const f = fixture();
  store.update(f.g, f.c, {
    last_error: require("../src/services/concertCountdownPermissions")
      .LEGACY_PERMISSION_ERROR,
    retry_at: "2027-01-01T12:05:00Z",
  });
  await f.refresh({ publish: true, force: true });
  assert.equal(f.calls.send, 1);
});
test("publication rejects an actual configuration revision change before any Discord request", async () => {
  const f = fixture(),
    revision = f.row().revision;
  store.save(f.g, f.c, JSON.parse(f.row().config));
  await assert.rejects(
    f.refresh({ publish: true, force: true, expectedRevision: revision }),
    (e) => e.code === "COUNTDOWN_CONFIGURATION_CHANGED",
  );
  assert.equal(f.calls.send, 0);
  assert.equal(f.calls.fetch, 0);
});
test("lost send response can be retried immediately without losing the durable delivery record or duplicating", async () => {
  const f = fixture();
  f.sendError = "after";
  await assert.rejects(f.refresh({ publish: true, force: true }), /after send/);
  assert.ok(f.row().delivery);
  f.sendError = null;
  await f.refresh({ publish: true, force: true });
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().delivery, null);
});
function isolateRenderingWork() {
  db.getDb()
    .prepare("UPDATE concert_countdowns SET enabled=0,render_version=?")
    .run(images.RENDER_VERSION);
}
async function upgradeFixture() {
  isolateRenderingWork();
  const f = fixture();
  await f.refresh({ publish: true });
  store.update(f.g, f.c, { render_version: null });
  return f;
}
const upgradeTime = () => new Date("2027-01-01T12:00Z");
test("renderer version alone changes the fingerprint without changing dates, photo or countdown numbers", () => {
  const f = fixture(),
    row = f.row(),
    m = service.model(row, upgradeTime());
  assert.notEqual(
    service.fingerprint(m, row, "previous-renderer"),
    service.fingerprint(m, row, images.RENDER_VERSION),
  );
});
test("published cards with automatic updates disabled are upgraded once in place with their saved data intact", async () => {
  const f = await upgradeFixture();
  store.photo(f.g, f.c, Buffer.from("saved venue photograph"), "jpeg");
  const before = f.row(),
    id = before.message_id,
    pinCalls = f.calls.pin;
  const result = await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(result.updated, 1);
  assert.equal(f.calls.send, 1);
  assert.equal(f.calls.edit, 1);
  assert.equal(f.calls.pin, pinCalls);
  assert.equal(f.messages.get(id).pinned, true);
  const after = f.row();
  for (const key of [
    "enabled",
    "message_id",
    "config",
    "photo",
    "photo_type",
    "revision",
    "published_at",
  ])
    assert.deepEqual(after[key], before[key], key);
  assert.equal(after.render_version, images.RENDER_VERSION);
  const calls = { ...f.calls };
  db.closeDb();
  const again = await service.runUpdates(f.client, {
    now: new Date("2027-01-05T12:00Z"),
  });
  assert.equal(again.updated, 0);
  assert.deepEqual(f.calls, calls);
  assert.equal(f.row().enabled, 0);
});
test("unpublished configurations and pending initial send intents are never published by the version refresh", async () => {
  isolateRenderingWork();
  const f = fixture();
  store.update(f.g, f.c, {
    delivery: JSON.stringify({
      after: "0",
      nonce: "pending-owner-publication",
    }),
  });
  const before = f.row();
  const result = await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(result.updated, 0);
  assert.equal(f.calls.send, 0);
  assert.equal(f.calls.fetch, 0);
  assert.deepEqual(f.row(), before);
  assert.equal((await f.refresh({ renderUpgrade: true })).skipped, true);
  assert.equal(f.calls.send, 0);
});
test("a failed automatic render refresh persists across restart and retries in place after backoff", async () => {
  const f = await upgradeFixture(),
    id = f.row().message_id;
  f.editError = Error("Temporary edit failure");
  let result = await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(result.failed, 1);
  assert.equal(f.row().render_version, null);
  assert.equal(f.row().message_id, id);
  assert.equal(f.calls.send, 1);
  f.editError = null;
  db.closeDb();
  result = await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(result.deferred, 1);
  assert.equal(f.calls.edit, 1);
  result = await service.runUpdates(f.client, {
    now: new Date("2027-01-01T12:05:01Z"),
  });
  assert.equal(result.updated, 1);
  assert.equal(f.row().render_version, images.RENDER_VERSION);
  assert.equal(f.row().message_id, id);
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().enabled, 0);
});
test("version refreshes respect Discord rate limits even when force is requested", async () => {
  const f = await upgradeFixture();
  f.editError = Object.assign(Error("Rate limited"), {
    status: 429,
    retry_after: 90,
  });
  await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(f.row().render_version, null);
  assert.equal(f.row().retry_kind, "rate_limit");
  f.editError = null;
  assert.equal(
    (await f.refresh({ renderUpgrade: true, force: true })).deferred,
    true,
  );
  assert.equal(f.calls.edit, 1);
  await service.runUpdates(f.client, { now: new Date("2027-01-01T12:01:31Z") });
  assert.equal(f.calls.edit, 2);
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().render_version, images.RENDER_VERSION);
});
test("a restart after editing but before the version checkpoint only re-edits the original message", async () => {
  const f = await upgradeFixture(),
    id = f.row().message_id,
    original = store.update;
  store.update = (g, c, fields) => {
    if (g === f.g && fields.render_version)
      throw Error("Interrupted version checkpoint");
    return original(g, c, fields);
  };
  try {
    const result = await service.runUpdates(f.client, { now: upgradeTime() });
    assert.equal(result.failed, 1);
    assert.equal(f.calls.edit, 1);
    assert.equal(f.row().render_version, null);
  } finally {
    store.update = original;
  }
  db.closeDb();
  await service.runUpdates(f.client, { now: new Date("2027-01-01T12:05:01Z") });
  assert.equal(f.calls.edit, 2);
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().message_id, id);
  assert.equal(f.row().render_version, images.RENDER_VERSION);
});
test("simultaneous version-refresh workers cannot create another message or overlap edits", async () => {
  const f = await upgradeFixture();
  const results = await Promise.all([
    service.runUpdates(f.client, { now: upgradeTime() }),
    service.runUpdates(f.client, { now: upgradeTime() }),
  ]);
  assert.equal(
    results.reduce((n, r) => n + r.updated, 0),
    1,
  );
  assert.equal(f.calls.edit, 1);
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().render_version, images.RENDER_VERSION);
});
test("adding second and third dates edits the existing published countdown without creating another message", async () => {
  isolateRenderingWork();
  const f = fixture();
  await f.refresh({ publish: true });
  const id = f.row().message_id,
    render = images.render;
  let rendered;
  images.render = async (m) => {
    rendered = m;
    return Buffer.from("rendered PNG");
  };
  try {
    const ids = [f.event];
    for (const date of ["2027-06-19", "2027-06-20"]) {
      ids.push(
        calendar.createCalendarEvent({
          guildId: f.g,
          calendarChannelId: "cal",
          title: "Additional Chicago date",
          eventDate: date,
          allDay: true,
          calendarType: "stray_kids",
          category: "concert",
          timezone: "America/Chicago",
          createdBy: "admin",
        }),
      );
      store.save(f.g, f.c, { ...JSON.parse(f.row().config), eventIds: ids });
      await f.refresh({ force: true });
      assert.equal(rendered.panels.length, ids.length);
      assert.deepEqual(
        rendered.panels.map((p) => p.day),
        ids.map((_, n) => n + 1),
      );
      assert.equal(f.row().message_id, id);
      assert.equal(f.calls.send, 1);
      assert.equal(f.messages.get(id).pinned, true);
      assert.equal(f.row().enabled, 0);
    }
  } finally {
    images.render = render;
  }
});
test("automatic updates continue normally for enabled cards after their one-time renderer upgrade", async () => {
  const f = await upgradeFixture();
  store.update(f.g, f.c, { enabled: 1 });
  await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(f.row().enabled, 1);
  assert.equal(f.calls.edit, 1);
  await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(f.calls.edit, 1);
  await service.runUpdates(f.client, { now: new Date("2027-01-02T12:00Z") });
  assert.equal(f.calls.edit, 2);
  assert.equal(f.calls.send, 1);
  assert.equal(f.row().enabled, 1);
});
test("additive renderer-version migration preserves legacy published data and does not pre-mark the refresh complete", () => {
  const { DatabaseSync } = require("node:sqlite"),
    { migrateCountdowns } = require("../src/db/concertCountdownSchema");
  const d = new DatabaseSync(":memory:");
  d.exec(
    "CREATE TABLE concert_countdowns(guild_id TEXT,channel_id TEXT,config TEXT,photo BLOB,photo_type TEXT,message_id TEXT,enabled INTEGER,fingerprint TEXT,last_success TEXT,last_error TEXT,published_at TEXT,PRIMARY KEY(guild_id,channel_id))",
  );
  d.prepare("INSERT INTO concert_countdowns VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    "g",
    "c",
    JSON.stringify({
      city: "Milan",
      venue: "San Siro Stadium",
      timezone: "Europe/Rome",
      eventIds: [1],
    }),
    Buffer.from("saved photograph"),
    "jpeg",
    "existing-message",
    0,
    "previous-fingerprint",
    "previous-success",
    null,
    "already-published",
  );
  const before = d.prepare("SELECT * FROM concert_countdowns").get();
  migrateCountdowns(d);
  const after = d.prepare("SELECT * FROM concert_countdowns").get();
  for (const key of Object.keys(before))
    assert.deepEqual(after[key], before[key], key);
  assert.equal(after.render_version, null);
  migrateCountdowns(d);
  assert.deepEqual(d.prepare("SELECT * FROM concert_countdowns").get(), after);
  d.close();
});

function assertImageOnly(payload) {
  assert.equal(payload.content, "");
  assert.deepEqual(payload.embeds, []);
  assert.deepEqual(payload.components, []);
  assert.equal(payload.files.length, 1);
  assert.match(payload.files[0].name, /^harmony-countdown-[a-f0-9]{64}\.png$/);
  assert.match(payload.files[0].description, /Chicago — Soldier Field/);
  assert.match(payload.files[0].description, /2027-06-18: \d+ days to go/);
  assert.ok(payload.files[0].description.length <= 1024);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
}
test("preview, publication and edits contain only the image with accessible attachment metadata", async () => {
  const f = fixture();
  const preview = await service.preview(f.row());
  assertImageOnly(preview);
  await f.refresh({ publish: true });
  const m = f.messages.get(f.row().message_id);
  assertImageOnly(m.sent);
  const name = m.sent.files[0].name;
  assert.ok(m.sent.nonce);
  assert.equal(m.sent.enforceNonce, true);
  await f.refresh({ force: true });
  assertImageOnly(m.lastEdit);
  assert.equal(m.lastEdit.files[0].name, name);
  assert.equal(preview.files[0].name, name);
  assert.equal(m.content, "");
  assert.equal(f.calls.send, 1);
});
test("installed Discord.js serializes empty content and attachment descriptions without visible companion fields", async () => {
  const { Client, MessagePayload } = require("discord.js");
  const f = fixture(), client = new Client({ intents: [] });
  const p = await service.preview(f.row());
  const serialized = MessagePayload.create({ client }, {
    ...p, attachments: [],
  }).resolveBody();
  await serialized.resolveFiles();
  assert.equal(serialized.body.content, "");
  assert.deepEqual(serialized.body.embeds, []);
  assert.deepEqual(serialized.body.components, []);
  assert.equal(serialized.body.attachments.length, 1);
  assert.equal(serialized.body.attachments[0].description, p.files[0].description);
  assert.equal(serialized.files[0].name, p.files[0].name);
  assert.deepEqual(serialized.files[0].data, p.files[0].attachment);
});
test("legacy disabled published cards lose all companion text once and preserve saved owner data and pins", async () => {
  isolateRenderingWork();
  const f = fixture();
  store.photo(f.g, f.c, Buffer.from("owner stadium photograph"), "jpeg");
  const m = f.message("Chicago — Soldier Field\n2027-06-18: 168 days to go\nYoutiful STAY • World Tour Countdown");
  m.pinned = true;
  store.update(f.g, f.c, {
    message_id: m.id, published_at: "2026-11-24T12:00Z",
    render_version: "countdown-card-v2-single-date-centered",
    // Even a matching image fingerprint cannot bypass a pending presentation upgrade.
    fingerprint: service.fingerprint(service.model(f.row(), upgradeTime()), f.row()),
    checked_at: upgradeTime().toISOString(),
  });
  const before = f.row();
  const result = await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(result.updated, 1);
  assertImageOnly(m.lastEdit);
  assert.equal(m.content, "");
  assert.equal(f.calls.send, 0);
  assert.equal(f.calls.pin, 0);
  assert.equal(m.pinned, true);
  for (const key of ["message_id", "enabled", "config", "photo", "photo_type", "revision", "published_at"])
    assert.deepEqual(f.row()[key], before[key], key);
  assert.equal(f.row().render_version, images.RENDER_VERSION);
  db.closeDb();
  const calls = { ...f.calls };
  await service.runUpdates(f.client, { now: new Date("2027-01-02T12:00Z") });
  assert.deepEqual(f.calls, calls);
});
test("image-only pinned countdown is recovered by attachment identity when its saved message ID is absent", async () => {
  isolateRenderingWork();
  const f = fixture();
  await f.refresh({ publish: true });
  const id = f.row().message_id, m = f.messages.get(id);
  assert.equal(m.content, "");
  store.update(f.g, f.c, { message_id: null, render_version: null });
  db.closeDb();
  await service.runUpdates(f.client, { now: upgradeTime() });
  assert.equal(f.row().message_id, id);
  assert.equal(f.calls.send, 1);
  assert.equal(f.calls.edit, 1);
  assert.equal(m.pinned, true);
  assert.equal(m.content, "");
});
test("lost image-only send response is recovered after restart using attachment metadata beyond 100 messages", async () => {
  const f = fixture();
  f.sendError = "after";
  await assert.rejects(f.refresh({ publish: true }), /after send/);
  const m = f.messages.first(), id = m.id;
  assert.equal(m.content, "");
  assert.ok(m.attachments.first().name);
  for (let i = 0; i < 250; i++) f.message("chat", "member");
  db.closeDb();
  f.sendError = null;
  f.retry();
  await f.refresh({ publish: true });
  assert.equal(f.row().message_id, id);
  assert.equal(f.calls.send, 1);
  assert.equal(m.pinned, true);
  assert.equal(f.row().delivery, null);
});
test("attachment identification rejects another room and another author without modifying their pinned messages", async () => {
  const f = fixture(), other = fixture();
  const filename = (await service.preview(f.row())).files[0].name;
  const otherFilename = (await service.preview(other.row())).files[0].name;
  assert.notEqual(filename, otherFilename);
  const foreign = f.message(""), copied = f.message("", "member");
  foreign.attachments.set("1", { name: otherFilename });
  copied.attachments.set("1", { name: filename });
  foreign.pinned = copied.pinned = true;
  await f.refresh({ publish: true });
  assert.equal(f.calls.send, 1);
  assert.notEqual(f.row().message_id, foreign.id);
  assert.notEqual(f.row().message_id, copied.id);
  for (const m of [foreign, copied]) {
    assert.equal(m.lastEdit, undefined);
    assert.equal(m.pinned, true);
  }
});
test("a stored ID with unrelated attachment metadata fails closed instead of overwriting or duplicating", async () => {
  const f = fixture(), m = f.message("");
  m.attachments.set("1", { name: "countdown.png" });
  store.update(f.g, f.c, { message_id: m.id, published_at: "2026-11-24T12:00Z" });
  await assert.rejects(f.refresh({ force: true }), /ownership mismatch/);
  assert.equal(f.calls.send, 0);
  assert.equal(f.calls.edit, 0);
  assert.equal(f.row().message_id, m.id);
});

async function dailyFixture(zone = 'America/Chicago', at = '2027-06-17T05:00:00Z') {
  isolateRenderingWork();
  const f = fixture(), config = JSON.parse(f.row().config); config.timezone = zone;
  store.save(f.g, f.c, config); store.photo(f.g, f.c, Buffer.from('preserved stadium photo'), 'jpeg');
  await f.refresh({ publish: true, now: new Date(at) }); store.update(f.g, f.c, { enabled: 1 });
  return f;
}
test('enabled published countdowns edit in place at venue midnight once, retaining photo, config, ID, pin and settings', async () => {
  const f = await dailyFixture('America/Toronto', '2027-06-16T04:00Z');
  const before = f.row(), m = f.messages.get(before.message_id);
  assert.equal(service.model(before, new Date('2027-06-16T23:00Z')).panels[0].days, 2);
  const calls = { ...f.calls };
  await service.runUpdates(f.client, { now: new Date('2027-06-17T03:59:59.999Z') }); assert.deepEqual(f.calls, calls);
  const midnight = new Date('2027-06-17T04:00:00.000Z');
  const result = await service.runUpdates(f.client, { now: midnight });
  assert.equal(result.updated, 1); assert.equal(f.calls.edit, 1); assert.match(m.lastEdit.files[0].description, /TOMORROW/);
  assert.equal(service.model(f.row(), midnight).panels[0].days, 1);
  for (const k of ['message_id', 'photo', 'photo_type', 'config', 'revision', 'enabled', 'published_at']) assert.deepEqual(f.row()[k], before[k], k);
  assert.equal(m.pinned, true); assert.equal(f.calls.pin, 1); assert.equal(f.calls.send, 1);
  assert.equal(f.row().last_success, midnight.toISOString());
  assert.equal(service.nextUpdate(f.row(), midnight).toISOString(), '2027-06-18T04:00:00.000Z');
  await service.runUpdates(f.client, { now: midnight }); assert.equal(f.calls.edit, 1);
});
test('independent venue midnights, multi-date panels and D-day/completed states advance from actual dates', async () => {
  const f = await dailyFixture('America/Vancouver', '2027-06-16T07:00Z');
  const second = calendar.createCalendarEvent({ guildId: f.g, calendarChannelId: 'cal', title: 'Chicago concert night 2', timezone: 'America/Vancouver', eventDate: '2027-06-19', calendarType: 'stray_kids', category: 'concert', allDay: true, createdBy: 'admin' });
  const config = JSON.parse(f.row().config); config.eventIds.push(second); store.save(f.g, f.c, config);
  await f.refresh({ force: true, now: new Date('2027-06-16T07:00Z') });
  await service.runUpdates(f.client, { now: new Date('2027-06-17T04:00Z') }); assert.equal(f.calls.edit, 1); // Toronto midnight isn't Vancouver midnight.
  await service.runUpdates(f.client, { now: new Date('2027-06-17T07:00Z') });
  assert.deepEqual(service.model(f.row(), new Date(f.row().last_success)).panels.map(p => p.days), [1, 2]);
  await service.runUpdates(f.client, { now: new Date('2027-06-18T07:00Z') });
  assert.deepEqual(service.model(f.row(), new Date(f.row().last_success)).panels.map(p => p.state), ['today', 'tomorrow']);
  await service.runUpdates(f.client, { now: new Date('2027-06-19T07:00Z') });
  assert.deepEqual(service.model(f.row(), new Date(f.row().last_success)).panels.map(p => p.state), ['completed', 'today']);
  assert.equal(f.calls.send, 1);
});
test('restart catches up several missed days rather than subtracting just one', async () => {
  const f = await dailyFixture('America/Toronto', '2027-06-10T04:00Z'), id = f.row().message_id;
  assert.equal(service.model(f.row(), new Date('2027-06-10T04:00Z')).panels[0].days, 8);
  db.closeDb(); const resumed = new Date('2027-06-15T15:00Z');
  await service.runUpdates(f.client, { now: resumed });
  assert.equal(service.model(f.row(), resumed).panels[0].days, 3); assert.equal(f.calls.edit, 1); assert.equal(f.row().message_id, id);
  assert.equal(f.row().last_success, resumed.toISOString());
});
test('midnight failure respects persisted retry delay after restart and preserves the original message', async () => {
  const f = await dailyFixture('America/Toronto', '2027-06-16T04:00Z'), id = f.row().message_id;
  f.editError = Object.assign(Error('Rate limited'), { retry_after: 90, status: 429 });
  const midnight = new Date('2027-06-17T04:00Z');
  assert.equal((await service.runUpdates(f.client, { now: midnight })).failed, 1);
  assert.equal(service.nextUpdate(f.row(), midnight).toISOString(), '2027-06-17T04:01:30.000Z');
  db.closeDb(); f.editError = null;
  await service.runUpdates(f.client, { now: new Date('2027-06-17T04:01:29Z') }); assert.equal(f.calls.edit, 1);
  await service.runUpdates(f.client, { now: new Date('2027-06-17T04:01:30Z') }); assert.equal(f.calls.edit, 2);
  assert.equal(f.row().message_id, id); assert.equal(f.calls.send, 1); assert.equal(f.row().retry_at, null);
});
test('completed fingerprints still checkpoint each midnight without spinning inside the six-hour health window', async () => {
  const f = await dailyFixture('America/Toronto', '2027-06-19T23:00Z'), now = new Date('2027-06-20T04:00Z');
  assert.equal((await service.runUpdates(f.client, { now })).updated, 1);
  assert.equal(f.row().last_success, now.toISOString());
  assert.equal(service.nextUpdate(f.row(), now).toISOString(), '2027-06-21T04:00:00.000Z');
  assert.equal(f.calls.edit, 0); assert.equal(f.calls.send, 1);
});
test('daily scheduling excludes disabled cards and private drafts, and Refresh Now still works', async () => {
  const f = await dailyFixture(); store.update(f.g, f.c, { enabled: 0 });
  const before = f.row(), calls = { ...f.calls };
  await service.runUpdates(f.client, { now: new Date('2027-06-18T05:00Z') }); assert.deepEqual(f.calls, calls);
  assert.equal(service.nextUpdate(f.row()), null);
  const draft = fixture(); store.update(draft.g, draft.c, { enabled: 1 });
  assert.equal(store.renderingWork(images.RENDER_VERSION).some(r => r.guild_id === draft.g), false);
  await f.refresh({ force: true, now: new Date('2027-06-18T05:00Z') });
  assert.equal(f.calls.edit, 1); assert.equal(f.row().enabled, before.enabled);
});
test('scheduler arms one midnight timer, wakes on settings changes and stops without a minute poll', async () => {
  const f = await dailyFixture('America/Toronto', '2027-06-16T04:00Z');
  let now = new Date('2027-06-16T12:00Z'); const pending = new Map(); let seq = 0;
  const stop = service.start(f.client, { clock: () => now, setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; }, clearTimer: id => pending.delete(id) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 1); assert.equal([...pending.values()][0].ms, 16 * 3600000);
  const task = [...pending.values()][0]; pending.clear(); now = new Date('2027-06-17T04:00Z'); await task.fn();
  assert.equal(f.calls.edit, 1); assert.equal([...pending.values()][0].ms, 24 * 3600000);
  store.update(f.g, f.c, { enabled: 0 }); assert.equal(pending.size, 0);
  store.update(f.g, f.c, { enabled: 1 }); assert.equal(pending.size, 1);
  stop(); assert.equal(pending.size, 0);
  store.update(f.g, f.c, { enabled: 0 }); assert.equal(pending.size, 0);
});
test('invalid saved zone retries with backoff; a surviving lease delays recovery safely', async () => {
  const f = await dailyFixture(), now = new Date('2027-06-17T06:00Z');
  const config = JSON.parse(f.row().config); config.timezone = 'Mars/Chicago'; store.save(f.g, f.c, config);
  // A valid fingerprint exercises zone validation while planning the next local day.
  store.update(f.g, f.c, { fingerprint: 'old' });
  assert.equal((await service.runUpdates(f.client, { now })).failed, 1);
  assert.equal(service.nextUpdate(f.row(), now).toISOString(), '2027-06-17T06:05:00.000Z');
  const due = { ...f.row(), lease_until: now.getTime() + 600000 };
  assert.equal(service.nextUpdate(due, now).getTime(), due.lease_until + 1);
  assert.equal(f.calls.send, 1);
});
test('the running midnight timer arms the exact rate-limit retry and recovers without a second send', async () => {
  const f = await dailyFixture('America/Toronto', '2027-06-16T04:00Z');
  let now = new Date('2027-06-17T03:00Z'); const pending = new Map(); let seq = 0;
  const stop = service.start(f.client, { clock: () => now, setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; }, clearTimer: id => pending.delete(id) });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const midnight = [...pending.values()][0]; pending.clear(); now = new Date('2027-06-17T04:00Z');
    f.editError = Object.assign(Error('Rate limited'), { status: 429, retry_after: 90 }); await midnight.fn();
    assert.equal(pending.size, 1); const retry = [...pending.values()][0]; assert.equal(retry.ms, 90000);
    pending.clear(); now = new Date('2027-06-17T04:01:30Z'); f.editError = null; await retry.fn();
    assert.equal(f.calls.send, 1); assert.equal(f.calls.edit, 2); assert.equal(f.row().last_error, null);
    assert.equal([...pending.values()][0].ms, 24 * 3600000 - 90000);
  } finally { stop(); }
});
test('a same-day failed manual refresh clears its error on scheduled retry instead of taking the unchanged-image shortcut', async () => {
  const f = await dailyFixture('America/Toronto', '2027-06-16T04:00Z');
  f.editError = Error('Temporary forced-edit failure');
  await assert.rejects(f.refresh({ force: true, now: new Date('2027-06-16T04:01Z') }), /Temporary/);
  f.editError = null;
  const due = new Date(f.row().retry_at); assert.equal(due.toISOString(), '2027-06-16T04:06:00.000Z');
  await service.runUpdates(f.client, { now: due });
  assert.equal(f.row().last_error, null); assert.equal(f.row().retry_at, null);
  assert.equal(service.nextUpdate(f.row(), due).toISOString(), '2027-06-17T04:00:00.000Z');
  assert.equal(f.calls.send, 1);
});
test('a manual failure releases its lease and rearms the saved retry without waiting for lease expiry', async t => {
  const f = await dailyFixture('America/Toronto', '2027-06-16T04:00Z');
  let now = new Date('2027-06-16T04:01Z'); const pending = new Map(); let seq = 0;
  t.mock.method(Date, 'now', () => now.getTime());
  const stop = service.start(f.client, { clock: () => now, setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; }, clearTimer: id => pending.delete(id) });
  try {
    await new Promise(resolve => setImmediate(resolve));
    f.editError = Object.assign(Error('Rate limited'), { status: 429, retry_after: 90 });
    await assert.rejects(f.refresh({ force: true, now }), /Rate limited/);
    assert.equal(pending.size, 1); assert.equal([...pending.values()][0].ms, 90000);
    assert.equal(f.row().lease_until, null);
  } finally { stop(); }
});
