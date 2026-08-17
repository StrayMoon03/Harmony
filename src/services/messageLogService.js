const { EmbedBuilder } = require("discord.js");
const store = require("../stores/messageLogStore");

const RETENTION_MS = 72 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

function expiresAt() {
  return new Date(Date.now() + RETENTION_MS).toISOString();
}

function attachmentData(message) {
  return JSON.stringify([...message.attachments.values()].map((file) => ({
    name: file.name || "attachment",
    url: file.url,
    contentType: file.contentType || null,
    size: file.size || null,
  })));
}

function displayText(value, fallback = "*(no text)*") {
  const text = (value || "").trim();
  if (!text) return fallback;
  return text.length > 1500 ? text.slice(0, 1497) + "..." : text;
}

function attachmentText(serialized) {
  let files = [];
  try { files = JSON.parse(serialized || "[]"); } catch {}
  if (!files.length) return null;
  return displayText(files.map((file) => `[${file.name}](${file.url})`).join("\n"));
}

function settingsFor(message) {
  if (!message.guild || message.author?.bot) return null;
  const settings = store.getLogSettings(message.guild.id);
  if (!settings?.enabled) return null;
  if (message.channelId === settings.channel_id) return null;
  if (store.isChannelExcluded(message.guild.id, message.channelId)) return null;
  return settings;
}

function baseEmbed(message, title, color, timestamp) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(`By <@${message.author?.id || "unknown"}> in <#${message.channelId}>`)
    .setFooter({ text: `Message ID: ${message.id}` })
    .setTimestamp(timestamp || new Date());
}

async function postLog(message, settings, embed) {
  const channel = message.guild.channels.cache.get(settings.channel_id) ||
    await message.guild.channels.fetch(settings.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const posted = await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
  store.addLogPost(posted.id, message.guild.id, channel.id, expiresAt());
}

async function handleLoggedMessageCreate(message) {
  try {
    const settings = settingsFor(message);
    if (!settings) return;
    const now = new Date().toISOString();
    const attachments = attachmentData(message);
    store.saveSnapshot({
      messageId: message.id, guildId: message.guild.id,
      channelId: message.channelId, userId: message.author.id,
      username: message.author.tag || message.author.username,
      content: message.content || "", attachments,
      createdAt: message.createdAt.toISOString(), updatedAt: now,
      expiresAt: expiresAt(),
    });
    const embed = baseEmbed(message, "Message sent", 0x5865f2, message.createdAt)
      .addFields({ name: "Content", value: displayText(message.content) });
    const files = attachmentText(attachments);
    if (files) embed.addFields({ name: "Attachments", value: files });
    await postLog(message, settings, embed);
  } catch (error) {
    console.error("Harmony message-create logging failed:", error);
  }
}

async function handleLoggedMessageUpdate(oldMessage, newMessage) {
  try {
    if (newMessage.partial) await newMessage.fetch().catch(() => null);
    const settings = settingsFor(newMessage);
    if (!settings) return;
    const previous = store.getSnapshot(newMessage.id);
    const before = previous?.content ?? oldMessage.content ?? "";
    const beforeAttachments = previous?.attachments ?? attachmentData(oldMessage);
    const after = newMessage.content || "";
    const afterAttachments = attachmentData(newMessage);
    if (before === after && beforeAttachments === afterAttachments) return;
    const embed = baseEmbed(newMessage, "Message edited", 0xf0b232)
      .addFields(
        { name: "Before", value: displayText(before) },
        { name: "After", value: displayText(after) }
      );
    const files = attachmentText(afterAttachments);
    if (files) embed.addFields({ name: "Attachments after edit", value: files });
    await postLog(newMessage, settings, embed);
    const now = new Date().toISOString();
    store.saveSnapshot({
      messageId: newMessage.id, guildId: newMessage.guild.id,
      channelId: newMessage.channelId, userId: newMessage.author.id,
      username: newMessage.author.tag || newMessage.author.username,
      content: after, attachments: afterAttachments,
      createdAt: previous?.created_at || newMessage.createdAt.toISOString(),
      updatedAt: now, expiresAt: expiresAt(),
    });
  } catch (error) {
    console.error("Harmony message-edit logging failed:", error);
  }
}

async function handleLoggedMessageDelete(message) {
  try {
    const previous = store.getSnapshot(message.id);
    if (!message.guild || message.author?.bot) return;
    const settings = store.getLogSettings(message.guild.id);
    if (!settings?.enabled || message.channelId === settings.channel_id ||
        store.isChannelExcluded(message.guild.id, message.channelId)) return;
    const authorId = previous?.user_id || message.author?.id;
    const synthetic = { ...message, author: { id: authorId || "unknown" } };
    const embed = baseEmbed(synthetic, "Message deleted", 0xed4245)
      .addFields({ name: "Content", value: displayText(previous?.content ?? message.content) });
    const files = attachmentText(previous?.attachments ?? attachmentData(message));
    if (files) embed.addFields({ name: "Attachments", value: files });
    await postLog(message, settings, embed);
  } catch (error) {
    console.error("Harmony message-delete logging failed:", error);
  }
}

async function cleanup(client) {
  const now = new Date().toISOString();
  for (const post of store.listExpiredLogPosts(now)) {
    try {
      const guild = client.guilds.cache.get(post.guild_id);
      const channel = guild?.channels.cache.get(post.channel_id) ||
        await guild?.channels.fetch(post.channel_id).catch(() => null);
      const message = await channel?.messages.fetch(post.message_id).catch(() => null);
      if (message) await message.delete().catch(() => null);
    } finally {
      store.removeLogPost(post.message_id);
    }
  }
  store.purgeExpiredSnapshots(now);
}

function startMessageLogCleanup(client) {
  cleanup(client).catch((error) => console.error("Message-log cleanup failed:", error));
  const timer = setInterval(() => cleanup(client).catch((error) =>
    console.error("Message-log cleanup failed:", error)), CLEANUP_INTERVAL_MS);
  timer.unref?.();
}

module.exports = {
  RETENTION_MS, handleLoggedMessageCreate, handleLoggedMessageUpdate,
  handleLoggedMessageDelete, startMessageLogCleanup,
};
