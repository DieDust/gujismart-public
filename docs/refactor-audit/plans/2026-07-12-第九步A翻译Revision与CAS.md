# 第九步 A：翻译 revision、context snapshot 与 CAS

## Task 1：RED

- [x] 1.1 context hash 覆盖 canonical source、unit source、provider/model/mode/style/glossary 与算法版本。
- [x] 1.2 provider/edit 和 provider/source-change 并发回归先失败；迟到结果不得覆盖。
- [x] 1.3 manual expected revision、detached candidate、revision cursor 和重启先失败。

## Task 2：GREEN

- [x] 2.1 additive 建 context snapshots、unit revisions 和 attempts。
- [x] 2.2 翻译调用开始冻结 context/base revision，提交使用 source/context/manual CAS。
- [x] 2.3 人工编辑创建 active manual revision；旧 projection 保留兼容。
- [x] 2.4 shared/preload/main 暴露 revision identity 与有界历史读取。

## Task 3：门禁与文档

- [x] 3.1 更新模块 10/11/14、README、台账和脚本说明。
- [x] 3.2 专项与完整 check/build/smoke/diff/open-source。
- [x] 3.3 保持本地，不 commit/push/PR/tag/Release。

## 边界

- `page_translation_units` 继续作为旧读取投影，新版权威历史在 revision/context/attempt 表。
- 机器迟到结果保留为 detached candidate，人工译文和当前 source 永不被静默覆盖。
- 本步不新增 provider、模型、依赖或外部服务。
