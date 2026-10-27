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

const CONDITION_TYPES = new Set(["phrase", "domain", "url", "has_attachment", "has_image_attachment"]);

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

function cleanRuleValue(type, value) {
  const trimmed = String(value || "").trim();
  return type === "domain" ? normalizeDomain(trimmed) : trimmed.toLowerCase();
}

function normalizeConditions(rule) {
  if (Array.isArray(rule.conditions)) return rule.conditions;
  if (typeof rule.conditions_json === "string") {
    try {
      const parsed = JSON.parse(rule.conditions_json);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  // Rows created before compound rules retain their historical substring
  // behavior for phrase rules; new rules use whole-word/phrase matching.
  return [{ type: rule.rule_type, value: rule.pattern, legacySubstring: true }];
}

function isImageAttachment(file) {
  const contentType = String(file?.contentType || file?.content_type || "").toLowerCase();
  if (contentType.startsWith("image/")) return true;
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(String(file?.name || ""));
}

function phraseMatches(text, phrase, legacySubstring = false) {
  const haystack = String(text || "").toLowerCase();
  const needle = String(phrase || "").trim().toLowerCase();
  if (!needle) return false;
  if (legacySubstring) return haystack.includes(needle);
  const escaped = needle
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(haystack);
}

function urlsIn(text) {
  return String(text || "").match(/https?:\/\/[^\s<>]+/gi) || [];
}

function getAttachments(message) {
  return Array.from(message?.attachments?.values?.() || []);
}

function conditionMatches(condition, message) {
  const content = String(message.content || "");
  const attachments = getAttachments(message);
  if (condition.type === "phrase") {
    const textParts = [content, ...attachments.map((file) => file.name || "")];
    if (condition.legacySubstring) return phraseMatches(textParts.join("\n"), condition.value, true);
    return textParts.some((part) => phraseMatches(part, condition.value));
  }
  if (condition.type === "url") {
    const pattern = String(condition.value || "").toLowerCase();
    return Boolean(pattern) && urlsIn(content).some((url) => url.toLowerCase().includes(pattern));
  }
  if (condition.type === "domain") {
    const wanted = normalizeDomain(condition.value);
    if (!wanted) return false;
    return urlsIn(content).some((raw) => {
      try {
        const host = normalizeDomain(new URL(raw).hostname);
        return host === wanted || host.endsWith("." + wanted);
      } catch {
        return false;
      }
    });
  }
  if (condition.type === "has_attachment") return attachments.length > 0;
  if (condition.type === "has_image_attachment") return attachments.some(isImageAttachment);
  return false;
}

function conditionLabel(condition) {
  if (condition.type === "phrase") return `Text contains “${condition.value}”`;
  if (condition.type === "domain") return `Website/domain: ${condition.value}`;
  if (condition.type === "url") return `URL contains: ${condition.value}`;
  if (condition.type === "has_attachment") return "Message has an attachment";
  if (condition.type === "has_image_attachment") return "Message has an image attachment";
  return "Unknown condition";
}

function evaluateRule(rule, message) {
  const conditions = normalizeConditions(rule);
  const results = conditions.map((condition) => ({ condition, matched: conditionMatches(condition, message) }));
  const mode = String(rule.match_mode || "all").toLowerCase() === "any" ? "any" : "all";
  const matches = results.length > 0 && (mode === "all"
    ? results.every((result) => result.matched)
    : results.some((result) => result.matched));
  return {
    matches,
    mode,
    conditions,
    matchedConditions: results.filter((result) => result.matched).map((result) => result.condition),
  };
}

function ruleMatches(rule, message) {
  return evaluateRule(rule, message).matches;
}

function validateConditions(conditions, matchMode = "all") {
  if (!Array.isArray(conditions) || conditions.length < 1 || conditions.length > 5) {
    throw new Error("A rule needs between 1 and 5 conditions.");
  }
  if (!["all", "any"].includes(String(matchMode).toLowerCase())) {
    throw new Error("Choose whether ALL or ANY conditions must match.");
  }
  return conditions.map((condition) => {
    if (!CONDITION_TYPES.has(condition.type)) throw new Error("That condition type is not supported.");
    if (["has_attachment", "has_image_attachment"].includes(condition.type)) {
      if (String(condition.value || "").trim()) throw new Error("Attachment conditions do not take a value.");
      return { type: condition.type };
    }
    const value = cleanRuleValue(condition.type, condition.value);
    if (!value) throw new Error("Each text, domain, or URL condition needs a value.");
    if (condition.type === "domain" && !value.includes(".")) {
      throw new Error("Website/domain values should look like `example.com`.");
    }
    if (value.length > 300) throw new Error("Condition values can be up to 300 characters.");
    return { type: condition.type, value };
  });
}

function legacyColumns(conditions) {
  const first = conditions[0];
  return [
    ["phrase", "domain", "url"].includes(first.type) ? first.type : "phrase",
    first.value || first.type,
  ];
}

function createRule({ guildId, name = null, conditions, matchMode = "all", category, action = "flag" }) {
  const normalized = validateConditions(conditions, matchMode);
  if (!Object.hasOwn(CATEGORY_LABELS, category)) throw new Error("Choose one of the available Guard reasons.");
  if (!["flag", "remove"].includes(action)) throw new Error("Choose Admin Review or Automatic Removal.");
  const [type, pattern] = legacyColumns(normalized);
  return store.addRule({
    guildId, name: String(name || "").trim() || null,
    conditions: normalized, matchMode: String(matchMode).toLowerCase(),
    type, pattern, category, action,
  });
}

function editRule(guildId, ruleId, changes) {
  const existing = store.getRule(guildId, ruleId);
  if (!existing) return false;
  const update = {};
  if (changes.name !== undefined) update.name = String(changes.name || "").trim() || null;
  if (changes.category !== undefined) {
    if (!Object.hasOwn(CATEGORY_LABELS, changes.category)) throw new Error("Choose one of the available Guard reasons.");
    update.category = changes.category;
  }
  if (changes.action !== undefined) {
    if (!["flag", "remove"].includes(changes.action)) throw new Error("Choose Admin Review or Automatic Removal.");
    update.action = changes.action;
  }
  if (changes.conditions !== undefined) {
    const conditions = validateConditions(changes.conditions, changes.matchMode ?? existing.match_mode ?? "all");
    const [type, pattern] = legacyColumns(conditions);
    update.conditions = conditions;
    update.rule_type = type;
    update.pattern = pattern;
  }
  if (changes.matchMode !== undefined) {
    const matchMode = String(changes.matchMode).toLowerCase();
    if (!["all", "any"].includes(matchMode)) throw new Error("Choose whether ALL or ANY conditions must match.");
    update.match_mode = matchMode;
  }
  return store.updateRule(guildId, ruleId, update);
}

function removeRule(guildId, ruleId) {
  return store.removeRule(guildId, ruleId);
}

function memberCanViewReviewRoom(channel) {
  if (!channel || typeof channel.permissionsFor !== "function") return null;
  const view = PermissionFlagsBits.ViewChannel;
  const everyoneRole = channel.guild?.roles?.everyone;
  if (everyoneRole && channel.permissionsFor(everyoneRole)?.has(view)) return true;
  const memberOverwrites = channel.permissionOverwrites?.cache?.values?.() || [];
  for (const overwrite of memberOverwrites) {
    if (overwrite.type !== 1 || !overwrite.allow?.has(view)) continue;
    const member = channel.guild?.members?.cache?.get(overwrite.id);
    const memberPermissions = member?.permissions;
    const isModerator = [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.ManageChannels,
    ].some((bit) => memberPermissions?.has(bit));
    if (!isModerator) return true;
  }
  const roles = channel.guild?.roles?.cache?.values?.() || [];
  for (const role of roles) {
    if (!role || role.id === everyoneRole?.id) continue;
    const rolePermissions = role.permissions;
    const isModeratorRole = [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.ManageChannels,
    ].some((bit) => rolePermissions?.has(bit));
    if (!isModeratorRole && channel.permissionsFor(role)?.has(view)) return true;
  }
  return false;
}

function reviewRoomVisibilityWarning(channel) {
  const visible = memberCanViewReviewRoom(channel);
  if (visible === true) return "⚠️ Visibility check: @everyone or a role without moderation permissions appears able to view this room. Review its channel permissions before using it for private moderation.";
  if (visible === false) return "Visibility check: @everyone and the checked non-moderator roles do not appear able to view this room. Verify your intended moderator access.";
  return "⚠️ Visibility could not be verified from the available channel permissions. Check who can view this room before using it for private moderation.";
}

async function getGuardChannel(guild, settings) {
  const channel = guild.channels.cache.get(settings.channel_id) ||
    await guild.channels.fetch(settings.channel_id).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function attachmentSummary(message) {
  return getAttachments(message).map((file) => {
    const name = truncate(file.name || "(unnamed attachment)", 120);
    const type = file.contentType || file.content_type || "type unavailable";
    return `• ${name} — ${truncate(type, 80)}`;
  });
}

function reviewEmbed(message, rule, match) {
  const jumpUrl = `https://discord.com/channels/${message.guild.id}/${message.channelId}/${message.id}`;
  const name = truncate(rule.name || `Rule #${rule.id}`, 100);
  const lines = [
    `**Member:** <@${message.author.id}>`,
    `**Channel:** <#${message.channelId}>`,
    `**Reason:** ${CATEGORY_LABELS[rule.category] || rule.category}`,
    `**Rule:** ${name} · #${rule.id}`,
    `**Matched condition${match.matchedConditions.length === 1 ? "" : "s"}:** ${match.matchedConditions.map(conditionLabel).join("; ")}`,
    `[Open original message](${jumpUrl})`,
    "",
    `**Message:** ${message.content ? truncate(message.content, 1400) : "(no text)"}`,
  ];
  const attachments = attachmentSummary(message);
  if (attachments.length) lines.push("", "**Attachments:**", ...attachments.slice(0, 10));
  lines.push("", "Harmony has not removed the message. Media processing is paused until an admin reviews it.");
  return new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle("⚠️ Community Guard Review")
    .setDescription(truncate(lines.join("\n"), 4000))
    .setTimestamp();
}

function reviewButtons(rule, message) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`guard_remove:${rule.id}:${message.channelId}:${message.id}`)
      .setLabel("Remove & privately message")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`guard_safe:${rule.id}:${message.channelId}:${message.id}`)
      .setLabel("Mark safe")
      .setStyle(ButtonStyle.Success)
  );
}

