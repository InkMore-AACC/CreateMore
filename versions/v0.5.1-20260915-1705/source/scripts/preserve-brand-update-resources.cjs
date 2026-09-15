'use strict';
// One-time, explicit resource preservation for this logo-only update. Never edits the old release.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function main(){
  const root=path.resolve(__dirname,'..'),previous=path.join(root,'dist/CreateMore-0.1.0-20260907013017-win32-x64'),next=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0].directory;
  if(!path.resolve(next).startsWith(path.join(root,'dist')+path.sep)||path.resolve(previous)===path.resolve(next))throw new Error('Old and new release paths must be distinct in this workspace');
  const records=[];
  async function walk(relative){for(const entry of await fs.readdir(path.join(previous,relative),{withFileTypes:true})){const rel=path.join(relative,entry.name),from=path.join(previous,rel),to=path.join(next,rel);if(entry.isSymbolicLink())throw new Error('Linked resource must be reviewed: '+rel);if(entry.isDirectory()){await walk(rel);continue;}const bytes=await fs.readFile(from),sha256=hash(bytes);let existing;try{existing=hash(await fs.readFile(to));}catch(e){if(e.code!=='ENOENT')throw e;}if(existing===sha256)continue;await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);if(hash(await fs.readFile(from))!==sha256||hash(await fs.readFile(to))!==sha256)throw new Error('Resource changed during copy');records.push({file:rel.replaceAll('\\','/'),sha256,replacedBuiltIn:!!existing});}}
  for(const kind of ['skills','tools','workflows'])await walk(path.join('resources',kind));
  const result={at:new Date().toISOString(),previous,next,files:records,verified:true,scope:'User resource overlay after the source-integrity check; image-zimage/current.json is intentionally different from the factory default'};
  await fs.writeFile(path.join(root,'testing-output/brand-user-resource-preservation.json'),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
