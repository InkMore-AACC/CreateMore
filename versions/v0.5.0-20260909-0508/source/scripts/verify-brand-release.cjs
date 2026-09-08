'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
async function main(){
  const root=path.resolve(__dirname,'..'),release=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0],{NtExecutable,NtExecutableResource}=await import('resedit');
  const ico=await fs.readFile(path.join(root,'app/ui/assets/brand/oo-logo.ico')),frames=[];for(let i=0;i<ico.readUInt16LE(4);i++){const p=6+i*16;frames.push(ico.subarray(ico.readUInt32LE(p+12),ico.readUInt32LE(p+12)+ico.readUInt32LE(p+8)));}
  const entries=NtExecutableResource.from(NtExecutable.from(await fs.readFile(release.exe))).entries.filter(e=>e.type===3);assert.equal(entries.length,frames.length);
  for(const frame of frames)assert(entries.some(e=>Buffer.from(e.bin).equals(frame)),'An embedded EXE icon differs from the brand ICO');
  const bundled=path.join(release.directory,'resources/app/app/ui/assets/brand');for(const name of ['oo-logo.png','oo-logo.ico'])assert.deepEqual(await fs.readFile(path.join(bundled,name)),await fs.readFile(path.join(root,'app/ui/assets/brand',name)));
  process.stdout.write(JSON.stringify({version:release.version,exe:release.exe,embeddedIconFrames:entries.length,allEmbeddedFramesMatch:true,bundledAssetsMatch:true},null,2)+'\n');
}
main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
