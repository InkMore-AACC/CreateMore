'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { validateBundle } = require('../providers/workflows.cjs');
const { child, regularFile, noLinks, scrubCredentials, rewriteStrings } = require('./storage.cjs');
const { types } = require('../ui/canvas-model.js');

const clone = value => JSON.parse(JSON.stringify(value));
const uid = prefix => prefix + '-' + crypto.randomUUID();
const reject = (code, message) => { throw Object.assign(new Error(message), { code }); };
const scalarStrings = value => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(scalarStrings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(scalarStrings) : [];
};
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

function withoutRuntime(node) {
  const copy = scrubCredentials(clone(node));
  for (const key of ['taskId', 'error', 'history', 'generationHistory', 'workflowHistory', 'tasks', 'taskState', 'progress', 'lastResultAt', 'styleTrace']) delete copy[key];
  if (String(copy.workflowId || '').startsWith('default:') || copy.workflow?.origin === 'default') delete copy.workflow;
  return copy;
}

function ownNode(service, canvas, nodeId) {
  const node = canvas.state.nodes.find(item => item.id === nodeId);
  if (!node) reject('NODE_NOT_FOUND', '请选择需要配置的卡片。');
  if (node.owner !== service.identity.id) reject('FORBIDDEN', '只能配置自己的卡片；可先复制他人的卡片。');
  return node;
}

async function resolveSource(service, canvas, reference) {
  if (typeof reference !== 'string' || !reference) reject('ASSET_NOT_FOUND', '资源没有可读取的素材。');
  const record = canvas.state.assets.find(asset => [asset.id, asset.asset, asset.path].includes(reference));
  if (record) return service.store.resolveAssetPath(canvas.projectDir, canvas.id, record);
  if (reference.startsWith('createmore-media://asset/')) {
    const file = service.mediaFiles?.get(reference.split('/').pop());
    if (!file) reject('ASSET_NOT_FOUND', '预览引用已失效，请重新选择素材。');
    return (await regularFile(file)).absolute;
  }
  return (await regularFile(path.isAbsolute(reference) ? reference : child(canvas.canvasDir, reference))).absolute;
}

async function gatherFiles(service, canvas, nodes, additionalReferences = []) {
  const needed = new Set([...nodes.flatMap(scalarStrings), ...additionalReferences.filter(Boolean)]);
  const records = canvas.state.assets.filter(asset => [asset.id, asset.asset, asset.path].some(value => needed.has(value)));
  const matched = new Set(records.flatMap(asset => [asset.id, asset.asset, asset.path]));
  const explicit = [...nodes.map(node => node.asset), ...nodes.flatMap(node => (node.shots || []).map(shot => shot.frame)), ...additionalReferences].filter(Boolean);
  for (const reference of explicit) if (!matched.has(reference)) {
    const actual = await resolveSource(service, canvas, reference);
    records.push({ id: uid('resource-asset'), title: path.basename(actual), type: require('./storage.cjs').mediaType(actual), asset: reference, path: reference });
    matched.add(reference);
  }
  const files = [], assets = [], replacements = new Map();
  for (const record of records) {
    const actual = await resolveSource(service, canvas, record.asset || record.path || record.id);
    const relative = 'assets/' + uid('material') + path.extname(actual).toLowerCase().slice(0, 16);
    files.push({ sourcePath: actual, relativePath: relative });
    const asset = { ...scrubCredentials(record), asset: relative, path: relative, external: false };
    delete asset.missing; assets.push(asset);
    for (const value of [record.asset, record.path, actual]) if (typeof value === 'string') replacements.set(value, relative);
  }
  return { files, assets, replacements };
}

