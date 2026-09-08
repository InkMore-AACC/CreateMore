'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateReferences}=require('../app/core/snapshot-inputs.cjs');
test('unassigned media is rejected before creating a queued task',()=>{
  assert.throws(()=>validateReferences({workflow:{mapping:{inputs:[]}},references:[{type:'image',path:'unused.png'}]}),e=>e.code==='REFERENCE_COUNT'&&e.message.includes('不接收参考素材'));
  const workflow={mapping:{inputs:[{id:'image',source:'reference',index:0,mediaType:'image'}]}};
  assert.throws(()=>validateReferences({workflow,references:[{type:'image'},{type:'image'}]}),{code:'REFERENCE_COUNT'});
  assert.doesNotThrow(()=>validateReferences({workflow,references:[{type:'image'}]}));
});
