'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CreateMoreService } = require('../app/core/service.cjs');
const { capture, apply, saveWorkflow, applyHistory } = require('../app/core/library-actions.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'createmore-library-')); let runs = 0;
  const hub = { async run() { runs++; throw new Error('library actions must not generate'); }, async reconcile() { return { state: 'unknown' }; }, async cancel() { return { cancelled: false }; }, async status() { return {}; }, async close() {} };
  const service = await new CreateMoreService({ appDir: path.join(root, 'app'), dataDir: path.join(root, 'data'), hub }).init();
  t.after(async () => { await service.close(); assert.equal(runs, 0); assert.ok(path.basename(root).startsWith('createmore-library-')); await fs.rm(root, { recursive: true, force: true }); });
  await service.createProject(path.join(root, 'project'), '资源闭环项目'); return { root, service };
}
async function add(service, type, fields = {}) { const node = service.newNode(type, fields); service.current.state.nodes.push(node); service.current.dirty = true; service.current.revision++; return node; }
function bundle(text = 'original') { return { gui: { nodes: [], links: [] }, api: { '1': { class_type: 'ExamplePrompt', inputs: { text, steps: 10 } }, '2': { class_type: 'ExampleOutput', inputs: { image: ['1', 0] } } }, mapping: { inputs: [{ id: 'prompt', nodeId: '1', input: 'text', source: 'prompt', type: 'string' }, { id: 'steps', nodeId: '1', input: 'steps', source: 'parameter', type: 'integer', default: 10, min: 1, max: 50 }], outputs: [{ id: 'image', nodeId: '2', key: 'images', mediaType: 'image', primary: true }] } }; }

