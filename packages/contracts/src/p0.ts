export const caseStatuses = ['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'ERROR', 'CANCELLED', 'INTERRUPTED'] as const;
export type CaseStatus = typeof caseStatuses[number];
export type RunStatus = 'QUEUED' | 'RUNNING' | 'PAUSING' | 'PAUSED' | 'STOPPING' | 'COMPLETED' | 'CANCELLED' | 'INTERRUPTED' | 'ERROR';
export type Field = 'externalId' | 'module' | 'title' | 'priority' | 'preconditions' | 'steps' | 'expectations';
export interface Source { fileName: string; sheet: string; rows: number[]; original: string[] }
export interface TestCase {
  id: string; externalId: string; module: string; title: string; priority: string;
  preconditions: string[]; steps: string[]; expectations: string[]; source: Source;
  excluded: boolean; duplicateAcknowledged: boolean; issuesResolved?: boolean;
}
export interface ImportIssue { caseId?: string; sheet: string; row?: number; message: string; blocking: boolean }
export interface SheetMapping { headerRow: number; columns: Partial<Record<Field, number>> }
// 用例集来源：excel = 工作簿导入；recording = 录制脚本转换。旧记录无此字段，读取时归一化为 excel。
export type ImportOrigin = 'excel' | 'recording';
export interface ImportDraft {
  id: string; fileName: string; revision: number; confirmedAt: string | null; createdAt: string;
  systemId: string; origin: ImportOrigin;
  sheets: { name: string; rows: number; selected: boolean; preview: string[][] }[];
  mappings: Record<string, SheetMapping>; cases: TestCase[]; issues: ImportIssue[];
}
export interface Environment {
  id: string; systemId: string; name: string; baseURL: string; loginURL: string; username: string;
  credentialRef: string; hasPassword: boolean; captchaStrategy: 'none' | 'image' | 'test-code' | 'manual';
  captchaCode: string; createdAt: string;
}
export interface System { id: string; name: string }
// 录制脚本：codegen 子进程产物。INTERRUPTED 表示录制未正常结束；脚本可能仍落盘，不伪造成功。
export type RecordingStatus = 'RECORDING' | 'COMPLETED' | 'INTERRUPTED' | 'ERROR';
export interface Recording {
  id: string; name: string; status: RecordingStatus; startURL: string;
  scriptAvailable: boolean; createdAt: string; endedAt: string | null; caseDraftId?: string;
}
// 思考档位与 Pi 的 ThinkingLevel 一致，运行时会原样传给会话。
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof thinkingLevels[number];
// 模型提供商：apiKey 只以 credentialRef 形式存在服务端，绝不下发页面。
export interface ModelProvider {
  id: string; name: string; baseURL: string; modelId: string;
  contextWindow: number; maxTokens: number;
  inputText: boolean; inputImage: boolean;
  reasoning: boolean; thinkingLevel: ThinkingLevel;
  api: 'openai-completions';
  credentialRef: string; hasApiKey: boolean; active: boolean; createdAt: string;
}
export type PublicModelProvider = Omit<ModelProvider, 'credentialRef'>;
export interface RunEvidence {
  id: string; runId: string; caseId: string; stepId: string; expectationId?: string;
  kind: 'tool' | 'observation' | 'position' | 'screenshot'; path: string; timestamp: string;
  success?: boolean;
}
export interface Assertion {
  expectationId: string; expected: string; actual: string; status: 'PASSED' | 'FAILED' | 'ERROR'; evidenceIds: string[];
}
export interface CaseResult {
  caseId: string; status: CaseStatus; phase: string; reason: string; assertions: Assertion[];
  steps: { id: string; text: string; status: string; evidenceIds: string[] }[];
  evidence: RunEvidence[]; startedAt: string | null; endedAt: string | null;
}
export interface RunEvent { seq: number; timestamp: string; type: string; caseId?: string; message: string }
export interface Run {
  id: string; importId: string; revision: number; environment: { id: string; name: string; baseURL: string; systemId: string };
  modelId: string; status: RunStatus; cases: TestCase[]; results: CaseResult[];
  events: RunEvent[]; reason: string; createdAt: string; endedAt: string | null;
}
export function metrics(results: Pick<CaseResult, 'status'>[]) {
  const counts = Object.fromEntries(caseStatuses.map(status => [status, results.filter(r => r.status === status).length])) as Record<CaseStatus, number>;
  const judged = counts.PASSED + counts.FAILED;
  const terminal = results.length - counts.PENDING - counts.RUNNING;
  const round = (n: number) => Math.round(n * 1000) / 10;
  return { total: results.length, counts, passRate: judged ? round(counts.PASSED / judged) : null, completionRate: results.length ? round(judged / results.length) : 0, progress: results.length ? round(terminal / results.length) : 0 };
}
