'use strict';
const fs=require('node:fs/promises');
const {ProviderError,endpoint,jsonFetch,post,saveText}=require('./util.cjs');
async function materializeTextResult(result,{outputDir}={}){
  if(!result?.pendingTextSave)return result;
  if(!['ollama','openai-compatible'].includes(result.provider)||typeof result.text!=='string'||!result.text)throw new ProviderError('待保存文字结果无效','TEXT_RESULT_INVALID');
  const output=await saveText(outputDir,result.text,result.provider),saved={...result,outputs:[output]};delete saved.pendingTextSave;delete saved.localSaveError;return saved;
}
async function completedText(provider,text,metadata,outputDir){
  const result={provider,state:'completed',text,outputs:[],metadata,pendingTextSave:true};
  try{return await materializeTextResult(result,{outputDir});}
  catch(error){return {...result,localSaveError:{code:error.code||'TEXT_SAVE_FAILED',message:error.message}};}
}
class LlmProvider{
  constructor(kind,config={},options={}){this.kind=kind;this.config=config;this.fetch=options.fetch || fetch;}
  get url(){return endpoint(this.config.url,this.kind==='ollama'?'http://127.0.0.1:11434':'https://api.openai.com/v1');}
  headers(){return this.config.apiKey?{Authorization:`Bearer ${this.config.apiKey}`}:{ };}
  async status(){if(this.kind!=='ollama'&&!this.config.url)return {ready:false,available:false,reason:'尚未配置 API 地址和模型',capabilities:['text']};try{const data=await jsonFetch(this.fetch,this.url+(this.kind==='ollama'?'/api/tags':'/models'),{headers:this.headers()},2500);const models=this.kind==='ollama'?(data.models || []).map(m=>({id:m.name})):(data.data || []);return {ready:!!this.config.model,available:true,url:this.url,models,capabilities:['text',...(this.config.vision?['image-input']:[])],reason:this.config.model?undefined:'请选择模型'};}catch(e){return {ready:false,available:false,reason:e.message};}}
  async run(snapshot,{outputDir,signal,onProgress=()=>{}}={}){if(snapshot.kind!=='text')throw new ProviderError('此连接仅支持文字输出','UNSUPPORTED_CAPABILITY');const model=snapshot.model || this.config.model;if(!model)throw new ProviderError('尚未选择语言模型','MODEL_REQUIRED');const refs=snapshot.references || [];if(refs.length&&!this.config.vision)throw new ProviderError('此模型尚未确认看图能力','VISION_UNCONFIRMED');if(refs.some(r=>r.type!=='image'))throw new ProviderError('请先将视频取帧或将音频转录','UNSUPPORTED_REFERENCE');onProgress({state:'running',message:'语言模型正在处理（未提供精确进度）'});let data;
    if(this.kind==='ollama'){const images=await Promise.all(refs.map(r=>fs.readFile(r.path).then(b=>b.toString('base64'))));data=await jsonFetch(this.fetch,this.url+'/api/chat',{...post({model,stream:false,messages:[...(snapshot.messages || []),{role:'user',content:snapshot.prompt,...(images.length?{images}:{})}],options:snapshot.parameters || {}}),signal},snapshot.timeoutMs || 600000);const text=data.message?.content;if(typeof text!=='string'||!text)throw new ProviderError('本地模型未返回文字','EMPTY_OUTPUT');return completedText(this.kind,text,{model,totalDuration:data.total_duration},outputDir);}
    const content=[{type:'text',text:snapshot.prompt}];for(const ref of refs){const bytes=await fs.readFile(ref.path);content.push({type:'image_url',image_url:{url:`data:${ref.mime || 'image/png'};base64,${bytes.toString('base64')}`}});}const request=post({model,stream:false,messages:[...(snapshot.messages || []),{role:'user',content:refs.length?content:snapshot.prompt}],...(snapshot.parameters?.temperature!=null?{temperature:snapshot.parameters.temperature}:{})});data=await jsonFetch(this.fetch,this.url+'/chat/completions',{...request,headers:{...request.headers,...this.headers()},signal},snapshot.timeoutMs || 600000);const text=data.choices?.[0]?.message?.content;if(typeof text!=='string'||!text)throw new ProviderError('API 未返回文字','EMPTY_OUTPUT');return completedText(this.kind,text,{model,usage:data.usage},outputDir);
  }
  async cancel(){return {state:'unsupported',message:'此接口只能取消本机等待，不能确认远端停止计费或计算'};}
  async reconcile(){return {state:'unsupported',message:'此同步语言接口不提供任务恢复查询；不会自动重发'};}
}
module.exports={LlmProvider,materializeTextResult};
