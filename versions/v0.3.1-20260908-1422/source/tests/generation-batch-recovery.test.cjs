'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {prepare,ImageBatchRunner}=require('../app/core/generation-batch.cjs');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const workflow={api:{'1':{class_type:'Fake',inputs:{seed:7,batch_size:1}}},gui:null,mapping:{inputs:[{id:'seed',source:'parameter',nodeId:'1',input:'seed',type:'integer',min:0,max:99}],outputs:[{id:'image',nodeId:'1',key:'images',type:'image'}]}};
async function fixture(t,count=1){const root=await fs.mkdtemp(path.join(os.tmpdir(),'createmore-batch-recovery-'));t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('createmore-batch-recovery-'));await fs.rm(root,{recursive:true,force:true});});const snapshot=prepare({provider:'comfyui',kind:'image',prompt:'frozen prompt',parameters:{count,seed:7},workflow,outputDir:path.join(root,'outputs')});const create=overrides=>new ImageBatchRunner({dataDir:root,run:async()=>assert.fail('unexpected submission'),reconcile:async()=>assert.fail('unexpected reconciliation'),cancel:async()=>({state:'unknown'}),...overrides});const read=()=>fs.readFile(create({}).file(snapshot.generationPlan),'utf8').then(JSON.parse);return {root,snapshot,create,read};}
async function output(o,seed){const file=path.join(o.outputDir,'result.png');await fs.mkdir(o.outputDir,{recursive:true});await fs.writeFile(file,'saved seed '+seed);return {state:'completed',outputs:[{path:file,type:'image',outputId:'image'}]};}
const uncertain=e=>e.uncertain===true;

test('queued and every unconfirmed source state preserve the original receipt across repeated process restarts',async t=>{
  for(const state of ['queued','running','unknown','cancel-requested','completed-remote','not-running','unsupported','provider-new-state'])await t.test(state,async t=>{const {snapshot,create,read}=await fixture(t);let runs=0,checks=0;
    const run=async(s,o)=>{runs++;o.onProgress({remoteId:'original-7'});throw Object.assign(new Error('lost wait'),{uncertain:true});};
    await assert.rejects(create({run}).execute(snapshot),uncertain);
    for(let i=0;i<2;i++){const reconcile=async(s,r)=>{checks++;assert.equal(r.remoteId,'original-7');assert.equal(s.parameters.seed,7);return {state};};await assert.rejects(create({run,reconcile}).execute(snapshot,{},true),uncertain);assert.equal((await read()).current.remote.remoteId,'original-7');}
    const result=await create({run,reconcile:async(s,r,o)=>{assert.equal(r.remoteId,'original-7');return output(o,s.parameters.seed);}}).execute(snapshot,{},true);assert.equal(result.outputs.length,1);assert.equal(runs,1);assert.equal(checks,2);
  });
});

