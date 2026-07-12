# GujiSmart 全面重构实施总 TODO

更新时间：2026-07-12
范围：当前活跃仓库根目录。旧的历史目录不属于实施事实来源。

## 使用规则

- `[x]` 表示已经有代码、回归和文档证据；`[~]` 表示已有部分基础但成品链路未完成；`[ ]` 表示尚未实现。
- 所有新增依赖、模型、watcher、向量库、云服务、数据库业务表都必须先单独审批；本表默认使用现有 React/Electron/SQLite/Node 能力。
- 旧数据库优先兼容，必要结构只做 additive；每个迁移必须有旧库、重复执行、故障注入、回滚和恢复测试。
- 古籍/扫描史料与现代 PDF/论文共用数据、任务、定位、选择和撤销合同，只通过 preset 改默认布局与工具。
- 总文献数不设产品硬上限；renderer DOM、IPC、活动请求、缓存、并发和单批 payload 必须有界。
- 用户本地测试通过并明确批准公开前，不 push、PR、GitHub Actions、tag 或 Release。

## 已完成基线

- [x] 文件 capability、托管路径、外部目录、导入选择和安全边界。
- [x] CredentialVault、protected settings、ErrorEnvelope、TaskStateEnvelope。
- [x] 统一持久 scheduler、lease/attempt/cursor、OCR/import 兼容桥。
- [x] canonical page content、OCR artifact、人工校对保护和 StableReaderLocator。
- [x] Search generation/Snapshot/EvidenceResolver、ResearchEvidence、aggregate、record/output/claim lineage。
- [x] TranslationContextSnapshot、translation revision/CAS、CitationResolver V2/CitationSnapshot。
- [x] ExportSnapshot、ExportArtifact、AtomicExportWriter、旧目标保护和产物哈希。
- [x] workspace v2/last-known-good、Esc 基础保护、latest request/drag transaction 基础。
- [x] 合成古籍/论文 fixture、SPDX/vendor manifest、包内许可证、本地 RC manifest、源码和 unpackaged smoke。

## 第一批：必须先补齐的正确性缺口

### A. 导入与任务

- [ ] 将文件发现 producer、格式解析和批次追加从 renderer 移入 main；使用 cursor/selection descriptor，不一次性传递全部路径。
- [~] 导入后的自动 OCR 已按最多 200 条分段登记到统一 `task_jobs/task_items`，保存 engine/batch 设置快照、导入顺序、lease/heartbeat 和逐项结果，关闭后自动恢复；PDF 预览队列仍需迁入持久任务。
- [ ] 导入 item 保存 fingerprint、首次来源、补回来源、目标 folder、任务 ID 和去重决策；同名不同内容必须并列显示。
- [ ] 对超大目录、外部目录循环、取消、权限错误、磁盘满、重复导入建立分批故障注入矩阵。
- [ ] PDF 页拆分、压缩、页图生成和 OCR 之间使用 artifact 引用，不在 IPC/SQLite 单行 JSON 中复制整批数据。

### B. OCR 成品链路

- [ ] 将单页、区域重识别、vision、hybrid、local OCR 全部变为统一 scheduler item，具备 request deadline、heartbeat、cancel 和重建。
- [ ] 稳定 block identity、阅读顺序和坐标版本化；重跑后支持 block-level diff，而不是只能整页替换。
- [ ] 建立 OCR 质量门禁：空结果、低置信度、重叠框、越界框、异常阅读顺序、表格/图片结构缺失进入待复核。
- [ ] 质量门禁结果写入 OCR run/page artifact manifest；失败只生成候选，不激活到 canonical 内容。
- [ ] OCR 运行配置、provider/model、页范围、重试和成本估算可在任务详情查看。

### C. 检索成品链路

