# 共享契约

M1 的固定用例、逐项预期、证据和结果类型已放在 `smoke.ts`。整条结果由后端校验每项证据后计算，模型不能直接指定 PASSED。

后续加入 ImportDraft、TestCase、EnvironmentSummary、Run 等完整 P0 对象与事件载荷。
只放前后端共用的定义及必要校验，不导出密码、API key、数据库实例或 Pi 会话对象。

当前字段草案见 [技术设计](../../../docs/architecture.md)。
