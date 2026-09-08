/* CreateMore canvas prototype. No network or generation requests. */
(function () {
  'use strict';
  const {Graph,types,seed,blankShot,clone}=CanvasModel;
  const $=selector=>document.querySelector(selector);
  const esc=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icons={
    plus:'M12 5v14M5 12h14',close:'m6 6 12 12M18 6 6 18',up:'M12 19V5m-6 6 6-6 6 6',
    panel:'M4 4h16v16H4zM9 4v16',search:'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    filter:'M4 6h16M7 12h10M10 18h4',workflow:'M3 4h6v6H3zM15 14h6v6h-6zM6 10v7h9M15 4h6v6h-6zM9 7h6',
    table:'M3 4h18v16H3zM3 9h18M8 9v11',queue:'M4 5h16M4 12h16M4 19h10',
    save:'M4 3h13l4 4v14H3V3h1M7 3v6h9V3M7 21v-8h10v8',
    share:'M8 12 17 6M8 12l9 6M7 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0M21 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M21 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    agent:'M5 6h14l2 13H3L5 6ZM8 10v4m8-4v4M9 17h6M12 3v3',more:'M5 12h.01M12 12h.01M19 12h.01',
    group:'M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5M7 7h10v10H7z',copy:'M8 8h13v13H8zM4 16H3V3h13v1',
    trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    arrange:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    map:'m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16',
    link:'m9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    grid:'M4 4h16v16H4zM4 10h16M4 16h16M10 4v16M16 4v16',
    spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
    person:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-3a8 8 0 0 1 16 0v3',
    keyboard:'M2 5h20v14H2zM6 9h.1m4 0h.1m4 0h.1m4 0h.1M6 13h.1M9 15h6m3-2h.1',
    help:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M9 8a3 3 0 1 1 4 3c-1 1-1 2-1 3M12 17h.01',
    history:'M3 4v5h5M3 9a9 9 0 1 1 0 7M12 6v6l4 2',settings:'M4 7h16M4 17h16M8 4v6m8 4v6',
    image:'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M17 7h.01',
    video:'M3 5h13v14H3zM16 9l6-4v14l-6-4',audio:'M4 10v4M8 5v14M12 2v20M16 7v10M20 10v4',
    text:'M4 5h16M4 10h16M4 15h16M4 20h10',upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
    download:'M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5',expand:'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5',
    warning:'M12 3 2 21h20L12 3ZM12 9v5m0 3h.01',play:'m7 4 14 8-14 8V4Z',
    folder:'M3 5h7l2 3h9v13H3V5Z',check:'m4 12 5 5L20 6',undo:'M8 4 3 9l5 5M3 9h11a7 7 0 0 1 7 7',
    eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    light:'M12 1v3M12 20v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
    scissors:'m8 8 12 12M8 16 20 4M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0'
  };
  const icon=name=>'<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="'+(icons[name]||icons.workflow)+'"/></svg>';
  const btn=(action,label,ic,extra='')=>'<button data-action="'+action+'" '+extra+'>'+ (ic?icon(ic):'')+label+'</button>';
  function hydrateIcons(scope=document){scope.querySelectorAll('[data-icon]').forEach(el=>{el.insertAdjacentHTML('afterbegin',icon(el.dataset.icon));el.removeAttribute('data-icon')});}
  hydrateIcons();
  const key='createmore.canvas.redesign.v5';
  let data,restored=false;
  try{data=JSON.parse(localStorage.getItem(key));if(!Graph.valid(data))data=null;else restored=true;}catch{data=null;}
  const graph=new Graph(data||seed());
  const ui={selected:new Set(['hero']),tab:'canvas',filter:'all',search:'',source:null,context:null,selectedGroup:null,menuPoint:null,snap:false,showWires:true,space:false,drag:null,clipboard:null,dirty:false,panelKind:null,staged:false,toastTimer:null,ignoreClickUntil:0,autoTimer:null};
  const state=()=>graph.state;
  const toast=message=>{const t=$('#toast');t.textContent=message;t.hidden=false;clearTimeout(ui.toastTimer);ui.toastTimer=setTimeout(()=>t.hidden=true,3200);};
  function dirty(){ui.dirty=true;$('#save-status').textContent='草图有未保存更改';}
  function save(){
    try{localStorage.setItem(key,JSON.stringify(state()));ui.dirty=false;$('#save-status').textContent='草图已保存在此浏览器';return true;}
    catch{$('#save-status').textContent='保存失败 · 请导出草图';toast('浏览器存储不可用或已满，可通过项目面板导出草图。');return false;}
  }
  function timer(){clearInterval(ui.autoTimer);ui.autoTimer=setInterval(()=>{if(ui.dirty)save();},(state().settings?.saveMinutes||5)*60000);}
  function sources(n){return types[n.type].sources;}
  function safeAsset(src){return typeof src==='string'&&(/^(assets\/(mountain|traveler)\.svg)$/.test(src)||/^data:(image\/(png|jpeg|webp)|audio\/[\w.+-]+|video\/[\w.+-]+);base64,/.test(src))?src:'';}
  const thumb=n=>safeAsset(n.asset)?'<img src="'+esc(safeAsset(n.asset))+'" alt="">':icon(types[n.type].icon);
  const isHidden=n=>state().groups.some(g=>g.collapsed&&g.members.includes(n.id));
  function selection(ids){ui.selected=new Set(ids.filter(id=>graph.get(id)));ui.selectedGroup=null;render();}
  function nodeContent(n){
    if(n.error)return '<div class="failure-content">'+icon('warning')+'<strong>生成失败 · 示例</strong><small>'+esc(n.error)+'</small><small>TaskID: '+esc(n.taskId)+'</small></div>';
    if(safeAsset(n.asset)){
      if(n.type==='video')return '<video controls class="media" src="'+esc(safeAsset(n.asset))+'" style="pointer-events:auto"></video>';
      if(n.type==='audio')return '<div class="audio-content"><audio controls src="'+esc(safeAsset(n.asset))+'" style="width:100%"></audio></div>';
      return '<img class="media" draggable="false" src="'+esc(safeAsset(n.asset))+'" alt="'+esc(n.title)+'">'+(n.asset.startsWith('assets/')?'<span class="media-note">构图示意</span>':'')+(Number(n.count)>1?'<span class="media-count">'+icon('image')+' '+esc(n.count)+' 张 · 示例</span>':'');
    }
    if(n.type==='script')return '<div class="story-preview"><header><strong>'+esc(n.title)+'</strong><span class="badge">脚本</span></header>'+n.shots.slice(0,3).map((s,i)=>'<div class="shot-preview"><span>'+String(i+1).padStart(2,'0')+'</span><div><p>'+esc(s.description||'点击编辑镜头内容')+'</p><small>'+esc(s.duration)+'　'+esc(s.size)+'　'+esc(s.camera)+'</small></div></div>').join('')+btn('script','打开脚本节点 →',null,'data-node="'+n.id+'"')+'</div>';
    if(n.type==='style'||n.type==='character')return '<div class="text-content"><span class="style-symbol">'+icon(types[n.type].icon)+'</span><h3>'+esc(n.title)+'</h3><p>'+esc(n.content||'连接目标节点，将风格或角色约束带入创作。')+'</p><small>输出创作约束</small></div>';
    if(n.type==='text'&&n.content)return '<div class="text-content">'+esc(n.content)+'</div>';
    if(n.type==='audio'&&n.content)return '<div class="audio-content"><div class="wave">'+Array.from({length:65},(_,i)=>'<b style="height:'+(9+(i*17)%45)+'px"></b>').join('')+'</div><div class="row">'+icon('audio')+'<span>环境音 · 波形示例</span><span class="grow"></span><small>无音频文件</small></div></div>';
    return '<div class="empty-content">'+icon(types[n.type].icon)+'<small>尝试：</small>'+btn(n.type==='text'?'edit-text':'import',n.type==='text'?'自己编写内容':'添加参考素材',n.type==='text'?'text':'upload','data-node="'+n.id+'"')+'<small>'+esc(types[n.type].name)+'节点</small></div>';
  }
  function nodeTools(n){
    if(!n.content&&!n.asset&&!n.shots.length&&!n.error)return '';
    const attr='data-node="'+n.id+'"';
    let tools='';
    if(n.type==='image')tools=btn('tool','人像质感','person',attr+' data-tool="人像质感"')+btn('tool','多角度','eye',attr+' data-tool="多角度"')+btn('tool','打光','light',attr+' data-tool="打光"')+btn('tool','九宫格','grid',attr+' data-tool="九宫格"')+btn('tool','高清','expand',attr+' data-tool="高清"');
    else if(n.type==='script')tools=btn('script','编辑镜头','table',attr)+btn('generation','生成分镜','image',attr);
    else if(n.type==='audio')tools=btn('tool','截取','scissors',attr+' data-tool="截取"')+btn('tool','变速','audio',attr+' data-tool="变速"')+btn('tool','切分','scissors',attr+' data-tool="切分"');
    else if(n.type==='video')tools=btn('tool','逐帧拉片','table',attr+' data-tool="逐帧拉片"')+btn('tool','片段重拍','video',attr+' data-tool="片段重拍"');
    else tools=btn('edit-text','编辑内容','text',attr);
    return '<div class="node-tools">'+tools+'<i></i>'+btn('download','', 'download',attr+' title="下载内容"')+btn('preview','', 'expand',attr+' title="展开内容"')+'</div>';
  }
  function nodeParams(n){
    const attr='data-node="'+n.id+'"',refs=state().edges.filter(e=>e.to===n.id).map(e=>graph.get(e.from));
    return '<div class="node-params" data-owner="'+n.id+'"><div class="params-references">'+btn('reference','参考','plus',attr)+refs.map(r=>'<span class="ref-tag" title="'+esc(r.title)+'">'+esc(r.title)+'</span>').join('')+'</div><div class="params-tabs">'+btn('tool','标记',null,attr+' data-tool="标记"')+btn('library-styles','风格','spark')+btn('focus-node','聚焦',null,attr)+'</div><textarea aria-label="'+esc(n.title)+' 提示词" data-prop="prompt" placeholder="描述你的创作内容，@ 引用素材">'+esc(n.prompt)+'</textarea><div class="params-options"><select aria-label="生成来源" data-prop="source">'+sources(n).map(s=>'<option'+(n.source===s?' selected':'')+'>'+esc(s)+'</option>').join('')+'</select>'+(['image','video'].includes(n.type)?btn('spec',esc(n.ratio)+' · '+esc(n.quality)+' · '+esc(n.count)+'张',null,attr):'<span class="badge">尚未连接</span>')+btn('generation','', 'up',attr+' class="generate-button" title="检查生成配置"')+'</div><details><summary>高级设置</summary><label>联网搜索<input type="checkbox" data-prop="web" '+(n.web?'checked':'')+'></label><label>智能引用 AutoLink<input type="checkbox" data-prop="autoLink" '+(n.autoLink?'checked':'')+'></label>'+btn('resources','节点配置 ↗','settings')+'</details></div>';
  }
  function renderNodes(){
    $('#nodes').innerHTML=state().nodes.filter(n=>!isHidden(n)).map(n=>'<article class="node '+(ui.selected.has(n.id)?'selected':'')+'" data-id="'+n.id+'" style="left:'+n.x+'px;top:'+n.y+'px;width:'+n.w+'px;height:'+n.h+'px"><div class="node-title">'+icon(types[n.type].icon)+'<span class="title-name">'+esc(n.title)+'</span><small>'+(['image','video'].includes(n.type)?esc(n.ratio):'')+'</small>'+btn('node-menu','', 'more','data-node="'+n.id+'" aria-label="'+esc(n.title)+' 操作"')+'</div>'+nodeTools(n)+'<div class="node-face">'+nodeContent(n)+'</div><button class="port input" data-input="'+n.id+'" aria-label="'+esc(n.title)+' 输入端">+</button><button class="port output" data-output="'+n.id+'" aria-label="'+esc(n.title)+' 输出端">+</button>'+nodeParams(n)+'</article>').join('');
  }
  function groupBounds(g){const b=graph.bounds(g.members);return {x:b.x-35,y:b.y-42,w:b.w+70,h:b.h+80};}
  function renderGroups(){
    $('#groups').innerHTML=state().groups.map(g=>{const b=groupBounds(g);return '<section class="group-box '+(g.collapsed?'collapsed ':'')+(ui.selectedGroup===g.id?'selected':'')+'" data-group="'+g.id+'" style="left:'+b.x+'px;top:'+b.y+'px;width:'+(g.collapsed?300:b.w)+'px;height:'+(g.collapsed?100:b.h)+'px"><div class="group-label" data-group-drag="'+g.id+'">'+btn('collapse',g.collapsed?'›':'⌄',null,'data-group-id="'+g.id+'"')+'<span>'+esc(g.title)+' · '+g.members.length+'</span>'+btn('group-menu','', 'more','data-group-id="'+g.id+'"')+'</div>'+(g.collapsed?'<div class="group-collapsed-text">'+g.members.length+' 个节点已折叠 · 点击箭头展开</div>':'')+'</section>';}).join('');
  }
  function point(n,output){return {x:n.x+(output?n.w+20:-20),y:n.y+n.h/2};}
  const path=(a,b)=>{const bend=Math.max(70,Math.abs(b.x-a.x)*.5);return 'M'+a.x+' '+a.y+' C'+(a.x+bend)+' '+a.y+' '+(b.x-bend)+' '+b.y+' '+b.x+' '+b.y;};
  function renderWires(){
    $('#wires').innerHTML=state().edges.filter(e=>!isHidden(graph.get(e.from))&&!isHidden(graph.get(e.to))).map(e=>'<path data-edge="'+e.id+'" class="'+(ui.selected.has(e.from)||ui.selected.has(e.to)?'active':'')+'" d="'+path(point(graph.get(e.from),true),point(graph.get(e.to),false))+'"/>').join('');
    $('#wires').style.visibility=ui.showWires?'visible':'hidden';
    if(ui.drag?.kind==='wire')$('#wires').insertAdjacentHTML('beforeend','<path class="draft-wire" d="'+path(point(graph.get(ui.drag.from),true),ui.drag.end)+'"/>');
  }
  function treeRow(n){return '<button class="tree-row '+(ui.selected.has(n.id)?'active':'')+'" data-locate="'+n.id+'"><span class="thumb">'+thumb(n)+'</span><span class="label">'+esc(n.title)+'</span><span class="type">'+(n.error?'!':'')+'</span></button>';}
  function renderSide(){
    let html='';
    const visible=state().nodes.filter(n=>(ui.filter==='all'||n.type===ui.filter)&&n.title.toLowerCase().includes(ui.search.toLowerCase()));
    if(ui.tab==='canvas'){
      const grouped=new Set(state().groups.flatMap(g=>g.members));
      html='<div class="tree-group-title"><span>当前画布</span>'+btn('create-menu','', 'plus','title="添加节点"')+'</div>'+visible.filter(n=>!grouped.has(n.id)).map(treeRow).join('');
      state().groups.forEach(g=>{const members=visible.filter(n=>g.members.includes(n.id));if(members.length)html+='<div class="tree-group-title">'+esc(g.title)+'<span>'+members.length+'</span></div>'+members.map(treeRow).join('');});
    }else if(ui.tab==='assets'){
      html='<div class="tree-group-title">外部素材 <small>点击添加到画布</small></div><div class="asset-grid">'+(state().assets||[]).filter(a=>a.title.toLowerCase().includes(ui.search.toLowerCase())).map(a=>'<button data-action="use-asset" data-asset-id="'+a.id+'">'+(a.type==='image'?'<img src="'+esc(safeAsset(a.asset))+'" alt="">':icon(types[a.type].icon))+'<span>'+esc(a.title)+'</span></button>').join('')+'</div>'+btn('import','导入素材','upload','class="full"')+'<div class="tree-group-title">生成素材</div><p class="muted" style="padding:8px;font-size:11px">尚未接入生成来源</p>';
    }else html='<div class="tree-group-title">生成历史</div><p class="muted" style="padding:8px;font-size:12px;line-height:1.9">草图尚未执行生成。<br>历史结果会独立于画布卡片保留。</p>'+btn('diagnosis','查看失败状态示例','warning');
    $('#side-content').innerHTML=html;$('#node-count').textContent='共 '+state().nodes.length+' 个节点';
    document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===ui.tab));
  }
  function renderSelection(){
    $('#agent-refs').innerHTML=[...ui.selected].map(id=>graph.get(id)).filter(Boolean).map(n=>'<button class="ref-tag" data-locate="'+n.id+'">'+icon(types[n.type].icon)+esc(n.title)+'</button>').join('');
    $('#selection-tools').hidden=ui.selected.size<2;$('#selection-count').textContent='已选择 '+ui.selected.size+' 个节点';
  }
  function renderView(){const v=state().view;$('#world').style.transform='translate('+v.x+'px,'+v.y+'px) scale('+v.k+')';$('#viewport').style.backgroundSize=18*v.k+'px '+18*v.k+'px';$('#viewport').style.backgroundPosition=v.x+'px '+v.y+'px';$('#zoom-value').innerHTML=Math.round(v.k*100)+'% <small>⌄</small>';renderMap();}
  function renderMap(){if($('#minimap').hidden)return;const b=graph.bounds(),s=Math.min(200/(b.w+100),120/(b.h+100));ui.map={b,s};const v=state().view,w=$('#workspace');$('#minimap').innerHTML=state().nodes.map(n=>'<rect x="'+(10+(n.x-b.x)*s)+'" y="'+(10+(n.y-b.y)*s)+'" width="'+n.w*s+'" height="'+n.h*s+'" rx="2" fill="'+(ui.selected.has(n.id)?'#68a9ad':'#606568')+'"/>').join('')+'<rect x="'+(10+(-v.x/v.k-b.x)*s)+'" y="'+(10+(-v.y/v.k-b.y)*s)+'" width="'+w.clientWidth/v.k*s+'" height="'+w.clientHeight/v.k*s+'" fill="none" stroke="#abd3d5" stroke-width="1"/>';}
  function render(){ui.selected=new Set([...ui.selected].filter(id=>graph.get(id)));renderNodes();renderGroups();renderWires();renderSide();renderSelection();renderView();}
  function localPoint(clientX,clientY){const r=$('#workspace').getBoundingClientRect();return {x:clientX-r.left,y:clientY-r.top};}
  function worldPoint(clientX,clientY){const p=localPoint(clientX,clientY),v=state().view;return {x:(p.x-v.x)/v.k,y:(p.y-v.y)/v.k};}
  function fit(ids,includeParams=false){
    const b=graph.bounds(ids),w=$('#workspace'),extra=includeParams?230:60;
    const k=Math.max(.15,Math.min(1,(w.clientWidth-100)/(b.w+80),(w.clientHeight-160)/(b.h+extra)));
    state().view={k,x:(w.clientWidth-b.w*k)/2-b.x*k,y:100-b.y*k};
    renderView();
  }
  function locate(id){const n=graph.get(id);if(!n)return;state().groups.forEach(g=>{if(g.members.includes(id))g.collapsed=false;});ui.selected=new Set([id]);closeTransient();fit([id],true);render();}
  function showMenu(html,x,y){const menu=$('#menu');menu.innerHTML=html;menu.hidden=false;menu.style.left='0px';menu.style.top='0px';const r=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(x,innerWidth-r.width-12))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-r.height-12))+'px';}
  function closePanel(force=false){
    if(ui.staged&&!force){toast('配置尚未保存，请选择“保存”或“取消”。');return false;}
    $('#panel').hidden=true;ui.panelKind=null;ui.staged=false;return true;
  }
  function closeTransient(){ $('#menu').hidden=true;return closePanel(); }
  function panel(title,html,kind='generic'){
    if(ui.staged){toast('请先保存或取消当前配置。');return false;}
    $('#menu').hidden=true;$('#panel-title').textContent=title;$('#panel-body').innerHTML=html;$('#panel').hidden=false;ui.panelKind=kind;return true;
  }
  function createMenu(x,y,source){
    ui.source=source||null;ui.menuPoint=worldPoint(x,y);
    let html='<h4>'+(source?'引用该节点生成':'添加节点')+'</h4>';
    Object.entries(types).forEach(([type,t])=>{if(!source||graph.compatible(graph.get(source),{id:'new',type}))html+='<button data-create="'+type+'">'+icon(t.icon)+t.name+(type==='custom'?'<small>工作流</small>':'')+'</button>';});
    html+='<hr><button disabled>'+icon('video')+'3D 导演台 <small>预留</small></button><hr>'+btn('import','上传素材','upload');
    showMenu(html,x,y);
  }
  function create(type,source=ui.source){
    const n0=source?graph.get(source):null,p=ui.menuPoint||worldPoint($('#workspace').getBoundingClientRect().left+$('#workspace').clientWidth/2,innerHeight*.35);
    let x=n0?n0.x+n0.w+150:p.x,y=n0?n0.y:p.y;
    const t=types[type];
    while(state().nodes.some(n=>x<n.x+n.w+35&&x+t.w+35>n.x&&y<n.y+n.h+70&&y+t.h+70>n.y))y+=t.h+100;
    try{const n=graph.create(type,x,y,source);ui.source=null;dirty();locate(n.id);return n;}catch(e){toast(e.message);}
  }
  function nodeMenu(id,x,y){ui.context=id;if(!ui.selected.has(id))selection([id]);showMenu('<h4>'+esc(graph.get(id).title)+'</h4>'+btn('rename','重命名','text')+btn('duplicate','复制','copy','data-menu-copy="1"')+btn('agent-reference','添加到 Agent','agent')+'<hr>'+btn('delete','删除卡片','trash')+'<small style="display:block;padding:6px 9px">删除可撤销，素材记录保留</small>',x,y);}
  function duplicate(){const copies=graph.copy([...ui.selected]);if(copies.length){ui.selected=new Set(copies.map(n=>n.id));dirty();closeTransient();render();}}
  function rename(id,group=false){ui.context=id;const current=group?state().groups.find(g=>g.id===id):graph.get(id);panel('重命名','<form id="rename-form" data-group="'+group+'"><label class="stack">名称<input name="name" maxlength="80" required value="'+esc(current.title)+'"></label><div class="panel-footer">'+btn('close-panel','取消')+'<button type="submit" class="primary">保存名称</button></div></form>','rename');$('#rename-form input')?.select();}
  const shotFields=[['duration','时长'],['description','画面描述'],['size','景别'],['light','光影氛围'],['dialogue','对白·旁白'],['sound','音效'],['camera','运镜']];
  function script(id){
    const n=graph.get(id);if(!n||n.type!=='script')return;ui.context=id;
    const rows=n.shots.map((s,i)=>'<tr><td>'+String(i+1).padStart(2,'0')+'</td>'+shotFields.map(([f])=>'<td contenteditable="plaintext-only" data-shot="'+i+'" data-field="'+f+'">'+esc(s[f])+'</td>').join('')+'</tr>').join('');
    panel(n.title,'<div class="step-bar"><span class="active">① 确认镜头</span><span>② 准备资产</span><span>③ 合成提示词</span></div><div class="row between" style="margin-bottom:14px"><small id="shot-count">'+n.shots.length+' 个镜头 · 编辑后同步至画布</small>'+btn('download-script','导出 CSV','download')+'</div><div class="table-scroll"><table><thead><tr><th>镜号</th>'+shotFields.map(([,name])=>'<th>'+name+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div><div class="panel-footer">'+btn('add-shot','添加镜头','plus')+'<span class="grow"></span>'+btn('prepare-assets','准备资产 →')+btn('close-panel','完成编辑','check','class="primary"')+'</div>','script');
  }
  function tasks(){panel('生成任务','<div class="queue-columns"><section><div class="row between"><h3>本地 ComfyUI</h3><span class="badge">同一实例串行</span></div><div class="empty-queue">'+icon('queue')+'暂无任务<small>连接本机或成员共享的执行设备</small></div>'+btn('connections','配置执行设备 →')+'</section><section><div class="row between"><h3>外部生成</h3><span class="badge">按来源并发</span></div><div class="empty-queue">'+icon('queue')+'暂无任务<small>Codex Image2 · 外部 API</small></div>'+btn('connections','配置生成来源 →')+'</section></div><div class="notice">当前为交互草图，尚未提交任何生成任务。</div>','tasks');}
  function nav(page){const names={project:'项目',lan:'局域网',resources:'创作资源',connections:'连接',settings:'设置'};return '<nav class="panel-nav">'+Object.entries(names).map(([id,name])=>btn(id,name,null,'class="'+(id===page?'active':'')+'"')).join('')+'</nav>';}
  function connections(){panel('连接',nav('connections')+'<p class="muted">配置本机服务与生成来源。卡片内选择本次使用的来源。</p>'+[['本地 ComfyUI','沿用现有安装、模型目录与工作流'],['本机 Codex','订阅登录 · Agent 与 Image2'],['外部 API','平台、模型与执行额度'],['本地模型','本机可用的文字或多模态模型']].map(([name,description])=>'<div class="form-row"><label>'+name+'</label><div class="row between"><div><span class="badge">未连接</span><small>'+description+'</small></div>'+btn('connection-detail','配置 →',null,'data-provider="'+name+'"')+'</div></div>').join(''),'connections');}
  function resources(tab='普通生成节点'){const list=['普通生成节点','卡片工具','自定义节点','Skill'];let body=nav('resources')+'<div class="tabs" style="border-top:0;padding-left:0">'+list.map(t=>btn('resource-tab',t,null,'data-resource="'+t+'" class="'+(t===tab?'active':'')+'"')).join('')+'</div>';
    if(tab==='普通生成节点')body+=['image','video','audio','text'].map(type=>'<div class="form-row"><label>'+icon(types[type].icon)+' '+types[type].name+'</label><div>'+btn('node-config','工作流与来源配置 →',null,'data-type="'+type+'"')+'<small>每类普通节点绑定一套本机 ComfyUI 工作流</small></div></div>').join('');
    else if(tab==='卡片工具')body+='<p class="muted">按素材类型组织工具；每项可选择工作流、模型或本地处理程序。</p>'+['图片 · 人像质感 / 多角度 / 打光 / 高清','视频 · 逐帧拉片 / 片段重拍 / 截取','音频 · 截取 / 变速 / 切分','文本 · 扩写 / 翻译 / 结构整理'].map(t=>'<div class="form-row"><label>'+esc(t.split(' · ')[0])+'</label><span>'+esc(t.split(' · ')[1])+'</span></div>').join('');
    else if(tab==='自定义节点')body+='<div class="notice">通用工作流卡片：每个实例单独选择工作流，公开参数和端口随映射变化。</div><div class="form-row"><label>工作流库</label>'+btn('mapping','查看映射布局 →','workflow')+'</div>';
    else body+='<p class="muted">软件、个人、项目及引用的本机 Skill 分别标记来源。</p>'+btn('library-skills','浏览 Skill 卡片 →','spark');
    panel('创作资源',body,'resources');
  }
  function library(kind){
    const catalog={presets:[['人物探索','参考图、风格与图片节点组成的可复用预设'],['镜头构思','创作笔记与分镜脚本'],['声音草案','提示文本与音频节点']],styles:[['寂静山野','自然漫射光，低饱和绿色，克制的电影构图'],['胶片纪实','细腻颗粒，自然反差与生活感'],['冷色未来','冷色环境与局部暖色光源']],characters:[['山野旅人','风衣、旧信纸、背包；保留身份特征'],['森林向导','沉静的观察者，实用的户外服装'],['新角色','建立外观、服饰与身份描述']],skills:[['电影画面提示词','构图、光线、镜头语言'],['剧本转分镜','拆解镜头与叙事信息'],['角色一致性','维护跨镜头身份特征']]};
    panel({presets:'预设库',styles:'风格库',characters:'角色库',skills:'Skill'}[kind],'<div class="resource-cards">'+catalog[kind].map(([name,desc],i)=>'<article class="resource-card"><img src="assets/'+(i===1?'traveler':'mountain')+'.svg" alt="示意封面"><div><h3>'+name+'</h3><p>'+desc+'</p>'+btn('apply-resource',kind==='skills'?'添加到对话':'应用到画布',null,'data-kind="'+kind+'" data-name="'+name+'" data-description="'+esc(desc)+'"')+'</div></article>').join('')+'</div><p class="muted" style="font-size:11px">应用到画布创建独立卡片；不会自动提交生成。</p>','library');
  }
  function generation(id){const n=graph.get(id);panel('检查生成配置','<div class="notice">尚未连接生成来源，本次没有提交任务。</div><div class="form-row"><label>当前卡片</label><span>'+esc(n?.title||'当前选区')+'</span></div><div class="form-row"><label>来源</label><span>'+esc(n?.source||'未选择')+'</span></div><div class="panel-footer">'+btn('connections','配置连接','settings','class="primary"')+btn('tasks','查看任务队列','queue')+'</div>','generation');}
  function downloadText(name,text,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function download(n){if(!n)return;if(n.asset&&safeAsset(n.asset)){const a=document.createElement('a');a.href=safeAsset(n.asset);a.download=n.title+(n.asset.startsWith('assets/')?'.svg':'');a.click();}else if(n.type==='script')downloadScript(n);else downloadText(n.title+'.txt',n.content||n.prompt);}
  function downloadScript(n){const rows=[['镜号',...shotFields.map(f=>f[1])],...n.shots.map((s,i)=>[i+1,...shotFields.map(([f])=>s[f])])];downloadText(n.title+'.csv','\ufeff'+rows.map(r=>r.map(c=>'"'+String(c??'').replace(/"/g,'""').replace(/^[=+@-]/,"'$&")+'"').join(',')).join('\r\n'),'text/csv;charset=utf-8');}
  function showProject(){panel('项目 · 山野来信',nav('project')+'<div class="resource-cards"><article class="resource-card"><img src="assets/mountain.svg" alt="画布封面"><div><h3>人物与镜头</h3><p>'+state().nodes.length+' 个节点 · 当前画布</p>'+btn('close-panel','返回画布 →')+'</div></article></div><div class="panel-footer">'+btn('export','导出此草图','download')+btn('save','保存浏览器草稿','save')+'</div><p class="muted" style="font-size:12px">本版支持浏览器草稿及 JSON 导出；正式项目的打开、打包和多画布管理待接入。</p>','project');}
  function settings(){panel('设置',nav('settings')+'<form id="settings-form" data-staged><div class="form-row"><label for="save-minutes">定时保存间隔</label><input id="save-minutes" name="minutes" type="number" min="1" max="60" required value="'+(state().settings?.saveMinutes||5)+'"></div><p class="muted">单位：分钟。有更改时保存浏览器草稿。工程历史自动保存目录与份数管理在正式软件中实现。</p><div class="panel-footer">'+btn('cancel-config','取消')+'<button class="primary" type="submit">保存设置</button></div></form>','settings');}
  function keys(){const entries=[['添加节点','双击空白 / 右键 / Tab'],['平移画布','空格 + 拖动 / 中键'],['缩放画布','滚轮'],['增加或移除选区','Shift + 点击'],['框选','拖动空白区域'],['复制 / 粘贴选区','Ctrl+C / Ctrl+V'],['复制到旁边','Ctrl+D / Alt + 拖动'],['撤销 / 重做','Ctrl+Z / Ctrl+Shift+Z'],['分组','Ctrl+G'],['删除卡片','Delete'],['保存草图','Ctrl+S'],['关闭浮窗','Esc']];panel('快捷键','<div class="shortcut-grid">'+entries.map(([a,b])=>'<div><span>'+a+'</span><kbd>'+b+'</kbd></div>').join('')+'</div>','keys');}
  function preview(n){panel(n.title,n.asset&&safeAsset(n.asset)?(n.type==='image'?'<img src="'+esc(safeAsset(n.asset))+'" style="max-width:100%;max-height:65vh;display:block;margin:auto" alt="'+esc(n.title)+'">':'<'+n.type+' controls src="'+esc(safeAsset(n.asset))+'" style="width:100%"></'+n.type+'>'):'<div class="log">'+esc(n.content||n.prompt||'暂无内容')+'</div>','preview');}
  function action(name,b,event){
    const id=b?.dataset.node||ui.context||[...ui.selected][0],n=graph.get(id),r=b?.getBoundingClientRect(),x=r?.left||innerWidth/2,y=r?.bottom||100;
    switch(name){
      case 'left':$('#app').classList.toggle('left-closed');$('#reopen-left').hidden=!$('#app').classList.contains('left-closed');renderView();break;
      case 'agent':$('#app').classList.toggle('agent-closed');break;
      case 'navigation':showMenu(['project','lan','resources','connections','settings'].map((a,i)=>btn(a,['项目','局域网','创作资源','连接','设置'][i],['folder','share','workflow','link','settings'][i])).join('')+'<hr>'+btn('keys','快捷键','keyboard')+btn('help','帮助与诊断','help'),x,y);break;
      case 'project':case 'canvases':showProject();break;
      case 'connections':connections();break;
      case 'resources':resources();break;
      case 'resource-tab':resources(b.dataset.resource);break;
      case 'settings':settings();break;
      case 'lan':case 'share':panel('局域网协作',nav('lan')+'<div class="notice">当前画布仅在本机浏览器。局域网共享尚未接入。</div><div class="form-row"><label>画布共享</label><button disabled>开始共享</button></div><div class="form-row"><label>成员权限</label><span>成员修改自己的卡片，可引用或复制他人的内容</span></div><div class="form-row"><label>执行资源</label><span>默认使用自己的来源，共享执行资源需主动开启</span></div><div class="form-row"><label>素材副本</label><span>成员持有完整素材；停止共享不撤回副本</span></div>','lan');break;
      case 'workflow':closeTransient();fit();break;
      case 'storyboard-view':{const s=state().nodes.find(n=>n.type==='script');if(s)script(s.id);else toast('请先创建分镜脚本节点。');break;}
      case 'create-menu':createMenu(x,y);break;
      case 'tasks':tasks();break;
      case 'save':save();break;
      case 'export':downloadText('CreateMore-草图.json',JSON.stringify(state(),null,2),'application/json');break;
      case 'close-panel':closePanel();break;
      case 'cancel-config':closePanel(true);break;
      case 'filter':showMenu('<h4>节点类型</h4>'+btn('set-filter','全部',null,'data-filter="all"')+Object.entries(types).map(([type,t])=>btn('set-filter',t.name,t.icon,'data-filter="'+type+'"')).join(''),x,y);break;
      case 'set-filter':ui.filter=b.dataset.filter;$('#menu').hidden=true;renderSide();break;
      case 'node-menu':nodeMenu(id,x,y);break;
      case 'rename':rename(id);break;
      case 'duplicate':duplicate();break;
      case 'delete':graph.remove([...ui.selected]);ui.selected.clear();dirty();closeTransient();render();break;
      case 'agent-reference':$('#app').classList.remove('agent-closed');$('#menu').hidden=true;renderSelection();$('#chat-input').focus();break;
      case 'focus-node':locate(id);break;
      case 'reference':showMenu('<h4>选择画布节点作为参考</h4>'+state().nodes.filter(other=>other.id!==id&&graph.compatible(other,n)).map(other=>btn('add-reference',esc(other.title),types[other.type].icon,'data-from="'+other.id+'" data-node="'+id+'"')).join(''),x,y);break;
      case 'add-reference':try{graph.connect(b.dataset.from,id);dirty();$('#menu').hidden=true;render();}catch(e){toast(e.message);}break;
      case 'spec':ui.context=id;panel('输出规格','<form id="spec-form"><div class="form-row"><label>比例</label><select name="ratio">'+['16:9','3:2','1:1','9:16'].map(v=>'<option'+(n.ratio===v?' selected':'')+'>'+v+'</option>').join('')+'</select></div><div class="form-row"><label>清晰度</label><select name="quality">'+['1K','2K','4K'].map(v=>'<option'+(n.quality===v?' selected':'')+'>'+v+'</option>').join('')+'</select></div><div class="form-row"><label>数量</label><input type="number" name="count" value="'+esc(n.count)+'" min="1" max="8" required></div><div class="panel-footer">'+btn('cancel-config','取消')+'<button class="primary" type="submit">保存规格</button></div></form>','spec');break;
      case 'generation':generation(id);break;
      case 'script':script(id);break;
      case 'add-shot':graph.checkpoint();n.shots.push(blankShot());dirty();script(id);renderNodes();break;
      case 'prepare-assets':panel('准备资产','<div class="notice">镜头表已保留。可先在画布中创建角色和参考素材，再将它们连接到脚本节点。</div>'+btn('close-panel','回到画布')+'<p class="muted">资产识别和提示词合成需配置生成来源。</p>','assets');break;
      case 'download-script':downloadScript(n);break;
      case 'edit-text':ui.context=id;panel('编辑 · '+n.title,'<label class="stack">内容<textarea id="text-editor" style="min-height:240px">'+esc(n.content)+'</textarea></label><div class="panel-footer"><small>编辑同步到当前节点</small>'+btn('close-panel','完成编辑',null,'class="primary"')+'</div>','text');break;
      case 'download':download(n);break;
      case 'preview':preview(n);break;
      case 'tool':ui.context=id;panel(b.dataset.tool,'<div class="form-row"><label>来源素材</label><span>'+esc(n.title)+'</span></div><div class="form-row"><label>处理方式</label><span>在卡片工具设置中配置工作流、模型或本地程序</span></div><div class="notice">处理成功后创建关联来源的新卡片，原始素材保留。本版尚未接入处理程序。</div><div class="panel-footer">'+btn('resources','卡片工具设置','settings')+btn('close-panel','返回画布')+'</div>','tool');break;
      case 'group':try{const g=graph.group([...ui.selected]);dirty();render();rename(g.id,true);}catch(e){toast(e.message);}break;
      case 'collapse':{const g=state().groups.find(g=>g.id===b.dataset.groupId);graph.checkpoint();g.collapsed=!g.collapsed;dirty();render();break;}
      case 'group-menu':ui.context=b.dataset.groupId;showMenu(btn('rename-group','重命名','text')+btn('ungroup','解组','group')+btn('save-preset','保存为预设','workflow'),x,y);break;
      case 'rename-group':rename(ui.context,true);break;
      case 'ungroup':graph.checkpoint();state().groups=state().groups.filter(g=>g.id!==ui.context);dirty();$('#menu').hidden=true;render();break;
      case 'save-preset':{const g=state().groups.find(g=>g.id===ui.context);if(g){const ids=g.members;downloadText(g.title+'-预设.json',JSON.stringify({nodes:state().nodes.filter(n=>ids.includes(n.id)),edges:state().edges.filter(e=>ids.includes(e.from)&&ids.includes(e.to))},null,2),'application/json');}break;}
      case 'arrange':{graph.checkpoint();const nodes=ui.selected.size>1?state().nodes.filter(n=>ui.selected.has(n.id)):state().nodes.filter(n=>n.owner==='me');nodes.forEach((n,i)=>{n.x=80+(i%3)*530;n.y=150+Math.floor(i/3)*520;});dirty();render();fit();break;}
      case 'wires':ui.showWires=!ui.showWires;b.classList.toggle('active',ui.showWires);renderWires();break;
      case 'snap':ui.snap=!ui.snap;b.classList.toggle('active',ui.snap);break;
      case 'minimap':$('#minimap').hidden=!$('#minimap').hidden;renderMap();break;
      case 'zoom':showMenu(btn('fit','适应全部','expand')+btn('fit-selected','适应选区','expand')+'<hr>'+[50,75,100,125,150].map(z=>btn('set-zoom',z+'%',null,'data-zoom="'+z+'"')).join(''),x,y-220);break;
      case 'fit':fit();$('#menu').hidden=true;break;
      case 'fit-selected':fit([...ui.selected],true);$('#menu').hidden=true;break;
      case 'set-zoom':zoomAt(Number(b.dataset.zoom)/100,$('#workspace').clientWidth/2,$('#workspace').clientHeight/2);$('#menu').hidden=true;break;
      case 'import':ui.importTarget=b?.dataset.node||null;$('#file-input').click();$('#menu').hidden=true;break;
      case 'use-asset':{const a=state().assets.find(a=>a.id===b.dataset.assetId);if(a){const added=create(a.type,null);if(added){added.asset=a.asset;added.title=a.title;added.content='引用素材';dirty();render();}}break;}
      case 'library-presets':case 'library-styles':case 'library-characters':case 'library-skills':library(name.replace('library-',''));break;
      case 'apply-resource':{
        const kind=b.dataset.kind,title=b.dataset.name,description=b.dataset.description;
        if(kind==='skills'){$('#chat-input').value+='/'+title+' ';$('#app').classList.remove('agent-closed');closePanel();$('#chat-input').focus();break;}
        ui.menuPoint=worldPoint($('#workspace').getBoundingClientRect().left+$('#workspace').clientWidth/2,innerHeight*.3);
        const n1=create(kind==='styles'?'style':kind==='characters'?'character':'text',null);if(!n1)break;n1.title=title;n1.content=description;
        if(kind==='presets'){const n2=graph.create(title==='镜头构思'?'script':title==='声音草案'?'audio':'image',n1.x+n1.w+140,n1.y,n1.id);ui.selected=new Set([n1.id,n2.id]);}
        dirty();render();fit([...ui.selected],true);break;
      }
      case 'keys':keys();break;
      case 'help':panel('帮助与诊断','<div class="row">'+btn('keys','快捷键','keyboard')+btn('diagnosis','当前画布诊断','warning')+btn('export','导出草图','download')+'</div><p class="muted">CreateMore · 全新画布草图 V5<br>当前支持本地画布编辑与浏览器草稿。ComfyUI、Codex、API、局域网及媒体处理尚未接入。</p>','help');break;
      case 'diagnosis':panel('当前画布诊断','<div class="log">状态：交互草图，未执行生成\n\n示例失败：旁白提示词超过长度限制\n来源：外部生成 · 示例\nTaskID：DEMO-VO-001\n\n真实连接：ComfyUI / Codex / API 均尚未接入</div><div class="panel-footer">'+btn('diagnosis-locate','定位失败卡片','warning')+btn('connections','连接设置','settings')+'</div>','diagnosis');break;
      case 'diagnosis-locate':locate('failure');break;
      case 'send':if($('#chat-input').value.trim()){toast('本机 Codex 尚未连接，输入已保留。');connections();}break;
      case 'agent-new':if($('#chat-input').value.trim()){toast('当前输入已保留，可先复制或清空后新建对话。');}else toast('当前已是新对话。');break;
      case 'agent-history':panel('历史对话','<p class="muted">尚未连接 Codex，没有历史对话。</p>','agent-history');break;
      case 'connection-detail':panel(b.dataset.provider+' · 连接配置','<p class="muted">连接配置布局预览，当前不会启动服务或保存凭据。</p><div class="form-row"><label>状态</label><span class="badge">未连接</span></div><div class="form-row"><label>本机位置 / 服务地址</label><input disabled placeholder="正式接入后选择安装位置或填写地址"></div><div class="panel-footer">'+btn('connections','返回连接列表')+'</div>','connection-detail');break;
      case 'node-config':panel(types[b.dataset.type].name+' · 普通生成节点','<div class="form-row"><label>默认 ComfyUI 工作流</label>'+btn('mapping','工作流与映射 →','workflow')+'</div><div class="form-row"><label>可用来源</label><span>'+types[b.dataset.type].sources.map(esc).join(' / ')+'</span></div><p class="muted">此处是软件级默认配置；卡片参数只影响当前卡片。</p>','node-config');break;
      case 'mapping':panel('工作流映射','<div class="queue-columns"><section><h3>原生 ComfyUI 工作流</h3><div class="empty-queue">'+icon('workflow')+'选择工作流后在此编辑</div></section><section><h3>公开输入与输出</h3><div class="form-row"><label>输入</label><span>参考图、提示词、尺寸</span></div><div class="form-row"><label>输出</label><span>主预览、素材文件</span></div><small>同时保存普通 JSON、执行数据和映射配置。</small></section></div><div class="notice">布局预留，原生编辑器与执行服务尚未接入。</div>','mapping');break;
      case 'remove-edge':{const e=state().edges.find(e=>e.id===b.dataset.edgeId);if(e){graph.checkpoint();state().edges=state().edges.filter(edge=>edge!==e);dirty();$('#menu').hidden=true;render();}break;}
    }
  }
  function zoomAt(k,x,y){const v=state().view,next=Math.max(.15,Math.min(2,k));v.x=x-(x-v.x)*next/v.k;v.y=y-(y-v.y)*next/v.k;v.k=next;renderView();}
  document.addEventListener('click',event=>{
    if(Date.now()<ui.ignoreClickUntil)return;
    if(ui.staged&&!event.target.closest('#panel')){toast('请先保存或取消当前配置。');return;}
    const b=event.target.closest('button');
    if(b?.dataset.create){create(b.dataset.create);return;}
    if(b?.dataset.locate){locate(b.dataset.locate);return;}
    if(b?.dataset.output){const r=b.getBoundingClientRect();createMenu(r.right+8,r.top,b.dataset.output);return;}
    if(b?.dataset.input){const target=b.dataset.input;const n=graph.get(target),r=b.getBoundingClientRect();ui.context=target;showMenu('<h4>引用画布节点</h4>'+state().nodes.filter(a=>graph.compatible(a,n)).map(a=>btn('add-reference',esc(a.title),types[a.type].icon,'data-node="'+target+'" data-from="'+a.id+'"')).join(''),r.left,r.bottom);return;}
    if(b?.dataset.tab){ui.tab=b.dataset.tab;renderSide();return;}
    if(b?.dataset.skill){$('#chat-input').value+='/'+b.dataset.skill+' ';$('#chat-input').focus();return;}
    if(b?.dataset.action){action(b.dataset.action,b,event);return;}
    const edge=event.target.closest('[data-edge]');if(edge){const e=state().edges.find(e=>e.id===edge.dataset.edge);showMenu('<h4>'+esc(graph.get(e.from).title)+' → '+esc(graph.get(e.to).title)+'</h4>'+btn('remove-edge','移除连线','link','data-edge-id="'+e.id+'"'),event.clientX,event.clientY);return;}
    if(!event.target.closest('#menu'))$('#menu').hidden=true;
  });
  $('#search').addEventListener('input',event=>{ui.search=event.target.value;renderSide();});
  document.addEventListener('focusin',event=>{
    if(event.target.matches('[data-prop],[data-shot],#text-editor'))graph.checkpoint();
  });
  document.addEventListener('input',event=>{
    const field=event.target;
    if(field.closest('#settings-form,#spec-form,#rename-form'))ui.staged=true;
    if(field.dataset.prop){const n=graph.get(field.closest('[data-owner]').dataset.owner);if(n.owner!=='me')return;n[field.dataset.prop]=field.type==='checkbox'?field.checked:field.value;dirty();}
    if(field.dataset.shot){const n=graph.get(ui.context);n.shots[Number(field.dataset.shot)][field.dataset.field]=field.textContent;dirty();}
    if(field.id==='text-editor'){graph.get(ui.context).content=field.value;dirty();}
    if(field.id==='chat-input'&&/[\/@]$/.test(field.value)){const r=field.getBoundingClientRect();showMenu(field.value.endsWith('/')?'<h4>调用 Skill</h4>'+['电影画面提示词','剧本转分镜','角色一致性'].map(s=>'<button data-skill="'+s+'">'+icon('spark')+s+'</button>').join(''):'<h4>引用节点</h4>'+state().nodes.map(n=>'<button data-locate="'+n.id+'">'+icon(types[n.type].icon)+esc(n.title)+'</button>').join(''),r.left,r.top-240);}
  });
  document.addEventListener('focusout',event=>{if(event.target.matches('[data-shot],#text-editor')){renderNodes();renderSide();}});
  document.addEventListener('submit',event=>{
    event.preventDefault();const form=event.target,values=new FormData(form);
    if(form.id==='rename-form'){const title=String(values.get('name')).trim();if(!title)return;graph.checkpoint();if(form.dataset.group==='true')state().groups.find(g=>g.id===ui.context).title=title;else graph.get(ui.context).title=title;}
    if(form.id==='spec-form'){graph.checkpoint();Object.assign(graph.get(ui.context),Object.fromEntries(values));}
    if(form.id==='settings-form'){graph.checkpoint();state().settings.saveMinutes=Number(values.get('minutes'));timer();}
    ui.staged=false;dirty();closePanel(true);render();
  });
  const viewport=$('#viewport');
  viewport.addEventListener('pointerdown',event=>{
    if(ui.staged)return;
    if(event.button===2)return;
    const start=worldPoint(event.clientX,event.clientY),local=localPoint(event.clientX,event.clientY);
    if(ui.space||event.button===1){event.preventDefault();ui.drag={kind:'pan',x:event.clientX,y:event.clientY,v:clone(state().view)};viewport.setPointerCapture(event.pointerId);return;}
    const output=event.target.closest('[data-output]');
    if(output){ui.drag={kind:'wire',from:output.dataset.output,end:start,x:event.clientX,y:event.clientY,moved:false};$('#workspace').classList.add('connecting');return;}
    if(event.target.closest('button,input,textarea,select,details,[contenteditable],audio,video'))return;
    const nodeEl=event.target.closest('.node'),groupEl=event.target.closest('[data-group]');
    if(nodeEl){
      const id=nodeEl.dataset.id,n=graph.get(id);
      if(event.shiftKey){ui.selected.has(id)?ui.selected.delete(id):ui.selected.add(id);render();return;}
      if(!ui.selected.has(id))ui.selected=new Set([id]);
      if(event.target.closest('.text-content')){document.querySelectorAll('.node').forEach(el=>el.classList.toggle('selected',ui.selected.has(el.dataset.id)));renderSelection();renderSide();renderWires();return;}
      const ids=[...ui.selected].filter(id=>graph.get(id).owner==='me');
      if(!ids.length){render();return;}
      closeTransient();
      if(event.altKey){const copies=graph.copy(ids,0,0);ui.selected=new Set(copies.map(n=>n.id));dirty();}
      ui.drag={kind:'nodes',start,positions:[...ui.selected].map(id=>({id,x:graph.get(id).x,y:graph.get(id).y})),moved:false,checkpoint:event.altKey};
      render();viewport.setPointerCapture(event.pointerId);event.preventDefault();return;
    }
    if(groupEl){const g=state().groups.find(g=>g.id===groupEl.dataset.group);ui.selected=new Set(g.members);ui.selectedGroup=g.id;ui.drag={kind:'nodes',start,positions:g.members.map(id=>({id,x:graph.get(id).x,y:graph.get(id).y})),moved:false,checkpoint:false};render();viewport.setPointerCapture(event.pointerId);return;}
    if(event.target.closest('[data-edge]'))return;
    closeTransient();ui.drag={kind:'marquee',local,start,original:event.shiftKey?[...ui.selected]:[],moved:false};if(!event.shiftKey)ui.selected.clear();render();viewport.setPointerCapture(event.pointerId);
  });
  document.addEventListener('pointermove',event=>{
    const d=ui.drag;if(!d)return;
    if(d.kind==='pan'){state().view.x=d.v.x+event.clientX-d.x;state().view.y=d.v.y+event.clientY-d.y;renderView();return;}
    const p=worldPoint(event.clientX,event.clientY);
    if(d.kind==='wire'){d.end=p;d.moved=Math.abs(event.clientX-d.x)+Math.abs(event.clientY-d.y)>6;renderWires();return;}
    if(d.kind==='nodes'){const dx=p.x-d.start.x,dy=p.y-d.start.y;d.moved=d.moved||Math.abs(dx)+Math.abs(dy)>3;if(!d.moved)return;if(!d.checkpoint){graph.checkpoint();d.checkpoint=true;}d.positions.forEach(pos=>{const n=graph.get(pos.id);n.x=ui.snap?Math.round((pos.x+dx)/18)*18:pos.x+dx;n.y=ui.snap?Math.round((pos.y+dy)/18)*18:pos.y+dy;const el=document.querySelector('.node[data-id="'+n.id+'"]');if(el){el.style.left=n.x+'px';el.style.top=n.y+'px';}});renderGroups();renderWires();renderMap();return;}
    if(d.kind==='marquee'){const local=localPoint(event.clientX,event.clientY),x=Math.min(local.x,d.local.x),y=Math.min(local.y,d.local.y),w=Math.abs(local.x-d.local.x),h=Math.abs(local.y-d.local.y);d.moved=w+h>5;const m=$('#marquee');m.hidden=!d.moved;m.style.cssText='left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px';const minX=Math.min(p.x,d.start.x),minY=Math.min(p.y,d.start.y),maxX=Math.max(p.x,d.start.x),maxY=Math.max(p.y,d.start.y);ui.selected=new Set([...d.original,...state().nodes.filter(n=>!isHidden(n)&&n.x<maxX&&n.x+n.w>minX&&n.y<maxY&&n.y+n.h>minY).map(n=>n.id)]);document.querySelectorAll('.node').forEach(n=>n.classList.toggle('selected',ui.selected.has(n.dataset.id)));renderSelection();renderWires();}
  });
  document.addEventListener('pointerup',event=>{
    const d=ui.drag;if(!d)return;
    ui.drag=null;$('#marquee').hidden=true;$('#workspace').classList.remove('connecting');
    if(d.kind==='wire'){const target=d.moved?document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-input]'):null;if(target){try{graph.connect(d.from,target.dataset.input);dirty();}catch(e){toast(e.message);}}else createMenu(event.clientX,event.clientY,d.from);ui.ignoreClickUntil=Date.now()+120;}
    if(d.kind==='nodes'&&d.moved){dirty();ui.ignoreClickUntil=Date.now()+100;}
    if(d.kind==='marquee'&&d.moved)ui.ignoreClickUntil=Date.now()+100;
    render();if(d.kind==='pan')renderView();
  });
  document.addEventListener('pointercancel',()=>{ui.drag=null;$('#marquee').hidden=true;$('#workspace').classList.remove('connecting');render();});
  viewport.addEventListener('dblclick',event=>{if(!event.target.closest('.node,.group-box'))createMenu(event.clientX,event.clientY);});
  viewport.addEventListener('contextmenu',event=>{event.preventDefault();if(ui.staged)return;const el=event.target.closest('.node');if(el)nodeMenu(el.dataset.id,event.clientX,event.clientY);else createMenu(event.clientX,event.clientY);});
  viewport.addEventListener('wheel',event=>{if(event.target.closest('textarea,select,.node-params,.text-content'))return;event.preventDefault();const p=localPoint(event.clientX,event.clientY);zoomAt(state().view.k*Math.exp(-event.deltaY*.0013),p.x,p.y);},{passive:false});
  document.addEventListener('keydown',event=>{
    if(event.target.closest('input,textarea,select,[contenteditable]')){if(event.key==='Escape')$('#menu').hidden=true;return;}
    if(ui.staged&&event.key!=='Escape')return;
    if(event.key===' '){ui.space=true;event.preventDefault();$('#workspace').style.cursor='grab';}
    if(event.key==='Escape'){closeTransient();return;}
    const mod=event.ctrlKey||event.metaKey,k=event.key.toLowerCase();
    if(mod&&['z','y','c','v','d','g','s','a'].includes(k)){event.preventDefault();
      if(k==='z'||k==='y'){(k==='y'||event.shiftKey)?graph.redo():graph.undo();dirty();render();}
      if(k==='c')ui.clipboard={nodes:clone(state().nodes.filter(n=>ui.selected.has(n.id))),edges:clone(state().edges.filter(e=>ui.selected.has(e.from)&&ui.selected.has(e.to)))};
      if(k==='v'&&ui.clipboard){graph.checkpoint();const map=new Map();const copies=ui.clipboard.nodes.map(n=>{const c=clone(n);c.id='n'+(++state().seq);map.set(n.id,c.id);c.x+=70;c.y+=70;c.owner='me';c.title+=' · 副本';delete c.taskId;delete c.error;return c;});state().nodes.push(...copies);state().edges.push(...ui.clipboard.edges.map(e=>({id:'e'+(++state().seq),from:map.get(e.from),to:map.get(e.to)})));selection(copies.map(n=>n.id));dirty();}
      if(k==='d')duplicate();if(k==='g')action('group');if(k==='s')save();if(k==='a')selection(state().nodes.filter(n=>!isHidden(n)).map(n=>n.id));
    }
    if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();graph.remove([...ui.selected]);ui.selected.clear();dirty();render();}
    if(event.key==='Tab'&&!event.target.closest('#panel,#menu,.agent,.sidebar')){event.preventDefault();const r=$('#workspace').getBoundingClientRect();createMenu(r.left+r.width*.4,r.top+120);}
  });
  document.addEventListener('keyup',event=>{if(event.key===' '){ui.space=false;$('#workspace').style.cursor='';}});
  window.addEventListener('blur',()=>{ui.space=false;ui.drag=null;$('#workspace').classList.remove('connecting');$('#marquee').hidden=true;});
  $('#minimap').addEventListener('pointerdown',event=>{if(!ui.map)return;const r=event.currentTarget.getBoundingClientRect(),{b,s}=ui.map,wx=((event.clientX-r.left)*220/r.width-10)/s+b.x,wy=((event.clientY-r.top)*140/r.height-10)/s+b.y;state().view.x=$('#workspace').clientWidth/2-wx*state().view.k;state().view.y=$('#workspace').clientHeight/2-wy*state().view.k;renderView();});
  $('#file-input').addEventListener('change',async event=>{
    const files=[...event.target.files],target=ui.importTarget;ui.importTarget=null;
    for(const file of files){
      if(file.size>8*1024*1024){toast('草图素材上限为 8 MB，较大文件留待正式素材管理接入。');continue;}
      if(!/^(image\/(png|jpeg|webp)|audio\/|video\/)/.test(file.type)){toast('暂不支持这种素材格式。');continue;}
      const asset=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);}).catch(()=>null);
      if(!asset){toast('文件读取失败。');continue;}
      const type=file.type.split('/')[0],t=graph.get(target);
      if(!state().assets)state().assets=[];
      state().assets.push({id:'asset'+(++state().seq),title:file.name,type,asset});
      if(t&&t.type===type){graph.checkpoint();t.asset=asset;t.content='导入素材';t.title=file.name;}
      else{const n=create(type,null);if(n){n.asset=asset;n.title=file.name;n.content='导入素材';}}
      dirty();render();
    }
    event.target.value='';
  });
  const originalClose=closePanel;
  closePanel=function(force){const kind=ui.panelKind;const ok=originalClose(force);if(ok&&['script','text'].includes(kind))render();return ok;};
  window.addEventListener('resize',renderView);
  if(!restored){render();fit($('#workspace').clientWidth>1500?['reference','style','hero','script']:['reference','style','hero'],true);}else{render();$('#save-status').textContent='已恢复浏览器草稿';}
  timer();
})();