async function thumbnail(nodes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'createmore-thumbnail-'));
  const x = Math.min(...nodes.map(node => node.x)), y = Math.min(...nodes.map(node => node.y));
  const width = Math.max(1, ...nodes.map(node => node.x - x + node.w)), height = Math.max(1, ...nodes.map(node => node.y - y + node.h));
  const scale = Math.min(560 / width, 310 / height);
  const rects = nodes.map(node => `<g transform="translate(${40 + (node.x - x) * scale},${45 + (node.y - y) * scale})"><rect width="${Math.max(10, node.w * scale)}" height="${Math.max(10, node.h * scale)}" rx="7" fill="#30383e" stroke="#5aa9bb" stroke-width="1.5"/><text x="8" y="19" fill="#e7f0f4" font-family="sans-serif" font-size="11">${xml(String(node.title || node.type).slice(0, 18))}</text></g>`).join('');
  const file = path.join(dir, 'cover.svg');
  await fs.writeFile(file, `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#192126"/>${rects}<text x="40" y="382" fill="#9fb1b9" font-family="sans-serif" font-size="12">CreateMore · ${nodes.length} 个节点</text></svg>`, 'utf8');
  return { file, async cleanup() { if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('createmore-thumbnail-')) reject('UNSAFE_PATH', '缩略图临时目录校验失败。'); await fs.rm(dir, { recursive: true, force: true }); } };
}

function sourceDependencies(nodes, allEdges, ids) {
  const dependencies = [];
  for (const edge of allEdges) if (ids.has(edge.to) && !ids.has(edge.from)) dependencies.push({ type: 'external-input', nodeId: edge.to, sourceId: edge.from, input: edge.inputId || edge.toPort || edge.inputPort || null });
  for (const node of nodes) if (String(node.workflowId || '').startsWith('default:')) dependencies.push({ type: 'machine-default-workflow', nodeId: node.id, workflowId: node.workflowId });
  return dependencies;
}

async function capture(service, { kind, data = {}, nodeIds = [], assetId } = {}) {
  const canvas = service.requireCurrent();
  return service.mutate(async () => {
    if (!['presets', 'characters', 'skills', 'styles'].includes(kind)) reject('RESOURCE_KIND_UNSUPPORTED', '此入口仅用于预设、角色和 Skill。');
    if (kind === 'skills' || kind === 'styles') {
      const resource = await service.resources.save('skills', { ...data, ...(kind === 'styles' ? { classification: 'style' } : {}) });
      return { ...(await service.view(canvas)), resource };
    }
    const ids = new Set(nodeIds), selected = canvas.state.nodes.filter(node => ids.has(node.id));
    if (kind === 'presets' && !selected.length) reject('SELECTION_REQUIRED', '请先选择要保存为预设的节点。');
    if (nodeIds.some(id => !canvas.state.nodes.some(node => node.id === id))) reject('NODE_NOT_FOUND', '选区包含已不存在的卡片，请重新选择。');
    const nodes = selected.map(withoutRuntime);
    let cover = data.cover || (kind === 'characters' ? assetId || (selected.length === 1 && selected[0].type === 'image' ? selected[0].assetId || selected[0].asset : null) : null);
    if (kind === 'characters' && !cover) reject('CHARACTER_COVER_REQUIRED', '请为角色指定名称和图片封面。');
    const gathered = await gatherFiles(service, canvas, nodes, [assetId, cover]);
    let generated;
    try {
      if (cover) {
        const record = gathered.assets.find(asset => asset.id === cover);
        cover = record?.asset || gathered.replacements.get(cover) || cover;
      } else {
        cover = gathered.assets.find(asset => asset.type === 'image')?.asset;
        if (!cover) { generated = await thumbnail(nodes); cover = generated.file; }
      }
      const cleanData = scrubCredentials(clone(data));
      for (const key of ['tasks', 'history', 'generationHistory', 'reference']) delete cleanData[key];
      const payload = { ...cleanData, cover, assets: gathered.assets };
      if (kind === 'presets') {
        payload.nodes = rewriteStrings(nodes, gathered.replacements);
        payload.edges = canvas.state.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(clone);
        payload.groups = canvas.state.groups.map(group => ({ ...clone(group), members: group.members.filter(member => ids.has(member)) })).filter(group => group.members.length > 1);
        payload.dependencies = sourceDependencies(nodes, canvas.state.edges, ids);
      } else {
        payload.materials = nodes.filter(node => node.content || node.prompt).map(node => ({ type: node.type, title: node.title, content: node.content || node.prompt, assetId: node.assetId }));
      }
      const resource = await service.resources.save(kind, payload, { files: gathered.files });
      return { ...(await service.view(canvas)), resource };
    } finally { if (generated) await generated.cleanup(); }
  });
}

