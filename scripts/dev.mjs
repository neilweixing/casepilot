import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const port = Number(process.env.CASEPILOT_PORT || 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error('开发模式请使用 1024–65534 之间的服务端口，需另留一个相邻端口给前端');
const children = [
  spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', 'apps/server/src/main.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, CASEPILOT_DEV_WEB_ORIGIN: `http://127.0.0.1:${port + 1}` } }),
  spawn(process.execPath, [vite, '--config', 'apps/web/vite.config.ts', 'apps/web'], { cwd: root, stdio: 'inherit', env: process.env }),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
for (const child of children) {
  child.on('error', () => { process.exitCode = 1; stop(); });
  child.on('exit', code => { if (!stopping) { process.exitCode = code || 1; stop(); } });
}
console.log(`开发模式：前端自动更新 http://127.0.0.1:${port + 1}；后端修改后自动重载。`);
