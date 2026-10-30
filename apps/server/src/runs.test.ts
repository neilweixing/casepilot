import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CaseResult, Environment, Run, TestCase } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import { RunManager } from './runs.ts';
import { AuthenticationFailure, executeCase } from './case-agent.ts';
import { loadConfig } from './config.ts';

const sample: TestCase = { id: 'case', externalId: 'C', title: '提交', module: '', priority: '', preconditions: [], steps: ['点击提交'], expectations: ['提示成功'], source: { fileName: 'synthetic.xlsx', sheet: 'S', rows: [2], original: [] }, excluded: false, duplicateAcknowledged: false };
function harness(executor: typeof executeCase, count = 1) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'casepilot-run-')), store = new Store(directory);
  const ref = store.password(JSON.stringify({ password: 'old-synthetic', captchaCode: '' }));
  const env: Environment = { id: 'env', systemId: 'sys', name: 'synthetic', baseURL: 'http://127.0.0.1:4310/demo', loginURL: '', username: 'synthetic', credentialRef: ref, hasPassword: true, captchaCode: '', captchaStrategy: 'none', createdAt: '' };
  store.put('environment', env);
  store.put('import-version', { id: 'import:1', confirmedAt: new Date().toISOString(), cases: Array.from({ length: count }, (_, i) => ({ ...structuredClone(sample), id: `case-${i}` })) });
  const manager = new RunManager(store, loadConfig({ CASEPILOT_DATA_DIR: directory }), { executeCase: executor!, loadModel: () => ({ apiKey: 'synthetic-not-used', baseURL: 'http://127.0.0.1', modelId: 'synthetic-not-used', contextWindow: 65536, maxTokens: 4096, input: ['text'] as ('text' | 'image')[], reasoning: false, thinkingLevel: 'off' as const }) });
  return { directory, store, manager, env, async cleanup() { await manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function finish(runId: string, c: TestCase, r: CaseResult, status: 'PASSED' | 'FAILED') {
  r.steps[0]!.status = 'DONE'; r.steps[0]!.evidenceIds = ['step'];
  r.evidence.push(...[{ id: 'step', stepId: 's1', kind: 'tool' as const }, { id: 'observation', stepId: 'e1', kind: 'observation' as const }].map(e => ({ ...e, runId, caseId: c.id, path: e.id + '.json', timestamp: '', success: true })));
  r.assertions.push({ expectationId: 'e1', expected: c.expectations[0]!, actual: '合成状态机输入，不代表真实页面', status, evidenceIds: ['observation'] }); r.status = status;
}
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); } throw new Error('状态转换超时'); }

