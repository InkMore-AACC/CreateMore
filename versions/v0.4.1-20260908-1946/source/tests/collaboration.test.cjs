'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {CollaborationService, sharedSnapshot, privateIP} = require('../app/core/collaboration.cjs');

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function peers(t,count,{assets = [],assetData = new Map()} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'createmore-lan-test-')), services = [], snapshots = [], written = [], events = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.dispose()));
    const target = path.resolve(root), prefix = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(target.startsWith(prefix) && path.basename(target).startsWith('createmore-lan-test-'));
    await fs.rm(target,{recursive:true,force:true});
  });
  for (let index = 0; index < count; index++) {
    snapshots[index] = {canvasId:'canvas-test',version:5,nodes:index ? [] : [{id:'host-node',type:'text',owner:'me',title:'主持人的内容',content:'hello',x:0,y:0,w:300,h:200}],edges:[],groups:[],assets:index ? [] : assets,view:{x:index*50,y:0,k:1},chat:[{content:'PRIVATE-CODEX-CHAT'}],settings:{apiKey:'DO-NOT-SHARE'}};
    written[index] = new Map(); events[index] = [];
    const service = new CollaborationService({dataDir:path.join(root,String(index)),pollMs:60000,timeoutMs:700,
      getSnapshot:() => snapshots[index], applySnapshot:(value) => { snapshots[index] = {...snapshots[index],...value}; },
      listAssets:() => index ? [] : assets,readAsset:id => assetData.get(id),writeAsset:(meta,data) => { written[index].set(meta.id,Buffer.from(data)); },onEvent:event => events[index].push(event)});
    await service.ready; services.push(service);
  }
  return {services,snapshots,written,events,root};
}
async function host(service,password = '') { return service.startHosting({port:0,host:'127.0.0.1',password}); }
async function join(service,url,password = '') { return service.join({url,password,port:0,host:'127.0.0.1'}); }
function post(url,route,value,origin) {
  return new Promise((resolve,reject) => { const data = Buffer.from(JSON.stringify(value)); const req = http.request(new URL(route,url),{method:'POST',headers:{'content-type':'application/json','content-length':data.length,...(origin ? {origin} : {})}}, res => { const chunks = []; res.on('data',part => chunks.push(part)); res.on('end',() => resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())})); }); req.on('error',reject); req.end(data); });
}

test('persistent identity is available before sharing and private state is removed',async t => {
  const {services,root} = await peers(t,1), service = services[0], before = service.status().identity;
  assert.equal(service.status().mode,'idle'); assert.ok(before.id); assert.ok(before.color); assert.equal(before.privateKey,undefined);
  const next = new CollaborationService({dataDir:path.join(root,'0')}); await next.ready; services.push(next); assert.deepEqual(next.status().identity,before);
  const shared = sharedSnapshot({nodes:[{id:'a',owner:'me',apiKey:'secret',params:{token:'NO',seed:4},asset:'C:\\private\\a.png'}],view:{x:1},chat:['PRIVATE'],settings:{password:'secret'},groups:[],edges:[]},before.id);
  assert.equal(shared.nodes[0].owner,before.id); assert.deepEqual(shared.nodes[0].params,{seed:4}); assert.ok(!JSON.stringify(shared).includes('secret')); assert.ok(!('view' in shared)); assert.ok(!('chat' in shared)); assert.ok(!('asset' in shared.nodes[0]));
});

test('password challenge, host pinning and browser-origin rejection are enforced',async t => {
  const {services} = await peers(t,2), [a,b] = services, hosting = await host(a,'lan-test-password');
  await assert.rejects(join(b,hosting.url,'wrong'),{code:'PASSWORD'});
  await assert.rejects(b.join({url:hosting.url,password:'lan-test-password',expectedHostId:'00000000'}),{code:'HOST_CHANGED'});
  const result = await post(hosting.url,'/challenge',{},'https://untrusted.example'); assert.equal(result.status,403); assert.equal(result.body.code,'ORIGIN');
  await join(b,hosting.url,'lan-test-password'); assert.equal(b.status().mode,'joined');
  const serialized = JSON.stringify(b.state); assert.ok(!serialized.includes('lan-test-password')); assert.ok(!serialized.includes('DO-NOT-SHARE')); assert.ok(!serialized.includes('PRIVATE-CODEX-CHAT'));
  assert.equal(privateIP('8.8.8.8'),false); assert.equal(privateIP('192.168.1.5'),true); await assert.rejects(b._connect('http://8.8.8.8'),{code:'LAN_ONLY'});
});

