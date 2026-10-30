import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig, projectRoot } from '../apps/server/src/config.ts';

// 这是一次独立的终止验收，会调用真实模型并打开可见浏览器。
const child = spawn(process.execPath, ['apps/server/src/smoke-cli.ts'], { cwd: projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let output = '';
let stopped = false;
let forceTimer;
const stop = () => {
  if (stopped) return;
  stopped = true;
  child.send({ type: 'casepilot-stop' });
  forceTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
};
const timer = setTimeout(stop, 60000);
child.stdout.on('data', chunk => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  if (output.includes('完成 mcp__playwright__browser_navigate')) stop();
});
child.stderr.on('data', chunk => process.stderr.write(chunk));
child.on('error', () => { console.error('无法启动终止验收进程'); process.exitCode = 1; });
child.on('close', async () => {
  clearTimeout(timer);
  clearTimeout(forceTimer);
  try {
    assert.ok(output.includes('完成 mcp__playwright__browser_navigate'), '必须实际打开页面后再终止');
    const runId = output.match(/开始 normal 样本：([0-9a-f-]{36})/)?.[1];
    assert.ok(runId, '缺少本次运行编号');
    const directory = path.join(loadConfig().dataDir, 'runs', runId);
    const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    const lifecycle = JSON.parse(await readFile(path.join(directory, 'lifecycle.json'), 'utf8'));
    assert.equal(result.status, 'CANCELLED');
    assert.ok(lifecycle.browserProcessIds.length > 0, '必须实际检查浏览器子进程');
    assert.ok(lifecycle.mcpReleased && lifecycle.browserReleased, 'MCP 和浏览器均应释放');
    console.log('终止验收通过：打开真实页面后终止，结果为 CANCELLED，MCP 与浏览器子进程均已释放。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
});
