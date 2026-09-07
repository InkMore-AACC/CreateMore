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
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
  app.whenReady().then(start).catch(async error=>{await fs.mkdir(dataDir,{recursive:true});await fs.appendFile(path.join(dataDir,'startup-error.log'),new Date().toISOString()+' '+error.stack+'\n');dialog.showErrorBox('CreateMore 启动失败',error.message);app.exit(1);});
}
async function start(){
  service=new CreateMoreService({appDir,dataDir,encryptSecret:text=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 凭据加密不可用，密钥未保存');return safeStorage.encryptString(text).toString('base64');},decryptSecret:value=>safeStorage.decryptString(Buffer.from(value,'base64'))});await service.init();automation=await startAutomation(service,{dataDir});
  protocol.handle('createmore-media',async request=>{try{const url=new URL(request.url);if(url.host!=='asset'||url.search||url.hash)return new Response('Not found',{status:404});const file=service.mediaFiles.get(url.pathname.slice(1));if(!file)return new Response('Not found',{status:404});return await require('./media-protocol.cjs').fileResponse(file,request);}catch{return new Response('Missing asset',{status:404});}});
  window=new BrowserWindow({width:1600,height:980,minWidth:960,minHeight:640,title:'CreateMore',backgroundColor:'#171717',show:!process.argv.includes('--smoke-test')&&!process.argv.includes('--e2e-test'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  Menu.setApplicationMenu(null);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(url!==entry)event.preventDefault();});window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  service.on('event',data=>{if(!window.isDestroyed())window.webContents.send('createmore:event',data);});
  function trusted(event){if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==entry)throw new Error('拒绝来自其他页面的桌面操作');}
  const handle=(name,fn)=>ipcMain.handle(name,async(event,...args)=>{trusted(event);try{return {ok:true,value:await fn(...args)};}catch(error){return {ok:false,error:{code:error.code||'DESKTOP_ERROR',message:error.message||String(error)}};}});
  handle('createmore:call',(method,args)=>service.call(method,args));
  handle('createmore:directory',async()=>{const result=await dialog.showOpenDialog(window,{title:'选择项目或资源目录',properties:['openDirectory','createDirectory']});if(result.canceled)return null;return result.filePaths[0];});
  handle('createmore:files',async(options={})=>{const result=await dialog.showOpenDialog(window,{title:options.title||'选择文件',properties:['openFile',...(options.multiple?['multiSelections']:[])],filters:Array.isArray(options.filters)?options.filters:[]});if(result.canceled)return [];for(const file of result.filePaths)selectedFiles.add(file);return result.filePaths;});
  handle('createmore:save-file',async(options={})=>{const result=await dialog.showSaveDialog(window,{title:options.title||'导出文件',defaultPath:options.name,filters:options.filters});return result.canceled?null:result.filePath;});
  handle('createmore:read-json',async file=>{if(!selectedFiles.has(file))throw new Error('只能读取刚刚选择的文件');if((await fs.stat(file)).size>32*1024*1024)throw new Error('JSON 文件过大');return JSON.parse(await fs.readFile(file,'utf8'));});
  handle('createmore:reveal',async assetId=>{const file=await service.assetPath(assetId);shell.showItemInFolder(file);});
  handle('createmore:download',async nodeId=>{const c=service.requireCurrent(),node=c.state.nodes.find(n=>n.id===nodeId);if(!node)throw new Error('节点不存在');const original=node.assetId?await service.assetPath(node.assetId,c):null,extension=node.type==='script'?'.xlsx':original?path.extname(original):'.txt';const result=await dialog.showSaveDialog(window,{title:'另存内容（原素材保留）',defaultPath:node.title.replace(/[<>:"/\\|?*]/g,'_')+extension});if(result.canceled)return {cancelled:true};if(original&&path.resolve(original).toLowerCase()===path.resolve(result.filePath).toLowerCase())throw new Error('请选择不同于原素材的保存位置');if(node.type==='script')await service.call('storyboard.export',{nodeId,path:result.filePath});else if(original)await fs.copyFile(original,result.filePath);else await fs.writeFile(result.filePath,node.content||node.prompt||'','utf8');return {path:result.filePath,saved:true};});
  async function editor(){await service.hub.ready;const config=service.hub.publicConfig().comfyui||{},url=config.url||'http://127.0.0.1:8188';if(nativeEditor&&nativeEditorURL===url)return nativeEditor;if(config.installDir&&config.pythonPath)await service.hub.providers.comfyui.start();nativeEditor?.close();const cached=nativeEditors.find(item=>item.connectionURL===url);if(cached){nativeEditor=cached;nativeEditorURL=url;return cached;}const {createNativeEditor}=require('./providers/native-editor.cjs');nativeEditor=createNativeEditor({BrowserWindow,Menu,parent:window,url,confirmReplace:async()=>{const r=await dialog.showMessageBox(window,{type:'question',message:'原生编辑器有未同步的更改，是否用所选工作流替换？',buttons:['取消','替换'],defaultId:0,cancelId:0});return r.response===1;},onSave:bundle=>{if((service.hub.publicConfig().comfyui?.url||'http://127.0.0.1:8188')!==url)throw new Error('这个编辑窗口属于旧连接，未覆盖当前映射。请先切回对应连接，再同步。');window.webContents.send('createmore:event',{type:'native-workflow',data:bundle});}});nativeEditor.connectionURL=url;nativeEditorURL=url;nativeEditors.push(nativeEditor);return nativeEditor;}
  handle('createmore:open-comfy',async()=>{await(await editor()).open();return {opened:true};});
  handle('createmore:native-convert',async gui=>(await editor()).convert(gui));
  handle('createmore:native-read',async()=>(await editor()).read());
  await window.loadFile(path.join(__dirname,'ui','index.html'));
  if(process.argv.includes('--e2e-test')){const report=await require('./e2e.cjs').run({window,service,appDir,dataDir});closing=true;disposeEditors();await automation.close();await service.close();app.exit(report.ok?0:1);return;}
  window.on('close',async event=>{if(closing)return;event.preventDefault();if(closePending)return;closePending=true;
    try{const allowed=await require('./core/exit-check.cjs').prepareExit({flush:()=>window.webContents.executeJavaScript('window.CreateMoreDesktop?.sync()'),dirty:()=>[...service.sessions.values()].filter(s=>s.dirty),active:()=>service.queue.list().filter(t=>!['succeeded','failed','cancelled'].includes(t.state)),confirm:async({sessions,tasks})=>{const result=await dialog.showMessageBox(window,{type:'question',title:'退出 CreateMore',message:sessions.length?'有未保存的画布更改。':'仍有生成任务未结束。',detail:tasks.length?'退出不会声称远端任务已取消；下次启动会先核对任务状态。ComfyUI 后台保留运行。':'可保存后退出，或取消并继续编辑。ComfyUI 后台保留运行。',buttons:['保存并退出','取消'],defaultId:0,cancelId:1});return result.response===0;},save:c=>service.saveSession(c,false)});if(!allowed)return;
      closing=true;disposeEditors();await automation.close();await service.close();app.quit();
    }catch(e){closing=false;dialog.showErrorBox('保存或退出失败，窗口已保留',e.message);}finally{closePending=false;}});
  if(process.argv.includes('--smoke-test')){const report={app:app.getVersion(),ready:true,renderer:await window.webContents.executeJavaScript("({title:document.title,canvas:!!window.CreateMoreCanvas,desktop:!!window.desktop,node:typeof require})")};await fs.mkdir(path.join(appDir,'.test-output'),{recursive:true});await fs.writeFile(path.join(appDir,'.test-output','electron-smoke.json'),JSON.stringify(report,null,2));closing=true;await automation.close();await service.close();app.exit(report.renderer.canvas&&report.renderer.desktop&&report.renderer.node==='undefined'?0:1);}
}
app.on('window-all-closed',()=>{if(!closing)app.quit();});
