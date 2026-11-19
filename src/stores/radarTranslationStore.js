const { getDb } = require("../db/sqlite");
const { hash } = require("./radarStore");
const { VERSION, normalize, translationInput } = require("../services/radarPresentation");
function identity(source) {
  const input = translationInput(source);
  return { sourceHash: hash([normalize(source.title), normalize(source.summary)]), inputHash: hash([VERSION, input]), input };
}
function get(source, provider) {
  const { sourceHash, inputHash } = identity(source);
  const row = getDb().prepare("SELECT * FROM radar_translations WHERE observation_id=? AND source_hash=? AND provider=?")
    .get(source.id, sourceHash, provider);
  return row?.input_hash === inputHash ? row : null;
}
function claim(source, provider, now, leaseMs) {
  const existing = get(source, provider);
  if (existing && (["ready", "skipped", "unavailable"].includes(existing.status) ||
      Date.parse(existing.next_retry_at) > now || Date.parse(existing.lease_until) > now)) return false;
  const { sourceHash, inputHash, input } = identity(source);
  const result = getDb().prepare(`INSERT INTO radar_translations(observation_id,source_hash,provider,input_hash,input_title,input_summary,status,lease_until,updated_at)
    VALUES(?,?,?,?,?,?,'pending',?,?) ON CONFLICT(observation_id,source_hash,provider) DO UPDATE SET
    input_hash=excluded.input_hash,input_title=excluded.input_title,input_summary=excluded.input_summary,status='pending',
    lease_until=excluded.lease_until,next_retry_at=NULL,error=NULL,updated_at=excluded.updated_at
    WHERE radar_translations.status!='pending' OR radar_translations.lease_until IS NULL OR radar_translations.lease_until<=excluded.updated_at`)
    .run(source.id, sourceHash, provider, inputHash, input.title, input.summary, new Date(now + leaseMs).toISOString(), new Date(now).toISOString());
  return result.changes > 0;
}
function reusable(source, provider) {
  const { inputHash } = identity(source);
  return getDb().prepare(`SELECT * FROM radar_translations WHERE observation_id=? AND provider=? AND input_hash=?
    AND status IN ('ready','skipped') ORDER BY updated_at DESC LIMIT 1`).get(source.id, provider, inputHash);
}
function save(source, provider, result, now = Date.now()) {
  const { sourceHash } = identity(source);
  getDb().prepare(`UPDATE radar_translations SET status=?, original_language=?, translated_title=?, translated_summary=?,
    error=?,next_retry_at=?,lease_until=NULL,updated_at=? WHERE observation_id=? AND source_hash=? AND provider=?`)
    .run(result.status, result.language || null, result.title || null, result.summary || null,
      result.error || null, result.retryAt ? new Date(result.retryAt).toISOString() : null, new Date(now).toISOString(), source.id, sourceHash, provider);
}
module.exports = { identity, get, claim, reusable, save };
