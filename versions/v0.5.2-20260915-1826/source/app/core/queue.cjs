'use strict';
const {EventEmitter}=require('node:events');
const {path,clone,id,fail,readJSON,atomicJSON,serial,redact}=require('./util.cjs');
const {materializeTextResult}=require('../providers/http.cjs');
const TERMINAL=new Set(['succeeded','failed','cancelled']);
class TaskQueue extends EventEmitter {
  constructor({dataDir,run,reconcile,cancel,limits={},onResult,prepare}) {
    super();this.file=path.join(dataDir,'tasks.json');this.run=run;this.reconcileRun=reconcile;this.cancelRun=cancel;this.onResult=onResult;this.prepare=prepare;this.limits={codex:2,image2:2,ollama:1,'openai-compatible':3,runninghub:2,...limits};this.tasks=[];this.controllers=new Map();this.paused=new Set();this.persist=serial();this.closed=false;
  }
  async init(){
    const saved=await readJSON(this.file,{tasks:[],paused:[]});this.tasks=saved.tasks||[];this.paused=new Set(saved.paused||[]);
    for(const t of this.tasks){const interrupted=['running','cancelling','saving','reconciling'].includes(t.state);if(interrupted){t.state='unknown';t.message='软件曾中断；需核对远端任务，不会重复提交';t.updatedAt=new Date().toISOString();}if(t.result&&(t.resultPending||interrupted)){t.resultPending=true;t.message='生成结果已保存，等待恢复画布关联；不会重复生成';}}
    await this.flush();this.kick();return this;
  }
  async flush(){return this.persist(()=>atomicJSON(this.file,{version:1,tasks:this.tasks,paused:[...this.paused]}));}
  emitChange(t){this.emit('change',t?this.public(t):null);}
  public(t){const {snapshot,...visible}=t;return redact(clone(visible));}
  list({canvasId,owner,includeRemoved=false}={}){return this.tasks.filter(t=>(!canvasId||t.canvasId===canvasId)&&(!owner||t.owner===owner)&&(includeRemoved||!t.removed)).map(t=>this.public(t));}
  get(id){return this.tasks.find(t=>t.id===id)||fail('任务不存在','NOT_FOUND');}
  async submit(snapshot,owner){
    if(this.closed)fail('任务服务正在退出');if(!owner||!snapshot?.provider||!snapshot.canvasId)fail('任务缺少来源、画布或所有者');
    const frozen=clone(this.prepare?await this.prepare(snapshot):snapshot),now=new Date().toISOString();
    const task={id:id('task'),owner,canvasId:frozen.canvasId,nodeId:frozen.nodeId||null,projectDir:frozen.projectDir,provider:frozen.provider,resourceId:frozen.resourceId||frozen.provider,title:frozen.title||frozen.kind||'生成任务',state:'queued',createdAt:now,updatedAt:now,message:'等待调度',snapshot:frozen,events:[]};
    this.tasks.push(task);await this.flush();this.emitChange(task);this.kick();return this.public(task);
  }
  bucket(t){return t.provider==='comfyui'?`comfyui:${t.resourceId}`:t.provider;}
  limit(t){return t.provider==='comfyui'?1:(this.limits[t.provider]||1);}
  blocked(t){return this.paused.has(`owner:${t.owner}:${t.provider}`)||this.paused.has(`resource:${t.resourceId}`);}
  kick(){if(this.closed)return;queueMicrotask(()=>{
    if(this.closed)return;
    for(const t of this.tasks){if(t.state!=='queued'||this.blocked(t))continue;const running=this.tasks.filter(x=>['running','cancelling','saving','reconciling','unknown'].includes(x.state)&&this.bucket(x)===this.bucket(t)).length;if(running<this.limit(t))this.execute(t).catch(e=>this.emit('internalError',e));}
  });}
  async transition(t,state,message,extra={}){Object.assign(t,{state,message,updatedAt:new Date().toISOString()},extra);t.events.push({at:t.updatedAt,state,message:redact(message)});if(t.events.length>300)t.events.splice(0,t.events.length-300);await this.flush();this.emitChange(t);}
  async execute(t,recovery=false){
    const retryFailed=recovery&&t.state==='failed',controller=new AbortController();let receivedResult=false;this.controllers.set(t.id,controller);t.state=recovery?'reconciling':'running';
    try{
      await this.transition(t,t.state,recovery?'正在核对远端状态':'正在执行');
      const options={signal:controller.signal,outputDir:t.snapshot.outputDir,onProgress:p=>{
        if(Object.hasOwn(p,'activeOperation'))t.activeOperation=p.activeOperation?clone(p.activeOperation):null;
        if(p.remoteId&&!t.activeOperation)t.styleId=undefined;
        if(p.remoteId)t.remoteId=p.remoteId;if(p.threadId)t.threadId=p.threadId;if(p.turnId)t.turnId=p.turnId;
        if(Number.isFinite(p.progress))t.progress=Math.max(0,Math.min(100,p.progress));else if(p.progress&&Number.isFinite(p.progress.value)&&Number.isFinite(p.progress.max))t.nodeProgress={value:p.progress.value,max:p.progress.max};
        if(p.message)t.message=redact(p.message);t.updatedAt=new Date().toISOString();this.flush().catch(e=>this.emit('internalError',e));this.emitChange(t);
      }};
      let result=recovery?await this.reconcileRun(t.snapshot,{remoteId:t.remoteId,threadId:t.threadId,turnId:t.turnId,activeOperation:t.activeOperation,styleId:t.styleId,retryFailed},options):await this.run(t.snapshot,options);
      if(result?.state==='unknown'||result?.state==='running'){if(result.storyboard)t.partialResult=clone(result);await this.transition(t,'unknown','远端状态尚未确定；未重复提交');return;}
      if(result?.state==='cancelled'){await this.transition(t,'cancelled','来源已确认取消');return;}
      if(!result||(!result.text&&!(result.outputs||[]).length))throw new Error('来源未返回可保存的文字或素材结果');
      t.result=clone(result);receivedResult=true;delete t.partialResult;t.activeOperation=null;t.styleId=undefined;t.styleTrace=result.styleTrace;await this.transition(t,'saving','正在保存并关联结果');
      if(result.pendingTextSave){result=await materializeTextResult(result,options);t.result=clone(result);await this.flush();}
      if(this.onResult)await this.onResult(t,result);
      await this.transition(t,result.cancelled?'cancelled':result.partial?'failed':'succeeded',result.cancelled?'已取消；取消前完成的内容及缺失标记已保存':result.partial?'部分范围未完成，已保留完成内容及缺失标记':'结果已保存',{progress:undefined,partial:!!result.partial,resultPending:false});
    }catch(e){
      if(e.styleTrace)t.styleTrace=clone(e.styleTrace);if(e.styleId)t.styleId=e.styleId;
      if(receivedResult){await this.transition(t,'failed','生成结果已取得，但关联或保存失败：'+e.message,{error:redact(e.message),resultPending:true});}
      else if(e.code==='CANCELLED'||e.name==='AbortError')await this.transition(t,e.confirmed||t.cancelConfirmed?'cancelled':'unknown',e.confirmed||t.cancelConfirmed?'来源已确认取消':'已请求中止；远端状态仍需核对',{error:redact(e.message)});
      else await this.transition(t,e.uncertain?'unknown':'failed',redact(e.message),{error:redact(e.message)});
    }finally{this.controllers.delete(t.id);this.kick();}
  }
  authorize(t,actor){if(t.owner!==actor)fail('只能管理自己的任务','FORBIDDEN');}
  async pause(id,actor){const t=this.get(id);this.authorize(t,actor);if(t.state!=='queued')fail('仅可暂停尚未执行的任务；运行中不会被假暂停');await this.transition(t,'paused','任务已暂停，未开始执行');return this.public(t);}
  async resume(id,actor){const t=this.get(id);this.authorize(t,actor);if(t.state!=='paused')fail('任务不是暂停状态');await this.transition(t,'queued','等待调度');this.kick();return this.public(t);}
  async pauseQueue(provider,actor,paused=true){const key=`owner:${actor}:${provider}`;paused?this.paused.add(key):this.paused.delete(key);await this.flush();this.emitChange();this.kick();}
  async pauseResource(resourceId,paused=true){const key=`resource:${resourceId}`;paused?this.paused.add(key):this.paused.delete(key);await this.flush();this.kick();}
  async cancel(id,actor){
    const t=this.get(id);this.authorize(t,actor);
    if(['queued','paused'].includes(t.state)){await this.transition(t,'cancelled','已取消，尚未提交到来源');this.kick();return this.public(t);}
    if(TERMINAL.has(t.state))return this.public(t);
    if(!this.cancelRun)fail('当前来源未提供可验证的取消能力');
    await this.transition(t,'cancelling','正在请求来源取消');
    try{const r=await this.cancelRun({provider:t.provider,remoteId:t.remoteId,threadId:t.threadId,turnId:t.turnId,resourceId:t.resourceId,connection:t.snapshot.connection,activeOperation:t.activeOperation});
      if(r?.state==='cancelled'||r?.cancelled===true){t.cancelConfirmed=true;this.controllers.get(t.id)?.abort();if(r.text||(r.outputs||[]).length){t.result={...clone(r),state:'completed',cancelled:true,partial:true};await this.transition(t,'saving','取消已确认，正在保存此前完成的部分');try{await this.onResult?.(t,t.result);t.resultPending=false;}catch(error){await this.transition(t,'failed','已取消；此前完成结果的关联需要恢复：'+redact(error.message),{resultPending:true,error:redact(error.message)});return this.public(t);}}await this.transition(t,'cancelled','来源已确认取消；已取得内容继续保留',{partial:!!t.result?.partial});}
      else{await this.transition(t,'unknown',r?.message||'取消尚未确认，需继续核对远端状态');}
    }catch(e){await this.transition(t,'unknown','取消请求未确认：'+redact(e.message));}
    return this.public(t);
  }
  async reconcile(id,actor){const t=this.get(id);this.authorize(t,actor);if(this.controllers.has(id))fail('任务仍在本机执行');
    if(t.resultPending&&t.result){if(t.result.pendingTextSave){t.result=await materializeTextResult(t.result,{outputDir:t.snapshot.outputDir});await this.flush();}await this.onResult(t,t.result);t.resultPending=false;await this.transition(t,t.result.cancelled?'cancelled':t.result.partial?'failed':'succeeded',t.result.cancelled?'已恢复取消前完成的内容':t.result.partial?'已重新关联部分结果，未完成范围仍保留缺失标记':'已重新关联已取得的结果',{partial:!!t.result.partial});return this.public(t);}
    if(!this.reconcileRun)fail('来源不支持核对');if(!['unknown','failed'].includes(t.state))fail('此任务无需恢复');await this.execute(t,true);return this.public(t);
  }
  async remove(id,actor){const t=this.get(id);this.authorize(t,actor);if(!TERMINAL.has(t.state))fail('仅可从列表移除已结束任务；运行任务请先确认取消');t.removed=true;await this.flush();this.emitChange(t);}
  async close(){this.closed=true;await this.flush();}
}
module.exports={TaskQueue,TERMINAL};