test('串行执行失败/阻塞后继续，服务拒绝第二个任务并释放共享锁', async () => {
  let release!: () => void; const held = new Promise<void>(r => { release = r; }); const order: string[] = [];
  const h = harness(async (_cfg, _model, runId, c, _env, _cred, r, control) => {
    order.push(c.id); await held;
    if (c.id === 'case-1') { r.phase = 'PREPARING'; r.status = 'BLOCKED'; r.evidence.push({ id: 'p', runId, caseId: c.id, stepId: 'prepare', kind: 'tool', path: 'p.json', timestamp: '', success: true }); }
    else finish(runId, c, r, c.id === 'case-0' ? 'FAILED' : 'PASSED');
    control.changed();
  }, 3);
  try {
    const run = h.manager.create('import', 1, h.env.id);
    assert.ok(existsSync(path.join(h.directory, 'm1.lock')));
    assert.throws(() => h.manager.create('import', 1, h.env.id), /占用|任务/);
    release(); await until(() => h.store.get<Run>('run', run.id).status === 'COMPLETED');
    const stored = h.store.get<Run>('run', run.id);
    assert.deepEqual(order, ['case-0', 'case-1', 'case-2']); assert.deepEqual(stored.results.map(r => r.status), ['FAILED', 'BLOCKED', 'PASSED']);
    assert.equal(existsSync(path.join(h.directory, 'm1.lock')), false);
  } finally { release(); await h.cleanup(); }
});
test('认证失败暂停整批，显式继续后可更新同账号密码，不执行后续用例', async () => {
  const passwords: string[] = []; let attempts = 0;
  const h = harness(async (_cfg, _model, runId, c, _env, cred, r) => {
    passwords.push(cred.password); attempts++;
    if (attempts === 1) { r.phase = 'AUTHENTICATING'; throw new AuthenticationFailure('测试密码错误'); }
    finish(runId, c, r, 'PASSED');
  });
  try {
    const run = h.manager.create('import', 1, h.env.id); await until(() => h.store.get<Run>('run', run.id).status === 'PAUSED');
    assert.equal(attempts, 1); assert.equal(h.store.get<Run>('run', run.id).results[0]!.status, 'PENDING');
    h.store.put('environment', { ...h.env, credentialRef: h.store.password(JSON.stringify({ password: 'new-synthetic', captchaCode: '' })) });
    h.manager.control(run.id, 'resume'); await until(() => h.store.get<Run>('run', run.id).status === 'COMPLETED');
    assert.deepEqual(passwords, ['old-synthetic', 'new-synthetic']);
  } finally { await h.cleanup(); }
});
test('运行期间服务关闭记录中断，未开始项保持 PENDING，不自动重放', async () => {
  const h = harness(async (_cfg, _model, _runId, _c, _env, _cred, r, control) => {
    await new Promise<void>(resolve => { control.signal.addEventListener('abort', () => resolve(), { once: true }); }); r.status = 'CANCELLED';
  }, 2);
  try {
    const run = h.manager.create('import', 1, h.env.id); await until(() => h.store.get<Run>('run', run.id).results[0]!.status === 'RUNNING');
    await h.manager.close(); const stored = h.store.get<Run>('run', run.id);
    assert.equal(stored.status, 'INTERRUPTED'); assert.deepEqual(stored.results.map(r => r.status), ['INTERRUPTED', 'PENDING']);
  } finally { await h.cleanup(); }
});

test('准备或业务中登录失效保留 ERROR，显式继续只运行下一条并加载同账号新凭证', async () => {
  for (const phase of ['PREPARING', 'EXECUTING', 'VERIFYING']) {
    const visits: string[] = [], passwords: string[] = [];
    const h = harness(async (_cfg, _model, runId, c, _env, cred, r) => {
      visits.push(c.id); passwords.push(cred.password);
      if (c.id === 'case-0') { r.phase = phase; throw new AuthenticationFailure('登录状态已失效'); }
      finish(runId, c, r, 'PASSED');
    }, 2);
    try {
      const run = h.manager.create('import', 1, h.env.id);
      await until(() => h.store.get<Run>('run', run.id).status === 'PAUSED');
      const paused = h.store.get<Run>('run', run.id);
      assert.deepEqual(paused.results.map(r => r.status), ['ERROR', 'PENDING']);
      assert.ok(paused.reason.startsWith('登录无法完成'));
      assert.ok(paused.events.some(e => e.type === 'case_finished' && e.caseId === 'case-0'));
      h.store.put('environment', { ...h.env, credentialRef: h.store.password(JSON.stringify({ password: 'new-synthetic', captchaCode: '' })) });
      h.manager.control(run.id, 'resume');
      await until(() => h.store.get<Run>('run', run.id).status === 'COMPLETED');
      assert.deepEqual(visits, ['case-0', 'case-1']); assert.deepEqual(passwords, ['old-synthetic', 'new-synthetic']);
      assert.deepEqual(h.store.get<Run>('run', run.id).results.map(r => r.status), ['ERROR', 'PASSED']);
    } finally { await h.cleanup(); }
  }
});

test('已经证实的失败在登录失效、暂停和停止后仍保留 FAILED', async () => {
  const h = harness(async (_cfg, _model, runId, c, _env, _cred, r) => {
    finish(runId, c, r, 'FAILED'); r.phase = 'VERIFYING'; throw new AuthenticationFailure('会话失效');
  }, 2);
  try {
    const run = h.manager.create('import', 1, h.env.id); await until(() => h.store.get<Run>('run', run.id).status === 'PAUSED');
    assert.deepEqual(h.store.get<Run>('run', run.id).results.map(r => r.status), ['FAILED', 'PENDING']);
    h.manager.control(run.id, 'stop'); await until(() => h.store.get<Run>('run', run.id).status === 'CANCELLED');
    assert.deepEqual(h.store.get<Run>('run', run.id).results.map(r => r.status), ['FAILED', 'CANCELLED']);
  } finally { await h.cleanup(); }
});
