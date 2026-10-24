const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const birthdayStore = require("../stores/birthdayStore");
const { linkWelcomePassCode } = require("../stores/welcomePassStore");
const { normalizeBias, BIASES } = require("./birthdayPresets");
const {
  validTimezone,
  validMmdd,
  formatMmdd,
  upcomingProfiles,
  buildBirthdayEmbed,
} = require("./birthdayService");
const { YOUTIFUL_TIMEZONE_OPTIONS } = require("../data/youtifulTimezones");

const managerSessions = new Map();
const ANNOUNCEMENT_HOURS = [
  [0, "12:00 AM"], [1, "1:00 AM"], [2, "2:00 AM"], [3, "3:00 AM"], [4, "4:00 AM"],
  [5, "5:00 AM"], [6, "6:00 AM"], [7, "7:00 AM"], [8, "8:00 AM"], [9, "9:00 AM"],
  [10, "10:00 AM"], [11, "11:00 AM"], [12, "12:00 PM"], [13, "1:00 PM"], [14, "2:00 PM"],
  [15, "3:00 PM"], [16, "4:00 PM"], [17, "5:00 PM"], [18, "6:00 PM"], [19, "7:00 PM"],
  [20, "8:00 PM"], [21, "9:00 PM"], [22, "10:00 PM"], [23, "11:00 PM"],
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isBirthdayAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has?.("ManageGuild") ||
    interaction.memberPermissions?.has?.("Administrator")
  );
}

function sessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user?.id || "unknown"}`;
}

function getSession(interaction) {
  return managerSessions.get(sessionKey(interaction)) || {};
}

function saveSession(interaction, changes) {
  const next = { ...getSession(interaction), ...changes };
  managerSessions.set(sessionKey(interaction), next);
  return next;
}

function clearSession(interaction) {
  managerSessions.delete(sessionKey(interaction));
}

function memberSelect(customId, placeholder = "Choose a member") {
  return [new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1),
  )];
}

function biasSelect(customId, selected = null, includeKeep = false) {
  const options = [];
  if (includeKeep) options.push({ label: "Keep current bias", value: "__keep__", description: "Leave the saved bias unchanged" });
  options.push(...BIASES.map((bias) => ({ label: bias, value: bias, default: bias === selected })));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose a bias").addOptions(options),
  );
}

function timezoneSelect(customId, selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose a time zone").addOptions(
      YOUTIFUL_TIMEZONE_OPTIONS.filter((option) => option.value !== "none").map((option) => ({ ...option, default: option.value === selected })),
    ),
  );
}

function hourSelect(customId, selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose an announcement time").addOptions(
      ANNOUNCEMENT_HOURS.map(([value, label]) => ({ label, value: String(value), default: Number(selected) === value })),
    ),
  );
}

function weekdaySelect(customId, selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose a weekly reminder day").addOptions(
      WEEKDAYS.map((label, value) => ({ label, value: String(value), default: Number(selected) === value })),
    ),
  );
}

function timezoneLabel(value) {
  return YOUTIFUL_TIMEZONE_OPTIONS.find((option) => option.value === value)?.label || value || "Not set";
}

function hourLabel(value) {
  const found = ANNOUNCEMENT_HOURS.find(([hour]) => Number(hour) === Number(value));
  return found ? found[1] : "Not set";
}

function settingsChannelRoleComponents(settings = {}) {
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId("harmony-manager:community:birthdaysettingschannel")
      .setPlaceholder("Choose the announcement channel")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
      .setCustomId("harmony-manager:community:birthdaysettingsrole")
      .setPlaceholder("Choose the birthday role")
      .setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaysettingsstep2").setLabel("Continue to time settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayhome").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function settingsLines(settings) {
  if (!settings) return ["Status: **Off / not configured**", "Use **Settings** to connect the existing birthday scheduler."];
  return [
    `Status: **${settings.enabled ? "On" : "Off"}**`,
    `Announcement channel: ${settings.channel_id ? `<#${settings.channel_id}>` : "Not set"}`,
    `Birthday role: ${settings.role_id ? `<@&${settings.role_id}>` : "Not set"}`,
    `Time zone: **${timezoneLabel(settings.timezone)}**`,
    `Announcement time: **${hourLabel(settings.announcement_hour)}**`,
    `Weekly reminder: **${settings.weekly_enabled ? "On" : "Off"}**`,
    `Monthly recap: **${settings.monthly_recap_enabled ? "On" : "Off"}**`,
  ];
}

function birthdayManagerContent(guildId) {
  const settings = birthdayStore.getBirthdaySettings(guildId);
  const profiles = birthdayStore.listBirthdayProfiles(guildId);
  const memberProfiles = profiles.filter((profile) => profile.user_id).length;
  return [
    "🎂 **BIRTHDAY MANAGER**",
    "",
    ...settingsLines(settings),
    `Opted-in member birthdays: **${memberProfiles}**`,
    "",
    "This panel uses Harmony's existing birthday profiles, scheduler, presets, and role behavior.",
  ].join("\n");
}

function birthdayManagerComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaystatus").setLabel("Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayupcoming").setLabel("Upcoming").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayadd").setLabel("Manage Birthday").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaycustomize").setLabel("Customize").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayclear").setLabel("Clear Custom").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaypreview").setLabel("Preview").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaymatchall").setLabel("Connect Welcome Passes").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaymatchmember").setLabel("Resolve One Welcome Pass").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaynonmember").setLabel("Non-Member Birthdays").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaysettings").setLabel("Settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayweekly").setLabel("Turn Weekly Reminder Off/On").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaymonthly").setLabel("Turn Monthly Recap Off/On").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayoff").setLabel("Turn Off").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayhome").setLabel("Refresh").setStyle(ButtonStyle.Success),
    ),
  ];
}

function birthdayBackRow() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-manager:community:birthdayhome").setLabel("Back to Birthday Manager").setStyle(ButtonStyle.Secondary),
  )];
}

function nonMemberBirthdayComponents(profiles = []) {
  const rows = [];
  if (profiles.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("harmony-manager:community:birthdaynonmemberselect")
        .setPlaceholder("Choose a non-member birthday to manage")
        .addOptions(profiles.slice(0, 25).map((profile) => ({
          label: `${profile.birthday_name} — ${profile.birthday_mmdd}`.slice(0, 100),
          value: String(profile.id),
        }))),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-manager:community:birthdaynonmemberadd").setLabel("Add Birthday").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("harmony-manager:community:birthdayhome").setLabel("Back to Birthday Manager").setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

function nonMemberBirthdayModal(action, profile = {}) {
  return textModal(`harmony-manager:community:${action}${profile.id ? `:${profile.id}` : ""}`, profile.id ? "Edit non-member birthday" : "Add non-member birthday", [
    { id: "name", label: "Display name", required: true, maxLength: 80, value: profile.birthday_name },
    { id: "birthday", label: "Birthday (MM-DD)", required: true, maxLength: 5, value: profile.birthday_mmdd },
    { id: "timezone", label: "IANA time zone", required: true, maxLength: 100, value: profile.timezone || "Asia/Seoul" },
  ]);
}

function renderNonMemberBirthday(profile) {
  return [
    `**${profile.birthday_name}**`,
    `Birthday: **${formatMmdd(profile.birthday_mmdd)}** (${profile.birthday_mmdd})`,
    `Time zone: **${profile.timezone}**`,
    "This annual birthday is not linked to a Discord member and does not receive a birthday role.",
  ].join("\n");
}

function textModal(customId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  modal.addComponents(fields.map((field) => {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(Boolean(field.required))
      .setMaxLength(field.maxLength || 1000);
    if (field.value) input.setValue(String(field.value).slice(0, field.maxLength || 1000));
    return new ActionRowBuilder().addComponents(input);
  }));
  return modal;
}

function profileEditModal(action, memberId, bias = null, profile = null) {
  const isAdd = action === "birthdayadd";
  const fields = isAdd
    ? [
      { id: "birthday", label: "Birthday (MM-DD)", required: true, maxLength: 5, value: profile?.birthday_mmdd },
      { id: "name", label: "Announcement name (optional)", maxLength: 80, value: profile?.birthday_name },
    ]
    : [
      { id: "message", label: "Custom birthday message (optional)", paragraph: true, maxLength: 1000, value: profile?.custom_message },
      { id: "image-url", label: "HTTPS image URL (optional)", maxLength: 500, value: profile?.custom_image_url },
    ];
  return textModal(`harmony-manager:community:${action}modal:${memberId}:${encodeURIComponent(bias || "__keep__")}`, isAdd ? "Manage birthday" : "Customize birthday", fields);
}

function renderUpcoming(guildId) {
  const profiles = upcomingProfiles(guildId, 30);
  const description = profiles.length
    ? profiles.map((p) => `🎂 ${p.user_id ? `<@${p.user_id}>` : `**${p.birthday_name}**`} — ${formatMmdd(p.birthday_mmdd)}${p.daysAway === 0 ? " (today)" : ` (in ${p.daysAway} days)`}`).join("\n")
    : "No birthdays are coming up in the next 30 days.";
  return new EmbedBuilder().setColor(0xc084fc).setTitle("📅 Upcoming birthdays").setDescription(description).setFooter({ text: "Includes opted-in members and configured non-member birthdays." });
}

async function saveSettings(interaction, selected = {}) {
  const existing = birthdayStore.getBirthdaySettings(interaction.guildId) || {};
  const channelId = selected.channelId || existing.channel_id;
  const roleId = selected.roleId || existing.role_id;
  const timezone = selected.timezone || existing.timezone || "America/New_York";
  const hour = Number(selected.announcementHour ?? existing.announcement_hour ?? 9);
  const weeklyDay = Number(selected.weeklyDay ?? existing.weekly_day ?? 0);
  const weekly = existing.weekly_enabled !== 0;
  const monthly = existing.monthly_recap_enabled !== 0;
  const channel = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
  const role = roleId ? await interaction.guild.roles.fetch(roleId).catch(() => null) : null;
  if (!channel?.isTextBased?.() || !role || !validTimezone(timezone) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(weeklyDay) || weeklyDay < 0 || weeklyDay > 6) {
    throw new Error("Choose a valid announcement channel, birthday role, time zone, announcement time, and reminder day.");
  }
  const me = interaction.guild.members.me;
  if (role.managed || role.id === interaction.guild.id || !me?.permissions?.has?.("ManageRoles") || role.position >= me.roles.highest.position) {
    throw new Error("Choose a regular birthday role below Harmony's highest role.");
  }
  birthdayStore.saveBirthdaySettings({ guildId: interaction.guildId, channelId, roleId, timezone, announcementHour: hour, weeklyDay, weeklyEnabled: weekly, monthlyRecapEnabled: monthly });
}

function settingsStep2Components(settings) {
  return [
    timezoneSelect("harmony-manager:community:birthdaysettingstimezone", settings.timezone || "America/New_York"),
    hourSelect("harmony-manager:community:birthdaysettingstime", settings.announcementHour ?? settings.announcement_hour ?? 9),
    weekdaySelect("harmony-manager:community:birthdaysettingsday", settings.weeklyDay ?? settings.weekly_day ?? 0),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaysettingssave").setLabel("Save Birthday Settings").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayhome").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function normalizeName(value) {
  return String(value || "").trim().replace(/^@/, "").toLocaleLowerCase();
}

function memberNames(member) {
  return new Set([
    member.user?.username,
    member.user?.globalName,
    member.displayName,
    member.user?.discriminator && member.user.discriminator !== "0"
      ? `${member.user.username}#${member.user.discriminator}` : null,
  ].map(normalizeName).filter(Boolean));
}

