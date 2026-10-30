# 参考资料与核实边界

核实日期：2026-10-30（Asia/Shanghai）。
以下是官方外部资料，不是本工程的执行日志。文档链接内容可能随版本变化，实施时以锁定版本为准。

| 来源 | 本次使用的事实或原则 | 边界 |
|---|---|---|
| [Pi 官方仓库](https://github.com/earendil-works/pi) | 原 badlogic/pi-mono 当前重定向到这里 | 不是运行结果 |
| [Pi 1.4.0 包元数据](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/package.json) | 当前候选包名、版本、Node 最低要求 | 未进行 npm 安装 |
| [Pi SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md) | 服务内嵌 SDK、会话与事件 | 会话保存不等于任务安全续跑 |
| [SDK MCP 示例](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts) | SDK 显式注册官方扩展并绑定生命周期 | 不能假设 CLI 默认能力全部自动存在 |
| [Pi MCP 配置](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/mcp.md) | 本地 mcp.json、stdio / Streamable HTTP、环境变量 | 不支持旧 MCP SSE transport |
| [Pi 模型配置](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md) | 兼容端点、baseUrl、模型与凭证配置 | 实际工具/图像支持仍需实测 |
| [Pi 模型字段](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md) | apiKey、协议、模型输入能力的字段 | 示例配置不是已经连通的服务 |
| [Pi Skills](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md) | Skills 资源发现与配置 | Skills 不提供系统权限隔离 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 可访问性操作、截图、可见浏览器、profile | 报告与证据关联由本工程实现 |
| [Playwright MCP 包元数据](https://github.com/microsoft/playwright-mcp/blob/main/package.json) | main 写 0.0.83 | M1 另用 npm 查询确认发布，安装并核对实际工具；示例仍不启用 |
| [Playwright MCP 许可证](https://github.com/microsoft/playwright-mcp/blob/main/LICENSE) | Apache-2.0，工具本身无本机订阅/调用收费 | 模型服务仍可能按用量计费 |
| [SheetJS 合并单元格](https://docs.sheetjs.com/docs/csf/features/merges/) | 读取合并范围与业务语义归组是两件事 | 尚未选择或安装该库 |
| [SheetJS 公式](https://docs.sheetjs.com/docs/csf/features/formulae/) | 读取公式不能视为已经计算其结果 | 输入仍需校验与确认 |
| [ExcelJS](https://github.com/exceljs/exceljs) | M2 最终选择 ExcelJS 4.4.0 读取单元格、合并与缓存值 | 合成样本已验证，用户真实文件尚未验证；不执行公式 |
| [Node.js SQLite](https://nodejs.org/api/sqlite.html) | 使用内置 node:sqlite 保存结构化数据 | Windows 运行仍待验证，不以 macOS 检查代替 |
| [Radix Select](https://www.radix-ui.com/primitives/docs/components/select) | 统一选择控件与键盘/焦点语义 | 使用已安装 2.4.1；页面交互实际验证见当前阶段记录 |
| [reCAPTCHA 测试说明](https://developers.google.com/recaptcha/docs/faq#id-like-to-run-automated-tests-with-recaptcha-what-should-i-do) | 第三方挑战可有测试模式 | 不承诺稳定解开真实挑战 |
| [Turnstile 测试说明](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) | 提供测试 key 模拟验证结果 | 依赖被测系统允许测试配置 |
| [AGENTS.md](https://agents.md/) | 给 Coding Agent 提供明确上下文和检查入口 | 本工程具体规则自行制定 |
| [AI 编码协作建议](https://code.claude.com/docs/en/best-practices) | 提供项目约束与可执行检查 | 不要求使用该产品或照搬其工具设置 |

## 仍需核实

- 用户当前模型的工具/图像、MCP 0.0.83 的安装/工具和本机 Chrome 已通过 M1 实测，详见 [M1 验证记录](m1-verification.md)。其他模型与平台仍需验证。
- SDK Skill 读取和完整本地 MCP 配置接入尚未实现；M1 全部禁用 Skills，只使用受控内联扩展。
- 真实 Excel 的归组规则、真实系统的登录与验证码、UI 预期判定的可靠性。
- runtime.example.json 是本工程设计，不是第三方 SDK 的标准配置格式。

M1 已有真实模型与可控页面浏览器验证，尚无用户目标系统验证；官方文档、契约检查、可控页面和真实目标系统证据必须分别说明。
