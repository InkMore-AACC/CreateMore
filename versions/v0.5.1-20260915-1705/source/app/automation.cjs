'use strict';
const http=require('node:http');
const {fs,path,crypto,id,atomicJSON,publicError,fail}=require('./core/util.cjs');
const METHODS=new Set(['app.status','canvas.get','canvas.update','canvas.save','canvas.list','canvas.open','canvas.create','task.list','task.submit','task.pause','task.resume','task.cancel','task.reconcile','task.remove','asset.import','history.list','resource.list','resource.get','skill.read','agent.tool','provider.status','diagnostics.list','media.submit']);
async function startAutomation(service,{dataDir,port=0}={}){
  const token=crypto.randomBytes(32).toString('base64url');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    const send=(code,data)=>{res.writeHead(code);res.end(JSON.stringify(data));};
    if(req.headers.origin)return send(403,{error:{message:'此接口不接受网页跨域调用'}});
    const auth=req.headers.authorization||'',expected='Bearer '+token;const a=Buffer.from(auth),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return send(401,{error:{message:'需要本机授权令牌'}});
    if(req.method!=='POST'||req.url!=='/rpc')return send(404,{error:{message:'未知端点'}});
    let size=0;const chunks=[];try{for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024)fail('请求超过 16 MB');chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!METHODS.has(input.method))return send(403,{error:{message:'自动化接口不允许此操作'}});const result=await service.call(input.method,input.args);send(200,{result});}catch(e){send(400,{error:publicError(e)});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address(),file=path.join(dataDir,'automation.json');await atomicJSON(file,{version:1,url:`http://127.0.0.1:${address.port}/rpc`,token,pid:process.pid,startedAt:new Date().toISOString()});
  return {server,file,url:`http://127.0.0.1:${address.port}/rpc`,async close(){await new Promise(resolve=>server.close(resolve));await fs.unlink(file).catch(()=>{});}};
}
module.exports={startAutomation,METHODS};
