'use strict';

// Opt-in: one real local image, two fresh profiles, no mock Hub or provider.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {CreateMoreService} = require('../app/core/service.cjs');
const root = path.resolve(__dirname, '..');
const comfyURL = 'http://127.0.0.1:8188';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(url) { const response = await fetch(url, {signal:AbortSignal.timeout(15000)}); assert(response.ok, 'Local ComfyUI HTTP ' + response.status); return response.json(); }
async function fileHash(file) { return sha(await fs.readFile(file)); }
async function until(fn, label, timeout = 20 * 60 * 1000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error(label + ' timed out; no task was cancelled or resubmitted'); await delay(350); } }
async function node(service, type, fields) { const value = service.newNode(type, fields); service.current.state.nodes.push(value); service.current.dirty = true; service.current.revision++; await service.saveCanvas(); return value; }

// Observe only our newly created HTTP server. Never retain a key, token or body.
function observeWire(service, report, privateText) {
  service.collab.server.prependListener('request', req => {
    if (req.url !== '/rpc') return;
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { const text = Buffer.concat(chunks).toString(), value = JSON.parse(text); report.rpcRequests++;
        if (Object.keys(value).sort().join(',') !== 'box,sid' || typeof value.sid !== 'string' || !value.box || Object.keys(value.box).sort().join(',') !== 'data,iv,tag' || Buffer.from(value.box.iv, 'base64').length !== 12 || Buffer.from(value.box.tag, 'base64').length !== 16) report.invalidEnvelopes++;
        if (privateText.some(v => text.includes(v))) report.plaintextMatches++;
      } catch { report.invalidEnvelopes++; }
    });
  });
}

