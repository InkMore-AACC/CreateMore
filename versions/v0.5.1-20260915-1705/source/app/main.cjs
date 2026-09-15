'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,protocol,safeStorage,Menu}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {CreateMoreService}=require('./core/service.cjs');
const {startAutomation}=require('./automation.cjs');
const appDir=app.isPackaged?path.dirname(process.execPath):path.resolve(__dirname,'..');
const dataDir=process.env.CREATEMORE_DATA_DIR||path.join(app.getPath('appData'),'CreateMore');
app.setPath('userData',dataDir);
protocol.registerSchemesAsPrivileged([{scheme:'createmore-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
let window,service,automation,nativeEditor,nativeEditorURL,closing=false,closePending=false;const selectedFiles=new Set(),nativeEditors=[];
function disposeEditors(){for(const editor of nativeEditors)editor.dispose();}
const entry=pathToFileURL(path.join(__dirname,'ui','index.html')).href;
let documentsReady=false;
const pendingDocuments=[];
function enqueueDocuments(argv,cwd=process.cwd()){for(const arg of argv){if(typeof arg!=='string'||arg.startsWith('-')||path.extname(arg).toLowerCase()!=='.createmore')continue;pendingDocuments.push(path.resolve(cwd,arg));}if(documentsReady&&pendingDocuments.length&&window&&!window.isDestroyed())window.webContents.send('createmore:event',{type:'open-documents'});}
enqueueDocuments(process.argv.slice(1));
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',(_event,argv,cwd)=>{enqueueDocuments(argv,cwd);if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
  app.whenReady().then(start).catch(async error=>{await fs.mkdir(dataDir,{recursive:true});await fs.appendFile(path.join(dataDir,'startup-error.log'),new Date().toISOString()+' '+error.stack+'\n');dialog.showErrorBox('CreateMore 启动失败',error.message);app.exit(1);});
}
async function start(){
  if(process.argv.includes('--diagnose-config-loader')){
    const {ProviderHub}=require('./providers');const hub=new ProviderHub({appDir,dataDir,decryptSecret:value=>safeStorage.decryptString(Buffer.from(value,'base64'))});await hub.ready;
    const c=hub.publicConfig().comfyui||{};const report={at:new Date().toISOString(),dataDir,configFile:hub.file,loadError:hub.loadError||null,comfyui:{url:c.url||null,installDir:c.installDir||null,pythonPath:c.pythonPath||null,args:c.args||[]}};
    const target=path.join(appDir,'.test-output');await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'config-diagnostic.json'),JSON.stringify(report,null,2));await hub.close();closing=true;app.exit(0);return;
  }
  service=new CreateMoreService({appDir,dataDir,encryptSecret:text=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 凭据加密不可用，密钥未保存');return safeStorage.encryptString(text).toString('base64');},decryptSecret:value=>safeStorage.decryptString(Buffer.from(value,'base64'))});await service.init();automation=await startAutomation(service,{dataDir});
  protocol.handle('createmore-media',async request=>{try{const url=new URL(request.url);if(url.host!=='asset'||url.search||url.hash)return new Response('Not found',{status:404});const file=service.mediaFiles.get(url.pathname.slice(1));if(!file)return new Response('Not found',{status:404});return await require('./media-protocol.cjs').fileResponse(file,request);}catch{return new Response('Missing asset',{status:404});}});
  window=new BrowserWindow({width:1600,height:980,minWidth:960,minHeight:640,title:'CreateMore',icon:path.join(__dirname,'ui/assets/brand/oo-logo.ico'),backgroundColor:'#171717',show:!process.argv.some(arg=>['--smoke-test','--e2e-test','--diagnose-config','--production-local-check'].includes(arg)),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  Menu.setApplicationMenu(null);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(url!==entry)event.preventDefault();});window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  service.on('event',data=>{if(!window.isDestroyed())window.webContents.send('createmore:event',data);});
  function trusted(event){if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==entry)throw new Error('拒绝来自其他页面的桌面操作');}
  const handle=(name,fn)=>ipcMain.handle(name,async(event,...args)=>{trusted(event);try{return {ok:true,value:await fn(...args)};}catch(error){return {ok:false,error:{code:error.code||'DESKTOP_ERROR',message:error.message||String(error)}};}});
  handle('createmore:call',(method,args)=>service.call(method,args));
  handle('createmore:directory',async()=>{const result=await dialog.showOpenDialog(window,{title:'选择项目或资源目录',properties:['openDirectory','createDirectory']});if(result.canceled)return null;return result.filePaths[0];});
  handle('createmore:pending-documents',async()=>{documentsReady=true;return pendingDocuments.splice(0);});
  handle('createmore:associate-documents',async()=>{if(!app.isPackaged)throw new Error('请在打包后的软件中关联工程文件');const answer=await dialog.showMessageBox(window,{type:'question',title:'关联 CreateMore 工程',message:'为当前 Windows 用户关联 .createmore 工程文件？',detail:'设置工程图标及双击打开方式。不会修改 JSON 或其他格式。软件搬家后可再次点击此按钮修复。',buttons:['关联工程文件','取消'],defaultId:0,cancelId:1});if(answer.response!==0)return {cancelled:true};return require('./file-association.cjs').register({exe:process.execPath,icon:path.join(__dirname,'ui/assets/brand/oo-project.ico')});});
  handle('createmore:files',async(options={})=>{const result=await dialog.showOpenDialog(window,{title:options.title||'选择文件',properties:['openFile',...(options.multiple?['multiSelections']:[])],filters:Array.isArray(options.filters)?options.filters:[]});if(result.canceled)return [];for(const file of result.filePaths)selectedFiles.add(file);return result.filePaths;});
  handle('createmore:save-file',async(options={})=>{const result=await dialog.showSaveDialog(window,{title:options.title||'导出文件',defaultPath:options.name,filters:options.filters});return result.canceled?null:result.filePath;});
  handle('createmore:read-json',async file=>{if(!selectedFiles.has(file))throw new Error('只能读取刚刚选择的文件');if((await fs.stat(file)).size>32*1024*1024)throw new Error('JSON 文件过大');return JSON.parse(await fs.readFile(file,'utf8'));});
  handle('createmore:reveal',async assetId=>{const file=await service.assetPath(assetId);shell.showItemInFolder(file);});
  handle('createmore:download',async nodeId=>{const c=service.requireCurrent(),node=c.state.nodes.find(n=>n.id===nodeId);if(!node)throw new Error('节点不存在');const original=node.assetId?await service.assetPath(node.assetId,c):null,extension=node.type==='script'?'.xlsx':original?path.extname(original):'.txt';const result=await dialog.showSaveDialog(window,{title:'另存内容（原素材保留）',defaultPath:node.title.replace(/[<>:"/\\|?*]/g,'_')+extension});if(result.canceled)return {cancelled:true};if(original&&path.resolve(original).toLowerCase()===path.resolve(result.filePath).toLowerCase())throw new Error('请选择不同于原素材的保存位置');if(node.type==='script')await service.call('storyboard.export',{nodeId,path:result.filePath});else if(original)await fs.copyFile(original,result.filePath);else await fs.writeFile(result.filePath,node.content||node.prompt||'','utf8');return {path:result.filePath,saved:true};});
  async function editor(){await service.hub.ready;const config=service.hub.publicConfig().comfyui||{},url=config.url||'http://127.0.0.1:8188';if(nativeEditor&&nativeEditorURL===url)return nativeEditor;if(config.installDir&&config.pythonPath)await service.hub.providers.comfyui.start();nativeEditor?.close();const cached=nativeEditors.find(item=>item.connectionURL===url);if(cached){nativeEditor=cached;nativeEditorURL=url;return cached;}const {createNativeEditor}=require('./providers/native-editor.cjs');nativeEditor=createNativeEditor({BrowserWindow,Menu,ipcMain,parent:window,url,confirmReplace:async()=>{const r=await dialog.showMessageBox(window,{type:'question',message:'原生编辑器有未同步的更改，是否用所选工作流替换？',buttons:['取消','替换'],defaultId:0,cancelId:0});return r.response===1;},onSave:bundle=>{if((service.hub.publicConfig().comfyui?.url||'http://127.0.0.1:8188')!==url)throw new Error('这个编辑窗口属于旧连接，未覆盖当前映射。请先切回对应连接，再同步。');window.webContents.send('createmore:event',{type:'native-workflow',data:bundle});}});nativeEditor.connectionURL=url;nativeEditorURL=url;nativeEditors.push(nativeEditor);return nativeEditor;}
  handle('createmore:open-comfy',async()=>{await(await editor()).open();return {opened:true};});
  handle('createmore:native-convert',async(gui,options)=>(await editor()).convert(gui,options));
  handle('createmore:native-read',async()=>(await editor()).read());
  await window.loadFile(path.join(__dirname,'ui','index.html'));
  if(process.argv.includes('--production-local-check')){const report=await require('./production-local-check.cjs').run({service,appDir,dataDir,BrowserWindow,window});closing=true;await automation.close();await service.close();app.exit(report.ok?0:1);return;}
  if(process.argv.includes('--diagnose-config')){
    await window.webContents.executeJavaScript('window.CreateMoreDesktop.ready');
    const config=await window.webContents.executeJavaScript('window.desktop.call("provider.config")');const c=config.comfyui||{};
    const form=await window.webContents.executeJavaScript('(async()=>{await window.CreateMoreDesktop.handlers.connections();await window.CreateMoreDesktop.handlers["connection-detail"]({dataset:{provider:"comfyui"}});return Object.fromEntries(["url","installDir","pythonPath","args"].map(key=>[key,document.querySelector("[name="+key+"]")?.value]));})()');
    const report={at:new Date().toISOString(),dataDir,configFile:service.hub.file,loadError:service.hub.loadError||null,comfyui:{url:c.url||null,installDir:c.installDir||null,pythonPath:c.pythonPath||null,args:c.args||[]},form};
    const target=path.join(appDir,'.test-output');await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'config-diagnostic.json'),JSON.stringify(report,null,2));closing=true;await automation.close();await service.close();app.exit(0);return;
  }
  if(process.argv.includes('--document-smoke-test')){
    const testRoot=path.resolve(appDir,'.test-output'),relative=path.relative(testRoot,dataDir);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('工程启动测试必须使用独立测试配置');
    await window.webContents.executeJavaScript('window.CreateMoreDesktop.ready');
    const requested=process.argv.find(arg=>path.extname(arg).toLowerCase()==='.createmore');
    if(!requested)throw new Error('缺少工程测试文件');const target=await service.store.resolveDocument(requested);
    if(!service.current||service.current.projectDir!==target.projectDir||(target.canvasId&&service.current.id!==target.canvasId))throw new Error('启动时未打开指定工程');
    await fs.mkdir(testRoot,{recursive:true});await fs.writeFile(path.join(testRoot,'document-cold-start.json'),JSON.stringify({ok:true,version:app.getVersion(),requested,projectDir:service.current.projectDir,canvasId:service.current.id},null,2));
    closing=true;await automation.close();await service.close();app.exit(0);return;
  }
  if(process.argv.includes('--e2e-test')){const report=await require('./e2e.cjs').run({window,service,appDir,dataDir});closing=true;disposeEditors();await automation.close();await service.close();app.exit(report.ok?0:1);return;}
  window.on('close',async event=>{if(closing)return;event.preventDefault();if(closePending)return;closePending=true;
    try{const allowed=await require('./core/exit-check.cjs').prepareExit({flush:()=>window.webContents.executeJavaScript('window.CreateMoreDesktop?.sync()'),dirty:()=>[...service.sessions.values()].filter(s=>s.dirty),active:()=>service.queue.list().filter(t=>!['succeeded','failed','cancelled'].includes(t.state)),confirm:async({sessions,tasks})=>{const result=await dialog.showMessageBox(window,{type:'question',title:'退出 CreateMore',message:sessions.length?'有未保存的画布更改。':'仍有生成任务未结束。',detail:tasks.length?'退出不会声称远端任务已取消；下次启动会先核对任务状态。ComfyUI 后台保留运行。':'可保存后退出，或取消并继续编辑。ComfyUI 后台保留运行。',buttons:['保存并退出','取消'],defaultId:0,cancelId:1});return result.response===0;},save:c=>service.saveSession(c,false)});if(!allowed)return;
      closing=true;disposeEditors();await automation.close();await service.close();app.quit();
    }catch(e){closing=false;dialog.showErrorBox('保存或退出失败，窗口已保留',e.message);}finally{closePending=false;}});
  if(process.argv.includes('--smoke-test')){const report={app:app.getVersion(),ready:true,renderer:await window.webContents.executeJavaScript("({title:document.title,canvas:!!window.CreateMoreCanvas,desktop:!!window.desktop,node:typeof require,brand:(()=>{const img=document.querySelector('img.brand-mark');return img?{alt:img.alt,loaded:img.complete&&img.naturalWidth>0,width:img.clientWidth,height:img.clientHeight,transform:getComputedStyle(img).transform}:null})()})")};await fs.mkdir(path.join(appDir,'.test-output'),{recursive:true});await fs.writeFile(path.join(appDir,'.test-output','electron-smoke.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(appDir,'.test-output','electron-smoke.png'),(await window.webContents.capturePage()).toPNG());closing=true;await automation.close();await service.close();app.exit(report.renderer.canvas&&report.renderer.desktop&&report.renderer.node==='undefined'&&report.renderer.brand?.loaded&&report.renderer.brand?.alt==='O.o'?0:1);}
}
app.on('window-all-closed',()=>{if(!closing)app.quit();});
