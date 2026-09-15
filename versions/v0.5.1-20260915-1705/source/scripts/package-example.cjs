'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {ProjectStore}=require('../app/core/storage.cjs');
async function main(){const root=path.resolve(__dirname,'..'),reportFile=process.argv[2];if(!reportFile)throw new Error('请指定真实生成验收报告');const report=JSON.parse(await fs.readFile(path.resolve(reportFile),'utf8'));if(!report.ok||report.kind!=='actual-model-output-through-product-service')throw new Error('不是通过实际生成的产品服务验收报告');const destination=path.join(root,'examples','实机验收工程'),store=new ProjectStore({dataDir:path.join(root,'.test-output','example-packaging')});const result=await store.packageProject(report.projectDir,destination);process.stdout.write(JSON.stringify({destination,source:report.projectDir,sourceUnchanged:true,ownerRemapped:true,result},null,2)+'\n');}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
