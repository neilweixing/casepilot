import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { smokeCase, type Evidence, type ExpectationResult } from '../../../packages/contracts/src/smoke.ts';
import { EvidenceStore, finalizeResult } from './evidence.ts';
import { loadConfig, loadModelConfig, redact } from './config.ts';
import { assessObservation, assessVisual, parseObservation, type Observation } from './observe.ts';
import { createServer } from './server.ts';
import { checkToolCall, type ToolPolicyState } from './tool-policy.ts';
import { mcpTool } from './mcp.ts';
import { observeFunction } from './fixture.ts';

const runId = '7c8e2b36-035f-4a54-bfa6-f04ab71423c6';
const url = `http://127.0.0.1:4310/m1/form?run=${runId}&variant=normal`;
const observation: Observation = {
  runId, url, text: '已提交：测试用户 / 2026-11-01', submissions: 1, name: '测试用户', startDate: '2026-11-01',
  nameRect: { x: 0, y: 100, width: 200, height: 40, bottom: 140, visible: true },
  dateRect: { x: 0, y: 180, width: 200, height: 40, bottom: 220, visible: true },
};
const evidence: Evidence[] = [
  { id: 'o', kind: 'observation', path: 'o.json' },
  { id: 's', kind: 'screenshot', path: 's.png' },
  { id: 'v', kind: 'visual', path: 'v.json', expectationId: 'visual-code' },
].map(item => ({ ...item, runId, caseId: smokeCase.id, timestamp: new Date().toISOString() })) as Evidence[];
const expectations: ExpectationResult[] = [
  ...assessObservation(observation, ['o', 's']),
  { expectationId: 'visual-code', status: 'PASSED', actual: '1234', evidenceIds: ['v', 's'] },
];

test('必须逐项有本次证据，才接受通过', () => {
  assert.equal(finalizeResult(runId, expectations, evidence, []).status, 'PASSED');
  assert.equal(finalizeResult(runId, expectations.slice(0, 2), evidence, []).status, 'ERROR');
  assert.equal(finalizeResult(runId, expectations, evidence.filter(e => e.kind !== 'screenshot'), []).status, 'ERROR');
  assert.equal(finalizeResult(runId, expectations, evidence.map(e => ({ ...e, runId: 'another-run' })), []).status, 'ERROR');
  assert.equal(finalizeResult(runId, [...expectations, expectations[0]!], evidence, []).status, 'ERROR');
  assert.equal(finalizeResult(runId, [], [], []).status, 'ERROR');
});

test('模型看不到图像、图像未发出或识别不可靠都记执行异常', () => {
  assert.equal(assessVisual('1234', '1234', 1, []).status, 'PASSED');
  assert.equal(assessVisual('unavailable', '1234', 1, []).status, 'ERROR');
  assert.equal(assessVisual('1234', '1234', 0, []).status, 'ERROR');
  assert.equal(assessVisual('4321', '1234', 1, []).status, 'ERROR');
});

test('已证实的失败不被后续异常或终止抹掉', () => {
  const failed = expectations.map(item => item.expectationId === 'field-position' ? { ...item, status: 'FAILED' as const } : item);
  assert.equal(finalizeResult(runId, failed, evidence, ['后续工具异常'], true).status, 'FAILED');
  assert.equal(finalizeResult(runId, expectations, evidence, ['模型异常']).status, 'ERROR');
  assert.equal(finalizeResult(runId, [], [], [], true).status, 'CANCELLED');
  assert.deepEqual(finalizeResult(runId, [], [], [], true).errors, []);
  const withoutScreenshot = failed.map(item => ({ ...item, evidenceIds: item.evidenceIds.filter(id => id !== 's') }));
  assert.equal(finalizeResult(runId, withoutScreenshot, evidence.filter(e => e.id !== 's'), ['后续截图失败']).status, 'FAILED');
});

test('字段文字都存在时，仍按实际矩形判断顺序和可见性', () => {
  assert.deepEqual(assessObservation(observation, []).map(e => e.status), ['PASSED', 'PASSED']);
  const reversed = { ...observation, nameRect: observation.dateRect, dateRect: observation.nameRect };
  assert.deepEqual(assessObservation(reversed, []).map(e => e.status), ['PASSED', 'FAILED']);
  const hidden = { ...observation, dateRect: { ...observation.dateRect, visible: false } };
  assert.equal(assessObservation(hidden, [])[1]!.status, 'FAILED');
  assert.equal(assessObservation({ ...observation, submissions: 2 }, [])[0]!.status, 'FAILED');
});

test('页面观察拒绝其他运行、其他页面和缺失位置', () => {
  const content = (value: unknown) => [{ type: 'text', text: `### Result\n${JSON.stringify(value)}\n### Ran Playwright code\n...` }];
  assert.deepEqual(parseObservation(content(observation), runId, url), observation);
  assert.throws(() => parseObservation(content({ ...observation, runId: 'other' }), runId, url));
  assert.throws(() => parseObservation(content({ ...observation, url: url + '#other' }), runId, url));
  assert.throws(() => parseObservation(content({ ...observation, dateRect: null }), runId, url));
  assert.throws(() => parseObservation([{ type: 'text', text: '操作成功' }], runId, url));
});

