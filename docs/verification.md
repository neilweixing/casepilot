# M0 骨架交付核对（历史记录）

以下保留 M0 当时的结果，不代表当前工程仍无业务代码。M1 的实际版本、检查和浏览器证据见 [M1 验证记录](m1-verification.md)。

交付日期：2026-10-30（Asia/Shanghai）
交付范围：文档、workspace 元数据、预留目录、无真实凭证的示例配置、文档检查脚本。
业务实现：未开始。

## 检查范围

- 项目入口、Agent 规则、P0、设计、执行、验收、计划、决策与参考文档。
- Markdown 的本地文件链接与图片目标。
- JSON 配置/工作区元数据/示例用例的语法。
- 工作区名称、无假运行命令、MCP 示例默认禁用。
- 原始模板截图是否在项目内部可访问。
- 文档中的通过率示例是否一致。
- 根 Git 忽略规则覆盖数据、凭证与执行产物。

## 实际结果

暂存目录已完成以下检查；目标目录的检查结果将在创建后追加。

| 检查 | 实际结果 |
|---|---|
| node scripts/check-docs.mjs | 退出码 0；18 个 Markdown、9 个 JSON、32 个本地链接通过 |
| pnpm install --lockfile-only --offline --ignore-scripts | 退出码 0；仅为 4 个无依赖 workspace 生成锁文件，没有安装运行依赖 |
| pnpm check | 退出码 0；文档与骨架检查通过 |

已将用户提供的模板截图复制到 docs/assets/excel-template.png，不依赖系统临时文件继续存在。

## 未进行

- 未安装 React、Fastify、Pi SDK、Playwright MCP 或浏览器。
- 未启动/重启任何服务。
- 未接入真实模型或被测系统。
- 未运行应用 build、typecheck、业务测试或浏览器 E2E。
- 未创建提交、推送远程或部署。

## 目标目录核对

目标目录：/Users/nieweixing/Code/casepilot

- 写入前确认目标不存在，未覆盖其他工程。
- 复制完成后逐文件 SHA-256 校验一致。
- Git 初始化为 main 分支，尚无提交；origin 已设置为 git@github.com:neilweixing/casepilot.git，未推送。
- 在目标目录运行 pnpm check，退出码 0；18 个 Markdown、9 个 JSON、32 个本地链接通过。
- Git 忽略规则已验证：真实 .env、本地配置、data 与 artifacts 被忽略，示例配置和模板截图未被忽略。
- 这些结果只证明文档、示例与工程结构有效，不证明任何业务能力已经实现。
