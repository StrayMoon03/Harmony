const test = require("node:test");
const assert = require("node:assert/strict");
const birthdayStore = require("../src/stores/birthdayStore");
const {
  buildBirthdayEmbed,
  announceNonDiscordBirthdays,
  isNonDiscordBirthdayDue,
  isMemberBirthdayAnnouncementTime,
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
  assert.equal(row.bias, "Still deciding");
  assert.equal(Object.hasOwn(row, "birth_year"), false);

  const same = birthdayStore.upsertNonDiscordBirthdayProfile({
    guildId, birthdayName: "lee know", birthdayMmdd: "10-25", timezone: "Asia/Seoul",
  });
  assert.equal(same, id);
  assert.equal(birthdayStore.listNonDiscordBirthdayProfiles(guildId).length, 1);
});

test("custom non-member messages persist independently from date and timezone edits", () => {
  const guildId = `birthday-nondiscord-message-store-${Date.now()}`;
  const customMessage = "First paragraph.\n\nSecond paragraph.";
  const id = birthdayStore.upsertNonDiscordBirthdayProfile({ guildId, birthdayName: "Lee Know", birthdayMmdd: "10-25", timezone: "Asia/Seoul", customMessage });
  assert.equal(birthdayStore.getNonDiscordBirthdayProfile(guildId, id).custom_message, customMessage);

  assert.equal(birthdayStore.updateNonDiscordBirthdayProfile(guildId, id, {
    birthdayName: "Lee Know", birthdayMmdd: "10-26", timezone: "Asia/Tokyo",
  }), true);
  let row = birthdayStore.getNonDiscordBirthdayProfile(guildId, id);
  assert.equal(row.custom_message, customMessage);
  assert.equal(row.birthday_mmdd, "10-26");
  assert.equal(row.timezone, "Asia/Tokyo");

  const revisedMessage = "New opening.\n\nNew second paragraph.";
  assert.equal(birthdayStore.updateNonDiscordBirthdayMessage(guildId, id, revisedMessage), true);
  row = birthdayStore.getNonDiscordBirthdayProfile(guildId, id);
  assert.equal(row.custom_message, revisedMessage);
  assert.equal(row.birthday_mmdd, "10-26");
  assert.equal(row.timezone, "Asia/Tokyo");
});

test("Asia/Seoul non-member birthday becomes due at local midnight, regardless of guild hour", () => {
  const profile = { birthday_mmdd: "10-25", timezone: "Asia/Seoul", last_announced_year: null };
  const beforeMidnight = new Date("2026-10-24T14:59:59.000Z"); // 23:59:59 on Oct 24 in Seoul
  const atMidnight = new Date("2026-10-24T15:00:00.000Z"); // 00:00 on Oct 25 in Seoul
  assert.equal(zonedParts(beforeMidnight, profile.timezone).dateKey, "2026-10-24");
  assert.equal(zonedParts(atMidnight, profile.timezone).dateKey, "2026-10-25");
  assert.equal(isNonDiscordBirthdayDue(profile, beforeMidnight), false);
  assert.equal(isNonDiscordBirthdayDue(profile, atMidnight), true);
});

test("non-member birthday in another IANA timezone becomes due at that timezone's midnight", () => {
  const profile = { birthday_mmdd: "10-25", timezone: "America/New_York", last_announced_year: null };
  const beforeMidnight = new Date("2026-10-25T03:59:59.000Z"); // 23:59:59 EDT on Oct 24
  const atMidnight = new Date("2026-10-25T04:00:00.000Z"); // 00:00 EDT on Oct 25
  assert.equal(zonedParts(beforeMidnight, profile.timezone).dateKey, "2026-10-24");
  assert.equal(zonedParts(atMidnight, profile.timezone).dateKey, "2026-10-25");
  assert.equal(isNonDiscordBirthdayDue(profile, beforeMidnight), false);
  assert.equal(isNonDiscordBirthdayDue(profile, atMidnight), true);
});

