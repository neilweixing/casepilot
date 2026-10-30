import type { TestCase } from '../../../packages/contracts/src/p0.ts';

export function expectsLoginPage(testCase: TestCase) {
  // “已登录”前置条件不代表登录功能测试，只检查确认后的操作与预期。
  const intent = [...testCase.steps, ...testCase.expectations].join('\n').replace(/登录名/g, '用户名');
  return /登录|登入|登出|注销|(?:修改|重置|更改)密码|\b(?:sign|log)\s*(?:in|out)\b/i.test(intent);
}

export function unexpectedLogin(testCase: TestCase, phase: string, authenticated: boolean, state: Record<string, unknown>, loginURL?: string) {
  if (!authenticated || phase === 'AUTHENTICATING' || expectsLoginPage(testCase) || !(Number(state.visiblePasswords) > 0)) return false;
  if (state.loginForm === true) return true;
  if (!loginURL) return false;
  const current = new URL(String(state.url)), configured = new URL(loginURL);
  return current.origin === configured.origin && current.pathname.replace(/\/+$/, '') === configured.pathname.replace(/\/+$/, '');
}
