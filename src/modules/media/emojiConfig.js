const PLATFORM_EMOJI = {
  facebook: { env: "HARMONY_HEART_FACEBOOK_ID", name: "harmony_heart_facebook", fallback: "💙" },
  instagram: { env: "HARMONY_HEART_INSTAGRAM_ID", name: "harmony_heart_instagram", fallback: "💛" },
  youtube: { env: "HARMONY_HEART_YOUTUBE_ID", name: "harmony_heart_youtube", fallback: "❤️" },
  threads: { env: "HARMONY_HEART_THREADS_ID", name: "harmony_heart_threads", fallback: "🤍" },
  tiktok: { env: "HARMONY_HEART_TIKTOK_ID", name: "harmony_heart_tiktok", fallback: "🩷" },
  x: { env: "HARMONY_HEART_X_ID", name: "harmony_heart_x", fallback: "🖤" },
};

const PLATFORM_ICON_EMOJI = {
  facebook: { env: "HARMONY_PLATFORM_FACEBOOK_ID", name: "facebook" },
  instagram: { env: "HARMONY_PLATFORM_INSTAGRAM_ID", name: "instagram" },
  tiktok: { env: "HARMONY_PLATFORM_TIKTOK_ID", name: "tiktok" },
  threads: { env: "HARMONY_PLATFORM_THREADS_ID", name: "threads" },
  x: { env: "HARMONY_PLATFORM_X_ID", name: "xlogo" },
  youtube: { env: "HARMONY_PLATFORM_YOUTUBE_ID", name: "youtube" },
};

const STATUS_EMOJI = {
  working: { env: "HARMONY_WORKING_EMOJI_ID", name: "harmony_working" },
  failure: { env: "HARMONY_UHOH_EMOJI_ID", name: "harmony_uhoh" },
  thanks: { env: "HARMONY_THANK_YOU_EMOJI_ID", name: "harmony_thank_you" },
};

function configuredEmoji(definition) {
  const id = String(process.env[definition.env] || "").trim();
  return /^\d{15,22}$/.test(id) ? `<:${definition.name}:${id}>` : null;
}

function platformHeart(platform) {
  const definition = PLATFORM_EMOJI[platform];
  if (!definition) return "🤍";
  return configuredEmoji(definition) || definition.fallback;
}

function platformIcon(platform) {
  const definition = PLATFORM_ICON_EMOJI[String(platform || "").toLowerCase()];
  return definition ? configuredEmoji(definition) : null;
}

function statusEmoji(kind) {
  const definition = STATUS_EMOJI[kind];
  return definition ? configuredEmoji(definition) : null;
}

module.exports = {
  PLATFORM_EMOJI,
  PLATFORM_ICON_EMOJI,
  STATUS_EMOJI,
  platformHeart,
  platformIcon,
  statusEmoji,
};
