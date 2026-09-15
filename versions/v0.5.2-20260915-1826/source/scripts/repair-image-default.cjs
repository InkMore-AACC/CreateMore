'use strict';
// Repairs only the positively identified invalid default in a new candidate build.
const fs=require('node:fs/promises'),path=require('node:path');
async function main(){
  const root=path.resolve(__dirname,'..');const release=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0];
  const target=path.join(release.directory,'resources/workflows/defaults/image-zimage');
  if(!target.startsWith(path.join(root,'dist')+path.sep))throw Error('候选构建目录越界');
  const currentFile=path.join(target,'current.json'),previous=JSON.parse(await fs.readFile(currentFile,'utf8'));
  if(previous.version!=='767dd9926c5495117c6bf38c')throw Error('不是已确认的错误版本，未自动替换');
  const {WorkflowStore}=require('../app/providers/workflows.cjs');const store=new WorkflowStore(path.dirname(target)),old=await store.read('image-zimage');
  if(old.api['41']?.class_type!=='CLIPLoader'||!old.mapping.outputs.some(o=>String(o.nodeId)==='41'&&o.key==='images'))throw Error('故障特征不匹配');
  const source=new WorkflowStore(path.join(root,'resources/workflows/defaults')),correct=await source.read('image-zimage');
  // All old immutable version folders remain intact; keep a named recovery record as well.
  await fs.writeFile(path.join(target,'recovery-before-image-default.json'),JSON.stringify({at:new Date().toISOString(),previous,reason:'Image default contained H3 video graph and mapped CLIPLoader as image output'},null,2),{flag:'wx'});
  const result=await store.save('image-zimage',correct);
  console.log(JSON.stringify({candidate:release.directory,previous:previous.version,repaired:result.version,oldVersionsPreserved:true}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
