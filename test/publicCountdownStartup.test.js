const test=require('node:test'), assert=require('node:assert/strict'), {EventEmitter}=require('node:events');
const {start,settings,privateAddress}=require('../services/public-countdowns/startup');
const env={RAILWAY_PRIVATE_DOMAIN:'youtiful-stay-countdowns.railway.internal',COUNTDOWN_PUBLIC_ORIGIN:'https://countdowns.example.com',COUNTDOWN_PUBLIC_SYNC_SECRET:'fixture-only-secret-'.repeat(3)};
const nic=(...addresses)=>({eth0:addresses.map(address=>({address,internal:false}))});
const interfaces=()=>nic('fd12:1234:5678:1::2','10.0.0.2');
function fixture(failAt) {
  const binds=[], logs=[];let closed=0,created=0;
  function server(name){const s=new EventEmitter();s.listen=(port,host)=>{binds.push({name,port,host});queueMicrotask(()=>s.emit(name===failAt?'error':'listening',Object.assign(Error('SECRET-CANARY /private/path'),{code:'EADDRINUSE'})));};return s;}
  const service={privateServer:server('private'),publicServer:server('public'),close:async()=>{closed++;}};
  const options={env,networkInterfaces:interfaces,createService:async()=>{created++;return service;},log:l=>logs.push(JSON.parse(l))};
  return {options,service,logs,binds,get closed(){return closed;},get created(){return created;}};
}
test('NXDOMAIN for the service hostname cannot block startup: bind the actual local private interface without DNS',async()=>{
  const dns=require('node:dns/promises'),lookup=dns.lookup;let queries=0;
  dns.lookup=async()=>{queries++;throw Object.assign(Error('NXDOMAIN'),{code:'ENOTFOUND'});};
  const f=fixture();try{
    assert.equal(await start(f.options),f.service);assert.equal(queries,0);
    assert.deepEqual(f.binds,[{name:'private',port:3101,host:'fd12:1234:5678:1::2'},{name:'public',port:3000,host:'0.0.0.0'}]);
    assert.deepEqual(f.logs,[{component:'public-countdowns',event:'ready',stage:'ready'}]);
  }finally{dns.lookup=lookup;}
});
test('private selection accepts local Railway IPv6 or 10/8 and rejects wildcards, public IPs, loopback, mapped and non-ULA IPv6',()=>{
  assert.equal(privateAddress(nic('10.2.3.4')),'10.2.3.4');assert.equal(privateAddress(nic('FD12::1')),'FD12::1');
  for(const ip of ['0.0.0.0','::','127.0.0.1','::1','8.8.8.8','192.0.2.1','fc::1','fd::1','fe80::1','::ffff:10.0.0.1'])assert.equal(privateAddress(nic(ip)),null,ip);
  assert.equal(privateAddress({lo:[{address:'fd12::1',internal:true}]}),null);
  assert.throws(()=>privateAddress(nic('fd12::1','fd12::2')),/AMBIGUOUS/);
});
test('bounded interface readiness retry starts only once and never opens public-only health',async()=>{
  const f=fixture();let polls=0,waits=0;
  await start({...f.options,networkInterfaces:()=>++polls<3?{}:interfaces(),wait:async ms=>{assert.equal(ms,1000);assert.equal(f.binds.length,0);waits++;}});
  assert.equal(waits,2);assert.equal(f.created,1);assert.equal(f.logs[0].code,'PRIVATE_INTERFACE_NOT_READY');
  const missing=fixture();waits=0;
  await assert.rejects(start({...missing.options,networkInterfaces:()=>({}),wait:async()=>{waits++;}}),/STARTUP_FAILED/);
  assert.equal(waits,19);assert.equal(missing.created,0);assert.deepEqual(missing.binds,[]);assert.equal(missing.logs.at(-1).code,'PRIVATE_INTERFACE_UNAVAILABLE');
});
test('configuration remains fail closed, names invalid fields safely and never creates a service',async()=>{
  for(const [patch,code] of [
    [{DISCORD_TOKEN:'SECRET-CANARY'},'PRIVATE_CONFIGURATION_PRESENT'],
    [{RAILWAY_PRIVATE_DOMAIN:'public.example.com'},'RAILWAY_PRIVATE_DOMAIN_INVALID'],
    [{COUNTDOWN_PUBLIC_ORIGIN:'https://user:SECRET-CANARY@example.com/private'},'COUNTDOWN_PUBLIC_ORIGIN_INVALID'],
    [{COUNTDOWN_PUBLIC_SYNC_SECRET:'SECRET-CANARY'},'COUNTDOWN_PUBLIC_SYNC_SECRET_INVALID'],
    [{PORT:'3101'},'PUBLIC_PRIVATE_PORT_COLLISION'],[{PORT:'NaN'},'PORT_INVALID'],
    [{COUNTDOWN_SYNC_PORT:'65536'},'COUNTDOWN_SYNC_PORT_INVALID'],[{COUNTDOWN_PUBLIC_GLOBAL_RATE:'0'},'COUNTDOWN_PUBLIC_GLOBAL_RATE_INVALID']
  ]) {
    const f=fixture();await assert.rejects(start({...f.options,env:{...env,...patch}}),/STARTUP_FAILED/);
    assert.equal(f.created,0);assert.equal(f.logs[0].stage,'configuration');assert.equal(f.logs[0].code,code);assert.doesNotMatch(JSON.stringify(f.logs),/SECRET-CANARY|example.com/);
  }
  assert.equal(settings(env).publicPort,3000);
});
test('awaited bind failures clean up both listeners, report the exact stage and do not announce readiness',async()=>{
  for(const name of ['private','public']){
    const f=fixture(name);await assert.rejects(start(f.options),/STARTUP_FAILED/);
    assert.equal(f.closed,1);assert.equal(f.logs.at(-1).stage,name+'-listener');assert.equal(f.logs.at(-1).code,'EADDRINUSE');
    assert.equal(f.binds.length,name==='private'?1:2);assert.doesNotMatch(JSON.stringify(f.logs),/SECRET-CANARY|private\/path|"ready"/);
  }
});
test('storage and unknown errors log only allowlisted codes; exceptions and forged diagnostic fields stay private',async()=>{
  for(const code of ['EACCES','ENOSPC','NOT-SAFE-CANARY']){
    const f=fixture();await assert.rejects(start({...f.options,createService:async()=>{throw Object.assign(Error('SECRET-CANARY'),{code,safeCode:'FORGED-SECRET-CANARY'});}}));
    assert.equal(f.logs.at(-1).stage,'projection-storage');assert.equal(f.logs.at(-1).code,code==='NOT-SAFE-CANARY'?'UNEXPECTED_FAILURE':code);
    assert.doesNotMatch(JSON.stringify(f.logs),/CANARY/);
  }
});
test('runtime listener failures close the service and use sanitized diagnostics',async()=>{
  const f=fixture();let fatal=0;await start({...f.options,onFatal:()=>{fatal++;}});
  f.service.privateServer.emit('error',Object.assign(Error('SECRET-CANARY'),{code:'EIO'}));
  await new Promise(r=>setImmediate(r));assert.equal(f.closed,1);assert.equal(fatal,1);
  assert.deepEqual(f.logs.at(-1),{component:'public-countdowns',event:'listener-failed',stage:'private-listener',code:'EIO'});
});
