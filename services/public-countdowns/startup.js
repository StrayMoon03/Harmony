"use strict";
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const CODES = new Set(['ENOTFOUND','EAI_AGAIN','EADDRINUSE','EADDRNOTAVAIL','EACCES','EPERM','ENOSPC','EROFS','EIO','ENOENT']);
const SAFE_CODES = new Set(['PRIVATE_CONFIGURATION_PRESENT','RAILWAY_PRIVATE_DOMAIN_INVALID','COUNTDOWN_PUBLIC_ORIGIN_INVALID','COUNTDOWN_PUBLIC_SYNC_SECRET_INVALID','PORT_INVALID','COUNTDOWN_SYNC_PORT_INVALID','COUNTDOWN_PUBLIC_PEER_RATE_INVALID','COUNTDOWN_PUBLIC_GLOBAL_RATE_INVALID','PUBLIC_PRIVATE_PORT_COLLISION','PRIVATE_INTERFACE_AMBIGUOUS','PRIVATE_INTERFACE_UNAVAILABLE']);
function fault(code) { return Object.assign(Error(code), { safeCode:code }); }
function settings(env) {
  if (['DISCORD_TOKEN','BOT_TOKEN','HARMONY_DB_PATH','DATABASE_URL','WELCOME_PASS_SHARED_SECRET'].some(key=>env[key])) throw fault('PRIVATE_CONFIGURATION_PRESENT');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.railway\.internal$/i.test(env.RAILWAY_PRIVATE_DOMAIN || '')) throw fault('RAILWAY_PRIVATE_DOMAIN_INVALID');
  let origin;
  try { origin = new URL(env.COUNTDOWN_PUBLIC_ORIGIN); } catch { throw fault('COUNTDOWN_PUBLIC_ORIGIN_INVALID'); }
  if (origin.protocol!=='https:' || origin.origin!==env.COUNTDOWN_PUBLIC_ORIGIN || origin.username || origin.password) throw fault('COUNTDOWN_PUBLIC_ORIGIN_INVALID');
  if (typeof env.COUNTDOWN_PUBLIC_SYNC_SECRET!=='string' || env.COUNTDOWN_PUBLIC_SYNC_SECRET.length<32) throw fault('COUNTDOWN_PUBLIC_SYNC_SECRET_INVALID');
  const number = (key, fallback, max) => {
    const raw=env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw)<1 || Number(raw)>max) throw fault(key+'_INVALID');
    return Number(raw);
  };
  const publicPort=number('PORT',3000,65535), privatePort=number('COUNTDOWN_SYNC_PORT',3101,65535);
  if(publicPort===privatePort) throw fault('PUBLIC_PRIVATE_PORT_COLLISION');
  return { publicPort, privatePort, options:{ directory:env.COUNTDOWN_PUBLIC_DIRECTORY || '/data/countdowns', origin:origin.origin, secret:env.COUNTDOWN_PUBLIC_SYNC_SECRET, perPeer:number('COUNTDOWN_PUBLIC_PEER_RATE',600,10000), globalLimit:number('COUNTDOWN_PUBLIC_GLOBAL_RATE',2400,10000) } };
}
function privateAddress(interfaces) {
  // Bind only an address actually assigned to this container. Self-DNS may not
  // exist until deployment health checks pass, and may refer to an old replica.
  const local=Object.values(interfaces).flat().filter(item=>item && !item.internal);
  const ipv6=[...new Set(local.filter(item=>net.isIP(item.address)===6 && /^f[cd][0-9a-f]{2}:/i.test(item.address)).map(item=>item.address))];
  const ipv4=[...new Set(local.filter(item=>net.isIP(item.address)===4 && item.address.startsWith('10.')).map(item=>item.address))];
  const candidates=ipv6.length?ipv6:ipv4;
  if(candidates.length>1)throw fault('PRIVATE_INTERFACE_AMBIGUOUS');
  return candidates[0] || null;
}
function listen(server, port, host) {
  return new Promise((resolve,reject)=>{
    const failed=error=>{server.removeListener('listening',ready);reject(error);};
    const ready=()=>{server.removeListener('error',failed);resolve();};
    server.once('error',failed);server.once('listening',ready);
    try { server.listen(port,host); } catch(error) {server.removeListener('error',failed);server.removeListener('listening',ready);reject(error);}
  });
}
async function start({env=process.env, networkInterfaces=require('node:os').networkInterfaces, createService, wait=delay, log=line=>console.error(line), onFatal=()=>{process.exitCode=1;}}={}) {
  let stage='configuration', service;
  // Only constant stage/code identifiers are logged. Never serialize exceptions,
  // environment values, paths, addresses, projection data or authentication data.
  const report=(event,code)=>log(JSON.stringify({component:'public-countdowns',event,stage,...(code?{code}:{})}));
  const safeCode=error=>SAFE_CODES.has(error.safeCode)?error.safeCode:CODES.has(error.code)?error.code:'UNEXPECTED_FAILURE';
  try {
    const config=settings(env);
    stage='private-interface';
    let address;
    for(let attempt=0;attempt<20;attempt++) {
      address=privateAddress(networkInterfaces());
      if(address)break;
      if(attempt===0)report('waiting','PRIVATE_INTERFACE_NOT_READY');
      if(attempt<19)await wait(1000);
    }
    if(!address)throw fault('PRIVATE_INTERFACE_UNAVAILABLE');
    stage='projection-storage';
    service=await createService(config.options);
    for(const server of [service.privateServer,service.publicServer])server.on('error',error=>{
      if(stage!=='ready')return; // The awaited bind handles startup errors.
      stage=server===service.privateServer?'private-listener':'public-listener';
      report('listener-failed',safeCode(error));
      void service.close().catch(()=>{}).finally(onFatal);
    });
    stage='private-listener';await listen(service.privateServer,config.privatePort,address);
    stage='public-listener';await listen(service.publicServer,config.publicPort,'0.0.0.0');
    stage='ready';report('ready');
    return service;
  } catch(error) {
    const code=safeCode(error);
    report('startup-failed',code);
    if(service)await service.close().catch(()=>{});
    throw fault('STARTUP_FAILED');
  }
}
module.exports={settings,privateAddress,start};
