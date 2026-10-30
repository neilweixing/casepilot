import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { metrics, type Run, type RunEvidence } from '../../../packages/contracts/src/p0.ts';
import { publicRunData, scrubValue, secretRedactor } from './execution-rules.ts';

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const labels: Record<string, string> = { PENDING: '未开始', RUNNING: '执行中', PASSED: '通过', FAILED: '未通过', BLOCKED: '前置阻塞', ERROR: '执行异常', CANCELLED: '已停止', INTERRUPTED: '已中断', QUEUED: '等待执行', PAUSING: '正在暂停', PAUSED: '已暂停', STOPPING: '正在停止', COMPLETED: '处理结束', DONE: '操作完成', UNCERTAIN: '结果不确定', SENT: '等待操作结果' };
const evidenceLabels = { tool: '工具记录', observation: '页面观察', position: '位置观察', screenshot: '页面截图' };
const h = escapeHtml;
const badge = (status: string) => `<span class="badge" data-status="${h(status)}">${h(labels[status] || status)}</span>`;

// 只读取本次登记的证据；解析真实路径，避免符号链接绕过目录边界。
export function readRunEvidence(dataDir: string, runId: string, evidence: RunEvidence) {
  if (evidence.runId !== runId) throw new Error('证据不属于当前任务');
  const archive = realpathSync(path.resolve(dataDir, 'runs'));
  const root = realpathSync(path.resolve(archive, runId));
  const file = realpathSync(path.resolve(root, evidence.path));
  if (!root.startsWith(archive + path.sep) || !file.startsWith(root + path.sep)) throw new Error('证据路径无效');
  if (!file.endsWith(evidence.kind === 'screenshot' ? '.png' : '.json')) throw new Error('证据类型无效');
  const bytes = readFileSync(file);
  if (evidence.kind === 'screenshot' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('截图格式无效');
  return bytes;
}

export function htmlReport(input: Run, dataDir: string, secrets: string[] = []) {
  const run = publicRunData(input, secrets), clean = secretRedactor(secrets), stats = metrics(run.results);
  const cases = run.cases.map((c, caseIndex) => {
    const result = run.results.find(r => r.caseId === c.id)!;
    const anchors = new Map(result.evidence.map((e, i) => [e.id, `evidence-${caseIndex}-${i}`]));
    const links = (ids: string[]) => ids.length ? ids.map(id => {
      const index = result.evidence.findIndex(e => e.id === id), e = result.evidence[index];
      return e ? `<a href="#${anchors.get(id)}">${h(evidenceLabels[e.kind])} ${index + 1}${e.success === false ? '（调用失败）' : ''}</a>` : `<span class="missing">证据 ${h(id)} 未登记</span>`;
    }).join(' ') : '<span class="muted">无关联证据</span>';
    const evidence = result.evidence.map(e => {
      const title = `${evidenceLabels[e.kind]} · ${e.stepId} · ${e.timestamp}`;
      let body: string;
      try {
        if (e.runId !== run.id || e.caseId !== c.id) throw new Error('证据不属于当前用例');
        const bytes = readRunEvidence(dataDir, run.id, e);
        if (e.kind === 'screenshot') {
          body = `<figure><img alt="${h(c.title)}的步骤证据" src="data:image/png;base64,${bytes.toString('base64')}"><figcaption>${h(title)}</figcaption></figure>`;
        } else {
          const value = scrubValue(JSON.parse(bytes.toString('utf8')), clean);
          body = `<details><summary>展开原始${h(evidenceLabels[e.kind])}${e.success === false ? '（调用失败）' : ''}</summary><pre>${h(JSON.stringify(value, null, 2))}</pre></details>`;
        }
      } catch {
        body = '<p class="missing">证据文件缺失或不可安全读取，请回查原始记录；原用例结论未被修改。</p>';
      }
      return `<div class="evidence" id="${anchors.get(e.id)}"><h4>${h(title)}</h4><small>证据 ID：${h(e.id)}</small>${body}</div>`;
    }).join('');
    const analysis = ['FAILED', 'BLOCKED', 'ERROR', 'INTERRUPTED'].includes(result.status) ? '<aside class="analysis"><h3>原因分析</h3><p>未生成独立根因分析。下方证据用于回查实际操作与观察；执行说明中的判断未经独立确认。</p></aside>' : '';
    return `<section class="case" id="case-${caseIndex}">
      <header class="case-heading"><div><small>${h(c.externalId || c.id)}</small><h2>${h(c.title)}</h2></div>${badge(result.status)}</header>
      <p class="muted">${h(c.source.fileName)} / ${h(c.source.sheet)} / 原始行 ${h(c.source.rows.join('、'))}</p>
      <dl class="case-meta"><div><dt>模块 / 优先级</dt><dd>${h(c.module || '未填写')} / ${h(c.priority || '未填写')}</dd></div><div><dt>开始 / 结束</dt><dd>${h(result.startedAt || '未开始')} / ${h(result.endedAt || '尚未结束')}</dd></div></dl>
      <h3>执行说明</h3><p>${h(result.reason || '暂无说明')}</p>${analysis}
      <h3>前置条件</h3>${c.preconditions.length ? `<ol>${c.preconditions.map(s => `<li>${h(s)}</li>`).join('')}</ol>` : '<p class="muted">未指定前置条件</p>'}
      <h3>操作步骤</h3><ol class="steps">${result.steps.map(s => `<li><div>${h(s.text)} ${badge(s.status)}</div>${s.evidenceIds.length ? `<details class="step-evidence"><summary>查看本步骤的 ${s.evidenceIds.length} 项证据</summary><p class="links">${links(s.evidenceIds)}</p></details>` : '<p class="muted">无关联证据</p>'}</li>`).join('')}</ol>
      <h3>预期与实际观察</h3>${c.expectations.map((expected, i) => {
        const a = result.assertions.find(a => a.expectationId === `e${i + 1}`);
        return `<article class="assertion"><header><strong>${h(expected)}</strong>${badge(a?.status || 'PENDING')}</header><p>${h(a?.actual || '尚未验证，没有实际观察结果。')}</p><p class="links">${links(a?.evidenceIds || [])}</p></article>`;
      }).join('')}
      <details class="source"><summary>原始来源文本 · revision ${h(run.revision)}</summary><pre>${h(c.source.original.join('\n'))}</pre></details>
      <h3>归档证据 <small>${result.evidence.length} 项</small></h3><p class="muted">页面观察与工具结果为执行记录；逐项判断由 Agent 根据这些证据记录。</p>${evidence || '<p class="muted">没有归档证据。</p>'}
      <a class="back" href="#case-index">返回用例目录</a></section>`;
  }).join('');
  const active = ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'].includes(run.status);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>CasePilot · ${h(run.environment.name)} · 测试报告</title><style>${reportStyle}</style></head><body><main>
    <header class="report-heading"><span class="brand">CasePilot</span>${badge(run.status)}</header><h1>测试执行报告</h1>
    <p class="intro">${h(run.environment.name)}${active ? ' · 执行中快照，后续结果不包含在本文件内。' : ' · 处理结束不代表全部验证通过，请查看逐项结果。'}</p>
    <dl class="meta"><div><dt>任务</dt><dd>${h(run.id)}</dd></div><div><dt>环境地址</dt><dd>${h(run.environment.baseURL)}</dd></div><div><dt>确认版本</dt><dd>${h(run.importId)} / revision ${h(run.revision)}</dd></div><div><dt>模型</dt><dd>${h(run.modelId)}</dd></div><div><dt>创建 / 结束</dt><dd>${h(run.createdAt)} / ${h(run.endedAt || '尚未结束')}</dd></div><div><dt>导出时间</dt><dd>${new Date().toISOString()}</dd></div></dl>
    <dl class="metrics"><div><dt>通过率</dt><dd data-metric="passRate">${stats.passRate === null ? '<small>暂无可判定结果</small>' : stats.passRate + '%'}</dd></div><div><dt>执行完成率</dt><dd data-metric="completionRate">${stats.completionRate}%</dd></div><div><dt>处理进度</dt><dd data-metric="progress">${stats.progress}%</dd></div><div><dt>用例总数</dt><dd data-metric="total">${stats.total}</dd></div></dl>
    <div class="counts">${Object.entries(stats.counts).map(([status, count]) => `<span data-count="${status}">${badge(status)}<b>${count}</b></span>`).join('')}</div>
    <p class="muted">通过率仅计算通过与未通过；执行完成率为两者之和占全部用例的比例。阻塞、异常、停止、中断和未开始单独列出。</p>
    ${run.reason ? `<p class="intro">执行说明：${h(run.reason)}</p>` : ''}
    <nav id="case-index" aria-label="用例目录"><h2>用例目录</h2><ol>${run.cases.map((c, i) => `<li><a href="#case-${i}"><span>${h(c.externalId || i + 1)} ${h(c.title)}</span>${badge(run.results.find(r => r.caseId === c.id)!.status)}</a></li>`).join('')}</ol></nav>
    ${cases}<details><summary>任务事件记录</summary><ol>${run.events.map(e => `<li><time>${h(e.timestamp)}</time> ${h(e.message)}</li>`).join('')}</ol></details>
    <footer><p>本文件包含导出时的结构化结果和已归档证据，可独立离线查看。</p><p>统计由服务计算；逐项判断依据归档观察，执行说明不能替代证据或独立根因分析。</p></footer>
    </main></body></html>`;
}

const reportStyle = `
*{box-sizing:border-box}body{font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#292825;background:#faf9f6;margin:0;padding:36px 24px}main{max-width:1040px;margin:auto}h1,h2,h3,h4,p{margin:0}h1{font-size:32px;font-weight:550;letter-spacing:-.8px;margin:12px 0}h2{font-size:22px;font-weight:550}h3{font-size:15px;margin:28px 0 10px}h4{font-size:13px;font-weight:550}small,.muted,dt{color:#706b63;font-size:12px}.brand{font:24px Georgia,serif}
.report-heading,.case-heading,article header{display:flex;justify-content:space-between;align-items:center;gap:16px}.intro{margin:12px 0 24px}.meta,.case-meta{display:grid;grid-template-columns:1fr 1fr;gap:12px 28px;margin:24px 0}.meta dd,.case-meta dd{margin:3px 0 0;font-size:13px;overflow-wrap:anywhere}.case-meta{padding-bottom:16px;border-bottom:1px solid #e4e0d8}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);border-block:1px solid #d8d3ca;padding:20px 0;margin:24px 0 12px;gap:16px}.metrics dd{font:30px/1.4 Georgia,"Songti SC",serif;margin:6px 0 0}.metrics dd small{font:13px/1.6 system-ui}.counts{display:flex;gap:10px 20px;flex-wrap:wrap;margin:20px 0}.counts span{font-size:12px}.counts b{margin-left:6px}
.badge{display:inline-block;white-space:nowrap;font-size:11px;background:#eeece7;color:#625e56;border-radius:4px;padding:3px 8px;font-weight:400}.badge[data-status=PASSED],.badge[data-status=DONE]{background:#e8f0eb;color:#38634c}.badge[data-status=FAILED]{background:#f8e8e5;color:#9b4137}.badge[data-status=ERROR],.badge[data-status=INTERRUPTED]{background:#f5eadf;color:#865624}.badge[data-status=RUNNING],.badge[data-status=PAUSED]{background:#e9edf5;color:#4b5c80}
nav{margin:32px 0}nav ol{padding:0;list-style:none}nav li{border-bottom:1px solid #e4e0d8}nav a{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 0;color:#39362f;text-decoration:none}.case{background:#fff;border:1px solid #e4e0d8;padding:30px;margin:24px 0;border-radius:10px;overflow-wrap:anywhere;scroll-margin-top:20px}.case-heading small{display:block;margin-bottom:6px}.case>.muted{margin-top:12px}
.steps{padding-left:22px}.steps li{padding:8px 0}.steps .badge{margin-left:8px}.links{margin-top:7px;font-size:12px}.links a{margin-right:10px}a{color:#97573d;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:2px solid #a45f45;outline-offset:4px}.assertion{border-left:3px solid #d8c5b4;margin:16px 0;padding:4px 0 4px 16px}.assertion header{align-items:flex-start}.assertion p{margin-top:8px;white-space:pre-wrap;font-size:13px}
.analysis{border-left:2px solid #e4e0d8;padding-left:16px;margin-top:20px;color:#706b63}.analysis h3{margin-top:0}.analysis p{font-size:12px}.source{margin-top:24px}.evidence{border-top:1px solid #e4e0d8;margin-top:18px;padding-top:18px;scroll-margin-top:20px}.evidence:target{outline:2px solid #b78d6f;outline-offset:8px}.evidence>small{display:block;margin:4px 0 10px}summary{cursor:pointer;font-size:13px;color:#625e56}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.8 ui-monospace,monospace;background:#f6f5f2;border-radius:6px;padding:14px}figure{margin:16px 0}img{max-width:100%;height:auto;border:1px solid #e4e0d8;border-radius:6px}figcaption{font-size:11px;color:#706b63;margin-top:5px}.missing{color:#9b4137;font-size:12px}.back{display:inline-block;margin-top:26px;font-size:12px}footer{font-size:12px;color:#706b63;padding:24px 0}footer p{margin-top:5px}
@media(max-width:640px){body{padding:24px 14px}.case{padding:20px}.meta,.case-meta{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.report-heading,.case-heading{align-items:flex-start}h1{font-size:27px}h2{font-size:19px}}@media print{body{background:white;padding:0}.case{border:0;border-top:1px solid #aaa;border-radius:0;padding:24px 0}.evidence,article,figure{break-inside:avoid}details{display:block}details>pre{display:block}nav,.back{display:none}a{color:inherit}}
`;
