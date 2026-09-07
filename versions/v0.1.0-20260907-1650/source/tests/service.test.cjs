'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CreateMoreService } = require('../app/core/service.cjs');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, message = 'condition', timeout = 4000) { const started = Date.now(); while (!predicate()) { if (Date.now() - started > timeout) assert.fail('Timed out: ' + message); await new Promise(resolve => setTimeout(resolve, 5)); } }
function hub(overrides = {}) { return { async prepare(snapshot) { return {...snapshot,connection:{frozen:true}}; }, async run() { return { text: 'mock result' }; }, async reconcile() { return { state: 'unknown' }; }, async cancel() { return { cancelled: false }; }, async status() { return {}; }, async configure() {}, async close() {}, ...overrides }; }
async function setup(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'createmore-service-'));
  const options = { appDir: path.join(root, 'app'), dataDir: path.join(root, 'data'), hub: hub(overrides) };
  const service = await new CreateMoreService(options).init();
  const services = [service];
  t.after(async () => { for (const active of services) { await until(() => !active.queue.controllers.size, 'test providers finish'); await active.close(); } assert.ok(path.basename(root).startsWith('createmore-service-')); await fs.rm(root, { recursive: true, force: true }); });
  const created = await service.call('project.create', { directory: path.join(root, 'project'), name: '集成测试项目' });
  return { root, service, created, options, services };
}
async function add(service, type = 'text', fields = {}) {
  const result = await service.agentTool('canvas_create', { type, title: '测试节点', prompt: 'test prompt', ...fields });
  return service.current.state.nodes.find(node => node.id === result.nodeId);
}

test('service uses persistent collaboration identity, saves and reopens project/canvas', async t => {
  const { service, options, created, services } = await setup(t);
  const node = await add(service); const identity = service.identity.id;
  assert.notEqual(identity, 'me'); assert.equal(node.owner, identity);
  const view = await service.call('canvas.get'); assert.equal(view.state.nodes[0].owner, 'me');
  view.state.nodes[0].title = '已保存名称'; await service.call('canvas.update', { state: view.state, revision: view.revision }); await service.call('canvas.save');
  await service.call('canvas.create', { name: '第二画布' }); assert.equal(service.current.state.nodes.length, 0);
  await service.close();
  const reopened = await new CreateMoreService(options).init(); services.push(reopened);
  await reopened.call('project.open', { directory: created.project.projectDir });
  assert.equal(reopened.identity.id, identity); assert.equal(reopened.current.state.nodes[0].title, '已保存名称'); assert.equal((await reopened.call('canvas.list')).length, 2);
});

