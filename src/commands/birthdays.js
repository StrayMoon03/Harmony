const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require("discord.js");
const store = require("../stores/birthdayStore");
const { BIASES, normalizeBias } = require("../services/birthdayPresets");
const {
  validTimezone,
  validMmdd,
  formatMmdd,
  upcomingProfiles,
  buildBirthdayEmbed,
} = require("../services/birthdayService");

const biasChoices = BIASES.map((name) => ({ name, value: name }));
const weekdayChoices = [
  ["Sunday", 0], ["Monday", 1], ["Tuesday", 2], ["Wednesday", 3],
  ["Thursday", 4], ["Friday", 5], ["Saturday", 6],
].map(([name, value]) => ({ name, value }));
const adminActions = new Set([
  "setup", "status", "set-member", "customize", "clear-custom",
  "preview", "upcoming", "off",
]);

const data = new SlashCommandBuilder()
  .setName("harmony-birthdays")
  .setDescription("Celebrate opted-in member birthdays")
  .addSubcommand((sub) => sub
    .setName("setup")
    .setDescription("Turn birthday celebrations on")
    .addChannelOption((o) => o.setName("channel").setDescription("Announcement channel").setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Temporary 24-hour birthday role").setRequired(true))
    .addStringOption((o) => o.setName("timezone").setDescription("IANA timezone, such as America/New_York").setRequired(true))
    .addIntegerOption((o) => o.setName("hour").setDescription("Announcement hour, 0–23").setMinValue(0).setMaxValue(23))
    .addIntegerOption((o) => o.setName("weekly-day").setDescription("Day for the upcoming-birthday reminder").addChoices(...weekdayChoices))
    .addBooleanOption((o) => o.setName("weekly").setDescription("Post weekly upcoming reminders"))
    .addBooleanOption((o) => o.setName("monthly-recap").setDescription("Post a recap on the first of each month")))
  .addSubcommand((sub) => sub.setName("status").setDescription("Show birthday setup"))
  .addSubcommand((sub) => sub
    .setName("set-member")
    .setDescription("Add or update a member birthday")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("birthday").setDescription("Month and day as MM-DD").setRequired(true))
    .addStringOption((o) => o.setName("bias").setDescription("Birthday-message bias").setRequired(true).addChoices(...biasChoices))
    .addStringOption((o) => o.setName("name").setDescription("Name used in the announcement").setMaxLength(80)))
  .addSubcommand((sub) => sub
    .setName("customize")
    .setDescription("Customize one member's fan-made birthday note")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("bias").setDescription("Birthday-message bias").addChoices(...biasChoices))
    .addStringOption((o) => o.setName("message").setDescription("Custom fan-made message").setMaxLength(1000))
    .addStringOption((o) => o.setName("image-url").setDescription("Optional HTTPS celebration image").setMaxLength(500)))
  .addSubcommand((sub) => sub
    .setName("clear-custom")
    .setDescription("Return a member to Harmony's rotating preset messages")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)))
  .addSubcommand((sub) => sub
    .setName("preview")
    .setDescription("Preview a member's birthday announcement")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)))
  .addSubcommand((sub) => sub.setName("upcoming").setDescription("Privately list the next 30 days"))
  .addSubcommand((sub) => sub.setName("next").setDescription("Show the next opted-in birthdays"))
  .addSubcommand((sub) => sub
    .setName("month")
    .setDescription("Show opted-in birthdays for a month")
    .addIntegerOption((o) => o.setName("month").setDescription("Month number").setMinValue(1).setMaxValue(12)))
  .addSubcommand((sub) => sub.setName("off").setDescription("Turn scheduled birthday posts off"));

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function listEmbed(title, profiles) {
  const description = profiles.length
    ? profiles.map((p) => `🎂 <@${p.user_id}> — ${formatMmdd(p.birthday_mmdd)}${p.bias ? ` • ${p.bias}` : ""}`).join("\n")
    : "No opted-in birthdays were found for that time.";
  return new EmbedBuilder()
    .setColor(0xc084fc)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "Harmony stores no birth year or age." });
}

