'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TaskQueue } = require('../app/core/queue.cjs');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(predicate, message = 'condition', timeout = 3500) { const started = Date.now(); while (!predicate()) { if (Date.now() - started > timeout) assert.fail('Timed out: ' + message); await new Promise(resolve => setTimeout(resolve, 5)); } }
const snapshot = (overrides = {}) => ({ provider: 'comfyui', resourceId: 'local-a', canvasId: 'canvas-a', nodeId: 'node-a', projectDir: 'project-a', kind: 'text', prompt: 'original', parameters: { seed: 1 }, ...overrides });
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'createmore-queue-'));
  const queue = new TaskQueue({ dataDir: root, run: async () => ({ text: 'done' }), ...options });
  const errors = []; queue.on('internalError', error => errors.push(error)); await queue.init();
  t.after(async () => { await queue.close(); await until(() => queue.controllers.size === 0, 'all test providers settle'); assert.deepEqual(errors, []); assert.ok(path.basename(root).startsWith('createmore-queue-')); await fs.rm(root, { recursive: true, force: true }); });
  return { queue, root };
}

test('each ComfyUI instance serializes while distinct instances may execute together', async t => {
  const release = deferred(), started = [], active = new Map(), maximum = new Map();
  t.after(() => release.resolve());
  const { queue } = await setup(t, { run: async task => {
    started.push(task.resourceId); active.set(task.resourceId, (active.get(task.resourceId) || 0) + 1); maximum.set(task.resourceId, Math.max(maximum.get(task.resourceId) || 0, active.get(task.resourceId)));
    await release.promise; active.set(task.resourceId, active.get(task.resourceId) - 1); return { text: 'done' };
  } });
  await queue.pauseQueue('comfyui', 'owner-a');
  const one = await queue.submit(snapshot(), 'owner-a'), two = await queue.submit(snapshot(), 'owner-a'), three = await queue.submit(snapshot({ resourceId: 'local-b' }), 'owner-a');
  await queue.pauseQueue('comfyui', 'owner-a', false);
  await until(() => started.length === 2, 'two independent instances start');
  assert.equal(queue.get(two.id).state, 'queued'); assert.equal(queue.get(one.id).state, 'running'); assert.equal(queue.get(three.id).state, 'running');
  release.resolve(); await until(() => queue.tasks.every(task => task.state === 'succeeded') && !queue.controllers.size);
  assert.equal(maximum.get('local-a'), 1); assert.equal(maximum.get('local-b'), 1);
});

test('external provider concurrency respects configured cap and freezes submission inputs', async t => {
  const release = deferred(), received = [];
  t.after(() => release.resolve());
  const { queue } = await setup(t, { limits: { image2: 2 }, run: async input => { received.push(input); await release.promise; return { text: 'done' }; } });
  const input = snapshot({ provider: 'image2' });
  const first = await queue.submit(input, 'owner'); input.prompt = 'edited later'; input.parameters.seed = 9;
  await queue.submit(snapshot({ provider: 'image2' }), 'owner'); const third = await queue.submit(snapshot({ provider: 'image2' }), 'owner');
  await until(() => received.length === 2); assert.equal(queue.get(third.id).state, 'queued'); assert.equal(queue.get(first.id).snapshot.prompt, 'original'); assert.equal(queue.get(first.id).snapshot.parameters.seed, 1);
  release.resolve(); await until(() => queue.tasks.every(task => task.state === 'succeeded') && !queue.controllers.size);
});

test('owner queue pause does not stop another member; queued task pause/cancel never invokes provider', async t => {
  const called = [];
  const { queue } = await setup(t, { run: async input => { called.push(input.prompt); return { text: 'done' }; } });
  await queue.pauseQueue('codex', 'a');
  const mine = await queue.submit(snapshot({ provider: 'codex', prompt: 'a' }), 'a');
  const theirs = await queue.submit(snapshot({ provider: 'codex', prompt: 'b' }), 'b');
  await until(() => queue.get(theirs.id).state === 'succeeded'); assert.deepEqual(called, ['b']);
  await assert.rejects(queue.pause(mine.id, 'b'), { code: 'FORBIDDEN' });
  await queue.pause(mine.id, 'a'); assert.equal(queue.get(mine.id).state, 'paused');
  await queue.resume(mine.id, 'a'); assert.equal(queue.get(mine.id).state, 'queued');
  await queue.cancel(mine.id, 'a'); assert.equal(queue.get(mine.id).state, 'cancelled'); assert.deepEqual(called, ['b']);
  await assert.rejects(queue.remove(mine.id, 'b'), { code: 'FORBIDDEN' }); await queue.remove(mine.id, 'a');
  assert.equal(queue.list().length, 1); assert.equal(queue.list({ includeRemoved: true }).length, 2);
});

