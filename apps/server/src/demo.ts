import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerCaptchaDemo } from './captcha-demo.ts';

// 仅用于开发验收的独立目标，不作为 CasePilot 的真实用户登录系统。
export function registerDemo(app: FastifyInstance) {
  registerCaptchaDemo(app);
  const sessions = new Set<string>();
  const recoveryCounts = new Map<string, number>();
  const lifecycleData = new Map<string, { created: number; active: number; clears: number; retained: number }>();
  const lifecycleState = (id: string) => {
    if (!lifecycleData.has(id)) lifecycleData.set(id, { created: 0, active: 0, clears: 0, retained: 0 });
    return lifecycleData.get(id)!;
  };
  const authenticated = (cookie?: string) => sessions.has(cookie?.match(/casepilot_demo=([0-9a-f-]+)/)?.[1] || '');
  const shell = (body: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CasePilot 可控测试系统</title><style>body{font:17px/1.7 system-ui;max-width:700px;margin:50px auto;color:#282724;background:#faf9f6}main{background:white;border:1px solid #ddd;padding:30px;border-radius:12px}label{display:block;margin:15px 0}input{display:block;padding:10px;width:90%;font:inherit;margin-top:5px}button{padding:10px 22px;font:inherit}output{display:block;margin-top:20px}nav{margin:20px 0}canvas{background:#eef1f5}</style><main>${body}</main></html>`;
  const form = (reversed: boolean, expireOnSubmit = false) => {
    const name = '<label>姓名<input name="name" required></label>', date = '<label>预计启动日期<input name="startDate" required></label>';
    return shell(`<h1>可控表单</h1><p id="permissions">当前权限：普通测试账号。没有管理员权限。</p><p id="preparation">测试数据尚未准备</p><button type="button" id="prepare">准备测试数据</button><form>${reversed ? date + name : name + date}<button>提交</button></form><output role="status" data-count="0">尚未提交</output><p id="submission-count">本窗口提交次数：0</p><p>页面视觉校验码：</p><canvas width="250" height="80" aria-label="视觉校验码图像"></canvas><script>const countLabel=document.querySelector('#submission-count');const showCount=()=>countLabel.textContent='本窗口提交次数：'+(sessionStorage.getItem('demoSubmissions')||'0');showCount();const preparation=document.querySelector('#preparation');if(sessionStorage.getItem('prepared')==='yes')preparation.textContent='测试数据已准备';document.querySelector('#prepare').addEventListener('click',()=>{sessionStorage.setItem('prepared','yes');preparation.textContent='测试数据已准备';});const ctx=document.querySelector('canvas').getContext('2d');ctx.font='bold 48px monospace';ctx.fillStyle='#1d385d';ctx.fillText('5821',45,56);document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,o=document.querySelector('output');const count=Number(sessionStorage.getItem('demoSubmissions')||'0')+1;sessionStorage.setItem('demoSubmissions',String(count));showCount();o.dataset.count=String(count);if(${expireOnSubmit}){await fetch('/demo/expire',{method:'POST'});location.href='/demo/login';return;}o.textContent='已提交：'+f.elements.name.value+' / '+f.elements.startDate.value;});</script>`);
  };
  app.get('/demo', async (_request, reply) => reply.type('text/html').send(form(false)));
  app.get<{ Params: { checkId: string } }>('/demo/lifecycle/:checkId', async (request, reply) => {
    const id = request.params.checkId;
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: '需要合成验收编号' });
    const s = lifecycleState(id);
    return reply.type('text/html').send(shell(`<h1>中断与数据保留验收</h1><p>本页面仅保存独立合成数据。清理后可通过“恢复本次记录”撤销。</p><button id="lifecycle-create">创建记录</button><button id="lifecycle-clear">清理本次记录</button><button id="lifecycle-restore">恢复本次记录</button><output role="status">等待操作</output><p id="lifecycle-count">当前记录数：${s.active}</p><p id="lifecycle-created">累计创建次数：${s.created}</p><p id="lifecycle-clears">清理次数：${s.clears}</p><p id="lifecycle-retained">可恢复记录数：${s.retained}</p><script>for(const action of ['create','clear','restore'])document.querySelector('#lifecycle-'+action).addEventListener('click',async()=>{const response=await fetch('/demo/lifecycle/${id}/'+action,{method:'POST'});const s=await response.json();document.querySelector('#lifecycle-count').textContent='当前记录数：'+s.active;document.querySelector('#lifecycle-created').textContent='累计创建次数：'+s.created;document.querySelector('#lifecycle-clears').textContent='清理次数：'+s.clears;document.querySelector('#lifecycle-retained').textContent='可恢复记录数：'+s.retained;document.querySelector('output').textContent=action==='create'?'创建完成':action==='clear'?'已清理，可恢复':'已恢复';});</script>`));
  });
  app.get<{ Params: { checkId: string } }>('/demo/lifecycle/:checkId/count', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(request.params.checkId)) return reply.code(400).send({ error: '需要合成验收编号' });
    return lifecycleState(request.params.checkId);
  });
  for (const action of ['create', 'clear', 'restore']) app.post<{ Params: { checkId: string } }>(`/demo/lifecycle/:checkId/${action}`, async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(request.params.checkId)) return reply.code(400).send({ error: '需要合成验收编号' });
    const s = lifecycleState(request.params.checkId);
    if (action === 'create') { s.created++; s.active++; }
    else if (action === 'clear') { s.retained += s.active; s.active = 0; s.clears++; }
    else { s.active += s.retained; s.retained = 0; }
    return s;
  });
  app.get<{ Params: { checkId: string } }>('/demo/recovery/:checkId', async (request, reply) => {
    const id = request.params.checkId;
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: '需要合成验收编号' });
    return reply.type('text/html').send(shell(`<h1>恢复验收表单</h1><p>这是独立的合成目标，每次点击都会创建一条计数记录。</p><form><button id="create-record">创建记录</button></form><output role="status">尚未创建</output><p id="recovery-count">本窗口提交次数：0</p><script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const response=await fetch('/demo/recovery/${id}/create',{method:'POST'});const {count}=await response.json();document.querySelector('output').textContent='创建完成';document.querySelector('#recovery-count').textContent='本窗口提交次数：'+count;document.querySelector('button').textContent='再次创建记录';});</script>`));
  });
  app.post<{ Params: { checkId: string } }>('/demo/recovery/:checkId/create', async (request, reply) => {
    const id = request.params.checkId;
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: '需要合成验收编号' });
    const count = (recoveryCounts.get(id) || 0) + 1; recoveryCounts.set(id, count);
    return { count };
  });
  app.get<{ Params: { checkId: string } }>('/demo/recovery/:checkId/count', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(request.params.checkId)) return reply.code(400).send({ error: '需要合成验收编号' });
    return { count: recoveryCounts.get(request.params.checkId) || 0 };
  });
  app.get('/demo/reversed', async (_request, reply) => reply.type('text/html').send(form(true)));
  app.get('/demo/secure', async (request, reply) => authenticated(request.headers.cookie) ? reply.type('text/html').send(form(false)) : reply.redirect('/demo/login'));
  app.get('/demo/session-expiry', async (request, reply) => authenticated(request.headers.cookie) ? reply.type('text/html').send(form(false, true)) : reply.redirect('/demo/login'));
  app.post('/demo/expire', async (request, reply) => {
    const token = request.headers.cookie?.match(/casepilot_demo=([0-9a-f-]+)/)?.[1];
    if (token) sessions.delete(token);
    return reply.header('Set-Cookie', 'casepilot_demo=; HttpOnly; SameSite=Strict; Path=/demo; Max-Age=0').send({ expired: true });
  });
  for (const captcha of [false, true]) app.get(captcha ? '/demo/login-captcha' : '/demo/login', async (_request, reply) => reply.type('text/html').send(shell(`<h1>测试系统登录</h1><p>这是可控验收页面。</p><form><label>用户名<input name="username" autocomplete="off"></label><label>密码<input type="password" name="password" autocomplete="off"></label>${captcha ? '<label>图片验证码<input name="captcha"></label><canvas width="180" height="70" aria-label="四位图片验证码"></canvas>' : ''}<button>登录</button></form><output role="alert"></output><script>${captcha ? "const ctx=document.querySelector('canvas').getContext('2d');ctx.font='bold 42px monospace';ctx.fillText('2468',30,50);" : ''}document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;const r=await fetch('/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.elements.username.value,password:f.elements.password.value,captcha:f.elements.captcha?.value||'',requiresCaptcha:${captcha}})});if(r.ok)location.href='/demo/secure';else document.querySelector('output').textContent='登录失败，请检查账号、密码或验证码';});</script>`)));
  app.post<{ Body: { username?: string; password?: string; captcha?: string; requiresCaptcha?: boolean } }>('/demo/login', async (request, reply) => {
    if (request.body.username !== 'demo-user' || request.body.password !== 'demo-password' || request.body.requiresCaptcha && request.body.captcha !== '2468') return reply.code(401).send({ error: '登录失败' });
    const token = randomUUID(); sessions.add(token); return reply.header('Set-Cookie', `casepilot_demo=${token}; HttpOnly; SameSite=Strict; Path=/demo`).send({ ok: true });
  });
}
