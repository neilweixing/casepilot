import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../apps/server/src/config.ts';
import { executionWorkbook } from '../apps/server/src/import-fixtures.ts';

// 只创建本机可控系统的合成输入；不会选择或修改用户已有环境。
const config = loadConfig();
const scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.slice(11) || 'normal';
const systemId = process.argv.find(arg => arg.startsWith('--system-id='))?.slice(12);
if (!['normal', 'reversed', 'wrong-password', 'test-code'].includes(scenario)) throw new Error('未知验收场景');
const api = async (route, method = 'GET', body) => {
  const bytes = Buffer.isBuffer(body);
  const response = await fetch(config.origin + '/api' + route, { method, headers: { 'X-CasePilot-Request': '1', ...(body ? { 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' } : {}) }, ...(body ? { body: bytes ? body : JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '接口失败'); return result;
};
let run;
try {
  const status = await api('/status');
  assert.ok(status.runnerAvailable, '当前服务尚未开启 M3 验证入口，请启动最新开发服务');
  const system = systemId ? (await api('/systems')).find(s => s.id === systemId) : await api('/systems', 'POST', { name: `M3 合成验收 ${randomUUID().slice(0, 8)}` });
  assert.ok(system && system.name.startsWith('M3 '), '只能在明确指定的 M3 合成系统中创建验收环境');
  const login = scenario !== 'reversed';
  const env = await api('/environments', 'POST', { systemId: system.id, name: `M3 ${scenario}`, baseURL: config.origin + (scenario === 'reversed' ? '/demo/reversed' : '/demo/secure'), ...(login ? { loginURL: config.origin + (scenario === 'test-code' ? '/demo/login-captcha' : '/demo/login'), username: 'demo-user', password: scenario === 'wrong-password' ? 'deliberately-incorrect-synthetic' : 'demo-password' } : {}), captchaStrategy: scenario === 'test-code' ? 'test-code' : 'none', ...(scenario === 'test-code' ? { captchaCode: '2468' } : {}) });
  const workbook = await executionWorkbook(['reversed', 'test-code'].includes(scenario));
  const draft = await api(`/imports?name=m3-${scenario}.xlsx`, 'POST', workbook);
  await api(`/imports/${draft.id}/confirm`, 'POST', { revision: draft.revision });
  run = await api('/runs', 'POST', { importId: draft.id, revision: draft.revision, environmentId: env.id });
  console.log(`M3 ${scenario}：${run.id}`);
  let last = 0, stopRequested = false;
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    run = await api(`/runs/${run.id}`);
    for (const e of run.events.filter(e => e.seq > last)) { console.log(`${e.seq} ${e.message}`); last = e.seq; }
    if (run.status === 'PAUSED') {
      if (scenario !== 'wrong-password') throw new Error('任务意外暂停：' + run.reason);
      assert.ok(run.results.every(r => r.status === 'PENDING')); assert.ok(run.results.every(r => r.steps.every(s => s.status === 'PENDING')));
      if (!stopRequested) { await api(`/runs/${run.id}/stop`, 'POST'); stopRequested = true; }
    }
    if (!['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'].includes(run.status)) break;
    await delay(2000);
  }
  if (scenario === 'wrong-password') {
    assert.equal(run.status, 'CANCELLED'); assert.ok(run.results.every(r => r.status === 'CANCELLED'));
  } else {
    assert.equal(run.status, 'COMPLETED');
    assert.deepEqual(run.results.map(r => r.status), scenario === 'normal' ? ['PASSED', 'BLOCKED', 'FAILED', 'PASSED'] : [scenario === 'reversed' ? 'FAILED' : 'PASSED']);
    if (scenario === 'reversed') {
      assert.deepEqual(run.results[0].assertions.map(a => a.status), ['PASSED', 'FAILED'], '提交文字必须通过，实际字段位置必须不符');
      const position = run.results[0].assertions[1];
      assert.ok(position.evidenceIds.some(id => run.results[0].evidence.some(e => e.id === id && e.kind === 'position' && e.stepId === 'e2')), '位置失败必须有本次实际坐标证据');
    }
  }
  const directory = path.join(config.dataDir, 'm3-check'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, `${scenario}.json`), JSON.stringify({ scenario, runId: run.id, status: run.status, results: run.results.map(r => ({ caseId: r.caseId, status: r.status, assertions: r.assertions.length })), metrics: run.metrics, verifiedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`验收通过：${run.results.map(r => r.status).join('、')}`);
} catch (error) {
  console.error('M3 验收未通过：' + error.message);
  if (run && ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED'].includes(run.status)) await api(`/runs/${run.id}/stop`, 'POST').catch(() => {});
  process.exitCode = 1;
}
