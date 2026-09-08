'use strict';
const crypto=require('node:crypto');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
function accountFingerprint(account){return crypto.createHash('sha256').update(JSON.stringify(stable(account??null))).digest('hex');}
module.exports={accountFingerprint};
