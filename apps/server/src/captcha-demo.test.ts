import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerCaptchaDemo } from './captcha-demo.ts';

// 契约测试可读取合成 SVG 的答案来验证目标本身；真实 Agent 验收不读取 SVG 源码或答案接口。
test('图片目标不在 HTML/地址/计数中提供答案，刷新后旧图验证码失效', async () => {
  const app = Fastify(); registerCaptchaDemo(app); const base = `/demo/image-captcha/${randomUUID()}`;
  try {
    const page = (await app.inject(`${base}/login`)).body;
    const src = page.match(/src="([^"]+)"/)![1]!;
    const svg = (await app.inject(src)).body, code = [...svg.matchAll(/<text[^>]*>(.)<\/text>/g)].map(m => m[1]).join('');
    assert.equal(code.length, 6); assert.ok(!page.includes(code));
    const counts = (await app.inject(`${base}/count`)).json(); assert.ok(!JSON.stringify(counts).includes(code));
    await app.inject({ method: 'POST', url: `${base}/refresh` });
    assert.equal((await app.inject(src)).statusCode, 404);
    const reply = await app.inject({ method: 'POST', url: `${base}/login`, payload: { username: 'demo-user', password: 'demo-password', captcha: code, imageKey: src.split('/').at(-1) } });
    assert.equal(reply.statusCode, 401);
    assert.equal((await app.inject(`${base}/protected`)).statusCode, 302);
  } finally { await app.close(); }
});

test('首次失效场景确实拒绝正确识别，刷新新图后才建立真实会话', async () => {
  const app = Fastify(); registerCaptchaDemo(app); const base = `/demo/image-captcha/${randomUUID()}`;
  try {
    let image = (await app.inject(`${base}/login/retry`)).body.match(/src="([^"]+)"/)![1]!;
    for (let i = 0; i < 2; i++) {
      const svg = (await app.inject(image)).body, code = [...svg.matchAll(/<text[^>]*>(.)<\/text>/g)].map(m => m[1]).join('');
      const reply = await app.inject({ method: 'POST', url: `${base}/login`, payload: { username: 'demo-user', password: 'demo-password', captcha: code, imageKey: image.split('/').at(-1) } });
      assert.equal(reply.statusCode, i === 0 ? 401 : 200);
      if (i === 0) {
        const old = await app.inject({ method: 'POST', url: `${base}/login`, payload: { username: 'demo-user', password: 'demo-password', captcha: code, imageKey: image.split('/').at(-1) } });
        assert.equal(old.statusCode, 401, '失效旧图不能靠再次提交登录成功');
        image = (await app.inject({ method: 'POST', url: `${base}/refresh` })).json<{ image: string }>().image;
      }
      else assert.equal((await app.inject({ url: `${base}/protected`, headers: { cookie: String(reply.headers['set-cookie']).split(';')[0]! } })).statusCode, 200);
    }
    assert.deepEqual((await app.inject(`${base}/count`)).json(), { issued: 2, refreshes: 1, submissions: 3, correct: 2, successes: 1, businessWrites: 0 });
  } finally { await app.close(); }
});
