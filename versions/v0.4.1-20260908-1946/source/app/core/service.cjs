'use strict';
const {EventEmitter}=require('node:events');
const {isDeepStrictEqual}=require('node:util');
const {fs,path,crypto,clone,id,fail,readJSON,atomicJSON,serial,redact,publicError}=require('./util.cjs');
const {ProjectStore}=require('./storage.cjs');
const {ResourceStore}=require('./resources.cjs');
const {TaskQueue}=require('./queue.cjs');
const {MediaService,exportStoryboard}=require('./media.cjs');
const execution=require('./execution-actions.cjs');
const generation=require('./generation-batch.cjs');
const inputs=require('./snapshot-inputs.cjs');
const {Graph,types,blankShot,ports}=require('../ui/canvas-model.js');
const SOURCES={'本地 ComfyUI':'comfyui','Codex':'codex','Codex Image2':'image2','本地模型':'ollama','外部 API':'openai-compatible','RunningHub':'runninghub'};
const emptyState=()=>({version:5,nodes:[],edges:[],groups:[],assets:[],view:{x:60,y:130,k:1},seq:0,chat:[],settings:{saveMinutes:5,maxSnapshots:100}});
function same(a,b){return isDeepStrictEqual(a,b);}
function resultFingerprint(result){const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;return crypto.createHash('sha256').update(JSON.stringify(stable({outputs:result.outputs||[],text:result.text,storyboard:result.storyboard,generations:result.generations,generationErrors:result.generationErrors,partial:result.partial,cancelled:result.cancelled}))).digest('hex');}
function normalizeState(state,owner){
  if(!Graph.valid(state))fail('画布数据不完整，拒绝覆盖当前工程');
  const s=clone(state);s.assets=Array.isArray(s.assets)?s.assets:[];s.chat=Array.isArray(s.chat)?s.chat:[];
  for(const n of s.nodes){if(n.owner==='me'||!n.owner)n.owner=owner;n.shots=Array.isArray(n.shots)?n.shots:[];n.prompt=n.prompt||'';n.content=n.content||'';}
  for(const g of s.groups){if(g.owner==='me'||!g.owner)g.owner=s.nodes.find(n=>g.members.includes(n.id))?.owner||owner;}
  return s;
}
class CreateMoreService extends EventEmitter {
  constructor({appDir,dataDir,encryptSecret,decryptSecret,hub,collaboration}){
    super();this.appDir=appDir;this.dataDir=dataDir;this.store=new ProjectStore({appDir,dataDir});this.resources=new ResourceStore({appDir});
    const {ProviderHub}=require('../providers');this.hub=hub||new ProviderHub({appDir,dataDir,encryptSecret,decryptSecret});this.chatSession=new (require('./chat-session.cjs').ChatSession)({hub:this.hub,dataDir});this.media=new MediaService();this.sessions=new Map();this.mediaFiles=new Map();this.current=null;this.mutate=serial();this.logs=[];this.clipboard=null;this.settingsFile=path.join(dataDir,'settings.json');this.identity=null;this.collab=collaboration;this.closed=false;
  }
  async init(){
    await fs.mkdir(this.dataDir,{recursive:true});this.settings=await readJSON(this.settingsFile,{saveMinutes:5,maxSnapshots:100,bindings:{image:'default:image-zimage',video:'default:video-h3-turbo',audio:'default:audio-h3-ambience',text:'default:text-qwen3'},tools:{'高清':{workflowId:'default:tool-image-upscale'},'片段重拍':{workflowId:'default:video-h3-i2v'}},externalProvider:'openai-compatible'});const {Diagnostics}=require('./diagnostics.cjs');this.diagnostics=await new Diagnostics({dataDir:this.dataDir}).init();this.logs=await this.diagnostics.list();
    if(!this.collab){const {CollaborationService}=require('./collaboration.cjs');this.collab=new CollaborationService({dataDir:this.dataDir,getSnapshot:()=>this.sharedSnapshot(),applySnapshot:(s,meta)=>this.applyShared(s,meta),listAssets:()=>this.sharedAssets(),readAsset:id=>this.assetPath(id,this.sharedSession||this.current),writeAsset:(meta,buffer,options)=>this.receiveSharedAsset(meta,buffer,options),onEvent:event=>{this.emit('event',{type:'lan',data:event});}});}
    if(this.collab.init)await this.collab.init();if(this.collab.ready)await (typeof this.collab.ready==='function'?this.collab.ready():this.collab.ready);
    const status=await this.collab.status();this.identity=status.identity;if(!this.identity?.id)fail('无法初始化本机身份');
    this.images=new generation.ImageBatchRunner({dataDir:this.dataDir,run:(s,o)=>this.runSource(s,o),reconcile:(s,r,o)=>this.reconcileSource(s,r,o),cancel:r=>this.cancelSource(r)});
    this.queue=new TaskQueue({dataDir:this.dataDir,prepare:s=>this.prepareSnapshot(s),run:(s,o)=>this.run(s,o),reconcile:(s,r,o)=>this.reconcileTask(s,r,o),cancel:r=>r.activeOperation?this.cancelSource(r):r.remoteId?.type==='image-batch'?this.images.cancel(r):this.cancelSource(r),onResult:(t,r)=>this.applyResult(t,r)});
    await execution.install(this);
    this.queue.on('change',task=>this.emit('event',{type:'task',data:task}));this.queue.on('internalError',e=>this.log('error','任务写盘失败',e));await this.queue.init();
    this.autoTimer=setInterval(()=>this.autosave().catch(e=>this.log('error','自动保存失败',e)),10000);this.autoTimer.unref();return this;
  }
  log(level,message,error,extra={}){const record={id:id('log'),at:new Date().toISOString(),level,message,error:error?publicError(error):undefined,...redact(extra)};this.logs.push(record);if(this.logs.length>2000)this.logs.shift();this.emit('event',{type:'diagnostic',data:record});this.diagnostics?.append(record).catch(()=>{});return record;}
  requireCurrent(){return this.current||fail('请先新建或打开项目与画布','NO_CANVAS');}
  sessionKey(projectDir,canvasId){return path.resolve(projectDir)+'|'+canvasId;}
  async session(projectDir,canvasId){const key=this.sessionKey(projectDir,canvasId);if(this.sessions.has(key))return this.sessions.get(key);const loaded=await this.store.loadCanvas(projectDir,canvasId);const session={...loaded,projectDir,id:canvasId,state:normalizeState(loaded.state,this.identity.id),dirty:false,revision:0,lastArchived:Date.now()};this.sessions.set(key,session);return session;}
  async openCanvas(projectDir,canvasId){const lan=await this.collab.status();if(this.sharedSession&&['hosting','joined','disconnected'].includes(lan.mode)&&this.sessionKey(projectDir,canvasId)!==this.sessionKey(this.sharedSession.projectDir,this.sharedSession.id))fail('请先离开或停止当前共享，再切换画布；不会把共享改动写进另一张画布','LAN_CANVAS_LOCKED');this.current=await this.session(projectDir,canvasId);await this.registerAssets(this.current);this.emit('event',{type:'canvas-open',data:await this.view()});return this.view();}
  async createProject(directory,name){const project=await this.store.createProject(directory,name);const canvas=await this.store.createCanvas(project.projectDir,'主画布',emptyState());await this.openCanvas(project.projectDir,canvas.id);return {project,canvas:await this.view()};}
  async openProject(directory){const project=await this.store.openProject(directory);const canvases=await this.store.listCanvases(project.projectDir);if(!canvases.length){const c=await this.store.createCanvas(project.projectDir,'主画布',emptyState());canvases.push(c);}await this.openCanvas(project.projectDir,canvases[0].id);return {project,canvas:await this.view()};}
  async createCanvas(name){const c=this.requireCurrent();const created=await this.store.createCanvas(c.projectDir,name,emptyState());return this.openCanvas(c.projectDir,created.id);}
  mediaURL(file){const absolute=path.resolve(file);let entry=[...this.mediaFiles].find(([,p])=>p===absolute);if(!entry){entry=[id('media'),absolute];this.mediaFiles.set(...entry);}return 'createmore-media://asset/'+entry[0];}
  async registerAssets(c){for(const a of c.state.assets||[]){try{const p=await this.store.resolveAssetPath(c.projectDir,c.id,a);a.missing=false;await fs.access(p);this.mediaURL(p);}catch{a.missing=true;}}}
  async assetPath(assetId,c=this.current){if(!c)fail('没有活动画布');const a=c.state.assets.find(x=>x.id===assetId);if(!a)fail('素材不存在');return this.store.resolveAssetPath(c.projectDir,c.id,a);}
  decodeState(incoming){const s=clone(incoming);const c=this.requireCurrent();const convert=src=>{if(typeof src==='string'&&src.startsWith('createmore-media://asset/')){const p=this.mediaFiles.get(src.split('/').pop());if(!p)fail('素材引用已过期');const match=c.state.assets.find(a=>{const v=a.path||a.asset;return v&&(path.isAbsolute(v)?path.resolve(v):path.resolve(c.canvasDir,v))===p;});return match?.asset||p;}return src;};
    for(const n of s.nodes||[]){if(n.asset!==undefined)n.asset=convert(n.asset);for(const shot of n.shots||[])if(shot.frame)shot.frame=convert(shot.frame);}
    for(const a of s.assets||[]){a.asset=convert(a.asset);if(a.path?.startsWith('createmore-media:'))a.path=convert(a.path);delete a.missing;}
    return normalizeState(s,this.identity.id);
  }
  async view(c=this.current){if(!c)return null;const state=clone(c.state);const lookup=new Map();
    for(const a of state.assets){try{const p=await this.store.resolveAssetPath(c.projectDir,c.id,a);const url=this.mediaURL(p);lookup.set(a.id,url);lookup.set(a.asset,url);a.asset=url;}catch{a.missing=true;}}
    for(const n of state.nodes){if(n.owner===this.identity.id)n.owner='me';if(n.assetId&&lookup.has(n.assetId))n.asset=lookup.get(n.assetId);else if(lookup.has(n.asset))n.asset=lookup.get(n.asset);else if(n.asset&&path.isAbsolute(n.asset))n.asset=this.mediaURL(n.asset);for(const shot of n.shots||[])if(shot.frame){if(lookup.has(shot.frame))shot.frame=lookup.get(shot.frame);else if(path.isAbsolute(shot.frame))shot.frame=this.mediaURL(shot.frame);}}
    for(const g of state.groups)if(g.owner===this.identity.id)g.owner='me';
    return {projectDir:c.projectDir,canvasDir:c.canvasDir,id:c.id,name:c.name,state,dirty:c.dirty,revision:c.revision,identity:this.identity};
  }
  async updateCanvas(incoming,{revision}={}){return this.mutate(async()=>{
    const c=this.requireCurrent(),next=this.decodeState(incoming),old=c.state,actor=this.identity.id;
    if(revision!=null&&revision!==c.revision)fail('画布有新变化，请同步后重试','REVISION_CONFLICT');
    const oldBy=new Map(old.nodes.map(n=>[n.id,n]));for(const n of old.nodes)if(n.owner!==actor&&!same(next.nodes.find(x=>x.id===n.id),n))fail('不能修改或删除其他成员的卡片','FORBIDDEN');
    for(const n of next.nodes){const prior=oldBy.get(n.id);if(!prior&&n.owner!==actor)fail('新建卡片只能归自己所有','FORBIDDEN');if(prior&&prior.owner!==n.owner)fail('不能修改卡片归属','FORBIDDEN');}
    const owner=id=>oldBy.get(id)?.owner||next.nodes.find(n=>n.id===id)?.owner;
    for(const e of old.edges)if(owner(e.to)!==actor&&!same(next.edges.find(x=>x.id===e.id),e)&&next.nodes.some(n=>n.id===e.from))fail('不能修改其他成员的输入连线','FORBIDDEN');
    for(const e of next.edges)if(!old.edges.some(x=>x.id===e.id)&&owner(e.to)!==actor)fail('不能连接到其他成员的输入','FORBIDDEN');
    for(const g of next.groups)if(g.members.some(id=>owner(id)!==g.owner))fail('分组不能混合不同成员的可编辑内容');
    for(const g of old.groups)if(g.owner!==actor&&!same(next.groups.find(x=>x.id===g.id),g))fail('不能修改其他成员的分组','FORBIDDEN');
    for(const a of next.assets){const before=old.assets.find(x=>x.id===a.id);if(!before)fail('新素材必须通过导入或生成入口登记','INVALID_ASSET');for(const key of ['asset','path','sha256','size','type','external','generated','owner'])if(!same(a[key],before[key]))fail('素材原路径和内容标识不能通过画布编辑替换，请使用重新定位入口','ASSET_IDENTITY');}
    next.assets=[...new Map([...(old.assets||[]),...(next.assets||[])].map(a=>[a.id,a])).values()];
    const lan=await this.collab.status();if(this.sharedSession===c&&['hosting','joined','disconnected'].includes(lan.mode)){if(lan.mode==='disconnected')fail('共享已断线，修改未提交；请重连或另存独立画布','LAN_OFFLINE');await this.publishDiff(old,next);c.state={...c.state,view:next.view,chat:next.chat,settings:next.settings,seq:Math.max(c.state.seq||0,next.seq||0)};}else c.state=next;c.dirty=true;c.revision++;return {revision:c.revision,dirty:true};
  });}
  async publishDiff(old,next){
    const {sharedSnapshot}=require('./collaboration.cjs'),actor=this.identity.id,before=sharedSnapshot(old,actor),after=sharedSnapshot(next,actor),ops=[],removed=new Set(before.nodes.filter(n=>!after.nodes.some(x=>x.id===n.id)).map(n=>n.id));
    for(const e of before.edges)if(!after.edges.some(x=>x.id===e.id)&&!removed.has(e.from)&&!removed.has(e.to))ops.push({type:'edge.delete',id:e.id});
    for(const g of before.groups)if(!after.groups.some(x=>x.id===g.id)&&g.members.some(id=>!removed.has(id)))ops.push({type:'group.delete',id:g.id});
    for(const n of before.nodes)if(removed.has(n.id))ops.push({type:'node.delete',id:n.id});
    for(const n of after.nodes){const prior=before.nodes.find(x=>x.id===n.id);if(!prior)ops.push({type:'node.create',node:n});else if(!same(prior,n))ops.push({type:'node.update',id:n.id,patch:n});}
    for(const e of after.edges){const prior=before.edges.find(x=>x.id===e.id);if(!prior)ops.push({type:'edge.create',edge:e});else if(!same({...prior,owner:undefined},{...e,owner:undefined})){ops.push({type:'edge.delete',id:e.id},{type:'edge.create',edge:e});}}
    for(const g of after.groups)if(!same(before.groups.find(x=>x.id===g.id),g))ops.push({type:'group.upsert',group:g});
    if(!ops.length)return {unchanged:true};const status=await this.collab.status();return this.collab.publish({type:'batch',operations:ops,baseRevision:status.revision,idempotencyKey:id('lan-op')});
  }
  async saveCanvas({autosave=false}={}){const c=this.requireCurrent();return this.saveSession(c,autosave);}
  async saveSession(c,autosave){const revision=c.revision;const result=await this.store.saveCanvas(c.projectDir,c.id,c.state,{autosave});if(revision===c.revision)c.dirty=false;c.lastArchived=Date.now();this.emit('event',{type:'saved',data:{canvasId:c.id,revision,...result}});return result;}
  async autosave(){for(const c of this.sessions.values()){const minutes=c.state.settings?.saveMinutes||this.settings.saveMinutes||5;if(c.dirty&&Date.now()-c.lastArchived>=minutes*60000){await this.saveSession(c,true);}}}
  async importAsset(file,{copy=false,targetId}={}){const c=this.requireCurrent();const target=targetId?c.state.nodes.find(n=>n.id===targetId):null;if(target&&target.owner!==this.identity.id)fail('不能修改他人的卡片');const content=inputs.isText(null,file)?await inputs.readText(file):'导入素材';const a=await this.store.importAsset(c.projectDir,c.id,file,{copy});c.state.assets=[...c.state.assets.filter(x=>x.id!==a.id),a];if(targetId){if(target){target.asset=a.asset;target.assetId=a.id;target.content=content;target.title=a.title;}}
    else{const n=this.newNode(a.type,{title:a.title,asset:a.asset,assetId:a.id,content});c.state.nodes.push(n);}c.dirty=true;c.revision++;await this.registerAssets(c);await this.syncSharedAssets?.(c);return this.view(c);}
  newNode(type,fields={},c=this.current){const t=types[type];return {id:id('n'),type,title:t.name,x:120+(c?.state.nodes.length||0)%4*90,y:150+(c?.state.nodes.length||0)%4*80,w:t.w,h:t.h,owner:this.identity.id,prompt:'',content:'',source:t.sources[0],ratio:'16:9',quality:'1K',count:1,shots:type==='script'?[blankShot()]:[],...fields};}
  async references(n,c,workflow){return inputs.references(this,n,c,workflow);}
  async buildSnapshot(nodeId,overrides={},c=this.requireCurrent(),{skipLocalWorkflow=false}={}){const n=c.state.nodes.find(n=>n.id===nodeId);if(!n)fail('节点不存在');if(n.owner!==this.identity.id)fail('只能生成到自己的节点');const provider=overrides.provider||(n.source==='外部 API'?this.settings.externalProvider:SOURCES[n.source]);if(!provider)fail('请选择有效生成来源');
    for(const key of Object.keys(overrides))if(!['provider','parameters'].includes(key))fail('不能覆盖任务的工程、画布、身份或输出路径','INVALID_OVERRIDE');
    if(provider==='image2'&&n.type!=='image')fail('Codex Image2 只能用于图片生成','CAPABILITY_MISMATCH');if(['codex','ollama','openai-compatible'].includes(provider)&&!['text','script','style','character'].includes(n.type))fail('此来源未提供对应媒体生成能力','CAPABILITY_MISMATCH');
    const kind=n.type==='script'?'text':n.type==='custom'?(n.outputType||'image'):n.type;const outputDir=path.join(c.canvasDir,kind==='text'?'text':kind);await fs.mkdir(outputDir,{recursive:true});
    let workflow=skipLocalWorkflow?undefined:n.workflow;const binding=n.workflowId||this.settings.bindings?.[n.type==='script'?'text':n.type];if(!workflow&&binding&&provider==='comfyui'&&!skipLocalWorkflow)workflow=await this.workflowRead(binding,n.workflowVersion);
    const refs=await this.references(n,c,workflow);const styles=c.state.edges.filter(e=>e.to===n.id).map(e=>c.state.nodes.find(n=>n.id===e.from)).filter(x=>x?.type==='style').sort((a,b)=>(n.styleOrder||[]).indexOf(a.id)-(n.styleOrder||[]).indexOf(b.id)).filter(s=>!(n.disabledStyles||[]).includes(s.id));
    let prompt=[n.toolInstructions?.[provider]||n.toolInstructions?.default,n.prompt||n.content].filter(Boolean).join('\n')+refs.filter(r=>r.text).map(r=>'\n\n参考文字 '+r.title+'：\n'+r.text).join('');if(n.type==='script')prompt+='\n请输出可编辑分镜表。仅返回JSON数组，每项包含duration（如5s）、description、prompt、size、camera、light、dialogue、sound。每项一个镜头，不输出Markdown围栏。';
    return {provider,kind,nodeId,canvasId:c.id,projectDir:c.projectDir,title:n.title,prompt,references:refs.filter(r=>r.path||r.inputId),workflow,workflowId:binding,workflowVersion:n.workflowVersion,parameters:{...n.parameters,ratio:n.ratio,quality:n.quality,count:Number(n.count??1),...overrides.parameters},styles:styles.map(s=>({id:s.id,title:s.title,content:s.content,skill:s.skill,provider:SOURCES[s.source]||'codex'})),outputDir};
  }
  async submitNode(nodeId,overrides,c=this.requireCurrent()){const snapshot=await this.buildSnapshot(nodeId,overrides,c);if(!snapshot.prompt?.trim()&&!snapshot.references.length)fail('请填写提示词或连接素材');if(snapshot.provider==='comfyui'&&!snapshot.workflow)fail('此节点尚未绑定 ComfyUI 工作流，请先配置');const task=await this.queue.submit(snapshot,this.identity.id);const n=c.state.nodes.find(n=>n.id===nodeId);if(n){n.taskId=task.id;delete n.error;}c.dirty=true;c.revision++;try{await this.saveSession(c,false);}catch(e){this.log('error','任务已登记，但画布关联尚未保存',e,{taskId:task.id});}return task;}
  async run(snapshot,options){
    if(snapshot.provider==='media')return this.media.process(snapshot,options);
    if(snapshot.provider==='storyboard')return require('./creative.cjs').runAnalysis(this,snapshot,options);
    let prepared=clone(snapshot);if(snapshot.styles?.length){const result=await require('./creative.cjs').styles(this,snapshot,options);prepared.prompt=result.prompt;prepared.styleTrace=result.trace;}
    const result=prepared.generationPlan?await this.images.execute(prepared,options):await this.runSource(prepared,options);if(prepared.styleTrace)result.styleTrace=prepared.styleTrace;return inputs.hydrateText(result);
  }
  async runSource(snapshot,options){return snapshot.provider==='shared-comfyui'?execution.run(this,snapshot,options):this.hub.run(snapshot,options);}
  async reconcileSource(snapshot,remote,options){if(snapshot.provider==='media')return {state:'unknown',message:'本地媒体进程在软件中断后不能冒认完成，请检查结果文件'};return snapshot.provider==='shared-comfyui'?execution.reconcile(this,snapshot,remote,options):this.hub.reconcile(snapshot,remote,options);}
  async reconcileTask(snapshot,remote,options){if(snapshot.provider==='storyboard')return require('./creative.cjs').runAnalysis(this,snapshot,{...options,recovery:true,retryFailed:remote.retryFailed===true});if(remote.activeOperation?.role==='style'||remote.styleId)return this.run(snapshot,options);return snapshot.generationPlan?this.images.execute(snapshot,options,true):this.reconcileSource(snapshot,remote,options);}
  async cancelSource(remote){if(remote.activeOperation){const op=remote.activeOperation;if(!op.provider||(!op.remoteId&&!op.threadId))return {state:'unknown',message:'当前中间步骤尚无来源标识，未向其他来源发送中断'};remote={...remote,provider:op.provider,connection:op.connection,remoteId:op.remoteId,threadId:op.threadId,turnId:op.turnId,activeOperation:null};}if(remote.provider==='media'||remote.remoteId?.type==='media')return this.media.cancel(remote);return remote.provider==='shared-comfyui'?execution.cancel(this,remote):this.hub.cancel(remote);}
  async submitTool(args){return require('./creative.cjs').submitTool(this,args);}
  async analyzeStoryboard(args){return require('./creative.cjs').analyze(this,args);}
  async stylePreview(nodeId){const snapshot=await this.buildSnapshot(nodeId);const result=await require('./creative.cjs').styles(this,snapshot,{outputDir:snapshot.outputDir});return {original:snapshot.prompt,steps:result.trace,final:result.prompt,generatedMedia:false};}
  async applyResult(task,result){if(task.snapshot?.remoteExecution)return;result=await inputs.hydrateText(result);return this.mutate(async()=>{
    const c=await this.session(task.projectDir,task.canvasId),historyFile=path.join(c.canvasDir,'generation-history.json'),resultDigest=resultFingerprint(result);const history=await readJSON(historyFile,[]);const previous=history.find(h=>h.taskId===task.id);if(previous?.resultDigest===resultDigest&&c.state.appliedTaskIds?.includes(task.id)){if(c.dirty)await this.saveSession(c,false);await this.registerAssets(c);await this.syncSharedAssets(c);this.emit('event',{type:'result',data:{canvasId:c.id,taskId:task.id,view:c===this.current?await this.view(c):null}});return;}
    const outputs=[];for(const out of(result.outputs||[])){await fs.access(out.path);const oldIndex=previous?.resultOutputPaths?.findIndex(file=>path.resolve(file)===path.resolve(out.path))??-1;const a=(oldIndex>=0?previous.outputs?.[oldIndex]:null)||await this.store.importAsset(c.projectDir,c.id,out.path,{copy:false,generated:true});Object.assign(a,{time:out.time,outputId:out.outputId,generationIndex:out.generationIndex,seed:out.seed});c.state.assets=[...c.state.assets.filter(x=>x.id!==a.id),a];outputs.push({...a});}
    let n=c.state.nodes.find(x=>x.id===task.nodeId);const latestTask=this.queue.tasks.filter(t=>t.canvasId===task.canvasId&&t.projectDir===task.projectDir&&t.nodeId===task.nodeId).at(-1);const canApply=n&&n.owner===task.owner&&(n.taskId===task.id||(!n.taskId&&latestTask?.id===task.id))&&n.workflowVersion===task.snapshot.workflowVersion;
    if(['new','storyboard','script'].includes(task.snapshot.resultMode)||!canApply){n=null;}
    if(n){n.taskId=task.id;delete n.error;if(result.text!=null){n.content=result.text;if(n.type==='script'){try{const parsed=JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g,''));if(Array.isArray(parsed))n.shots=parsed;else if(Array.isArray(parsed.shots))n.shots=parsed.shots;}catch{n.content=result.text;}}}if(outputs.length){n.asset=outputs[0].asset;n.assetId=outputs[0].id;n.outputAssets=outputs.map(a=>a.id);n.outputBindings={};for(const a of outputs)if(a.outputId){if(!n.outputBindings[a.outputId])n.outputBindings[a.outputId]={assetId:a.id,assetIds:[]};n.outputBindings[a.outputId].assetIds.push(a.id);}}n.generations=result.generations;n.generationErrors=result.generationErrors;n.styleTrace=result.styleTrace;n.lastResultAt=new Date().toISOString();}
    else if(task.snapshot.resultMode==='script'){const source=c.state.nodes.find(x=>x.id===task.snapshot.sourceNodeId);let shots;try{const parsed=require('./creative.cjs').parseJSON(result.text);const rows=Array.isArray(parsed)?parsed:parsed.shots;if(!Array.isArray(rows)||!rows.length||rows.length>1000||rows.some(row=>!row||typeof row.description!=='string'||!row.description.trim()))throw new Error('未返回有效分镜行');shots=rows.map(row=>Object.fromEntries(['duration','description','prompt','size','camera','light','dialogue','sound'].map(key=>[key,String(row[key]??'')])));}catch(error){this.log('warn','剧本生成文字已保留，但未解析为分镜表',error,{taskId:task.id});}const next=this.newNode(shots?'script':'text',{originTaskId:task.id,source:Object.keys(SOURCES).find(k=>SOURCES[k]===task.provider)||'本地媒体处理',title:task.title+(shots?'':' · 格式待整理'),...(shots?{shots}:{}),content:result.text||'模型未返回可解析分镜；请在任务详情核对原始结果',sourceNodeId:source?.id,assetId:outputs[0]?.id,asset:outputs[0]?.asset,outputAssets:outputs.map(a=>a.id),x:(source?.x||100)+(source?.w||380)+140,y:source?.y||150},c);c.state.nodes.push(next);if(source)c.state.edges.push({id:id('e'),from:source.id,to:next.id});}
    else if(task.snapshot.resultMode==='storyboard'&&result.storyboard){const source=c.state.nodes.find(x=>x.id===task.snapshot.sourceNodeId);const next=this.newNode('script',{originTaskId:task.id,source:Object.keys(SOURCES).find(k=>SOURCES[k]===task.provider)||'本地媒体处理',title:task.title,shots:clone(result.storyboard.shots),sourceNodeId:source?.id,sourceAssetId:result.storyboard.sourceAssetId,analysisVersion:result.storyboard.version,analysisErrors:result.storyboard.errors,content:result.partial?'部分范围未完成':'代表帧分析',x:(source?.x||100)+(source?.w||380)+140,y:source?.y||150},c);c.state.nodes.push(next);if(source)c.state.edges.push({id:id('e'),from:source.id,to:next.id});}
    else if(task.snapshot.resultMode==='new'){const source=c.state.nodes.find(x=>x.id===task.snapshot.sourceNodeId);if(result.text&&!outputs.length){const next=this.newNode('text',{originTaskId:task.id,source:Object.keys(SOURCES).find(k=>SOURCES[k]===task.provider)||'本地媒体处理',title:task.title,content:result.text,sourceNodeId:source?.id,x:(source?.x||100)+(source?.w||380)+140,y:source?.y||150},c);c.state.nodes.push(next);if(source)c.state.edges.push({id:id('e'),from:source.id,to:next.id});}for(const a of outputs){const content=inputs.isText(a.type,a.path)?await inputs.readText(await this.assetPath(a.id,c)):'处理结果';const next=this.newNode(a.type,{originTaskId:task.id,source:Object.keys(SOURCES).find(k=>SOURCES[k]===task.provider)||'本地媒体处理',title:task.title,asset:a.asset,assetId:a.id,content,x:(source?.x||100)+(source?.w||380)+140,y:(source?.y||150)+outputs.indexOf(a)*330,sourceNodeId:source?.id},c);c.state.nodes.push(next);if(source)c.state.edges.push({id:id('e'),from:source.id,to:next.id});}}
    const entry={taskId:task.id,nodeId:task.nodeId,createdAt:previous?.createdAt||new Date().toISOString(),provider:task.provider,prompt:task.snapshot.prompt,parameters:task.snapshot.parameters,outputs,resultOutputPaths:(result.outputs||[]).map(o=>o.path),resultDigest,text:result.text,styleTrace:result.styleTrace,generations:result.generations,generationErrors:result.generationErrors,applied:!!n};if(previous)Object.assign(previous,entry);else history.push(entry);await atomicJSON(historyFile,history);
    c.state.appliedTaskIds=[...(c.state.appliedTaskIds||[]).filter(t=>t!==task.id),task.id];c.dirty=true;c.revision++;await this.saveSession(c,false);await this.registerAssets(c);await this.syncSharedAssets?.(c);this.emit('event',{type:'result',data:{canvasId:c.id,taskId:task.id,view:c===this.current?await this.view(c):null}});
  });}
  async workflowRead(binding,version){if(typeof binding==='object'&&binding.api)return binding;const key=typeof binding==='string'?binding:binding.id;if(key.startsWith('default:'))return this.hub.defaultWorkflows.read(key.slice(8),version);const workflow=await this.resources.get('workflows',key);return workflow.data||workflow;}
  async prepareSnapshot(snapshot){
    let local=clone(snapshot);inputs.validateReferences(local);if(local.sharedRequest){const devices=await this.gateway.listOffers(),offer=devices.devices.find(d=>d.deviceId===local.sharedRequest.deviceId)?.offers.find(o=>o.id===local.sharedRequest.offerId);if(offer?.parameters?.seed)local.generationSeedRange=offer.parameters.seed;}generation.prepare(local);if(local.references?.length){const dir=path.join(this.dataDir,'task-inputs',id('snapshot'));await fs.mkdir(dir,{recursive:true});for(const [i,ref]of local.references.entries()){if(!ref.path&&ref.type==='text'&&typeof ref.text==='string'){ref.path=path.join(dir,i+'.txt');await fs.writeFile(ref.path,ref.text,{flag:'wx'});continue;}if(!ref.path)fail('任务参考素材尚未落盘');const filename=path.join(dir,String(i)+path.extname(ref.path));await fs.copyFile(ref.path,filename,require('node:fs').constants.COPYFILE_EXCL);ref.originalPath=ref.path;ref.path=filename;}}
    local=await require('./creative.cjs').prepareStyles(local,{hub:this.hub,resources:this.resources});if(this.hub.prepare&&!['media','storyboard','shared-comfyui'].includes(local.provider))return this.hub.prepare(local);return local;
  }
  async call(method,args={}){
    if(method==='app.status')return {version:require('../../package.json').version,identity:this.identity,current:await this.view(),settings:redact(this.settings),providers:await this.hub.status(),media:await this.media.status(),lan:await this.collab.status()};
    if(method==='project.recent')return this.store.listRecent();
    if(method==='project.create')return this.createProject(args.directory,args.name);
    if(method==='project.open')return this.openProject(args.directory);
    if(method==='project.openFile'){const target=await this.store.resolveDocument(args.path);if(target.canvasId){await this.openCanvas(target.projectDir,target.canvasId);return {canvas:await this.view()};}return this.openProject(target.projectDir);}
    if(method==='canvas.list'){const c=this.requireCurrent();return this.store.listCanvases(c.projectDir);}
    if(method==='canvas.create')return this.createCanvas(args.name);
    if(method==='canvas.open')return this.openCanvas(args.projectDir||this.requireCurrent().projectDir,args.id);
    if(method==='canvas.get')return this.view();
    if(method==='canvas.update')return this.updateCanvas(args.state,{revision:args.revision});
    if(method==='canvas.save')return this.saveCanvas();
    if(method==='clipboard.copy')return require('./clipboard.cjs').copy(this,args.nodeIds);
    if(method==='clipboard.paste')return require('./clipboard.cjs').paste(this);
    if(method==='asset.import')return this.importAsset(args.path,args);
    if(method==='asset.annotate')return require('./annotation.cjs').save(this,args);
    if(method==='media.annotationFrame')return require('./annotation.cjs').frame(this,args);
    if(method==='asset.relink')return this.mutate(async()=>{const c=this.requireCurrent();await this.saveSession(c,false);const r=await this.store.relinkAsset(c.projectDir,c.id,args.id,args.path,{batch:args.batch!==false});if(r.state)c.state=normalizeState(r.state,this.identity.id);c.revision++;c.dirty=true;await this.registerAssets(c);return {result:r,view:await this.view(c)};});
    if(method==='asset.path')return this.assetPath(args.id);
    if(method==='project.package')return this.mutate(async()=>{const c=this.requireCurrent();for(const session of this.sessions.values())if(session.projectDir===c.projectDir&&session.dirty)await this.saveSession(session,false);return args.canvasOnly?this.store.packageCanvas(c.projectDir,c.id,args.destination):this.store.packageProject(c.projectDir,args.destination);});
    if(method==='canvas.autosaves'){const c=this.requireCurrent();return this.store.listAutosaves(c.projectDir,c.id);}
    if(method==='canvas.restorePreview'){const c=this.requireCurrent();return this.store.previewRestore(c.projectDir,c.id,args.name);}
    if(method==='canvas.restore'){const c=this.requireCurrent();await this.saveCanvas();const r=await this.store.restoreCanvas(c.projectDir,c.id,args.name,{asNew:args.asNew,name:args.newName,ownerId:this.identity.id});this.sessions.delete(this.sessionKey(c.projectDir,args.asNew?r.id:c.id));return this.openCanvas(c.projectDir,args.asNew?r.id:c.id);}
    if(method==='task.list')return this.queue.list(args);
    if(method==='task.submit')return this.submitNode(args.nodeId,args.overrides);
    if(method==='task.pause')return this.queue.pause(args.id,this.identity.id);
    if(method==='task.resume')return this.queue.resume(args.id,this.identity.id);
    if(method==='task.cancel')return this.queue.cancel(args.id,this.identity.id);
    if(method==='task.reconcile')return this.queue.reconcile(args.id,this.identity.id);
    if(method==='task.previewPartial'){const task=this.queue.get(args.id);this.queue.authorize(task,this.identity.id);if(!task.partialResult?.storyboard)fail('没有已经取得的部分分析范围');await this.applyResult(task,{...task.partialResult,state:'completed',partial:true});return this.view(await this.session(task.projectDir,task.canvasId));}
    if(method==='task.remove')return this.queue.remove(args.id,this.identity.id);
    if(method==='task.pauseQueue')return this.queue.pauseQueue(args.provider,this.identity.id,args.paused);
    if(method==='execution.capabilities')return execution.describe(this);
    if(method==='execution.offers')return this.gateway.listOffers();
    if(method==='execution.offer')return this.gateway.offer(args);
    if(method==='execution.stop')return this.gateway.stopOffer(args.offerId||args.id);
    if(method==='execution.submit')return execution.submitNode(this,args);
    if(method==='execution.status')return this.gateway.remoteStatus({deviceId:args.deviceId,jobId:args.jobId});
    if(method==='execution.cancel')return this.gateway.cancelRemote({deviceId:args.deviceId,jobId:args.jobId});
    if(method==='execution.deviceCancel')return this.gateway.cancelDeviceTask(args.jobId);
    if(method==='execution.pauseDevice')return this.gateway.pauseDevice(args.provider||'comfyui',args.paused!==false);
    if(method==='provider.status')return this.hub.status();
    if(method==='provider.comfyStart'){await this.hub.ready;return this.hub.providers.comfyui.start();}
    if(method==='provider.comfyStop')return this.hub.stopComfyOwned({instanceId:args.instanceId});
    if(method==='provider.comfyFree'){await this.hub.ready;return this.hub.providers.comfyui.releaseMemory();}
    if(method==='provider.config'){await this.hub.ready;return this.hub.publicConfig();}
    if(method==='workflow.catalog'){return readJSON(path.join(this.appDir,'resources','workflows','catalog.json'),[]);}
    if(method==='workflow.read')return this.workflowRead(args.id,args.version);
    if(method==='workflow.validate'){await this.hub.ready;require('../providers/workflows.cjs').validateBundle(args.bundle);return this.hub.providers.comfyui.validate(args.bundle.api,args.bundle.mapping);}
    if(method==='workflow.save')return require('./library-actions.cjs').saveWorkflow(this,args);
    if(method==='workflow.defaultSave'){if(typeof args.id!=='string'||!/^default:[a-zA-Z0-9_-]+$/.test(args.id))fail('默认工作流编号无效');await this.hub.defaultWorkflows.read(args.id.slice(8));return this.hub.defaultWorkflows.save(args.id.slice(8),args.bundle);}
    if(method==='resource.capture')return require('./library-actions.cjs').capture(this,args);
    if(method==='resource.apply')return require('./library-actions.cjs').apply(this,args);
    if(method==='provider.configure'){await this.hub.configure(args.config);return this.hub.status();}
    if(method==='settings.get')return clone(this.settings);
    if(method==='settings.save'){const next={...this.settings,...args};if(!Number.isFinite(Number(next.saveMinutes))||next.saveMinutes<1||next.saveMinutes>1440||next.maxSnapshots<1||next.maxSnapshots>10000)fail('保存间隔或份数无效');this.settings=next;await atomicJSON(this.settingsFile,next);if(this.current){this.current.state.settings={...this.current.state.settings,saveMinutes:Number(next.saveMinutes),maxSnapshots:Number(next.maxSnapshots)};this.current.dirty=true;}return clone(next);}
    if(method==='resource.list'){const records=await this.resources.list(args.kind,args.options);for(const record of records)if(record.cover)record.coverURL=this.mediaURL(path.join(record.resourceDir,record.cover));return records;}
    if(method==='resource.get')return this.resources.get(args.kind,args.id,args.options);
    if(method==='resource.save')return this.resources.save(args.kind,args.data,args.options);
    if(method==='resource.remove')return this.resources.remove(args.kind,args.id,args.options);
    if(method==='resource.enabled')return this.resources.setEnabled(args.kind,args.id,args.enabled);
    if(method==='resource.import')return this.resources.import(args.kind,args.directory,args.options);
    if(method==='resource.export')return this.resources.export(args.kind,args.id,args.directory);
    if(method==='skill.reference')return this.resources.referenceSkill(args.name,args.path,args.metadata);
    if(method==='skill.read')return this.resources.readSkill(args.id);
    if(method==='skill.manageRead')return this.resources.readSkill(args.id,{allowDisabled:true});
    if(method==='skill.copy')return this.resources.copySkill(args.id,args.name);
    if(method==='diagnostics.list')return {logs:this.logs,tasks:this.queue.list({includeRemoved:true})};
    if(method==='storage.inspect')return require('./storage-management.cjs').inspect(this);
    if(method==='storage.trimCache')return require('./storage-management.cjs').trim(this,args);
    if(method==='diagnostics.export'){const report=require('./diagnostic-export.cjs').report({providers:await this.hub.status(),logs:this.logs,tasks:this.queue.tasks});await atomicJSON(args.path,report);return {path:args.path};}
    if(method==='history.list'){const c=this.requireCurrent();return readJSON(path.join(c.canvasDir,'generation-history.json'),[]);}
    if(method==='history.apply')return require('./library-actions.cjs').applyHistory(this,args);
    if(method==='media.probe')return this.media.probe(await this.assetPath(args.assetId));
    if(method==='media.submit')return this.submitMedia(args);
    if(method==='tool.prepare')return require('./creative.cjs').submitTool(this,args,{prepareOnly:true});
    if(method==='tool.submit')return this.submitTool(args);
    if(method==='storyboard.analyze')return this.analyzeStoryboard(args);
    if(method==='style.preview')return this.stylePreview(args.nodeId);
    if(method==='storyboard.export'){const c=this.requireCurrent(),n=c.state.nodes.find(n=>n.id===args.nodeId);if(!n||n.type!=='script')fail('请选择分镜表');return exportStoryboard({shots:n.shots,title:n.title,file:args.path,resolveImage:src=>this.resolveFrame(src,c)});}
    if(method==='agent.send')return this.chat(args);
    if(method==='agent.stop')return this.chatSession.stop();
    if(method==='agent.status'){if(this.chatSession.ready)await this.chatSession.ready;return this.chatSession.state();}
    if(method==='agent.reconcile')return this.reconcileChat();
    if(method==='agent.history')return readJSON(path.join(this.dataDir,'chats.json'),[]);
    if(method==='agent.tool')return this.agentTool(args.name,args.arguments);
    if(method==='lan.status')return this.collab.status();
    if(method==='lan.host'){const c=this.requireCurrent();await this.saveCanvas();this.sharedSession=c;c.sharedCanvasId=c.id;return this.collab.startHosting({...args,canvasId:c.id});}
    if(method==='lan.join'){const c=this.requireCurrent(),status=await this.collab.status();if(this.sharedSession&&this.sharedSession!==c&&['hosting','joined','disconnected'].includes(status.mode))fail('请先离开当前共享','LAN_CANVAS_LOCKED');await this.saveSession(c,true);if(!this.sharedSession||!['joined','disconnected'].includes(status.mode))this.joiningNewCanvas={projectDir:c.projectDir,name:args.name||('共享画布 · '+new Date().toISOString().replace(/[:.]/g,'-'))};this.sharedSession=c;this.joiningShared=true;try{return await this.collab.join(args);}finally{this.joiningShared=false;this.joiningNewCanvas=null;}}
    if(method==='lan.leave')return this.collab.leave();
    if(method==='lan.stop')return this.collab.stopSharing();
    if(method==='lan.password')return this.collab.changePassword(args.password);
    if(method==='lan.takeover')return this.collab.takeover(args);
    if(method==='lan.sync')return this.collab.syncNow();
    if(method==='lan.recover')return this.collab.recoverPending();
    fail('未知操作：'+method,'UNKNOWN_METHOD');
  }
  async resolveFrame(src,c=this.current){if(typeof src!=='string'||!c)fail('分镜截图没有有效素材引用');const candidate=src.startsWith('createmore-media:')?this.mediaFiles.get(src.split('/').pop()):path.resolve(c.canvasDir,src);if(!candidate)fail('分镜截图引用已失效');for(const asset of c.state.assets||[]){if(asset.type!=='image')continue;let actual;try{actual=await this.assetPath(asset.id,c);}catch{continue;}if(path.resolve(actual)===path.resolve(candidate))return actual;}fail('分镜截图必须引用当前画布已登记的图片素材','FRAME_NOT_REGISTERED');}
  async submitMedia({nodeId,tool,parameters={}}){const c=this.requireCurrent(),n=c.state.nodes.find(n=>n.id===nodeId);if(!n?.assetId)fail('需要真实音视频文件');const source=await this.assetPath(n.assetId);const outputDir=path.join(c.canvasDir,'media-results');await fs.mkdir(outputDir,{recursive:true});return this.queue.submit({provider:'media',kind:tool==='frame'||tool==='frames'?'image':n.type,tool,parameters,references:[{path:source,type:n.type}],nodeId:null,sourceNodeId:n.id,resultMode:'new',projectDir:c.projectDir,canvasId:c.id,title:n.title+' · '+tool,outputDir},this.identity.id);}
  async chat({text,threadId,skillIds=[],nodeIds=[]}){
    if(this.chatSession.ready)await this.chatSession.ready;if(this.chatSession.state().active)fail('已有私人回合正在处理或待核对，请先恢复该回合','CHAT_BUSY');
    if(!text?.trim())fail('请输入内容');if(threadId){const existing=await readJSON(path.join(this.dataDir,'chats.json'),[]);if(!existing.some(c=>c.threadId===threadId))fail('只能继续本机 CreateMore 已创建的对话','FORBIDDEN');}const c=this.requireCurrent();let prompt=text;const selectedSkills=[];for(const resourceId of skillIds){const skill=await this.resources.readSkill(resourceId),content=typeof skill==='string'?skill:skill.content;prompt+='\n\n调用方法：\n'+content;selectedSkills.push({id:resourceId,name:skill.name||resourceId,revision:skill.revision,version:skill.version,content,sha256:require('node:crypto').createHash('sha256').update(content).digest('hex')});}
    const refs=[];for(const nodeId of nodeIds){const n=c.state.nodes.find(n=>n.id===nodeId);if(!n)continue;let content=n.content||n.prompt||'';if(n.assetId){const asset=c.state.assets.find(a=>a.id===n.assetId),file=await this.assetPath(n.assetId);if(inputs.isText(asset?.type,file)){if(!content||['导入素材','处理结果'].includes(content))content=await inputs.readText(file);}else refs.push({path:file,type:asset?.type||n.type});}prompt+='\n\n引用节点 '+n.id+' '+n.title+'：\n'+content;}
    const {tools}=require('./agent-tools.cjs');
    const context={requestId:id('chat-turn'),userText:text,requestedThreadId:threadId,projectDir:c.projectDir,canvasDir:c.canvasDir,canvasId:c.id,canvasName:c.name,startedAt:new Date().toISOString(),skills:selectedSkills,nodes:nodeIds.map(nodeId=>c.state.nodes.find(n=>n.id===nodeId)).filter(Boolean).map(n=>({id:n.id,title:n.title,type:n.type,assetId:n.assetId}))};let result;
    try{result=await this.chatSession.run({provider:'codex',kind:'text',prompt,threadId,references:refs,tools,outputDir:path.join(c.canvasDir,'text')},{context,outputDir:path.join(c.canvasDir,'text'),onProgress:p=>this.emit('event',{type:'chat-progress',data:p}),onToolCall:(name,args)=>this.agentTool(name,args,c)});}catch(error){const record=this.chatSession.record(error.chatRequestId);if(record)try{await this.saveChatTurn(this.chatSession.resultOf(record));}catch(saveError){this.log('error','私人回合已保留，聊天列表关联待恢复',saveError,{requestId:record.id});}throw error;}
    return this.saveChatTurn(result);
  }
  async saveChatTurn(result){
    if(!result.context||!result.requestId)return result;this.chatHistoryMutate||=serial();return this.chatHistoryMutate(async()=>{
      const context=result.context,file=path.join(this.dataDir,'chats.json'),chats=await readJSON(file,[]),threadId=result.threadId||context.requestedThreadId;let chat=chats.find(c=>c.turns?.some(t=>t.requestId===result.requestId)||c.messages?.some(m=>m.requestId===result.requestId)||(threadId&&c.threadId===threadId));
      if(!chat){chat={id:id('chat'),threadId,title:context.userText.slice(0,35),createdAt:context.startedAt,projectDir:context.projectDir,canvasId:context.canvasId,messages:[],turns:[]};chats.push(chat);}if(threadId)chat.threadId=threadId;chat.turns||=[];
      const existing=chat.turns.find(t=>t.requestId===result.requestId),state=existing?.state==='completed'?'completed':result.state||'unknown',meta={requestId:result.requestId,threadId,turnId:result.turnId||result.remoteId,state,projectDir:context.projectDir,canvasId:context.canvasId,canvasName:context.canvasName,startedAt:context.startedAt,updatedAt:new Date().toISOString(),skills:clone(context.skills||[]),nodes:clone(context.nodes||[])};if(existing)Object.assign(existing,meta);else chat.turns.push(meta);
      if(!chat.messages.some(m=>m.id===result.requestId+':user'))chat.messages.push({id:result.requestId+':user',requestId:result.requestId,role:'user',text:context.userText,at:context.startedAt,projectDir:context.projectDir,canvasId:context.canvasId});
      if(state==='completed'&&typeof result.text==='string'&&!chat.messages.some(m=>m.id===result.requestId+':assistant'))chat.messages.push({id:result.requestId+':assistant',requestId:result.requestId,role:'assistant',text:result.text,at:meta.updatedAt,projectDir:context.projectDir,canvasId:context.canvasId});
      await atomicJSON(file,chats);if(['completed','failed','cancelled'].includes(state))await this.chatSession.acknowledge(result.requestId);return {state,text:result.text,threadId,chatId:chat.id,requestId:result.requestId,active:!!result.active};
    });
  }
  async reconcileChat(){this.chatRecoveryMutate||=serial();return this.chatRecoveryMutate(async()=>{if(this.chatSession.ready)await this.chatSession.ready;const record=this.chatSession.record(this.chatSession.state().requestId);if(record?.context?.canvasDir&&!record.result)try{await fs.access(await this.store.documentPath(record.context.canvasDir,'画布.createmore'));}catch{fail('原聊天画布已不存在，已保留回合编号，未把结果写入当前画布','CHAT_CANVAS_MISSING');}try{return await this.saveChatTurn(await this.chatSession.reconcile());}catch(error){const failed=this.chatSession.record(error.chatRequestId);if(failed)await this.saveChatTurn(this.chatSession.resultOf(failed));throw error;}});}
  async agentTool(name,args={},c=this.requireCurrent()){
    if(name==='canvas_read')return {canvasId:c.id,nodes:c.state.nodes.map(n=>({id:n.id,type:n.type,title:n.title,owner:n.owner,content:n.content,prompt:n.prompt,source:n.source,parameters:n.parameters,assetId:n.assetId,outputType:n.outputType,inputs:ports(n,'input'),outputs:ports(n,'output'),editable:n.owner===this.identity.id})),edges:c.state.edges};
    if(name==='canvas_tasks')return this.queue.list({canvasId:c.id});
    if(name==='canvas_generate')return this.submitNode(args.nodeId,undefined,c);
    if(name==='canvas_create'){if(!Object.hasOwn(types,args.type))fail('不支持此节点类型');if(args.source&&!types[args.type].sources.includes(args.source))fail('节点不支持此来源','CAPABILITY_MISMATCH');const n=this.newNode(args.type,{title:String(args.title||types[args.type].name),content:String(args.content||''),prompt:String(args.prompt||''),x:Number.isFinite(args.x)?args.x:120,y:Number.isFinite(args.y)?args.y:150,...(args.source?{source:args.source}:{})},c);c.state.nodes.push(n);c.dirty=true;c.revision++;await this.syncSharedAssets?.(c);this.emit('event',{type:'result',data:{canvasId:c.id,view:c===this.current?await this.view(c):null}});return {nodeId:n.id};}
    if(name==='canvas_update'){const n=c.state.nodes.find(n=>n.id===args.id);if(!n||n.owner!==this.identity.id)fail('只能修改自己的节点','FORBIDDEN');const allowed=['title','content','prompt','x','y','ratio','quality','count','source','parameters'],patch=clone(args.patch||{});for(const [k,v]of Object.entries(patch)){if(!allowed.includes(k))fail('不允许修改该字段：'+k);if(['x','y'].includes(k)&&!Number.isFinite(v))fail('坐标无效');if(k==='source'&&!types[n.type]?.sources.includes(v))fail('节点不支持此来源','CAPABILITY_MISMATCH');if(k==='parameters'&&(!v||Array.isArray(v)||typeof v!=='object'||Object.entries(v).some(([key,value])=>!/^[-\w]{1,80}$/.test(key)||!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))))fail('公开参数只接受有限的字符串、数字或布尔值');if(k==='count'&&(!Number.isInteger(Number(v))||Number(v)<1||Number(v)>(n.type==='image'?8:1)))fail('图片份数应为1–8，其他节点为1');if(['title','content','prompt','ratio','quality'].includes(k)&&typeof v!=='string')fail('文字字段类型无效');}Object.assign(n,patch);c.dirty=true;c.revision++;await this.syncSharedAssets?.(c);this.emit('event',{type:'result',data:{canvasId:c.id,view:c===this.current?await this.view(c):null}});return {updated:true};}
    if(name==='canvas_connect'){const cloneState=clone(c.state);for(const n of cloneState.nodes)if(n.owner===this.identity.id)n.owner='me';const graph=new Graph(cloneState);graph.connect(args.from,args.to,{inputId:args.inputId,outputId:args.outputId});c.state=normalizeState(graph.state,this.identity.id);c.dirty=true;c.revision++;await this.syncSharedAssets?.(c);this.emit('event',{type:'result',data:{canvasId:c.id,view:c===this.current?await this.view(c):null}});return {connected:true};}
    fail('Agent 工具不在允许列表中','FORBIDDEN');
  }
  sharedSnapshot(){const c=this.sharedSession||this.requireCurrent();return {canvasId:c.sharedCanvasId||c.id,version:c.state.version,nodes:clone(c.state.nodes),edges:clone(c.state.edges),groups:clone(c.state.groups),assets:clone(c.state.assets)};}
  async applyShared(snapshot,meta){
    if(this.joiningNewCanvas){const options=this.joiningNewCanvas;this.joiningNewCanvas=null;const created=await this.store.createCanvas(options.projectDir,options.name,emptyState());this.sharedSession=await this.session(options.projectDir,created.id);this.current=this.sharedSession;}
    const c=this.sharedSession;if(!c)fail('共享回调没有绑定画布，拒绝写入当前任意画布','LAN_CANVAS_LOCKED');
    if(c.sharedCanvasId&&snapshot.canvasId!==c.sharedCanvasId&&!this.joiningShared)fail('共享画布身份不匹配，已阻止交叉写入','LAN_CANVAS_MISMATCH');c.sharedCanvasId=snapshot.canvasId;
    const local=new Map(c.state.assets.map(a=>[a.id,a])),sharedIds=new Set((snapshot.assets||[]).map(a=>a.id)),assets=(snapshot.assets||[]).map(meta=>{const a=local.get(meta.id);return a&&a.asset&&(!a.sha256||a.sha256===meta.sha256)?{...meta,...a,sha256:meta.sha256,size:meta.size,owner:meta.owner}:{...meta,title:meta.name,missing:true};});
    for(const a of c.state.assets)if(!sharedIds.has(a.id))assets.push(a);
    const lookup=new Map(assets.filter(a=>a.asset&&!a.missing).map(a=>[a.id,a]));const nodes=clone(snapshot.nodes);
    for(const node of nodes){if(node.assetId){const asset=lookup.get(node.assetId);if(asset)node.asset=asset.asset;else delete node.asset;}else if(node.asset){const known=assets.find(a=>a.asset===node.asset);if(known)node.assetId=known.id;else delete node.asset;}}
    c.state={...c.state,nodes,edges:clone(snapshot.edges),groups:clone(snapshot.groups),assets};c.dirty=true;c.revision++;await this.registerAssets(c);this.emit('event',{type:'shared',data:{canvasId:c.id,view:c===this.current?await this.view(c):null,meta}});
  }
  async sharedAssets(){const c=this.sharedSession||this.requireCurrent();return c.state.assets.map(a=>({id:a.id,name:a.title||a.name,type:a.type,size:a.size,sha256:a.sha256}));}
  async receiveSharedAsset(meta,buffer,{sourcePath}={}){
    const c=this.sharedSession;if(!c)fail('素材同步没有绑定共享画布','LAN_CANVAS_LOCKED');const dir=path.join(c.canvasDir,['image','video','audio','text'].includes(meta.type)?meta.type:'assets');await fs.mkdir(dir,{recursive:true});const ext=path.extname(meta.name||'').replace(/[^.a-zA-Z0-9]/g,'').slice(0,16),file=path.join(dir,id('shared')+ext);if(buffer)await fs.writeFile(file,buffer,{flag:'wx'});else if(sourcePath)await fs.copyFile(sourcePath,file,require('node:fs').constants.COPYFILE_EXCL);else fail('素材同步没有完整文件','LAN_ASSET_INCOMPLETE');const a=await this.store.importAsset(c.projectDir,c.id,file,{copy:false,assetId:meta.id,owner:meta.owner});Object.assign(a,{id:meta.id,sha256:meta.sha256,size:meta.size,owner:meta.owner,title:meta.name,missing:false});c.state.assets=[...c.state.assets.filter(x=>x.id!==a.id),a];for(const node of c.state.nodes)if(node.assetId===a.id)node.asset=a.asset;c.dirty=true;await this.registerAssets(c);this.emit('event',{type:'shared-asset',data:{canvasId:c.id,assetId:a.id,view:c===this.current?await this.view(c):null}});return a;
  }
  async syncSharedAssets(c=this.current){
    const status=await this.collab.status();if(c!==this.sharedSession||!['hosting','joined','disconnected'].includes(status.mode))return;if(status.mode==='disconnected')fail('共享已断线；本地新增素材已保留，重新连接后再同步','LAN_OFFLINE');
    const target=clone(c.state);for(const asset of target.assets){const known=this.collab.state.manifest.find(m=>m.id===asset.id);if(!known)await this.collab.addAsset({id:asset.id,name:asset.title||asset.name,type:asset.type},await this.assetPath(asset.id,c));}
    const canonical=this.collab.state.snapshot;await this.publishDiff(canonical,target);c.state={...c.state,view:target.view,chat:target.chat,settings:target.settings,seq:Math.max(c.state.seq||0,target.seq||0)};c.dirty=true;
  }
  async close(){if(this.closed)return;this.closed=true;clearInterval(this.autoTimer);await this.queue.close();await this.media.close();await this.gateway?.close();await this.collab.leave();await this.hub.close?.();}
}
module.exports={CreateMoreService,emptyState,normalizeState,SOURCES};
