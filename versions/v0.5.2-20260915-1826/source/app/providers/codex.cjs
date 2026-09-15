'use strict';
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const crypto = require('node:crypto');
const { ProviderError, redact, saveText, writeAtomic, mediaType, abortCheck } = require('./util.cjs');
const {restrictedConfig,restrictedLaunchArgs,freezeSkills}=require('./codex-policy.cjs');

function discoverCodex(config={}) {
  if(config.command) return {command:config.command,argsPrefix:config.argsPrefix || []};
  if(process.env.CODEX_CLI_PATH && fss.existsSync(process.env.CODEX_CLI_PATH))return {command:process.env.CODEX_CLI_PATH,argsPrefix:[]};
  const base=path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'OpenAI','Codex','bin');
  if(fss.existsSync(base)){const found=fss.readdirSync(base).map(n=>path.join(base,n,'codex.exe')).filter(f=>fss.existsSync(f)).sort((a,b)=>fss.statSync(b).mtimeMs-fss.statSync(a).mtimeMs);if(found.length)return {command:found[0],argsPrefix:[]};}
  const npm=path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'npm','node_modules','@openai','codex','bin','codex.js');
  if(fss.existsSync(npm))return {command:process.execPath,argsPrefix:[npm]};
  return {command:process.platform==='win32'?'codex.exe':'codex',argsPrefix:[]};
}
class CodexProvider {
  constructor(config={},options={}) {this.config=config;this.spawn=options.spawn || spawn;this.child=null;this.pending=new Map();this.turns=new Map();this.handlers=new Map();this.counter=0;this.starting=null;this.stderr='';}
  send(value){if(!this.child?.stdin?.writable)throw new ProviderError('Codex 连接尚未就绪','CODEX_DISCONNECTED');this.child.stdin.write(JSON.stringify(value)+'\n');}
  request(method,params={},timeoutMs=30000) {return new Promise((resolve,reject)=>{const id=++this.counter;const timer=setTimeout(()=>{this.pending.delete(id);reject(new ProviderError(`Codex 请求超时：${method}`,'STATUS_UNKNOWN',{method}));},timeoutMs);this.pending.set(id,{resolve,reject,timer,method});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  state(turnId){if(!this.turns.has(turnId))this.turns.set(turnId,{items:[],text:'',done:null,waiters:[]});return this.turns.get(turnId);}
  settle(state){if(!state.done)return;for(const waiter of state.waiters.splice(0)){clearTimeout(waiter.timer);waiter.cleanup();if(['failed','interrupted'].includes(state.done.status)){const error=new ProviderError(state.done.error?.message || 'Codex 回合已中断',state.done.status==='failed'?'EXECUTION_FAILED':'CANCELLED',state.done.error);error.confirmed=state.done.status==='interrupted';waiter.reject(error);}else waiter.resolve(state);}}
  async message(msg){
    if(msg.id!=null && !msg.method && this.pending.has(msg.id)){const p=this.pending.get(msg.id);this.pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new ProviderError(`${p.method}: ${msg.error.message || '协议错误'}`,'CODEX_PROTOCOL',msg.error)):p.resolve(msg.result);return;}
    if(msg.id!=null && msg.method){
      const p=msg.params || {};let result;
      if(msg.method==='item/tool/call'){try{const handler=this.handlers.get(p.threadId);if(!handler)throw new Error('此线程没有授权的画布工具处理器');const value=await handler(p.tool,p.arguments,{threadId:p.threadId,turnId:p.turnId});result={success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]};}catch(e){result={success:false,contentItems:[{type:'inputText',text:redact(e.message)}]};}}
      else if(msg.method.includes('requestApproval'))result={decision:'decline'};
      else if(msg.method==='item/tool/requestUserInput'||msg.method==='tool/requestUserInput')result={answers:{}};
      else if(msg.method==='mcpServer/elicitation/request')result={action:'decline',content:null};
      else {this.send({id:msg.id,error:{code:-32601,message:'CreateMore 不支持此交互请求；未自动授权'}});return;}
      this.send({id:msg.id,result});return;
    }
    const p=msg.params || {};const turnId=p.turnId || p.turn?.id;if(!turnId)return;const state=this.state(turnId);
    if(msg.method==='item/agentMessage/delta'){state.text+=p.delta || '';state.onProgress?.({state:'running',message:'Codex 正在回复',delta:p.delta});}
    if(msg.method==='item/completed'){state.items.push(p.item);state.onProgress?.({state:'running',message:p.item?.type==='imageGeneration'?'Codex 图像工具已返回，正在核对文件':'Codex 正在处理',itemType:p.item?.type});}
    if(msg.method==='turn/completed'){state.done=p.turn;this.settle(state);}
  }
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();for(const state of this.turns.values())for(const w of state.waiters.splice(0)){clearTimeout(w.timer);w.cleanup();w.reject(error);}this.starting=null;this.child=null;}
  async start(){if(this.starting)return this.starting;this.starting=(async()=>{const rt=discoverCodex(this.config);const args=[...rt.argsPrefix,'app-server','--stdio',...restrictedLaunchArgs()];const env={...process.env};if(process.versions.electron&&rt.command===process.execPath)env.ELECTRON_RUN_AS_NODE='1';const child=this.spawn(rt.command,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env});this.child=child;child.on('error',e=>this.fail(new ProviderError(`无法启动本机 Codex：${e.message}`,'CODEX_UNAVAILABLE')));child.on('exit',code=>this.fail(new ProviderError(`Codex 连接中断（${code}）；请恢复核对任务`,'STATUS_UNKNOWN')));createInterface({input:child.stdout}).on('line',line=>{try{this.message(JSON.parse(line)).catch(e=>{this.stderr=redact(e.message);});}catch{}});createInterface({input:child.stderr}).on('line',line=>{this.stderr=(this.stderr+'\n'+redact(line)).slice(-6000);});await this.request('initialize',{clientInfo:{name:'createmore',title:'CreateMore',version:'0.1.0'},capabilities:{experimentalApi:true}});this.send({method:'initialized'});return this;})().catch(e=>{this.close();throw e;});return this.starting;}
  async status(){try{await this.start();const [account,models,capabilities]=await Promise.all([this.request('account/read',{refreshToken:false}),this.request('model/list',{limit:100,includeHidden:false}),this.request('modelProvider/capabilities/read',{}).catch(()=>({imageGeneration:false}))]);this.models=models.data || [];this.capabilities=capabilities;return {ready:!!account.account,available:true,authenticated:!!account.account,authType:account.account?.type,models:this.models,capabilities:['text','image-input','agent',...(capabilities.imageGeneration?['image']:[])],reason:account.account?undefined:'请先使用本机 Codex 登录；不需要 OpenAI API 密钥'};}catch(e){return {ready:false,available:false,reason:e.message,code:e.code};}}
  async threadPolicy(snapshot,outputDir){
    const config=restrictedConfig();const servers=[];let cursor;
    do{const page=await this.request('mcpServerStatus/list',{limit:100,...(cursor?{cursor}:{})});servers.push(...page.data);cursor=page.nextCursor;}while(cursor);
    // An empty mcp_servers table is merged with user config, so explicitly disable every discovered entry.
    config.mcp_servers=Object.fromEntries(servers.map(s=>[s.name,{enabled:false}]));
    const listed=await this.request('skills/list',{cwds:[path.resolve(outputDir)],forceReload:true});
    const selected=new Set((snapshot.skills || []).filter(s=>s.enabled!==false&&s.path).map(s=>path.resolve(s.path).toLowerCase()));
    config['skills.config']=(listed.data || []).flatMap(d=>d.skills || []).map(s=>({path:s.path,enabled:selected.has(path.resolve(s.path).toLowerCase())}));
    for(const skill of snapshot.skills || [])if(skill.enabled!==false&&skill.path&&!config['skills.config'].some(s=>path.resolve(s.path).toLowerCase()===path.resolve(skill.path).toLowerCase()))config['skills.config'].push({path:skill.path,enabled:true});
    return config;
  }
  async run(snapshot,{onProgress=()=>{},signal,outputDir,onToolCall}={}){
    if(!['text','image'].includes(snapshot.kind))throw new ProviderError('Codex 不能生成此素材类型','UNSUPPORTED_CAPABILITY');if(!outputDir)throw new ProviderError('缺少结果目录','OUTPUT_DIR_REQUIRED');await fs.mkdir(outputDir,{recursive:true});abortCheck(signal);await this.start();
    const verifyAccount=async()=>{if(!snapshot.connection?.expectedAccountFingerprint)return;const current=(await this.request('account/read',{refreshToken:false})).account;if(!current||require('./account-identity.cjs').accountFingerprint(current)!==snapshot.connection.expectedAccountFingerprint){const error=new ProviderError('执行设备的 Codex 账号已改变，未向新账号提交；请由主人重新开放资源','ACCOUNT_CHANGED');error.beforeSubmission=true;throw error;}};await verifyAccount();
    const imageMode=snapshot.provider==='image2'||snapshot.kind==='image';const refs=snapshot.references || [];if(refs.some(r=>r.type && r.type!=='image'))throw new ProviderError('Codex 参考输入只接受图像；视频与音频须先分析取帧或转录','UNSUPPORTED_REFERENCE');
    const instruction=imageMode?`请用 Codex 内置 image_gen 工具实际生成/编辑一张图片。必须调用该工具，不要用 Python、SVG、浏览器截图或外部 API 代替。不要查找 API 密钥。参考图如有，须按用户提示使用。完成后直接返回结果，不要额外调用文件编辑工具。\n尺寸或比例：${snapshot.parameters?.size || snapshot.parameters?.ratio || '1:1'}\n用户提示：${snapshot.prompt}`:snapshot.prompt;
    const threadConfig=await this.threadPolicy(snapshot,outputDir);threadConfig['features.image_generation']=imageMode;
    const threadOptions={cwd:outputDir,approvalPolicy:'never',sandbox:'read-only',ephemeral:false,environments:[],selectedCapabilityRoots:[],config:threadConfig,developerInstructions:'你是 CreateMore 创作助手。只能通过当前显式提供的画布工具操作画布。普通文字请求直接回答；不得通过 shell 绕过画布权限，不修改本地文件或全局配置。私人对话如需生成图片，使用显式画布生成工具提交独立任务；图像生成专用回合使用内置图像工具。'};
    if(snapshot.model || snapshot.connection?.model || (!snapshot.connection?.frozen&&this.config.model))threadOptions.model=snapshot.model || snapshot.connection?.model || this.config.model;
    if(snapshot.tools?.length)threadOptions.dynamicTools=snapshot.tools.map(t=>({type:'function',name:t.name,description:t.description,inputSchema:t.inputSchema,deferLoading:false}));
    let threadId=snapshot.threadId;
    if(threadId)await this.request('thread/resume',{threadId,...threadOptions},60000);else threadId=(await this.request('thread/start',threadOptions,60000)).thread.id;
    const inventory=await this.request('mcpServerStatus/list',{threadId,limit:100});if(inventory.data.some(s=>s.runtimeStatus!=='disabled'&&Object.keys(s.tools || {}).length))throw new ProviderError('创作助手仍发现未隔离的 MCP 工具，已阻止发送请求','POLICY_UNCONFIRMED');
    if(onToolCall)this.handlers.set(threadId,onToolCall);
    const input=[{type:'text',text:instruction,text_elements:[]}];for(const ref of refs){await fs.access(ref.path);input.push({type:'localImage',path:path.resolve(ref.path),detail:'original'});}for(const skill of await freezeSkills(snapshot.skills || []))input.push({type:'text',text:`用户显式选择的创作方法 ${skill.name || 'Skill'}（仅适用于本次请求；不扩大工具和画布权限）：\n${skill.content}`,text_elements:[]});
    const turnParams={threadId,input,environments:[]};if(snapshot.effort || snapshot.connection?.effort || (!snapshot.connection?.frozen&&this.config.effort))turnParams.effort=snapshot.effort || snapshot.connection?.effort || this.config.effort;if(snapshot.outputSchema)turnParams.outputSchema=snapshot.outputSchema;
    let turnId;
    try{if(signal?.aborted){const error=new ProviderError('本次对话已在发送前取消','CANCELLED');error.confirmed=true;throw error;}await verifyAccount();const response=await this.request('turn/start',turnParams,60000);turnId=response.turn.id;const state=this.state(turnId);state.onProgress=onProgress;onProgress({state:'submitted',threadId,turnId,remoteId:turnId,message:'Codex 已接收本次请求'});
      const result=await new Promise((resolve,reject)=>{const onAbort=()=>{this.cancel({threadId,turnId}).catch(()=>{});const i=state.waiters.indexOf(waiter);if(i>=0)state.waiters.splice(i,1);clearTimeout(waiter.timer);reject(new ProviderError('已请求中断 Codex；需核对最终状态','ABORTED'));};const waiter={resolve,reject,cleanup:()=>signal?.removeEventListener('abort',onAbort),timer:setTimeout(()=>{const i=state.waiters.indexOf(waiter);if(i>=0)state.waiters.splice(i,1);waiter.cleanup();reject(new ProviderError('Codex 等待超时；保留回合标识，不重复提交','STATUS_UNKNOWN'));},snapshot.timeoutMs || 1200000)};state.waiters.push(waiter);signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();else this.settle(state);});
      return await this.collect(result,{imageMode,threadId,turnId,outputDir,provider:imageMode?'image2':'codex'});
    }catch(e){e.threadId=threadId;e.turnId=turnId;e.remoteId=turnId;e.provider=imageMode?'image2':'codex';throw e;}
    finally{if(!snapshot.keepToolHandler)this.handlers.delete(threadId);}
  }
  async collect(state,{imageMode,threadId,turnId,outputDir,provider}){
    const outputs=[];const text=state.items.filter(i=>i?.type==='agentMessage').map(i=>i.text).join('\n') || state.text || '';
    if(imageMode){for(const item of state.items.filter(i=>i?.type==='imageGeneration')){if(item.failure)continue;const dest=path.join(outputDir,`image2-${crypto.randomUUID()}.png`);if(item.savedPath){const stat=await fs.stat(item.savedPath);if(!stat.size)continue;await fs.copyFile(item.savedPath,dest);outputs.push({path:dest,type:'image',mime:'image/png',bytes:stat.size});}else if(item.result && /^[A-Za-z0-9+/=\r\n]+$/.test(item.result) && item.result.length>100){const bytes=Buffer.from(item.result,'base64');if(bytes.subarray(1,4).toString()!=='PNG' && bytes[0]!==0xff)continue;await writeAtomic(dest,bytes);outputs.push({path:dest,type:'image',mime:'image/png',bytes:bytes.length});}}if(!outputs.length)throw new ProviderError('Codex 回合结束，但未取得内置 Image2 的真实图像文件','IMAGE_OUTPUT_MISSING',{text,failures:state.items.filter(i=>i?.type==='imageGeneration').map(i=>i.failure)});}
    else {if(!text.trim())throw new ProviderError('Codex 未返回文字结果','EMPTY_OUTPUT');outputs.push(await saveText(outputDir,text,'codex'));}
    return {provider,remoteId:turnId,threadId,turnId,state:'completed',outputs,text,metadata:{itemTypes:state.items.map(i=>i?.type)}};
  }
  async cancel({threadId,turnId,remoteId}){await this.start();if(!threadId || !(turnId || remoteId))throw new ProviderError('缺少 Codex 线程/回合标识','REMOTE_ID_REQUIRED');await this.request('turn/interrupt',{threadId,turnId:turnId || remoteId});return {state:'cancel-requested',message:'已请求 Codex 中断，等待真实结束事件'};}
  async reconcile(snapshot,remote,{outputDir}={}){await this.start();const data=await this.request('thread/read',{threadId:remote.threadId,includeTurns:true});const turn=data.thread?.turns?.find(t=>t.id===(remote.turnId || remote.remoteId));if(!turn)return {state:'unknown',message:'Codex 历史未找到此回合，不能自动重交'};if(turn.status!=='completed')return {state:turn.status==='failed'?'failed':turn.status==='interrupted'?'cancelled':'unknown',message:turn.error?.message || `Codex 回合状态：${turn.status}`};if(!outputDir)return {state:'completed-remote'};return this.collect({items:turn.items || [],text:''},{imageMode:snapshot.provider==='image2'||snapshot.kind==='image',provider:snapshot.provider,threadId:remote.threadId,turnId:turn.id,outputDir});}
  close(){const child=this.child;this.child=null;this.starting=null;if(child)child.kill();this.fail(new ProviderError('CreateMore 的 Codex 连接已关闭','CODEX_DISCONNECTED'));}
}
module.exports={CodexProvider,discoverCodex};
