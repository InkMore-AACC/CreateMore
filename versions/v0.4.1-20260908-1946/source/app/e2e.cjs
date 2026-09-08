'use strict';

// Development-only DOM-event / IPC integration acceptance. No user browser,
// native dialog, screenshot, paid provider or existing project is involved.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { ResourceStore } = require('./core/resources.cjs');
const { ChatSession } = require('./core/chat-session.cjs');
const { redact } = require('./core/util.cjs');
const http = require('node:http');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function chatMockServer(){
  const fixture={mode:'late',turns:[],reads:0,waiters:new Map()};const send=(res,value)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{try{let raw='';for await(const part of req){raw+=part;if(raw.length>1000000)throw new Error('test body limit');}const data=JSON.parse(raw||'{}');
    if(req.url==='/submit'){const n=fixture.turns.length+1,turn={provider:'codex',threadId:data.threadId||'e2e-private-thread-'+n,turnId:'e2e-private-turn-'+n,remoteId:'e2e-private-turn-'+n,mode:fixture.mode,text:'E2E 原回合回答 '+n};fixture.turns.push(turn);return send(res,turn);}
    const turn=fixture.turns.find(t=>t.turnId===data.turnId);if(!turn)throw new Error('unknown mock turn');
    if(req.url==='/wait'){if(turn.mode==='unknown')return send(res,{...turn,state:'unknown'});if(turn.mode==='completed')return send(res,{...turn,state:'completed'});fixture.waiters.set(turn.turnId,res);return;}
    if(req.url==='/reconcile'){fixture.reads++;return send(res,{...turn,state:'completed'});}if(req.url==='/stop')return send(res,{state:'cancel-requested'});throw new Error('test route missing');
  }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));fixture.url='http://127.0.0.1:'+server.address().port;
  fixture.release=turn=>{const res=fixture.waiters.get(turn.turnId);if(res){fixture.waiters.delete(turn.turnId);send(res,{...turn,state:'completed'});}};
  fixture.request=async(route,data)=>{const response=await fetch(fixture.url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('Mock chat HTTP '+response.status);return response.json();};
  fixture.close=async()=>{for(const turn of fixture.turns)fixture.release(turn);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};return fixture;
}

function validateEnvironment({ appDir, dataDir, service }, argv = process.argv) {
  assert(argv.includes('--e2e-test'), 'E2E requires the explicit --e2e-test flag');
  const root = path.resolve(appDir, '.test-output');
  const rel = path.relative(root, path.resolve(dataDir));
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'E2E requires an isolated dataDir below .test-output');
  assert(!service.current && service.sessions.size === 0, 'E2E refuses an existing project session');
  assert(service.queue.tasks.length === 0, 'E2E requires a fresh, empty task queue');
  return root;
}

