import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Environment, Field, ImportDraft, ImportIssue, PublicModelProvider, Recording, Run, SheetMapping, System, TestCase } from '../../../packages/contracts/src/p0.ts';
import type { metrics } from '../../../packages/contracts/src/p0.ts';
import './style.css';
import { Select } from './Select.tsx';
import { ExecutionLog } from './ExecutionLog.tsx';

type RunDetail = Run & { metrics: ReturnType<typeof metrics> };
type ImportSummary = Pick<ImportDraft, 'id' | 'fileName' | 'revision' | 'confirmedAt' | 'createdAt' | 'systemId' | 'origin'> & { caseCount: number };
type PublicEnvironment = Omit<Environment, 'credentialRef' | 'captchaCode'>;
type Status = { model: { configured: boolean; modelId?: string }; platform: string; browser: string; runnerAvailable: boolean };
type Page = 'new' | 'imports' | 'environments' | 'runs' | 'reports' | 'settings';
type Extensions = { skills: { name: string; enabled: boolean }[]; mcp: { name: string; version: string; enabled: boolean; connection: string }[] };
const labels: Record<string, string> = { PENDING: '未开始', RUNNING: '执行中', PASSED: '通过', FAILED: '未通过', BLOCKED: '前置阻塞', ERROR: '执行异常', CANCELLED: '已停止', INTERRUPTED: '已中断', QUEUED: '等待执行', PAUSING: '准备暂停', PAUSED: '已暂停', STOPPING: '正在停止', COMPLETED: '处理结束', DONE: '操作完成', UNCERTAIN: '结果不确定', SENT: '等待操作结果' };
const fieldNames: Record<Field, string> = { externalId: '用例编号', module: '模块', title: '标题', priority: '优先级', preconditions: '前置条件', steps: '操作步骤', expectations: '预期结果' };
const active = (status: string) => ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'].includes(status);
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api' + url, { method, headers: { ...(body instanceof File ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CasePilot-Request': '1' } : {}) }, ...(body ? { body: body instanceof File ? body : JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({ error: '服务暂时无法连接，请检查本机服务' }));
  if (!response.ok) throw new Error(data.error || '操作未完成，请稍后重试');
  return data;
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />, file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" /></>,
    env: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 8h2M7 12h6" /></>, runs: <><path d="m9 5 11 7-11 7z" /><path d="M4 5v14" /></>, report: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 16v-3M12 16V8M16 16v-5" /></>, settings: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></>, upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>, arrow: <path d="M4 12h16m-6-6 6 6-6 6" />, chevron: <path d="m9 5 7 7-7 7" />, refresh: <><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" /><path d="M20.7 4.6v5.2h-5.2" /></>, sliders: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>, model: <><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M8 12h8M8 16h4" /></>, check: <path d="m5 12 4 4L19 6" />, close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.file}</svg>;
}
function Badge({ status }: { status: string }) { return <span className={'badge ' + status.toLowerCase()}>{labels[status] || status}</span>; }
function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) { return <div className="empty"><span className="empty-icon"><Icon name="file" /></span><h3>{title}</h3><p>{text}</p>{action}</div>; }
// 删除不可撤销，因此二次确认就地展开，离开这一行即自动收起，不会误触。
function DeleteButton({ target, disabled, onConfirm }: { target: string; disabled?: boolean; onConfirm(): void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className="text-button danger" disabled={disabled} onClick={() => setAsking(true)}>删除</button>;
  return <span className="delete-confirm" role="group" aria-label={`确认删除${target}`}>
    <span className="delete-confirm-text">删除后不可恢复，确认删除{target}？</span>
    <button className="text-button danger strong" onClick={() => { setAsking(false); onConfirm(); }}>确认删除</button>
    <button className="text-button" onClick={() => setAsking(false)}>取消</button>
  </span>;
}

function App() {
  const [page, setPage] = useState<Page>('new'), [imports, setImports] = useState<ImportSummary[]>([]), [systems, setSystems] = useState<System[]>([]), [environments, setEnvironments] = useState<PublicEnvironment[]>([]), [runs, setRuns] = useState<RunDetail[]>([]), [recordings, setRecordings] = useState<Recording[]>([]);
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState<(ImportDraft & { problems?: ImportIssue[] }) | null>(null), [selectedRun, setSelectedRun] = useState(''), [run, setRun] = useState<RunDetail | null>(null);
  const [selectedImport, setSelectedImport] = useState(''), [selectedEnv, setSelectedEnv] = useState(''), [providers, setProviders] = useState<PublicModelProvider[]>([]), [extensions, setExtensions] = useState<Extensions | null>(null);
  const [systemFilter, setSystemFilter] = useState(''), [originFilter, setOriginFilter] = useState(''), [importsTab, setImportsTab] = useState<'excel' | 'recorder'>('excel');
  const uploadInput = useRef<HTMLInputElement>(null);
  const refresh = async () => { const [i, s, e, r, info, p, x, rec] = await Promise.all([api<ImportSummary[]>('/imports'), api<System[]>('/systems'), api<PublicEnvironment[]>('/environments'), api<RunDetail[]>('/runs'), api<Status>('/status'), api<PublicModelProvider[]>('/model-providers'), api<Extensions>('/extensions'), api<Recording[]>('/recordings')]); setImports(i); setSystems(s); setEnvironments(e); setRuns(r); setStatus(info); setProviders(p); setExtensions(x); setRecordings(rec); };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);
  const perform = async (work: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '操作未完成'); } finally { setBusy(false); } };
  useEffect(() => {
    if (!selectedRun) return;
    let disposed = false;
    const events = new EventSource(`/api/runs/${selectedRun}/events`);
    const load = async () => { try { const value = await api<RunDetail>(`/runs/${selectedRun}`); if (!disposed) { setRun(value); if (!active(value.status)) events.close(); } } catch (e) { if (!disposed) setError((e as Error).message); } };
    events.onmessage = () => { void load(); };
    const timer = setInterval(() => { void load(); }, 2500); void load();
    return () => { disposed = true; events.close(); clearInterval(timer); };
  }, [selectedRun]);
  const navigate = (p: Page) => { setPage(p); setError(''); setNotice(''); if (p !== 'imports') setDraft(null); if (p !== 'runs') setSelectedRun(''); void refresh().catch(e => setError(e.message)); };
  const upload = (file: File | undefined) => { if (!file) return; void perform(async () => { if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('请选择 .xlsx 文件；旧版或加密工作簿请先转换'); const value = await api<ImportDraft>(`/imports?name=${encodeURIComponent(file.name)}`, 'POST', file); setDraft(await api(`/imports/${value.id}`)); setPage('imports'); await refresh(); setNotice('解析完成。请核对工作表、用例内容和原始来源后确认。'); }); };
  const showRun = (id: string) => { setPage('runs'); setSelectedRun(id); setRun(null); };
  const nav: { id: Page; icon: string; text: string }[] = [{ id: 'imports', icon: 'file', text: '用例库' }, { id: 'environments', icon: 'env', text: '系统与环境' }, { id: 'runs', icon: 'runs', text: '测试任务' }, { id: 'reports', icon: 'report', text: '执行报告' }, { id: 'settings', icon: 'sliders', text: '设置' }];
  const navLabel = page === 'new' ? '新建测试' : nav.find(n => n.id === page)?.text || '设置';
  const activeRun = runs.find(r => active(r.status));
  const activeProvider = providers.find(p => p.active);
  const selectedConfirmed = imports.find(i => i.id === selectedImport && i.confirmedAt);
  const selectedEnvValue = environments.find(e => e.id === selectedEnv);
  // 服务端在创建任务时也会拒绝跨系统组合，这里提前提示避免无效提交。
  const systemMismatch = !!selectedConfirmed?.systemId && !!selectedEnvValue && selectedEnvValue.systemId !== selectedConfirmed.systemId;
  // 用例库按系统分组：每个系统一组，旧数据未指定归属的归入“未指定系统”。
  const importGroups = [...systems.map(s => ({ key: s.id, name: s.name, items: imports.filter(i => i.systemId === s.id) })), { key: 'none', name: '未指定系统', items: imports.filter(i => !i.systemId) }].filter(g => g.items.length && (!systemFilter || g.key === systemFilter));
  return <div className={'app ' + (collapsed ? 'sidebar-collapsed' : '') + (page === 'runs' && selectedRun ? ' run-workspace' : '')}>
    <aside className="sidebar"><div className="brand"><button className="brand-mark" onClick={() => navigate('new')} aria-label="CasePilot 首页">C</button>{!collapsed && <span>CasePilot</span>}<button className="collapse" aria-label={collapsed ? '展开导航' : '收起导航'} onClick={() => setCollapsed(!collapsed)}>☰</button></div>
      <button className={'new-nav ' + (page === 'new' ? 'selected' : '')} onClick={() => navigate('new')}><Icon name="plus" />{!collapsed && '新建测试'}</button>
      <nav aria-label="主导航">{nav.map(n => <button key={n.id} title={n.text} className={page === n.id ? 'selected' : ''} onClick={() => navigate(n.id)}><Icon name={n.icon} />{!collapsed && n.text}</button>)}</nav>
      {!collapsed && <div className="recent"><div className="nav-caption">最近的任务</div>{runs.slice(0, 5).map(r => <button key={r.id} className="recent-item" onClick={() => showRun(r.id)}><span className={'dot ' + r.status.toLowerCase()} />{r.environment.name}<small>{date(r.createdAt).split(' ')[0]}</small></button>)}{!runs.length && <p>开始后，任务会出现在这里</p>}</div>}
      <div className="sidebar-bottom">{!collapsed && <div className="model-status">
        {activeProvider
          ? <div className="model-line" title={`${activeProvider.modelId}${activeProvider.reasoning ? ` · 思考深度 ${thinkingLevelLabels[activeProvider.thinkingLevel] || activeProvider.thinkingLevel}` : ' · 未开启推理'}`}>
              <span className="local-dot" aria-hidden="true" />
              <span className="model-line-name">{activeProvider.modelId}</span>
              <span className="model-line-level">{activeProvider.reasoning ? (thinkingLevelLabels[activeProvider.thinkingLevel] || activeProvider.thinkingLevel) : '未开启'}</span>
            </div>
          : <div className="model-line" title="尚未配置模型提供商"><span className="local-dot muted" aria-hidden="true" /><span className="model-line-name muted">模型未配置</span></div>}
      </div>}</div></aside>
    <main><header className="topbar"><span>工作区 <span className="slash">/</span> {navLabel}</span></header>
      <div className="content">{error && <div role="alert" className="alert error"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><Icon name="close" /></button></div>}{notice && <div role="status" className="alert success">{notice}</div>}{busy && <div role="status" className="working">正在处理，请稍候…</div>}
        {page === 'new' && <><div className="welcome"><span className="eyebrow">CASEPILOT / WEB TESTING</span><h1>让每一轮测试，<br />都有据可查。</h1><p>导入已有用例，选择测试环境。<br />让 Agent 操作真实浏览器，留下可复查的执行记录。</p></div>
          <section className="start-card"><div className="card-heading"><h2>开始一轮测试</h2><span className="caption">按顺序执行 · 单环境单账号</span></div>
            {activeRun && <div className="alert neutral">已有任务正在执行或暂停。<button className="text-button" onClick={() => showRun(activeRun.id)}>查看当前任务 <Icon name="arrow" /></button></div>}
            <div className="start-fields"><label><span>01 / 选择用例集</span><Select aria-label="选择已确认的用例集" value={selectedImport} onChange={e => setSelectedImport(e.target.value)}><option value="">选择已确认的用例集</option>{imports.filter(i => i.confirmedAt).map(i => <option key={i.id} value={i.id}>{i.fileName} · {i.origin === 'recording' ? '录制' : 'Excel'} · {systems.find(s => s.id === i.systemId)?.name || '未指定系统'} · {i.caseCount} 条 · v{i.revision}</option>)}</Select><button className="text-button" onClick={() => uploadInput.current?.click()}><Icon name="upload" />导入新的 Excel</button></label><label><span>02 / 选择环境</span><Select aria-label="选择测试环境" value={selectedEnv} onChange={e => setSelectedEnv(e.target.value)}><option value="">选择测试环境</option>{environments.map(e => <option key={e.id} value={e.id}>{systems.find(s => s.id === e.systemId)?.name} / {e.name}</option>)}</Select><button className="text-button" onClick={() => navigate('environments')}><Icon name="plus" />管理测试环境</button></label></div>
            {systemMismatch && <p className="warning-text">所选环境属于其他系统，请选择与用例集一致的环境。</p>}
            <div className="card-footer"><span>{status?.runnerAvailable ? '确认后的用例才会进入执行流程' : '本阶段可导入、确认用例和配置环境；执行功能将在下一阶段开放'}</span><button className="primary" disabled={busy || !selectedConfirmed || !selectedEnv || systemMismatch || !!activeRun || !status?.model.configured || !status.runnerAvailable} onClick={() => void perform(async () => { const selected = selectedConfirmed; if (!selected) throw new Error('请选择已确认的用例版本'); const value = await api<Run>('/runs', 'POST', { importId: selected.id, revision: selected.revision, environmentId: selectedEnv }); showRun(value.id); await refresh(); })}>创建并开始 <Icon name="arrow" /></button></div>
          </section><div className="workflow">{[['file', '导入与核对', '保留原始来源，人工确认后执行'], ['runs', '真实浏览器', '按步骤操作，不用接口冒充 UI'], ['report', '结果与证据', '逐项验证，页面查看与 HTML 导出']].map(([icon, title, text]) => <div key={title}><Icon name={icon!} /><h3>{title}</h3><p>{text}</p></div>)}</div></>}
        {page === 'imports' && (draft ? <ImportEditor draft={draft} systems={systems} busy={busy} onBack={() => setDraft(null)} onAction={work => void perform(async () => { const updated = await work(); setDraft(await api(`/imports/${updated.id}`)); await refresh(); })} /> : <>
<PageHeading eyebrow="TEST CASES" title="用例库" text="从 Excel 导入或在浏览器中录制。每条用例都保留来源，确认之后才会执行。" action={null} />
<div className="imports-tab-switch" role="tablist" aria-label="用例来源">
  <button role="tab" aria-selected={importsTab === 'excel'} onClick={() => setImportsTab('excel')}>Excel 导入</button>
  <button role="tab" aria-selected={importsTab === 'recorder'} onClick={() => setImportsTab('recorder')}>录制脚本</button>
</div>
{importsTab === 'recorder'
  ? <RecorderSection recordings={recordings} busy={busy} perform={perform} refresh={refresh} setNotice={setNotice} onOpenDraft={(id) => void perform(async () => { setDraft(await api(`/imports/${id}`)); window.scrollTo(0, 0); })} />
  : <><div className="upload-zone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files[0]); }}><Icon name="upload" /><h3>把工作簿拖到这里</h3><p>支持 .xlsx、多工作表、合并单元格与单元格内多行步骤</p><button className="secondary" onClick={() => uploadInput.current?.click()}>选择 Excel 文件</button><small>只读取表格；不会执行公式、宏或其中的指令</small></div>
  {imports.length ? <><div className="case-group-filter"><Select aria-label="按来源筛选用例集" value={originFilter} onChange={e => setOriginFilter(e.target.value)}><option value="">全部来源</option><option value="excel">Excel 导入</option><option value="recording">录制转换</option></Select><Select aria-label="按系统筛选用例集" value={systemFilter} onChange={e => setSystemFilter(e.target.value)}><option value="">全部系统</option>{systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="none">未指定系统</option></Select></div>{importGroups.filter(g => originFilter ? g.items.some(i => i.origin === originFilter) : true).map(g => <section className="case-group" key={g.key}><div className="case-group-heading"><h2>{g.name}</h2><span className="caption">{originFilter ? g.items.filter(i => i.origin === originFilter).length : g.items.length} 个用例集</span></div><div className="table-wrap"><table><thead><tr><th>用例集</th><th>用例数</th><th>版本</th><th>状态</th><th>创建时间</th><th /></tr></thead><tbody>{g.items.filter(i => !originFilter || i.origin === originFilter).map(i => <tr key={i.id}><td className="strong">{i.fileName} <span className="badge">{i.origin === 'recording' ? '录制' : 'Excel'}</span></td><td>{i.caseCount}</td><td>v{i.revision}</td><td><span className={'badge ' + (i.confirmedAt ? 'passed' : 'pending')}>{i.confirmedAt ? '已确认' : '待核对'}</span></td><td>{date(i.createdAt)}</td><td><button className="text-button" onClick={() => void perform(async () => setDraft(await api(`/imports/${i.id}`)))}>查看与修订 <Icon name="chevron" /></button><DeleteButton target={`用例集「${i.fileName}」`} disabled={busy} onConfirm={() => void perform(async () => { await api(`/imports/${i.id}`, 'DELETE'); await refresh(); setNotice(`已删除用例集「${i.fileName}」`); })} /></td></tr>)}</tbody></table></div></section>)}{!importGroups.filter(g => originFilter ? g.items.some(i => i.origin === originFilter) : true).length && <Empty title="该筛选下没有用例集" text="换一个来源或系统查看，或导入新的工作簿。" />}</> : <Empty title="还没有用例集" text="上传第一个工作簿，或切换到「录制脚本」开始录制。" />}</>}
</>)}
        {page === 'environments' && <EnvironmentPage systems={systems} environments={environments} busy={busy} perform={perform} refresh={refresh} setNotice={setNotice} />}
        {(page === 'runs' || page === 'reports') && (selectedRun && page === 'runs' ? run ? <RunPage run={run} busy={busy} onBack={() => { setSelectedRun(''); void refresh(); }} onControl={action => void perform(async () => { await api(`/runs/${run.id}/${action}`, 'POST'); setRun(await api(`/runs/${run.id}`)); await refresh(); })} /> : <p className="loading">正在读取执行记录…</p> : <><PageHeading eyebrow={page === 'reports' ? 'REPORTS' : 'TEST RUNS'} title={page === 'reports' ? '执行报告' : '测试任务'} text={page === 'reports' ? '查看逐项结论和原始证据，或下载可离线打开的 HTML。' : '进度、结果与中断记录，都保留在这里。'} action={<button className="primary" onClick={() => void perform(refresh)}><Icon name="refresh" />刷新列表</button>} />{runs.length ? <div className="table-wrap"><table><thead><tr><th>任务 / 环境</th><th>状态</th><th>通过率</th><th>执行完成率</th><th>创建时间</th><th /></tr></thead><tbody>{runs.map(r => <tr key={r.id}><td><strong>{r.environment.name}</strong><small className="block mono">{r.id.slice(0, 8)}</small></td><td><Badge status={r.status} /></td><td>{r.metrics.passRate === null ? '暂无可判定结果' : r.metrics.passRate + '%'}</td><td>{r.metrics.completionRate}%</td><td>{date(r.createdAt)}</td><td><div className="row-actions"><button className="text-button" onClick={() => showRun(r.id)}>查看详情</button><DeleteButton target={`任务「${r.environment.name} ${r.id.slice(0, 8)}」`} disabled={busy || active(r.status)} onConfirm={() => void perform(async () => { await api(`/runs/${r.id}`, 'DELETE'); if (selectedRun === r.id) { setSelectedRun(''); setRun(null); } await refresh(); setNotice('已删除任务及其证据文件'); })} />{page === 'reports' && <><a className="text-button" href={`/api/runs/${r.id}/report`} target="_blank" rel="noreferrer">查看报告</a><a className="text-button" href={`/api/runs/${r.id}/report.html`} download>下载 HTML</a></>}</div></td></tr>)}</tbody></table></div> : <Empty title="还没有执行记录" text="从已确认的用例集创建第一轮测试。" action={<button className="secondary" onClick={() => navigate('new')}>新建测试</button>} />}</>)}
        {page === 'settings' && <SettingsPage providers={providers} extensions={extensions} busy={busy} perform={perform} refresh={refresh} setNotice={setNotice} />}
      </div><input ref={uploadInput} type="file" aria-label="上传 Excel 工作簿" className="visually-hidden" accept=".xlsx" onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} /></main>
  </div>;
}