async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  const privateReply = adminActions.has(action);
  await interaction.deferReply(privateReply ? { flags: 64 } : {});

  if (privateReply && !isAdmin(interaction)) {
    await interaction.editReply("Only server administrators can use that birthday setting.");
    return;
  }

  if (action === "setup") {
    const channel = interaction.options.getChannel("channel", true);
    const role = interaction.options.getRole("role", true);
    const timezone = interaction.options.getString("timezone", true).trim();
    if (!channel.isTextBased()) {
      await interaction.editReply("Please choose a text channel.");
      return;
    }
    if (!validTimezone(timezone)) {
      await interaction.editReply("That timezone is not valid. Try `America/New_York`, `America/Chicago`, `America/Denver`, or `America/Los_Angeles`.");
      return;
    }
    const me = interaction.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
      await interaction.editReply("Harmony needs **Manage Roles**, and the birthday role must be below Harmony's highest role.");
      return;
    }
    store.saveBirthdaySettings({
      guildId: interaction.guildId,
      channelId: channel.id,
      roleId: role.id,
      timezone,
      announcementHour: interaction.options.getInteger("hour") ?? 9,
      weeklyDay: interaction.options.getInteger("weekly-day") ?? 0,
      weeklyEnabled: interaction.options.getBoolean("weekly") ?? true,
      monthlyRecapEnabled: interaction.options.getBoolean("monthly-recap") ?? true,
    });
    await interaction.editReply([
      "🎂 **Harmony Birthdays is ready!**",
      `Announcements: <#${channel.id}>`,
      `24-hour role: <@&${role.id}>`,
      `Timezone: ${timezone}`,
      "Welcome Pass opt-ins will connect automatically after approval.",
    ].join("\n"));
    return;
  }

  if (action === "status") {
    const settings = store.getBirthdaySettings(interaction.guildId);
    if (!settings) {
      await interaction.editReply("Birthdays are not set up yet. Use `/harmony-birthdays setup`.");
      return;
    }
    await interaction.editReply([
      `Status: **${settings.enabled ? "On" : "Off"}**`,
      `Channel: <#${settings.channel_id}>`,
      `Role: ${settings.role_id ? `<@&${settings.role_id}>` : "None"}`,
      `Time: ${settings.announcement_hour}:00 in ${settings.timezone}`,
      `Weekly reminder: ${settings.weekly_enabled ? "On" : "Off"}`,
      `Monthly recap: ${settings.monthly_recap_enabled ? "On" : "Off"}`,
    ].join("\n"));
    return;
  }

  if (action === "set-member") {
    const member = interaction.options.getUser("member", true);
    const birthday = interaction.options.getString("birthday", true).trim();
    if (!validMmdd(birthday)) {
      await interaction.editReply("Use a real month and day in **MM-DD** format, such as `03-25`.");
      return;
    }
    store.upsertBirthdayProfile({
      guildId: interaction.guildId,
      userId: member.id,
      birthdayMmdd: birthday,
      birthdayName: interaction.options.getString("name")?.trim() || member.globalName || member.username,
      bias: normalizeBias(interaction.options.getString("bias", true)),
    });
    await interaction.editReply(`Saved <@${member.id}>'s birthday as **${formatMmdd(birthday)}**. No year or age was stored.`);
    return;
  }

  if (action === "customize") {
    const member = interaction.options.getUser("member", true);
    const bias = interaction.options.getString("bias");
    const message = interaction.options.getString("message")?.trim();
    const imageUrl = interaction.options.getString("image-url")?.trim();
    if (!bias && !message && !imageUrl) {
      await interaction.editReply("Choose a bias, message, or image to customize.");
      return;
    }
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
      await interaction.editReply("The image must use an **https://** URL.");
      return;
    }
    const updated = store.setBirthdayCustomization(interaction.guildId, member.id, {
      bias: bias ? normalizeBias(bias) : null,
      customMessage: message,
      customImageUrl: imageUrl,
    });
    await interaction.editReply(updated
      ? `Saved <@${member.id}>'s birthday customization. It will be labeled fan-made and bias-inspired.`
      : "That member has no birthday profile yet. Use `/harmony-birthdays set-member` first.");
    return;
  }

  if (action === "clear-custom") {
    const member = interaction.options.getUser("member", true);
    const updated = store.clearBirthdayCustomization(interaction.guildId, member.id);
    await interaction.editReply(updated
      ? `<@${member.id}> will use Harmony's rotating preset birthday messages again.`
      : "That member has no birthday profile.");
    return;
  }

  if (action === "preview") {
    const member = interaction.options.getUser("member", true);
    const profile = store.getBirthdayProfile(interaction.guildId, member.id);
    if (!profile?.celebration_enabled || !profile.birthday_mmdd) {
      await interaction.editReply("That member has no opted-in birthday profile.");
      return;
    }
    await interaction.editReply({ embeds: [buildBirthdayEmbed(profile, new Date().getUTCFullYear(), true)] });
    return;
  }

  if (action === "upcoming") {
    const profiles = upcomingProfiles(interaction.guildId, 30);
    await interaction.editReply({ embeds: [listEmbed("📅 Birthdays in the next 30 days", profiles)] });
    return;
  }

  if (action === "next") {
    const profiles = upcomingProfiles(interaction.guildId, 366);
    const nearest = profiles.length ? profiles[0].daysAway : null;
    const next = nearest === null ? [] : profiles.filter((p) => p.daysAway === nearest);
    await interaction.editReply({ embeds: [listEmbed("✨ Next Youtiful STAY birthdays", next)] });
    return;
  }

  if (action === "month") {
    const month = interaction.options.getInteger("month") ?? new Date().getMonth() + 1;
    const profiles = store.listBirthdayProfiles(interaction.guildId)
      .filter((p) => Number(p.birthday_mmdd.slice(0, 2)) === month);
    const monthName = new Date(2024, month - 1, 1).toLocaleDateString("en-US", { month: "long" });
    await interaction.editReply({ embeds: [listEmbed(`🎂 ${monthName} birthdays`, profiles)] });
    return;
  }

  if (action === "off") {
    const changed = store.disableBirthdaySettings(interaction.guildId);
    await interaction.editReply(changed
      ? "Birthday scheduling is off. Member profiles remain safely stored."
      : "Birthdays were not configured.");
  }
}

module.exports = { data, execute };
