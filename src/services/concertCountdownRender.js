"use strict";
const {spawn} = require("node:child_process");
const escape = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function html(model, photo) {
  const panels=model.panels.map(p=>'<section><b>DAY '+p.day+'</b><strong>'+escape(p.state==="upcoming"?p.days:p.label)+'</strong><small>'+escape(p.state==="upcoming"?p.label:"")+'</small><div>'+escape(new Intl.DateTimeFormat("en-US",{dateStyle:"long",timeZone:"UTC"}).format(new Date(p.date+"T12:00:00Z")))+'</div></section>').join("");
  const banner=photo?'<img src="data:image/'+photo.type+';base64,'+Buffer.from(photo.bytes).toString("base64")+'">':'<aside>WORLD TOUR</aside>';
  return '<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#202126;color:#fff;font:24px Arial,sans-serif;width:800px}main{margin:8px;border:2px solid #f87926;border-radius:20px;padding:20px;background:#24252a}h1{font-size:32px;text-align:center;margin:0 0 16px;overflow-wrap:anywhere}img,aside{width:100%;height:220px;object-fit:cover;border-radius:12px}aside{display:grid;place-items:center;background:#15161a;color:#f87926;font-weight:bold}h2{font-size:23px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat('+ (model.panels.length===1?1:2) +',minmax(0,1fr));gap:12px}section{background:#131418;border-radius:12px;padding:16px;text-align:center;display:flex;flex-direction:column;gap:7px;justify-content:center}strong{color:#ff812c;font-size:clamp(25px,5vw,56px);overflow-wrap:anywhere}small{font-size:18px}footer{text-align:center;margin-top:20px;font-size:20px}footer small{display:block;color:#aaa;margin-top:8px}</style><main><h1>🧡 '+escape(model.city.toUpperCase())+', ARE YOU READY? 🖤</h1>'+banner+'<h2>📍 '+escape(model.venue)+'</h2><div class="grid">'+(panels||'<p>No active concert dates</p>')+'</div><footer>'+ (model.panels.length>1?"Different days. Same love for our eight.":"Eight Kids. One STAY family.")+'<small>Youtiful STAY • World Tour Countdown</small></footer></main>';
}
function render(model,photo) {
  return new Promise((resolve,reject)=>{
    const script="import sys\nfrom playwright.sync_api import sync_playwright\nwith sync_playwright() as p:\n b=p.chromium.launch(args=['--no-sandbox'])\n page=b.new_page(viewport={'width':800,'height':600},device_scale_factor=1)\n page.route('**/*',lambda route:route.abort())\n page.set_content(sys.stdin.read(),wait_until='load')\n sys.stdout.buffer.write(page.locator('main').screenshot(type='png',timeout=15000))\n b.close()";
    const child=spawn("python3",["-c",script],{stdio:["pipe","pipe","pipe"]});
    const chunks=[];let size=0;
    const timer=setTimeout(()=>{child.kill();reject(new Error("Countdown rendering timed out"));},30000);
    child.stdout.on("data",c=>{size+=c.length;if(size>8*1024*1024){child.kill();reject(new Error("Countdown image too large"));}else chunks.push(c);});
    child.stderr.resume();child.stdin.on("error",()=>{});child.on("error",e=>{clearTimeout(timer);reject(e);});
    child.on("close",code=>{clearTimeout(timer);if(code===0&&size)resolve(Buffer.concat(chunks));else reject(new Error("Countdown rendering failed"));});
    child.stdin.end(html(model,photo));
  });
}
module.exports={html,render};
