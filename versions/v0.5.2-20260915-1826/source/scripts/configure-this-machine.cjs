'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {ProviderHub}=require('../app/providers');
async function main(){
  if(!process.argv.includes('--configure'))throw new Error('仅在明确配置本机时运行：--configure；不会安装或修改 ComfyUI/Codex。');
  const dataDir=path.join(process.env.APPDATA,'CreateMore');
  try{await fs.access(path.join(dataDir,'providers.json'));throw new Error('已有正式连接配置，已保留。请在软件连接页面中修改。');}catch(error){if(error.code!=='ENOENT')throw error;}
  const installDir=path.join(process.env.LOCALAPPDATA,'Comfy-Desktop','ComfyUI-Installs','ComfyUI','ComfyUI'),pythonPath=path.join(installDir,'.venv','Scripts','python.exe'),modelPaths=path.join(process.env.APPDATA,'Comfy Desktop','instance-model-paths','inst-1787467970326.yaml');
  for(const file of [path.join(installDir,'main.py'),pythonPath,modelPaths])await fs.access(file);
  const server=await fs.readFile(path.join(installDir,'server.py'),'utf8'),targetedInterrupt=/prompt_id = json_data\.get\('prompt_id'\)/.test(server)&&/if item\[1\] == prompt_id/.test(server);
  const hub=new ProviderHub({appDir:path.resolve(__dirname,'..'),dataDir});
  await hub.configure({comfyui:{url:'http://127.0.0.1:8188',installDir,pythonPath,args:['--extra-model-paths-config',modelPaths],targetedInterrupt},codex:{}});
  const statuses=await hub.status();await hub.close();
  process.stdout.write(JSON.stringify({dataDir,configured:true,comfyuiReady:statuses.comfyui.ready,codexReady:statuses.codex.ready,targetedInterrupt,changedGlobalCodexConfig:false,changedComfyEnvironment:false},null,2)+'\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