async function matchAllImportedBirthdays(interaction) {
  const pending = birthdayStore.listUnlinkedWelcomePassBirthdayProfiles();
  const fetched = await interaction.guild.members.fetch().catch(() => null);
  if (!fetched) throw new Error("Harmony could not read the server member list. Confirm Server Members Intent is enabled.");
  const members = [...fetched.values()].filter((member) => !member.user.bot);
  const result = { connected: 0, unresolved: [] };
  for (const profile of pending) {
    const target = normalizeName(profile.discord_username);
    const label = profile.birthday_name || profile.discord_username || profile.welcome_pass_code;
    if (!target) { result.unresolved.push({ name: label, reason: "missing Discord username" }); continue; }
    const usernameMatches = members.filter((member) => normalizeName(member.user.username) === target || (member.user.discriminator !== "0" && normalizeName(`${member.user.username}#${member.user.discriminator}`) === target));
    const matches = usernameMatches.length ? usernameMatches : members.filter((member) => memberNames(member).has(target));
    if (matches.length !== 1) { result.unresolved.push({ name: label, reason: matches.length ? "more than one member has that name" : "no matching server member" }); continue; }
    const linked = linkWelcomePassCode({ code: profile.welcome_pass_code, guildId: interaction.guildId, userId: matches[0].id });
    if (!linked.ok || !birthdayStore.attachWelcomePassBirthdayProfile(profile.welcome_pass_code)) result.unresolved.push({ name: label, reason: "Welcome Pass link conflict" });
    else result.connected += 1;
  }
  return result;
}