async function importResourceAssets(service, canvas, resource) {
  const replacements = new Map(), imported = [];
  for (const old of resource.assets || []) {
    const source = child(resource.resourceDir, old.path || old.asset);
    let asset;
    try { asset = await service.store.importAsset(canvas.projectDir, canvas.id, source, { copy: true, title: old.title }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const reference = 'other/' + uid('missing') + path.extname(old.asset || old.path || '').slice(0, 16);
      asset = { ...clone(old), id: uid('asset'), asset: reference, path: reference, external: false, missing: true, missingReason: '资源包缺少素材文件，请重新指定。' };
    }
    imported.push(asset);
    replacements.set(old.id, asset.id);
    for (const reference of [old.asset, old.path]) if (typeof reference === 'string') replacements.set(reference, asset.asset);
  }
  return { imported, replacements };
}

async function retainNodeWorkflow(service, canvas, node, identity) {
  if (!node.workflow || String(node.workflowId || '').startsWith('default:') || node.workflow.origin === 'default') { if (String(node.workflowId || '').startsWith('default:')) delete node.workflow; return; }
  const bundle = { gui: node.workflow.gui ?? null, api: node.workflow.api, mapping: node.workflow.mapping };
  validateBundle(bundle);
  const retained = await service.store.retainWorkflow(canvas.projectDir, canvas.id, { ...bundle, id: identity || node.workflowId || uid('workflow'), version: node.workflowVersion || node.workflow.revision || 1, origin: 'custom' });
  node.workflow = { ...scrubCredentials(bundle), origin: 'custom' };
  node.workflowRef = retained.path; node.workflowVersion = retained.hash;
}

async function finish(service, canvas) {
  canvas.dirty = true; canvas.revision++;
  if (service.syncSharedAssets) await service.syncSharedAssets(canvas);
  return service.view(canvas);
}

function compatibleMapping(previous, next, edges, nodeId, nodes = []) {
  if (!previous || !edges.some(edge => edge.from === nodeId || edge.to === nodeId)) return;
  const category = field => new Map((field || []).map(port => [String(port.id), port]));
  for (const direction of ['inputs', 'outputs']) {
    const oldPorts = category(direction === 'inputs' ? previous.inputs.filter(p => p.source === 'reference') : previous.outputs), newPorts = category(direction === 'inputs' ? next.inputs.filter(p => p.source === 'reference') : next.outputs);
    for (const edge of edges.filter(edge => direction === 'inputs' ? edge.to === nodeId : edge.from === nodeId)) {
      const explicit = direction === 'inputs' ? edge.inputId || edge.toPort || edge.inputPort : edge.outputId || edge.fromPort || edge.outputPort;
      const source = direction === 'inputs' && nodes.find(n => n.id === edge.from);
      if (direction === 'inputs' && (explicit === '$style' || (!explicit && source?.type === 'style'))) continue;
      if (direction === 'inputs' && (explicit === '$prompt' || (!explicit && ['text','script','character'].includes(source?.type) && previous.inputs.some(p => p.source === 'prompt')))) {
        if (!next.inputs.some(p => p.source === 'prompt')) reject('WORKFLOW_CONNECTION_CONFLICT', '已有提示文字输入；请保留提示词映射或先断开该控制连线。');
        continue;
      }
      const old = explicit ? oldPorts.get(String(explicit)) : [...oldPorts.values()][0];
      const current = old ? newPorts.get(String(old.id)) : null;
      const oldType = old?.mediaType || old?.type, currentType = current?.mediaType || current?.type;
      const count = direction === 'inputs' ? edges.filter(e => e.to === nodeId && (e.inputId || e.toPort || e.inputPort || [...oldPorts.keys()][0]) === String(old?.id)).length : 0;
      if (!old || !current || (oldType && currentType !== oldType) || (direction === 'inputs' && !current.multiple && count > 1)) reject('WORKFLOW_CONNECTION_CONFLICT', '新工作流的公开端口与现有连线不兼容；请先确认并断开相关连线，旧卡片配置未修改。');
    }
  }
}

async function bindWorkflow(service, canvas, resource, nodeId) {
  const node = ownNode(service, canvas, nodeId);
  const bundle = validateBundle({ gui: resource.gui ?? null, api: resource.api, mapping: resource.mapping });
  compatibleMapping(node.workflow?.mapping, bundle.mapping, canvas.state.edges, node.id, canvas.state.nodes);
  const next = clone(node);
  const previous = node.workflow ? { workflow: clone(node.workflow), workflowId: node.workflowId, workflowName: node.workflowName, workflowVersion: node.workflowVersion, workflowRef: node.workflowRef, parameters: clone(node.parameters || {}) } : null;
  if (previous) next.workflowHistory = [...(node.workflowHistory || []), previous];
  Object.assign(next, { workflow: { ...bundle, origin: 'custom' }, workflowId: resource.id, workflowName: resource.name, workflowVersion: resource.revision, source: '本地 ComfyUI', mapping: clone(bundle.mapping), dependencyIssues: [] });
  await retainNodeWorkflow(service, canvas, next, resource.id);
  const defaults = Object.fromEntries(bundle.mapping.inputs.filter(input => input.source === 'parameter' && input.default !== undefined).map(input => [input.id, input.default]));
  next.parameters = { ...defaults, ...(node.parameters || {}) };
  const main = bundle.mapping.outputs.find(output => output.primary || output.preview) || bundle.mapping.outputs[0];
  if (main?.mediaType || main?.type) next.outputType = main.mediaType || main.type;
  // Task identity is retained: results still match the frozen old workflow version, not this revision.
  Object.assign(node, next);
}

async function skillAttachments(service, canvas, directory) {
  const files = [], assets = [];
  const walk = async (folder, relative = '') => {
    await noLinks(folder);
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || /^(?:auth|credentials|secrets|connections)\.json$/i.test(entry.name)) continue;
      const reference = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) reject('SYMLINK_NOT_ALLOWED', 'Skill 附属资料包含符号链接，未导入。');
      if (entry.isDirectory()) await walk(child(folder, entry.name), reference);
      else if (entry.isFile() && reference.toLowerCase() !== 'skill.md') {
        const asset = await service.store.importAsset(canvas.projectDir, canvas.id, child(folder, entry.name), { copy: true, title: reference });
        assets.push(asset); files.push({ relativePath: reference, assetId: asset.id, asset: asset.asset });
      }
    }
  };
  await walk(directory); return { files, assets };
}

