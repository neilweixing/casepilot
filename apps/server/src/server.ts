import Fastify from 'fastify';
import type { RuntimeConfig } from './config.ts';
import { fixturePage } from './fixture.ts';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.ts';
import { Store } from './storage.ts';
import { registerApi } from './api.ts';
import { registerDemo } from './demo.ts';

export function createServer(config: RuntimeConfig, store?: Store) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== `127.0.0.1:${config.port}`) return reply.code(403).send({ error: '仅接受本机服务地址' });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
  });
  app.get('/health', async () => ({ name: 'casepilot', milestone: 'M1', fixtureRevision: 1 }));
  if (store) { registerApi(app, config, store); registerDemo(app); }
  const webDir = path.join(projectRoot, 'apps/web/dist');
  app.get('/', async (_request, reply) => {
    if (process.env.CASEPILOT_DEV_WEB_ORIGIN === `http://127.0.0.1:${config.port + 1}`) return reply.redirect(process.env.CASEPILOT_DEV_WEB_ORIGIN);
    return reply.type('text/html').send(existsSync(path.join(webDir, 'index.html')) ? readFileSync(path.join(webDir, 'index.html')) : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>CasePilot</h1><p>请先执行 pnpm build 生成 Web 页面，再刷新。M1 验收仍可使用 pnpm smoke。</p></html>');
  });
  app.get<{ Params: { file: string } }>('/assets/:file', async (request, reply) => {
    if (!/^[a-zA-Z0-9_-]+\.(js|css)$/.test(request.params.file)) return reply.code(404).send();
    const file = path.join(webDir, 'assets', request.params.file);
    if (!existsSync(file)) return reply.code(404).send();
    return reply.type(file.endsWith('.css') ? 'text/css' : 'text/javascript').send(readFileSync(file));
  });
  app.get<{ Querystring: { run?: string; variant?: string } }>('/m1/form', async (request, reply) => {
    const { run, variant = 'normal' } = request.query;
    if (!run || !/^[0-9a-f-]{36}$/.test(run) || !['normal', 'reversed'].includes(variant)) {
      return reply.code(400).send({ error: '需要有效的 run 和 variant' });
    }
    return reply.type('text/html').send(fixturePage(run, variant === 'reversed'));
  });
  return app;
}
