'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProjectStore, validateName, child, validState, atomicJSON } = require('../app/core/storage.cjs');

function state() { return { version: 5, assets: [], nodes: [{ id: 'n1', title: '测试', type: 'text', owner: 'member-a', x: 0, y: 0, w: 300, h: 200, content: 'initial' }], edges: [], groups: [], view: { x: 0, y: 0, k: 1 }, seq: 1, settings: { saveMinutes: 5, maxSnapshots: 100 } }; }
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'createmore-storage-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('createmore-storage-')); await fs.rm(root, { recursive: true, force: true }); });
  const store = new ProjectStore({ dataDir: path.join(root, 'local'), appDir: path.join(root, 'application') });
  const project = await store.createProject(path.join(root, 'project'), '项目 A');
  const canvas = await store.createCanvas(project.projectDir, '画布 A', state());
  return { root, store, project, canvas };
}

test('rejects Windows reserved and traversal names on every platform', () => {
  for (const name of ['', ' ', 'CON', 'nul.txt', 'COM1', 'LPT¹', '../a', 'a/b', 'a\\b', 'bad.', 'bad ', 'a:b']) assert.throws(() => validateName(name), { code: 'INVALID_NAME' });
  assert.equal(validateName('山野 · 01'), '山野 · 01');
  for (const name of ['../escape', '/absolute', 'C:\\escape', 'a/../../b', 'a//b', 'folder/CON.txt', 'file.txt:stream', 'trailing./file']) assert.throws(() => child('C:\\workspace', name), { code: 'UNSAFE_PATH' });
});

test('creates and reopens multiple canvases, rejects case-insensitive duplicate names', async t => {
  const { store, project, canvas } = await setup(t);
  await store.createCanvas(project.projectDir, 'Second', state());
  await assert.rejects(store.createCanvas(project.projectDir, 'second', state()), { code: 'NAME_CONFLICT' });
  assert.equal((await store.openProject(project.projectDir)).canvases.length, 2);
  assert.equal((await store.loadCanvas(project.projectDir, canvas.id)).state.nodes[0].content, 'initial');
  assert.equal((await store.listRecent())[0].exists, true);
  for (const folder of ['image', 'audio', 'video', 'text', 'other', 'workflows', 'autosaves']) assert.ok((await fs.stat(path.join(canvas.canvasDir, folder))).isDirectory());
});

test('validates state without discarding unknown future node types', async t => {
  const { store, project, canvas } = await setup(t);
  const next = state(); next.nodes[0].type = 'extension.unknown';
  assert.ok(validState(next)); await store.saveCanvas(project.projectDir, canvas.id, next);
  next.nodes[0].x = NaN;
  await assert.rejects(store.saveCanvas(project.projectDir, canvas.id, next), { code: 'INVALID_CANVAS' });
  assert.equal((await store.loadCanvas(project.projectDir, canvas.id)).state.nodes[0].type, 'extension.unknown');
});

test('atomic save keeps prior state and recovers a corrupt main file', async t => {
  const { store, project, canvas } = await setup(t);
  const next = state(); next.nodes[0].content = 'saved';
  await store.saveCanvas(project.projectDir, canvas.id, next);
  await fs.writeFile(path.join(canvas.canvasDir, 'canvas.json'), '{broken', 'utf8');
  const recovered = await store.loadCanvas(project.projectDir, canvas.id);
  assert.equal(recovered.recovered, true); assert.equal(recovered.state.nodes[0].content, 'initial');
  await store.saveCanvas(project.projectDir, canvas.id, next);
  assert.equal(JSON.parse(await fs.readFile(path.join(canvas.canvasDir, 'canvas.json.previous'), 'utf8')).state.nodes[0].content, 'initial');
});

