'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
  const {packager}=await import('@electron/packager'),root=path.resolve(__dirname,'..'),pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')),stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14),outputParent=path.join(root,'dist','build-'+stamp);
  const electronPackage=require('electron/package.json'),checksums=require('electron/checksums.json');
  let previous;try{previous=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0].directory;}catch(e){if(e.code!=='ENOENT')throw e;}
  const previousArg=process.argv.find(arg=>arg.startsWith('--previous='));if(previousArg)previous=path.resolve(previousArg.slice('--previous='.length));
  if(previous&&!path.resolve(previous).startsWith(path.join(root,'dist')+path.sep))throw new Error('旧版本资源目录越界');
  if(electronPackage.version!==pkg.devDependencies.electron||!/^[a-f0-9]{64}$/.test(checksums[`electron-v${electronPackage.version}-win32-x64.zip`]||''))throw new Error('本机 Electron 版本或官方包内校验表与锁定版本不匹配');
  const icon=path.join(root,'app/ui/assets/brand/oo-logo.ico');await fs.access(icon);
  // The installed official Electron package ships the checksums; validate cached ZIPs without fetching the same checksum file on every build.
  const outputs=await packager({dir:root,out:outputParent,name:'CreateMore',platform:'win32',arch:'x64',electronVersion:electronPackage.version,download:{checksums},icon,overwrite:false,asar:false,prune:true,ignore:[/^\/(?:dist|\.runtime|\.test-output|testing-output|chat-image-probe|prototype|CreateMore|docs|tests|scripts|examples|resources|\.git)(?:\/|$)/,/\.lnk$/i,/^\/app\/providers\/(?:.*probe.*|live-recipes)\.cjs$/],win32metadata:{CompanyName:'CreateMore',FileDescription:'CreateMore 本地创作画布',ProductName:'CreateMore'}});
  const releases=[];
  for(const output of outputs){
    // Only newly created packaging output is renamed. Existing releases/resources stay untouched.
    if(!path.resolve(output).startsWith(path.resolve(outputParent)+path.sep))throw new Error('打包输出越界');
    const destination=path.join(root,'dist',`v${pkg.version}-${stamp}`,'Windows-app');try{await fs.access(destination);throw new Error('交付目录已存在，拒绝覆盖');}catch(error){if(error.code!=='ENOENT')throw error;}
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.rename(output,destination);
    for(const entry of await fs.readdir(path.join(root,'resources'),{withFileTypes:true})){if(entry.name==='.trash')continue;await fs.cp(path.join(root,'resources',entry.name),path.join(destination,'resources',entry.name),{recursive:true,errorOnExist:true,force:false,filter:file=>!file.split(path.sep).includes('.trash')});}
    let resourceUpgrade;if(previous){const baseline=JSON.parse(await fs.readFile(path.join(root,'resources/builtin-upgrade-base.json'),'utf8'));resourceUpgrade=await require('../app/core/resource-upgrade.cjs').mergePreviousResources(path.join(previous,'resources'),path.join(destination,'resources'),baseline);}
    const {ProjectStore}=require('../app/core/storage.cjs'),store=new ProjectStore({dataDir:path.join(outputParent,'example-profile')}),demo=path.join(destination,'examples','新工程示例');
    await store.createProject(demo,'新工程示例');await store.createCanvas(demo,'主画布',{version:5,nodes:[],edges:[],groups:[],assets:[],view:{x:60,y:130,k:1},seq:0,settings:{saveMinutes:5,maxSnapshots:100}});
    await fs.copyFile(path.join(root,'docs/工程文件说明.md'),path.join(destination,'工程文件说明.md'));
    await fs.mkdir(path.join(destination,'docs'),{recursive:true});for(const file of ['重构-已确认要求.md','重构-LibTV交互对照表.md','重构-问题与验收表.md','v0.4.1-重构阶段交付.md','当前执行约定与工作流复核.md','本地专用工作流实施记录-20260908.md','v0.3.0-本轮修复与待确认.md','LibTV交互补测-2026-09-08.md','使用说明.md','实施进度与待确认.md','验收与审核记录.md','本地功能接入清单.md','生成接入验证记录.md','LAN验证记录.md'])await fs.copyFile(path.join(root,'docs',file),path.join(destination,'docs',file));
    await fs.copyFile(path.join(root,'README.md'),path.join(destination,'README.md'));
    const exe=path.join(destination,'CreateMore.exe'),bytes=await fs.readFile(exe);releases.push({directory:destination,exe,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),version:pkg.version,createdAt:new Date().toISOString(),preservedResourcesFrom:previous||null,resourceUpgrade});
  }
  const current=releases[0],relativeExe=path.relative(root,current.exe);
  if(!process.argv.includes('--no-launcher')){
  require('node:child_process').execFileSync(require('electron'),[path.join(root,'scripts/create-launch-shortcut.cjs'),current.exe,path.join(root,'启动 CreateMore.lnk')],{windowsHide:true});
  await fs.writeFile(path.join(root,'启动 CreateMore.cmd'),'@echo off\r\nset "CREATEMORE_LAUNCH_EXE=%~dp0'+relativeExe+'"\r\nif not exist "%CREATEMORE_LAUNCH_EXE%" (\r\n  echo CreateMore release was not found. Please see README.md.\r\n  pause\r\n  exit /b 1\r\n)\r\nstart "" "%CREATEMORE_LAUNCH_EXE%"\r\n');
  }
  const manifest=path.join(root,'dist','latest-build.json');await fs.writeFile(manifest,JSON.stringify({releases},null,2));
  process.stdout.write(JSON.stringify({manifest,releases},null,2)+'\n');
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
