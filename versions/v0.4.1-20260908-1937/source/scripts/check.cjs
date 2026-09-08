'use strict';
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):/\.(c?js)$/.test(e.name)?[path.join(dir,e.name)]:[]);}
let failures=0;for(const file of [...walk('app'),...walk('scripts')]){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});if(r.status){process.stderr.write(file+'\n'+r.stderr);failures++;}}process.stdout.write(failures?'语法检查失败：'+failures+'\n':'全部产品脚本语法检查通过\n');process.exitCode=failures?1:0;
