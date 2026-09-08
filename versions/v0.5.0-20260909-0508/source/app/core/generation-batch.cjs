'use strict';
const {fs,path,crypto,clone,id,fail,readJSON,atomicJSON}=require('./util.cjs');
function eligible(s){return s.kind==='image'&&!['media','storyboard'].includes(s.provider);}
function prepare(snapshot){
  if(!eligible(snapshot)||snapshot.generationPlan)return snapshot;
  const count=Number(snapshot.parameters?.count??1);if(!Number.isInteger(count)||count<1||count>8)fail('图片数量必须是 1 到 8 的整数','INVALID_COUNT');
  const field=(snapshot.workflow?.mapping?.inputs||[]).find(f=>f.source==='parameter'&&(['seed','noise_seed'].includes(f.id)||['seed','noise_seed'].includes(f.input)));
  const schema=snapshot.generationSeedRange||field||{},min=Math.max(0,Number(schema.minimum??schema.min??0)),max=Math.min(Number.MAX_SAFE_INTEGER-1,Number(schema.maximum??schema.max??0xffffffff));
  const raw=snapshot.sharedRequest?.parameters?.seed??snapshot.parameters?.[field?.id||'seed'];const explicit=Number(raw);
  if(raw!=null&&(!Number.isSafeInteger(explicit)||explicit<min||explicit>max)&&explicit!==-1)fail('图片种子超出工作流允许范围','INVALID_SEED');
  const seed=Number.isSafeInteger(explicit)&&explicit>=min&&explicit<=max?explicit:min+crypto.randomInt(0,Math.min(max-min+1,0x7fffffff));
  snapshot.generationPlan={id:id('generation'),count,seeds:Array.from({length:count},(_,i)=>min+((seed-min+i)%(max-min+1)))};return snapshot;
}
function oneSnapshot(snapshot,index){
  const out=clone(snapshot),plan=out.generationPlan;delete out.generationPlan;
  out.parameters={...out.parameters,count:1,seed:plan.seeds[index]};
  for(const field of out.workflow?.mapping?.inputs||[])if(field.source==='parameter'){
    if(['count','batch_size','batchSize'].includes(field.id)||field.input==='batch_size')out.parameters[field.id]=1;
    if(['seed','noise_seed'].includes(field.id)||['seed','noise_seed'].includes(field.input))out.parameters[field.id]=plan.seeds[index];
  }
  out.outputDir=path.join(snapshot.outputDir,plan.id,String(index+1));
  if(out.sharedRequest){out.sharedRequest.requestId=plan.id+'-'+index;for(const key of Object.keys(out.sharedRequest.parameters||{})){if(['count','batch_size','batchSize'].includes(key))out.sharedRequest.parameters[key]=1;if(['seed','noise_seed'].includes(key))out.sharedRequest.parameters[key]=plan.seeds[index];}}
  return out;
}
const BEFORE_SUBMISSION_CODES=new Set(['OUTPUT_DIR_REQUIRED','WORKFLOW_INVALID','GUI_INVALID','API_INVALID','MAPPING_INVALID','WORKFLOW_REQUIRED','REFERENCE_MISSING','REFERENCE_COUNT','REFERENCE_TYPE','INPUT_REQUIRED','PARAMETER_RANGE','PARAMETER_OPTION','ENVIRONMENT_MISMATCH','LAUNCH_CONFIG_REQUIRED','REMOTE_LAUNCH','LAUNCH_FAILED','LAUNCH_TIMEOUT','UNSUPPORTED_CAPABILITY','UNSUPPORTED_REFERENCE','POLICY_UNCONFIRMED','MODEL_REQUIRED','CREDENTIAL_REQUIRED','PROVIDER_UNAVAILABLE','INVALID_ENDPOINT']);
function receipt(value){return Object.fromEntries(['remoteId','threadId','turnId'].filter(k=>value?.[k]).map(k=>[k,value[k]]));}
function rememberRemote(current,value){const fields=receipt(value);if(Object.keys(fields).length)current.remote={...current.remote,...fields};}
function failureState(error,current){
  if((error.code==='CANCELLED'&&error.confirmed)||error.cancellation?.state==='cancelled')return 'cancelled';
  if(['EXECUTION_FAILED','SUBMISSION_REJECTED'].includes(error.code))return 'failed';
  // Missing a receipt is not proof that the request was never sent.
  if(!current?.remote&&(error.beforeSubmission===true||error.submitted===false||BEFORE_SUBMISSION_CODES.has(error.code)))return 'not-submitted';
  return 'unknown';
}
function collect(record){return {provider:record.provider,state:'completed',outputs:record.results.flatMap(r=>r.outputs||[]),text:record.results.map(r=>r.text).filter(Boolean).join('\n\n'),generations:record.results.map(({outputs,text,...r})=>r),generationErrors:record.errors,styleTrace:record.styleTrace,partial:record.results.length<record.count||record.errors.length>0,...(record.cancelled?{cancelled:true,partial:true}:{})};}
class ImageBatchRunner {
  constructor({dataDir,run,reconcile,cancel}){this.directory=path.join(dataDir,'generation-batches');this.runOne=run;this.reconcileOne=reconcile;this.cancelOne=cancel;this.active=new Map();}
  file(plan){if(!/^generation-[a-zA-Z0-9-]+$/.test(plan.id))fail('生成记录标识无效');return path.join(this.directory,plan.id+'.json');}
  async execute(snapshot,options={},recover=false){
    if(!snapshot.generationPlan)return this.runOne(snapshot,options);
    const plan=snapshot.generationPlan,file=this.file(plan);let record=await readJSON(file,null);
    if(record&&!recover)fail('该批生成已有提交记录，请核对状态，不会重复提交','GENERATION_EXISTS');
    record=record||{id:plan.id,count:plan.count,seeds:plan.seeds,prompt:snapshot.prompt,styleTrace:snapshot.styleTrace,results:[],errors:[],current:null};record.provider=snapshot.provider;
    snapshot={...snapshot,prompt:record.prompt,styleTrace:record.styleTrace};
    if(record.count!==plan.count||JSON.stringify(record.seeds)!==JSON.stringify(plan.seeds))fail('生成提交记录不匹配');
    let resolveDone;const active={record,cancelled:false,controller:new AbortController(),done:new Promise(r=>resolveDone=r)};this.active.set(plan.id,active);
    const signal=options.signal?AbortSignal.any([options.signal,active.controller.signal]):active.controller.signal;
    let writes=Promise.resolve();const save=()=>{const frozen=clone(record);writes=writes.then(()=>atomicJSON(file,frozen));return writes;};
    const finish=()=>{const result=collect(record);if(record.cancelled&&!result.outputs.length&&!result.text)result.state='cancelled';active.result=result;return result;};
    try{
      if(record.cancelled)return finish();
      for(let index=record.results.length;index<plan.count;index++){
        if(active.cancelled){record.cancelled=true;await save();return finish();}
        if(signal.aborted){const e=new Error('图片生成已中止，远端状态仍需核对');e.code='CANCELLED';throw e;}
        let attempt=record.current?.attempt||1;
        if(record.current&&['failed','not-submitted'].includes(record.current.status)){
          if(!recover||options.retryFailed===false){const e=new Error(record.current.error?.message||'此份生成已失败，等待明确重试');e.code=record.current.error?.code||'EXECUTION_FAILED';throw e;}
          (record.attempts||=[]).push(clone(record.current));attempt++;record.current=null;record.errors=[];
        }
        const one=oneSnapshot(snapshot,index);if(one.sharedRequest&&attempt>1)one.sharedRequest.requestId+='-attempt-'+attempt;
        const resuming=record.current?.index===index;
        if(record.current&&!resuming)fail('生成恢复索引不匹配','GENERATION_RECORD_INVALID');
        if((resuming&&!record.current.remote)||(!record.current&&record.errors.some(e=>e.index===index))){const e=new Error('此前失败记录缺少可核对回执，不能安全重复生成');e.code='GENERATION_RECEIPT_MISSING';e.uncertain=true;throw e;}
        await fs.mkdir(one.outputDir,{recursive:true});
        record.current=record.current||{index,seed:plan.seeds[index],attempt,startedAt:new Date().toISOString(),status:'submitting',remote:null};record.errors=[];await save();
        options.onProgress?.({remoteId:{type:'image-batch',id:plan.id},message:`生成图片 ${index+1} / ${plan.count}`});
        const progress=p=>{
          if(record.current?.index!==index)return;
          if(p.remoteId||p.threadId||p.turnId){rememberRemote(record.current,p);if(p.state)record.current.remoteState=p.state;save().catch(()=>{});}
          const {remoteId,threadId,turnId,...visible}=p;options.onProgress?.({...visible,remoteId:{...(typeof record.current.remote?.remoteId==='object'?record.current.remote.remoteId:{}),type:'image-batch',id:plan.id},message:`图片 ${index+1} / ${plan.count}：${p.message||'处理中'}`});
        };
        let result;
        try{
          const runOptions={...options,signal,outputDir:one.outputDir,onProgress:progress};
          result=resuming?await this.reconcileOne(one,record.current.remote,runOptions):await this.runOne(one,runOptions);
          rememberRemote(record.current,result);
          if(result?.state==='failed'){const e=new Error(result.message||'来源已确认执行失败');e.code='EXECUTION_FAILED';throw e;}
          if(result?.state==='cancelled'){const e=new Error('来源已确认取消');e.code='CANCELLED';e.confirmed=true;throw e;}
          if(result?.state&&!['completed','succeeded'].includes(result.state)){record.current.remoteState=result.state;const e=new Error(result.message||'当前图片远端状态尚未确认，未重复提交');e.code='GENERATION_PENDING';e.uncertain=true;throw e;}
          if(!result?.outputs?.length&&!result?.text){const e=new Error('当前图片未返回可保存结果，需核对原任务');e.code='OUTPUT_MISSING';throw e;}
          const seedSupported=snapshot.provider==='comfyui'&&(snapshot.workflow?.mapping?.inputs||[]).some(f=>f.source==='parameter'&&(['seed','noise_seed'].includes(f.id)||['seed','noise_seed'].includes(f.input)));
          const reported=(result.outputs||[]).some(o=>Number.isSafeInteger(o.seed));record.results.push({index,seed:plan.seeds[index],seedStatus:seedSupported?'submitted':reported?'reported-by-source':'unsupported-or-not-reported',completedAt:new Date().toISOString(),text:result.text,outputs:(result.outputs||[]).map(o=>({...o,generationIndex:index,seed:seedSupported?plan.seeds[index]:o.seed})),partial:!!result.partial});record.current=null;await save();
          if(active.cancelled||result.cancelled){record.cancelled=true;await save();return finish();}
          if(result.partial){record.errors.push({index,message:'当前份生成仅部分完成'});await save();break;}
        }catch(e){
          await writes;rememberRemote(record.current,e);if(e.details)rememberRemote(record.current,e.details);
          const status=active.cancelled?'cancelled':failureState(e,record.current);
          record.current.status=status;record.current.error={code:e.code||'GENERATION_ERROR',message:e.message};
          record.errors=[{index,seed:plan.seeds[index],code:e.code||'GENERATION_ERROR',message:e.message,status,retryable:['failed','not-submitted'].includes(status)}];
          if(status==='cancelled')record.cancelled=true;await save();
          if(status==='cancelled')return finish();
          if(status==='unknown'){e.uncertain=true;throw e;}
          e.uncertain=false;if(!record.results.length)throw e;break;
        }
      }
      return finish();
    }finally{try{await writes;}finally{this.active.delete(plan.id);resolveDone();}}
  }
  async cancel(remote){
    const token=remote.remoteId;if(token?.type!=='image-batch')return this.cancelOne(remote);
    const file=this.file(token),active=this.active.get(token.id),record=active?.record||await readJSON(file,null);
    if(!record)fail('找不到此批生成记录');
    if(!record.current){if(active){active.cancelled=true;active.controller.abort();await active.done;return active.result?.cancelled?active.result:{state:'cancelled'};}return {state:'unknown',message:'本批没有仍在执行的来源，需恢复已有结果'};}
    if(record.cancelled){const saved=collect(record);return saved.outputs.length||saved.text?saved:{state:'cancelled'};}
    if(['failed','not-submitted'].includes(record.current.status))return {state:'failed',message:'当前份已确认失败，没有仍需取消的来源'};
    if(!record.current.remote)return {state:'unknown',message:'生成提交尚未取得来源标识，不能确认取消'};
    const result=await this.cancelOne({...remote,...record.current.remote});
    if(result?.state==='cancelled'||result?.cancelled===true){if(active){active.cancelled=true;active.controller.abort();await active.done;return active.result?.cancelled?active.result:{state:'cancelled'};}record.cancelled=true;record.current.status='cancelled';await atomicJSON(file,record);const saved=collect(record);return saved.outputs.length||saved.text?saved:{state:'cancelled'};}return result;
  }
}
module.exports={prepare,oneSnapshot,ImageBatchRunner};
