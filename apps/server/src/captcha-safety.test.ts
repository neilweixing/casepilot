import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaBudget, CaptchaLimit } from './captcha-safety.ts';

test('验证码提交只接受当前页面最新且确实发给模型的图片，每张只能提交一次', () => {
  const b = new CaptchaBudget(3);
  b.capture('image-1', 'http://local/login');
  assert.throws(() => b.submit('image-1', 'http://local/login', false), /未实际/);
  assert.throws(() => b.submit('image-1', 'http://local/other', true), /过期/);
  b.capture('image-2', 'http://local/login');
  assert.throws(() => b.submit('image-1', 'http://local/login', true), /过期/);
  assert.equal(b.submit('image-2', 'http://local/login', true), 1);
  assert.throws(() => b.submit('image-2', 'http://local/login', true), /已提交/);
  assert.throws(() => b.capture('same-image-new-id', 'http://local/login'), /已提交/);
  assert.throws(() => b.refresh(), /尚未明确/);
});

test('截图、刷新和提交各有预算，重新导航或刷新不能重置累计次数', () => {
  const b = new CaptchaBudget(3);
  for (let i = 1; i <= 3; i++) {
    b.capture(`image-${i}`, 'http://local/login');
    assert.equal(b.submit(`image-${i}`, 'http://local/login', true), i);
    if (i < 3) b.refresh(true);
  }
  b.invalidate();
  assert.throws(() => b.capture('image-4', 'http://local/login'), CaptchaLimit);
  assert.throws(() => b.refresh(), CaptchaLimit);
  assert.deepEqual(b.counts, { captures: 3, submissions: 3, refreshes: 2 });
});

test('刷新立即使旧图片失效；一次预算不允许刷新', () => {
  const b = new CaptchaBudget(3); b.capture('image-1', 'http://local/login'); b.refresh();
  assert.throws(() => b.submit('image-1', 'http://local/login', true), /过期/);
  assert.throws(() => new CaptchaBudget(1).refresh(), CaptchaLimit);
});

test('导航后给同一已提交图像换证据 ID，也不能重复提交', () => {
  const b = new CaptchaBudget(3);
  b.capture('image-1', 'http://local/login', 'same-pixels');
  b.submit('image-1', 'http://local/login', true); b.invalidate();
  assert.throws(() => b.capture('new-id', 'http://local/login/again', 'same-pixels'), /已提交/);
  b.capture('fresh-image', 'http://local/login/again', 'different-pixels');
  assert.equal(b.submit('fresh-image', 'http://local/login/again', true), 2);
});
