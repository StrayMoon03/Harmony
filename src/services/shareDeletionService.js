const shareStore = require("../stores/shareStore");

/**
 * When the original member link is deleted:
 * 1) forget the saved share (which also subtracts it from collection totals),
 * 2) delete every Discord message Harmony created for that share.
 *
 * @param {import("discord.js").Message} message
 */
async function handleDeletedShare(message) {
  const removed = shareStore.removeByMessageId(message.id);
  if (!removed) return false;

  const guildId = removed.share?.guild_id || message.guildId;
  const guild =
    message.guild ||
    message.client.guilds.cache.get(guildId) ||
    (guildId
      ? await message.client.guilds.fetch(guildId).catch(() => null)
      : null);

  for (const output of removed.outputs) {
    try {
      const channel =
        guild?.channels.cache.get(output.channel_id) ||
        (await guild?.channels.fetch(output.channel_id).catch(() => null));
      if (!channel?.isTextBased()) continue;

      const botMessage = await channel.messages
        .fetch(output.bot_message_id)
        .catch(() => null);
      if (botMessage) await botMessage.delete().catch(() => null);
    } catch (error) {
      console.warn(
        "Could not delete a Harmony media message:",
        error instanceof Error ? error.message : error
      );
    }
  }

  // Older saved shares predate output-message tracking. The first Harmony
  // media card is a reply, so remove it safely when it is still recent.
  if (removed.outputs.length === 0 && message.channel?.isTextBased()) {
    const recent = await message.channel.messages
      .fetch({ limit: 100 })
      .catch(() => null);
    const replies = recent?.filter(
      (candidate) =>
        candidate.author.id === message.client.user.id &&
        candidate.reference?.messageId === message.id
    );
    for (const reply of replies?.values() || []) {
      await reply.delete().catch(() => null);
    }
  }

  console.log(
    "Deleted share forgotten:",
    removed.share
      ? removed.share.platform + ":" + removed.share.media_id
      : message.id
  );
  return true;
}

module.exports = {
  handleDeletedShare,
};
