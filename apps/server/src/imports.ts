import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Field, ImportDraft, ImportIssue, SheetMapping, TestCase } from '../../../packages/contracts/src/p0.ts';
import { Store } from './storage.ts';

export const aliases: Record<Field, string[]> = {
  externalId: ['用例编号', '用例id', '编号', 'caseid', 'id'], module: ['模块', '所属模块', '功能模块', 'module'],
  title: ['用例标题', '用例名称', '标题', '测试点', 'title', 'name'], priority: ['优先级', 'priority', '级别'],
  preconditions: ['前置条件', '前提条件', '预置条件', 'preconditions', '前置'],
  steps: ['操作步骤', '测试步骤', '步骤', 'steps', '操作'], expectations: ['预期结果', '期望结果', '预期', 'expectedresult', 'expectations'],
};
const normalize = (s: string) => s.toLowerCase().replace(/[\s_\-：:]/g, '');
const lines = (s: string) => s.split(/\r?\n/).map(s => s.replace(/^\s*(?:\d+[.、)）]|[（(]\d+[)）])\s*/, '').trim()).filter(Boolean);

function validateZip(bytes: Buffer) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('文件不是有效的 xlsx，或工作簿已加密');
  const entries = bytes.readUInt16LE(eocd + 10), offset = bytes.readUInt32LE(eocd + 16);
  if (!entries || entries > 5000 || entries === 0xffff || offset === 0xffffffff) throw new Error('工作簿结构或大小超出 P0 支持范围');
  let cursor = offset, total = 0;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('工作簿压缩目录损坏');
    const size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    if (/vbaProject\.bin$/i.test(name)) throw new Error('P0 不支持包含宏的工作簿');
    if (size > 16 * 1024 * 1024 || (total += size) > 32 * 1024 * 1024) throw new Error('工作簿解压后过大，请拆分后导入');
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
}

function cellText(cell: ExcelJS.Cell): { text: string; issue?: string; blocking?: boolean } {
  const value = cell.value;
  if (value === null || value === undefined) return { text: '' };
  if (value instanceof Date) return { text: value.toISOString().slice(0, 10) };
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      if (value.result === undefined || value.result === null) return { text: '', issue: '公式没有有效缓存值；不会计算公式，请手动补充或排除用例', blocking: true };
      return { text: String(value.result), issue: '公式仅使用文件内的缓存值，未执行计算', blocking: false };
    }
    if ('richText' in value) return { text: value.richText.map(part => part.text).join('') };
    if ('hyperlink' in value) return { text: value.text || value.hyperlink, issue: '保留链接文字，未访问外部链接', blocking: false };
    if ('error' in value) return { text: '', issue: '单元格含 Excel 错误值，请手动补充或排除用例', blocking: true };
  }
  return { text: String(value) };
}

