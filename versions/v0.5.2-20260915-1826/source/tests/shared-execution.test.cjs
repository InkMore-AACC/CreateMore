'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {CollaborationService}=require('../app/core/collaboration.cjs');
const {SharedExecutionGateway}=require('../app/core/shared-execution.cjs');
const {TaskQueue}=require('../app/core/queue.cjs');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+4000;while(!await fn()){if(Date.now()>end)assert.fail('Timed out waiting for test queue');await sleep(5);}}
async function setup(t,{count=3,run,withAsset=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'createmore-shared-execution-')),lans=[],gateways=[],queues=[],received=[];
  t.after(async()=>{for(const queue of queues){await until(()=>queue.controllers.size===0);await queue.close();}for(const gateway of gateways)await gateway.close();await Promise.all(lans.map(lan=>lan.dispose()));assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('createmore-shared-execution-'));await fs.rm(root,{recursive:true,force:true});});
  for(let index=0;index<count;index++){
    const lan=new CollaborationService({dataDir:path.join(root,String(index),'lan'),getSnapshot:()=>({canvasId:'shared-generation-canvas',nodes:[],edges:[],groups:[],assets:index===0&&withAsset?[{id:'reference',name:'ref.png',type:'image'}]:[]}),listAssets:()=>index===0&&withAsset?[{id:'reference',name:'ref.png',type:'image'}]:[],readAsset:()=>Buffer.from('shared reference bytes'),pollMs:60000,timeoutMs:700});await lan.ready;lans.push(lan);
    const queue=await new TaskQueue({dataDir:path.join(root,String(index),'queue'),run:async(snapshot,options)=>{received.push({index,snapshot});if(run)return run(snapshot,options,index);options.onProgress({remoteId:'test-provider-'+index,progress:42,message:'actual queue test progress'});const source=snapshot.references[0]?await fs.readFile(snapshot.references[0].path,'utf8'):'no reference';const file=path.join(snapshot.outputDir,'result.png');await fs.writeFile(file,'output from '+source);return {outputs:[{path:file,type:'image'}],text:'test provider response'};},cancel:async()=>({cancelled:true}),onResult:async task=>{assert.equal(task.snapshot.remoteExecution,true);}}).init();queues.push(queue);
    const gateway=new SharedExecutionGateway({dataDir:path.join(root,String(index),'gateway'),collaboration:lan,describeProvider:async()=>({available:true,kinds:['image'],inputTypes:['image','text'],parameters:{seed:{type:'integer',minimum:0,maximum:100},steps:{type:'integer',minimum:1,maximum:40},apiKey:{type:'string'}},workflows:[{id:'local-image-binding',name:'本机图片工作流',kinds:['image']}],apiKey:'NEVER-BROADCAST-CREDENTIAL'}),resolveWorkflow:async(id,kind)=>({id,kind,api:{'1':{class_type:'TestDeviceWorkflow',inputs:{credential:'DEVICE-ONLY-SECRET'}}}}),submitTask:(snapshot,owner)=>queue.submit(snapshot,owner),getTask:id=>queue.get(id),cancelTask:(id,owner)=>queue.cancel(id,owner),pauseResource:(id,paused)=>queue.pauseResource(id,paused)});await gateway.ready;gateways.push(gateway);
  }
  const hosted=await lans[0].startHosting({host:'127.0.0.1',port:0,password:'gateway-test'});for(const lan of lans.slice(1))await lan.join({url:hosted.url,password:'gateway-test',host:'127.0.0.1',port:0});for(const lan of lans.slice(1))await lan.syncNow();return {root,lans,gateways,queues,received};
}
const reference=(extra={})=>({assetId:'reference',sha256:crypto.createHash('sha256').update('shared reference bytes').digest('hex'),size:Buffer.byteLength('shared reference bytes'),...extra});
const request=(lan,offer,extra={})=>({deviceId:lan.identity.id,offerId:offer.id,kind:'image',prompt:'test prompt',parameters:{seed:3,steps:2},references:[reference()],...extra});

