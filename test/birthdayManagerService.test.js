const test = require("node:test");
const assert = require("node:assert/strict");
const { birthdayManagerContent, birthdayManagerComponents, handleBirthdayManagerInteraction } = require("../src/services/birthdayManagerService");
const { managerPanelComponents } = require("../src/services/eventSchedulerService");
const birthdayStore = require("../src/stores/birthdayStore");

function fakeInteraction(action, guildId, admin = true, fields = {}) {
  const responses = [];
  const interaction = {
    guildId,
    user: { id: "birthday-admin" },
    memberPermissions: { has: (permission) => admin && ["ManageGuild", "Administrator"].includes(permission) },
    responses,
    fields: { getTextInputValue: (id) => fields[id] || "" },
    isButton: () => !fields.__modal,
    isModalSubmit: () => Boolean(fields.__modal),
    isMessageComponent: () => true,
    reply: async (payload) => responses.push({ type: "reply", payload }),
    update: async (payload) => responses.push({ type: "update", payload }),
    showModal: async (modal) => { interaction.modal = modal; responses.push({ type: "modal", modal }); },
  };
  return interaction;
}

test("community manager exposes one private Birthdays control", () => {
  const rows = managerPanelComponents("community");
  const customIds = rows.flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.ok(customIds.includes("harmony-manager:community:birthdays"));
  assert.equal(customIds.filter((id) => id === "harmony-manager:community:birthdays").length, 1);
});

test("Birthday Manager opens privately and renders current settings", async () => {
  const guildId = `birthday-manager-${Date.now()}`;
  birthdayStore.saveBirthdaySettings({ guildId, channelId: "birthday-channel", roleId: "birthday-role", timezone: "America/New_York", announcementHour: 9, weeklyDay: 0, weeklyEnabled: true, monthlyRecapEnabled: false });
  birthdayStore.upsertBirthdayProfile({ guildId, userId: "100001", birthdayMmdd: "03-25", birthdayName: "Mina", bias: "Han" });
  const interaction = fakeInteraction("birthdays", guildId);
  await handleBirthdayManagerInteraction(interaction, "birthdays");
  assert.equal(interaction.responses[0].payload.flags, 64);
  assert.match(interaction.responses[0].payload.content, /Status: \*\*On\*\*/);
  assert.match(interaction.responses[0].payload.content, /America\/New_York/);
  assert.match(interaction.responses[0].payload.content, /Opted-in profiles: \*\*1\*\*/);
});

test("unauthorized Birthday Manager access is rejected privately", async () => {
  const interaction = fakeInteraction("birthdays", `birthday-unauthorized-${Date.now()}`, false);
  await handleBirthdayManagerInteraction(interaction, "birthdays");
  assert.equal(interaction.responses[0].payload.flags, 64);
  assert.match(interaction.responses[0].payload.content, /Only server administrators/);
});

test("Birthday Manager uses existing profile data for update, customization, clear, preview, and disable confirmation", async () => {
  const guildId = `birthday-actions-${Date.now()}`;
  birthdayStore.upsertBirthdayProfile({ guildId, userId: "100002", birthdayMmdd: "10-12", birthdayName: "Alex", bias: "Felix" });
  const add = fakeInteraction("birthdayaddmodal", guildId, true, { __modal: true, member: "<@100002>", birthday: "11-03", bias: "Han", name: "Alex Updated" });
  await handleBirthdayManagerInteraction(add, "birthdayaddmodal");
  assert.equal(birthdayStore.getBirthdayProfile(guildId, "100002").birthday_mmdd, "11-03");
  const customize = fakeInteraction("birthdaycustomizemodal", guildId, true, { __modal: true, member: "100002", bias: "Changbin", message: "A custom note", "image-url": "" });
  await handleBirthdayManagerInteraction(customize, "birthdaycustomizemodal");
  assert.equal(birthdayStore.getBirthdayProfile(guildId, "100002").custom_message, "A custom note");
  const preview = fakeInteraction("birthdaypreviewmodal", guildId, true, { __modal: true, member: "100002" });
  await handleBirthdayManagerInteraction(preview, "birthdaypreviewmodal");
  assert.ok(preview.responses[0].payload.embeds?.length);
  const clear = fakeInteraction("birthdayclearmodal", guildId, true, { __modal: true, member: "100002" });
  await handleBirthdayManagerInteraction(clear, "birthdayclearmodal");
  assert.equal(birthdayStore.getBirthdayProfile(guildId, "100002").custom_message, null);
  birthdayStore.saveBirthdaySettings({ guildId, channelId: "c", roleId: "r", timezone: "America/New_York", announcementHour: 9, weeklyDay: 0, weeklyEnabled: true, monthlyRecapEnabled: true });
  const weekly = fakeInteraction("birthdayweekly", guildId);
  await handleBirthdayManagerInteraction(weekly, "birthdayweekly");
  assert.equal(birthdayStore.getBirthdaySettings(guildId).weekly_enabled, 0);
  const monthly = fakeInteraction("birthdaymonthly", guildId);
  await handleBirthdayManagerInteraction(monthly, "birthdaymonthly");
  assert.equal(birthdayStore.getBirthdaySettings(guildId).monthly_recap_enabled, 0);
  const off = fakeInteraction("birthdayoff", guildId);
  await handleBirthdayManagerInteraction(off, "birthdayoff");
  assert.match(off.responses[0].payload.content, /Turn birthday scheduling off/);
  const confirm = fakeInteraction("birthdayoffconfirm", guildId);
  await handleBirthdayManagerInteraction(confirm, "birthdayoffconfirm");
  assert.equal(birthdayStore.getBirthdaySettings(guildId).enabled, 0);
});

test("Birthday Manager upcoming view uses Welcome Pass-compatible birthday profiles", async () => {
  const guildId = `birthday-upcoming-${Date.now()}`;
  birthdayStore.upsertBirthdayProfile({ guildId, userId: "100003", birthdayMmdd: "10-20", birthdayName: "STAY", bias: "Han" });
  const interaction = fakeInteraction("birthdayupcoming", guildId);
  await handleBirthdayManagerInteraction(interaction, "birthdayupcoming");
  assert.equal(interaction.responses[0].type, "update");
  assert.match(interaction.responses[0].payload.embeds[0].data.description, /October 20/);
});

test("Birthday Manager content reports the existing system rather than a second data source", () => {
  const guildId = `birthday-content-${Date.now()}`;
  assert.match(birthdayManagerContent(guildId), /existing Welcome Pass birthday profiles/);
  assert.equal(birthdayManagerComponents().length, 3);
});

test("Birthday Manager settings update the existing birthday configuration", async () => {
  const guildId = `birthday-settings-${Date.now()}`;
  const interaction = fakeInteraction("birthdaysettingsmodal", guildId, true, {
    __modal: true,
    channel: "200001",
    role: "200002",
    timezone: "America/Los_Angeles",
    hour: "8",
    "weekly-day": "2",
  });
  interaction.guild = {
    channels: { fetch: async () => ({ isTextBased: () => true }) },
    roles: { fetch: async () => ({ id: "200002", managed: false, position: 1 }) },
    members: { me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } },
  };
  await handleBirthdayManagerInteraction(interaction, "birthdaysettingsmodal");
  const settings = birthdayStore.getBirthdaySettings(guildId);
  assert.equal(settings.timezone, "America/Los_Angeles");
  assert.equal(settings.announcement_hour, 8);
  assert.equal(settings.weekly_day, 2);
});
