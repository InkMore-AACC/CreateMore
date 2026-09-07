'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {MediaService,run,exportStoryboard}=require('../app/core/media.cjs');
const {Diagnostics}=require('../app/core/diagnostics.cjs');
test('real FFmpeg trims, splits, changes speed, extracts timed frames and audio without overwriting source',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'createmore-media-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source.mp4'),media=new MediaService();
  await run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','color=c=teal:s=128x128:r=24:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);const before=await fs.readFile(source),info=await media.probe(source);assert.ok(info.duration>=2);assert.equal(info.width,128);
  const opts={outputDir:path.join(dir,'results')},snapshot={kind:'video',references:[{path:source}],parameters:{start:.25,end:1.25}};
  const trim=await media.process({...snapshot,tool:'trim'},opts);assert.equal(trim.outputs.length,1);assert.ok((await media.probe(trim.outputs[0].path)).duration<1.2);
  const audio=await media.process({...snapshot,tool:'extract-audio'},opts);assert.equal(audio.outputs[0].type,'audio');
  const frames=await media.process({...snapshot,tool:'frames',parameters:{start:0,end:2,interval:.5}},opts);assert.deepEqual(frames.outputs.map(f=>f.time),[0,.5,1,1.5]);
  const speed=await media.process({...snapshot,tool:'speed',parameters:{start:0,end:2,speed:2}},opts);assert.ok((await media.probe(speed.outputs[0].path)).duration<1.3);
  const split=await media.process({...snapshot,tool:'split',parameters:{start:0,end:2,interval:.8}},opts);assert.equal(split.outputs.length,3);assert.deepEqual(await fs.readFile(source),before);
  await assert.rejects(media.process({...snapshot,tool:'trim',parameters:{start:-1,end:3}},opts));
  const excel=path.join(dir,'shots.xlsx');await exportStoryboard({shots:[{description:'=不应变成公式',prompt:'镜头提示',start:0,end:.5,duration:'.5s',frame:frames.outputs[0].path}],title:'测试',file:excel,resolveImage:async p=>p});const ExcelJS=require('exceljs'),book=new ExcelJS.Workbook();await book.xlsx.readFile(excel);assert.equal(book.worksheets[0].getCell('E2').value,'=不应变成公式');assert.equal(book.worksheets[0].getImages().length,1);
});
test('diagnostic retention only removes owned date logs and preserves key errors',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'createmore-logs-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const logs=await new Diagnostics({dataDir:dir,maxBytes:200,days:30}).init();await fs.writeFile(path.join(logs.root,'keep-user.txt'),'keep');await logs.append({at:'2000-01-01T00:00:00Z',level:'error',message:'token=abc'});assert.equal(await fs.readFile(path.join(logs.root,'keep-user.txt'),'utf8'),'keep');assert.equal((await logs.tail(logs.critical))[0].message,'token=[已脱敏]');assert.equal((await logs.files()).length,0);});
