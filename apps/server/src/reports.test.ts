import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { caseStatuses, metrics, type CaseStatus, type Environment, type Run, type RunEvidence } from '../../../packages/contracts/src/p0.ts';
import { htmlReport } from './reports.ts';
import { Store } from './storage.ts';
import { createServer } from './server.ts';
import { loadConfig } from './config.ts';

function sample(statuses: CaseStatus[]): Run {
  return {
    id: 'report-run', importId: 'confirmed-import', revision: 7,
    environment: { id: 'env', systemId: 'sys', name: '报告边界样本', baseURL: 'https://example.invalid/test' },
    modelId: 'synthetic-model', status: 'COMPLETED', reason: '', createdAt: '2026-10-30T01:00:00Z', endedAt: '2026-10-30T01:02:00Z', events: [],
    cases: statuses.map((_s, i) => ({ id: `c${i}`, externalId: `TC-${i}`, module: '表单', title: `样本 ${i}`, priority: 'P0', preconditions: ['已有测试数据'], steps: ['打开测试页面'], expectations: ['标题可见'], source: { fileName: 'confirmed.xlsx', sheet: '用例', rows: [i + 2], original: ['原始用例内容'] }, excluded: false, duplicateAcknowledged: false })),
    results: statuses.map((status, i) => ({ caseId: `c${i}`, status, phase: 'FINALIZING', reason: '执行说明', steps: [{ id: 's1', text: '打开测试页面', status: status === 'PENDING' ? 'PENDING' : 'DONE', evidenceIds: [] }], assertions: [], evidence: [], startedAt: '2026-10-30T01:00:00Z', endedAt: '2026-10-30T01:01:00Z' })),
  };
}
function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), 'casepilot-report-'));
  mkdirSync(path.join(directory, 'runs/report-run/c0'), { recursive: true });
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function addEvidence(run: Run, id: string, kind: RunEvidence['kind'], file = `c0/${id}.json`) {
  const e: RunEvidence = { id, kind, path: file, runId: run.id, caseId: 'c0', stepId: 'e1', timestamp: run.createdAt, success: true };
  run.results[0]!.evidence.push(e); return e;
}

test('报告与指标覆盖 8/1/1、全部状态、零分母与进行中快照', () => {
  const run = sample([...Array<CaseStatus>(8).fill('PASSED'), 'FAILED', 'BLOCKED']);
  const html = htmlReport(run, '/unused');
  assert.match(html, /data-metric="passRate">88\.9%/); assert.match(html, /data-metric="completionRate">90%/); assert.match(html, /data-metric="progress">100%/);
  const mixed = sample([...caseStatuses]); const stats = metrics(mixed.results);
  assert.equal(Object.values(stats.counts).reduce((sum, n) => sum + n, 0), 8);
  assert.deepEqual([stats.passRate, stats.completionRate, stats.progress], [50, 25, 75]);
  const mixedHtml = htmlReport(mixed, '/unused');
  for (const status of caseStatuses) assert.ok(mixedHtml.includes(`data-count="${status}"`));
  for (const statuses of [[], ['BLOCKED'], ['ERROR'], ['BLOCKED', 'ERROR']] as CaseStatus[][]) {
    const empty = sample(statuses), stats = metrics(empty.results);
    assert.equal(stats.passRate, null); assert.equal(stats.completionRate, 0);
    assert.ok(htmlReport(empty, '/unused').includes('暂无可判定结果'));
  }
  run.status = 'PAUSED'; assert.ok(htmlReport(run, '/unused').includes('执行中快照'));
});

