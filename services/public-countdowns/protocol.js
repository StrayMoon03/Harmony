"use strict";
const crypto = require('node:crypto');
const { localDate, dayIndex, buildCountdown } = require('../../src/services/concertCountdownModel');
const SLUG = /^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{12}$/;
const LEASE_MS = 15 * 60000, MAX_BODY = 6 * 1024 * 1024;
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error('Invalid public fields');
}
function validateData(data) {
  exact(data, ['city', 'country', 'venue', 'timezone', 'dates', 'photo']);
  for (const [key, max] of [['city',80],['country',80],['venue',120],['timezone',80]]) {
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > max || /[\x00-\x1f]/.test(data[key])) throw Error('Invalid ' + key);
  }
  localDate(new Date(), data.timezone);
  if (!Array.isArray(data.dates) || !data.dates.length || data.dates.length > 12 || new Set(data.dates).size !== data.dates.length) throw Error('Invalid concert dates');
  data.dates.forEach(dayIndex);
  if (data.photo !== null && (typeof data.photo !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.photo) || Buffer.from(data.photo, 'base64').length > 4 * 1024 * 1024)) throw Error('Invalid photograph');
  return { city: data.city, country: data.country, venue: data.venue, timezone: data.timezone, dates: [...data.dates].sort(), photo: data.photo };
}
const hashData = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
function publicModel(data, now = new Date()) {
  const events = data.dates.map((date, n) => ({ id:n, guild_id:'public', calendar_type:'stray_kids', category:'concert', all_day:1, event_date:date }));
  return buildCountdown({ guildId:'public', city:data.city, venue:data.venue, timezone:data.timezone, eventIds:events.map(e=>e.id) }, events, now);
}
function sign(secret, body, timestamp = Date.now(), nonce = crypto.randomBytes(16).toString('hex')) {
  return { 'content-type':'application/json', 'x-countdown-time':String(timestamp), 'x-countdown-nonce':nonce,
    'x-countdown-signature':crypto.createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${body}`).digest('hex') };
}
function verify(secret, body, headers, now, seen) {
  const t = headers['x-countdown-time'], nonce = headers['x-countdown-nonce'], signature = headers['x-countdown-signature'];
  if (!/^\d{13}$/.test(t || '') || Math.abs(now - Number(t)) > 60000 || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = sign(secret, body, Number(t), nonce)['x-countdown-signature'];
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  for (const [key, expires] of seen) if (expires < now) seen.delete(key);
  if (seen.has(nonce) || seen.size >= 5000) return false;
  seen.set(nonce, now + 120000); return true;
}
module.exports = { SLUG, LEASE_MS, MAX_BODY, exact, validateData, hashData, publicModel, sign, verify };
