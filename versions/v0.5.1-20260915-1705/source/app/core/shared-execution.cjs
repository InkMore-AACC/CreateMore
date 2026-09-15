'use strict';

const fs=require('node:fs/promises');
const nativeFS=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const CHUNK=256*1024,MAX_SIZE=8*1024*1024*1024;
const clone=value=>JSON.parse(JSON.stringify(value));
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,180}$/.test(value);
const safePort=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(value);
const terminal=new Set(['succeeded','failed','cancelled']);
const providers=new Set(['comfyui','codex','image2','ollama','openai-compatible','runninghub']);
const accountProviders=new Set(['codex','image2','openai-compatible','runninghub']);
function error(message,code='INVALID'){return Object.assign(new Error(message),{code});}
async function fileHash(file){const h=crypto.createHash('sha256');for await(const chunk of nativeFS.createReadStream(file))h.update(chunk);return h.digest('hex');}
async function save(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600});try{await fs.rename(temporary,file);}catch(e){await fs.unlink(temporary).catch(()=>{});throw e;}}
const within=(root,file)=>{const relative=path.relative(path.resolve(root),path.resolve(file));return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
function publicError(e){return String(e?.message||e||'设备操作失败').replace(/\bsk-[\w-]{16,}\b/g,'[已过滤密钥]').replace(/(?:api[_-]?key|authorization|password|token)\s*[:=]\s*[^\s,;]+/ig,'[已过滤凭据]').replace(/[A-Za-z]:[\\/][^\r\n,;]+/g,'[设备本地路径]');}
function parameterSchema(input={}){
  const schema={};for(const [name,spec]of Object.entries(input)){if(!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name)||/(key|secret|password|token|url|path|command|code|workflow)/i.test(name))continue;if(!['number','integer','string','boolean'].includes(spec?.type))continue;const item={type:spec.type};for(const key of ['minimum','maximum','maxLength'])if(Number.isFinite(spec[key]))item[key]=spec[key];if(Array.isArray(spec.enum)&&spec.enum.length<=100&&spec.enum.every(v=>['string','number','boolean'].includes(typeof v)))item.enum=clone(spec.enum);if(['number','boolean','string'].includes(typeof spec.default))item.default=spec.default;schema[name]=item;}return schema;
}
function parameters(input,schema){
  if(!input||typeof input!=='object'||Array.isArray(input))throw error('生成参数必须为对象');const out={};
  for(const [name,value]of Object.entries(input)){const spec=schema[name];if(!spec)throw error('设备未公开此参数：'+name,'CAPABILITY');if(spec.type==='integer'?!Number.isSafeInteger(value):spec.type==='number'?!Number.isFinite(value):typeof value!==spec.type)throw error('参数类型不兼容：'+name,'CAPABILITY');if(spec.minimum!==undefined&&value<spec.minimum||spec.maximum!==undefined&&value>spec.maximum||spec.enum&&!spec.enum.includes(value)||typeof value==='string'&&value.length>(spec.maxLength||10000))throw error('参数超出设备支持范围：'+name,'CAPABILITY');out[name]=value;}return out;
}
function resultFlags(result,state){return {partial:!!result.partial||state==='failed'||state==='cancelled',cancelled:!!result.cancelled||state==='cancelled',generationErrors:(Array.isArray(result.generationErrors)?result.generationErrors:[]).slice(0,100).map(item=>({...(Number.isSafeInteger(item?.index)?{index:item.index}:{}),...(Number.isSafeInteger(item?.seed)?{seed:item.seed}:{}),code:['CANCELLED','EXECUTION_FAILED','OUTPUT_MISSING','REMOTE_PARTIAL'].includes(item?.code)?item.code:'REMOTE_PARTIAL',message:'设备部分生成未完成；详细错误保留在执行设备'}))};}
function referencePorts(fields=[]){return fields.map((field,index)=>{if(!safePort(field.id))throw error('共享工作流输入端口须使用 1–80 位固定英文数字标识','CAPABILITY');return {id:field.id,index:Number.isSafeInteger(field.index)&&field.index>=0?field.index:index,multiple:!!field.multiple,required:!!field.required,type:field.mediaType||field.type||null};});}
function validatePorts(refs,ports=[],checkType=false){
  for(const ref of refs)if(ref.inputId&&!ports.some(p=>p.id===ref.inputId))throw error('工作流未公开此输入端口：'+ref.inputId,'CAPABILITY');
  if(!ports.length)return;
  const used=new Set();for(const port of ports){let group=refs.map((ref,index)=>({ref,index})).filter(({ref})=>ref.inputId===port.id);if(!group.length)group=port.multiple?refs.map((ref,index)=>({ref,index})).filter(({ref})=>!ref.inputId):refs[port.index]&&!refs[port.index].inputId?[{ref:refs[port.index],index:port.index}]:[];
    if(port.required&&!group.length)throw error('缺少必需输入端口：'+port.id,'CAPABILITY');if(!port.multiple&&group.length>1)throw error('该端口只接受一个素材：'+port.id,'CAPABILITY');if(checkType&&['image','video','audio','text'].includes(port.type)&&group.some(({ref})=>ref.type!==port.type))throw error('输入端口素材类型不匹配：'+port.id,'CAPABILITY');for(const {index}of group)used.add(index);
  }if(used.size!==refs.length)throw error('有素材未匹配有效输入端口，未静默忽略','CAPABILITY');
}

