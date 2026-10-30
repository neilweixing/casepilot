import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { metrics, type Environment, type ImportDraft, type Run, type System } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import { confirmImport, createImport, importProblems, parseWorkbook, reviseImport } from './imports.ts';
import { fixtureWorkbook } from './import-fixtures.ts';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';
import { saveEnvironment, publicEnvironment } from './environments.ts';
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
    const confirmed = confirmImport(t.store, draft.id, fixed.revision); assert.ok(confirmed.confirmedAt);
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
    const confirmed = confirmImport(t.store, draft.id, resolved.revision);
    assert.equal(confirmImport(t.store, draft.id, resolved.revision).confirmedAt, confirmed.confirmedAt);
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
    const confirmed = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/confirm`, headers, payload: { revision: 1 } });
    assert.equal(confirmed.statusCode, 200); assert.ok(confirmed.json().confirmedAt);
    const conflict = await app.inject({ method: 'PATCH', url: `/api/imports/${draft.id}`, headers, payload: { revision: 0, cases: draft.cases } });
    assert.equal(conflict.statusCode, 409);
    const split = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/split`, headers, payload: { revision: 1, caseId: draft.cases[0]!.id, stepIndex: 1, expectationIndex: 1 } });
    assert.equal(split.statusCode, 200); assert.equal(split.json().cases.length, 2); assert.equal(split.json().confirmedAt, null);
    const merged = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/merge`, headers, payload: { revision: 2, caseIds: split.json().cases.map((c: { id: string }) => c.id) } });
    assert.equal(merged.statusCode, 200); assert.equal(merged.json().cases.length, 1);
    const reparsed = await app.inject({ method: 'POST', url: `/api/imports/${draft.id}/reparse`, headers, payload: { revision: 3, sheets: ['表单用例'], mappings: draft.mappings } });
    assert.equal(reparsed.statusCode, 200); assert.equal(reparsed.json().revision, 4); assert.equal(reparsed.json().confirmedAt, null);
    assert.equal(reparsed.json().cases[0].steps.length, 3);
    assert.equal((await app.inject({ url: '/assets/../../.env', headers })).statusCode, 404);
  } finally { await app.close(); t.cleanup(); }
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