test('owner permissions apply to coordinator, members, edges and groups; private view remains local',async t => {
  const {services,snapshots} = await peers(t,2), [a,b] = services, hosting = await host(a); await join(b,hosting.url);
  const bid = b.status().identity.id, aid = a.status().identity.id;
  await b.publish({type:'node.create',node:{id:'member-node',type:'text',title:'成员内容',owner:aid,x:1,y:2,w:300,h:200}});
  assert.equal(a.state.snapshot.nodes.find(n => n.id === 'member-node').owner,bid);
  await assert.rejects(b.publish({type:'node.update',id:'host-node',patch:{title:'illegal'}}),{code:'OWNERSHIP'});
  await assert.rejects(a.publish({type:'node.update',id:'member-node',patch:{title:'illegal'}}),{code:'OWNERSHIP'});
  await assert.rejects(b.publish({type:'node.update',id:'member-node',patch:{owner:aid}}),{code:'OWNERSHIP'});
  await b.publish({type:'edge.create',edge:{id:'edge-reference',from:'host-node',to:'member-node'}});
  await assert.rejects(a.publish({type:'edge.delete',id:'edge-reference'}),{code:'OWNERSHIP'});
  await assert.rejects(b.publish({type:'group.upsert',group:{id:'bad-group',members:['host-node','member-node']}}),{code:'OWNERSHIP'});
  await b.publish({type:'group.upsert',group:{id:'my-group',title:'我的组',members:['member-node']}});
  await b.syncNow(); assert.equal(snapshots[1].view.x,50); assert.equal(snapshots[1].chat[0].content,'PRIVATE-CODEX-CHAT');
});