- [ ] 将大 folder/tag scope 改为 cursor/临时选择快照，禁止巨大 `IN (...)` 和一次性全量 docId 数组。
- [ ] 所有 all-mode 查询返回 `countsExact/truncated/continuation/coverage/snapshotId`；安全上限不能静默截断。
- [ ] 搜索 index worker 增加 watchdog、exit-without-result reject、超时终止、重建恢复和统一任务记录。
- [ ] phrase-aware OpenCC、非 BMP offset、segment overlap、外置正文、20,000+ 结果和前端反序请求纳入真实行为测试。
- [ ] 精确总数独立为可取消 aggregate job，未完成时显示“至少 N 条/统计中”，不伪装精确。

### D. 文库组织与批量操作

- [x] folder create/update/move/import 已统一 main-side parent 校验，拒绝不存在父级、自引用、后代循环和同层重名；重命名不再静默合并文件夹。
- [~] 标签 create/update 已统一 parent 校验，拒绝空名、不存在父级、自引用、后代循环和规范名冲突；`tags:list` 已改为纯读取。别名关系仍需单独审批存储方案。
- [ ] AI 重分类超过 200 条时改为持久批次；部分失败必须保持 partial/error 并可重试，不能直接 completed。
- [ ] 文件夹、标签、文献选择统一 `SelectionDescriptor`，支持跨页、全匹配、排除项和准确/估算总数。
- [ ] 移动、删除、合并、排除使用 main operation receipt/undo；撤销不能覆盖批次之后的人工修改。

## 第二批：交互与 UI 成品

### E. 交互内核完整接入

- [ ] 将 CloseCoordinator 接入 BrowserWindow close、settings、reader、proof、research draft；保存失败必须阻止关闭或明确放弃。
- [ ] Folders、Tags、Excerpts AI、tab title、跨 workspace 流统一 identity generation/latest-request-wins。
- [ ] 建立 CommandRegistry、OverlayManager、focus transaction 和统一快捷键冲突中心。
- [ ] 完成 tablist/tree/listbox/grid 的键盘、读屏、Shift+F10、Ctrl+Tab、方向键和焦点回退。
- [ ] 文件夹/文献拖放、触控、多选、框选、pointercancel、失焦和 unmount cleanup 全部行为化测试。
- [ ] 业务 undo 只消费 main operation receipt；补回收站、永久删除影响预览和失败回滚。
- [ ] workspace 删除静默 60/40 截断，改为 descriptor 搜索、窗口化、归档提示和可恢复保存失败。
- [ ] 完成活动 tab + LRU warm window、abort generation、显示器/DPI/窗口恢复和 unavailable placeholder。

### F. UI 视觉系统

- [ ] 建立单一 ThemeDefinition/token 层，消除 global.css、Ant token、app.css 的重复颜色和间距。
- [ ] 将 `app.css` 按 shell、navigation、reader、library、research、settings 分层，降低 `!important` 和跨域选择器。
- [ ] 修复操作文本对比度、中文字体回退、focus-visible、reduced-motion、forced-colors、200% zoom 和窄窗口裁切。
- [ ] 统一 StatusBadge、ProgressSummary、StatePanel、EmptyState、ErrorState、Toolbar、Action primitive。
- [ ] 重做欢迎页、文库卡片、文件夹树、搜索结果、阅读器工具栏、AI 浮层和研究面板的层级与密度。
- [ ] 图标按钮补 accessible name/tooltip；鼠标专属控件提供键盘/触控等价入口。
- [ ] 视觉回归使用公开合成 fixture，不使用真实用户文库截图。

## 第三批：用户可见产品功能

### G. OCR 质量中心

- [ ] OCR 版本列表、文本/坐标/版式 diff、候选采用/回退和人工确认。
- [ ] 低置信度、空结果、异常坐标、表格/图片缺失待校对收件箱。
- [ ] OCR 运行详情：范围、配置、耗时、重试、失败原因、成本和产物版本。

### H. 证据收件箱与研究矩阵

