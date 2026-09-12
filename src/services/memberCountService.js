const {
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const {
  getMemberCountSettings,
  listEnabledMemberCountSettings,
  saveMemberCountSettings,
} = require("../stores/memberCountStore");

const refreshTimers = new Map();
let periodicTimer = null;

async function fetchChannel(guild, channelId) {
  if (!channelId) return null;
  return guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));
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

async function setupMemberCounts(guild, stayRole) {
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
    roleId: stayRole.id,
    categoryId: category.id,
    totalChannelId: totalChannel.id,
    stayChannelId: stayChannel.id,
    noRoleChannelId: noRoleChannel.id,
  });

  const counts = await refreshMemberCounts(guild);
  return { category, counts };
}

async function refreshMemberCounts(guild) {
  const settings = getMemberCountSettings(guild.id);
  if (!settings?.enabled) return null;

  const members = await guild.members.fetch();
  const humans = [...members.values()].filter((member) => !member.user.bot);
  const stayCount = humans.filter((member) =>
    member.roles.cache.has(settings.role_id)
  ).length;
  const counts = {
    total: humans.length,
    stay: stayCount,
    noRole: humans.length - stayCount,
  };

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
    `💜 Stay Role: ${counts.stay}`,
    `⚠️ No Stay Role: ${counts.noRole}`,
  ];
  await Promise.all(channels.map((channel, index) =>
    channel.name === names[index]
      ? Promise.resolve()
      : channel.setName(names[index], "Harmony member count refresh")
  ));

  return counts;
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
  for (const settings of listEnabledMemberCountSettings()) {
    const guild = client.guilds.cache.get(settings.guild_id) ||
      (await client.guilds.fetch(settings.guild_id).catch(() => null));
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
  refreshMemberCounts,
  scheduleMemberCountRefresh,
  startMemberCountScheduler,
};
