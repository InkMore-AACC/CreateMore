'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const clone = x => structuredClone(x);
const id = prefix => `${prefix || 'id'}-${crypto.randomUUID()}`;
function fail(message, code = 'INVALID_REQUEST') { const e = new Error(message); e.code = code; throw e; }
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /api.?key|token|password|secret|authorization|cookie|credential/i.test(k) ? '[已脱敏]' : redact(v)]));
  return typeof value === 'string' ? value.replace(/(Bearer\s+)[\w.\-]+/gi,'$1[已脱敏]').replace(/\bsk-[\w-]{12,}/g,'[已脱敏]').replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;&]+/gi,'$1[已脱敏]') : value;
}
async function readJSON(file, fallback) { try { return JSON.parse(await fs.readFile(file,'utf8')); } catch(e) { if(e.code === 'ENOENT' && arguments.length>1) return clone(fallback); throw e; } }
async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${crypto.randomUUID()}.tmp`;
  const handle=await fs.open(temp,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(value,null,2),'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temp,file); } catch(e) { await fs.unlink(temp).catch(()=>{}); throw e; }
}
function serial() { let tail=Promise.resolve(); return fn => { const p=tail.then(fn,fn); tail=p.catch(()=>{}); return p; }; }
function publicError(e) { return {message:redact(e.message||String(e)),code:e.code||'INTERNAL_ERROR'}; }
module.exports={fs,path,crypto,clone,id,fail,redact,readJSON,atomicJSON,serial,publicError};