export async function parseWorkbook(bytes: Buffer, fileName: string, selected?: string[], overrides: Record<string, SheetMapping> = {}) {
  validateZip(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  if (workbook.worksheets.length > 30) throw new Error('工作表超过 30 个，请拆分后导入');
  const cases: TestCase[] = [], issues: ImportIssue[] = [], mappings: Record<string, SheetMapping> = Object.create(null);
  const sheets: ImportDraft['sheets'] = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > 5000 || sheet.columnCount > 100) throw new Error(`工作表“${sheet.name}”超过 5000 行或 100 列，请拆分`);
    const rows: string[][] = [];
    for (let row = 1; row <= sheet.rowCount; row++) rows.push(Array.from({ length: sheet.columnCount }, (_, i) => cellText(sheet.getCell(row, i + 1)).text));
    const included = !selected || selected.includes(sheet.name);
    sheets.push({ name: sheet.name, rows: sheet.rowCount, selected: included, preview: rows.slice(0, 100) });
    let mapping: SheetMapping = { headerRow: 1, columns: {} }, score = 0;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const columns: Partial<Record<Field, number>> = {};
      rows[i]!.forEach((text, j) => { for (const field of Object.keys(aliases) as Field[]) if (aliases[field].some(alias => normalize(alias) === normalize(text))) columns[field] = j + 1; });
      if (Object.keys(columns).length > score) { score = Object.keys(columns).length; mapping = { headerRow: i + 1, columns }; }
    }
    if (Object.hasOwn(overrides, sheet.name)) mapping = overrides[sheet.name]!;
    if (!Number.isInteger(mapping.headerRow) || mapping.headerRow < 1 || mapping.headerRow > sheet.rowCount || Object.values(mapping.columns).some(c => !Number.isInteger(c) || c! < 1 || c! > sheet.columnCount) || new Set(Object.values(mapping.columns)).size !== Object.values(mapping.columns).length) throw new Error('表头行或字段映射无效，请检查是否重复映射列');
    mappings[sheet.name] = mapping;
    if (!included) continue;
    if (!mapping.columns.title || !mapping.columns.steps || !mapping.columns.expectations) { issues.push({ sheet: sheet.name, message: '无法识别标题、步骤或预期列，请修正字段映射', blocking: true }); continue; }
    let previous: TestCase | undefined, previousAnchor = '';
    for (let row = mapping.headerRow + 1; row <= sheet.rowCount; row++) {
      const values = Object.fromEntries((Object.keys(aliases) as Field[]).map(field => [field, mapping.columns[field] ? rows[row - 1]![mapping.columns[field]! - 1] || '' : ''])) as Record<Field, string>;
      if (!Object.values(values).some(v => v.trim())) continue;
      const idCol = mapping.columns.externalId, titleCol = mapping.columns.title;
      const groupCell = idCol && sheet.getCell(row, idCol).isMerged ? sheet.getCell(row, idCol) : titleCol && sheet.getCell(row, titleCol).isMerged ? sheet.getCell(row, titleCol) : undefined;
      const anchor = groupCell?.master.address || '';
      const continuation = Boolean(previous && anchor && anchor === previousAnchor);
      const current: TestCase = continuation ? previous! : { id: randomUUID(), externalId: values.externalId.trim(), module: values.module.trim(), title: values.title.trim(), priority: values.priority.trim(), preconditions: [], steps: [], expectations: [], source: { fileName, sheet: sheet.name, rows: [], original: [] }, excluded: false, duplicateAcknowledged: false };
      current.source.rows.push(row); current.source.original.push(JSON.stringify(rows[row - 1]));
      for (const field of ['preconditions', 'steps', 'expectations'] as const) {
        const column = mapping.columns[field];
        if (!column) continue;
        const cell = sheet.getCell(row, column);
        if (!(continuation && cell.isMerged && Number(cell.master.row) < row)) current[field].push(...lines(values[field]));
      }
      for (const [field, col] of Object.entries(mapping.columns)) {
        const detail = cellText(sheet.getCell(row, col!));
        if (detail.issue) issues.push({ caseId: current.id, sheet: sheet.name, row, message: `${aliases[field as Field]?.[0] || field}：${detail.issue}`, blocking: detail.blocking || false });
      }
      if (!continuation) cases.push(current);
      previous = current; previousAnchor = anchor;
    }
  }
  if (cases.length > 1000) throw new Error('用例超过 1000 条，请分批导入');
  return { sheets, mappings, cases, issues };
}

