# CasePilot

基于 Pi SDK 的 Web 自动化测试 Agent：导入 Excel 用例，选择测试环境，由 Agent 操作真实浏览器，生成有证据的执行报告。

**当前状态：M1、导入确认、核心串行批次、登录、反序定位、暂停控制、报告、有限恢复及提交回执丢失已有本机可控样本验证。进程中断、历史恢复、默认保留数据、明确 UI 清理、普通字符图片验证码以及四类对象的受控删除也已专项验证。可信运行时 Skills/本地扩展与真实材料验收仍待后续。Windows 实机按用户要求延后，跨平台支持保留。默认执行开关保持关闭，本机验收配置已开启。完整 P0 尚未完成。**
创建日期：2026-10-30（Asia/Shanghai）。
远程地址：git@github.com:neilweixing/casepilot.git（已配置 origin，尚未推送）。

## P0 工作流

上传 Excel → 预览并确认用例 → 选择测试环境 → 顺序执行 → 页面查看 / 下载 HTML 报告。

P0 个人本机使用；后续再考虑团队使用。桌面 Web、单环境单账号、本机可见浏览器、前置条件自动准备、失败继续，都是本次访谈确认的范围。
最终支持 Windows 与 macOS。当前实际运行验证在 macOS 完成；Windows CI 已配置但未运行，用户已将 Windows 实机验证延后，不将代码兼容处理冒称为 Windows 实测通过。

## 从哪里开始

| 文件 | 用途 |
|---|---|
| [AGENTS.md](AGENTS.md) | Coding Agent 进入项目后先读的协作规则 |
| [P0 需求](docs/p0.md) | 用户已经确认的产品范围与边界 |
| [技术设计](docs/architecture.md) | 模块职责、SDK/MCP 接入、数据与接口草案 |
| [导入阶段验证](docs/m2-verification.md) | Web、导入确认、环境配置与下拉组件的实际检查和限制 |
| [执行阶段验证](docs/m3-verification.md) | 真实批次、登录、测试验证码、执行记录交互与尚未通过的补验 |
| [控制阶段验证](docs/m4-verification.md) | 登录失效、暂停继续停止、页面重连与原生快照脱敏补查 |
| [报告阶段验证](docs/m4-reports-verification.md) | 统一统计、内嵌证据、页面预览、HTML 下载与本地打开确认 |
| [有限恢复验证](docs/m4-recovery-verification.md) | 定位次数/时间上限、提交不确定、原始错误保留和计时器收尾 |
| [中断与清理验证](docs/m4-interruption-verification.md) | 正常关闭/突然退出、历史不重放、残留锁与明确 UI 清理 |
| [图片验证码验证](docs/m3-image-captcha-verification.md) | 普通字符识别、失效刷新、次数上限、不可读停止与凭证保护 |
| [对象删除](docs/tasks/M5-deletion.md) | 系统/环境/用例集/任务的删除入口、引用保护与专属数据清理 |
| [设置页](docs/tasks/M5-settings.md) | 模型提供商与自定义配置、Skills/MCP 状态 |
| [执行规则](docs/execution.md) | 状态、判定、恢复边界和通过率口径 |
| [验收清单](docs/acceptance.md) | P0 必须拿出哪些可复查的证据 |
| [实现计划](docs/plan.md) | 按完整工作流逐步交付的里程碑 |
| [决策记录](docs/decisions.md) | 已确认选择与早期方案的变更 |
| [协作流程](docs/workflow.md) | 先读需求、写任务、实现、验证、更新进度 |
| [参考资料](docs/references.md) | 官方资料、核实日期与仍需实测的假设 |
| [交付核对](docs/verification.md) | 本次骨架检查结果，不代表业务测试通过 |

## 工程结构

~~~text
casepilot/
├── AGENTS.md
├── apps/
│   ├── web/src/             # React 工作台、导入确认与环境配置页面
│   └── server/src/          # M1 服务、Pi/MCP 执行器、证据校验和测试
├── packages/contracts/src/  # 固定用例与结构化执行契约
├── configs/                 # 无真实凭证的配置示例
├── docs/                    # 需求、设计、决策、验收和任务
├── scripts/check-docs.mjs   # 无第三方依赖的文档/配置检查
└── tests/fixtures/          # 用例样本与后续验证数据
~~~

保持三个 workspace 即可，不预建插件市场、分布式调度或通用 Agent 平台。

## 启动工作台

安装依赖：`pnpm install --frozen-lockfile`。复制 `.env.example` 为 `.env`，已有真实配置不要覆盖。
开发模式使用两个相邻端口，默认 Web 为 `http://127.0.0.1:4311`，后端为 `http://127.0.0.1:4310`。前端由 Vite 自动更新，后端由 Node.js watch 自动重载；访问后端首页会转到开发页面。

~~~sh
pnpm dev
~~~

