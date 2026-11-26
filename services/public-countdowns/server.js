"use strict";
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { nextMidnight, localDate } = require('../../src/services/concertCountdownModel');
const images = require('../../src/services/concertCountdownRender');
const thumbnail = require('./venue');
const protocol = require('./protocol'), { page, CSS, SCRIPT } = require('./page');
async function createService({ directory, origin, secret, clock = () => new Date(), renderer = images, perPeer = 600, globalLimit = 2400 }) {
  if(![perPeer,globalLimit].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=10000))throw Error('Bounded positive request limits are required');
  if (typeof secret !== 'string' || secret.length < 32) throw Error('A strong private sync secret is required');
  const canonical = new URL(origin); if (canonical.protocol !== 'https:' || canonical.origin !== origin || canonical.username || canonical.password) throw Error('Use a canonical HTTPS public origin');
  const root = path.resolve(directory), entries = new Map(), queues = new Map(), seen = new Map(), buckets = new Map(), cache = new Map();
  let timer, refreshing, busy = false, stopped = false, cacheBytes = 0, activePublic = 0;
  await fs.mkdir(root, { recursive:true, mode:0o700 });
  const filename = (slug, name) => path.join(root, slug, name);
  async function atomic(file, bytes) { const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'; await fs.writeFile(temp, bytes, { mode:0o600 }); await fs.rename(temp, file); }
  async function save(entry) { await fs.mkdir(path.join(root,entry.slug), { recursive:true, mode:0o700 }); await atomic(filename(entry.slug,'manifest.json'), JSON.stringify(entry)); entries.set(entry.slug, entry); cache.clear(); cacheBytes=0; }
  const queue = (slug, fn) => {
    const task = (queues.get(slug) || Promise.resolve()).catch(()=>{}).then(fn);
    queues.set(slug,task); task.finally(()=>{ if(queues.get(slug)===task) queues.delete(slug); }).catch(()=>{}); return task;
  };
  for (const dir of await fs.readdir(root, { withFileTypes:true })) {
    if (!dir.isDirectory() || !protocol.SLUG.test(dir.name)) continue;
    try {
      const e = JSON.parse(await fs.readFile(filename(dir.name,'manifest.json'),'utf8'));
      if (e.slug!==dir.name || !Number.isSafeInteger(e.seq) || !/^[a-f0-9]{64}$/.test(e.hash || '') && e.enabled) continue;
      if (e.enabled) {
        protocol.validateData({ ...e.data, photo:null });
        const source=e.photoPresent ? await fs.readFile(filename(e.slug,e.hash+'.source')).catch(()=>null) : null;
        if(e.photoPresent && !source) e.enabled=false; // Publisher will repair via authenticated full upsert.
        else if(e.expires>clock().getTime()) {
          const files=[e.hash+'.venue',`graph-${e.hash}-${e.day}.png`];
          const present=await Promise.all(files.map(file=>fs.access(filename(e.slug,file)).then(()=>true,()=>false)));
          if(present.some(value=>!value)) {
            try { Object.assign(e,await prepare(e.slug,{...e.data,photo:source?source.toString('base64'):null},e.hash,clock())); await save(e); }
            catch {e.enabled=false;}
          }
        }
      }
      entries.set(e.slug,e);
    } catch { /* A malformed projection is never exposed. */ }
  }
  async function prepare(slug, data, hash, now) {
    const photo = data.photo ? Buffer.from(data.photo,'base64') : null;
    const graph = await renderer.render(protocol.publicModel(data,now), photo ? { bytes:photo, type:'jpeg' } : null);
    const venue = photo ? await thumbnail((await renderer.validatePhoto(photo)).bytes) : await fs.readFile(path.join(__dirname,'fallback.png'));
    await fs.mkdir(path.join(root,slug), { recursive:true, mode:0o700 });
    const day = localDate(now,data.timezone);
    if (photo) await atomic(filename(slug,hash+'.source'),photo);
    await atomic(filename(slug,hash+'.venue'),venue);
    await atomic(filename(slug,`graph-${hash}-${day}.png`),graph);
    return { day, photoPresent:Boolean(photo), venueType:photo?'image/jpeg':'image/png' };
  }
  async function apply(body) {
    protocol.exact(body,['operation','slug','seq','expires','hash','data']);
    if (!protocol.SLUG.test(body.slug || '') || !Number.isSafeInteger(body.seq) || body.seq<1 || !['upsert','renew','withdraw'].includes(body.operation)) throw Object.assign(Error('Invalid request'),{status:400});
    return queue(body.slug, async()=>{
      const old = entries.get(body.slug), now = clock();
      if (old && body.seq<=old.seq) throw Object.assign(Error('Outdated projection'),{status:409});
      if (body.operation==='withdraw') {
        await save({ slug:body.slug, seq:body.seq, enabled:false });
        for (const file of await fs.readdir(path.join(root,body.slug))) if(file!=='manifest.json') await fs.unlink(filename(body.slug,file)).catch(()=>{});
        arm(); return;
      }
      if (!Number.isFinite(body.expires) || body.expires<=now.getTime() || body.expires>now.getTime()+20*60000 || !/^[a-f0-9]{64}$/.test(body.hash || '')) throw Object.assign(Error('Invalid public lease'),{status:400});
      if (body.operation==='renew') {
        if(!old?.enabled || old.hash!==body.hash || body.data!==undefined) throw Object.assign(Error('Projection required'),{status:409});
        await save({ ...old, seq:body.seq, expires:body.expires }); arm(); return;
      }
      if(!old && entries.size>=500) throw Object.assign(Error('Projection capacity reached'),{status:503});
      const data = protocol.validateData(body.data); if(protocol.hashData(data)!==body.hash) throw Object.assign(Error('Invalid projection hash'),{status:400});
      const prepared = await prepare(body.slug,data,body.hash,now);
      const safeData = { ...data }; delete safeData.photo;
      await save({ slug:body.slug, seq:body.seq, enabled:true, expires:body.expires, hash:body.hash, data:safeData, ...prepared }); arm();
    });
  }
  async function renderDue() {
    if (stopped) return; busy=true;
    try {
      for (const e of [...entries.values()]) {
        const now=clock(); if(!e.enabled || e.expires<=now.getTime() || e.day===localDate(now,e.data.timezone)) continue;
        await queue(e.slug,async()=>{
          const latest=entries.get(e.slug), at=clock(); if(!latest.enabled || latest.expires<=at.getTime()) return;
          const photo=latest.photoPresent ? await fs.readFile(filename(e.slug,latest.hash+'.source')) : null;
          const graph=await renderer.render(protocol.publicModel(latest.data,at),photo?{bytes:photo,type:'jpeg'}:null), day=localDate(at,latest.data.timezone);
          await atomic(filename(e.slug,`graph-${latest.hash}-${day}.png`),graph); await save({...latest,day,renderRetryAt:null});
          for(const file of await fs.readdir(path.join(root,e.slug))) if(file.startsWith('graph-') && file!==`graph-${latest.hash}-${day}.png`) await fs.unlink(filename(e.slug,file)).catch(()=>{});
        }).catch(async()=>{const latest=entries.get(e.slug);if(latest?.enabled)await save({...latest,renderRetryAt:clock().getTime()+30000}).catch(()=>{});});
      }
    } finally { busy=false; arm(); }
  }
  function refresh() {
    if(refreshing)return refreshing;
    refreshing=renderDue().finally(()=>{refreshing=null;});return refreshing;
  }
  function arm() {
    if(busy || stopped) return; clearTimeout(timer); const now=clock(); let due;
    for(const e of entries.values()) if(e.enabled && e.expires>now.getTime()) {
      const next=e.day!==localDate(now,e.data.timezone)?new Date(Math.max(now.getTime()+1,e.renderRetryAt||0)):nextMidnight(now,e.data.timezone);
      if(!due || next<due) due=next;
    }
    if(due) { timer=setTimeout(()=>void refresh(),Math.max(1,due-now)); timer.unref?.(); }
  }
  function allowed(key) {
    const now=clock().getTime(); for(const [k,b] of buckets) if(b.until<=now) buckets.delete(k);
    if(buckets.size>=5000 && !buckets.has(key)) return false;
    const b=buckets.get(key)||{count:0,until:now+60000}; b.count++; buckets.set(key,b); return b.count<=(key==='*'?globalLimit:perPeer);
  }
  function send(req,res,status,body,type='text/plain; charset=utf-8') {
    let bytes=Buffer.isBuffer(body)?body:Buffer.from(body); const headers={'Content-Type':type,'Cache-Control':'no-cache, max-age=0, must-revalidate','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex','Content-Security-Policy':"default-src 'none'; img-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'Vary':'Accept-Encoding'};
    if(status===200 && /text|javascript/.test(type)) { const enc=req.headers['accept-encoding']||''; if(/\bgzip\b/.test(enc)){bytes=zlib.gzipSync(bytes);headers['Content-Encoding']='gzip';}else if(/\bdeflate\b/.test(enc)){bytes=zlib.deflateSync(bytes);headers['Content-Encoding']='deflate';} }
    if(status===200) { headers.ETag='"'+crypto.createHash('sha256').update(bytes).digest('hex')+'"'; if(req.headers['if-none-match']===headers.ETag){res.writeHead(304,headers);res.end();return;} }
    if(status===429) headers['Retry-After']='60'; if(status===503) headers['Retry-After']='5';
    res.writeHead(status,{...headers,'Content-Length':bytes.length}); res.end(req.method==='HEAD'?undefined:bytes);
  }
  async function cached(key,file) {
    if(cache.has(key)) {const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}
    const bytes=await fs.readFile(file); if(cache.has(key))return cache.get(key); while(cacheBytes+bytes.length>32*1024*1024 && cache.size){const first=cache.keys().next().value;cacheBytes-=cache.get(first).length;cache.delete(first);} if(bytes.length<=32*1024*1024){cache.set(key,bytes);cacheBytes+=bytes.length;} return bytes;
  }
  const publicServer=http.createServer(async(req,res)=>{
    if(activePublic>=16)return send(req,res,503,'Please try again shortly.');
    activePublic++;
    let released=false;const release=()=>{if(!released){released=true;activePublic--;}};res.once('finish',release);res.once('close',release);
    try {
      if(!allowed('*') || !allowed(req.socket.remoteAddress||'unknown')) return send(req,res,429,'Please try again shortly.');
      if(!['GET','HEAD'].includes(req.method)) return send(req,res,405,'Read-only endpoint.');
      if((req.url||'').length>2048) return send(req,res,414,'Not found.');
      const url=new URL(req.url,'http://local');
      if(url.pathname==='/health') return send(req,res,200,'ok');
      if(url.pathname==='/countdown.css') return send(req,res,200,CSS,'text/css; charset=utf-8');
      if(url.pathname==='/countdown.js') return send(req,res,200,SCRIPT,'application/javascript; charset=utf-8');
      const match=url.pathname.match(/^\/countdowns\/([^/]+)(?:\/(countdown\.png|venue\.jpg))?$/);
      if(!match || !protocol.SLUG.test(match[1])) return send(req,res,404,'Countdown unavailable.');
      const e=entries.get(match[1]), now=clock();
      if(!e?.enabled || e.expires<=now.getTime()) return send(req,res,404,'Countdown unavailable.');
      if(!match[2]) return send(req,res,200,page(e,origin,now),'text/html; charset=utf-8');
      if(match[2]==='venue.jpg') return send(req,res,200,await cached(e.slug+e.hash+'venue',filename(e.slug,e.hash+'.venue')),e.venueType);
      const day=localDate(now,e.data.timezone); if(day!==e.day) return send(req,res,503,'Preparing today’s countdown.');
      return send(req,res,200,await cached(e.slug+e.hash+day,filename(e.slug,`graph-${e.hash}-${day}.png`)),'image/png');
    } catch { if(!res.headersSent) send(req,res,503,'Countdown temporarily unavailable.'); else res.end(); }
  });
  const privateServer=http.createServer(async(req,res)=>{
    try {
      if(req.method!=='POST' || req.url!=='/internal/sync') return send(req,res,404,'Not found.');
      const length=Number(req.headers['content-length']); if(!Number.isSafeInteger(length)||length<1||length>protocol.MAX_BODY) {req.resume();return send(req,res,413,'Invalid body.');}
      const chunks=[];let size=0; for await(const chunk of req){size+=chunk.length;if(size>protocol.MAX_BODY)throw Object.assign(Error('Too large'),{status:413});chunks.push(chunk);} const body=Buffer.concat(chunks).toString('utf8');
      if(!protocol.verify(secret,body,req.headers,clock().getTime(),seen)) return send(req,res,401,'Unauthorized.');
      await apply(JSON.parse(body)); send(req,res,200,'ok');
    } catch(error) { if(!res.headersSent) send(req,res,error.status||400,'Sync not accepted.'); else res.end(); }
  });
  for(const server of [publicServer,privateServer]){server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=200;}
  privateServer.maxConnections=4;
  await refresh();
  return { publicServer, privateServer, refresh, close:async()=>{stopped=true;clearTimeout(timer);for(const server of [publicServer,privateServer]){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}} };
}
async function main() {
  const { lookup }=require('node:dns/promises');
  const env=process.env, domain=env.RAILWAY_PRIVATE_DOMAIN;
  if(['DISCORD_TOKEN','BOT_TOKEN','HARMONY_DB_PATH','DATABASE_URL','WELCOME_PASS_SHARED_SECRET'].some(k=>env[k]))throw Error('Private bot/database configuration must not be supplied to the public service');
  if(!domain?.endsWith('.railway.internal')) throw Error('Private Railway networking is required; no public sync listener will be opened');
  const addresses=await lookup(domain,{all:true}); const address=addresses.find(a=>/^f[cd][0-9a-f]*:/i.test(a.address)) || addresses.find(a=>/^10\./.test(a.address));
  if(!address) throw Error('A private bind address is required');
  if(Number(env.PORT||3000)===Number(env.COUNTDOWN_SYNC_PORT||3101)) throw Error('Public/private ports must differ');
  const service=await createService({directory:env.COUNTDOWN_PUBLIC_DIRECTORY||'/data/countdowns',origin:env.COUNTDOWN_PUBLIC_ORIGIN,secret:env.COUNTDOWN_PUBLIC_SYNC_SECRET,perPeer:Number(env.COUNTDOWN_PUBLIC_PEER_RATE||600),globalLimit:Number(env.COUNTDOWN_PUBLIC_GLOBAL_RATE||2400)});
  service.privateServer.listen(Number(env.COUNTDOWN_SYNC_PORT||3101),address.address);
  service.publicServer.listen(Number(env.PORT||3000),'0.0.0.0');
}
if(require.main===module)main().catch(()=>{console.error('Public countdown service could not start; check its isolated configuration.');process.exit(1);});
module.exports={createService};
