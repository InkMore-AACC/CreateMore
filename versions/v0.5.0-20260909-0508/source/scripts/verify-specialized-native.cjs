'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const {createNativeEditor}=require('../app/providers/native-editor.cjs');
const {authoredGui}=require('../app/providers/recipes.cjs');
const {speechRecipes,imageRecipe}=require('../app/providers/specialized-recipes.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(root,'testing-output','specialized-native-'+Date.now());
app.setPath('userData',path.join(base,'profile'));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore/providers.json'),'utf8')).comfyui,p=new ComfyProvider({...config,url:'http://127.0.0.1:8189'});
  class HiddenWindow extends BrowserWindow{show(){}}
  const editor=createNativeEditor({BrowserWindow:HiddenWindow,url:p.url}),report={cases:[],ok:false};
  try{
    const ready=(await p.status()).ready;if(ready&&!process.argv.includes('--reuse'))throw Error('8189 already occupied');if(!ready)await p.start();const {nodes}=await p.inspect();
    const recipes=[...speechRecipes(nodes),imageRecipe('portrait'),imageRecipe('angles',true),imageRecipe('grid',true,true),imageRecipe('mark',false,false,true)];
    for(const recipe of recipes){
      const item={id:recipe.id};report.cases.push(item);
      try{const result=await editor.convert(authoredGui(recipe.api,nodes),{mapping:recipe.mapping,replace:true});await fs.mkdir(base,{recursive:true});await fs.writeFile(path.join(base,recipe.id+'.json'),JSON.stringify(result,null,2));
        for(const [id,node]of Object.entries(recipe.api)){assert.equal(result.api[id]?.class_type,node.class_type,'Class '+id);assert.deepEqual(result.api[id].inputs,node.inputs,'Inputs '+recipe.id+' node '+id);}
        assert.deepEqual(result.mapping,recipe.mapping);item.ok=true;
      }catch(e){item.ok=false;item.error=e.message;console.error(e);}
    }
    report.ok=report.cases.every(c=>c.ok);
  }catch(e){report.error=e.stack;}
  finally{editor.dispose();if(p.owned)report.cleanup=await p.stopOwned().catch(e=>({error:e.message}));await fs.mkdir(base,{recursive:true});await fs.writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);}
});
