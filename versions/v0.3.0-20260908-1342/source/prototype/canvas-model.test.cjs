const test=require('node:test');
const assert=require('node:assert/strict');
const {Graph,seed,types}=require('./canvas-model.js');
test('seed restores all nodes, edges and groups',()=>assert.ok(Graph.valid(seed())));
test('invalid persisted graph is rejected',()=>{
  const s=seed();s.edges.push({id:'bad',from:'missing',to:'hero'});assert.equal(Graph.valid(s),false);
  const s2=seed();s2.view.k=Infinity;assert.equal(Graph.valid(s2),false);
});
test('create from output adds downstream node and exact edge; undo restores graph',()=>{
  const g=new Graph(),before=JSON.stringify(g.state),n=g.create('text',1000,300,'hero');
  assert.equal(g.state.edges.at(-1).from,'hero');assert.equal(g.state.edges.at(-1).to,n.id);
  assert.match(n.prompt,/引用/);assert.equal(g.undo(),true);
  const original=JSON.parse(before);assert.deepEqual(g.state,original);
  g.redo();assert.ok(g.get(n.id));
});
test('type incompatible connections are rejected',()=>{
  const g=new Graph();assert.throws(()=>g.connect('audio','hero'),/不兼容/);
  assert.throws(()=>g.create('image',1,1,'audio'),/不能直接连接/);
});
test('duplicate and cyclic links are rejected without edge mutation',()=>{
  const g=new Graph();assert.throws(()=>g.connect('reference','hero'),/已经连接/);
  const a=g.create('text',1,1),b=g.create('text',2,2),c=g.create('text',3,3);
  g.connect(a.id,b.id);g.connect(b.id,c.id);const count=g.state.edges.length;
  assert.throws(()=>g.connect(c.id,a.id),/循环/);assert.equal(g.state.edges.length,count);
});
test('copy selection keeps internal edges and removes outside links',()=>{
  const g=new Graph(),copies=g.copy(['reference','hero']);
  const ids=copies.map(n=>n.id),edges=g.state.edges.filter(e=>ids.includes(e.to)||ids.includes(e.from));
  assert.equal(copies.length,2);assert.equal(edges.length,1);
  assert.deepEqual([edges[0].from,edges[0].to],ids);
  assert.equal(copies[1].prompt,g.get('hero').prompt);assert.equal(copies[1].asset,g.get('hero').asset);
  copies[1].prompt='changed';assert.notEqual(copies[1].prompt,g.get('hero').prompt);
});
test('copies do not inherit failed task state',()=>{
  const g=new Graph(),[n]=g.copy(['failure']);assert.equal(n.taskId,undefined);assert.equal(n.error,undefined);
});
test('delete is undoable and cleans related edges and group membership',()=>{
  const g=new Graph();g.remove(['hero','audio']);
  assert.equal(g.get('hero'),undefined);assert.ok(g.state.edges.every(e=>e.from!=='hero'&&e.to!=='hero'));
  assert.deepEqual(g.state.groups[0].members,['failure']);g.undo();assert.ok(g.get('hero'));assert.ok(g.get('audio'));
});
test('deleting a canvas card preserves independent material records',()=>{
  const g=new Graph(),assets=JSON.stringify(g.state.assets);g.remove(['reference','hero']);
  assert.equal(JSON.stringify(g.state.assets),assets);
});
test('group moves nodes out of former group and undo restores prior membership',()=>{
  const g=new Graph(),newGroup=g.group(['audio','text']);
  assert.deepEqual(newGroup.members,['audio','text']);assert.deepEqual(g.state.groups[0].members,['failure']);
  g.undo();assert.deepEqual(g.state.groups[0].members,['audio','failure']);
});
test('ownership prevents deletion and input modification but allows copying',()=>{
  const g=new Graph();g.get('hero').owner='member';g.remove(['hero']);assert.ok(g.get('hero'));
  assert.throws(()=>g.connect('text','hero'),/自己的/);assert.equal(g.copy(['hero'])[0].owner,'me');
});
test('source menu never offers text or image-only sources for video',()=>{
  assert.deepEqual(types.video.sources,['本地 ComfyUI','外部 API']);
});
test('undo and redo preserve edited shot and prompt data',()=>{
  const g=new Graph();g.checkpoint();g.get('script').shots[0].description='edited';g.get('hero').prompt='new';
  g.undo();assert.notEqual(g.get('script').shots[0].description,'edited');g.redo();
  assert.equal(g.get('script').shots[0].description,'edited');assert.equal(g.get('hero').prompt,'new');
});
test('persisted graph roundtrip preserves state exactly',()=>{
  const g=new Graph();g.create('video',50,70);g.group(['reference','hero']);
  const restored=new Graph(JSON.parse(JSON.stringify(g.state)));assert.deepEqual(restored.state,g.state);
});
