'use strict';
// Explicit, isolated acceptance through the same service/queue used by the canvas.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {CreateMoreService}=require('../app/core/service.cjs');
const {writeAtomic}=require('../app/providers/util.cjs');
async function main(){
  if(!process.argv.includes('--run-local'))throw new Error('需要 --run-local 明确启用本机生成');
  const root=path.resolve(__dirname,'..'),base=path.join(root,'testing-output','local-cards-'+Date.now());
  const config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore','providers.json'),'utf8')).comfyui;
  const service=new CreateMoreService({appDir:root,dataDir:path.join(base,'profile')});
  const report={kind:'product-service-card-and-tool-real-output',base,startedAt:new Date().toISOString(),cases:[],ok:false};
  const save=()=>writeAtomic(path.join(base,'report.json'),JSON.stringify(report,null,2));
  async function settle(task,name){
    const began=Date.now();console.log(JSON.stringify({starting:name,taskId:task.id}));
    for(;;){const current=service.queue.get(task.id);if(['succeeded','failed','unknown','cancelled'].includes(current.state)){
      const nodes=service.current.state.nodes.filter(n=>n.taskId===task.id||n.originTaskId===task.id||n.id===current.snapshot?.nodeId);
      const assetIds=[...new Set(nodes.flatMap(n=>n.outputAssets||[n.assetId]).filter(Boolean))];
      const outputs=[];for(const id of assetIds){const file=await service.assetPath(id),bytes=await fs.readFile(file);let probe;
        if(!['.txt','.json'].includes(path.extname(file)))probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,size:stream=codec_type,width,height,sample_rate','-of','json',file],{encoding:'utf8',windowsHide:true}));
        outputs.push({id,path:file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),probe});}
      const item={name,taskId:task.id,state:current.state,error:current.error,message:current.message,seconds:(Date.now()-began)/1000,nodeIds:nodes.map(n=>n.id),outputs};
      report.cases.push(item);await save();console.log(JSON.stringify(item));assert.equal(current.state,'succeeded',name+': '+JSON.stringify(current.error||current.message));assert.ok(outputs.length,name+' 必须保存文件并回到结果卡片');assert.ok(outputs.every(o=>o.bytes>0));return nodes[0];
    }if(Date.now()-began>30*60*1000)throw new Error(name+' 状态超过等待上限；保留原任务，不重交');await new Promise(r=>setTimeout(r,500));}
  }
  async function card(name,type,workflowId,fields={}){if(process.argv.includes('--defaults')&&['image','video','audio'].includes(type))fields.parameters={seed:fields.parameters?.seed||80921};const node=service.newNode(type,{title:name,source:'本地 ComfyUI',workflowId:'default:'+workflowId,...fields});service.current.state.nodes.push(node);service.current.dirty=true;service.current.revision++;await service.saveCanvas();return settle(await service.submitNode(node.id),name);}
  try{
    await service.init();await service.createProject(path.join(base,'验收工程'),'本地生成验收');await service.hub.configure({comfyui:config});
    const p=service.hub.providers.comfyui,status=await p.status();if(status.ready&&(status.running||status.pending))throw new Error('发现现有任务，未启动验收');
    await p.start();report.backend={url:p.url,owned:!!p.owned,pid:p.owned?.pid};await save();
    const info=await p.inspect();await writeAtomic(path.join(base,'node-inventory.json'),JSON.stringify(info.nodes,null,2));report.nodeCount=Object.keys(info.nodes).length;
    const image=await card('图片生成','image','image-zimage',{count:1,prompt:'A matte teal ceramic cup on a warm gray table, soft natural side light, no letters.',parameters:{width:256,height:256,steps:4,seed:80911},ratio:'1:1',quality:'256px'});
    for(const [tool,parameters]of [['尺寸调整',{width:128,height:128}],['裁切',{width:128,height:128,x:32,y:32}],['高清',{}],['本地反推',{max_length:64}]])await settle(await service.submitTool({nodeId:image.id,tool,parameters:{provider:'comfyui',...parameters}}),tool);
    await card('本地文字生成','text','text-qwen3',{prompt:'请用一句中文描述青绿色陶杯。只输出一句话。',parameters:{max_length:64}});
    const edit=service.newNode('image',{title:'图生图',source:'本地 ComfyUI',workflowId:'default:image-zimage-edit',prompt:'A teal ceramic cup with a small yellow flower beside it, soft studio light.',parameters:{steps:4,seed:80912,denoise:0.5}});
    service.current.state.nodes.push(edit);service.current.state.edges.push({id:crypto.randomUUID(),from:image.id,to:edit.id});service.current.revision++;service.current.dirty=true;await service.saveCanvas();await settle(await service.submitNode(edit.id),'图生图');
    if(!process.argv.includes('--skip-video')){
      await card('文生视频含音轨','video','video-h3-turbo',{prompt:'A teal ceramic cup on a table, camera slowly moves closer. Quiet room tone, no speech.',parameters:{width:256,height:256,length:22,steps:4,seed:80913},ratio:'1:1',quality:'256px'});
      const video=service.newNode('video',{title:'图生视频',source:'本地 ComfyUI',workflowId:'default:video-h3-i2v',prompt:'A teal ceramic cup, slow camera push in, quiet ambient room tone.',parameters:{width:256,height:256,length:22,steps:4,seed:80914}});if(process.argv.includes('--defaults'))video.parameters={seed:80924};service.current.state.nodes.push(video);service.current.state.edges.push({id:crypto.randomUUID(),from:image.id,to:video.id});service.current.revision++;service.current.dirty=true;await service.saveCanvas();await settle(await service.submitNode(video.id),'图生视频');
      await card('环境音生成','audio','audio-h3-ambience',{prompt:'Quiet garden ambience, soft rustling leaves and distant birds, no speech or music.',parameters:{width:256,height:256,length:22,steps:4,seed:80915}});
    }
    report.ok=true;report.projectDir=service.current.projectDir;report.completedAt=new Date().toISOString();await service.saveCanvas();
  }catch(e){report.error={message:e.message,code:e.code,stack:e.stack};process.exitCode=1;console.error(e);}
  finally{await save();console.log('REPORT '+path.join(base,'report.json'));await service.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
