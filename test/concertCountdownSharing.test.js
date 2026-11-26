const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
process.env.HARMONY_DB_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'countdown-sharing-')),'fixture.sqlite');
const store=require('../src/stores/concertCountdownStore'), calendar=require('../src/stores/eventSchedulerStore'), service=require('../src/services/concertCountdownService');
const images=require('../src/services/concertCountdownRender'), sharing=require('../src/services/concertCountdownSharing'), protocol=require('../services/public-countdowns/protocol');
const {getDb,closeDb}=require('../src/db/sqlite');
const env={COUNTDOWN_PUBLIC_ORIGIN:'https://countdowns.example.com',COUNTDOWN_PUBLIC_SYNC_URL:'http://public-countdowns.railway.internal:3101/internal/sync',COUNTDOWN_PUBLIC_SYNC_SECRET:'fixture-only-secret-'.repeat(3)};
const now=new Date('2027-01-01T12:00Z');let seq=0;
function fixture(published=true){
  const g='PRIVATE-GUILD-'+(++seq),c='PRIVATE-CHANNEL-'+seq;
  const ids=['2027-06-18','2027-06-19'].map(eventDate=>calendar.createCalendarEvent({guildId:g,calendarChannelId:'PRIVATE-CALENDAR',title:'Chicago concert',eventDate,eventTimezone:'America/Chicago',timezone:'America/Chicago',calendarType:'stray_kids',category:'concert',allDay:true,createdBy:'PRIVATE-ACTOR'}));
  store.save(g,c,{guildId:g,city:'Chicago',country:'United States',venue:'Soldier Field',timezone:'America/Chicago',eventIds:ids});store.photo(g,c,Buffer.from('approved photograph'),'jpeg');
  const row=()=>store.get(g,c), publish=()=>store.update(g,c,{message_id:'PRIVATE-MESSAGE',published_at:now.toISOString(),last_success:now.toISOString(),render_version:images.RENDER_VERSION,fingerprint:service.fingerprint(service.model(row(),now),row())});
  if(published)publish();const calls=[];
  const transport=async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return{ok:true,status:200};};
  return {g,c,ids,row,publish,calls,options:{env,transport,now},hash:()=>protocol.hashData(sharing.projection(row()))};
}
test('sharing is off by default and only approved published configurations can opt in',async()=>{
  const f=fixture(), before=f.row();assert.equal(sharing.get(f.g,f.c),undefined);
  const share=sharing.ensure(f.g,f.c);assert.equal(share.enabled,0);assert.match(share.slug,/^chicago-soldier-field-[a-f0-9]{12}$/);assert.deepEqual(f.row(),before);assert.equal(f.calls.length,0);
  await assert.rejects(sharing.enable(f.g,f.c,'changed',f.options),/changed/);assert.equal(sharing.get(f.g,f.c).enabled,0);
  const draft=fixture(false);assert.throws(()=>sharing.ensure(draft.g,draft.c),/Publish/);assert.equal(sharing.get(draft.g,draft.c),undefined);
});
test('enable returns a stable readable URL and exports only public fields; disable changes no Discord configuration',async()=>{
  const f=fixture(), before=f.row();await sharing.enable(f.g,f.c,f.hash(),f.options);
  const share=sharing.get(f.g,f.c), body=f.calls[0].body;
  assert.equal(body.operation,'upsert');assert.deepEqual(Object.keys(body.data).sort(),['city','country','dates','photo','timezone','venue']);
  assert.doesNotMatch(JSON.stringify(body),/PRIVATE-GUILD|PRIVATE-CHANNEL|PRIVATE-MESSAGE|PRIVATE-ACTOR|PRIVATE-CALENDAR|guild_id|eventIds|enabled/);
  assert.equal(f.calls[0].options.redirect,'error');assert.ok(f.calls[0].options.signal);assert.equal(f.calls[0].options.headers['x-countdown-signature'].length,64);
  await sharing.sync(f.g,f.c,f.options);assert.equal(f.calls[1].body.operation,'renew');assert.equal(f.calls[1].body.data,undefined);
  closeDb();await sharing.disable(f.g,f.c,f.options);assert.equal(f.calls[2].body.operation,'withdraw');
  assert.equal(sharing.get(f.g,f.c).enabled,0);assert.equal(sharing.get(f.g,f.c).pending,0);assert.deepEqual(f.row(),before);
  await sharing.enable(f.g,f.c,f.hash(),f.options);assert.equal(sharing.get(f.g,f.c).slug,share.slug);
});
test('unreviewed photographs and details never leave Harmony; last approved pages may renew until publication',async()=>{
  const f=fixture();await sharing.enable(f.g,f.c,f.hash(),f.options);const hash=sharing.get(f.g,f.c).synced_hash;
  store.photo(f.g,f.c,Buffer.from('PRIVATE-UNREVIEWED-PHOTO'),'jpeg');assert.equal(sharing.projection(f.row()),null);
  await sharing.sync(f.g,f.c,f.options);const body=f.calls.at(-1).body;assert.equal(body.operation,'renew');assert.equal(body.hash,hash);assert.equal(body.data,undefined);
  const fresh=fixture();store.photo(fresh.g,fresh.c,Buffer.from('private draft'),'jpeg');await assert.rejects(sharing.enable(fresh.g,fresh.c,'any',fresh.options),/changed/);
  f.publish();await sharing.sync(f.g,f.c,f.options);assert.equal(f.calls.at(-1).body.operation,'upsert');assert.equal(f.calls.at(-1).body.data.photo,Buffer.from('PRIVATE-UNREVIEWED-PHOTO').toString('base64'));
});
test('canceled/unapproved selected dates revoke the projection rather than renewing stale public data',async()=>{
  const f=fixture();await sharing.enable(f.g,f.c,f.hash(),f.options);
  getDb().prepare('UPDATE scheduled_events SET cancelled_at=? WHERE id=?').run(now.toISOString(),f.ids[0]);
  await assert.rejects(sharing.sync(f.g,f.c,f.options),/no longer approved/);assert.equal(f.calls.at(-1).body.operation,'withdraw');assert.equal(sharing.get(f.g,f.c).enabled,0);
});
test('failed withdrawal is explicit, durable, and retried without changing the permanent slug',async()=>{
  const f=fixture();await sharing.enable(f.g,f.c,f.hash(),f.options);const slug=sharing.get(f.g,f.c).slug;
  await assert.rejects(sharing.disable(f.g,f.c,{...f.options,transport:async()=>{throw Error('network');}}),/not confirmed.*15 minutes/);
  const share=sharing.get(f.g,f.c);assert.equal(share.enabled,0);assert.equal(share.pending,1);assert.match(share.last_error,/15 minutes/);
  closeDb();await sharing.sync(f.g,f.c,f.options);assert.equal(f.calls.at(-1).body.operation,'withdraw');assert.equal(sharing.get(f.g,f.c).pending,0);assert.equal(sharing.get(f.g,f.c).slug,slug);
});
test('late upserts cannot override a newer disable, and stale acknowledgments cannot clear removal state',async()=>{
  const f=fixture();let entered,finish;const started=new Promise(r=>{entered=r;}),waiting=new Promise(r=>{finish=r;});
  const first=sharing.enable(f.g,f.c,f.hash(),{...f.options,transport:async(url,options)=>{f.calls.push({body:JSON.parse(options.body)});entered();await waiting;return{ok:true,status:200};}});
  await started;const removal=sharing.disable(f.g,f.c,f.options);finish();await first;await removal;
  assert.deepEqual(f.calls.map(c=>c.body.operation),['upsert','withdraw']);assert.ok(f.calls[1].body.seq>f.calls[0].body.seq);assert.equal(sharing.get(f.g,f.c).enabled,0);assert.equal(sharing.get(f.g,f.c).pending,0);
});
test('missing public projections are repaired with a full upsert, without owner reconfiguration',async()=>{
  const f=fixture();await sharing.enable(f.g,f.c,f.hash(),f.options);
  await assert.rejects(sharing.sync(f.g,f.c,{...f.options,transport:async()=>({ok:false,status:409})}),/not confirmed/);
  assert.equal(sharing.get(f.g,f.c).synced_hash,null);await sharing.sync(f.g,f.c,f.options);assert.equal(f.calls.at(-1).body.operation,'upsert');
});
test('hosting configuration cannot send data or credentials to public/redirect URLs',()=>{
  for(const url of ['https://evil.example/internal/sync','http://localhost:3101/internal/sync','http://public-countdowns.railway.internal/private','http://user:pass@public-countdowns.railway.internal:3101/internal/sync'])assert.throws(()=>sharing.settings({...env,COUNTDOWN_PUBLIC_SYNC_URL:url}));
  assert.throws(()=>sharing.settings({...env,COUNTDOWN_PUBLIC_ORIGIN:'https://countdowns.example.com/path'}));
  assert.throws(()=>sharing.settings({...env,COUNTDOWN_PUBLIC_SYNC_SECRET:'short'}));
  const stop=sharing.start({env:{}});stop();
});
test('approved calendar reschedules update the public projection without enabling a disabled Discord countdown',async()=>{
  const f=fixture();await sharing.enable(f.g,f.c,f.hash(),f.options);const before=f.row();
  getDb().prepare('UPDATE scheduled_events SET event_date=? WHERE id=?').run('2027-06-20',f.ids[1]);
  await sharing.sync(f.g,f.c,f.options);assert.deepEqual(f.calls.at(-1).body.data.dates,['2027-06-18','2027-06-20']);
  assert.equal(f.row().enabled,before.enabled);assert.equal(f.row().message_id,before.message_id);assert.equal(f.row().fingerprint,before.fingerprint);
});
test('failed initial sync survives restart and retries existing consent without re-uploading or changing Discord configuration',async()=>{
  const f=fixture(),before=f.row();
  await assert.rejects(sharing.enable(f.g,f.c,f.hash(),{...f.options,transport:async()=>{throw Object.assign(Error('getaddrinfo ENOTFOUND'),{code:'ENOTFOUND'});}}),/not confirmed/);
  const pending=sharing.get(f.g,f.c);assert.equal(pending.enabled,1);assert.equal(pending.pending,1);assert.equal(pending.synced_hash,null);
  closeDb();
  // start() performs its usual startup catch-up over persisted consent.
  let complete;const delivered=new Promise(r=>{complete=r;});
  const stop=sharing.start({...f.options,transport:async(url,options)=>{if(JSON.parse(options.body).slug!==pending.slug)return {ok:true,status:200};const response=await f.options.transport(url,options);complete();return response;}});
  try{
    await delivered;await new Promise(r=>setImmediate(r));
    const ready=sharing.get(f.g,f.c);assert.equal(ready.enabled,1);assert.equal(ready.pending,0);assert.equal(ready.slug,pending.slug);assert.ok(ready.sequence>pending.sequence);assert.equal(ready.last_error,null);
    assert.equal(f.calls.at(-1).body.operation,'upsert');assert.deepEqual(f.row(),before);
  }finally{stop();}
});
