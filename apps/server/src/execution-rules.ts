import type { CaseResult, Run, RunEvidence, TestCase } from '../../../packages/contracts/src/p0.ts';

export function secretRedactor(secrets: string[]) {
  const tokens = [...new Set(secrets.filter(Boolean).flatMap(s => [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)]))].sort((a, b) => b.length - a.length);
  return (text: string) => tokens.reduce((value, token) => {
    if (token.length >= 3) return value.split(token).join('[REDACTED]');
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), '[REDACTED]');
  }, text).replace(/(Bearer\s+)[\w.+/-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|token|session|api_key|password|code)=)[^&#\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
}

export function scrubValue<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === 'string') return clean(value) as T;
  if (Array.isArray(value)) return value.map(item => scrubValue(item, clean)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:authorization|proxy-authorization|cookie|set-cookie|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key|password|secret)$/i.test(key) ? '[REDACTED]' : scrubValue(item, clean)])) as T;
  return value;
}

export function publicRunData(run: Run, secrets: string[]) {
  const copy = scrubValue(run, secretRedactor(secrets));
  // 仅正文脱敏，服务生成的标识和文件引用保持关联，避免短用户名碰巧出现在 UUID 中。
  copy.id = run.id; copy.importId = run.importId; copy.environment.id = run.environment.id; copy.environment.systemId = run.environment.systemId;
  copy.cases.forEach((c, i) => { c.id = run.cases[i]!.id; });
  copy.results.forEach((r, i) => {
    const original = run.results[i]!; r.caseId = original.caseId;
    r.steps.forEach((s, j) => { s.id = original.steps[j]!.id; s.evidenceIds = [...original.steps[j]!.evidenceIds]; });
    r.assertions.forEach((a, j) => { a.expectationId = original.assertions[j]!.expectationId; a.evidenceIds = [...original.assertions[j]!.evidenceIds]; });
    r.evidence.forEach((e, j) => { const source = original.evidence[j]!; Object.assign(e, { id: source.id, runId: source.runId, caseId: source.caseId, stepId: source.stepId, path: source.path }); if (source.expectationId) e.expectationId = source.expectationId; });
  });
  copy.events.forEach((e, i) => { if (run.events[i]!.caseId) e.caseId = run.events[i]!.caseId; });
  return copy;
}

export function requiredActions(step: string) {
  if (/^(检查|验证|确认|观察|查看|确保)/.test(step.trim()) && !/(然后|再|并|随后|之后|后)[^。]*?(点击|填写|输入|录入|选择|按下)/.test(step)) return [];
  const actions: string[] = [];
  if (/点击|单击|双击|勾选|取消勾选/.test(step) || /提交|保存|创建|删除/.test(step) && !/按下|回车|键盘/.test(step)) actions.push('click');
  if (/填写|输入|录入/.test(step)) actions.push('fill');
  if (/下拉|选择/.test(step) && !/选择器/.test(step)) actions.push('select');
  if (/打开|访问|跳转/.test(step)) actions.push('navigate');
  if (/按下|回车|键盘/.test(step)) actions.push('press');
  return actions;
}

export function checkStepActions(step: string, actions: Set<string>) {
  const missing = requiredActions(step).filter(action => !actions.has(action));
  // 打开页面可以通过页面链接或按钮完成，不要求一定直接导航。
  return missing.filter(action => !(['navigate', 'select'].includes(action) && actions.has('click')));
}

export function readonlyPhase(phase: string, action: string) {
  return phase !== 'VERIFYING' || action === 'snapshot';
}

function validEvidence(evidence: RunEvidence[], ids: string[], runId: string, caseId: string, stepId: string, assertion = false) {
  return ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => evidence.some(e => e.id === id && e.runId === runId && e.caseId === caseId && e.stepId === stepId && e.success !== false && (!assertion || ['observation', 'position', 'screenshot'].includes(e.kind))));
}

export function validateCaseResult(runId: string, c: TestCase, result: CaseResult) {
  const validAssertions = result.assertions.filter(a => {
    const index = Number(a.expectationId.slice(1)) - 1;
    return /^e[1-9]\d*$/.test(a.expectationId) && c.expectations[index] === a.expected && validEvidence(result.evidence, a.evidenceIds, runId, c.id, a.expectationId, true);
  });
  if (validAssertions.some(a => a.status === 'FAILED')) { result.status = 'FAILED'; return; }
  if (['ERROR', 'CANCELLED', 'INTERRUPTED'].includes(result.status)) return;
  if (result.status === 'BLOCKED') {
    if (result.phase !== 'PREPARING' || !result.evidence.some(e => e.stepId === 'prepare' && e.success !== false && e.runId === runId && e.caseId === c.id)) { result.status = 'ERROR'; result.reason = '前置阻塞缺少实际页面证据'; }
    return;
  }
  const allSteps = c.steps.every((text, i) => result.steps.filter(s => s.id === `s${i + 1}` && s.text === text && s.status === 'DONE' && validEvidence(result.evidence, s.evidenceIds, runId, c.id, s.id)).length === 1);
  const allAssertions = c.expectations.length > 0 && validAssertions.length === c.expectations.length && c.expectations.every((_text, i) => validAssertions.filter(a => a.expectationId === `e${i + 1}` && a.status === 'PASSED').length === 1);
  result.status = allSteps && allAssertions ? 'PASSED' : 'ERROR';
  if (result.status === 'ERROR') result.reason = '步骤、逐项预期或当前用例证据不完整，不能判为通过';
}
