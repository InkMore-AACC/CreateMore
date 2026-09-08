'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function mergePreviousResources(previous,destination,baseline={}){
  const result={preserved:0,upgraded:[],newCatalogEntries:[]};
  async function visit(relative){
    const old=path.join(previous,relative),target=path.join(destination,relative),stat=await fs.lstat(old);
    if(stat.isSymbolicLink())throw Error('用户资源包含链接，请先检查');
    if(stat.isDirectory()){await fs.mkdir(target,{recursive:true});for(const name of await fs.readdir(old))if(name!=='.trash')await visit(path.join(relative,name));return;}
    const key=relative.split(path.sep).join('/'),bytes=await fs.readFile(old);
    if(key==='workflows/catalog.json'){
      const before=JSON.parse(bytes),incoming=JSON.parse(await fs.readFile(target,'utf8'));
      const additions=incoming.filter(entry=>!before.some(old=>old.id===entry.id));
      await fs.writeFile(target,JSON.stringify([...before,...additions],null,2));result.newCatalogEntries=additions.map(e=>e.id);return;
    }
    if(baseline[key]&&crypto.createHash('sha256').update(bytes).digest('hex')===baseline[key]){await fs.access(target);result.upgraded.push(key);return;}
    await fs.copyFile(old,target);result.preserved++;
  }
  for(const kind of ['skills','tools','workflows'])await visit(kind);
  return result;
}
module.exports={mergePreviousResources};
