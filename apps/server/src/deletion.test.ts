import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Environment, ImportDraft, Run, System, TestCase } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import { deleteEnvironment, deleteImport, deleteRun, deleteSystem } from './deletion.ts';

const testCase: TestCase = { id: 'case', externalId: 'C', title: '标题', module: '', priority: '', preconditions: [], steps: ['点击'], expectations: ['成功'], source: { fileName: 'synthetic.xlsx', sheet: 'S', rows: [2], original: [] }, excluded: false, duplicateAcknowledged: false };

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'casepilot-delete-'));
  const store = new Store(directory);
  return { directory, store, cleanup() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function system(store: Store, id: string): System { return store.put('system', { id, name: `系统 ${id}` }); }
function environment(store: Store, id: string, systemId: string, credentialRef: string): Environment {
  return store.put('environment', { id, systemId, name: `环境 ${id}`, baseURL: 'http://127.0.0.1:4310/demo', loginURL: '', username: 'synthetic', credentialRef, hasPassword: true, captchaCode: '', captchaStrategy: 'none', createdAt: '' });
}
function run(store: Store, id: string, environmentId: string, importId: string, status: Run['status'] = 'COMPLETED'): Run {
  return store.put('run', { id, importId, revision: 1, environment: { id: environmentId, name: '环境', baseURL: 'http://127.0.0.1:4310/demo', systemId: 'sys' }, modelId: 'synthetic', status, cases: [testCase], results: [], events: [], reason: '', createdAt: '', endedAt: null });
}
function importDraft(store: Store, id: string): ImportDraft {
  const draft: ImportDraft = { id, fileName: 'synthetic.xlsx', revision: 1, confirmedAt: '', createdAt: '', systemId: '', origin: 'excel', sheets: [], mappings: {}, cases: [testCase], issues: [] };
  store.put('import', draft);
  store.put('import-version', { ...draft, id: `${id}:1`, importId: id });
  mkdirSync(path.join(store.dataDir, 'imports', id), { recursive: true });
  writeFileSync(path.join(store.dataDir, 'imports', id, 'original.xlsx'), 'synthetic');
  return draft;
}

test('系统下仍有环境时拒绝删除，删完环境后可以删除', () => {
  const h = setup();
  try {
    system(h.store, 'sys');
    const ref = h.store.password(JSON.stringify({ password: 'synthetic', captchaCode: '' }));
    environment(h.store, 'env', 'sys', ref);
    assert.throws(() => deleteSystem(h.store, 'sys'), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /还有 1 个环境/.test(error.message));
    assert.ok(h.store.has('system', 'sys'));
    deleteEnvironment(h.store, 'env');
    assert.equal(deleteSystem(h.store, 'sys').deleted, 'system');
    assert.ok(!h.store.has('system', 'sys'));
  } finally { h.cleanup(); }
});

test('环境被历史任务使用时拒绝删除，且不误删共享凭证', () => {
  const h = setup();
  try {
    system(h.store, 'sys');
    const ref = h.store.password(JSON.stringify({ password: 'synthetic', captchaCode: '' }));
    environment(h.store, 'env', 'sys', ref);
    importDraft(h.store, 'import');
    run(h.store, 'run', 'env', 'import');
    // 历史任务的私有记录与环境共享同一个凭证引用。
    h.store.put('run-private', { id: 'run', credentialRef: ref, environment: h.store.get<Environment>('environment', 'env'), children: [] });
    assert.throws(() => deleteEnvironment(h.store, 'env'), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /1 个历史任务/.test(error.message));
    assert.ok(existsSync(path.join(h.directory, 'credentials', `${ref}.json`)), '任务仍引用时凭证必须保留');
  } finally { h.cleanup(); }
});

test('无引用的环境连同专属凭证一起删除，共享凭证不被误删', () => {
  const h = setup();
  try {
    system(h.store, 'sys');
    const shared = h.store.password(JSON.stringify({ password: 'shared', captchaCode: '' }));
    const own = h.store.password(JSON.stringify({ password: 'own', captchaCode: '' }));
    environment(h.store, 'env-a', 'sys', shared);
    environment(h.store, 'env-b', 'sys', shared);
    environment(h.store, 'env-c', 'sys', own);
    assert.equal(deleteEnvironment(h.store, 'env-a').credentialReleased, false, '凭证仍被 env-b 使用');
    assert.ok(existsSync(path.join(h.directory, 'credentials', `${shared}.json`)));
    assert.equal(deleteEnvironment(h.store, 'env-c').credentialReleased, true, '唯一持有者删除后凭证应移除');
    assert.ok(!existsSync(path.join(h.directory, 'credentials', `${own}.json`)));
  } finally { h.cleanup(); }
});

test('用例集被任务引用时拒绝，无引用时连同确认版本与原文件一起删除', () => {
  const h = setup();
  try {
    system(h.store, 'sys');
    const ref = h.store.password(JSON.stringify({ password: 'synthetic', captchaCode: '' }));
    environment(h.store, 'env', 'sys', ref);
    importDraft(h.store, 'import-used');
    importDraft(h.store, 'import-free');
    run(h.store, 'run', 'env', 'import-used');
    assert.throws(() => deleteImport(h.store, 'import-used'), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /1 个历史任务/.test(error.message));
    const result = deleteImport(h.store, 'import-free');
    assert.equal(result.versionsRemoved, 1);
    assert.ok(!h.store.has('import', 'import-free'));
    assert.ok(!h.store.has('import-version', 'import-free:1'));
    assert.ok(!existsSync(path.join(h.directory, 'imports', 'import-free')));
  } finally { h.cleanup(); }
});

test('运行中的任务拒绝删除，终态任务连同私有记录与证据目录一起删除', () => {
  const h = setup();
  try {
    system(h.store, 'sys');
    const ref = h.store.password(JSON.stringify({ password: 'synthetic', captchaCode: '' }));
    environment(h.store, 'env', 'sys', ref);
    importDraft(h.store, 'import');
    for (const status of ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'] as const) {
      run(h.store, `run-${status}`, 'env', 'import', status);
      assert.throws(() => deleteRun(h.store, `run-${status}`), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /请先停止/.test(error.message), `${status} 不应允许删除`);
      h.store.remove('run', `run-${status}`);
    }
    run(h.store, 'run-done', 'env', 'import');
    h.store.put('run-private', { id: 'run-done', credentialRef: ref, environment: h.store.get<Environment>('environment', 'env'), children: [] });
    const evidenceDirectory = path.join(h.directory, 'runs', 'run-done', 'case');
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(path.join(evidenceDirectory, 'e1.json'), '{}');
    deleteRun(h.store, 'run-done');
    assert.ok(!h.store.has('run', 'run-done'));
    assert.ok(!h.store.has('run-private', 'run-done'));
    assert.ok(!existsSync(path.join(h.directory, 'runs', 'run-done')), '证据目录应一并删除');
    assert.ok(existsSync(path.join(h.directory, 'credentials', `${ref}.json`)), '环境仍持有该凭证');
  } finally { h.cleanup(); }
});

test('删除不存在的对象返回 404，不静默成功', () => {
  const h = setup();
  try {
    for (const attempt of [() => deleteSystem(h.store, 'missing'), () => deleteEnvironment(h.store, 'missing'), () => deleteImport(h.store, 'missing'), () => deleteRun(h.store, 'missing')]) {
      assert.throws(attempt, (error: Error & { statusCode?: number }) => error.statusCode === 404);
    }
  } finally { h.cleanup(); }
});