class SharedExecutionGateway{
  constructor({dataDir,collaboration,describeProvider,resolveWorkflow,submitTask,getTask,cancelTask,reconcileTask,pauseResource,onEvent=()=>{}}={}){
    if(!dataDir||!collaboration||!describeProvider||!resolveWorkflow||!submitTask||!getTask||!cancelTask)throw new Error('SharedExecutionGateway requires LAN and device queue callbacks');
    Object.assign(this,{dataDir:path.resolve(dataDir),collaboration,describeProvider,resolveWorkflow,submitTask,getTask,cancelTask,reconcileTask,pauseResource,onEvent});this.offers=[];this.jobs=[];this.busy=Promise.resolve();this.persistLock=Promise.resolve();this.removers=[];this.ready=this._init();
  }
  async _init(){await this.collaboration.ready;await fs.mkdir(this.dataDir,{recursive:true});this.file=path.join(this.dataDir,'shared-execution.json');try{const state=JSON.parse(await fs.readFile(this.file,'utf8'));this.offers=(state.offers||[]).map(item=>({...item,enabled:false}));this.jobs=state.jobs||[];}catch(e){if(e.code!=='ENOENT')throw error('共享执行记录损坏，拒绝重新提交旧任务','STATE');}
    // Offers require a new local decision after restart; credentials never live here.
    const handlers={offers:()=>this._publicOffers(),submit:(p,c)=>this._serial(()=>this._submit(p,c)),status:(p,c)=>this._status(p.jobId,c.memberId),reconcile:(p,c)=>this._reconcile(p.jobId,c.memberId),cancel:(p,c)=>this._cancel(p.jobId,c.memberId),result:(p,c)=>this._resultChunk(p,c.memberId)};
    for(const [suffix,handler]of Object.entries(handlers))this.removers.push(this.collaboration.registerRPC('resource.'+suffix,handler,{allowAfterStop:['status','reconcile','cancel','result'].includes(suffix)}));await this._persist();return this;
  }
  _serial(fn){const result=this.busy.then(fn,fn);this.busy=result.catch(()=>{});return result;}
  async _persist(){const write=()=>save(this.file,{version:1,offers:this.offers,jobs:this.jobs});const result=this.persistLock.then(write,write);this.persistLock=result.catch(()=>{});return result;}
  _emit(type,detail){try{this.onEvent({type,...detail});}catch{}}
  async _description(provider){if(!providers.has(provider))throw error('设备未支持此执行来源','UNSUPPORTED');const value=await this.describeProvider(provider);if(!value?.available)throw error('设备来源当前不可用：'+(value?.reason||provider),'PROVIDER_UNAVAILABLE');return value;}
  async offer({provider='comfyui',workflowId,kind='image',enabled=true,allowedMembers,maxReferences=8,allowAccountUsage=false}={}){
    await this.ready;if(!enabled){const existing=this.offers.find(o=>o.provider===provider&&o.workflowId===workflowId&&o.kind===kind);if(!existing)throw error('共享资源不存在','NOT_FOUND');return this.stopOffer(existing.id);}
    if(!safeId(workflowId))throw error('工作流必须使用本机资源库稳定标识，不能公开文件路径','CAPABILITY');
    if(accountProviders.has(provider)&&allowAccountUsage!==true)throw error('资源主人须明确允许成员消耗本机账号额度或费用','ACCOUNT_CONSENT_REQUIRED');
    if(['codex','ollama','openai-compatible'].includes(provider)&&kind!=='text'||provider==='image2'&&kind!=='image')throw error('该来源不支持所选输出类型','CAPABILITY');
    const description=await this._description(provider),workflow=(description.workflows||[]).find(w=>w.id===workflowId);
    if(!workflow||!description.kinds?.includes(kind)||(workflow.kinds&&!workflow.kinds.includes(kind)))throw error('未找到本机已绑定且兼容的工作流','CAPABILITY');
    if(allowedMembers!==undefined&&(!Array.isArray(allowedMembers)||!allowedMembers.every(safeId)))throw error('成员白名单无效');if(!Number.isInteger(maxReferences)||maxReferences<0||maxReferences>64)throw error('素材数量限制无效');
    const capability={...description,...workflow};const previous=this.offers.find(o=>o.provider===provider&&o.workflowId===workflowId&&o.kind===kind),record={id:previous?.id||crypto.randomUUID(),provider,workflowId,kind,enabled:true,accountUsageAllowed:accountProviders.has(provider),allowedMembers:allowedMembers?clone(allowedMembers):null,maxReferences:Math.min(maxReferences,capability.maxReferences??64),minReferences:capability.minReferences||0,inputTypes:(capability.inputTypes||['image','text']).filter(t=>['image','video','audio','text'].includes(t)),referenceInputs:referencePorts(capability.referenceInputs),parameters:parameterSchema(capability.parameters||{}),name:String(workflow.name||workflowId).slice(0,100),updatedAt:Date.now()};
    this.offers=this.offers.filter(o=>o.id!==record.id).concat(record);await this._persist();this._emit('resource-offered',{id:record.id});return this._publicOffer(record);
  }
  _publicOffer(record){const {allowedMembers,...visible}=record;return {...clone(visible),deviceId:this.collaboration.identity.id,memberRestricted:!!allowedMembers};}
  async _publicOffers(){await this.ready;return this.offers.filter(o=>o.enabled).map(o=>this._publicOffer(o));}
  async listOffers(){await this.ready;const members=this.collaboration.state?.members.filter(m=>m.active)||[{id:this.collaboration.identity.id,name:this.collaboration.identity.name}];const devices=await Promise.all(members.map(async member=>{try{const offers=member.id===this.collaboration.identity.id?await this._publicOffers():await this.collaboration.callMember(member.id,'resource.offers');return {deviceId:member.id,name:member.name,reachable:true,offers};}catch(e){return {deviceId:member.id,name:member.name,reachable:false,offers:[],error:{code:e.code||'NETWORK',message:publicError(e)}};}}));return {devices};}
  async stopOffer(offerId){await this.ready;return this._serial(async()=>{const offer=this.offers.find(o=>o.id===offerId);if(!offer)throw error('共享资源不存在','NOT_FOUND');offer.enabled=false;await this._persist();this._emit('resource-stopped',{id:offerId});return this._publicOffer(offer);});}
  _validateInput(input,offer){
    const allowed=['offerId','kind','prompt','parameters','references','requestId','requestCanvasId'];for(const key of Object.keys(input))if(!allowed.includes(key))throw error('共享生成不能指定未公开字段：'+key,'CAPABILITY');
    if(input.kind!==offer.kind)throw error('该设备资源不能生成所选类型','CAPABILITY');if(typeof input.prompt!=='string'||input.prompt.length>100000)throw error('提示词格式或长度无效');
    const params=parameters(input.parameters||{},offer.parameters);if(!Array.isArray(input.references)||input.references.length>offer.maxReferences||input.references.length<(offer.minReferences||0)||input.references.some(r=>!safeId(r?.assetId)||r.inputId!==undefined&&!safePort(r.inputId)||Object.keys(r).some(k=>!['assetId','inputId','sha256','size'].includes(k))))throw error('引用素材数量或标识不兼容','CAPABILITY');
    if(input.references.some(r=>typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256)||!Number.isSafeInteger(r.size)||r.size<0||r.size>MAX_SIZE))throw error('共享引用缺少固定版本，请重新确认素材后提交；不会改用当前版本','REFERENCE_VERSION_REQUIRED');validatePorts(input.references,offer.referenceInputs);
    if(!input.prompt.trim()&&!input.references.length)throw error('请填写提示词或选择共享素材');if(!safeId(input.requestId)||!safeId(input.requestCanvasId))throw error('任务重试编号或画布标识无效');return params;
  }
  async submitRemote({deviceId,offerId,kind,prompt,parameters:params={},references=[],requestId=crypto.randomUUID(),requestCanvasId=this.collaboration.state?.snapshot.canvasId}={}){
    await this.ready;if(!this.collaboration.state||this.collaboration.state.stopped||!['hosting','joined'].includes(this.collaboration.mode))throw error('当前没有可用共享会话','OFFLINE');if(!safeId(deviceId))throw error('请选择执行设备');const input={offerId,kind,prompt,parameters:params,references,requestId,requestCanvasId};const offers=deviceId===this.collaboration.identity.id?await this._publicOffers():await this.collaboration.callMember(deviceId,'resource.offers');const offer=offers.find(o=>o.id===offerId);if(!offer)throw error('设备没有主动开放该资源','OFFER_STOPPED');this._validateInput(input,offer);
    const result=await this.collaboration.callMember(deviceId,'resource.submit',input);return {deviceId,...result};
  }
  async _submit(input,{memberId,sessionId,canvasId}){
    await this.ready;if(this.collaboration.state.stopped||!['hosting','joined'].includes(this.collaboration.mode))throw error('当前共享会话不能接受新生成','OFFLINE');
    const offer=this.offers.find(o=>o.id===input.offerId&&o.enabled);if(!offer)throw error('设备已停止开放此资源','OFFER_STOPPED');if(offer.allowedMembers&&!offer.allowedMembers.includes(memberId)&&memberId!==this.collaboration.identity.id)throw error('资源主人未允许此成员使用设备','FORBIDDEN');
    const cleanParameters=this._validateInput(input,offer);if(input.requestCanvasId!==canvasId)throw error('请求画布不是当前共享画布','FORBIDDEN');
    const fingerprint=digest(JSON.stringify(input)),existing=this.jobs.find(j=>j.requestId===input.requestId&&j.requesterId===memberId&&j.sessionId===sessionId);
    if(existing){if(existing.fingerprint!==fingerprint)throw error('同一重试编号对应不同生成请求','IDEMPOTENCY_CONFLICT');if(!existing.taskId)throw error('此前提交结果尚未确认，不会重复生成；请在设备任务记录中核对','UNCERTAIN');const task=await this.getTask(existing.taskId);return {jobId:existing.id,taskId:existing.taskId,state:task.state,replayed:true};}
    const live=await this._description(offer.provider),liveWorkflow=(live.workflows||[]).find(w=>w.id===offer.workflowId);if(!liveWorkflow||!live.kinds?.includes(offer.kind)||liveWorkflow.kinds&&!liveWorkflow.kinds.includes(offer.kind))throw error('设备工作流能力已经改变，请重新选择资源','CAPABILITY');const liveCapability={...live,...liveWorkflow};parameters(cleanParameters,parameterSchema(liveCapability.parameters||{}));if(input.references.length>(liveCapability.maxReferences??64)||input.references.length<(liveCapability.minReferences||0))throw error('设备工作流的素材数量要求已改变','CAPABILITY');await this.collaboration._syncAssets();const inputs=[];
    const jobId=crypto.randomUUID(),jobDir=path.join(this.dataDir,'jobs',jobId),outputDir=path.join(jobDir,'outputs');await fs.mkdir(outputDir,{recursive:true});
    for(const [index,ref]of input.references.entries()){
      const asset=await this.collaboration.sharedAssetFile(ref.assetId);if(!offer.inputTypes.includes(asset.meta.type)||liveCapability.inputTypes&&!liveCapability.inputTypes.includes(asset.meta.type))throw error('工作流不支持此输入类型：'+asset.meta.type,'CAPABILITY');if(asset.meta.sha256!==ref.sha256||asset.meta.size!==ref.size)throw error('共享引用已改变，设备未提交生成','ASSET_VERSION');
      const inputDir=path.join(jobDir,'inputs');await fs.mkdir(inputDir,{recursive:true});const frozen=path.join(inputDir,index+path.extname(asset.meta.name||'').replace(/[^.A-Za-z0-9]/g,'').slice(0,16));await fs.copyFile(asset.path,frozen,nativeFS.constants.COPYFILE_EXCL);
      // Check the independent copy, not a source path that can change between checking and copying.
      if((await fs.stat(frozen)).size!==ref.size||await fileHash(frozen)!==ref.sha256)throw error('引用在复制期间改变，设备未提交生成','ASSET_VERSION');inputs.push({id:ref.assetId,type:asset.meta.type,path:frozen,title:asset.meta.name,sha256:ref.sha256,size:ref.size,...(ref.inputId?{inputId:ref.inputId}:{})});
    }
    const resolved=await this.resolveWorkflow(offer.workflowId,offer.kind,offer.provider);if(!resolved)throw error('本机执行绑定已失效','CAPABILITY');const workflow=offer.provider==='comfyui'?resolved:resolved.workflow;
    validatePorts(inputs,workflow?referencePorts(workflow.mapping?.inputs?.filter(f=>f.source==='reference')):offer.referenceInputs,true);
    for(const ref of input.references){const meta=this.collaboration.state.manifest.find(m=>m.id===ref.assetId);if(meta?.sha256!==ref.sha256||meta?.size!==ref.size)throw error('共享引用版本已改变，设备未提交生成','ASSET_VERSION');}
    const record={id:jobId,requestId:input.requestId,requesterId:memberId,sessionId,requestCanvasId:canvasId,offerId:offer.id,provider:offer.provider,kind:offer.kind,workflowId:offer.workflowId,fingerprint,outputDir,createdAt:Date.now(),state:'submitting',taskId:null,outputs:[]};this.jobs.push(record);await this._persist();
    const snapshot={provider:offer.provider,kind:offer.kind,canvasId,projectDir:path.join(this.dataDir,'jobs',jobId),nodeId:null,title:'局域网 · '+offer.name,prompt:input.prompt,parameters:cleanParameters,references:inputs,workflow,workflowId:offer.provider==='comfyui'?offer.workflowId:resolved.workflowId,resourceId:offer.provider==='comfyui'?(workflow?.resourceId||'comfyui'):offer.provider,outputDir,remoteExecution:true,sharedExecutionId:jobId,requesterId:memberId};
    // Only device-resolved fixed settings; never accept thread, tools, messages or credentials from members.
    if(offer.provider!=='comfyui'){if(resolved.model)snapshot.model=resolved.model;if(resolved.effort)snapshot.effort=resolved.effort;if(resolved.connection)snapshot.connection=clone(resolved.connection);snapshot.tools=[];snapshot.skills=[];}
    try{const task=await this.submitTask(snapshot,memberId);if(!safeId(task?.id))throw error('设备任务队列未返回可追踪编号','UNCERTAIN');record.taskId=task.id;record.state=task.state;await this._persist();this._emit('remote-task-submitted',{jobId,taskId:task.id,requesterId:memberId});return {jobId,taskId:task.id,state:task.state};}
    catch(e){record.state='unknown';record.error=publicError(e);await this._persist().catch(()=>{});throw error('设备提交未完全确认，不会自动重提：'+publicError(e),'UNCERTAIN');}
  }
  _job(jobId,actor){const job=this.jobs.find(j=>j.id===jobId);if(!job)throw error('设备生成任务不存在','NOT_FOUND');if(job.requesterId!==actor)throw error('只能读取或控制自己发起的设备任务','FORBIDDEN');return job;}
  async _status(jobId,actor){
    await this.ready;const job=this._job(jobId,actor);if(!job.taskId)return {jobId:job.id,taskId:null,state:'unknown',message:'提交尚未确认，请在设备端核对，不会自动重提',outputs:[]};
    const task=await this.getTask(job.taskId);const value={jobId:job.id,taskId:job.taskId,state:task.state,message:publicError(task.message||''),outputs:[]};if(Number.isFinite(task.progress))value.progress=task.progress;if(task.error)value.error=publicError(task.error);
    if(task.state==='succeeded'||terminal.has(task.state)&&((task.result?.outputs||[]).length||task.result?.text)){
      const result=task.result||{};if(typeof result.text==='string')value.text=result.text;
      const root=await fs.realpath(job.outputDir),outputs=[];for(const [index,out]of (result.outputs||[]).entries()){
        if(typeof out.path!=='string')throw error('设备产物缺少实际文件','RESULT_MISSING');const file=await fs.realpath(out.path);if(!within(root,file))throw error('设备结果不在本次任务输出目录，拒绝读取其他文件','RESULT_SCOPE');const stat=await fs.stat(file);if(!stat.isFile()||stat.size>MAX_SIZE)throw error('结果文件类型或大小不兼容','RESULT_SCOPE');
        const cached=job.outputs.find(r=>r.path===file&&r.size===stat.size&&r.mtimeMs===stat.mtimeMs),sha256=cached?.sha256||await fileHash(file);outputs.push({id:job.id+':'+index,name:path.basename(file),type:['image','video','audio','text'].includes(out.type)?out.type:job.kind,size:stat.size,sha256,path:file,mtimeMs:stat.mtimeMs,...(safePort(out.outputId)?{outputId:out.outputId}:{}),...(Number.isSafeInteger(out.seed)?{seed:out.seed}:{})});
      }
      if(!outputs.length&&!value.text)throw error('设备任务虽结束，但没有可取回的真实结果','RESULT_MISSING');job.outputs=outputs;job.state=task.state;await this._persist();value.outputs=outputs.map(({path,mtimeMs,...meta})=>meta);Object.assign(value,{resultAvailable:true,...resultFlags(result,task.state)});
    }
    return value;
  }
  async remoteStatus({deviceId,jobId}){await this.ready;return this.collaboration.callMember(deviceId,'resource.status',{jobId});}
  async _reconcile(jobId,actor){const job=this._job(jobId,actor);if(job.taskId&&this.reconcileTask){const task=await this.getTask(job.taskId);if(task.state==='unknown'||task.resultPending)await this.reconcileTask(job.taskId,actor);}return this._status(jobId,actor);}
  async reconcileRemote({deviceId,jobId}){await this.ready;return this.collaboration.callMember(deviceId,'resource.reconcile',{jobId});}
  async _cancel(jobId,actor){const job=this._job(jobId,actor);if(!job.taskId)throw error('任务提交尚未确认，不能声称已取消','UNCERTAIN');await this.cancelTask(job.taskId,actor);return this._status(jobId,actor);}
  async cancelRemote({deviceId,jobId}){await this.ready;return this.collaboration.callMember(deviceId,'resource.cancel',{jobId});}
  async cancelDeviceTask(jobId){await this.ready;const job=this.jobs.find(j=>j.id===jobId);if(!job)throw error('设备任务不存在','NOT_FOUND');return this._cancel(jobId,job.requesterId);}
  async pauseDevice(provider='comfyui',paused=true){await this.ready;if(!providers.has(provider)||!this.pauseResource)throw error('设备没有接入调度暂停能力','UNSUPPORTED');await this.pauseResource(provider,!!paused);return {provider,paused:!!paused,scope:'future-dispatch-only'};}
  async _resultChunk({jobId,outputId,offset=0},actor){
    const job=this._job(jobId,actor);if(!job.outputs.length)await this._status(jobId,actor);const out=job.outputs.find(o=>o.id===outputId);if(!out)throw error('任务输出不存在','RESULT_MISSING');if(!Number.isSafeInteger(offset)||offset<0||offset>out.size)throw error('结果读取位置无效');const real=await fs.realpath(out.path),root=await fs.realpath(job.outputDir);if(!within(root,real))throw error('结果路径已改变，拒绝越界读取','RESULT_SCOPE');const handle=await fs.open(real,'r'),buffer=Buffer.alloc(Math.min(CHUNK,out.size-offset));try{const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);return {outputId,offset,sha256:out.sha256,size:out.size,data:buffer.subarray(0,bytesRead).toString('base64')};}finally{await handle.close();}
  }
  async downloadResults({deviceId,jobId,outputDir}){
    await this.ready;if(!outputDir||!path.isAbsolute(outputDir))throw error('结果目录必须是本机明确的绝对路径');const status=await this.remoteStatus({deviceId,jobId});if(!terminal.has(status.state)||!status.resultAvailable||!status.outputs?.length&&!status.text)throw error('设备任务尚未取得可保存结果','NOT_READY');await fs.mkdir(outputDir,{recursive:true});const root=await fs.realpath(outputDir),outputs=[];
    for(const meta of status.outputs){if(!/^[a-f0-9]{64}$/.test(meta.sha256)||!safeId(meta.id)||!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>MAX_SIZE)throw error('设备结果清单无效','RESULT_SCOPE');const ext=path.extname(meta.name||'').replace(/[^.A-Za-z0-9]/g,'').slice(0,16),filename=path.join(root,'shared-'+meta.sha256.slice(0,24)+ext),part=filename+'.part';if(!within(root,filename))throw error('结果路径越界');
      let present=false;try{if((await fs.lstat(filename)).isSymbolicLink())throw error('结果目标是链接，拒绝覆盖','RESULT_SCOPE');present=await fileHash(filename)===meta.sha256;}catch(e){if(e.code!=='ENOENT')throw e;}if(!present){try{const stat=await fs.lstat(part);if(stat.isSymbolicLink()||!stat.isFile())throw error('临时结果路径不是普通文件','RESULT_SCOPE');}catch(e){if(e.code!=='ENOENT')throw e;}const handle=await fs.open(part,'a');await handle.close();let offset=(await fs.stat(part)).size;if(offset>meta.size){await fs.truncate(part,0);offset=0;}
        while(offset<meta.size){const chunk=await this.collaboration.callMember(deviceId,'resource.result',{jobId,outputId:meta.id,offset});const data=Buffer.from(chunk.data||'','base64');if(chunk.offset!==offset||chunk.sha256!==meta.sha256||chunk.size!==meta.size||!data.length||data.length>CHUNK||offset+data.length>meta.size)throw error('设备输出分块不匹配','RESULT_HASH');await fs.appendFile(part,data);offset+=data.length;this._emit('remote-result-progress',{deviceId,jobId,outputId:meta.id,received:offset,total:meta.size});}
        if(await fileHash(part)!==meta.sha256){await fs.truncate(part,0);throw error('设备输出校验失败，尚未当作成功素材','RESULT_HASH');}
        try{await fs.copyFile(part,filename,nativeFS.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST'||await fileHash(filename)!==meta.sha256)throw error('结果文件已存在且内容不同，未覆盖','RESULT_SCOPE');}await fs.unlink(part);
      }outputs.push({path:filename,type:meta.type,size:meta.size,sha256:meta.sha256,...(safePort(meta.outputId)?{outputId:meta.outputId}:{}),...(Number.isSafeInteger(meta.seed)?{seed:meta.seed}:{})});
    }
    return {state:'completed',text:status.text,outputs,...resultFlags(status,status.state),remote:{deviceId,jobId,taskId:status.taskId}};
  }
  async close(){await this.ready;for(const remove of this.removers)remove();await this._persist();}
}

module.exports={SharedExecutionGateway};
