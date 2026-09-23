const PLATFORM_EMOJI = {
  facebook: { env: "HARMONY_HEART_FACEBOOK_ID", name: "harmony_heart_facebook", fallback: "💙" },
  instagram: { env: "HARMONY_HEART_INSTAGRAM_ID", name: "harmony_heart_instagram", fallback: "💛" },
  youtube: { env: "HARMONY_HEART_YOUTUBE_ID", name: "harmony_heart_youtube", fallback: "❤️" },
  threads: { env: "HARMONY_HEART_THREADS_ID", name: "harmony_heart_threads", fallback: "🤍" },
  tiktok: { env: "HARMONY_HEART_TIKTOK_ID", name: "harmony_heart_tiktok", fallback: "🩷" },
  x: { env: "HARMONY_HEART_X_ID", name: "harmony_heart_x", fallback: "🖤" },
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

function statusEmoji(kind) {
  const definition = STATUS_EMOJI[kind];
  return definition ? configuredEmoji(definition) : null;
}

module.exports = { PLATFORM_EMOJI, STATUS_EMOJI, platformHeart, statusEmoji };
