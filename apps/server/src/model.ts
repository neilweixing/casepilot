import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelConfig } from './config.ts';

export async function modelRuntime(config: ModelConfig) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  // 全部取自页面配置；未配置的字段由 providerDefaults 提供历史默认值。
  runtime.registerProvider('casepilot', { api: 'openai-completions', baseUrl: config.baseURL, authHeader: true, models: [{ id: config.modelId, name: config.modelId, reasoning: config.reasoning, input: config.input, contextWindow: config.contextWindow, maxTokens: config.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  await runtime.setRuntimeApiKey('casepilot', config.apiKey);
  const model = runtime.getModel('casepilot', config.modelId);
  if (!model) throw new Error('模型未注册');
  return { runtime, model };
}
