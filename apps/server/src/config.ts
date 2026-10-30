import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { ThinkingLevel } from '../../../packages/contracts/src/p0.ts';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function integer(value: string | undefined, fallback: number, name: string, min: number, max: number) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} 必须在 ${min}–${max} 之间`);
  return number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.CASEPILOT_HOST || '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('M1 服务仅允许绑定 127.0.0.1');
  const port = integer(env.CASEPILOT_PORT, 4310, 'CASEPILOT_PORT', 1024, 65535);
  const dataDir = path.resolve(projectRoot, env.CASEPILOT_DATA_DIR || './data');
  if ([projectRoot, homedir(), path.parse(dataDir).root].includes(dataDir)) throw new Error('数据目录必须是专用子目录，不能使用项目根目录、用户主目录或磁盘根目录');
  return {
    host, port,
    origin: `http://${host}:${port}`,
    dataDir,
    timeoutMs: integer(env.CASEPILOT_CASE_TIMEOUT_MS, 300_000, 'CASEPILOT_CASE_TIMEOUT_MS', 1000, 900_000),
    stepRecoveryAttempts: integer(env.CASEPILOT_STEP_RECOVERY_ATTEMPTS, 2, 'CASEPILOT_STEP_RECOVERY_ATTEMPTS', 0, 5),
    stepRecoveryTimeoutMs: integer(env.CASEPILOT_STEP_RECOVERY_TIMEOUT_MS, 120_000, 'CASEPILOT_STEP_RECOVERY_TIMEOUT_MS', 1000, 300_000),
    captchaAttempts: integer(env.CASEPILOT_CAPTCHA_ATTEMPTS, 3, 'CASEPILOT_CAPTCHA_ATTEMPTS', 1, 5),
    maxToolCalls: 30,
    runnerEnabled: env.CASEPILOT_ENABLE_RUNNER === '1',
  };
}

export function loadModelConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = ['CASEPILOT_BASE_URL', 'CASEPILOT_MODEL_ID', 'CASEPILOT_API_KEY'] as const;
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`模型配置不完整：请在 .env 填写 ${missing.join('、')}`);
  let url: URL;
  try { url = new URL(env.CASEPILOT_BASE_URL!); }
  catch { throw new Error('CASEPILOT_BASE_URL 必须是有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CASEPILOT_BASE_URL 仅接受不含凭证、查询参数或片段的 HTTP(S) 地址');
  }
  if (url.hostname.endsWith('.invalid') || env.CASEPILOT_MODEL_ID!.startsWith('replace-with-')) {
    throw new Error('请将模型示例地址和 modelId 替换为真实配置');
  }
  return { baseURL: url.href.replace(/\/$/, ''), modelId: env.CASEPILOT_MODEL_ID!.trim(), apiKey: env.CASEPILOT_API_KEY!.trim(), contextWindow: 65536, maxTokens: 4096, input: ['text', 'image'] as ('text' | 'image')[], reasoning: false, thinkingLevel: 'off' as ThinkingLevel };
}

export type RuntimeConfig = ReturnType<typeof loadConfig>;
export type ModelConfig = ReturnType<typeof loadModelConfig>;

export function redact(text: string, secrets: string[]) {
  return secrets.filter(Boolean).reduce((value, secret) => value.split(secret).join('[REDACTED]'), text);
}
