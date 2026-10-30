import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// 普通字符图片的独立合成目标。答案只保存在目标端，不放入页面文本、地址或计数响应。
export function registerCaptchaDemo(app: FastifyInstance) {
  type State = { mode: string; code: string; imageKey: string; invalid: boolean; issued: number; refreshes: number; submissions: number; correct: number; successes: number; businessWrites: number; tokens: Set<string> };
  const states = new Map<string, State>();
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const issue = (s: State) => { s.code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); s.imageKey = randomUUID(); s.invalid = false; s.issued++; };
  const valid = (id: string) => /^[0-9a-f-]{36}$/.test(id);
  const authenticated = (s: State, cookie?: string) => s.tokens.has(cookie?.match(/casepilot_image_demo=([0-9a-f-]+)/)?.[1] || '');
  const page = (body: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>普通图片验证码验收</title><style>body{font:17px/1.7 system-ui;background:#faf9f6;color:#282724;max-width:640px;margin:50px auto}main{background:white;padding:30px;border:1px solid #ddd;border-radius:12px}label{display:block;margin:14px 0}input{display:block;font:inherit;padding:9px;width:85%}button{font:inherit;padding:9px 18px;margin:12px 8px 0 0}img{display:block;border:1px solid #aaa}output{display:block;margin-top:18px;color:#8c3428}</style><main>${body}</main></html>`;
  app.get<{ Params: { id: string; mode?: string } }>('/demo/image-captcha/:id/login/:mode?', async (request, reply) => {
    const id = request.params.id, mode = request.params.mode || 'normal';
    if (!valid(id) || !['normal','retry','exhaust','unreadable'].includes(mode)) return reply.code(400).send({ error: '需要合成验收编号与场景' });
    if (!states.has(id)) { const s: State = { mode, code: '', imageKey: '', invalid: false, issued: 0, refreshes: 0, submissions: 0, correct: 0, successes: 0, businessWrites: 0, tokens: new Set() }; issue(s); states.set(id, s); }
    const s = states.get(id)!, base = `/demo/image-captcha/${id}`;
    return reply.type('text/html').send(page(`<h1>普通图片验证码验收</h1><p>请使用配置的测试账号登录。</p><form><label>用户名<input name="username" autocomplete="off"></label><label>密码<input name="password" type="password" autocomplete="off"></label><label>图片验证码<input name="captcha" autocomplete="off" maxlength="8"></label><img id="captcha-image" width="240" height="80" alt="六位字符图片验证码" src="${base}/image/${s.imageKey}"><button type="button" id="refresh-image">换一张验证码</button><button type="submit" id="captcha-login">登录</button></form><output role="alert"></output><script>const f=document.querySelector('form'),o=document.querySelector('output'),image=document.querySelector('img');document.querySelector('#refresh-image').addEventListener('click',async()=>{const r=await fetch('${base}/refresh',{method:'POST'});const v=await r.json();image.src=v.image;f.elements.captcha.value='';o.textContent='';});f.addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('${base}/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.elements.username.value,password:f.elements.password.value,captcha:f.elements.captcha.value,imageKey:image.src.split('/').pop()})});if(r.ok)location.href='${base}/protected';else o.textContent=(await r.json()).error;});</script>`));
  });
  app.get<{ Params: { id: string; key: string } }>('/demo/image-captcha/:id/image/:key', async (request, reply) => {
    const s = states.get(request.params.id);
    if (!s || s.imageKey !== request.params.key) return reply.code(404).send();
    const glyphs = s.mode === 'unreadable' ? '??????' : s.code;
    const letters = [...glyphs].map((c, i) => `<text x="${20 + i * 35}" y="${51 + (i % 2 ? 3 : -2)}" transform="rotate(${i % 2 ? -5 : 5} ${20 + i * 35} 45)">${c}</text>`).join('');
    return reply.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#edf2ed"/><path d="M0 20L240 60M0 65L240 25" stroke="#a5b0ae" stroke-width="1.5"/><g font-family="monospace" font-size="35" font-weight="bold" fill="#243c52">${letters}</g></svg>`);
  });
  app.post<{ Params: { id: string } }>('/demo/image-captcha/:id/refresh', async (request, reply) => {
    const s = states.get(request.params.id); if (!s) return reply.code(404).send();
    s.refreshes++; issue(s); return { image: `/demo/image-captcha/${request.params.id}/image/${s.imageKey}` };
  });
  app.post<{ Params: { id: string }; Body: { username?: string; password?: string; captcha?: string; imageKey?: string } }>('/demo/image-captcha/:id/login', async (request, reply) => {
    const s = states.get(request.params.id); if (!s) return reply.code(404).send();
    s.submissions++;
    if (request.body.username !== 'demo-user' || request.body.password !== 'demo-password') return reply.code(401).send({ error: '账号或密码错误' });
    const correct = !s.invalid && request.body.imageKey === s.imageKey && request.body.captcha?.toUpperCase() === s.code;
    if (correct) s.correct++;
    if (s.mode === 'retry' && s.submissions === 1) s.invalid = true;
    if (!correct || s.invalid || s.mode === 'exhaust' || s.mode === 'unreadable') return reply.code(401).send({ error: '验证码错误或已失效，请换一张后重试' });
    const token = randomUUID(); s.tokens.add(token); s.successes++;
    reply.header('Set-Cookie', `casepilot_image_demo=${token}; HttpOnly; SameSite=Strict; Path=/demo/image-captcha/${request.params.id}`); return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/demo/image-captcha/:id/protected', async (request, reply) => {
    const s = states.get(request.params.id), base = `/demo/image-captcha/${request.params.id}`;
    if (!s || !authenticated(s, request.headers.cookie)) return reply.redirect(`${base}/login`);
    return reply.type('text/html').send(page(`<h1>验证码登录成功</h1><p>已进入需要登录的测试页面。</p><button id="business">业务提交</button><output role="status">尚未提交业务</output><script>document.querySelector('button').addEventListener('click',async()=>{const r=await fetch('${base}/business',{method:'POST'});if(r.ok)document.querySelector('output').textContent='业务已提交';});</script>`));
  });
  app.post<{ Params: { id: string } }>('/demo/image-captcha/:id/business', async (request, reply) => {
    const s = states.get(request.params.id); if (!s || !authenticated(s, request.headers.cookie)) return reply.code(401).send();
    s.businessWrites++; return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/demo/image-captcha/:id/count', async (request, reply) => {
    const s = states.get(request.params.id); if (!s) return reply.code(404).send();
    return { issued: s.issued, refreshes: s.refreshes, submissions: s.submissions, correct: s.correct, successes: s.successes, businessWrites: s.businessWrites };
  });
}
