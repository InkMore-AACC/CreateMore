'use strict';
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1400,height:950,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}),checks=[];let ok=false;
  try{await win.loadFile(path.resolve('app/ui/index.html'));const run=code=>win.webContents.executeJavaScript(code),frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await run(`window.C=CreateMoreCanvas;C.graph.state={version:5,nodes:[],edges:[],groups:[],assets:[],view:{x:0,y:0,k:1},seq:0};window.testNode=C.graph.create('image',370,120);C.ui.selected=new Set([testNode.id]);C.render();`);await frame();
    const port=await run(`(()=>{const r=document.querySelector('[data-output]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',...port,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseMove',x:port.x-200,y:port.y+30,button:'left'});
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});win.webContents.sendInputEvent({type:'mouseUp',x:port.x-200,y:port.y+30,button:'left'});await frame();
    assert.equal(await run(`C.ui.drag===null&&C.state().edges.length===0&&document.querySelector('#menu').hidden`),true);checks.push('真实鼠标拖线期间按 Esc 取消，不新增节点或连线');
    const drop=await run(`(()=>{const r=document.querySelector('#workspace').getBoundingClientRect();return {x:Math.round(r.left+80),y:Math.round(r.top+110)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',...port,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseMove',...drop,button:'left'});win.webContents.sendInputEvent({type:'mouseUp',...drop,button:'left'});await frame();
    assert.equal(await run(`!document.querySelector('#menu').hidden&&C.ui.menuAtDrop===true`),true);
    await new Promise(r=>setTimeout(r,160));await run(`document.querySelector('#menu [data-create=text]').click()`);await frame();
    const result=await run(`({nodes:C.state().nodes.map(n=>({x:n.x,y:n.y,type:n.type})),edges:C.state().edges.length})`);assert.equal(result.edges,1);assert.ok(result.nodes.find(n=>n.type==='text').x<result.nodes.find(n=>n.type==='image').x);checks.push('向左拖线创建落在左侧空位，而不是强制跳到右侧');
    await run(`C.state().view={x:0,y:0,k:1};C.state().nodes=C.state().nodes.filter(n=>n.type==='image');C.state().edges=[];const n=C.state().nodes[0];n.x=250;n.y=60;n.w=380;n.h=900;n.ratio='9:16';C.ui.selected=new Set([n.id]);C.render();`);await frame();
    const geometry=await run(`(()=>{const p=document.querySelector('.node.selected .node-params').getBoundingClientRect(),w=document.querySelector('#workspace').getBoundingClientRect();return {p:{top:p.top,bottom:p.bottom,left:p.left,right:p.right},w:{top:w.top,bottom:w.bottom,left:w.left,right:w.right}}})()`);
    assert.ok(geometry.p.top>geometry.w.bottom);assert.ok(geometry.p.right-geometry.p.left>=620);checks.push('竖版高卡片的参数面板保持在卡片下方并允许超出视口，不自动换边或移动画布');ok=true;
  }catch(e){checks.push({error:e.stack});console.error(e);}
  finally{const report={ok,checks,at:new Date().toISOString()};await fs.mkdir(path.resolve('testing-output'),{recursive:true});await fs.writeFile(path.resolve('testing-output/canvas-gestures.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));win.destroy();app.exit(ok?0:1);}
});
