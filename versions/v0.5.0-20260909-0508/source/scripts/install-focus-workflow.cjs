'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const {WorkflowStore}=require('../app/providers/workflows.cjs');
const {recipes,authoredGui}=require('../app/providers/recipes.cjs');
async function main(){
  const root=path.resolve(__dirname,'..'),configFile=path.join(process.env.APPDATA,'CreateMore','providers.json'),config=JSON.parse(await fs.readFile(configFile,'utf8')).comfyui||{},provider=new ComfyProvider(config),recipe=recipes().find(item=>item.id==='tool-image-focus');
  if(!recipe)throw new Error('未找到聚焦工作流定义');const before=await provider.status();if(!before.ready)await provider.start();try{const {nodes}=await provider.inspect();await provider.validate(recipe.api,recipe.mapping);const store=new WorkflowStore(path.join(root,'resources','workflows','defaults')),saved=await store.save(recipe.id,{gui:authoredGui(recipe.api,nodes),api:recipe.api,mapping:recipe.mapping});
  const catalogFile=path.join(root,'resources','workflows','catalog.json'),catalog=JSON.parse(await fs.readFile(catalogFile,'utf8')),entry={id:recipe.id,version:saved.version,path:path.posix.join('defaults',recipe.id,'versions',saved.version),label:recipe.label,kind:recipe.kind,note:recipe.note,validated:'environment'};const index=catalog.findIndex(item=>item.id===recipe.id);if(index<0)catalog.push(entry);else catalog[index]=entry;catalog.sort((a,b)=>a.id.localeCompare(b.id));await fs.writeFile(catalogFile,JSON.stringify(catalog,null,2)+'\n');process.stdout.write(JSON.stringify({ok:true,id:recipe.id,version:saved.version,nodeCount:Object.keys(recipe.api).length,liveNodeRegistry:Object.keys(nodes).length})+'\n');}finally{if(!before.ready&&provider.owned)await provider.stopOwned();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
