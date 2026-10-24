const test = require("node:test");
const assert = require("node:assert/strict");
const { birthdayManagerContent, birthdayManagerComponents, handleBirthdayManagerInteraction } = require("../src/services/birthdayManagerService");
const { managerPanelComponents } = require("../src/services/eventSchedulerService");
const birthdayStore = require("../src/stores/birthdayStore");

function fakeInteraction(action, guildId, admin = true, fields = {}, options = {}) {
  const responses = [];
  const kind = options.kind || (fields.__modal ? "modal" : "button");
  const interaction = {
    guildId,
    user: { id: options.userId || "birthday-admin" },
    customId: options.customId || `harmony-manager:community:${action}`,
    values: options.values || [],
    memberPermissions: { has: (permission) => admin && ["ManageGuild", "Administrator"].includes(permission) },
    responses,
    fields: { getTextInputValue: (id) => fields[id] || "" },
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    isUserSelectMenu: () => kind === "user",
    isStringSelectMenu: () => kind === "string",
    isChannelSelectMenu: () => kind === "channel",
    isRoleSelectMenu: () => kind === "role",
    isMessageComponent: () => true,
    reply: async (payload) => responses.push({ type: "reply", payload }),
    update: async (payload) => responses.push({ type: "update", payload }),
    showModal: async (modal) => { interaction.modal = modal; responses.push({ type: "modal", modal }); },
    guild: options.guild,
  };
  return interaction;
}

test("community manager exposes one private Birthdays control", () => {
  const rows = managerPanelComponents("community");
  const customIds = rows.flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.ok(customIds.includes("harmony-manager:community:birthdays"));
  assert.equal(customIds.filter((id) => id === "harmony-manager:community:birthdays").length, 1);
});

test("Birthday Manager opens ephemerally and renders current settings", async () => {
  const guildId = `birthday-manager-${Date.now()}`;
  birthdayStore.saveBirthdaySettings({ guildId, channelId: "birthday-channel", roleId: "birthday-role", timezone: "America/New_York", announcementHour: 9, weeklyDay: 0, weeklyEnabled: true, monthlyRecapEnabled: false });
  birthdayStore.upsertBirthdayProfile({ guildId, userId: "100001", birthdayMmdd: "03-25", birthdayName: "Mina", bias: "Han" });
  const interaction = fakeInteraction("birthdays", guildId);
  await handleBirthdayManagerInteraction(interaction, "birthdays");
  assert.equal(interaction.responses[0].payload.flags, 64);
  assert.match(interaction.responses[0].payload.content, /Status: \*\*On\*\*/);
  assert.match(interaction.responses[0].payload.content, /Opted-in member birthdays: \*\*1\*\*/);
  assert.ok(interaction.responses[0].payload.components.flatMap((row) => row.components).some((button) => button.data.label === "Manage Birthday"));
});

test("unauthorized Birthday Manager access is rejected privately", async () => {
  const interaction = fakeInteraction("birthdays", `birthday-unauthorized-${Date.now()}`, false);
  await handleBirthdayManagerInteraction(interaction, "birthdays");
  assert.equal(interaction.responses[0].payload.flags, 64);
  assert.match(interaction.responses[0].payload.content, /Only server administrators/);
});

