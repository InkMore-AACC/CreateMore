/* Run in the dedicated native ComfyUI editor page, never in a user's dirty existing tab.
   Native app.graphToPrompt performs frontend/custom-node serialization. The host transports
   the returned GUI/API pair to WorkflowStore.save together with the mapping form. */
export async function createMoreNativeExport() {
  const { app } = await import('/scripts/app.js');
  if (!app.graph || typeof app.graphToPrompt !== 'function') throw new Error('当前原生 ComfyUI 前端尚未就绪');
  const converted = await app.graphToPrompt();
  if (!converted?.workflow?.nodes || !converted?.output) throw new Error('原生前端未返回完整普通工作流与 API 数据');
  return { gui: converted.workflow, api: converted.output, selectedNodeIds: Object.keys(app.canvas?.selected_nodes || {}) };
}
export async function createMoreNativeImport(gui) {
  const { app } = await import('/scripts/app.js');
  if (app.graph?._nodes?.length) throw new Error('编辑器已有内容，需由用户明确保存或丢弃后再导入');
  await app.loadGraphData(gui);
  return createMoreNativeExport();
}