test('external and copied assets render through capability URLs but persist actual paths', async t => {
  const { root, service } = await setup(t);
  const original = path.join(root, 'external.png'); await fs.writeFile(original, 'real-file-bytes');
  let view = await service.call('asset.import', { path: original, copy: false });
  assert.match(view.state.nodes[0].asset, /^createmore-media:\/\/asset\//); assert.equal(service.current.state.assets[0].external, true);
  await service.call('canvas.update', { state: view.state, revision: view.revision }); await service.call('canvas.save');
  let stored = JSON.parse(await fs.readFile(path.join(service.current.canvasDir, 'canvas.json'), 'utf8'));
  assert.equal(stored.state.nodes[0].asset, original); assert.equal(stored.state.assets[0].asset, original);
  view = await service.call('asset.import', { path: original, copy: true }); await service.call('canvas.update', { state: view.state, revision: view.revision }); await service.call('canvas.save');
  stored = JSON.parse(await fs.readFile(path.join(service.current.canvasDir, 'canvas.json'), 'utf8'));
  assert.match(stored.state.nodes[1].asset, /^image\//); assert.equal(stored.state.assets[1].external, false); assert.equal(JSON.stringify(stored).includes('createmore-media:'), false);
  assert.equal(await fs.readFile(await service.call('asset.path', { id: stored.state.assets[1].id }), 'utf8'), 'real-file-bytes');
});

test('relink preserves unsaved edits and refuses different bytes under an existing asset identity', async t => {
  const {root,service}=await setup(t),before=path.join(root,'old.png'),after=path.join(root,'new.png');await fs.writeFile(before,'same image bytes');await service.call('asset.import',{path:before});await service.saveCanvas();const view=await service.view();view.state.nodes[0].prompt='unsaved latest creative input';await service.call('canvas.update',{state:view.state,revision:view.revision});await fs.rename(before,after);const assetId=service.current.state.assets[0].id;const result=await service.call('asset.relink',{id:assetId,path:after});assert.equal(result.view.state.nodes[0].prompt,'unsaved latest creative input');assert.equal((await service.store.loadCanvas(service.current.projectDir,service.current.id)).state.nodes[0].prompt,'unsaved latest creative input');const different=path.join(root,'different.png');await fs.writeFile(different,'different bytes');await assert.rejects(service.call('asset.relink',{id:assetId,path:different}),e=>e.code==='ASSET_CONTENT_MISMATCH');assert.equal(await service.assetPath(assetId),after);
});

test('result recovery retries required shared publication even when local result was already committed', async t => {
  const {service}=await setup(t);const n=await add(service);let calls=0,events=0;const original=service.syncSharedAssets.bind(service);service.syncSharedAssets=async()=>{calls++;if(calls<3)throw new Error('LAN publication interrupted');};service.on('event',event=>{if(event.type==='result')events++;});const submitted=await service.submitNode(n.id);await until(()=>service.queue.get(submitted.id).state==='failed'&&!service.queue.controllers.size);assert.equal(calls,1);assert.equal(events,0);await assert.rejects(service.queue.reconcile(submitted.id,service.identity.id),/publication interrupted/);assert.equal(calls,2);assert.notEqual(service.queue.get(submitted.id).state,'succeeded');await service.queue.reconcile(submitted.id,service.identity.id);assert.equal(calls,3);assert.equal(events,1);assert.equal(service.queue.get(submitted.id).state,'succeeded');assert.equal(service.current.state.nodes.length,1);const history=await service.call('history.list');assert.equal(history.filter(h=>h.taskId===submitted.id).length,1);service.syncSharedAssets=original;
});

test('partial-result recovery uses actual output identities, not shifted list positions',async t=>{
  const {service,root}=await setup(t);const node=await add(service,'image'),files=['one.png','two.png','three.png'].map(n=>path.join(root,n));for(const file of files)await fs.writeFile(file,path.basename(file));const task={id:'partial-recovery',owner:service.identity.id,nodeId:node.id,canvasId:service.current.id,projectDir:service.current.projectDir,provider:'image2',snapshot:{},title:'partial'};service.queue.tasks.push(task);node.taskId=task.id;
  await service.applyResult(task,{outputs:[{path:files[0],type:'image'},{path:files[2],type:'image'}],partial:true});const former=[...node.outputAssets];
  await service.applyResult(task,{outputs:files.map(file=>({path:file,type:'image'}))});assert.equal(node.outputAssets[0],former[0]);assert.equal(node.outputAssets[2],former[1]);assert.notEqual(node.outputAssets[1],former[1]);assert.equal(await fs.readFile(await service.assetPath(node.outputAssets[1]),'utf8'),'two.png');assert.equal(service.current.state.assets.length,3);
});

test('completed storyboard ranges with unchanged frame count still produce the recovered version',async t=>{
  const {service}=await setup(t);const source=await add(service,'video'),task={id:'analysis-recovery',owner:service.identity.id,nodeId:source.id,canvasId:service.current.id,projectDir:service.current.projectDir,provider:'storyboard',title:'analysis',snapshot:{resultMode:'storyboard',sourceNodeId:source.id}};service.queue.tasks.push(task);
  const partial={outputs:[],text:'[]',partial:true,storyboard:{shots:[{index:0,description:'first complete range'}],errors:[{start:3,end:6}],version:'original'}};await service.applyResult(task,partial);const first=service.current.state.nodes.find(n=>n.type==='script');first.shots[0].description='user manually revised';
  const complete={...partial,partial:false,storyboard:{...partial.storyboard,shots:[{index:0,description:'first complete range'},{index:1,description:'recovered range'}],errors:[]}};await service.applyResult(task,complete);assert.equal(service.current.state.nodes.filter(n=>n.type==='script').length,2);assert.equal(first.shots[0].description,'user manually revised');await service.applyResult(task,complete);assert.equal(service.current.state.nodes.filter(n=>n.type==='script').length,2);
});

test('Agent updates validate all fields before changing memory and can explicitly select Image2',async t=>{
  const {service}=await setup(t),node=await add(service,'image');const title=node.title;await assert.rejects(service.agentTool('canvas_update',{id:node.id,patch:{title:'must not partially apply',owner:'another'}}));assert.equal(node.title,title);await service.agentTool('canvas_update',{id:node.id,patch:{source:'Codex Image2',parameters:{seed:123},count:2}});assert.equal(node.source,'Codex Image2');assert.equal(node.count,2);await assert.rejects(service.agentTool('canvas_update',{id:node.id,patch:{parameters:{nested:{connection:'forbidden'}}}}));assert.equal(node.parameters.seed,123);const video=await add(service,'video');await assert.rejects(service.agentTool('canvas_update',{id:video.id,patch:{source:'Codex Image2'}}),{code:'CAPABILITY_MISMATCH'});
});

test('private Agent and MCP advertise the same named-port contract',async()=>{
  const {tools}=require('../app/core/agent-tools.cjs'),mcp=require('../app/mcp.cjs');assert.deepEqual(mcp.tools,tools);const connect=tools.find(tool=>tool.name==='canvas_connect');assert.equal(connect.inputSchema.properties.inputId.type,'string');assert.equal(connect.inputSchema.properties.outputId.type,'string');assert.ok(tools.some(tool=>tool.name==='canvas_tasks'));
});

test('storyboard frame export only reads registered images, not arbitrary project-supplied paths',async t=>{const {service,root}=await setup(t);const image=path.join(root,'allowed.png'),secret=path.join(root,'unregistered.png');await fs.writeFile(image,'allowed');await fs.writeFile(secret,'do not read');await service.call('asset.import',{path:image,copy:false});const asset=service.current.state.assets[0];assert.equal(await service.resolveFrame(image),image);assert.equal(await service.resolveFrame(service.mediaURL(image)),image);await assert.rejects(service.resolveFrame(secret),{code:'FRAME_NOT_REGISTERED'});await assert.rejects(service.resolveFrame('../../unregistered.png'),{code:'FRAME_NOT_REGISTERED'});assert.equal(await service.resolveFrame(asset.path),image);});

test('mock-provider image result is registered, persisted and associated with real history', async t => {
  let invocations = 0;
  const { service } = await setup(t, { async run(snapshot, { onProgress }) { invocations++; onProgress({ remoteId: 'mock-image-one', message: 'actual test provider output' }); const file = path.join(snapshot.outputDir, 'test-output.png'); await fs.writeFile(file, 'mock-image-content'); return { outputs: [{ path: file, type: 'image' }] }; } });
  const node = await add(service, 'image');
  const submitted = await service.call('task.submit', { nodeId: node.id });
  await until(() => service.queue.get(submitted.id).state === 'succeeded' && !service.queue.controllers.size, 'result persisted');
  assert.equal(invocations, 1); const savedNode = service.current.state.nodes.find(item => item.id === node.id); assert.ok(savedNode.assetId); assert.match(savedNode.asset, /^image\//);
  const asset = service.current.state.assets.find(item => item.id === savedNode.assetId); assert.equal(asset.external, false); assert.equal(asset.generated, true);
  assert.equal(await fs.readFile(await service.assetPath(asset.id), 'utf8'), 'mock-image-content');
  const history = await service.call('history.list'); assert.equal(history.length, 1); assert.equal(history[0].taskId, submitted.id); assert.equal(history[0].applied, true);
  const disk = JSON.parse(await fs.readFile(path.join(service.current.canvasDir, 'canvas.json'), 'utf8')); assert.equal(disk.state.nodes[0].assetId, asset.id);
});

test('late task result goes to original canvas after user switches canvases', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { service } = await setup(t, { async run() { await gate.promise; return { text: 'result on original' }; } });
  const node = await add(service), originalId = service.current.id, projectDir = service.current.projectDir;
  const task = await service.call('task.submit', { nodeId: node.id });
  const second = await service.call('canvas.create', { name: '新画布' }); gate.resolve();
  await until(() => service.queue.get(task.id).state === 'succeeded' && !service.queue.controllers.size);
  assert.equal(service.current.id, second.id); assert.equal(service.current.state.nodes.length, 0);
  await service.call('canvas.open', { projectDir, id: originalId }); assert.equal(service.current.state.nodes[0].content, 'result on original');
});

test('deleted node is not resurrected by late result and result history survives', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { service } = await setup(t, { async run() { await gate.promise; return { text: 'kept in history' }; } });
  const node = await add(service), task = await service.call('task.submit', { nodeId: node.id });
  const view = await service.view(); view.state.nodes = []; await service.updateCanvas(view.state, { revision: view.revision }); gate.resolve();
  await until(() => service.queue.get(task.id).state === 'succeeded' && !service.queue.controllers.size);
  assert.equal(service.current.state.nodes.length, 0); const history = await service.call('history.list'); assert.equal(history[0].text, 'kept in history'); assert.equal(history[0].applied, false);
});

test('owner permissions reject modifying others but allow own edit beside untouched peer node', async t => {
  const { service } = await setup(t); const own = await add(service);
  const foreign = service.newNode('text', { id: 'other-node', owner: 'other-member', title: '只读卡片' }); service.current.state.nodes.push(foreign);
  let view = await service.view(); view.state.nodes.find(node => node.id === own.id).title = '自己的修改';
  await service.updateCanvas(view.state, { revision: view.revision });
  view = await service.view(); view.state.nodes.find(node => node.id === foreign.id).title = '越权修改';
  await assert.rejects(service.updateCanvas(view.state), { code: 'FORBIDDEN' });
  await assert.rejects(service.agentTool('canvas_update', { id: foreign.id, patch: { title: '越权' } }), { code: 'FORBIDDEN' });
  await assert.rejects(service.agentTool('canvas_connect', { from: own.id, to: foreign.id }));
  await assert.rejects(service.submitNode(foreign.id)); assert.equal(service.queue.tasks.length, 0);
  assert.equal(service.current.state.nodes.find(node => node.id === own.id).title, '自己的修改');
});

test('revision conflict is rejected and disabled local Skill never reaches mock Codex', async t => {
  let invocations = 0;
  const { service } = await setup(t, { async run() { invocations++; return { text: 'response', threadId: 'test-thread' }; } });
  const stale = await service.view(); await add(service);
  await assert.rejects(service.updateCanvas(stale.state, { revision: stale.revision }), { code: 'REVISION_CONFLICT' });
  const skill = await service.call('resource.save', { kind: 'skills', data: { name: '停用技能', content: '# Skill\nDo a method' } });
  await service.call('resource.enabled', { kind: 'skills', id: skill.id, enabled: false });
  await assert.rejects(service.call('agent.send', { text: 'test', skillIds: [skill.id] }), { code: 'SKILL_DISABLED' }); assert.equal(invocations, 0);
});

test('result association retry after save failure must persist node instead of trusting history entry', async t => {
  const { service } = await setup(t, { async run() { return { text: 'must survive restart' }; } });
  const node = await add(service); await service.saveCanvas();
  const originalSave = service.store.saveCanvas.bind(service.store); let failedOnce = false;
  service.store.saveCanvas = async (...args) => { if (!failedOnce && args[2].appliedTaskIds?.length) { failedOnce = true; throw new Error('injected first result-association save failure'); } return originalSave(...args); };
  const task = await service.submitNode(node.id); await until(() => service.queue.get(task.id).state === 'failed' && !service.queue.controllers.size);
  await service.queue.reconcile(task.id, service.identity.id); assert.equal(service.queue.get(task.id).state, 'succeeded');
  const disk = JSON.parse(await fs.readFile(path.join(service.current.canvasDir, 'canvas.json'), 'utf8'));
  assert.equal(disk.state.nodes[0].content, 'must survive restart'); assert.equal((await service.call('history.list')).length, 1);
});

test('persisted pending result survives an actual service restart after canvas save failure', async t => {
  let runs = 0;
  const { service, options, services, created } = await setup(t, { async run() { runs++; return { text: 'recover across restart' }; } });
  const node = await add(service); await service.saveCanvas();
  service.store.saveCanvas = async () => { throw new Error('injected persistent disk failure'); };
  const task = await service.submitNode(node.id); await until(() => service.queue.get(task.id).state === 'failed' && !service.queue.controllers.size);
  await service.close();
  const restarted = await new CreateMoreService(options).init(); services.push(restarted); await restarted.openProject(created.project.projectDir);
  await restarted.queue.reconcile(task.id, restarted.identity.id);
  assert.equal(restarted.queue.get(task.id).state, 'succeeded'); assert.equal(runs, 1);
  const disk = JSON.parse(await fs.readFile(path.join(restarted.current.canvasDir, 'canvas.json'), 'utf8'));
  assert.equal(disk.state.nodes[0].content, 'recover across restart');
});

test('node submit cannot override trusted canvas, owner, output path, or resume foreign Codex thread', async t => {
  const { service, root } = await setup(t); const node = await add(service);
  const overrides = { nodeId: 'foreign-node', canvasId: 'foreign-canvas', projectDir: root, outputDir: root, threadId: 'outside-createmore-thread' };
  await assert.rejects(service.buildSnapshot(node.id, overrides));
  assert.equal(service.queue.tasks.length, 0);
});

test('chat rejects unknown Codex thread before provider invocation', async t => {
  let runs = 0;
  const { service } = await setup(t, { async run() { runs++; return { text: 'never' }; } });
  await assert.rejects(service.chat({ text: 'continue', threadId: 'another-application-thread' }), { code: 'FORBIDDEN' });
  assert.equal(runs, 0);
});

test('late Agent tool call stays bound to originating canvas after canvas switch', async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const { service } = await setup(t, { async run(_snapshot, options) { entered.resolve(); await gate.promise; await options.onToolCall('canvas_create', { type: 'text', title: 'Agent原画布结果' }); return { text: 'done', threadId: 'known-created-thread' }; } });
  const originalId = service.current.id, projectDir = service.current.projectDir;
  const pending = service.chat({ text: 'create note' }); await entered.promise;
  const next = await service.createCanvas('切换后的画布'); gate.resolve();
  let rejected = false; try { await pending; } catch { rejected = true; }
  assert.equal(service.current.id, next.id); assert.equal(service.current.state.nodes.length, 0, 'old chat cannot mutate newly selected canvas');
  await service.openCanvas(projectDir, originalId);
  assert.ok(rejected || service.current.state.nodes.some(node => node.title === 'Agent原画布结果'));
});

