"use strict";
const {spawn}=require('node:child_process'),path=require('node:path');
module.exports=bytes=>new Promise((resolve,reject)=>{
  const child=spawn('python3',[path.join(__dirname,'venue.py')],{stdio:['pipe','pipe','pipe']}),chunks=[];let size=0;
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)child.kill('SIGKILL');else chunks.push(chunk);});
  child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);code===0&&size>0&&size<=2*1024*1024?resolve(Buffer.concat(chunks)):reject(Error('Public venue preview could not be prepared'));});child.stdin.end(bytes);
});
