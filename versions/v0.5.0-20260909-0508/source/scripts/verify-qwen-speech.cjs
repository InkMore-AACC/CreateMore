'use strict';
// Real ComfyUI queue execution, isolated output, never a user's canvas.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {ComfyProvider}=require('../app/providers/comfyui.cjs');
const {authoredGui}=require('../app/providers/recipes.cjs');
const {writeAtomic}=require('../app/providers/util.cjs');
async function main(){
  if(!process.argv.includes('--run-local'))throw Error('Explicit --run-local required');
  const root=path.resolve(__dirname,'..'),base=path.join(root,'testing-output','qwen-speech-'+Date.now());
  const config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore/providers.json'),'utf8')).comfyui;
  const reuse=process.argv.includes('--reuse-user-backend');
  const p=new ComfyProvider({...config,url:reuse?'http://127.0.0.1:8188':'http://127.0.0.1:8189'}),report={base,cases:[],ok:false};
  await fs.mkdir(base,{recursive:true});
  try{
    const status=await p.status();if(status.ready&&(!reuse||status.running||status.pending))throw Error('后台已占用，未开始验收');
    await p.start();const {nodes}=await p.inspect();await writeAtomic(path.join(base,'node-inventory.json'),JSON.stringify(nodes));
    const models=nodes.CreateMoreQwenTTS?.input.required.model[0];assert.ok(models?.length,'TTS node registered');
    const emotionPair=process.argv.includes('--emotion-pair');
    for(const mode of emotionPair?['custom_voice','custom_voice']:['voice_design',...(process.argv.includes('--all')?['custom_voice','voice_clone']:[])]){
      const caseName=emotionPair?'emotion-'+(report.cases.length?'sad':'happy'):mode;
      const kind={voice_design:'VoiceDesign',custom_voice:'CustomVoice',voice_clone:'Base'}[mode];
      const model=models.find(m=>m.includes(kind));assert.ok(model,kind+' model found');
      const api={'1':{class_type:'CreateMoreQwenTTS',inputs:{model,mode,text:mode==='voice_clone'?'今天的风很轻，阳光正好。我们终于可以出发了。':'今天的风很轻，阳光正好。欢迎来到我们的创作画布。',instruction:mode==='voice_clone'?'':'年轻女性，声音温暖清澈，轻松自然，带一点开心的笑意。',speaker:'Vivian',language:'Chinese',seed:80908,max_new_tokens:512,reference_text:mode==='voice_clone'?'今天的风很轻，阳光正好。欢迎来到我们的创作画布。':''}},'2':{class_type:'SaveAudio',inputs:{audio:['1',0],filename_prefix:'CreateMore/tts-test'}}};
      if(emotionPair)api['1'].inputs.instruction=report.cases.length?'非常难过，语速稍慢，声音低落，带一点哽咽，但吐字自然清楚。':'真诚开心，轻快兴奋，带着自然的笑意，不要夸张播音。';
      const mapping={inputs:[{id:'prompt',source:'prompt',nodeId:'1',input:'text',required:true}],outputs:[{id:'audio',nodeId:'2',key:'audio',type:'audio'}]};
      let references=[];
      if(mode==='voice_clone'){
        const first=report.cases[0].result.outputs[0];
        api['3']={class_type:'LoadAudio',inputs:{audio:'example.wav'}};api['1'].inputs.reference_audio=['3',0];
        mapping.inputs.push({id:'audio',source:'reference',nodeId:'3',input:'audio',mediaType:'audio',required:true});references=[{path:first.path,type:'audio'}];
      }
      const workflow={api,mapping,gui:authoredGui(api,nodes)};await writeAtomic(path.join(base,caseName+'-workflow.json'),JSON.stringify(workflow,null,2));
      let last;const start=Date.now();console.log('Starting '+mode);
      const result=await p.run({workflow,prompt:api['1'].inputs.text,references,timeoutMs:1000000},{outputDir:path.join(base,caseName),onProgress:state=>{if(state.state!==last){console.log(JSON.stringify(state));last=state.state;}}});
      report.cases.push({mode,caseName,instruction:api['1'].inputs.instruction,seconds:(Date.now()-start)/1000,result});await writeAtomic(path.join(base,'report.json'),JSON.stringify(report,null,2));
      assert.equal(result.state,'completed');console.log(JSON.stringify(report.cases.at(-1)));
    }
    if(process.argv.includes('--cancel')){
      const workflow=JSON.parse(await fs.readFile(path.join(base,'voice_design-workflow.json'),'utf8'));workflow.api['1'].inputs.max_new_tokens=4096;
      const controller=new AbortController();let timer;
      try{await p.run({workflow,prompt:'今天的风很轻，阳光正好。'.repeat(100),timeoutMs:120000},{signal:controller.signal,outputDir:path.join(base,'cancelled'),onProgress:s=>{if(s.state==='running'&&!timer)timer=setTimeout(()=>controller.abort(),5000);}});throw Error('Cancellation unexpectedly completed');}
      catch(e){assert.equal(e.code,'ABORTED');report.cancellation=e.cancellation;}
      finally{clearTimeout(timer);}
      for(let i=0;i<60;i++){const q=await p.request('/queue');if(!q.queue_running.length&&!q.queue_pending.length){report.cancelQueueEmpty=true;break;}await new Promise(r=>setTimeout(r,500));}
      assert.equal(report.cancelQueueEmpty,true,'Cancelled speech worker must stop');
    }
    report.ok=true;
  }catch(e){report.error={message:e.message,details:e.details,stack:e.stack};console.error(e);process.exitCode=1;}
  finally{if(p.owned)report.cleanup=await p.stopOwned().catch(e=>({error:e.message}));await writeAtomic(path.join(base,'report.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(base,'report.json'));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
