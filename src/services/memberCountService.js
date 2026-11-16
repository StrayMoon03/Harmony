const {
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const roomStore = require("../stores/adminRoomStore");
const { getWelcomePassSettings } = require("../stores/welcomePassStore");
const {
  getMemberCountSettings,
  getMemberCountAccounting,
  listEnabledMemberCountSettings,
  saveMemberCountSettings,
  recordMemberCountActivity,
} = require("../stores/memberCountStore");

const refreshTimers = new Map();
let periodicTimer = null;

async function fetchChannel(guild, channelId) {
  if (!channelId) return null;
  return guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch((error) => {
      if (error.code === 10003) return null;
      throw error;
    }));
}

async function createCounterChannel(guild, parent, name) {
  return guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: parent.id,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
      },
    ],
    reason: "Harmony live member counts",
  });
}

function getMemberCountRoles(guild) {
  const accounting = getMemberCountAccounting(guild.id);
  const resolve = (id) => id && id !== guild.id && guild.roles.cache.has(id) ? id : null;
  return {
    stayRoleId: resolve(getWelcomePassSettings(guild.id)?.role_id),
    adminRoleId: resolve(accounting.admin_role_id),
    moderatorRoleId: resolve(accounting.moderator_role_id),
    excludeStaff: Boolean(accounting.exclude_staff),
  };
}

async function setupMemberCounts(guild) {
  const { stayRoleId } = getMemberCountRoles(guild);
  if (!stayRoleId) throw new Error("Set the Approved Role in Welcome Pass before setting up SERVER STATS.");
  const current = getMemberCountSettings(guild.id);
  let category = await fetchChannel(guild, current?.category_id);
  if (!category || category.type !== ChannelType.GuildCategory) {
    category = await guild.channels.create({
      name: "📊 SERVER STATS",
      type: ChannelType.GuildCategory,
      reason: "Harmony live member counts",
    });
  }

  const totalChannel =
    await fetchChannel(guild, current?.total_channel_id) ||
    await createCounterChannel(guild, category, "👥 Total Members: …");
  const stayChannel =
    await fetchChannel(guild, current?.stay_channel_id) ||
    await createCounterChannel(guild, category, "💜 Stay Role: …");
  const noRoleChannel =
    await fetchChannel(guild, current?.no_role_channel_id) ||
    await createCounterChannel(guild, category, "⚠️ No Stay Role: …");

  for (const channel of [totalChannel, stayChannel, noRoleChannel]) {
    if (channel.parentId !== category.id) {
      await channel.setParent(category, { lockPermissions: false });
    }
  }
  await category.setPosition(0).catch((error) => {
    console.warn("Harmony could not move Server Stats to the top:", error);
  });

  saveMemberCountSettings({
    guildId: guild.id,
    roleId: stayRoleId,
    categoryId: category.id,
    totalChannelId: totalChannel.id,
    stayChannelId: stayChannel.id,
    noRoleChannelId: noRoleChannel.id,
  });

  const counts = await refreshMemberCounts(guild);
  return { category, counts, stayRoleId };
}

async function getMemberCounts(guild) {
  const { stayRoleId, adminRoleId, moderatorRoleId, excludeStaff } = getMemberCountRoles(guild);
  const roles = [adminRoleId, moderatorRoleId, stayRoleId];
  const ready = roles.every(Boolean) && new Set(roles).size === roles.length;
  const privateCounts = ready ? { stay: 0, admins: 0, moderators: 0, noRole: 0 } : null;

  let total = 0;
  let stayHolders = 0;
  const members = await guild.members.fetch();
  for (const member of members.values()) {
    if (member.user.bot) continue;
    total++;
    const hasStay = stayRoleId && member.roles.cache.has(stayRoleId);
    if (hasStay) stayHolders++;
    if (!privateCounts) continue;

    const isAdmin = member.roles.cache.has(adminRoleId);
    const isModerator = member.roles.cache.has(moderatorRoleId);
    if (isAdmin) privateCounts.admins++;
    if (isModerator && (!excludeStaff || !isAdmin)) privateCounts.moderators++;
    if (hasStay && (!excludeStaff || (!isAdmin && !isModerator))) privateCounts.stay++;
    if (!isAdmin && !isModerator && !hasStay) privateCounts.noRole++;
  }
  return {
    total,
    publicStay: stayRoleId ? stayHolders : null,
    publicNoStay: stayRoleId ? total - stayHolders : null,
    privateCounts,
    excludeStaff,
  };
}

