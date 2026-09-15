'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const {imageRecipe}=require('../app/providers/specialized-recipes.cjs');
const {authoredGui}=require('../app/providers/recipes.cjs');
const {WorkflowStore}=require('../app/providers/workflows.cjs');
const {writeAtomic}=require('../app/providers/util.cjs');
async function main(){
  if(!process.argv.includes('--run-local'))throw Error('Explicit --run-local required');
  const root=path.resolve(__dirname,'..'),base=path.join(root,'testing-output','qwen-images-'+Date.now());await fs.mkdir(base,{recursive:true});
  const config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore/providers.json'),'utf8')).comfyui,p=new ComfyProvider({...config,url:process.argv.includes('--reuse-user-backend')?'http://127.0.0.1:8188':'http://127.0.0.1:8189'}),report={base,cases:[],ok:false};
  const persist=()=>writeAtomic(path.join(base,'report.json'),JSON.stringify(report,null,2));
  try{
    const status=await p.status();if(status.ready&&(!process.argv.includes('--reuse-user-backend')||status.running||status.pending))throw Error('后台已占用，未开始验收');await p.start();const {nodes}=await p.inspect();
    const fixture=JSON.parse(await fs.readFile(path.join(root,'testing-output/local-cards-1788845463742/report.json'),'utf8')).cases.find(c=>c.name==='图片生成').outputs[0].path;
    const mask=path.join(base,'mask.png'),guide=path.join(base,'guide.png');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=1024x1024','-vf','drawbox=x=300:y=250:w=440:h=540:color=white:t=fill','-frames:v','1',mask],{windowsHide:true});
    execFileSync('ffmpeg',['-v','error','-i',fixture,'-vf','drawbox=x=300:y=250:w=440:h=540:color=red:t=4','-frames:v','1',guide],{windowsHide:true});
    const portraitWorkflow=await new WorkflowStore(path.join(root,'resources/workflows/defaults')).read('image-zimage');
    console.log('Generating a portrait test fixture');const portrait=await p.run({workflow:portraitWorkflow,prompt:'Close portrait photograph of an adult woman aged 30, warm medium skin, natural freckles, dark brown eyes, short dark hair, plain grey crew neck shirt, neutral expression, soft window light, detailed skin texture, no makeup, no text.',parameters:{width:512,height:512,steps:8,seed:88910}},{outputDir:path.join(base,'portrait-source')});report.portraitSource=portrait.outputs[0].path;await persist();
    const cases=[['portrait',false,false,false,report.portraitSource,'保留人物身份、脸型、五官、发型和构图。只增强自然皮肤细节与细小雀斑，避免磨皮和过度锐化。'],['angles',true,false,false,report.portraitSource,'Preserve the woman, freckles, short dark hair, grey shirt and room. Maintain identity.'],['lighting',false,false,false,fixture,'Change only the lighting: warm amber light from the right, soft deep shadows on the left. Preserve the exact cup shape, camera position, colors and background.'],['grid',true,true,false,report.portraitSource,'Preserve the woman, freckles, short dark hair, grey shirt and room. Maintain identity.'],['mark',false,false,true,fixture,'第一张是原图，第二张是区域指引。把标注区域内的青绿色陶杯改成明亮红色的同款陶杯。保留形状，不添加其他物品。移除红色标记线。']];
    const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7).split(',');
    for(const [name,angle,grid,masked,source,prompt]of cases.filter(c=>!only||only.includes(c[0]))){
      const recipe=imageRecipe('tool-qwen-'+name,angle,grid,masked),workflow={...recipe,gui:authoredGui(recipe.api,nodes)},item={name,startedAt:new Date().toISOString()};report.cases.push(item);await persist();
      const refs=[{path:source,type:'image'}];if(masked)refs.push({path:guide,type:'image'},{path:mask,type:'image'});
      await writeAtomic(path.join(base,name+'-workflow.json'),JSON.stringify(workflow,null,2));let last;const began=Date.now();console.log('Starting '+name);
      try{item.result=await p.run({workflow,prompt,references:refs,parameters:{megapixels:1,seed:88911,steps:4,azimuth:'right side view'},timeoutMs:1800000},{outputDir:path.join(base,name),onProgress:s=>{if(s.state!==last){console.log(JSON.stringify({case:name,...s}));last=s.state;}}});assert.equal(item.result.state,'completed');item.seconds=(Date.now()-began)/1000;item.ok=true;
        if(masked){item.unchangedOutsideMask=JSON.parse(execFileSync(config.pythonPath,['-c','from PIL import Image; import numpy as np,json,sys; a=np.array(Image.open(sys.argv[1]).convert("RGB")); b=np.array(Image.open(sys.argv[2]).convert("RGB")); m=np.array(Image.open(sys.argv[3]).convert("L"))>0; print(json.dumps({"same_size":a.shape==b.shape,"outside_max_error":int(np.abs(a.astype(int)-b.astype(int))[~m].max()),"inside_changed_pixels":int(np.any(a!=b,axis=-1)[m].sum())}))',fixture,item.result.outputs[0].path,mask],{encoding:'utf8',windowsHide:true}));assert.equal(item.unchangedOutsideMask.outside_max_error,0);assert.ok(item.unchangedOutsideMask.inside_changed_pixels>0);}
      }catch(e){item.ok=false;item.error={message:e.message,details:e.details};console.error(e);}
      await persist();console.log(JSON.stringify(item));const status=await p.status();if(status.running||status.pending){report.stoppedEarly='Backend still busy; no further submission';break;}
    }
    report.ok=report.cases.length>0&&report.cases.every(c=>c.ok);
  }catch(e){report.error=e.stack;console.error(e);}
  finally{if(p.owned)report.cleanup=await p.stopOwned().catch(e=>({error:e.message}));await persist();console.log('REPORT '+path.join(base,'report.json'));if(!report.ok)process.exitCode=1;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
