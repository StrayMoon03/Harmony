const { EmbedBuilder } = require("discord.js");
const store = require("../stores/birthdayStore");
const {
  normalizeBias,
  presetFor,
  spotlightFor,
} = require("./birthdayPresets");

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ROLE_DURATION_MS = 24 * 60 * 60 * 1000;

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    weekday: weekdays[values.weekday],
    dateKey: `${values.year}-${values.month}-${values.day}`,
    mmdd: `${values.month}-${values.day}`,
  };
}

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function validMmdd(value) {
  const match = String(value || "").match(/^(\d{2})-(\d{2})$/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const date = new Date(2024, month - 1, day);
  return date.getMonth() === month - 1 && date.getDate() === day;
}

function formatMmdd(mmdd) {
  if (!validMmdd(mmdd)) return "Unknown date";
  const [month, day] = mmdd.split("-").map(Number);
  return new Date(2024, month - 1, day).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

function nextOccurrence(mmdd, now = new Date()) {
  if (!validMmdd(mmdd)) return null;
  const [month, day] = mmdd.split("-").map(Number);
  let year = now.getUTCFullYear();
  let date = new Date(Date.UTC(year, month - 1, day));
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  if (date < today) {
    year += 1;
    date = new Date(Date.UTC(year, month - 1, day));
  }
  return date;
}

function daysUntil(mmdd, now = new Date()) {
  const next = nextOccurrence(mmdd, now);
  if (!next) return Number.POSITIVE_INFINITY;
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  return Math.round((next - today) / (24 * 60 * 60 * 1000));
}

function buildBirthdayEmbed(profile, year, preview = false) {
  // A non-member profile is an event/person record, not a Discord member's
  // bias selection. Keep its generated copy neutral even if an old row has a
  // member-specific bias value.
  const bias = profile.user_id ? normalizeBias(profile.bias) : "Still deciding";
  const message = profile.custom_message || presetFor({ ...profile, bias }, year);
  const name = profile.birthday_name || "Birthday STAY";
  const person = profile.user_id ? `<@${profile.user_id}>` : name;
  const description = !profile.user_id && profile.custom_message?.trim()
    ? profile.custom_message.trim()
    : [
      preview ? `Preview for ${person}` : `Today belongs to ${person}!`,
      "",
      `**A fan-made birthday note inspired by ${bias}:**`,
      message,
      "",
      spotlightFor(bias),
      "",
      "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
    ].join("\n");
  const embed = new EmbedBuilder()
    .setColor(0xc084fc)
    .setTitle(`🎂 Happy Birthday, ${name}!`)
    .setDescription(description)
    .setFooter({ text: `Birthday: ${formatMmdd(profile.birthday_mmdd)} • No age or birth year stored` })
    .setTimestamp(new Date());

  if (profile.custom_image_url && /^https?:\/\//i.test(profile.custom_image_url)) {
    embed.setImage(profile.custom_image_url);
  }
  return embed;
}

async function fetchGuild(client, guildId) {
  return client.guilds.cache.get(guildId) ||
    await client.guilds.fetch(guildId).catch(() => null);
}

async function fetchTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const channel = guild.channels.cache.get(channelId) ||
    await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function announceBirthdays(client, settings, parts) {
  const guild = await fetchGuild(client, settings.guild_id);
  if (!guild) return;
  const channel = await fetchTextChannel(guild, settings.channel_id);
  if (!channel) throw new Error("Birthday announcement channel is unavailable.");

  const profiles = store.listBirthdayProfiles(guild.id)
    .filter((profile) =>
      Boolean(profile.user_id) &&
      profile.birthday_mmdd === parts.mmdd &&
      Number(profile.last_announced_year || 0) !== parts.year
    );

  for (const profile of profiles) {
    const member = await guild.members.fetch(profile.user_id).catch(() => null);
    if (!member) continue;

    let roleAdded = false;
    if (settings.role_id && !member.roles.cache.has(settings.role_id)) {
      try {
        await member.roles.add(
          settings.role_id,
          "Harmony birthday celebration"
        );
        roleAdded = true;
      } catch (error) {
        console.error("Could not grant birthday role:", error);
      }
    }

    try {
      await channel.send({
        content: `🎉 @everyone, help us wish <@${member.id}> a very Happy Birthday!`,
        embeds: [buildBirthdayEmbed(profile, parts.year)],
        allowedMentions: {
          parse: ["everyone"],
          users: [member.id],
        },
      });
    } catch (error) {
      if (roleAdded) {
        await member.roles.remove(
          settings.role_id,
          "Birthday announcement could not be delivered"
        ).catch(() => {});
      }
      throw error;
    }

    store.markBirthdayAnnounced(
      profile.id,
      parts.year,
      new Date(Date.now() + ROLE_DURATION_MS).toISOString()
    );
  }
}

async function announceNonDiscordBirthdays(client, settings, now = new Date()) {
  const due = store.listNonDiscordBirthdayProfiles(settings.guild_id)
    .filter((profile) => isNonDiscordBirthdayDue(profile, now, settings.announcement_hour));
  if (!due.length) return;
  const guild = await fetchGuild(client, settings.guild_id);
  if (!guild) return;
  const channel = await fetchTextChannel(guild, settings.channel_id);
  if (!channel) throw new Error("Birthday announcement channel is unavailable.");
  for (const profile of due) {
    const local = zonedParts(now, profile.timezone);
    await channel.send({
      content: `🎉 @everyone, help us celebrate **${profile.birthday_name}** today!`,
      embeds: [buildBirthdayEmbed(profile, local.year)],
      allowedMentions: { parse: ["everyone"] },
    });
    store.markBirthdayAnnounced(profile.id, local.year, null);
  }
}

function isNonDiscordBirthdayDue(profile, now = new Date(), announcementHour = null) {
  if (!validTimezone(profile.timezone)) return false;
  const local = zonedParts(now, profile.timezone);
  return profile.birthday_mmdd === local.mmdd &&
    Number(profile.last_announced_year || 0) !== local.year &&
    (announcementHour === null || local.hour >= Number(announcementHour));
}

function daysUntilInTimezone(mmdd, timezone, now = new Date()) {
  if (!validMmdd(mmdd) || !validTimezone(timezone)) return Number.POSITIVE_INFINITY;
  const local = zonedParts(now, timezone);
  const [month, day] = mmdd.split("-").map(Number);
  let year = local.year;
  let target = new Date(Date.UTC(year, month - 1, day));
  const today = Date.UTC(local.year, local.month - 1, local.day);
  if (target.getTime() < today ||
      (month === 2 && day === 29 && target.getUTCMonth() !== 1)) {
    do {
      year += 1;
      target = new Date(Date.UTC(year, month - 1, day));
    } while (month === 2 && day === 29 && target.getUTCMonth() !== 1);
  }
  return Math.round((target.getTime() - today) / (24 * 60 * 60 * 1000));
}

function upcomingProfiles(guildId, limitDays = 7) {
  return store.listBirthdayProfiles(guildId)
    .map((profile) => ({
      ...profile,
      daysAway: profile.user_id
        ? daysUntil(profile.birthday_mmdd)
        : daysUntilInTimezone(profile.birthday_mmdd, profile.timezone),
    }))
    .filter((profile) => profile.daysAway >= 0 && profile.daysAway <= limitDays)
    .sort((a, b) => a.daysAway - b.daysAway);
}

async function postWeeklyReminder(client, settings) {
  const profiles = upcomingProfiles(settings.guild_id, 7);
  if (!profiles.length) return;
  const guild = await fetchGuild(client, settings.guild_id);
  const channel = await fetchTextChannel(guild, settings.channel_id);
  if (!channel) return;

  const lines = profiles.map((profile) => {
    const when = profile.daysAway === 0
      ? "today"
      : profile.daysAway === 1
        ? "tomorrow"
        : `in ${profile.daysAway} days`;
    return `🎂 ${profile.user_id ? `<@${profile.user_id}>` : `**${profile.birthday_name}**`} — ${formatMmdd(profile.birthday_mmdd)} (${when})`;
  });

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xf472b6)
        .setTitle("✨ Birthdays coming up this week")
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Includes opted-in members and configured non-member birthdays." }),
    ],
    allowedMentions: { parse: [] },
  });
}

