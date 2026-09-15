'use strict';
const {contextBridge,ipcRenderer,webUtils}=require('electron');
// Plain rejection data survives contextBridge; native Error custom fields do not.
async function invoke(channel,...args){const result=await ipcRenderer.invoke(channel,...args);if(!result?.ok)throw {message:result?.error?.message||'桌面操作失败',code:result?.error?.code||'DESKTOP_ERROR'};return result.value;}
contextBridge.exposeInMainWorld('desktop',Object.freeze({
  call:(method,args={})=>invoke('createmore:call',method,args),
  pickDirectory:()=>invoke('createmore:directory'),
  pendingDocuments:()=>invoke('createmore:pending-documents'),
  associateDocuments:()=>invoke('createmore:associate-documents'),
  pickFiles:(options={})=>invoke('createmore:files',options),
  saveFile:(options={})=>invoke('createmore:save-file',options),
  reveal:assetId=>invoke('createmore:reveal',assetId),
  download:nodeId=>invoke('createmore:download',nodeId),
  openComfy:()=>invoke('createmore:open-comfy'),
  nativeConvert:(gui,options)=>invoke('createmore:native-convert',gui,options),
  nativeRead:()=>invoke('createmore:native-read'),
  readJSON:file=>invoke('createmore:read-json',file),
  onEvent:listener=>{const handle=(_event,data)=>listener(data);ipcRenderer.on('createmore:event',handle);return()=>ipcRenderer.removeListener('createmore:event',handle);},
  filePath:file=>webUtils.getPathForFile(file)
}));
