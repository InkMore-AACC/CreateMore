'use strict';
// One public capability contract for private Codex and external MCP clients.
const tools=[
  {name:'canvas_read',description:'读取本轮绑定的画布、真实端口、来源与编辑权限；不读取其他软件。',inputSchema:{type:'object',properties:{}}},
  {name:'canvas_create',description:'创建自己的节点，不自动生成。source只能按用户明确要求选择，不自动改用付费来源。',inputSchema:{type:'object',properties:{type:{type:'string'},title:{type:'string'},content:{type:'string'},prompt:{type:'string'},source:{type:'string'},x:{type:'number'},y:{type:'number'}},required:['type']}},
  {name:'canvas_update',description:'更新自己的节点；可改文字、位置、来源、公开参数、比例、质量及图片份数，不能修改文件路径/凭据/所有者。仅按用户意图选择来源。',inputSchema:{type:'object',properties:{id:{type:'string'},patch:{type:'object'}},required:['id','patch']}},
  {name:'canvas_connect',description:'连接到自己的节点输入；多端口卡片按canvas_read返回的固定inputId/outputId连接。',inputSchema:{type:'object',properties:{from:{type:'string'},to:{type:'string'},inputId:{type:'string'},outputId:{type:'string'}},required:['from','to']}},
  {name:'canvas_generate',description:'按卡片已经明确选择的来源提交独立生成任务，不自动切换来源，不等待私人对话结束。',inputSchema:{type:'object',properties:{nodeId:{type:'string'}},required:['nodeId']}},
  {name:'canvas_tasks',description:'查看本轮绑定画布的真实任务状态，不把排队、未知或素材卡存在当成生成成功。',inputSchema:{type:'object',properties:{}}}
];
module.exports={tools};
