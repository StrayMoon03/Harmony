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
  const bias = normalizeBias(profile.bias);
  const message = profile.custom_message || presetFor(profile, year);
  const name = profile.birthday_name || "Birthday STAY";
  const embed = new EmbedBuilder()
    .setColor(0xc084fc)
    .setTitle(`🎂 Happy Birthday, ${name}!`)
    .setDescription([
      preview ? `Preview for <@${profile.user_id}>` : `Today belongs to <@${profile.user_id}>!`,
      "",
      `**A fan-made birthday note inspired by ${bias}:**`,
      message,
      "",
      spotlightFor(bias),
      "",
      "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
    ].join("\n"))
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
      profile.birthday_mmdd === parts.mmdd &&
      Number(profile.last_announced_year || 0) !== parts.year
    );

  for (const profile of profiles) {
    const member = await guild.members.fetch(profile.user_id).catch(() => null);
    if (!member) continue;

    if (settings.role_id && !member.roles.cache.has(settings.role_id)) {
      await member.roles.add(
        settings.role_id,
        "Harmony birthday celebration"
      ).catch((error) => {
        console.error("Could not grant birthday role:", error);
      });
    }

    await channel.send({
      content: `🎉 <@${member.id}>`,
      embeds: [buildBirthdayEmbed(profile, parts.year)],
      allowedMentions: { users: [member.id] },
    });

    store.markBirthdayAnnounced(
      profile.id,
      parts.year,
      new Date(Date.now() + ROLE_DURATION_MS).toISOString()
    );
  }
}

function upcomingProfiles(guildId, limitDays = 7) {
  return store.listBirthdayProfiles(guildId)
    .map((profile) => ({
      ...profile,
      daysAway: daysUntil(profile.birthday_mmdd),
      nextDate: nextOccurrence(profile.birthday_mmdd),
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
    return `🎂 <@${profile.user_id}> — ${formatMmdd(profile.birthday_mmdd)} (${when})`;
  });

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xf472b6)
        .setTitle("✨ Birthdays coming up this week")
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Only members who opted into birthday celebrations are shown." }),
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
  const members = [...new Set(history.map((item) => item.user_id))]
    .map((id) => `<@${id}>`);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xa78bfa)
        .setTitle(`💜 ${monthName} birthday recap`)
        .setDescription([
          "One more round of birthday love for the STAYs we celebrated:",
          "",
          members.join("\n"),
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
    try {
      const guild = await fetchGuild(client, profile.guild_id);
      const member = await guild?.members.fetch(profile.user_id).catch(() => null);
      if (member && profile.role_id && member.roles.cache.has(profile.role_id)) {
        await member.roles.remove(
          profile.role_id,
          "Harmony birthday celebration ended"
        );
      }
    } catch (error) {
      console.error("Could not remove expired birthday role:", error);
    } finally {
      store.clearBirthdayRoleTimer(profile.id);
    }
  }
}

async function processBirthdaySchedule(client) {
  await removeExpiredBirthdayRoles(client);

  for (const settings of store.listBirthdaySettings()) {
    try {
      if (!validTimezone(settings.timezone)) continue;
      const parts = zonedParts(new Date(), settings.timezone);
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
  formatMmdd,
  daysUntil,
  nextOccurrence,
  upcomingProfiles,
  buildBirthdayEmbed,
  startBirthdayScheduler,
};
