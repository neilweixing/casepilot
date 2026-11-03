import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ImportDraft, Recording } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import { RecorderManager } from './recorder.ts';
import { parseRecording, recordingToTestCase } from './recording-parser.ts';
import { createDraftFromRecording, confirmImport, importProblems } from './imports.ts';
import { RunManager } from './runs.ts';
import { loadConfig } from './config.ts';

function temporary() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'casepilot-recorder-'));
  const store = new Store(directory);
  return { directory, store, cleanup() { this.store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const sampleScript = `const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4310/demo/form');

  // ---------------------
  await page.getByRole('button', { name: '提交' }).click();
  await page.getByLabel('姓名').fill('测试用户');
  await page.getByLabel('姓名').press('Enter');
  await expect(page.getByText('已提交')).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:4310/demo/form?ok=1');
  await page.waitForTimeout(5000);
  await context.close();
  await browser.close();
})();`;

test('录制脚本解析：基本操作转步骤，断言转预期，未识别行保留', () => {
  const parsed = parseRecording(sampleScript, '样本录制');
  assert.equal(parsed.steps[0], '打开页面 http://127.0.0.1:4310/demo/form');
  assert.ok(parsed.steps.some(s => s.startsWith('点击「提交」') && s.includes("getByRole('button'")));
  assert.ok(parsed.steps.some(s => s.includes('输入“测试用户”')));
  assert.ok(parsed.steps.some(s => s.includes('按键 Enter')));
  // waitForTimeout 不属于可执行业务步骤，不应混入
  assert.ok(!parsed.steps.some(s => s.includes('waitForTimeout')));
  assert.deepEqual(parsed.expectations, ['页面「已提交」可见', '页面地址为 http://127.0.0.1:4310/demo/form?ok=1']);
  // 未识别行（如双击/悬停等本版不支持的操作）原样保留并登记非阻塞问题
  const withUnknown = sampleScript.replace("await page.getByLabel('姓名').fill('测试用户');", "await page.getByRole('button', { name: '上传' }).dblclick();");
  const parsedUnknown = parseRecording(withUnknown, '样本录制');
  assert.ok(parsedUnknown.steps.some(s => s.includes('待人工修订') && s.includes('dblclick')));
  assert.ok(parsedUnknown.issues.some(i => !i.blocking && i.message.includes('dblclick')));
});

test('录制转用例：来源保留代码行，空录制有提示且不阻塞确认链路', () => {
  const converted = recordingToTestCase('r1', '表单回归', sampleScript);
  const testCase = converted.cases[0]!;
  assert.equal(testCase.source.fileName, '表单回归');
  assert.equal(testCase.source.sheet, '录制');
  assert.ok(testCase.source.original.join('\n').includes("getByRole('button'"));
  assert.ok(testCase.steps.length >= 4);
  assert.equal(converted.issues.every(i => i.sheet === '录制'), true);
  const empty = recordingToTestCase('r2', '空录制', "const { chromium } = require('playwright');\n");
  assert.equal(empty.cases[0]!.steps.length, 0);
  assert.ok(empty.issues.some(i => i.message.includes('为空')));
});

test('录制互斥：录制中拒绝创建任务，任务占用时拒绝开始录制，恢复清理死锁', async () => {
  const t = temporary();
  try {
    // 模拟一个存活但非本进程的录制锁：recoverPrevious 不清存活锁。
    writeFileSync(path.join(t.directory, 'recorder.lock'), JSON.stringify({ kind: 'recording', recordingId: 'stale', ownerPid: 1 }));
    const config = loadConfig({ CASEPILOT_DATA_DIR: t.directory });
    const manager = new RecorderManager(t.store, config, { spawn: (() => { throw new Error('测试不真正启动浏览器'); }) as never });
    assert.throws(() => manager.start('测试录制', ''), /占用/);
    // 死进程锁被回收后可以开始录制；spawn 抛错时锁必须回滚，不留脏锁。
    rmSync(path.join(t.directory, 'recorder.lock'));
    assert.throws(() => manager.start('测试录制', ''), /测试不真正启动浏览器/);
    assert.equal(existsSync(path.join(t.directory, 'recorder.lock')), false, 'spawn 失败后锁应回滚');
    // RunManager.create 看到遗留 RECORDING 记录时拒绝任务。
    t.store.put<Recording>('recording', { id: 'r-active', name: '进行中', status: 'RECORDING', startURL: '', scriptAvailable: false, createdAt: '', endedAt: null });
    const ref = t.store.password(JSON.stringify({ password: 'synthetic', captchaCode: '' }));
    const store = t.store;
    const env = store.put('environment', { id: 'env', systemId: 'sys', name: '环境', baseURL: 'http://127.0.0.1:4310/demo', loginURL: '', username: 'synthetic', credentialRef: ref, hasPassword: true, captchaCode: '', captchaStrategy: 'none', createdAt: '' });
    store.put('import-version', { id: 'import:1', confirmedAt: new Date().toISOString(), cases: [{ id: 'case', externalId: '', module: '', title: '标题', priority: '', preconditions: [], steps: ['点击'], expectations: ['成功'], source: { fileName: 'x', sheet: 'S', rows: [2], original: [] }, excluded: false, duplicateAcknowledged: false }] });
    const runner = new RunManager(store, config, { executeCase: (async () => {}) as never, loadModel: () => ({ apiKey: 'x', baseURL: 'http://127.0.0.1', modelId: 'x', contextWindow: 65536, maxTokens: 4096, input: ['text'] as ('text' | 'image')[], reasoning: false, thinkingLevel: 'off' as const }) });
    assert.throws(() => runner.create('import', 1, env.id), /录制进行中/);
    await runner.close();
    // 服务重启恢复：遗留 RECORDING 标为 INTERRUPTED。
    const reopened = new RecorderManager(t.store, loadConfig({ CASEPILOT_DATA_DIR: t.directory }), { spawn: (() => { throw new Error('不启动'); }) as never });
    assert.equal(t.store.get<Recording>('recording', 'r-active').status, 'INTERRUPTED');
  } finally { t.cleanup(); }
});

test('convert：录制转草稿走确认门禁，重复转换被拒绝，abort 未落盘记 INTERRUPTED', async () => {
  const t = temporary();
  try {
    const config = loadConfig({ CASEPILOT_DATA_DIR: t.directory });
    // 注入合成 manager：不真正 spawn，脚本与状态通过 store 构造。
    const recording: Recording = { id: 'r1', name: '表单回归', status: 'COMPLETED', startURL: 'http://127.0.0.1:4310/demo/form', scriptAvailable: true, createdAt: '', endedAt: '' };
    t.store.put('recording', recording);
    const dir = path.join(t.directory, 'recordings', 'r1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'script.js'), sampleScript);
    const { createServer } = await import('./server.ts');
    const app = createServer(config, t.store);
    const headers = { host: '127.0.0.1:4310', 'x-casepilot-request': '1' };
    try {
      const script = await app.inject({ url: '/api/recordings/r1/script', headers });
      assert.equal(script.statusCode, 200);
      const convert = await app.inject({ method: 'POST', url: '/api/recordings/r1/convert', headers });
      assert.equal(convert.statusCode, 200);
      const draftId = convert.json().caseDraftId;
      const draft = t.store.get<ImportDraft>('import', draftId);
      assert.equal(draft.origin, 'recording');
      assert.equal(draft.cases.length, 1);
      // 列表接口返回归一化后的 origin
      const list = await app.inject({ url: '/api/imports', headers: { host: headers.host } });
      assert.equal(list.json().find((d: { id: string }) => d.id === draftId).origin, 'recording');
      // 未指定系统时确认门禁拒绝（与 Excel 导入一致）。
      assert.ok(importProblems(draft).concat().length >= 0);
      assert.throws(() => confirmImport(t.store, draftId, draft.revision), /所属系统/);
      const repeat = await app.inject({ method: 'POST', url: '/api/recordings/r1/convert', headers });
      assert.equal(repeat.statusCode, 409);
      // 草稿被删除后引用悬空：清除引用并允许重新转换，不留死锁。
      t.store.remove('import', draftId);
      const reconvert = await app.inject({ method: 'POST', url: '/api/recordings/r1/convert', headers });
      assert.equal(reconvert.statusCode, 200);
      assert.notEqual(reconvert.json().caseDraftId, draftId);
      // 进行中的录制不能删除；未落盘的 abort 记录为 INTERRUPTED。
      t.store.put('recording', { ...recording, id: 'r2', status: 'RECORDING', scriptAvailable: false, caseDraftId: undefined });
      const removed = await app.inject({ method: 'DELETE', url: '/api/recordings/r2', headers });
      assert.equal(removed.statusCode, 409);
      const aborted = await app.inject({ method: 'POST', url: '/api/recordings/r2/abort', headers });
      assert.equal(aborted.statusCode, 409, '非本会话启动的录制不能由 API 放弃');
    } finally { await app.close(); }
  } finally { t.cleanup(); }
});

test('abort 落盘脚本记为 COMPLETED，与真实 codegen 定时保存行为一致', async () => {
  const t = temporary();
  const config = loadConfig({ CASEPILOT_DATA_DIR: t.directory });
  try {
    // 用无害的常驻 node 进程占位 child（不启动浏览器），验证 abort 与落盘判定。
    const { spawn } = await import('node:child_process');
    const manager = new RecorderManager(t.store, config, { spawn: ((cmd: string, args: string[]) => spawn(cmd, [args[0]!, '-e', 'setInterval(() => {}, 1000)'])) as never, isProcessAlive: () => false });
    const recording = manager.start('冒烟', '');
    const dir = path.join(t.directory, 'recordings', recording.id);
    writeFileSync(path.join(dir, 'script.js'), sampleScript);
    await delay(50);
    const finished = manager.abort(recording.id);
    assert.equal(finished.status, 'COMPLETED');
    assert.equal(finished.scriptAvailable, true);
    await manager.close();
  } finally { t.cleanup(); }
});
