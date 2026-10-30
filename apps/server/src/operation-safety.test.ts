import test from 'node:test';
import assert from 'node:assert/strict';
import { StepRecovery, RecoveryLimit, MutationFence } from './operation-safety.ts';

test('定位失败需新快照，最多初次尝试加两次恢复，成功不清空累计次数', () => {
  const r = new StepRecovery(2, 1000);
  assert.equal(r.failed(0), 1); assert.throws(() => r.beforeTarget(1), /快照/);
  r.snapshot(2); r.beforeTarget(3); r.resolved(4);
  assert.equal(r.failed(10), 2); r.snapshot(11); r.beforeTarget(12); r.resolved(13);
  assert.throws(() => r.failed(20), RecoveryLimit);
  assert.equal(r.failures, 3);
});

test('恢复累计时间有边界，快照不能重置时限，正常执行不消耗恢复时间', () => {
  const r = new StepRecovery(5, 100);
  r.failed(1000); r.snapshot(1030); r.resolved(1060);
  assert.equal(r.remaining(5000), 40);
  r.failed(6000); r.snapshot(6010); r.beforeTarget(6039);
  assert.throws(() => r.beforeTarget(6040), /恢复时间/);
});

test('显式暂停不消耗恢复时间，零恢复次数首个定位失败即退出', () => {
  const r = new StepRecovery(2, 100);
  r.failed(0); r.pause(1000); r.snapshot(1050); r.beforeTarget(1099);
  assert.throws(() => r.beforeTarget(1100), RecoveryLimit);
  assert.throws(() => new StepRecovery(0, 100).failed(0), RecoveryLimit);
});

test('未确认的写操作阻止任何后续写入，不能通过改标签、目标或按键重放', () => {
  const f = new MutationFence(); f.begin('click', 'button:create');
  for (const action of ['click', 'press', 'fill', 'select']) assert.throws(() => f.begin(action, 'different-target'), /结果不确定/);
  assert.equal(f.pending, true);
});

test('收到回执后允许其他明确动作，但同一步骤同一点击或按键不能再次发出', () => {
  const f = new MutationFence(); f.begin('click', 'stable-button'); f.acknowledge();
  assert.throws(() => f.begin('click', 'stable-button'), /重复/);
  f.begin('fill', 'name'); f.acknowledge(); f.begin('fill', 'name'); f.acknowledge();
  f.begin('press', 'input:Enter'); f.acknowledge(); assert.throws(() => f.begin('press', 'input:Enter'), /重复/);
  f.begin('click', 'other-button'); f.acknowledge(); assert.equal(f.pending, false);
});