async function sendAdminLog(message, details) {
  const settings = store.getSettings(message.guild.id);
  if (!settings?.channel_id) return false;
  const channel = await getGuardChannel(message.guild, settings);
  if (!channel) return false;
  const lines = [
    `**Member:** <@${message.author.id}>`,
    `**Channel:** <#${message.channelId}>`,
    `**Reason:** ${CATEGORY_LABELS[details.category] || details.category}`,
    `**Source:** ${details.source}`,
    details.adminId ? `**Handled by:** <@${details.adminId}>` : null,
    `**Private DM:** ${details.dmDelivered ? "Delivered" : "Could not deliver—member DMs may be closed"}`,
    `**Message ID:** \`${message.id}\``,
  ].filter(Boolean);
  try {
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle("💜 Community Guard Removal").setDescription(lines.join("\n")).setTimestamp()],
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    console.warn("Community Guard could not post to its configured review room:", error?.message || error);
    return false;
  }
}

async function deleteMirroredReplies(message) {
  const recent = await message.channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return 0;
  const replies = recent.filter((candidate) => candidate.author.id === message.client.user.id && candidate.reference?.messageId === message.id);
  let removed = 0;
  for (const reply of replies.values()) {
    if (await reply.delete().then(() => true).catch(() => false)) removed += 1;
  }
  return removed;
}

