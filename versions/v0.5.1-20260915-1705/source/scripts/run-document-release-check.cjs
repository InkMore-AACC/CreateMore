'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process');
async function main(){
  const root=path.resolve(__dirname,'..'),release=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0];
  const dataDir=path.join(release.directory,'.test-output','document-e2e-'+Date.now());
  const child=spawn(release.exe,['--e2e-test'],{env:{...process.env,CREATEMORE_DATA_DIR:dataDir},windowsHide:true,stdio:'pipe'});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Isolated test timeout'));},180000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve(code);});});
  const result=JSON.parse(await fs.readFile(path.join(release.directory,'.test-output/electron-e2e-latest.json'),'utf8'));
  if(code!==0||!result.ok){const report=JSON.parse(await fs.readFile(result.reportFile,'utf8'));throw new Error(JSON.stringify({code,...result,error:report.error,output}));}
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
main().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
