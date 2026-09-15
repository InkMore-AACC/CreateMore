'use strict';
function pickScalars(value,keys){return Object.fromEntries(keys.filter(k=>['string','number','boolean'].includes(typeof value?.[k])).map(k=>[k,value[k]]));}
function errorSummary(value){if(!value)return undefined;return {reported:true,...(value&&typeof value==='object'&&/^[A-Z0-9_]{1,80}$/.test(value.code||'')?{code:value.code}:{})};}
function report({tasks=[],logs=[],providers={}}={}){
  return {version:'0.1.0',createdAt:new Date().toISOString(),privacy:'不附任务输入、素材路径、对话、模型配置或详细错误文本；详细诊断仅保留在本机。',
    tasks:tasks.map(t=>({...pickScalars(t,['id','state','provider','createdAt','updatedAt','progress','partial','removed','resultPending']),error:errorSummary(t.error),events:(t.events||[]).map(e=>pickScalars(e,['at','state']))})),
    logs:logs.map(l=>({...pickScalars(l,['id','at','level']),error:errorSummary(l.error)})),
    providers:Object.fromEntries(Object.entries(providers).filter(([name])=>/^[a-z0-9-]{1,40}$/i.test(name)).map(([name,p])=>[name,pickScalars(p,['ready','available','running','pending','owned'])]))};
}
module.exports={report};
