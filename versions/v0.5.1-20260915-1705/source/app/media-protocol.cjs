'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {Readable}=require('node:stream');
const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.avif':'image/avif','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.m4a':'audio/mp4','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'};
function rangeFor(header,size){
  if(!header)return null;const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());if(!match||(!match[1]&&!match[2])||size===0)return false;
  let start,end;if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return false;start=Math.max(0,size-suffix);end=size-1;}else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return false;end=Math.min(end,size-1);}return {start,end};
}
// Caller resolves an opaque, registered capability ID. This helper never accepts URLs or paths from the renderer.
async function fileResponse(file,request=new Request('http://localhost/')){
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
  const stat=await fsp.stat(file);if(!stat.isFile())return new Response(null,{status:404});const range=rangeFor(request.headers.get('range'),stat.size),headers={'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','Access-Control-Allow-Origin':'null','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(range===false)return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${stat.size}`,'Content-Length':'0'}});
  const start=range?.start??0,end=range?.end??stat.size-1;headers['Content-Length']=String(Math.max(0,end-start+1));if(range)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
  const body=request.method==='HEAD'||!stat.size?null:Readable.toWeb(fs.createReadStream(file,{start,end,signal:request.signal}));return new Response(body,{status:range?206:200,headers});
}
module.exports={fileResponse,rangeFor};
