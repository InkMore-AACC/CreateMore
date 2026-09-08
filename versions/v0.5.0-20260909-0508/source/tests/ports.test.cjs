'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Model=require('../app/ui/canvas-model.js');
const {Graph,ports,portPoint,nodeHeight}=Model;
function custom(id,fields={}){return {id,type:'custom',owner:'me',x:400,y:100,w:330,h:220,title:id,content:'',prompt:'',shots:[],workflow:{mapping:{inputs:[{id:'left',source:'reference',mediaType:'image',index:0,label:'左参考图'},{id:'right',source:'reference',mediaType:'image',index:1,label:'右参考图'},{id:'voices',source:'reference',mediaType:'audio',index:2,multiple:true},{id:'instruction',source:'prompt'},{id:'steps',source:'parameter',type:'number'}],outputs:[{id:'picture',mediaType:'image',label:'完成图'},{id:'sound',type:'audio',label:'配音'},{id:'words',type:'text'}]}},...fields};}
function normal(id,type='image',fields={}){return {id,type,owner:'me',x:10,y:100,w:300,h:200,title:id,content:'',prompt:'',shots:[],...fields};}
function state(nodes=[normal('source'),normal('source2'),normal('voice','audio'),custom('target')]){return {version:5,nodes,edges:[],groups:[],assets:[],view:{x:0,y:0,k:1},seq:10,chat:[],settings:{saveMinutes:5}};}

test('workflow reference ports retain names, media types, index and cardinality; control ports are distinct',()=>{
  const n=custom('n'),inputs=ports(n,'input'),outputs=ports(n,'output');
  assert.deepEqual(inputs.map(p=>p.id),['left','right','voices','$prompt','$style']);
  assert.equal(inputs[2].index,2);assert.equal(inputs[2].multiple,true);assert.equal(inputs[0].label,'左参考图');assert.equal(inputs[3].control,true);
  assert.deepEqual(outputs.map(p=>p.mediaType),['image','audio','text']);
  n.workflow.mapping.inputs=n.workflow.mapping.inputs.filter(p=>p.source!=='prompt');assert(!ports(n,'input').some(p=>p.id==='$prompt'));
});
test('normal nodes keep legacy single ports and allow several distinct reference sources',()=>{
  const graph=new Graph(state([normal('a'),normal('b'),normal('c')]));
  graph.connect('a','c');graph.connect('b','c');assert.equal(ports(graph.get('a'),'output').length,1);
  assert(graph.state.edges.every(e=>e.inputId===undefined&&e.outputId===undefined));assert.throws(()=>graph.connect('a','c'),/已经连接/);
});
test('the same node pair can connect different ports; single and multiple inputs enforce their capacity',()=>{
  const graph=new Graph(state());graph.connect('source','target',{inputId:'left'});graph.connect('source','target',{inputId:'right'});
  assert.deepEqual(graph.state.edges.map(e=>e.inputId),['left','right']);assert.throws(()=>graph.connect('source2','target',{inputId:'left'}),/一个来源/);
  graph.state.nodes.push(normal('voice2','audio'));graph.connect('voice','target',{inputId:'voices'});graph.connect('voice2','target',{inputId:'voices'});
  assert.equal(graph.state.edges.filter(e=>e.inputId==='voices').length,2);assert.throws(()=>graph.connect('voice','target',{inputId:'voices'}),/已经连接/);
});
test('named output media types are checked and invalid ports cannot silently fall back',()=>{
  const graph=new Graph(state([custom('producer'),custom('target')]));
  assert.throws(()=>graph.connect('producer','target',{outputId:'sound',inputId:'left'}),/类型不兼容/);
  assert.throws(()=>graph.connect('producer','target',{outputId:'missing',inputId:'left'}),/不存在/);
  assert.throws(()=>graph.connect('producer','target',{outputId:'picture',inputId:'missing'}),/不存在/);
  graph.connect('producer','target',{outputId:'sound',inputId:'voices'});assert.equal(graph.state.edges[0].outputId,'sound');
});
test('style and prompt controls accept only their actual source kinds and preserve explicit ids',()=>{
  const graph=new Graph(state([normal('style','style'),normal('text','text'),normal('image'),custom('target')]));
  graph.connect('style','target',{inputId:'$style'});graph.connect('text','target',{inputId:'$prompt'});
  assert.throws(()=>graph.connect('image','target',{inputId:'$prompt'}),/类型不兼容/);assert.throws(()=>graph.connect('text','target',{inputId:'$style'}),/类型不兼容/);
  assert.deepEqual(graph.portIds(graph.get('style'),graph.get('target')), {inputId:'$style'});
});
test('owner and cycle protection cannot be bypassed with a different named port',()=>{
  const graph=new Graph(state([custom('a'),custom('b'),custom('peer',{owner:'other-member'})]));
  assert.throws(()=>graph.connect('a','peer',{outputId:'picture',inputId:'left'}),/自己的节点/);
  graph.connect('a','b',{outputId:'picture',inputId:'left'});assert.throws(()=>graph.connect('b','a',{outputId:'picture',inputId:'right'}),/循环/);
});
test('copy and undo preserve exact port identities, and node creation retains chosen output port',()=>{
  const graph=new Graph(state([custom('a'),custom('b')]));graph.connect('a','b',{inputId:'left',outputId:'picture'});
  const copies=graph.copy(['a','b']),edge=graph.state.edges.find(e=>e.to===copies[1].id);assert.equal(edge.inputId,'left');assert.equal(edge.outputId,'picture');
  assert(graph.undo());assert.equal(graph.state.nodes.length,2);assert.equal(graph.state.edges[0].outputId,'picture');
  const n=graph.create('text',900,200,'a',{outputId:'words'});assert.equal(graph.state.edges.find(e=>e.to===n.id).outputId,'words');
});
test('wire endpoints use each real named port and dense port lists grow node bounds',()=>{
  const n=custom('n'),left=portPoint(n,'input','left'),right=portPoint(n,'input','right'),sound=portPoint(n,'output','sound');
  assert.notEqual(left.y,right.y);assert.equal(left.x,n.x-20);assert.equal(sound.x,n.x+n.w+20);
  n.workflow.mapping.inputs=Array.from({length:20},(_,i)=>({id:'input'+i,source:'reference',mediaType:'image'}));
  assert(nodeHeight(n)>n.h);assert(portPoint(n,'input','input19').y<n.y+nodeHeight(n));assert.equal(new Graph(state([n])).bounds().h,nodeHeight(n));
});

