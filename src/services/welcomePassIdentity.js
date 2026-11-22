// Presentation normalization only: no fuzzy, prefix or punctuation matching.
function normalizeDiscordUsername(value) {
  return String(value || "").normalize("NFC").trim().replace(/^@/, "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\uFE0F\u200D\u20E3]/gu, "")
    .replace(/\s/gu, "").toLowerCase();
}
function matchingMembers(members, input) {
  const expected = normalizeDiscordUsername(input);
  if (!expected) return [];
  return [...members.values()].filter(member => !member.user.bot &&
    [member.user.username, member.user.globalName, member.displayName]
      .some(alias => normalizeDiscordUsername(alias) === expected));
}
module.exports = { normalizeDiscordUsername, matchingMembers };