async function apply(service, { kind, id, nodeId, assetIds, includeDescription, materialIndexes } = {}) {
  const canvas = service.requireCurrent();
  return service.mutate(async () => {
    if (kind === 'styles') {
      const skill = await service.resources.readSkill(id);
      const attachments = await skillAttachments(service, canvas, skill.baseDirectory);
      const node = service.newNode('style', { title: skill.name, content: skill.content, skill: { id: skill.id, name: skill.name, revision: skill.revision, content: skill.content, classification: skill.classification, files: attachments.files } }, canvas);
      canvas.state.nodes.push(node); canvas.state.assets.push(...attachments.assets);
      return finish(service, canvas);
    }
    const resource = await service.resources.get(kind, id);
    if (resource.enabled === false) reject('RESOURCE_DISABLED', '此资源已禁用，请启用后再应用。');
    if (kind === 'workflows') { await bindWorkflow(service, canvas, resource, nodeId); return finish(service, canvas); }
    if (!['presets', 'characters'].includes(kind)) reject('RESOURCE_KIND_UNSUPPORTED', '此资源不能直接应用到画布。');
    if (kind === 'presets' && !Array.isArray(resource.nodes)) reject('PRESET_INVALID', '预设缺少节点资料。');
    let selectedResource = resource, selectedMaterials = resource.materials || [];
    if (kind === 'characters') {
      const assets = resource.assets || [], materials = resource.materials || [];
      if (includeDescription !== undefined && typeof includeDescription !== 'boolean') reject('CHARACTER_SELECTION_INVALID', '角色描述选项必须为开启或关闭。');
      if (assetIds !== undefined && (!Array.isArray(assetIds) || assetIds.some(value => typeof value !== 'string' || !assets.some(asset => asset.id === value)))) reject('CHARACTER_SELECTION_INVALID', '所选素材不属于当前角色资源，请重新选择。');
      if (materialIndexes !== undefined && (!Array.isArray(materialIndexes) || materialIndexes.some(value => !Number.isInteger(value) || value < 0 || value >= materials.length || typeof materials[value]?.content !== 'string' || !materials[value].content || materials[value].assetId))) reject('CHARACTER_SELECTION_INVALID', '所选文字资料不属于当前角色的独立文字素材，请重新选择。');
      selectedResource = { ...resource, assets: assetIds === undefined ? assets : assets.filter(asset => assetIds.includes(asset.id)) };
      selectedMaterials = materialIndexes === undefined ? materials : materials.filter((_, index) => materialIndexes.includes(index));
      const hasDescription = includeDescription !== false && ['description', 'story', 'personality', 'background'].some(key => typeof resource[key] === 'string' && resource[key].trim());
      if (!selectedResource.assets.length && !hasDescription && !selectedMaterials.some(material => material.content && !material.assetId)) reject('CHARACTER_SELECTION_EMPTY', '请至少选择一项角色素材或文字描述。');
    }
    const { imported, replacements } = await importResourceAssets(service, canvas, selectedResource), created = [], edges = [], groups = [];
    if (kind === 'presets') {
      const nodes = rewriteStrings(resource.nodes.map(withoutRuntime), replacements), map = new Map();
      const minX = nodes.length ? Math.min(...nodes.map(node => node.x)) : 0, minY = nodes.length ? Math.min(...nodes.map(node => node.y)) : 0;
      const offset = 120 + canvas.state.nodes.length % 6 * 45;
      for (const original of nodes) {
        const node = service.newNode(original.type, { ...original, id: uid('n'), owner: service.identity.id, x: original.x - minX + offset, y: original.y - minY + 150, presetSource: { id: resource.id, revision: resource.revision } }, canvas);
        map.set(original.id, node.id);
        if (!Object.hasOwn(types, node.type)) node.dependencyIssues = ['未知节点类型，原始参数与连接已保留。'];
        try { await retainNodeWorkflow(service, canvas, node); }
        catch (error) {
          if (!['WORKFLOW_INVALID', 'GUI_INVALID', 'API_INVALID', 'MAPPING_INVALID'].includes(error.code)) throw error;
          node.dependencyIssues = [...(node.dependencyIssues || []), '自定义工作流配置不完整，原始配置已保留：' + error.message];
          node.workflowInvalid = true;
        }
        created.push(node);
      }
      for (const edge of resource.edges || []) if (map.has(edge.from) && map.has(edge.to)) edges.push({ ...clone(edge), id: uid('e'), from: map.get(edge.from), to: map.get(edge.to) });
      for (const group of resource.groups || []) { const members = group.members.filter(id => map.has(id)).map(id => map.get(id)); if (members.length > 1) groups.push({ ...clone(group), id: uid('g'), owner: service.identity.id, members }); }
      for (const dependency of resource.dependencies || []) {
        const node = created.find(item => item.id === map.get(dependency.nodeId));
        if (node) node.dependencyIssues = [...(node.dependencyIssues || []), dependency.type === 'external-input' ? '预设原有外部输入未复制，请补充参考素材。' : '需要当前电脑配置默认工作流：' + dependency.workflowId];
      }
    } else {
      let index = 0;
      for (const asset of imported) {
        const type = ['image', 'video', 'audio', 'text'].includes(asset.type) ? asset.type : 'custom';
        created.push(service.newNode(type, { title: resource.name + ' · ' + asset.title, assetId: asset.id, asset: asset.asset, content: '角色资料', x: 120 + index++ * 420, y: 160, characterSource: { id: resource.id, revision: resource.revision } }, canvas));
      }
      const descriptions = includeDescription === false ? [] : ['description', 'story', 'personality', 'background'].filter(key => typeof resource[key] === 'string' && resource[key].trim()).map(key => resource[key]);
      for (const material of selectedMaterials) if (material.content && !material.assetId) descriptions.push(material.title + '\n' + material.content);
      if (descriptions.length) created.push(service.newNode('character', { title: resource.name, content: descriptions.join('\n\n'), characterSource: { id: resource.id, revision: resource.revision }, x: 120 + index * 420, y: 160 }, canvas));
    }
    for (const node of created) {
      const references = new Set(scalarStrings(node));
      if (imported.some(asset => asset.missing && (references.has(asset.id) || references.has(asset.asset)))) node.dependencyIssues = [...(node.dependencyIssues || []), '缺少资源素材，请重新指定文件。'];
      if (node.dependencyIssues?.length) node.error = node.dependencyIssues.join('\n');
    }
    canvas.state.nodes.push(...created); canvas.state.edges.push(...edges); canvas.state.groups.push(...groups); canvas.state.assets.push(...imported);
    return finish(service, canvas);
  });
}