test("non-member catch-up later on the local birthday announces once despite guild hour and timezone", async () => {
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
  const settings = { guild_id: guildId, channel_id: "birthday-channel", timezone: "Pacific/Honolulu", announcement_hour: 2 };
  const laterThatDayInSeoul = new Date("2026-10-25T01:00:00.000Z"); // 10:00 Oct 25 Seoul; after midnight and before/independent of guild schedule
  await announceNonDiscordBirthdays(client, settings, laterThatDayInSeoul);
  await announceNonDiscordBirthdays(client, settings, new Date("2026-10-25T02:00:00.000Z"));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Lee Know/);
  assert.doesNotMatch(sent[0].content, /<@/);
  assert.equal(sent[0].allowedMentions.users, undefined);
  assert.equal(birthdayStore.getNonDiscordBirthdayProfile(guildId, id).last_announced_year, 2026);
});

test("each non-member birthday uses its own custom announcement message", async () => {
  const guildId = `birthday-nondiscord-custom-announce-${Date.now()}`;
  const customMessage = "Lee Know's first paragraph.\n\nLee Know's second paragraph.";
  const id = birthdayStore.upsertNonDiscordBirthdayProfile({ guildId, birthdayName: "Lee Know", birthdayMmdd: "10-25", timezone: "Asia/Seoul", customMessage });
  const bangChanMessage = "Bang Chan's own birthday note.";
  const bangChanId = birthdayStore.upsertNonDiscordBirthdayProfile({ guildId, birthdayName: "Bang Chan", birthdayMmdd: "10-25", timezone: "Asia/Seoul", customMessage: bangChanMessage });
  const sent = [];
  const channel = { isTextBased: () => true, send: async (payload) => sent.push(payload) };
  const guild = { id: guildId, channels: { cache: new Map([["birthday-channel", channel]]) } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  await announceNonDiscordBirthdays(client, { guild_id: guildId, channel_id: "birthday-channel", announcement_hour: 2 }, new Date("2026-10-24T15:00:00.000Z"));
  assert.equal(sent.length, 2);
  const leeAnnouncement = sent.find((payload) => payload.embeds[0].data.title.includes("Lee Know"));
  const bangChanAnnouncement = sent.find((payload) => payload.embeds[0].data.title.includes("Bang Chan"));
  assert.equal(leeAnnouncement.embeds[0].data.description, customMessage);
  assert.equal(bangChanAnnouncement.embeds[0].data.description, bangChanMessage);
  assert.doesNotMatch(leeAnnouncement.embeds[0].data.description, /Still deciding|inspired by|spotlight|rotating/);
  assert.equal(birthdayStore.getNonDiscordBirthdayProfile(guildId, id).last_announced_year, 2026);
  assert.equal(birthdayStore.getNonDiscordBirthdayProfile(guildId, bangChanId).last_announced_year, 2026);
});

test("member birthday schedule remains tied to the configured guild announcement hour", () => {
  const settings = { announcement_hour: 2 };
  assert.equal(isMemberBirthdayAnnouncementTime(settings, { hour: 1 }), false);
  assert.equal(isMemberBirthdayAnnouncementTime(settings, { hour: 2 }), true);
  assert.equal(isMemberBirthdayAnnouncementTime(settings, { hour: 0 }), false);
});

test("annual non-Discord recurrence is deduplicated per local year", () => {
  const profile = { birthday_mmdd: "10-25", timezone: "Asia/Seoul", last_announced_year: 2026 };
  assert.equal(isNonDiscordBirthdayDue(profile, new Date("2026-10-25T00:00:00Z")), false);
  assert.equal(isNonDiscordBirthdayDue(profile, new Date("2027-10-25T00:00:00Z")), true);
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

test("non-member announcement copy uses the neutral preset regardless of the person's name or stale bias", () => {
  for (const name of ["Lee Know", "Bang Chan"]) {
    const profile = {
      user_id: null,
      birthday_name: name,
      birthday_mmdd: "10-25",
      bias: "Lee Know", // Simulate an older or incorrectly populated row.
    };
    const embed = buildBirthdayEmbed(profile, 2026);
    assert.match(embed.data.title, new RegExp(name));
    assert.match(embed.data.description, /inspired by Still deciding/);
    assert.doesNotMatch(embed.data.description, /calm, delightfully unpredictable|one full day of doing things your way/);
  }
});