test('idempotency and stale-revision checks do not duplicate or overwrite nodes',async t => {
  const {services} = await peers(t,2), [a,b] = services, hosting = await host(a); await join(b,hosting.url);
  const op = {type:'node.create',node:{id:'retry-node',type:'text'},idempotencyKey:'retry-123'}; await b.publish(op); await b.publish(op);
  assert.equal(a.state.snapshot.nodes.filter(n => n.id === 'retry-node').length,1);
  await a.publish({type:'node.update',id:'host-node',patch:{title:'newer update'}});const latest=a.state.revision;await b.publish(op);assert.equal(b.state.revision,latest);assert.equal(b.state.snapshot.nodes.find(n=>n.id==='host-node').title,'newer update');
  await assert.rejects(b.publish({...op,node:{id:'another-node',type:'text'}}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(b.publish({type:'node.update',id:'retry-node',patch:{title:'stale'},baseRevision:0}),{code:'CONFLICT'});
  await assert.rejects(b.publish({type:'view.update',view:{x:55}}),/私人视图/);
});

test('full assets are copied, hash-checked, retained after card deletion and synchronized after upload',async t => {
  const data = crypto.randomBytes(700000), assets = [{id:'image-one',name:'source.png',type:'image',path:'C:\\private\\source.png'}], assetData = new Map([['image-one',data]]);
  const {services,written,events} = await peers(t,2,{assets,assetData}), [a,b] = services, hosting = await host(a); await join(b,hosting.url);
  assert.equal(digest(written[1].get('image-one')),digest(data)); assert.ok(events[1].filter(e => e.type === 'asset-progress').length >= 3);
  assert.equal(b.state.manifest[0].path,undefined); assert.equal(b.status().assetsReady,1);
  const created = Buffer.from('member persistent asset'); await b.addAsset({id:'member-asset',name:'notes.txt',type:'text'},created); assert.equal(a.state.manifest.length,2); assert.equal(written[0].get('member-asset').toString(),created.toString());
  await assert.rejects(b.addAsset({id:'image-one',name:'overwrite.png',type:'image'},Buffer.from('illegal')),{code:'OWNERSHIP'});
  await a.publish({type:'node.delete',id:'host-node'}); await b.syncNow(); assert.equal(b.state.manifest.length,2); assert.equal(digest(written[1].get('image-one')),digest(data));
});

test('interleaved uploads cannot overwrite another member after both began the same unused asset id',async t=>{
  const {services,written}=await peers(t,3),[coordinator,a,b]=services,hosting=await host(coordinator);await join(a,hosting.url);await join(b,hosting.url);const assetId='interleaved-asset',first=Buffer.from('first member owns these bytes'),second=Buffer.from('second member must not replace them'),meta=bytes=>({id:assetId,name:'shared.txt',type:'text',size:bytes.length,sha256:digest(bytes)});
  for(const [member,bytes]of [[a,first],[b,second]]){await member._request('asset.begin',{meta:meta(bytes)});await member._request('asset.chunk',{id:assetId,sha256:digest(bytes),offset:0,data:bytes.toString('base64')});}
  await a._request('asset.commit',{id:assetId,sha256:digest(first)});await a.syncNow();await a.publish({type:'node.create',node:{id:'first-member-ref',type:'text',assetId,content:'owner reference'}});const before=structuredClone(coordinator.state.snapshot.nodes),revision=coordinator.state.revision,localFile=(await coordinator.sharedAssetFile(assetId)).path;
  await assert.rejects(b._request('asset.commit',{id:assetId,sha256:digest(second)}),{code:'OWNERSHIP'});assert.equal(coordinator.state.revision,revision);assert.deepEqual(coordinator.state.snapshot.nodes,before);assert.equal(coordinator.state.manifest.find(m=>m.id===assetId).owner,a.identity.id);assert.equal(coordinator.state.manifest.find(m=>m.id===assetId).sha256,digest(first));assert.deepEqual(await fs.readFile(localFile),first);assert.deepEqual(written[0].get(assetId),first);assert.deepEqual(await fs.readFile((await coordinator.sharedAssetFile(assetId)).path),first);
});

test('interrupted asset transfer resumes at its saved chunk offset',async t => {
  const data = crypto.randomBytes(600000), {services,written} = await peers(t,2,{assets:[{id:'resume',name:'large.bin',type:'other'}],assetData:new Map([['resume',data]])}), [a,b] = services, hosting = await host(a);
  const request = b._request.bind(b); let blocked = true; const offsets = [];
  b._request = async (method,params,...rest) => { if (method === 'asset.read') { offsets.push(params.offset); if (params.offset >= 262144 && blocked) { blocked = false; throw Object.assign(new Error('simulated interrupted transfer'),{code:'NETWORK'}); } } return request(method,params,...rest); };
  await assert.rejects(join(b,hosting.url),/simulated/); assert.equal(b.status().assetsReady,0); await b.syncNow();
  assert.deepEqual(offsets.slice(0,3),[0,262144,262144]); assert.equal(digest(written[1].get('resume')),digest(data)); assert.equal(b.status().assetsReady,1);
});

test('password change invalidates current sessions and requires the new password',async t => {
  const {services} = await peers(t,2), [a,b] = services, hosting = await host(a,'old-pass'); await join(b,hosting.url,'old-pass');
  await a.changePassword('new-pass'); await assert.rejects(b.syncNow(),{code:'REAUTH'}); await assert.rejects(join(b,hosting.url,'old-pass'),{code:'PASSWORD'});
  await join(b,hosting.url,'new-pass'); assert.equal(b.status().mode,'joined');
});

test('stop sharing persists a tombstone and never removes copied assets or permits takeover',async t => {
  const data = Buffer.from('retained'), {services,written} = await peers(t,2,{assets:[{id:'keep',name:'keep.txt',type:'text'}],assetData:new Map([['keep',data]])}), [a,b] = services, hosting = await host(a); await join(b,hosting.url);
  await a.stopSharing(); await b.syncNow(); assert.equal(b.status().mode,'stopped'); assert.equal(written[1].get('keep').toString(),'retained');
  await assert.rejects(b.takeover(),{code:'STOPPED'}); await assert.rejects(b.publish({type:'node.create',node:{id:'no'}}),{code:'STOPPED'});
});

test('quorum-backed manual takeover works with two of three members and fences old epochs',async t => {
  const {services} = await peers(t,3), [a,b,c] = services, hosting = await host(a); await join(b,hosting.url); await join(c,hosting.url); await b.syncNow();
  await assert.rejects(b.takeover(),{code:'HOST_ALIVE'});
  await a.dispose(); await assert.rejects(b.syncNow()); await assert.rejects(c.syncNow());
  const taken = await b.takeover({password:'replacement'}); assert.equal(taken.mode,'hosting'); assert.equal(taken.epoch,2); assert.equal(c.state.epoch,2);
  await join(c,taken.url,'replacement'); await c.publish({type:'node.create',node:{id:'after-takeover',type:'text'}}); assert.ok(b.state.snapshot.nodes.some(n => n.id === 'after-takeover'));
  await assert.rejects(c._rpc({sessionId:c.state.sessionId,epoch:1,method:'publish',params:{}},a.identity.id),{code:'EPOCH'});
});

test('two-member partition blocks unsafe takeover and coordinator writes without majority',async t => {
  const {services} = await peers(t,2), [a,b] = services, hosting = await host(a); await join(b,hosting.url); await b.dispose();
  await assert.rejects(a.publish({type:'node.update',id:'host-node',patch:{title:'uncertain'}}),{code:'NO_QUORUM'}); assert.equal(a.status().pendingWrite,true); assert.equal(a.state.snapshot.nodes[0].title,'主持人的内容');
  await assert.rejects(a.publish({type:'node.update',id:'host-node',patch:{title:'different'}}),{code:'UNCERTAIN_WRITE'});
  await a.dispose(); b.mode = 'disconnected'; await assert.rejects(b.takeover(),{code:'NO_QUORUM'});
});

test('batch failure is atomic and repeated ordinary edits reuse authentication without rate-limit failure',async t=>{
  const {services}=await peers(t,2),[a,b]=services,hosting=await host(a);await join(b,hosting.url);const revision=a.state.revision;
  await assert.rejects(b.publish({type:'batch',operations:[{type:'node.create',node:{id:'batch-part',type:'text'}},{type:'node.update',id:'host-node',patch:{title:'not allowed'}}]}),{code:'OWNERSHIP'});assert.equal(a.state.revision,revision);assert.ok(!a.state.snapshot.nodes.some(n=>n.id==='batch-part'));
  for(let index=0;index<40;index++)await a.publish({type:'node.update',id:'host-node',patch:{x:index}});assert.equal(b.state.snapshot.nodes[0].x,39);assert.equal(a.status().pendingWrite,false);
});
