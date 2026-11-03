import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Recording } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import type { RuntimeConfig } from './config.ts';
import { descendantPids, processExists } from './mcp.ts';

const require = createRequire(import.meta.url);
// playwright 的 package exports 不暴露 cli.js；包根目录下直接拼路径（cli.js 实际存在）。
const playwrightCli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
const lockName = 'recorder.lock';

interface Active { recording: Recording; child: ChildProcess | undefined }

// codegen 产物与运行记录共用 dataDir 下的 recordings/<id>/script.js。
function recordingDir(config: RuntimeConfig, id: string) {
  const parent = path.join(config.dataDir, 'recordings');
  return path.join(parent, id);
}

function scriptPath(config: RuntimeConfig, id: string) {
  return path.join(recordingDir(config, id), 'script.js');
}

// 锁与任务执行共用"一个浏览器"的互斥语义：锁里记录归属进程，恢复时只回收确认死亡的锁。
function lockPath(config: RuntimeConfig) { return path.join(config.dataDir, lockName); }

function readLock(config: RuntimeConfig): { kind: string; recordingId?: string; runId?: string; ownerPid: number } | undefined {
  try { return JSON.parse(readFileSync(lockPath(config), 'utf8')); }
  catch { return undefined; }
}

export class RecorderManager {
  private active: Active | undefined;
  private store: Store;
  private config: RuntimeConfig;
  private spawnCodegen: typeof spawn;
  private alive: typeof processExists;
  constructor(store: Store, config: RuntimeConfig, dependencies: { spawn?: typeof spawn; isProcessAlive?: typeof processExists } = {}) {
    this.store = store; this.config = config;
    this.spawnCodegen = dependencies.spawn || spawn;
    this.alive = dependencies.isProcessAlive || processExists;
    this.recoverPrevious();
  }
  // 服务启动时收尾：遗留 RECORDING 标为 INTERRUPTED（脚本可能已部分落盘，不删除）；死进程的锁回收。
  private recoverPrevious() {
    const lock = readLock(this.config);
    if (lock && lock.kind === 'recording' && !this.alive(lock.ownerPid)) {
      try { if (readFileSync(lockPath(this.config), 'utf8') === JSON.stringify(lock)) unlinkSync(lockPath(this.config)); } catch { /* 锁已被替换时不误删。 */ }
    }
    for (const recording of this.store.list<Recording>('recording')) {
      if (recording.status !== 'RECORDING') continue;
      const stale = { ...recording, status: 'INTERRUPTED' as const, endedAt: recording.endedAt || new Date().toISOString(), scriptAvailable: existsSync(scriptPath(this.config, recording.id)) };
      this.store.put('recording', stale);
    }
  }
  current() { return this.active?.recording; }
  start(name: string, startURL: string) {
    if (this.active) throw Object.assign(new Error('已有录制进行中，请先结束当前录制'), { statusCode: 409 });
    if (existsSync(lockPath(this.config))) throw Object.assign(new Error('浏览器被任务执行占用，任务结束后再开始录制'), { statusCode: 409 });
    for (const run of this.store.list<{ status: string }>('run')) if (['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'].includes(run.status)) throw Object.assign(new Error('已有测试任务占用浏览器，任务结束后再开始录制'), { statusCode: 409 });
    const id = randomUUID();
    mkdirSync(recordingDir(this.config, id), { recursive: true, mode: 0o700 });
    const recording: Recording = { id, name: name.trim().slice(0, 200) || '未命名录制', status: 'RECORDING', startURL, scriptAvailable: false, createdAt: new Date().toISOString(), endedAt: null };
    let lock: number;
    const lockText = JSON.stringify({ kind: 'recording', recordingId: id, ownerPid: process.pid });
    try { lock = openSync(lockPath(this.config), 'wx', 0o600); writeFileSync(lockPath(this.config), lockText); }
    catch { throw Object.assign(new Error('浏览器锁被占用，请稍后重试'), { statusCode: 409 }); }
    try {
      // 与 @playwright/mcp 同一套浏览器选择：系统 Chrome，独立 profile（codegen 自带临时上下文），不下载浏览器。
      const args = [playwrightCli, 'codegen', '--target=javascript', '--channel', 'chrome', '--ignore-https-errors', '--block-service-workers', '-o', scriptPath(this.config, id)];
      if (startURL) args.push(startURL);
      const child = this.spawnCodegen(process.execPath, args, { stdio: 'ignore' });
      this.active = { recording, child };
      this.store.put('recording', recording);
      child.on('exit', () => { void this.finish(recording.id, false); });
    } catch (error) {
      closeSync(lock); unlinkSync(lockPath(this.config));
      throw error;
    }
    closeSync(lock);
    return recording;
  }
  // 用户"放弃"或 codegen 进程退出都会走到这里；脚本存在与否如实记录。
  abort(id: string) {
    const active = this.active;
    if (!active || active.recording.id !== id) throw Object.assign(new Error('当前没有进行中的录制'), { statusCode: 409 });
    active.child?.kill('SIGTERM');
    // active 已确认存在，finish 必然执行落库。
    return this.finish(id, true)!;
  }
  // finish 只执行一次：active 已清空时 exit 回调不再重复写库。
  private finishGuarded = new Set<string>();
  private finish(id: string, aborted: boolean): Recording | undefined {
    // active 已清空说明状态已由另一次 finish 落库；exit 回调晚到时不再碰 store。
    if (this.active?.recording.id !== id || this.finishGuarded.has(id)) return undefined;
    this.finishGuarded.add(id);
    const recording = this.active.recording;
    this.active = undefined;
    // 录制结束即释放浏览器锁；残留锁会让下一次录制或任务创建被误拦。
    try { if (existsSync(lockPath(this.config)) && readFileSync(lockPath(this.config), 'utf8') === JSON.stringify({ kind: 'recording', recordingId: id, ownerPid: process.pid })) unlinkSync(lockPath(this.config)); } catch { /* 内容已被替换时不误删。 */ }
    const scriptAvailable = existsSync(scriptPath(this.config, id));
    // codegen 崩溃（如证书错误）可能在落盘模板壳后退出：没有任何实际操作行的不算成功录制。
    const isEmptyShell = scriptAvailable && !/(await page\.|await expect\()/.test(readFileSync(scriptPath(this.config, id), 'utf8'));
    const status = scriptAvailable && !isEmptyShell ? 'COMPLETED' : aborted ? 'INTERRUPTED' : 'ERROR';
    const updated: Recording = { ...recording, status, scriptAvailable, endedAt: new Date().toISOString() };
    return this.store.put('recording', updated);
  }
  script(id: string) {
    const recording = this.store.get<Recording>('recording', id);
    if (!recording.scriptAvailable && !existsSync(scriptPath(this.config, id))) throw Object.assign(new Error('录制脚本不存在'), { statusCode: 404 });
    return { recording, script: readFileSync(scriptPath(this.config, id), 'utf8') };
  }
  descendants(id: string) {
    const active = this.active?.recording.id === id ? this.active.child : undefined;
    return descendantPids(active?.pid);
  }
  async close() {
    const active = this.active;
    if (!active) return;
    active.child?.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (!active.child) return resolve();
      const timer = setTimeout(resolve, 2000);
      active.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.finish(active.recording.id, true);
  }
}
