'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {WorkflowStore}=require('../app/providers/workflows.cjs');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
async function main(){
  const root=path.resolve(__dirname,'..'),release=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0];
  const provider=new ComfyProvider(),nodes=await provider.request('/object_info');provider.request=async route=>{if(route!=='/object_info')throw Error('只读审计禁止其他请求');return nodes;};
  const report={at:new Date().toISOString(),scope:'Read-only schema checks, not generation proof',candidate:release.directory,nodeCount:Object.keys(nodes).length,cases:[]};
  for(const [name,base]of [['source',root],['candidate',release.directory]]){
    const folder=path.join(base,'resources/workflows/defaults'),store=new WorkflowStore(folder);
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){if(!entry.isDirectory())continue;
      const item={scope:name,id:entry.name};try{const bundle=await store.read(entry.name);await provider.validate(bundle.api,bundle.mapping);item.valid=true;item.nodes=Object.keys(bundle.api).length;item.outputs=bundle.mapping.outputs.map(o=>({node:o.nodeId,key:o.key,type:o.type}));}catch(e){item.valid=false;item.error=e.message;item.details=e.details;}report.cases.push(item);
    }
  }
  const file=path.join(root,'testing-output/workflow-schema-audit.json');await fs.writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify({file,total:report.cases.length,failures:report.cases.filter(c=>!c.valid)},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