async function postMonthlyRecap(client, settings, parts) {
  const guild = await fetchGuild(client, settings.guild_id);
  const channel = await fetchTextChannel(guild, settings.channel_id);
  if (!channel) return;

  const currentStart = new Date(Date.UTC(parts.year, parts.month - 1, 1));
  const previousStart = new Date(Date.UTC(parts.year, parts.month - 2, 1));
  const history = store.listBirthdayHistory(
    settings.guild_id,
    previousStart.toISOString(),
    currentStart.toISOString()
  );
  if (!history.length) return;

  const monthName = previousStart.toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const celebrants = [...new Map(history.map((item) => [
    item.user_id ? `user:${item.user_id}` : `name:${item.birthday_name || item.birthday_mmdd}`,
    item.user_id ? `<@${item.user_id}>` : item.birthday_name || "Birthday celebration",
  ])).values()];

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xa78bfa)
        .setTitle(`💜 ${monthName} birthday recap`)
        .setDescription([
          "One more round of birthday love for the STAYs we celebrated:",
          "",
          celebrants.join("\n"),
          "",
          "Thank you for making their days feel special!",
        ].join("\n")),
    ],
    allowedMentions: { parse: [] },
  });
}

async function removeExpiredBirthdayRoles(client) {
  const expired = store.listExpiredBirthdayRoles(new Date().toISOString());
  for (const profile of expired) {
    const guild = await fetchGuild(client, profile.guild_id);
    if (!guild) continue;

    const member = await guild.members.fetch(profile.user_id).catch(() => null);
    if (!member) {
      // The member left the server, so there is no role left to remove.
      store.clearBirthdayRoleTimer(profile.id);
      continue;
    }

    try {
      if (profile.role_id && member.roles.cache.has(profile.role_id)) {
        await member.roles.remove(
          profile.role_id,
          "Harmony birthday celebration ended"
        );
      }
      store.clearBirthdayRoleTimer(profile.id);
    } catch (error) {
      // Keep the timer so Harmony retries after a temporary Discord or
      // permissions failure instead of leaving the role behind forever.
      console.error("Could not remove expired birthday role:", error);
    }
  }
}

