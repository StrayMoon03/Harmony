const { EmbedBuilder } = require("discord.js");
const { getErrorInboxSettings } = require("../stores/errorInboxStore");

function firstLink(content) {
  return String(content || "").match(/https?:\/\/[^\s<>]+/i)?.[0] || null;
}

function platformFromLink(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("instagram.com")) return "Instagram";
  if (value.includes("facebook.com") || value.includes("fb.watch")) return "Facebook";
  if (value.includes("tiktok.com")) return "TikTok";
  if (value.includes("threads.com") || value.includes("threads.net")) return "Threads";
  if (value.includes("youtube.com") || value.includes("youtu.be")) return "YouTube";
  if (value.includes("x.com") || value.includes("twitter.com")) return "X";
  return "Media link";
}

function safeReason(error) {
  const text = [
    error?.message,
    error?.stderr,
    typeof error === "string" ? error : "",
  ].filter(Boolean).join(" ");

  if (/no audio|audio stream|silent/i.test(text)) {
    return "The downloaded video did not contain a usable audio track.";
  }
  if (/requested format is not available|no formats found/i.test(text)) {
    return "The platform did not provide a downloadable media format Harmony could use.";
  }
  if (/cookies?|sign in|login|authentication|checkpoint/i.test(text)) {
    return "The platform requires refreshed access or login cookies.";
  }
  if (/compress|too large|size limit|under Discord limit/i.test(text)) {
    return "The media could not be reduced safely to Discord’s upload limit.";
  }
  if (/timeout|timed out|SIGKILL/i.test(text)) {
    return "The platform took too long to return usable media.";
  }
  if (/verify|verified|exact post|expose media|linkOnly|FACEBOOK_UNVERIFIED_MEDIA/i.test(text)) {
    return "Harmony could not verify media belonging to this exact post.";
  }
  if (/unsupported URL|extract|download|retrieve|no media/i.test(text)) {
    return "Harmony could not retrieve usable media from this link.";
  }
  return "Harmony encountered an unexpected media-processing error.";
}

function makeErrorId() {
  const time = Date.now().toString(36).slice(-6).toUpperCase();
  const random = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `HM-${time}-${random}`;
}

async function resolveDestination(client, settings) {
  const guild =
    client.guilds.cache.get(settings.destination_guild_id) ||
    await client.guilds.fetch(settings.destination_guild_id).catch(() => null);
  if (!guild) return null;

  const channel =
    guild.channels.cache.get(settings.destination_channel_id) ||
    await guild.channels.fetch(settings.destination_channel_id).catch(() => null);

  return channel?.isTextBased() ? channel : null;
}

async function logMediaError(message, error) {
  const settings = getErrorInboxSettings();
  if (!settings?.enabled || !message?.client) return false;

  const destination = await resolveDestination(message.client, settings);
  if (!destination) {
    console.warn("Harmony error inbox channel is unavailable.");
    return false;
  }

  const link = firstLink(message.content);
  const errorId = makeErrorId();
  const serverName = message.guild?.name || "Direct message";
  const channelName = message.channel?.name
    ? `#${message.channel.name}`
    : message.channelId || "Unknown channel";
  const memberName =
    message.member?.displayName ||
    message.author?.globalName ||
    message.author?.username ||
    "Unknown member";
  const jumpUrl = message.url ||
    (message.guild?.id && message.channelId && message.id
      ? `https://discord.com/channels/${message.guild.id}/${message.channelId}/${message.id}`
      : null);

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ ${platformFromLink(link)} link failed`)
    .setColor(0xed4245)
    .addFields(
      { name: "Server", value: serverName, inline: true },
      { name: "Channel", value: channelName, inline: true },
      { name: "Posted by", value: memberName, inline: true },
      { name: "Reason", value: safeReason(error) },
      { name: "Original link", value: link || "No link was captured." },
      { name: "Error ID", value: errorId, inline: true }
    )
    .setFooter({ text: "Technical details remain private in Railway logs." })
    .setTimestamp(new Date());

  if (jumpUrl) {
    embed.addFields({ name: "Original Discord message", value: `[Jump to message](${jumpUrl})` });
  }

  await destination.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });

  console.log(`Harmony media error reported as ${errorId}.`);
  return true;
}

async function sendErrorInboxTest(client, interaction) {
  const settings = getErrorInboxSettings();
  if (!settings?.enabled) return false;
  const destination = await resolveDestination(client, settings);
  if (!destination) return false;

  await destination.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("💜 Harmony error inbox is ready")
        .setColor(0x9b59b6)
        .setDescription(
          "Media failures from every server Harmony serves will be reported here privately."
        )
        .addFields(
          { name: "Configured by", value: interaction.user.username, inline: true },
          { name: "Troubleshooting server", value: interaction.guild.name, inline: true }
        )
        .setTimestamp(new Date()),
    ],
    allowedMentions: { parse: [] },
  });
  return true;
}

module.exports = {
  logMediaError,
  sendErrorInboxTest,
};
