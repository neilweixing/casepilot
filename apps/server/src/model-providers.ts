import { randomUUID } from 'node:crypto';
import { thinkingLevels, type ModelProvider, type PublicModelProvider, type ThinkingLevel } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';
import type { ModelConfig } from './config.ts';

// 提供商落盘时 apiKey 单独加密存 credentials 目录，记录里只留 credentialRef。
interface StoredProvider {
  id: string; name: string; baseURL: string; modelId: string;
  contextWindow: number; maxTokens: number;
  inputText: boolean; inputImage: boolean;
  reasoning: boolean; thinkingLevel: ThinkingLevel;
  credentialRef: string; hasApiKey: boolean; createdAt: string;
}

// 默认值与改造前 model.ts 的写死值一致，保证未配置的提供商行为不变。
export const providerDefaults = { contextWindow: 65536, maxTokens: 4096, inputText: true, inputImage: true, reasoning: false, thinkingLevel: 'off' as ThinkingLevel };

const kind = 'model-provider';
const activeKind = 'model-active';

export function listProviders(store: Store): PublicModelProvider[] {
  const activeId = activeProviderId(store);
  return store.list<StoredProvider>(kind).map(({ credentialRef: _ref, ...visible }) => ({ ...visible, api: 'openai-completions' as const, active: visible.id === activeId }));
}

// 激活状态是单例记录：键固定为 'active'，值内部保存 providerId。
export function activeProviderId(store: Store): string | undefined {
  try { return store.get<{ id: string; providerId?: string }>(activeKind, 'active').providerId; } catch { return undefined; }
}

function validate(input: Record<string, unknown>) {
  const text = (value: unknown, name: string, max = 2000) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}无效`);
    return value.trim();
  };
  const name = text(input.name, '提供商名称', 100);
  const modelId = text(input.modelId, '模型 ID', 200);
  let url: URL;
  try { url = new URL(text(input.baseURL, '接口地址')); }
  catch { throw new Error('接口地址必须是有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址仅接受不含凭证、查询参数或片段的 HTTP(S) 地址');
  }
  if (url.hostname.endsWith('.invalid') || modelId.startsWith('replace-with-')) throw new Error('请填写真实的接口地址与模型 ID');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (apiKey.length > 1000) throw new Error('API 密钥过长');

  const tokenCount = (value: unknown, field: string, min: number, max: number, fallback: number) => {
    if (value === undefined || value === '' || value === null) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${field}必须是 ${min}–${max} 之间的整数`);
    return n;
  };
  const contextWindow = tokenCount(input.contextWindow, '上下文窗口', 1024, 2_000_000, providerDefaults.contextWindow);
  const maxTokens = tokenCount(input.maxTokens, '最大输出 token 数', 256, 1_000_000, providerDefaults.maxTokens);
  // 输出不可能超过上下文窗口，否则请求必然被上游拒绝。
  if (maxTokens > contextWindow) throw new Error('最大输出 token 数不能超过上下文窗口');

  const flag = (value: unknown, fallback: boolean) => value === undefined ? fallback : value === true;
  const inputText = flag(input.inputText, providerDefaults.inputText);
  const inputImage = flag(input.inputImage, providerDefaults.inputImage);
  // 执行器依赖文本输入；图像关闭时验证码与视觉预期会明确失败，属预期行为。
  if (!inputText) throw new Error('必须支持文本输入');

  const reasoning = flag(input.reasoning, providerDefaults.reasoning);
  const level = (input.thinkingLevel ?? providerDefaults.thinkingLevel) as ThinkingLevel;
  if (!thinkingLevels.includes(level)) throw new Error('思考档位无效');
  if (!reasoning && level !== 'off') throw new Error('未开启推理时思考档位只能是 off');

  return { name, modelId, baseURL: url.href.replace(/\/$/, ''), apiKey, contextWindow, maxTokens, inputText, inputImage, reasoning, thinkingLevel: level };
}

export function saveProvider(store: Store, input: Record<string, unknown>, id: string = randomUUID()): PublicModelProvider {
  const existing = store.has(kind, id) ? store.get<StoredProvider>(kind, id) : undefined;
  const value = validate(input);
  let credentialRef = existing?.credentialRef ?? '';
  // 留空表示保留原密钥；首次创建必须提供。
  if (value.apiKey) credentialRef = store.password(value.apiKey);
  else if (!credentialRef) throw new Error('首次添加提供商需要填写 API 密钥');
  const provider: StoredProvider = {
    id, name: value.name, baseURL: value.baseURL, modelId: value.modelId,
    contextWindow: value.contextWindow, maxTokens: value.maxTokens,
    inputText: value.inputText, inputImage: value.inputImage,
    reasoning: value.reasoning, thinkingLevel: value.thinkingLevel,
    credentialRef, hasApiKey: true,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  if (existing && credentialRef !== existing.credentialRef) store.removeSecret(existing.credentialRef);
  // 先写记录再决定激活，避免首个提供商因记录尚未落盘而读不到。
  store.put(kind, provider);
  if (!activeProviderId(store)) store.put(activeKind, { id: 'active', providerId: id });
  const { credentialRef: _ref, ...visible } = provider;
  return { ...visible, api: 'openai-completions' as const, active: activeProviderId(store) === id };
}

export function activateProvider(store: Store, id: string): PublicModelProvider {
  if (!store.has(kind, id)) throw Object.assign(new Error('模型提供商不存在'), { statusCode: 404 });
  store.put(activeKind, { id: 'active', providerId: id });
  return listProviders(store).find(p => p.id === id)!;
}

export function removeProvider(store: Store, id: string) {
  const provider = store.get<StoredProvider>(kind, id);
  const others = store.list<StoredProvider>(kind).filter(p => p.id !== id);
  if (!others.length) throw Object.assign(new Error('至少保留一个模型提供商；如需停用请先添加替代配置'), { statusCode: 409 });
  store.remove(kind, id);
  store.removeSecret(provider.credentialRef);
  // 删除的是当前激活项时，切到剩余最近的一个，避免运行时无模型。
  if (activeProviderId(store) === id) store.put(activeKind, { id: 'active', providerId: others[0]!.id });
  return { deleted: 'model-provider' as const, id, active: others[0]!.id };
}

// 运行时读取：只用页面配置的激活提供商，不再回落 .env。
export function resolveModelConfig(store: Store): ModelConfig {
  const id = activeProviderId(store);
  if (!id) throw new Error('尚未配置模型提供商，请在设置中添加并启用');
  const provider = store.get<StoredProvider>(kind, id);
  let apiKey: string;
  // password() 存的是裸字符串，不能按 JSON 解析。
  try { apiKey = store.secret(provider.credentialRef); }
  catch { throw new Error('模型提供商的 API 密钥不可读取，请在设置中重新填写'); }
  // 改造前保存的记录缺少自定义字段，必须回落到默认值；
  // 否则输入类型会变成空数组，模型将声明不支持任何输入而完全不可用。
  const d = providerDefaults;
  const contextWindow = provider.contextWindow ?? d.contextWindow;
  const inputText = provider.inputText ?? d.inputText;
  const inputImage = provider.inputImage ?? d.inputImage;
  return {
    baseURL: provider.baseURL, modelId: provider.modelId, apiKey,
    contextWindow, maxTokens: provider.maxTokens ?? d.maxTokens,
    input: [...(inputText ? ['text' as const] : []), ...(inputImage ? ['image' as const] : [])],
    reasoning: provider.reasoning ?? d.reasoning,
    thinkingLevel: provider.thinkingLevel ?? d.thinkingLevel,
  };
}
