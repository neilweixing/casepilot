import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import type { Run } from '../../../packages/contracts/src/p0.ts';
import { loadConfig, redact } from './config.ts';
import { Store } from './storage.ts';
import { RunManager } from './runs.ts';
import { createImport, confirmImport } from './imports.ts';
import { saveEnvironment } from './environments.ts';
import { htmlReport } from './reports.ts';
import { processExists } from './mcp.ts';

const scenario = process.argv.find(v => v.startsWith('--scenario='))?.slice(11) || 'normal';
assert.ok(['normal','retry','exhaust','unreadable'].includes(scenario), '未知图片验证码验收场景');
const base = loadConfig(), checkId = randomUUID(), directory = path.join(base.dataDir, 'captcha-check', `${scenario}-${checkId}`);
const shouldPause = ['exhaust','unreadable'].includes(scenario);
let store: Store | undefined, manager: RunManager | undefined, run: Run | undefined, lock: number | undefined, paused: Run | undefined;
const active = (r: Run) => ['QUEUED','RUNNING','PAUSING','PAUSED','STOPPING'].includes(r.status);
process.once('SIGINT', () => { void manager?.close(); });
try {
  const lockPath = path.join(base.dataDir, 'm1.lock');
  lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid));
  mkdirSync(directory, { recursive: true, mode: 0o700 }); store = new Store(directory);
  store.put('system', { id: 'synthetic', name: '普通图片验证码合成系统' });
  const env = saveEnvironment(store, { systemId: 'synthetic', name: `图片验证码 ${scenario}`, baseURL: `${base.origin}/demo/image-captcha/${checkId}/protected`, loginURL: `${base.origin}/demo/image-captcha/${checkId}/login/${scenario}`, username: 'demo-user', password: 'demo-password', captchaStrategy: 'image' });
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('普通图片验证码');
  sheet.addRow(['用例编号','用例标题','操作步骤','预期结果']);
  sheet.addRow(['CAP-001','图片验证码认证后检查受保护页面','检查当前页面展示“验证码登录成功”标题','页面可见“验证码登录成功”标题']);
  if (shouldPause) sheet.addRow(['CAP-002','认证故障后不应开始业务','打开选定测试环境页面\n点击“业务提交”','页面显示“业务已提交”']);
  const draft = await createImport(store, Buffer.from(await book.xlsx.writeBuffer()), `image-captcha-${scenario}.xlsx`); confirmImport(store, draft.id, draft.revision);
  manager = new RunManager(store, { ...base, dataDir: directory, runnerEnabled: true, ...(['retry','exhaust'].includes(scenario) ? { timeoutMs: 900000 } : {}) });
  run = manager.create(draft.id, draft.revision, env.id);
  console.log(`图片验证码验收 ${scenario}：${run.id}；独立目录 ${path.relative(base.dataDir, directory)}`);
  let seq = 0; const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    run = store.get<Run>('run', run.id);
    for (const e of run.events.filter(e => e.seq > seq)) { console.log(`${e.seq} ${e.message}`); seq = e.seq; }
    if (!active(run)) break;
    if (run.status === 'PAUSED') {
      paused = structuredClone(run); writeFileSync(path.join(directory, 'paused.json'), JSON.stringify(paused, null, 2), { mode: 0o600 });
      manager.control(run.id, 'stop');
    }
    await delay(500);
  }
  if (shouldPause) {
    assert.ok(paused, '识别失败或上限耗尽应暂停整批');
    const snapshot = paused;
    assert.deepEqual(snapshot.results.map(r => r.status), ['PENDING','PENDING']);
    assert.ok(snapshot.results.every(r => r.steps.every(s => s.status === 'PENDING')));
    assert.equal(snapshot.events.filter(e => e.type === 'case_started' && e.caseId === snapshot.cases[1]!.id).length, 0);
    assert.equal(run.status, 'CANCELLED');
  } else { assert.equal(paused, undefined); assert.equal(run.status, 'COMPLETED'); assert.deepEqual(run.results.map(r => r.status), ['PASSED']); }
  const response = await fetch(`${base.origin}/demo/image-captcha/${checkId}/count`); assert.ok(response.ok);
  const counts = await response.json() as { issued: number; refreshes: number; submissions: number; correct: number; successes: number; businessWrites: number };
  assert.equal(counts.businessWrites, 0); assert.equal(counts.successes, shouldPause ? 0 : 1);
  assert.ok(counts.submissions <= base.captchaAttempts && counts.refreshes <= base.captchaAttempts - 1);
  if (scenario === 'normal') assert.deepEqual([counts.submissions,counts.refreshes,counts.correct], [1,0,1]);
  if (scenario === 'retry') assert.deepEqual([counts.submissions,counts.refreshes,counts.correct], [2,1,2]);
  if (scenario === 'exhaust') { assert.equal(counts.submissions, base.captchaAttempts); assert.match(paused!.reason, /上限|耗尽|次数|失败/); }
  if (scenario === 'unreadable') assert.equal(counts.submissions, 0, '不可读图片不得猜测提交');
  const tools = run.results.flatMap(r => r.evidence.filter(e => e.kind === 'tool').map(e => JSON.parse(readFileSync(path.join(directory, 'runs', run!.id, e.path), 'utf8'))));
  const captures = tools.filter(e => e.name === 'captcha_capture'), submits = tools.filter(e => e.name === 'captcha_submit');
  assert.equal(submits.length, counts.submissions); assert.ok(captures.length >= submits.length && captures.length <= base.captchaAttempts);
  const info = store.get<{ pid?: number; children: number[] }>('run-private', run.id);
  assert.ok(![info.pid,...info.children].some(processExists)); assert.equal(existsSync(path.join(directory, 'm1.lock')), false);
  writeFileSync(path.join(directory, 'report.html'), htmlReport(run, directory, [process.env.CASEPILOT_API_KEY || '', 'demo-user', 'demo-password']), { mode: 0o600 });
  const summary = { scenario, checkId, runId: run.id, results: run.results.map(r => r.status), paused: paused?.reason || null, counts, captures: captures.length, submissions: submits.length, imageDeliveredBeforeSubmission: true, released: true, checkedAt: new Date().toISOString() };
  writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`验收通过：${shouldPause ? '整批暂停，后续业务未开始' : 'PASSED'}；图片识别 ${captures.length} 次、登录提交 ${counts.submissions} 次；工具已释放`);
} catch (error) {
  console.error('图片验证码验收未通过：' + redact(error instanceof Error ? error.message : '未知异常', [process.env.CASEPILOT_API_KEY || '', 'demo-user', 'demo-password'])); process.exitCode = 1;
} finally {
  await manager?.close();
  let released = true;
  if (store && run) { const info = store.get<{ pid?: number; children: number[] }>('run-private', run.id); released = ![info.pid,...info.children].some(processExists); }
  store?.close();
  if (lock !== undefined) {
    closeSync(lock); const file = path.join(base.dataDir, 'm1.lock');
    if (released && existsSync(file) && readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file);
    else { process.exitCode = 1; console.error('工具进程尚未释放或锁归属变化，共享占用保留'); }
  }
}
