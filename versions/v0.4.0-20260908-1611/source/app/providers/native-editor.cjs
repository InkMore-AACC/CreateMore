'use strict';
const crypto=require('node:crypto');
const {ProviderError,endpoint}=require('./util.cjs');
const {installNativeMapping}=require('./native-mapping.cjs');
function createNativeEditor({BrowserWindow,Menu,parent,url,bundle,onSave,confirmReplace}={}){
  if(!BrowserWindow)throw new Error('BrowserWindow is required');const base=endpoint(url,'http://127.0.0.1:8188');const origin=new URL(base).origin;let window=null;let ready=null;let savedSignature=null;let nextBundle=bundle;let importing=false;let disposing=false;let editorContext=null;
  const signature=b=>JSON.stringify({nodes:b.gui?.nodes,links:b.gui?.links,groups:b.gui?.groups,definitions:b.gui?.definitions,mapping:b.mapping});
  async function native(expression){if(!window || window.isDestroyed())throw new ProviderError('原生编辑器未打开','EDITOR_CLOSED');return window.webContents.executeJavaScript(`(async()=>{const {app}=await import('/scripts/app.js');${expression}})()`,true);}
  async function read(){await open();const value=await native('const result=await app.graphToPrompt();if(!result?.workflow?.nodes||!result.output)throw new Error("原生前端尚未返回完整转换结果");return {gui:result.workflow,api:result.output,...(window.__createMoreMapper?{mapping:window.__createMoreMapper.state.mapping}:{}),selectedNodeIds:Object.keys(app.canvas?.selected_nodes||{})};');return {...value,editorContext};}
  async function importGui(gui,{replace=false}={}){if(!gui?.nodes || !gui.links)throw new ProviderError('导入内容不是普通工作流 JSON','GUI_INVALID');if(savedSignature){const current=await read();if(signature(current)!==savedSignature&&!replace){if(!confirmReplace || !await confirmReplace())throw new ProviderError('原生编辑器有未同步修改，已保留；请先同步或明确取消这些修改','EDITOR_DIRTY');}}await native(`await app.loadGraphData(${JSON.stringify(gui)},true,false);return true;`);const value=await read();savedSignature=signature(value);return value;}
  async function open(){if(ready){await ready;if(window&&!window.isDestroyed())window.show();return window;}window=new BrowserWindow({parent,width:1400,height:900,minWidth:900,minHeight:650,title:'CreateMore · 原生 ComfyUI 工作流',show:false,backgroundColor:'#171819',webPreferences:{partition:'createmore-native-'+crypto.randomUUID(),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,webviewTag:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,target)=>{if(new URL(target).origin!==origin)event.preventDefault();});
    window.webContents.on('will-attach-webview',e=>e.preventDefault());
    window.on('close',event=>{if(!disposing){event.preventDefault();window.hide();}}); // Closing the editor preserves its unsynchronized draft and does not stop ComfyUI.
    window.on('closed',()=>{window=null;ready=null;savedSignature=null;});
    if(Menu){const menu=Menu.buildFromTemplate([{label:'工作流',submenu:[{label:'同步到 CreateMore',accelerator:'CmdOrCtrl+S',click:async()=>{try{const value=await read();await onSave?.(value);savedSignature=signature(value);}catch(e){window?.webContents.executeJavaScript(`alert(${JSON.stringify('同步失败：'+e.message)})`);}}},{label:'关闭',role:'close'}]}]);window.setMenu(menu);}else window.setMenu(null);
    ready=(async()=>{await window.loadURL(base+'/');await window.webContents.executeJavaScript('(async()=>{for(let i=0;i<240;i++){const app=window.comfyAPI?.app?.app;if(app?.graph&&app.canvas&&app.positionConversion&&typeof app.graphToPrompt==="function")return true;await new Promise(r=>setTimeout(r,250));}throw new Error("ComfyUI 原生前端初始化超时");})()');window.show();return window;})().catch(e=>{ready=null;throw e;});await ready;
    if(nextBundle?.gui&&!importing){const initial=nextBundle.gui;nextBundle=null;importing=true;try{await importGui(initial,{replace:true});}finally{importing=false;}}
    return window;
  }
  async function convert(gui,options={}){await open();await importGui(gui,options);editorContext=options.editorContext||crypto.randomUUID();await native(`(${installNativeMapping.toString()})(app,${JSON.stringify(options.mapping||{inputs:[],outputs:[]})});`);const result=await read();savedSignature=signature(result);return result;}
  async function markSynced(){savedSignature=signature(await read());}
  function close(){window?.close();}
  function dispose(){disposing=true;window?.destroy();}
  return {open,convert,read,markSynced,close,dispose,isOpen:()=>!!window&&!window.isDestroyed()};
}
module.exports={createNativeEditor};
