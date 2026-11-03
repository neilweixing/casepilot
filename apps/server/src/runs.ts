import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Environment, ImportDraft, Run } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import { loadModelConfig, type RuntimeConfig } from './config.ts';
import { resolveModelConfig } from './model-providers.ts';
import { AuthenticationFailure, executeCase } from './case-agent.ts';
import { processExists } from './mcp.ts';
import { validateCaseResult } from './execution-rules.ts';

interface Active { run: Run; controller: AbortController; pause: boolean; resume?: () => void; pid?: number; children: number[]; lock: number; lockText: string; shutdown?: boolean }
interface PrivateRun { id: string; credentialRef: string; environment: Environment; ownerPid?: number; pid?: number; children: number[] }
const activeStatuses = ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'];

export class RunManager {
  readonly store: Store;
  readonly config: RuntimeConfig;
  private active: Active | undefined;
  private recoveryBlocked = false;
  private executor: typeof executeCase;
  private loadModel: typeof loadModelConfig;
  private isAlive: typeof processExists;
  constructor(store: Store, config: RuntimeConfig, dependencies: { executeCase?: typeof executeCase; loadModel?: typeof loadModelConfig; isProcessAlive?: typeof processExists } = {}) {
    this.store = store; this.config = config;
    this.executor = dependencies.executeCase || executeCase; this.loadModel = dependencies.loadModel || (() => resolveModelConfig(store));
    this.isAlive = dependencies.isProcessAlive || processExists;
    this.recoverPrevious();
  }
  private interrupt(run: Run, reason: string, shutdown = false) {
    run.status = 'INTERRUPTED'; run.reason = reason; run.endedAt ||= new Date().toISOString();
    for (const result of run.results) {
      if (shutdown && result.status === 'CANCELLED' && !result.startedAt) { result.status = 'PENDING'; result.reason = ''; }
      if (result.status === 'RUNNING' || result.status === 'PENDING' && result.startedAt || shutdown && result.status === 'CANCELLED' && result.startedAt) {
        result.status = 'INTERRUPTED'; result.reason = reason; result.endedAt ||= run.endedAt;
      }
      if (result.status === 'INTERRUPTED') for (const step of result.steps) {
        if (step.status === 'SENT') step.status = 'UNCERTAIN';
        else if (step.status === 'RUNNING') step.status = 'INTERRUPTED';
      }
    }
  }
  private save(run: Run) {
    if (this.active?.run === run && this.active.shutdown) this.interrupt(run, '服务退出或重载导致中断，未自动重放业务操作', true);
    this.store.put('run', run);
  }
  private recoverPrevious() {
    const lockPath = path.join(this.config.dataDir, 'm1.lock'), runs = this.store.list<Run>('run');
    this.recoveryBlocked = false;
    let lock: { kind: string; runId: string; ownerPid: number } | undefined, lockText: string | undefined;
    const info = new Map<string, PrivateRun>();
    try {
      if (existsSync(lockPath)) {
        lockText = readFileSync(lockPath, 'utf8');
        try { lock = JSON.parse(lockText); } catch { /* 旧 M1 锁没有可靠归属，不自动删除。 */ }
        if (!lock || lock.kind !== 'run' || !/^[0-9a-f-]{36}$/.test(lock.runId) || !Number.isSafeInteger(lock.ownerPid) || lock.ownerPid < 1 || this.isAlive(lock.ownerPid)) { this.recoveryBlocked = true; return; }
      }
      for (const run of runs) {
        try { info.set(run.id, this.store.get<PrivateRun>('run-private', run.id)); } catch { /* 旧记录可能没有私有元数据。 */ }
        const owner = info.get(run.id)?.ownerPid;
        if (activeStatuses.includes(run.status) && owner && this.isAlive(owner)) { this.recoveryBlocked = true; return; }
      }
      if (lock && info.get(lock.runId)?.ownerPid !== lock.ownerPid) { this.recoveryBlocked = true; return; }
      for (const run of runs) {
        if (activeStatuses.includes(run.status)) {
          this.interrupt(run, '上次服务退出导致中断，未自动重放操作');
          this.event(run, 'interrupted', run.reason);
        }
        const meta = info.get(run.id);
        if (!meta) continue;
        if ([meta.pid, ...meta.children].some(pid => this.isAlive(pid))) this.recoveryBlocked = true;
        else if (meta.pid !== undefined || meta.children.length) { delete meta.pid; meta.children = []; this.store.put('run-private', meta); }
      }
      if (lock && !this.recoveryBlocked) {
        // 再核对原始内容，不能删除恢复期间被替换的新锁。
        if (readFileSync(lockPath, 'utf8') === lockText) unlinkSync(lockPath);
        else this.recoveryBlocked = true;
      }
    } catch { this.recoveryBlocked = true; }
  }
  event(run: Run, type: string, message: string, caseId?: string) {
    run.events.push({ seq: (run.events.at(-1)?.seq || 0) + 1, timestamp: new Date().toISOString(), type, message, ...(caseId ? { caseId } : {}) });
    this.save(run);
  }
  create(importId: string, revision: number, environmentId: string) {
    if (!this.active) this.recoverPrevious();
    if (this.active || this.recoveryBlocked || existsSync(path.join(this.config.dataDir, 'm1.lock'))) throw Object.assign(new Error('已有任务占用浏览器，或上次执行的浏览器尚未释放'), { statusCode: 409 });
    // 录制浏览器与执行浏览器互斥：录制进行中不接受新任务。
    if (existsSync(path.join(this.config.dataDir, 'recorder.lock'))) throw Object.assign(new Error('录制进行中占用浏览器，请先结束录制再创建任务'), { statusCode: 409 });
    for (const recording of this.store.list<{ status: string }>('recording')) if (recording.status === 'RECORDING') throw Object.assign(new Error('录制进行中占用浏览器，请先结束录制再创建任务'), { statusCode: 409 });
    let version: ImportDraft;
    try { version = this.store.get('import-version', `${importId}:${revision}`); }
    catch { throw Object.assign(new Error('该用例版本尚未确认，不能执行'), { statusCode: 409 }); }
    if (!version.confirmedAt) throw new Error('用例尚未确认');
    const environment = this.store.get<Environment>('environment', environmentId);
    // 旧快照没有 systemId 时保持可用；新快照要求环境与用例集属于同一系统，防止串环境执行。
    const snapshotSystemId = version.systemId || '';
    if (snapshotSystemId && environment.systemId !== snapshotSystemId) throw Object.assign(new Error('所选环境属于其他系统，请选择与用例集一致的环境'), { statusCode: 409 });
    const model = this.loadModel();
    const cases = version.cases.filter(c => !c.excluded);
    if (!cases.length) throw new Error('没有可执行用例');
    const run: Run = { id: randomUUID(), importId, revision, environment: { id: environment.id, name: environment.name, baseURL: environment.baseURL, systemId: environment.systemId }, modelId: model.modelId, status: 'QUEUED', cases: structuredClone(cases), results: cases.map(c => ({ caseId: c.id, status: 'PENDING', phase: 'VALIDATING', reason: '', assertions: [], steps: c.steps.map((text, i) => ({ id: `s${i + 1}`, text, status: 'PENDING', evidenceIds: [] })), evidence: [], startedAt: null, endedAt: null })), events: [], reason: '', createdAt: new Date().toISOString(), endedAt: null };
    let lock: number;
    const lockText = JSON.stringify({ kind: 'run', runId: run.id, ownerPid: process.pid });
    try { lock = openSync(path.join(this.config.dataDir, 'm1.lock'), 'wx', 0o600); writeFileSync(lock, lockText); }
    catch { throw Object.assign(new Error('已有执行任务持有浏览器锁，请稍后重试'), { statusCode: 409 }); }
    try {
      this.store.put('run-private', { id: run.id, ownerPid: process.pid, credentialRef: environment.credentialRef, environment, children: [] });
      this.event(run, 'created', '任务已创建，按确认顺序执行');
    } catch (error) { closeSync(lock); unlinkSync(path.join(this.config.dataDir, 'm1.lock')); throw error; }
    const active: Active = { run, controller: new AbortController(), pause: false, children: [], lock, lockText };
    this.active = active;
    queueMicrotask(() => { void this.execute(active, environment, model).catch(() => { run.status = 'ERROR'; run.reason = '任务执行器异常，已有证据保留'; this.store.put('run', run); this.active = undefined; }); });
    return run;
  }
  private async boundary(active: Active, signal?: AbortSignal) {
    active.controller.signal.throwIfAborted();
    if (!active.pause) return false;
    active.run.status = 'PAUSED'; this.event(active.run, 'paused', active.run.reason || '已暂停，继续前将重新检查页面');
    await new Promise<void>(resolve => { const finish = () => { signal?.removeEventListener('abort', finish); resolve(); }; active.resume = finish; signal?.addEventListener('abort', finish, { once: true }); if (signal?.aborted) finish(); });
    delete active.resume; active.controller.signal.throwIfAborted(); signal?.throwIfAborted();
    active.run.status = 'RUNNING'; this.event(active.run, 'resumed', '已继续；旧页面观察已失效');
    return true;
  }
  private async execute(active: Active, environment: Environment, model: ReturnType<typeof loadModelConfig>) {
    const run = active.run;
    run.status = 'RUNNING'; this.event(run, 'started', '开始执行');
    const runTimeout = setTimeout(() => { run.reason = '任务执行超时，保留已有结果'; active.controller.abort(); active.resume?.(); }, 1800000);
    try {
      const privateRun = this.store.get<PrivateRun>('run-private', run.id);
      let credential = JSON.parse(this.store.secret(privateRun.credentialRef)) as { password: string; captchaCode: string };
      for (let index = 0; index < run.cases.length; index++) {
        if (active.controller.signal.aborted) break;
        await this.boundary(active);
        const c = run.cases[index]!, result = run.results[index]!;
        result.status = 'RUNNING'; result.startedAt = new Date().toISOString();
        result.endedAt = null;
        this.event(run, 'case_started', c.title, c.id);
        try {
          await this.executor(this.config, model, run.id, c, environment, credential, result, {
            signal: active.controller.signal,
            boundary: signal => this.boundary(active, signal), changed: () => this.save(run),
            event: message => this.event(run, 'progress', message, c.id),
            processes: (pid, children) => { if (pid !== undefined) active.pid = pid; else delete active.pid; active.children = children; const info = { ...privateRun, children }; if (pid !== undefined) Object.assign(info, { pid }); else delete info.pid; this.store.put('run-private', info); },
          });
        } catch (error) {
          if (error instanceof AuthenticationFailure) {
            const beforeBusiness = ['AUTHENTICATING', 'VALIDATING'].includes(result.phase);
            result.status = beforeBusiness ? 'PENDING' : result.assertions.some(a => a.status === 'FAILED') ? 'FAILED' : 'ERROR'; result.reason = error.message;
            if (!beforeBusiness) { validateCaseResult(run.id, c, result); this.event(run, 'case_finished', `${c.title}：${result.status}`, c.id); }
            run.reason = (error.kind === 'login' ? '登录无法完成：' : '环境暂时不可用：') + error.message;
            active.pause = true; await this.boundary(active);
            const latest = this.store.get<Environment>('environment', environment.id);
            if (latest.baseURL !== environment.baseURL || latest.loginURL !== environment.loginURL || latest.username !== environment.username) throw new Error('环境地址或账号发生变化，请创建新任务');
            environment = latest; privateRun.environment = latest; privateRun.credentialRef = latest.credentialRef;
            credential = JSON.parse(this.store.secret(latest.credentialRef)); this.store.put('run-private', privateRun);
            if (beforeBusiness) index--;
            continue;
          }
          result.status = 'ERROR'; result.reason = '执行异常，无法可靠判断';
        }
        validateCaseResult(run.id, c, result);
        this.event(run, 'case_finished', `${c.title}：${result.status}`, c.id);
        if (active.pid || active.children.length) { run.reason = '工具进程未释放，后续任务暂停'; active.pause = true; await this.boundary(active); }
      }
      if (active.controller.signal.aborted) {
        for (const result of run.results) if (['PENDING', 'RUNNING'].includes(result.status)) { result.status = 'CANCELLED'; result.reason = '任务已停止，未自动重放'; }
        run.status = 'CANCELLED';
      } else run.status = 'COMPLETED';
    } catch {
      run.status = active.controller.signal.aborted ? 'CANCELLED' : 'ERROR';
      for (const result of run.results) if (['PENDING', 'RUNNING'].includes(result.status)) result.status = active.controller.signal.aborted ? 'CANCELLED' : 'PENDING';
    } finally {
      clearTimeout(runTimeout); run.endedAt = new Date().toISOString();
      if (active.shutdown) {
        this.interrupt(run, '服务退出或重载导致中断，未自动重放业务操作', true);
      }
      this.event(run, 'finished', run.reason || `任务处理结束：${run.status}`);
      if (active.pid || active.children.length) this.recoveryBlocked = true;
      closeSync(active.lock);
      if (!this.recoveryBlocked) {
        const file = path.join(this.config.dataDir, 'm1.lock');
        if (existsSync(file) && readFileSync(file, 'utf8') === active.lockText) unlinkSync(file);
      }
      this.active = undefined;
    }
  }
  control(id: string, action: 'pause' | 'resume' | 'stop') {
    const active = this.active;
    if (!active || active.run.id !== id) throw Object.assign(new Error('任务当前不能操作'), { statusCode: 409 });
    const run = active.run;
    if (action === 'pause') {
      if (run.status !== 'RUNNING') throw new Error('只有运行中的任务可以暂停');
      active.pause = true; run.status = 'PAUSING'; this.event(run, 'pausing', '等待当前工具边界暂停');
    } else if (action === 'resume') {
      if (run.status !== 'PAUSED' || run.reason.includes('未释放') && [active.pid, ...active.children].some(processExists)) throw new Error('当前任务不能继续，请先核实工具进程');
      if (run.reason.includes('未释放')) { delete active.pid; active.children = []; const info = this.store.get<PrivateRun>('run-private', id); delete info.pid; info.children = []; this.store.put('run-private', info); }
      active.pause = false; run.reason = ''; active.resume?.();
    } else {
      active.pause = false; run.status = 'STOPPING'; this.event(run, 'stopping', '正在停止并收集现有证据'); active.controller.abort(); active.resume?.();
    }
    return run;
  }
  async close() {
    const active = this.active;
    if (!active) return;
    if (!active.shutdown) { active.shutdown = true; this.event(active.run, 'interrupting', '服务正在退出，已保存中断现场，不自动重放业务操作'); }
    active.controller.abort(); active.resume?.();
    for (let i = 0; i < 200 && this.active; i++) await delay(50);
  }
}