test('generic canvas update cannot reassign immutable asset identity to different file bytes', async t => {
  const { service, root } = await setup(t);
  const original = path.join(root, 'original.png'), other = path.join(root, 'other.png'); await fs.writeFile(original, 'original'); await fs.writeFile(other, 'replacement');
  const view = await service.importAsset(original, { copy: false });
  service.current.state.nodes[0].owner = 'peer';
  const incoming = await service.view(); incoming.state.assets[0].asset = other; incoming.state.assets[0].path = other;
  await assert.rejects(service.updateCanvas(incoming.state, { revision: incoming.revision }));
  assert.equal(await service.assetPath(view.state.assets[0].id), original);
});

test('ordinary video node cannot select Codex Image2 through an override', async t => {
  const { service } = await setup(t); const video = await add(service, 'video');
  await assert.rejects(service.buildSnapshot(video.id, { provider: 'image2' }));
});

test('shared undo preserves newly changed peer nodes, peer inputs and retained media', async t => {
  const { service } = await setup(t); const own = await add(service);
  const peer = service.newNode('text', { id: 'peer-card', owner: 'peer-id', title: 'peer original' }); service.current.state.nodes.push(peer);
  const { Graph } = require('../app/ui/canvas-model.js'); const graph = new Graph((await service.view()).state);
  graph.checkpoint(); graph.get(own.id).title = 'own edited'; graph.get(peer.id).title = 'peer newest';
  graph.state.assets.push({ id: 'later-output', asset: 'image/later.png' }); graph.state.edges.push({ id: 'peer-input', from: own.id, to: peer.id });
  assert.equal(graph.undo(), true); assert.equal(graph.get(own.id).title, '测试节点'); assert.equal(graph.get(peer.id).title, 'peer newest');
  assert.equal(graph.state.edges[0].id, 'peer-input'); assert.equal(graph.state.assets[0].id, 'later-output');
});

