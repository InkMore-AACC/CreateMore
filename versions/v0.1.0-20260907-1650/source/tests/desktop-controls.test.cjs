'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { types } = require('../app/ui/canvas-model.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/ui/desktop.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

// Exercises the actual desktop handlers and registered form/filter listeners.
// This is a renderer-boundary harness, not an Electron/native-dialog test.
function setup(resources = {}) {
  const elements = new Map(), listeners = new Map(), calls = [], notices = [];
  const ui = { selected: new Set(), staged: false }, graph = { state: { nodes: [{ id: 'own', owner: 'me', type: 'image' }], edges: [], groups: [], assets: [], settings: {} }, get(id) { return this.state.nodes.find(n => n.id === id); }, checkpoint() {} };
  const element = selector => { if (!elements.has(selector)) elements.set(selector, { style: {}, value: '', innerHTML: '', textContent: '', dataset: {}, focus() {}, closest() { return null; }, querySelector() { return null; }, remove() {}, insertAdjacentHTML(position, html) { this.innerHTML += html; } }); return elements.get(selector); };
  let panel = '', revision = 0;
  const current = () => ({ id: 'canvas', name: '测试画布', projectDir: 'C:\\project', revision, identity: { id: 'self', name: '我', color: '#fff' }, state: clone(graph.state) });
  const overrides = {};
  const D = {
    async call(method, args) {
      calls.push({ method, args: clone(args || {}) });
      if (overrides[method]) return overrides[method](args);
      if (method === 'app.status') return new Promise(() => {});
      if (method === 'resource.list') return clone(resources[args.kind] || []);
      if (method === 'resource.get' || method === 'skill.manageRead' || method === 'skill.read') return clone((resources[args.kind || 'skills'] || []).find(r => r.id === args.id));
      if (method === 'canvas.update') return { revision: ++revision };
      if (method === 'resource.apply') return current();
      if (method === 'asset.path') return 'C:\\images\\chosen.png';
      if (method === 'provider.status') return { comfyui: { ready: true, ownedInstances: [] } };
      if (method === 'provider.config') return {};
      if (method === 'task.list') return [];
      if (method === 'settings.save') return args;
      return {};
    },
    async pickFiles() { return ['C:\\images\\picked.png']; }, onEvent() {}
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const C = { esc: escape, btn: (action, label, icon, attrs = '') => '<button data-action="' + action + '" ' + attrs + '>' + label + '</button>', icon: () => '', toast: text => notices.push(text), graph, ui, types, clone, render() {}, dirty() {}, closePanel() {}, nav: () => '', panel(title, html, kind) { panel = html; ui.panelKind = kind; }, };
  const document = { querySelector: element, querySelectorAll: () => [], addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } };
  const window = { desktop: D, CreateMoreCanvas: C, addEventListener() {} };
  class FormData { constructor(form) { this.entries = Object.entries(form.values); } [Symbol.iterator]() { return this.entries[Symbol.iterator](); } }
  vm.runInNewContext(source, { window, document, FormData, CSS: { escape: value => value }, crypto: require('node:crypto'), setTimeout, clearTimeout, console });
  const desktop = window.CreateMoreDesktop;
  desktop.app.current = current(); desktop.app.status = { identity: { id: 'self' }, providers: {} };
  async function submit(name, values) {
    const button = { disabled: false }, form = { dataset: { desktopForm: name }, values, querySelector() { return button; } };
    for (const listener of listeners.get('submit')) listener({ target: form, preventDefault() {}, stopImmediatePropagation() {} });
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(button.disabled, false);
  }
  function filter(key, value) { const target = { dataset: { libraryFilter: key }, value, closest: () => null }; for (const listener of listeners.get('change') || []) listener({ target }); }
  return { desktop, handlers: desktop.handlers, app: desktop.app, graph, ui, calls, notices, overrides, element, submit, filter, listeners, panel: () => panel };
}
const resource = (id, name, tags = []) => ({ id, name, tags, enabled: true, source: 'user', revision: 1 });

