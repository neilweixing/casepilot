# 服务与执行器

`main.ts` 启动 Fastify 可控页面服务；`smoke-cli.ts` 在独立命令行进程内嵌 Pi SDK 执行固定用例。
当前 `api.ts` 已接系统、环境、导入和确认；`storage.ts` 使用 SQLite 与受限加密凭证目录。导入模块只读取数据，不执行工作簿内容。
`runs.ts`、`case-agent.ts`、`reports.ts` 已做核心批次、控制、报告、有限恢复、提交回执丢失、中断、历史恢复与明确 UI 清理的本机可控样本验证，范围见根目录 `docs/plan.md`。`lifecycle-cli.ts` 用独立执行子进程验收正常关闭、突然退出和清理，不重启用户服务。`captcha-safety.ts` 与受控 `captcha` 工具完成普通字符图片验证码、有限认证重试与凭证截图保护，真实场景由 `captcha-cli.ts` 验收。可信运行时 Skills/本地扩展和真实材料仍待后续；默认不开放创建任务，不能因代码存在宣称完整 P0 已完成。

`smoke.ts` 管理 SDK 会话、模型、MCP 生命周期；`tool-policy.ts` 限制工具与提交次数；`observe.ts` 校验真实页面观察；`evidence.ts` 落盘并确定结果。
执行规则与结果类型位于 `packages/contracts/src/smoke.ts`。不要将模型的最终文本当作执行结果。

服务负责状态、超时、确认、凭证、结果验证和报告。
Pi SDK 负责模型与工具循环；Playwright MCP 负责浏览器操作。不得把模型的最终文本当成执行凭据。

参见 [技术设计](../../../docs/architecture.md) 与 [执行规则](../../../docs/execution.md)。
