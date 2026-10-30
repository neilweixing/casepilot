import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaseResult, Run, RunEvidence, TestCase } from '../../../packages/contracts/src/p0.ts';
import { checkStepActions, publicRunData, readonlyPhase, scrubValue, secretRedactor, validateCaseResult } from './execution-rules.ts';

const c: TestCase = { id: 'case', externalId: 'C1', title: '提交', module: '', priority: '', preconditions: [], steps: ['点击提交'], expectations: ['显示成功', '日期位于姓名下方'], source: { fileName: 'sample.xlsx', sheet: 'Sheet1', rows: [2], original: ['原始文本'] }, excluded: false, duplicateAcknowledged: false };
const evidence = (id: string, stepId: string, kind: RunEvidence['kind'] = 'observation'): RunEvidence => ({ id, runId: 'run', caseId: c.id, stepId, kind, success: true, timestamp: new Date().toISOString(), path: id + '.json' });
const complete = (): CaseResult => ({ caseId: c.id, status: 'PASSED', phase: 'VERIFYING', reason: '', startedAt: null, endedAt: null, steps: [{ id: 's1', text: c.steps[0]!, status: 'DONE', evidenceIds: ['s'] }], assertions: [{ expectationId: 'e1', expected: c.expectations[0]!, actual: '成功', status: 'PASSED', evidenceIds: ['o1'] }, { expectationId: 'e2', expected: c.expectations[1]!, actual: '坐标在下方', status: 'PASSED', evidenceIds: ['o2'] }], evidence: [evidence('s', 's1', 'tool'), evidence('o1', 'e1'), evidence('o2', 'e2', 'position')] });

test('验证阶段只允许只读 UI 操作，不能补操作制造通过', () => {
  assert.equal(readonlyPhase('VERIFYING', 'snapshot'), true);
  for (const action of ['click', 'fill', 'select', 'press', 'navigate']) assert.equal(readonlyPhase('VERIFYING', action), false);
  assert.equal(readonlyPhase('EXECUTING', 'click'), true);
});
test('点击与填写步骤需要实际动作，检查提交结果不要求再次提交', () => {
  assert.deepEqual(checkStepActions('点击提交', new Set(['snapshot'])), ['click']);
  assert.deepEqual(checkStepActions('填写姓名并点击保存', new Set(['fill'])), ['click']);
  assert.deepEqual(checkStepActions('检查提交后的提示', new Set(['snapshot'])), []);
  assert.deepEqual(checkStepActions('确认输入框的值正确', new Set(['snapshot'])), []);
  assert.deepEqual(checkStepActions('按下回车提交', new Set(['press'])), []);
  assert.deepEqual(checkStepActions('打开页面', new Set(['click'])), []);
});
test('完整证据才接受通过，缺步骤/预期/关联或改动预期均拒绝', () => {
  const good = complete(); validateCaseResult('run', c, good); assert.equal(good.status, 'PASSED');
  for (const mutate of [
    (r: CaseResult) => { r.steps = []; },
    (r: CaseResult) => { r.assertions.pop(); },
    (r: CaseResult) => { r.assertions[0]!.expected = '放宽后的标准'; },
    (r: CaseResult) => { r.evidence[1]!.runId = 'other'; },
    (r: CaseResult) => { r.evidence[1]!.stepId = 'e2'; },
    (r: CaseResult) => { r.evidence[0]!.success = false; },
    (r: CaseResult) => { r.assertions[0]!.status = 'ERROR'; r.assertions[0]!.evidenceIds = []; r.assertions[0]!.actual = '页面丢失，无法验证'; },
  ]) { const r = complete(); mutate(r); validateCaseResult('run', c, r); assert.equal(r.status, 'ERROR'); }
});
test('明确失败保留，未完成后续验证或取消不能抹去失败', () => {
  const r = complete(); r.assertions[0]!.status = 'FAILED'; r.assertions.pop(); r.status = 'CANCELLED';
  validateCaseResult('run', c, r); assert.equal(r.status, 'FAILED');
});
test('BLOCKED 必须来自准备阶段的实际证据', () => {
  const r = complete(); r.status = 'BLOCKED'; validateCaseResult('run', c, r); assert.equal(r.status, 'ERROR');
  const b = complete(); b.status = 'BLOCKED'; b.phase = 'PREPARING'; b.evidence.push(evidence('p', 'prepare', 'tool'));
  validateCaseResult('run', c, b); assert.equal(b.status, 'BLOCKED');
});
test('递归脱敏保持 JSON 结构，支持引号、反斜杠与短凭证', () => {
  const password = 'pa"ss\\word', clean = secretRedactor([password, 'a']);
  const original = { name: 'name', args: { password, value: 'a' }, success: true, message: `echo ${JSON.stringify(password)}` };
  const value = scrubValue(original, clean);
  assert.equal(value.args.password, '[REDACTED]'); assert.equal(value.args.value, '[REDACTED]'); assert.equal(value.name, 'name'); assert.equal(value.success, true);
  assert.ok(!JSON.stringify(value).includes(JSON.stringify(password).slice(1, -1)));
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value); assert.equal(original.args.password, password);
});
test('正文脱敏不能破坏服务标识与证据引用', () => {
  const run = { id: '123-identifier', importId: 'import-123', environment: { id: 'environment-123', systemId: 'system-123', name: '123' }, cases: [{ ...c, id: 'case-123' }], results: [complete()], events: [{ seq: 1, timestamp: '', type: 'progress', caseId: 'case-123', message: '123' }], reason: '账号 123' } as unknown as Run;
  run.results[0]!.assertions[0]!.actual = '账号 123'; run.results[0]!.evidence[0]!.id = 'proof-123';
  const out = publicRunData(run, ['123']);
  assert.equal(out.id, run.id); assert.equal(out.cases[0]!.id, 'case-123'); assert.equal(out.results[0]!.evidence[0]!.id, 'proof-123');
  assert.equal(out.results[0]!.assertions[0]!.actual, '账号 [REDACTED]'); assert.equal(out.events[0]!.caseId, 'case-123');
});