function boot(snapshot){
  const {parseHTML}=require('../prototype/.validation/node_modules/linkedom');
  const {window}=parseHTML(fs.readFileSync(path.join(__dirname,'../app/ui/index.html'),'utf8')),document=window.document;
  Object.defineProperties(window.HTMLElement.prototype,{clientWidth:{configurable:true,get(){return this.id==='workspace'?1000:220;}},clientHeight:{configurable:true,get(){return this.id==='workspace'?900:140;}}});
  window.HTMLElement.prototype.getBoundingClientRect=function(){return {left:20,top:20,right:1000,bottom:900,width:1000,height:900};};
  window.HTMLElement.prototype.setPointerCapture=function(){};window.HTMLElement.prototype.focus=function(){};
  const context={window,document,CanvasModel:Model,innerWidth:1440,innerHeight:1000,CustomEvent:window.CustomEvent,localStorage:{getItem:()=>JSON.stringify(snapshot),setItem(){}},requestAnimationFrame:()=>1,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},Date,Blob,URL,console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/ui/canvas.js'),'utf8'),context);
  const send=(el,type,props={})=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,props);el.dispatchEvent(e);};
  const click=selector=>{const el=document.querySelector(selector);assert(el,'Missing '+selector);send(el,'click');};
  return {document,app:window.CreateMoreCanvas,send,click};
}
test('actual canvas DOM displays named ports and input-reference clicks store the chosen role',()=>{
  const ui=boot(state());assert.equal(ui.document.querySelectorAll('[data-input="target"]').length,5);assert.equal(ui.document.querySelectorAll('[data-output="target"]').length,3);
  ui.click('[data-input="target"][data-input-id="right"]');ui.click('#menu [data-action="add-reference"][data-from="source"][data-input-id="right"]');
  assert.equal(ui.app.state().edges[0].inputId,'right');assert.match(ui.document.querySelector('[data-edge]').getAttribute('d'),new RegExp(portPoint(ui.app.graph.get('target'),'input','right').y+'$'));
});
test('dragging a named output to a named input stores both port ids',()=>{
  const ui=boot(state([custom('a'),custom('b')]));
  ui.send(ui.document.querySelector('[data-output="a"][data-output-id="sound"]'),'pointerdown',{button:0,clientX:500,clientY:200});
  ui.send(ui.document,'pointermove',{clientX:900,clientY:300});ui.document.elementFromPoint=()=>ui.document.querySelector('[data-input="b"][data-input-id="voices"]');
  ui.send(ui.document,'pointerup',{clientX:900,clientY:300});assert.equal(ui.app.state().edges[0].inputId,'voices');assert.equal(ui.app.state().edges[0].outputId,'sound');
});
test('a wire dropped anywhere on a compatible card connects without hitting its small input dot',()=>{
  const ui=boot(state([normal('a'),normal('b')]));
  ui.send(ui.document.querySelector('[data-output="a"]'),'pointerdown',{button:0,clientX:500,clientY:200});
  ui.send(ui.document,'pointermove',{clientX:900,clientY:300});ui.document.elementFromPoint=()=>ui.document.querySelector('.node[data-id="b"] .node-face');
  ui.send(ui.document,'pointerup',{clientX:900,clientY:300});assert.equal(ui.app.state().edges[0].from,'a');assert.equal(ui.app.state().edges[0].to,'b');
});
test('new cards stay at the pointer world position and never recenter the canvas',()=>{const ui=boot(state([])),before={...ui.app.state().view};ui.app.ui.menuPoint={x:643,y:417};const n=ui.app.create('image',null);assert.equal(n.x,643);assert.equal(n.y,417);assert.deepEqual({...ui.app.state().view},before);assert.equal(n.cardKind,'generator');});
test('loaded image and video cards adopt their real media aspect ratio',()=>{const uri='createmore-media://asset/real',ui=boot(state([normal('portrait','image',{asset:uri,content:'素材',cardKind:'asset'}),normal('wide','video',{asset:uri,content:'素材',cardKind:'asset'})])),img=ui.document.querySelector('[data-canvas-media="portrait"]'),video=ui.document.querySelector('[data-canvas-media="wide"]');Object.defineProperties(img,{naturalWidth:{value:800},naturalHeight:{value:1200},complete:{value:true}});ui.send(img,'load');assert.equal(ui.app.graph.get('portrait').h,420);assert.equal(ui.app.graph.get('portrait').w,280);Object.defineProperties(video,{videoWidth:{value:1920},videoHeight:{value:1080}});ui.send(video,'loadedmetadata');assert.equal(ui.app.graph.get('wide').w,420);assert.equal(ui.app.graph.get('wide').h,236);});
test('custom media uses its actual video, audio or text preview; absent audio has no invented waveform',()=>{
  const uri='createmore-media://asset/test',ui=boot(state([custom('video',{outputType:'video',asset:uri}),custom('audio',{outputType:'audio',asset:uri}),custom('text',{outputType:'text',content:'真实文字结果'}),normal('empty','audio',{content:'旧版波形示例'})]));
  assert(ui.document.querySelector('.node[data-id="video"] video'));assert(ui.document.querySelector('.node[data-id="audio"] audio'));assert.match(ui.document.querySelector('.node[data-id="text"] .text-content').textContent,/真实文字结果/);
  assert(!ui.document.querySelector('.wave'));assert.match(ui.document.querySelector('.node[data-id="empty"]').textContent,/暂无音频文件/);
});
test('image count badge uses actual stored outputs rather than requested sample count',()=>{
  const uri='createmore-media://asset/test',ui=boot(state([normal('image','image',{asset:uri,count:99,outputAssets:['a','b','c']})]));
  assert.equal(ui.document.querySelector('.media-count').textContent.trim(),'3 张');assert(!ui.document.querySelector('.media-count').textContent.includes('示例'));
  ui.app.graph.get('image').outputAssets=[];ui.app.render();assert(!ui.document.querySelector('.media-count'));
});

