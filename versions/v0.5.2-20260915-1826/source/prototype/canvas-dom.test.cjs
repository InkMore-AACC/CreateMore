// DOM event checks, not a browser renderer or a screenshot test.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('./.validation/node_modules/linkedom');
const CanvasModel=require('./canvas-model.js');
function boot(){
  const {window}=parseHTML(fs.readFileSync(__dirname+'/main-canvas.html','utf8'));
  const {document,Event}=window,storage=new Map();
  Object.defineProperties(window.HTMLElement.prototype,{
    clientWidth:{configurable:true,get(){return this.id==='workspace'?920:220;}},
    clientHeight:{configurable:true,get(){return this.id==='workspace'?900:140;}}
  });
  window.HTMLElement.prototype.getBoundingClientRect=function(){return {left:this.id==='workspace'?220:20,top:0,right:1140,bottom:200,width:920,height:900};};
  window.HTMLElement.prototype.setPointerCapture=function(){};
  window.HTMLElement.prototype.focus=function(){};
  window.HTMLInputElement.prototype.select=function(){};
  class FormData {
    constructor(form){this.values=[...form.querySelectorAll('[name]')].map(el=>[el.name,el.value]);}
    get(name){return this.values.find(([key])=>key===name)?.[1];}
    [Symbol.iterator](){return this.values[Symbol.iterator]();}
  }
  let now=1000;
  class Clock extends Date {static now(){return now;}}
  const context={document,window:{addEventListener(){}},CanvasModel,innerWidth:1440,innerHeight:900,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},Date:Clock,FormData,Blob,URL,console};
  vm.runInNewContext(fs.readFileSync(__dirname+'/canvas.js','utf8'),context,{filename:'canvas.js'});
  const click=selector=>{const el=document.querySelector(selector);assert.ok(el,'missing '+selector);el.dispatchEvent(new Event('click',{bubbles:true}));};
  const input=(selector,value)=>{const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
  const send=(el,type,props={})=>{const e=new Event(type,{bubbles:true,cancelable:true});Object.assign(e,props);el.dispatchEvent(e);};
  const saved=()=>{click('[data-action="save"]');return JSON.parse([...storage.values()][0]);};
  return {document,click,input,send,Event,saved,advance(){now+=200;}};
}
test('app boots into full canvas with seven nodes, references and resource navigation',()=>{
  const app=boot();assert.equal(app.document.querySelectorAll('.node').length,7);
  assert.match(app.document.querySelector('#agent-refs').textContent,/人物探索/);
  app.click('[data-action="navigation"]');assert.match(app.document.querySelector('#menu').textContent,/局域网/);
});
test('creation menu actually adds selectable card and sidebar entry',()=>{
  const app=boot();app.click('[data-action="create-menu"]');app.click('[data-create="text"]');
  assert.equal(app.document.querySelectorAll('.node').length,8);
  const state=app.saved();assert.equal(state.nodes.at(-1).type,'text');
  assert.equal(app.document.querySelector('.node.selected').dataset.id,state.nodes.at(-1).id);
});
test('pointer click on output survives rerender and opens downstream menu',()=>{
  const app=boot(),port=app.document.querySelector('[data-output="hero"]');
  app.send(port,'pointerdown',{button:0,clientX:600,clientY:320,pointerId:1});
  app.send(app.document,'pointerup',{button:0,clientX:600,clientY:320,pointerId:1});
  assert.equal(app.document.querySelector('#menu').hidden,false);app.advance();
  app.click('[data-create="text"]');const state=app.saved(),last=state.nodes.at(-1);
  assert.ok(state.edges.some(e=>e.from==='hero'&&e.to===last.id));
});
test('rename propagates to card, sidebar, reference chip and persisted state',()=>{
  const app=boot();app.click('.node[data-id="hero"] [data-action="node-menu"]');app.click('[data-action="rename"]');
  app.input('#rename-form input','新构图');app.send(app.document.querySelector('#rename-form'),'submit');
  assert.match(app.document.querySelector('.node[data-id="hero"] .node-title').textContent,/新构图/);
  assert.match(app.document.querySelector('#agent-refs').textContent,/新构图/);
  assert.equal(app.saved().nodes.find(n=>n.id==='hero').title,'新构图');
});
test('script editing and adding a row survives modal close and reopening',()=>{
  const app=boot();app.click('.node[data-id="script"] [data-action="script"]');
  const cell=app.document.querySelector('[data-shot="0"][data-field="description"]');
  cell.textContent='重写镜头';app.send(cell,'input');app.click('[data-action="add-shot"]');
  assert.equal(app.document.querySelectorAll('#panel tbody tr').length,4);
  app.click('[data-action="close-panel"]');app.click('.node[data-id="script"] [data-action="script"]');
  assert.equal(app.document.querySelector('[data-shot="0"][data-field="description"]').textContent,'重写镜头');
});
test('deleting card retains asset library and asset can be added back',()=>{
  const app=boot();app.click('.node[data-id="hero"] [data-action="node-menu"]');app.click('#menu [data-action="delete"]');
  app.click('[data-tab="assets"]');assert.equal(app.document.querySelectorAll('[data-action="use-asset"]').length,2);
  app.click('[data-asset-id="a2"]');assert.equal(app.document.querySelectorAll('.node').length,7);
});
test('queue presents two columns with empty actual state',()=>{
  const app=boot();app.click('[data-action="tasks"]');
  assert.equal(app.document.querySelectorAll('.queue-columns>section').length,2);
  assert.match(app.document.querySelector('#panel-body').textContent,/尚未提交/);
});
test('unsupported generation keeps user input and opens connection prerequisite',()=>{
  const app=boot();app.input('.node[data-id="hero"] [data-prop="prompt"]','保留这段输入');
  app.click('.node[data-id="hero"] [data-action="generation"]');assert.match(app.document.querySelector('#panel-body').textContent,/没有提交任务/);
  app.click('[data-action="close-panel"]');assert.equal(app.saved().nodes.find(n=>n.id==='hero').prompt,'保留这段输入');
});
test('dragging moves node and undo restores its previous coordinates',()=>{
  const app=boot(),before=app.saved().nodes.find(n=>n.id==='hero');
  app.send(app.document.querySelector('.node[data-id="hero"] .node-title'),'pointerdown',{button:0,clientX:600,clientY:250,pointerId:1});
  app.send(app.document,'pointermove',{clientX:680,clientY:290});
  app.send(app.document,'pointerup',{clientX:680,clientY:290});app.advance();
  const after=app.saved().nodes.find(n=>n.id==='hero');assert.ok(after.x>before.x);assert.ok(after.y>before.y);
  app.send(app.document.body,'keydown',{key:'z',ctrlKey:true});
  const restored=app.saved().nodes.find(n=>n.id==='hero');assert.equal(restored.x,before.x);assert.equal(restored.y,before.y);
});
test('dragging between ports creates the requested connection',()=>{
  const app=boot(),port=app.document.querySelector('[data-output="reference"]');
  app.send(port,'pointerdown',{button:0,clientX:600,clientY:250});
  app.send(app.document,'pointermove',{clientX:800,clientY:350});
  app.document.elementFromPoint=()=>app.document.querySelector('[data-input="text"]');
  app.send(app.document,'pointerup',{clientX:800,clientY:350});app.advance();
  assert.ok(app.saved().edges.some(e=>e.from==='reference'&&e.to==='text'));
});
test('wheel zoom changes view transform rather than document scroll',()=>{
  const app=boot(),before=app.saved().view.k;
  app.send(app.document.querySelector('#viewport'),'wheel',{clientX:650,clientY:400,deltaY:-120});
  const after=app.saved().view.k;assert.ok(after>before);
  assert.match(app.document.querySelector('#world').style.transform,/scale/);
});
test('staged configuration survives outside close and explicit cancel discards edits',()=>{
  const app=boot();app.click('[data-action="navigation"]');app.click('#menu [data-action="settings"]');
  app.input('#save-minutes','12');app.click('[data-action="close-panel"]');
  assert.equal(app.document.querySelector('#panel').hidden,false);
  app.click('[data-action="cancel-config"]');assert.equal(app.document.querySelector('#panel').hidden,true);
  assert.equal(app.saved().settings.saveMinutes,5);
});
