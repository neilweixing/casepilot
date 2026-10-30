import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { observeUI } from './ui-observation.ts';

function harness() {
  const element = (y: number) => ({ textContent: '', value: '', getBoundingClientRect: () => ({ x: 20, y, width: 300, height: 40, bottom: y + 40, right: 320 }) });
  const date = element(80), name = element(160);
  const refs: Record<string, object> = { f1e11: date, f1e9: name, e11: date };
  const selectors: Record<string, object[]> = { '#date': [date], '#name': [name], input: [date, name] };
  const context = { location: { href: 'http://127.0.0.1:4310/demo/reversed' }, innerWidth: 1280, innerHeight: 900, scrollX: 0, scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    document: { querySelectorAll: (selector: string) => selectors[selector] || [] } };
  const targets: (string | undefined)[] = [];
  const evaluate = async (expression: string, target?: string) => {
    targets.push(target);
    if (target && !refs[target]) throw new Error('快照引用已失效');
    return (runInNewContext(expression, context) as (element?: object) => Record<string, unknown>)(target ? refs[target] : undefined);
  };
  return { context, evaluate, targets };
}

test('快照引用由原生目标解析，反序几何关系与混合 CSS 目标保持一致', async () => {
  const h = harness();
  const data = await observeUI(h.evaluate, 'f1e11', 'position', 'f1e9');
  assert.deepEqual(h.targets, ['f1e11', 'f1e9']);
  assert.equal(data.rect!.y, 80); assert.equal(data.otherRect!.y, 160);
  assert.equal(data.below, false); assert.equal(data.above, true);
  const opposite = await observeUI(h.evaluate, 'f1e9', 'position', 'f1e11');
  assert.equal(opposite.below, true); assert.equal(opposite.above, false);
  const mixed = await observeUI(h.evaluate, 'e11', 'position', '#name');
  assert.equal(mixed.above, true); assert.equal(mixed.below, false);
});

test('目标缺失、选择器歧义或旧引用不能产生可靠位置证据', async () => {
  const h = harness();
  await assert.rejects(() => observeUI(h.evaluate, 'f1e11', 'position'), /两个目标/);
  await assert.rejects(() => observeUI(h.evaluate, '#missing', 'position', 'f1e9'), /实际存在/);
  await assert.rejects(() => observeUI(h.evaluate, 'input', 'position', 'f1e9'), /多个元素/);
  await assert.rejects(() => observeUI(h.evaluate, 'f2e11', 'position', 'f1e9'), /引用已失效/);
  assert.equal((await observeUI(h.evaluate, '#missing', 'visible')).exists, false);
});

test('两次读取之间发生导航或滚动时拒绝位置判断', async () => {
  for (const change of ['navigation', 'scroll']) {
    const h = harness(); let count = 0;
    const evaluate = async (expression: string, target?: string) => {
      if (++count === 2) {
        if (change === 'navigation') h.context.location.href += '?next=1';
        else h.context.scrollY = 20;
      }
      return h.evaluate(expression, target);
    };
    await assert.rejects(() => observeUI(evaluate, 'f1e11', 'position', 'f1e9'), /观察期间发生变化/);
  }
});

test('选择器中的引号和脚本文本只作为数据传入，不成为页面脚本', async () => {
  const h = harness();
  await observeUI(h.evaluate, '\");globalThis.injected=true;//', 'visible');
  assert.equal('injected' in h.context, false);
});
