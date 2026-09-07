'use strict';
// Deterministic, generated-data-only fixture: no user canvas or model invocation.
function snapshot(count=1000){
  const kinds=['video','image','audio','text'];const nodes=Array.from({length:count},(_,i)=>({id:'bench'+i,type:kinds[i%4],owner:'me',x:(i%40)*430,y:80+Math.floor(i/40)*360,w:360,h:220,title:'测试节点 '+i,source:i%4===3?'Codex':'本地 ComfyUI',content:i%4===3?'用于有界渲染测量的文字。':'',prompt:'',ratio:'16:9',count:1,shots:[],...(i%4===3?{}:{asset:'createmore-media://asset/render-fixture'})}));
  return {version:5,nodes,edges:nodes.slice(1).map((n,i)=>({id:'edge'+i,from:nodes[i].id,to:n.id})),groups:[],assets:[],view:{x:20,y:0,k:1},seq:count,chat:[],settings:{saveMinutes:5}};
}
module.exports={snapshot};