export function importProblems(draft: ImportDraft): ImportIssue[] {
  const included = draft.cases.filter(c => !c.excluded);
  const issues = draft.issues.filter(issue => !issue.caseId && issue.blocking);
  for (const c of included) {
    if (!c.title.trim() || !c.steps.length || !c.expectations.length || c.steps.some(x => !x.trim()) || c.expectations.some(x => !x.trim())) issues.push({ caseId: c.id, sheet: c.source.sheet, message: '标题、步骤与预期必须完整', blocking: true });
    if (c.externalId && included.filter(other => other.externalId === c.externalId).length > 1 && !c.duplicateAcknowledged) issues.push({ caseId: c.id, sheet: c.source.sheet, message: `编号 ${c.externalId} 重复，请明确确认或修正`, blocking: true });
    // 原始解析问题只能由用户修订该用例或排除解决，不能静默忽略。
    if (!c.issuesResolved) for (const issue of draft.issues.filter(i => i.caseId === c.id && i.blocking)) issues.push(issue);
  }
  if (!included.length) issues.push({ sheet: '', message: '至少保留一条完整用例', blocking: true });
  return issues;
}

export async function createImport(store: Store, bytes: Buffer, name: string) {
  if (!/\.xlsx$/i.test(name)) throw new Error('当前支持 .xlsx；旧版 .xls、加密文件和宏工作簿请转换后再导入');
  const fileName = path.basename(name).slice(0, 200), id = randomUUID();
  const parsed = await parseWorkbook(bytes, fileName);
  const dir = path.join(store.dataDir, 'imports', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'original.xlsx'), bytes, { mode: 0o600 });
  return store.put<ImportDraft>('import', { id, fileName, revision: 1, confirmedAt: null, createdAt: new Date().toISOString(), ...parsed });
}

export async function reparseImport(store: Store, id: string, selected: string[], mappings: Record<string, SheetMapping>) {
  const draft = store.get<ImportDraft>('import', id);
  if (!selected.length || selected.some(s => !draft.sheets.some(sheet => sheet.name === s))) throw new Error('请选择有效工作表');
  const parsed = await parseWorkbook(readFileSync(path.join(store.dataDir, 'imports', id, 'original.xlsx')), draft.fileName, selected, mappings);
  return store.put('import', { ...draft, ...parsed, revision: draft.revision + 1, confirmedAt: null });
}

export function reviseImport(store: Store, id: string, revision: number, edits: TestCase[]) {
  const draft = store.get<ImportDraft>('import', id);
  if (draft.revision !== revision) throw Object.assign(new Error('草稿已更新，请刷新后修改'), { statusCode: 409 });
  if (!Array.isArray(edits) || edits.length > 1000 || new Set(edits.map(c => c.id)).size !== edits.length) throw new Error('用例列表无效或内部编号重复');
  const cases = edits.map(c => {
    const original = draft.cases.find(o => o.id === c.id);
    if (!original || typeof c.title !== 'string' || typeof c.externalId !== 'string' || !['preconditions', 'steps', 'expectations'].every(key => Array.isArray(c[key as keyof TestCase]) && (c[key as 'steps'] as unknown[]).every(s => typeof s === 'string' && s.length <= 10000))) throw new Error('修订用例格式无效');
    return { ...original, externalId: c.externalId, title: c.title, module: String(c.module || ''), priority: String(c.priority || ''), preconditions: c.preconditions, steps: c.steps, expectations: c.expectations, excluded: c.excluded === true, duplicateAcknowledged: c.duplicateAcknowledged === true, issuesResolved: c.issuesResolved === true };
  });
  if (cases.length !== draft.cases.length) throw new Error('请通过排除标记保留原始用例，不能静默删除');
  return store.put('import', { ...draft, cases, revision: draft.revision + 1, confirmedAt: null });
}

export function confirmImport(store: Store, id: string, revision: number) {
  const draft = store.get<ImportDraft>('import', id);
  if (draft.revision !== revision) throw Object.assign(new Error('确认版本已变化，请刷新'), { statusCode: 409 });
  if (draft.confirmedAt) return draft;
  const problems = importProblems(draft);
  if (problems.length) throw new Error(problems.map(p => p.message).join('；'));
  const confirmed = { ...draft, confirmedAt: new Date().toISOString() };
  store.put('import-version', { ...confirmed, id: `${id}:${revision}`, importId: id });
  return store.put('import', confirmed);
}
