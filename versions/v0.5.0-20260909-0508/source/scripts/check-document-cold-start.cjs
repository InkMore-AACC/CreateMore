'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
async function main(){
  const root=path.resolve(__dirname,'..'),release=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0];
  const file=path.join(release.directory,'examples/新工程示例/主画布/画布.createmore');
  const dataDir=path.join(release.directory,'.test-output','cold-document-'+Date.now());
  const child=spawn(release.exe,['--document-smoke-test',file],{env:{...process.env,CREATEMORE_DATA_DIR:dataDir},windowsHide:true,stdio:'pipe'});
  let output='';child.stderr.on('data',b=>output+=b);
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Cold open timed out: '+output));},60000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  if(code!==0)throw new Error('Cold open failed '+code+' '+output);
  const report=JSON.parse(await fs.readFile(path.join(release.directory,'.test-output/document-cold-start.json'),'utf8'));
  if(!report.ok||report.requested!==file)throw new Error('Cold start readback mismatch');
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
main().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
