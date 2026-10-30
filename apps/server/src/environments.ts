import { randomUUID } from 'node:crypto';
import type { Environment, System } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';

function text(value: unknown, name: string, required = true) {
  if (typeof value !== 'string' || value.length > 2000 || (required && !value.trim())) throw new Error(`${name}无效`);
  return value.trim();
}
function url(value: unknown, name: string) {
  const result = new URL(text(value, name));
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password || result.hash || result.search) throw new Error(`${name}必须是不含凭证、查询参数和片段的 HTTP(S) 地址`);
  return result.href;
}
export function publicEnvironment(env: Environment) {
  const { credentialRef: _ref, captchaCode: _code, ...visible } = env;
  return visible;
}
export function saveEnvironment(store: Store, input: Record<string, unknown>, id: string = randomUUID()) {
  const existing = input.id ? store.get<Environment>('environment', id) : undefined;
  const systemId = text(input.systemId, '系统');
  store.get<System>('system', systemId);
  const strategy = input.captchaStrategy || 'none';
  if (!['none', 'image', 'test-code', 'manual'].includes(String(strategy))) throw new Error('验证码方式无效');
  let credentialRef = existing?.credentialRef || '', hasPassword = existing?.hasPassword || false;
  const oldSecret = existing ? JSON.parse(store.secret(existing.credentialRef)) as { password: string; captchaCode: string } : { password: '', captchaCode: '' };
  const captchaCode = typeof input.captchaCode === 'string' && input.captchaCode.length > 0 ? input.captchaCode : oldSecret.captchaCode;
  if (strategy === 'test-code' && !captchaCode) throw new Error('请填写测试专用验证码');
  if (typeof input.password === 'string' && input.password.length > 0) {
    if (input.password.length > 1000) throw new Error('密码过长');
    credentialRef = store.password(JSON.stringify({ password: input.password, captchaCode }));
    hasPassword = true;
  } else if (!credentialRef || captchaCode !== oldSecret.captchaCode) credentialRef = store.password(JSON.stringify({ password: oldSecret.password, captchaCode }));
  const environment: Environment = { id, systemId, name: text(input.name, '环境名称'), baseURL: url(input.baseURL, '系统地址'), loginURL: input.loginURL ? url(input.loginURL, '登录地址') : '', username: text(input.username ?? '', '用户名', false), credentialRef, hasPassword, captchaStrategy: strategy as Environment['captchaStrategy'], captchaCode: '', createdAt: existing?.createdAt || new Date().toISOString() };
  if (environment.username && !hasPassword) throw new Error('设置用户名时请同时填写密码');
  return store.put('environment', environment);
}
