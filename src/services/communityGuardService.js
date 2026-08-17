const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const store = require("../stores/communityGuardStore");

const CATEGORY_LABELS = {
  paid: "Paid content",
  promotion: "Self-promotion",
  inappropriate: "Inappropriate content",
  harmful_ai: "Harmful or ridiculing AI",
  spam: "Spam or scam",
  other: "Other rule violation",
};

const DM_MESSAGES = {
  paid: "I tucked that post away because it appears to contain paid or subscriber-only content. Keeping it in its original home helps protect the artists and our community. Thank you for understanding!",
  promotion: "I tucked that post away because personal sales and self-promotion need admin approval before being shared here. No worries—please check with the admin team if you think it belongs in one of our rooms.",
  inappropriate: "I tucked that post away because it wasn’t quite the right fit for this room. We want everyone to feel comfortable here, so thank you for helping us keep the space welcoming.",
  harmful_ai: "I tucked that post away because AI content that could embarrass, ridicule, or negatively affect the members isn’t shared in our community. Thank you for helping us keep things respectful.",
  spam: "I tucked that message away because it matched something our team watches for as possible spam or an unsafe link. If you believe it was removed by mistake, please let an admin know.",
  other: "I tucked that message away because it wasn’t the right fit for this server. If you have questions, please reach out to an admin—we’ll be happy to help.",
};

function memberCanModerate(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
}

function normalizeDomain(value) {
  let text = String(value || "").trim().toLowerCase();
  try {
    const url = new URL(text.includes("://") ? text : "https://" + text);
    text = url.hostname;
  } catch {}
  return text.replace(/^www\./, "").replace(/\/$/, "");
}

function urlsIn(text) {
  return String(text || "").match(/https?:\/\/[^\s<>]+/gi) || [];
}

function ruleMatches(rule, message) {
  const content = [
    message.content || "",
    ...message.attachments.values().map((file) => file.name || ""),
  ].join("\n");
  const lower = content.toLowerCase();
  const pattern = String(rule.pattern || "").toLowerCase();

  if (rule.rule_type === "phrase") return lower.includes(pattern);
  if (rule.rule_type === "url") {
    return urlsIn(content).some((url) => url.toLowerCase().includes(pattern));
  }
  if (rule.rule_type === "domain") {
    const wanted = normalizeDomain(pattern);
    return urlsIn(content).some((raw) => {
      try {
        const host = normalizeDomain(new URL(raw).hostname);
        return host === wanted || host.endsWith("." + wanted);
      } catch {
        return false;
      }
    });
  }
  return false;
}

async function getGuardChannel(guild, settings) {
  const channel = guild.channels.cache.get(settings.channel_id) ||
    await guild.channels.fetch(settings.channel_id).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function sendAdminLog(message, details) {
  const settings = store.getSettings(message.guild.id);
  if (!settings?.channel_id) return;
  const channel = await getGuardChannel(message.guild, settings);
  if (!channel) return;

  const lines = [
    "**Member:** <@" + message.author.id + ">",
    "**Channel:** <#" + message.channelId + ">",
    "**Reason:** " + (CATEGORY_LABELS[details.category] || details.category),
    "**Source:** " + details.source,
    details.adminId ? "**Handled by:** <@" + details.adminId + ">" : null,
    "**Private DM:** " + (details.dmDelivered ? "Delivered" : "Could not deliver—member DMs may be closed"),
    "**Message ID:** `" + message.id + "`",
  ].filter(Boolean);

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle("💜 Community Guard Removal")
      .setDescription(lines.join("\n"))
      .setTimestamp()],
    allowedMentions: { parse: [] },
  });
}

async function deleteMirroredReplies(message) {
  const recent = await message.channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return 0;
  const replies = recent.filter((candidate) =>
    candidate.author.id === message.client.user.id &&
    candidate.reference?.messageId === message.id
  );
  let removed = 0;
  for (const reply of replies.values()) {
    if (await reply.delete().then(() => true).catch(() => false)) removed += 1;
  }
  return removed;
}

async function dmMember(message, category) {
  const body = DM_MESSAGES[category] || DM_MESSAGES.other;
  return message.author.send({
    content: [
      "💜 Hi " + (message.author.globalName || message.author.username) + "!",
      "",
      body,
      "",
      "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
    ].join("\n"),
    allowedMentions: { parse: [] },
  }).then(() => true).catch(() => false);
}

async function removeMessage(message, {
  category, source, ruleId = null, adminId = null,
}) {
  if (!message?.guild || message.author?.bot) {
    throw new Error("Harmony can only moderate a member’s server message.");
  }

  await message.delete().catch((error) => {
    throw new Error("I couldn’t delete that message. Check my Manage Messages permission.", { cause: error });
  });
  await deleteMirroredReplies(message);
  store.removeContributionForMessage(message.guild.id, message.id);
  const dmDelivered = await dmMember(message, category);
  store.addAction({
    guildId: message.guild.id,
    messageId: message.id,
    channelId: message.channelId,
    userId: message.author.id,
    category,
    source,
    ruleId,
    adminId,
    dmDelivered,
  });
  await sendAdminLog(message, { category, source, adminId, dmDelivered });
  return { dmDelivered };
}

