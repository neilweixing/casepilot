# P0 技术设计

状态：完整 P0 的技术设计。M1、Web/导入/环境、核心批次、控制、报告与有限恢复已有本机可控样本验证，执行开关默认关闭；实际范围见 [实现计划](plan.md) 与各阶段记录，完整 P0 尚未完成。
产品边界以 [P0 需求](p0.md) 为准，外部能力出处见 [参考资料](references.md)。

## 1. 推荐结构

~~~mermaid
flowchart LR
  User[本机用户] --> Web[Web 任务页面]
  Web --> API[CasePilot 服务]
  API --> Import[Excel 导入与确认]
  API --> Runner[串行任务执行器]
  API --> Store[(SQLite / 本机文件)]
  Runner --> Pi[Pi Agent SDK]
  Pi --> MCP[Playwright MCP]
  MCP --> Browser[本机可见浏览器]
  Browser --> Target[选定的测试环境]
  Runner --> Evidence[步骤与证据记录]
  Evidence --> Report[页面 / HTML 报告]
  Report --> Web
~~~

本机一个服务进程负责 HTTP API、串行调度和状态落盘；前端是任务表单与结果页面。
不引入独立消息队列、分布式 worker 或向量数据库。模型请求按配置发往所选服务，不承诺本地模型推理。

## 2. 技术建议与版本状态

| 部分 | 建议 | 当前证据 |
|---|---|---|
| 工程 | TypeScript + pnpm workspace | 已安装 TypeScript 5.9.3，增加真实类型检查与边界测试 |
| Web | React + Vite | React 19.3.1、Vite 8.3.5；基础页面、导入确认与环境配置已做浏览器验证 |
| API | Node.js + Fastify + HTTP/SSE | Fastify 5.6.2 已接系统/环境/导入/任务/报告 API；真实批次、控制及页面刷新重连已验证 |
| 数据 | SQLite 保存结构化数据，本机目录保存文件 | 使用 Node.js 内置 node:sqlite；草稿、确认版本、系统/环境及任务证据已落盘 |
| 执行核心 | Pi coding-agent SDK | 1.4.0 已安装并连接用户配置的真实模型 |
| 浏览器 | 官方 Playwright MCP，本机 headed 模式 | 0.0.83 已安装、核对实际工具并操作本机 Chrome |
| Excel | XLSX 解析 + 语义识别 + 人工确认 | ExcelJS 4.4.0，合成布局及模型映射建议已验证；真实文件待用户提供 |

锁定 Pi 包是 @earendil-works/pi-coding-agent@1.4.0；旧项目 badlogic/pi-mono 当前跳转到 earendil-works/pi。
不要复制旧教程里的 @mariozechner 包名后混用新 API。
M1 已通过 npm 确认 Playwright MCP 0.0.83 有发布包，安装后完成真实握手与工具清单核对，并写入 lockfile。
该包依赖的 Playwright 是锁定的 alpha 版本，已在本机 Chrome 上验证；这不等于所有浏览器环境都已验证。
M1 保留固定用例的命令行验收入口；M3 起通用执行由本机任务服务调度，Web 页面通过 API 创建任务并订阅进度。

## 3. 模块职责

| 模块 | 负责 | 不负责 |
|---|---|---|
| web | 环境/导入确认/任务/报告页面，订阅进度 | 保存凭证明文、计算另一套统计 |
| import | 读取表格结构、生成导入草稿、问题定位、确认版本 | 自动执行表格内容或静默丢弃歧义 |
| environments | 系统与环境配置、凭证引用、登录方式 | 多账号角色切换和团队权限 |
| runs | 串行队列、状态机、预算、暂停停止、持久化 | 让模型直接宣布整批任务完成 |
| agent | Pi SDK、资源加载、受控工具、步骤反馈 | 绕过页面完成 UI 用例 |
| evidence | 工具调用结果、截图、断言证据与来源关联 | 把模型意图当成已执行动作 |
| reports | 服务端状态聚合、指标、HTML 导出 | 覆盖结构化结果或重新猜测通过率 |

实现前不把这些模块分别拆成 npm 包；共享 API 类型与校验再放 packages/contracts。

## 4. Pi SDK 接入边界

- 通过 SDK 直接嵌入服务端，不将 CLI 的交互式终端作为 Web 服务端。
- 给运行环境显式指定 cwd、agentDir、模型、资源与工具。避免自动继承开发者个人全局配置。
- 官方 SDK 的 MCP/Skills 接入方式与 CLI 默认行为不同；M1 按已核实版本注册官方 MCP 扩展并完成生命周期绑定。
- 默认配置只连接明确启用的 MCP 服务；Skills 路径明确指定。用户上传的数据不能追加可执行扩展。
- 实际工具清单需要检查。P0 不默认暴露 shell、任意文件编辑及无约束脚本执行。
- 加载 Skill 正文所需的只读文件能力应限制在配置的 Skill 根目录，不能因此开放整个文件系统。
- 每条用例使用独立的 Agent 上下文，避免上一条的推理和结论污染下一条；浏览器归属当前任务。
- 本地串行任务可以复用已验证登录状态，每条用例仍从明确的起点重新检查前置条件，不隐式依赖上条结果。
- UI 结果只能由服务接受经过校验的结构化 CaseResult，缺步骤或证据时不得接受 PASSED。
- Pi 会话持久化是对话记录，不等于任务崩溃后可安全恢复；P0 不引入实验性的 durable 框架。

