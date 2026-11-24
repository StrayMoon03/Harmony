"use strict";
const store=require("../stores/concertCountdownStore");
const events=require("../stores/eventSchedulerStore");
const {buildCountdown}=require("./concertCountdownModel");
const {render}=require("./concertCountdownRender");
const {createHash}=require("node:crypto");
const locks=new Set();
function model(row,now){
 const config=JSON.parse(row.config);
 const selected=config.eventIds.map(id=>events.getEvent(row.guild_id,id)).filter(Boolean);
 return buildCountdown(config,selected,now);
}
function text(m){return [m.city+" — "+m.venue,...m.panels.map(p=>p.date+": "+(p.state==="upcoming"?p.days+" days to go":p.label)),...(m.panels.length?[]:["No active concert dates"])].join("\n");}
async function preview(row){const m=model(row);return {content:text(m),files:[{attachment:await render(m,row.photo?{type:row.photo_type,bytes:row.photo}:null),name:"countdown.png"}],allowedMentions:{parse:[]}};}
async function refresh(client,g,c,{publish=false,force=false}={}){
 const key=g+":"+c;if(locks.has(key))throw Error("Countdown update already running");locks.add(key);
 try{
 const row=store.get(g,c);if(!row)throw Error("Configure this room first");
 if(!row.message_id&&!publish)throw Error("Initial publication requires approval");
 const m=model(row);const hash=createHash("sha256").update(JSON.stringify(m)).update(row.photo||Buffer.alloc(0)).digest("hex");
 if(!force&&row.fingerprint===hash)return;
 const channel=await client.channels.fetch(c);if(channel?.guildId!==g||!channel.isTextBased()||!channel.messages)throw Error("Invalid concert room");
 const marker="Youtiful STAY • World Tour Countdown ["+c+"]";
 let message;
 if(row.message_id){try{message=await channel.messages.fetch(row.message_id);}catch(e){if(Number(e.code)!==10008)throw e;}}
 if(!message){
 const recent=await channel.messages.fetch({limit:100});
 message=recent.find(x=>x.author.id===client.user.id&&x.content.endsWith(marker));
 }
 if(message&&message.author.id!==client.user.id)throw Error("Managed message ownership mismatch");
 const payload={...await preview(row),content:text(m)+"\n"+marker};
 if(message)await message.edit({...payload,attachments:[]});
 else message=await channel.send({...payload,nonce:c,enforceNonce:true});
 store.update(g,c,{message_id:message.id});
 if(!message.pinned)await message.pin();
 store.update(g,c,{fingerprint:hash,last_success:new Date().toISOString(),last_error:null});
 }catch(e){if(store.get(g,c))store.update(g,c,{last_error:String(e.message).slice(0,250)});throw e;}finally{locks.delete(key);}
}
function start(client){let busy=false;async function tick(){if(busy)return;busy=true;try{for(const row of store.enabled()){try{await refresh(client,row.guild_id,row.channel_id);}catch(e){console.error("Concert countdown update failed",row.channel_id,e.message);}}}finally{busy=false;}}const run=()=>tick().catch(e=>console.error("Concert countdown scheduler failed",e.message));run();const timer=setInterval(run,60000);timer.unref?.();}
module.exports={model,text,preview,refresh,start};
