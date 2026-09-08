'use strict';
// Isolated real renderer -> preload IPC -> product service -> local provider acceptance.
const {app,BrowserWindow,ipcMain,protocol}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {CreateMoreService}=require('../app/core/service.cjs');
const {writeAtomic}=require('../app/providers/util.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(root,'testing-output','tool-ui-'+Date.now());
app.setPath('userData',path.join(base,'electron-profile'));
protocol.registerSchemesAsPrivileged([{scheme:'createmore-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  if(!process.argv.includes('--run-local'))throw new Error('需要 --run-local 明确启用本机验收');
  const report={at:new Date().toISOString(),scope:'Real mouse clicks on tool/menu/submit, DOM form input, actual preload IPC and local output. Not artistic acceptance.',cases:[],ok:false};
  const service=new CreateMoreService({appDir:root,dataDir:path.join(base,'profile')});let win;
  const persist=()=>writeAtomic(path.join(base,'report.json'),JSON.stringify(report,null,2));
  try{
    await service.init();await service.createProject(path.join(base,'验收工程'),'工具界面验收');
    const config=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'CreateMore/providers.json'),'utf8')).comfyui;
    await service.hub.configure({comfyui:{...config,url:'http://127.0.0.1:8189'}});
    const p=service.hub.providers.comfyui,prior=await p.status();if(prior.ready)throw new Error('8189 已在线，未复用或触碰现有后台');
    const fixture=JSON.parse(await fs.readFile(path.join(root,'testing-output/local-cards-1788845463742/report.json'),'utf8')),source={};
    for(const [type,name]of [['image','图片生成'],['video','文生视频含音轨'],['audio','环境音生成']]){await service.importAsset(fixture.cases.find(c=>c.name===name).outputs[0].path,{copy:true});source[type]=service.current.state.nodes.at(-1).id;}
    for(const type of ['text','script']){const n=service.newNode(type,{title:'文字工具验收',content:'清晨，摄影师把青绿色陶杯放在木桌上。阳光从左侧窗户照入。他把一朵黄色小花放在杯旁，然后离开。',prompt:'',shots:type==='script'?[{description:'摄影师在清晨的木桌上摆放陶杯与黄色小花。',prompt:'清晨室内，陶杯，黄色小花。',duration:'5s'}]:undefined});service.current.state.nodes.push(n);source[type]=n.id;}
    const speechNodes=[];
    if(process.argv.includes('--speech')){
      const reference=JSON.parse(await fs.readFile(path.join(root,'testing-output/qwen-speech-1788852035848/report.json'),'utf8')).cases[0].result.outputs[0].path;
      await service.importAsset(reference,{copy:true});const ref=service.current.state.nodes.at(-1);
      for(const mode of ['design','emotion','clone']){const n=service.newNode('audio',{title:'语音界面验收 · '+mode,source:'本地 ComfyUI',prompt:'今天的风很轻，阳光正好。欢迎来到我们的创作画布。',x:220,y:120});speechNodes.push({id:n.id,mode});service.current.state.nodes.push(n);if(mode==='clone')service.current.state.edges.push({id:crypto.randomUUID(),from:ref.id,to:n.id});}
    }
    await service.saveCanvas();
    const originalRun=service.hub.run.bind(service.hub);service.hub.run=(snapshot,options)=>{if(!['comfyui','media','storyboard'].includes(snapshot.provider))throw new Error('验收拒绝非本地来源 '+snapshot.provider);return originalRun(snapshot,options);};
    win=new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{preload:path.join(root,'app/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.setBackgroundThrottling(false);
    ipcMain.handle('createmore:call',async(event,method,args)=>{assert.equal(event.sender,win.webContents);try{return {ok:true,value:await service.call(method,args)};}catch(e){return {ok:false,error:{message:e.message,code:e.code}};}});
    ipcMain.handle('createmore:pending-documents',()=>({ok:true,value:[]}));
    protocol.handle('createmore-media',async req=>{const file=service.mediaFiles.get(new URL(req.url).pathname.slice(1));return file?require('../app/media-protocol.cjs').fileResponse(file,req):new Response('',{status:404});});
    service.on('event',data=>{if(!win.isDestroyed())win.webContents.send('createmore:event',data);});
    await win.loadFile(path.join(root,'app/ui/index.html'));
    const run=(fn,args)=>win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(args)})`);
    await run(()=>window.CreateMoreDesktop.ready);
    async function until(fn,label,limit=15000){const start=Date.now();for(;;){const value=await fn();if(value)return value;if(Date.now()-start>limit)throw new Error('等待超时：'+label);await pause(100);}}
    async function click(selector){const pt=await run(s=>{const el=[...document.querySelectorAll(s)].find(e=>e.getClientRects().length&&e.getBoundingClientRect().width>0);if(!el)throw new Error('缺少可见按钮 '+s);el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};},selector);win.webContents.sendInputEvent({type:'mouseDown',...pt,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...pt,button:'left'});await pause(180);}
    const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7).split(',');
    const records=process.argv.includes('--speech')?[]:(await service.resources.list('tools',{source:'builtin'})).filter(r=>!only||only.includes(r.name));
    await p.start();report.backend={url:p.url,pid:p.owned?.pid};await persist();
    for(const record of records){const item={id:record.id,name:record.name,mediaType:record.mediaType,workflowId:record.workflowId,startedAt:new Date().toISOString(),ok:false};report.cases.push(item);const began=Date.now();
      try{
        await run(async id=>{const C=CreateMoreCanvas;C.closePanel(true);C.closeTransient();await CreateMoreDesktop.refresh();C.state().view={x:0,y:0,k:1};const n=C.graph.get(id);n.x=240;n.y=140;n.w=330;n.h=220;C.selection([id]);C.render();},source[record.mediaType]);
        const selector='[data-tool-id="'+record.id+'"]';if(!await run(s=>[...document.querySelectorAll(s)].some(e=>e.getClientRects().length&&e.getBoundingClientRect().width>0),selector))await click('[data-action="tools-more"][data-node="'+source[record.mediaType]+'"]');
        await click(selector);await until(()=>run(id=>CreateMoreDesktop.app.toolId===id&&!!document.querySelector('[data-desktop-form="tool"]')?.getClientRects().length,record.id),'当前工具表单');
        if(record.name==='标记'&&record.workflowId==='default:tool-qwen-mark'){
          await click('[data-action="annotate-tool"]');await until(()=>run(()=>!!document.querySelector('[data-mark-mode="mask"]')),'标注图片加载完成');await click('[data-mark-mode="rect"]');
          const rect=await run(()=>{const r=document.querySelector('#annotation-canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
          const start={x:Math.round(rect.x+rect.w*.28),y:Math.round(rect.y+rect.h*.24)},end={x:Math.round(rect.x+rect.w*.74),y:Math.round(rect.y+rect.h*.8)};
          win.webContents.sendInputEvent({type:'mouseDown',...start,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseMove',...end,button:'left'});win.webContents.sendInputEvent({type:'mouseUp',...end,button:'left',clickCount:1});await click('#mark-save');await until(()=>run(()=>!!document.querySelector('[data-desktop-form="tool"] [name="annotationAssetId"]')),'遮罩保存返回工具');
        }
        const generic=record.workflowId==='default:image-zimage-edit';
        await run(({name,generic})=>{const form=document.querySelector('[data-desktop-form="tool"]');const values={provider:'comfyui',max_length:1024,start:0,end:2,interval:1,speed:1.25,volume:-6,width:128,height:128,x:16,y:16,steps:4,length:22,seed:81100};if(name==='逐帧拉片')values.max_length=512;if(name==='片段重拍')values.prompt='保持青绿色陶杯及木桌，镜头缓慢靠近。无对白。';if(name==='剧本转分镜')values.prompt='拆成两个镜头，输出简短内容。';if(name==='标记')values.prompt='仅将标注区域内的陶杯改成红色，保持形状、背景和原构图。';if(name==='打光')values.prompt='仅改为右侧暖光，保持原有构图和物体。';for(const [key,value]of Object.entries(values)){const el=form.elements.namedItem(key);if(el){el.value=String(value);el.dispatchEvent(new Event('change',{bubbles:true}));}}if(generic){const el=form.elements.namedItem('allowGenericExperiment');if(!el||el.checked)throw new Error('缺少默认未勾选的实验提示');}}, {name:record.name,generic});
        const count=service.queue.tasks.length;await click('[data-desktop-form="tool"] button[type="submit"]');
        if(generic){await until(()=>run(()=>document.body.textContent.includes('尚未接入已验收的专用本地工作流')),'专用能力拒绝提示');assert.equal(service.queue.tasks.length,count);item.status='blocked-unverified-specialized';item.ok=true;item.effectAccepted=false;}
        else{const task=await until(()=>service.queue.tasks.length>count&&service.queue.tasks.at(-1),'任务提交');item.taskId=task.id;
          const done=await until(()=>{const t=service.queue.get(task.id);return ['succeeded','failed','unknown','cancelled'].includes(t.state)&&t;},record.name+'生成',20*60*1000);item.state=done.state;item.error=done.error;assert.equal(done.state,'succeeded',JSON.stringify(done.error));
          const results=service.current.state.nodes.filter(n=>n.originTaskId===task.id);assert.ok(results.length,'结果未回到卡片');item.results=results.map(n=>({id:n.id,type:n.type,shots:n.shots?.length}));item.outputs=[];
          for(const id of [...new Set(results.flatMap(n=>n.outputAssets||[n.assetId]).filter(Boolean))]){const file=await service.assetPath(id),bytes=await fs.readFile(file);assert.ok(bytes.length);item.outputs.push({path:file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
          if(record.handler==='剧本转分镜'||record.handler==='逐帧拉片')assert.ok(results.some(n=>n.type==='script'&&n.shots?.length),'未解析出分镜，不能算该工具成功');else assert.ok(item.outputs.length,'工具必须落盘');
          item.ok=true;item.effectAccepted=false;item.status='ui-local-output-verified';
        }
      }catch(e){item.error={message:e.message,stack:e.stack};item.status='failed';item.dom=await run(()=>({text:document.querySelector('#panel')?.textContent||document.body.textContent.slice(-2500),invalid:[...document.querySelectorAll('[data-desktop-form="tool"] :invalid')].map(e=>({name:e.name,message:e.validationMessage})),form:document.querySelector('[data-desktop-form="tool"]')?.outerHTML})).catch(()=>null);await fs.writeFile(path.join(base,record.id+'-failure.png'),(await win.webContents.capturePage()).toPNG());console.error(record.name+': '+e.message);}
      item.seconds=(Date.now()-began)/1000;await persist();console.log(JSON.stringify({tool:item.name,type:item.mediaType,status:item.status,seconds:item.seconds}));
      const status=await p.status();if(status.running||status.pending){report.stoppedEarly='后台仍有任务，未继续提交';break;}
    }
    for(const speech of speechNodes){const item={name:'语音 · '+speech.mode,ok:false};report.cases.push(item);
      try{
        await run(async ({id})=>{const C=CreateMoreCanvas;C.closePanel(true);await CreateMoreDesktop.refresh();C.state().view={x:0,y:0,k:1};C.selection([id]);C.render();},speech);
        await until(()=>run(({id,mode})=>!!document.querySelector('[data-workflow-choice][data-node="'+id+'"] option[value="default:audio-qwen-'+mode+'"]'),speech),'语音工作流目录');
        await run(({id,mode})=>{const select=document.querySelector('[data-workflow-choice][data-node="'+id+'"]');select.value='default:audio-qwen-'+mode;select.dispatchEvent(new Event('change',{bubbles:true}));},speech);
        await until(()=>run(id=>!!document.querySelector('[data-owner="'+id+'"] [data-param="max_new_tokens"]'),speech.id),'语音公开参数');
        await run(({id,mode})=>{const parent=document.querySelector('[data-owner="'+id+'"]');for(const [key,value]of Object.entries({max_new_tokens:512,instruction:'自然轻松，带一点开心的笑意。',reference_text:'今天的风很轻，阳光正好。欢迎来到我们的创作画布。'})){const input=parent.querySelector('[data-param="'+key+'"]');if(input){input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));}}},speech);
        const before=service.queue.tasks.length;await click('[data-action="generation"][data-node="'+speech.id+'"].generate-button');
        const task=await until(()=>service.queue.tasks.length>before&&service.queue.tasks.at(-1),'语音界面任务提交');item.taskId=task.id;
        const done=await until(()=>{const t=service.queue.get(task.id);return ['succeeded','failed','unknown','cancelled'].includes(t.state)&&t;},'语音生成',900000);assert.equal(done.state,'succeeded',JSON.stringify(done.error));
        const result=service.current.state.nodes.find(n=>n.id===speech.id);assert.ok(result.assetId,'Audio result must return to original card');const file=await service.assetPath(result.assetId);assert.ok((await fs.stat(file)).size>0);item.outputs=[{path:file}];item.status='ui-local-output-verified';item.ok=true;
      }catch(e){item.status='failed';item.error=e.stack;console.error(e);}
      await persist();console.log(JSON.stringify(item));
    }
    report.ok=report.cases.length===records.length+speechNodes.length&&report.cases.every(c=>c.ok);report.summary={localOutputs:report.cases.filter(c=>c.status==='ui-local-output-verified').length,specializedBlocked:report.cases.filter(c=>c.status==='blocked-unverified-specialized').length,failed:report.cases.filter(c=>c.status==='failed').length,artisticAcceptance:false};await fs.writeFile(path.join(base,'final-ui.png'),(await win.webContents.capturePage()).toPNG());
  }catch(e){report.error=e.stack;console.error(e);}
  finally{const p=service.hub?.providers?.comfyui;if(p?.owned)report.cleanup=await p.stopOwned().catch(e=>({error:e.message}));await service.close();await persist();if(win&&!win.isDestroyed())win.destroy();console.log('REPORT '+path.join(base,'report.json'));app.exit(report.ok?0:1);}
}).catch(e=>{console.error(e);app.exit(1);});