test('actual Comfy download failure retries only original history/view, retaining successful rounds and frozen seeds',async t=>{
  const {snapshot,create,read}=await fixture(t,3);const originalWebSocket=global.WebSocket;global.WebSocket=undefined;t.after(()=>global.WebSocket=originalWebSocket);
  const submitted=[],historyIds=[],downloads=[];let failDownload=true;
  const fetcher=async(url,options={})=>{const u=new URL(url);if(u.pathname==='/object_info')return Response.json({Fake:{input:{required:{seed:['INT',{min:0,max:99}],batch_size:['INT',{min:1,max:1}]}}}});
    if(u.pathname==='/prompt'){const api=JSON.parse(options.body).prompt;submitted.push(api['1'].inputs.seed);return Response.json({prompt_id:'original-'+api['1'].inputs.seed});}
    if(u.pathname.startsWith('/history/')){const remoteId=u.pathname.split('/').at(-1);historyIds.push(remoteId);return Response.json({[remoteId]:{status:{completed:true},outputs:{'1':{images:[{filename:remoteId+'.png',type:'output'}]}}}});}
    if(u.pathname==='/view'){const name=u.searchParams.get('filename');downloads.push(name);if(name==='original-8.png'&&failDownload)return new Response('mock download unavailable',{status:503});return new Response('real downloaded mock bytes '+name,{headers:{'content-type':'image/png'}});}
    assert.fail('Unexpected mock endpoint '+u.pathname);
  };
  const provider=new ComfyProvider({url:'http://batch.invalid'},{fetch:fetcher});const adapter={run:(s,o)=>provider.run(s,o),reconcile:(s,r,o)=>provider.reconcile(s,r,o)};
  await assert.rejects(create(adapter).execute(snapshot),e=>e.code==='DOWNLOAD_FAILED'&&e.uncertain);let saved=await read();const first=saved.results[0].outputs[0].path;assert.equal(await fs.readFile(first,'utf8'),'real downloaded mock bytes original-7.png');assert.deepEqual(submitted,[7,8]);assert.equal(saved.current.remote.remoteId,'original-8');
  await assert.rejects(create(adapter).execute(snapshot,{},true),uncertain);assert.deepEqual(submitted,[7,8]);assert.equal((await read()).current.remote.remoteId,'original-8');
  failDownload=false;const result=await create(adapter).execute(snapshot,{},true);assert.deepEqual(submitted,[7,8,9]);assert.deepEqual(result.generations.map(g=>g.seed),[7,8,9]);assert.equal(result.outputs[0].path,first);assert.equal(result.outputs.length,3);assert.equal(downloads.filter(x=>x==='original-7.png').length,1);assert.equal(historyIds.filter(x=>x==='original-8').length,3);
});

test('receipt on thrown errors is persisted and disk/write errors cannot become new attempts',async t=>{
  for(const code of ['ENOSPC','EACCES','DOWNLOAD_FAILED','OUTPUT_MISSING','IMAGE_OUTPUT_MISSING','HTTP_ERROR'])await t.test(code,async t=>{const {snapshot,create,read}=await fixture(t);let runs=0;const run=async()=>{runs++;throw Object.assign(new Error(code),{code,remoteId:'receipt-in-error'});};await assert.rejects(create({run}).execute(snapshot),uncertain);assert.equal((await read()).current.remote.remoteId,'receipt-in-error');const result=await create({run,reconcile:async(s,r,o)=>{assert.equal(r.remoteId,'receipt-in-error');return output(o,s.parameters.seed);}}).execute(snapshot,{},true);assert.equal(result.outputs.length,1);assert.equal(runs,1);});
});

test('ordinary errors without a receipt remain uncertain, while explicit pre-submission failure permits a deliberate retry',async t=>{
  const {snapshot,create,read}=await fixture(t);let runs=0;const run=async()=>{runs++;throw new Error('socket closed without a receipt');};await assert.rejects(create({run}).execute(snapshot),uncertain);await assert.rejects(create({run}).execute(snapshot,{},true),e=>e.code==='GENERATION_RECEIPT_MISSING');assert.equal(runs,1);assert.equal((await read()).current.status,'unknown');
  const safe=await fixture(t);let attempts=0;const safeRun=async(s,o)=>{attempts++;if(attempts===1)throw Object.assign(new Error('blocked before dispatch'),{beforeSubmission:true,code:'LOCAL_VALIDATION_FAILED'});return output(o,s.parameters.seed);};await assert.rejects(safe.create({run:safeRun}).execute(safe.snapshot),e=>!e.uncertain);const result=await safe.create({run:safeRun}).execute(safe.snapshot,{},true);assert.equal(result.outputs.length,1);assert.equal(attempts,2);assert.equal((await safe.read()).attempts[0].status,'not-submitted');
});

