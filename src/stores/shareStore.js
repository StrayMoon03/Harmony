const { getDb } = require("../db/sqlite");

/**
 * @typedef {object} ShareRecord
 * @property {number} id
 * @property {string} platform
 * @property {string} media_id
 * @property {string|null} creator
 * @property {string} shared_by
 * @property {string|null} shared_by_id
 * @property {string} shared_at
 * @property {string|null} message_id
 * @property {string|null} channel_id
 * @property {string|null} guild_id
 * @property {string|null} url
 */

/**
 * @param {string} platform
 * @param {string} mediaId
 * @returns {ShareRecord|null}
 */
function find(platform, mediaId) {
  const row = getDb()
    .prepare(
      `SELECT * FROM shares WHERE platform = ? AND media_id = ? LIMIT 1`
    )
    .get(platform, mediaId);

  return row ?? null;
}

/**
 * @param {object} data
 * @param {string} data.platform
 * @param {string} data.mediaId
 * @param {string|null} [data.creator]
 * @param {string} data.sharedBy
 * @param {string|null} [data.sharedById]
 * @param {string|null} [data.messageId]
 * @param {string|null} [data.channelId]
 * @param {string|null} [data.guildId]
 * @param {string|null} [data.url]
 * @returns {{ ok: true, id: number } | { ok: false, reason: "duplicate" }}
 */
function insert(data) {
  const sharedAt = new Date().toISOString();

  try {
    const result = getDb()
      .prepare(
        `INSERT INTO shares (
          platform, media_id, creator, shared_by, shared_by_id,
          shared_at, message_id, channel_id, guild_id, url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.platform,
        data.mediaId,
        data.creator ?? null,
        data.sharedBy,
        data.sharedById ?? null,
        sharedAt,
        data.messageId ?? null,
        data.channelId ?? null,
        data.guildId ?? null,
        data.url ?? null
      );

    // node:sqlite returns { changes, lastInsertRowid } from StatementSync.run()
    const id = Number(result.lastInsertRowid);
    return { ok: true, id };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    // UNIQUE constraint race
    if (
      message.includes("UNIQUE constraint failed") ||
      (err && err.code === "ERR_SQLITE_ERROR" && message.includes("UNIQUE"))
    ) {
      return { ok: false, reason: "duplicate" };
    }
    throw err;
  }
}

/**
 * Removes one saved share so it can be shared again.
 *
 * @param {string} platform
 * @param {string} mediaId
 * @returns {boolean}
 */
function remove(platform, mediaId) {
  const result = getDb()
    .prepare(
      `DELETE FROM shares WHERE platform = ? AND media_id = ?`
    )
    .run(platform, mediaId);

  return Number(result.changes) > 0;
}

module.exports = {
  find,
  insert,
  remove,
};