test('配置不回显秘密，未配置不使用假模型', () => {
  assert.throws(() => loadModelConfig({}), /CASEPILOT_BASE_URL/);
  assert.throws(() => loadModelConfig({ CASEPILOT_API_KEY: 'secret-value', CASEPILOT_BASE_URL: 'https://user:secret-value@example.com', CASEPILOT_MODEL_ID: 'model' }), error => error instanceof Error && !error.message.includes('secret-value'));
  assert.throws(() => loadConfig({ CASEPILOT_HOST: '0.0.0.0' }));
  assert.throws(() => loadConfig({ CASEPILOT_CASE_TIMEOUT_MS: 'Infinity' }));
  assert.equal(loadConfig({}).timeoutMs, 300000);
  assert.equal(loadConfig({}).stepRecoveryAttempts, 2); assert.equal(loadConfig({}).stepRecoveryTimeoutMs, 120000);
  assert.throws(() => loadConfig({ CASEPILOT_STEP_RECOVERY_ATTEMPTS: '-1' }));
  assert.throws(() => loadConfig({ CASEPILOT_STEP_RECOVERY_ATTEMPTS: '6' }));
  assert.throws(() => loadConfig({ CASEPILOT_STEP_RECOVERY_TIMEOUT_MS: 'Infinity' }));
  assert.equal(loadConfig({ CASEPILOT_CASE_TIMEOUT_MS: '600000' }).timeoutMs, 600000);
  assert.equal(loadConfig({ CASEPILOT_CASE_TIMEOUT_MS: '900000' }).timeoutMs, 900000);
  assert.throws(() => loadConfig({ CASEPILOT_CASE_TIMEOUT_MS: '900001' }));
  assert.equal(redact('secret-value secret-value', ['secret-value']), '[REDACTED] [REDACTED]');
});

test('证据落盘脱敏且拒绝假 PNG', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'casepilot-evidence-'));
  try {
    const store = new EvidenceStore(runId, directory, ['secret-value']);
    store.add('tool', { error: 'secret-value' }, { stepId: 'open' });
    store.event('test', { token: 'secret-value' });
    assert.ok(!readFileSync(path.join(store.directory, 'e1.json'), 'utf8').includes('secret-value'));
    assert.ok(!readFileSync(path.join(store.directory, 'events.jsonl'), 'utf8').includes('secret-value'));
    assert.throws(() => store.add('screenshot', Buffer.from('fake png')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('可控页提供正序和反序，拒绝无效输入和非本机 Host', async () => {
  const app = createServer(loadConfig({}));
  try {
    const inject = (path: string) => app.inject({ method: 'GET', url: path, headers: { host: '127.0.0.1:4310' } });
    const normal = await inject(`/m1/form?run=${runId}`);
    const reversed = await inject(`/m1/form?run=${runId}&variant=reversed`);
    assert.equal(normal.statusCode, 200);
    assert.ok(normal.body.indexOf('name="name"') < normal.body.indexOf('name="startDate"'));
    assert.ok(reversed.body.indexOf('name="startDate"') < reversed.body.indexOf('name="name"'));
    assert.equal((await inject('/m1/form?run=<script>')).statusCode, 400);
    assert.equal((await app.inject({ url: '/health', headers: { host: 'evil.example' } })).statusCode, 403);
  } finally { await app.close(); }
});

test('工具边界拦截 shell、任意脚本、文件写入和外部导航', () => {
  const state: ToolPolicyState = { completedSteps: new Set(), navigateIssued: false, submitIssued: false, toolCalls: 0, finished: false };
  const check = (name: string, input = {}, parent?: string) => checkToolCall(name, input, parent, state, url, false, 30);
  assert.ok(check('bash', { command: 'pwd' }));
  assert.ok(check(mcpTool('browser_evaluate'), { function: '() => fetch("https://evil.example")' }, 'parent'));
  assert.ok(check(mcpTool('browser_evaluate'), { function: observeFunction }));
  assert.equal(check(mcpTool('browser_evaluate'), { function: observeFunction }, 'parent'), undefined);
  assert.ok(check(mcpTool('browser_snapshot'), { filename: '/tmp/unwanted.txt' }));
  assert.ok(check(mcpTool('browser_take_screenshot'), { type: 'png', scale: 'css', fullPage: false, filename: '/tmp/unwanted.png' }, 'parent'));
  assert.ok(check(mcpTool('browser_navigate'), { url: 'https://evil.example' }));
  assert.equal(check(mcpTool('browser_navigate'), { url }), undefined);
  assert.ok(check(mcpTool('browser_navigate'), { url }));
});

test('提交结果不明时仍禁止再次点击，终止及预算也由服务拦截', () => {
  const state: ToolPolicyState = { completedSteps: new Set(['open', 'fill']), navigateIssued: true, submitIssued: false, toolCalls: 0, finished: false };
  assert.equal(checkToolCall(mcpTool('browser_click'), { target: 'e1' }, undefined, state, url, false, 3), undefined);
  assert.ok(checkToolCall(mcpTool('browser_click'), { target: 'e1' }, undefined, state, url, false, 3));
  assert.ok(checkToolCall(mcpTool('browser_snapshot'), {}, undefined, state, url, true, 3));
  assert.ok(checkToolCall(mcpTool('browser_snapshot'), {}, undefined, state, url, false, 3));
});
