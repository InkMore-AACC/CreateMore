'use strict';
const readline=require('node:readline');const {request}=require('./cli.cjs');
const {tools}=require('./core/agent-tools.cjs');
async function dispatch(message){const {id,method,params={}}=message;if(id===undefined)return;let result;
  if(method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'createmore',version:'0.1.0'}};
  else if(method==='ping')result={};else if(method==='tools/list')result={tools};else if(method==='tools/call'){if(!tools.some(t=>t.name===params.name))throw new Error('未知工具');try{const output=await request('agent.tool',{name:params.name,arguments:params.arguments});result={content:[{type:'text',text:JSON.stringify(output)}]};}catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}}
  else return {jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}};return {jsonrpc:'2.0',id,result};}
if(require.main===module){const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});let tail=Promise.resolve();input.on('line',line=>{tail=tail.then(async()=>{let message;try{message=JSON.parse(line);const response=await dispatch(message);if(response)process.stdout.write(JSON.stringify(response)+'\n');}catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32603,message:e.message}})+'\n');}});});}
module.exports={dispatch,tools};
