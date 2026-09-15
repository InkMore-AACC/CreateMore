'use strict';
const {fs,path,fail}=require('./util.cjs');
const TEXT_LIMIT=8*1024*1024;
async function readText(file){const info=await fs.stat(file);if(info.size>TEXT_LIMIT)fail('文本素材超过 8 MB，请拆分后导入','TEXT_TOO_LARGE');const bytes=await fs.readFile(file);if(bytes[0]===0xff&&bytes[1]===0xfe)return bytes.subarray(2).toString('utf16le');if(bytes[0]===0xfe&&bytes[1]===0xff)return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');return bytes.toString('utf8').replace(/^\uFEFF/,'');}
const isText=(type,file)=>['text','script','character'].includes(type)||/\.(txt|md|markdown)$/i.test(file||'');
async function references(service,node,canvas,workflow=node.workflow){
  const ports=(workflow?.mapping?.inputs||[]).filter(f=>f.source==='reference'),ordered=[...ports].sort((a,b)=>(a.index??ports.indexOf(a))-(b.index??ports.indexOf(b)));
  const result=[];
  for(const edge of canvas.state.edges.filter(e=>e.to===node.id)){
    const source=canvas.state.nodes.find(n=>n.id===edge.from);if(!source||source.type==='style'||edge.inputId==='$style')continue;
    const inputId=edge.inputId||((node.type==='custom'&&ports.length)?ordered[0].id:undefined);
    if(inputId&&!inputId.startsWith('$')&&!ports.some(p=>p.id===inputId))fail('连线目标输入端口已不存在：'+inputId,'INPUT_PORT_MISSING');
    if(inputId?.startsWith('$')&&inputId!=='$prompt')fail('不支持此控制输入端口','INPUT_PORT_MISSING');
    const binding=edge.outputId?source.outputBindings?.[edge.outputId]:null;
    let assetId=edge.outputId?(typeof binding==='string'?binding:binding?.assetId):source.assetId;
    if(edge.outputId&&!binding){const first=source.workflow?.mapping?.outputs?.[0];if(first?.id===edge.outputId)assetId=source.assetId;else fail('来源端口尚无实际生成结果：'+edge.outputId,'OUTPUT_PORT_EMPTY');}
    const asset=canvas.state.assets.find(a=>a.id===assetId);const file=assetId?await service.assetPath(assetId,canvas):null;
    const type=asset?.type||(source.type==='custom'?(source.workflow?.mapping?.outputs||[]).find(o=>o.id===edge.outputId)?.type:source.type);
    const port=ports.find(p=>p.id===inputId),textPort=port&&(port.mediaType==='text'||port.type==='text');
    const control=inputId==='$prompt'||(!port&&isText(type,file));
    if(control){if(inputId==='$prompt'&&!isText(type,file)&&typeof binding?.text!=='string')fail('提示文字端口只接受实际文字输出','REFERENCE_TYPE');const editable=!edge.outputId&&isText(source.type)&&source.content&&!['导入素材','处理结果'].includes(source.content);const text=editable?source.content:file&&isText(type,file)?await readText(file):binding?.text||source.content||source.prompt||'';result.push({type:'text',text,title:source.title,outputId:edge.outputId});}
    else if(file)result.push({id:assetId,path:file,type:asset?.type||type,title:source.title,inputId,outputId:edge.outputId,...(textPort?{text:await readText(file)}:{})});
    else if(source.content||binding?.text){if(port){if(!textPort)fail('端口需要已保存的媒体素材：'+inputId,'REFERENCE_MISSING');result.push({type:'text',text:binding?.text||source.content,title:source.title,inputId,outputId:edge.outputId});}else result.push({type:'text',text:source.content,title:source.title});}
    else if(port)fail('输入端口尚无实际素材：'+inputId,'REFERENCE_MISSING');
  }
  return result.sort((a,b)=>{const ai=ordered.findIndex(p=>p.id===a.inputId),bi=ordered.findIndex(p=>p.id===b.inputId);return (ai<0?1e6:ai)-(bi<0?1e6:bi);});
}
function validateReferences(snapshot){
  if(!snapshot.workflow)return;const ports=(snapshot.workflow.mapping?.inputs||[]).filter(p=>p.source==='reference'),refs=snapshot.references||[],used=new Set();
  for(const ref of refs)if(ref.inputId&&!ports.some(p=>p.id===ref.inputId))fail('参考素材的输入端口已不存在：'+ref.inputId,'INPUT_PORT_MISSING');
  for(const port of ports){const named=refs.filter(r=>r.inputId===port.id),legacy=refs.filter(r=>!r.inputId);const selected=named.length?named:port.multiple?legacy:refs[port.index||0]&&!refs[port.index||0].inputId?[refs[port.index||0]]:[];
    if(port.required&&!selected.length)fail('缺少必需输入端口：'+(port.label||port.id),'INPUT_REQUIRED');if(!port.multiple&&selected.length>1)fail('该端口只接受一个素材：'+port.id,'REFERENCE_COUNT');
    selected.forEach(ref=>used.add(ref));
    const type=port.mediaType||(['image','audio','video','text'].includes(port.type)?port.type:null);if(type&&selected.some(r=>r.type!==type))fail('输入端口素材类型不匹配：'+port.id,'REFERENCE_TYPE');
  }
  if(refs.some(ref=>!used.has(ref)))fail(ports.length?'部分素材没有对应工作流输入端口，请减少素材或选择支持这些输入的工作流。':'当前工作流不接收参考素材，请选择图生图等带素材输入的工作流。','REFERENCE_COUNT');
}
async function hydrateText(result){if(result.text?.length)return result;const texts=[];for(const out of result.outputs||[])if(isText(out.type,out.path))texts.push(await readText(out.path));return texts.length?{...result,text:texts.join('\n\n')}:result;}
module.exports={readText,isText,references,validateReferences,hydrateText};