test("member selection routes Manage Birthday through the existing profile store", async () => {
  const guildId = `birthday-manage-${Date.now()}`;
  const open = fakeInteraction("birthdayadd", guildId);
  await handleBirthdayManagerInteraction(open, "birthdayadd");
  assert.equal(open.responses[0].payload.components[0].components[0].data.type, 5);
  const selected = fakeInteraction("birthdaymember", guildId, true, {}, { kind: "user", values: ["100002"], customId: "harmony-manager:community:birthdaymember:add" });
  await handleBirthdayManagerInteraction(selected, "birthdaymember");
  assert.match(selected.responses[0].payload.content, /Choose a bias/);
  const bias = fakeInteraction("birthdaybias", guildId, true, {}, { kind: "string", values: ["Han"], customId: "harmony-manager:community:birthdaybias:add:100002" });
  await handleBirthdayManagerInteraction(bias, "birthdaybias");
  assert.match(bias.modal.data.custom_id, /birthdayaddmodal:100002:Han/);
  const submit = fakeInteraction("birthdayaddmodal", guildId, true, { __modal: true, birthday: "11-03", name: "Alex" }, { kind: "modal", customId: "harmony-manager:community:birthdayaddmodal:100002:Han" });
  await handleBirthdayManagerInteraction(submit, "birthdayaddmodal");
  assert.equal(birthdayStore.getBirthdayProfile(guildId, "100002").birthday_mmdd, "11-03");
  assert.equal(birthdayStore.getBirthdayProfile(guildId, "100002").bias, "Han");
});

test("member selection supports Customize, Preview, and Clear Custom", async () => {
  const guildId = `birthday-actions-${Date.now()}`;
  birthdayStore.upsertBirthdayProfile({ guildId, userId: "100003", birthdayMmdd: "10-12", birthdayName: "Alex", bias: "Felix" });
  birthdayStore.setBirthdayCustomization(guildId, "100003", { bias: "Felix", customMessage: "A custom note", customImageUrl: null });
  const customize = fakeInteraction("birthdaycustomize", guildId);
  await handleBirthdayManagerInteraction(customize, "birthdaycustomize");
  const selected = fakeInteraction("birthdaymember", guildId, true, {}, { kind: "user", values: ["100003"], customId: "harmony-manager:community:birthdaymember:customize" });
  await handleBirthdayManagerInteraction(selected, "birthdaymember");
  const bias = fakeInteraction("birthdaybias", guildId, true, {}, { kind: "string", values: ["Changbin"], customId: "harmony-manager:community:birthdaybias:customize:100003" });
  await handleBirthdayManagerInteraction(bias, "birthdaybias");
  const submit = fakeInteraction("birthdaycustomizemodal", guildId, true, { __modal: true, message: "A new note", "image-url": "" }, { kind: "modal", customId: "harmony-manager:community:birthdaycustomizemodal:100003:Changbin" });
  await handleBirthdayManagerInteraction(submit, "birthdaycustomizemodal");
  assert.equal(birthdayStore.getBirthdayProfile(guildId, "100003").custom_message, "A new note");
  assert.equal(birthdayStore.getBirthdayProfile(guildId, "100003").bias, "Changbin");
  const preview = fakeInteraction("birthdaypreview", guildId);
  await handleBirthdayManagerInteraction(preview, "birthdaypreview");
  const previewSelected = fakeInteraction("birthdaymember", guildId, true, {}, { kind: "user", values: ["100003"], customId: "harmony-manager:community:birthdaymember:preview" });
  await handleBirthdayManagerInteraction(previewSelected, "birthdaymember");
  assert.ok(previewSelected.responses[0].payload.embeds?.length);
  const clear = fakeInteraction("birthdayclear", guildId);
  await handleBirthdayManagerInteraction(clear, "birthdayclear");
  const clearSelected = fakeInteraction("birthdaymember", guildId, true, {}, { kind: "user", values: ["100003"], customId: "harmony-manager:community:birthdaymember:clear" });
  await handleBirthdayManagerInteraction(clearSelected, "birthdaymember");
  assert.equal(birthdayStore.getBirthdayProfile(guildId, "100003").custom_message, null);
});

