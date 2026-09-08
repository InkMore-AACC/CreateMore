'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=name=>fs.readFileSync(path.join(root,name));
test('O.o sidebar, window and packaged executable share the brand assets',()=>{
  const html=read('app/ui/index.html').toString(),main=read('app/main.cjs').toString(),build=read('scripts/build.cjs').toString();
  assert.match(html,/<img class="brand-mark"[^>]+src="assets\/brand\/oo-logo.png"[^>]+alt="O.o"/);assert(!html.includes('C<span>↗</span>'));
  assert(main.includes("icon:path.join(__dirname,'ui/assets/brand/oo-logo.ico')"));assert(build.includes("app/ui/assets/brand/oo-logo.ico"));assert(build.includes('download:{checksums},icon,'));
});
test('Windows ICO contains all seven valid PNG resolutions, sharing the 256px UI artwork',()=>{
  const ico=read('app/ui/assets/brand/oo-logo.ico'),png=read('app/ui/assets/brand/oo-logo.png'),sizes=[16,24,32,48,64,128,256];
  assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),sizes.length);let end=6+16*sizes.length;
  sizes.forEach((size,index)=>{const pos=6+16*index,length=ico.readUInt32LE(pos+8),offset=ico.readUInt32LE(pos+12);assert.equal(offset,end);assert.equal(ico[pos]||256,size);assert.equal(ico[pos+1]||256,size);const frame=ico.subarray(offset,offset+length);assert.equal(frame.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(frame.readUInt32BE(16),size);assert.equal(frame.readUInt32BE(20),size);if(size===256)assert.deepEqual(frame,png);end+=length;});assert.equal(end,ico.length);
});
