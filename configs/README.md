# 配置示例

这些 JSON 文件是完整 P0 的文档示例，**M1 不自动加载它们**。
真实配置写入被忽略的本地文件或 data/agent 目录，不提交账号密码。

| 文件 | 归属与作用 |
|---|---|
| [runtime.example.json](runtime.example.json) | CasePilot 自有配置草案，不是 Pi 的原生格式 |
| [pi-models.example.json](pi-models.example.json) | Pi models.json 的兼容接口配置示例 |
| [pi-mcp.example.json](pi-mcp.example.json) | Pi mcp.json 示例，默认禁用浏览器服务 |
| [环境变量](../.env.example) | 本地模型与服务配置的占位变量 |

M1 的 `dev`、`smoke`、`stop:check` 从根目录 `.env` 加载配置，已有环境变量优先。先填写 `CASEPILOT_BASE_URL`、`CASEPILOT_MODEL_ID`、`CASEPILOT_API_KEY`，真实文件不进入 Git。
服务绑定 `127.0.0.1`，默认端口 4310；`CASEPILOT_DATA_DIR` 相对项目根目录解析，默认 `data/`。服务启动由用户执行。
M1 固定使用 `openai-completions`，不会自动探测或切换其他协议。
Web 当前也沿用此模型配置。`pnpm dev` 是 Vite + Node watch 开发模式，默认 Web 4311、后端 4310；`pnpm start` 在构建后启动单端口服务。热加载在用户启用新入口后生效。
通用执行的定位恢复使用 `.env`：`CASEPILOT_STEP_RECOVERY_ATTEMPTS` 默认 2（允许 0–5），`CASEPILOT_STEP_RECOVERY_TIMEOUT_MS` 默认 120000（允许 1000–300000）。每个准备阶段、操作步骤与独立预期分别计数，时间仅累计定位恢复中的活动时间；显式暂停不计入，重新取快照不重置预算。JSON 示例仍不自动加载。
普通图片验证码使用 `CASEPILOT_CAPTCHA_ATTEMPTS`，默认 3（允许 1–5），每次认证最多识别/提交 N 次、刷新 N−1 次。只截取验证码 img/canvas，图像实际发给模型后才允许填写和提交；明确验证码失败后才能刷新重试，未知结果不重复提交。不能识别或达到上限时暂停整批。该预算不会放宽业务操作的恢复或重放规则。
`pnpm recovery:check --scenario=recover|exhaust|time-limit|uncertain` 使用独立合成输入和真实模型/MCP/Chrome；只在开发目标创建计数记录，不选择用户已有环境。故障注入在该验收命令的宿主代码中，生产 API 没有注入开关；命令持有与其他执行器相同的浏览器锁。服务仍由用户启动。
导入/环境数据存入 `data/casepilot.sqlite`，原文件保留在 `data/imports/`；环境密码/测试码通过 AES-256-GCM 存在受限的 `data/credentials/`，不放入示例配置或页面响应。
模型名称必须填写真实模型 ID；apiKey、baseURL 两项不足以唯一确定模型。
示例中的 replace-with-your-model-id 是待替换文本，不是自动插值。

Pi 使用 baseUrl（小写 l），CasePilot 的 API 与界面可以叫 baseURL，但必须明确转换。
模型协议先验证 openai-completions，需要其他协议时明确增加适配，不自动猜测切换。
工具调用必须实测；图片验证码或视觉检查需要模型图像输入或明确配置的识别能力。

已从 npm 确认并安装 Pi `1.4.0`、Playwright MCP `0.0.83`，精确版本见 `apps/server/package.json` 与根 lockfile。
M1 通过官方 MCP 扩展的 `loadConfig` 回调提供唯一的 Playwright 服务，并直接启动已安装的本地 CLI，不依赖运行时 npx 下载或参数插值。
JSON 示例继续保持 `enabled=false`；修改示例不会改变 M1 工具权限或额外启用服务。
Playwright MCP 默认有界面；示例的 isolated 是浏览器 profile 隔离，不是系统权限沙箱。
M1 每次运行使用 `data/agent/<runId>/` 下的独立工作目录和配置目录，禁用全部 Skills、磁盘扩展、提示模板、上下文文件与个人全局配置。后续 P0 再实现明确配置的可信 Skill 路径与受限读取。
M1 不向模型暴露 shell、文件工具和任意脚本工具；固定观察与截图通过内部嵌套调用执行，脚本正文和截图参数均由服务校验。
