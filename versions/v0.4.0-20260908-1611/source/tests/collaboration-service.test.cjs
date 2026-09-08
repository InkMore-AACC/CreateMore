'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {CreateMoreService}=require('../app/core/service.cjs');

async function setup(t,count=2){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'createmore-service-lan-')),services=[];
  t.after(async()=>{for(const s of services)await s.close();const target=path.resolve(root);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('createmore-service-lan-'));await fs.rm(target,{recursive:true,force:true});});
  for(let i=0;i<count;i++){const hub={async run(){throw new Error('No generation is used in LAN tests');},async status(){return {};},async close(){},async cancel(){return {cancelled:false};},async reconcile(){return {state:'unknown'};}};const service=await new CreateMoreService({appDir:path.join(root,String(i),'app'),dataDir:path.join(root,String(i),'data'),hub}).init();services.push(service);service.collab.pollMs=60000;service.collab.timeoutMs=700;await service.createProject(path.join(root,String(i),'project'),'成员'+i);}
  return {root,services};
}
async function connect(a,b){const hosted=await a.call('lan.host',{host:'127.0.0.1',port:0,password:'test-pass'});await b.call('lan.join',{url:hosted.url,password:'test-pass',host:'127.0.0.1',port:0});return hosted;}

test('service LAN maps local owners, preserves private canvas, and commits multiple changes atomically',async t=>{
  const {services}=await setup(t),[a,b]=services;
  const hostNode=a.newNode('text',{title:'主持人文本'});a.current.state.nodes.push(hostNode);
  const original=b.current,privateNode=b.newNode('text',{title:'私人未共享'});original.state.nodes.push(privateNode);original.state.view.x=456;
  await connect(a,b);assert.notEqual(b.current.id,original.id);assert.ok(original.state.nodes.some(n=>n.title==='私人未共享'));assert.ok(!a.collab.state.snapshot.nodes.some(n=>n.title==='私人未共享'));
  let view=await b.view();assert.equal(view.state.nodes[0].owner,a.identity.id);const own=b.newNode('text',{title:'成员自己的卡片'});view.state.nodes.push({...own,owner:'me'});view.state.edges.push({id:'mine-edge',from:hostNode.id,to:own.id});view.state.view.x=730;
  const before=a.collab.state.revision;await b.updateCanvas(view.state,{revision:view.revision});assert.equal(a.collab.state.revision,before+1);assert.equal(a.current.state.nodes.find(n=>n.id===own.id).owner,b.identity.id);assert.equal(b.current.state.nodes.find(n=>n.id===own.id).owner,b.identity.id);assert.equal((await b.view()).state.nodes.find(n=>n.id===own.id).owner,'me');assert.equal(b.current.state.view.x,730);assert.notEqual(a.current.state.view.x,730);
  view=await a.view();view.state.nodes.find(n=>n.id===own.id).title='主持人不能强改';await assert.rejects(a.updateCanvas(view.state,{revision:view.revision}),{code:'FORBIDDEN'});
  await assert.rejects(b.openCanvas(original.projectDir,original.id),{code:'LAN_CANVAS_LOCKED'});
  const nodesBefore=a.current.state.nodes.length;view=await b.view();view.state.nodes.push({...b.newNode('text',{id:'bad-batch',title:'不能局部提交'}),owner:'me'});view.state.edges.push({id:'unauthorized-edge',from:'bad-batch',to:hostNode.id});await assert.rejects(b.updateCanvas(view.state,{revision:view.revision}));assert.equal(a.current.state.nodes.length,nodesBefore);
});

test('service LAN downloads stable material copies, retains host external paths, and synchronizes new imports',async t=>{
  const {root,services}=await setup(t),[a,b]=services,source=path.join(root,'reference.png');await fs.writeFile(source,'first real disk asset');await a.importAsset(source,{copy:false});const assetId=a.current.state.nodes[0].assetId;
  await connect(a,b);assert.equal(await a.assetPath(assetId),source);const replica=await b.assetPath(assetId);assert.ok(replica.startsWith(b.current.canvasDir+path.sep));assert.notEqual(replica,source);assert.equal(await fs.readFile(replica,'utf8'),'first real disk asset');assert.equal(b.current.state.nodes[0].assetId,assetId);assert.match((await b.view()).state.nodes[0].asset,/^createmore-media:/);
  const retainedPath=b.current.state.assets.find(x=>x.id===assetId).path;
  const incoming=await a.view();incoming.state.nodes[0].title='远端修改不会冲掉本地素材路径';await a.updateCanvas(incoming.state,{revision:incoming.revision});await b.collab.syncNow();assert.equal(b.current.state.assets.find(x=>x.id===assetId).path,retainedPath);assert.equal(await fs.readFile(await b.assetPath(assetId),'utf8'),'first real disk asset');
  const ownFile=path.join(root,'member.png');await fs.writeFile(ownFile,'new own asset');await b.importAsset(ownFile,{copy:false});await b.syncSharedAssets(b.current);await a.collab._syncAssets?.();
  const ownNode=b.current.state.nodes.find(n=>n.owner===b.identity.id);assert.ok(ownNode?.assetId,'addAsset callback cannot remove freshly imported node');assert.ok(a.current.state.nodes.some(n=>n.id===ownNode.id));assert.equal(await fs.readFile(await a.assetPath(ownNode.assetId),'utf8'),'new own asset');
  await a.saveCanvas();await b.saveCanvas();const stored=JSON.parse(await fs.readFile(path.join(b.current.canvasDir,'画布.createmore'),'utf8'));assert.equal(stored.state.nodes[0].assetId,assetId);assert.ok(stored.state.assets.find(x=>x.id===assetId).path);
});

test('late callbacks stay on their bound canvas after sharing stops and user opens another canvas',async t=>{
  const {services}=await setup(t),[a,b]=services;const node=a.newNode('text',{title:'source'});a.current.state.nodes.push(node);await connect(a,b);const bound=b.current;
  await a.call('lan.stop');await b.collab.syncNow();const created=await b.createCanvas('停止共享后的新画布');assert.equal(b.current.id,created.id);
  const delayed=JSON.parse(JSON.stringify(b.collab.state.snapshot));delayed.nodes[0].title='迟到回调只更新旧绑定';await b.applyShared(delayed,{reason:'simulated-delayed'});assert.equal(b.current.state.nodes.length,0);assert.equal(bound.state.nodes[0].title,'迟到回调只更新旧绑定');
});
