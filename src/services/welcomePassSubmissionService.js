const {
  claimWelcomePassSubmissionAlert,
  getWelcomePassSubmissionAlert,
  listWelcomePassSettings,
  markWelcomePassSubmissionAlertDelivered,
  getWelcomePassLink,
  preserveWelcomePassIdentity,
} = require("../stores/welcomePassStore");
const { normalizeDiscordUsername, matchingMembers } = require("./welcomePassIdentity");

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

async function findUniqueMember(guild, discordUsername) {
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return null;
  const matches = matchingMembers(members, discordUsername);
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

  // Recover the durable ID on callbacks/restarts; never resolve a new name in
  // place of a previously linked account, including after username changes.
  const linked = getWelcomePassLink(submission.reference);
  let member = linked?.guild_id === guild.id
    ? await guild.members.fetch({ user: linked.user_id, force: true }).catch(() => null) : null;
  if (member?.user.bot || (member && member.id !== linked.user_id)) member = null;
  let discordMember = member ? { id: member.id, username: member.user.username, guildId: guild.id } : null;

  // Claim before contacting Discord. The unique reference key makes callback
  // retries and concurrent deliveries at-most-once, including ambiguous send
  // outcomes where Discord may have accepted a message before the connection
  // failed.
  if (!claimWelcomePassSubmissionAlert(submission.reference)) {
    return {
      status: getWelcomePassSubmissionAlert(submission.reference)?.delivered_at
        ? "already_notified"
        : "already_attempted",
      ...(discordMember ? { discordMember } : {}),
    };
  }

  if (!linked) {
    member = await findUniqueMember(guild, submission.discordUsername);
    if (member) {
      const preserved = preserveWelcomePassIdentity({ code: submission.reference, guildId: guild.id, userId: member.id });
      if (preserved.ok) discordMember = { id: member.id, username: member.user.username, guildId: guild.id };
      else member = null;
    }
  }
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
    return { status: "notified", ...(discordMember ? { discordMember } : {}) };
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
