# 第九步 B：CitationResolver 与 CitationSnapshot

## Task 1：RED

- [x] 1.1 古籍替代必填组、现代论文/学位/在线文献 required fields 与 provenance 回归先失败。
- [x] 1.2 snapshot 幂等、metadata/style/template stale、corrupt 和 cursor 回归先失败。
- [x] 1.3 目标类型缺模板不得任意 fallback；旧字符串 API 保持兼容。

## Task 2：GREEN

- [x] 2.1 建 versioned required/recommended registry 与统一 resolution DTO。
- [x] 2.2 additive 保存 immutable CitationSnapshot，main-only 构造并验证版本/hash。
- [x] 2.3 接入 citation IPC/preload，为后续批量/导出暴露 snapshot ID。
- [x] 2.4 修复缺年份使用当前年和任意模板 fallback。

## Task 3：文档与门禁

- [x] 3.1 更新模块 10/11/14、README、台账和脚本说明。
- [x] 3.2 纳入最终完整 check/build/smoke/diff/open-source。

## 边界

- 古籍和现代论文共享 resolver，但 required groups 按 citation type 区分。
- snapshot 保存字段来源与诊断，不把清理后的字符串当唯一事实。
- 不新增样式库、解析库或外部服务。
