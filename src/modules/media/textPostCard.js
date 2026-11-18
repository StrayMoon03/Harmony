const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { platformIcon } = require("./emojiConfig");
const { buttonUrlForPlatform } = require("./formatter");

// Discord embed limits.
const DESCRIPTION_LIMIT = 4096;
const AUTHOR_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const URL_LIMIT = 2048;

// Same colors the media cards use for each platform.
const PLATFORM_COLORS = {
  threads: 0xffffff,
  x: 0x000000,
  instagram: 0xfacc15,
  tiktok: 0xff4fa3,
  youtube: 0xff0000,
};

function truncate(value, limit) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || value.length > URL_LIMIT) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Builds the Discord message Harmony posts for a text-only social post.
 * Only text from the exact, verified post may be passed in.
 *
 * @param {object} options
 * @param {string} options.platform Display name, e.g. "Threads".
 * @param {string} options.text
 * @param {string|null} [options.displayName]
 * @param {string|null} [options.handle]
 * @param {string|null} [options.avatarUrl]
 * @param {string} options.originalUrl
 * @param {string|number|Date|null} [options.originalDate]
 * @param {string|null} [options.sharedById]
 * @param {string|null} [options.memberComment]
 */
function buildTextPostMessage({
  platform,
  text,
  displayName,
  handle,
  avatarUrl,
  originalUrl,
  originalDate,
  sharedById,
  memberComment,
}) {
  const key = String(platform || "").toLowerCase();
  const safeHandle = String(handle || "").trim().replace(/^@+/, "");
  const name = String(displayName || "").trim();
  const authorName = name && safeHandle && name.toLowerCase() !== safeHandle.toLowerCase()
    ? `${name} (@${safeHandle})`
    : safeHandle ? `@${safeHandle}` : name;
  const postUrl = safeHttpsUrl(originalUrl);

  const embed = new EmbedBuilder()
    .setColor(PLATFORM_COLORS[key] ?? 0x5865f2)
    .setDescription(truncate(String(text || "").trim(), DESCRIPTION_LIMIT) || "\u200b")
    .setFooter({ text: `Text-only post from ${platform}` });
  if (authorName) {
    embed.setAuthor({
      name: truncate(authorName, AUTHOR_NAME_LIMIT),
      ...(safeHttpsUrl(avatarUrl) ? { iconURL: avatarUrl } : {}),
      ...(postUrl ? { url: postUrl } : {}),
    });
  }
  const date = validDate(originalDate);
  if (date) embed.setTimestamp(date);

  const sharedBy = sharedById ? `<@${sharedById}>` : "Unknown member";
  embed.addFields({ name: "\u200b", value: `Shared by ${sharedBy}` });
  if (memberComment) {
    embed.addFields({
      name: "💬 Comment",
      value: truncate(memberComment, FIELD_VALUE_LIMIT),
    });
  }

  const buttonUrl = buttonUrlForPlatform(platform, postUrl);
  const icon = platformIcon(key);
  return {
    content: icon ? `${icon} ${platform}` : platform,
    embeds: [embed],
    components: buttonUrl
      ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(`View on ${platform}`)
          .setStyle(ButtonStyle.Link)
          .setURL(buttonUrl)
      )]
      : [],
    allowedMentions: { parse: [] },
  };
}

module.exports = {
  buildTextPostMessage,
  PLATFORM_COLORS,
  DESCRIPTION_LIMIT,
};
