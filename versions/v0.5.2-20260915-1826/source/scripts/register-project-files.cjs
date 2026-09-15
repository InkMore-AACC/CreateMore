'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
async function main(){
  if(!process.argv.includes('--apply'))throw new Error('Explicit --apply is required to change current-user file association');
  const root=path.resolve(__dirname,'..'),release=JSON.parse(await fs.readFile(path.join(root,'dist/latest-build.json'),'utf8')).releases[0];
  if(!path.resolve(release.directory).startsWith(path.join(root,'dist')+path.sep))throw new Error('Release outside workspace');
  const result=await require('../app/file-association.cjs').register({exe:release.exe,icon:path.join(release.directory,'resources/app/app/ui/assets/brand/oo-project.ico')});
  await fs.writeFile(path.join(root,'testing-output/project-file-association.json'),JSON.stringify({...result,at:new Date().toISOString()},null,2));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
main().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
