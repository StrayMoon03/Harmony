const { GatewayRateLimitError } = require("discord.js");
const roomStore = require("../stores/adminRoomStore");
const { getWelcomePassSettings } = require("../stores/welcomePassStore");
const {
  getMemberCountAccounting,
  recordMemberCountActivity,
} = require("../stores/memberCountStore");

const refreshTimers = new Map();
const refreshJobs = new Map();
const memberRequests = new Map();
const memberRetries = new Map();
const lastFullFetch = new WeakMap();
const FULL_FETCH_COOLDOWN_MS = 30_000;
const REFRESH_QUEUED_MESSAGE = "Refresh queued because Discord temporarily rate-limited the member-list request. Harmony will retry automatically.";
let periodicTimer = null;

function getMemberCountRoles(guild) {
  const accounting = getMemberCountAccounting(guild.id);
  const resolve = (id) => id && id !== guild.id && guild.roles.cache.has(id) ? id : null;
  return {
    stayRoleId: resolve(getWelcomePassSettings(guild.id)?.role_id),
    adminRoleId: resolve(accounting.admin_role_id),
    moderatorRoleId: resolve(accounting.moderator_role_id),
  };
}

function fetchMembers(guild, reconcile) {
  const retry = memberRetries.get(guild.id);
  if (retry) throw retry;
  const pending = memberRequests.get(guild.id);
  if (pending) return pending;

  const cache = guild.members.cache;
  const complete = guild.available !== false && Number.isInteger(guild.memberCount) &&
    cache?.size === guild.memberCount;
  const recentlyFetched = Date.now() - (lastFullFetch.get(guild) ?? -Infinity) < FULL_FETCH_COOLDOWN_MS;
  if (complete && (!reconcile || recentlyFetched)) return cache;

  const startedAt = Date.now();
  const request = guild.members.fetch().then((members) => {
    lastFullFetch.set(guild, startedAt);
    return members;
  }).catch((error) => {
    const retryAfter = error.data?.retry_after;
    if (error instanceof GatewayRateLimitError && error.data.opcode === 8 &&
        Number.isFinite(retryAfter) && retryAfter >= 0) {
      memberRetries.set(guild.id, error);
      clearTimeout(refreshTimers.get(guild.id));
      refreshTimers.delete(guild.id);
      const timer = setTimeout(() => {
        memberRetries.delete(guild.id);
        return runScheduledRefresh(guild, true);
      }, Math.max(1, Math.ceil(retryAfter * 1000)));
      timer.unref?.();
    }
    throw error;
  }).finally(() => memberRequests.delete(guild.id));
  memberRequests.set(guild.id, request);
  return request;
}

async function getMemberCounts(guild, { reconcile = false } = {}) {
  const members = await fetchMembers(guild, reconcile);
  const { stayRoleId, adminRoleId, moderatorRoleId } = getMemberCountRoles(guild);
  const roles = [adminRoleId, moderatorRoleId, stayRoleId];
  const ready = roles.every(Boolean) && new Set(roles).size === roles.length;
  const counts = {
    total: members.size,
    stay: stayRoleId ? 0 : null,
    bots: 0,
    admins: ready ? 0 : null,
    moderators: ready ? 0 : null,
    noRole: ready ? 0 : null,
  };

  for (const member of members.values()) {
    const hasStay = stayRoleId && member.roles.cache.has(stayRoleId);
    if (hasStay) counts.stay++;
    if (member.user.bot === true) {
      counts.bots++;
      continue;
    }

    if (!ready) continue;

    if (member.roles.cache.has(adminRoleId)) counts.admins++;
    else if (member.roles.cache.has(moderatorRoleId)) counts.moderators++;
    else if (!hasStay) counts.noRole++;
  }
  return counts;
}

function refreshMemberCounts(guild, { reconcile = true } = {}) {
  if (memberRetries.has(guild.id)) return Promise.resolve({ queued: true });
  if (!refreshJobs.has(guild.id)) {
    const job = updateMemberCounts(guild, reconcile).finally(() => refreshJobs.delete(guild.id));
    refreshJobs.set(guild.id, job);
  }
  return refreshJobs.get(guild.id);
}

async function updateMemberCounts(guild, reconcile) {
  if (!roomStore.getPanel(guild.id)?.enabled) return { privateRefreshed: false };
  let snapshot;
  try {
    snapshot = await getMemberCounts(guild, { reconcile });
  } catch (error) {
    if (memberRetries.get(guild.id) === error) return { queued: true };
    throw error;
  }

  // Resolve lazily because the Admin Room also uses this service.
  await require("./adminRoomService").refreshMemberCountDisplay(guild, snapshot);
  return { privateRefreshed: true };
}

function recordObservedHumanActivity(guildId, kind, now) {
  try {
    recordMemberCountActivity(guildId, kind, now);
  } catch (error) {
    console.error("Harmony could not save a member count event:", { guildId, kind, error });
  }
}

function observeMembershipChange(member, kind, now = new Date()) {
  if (!member.user.bot) recordObservedHumanActivity(member.guild.id, kind, now);
  scheduleMemberCountRefresh(member.guild);
}

function scheduleMemberCountRoleRefresh(oldMember, newMember) {
  const guild = newMember.guild;
  if (newMember.user.bot) {
    const stayRoleId = getWelcomePassSettings(guild.id)?.role_id;
    if (!stayRoleId || oldMember.roles.cache.has(stayRoleId) === newMember.roles.cache.has(stayRoleId)) return;
  }
  scheduleMemberCountRefresh(guild);
}

async function runScheduledRefresh(guild, reconcile) {
  try {
    // An event may have arrived after the active refresh took its snapshot.
    await refreshJobs.get(guild.id)?.catch(() => {});
    await refreshMemberCounts(guild, { reconcile });
  } catch (error) {
    console.error(`Could not refresh member counts in ${guild.name}:`, error);
  }
}

function scheduleMemberCountRefresh(guild, delayMs = 2500, { reconcile = false } = {}) {
  if (memberRetries.has(guild.id)) return;
  const existing = refreshTimers.get(guild.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    refreshTimers.delete(guild.id);
    return runScheduledRefresh(guild, reconcile);
  }, delayMs);
  timer.unref?.();
  refreshTimers.set(guild.id, timer);
}

async function refreshAllMemberCounts(client) {
  for (const { guild_id: guildId } of roomStore.getEnabledPanels()) {
    const guild = client.guilds.cache.get(guildId) ||
      (await client.guilds.fetch(guildId).catch(() => null));
    if (guild) scheduleMemberCountRefresh(guild, 0, { reconcile: true });
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
  REFRESH_QUEUED_MESSAGE,
  getMemberCounts,
  getMemberCountRoles,
  observeMembershipChange,
  recordObservedHumanActivity,
  refreshMemberCounts,
  scheduleMemberCountRefresh,
  scheduleMemberCountRoleRefresh,
  startMemberCountScheduler,
};
