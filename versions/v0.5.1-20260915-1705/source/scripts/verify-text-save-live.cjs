'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {ProviderHub}=require('../app/providers/index.js');

const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function verifyServerFiles(report,item){
  const files=Object.values(item.outputs||{}).flatMap(output=>output.files||[]);assert.ok(files.length,'History must expose the TXT saved by ComfyUI');report.remoteDownloads=[];
  for(const [index,file]of files.entries()){
    assert.equal(path.extname(file.filename),'.txt');const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder||'',type:file.type||'output'});
    const response=await fetch(report.url+'/view?'+query,{signal:AbortSignal.timeout(5000)});assert.equal(response.ok,true);const bytes=Buffer.from(await response.arrayBuffer()),text=bytes.toString('utf8');assert.equal(text.replace(/\r\n/g,'\n'),report.expectedText);
    const saved=path.join(report.base,'server-text-'+index+'.txt');try{await fs.writeFile(saved,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;assert.equal(digest(await fs.readFile(saved)),digest(bytes));}
    report.remoteDownloads.push({remote:file,path:saved,bytes:bytes.length,sha256:digest(bytes),contentMatches:true,byteIdenticalToProviderOutput:digest(bytes)===report.expectedSha256,lineEndings:text.includes('\r\n')?'CRLF':'LF',normalizedSha256:digest(Buffer.from(text.replace(/\r\n/g,'\n')))});
  }
}
async function verifyExisting(file){
  const testingDir=path.resolve(__dirname,'..','testing-output'),target=path.resolve(file),base=path.dirname(target);assert.equal(path.dirname(base),testingDir);assert.ok(path.basename(base).startsWith('text-save-live-'));assert.equal(path.basename(target),'report.json');
  const report=JSON.parse(await fs.readFile(target,'utf8'));assert.equal(report.base,base);assert.equal(report.url,'http://127.0.0.1:8188');assert.equal(report.kind,'actual-comfy-text-save-without-model-inference');
  try{const response=await fetch(report.url+'/history/'+encodeURIComponent(report.remoteId),{signal:AbortSignal.timeout(5000)});assert.equal(response.ok,true);const history=await response.json();await verifyServerFiles(report,history[report.remoteId]);report.remoteDownloadVerifiedAt=new Date().toISOString();report.ok=report.history.promptMatches&&report.originalWorkflowUnchanged&&report.outputs.every(output=>output.contentMatches);if(report.error){report.previousVerificationError=report.error;delete report.error;}report.verificationNote='ComfyUI 在 Windows 上写入 CRLF；ProviderHub 将 history.text 原文保存为 LF。中文逐字相同，分别记录原始字节哈希，规范化换行后哈希相同。';}catch(error){report.ok=false;report.error={code:error.code||'VERIFY_FAILED',message:error.message};process.exitCode=1;}
  await fs.writeFile(target,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
async function main(){
  const appDir=path.resolve(__dirname,'..'),testingDir=path.join(appDir,'testing-output');
  await fs.mkdir(testingDir,{recursive:true});const base=await fs.mkdtemp(path.join(testingDir,'text-save-live-'));
  const report={kind:'actual-comfy-text-save-without-model-inference',startedAt:new Date().toISOString(),base,workflowId:'tool-text-save',url:'http://127.0.0.1:8188',events:[],ok:false};
  const hub=new ProviderHub({appDir,dataDir:path.join(base,'isolated-config'),config:{comfyui:{url:report.url}}});
  try{
    await hub.ready;const status=await hub.providers.comfyui.status();report.service={ready:status.ready,owned:status.owned,running:status.running,pending:status.pending};assert.equal(status.ready,true,status.reason);
    const folder=path.join(appDir,'resources','workflows','defaults',report.workflowId),current=JSON.parse(await fs.readFile(path.join(folder,'current.json'),'utf8'));report.workflowVersion=current.version;
    const files=['current.json',...['workflow.json','workflow.api.json','mapping.json'].map(name=>path.join('versions',current.version,name))];
    const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,digest(await fs.readFile(path.join(folder,file)))])));report.workflowHashesBefore=await hashes();
    const workflow=await hub.defaultWorkflows.read(report.workflowId,current.version);const nodeTypes=Object.values(workflow.api).map(node=>node.class_type).sort();assert.deepEqual(nodeTypes,['PrimitiveStringMultiline','SaveText']);report.nodeTypes=nodeTypes;
    const prompt='CreateMore 本地文字保存验收。\n这是未经语言模型改写的中文原文：青绿色陶杯、温灰背景与柔和侧光。\n唯一验收标识：'+path.basename(base);
    report.expectedText=prompt;report.expectedSha256=digest(Buffer.from(prompt));
    const snapshot=await hub.prepare({provider:'comfyui',kind:'text',workflowId:'default:tool-text-save',workflow,prompt,references:[],parameters:{},timeoutMs:60000});
    const outputDir=path.join(base,'outputs');const result=await hub.run(snapshot,{outputDir,signal:AbortSignal.timeout(60000),onProgress:event=>{report.events.push({state:event.state,remoteId:event.remoteId,message:event.message});if(event.remoteId)report.remoteId=event.remoteId;}});
    report.result=result;report.remoteId=result.remoteId;assert.equal(result.state,'completed');assert.ok(result.outputs?.length);
    report.outputs=[];for(const output of result.outputs){assert.equal(path.dirname(path.resolve(output.path)),outputDir);const bytes=await fs.readFile(output.path);const content=bytes.toString('utf8');assert.equal(content,prompt);report.outputs.push({path:output.path,bytes:bytes.length,sha256:digest(bytes),contentMatches:true});}
    const response=await fetch(report.url+'/history/'+encodeURIComponent(result.remoteId),{signal:AbortSignal.timeout(5000)});assert.equal(response.ok,true);const history=await response.json();const item=history[result.remoteId];assert.ok(item);assert.equal(item.status?.completed,true);assert.equal(item.status?.status_str,'success');assert.deepEqual(Object.values(item.prompt[2]).map(node=>node.class_type).sort(),nodeTypes);assert.ok(Object.values(item.prompt[2]).some(node=>node.class_type==='PrimitiveStringMultiline'&&node.inputs.value===prompt));
    const historyFile=path.join(base,'comfy-history.json');await fs.writeFile(historyFile,JSON.stringify(history,null,2),{flag:'wx'});report.history={path:historyFile,remoteId:result.remoteId,status:item.status,outputs:item.outputs,promptMatches:true};
    await verifyServerFiles(report,item);
    report.workflowHashesAfter=await hashes();assert.deepEqual(report.workflowHashesAfter,report.workflowHashesBefore);report.originalWorkflowUnchanged=true;report.ok=true;
  }catch(error){report.error={code:error.code||'VERIFY_FAILED',message:error.message,uncertain:!!error.uncertain,remoteId:error.remoteId||report.remoteId};process.exitCode=1;}
  finally{await hub.close();report.completedAt=new Date().toISOString();report.reportPath=path.join(base,'report.json');await fs.writeFile(report.reportPath,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));}
}
(process.argv[2]==='--verify-existing'?verifyExisting(process.argv[3]):main()).catch(error=>{console.error(error.message);process.exitCode=1;});
