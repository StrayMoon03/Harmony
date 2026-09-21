const { PermissionFlagsBits } = require("discord.js");
const store = require("../stores/eventSchedulerStore");

const CHECK_INTERVAL_MS = 30 * 1000;
const MAX_ANNOUNCEMENTS = 12;
const HEADER = /^harmony\s+event\b/i;

function isAdmin(message) {
  return Boolean(
    message.member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    message.member?.permissions?.has(PermissionFlagsBits.Administrator)
  );
}

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function localToUtc(dateText, timeText, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(timeText);
  if (!match || !clock) return null;
  const target = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(clock[1]), minute: Number(clock[2]),
  };
  if (target.hour > 23 || target.minute > 59) return null;
  let value = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(value))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    );
    if (parts.hour === 24) parts.hour = 0;
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const wanted = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
    value += wanted - shown;
  }
  return new Date(value);
}

function field(lines, name) {
  const line = lines.find((item) => item.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line ? line.slice(line.indexOf(":") + 1).trim() : "";
}

function parseEvent(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = field(lines, "title");
  const link = field(lines, "link");
  const destination = field(lines, "post in");
  const timezone = field(lines, "timezone") || "America/New_York";
  const channelMatch = /<#(\d+)>/.exec(destination);
  const marker = lines.findIndex((line) => /^announcements\s*:/i.test(line));
  if (!title || title.length > 120) throw new Error("Add a Title (120 characters or fewer).");
  if (!/^https?:\/\/\S+$/i.test(link)) throw new Error("Add one complete http or https Link.");
  if (!channelMatch) throw new Error("Use a Discord channel mention after Post in.");
  if (!validTimezone(timezone)) throw new Error("That Timezone is not valid.");
  if (marker < 0) throw new Error("Add an Announcements: section.");

  const announcements = [];
  for (const line of lines.slice(marker + 1)) {
    const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*\|\s*(.+)$/.exec(line);
    if (!match) throw new Error("Each announcement must be: YYYY-MM-DD HH:MM | your message");
    const when = localToUtc(match[1], match[2], timezone);
    if (!when || Number.isNaN(when.getTime())) throw new Error("One announcement has an invalid date or time.");
    if (when.getTime() <= Date.now()) throw new Error("Every announcement time must be in the future.");
    if (match[3].length > 1800) throw new Error("Each message must be 1,800 characters or fewer.");
    announcements.push({ scheduledFor: when.toISOString(), message: match[3] });
  }
  if (!announcements.length || announcements.length > MAX_ANNOUNCEMENTS) {
    throw new Error(`Add between 1 and ${MAX_ANNOUNCEMENTS} announcements.`);
  }
  return { title, link, destinationChannelId: channelMatch[1], timezone, announcements };
}

async function handleEventSchedulerMessage(message) {
  if (!message.guild || message.author.bot || !HEADER.test(message.content || "")) return false;
  if (!isAdmin(message)) {
    await message.reply({ content: "Only server admins can schedule Harmony announcements.", allowedMentions: { repliedUser: false } });
    return true;
  }

  const cancel = /^harmony\s+event\s+cancel\s+(\d+)\s*$/i.exec(message.content.trim());
  if (cancel) {
    const removed = store.cancelEvent(message.guild.id, Number(cancel[1]), message.author.id);
    await message.reply({ content: removed ? `Cancelled event #${cancel[1]}.` : "I could not find that active event.", allowedMentions: { repliedUser: false } });
    return true;
  }

  if (/^harmony\s+event\s+list\s*$/i.test(message.content.trim())) {
    const events = store.listEvents(message.guild.id);
    const content = events.length
      ? events.map((event) => `#${event.id} — **${event.title}** (${event.pending_count} upcoming)`).join("\n")
      : "There are no upcoming scheduled events.";
    await message.reply({ content, allowedMentions: { parse: [] } });
    return true;
  }

  try {
    const parsed = parseEvent(message.content);
    const destination = message.guild.channels.cache.get(parsed.destinationChannelId) ||
      await message.guild.channels.fetch(parsed.destinationChannelId).catch(() => null);
    if (!destination?.isTextBased()) throw new Error("The Post in channel is unavailable.");
    const me = message.guild.members.me;
    const permissions = destination.permissionsFor(me);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
      throw new Error("Harmony cannot view and send messages in that Post in channel.");
    }

    const eventId = store.createEvent({
      guildId: message.guild.id,
      sourceChannelId: message.channel.id,
      destinationChannelId: parsed.destinationChannelId,
      title: parsed.title,
      link: parsed.link,
      timezone: parsed.timezone,
      createdBy: message.author.id,
      announcements: parsed.announcements,
    });
    const lines = parsed.announcements.map((item) =>
      `• <t:${Math.floor(new Date(item.scheduledFor).getTime() / 1000)}:F> — ${item.message}`
    );
    await message.reply({
      content: [
        `✅ Event #${eventId} saved: **${parsed.title}**`,
        `Destination: <#${parsed.destinationChannelId}>`,
        `Link: ${parsed.link}`,
        "",
        ...lines,
        "",
        `Cancel with: ` + "`Harmony event cancel " + eventId + "`",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
    await message.react("✅").catch(() => {});
  } catch (error) {
    await message.reply({
      content: [
        `I could not save that event: **${error.message}**`,
        "",
        "Use:",
        "`Harmony event`",
        "`Title: Rock in Rio Replay`",
        "`Link: https://example.com/event`",
        "`Post in: #your-channel`",
        "`Timezone: America/New_York`",
        "`Announcements:`",
        "`2026-10-01 20:00 | Rock in Rio is one week away!`",
        "`2026-10-08 20:00 | Rock in Rio is starting now!`",
      ].join("\n"),
      allowedMentions: { repliedUser: false },
    });
  }
  return true;
}

async function processScheduledAnnouncements(client) {
  const due = store.dueAnnouncements(new Date().toISOString());
  for (const item of due) {
    if (!store.markSending(item.id)) continue;
    try {
      const guild = client.guilds.cache.get(item.guild_id) ||
        await client.guilds.fetch(item.guild_id).catch(() => null);
      const channel = guild && (guild.channels.cache.get(item.destination_channel_id) ||
        await guild.channels.fetch(item.destination_channel_id).catch(() => null));
      if (!channel?.isTextBased()) throw new Error("Destination channel is unavailable.");
      const sent = await channel.send({
        content: `${item.message}\n\n${item.link}`,
        allowedMentions: { parse: ["everyone", "roles", "users"] },
      });
      store.markSent(item.id, sent.id);
    } catch (error) {
      store.markFailed(item.id, error.message);
      console.error(`Scheduled event announcement ${item.id} failed:`, error);
    }
  }
}

function startEventScheduler(client) {
  processScheduledAnnouncements(client).catch((error) => console.error("Event scheduler startup failed:", error));
  const timer = setInterval(
    () => processScheduledAnnouncements(client).catch((error) => console.error("Event scheduler failed:", error)),
    CHECK_INTERVAL_MS
  );
  timer.unref?.();
}

module.exports = { parseEvent, handleEventSchedulerMessage, processScheduledAnnouncements, startEventScheduler };
