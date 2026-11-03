import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { metrics, type Environment, type ImportDraft, type Run, type System } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import { confirmImport, createImport, importProblems, parseWorkbook, reviseImport } from './imports.ts';
import { fixtureWorkbook } from './import-fixtures.ts';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';
import { saveEnvironment, publicEnvironment } from './environments.ts';
import { deleteImport, deleteSystem } from './deletion.ts';
import { executeCase } from './case-agent.ts';
import { htmlReport } from './reports.ts';
import { RunManager } from './runs.ts';
import { parseProcessTable } from './mcp.ts';

function temporary() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'casepilot-p0-'));
  return { directory, store: new Store(directory), cleanup() { this.store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('Excel 别名、列顺序、说明行、多步、合并跨行和多工作表实际解析', async () => {
  const result = await parseWorkbook(await fixtureWorkbook('layouts'), 'samples.xlsx');
  assert.equal(result.sheets.length, 3); assert.equal(result.mappings['表单用例']!.headerRow, 2);
  assert.equal(result.cases.length, 3); assert.equal(result.cases[0]!.steps.length, 3); assert.equal(result.cases[0]!.expectations.length, 2);
  assert.deepEqual(result.cases[0]!.source.rows, [3]); assert.equal(result.cases[0]!.source.fileName, 'samples.xlsx');
  assert.deepEqual(result.cases[1]!.source.rows, [2, 3]); assert.equal(result.cases[1]!.steps.length, 2);
  const selected = await parseWorkbook(await fixtureWorkbook('layouts'), 'samples.xlsx', ['单行']);
  assert.equal(selected.cases.length, 1); assert.equal(selected.cases[0]!.source.sheet, '单行');
});

test('重复编号、空字段、无缓存公式阻止确认；修订保留原文并使确认失效', async () => {
  const t = temporary();
  try {
    const draft = await createImport(t.store, await fixtureWorkbook('problems'), 'problems.xlsx');
    const problems = importProblems(draft); assert.ok(problems.some(p => p.message.includes('重复'))); assert.ok(problems.some(p => p.message.includes('公式')));
    assert.throws(() => confirmImport(t.store, draft.id, draft.revision));
    const fixed = reviseImport(t.store, draft.id, draft.revision, draft.cases.map((c, i) => ({ ...c, excluded: i > 0, duplicateAcknowledged: true })));
    // 确认前必须指定用例集所属系统。
    t.store.put<System>('system', { id: 'system', name: '测试系统' });
    assert.throws(() => confirmImport(t.store, draft.id, fixed.revision), /所属系统/);
    const owned = reviseImport(t.store, draft.id, fixed.revision, fixed.cases, 'system');
    const confirmed = confirmImport(t.store, draft.id, owned.revision); assert.ok(confirmed.confirmedAt);
    const changed = reviseImport(t.store, draft.id, confirmed.revision, confirmed.cases.map(c => ({ ...c, title: c.title + '修订' })));
    assert.equal(changed.confirmedAt, null); assert.equal(changed.revision, confirmed.revision + 1);
    const old = t.store.get<ImportDraft>('import-version', `${draft.id}:${confirmed.revision}`);
    assert.equal(old.cases[0]!.title, confirmed.cases[0]!.title); assert.deepEqual(changed.cases[0]!.source, draft.cases[0]!.source);
    assert.throws(() => reviseImport(t.store, draft.id, 1, changed.cases), /刷新/);
  } finally { t.cleanup(); }
});

test('无效文件和重复列映射有明确错误，不执行输入内容', async () => {
  await assert.rejects(() => parseWorkbook(Buffer.from('run shell'), 'bad.xlsx'), /有效的 xlsx/);
  const bytes = await fixtureWorkbook();
  await assert.rejects(() => parseWorkbook(bytes, 'sample.xlsx', ['表单用例'], { 表单用例: { headerRow: 2, columns: { title: 1, steps: 1, expectations: 2 } } }), /重复映射/);
});

test('排除再恢复或修改无关字段不能抹掉公式问题，须明确人工修正', async () => {
  const t = temporary();
  try {
    const draft = await createImport(t.store, await fixtureWorkbook('problems'), 'sample.xlsx');
    const formula = draft.cases.find(c => c.title === '无缓存公式')!;
    const edited = reviseImport(t.store, draft.id, 1, draft.cases.map(c => ({ ...c, excluded: c.id !== formula.id, title: c.title + '修改', steps: c.id === formula.id ? ['人工填写的步骤'] : c.steps })));
    assert.ok(importProblems(edited).some(i => i.caseId === formula.id && i.message.includes('公式')));
    const resolved = reviseImport(t.store, draft.id, edited.revision, edited.cases.map(c => ({ ...c, issuesResolved: c.id === formula.id })));
    assert.equal(importProblems(resolved).length, 0);
    t.store.put<System>('system', { id: 'system', name: '测试系统' });
    const owned = reviseImport(t.store, draft.id, resolved.revision, resolved.cases, 'system');
    const confirmed = confirmImport(t.store, draft.id, owned.revision);
    assert.equal(confirmImport(t.store, draft.id, owned.revision).confirmedAt, confirmed.confirmedAt);
  } finally { t.cleanup(); }
});

test('环境账号加密保存，响应不返回凭证引用、密码或测试验证码', () => {
  const t = temporary();
  try {
    const sys = t.store.put<System>('system', { id: 'system', name: '测试系统' });
    const env = saveEnvironment(t.store, { systemId: sys.id, name: '环境一', baseURL: 'http://127.0.0.1:4310/demo', username: 'synthetic-user', password: 'synthetic-password', captchaStrategy: 'test-code', captchaCode: 'synthetic-code' });
    const json = JSON.stringify(publicEnvironment(env)); assert.ok(!json.includes('synthetic-password')); assert.ok(!json.includes('synthetic-code')); assert.ok(!json.includes('credentialRef'));
    const files = readdirSync(path.join(t.directory, 'credentials')).filter(f => f.endsWith('.json'));
    assert.ok(files.every(f => !readFileSync(path.join(t.directory, 'credentials', f), 'utf8').includes('synthetic-password')));
    const modified = saveEnvironment(t.store, { ...env, id: env.id, password: '', captchaCode: 'updated-code' }, env.id);
    assert.equal(JSON.parse(t.store.secret(modified.credentialRef)).password, 'synthetic-password');
    assert.equal(JSON.parse(t.store.secret(modified.credentialRef)).captchaCode, 'updated-code');
    const second = saveEnvironment(t.store, { systemId: sys.id, name: '环境二', baseURL: 'http://localhost:4310/demo' });
    assert.notEqual(second.id, env.id); assert.equal(t.store.list<Environment>('environment').length, 2);
  } finally { t.cleanup(); }
});

test('会话失效可控目标在撤销会话后真正拒绝原 Cookie，不只切换页面文字', async () => {
  const t = temporary(), app = createServer(loadConfig({ CASEPILOT_DATA_DIR: t.directory }), t.store);
  const headers = { host: '127.0.0.1:4310' };
  try {
    assert.equal((await app.inject({ url: '/demo/session-expiry', headers })).statusCode, 302);
    const signedIn = await app.inject({ method: 'POST', url: '/demo/login', headers, payload: { username: 'demo-user', password: 'demo-password' } });
    assert.equal(signedIn.statusCode, 200);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!;
    const protectedPage = await app.inject({ url: '/demo/session-expiry', headers: { ...headers, cookie } });
    assert.equal(protectedPage.statusCode, 200); assert.ok(protectedPage.body.includes('if(true)'));
    assert.ok(protectedPage.body.includes('本窗口提交次数'));
    await app.inject({ method: 'POST', url: '/demo/expire', headers: { ...headers, cookie } });
    assert.equal((await app.inject({ url: '/demo/session-expiry', headers: { ...headers, cookie } })).statusCode, 302);
  } finally { await app.close(); t.cleanup(); }
});

test('恢复合成目标每次创建均累计计数，便于识别重复副作用', async () => {
  const t = temporary(), app = createServer(loadConfig({ CASEPILOT_DATA_DIR: t.directory }), t.store);
  try {
    const headers = { host: '127.0.0.1:4310' }, id = '11111111-1111-4111-8111-111111111111';
    assert.equal((await app.inject({ url: `/demo/recovery/${id}/count`, headers })).json().count, 0);
    for (const n of [1, 2]) assert.equal((await app.inject({ method: 'POST', url: `/demo/recovery/${id}/create`, headers })).json().count, n);
    assert.equal((await app.inject({ url: `/demo/recovery/${id}/count`, headers })).json().count, 2);
    assert.equal((await app.inject({ url: '/demo/recovery/invalid', headers })).statusCode, 400);
  } finally { await app.close(); t.cleanup(); }
});

test('数据清理验收目标独立计数，清理可恢复且不清空操作审计', async () => {
  const t = temporary(), app = createServer(loadConfig({ CASEPILOT_DATA_DIR: t.directory }), t.store);
  try {
    const headers = { host: '127.0.0.1:4310' }, id = '22222222-2222-4222-8222-222222222222';
    const post = (action: string) => app.inject({ method: 'POST', url: `/demo/lifecycle/${id}/${action}`, headers });
    assert.equal((await post('create')).json().active, 1);
    assert.deepEqual((await post('clear')).json(), { active: 0, created: 1, clears: 1, retained: 1 });
    assert.deepEqual((await post('restore')).json(), { active: 1, created: 1, clears: 1, retained: 0 });
    assert.equal((await app.inject({ url: `/demo/lifecycle/${id}`, headers })).statusCode, 200);
  } finally { await app.close(); t.cleanup(); }
});

test('真实 API 保持导入门禁，修订冲突返回 409，未验收执行不开放', async () => {
  const t = temporary(), config = loadConfig({ CASEPILOT_DATA_DIR: t.directory }), app = createServer(config, t.store);
  const headers = { host: '127.0.0.1:4310', 'x-casepilot-request': '1' };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/systems', headers: { host: headers.host }, payload: { name: 'X' } })).statusCode, 403);
    const uploaded = await app.inject({ method: 'POST', url: '/api/imports?name=sample.xlsx', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: await fixtureWorkbook() });
    assert.equal(uploaded.statusCode, 200); const draft = uploaded.json<ImportDraft>();
    const result = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: { importId: draft.id, revision: 1, environmentId: 'none' } });
    assert.equal(result.statusCode, 409); assert.ok(result.json().error.includes('下一阶段'));
    config.runnerEnabled = true;
    const unconfirmed = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: { importId: draft.id, revision: 1, environmentId: 'none' } });
    assert.equal(unconfirmed.statusCode, 409); assert.ok(unconfirmed.json().error.includes('尚未确认'));
    config.runnerEnabled = false;
    // 确认门禁：先指定所属系统，无效归属被拒绝。
    const early = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/confirm`, headers, payload: { revision: 1 } });
    assert.equal(early.statusCode, 400); assert.ok(early.json().error.includes('所属系统'));
    const system = await app.inject({ method: 'POST', url: '/api/systems', headers, payload: { name: '测试系统' } });
    assert.equal(system.statusCode, 200); const systemId = system.json().id;
    const invalid = await app.inject({ method: 'PATCH', url: `/api/imports/${draft.id}`, headers, payload: { revision: 1, cases: draft.cases, systemId: 'missing' } });
    assert.equal(invalid.statusCode, 400); assert.ok(invalid.json().error.includes('系统不存在'));
    const owned = await app.inject({ method: 'PATCH', url: `/api/imports/${draft.id}`, headers, payload: { revision: 1, cases: draft.cases, systemId } });
    assert.equal(owned.statusCode, 200); assert.equal(owned.json().systemId, systemId); assert.equal(owned.json().revision, 2); assert.equal(owned.json().confirmedAt, null);
    const confirmed = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/confirm`, headers, payload: { revision: 2 } });
    assert.equal(confirmed.statusCode, 200); assert.ok(confirmed.json().confirmedAt);
    const conflict = await app.inject({ method: 'PATCH', url: `/api/imports/${draft.id}`, headers, payload: { revision: 0, cases: draft.cases } });
    assert.equal(conflict.statusCode, 409);
    const split = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/split`, headers, payload: { revision: 2, caseId: draft.cases[0]!.id, stepIndex: 1, expectationIndex: 1 } });
    assert.equal(split.statusCode, 200); assert.equal(split.json().cases.length, 2); assert.equal(split.json().confirmedAt, null); assert.equal(split.json().systemId, systemId);
    const merged = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/merge`, headers, payload: { revision: 3, caseIds: split.json().cases.map((c: { id: string }) => c.id) } });
    assert.equal(merged.statusCode, 200); assert.equal(merged.json().cases.length, 1); assert.equal(merged.json().systemId, systemId);
    const reparsed = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/reparse`, headers, payload: { revision: 4, sheets: ['表单用例'], mappings: draft.mappings } });
    assert.equal(reparsed.statusCode, 200); assert.equal(reparsed.json().revision, 5); assert.equal(reparsed.json().confirmedAt, null); assert.equal(reparsed.json().systemId, systemId);
    assert.equal(reparsed.json().cases[0].steps.length, 3);
    assert.equal((await app.inject({ url: '/assets/../../.env', headers })).statusCode, 404);
  } finally { await app.close(); t.cleanup(); }
});

test('用例集归属系统：确认门禁、执行环境一致性与删除引用保护', async () => {
  const t = temporary();
  const until = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); } throw new Error('状态转换超时'); };
  try {
    const store = t.store;
    store.put<System>('system', { id: 'sys-a', name: '系统 A' });
    store.put<System>('system', { id: 'sys-b', name: '系统 B' });
    store.put<System>('system', { id: 'sys-clean', name: '无环境系统' });
    const draft = await createImport(store, await fixtureWorkbook(), 'sample.xlsx');
    assert.throws(() => confirmImport(store, draft.id, draft.revision), /所属系统/);
    assert.throws(() => reviseImport(store, draft.id, draft.revision, draft.cases, 'missing'), /系统不存在/);
    const owned = reviseImport(store, draft.id, draft.revision, draft.cases, 'sys-a');
    assert.equal(owned.systemId, 'sys-a'); assert.equal(owned.revision, draft.revision + 1); assert.equal(owned.confirmedAt, null);
    const confirmed = confirmImport(store, draft.id, owned.revision);
    assert.ok(confirmed.confirmedAt);
    assert.equal(store.get<ImportDraft>('import-version', `${draft.id}:${owned.revision}`).systemId, 'sys-a');
    // 无环境系统因持有用例集不能删除；删除用例集后才能删除。
    const spare = await createImport(store, await fixtureWorkbook(), 'spare.xlsx');
    const spareOwned = reviseImport(store, spare.id, spare.revision, spare.cases, 'sys-clean');
    assert.throws(() => deleteSystem(store, 'sys-clean'), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /还有 1 个用例集/.test(error.message));
    deleteImport(store, spareOwned.id);
    assert.equal(deleteSystem(store, 'sys-clean').deleted, 'system');
    // 环境与用例集系统不一致时拒绝创建任务，不产生任何 run 记录。
    const ref = store.password(JSON.stringify({ password: 'synthetic', captchaCode: '' }));
    const envA = store.put<Environment>('environment', { id: 'env-a', systemId: 'sys-a', name: '环境 A', baseURL: 'http://127.0.0.1:4310/demo', loginURL: '', username: 'synthetic', credentialRef: ref, hasPassword: true, captchaCode: '', captchaStrategy: 'none', createdAt: '' });
    store.put('environment', { ...envA, id: 'env-b', systemId: 'sys-b' });
    const model = () => ({ apiKey: 'synthetic-not-used', baseURL: 'http://127.0.0.1', modelId: 'synthetic-not-used', contextWindow: 65536, maxTokens: 4096, input: ['text'] as ('text' | 'image')[], reasoning: false, thinkingLevel: 'off' as const });
    // 合成执行器：落盘最小证据，让每条用例以 PASSED 结束，不触碰真实浏览器。
    const executor: typeof executeCase = async (_config, _model, runId, c, _env, _cred, r) => {
      r.steps[0]!.status = 'DONE'; r.steps[0]!.evidenceIds = ['step'];
      r.evidence.push({ id: 'step', runId, caseId: c.id, stepId: 's1', kind: 'tool', path: 'step.json', timestamp: '', success: true }, { id: 'observation', runId, caseId: c.id, stepId: 'e1', kind: 'observation', path: 'obs.json', timestamp: '', success: true });
      r.assertions.push({ expectationId: 'e1', expected: c.expectations[0]!, actual: '合成状态机输入，不代表真实页面', status: 'PASSED', evidenceIds: ['observation'] });
      r.status = 'PASSED';
    };
    const manager = new RunManager(store, loadConfig({ CASEPILOT_DATA_DIR: t.directory }), { executeCase: executor, loadModel: model });
    try {
      assert.throws(() => manager.create(confirmed.id, owned.revision, 'env-b'), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /其他系统/.test(error.message));
      assert.equal(store.list<Run>('run').length, 0);
      // 旧确认快照没有归属时保持可用，不被新校验卡死。
      store.put('import-version', { id: 'legacy:1', confirmedAt: new Date().toISOString(), cases: [{ ...structuredClone(confirmed.cases[0]!), id: 'legacy-case' }] });
      const legacy = manager.create('legacy', 1, 'env-b');
      await until(() => ['COMPLETED', 'CANCELLED', 'INTERRUPTED', 'ERROR'].includes(store.get<Run>('run', legacy.id).status));
      // 归属与环境一致时正常创建。
      const run = manager.create(confirmed.id, owned.revision, 'env-a');
      assert.equal(run.environment.systemId, 'sys-a');
      await until(() => ['COMPLETED', 'CANCELLED', 'INTERRUPTED', 'ERROR'].includes(store.get<Run>('run', run.id).status));
    } finally { await manager.close(); }
  } finally { t.cleanup(); }
});

test('重启保留草稿并将遗留活动任务标为中断，不自动执行', async () => {
  const t = temporary();
  try {
    const draft = await createImport(t.store, await fixtureWorkbook(), 'sample.xlsx');
    const run = { id: 'interrupted', status: 'RUNNING', results: [{ status: 'RUNNING', steps: [], startedAt: '2026-10-30T00:00:00Z', endedAt: null }, { status: 'PENDING', steps: [], startedAt: null, endedAt: null }], events: [] } as unknown as Run;
    t.store.put('run', run); t.store.close();
    const reopened = new Store(t.directory);
    try {
      new RunManager(reopened, loadConfig({ CASEPILOT_DATA_DIR: t.directory }));
      const recovered = reopened.get<Run>('run', run.id); assert.equal(recovered.status, 'INTERRUPTED'); assert.equal(recovered.results[0]!.status, 'INTERRUPTED'); assert.equal(recovered.results[1]!.status, 'PENDING');
      assert.equal(reopened.get<ImportDraft>('import', draft.id).fileName, 'sample.xlsx');
    } finally { reopened.close(); }
  } finally { t.cleanup(); }
});

test('统计包含全部状态并正确处理零分母，报告不引用外部脚本或 CDN', () => {
  const s = metrics([...Array(8).fill({ status: 'PASSED' }), { status: 'FAILED' }, { status: 'BLOCKED' }]);
  assert.equal(s.passRate, 88.9); assert.equal(s.completionRate, 90); assert.equal(s.progress, 100);
  assert.equal(metrics([]).passRate, null); assert.equal(metrics([{ status: 'ERROR' }]).passRate, null);
  const run = { id: 'r', importId: 'i', revision: 1, environment: { name: '<script>', baseURL: 'http://localhost' }, modelId: 'model', status: 'COMPLETED', createdAt: '', endedAt: null, cases: [], results: [], events: [], reason: '' } as unknown as Run;
  const html = htmlReport(run, '/tmp'); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(!/src="https?:/.test(html)); assert.ok(html.includes('暂无可判定结果'));
});

test('Windows CIM 与 macOS ps 进程清单按各自格式解析', () => {
  assert.deepEqual(parseProcessTable('[{"ProcessId":11,"ParentProcessId":1},{"ProcessId":12,"ParentProcessId":11}]', 'win32'), [[11, 1], [12, 11]]);
  assert.deepEqual(parseProcessTable('{"ProcessId":11,"ParentProcessId":1}', 'win32'), [[11, 1]]);
  assert.deepEqual(parseProcessTable(' 11 1\n 12 11\n', 'darwin'), [[11, 1], [12, 11]]);
});