async function main() {
  if (!process.argv.includes('--run-real-local')) throw new Error('Refusing generation: explicitly supply --run-real-local (one local ComfyUI image only)');
  const base = path.join(root, 'testing-output', 'lan-real-local-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8));
  await fs.mkdir(base, {recursive:true});
  const reportFile = path.join(base, 'report.json'), services = [];
  const report = {ok:false, startedAt:new Date().toISOString(), base, scope:'Two isolated CreateMoreService profiles, real loopback encrypted LAN, real ProviderHub and existing ComfyUI; not a multi-computer test', realLocalGeneration:true, mockProvider:false, videoCalls:0, paidProviderCalls:0, requested:{workflowId:'image-zimage',count:1,width:256,height:256,steps:4,seed:9071821}, wire:{rpcRequests:0,invalidEnvelopes:0,plaintextMatches:0}, events:[]};
  const persist = () => fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  const frozenFiles = ['app/core/service.cjs','app/core/collaboration.cjs','app/core/shared-execution.cjs','app/core/execution-actions.cjs','app/core/queue.cjs','app/core/generation-batch.cjs','app/providers/index.js','app/providers/comfyui.cjs','app/providers/workflows.cjs','resources/workflows/catalog.json','resources/workflows/defaults/image-zimage/current.json'];
  const frozen = Object.fromEntries(await Promise.all(frozenFiles.map(async file => [file,await fileHash(path.join(root,file))])));
  let device, requester;
  try {
    const queue = await json(comfyURL + '/queue');
    report.preflight = {endpoint:comfyURL,running:queue.queue_running.length,pending:queue.queue_pending.length};
    assert.equal(queue.queue_running.length + queue.queue_pending.length, 0, 'Existing ComfyUI is busy; this check does not interrupt other work');
    for (const name of ['device','requester']) {
      const service = await new CreateMoreService({appDir:root,dataDir:path.join(base,name,'profile')}).init();
      services.push(service); await service.hub.ready; assert.equal(service.hub.constructor.name,'ProviderHub');
      await service.hub.configure({comfyui:{url:comfyURL}});
      await service.createProject(path.join(base,name,'project'), 'LAN 实机验证 · ' + name);
    }
    [device,requester] = services;
    assert.notEqual(device.identity.id,requester.identity.id);
    const privateNode = await node(device,'text',{title:'执行设备原私人画布',content:'此卡不得接收远端生成结果'});
    const privateCanvasFile = path.join(device.current.canvasDir,'画布.createmore'), privateCanvasHash = await fileHash(privateCanvasFile);
    await device.createCanvas('仅本次共享验收');
    const sentinel = await node(device,'text',{title:'资源主人卡片',content:'执行资源控制权不赋予发起者此卡编辑权'}), sentinelBefore = structuredClone(sentinel);
    const marker = 'CreateMore_LAN_LIVE_' + crypto.randomUUID();
    const prompt = marker + '. A single matte teal ceramic cup on a warm gray table, soft side light, simple studio photograph, no letters, no logo.';
    const password = crypto.randomBytes(18).toString('base64url');
    const hosting = await device.call('lan.host',{host:'127.0.0.1',port:0,password});
    observeWire(device,report.wire,[marker,password]);
    await requester.call('lan.join',{url:hosting.url,password,host:'127.0.0.1',port:0});
    observeWire(requester,report.wire,[marker,password]);
    assert.equal(device.collab.state.sessionId,requester.collab.state.sessionId);
    assert.equal(device.collab.state.passwordRequired,true);
    assert.equal(device.collab.state.members.filter(m=>m.active).length,2);
    const capabilities = await device.call('execution.capabilities'), capability = capabilities.workflows.find(w=>w.id==='image-zimage');
    assert(capabilities.available && capability?.kinds.includes('image')); assert.equal(capability.maxReferences,0);
    const workflow = await device.workflowRead('default:image-zimage');
    assert.equal(workflow.api['6'].inputs.batch_size,1); assert.equal(workflow.api['10'].class_type,'SaveImage');
    report.workflow = {id:'image-zimage',version:workflow.version,sha256:sha(JSON.stringify(workflow)),mappedParameters:Object.keys(capability.parameters),backendOutputPrefix:workflow.api['10'].inputs.filename_prefix};
    const offer = await device.call('execution.offer',{provider:'comfyui',workflowId:'image-zimage',kind:'image',allowedMembers:[requester.identity.id]});
    const target = await node(requester,'image',{title:'远端本地模型真实回传',prompt,source:'本地 ComfyUI',count:1,ratio:'1:1',quality:'256px'});
    let peakDeviceActive = 0;
    for (const [index,service] of services.entries()) service.queue.on('change', task => {
      if (!task) return;
      if (index===0) peakDeviceActive=Math.max(peakDeviceActive,[...service.queue.controllers.keys()].filter(id=>service.queue.get(id).provider==='comfyui').length);
      const previous=report.events.findLast(e=>e.side===index&&e.taskId===task.id);
      if (!previous || previous.state!==task.state) { report.events.push({side:index,taskId:task.id,provider:task.provider,state:task.state,at:new Date().toISOString()}); process.stdout.write((index===0?'DEVICE ':'REQUESTER ')+task.id+' '+task.state+'\n'); }
    });
    const localTask = await requester.call('execution.submit',{nodeId:target.id,deviceId:device.identity.id,offerId:offer.id,parameters:{width:256,height:256,steps:4,seed:report.requested.seed}});
    report.requester = {identity:requester.identity.id,projectDir:requester.current.projectDir,canvasId:requester.current.id,nodeId:target.id,taskId:localTask.id};
    report.device = {identity:device.identity.id,projectDir:device.current.projectDir,canvasId:device.current.id,offerId:offer.id,privateCanvasFile,privateNodeId:privateNode.id};
    await persist();
    await until(() => ['succeeded','failed','unknown','cancelled'].includes(requester.queue.get(localTask.id).state) && services.every(s=>s.queue.controllers.size===0),'Real shared generation');
    const completed = requester.queue.get(localTask.id);
    report.requester.state=completed.state; report.requester.remoteId=completed.remoteId;
    assert.equal(completed.state,'succeeded',completed.error||completed.message);
    assert.equal(completed.provider,'shared-comfyui'); assert.equal(requester.queue.tasks.length,1); assert.equal(device.queue.tasks.length,1);
    const job = device.gateway.jobs[0], source = device.queue.get(job.taskId);
    assert.equal(job.requesterId,requester.identity.id); assert.equal(job.taskId,completed.remoteId.taskId); assert.equal(completed.remoteId.jobId,job.id);
    assert.equal(source.owner,requester.identity.id); assert.equal(source.snapshot.remoteExecution,true); assert.equal(source.snapshot.canvasId,'gateway:'+requester.identity.id);
    assert.equal(source.provider,'comfyui'); assert.equal(source.state,'succeeded'); assert.equal(device.queue.limit(source),1); assert.equal(peakDeviceActive,1);
    assert.equal(source.snapshot.connection.url,comfyURL); assert.equal(source.snapshot.generationPlan.count,1); assert.equal(source.snapshot.parameters.steps,4);
    const status = await requester.call('execution.status',{deviceId:device.identity.id,jobId:job.id});
    assert.equal(status.outputs.length,1); assert.equal(completed.result.outputs.length,1); assert.equal(source.result.outputs.length,1);
    const applied = requester.current.state.nodes.find(n=>n.id===target.id), asset = requester.current.state.assets.find(a=>a.id===applied.assetId);
    assert.equal(applied.owner,requester.identity.id); assert.equal(asset.owner,requester.identity.id); assert.equal(applied.taskId,localTask.id);
    const registeredPath = await requester.assetPath(asset.id), bytes = await fs.readFile(registeredPath), hashes = {device:await fileHash(source.result.outputs[0].path),wire:status.outputs[0].sha256,download:await fileHash(completed.result.outputs[0].path),registered:sha(bytes),manifest:asset.sha256};
    assert.equal(new Set(Object.values(hashes)).size,1); assert.equal(bytes.subarray(1,4).toString(),'PNG'); assert.equal(bytes.readUInt32BE(16),256); assert.equal(bytes.readUInt32BE(20),256);
    assert.equal(status.outputs[0].seed,report.requested.seed);
    assert.equal((await requester.call('history.list')).filter(h=>h.taskId===localTask.id).length,1);
    assert.equal((await device.call('history.list')).length,0);
    assert.deepEqual(device.current.state.nodes.find(n=>n.id===sentinel.id),sentinelBefore);
    assert.equal(await fileHash(privateCanvasFile),privateCanvasHash);
    const replica = device.current.state.nodes.find(n=>n.id===target.id); assert.equal(replica.owner,requester.identity.id); assert.equal(replica.assetId,asset.id);
    const disk = JSON.parse(await fs.readFile(path.join(requester.current.canvasDir,'画布.createmore'),'utf8')); assert.equal(disk.state.nodes.find(n=>n.id===target.id).assetId,asset.id);
    const history = await json(comfyURL + '/history?max_items=100');
    const matches = Object.entries(history).filter(([,item])=>Object.values(item.prompt?.[2]||{}).some(n=>n.class_type==='CLIPTextEncode'&&n.inputs?.text===prompt));
    assert.equal(matches.length,1,'Exactly one actual ComfyUI prompt contains our unique marker');
    const [promptId,actual] = matches[0]; assert.equal(actual.status.completed,true); assert.equal(actual.prompt[2]['6'].inputs.width,256); assert.equal(actual.prompt[2]['6'].inputs.height,256); assert.equal(actual.prompt[2]['6'].inputs.batch_size,1); assert.equal(actual.prompt[2]['8'].inputs.steps,4); assert.equal(actual.prompt[2]['8'].inputs.seed,report.requested.seed);
    assert.equal(report.wire.invalidEnvelopes,0); assert.equal(report.wire.plaintextMatches,0); assert(report.wire.rpcRequests>0);
    for (const [file,expected] of Object.entries(frozen)) assert.equal(await fileHash(path.join(root,file)),expected,'Production source changed during verification: '+file);
    report.device={...report.device,taskId:source.id,taskOwner:source.owner,jobId:job.id,sourceProvider:source.provider,remoteExecution:source.snapshot.remoteExecution,canvasTarget:source.snapshot.canvasId,queueBucket:device.queue.bucket(source),queueLimit:device.queue.limit(source),peakObservedActive:peakDeviceActive};
    report.output={assetId:asset.id,owner:asset.owner,path:registeredPath,devicePath:source.result.outputs[0].path,bytes:bytes.length,width:256,height:256,sha256:hashes.registered,hashes,seed:status.outputs[0].seed};
    report.comfy={promptId,completed:actual.status.completed,outputs:actual.outputs['10'].images,submittedJobs:matches.length,queueNumber:actual.prompt[0]};
    report.assertions={registeredOnRequester:true,requesterHistorySaved:true,deviceLocalHistoryUntouched:true,originalPrivateCanvasHashUnchanged:true,deviceOwnedSharedCardUnchanged:true,requesterResultReplicatedWithRequesterOwnership:true,productionSourceUnchanged:true};
    report.ok=true;
  } catch(error) { report.error={message:error.message,code:error.code,stack:error.stack}; }
  finally {
    report.cleanup={};
    for (const [index,service] of [...services.entries()].reverse()) { try { await service.close(); report.cleanup[index===0?'deviceClosed':'requesterClosed']=true; } catch(error) { report.cleanup.error=error.message; report.ok=false; } }
    try { const stats=await json(comfyURL+'/system_stats'); report.cleanup.existingComfyStillAvailable=!!stats.system; } catch(error) { report.cleanup.existingComfyStillAvailable=false; report.cleanup.comfyCheckError=error.message; report.ok=false; }
    report.completedAt=new Date().toISOString(); await persist();
  }
  process.stdout.write(JSON.stringify({ok:report.ok,reportFile,output:report.output?.path,comfyPromptId:report.comfy?.promptId,error:report.error?.message})+'\n');
  if(!report.ok)process.exitCode=1;
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