function PageHeading({ eyebrow, title, text, action }: { eyebrow: string; title: string; text: string; action?: React.ReactNode }) { return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{text}</p></div>{action}</div>; }

const recordingLabels: Record<string, string> = { RECORDING: '录制中', COMPLETED: '已完成', INTERRUPTED: '已中断', ERROR: '录制异常' };
// 用例库内嵌的录制区块：开始/进行中状态与录制记录；转换产物直接进下方用例列表。
function RecorderSection({ recordings, busy, perform, refresh, setNotice, onOpenDraft }: { recordings: Recording[]; busy: boolean; perform(work: () => Promise<void>): Promise<void>; refresh(): Promise<void>; setNotice(value: string): void; onOpenDraft(draftId: string): void }) {
  const [name, setName] = useState(''), [startURL, setStartURL] = useState(''), [scriptOf, setScriptOf] = useState<{ id: string; script: string } | null>(null);
  const active = recordings.find(r => r.status === 'RECORDING');
  const start = () => void perform(async () => {
    await api('/recordings', 'POST', { name: name.trim(), startURL: startURL.trim() });
    setName(''); setStartURL(''); await refresh();
    setNotice('录制已开始：在打开的浏览器中操作，关闭该浏览器窗口即结束录制。');
  });
  const abort = (id: string) => void perform(async () => { await api(`/recordings/${id}/abort`, 'POST'); await refresh(); setNotice('录制已结束。脚本如已保存会保留；未落盘的不会伪造生成。'); });
  const convert = (id: string) => void perform(async () => {
    const value = await api<Recording>(`/recordings/${id}/convert`, 'POST');
    await refresh(); setNotice('已生成用例草稿，请在用例库修订并确认。');
    if (value.caseDraftId) onOpenDraft(value.caseDraftId);
  });
  const showScript = (id: string) => void perform(async () => { setScriptOf(await api(`/recordings/${id}/script`)); });
  return <>
    {active
      ? <section className="recorder-active"><div className="recorder-pulse" aria-hidden="true" /><div><h2>正在录制：{active.name}</h2><p>在打开的浏览器窗口中按用例操作一遍。关闭该浏览器窗口即结束并保存脚本；不关闭也可以放弃。</p></div><div className="row-actions"><button className="danger-outline" disabled={busy} onClick={() => abort(active.id)}>结束录制</button></div></section>
      : <form className="panel recorder-start" onSubmit={e => { e.preventDefault(); start(); }}><div className="form-grid"><label>录制名称 <span className="caption">可选</span><input aria-label="录制名称" value={name} onChange={e => setName(e.target.value)} placeholder="例如：登录后提交表单" /></label><label>起始地址 <span className="caption">可选，默认空白页</span><input aria-label="起始地址" type="url" value={startURL} onChange={e => setStartURL(e.target.value)} placeholder="https://test.example.com" /></label></div><div className="card-footer"><span>在打开的系统 Chrome 中人工操作一遍，关闭窗口即结束录制；录制浏览器与测试任务互斥</span><button className="primary" disabled={busy}><Icon name="plus" />开始录制</button></div></form>}
    {scriptOf && <section className="panel recorder-script"><div className="card-heading"><h2>脚本预览</h2><button className="icon-button" aria-label="关闭脚本预览" onClick={() => setScriptOf(null)}><Icon name="close" /></button></div><pre>{scriptOf.script}</pre></section>}
    {recordings.length ? <div className="table-wrap"><table><thead><tr><th>名称</th><th>状态</th><th>开始时间</th><th>用例草稿</th><th /></tr></thead><tbody>{recordings.map(r => <tr key={r.id}><td className="strong">{r.name}<small className="block mono">{r.startURL || '空白页'}</small></td><td><span className={'badge ' + (r.status === 'COMPLETED' ? 'passed' : r.status === 'RECORDING' ? 'running' : 'cancelled')}>{recordingLabels[r.status]}</span></td><td>{date(r.createdAt)}</td><td>{r.caseDraftId ? <button className="text-button" onClick={() => onOpenDraft(r.caseDraftId!)}>查看用例集 <Icon name="chevron" /></button> : '—'}</td><td><div className="row-actions">{r.scriptAvailable && r.status !== 'RECORDING' && <button className="text-button" onClick={() => showScript(r.id)}>查看脚本</button>}{r.status === 'COMPLETED' && !r.caseDraftId && <button className="text-button" disabled={busy} onClick={() => convert(r.id)}>转为用例草稿 <Icon name="arrow" /></button>}{r.status === 'RECORDING' && <button className="text-button danger" disabled={busy} onClick={() => abort(r.id)}>放弃录制</button>}<DeleteButton target={`录制「${r.name}」`} disabled={busy || r.status === 'RECORDING'} onConfirm={() => void perform(async () => { await api(`/recordings/${r.id}`, 'DELETE'); await refresh(); setNotice(`已删除录制「${r.name}」`); })} /></div></td></tr>)}</tbody></table></div> : <Empty title="还没有录制记录" text="开始一次录制，人工操作一遍后转成用例草稿。" />}
  </>;
}

