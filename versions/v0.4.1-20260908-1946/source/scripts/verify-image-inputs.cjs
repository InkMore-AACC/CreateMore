'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {CreateMoreService}=require('../app/core/service.cjs');
async function main(){
  const root=path.resolve(__dirname,'..'),base=path.join(root,'testing-output','image-inputs-'+Date.now()),service=new CreateMoreService({appDir:root,dataDir:path.join(base,'profile')}),report={at:new Date().toISOString(),cases:[],ok:false};
  const write=()=>fs.writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));
  try{
    await service.init();await service.createProject(path.join(base,'验收工程'),'单图与双图编辑验收');const config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore/providers.json'),'utf8')).comfyui;await service.hub.configure({comfyui:config});
    const status=await service.hub.providers.comfyui.status();if(!status.ready||status.running||status.pending)throw Error('后台未就绪或繁忙，未提交');
    const images=['testing-output/qwen-images-1788862375264/portrait-source/713ff855-dacd-49d5-87ab-e767f7e5be86-image_00013_.png','dist/v0.4.0-20260908095022/Windows-app/.test-output/user-local-1788861121464/验收工程/主画布/image/generation-12b3fe71-bfaf-4f06-910e-f50d3a287222/1/c119a837-2a4f-454d-b8b8-14bdc046ceae-image_00010_.png'];
    const refs=[];for(const file of images){await service.importAsset(path.join(root,file),{copy:true});refs.push(service.current.state.nodes.at(-1));}
    for(const count of [1,2]){
      const n=service.newNode('image',{title:count+' 张参考指令编辑',source:'本地 ComfyUI',workflowId:'default:image-qwen-edit-'+count,prompt:count===1?'保持人物身份、五官、发型、姿势和房间，只把灰色上衣改成深蓝色。':'保持第一张图片人物的身份、五官、发型和灰色衣服，让她用手拿着第二张图片中的青绿色陶杯。自然写实摄影。',parameters:{seed:809381,steps:4},count:1});service.current.state.nodes.push(n);
      for(const [i,ref]of refs.slice(0,count).entries())service.current.state.edges.push({id:'ref-'+n.id+'-'+i,from:ref.id,to:n.id,inputId:i?'image2':'image'});
      const task=await service.submitNode(n.id),item={count,taskId:task.id};report.cases.push(item);await write();console.log(JSON.stringify(item));
      const until=Date.now()+20*60*1000;let final;while(Date.now()<until){final=service.queue.get(task.id);if(['succeeded','failed','cancelled','unknown'].includes(final.state))break;await new Promise(r=>setTimeout(r,500));}
      item.state=final.state;item.error=final.error;item.outputs=final.result?.outputs;await write();assert.equal(final.state,'succeeded');assert.ok(item.outputs?.length);
    }
    await service.saveCanvas();report.ok=true;
  }catch(e){report.error=e.message;process.exitCode=1;}
  finally{await write();await service.close();console.log('REPORT '+path.join(base,'report.json'));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