test('preset capture keeps selected internal graph and real media, excludes tasks/history/default workflow payload', async t => {
  const { root, service } = await setup(t); const source = path.join(root, 'reference.png'); await fs.writeFile(source, 'reference-image');
  await service.importAsset(source, { copy: false }); const first = service.current.state.nodes[0];
  const second = await add(service, 'image', { x: first.x + 450, y: first.y + 20, workflowId: 'default:image', workflow: { origin: 'default', api: { mustNotPackage: true } }, parameters: { apiKey: 'private', steps: 9 }, taskId: 'active-job', error: 'old transient error', history: [{ privateOldResult: true }] });
  const outside = await add(service, 'text', { content: 'not selected' });
  service.current.state.edges.push({ id: 'inside', from: first.id, to: second.id }, { id: 'outside-input', from: outside.id, to: second.id });
  service.current.state.groups.push({ id: 'group', title: '组合', owner: service.identity.id, members: [first.id, second.id] });
  const view = await capture(service, { kind: 'presets', data: { name: '图片组合' }, nodeIds: [first.id, second.id] });
  const resource = view.resource; assert.equal(resource.nodes.length, 2); assert.equal(resource.edges.length, 1); assert.equal(resource.groups.length, 1); assert.equal(resource.assets.length, 1);
  const copied = resource.nodes.find(node => node.id === second.id); assert.equal(copied.taskId, undefined); assert.equal(copied.error, undefined); assert.equal(copied.history, undefined); assert.equal(copied.workflow, undefined); assert.equal(copied.parameters.apiKey, undefined); assert.equal(copied.parameters.steps, 9);
  assert.equal(resource.dependencies.length, 2); assert.match(resource.cover, /^assets\//); assert.equal(await fs.readFile(path.join(resource.resourceDir, resource.cover), 'utf8'), 'reference-image');
  assert.equal(first.asset, source); assert.equal(second.taskId, 'active-job'); assert.equal(await fs.readFile(source, 'utf8'), 'reference-image');
});

test('text-only preset receives a local SVG graph thumbnail without image generation', async t => {
  const { service } = await setup(t); const node = await add(service, 'text', { title: '<safe & escaped>', content: 'notes' });
  const result = await capture(service, { kind: 'presets', data: { name: '文字组合' }, nodeIds: [node.id] });
  assert.equal(result.resource.cover, 'cover.svg');
  const svg = await fs.readFile(path.join(result.resource.resourceDir, 'cover.svg'), 'utf8'); assert.match(svg, /&lt;safe &amp; escaped&gt;/); assert.doesNotMatch(svg, /<safe & escaped>/);
});

test('preset application is an independent cross-canvas copy with stable internal connections and material', async t => {
  const { root, service } = await setup(t); const source = path.join(root, 'reference.png'); await fs.writeFile(source, 'self-contained');
  await service.importAsset(source, { copy: false }); const first = service.current.state.nodes[0]; first.owner = 'peer-owner'; first.x = 120; first.y = 150;
  const second = await add(service, 'text', { x: 540, y: 210, content: 'selected notes', taskId: 'not-copied' }); service.current.state.edges.push({ id: 'link', from: first.id, to: second.id });
  const resource = (await capture(service, { kind: 'presets', data: { name: '可移植组合' }, nodeIds: [first.id, second.id] })).resource;
  await service.createCanvas('目标画布'); await fs.unlink(source);
  const view = await apply(service, { kind: 'presets', id: resource.id }); assert.equal(view.state.nodes.length, 2); assert.equal(view.state.edges.length, 1); assert.ok(view.state.nodes.every(node => node.owner === 'me'));
  const nodes = service.current.state.nodes; assert.ok(nodes.every(node => node.id !== first.id && node.id !== second.id && !node.taskId)); assert.equal(nodes[1].x - nodes[0].x, 420); assert.equal(nodes[1].y - nodes[0].y, 60);
  assert.equal(await fs.readFile(await service.assetPath(nodes[0].assetId), 'utf8'), 'self-contained');
  const originalIds = nodes.map(node => node.id); await apply(service, { kind: 'presets', id: resource.id });
  assert.equal(service.current.state.nodes.length, 4); assert.equal(new Set(service.current.state.nodes.map(node => node.id)).size, 4); assert.notEqual(service.current.state.nodes[2].assetId, nodes[0].assetId);
  await service.resources.remove('presets', resource.id); await service.saveCanvas();
  assert.ok(await service.assetPath(service.current.state.nodes.find(node => node.id === originalIds[0]).assetId));
});

test('unknown preset node remains a visible placeholder with original data and edges', async t => {
  const { service } = await setup(t);
  const unknown = await add(service, 'vendor.special', { title: '未知扩展', customConfig: { preserve: 42 } }), known = await add(service, 'text', { content: 'downstream' });
  service.current.state.edges.push({ id: 'edge', from: unknown.id, to: known.id });
  const resource = (await capture(service, { kind: 'presets', data: { name: '含未知节点' }, nodeIds: [unknown.id, known.id] })).resource;
  await service.createCanvas('导入未知节点'); await apply(service, { kind: 'presets', id: resource.id });
  const copied = service.current.state.nodes.find(node => node.type === 'vendor.special'); assert.equal(copied.customConfig.preserve, 42); assert.ok(copied.dependencyIssues.length); assert.equal(service.current.state.edges.length, 1);
});

test('preset missing material or invalid custom dependency still imports placeholders without losing other nodes', async t => {
  const { root, service } = await setup(t); const source = path.join(root, 'reference.png'); await fs.writeFile(source, 'to-be-missing'); await service.importAsset(source, { copy: false });
  const image = service.current.state.nodes[0], custom = await add(service, 'custom', { workflowId: 'missing-custom', workflow: { gui: { nodes: [], links: [] }, mapping: { inputs: [] } } }), text = await add(service, 'text', { content: 'unaffected' });
  const resource = (await capture(service, { kind: 'presets', data: { name: '缺依赖预设' }, nodeIds: [image.id, custom.id, text.id] })).resource;
  await fs.unlink(path.join(resource.resourceDir, resource.assets[0].asset)); await service.createCanvas('带缺失加载');
  await apply(service, { kind: 'presets', id: resource.id });
  assert.equal(service.current.state.nodes.length, 3); assert.match(service.current.state.nodes.find(node => node.type === 'image').error, /缺少资源素材/);
  const placeholder = service.current.state.nodes.find(node => node.type === 'custom'); assert.equal(placeholder.workflowInvalid, true); assert.ok(placeholder.workflow.gui); assert.match(placeholder.error, /工作流配置不完整/);
  assert.equal(service.current.state.nodes.find(node => node.type === 'text').content, 'unaffected');
});

test('character capture requires a selected cover and copies media plus optional description', async t => {
  const { root, service } = await setup(t);
  await assert.rejects(capture(service, { kind: 'characters', data: { name: '没有封面' } }), { code: 'CHARACTER_COVER_REQUIRED' });
  const source = path.join(root, 'cover.png'); await fs.writeFile(source, 'character-cover'); await service.importAsset(source, { copy: false });
  const assetId = service.current.state.assets[0].id;
  const resource = (await capture(service, { kind: 'characters', data: { name: '石头角色', story: '风化的石头也可以是角色。' }, assetId })).resource;
  assert.equal(resource.assets.length, 1); await fs.unlink(source); await service.createCanvas('角色资料');
  await apply(service, { kind: 'characters', id: resource.id });
  assert.equal(service.current.state.nodes.length, 2); assert.equal(service.current.state.nodes.find(node => node.type === 'character').content, '风化的石头也可以是角色。');
  const image = service.current.state.nodes.find(node => node.type === 'image'); assert.equal(await fs.readFile(await service.assetPath(image.assetId), 'utf8'), 'character-cover');
});

async function selectableCharacter(t) {
  const setupResult = await setup(t), { root, service } = setupResult;
  for (const name of ['front', 'side']) { const file = path.join(root, name + '.png'); await fs.writeFile(file, name + '-image'); await service.importAsset(file, { copy: true }); }
  const nodes = service.current.state.nodes;
  const resource = (await capture(service, { kind: 'characters', data: { name: '可选角色', description: '总描述', story: '角色经历' }, nodeIds: nodes.map(node => node.id), assetId: nodes[0].assetId })).resource;
  const saved = await service.resources.save('characters', { ...resource, materials: [{ title: '声线', content: '低沉声线' }, { title: '带图资料', content: '随图片保留', assetId: resource.assets[0].id }, { title: '动作', content: '轻盈步态' }] });
  await service.createCanvas('角色应用目标'); return { ...setupResult, resource: saved };
}

test('character application copies only selected resource assets and standalone text materials', async t => {
  const { service, resource } = await selectableCharacter(t), old = JSON.stringify(resource);
  await apply(service, { kind: 'characters', id: resource.id, assetIds: [resource.assets[1].id], materialIndexes: [2], includeDescription: false });
  assert.equal(service.current.state.assets.length, 1); assert.equal(service.current.state.nodes.length, 2);
  const image = service.current.state.nodes.find(node => node.type === 'image'), text = service.current.state.nodes.find(node => node.type === 'character');
  assert.equal(await fs.readFile(await service.assetPath(image.assetId), 'utf8'), 'side-image'); assert.equal(text.content, '动作\n轻盈步态');
  assert.equal(JSON.stringify(resource), old); assert.equal((await service.resources.get('characters', resource.id)).assets.length, 2);
});

test('character description-only selection imports no files and omitted selectors retain all contents', async t => {
  const { service, resource } = await selectableCharacter(t);
  await apply(service, { kind: 'characters', id: resource.id, assetIds: [], materialIndexes: [], includeDescription: true });
  assert.equal(service.current.state.assets.length, 0); assert.equal(service.current.state.nodes.length, 1); assert.equal(service.current.state.nodes[0].content, '总描述\n\n角色经历');
  await service.createCanvas('完整角色'); await apply(service, { kind: 'characters', id: resource.id });
  assert.equal(service.current.state.assets.length, 2); assert.equal(service.current.state.nodes.length, 3);
  const text = service.current.state.nodes.find(node => node.type === 'character').content;
  assert.match(text, /总描述/); assert.match(text, /低沉声线/); assert.match(text, /轻盈步态/); assert.doesNotMatch(text, /随图片保留/);
});

test('character selectors reject foreign IDs paths objects indexes and empty choices before importing', async t => {
  const { root, service, resource } = await selectableCharacter(t);
  const before = JSON.stringify(service.current.state);
  const invalid = [
    { assetIds: ['foreign-resource-asset'] }, { assetIds: [path.join(root, 'front.png')] }, { assetIds: [{ id: resource.assets[0].id, path: path.join(root, 'front.png') }] },
    { assetIds: [resource.assets[0].id, '../outside.png'] }, { assetIds: null },
    { materialIndexes: [-1] }, { materialIndexes: [3] }, { materialIndexes: [1] }, { materialIndexes: ['0'] }, { materialIndexes: [0.5] }, { materialIndexes: null }, { includeDescription: 'false' }
  ];
  for (const selection of invalid) { await assert.rejects(apply(service, { kind: 'characters', id: resource.id, ...selection }), { code: 'CHARACTER_SELECTION_INVALID' }); assert.equal(JSON.stringify(service.current.state), before); }
  await assert.rejects(apply(service, { kind: 'characters', id: resource.id, assetIds: [], materialIndexes: [], includeDescription: false }), { code: 'CHARACTER_SELECTION_EMPTY' });
  assert.equal(JSON.stringify(service.current.state), before); assert.equal(service.current.state.assets.length, 0);
});

test('style Skill content and attachments remain independent after library edits/deletion', async t => {
  const { root, service } = await setup(t);
  const guide = path.join(root, 'guide.md'); await fs.writeFile(guide, '附属参考资料');
  const skill = await service.resources.save('skills', { name: '独立风格', content: '# 风格\n参考 references/guide.md', classification: 'style' }, { files: [{ sourcePath: guide, relativePath: 'references/guide.md' }] });
  await apply(service, { kind: 'styles', id: skill.id }); const node = service.current.state.nodes[0];
  assert.equal(node.skill.revision, 1); assert.equal(node.skill.files.length, 1); assert.equal(node.skill.files[0].relativePath, 'references/guide.md');
  assert.equal(await fs.readFile(await service.assetPath(node.skill.files[0].assetId), 'utf8'), '附属参考资料');
  await service.resources.save('skills', { id: skill.id, name: skill.name, content: '# Changed' }); await service.resources.remove('skills', skill.id);
  assert.equal(node.skill.content, '# 风格\n参考 references/guide.md'); await service.saveCanvas();
  const packaged = await service.store.packageProject(service.current.projectDir, path.join(root, 'portable')); const restored = await service.store.loadCanvas(packaged.projectDir, packaged.canvases[0].id);
  assert.equal(restored.state.nodes[0].skill.content, '# 风格\n参考 references/guide.md'); assert.ok(await service.store.resolveAssetPath(packaged.projectDir, restored.id, restored.state.nodes[0].skill.files[0].assetId));
});

test('disabled style cannot be applied and referenced Skill source stays untouched', async t => {
  const { root, service } = await setup(t); const folder = path.join(root, 'source-skill'); await fs.mkdir(folder); const skillPath = path.join(folder, 'SKILL.md'); await fs.writeFile(skillPath, '# original');
  const skill = await service.resources.referenceSkill('只读风格', skillPath); await service.resources.setEnabled('skills', skill.id, false);
  await assert.rejects(apply(service, { kind: 'styles', id: skill.id }), { code: 'SKILL_DISABLED' }); assert.equal(service.current.state.nodes.length, 0); assert.equal(await fs.readFile(skillPath, 'utf8'), '# original');
});

test('custom workflow library and canvas copies are versioned independently, including API-only import', async t => {
  const { service } = await setup(t); const first = await add(service, 'custom'), second = await add(service, 'custom');
  const saved = await saveWorkflow(service, { name: '自定义生成', bundle: bundle(), nodeId: first.id }); const resource = saved.resource, oldVersion = first.workflowVersion;
  first.taskId = 'existing-running-task'; const frozenTask = structuredClone(first.workflow);
  await apply(service, { kind: 'workflows', id: resource.id, nodeId: second.id }); assert.equal(second.workflowVersion, oldVersion);
  assert.equal((await fs.readdir(path.join(service.current.canvasDir, 'workflows'))).length, 1);
  const updated = await saveWorkflow(service, { resourceId: resource.id, name: resource.name, bundle: bundle('updated'), nodeId: first.id });
  assert.equal(updated.resource.revision, 2); assert.notEqual(first.workflowVersion, oldVersion); assert.equal(second.workflowVersion, oldVersion); assert.equal(second.workflow.api['1'].inputs.text, 'original'); assert.equal(frozenTask.api['1'].inputs.text, 'original'); assert.equal(first.taskId, 'existing-running-task'); assert.equal(first.workflowHistory.length, 1);
  await service.resources.remove('workflows', resource.id); assert.equal(second.workflow.api['1'].inputs.text, 'original'); assert.ok(await fs.stat(path.join(service.current.canvasDir, second.workflowRef)));
  const apiOnly = await saveWorkflow(service, { name: '仅API工作流', bundle: { ...bundle(), gui: null } }); assert.equal(apiOnly.resource.gui, null); assert.equal(apiOnly.resource.apiOnly, true);
});

test('GUI without native conversion, incompatible remapping, and peer binding are rejected without node mutation', async t => {
  const { service } = await setup(t); const node = await add(service, 'custom');
  await assert.rejects(saveWorkflow(service, { name: '未转换', bundle: { gui: { nodes: [], links: [] }, mapping: bundle().mapping }, nodeId: node.id }), { code: 'NATIVE_CONVERSION_REQUIRED' }); assert.equal(node.workflow, undefined);
  const saved = await saveWorkflow(service, { name: '有连线', bundle: bundle(), nodeId: node.id });
  const downstream = await add(service, 'image'); service.current.state.edges.push({ id: 'existing-edge', from: node.id, to: downstream.id, fromPort: 'image' });
  const incompatible = bundle('next'); incompatible.mapping.outputs[0].id = 'different-output';
  const original = JSON.stringify(node);
  await assert.rejects(saveWorkflow(service, { name: saved.resource.name, resourceId: saved.resource.id, bundle: incompatible, nodeId: node.id }), { code: 'WORKFLOW_CONNECTION_CONFLICT' }); assert.equal(JSON.stringify(node), original);
  node.owner = 'peer'; await assert.rejects(apply(service, { kind: 'workflows', id: saved.resource.id, nodeId: node.id }), { code: 'FORBIDDEN' });
});

test('captured custom workflow remains executable configuration after original library removal', async t => {
  const { service } = await setup(t); const node = await add(service, 'custom');
  const workflow = (await saveWorkflow(service, { name: '源工作流', bundle: bundle(), nodeId: node.id })).resource;
  const preset = (await capture(service, { kind: 'presets', data: { name: '含自定义工作流' }, nodeIds: [node.id] })).resource;
  await service.resources.remove('workflows', workflow.id); await service.createCanvas('独立目标'); await apply(service, { kind: 'presets', id: preset.id });
  const copied = service.current.state.nodes[0]; assert.equal(copied.workflow.api['1'].class_type, 'ExamplePrompt'); assert.ok(await fs.stat(path.join(service.current.canvasDir, copied.workflowRef)));
});

test('named reference and output edges remain compatible while prompt/style control edges stay separate', async t => {
  const { service } = await setup(t), node = await add(service, 'custom');
  const original = bundle(); original.api['1'].inputs.reference = '';
  original.mapping.inputs.push({ id: 'reference-image', nodeId: '1', input: 'reference', source: 'reference', mediaType: 'image', index: 0 });
  const saved = await saveWorkflow(service, { name: '多端口配置', bundle: original, nodeId: node.id });
  const image = await add(service, 'image'), style = await add(service, 'style'), text = await add(service, 'text'), downstream = await add(service, 'image');
  service.current.state.edges.push({ id: 'image-edge', from: image.id, to: node.id, inputId: 'reference-image' }, { id: 'style-edge', from: style.id, to: node.id, inputId: '$style' }, { id: 'prompt-edge', from: text.id, to: node.id, inputId: '$prompt' }, { id: 'output-edge', from: node.id, to: downstream.id, outputId: 'image' });
  const changed = structuredClone(original); changed.api['1'].inputs.steps = 11;
  await saveWorkflow(service, { name: saved.resource.name, resourceId: saved.resource.id, bundle: changed, nodeId: node.id });
  const version = node.workflowVersion;
  const incompatible = structuredClone(changed); incompatible.mapping.inputs.find(p => p.id === 'reference-image').mediaType = 'audio';
  await assert.rejects(saveWorkflow(service, { name: saved.resource.name, resourceId: saved.resource.id, bundle: incompatible, nodeId: node.id }), { code: 'WORKFLOW_CONNECTION_CONFLICT' });
  const noPrompt = structuredClone(changed); noPrompt.mapping.inputs = noPrompt.mapping.inputs.filter(p => p.source !== 'prompt');
  await assert.rejects(saveWorkflow(service, { name: saved.resource.name, resourceId: saved.resource.id, bundle: noPrompt, nodeId: node.id }), { code: 'WORKFLOW_CONNECTION_CONFLICT' });
  assert.equal(node.workflowVersion, version); assert.equal(service.current.state.edges.length, 4);
});

test('history application creates own independent result cards without touching source or rerunning task', async t => {
  const { root, service } = await setup(t); const output = path.join(root, 'result.png'); await fs.writeFile(output, 'historical-output');
  await service.importAsset(output, { copy: true }); const source = service.current.state.nodes[0], asset = service.current.state.assets[0]; source.owner = 'peer';
  const history = [{ taskId: 'completed-task', nodeId: source.id, outputs: [asset], text: '历史说明', applied: true }];
  const file = path.join(service.current.canvasDir, 'generation-history.json'); await fs.writeFile(file, JSON.stringify(history)); const before = JSON.stringify(source);
  await applyHistory(service, { taskId: 'completed-task' });
  assert.equal(service.current.state.nodes.length, 3); assert.equal(JSON.stringify(source), before); assert.ok(service.current.state.nodes.slice(1).every(node => node.owner === service.identity.id && !node.taskId));
  assert.equal(service.current.state.nodes[1].assetId, asset.id); assert.equal(service.current.state.nodes[2].content, '历史说明'); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), history);
});
