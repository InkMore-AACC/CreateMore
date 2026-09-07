'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ProviderError, endpoint, jsonFetch, post, sleep, download, saveText, mediaType, abortCheck } = require('./util.cjs');
const { validateBundle, bindInputs } = require('./workflows.cjs');

class ComfyProvider {
  constructor(config = {}, options = {}) { this.config = config; this.fetch = options.fetch || fetch; this.spawn = options.spawn || spawn; this.owned = null; }
  get url() { return endpoint(this.config.url, 'http://127.0.0.1:8188'); }
  request(route, options, timeout) { return jsonFetch(this.fetch, this.url + route, options, timeout); }
  async status() { try { const [stats, queue] = await Promise.all([this.request('/system_stats', {}, 2500), this.request('/queue', {}, 2500)]); return { ready:true, available:true, url:this.url, capabilities:['image','video','audio','text','workflow'], system:stats.system, devices:stats.devices, running:queue.queue_running?.length || 0, pending:queue.queue_pending?.length || 0, owned:!!this.owned }; } catch(e) { return { ready:false, available:false, url:this.url, reason:e.message, code:e.code }; } }
  async inspect() { const [status, nodes] = await Promise.all([this.status(), this.request('/object_info')]); return { ...status, nodes }; }
  async start() {if(this.starting)return this.starting;this.starting=this.launch().finally(()=>{this.starting=null;});return this.starting;}
  async launch() {
    if ((await this.status()).ready) return { reused:true, ...await this.status() };
    const { installDir, pythonPath, args = [] } = this.config;
    if (!installDir || !pythonPath || !Array.isArray(args) || args.some(x => typeof x !== 'string')) throw new ProviderError('请先配置现有 ComfyUI 安装目录、Python 与启动参数', 'LAUNCH_CONFIG_REQUIRED');
    await fs.access(path.join(installDir, 'main.py')); await fs.access(pythonPath);
    const u = new URL(this.url); if (!['127.0.0.1','localhost','[::1]'].includes(u.hostname)) throw new ProviderError('只能启动本机 ComfyUI；远程设备请由其所有者启动', 'REMOTE_LAUNCH');
    let error = '';if(!this.owned){const child=this.spawn(pythonPath, [path.join(installDir,'main.py'), '--listen', '127.0.0.1', '--port', u.port || '8188', ...args], { cwd:installDir, windowsHide:true, stdio:['ignore','pipe','pipe'] });this.owned=child;
      child.stdout?.on('data', () => {}); child.stderr?.on('data', d => { error = (error+d).slice(-4000); }); child.on('error', e => { error=e.message;if(this.owned===child)this.owned=null; }); child.on('exit', () => {if(this.owned===child)this.owned=null; });}
    for (let i=0;i<90;i++) { await sleep(1000); if ((await this.status()).ready) return { reused:false, ...await this.status() }; if (!this.owned) throw new ProviderError('ComfyUI 启动失败','LAUNCH_FAILED',{error}); }
    throw new ProviderError('ComfyUI 尚未就绪；保留后台以便诊断，不重复启动', 'LAUNCH_TIMEOUT', {error});
  }
  async stopOwned() { if (!this.owned) return { stopped:false, reason:'不是由 CreateMore 启动的进程' }; const queue=await this.request('/queue'); if (queue.queue_running?.length || queue.queue_pending?.length) throw new ProviderError('后台仍有任务，不能直接关闭','BUSY');const child=this.owned;
    if(child.exitCode!=null||child.signalCode!=null){if(this.owned===child)this.owned=null;return {stopped:true};}
    const stopped=await new Promise(resolve=>{let timer;const finish=value=>{clearTimeout(timer);child.removeListener?.('exit',onExit);resolve(value);};const onExit=()=>finish(true);child.once?.('exit',onExit);timer=setTimeout(()=>finish(false),Math.max(10,Math.min(Number(this.optionsStopTimeout)||10000,10000)));if(!child.kill())finish(false);});
    if(stopped&&this.owned===child)this.owned=null;return {stopped,reason:stopped?undefined:'已向自有后台发送停止信号，尚未确认退出；保留进程记录'};
  }
  async upload(reference, signal) {
    if (!reference.path) throw new ProviderError('参考素材缺少本机路径','REFERENCE_MISSING'); const bytes=await fs.readFile(reference.path); const name=`cm-${crypto.randomUUID()}${path.extname(reference.path)}`; const form=new FormData(); form.append('image',new Blob([bytes]),name); form.append('type','input'); form.append('subfolder','CreateMore'); form.append('overwrite','false');
    const result=await this.request('/upload/image',{method:'POST',body:form,signal},120000); if (!result.name) throw new ProviderError('上传接口未返回素材名称','UPLOAD_FAILED'); return {name:[result.subfolder,result.name].filter(Boolean).join('/'),type:reference.type || mediaType(reference.path)};
  }
  async validate(api) {
    const nodes=await this.request('/object_info'); const issues=[];
    for(const [id,node] of Object.entries(api)) { const def=nodes[node.class_type]; if(!def) {issues.push({nodeId:id,reason:`缺少节点 ${node.class_type}`});continue;} for(const key of Object.keys(def.input?.required || {}))if(!Object.hasOwn(node.inputs,key))issues.push({nodeId:id,input:key,reason:'缺少必需参数'});for(const [key,spec] of Object.entries({...def.input?.required,...def.input?.optional})) { const val=node.inputs[key];const options=Array.isArray(spec?.[0])?spec[0]:spec?.[0]==='COMBO'?spec?.[1]?.options:null;const fileUpload=spec?.[1]?.image_upload||spec?.[1]?.audio_upload||spec?.[1]?.video_upload;if(options && !fileUpload && val!=null && !Array.isArray(val) && !options.includes(val)) issues.push({nodeId:id,input:key,reason:'模型或选项不存在',value:val});if(['INT','FLOAT'].includes(spec?.[0]) && val!=null && !Array.isArray(val) && (typeof val!=='number'||!Number.isFinite(val)||(spec[0]==='INT'&&!Number.isInteger(val))||(spec[1]?.min!=null&&val<spec[1].min)||(spec[1]?.max!=null&&val>spec[1].max)))issues.push({nodeId:id,input:key,reason:'数值类型或范围无效'}); } }
    if(issues.length) throw new ProviderError('工作流与当前 ComfyUI 环境不兼容','ENVIRONMENT_MISMATCH',{issues}); return {valid:true};
  }
  async run(snapshot,{onProgress=()=>{},signal,outputDir}={}) {
    if(!outputDir) throw new ProviderError('生成结果目录未指定','OUTPUT_DIR_REQUIRED'); const bundle=validateBundle(snapshot.workflow); abortCheck(signal);
    if(this.config.installDir&&this.config.pythonPath){onProgress({state:'connecting',message:'正在检测并复用本机 ComfyUI；未运行时使用已配置环境启动'});await this.start();abortCheck(signal);}
    bindInputs(bundle,snapshot,(snapshot.references || []).map(ref=>({name:ref.path,type:ref.type || mediaType(ref.path || '')})));
    const uploaded=[]; for(const ref of snapshot.references || []) { onProgress({state:'uploading',message:'正在传递参考素材到执行设备'}); uploaded.push(await this.upload(ref,signal)); }
    const api=bindInputs(bundle,snapshot,uploaded); await this.validate(api); const clientId=crypto.randomUUID(); let socket;
    if(typeof WebSocket==='function') { try { socket=new WebSocket(this.url.replace(/^http/,'ws')+`/ws?clientId=${clientId}`); socket.addEventListener('error',()=>{}); socket.addEventListener('message', e=>{ if(typeof e.data!=='string')return; try {const v=JSON.parse(e.data);if(v.type==='progress')onProgress({state:'running',progress:{value:v.data.value,max:v.data.max},nodeId:v.data.node,message:'ComfyUI 正在执行'});}catch{}}); }catch{} }
    let remoteId='client:'+clientId;
    try { abortCheck(signal);onProgress({state:'submitting',remoteId,clientId,message:'已保存提交标识，正在向 ComfyUI 发送请求'});const result=await this.request('/prompt',post({prompt:api,client_id:clientId,extra_data:{extra_pnginfo:{workflow:bundle.gui},createmore:{taskId:snapshot.taskId || null}}}),60000); if(!result.prompt_id) throw new ProviderError('ComfyUI 未接受任务','SUBMISSION_REJECTED',result);remoteId=result.prompt_id; onProgress({state:'submitted',remoteId,message:'ComfyUI 已接收，正在核对执行状态'}); return await this.wait(remoteId,bundle,{onProgress,signal,outputDir,timeoutMs:snapshot.timeoutMs}); }
    catch(e) { if(remoteId) {e.remoteId=remoteId;e.provider='comfyui'; if(e.code==='ABORTED') e.cancellation=await this.cancel({remoteId}).catch(err=>({state:'unknown',message:err.message}));} throw e; }
    finally { socket?.close(); }
  }
  async wait(remoteId,bundle,{onProgress=()=>{},signal,outputDir,timeoutMs=3600000}={}) {
    const started=Date.now(); let misses=0;
    while(Date.now()-started<timeoutMs) {
      abortCheck(signal);
      try { const result=await this.reconcile({workflow:bundle},{remoteId},{outputDir,onProgress}); misses=0; if(['completed','cancelled'].includes(result.state)) return result; if(result.state==='failed') throw new ProviderError(result.message,'EXECUTION_FAILED',result.error); onProgress({state:result.state,remoteId,message:result.message}); }
      catch(e) { if(!['NETWORK_ERROR','HTTP_ERROR'].includes(e.code))throw e; if(++misses>=10)throw new ProviderError('与 ComfyUI 断线；已保留任务标识，请恢复查询，不重复提交','STATUS_UNKNOWN',{remoteId}); }
      await sleep(1000,signal);
    }
    throw new ProviderError('等待超时，远端可能仍在执行；请恢复查询','STATUS_UNKNOWN',{remoteId});
  }
  async reconcile(snapshot,remote,{outputDir,onProgress=()=>{}}={}) {
    let remoteId=remote.remoteId || remote.promptId; if(!remoteId)throw new ProviderError('缺少远端任务标识','REMOTE_ID_REQUIRED');if(remoteId.startsWith('client:')){const resolved=await this.resolveSubmission(remoteId);if(!resolved)return {state:'unknown',remoteId,message:'尚未找到此提交标识；不能自动重交'};remoteId=resolved;onProgress({state:'submitted',remoteId,message:'已按本次提交标识恢复 ComfyUI 任务'});}const history=await this.request('/history/'+encodeURIComponent(remoteId)); const item=history[remoteId];
    if(item) { if(item.status?.messages?.some(m=>m[0]==='execution_interrupted'))return {provider:'comfyui',remoteId,state:'cancelled',message:'ComfyUI 已确认执行中断'};const errors=item.status?.messages?.filter(m=>m[0]==='execution_error'); if(errors?.length || item.status?.status_str==='error')return {provider:'comfyui',remoteId,state:'failed',message:'ComfyUI 执行失败',error:errors || item.status}; if(item.status?.completed===false) return {state:'running',remoteId,message:'ComfyUI 正在执行'};
      if(!outputDir) return {provider:'comfyui',remoteId,state:'completed-remote',message:'远端完成，结果尚未保存'};
      onProgress({state:'saving',remoteId,message:'正在下载并保存生成结果'}); const outputs=[];const texts=[];
      for(const mapping of snapshot.workflow.mapping.outputs) {const values=item.outputs?.[String(mapping.nodeId)]?.[mapping.key]; if(values==null){if(mapping.required!==false)throw new ProviderError(`缺少已映射输出 ${mapping.id}`,'OUTPUT_MISSING',{nodeId:mapping.nodeId,key:mapping.key});continue;} for(const value of Array.isArray(values)?values:[values]) { if(typeof value==='string'){texts.push(value);outputs.push({...await saveText(outputDir,value,mapping.id),nodeId:mapping.nodeId,outputId:mapping.id});continue;} if(!value?.filename)throw new ProviderError('输出不是可持久保存的媒体或文字','UNSUPPORTED_OUTPUT',{mapping}); const query=new URLSearchParams({filename:value.filename,subfolder:value.subfolder || '',type:value.type || 'output'}); const file=await download(this.fetch,this.url+'/view?'+query,outputDir,value.filename); outputs.push({...file,type:mediaType(value.filename,mapping.type),nodeId:mapping.nodeId,outputId:mapping.id}); } }
      if(!outputs.length)throw new ProviderError('后台完成但没有取得已映射结果','OUTPUT_MISSING');return {provider:'comfyui',remoteId,state:'completed',outputs,...(texts.length?{text:texts.join('\n')}:{ }),metadata:{status:item.status}};
    }
    const queue=await this.request('/queue'); if(queue.queue_running?.some(v=>v[1]===remoteId))return {state:'running',remoteId,message:'ComfyUI 正在运行此任务'}; if(queue.queue_pending?.some(v=>v[1]===remoteId))return {state:'queued',remoteId,message:'在 ComfyUI 中排队'}; return {state:'unknown',remoteId,message:'后台队列与历史均未找到此任务；不能自动重交'};
  }
  async resolveSubmission(remoteId){const clientId=remoteId.slice(7);const queue=await this.request('/queue');const queued=[...queue.queue_running || [],...queue.queue_pending || []].find(v=>v[3]?.client_id===clientId);if(queued)return queued[1];const history=await this.request('/history?max_items=1000');return Object.entries(history).find(([,item])=>item.prompt?.[3]?.client_id===clientId)?.[0];}
  async cancel({remoteId}) { if(remoteId?.startsWith('client:')){remoteId=await this.resolveSubmission(remoteId);if(!remoteId)return {state:'unknown',message:'提交标识尚未解析，不能声称取消成功'};}const queue=await this.request('/queue'); if(queue.queue_pending?.some(v=>v[1]===remoteId)){await this.request('/queue',post({delete:[remoteId]})); const next=await this.request('/queue');if(next.queue_pending?.some(v=>v[1]===remoteId))return {state:'cancel-requested',message:'任务仍在等待队列，取消尚未确认'};if(next.queue_running?.some(v=>v[1]===remoteId))return {state:'running',message:'任务在取消前已开始运行，未确认取消，请继续核对'};const history=await this.request('/history/'+encodeURIComponent(remoteId));const item=history[remoteId];if(item){if(item.status?.messages?.some(m=>m[0]==='execution_interrupted'))return {state:'cancelled',message:'后台历史已确认中断'};if(item.status?.status_str==='error')return {state:'failed',message:'任务已失败，而非从等待队列取消'};return {state:item.status?.completed?'completed-remote':'unknown',message:'任务已离开等待队列且存在执行历史，不能声称取消成功'};}return {state:'cancelled',message:'等待队列已删除本任务，运行队列和历史均未发现已执行任务'};} if(queue.queue_running?.some(v=>v[1]===remoteId)){ // ComfyUI interrupt is device-global; only send after exact current-task ownership check.
      if(!this.config.targetedInterrupt) return {state:'unsupported',message:'尚未确认此 ComfyUI 支持按任务中断；未发送设备全局中断'};
      await this.request('/interrupt',post({prompt_id:remoteId}));return {state:'cancel-requested',message:'后台已接收中断请求，需核对最终状态'}; }return {state:'not-running',message:'任务不在队列；请核对历史，不能声称取消了已完成任务'}; }
}
module.exports={ComfyProvider};
