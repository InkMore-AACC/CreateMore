'use strict';
const {spawn}=require('node:child_process');
const {fs,path,id,fail}=require('./util.cjs');
function run(command,args,{signal,onProgress,onSpawn}={}){return new Promise((resolve,reject)=>{
  if(signal?.aborted){const e=new Error('本地媒体处理已取消');e.code='CANCELLED';e.confirmed=true;reject(e);return;}
  const p=spawn(command,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',failure=null;
  const abort=()=>{const e=new Error('本地媒体处理已取消');e.code='CANCELLED';e.confirmed=true;failure=e;p.kill();};signal?.addEventListener('abort',abort,{once:true});onSpawn?.(p);
  p.stdout.on('data',b=>{stdout+=b;if(stdout.length>8e6){failure=new Error('媒体程序输出过大');p.kill();}});p.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);onProgress?.({message:'本地媒体处理中'});});p.on('error',e=>{failure=e;});p.on('close',code=>{signal?.removeEventListener('abort',abort);if(failure)reject(failure);else if(code===0)resolve(stdout);else reject(new Error(`媒体处理失败 (${code})：${stderr.slice(-2500)}`));});
});}
class MediaService {
  constructor({ffmpeg='ffmpeg',ffprobe='ffprobe'}={}){this.ffmpeg=ffmpeg;this.ffprobe=ffprobe;this.jobs=new Map();}
  async status(){try{await run(this.ffmpeg,['-version']);await run(this.ffprobe,['-version']);return {available:true};}catch(e){return {available:false,reason:e.message};}}
  async probe(file,options){const result=JSON.parse(await run(this.ffprobe,['-v','error','-show_format','-show_streams','-of','json',file],options));return {duration:Number(result.format?.duration)||0,width:result.streams.find(s=>s.codec_type==='video')?.width,height:result.streams.find(s=>s.codec_type==='video')?.height,streams:result.streams,format:result.format};}
  async process(snapshot,options={}){
    const token=id('media-job'),controller=new AbortController();let done;const job={controller,children:new Set(),done:new Promise(r=>done=r)};this.jobs.set(token,job);
    const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    const progress=p=>options.onProgress?.({...p,remoteId:{type:'media',id:token}});
    progress({message:'准备本地媒体处理'});
    try{return await this.processOwned(snapshot,{...options,signal,onProgress:progress,onSpawn:child=>{job.children.add(child);child.once('close',()=>job.children.delete(child));options.onSpawn?.(child);}});}finally{this.jobs.delete(token);done();}
  }
  async cancel({remoteId}={}){const job=remoteId?.type==='media'&&this.jobs.get(remoteId.id);if(!job)return {state:'unknown',message:'没有仍由本机此任务持有的媒体进程；未终止其他程序'};job.controller.abort();await job.done;if(job.children.size)fail('媒体子进程尚未确认退出');return {state:'cancelled'};}
  async close(){const jobs=[...this.jobs.values()];for(const job of jobs)job.controller.abort();await Promise.all(jobs.map(job=>job.done));}
  async processOwned(snapshot,options={}){
    const source=snapshot.references?.[0]?.path;if(!source)fail('需要一个已保存的源素材');await fs.access(source);await fs.mkdir(options.outputDir,{recursive:true});
    const p=snapshot.parameters||{},info=await this.probe(source,options),tool=snapshot.tool;
    const start=Number(p.start||0),end=p.end==null||p.end===''?info.duration:Number(p.end);
    if(!Number.isFinite(start)||start<0||!Number.isFinite(end)||end<=start||end>info.duration+.1)fail('时间范围必须位于源素材有效时长内');
    const video=info.streams.some(s=>s.codec_type==='video'),type=snapshot.kind==='image'?'image':video?'video':'audio';
    const outputs=[];const execute=async(args,ext,outType)=>{const target=path.join(options.outputDir,id('media')+ext);await run(this.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n',...args,target],options);const st=await fs.stat(target);if(!st.size)fail('媒体输出为空');outputs.push({path:target,type:outType});return target;};
    if(tool==='frame'){await execute(['-ss',String(start),'-i',source,'-frames:v','1'],' .png'.trim(),'image');}
    else if(tool==='extract-audio'){if(!info.streams.some(s=>s.codec_type==='audio'))fail('原视频没有音轨');await execute(['-ss',String(start),'-i',source,'-t',String(end-start),'-vn','-c:a','pcm_s16le'],'.wav','audio');}
    else if(tool==='trim'){await execute(['-ss',String(start),'-i',source,'-t',String(end-start),...(video?['-c:v','libx264','-preset','fast','-crf','18','-c:a','aac']:['-c:a','pcm_s16le'])],video?'.mp4':'.wav',type);}
    else if(tool==='speed'){const speed=Number(p.speed||1);if(!Number.isFinite(speed)||speed<.25||speed>4)fail('速度范围为 0.25 到 4');const audioFilter=[];let a=speed;while(a>2){audioFilter.push('atempo=2');a/=2;}while(a<.5){audioFilter.push('atempo=0.5');a/=.5;}audioFilter.push('atempo='+a);const args=['-ss',String(start),'-i',source,'-t',String(end-start)];if(video)args.push('-filter:v',`setpts=PTS/${speed}`,'-c:v','libx264','-preset','fast');if(info.streams.some(s=>s.codec_type==='audio'))args.push('-filter:a',audioFilter.join(','),'-c:a',video?'aac':'pcm_s16le');await execute(args,video?'.mp4':'.wav',type);}
    else if(tool==='split'){const interval=Number(p.interval||5);if(interval<.1||interval>3600||!Number.isFinite(interval))fail('切分间隔无效');const count=Math.ceil((end-start)/interval);if(count>200)fail('单次最多切分 200 段');for(let i=0;i<count;i++){const time=start+i*interval;await execute(['-ss',String(time),'-i',source,'-t',String(Math.min(interval,end-time)),...(video?['-c:v','libx264','-preset','fast','-c:a','aac']:['-c:a','pcm_s16le'])],video?'.mp4':'.wav',type);}}
    else if(tool==='frames'){const interval=Number(p.interval||3);if(interval<.1||!Number.isFinite(interval))fail('取帧间隔无效');const count=Math.ceil((end-start)/interval);if(count>120)fail('单次分析最多 120 个代表帧，请扩大间隔或缩短范围');for(let i=0;i<count;i++){const time=start+i*interval;await execute(['-ss',String(time),'-i',source,'-frames:v','1','-vf','scale=1280:-2'],'.jpg','image');outputs.at(-1).time=time;}}
    else fail('未识别的本地媒体工具');
    return {provider:'media',outputs,metadata:{source,start,end,tool}};
  }
}
async function exportStoryboard({shots,title,file,resolveImage}){
  const ExcelJS=require('exceljs');const book=new ExcelJS.Workbook();book.creator='CreateMore';const sheet=book.addWorksheet('镜头表');sheet.columns=[{header:'镜号',key:'index',width:8},{header:'时间范围',key:'time',width:21},{header:'时长',key:'duration',width:12},{header:'代表截图',key:'frame',width:30},{header:'画面描述',key:'description',width:55},{header:'分镜提示词',key:'prompt',width:60},{header:'景别',key:'size',width:16},{header:'运镜',key:'camera',width:25},{header:'光影',key:'light',width:25},{header:'对白',key:'dialogue',width:25},{header:'声音',key:'sound',width:25}];
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF273438'}};
  for(let i=0;i<shots.length;i++){const s=shots[i];const row=sheet.addRow({...s,index:i+1,time:s.start!=null?`${s.start} – ${s.end}`:'',frame:''});row.alignment={vertical:'top',wrapText:true};row.height=110;if(s.frame&&resolveImage){const filename=await resolveImage(s.frame);if(filename){const ext=path.extname(filename).slice(1).toLowerCase();if(['png','jpeg','jpg'].includes(ext)){const imageId=book.addImage({filename,extension:ext==='jpg'?'jpeg':ext});sheet.addImage(imageId,{tl:{col:3,row:i+1},ext:{width:205,height:105}});}}}}
  sheet.views=[{state:'frozen',ySplit:1}];await book.xlsx.writeFile(file);return {path:file,rows:shots.length,title};
}
module.exports={MediaService,exportStoryboard,run};
