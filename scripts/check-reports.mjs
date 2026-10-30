import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../apps/server/src/config.ts';
import { metrics } from '../packages/contracts/src/p0.ts';

// 只读取已存在的运行与导出，不创建用例或触发模型，也不改写原始证据。
const config = loadConfig(), ids = process.argv.filter(v => v.startsWith('--run-id=')).map(v => v.slice(9));
assert.ok(ids.length, '请用 --run-id 指定已有验收任务');
assert.ok(ids.every(id => /^[0-9a-f-]{36}$/.test(id)), '运行 ID 无效');
const directory = path.join(config.dataDir, 'report-check'); mkdirSync(directory, { recursive: true, mode: 0o700 });
const secrets = ['demo-user', 'demo-password', 'deliberately-incorrect-synthetic', process.env.CASEPILOT_API_KEY].filter(Boolean);
const variants = [...new Set(secrets.flatMap(s => [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)]))];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const summaries = [];
for (const id of ids) {
  const response = await fetch(`${config.origin}/api/runs/${id}`); assert.ok(response.ok);
  const run = await response.json();
  const report = await fetch(`${config.origin}/api/runs/${id}/report.html`); assert.ok(report.ok);
  const html = await report.text(), expected = metrics(run.results);
  assert.deepEqual(run.metrics, expected);
  const text = key => html.match(new RegExp(`data-metric="${key}">([\\s\\S]*?)</dd>`))?.[1].replace(/<[^>]+>/g, '');
  assert.equal(text('passRate'), expected.passRate === null ? '暂无可判定结果' : `${expected.passRate}%`);
  assert.equal(text('completionRate'), `${expected.completionRate}%`); assert.equal(text('progress'), `${expected.progress}%`); assert.equal(text('total'), String(expected.total));
  for (const [status, count] of Object.entries(expected.counts)) assert.ok(html.includes(`data-count="${status}"><span class="badge" data-status="${status}">`) && new RegExp(`data-count="${status}">[\\s\\S]*?<b>${count}</b></span>`).test(html));
  assert.equal(Object.values(expected.counts).reduce((a, b) => a + b, 0), run.cases.length);
  assert.ok(!/<script\b|<link\b|<iframe\b|<object\b|<embed\b/i.test(html), '不应出现可执行内容或外部样式');
  assert.ok([...(html.matchAll(/<[^>]+>/g))].every(m => !/\s(?:on\w+|style)\s*=/i.test(m[0])), 'HTML 标签不能包含事件处理器或行内样式');
  // 转义后的工具脚本仅作为正文展示；toDataURL 等文字不能误判为 CSS 资源。
  assert.ok([...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].every(m => !/@import|\burl\s*\(/i.test(m[1])), '样式不能引用外部资源');
  assert.ok([...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].every(m => m[1].startsWith('#') || m[1].startsWith('data:image/png;base64,')), '所有资源都必须内嵌，链接只能是文档锚点');
  assert.ok(!html.includes('证据文件缺失或不可安全读取')); assert.ok(!variants.some(s => html.includes(s)), '导出存在原始秘密值');
  const evidence = run.results.flatMap(r => r.evidence), screenshots = evidence.filter(e => e.kind === 'screenshot');
  assert.equal([...html.matchAll(/class="evidence" id=/g)].length, evidence.length);
  const embedded = [...html.matchAll(/src="data:image\/png;base64,([^\"]+)"/g)].map(m => digest(Buffer.from(m[1], 'base64')));
  assert.deepEqual(embedded.sort(), screenshots.map(e => digest(readFileSync(path.join(config.dataDir, 'runs', run.id, e.path)))).sort());
  assert.ok([...html.matchAll(/href="#([^"]*)"/g)].every(m => html.includes(`id="${m[1]}"`)), '证据和目录链接必须有对应目标');
  writeFileSync(path.join(directory, `${id}.html`), html, { mode: 0o600 });
  summaries.push({ runId: id, status: run.status, metrics: expected, evidence: evidence.length, screenshots: screenshots.length, bytes: Buffer.byteLength(html), selfContained: true, plaintextMatches: 0, note: '文件结构检查；未将在线预览冒称为离线打开', checkedAt: new Date().toISOString() });
}
writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summaries, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summaries, null, 2));