- [ ] 从阅读器、搜索、摘录和 AI 收集 canonical evidence，支持多项目关系和项目独立批注。
- [ ] 证据收件箱显示 locator、source hash、precision/resolution、verification/stale 状态。
- [ ] 论点-支持证据-反证-待确认缺口矩阵；正式报告只消费 verified/confirmed 版本。
- [ ] 研究报告逐段/逐句回指 evidence/citation/output lineage，并可导出复现包。

### I. 翻译与引用质量面板

- [ ] 翻译版本对比、术语命中、保护符号、未翻译片段、人工/机器候选差异。
- [ ] 双语平行阅读和带 locator/hash 的 JSON/TSV 导出。
- [ ] 引用质量中心批量列出缺字段、stale/corrupt/legacy 状态和修复入口。
- [ ] 批量引用/导出流程消费 CitationSnapshot ID，不能重新拼接未验证字符串。

### J. 命名工作区与命令面板

- [ ] 创建、命名、复制、切换、归档和恢复本地工作区；只保存 descriptor/view snapshot，不复制正文和密钥。
- [ ] 命令面板按 scope 搜索命令、最近文献、固定文件夹和研究专题。
- [ ] 快捷键冲突、OS 保留键、IME composing、布局变化有解释和恢复默认。
- [ ] 古籍/论文 preset 只改变默认布局、密度、方向和工具，不拆成两套数据模型。

### K. 文库智能整理

- [ ] 未分类、重复候选、缺元数据、标签别名、OCR 未完成和 AI 分类建议的批量预览。
- [ ] 所有移动、合并、删除、标签操作可查看影响范围、准确/估算数量和撤销期限。
- [ ] 外部目录扫描默认手动触发；实时 watcher 属于需单独审批的候选依赖。

### L. 隐私、成本与健康中心

- [ ] OCR/AI provider、发送数据类别、调用量、预算、失败和恢复动作的本地摘要。
- [ ] 离线模式、每任务预算和预算达到后的暂停，不自动发起新请求。
- [ ] 数据库、索引、备份、任务、外部资源和安装包完整性统一健康页。
- [ ] 用户主动导出脱敏诊断包，不包含正文、真实路径、密钥和完整搜索结果。

## 第四批：性能、发布与公开门禁

- [ ] 固定机器性能 fixture：DOM、heap、RSS、IPC bytes、event-loop、切 tab、搜索、滚动、OCR/AI 请求 p95/p99。
- [ ] 统一测试输出 JSON/JUnit、超时分类、重试分类、临时目录清理和 artifact 汇总。
- [ ] 完成 Setup/Portable 安装、升级、卸载、断网、旧库打开、备份恢复和回滚矩阵。
- [ ] 替换全部真实 README/教程截图为合成古籍/现代论文 fixture，并人工复核图片 OCR、metadata、许可证和来源。
- [ ] 检查包内 LICENSE、NOTICE、THIRD_PARTY、SBOM、vendor hash、安装包摘要一致。
- [ ] 用户使用真实古籍副本和普通论文副本本地验收 INT-01 至 INT-40；失败项、已知限制和回退记录入 RC manifest。
- [ ] 用户明确回复测试无问题并批准公开后，才允许 push/PR/Actions/tag/Release。

## 当前执行顺序

1. 导入 producer/consumer、自动 OCR 持久队列和 OCR executor 接入统一 scheduler。
2. folder/tag/selection/批量 operation receipt 与 latest-request 行为化。
3. 搜索 cursor/count/truncation/worker watchdog。
4. CloseCoordinator 完整接线、CommandRegistry/OverlayManager、UI token 分层。
5. OCR 质量中心、证据收件箱、翻译/引用质量面板、命名工作区和命令面板。
6. 智能整理、健康/成本中心、性能矩阵、安装包和合成截图门禁。
7. 全量复核文档冲突，提供本地 RC 给用户验收；不自动公开。
