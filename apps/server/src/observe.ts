import type { ExpectationResult } from '../../../packages/contracts/src/smoke.ts';

interface Rect { x: number; y: number; width: number; height: number; bottom: number; visible: boolean }
export interface Observation {
  runId: string;
  url: string;
  text: string;
  submissions: number;
  name: string;
  startDate: string;
  nameRect: Rect;
  dateRect: Rect;
}

export function parseObservation(content: { type: string; text?: string }[], runId: string, url: string): Observation {
  const text = content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  // Playwright MCP 0.0.83 的 evaluate 将 JSON 放在 Result 段。
  const section = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/)?.[1];
  if (!section) throw new Error('MCP 未返回可关联的页面观察数据');
  const data = JSON.parse(section) as Observation;
  if (data.runId !== runId || data.url !== url || typeof data.text !== 'string' || !Number.isInteger(data.submissions)) {
    throw new Error('观察数据不属于当前用例页面');
  }
  for (const rect of [data.nameRect, data.dateRect]) {
    if (!rect || typeof rect.visible !== 'boolean' || !['x', 'y', 'width', 'height', 'bottom'].every(key => Number.isFinite(rect[key as keyof Rect]))) {
      throw new Error('页面未返回有效的字段位置');
    }
  }
  return data;
}

export function assessObservation(data: Observation, evidenceIds: string[]): ExpectationResult[] {
  const submitted = data.text === '已提交：测试用户 / 2026-11-01' && data.submissions === 1 && data.name === '测试用户' && data.startDate === '2026-11-01';
  const positioned = data.nameRect.visible && data.dateRect.visible && data.dateRect.y >= data.nameRect.bottom;
  return [
    { expectationId: 'submitted-text', status: submitted ? 'PASSED' : 'FAILED', actual: JSON.stringify({ text: data.text, submissions: data.submissions, name: data.name, startDate: data.startDate }), evidenceIds },
    { expectationId: 'field-position', status: positioned ? 'PASSED' : 'FAILED', actual: JSON.stringify({ nameRect: data.nameRect, dateRect: data.dateRect }), evidenceIds },
  ];
}

export function assessVisual(code: string, expected: string, imageRequests: number, evidenceIds: string[]): ExpectationResult {
  const supported = imageRequests > 0 && code !== 'unavailable';
  return {
    expectationId: 'visual-code',
    status: supported && code === expected ? 'PASSED' : 'ERROR',
    actual: supported ? `图像中识别到 ${code}` : '未确认图像输入能力或模型无法读取图像',
    evidenceIds,
  };
}
