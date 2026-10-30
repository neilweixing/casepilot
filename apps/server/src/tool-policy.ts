import { observeFunction } from './fixture.ts';
import { browserTools, mcpTool } from './mcp.ts';

export const allowedNames = [...browserTools.map(mcpTool), 'casepilot_observe', 'casepilot_record_visual', 'casepilot_finish'];
export interface ToolPolicyState {
  completedSteps: Set<string>;
  navigateIssued: boolean;
  submitIssued: boolean;
  toolCalls: number;
  finished: boolean;
}

// 返回原因表示拦截；在发出提交前记录已尝试，结果不明时也不得再次提交。
export function checkToolCall(name: string, input: Record<string, unknown>, parentId: string | undefined, state: ToolPolicyState, fixtureURL: string, aborted: boolean, maxCalls: number): string | undefined {
  state.toolCalls++;
  if (aborted || state.finished || state.toolCalls > maxCalls) return '运行已终止、已完成或工具调用预算耗尽';
  if (!allowedNames.includes(name)) return '工具不在 M1 白名单内';
  if (name === mcpTool('browser_snapshot') && Object.keys(input).length) return '页面快照不接受文件路径或其他参数';
  if (name === mcpTool('browser_evaluate') && (!parentId || input.function !== observeFunction || Object.keys(input).some(key => key !== 'function'))) return '只允许内置的固定只读页面观察';
  if (name === mcpTool('browser_take_screenshot') && (!parentId || Object.keys(input).some(key => !['type', 'fullPage', 'scale'].includes(key)) || input.type !== 'png' || input.fullPage !== false || input.scale !== 'css')) return '截图仅由证据工具采集，不接受自定义文件路径';
  if (name === mcpTool('browser_navigate')) {
    if (state.navigateIssued || input.url !== fixtureURL) return '只能打开本次用例指定页面一次';
    state.navigateIssued = true;
  }
  if (name === mcpTool('browser_fill_form')) {
    const fields = input.fields;
    if (!state.completedSteps.has('open') || state.submitIssued || !Array.isArray(fields) || fields.length !== 2 || !fields.every(f => f && f.type === 'textbox') || !fields.some(f => f.value === '测试用户') || !fields.some(f => f.value === '2026-11-01')) return '请按固定用例填写两个字段，提交后不得重填';
  }
  if (name === mcpTool('browser_click')) {
    if (!state.completedSteps.has('fill') || state.submitIssued || input.doubleClick === true || (input.button && input.button !== 'left') || (Array.isArray(input.modifiers) && input.modifiers.length)) return '只允许填写后提交一次，不自动重试提交';
    state.submitIssued = true;
  }
}
