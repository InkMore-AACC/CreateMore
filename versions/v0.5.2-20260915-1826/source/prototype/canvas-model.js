(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const types = {
    image: {name:'图片', icon:'image', w:380, h:254, sources:['Codex Image2','本地 ComfyUI','外部 API']},
    video: {name:'视频', icon:'video', w:380, h:214, sources:['本地 ComfyUI','外部 API']},
    audio: {name:'音频', icon:'audio', w:330, h:155, sources:['本地 ComfyUI','外部 API']},
    text: {name:'文本', icon:'text', w:310, h:230, sources:['Codex','本地模型','外部 API','本地 ComfyUI']},
    script: {name:'分镜脚本', icon:'table', w:440, h:310, sources:['Codex','本地模型','外部 API']},
    custom: {name:'自定义节点', icon:'workflow', w:330, h:220, sources:['本地 ComfyUI','外部 API']},
    style: {name:'风格', icon:'spark', w:300, h:230, sources:['Codex','本地模型','外部 API']},
    character: {name:'角色', icon:'person', w:300, h:230, sources:['Codex','本地模型','外部 API']}
  };
  const blankShot = () => ({duration:'5s',description:'',size:'',light:'',dialogue:'',sound:'',camera:''});
  function node(id, type, x, y, overrides) {
    const t=types[type];
    if(!t) throw new Error('未知节点类型');
    return Object.assign({id,type,x,y,w:t.w,h:t.h,title:t.name,owner:'me',prompt:'',content:'',source:t.sources[0],ratio:'16:9',count:'1',quality:'2K',autoLink:true,web:false,shots:type==='script'?[blankShot()]:[]}, overrides);
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
    undo(){if(!this.past.length)return false;this.future.push(clone(this.state));this.state=this.past.pop();return true;}
    redo(){if(!this.future.length)return false;this.past.push(clone(this.state));this.state=this.future.pop();return true;}
    get(id){return this.state.nodes.find(n=>n.id===id);}
    create(type,x,y,from){
      if(!types[type])throw new Error('未知节点类型');
      if(from&&!this.get(from))throw new Error('来源节点不存在');
      const next=this.state.seq+1,n=node('n'+next,type,x,y,{title:types[type].name+' '+next});
      if(from&&!this.compatible(this.get(from),n))throw new Error('这两种节点不能直接连接');
      this.checkpoint();this.state.seq=next;this.state.nodes.push(n);
      if(from){this.state.edges.push({id:'e'+(++this.state.seq),from,to:n.id});if(type==='text')n.prompt='根据引用素材整理提示词。';}
      return n;
    }
    compatible(a,b){
      if(!a||!b||a.id===b.id)return false;
      if(b.type==='style'||b.type==='character')return a.type==='text'||a.type==='image';
      if(a.type==='style')return ['image','video','text','script','custom'].includes(b.type);
      if(b.type==='image')return ['image','text','character','custom'].includes(a.type);
      return true;
    }
    connect(from,to){
      const a=this.get(from),b=this.get(to);
      if(!a||!b)throw new Error('节点不存在');
      if(b.owner!=='me')throw new Error('只能修改自己的节点输入');
      if(!this.compatible(a,b))throw new Error('输入类型不兼容');
      if(this.state.edges.some(e=>e.from===from&&e.to===to))throw new Error('这两个节点已经连接');
      const seen=new Set(),visit=id=>{if(id===from)return true;if(seen.has(id))return false;seen.add(id);return this.state.edges.filter(e=>e.from===id).some(e=>visit(e.to));};
      if(visit(to))throw new Error('连接会形成循环依赖');
      this.checkpoint();this.state.edges.push({id:'e'+(++this.state.seq),from,to});
    }
    copy(ids,dx=60,dy=60){
      const original=this.state.nodes.filter(n=>ids.includes(n.id));if(!original.length)return [];
      this.checkpoint();const map=new Map(),copies=original.map(n=>{const c=clone(n);c.id='n'+(++this.state.seq);map.set(n.id,c.id);c.x+=dx;c.y+=dy;c.title+=' · 副本';c.owner='me';delete c.taskId;delete c.error;return c});
      const edges=this.state.edges.filter(e=>map.has(e.from)&&map.has(e.to)).map(e=>({id:'e'+(++this.state.seq),from:map.get(e.from),to:map.get(e.to)}));
      this.state.nodes.push(...copies);this.state.edges.push(...edges);return copies;
    }
    remove(ids){const removable=ids.filter(id=>this.get(id)?.owner==='me');if(!removable.length)return;this.checkpoint();this.state.nodes=this.state.nodes.filter(n=>!removable.includes(n.id));this.state.edges=this.state.edges.filter(e=>!removable.includes(e.from)&&!removable.includes(e.to));this.state.groups.forEach(g=>g.members=g.members.filter(id=>!removable.includes(id)));this.state.groups=this.state.groups.filter(g=>g.members.length);}
    group(ids){const members=ids.filter(id=>this.get(id)?.owner==='me');if(members.length<2)throw new Error('请选择至少两个自己的节点');this.checkpoint();this.state.groups.forEach(g=>g.members=g.members.filter(id=>!members.includes(id)));this.state.groups=this.state.groups.filter(g=>g.members.length);const g={id:'g'+(++this.state.seq),title:'未命名分组',members,collapsed:false};this.state.groups.push(g);return g;}
    bounds(ids){const ns=this.state.nodes.filter(n=>!ids||ids.includes(n.id));if(!ns.length)return {x:0,y:0,w:1000,h:700};const x=Math.min(...ns.map(n=>n.x)),y=Math.min(...ns.map(n=>n.y));return {x,y,w:Math.max(...ns.map(n=>n.x+n.w))-x,h:Math.max(...ns.map(n=>n.y+n.h))-y};}
    static valid(s){return s?.version===5&&Array.isArray(s.nodes)&&s.nodes.every(n=>types[n.type]&&typeof n.id==='string'&&typeof n.title==='string'&&[n.x,n.y,n.w,n.h].every(Number.isFinite)&&n.w>0&&n.h>0)&&new Set(s.nodes.map(n=>n.id)).size===s.nodes.length&&Array.isArray(s.edges)&&s.edges.every(e=>s.nodes.some(n=>n.id===e.from)&&s.nodes.some(n=>n.id===e.to))&&Array.isArray(s.groups)&&s.groups.every(g=>Array.isArray(g.members)&&g.members.every(id=>s.nodes.some(n=>n.id===id)))&&s.view&&[s.view.x,s.view.y,s.view.k].every(Number.isFinite)&&s.view.k>=.15&&s.view.k<=2&&Number.isFinite(s.seq);}
  }
  const api={Graph,types,seed,blankShot,clone};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CanvasModel=api;
})(typeof globalThis!=='undefined'?globalThis:this);
