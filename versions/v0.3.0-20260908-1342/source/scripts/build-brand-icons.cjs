'use strict';
// Asset-only conversion. The checked-in ICO is used by ordinary builds; no new runtime dependency.
const fs=require('node:fs/promises'),path=require('node:path');
async function main(){
  const sharp=require(process.argv[2]||'sharp'),dir=path.resolve(__dirname,'../app/ui/assets/brand'),stem=process.argv[3]||'oo-logo';if(!['oo-logo','oo-project'].includes(stem))throw new Error('Unknown brand asset');const input=path.join(dir,stem+'-master.png');
  const sizes=[16,24,32,48,64,128,256],frames=await Promise.all(sizes.map(size=>sharp(input).resize(size,size,{fit:'contain'}).png().toBuffer()));
  const header=Buffer.alloc(6+16*frames.length);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);let offset=header.length;
  frames.forEach((frame,index)=>{const start=6+16*index,size=sizes[index];header[start]=header[start+1]=size===256?0:size;header.writeUInt16LE(1,start+4);header.writeUInt16LE(32,start+6);header.writeUInt32LE(frame.length,start+8);header.writeUInt32LE(offset,start+12);offset+=frame.length;});
  await fs.writeFile(path.join(dir,stem+'.png'),frames.at(-1));await fs.writeFile(path.join(dir,stem+'.ico'),Buffer.concat([header,...frames]));
  process.stdout.write(JSON.stringify({sizes,png:path.join(dir,stem+'.png'),ico:path.join(dir,stem+'.ico')})+'\n');
}
main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