test('running tasks cannot be paused, and unknown provider state prevents duplicate scheduling', async t => {
  const gate = deferred(); let runs = 0, reconciles = 0;
  t.after(() => gate.resolve());
  const { queue } = await setup(t, { run: async () => { runs++; await gate.promise; return { state: 'unknown' }; }, reconcile: async () => { reconciles++; return { text: 'recovered output' }; } });
  const first = await queue.submit(snapshot(), 'a'); const second = await queue.submit(snapshot(), 'a');
  await until(() => queue.get(first.id).state === 'running'); await assert.rejects(queue.pause(first.id, 'a'));
  gate.resolve(); await until(() => queue.get(first.id).state === 'unknown' && !queue.controllers.size);
  assert.equal(queue.get(second.id).state, 'queued'); assert.equal(runs, 1);
  await queue.reconcile(first.id, 'a'); assert.equal(reconciles, 1);
  await until(() => queue.get(second.id).state === 'unknown' && !queue.controllers.size);
  assert.equal(runs, 2); assert.equal(queue.get(first.id).state, 'succeeded');
});

test('confirmed cancel remains cancelled when local provider reacts with AbortError', async t => {
  const { queue } = await setup(t, { run: (_snapshot, { signal, onProgress }) => new Promise((resolve, reject) => {
    onProgress({ remoteId: 'remote-123', message: 'running' });
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted locally'), { name: 'AbortError' })), { once: true });
  }), cancel: async request => { assert.equal(request.remoteId, 'remote-123'); return { cancelled: true }; } });
  const task = await queue.submit(snapshot(), 'owner'); await until(() => queue.get(task.id).remoteId === 'remote-123');
  await queue.cancel(task.id, 'owner'); await until(() => !queue.controllers.size);
  assert.equal(queue.get(task.id).state, 'cancelled');
});

test('unconfirmed cancellation stays unknown until reconciliation and does not pretend success', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { queue } = await setup(t, { run: async () => { await gate.promise; return { state: 'unknown' }; }, cancel: async () => ({ state: 'unknown', message: 'remote acknowledgement unavailable' }), reconcile: async () => ({ state: 'cancelled' }) });
  const task = await queue.submit(snapshot(), 'owner'); await until(() => queue.get(task.id).state === 'running');
  await queue.cancel(task.id, 'owner'); assert.equal(queue.get(task.id).state, 'unknown');
  gate.resolve(); await until(() => !queue.controllers.size); await queue.reconcile(task.id, 'owner'); assert.equal(queue.get(task.id).state, 'cancelled');
});

test('saved running task becomes unknown after restart, never resubmits without verification', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'createmore-queue-restart-')); let runs = 0, reconciles = 0;
  const task = { id: 'saved-task', owner: 'owner', provider: 'comfyui', resourceId: 'one', canvasId: 'canvas', nodeId: 'node', state: 'running', remoteId: 'remote', events: [], snapshot: snapshot() };
  await fs.writeFile(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [task], paused: [] }));
  const queue = new TaskQueue({ dataDir: root, run: async () => { runs++; return { text: 'wrong repeat' }; }, reconcile: async (_input, remote) => { reconciles++; assert.equal(remote.remoteId, 'remote'); return { text: 'actual existing output' }; } });
  t.after(async () => { await queue.close(); assert.ok(path.basename(root).startsWith('createmore-queue-')); await fs.rm(root, { recursive: true, force: true }); });
  await queue.init(); assert.equal(queue.get(task.id).state, 'unknown'); assert.equal(runs, 0);
  await queue.reconcile(task.id, 'owner'); assert.equal(queue.get(task.id).state, 'succeeded'); assert.equal(reconciles, 1); assert.equal(runs, 0);
});

test('saving failure retains result and retries only association, not paid generation', async t => {
  let runs = 0, attempts = 0;
  const { queue } = await setup(t, { run: async () => { runs++; return { text: 'generated once' }; }, onResult: async () => { if (++attempts === 1) throw new Error('disk temporarily full'); } });
  const task = await queue.submit(snapshot({ provider: 'codex' }), 'owner');
  await until(() => queue.get(task.id).state === 'failed' && !queue.controllers.size); assert.equal(queue.get(task.id).resultPending, true);
  await queue.reconcile(task.id, 'owner'); assert.equal(queue.get(task.id).state, 'succeeded'); assert.equal(runs, 1); assert.equal(attempts, 2);
});

