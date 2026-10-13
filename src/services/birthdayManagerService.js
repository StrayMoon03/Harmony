const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
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

function extractId(value) {
  const match = String(value || "").match(/\d{5,}/);
  return match ? match[0] : null;
}

function isBirthdayAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has?.("ManageGuild") ||
    interaction.memberPermissions?.has?.("Administrator")
  );
}

function settingsLines(settings) {
  if (!settings) return ["Status: **Off / not configured**", "Use **Settings** to connect the existing birthday scheduler."];
  return [
    `Status: **${settings.enabled ? "On" : "Off"}**`,
    `Announcement channel: ${settings.channel_id ? `<#${settings.channel_id}>` : "Not set"}`,
    `Birthday role: ${settings.role_id ? `<@&${settings.role_id}>` : "Not set"}`,
    `Timezone: **${settings.timezone || "Not set"}**`,
    `Announcement hour: **${settings.announcement_hour}:00**`,
    `Weekly reminder: **${settings.weekly_enabled ? "On" : "Off"}**`,
    `Monthly recap: **${settings.monthly_recap_enabled ? "On" : "Off"}**`,
  ];
}

function birthdayManagerContent(guildId) {
  const settings = birthdayStore.getBirthdaySettings(guildId);
  const profiles = birthdayStore.listBirthdayProfiles(guildId);
  return [
    "🎂 **BIRTHDAY MANAGER**",
    "",
    ...settingsLines(settings),
    `Opted-in profiles: **${profiles.length}**`,
    "",
    "This panel uses the existing Welcome Pass birthday profiles, scheduler, presets, and role behavior.",
  ].join("\n");
}

function birthdayManagerComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaystatus").setLabel("Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayupcoming").setLabel("Upcoming").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayadd").setLabel("Add / Update").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaycustomize").setLabel("Customize").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayclear").setLabel("Clear Custom").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaypreview").setLabel("Preview").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaymatchall").setLabel("Match All Imports").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaymatchmember").setLabel("Match One").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaysettings").setLabel("Settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdayweekly").setLabel("Toggle Weekly").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-manager:community:birthdaymonthly").setLabel("Toggle Monthly").setStyle(ButtonStyle.Secondary),
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

function profileIdModal(action, title) {
  return textModal(`harmony-manager:community:${action}modal`, title, [
    { id: "member", label: "Member ID or @mention", required: true, maxLength: 40 },
  ]);
}

function profileEditModal(action, profile = null) {
  return textModal(`harmony-manager:community:${action}modal`, action === "birthdayadd" ? "Add or update birthday" : "Customize birthday", action === "birthdayadd" ? [
    { id: "member", label: "Member ID or @mention", required: true, maxLength: 40, value: profile?.user_id },
    { id: "birthday", label: "Birthday MM-DD", required: true, maxLength: 5, value: profile?.birthday_mmdd },
    { id: "bias", label: "Bias", required: true, maxLength: 80, value: profile?.bias || BIASES[0] },
    { id: "name", label: "Announcement name (optional)", maxLength: 80, value: profile?.birthday_name },
  ] : [
    { id: "member", label: "Member ID or @mention", required: true, maxLength: 40, value: profile?.user_id },
    { id: "bias", label: "Bias (optional)", maxLength: 80, value: profile?.bias },
    { id: "message", label: "Custom fan-made message (optional)", paragraph: true, maxLength: 1000, value: profile?.custom_message },
    { id: "image-url", label: "HTTPS image URL (optional)", maxLength: 500, value: profile?.custom_image_url },
  ]);
}

function renderUpcoming(guildId) {
  const profiles = upcomingProfiles(guildId, 30);
  const description = profiles.length
    ? profiles.map((p) => `🎂 <@${p.user_id}> — ${formatMmdd(p.birthday_mmdd)}${p.daysAway === 0 ? " (today)" : ` (in ${p.daysAway} days)`}`).join("\n")
    : "No opted-in birthdays are coming up in the next 30 days.";
  return new EmbedBuilder().setColor(0xc084fc).setTitle("📅 Upcoming birthdays").setDescription(description).setFooter({ text: "Welcome Pass opt-ins are the source of truth." });
}