async function processBirthdaySchedule(client) {
  await removeExpiredBirthdayRoles(client);

  for (const settings of store.listBirthdaySettings()) {
    try {
      if (!validTimezone(settings.timezone)) continue;
      const parts = zonedParts(new Date(), settings.timezone);
      await announceNonDiscordBirthdays(client, settings);
      if (parts.hour !== Number(settings.announcement_hour)) continue;

      if (settings.last_daily_key !== parts.dateKey) {
        await announceBirthdays(client, settings, parts);
        store.updateBirthdayRunKey(
          settings.guild_id,
          "last_daily_key",
          parts.dateKey
        );
      }

      const weeklyKey = `${parts.year}-W-${parts.dateKey}`;
      if (
        settings.weekly_enabled &&
        parts.weekday === Number(settings.weekly_day) &&
        settings.last_weekly_key !== weeklyKey
      ) {
        await postWeeklyReminder(client, settings);
        store.updateBirthdayRunKey(
          settings.guild_id,
          "last_weekly_key",
          weeklyKey
        );
      }

      const monthlyKey = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
      if (
        settings.monthly_recap_enabled &&
        parts.day === 1 &&
        settings.last_monthly_key !== monthlyKey
      ) {
        await postMonthlyRecap(client, settings, parts);
        store.updateBirthdayRunKey(
          settings.guild_id,
          "last_monthly_key",
          monthlyKey
        );
      }
    } catch (error) {
      console.error(
        `Birthday scheduler failed for guild ${settings.guild_id}:`,
        error
      );
    }
  }
}

function startBirthdayScheduler(client) {
  processBirthdaySchedule(client).catch((error) =>
    console.error("Birthday scheduler startup failed:", error)
  );
  const timer = setInterval(
    () => processBirthdaySchedule(client).catch((error) =>
      console.error("Birthday scheduler failed:", error)
    ),
    CHECK_INTERVAL_MS
  );
  timer.unref?.();
}

module.exports = {
  validTimezone,
  validMmdd,
  zonedParts,
  isNonDiscordBirthdayDue,
  daysUntilInTimezone,
  formatMmdd,
  daysUntil,
  nextOccurrence,
  upcomingProfiles,
  buildBirthdayEmbed,
  announceNonDiscordBirthdays,
  startBirthdayScheduler,
};
