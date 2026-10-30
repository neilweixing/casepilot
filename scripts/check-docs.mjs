import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const allFiles = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'data', 'artifacts', '.pnpm-store', 'dist', 'coverage'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else allFiles.push(absolute);
  }
}

async function exists(relative) {
  try { await stat(path.join(root, relative)); return true; } catch { return false; }
}

await walk(root);
const required = [
  'README.md', 'AGENTS.md', 'pnpm-workspace.yaml', 'tsconfig.base.json',
  'docs/p0.md', 'docs/architecture.md', 'docs/execution.md', 'docs/acceptance.md',
  'docs/plan.md', 'docs/decisions.md', 'docs/references.md', 'docs/workflow.md',
  'docs/verification.md', 'docs/tasks/TEMPLATE.md', 'docs/tasks/M1-agent-smoke.md',
  'docs/assets/excel-template.png', 'configs/runtime.example.json',
  'configs/pi-models.example.json', 'configs/pi-mcp.example.json',
  'tests/fixtures/import/normalized-case.example.json',
];
for (const relative of required) {
  if (!await exists(relative)) errors.push('缺少文件：' + relative);
}

let jsonCount = 0;
let linkCount = 0;
let markdownCount = 0;
for (const absolute of allFiles) {
  const relative = path.relative(root, absolute);
  if (absolute.endsWith('.json')) {
    jsonCount++;
    try { JSON.parse(await readFile(absolute, 'utf8')); }
    catch (error) { errors.push(relative + '：JSON 无效，' + error.message); }
  }
  if (!absolute.endsWith('.md')) continue;
  markdownCount++;
  const content = await readFile(absolute, 'utf8');
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const localPath = target.split('#')[0].split('?')[0];
    if (!localPath) continue;
    linkCount++;
    const resolved = path.resolve(path.dirname(absolute), decodeURIComponent(localPath));
    try { await stat(resolved); }
    catch { errors.push(relative + '：本地链接不存在，' + target); }
  }
}

try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'casepilot' || manifest.private !== true) errors.push('根 package 元数据不匹配');
  for (const name of ['dev', 'smoke', 'mcp:check', 'test', 'typecheck']) {
    if (!manifest.scripts?.[name]) errors.push('缺少 M1 实际检查入口：' + name);
  }
  for (const [directory, name] of [
    ['apps/web', '@casepilot/web'],
    ['apps/server', '@casepilot/server'],
    ['packages/contracts', '@casepilot/contracts'],
  ]) {
    const workspace = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    if (workspace.name !== name || workspace.private !== true) errors.push('工作区元数据不匹配：' + directory);
  }
  const mcp = JSON.parse(await readFile(path.join(root, 'configs/pi-mcp.example.json'), 'utf8'));
  if (mcp.mcpServers?.playwright?.enabled !== false) errors.push('MCP 示例应默认禁用');
  const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/import/normalized-case.example.json'), 'utf8'));
  if (fixture.source?.confirmed !== false) errors.push('示例用例不能冒充已确认导入');
} catch (error) { errors.push('元数据检查失败：' + error.message); }

if (errors.length) {
  process.stderr.write(errors.join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('文档与骨架检查通过：' + markdownCount + ' 个 Markdown，' +
    jsonCount + ' 个 JSON，' + linkCount + ' 个本地链接。仅检查文档和配置，不代表业务功能验证。\n');
}