test('restart during saving reuses already persisted output without contacting provider again', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'createmore-queue-saving-')); let providerChecks = 0, associations = 0;
  const task = { id: 'saved-output-task', owner: 'owner', provider: 'codex', resourceId: 'codex', canvasId: 'canvas', nodeId: 'node', state: 'saving', events: [], snapshot: snapshot({ provider: 'codex' }), result: { text: 'already retrieved result' } };
  await fs.writeFile(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [task], paused: [] }));
  const queue = new TaskQueue({ dataDir: root, run: async () => { throw new Error('must not rerun'); }, reconcile: async () => { providerChecks++; throw new Error('provider now offline'); }, onResult: async (_task, result) => { associations++; assert.equal(result.text, 'already retrieved result'); } });
  t.after(async () => { await queue.close(); assert.ok(path.basename(root).startsWith('createmore-queue-')); await fs.rm(root, { recursive: true, force: true }); });
  await queue.init(); await queue.reconcile(task.id, 'owner');
  assert.equal(queue.get(task.id).state, 'succeeded'); assert.equal(associations, 1); assert.equal(providerChecks, 0);
});

test('cancelled multi-batch analysis saves its completed ranges and stays cancelled', async t => {
  let saved=0;
  const {queue}=await setup(t,{run:async()=>({state:'completed',partial:true,cancelled:true,text:'[{"index":0}]',storyboard:{shots:[{index:0}],errors:[{range:[3,6]}]}}),onResult:async(_task,result)=>{saved++;assert.equal(result.cancelled,true);}});
  const item=await queue.submit(snapshot({provider:'storyboard'}),'owner');await until(()=>!queue.controllers.size&&queue.get(item.id).state==='cancelled');
  assert.equal(saved,1);assert.equal(queue.get(item.id).partial,true);assert.equal(queue.get(item.id).resultPending,false);
});

test('recovering unknown never authorizes resubmit; explicitly recovering failed permits failed ranges only', async t => {
  const attempts=[];
  const {queue}=await setup(t,{run:async()=>({state:'unknown',text:'[]',storyboard:{shots:[],errors:[{message:'connection lost'}]}}),reconcile:async(_input,remote)=>{attempts.push(remote.retryFailed);if(attempts.length===1)return {text:'[]',partial:true};return {text:'done'};}});
  const item=await queue.submit(snapshot({provider:'storyboard'}),'owner');await until(()=>!queue.controllers.size&&queue.get(item.id).state==='unknown');
  assert.ok(queue.get(item.id).partialResult.storyboard);await queue.reconcile(item.id,'owner');assert.equal(queue.get(item.id).state,'failed');
  await queue.reconcile(item.id,'owner');assert.equal(queue.get(item.id).state,'succeeded');assert.deepEqual(attempts,[false,true]);
});

test('an already associated partial result is not incorrectly flagged resultPending on restart', async t => {
  const {queue,root}=await setup(t,{run:async()=>({text:'partial',partial:true})});
  const item=await queue.submit(snapshot(),'owner');await until(()=>!queue.controllers.size&&queue.get(item.id).state==='failed');await queue.close();
  const restored=new TaskQueue({dataDir:root,run:async()=>{throw new Error('must not automatically resubmit');}});await restored.init();
  assert.equal(restored.get(item.id).state,'failed');assert.equal(restored.get(item.id).resultPending,false);await restored.close();
});

test('cancelling a restored image batch associates earlier outputs and retries only failed association',async t=>{let calls=0;const {queue}=await setup(t,{run:async()=>({state:'unknown'}),cancel:async()=>({state:'cancelled',partial:true,outputs:[{path:'already-generated.png',type:'image'}]}),onResult:async()=>{if(++calls===1)throw new Error('disk full');}});const task=await queue.submit(snapshot({provider:'image2'}),'owner');await until(()=>!queue.controllers.size&&queue.get(task.id).state==='unknown');await queue.cancel(task.id,'owner');assert.equal(queue.get(task.id).state,'failed');assert.equal(queue.get(task.id).resultPending,true);await queue.reconcile(task.id,'owner');assert.equal(queue.get(task.id).state,'cancelled');assert.equal(calls,2);});
