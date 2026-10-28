const { PermissionFlagsBits } = require("discord.js");

function isGuildAdmin({ guild, memberPermissions, member, userId } = {}) {
  const ownerId = guild?.ownerId || guild?.ownerID || guild?.owner?.id || null;
  if (ownerId && userId && ownerId === userId) return true;
  const permissions = memberPermissions || member?.permissions;
  return Boolean(
    permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
    permissions?.has?.(PermissionFlagsBits.Administrator)
  );
}

function isAdminRoomAuthorized(interaction) {
  return isGuildAdmin({
    guild: interaction?.guild,
    memberPermissions: interaction?.memberPermissions,
    member: interaction?.member,
    userId: interaction?.user?.id,
  });
}

module.exports = { isGuildAdmin, isAdminRoomAuthorized };
