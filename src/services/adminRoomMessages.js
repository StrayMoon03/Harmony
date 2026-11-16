const { PermissionFlagsBits } = require("discord.js");
const store = require("../stores/adminRoomStore");

const deliveriesInProgress = new Map();

function withAdminRoomLock(guildId, operation) {
  const previous = deliveriesInProgress.get(guildId) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  deliveriesInProgress.set(guildId, next);
  return next.finally(() => {
    if (deliveriesInProgress.get(guildId) === next) deliveriesInProgress.delete(guildId);
  });
}

async function fetchRoomChannel(guild, channelId) {
  return guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch((error) => {
    if (error.code === 10003) return null; // Unknown Channel
    throw error;
  });
}

async function fetchRoomMessage(channel, id) {
  return channel.messages.fetch({ message: id, force: true }).catch((error) => {
    if (error.code === 10008) return null; // Unknown Message
    throw error;
  });
}

function canReadHistory(guild, channel) {
  return channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ReadMessageHistory);
}

function deliveryMarker(delivery) {
  return `Harmony ${delivery.kind} · ${delivery.token}`;
}

async function findDelivery(guild, channel, delivery) {
  if (!canReadHistory(guild, channel)) {
    throw new Error("Harmony needs Read Message History to recover its Admin Room messages.");
  }
  if (delivery.message_id) return fetchRoomMessage(channel, delivery.message_id);

  // The record exists before the POST. Find a successful send even if its
  // response was lost or Discord's short nonce deduplication window expired.
  const marker = deliveryMarker(delivery);
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
    const ordered = [...batch.values()].sort((left, right) =>
      BigInt(left.id) > BigInt(right.id) ? -1 : 1);
    const match = ordered.find((message) => message.author?.id === guild.members.me.id &&
      message.embeds[0]?.footer?.text === marker);
    if (match) return match;
    const oldest = ordered.at(-1);
    if (ordered.length < 100 ||
        (delivery.after_message_id && BigInt(oldest.id) <= BigInt(delivery.after_message_id))) return null;
    before = oldest.id;
  }
}

async function ensureRoomMessage(guild, channel, kind, payload, shouldReuse = () => true) {
  let delivery = store.getDelivery(guild.id, kind);
  if (delivery) {
    if (delivery.channel_id !== channel.id) {
      throw new Error("Harmony's previous Admin Room message must be retired first.");
    }
    const existing = await findDelivery(guild, channel, delivery);
    if (existing && shouldReuse(existing)) {
      if (delivery.message_id !== existing.id) store.finishDelivery(delivery, existing.id);
      return existing;
    }
    if (delivery.message_id || existing) {
      store.clearDelivery(delivery);
      delivery = null;
    }
  }

  if (!canReadHistory(guild, channel)) {
    throw new Error("Harmony needs Read Message History to post a recoverable Admin Room message.");
  }
  if (!delivery) {
    const latest = await channel.messages.fetch({ limit: 1, cache: false });
    const anchor = latest.values().next().value?.id ?? null;
    delivery = store.beginDelivery(guild.id, kind, channel.id, anchor);
  }
  payload.embeds[0].setFooter({ text: deliveryMarker(delivery) });
  const posted = await channel.send({ ...payload, nonce: delivery.token, enforceNonce: true });
  store.finishDelivery(delivery, posted.id);
  return posted;
}

async function retireRoomMessage(guild, kind) {
  const delivery = store.getDelivery(guild.id, kind);
  if (!delivery) return;
  const channel = await fetchRoomChannel(guild, delivery.channel_id);
  const message = channel && await findDelivery(guild, channel, delivery);
  if (message) {
    await message.delete().catch((error) => {
      if (error.code !== 10008) throw error;
    });
  }
  store.clearDelivery(delivery);
}

module.exports = {
  withAdminRoomLock, fetchRoomChannel, fetchRoomMessage, ensureRoomMessage, retireRoomMessage,
};
