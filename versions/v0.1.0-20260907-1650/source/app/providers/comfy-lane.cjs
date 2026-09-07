'use strict';
const {ProviderError,sleep}=require('./util.cjs');
const lanes=new Map();
function laneKey(url){const parsed=new URL(url);if(parsed.hostname==='localhost')parsed.hostname='127.0.0.1';return parsed.href.replace(/\/$/,'');}
// All CreateMore Comfy runs, including style/vision substeps, share this lane.
// Existing externally submitted Comfy work is left untouched and allowed to finish.
async function inComfyLane(provider,work,{signal,onProgress=()=>{}}={}){
  const key=laneKey(provider.url),previous=lanes.get(key)||Promise.resolve();let release,startedWork=false;const mine=new Promise(resolve=>release=resolve),tail=previous.catch(()=>{}).then(()=>mine);lanes.set(key,tail);
  try{
    if(signal?.aborted)throw cancelled();let abort;await Promise.race([previous.catch(()=>{}),...(signal?[new Promise((_,reject)=>{abort=()=>reject(cancelled());signal.addEventListener('abort',abort,{once:true});})]:[])]).finally(()=>signal?.removeEventListener('abort',abort));
    if(signal?.aborted)throw cancelled();
    if(provider.config?.installDir&&provider.config?.pythonPath)await provider.start();
    const deadline=Date.now()+3600000;let lastNotice=0;
    while(true){if(signal?.aborted)throw cancelled();const queue=await provider.request('/queue');if(!(queue.queue_running?.length||queue.queue_pending?.length))break;if(Date.now()>deadline){const error=new ProviderError('ComfyUI已有任务长时间未结束，本次尚未提交','COMFY_LANE_TIMEOUT');error.beforeSubmission=true;throw error;}if(Date.now()-lastNotice>3000){lastNotice=Date.now();onProgress({state:'waiting',message:'等待当前 ComfyUI 实例已有任务完成；本步骤尚未提交'});}await sleep(500,signal);}
    startedWork=true;return await work();
  }catch(error){if(!startedWork){error.beforeSubmission=true;error.uncertain=false;}throw error;
  }finally{release();if(lanes.get(key)===tail)tail.finally(()=>{if(lanes.get(key)===tail)lanes.delete(key);});}
}
function cancelled(){const error=new ProviderError('等待 ComfyUI 调度时取消，本步骤尚未提交','CANCELLED');error.confirmed=true;error.beforeSubmission=true;return error;}
module.exports={inComfyLane,laneKey};