test("Birthday Manager settings use human-friendly channel, role, timezone, time, and weekday selectors", async () => {
  const guildId = `birthday-settings-${Date.now()}`;
  const settings = fakeInteraction("birthdaysettings", guildId);
  await handleBirthdayManagerInteraction(settings, "birthdaysettings");
  assert.equal(settings.responses[0].payload.components[0].components[0].data.type, 8);
  assert.equal(settings.responses[0].payload.components[1].components[0].data.type, 6);
  const channel = fakeInteraction("birthdaysettingschannel", guildId, true, {}, { kind: "channel", values: ["200001"] });
  await handleBirthdayManagerInteraction(channel, "birthdaysettingschannel");
  const role = fakeInteraction("birthdaysettingsrole", guildId, true, {}, { kind: "role", values: ["200002"] });
  await handleBirthdayManagerInteraction(role, "birthdaysettingsrole");
  const step = fakeInteraction("birthdaysettingsstep2", guildId);
  await handleBirthdayManagerInteraction(step, "birthdaysettingsstep2");
  assert.match(step.responses[0].payload.content, /time zone/);
  const timezone = fakeInteraction("birthdaysettingstimezone", guildId, true, {}, { kind: "string", values: ["America/Los_Angeles"] });
  await handleBirthdayManagerInteraction(timezone, "birthdaysettingstimezone");
  const hour = fakeInteraction("birthdaysettingstime", guildId, true, {}, { kind: "string", values: ["8"] });
  await handleBirthdayManagerInteraction(hour, "birthdaysettingstime");
  const day = fakeInteraction("birthdaysettingsday", guildId, true, {}, { kind: "string", values: ["2"] });
  await handleBirthdayManagerInteraction(day, "birthdaysettingsday");
  const guild = {
    channels: { fetch: async () => ({ isTextBased: () => true }) },
    roles: { fetch: async () => ({ id: "200002", managed: false, position: 1 }) },
    members: { me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } },
  };
  const save = fakeInteraction("birthdaysettingssave", guildId);
  save.guild = guild;
  await handleBirthdayManagerInteraction(save, "birthdaysettingssave");
  const saved = birthdayStore.getBirthdaySettings(guildId);
  assert.equal(saved.channel_id, "200001");
  assert.equal(saved.role_id, "200002");
  assert.equal(saved.timezone, "America/Los_Angeles");
  assert.equal(saved.announcement_hour, 8);
  assert.equal(saved.weekly_day, 2);
});

test("Resolve One Welcome Pass routes the selected member to its modal", async () => {
  const guildId = `birthday-match-one-${Date.now()}`;
  const open = fakeInteraction("birthdaymatchmember", guildId);
  await handleBirthdayManagerInteraction(open, "birthdaymatchmember");
  assert.match(open.responses[0].payload.content, /Choose the Discord member/);
  const selected = fakeInteraction("birthdaymember", guildId, true, {}, {
    kind: "user",
    values: ["100005"],
    customId: "harmony-manager:community:birthdaymember:matchmember",
  });
  await handleBirthdayManagerInteraction(selected, "birthdaymember");
  assert.ok(selected.modal);
  assert.equal(selected.modal.data.custom_id, "harmony-manager:community:birthdaymatchmembermodal:100005");
  assert.equal(selected.modal.data.title, "Connect Welcome Pass birthday");
});

