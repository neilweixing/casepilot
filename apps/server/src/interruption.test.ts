import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Run, TestCase } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import { RunManager } from './runs.ts';
import { loadConfig } from './config.ts';

function seed() {
  const directory = mkdtempSync(path.join(tmpdir(), 'casepilot-interruption-')), store = new Store(directory), id = randomUUID();
  const cases: TestCase[] = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, externalId: '', title: `状态样本 ${i}`, module: '', priority: '', preconditions: [], steps: ['点击创建记录'], expectations: ['页面提示成功'], source: { fileName: 'synthetic.xlsx', sheet: 'S', rows: [i + 2], original: [] }, excluded: false, duplicateAcknowledged: false }));
  const run: Run = { id, importId: 'import', revision: 1, environment: { id: 'env', systemId: 'sys', name: 'synthetic', baseURL: 'http://127.0.0.1:4310/demo' }, modelId: 'synthetic-not-used', status: 'RUNNING', reason: '', createdAt: '2026-10-30T00:00:00Z', endedAt: null, cases, results: cases.map((c, i) => ({ caseId: c.id, status: i === 0 ? 'PASSED' : i === 1 ? 'RUNNING' : 'PENDING', phase: 'EXECUTING', reason: '状态机输入，不代表真实 UI 验证', assertions: [], steps: [{ id: 's1', text: c.steps[0]!, status: i === 0 ? 'DONE' : i === 1 ? 'SENT' : 'PENDING', evidenceIds: [] }], evidence: [], startedAt: i < 2 ? '2026-10-30T00:00:01Z' : null, endedAt: i === 0 ? '2026-10-30T00:00:02Z' : null })), events: [{ seq: 3, timestamp: '2026-10-30T00:00:01Z', type: 'started', message: '合成状态输入' }] };
  store.put('run', run); store.put('run-private', { id, ownerPid: 900001, children: [] });
  const lock = path.join(directory, 'm1.lock');
  writeFileSync(lock, JSON.stringify({ kind: 'run', runId: id, ownerPid: 900001 }), { mode: 0o600 });
  return { store, run, directory, lock, config: loadConfig({ CASEPILOT_DATA_DIR: directory }), cleanup() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('已退出的运行恢复中断、保留已知结果与未知步骤，安全回收匹配的残留锁', () => {
  const h = seed();
  try {
    new RunManager(h.store, h.config, { isProcessAlive: () => false });
    const r = h.store.get<Run>('run', h.run.id);
    assert.deepEqual(r.results.map(r => r.status), ['PASSED', 'INTERRUPTED', 'PENDING']);
    assert.deepEqual(r.results[0], h.run.results[0]); assert.equal(r.results[1]!.steps[0]!.status, 'UNCERTAIN');
    assert.ok(r.results[1]!.endedAt); assert.equal(r.results[2]!.startedAt, null);
    assert.equal(r.events.at(-1)?.type, 'interrupted'); assert.equal(r.events.at(-1)?.seq, 4);
    assert.equal(existsSync(h.lock), false);
    const snapshot = structuredClone(r); new RunManager(h.store, h.config, { isProcessAlive: () => false });
    assert.deepEqual(h.store.get('run', r.id), snapshot, '重复打开不能重复修订历史或触发执行');
  } finally { h.cleanup(); }
});

test('锁归属进程仍存活时不篡改其运行，不启动第二个任务', () => {
  const h = seed();
  try {
    const manager = new RunManager(h.store, h.config, { isProcessAlive: pid => pid === 900001 });
    assert.deepEqual(h.store.get('run', h.run.id), h.run); assert.ok(existsSync(h.lock));
    assert.throws(() => manager.create('missing', 1, 'env'), /占用|释放/);
  } finally { h.cleanup(); }
});

test('旧运行已退出但工具仍存活时保留锁，工具释放后可重新核对并解除占用', () => {
  const h = seed(); let alive = true;
  try {
    h.store.put('run-private', { id: h.run.id, ownerPid: 900001, pid: 900002, children: [] });
    const manager = new RunManager(h.store, h.config, { isProcessAlive: pid => alive && pid === 900002 });
    assert.equal(h.store.get<Run>('run', h.run.id).status, 'INTERRUPTED'); assert.ok(existsSync(h.lock));
    assert.throws(() => manager.create('missing', 1, 'env'), /占用|释放/);
    alive = false;
    assert.throws(() => manager.create('missing', 1, 'env'), /尚未确认/);
    assert.equal(existsSync(h.lock), false);
    assert.deepEqual(h.store.get<{ children: number[] }>('run-private', h.run.id).children, []);
  } finally { h.cleanup(); }
});

test('未知或旧格式锁不被擅自删除，无法确认归属时保持阻止', () => {
  for (const contents of ['900001', 'invalid-lock', JSON.stringify({ kind: 'run', runId: randomUUID(), ownerPid: 900001 })]) {
    const h = seed();
    try {
      writeFileSync(h.lock, contents);
      const manager = new RunManager(h.store, h.config, { isProcessAlive: () => false });
      assert.equal(readFileSync(h.lock, 'utf8'), contents);
      assert.throws(() => manager.create('missing', 1, 'env'), /占用|释放/);
    } finally { h.cleanup(); }
  }
});

test('关闭先保存中断，再等待执行器退出，尚未开始项保持未开始', async () => {
  const h = seed(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  // 清除构造用的运行/锁，用一个真实调度状态验证关闭时的持久化时机。
  h.store.db.prepare("DELETE FROM documents WHERE kind IN ('run','run-private')").run();
  rmSync(h.lock);
  const ref = h.store.password(JSON.stringify({ password: '', captchaCode: '' }));
  h.store.put('environment', { id: 'env', systemId: 'sys', name: 'synthetic', baseURL: 'http://127.0.0.1:4310/demo', username: '', credentialRef: ref });
  h.store.put('import-version', { id: 'import:1', confirmedAt: 'confirmed', cases: h.run.cases });
  const manager = new RunManager(h.store, h.config, { executeCase: async () => { await held; }, loadModel: () => ({ apiKey: 'not-used', baseURL: 'http://127.0.0.1', modelId: 'not-used', contextWindow: 65536, maxTokens: 4096, input: ['text'] as ('text' | 'image')[], reasoning: false, thinkingLevel: 'off' as const }) });
  let closing: Promise<void> | undefined;
  try {
    const r = manager.create('import', 1, 'env');
    await delay(10); closing = manager.close(); await delay(10);
    assert.equal(h.store.get<Run>('run', r.id).status, 'INTERRUPTED');
    assert.deepEqual(h.store.get<Run>('run', r.id).results.map(r => r.status), ['INTERRUPTED', 'PENDING', 'PENDING']);
  } finally { release(); await closing; await manager.close(); h.cleanup(); }
});