function reviewButtons(rule, message) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("guard_remove:" + rule.id + ":" + message.channelId + ":" + message.id)
      .setLabel("Remove & privately message")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("guard_safe:" + rule.id + ":" + message.channelId + ":" + message.id)
      .setLabel("Mark safe")
      .setStyle(ButtonStyle.Success)
  );
}

async function sendReviewAlert(message, rule) {
  const settings = store.getSettings(message.guild.id);
  const channel = settings && await getGuardChannel(message.guild, settings);
  if (!channel) return;
  const jumpUrl = "https://discord.com/channels/" + message.guild.id + "/" + message.channelId + "/" + message.id;
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(0xf0b232)
      .setTitle("⚠️ Community Guard Review")
      .setDescription([
        "**Possible reason:** " + (CATEGORY_LABELS[rule.category] || rule.category),
        "**Member:** <@" + message.author.id + ">",
        "**Channel:** <#" + message.channelId + ">",
        "**Matched rule:** `#" + rule.id + "`",
        "[Open the original message](" + jumpUrl + ")",
        "",
        "Harmony has not removed the message. Media processing is paused until an admin reviews it.",
      ].join("\n"))
      .setTimestamp()],
    components: [reviewButtons(rule, message)],
    allowedMentions: { parse: [] },
  });
}

async function handleGuardedMessage(message) {
  if (!message.guild || message.author.bot) return false;
  const settings = store.getSettings(message.guild.id);
  if (!settings?.enabled || store.isSafeMessage(message.guild.id, message.id)) return false;
  const rule = store.listRules(message.guild.id).find((item) => ruleMatches(item, message));
  if (!rule) return false;

  if (rule.action === "remove") {
    await removeMessage(message, {
      category: rule.category,
      source: "Automatic admin-configured rule #" + rule.id,
      ruleId: rule.id,
    });
  } else {
    await sendReviewAlert(message, rule);
  }
  return true;
}

async function fetchTarget(interaction, channelId, messageId) {
  const channel = interaction.guild.channels.cache.get(channelId) ||
    await interaction.guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased()
    ? channel.messages.fetch(messageId).catch(() => null)
    : null;
}

async function handleGuardComponent(interaction) {
  const isGuardComponent =
    (interaction.isStringSelectMenu() && interaction.customId.startsWith("guard_manual:")) ||
    (interaction.isButton() && /^(guard_remove|guard_safe):/.test(interaction.customId));
  if (!isGuardComponent) return false;

  if (!interaction.guild || !memberCanModerate(interaction)) {
    await interaction.reply({
      content: "You need the Manage Messages permission to use Community Guard.",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("guard_manual:")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [, channelId, messageId] = interaction.customId.split(":");
    const message = await fetchTarget(interaction, channelId, messageId);
    if (!message) return interaction.editReply("That message is no longer available.");
    const category = interaction.values[0];
    try {
      const result = await removeMessage(message, {
        category,
        source: "Manual admin removal",
        adminId: interaction.user.id,
      });
      return interaction.editReply(
        "The message was removed and the member " +
        (result.dmDelivered ? "received a private explanation." : "could not be DMed; I notified the private admin channel.")
      );
    } catch (error) {
      return interaction.editReply(error.message || "I couldn’t remove that message.");
    }
  }

  if (interaction.isButton() && /^(guard_remove|guard_safe):/.test(interaction.customId)) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [action, ruleIdText, channelId, messageId] = interaction.customId.split(":");
    const rule = store.getRule(interaction.guild.id, Number(ruleIdText));
    const message = await fetchTarget(interaction, channelId, messageId);
    if (!message) return interaction.editReply("That message is no longer available.");

    if (action === "guard_safe") {
      store.markSafe(interaction.guild.id, message.id, interaction.user.id);
      await interaction.message.edit({ components: [] }).catch(() => {});
      await interaction.editReply("Marked safe. Harmony will now process the original message normally.");
      const { handleMediaMessage } = require("../handlers/mediaHandler");
      await handleMediaMessage(message).catch((error) =>
        console.error("Community Guard safe-message media processing failed:", error)
      );
      return;
    }

    if (!rule) return interaction.editReply("That Community Guard rule no longer exists.");
    try {
      const result = await removeMessage(message, {
        category: rule.category,
        source: "Admin-reviewed rule #" + rule.id,
        ruleId: rule.id,
        adminId: interaction.user.id,
      });
      await interaction.message.edit({ components: [] }).catch(() => {});
      return interaction.editReply(
        "Removed. The member " +
        (result.dmDelivered ? "received a private explanation." : "could not be DMed; the private log notes that.")
      );
    } catch (error) {
      return interaction.editReply(error.message || "I couldn’t remove that message.");
    }
  }

  return false;
}

module.exports = {
  CATEGORY_LABELS,
  DM_MESSAGES,
  handleGuardedMessage,
  handleGuardComponent,
  memberCanModerate,
  normalizeDomain,
};
