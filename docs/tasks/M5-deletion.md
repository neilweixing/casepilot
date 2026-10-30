# 任务：主体对象的受控删除

状态：已完成（本机孤立数据目录 + 真实 Chrome 页面验证）
对应里程碑：M4 补充（属于 P0 日常可用性）
对应验收：新增 A07（删除与引用保护）

## 问题与预期行为

当前 System、Environment、Import（用例集）、Run（测试任务）四类对象只有创建与修改，没有任何删除入口。
验收过程反复产生合成系统、环境、用例集与任务，只能靠手工改 SQLite 才能清理，用户无法自行整理数据。

本次完成后：页面上的四类对象都有明确的删除入口；点击后需要二次确认；存在引用关系时服务端拒绝删除并说明被谁引用；删除只影响该对象自身及其专属数据，不破坏历史报告。

## 本次范围

实现：
- 四类对象的 `DELETE /api/...` 端点与前端删除入口。
- 引用保护：有引用一律拒绝，不级联、不软删除。

明确不做：
- 不做软删除/归档、不做批量删除、不做回收站与撤销。
- 不清理被历史任务共享的凭证文件（历史证据脱敏仍需读取）。
- 不改表结构、不加迁移。

## 引用规则（本次确认）

| 对象 | 被谁引用 | 处理 |
|---|---|---|
| System | Environment.systemId | 其下仍有环境则拒绝 |
| Environment | Run.environment.id（快照） | 有历史任务则拒绝 |
| Import | Run.importId | 有历史任务则拒绝；无引用时连同 import-version 与原始 xlsx 一起删 |
| Run | 无 | 运行中（QUEUED/RUNNING/PAUSING/PAUSED/STOPPING）拒绝；终态任务连同 run-private 与 data/runs/<runId>/ 一起删 |

凭证文件只在确认没有其它环境或任务私有记录仍引用同一 `credentialRef` 时才删除。

## 输入与依赖

- `apps/server/src/storage.ts` 目前只有 `put/get/list`，需要补删除原语。
- `run.environment` 与 `run.cases` 是创建时的 `structuredClone` 快照，历史报告不依赖 Environment/Import 记录本身。
- 实测数据：12 个环境中 10 个的 `credentialRef` 同时被 run-private 共享，因此删环境不能顺手删凭证。

## 实现步骤

1. `storage.ts` 增加 `remove(kind, id)`、`count(kind, predicate)`，以及凭证引用检查。
2. 新建 `apps/server/src/deletion.ts`，集中实现四类对象的引用检查与删除，返回可读的中文拒绝原因。
3. `api.ts` 注册四个 DELETE 端点；沿用既有 `x-casepilot-request` 与同源校验。
4. 前端补充删除入口与确认交互，保持既有视觉体系（暖白、细边框、克制的陶土色）。
5. 补边界测试：有引用拒绝、无引用成功、运行中拒绝、共享凭证不被误删。
6. 实跑 `pnpm check`、`pnpm typecheck`、`pnpm test`、`pnpm build`。
7. 更新 `docs/plan.md`、`docs/acceptance.md`、README 状态。

## 验证与完成条件

- 单元测试覆盖拒绝与成功两条路径，并核对凭证文件与证据目录的实际存在性。
- 页面实际操作：删除无引用对象成功；删除有引用对象显示服务端拒绝原因。
- 历史任务的报告在删除环境/用例集后仍可打开（快照不依赖源记录）。
- 不把 mock 或单测当作真实浏览器验收；页面操作需另附证据。

## 完成记录

实现（2026-10-30）：
- `storage.ts` 增加 `remove`、`has`、`removeSecret`。
- 新增 `deletion.ts`：四类对象的引用检查与受控删除。凭证只在最后一个持有者删除时才移除；证据目录经 `realpathSync` 校验，拒绝越界。
- `api.ts` 注册 `DELETE /api/systems|environments|imports|runs/:id`，沿用既有同源与 `x-casepilot-request` 校验（非 GET/HEAD 均覆盖）。
- 前端新增 `DeleteButton` 就地二次确认，接入系统区块、环境卡片、用例库表格、任务表格；活动任务的删除按钮禁用。

实际检查：
- `pnpm check`：通过（35 个 Markdown、11 个 JSON、90 个本地链接）。
- `pnpm typecheck`：通过。
- `pnpm test`：68 passed / 0 failed（新增 6 项删除边界测试）。
- `pnpm build`：真实构建通过。
- `node scripts/delete-check.mjs`：7/7 通过，使用**临时数据目录与独立端口 4399/4400**，不接触项目 `data/`；截图见 `artifacts/delete-check/`。

已知限制：
- `8f4b0487` 与 `06653c26` 的真实记录在执行本验收时被脚本误删（脚本选行逻辑写错，非产品缺陷）。用户确认均为测试数据，不再恢复。教训：涉及删除的真实库验收必须使用隔离数据目录，脚本已改为临时目录启动独立服务。
- 不支持批量删除、回收站或撤销。
- Windows 上的 `rmSync` 与 ACL 行为未实机验证。
