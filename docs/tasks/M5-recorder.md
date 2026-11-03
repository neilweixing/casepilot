# 任务：基于 Playwright 的脚本录制（转用例，Agent 执行）

状态：已完成（本机真实录制实测）
对应里程碑：M4 补充
对应验收：B09（docs/acceptance.md）

## 问题与预期行为

用户希望降低用例编写门槛：人工在真实浏览器中操作一遍，生成可修订的用例草稿，再由现有 Agent 体系执行。录制不是第二套执行引擎（人工点击回放路线被否决，见 D29/D30），而是用例的另一个入口。

## 本次范围

- codegen 子进程管理：`node playwright/cli.js codegen --target=javascript --channel chrome -o data/recordings/<id>/script.js [startURL]`，系统 Chrome，不下载浏览器。
- 浏览器互斥：`recorder.lock`；录制中拒绝创建任务、任务/锁占用时拒绝开始录制，双向 409。
- 脚本解析：基本操作（goto/click/fill/press/check/selectOption）转自然语言步骤；`expect(...)` 断言转预期结果；选择器提示保留在步骤文本中；`waitForTimeout` 与 close 收尾行跳过；无法识别的行原样保留为步骤并登记非阻塞 issue。
- 转用例：一条录制 → 一个单用例 ImportDraft，走与 Excel 导入相同的修订、归属系统门禁与确认流程。
- 放弃语义：以脚本是否实际落盘为准（codegen 有定时保存，放弃也可能落盘），不伪造"未生成"。

暂不涉及：录制产物回放执行、帧/对话框/下载/悬停等复杂操作的语义化解析（保留原文人工修订）、录制中暂停续录、多录制并行。

## 输入与依赖

- `playwright@1.64.0-alpha-1790635538000` 固定加入 apps/server 依赖（随 @playwright/mcp 已在 lockfile）。
- 技术冒烟已验证：codegen 用系统 Chrome 可用；被 SIGKILL 时脚本仍落盘；生成代码为标准 JS。
- 复用：mcp.ts 的 processExists/descendantPids；imports.ts 的修订与确认门禁；runs.ts 的锁语义。

## 实现步骤

1. 契约 `Recording`；服务端 recorder.ts（spawn/锁/恢复/abort）与 recording-parser.ts。
2. API 路由（开始/列表/脚本/转换/放弃/删除）+ RunManager 双向互斥 + deletion。
3. 测试：解析、空脚本、互斥、恢复、convert 门禁、abort 语义。
4. 前端录制页：开始区、录制中状态、记录列表、脚本预览、转用例跳转。
5. 文档：D30、B09、plan。

## 验证与完成条件

- `pnpm typecheck`、`pnpm test`（82 项）、`pnpm check`、`pnpm build` 通过。
- 页面实测：真实录制 → 查看脚本 → 转用例 → ImportEditor 修订确认 → 现有执行链路跑一次。

## 完成记录

- 2026-11-03：实现与检查完成；`pnpm typecheck`、`pnpm test`（82 通过）、`pnpm check`、`pnpm build` 通过。
- 2026-11-03 页面实测（真实 codegen + 系统 Chrome + 用户人工操作）：
  - 页面发起录制 → Chrome 打开 demo 表单页 → 用户实际操作（导航、两次输入、按键、两次点击提交）→ 关闭窗口 → COMPLETED，脚本落盘。
  - 转用例草稿：10 步全部解析为自然语言（点击「姓名」textbox 等，保留原始选择器作定位提示）；无断言时预期为空，门禁正确拦截"标题、步骤与预期必须完整"。
  - ImportEditor 修订：补编号/标题/预期、创建新系统"演示站点"并归属（v1→v3）→ 确认成功 → 用例库按"演示站点"分组展示录制产物。
  - 互斥实测：录制进行中第二次录制 409；录制结束锁释放后可再次录制。
- 实测中发现并修复：录制结束未删除 recorder.lock 导致后续录制/任务被误拦（finish 现在按锁内容精确释放）；fill 值含 `\'` 转义时被截断（unquoteSingle 还原）；测试 3 依赖 pid=1 的 EPERM 语义（processExists 将 EPERM 视为存活）。
- 已知限制：录制起始地址 404 时不提示（如实打开报错页）；`waitForTimeout`/close 等非业务行跳过；双击/悬停/拖拽/对话框/下载/iframe 未语义化解析，原样保留待人工修订；`context` 上的操作与 `expect` 回调形式未覆盖。
- 待验收：确认后的录制用例经真实 Agent 执行链路跑一次（需开启 CASEPILOT_ENABLE_RUNNER=1，本次未执行以免占用浏览器）；真实目标系统材料仍按 M5 延后。