test("Welcome Pass matching, reminder controls, and confirmed disable remain available", async () => {
  const guildId = `birthday-controls-${Date.now()}`;
  birthdayStore.saveBirthdaySettings({ guildId, channelId: "c", roleId: "r", timezone: "America/New_York", announcementHour: 9, weeklyDay: 0, weeklyEnabled: true, monthlyRecapEnabled: true });
  const labels = birthdayManagerComponents().flatMap((row) => row.components).map((component) => component.data.label);
  assert.ok(labels.includes("Connect Welcome Passes"));
  assert.ok(labels.includes("Resolve One Welcome Pass"));
  assert.ok(labels.includes("Turn Weekly Reminder Off/On"));
  assert.ok(labels.includes("Turn Monthly Recap Off/On"));
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

test("Upcoming birthdays use member-friendly Welcome Pass wording", async () => {
  const guildId = `birthday-upcoming-${Date.now()}`;
  birthdayStore.upsertBirthdayProfile({ guildId, userId: "100004", birthdayMmdd: "10-20", birthdayName: "STAY", bias: "Han" });
  const interaction = fakeInteraction("birthdayupcoming", guildId);
  await handleBirthdayManagerInteraction(interaction, "birthdayupcoming");
  assert.match(interaction.responses[0].payload.embeds[0].data.footer.text, /Includes opted-in members and configured non-member birthdays/);
});

test("Birthday Manager content reports the existing system rather than a second data source", () => {
  const guildId = `birthday-content-${Date.now()}`;
  assert.match(birthdayManagerContent(guildId), /existing birthday profiles/);
  assert.equal(birthdayManagerComponents().length, 3);
});

test("non-member birthdays have a separate admin flow and do not replace the Discord member picker", async () => {
  const guildId = `birthday-nonmember-ui-${Date.now()}`;
  const components = birthdayManagerComponents().flatMap((row) => row.components);
  assert.ok(components.some((button) => button.data.label === "Non-Member Birthdays"));

  const denied = fakeInteraction("birthdaynonmember", guildId, false);
  await handleBirthdayManagerInteraction(denied, "birthdaynonmember");
  assert.match(denied.responses[0].payload.content, /Only server administrators/);
  assert.equal(denied.responses[0].payload.flags, 64);

  const open = fakeInteraction("birthdaynonmember", guildId);
  await handleBirthdayManagerInteraction(open, "birthdaynonmember");
  assert.match(open.responses[0].payload.content, /not Discord server members/);
  const add = fakeInteraction("birthdaynonmemberadd", guildId);
  await handleBirthdayManagerInteraction(add, "birthdaynonmemberadd");
  assert.equal(add.modal.data.title, "Add non-member birthday");
  assert.equal(add.modal.toJSON().components[2].components[0].value, "Asia/Seoul");

  const submit = fakeInteraction("birthdaynonmemberaddmodal", guildId, true, {
    name: "Lee Know", birthday: "10-25", timezone: "Asia/Seoul",
  }, { kind: "modal" });
  await handleBirthdayManagerInteraction(submit, "birthdaynonmemberaddmodal");
  const saved = birthdayStore.listNonDiscordBirthdayProfiles(guildId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].birthday_name, "Lee Know");
  assert.equal(saved[0].birthday_mmdd, "10-25");
  assert.equal(saved[0].timezone, "Asia/Seoul");
  assert.equal(saved[0].user_id, null);

  const memberFlow = fakeInteraction("birthdayadd", guildId);
  await handleBirthdayManagerInteraction(memberFlow, "birthdayadd");
  assert.equal(memberFlow.responses[0].payload.components[0].components[0].data.type, 5);
});

test("non-member birthdays can be edited and explicitly removed from their scoped admin list", async () => {
  const guildId = `birthday-nonmember-manage-${Date.now()}`;
  const id = birthdayStore.upsertNonDiscordBirthdayProfile({ guildId, birthdayName: "Lee Know", birthdayMmdd: "10-25", timezone: "Asia/Seoul" });
  const editButton = fakeInteraction("birthdaynonmemberedit", guildId, true, {}, { customId: `harmony-manager:community:birthdaynonmemberedit:${id}` });
  await handleBirthdayManagerInteraction(editButton, "birthdaynonmemberedit");
  assert.equal(editButton.modal.toJSON().components[0].components[0].value, "Lee Know");

  const edit = fakeInteraction("birthdaynonmembereditmodal", guildId, true, {
    name: "Lee Know", birthday: "10-25", timezone: "Asia/Seoul",
  }, { kind: "modal", customId: `harmony-manager:community:birthdaynonmembereditmodal:${id}` });
  await handleBirthdayManagerInteraction(edit, "birthdaynonmembereditmodal");
  assert.equal(birthdayStore.getNonDiscordBirthdayProfile(guildId, id).birthday_mmdd, "10-25");

  const remove = fakeInteraction("birthdaynonmemberdeleteconfirm", guildId, true, {}, { customId: `harmony-manager:community:birthdaynonmemberdeleteconfirm:${id}` });
  await handleBirthdayManagerInteraction(remove, "birthdaynonmemberdeleteconfirm");
  assert.equal(birthdayStore.getNonDiscordBirthdayProfile(guildId, id), null);
});