test('autosaves only changed state, rotates declared retention, leaves media untouched', async t => {
  const { store, project, canvas } = await setup(t);
  assert.equal((await store.saveCanvas(project.projectDir, canvas.id, state(), { autosave: true })).autosavePath, null);
  for (let i = 0; i < 4; i++) { const next = state(); next.nodes[0].content = 'change ' + i; await store.saveCanvas(project.projectDir, canvas.id, next, { autosave: true, maxSnapshots: 2 }); }
  const snapshots = await store.listAutosaves(project.projectDir, canvas.id);
  assert.equal(snapshots.length, 2);
  const current = (await store.loadCanvas(project.projectDir, canvas.id)).state;
  assert.equal((await store.saveCanvas(project.projectDir, canvas.id, current, { autosave: true })).autosavePath, null);
  const before = await fs.readFile(path.join(canvas.canvasDir, 'canvas.json'), 'utf8');
  await assert.rejects(store.saveCanvas(project.projectDir, canvas.id, current, { autosave: true, maxSnapshots: 0 }), { code: 'INVALID_RETENTION' });
  assert.equal(await fs.readFile(path.join(canvas.canvasDir, 'canvas.json'), 'utf8'), before);
});

test('asset records survive card deletion; copy, external, internal output paths are distinct', async t => {
  const { root, store, project, canvas } = await setup(t);
  const external = path.join(root, 'reference.png'); await fs.writeFile(external, 'image-data');
  const copied = await store.importAsset(project.projectDir, canvas.id, external);
  assert.equal(copied.external, false); assert.match(copied.asset, /^image\//);
  assert.equal(await fs.readFile(await store.resolveAssetPath(project.projectDir, canvas.id, copied.id), 'utf8'), 'image-data');
  const ref = await store.importAsset(project.projectDir, canvas.id, external, { copy: false });
  assert.equal(ref.external, true); assert.equal(ref.asset, external);
  const output = path.join(canvas.canvasDir, 'image', 'result.png'); await fs.writeFile(output, 'output');
  const generated = await store.importAsset(project.projectDir, canvas.id, output, { copy: false, generated: true });
  assert.equal(generated.asset, 'image/result.png'); assert.equal(generated.external, false); assert.equal(generated.generated, true);
  const next = state(); next.nodes = []; next.assets = [];
  await store.saveCanvas(project.projectDir, canvas.id, next);
  assert.equal((await store.loadCanvas(project.projectDir, canvas.id)).state.assets.length, 3);
  assert.equal(await fs.readFile(external, 'utf8'), 'image-data');
});

test('concurrent imports and saves preserve every independently registered asset', async t => {
  const { root, store, project, canvas } = await setup(t);
  const external = path.join(root, 'asset.txt'); await fs.writeFile(external, 'content');
  await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2 ? store.saveCanvas(project.projectDir, canvas.id, state()) : store.importAsset(project.projectDir, canvas.id, external)));
  assert.equal((await store.loadCanvas(project.projectDir, canvas.id)).state.assets.length, 4);
});

test('shared transfer preserves supplied immutable asset identity without duplicate registrations', async t => {
  const { root, store, project, canvas } = await setup(t);
  const file = path.join(root, 'shared.png'); await fs.writeFile(file, 'shared-data');
  const first = await store.importAsset(project.projectDir, canvas.id, file, { assetId: 'peer-asset-id', owner: 'peer', copy: true });
  const second = await store.importAsset(project.projectDir, canvas.id, file, { assetId: 'peer-asset-id', owner: 'peer', copy: true });
  assert.equal(first.id, second.id); assert.equal(second.owner, 'peer'); assert.equal((await store.loadCanvas(project.projectDir, canvas.id)).state.assets.length, 1);
  await fs.writeFile(file, 'changed-data');
  await assert.rejects(store.importAsset(project.projectDir, canvas.id, file, { assetId: 'peer-asset-id' }), { code: 'ASSET_ID_CONFLICT' });
});

