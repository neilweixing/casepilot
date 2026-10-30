import ExcelJS from 'exceljs';

export async function fixtureWorkbook(kind: 'normal' | 'layouts' | 'problems' = 'normal') {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('表单用例');
  sheet.addRow(['CasePilot 可控样本；仅作开发验证']);
  sheet.addRow(['优先级', '预期结果', '用例名称', '操作步骤', '用例编号', '模块', '前提条件']);
  sheet.addRow(['P1', '页面显示“已提交：测试用户 / 2026-11-01”\n预计启动日期输入框位于姓名输入框下方', '提交表单并检查字段位置', '打开测试环境页面\n姓名填写“测试用户”，预计启动日期填写“2026-11-01”\n点击一次“提交”', 'TC-001', '表单', '']);
  if (kind === 'layouts') {
    const merged = book.addWorksheet('合并跨行');
    merged.addRow(['用例编号', '用例标题', '操作步骤', '预期结果']);
    merged.addRow(['TC-M', '跨行用例', '打开页面', '页面打开']);
    merged.addRow(['', '', '填写名称', '名称正确']);
    merged.mergeCells('A2:A3'); merged.mergeCells('B2:B3');
    const one = book.addWorksheet('单行'); one.addRow(['title', 'steps', 'expectations']); one.addRow(['单行用例', '检查页面', '页面可见']);
  }
  if (kind === 'problems') {
    sheet.addRow(['P2', '', '', '点击保存', 'TC-001', '问题用例', '']);
    sheet.addRow(['P2', '值可见', '无缓存公式', { formula: '1+1' }, 'TC-003', '公式', '']);
    sheet.addRow(['P2', '值可见', '有缓存公式', { formula: '1+1', result: 2 }, 'TC-004', '公式', '']);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function executionWorkbook(single = false) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('M3 可控执行');
  sheet.addRow(['用例编号', '用例标题', '前置条件', '操作步骤', '预期结果']);
  const steps = '打开选定测试环境的表单页面\n填写姓名为“测试用户”，预计启动日期为“2026-11-01”\n点击一次“提交”按钮';
  sheet.addRow(['M3-001', '准备数据并提交表单', '通过页面确认“测试数据已准备”；若尚未准备，点击“准备测试数据”完成准备', steps, '页面显示“已提交：测试用户 / 2026-11-01”\n预计启动日期输入框位于姓名输入框下方']);
  if (!single) {
    sheet.addRow(['M3-002', '管理员前置无法满足', '当前账号拥有管理员权限；若页面明确显示没有管理员权限，不修改账号权限，记录前置条件无法满足', '点击提交按钮', '页面显示提交结果']);
    sheet.addRow(['M3-003', '明确失败仍有证据', '', steps, '提交结果文字为“已提交：另一个用户 / 2030-01-01”']);
    sheet.addRow(['M3-004', '前条失败后继续', '', '打开选定测试环境的表单页面', '页面中可见“可控表单”标题']);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function controlWorkbook(scenario: 'pause' | 'expired') {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('M4 控制验收');
  sheet.addRow(['用例编号', '用例标题', '前置条件', '操作步骤', '预期结果']);
  const steps = '打开选定测试环境的表单页面\n填写姓名为“测试用户”，预计启动日期为“2026-11-01”\n点击一次“提交”按钮';
  sheet.addRow(['M4-001', scenario === 'pause' ? '暂停后保持一次提交' : '普通表单提交', scenario === 'pause' ? '页面已显示“可控表单”标题' : '', steps,
    '页面显示“已提交：测试用户 / 2026-11-01”' + (scenario === 'pause' ? '\n页面显示“本窗口提交次数：1”' : '')]);
  sheet.addRow(['M4-002', scenario === 'pause' ? '停止时保留已有结果' : '故障恢复后继续下一条', '', '打开选定测试环境的表单页面', '页面中可见“可控表单”标题']);
  if (scenario === 'pause') sheet.addRow(['M4-003', '停止后不应开始', '', '打开选定测试环境的表单页面', '页面中可见“可控表单”标题']);
  return Buffer.from(await book.xlsx.writeBuffer());
}
