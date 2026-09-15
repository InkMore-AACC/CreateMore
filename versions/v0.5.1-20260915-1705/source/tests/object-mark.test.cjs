'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {CreateMoreService,configuredBinding}=require('../app/core/service.cjs');

test('object marking stores a stable prompt link and routes the marked current image as its own reference',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'createmore-object-mark-')),calls=[];
  const hub={async prepare(s){return {...s,connection:{frozen:true}};},async run(snapshot){calls.push(snapshot);return {text:'```json\n{"name":"青色杯子","bbox":{"x":0.32,"y":0.25,"width":0.28,"height":0.5}}\n```'};},async reconcile(){return {state:'unknown'};},async cancel(){return {state:'unknown'};},async status(){return {};},async close(){}};
  const service=await new CreateMoreService({appDir:path.join(root,'app'),dataDir:path.join(root,'data'),hub}).init();
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});});
  await service.createProject(path.join(root,'project'),'标记测试');const file=path.join(root,'cup.png');await fs.writeFile(file,'image bytes');await service.importAsset(file,{copy:true});
  const node=service.current.state.nodes[0];node.cardKind='generator';node.source='Codex Image2';node.prompt='把它改成白色';
  const result=await service.call('mark.identify',{nodeId:node.id,x:.45,y:.48});
  assert.equal(calls.length,1);assert.equal(calls[0].provider,'codex');assert.equal(calls[0].references[0].path,await service.assetPath(node.assetId));assert.equal(calls[0].outputSchema.type,'object');
  assert.equal(result.mark.name,'青色杯子');assert.match(node.prompt,/📌\[青色杯子\]\(createmore-mark:/);assert.deepEqual(configuredBinding(service.settings,node,service.current),{binding:'default:image-qwen-edit-1',route:'singleImage'});
  const snapshot=await service.buildSnapshot(node.id);assert.equal(snapshot.references.length,1);assert.equal(snapshot.references[0].id,node.assetId);assert.match(snapshot.prompt,/图钉标记“青色杯子”/);assert.doesNotMatch(snapshot.prompt,/createmore-mark:/);
});
