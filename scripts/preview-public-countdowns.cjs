"use strict";
// Offline Chicago fixture. No live Discord, Facebook, Railway or production database.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'public-chicago-review-'));process.env.HARMONY_DB_PATH=path.join(folder,'bot-fixture.sqlite');
const {createService}=require('../services/public-countdowns/server');
const sharing=require('../src/services/concertCountdownSharing'), service=require('../src/services/concertCountdownService'), images=require('../src/services/concertCountdownRender');
const store=require('../src/stores/concertCountdownStore'), calendar=require('../src/stores/eventSchedulerStore'), manager=require('../src/services/concertCountdownManager');
const {hashData}=require('../services/public-countdowns/protocol');
(async()=>{
  const now=new Date('2026-11-25T18:00Z'), origin='https://countdowns.example.com', secret='offline-review-secret-'.repeat(3);
  const output=path.join(__dirname,'../docs/public-concert-countdowns');fs.mkdirSync(output,{recursive:true});
  const photo=execFileSync('python3',['-c',`from PIL import Image,ImageDraw,ImageFont
import sys
im=Image.new('RGB',(1500,800),'#788ca2');d=ImageDraw.Draw(im)
for n in range(18):
 y=250+n*22;d.polygon([(50+n*12,y),(1450-n*12,y),(1400-n*12,y+17),(100+n*12,y+17)],fill=('#6e432d' if n%2 else '#be7844'))
d.ellipse((280,410,1220,750),fill='#3c7255');d.ellipse((380,470,1120,690),fill='#71945c')
f=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',30);d.text((750,100),'CHICAGO • REVIEW PHOTO FIXTURE',font=f,anchor='mm',fill='white')
im.save(sys.stdout.buffer,format='JPEG',quality=90)`]);
  const g='private-review-server',c='private-review-room',ids=['2027-06-18','2027-06-19'].map(eventDate=>calendar.createCalendarEvent({guildId:g,calendarChannelId:'private-calendar',title:'Chicago concert',eventDate,eventTimezone:'America/Chicago',timezone:'America/Chicago',calendarType:'stray_kids',category:'concert',allDay:true,createdBy:'fixture-owner'}));
  store.save(g,c,{guildId:g,city:'Chicago',country:'United States',venue:'Soldier Field',timezone:'America/Chicago',eventIds:ids});store.photo(g,c,photo,'jpeg');
  store.update(g,c,{message_id:'private-message',published_at:now.toISOString(),last_success:now.toISOString(),render_version:images.RENDER_VERSION,fingerprint:service.fingerprint(service.model(store.get(g,c),now),store.get(g,c))});
  const web=await createService({directory:path.join(folder,'public-only'),origin,secret,clock:()=>now});
  await new Promise(r=>web.publicServer.listen(0,'127.0.0.1',r));await new Promise(r=>web.privateServer.listen(0,'127.0.0.1',r));
  const internal='http://127.0.0.1:'+web.privateServer.address().port+'/internal/sync';
  const env={COUNTDOWN_PUBLIC_ORIGIN:origin,COUNTDOWN_PUBLIC_SYNC_URL:'http://public-countdowns.railway.internal:3101/internal/sync',COUNTDOWN_PUBLIC_SYNC_SECRET:secret};Object.assign(process.env,env);
  const session=manager.createSession({guildId:g,channelId:'private-control',user:{id:'fixture-owner'}});session.room=c;
  const consent=manager.sharingPage(session);
  await sharing.enable(g,c,hashData(sharing.projection(store.get(g,c))),{env,now,transport:(_url,options)=>fetch(internal,options)});
  const share=sharing.get(g,c), link='http://127.0.0.1:'+web.publicServer.address().port+'/countdowns/'+share.slug;
  fs.writeFileSync(path.join(output,'chicago.html'),await(await fetch(link)).text());
  fs.writeFileSync(path.join(output,'chicago-countdown.png'),Buffer.from(await(await fetch(link+'/countdown.png')).arrayBuffer()));
  fs.writeFileSync(path.join(output,'facebook-venue-preview.jpg'),Buffer.from(await(await fetch(link+'/venue.jpg')).arrayBuffer()));
  fs.writeFileSync(path.join(output,'manager-payloads.json'),JSON.stringify({consent,enabled:manager.sharingPage(session)},null,2)+'\n');
  const python=String.raw`import json,sys,os
from playwright.sync_api import sync_playwright
url,out=sys.argv[1:]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH'),headless=True,args=json.loads(os.environ.get('CHROMIUM_REVIEW_ARGS','["--no-sandbox"]')))
 records=[]
 for name,width,height in [('desktop',1280,1100),('mobile',390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1,is_mobile=name=='mobile',has_touch=name=='mobile')
  page.goto(url,wait_until='networkidle');page.locator('img').wait_for(state='visible')
  assert page.locator('img').evaluate('(el)=>el.complete && el.naturalWidth===800')
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  assert page.locator('h1').inner_text()=='Chicago'
  page.screenshot(path=out+'/chicago-'+name+'.png',full_page=True)
  records.append({'browser':browser.version,'layout':name,'width':width,'overflow':False,'graphicWidth':page.locator('img').evaluate('(el)=>el.naturalWidth')})
  page.close()
 browser.close()
print(json.dumps(records))`;
  // Keep the local HTTP event loop free while Chromium fetches this isolated fixture.
  const {spawn}=require('node:child_process');const result=await new Promise((resolve,reject)=>{const child=spawn('python3',['-c',python,link,output]);let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('close',code=>code?reject(Error(stderr)):resolve(stdout));});
  fs.writeFileSync(path.join(output,'browser-verification.json'),result);
  const {publicModel}=require('../services/public-countdowns/protocol');
  now.setTime(Date.parse('2026-11-26T05:59:59.999Z'));
  await sharing.sync(g,c,{env,now,transport:(_url,options)=>fetch(internal,options)});
  const beforeResponse=await fetch(link+'/countdown.png'),beforeBytes=Buffer.from(await beforeResponse.arrayBuffer()),beforeModel=publicModel(sharing.projection(store.get(g,c)),now),beforeUtc=now.toISOString();
  const beforeMeta=(await(await fetch(link)).text()).match(/<meta property="og:[^>]+>/g);
  now.setTime(Date.parse('2026-11-26T06:00:00.000Z'));await web.refresh();
  const afterResponse=await fetch(link+'/countdown.png',{headers:{'If-None-Match':beforeResponse.headers.get('etag')}}),afterBytes=Buffer.from(await afterResponse.arrayBuffer()),afterModel=publicModel(sharing.projection(store.get(g,c)),now);
  require('node:assert/strict').equal(afterResponse.status,200);
  require('node:assert/strict').notDeepEqual(afterBytes,beforeBytes);
  require('node:assert/strict').deepEqual(afterBytes,await images.render(service.model(store.get(g,c),now),{bytes:photo,type:'jpeg'}));
  require('node:assert/strict').deepEqual((await(await fetch(link)).text()).match(/<meta property="og:[^>]+>/g),beforeMeta);
  fs.writeFileSync(path.join(output,'chicago-after-midnight.png'),afterBytes);
  fs.writeFileSync(path.join(output,'midnight-verification.json'),JSON.stringify({timezone:'America/Chicago',before:{utc:beforeUtc,localDate:beforeModel.today,days:beforeModel.panels.map(p=>p.days)},after:{utc:now.toISOString(),localDate:afterModel.today,days:afterModel.panels.map(p=>p.days)},openGraphUnchanged:true,approvedRendererByteMatch:true,imageETagChanged:afterResponse.headers.get('etag')!==beforeResponse.headers.get('etag')},null,2)+'\n');
  console.log('Created real browser screenshots and verified the public midnight PNG transition.');await web.close();require('../src/db/sqlite').closeDb();
})().catch(error=>{console.error(error);process.exit(1);});