test('explicit offer exposes only device capability and real queue result is downloaded with integrity checks',async t=>{
  const {root,lans,gateways,queues,received}=await setup(t),[a,b]=gateways;const empty=await b.listOffers();assert.equal(empty.devices.flatMap(d=>d.offers).length,0);
  const offer=await a.offer({workflowId:'local-image-binding',kind:'image',allowedMembers:[lans[1].identity.id]});const discovered=await b.listOffers();assert.ok(discovered.devices.find(d=>d.deviceId===lans[0].identity.id).offers.some(o=>o.id===offer.id));assert.ok(!JSON.stringify(discovered).includes('CREDENTIAL'));assert.ok(!JSON.stringify(discovered).includes('apiKey'));
  const submitted=await b.submitRemote(request(lans[0],offer,{requestId:'one-generation'}));assert.ok(submitted.jobId);assert.ok(submitted.taskId);await until(()=>queues[0].get(submitted.taskId).state==='succeeded');const state=await b.remoteStatus(submitted);assert.equal(state.state,'succeeded');assert.equal(state.outputs.length,1);assert.equal(state.text,'test provider response');assert.ok(!JSON.stringify(state).includes(root));assert.equal(received[0].snapshot.references[0].id,'reference');assert.equal(received[0].snapshot.remoteExecution,true);assert.equal(queues[0].get(submitted.taskId).owner,lans[1].identity.id);
  const saved=await b.downloadResults({...submitted,outputDir:path.join(root,'requester-results')});assert.equal(await fs.readFile(saved.outputs[0].path,'utf8'),'output from shared reference bytes');assert.match(saved.outputs[0].sha256,/^[a-f0-9]{64}$/);assert.equal(saved.remote.jobId,submitted.jobId);
  await b.submitRemote(request(lans[0],offer,{requestId:'one-generation'}));assert.equal(queues[0].tasks.length,1,'same request never runs twice');
});

test('member whitelist, task ownership, parameter capabilities and arbitrary workflow/path injection are rejected',async t=>{
  const {lans,gateways,queues}=await setup(t),[a,b,c]=gateways;const offer=await a.offer({workflowId:'local-image-binding',kind:'image',allowedMembers:[lans[1].identity.id]});
  await assert.rejects(c.submitRemote(request(lans[0],offer)),{code:'FORBIDDEN'});await assert.rejects(b.submitRemote(request(lans[0],offer,{parameters:{seed:999}})),{code:'CAPABILITY'});await assert.rejects(b.submitRemote(request(lans[0],offer,{kind:'video'})),{code:'CAPABILITY'});
  const raw={offerId:offer.id,kind:'image',prompt:'test',parameters:{},references:[],requestId:'injected',requestCanvasId:'shared-generation-canvas',workflow:{api:'arbitrary'},outputDir:'C:\\private'};await assert.rejects(lans[1].callMember(lans[0].identity.id,'resource.submit',raw),{code:'CAPABILITY'});
  await assert.rejects(a.offer({provider:'codex',workflowId:'local-image-binding',kind:'image'}),{code:'ACCOUNT_CONSENT_REQUIRED'});
  const submitted=await b.submitRemote(request(lans[0],offer));await until(()=>queues[0].get(submitted.taskId).state==='succeeded');await assert.rejects(c.remoteStatus(submitted),{code:'FORBIDDEN'});await assert.rejects(c.cancelRemote(submitted),{code:'FORBIDDEN'});
});

test('stop offer blocks new jobs without cancelling existing work; device owner can stop its task explicitly',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {root,lans,gateways,queues}=await setup(t,{count:2,run:async(snapshot,options)=>{await Promise.race([gate,new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true}))]);const file=path.join(snapshot.outputDir,'retained.png');await fs.writeFile(file,'retained output');return {outputs:[{path:file,type:'image'}]};}}),[a,b]=gateways;const offer=await a.offer({workflowId:'local-image-binding',kind:'image'}),submitted=await b.submitRemote(request(lans[0],offer));await until(()=>queues[0].get(submitted.taskId).state==='running');await a.stopOffer(offer.id);assert.equal(queues[0].get(submitted.taskId).state,'running');await assert.rejects(b.submitRemote(request(lans[0],offer)),{code:'OFFER_STOPPED'});
  release();await until(()=>queues[0].get(submitted.taskId).state==='succeeded');await lans[0].stopSharing();const saved=await b.downloadResults({...submitted,outputDir:path.join(root,'after-stop')});assert.equal(await fs.readFile(saved.outputs[0].path,'utf8'),'retained output');
});