async function refreshMemberCounts(guild) {
  const settings = getMemberCountSettings(guild.id);
  const panel = roomStore.getPanel(guild.id);
  if (!settings?.enabled && !panel?.enabled) return null;
  // Resolve lazily because the Admin Room also uses this service for its Member Counts controls.
  const snapshot = panel?.enabled
    ? await require("./adminRoomService").refreshMemberCountDisplay(guild)
    : await getMemberCounts(guild);
  if (!settings?.enabled) return null;
  const { total, publicStay: stay, publicNoStay: noRole } = snapshot;
  const counts = { total, stay, noRole };
  const channels = await Promise.all([
    fetchChannel(guild, settings.total_channel_id),
    fetchChannel(guild, settings.stay_channel_id),
    fetchChannel(guild, settings.no_role_channel_id),
  ]);
  if (channels.some((channel) => !channel)) {
    throw new Error("One or more Server Stats channels are missing. Run setup again.");
  }

  const names = [
    `👥 Total Members: ${counts.total}`,
    counts.stay === null ? null : `💜 Stay Role: ${counts.stay}`,
    counts.noRole === null ? null : `⚠️ No Stay Role: ${counts.noRole}`,
  ];
  await Promise.all(channels.map((channel, index) =>
    names[index] === null || channel.name === names[index]
      ? Promise.resolve()
      : channel.setName(names[index], "Harmony member count refresh")
  ));

  return counts;
}

function observeMembershipChange(member, kind, now = new Date()) {
  if (!member.user.bot) {
    try {
      recordMemberCountActivity(member.guild.id, kind, now);
    } catch (error) {
      console.error("Harmony could not save a member count event:", error);
    }
  }
  scheduleMemberCountRefresh(member.guild);
}

function scheduleMemberCountRefresh(guild, delayMs = 2500) {
  const existing = refreshTimers.get(guild.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    refreshTimers.delete(guild.id);
    try {
      await refreshMemberCounts(guild);
    } catch (error) {
      console.error(`Could not refresh member counts in ${guild.name}:`, error);
    }
  }, delayMs);
  timer.unref?.();
  refreshTimers.set(guild.id, timer);
}

async function refreshAllMemberCounts(client) {
  const guildIds = new Set([
    ...listEnabledMemberCountSettings().map((settings) => settings.guild_id),
    ...roomStore.getEnabledPanels().map((panel) => panel.guild_id),
  ]);
  for (const guildId of guildIds) {
    const guild = client.guilds.cache.get(guildId) ||
      (await client.guilds.fetch(guildId).catch(() => null));
    if (guild) scheduleMemberCountRefresh(guild, 0);
  }
}

function startMemberCountScheduler(client) {
  refreshAllMemberCounts(client).catch((error) => {
    console.error("Initial member count refresh failed:", error);
  });
  if (periodicTimer) return;
  periodicTimer = setInterval(() => {
    refreshAllMemberCounts(client).catch((error) => {
      console.error("Periodic member count refresh failed:", error);
    });
  }, 10 * 60 * 1000);
  periodicTimer.unref?.();
}

module.exports = {
  setupMemberCounts,
  getMemberCounts,
  getMemberCountRoles,
  observeMembershipChange,
  refreshMemberCounts,
  scheduleMemberCountRefresh,
  startMemberCountScheduler,
};
