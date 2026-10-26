const birthdayStore = require("../stores/birthdayStore");
const { linkWelcomePassCode } = require("../stores/welcomePassStore");

function normalizeName(value) {
  return String(value || "").trim().replace(/^@/, "").toLocaleLowerCase();
}

function memberNames(member) {
  const user = member?.user || {};
  return new Set([
    user.username,
    user.globalName,
    member?.displayName,
    user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : null,
  ].map(normalizeName).filter(Boolean));
}

function profileLabel(profile) {
  return profile.birthday_name || profile.discord_username || profile.welcome_pass_code;
}

function matchImportedBirthdayName(pending, importedName) {
  const target = normalizeName(importedName);
  if (!target) return [];
  return pending.filter((profile) => [profile.birthday_name, profile.discord_username, profile.welcome_pass_code]
    .some((value) => normalizeName(value) === target));
}

async function matchAllImportedBirthdays({ guild, guildId, store = birthdayStore, linkCode = linkWelcomePassCode }) {
  const pending = store.listUnlinkedWelcomePassBirthdayProfiles();
  const fetched = await guild?.members?.fetch?.().catch(() => null);
  if (!fetched) throw new Error("Harmony could not read the server member list. Confirm Server Members Intent is enabled.");
  const members = [...fetched.values()].filter((member) => !member.user?.bot);
  const result = { connected: 0, unresolved: [] };

  for (const profile of pending) {
    const target = normalizeName(profile.discord_username);
    const label = profileLabel(profile);
    if (!target) {
      result.unresolved.push({ name: label, reason: "missing Discord username" });
      continue;
    }
    const usernameMatches = members.filter((member) => normalizeName(member.user?.username) === target ||
      (member.user?.discriminator && member.user.discriminator !== "0" && normalizeName(`${member.user.username}#${member.user.discriminator}`) === target));
    const matches = usernameMatches.length ? usernameMatches : members.filter((member) => memberNames(member).has(target));
    if (matches.length !== 1) {
      result.unresolved.push({ name: label, reason: matches.length ? "more than one member has that name" : "no matching server member" });
      continue;
    }
    const linked = linkCode({ code: profile.welcome_pass_code, guildId, userId: matches[0].id });
    if (!linked.ok || !store.attachWelcomePassBirthdayProfile(profile.welcome_pass_code)) {
      result.unresolved.push({ name: label, reason: "Welcome Pass link conflict" });
    } else result.connected += 1;
  }
  return result;
}

function matchOneImportedBirthday({ guildId, importedName, memberId, store = birthdayStore, linkCode = linkWelcomePassCode }) {
  const pending = store.listUnlinkedWelcomePassBirthdayProfiles();
  const matches = matchImportedBirthdayName(pending, importedName);
  if (!matches.length) return { status: "not-found" };
  if (matches.length > 1) return { status: "ambiguous", matches };
  const profile = matches[0];
  const linked = linkCode({ code: profile.welcome_pass_code, guildId, userId: memberId });
  if (!linked.ok) return { status: "conflict", profile };
  if (!store.attachWelcomePassBirthdayProfile(profile.welcome_pass_code)) return { status: "attach-failed", profile };
  return { status: "connected", profile };
}

module.exports = { normalizeName, memberNames, matchImportedBirthdayName, matchAllImportedBirthdays, matchOneImportedBirthday };
