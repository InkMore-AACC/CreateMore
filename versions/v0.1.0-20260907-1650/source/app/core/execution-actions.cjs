'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {SharedExecutionGateway}=require('./shared-execution.cjs');

function fail(message,code='SHARED_EXECUTION'){return Object.assign(new Error(message),{code});}
async function fingerprint(file){const hash=crypto.createHash('sha256');let size=0;for await(const chunk of require('node:fs').createReadStream(file)){size+=chunk.length;hash.update(chunk);}return {sha256:hash.digest('hex'),size};}
function schema(mapping){const output={};for(const field of mapping.inputs||[]){if(field.source!=='parameter')continue;let type=field.type||typeof field.default;if(!['string','number','integer','boolean'].includes(type))continue;const item={type};if(field.min!==undefined)item.minimum=field.min;if(field.max!==undefined)item.maximum=field.max;if(field.default!==undefined)item.default=field.default;if(field.options)item.enum=field.options;if(field.maxLength)item.maxLength=field.maxLength;output[field.id]=item;}return output;}
async function describeComfy(service){
  const direct=service.hub.providers?.comfyui,status=direct?.status?await direct.status():(await service.hub.status()).comfyui;
  let catalog=[];try{catalog=JSON.parse(await fs.readFile(path.join(service.appDir,'resources','workflows','catalog.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;const root=service.hub.defaultWorkflows?.root;if(root)try{catalog=(await fs.readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^[A-Za-z0-9_-]{1,100}$/.test(e.name)).map(e=>({id:e.name,label:e.name}));}catch(e){if(e.code!=='ENOENT')throw e;}}
  const workflows=[];for(const item of catalog){if(item.validated===false)continue;try{const bundle=await service.workflowRead('default:'+item.id),mapping=bundle.mapping,refs=mapping.inputs.filter(i=>i.source==='reference'),kinds=[...new Set(mapping.outputs.map(o=>o.type).filter(t=>['image','video','audio','text'].includes(t)))];if(!kinds.length)continue;workflows.push({id:item.id,name:item.label||item.name||item.id,kinds,parameters:schema(mapping),inputTypes:[...new Set(refs.map(r=>r.mediaType||'image'))],referenceInputs:refs.map((r,index)=>({id:r.id,index:r.index??index,multiple:!!r.multiple,required:!!r.required,type:r.mediaType||r.type})),maxReferences:refs.some(r=>r.multiple)?64:refs.length,minReferences:refs.filter(r=>r.required).length});}catch(e){service.log?.('warn','共享工作流暂不可用',e,{workflowId:item.id});}}
  return {provider:'comfyui',available:!!(status?.available??status?.ready),kinds:[...new Set(workflows.flatMap(w=>w.kinds))],workflows:workflows.map(w=>({...w,provider:'comfyui'}))};
}
const bindingKeys=new WeakMap();
function bindingId(service,provider,value){if(!bindingKeys.has(service))bindingKeys.set(service,crypto.randomBytes(32));return 'configured:'+provider+':'+crypto.createHmac('sha256',bindingKeys.get(service)).update(JSON.stringify(value)).digest('hex').slice(0,32);}
async function configured(service,provider){
  await service.hub.ready;const key=provider==='image2'?'codex':provider,config=structuredClone(service.hub.config?.[key]||{}),direct=service.hub.providers?.[key],status=direct?.status?await direct.status():(await service.hub.status())[provider];
  const unavailable=reason=>({provider,available:false,reason,workflows:[],kinds:[]});
  if(!status?.ready)return unavailable(status?.reason||'来源未连接或未完成配置');
  if(['codex','image2'].includes(provider)&&!status.capabilities?.includes(provider==='image2'?'image':'text'))return unavailable('本机账号未确认此输出能力');
  const account=['codex','image2'].includes(provider)&&direct?.request?(await direct.request('account/read',{refreshToken:false})).account:undefined;
  if(['codex','image2'].includes(provider)&&direct?.request&&!account)return unavailable('本机 Codex 账号尚未登录');
  const model=config.model||(provider==='codex'||provider==='image2'?(status.models||[]).find(m=>m.isDefault)?.model||(status.models||[]).find(m=>m.isDefault)?.id:undefined);
  if(provider!=='runninghub'&&!model)return unavailable('资源主人尚未选择模型');
  const candidates=[];
  if(provider==='runninghub'){
    if(!config.workflowId)return unavailable('资源主人尚未配置 RunningHub 任务工作流编号');
    for(const item of await service.resources.list('workflows',{includeDisabled:false})){try{const workflow=await service.workflowRead(item.id);require('../providers/workflows.cjs').validateBundle(workflow);const refs=workflow.mapping.inputs.filter(i=>i.source==='reference'),kinds=[...new Set(workflow.mapping.outputs.map(i=>i.type).filter(k=>['text','image','audio','video'].includes(k)))];if(!kinds.length)continue;candidates.push({resourceId:item.id,name:'RunningHub · '+item.name,workflow,kinds,inputTypes:[...new Set(refs.map(r=>r.mediaType||'image'))],referenceInputs:refs.map((r,i)=>({id:r.id,index:r.index??i,multiple:!!r.multiple,required:!!r.required,type:r.mediaType||r.type})),minReferences:refs.filter(r=>r.required).length,maxReferences:refs.some(r=>r.multiple)?64:refs.length,parameters:schema(workflow.mapping)});}catch{}}
    if(!candidates.length)return unavailable('请先在资源库保存与主人 RunningHub 配置相符的 API 工作流映射');
  }else{
    const kind=provider==='image2'?'image':'text',vision=provider==='image2'||(provider==='codex'?status.capabilities?.includes('image-input'):!!config.vision);
    candidates.push({name:provider+' · '+model,kinds:[kind],inputTypes:vision?['image']:[],referenceInputs:[],minReferences:0,maxReferences:vision?8:0,parameters:provider==='image2'?{ratio:{type:'string',enum:['1:1','16:9','9:16','4:3','3:4'],default:'1:1'}}:['ollama','openai-compatible'].includes(provider)?{temperature:{type:'number',minimum:0,maximum:2,default:1}}:{}});
  }
  return {provider,available:true,kinds:[...new Set(candidates.flatMap(w=>w.kinds))],workflows:candidates.map(w=>({id:bindingId(service,provider,{config,model,account,resourceId:w.resourceId,workflow:w.workflow}),provider,name:w.name,kinds:w.kinds,parameters:w.parameters,inputTypes:w.inputTypes,referenceInputs:w.referenceInputs,minReferences:w.minReferences,maxReferences:w.maxReferences})),private:{config,model,account,candidates}};
}
async function describe(service,provider){
  if(provider==='comfyui')return describeComfy(service);
  if(provider){const {private:_,...publicValue}=await configured(service,provider);return publicValue;}
  const results=await Promise.all(['comfyui','codex','image2','ollama','openai-compatible','runninghub'].map(async id=>{try{return await describe(service,id);}catch(e){return {provider:id,available:false,reason:e.message,kinds:[],workflows:[]};}}));
  return {available:results.some(r=>r.available),kinds:[...new Set(results.flatMap(r=>r.kinds))],workflows:results.filter(r=>r.available).flatMap(r=>r.workflows),providers:results.map(r=>({id:r.provider,available:r.available,reason:r.reason}))};
}
async function resolve(service,id,kind,provider){
  if(provider==='comfyui')return service.workflowRead('default:'+id);
  const selected=await configured(service,provider),index=selected.workflows.findIndex(w=>w.id===id&&w.kinds.includes(kind));if(!selected.available||index<0)throw fail('设备账号、模型或映射已改变，请由主人重新开放资源','CAPABILITY');
  const {config,model,account,candidates}=selected.private,workflow=candidates[index].workflow;
  const fixed=await service.hub.prepare({provider,kind,model,effort:config.effort,connection:config});
  if(['codex','image2'].includes(provider)&&account)fixed.connection.expectedAccountFingerprint=require('../providers/account-identity.cjs').accountFingerprint(account);
  return {model:fixed.model,effort:fixed.effort,connection:fixed.connection,workflow,workflowId:provider==='runninghub'?config.workflowId:undefined};
}
async function install(service){
  if(service.gateway)return service.gateway;
  if(service.gatewayInstalling)return service.gatewayInstalling;
  service.gatewayInstalling=(async()=>{
  const gateway=new SharedExecutionGateway({dataDir:path.join(service.dataDir,'shared-execution'),collaboration:service.collab,describeProvider:provider=>describe(service,provider),resolveWorkflow:(id,kind,provider)=>resolve(service,id,kind,provider),submitTask:(snapshot,requesterId)=>service.queue.submit({...snapshot,remoteExecution:true,canvasId:'gateway:'+requesterId,projectDir:path.join(service.dataDir,'shared-execution')},requesterId),getTask:id=>service.queue.get(id),cancelTask:(id,requesterId)=>service.queue.cancel(id,requesterId),reconcileTask:async(id,requesterId)=>{const task=service.queue.get(id);if(service.queue.controllers.has(id))return;if(task.resultPending||!['ollama','openai-compatible'].includes(task.provider))await service.queue.reconcile(id,requesterId);},pauseResource:(resourceId,paused)=>service.queue.pauseResource(resourceId,paused),onEvent:event=>service.emit?.('event',{type:'shared-execution',data:event})});
  await gateway.ready;service.gateway=gateway;return gateway;
  })();try{return await service.gatewayInstalling;}catch(e){service.gatewayInstalling=null;throw e;}
}
function ref(remote){const value=remote?.remoteId||remote;if(value&&typeof value==='object'&&value.deviceId&&value.jobId)return {deviceId:value.deviceId,jobId:value.jobId,taskId:value.taskId};throw fail('共享任务缺少已确认的设备任务编号；不能盲目重新提交','REMOTE_ID_MISSING');}
function paused(ms,signal){return new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(Object.assign(new Error('请求中止共享任务等待'),{name:'AbortError'}));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});}
async function waitResult(service,snapshot,remote,options={}){
  const began=Date.now(),timeout=snapshot.timeoutMs||30*60*1000;
  while(Date.now()-began<timeout){
    if(options.signal?.aborted){const status=await service.gateway.cancelRemote(remote);if(status.resultAvailable)return service.gateway.downloadResults({...remote,outputDir:options.outputDir||snapshot.outputDir});if(status.state==='cancelled')throw Object.assign(fail('设备已确认取消','CANCELLED'),{confirmed:true});throw Object.assign(fail('已请求取消，但设备状态尚未确认','REMOTE_UNKNOWN'),{uncertain:true});}
    let status;try{status=await service.gateway.remoteStatus(remote);}catch(e){throw Object.assign(fail('设备状态暂不可取得；未重新提交：'+e.message,e.code||'REMOTE_OFFLINE'),{uncertain:true});}
    options.onProgress?.({remoteId:remote,message:status.message||('设备任务：'+status.state),...(Number.isFinite(status.progress)?{progress:status.progress}:{})});
    if(status.resultAvailable||status.state==='succeeded')return service.gateway.downloadResults({...remote,outputDir:options.outputDir||snapshot.outputDir});
    if(status.state==='cancelled')return {state:'cancelled'};
    if(status.state==='failed')throw fail(status.error||status.message||'设备生成失败','REMOTE_FAILED');
    if(status.state==='unknown')return {state:'unknown',message:status.message};
    await paused(snapshot.pollMs||1200,options.signal).catch(e=>{if(e.name!=='AbortError')throw e;});
  }
  return {state:'unknown',message:'等待设备结果超时，任务未重复提交；可稍后核对'};
}
async function run(service,snapshot,options={}){
  await install(service);if(snapshot.styles?.length&&!snapshot.styleTrace?.length)throw fail('共享生成前需先完成所选风格处理，未静默跳过','STYLE_NOT_PREPARED');if(!snapshot.sharedRequest)throw fail('共享生成缺少明确的设备选择');
  const input={...snapshot.sharedRequest,prompt:snapshot.prompt};let submitted;try{for(const ref of input.references||[]){const local=(snapshot.references||[]).find(r=>r.id===ref.assetId&&(r.inputId||'')===(ref.inputId||''));if(!local?.path||!/^[a-f0-9]{64}$/.test(ref.sha256||''))throw fail('共享引用缺少可核对的提交版本','REFERENCE_VERSION_REQUIRED');const actual=await fingerprint(local.path);if(actual.sha256!==ref.sha256||actual.size!==ref.size)throw fail('冻结引用文件已改变，未发送生成请求','ASSET_VERSION');}submitted=await service.gateway.submitRemote(input);}catch(e){throw Object.assign(fail(e.message,e.code),{beforeSubmission:['ASSET_VERSION','REFERENCE_VERSION_REQUIRED'].includes(e.code),uncertain:['NETWORK','UNCERTAIN','REMOTE_OFFLINE'].includes(e.code)||e.uncertain});}
  const remote={deviceId:submitted.deviceId,jobId:submitted.jobId,taskId:submitted.taskId};options.onProgress?.({remoteId:remote,message:'已提交到所选局域网设备，等待真实结果'});return waitResult(service,snapshot,remote,options);
}
async function reconcile(service,snapshot,remote,options={}){await install(service);let selected;try{selected=ref(remote);}catch{return {state:'unknown',message:'未取得设备任务编号，请在资源设备上核对；不会重复提交'};}await service.gateway.reconcileRemote(selected);return waitResult(service,snapshot,selected,options);}
async function cancel(service,remote){await install(service);let selected;try{selected=ref(remote);}catch{return {cancelled:false,state:'unknown',message:'没有设备任务编号，不能声称取消成功'};}const status=await service.gateway.cancelRemote(selected);if(status.resultAvailable){const task=service.queue?.tasks.find(t=>t.owner===service.identity.id&&t.remoteId?.deviceId===selected.deviceId&&t.remoteId?.jobId===selected.jobId);if(task?.snapshot.outputDir)return service.gateway.downloadResults({...selected,outputDir:task.snapshot.outputDir});return {cancelled:false,state:'unknown',partial:true,message:'设备已结束并保留成功部分，请核对原任务以保存结果'};}return status.state==='cancelled'?{cancelled:true,state:'cancelled'}:{cancelled:false,state:'unknown',message:status.message||'设备尚未确认取消'};}
async function submitNode(service,{nodeId,deviceId,offerId,parameters:values={}}={}){
  await install(service);const current=service.requireCurrent(),lan=service.collab.status();if(service.sharedSession!==current||!['hosting','joined'].includes(lan.mode))throw fail('请先在当前共享画布中选择局域网执行设备','LAN_OFFLINE');
  if(deviceId===service.identity.id)throw fail('本机资源请使用普通本地来源，不创建跨设备代理任务','DEVICE_LOCAL');
  const devices=await service.gateway.listOffers(),selected=devices.devices.find(d=>d.deviceId===deviceId)?.offers.find(o=>o.id===offerId);if(!selected?.enabled)throw fail('所选设备没有主动开放此资源','OFFER_STOPPED');
  const base=await service.buildSnapshot(nodeId,{provider:'comfyui'},current,{skipLocalWorkflow:true});if(base.kind!==selected.kind)throw fail('所选设备资源不支持此节点的输出类型','CAPABILITY');
  await service.syncSharedAssets(current);const requestId=crypto.randomUUID(),references=[],text=[];for(const [index,input]of (base.references||[]).entries()){if(input.id){
    const directory=path.join(service.dataDir,'shared-execution-inputs',requestId);await fs.mkdir(directory,{recursive:true});const frozen=path.join(directory,index+path.extname(input.path||'').slice(0,16));if(!input.path)throw fail('共享输入尚未落盘','ASSET_UNSHARED');await fs.copyFile(input.path,frozen,require('node:fs').constants.COPYFILE_EXCL);const version=await fingerprint(frozen),meta=service.collab.state.manifest.find(m=>m.id===input.id);if(meta?.sha256!==version.sha256||meta?.size!==version.size)throw fail('素材内容已改变，请重新同步确认后提交','ASSET_VERSION');input.path=frozen;input.sha256=version.sha256;input.size=version.size;references.push({assetId:input.id,...version,...(input.inputId?{inputId:input.inputId}:{})});
  }else if(input.type==='text'&&input.text&&!input.inputId)text.push((input.title||'文字参考')+'：\n'+input.text);else throw fail('存在尚未登记为共享素材的输入，未静默丢弃','ASSET_UNSHARED');}
  const supplied={};for(const key of Object.keys(selected.parameters||{})){if(values[key]!==undefined)supplied[key]=values[key];else if(base.parameters?.[key]!==undefined)supplied[key]=base.parameters[key];else if(selected.parameters[key].default!==undefined)supplied[key]=selected.parameters[key].default;}
  for(const key of Object.keys(values))if(!Object.hasOwn(selected.parameters||{},key))throw fail('设备没有公开参数：'+key,'CAPABILITY');
  const request={deviceId,offerId,kind:base.kind,prompt:base.prompt+(text.length?'\n\n'+text.join('\n\n'):''),parameters:supplied,references,requestId,requestCanvasId:current.sharedCanvasId||lan.canvasId};
  // Validate using the wire fields only; device choice stays outside the encrypted payload.
  const {deviceId:_,...wire}=request;service.gateway._validateInput(wire,selected);
  const snapshot={...base,provider:'shared-comfyui',resourceId:'shared:'+deviceId,prompt:request.prompt,sharedRequest:request,workflow:undefined,workflowId:undefined,connection:undefined};const task=await service.queue.submit(snapshot,service.identity.id);
  const node=current.state.nodes.find(n=>n.id===nodeId);if(node){node.taskId=task.id;delete node.error;}current.dirty=true;current.revision++;try{await service.saveSession(current,false);}catch(e){service.log?.('error','共享任务已登记，但画布关联尚未保存',e,{taskId:task.id,deviceId});}return task;
}

module.exports={install,describe,run,reconcile,cancel,submitNode};
