const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  Client,
  ClientUser,
  ChannelType,
  PermissionFlagsBits: P,
} = require("discord.js");
const access = require("../src/services/concertCountdownPermissions");
const G = "100000000000000001",
  B = "100000000000000002",
  R = "100000000000000003",
  C = "100000000000000004",
  OTHER = "100000000000000005",
  OWNER = "100000000000000099",
  CAT = "100000000000000006";
const ALL = access.REQUIRED.reduce((bits, p) => bits | p.flag, 0n);
function fixture() {
  const client = new Client({ intents: [] });
  const user = {
    id: B,
    username: "Harmony",
    discriminator: "0000",
    avatar: null,
    bot: true,
  };
  client.user = new ClientUser(client, user);
  const role = (id, name, permissions = 0n) => ({
    id,
    name,
    permissions: String(permissions),
    position: id === G ? 0 : 1,
  });
  const state = {
    roles: [role(G, "@everyone"), role(R, "Harmony", ALL)],
    member: { user, roles: [R], joined_at: "2026-01-01T00:00Z" },
    channel: {
      id: C,
      guild_id: G,
      type: ChannelType.GuildText,
      name: "chicago",
      permission_overwrites: [],
      parent_id: null,
    },
    gets: [],
    fail: null,
  };
  const guild = client.guilds._add({
    id: G,
    name: "Test STAY server",
    owner_id: OWNER,
    roles: state.roles,
    emojis: [],
    features: [],
  });
  const channel = client.channels._add(state.channel, guild);
  client.rest.get = async (route) => {
    state.gets.push(route);
    if (state.fail) throw state.fail;
    if (route === `/channels/${C}`) return state.channel;
    if (route === `/guilds/${G}/roles`) return state.roles;
    if (route === `/guilds/${G}/members/${B}`) return state.member;
    throw Error("Unexpected GET " + route);
  };
  // Any accidental permissions mutation is an immediate test failure.
  for (const method of ["put", "patch", "delete", "post"])
    client.rest[method] = async () => {
      throw Error("Unexpected Discord mutation");
    };
  return {
    client,
    guild,
    channel,
    state,
    role,
    inspect: () => access.inspect(client, G, C),
  };
}
function overwrite(id, type, allow = 0n, deny = 0n) {
  return { id, type, allow: String(allow), deny: String(deny) };
}
test("reproduces cold bot-member cache failure with actual Discord.js; fresh resolution succeeds", async () => {
  const f = fixture();
  assert.equal(f.channel.permissionsFor(f.client.user), null);
  const snapshot = access.assertAllowed(await f.inspect());
  assert.equal(snapshot.member.id, B);
  assert.deepEqual(snapshot.diagnostics.missing, []);
  assert.equal(
    snapshot.channel.permissionsFor(snapshot.member).has(P.PinMessages),
    true,
  );
  assert.equal(f.state.gets.length, 3);
});
test("refreshes stale bot roles, role grants and channel overrides before calculating access", async () => {
  const f = fixture();
  f.guild.members._add({ ...f.state.member, roles: [] });
  assert.equal(
    f.channel.permissionsFor(f.client.user).has(P.PinMessages),
    false,
  );
  f.state.roles = [
    f.role(G, "@everyone"),
    f.role(R, "Harmony", ALL & ~P.PinMessages),
    f.role(OTHER, "Concert tools"),
  ];
  f.state.member = { ...f.state.member, roles: [OTHER] };
  f.state.channel = {
    ...f.state.channel,
    permission_overwrites: [overwrite(OTHER, 0, ALL)],
  };
  const snapshot = access.assertAllowed(await f.inspect());
  assert.ok(snapshot.member.roles.cache.has(OTHER));
  assert.deepEqual(snapshot.diagnostics.missing, []);
});
test("Pin Messages remains a BigInt high bit and does not require Manage Messages", async () => {
  const f = fixture();
  assert.equal(P.PinMessages, 1n << 51n);
  const { channel, member } = access.assertAllowed(await f.inspect());
  assert.equal(channel.permissionsFor(member).has(P.ManageMessages), false);
  assert.equal(channel.permissionsFor(member).has(P.PinMessages), true);
});
test("Manage Messages does not substitute for the missing Pin Messages permission", async () => {
  const f = fixture();
  f.state.roles = [
    f.role(G, "@everyone"),
    f.role(R, "Harmony", (ALL & ~P.PinMessages) | P.ManageMessages),
  ];
  const snapshot = await f.inspect();
  assert.deepEqual(snapshot.diagnostics.missing, ["Pin Messages"]);
  assert.throws(
    () => access.assertAllowed(snapshot),
    (e) =>
      e.code === "COUNTDOWN_MISSING_PERMISSIONS" &&
      /Pin Messages/.test(e.message) &&
      !/Attach Files/.test(e.message),
  );
});
test("identifies each missing permission individually rather than reporting a generic list", async () => {
  for (const p of access.REQUIRED) {
    const f = fixture();
    f.state.roles = [
      f.role(G, "@everyone"),
      f.role(R, "Harmony", ALL & ~p.flag),
    ];
    const snapshot = await f.inspect();
    assert.deepEqual(snapshot.diagnostics.missing, [p.name]);
    assert.throws(() => access.assertAllowed(snapshot), new RegExp(p.name));
  }
});
test("inherited everyone permissions and role-level room allows are calculated by Discord.js", async () => {
  const f = fixture();
  f.state.roles = [f.role(G, "@everyone", ALL), f.role(R, "Harmony")];
  access.assertAllowed(await f.inspect());
  f.state.channel = {
    ...f.state.channel,
    permission_overwrites: [
      overwrite(G, 0, 0n, P.PinMessages),
      overwrite(R, 0, P.PinMessages),
    ],
  };
  access.assertAllowed(await f.inspect());
});
test("member-specific denies override role allows and identify their source", async () => {
  const f = fixture();
  f.state.channel = {
    ...f.state.channel,
    permission_overwrites: [
      overwrite(R, 0, P.PinMessages),
      overwrite(B, 1, 0n, P.PinMessages),
    ],
  };
  const { diagnostics } = await f.inspect();
  assert.deepEqual(diagnostics.missing, ["Pin Messages"]);
  assert.match(
    diagnostics.permissions.find((p) => !p.allowed).source,
    /member-specific/,
  );
});
test("role-specific denies identify the role and everyone/member allows obey precedence", async () => {
  const f = fixture();
  f.state.channel = {
    ...f.state.channel,
    permission_overwrites: [overwrite(R, 0, 0n, P.AttachFiles)],
  };
  let snapshot = await f.inspect();
  assert.deepEqual(snapshot.diagnostics.missing, ["Attach Files"]);
  assert.match(
    snapshot.diagnostics.permissions.find((p) => !p.allowed).source,
    /Harmony/,
  );
  f.state.channel.permission_overwrites.push(overwrite(B, 1, P.AttachFiles));
  access.assertAllowed(await f.inspect());
});
test("an allow from another inherited role overrides a role deny without using role hierarchy", async () => {
  const f = fixture();
  f.state.roles.push(f.role(OTHER, "Additional role"));
  f.state.member.roles.push(OTHER);
  f.state.channel.permission_overwrites = [
    overwrite(R, 0, 0n, P.PinMessages),
    overwrite(OTHER, 0, P.PinMessages),
  ];
  access.assertAllowed(await f.inspect());
});
test("Administrator is honored without requesting or granting that permission", async () => {
  const f = fixture();
  f.state.roles = [
    f.role(G, "@everyone"),
    f.role(R, "Harmony", P.Administrator),
  ];
  f.state.channel.permission_overwrites = [overwrite(B, 1, 0n, ALL)];
  access.assertAllowed(await f.inspect());
  assert.equal(f.state.gets.length, 3);
});
test("category-synced overrides are respected and unsynced child overrides remain authoritative", async () => {
  const f = fixture();
  const parent = {
    id: CAT,
    guild_id: G,
    type: ChannelType.GuildCategory,
    name: "concerts",
    permission_overwrites: [overwrite(R, 0, 0n, P.PinMessages)],
  };
  f.client.channels._add(parent, f.guild);
  f.state.channel = {
    ...f.state.channel,
    parent_id: CAT,
    permission_overwrites: parent.permission_overwrites,
  };
  assert.deepEqual((await f.inspect()).diagnostics.missing, ["Pin Messages"]);
  f.state.channel.permission_overwrites = [];
  access.assertAllowed(await f.inspect());
});
test("unresolved bot membership is reported as an unavailable check, not five missing permissions", async () => {
  const f = fixture();
  f.state.member = {
    ...f.state.member,
    user: { ...f.state.member.user, id: OTHER },
  };
  await assert.rejects(
    f.inspect(),
    (e) =>
      e.code === "COUNTDOWN_PERMISSION_UNAVAILABLE" &&
      !e.message.includes("Pin Messages"),
  );
});
test("failures loading fresh permission data preserve rate-limit metadata", async () => {
  const f = fixture();
  f.state.fail = Object.assign(Error("Rate limited"), {
    status: 429,
    retry_after: 90,
  });
  await assert.rejects(
    f.inspect(),
    (e) => access.retryKind(e) === "rate_limit" && e.retry_after === 90,
  );
});
test("runtime pin refusals name the operation and distinguish allowed flags from actual API denial", async () => {
  const f = fixture();
  const e = await access.operationError(
    Object.assign(Error("Missing Permissions"), { code: 50013, status: 403 }),
    {
      client: f.client,
      guildId: G,
      channelId: C,
      stage: "pin the countdown",
      messageSaved: true,
    },
  );
  assert.match(e.message, /pin the countdown \(50013\)/);
  assert.match(e.message, /all five required permissions allowed/);
  assert.match(e.message, /reuse the saved message/);
  assert.equal(e.code, 50013);
});
test("permission drift after preflight reports the newly missing flag", async () => {
  const f = fixture();
  await f.inspect();
  f.state.roles[1] = f.role(R, "Harmony", ALL & ~P.PinMessages);
  const e = await access.operationError(
    Object.assign(Error("Missing Permissions"), { code: 50013 }),
    {
      client: f.client,
      guildId: G,
      channelId: C,
      stage: "pin the countdown",
      messageSaved: true,
    },
  );
  assert.match(e.message, /now missing: Pin Messages/);
  assert.doesNotMatch(e.message, /now missing:.*Attach Files/);
});
test("legacy permission failures can be retried, while unknown legacy and real rate limits retain their delay", () => {
  assert.equal(
    access.canRetryManually({ last_error: access.LEGACY_PERMISSION_ERROR }),
    true,
  );
  assert.equal(access.canRetryManually({ retry_kind: "rate_limit" }), false);
  assert.equal(
    access.canRetryManually({ last_error: "Unknown older error" }),
    false,
  );
  assert.equal(access.retryKind({ retryAfter: 5000 }), "rate_limit");
});
