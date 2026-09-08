'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({service,appDir,dataDir,BrowserWindow,window}){
  const relative=path.relative(path.join(appDir,'.test-output'),dataDir);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('本地验收必须使用独立配置目录');
  await service.hub.ready;const p=service.hub.providers.comfyui;const before=await p.status();if(before.ready&&(!process.argv.includes('--reuse-existing-comfy')||before.running||before.pending))throw Error('8188 已在运行且未授权复用或队列非空，未开始验收');
  const report={at:new Date().toISOString(),ok:false,scope:'Actual packaged EXE, copied local connection configuration, real backend output and native graph. Service submission; not user-mouse or artistic acceptance.',launch:process.argv.includes('--reuse-existing-comfy')?'background-reusing-existing-backend':'diagnostic-launch',cases:[]};let editor;
  const file=path.join(dataDir,'report.json');const persist=()=>fs.writeFile(file,JSON.stringify(report,null,2));
  async function wait(task,name){const item={name,taskId:task.id};report.cases.push(item);await persist();const until=Date.now()+12*60*1000;let latest;
    while(Date.now()<until){latest=service.queue.get(task.id);if(['succeeded','failed','cancelled','unknown'].includes(latest.state))break;await pause(500);}
    item.state=latest?.state;if(latest?.state!=='succeeded')throw Error(name+'：'+(latest?.error||latest?.message||'超时'));
    item.outputs=[];for(const output of latest.result?.outputs||[]){const bytes=await fs.readFile(output.path);item.outputs.push({path:output.path,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
    assert.ok(item.outputs.length,'必须有保存文件');item.ok=true;await persist();
  }
  try{
    await service.createProject(path.join(dataDir,'验收工程'),'用户启动环境验收');
    const node=service.newNode('image',{title:'正式软件出图检查',source:'本地 ComfyUI',prompt:'A teal ceramic cup beside a window, daylight, realistic photo.',workflowId:'default:image-zimage',parameters:{width:512,height:512,steps:4},count:1});service.current.state.nodes.push(node);
    await wait(await service.submitNode(node.id),'图片卡片真实生成');
    const assetsArg=process.argv.find(arg=>arg.startsWith('--acceptance-assets='));if(!assetsArg)throw Error('缺少验收素材目录');const assets=path.resolve(assetsArg.slice('--acceptance-assets='.length));
    const assetFile=path.join(assets,'exec-0865d89e-cac3-42be-b166-1b28e1b3209c.png');await service.importAsset(assetFile,{copy:true});const input=service.current.state.nodes.at(-1);
    await wait(await service.submitTool({nodeId:input.id,toolId:'builtin-tool-resize',parameters:{provider:'comfyui',width:256,height:256}}),'AAA 图片尺寸工具');
    const {createNativeEditor}=require('./providers/native-editor.cjs');class HiddenWindow extends BrowserWindow{show(){}}
    editor=createNativeEditor({BrowserWindow:HiddenWindow,url:p.url});const bundle=await service.workflowRead('default:image-zimage');const converted=await editor.convert(bundle.gui,{mapping:bundle.mapping,replace:true});assert.deepEqual(converted.mapping,bundle.mapping);assert.ok(Object.keys(converted.api||{}).length);report.nativeMapping={opened:true,mappingReadback:true,nodeCount:converted.gui.nodes.length};
    const {ResourceStore}=require('./core/resources.cjs');service.resources=new ResourceStore({appDir:dataDir});
    const custom=service.newNode('custom',{title:'原生映射保存后生成',source:'本地 ComfyUI',outputType:'image',prompt:'A teal ceramic cup beside a window, daylight.',parameters:{width:512,height:512,steps:4}});service.current.state.nodes.push(custom);
    await service.call('workflow.validate',{bundle:converted});const saved=await service.call('workflow.save',{name:'仅验收原生映射',bundle:converted,nodeId:custom.id});
    assert.ok(saved.resource.id);assert.ok(custom.workflowVersion);await wait(await service.submitNode(custom.id),'原生映射保存绑定后真实生成');
    assert.ok(custom.assetId);report.nativeMapping.savedResource=saved.resource.id;report.nativeMapping.generatedNode=custom.id;
    await service.saveCanvas();const reopened=await service.store.loadCanvas(service.current.projectDir,service.current.id);const restored=reopened.state.nodes.find(n=>n.id===custom.id);assert.equal(restored.workflowVersion,custom.workflowVersion);assert.equal(restored.assetId,custom.assetId);report.reopened={nodes:reopened.state.nodes.length,assets:reopened.state.assets.length,customMappingAndResultRetained:true};
    if(window){window.webContents.setBackgroundThrottling(false);report.visibleImages=await window.webContents.executeJavaScript(`(async()=>{await CreateMoreDesktop.ready;await CreateMoreDesktop.refresh();CreateMoreCanvas.closePanel(true);const C=CreateMoreCanvas,id=${JSON.stringify(custom.id)};C.state().nodes.forEach((n,i)=>{n.x=160+(i%2)*600;n.y=(i===0||n.id===id)?80:760;n.w=320;n.h=260;});C.state().view={x:20,y:0,k:.85};C.selection([id]);C.render();C.updateMediaVisibility();await Promise.all([...document.querySelectorAll('img[data-canvas-media][src]')].map(img=>img.decode()));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return [...document.querySelectorAll('img[data-canvas-media][src]')].map(img=>({nodeId:img.dataset.canvasMedia,width:img.naturalWidth,height:img.naturalHeight}));})()`);assert.ok(report.visibleImages.length&&report.visibleImages.every(i=>i.width>0));await fs.writeFile(path.join(dataDir,'local-mapping-card.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());report.screenshot=path.join(dataDir,'local-mapping-card.png');}
    report.ok=true;
  }catch(error){report.error={message:error.message,code:error.code};}
  finally{editor?.dispose();if(p.owned){try{report.cleanup=await p.stopOwned();}catch(error){report.cleanup={stopped:false,error:error.message};}}report.finishedAt=new Date().toISOString();await persist();}
  return report;
}
module.exports={run};