function ImportEditor({ draft: initial, systems, busy, onBack, onAction }: { draft: ImportDraft & { problems?: ImportIssue[] }; systems: System[]; busy: boolean; onBack(): void; onAction(work: () => Promise<ImportDraft>): void }) {
  const [draft, setDraft] = useState(initial), [dirty, setDirty] = useState(false), [mappingDirty, setMappingDirty] = useState(false), [merge, setMerge] = useState<string[]>([]), [mappingMessage, setMappingMessage] = useState(''), [suggesting, setSuggesting] = useState(false);
  const [systemId, setSystemId] = useState(initial.systemId || ''), [newSystem, setNewSystem] = useState('');
  useEffect(() => { setDraft(initial); setDirty(false); setMappingDirty(false); setMerge([]); setSystemId(initial.systemId || ''); setNewSystem(''); }, [initial]);
  const edit = (id: string, change: Partial<TestCase>) => { setDraft(d => ({ ...d, cases: d.cases.map(c => c.id === id ? { ...c, ...change } : c) })); setDirty(true); };
  // “创建新系统”先即时创建系统，再随修订一起保存归属；单独改归属也会生成新版本并取消确认。
  const save = () => {
    if (!dirty) return Promise.resolve(draft);
    const cases = draft.cases.map(c => ({ ...c, preconditions: c.preconditions.map(s => s.trim()).filter(Boolean), steps: c.steps.map(s => s.trim()).filter(Boolean), expectations: c.expectations.map(s => s.trim()).filter(Boolean) }));
    return (async () => {
      let target = systemId;
      if (target === 'new') {
        if (!newSystem.trim()) throw new Error('请填写新系统名称，或选择已有系统');
        target = (await api<System>('/systems', 'POST', { name: newSystem.trim() })).id;
        setSystemId(target); setNewSystem('');
      }
      return api<ImportDraft>(`/imports/${draft.id}`, 'PATCH', { revision: draft.revision, cases, systemId: target });
    })();
  };
  const updateMapping = (sheet: string, mapping: SheetMapping) => { setDraft(d => ({ ...d, mappings: { ...d.mappings, [sheet]: mapping } })); setMappingDirty(true); };
  return <><button className="back" onClick={onBack}>← 返回用例库</button><PageHeading eyebrow="REVIEW BEFORE RUN" title={draft.fileName} text={`版本 v${draft.revision} · ${draft.cases.filter(c => !c.excluded).length} 条保留用例 · ${draft.confirmedAt && !dirty && !mappingDirty ? '已确认，可用于创建任务' : '请核对后确认'}`} action={<div className="row-actions"><button className="secondary" disabled={busy || !dirty || mappingDirty} onClick={() => onAction(save)}>保存修订</button><button className="primary" disabled={busy || mappingDirty || !!draft.confirmedAt && !dirty} onClick={() => onAction(async () => { const saved = await save(); return api(`/imports/${draft.id}/confirm`, 'POST', { revision: saved.revision }); })}><Icon name="check" />确认用例集</button></div>} />
    <div className="case-system panel"><label>所属系统<Select aria-label="所属系统" value={systemId} onChange={e => { setSystemId(e.target.value); setDirty(true); }}><option value="">未指定系统</option>{systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="new">创建新系统…</option></Select></label>{systemId === 'new' && <label>新系统名称<input aria-label="新系统名称" value={newSystem} onChange={e => { setNewSystem(e.target.value); setDirty(true); }} placeholder="例如：CRM 系统" /></label>}<p className="caption">整个用例集归属一个系统；确认版本前必须指定，修改后需要重新确认。</p></div>
    <details className="panel mapping" open={!draft.cases.length}><summary>工作表与字段映射 <span>识别有误时在这里修正</span></summary>{draft.sheets.map(sheet => <div className="sheet" key={sheet.name}><div className="sheet-heading"><label className="checkline"><input type="checkbox" checked={sheet.selected} onChange={e => { setDraft(d => ({ ...d, sheets: d.sheets.map(s => s.name === sheet.name ? { ...s, selected: e.target.checked } : s) })); setMappingDirty(true); }} />{sheet.name} <span className="caption">{sheet.rows} 行</span></label><button className="text-button" disabled={busy || suggesting} onClick={() => { setSuggesting(true); setMappingMessage('正在识别字段，草稿不会自动执行或确认…'); void api<SheetMapping>(`/imports/${draft.id}/suggest-mapping`, 'POST', { sheet: sheet.name }).then(mapping => { updateMapping(sheet.name, mapping); setMappingMessage('已生成映射建议。请核对后点击重新解析。'); }).catch(error => setMappingMessage(error.message)).finally(() => setSuggesting(false)); }}>模型辅助识别</button></div>{sheet.selected && <><div className="mapping-fields"><label>表头所在行<input type="number" min="1" max={sheet.rows} value={draft.mappings[sheet.name]?.headerRow || 1} onChange={e => updateMapping(sheet.name, { ...draft.mappings[sheet.name], headerRow: +e.target.value })} /></label>{(Object.keys(fieldNames) as Field[]).map(field => <label key={field}>{fieldNames[field]}<Select value={draft.mappings[sheet.name]?.columns[field] || ''} onChange={e => { const columns = { ...draft.mappings[sheet.name].columns }; if (e.target.value) columns[field] = +e.target.value; else delete columns[field]; updateMapping(sheet.name, { ...draft.mappings[sheet.name], columns }); }}><option value="">未映射</option>{sheet.preview[(draft.mappings[sheet.name]?.headerRow || 1) - 1]?.map((text, index) => <option key={index} value={index + 1}>{index + 1} 列 · {text || '空表头'}</option>)}</Select></label>)}</div><details><summary>查看原始表格前 10 行</summary><div className="table-wrap preview"><table><tbody>{sheet.preview.slice(0, 10).map((row, i) => <tr key={i}><th>{i + 1}</th>{row.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table></div></details></>}</div>)}{mappingMessage && <p role="status" className="warning-text">{mappingMessage}</p>}<button className="secondary" disabled={busy || !mappingDirty} onClick={() => onAction(() => api(`/imports/${draft.id}/reparse`, 'POST', { revision: draft.revision, sheets: draft.sheets.filter(s => s.selected).map(s => s.name), mappings: draft.mappings }))}>按映射重新解析（替换当前草稿）</button>{mappingDirty && <p className="warning-text">映射已修改，请重新解析后再确认用例。</p>}</details>
    {!!initial.problems?.length && <div className="alert warning"><strong>以下内容需要处理</strong><ul>{initial.problems.map((p, i) => <li key={i}>{p.sheet}{p.row ? ` 第 ${p.row} 行` : ''}：{p.message}</li>)}</ul></div>}
    <div className="editor-toolbar"><span className="caption">步骤与预期分别编号，不要求数量相等。修改后会生成新版本。</span><button className="secondary small" disabled={merge.length !== 2 || busy || dirty} onClick={() => onAction(() => api(`/imports/${draft.id}/merge`, 'POST', { revision: draft.revision, caseIds: merge }))}>合并所选两条</button></div>
    {draft.cases.map((c, index) => <article className={'case-editor panel ' + (c.excluded ? 'excluded' : '')} key={c.id}><div className="case-top"><div className="row-actions"><input type="checkbox" aria-label={`选择合并第 ${index + 1} 条用例`} checked={merge.includes(c.id)} onChange={e => setMerge(m => e.target.checked ? [...m, c.id] : m.filter(id => id !== c.id))} /><span className="case-number">{String(index + 1).padStart(2, '0')}</span><span className="source">{c.source.sheet} · 原始行 {c.source.rows.join('、')}</span></div><label className="checkline"><input type="checkbox" checked={c.excluded} onChange={e => edit(c.id, { excluded: e.target.checked })} />排除本条</label></div><div className="case-fields"><label>用例编号<input aria-label={`用例 ${index + 1} 编号`} value={c.externalId} onChange={e => edit(c.id, { externalId: e.target.value })} /></label><label className="wide">用例标题<input aria-label={`用例 ${index + 1} 标题`} value={c.title} onChange={e => edit(c.id, { title: e.target.value })} /></label><label>模块<input value={c.module} onChange={e => edit(c.id, { module: e.target.value })} /></label><label>优先级<input value={c.priority} onChange={e => edit(c.id, { priority: e.target.value })} /></label></div><label className="textarea-label">前置条件<textarea aria-label={`用例 ${index + 1} 前置条件`} rows={2} value={c.preconditions.join('\n')} onChange={e => edit(c.id, { preconditions: e.target.value.split('\n') })} /></label><div className="case-text-columns">{(['steps', 'expectations'] as const).map(field => <label key={field}>{fieldNames[field]} <span className="caption">每行一项</span><textarea aria-label={`用例 ${index + 1} ${fieldNames[field]}`} rows={Math.max(4, c[field].length + 1)} value={c[field].join('\n')} onChange={e => edit(c.id, { [field]: e.target.value.split('\n') })} /></label>)}</div>{c.externalId && draft.cases.filter(x => !x.excluded && x.externalId === c.externalId).length > 1 && <label className="checkline warning-text"><input type="checkbox" checked={c.duplicateAcknowledged} onChange={e => edit(c.id, { duplicateAcknowledged: e.target.checked })} />编号重复，已核对并明确保留此条</label>}{draft.issues.some(i => i.caseId === c.id && i.blocking) && <label className="checkline warning-text"><input type="checkbox" checked={c.issuesResolved || false} onChange={e => edit(c.id, { issuesResolved: e.target.checked })} />已根据原始来源人工补充、修正本条解析问题</label>}<div className="case-bottom"><details><summary>原始来源文本</summary><pre>{c.source.original.join('\n')}</pre></details>{c.steps.length > 1 && <details><summary>拆分用例</summary><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); onAction(async () => { const saved = await save(); return api(`/imports/${draft.id}/split`, 'POST', { revision: saved.revision, caseId: c.id, stepIndex: Number(data.get('stepIndex')), expectationIndex: Number(data.get('expectationIndex')) }); }); }}><label>前一条保留的步骤数<input name="stepIndex" type="number" min="1" max={c.steps.length - 1} defaultValue="1" /></label><label>前一条保留的预期数<input name="expectationIndex" type="number" min="0" max={c.expectations.length} defaultValue="1" /></label><button className="secondary small" disabled={busy}>确认拆分</button></form></details>}</div></article>)}
  </>;
}

const blankEnv = { systemId: '', name: '', baseURL: '', loginURL: '', username: '', password: '', captchaStrategy: 'none', captchaCode: '' };
function EnvironmentPage({ systems, environments, busy, perform, refresh, setNotice }: { systems: System[]; environments: PublicEnvironment[]; busy: boolean; perform(work: () => Promise<void>): Promise<void>; refresh(): Promise<void>; setNotice(value: string): void }) {
  const [editing, setEditing] = useState<string | null>(null), [form, setForm] = useState({ ...blankEnv }), [newSystem, setNewSystem] = useState('');
  const set = (field: keyof typeof blankEnv, value: string) => setForm(f => ({ ...f, [field]: value }));
  return <><PageHeading eyebrow="TEST ENVIRONMENTS" title="系统与环境" text="每个环境使用一组账号。登录与前置准备在真实网页中完成。" action={<button className="primary" onClick={() => { setEditing('new'); setForm({ ...blankEnv }); }}><Icon name="plus" />添加环境</button>} />{systems.length > 0 && <section className="panel system-strip"><div className="card-heading"><h2>被测系统</h2><span className="caption">系统下还有环境时不能删除</span></div><ul>{systems.map(s => <li key={s.id}><span>{s.name}<small className="caption">{environments.filter(e => e.systemId === s.id).length} 个环境</small></span><DeleteButton target={`系统「${s.name}」`} disabled={busy} onConfirm={() => void perform(async () => { await api(`/systems/${s.id}`, 'DELETE'); await refresh(); setNotice(`已删除系统「${s.name}」`); })} /></li>)}</ul></section>}{editing !== null && <section className="panel environment-form"><div className="card-heading"><h2>{editing === 'new' ? '添加测试环境' : '编辑测试环境'}</h2><button className="icon-button" aria-label="关闭环境编辑" onClick={() => setEditing(null)}><Icon name="close" /></button></div><form onSubmit={e => { e.preventDefault(); void perform(async () => { let systemId = form.systemId; if (!systemId && newSystem.trim()) systemId = (await api<System>('/systems', 'POST', { name: newSystem })).id; if (!systemId) throw new Error('请选择系统或填写新的系统名称'); await api(editing === 'new' ? '/environments' : `/environments/${editing}`, editing === 'new' ? 'POST' : 'PATCH', { ...form, systemId }); setForm({ ...blankEnv }); setNewSystem(''); setEditing(null); await refresh(); }); }}><div className="form-grid"><label>所属系统<Select aria-label="所属系统" value={form.systemId} onChange={e => set('systemId', e.target.value)}><option value="">创建新系统</option>{systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>{!form.systemId && <label>新系统名称<input aria-label="新系统名称" value={newSystem} onChange={e => setNewSystem(e.target.value)} required /></label>}<label>环境名称<input aria-label="环境名称" value={form.name} onChange={e => set('name', e.target.value)} placeholder="例如：测试环境" required /></label><label>系统地址<input aria-label="系统地址" type="url" value={form.baseURL} onChange={e => set('baseURL', e.target.value)} placeholder="https://test.example.com" required /></label><label>登录地址 <span className="caption">可选</span><input aria-label="登录地址" type="url" value={form.loginURL} onChange={e => set('loginURL', e.target.value)} /></label><label>用户名 <span className="caption">无需登录时留空</span><input aria-label="用户名" autoComplete="off" value={form.username} onChange={e => set('username', e.target.value)} /></label><label>密码<input aria-label="密码" type="password" autoComplete="new-password" value={form.password} onChange={e => set('password', e.target.value)} placeholder={editing !== 'new' ? '留空保留已有密码' : '只保存在本机服务端'} /></label><label>验证码方式<Select aria-label="验证码方式" value={form.captchaStrategy} onChange={e => set('captchaStrategy', e.target.value)}><option value="none">无验证码</option><option value="image">普通字符图片</option><option value="test-code">测试专用验证码</option><option value="manual">需要人工或单独适配</option></Select></label>{form.captchaStrategy === 'test-code' && <label>测试验证码<input aria-label="测试验证码" type="password" value={form.captchaCode} onChange={e => set('captchaCode', e.target.value)} /></label>}</div><div className="card-footer"><span>凭证在本机加密保存，不写入执行报告</span><button className="primary" disabled={busy}>保存环境</button></div></form></section>}{environments.length ? <div className="environment-grid">{environments.map(env => <section className="panel environment-card" key={env.id}><div className="env-icon"><Icon name="env" /></div><span className="eyebrow">{systems.find(s => s.id === env.systemId)?.name}</span><h2>{env.name}</h2><p className="env-url">{env.baseURL}</p><div className="env-meta"><span>{env.hasPassword ? '已配置登录账号' : '无需账号'}</span><span>{env.captchaStrategy === 'none' ? '无验证码' : '已选择验证码方式'}</span></div><button className="text-button" onClick={() => { setEditing(env.id); setForm({ ...blankEnv, ...env, password: '', captchaCode: '' }); }}>编辑环境 <Icon name="chevron" /></button><DeleteButton target={`环境「${env.name}」`} disabled={busy} onConfirm={() => void perform(async () => { await api(`/environments/${env.id}`, 'DELETE'); if (editing === env.id) setEditing(null); await refresh(); setNotice(`已删除环境「${env.name}」`); })} /></section>)}</div> : <Empty title="添加第一个测试环境" text="填写被测系统地址。需要登录时，再配置该环境的一组账号。" />}</>;
}

function RunPage({ run, busy, onBack, onControl }: { run: RunDetail; busy: boolean; onBack(): void; onControl(action: string): void }) {
  const [pane, setPane] = useState<'cases' | 'events'>('cases');
  return <><button className="back" onClick={onBack}>← 返回任务列表</button><PageHeading eyebrow="EXECUTION DETAILS" title={run.environment.name} text={`任务 ${run.id.slice(0, 8)} · ${date(run.createdAt)}`} action={<div className="row-actions">{run.status === 'RUNNING' && <button className="secondary" disabled={busy} onClick={() => onControl('pause')}>暂停</button>}{run.status === 'PAUSED' && <button className="primary" disabled={busy} onClick={() => onControl('resume')}>继续</button>}{active(run.status) && <button className="danger-outline" disabled={busy || run.status === 'STOPPING'} onClick={() => onControl('stop')}>停止</button>}<a className="secondary" href={`/api/runs/${run.id}/report.html`} download>下载 HTML</a></div>} /><div className="run-summary panel"><div><Badge status={run.status} /><p title={run.reason || undefined}>{run.reason || (active(run.status) ? '正在操作本机的独立浏览器，请避免手动干预。' : '处理结束不代表全部验证通过，请查看逐项结果。')}</p></div><dl><div><dt>通过率</dt><dd>{run.metrics.passRate === null ? <small>暂无可判定结果</small> : run.metrics.passRate + '%'}</dd></div><div><dt>执行完成率</dt><dd>{run.metrics.completionRate}%</dd></div><div><dt>处理进度</dt><dd>{run.metrics.progress}%</dd></div><div><dt>用例总数</dt><dd>{run.metrics.total}</dd></div></dl></div><div className="counts">{Object.entries(run.metrics.counts).map(([s, n]) => <span key={s}><Badge status={s} /><b>{n}</b></span>)}</div><div className="workspace-pane-switch" aria-label="详情区域"><button aria-pressed={pane === 'cases'} onClick={() => setPane('cases')}>用例结果</button><button aria-pressed={pane === 'events'} onClick={() => setPane('events')}>执行记录</button></div><div className="run-layout" data-pane={pane}><div className="case-results-scroll" tabIndex={0} role="region" aria-label="用例结果与证据">{run.cases.map(c => { const r = run.results.find(r => r.caseId === c.id)!; return <details className="panel result-case" key={c.id} open={r.status === 'RUNNING' || r.status === 'FAILED' || r.status === 'ERROR'}><summary><span>{c.externalId && <small className="mono">{c.externalId}</small>}<strong>{c.title}</strong></span><Badge status={r.status} /></summary><p className="source">{c.source.fileName} / {c.source.sheet} / 原始行 {c.source.rows.join('、')}</p>{r.status === 'RUNNING' && <p className="current-phase">{{AUTHENTICATING:'正在登录',PREPARING:'检查并准备前置条件',EXECUTING:'正在执行步骤',VERIFYING:'正在验证预期'}[r.phase] || '正在检查用例'}</p>}<p>{r.reason}</p><h4>操作步骤</h4><ol className="steps">{r.steps.map(s => <li key={s.id}><span>{s.text}</span><Badge status={s.status} /></li>)}</ol><h4>预期与实际</h4>{c.expectations.map((expected, i) => { const a = r.assertions.find(a => a.expectationId === `e${i + 1}`); return <div className="assertion" key={i}><div><strong>{expected}</strong><Badge status={a?.status || 'PENDING'} /></div><p>{a?.actual || '尚未验证'}</p><div className="evidence-links">{a?.evidenceIds.map(id => <a key={id} target="_blank" rel="noreferrer" href={`/api/runs/${run.id}/evidence/${id}`}>查看证据 {id.slice(0, 6)} ↗</a>)}</div></div>; })}<div className="screenshots">{r.evidence.filter(e => e.kind === 'screenshot').map(e => <a key={e.id} target="_blank" rel="noreferrer" href={`/api/runs/${run.id}/evidence/${e.id}`}><img alt={`${c.title}步骤截图`} src={`/api/runs/${run.id}/evidence/${e.id}`} loading="lazy" /></a>)}</div></details>; })}</div><ExecutionLog key={run.id} events={run.events} running={active(run.status)} /></div></>;
}

createRoot(document.getElementById('root')!).render(<App />);

// 设置页：左侧分类、右侧配置。当前只有「模型」一组真实设置，其余分类不伪造内容。
type ProviderForm = { name: string; baseURL: string; modelId: string; apiKey: string; contextWindow: string; maxTokens: string; inputText: boolean; inputImage: boolean; reasoning: boolean; thinkingLevel: string };
const blankProvider: ProviderForm = { name: '', baseURL: '', modelId: '', apiKey: '', contextWindow: '65536', maxTokens: '4096', inputText: true, inputImage: true, reasoning: false, thinkingLevel: 'off' };
const thinkingLevelLabels: Record<string, string> = { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
const settingsSections = [
  { id: 'model', icon: 'model', text: '模型' },
  { id: 'skills', icon: 'file', text: 'Skills' },
  { id: 'mcp', icon: 'env', text: 'MCP' },
] as const;

function SettingsPage({ providers, extensions, busy, perform, refresh, setNotice }: { providers: PublicModelProvider[]; extensions: Extensions | null; busy: boolean; perform(work: () => Promise<void>): Promise<void>; refresh(): Promise<void>; setNotice(value: string): void }) {
  const [section, setSection] = useState<string>('model');
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>({ ...blankProvider });
  const set = (field: keyof ProviderForm, value: string) => setForm(f => ({ ...f, [field]: value }));
  const close = () => { setEditing(null); setForm({ ...blankProvider }); };
  const active = providers.find(p => p.active);
  return <>
    <PageHeading eyebrow="SETTINGS" title="设置" text="模型配置保存在本机服务端，API 密钥不下发到页面或进入执行报告。" />
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        {settingsSections.map(item => <button key={item.id} className={section === item.id ? 'selected' : ''} onClick={() => setSection(item.id)} aria-current={section === item.id ? 'page' : undefined}>
          <Icon name={item.icon} /><span>{item.text}</span>
        </button>)}
      </nav>
      <section className="settings-body" aria-label="设置内容">
        {section === 'skills' && <><header className="settings-heading"><div><h2>Skills</h2><p>Skills 是按需读取的能力说明，不等同于权限隔离。只有明确配置的可信目录才会被加载。</p></div><span className="badge pending">尚未启用</span></header><div className="settings-notice"><h3>当前没有加载任何 Skill</h3><p>执行器以 <code>noSkills</code> 启动，不读取磁盘上的 Skill，也不加载用户上传工作簿中的内容。可信目录与受限文件读取仍在实现中，因此这里不提供启停开关——避免出现按了却没生效的设置项。</p></div></>}
        {section === 'mcp' && <><header className="settings-heading"><div><h2>MCP</h2><p>通过 stdio 连接本地 MCP 服务。P0 只启用 Playwright 一个，用于操作本机可见浏览器。</p></div></header><div className="provider-list">{(extensions?.mcp ?? [{ name: 'Playwright', version: '0.0.83', enabled: true, connection: '按需连接' }]).map(item => <article className="provider-card" key={item.name}><div className="provider-main"><span className={'provider-dot' + (item.enabled ? ' on' : '')} aria-hidden="true" /><div><h3>{item.name}</h3><p className="provider-model">v{item.version}<small>{item.connection}</small></p></div></div><div className="row-actions"><span className={'badge ' + (item.enabled ? 'passed' : 'pending')}>{item.enabled ? '已启用' : '未启用'}</span></div></article>)}</div><div className="settings-notice"><h3>MCP 由服务端固定配置</h3><p>服务启动时以固定参数拉起 Playwright MCP（隔离 profile、禁用 service worker、限制允许的来源）。P0 不提供在线安装或添加其他 MCP 服务，以免把不可信来源引入执行环境。</p></div></>}
        {section === 'model' && <>
        <header className="settings-heading"><div><h2>模型</h2><p>填写各提供商的 API 密钥即可使用其模型。同一时间只有一个提供商处于启用状态。</p></div>{active && <span className="badge passed">已启用：{active.name}</span>}</header>

        <div className="provider-list">
          {providers.map(provider => <article className={'provider-card' + (provider.active ? ' active' : '')} key={provider.id}>
            <div className="provider-main">
              <span className={'provider-dot' + (provider.active ? ' on' : '')} aria-hidden="true" />
              <div><h3>{provider.name}</h3><p className="provider-model">{provider.modelId}<small>{provider.baseURL}</small></p></div>
            </div>
            <div className="row-actions">
              {provider.active ? <span className="caption">使用中</span> : <button className="text-button" disabled={busy} onClick={() => void perform(async () => { await api(`/model-providers/${provider.id}/activate`, 'POST'); await refresh(); setNotice(`已启用「${provider.name}」`); })}>启用</button>}
              <button className="text-button" disabled={busy} onClick={() => { setEditing(provider.id); setForm({ name: provider.name, baseURL: provider.baseURL, modelId: provider.modelId, apiKey: '', contextWindow: String(provider.contextWindow), maxTokens: String(provider.maxTokens), inputText: provider.inputText, inputImage: provider.inputImage, reasoning: provider.reasoning, thinkingLevel: provider.thinkingLevel }); }}>编辑</button>
              <DeleteButton target={`提供商「${provider.name}」`} disabled={busy} onConfirm={() => void perform(async () => { await api(`/model-providers/${provider.id}`, 'DELETE'); if (editing === provider.id) close(); await refresh(); setNotice(`已删除提供商「${provider.name}」`); })} />
            </div>
          </article>)}
          {!providers.length && <p className="settings-empty">还没有配置模型提供商。添加一个之后才能创建测试任务。</p>}
        </div>

        {editing === null
          ? <button className="provider-add" disabled={busy} onClick={() => { setEditing('new'); setForm({ ...blankProvider }); }}><Icon name="plus" />添加模型提供商</button>
          : <form className="panel provider-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
              const payload = { ...form, contextWindow: Number(form.contextWindow), maxTokens: Number(form.maxTokens), ...(form.reasoning ? {} : { thinkingLevel: 'off' }) };
              await api(editing === 'new' ? '/model-providers' : `/model-providers/${editing}`, editing === 'new' ? 'POST' : 'PATCH', payload);
              close(); await refresh(); setNotice(editing === 'new' ? '已添加模型提供商' : '已更新模型提供商');
            }); }}>
            <div className="card-heading"><h2>{editing === 'new' ? '添加模型提供商' : '编辑模型提供商'}</h2><button type="button" className="icon-button" aria-label="关闭提供商编辑" onClick={close}><Icon name="close" /></button></div>
            <div className="form-grid">
              <label>显示名称<input aria-label="提供商名称" value={form.name} onChange={e => set('name', e.target.value)} placeholder="例如：内部网关" required /></label>
              <label>模型 ID<input aria-label="模型 ID" value={form.modelId} onChange={e => set('modelId', e.target.value)} placeholder="例如：openai/deepseek-v4.1-flash" required /></label>
              <label className="wide-field">接口地址<input aria-label="接口地址" type="url" value={form.baseURL} onChange={e => set('baseURL', e.target.value)} placeholder="https://gateway.example.com/v1" required /></label>
              <label className="wide-field">API 密钥<input aria-label="API 密钥" type="password" autoComplete="new-password" value={form.apiKey} onChange={e => set('apiKey', e.target.value)} placeholder={editing === 'new' ? '只保存在本机服务端' : '留空保留已有密钥'} required={editing === 'new'} /></label>
            </div>
            <details className="provider-advanced" open>
              <summary>自定义配置 <span className="caption">窗口、输出上限、输入类型与思考档位</span></summary>
              <div className="form-grid">
                <label>上下文窗口<input aria-label="上下文窗口" type="number" min={1024} max={2000000} step={1024} value={form.contextWindow} onChange={e => set('contextWindow', e.target.value)} /><span className="field-hint">单位 token，默认 65536</span></label>
                <label>最大输出 token 数<input aria-label="最大输出 token 数" type="number" min={256} max={1000000} step={256} value={form.maxTokens} onChange={e => set('maxTokens', e.target.value)} /><span className="field-hint">不能超过上下文窗口</span></label>
              </div>
              <fieldset className="provider-flags">
                <legend>输入类型</legend>
                <label className="checkline"><input type="checkbox" checked disabled />文本<span className="caption">执行器必需</span></label>
                <label className="checkline"><input type="checkbox" aria-label="支持图像输入" checked={form.inputImage} onChange={e => setForm(f => ({ ...f, inputImage: e.target.checked }))} />图像<span className="caption">验证码与视觉预期需要</span></label>
              </fieldset>
              <fieldset className="provider-flags">
                <legend>推理</legend>
                <label className="checkline"><input type="checkbox" aria-label="开启推理" checked={form.reasoning} onChange={e => setForm(f => ({ ...f, reasoning: e.target.checked, ...(e.target.checked ? {} : { thinkingLevel: 'off' }) }))} />模型支持深度思考</label>
              </fieldset>
              <div className="form-grid">
                <label>思考档位<Select aria-label="思考档位" value={form.thinkingLevel} disabled={!form.reasoning} onChange={e => set('thinkingLevel', e.target.value)}>{Object.entries(thinkingLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><span className="field-hint">{form.reasoning ? '档位越高耗时越长' : '开启推理后可选择'}</span></label>
              </div>
            </details>
            <div className="card-footer"><span>执行前会校验该提供商的工具调用与图像能力，不满足时记执行异常，不伪造通过</span><button className="primary" disabled={busy}>保存提供商</button></div>
          </form>}
        </>}
      </section>
    </div>
  </>;
}