test('viewport test accounts for pan zoom and the full named-port node height',()=>{const n=normal('test');assert(Model.inViewport(n,{x:0,y:0,k:1},{width:1000,height:900}));assert(!Model.inViewport(n,{x:-2000,y:0,k:1},{width:1000,height:900}));assert(Model.inViewport(n,{x:-40,y:0,k:.2},{width:1000,height:900}));assert(!Model.inViewport(n,{x:1200,y:0,k:1},{width:1000,height:900}));});
test('offscreen media unloads and pauses while cards ports wires and persistent values remain',()=>{
  const uri='createmore-media://asset/real',snapshot=state([normal('near','video',{asset:uri}),normal('far','video',{asset:uri,x:5000}),normal('picture','image',{asset:uri,x:5000})]);snapshot.edges=[{id:'edge',from:'near',to:'far'}];const ui=boot(snapshot),near=ui.document.querySelector('[data-canvas-media="near"]'),far=ui.document.querySelector('[data-canvas-media="far"]');
  assert.equal(near.getAttribute('src'),uri);assert.equal(far.getAttribute('src'),null);assert.equal(near.getAttribute('preload'),'none');let paused=0,unloaded=0;near.pause=()=>paused++;near.load=()=>unloaded++;near.currentTime=3.5;near.volume=.6;near.playbackRate=1.25;
  ui.app.state().view.x=-5000;ui.app.updateMediaVisibility();assert.equal(near.getAttribute('src'),null);assert.equal(far.getAttribute('src'),uri);assert.equal(paused,1);assert.equal(unloaded,1);assert.equal(ui.document.querySelectorAll('.node').length,3);assert.equal(ui.document.querySelectorAll('[data-input]').length,3);assert.equal(ui.document.querySelectorAll('[data-edge]').length,1);assert.equal(ui.app.graph.get('near').asset,uri);
  ui.app.state().view.x=0;ui.app.updateMediaVisibility();near.currentTime=0;ui.send(near,'loadedmetadata');assert.equal(near.currentTime,3.5);assert.equal(near.volume,.6);assert.equal(near.playbackRate,1.25);assert.equal(near.hasAttribute('autoplay'),false);
});
test('media elements survive ordinary canvas rerenders and selected media is usable without loading offscreen selections',()=>{const uri='createmore-media://asset/test',ui=boot(state([normal('near','video',{asset:uri}),normal('far','audio',{asset:uri,x:5000})]));const near=ui.document.querySelector('[data-canvas-media="near"]');ui.app.ui.selected=new Set(['near']);ui.app.render();assert.equal(ui.document.querySelector('[data-canvas-media="near"]'),near);assert.equal(near.preload,'metadata');ui.app.ui.selected=new Set(['far']);ui.app.updateMediaVisibility();assert.equal(ui.document.querySelector('[data-canvas-media="far"]').getAttribute('src'),null);});
test('rapid viewport return before metadata does not replace the remembered playback position with zero',()=>{const uri='createmore-media://asset/test',ui=boot(state([normal('video','video',{asset:uri})])),video=ui.document.querySelector('video');video.currentTime=4;video.pause=()=>{};video.load=()=>{video.currentTime=0;};ui.app.state().view.x=-5000;ui.app.updateMediaVisibility();ui.app.state().view.x=0;ui.app.updateMediaVisibility();ui.app.state().view.x=-5000;ui.app.updateMediaVisibility();ui.app.state().view.x=0;ui.app.updateMediaVisibility();ui.send(video,'loadedmetadata');assert.equal(video.currentTime,4);});
test('ordinary media hides generation UI while generated images expose the shared size menu',()=>{const ui=boot(state([normal('video','video',{source:'本地 ComfyUI',count:99,quality:'4K'}),normal('text','text',{source:'Codex'}),normal('audio','audio',{source:'本地 ComfyUI'}),normal('image','image',{source:'本地 ComfyUI',count:4,quality:'4K'}),normal('image2','image',{source:'Codex Image2',count:2,ratio:'1:1'}),normal('asset','image',{asset:'createmore-media://asset/test',content:'导入素材',cardKind:'asset'})]));assert.equal(ui.document.querySelector('[data-prop="web"]'),null);assert.equal(ui.document.querySelector('[data-prop="autoLink"]'),null);assert.equal(ui.document.querySelector('.node[data-id="asset"] .node-params'),null);assert.equal(ui.document.querySelector('.node[data-id="video"] [data-action="spec"]'),null);assert.match(ui.document.querySelector('.node[data-id="image"] [data-action="spec"]').textContent,/16:9 · 4K · 4张/);ui.click('.node[data-id="image"] [data-action="spec"]');assert(ui.document.querySelector('[name="quality"]'));assert(ui.document.querySelector('[name="ratio"]'));assert.match(ui.document.querySelector('#panel-body').textContent,/3K/);ui.click('[data-action="close-panel"]');ui.click('.node[data-id="image2"] [data-action="spec"]');assert(ui.document.querySelector('[name="ratio"]'));assert.match(ui.document.querySelector('#panel-body').textContent,/自定义/);});