test('confirmed failed receipts require a later explicit retry and keep prior successful rounds plus attempt audit',async t=>{
  const {snapshot,create,read}=await fixture(t,2);snapshot.sharedRequest={parameters:{seed:7,count:2}};const seeds=[],requestIds=[];let fail=true;
  const run=async(s,o)=>{seeds.push(s.parameters.seed);requestIds.push(s.sharedRequest.requestId);o.onProgress({remoteId:'remote-'+s.parameters.seed});if(s.parameters.seed===8&&fail)throw Object.assign(new Error('uncertain'),{uncertain:true});return output(o,s.parameters.seed);};
  await assert.rejects(create({run}).execute(snapshot),uncertain);
  const partial=await create({run,reconcile:async()=>({state:'failed',message:'confirmed node failure'})}).execute(snapshot,{},true);assert.equal(partial.partial,true);assert.equal(partial.outputs.length,1);assert.deepEqual(seeds,[7,8]);assert.equal((await read()).current.remote.remoteId,'remote-8');assert.equal((await read()).current.status,'failed');
  await assert.rejects(create({run}).execute(snapshot,{retryFailed:false},true),{code:'EXECUTION_FAILED'});assert.deepEqual(seeds,[7,8]);
  fail=false;const result=await create({run}).execute(snapshot,{},true);assert.equal(result.outputs.length,2);assert.deepEqual(seeds,[7,8,8]);assert.equal(requestIds[2],requestIds[1]+'-attempt-2');const saved=await read();assert.equal(saved.attempts[0].remote.remoteId,'remote-8');assert.equal(saved.attempts[0].seed,8);
});

test('explicit execution failure and submission rejection are retryable without leaving known failed work permanently unknown',async t=>{
  for(const code of ['EXECUTION_FAILED','SUBMISSION_REJECTED'])await t.test(code,async t=>{const {snapshot,create,read}=await fixture(t);let runs=0;const run=async(s,o)=>{runs++;if(runs===1){o.onProgress({remoteId:'first-attempt'});throw Object.assign(new Error('explicit source rejection'),{code});}return output(o,s.parameters.seed);};await assert.rejects(create({run}).execute(snapshot),e=>e.code===code&&!e.uncertain);assert.equal((await read()).current.status,'failed');await create({run}).execute(snapshot,{},true);assert.equal(runs,2);assert.equal((await read()).attempts[0].remote.remoteId,'first-attempt');});
});

test('reconciled cancellation returns saved successful images for queue association without submitting missing rounds',async t=>{
  const {snapshot,create,read}=await fixture(t,3);let runs=0;const run=async(s,o)=>{runs++;o.onProgress({remoteId:'remote-'+s.parameters.seed});if(s.parameters.seed===8)throw Object.assign(new Error('uncertain'),{uncertain:true});return output(o,s.parameters.seed);};await assert.rejects(create({run}).execute(snapshot),uncertain);
  const result=await create({run,reconcile:async()=>({state:'cancelled'})}).execute(snapshot,{},true);assert.equal(result.state,'completed');assert.equal(result.partial,true);assert.equal(result.cancelled,true);assert.equal(result.outputs.length,1);assert.equal(runs,2);assert.equal((await read()).current.status,'cancelled');const restored=await create({run}).execute(snapshot,{},true);assert.equal(restored.cancelled,true);assert.equal(runs,2);
});

test('inactive batch cancellation returns saved partial output and persists the exact confirmed cancelled remote',async t=>{
  const {snapshot,create,read}=await fixture(t,2);const run=async(s,o)=>{o.onProgress({remoteId:'remote-'+s.parameters.seed});if(s.parameters.seed===8)throw Object.assign(new Error('uncertain'),{uncertain:true});return output(o,s.parameters.seed);};await assert.rejects(create({run}).execute(snapshot),uncertain);const runner=create({cancel:async r=>{assert.equal(r.remoteId,'remote-8');return {state:'cancelled'};}});const result=await runner.cancel({provider:'comfyui',remoteId:{type:'image-batch',id:snapshot.generationPlan.id}});assert.equal(result.state,'completed');assert.equal(result.cancelled,true);assert.equal(result.outputs.length,1);assert.equal((await read()).cancelled,true);
});

test('legacy failed records whose receipt was already discarded cannot silently become new submissions',async t=>{
  const {snapshot,create}=await fixture(t);const runner=create({});await fs.mkdir(runner.directory,{recursive:true});const plan=snapshot.generationPlan;await fs.writeFile(runner.file(plan),JSON.stringify({id:plan.id,count:plan.count,seeds:plan.seeds,prompt:snapshot.prompt,results:[],errors:[{index:0,seed:7,message:'old download failure'}],current:null}));await assert.rejects(runner.execute(snapshot,{},true),e=>e.code==='GENERATION_RECEIPT_MISSING'&&e.uncertain);
});
