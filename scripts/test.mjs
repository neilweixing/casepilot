import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
const files = readdirSync(new URL('../apps/server/src/', import.meta.url)).filter(name => name.endsWith('.test.ts')).sort().map(name => `apps/server/src/${name}`);
if (!files.length) throw new Error('没有找到业务测试，不能将空测试记为通过');
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
