'use strict';
const {ProviderError}=require('../providers/util.cjs');
const {path,crypto,clone,readJSON,atomicJSON,serial}=require('./util.cjs');
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>['string','number','boolean'].includes(typeof value?.[key])).map(key=>[key,value[key]]));
const receipt=remote=>pick(remote,['provider','remoteId','threadId','turnId']);
function contextOf(context){if(!context)return null;return {...pick(context,['requestId','userText','requestedThreadId','projectDir','canvasDir','canvasId','canvasName','startedAt']),skills:(context.skills||[]).map(s=>pick(s,['id','name','revision','version','sha256','content'])),nodes:(context.nodes||[]).map(n=>pick(n,['id','title','type','assetId']))};}

// This controller owns one private chat turn, not the generation queue. Dynamic
// tools may submit independent tasks; stopping a chat must never cancel those.
class ChatSession {
  constructor({hub,dataDir}){this.hub=hub;this.active=null;this.sequence=0;this.records=[];this.saveLock=serial();this.file=dataDir?path.join(dataDir,'private-chat-turns.json'):null;this.ready=this.file?this.load():null;this.ready?.catch(()=>{});}
  async load(){const saved=await readJSON(this.file,{version:1,records:[]});if(saved.version!==1||!Array.isArray(saved.records))throw new ProviderError('私人聊天恢复记录损坏，未重新发送请求','CHAT_RECORD_INVALID');this.records=saved.records.map(r=>({...pick(r,['id','phase','createdAt','updatedAt','associated','stopRequested']),context:contextOf(r.context),snapshot:pick(r.snapshot,['provider','kind','model','effort','outputDir']),remote:receipt(r.remote),...(r.result?{result:{...receipt(r.result),...pick(r.result,['state','text'])}}:{})}));const open=this.records.filter(r=>!r.result);if(open.length>1)throw new ProviderError('有多个未确认私人回合，需人工核对；未任意选择或重发','CHAT_RECORD_INVALID');if(open.length){const record=open[0];record.phase='unknown';this.active={id:record.id,phase:'unknown',stopRequested:!!record.stopRequested,remote:{...record.remote},snapshot:{...record.snapshot},context:record.context,controller:new AbortController(),options:{outputDir:record.snapshot.outputDir},record,restored:true};}return this;}
  persist(){if(!this.file)return Promise.resolve();const state=clone({version:1,records:this.records});return this.saveLock(()=>atomicJSON(this.file,state));}
  state(){const active=this.active,pendingResults=this.records.filter(r=>r.result&&!r.associated).length;return active?{active:true,phase:active.phase,stopRequested:active.stopRequested,requestId:active.id,...receipt(active.remote),projectDir:active.context?.projectDir,canvasId:active.context?.canvasId,restored:!!active.restored,pendingResults}:{active:false,phase:pendingResults?'result-pending':'idle',pendingResults};}
  record(requestId){const record=this.records.find(r=>r.id===requestId);return record?clone(record):null;}
  resultOf(record){return {...record.result,...record.remote,requestId:record.id,context:clone(record.context),state:record.result?.state||record.phase,active:!!this.active};}
  async acknowledge(requestId){if(this.ready)await this.ready;const record=this.records.find(r=>r.id===requestId);if(record?.result){record.associated=true;await this.persist();}}
  async finish(active,result){if(result.state&&!['completed','failed','cancelled'].includes(result.state)){active.phase='unknown';active.record.phase='unknown';await this.persist();return {...result,requestId:active.id,context:clone(active.context),active:true};}active.record.result={...receipt({...active.remote,...result}),...pick(result,['state','text'])};active.record.result.state||='completed';active.record.phase=active.record.result.state;active.record.remote=receipt(active.remote);active.record.updatedAt=new Date().toISOString();await this.persist();if(this.active===active)this.active=null;return {...result,state:active.record.result.state,requestId:active.id,context:clone(active.context)};}
  async run(snapshot,options={}){
    if(this.ready)await this.ready;
    if(this.active)throw new ProviderError('已有一轮私人对话正在处理；请等待结束或停止本轮','CHAT_BUSY');
    if(snapshot.provider&&snapshot.provider!=='codex')throw new ProviderError('私人对话仅允许 Codex 文字会话','CHAT_PROVIDER_INVALID');
    if(snapshot.kind&&snapshot.kind!=='text')throw new ProviderError('图片生成须提交独立任务，不能作为私人对话执行','CHAT_KIND_INVALID');
    const context=contextOf(options.context),requestId=context?.requestId||crypto.randomUUID();if(this.records.some(r=>r.id===requestId))throw new ProviderError('该私人回合已有提交记录，不能重复发送','CHAT_DUPLICATE');
    const {context:_,...providerOptions}=options;const now=new Date().toISOString(),record={id:requestId,createdAt:now,updatedAt:now,phase:'preparing',context,snapshot:{provider:'codex',kind:'text',outputDir:options.outputDir||snapshot.outputDir},remote:{provider:'codex'},associated:!context};this.records.push(record);
    const active={id:requestId,phase:'preparing',controller:new AbortController(),stopRequested:false,remote:{provider:'codex'},snapshot:null,context,options:providerOptions,record};this.active=active;
    const signal=options.signal?AbortSignal.any([options.signal,active.controller.signal]):active.controller.signal;
    try{
      await this.persist();const fixed=await this.hub.prepare({...snapshot,provider:'codex',kind:'text'});active.snapshot=fixed;active.remote.connection=fixed.connection;record.snapshot=pick(fixed,['provider','kind','model','effort','outputDir']);record.snapshot.outputDir=options.outputDir||fixed.outputDir;
      if(signal.aborted){const error=new ProviderError('私人对话已在发送前停止','CANCELLED');error.confirmed=true;throw error;}
      active.phase='running';record.phase='running';await this.persist();
      const result=await this.hub.run(fixed,{...providerOptions,signal,onProgress:progress=>{
        // Only a receipt for this run may supply a turn identifier. Never copy a
        // previous conversation's turn id from the input snapshot.
        for(const key of ['remoteId','threadId','turnId'])if(progress[key])active.remote[key]=progress[key];
        record.remote=receipt(active.remote);record.updatedAt=new Date().toISOString();this.persist().catch(()=>{});
        options.onProgress?.(progress);
      }});
      return await this.finish(active,result);
    }catch(error){
      for(const key of ['remoteId','threadId','turnId'])if(error[key])active.remote[key]=error[key];
      record.remote=receipt(active.remote);record.updatedAt=new Date().toISOString();error.chatRequestId=active.id;
      if(error.uncertain&&!error.confirmed&&active.phase!=='preparing'){active.phase='unknown';active.error=error.message;}
      else if(!record.result){record.result={state:error.confirmed&&['CANCELLED','ABORTED'].includes(error.code)?'cancelled':'failed',...receipt(active.remote)};if(this.active===active)this.active=null;}
      else if(this.active===active)this.active=null;
      record.phase=record.result?.state||active.phase;await this.persist();
      throw error;
    }
  }
  async stop(){
    if(this.ready)await this.ready;
    const active=this.active;if(!active)return {state:'not-running',message:'没有正在进行的私人对话'};
    active.stopRequested=true;active.record.stopRequested=true;await this.persist();
    if(!active.remote.threadId||!(active.remote.turnId||active.remote.remoteId)){
      // Aborting the adapter before receipt prevents submission when possible;
      // if a receipt arrives after abort, the adapter interrupts that exact turn.
      active.controller.abort();return {state:'cancel-requested',message:'已请求停止本轮私人对话，正在确认是否已经发送'};
    }
    if(active.cancelling)return active.cancelling;
    active.cancelling=(async()=>{const result=await this.hub.cancel({...active.remote,provider:'codex'});active.phase=active.phase==='unknown'?'unknown':'stopping';return result;})().finally(()=>{active.cancelling=null;});
    return active.cancelling;
  }
  async reconcile(options={}){
    if(this.ready)await this.ready;
    const active=this.active;if(!active){const pending=this.records.find(r=>r.result&&!r.associated);return pending?this.resultOf(pending):{state:'idle',active:false};}
    if(active.phase!=='unknown')return {state:active.phase,...this.state()};
    if(!active.snapshot||!active.remote.threadId||!(active.remote.turnId||active.remote.remoteId))return {state:'unknown',...this.state(),message:'本轮发送状态未知且缺少回合标识，不能自动重交'};
    if(typeof this.hub.reconcile!=='function')return {state:'unknown',...this.state(),message:'当前适配器不支持读取原回合；记录已保留，未重新发送'};
    if(active.reconciling)return active.reconciling;
    active.reconciling=(async()=>{try{const result=await this.hub.reconcile(active.snapshot,active.remote,{...active.options,...options,onToolCall:undefined,onProgress:undefined});if(['completed','failed','cancelled'].includes(result.state))return {...await this.finish(active,result),active:false};return {...result,requestId:active.id,context:clone(active.context),active:true};}catch(error){error.chatRequestId=active.id;active.phase='unknown';active.record.phase='unknown';await this.persist();throw error;}})().finally(()=>{active.reconciling=null;});return active.reconciling;
  }
}
module.exports={ChatSession};
