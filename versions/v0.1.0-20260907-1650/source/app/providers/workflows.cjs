'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ProviderError, writeAtomic } = require('./util.cjs');

function validateBundle(bundle) {
  const { gui, api, mapping } = bundle || {};
  if (!api || typeof api !== 'object' || Array.isArray(api) || !Object.keys(api).length) throw new ProviderError('工作流缺少可执行 API 数据', 'WORKFLOW_INVALID');
  if (gui != null && (!Array.isArray(gui.nodes) || !Array.isArray(gui.links))) throw new ProviderError('普通工作流必须包含 nodes 与 links', 'GUI_INVALID');
  for (const [id, node] of Object.entries(api)) if (!node || typeof node.class_type !== 'string' || !node.inputs || Array.isArray(node.inputs)) throw new ProviderError(`执行节点 ${id} 无效`, 'API_INVALID');
  if (!mapping || !Array.isArray(mapping.inputs) || !Array.isArray(mapping.outputs) || !mapping.outputs.length) throw new ProviderError('必须配置公开输入及至少一个输出', 'MAPPING_INVALID');
  const ids = new Set();
  for (const input of mapping.inputs) {
    if (input.id==null || String(input.id)==='' || ids.has(String(input.id))) throw new ProviderError('公开输入标识缺失或重复', 'MAPPING_INVALID'); ids.add(String(input.id));
    if(input.source==='reference'&&['$style','$prompt'].includes(String(input.id)))throw new ProviderError('参考输入不能使用画布保留端口 $style 或 $prompt','MAPPING_INVALID');
    const node = api[String(input.nodeId)]; if (!node || !Object.hasOwn(node.inputs, input.input)) throw new ProviderError(`输入 ${input.id} 指向不存在的节点参数`, 'MAPPING_INVALID');
    if (!['prompt','parameter','reference','constant'].includes(input.source)) throw new ProviderError(`输入 ${input.id} 缺少明确来源`, 'MAPPING_INVALID');
  }
  const outputIds=new Set();for (const output of mapping.outputs) {if (!api[String(output.nodeId)] || output.id==null || String(output.id)==='' || !output.key || outputIds.has(String(output.id))) throw new ProviderError('输出须明确节点、结果字段与不重复的固定标识', 'MAPPING_INVALID');outputIds.add(String(output.id));}
  return bundle;
}
function bindInputs(bundle, snapshot, uploaded = []) {
  validateBundle(bundle); const api = structuredClone(bundle.api);
  const referenceInputs = bundle.mapping.inputs.filter(i => i.source === 'reference');
  const refs=Array.from({length:Math.max(snapshot.references?.length||0,uploaded.length)},(_,index)=>({...snapshot.references?.[index],...uploaded[index]}));const used=new Set();const groups=new Map();
  for(const input of referenceInputs){let selected=refs.map((ref,index)=>({ref,index})).filter(({ref})=>ref.inputId!=null&&String(ref.inputId)===String(input.id));if(!selected.length){selected=input.multiple?refs.map((ref,index)=>({ref,index})).filter(({ref})=>ref.inputId==null||ref.inputId===''):refs[input.index||0]&&(refs[input.index||0].inputId==null||refs[input.index||0].inputId==='')?[{ref:refs[input.index||0],index:input.index||0}]:[];}if(!input.multiple&&selected.length>1)throw new ProviderError(`输入 ${input.id} 只接受一个参考素材`,'REFERENCE_COUNT');selected.forEach(({index})=>used.add(index));groups.set(input.id,selected.map(({ref})=>ref));}
  if(refs.some((_,index)=>!used.has(index)))throw new ProviderError('有参考素材未绑定到有效输入端口；请核对端口与映射，未静默丢弃','REFERENCE_COUNT');
  for (const input of bundle.mapping.inputs) {
    let value;
    if (input.source === 'prompt') value = snapshot.prompt;
    else if (input.source === 'reference') { const selected=groups.get(input.id)||[];value = input.multiple ? selected.map(r => r.name) : selected[0]?.name; if (input.mediaType && selected.some(r=>r.type!==input.mediaType)) throw new ProviderError(`输入 ${input.id} 的素材类型不符`, 'REFERENCE_TYPE');if(input.required&&input.multiple&&!selected.length)throw new ProviderError(`缺少输入：${input.label || input.id}`,'INPUT_REQUIRED'); }
    else if (input.source === 'constant') value = input.value;
    else value = snapshot.parameters?.[input.id] ?? input.default;
    if (value == null || value === '') { if (input.required) throw new ProviderError(`缺少输入：${input.label || input.id}`, 'INPUT_REQUIRED'); if (value == null) continue; }
    if (input.type === 'number' || input.type === 'integer') { value = Number(value); if (!Number.isFinite(value) || (input.type === 'integer' && !Number.isInteger(value)) || (input.min != null && value < input.min) || (input.max != null && value > input.max)) throw new ProviderError(`参数超出范围：${input.label || input.id}`, 'PARAMETER_RANGE'); }
    if (input.options && !input.options.includes(value)) throw new ProviderError(`参数选项无效：${input.id}`, 'PARAMETER_OPTION');
    api[String(input.nodeId)].inputs[input.input] = value;
  }
  return api;
}
class WorkflowStore {
  constructor(root) { this.root = path.resolve(root); }
  folder(id) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ProviderError('工作流标识无效', 'INVALID_ID'); return path.join(this.root, id); }
  async save(id, bundle, nativeConvert) {
    if (bundle.gui && !bundle.api) { if (!nativeConvert) throw new ProviderError('请在原生 ComfyUI 编辑器打开后保存，不能猜测第三方节点的 API 转换', 'NATIVE_CONVERSION_REQUIRED'); bundle = { ...bundle, api: await nativeConvert(bundle.gui) }; }
    validateBundle(bundle); const folder = this.folder(id); const version = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex').slice(0, 24); const target = path.join(folder, 'versions', version);
    await fs.mkdir(target, { recursive: true });
    await Promise.all([writeAtomic(path.join(target, 'workflow.json'), JSON.stringify(bundle.gui ?? null, null, 2)), writeAtomic(path.join(target, 'workflow.api.json'), JSON.stringify(bundle.api, null, 2)), writeAtomic(path.join(target, 'mapping.json'), JSON.stringify(bundle.mapping, null, 2))]);
    await this.read(id, version); // The only visible switch happens after all three files can be read together.
    await writeAtomic(path.join(folder, 'current.json'), JSON.stringify({ version, updatedAt: new Date().toISOString() })); return { id, version, path: target };
  }
  async read(id, version) { const folder = this.folder(id); version ||= JSON.parse(await fs.readFile(path.join(folder, 'current.json'), 'utf8')).version; if (!/^[a-f0-9]{24}$/.test(version)) throw new ProviderError('工作流版本无效', 'INVALID_VERSION'); const target = path.join(folder, 'versions', version); const [gui,api,mapping] = await Promise.all(['workflow.json','workflow.api.json','mapping.json'].map(f => fs.readFile(path.join(target,f),'utf8').then(JSON.parse))); return validateBundle({ gui,api,mapping }); }
}
module.exports = { WorkflowStore, validateBundle, bindInputs };
