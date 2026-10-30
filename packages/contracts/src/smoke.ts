export type ExpectationId = 'submitted-text' | 'field-position' | 'visual-code';
export type Verdict = 'PASSED' | 'FAILED' | 'ERROR';

export interface Evidence {
  id: string;
  runId: string;
  caseId: string;
  stepId?: string;
  expectationId?: ExpectationId;
  kind: 'tool' | 'observation' | 'screenshot' | 'visual';
  path: string;
  timestamp: string;
}

export interface ExpectationResult {
  expectationId: ExpectationId;
  status: Verdict;
  actual: string;
  evidenceIds: string[];
}

export interface SmokeResult {
  runId: string;
  caseId: string;
  status: Verdict | 'CANCELLED';
  expectations: ExpectationResult[];
  evidence: Evidence[];
  errors: string[];
}

export const smokeCase = {
  id: 'M1-FORM-001',
  revision: 1,
  title: '填写并提交表单，验证文本、字段位置及图像',
  steps: [
    { id: 'open', text: '打开指定的可控表单页' },
    { id: 'fill', text: '姓名填写“测试用户”，预计启动日期填写“2026-11-01”' },
    { id: 'submit', text: '点击一次“提交”' },
  ],
  expectations: [
    { id: 'submitted-text', text: '显示“已提交：测试用户 / 2026-11-01”，且只提交一次' },
    { id: 'field-position', text: '预计启动日期输入框完整位于姓名输入框下方，两者均可见' },
    { id: 'visual-code', text: '读取截图中的四位视觉校验码' },
  ],
} as const;
