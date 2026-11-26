"use strict";
const crypto = require('node:crypto');
const { getDb } = require('../db/sqlite');
const store = require('../stores/concertCountdownStore'), events = require('../stores/eventSchedulerStore');
const service = require('./concertCountdownService');
const { validateConfig } = require('./concertCountdownModel');
const protocol = require('../../services/public-countdowns/protocol');
const jobs = new Map();
function settings(env = process.env) {
  const origin = new URL(env.COUNTDOWN_PUBLIC_ORIGIN || 'about:blank'), sync = new URL(env.COUNTDOWN_PUBLIC_SYNC_URL || 'about:blank');
  if(origin.protocol!=='https:' || origin.origin!==env.COUNTDOWN_PUBLIC_ORIGIN || origin.username || origin.password) throw Error('Public countdown hosting is not configured yet.');
  if(sync.protocol!=='http:' || !sync.hostname.endsWith('.railway.internal') || sync.username || sync.password || sync.pathname!=='/internal/sync' || sync.search || sync.hash) throw Error('A private countdown sync endpoint is required.');
  if((env.COUNTDOWN_PUBLIC_SYNC_SECRET || '').length<32) throw Error('Public countdown sharing is not configured yet.');
  return { origin:origin.origin, sync:sync.href, secret:env.COUNTDOWN_PUBLIC_SYNC_SECRET };
}
const get = (g,c) => getDb().prepare('SELECT * FROM concert_countdown_shares WHERE guild_id=? AND channel_id=?').get(g,c);
function projection(row) {
  if(!row || (!row.message_id && !row.published_at)) throw Error('Publish this countdown before sharing it.');
  const config = JSON.parse(row.config), selected = config.eventIds.map(id=>events.getEvent(row.guild_id,id)).filter(Boolean);
  validateConfig(config,selected);
  // save()/photo() clear the fingerprint until that revision is published.
  // Approved calendar reschedules may change dates without editing this revision.
  if(!row.last_success || !row.fingerprint) return null;
  const data = { city:config.city, country:config.country, venue:config.venue, timezone:config.timezone, dates:service.model(row,new Date(row.last_success)).panels.map(p=>p.date), photo:row.photo?Buffer.from(row.photo).toString('base64'):null };
  return protocol.validateData(data);
}
function ensure(g,c) {
  let share=get(g,c); if(share)return share;
  const row=store.get(g,c); if(!row || (!row.message_id && !row.published_at))throw Error('Publish this countdown before sharing it.');
  const config=JSON.parse(row.config), human=[config.city,config.venue].join('-').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70).replace(/-$/,'')||'concert';
  getDb().prepare('INSERT OR IGNORE INTO concert_countdown_shares(guild_id,channel_id,slug) VALUES(?,?,?)').run(g,c,human+'-'+crypto.randomBytes(6).toString('hex'));
  return get(g,c);
}
function toggle(g,c,enabled) {
  ensure(g,c); getDb().prepare('UPDATE concert_countdown_shares SET enabled=?,pending=1,sequence=sequence+1,last_error=NULL WHERE guild_id=? AND channel_id=?').run(enabled?1:0,g,c);
}
async function syncOne(g,c,{env=process.env,transport=fetch,now=new Date()}={}) {
  const config=settings(env), share=get(g,c); if(!share || (!share.enabled && !share.pending))return;
  let data=null, sourceError=null;
  if(share.enabled) {
    try { data=projection(store.get(g,c)); if(!data && !share.synced_hash)throw Error('Publish the latest reviewed changes before enabling public sharing.'); }
    catch(error) { sourceError=error.message; toggle(g,c,false); }
  }
  const current=get(g,c), seq=getDb().prepare('UPDATE concert_countdown_shares SET sequence=sequence+1 WHERE guild_id=? AND channel_id=? RETURNING sequence').get(g,c).sequence;
  const hash=data?protocol.hashData(data):current.synced_hash;
  const body={ operation:current.enabled?(data && hash!==current.synced_hash?'upsert':'renew'):'withdraw', slug:current.slug, seq };
  if(current.enabled){body.expires=now.getTime()+protocol.LEASE_MS;body.hash=hash;if(body.operation==='upsert')body.data=data;}
  const raw=JSON.stringify(body);
  let confirmed=false;
  try {
    const response=await transport(config.sync,{method:'POST',headers:protocol.sign(config.secret,raw,now.getTime()),body:raw,redirect:'error',signal:AbortSignal.timeout(10000)});
    if(response.body?.cancel)await response.body.cancel().catch(()=>{});
    if(!response.ok){if(response.status===409)getDb().prepare('UPDATE concert_countdown_shares SET synced_hash=NULL WHERE guild_id=? AND channel_id=? AND sequence=?').run(g,c,seq);throw Error('Public countdown sync was not confirmed.');}
    confirmed=true;
    getDb().prepare('UPDATE concert_countdown_shares SET pending=0,synced_hash=?,last_synced=?,last_error=? WHERE guild_id=? AND channel_id=? AND sequence=?').run(current.enabled?hash:null,now.toISOString(),sourceError,g,c,seq);
    if(sourceError)throw Error(sourceError);
  } catch(error) {
    const message=(sourceError ? sourceError + (!confirmed ? ' Public removal is not confirmed; the old page expires within 15 minutes without renewal.' : '') : null) || (current.enabled?'Public countdown sync was not confirmed. The page stays unavailable or expires within 15 minutes without renewal.':'Public removal is not confirmed yet. The old page expires within 15 minutes without renewal.');
    getDb().prepare('UPDATE concert_countdown_shares SET last_error=? WHERE guild_id=? AND channel_id=? AND sequence=?').run(message,g,c,seq);
    throw Error(message);
  }
}
function sync(g,c,options) {
  const key=g+':'+c, task=(jobs.get(key)||Promise.resolve()).catch(()=>{}).then(()=>syncOne(g,c,options));
  jobs.set(key,task);task.finally(()=>{if(jobs.get(key)===task)jobs.delete(key);}).catch(()=>{});return task;
}
async function enable(g,c,reviewHash,options={}) {
  settings(options.env); const data=projection(store.get(g,c));
  if(!data || protocol.hashData(data)!==reviewHash)throw Error('The published countdown changed. Review public sharing again.');
  toggle(g,c,true); await sync(g,c,options); return get(g,c);
}
async function disable(g,c,options={}) {
  toggle(g,c,false);
  try { await sync(g,c,options); }
  catch { const message='Public removal is not confirmed yet. The old page expires within 15 minutes without renewal.';getDb().prepare('UPDATE concert_countdown_shares SET last_error=? WHERE guild_id=? AND channel_id=?').run(message,g,c);throw Error(message); }
  return get(g,c);
}
function start({env=process.env,transport=fetch}={}) {
  try{settings(env);}catch{return()=>{};}
  let busy=false,stopped=false,debounce;
  const run=async()=>{if(busy||stopped)return;busy=true;try{for(const row of getDb().prepare('SELECT guild_id,channel_id FROM concert_countdown_shares WHERE enabled=1 OR pending=1').all()){await sync(row.guild_id,row.channel_id,{env,transport}).catch(()=>{});await new Promise(r=>setImmediate(r));}}finally{busy=false;}};
  const unsubscribe=store.subscribe(()=>{clearTimeout(debounce);debounce=setTimeout(()=>void run(),1000);debounce.unref?.();});
  void run();const timer=setInterval(()=>void run(),5*60000);timer.unref?.();
  return()=>{stopped=true;unsubscribe();clearTimeout(debounce);clearInterval(timer);};
}
module.exports={settings,get,ensure,projection,enable,disable,sync,start};
