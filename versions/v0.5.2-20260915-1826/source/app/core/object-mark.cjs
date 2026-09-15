'use strict';
const {path,fs,id,fail}=require('./util.cjs');

const token=mark=>'{{createmore_object:'+mark.id+'}}';
const activeMarkIds=prompt=>new Set([...String(prompt||'').matchAll(/\{\{createmore_object:([a-zA-Z0-9_-]+)\}\}/g)].map(match=>match[1]));
const activeMarks=node=>{const ids=activeMarkIds(node?.prompt);return (Array.isArray(node?.objectMarks)?node.objectMarks:[]).filter(mark=>ids.has(mark.id)&&(!mark.sourceAssetId||mark.sourceAssetId===node.assetId));};
const stripTokens=prompt=>String(prompt||'').replace(/\s*\{\{createmore_object:[a-zA-Z0-9_-]+\}\}\s*/g,' ').replace(/\s{2,}/g,' ').trim();

function cleanJSON(text){
  const raw=String(text||'').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim(),start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start<0||end<=start)fail('识别结果没有返回可用的物体范围','OBJECT_MARK_INVALID');
  try{return JSON.parse(raw.slice(start,end+1));}catch{fail('识别结果格式不完整，请重新点击物体','OBJECT_MARK_INVALID');}
}
function normalizedBox(value,point){
  const source=value?.bbox||value?.box||value?.boundingBox||{},number=key=>Number(source[key]);let x=number('x'),y=number('y'),width=number('width'),height=number('height');
  if(![x,y,width,height].every(Number.isFinite)&&Array.isArray(value?.bbox)&&value.bbox.length===4)[x,y,width,height]=value.bbox.map(Number);
  if(![x,y,width,height].every(Number.isFinite)||width<=0||height<=0)fail('识别结果没有有效的虚线框范围，请重新点击物体','OBJECT_MARK_INVALID');
  x=Math.max(0,Math.min(.98,x));y=Math.max(0,Math.min(.98,y));width=Math.max(.02,Math.min(1-x,width));height=Math.max(.02,Math.min(1-y,height));
  if(point.x<x||point.x>x+width||point.y<y||point.y>y+height){x=Math.max(0,Math.min(1-width,point.x-width/2));y=Math.max(0,Math.min(1-height,point.y-height/2));}
  return {x,y,width,height};
}
function expandPrompt(prompt,node){
  const marks=new Map((node?.objectMarks||[]).map(mark=>[mark.id,mark]));
  return String(prompt||'').replace(/\{\{createmore_object:([a-zA-Z0-9_-]+)\}\}/g,(whole,markId)=>{const mark=marks.get(markId);if(!mark)return '';const b=mark.bbox;return `对象引用：名称“${mark.name}”，对应当前参考图中的归一化区域 x=${b.x.toFixed(3)}, y=${b.y.toFixed(3)}, width=${b.width.toFixed(3)}, height=${b.height.toFixed(3)}。后续指令提到该对象时仅指这个图像区域；输出图像不得绘制定位图钉、虚线框、标签、坐标或说明文字。`;});
}

async function identify(service,args={}){
  const c=service.requireCurrent(),node=c.state.nodes.find(item=>item.id===args.nodeId),x=Number(args.x),y=Number(args.y);
  if(!node||node.owner!==service.identity.id)fail('只能标记自己的图片卡片');
  if(node.type!=='image'||node.cardKind==='asset'||!node.assetId)fail('标记需要生成图片卡片中已经保存的图片','OBJECT_MARK_SOURCE_REQUIRED');
  if(![x,y].every(Number.isFinite)||x<0||x>1||y<0||y>1)fail('图钉位置无效','OBJECT_MARK_POSITION_INVALID');
  const sourceAssetId=node.assetId,projectDir=c.projectDir,canvasId=c.id,sourcePath=await service.assetPath(sourceAssetId,c),config=service.settings.featureBindings?.objectMark||{},provider=['codex','openai-compatible','comfyui'].includes(config.provider)?config.provider:'codex',outputDir=path.join(c.canvasDir,'text');
  await fs.mkdir(outputDir,{recursive:true});
  const prompt=`你是画布中的视觉物体定位器。用户点击了图片归一化坐标 x=${x.toFixed(4)}, y=${y.toFixed(4)}。识别该位置最具体、最有用的可见物体，并给出它在整张图片中的大致外接矩形。坐标必须归一化到 0..1，bbox 使用左上角 x、y、width、height。不要描述整张图，不要输出 Markdown，只返回 JSON：{"name":"简短中文物体名","bbox":{"x":0.0,"y":0.0,"width":0.1,"height":0.1}}。`;
  const snapshot={provider,kind:'text',prompt,references:[{path:sourcePath,type:'image',title:node.title}],parameters:{max_length:512},outputDir,timeoutMs:600000,...(provider==='codex'?{outputSchema:{type:'object',additionalProperties:false,required:['name','bbox'],properties:{name:{type:'string'},bbox:{type:'object',additionalProperties:false,required:['x','y','width','height'],properties:{x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'}}}}}}:{})};
  if(provider==='comfyui')snapshot.workflow=await service.workflowRead(config.workflowId||'default:tool-image-caption');
  const result=await service.hub.run(snapshot,{outputDir}),parsed=cleanJSON(result.text),name=String(parsed.name||parsed.object||'').trim().slice(0,80);
  if(!name)fail('识别结果没有物体名称，请重新点击','OBJECT_MARK_INVALID');
  const mark={id:id('mark'),name,x,y,bbox:normalizedBox(parsed,{x,y}),provider,sourceAssetId,createdAt:new Date().toISOString()};
  return service.mutate(async()=>{const current=service.requireCurrent(),target=current.state.nodes.find(item=>item.id===args.nodeId);if(current.id!==canvasId||current.projectDir!==projectDir||target?.assetId!==sourceAssetId)fail('识别期间图片或画布已改变，请重新标记','OBJECT_MARK_STALE');target.objectMarks=[...(target.objectMarks||[]),mark];const link=token(mark);if(!String(target.prompt||'').includes(link))target.prompt=String(target.prompt||'')+(String(target.prompt||'').trim()?' ':'')+link+' ';current.dirty=true;current.revision++;await service.saveSession(current,false);return {mark,view:await service.view(current)};});
}

module.exports={identify,token,activeMarks,activeMarkIds,expandPrompt,stripTokens,cleanJSON,normalizedBox};