async function saveWorkflow(service, { name, bundle, resourceId, nodeId } = {}) {
  const canvas = service.requireCurrent();
  return service.mutate(async () => {
    if (nodeId) ownNode(service, canvas, nodeId);
    if (bundle?.gui && !bundle.api) reject('NATIVE_CONVERSION_REQUIRED', '普通工作流须先在原生 ComfyUI 前端完成 API 转换；不会猜测第三方节点的执行数据。');
    const validated = validateBundle({ gui: bundle?.gui ?? null, api: bundle?.api, mapping: bundle?.mapping });
    if (nodeId) compatibleMapping(canvas.state.nodes.find(node => node.id === nodeId).workflow?.mapping, validated.mapping, canvas.state.edges, nodeId, canvas.state.nodes);
    const resource = await service.resources.save('workflows', { ...(resourceId ? { id: resourceId } : {}), name, ...validated, origin: 'custom', apiOnly: !validated.gui });
    if (nodeId) { await bindWorkflow(service, canvas, resource, nodeId); return { ...(await finish(service, canvas)), resource }; }
    return { ...(await service.view(canvas)), resource };
  });
}

async function applyHistory(service, { taskId } = {}) {
  const canvas = service.requireCurrent();
  return service.mutate(async () => {
    const history = JSON.parse(await fs.readFile(child(canvas.canvasDir, 'generation-history.json'), 'utf8'));
    const record = history.find(item => item.taskId === taskId);
    if (!record) reject('HISTORY_NOT_FOUND', '本画布没有此生成历史。');
    const prepared = [];
    for (const old of record.outputs || []) {
      let asset = canvas.state.assets.find(item => item.id === old.id);
      if (asset) await service.store.resolveAssetPath(canvas.projectDir, canvas.id, asset);
      else {
        const actual = await service.store.resolveAssetPath(canvas.projectDir, canvas.id, old);
        asset = await service.store.importAsset(canvas.projectDir, canvas.id, actual, { copy: false, generated: true });
      }
      prepared.push(asset);
    }
    const source = canvas.state.nodes.find(node => node.id === record.nodeId), created = [];
    for (const asset of prepared) {
      const type = ['image', 'video', 'audio', 'text'].includes(asset.type) ? asset.type : 'custom';
      const node = service.newNode(type, { title: (source?.title || '历史结果') + ' · 取用', assetId: asset.id, asset: asset.asset, content: type === 'text' && record.text ? record.text : '历史素材', historySource: { taskId: record.taskId, assetId: asset.id }, x: (source?.x || 120) + (source?.w || 300) + 100, y: (source?.y || 160) + created.length * 300 }, canvas);
      created.push(node);
    }
    if (record.text && !prepared.some(asset => asset.type === 'text')) created.push(service.newNode('text', { title: (source?.title || '历史结果') + ' · 取用', content: record.text, historySource: { taskId: record.taskId }, x: (source?.x || 120) + (source?.w || 300) + 100, y: (source?.y || 160) + created.length * 300 }, canvas));
    if (!created.length) reject('HISTORY_EMPTY', '此历史尚无可取用结果。');
    canvas.state.assets = [...new Map([...canvas.state.assets, ...prepared].map(asset => [asset.id, asset])).values()];
    canvas.state.nodes.push(...created);
    if (source) for (const node of created) canvas.state.edges.push({ id: uid('e'), from: source.id, to: node.id });
    return finish(service, canvas);
  });
}

module.exports = { capture, apply, saveWorkflow, applyHistory };