async function saveSettings(interaction) {
  const existing = birthdayStore.getBirthdaySettings(interaction.guildId) || {};
  const channelId = extractId(interaction.fields.getTextInputValue("channel"));
  const roleId = extractId(interaction.fields.getTextInputValue("role"));
  const timezone = interaction.fields.getTextInputValue("timezone").trim();
  const hour = Number(interaction.fields.getTextInputValue("hour").trim());
  const weeklyDay = Number(interaction.fields.getTextInputValue("weekly-day").trim());
  const weekly = existing.weekly_enabled !== 0;
  const monthly = existing.monthly_recap_enabled !== 0;
  const channel = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
  const role = roleId ? await interaction.guild.roles.fetch(roleId).catch(() => null) : null;
  if (!channel?.isTextBased?.() || !role || !validTimezone(timezone) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(weeklyDay) || weeklyDay < 0 || weeklyDay > 6) {
    throw new Error("Choose a valid text channel, role, IANA timezone, hour 0–23, and weekly day 0–6.");
  }
  const me = interaction.guild.members.me;
  if (role.managed || role.id === interaction.guild.id || !me?.permissions?.has?.("ManageRoles") || role.position >= me.roles.highest.position) {
    throw new Error("Choose a regular birthday role below Harmony's highest role.");
  }
  birthdayStore.saveBirthdaySettings({ guildId: interaction.guildId, channelId, roleId, timezone, announcementHour: hour, weeklyDay, weeklyEnabled: weekly, monthlyRecapEnabled: monthly });
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
  if (["birthdayadd", "birthdaycustomize", "birthdayclear", "birthdaypreview"].includes(action) && interaction.isButton?.()) {
    await interaction.showModal(action === "birthdayadd" || action === "birthdaycustomize" ? profileEditModal(action) : profileIdModal(action, action === "birthdaypreview" ? "Preview birthday" : "Clear customization"));
    return true;
  }
  if (action === "birthdayaddmodal" && interaction.isModalSubmit?.()) {
    const memberId = extractId(interaction.fields.getTextInputValue("member"));
    const birthday = interaction.fields.getTextInputValue("birthday").trim();
    if (!memberId || !validMmdd(birthday)) { await interaction.reply({ content: "Use a valid member ID and MM-DD birthday.", flags: 64 }); return true; }
    const bias = normalizeBias(interaction.fields.getTextInputValue("bias"));
    birthdayStore.upsertBirthdayProfile({ guildId: interaction.guildId, userId: memberId, birthdayMmdd: birthday, birthdayName: interaction.fields.getTextInputValue("name").trim() || memberId, bias });
    await interaction.reply({ content: `Saved <@${memberId}>'s birthday as **${formatMmdd(birthday)}**.`, components: birthdayBackRow(), flags: 64 });
    return true;
  }
  if (action === "birthdaycustomizemodal" && interaction.isModalSubmit?.()) {
    const memberId = extractId(interaction.fields.getTextInputValue("member"));
    const imageUrl = interaction.fields.getTextInputValue("image-url").trim();
    const bias = interaction.fields.getTextInputValue("bias").trim();
    const message = interaction.fields.getTextInputValue("message").trim();
    if (!memberId || (!bias && !message && !imageUrl) || (imageUrl && !/^https:\/\//i.test(imageUrl))) { await interaction.reply({ content: "Choose a member and a bias, message, or HTTPS image URL.", flags: 64 }); return true; }
    const updated = birthdayStore.setBirthdayCustomization(interaction.guildId, memberId, { bias: bias ? normalizeBias(bias) : null, customMessage: message, customImageUrl: imageUrl });
    await interaction.reply({ content: updated ? `Saved <@${memberId}>'s birthday customization.` : "That member has no birthday profile yet.", components: birthdayBackRow(), flags: 64 });
    return true;
  }
  if (["birthdayclearmodal", "birthdaypreviewmodal"].includes(action) && interaction.isModalSubmit?.()) {
    const memberId = extractId(interaction.fields.getTextInputValue("member"));
    const profile = memberId ? birthdayStore.getBirthdayProfile(interaction.guildId, memberId) : null;
    if (!profile) { await interaction.reply({ content: "That member has no birthday profile.", flags: 64 }); return true; }
    if (action === "birthdayclearmodal") {
      birthdayStore.clearBirthdayCustomization(interaction.guildId, memberId);
      await interaction.reply({ content: `<@${memberId}> will use Harmony's rotating preset messages again.`, components: birthdayBackRow(), flags: 64 });
    } else {
      await interaction.reply({ content: `Preview for <@${memberId}>:`, embeds: [buildBirthdayEmbed(profile, new Date().getUTCFullYear(), true)], components: birthdayBackRow(), flags: 64 });
    }
    return true;
  }
  if (action === "birthdaysettings" && interaction.isButton?.()) {
    const settings = birthdayStore.getBirthdaySettings(interaction.guildId) || {};
    await interaction.showModal(textModal("harmony-manager:community:birthdaysettingsmodal", "Birthday settings", [
      { id: "channel", label: "Announcement channel ID", required: true, maxLength: 40, value: settings.channel_id },
      { id: "role", label: "Birthday role ID", required: true, maxLength: 40, value: settings.role_id },
      { id: "timezone", label: "IANA timezone", required: true, maxLength: 80, value: settings.timezone || "America/New_York" },
      { id: "hour", label: "Announcement hour 0-23", required: true, maxLength: 2, value: String(settings.announcement_hour ?? 9) },
      { id: "weekly-day", label: "Weekly day 0-6 (Sun=0)", required: true, maxLength: 1, value: String(settings.weekly_day ?? 0) },
    ]));
    return true;
  }
  if (action === "birthdaysettingsmodal" && interaction.isModalSubmit?.()) {
    try { await saveSettings(interaction); await interaction.reply({ content: "Birthday settings saved. Existing scheduler behavior is unchanged.", components: birthdayBackRow(), flags: 64 }); }
    catch (error) { await interaction.reply({ content: error.message, flags: 64 }); }
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
    await interaction.showModal(textModal("harmony-manager:community:birthdaymatchmembermodal", "Match imported birthday", [
      { id: "imported-name", label: "Imported name or YS code", required: true, maxLength: 100 },
      { id: "member", label: "Member ID or @mention", required: true, maxLength: 40 },
    ]));
    return true;
  }
  if (action === "birthdaymatchmembermodal" && interaction.isModalSubmit?.()) {
    const importedName = normalizeName(interaction.fields.getTextInputValue("imported-name"));
    const memberId = extractId(interaction.fields.getTextInputValue("member"));
    const matches = birthdayStore.listUnlinkedWelcomePassBirthdayProfiles().filter((profile) => [profile.birthday_name, profile.discord_username, profile.welcome_pass_code].some((value) => normalizeName(value) === importedName));
    if (matches.length !== 1 || !memberId) { await interaction.reply({ content: matches.length > 1 ? "More than one imported birthday matches. Use the exact YS code." : "No unique imported birthday matched that name.", flags: 64 }); return true; }
    const linked = linkWelcomePassCode({ code: matches[0].welcome_pass_code, guildId: interaction.guildId, userId: memberId });
    if (!linked.ok || !birthdayStore.attachWelcomePassBirthdayProfile(matches[0].welcome_pass_code)) { await interaction.reply({ content: "Harmony could not connect that Welcome Pass record.", flags: 64 }); return true; }
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
