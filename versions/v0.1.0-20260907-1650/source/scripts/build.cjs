'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
  const {packager}=await import('@electron/packager'),root=path.resolve(__dirname,'..'),pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')),stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14),outputParent=path.join(root,'dist','build-'+stamp);
  const electronPackage=require('electron/package.json'),checksums=require('electron/checksums.json');
  if(electronPackage.version!==pkg.devDependencies.electron||!/^[a-f0-9]{64}$/.test(checksums[`electron-v${electronPackage.version}-win32-x64.zip`]||''))throw new Error('本机 Electron 版本或官方包内校验表与锁定版本不匹配');
  // The installed official Electron package ships the checksums; validate cached ZIPs without fetching the same checksum file on every build.
  const outputs=await packager({dir:root,out:outputParent,name:'CreateMore',platform:'win32',arch:'x64',electronVersion:electronPackage.version,download:{checksums},overwrite:false,asar:false,prune:true,ignore:[/^\/(?:dist|\.runtime|\.test-output|testing-output|chat-image-probe|prototype|CreateMore|docs|tests|scripts|examples|resources|\.git)(?:\/|$)/,/^\/app\/providers\/(?:.*probe.*|live-recipes)\.cjs$/],win32metadata:{CompanyName:'CreateMore',FileDescription:'CreateMore 本地创作画布',ProductName:'CreateMore'}});
  const releases=[];
  for(const output of outputs){
    // Only newly created packaging output is renamed. Existing releases/resources stay untouched.
    if(!path.resolve(output).startsWith(path.resolve(outputParent)+path.sep))throw new Error('打包输出越界');
    const destination=path.join(root,'dist',`CreateMore-${pkg.version}-${stamp}-win32-x64`);try{await fs.access(destination);throw new Error('交付目录已存在，拒绝覆盖');}catch(error){if(error.code!=='ENOENT')throw error;}
    await fs.rename(output,destination);
    for(const entry of await fs.readdir(path.join(root,'resources'),{withFileTypes:true})){if(entry.name==='.trash')continue;await fs.cp(path.join(root,'resources',entry.name),path.join(destination,'resources',entry.name),{recursive:true,errorOnExist:true,force:false,filter:file=>!file.split(path.sep).includes('.trash')});}
    await fs.cp(path.join(root,'examples'),path.join(destination,'examples'),{recursive:true,errorOnExist:true,force:false});
    await fs.mkdir(path.join(destination,'docs'),{recursive:true});for(const file of ['使用说明.md','实施进度与待确认.md','验收与审核记录.md','本地功能接入清单.md','生成接入验证记录.md','LAN验证记录.md'])await fs.copyFile(path.join(root,'docs',file),path.join(destination,'docs',file));
    await fs.copyFile(path.join(root,'README.md'),path.join(destination,'README.md'));
    const exe=path.join(destination,'CreateMore.exe'),bytes=await fs.readFile(exe);releases.push({directory:destination,exe,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),version:pkg.version,createdAt:new Date().toISOString()});
  }
  const manifest=path.join(root,'dist','latest-build.json');await fs.writeFile(manifest,JSON.stringify({releases},null,2));process.stdout.write(JSON.stringify({manifest,releases},null,2)+'\n');
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