test('device queue remains serial, requester cancellation is real and resource owner controls only device dispatch',async t=>{
  let active=0,maxActive=0;const releases=[];t.after(()=>releases.forEach(release=>release()));
  const {lans,gateways,queues}=await setup(t,{count:2,run:async(snapshot,options)=>{active++;maxActive=Math.max(maxActive,active);try{await new Promise((resolve,reject)=>{releases.push(resolve);options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('confirmed test cancellation'),{name:'AbortError'})),{once:true});});const file=path.join(snapshot.outputDir,'done.png');await fs.writeFile(file,'done');return {outputs:[{path:file,type:'image'}]};}finally{active--;}}}),[a,b]=gateways,offer=await a.offer({workflowId:'local-image-binding',kind:'image'});
  await a.pauseDevice('comfyui',true);const first=await b.submitRemote(request(lans[0],offer));const second=await b.submitRemote(request(lans[0],offer));assert.equal(queues[0].get(first.taskId).state,'queued');await a.pauseDevice('comfyui',false);await until(()=>queues[0].get(first.taskId).state==='running');assert.equal(queues[0].get(second.taskId).state,'queued');
  const cancelled=await b.cancelRemote(first);assert.equal(cancelled.state,'cancelled');await until(()=>queues[0].get(second.taskId).state==='running');const ownerCancelled=await a.cancelDeviceTask(second.jobId);assert.equal(ownerCancelled.state,'cancelled');await until(()=>queues[0].controllers.size===0);assert.equal(maxActive,1);
});

test('result outside device job output directory is never readable by another member',async t=>{
  let forbiddenFile;const {root,lans,gateways,queues}=await setup(t,{count:2,run:async()=>({outputs:[{path:forbiddenFile,type:'image'}]})});forbiddenFile=path.join(root,'not-task-secret.txt');await fs.writeFile(forbiddenFile,'must not leak');const [a,b]=gateways,offer=await a.offer({workflowId:'local-image-binding',kind:'image'}),job=await b.submitRemote(request(lans[0],offer));await until(()=>queues[0].get(job.taskId).state==='succeeded');await assert.rejects(b.remoteStatus(job),{code:'RESULT_SCOPE'});
});

test('a non-coordinator device executes another member request using local credentials and synchronized inputs',async t=>{
  const {root,lans,gateways,queues,received}=await setup(t),[_,device,requester]=gateways;const offer=await device.offer({workflowId:'local-image-binding',kind:'image'});const job=await requester.submitRemote(request(lans[1],offer));await until(()=>queues[1].get(job.taskId).state==='succeeded');assert.equal(queues[0].tasks.length,0);assert.equal(queues[1].tasks[0].owner,lans[2].identity.id);assert.equal(received[0].index,1);assert.ok(JSON.stringify(received[0].snapshot.workflow).includes('DEVICE-ONLY-SECRET'));const out=await requester.downloadResults({...job,outputDir:path.join(root,'third-member-results')});assert.equal(await fs.readFile(out.outputs[0].path,'utf8'),'output from shared reference bytes');
});