test('离线报告内嵌截图、失败工具与观察，步骤和预期链接到对应归档', () => {
  const t = temporary(), run = sample(['FAILED']);
  try {
    const observation = addEvidence(run, 'observed', 'observation');
    const tool = addEvidence(run, 'failed-tool', 'tool'); tool.success = false;
    const shot = addEvidence(run, 'image', 'screenshot', 'c0/image.png');
    writeFileSync(path.join(t.directory, 'runs/report-run', observation.path), JSON.stringify({ text: '实际标题为其他内容', visible: true }));
    writeFileSync(path.join(t.directory, 'runs/report-run', tool.path), JSON.stringify({ name: 'browser_click', isError: true, error: 'locator not found' }));
    // 有效的 1×1 PNG；只用于归档结构检查，不冒充浏览器截图。
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    writeFileSync(path.join(t.directory, 'runs/report-run', shot.path), Buffer.from(png, 'base64'));
    run.results[0]!.steps[0]!.evidenceIds = [tool.id];
    run.results[0]!.assertions.push({ expectationId: 'e1', expected: '标题可见', actual: '实际标题为其他内容', status: 'FAILED', evidenceIds: [observation.id, shot.id] });
    const original = structuredClone(run), html = htmlReport(run, t.directory);
    assert.ok(html.includes(`src="data:image/png;base64,${png}"`));
    assert.ok(html.includes('locator not found')); assert.ok(html.includes('调用失败'));
    for (const id of ['evidence-0-0', 'evidence-0-1', 'evidence-0-2']) { assert.ok(html.includes(`href="#${id}"`)); assert.ok(html.includes(`id="${id}"`)); }
    for (const value of ['confirmed.xlsx', '原始行 2', 'revision 7', '已有测试数据', run.createdAt, '原始用例内容', '未生成独立根因分析']) assert.ok(html.includes(value));
    assert.ok(!/<script|<link|<iframe|\son\w+=|(?:src|href)="(?:https?:|\/api)/i.test(html));
    assert.ok(html.includes("default-src 'none'")); assert.deepEqual(run, original);
  } finally { t.cleanup(); }
});

test('报告对元数据、来源、事件和原始证据转义并再次脱敏', () => {
  const t = temporary(), run = sample(['ERROR']);
  try {
    const attack = '</style><script>alert(1)</script><img src=x onerror=alert(1)>', secret = 'report-synthetic-secret';
    run.cases[0]!.title = attack; run.cases[0]!.source.original = [attack, secret];
    run.events.push({ seq: 1, timestamp: run.createdAt, type: 'note', message: secret }); run.reason = secret;
    const e = addEvidence(run, 'private', 'tool');
    writeFileSync(path.join(t.directory, 'runs/report-run', e.path), JSON.stringify({ message: `${attack} ${secret} Bearer opaque-bearer-value`, nested: { Cookie: 'session=opaque-cookie-value', access_token: 'opaque-access-value', password: 'opaque-password-value' }, url: 'https://example.invalid/?token=opaque-query-value' }));
    const html = htmlReport(run, t.directory, [secret]);
    for (const raw of [secret, 'opaque-bearer-value', 'opaque-cookie-value', 'opaque-access-value', 'opaque-password-value', 'opaque-query-value']) assert.ok(!html.includes(raw));
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(html.includes('[REDACTED]'));
  } finally { t.cleanup(); }
});

test('缺失、越界、符号链接、类型错误与跨用例证据明确提示，不改原结果', () => {
  const t = temporary(), run = sample(['PASSED']);
  try {
    writeFileSync(path.join(t.directory, 'outside.json'), JSON.stringify({ value: 'outside-private-marker' }));
    addEvidence(run, 'missing', 'observation');
    addEvidence(run, 'outside', 'tool', '../../outside.json');
    if (process.platform !== 'win32') {
      symlinkSync(path.join(t.directory, 'outside.json'), path.join(t.directory, 'runs/report-run/c0/link.json'));
      addEvidence(run, 'link', 'tool', 'c0/link.json');
    }
    writeFileSync(path.join(t.directory, 'runs/report-run/c0/not-image.png'), 'invalid-image-marker');
    addEvidence(run, 'not-image', 'screenshot', 'c0/not-image.png');
    const foreign = addEvidence(run, 'foreign', 'observation', '../../outside.json'); foreign.caseId = 'other';
    const html = htmlReport(run, t.directory);
    assert.equal((html.match(/证据文件缺失或不可安全读取/g) || []).length, run.results[0]!.evidence.length);
    assert.ok(!html.includes('outside-private-marker')); assert.ok(!html.includes('invalid-image-marker'));
    assert.equal(run.results[0]!.status, 'PASSED');
  } finally { t.cleanup(); }
});

test('报告 API 与详情/事件使用同一统计数据和私有凭证脱敏，文件名区分任务', async () => {
  const t = temporary(), store = new Store(t.directory), config = loadConfig({ CASEPILOT_DATA_DIR: t.directory }), app = createServer(config, store);
  const run = sample(['FAILED']), secret = 'report-api-private-password';
  try {
    const ref = store.password(JSON.stringify({ password: secret, captchaCode: '' }));
    const env = { id: 'env', username: 'report-private-user', credentialRef: ref } as Environment;
    store.put('run-private', { id: run.id, environment: env, credentialRef: ref, children: [] });
    run.reason = secret; run.events.push({ seq: 1, timestamp: run.createdAt, type: 'note', message: secret });
    const e = addEvidence(run, 'legacy', 'tool');
    writeFileSync(path.join(t.directory, 'runs/report-run', e.path), JSON.stringify({ legacy: secret }));
    store.put('run', run);
    const options = { headers: { host: '127.0.0.1:4310' } };
    const detail = await app.inject({ ...options, url: `/api/runs/${run.id}` });
    const report = await app.inject({ ...options, url: `/api/runs/${run.id}/report.html` });
    const preview = await app.inject({ ...options, url: `/api/runs/${run.id}/report` });
    const events = await app.inject({ ...options, url: `/api/runs/${run.id}/events` });
    const archived = await app.inject({ ...options, url: `/api/runs/${run.id}/evidence/${e.id}` });
    assert.equal(report.statusCode, 200); assert.match(String(report.headers['content-disposition']), /casepilot-report-run\.html/);
    assert.equal(preview.statusCode, 200); assert.equal(preview.headers['content-disposition'], undefined);
    assert.deepEqual(detail.json().metrics, metrics(run.results));
    assert.ok(report.body.includes('data-metric="passRate">0%')); assert.ok(report.body.includes('data-metric="completionRate">100%'));
    assert.equal(archived.statusCode, 200);
    for (const response of [detail, report, preview, events, archived]) { assert.ok(!response.body.includes(secret)); assert.ok(response.body.includes('[REDACTED]')); }
  } finally { await app.close(); t.cleanup(); }
});