test('library searches real names/descriptions/tags and combines tag filters', async () => {
  const h = setup({ characters: [{ ...resource('a', '白猫', ['动物']), description: '毛色偏暖' }, resource('b', '<b>石头</b>', ['道具'])] });
  await h.handlers['library-characters']();
  assert.match(h.panel(), /最近使用仅记录本画布/);
  h.filter('query', '偏暖'); assert.match(h.element('#library-results').innerHTML, /白猫/); assert.doesNotMatch(h.element('#library-results').innerHTML, /石头/);
  h.filter('tag', '道具'); assert.match(h.element('#library-results').innerHTML, /没有符合条件/);
  h.filter('query', ''); assert.match(h.element('#library-results').innerHTML, /&lt;b&gt;石头/);
  assert.equal(h.element('#library-count').textContent, '1 项');
});

test('resource filters never stage a configuration or clear an existing staged form', async () => {
  const h = setup({ characters: [resource('a', '白猫', ['动物'])] }); await h.handlers['library-characters']();
  for (const staged of [false, true]) {
    h.ui.staged = staged;
    for (const key of ['query', 'tag', 'sort']) {
      const target = { dataset: { libraryFilter: key }, value: key === 'sort' ? 'recent' : '', closest: () => null };
      for (const name of ['input', 'change']) for (const listener of h.listeners.get(name) || []) listener({ target });
      assert.equal(h.ui.staged, staged);
    }
  }
});

