'use strict';

// Flush the renderer's last keystroke before inspecting service-side dirty state.
// A failed flush/save must never authorize closing the only unsaved copy.
async function prepareExit({flush,dirty,active,confirm,save}){
  await flush();
  const sessions=dirty(),tasks=active();
  if((sessions.length||tasks.length)&&!await confirm({sessions,tasks}))return false;
  for(const session of sessions)await save(session);
  return true;
}
module.exports={prepareExit};