SDK 事件用于展示过程。Agent 停止生成文本也不表示用例通过，是否完成需要运行器检查结果与证据。
M1 已实现显式工作目录、独立配置目录、内存凭证/会话、工具白名单和结果证据校验。
当前通过官方扩展的 `loadConfig` 回调提供唯一的 Playwright MCP；不加载个人 MCP 配置、磁盘扩展、Skills 或上下文文件。
配置式可信 Skills 与受限文件读取尚未实现，不能因 M1 使用了 Pi SDK 就声称已经支持这些能力。

## 5. 浏览器控制

本机启动 Playwright MCP，使用可见浏览器；P0 不需要管理页面内的视频流。
页面可访问性结构用于稳定定位，截图用于视觉判断与证据。字段位置等检查需要实际检查元素位置/截图，不能把结构顺序直接当成视觉顺序。
截图发往模型时要确认模型支持图像输入，不能把描述截图的文本当成图像本身。
建议先使用独立测试 profile，避免操作用户日常浏览器。每个任务独占该 profile，不跨任务混用登录。
MCP 的 isolated profile 不构成系统权限沙箱，stdio 进程仍继承宿主权限。
控制网页中必要的 evaluate 能力时，明确只允许页面观察/断言所需范围；不能借此执行任意业务脚本替代 UI 步骤。
Playwright MCP 可以采集截图；用例、步骤、预期与证据的关联以及 HTML 报告需要 CasePilot 自己实现。
首次启动需核实浏览器已安装；服务不要未经说明下载浏览器或替换用户默认浏览器。

## 6. 数据与本机文件布局

建议的数据对象：

| 对象 | 核心字段 |
|---|---|
| System | id、name |
| Environment | id、systemId、name、baseURL、loginURL、username、credentialRef、captchaStrategy |
| ImportDraft | id、sourceFile、sheets、mapping、cases、issues、revision、confirmedAt |
| TestCase | id、externalId、module、title、priority、preconditions、steps、expectations、source |
| Run | id、confirmedRevision、environmentSnapshot、modelSnapshot、status、selectedCaseIds、timestamps |
| CaseResult | id、runId、caseId、status、phase、actualResults、reason、evidenceIds、timestamps |
| Evidence | id、runId、caseId、stepId/expectationId、kind、path、timestamp、redactionState |

账号密码不放入可导出的 environmentSnapshot；导出只放环境名称与必要的非敏感地址。
steps 与 expectations 是独立列表，通过关联 ID 表达对应关系，不要求数量相同。
环境密码使用服务端 credentialRef 关联本地受限存储，不把 Base64 称为加密。
当前环境密码/测试码使用 AES-256-GCM，单独密钥文件位于受限 `data/credentials/`；macOS 使用目录权限，Windows 实现使用系统 ACL，后者尚待真机验证。目录与数据库备份应一起按本地秘密处理，不能将加密描述成防护已登录本机用户。

~~~text
data/
  casepilot.sqlite
  credentials/          # 本地秘密，不能打包进报告
  imports/<importId>/   # 原文件、解析草稿与确认版本
  runs/<runId>/         # 事件、证据、报告
  agent/                # 独立的 Pi 配置与资源
~~~

data/ 整体被 Git 忽略，初始化时设置适当的本机访问权限。
模型 API key 通过环境变量或受限本地配置加载；不下发给 Web 页面。
报告、截图和导出均需处理敏感内容，不以“本机运行”为由直接输出密码。

## 7. API 与事件草案

系统、环境、导入/修订/确认和扩展状态接口已实现。任务执行、控制、SSE 与报告已有首版代码，但创建任务默认关闭，不能把接口存在当成业务验收通过。
同时保留 `GET /health`、`GET /m1/form` 与开发验收用 `/demo` 页面。

| 方法 / 路径 | 用途 |
|---|---|
| GET/POST /api/systems | 查询/创建被测系统 |
| GET/POST /api/environments | 查询/创建环境 |
| PATCH /api/environments/:id | 修改环境和凭证 |
| POST /api/imports | 上传 Excel 并创建识别草稿 |
| GET/PATCH /api/imports/:id | 预览/修正草稿 |
| POST /api/imports/:id/confirm | 确认不可变的执行版本 |
| GET/POST /api/runs | 查询/创建测试任务 |
| GET /api/runs/:id | 任务详情与统计 |
| POST /api/runs/:id/pause | 请求在可控边界暂停 |
| POST /api/runs/:id/resume | 检查后继续 |
| POST /api/runs/:id/stop | 停止并保留已有结果 |
| GET /api/runs/:id/events | SSE 推送进度，带单调递增序号 |
| GET /api/runs/:id/report.html | 下载自包含 HTML |
| GET /api/extensions | 已启用 MCP/Skills 与连接状态 |

SSE 是 CasePilot 给浏览器页面推送进度的方式，不是 Pi MCP 连接的 transport。
Pi MCP 配置使用 stdio 或 Streamable HTTP，不使用旧 MCP SSE transport。
运行任务只接受确认版本的 ID；服务端检查 revision 和确认状态，不能只靠页面禁用按钮。
事件断线可按序号补读，页面重连不能重新触发执行。数据文件路径不能直接由用户拼成任意文件读取地址。

## 8. 页面建议

环境列表/编辑、Excel 导入确认、任务列表、执行详情、报告详情。
执行详情展示当前用例、当前步骤、实际工具结果摘要、恢复次数和截图链接，不要求公开模型内部推理。
按钮状态与服务端状态机一致；保留暂停、继续、停止，不在 P0 增加聊天窗口。
视觉方向依用户要求参考已登录的 claude.ai：白色内容、浅灰侧栏、细边框与轻圆角。所有选择控件使用统一的 Radix Select 自绘浮层，并保留键盘、焦点和选中语义。
