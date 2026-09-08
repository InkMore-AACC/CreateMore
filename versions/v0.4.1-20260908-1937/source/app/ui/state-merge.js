(function(root){
  'use strict';
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function fields(base,local,remote,locked=[]){const result=clone(remote);for(const key of new Set([...Object.keys(base||{}),...Object.keys(local||{})]))if(!locked.includes(key)&&!same(base?.[key],local?.[key])){if(local?.[key]===undefined)delete result[key];else result[key]=clone(local[key]);}return result;}
  function collection(base=[],local=[],remote=[],owns=()=>true,locked=[]){const previous=new Map(base.map(v=>[v.id,v])),mine=new Map(local.map(v=>[v.id,v]));const result=[];for(const item of remote){const before=previous.get(item.id),current=mine.get(item.id);if(!owns(item)){result.push(clone(item));continue;}if(before&&!current)continue;result.push(current?fields(before,current,item,locked):clone(item));}for(const item of local)if(!previous.has(item.id)&&!remote.some(v=>v.id===item.id)&&owns(item))result.push(clone(item));return result;}
  function merge(base,local,remote){base||={};const result=fields(base,local,remote,['nodes','edges','groups','assets','appliedTaskIds']);
    result.nodes=collection(base.nodes,local.nodes,remote.nodes,n=>n.owner==='me',['taskId','asset','assetId','outputAssets','lastResultAt','styleTrace']);
    const own=new Set(result.nodes.filter(n=>n.owner==='me').map(n=>n.id)),ids=new Set(result.nodes.map(n=>n.id));
    result.edges=collection(base.edges,local.edges,remote.edges,e=>own.has(e.to)).filter(e=>ids.has(e.from)&&ids.has(e.to));
    result.groups=collection(base.groups,local.groups,remote.groups,g=>g.owner==='me'||g.members.every(id=>own.has(id))).map(g=>({...g,members:g.members.filter(id=>ids.has(id))}));
    result.assets=collection(base.assets,local.assets,remote.assets,()=>true,['asset','path','sha256','size','type','external','generated','owner']);return result;
  }
  if(typeof module==='object')module.exports={merge};else root.CreateMoreMerge={merge};
})(typeof window==='undefined'?globalThis:window);
