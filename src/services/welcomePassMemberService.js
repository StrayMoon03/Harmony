const { getMemberCountAccounting } = require("../stores/memberCountStore");
const { listWelcomePassSettings, getWelcomePassSettings, checkWelcomePassMember } = require("../stores/welcomePassStore");

async function welcomePassGuild(client) {
  const settings = listWelcomePassSettings();
  if (settings.length !== 1) throw new Error("welcome_pass_server_ambiguous");
  const guild = client.guilds.cache.get(settings[0].guild_id) || await client.guilds.fetch(settings[0].guild_id);
  if (!guild) throw new Error("welcome_pass_server_unavailable");
  return guild;
}
async function selectedMember(client, code, userId) {
  if (!/^\d{17,20}$/.test(userId || "")) return { ok: false, reason: "invalid_discord_member" };
  const guild = await welcomePassGuild(client);
  // A cached member is insufficient: they may have left since opening the picker.
  const member = await guild.members.fetch({ user: userId, force: true }).catch((error) => {
    if (error.code === 10007) return null;
    throw error;
  });
  if (!member || member.user.bot) return { ok: false, reason: "discord_member_unavailable" };
  const checked = checkWelcomePassMember({ code, guildId: guild.id, userId: member.id });
  return checked.ok ? { ok: true, guildId: guild.id, userId: member.id, username: member.user.username } : checked;
}
async function listMembers(client, after) {
  if (after && !/^\d{17,20}$/.test(after)) throw new Error("invalid_member_cursor");
  const guild = await welcomePassGuild(client);
  const roleId = getWelcomePassSettings(guild.id)?.role_id;
  // Fail closed if the authoritative Approved Role cannot be resolved. Never
  // substitute pass status, role names, or an unfiltered roster.
  if (!roleId || !await guild.roles.fetch(roleId)) throw new Error("welcome_pass_approved_role_unavailable");
  const accounting = getMemberCountAccounting(guild.id);
  const excludedRoleIds = [roleId, accounting.admin_role_id, accounting.moderator_role_id].filter(Boolean);
  // Normal picker eligibility only. Exact-ID selection/recovery deliberately
  // remains independent so a previous admission target can be reconciled.
  const page = await guild.members.list({ limit: 100, ...(after ? { after } : {}) });
  const all = [...page.values()];
  return { members: all.filter((member) => !member.user.bot && !excludedRoleIds.some((id) => member.roles.cache.has(id))).map((member) => ({
    id: member.id, username: member.user.username, displayName: member.displayName || member.user.globalName || member.user.username,
  })), after: all.length === 100 ? all.at(-1).id : null };
}
module.exports = { selectedMember, listMembers };
