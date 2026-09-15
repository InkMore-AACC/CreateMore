'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');
async function main(){const root=path.resolve(__dirname,'..'),release=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0];
  const config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore/providers.json'),'utf8'));if(!config.comfyui?.installDir||!config.comfyui?.pythonPath)throw Error('用户实际启动配置仍不完整');
  const data=path.join(release.directory,'.test-output','user-local-'+Date.now());await fs.mkdir(data,{recursive:true});await fs.writeFile(path.join(data,'providers.json'),JSON.stringify({comfyui:config.comfyui},null,2));
  const reuse=process.argv.includes('--reuse-existing-comfy');
  const reportName=reuse?'background-local-check-location.json':'user-local-check-location.json';
  await fs.writeFile(path.join(root,'testing-output',reportName),JSON.stringify({data,exe:release.exe,at:new Date().toISOString(),launch:reuse?'background-reusing-user-backend':'user'},null,2));
  const child=cp.spawn(release.exe,['--production-local-check','--acceptance-assets='+path.join(root,'AAA'),...(reuse?['--reuse-existing-comfy']:[])],{env:{...process.env,CREATEMORE_DATA_DIR:data},windowsHide:true,stdio:'inherit'});
  child.once('error',e=>{console.error(e.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code||0;});
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
