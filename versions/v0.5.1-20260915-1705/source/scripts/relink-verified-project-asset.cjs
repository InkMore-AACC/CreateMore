'use strict';
const path=require('node:path');
const {ProjectStore}=require('../app/core/storage.cjs');
async function main(){
  const [projectDir,canvasId,assetId,newFile]=process.argv.slice(2);if(!projectDir||!canvasId||!assetId||!newFile)throw new Error('用法：node relink-verified-project-asset.cjs <工程目录> <画布ID> <素材ID> <新文件>');
  const store=new ProjectStore({appDir:path.resolve(__dirname,'..'),dataDir:path.join(path.resolve(__dirname,'..'),'.test-output','relink-support')});await store.openProject(projectDir);const result=await store.relinkAsset(projectDir,canvasId,assetId,newFile,{batch:false});process.stdout.write(JSON.stringify({updated:result.updated,ambiguous:result.ambiguous,missing:result.missing,verifiedByStoredHash:true},null,2)+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
