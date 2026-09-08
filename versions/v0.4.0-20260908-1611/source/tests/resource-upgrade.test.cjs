'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {mergePreviousResources}=require('../app/core/resource-upgrade.cjs');
test('resource upgrade replaces only known pristine builtins and keeps user edits and catalog choices',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cm-upgrade-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const old=path.join(root,'old'),next=path.join(root,'next');
  for(const base of [old,next])for(const kind of ['skills','tools','workflows'])await fs.mkdir(path.join(base,kind),{recursive:true});
  await fs.writeFile(path.join(old,'tools/pristine'),'stock');await fs.writeFile(path.join(next,'tools/pristine'),'new implementation');
  await fs.writeFile(path.join(old,'tools/modified'),'user change');await fs.writeFile(path.join(next,'tools/modified'),'new implementation');
  await fs.writeFile(path.join(old,'workflows/catalog.json'),JSON.stringify([{id:'original',version:'user-version'}]));await fs.writeFile(path.join(next,'workflows/catalog.json'),JSON.stringify([{id:'original',version:'stock-version'},{id:'new-speech',version:'new'}]));
  const sha=crypto.createHash('sha256').update('stock').digest('hex');const result=await mergePreviousResources(old,next,{'tools/pristine':sha,'tools/modified':sha});
  assert.equal(await fs.readFile(path.join(next,'tools/pristine'),'utf8'),'new implementation');assert.equal(await fs.readFile(path.join(next,'tools/modified'),'utf8'),'user change');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(next,'workflows/catalog.json'),'utf8')),[{id:'original',version:'user-version'},{id:'new-speech',version:'new'}]);assert.equal(result.preserved,1);assert.deepEqual(result.newCatalogEntries,['new-speech']);
});
