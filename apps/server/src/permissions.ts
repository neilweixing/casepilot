import { chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function restrictDirectory(directory: string) {
  if (process.platform === 'win32') {
    const account = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    if (!account || /[\r\n]/.test(account)) throw new Error('无法确认 Windows 当前用户，未初始化凭证存储');
    // 使用系统 ACL 限制当前用户访问；Windows chmod 不能代替权限隔离。
    execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`], { stdio: 'pipe', windowsHide: true, timeout: 10000 });
  } else chmodSync(directory, 0o700);
}