test('task association advances revision so stale canvas state cannot erase running task identity', async t => {
  const { service } = await setup(t); const node = await add(service);
  await service.queue.pauseQueue('codex', service.identity.id);
  const stale = await service.view(); const task = await service.submitNode(node.id);
  await assert.rejects(service.updateCanvas(stale.state, { revision: stale.revision }), { code: 'REVISION_CONFLICT' });
  assert.equal(service.current.state.nodes[0].taskId, task.id);
  await service.queue.cancel(task.id, service.identity.id);
});

test('script conversion tool creates one editable storyboard and retains original text and output',async t=>{
  const rows=[{duration:'3s',description:'人物走近窗口',prompt:'逆光全景',camera:'缓慢推进',dialogue:'你好'}];
  const {service}=await setup(t,{async run(snapshot){assert.match(snapshot.prompt,/只返回JSON数组/);return {state:'completed',text:JSON.stringify(rows)};}});
  const source=await add(service,'text',{content:'原剧本文字',prompt:'原剧本文字'}),before=JSON.stringify(source);const task=await service.submitTool({nodeId:source.id,tool:'剧本转分镜'});
  await until(()=>['succeeded','failed'].includes(service.queue.get(task.id).state));assert.equal(service.queue.get(task.id).state,'succeeded');assert.equal(service.current.state.nodes.length,2);
  const script=service.current.state.nodes.find(n=>n.type==='script');assert.ok(script);assert.equal(script.shots[0].description,rows[0].description);assert.equal(script.shots[0].camera,'缓慢推进');assert.equal(script.sourceNodeId,source.id);assert.equal(JSON.stringify(source),before);
  await service.applyResult(service.queue.get(task.id),service.queue.get(task.id).result);assert.equal(service.current.state.nodes.length,2);const stored=await service.store.loadCanvas(service.current.projectDir,service.current.id);assert.equal(stored.state.nodes.find(n=>n.type==='script').shots[0].dialogue,'你好');
});
test('unparseable script conversion retains the original model text visibly instead of claiming an empty storyboard',async t=>{
  const {service}=await setup(t,{async run(){return {state:'completed',text:'需要补充主角的信息才能拆分镜头。'};}});const source=await add(service,'text');const task=await service.submitTool({nodeId:source.id,tool:'剧本转分镜'});await until(()=>['succeeded','failed'].includes(service.queue.get(task.id).state));const result=service.current.state.nodes.find(n=>n.sourceNodeId===source.id);assert.equal(result.type,'text');assert.match(result.title,/格式待整理/);assert.match(result.content,/补充主角/);assert.equal(service.current.state.nodes.filter(n=>n.type==='script').length,0);
});
test('local storyboard card uses the text default binding and preserves JSON output contract',async t=>{
  const {service}=await setup(t);const node=await add(service,'script');service.settings.bindings={text:'default:chosen-text'};service.workflowRead=async key=>({id:key,api:{},mapping:{inputs:[],outputs:[]}});const snapshot=await service.buildSnapshot(node.id,{provider:'comfyui'});assert.equal(snapshot.workflowId,'default:chosen-text');assert.equal(snapshot.workflow.id,'default:chosen-text');assert.equal(snapshot.kind,'text');assert.match(snapshot.prompt,/仅返回JSON数组/);
});
