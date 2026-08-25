const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require("discord.js");
const store = require("../stores/birthdayStore");
const {
  linkWelcomePassCode,
} = require("../stores/welcomePassStore");
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
  "preview", "upcoming", "match-all", "match-member", "off",
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
  .addSubcommand((sub) => sub
    .setName("match-all")
    .setDescription("Connect imported birthdays to current Discord members"))
  .addSubcommand((sub) => sub
    .setName("match-member")
    .setDescription("Connect one unmatched imported birthday to a member")
    .addStringOption((o) => o
      .setName("imported-name")
      .setDescription("Name shown in the match-all results")
      .setRequired(true)
      .setMaxLength(100))
    .addUserOption((o) => o
      .setName("member")
      .setDescription("Correct Discord member")
      .setRequired(true)))
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

function normalizeMemberName(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLocaleLowerCase();
}

function memberNames(member) {
  const names = [
    member.user.username,
    member.user.globalName,
    member.displayName,
  ];
  if (member.user.discriminator && member.user.discriminator !== "0") {
    names.push(`${member.user.username}#${member.user.discriminator}`);
  }
  return new Set(names.map(normalizeMemberName).filter(Boolean));
}

function formatMatchReport(result) {
  const lines = [
    "🎂 **Birthday matching complete**",
    `Connected: **${result.connected}**`,
    `Still needs attention: **${result.unresolved.length}**`,
  ];
  if (result.unresolved.length) {
    const visible = result.unresolved.slice(0, 20)
      .map((item) => `• ${item.name} — ${item.reason}`);
    lines.push("", "**Not connected:**", ...visible);
    if (result.unresolved.length > visible.length) {
      lines.push(`• …and ${result.unresolved.length - visible.length} more`);
    }
  } else {
    lines.push("", "Every imported birthday is connected. 💜");
  }
  return lines.join("\n");
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
    if (role.managed || role.id === interaction.guild.id) {
      await interaction.editReply("Please choose a regular role created for birthdays, not @everyone or an integration-managed role.");
      return;
    }
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

  if (action === "match-all") {
    const pending = store.listUnlinkedWelcomePassBirthdayProfiles();
    if (!pending.length) {
      await interaction.editReply("Every imported birthday is already connected, or no imported birthdays are waiting.");
      return;
    }

    const fetched = await interaction.guild.members.fetch().catch(() => null);
    if (!fetched) {
      await interaction.editReply("Harmony could not read the server member list. Confirm that **Server Members Intent** is enabled, then try again.");
      return;
    }

    const members = [...fetched.values()].filter((member) => !member.user.bot);
    const result = { connected: 0, unresolved: [] };

    for (const profile of pending) {
      const target = normalizeMemberName(profile.discord_username);
      const label = profile.birthday_name || profile.discord_username || profile.welcome_pass_code;
      if (!target) {
        result.unresolved.push({ name: label, reason: "sync once more to import the Discord username" });
        continue;
      }

      const usernameMatches = members.filter(
        (member) => normalizeMemberName(member.user.username) === target ||
          (member.user.discriminator !== "0" &&
            normalizeMemberName(`${member.user.username}#${member.user.discriminator}`) === target)
      );
      const matches = usernameMatches.length
        ? usernameMatches
        : members.filter((member) => memberNames(member).has(target));

      if (matches.length !== 1) {
        result.unresolved.push({
          name: label,
          reason: matches.length ? "more than one member has that name" : "no matching server member",
        });
        continue;
      }

      const linked = linkWelcomePassCode({
        code: profile.welcome_pass_code,
        guildId: interaction.guildId,
        userId: matches[0].id,
      });
      if (!linked.ok) {
        result.unresolved.push({ name: label, reason: "Welcome Pass link conflict" });
        continue;
      }

      if (store.attachWelcomePassBirthdayProfile(profile.welcome_pass_code)) {
        result.connected += 1;
      } else {
        result.unresolved.push({ name: label, reason: "birthday profile could not be attached" });
      }
    }

    await interaction.editReply(formatMatchReport(result));
    return;
  }

  if (action === "match-member") {
    const importedName = interaction.options.getString("imported-name", true).trim();
    const member = interaction.options.getUser("member", true);
    const target = normalizeMemberName(importedName);
    const pending = store.listUnlinkedWelcomePassBirthdayProfiles();
    const matches = pending.filter((profile) => [
      profile.birthday_name,
      profile.discord_username,
      profile.welcome_pass_code,
    ].some((value) => normalizeMemberName(value) === target));

    if (!matches.length) {
      await interaction.editReply(`No unmatched imported birthday was found for **${importedName}**. Run \`/harmony-birthdays match-all\` to see the current list.`);
      return;
    }
    if (matches.length > 1) {
      await interaction.editReply(`More than one unmatched birthday uses **${importedName}**. Use the member's \`YS-XXXXXXXX\` confirmation code in the imported-name box instead.`);
      return;
    }

    const profile = matches[0];
    const linked = linkWelcomePassCode({
      code: profile.welcome_pass_code,
      guildId: interaction.guildId,
      userId: member.id,
    });
    if (!linked.ok) {
      await interaction.editReply("Harmony could not connect that record because the Welcome Pass or Discord member is already linked to a different account.");
      return;
    }
    if (!store.attachWelcomePassBirthdayProfile(profile.welcome_pass_code)) {
      await interaction.editReply("The Welcome Pass was linked, but Harmony could not attach its birthday profile. Please check the Railway logs before trying again.");
      return;
    }

    await interaction.editReply(`Connected **${importedName}** to <@${member.id}>. Their existing birthday details were preserved.`);
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