test('real desktop form input keeps unsaved protection and blocks outside navigation', async () => {
  const h = setup(), target = { dataset: {}, closest: selector => selector === '[data-desktop-form]' ? {} : null };
  for (const listener of h.listeners.get('input')) listener({ target });
  assert.equal(h.ui.staged, true);
  const button = { dataset: { action: 'library-characters' } }; let stopped = false;
  const clickTarget = { closest: selector => selector === 'button' ? button : null };
  h.listeners.get('click')[0]({ target: clickTarget, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.equal(h.ui.staged, true); assert.equal(h.calls.filter(c => c.method === 'resource.list').length, 0); assert.match(h.notices.at(-1), /保存或取消/);
});

test('recent resource sorting uses only this actor and successful usage persists in canvas settings', async () => {
  const h = setup({ skills: [resource('a', 'A 方法'), resource('b', 'B 方法')] });
  h.graph.state.settings.resourceUsage = { self: { 'skills:b': 2 }, peer: { 'skills:a': 9999999999999 } };
  await h.handlers['library-skills'](); h.filter('sort', 'recent');
  const html = h.element('#library-results').innerHTML; assert.ok(html.indexOf('B 方法') < html.indexOf('A 方法'));
  await h.handlers['resource-apply']({ dataset: { kind: 'skills', id: 'a' } });
  assert.ok(h.graph.state.settings.resourceUsage.self['skills:a'] > 2);
  assert.equal(h.graph.state.settings.resourceUsage.peer['skills:a'], 9999999999999);
  await h.desktop.sync(); assert.ok(h.calls.findLast(c => c.method === 'canvas.update').args.state.settings.resourceUsage.self['skills:a']);
  h.overrides['skill.read'] = () => { throw new Error('已停用'); };
  const before = h.graph.state.settings.resourceUsage.self['skills:a'];
  await assert.rejects(h.handlers['resource-apply']({ dataset: { kind: 'skills', id: 'a' } }), /已停用/);
  assert.equal(h.graph.state.settings.resourceUsage.self['skills:a'], before);
});

test('character chooser sends only selected asset IDs and independent text indexes', async () => {
  const h = setup({ characters: [{ ...resource('cat', '猫'), description: '一只猫', assets: [{ id: 'image', type: 'image', title: '肖像' }, { id: 'audio', type: 'audio', title: '声音' }], materials: [{ title: '性格笔记', content: '亲人' }, { title: '绑定素材', content: '已有图片', assetId: 'image' }] }] });
  await h.handlers['resource-apply']({ dataset: { kind: 'characters', id: 'cat' } });
  assert.match(h.panel(), /选择|选中/); assert.match(h.panel(), /name="material-0"/); assert.doesNotMatch(h.panel(), /name="material-1"/);
  await h.submit('character-apply', { 'asset-1': 'on', 'material-0': 'on' });
  const applied = h.calls.find(c => c.method === 'resource.apply');
  assert.deepEqual(applied.args, { kind: 'characters', id: 'cat', assetIds: ['audio'], materialIndexes: [0], includeDescription: false });
  assert.ok(h.graph.state.settings.resourceUsage.self['characters:cat']);
});

test('empty character choice does not call apply', async () => {
  const h = setup({ characters: [{ ...resource('cat', '猫'), description: '猫的设定' }] });
  await h.handlers['resource-apply']({ dataset: { kind: 'characters', id: 'cat' } }); await h.submit('character-apply', {});
  assert.ok(h.notices.some(n => /至少选择/.test(n))); assert.equal(h.calls.filter(c => c.method === 'resource.apply').length, 0);
});

test('existing resource metadata edit preserves materials and copies a selected native cover through resource.save', async () => {
  const existing = { ...resource('preset', '组合', ['原标签']), cover: 'cover.png', resourceDir: 'C:\\resources\\组合', nodes: [{ id: 'retained' }], assets: [{ id: 'retained-asset' }] };
  const h = setup({ presets: [existing] });
  await h.handlers['resource-edit']({ dataset: { kind: 'presets', id: 'preset' } });
  await h.handlers['pick-cover'](); assert.equal(h.element('[name="cover"]').value, 'C:\\images\\picked.png'); assert.equal(h.ui.staged, true);
  await h.submit('resource', { name: '改名组合', tags: '道具， 角色,道具', enabled: 'on', cover: h.element('[name="cover"]').value });
  const saved = h.calls.find(c => c.method === 'resource.save'); assert.equal(saved.args.data.cover, 'C:\\images\\picked.png'); assert.deepEqual(saved.args.data.tags, ['道具', '角色']); assert.deepEqual(saved.args.data.nodes, existing.nodes); assert.deepEqual(saved.args.data.assets, existing.assets);
  assert.equal(h.calls.filter(c => c.method === 'resource.capture').length, 0);
});

test('new preset capture leaves empty cover for the existing automatic thumbnail path', async () => {
  const h = setup(); h.ui.selected.add('own'); await h.handlers['resource-new']({ dataset: { kind: 'presets' } });
  await h.submit('resource', { name: '新组合', cover: '', tags: '', enabled: 'on' });
  const saved = h.calls.find(c => c.method === 'resource.capture'); assert.deepEqual(saved.args.nodeIds, ['own']); assert.equal(saved.args.data.cover, '');
});

test('remote execution controls use typed public schema and preserve only whitelisted values', async () => {
  const h = setup();
  h.app.deviceChoices = [{ id: 'offer', deviceId: 'peer', deviceName: '工作站', name: '图片', parameters: { steps: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, scale: { type: 'number', default: 3.5 }, enabled: { type: 'boolean', default: false }, mode: { type: 'string', enum: ['a', 'b'], default: 'b' }, apiKey: { type: 'string' }, broken: { type: 'object' } } }];
  await h.handlers['execution-use']({ dataset: { node: 'own', id: 'offer', device: 'peer' } });
  assert.match(h.panel(), /value="20"/); assert.match(h.panel(), /value="false" selected/); assert.doesNotMatch(h.panel(), /apiKey|broken/);
  await h.submit('execution-parameters', { 'execution-param-0': '8', 'execution-param-1': '2.25', 'execution-param-2': 'false', 'execution-param-3': 'option-0', unlisted: 'ignored', apiKey: 'not forwarded' });
  assert.deepEqual(clone(h.graph.get('own').execution.parameters), { steps: 8, scale: 2.25, enabled: false, mode: 'a' });
  const saved = h.calls.findLast(c => c.method === 'canvas.update'); assert.equal(saved.args.state.nodes[0].execution.deviceId, 'peer');
  assert.equal(saved.args.state.nodes[0].execution.parameters.apiKey, undefined);
});

test('remote execution rejects wrong type/range/enum and changing device drops old parameters', async () => {
  const h = setup(); h.graph.get('own').execution = { deviceId: 'old', offerId: 'old', parameters: { steps: 49 } };
  h.app.deviceChoices = [{ id: 'offer', deviceId: 'peer', deviceName: '工作站', name: '图片', parameters: { steps: { type: 'integer', minimum: 1, maximum: 50, default: 8 }, mode: { type: 'string', enum: ['a', 'b'] } } }];
  await h.handlers['execution-use']({ dataset: { node: 'own', id: 'offer', device: 'peer' } }); assert.match(h.panel(), /value="8"/); assert.doesNotMatch(h.panel(), /value="49"/);
  for (const values of [{ 'execution-param-0': '1.5' }, { 'execution-param-0': '99' }, { 'execution-param-1': 'bad' }]) await h.submit('execution-parameters', values);
  assert.equal(h.notices.length, 3); assert.equal(h.graph.get('own').execution.deviceId, 'old'); assert.equal(h.calls.filter(c => c.method === 'canvas.update').length, 0);
  h.graph.get('own').owner = 'peer'; await assert.rejects(async () => h.handlers['execution-use']({ dataset: { node: 'own', id: 'offer', device: 'peer' } }), /执行设备已失效/);
});

test('ComfyUI stop control appears only for process identities actually owned by this application', async () => {
  const h = setup(); await h.handlers.connections(); assert.match(h.panel(), /data-action="comfy-start"/); assert.doesNotMatch(h.panel(), /data-action="comfy-stop-owned"/);
  h.overrides['provider.status'] = () => ({ comfyui: { ready: true, ownedInstances: [{ id: 'owned-instance', url: 'http://127.0.0.1:8190' }] } });
  await h.handlers.connections(); assert.match(h.panel(), /data-action="comfy-stop-owned" data-id="owned-instance"/);
});

test('unknown tasks are presented as original-task checks, not fresh generation', async () => {
  const h = setup(); h.overrides['task.list'] = () => [{ id: 'unknown-1', title: '不确定任务', provider: 'image2', state: 'unknown', partialResult: { storyboard: { shots: [] } } }, { id: 'partial-1', title: '部分结果', provider: 'image2', state: 'failed', partial: true }];
  await h.handlers.tasks(); assert.match(h.panel(), /核对原任务/); assert.match(h.panel(), /重试未完成部分/); assert.match(h.panel(), /查看已完成范围/);
});

test('remote enum preserves empty-string values and boolean defaults without accepting arbitrary strings', async () => {
  const h = setup(); h.app.deviceChoices = [{ id: 'offer', deviceId: 'peer', deviceName: '设备', name: '图片', parameters: { suffix: { type: 'string', enum: ['', 'x'], default: 'x' }, flag: { type: 'boolean', enum: [false, true], default: false } } }];
  await h.handlers['execution-use']({ dataset: { node: 'own', id: 'offer', device: 'peer' } });
  assert.match(h.panel(), /value="option-0" selected> false|value="option-0" selected>false/);
  await h.submit('execution-parameters', { 'execution-param-0': 'option-0', 'execution-param-1': 'option-0' });
  assert.deepEqual(clone(h.graph.get('own').execution.parameters), { suffix: '', flag: false });
});

test('autosave settings changes preserve project-local resource use without sending it to machine settings', async () => {
  const h = setup(); h.graph.state.settings.resourceUsage = { self: { 'skills:a': 123 } };
  await h.submit('settings', { saveMinutes: '7', maxSnapshots: '75' });
  assert.deepEqual(clone(h.graph.state.settings.resourceUsage), { self: { 'skills:a': 123 } });
  assert.deepEqual(h.calls.find(c => c.method === 'settings.save').args, { saveMinutes: 7, maxSnapshots: 75 });
});

test('LAN identity panel shows complete local coordinator and pinned fingerprints without shortening', async () => {
  const h = setup(), local = '1'.repeat(32), host = '2'.repeat(32);
  h.overrides['lan.status'] = () => ({ identity: { id: local, name: '本机' }, hostId: host, pinnedHostId: host, mode: 'joined', assetsReady: 0, assetsTotal: 0, members: [{ id: host, name: '协调者' }] });
  await h.handlers.lan(); assert.match(h.panel(), new RegExp('value="' + local + '"[^>]*data-lan-fingerprint="local"')); assert.match(h.panel(), new RegExp('value="' + host + '"[^>]*data-lan-fingerprint="host"')); assert.match(h.panel(), new RegExp('value="' + host + '"[^>]*data-lan-fingerprint="pinned"'));
  assert.match(h.panel(), /首次信任/);
});

test('LAN join validates and forwards an optional full expectedHostId before connecting', async () => {
  const h = setup(); h.overrides['canvas.get'] = () => clone(h.app.current);
  await h.handlers['lan-join-form'](); assert.match(h.panel(), /name="expectedHostId"/);
  await h.submit('lan-join', { url: 'http://127.0.0.1:1234', password: 'pass', expectedHostId: 'not-full' }); assert.equal(h.calls.filter(c => c.method === 'lan.join').length, 0);
  await h.submit('lan-join', { url: 'http://127.0.0.1:1234', password: 'pass', expectedHostId: ' ABCDEF0123456789ABCDEF0123456789 ' });
  assert.equal(h.calls.find(c => c.method === 'lan.join').args.expectedHostId, 'abcdef0123456789abcdef0123456789');
});

test('execution sharing lists only configured provider resources and requires owner account consent', async () => {
  const h = setup(); h.overrides['execution.capabilities'] = () => ({ providers: [{ id: 'image2', available: true }, { id: 'runninghub', available: false, reason: '没有映射' }], workflows: [{ provider: 'image2', id: 'fixed:images', name: '已选图像模型', kinds: ['image'] }, { provider: 'runninghub', id: 'unavailable', name: '不可用资源', kinds: ['video'] }] });
  await h.handlers['execution-share'](); assert.match(h.panel(), /Codex Image2/); assert.doesNotMatch(h.panel(), /不可用资源/); assert.match(h.element('#execution-account-consent').innerHTML, /required/);
  await h.submit('execution-offer', { capability: '0', kind: 'image' }); assert.equal(h.calls.filter(c => c.method === 'execution.offer').length, 0);
  await h.submit('execution-offer', { capability: '0', kind: 'video', allowAccountUsage: 'on' }); assert.equal(h.calls.filter(c => c.method === 'execution.offer').length, 0);
  await h.submit('execution-offer', { capability: '0', kind: 'image', allowAccountUsage: 'on', members: 'member-a，member-b,member-a' });
  assert.deepEqual(h.calls.find(c => c.method === 'execution.offer').args, { provider: 'image2', workflowId: 'fixed:images', kind: 'image', allowAccountUsage: true, allowedMembers: ['member-a', 'member-b'] });
});

test('no configured execution resource exposes a confirmation form', async () => {
  const h = setup(); h.overrides['execution.capabilities'] = () => ({ providers: [{ id: 'codex', available: false, reason: '尚未登录' }], workflows: [] });
  await h.handlers['execution-share'](); assert.match(h.panel(), /当前没有已配置/); assert.match(h.panel(), /尚未登录/); assert.doesNotMatch(h.panel(), /data-desktop-form="execution-offer"/);
});

test('video annotation timestamp is frozen to the registered source and never reused on another node', async () => {
  const h = setup(); h.graph.state.nodes = [{ id: 'video-a', type: 'video', owner: 'me', assetId: 'source-a', asset: 'video.mp4', title: '视频' }, { id: 'video-b', type: 'video', owner: 'me', assetId: 'source-b', asset: 'other.mp4', title: '另一视频' }];
  h.graph.state.assets = [{ id: 'annotation', type: 'image', annotation: { sourceAssetId: 'source-a' } }]; h.overrides['media.probe'] = () => ({ duration: 10 });
  h.app.annotation = { nodeId: 'video-a', toolId: '片段重拍', sourceAssetId: 'source-a', assetId: 'annotation', time: 1.25, canvasId: h.app.current.id, projectDir: h.app.current.projectDir };
  await h.handlers.tool({ dataset: { node: 'video-a', tool: '片段重拍' } }); assert.match(h.panel(), /name="annotationTime" value="1.25"/); assert.match(h.panel(), /1\.250 秒/);
  await h.submit('tool', { start: '8', end: '10', annotationAssetId: 'annotation', annotationTime: '8' });
  assert.equal(h.calls.find(c => c.method === 'tool.submit').args.parameters.annotationTime, '1.25');
  await h.handlers.tool({ dataset: { node: 'video-b', tool: '片段重拍' } }); assert.doesNotMatch(h.panel(), /name="annotationAssetId"/);
  const before = h.calls.filter(c => c.method === 'tool.submit').length; await h.submit('tool', { annotationAssetId: 'annotation' }); assert.equal(h.calls.filter(c => c.method === 'tool.submit').length, before);
});

test('image-output tools label Image2 only while text-output tools allow Codex analysis', async () => {
  const h = setup(); h.app.tools = [{ id: 'edit', name: '重绘', handler: '重绘', mediaType: 'image', outputType: 'image', provider: 'codex' }, { id: 'caption', name: '分析', handler: '反推提示词', mediaType: 'image', outputType: 'text', provider: 'codex' }];
  await h.handlers.tool({ dataset: { node: 'own', toolId: 'edit' } }); assert.match(h.panel(), /value="image2" selected/); assert.doesNotMatch(h.panel(), /value="codex"/);
  await h.handlers.tool({ dataset: { node: 'own', toolId: 'caption' } }); assert.match(h.panel(), /value="codex" selected/);
});

test('local Comfy style option preserves prior default and whole-audio volume exposes no ignored time range', async () => {
  assert.equal(types.style.sources[0], 'Codex'); assert(types.style.sources.includes('本地 ComfyUI'));
  assert.equal(types.script.sources[0], 'Codex'); assert(types.script.sources.includes('本地 ComfyUI'));
  const h = setup(); h.graph.state.nodes = [{ id: 'audio', type: 'audio', owner: 'me', assetId: 'sound', asset: 'sound.wav', title: '声音' }]; h.overrides['media.probe'] = () => ({ duration: 4 });
  await h.handlers.tool({ dataset: { node: 'audio', tool: '音量' } }); assert.doesNotMatch(h.panel(), /name="start"|name="end"/); assert.match(h.panel(), /作用于整段音频/);
  await h.handlers.tool({ dataset: { node: 'audio', tool: '截取' } }); assert.match(h.panel(), /name="start"/); assert.match(h.panel(), /name="end"/);
});

test('device pause passes the explicitly selected provider and does not claim to pause other sources', async () => {
  const h = setup(); h.element('[name="executionPauseProvider"]').value = 'image2';
  await h.handlers['execution-pause']({ dataset: { paused: 'true' } });
  assert.deepEqual(h.calls.find(c => c.method === 'execution.pauseDevice').args, { provider: 'image2', paused: true }); assert.match(h.notices.at(-1), /Codex Image2.*其他来源不受影响/);
  h.element('[name="executionPauseProvider"]').value = 'unsupported'; await assert.rejects(h.handlers['execution-pause']({ dataset: { paused: 'true' } }), /请选择/);
});
