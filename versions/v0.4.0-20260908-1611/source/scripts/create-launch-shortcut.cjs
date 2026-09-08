'use strict';
const {app,shell}=require('electron'),path=require('node:path');
try{
  const root=path.resolve(__dirname,'..'),[exeArg,linkArg]=process.argv.slice(2),exe=path.resolve(exeArg),link=path.resolve(linkArg);
  if(!exe.startsWith(path.join(root,'dist')+path.sep)||path.dirname(link)!==root||path.extname(link)!=='.lnk')throw new Error('Shortcut targets must belong to this workspace release');
  if(!require('node:fs').existsSync(exe))throw new Error('Release executable missing');
  if(!shell.writeShortcutLink(link,'create',{target:exe,cwd:path.dirname(exe),icon:exe,iconIndex:0,description:'CreateMore - O.o'}))throw new Error('Windows shortcut could not be written');
  const saved=shell.readShortcutLink(link);if(saved.target!==exe||saved.icon!==exe||saved.iconIndex!==0)throw new Error('Shortcut target/icon verification failed');
  app.exit(0);
}catch(e){process.stderr.write(e.message+'\n');app.exit(1);}