如果当前终端仍运行旧入口，下次重新运行 `pnpm dev` 后热加载才生效。服务第一次启动仍由用户执行；修改后端或 `.env` 可能中断开发任务，不会自动续跑业务步骤。

使用构建后的单端口页面：

~~~sh
pnpm build
pnpm start
~~~

然后访问 `http://127.0.0.1:4310`。Windows 与 macOS 使用相同命令；本次未在 Windows 机器上实际运行。

当前可通过页面导入 `.xlsx`、选择工作表、修正列映射/用例、拆分合并、排除与确认版本、保存系统和环境。任务入口默认关闭；本机验收可通过 `.env` 的 `CASEPILOT_ENABLE_RUNNER=1` 开启，已确认版本和单任务限制仍由服务校验。当前模型的多阶段用例实测超过 5 分钟，本机设置 `CASEPILOT_CASE_TIMEOUT_MS=600000`；原始超时记录保留，不自动重跑。

## M1 固定用例验收

先执行 `pnpm install --frozen-lockfile`。复制 `.env.example` 为 `.env`，填写模型地址、ID 和密钥；已有 `.env` 不要覆盖。
本机需要已安装 Google Chrome。程序使用独立的临时 profile，不下载浏览器。

~~~sh
pnpm dev
~~~

服务由用户启动并保持运行。在另一个终端执行：

~~~sh
pnpm smoke
pnpm smoke --variant=reversed
~~~

正常样本应为 `PASSED`；反序样本应为 `FAILED`，退出码为 2。两者执行同一份用例，反序页面故意将日期输入框放到姓名上方。
执行器还会让模型读取截图里的四位数字，确认图像真实进入请求且能被读取；这不等于真实验证码已经验收。
结果、逐项预期、工具记录、截图和资源释放记录保存在 `data/runs/<runId>/`，不进入 Git。
每次运行最多 30 次工具调用，默认 300 秒（可通过本地配置调整）；不自动重跑整条用例、不重复提交。`Ctrl+C` 终止执行并保留已有证据。

目前只支持 `.env` 中的 OpenAI-compatible `openai-completions` 接口；配置与真实调用不匹配时记 `ERROR`。M1 命令只执行固定的可控用例，不代表通用 Excel 任务执行已经完成。

## 当前可执行的检查

本机核实环境：Node.js 26.12.1、pnpm 12.15.0。Node 最低版本按候选 Pi SDK 的要求设置为 22.19.0。

~~~sh
node scripts/check-docs.mjs
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm mcp:check
pnpm stop:check
~~~

前两条检查同一套文档、JSON 示例与工程结构；`typecheck` 与 `test` 检查实际新增的代码和边界。
`mcp:check` 连接真实 MCP 并核对工具清单，不调用模型或打开浏览器。
`stop:check` 会调用真实模型并打开浏览器，在打开页面后终止，核实结果与子进程释放。它需要已启动的服务和可用模型配置。
`pnpm build` 真实构建 React Web；`pnpm test` 通过 Node 脚本收集测试文件，避免依赖 shell 的通配符展开。
`pnpm reports:check --run-id=<已有任务 ID>` 只检查历史运行的报告与证据，不触发模型或重跑业务；需要用户已启动服务。多份报告可重复传入 `--run-id`。
`pnpm recovery:check --scenario=recover` 使用独立合成用例与真实模型/MCP/Chrome 验证定位恢复；另有 `exhaust`、`time-limit`、`uncertain` 三种故障场景，均持有共享浏览器锁并保留原始失败。该验收不选择用户已有环境或重启服务。
`pnpm lifecycle:check --scenario=graceful` 验证自建执行子进程正常关闭；另有 `crash` 突然退出和 `cleanup` 明确清理场景。它们使用独立合成数据、真实模型与浏览器，持有共享锁；不会终止用户服务。`crash` 只终止本次自建子进程，测试侧按此前记录的进程归属收尾，生产恢复器不会杀死未知进程。
`pnpm captcha:check --scenario=normal` 验证普通字符图片登录；另有 `retry`、`exhaust`、`unreadable`，分别验证失效刷新、持续拒绝上限与无法识别时不猜测。使用独立合成环境和真实模型/浏览器，目标计数只用于验收核对，不代替 UI；不重启用户服务。
`pnpm delete:check` 在临时数据目录与独立端口启动自己的服务与前端，用真实 Chrome 验收四类对象的删除与引用保护；不接触项目 `data/`，也不重启用户服务。

配置说明见 [configs/README.md](configs/README.md)。JSON 示例不会自动加载，不含真实账号、密码或 API key。

## 下一步

M1 实际结果见 [M1 验证记录](docs/m1-verification.md)，导入与批次分别见 [M2](docs/m2-verification.md)、[M3](docs/m3-verification.md)。M4 控制、报告、有限恢复、中断与数据清理，以及普通字符图片验证码已完成本机可控样本验证。下一小阶段接入可信运行时 Skills/本地扩展；Windows 实机延后，真实 xlsx 和系统在开发后由用户提供。