async function run({ window, service, appDir, dataDir }) {
  const outputRoot = validateEnvironment({ appDir, dataDir, service });
  const runDir = path.join(outputRoot, 'e2e-' + crypto.randomUUID());
  await fs.mkdir(runDir, { recursive: true });
  const reportFile = path.join(runDir, 'report.json');
  const report = {
    ok: false, startedAt: new Date().toISOString(), runDir, dataDir,
    scope: 'Electron renderer DOM events, actual preload IPC, project files and media protocol; mock generation only',
    excluded: ['pixel/visual review', 'native file dialog automation', 'real ComfyUI/Codex/Image2 generation'],
    cases: [], consoleErrors: [], providerCalls: []
  };
  const originalHub = service.hub;
  const originalResources = service.resources;
  const originalChatSession = service.chatSession;
  const consoleHandler = (event, legacyLevel, legacyMessage) => {
    const details = event?.message !== undefined ? event : { level: legacyLevel, message: legacyMessage };
    if (details.level === 'error' || details.level === 3) report.consoleErrors.push(String(details.message));
  };
  window.webContents.on('console-message', consoleHandler);
  window.webContents.setBackgroundThrottling(false);
  const evaluate = (fn, args = {}) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(args)})`);
  async function until(fn, label, timeout = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await fn();
      if (value) return value;
      await sleep(60);
    }
    throw new Error('Timed out: ' + label);
  }
  const waitDOM = (selector, timeout) => until(() => evaluate(s => !!document.querySelector(s), selector), selector, timeout);
  const click = selector => evaluate(s => {
    const el = document.querySelector(s); if (!el) throw new Error('Missing control: ' + s);
    el.click(); return { text: el.textContent.trim(), action: el.dataset.action || el.dataset.create };
  }, selector);
  const closePanel = () => evaluate(() => { window.CreateMoreCanvas.closePanel(true); window.CreateMoreCanvas.closeTransient(); });
  const state = () => evaluate(() => window.CreateMoreCanvas.clone(window.CreateMoreCanvas.state()));
  const save = () => evaluate(() => window.CreateMoreDesktop.save());
  const select = ids => evaluate(ids => { window.CreateMoreCanvas.selection(ids); document.querySelector('#workspace').focus(); }, ids);
  const keyboard = key => evaluate(key => {
    const el = document.querySelector('#workspace'); el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
  }, key);
  async function form(name, values) {
    const selector = `[data-desktop-form="${name}"]`;
    await waitDOM(selector);
    await evaluate(({ selector, values }) => {
      const form = document.querySelector(selector);
      for (const [name, value] of Object.entries(values)) {
        const el = form.elements.namedItem(name); if (!el || !('value' in el)) throw new Error('Missing or ambiguous field: ' + name);
        if (el.type === 'checkbox') el.checked = !!value; else el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (!form.reportValidity()) throw new Error('Form is invalid: ' + selector);
      form.requestSubmit();
    }, { selector, values });
    await until(() => evaluate(s => !document.querySelector(s) || document.querySelector('#panel').hidden, selector), 'submit ' + name);
  }
  async function create(type) {
    await closePanel();
    const before = new Set((await state()).nodes.map(n => n.id));
    await evaluate(() => {
      const viewport = document.querySelector('#viewport'), r = viewport.getBoundingClientRect();
      viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    });
    await click(`#menu [data-create="${type}"]`);
    const n = (await state()).nodes.find(n => !before.has(n.id));
    assert(n && n.type === type, 'Node creation button did not create requested type');
    return n;
  }
  async function editNode(id, values) {
    await select([id]);
    await evaluate(({ id, values }) => {
      for (const [prop, value] of Object.entries(values)) {
        const el = document.querySelector(`[data-owner="${CSS.escape(id)}"] [data-prop="${prop}"]`);
        if (!el) throw new Error('Missing node property: ' + prop);
        if (el.tagName === 'SELECT' && ![...el.options].some(option => option.value === value)) throw new Error('Invalid select option: ' + value);
        el.focus(); el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true })); el.blur();
      }
      document.querySelector('#workspace').focus();
    }, { id, values });
  }
  async function caseRun(name, fn) {
    const entry = { name, status: 'running' }, started = Date.now(); report.cases.push(entry);
    try { entry.evidence = await fn(); entry.status = 'passed'; }
    catch (error) {
      entry.status = 'failed'; entry.error = error.stack || error.message;
      entry.renderer = await evaluate(() => ({ title: document.title, panel: document.querySelector('#panel-title')?.textContent, panelHidden: document.querySelector('#panel')?.hidden, panelKind: window.CreateMoreCanvas?.ui.panelKind, staged: window.CreateMoreCanvas?.ui.staged, desktopForm: document.querySelector('#panel [data-desktop-form]')?.dataset.desktopForm, toast: document.querySelector('#toast')?.textContent, saveStatus: document.querySelector('#save-status')?.textContent, nodeCount: window.CreateMoreCanvas?.state().nodes.length })).catch(() => null);
      throw error;
    } finally { entry.durationMs = Date.now() - started; await fs.writeFile(reportFile, JSON.stringify(report, null, 2)); }
  }

  let projectDir, firstCanvasId, firstCanvasDir, textNode, importedNode, copiedIds, presetId, releaseImage, toolResourceId, chatMock, chatHub, chatSkill, recoveredChatId, historyWriter;
  try {
    await caseRun('renderer initialization and security boundary', async () => {
      await until(() => evaluate(() => !!window.CreateMoreDesktop?.app.status), 'initial renderer refresh', 45000);
      const info = await evaluate(() => ({ title: document.title, preload: typeof window.desktop.call, renderer: !!window.CreateMoreCanvas, require: typeof require, process: typeof process, nodes: window.CreateMoreCanvas.state().nodes.length }));
      assert.equal(info.require, 'undefined'); assert.equal(info.process, 'undefined'); assert.equal(info.nodes, 0); assert.equal(info.preload, 'function');
      return info;
    });
    // Observe real, already-initialized connections before installing the test Hub.
    // This does not submit work, launch ComfyUI, or persist account/model payloads.
    const compactStatus = status => ({
      ready: typeof status?.ready === 'boolean' ? status.ready : null,
      available: typeof status?.available === 'boolean' ? status.available : null,
      reason: typeof status?.reason === 'string' ? redact(status.reason).replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email omitted]').replace(/https?:\/\/\S+/gi, '[URL omitted]').replace(/[A-Za-z0-9_=-]{48,}/g, '[opaque value omitted]').slice(0, 300) : null
    });
    const connectivity = { checkedAt: new Date().toISOString(), scope: 'Original ProviderHub and media status; isolated fresh profile; not generation proof', providers: {}, media: null };
    const [providerStatus, mediaStatus] = await Promise.allSettled([originalHub.status(), service.media.status()]);
    if (providerStatus.status === 'fulfilled') {
      for (const id of ['comfyui', 'codex', 'image2', 'ollama', 'openai-compatible', 'runninghub']) connectivity.providers[id] = compactStatus(providerStatus.value[id]);
      try { connectivity.providers.comfyui.url = new URL(providerStatus.value.comfyui?.url).origin; } catch { connectivity.providers.comfyui.url = null; }
      connectivity.providers.codex.capabilities = (providerStatus.value.codex?.capabilities || []).filter(value => ['text', 'image-input', 'agent', 'image'].includes(value));
    } else connectivity.providerProbeError = 'Real provider status query failed; no generation was attempted';
    connectivity.media = mediaStatus.status === 'fulfilled' ? compactStatus(mediaStatus.value) : { ready: null, available: null, reason: 'Real FFmpeg/FFprobe status query failed' };
    report.originalProviderConnectivity = connectivity;
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    service.resources = new ResourceStore({ appDir: runDir });
    toolResourceId = (await service.resources.save('tools', { name: 'E2E 尺寸调整', handler: '尺寸调整', mediaType: 'image', provider: 'comfyui', enabled: true, order: 0 })).id;
    service.hub = {
      ready: Promise.resolve(),
      providers:{comfyui:{validate:async(api,mapping)=>{assert.deepEqual(Object.values(api).map(n=>n.class_type),['ExamplePrompt','ExampleOutput']);assert.ok(mapping.outputs.every(o=>o.nodeId==='2'));return {valid:true,mock:true};}}},
      status: async () => Object.fromEntries(['codex', 'image2', 'comfyui', 'ollama', 'openai-compatible', 'runninghub'].map(name => [name, { ready: true, reason: 'E2E mock only' }])),
      publicConfig: () => ({}),
      prepare: async snapshot => snapshot,
      defaultWorkflows: { list: async () => [], read: async () => { throw new Error('No real workflow is used in E2E'); } },
      run: async (snapshot, options = {}) => {
        const rel = path.relative(runDir, path.resolve(snapshot.outputDir));
        assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'Mock output must remain in the E2E project');
        assert(['image', 'text'].includes(snapshot.kind), 'E2E must never generate video');
        report.providerCalls.push({ provider: snapshot.provider, kind: snapshot.kind, nodeId: snapshot.nodeId, mock: true });
        options.onProgress?.({ progress: 50, message: 'E2E mock result; no real provider submitted' });
        if (snapshot.kind === 'image') await new Promise(resolve => { releaseImage = resolve; });
        await fs.mkdir(snapshot.outputDir, { recursive: true });
        const file = path.join(snapshot.outputDir, 'e2e-output-' + crypto.randomUUID() + (snapshot.kind === 'image' ? '.png' : '.txt'));
        await fs.writeFile(file, snapshot.kind === 'image' ? PNG : 'E2E 文字生成回写验证');
        if (snapshot.kind === 'text') await sleep(80);
        return { text: snapshot.kind === 'text' ? 'E2E 文字生成回写验证' : undefined, outputs: [{ path: file, type: snapshot.kind }] };
      },
      cancel: async () => ({ confirmed: true }), reconcile: async () => ({ state: 'unknown' }), close: async () => {}
    };
    await evaluate(() => window.CreateMoreDesktop.refresh());

    await caseRun('new project form through real IPC', async () => {
      projectDir = path.join(runDir, '项目一');
      await click('[data-action="new-project"]'); await form('new-project', { name: 'E2E 项目', directory: projectDir });
      firstCanvasId = service.current.id; firstCanvasDir = service.current.canvasDir;
      const manifest = JSON.parse(await fs.readFile(path.join(projectDir, '项目.createmore'), 'utf8'));
      assert.equal(manifest.name, 'E2E 项目'); assert.equal(manifest.canvases.length, 1);
      return { manifest: path.join(projectDir, '项目.createmore'), canvasId: firstCanvasId };
    });
    await caseRun('both queue sections begin empty', async () => {
      await click('[data-action="tasks"]'); await waitDOM('.queue-columns');
      const counts = await evaluate(() => ({ sections: document.querySelectorAll('.queue-columns > section').length, empty: document.querySelectorAll('.empty-queue').length, active: document.querySelector('#queue-count').textContent }));
      assert.equal(counts.sections, 2); assert.equal(counts.empty, 2); assert.equal(counts.active, '0'); return counts;
    });
    await caseRun('node button, prompt input and save to disk', async () => {
      textNode = await create('text'); await editNode(textNode.id, { prompt: 'E2E 用户输入保留：雨后的街道', source: 'Codex' }); await save();
      const disk = JSON.parse(await fs.readFile(path.join(firstCanvasDir, '画布.createmore'), 'utf8'));
      const node = (disk.state || disk).nodes.find(n => n.id === textNode.id);
      assert.equal(node.prompt, 'E2E 用户输入保留：雨后的街道'); assert.equal(node.owner, service.identity.id);
      return { nodeId: node.id, prompt: node.prompt, owner: node.owner, file: path.join(firstCanvasDir, '画布.createmore') };
    });
    await caseRun('actual PNG import, external reference and media protocol', async () => {
      const fixture = path.join(runDir, 'reference.png');
      const fixtureData = await evaluate(() => { const c = document.createElement('canvas'); c.width = 160; c.height = 120; const ctx = c.getContext('2d'); ctx.fillStyle = '#e8edeb'; ctx.fillRect(0, 0, 160, 120); ctx.fillStyle = '#7aadb6'; ctx.fillRect(55, 25, 50, 70); return c.toDataURL('image/png').split(',')[1]; });
      await fs.writeFile(fixture, Buffer.from(fixtureData, 'base64'));
      await evaluate(async file => { await window.CreateMoreDesktop.sync(); window.CreateMoreDesktop.apply(await window.desktop.call('asset.import', { path: file, copy: false })); }, fixture);
      importedNode = service.current.state.nodes.find(n => n.type === 'image'); assert(importedNode);
      const asset = service.current.state.assets.find(a => a.id === importedNode.assetId); assert.equal(asset.external, true); assert.equal(asset.asset, fixture);
      await until(() => evaluate(id => { const image = document.querySelector(`.node[data-id="${CSS.escape(id)}"] img`); return image && image.complete && image.naturalWidth > 0; }, importedNode.id), 'PNG decoded through media protocol');
      await save();
      const raw = await fs.readFile(path.join(firstCanvasDir, '画布.createmore'), 'utf8'); assert(!raw.includes('createmore-media:'));
      return { assetId: asset.id, external: true, reference: fixture, decoded: true };
    });
    await caseRun('annotation loads anonymous media, draws a real rectangle and saves independent PNG', async () => {
      const originalPath = await service.assetPath(importedNode.assetId), originalHash = crypto.createHash('sha256').update(await fs.readFile(originalPath)).digest('hex');
      const source = (await state()).nodes.find(n => n.id === importedNode.id);
      const dimensions = await evaluate(async ({ url, sourceAssetId }) => {
        window.__createMoreE2EAnnotation = await window.CreateMoreAnnotation.open({ url, title: 'E2E 标注', onSave: async payload => {
          const result = await window.desktop.call('asset.annotate', { sourceAssetId, ...payload });
          window.__createMoreE2EAnnotationResult = { assetId: result.assetId, marks: payload.marks };
          window.CreateMoreDesktop.apply(result.view); window.CreateMoreCanvas.closePanel(true);
        } });
        return { width: window.__createMoreE2EAnnotation.canvas.width, height: window.__createMoreE2EAnnotation.canvas.height };
      }, { url: source.asset, sourceAssetId: importedNode.assetId });
      assert.deepEqual(dimensions, { width: 160, height: 120 }); await click('[data-mark-mode="rect"]');
      await evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const points = await evaluate(() => { const r = document.querySelector('#annotation-canvas').getBoundingClientRect(); return { x1: Math.round(r.left + r.width * .2), y1: Math.round(r.top + r.height * .2), x2: Math.round(r.left + r.width * .8), y2: Math.round(r.top + r.height * .8) }; });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: points.x1, y: points.y1 });
      window.webContents.sendInputEvent({ type: 'mouseDown', x: points.x1, y: points.y1, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: points.x2, y: points.y2, button: 'left' });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: points.x2, y: points.y2, button: 'left', clickCount: 1 });
      await until(() => evaluate(() => window.__createMoreE2EAnnotation.marks.length === 1), 'real annotation pointer stroke');
      const redPixels = await evaluate(() => { const c = document.querySelector('#annotation-canvas'), bytes = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let red = 0; for (let i = 0; i < bytes.length; i += 4) if (bytes[i] > 200 && bytes[i + 1] < 130 && bytes[i + 2] < 130) red++; return red; });
      assert(redPixels > 20, 'Annotation must change actual canvas pixels'); await click('#mark-save');
      const result = await until(() => evaluate(() => window.__createMoreE2EAnnotationResult), 'annotation PNG IPC saved');
      const annotated = service.current.state.assets.find(a => a.id === result.assetId), file = await service.assetPath(result.assetId), bytes = await fs.readFile(file);
      assert.equal(annotated.annotation.sourceAssetId, importedNode.assetId); assert.equal(result.marks[0].mode, 'rect');
      assert.notEqual(crypto.createHash('sha256').update(bytes).digest('hex'), originalHash);
      assert.equal(crypto.createHash('sha256').update(await fs.readFile(originalPath)).digest('hex'), originalHash);
      assert.equal(bytes.readUInt32BE(16), 160); assert.equal(bytes.readUInt32BE(20), 120); await save();
      await evaluate(() => { delete window.__createMoreE2EAnnotation; delete window.__createMoreE2EAnnotationResult; });
      return { sourceAssetId: importedNode.assetId, annotatedAssetId: result.assetId, file, redPixels, dimensions, originalHashUnchanged: true, anonymousCORSRoundTrip: true };
    });
    await caseRun('zoom menu and keyboard duplicate', async () => {
      await closePanel(); await select([textNode.id]);
      await click('[data-action="zoom"]'); await click('#menu [data-action="set-zoom"][data-zoom="75"]');
      assert.equal((await state()).view.k, .75);
      const before = (await state()).nodes.length; await keyboard('d');
      assert.equal((await state()).nodes.length, before + 1); await save();
      return { zoom: .75, duplicatedNodeCount: before + 1 };
    });
    await caseRun('output connector creates connected node', async () => {
      await select([textNode.id]); const before = new Set((await state()).nodes.map(n => n.id));
      await click(`[data-output="${textNode.id}"]`); await click('#menu [data-create="image"]');
      const current = await state(), target = current.nodes.find(n => !before.has(n.id));
      assert(target); assert(current.edges.some(e => e.from === textNode.id && e.to === target.id)); await save();
      return { from: textNode.id, to: target.id, edges: current.edges.length };
    });
    await caseRun('copy, new canvas form, and cross-canvas paste', async () => {
      copiedIds = [textNode.id, importedNode.id]; await select(copiedIds); await keyboard('c');
      await until(() => service.clipboard?.nodes.length === 2, 'clipboard copy IPC');
      await click('[data-action="project"]'); await waitDOM('[data-action="new-canvas"]'); await click('[data-action="new-canvas"]'); await form('new-canvas', { name: '跨画布副本' });
      assert.notEqual(service.current.id, firstCanvasId); await keyboard('v');
      await until(async () => (await state()).nodes.length === 2, 'clipboard paste IPC'); await save();
      const nodes = service.current.state.nodes; assert(nodes.every(n => !copiedIds.includes(n.id) && n.owner === service.identity.id));
      const pastedImage = nodes.find(n => n.type === 'image'); assert.notEqual(pastedImage.assetId, importedNode.assetId); await fs.access(await service.assetPath(pastedImage.assetId));
      return { targetCanvas: service.current.id, newNodeIds: nodes.map(n => n.id), independentAssetId: pastedImage.assetId };
    });
    await caseRun('preset capture form and independent application', async () => {
      await select((await state()).nodes.map(n => n.id)); await click('[data-action="library-presets"]'); await waitDOM('[data-action="resource-new"]');
      await click('[data-action="resource-new"][data-kind="presets"]'); await form('resource', { name: 'E2E 独立预设', description: '测试文字与外部图片资料随预设复制', enabled: true });
      const resources = await service.resources.list('presets'); assert.equal(resources.length, 1); presetId = resources[0].id;
      await click('[data-action="library-presets"]'); await waitDOM(`[data-action="resource-apply"][data-id="${presetId}"]`);
      await click(`[data-action="resource-apply"][data-id="${presetId}"]`);
      await until(async () => (await state()).nodes.length === 4, 'preset applied to canvas'); await save();
      assert.equal(new Set(service.current.state.nodes.map(n => n.id)).size, 4);
      return { resourceId: presetId, resourceRoot: path.join(runDir, 'resources'), independentNodes: 4 };
    });
    await caseRun('image tool form opens without generating', async () => {
      const node = (await state()).nodes.find(n => n.type === 'image'); await closePanel(); await select([node.id]);
      await click(`[data-action="tool"][data-node="${node.id}"][data-tool-id="${toolResourceId}"]`); await waitDOM('[data-desktop-form="tool"]');
      const fields = await evaluate(() => [...document.querySelector('[data-desktop-form="tool"]').elements].filter(e => e.name).map(e => e.name));
      assert(fields.includes('prompt')); assert.equal(report.providerCalls.length, 0); await closePanel();
      return { sourceNode: node.id, fields, noSubmission: true };
    });
    await caseRun('custom workflow binding and mapping form refresh its retained version', async () => {
      const node = await create('custom'); await save();
      const bundle = { gui: null, api: { '1': { class_type: 'ExamplePrompt', inputs: { text: 'E2E', steps: 10, left: '', right: '' } }, '2': { class_type: 'ExampleOutput', inputs: { image: ['1', 0] } } }, mapping: { inputs: [{ id: 'prompt', nodeId: '1', input: 'text', source: 'prompt', type: 'string' }, { id: 'steps', nodeId: '1', input: 'steps', source: 'parameter', type: 'integer', default: 10, min: 1, max: 50 }, { id: 'left', nodeId: '1', input: 'left', source: 'reference', mediaType: 'image', type: 'string', index: 0 }, { id: 'right', nodeId: '1', input: 'right', source: 'reference', mediaType: 'image', type: 'string', index: 1 }], outputs: [{ id: 'image', nodeId: '2', key: 'images', mediaType: 'image', primary: true }] } };
      const result = await evaluate(bundle => window.desktop.call('workflow.save', { name: 'E2E 工作流', bundle }), bundle);
      await select([node.id]); await click(`[data-action="choose-workflow"][data-node="${node.id}"]`); await waitDOM(`[data-action="bind-custom"][data-id="${result.resource.id}"]`);
      await click(`[data-action="bind-custom"][data-id="${result.resource.id}"]`);
      await until(async () => !!(await state()).nodes.find(n => n.id === node.id)?.workflowVersion, 'workflow binding renderer refresh');
      const before = (await state()).nodes.find(n => n.id === node.id); assert.equal(typeof before.workflowRef, 'string'); assert.equal(before.workflow.gui, null);
      await select([node.id]); await click(`[data-action="mapping"][data-node="${node.id}"]`); await waitDOM('[data-desktop-form="mapping"]');
      await evaluate(() => { const field = document.querySelector('[data-map-node="1"][data-map-input="steps"] [data-map-default]'); field.value = '11'; field.dispatchEvent(new Event('input', { bubbles: true })); });
      await form('mapping', { name: 'E2E 工作流修订', outputs: JSON.stringify(bundle.mapping.outputs) });
      const after = (await state()).nodes.find(n => n.id === node.id);
      assert.equal(after.workflowName, 'E2E 工作流修订', 'Mapping save must refresh the renderer copy'); assert.notEqual(after.workflowVersion, before.workflowVersion);
      assert.equal(after.workflow.mapping.inputs.find(i => i.id === 'steps').default, 11); await save();
      const retained = service.current.state.nodes.find(n => n.id === node.id); assert.equal(retained.workflowVersion, after.workflowVersion);
      await fs.access(path.join(service.current.canvasDir, after.workflowRef));
      return { nodeId: node.id, oldVersion: before.workflowVersion, newVersion: after.workflowVersion, retainedFile: after.workflowRef, nativeConversionRequired: false, apiOnly: true };
    });
    await caseRun('ordinary local image card keeps workflow and mapping visible and saves an independent mapping',async()=>{
      const node=await create('image'),originalRead=service.hub.defaultWorkflows.read;
      const bundle=structuredClone((await state()).nodes.find(n=>n.type==='custom'&&n.workflow).workflow),unchanged=JSON.stringify(bundle);
      service.hub.defaultWorkflows.read=async()=>structuredClone(bundle);
      try{
        await editNode(node.id,{source:'本地 ComfyUI'});await evaluate(id=>{const C=CreateMoreCanvas;C.graph.get(id).workflowId='default:e2e-visible';C.dirty();C.render();},node.id);await save();
        assert.ok(await evaluate(id=>['choose-workflow','mapping'].every(action=>{const el=document.querySelector('.local-mapping-access [data-action="'+action+'"][data-node="'+id+'"]');return el?.getClientRects().length>0&&!el.closest('details');}),node.id));
        await click(`[data-action="mapping"][data-node="${node.id}"]`);await waitDOM('[data-desktop-form="mapping"]');
        await form('mapping',{name:'普通图片独立映射',outputs:JSON.stringify(bundle.mapping.outputs)});
        const saved=(await state()).nodes.find(n=>n.id===node.id);assert.equal(saved.type,'image');assert.ok(saved.workflowRef);assert.notEqual(saved.workflowId,'default:e2e-visible');assert.equal(JSON.stringify(bundle),unchanged);
        return {nodeId:node.id,alwaysVisible:true,independentVersion:saved.workflowVersion,defaultUnchanged:true};
      }finally{service.hub.defaultWorkflows.read=originalRead;}
    });
    await caseRun('custom workflow clipboard preserves portable retained reference', async () => {
      const original = (await state()).nodes.find(n => n.type === 'custom'); await select([original.id]); await keyboard('c');
      await until(() => service.clipboard?.nodes.length === 1 && service.clipboard.nodes[0].id === original.id, 'custom clipboard copied');
      const before = (await state()).nodes.length; await keyboard('v'); await until(async () => (await state()).nodes.length === before + 1, 'custom clipboard pasted');
      const copy = (await state()).nodes.find(n => n.type === 'custom' && n.id !== original.id);
      assert.equal(typeof copy.workflowRef, 'string', 'Clipboard must store the workflow path, not a runtime descriptor');
      assert.equal(copy.workflowVersion, original.workflowVersion); await save(); await fs.access(path.join(service.current.canvasDir, copy.workflowRef));
      return { originalId: original.id, copyId: copy.id, version: copy.workflowVersion, retainedFile: copy.workflowRef };
    });
    await caseRun('named custom ports are distinct and persist through real canvas IPC', async () => {
      const target = (await state()).nodes.find(n => n.type === 'custom'), source = (await state()).nodes.find(n => n.type === 'image');
      await select([target.id]);
      const counts = await evaluate(id => ({ inputs: document.querySelectorAll(`[data-input="${CSS.escape(id)}"]`).length, outputs: document.querySelectorAll(`[data-output="${CSS.escape(id)}"]`).length }), target.id);
      assert.equal(counts.inputs, 4); assert.equal(counts.outputs, 1);
      for (const inputId of ['left', 'right']) {
        await click(`[data-input="${target.id}"][data-input-id="${inputId}"]`);
        await click(`#menu [data-action="add-reference"][data-from="${source.id}"][data-input-id="${inputId}"]`);
      }
      await save();
      const incoming = service.current.state.edges.filter(e => e.from === source.id && e.to === target.id); assert.deepEqual(incoming.map(e => e.inputId).sort(), ['left', 'right']);
      const before = new Set((await state()).nodes.map(n => n.id));
      await click(`[data-output="${target.id}"][data-output-id="image"]`); await click('#menu [data-create="image"]'); await save();
      const resultNode = service.current.state.nodes.find(n => !before.has(n.id)), outgoing = service.current.state.edges.find(e => e.from === target.id && e.to === resultNode.id);
      assert.equal(outgoing.outputId, 'image');
      return { customNode: target.id, namedInputs: incoming.map(e => e.inputId), namedOutput: outgoing.outputId, rendererPorts: counts, persisted: true };
    });
    await caseRun('mock text generation button, queue, history and result IPC', async () => {
      const node = (await state()).nodes.find(n => n.type === 'text'); await editNode(node.id, { prompt: 'E2E 文字任务', source: 'Codex' });
      await click(`[data-action="generation"][data-node="${node.id}"]`);
      await until(() => service.queue.tasks.some(t => t.nodeId === node.id), 'text submitted');
      const task = service.queue.tasks.find(t => t.nodeId === node.id);
      await until(() => ['succeeded', 'failed'].includes(task.state), 'text result saved'); assert.equal(task.state, 'succeeded', task.error);
      await until(async () => (await state()).nodes.some(n => n.id === node.id && n.content === 'E2E 文字生成回写验证'), 'text result reached renderer');
      const history = await service.call('history.list'); assert(history.some(h => h.taskId === task.id));
      await fs.access(task.result.outputs[0].path); return { taskId: task.id, state: task.state, history: true, output: task.result.outputs[0].path, mock: true };
    });
    await caseRun('mock Image2 generation and decoded output PNG', async () => {
      const node = await create('image'); await editNode(node.id, { prompt: 'E2E 图片任务', source: 'Codex Image2' });
      await click(`[data-action="generation"][data-node="${node.id}"]`);
      await until(() => service.queue.tasks.some(t => t.nodeId === node.id), 'image submitted');
      const task = service.queue.tasks.find(t => t.nodeId === node.id);
      await until(() => !!releaseImage, 'mock image held for concurrent-edit test');
      await editNode(node.id, { prompt: 'E2E 图片生成中继续输入，结果回来不能覆盖' });
      releaseImage(); releaseImage = null;
      await until(() => ['succeeded', 'failed'].includes(task.state), 'image result saved'); assert.equal(task.state, 'succeeded', task.error);
      await until(() => evaluate(id => { const el = document.querySelector(`.node[data-id="${CSS.escape(id)}"] img`); return el?.complete && el.naturalWidth > 0; }, node.id), 'generated PNG decoded');
      assert.equal((await state()).nodes.find(n => n.id === node.id).prompt, 'E2E 图片生成中继续输入，结果回来不能覆盖', 'Generation event must preserve unsaved renderer edits');
      const saved = service.current.state.nodes.find(n => n.id === node.id), asset = service.current.state.assets.find(a => a.id === saved.assetId);
      assert.equal(asset.generated, true); assert.equal(asset.external, false);
      return { taskId: task.id, assetId: asset.id, output: task.result.outputs[0].path, decoded: true, mock: true };
    });
    await caseRun('settings form persists and completed queue has zero active', async () => {
      await closePanel(); await click('[data-action="navigation"]'); await click('#menu [data-action="settings"]'); await form('settings', { saveMinutes: 9, maxSnapshots: 17 });
      const settings = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')); assert.equal(settings.saveMinutes, 9); assert.equal(settings.maxSnapshots, 17);
      await click('[data-action="tasks"]'); await waitDOM('.queue-columns');
      const counts = await evaluate(() => ({ sections: document.querySelectorAll('.queue-columns > section').length, tasks: document.querySelectorAll('.task-card').length, active: document.querySelector('#queue-count').textContent }));
      assert.equal(counts.tasks, 2); assert.equal(counts.active, '0'); await closePanel(); await save();
      return { settingsFile: path.join(dataDir, 'settings.json'), saveMinutes: 9, maxSnapshots: 17, queue: counts };
    });
    await caseRun('reopen original canvas and preserve its distinct contents', async () => {
      await click('[data-action="project"]'); await waitDOM(`[data-action="open-canvas"][data-id="${firstCanvasId}"]`); await click(`[data-action="open-canvas"][data-id="${firstCanvasId}"]`);
      await until(() => service.current.id === firstCanvasId, 'original canvas reopened');
      await until(async () => (await state()).nodes.some(n => n.id === textNode.id), 'original renderer state');
      const original = (await state()).nodes.find(n => n.id === textNode.id); assert.equal(original.prompt, 'E2E 用户输入保留：雨后的街道'); assert(!original.taskId);
      return { canvasId: firstCanvasId, originalPrompt: original.prompt, noCrossCanvasResultLeak: true };
    });
    await caseRun('project switch and reopen through recent-project control', async () => {
      await closePanel(); await save(); await click('[data-action="project"]'); await waitDOM('[data-action="new-project"]'); await click('[data-action="new-project"]');
      const secondProject = path.join(runDir, '项目二'); await form('new-project', { name: 'E2E 第二项目', directory: secondProject }); assert.equal(service.current.projectDir, secondProject);
      await click('[data-action="project"]'); await waitDOM('[data-action="recent-project"]');
      await evaluate(directory => { const button = [...document.querySelectorAll('[data-action="recent-project"]')].find(b => b.dataset.path === directory); if (!button) throw new Error('Original project not listed'); button.click(); }, projectDir);
      await until(() => service.current.projectDir === projectDir, 'recent project reopened');
      return { secondProject, reopenedProject: service.current.projectDir, manifestsPreserved: true };
    });
    await caseRun('navigation waits for delayed project response without closing the next resource panel',async()=>{
      await closePanel();await click('[data-action="project"]');await waitDOM('[data-action="recent-project"]');const originalCall=service.call;let entered=false,release;
      const gate=new Promise(resolve=>{release=resolve;});service.call=async function(method,args){const result=await originalCall.call(this,method,args);if(method==='project.open'){entered=true;await gate;}return result;};
      try{
        await evaluate(directory=>{const button=[...document.querySelectorAll('[data-action="recent-project"]')].find(b=>b.dataset.path===directory);if(!button)throw new Error('测试原工程不在最近列表');button.click();},projectDir);await until(()=>entered,'project service finished while IPC held');
        await click('[data-action="library-characters"]');release();
        await until(()=>evaluate(()=>!document.querySelector('#panel').hidden&&CreateMoreCanvas.ui.panelKind==='desktop-library'),'next library remains open');
        await new Promise(resolve=>setTimeout(resolve,150));assert.ok(await evaluate(()=>!document.querySelector('#panel').hidden&&CreateMoreCanvas.ui.panelKind==='desktop-library'));
        return {delayedIPC:true,nextNavigationPreserved:true};
      }finally{release();service.call=originalCall;await closePanel();}
    });
    await caseRun('IPC preserves structured revision-conflict error', async () => {
      const error = await evaluate(async () => {
        try { await window.desktop.call('canvas.update', { state: window.CreateMoreCanvas.state(), revision: -1 }); return null; }
        catch (error) { return { code: error.code, message: error.message }; }
      });
      assert.equal(error?.code, 'REVISION_CONFLICT', JSON.stringify(error)); return error;
    });
    await caseRun('final disk and provider-isolation checks', async () => {
      await until(() => service.queue.controllers.size === 0, 'all mock tasks settled');
      const canvases = await service.store.listCanvases(projectDir); assert.equal(canvases.length, 2);
      for (const canvas of canvases) {
        const loaded = await service.store.loadCanvas(projectDir, canvas.id); assert(loaded.state.nodes.length > 0);
        assert(loaded.state.nodes.every(n => n.owner === service.identity.id));
      }
      assert.equal(report.providerCalls.length, 2); assert(report.providerCalls.every(c => c.mock && c.kind !== 'video'));
      assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
      return { canvasCount: canvases.length, mockProviderCalls: report.providerCalls.length, videoCalls: 0, realProviderCalls: 0, existingUserProjectsChanged: false };
    });
    let uiCharacter, uiCharacterNode;
    const waitLibrary = async () => {
      await until(() => evaluate(() => !document.querySelector('#panel').hidden && window.CreateMoreCanvas.ui.panelKind === 'desktop-library' && !!document.querySelector('[data-library-filter="query"]')), 'visible refreshed resource library');
      await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await evaluate(() => window.CreateMoreCanvas.ui.staged), false, 'Library navigation and filters must not create unsaved configuration');
    };
    await caseRun('resource search and tag filtering use real resource metadata through IPC', async () => {
      const portrait = path.join(runDir, 'reference.png'), pose = path.join(runDir, 'role-pose.png'); await fs.writeFile(pose, PNG);
      uiCharacter = await service.resources.save('characters', { name: 'E2E 精灵角色', description: '森林中的精灵资料', tags: ['森林', '角色'], cover: portrait, assets: [{ id: 'role-portrait', title: '角色肖像', type: 'image', path: 'assets/portrait.png', asset: 'assets/portrait.png' }, { id: 'role-pose', title: '其他姿态', type: 'image', path: 'assets/pose.png', asset: 'assets/pose.png' }], materials: [{ title: '性格笔记', content: '勇敢且谨慎' }] }, { files: [{ sourcePath: portrait, relativePath: 'assets/portrait.png' }, { sourcePath: pose, relativePath: 'assets/pose.png' }] });
      await service.resources.save('characters', { name: 'E2E 机械道具', description: '机械材质资料', tags: ['机械'], cover: portrait });
      await closePanel(); await click('[data-action="library-characters"]'); await waitLibrary();
      const change = async (key, value) => { await evaluate(({ key, value }) => { const el = document.querySelector(`[data-library-filter="${key}"]`); el.value = value; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }, { key, value }); await waitLibrary(); };
      await change('query', '精灵');
      let result = await evaluate(() => ({ count: document.querySelectorAll('#library-results .resource-card').length, text: document.querySelector('#library-results').textContent }));
      assert.equal(result.count, 1); assert.match(result.text, /E2E 精灵角色/); assert.doesNotMatch(result.text, /E2E 机械道具/);
      await change('tag', '机械'); assert.equal(await evaluate(() => document.querySelectorAll('#library-results .resource-card').length), 0);
      await change('query', ''); result = await evaluate(() => ({ count: document.querySelectorAll('#library-results .resource-card').length, text: document.querySelector('#library-results').textContent }));
      assert.equal(result.count, 1); assert.match(result.text, /E2E 机械道具/);
      await change('tag', ''); await closePanel();
      return { actualDOMEvents: true, actualResourceListIPC: true, visibleRefreshedPanel: true, filtersRemainUnstaged: true, resourceId: uiCharacter.id, manifest: path.join(uiCharacter.resourceDir, '.resource.json'), searchMatches: 1, combinedFilterMatches: 0, tagMatches: 1 };
    });
    await caseRun('character material checkboxes copy only the selected file through IPC and persist personal recent usage', async () => {
      const beforeNodes = new Set((await state()).nodes.map(n => n.id)), beforeAssets = new Set(service.current.state.assets.map(a => a.id));
      await click('[data-action="library-characters"]'); await waitLibrary(); await waitDOM(`[data-action="resource-apply"][data-id="${uiCharacter.id}"]`);
      await click(`[data-action="resource-apply"][data-id="${uiCharacter.id}"]`); await form('character-apply', { 'asset-0': true, 'asset-1': false, description: false, 'material-0': false });
      await save(); const created = service.current.state.nodes.filter(n => !beforeNodes.has(n.id)), added = service.current.state.assets.filter(a => !beforeAssets.has(a.id));
      assert.equal(created.length, 1); assert.equal(added.length, 1); uiCharacterNode = created[0];
      assert.equal(uiCharacterNode.characterSource.id, uiCharacter.id); assert.equal(uiCharacterNode.assetId, added[0].id); assert.equal(added[0].external, false);
      const source = path.join(uiCharacter.resourceDir, 'assets/portrait.png'), copy = await service.assetPath(added[0].id), sourceHash = crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
      assert.equal(crypto.createHash('sha256').update(await fs.readFile(copy)).digest('hex'), sourceHash); assert.notEqual(copy, source);
      const loaded = await service.store.loadCanvas(service.current.projectDir, service.current.id), usage = loaded.state.settings.resourceUsage[service.identity.id]['characters:' + uiCharacter.id];
      assert(Number.isFinite(usage) && usage > 0); assert.equal(service.queue.tasks.length, 2); assert.equal(report.providerCalls.length, 2);
      return { resourceId: uiCharacter.id, selectedSourceId: 'role-portrait', copiedAssetId: added[0].id, copiedFile: copy, sourceHash, createdNodes: 1, importedAssets: 1, omittedPoseAndText: true, recentUsageSaved: true, newGenerationTasks: 0 };
    });
    await caseRun('resource cover selection from a canvas image preserves library materials while saving real image bytes', async () => {
      const originalAssets = uiCharacter.assets, coverSource = await service.assetPath(uiCharacterNode.assetId);
      await select([uiCharacterNode.id]); await click('[data-action="library-characters"]'); await waitDOM(`[data-action="resource-edit"][data-id="${uiCharacter.id}"]`);
      await click(`[data-action="resource-edit"][data-id="${uiCharacter.id}"]`); await waitDOM('[data-action="pick-selection-cover"]'); await click('[data-action="pick-selection-cover"]');
      await click(`[data-action="use-selection-cover"][data-id="${uiCharacterNode.assetId}"]`);
      await until(() => evaluate(expected => document.querySelector('[name="cover"]').value === expected, coverSource), 'cover path resolved by asset IPC');
      await form('resource', { name: 'E2E 精灵角色资料更新', tags: '森林, 精灵', description: '只更新资料，不覆盖库中两个图像', enabled: true });
      const saved = await service.resources.get('characters', uiCharacter.id); assert.deepEqual(saved.assets, originalAssets); assert.deepEqual(saved.tags, ['森林', '精灵']); assert.equal(saved.materials[0].content, '勇敢且谨慎');
      const bytes = await fs.readFile(path.join(saved.resourceDir, saved.cover)); assert.deepEqual(bytes, await fs.readFile(coverSource)); assert.equal(path.isAbsolute(saved.cover), false);
      const manifest = JSON.parse(await fs.readFile(path.join(saved.resourceDir, '.resource.json'), 'utf8')); assert.equal(manifest.name, saved.name); assert.equal(manifest.assets.length, 2);
      uiCharacter = saved; return { selectedAssetId: uiCharacterNode.assetId, savedCover: path.join(saved.resourceDir, saved.cover), preservedAssets: 2, nativeDialogUsed: false, realImageBytesCopied: true, metadataSavedToDisk: true };
    });
    await caseRun('remote public parameter form keeps exact types and defaults through real canvas IPC and disk save', async () => {
      const originalOffers = service.gateway.listOffers;
      service.gateway.listOffers = async () => ({ devices: [{ deviceId: service.identity.id, name: '本机', reachable: true, offers: [] }, { deviceId: 'peer-e2e-device', name: 'E2E 工作站', reachable: true, offers: [{ id: 'e2e-offer', name: 'E2E 公开参数', kind: 'image', enabled: true, parameters: { steps: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, scale: { type: 'number', minimum: 0, maximum: 10, default: 3.5 }, flag: { type: 'boolean', default: false }, mode: { type: 'string', enum: ['', 'quality'], default: 'quality' }, apiKey: { type: 'string', default: 'must-not-render' }, malformed: { type: 'object' } } }] }] });
      try {
        await closePanel(); await select([uiCharacterNode.id]); await click(`[data-action="execution-choose"][data-node="${uiCharacterNode.id}"]`); await waitDOM('[data-action="execution-use"][data-id="e2e-offer"]');
        await click('[data-action="execution-use"][data-id="e2e-offer"]'); await waitDOM('[data-desktop-form="execution-parameters"]');
        const fields = await evaluate(() => { const f = document.querySelector('[data-desktop-form="execution-parameters"]'); return { steps: f.elements.namedItem('execution-param-0').value, flag: f.elements.namedItem('execution-param-2').value, mode: f.elements.namedItem('execution-param-3').value, count: [...f.elements].filter(e => e.name).length, text: f.textContent }; });
        assert.equal(fields.steps, '20'); assert.equal(fields.flag, 'false'); assert.equal(fields.mode, 'option-1'); assert.equal(fields.count, 4); assert.doesNotMatch(fields.text, /apiKey|must-not-render|malformed/);
        const rangeRejected = await evaluate(() => { const e = document.querySelector('[name="execution-param-0"]'); e.value = '99'; const invalid = !e.checkValidity(); e.value = '20'; return invalid; }); assert(rangeRejected);
        await form('execution-parameters', { 'execution-param-0': 8, 'execution-param-1': 2.25, 'execution-param-2': 'false', 'execution-param-3': 'option-0' }); await save();
        const loaded = await service.store.loadCanvas(service.current.projectDir, service.current.id), node = loaded.state.nodes.find(n => n.id === uiCharacterNode.id);
        assert.equal(node.execution.deviceId, 'peer-e2e-device'); assert.equal(node.execution.offerId, 'e2e-offer'); assert.deepEqual(node.execution.parameters, { steps: 8, scale: 2.25, flag: false, mode: '' }); assert.equal(service.queue.tasks.length, 2); assert.equal(report.providerCalls.length, 2);
        return { nodeId: node.id, publicFields: 4, parameters: node.execution.parameters, actualDOMEvents: true, actualCanvasSaveIPC: true, diskFile: path.join(service.current.canvasDir, '画布.createmore'), capabilityDiscovery: 'isolated mock offers only; no multi-PC claim', newGenerationTasks: 0 };
      } finally { service.gateway.listOffers = originalOffers; }
    });
    await caseRun('private chat late HTTP response stays in original history after a real canvas IPC switch',async()=>{
      chatMock=await chatMockServer();chatHub={...service.hub,prepare:async snapshot=>({...snapshot,connection:{frozen:true}}),run:async(snapshot,options)=>{const turn=await chatMock.request('/submit',{threadId:snapshot.threadId});options.onProgress({threadId:turn.threadId,turnId:turn.turnId,remoteId:turn.remoteId,message:'隔离模拟回合正在等待'});const result=await chatMock.request('/wait',{turnId:turn.turnId});if(result.state==='unknown')throw Object.assign(new Error('模拟响应状态未确认'),{uncertain:true,code:'STATUS_UNKNOWN',threadId:turn.threadId,turnId:turn.turnId,remoteId:turn.remoteId});return result;},reconcile:(snapshot,remote)=>chatMock.request('/reconcile',{turnId:remote.turnId}),cancel:remote=>chatMock.request('/stop',{turnId:remote.turnId})};service.chatSession=new ChatSession({hub:chatHub,dataDir});await service.chatSession.ready;
      chatSkill=await service.resources.save('skills',{name:'E2E 聊天方法',content:'原版本方法内容',enabled:true});await evaluate(()=>window.CreateMoreDesktop.refresh());await closePanel();await click('#agent [data-action="agent-new"]');await click(`[data-action="choose-skill"][data-id="${chatSkill.id}"]`);await until(()=>evaluate(id=>window.CreateMoreDesktop.app.skillIds.includes(id),chatSkill.id),'skill selection IPC');const original=service.current.id;
      await evaluate(()=>{document.querySelector('#chat-input').value='E2E 迟到回答留在原画布';});await click('#agent [data-action="send"]');await until(()=>chatMock.waiters.size===1,'mock chat HTTP wait');
      const other=(await service.store.listCanvases(projectDir)).find(c=>c.id!==original);await click('[data-action="project"]');await waitDOM(`[data-action="open-canvas"][data-id="${other.id}"]`);await click(`[data-action="open-canvas"][data-id="${other.id}"]`);await until(()=>evaluate(id=>window.CreateMoreDesktop.app.current.id===id,other.id),'new chat canvas rendered');
      const turn=chatMock.turns[0];chatMock.release(turn);await until(()=>evaluate(()=>!window.CreateMoreDesktop.app.chatSending),'late chat handler returned');const uiChat=await evaluate(()=>({messages:window.CreateMoreDesktop.app.messages,status:document.querySelector('.agent-status').textContent}));assert.equal(uiChat.messages.length,0);assert.match(uiChat.status,/原聊天|另一/);const history=await service.call('agent.history');assert.equal(history[0].messages.length,2);assert(history[0].messages.every(m=>m.canvasId===original));assert.equal(history[0].turns[0].skills[0].revision,chatSkill.revision);
      return {server:'loopback HTTP mock',originalCanvas:original,visibleCanvas:other.id,lateAnswerAddedToVisibleChat:false,historyMessages:2,realIPC:true};
    });
    await caseRun('unknown private turn survives controller restart and renderer reload; new display cannot bypass pending state',async()=>{
      chatMock.mode='unknown';await click('#agent [data-action="agent-new"]');await click(`[data-action="choose-skill"][data-id="${chatSkill.id}"]`);await until(()=>evaluate(id=>window.CreateMoreDesktop.app.skillIds.includes(id),chatSkill.id),'skill selection before unknown turn');await evaluate(()=>{document.querySelector('#chat-input').value='E2E 未知回合只核对';});await click('#agent [data-action="send"]');await until(()=>evaluate(()=>window.CreateMoreDesktop.app.chatStatus?.phase==='unknown'&&!window.CreateMoreDesktop.app.chatSending),'unknown state shown');
      assert.equal(await evaluate(()=>document.querySelector('#agent-recovery').hidden),false);assert.match(await evaluate(()=>document.querySelector('#agent-context').textContent),/核对原回合/);await click('#agent [data-action="agent-new"]');await until(()=>evaluate(()=>window.CreateMoreDesktop.app.messages.length===0&&document.querySelector('#agent [data-action="send"]').disabled),'new chat display still blocked');const sent=chatMock.turns.length;await click('#agent [data-action="send"]');assert.equal(chatMock.turns.length,sent);
      service.chatSession=new ChatSession({hub:chatHub,dataDir});await service.chatSession.ready;const loaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.webContents.reload();await loaded;await until(()=>evaluate(()=>window.CreateMoreDesktop?.app.chatStatus?.phase==='unknown'),'durable agent.status after renderer restart');assert.equal(await evaluate(()=>document.querySelector('#agent-recovery').hidden),false);assert.equal(await evaluate(()=>document.querySelector('#agent [data-action="send"]').disabled),true);
      await click('#agent [data-action="agent-reconcile"]');await until(()=>evaluate(()=>!window.CreateMoreDesktop.app.chatRecovering&&window.CreateMoreDesktop.app.messages.some(m=>m.role==='assistant')),'recovered answer displayed');const history=await service.call('agent.history'),recovered=history.find(c=>c.threadId===chatMock.turns.at(-1).threadId);recoveredChatId=recovered.id;assert.equal(recovered.messages.length,2);assert.equal(chatMock.reads,1);assert.equal(chatMock.turns.length,sent);assert.equal(await evaluate(()=>document.querySelector('#agent-recovery').hidden),true);await evaluate(()=>window.CreateMoreDesktop.handlers['agent-reconcile']());assert.equal(chatMock.reads,1);assert.equal((await service.call('agent.history')).find(c=>c.id===recovered.id).messages.length,2);
      return {controllerReloadedFromDisk:true,electronRendererReloaded:true,actualIPC:true,submissions:sent,originalTurnReads:1,recoveryMessages:2,newDisplayBypassBlocked:true};
    });
    await caseRun('private history shows original canvas and Skill version and confirms cross-canvas continuation scope',async()=>{
      const record=(await service.call('agent.history')).find(c=>c.id===recoveredChatId),origin=record.turns.at(-1),other=(await service.store.listCanvases(projectDir)).find(c=>c.id!==origin.canvasId);await click('[data-action="project"]');await waitDOM(`[data-action="open-canvas"][data-id="${other.id}"]`);await click(`[data-action="open-canvas"][data-id="${other.id}"]`);await until(()=>evaluate(id=>window.CreateMoreDesktop.app.current.id===id,other.id),'other scope open');await click('#agent [data-action="agent-history"]');await waitDOM(`[data-action="agent-open"][data-id="${record.id}"]`);const list=await evaluate(()=>document.querySelector('#panel-body').textContent);assert.match(list,/原画布/);assert.match(list,/E2E 聊天方法 v1/);await click(`[data-action="agent-open"][data-id="${record.id}"]`);const context=await evaluate(()=>document.querySelector('#agent-context').textContent);assert.match(context,/历史回合来自/);assert.match(context,/本次继续将作用于/);assert.match(context,/E2E 聊天方法/);
      await evaluate(()=>{document.querySelector('#chat-input').value='本次不应直接跨画布发送';});const sent=chatMock.turns.length;await click('#agent [data-action="send"]');await waitDOM('[data-action="agent-continue-current"]');assert.equal(chatMock.turns.length,sent);assert.match(await evaluate(()=>document.querySelector('#panel-body').textContent),/当前画布/);await click('#panel [data-action="agent-open-canvas"]');await until(()=>evaluate(id=>window.CreateMoreDesktop.app.current.id===id,origin.canvasId),'origin canvas via chat button');assert.equal(chatMock.turns.length,sent);assert.equal(await evaluate(()=>window.CreateMoreDesktop.app.chatRecord.id),record.id);
      return {historyCanvas:origin.canvasId,skillRevision:origin.skills[0].revision,crossScopeConfirmation:true,originalCanvasButtonRealIPC:true,noImplicitSubmission:true};
    });
    await caseRun('completed private answer awaiting history save shows recovery entry and saves once without server regeneration',async()=>{
      chatMock.mode='completed';await click('#agent [data-action="agent-new"]');historyWriter=service.saveChatTurn;let blocked=true;service.saveChatTurn=function(result){if(blocked&&result.state==='completed'){blocked=false;throw new Error('E2E 模拟聊天列表暂不能保存');}return historyWriter.call(this,result);};await evaluate(()=>{document.querySelector('#chat-input').value='E2E 已完成结果待保存';});await click('#agent [data-action="send"]');await until(()=>evaluate(()=>window.CreateMoreDesktop.app.chatStatus?.pendingResults===1&&!window.CreateMoreDesktop.app.chatSending),'pending result recovery control');service.saveChatTurn=historyWriter;historyWriter=null;assert.equal(await evaluate(()=>document.querySelector('#agent-recovery').hidden),false);assert.equal(await evaluate(()=>document.querySelector('#agent [data-action="send"]').disabled),true);const sent=chatMock.turns.length,reads=chatMock.reads;await click('#agent [data-action="agent-reconcile"]');await until(()=>evaluate(()=>!window.CreateMoreDesktop.app.chatRecovering&&window.CreateMoreDesktop.app.chatStatus?.pendingResults===0),'pending answer associated');const history=await service.call('agent.history'),record=history.find(c=>c.threadId===chatMock.turns.at(-1).threadId);assert.equal(record.messages.length,2);assert.equal(chatMock.turns.length,sent);assert.equal(chatMock.reads,reads);assert.equal(await evaluate(()=>document.querySelector('#agent-recovery').hidden),true);return {pendingResultVisible:true,recoveryViaIPC:true,messageCount:2,extraSubmit:0,extraRemoteRead:0};
    });
    await caseRun('LAN fingerprint form performs real loopback identity pinning and displays complete verified identities', async () => {
      const { CollaborationService } = require('./core/collaboration.cjs'), originalCanvasId = service.current.id, originalJoin = service.collab.join;
      const peer = new CollaborationService({ dataDir: path.join(runDir, 'fingerprint-peer'), pollMs: 60000, getSnapshot: () => ({ canvasId: 'e2e-fingerprint-canvas', version: 5, nodes: [], edges: [], groups: [], assets: [] }) });
      await peer.ready; const hosted = await peer.startHosting({ host: '127.0.0.1', port: 0, password: 'e2e-fingerprint-pass' });
      service.collab.join = function(args) { return originalJoin.call(this, { ...args, host: '127.0.0.1', port: 0 }); };
      try {
        await closePanel(); await evaluate(() => window.CreateMoreDesktop.handlers.lan()); await waitDOM('[data-lan-fingerprint="local"]');
        assert.equal(await evaluate(() => document.querySelector('[data-lan-fingerprint="local"]').value), service.identity.id); assert.equal(service.identity.id.length, 32);
        await click('[data-action="lan-join-form"]'); await form('lan-join', { url: hosted.url, password: 'e2e-fingerprint-pass', expectedHostId: hosted.identity.id.toUpperCase() });
        await until(() => service.collab.status().mode === 'joined', 'real signed loopback join');
        await evaluate(() => window.CreateMoreDesktop.handlers.lan()); await waitDOM('[data-lan-fingerprint="pinned"]');
        const shown = await evaluate(() => Object.fromEntries(['local', 'host', 'pinned'].map(key => [key, document.querySelector(`[data-lan-fingerprint="${key}"]`).value])));
        assert.deepEqual(shown, { local: service.identity.id, host: hosted.identity.id, pinned: hosted.identity.id });
        const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'session.json'), 'utf8')); assert.equal(saved.pins[hosted.url], hosted.identity.id);
        return { actualDOMForm: true, actualJoinIPC: true, realSignedLoopbackHandshake: true, fullIdentityLength: 32, fingerprints: shown, durablePinFile: path.join(dataDir, 'session.json'), loopbackOnly: true, multiPCClaim: false };
      } finally {
        service.collab.join = originalJoin; await service.call('lan.leave').catch(() => {}); await peer.dispose();
        await evaluate(async id => { window.CreateMoreCanvas.closePanel(true); window.CreateMoreDesktop.apply(await window.desktop.call('canvas.open', { id })); }, originalCanvasId);
      }
    });
    await caseRun('account-backed execution offer requires explicit consent and persists only the selected configured capability', async () => {
      const previousHub = service.hub; let offeredId;
      service.hub = { ...previousHub, config: { codex: { model: 'e2e-account-model' } }, providers: { comfyui: { status: async () => ({ ready: false, available: false, reason: 'E2E no local generation' }) }, codex: { status: async () => ({ ready: true, capabilities: ['text', 'image', 'image-input'], models: [{ model: 'e2e-account-model', isDefault: true }] }) } } };
      try {
        await closePanel(); await evaluate(() => window.CreateMoreDesktop.handlers['execution-share']()); await waitDOM('[data-desktop-form="execution-offer"]');
        const selected = await evaluate(() => { const field = document.querySelector('[name="capability"]'), option = [...field.options].find(o => o.textContent.includes('Codex Image2')); if (!option) throw new Error('Configured Image2 resource missing'); field.value = option.value; field.dispatchEvent(new Event('change', { bubbles: true })); const consent = document.querySelector('[name="allowAccountUsage"]'); return { index: option.value, consentRequired: consent.required, consentChecked: consent.checked, initialValid: document.querySelector('[data-desktop-form="execution-offer"]').checkValidity(), kinds: [...document.querySelector('[name="kind"]').options].map(o => o.value) }; });
        assert.equal(selected.consentRequired, true); assert.equal(selected.consentChecked, false); assert.equal(selected.initialValid, false); assert.deepEqual(selected.kinds, ['image']);
        const before = service.gateway.offers.length; await form('execution-offer', { capability: selected.index, kind: 'image', members: service.identity.id, allowAccountUsage: true });
        assert.equal(service.gateway.offers.length, before + 1); const offer = service.gateway.offers.at(-1); offeredId = offer.id;
        assert.equal(offer.provider, 'image2'); assert.match(offer.workflowId, /^configured:image2:/); assert.equal(offer.kind, 'image'); assert.equal(offer.accountUsageAllowed, true); assert.deepEqual(offer.allowedMembers, [service.identity.id]);
        const file = path.join(dataDir, 'shared-execution', 'shared-execution.json'), saved = JSON.parse(await fs.readFile(file, 'utf8')); assert(saved.offers.some(o => o.id === offer.id && o.accountUsageAllowed));
        await evaluate(() => window.CreateMoreDesktop.handlers['execution-devices']()); await waitDOM('[name="executionPauseProvider"]');
        await evaluate(() => { const input = document.querySelector('[name="executionPauseProvider"]'); input.value = 'image2'; input.dispatchEvent(new Event('change', { bubbles: true })); });
        await click('[data-action="execution-pause"][data-paused="true"]'); await until(() => service.queue.paused.has('resource:image2'), 'Image2-only pause via real IPC'); assert(!service.queue.paused.has('resource:comfyui'));
        await click('[data-action="execution-pause"][data-paused="false"]'); await until(() => !service.queue.paused.has('resource:image2'), 'Image2-only scheduling restored'); await closePanel();
        assert.equal(service.queue.tasks.length, 2); assert.equal(report.providerCalls.length, 2);
        return { actualDOMConsent: true, initiallyUnchecked: true, actualOfferIPC: true, provider: offer.provider, fixedBindingId: offer.workflowId, file, allowedMembers: offer.allowedMembers, mockAccountStatusOnly: true, realAccountCalls: 0, newGenerationTasks: 0, offerStoppedAfterCheck: true, explicitImage2PauseIPC: true, otherSourcesRemainUnpaused: true };
      } finally { if (offeredId) await service.gateway.stopOffer(offeredId); service.hub = previousHub; }
    });
    await caseRun('reshoot annotation keeps its actual sampled timestamp after time edits and cannot carry over to another video node', async () => {
      const videoFile = path.join(runDir, 'annotation-timing-fixture.mp4');
      await require('./core/media.cjs').run(service.media.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=teal:s=128x128:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile]);
      const tool = await service.resources.save('tools', { name: 'E2E 片段重拍', handler: '片段重拍', mediaType: 'video', outputType: 'video', provider: 'comfyui', enabled: true });
      await evaluate(async file => { await window.CreateMoreDesktop.sync(); window.CreateMoreDesktop.apply(await window.desktop.call('asset.import', { path: file, copy: false })); await window.CreateMoreDesktop.refresh(); }, videoFile);
      const node = service.current.state.nodes.find(n => n.asset === videoFile); assert(node); await select([node.id]);
      await click(`[data-action="tool"][data-node="${node.id}"][data-tool-id="${tool.id}"]`); await waitDOM('#tool-preview');
      const annotateAt = async time => {
        await until(() => evaluate(() => document.querySelector('#tool-preview')?.readyState >= 1), 'video metadata loaded');
        await evaluate(time => { document.querySelector('#tool-preview').currentTime = time; }, time);
        await until(() => evaluate(time => Math.abs(document.querySelector('#tool-preview').currentTime - time) < .001 && !document.querySelector('#tool-preview').seeking, time), 'video frame seek completed');
        await click('[data-action="annotate-tool"]'); await waitDOM('#mark-save'); await click('#mark-save');
        await until(() => evaluate(time => document.querySelector('[name="annotationTime"]')?.value === String(time) && !!document.querySelector('[data-desktop-form="tool"]'), time), 'annotation timestamp returned to tool form');
        return evaluate(() => ({ assetId: document.querySelector('[name="annotationAssetId"]').value, time: document.querySelector('[name="annotationTime"]').value, text: document.querySelector('#panel-body').textContent }));
      };
      const first = await annotateAt(.5); assert.match(first.text, /0\.500 秒/);
      const second = await annotateAt(1.5); assert.notEqual(second.assetId, first.assetId, 'Reannotation must not restore old hidden asset ID'); assert.match(second.text, /1\.500 秒/);
      const originalCall = service.call; let request;
      service.call = function(method, args) { if (method === 'tool.submit') { request = structuredClone(args); return Promise.resolve({ id: 'e2e-reshoot-ui-only' }); } return originalCall.call(this, method, args); };
      try { await form('tool', { start: 1.7, end: 2, prompt: '保持原场景，只改变主体颜色' }); }
      finally { service.call = originalCall; }
      assert.equal(request.nodeId, node.id); assert.equal(request.parameters.start, '1.7'); assert.equal(request.parameters.annotationTime, '1.5'); assert.equal(request.parameters.annotationAssetId, second.assetId);
      await select([node.id]); const previousIds = new Set((await state()).nodes.map(n => n.id)); await keyboard('d');
      const duplicate = await until(async () => (await state()).nodes.find(n => !previousIds.has(n.id) && n.type === 'video'), 'second independent video node');
      await select([duplicate.id]); await click(`[data-action="tool"][data-node="${duplicate.id}"][data-tool-id="${tool.id}"]`); await waitDOM('[data-desktop-form="tool"]');
      await until(() => evaluate(id => !document.querySelector('#panel').hidden && window.CreateMoreCanvas.ui.context === id, duplicate.id), 'second video tool form finished loading');
      assert.equal(await evaluate(() => !!document.querySelector('[name="annotationAssetId"]')), false); await closePanel(); await save();
      assert.equal(service.queue.tasks.length, 2); assert.equal(report.providerCalls.length, 2);
      return { sourceVideo: videoFile, videoSource: 'local FFmpeg color fixture, not generated by an AI/provider', sampleTimes: [.5, 1.5], latestAnnotation: second.assetId, editedStart: 1.7, submittedAnnotationTime: 1.5, actualFrameExtractionAndAnnotationIPC: true, oldHiddenAssetNotRestored: true, secondNodeCannotReuse: true, toolSubmission: 'intercepted at service boundary after real IPC; no video generation submitted', newGenerationTasks: 0 };
    });
    await caseRun('image tool creates connected draft without running and generates back into that draft',async()=>{
      await closePanel();const source=(await state()).nodes.find(n=>n.type==='image'&&n.assetId&&n.owner==='me');assert(source);
      const resource=await service.resources.save('tools',{name:'E2E 打光草稿',handler:'打光',mediaType:'image',outputType:'image',provider:'image2',enabled:true,order:-10});
      await evaluate(()=>window.CreateMoreDesktop.refresh());await select([source.id]);const beforeTasks=service.queue.tasks.length;
      await click(`[data-action="tool"][data-node="${source.id}"][data-tool-id="${resource.id}"]`);
      const draft=await until(async()=> (await state()).nodes.find(n=>n.toolResource?.id===resource.id),'connected tool draft');await save();
      assert.equal(service.queue.tasks.length,beforeTasks);assert.equal(draft.assetId,undefined);assert.equal(draft.source,'Codex Image2');assert.ok(service.current.state.edges.some(e=>e.from===source.id&&e.to===draft.id));
      assert.equal(await evaluate(()=>!!document.querySelector('[data-desktop-form="tool"]')?.getClientRects().length),false);
      await select([draft.id]);await click(`[data-action="generation"][data-node="${draft.id}"]`);
      await until(()=>!!releaseImage,'tool draft mock execution');releaseImage();releaseImage=null;
      await until(()=>service.queue.tasks.find(t=>t.nodeId===draft.id)?.state==='succeeded','tool draft mock saved');
      assert.ok(service.current.state.nodes.find(n=>n.id===draft.id)?.assetId);assert.equal(service.current.state.nodes.filter(n=>n.toolResource?.id===resource.id).length,1);
      return {draftNodeId:draft.id,noTaskOnToolSelection:true,sameNodeReceivesResult:true,generation:'mock provider; real renderer and IPC'};
    });
    await caseRun('selected composer remains readable and inside canvas across zoom levels',async()=>{
      await closePanel();
      const sizes=[];
      for(const zoom of [.5,1]){
        await evaluate(k=>{const C=window.CreateMoreCanvas,n=C.state().nodes.find(n=>n.type==='image'&&n.asset);C.ui.selected=new Set([n.id]);C.state().view={x:280-n.x*k,y:120-n.y*k,k};C.render();},zoom);
        await evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const bounds=await evaluate(()=>{const p=document.querySelector('.node.selected .node-params').getBoundingClientRect(),w=document.querySelector('#workspace').getBoundingClientRect();return {width:p.width,height:p.height,left:p.left,right:p.right,top:p.top,bottom:p.bottom,workspace:{left:w.left,right:w.right,top:w.top,bottom:w.bottom}};});
        assert.ok(bounds.width>=600,'编辑面板未保持可读宽度');assert.ok(bounds.left>=bounds.workspace.left&&bounds.right<=bounds.workspace.right,'编辑面板横向越界');assert.ok(bounds.top>=bounds.workspace.top&&bounds.bottom<=bounds.workspace.bottom,'编辑面板纵向越界');sizes.push({zoom,...bounds});
        await fs.writeFile(path.join(runDir,'selected-composer-'+zoom+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      }
      assert.ok(Math.abs(sizes[0].width-sizes[1].width)<2,'缩放画布不应缩小编辑控件');return {sizes};
    });
    await caseRun('capture this isolated Electron test window for manual review', async () => {
      await closePanel(); await evaluate(() => { window.CreateMoreCanvas.selection([]); window.CreateMoreCanvas.action('arrange'); document.querySelector('#toast').hidden = true; window.CreateMoreCanvas.fit(); }); await save();
      await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const capture = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); assert(!capture.isEmpty(), 'Electron window capture is empty');
      const file = path.join(runDir, 'main-window.png'); await fs.writeFile(file, capture.toPNG());
      return { file, dimensions: capture.getSize(), source: 'Only this newly created application test window', pixelAssertions: false };
    });
    await caseRun('new project files open through renderer IPC and real second-instance launch without losing unsaved input', async()=>{
      await closePanel();
      const original=service.current,dir=path.join(runDir,'新格式 双击工程');
      const p=await service.store.createProject(dir,'双击测试');
      const blank={version:5,nodes:[],edges:[],groups:[],assets:[],view:{x:0,y:0,k:1},seq:0};
      await service.store.createCanvas(dir,'主画布',blank);
      const second=await service.store.createCanvas(dir,'第二画布',blank),file=path.join(second.canvasDir,'画布.createmore');
      await evaluate(()=>{const C=window.CreateMoreCanvas;C.graph.state.settings.documentUnsavedMarker='保存后切换';C.dirty();});
      const {spawn}=require('node:child_process'),launchArgs=require('electron').app.isPackaged?[file]:[appDir,file];
      const child=spawn(process.execPath,launchArgs,{env:{...process.env,CREATEMORE_DATA_DIR:dataDir},windowsHide:true,stdio:'ignore'});
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('second-instance launch timed out'));},20000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('second instance exit '+code));});});
      await until(()=>evaluate(id=>window.CreateMoreDesktop.app.current?.id===id,second.id),'actual second-instance document delivery');
      assert.equal((await service.store.loadCanvas(original.projectDir,original.id)).state.settings.documentUnsavedMarker,'保存后切换');
      await evaluate(async file=>window.CreateMoreDesktop.openDocument(file),path.join(dir,'项目.createmore'));
      assert.equal(service.current.id,p.canvases?.[0]?.id|| (await service.store.listCanvases(dir))[0].id);
      const currentId=service.current.id;
      await evaluate(async file=>{window.CreateMoreCanvas.ui.staged=true;try{await window.CreateMoreDesktop.openDocument(file);throw new Error('should reject staged edit');}catch(e){if(!String(e.message).includes('面板'))throw e;}finally{window.CreateMoreCanvas.ui.staged=false;}},file);
      assert.equal(service.current.id,currentId);
      const saveSession=service.saveSession;service.saveSession=async()=>{throw new Error('document-test disk failure');};
      try{await assert.rejects(evaluate(async file=>window.CreateMoreDesktop.openDocument(file),file));assert.equal(service.current.id,currentId);}finally{service.saveSession=saveSession;}
      return {file,realSecondProcess:true,unsavedSaved:true,stagedEditBlocked:true,failedSaveBlocked:true,newFormat:2};
    });
    report.ok = true;
  } catch (error) {
    report.error = error.stack || error.message;
  } finally {
    releaseImage?.();
    if(historyWriter)service.saveChatTurn=historyWriter;
    if(chatMock)await chatMock.close();
    await until(() => service.queue.controllers.size === 0, 'mock tasks settled before restoring real Hub').catch(error => { report.ok = false; report.cleanupError = error.message; });
    service.hub = originalHub; service.resources = originalResources;service.chatSession=originalChatSession;
    window.webContents.removeListener('console-message', consoleHandler);
    report.finishedAt = new Date().toISOString(); report.passed = report.cases.filter(c => c.status === 'passed').length;
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(outputRoot, 'electron-e2e-latest.json'), JSON.stringify({ ok: report.ok, passed: report.passed, reportFile, runDir, finishedAt: report.finishedAt }, null, 2));
  }
  return report;
}

module.exports = { run, validateEnvironment };
