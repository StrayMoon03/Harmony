const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {createService}=require('../services/public-countdowns/server'), protocol=require('../services/public-countdowns/protocol');
const {localDate}=require('../src/services/concertCountdownModel');
const secret='fixture-only-'.repeat(4), slug='chicago-soldier-field-123456abcdef', origin='https://countdowns.example.com';
const data={city:'Chicago',country:'United States',venue:'Soldier Field',timezone:'America/Chicago',dates:['2027-06-18','2027-06-19'],photo:null};
async function fixture(options={}){
  const directory=options.directory||await fs.mkdtemp(path.join(os.tmpdir(),'public-countdown-'));
  let now=new Date('2027-06-17T04:59:59Z'); const calls={render:0,photo:0};
  const renderer={render:async m=>{calls.render++;return Buffer.from('fixture PNG '+m.today+' '+m.panels.map(p=>p.days).join(','));},validatePhoto:async b=>{calls.photo++;return {bytes:b,type:'jpeg'};}};
  const service=await createService({directory,origin,secret,clock:()=>now,renderer,...options});
  for(const server of [service.publicServer,service.privateServer])await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+service.publicServer.address().port, internal='http://127.0.0.1:'+service.privateServer.address().port+'/internal/sync';
  let seq=0;
  const send=async(body,headers)=>{const raw=JSON.stringify(body);return fetch(internal,{method:'POST',headers:headers||protocol.sign(secret,raw,now.getTime()),body:raw});};
  const upsert=async(d=data)=>send({operation:'upsert',slug,seq:++seq,expires:now.getTime()+protocol.LEASE_MS,hash:protocol.hashData(protocol.validateData(d)),data:d});
  return {service,directory,calls,base,internal,send,upsert,setNow:v=>{now=new Date(v);},get now(){return now;},nextSeq:()=>++seq};
}
test('public Chicago page is responsive, branded, accessible and has stable Facebook metadata without countdown numbers',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.base+'/countdowns/'+slug)).status,404);assert.equal((await f.upsert()).status,200);
    const response=await fetch(f.base+'/countdowns/'+slug), html=await response.text();
    assert.equal(response.status,200);assert.match(html,/name="viewport"/);assert.match(html,/Youtiful STAY/);assert.match(html,/Soldier Field/);assert.match(html,/June 18, 2027/);assert.match(html,/June 19, 2027/);
    assert.match(html,/alt="Chicago — Soldier Field/);assert.match(html,/og:image/);assert.match(html,/venue.jpg/);assert.doesNotMatch(html,/Discord|guild_id|channel_id|secret|login/);
    const og=html.match(/<meta property="og:[^>]+>/g);assert.ok(og.every(v=>!v.includes('days to go')&&!v.includes('DAYS TO GO')));
    assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);assert.match(response.headers.get('cache-control'),/must-revalidate/);assert.equal(response.headers.get('set-cookie'),null);
    const image=await fetch(f.base+'/countdowns/'+slug+'/countdown.png');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
    assert.equal((await fetch(f.base+'/countdowns/'+slug+'/venue.jpg')).headers.get('content-type'),'image/png');
  }finally{await f.service.close();}
});
test('midnight changes the real model output, invalidates image ETags, and leaves Open Graph metadata stable',async()=>{
  const f=await fixture();try{
    await f.upsert();const url=f.base+'/countdowns/'+slug, first=await fetch(url), before=await first.text(), image=await fetch(url+'/countdown.png'), etag=image.headers.get('etag');
    assert.equal((await fetch(url+'/countdown.png',{headers:{'If-None-Match':etag}})).status,304);
    f.setNow('2027-06-17T05:00:00Z');assert.equal(localDate(f.now,data.timezone),'2027-06-17');
    assert.equal((await fetch(url+'/countdown.png',{headers:{'If-None-Match':etag}})).status,503);await f.service.refresh();
    const changed=await fetch(url+'/countdown.png',{headers:{'If-None-Match':etag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);assert.match(await changed.text(),/1,2$/);
    const after=await(await fetch(url)).text();assert.deepEqual(after.match(/<meta property="og:[^>]+>/g),before.match(/<meta property="og:[^>]+>/g));
  }finally{await f.service.close();}
});
test('restart recovers persisted approved projections; expired leases fail closed until authenticated renewal',async()=>{
  let f=await fixture();const dir=f.directory;await f.upsert();await f.service.close();
  f=await fixture({directory:dir});try{
    assert.equal((await fetch(f.base+'/countdowns/'+slug)).status,200);
    f.setNow('2027-06-20T06:00Z');assert.equal((await fetch(f.base+'/countdowns/'+slug)).status,404);
    const renewed=await f.send({operation:'renew',slug,seq:2,expires:f.now.getTime()+protocol.LEASE_MS,hash:protocol.hashData(data)});assert.equal(renewed.status,200);await f.service.refresh();
    assert.equal((await fetch(f.base+'/countdowns/'+slug)).status,200);const graph=await fetch(f.base+'/countdowns/'+slug+'/countdown.png');assert.match(await graph.text(),/0,0$/);
  }finally{await f.service.close();}
});
test('public port is read-only and exposes no administrative, sync, file, JSON, or enumeration endpoints',async()=>{
  const f=await fixture();try{
    await f.upsert();
    for(const endpoint of ['/','/internal/sync','/admin','/data','/countdowns','/countdowns/'+slug+'/manifest.json','/countdowns/'+slug+'/../../private.sqlite','/countdowns/'+slug+'/source.jpg'])assert.equal((await fetch(f.base+endpoint)).status,404,endpoint);
    for(const method of ['POST','PATCH','DELETE','PUT'])assert.equal((await fetch(f.base+'/countdowns/'+slug,{method})).status,405);
    const poison=await(await fetch(f.base+'/countdowns/'+slug,{headers:{host:'evil.example'}})).text();assert.match(poison,/https:\/\/countdowns.example.com/);assert.doesNotMatch(poison,/evil.example/);
  }finally{await f.service.close();}
});
test('private ingestion checks HMAC, replay, monotonic revisions, schema and photo bounds',async()=>{
  const f=await fixture();try{
    const body={operation:'upsert',slug,seq:1,expires:f.now.getTime()+protocol.LEASE_MS,hash:protocol.hashData(data),data}, raw=JSON.stringify(body), headers=protocol.sign(secret,raw,f.now.getTime());
    assert.equal((await f.send(body,{'content-type':'application/json'})).status,401);
    assert.equal((await f.send(body,headers)).status,200);assert.equal((await f.send(body,headers)).status,401);
    assert.equal((await f.send(body)).status,409);
    const evil={...data,guild_id:'PRIVATE-CANARY',token:'SECRET-CANARY'};
    const bad=await f.send({...body,seq:2,data:evil});assert.equal(bad.status,400);assert.doesNotMatch(await bad.text(),/PRIVATE-CANARY|SECRET-CANARY/);
    assert.equal((await f.send({...body,seq:3,slug:'../outside'})).status,400);
    assert.throws(()=>protocol.validateData({...data,dates:['2027-02-30']}));assert.throws(()=>protocol.validateData({...data,photo:'a'.repeat(6*1024*1024)}));
    const now=f.now.getTime();assert.equal(protocol.verify(secret,raw,protocol.sign(secret,raw,now-61000),now,new Map()),false);
  }finally{await f.service.close();}
});
test('withdrawal removes every public asset before cache/ETag handling; old sync messages cannot restore it',async()=>{
  const f=await fixture();try{
    await f.upsert();const url=f.base+'/countdowns/'+slug, image=await fetch(url+'/countdown.png'), etag=image.headers.get('etag');
    assert.equal((await f.send({operation:'withdraw',slug,seq:2})).status,200);
    for(const suffix of ['','/venue.jpg','/countdown.png'])assert.equal((await fetch(url+suffix,{headers:{'If-None-Match':etag}})).status,404);
    assert.equal((await f.send({operation:'renew',slug,seq:1,expires:f.now.getTime()+protocol.LEASE_MS,hash:protocol.hashData(data)})).status,409);
    assert.deepEqual(await fs.readdir(path.join(f.directory,slug)),['manifest.json']);
  }finally{await f.service.close();}
});
test('read traffic is cached and rate limited without causing image rendering',async()=>{
  const f=await fixture({perPeer:5});try{
    await f.upsert();const renders=f.calls.render;
    for(let n=0;n<5;n++)assert.equal((await fetch(f.base+'/countdowns/'+slug+'/countdown.png',{headers:{'x-forwarded-for':'192.0.2.'+n}})).status,200);
    const limited=await fetch(f.base+'/countdowns/'+slug);assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');assert.equal(f.calls.render,renders);
  }finally{await f.service.close();}
});
test('public HTML escapes supplied text, and the service does not import Discord, SQLite or bot/admin modules',async()=>{
  const f=await fixture();try{
    const evil={...data,city:'Chicago <script>alert(1)</script>',venue:'" onload="alert(1)'};await f.upsert(evil);
    const html=await(await fetch(f.base+'/countdowns/'+slug)).text();assert.doesNotMatch(html,/<script>alert/);assert.match(html,/&lt;script&gt;/);
    assert.ok(!Object.keys(require.cache).some(file=>/node_modules\/discord|src\/db\/sqlite|welcomePassServer|concertCountdownManager/.test(file)));
  }finally{await f.service.close();}
});
test('real approved renderer produces identical PNG bytes and the shared photograph is stripped of EXIF metadata',async()=>{
  const {execFileSync}=require('node:child_process'), images=require('../src/services/concertCountdownRender');
  const photo=execFileSync('python3',['-c',"from PIL import Image;import io,sys;im=Image.new('RGB',(1200,630),'#516879');e=Image.Exif();e[270]='PRIVATE-EXIF-CANARY';im.save(sys.stdout.buffer,format='JPEG',exif=e)"]);
  const f=await fixture({renderer:images});try{
    const d={...data,photo:photo.toString('base64')};assert.equal((await f.upsert(d)).status,200);
    const actual=Buffer.from(await(await fetch(f.base+'/countdowns/'+slug+'/countdown.png')).arrayBuffer());
    assert.deepEqual(actual,await images.render(protocol.publicModel(d,f.now),{bytes:photo,type:'jpeg'}));
    const venue=await fetch(f.base+'/countdowns/'+slug+'/venue.jpg');assert.equal(venue.headers.get('content-type'),'image/jpeg');assert.equal(Buffer.from(await venue.arrayBuffer()).includes(Buffer.from('PRIVATE-EXIF-CANARY')),false);
  }finally{await f.service.close();}
});
test('restart rebuilds a missing cached graphic from the approved projection, without a new owner setup',async()=>{
  let f=await fixture();await f.upsert();const dir=f.directory;await f.service.close();
  const files=await fs.readdir(path.join(dir,slug));await fs.unlink(path.join(dir,slug,files.find(name=>name.startsWith('graph-'))));
  f=await fixture({directory:dir});try{assert.equal(f.calls.render,1);assert.equal((await fetch(f.base+'/countdowns/'+slug+'/countdown.png')).status,200);}finally{await f.service.close();}
});
test('public-service startup rejects bot credentials and exits without revealing them',()=>{
  const result=require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'../services/public-countdowns/server.js')],{env:{...process.env,DISCORD_TOKEN:'PRIVATE-CREDENTIAL-CANARY'},encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.doesNotMatch(result.stderr,/PRIVATE-CREDENTIAL-CANARY/);assert.match(result.stderr,/isolated configuration/);
});
