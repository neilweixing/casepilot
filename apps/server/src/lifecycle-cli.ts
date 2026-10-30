import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type Serializable } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { McpClient, type McpRequestOptions } from '@earendil-works/pi-mcp';
import type { Run } from '../../../packages/contracts/src/p0.ts';
import { loadConfig, projectRoot, redact } from './config.ts';
import { Store } from './storage.ts';
import { RunManager } from './runs.ts';
import { executeCase } from './case-agent.ts';
import { createImport, confirmImport } from './imports.ts';
import { saveEnvironment } from './environments.ts';
import { descendantPids, processExists } from './mcp.ts';
import { createServer } from './server.ts';

const base = loadConfig(), worker = process.argv.find(v => v.startsWith('--worker='))?.slice(9);
const scenario = process.argv.find(v => v.startsWith('--scenario='))?.slice(11) || 'graceful';
const active = (r: Run) => ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'].includes(r.status);
const send = (message: Serializable) => new Promise<void>((resolve, reject) => { if (!process.send) return reject(new Error('缺少验收 IPC')); process.send(message, undefined, {}, error => error ? reject(error) : resolve()); });

async function executeWorker(key: string) {
  assert.match(key, /^(graceful|crash|cleanup)-[0-9a-f-]{36}$/);
  const directory = path.join(base.dataDir, 'lifecycle-check', key), config = { ...base, dataDir: directory, runnerEnabled: true };
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as { scenario: string; importId: string; revision: number; environmentId: string; checkId: string };
  const store = new Store(directory); let closing: Promise<void> | undefined, manager: RunManager;
  class CheckpointClient extends McpClient {
    private held = false;
    override async callTool(name: string, args: Record<string, unknown> = {}, options?: McpRequestOptions) {
      const result = await super.callTool(name, args, options);
      if (name !== 'browser_click' || result.isError || this.held) return result;
      this.held = true;
      try {
        let text = '';
        for (let i = 0; i < 20; i++) {
          const snapshot = await super.callTool('browser_snapshot', {});
          text = snapshot.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          if (text.includes('当前记录数：1')) break;
          await delay(100);
        }
        assert.ok(text.includes('当前记录数：1'), '中断前必须有真实创建后的页面现场');
        const shot = await super.callTool('browser_take_screenshot', { type: 'png', fullPage: false, scale: 'css' });
        const image = shot.content.find(c => c.type === 'image');
        assert.ok(image?.type === 'image' && image.mimeType === 'image/png');
        writeFileSync(path.join(directory, 'checkpoint.png'), Buffer.from(image.data, 'base64'), { mode: 0o600 });
        writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify({ text, nativeClickAcknowledged: true, note: '验收侧中断前现场，不作为预期通过依据' }, null, 2), { mode: 0o600 });
        await send({ type: 'checkpoint' });
      } catch (error) { await send({ type: 'probe-error', message: error instanceof Error ? error.message : '现场采集失败' }); throw error; }
      // 回执暂存于验收层，生产执行器仍处于 SENT；父进程随后关闭或终止此独立子进程。
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('验收子进程正在退出，回执未交付'));
        options?.signal?.addEventListener('abort', abort, { once: true }); if (options?.signal?.aborted) abort();
      });
      return result;
    }
  }
  manager = new RunManager(store, config, { executeCase: async (cfg, model, runId, c, environment, credential, result, control) => {
    const client = manifest.scenario !== 'cleanup' && c.externalId === 'LIFE-002' ? new CheckpointClient({ name: 'casepilot-lifecycle-check', version: '1', requestTimeoutMs: 15000 }) : undefined;
    return executeCase(cfg, model, runId, c, environment, credential, result, control, client);
  } });
  process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') closing ||= manager.close(); });
  process.once('SIGTERM', () => { closing ||= manager.close(); });
  try {
    const run = manager.create(manifest.importId, manifest.revision, manifest.environmentId);
    await send({ type: 'started', runId: run.id });
    let seq = 0; const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      const value = store.get<Run>('run', run.id);
      for (const e of value.events.filter(e => e.seq > seq)) { console.log(`${e.seq} ${e.message}`); seq = e.seq; }
      if (!active(value)) break;
      if (value.status === 'PAUSED') throw new Error('验收目标意外暂停');
      await delay(300);
    }
    await closing;
    await send({ type: 'done', runId: run.id });
  } finally { await manager.close(); store.close(); if (process.connected) process.disconnect(); }
}

