'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const {WorkflowStore}=require('../app/providers/workflows.cjs');
async function main(){
  const root=path.resolve(__dirname,'..'),config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore','providers.json'),'utf8')).comfyui||{},provider=new ComfyProvider(config),source=path.join(root,'AAA','Codex 图像 2026年8月29日 16_57_41.png'),outputDir=path.join(root,'testing-output','focus-live-'+Date.now()),before=await provider.status();if(!before.ready)await provider.start();
  try{const workflow=await new WorkflowStore(path.join(root,'resources','workflows','defaults')).read('tool-image-focus'),result=await provider.run({kind:'image',workflow,references:[{path:source,type:'image'}],parameters:{x:0,y:0,cropWidth:256,cropHeight:256,outputWidth:1024,outputHeight:1024},timeoutMs:600000},{outputDir,onProgress:event=>{if(['submitted','saving'].includes(event.state))process.stdout.write(JSON.stringify({state:event.state,remoteId:event.remoteId})+'\n');}}),file=result.outputs[0].path,bytes=await fs.readFile(file),report={ok:true,workflowId:'tool-image-focus',source,output:file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),remoteId:result.remoteId};await fs.writeFile(path.join(outputDir,'report.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+'\n');}finally{if(!before.ready&&provider.owned)await provider.stopOwned();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
