# 验证样本目录

[规范化用例样本](import/normalized-case.example.json) 是根据用户模板中的“字段排列顺序”场景整理的脱敏示例。
它用于解释字段契约，不代表 Excel 已解析成功，也不是实际测试报告。
期望页面行为需要目标系统确认，当前只表达“检查页面正常”和“检查字段相对顺序”。

M1 可控页面已经放在 `apps/server/src/fixture.ts`，覆盖正常与字段反序；实际执行记录见 [M1 验证记录](../../docs/m1-verification.md)。后续增加多个 Excel 排布样本及阻塞、异常等场景。
M2 的 `generated/normal.xlsx`、`layouts.xlsx`、`problems.xlsx` 是合成工作簿，可用 `node scripts/create-fixtures.mjs` 重新生成。它们覆盖别名/说明行、合并跨行、多 sheet、重复与公式问题，不代表用户真实工作簿已通过。
用户真实工作簿及执行产物不直接提交到此目录，除非已得到授权并完成脱敏。
