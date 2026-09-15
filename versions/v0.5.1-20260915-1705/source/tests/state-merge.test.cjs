'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { merge } = require('../app/ui/state-merge.js');
const clone = value => structuredClone(value);
const canvas = () => ({ version: 5, nodes: [{ id: 'mine', type: 'image', owner: 'me', prompt: 'submitted', x: 10, content: '', taskId: 'task-old', asset: 'old-url', assetId: 'asset-old' }, { id: 'peer', type: 'text', owner: 'member-2', prompt: 'peer prompt', content: 'peer text' }], edges: [], groups: [], assets: [{ id: 'asset-old', title: 'Original', asset: 'old-url', path: 'image/old.png', type: 'image', sha256: 'old-hash', size: 10, external: false, generated: true }], view: { x: 0, y: 0, k: 1 }, settings: { saveMinutes: 5 }, appliedTaskIds: [] });

test('three-way merge keeps unsynced prompt while accepting authoritative generation output fields', () => {
  const base = canvas(), local = clone(base), remote = clone(base);
  Object.assign(local.nodes[0], { prompt: 'still typing', x: 333, taskId: 'stale-local-task', asset: 'stale-local-url', assetId: 'stale-local-id', outputAssets: ['stale-output'], lastResultAt: 'old', styleTrace: ['stale'] });
  Object.assign(remote.nodes[0], { content: 'new output', taskId: 'task-new', asset: 'new-url', assetId: 'asset-new', outputAssets: ['asset-new'], lastResultAt: 'now', styleTrace: ['actual'] });
  remote.appliedTaskIds = ['task-new'];
  const result = merge(base, local, remote), node = result.nodes[0];
  assert.equal(node.prompt, 'still typing'); assert.equal(node.x, 333); assert.equal(node.content, 'new output');
  for (const key of ['taskId', 'asset', 'assetId', 'outputAssets', 'lastResultAt', 'styleTrace']) assert.deepEqual(node[key], remote.nodes[0][key]);
  assert.deepEqual(result.appliedTaskIds, ['task-new']);
});

test('local text editing wins a same-field result conflict without discarding other result metadata', () => {
  const base = canvas(), local = clone(base), remote = clone(base);
  base.nodes[0].type = local.nodes[0].type = remote.nodes[0].type = 'text';
  local.nodes[0].content = 'new user text'; remote.nodes[0].content = 'late generation text'; remote.nodes[0].taskId = 'new-task';
  const result = merge(base, local, remote); assert.equal(result.nodes[0].content, 'new user text'); assert.equal(result.nodes[0].taskId, 'new-task');
});

test('deleted own nodes stay deleted; newly drawn nodes and new remote result cards are retained', () => {
  const base = canvas(), local = clone(base), remote = clone(base);
  local.nodes = local.nodes.filter(n => n.id !== 'mine'); local.nodes.push({ id: 'local-new', owner: 'me', type: 'text', prompt: 'new card' });
  remote.nodes[0].content = 'late result'; remote.nodes.push({ id: 'remote-result', owner: 'me', type: 'image', assetId: 'result' });
  const ids = merge(base, local, remote).nodes.map(n => n.id);
  assert(!ids.includes('mine')); assert(ids.includes('local-new')); assert(ids.includes('remote-result')); assert(ids.includes('peer'));
});

test('remote deletion is not undone by stale local edits and foreign changes remain authoritative', () => {
  const base = canvas(), local = clone(base), remote = clone(base);
  local.nodes[0].prompt = 'stale edit after deletion'; local.nodes[1].prompt = 'unauthorized';
  local.nodes.push({ id: 'fake-peer', owner: 'member-2', type: 'text' });
  remote.nodes = remote.nodes.filter(n => n.id !== 'mine'); remote.nodes[0].prompt = 'latest peer prompt';
  const result = merge(base, local, remote); assert.deepEqual(result.nodes.map(n => n.id), ['peer']); assert.equal(result.nodes[0].prompt, 'latest peer prompt');
});

test('local edge and group edits merge with peer-owned structures without dangling references', () => {
  const base = canvas(); base.nodes.push({ id: 'mine-2', owner: 'me', type: 'text' });
  base.edges = [{ id: 'own-input', from: 'peer', to: 'mine' }, { id: 'peer-input', from: 'mine-2', to: 'peer' }];
  base.groups = [{ id: 'own-group', owner: 'me', members: ['mine', 'mine-2'], name: 'old group' }, { id: 'peer-group', owner: 'member-2', members: ['peer'], name: 'peer group' }];
  const local = clone(base), remote = clone(base);
  local.edges = [{ id: 'peer-input', from: 'mine', to: 'peer' }, { id: 'new-input', from: 'mine-2', to: 'mine' }];
  local.groups[0].name = 'edited group'; local.groups[1].name = 'unauthorized name';
  remote.groups[1].name = 'latest peer group'; remote.edges.push({ id: 'invalid-edge', from: 'missing', to: 'mine' });
  const result = merge(base, local, remote);
  assert(!result.edges.some(e => e.id === 'own-input' || e.id === 'invalid-edge'));
  assert.deepEqual(result.edges.find(e => e.id === 'peer-input'), base.edges[1]); assert(result.edges.some(e => e.id === 'new-input'));
  assert.equal(result.groups.find(g => g.id === 'own-group').name, 'edited group'); assert.equal(result.groups.find(g => g.id === 'peer-group').name, 'latest peer group');
});

test('asset metadata edits survive while identity, paths and new output assets stay authoritative', () => {
  const base = canvas(), local = clone(base), remote = clone(base);
  Object.assign(local.assets[0], { title: 'Renamed by user', folderId: 'my-folder', asset: 'unsafe-url', path: 'outside-file', sha256: 'fake', size: 900, type: 'video', owner: 'other', external: true, generated: false });
  Object.assign(remote.assets[0], { asset: 'new-capability-url', path: 'image/old.png', owner: 'me' });
  remote.assets.push({ id: 'new-output', title: 'Output', asset: 'result-url', sha256: 'result-hash' });
  const result = merge(base, local, remote), asset = result.assets.find(a => a.id === 'asset-old');
  assert.equal(asset.title, 'Renamed by user'); assert.equal(asset.folderId, 'my-folder');
  for (const key of ['asset', 'path', 'sha256', 'size', 'type', 'owner', 'external', 'generated']) assert.deepEqual(asset[key], remote.assets[0][key]);
  assert(result.assets.some(a => a.id === 'new-output'));
});

test('local property deletion and canvas view changes survive without mutating any input', () => {
  const base = canvas(), local = clone(base), remote = clone(base); base.nodes[0].optional = local.nodes[0].optional = remote.nodes[0].optional = 'remove me';
  delete local.nodes[0].optional; local.view = { x: 10, y: 30, k: .75 }; remote.settings.saveMinutes = 9;
  const before = [base, local, remote].map(clone), result = merge(base, local, remote);
  assert(!Object.hasOwn(result.nodes[0], 'optional')); assert.deepEqual(result.view, local.view); assert.equal(result.settings.saveMinutes, 9);
  result.nodes[0].prompt = 'mutate merged result'; assert.deepEqual([base, local, remote], before);
});

test('an empty baseline accepts both local new cards and remote state safely', () => {
  const local = canvas(), remote = canvas(); local.nodes.push({ id: 'draft', owner: 'me', type: 'text', prompt: 'pending' }); remote.nodes.push({ id: 'result', owner: 'me', type: 'image' });
  const merged = merge(undefined, local, remote); assert(merged.nodes.some(n => n.id === 'draft')); assert(merged.nodes.some(n => n.id === 'result'));
});