test('named input ids are checked against actual device mapping and output port ids survive verified download',async t=>{
  const {root,lans,gateways,queues,received}=await setup(t,{count:2,run:async(snapshot)=>{const file=path.join(snapshot.outputDir,'right.png');await fs.writeFile(file,'right output');return {outputs:[{path:file,type:'image',outputId:'right-result',seed:3}]};}}),[device,requester]=gateways;
  const ports=[{id:'left',index:0,mediaType:'image',required:true},{id:'right',index:1,mediaType:'image',required:true}];
  device.describeProvider=async()=>({available:true,kinds:['image'],workflows:[{id:'ports',name:'Two ports',kinds:['image'],referenceInputs:ports,maxReferences:2,minReferences:2,inputTypes:['image'],parameters:{}}]});
  device.resolveWorkflow=async()=>({api:{'1':{class_type:'Fake',inputs:{}}},mapping:{inputs:ports.map(p=>({...p,source:'reference'})),outputs:[{id:'right-result',nodeId:'1',key:'images',type:'image'}]}});
  const offer=await device.offer({workflowId:'ports'}),base={deviceId:lans[0].identity.id,offerId:offer.id,kind:'image',prompt:'ports',parameters:{},references:[reference({inputId:'right'}),reference({inputId:'left'})]};
  await assert.rejects(requester.submitRemote({...base,references:[reference({inputId:'left'}),reference({inputId:'left'})]}),{code:'CAPABILITY'});
  await assert.rejects(requester.submitRemote({...base,references:[reference({inputId:'not-a-port'}),reference({inputId:'left'})]}),{code:'CAPABILITY'});
  await assert.rejects(requester.submitRemote({...base,references:[reference({inputId:'../../private'}),reference({inputId:'left'})]}),{code:'CAPABILITY'});
  const job=await requester.submitRemote(base);await until(()=>queues[0].get(job.taskId).state==='succeeded');assert.deepEqual(received[0].snapshot.references.map(r=>r.inputId),['right','left']);const out=await requester.downloadResults({...job,outputDir:path.join(root,'named-results')});assert.equal(out.outputs[0].outputId,'right-result');assert.equal(out.outputs[0].seed,3);
  device.resolveWorkflow=async()=>({api:{'1':{class_type:'Fake',inputs:{}}},mapping:{inputs:[{id:'changed',source:'reference',required:true,index:0,mediaType:'image'}],outputs:[]}});await assert.rejects(requester.submitRemote(base),{code:'CAPABILITY'});assert.equal(queues[0].tasks.length,1);
});

test('a published reference version change or legacy unpinned reference is rejected without device generation',async t=>{
  const {lans,gateways,queues}=await setup(t,{count:2}),[device,requester]=gateways,offer=await device.offer({workflowId:'local-image-binding',kind:'image'}),frozen=request(lans[0],offer);
  await assert.rejects(requester.submitRemote({...frozen,references:[{assetId:'reference'}]}),{code:'REFERENCE_VERSION_REQUIRED'});await lans[0].addAsset({id:'reference',name:'ref.png',type:'image'},Buffer.from('owner updated version after request was frozen'));await assert.rejects(requester.submitRemote(frozen),{code:'ASSET_VERSION'});assert.equal(queues[0].tasks.length,0);
});

test('device validates the copied reference bytes and later source changes cannot alter a submitted snapshot',async t=>{
  const {lans,gateways,queues,received}=await setup(t,{count:2}),[device,requester]=gateways,offer=await device.offer({workflowId:'local-image-binding',kind:'image'}),original=lans[0].sharedAssetFile.bind(lans[0]),asset=await original('reference');
  lans[0].sharedAssetFile=async id=>{const found=await original(id);await fs.writeFile(found.path,'changed between check and copy');return found;};await assert.rejects(requester.submitRemote(request(lans[0],offer)),{code:'ASSET_VERSION'});assert.equal(queues[0].tasks.length,0);await fs.writeFile(asset.path,'shared reference bytes');lans[0].sharedAssetFile=original;
  const resolve=device.resolveWorkflow;device.resolveWorkflow=async(...args)=>{await fs.writeFile(asset.path,'changed after independent copy');return resolve(...args);};const job=await requester.submitRemote(request(lans[0],offer));await until(()=>queues[0].get(job.taskId).state==='succeeded');assert.equal(received.length,1);assert.notEqual(received[0].snapshot.references[0].path,asset.path);assert.equal(await fs.readFile(received[0].snapshot.references[0].path,'utf8'),'shared reference bytes');assert.equal(await fs.readFile(queues[0].get(job.taskId).result.outputs[0].path,'utf8'),'output from shared reference bytes');
});