function customParts(interaction) {
  return String(interaction.customId || "").split(":");
}

function selectedMemberId(interaction) {
  return String(interaction.values?.[0] || "");
}

function memberPrompt(action, text) {
  return {
    content: text,
    components: memberSelect(`harmony-manager:community:birthdaymember:${action}`),
    embeds: [],
  };
}

async function handleBirthdayManagerInteraction(interaction, action) {
  if (!isBirthdayAdmin(interaction)) {
    await interaction.reply({ content: "Only server administrators can use Birthday Manager.", flags: 64 });
    return true;
  }
  if (action === "birthdays" && interaction.isButton?.()) {
    await interaction.reply({ content: birthdayManagerContent(interaction.guildId), components: birthdayManagerComponents(), flags: 64 });
    return true;
  }
  if (action === "birthdayhome" && (interaction.isButton?.() || interaction.isMessageComponent?.())) {
    await interaction.update({ content: birthdayManagerContent(interaction.guildId), components: birthdayManagerComponents(), embeds: [] });
    return true;
  }
  if (action === "birthdaystatus" && interaction.isButton?.()) {
    await interaction.update({ content: birthdayManagerContent(interaction.guildId), components: birthdayBackRow() });
    return true;
  }
  if (action === "birthdayupcoming" && interaction.isButton?.()) {
    await interaction.update({ content: "Here are the next 30 days of opted-in birthdays:", embeds: [renderUpcoming(interaction.guildId)], components: birthdayBackRow() });
    return true;
  }
  if (action === "birthdayadd" && interaction.isButton?.()) {
    await interaction.update(memberPrompt("add", "Choose the Discord member whose birthday you want to manage."));
    return true;
  }
  if (action === "birthdaynonmember" && interaction.isButton?.()) {
    const profiles = birthdayStore.listNonDiscordBirthdayProfiles(interaction.guildId);
    await interaction.update({
      content: ["🎂 **NON-MEMBER BIRTHDAYS**", "Add recurring birthdays for people who are not Discord server members. Each birthday uses its own IANA time zone; no Discord account or birth year is stored.", profiles.length ? `\nSaved birthdays: **${profiles.length}**` : "\nNo non-member birthdays are configured yet."].join("\n"),
      components: nonMemberBirthdayComponents(profiles), embeds: [],
    });
    return true;
  }
  if (action === "birthdaynonmemberadd" && interaction.isButton?.()) {
    await interaction.showModal(nonMemberBirthdayModal("birthdaynonmemberaddmodal"));
    return true;
  }
  if (action === "birthdaynonmemberaddmodal" && interaction.isModalSubmit?.()) {
    const name = interaction.fields.getTextInputValue("name").trim();
    const birthday = interaction.fields.getTextInputValue("birthday").trim();
    const timezone = interaction.fields.getTextInputValue("timezone").trim();
    if (!name || name.length > 80 || !validMmdd(birthday) || !validTimezone(timezone)) {
      await interaction.reply({ content: "Enter a display name, a valid MM-DD birthday, and a valid IANA time zone such as Asia/Seoul.", flags: 64 });
      return true;
    }
    birthdayStore.upsertNonDiscordBirthdayProfile({ guildId: interaction.guildId, birthdayName: name, birthdayMmdd: birthday, timezone });
    await interaction.reply({ content: `Saved **${name}** as an annual birthday on **${formatMmdd(birthday)}** in **${timezone}**.`, components: birthdayBackRow(), flags: 64 });
    return true;
  }
  if (action === "birthdaynonmemberselect" && interaction.isStringSelectMenu?.()) {
    const profile = birthdayStore.getNonDiscordBirthdayProfile(interaction.guildId, interaction.values?.[0]);
    if (!profile) {
      await interaction.update({ content: "That non-member birthday is no longer available.", components: birthdayBackRow(), embeds: [] });
      return true;
    }
    await interaction.update({ content: renderNonMemberBirthday(profile), components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`harmony-manager:community:birthdaynonmemberedit:${profile.id}`).setLabel("Edit").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`harmony-manager:community:birthdaynonmemberdelete:${profile.id}`).setLabel("Remove").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("harmony-manager:community:birthdaynonmember").setLabel("Back").setStyle(ButtonStyle.Secondary),
      ),
    ], embeds: [] });
    return true;
  }
  if (action === "birthdaynonmemberedit" && interaction.isButton?.()) {
    const profileId = customParts(interaction)[3];
    const profile = birthdayStore.getNonDiscordBirthdayProfile(interaction.guildId, profileId);
    if (!profile) {
      await interaction.update({ content: "That non-member birthday is no longer available.", components: birthdayBackRow(), embeds: [] });
      return true;
    }
    await interaction.showModal(nonMemberBirthdayModal("birthdaynonmembereditmodal", profile));
    return true;
  }
  if (action === "birthdaynonmembereditmodal" && interaction.isModalSubmit?.()) {
    const profileId = customParts(interaction)[3];
    const name = interaction.fields.getTextInputValue("name").trim();
    const birthday = interaction.fields.getTextInputValue("birthday").trim();
    const timezone = interaction.fields.getTextInputValue("timezone").trim();
    if (!profileId || !name || name.length > 80 || !validMmdd(birthday) || !validTimezone(timezone)) {
      await interaction.reply({ content: "Enter a display name, a valid MM-DD birthday, and a valid IANA time zone such as Asia/Seoul.", flags: 64 });
      return true;
    }
    const updated = birthdayStore.updateNonDiscordBirthdayProfile(interaction.guildId, profileId, { birthdayName: name, birthdayMmdd: birthday, timezone });
    await interaction.reply({ content: updated ? `Updated **${name}** to **${formatMmdd(birthday)}** in **${timezone}**.` : "That non-member birthday is no longer available.", components: birthdayBackRow(), flags: 64 });
    return true;
  }
  if (action === "birthdaynonmemberdelete" && interaction.isButton?.()) {
    const profileId = customParts(interaction)[3];
    const profile = birthdayStore.getNonDiscordBirthdayProfile(interaction.guildId, profileId);
    if (!profile) {
      await interaction.update({ content: "That non-member birthday is no longer available.", components: birthdayBackRow(), embeds: [] });
      return true;
    }
    await interaction.update({ content: `Remove the recurring birthday for **${profile.birthday_name}**? Past announcement history will remain.`, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-manager:community:birthdaynonmemberdeleteconfirm:${profile.id}`).setLabel("Confirm Remove").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`harmony-manager:community:birthdaynonmemberedit:${profile.id}`).setLabel("Keep / Edit").setStyle(ButtonStyle.Secondary),
    )], embeds: [] });
    return true;
  }
  if (action === "birthdaynonmemberdeleteconfirm" && interaction.isButton?.()) {
    const profileId = customParts(interaction)[3];
    const removed = birthdayStore.deleteNonDiscordBirthdayProfile(interaction.guildId, profileId);
    const profiles = birthdayStore.listNonDiscordBirthdayProfiles(interaction.guildId);
    await interaction.update({ content: removed ? "Non-member birthday removed. Past announcement history remains." : "That non-member birthday is no longer available.", components: nonMemberBirthdayComponents(profiles), embeds: [] });
    return true;
  }
  if (action === "birthdaycustomize" && interaction.isButton?.()) {
    await interaction.update(memberPrompt("customize", "Choose the Discord member whose birthday message you want to customize."));
    return true;
  }
  if (action === "birthdayclear" && interaction.isButton?.()) {
    await interaction.update(memberPrompt("clear", "Choose the member whose custom birthday message should be cleared."));
    return true;
  }
  if (action === "birthdaypreview" && interaction.isButton?.()) {
    await interaction.update(memberPrompt("preview", "Choose a member to preview their birthday announcement."));
    return true;
  }
  if (action === "birthdaymember" && interaction.isUserSelectMenu?.()) {
    const [, , , mode] = customParts(interaction);
    const memberId = selectedMemberId(interaction);
    if (!memberId || !["add", "customize", "clear", "preview", "matchmember"].includes(mode)) return true;
    if (mode === "matchmember") {
      saveSession(interaction, { memberId });
      await interaction.showModal(textModal(`harmony-manager:community:birthdaymatchmembermodal:${memberId}`, "Connect Welcome Pass birthday", [
        { id: "imported-name", label: "Welcome Pass name or code", required: true, maxLength: 100 },
      ]));
      return true;
    }
    if (mode === "clear" || mode === "preview") {
      const profile = birthdayStore.getBirthdayProfile(interaction.guildId, memberId);
      if (!profile) {
        await interaction.update({ content: "That member does not have a birthday profile yet.", components: birthdayBackRow(), embeds: [] });
        return true;
      }
      if (mode === "clear") {
        birthdayStore.clearBirthdayCustomization(interaction.guildId, memberId);
        await interaction.update({ content: "That member will use Harmony's rotating birthday messages again.", components: birthdayBackRow(), embeds: [] });
      } else {
        await interaction.update({ content: `Preview for <@${memberId}>:`, embeds: [buildBirthdayEmbed(profile, new Date().getUTCFullYear(), true)], components: birthdayBackRow() });
      }
      return true;
    }
    const profile = birthdayStore.getBirthdayProfile(interaction.guildId, memberId);
    const currentBias = profile?.bias ? normalizeBias(profile.bias) : null;
    saveSession(interaction, { memberId, mode });
    await interaction.update({
      content: mode === "add" ? "Choose a bias, then enter the birthday details." : "Choose a bias, or keep the current bias, then enter the customization.",
      components: [biasSelect(`harmony-manager:community:birthdaybias:${mode}:${memberId}`, currentBias, mode === "customize"), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("harmony-manager:community:birthdayhome").setLabel("Cancel").setStyle(ButtonStyle.Secondary))],
      embeds: [],
    });
    return true;
  }
  if (action === "birthdaybias" && interaction.isStringSelectMenu?.()) {
    const [, , , mode, memberId] = customParts(interaction);
    const selectedBias = interaction.values?.[0];
    if (!memberId || !["add", "customize"].includes(mode) || !selectedBias) return true;
    const profile = birthdayStore.getBirthdayProfile(interaction.guildId, memberId);
    await interaction.showModal(profileEditModal(mode === "add" ? "birthdayadd" : "birthdaycustomize", memberId, selectedBias === "__keep__" ? (profile?.bias || "__keep__") : selectedBias, profile));
    return true;
  }
  if (action === "birthdayaddmodal" && interaction.isModalSubmit?.()) {
    const [, , , memberId, biasValue] = customParts(interaction);
    const memberIdValue = memberId || getSession(interaction).memberId;
    const birthday = interaction.fields.getTextInputValue("birthday").trim();
    if (!memberIdValue || !validMmdd(birthday)) { await interaction.reply({ content: "Choose a member and enter a valid birthday in MM-DD format.", flags: 64 }); return true; }
    const bias = normalizeBias(decodeURIComponent(biasValue || "Still deciding"));
    birthdayStore.upsertBirthdayProfile({ guildId: interaction.guildId, userId: memberIdValue, birthdayMmdd: birthday, birthdayName: interaction.fields.getTextInputValue("name").trim() || memberIdValue, bias });
    clearSession(interaction);
    await interaction.reply({ content: `Saved <@${memberIdValue}>'s birthday as **${formatMmdd(birthday)}**.`, components: birthdayBackRow(), flags: 64 });
    return true;
  }
  if (action === "birthdaycustomizemodal" && interaction.isModalSubmit?.()) {
    const [, , , memberId, biasValue] = customParts(interaction);
    const memberIdValue = memberId || getSession(interaction).memberId;
    const imageUrl = interaction.fields.getTextInputValue("image-url").trim();
    const message = interaction.fields.getTextInputValue("message").trim();
    const bias = decodeURIComponent(biasValue || "__keep__");
    if (!memberIdValue || (!message && !imageUrl && bias === "__keep__") || (imageUrl && !/^https:\/\//i.test(imageUrl))) { await interaction.reply({ content: "Choose a member and enter a message, bias, or HTTPS image URL.", flags: 64 }); return true; }
    const updated = birthdayStore.setBirthdayCustomization(interaction.guildId, memberIdValue, { bias: bias === "__keep__" ? null : normalizeBias(bias), customMessage: message, customImageUrl: imageUrl });
    clearSession(interaction);
    await interaction.reply({ content: updated ? `Saved <@${memberIdValue}>'s birthday customization.` : "That member has no birthday profile yet.", components: birthdayBackRow(), flags: 64 });
    return true;
  }
  if (action === "birthdaysettings" && interaction.isButton?.()) {
    const settings = birthdayStore.getBirthdaySettings(interaction.guildId) || {};
    saveSession(interaction, { channelId: settings.channel_id || null, roleId: settings.role_id || null });
    await interaction.update({ content: "Choose the announcement channel and birthday role Harmony should use.", components: settingsChannelRoleComponents(settings), embeds: [] });
    return true;
  }
  if (action === "birthdaysettingschannel" && interaction.isChannelSelectMenu?.()) {
    saveSession(interaction, { channelId: selectedMemberId(interaction) });
    await interaction.update({ content: "Announcement channel selected. Now choose the birthday role.", components: settingsChannelRoleComponents(), embeds: [] });
    return true;
  }
  if (action === "birthdaysettingsrole" && interaction.isRoleSelectMenu?.()) {
    saveSession(interaction, { roleId: selectedMemberId(interaction) });
    await interaction.update({ content: "Birthday role selected. Continue to choose time zone, announcement time, and reminder day.", components: settingsChannelRoleComponents(), embeds: [] });
    return true;
  }
  if (action === "birthdaysettingsstep2" && interaction.isButton?.()) {
    const settings = birthdayStore.getBirthdaySettings(interaction.guildId) || {};
    const current = { ...settings, ...getSession(interaction) };
    if (!current.channelId || !current.roleId) {
      await interaction.update({ content: "Please choose both an announcement channel and birthday role first.", components: settingsChannelRoleComponents(), embeds: [] });
      return true;
    }
    saveSession(interaction, current);
    await interaction.update({
      content: "Choose Harmony's time zone, announcement time, and weekly reminder day.",
      components: settingsStep2Components(current),
      embeds: [],
    });
    return true;
  }
  if (action === "birthdaysettingstimezone" && interaction.isStringSelectMenu?.()) {
    const current = saveSession(interaction, { timezone: interaction.values[0] });
    await interaction.update({ content: `Time zone selected: **${YOUTIFUL_TIMEZONE_OPTIONS.find((option) => option.value === interaction.values[0])?.label || "Selected"}**. Continue choosing the remaining settings.`, components: settingsStep2Components(current) });
    return true;
  }
  if (action === "birthdaysettingstime" && interaction.isStringSelectMenu?.()) {
    const current = saveSession(interaction, { announcementHour: Number(interaction.values[0]) });
    await interaction.update({ content: `Announcement time selected: **${ANNOUNCEMENT_HOURS.find(([value]) => value === Number(interaction.values[0]))?.[1] || "Selected"}**. Continue choosing the remaining settings.`, components: settingsStep2Components(current) });
    return true;
  }
  if (action === "birthdaysettingsday" && interaction.isStringSelectMenu?.()) {
    const current = saveSession(interaction, { weeklyDay: Number(interaction.values[0]) });
    await interaction.update({ content: `Weekly reminder day selected: **${WEEKDAYS[Number(interaction.values[0])] || "Selected"}**. Save when ready.`, components: settingsStep2Components(current) });
    return true;
  }
  if (action === "birthdaysettingssave" && interaction.isButton?.()) {
    const existing = birthdayStore.getBirthdaySettings(interaction.guildId) || {};
    const current = { ...existing, ...getSession(interaction) };
    try {
      await saveSettings(interaction, current);
      clearSession(interaction);
      await interaction.update({ content: "Birthday settings saved. Existing scheduler behavior is unchanged.", components: birthdayBackRow(), embeds: [] });
    } catch (error) {
      await interaction.update({ content: error.message, components: birthdayBackRow(), embeds: [] });
    }
    return true;
  }
  if (["birthdayweekly", "birthdaymonthly"].includes(action) && interaction.isButton?.()) {
    const settings = birthdayStore.getBirthdaySettings(interaction.guildId);
    if (!settings) { await interaction.update({ content: "Set up birthdays before changing reminder settings.", components: birthdayBackRow() }); return true; }
    const weeklyEnabled = action === "birthdayweekly" ? !Boolean(settings.weekly_enabled) : Boolean(settings.weekly_enabled);
    const monthlyRecapEnabled = action === "birthdaymonthly" ? !Boolean(settings.monthly_recap_enabled) : Boolean(settings.monthly_recap_enabled);
    birthdayStore.saveBirthdaySettings({ guildId: interaction.guildId, channelId: settings.channel_id, roleId: settings.role_id, timezone: settings.timezone, announcementHour: settings.announcement_hour, weeklyDay: settings.weekly_day, weeklyEnabled, monthlyRecapEnabled });
    await interaction.update({ content: birthdayManagerContent(interaction.guildId), components: birthdayManagerComponents() });
    return true;
  }
  if (action === "birthdaymatchall" && interaction.isButton?.()) {
    try {
      const result = await matchAllImportedBirthdays(interaction);
      const unresolved = result.unresolved.slice(0, 15).map((item) => `• ${item.name} — ${item.reason}`);
      await interaction.reply({ content: [`🎂 **Birthday matching complete**`, `Connected: **${result.connected}**`, `Still needs attention: **${result.unresolved.length}**`, ...unresolved].join("\n"), components: birthdayBackRow(), flags: 64 });
    } catch (error) { await interaction.reply({ content: error.message, components: birthdayBackRow(), flags: 64 }); }
    return true;
  }
  if (action === "birthdaymatchmember" && interaction.isButton?.()) {
    await interaction.update(memberPrompt("matchmember", "Choose the Discord member to connect to a Welcome Pass birthday."));
    return true;
  }
  if (action === "birthdaymatchmembermodal" && interaction.isModalSubmit?.()) {
    const importedName = normalizeName(interaction.fields.getTextInputValue("imported-name"));
    const [, , , memberId] = customParts(interaction);
    const matches = birthdayStore.listUnlinkedWelcomePassBirthdayProfiles().filter((profile) => [profile.birthday_name, profile.discord_username, profile.welcome_pass_code].some((value) => normalizeName(value) === importedName));
    if (matches.length !== 1 || !memberId) { await interaction.reply({ content: matches.length > 1 ? "More than one Welcome Pass birthday matches. Use the exact Welcome Pass code." : "No unique Welcome Pass birthday matched that name.", flags: 64 }); return true; }
    const linked = linkWelcomePassCode({ code: matches[0].welcome_pass_code, guildId: interaction.guildId, userId: memberId });
    if (!linked.ok || !birthdayStore.attachWelcomePassBirthdayProfile(matches[0].welcome_pass_code)) { await interaction.reply({ content: "Harmony could not connect that Welcome Pass record.", flags: 64 }); return true; }
    clearSession(interaction);
    await interaction.reply({ content: `Connected **${matches[0].birthday_name || importedName}** to <@${memberId}>.`, components: birthdayBackRow(), flags: 64 });
    return true;
  }
  if (action === "birthdayoff" && interaction.isButton?.()) {
    await interaction.update({ content: "Turn birthday scheduling off? Member profiles will remain stored.", components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayoffconfirm").setLabel("Confirm Turn Off").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayhome").setLabel("Keep On").setStyle(ButtonStyle.Secondary),
    )] });
    return true;
  }
  if (action === "birthdayoffconfirm" && interaction.isButton?.()) {
    const changed = birthdayStore.disableBirthdaySettings(interaction.guildId);
    await interaction.update({ content: changed ? "Birthday scheduling is off. Member profiles remain safely stored." : "Birthdays were not configured.", components: birthdayBackRow() });
    return true;
  }
  return false;
}

module.exports = { birthdayManagerContent, birthdayManagerComponents, handleBirthdayManagerInteraction };