test('relink is explicit and batch matching verifies original hashes', async t => {
  const { root, store, project, canvas } = await setup(t);
  const before = path.join(root, 'before'), after = path.join(root, 'after'); await fs.mkdir(before); await fs.mkdir(after);
  for (const name of ['one.png', 'two.png', 'three.png']) await fs.writeFile(path.join(before, name), name);
  const assets = [];
  for (const name of ['one.png', 'two.png', 'three.png']) assets.push(await store.importAsset(project.projectDir, canvas.id, path.join(before, name), { copy: false }));
  const next = (await store.loadCanvas(project.projectDir, canvas.id)).state; next.nodes[0].asset = assets[0].asset; await store.saveCanvas(project.projectDir, canvas.id, next);
  for (const name of ['one.png', 'two.png', 'three.png']) await fs.rename(path.join(before, name), path.join(after, name));
  await fs.writeFile(path.join(after, 'three.png'), 'different');
  const result = await store.relinkAsset(project.projectDir, canvas.id, assets[0].id, path.join(after, 'one.png'), { batch: true });
  assert.equal(result.updated.length, 2); assert.equal(result.ambiguous.length, 1);
  assert.equal(result.state.nodes[0].asset, path.join(after, 'one.png'));
});

test('restore previews and preserves current state plus later independent assets', async t => {
  const { root, store, project, canvas } = await setup(t);
  const next = state(); next.nodes[0].content = 'old'; await store.saveCanvas(project.projectDir, canvas.id, next, { autosave: true });
  const snapshot = (await store.listAutosaves(project.projectDir, canvas.id))[0];
  next.nodes[0].content = 'new'; await store.saveCanvas(project.projectDir, canvas.id, next);
  const later = path.join(root, 'later.wav'); await fs.writeFile(later, 'later'); await store.importAsset(project.projectDir, canvas.id, later);
  assert.equal((await store.previewRestore(project.projectDir, canvas.id, snapshot.name)).nodes[0].content, 'old');
  const restored = await store.restoreCanvas(project.projectDir, canvas.id, snapshot.name);
  assert.equal(restored.state.nodes[0].content, 'old'); assert.equal(restored.state.assets.length, 1);
  assert.equal(JSON.parse(await fs.readFile(restored.beforeRestorePath, 'utf8')).state.nodes[0].content, 'new');
});

test('independent package detaches old owners and execution devices without changing original shared copy', async t => {
  const {root,store,project,canvas}=await setup(t),next=state();next.nodes[0].taskId='old-machine-task';next.nodes[0].execution={deviceId:'other-machine',offerId:'private-offer'};next.shared=true;next.chat=[{text:'private'}];await store.saveCanvas(project.projectDir,canvas.id,next);const result=await store.packageProject(project.projectDir,path.join(root,'portable-copy'));assert.notEqual(result.canvases[0].id,canvas.id);const packaged=await store.loadCanvas(result.projectDir,result.canvases[0].id);assert.equal(packaged.copiedFromCanvasId,canvas.id);assert.equal(packaged.state.nodes[0].owner,'me');assert.equal(packaged.state.nodes[0].copiedFromOwner,'member-a');assert.equal(packaged.state.nodes[0].taskId,undefined);assert.equal(packaged.state.nodes[0].execution,undefined);assert.equal(packaged.state.shared,undefined);assert.equal(packaged.state.chat,undefined);const original=await store.loadCanvas(project.projectDir,canvas.id);assert.equal(original.state.nodes[0].owner,'member-a');assert.equal(original.state.nodes[0].taskId,'old-machine-task');assert.equal(original.state.shared,true);
});

