'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createNativeEditor}=require('../app/providers/native-editor.cjs');
const {WorkflowStore}=require('../app/providers/workflows.cjs');
app.whenReady().then(async()=>{
  const base=path.resolve('testing-output','native-mapping-'+Date.now()),store=new WorkflowStore(path.resolve('resources/workflows/defaults'));
  class HiddenWindow extends BrowserWindow{show(){}}
  let synced=null;const editor=createNativeEditor({BrowserWindow:process.argv.includes('--hidden')?HiddenWindow:BrowserWindow,ipcMain,onSave:async value=>{synced=value;},url:'http://127.0.0.1:8188'});const report={ok:false,base,checks:[]};
  try{await fs.mkdir(base,{recursive:true});const source=await store.read('image-zimage'),original=JSON.stringify(source);
    const result=await editor.convert(source.gui,{mapping:source.mapping,editorContext:'live-test-image'});assert.equal(result.editorContext,'live-test-image');assert.deepEqual(result.mapping,source.mapping);report.checks.push('真实 ComfyUI 前端导入和映射回读');
    const win=await editor.open(),run=code=>win.webContents.executeJavaScript(`(async()=>{const {app}=await import('/scripts/app.js');${code}})()`);
    await run(`app.canvas.selectNode(app.graph.getNodeById(8));return true;`);
    for(let i=0;i<100;i++){if(await run(`return document.querySelector('#createmore-mapping')?.shadowRoot.querySelector('#parameter')?.querySelector('option[value="steps"]')!=null;`))break;if(i===99)throw new Error('真实节点参数面板未出现');await new Promise(r=>setTimeout(r,100));}
    await run(`const root=document.querySelector('#createmore-mapping').shadowRoot;root.querySelector('#parameter').value='steps';root.querySelector('#parameter').dispatchEvent(new Event('change'));root.querySelector('[name=label]').value='实机验证步数';root.querySelector('[name=default]').value='6';root.querySelector('#mapping-form').requestSubmit();return true;`);
    const edited=await editor.read(),steps=edited.mapping.inputs.find(i=>i.id==='steps');assert.equal(steps.label,'实机验证步数');assert.equal(steps.default,6);assert.equal(steps.nodeId,'8');assert.equal(steps.input,'steps');report.checks.push('点击真实采样节点，公开真实 steps 参数并同步');
    assert.ok(await run(`return document.querySelector('#createmore-mapping').shadowRoot.querySelector('#card-preview').textContent.includes('实机验证步数');`));report.checks.push('修改后的公开参数已出现在卡片预览');
    assert.equal(JSON.stringify(await store.read('image-zimage')),original);report.checks.push('未修改默认工作流和用户项目');
    await run(`await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;`);
    report.visibleDOM=await run(`return {splash:!!document.getElementById('splash-loader'),panel:document.querySelector('#createmore-mapping').getBoundingClientRect().toJSON(),canvas:!!app.canvas};`);
    assert.equal(report.visibleDOM.splash,false);
    await fs.writeFile(path.join(base,'native-editor.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    ipcMain.emit('createmore:native-sync',{sender:{}});assert.equal(synced,null);
    await run(`document.querySelector('#createmore-mapping').shadowRoot.querySelector('#sync-back').click();return true;`);
    for(let i=0;i<100&&!synced;i++)await new Promise(r=>setTimeout(r,100));
    assert.equal(synced?.editorContext,'live-test-image');assert.equal(synced.mapping.inputs.find(i=>i.id==='steps').default,6);
    report.checks.push('真实窗口同步按钮回传正确上下文，拒绝其他窗口发送的同步消息');report.ok=true;
  }catch(e){report.error={message:e.message,stack:e.stack};console.error(e);}
  finally{await fs.mkdir(base,{recursive:true});await fs.writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));editor.dispose();app.exit(report.ok?0:1);}
});