async function dmMember(message, category) {
  const body = DM_MESSAGES[category] || DM_MESSAGES.other;
  return message.author.send({
    content: ["💜 Hi " + (message.author.globalName || message.author.username) + "!", "", body, "", "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚"].join("\n"),
    allowedMentions: { parse: [] },
  }).then(() => true).catch(() => false);
}

async function removeMessage(message, { category, source, ruleId = null, adminId = null }) {
  if (!message?.guild || message.author?.bot) throw new Error("Harmony can only moderate a member’s server message.");
  await message.delete().catch((error) => {
    throw new Error("I couldn’t delete that message. Check my Manage Messages permission.", { cause: error });
  });
  await deleteMirroredReplies(message);
  store.removeContributionForMessage(message.guild.id, message.id);
  const dmDelivered = await dmMember(message, category);
  store.addAction({
    guildId: message.guild.id, messageId: message.id, channelId: message.channelId,
    userId: message.author.id, category, source, ruleId, adminId, dmDelivered,
  });
  const logDelivered = await sendAdminLog(message, { category, source, adminId, dmDelivered });
  return { dmDelivered, logDelivered };
}

async function disableReviewCard(guild, state) {
  if (!state?.review_channel_id || !state?.review_message_id) return;
  const channel = guild.channels.cache.get(state.review_channel_id) ||
    await guild.channels.fetch(state.review_channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const review = await channel.messages.fetch(state.review_message_id).catch(() => null);
  if (review) await review.edit({ components: [] }).catch(() => {});
}

async function sendReviewAlert(message, rule, match) {
  const settings = store.getSettings(message.guild.id);
  if (!settings?.channel_id) return null;
  const channel = await getGuardChannel(message.guild, settings);
  if (!channel) return null;
  return channel.send({
    embeds: [reviewEmbed(message, rule, match)],
    components: [reviewButtons(rule, message)],
    allowedMentions: { parse: [] },
  });
}

async function updateReviewAlert(message, rule, match, state) {
  const channel = state?.review_channel_id && (message.guild.channels.cache.get(state.review_channel_id) ||
    await message.guild.channels.fetch(state.review_channel_id).catch(() => null));
  if (!channel?.isTextBased() || !state.review_message_id) return false;
  const alert = await channel.messages.fetch(state.review_message_id).catch(() => null);
  if (!alert) return false;
  await alert.edit({
    embeds: [reviewEmbed(message, rule, match)],
    components: [reviewButtons(rule, message)],
    allowedMentions: { parse: [] },
  });
  return true;
}

async function handleGuardedMessage(message, { edited = false } = {}) {
  if (message?.partial) message = await message.fetch().catch(() => message);
  if (!message?.guild || message.author?.bot) return false;
  const settings = store.getSettings(message.guild.id);
  if (!settings?.enabled) return false;
  if (!edited && store.isSafeMessage(message.guild.id, message.id)) return false;
  if (edited) store.clearSafe(message.guild.id, message.id);

  const prior = store.getMessageState(message.guild.id, message.id);
  const rules = store.listRules(message.guild.id);
  const selected = rules.map((rule) => ({ rule, match: evaluateRule(rule, message) })).find((item) => item.match.matches);

  if (!selected) {
    if (edited && prior?.status === "pending") {
      await disableReviewCard(message.guild, prior);
      store.setMessageState(message.guild.id, message.id, "resolved", prior.rule_id);
    }
    return false;
  }

  const { rule, match } = selected;
  if (rule.action === "remove") {
    try {
      await removeMessage(message, {
        category: rule.category,
        source: `Automatic admin-configured rule #${rule.id}`,
        ruleId: rule.id,
      });
    } catch (error) {
      // The matched message must not proceed to Harmony media handling when
      // automatic removal fails; keep it in Discord and surface the failure.
      console.error("Community Guard matched a message but could not remove it; normal processing was stopped:", error);
      return true;
    }
    if (prior?.status === "pending") await disableReviewCard(message.guild, prior);
    store.setMessageState(message.guild.id, message.id, "removed", rule.id);
    return true;
  }

  if (prior?.status === "pending") {
    if (!edited) return true;
    const updated = await updateReviewAlert(message, rule, match, prior).catch(() => false);
    if (!updated) {
      await disableReviewCard(message.guild, prior);
      store.setMessageState(message.guild.id, message.id, "resolved", rule.id);
      return false;
    }
    store.setReviewMessage(message.guild.id, message.id, rule.id, prior.review_channel_id, prior.review_message_id);
    return true;
  }
  if (prior?.status === "removed") return true;
  if (!store.beginReview(message.guild.id, message.id, rule.id)) return true;

  let alert;
  try {
    alert = await sendReviewAlert(message, rule, match);
  } catch (error) {
    store.setMessageState(message.guild.id, message.id, "resolved", rule.id);
    console.warn("Community Guard could not post a review alert; message continues through normal processing:", error?.message || error);
    return false;
  }
  if (!alert) {
    store.setMessageState(message.guild.id, message.id, "resolved", rule.id);
    console.warn("Community Guard has no usable review room; matched message continues through normal processing.");
    return false;
  }
  store.setReviewMessage(message.guild.id, message.id, rule.id, alert.channelId, alert.id);
  return true;
}

async function fetchTarget(interaction, channelId, messageId) {
  const channel = interaction.guild.channels.cache.get(channelId) ||
    await interaction.guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel.messages.fetch(messageId).catch(() => null) : null;
}

async function handleGuardComponent(interaction) {
  const isGuardComponent =
    (interaction.isStringSelectMenu() && interaction.customId.startsWith("guard_manual:")) ||
    (interaction.isButton() && /^(guard_remove|guard_safe):/.test(interaction.customId));
  if (!isGuardComponent) return false;

  if (!interaction.guild || !memberCanModerate(interaction)) {
    await interaction.reply({ content: "You need the Manage Messages permission to use Community Guard.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("guard_manual:")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [, channelId, messageId] = interaction.customId.split(":");
    const message = await fetchTarget(interaction, channelId, messageId);
    if (!message) return interaction.editReply("That message is no longer available.");
    const category = interaction.values[0];
    try {
      const result = await removeMessage(message, { category, source: "Manual admin removal", adminId: interaction.user.id });
      if (result.dmDelivered) return interaction.editReply("The message was removed and the member received a private explanation.");
      return interaction.editReply(result.logDelivered
        ? "The message was removed. The member could not be DMed; the Guard Review Room log records this."
        : "The message was removed, but the member could not be DMed and no Guard Review Room log could be posted.");
    } catch (error) {
      return interaction.editReply(error.message || "I couldn’t remove that message.");
    }
  }

  if (interaction.isButton() && /^(guard_remove|guard_safe):/.test(interaction.customId)) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [action, ruleIdText, channelId, messageId] = interaction.customId.split(":");
    const state = store.getMessageState(interaction.guild.id, messageId);
    if (state?.status !== "pending") return interaction.editReply("This review has already been handled or is no longer active.");
    const rule = store.getRule(interaction.guild.id, Number(ruleIdText));
    const message = await fetchTarget(interaction, channelId, messageId);
    if (!message) return interaction.editReply("That message is no longer available.");

    if (action === "guard_safe") {
      store.markSafe(interaction.guild.id, message.id, interaction.user.id);
      store.setMessageState(interaction.guild.id, message.id, "safe", Number(ruleIdText));
      await interaction.message.edit({ components: [] }).catch(() => {});
      await interaction.editReply("Marked safe. Harmony will now process the original message normally.");
      const { handleMediaMessage } = require("../handlers/mediaHandler");
      await handleMediaMessage(message).catch((error) => console.error("Community Guard safe-message media processing failed:", error));
      return true;
    }

    if (!rule) return interaction.editReply("That Community Guard rule no longer exists.");
    try {
      await removeMessage(message, {
        category: rule.category,
        source: `Admin-reviewed rule #${rule.id}`,
        ruleId: rule.id,
        adminId: interaction.user.id,
      });
      store.setMessageState(interaction.guild.id, message.id, "removed", rule.id);
      await interaction.message.edit({ components: [] }).catch(() => {});
      return interaction.editReply("Removed. The member was contacted privately if their DMs were available; the log records the delivery result.");
    } catch (error) {
      return interaction.editReply(error.message || "I couldn’t remove that message.");
    }
  }
  return false;
}

module.exports = {
  CATEGORY_LABELS,
  DM_MESSAGES,
  CONDITION_TYPES,
  cleanRuleValue,
  normalizeConditions,
  conditionLabel,
  conditionMatches,
  evaluateRule,
  ruleMatches,
  validateConditions,
  createRule,
  editRule,
  removeRule,
  memberCanViewReviewRoom,
  reviewRoomVisibilityWarning,
  handleGuardedMessage,
  handleGuardComponent,
  memberCanModerate,
};
