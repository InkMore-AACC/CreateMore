'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const {WorkflowStore}=require('../app/providers/workflows.cjs');
const {authoredGui}=require('../app/providers/recipes.cjs');
const {speechRecipes,imageRecipe}=require('../app/providers/specialized-recipes.cjs');
const {writeAtomic}=require('../app/providers/util.cjs');
async function main(){
  if(!process.argv.includes('--install'))throw Error('Explicit --install required');
  const root=path.resolve(__dirname,'..'),config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore/providers.json'),'utf8')).comfyui;
  const provider=new ComfyProvider({...config,url:'http://127.0.0.1:8189'});
  try{
    const ready=(await provider.status()).ready;if(ready&&!process.argv.includes('--reuse'))throw Error('8189 already occupied; leave it untouched');
    if(!ready)await provider.start();const {nodes}=await provider.inspect();
    const recipes=speechRecipes(nodes);
    if(process.argv.includes('--images'))recipes.push(...[['portrait',false,false,false,'人像质感'],['angles',true,false,false,'多角度'],['lighting',false,false,false,'打光'],['grid',true,true,false,'九宫格'],['mark',false,false,true,'区域编辑']].map(([id,angle,grid,mask,label])=>({...imageRecipe('tool-qwen-'+id,angle,grid,mask),label:'图片 · '+label,note:grid?'九次真实采样后拼成 3×3；并非一次生成九格。':mask?'原图、标注和遮罩分离；遮罩外合成回原始像素。':'Qwen Image Edit 2511 专用图像编辑路径；按实际素材验收。'})));
    const store=new WorkflowStore(path.join(root,'resources/workflows/defaults')),file=path.join(root,'resources/workflows/catalog.json'),catalog=JSON.parse(await fs.readFile(file,'utf8'));
    for(const recipe of recipes){
      await provider.validate(recipe.api);
      const result=await store.save(recipe.id,{gui:authoredGui(recipe.api,nodes),api:recipe.api,mapping:recipe.mapping});
      const entry={id:recipe.id,version:result.version,path:'defaults/'+recipe.id+'/versions/'+result.version,label:recipe.label,kind:recipe.kind,note:recipe.note,validated:'environment'};
      const index=catalog.findIndex(r=>r.id===entry.id);if(index<0)catalog.push(entry);else catalog[index]=entry;
      console.log(JSON.stringify(entry));
    }
    await writeAtomic(file,JSON.stringify(catalog,null,2));
  }finally{if(provider.owned)console.log(await provider.stopOwned());}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
