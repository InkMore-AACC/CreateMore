'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const {ProviderError}=require('./util.cjs');
// Process-local policy. Never writes ~/.codex/config.toml or changes the desktop session.
const disabledFeatures=['shell_tool','unified_exec','shell_snapshot','apps','plugins','remote_plugin','browser_use','browser_use_external','computer_use','in_app_browser','memories','multi_agent','multi_agent_v2','goals','hooks','workspace_dependencies','skill_search','skill_mcp_dependency_install','tool_suggest','view_image'];
function restrictedConfig(){return Object.fromEntries([
  ...disabledFeatures.map(id=>['features.'+id,false]),
  ['features.code_mode_host',true],['features.skip_host_skill_discovery',true],['skills.bundled.enabled',false],['skills.include_instructions',false],['agents.enabled',false],
  ['project_doc_max_bytes',0],['web_search','disabled'],['mcp_servers',{}],['tools.update_plan.enabled',false]
]);}
function restrictedLaunchArgs(){return Object.entries(restrictedConfig()).flatMap(([key,value])=>['-c',key+'='+JSON.stringify(value)]);}
async function freezeSkills(skills=[]){const selected=[];for(const skill of skills){if(skill.enabled===false)continue;let content=skill.content;if(typeof content!=='string'){if(!skill.path)throw new ProviderError('已选Skill缺少内容或路径','SKILL_INPUT_REQUIRED');const actual=await fs.realpath(skill.path);if(path.basename(actual).toLowerCase()!=='skill.md')throw new ProviderError('Skill路径必须指向明确选择的SKILL.md','SKILL_PATH_INVALID');content=await fs.readFile(actual,'utf8');}if(!content.trim())throw new ProviderError('已选Skill内容为空','SKILL_INPUT_REQUIRED');selected.push({...skill,enabled:true,content,contentHash:crypto.createHash('sha256').update(content).digest('hex')});}return selected;}
module.exports={disabledFeatures,restrictedConfig,restrictedLaunchArgs,freezeSkills};
