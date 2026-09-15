'use strict';
// Read-only reproduction in the shipped Electron runtime. Never prints credentials.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),release=JSON.parse(fs.readFileSync(path.join(root,'dist/latest-build.json'),'utf8')).releases[0];
if(process.argv.includes('--disk-only')){
  const file=path.join(process.env.APPDATA,'CreateMore/providers.json'),bytes=fs.readFileSync(file),c=JSON.parse(bytes).comfyui||{};
  const report={at:new Date().toISOString(),file,bytes:bytes.length,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),mtime:fs.statSync(file).mtime.toISOString(),comfyui:{url:c.url,installDir:c.installDir,pythonPath:c.pythonPath,args:c.args}};
  fs.mkdirSync(path.join(root,'testing-output'),{recursive:true});fs.writeFileSync(path.join(root,'testing-output/user-launch-config.json'),JSON.stringify(report,null,2));
}else if(!process.argv.includes('--child')){
  process.stdout.write(cp.execFileSync(release.exe,[__filename,'--child'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,encoding:'utf8'}));
}else{
  const {ProviderHub}=require(path.join(release.directory,'resources/app/app/providers'));
  const hub=new ProviderHub({dataDir:path.join(process.env.APPDATA,'CreateMore')});
  hub.ready.then(async()=>{const c=hub.publicConfig().comfyui||{};console.log(JSON.stringify({runtime:process.versions.electron,loadError:hub.loadError,url:c.url,installDir:c.installDir,pythonPath:c.pythonPath,args:c.args}));await hub.close();});
}
