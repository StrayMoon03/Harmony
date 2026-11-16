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
const setupJobs = new Map();
const PUBLIC_COUNTERS = [
  { key: "total_channel_id", name: "👥 Total Members", match: /^(?:👥\s*)?Total Members:\s*(?:\d+|…)$/iu },
  { key: "stay_channel_id", name: "💜 Stay Role", match: /^(?:💜\s*)?Stay Role:\s*(?:\d+|…)$/iu },
  { key: "no_role_channel_id", name: "⚠️ No Stay Role", match: /^(?:⚠️?\s*)?No Stay Role:\s*(?:\d+|…)$/iu },
];
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

function setupMemberCounts(guild) {
  if (!setupJobs.has(guild.id)) {
    const setup = configurePublicCounters(guild).finally(() => setupJobs.delete(guild.id));
    setupJobs.set(guild.id, setup);
  }
  return setupJobs.get(guild.id);
}

function ambiguousPublicCounters() {
  return Object.assign(new Error("Harmony found ambiguous SERVER STATS channels. Setup stopped before creating counters."), {
    code: "AMBIGUOUS_SERVER_STATS",
  });
}

async function configurePublicCounters(guild) {
  const { stayRoleId } = getMemberCountRoles(guild);
  if (!stayRoleId) throw new Error("Set the Approved Role in Welcome Pass before setting up SERVER STATS.");
  const current = getMemberCountSettings(guild.id);
  const savedCategory = await fetchChannel(guild, current?.category_id);
  const available = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const matchingCategories = available.filter((channel) =>
    channel.type === ChannelType.GuildCategory && /^(?:📊\s*)?SERVER STATS$/iu.test(channel.name.trim()));
  if (savedCategory?.type !== ChannelType.GuildCategory && matchingCategories.length > 1) {
    throw ambiguousPublicCounters();
  }
  let category = savedCategory?.type === ChannelType.GuildCategory ? savedCategory : matchingCategories[0];
  const children = category ? available.filter((channel) =>
    channel.type === ChannelType.GuildVoice && channel.parentId === category.id
  ) : [];
  const counters = await Promise.all(PUBLIC_COUNTERS.map(async (counter) => {
    const saved = await fetchChannel(guild, current?.[counter.key]);
    if (saved?.type === ChannelType.GuildVoice) return saved;
    const matches = children.filter((channel) => counter.match.test(channel.name.trim()));
    if (matches.length > 1) throw ambiguousPublicCounters();
    return matches[0];
  }));
  if (category && category.id !== savedCategory?.id && counters.some((channel) => !channel) &&
      children.some((channel) => !PUBLIC_COUNTERS.some((counter) => counter.match.test(channel.name.trim())))) {
    throw ambiguousPublicCounters();
  }
  category ||= await guild.channels.create({
    name: "📊 SERVER STATS",
    type: ChannelType.GuildCategory,
    reason: "Harmony live member counts",
  });
  for (const [index, counter] of PUBLIC_COUNTERS.entries()) {
    counters[index] ||= await createCounterChannel(guild, category, `${counter.name}: …`);
  }
  const [totalChannel, stayChannel, noRoleChannel] = counters;

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
