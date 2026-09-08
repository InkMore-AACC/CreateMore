'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {promisify}=require('node:util');
const execFile=promisify(require('node:child_process').execFile);
const progId='CreateMore.Project.2',base='HKCU\\Software\\Classes';
function entries(exe,icon){
  if(!path.win32.isAbsolute(exe)||!path.win32.isAbsolute(icon)||/["\r\n]/.test(exe+icon))throw new Error('软件或图标路径无效');
  return [
    [base+'\\'+progId,'','CreateMore 工程'],
    [base+'\\'+progId+'\\DefaultIcon','',`"${icon}",0`],
    [base+'\\'+progId+'\\shell\\open\\command','',`"${exe}" "%1"`],
    [base+'\\.createmore\\OpenWithProgids',progId,''],
    [base+'\\Applications\\CreateMore.exe\\DefaultIcon','',`"${icon}",0`],
    [base+'\\Applications\\CreateMore.exe\\shell\\open\\command','',`"${exe}" "%1"`],
    [base+'\\Applications\\CreateMore.exe\\SupportedTypes','.createmore',''],
  ];
}
async function register({exe,icon}){
  if(process.platform!=='win32')throw new Error('文件关联仅支持 Windows');
  await fs.access(exe);await fs.access(icon);
  const reg=path.join(process.env.SystemRoot||'C:\\Windows','System32','reg.exe');
  const run=args=>execFile(reg,args,{windowsHide:true,encoding:'utf8'});
  let existing='';
  try{existing=(await run(['query',base+'\\.createmore','/ve'])).stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim()||'';}catch(e){if(e.code!==1)throw e;}
  for(const [key,name,value] of entries(exe,icon))await run(['add',key,...(name?['/v',name]:['/ve']),'/t','REG_SZ','/d',value,'/f']);
  // Never overwrite another application's extension association or Windows UserChoice.
  if(!existing||existing===progId)await run(['add',base+'\\.createmore','/ve','/t','REG_SZ','/d',progId,'/f']);
  const command=(await run(['query',base+'\\'+progId+'\\shell\\open\\command','/ve'])).stdout;
  if(!command.includes(`"${exe}" "%1"`))throw new Error('文件关联回读失败');
  await execFile(path.join(process.env.SystemRoot||'C:\\Windows','System32','ie4uinit.exe'),['-show'],{windowsHide:true}).catch(()=>{});
  return {registered:true,extension:'.createmore',progId,exe,defaultPreserved:!!existing&&existing!==progId};
}
module.exports={entries,register};
