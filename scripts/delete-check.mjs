// 删除功能 UI 验收：在临时目录起独立服务与独立数据目录，绝不接触项目 data/。
// 真实可见 Chrome 操作页面；结束后关闭浏览器与临时服务，删除临时目录。
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = path.resolve('.');
const require = createRequire(path.join(root, 'apps/server/package.json'));
const { chromium } = require(require.resolve('playwright', { paths: [path.dirname(require.resolve('@playwright/mcp/package.json'))] }));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'casepilot-delete-ui-'));
const out = path.join(root, 'artifacts/delete-check');
mkdirSync(out, { recursive: true });
const port = 4399, webPort = 4400;
const api = `http://127.0.0.1:${port}`, base = `http://127.0.0.1:${webPort}`;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const call = (url, method, body) => fetch(api + url, { method, headers: { 'X-CasePilot-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

// 独立服务：同一份代码，独立 SQLite 与证据目录。
const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'apps/server/src/main.ts'], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, CASEPILOT_PORT: String(port), CASEPILOT_DATA_DIR: dataDir, CASEPILOT_ENABLE_RUNNER: '1' },
});
// 独立 Vite 前端：端口与后端相邻，代理到临时后端。
const viteEntry = path.join(path.dirname(require.resolve('vite/package.json', { paths: [path.join(root, 'apps/web')] })), 'bin/vite.js');
const vite = spawn(process.execPath, [viteEntry, '--config', 'apps/web/vite.config.ts', 'apps/web'], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, CASEPILOT_PORT: String(port) },
});
const waitUp = async (url) => { for (let i = 0; i < 150; i++) { try { if ((await fetch(url)).ok) return true; } catch {} await new Promise(r => setTimeout(r, 100)); } return false; };

let browser;
try {
  if (!await waitUp(api + '/health')) throw new Error('临时服务未能启动');
  if (!await waitUp(base + '/')) throw new Error('临时前端未能启动');

  // 造数据：两个系统，一个含环境；一个用例集（无任务引用）
  const sysA = await call('/api/systems', 'POST', { name: '验收系统甲' });
  const sysB = await call('/api/systems', 'POST', { name: '验收系统乙' });
  await call('/api/environments', 'POST', { systemId: sysB.data.id, name: '乙环境', baseURL: 'http://127.0.0.1:4310/demo', captchaStrategy: 'none' });

  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1440,940'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '系统与环境' }).click();
  await page.getByRole('heading', { name: '系统与环境' }).waitFor();
  await page.screenshot({ path: path.join(out, '10-systems.png') });

  // 1. 有环境的系统被拒绝
  const sysRowA = page.locator('.system-strip li').filter({ hasText: '验收系统乙' });
  await sysRowA.getByRole('button', { name: '删除' }).click();
  await sysRowA.locator('.delete-confirm').getByRole('button', { name: '确认删除' }).click();
  const alert1 = page.getByRole('alert');
  await alert1.waitFor({ timeout: 8000 }).catch(() => {});
  const t1 = await alert1.innerText().catch(() => '');
  check('有环境的系统显示服务端拒绝原因', /个环境/.test(t1), t1.slice(0, 50));
  await page.screenshot({ path: path.join(out, '11-system-refused.png') });

  // 2. 无环境的系统成功删除
  const sysRowA2 = page.locator('.system-strip li').filter({ hasText: '验收系统甲' });
  await sysRowA2.getByRole('button', { name: '删除' }).click();
  await sysRowA2.locator('.delete-confirm').getByRole('button', { name: '确认删除' }).click();
  await page.waitForTimeout(800);
  const systemsLeft = await (await fetch(api + '/api/systems')).json();
  check('无环境系统从服务端移除', !systemsLeft.some(s => s.id === sysA.data.id));

  // 3. 二次确认可取消
  const envCard = page.locator('.environment-card').filter({ hasText: '乙环境' });
  await envCard.getByRole('button', { name: '删除' }).click();
  const confirm = envCard.locator('.delete-confirm');
  check('删除前出现就地二次确认', await confirm.isVisible() && /不可恢复/.test(await confirm.innerText()));
  await confirm.getByRole('button', { name: '取消' }).click();
  check('取消后环境仍在', await envCard.count() === 1);

  // 4. 环境成功删除
  await envCard.getByRole('button', { name: '删除' }).click();
  await envCard.locator('.delete-confirm').getByRole('button', { name: '确认删除' }).click();
  await page.waitForTimeout(800);
  const envsLeft = await (await fetch(api + '/api/environments')).json();
  check('环境从服务端移除且卡片消失', !envsLeft.some(e => e.name === '乙环境') && await page.locator('.environment-card').filter({ hasText: '乙环境' }).count() === 0);
  await page.screenshot({ path: path.join(out, '12-system-env-deleted.png') });

  // 5. 系统与用例库入口存在
  await page.getByRole('button', { name: '用例库' }).click();
  await page.getByRole('heading', { name: '用例库' }).waitFor();
  check('用例库无数据时显示空状态', await page.locator('.empty').isVisible() || await page.locator('table tbody tr').count() === 0);
  await page.getByRole('button', { name: '测试任务' }).click();
  await page.getByRole('heading', { name: '测试任务' }).waitFor();
  check('任务列表无数据时显示空状态', await page.locator('.empty').isVisible() || await page.locator('table tbody tr').count() === 0);
  await page.screenshot({ path: path.join(out, '13-empty-states.png') });
} catch (error) {
  console.error('验收异常：', error.message);
  results.push({ name: '执行未中断', ok: false, detail: error.message });
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGTERM'); vite.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  rmSync(dataDir, { recursive: true, force: true });
  writeFileSync(path.join(out, 'delete-ui-summary.json'), JSON.stringify({ results, dataDir, note: '使用临时数据目录，未接触项目 data/' }, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  console.log('临时数据目录已删除：', dataDir);
  process.exitCode = failed.length ? 1 : 0;
}
