import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../apps/server/src/config.ts';
import { controlWorkbook } from '../apps/server/src/import-fixtures.ts';

// 此脚本只创建本机合成数据；检查点处等待操作员从 Web 继续或停止。
const config = loadConfig(), scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.slice(11) || 'pause';
assert.ok(['pause', 'expired'].includes(scenario), '未知验收场景');
const api = async (route, method = 'GET', body) => {
  const binary = Buffer.isBuffer(body);
  const response = await fetch(config.origin + '/api' + route, { method, headers: { 'X-CasePilot-Request': '1', ...(body ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) }, ...(body ? { body: binary ? body : JSON.stringify(body) } : {}) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || '请求失败'); return value;
};
const active = status => ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'].includes(status);
const cachedTools = new Map();
const tools = (run, index, step, name) => run.results[index].evidence.filter(e => {
  if (e.kind !== 'tool' || e.stepId !== step || e.success === false) return false;
  if (!cachedTools.has(e.id)) cachedTools.set(e.id, JSON.parse(readFileSync(path.join(config.dataDir, 'runs', run.id, e.path), 'utf8')));
  return cachedTools.get(e.id).name === name;
});
let run;
try {
  assert.ok((await api('/status')).runnerAvailable, '服务未开启任务验收');
  const system = await api('/systems', 'POST', { name: `M4 控制验收 ${randomUUID().slice(0, 6)}` });
  const env = await api('/environments', 'POST', { systemId: system.id, name: `M4 ${scenario === 'pause' ? '暂停与继续' : '会话失效'} ${randomUUID().slice(0, 4)}`, baseURL: config.origin + (scenario === 'pause' ? '/demo' : '/demo/session-expiry'), ...(scenario === 'expired' ? { loginURL: config.origin + '/demo/login', username: 'demo-user', password: 'demo-password' } : {}), captchaStrategy: 'none' });
  const draft = await api(`/imports?name=m4-${scenario}.xlsx`, 'POST', await controlWorkbook(scenario));
  await api(`/imports/${draft.id}/confirm`, 'POST', { revision: draft.revision });
  run = await api('/runs', 'POST', { importId: draft.id, revision: draft.revision, environmentId: env.id });
  console.log(`M4 ${scenario}：${run.id}；环境：${env.name}`);
  let last = 0, firstPause = false, stopPause = false, pauseRequested = '', previousStatus = '';
  const checkpoints = [], deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    run = await api(`/runs/${run.id}`);
    for (const e of run.events.filter(e => e.seq > last)) { console.log(`${e.seq} ${e.message}`); last = e.seq; }
    if (scenario === 'pause' && ['ERROR', 'FAILED', 'BLOCKED', 'CANCELLED', 'INTERRUPTED'].includes(run.results[0].status)) throw new Error('首条未完成控制验收：' + run.results[0].reason);
    if (scenario === 'pause' && !pauseRequested && run.status === 'RUNNING') {
      if (!firstPause && tools(run, 0, 's3', 'browser_click').length === 1) {
        pauseRequested = 'submitted'; await api(`/runs/${run.id}/pause`, 'POST');
      } else if (firstPause && run.results[0].status === 'PASSED' && run.results[1].status === 'RUNNING' && tools(run, 1, 's1', 'browser_navigate').length) {
        pauseRequested = 'stop'; await api(`/runs/${run.id}/pause`, 'POST');
      }
    }
    if (run.status === 'PAUSED' && (!firstPause || pauseRequested === 'stop' && !stopPause)) {
      if (scenario === 'expired') {
        assert.deepEqual(run.results.map(r => r.status), ['ERROR', 'PENDING']);
        assert.ok(run.reason.includes('登录状态已失效'));
      } else assert.ok(pauseRequested, '未预期的环境暂停');
      assert.equal(tools(run, 0, 's3', 'browser_click').length, 1);
      const evidence = run.results.map(r => r.evidence.length), totalRuns = (await api('/runs')).length;
      await delay(6000);
      const held = await api(`/runs/${run.id}`);
      assert.equal(held.status, 'PAUSED'); assert.deepEqual(held.results.map(r => r.evidence.length), evidence);
      assert.equal((await api('/runs')).length, totalRuns);
      const marker = pauseRequested === 'stop' ? 'stop-ready' : scenario === 'expired' ? 'expired-paused' : 'submitted-paused';
      checkpoints.push({ marker, seq: held.events.at(-1)?.seq, evidence, checkedAt: new Date().toISOString() });
      if (marker === 'stop-ready') { stopPause = true; console.log('CHECKPOINT stop-ready：暂停检查通过，请在页面停止'); }
      else { firstPause = true; console.log(`CHECKPOINT ${marker}：暂停检查通过，请在页面刷新后继续`); }
    }
    if (run.status === 'RUNNING' && previousStatus === 'PAUSED') pauseRequested = '';
    if (!active(run.status)) break;
    previousStatus = run.status;
    await delay(500);
  }
  assert.ok(firstPause, '未完成第一个暂停检查点');
  if (scenario === 'pause') { assert.ok(stopPause); assert.equal(run.status, 'CANCELLED'); assert.deepEqual(run.results.map(r => r.status), ['PASSED', 'CANCELLED', 'CANCELLED']); }
  else { assert.equal(run.status, 'COMPLETED'); assert.deepEqual(run.results.map(r => r.status), ['ERROR', 'PASSED']); }
  assert.equal(tools(run, 0, 's3', 'browser_click').length, 1);
  assert.equal(run.events.filter(e => e.type === 'case_started' && e.caseId === run.cases[0].id).length, 1, '首条用例不得重跑');
  assert.ok(!existsSync(path.join(config.dataDir, 'm1.lock')), '浏览器锁必须释放');
  const directory = path.join(config.dataDir, 'm4-check'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, `${scenario}-${run.id}.json`), JSON.stringify({ runId: run.id, scenario, status: run.status, results: run.results.map(r => ({ status: r.status, assertions: r.assertions.map(a => a.status) })), checkpoints, metrics: run.metrics, verifiedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`验收通过：${run.results.map(r => r.status).join('、')}；提交一次，首条未重跑，锁已释放`);
} catch (error) {
  console.error('M4 验收未通过：' + error.message);
  if (run && active(run.status)) await api(`/runs/${run.id}/stop`, 'POST').catch(() => {});
  process.exitCode = 1;
}
