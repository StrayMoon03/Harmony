const {
  claimWelcomePassSubmissionAlert,
  getWelcomePassSubmissionAlert,
  listWelcomePassSettings,
  markWelcomePassSubmissionAlertDelivered,
} = require("../stores/welcomePassStore");

function normalizeDiscordUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLocaleLowerCase();
}

function safeDiscordText(value, maxLength) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength)
    .replaceAll("`", "ˋ");
}

function formatSubmittedTimestamp(value) {
  const seconds = Math.floor(Date.parse(value) / 1000);
  return `<t:${seconds}:F>`;
}

async function findExactMember(guild, discordUsername) {
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return null;
  const expected = normalizeDiscordUsername(discordUsername);
  const matches = [...members.values()].filter((member) =>
    !member.user.bot && normalizeDiscordUsername(member.user.username) === expected
  );
  return matches.length === 1 ? matches[0] : null;
}

async function sendWelcomePassSubmissionAlert(client, submission) {
  const configured = listWelcomePassSettings().filter((item) => item.channel_id);
  if (configured.length !== 1) {
    return { status: configured.length ? "review_room_ambiguous" : "review_room_unconfigured" };
  }

  const settings = configured[0];
  const guild = client.guilds.cache.get(settings.guild_id) ||
    await client.guilds.fetch(settings.guild_id).catch(() => null);
  if (!guild) return { status: "guild_unavailable" };

  const channel = guild.channels.cache.get(settings.channel_id) ||
    await guild.channels.fetch(settings.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return { status: "review_room_unavailable" };

  // Claim before contacting Discord. The unique reference key makes callback
  // retries and concurrent deliveries at-most-once, including ambiguous send
  // outcomes where Discord may have accepted a message before the connection
  // failed.
  if (!claimWelcomePassSubmissionAlert(submission.reference)) {
    return {
      status: getWelcomePassSubmissionAlert(submission.reference)?.delivered_at
        ? "already_notified"
        : "already_attempted",
    };
  }

  const member = await findExactMember(guild, submission.discordUsername);
  const username = safeDiscordText(submission.discordUsername, 80);
  const facebookName = safeDiscordText(submission.facebookName, 100);
  const memberLine = member ? `<@${member.id}>` : `@${username}`;
  const content = [
    "📌 **Welcome Pass Ready for Review!**",
    "",
    memberLine,
    `**Facebook:** ${facebookName}`,
    `**Submitted:** ${formatSubmittedTimestamp(submission.submittedAt)}`,
    "",
    "A new member is waiting at the door. Please review their Welcome Pass in the admin dashboard. 💜",
  ].join("\n");

  try {
    const sent = await channel.send({
      content,
      allowedMentions: member ? { users: [member.id] } : { parse: [] },
    });
    markWelcomePassSubmissionAlertDelivered(submission.reference, sent?.id || null);
    return { status: "notified" };
  } catch {
    // Do not log Discord's raw error or retry an ambiguous delivery. The app's
    // authoritative Firestore submission remains successful and can be
    // reviewed in its dashboard.
    console.error("Could not deliver a Welcome Pass submission alert to the configured review room.");
    return { status: "delivery_failed" };
  }
}

module.exports = {
  normalizeDiscordUsername,
  safeDiscordText,
  formatSubmittedTimestamp,
  sendWelcomePassSubmissionAlert,
};
