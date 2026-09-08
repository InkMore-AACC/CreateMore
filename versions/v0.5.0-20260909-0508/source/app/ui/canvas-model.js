(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const typeTable = {
    image: {name:'图片', icon:'image', w:420, h:236, sources:['Codex Image2','外部 API','本地 ComfyUI']},
    video: {name:'视频', icon:'video', w:420, h:236, sources:['外部 API','本地 ComfyUI']},
    audio: {name:'音频', icon:'audio', w:330, h:155, sources:['本地 ComfyUI','RunningHub']},
    text: {name:'文本', icon:'text', w:310, h:230, sources:['Codex','本地模型','外部 API','本地 ComfyUI']},
    script: {name:'分镜脚本', icon:'table', w:440, h:310, sources:['Codex','本地 ComfyUI','本地模型','外部 API']},
    custom: {name:'自定义节点', icon:'workflow', w:330, h:220, sources:['本地 ComfyUI','RunningHub']},
    style: {name:'风格', icon:'spark', w:300, h:230, sources:['Codex','本地 ComfyUI','本地模型','外部 API']},
    character: {name:'角色', icon:'person', w:300, h:230, sources:['Codex','本地模型','外部 API'], creatable:false}
  };
  const types = new Proxy(typeTable,{get:(t,p)=>t[p]||{name:'未知节点 · '+String(p),icon:'warning',w:330,h:220,sources:[]}});
  const mediaType = value => ['image','video','audio','text','style','any'].includes(String(value||'').toLowerCase())?String(value).toLowerCase():'any';
  function ports(n,direction){
    if(!n)return [];
    const input=direction==='input',mapping=n.type==='custom'&&n.workflow?.mapping;
    if(!mapping)return [{id:undefined,label:input?'参考输入':'输出',mediaType:input?'any':n.type==='custom'?mediaType(n.outputType):['script','character'].includes(n.type)?'text':mediaType(n.type),multiple:input,legacy:true}];
    const list=(input?mapping.inputs||[]:mapping.outputs||[]).filter(p=>!input||p.source==='reference').map((p,index)=>({id:String(p.id),label:p.label||p.name||String(p.id),mediaType:mediaType(p.mediaType||p.type),index:p.index??index,multiple:!!p.multiple,control:false}));
    if(input){if((mapping.inputs||[]).some(p=>p.source==='prompt'))list.push({id:'$prompt',label:'提示文字',mediaType:'text',multiple:true,control:true});list.push({id:'$style',label:'风格',mediaType:'style',multiple:true,control:true});}
    return list;
  }
  const portFor=(n,direction,id)=>{const list=ports(n,direction);return id==null||id===''?list[0]:list.find(p=>p.id===String(id));};
  const inputPort=(a,b,id)=>{if(id==null&&b.type==='custom'&&b.workflow?.mapping){if(a.type==='style')return portFor(b,'input','$style');if(['text','script','character'].includes(a.type)&&ports(b,'input').some(p=>p.id==='$prompt'))return portFor(b,'input','$prompt');}return portFor(b,'input',id);};
  const nodeHeight=n=>Math.max(n.h,24+Math.max(ports(n,'input').length,ports(n,'output').length)*28);
  function inViewport(n,view,size,margin=0){const x=n.x*view.k+view.x,y=n.y*view.k+view.y;return x+n.w*view.k>=-margin&&y+nodeHeight(n)*view.k>=-margin&&x<=size.width+margin&&y<=size.height+margin;}
  function portPoint(n,direction,id){const list=ports(n,direction),port=portFor(n,direction,id),index=port?Math.max(0,list.findIndex(p=>p.id===port.id)):0;return {x:n.x+(direction==='output'?n.w+20:-20),y:n.y+nodeHeight(n)*(index+1)/((list.length||1)+1)};}
  const uid = prefix => prefix+'-'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
  const blankShot = () => ({duration:'5s',description:'',size:'',light:'',dialogue:'',sound:'',camera:''});
  const generatorTypes=new Set(['image','video','audio','text','script','custom']);
  function inferCardKind(n){
    if(n?.cardKind==='asset'||n?.cardKind==='generator')return n.cardKind;
    if(!generatorTypes.has(n?.type))return 'asset';
    if(n.type==='custom')return 'generator';
    const generated=!!(n.prompt||n.taskId||n.workflow||n.workflowId||n.toolResource||(n.outputAssets||[]).length);
    if(!generated&&(n.asset||n.assetId||n.content))return 'asset';
    return 'generator';
  }
  const isGenerator=n=>inferCardKind(n)==='generator';
  function mediaBox(ratio,max=420){
    const value=Number(ratio);
    if(!Number.isFinite(value)||value<=0)return {w:max,h:Math.round(max*9/16)};
    return value>=1?{w:max,h:Math.max(120,Math.round(max/value))}:{w:Math.max(120,Math.round(max*value)),h:max};
  }
  function ratioValue(value){const parts=String(value||'').split(':').map(Number);return parts.length===2&&parts.every(Number.isFinite)&&parts[0]>0&&parts[1]>0?parts[0]/parts[1]:NaN;}
  function node(id, type, x, y, overrides) {
    const t=types[type];
    if(!t) throw new Error('未知节点类型');
    const next=Object.assign({id,type,x,y,w:t.w,h:t.h,title:t.name,owner:'me',prompt:'',content:'',source:t.sources[0],ratio:'16:9',count:'1',quality:'2K',cardKind:generatorTypes.has(type)?'generator':'asset',shots:type==='script'?[blankShot()]:[]}, overrides);
    next.cardKind=inferCardKind(next);return next;
  }
  function seed() {
    return {
      version:5, assets:[
        {id:'a1',title:'山野 · 环境参考',type:'image',asset:'assets/mountain.svg'},
        {id:'a2',title:'人物探索 · 构图示意',type:'image',asset:'assets/traveler.svg'}
      ], nodes:[
        node('reference','image',70,150,{title:'山野 · 环境参考',w:300,h:200,asset:'assets/mountain.svg',content:'示例素材'}),
        node('style','style',70,470,{title:'风格 · 寂静山野',content:'自然漫射光，克制的低饱和绿色。\n保留空气透视与远近层次，让人物成为风景中的一个停顿。',prompt:'自然光、雾气、低饱和绿色；人物比例小，远景留白。'}),
        node('hero','image',520,205,{title:'人物探索 · 01',w:410,h:274,asset:'assets/traveler.svg',content:'示例素材',prompt:'清晨，旅人站在山坡上。远山层叠，薄雾缓慢掠过林间。人物背向镜头，衣角被风轻轻吹起。',count:'4'}),
        node('script','script',1110,145,{title:'山野来信 · 镜头表',shots:[
          {duration:'4s',description:'冷雾中的山脊，独行旅人停在高处。',size:'远景',light:'冷色晨光',dialogue:'',sound:'山风、细微鸟鸣',camera:'缓慢推进'},
          {duration:'5s',description:'旅人回过头，注视林线深处。',size:'中景',light:'柔和侧逆光',dialogue:'有人吗？',sound:'衣料声',camera:'轻微环绕'},
          {duration:'4s',description:'旧信纸在手中展开，晨光落在字迹上。',size:'特写',light:'暖色局部光',dialogue:'',sound:'纸张摩擦',camera:'移焦'}
        ]}),
        node('audio','audio',1120,630,{title:'山风 · 氛围音',content:'波形示例',prompt:'疏朗、安静的山风，偶尔有远处鸟鸣，保留长段留白。'}),
        node('failure','audio',1570,630,{title:'旁白 · 待修正',error:'提示词超过当前来源长度限制',taskId:'DEMO-VO-001',prompt:'低沉、克制地讲述旅人收到来信的故事。'}),
        node('text','text',1640,160,{title:'创作笔记',content:'山野来信\n\n先建立空间，再靠近人物。\n\n环境承担情绪，声音连接镜头。叙事从一个停顿开始。',prompt:'整理这组镜头的创作意图。'})
      ],
      edges:[{id:'e1',from:'reference',to:'hero'},{id:'e2',from:'style',to:'hero'},{id:'e3',from:'hero',to:'script'},{id:'e4',from:'script',to:'audio'}],
      groups:[{id:'g1',title:'声音探索',members:['audio','failure'],collapsed:false}],
      view:{x:20,y:10,k:.85}, chat:[], settings:{saveMinutes:5,maxSnapshots:100}, seq:20
    };
  }
  class Graph {
    constructor(data) { this.state=clone(data||seed());this.past=[];this.future=[]; }
    checkpoint(){this.past.push(clone(this.state));if(this.past.length>60)this.past.shift();this.future=[];}
    undo(){if(!this.past.length)return false;this.future.push(clone(this.state));this.restore(this.past.pop());return true;}
    redo(){if(!this.future.length)return false;this.past.push(clone(this.state));this.restore(this.future.pop());return true;}
    restore(snapshot){
      const current=this.state,foreign=current.nodes.filter(n=>n.owner!=='me'),foreignIds=new Set(foreign.map(n=>n.id));
      snapshot.nodes=snapshot.nodes.filter(n=>n.owner==='me'&&!foreignIds.has(n.id)).concat(clone(foreign));
      const ids=new Set(snapshot.nodes.map(n=>n.id));
      snapshot.edges=snapshot.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)&&!foreignIds.has(e.to)).concat(clone(current.edges.filter(e=>foreignIds.has(e.to)&&ids.has(e.from))));
      snapshot.groups=snapshot.groups.filter(g=>g.members.every(id=>ids.has(id)&&!foreignIds.has(id))).concat(clone(current.groups.filter(g=>g.members.some(id=>foreignIds.has(id)))));
      snapshot.assets=[...new Map([...(snapshot.assets||[]),...(current.assets||[])].map(a=>[a.id,a])).values()];
      this.state=snapshot;
    }
    nextId(prefix='n'){this.state.seq++;return uid(prefix);}
    get(id){return this.state.nodes.find(n=>n.id===id);}
    create(type,x,y,from,options={}){
      if(!types[type])throw new Error('未知节点类型');
      if(from&&!this.get(from))throw new Error('来源节点不存在');
      const next=this.state.seq+1,n=node(uid('n'),type,x,y,{title:(options.cardKind==='asset'?'普通':'生成')+types[type].name+' '+next,cardKind:options.cardKind});
      if(from&&!this.compatible(this.get(from),n,options))throw new Error('这两种节点不能直接连接');
      this.checkpoint();this.state.seq=next;this.state.nodes.push(n);
      if(from){this.state.edges.push({id:this.nextId('e'),from,to:n.id,...this.portIds(this.get(from),n,options)});if(type==='text')n.prompt='根据引用素材整理提示词。';}
      return n;
    }
    portIds(a,b,options={}){const output=portFor(a,'output',options.outputId),input=inputPort(a,b,options.inputId);return {...(input?.id!==undefined?{inputId:input.id}:{}),...(output?.id!==undefined?{outputId:output.id}:{})};}
    compatible(a,b,options={}){
      if(!a||!b||a.id===b.id)return false;
      const output=portFor(a,'output',options.outputId),input=inputPort(a,b,options.inputId);
      if(!output||!input)return false;
      if(a.type==='custom'||b.type==='custom'){
        if(input.id==='$style')return a.type==='style';
        if(a.type==='style')return b.type==='custom'?!b.workflow?.mapping:['image','video','audio','text','script'].includes(b.type);
        if(input.id==='$prompt')return ['text','script','character'].includes(a.type)||(a.type==='custom'&&output.mediaType==='text');
        if(b.type==='custom'&&input.mediaType!=='any')return output.mediaType===input.mediaType;
        if(a.type==='custom'&&output.mediaType!=='any')return b.type==='image'?['image','text'].includes(output.mediaType):['style','character'].includes(b.type)?['image','text'].includes(output.mediaType):true;
        return true;
      }
      if(b.type==='style'||b.type==='character')return a.type==='text'||a.type==='image';
      if(a.type==='style')return ['image','video','audio','text','script','custom'].includes(b.type);
      if(b.type==='image')return ['image','text','character','custom'].includes(a.type);
      return true;
    }
    connect(from,to,options={}){
      const a=this.get(from),b=this.get(to);
      if(!a||!b)throw new Error('节点不存在');
      if(b.owner!=='me')throw new Error('只能修改自己的节点输入');
      if(!this.compatible(a,b,options))throw new Error('输入输出端口不存在或类型不兼容');
      const ids=this.portIds(a,b,options),input=portFor(b,'input',ids.inputId);
      const sameInput=e=>e.to===to&&this.portIds(this.get(e.from),b,e).inputId===ids.inputId;
      if(this.state.edges.some(e=>e.from===from&&sameInput(e)&&this.portIds(a,b,e).outputId===ids.outputId))throw new Error('这两个端口已经连接');
      if(!input.multiple&&this.state.edges.some(sameInput))throw new Error('此输入只接收一个来源，请先移除已有连线');
      const seen=new Set(),visit=id=>{if(id===from)return true;if(seen.has(id))return false;seen.add(id);return this.state.edges.filter(e=>e.from===id).some(e=>visit(e.to));};
      if(visit(to))throw new Error('连接会形成循环依赖');
      this.checkpoint();const edge={id:this.nextId('e'),from,to,...ids};this.state.edges.push(edge);return edge;
    }
    copy(ids,dx=60,dy=60){
      const original=this.state.nodes.filter(n=>ids.includes(n.id));if(!original.length)return [];
      this.checkpoint();const map=new Map(),copies=original.map(n=>{const c=clone(n);c.id=this.nextId('n');map.set(n.id,c.id);c.x+=dx;c.y+=dy;c.title+=' · 副本';c.owner='me';delete c.taskId;delete c.error;return c});
      const edges=this.state.edges.filter(e=>map.has(e.from)&&map.has(e.to)).map(e=>({...clone(e),id:this.nextId('e'),from:map.get(e.from),to:map.get(e.to)}));
      this.state.nodes.push(...copies);this.state.edges.push(...edges);return copies;
    }
    remove(ids){const removable=ids.filter(id=>this.get(id)?.owner==='me');if(!removable.length)return;this.checkpoint();this.state.nodes=this.state.nodes.filter(n=>!removable.includes(n.id));this.state.edges=this.state.edges.filter(e=>!removable.includes(e.from)&&!removable.includes(e.to));this.state.groups.forEach(g=>g.members=g.members.filter(id=>!removable.includes(id)));this.state.groups=this.state.groups.filter(g=>g.members.length);}
    group(ids){const members=ids.filter(id=>this.get(id)?.owner==='me');if(members.length<2)throw new Error('请选择至少两个自己的节点');this.checkpoint();this.state.groups.forEach(g=>g.members=g.members.filter(id=>!members.includes(id)));this.state.groups=this.state.groups.filter(g=>g.members.length);const g={id:this.nextId('g'),title:'未命名分组',members,collapsed:false};g.owner='me';this.state.groups.push(g);return g;}
    bounds(ids){const ns=this.state.nodes.filter(n=>!ids||ids.includes(n.id));if(!ns.length)return {x:0,y:0,w:1000,h:700};const x=Math.min(...ns.map(n=>n.x)),y=Math.min(...ns.map(n=>n.y));return {x,y,w:Math.max(...ns.map(n=>n.x+n.w))-x,h:Math.max(...ns.map(n=>n.y+nodeHeight(n)))-y};}
    static valid(s){return s?.version===5&&Array.isArray(s.nodes)&&s.nodes.every(n=>typeof n.type==='string'&&typeof n.id==='string'&&typeof n.title==='string'&&[n.x,n.y,n.w,n.h].every(Number.isFinite)&&n.w>0&&n.h>0)&&new Set(s.nodes.map(n=>n.id)).size===s.nodes.length&&Array.isArray(s.edges)&&s.edges.every(e=>s.nodes.some(n=>n.id===e.from)&&s.nodes.some(n=>n.id===e.to))&&Array.isArray(s.groups)&&s.groups.every(g=>Array.isArray(g.members)&&g.members.every(id=>s.nodes.some(n=>n.id===id)))&&s.view&&[s.view.x,s.view.y,s.view.k].every(Number.isFinite)&&s.view.k>=.15&&s.view.k<=2&&Number.isFinite(s.seq);}
  }
  const api={Graph,types,seed,blankShot,clone,uid,ports,portFor,portPoint,nodeHeight,mediaType,inViewport,inferCardKind,isGenerator,mediaBox,ratioValue};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CanvasModel=api;
})(typeof globalThis!=='undefined'?globalThis:this);
