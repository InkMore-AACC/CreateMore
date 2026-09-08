'use strict';
const {fs,path,redact,serial}=require('./util.cjs');
class Diagnostics {
  constructor({dataDir,days=30,maxBytes=1024**3}){this.root=path.join(dataDir,'logs');this.critical=path.join(dataDir,'critical-errors.jsonl');this.days=days;this.maxBytes=maxBytes;this.write=serial();}
  async init(){await fs.mkdir(this.root,{recursive:true});await this.rotate();return this;}
  async append(record){return this.write(async()=>{const clean=redact(record),filename=path.join(this.root,new Date(record.at||Date.now()).toISOString().slice(0,10)+'.jsonl');await fs.appendFile(filename,JSON.stringify(clean)+'\n');if(record.level==='error')await fs.appendFile(this.critical,JSON.stringify(clean)+'\n');await this.rotate();});}
  async files(){const entries=await fs.readdir(this.root,{withFileTypes:true});const files=[];for(const entry of entries){if(!entry.isFile()||!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))continue;const file=path.join(this.root,entry.name),stat=await fs.lstat(file);if(!stat.isSymbolicLink())files.push({path:file,name:entry.name,size:stat.size,date:Date.parse(entry.name.slice(0,10)+'T00:00:00Z')});}return files.sort((a,b)=>a.date-b.date);}
  async rotate(){const files=await this.files();let bytes=files.reduce((n,f)=>n+f.size,0);const removed=[];for(const file of files){if(file.date<Date.now()-this.days*86400000||bytes>this.maxBytes){await fs.unlink(file.path);bytes-=file.size;removed.push(file.name);}}return {removed,bytes};}
  async tail(filename,limit=1000){let handle;try{handle=await fs.open(filename,'r');const stat=await handle.stat(),size=Math.min(stat.size,2*1024*1024),buffer=Buffer.alloc(size);await handle.read(buffer,0,size,stat.size-size);return buffer.toString('utf8').split('\n').slice(-limit-1).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);}catch(e){if(e.code==='ENOENT')return [];throw e;}finally{await handle?.close();}}
  async list(){const files=(await this.files()).reverse(),logs=[];for(const file of files){logs.unshift(...await this.tail(file.path));if(logs.length>=2000)break;}return logs.slice(-2000);}
}
module.exports={Diagnostics};
