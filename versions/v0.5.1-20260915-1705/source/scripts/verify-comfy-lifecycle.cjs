'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
async function main(){
  if(!process.argv.includes('--run-local'))throw new Error('需要 --run-local');
  const occupied=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:8189});socket.setTimeout(2000);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});});if(occupied)throw new Error('8189 已被占用，未动已有实例');
  const config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore/providers.json'),'utf8')).comfyui;
  const p=new ComfyProvider({...config,url:'http://127.0.0.1:8189'}),report={ok:false,url:p.url,at:new Date().toISOString()};
  try{report.started=await p.start();assert.ok(p.owned);report.pid=p.owned.pid;report.release=await p.releaseMemory();report.stopped=await p.stopOwned();assert.equal(report.stopped.stopped,true);report.final=await p.status();assert.equal(report.final.ready,false);report.ok=true;}
  catch(e){report.error=e.stack;process.exitCode=1;}
  finally{if(p.owned)report.cleanup=await p.stopOwned().catch(e=>({error:e.message}));await fs.writeFile(path.resolve('testing-output/comfy-lifecycle.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
