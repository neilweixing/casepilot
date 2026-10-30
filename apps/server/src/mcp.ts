import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { StdioTransport } from '@earendil-works/pi-mcp';

const require = createRequire(import.meta.url);
export const mcpTool = (name: string) => `mcp__playwright__${name}`;
export const browserTools = ['browser_navigate', 'browser_snapshot', 'browser_fill_form', 'browser_click', 'browser_evaluate', 'browser_take_screenshot'] as const;

export function browserTransport(outputDir: string, origin: string | string[], idleTimeoutMs = 60000, snapshotMode: 'full' | 'none' = 'full') {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'DISPLAY', 'XAUTHORITY', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return new StdioTransport({
    command: process.execPath,
    args: [path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'),
      '--browser', 'chrome', '--isolated', '--no-webmcp', '--block-service-workers',
      '--image-responses', 'allow', '--viewport-size', '1280x900', '--codegen', 'none', '--snapshot-mode', snapshotMode,
      '--allowed-origins', Array.isArray(origin) ? origin.join(';') : origin, '--output-dir', outputDir,
      '--timeout-action', '5000', '--timeout-navigation', '10000', '--idle-timeout', String(idleTimeoutMs)],
    cwd: outputDir, env, inheritEnv: false, stderr: 'pipe', closeTimeoutMs: 2000,
  });
}

export function processExists(pid: number | undefined) {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export function parseProcessTable(output: string, platform: NodeJS.Platform): number[][] {
  if (platform === 'win32') {
    const parsed = JSON.parse(output || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(row => [Number(row.ProcessId), Number(row.ParentProcessId)]);
  }
  return output.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
}

export function descendantPids(pid: number | undefined) {
  if (!pid) return [];
  // 只读取进程编号与父编号，不采集可能包含凭证的命令行。
  const output = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    : execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 10000 });
  const rows = parseProcessTable(output, process.platform);
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parent] of rows) {
      if (child && parent && (parent === pid || descendants.has(parent)) && !descendants.has(child)) { descendants.add(child); changed = true; }
    }
  }
  return [...descendants];
}
