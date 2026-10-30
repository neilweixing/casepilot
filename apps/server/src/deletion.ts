import { realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Environment, ImportDraft, Run, System } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';

interface PrivateRun { id: string; credentialRef: string; environment: Environment }

// 运行中的任务不能删除：执行器仍在使用 run 记录、凭证与浏览器锁。
const activeStatuses = ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'] as const;

function refuse(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// 凭证文件可能被多个环境或历史任务共享，只有最后一个持有者删除时才真正移除。
function releaseCredential(store: Store, ref: string, exclude: { kind: string; id: string }) {
  if (!ref) return false;
  const stillUsed = store.list<Environment>('environment').some(e => e.credentialRef === ref && exclude.id !== e.id)
    || store.list<PrivateRun>('run-private').some(r => r.credentialRef === ref && exclude.id !== r.id);
  if (stillUsed) return false;
  store.removeSecret(ref);
  return true;
}

// 只删除运行目录下确属该任务的那一层，拒绝任何越界路径。
function removeRunDirectory(dataDir: string, runId: string) {
  const runs = realpathSync(path.join(dataDir, 'runs'));
  const target = path.join(runs, runId);
  if (path.dirname(path.resolve(target)) !== runs) throw new Error('任务证据目录不在允许范围内');
  rmSync(target, { recursive: true, force: true });
  return target;
}

export function deleteSystem(store: Store, id: string) {
  const system = store.get<System>('system', id);
  const environments = store.list<Environment>('environment').filter(e => e.systemId === id);
  if (environments.length) throw refuse(`该系统下还有 ${environments.length} 个环境，请先删除这些环境`);
  store.remove('system', system.id);
  return { deleted: 'system' as const, id: system.id, name: system.name };
}

export function deleteEnvironment(store: Store, id: string) {
  const environment = store.get<Environment>('environment', id);
  const runs = store.list<Run>('run').filter(r => r.environment.id === id);
  if (runs.length) throw refuse(`该环境已被 ${runs.length} 个历史任务使用，保留记录才能回查报告；如只需停用请修改地址或账号`);
  const credentialReleased = releaseCredential(store, environment.credentialRef, { kind: 'environment', id });
  store.remove('environment', environment.id);
  return { deleted: 'environment' as const, id: environment.id, name: environment.name, credentialReleased };
}

export function deleteImport(store: Store, id: string) {
  const draft = store.get<ImportDraft>('import', id);
  const runs = store.list<Run>('run').filter(r => r.importId === id);
  if (runs.length) throw refuse(`该用例集已被 ${runs.length} 个历史任务使用，保留记录才能回查报告；如需调整请导入新版本`);
  // 确认版本按 `${importId}:${revision}` 存，需按前缀精确匹配删除，不能只删当前 revision。
  const versions = store.list<ImportDraft & { importId?: string }>('import-version').filter(v => v.importId === id || v.id.startsWith(`${id}:`) || v.id === id);
  for (const version of versions) store.remove('import-version', version.id);
  store.remove('import', draft.id);
  const directory = path.join(store.dataDir, 'imports', draft.id);
  if (path.dirname(path.resolve(directory)) === path.resolve(store.dataDir, 'imports')) rmSync(directory, { recursive: true, force: true });
  return { deleted: 'import' as const, id: draft.id, fileName: draft.fileName, versionsRemoved: versions.length };
}

export function deleteRun(store: Store, id: string) {
  const run = store.get<Run>('run', id);
  if ((activeStatuses as readonly string[]).includes(run.status)) throw refuse(`任务当前状态为 ${run.status}，请先停止并等待执行结束再删除`);
  let privateRun: PrivateRun | undefined;
  try { privateRun = store.get<PrivateRun>('run-private', run.id); } catch { /* 旧记录可能没有私有元数据。 */ }
  store.remove('run-private', run.id);
  store.remove('run', run.id);
  // 证据目录在记录删除后再清理；即使目录缺失也不影响已完成的删除。
  removeRunDirectory(store.dataDir, run.id);
  const credentialReleased = privateRun ? releaseCredential(store, privateRun.credentialRef, { kind: 'run-private', id: run.id }) : false;
  return { deleted: 'run' as const, id: run.id, environment: run.environment.name, credentialReleased };
}
