'use strict';
// Creates a new version only; never overwrites a previous version or edits the working software.
const fs=require('node:fs/promises'),native=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const repo=__dirname,source=path.resolve(repo,'../..');
const sha=async file=>{const h=crypto.createHash('sha256');for await(const chunk of native.createReadStream(file))h.update(chunk);return h.digest('hex');};
const inside=(parent,child)=>path.resolve(child).startsWith(path.resolve(parent)+path.sep);
async function copyTree(from,to,manifest,base,relative='',includeDependencies=false){
  const stat=await fs.lstat(from);if(stat.isSymbolicLink())throw new Error('Refusing linked backup input: '+from);
  if(stat.isDirectory()){
    await fs.mkdir(to,{recursive:true});
    for(const entry of await fs.readdir(from,{withFileTypes:true})){
      if(['.git','.test-output','.validation','.trash'].includes(entry.name)||entry.name==='node_modules'&&!includeDependencies)continue;
      if(relative.replaceAll('\\','/')==='app/providers'&&/(probe|live-recipes)/.test(entry.name))continue;
      await copyTree(path.join(from,entry.name),path.join(to,entry.name),manifest,base,path.join(relative,entry.name),includeDependencies);
    }
  }else if(stat.isFile()){
    await fs.mkdir(path.dirname(to),{recursive:true});const before=await sha(from);
    await fs.copyFile(from,to,native.constants.COPYFILE_EXCL);
    if(before!==await sha(to)||before!==await sha(from))throw new Error('Backup differs or source changed: '+relative);
    manifest.push({path:path.relative(base,to).replaceAll('\\','/'),size:stat.size,sha256:before});
  }
}
async function main(){
  const [version,projectDir]=process.argv.slice(2);if(!/^v\d+\.\d+\.\d+-\d{8}-\d{4}$/.test(version||''))throw new Error('Usage: node backup-version.cjs v0.1.0-YYYYMMDD-HHMM [current-project-directory]');
  if(path.resolve(source)!==path.resolve('C:/Users/O.oInkMore/Desktop/CreateMore'))throw new Error('Source location must be checked before using this machine-specific backup helper');
  const destination=path.join(repo,'versions',version);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.mkdir(destination);
  const manifest=[],sourceDir=path.join(destination,'source');await fs.mkdir(sourceDir);
  for(const entry of ['app','docs','resources','scripts','tests','prototype','examples','package.json','package-lock.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore'])await copyTree(path.join(source,entry),path.join(sourceDir,entry),manifest,destination,entry);
  const metadata={version,createdAt:new Date().toISOString(),scope:'software source, approved V5 sketch, default workflows, tests, docs and generated demonstration project; excludes credentials, runtime profiles and private working projects',files:manifest};
  await fs.writeFile(path.join(destination,'source-manifest.json'),JSON.stringify(metadata,null,2),{flag:'wx'});
  const localDir=path.join(destination,'local-only');await fs.mkdir(localDir);const localFiles=[];
  const release=JSON.parse(await fs.readFile(path.join(source,'dist','latest-build.json'),'utf8')).releases[0];if(!inside(path.join(source,'dist'),release.directory))throw new Error('Invalid release location');
  await copyTree(release.directory,path.join(localDir,'Windows-app'),localFiles,localDir,'',true);
  let canvas=null;
  if(projectDir){
    const project=path.resolve(projectDir);if(inside(project,destination)||inside(destination,project)||project===source)throw new Error('Project/source backup locations overlap');
    const {ProjectStore}=require(path.join(source,'app/core/storage.cjs'));const store=new ProjectStore({dataDir:path.join(localDir,'packaging-state'),appDir:source});
    await store.openProject(project);
    await copyTree(project,path.join(localDir,'current-project-original'),localFiles,localDir);
    await store.packageProject(project,path.join(localDir,'current-project-portable'));
    const packaged=await store.openProject(path.join(localDir,'current-project-portable'));let nodes=0,assets=0;
    for(const item of packaged.canvases){const loaded=await store.loadCanvas(path.join(localDir,'current-project-portable'),item.id);nodes+=loaded.state.nodes.length;for(const asset of loaded.state.assets){const file=await store.resolveAssetPath(path.join(localDir,'current-project-portable'),item.id,asset);if(asset.sha256&&await sha(file)!==asset.sha256)throw new Error('Portable project asset verification failed');assets++;}}
    canvas={source:project,canvases:packaged.canvases.length,nodes,assets,portableAssetsVerified:true};
  }
  await fs.writeFile(path.join(localDir,'local-manifest.json'),JSON.stringify({version,releaseSource:release.directory,canvas,files:localFiles},null,2),{flag:'wx'});
  await fs.writeFile(path.join(destination,'打开备份软件.cmd'),'@echo off\r\nstart "" "%~dp0local-only\\Windows-app\\CreateMore.exe"\r\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({version,destination,sourceFiles:manifest.length,sourceBytes:manifest.reduce((n,x)=>n+x.size,0),localFiles:localFiles.length,canvas,verified:true},null,2)+'\n');
}
module.exports={copyTree,sha};
if(require.main===module)main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
