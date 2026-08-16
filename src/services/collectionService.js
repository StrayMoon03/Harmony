const { EmbedBuilder } = require("discord.js");
const {
  getCollectionSettings,
  listScheduledCollectionSettings,
  markWeeklyRecapPosted,
  getLeaderboard,
  getMemberStats,
  getRecap,
  getMemberAllTimeCount,
  claimMilestone,
} = require("../stores/collectionStore");

const PLATFORM_LABELS = {
  instagram: "Instagram 💛",
  facebook: "Facebook 💙",
  tiktok: "TikTok 🩷",
  x: "X 🖤",
  youtube: "YouTube ❤️",
  threads: "Threads 🤍",
};
const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000];

function periodLabel(period) {
  return period === "week"
    ? "the last 7 days"
    : period === "month"
      ? "the last 30 days"
      : "all time";
}

function lines(rows, formatter, empty = "Nothing collected yet.") {
  return rows.length ? rows.map(formatter).join("\n") : empty;
}

function buildLeaderboardEmbed(guildId, period, platform) {
  const rows = getLeaderboard(guildId, period, platform, 10);
  const platformLabel =
    platform && platform !== "all"
      ? PLATFORM_LABELS[platform] || platform
      : "All platforms";

  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("🏆 Harmony Collection Leaders")
    .setDescription(
      "**" + platformLabel + " · " + periodLabel(period) + "**\n\n" +
      lines(rows, (row, index) =>
        (index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "**" + (index + 1) + ".**") +
        " <@" + row.shared_by_id + "> — **" + row.total + "**"
      )
    )
    .setFooter({ text: "Every unique addition helps our collection grow 💜" });
}

function buildMemberStatsEmbed(guildId, user, period) {
  const stats = getMemberStats(guildId, user.id, period);
  const platformText = lines(
    stats.platforms,
    (row) => (PLATFORM_LABELS[row.platform] || row.platform) + ": **" + row.total + "**"
  );

  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("💜 " + (user.globalName || user.username) + "’s Collection Stats")
    .setDescription([
      "**" + periodLabel(period) + "**",
      "",
      "Unique additions: **" + stats.total + "**",
      stats.rank ? "Leaderboard position: **#" + stats.rank + "**" : "Leaderboard position: Not ranked yet",
      "All-time collection total: **" + stats.allTimeTotal + "**",
      "",
      "**By platform**",
      platformText,
    ].join("\n"))
    .setThumbnail(user.displayAvatarURL())
    .setFooter({ text: "Thank you for helping keep our collection growing!" });
}

function buildRecapEmbed(guildId, period) {
  const recap = getRecap(guildId, period);
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("✨ Harmony Collection Recap")
    .setDescription([
      "**Celebrating " + periodLabel(period) + "**",
      "",
      "Our collection grew by **" + recap.total + "** unique post" + (recap.total === 1 ? "" : "s") + ".",
      "**" + recap.contributors + "** member" + (recap.contributors === 1 ? "" : "s") + " contributed.",
      recap.firstTimers ? "**" + recap.firstTimers + "** first-time contributor" + (recap.firstTimers === 1 ? "" : "s") + " joined in!" : null,
    ].filter(Boolean).join("\n"))
    .addFields(
      {
        name: "🏆 Top Contributors",
        value: lines(recap.leaders, (row, index) =>
          "**" + (index + 1) + ".** <@" + row.shared_by_id + "> — " + row.total
        ),
        inline: false,
      },
      {
        name: "🌈 Platform Mix",
        value: lines(recap.platforms, (row) =>
          (PLATFORM_LABELS[row.platform] || row.platform) + " — **" + row.total + "**"
        ),
        inline: true,
      },
      {
        name: "⭐ Most-Collected Creators",
        value: lines(recap.creators, (row) =>
          row.creator + " — **" + row.total + "**"
        ),
        inline: true,
      }
    )
    .setFooter({ text: "Every share adds something special. Thank you! 💜 Harmony" })
    .setTimestamp();
}

async function fetchChannel(client, guildId, channelId) {
  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));
  return channel && channel.isTextBased() ? channel : null;
}

async function handleNewCollectionShare(client, record) {
  if (!record.guild_id || !record.shared_by_id) return;
  const settings = getCollectionSettings(record.guild_id);
  if (!settings || !settings.milestones_enabled) return;

  const total = getMemberAllTimeCount(record.guild_id, record.shared_by_id);
  const milestone = MILESTONES.find((value) => value === total);
  if (!milestone || !claimMilestone(record.guild_id, record.shared_by_id, milestone)) {
    return;
  }

  const channel = await fetchChannel(client, record.guild_id, settings.channel_id);
  if (!channel) return;

  const message =
    milestone === 1
      ? "✨ <@" + record.shared_by_id + "> just added their **first post** to our collection! Welcome to the collection crew! 💜"
      : "🎉 Collection milestone! <@" + record.shared_by_id + "> has added **" + milestone + " unique posts**. Thank you for helping our collection shine! 💜";

  await channel.send({
    content: message,
    allowedMentions: { users: [record.shared_by_id] },
  });
}

function localScheduleParts(timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

async function runScheduledRecaps(client) {
  for (const settings of listScheduledCollectionSettings()) {
    try {
      const parts = localScheduleParts(settings.timezone);
      if (
        WEEKDAYS[parts.weekday] !== settings.weekday ||
        Number(parts.hour) !== settings.hour
      ) continue;

      const key = parts.year + "-" + parts.month + "-" + parts.day;
      if (settings.last_weekly_key === key) continue;

      const channel = await fetchChannel(
        client,
        settings.guild_id,
        settings.channel_id
      );
      if (!channel) continue;

      await channel.send({
        embeds: [buildRecapEmbed(settings.guild_id, "week")],
        allowedMentions: { parse: ["users"] },
      });
      markWeeklyRecapPosted(settings.guild_id, key);
    } catch (error) {
      console.error("Scheduled collection recap failed:", error);
    }
  }
}

function startCollectionScheduler(client) {
  runScheduledRecaps(client);
  return setInterval(() => runScheduledRecaps(client), 5 * 60 * 1000);
}

module.exports = {
  PLATFORM_LABELS,
  buildLeaderboardEmbed,
  buildMemberStatsEmbed,
  buildRecapEmbed,
  handleNewCollectionShare,
  startCollectionScheduler,
};
