const test = require("node:test");
const assert = require("node:assert/strict");
const { matchAllImportedBirthdays, matchOneImportedBirthday } = require("../src/services/birthdayMatchingService");
const birthdaysCommand = require("../src/commands/birthdays");
const { birthdayManagerContent, isBirthdayAdmin } = require("../src/services/birthdayManagerService");
const birthdayStore = require("../src/stores/birthdayStore");
const { PermissionFlagsBits } = require("discord.js");

test("birthday admin permission matches Schedule Manager policy without changing member-facing commands", () => {
  const manageGuild = { has: (permission) => permission === PermissionFlagsBits.ManageGuild || permission === "ManageGuild" };
  const administrator = { has: (permission) => permission === PermissionFlagsBits.Administrator || permission === "Administrator" };
  const member = { has: () => false };
  assert.equal(birthdaysCommand.isAdmin({ memberPermissions: manageGuild }), true);
  assert.equal(isBirthdayAdmin({ memberPermissions: manageGuild }), true);
  assert.equal(birthdaysCommand.isAdmin({ memberPermissions: administrator }), true);
  assert.equal(isBirthdayAdmin({ memberPermissions: administrator }), true);
  assert.equal(birthdaysCommand.isAdmin({ memberPermissions: member }), false);
  const command = birthdaysCommand.data.toJSON();
  assert.ok(command.options.some((option) => option.name === "next"));
  assert.ok(command.options.some((option) => option.name === "month"));
  assert.match(command.description, /member and non-member/);
  const setup = command.options.find((option) => option.name === "setup");
  assert.match(setup.options.find((option) => option.name === "hour").description, /Discord-member/);
  const guildId = `birthday-wording-${Date.now()}`;
  birthdayStore.saveBirthdaySettings({ guildId, channelId: "birthday-channel", roleId: "birthday-role", timezone: "America/New_York", announcementHour: 9, weeklyEnabled: true, weeklyDay: 0, monthlyRecapEnabled: true });
  const text = birthdayManagerContent(guildId);
  assert.match(text, /Discord-member birthday announcement time/);
  assert.match(text, /non-member birthdays announce at 12:00 AM/i);
});

test("Birthday Manager and slash birthday matching use the same shared matching service behavior", async () => {
  const profiles = [
    { birthday_name: "Ari", discord_username: "AriUser", welcome_pass_code: "YS-11111111" },
    { birthday_name: "No Match", discord_username: "absent", welcome_pass_code: "YS-22222222" },
  ];
  const attached = [];
  const linkedCodes = [];
  const fakeStore = {
    listUnlinkedWelcomePassBirthdayProfiles: () => profiles,
    attachWelcomePassBirthdayProfile: (code) => { attached.push(code); return true; },
  };
  const fakeLink = ({ code, guildId, userId }) => { linkedCodes.push({ code, guildId, userId }); return { ok: true }; };
  const guild = { members: { fetch: async () => new Map([
    ["member-1", { id: "member-1", displayName: "Ari", user: { id: "member-1", username: "AriUser", globalName: "Ari", bot: false, discriminator: "0" } }],
    ["bot", { id: "bot", displayName: "AriUser", user: { username: "AriUser", bot: true, discriminator: "0" } }],
  ]) } };
  const result = await matchAllImportedBirthdays({ guild, guildId: "guild", store: fakeStore, linkCode: fakeLink });
  assert.equal(result.connected, 1);
  assert.deepEqual(result.unresolved, [{ name: "No Match", reason: "no matching server member" }]);
  assert.deepEqual(attached, ["YS-11111111"]);
  assert.deepEqual(linkedCodes, [{ code: "YS-11111111", guildId: "guild", userId: "member-1" }]);

  const one = matchOneImportedBirthday({ guildId: "guild", importedName: "ariuser", memberId: "member-2", store: fakeStore, linkCode: fakeLink });
  assert.equal(one.status, "connected");
  assert.equal(one.profile.welcome_pass_code, "YS-11111111");
});
