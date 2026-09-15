'use strict';
// Run from the user's normal Windows launch context, not the background test context.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const {writeAtomic}=require('../app/providers/util.cjs');
const root=path.resolve(__dirname,'..');
async function main(){
  if(!process.argv.includes('--apply-config'))throw Error('Explicit --apply-config required');
  const report={at:new Date().toISOString(),ok:false,configurationSaved:false,generationVerified:false};let provider;
  const output=path.join(root,'testing-output/user-comfy-repair.json');await fs.mkdir(path.dirname(output),{recursive:true});
  try{
    const profile=path.join(process.env.APPDATA,'CreateMore'),file=path.join(profile,'providers.json');
    const original=await fs.readFile(file),config=JSON.parse(original);
    const installDir=path.join(process.env.LOCALAPPDATA,'Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI');
    const pythonPath=path.join(installDir,'.venv/Scripts/python.exe');
    const extra=path.join(process.env.APPDATA,'Comfy Desktop/instance-model-paths/inst-1787467970326.yaml');
    for(const item of [path.join(installDir,'main.py'),pythonPath,extra])await fs.access(item);
    const url=config.comfyui?.url||'http://127.0.0.1:8188';const parsed=new URL(url);
    if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.port!=='8188')throw Error('当前连接不是已核对的本机 8188，未替换配置');
    const backup=path.join(profile,'备份','providers-before-user-repair-'+Date.now()+'.json');await fs.mkdir(path.dirname(backup),{recursive:true});await fs.writeFile(backup,original,{flag:'wx'});
    const args=config.comfyui?.args?.length?config.comfyui.args:['--extra-model-paths-config',extra];
    config.comfyui={...config.comfyui,url,installDir,pythonPath,args};
    await writeAtomic(file,JSON.stringify(config,null,2));
    const saved=JSON.parse(await fs.readFile(file,'utf8'));if(saved.comfyui.installDir!==installDir||saved.comfyui.pythonPath!==pythonPath)throw Error('配置保存回读不一致');
    report.configurationSaved=true;report.backup=backup;report.configFile=file;report.beforeHash=crypto.createHash('sha256').update(original).digest('hex');
    const models=path.join(process.env.LOCALAPPDATA,'Comfy-Desktop/ComfyUI-Shared/models');
    const checks=[['main-image','diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors'],['image-encoder','text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors'],['image-vae','vae/qwen_image_vae.safetensors'],['lightning','loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors'],['angles','loras/qwen-image-edit-2511-multiple-angles-lora.safetensors']];
    report.files=[];for(const [id,relative] of checks){try{const s=await fs.stat(path.join(models,relative));report.files.push({id,exists:s.isFile(),bytes:s.size});}catch(e){if(e.code!=='ENOENT')throw e;report.files.push({id,exists:false});}}
    try{await fs.access(path.join(installDir,'custom_nodes/createmore_qwen_tts/__init__.py'));report.speechNodeFiles=true;}catch{report.speechNodeFiles=false;}
    await writeAtomic(output,JSON.stringify(report,null,2));
    provider=new ComfyProvider(config.comfyui);const before=await provider.status();report.reused=before.ready;
    await provider.start();const inspected=await provider.inspect();report.backend={ready:inspected.ready,url:provider.url,nodeCount:Object.keys(inspected.nodes||{}).length};
    report.speechNodes=Object.keys(inspected.nodes||{}).filter(name=>/CreateMore.*(Qwen|Camera)/i.test(name));report.ok=!!inspected.ready;
  }catch(error){report.error={message:error.message,code:error.code};process.exitCode=1;}
  finally{if(provider?.owned){try{report.cleanup=await provider.stopOwned();}catch(e){report.cleanup={stopped:false,error:e.message};}}report.finishedAt=new Date().toISOString();await writeAtomic(output,JSON.stringify(report,null,2));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
