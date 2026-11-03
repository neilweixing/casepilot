import { randomUUID } from 'node:crypto';
import type { ImportIssue, TestCase } from '../../../packages/contracts/src/p0.ts';

// 把 codegen 生成的 JavaScript 逐行解析为自然语言步骤与预期结果。
// 只映射基本操作；无法识别的行原样保留为步骤并登记非阻塞 issue，人工修订后再确认。
export interface ParsedScript {
  title: string;
  steps: string[];
  expectations: string[];
  issues: ImportIssue[];
}

// getByRole/getByLabel 等定位器描述转成"「名称」"提示；保留给 Agent 提高首轮定位成功率。
function locatorDescription(expression: string): string {
  const named = expression.match(/getBy(?:Role|Label|Text|Placeholder|AltText|Title|TestId)\((.+)\)/);
  if (!named) return '';
  const parts: string[] = [];
  const name = named[1]!.match(/name:\s*['"]([^'"]+)['"]/) || named[1]!.match(/^['"]([^'"]+)['"]/);
  if (name?.[1]) parts.push(`「${name[1]}」`);
  const role = named[1]!.match(/^['"](\w+)['"]/);
  if (role?.[1]) parts.push(role[1]);
  return parts.join(' ');
}

function trimQuoted(value: string | undefined): string {
  return (value || '').replace(/^['"]|['"]$/g, '').trim();
}

// 取出 JS 单引号字符串字面量的内容：容忍 \' 转义，并把 \' 还原为 '。
function unquoteSingle(source: string | undefined): string {
  if (!source) return '';
  const match = source.match(/^'((?:\\'|[^'])*)'/);
  return match ? match[1]!.replace(/\\'/g, "'").trim() : trimQuoted(source);
}

export function parseRecording(script: string, sourceName: string): ParsedScript {
  const steps: string[] = [], expectations: string[] = [], issues: ImportIssue[] = [];
  let title = '';
  const lines = script.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || /^(const|let|import|require|\}\)|\{|\};|\);|async|\(async)/.test(line)) continue;
    // await page.goto('...') → 打开 URL
    let match = line.match(/^await (?:page|context)\.goto\(['"]([^'"]+)['"]/);
    if (match) {
      if (!title) { title = match[1]!; steps.push(`打开页面 ${match[1]}`); }
      else steps.push(`打开页面 ${match[1]}`);
      continue;
    }
    // await page.getByRole('button', { name: 'x' }).click() → 点击「x」
    match = line.match(/^await page\.(.+)\.click\(/);
    if (match) { steps.push(`点击${locatorDescription(match[1]!) || '页面元素'}（${match[1]!.slice(0, 120)}）`); continue; }
    // await page.getByLabel('x').fill('y') → 输入；fill 值可能含 \' 转义
    match = line.match(/^await page\.(.+)\.fill\((.*)\);?$/);
    if (match) { steps.push(`在${locatorDescription(match[1]!) || '输入框'}输入“${unquoteSingle(match[2])}”`); continue; }
    match = line.match(/^await page\.(.+)\.press\(['"]([^'"]+)['"]/);
    if (match) { steps.push(`在${locatorDescription(match[1]!) || '焦点处'}按键 ${trimQuoted(match[2])}`); continue; }
    match = line.match(/^await page\.(.+)\.(check|uncheck|select_option|selectOption)\(/);
    if (match) { steps.push(`${match[2] === 'check' ? '勾选' : match[2] === 'uncheck' ? '取消勾选' : '选择'}${locatorDescription(match[1]!) || '控件'}`); continue; }
    // await expect(page.getByText('x')).toBeVisible() → 预期
    match = line.match(/^await expect\(page\.(.+)\)\.(toBeVisible|toBeHidden|toHaveText|toContainText|toHaveURL|toHaveValue)\((.*)\);?$/);
    if (!match) {
      // 整页断言：await expect(page).toHaveURL('...') / toHaveTitle
      match = line.match(/^await expect\((?:page|context)\)\.(toBeVisible|toBeHidden|toHaveText|toContainText|toHaveURL|toHaveTitle)\((.*)\);?$/);
      if (match) {
        const kind = match[1]!, argument = trimQuoted(match[2]!);
        expectations.push(kind === 'toHaveURL' ? `页面地址为 ${argument}` : kind === 'toHaveTitle' ? `页面标题为“${argument}”` : `页面${argument}`);
        continue;
      }
    }
    if (match) {
      const kind = match[2]!;
      const description = locatorDescription(match[1]!) || match[1]!.slice(0, 120);
      const argument = trimQuoted(match[3]!.replace(/^['"]|['"],?\s*\{.*\}?$/g, ''));
      const text = kind === 'toBeVisible' ? `页面${description || '元素'}可见`
        : kind === 'toBeHidden' ? `页面${description || '元素'}不可见`
        : kind === 'toHaveURL' ? `页面地址为 ${argument}`
        : `${description || '元素'}${kind === 'toHaveValue' ? '的值为' : '包含文本'}“${argument}”`;
      expectations.push(text);
      continue;
    }
    // 其他可执行行原样保留为步骤，人工修订后使用；不当作预期或丢弃。
    // waitForTimeout 是录制停顿的副产品而非业务步骤；close 收尾行无业务含义。
    if (/^await page\.waitForTimeout\(/.test(line) || line === 'await context.close();' || line === 'await browser.close();') continue;
    if (/^await /.test(line)) {
      steps.push(`（待人工修订）${line.replace(/;$/, '').slice(0, 300)}`);
      issues.push({ sheet: '录制', message: `未识别的操作已原样保留：${line.slice(0, 160)}`, blocking: false });
    }
  }
  return { title: title || sourceName, steps, expectations, issues };
}

// 一条录制 → 一个单用例 TestCase；source.original 保留全部代码行，来源可回查。
export function recordingToTestCase(recordingId: string, name: string, script: string): { cases: TestCase[]; issues: ImportIssue[] } {
  const parsed = parseRecording(script, name);
  if (!parsed.steps.length) parsed.issues.push({ sheet: '录制', message: '录制内容为空或没有可识别的操作', blocking: false });
  const testCase: TestCase = {
    id: randomUUID(), externalId: '', module: '录制', title: parsed.title.slice(0, 200) || name,
    priority: '', preconditions: [], steps: parsed.steps, expectations: parsed.expectations,
    source: { fileName: name, sheet: '录制', rows: [1], original: script.split(/\r?\n/) },
    excluded: false, duplicateAcknowledged: false,
  };
  return { cases: [testCase], issues: parsed.issues };
}
