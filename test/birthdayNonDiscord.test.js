const test = require("node:test");
const assert = require("node:assert/strict");
const birthdayStore = require("../src/stores/birthdayStore");
const {
  buildBirthdayEmbed,
  announceNonDiscordBirthdays,
  isNonDiscordBirthdayDue,
  upcomingProfiles,
  zonedParts,
} = require("../src/services/birthdayService");

test("non-Discord birthday storage needs no member or birth year and keeps annual MM-DD", () => {
  const guildId = `birthday-nondiscord-store-${Date.now()}`;
  const id = birthdayStore.upsertNonDiscordBirthdayProfile({
    guildId,
    birthdayName: "Lee Know",
    birthdayMmdd: "10-25",
    timezone: "Asia/Seoul",
  });
  const row = birthdayStore.getNonDiscordBirthdayProfile(guildId, id);
  assert.equal(row.user_id, null);
  assert.equal(row.welcome_pass_code, null);
  assert.equal(row.birthday_name, "Lee Know");
  assert.equal(row.birthday_mmdd, "10-25");
  assert.equal(row.timezone, "Asia/Seoul");
  assert.equal(Object.hasOwn(row, "birth_year"), false);

  const same = birthdayStore.upsertNonDiscordBirthdayProfile({
    guildId, birthdayName: "lee know", birthdayMmdd: "10-25", timezone: "Asia/Seoul",
  });
  assert.equal(same, id);
  assert.equal(birthdayStore.listNonDiscordBirthdayProfiles(guildId).length, 1);
});

test("Asia/Seoul birthday date boundary and announcement hour follow the profile timezone", () => {
  const profile = { birthday_mmdd: "10-25", timezone: "Asia/Seoul", last_announced_year: null };
  const beforeSeoulBirthday = new Date("2026-10-24T23:59:00.000Z"); // 08:59 on Oct 25 in Seoul
  const atSeoulAnnouncement = new Date("2026-10-25T00:00:00.000Z"); // 09:00 on Oct 25 in Seoul
  assert.equal(zonedParts(beforeSeoulBirthday, profile.timezone).dateKey, "2026-10-25");
  assert.equal(isNonDiscordBirthdayDue(profile, beforeSeoulBirthday, 9), false);
  assert.equal(isNonDiscordBirthdayDue(profile, atSeoulAnnouncement, 9), true);
});

test("scheduler announces a Seoul birthday once after its local announcement hour without Discord-member lookup", async () => {
  const guildId = `birthday-nondiscord-schedule-${Date.now()}`;
  const id = birthdayStore.upsertNonDiscordBirthdayProfile({ guildId, birthdayName: "Lee Know", birthdayMmdd: "10-25", timezone: "Asia/Seoul" });
  const sent = [];
  const channel = { isTextBased: () => true, send: async (payload) => sent.push(payload) };
  const guild = {
    id: guildId,
    channels: { cache: new Map([["birthday-channel", channel]]) },
    members: { fetch: async () => { throw new Error("Non-member birthdays must not fetch a Discord member"); } },
  };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const settings = { guild_id: guildId, channel_id: "birthday-channel", announcement_hour: 9 };
  const atNineSeoul = new Date("2026-10-25T00:00:00.000Z");
  await announceNonDiscordBirthdays(client, settings, atNineSeoul);
  await announceNonDiscordBirthdays(client, settings, new Date("2026-10-25T01:00:00.000Z"));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Lee Know/);
  assert.doesNotMatch(sent[0].content, /<@/);
  assert.equal(sent[0].allowedMentions.users, undefined);
  assert.equal(birthdayStore.getNonDiscordBirthdayProfile(guildId, id).last_announced_year, 2026);
});

test("annual non-Discord recurrence is deduplicated per local year", () => {
  const profile = { birthday_mmdd: "10-25", timezone: "Asia/Seoul", last_announced_year: 2026 };
  assert.equal(isNonDiscordBirthdayDue(profile, new Date("2026-10-25T00:00:00Z"), 9), false);
  assert.equal(isNonDiscordBirthdayDue(profile, new Date("2027-10-25T00:00:00Z"), 9), true);
});

test("non-Discord announcement history is retained without a user ID or role timer", () => {
  const guildId = `birthday-nondiscord-history-${Date.now()}`;
  const id = birthdayStore.upsertNonDiscordBirthdayProfile({ guildId, birthdayName: "Lee Know", birthdayMmdd: "10-25", timezone: "Asia/Seoul" });
  birthdayStore.markBirthdayAnnounced(id, 2026, "2026-10-26T00:00:00.000Z");
  const row = birthdayStore.getNonDiscordBirthdayProfile(guildId, id);
  assert.equal(row.last_announced_year, 2026);
  assert.equal(row.role_remove_at, null);
  const history = birthdayStore.listBirthdayHistory(guildId, "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
  assert.equal(history.length, 1);
  assert.equal(history[0].user_id, null);
  assert.equal(history[0].birthday_name, "Lee Know");
});

test("non-member reminders and previews use a display name while member birthdays retain mentions", () => {
  const guildId = `birthday-nondiscord-display-${Date.now()}`;
  birthdayStore.upsertNonDiscordBirthdayProfile({ guildId, birthdayName: "Lee Know", birthdayMmdd: "10-25", timezone: "Asia/Seoul" });
  birthdayStore.upsertBirthdayProfile({ guildId, userId: "918273", birthdayMmdd: "10-25", birthdayName: "Stay", bias: "Han" });
  const profiles = birthdayStore.listBirthdayProfiles(guildId);
  const nonMember = profiles.find((profile) => !profile.user_id);
  const member = profiles.find((profile) => profile.user_id);
  const preview = buildBirthdayEmbed(nonMember, 2026, true).data.description;
  assert.match(preview, /Preview for Lee Know/);
  assert.doesNotMatch(preview, /<@undefined>/);
  assert.match(buildBirthdayEmbed(member, 2026, true).data.description, /Preview for <@918273>/);
  assert.equal(upcomingProfiles(guildId, 365).some((profile) => profile.user_id === "918273"), true);
});