test('package copies external assets, rewrites references, excludes machine workflows and credentials', async t => {
  const { root, store, project, canvas } = await setup(t);
  const external = path.join(root, 'reference.png'); await fs.writeFile(external, 'portable-data');
  const asset = await store.importAsset(project.projectDir, canvas.id, external, { copy: false });
  const next = (await store.loadCanvas(project.projectDir, canvas.id)).state;
  next.nodes[0].asset = asset.asset; next.nodes[0].parameters = { apiKey: 'secret', prompt: 'keep prompt' }; next.connections = { password: 'private' };
  await store.saveCanvas(project.projectDir, canvas.id, next);
  await atomicJSON(path.join(canvas.canvasDir, 'generation-history.json'), [{ taskId: 'past-task', prompt: 'kept history', outputs: [asset], parameters: { apiKey: 'private' } }]);
  await store.retainWorkflow(project.projectDir, canvas.id, { id: 'custom-a', origin: 'custom', gui: { nodes: [] }, api: { node: { api_key: 'secret', text: 'kept' } }, mapping: { inputs: [] } });
  await assert.rejects(store.retainWorkflow(project.projectDir, canvas.id, { id: 'default', origin: 'default', gui: {}, api: {}, mapping: {} }), { code: 'CUSTOM_WORKFLOW_REQUIRED' });
  const packaged = await store.packageProject(project.projectDir, path.join(root, 'package'));
  const packagedCanvasId=packaged.canvases[0].id;
  const loaded = await store.loadCanvas(packaged.projectDir, packagedCanvasId);
  assert.notEqual(loaded.state.nodes[0].asset, external); assert.equal(loaded.state.assets[0].external, false);
  assert.equal(await fs.readFile(await store.resolveAssetPath(packaged.projectDir, packagedCanvasId, loaded.state.assets[0]), 'utf8'), 'portable-data');
  assert.equal(loaded.state.nodes[0].parameters.apiKey, undefined); assert.equal(loaded.state.connections, undefined);
  const history = JSON.parse(await fs.readFile(path.join(loaded.canvasDir, 'generation-history.json'), 'utf8'));
  assert.equal(history[0].prompt, 'kept history'); assert.equal(history[0].outputs[0].asset, loaded.state.assets[0].asset); assert.equal(history[0].outputs[0].external, false); assert.equal(history[0].parameters.apiKey, undefined);
  assert.equal((await fs.readdir(path.join(loaded.canvasDir, 'workflows'))).length, 1);
  await fs.unlink(external);
  assert.ok(await store.resolveAssetPath(packaged.projectDir, packagedCanvasId, loaded.state.assets[0]));
  await assert.rejects(store.packageProject(project.projectDir, path.join(project.projectDir, 'nested')), { code: 'UNSAFE_DESTINATION' });
  await assert.rejects(store.packageProject(project.projectDir, packaged.projectDir), { code: 'DESTINATION_NOT_EMPTY' });
});

test('missing material fails package with a recoverable partial directory, never fake success', async t => {
  const { root, store, project, canvas } = await setup(t);
  const external = path.join(root, 'lost.png'); await fs.writeFile(external, 'lost'); await store.importAsset(project.projectDir, canvas.id, external, { copy: false }); await fs.unlink(external);
  await assert.rejects(store.packageCanvas(project.projectDir, canvas.id, path.join(root, 'package')), err => err.code === 'MISSING_PACKAGE_ASSET' && typeof err.partialDirectory === 'string');
});

test('symlink or junction project/media boundaries are rejected', async t => {
  const { root, store, project, canvas } = await setup(t);
  const other = path.join(root, 'other'); await fs.mkdir(other);
  const link = path.join(root, 'junction');
  try { await fs.symlink(other, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (err) { if (err.code === 'EPERM') { t.skip('OS does not grant symlink creation'); return; } throw err; }
  await assert.rejects(store.createProject(link, 'unsafe'), { code: 'SYMLINK_NOT_ALLOWED' });
  const manifest = JSON.parse(await fs.readFile(path.join(project.projectDir, '.createmore.json'), 'utf8'));
  manifest.canvases[0].directory = '../other'; await atomicJSON(path.join(project.projectDir, '.createmore.json'), manifest, { backup: false });
  await assert.rejects(store.loadCanvas(project.projectDir, canvas.id), { code: 'INVALID_NAME' });
});