async function verifyScenario() {
  assert.ok(['graceful', 'crash', 'cleanup'].includes(scenario), '未知中断验收场景');
  const checkId = randomUUID(), key = `${scenario}-${checkId}`, directory = path.join(base.dataDir, 'lifecycle-check', key);
  let lock: number | undefined, child: ChildProcess | undefined, childClosed = false, owned: number[] = [], store: Store | undefined;
  const lockPath = path.join(base.dataDir, 'm1.lock');
  try {
    lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid));
    mkdirSync(directory, { recursive: true, mode: 0o700 }); store = new Store(directory);
    store.put('system', { id: 'synthetic', name: 'M4 中断合成系统' });
    const env = saveEnvironment(store, { systemId: 'synthetic', name: `M4 ${scenario}`, baseURL: `${base.origin}/demo/lifecycle/${checkId}`, captchaStrategy: 'none' });
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('中断与清理');
    sheet.addRow(['用例编号', '用例标题', '操作步骤', '预期结果']);
    if (scenario === 'cleanup') sheet.addRow(['LIFE-CLEAR', '按明确步骤清理本次记录', '打开选定测试环境页面\n点击一次“创建记录”\n点击一次“清理本次记录”', '页面显示“当前记录数：0”\n页面显示“清理次数：1”\n页面显示“可恢复记录数：1”']);
    else {
      sheet.addRow(['LIFE-001', '已完成结果必须保留', '打开选定测试环境页面', '页面可见“中断与数据保留验收”标题']);
      sheet.addRow(['LIFE-002', '创建期间中断不重放', '打开选定测试环境页面\n点击一次“创建记录”', '页面显示“当前记录数：1”']);
      sheet.addRow(['LIFE-003', '中断后不应开始', '打开选定测试环境页面\n点击一次“创建记录”', '页面显示“当前记录数：2”']);
    }
    const draft = await createImport(store, Buffer.from(await book.xlsx.writeBuffer()), `m4-${scenario}.xlsx`); confirmImport(store, draft.id, draft.revision);
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ scenario, checkId, importId: draft.id, revision: draft.revision, environmentId: env.id }, null, 2), { mode: 0o600 });
    store.close(); store = undefined;
    child = spawn(process.execPath, ['--env-file-if-exists=.env', fileURLToPath(import.meta.url), `--worker=${key}`], { cwd: projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout!.on('data', data => process.stdout.write(data)); child.stderr!.on('data', data => process.stderr.write(data));
    let runId = '', readyReached = false, checkpoint!: () => void, fail!: (error: Error) => void, timer: ReturnType<typeof setTimeout>;
    const ready = new Promise<void>((resolve, reject) => { checkpoint = () => { readyReached = true; resolve(); }; fail = reject; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once('error', error => { fail(error); reject(error); });
      child!.once('close', (code, signal) => { childClosed = true; resolve({ code, signal }); if (!readyReached) fail(new Error('未到达验收检查点就结束')); });
    });
    child.on('message', message => {
      const m = message as { type: string; runId?: string; message?: string };
      if (m.type === 'started') { runId = m.runId!; console.log(`中断验收 ${scenario}：${runId}；目录 ${key}`); }
      if (m.type === 'checkpoint' || scenario === 'cleanup' && m.type === 'done') checkpoint();
      if (m.type === 'probe-error') fail(new Error(m.message));
    });
    timer = setTimeout(() => fail(new Error('等待真实验收检查点超时')), 15 * 60 * 1000);
    try { await ready; } finally { clearTimeout(timer); }
    assert.ok(runId);
    let before: Run | undefined;
    if (scenario !== 'cleanup') {
      const db = new DatabaseSync(path.join(directory, 'casepilot.sqlite'), { readOnly: true });
      before = JSON.parse(db.prepare("SELECT body FROM documents WHERE kind='run' AND id=?").get(runId)!.body as string); db.close();
      assert.deepEqual(before!.results.map(r => r.status), ['PASSED', 'RUNNING', 'PENDING']);
      assert.equal(before!.results[1]!.steps[1]!.status, 'SENT');
      writeFileSync(path.join(directory, 'before-interruption.json'), JSON.stringify(before, null, 2), { mode: 0o600 });
      owned = descendantPids(child.pid);
      if (scenario === 'crash') child.kill('SIGKILL');
      else child.send({ type: 'shutdown' });
    }
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([exited, new Promise<never>((_, reject) => { exitTimer = setTimeout(() => reject(new Error('验收子进程未按时退出')), 20000); })]).finally(() => clearTimeout(exitTimer));
    if (scenario === 'crash') assert.equal(outcome.signal, 'SIGKILL'); else assert.equal(outcome.code, 0);
    store = new Store(directory); const config = { ...base, dataDir: directory, runnerEnabled: true };
    const firstRecovery = new RunManager(store, config);
    const remainingAtRecovery = owned.filter(processExists);
    if (remainingAtRecovery.length) assert.throws(() => firstRecovery.create('not-confirmed', 1, env.id), /占用|释放/);
    // 只处理本次活着时记录到的自建子进程家族；生产恢复器不会杀死归属不明的 PID。
    for (const pid of [...remainingAtRecovery].reverse()) if (processExists(pid)) try { process.kill(pid, 'SIGTERM'); } catch { /* 进程可能已自然退出。 */ }
    for (let i = 0; i < 100 && owned.some(processExists); i++) await delay(50);
    assert.ok(!owned.some(processExists), '本次验收工具进程必须释放');
    assert.throws(() => firstRecovery.create('not-confirmed', 1, env.id), /尚未确认/);
    const restored = store.get<Run>('run', runId);
    if (scenario === 'cleanup') assert.deepEqual(restored.results.map(r => r.status), ['PASSED']);
    else {
      assert.equal(restored.status, 'INTERRUPTED');
      assert.deepEqual(restored.results.map(r => r.status), ['PASSED', 'INTERRUPTED', 'PENDING']);
      assert.deepEqual(restored.results[0], before!.results[0]);
      assert.equal(restored.results[1]!.steps[1]!.status, 'UNCERTAIN');
      assert.equal(restored.events.filter(e => e.type === 'case_started' && e.caseId === restored.cases[2]!.id).length, 0);
      assert.throws(() => firstRecovery.control(runId, 'resume'), /不能操作/);
    }
    // 使用实际 API 注册与报告代码读取重开的数据，不启动第二个 HTTP 服务。
    const app = createServer(config, store), headers = { host: `127.0.0.1:${base.port}` };
    try {
      const detail = await app.inject({ url: `/api/runs/${runId}`, headers }); assert.equal(detail.statusCode, 200);
      const historical = detail.json<Run>(); assert.deepEqual(historical.results, restored.results);
      const report = await app.inject({ url: `/api/runs/${runId}/report.html`, headers }); assert.equal(report.statusCode, 200);
      writeFileSync(path.join(directory, 'report.html'), report.body, { mode: 0o600 });
      await delay(2000);
      assert.deepEqual(store.get<Run>('run', runId), restored, '查看历史不能自动推进任务');
      const counts = await fetch(`${base.origin}/demo/lifecycle/${checkId}/count`).then(r => r.json());
      assert.deepEqual(counts, scenario === 'cleanup' ? { created: 1, active: 0, clears: 1, retained: 1 } : { created: 1, active: 1, clears: 0, retained: 0 });
      const summary = { scenario, checkId, runId, childExit: outcome, results: restored.results.map(r => r.status), counts, orphanToolsAtRecovery: remainingAtRecovery.length, released: true, historyUnchanged: true, checkedAt: new Date().toISOString() };
      writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
      console.log(`验收通过：${summary.results.join('、')}；创建 ${counts.created} 次，清理 ${counts.clears} 次；历史未重放，工具已释放`);
    } finally { await app.close(); store = undefined; }
  } finally {
    if (child && !childClosed) {
      owned = [...new Set([...owned, ...descendantPids(child.pid)])];
      child.kill('SIGTERM');
      for (let i = 0; i < 240 && !childClosed; i++) await delay(50);
    }
    for (const pid of [...owned].reverse()) if (processExists(pid)) try { process.kill(pid, 'SIGTERM'); } catch { /* 只收尾本次记录的验收进程。 */ }
    store?.close();
    if (lock !== undefined) {
      closeSync(lock);
      if ((!child || childClosed) && !owned.some(processExists) && existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath);
    }
  }
}

try { if (worker) await executeWorker(worker); else await verifyScenario(); }
catch (error) { console.error('中断/清理验收未通过：' + redact(error instanceof Error ? error.message : '未知错误', [process.env.CASEPILOT_API_KEY || ''])); process.exitCode = 1; if (process.connected) process.disconnect(); }
