import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { McpClient, type McpRequestOptions } from '@earendil-works/pi-mcp';
import { loadConfig } from './config.ts';
import { executeCase } from './case-agent.ts';
import { Store } from './storage.ts';
import { createImport, confirmImport } from './imports.ts';
import { saveEnvironment } from './environments.ts';
import { RunManager } from './runs.ts';
import { htmlReport } from './reports.ts';
import type { Run } from '../../../packages/contracts/src/p0.ts';
import { processExists } from './mcp.ts';

// 验收专用的调用层故障注入。HTTP、模型工具、环境变量和上传文件均不能启用此注入。
const scenario = process.argv.find(v => v.startsWith('--scenario='))?.slice(11) || 'recover';
assert.ok(['recover', 'exhaust', 'uncertain', 'time-limit'].includes(scenario), '未知恢复验收场景');
const base = loadConfig(), checkId = randomUUID(), directory = path.join(base.dataDir, 'recovery-check', `${scenario}-${checkId}`);
const injections: { kind: string; at: number; target?: string; nativeAcknowledged?: boolean }[] = [];
let injected = 0, clicks = 0;
class FaultClient extends McpClient {
  override async callTool(name: string, args: Record<string, unknown> = {}, options?: McpRequestOptions) {
    if (scenario !== 'uncertain' && name === 'browser_evaluate' && String(args.function).includes('parts.unshift') && (scenario !== 'recover' || injected === 0)) {
      injected++;
      // 让真实 MCP 解析一个不存在的目标，确实在发送业务动作之前失败；原始调用记录保留修改后的参数。
      args.target = '#casepilot-injected-stale-target';
      injections.push({ kind: 'native-missing-target', at: Date.now(), target: String(args.target) });
    }
    const result = await super.callTool(name, args, options);
    if (name === 'browser_click') {
      clicks++;
      if (scenario === 'uncertain' && !result.isError && injected === 0) {
        injected++; injections.push({ kind: 'lost-reply-after-native-click', at: Date.now(), target: String(args.target), nativeAcknowledged: true });
        throw new Error('验收注入：真实点击已完成，但执行器没有收到回执');
      }
    }
    return result;
  }
}
let store: Store | undefined, manager: RunManager | undefined, run: Run | undefined, lock: number | undefined;
const active = (r: Run) => ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'].includes(r.status);
process.once('SIGINT', () => { void manager?.close(); });
try {
  lock = openSync(path.join(base.dataDir, 'm1.lock'), 'wx', 0o600); writeFileSync(lock, String(process.pid));
  mkdirSync(directory, { recursive: true, mode: 0o700 }); store = new Store(directory);
  store.put('system', { id: 'synthetic', name: 'M4 恢复合成系统' });
  const config = { ...base, dataDir: directory, runnerEnabled: true, ...(scenario === 'exhaust' ? { stepRecoveryTimeoutMs: 300000 } : scenario === 'time-limit' ? { stepRecoveryTimeoutMs: 1000 } : {}) };
  const env = saveEnvironment(store, { systemId: 'synthetic', name: `M4 恢复 ${scenario}`, baseURL: `${base.origin}/demo/recovery/${checkId}`, captchaStrategy: 'none' });
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('恢复边界');
  sheet.addRow(['用例编号', '用例标题', '操作步骤', '预期结果']);
  sheet.addRow(['REC-001', '创建记录并验证一次提交', '打开选定测试环境页面\n点击一次“创建记录”按钮', '页面显示“创建完成”\n页面显示“本窗口提交次数：1”']);
  sheet.addRow(['REC-002', '前条异常后继续下一条', '打开选定测试环境页面', '页面可见“恢复验收表单”标题']);
  const draft = await createImport(store, Buffer.from(await book.xlsx.writeBuffer()), 'm4-recovery.xlsx');
  confirmImport(store, draft.id, draft.revision);
  manager = new RunManager(store, config, { executeCase: async (cfg, model, runId, c, environment, credential, result, control) => {
    const client = c.externalId === 'REC-001' ? new FaultClient({ name: 'casepilot-recovery-check', version: '1', requestTimeoutMs: 15000 }) : undefined;
    return executeCase(cfg, model, runId, c, environment, credential, result, control, client);
  } });
  run = manager.create(draft.id, draft.revision, env.id);
  console.log(`恢复验收 ${scenario}：${run.id}；独立目录 ${path.relative(base.dataDir, directory)}`);
  let seq = 0; const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    run = store.get<Run>('run', run.id);
    for (const e of run.events.filter(e => e.seq > seq)) { console.log(`${e.seq} ${e.message}`); seq = e.seq; }
    if (!active(run)) break;
    if (run.status === 'PAUSED') throw new Error('不应发生全局环境暂停：' + run.reason);
    await delay(500);
  }
  assert.equal(run.status, 'COMPLETED');
  assert.deepEqual(run.results.map(r => r.status), [scenario === 'recover' ? 'PASSED' : 'ERROR', 'PASSED']);
  const first = run.results[0]!;
  assert.equal(run.events.filter(e => e.type === 'case_started' && e.caseId === first.caseId).length, 1);
  const counts = await fetch(`${base.origin}/demo/recovery/${checkId}/count`).then(r => r.json()) as { count: number };
  assert.equal(counts.count, ['recover', 'uncertain'].includes(scenario) ? 1 : 0);
  assert.equal(clicks, ['recover', 'uncertain'].includes(scenario) ? 1 : 0);
  if (scenario === 'recover') assert.equal(injected, 1);
  if (scenario === 'exhaust') { assert.equal(injected, 3); assert.match(first.reason, /恢复次数已耗尽/); }
  if (scenario === 'time-limit') {
    assert.equal(injected, 1); assert.match(first.reason, /恢复时间已耗尽/);
    assert.ok(Date.parse(first.endedAt!) - injections[0]!.at < 20000, '时间预算达到后应及时收尾');
  }
  if (scenario === 'uncertain') {
    assert.equal(injected, 1); assert.match(first.reason, /结果不确定/); assert.equal(first.steps[1]!.status, 'UNCERTAIN');
    const snapshots = first.evidence.filter(e => e.kind === 'tool').map(e => JSON.parse(readFileSync(path.join(directory, 'runs', run!.id, e.path), 'utf8'))).filter(e => e.name === 'browser_snapshot');
    assert.ok(snapshots.some(e => JSON.stringify(e).includes('本窗口提交次数：1')), '不确定结果必须保留真实只读现场');
  }
  const info = store.get<{ pid?: number; children: number[] }>('run-private', run.id);
  assert.ok(![info.pid, ...info.children].some(processExists));
  assert.equal(existsSync(path.join(directory, 'm1.lock')), false);
  const summary = { scenario, checkId, runId: run.id, results: run.results.map(r => r.status), injections, nativeClicks: clicks, targetCount: counts.count, recoveryEvents: run.events.filter(e => e.message.includes('定位恢复')), metrics: run.results.map(r => ({ status: r.status, reason: r.reason, endedAt: r.endedAt })), released: true, checkedAt: new Date().toISOString() };
  writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  writeFileSync(path.join(directory, 'report.html'), htmlReport(run, directory, [process.env.CASEPILOT_API_KEY || '']), { mode: 0o600 });
  console.log(`验收通过：${summary.results.join('、')}；真实创建 ${counts.count} 次；浏览器已释放`);
} catch (error) {
  console.error('恢复验收未通过：' + (error instanceof Error ? error.message : '未知异常')); process.exitCode = 1;
} finally {
  await manager?.close();
  if (existsSync(directory)) writeFileSync(path.join(directory, 'injections.json'), JSON.stringify(injections, null, 2), { mode: 0o600 });
  if (store && run) {
    const info = store.get<{ pid?: number; children: number[] }>('run-private', run.id);
    if ([info.pid, ...info.children].some(processExists)) { process.exitCode = 1; console.error('工具进程未释放，共享锁保留'); lock = undefined; }
  }
  store?.close();
  if (lock !== undefined) { closeSync(lock); unlinkSync(path.join(base.dataDir, 'm1.lock')); }
}
