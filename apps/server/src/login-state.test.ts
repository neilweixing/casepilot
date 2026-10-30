import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestCase } from '../../../packages/contracts/src/p0.ts';
import { expectsLoginPage, unexpectedLogin } from './login-state.ts';

const business = { steps: ['打开表单', '点击提交'], expectations: ['提示成功'], preconditions: ['已登录系统'] } as TestCase;
const state = { url: 'http://127.0.0.1:4310/demo/login', visiblePasswords: 1, loginForm: true };

test('已登录的普通业务流程意外出现登录表单，需暂停而非判为产品失败', () => {
  assert.equal(expectsLoginPage(business), false);
  assert.equal(expectsLoginPage({ ...business, steps: ['填写登录名并保存'], expectations: ['登录名正确显示'] }), false);
  for (const phase of ['PREPARING', 'EXECUTING', 'VERIFYING']) assert.equal(unexpectedLogin(business, phase, true, state), true);
  assert.equal(unexpectedLogin(business, 'AUTHENTICATING', true, state), false);
  assert.equal(unexpectedLogin(business, 'EXECUTING', false, state), false);
});
test('配置登录地址可辅助识别，无可见密码框或普通密码设置页不能单独证明失效', () => {
  const url = 'http://127.0.0.1:4310/demo/login';
  assert.equal(unexpectedLogin(business, 'EXECUTING', true, { ...state, loginForm: false }, url), true);
  assert.equal(unexpectedLogin(business, 'EXECUTING', true, { ...state, visiblePasswords: 0 }, url), false);
  assert.equal(unexpectedLogin(business, 'EXECUTING', true, { url }, url), false);
  assert.equal(unexpectedLogin(business, 'EXECUTING', true, { ...state, loginForm: false, url: 'http://127.0.0.1:4310/settings' }, url), false);
});
test('明确的登录、退出及密码测试按确认内容执行，不自动当作环境故障', () => {
  for (const steps of [['点击登录按钮'], ['退出登录并检查页面'], ['修改密码'], ['Log out']]) {
    const loginCase = { ...business, steps };
    assert.equal(expectsLoginPage(loginCase), true);
    assert.equal(unexpectedLogin(loginCase, 'EXECUTING', true, state), false);
  }
  assert.equal(unexpectedLogin({ ...business, expectations: ['页面显示登录表单'] }, 'VERIFYING', true, state), false);
});
