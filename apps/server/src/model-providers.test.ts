import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './storage.ts';
import { activateProvider, listProviders, removeProvider, resolveModelConfig, saveProvider } from './model-providers.ts';

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'casepilot-provider-'));
  const store = new Store(directory);
  return { directory, store, cleanup() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const input = (name: string, modelId = 'openai/demo-model') => ({ name, baseURL: 'https://gateway.example.com/v1', modelId, apiKey: `key-${name}` });

test('新增的第一个提供商自动启用，页面数据不含密钥引用', () => {
  const h = setup();
  try {
    const created = saveProvider(h.store, input('甲'));
    assert.equal(created.active, true);
    assert.equal(created.hasApiKey, true);
    assert.ok(!('credentialRef' in created), '页面响应不能带 credentialRef');
    const listed = listProviders(h.store);
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes('key-甲'), '列表不能回显密钥');
  } finally { h.cleanup(); }
});

test('运行时只读取启用的提供商，密钥解密后可还原', () => {
  const h = setup();
  try {
    assert.throws(() => resolveModelConfig(h.store), /尚未配置模型提供商/);
    const a = saveProvider(h.store, input('甲'));
    const b = saveProvider(h.store, input('乙', 'other/model'));
    assert.equal(listProviders(h.store).filter(p => p.active).length, 1, '同时只能有一个启用');
    assert.equal(resolveModelConfig(h.store).modelId, 'openai/demo-model');
    activateProvider(h.store, b.id);
    const config = resolveModelConfig(h.store);
    assert.equal(config.modelId, 'other/model');
    assert.equal(config.apiKey, 'key-乙');
    assert.equal(config.baseURL, 'https://gateway.example.com/v1');
    assert.equal(activateProvider(h.store, a.id).active, true);
  } finally { h.cleanup(); }
});

test('编辑时留空密钥保留原值，填写新密钥则替换并清理旧凭证', () => {
  const h = setup();
  try {
    const created = saveProvider(h.store, input('甲'));
    saveProvider(h.store, { name: '甲改名', baseURL: 'https://gateway.example.com/v1', modelId: 'm2', apiKey: '' }, created.id);
    assert.equal(resolveModelConfig(h.store).apiKey, 'key-甲', '留空应保留原密钥');
    assert.equal(resolveModelConfig(h.store).modelId, 'm2');
    saveProvider(h.store, { name: '甲', baseURL: 'https://gateway.example.com/v1', modelId: 'm2', apiKey: 'new-key' }, created.id);
    assert.equal(resolveModelConfig(h.store).apiKey, 'new-key');
  } finally { h.cleanup(); }
});

test('删除最后一个提供商被拒绝；删除激活项会切换到剩余项', () => {
  const h = setup();
  try {
    const a = saveProvider(h.store, input('甲'));
    assert.throws(() => removeProvider(h.store, a.id), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /至少保留一个/.test(error.message));
    const b = saveProvider(h.store, input('乙', 'other/model'));
    activateProvider(h.store, b.id);
    removeProvider(h.store, b.id);
    const rest = listProviders(h.store);
    assert.equal(rest.length, 1);
    assert.equal(rest[0]!.active, true, '删除激活项后剩余项应自动启用');
    assert.equal(resolveModelConfig(h.store).modelId, 'openai/demo-model');
  } finally { h.cleanup(); }
});

test('非法输入被拒绝，且不回显密钥到错误信息', () => {
  const h = setup();
  try {
    assert.throws(() => saveProvider(h.store, { ...input('甲'), baseURL: 'not-a-url' }), /接口地址/);
    assert.throws(() => saveProvider(h.store, { ...input('甲'), baseURL: 'https://u:secret@example.com/v1' }), error => error instanceof Error && !error.message.includes('secret'));
    assert.throws(() => saveProvider(h.store, { ...input('甲'), modelId: 'replace-with-your-model-id' }), /真实的接口地址与模型 ID/);
    assert.throws(() => saveProvider(h.store, { name: '', baseURL: 'https://a.example.com/v1', modelId: 'm', apiKey: 'k' }), /提供商名称无效/);
  } finally { h.cleanup(); }
});

test('自定义配置：窗口与输出上限有边界，且输出不得超过上下文窗口', () => {
  const h = setup();
  try {
    const base = { name: '甲', baseURL: 'https://a.example.com/v1', modelId: 'm', apiKey: 'k' };
    assert.throws(() => saveProvider(h.store, { ...base, contextWindow: 1023 }), /上下文窗口必须是 1024–2000000/);
    assert.throws(() => saveProvider(h.store, { ...base, contextWindow: 2000001 }), /上下文窗口/);
    assert.throws(() => saveProvider(h.store, { ...base, maxTokens: 255 }), /最大输出 token 数/);
    assert.throws(() => saveProvider(h.store, { ...base, contextWindow: 4096, maxTokens: 8192 }), /不能超过上下文窗口/);
    // 未填写时使用与改造前一致的默认值。
    const created = saveProvider(h.store, base);
    assert.equal(created.contextWindow, 65536);
    assert.equal(created.maxTokens, 4096);
    assert.equal(created.reasoning, false);
    assert.equal(created.thinkingLevel, 'off');
  } finally { h.cleanup(); }
});

test('推理关闭时思考档位只能是 off；文本输入必须开启', () => {
  const h = setup();
  try {
    const base = { name: '甲', baseURL: 'https://a.example.com/v1', modelId: 'm', apiKey: 'k' };
    assert.throws(() => saveProvider(h.store, { ...base, reasoning: false, thinkingLevel: 'high' }), /未开启推理时思考档位只能是 off/);
    assert.throws(() => saveProvider(h.store, { ...base, inputText: false }), /必须支持文本输入/);
    assert.throws(() => saveProvider(h.store, { ...base, thinkingLevel: 'ultra' }), /思考档位无效/);
    const ok = saveProvider(h.store, { ...base, reasoning: true, thinkingLevel: 'xhigh', inputImage: false });
    assert.equal(ok.thinkingLevel, 'xhigh');
    assert.equal(ok.inputImage, false);
    // 关闭图像后运行时只声明文本输入，验证码类预期会明确失败而不是假装支持。
    assert.deepEqual(resolveModelConfig(h.store).input, ['text']);
  } finally { h.cleanup(); }
});

test('改造前保存的旧记录缺少自定义字段时回落到默认值，不能变成空输入类型', () => {
  const h = setup();
  try {
    // 直接写入改造前格式的记录，模拟已有数据库。
    const ref = h.store.password('legacy-key');
    h.store.put('model-provider', { id: 'legacy', name: '旧配置', baseURL: 'https://a.example.com/v1', modelId: 'm', credentialRef: ref, hasApiKey: true, createdAt: '' });
    h.store.put('model-active', { id: 'active', providerId: 'legacy' });
    const config = resolveModelConfig(h.store);
    assert.deepEqual(config.input, ['text', 'image'], '旧记录必须仍声明文本与图像输入');
    assert.equal(config.contextWindow, 65536);
    assert.equal(config.maxTokens, 4096);
    assert.equal(config.reasoning, false);
    assert.equal(config.thinkingLevel, 'off');
    assert.equal(config.apiKey, 'legacy-key');
  } finally { h.cleanup(); }
});
