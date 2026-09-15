'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const {WorkflowStore}=require('../app/providers/workflows.cjs');
const {imageRecipe}=require('../app/providers/specialized-recipes.cjs');
const {authoredGui}=require('../app/providers/recipes.cjs');
const {writeAtomic}=require('../app/providers/util.cjs');
async function main(){
  const root=path.resolve(__dirname,'..'),provider=new ComfyProvider(),nodes=await provider.request('/object_info');
  const store=new WorkflowStore(path.join(root,'resources/workflows/defaults')),file=path.join(root,'resources/workflows/catalog.json'),catalog=JSON.parse(await fs.readFile(file,'utf8'));
  for(const count of [1,2]){
    const id='image-qwen-edit-'+count;if(catalog.some(r=>r.id===id))throw Error('已存在该工作流，不覆盖：'+id);
    const recipe=imageRecipe(id);
    if(count===2){recipe.api['20']={class_type:'LoadImage',inputs:{image:'reference-2.png'}};recipe.api['9'].inputs.image2=['20',0];recipe.api['10'].inputs.image2=['20',0];recipe.mapping.inputs.push({id:'image2',label:'第二张参考图',source:'reference',nodeId:'20',input:'image',required:true,mediaType:'image',index:1});}
    await provider.validate(recipe.api,recipe.mapping);const bundle={api:recipe.api,mapping:recipe.mapping,gui:authoredGui(recipe.api,nodes)},result=await store.save(id,bundle);
    catalog.push({id,version:result.version,path:'defaults/'+id+'/versions/'+result.version,label:'图像指令编辑 · Qwen · '+count+' 张参考',kind:'image',note:'Qwen Image Edit 2511 图像条件编辑；需要恰好 '+count+' 张参考。不是通用加噪重绘。',validated:'environment'});
  }
  await writeAtomic(file,JSON.stringify(catalog,null,2));console.log('已新增单图和双图指令编辑工作流，原工作流保留。');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
