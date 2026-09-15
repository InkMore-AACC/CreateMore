'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {ComfyProvider}=require('./comfyui.cjs');
const {CodexProvider}=require('./codex.cjs');
const {LlmProvider}=require('./http.cjs');
const {RunningHubProvider}=require('./runninghub.cjs');
const {WorkflowStore}=require('./workflows.cjs');
const {ProviderError,redact,writeAtomic}=require('./util.cjs');
const {freezeSkills}=require('./codex-policy.cjs');
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));return value;}
function comfyIdentity(config={}){const safe={...config,url:new ComfyProvider(config).url};for(const key of ['frozen','apiKey','encryptedApiKey','credentialRef','hasApiKey'])delete safe[key];return crypto.createHash('sha256').update(JSON.stringify(canonical(safe))).digest('hex');}
class ProviderHub{
  constructor(options={}){this.options=options;this.appDir=options.appDir || process.cwd();this.dataDir=options.dataDir || path.join(this.appDir,'data');this.config=options.config || {};this.file=path.join(this.dataDir,'providers.json');this.credentialFile=path.join(this.dataDir,'provider-credentials.json');this.credentials={};this.credentialMemory=new Map();this.comfyInstances=new Map();this.providers={};this.ready=this.load();this.defaultWorkflows=new WorkflowStore(path.join(this.appDir,'resources','workflows','defaults'));this.customWorkflows=new WorkflowStore(path.join(this.appDir,'resources','workflows','custom'));}
  async load(){try{const config=JSON.parse(await fs.readFile(this.file,'utf8'));for(const item of Object.values(config)){if(item?.encryptedApiKey&&this.options.decryptSecret)item.apiKey=await this.options.decryptSecret(item.encryptedApiKey);delete item.encryptedApiKey;}this.config={...config,...this.config};}catch(e){if(e.code!=='ENOENT')this.loadError=e.message;}try{this.credentials=JSON.parse(await fs.readFile(this.credentialFile,'utf8'));}catch(e){if(e.code!=='ENOENT')this.loadError=e.message;}this.build();}
  comfyFor(config={}){const key=comfyIdentity(config);if(!this.comfyInstances.has(key))this.comfyInstances.set(key,new ComfyProvider(structuredClone(config),this.options));return this.comfyInstances.get(key);}
  build(){this.providers.comfyui=this.comfyFor(this.config.comfyui);this.providers.codex=new CodexProvider(this.config.codex,this.options);this.providers.image2=this.providers.codex;for(const kind of ['ollama','openai-compatible'])this.providers[kind]=new LlmProvider(kind,this.config[kind],this.options);this.providers.runninghub=new RunningHubProvider(this.config.runninghub,this.options);}
  async configure(config){await this.ready;for(const [key,value]of Object.entries(config)){this.config[key]={...this.config[key],...value};if(key==='comfyui')this.providers.comfyui=this.comfyFor(this.config[key]);else if(this.providers[key])this.providers[key].config=this.config[key];}const saved=structuredClone(this.config);for(const item of Object.values(saved)){if(item?.apiKey){if(this.options.encryptSecret)item.encryptedApiKey=await this.options.encryptSecret(item.apiKey);delete item.apiKey;}}await writeAtomic(this.file,JSON.stringify(saved,null,2));return this.publicConfig();}
  publicConfig(){return Object.fromEntries(Object.entries(this.config).map(([id,c])=>{const out={...c,hasApiKey:!!c.apiKey};delete out.apiKey;delete out.encryptedApiKey;return [id,out];}));}
  async status(){await this.ready;const results=await Promise.all(Object.entries(this.providers).filter(([id])=>id!=='image2').map(async([id,p])=>[id,await p.status()]));const out=Object.fromEntries(results);const owners=[...this.comfyInstances.entries()].filter(([,p])=>p.owned).map(([id,p])=>({id,url:p.url,pid:p.owned.pid}));out.comfyui.owned=owners.some(p=>p.url===out.comfyui.url);out.comfyui.ownedInstances=owners;out.image2={ready:!!out.codex?.ready&&out.codex.capabilities?.includes('image'),available:!!out.codex?.available,capabilities:['image'],reason:!out.codex?.ready?out.codex?.reason:!out.codex.capabilities?.includes('image')?'当前 Codex 未确认内置图像能力':undefined};return out;}
  async prepare(snapshot){
    await this.ready;const out=structuredClone(snapshot);const key=out.provider==='image2'?'codex':out.provider;
    if(!this.providers[key])throw new ProviderError(`尚未实现或配置此来源：${key}`,'PROVIDER_UNAVAILABLE');if(out.connection?.frozen)return out;
    const connection=structuredClone({...this.config[key],...out.connection});
    if(out.skills)out.skills=await freezeSkills(out.skills);
    if(connection.apiKey){const id=crypto.createHash('sha256').update(key+'\0'+connection.apiKey).digest('hex');this.credentialMemory.set(id,connection.apiKey);if(!this.credentials[id]&&this.options.encryptSecret){this.credentials[id]={provider:key,encrypted:await this.options.encryptSecret(connection.apiKey)};await writeAtomic(this.credentialFile,JSON.stringify(this.credentials,null,2));}connection.credentialRef=id;}
    delete connection.apiKey;delete connection.encryptedApiKey;delete connection.hasApiKey;if(key!=='codex')connection.url ||= this.providers[key].url;
    if(key==='codex'){
      out.model ||= connection.model;out.effort ||= connection.effort;
      if(!out.model){const provider=this.providers.codex;if(!provider.models?.length)await provider.status();const selected=provider.models?.find(m=>m.isDefault);if(!selected)throw new ProviderError('未能确定本机 Codex 的默认模型，请连接后选择模型','MODEL_REQUIRED');out.model=selected.model || selected.id;if(!out.effort)out.effort=selected.defaultReasoningEffort;}
      connection.model=out.model;if(out.effort)connection.effort=out.effort;
    }else out.model ||= connection.model;
    connection.frozen=true;out.connection=connection;return out;
  }
  async providerFor(id,connection){await this.ready;const current=this.providers[id];if(!current)throw new ProviderError(`尚未实现或配置此来源：${id}`,'PROVIDER_UNAVAILABLE');if(['codex','image2'].includes(id))return current;const config=structuredClone(connection?.frozen?connection:{...this.config[id],...connection});if(config.credentialRef){let key=this.credentialMemory.get(config.credentialRef);if(!key){const item=this.credentials[config.credentialRef];if(item?.provider===id&&this.options.decryptSecret)key=await this.options.decryptSecret(item.encrypted);}if(!key)throw new ProviderError('原任务使用的机器凭据不可恢复；不能改用新密钥静默重交','CREDENTIAL_UNAVAILABLE');config.apiKey=key;}return id==='comfyui'?this.comfyFor(config):id==='runninghub'?new RunningHubProvider(config,this.options):new LlmProvider(id,config,this.options);}
  async run(snapshot,options={}){const fixed=await this.prepare(snapshot),provider=await this.providerFor(fixed.provider,fixed.connection);if(fixed.provider==='comfyui'){try{provider.preflight(fixed,options);}catch(error){error.beforeSubmission=true;error.uncertain=false;throw error;}return require('./comfy-lane.cjs').inComfyLane(provider,()=>provider.run(fixed,options),options);}return provider.run(fixed,options);}
  async cancel(remote){return (await this.providerFor(remote.provider,remote.connection)).cancel(remote);}
  async reconcile(snapshot,remote,options){return (await this.providerFor(snapshot.provider || remote.provider,snapshot.connection || remote.connection)).reconcile(snapshot,remote,options);}
  async stopComfyOwned({url,instanceId}={}){await this.ready;const targetUrl=url?new ComfyProvider({url}).url:this.providers.comfyui.url;const selected=[...this.comfyInstances.entries()].filter(([id,p])=>p.owned&&(instanceId?id===instanceId:p.url===targetUrl));if(!selected.length)return {stopped:false,reason:'此服务不是由本次 CreateMore 启动，未关闭其他进程'};const results=[];for(const [id,p]of selected)results.push({id,url:p.url,...await p.stopOwned()});return {stopped:results.every(r=>r.stopped),results};}
  async close(){await this.ready;this.providers.codex.close();}
}
module.exports={ProviderHub,ComfyProvider,CodexProvider,LlmProvider,RunningHubProvider,WorkflowStore,ProviderError,redact};
