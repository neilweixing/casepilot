import { mkdirSync, writeFileSync } from 'node:fs';
import { executionWorkbook, fixtureWorkbook } from '../apps/server/src/import-fixtures.ts';
mkdirSync('tests/fixtures/generated', { recursive: true });
for (const kind of ['normal', 'layouts', 'problems']) {
  writeFileSync(`tests/fixtures/generated/${kind}.xlsx`, await fixtureWorkbook(kind));
  console.log(`已生成 tests/fixtures/generated/${kind}.xlsx（合成样本，未连接真实系统）`);
}
writeFileSync('tests/fixtures/generated/m3-execution.xlsx', await executionWorkbook());
writeFileSync('tests/fixtures/generated/m3-position.xlsx', await executionWorkbook(true));
console.log('已生成 M3 可控执行样本（需要人工确认后从页面发起）');
