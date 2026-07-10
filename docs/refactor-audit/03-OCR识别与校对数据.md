# 03 OCR 识别与校对数据

## 1. 本章结论

GujiSmart 的 OCR 已经不是一条简单的“图片上传后保存文本”链路。当前实现同时覆盖飞桨同步图片 OCR、飞桨异步 PDF OCR、PDF 原生文本层直读、视觉模型 OCR、混合 OCR、本地 PaddleOCR、古籍竖排与表格后处理、低质量区域重识别、OCR IR、搜索索引刷新、启动恢复和多种校对界面。尤其是 PDF/qpdf 分片、流式上传、JSONL 下载、已完成页跳过、坐标对齐、重复文本拦截和结构化 IR，都是应当保留的工程基础。

当前最优先的问题不是再叠加一个新模型，而是先保证“旧结果和人工校对绝不丢失、页码绝不写错、任务可以真正取消和恢复、资源始终有界”。全量重跑、单页重跑、视觉重跑、古籍增强、版面重做和版本切换会在新结果成功前清空人工校对；所谓 OCR 版本按 `(page_id, engine)` 唯一，同一引擎重跑会覆盖历史；异步 PDF `pageRanges` 没有返回页数和来源页校验，当前对应行为测试已经失败；视觉 OCR 和本地 OCR 又没有接入统一取消与恢复合同。

本章建议保留现有 `pages` 和 `page_ocr_versions` 作为兼容投影，复用模块 02 已提出的统一持久化任务调度器，并旁路新增 OCR run、page attempt 和 artifact version 结构。任何结果都先进入 staging，完成页码、结构、质量和来源校验后再以短事务激活；人工校对作为独立数据层保留，OCR 变化只把校对标记为“基线已变化”，不得删除。LLM、视觉 OCR 与 PaddleOCR 的明文凭据泄露统一提升为跨模块 P0，必须先于云端 OCR 功能扩展完成 CredentialVault 迁移。第一轮正确性修复不需要新增第三方依赖；新增本地模型、外部服务或解析库仍须实施前确认。

## 2. 审阅范围与现状验证

本章完整阅读或复核了以下主归属文件：

- `src/main/ocr.ts`
- `src/main/ipc/ocr.ts`
- `src/main/local-paddle-ocr.ts`
- `src/main/vision-ocr.ts`
- `src/main/ocr-recovery.ts`
- `src/shared/ocr-ir.ts`
- `src/shared/ocr-run-metadata.ts`
- `src/renderer/src/components/GujiFacsimileProofreader.tsx`
- `src/renderer/src/components/TextEditor.tsx`
- `src/renderer/src/components/OverlayProofreader.tsx`
- `src/renderer/src/utils/ocrCoordinates.ts`
- `src/renderer/src/utils/ocrPageImages.ts`
- `src/renderer/src/utils/ocrText.ts`

同时复核了 `src/main/pdf-preflight.ts`、`src/main/batch-processor.ts`、`src/main/database.ts`、`src/main/ipc/documents.ts`、`src/main/ipc/settings.ts`、`src/preload/index.ts`、`src/shared/types.ts`、`src/renderer/src/views/LibraryView.tsx`、`src/renderer/src/views/DocumentView.tsx` 中与 OCR 提交、保存、版本、校对、页面资产、任务恢复和设置有关的区段，以及对应公开回归脚本。

### 2.1 本次重新执行结果

| 命令 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `npm run check:ocr-layout`、`check:ocr-ir`、`check:ocr-benchmark` | 通过 | 编译后的纯函数与固定语料，覆盖去重、阅读顺序、IR 和少量质量样例 |
| `npm run check:ocr-coordinate`、`node scripts/ocr-coordinate-tightening-regression.js` | 通过 | 坐标换算、局部收紧及部分 renderer 合同 |
| `npm run check:pdf-text-layer` | 通过 | 合成 PDF 的原生文本层、空白页和混合页行为 |
| `npm run test:ocr-recovery`、`npm run test:startup-recovery` | 通过 | 临时 SQLite 上的中断状态修复和启动恢复 |
| `npm run test:library-ocr-status`、`npm run test:source-structured-ocr` | 通过 | Electron/Playwright 下部分状态协调和结构化 OCR 阅读链 |
| `npm run check:ocr-progress`、`check:ocr-upload`、`check:ocr-result-save`、`check:ocr-region`、`check:ocr-run-metadata`、`check:batch-processor-save`、`check:startup-nonblocking`、`check:library-ocr-incomplete` | 通过 | 主要是源码结构、关键字符串或局部纯函数守卫，不能替代故障行为测试 |
| `npm run check:facsimile-stacked-vertical-blocks`、`check:reading-order`、`check:source-reader-image` | 通过 | 主要是 renderer 源码合同守卫 |
| `npm run test:ocr-pdf-resume` | **失败** | 目标页应为第 3、5 页，实际得到 `page 1`、`page 2` |
| `node scripts/ocr-async-pdf-complete-pending-regression.js` | **失败** | 等待结果文件阶段的源码合同已漂移；脚本本身也没有模拟真实状态序列 |

`test:ocr-pdf-resume` 的 mock 没有按上传 FormData 中的 `pageRanges` 返回紧凑页结果，因此测试桩需要修正；但生产代码同样没有验证服务端是否真的遵守页范围和返回基数，所以不能把它简单归为“只需改测试”。正确目标是同时修正 mock，并新增“服务忽略 `pageRanges` 时明确失败且零写入”的负例。

`ocr-async-pdf-complete-pending-regression.js` 目前只通过源码字符串判断设计意图。核心轮询代码在成功态但没有结果 URL 时立即抛错，三分钟 grace 分支实际到不了；IPC 还把 `awaitingResultFile` 的布尔条件写反。该脚本应升级为可控时钟加状态序列行为测试。

## 3. 当前端到端数据流

### 3.1 引擎分流

`documents:batchOcr` 根据 engine 和文献格式进入不同路径：

```text
Paddle + PDF
  -> PDF 文本层预检
  -> 可用页直接生成 native_pdf_text 结果
  -> 其余页整本上传 / pageRanges / qpdf / pdf-lib 分片
  -> 异步提交、轮询、JSONL 下载、页映射、后处理、分块保存

Paddle + 图片页
  -> 准备图片、限流调用同步 OCR
  -> 古籍竖排/表格/坐标/重复文本后处理
  -> 分块写 pages 和 page_ocr_versions

Vision / Hybrid
  -> renderer 确保页图可读
  -> OpenAI-compatible vision 请求
  -> 结构化 JSON、版面块、目录候选和可选 Paddle 合并
  -> 保存并触发目录、搜索与后台结构整理

Local Paddle
  -> 设置页下载或导入 runtime/model
  -> 每页启动 Python/runner 进程
  -> 解析 stdout JSON 并保存
```

### 3.2 飞桨异步 PDF

当前异步 PDF 链路会优先直接上传原 PDF；超出服务限制或出现结构问题时使用 qpdf 或 pdf-lib 生成分片。选择部分页时，原文件上传配合 `pageRanges`，本地物理分片则直接只包含目标页。提交、轮询和结果下载均接受 AbortSignal，下载使用 Reader 与 idle timeout，并按 JSONL 行解析。

结果页当前主要依靠“返回数组序号”映射到 `resultPageIndexes`，而不是服务端返回的稳定源页标识。JSONL 虽然流式读取，但每个分片仍把最多 1000 页 payload 全部累计到数组，再归一化并返回（`src/main/ocr.ts:177`、`src/main/ocr.ts:5100` 至 `src/main/ocr.ts:5159`）。

### 3.3 保存、版本与校对

`savePageOcrResults` 会在事务内直接更新 `pages.ocr_text/ocr_result/ocr_status`，随后 upsert `page_ocr_versions`，再把搜索索引标脏并安排后台 IR/目录整理（`src/main/ipc/ocr.ts:4957` 至 `src/main/ipc/ocr.ts:5089`）。大结果每 50 页提交一次事务，因此是“逐批直接激活”，不是 staging 后切换。

保存函数本身在发现 `proofed_text` 时会尽量保留校对状态；但全量和多种单页入口在调用保存函数之前已经把校对字段清空，因此这一保护无法避免数据丢失。版本切换也直接把 `proofed_text` 设为 null。

### 3.4 恢复、取消与进度

主 `documents:batchOcr` 为活动文献建立 AbortController，普通 Paddle 且非强制重跑的任务会写入 `batch_queue` 供启动恢复。`ocr-recovery.ts` 能把中断页、已有内容但状态滞后的页和孤立 batch item 修正到可继续状态。

恢复覆盖并不统一：vision、hybrid、local、强制重跑、区域重识别和版面重做没有同一 run/attempt；legacy `BatchProcessor` 的 pause/cancel 只改内存 job 状态，恢复时每个 batch group 都立即启动。进度事件有 `runMetadata` 摘要，但没有稳定 `runId/attemptId/eventSeq`，旧事件和新尝试难以严格区分。

### 3.5 OCR IR 与校对界面

`ocr-ir.ts` 把多种云端/本地返回规范化为统一页、block、paragraph、table、formula、reading flow 和质量报告，并保留原来源与处理事件。古籍影印校对、叠加框校对和阅读器都复用坐标与版面信息。

当前 DocumentView 的生产校对路径是 `GujiFacsimileProofreader` 或 `TextEditor`（`src/renderer/src/views/DocumentView.tsx:5707` 至 `src/renderer/src/views/DocumentView.tsx:5761`）。`OverlayProofreader` 没有生产 import/JSX，仅被源码合同脚本引用，因此其保存和 undo/redo 问题属于待删除或重新接入的 dormant code 风险，不能代表现行校对行为。

现行两个编辑器也没有可靠的保存确认合同：子组件 `onSave` 类型为 void，父级保存吞掉异常；TextEditor 的 undo/redo 只改本地状态。坐标工具对四数字数组用启发式猜测 `xyxy` 或 `xywh`，古籍竖列拆分又可能只更新临时 rect 而保留旧 location。页面图片“可读性”检查会把完整图片读成 Base64，仅为判断路径是否存在，且没有验证图片能否解码或页码是否对应。

## 4. 必须保留的能力

- 原 PDF 直接上传、官方 `pageRanges`、qpdf 优先和 pdf-lib 回退。
- 上传超时、轮询 idle/stall 检测、下载 Reader、JSONL 行解析和事件循环让步。
- 已完成页跳过、页级补跑、启动恢复和当前主 Paddle AbortSignal。
- 原生 PDF 文本层直读，避免对可靠文字 PDF 重复 OCR。
- 古籍竖排、双页影印、表格、目录候选、小字夹注、重复文本和图片块处理。
- 坐标保存、读取时兼容校正、局部低质量区域重识别和结构重处理。
- OCR IR 的来源、处理过程、阅读顺序、表格/公式、跨页连续性和质量摘要。
- OCR 保存后搜索标脏、后台 finalize、目录失效和页面资产外置。
- 本地 OCR runtime/model 不进入默认安装包和公开 Release；下载、校验和安全解压边界继续保留。

## 5. 关键问题

### D03-P1-01 新 OCR 成功前清空人工校对，失败、取消或崩溃会造成数据丢失

**证据等级：已确认。**

全量强制重跑在 `resetPagesForFullOcrRerun` 中把整本文献的 `proofed_text` 和 `proofed_text_ref` 置空（`src/main/ipc/ocr.ts:4732` 至 `src/main/ipc/ocr.ts:4746`）。单页 Paddle、视觉、古籍增强和版面重做分别在 `src/main/ipc/ocr.ts:6403`、`src/main/ipc/ocr.ts:6472`、`src/main/ipc/ocr.ts:6537`、`src/main/ipc/ocr.ts:6603` 先清校对；版本切换也在 `src/main/ipc/documents.ts:5360` 至 `src/main/ipc/documents.ts:5362` 清空。

**落实方案：**

1. 所有 OCR/版面操作禁止修改 `proofed_text`；新结果只写 staging artifact。
2. 校验成功后激活 OCR artifact，但人工校对仍保留，并记录其基于哪个 artifact/hash。
3. 若 OCR 基线变化，校对状态改为 `base_changed` 或等价诊断，不自动回到空白 pending。
4. UI 提供“保留我的校对”“查看 OCR 差异并合并”“明确丢弃校对”三种显式动作。
5. 第一批先补故障测试：提交失败、轮询失败、保存一半、用户取消、进程强退和版本切换取消都必须保持校对字节完全不变。

### D03-P1-02 OCR“版本”按引擎覆盖，不是真正的历史版本

**证据等级：已确认。**

数据库唯一索引是 `page_ocr_versions(page_id, engine)`（`src/main/database.ts:933`）；保存使用 `ON CONFLICT(page_id, engine) DO UPDATE`（`src/main/ipc/ocr.ts:3972` 至 `src/main/ipc/ocr.ts:4003`）。同一引擎更换模型、prompt、参数或重新识别后，旧结果和 provenance 被覆盖。

**落实方案：**

- 新 artifact 以独立 ID 和 `run_id` 插入，唯一约束为 `(run_id, page_id)`，不以 engine 去重历史。
- 每个 artifact 保存 engine、模型、服务商、prompt/参数版本、输入文件指纹、页面源编号、坐标基准、耗时、重试、费用和质量摘要。
- `pages` 继续保存当前激活文本/结果，供旧代码和旧数据库读取；`page_ocr_versions` 在兼容期表示“每个 engine 最近可切换投影”，不再承担完整历史。
- 激活、回滚和删除历史分别建显式命令；删除当前激活版本前必须先切换或拒绝。

### D03-P1-03 `pageRanges` 结果缺少来源与基数校验，存在静默错页风险

**证据等级：生产防御缺失已确认；云端是否违约需真实服务验证。**

直接上传原 PDF 时会把 `sourcePageIndexes` 写入 `resultPageIndexes`（`src/main/ocr.ts:4569` 至 `src/main/ocr.ts:4582`）；结果归一化再按数组序号建立映射（`src/main/ocr.ts:5173` 至 `src/main/ocr.ts:5196`）。代码没有验证返回页数、服务端页码、结果内页码或源文件指纹。

本轮 `npm run test:ocr-pdf-resume` 稳定失败：目标第 3、5 页实际映射成第 1、2 页。测试 mock 需要理解 `pageRanges`，同时生产端必须 fail closed。

**落实方案：**

- 每次提交生成 immutable chunk manifest：源文件 hash、target page nums、pageRanges、上传页数、预期结果数和 attempt ID。
- 结果必须满足“显式页码可验证”或“返回数量严格等于目标数量且服务能力已声明”之一；否则整个 chunk 标为 `contract_mismatch`，零激活。
- 若服务返回全书结果，只能在页数等于原 PDF 页数时按原页筛选；不能把前 N 个结果猜成目标页。
- 保存前逐页检查 page ID、source page num、图像尺寸/坐标基准和重复结果指纹。
- 对真实 Paddle API 建小型 canary，覆盖连续、离散、倒序输入被规范化、1000 页边界和服务忽略参数。

### D03-P1-04 异步任务“完成但结果文件未就绪”的状态机和 UI 阶段均有错误

**证据等级：已确认。**

轮询在 `success/completed` 但没有 `jsonUrl` 时立即抛错（`src/main/ocr.ts:4948` 至 `src/main/ocr.ts:4958`），后面的三分钟 grace 逻辑因此对该常见状态不可达（`src/main/ocr.ts:4965` 至 `src/main/ocr.ts:4968`）。

IPC 把 `isAwaitingAsyncResult` 定义为“全部完成且 **不是** awaitingResultFile”（`src/main/ipc/ocr.ts:5690` 至 `src/main/ipc/ocr.ts:5692`），导致真正等待结果文件时 phase 反而从 saving 回到 ocr。直接运行 `ocr-async-pdf-complete-pending-regression.js` 也已经失败。

**落实方案：** 建立显式 `submitted -> queued -> processing -> result_pending -> downloading -> validating -> activating -> completed` 状态机；所有状态转换带 run/attempt/eventSeq，测试使用 fake clock 连续模拟状态序列，不再用源码字符串证明行为。

### D03-P1-05 服务繁忙可在提交 limiter 内重试接近四小时，缺少服务级背压和公平性

**证据等级：已确认。**

队列忙会把最大尝试次数扩到 240，后期每次等待 60 秒（`src/main/ocr.ts:4770` 至 `src/main/ocr.ts:4861`），总等待接近 3 小时 58 分。整个重试循环占用 `asyncSubmitLimit` 槽位，且没有读取 `Retry-After`、全局 cooldown、随机抖动、优先级或不同用户任务之间的公平调度；死代码 `if (false && ...)` 还保留了旧 API envelope 分支（`src/main/ocr.ts:4819` 至 `src/main/ocr.ts:4829`）。

**落实方案：**

- 一次提交失败后释放网络令牌，把 `next_attempt_at` 持久化，由 scheduler 到时重新 claim。
- 优先使用标准 `Retry-After`，否则采用有上限的指数退避加 jitter；服务级 429/queue full 触发共享 cooldown。
- 交互单页、用户手动批次、自动导入和后台维护使用明确优先级与 aging，不能让大批任务长期占满。
- 默认最大自动等待和最大尝试可配置；达到上限后进入 `waiting_user/retryable`，不伪装成持续运行。
- 删除死分支，并以录制的 API envelope fixture 覆盖兼容解析。

### D03-P1-06 文档、页面、提交和结果数组各自限流，但没有统一资源预算

**证据等级：已确认。**

renderer 默认一次并发 5 篇、最大 20 篇（`src/renderer/src/views/LibraryView.tsx:3752` 至 `src/renderer/src/views/LibraryView.tsx:3780`）；单文档图片页默认并发 6、最大 32（`src/main/ocr.ts:159` 至 `src/main/ocr.ts:162`）。默认可能出现 30 个页请求，配置上限理论可达 640。vision 页并发又可单独设到 20（`src/main/vision-ocr.ts:180` 至 `src/main/vision-ocr.ts:195`）。

`recognizePages` 和 vision 路径虽然有 limiter，仍对全部页面创建 `Promise.all(pages.map(...))`（`src/main/ocr.ts:3928` 至 `src/main/ocr.ts:4013`、`src/main/vision-ocr.ts:1110` 至 `src/main/vision-ocr.ts:1120`）；文档批处理也对全部 docIds 创建 Promise（`src/main/ipc/ocr.ts:6310`）。任务总数不设上限时，闭包、Promise、结果数组和 IPC payload 仍随总量增长。

**落实方案：**

- scheduler 建立全局资源令牌：远端提交、轮询、下载、图片预处理、CPU 后处理、本地 worker、数据库写入和单文档页面窗口。
- 页面和文档都采用 claim cursor + 固定 worker 数，不为尚未 claim 的全部条目创建 Promise。
- JSONL 每读一页就规范化、校验并写 staging；不能在单 chunk 内累计最多 1000 页 payload。
- 异步 PDF chunk concurrency 当前设置最大值固定为 1（`src/main/ocr.ts:163` 至 `src/main/ocr.ts:164`），先保留保守值；只有基准证明服务、内存和公平性可承受时才开放 2 以上。
- 设置页显示的是“全局并发预算”和按资源推导的有效并发，而不是让多个相乘旋钮制造不可预测负载。

### D03-P1-07 直接分批覆盖 active pages，缺少可验证 staging 与激活边界

**证据等级：已确认。**

当前每 50 页在事务中直接更新 active `pages`，之后继续处理下一批（`src/main/ipc/ocr.ts:4957` 至 `src/main/ipc/ocr.ts:5124`）。中途失败时文献可能同时包含新旧 run 的 active 页面；恢复只能根据内容与状态推断，无法证明每页来自哪个 attempt。

**落实方案：**

- 远端结果、规范化 IR、质量报告和 source mapping 先写 artifact staging。
- 页级校验通过后以短事务更新 active artifact 和 `pages` 投影；失败页继续指向旧 artifact。
- run manifest 记录目标页集合以及每页 `old_active/new_active/failed/skipped`；文献级顶层状态使用 `completed + completionKind='partial'`，而不是新增 `partial` 终态或靠文本是否为空推断。
- 对要求整批一致的操作提供“全部目标页验证完成后再切换”的可选模式，但默认使用有界页级原子激活，避免超大事务。

### D03-P1-08 恢复合同只覆盖部分 Paddle 任务，legacy pause/cancel 也不终止当前工作

**证据等级：已确认。**

`shouldPersistBatchOcrForRecovery` 只接受普通 Paddle 且非强制重跑（`src/main/ipc/ocr.ts:336` 至 `src/main/ipc/ocr.ts:339`）。vision、hybrid、local、单页、区域和版面任务没有统一持久化 attempt。

legacy BatchProcessor 恢复时按 batch group 全部启动（`src/main/batch-processor.ts:482` 至 `src/main/batch-processor.ts:514`）；pause/cancel 只修改 job 状态和 map，不 abort 当前 controller（`src/main/batch-processor.ts:781` 至 `src/main/batch-processor.ts:802`）。

**落实方案：** 所有 OCR 入口统一创建 `task_job/task_item + ocr_run/page_attempt`；pause 停止新 claim，cancel abort 当前网络/本地进程并把未开始项标 canceled，重启只恢复 lease 过期且未提交的 attempt。legacy API 在一个兼容版本内转发到统一 scheduler，Dashboard 和 preload 调用迁移后删除旧物理队列。

### D03-P1-09 视觉 OCR 无任务 AbortSignal，且默认把原文、prompt 和响应写入无期限日志

**证据等级：已确认。**

视觉请求只创建超时 controller，没有接收外部任务 signal（`src/main/vision-ocr.ts:626` 至 `src/main/vision-ocr.ts:667`）；重试 sleep 和 `recognizePagesWithVisionModel` 也不可由 OCR cancel 中断（`src/main/vision-ocr.ts:1081` 至 `src/main/vision-ocr.ts:1120`）。

失败和成功都会写诊断日志，内容包括 base text preview、完整 prompt、请求体预览、模型响应预览和解析结果（`src/main/vision-ocr.ts:703` 至 `src/main/vision-ocr.ts:792`、`src/main/vision-ocr.ts:939` 至 `src/main/vision-ocr.ts:948`）。图片 data URL 被脱敏，但文字隐私和磁盘增长没有 opt-in、容量或 TTL。

**落实方案：**

- signal 从 job 一直传到图片读取、fetch、重试 sleep、JSON 解析和保存；timeout 与用户 cancel 使用组合 signal，并区分错误码。
- 普通日志只保留 request ID、模型、耗时、字节、token、错误分类和 hash；原文/响应仅在用户主动开启诊断后临时保存。
- 诊断日志设置单文件上限、总容量、TTL、一键清理和备份排除；导出前显示包含的数据范围。
- vision/hybrid 的每次外发记录服务商、目的、页面范围和用户授权版本。

### D03-P1-10 本地 Paddle 每页重启进程和模型，缺少超时、取消与卡死恢复

**证据等级：已确认。**

`runLocalPaddleRunner` 每页调用 `spawn` 并累计 stdout/stderr，只有 close/error 回调，没有 timeout 或 signal（`src/main/local-paddle-ocr.ts:1303` 至 `src/main/local-paddle-ocr.ts:1384`）。`recognizePagesWithLocalPaddle` 再逐页串行调用它（`src/main/local-paddle-ocr.ts:1387` 至 `src/main/local-paddle-ocr.ts:1434`），模型很可能每页重新加载。

**落实方案：** 使用固定数量常驻 runner，通过 stdio JSONL 或本地受限 IPC 传页任务；每个 request 有 deadline、最大输出、heartbeat 和 cancel，进程卡死时先终止再重建。模型下载、SHA-256、manifest 和安全解压继续使用现有机制；引入新的 runtime 或模型仍需实施前确认。

### D03-P1-11 大 PDF 预检与整本 IR 会形成重复整本内存峰值

**证据等级：已确认。**

文本层预检先 `readFile` 整个 PDF 到 Uint8Array（`src/main/pdf-preflight.ts:233` 至 `src/main/pdf-preflight.ts:247`），OCR 路径又设置 `analyzeAllPages: true`（`src/main/ipc/ocr.ts:5339` 至 `src/main/ipc/ocr.ts:5342`）。最多 8 个缓存项保存全部页面分析（`src/main/pdf-preflight.ts:25` 至 `src/main/pdf-preflight.ts:31`）。OCR 结束后 `reprocessDocumentOcrStructure` hydrate 全部已完成页面并构造整本文档 IR（`src/main/ipc/ocr.ts:4299` 至 `src/main/ipc/ocr.ts:4320`、调用点 `src/main/ipc/ocr.ts:6052`）。

**落实方案：**

- 先采样判定，只有发现可用文本层时才按页流式扫描剩余页；任务可取消并在 worker 中运行。
- cache 只保存文件签名、页级摘要和外置结果引用，不保存多个整本大对象。
- 文档 IR 按页增量写入，跨页连续性使用有限窗口与最终归并，不 hydrate 整本 payload。
- 建 10、100、1000、5000 页基准，记录峰值 RSS、event-loop delay、首个结果时延和取消时延。

### D03-P0-01 LLM、视觉 OCR 与 PaddleOCR 凭据明文进入 SQLite、renderer 和整库备份

**证据等级：已确认。**

所有设置都是 `settings(key,value)` 明文（`src/main/database.ts:519` 至 `src/main/database.ts:522`）；视觉和 LLM profile 直接序列化 `apiKey`（`src/main/ipc/settings.ts:511` 至 `src/main/ipc/settings.ts:540`）；PaddleOCR 直接读取 `paddleocr_api_key`（`src/main/ocr.ts:347` 至 `src/main/ocr.ts:356`），模型列表 IPC 也可接收 renderer 明文 Token（`src/main/ipc/settings.ts:646` 至 `src/main/ipc/settings.ts:651`）；`settings:getAll` 返回全部键值到 renderer（`src/main/ipc/settings.ts:633` 至 `src/main/ipc/settings.ts:640`）。整库备份自然会携带三类密钥。

**落实方案：** 复用模块 01/07 唯一 `CredentialVault`：Electron `safeStorage` 密文写入 `userData/secrets` versioned sidecar，SQLite 只保存 entry/version/state。renderer 只能短暂提交当前草稿，已保存 secret 不得读回；Paddle/视觉/LLM 模型列表与连通性测试只使用 profileId 或 TTL draft ref。sidecar 与 SQLite 通过 prepare/activate/finalize journal 恢复，普通备份默认排除 secret，历史含密钥备份生成脱敏替代副本后由用户决定是否隔离原件。迁移先准备并验证密文，再切换引用和清理旧明文；失败保持完整旧状态，不能新建普通明文备份。

### D03-P1-12 阅读正文、搜索、翻译和导出没有使用同一 canonical text

**证据等级：已确认。**

`extractPageText` 对古籍、报刊等页面会先从旧 OCR blocks 返回文本，之后才检查 `proofed_text`（`src/renderer/src/utils/ocrText.ts:1151` 至 `src/renderer/src/utils/ocrText.ts:1176`）；`getReadablePageElements` 只要 layout blocks 可用就直接返回，最终 fallback 才进入 `extractPageText`（`src/renderer/src/utils/ocrText.ts:1744` 至 `src/renderer/src/utils/ocrText.ts:1854`）。DocumentView 检索和主进程导出却优先使用人工校对。古籍影印翻译源只接收 `ocr_result`，无法看到 page 上的 `proofed_text`（`src/renderer/src/components/GujiFacsimileProofreader.tsx:1692` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:1694`、`src/renderer/src/views/DocumentView.tsx:1689` 至 `src/renderer/src/views/DocumentView.tsx:1691`）。

这会让用户看到旧 OCR、搜索命中校对文本、导出另一份文本，翻译又基于旧 OCR。

反过来，三套编辑器又把全部 layout block 的 words 直接 join 成 `ocr_text/proofed_text`（`src/renderer/src/components/GujiFacsimileProofreader.tsx:1596` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:1633`、`src/renderer/src/components/TextEditor.tsx:218` 至 `src/renderer/src/components/TextEditor.tsx:226`）。Guji blocks 会保留页眉、页码、印章和图片等定位块，图片 fallback 还可能使用 alt/`image` 作为 words（`src/renderer/src/components/GujiFacsimileProofreader.tsx:677` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:732`）。如果简单把 proofed_text 提到最高优先级，会把装饰块和图片占位污染搜索与导出。

**落实方案：**

- shared 定义唯一 `CanonicalPageContent` DTO，并由模块 03 的 `CanonicalContentProvider.resolvePage(...)` 返回：已确认人工校对优先，否则 active artifact；同时返回来源、base artifact 和 source-range 映射。
- canonical proof text 必须从共享 reading-flow derivation 生成，明确排除 header/footer/page number/seal/image 等装饰块，并定义表格、公式、图注的序列化策略。
- 阅读、页内检索、全库索引、AI、翻译、引用和导出全部消费同一 provider，禁止自行写 `proofed_text || ocr_text` 变体。
- 结构化阅读不能因为需要 layout blocks 就丢掉人工文本；应把 proof revision 映射回 block/source range，无法映射时明确进入纯文本校对视图。
- OCR-15 必须用同一数据库样本跨所有消费者比较输出 hash。

### D03-P1-13 现行校对保存会吞掉失败，调用方无法等待、重试或处理乱序

**证据等级：已确认。**

GujiFacsimileProofreader 和 dormant Overlay 的 `onSave` 都是 void 合同；Guji 提交后会立即关闭编辑和推进历史，无法 await 保存结果（`src/renderer/src/components/GujiFacsimileProofreader.tsx:2117` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:2136`）。父 `handleSavePage` 捕获异常后只显示消息，不向子组件传播；也没有检查 main 返回 false 的“页面不存在”结果（`src/renderer/src/views/DocumentView.tsx:3520` 至 `src/renderer/src/views/DocumentView.tsx:3584`、`src/main/ipc/documents.ts:5215` 至 `src/main/ipc/documents.ts:5220`）。

即使保存成功，父层回写新的 page/ocrResult 对象后，Guji 初始化 effect 会把 history 重置为单一快照（`src/renderer/src/components/GujiFacsimileProofreader.tsx:1790` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:1798`）；TextEditor 也会在 layoutResult/ocrResult 变化时清空历史（`src/renderer/src/components/TextEditor.tsx:168` 至 `src/renderer/src/components/TextEditor.tsx:189`）。因此 undo 往往只在 IPC 回包前短暂可用。

**落实方案：**

- 合同改为 `Promise<SaveResult>`，包含 pageId、revision、clientSeq、savedAt、conflict/errorCode。
- 每页单写队列串行保存；旧 response 到达时不得覆盖新 revision。
- 保存中、已保存、离线草稿、冲突和失败都有可见状态；失败不关闭编辑器，不清本地内容。
- undo/redo 生成新 revision 并走同一保存队列，不直接篡改历史 active 行；自己的 save echo 只确认 revision，不重置历史，只有外部 baseRevision 变化才启动合并。

### D03-P1-14 古籍竖列拆分和坐标解析存在保存后 round-trip 损坏

**证据等级：已确认。**

`splitWideVerticalBlocks` 和叠块拆分只更新临时 `__rect`，保留原 `location`（`src/renderer/src/components/GujiFacsimileProofreader.tsx:786` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:803`、`src/renderer/src/components/GujiFacsimileProofreader.tsx:867` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:881`）。保存时又优先写 `block.location`，所以多个拆列可能全部写回同一个旧大矩形（`src/renderer/src/components/GujiFacsimileProofreader.tsx:1596` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:1626`）。

renderer 对 `[80,120,30,40]` 可按 xywh 解析，IR `toOcrBoundingBox` 对同一输入却可能返回 undefined（`src/shared/ocr-ir.ts:173` 至 `src/shared/ocr-ir.ts:182`）；`pages:update` 又会强制重建 IR（`src/main/ipc/documents.ts:5233` 至 `src/main/ipc/documents.ts:5244`），造成保存后坐标覆盖率下降。

**落实方案：**

- block 内只保留一个权威 rect；拆分时同步生成明确 `location + coordinate_format`，保存不得优先旧字段。
- renderer、main 和 IR 使用同一坐标 parser/serializer，并做 save -> reload -> rebuild IR round-trip 属性测试。
- 旧格式猜测带 `inferredFormat/confidence`；不确定时保留原始 coordinate，不静默丢弃。

### D03-P1-15 页图请求越界时可能把 PDF 最后一页静默复制成不存在的页

**证据等级：已确认。**

`ensurePdfPageImagesForOcr` 使用 PDF 页数、数据库页数和请求最大页码的最大值过滤（`src/renderer/src/utils/ocrPageImages.ts:157` 至 `src/renderer/src/utils/ocrPageImages.ts:168`），然后按请求 pageNum 缓存（`src/renderer/src/utils/ocrPageImages.ts:180` 至 `src/renderer/src/utils/ocrPageImages.ts:188`）。底层 PDF render 会把越界 pageNum clamp 到最后一页（`src/renderer/src/utils/pdf.ts:205` 至 `src/renderer/src/utils/pdf.ts:228`）。例如请求第 11 页而 PDF 只有 10 页时，可能把第 10 页保存成 `page_11.jpg`。

**落实方案：** PDF 实际页数是硬边界；请求越界必须 `page_out_of_range` 失败，绝不 clamp。render 返回实际 pageNum，缓存前断言与请求一致；数据库页数冲突进入页面完整性诊断，不自动制造页图。

### D03-P1-16 人工编辑 hybrid 页面可能用传统 OCR 底稿覆盖视觉校正和 provenance

**证据等级：已确认。**

`getProofingOcrResult` 对 hybrid/fallback 返回 `base_ocr_result`（`src/renderer/src/views/DocumentView.tsx:581` 至 `src/renderer/src/views/DocumentView.tsx:587`），TextEditor 接收该对象后 spread 并把它作为整页 `ocr_result` 回写（`src/renderer/src/views/DocumentView.tsx:5744` 至 `src/renderer/src/views/DocumentView.tsx:5748`、`src/renderer/src/components/TextEditor.tsx:218` 至 `src/renderer/src/components/TextEditor.tsx:227`）。一次改字可能删除顶层 `source_type: hybrid_ocr`、视觉 `corrected_text`、warnings、TOC 和 provenance。Guji 路径选择带坐标的 base 后也存在同类风险（`src/renderer/src/views/DocumentView.tsx:707` 至 `src/renderer/src/views/DocumentView.tsx:714`）。

**落实方案：** 校对只写独立 proof revision 和 block patch，不把“用于显示坐标的候选对象”当持久化基线；active OCR artifact immutable。需要物化兼容 `pages.ocr_result` 时，由 main 将 proof overlay 合并到原 artifact 的兼容视图，保留 hybrid/vision provenance 和未编辑结构。

### D03-P2-01 IR 空页可以得到 0.55 质量分，页级空结果没有明确问题码

`buildQualityReport` 只遍历已有 block；没有 block 时 warning 仍为 0，最终 score 为 0.55（`src/shared/ocr-ir.ts:609` 至 `src/shared/ocr-ir.ts:665`）。新增页级 `empty_page/empty_result` 诊断，并区分真实空白页、只含图片页、服务空响应和解析丢失。

### D03-P2-02 非法 HTML 数字实体可让 OCR 页面渲染崩溃

`decodeHtmlEntities` 对数字实体直接调用 `String.fromCodePoint`（`src/renderer/src/utils/ocrText.ts:370` 至 `src/renderer/src/utils/ocrText.ts:379`）；超出 Unicode 范围的 `&#99999999;` 会抛 RangeError。解析必须校验 0 至 0x10FFFF、排除 surrogate，并用替换字符加诊断继续渲染。

### D03-P2-03 renderer 为判断页图可读而加载完整 Base64，页图准备没有统一取消

`isReadablePageImagePath` 调用 `readImageAsDataURL`（`src/renderer/src/utils/ocrPageImages.ts:50` 至 `src/renderer/src/utils/ocrPageImages.ts:58`），main 侧只 exists/readFile/base64，没有验证图片可解码（`src/main/ipc/settings.ts:1005` 至 `src/main/ipc/settings.ts:1014`）；零字节和损坏图片也可能被判 ready。检查最多 12 路并发（`src/renderer/src/utils/ocrPageImages.ts:75` 至 `src/renderer/src/utils/ocrPageImages.ts:89`），任一 worker 失败后其他 Promise 仍继续写缓存。

应新增 main 侧 `probeImage`，只读取头部并实际解码尺寸；`runLimited` 接受 AbortSignal，失败后停止新领取并等待已开始 worker 安全收束；生成页图进入持久任务。

### D03-P2-04 OCR 校对组件的生产状态、历史行为和测试合同已经分叉

OverlayProofreader 没有生产调用，但多个回归脚本仍把它当成主要校对实现；它的 undo/redo 只改本地 state（`src/renderer/src/components/OverlayProofreader.tsx:729` 至 `src/renderer/src/components/OverlayProofreader.tsx:768`）。现行 Guji 有 undo、无 redo，TextEditor 有本地 undo/redo，却都受保存回显重置历史影响。应决定删除 dormant Overlay 或正式复用，测试只针对真实生产路径；所有活跃编辑器共享同一 revision/history service。

### D03-P2-05 进度摘要缺少稳定 run/attempt 身份

`OcrProgressEvent` 只有 docId、页数、phase 和摘要（`src/shared/types.ts:672` 至 `src/shared/types.ts:688`）；`OcrRunMetadata` 也没有 run ID。增加 `runId/attemptId/eventSeq/leaseOwner`，renderer 只接受当前 run 的单调事件，历史任务中心按 ID 查询持久状态。

### D03-P2-06 OCR block 编辑和翻译状态缺少键盘与辅助技术语义

Overlay 和 Guji 的 block/translation overlay 主要依赖 click/double-click，缺少 role、tabIndex、Enter/Space/Escape；图标按钮和动态翻译状态也缺少完整 aria-label/aria-live（`src/renderer/src/components/OverlayProofreader.tsx:922` 至 `src/renderer/src/components/OverlayProofreader.tsx:1040`、`src/renderer/src/components/GujiFacsimileProofreader.tsx:2362` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:2597`）。模块 08/09 应提供等价键盘路径，但 OCR 编辑命令和 revision 仍由本模块定义。

### D03-P2-07 renderer 版面测量缺少大块性能基准

Overlay 会对每个竖排 block crop canvas、`getImageData` 并逐像素扫描（`src/renderer/src/components/OverlayProofreader.tsx:315` 至 `src/renderer/src/components/OverlayProofreader.tsx:425`、`src/renderer/src/components/OverlayProofreader.tsx:703` 至 `src/renderer/src/components/OverlayProofreader.tsx:720`）；Guji 换行反复测量累积字符串并二分字号，长合并 block 接近 O(n²)（`src/renderer/src/components/GujiFacsimileProofreader.tsx:1244` 至 `src/renderer/src/components/GujiFacsimileProofreader.tsx:1367`）。现有 OCR benchmark 只测 IR，不测 renderer。目标是缓存测量、按可见 block 计算并建立长页交互基准。

### D03-P2-08 中文重复文本错误没有进入 run metadata 的 `repeated_text` 诊断

`ocr-run-metadata` 只搜索英文 repeated/duplicate（`src/shared/ocr-run-metadata.ts:46` 至 `src/shared/ocr-run-metadata.ts:55`），实际 guard 文案是中文“疑似重复生成”（`src/main/ocr.ts:2967` 至 `src/main/ocr.ts:2970`）。应从稳定 error code 构建 metadata，不从本地化 message 猜测；现有测试需加入中文和未来本地化样例。

## 6. 目标架构与数据兼容

```text
Renderer / Import Outbox / Manual OCR
  -> Unified Task Scheduler (模块 02)
     -> task_jobs / task_items
     -> bounded claim, lease, retry, pause, cancel, priority
        -> OCR Run Coordinator
           -> ocr_runs
           -> ocr_page_attempts
           -> engine adapters
              Paddle PDF | Paddle image | Vision | Hybrid | Local
           -> staging artifact validation
           -> page-level atomic activation
              -> ocr_artifact_versions
              -> pages active compatibility projection
              -> page_ocr_versions latest-engine compatibility projection
           -> search/TOC/IR outbox
```

### 6.1 建议的旁路结构

**`ocr_runs`**

- run ID、doc ID、engine/profile、目标页集合引用、source fingerprint。
- 模型、endpoint 标识、prompt/参数/pipeline 版本和用户授权版本。
- 顶层 `TaskStatus=queued|running|paused|completed|error|canceled`、领域 phase、`completionKind=complete|partial`、统计、开始/结束时间和父 run；旧 failed/partial 只通过模块 01 的兼容映射读取。

**`ocr_page_attempts`**

- run ID、page ID、source page num、chunk/`pageRanges` manifest、attempt 序号。
- lease、状态、next attempt、错误码、请求 ID、耗时、字节、token/费用。
- staging artifact ID 和校验结果。

**`ocr_artifact_versions`**

- immutable artifact ID、page ID、run ID、engine、text/result/IR 外置引用。
- coordinate contract、quality report、provenance、created time 和 active 标记。
- 同一 page/engine 可有无限历史；保留策略由用户设置，删除前检查引用。

这些表均为 additive migration，不删除或改写 `pages` 的现有列。旧版本仍可读取当前 active 投影；但旧版本继续执行 OCR 或校对会绕过新历史合同，因此“旧版可读”和“旧版可继续写”必须分开验收。若不能提供兼容写入桥，降级写入应恢复迁移前备份。

### 6.2 激活与校对原则

- OCR artifact immutable，激活指针可变。
- `pages.ocr_text/ocr_result` 是 active artifact 的兼容投影。
- `proofed_text` 属于人工层，不属于 OCR artifact；任何自动任务不得清空。
- 校对保存记录 base artifact/hash；基线变化时进入三方差异合并。
- 搜索、AI、导出和阅读统一使用 `CanonicalContentProvider.resolvePage(...) -> CanonicalPageContent`：已确认人工校对优先，否则 active OCR。

## 7. 分阶段落实方案

### 阶段 A：先封住凭据泄露、数据错误与数据丢失

- 先完成 D03-P0-01：三类凭据共用 main-only sidecar vault/journal，generic settings 拒绝 secret 读回，模型列表不再传 apiKey，普通/历史备份完成脱敏策略。
- 写 proof 保留、pageRanges 违约、结果 URL 延迟、乱序校对保存和版本覆盖的失败行为测试。
- 删除所有 OCR 前清空校对逻辑；版本切换保留校对。
- 修正异步结果 pending 状态机和 phase 条件。
- pageRanges 结果不满足 manifest 时零写入。
- 暂不增加并发，也不更换模型。

### 阶段 B：统一 run/attempt 与 staging

- 复用模块 02 `task_jobs/task_items`，增加 OCR 专属 run/attempt/artifact 表。
- 现有每个 OCR IPC 先转为创建 run，再由 adapter 执行。
- 保存改 staging -> validate -> page transaction activate。
- `pages` 和 `page_ocr_versions` 作为兼容投影双写并做一致性校验。
- 迁移前自动备份、schema probe、可重入 migration、失败回滚和旧库样本演练。

### 阶段 C：取消、恢复与全局资源预算

- vision、local、图片准备、后处理和保存全链传递 AbortSignal。
- legacy batch API 转发到统一 scheduler，删除第二套物理执行器。
- 全局令牌控制网络、CPU、本地 worker、数据库写和单文档窗口。
- 队列 busy 改持久 `next_attempt_at`，支持 Retry-After、jitter、服务 cooldown 和公平调度。
- 任意数量任务只增加数据库行，不线性增加 renderer/main 内存。

### 阶段 D：内存与性能

- JSONL 边读、边校验、边写 staging。
- PDF 文本层预检 worker 化、采样优先、页级缓存。
- 文档 IR 增量化和有限跨页窗口。
- 本地 Paddle 常驻受控 worker，模型只加载一次。
- 用固定硬件和固定语料建立基线后再决定异步 PDF 是否允许多 chunk 并发。

### 阶段 E：质量、校对和可观察性

- 建立古籍竖排、报纸、多栏论文、表格、公式、扫描噪声、原生 PDF 的金标集。
- 记录 CER/WER、表格 cell F1、版面 block IoU、阅读顺序、坐标覆盖、空页误报和人工修改距离。
- 低置信度/空页/坐标异常进入审查队列。
- 校对 revision、OCR artifact diff、三方合并和按页回滚。
- 任务中心展示真实 run、attempt、成本、时延、服务状态和恢复动作。

### 阶段 F：安全与隐私

- 复核阶段 A 的 CredentialVault、历史备份处理和 secret scanner，不再在此重复建设第二套密钥存储。
- 日志默认元数据化、原文诊断 opt-in、TTL/容量/清理/备份排除。
- 外部 OCR 与视觉服务显示页面范围、服务商和授权。
- 隐私模式可强制只用原生文本层和已批准的本地 OCR。

## 8. 新版验收方案

| 编号 | 目标成品行为 | 自动化/故障场景 | 兼容要求 |
| --- | --- | --- | --- |
| OCR-01 | 任意 OCR 重跑、版面重做、版本切换失败或取消都不改变人工校对 | 提交失败、结果下载失败、保存中强退、切换取消 | 旧 `proofed_text` 字节和引用完全不变 |
| OCR-02 | 目标页 `[3,5]` 只能激活原 PDF 第 3、5 页 | 服务遵守、忽略、返回全书、少页、多页、乱序 | 契约不满足明确失败且零激活 |
| OCR-03 | 同一引擎重复 10 次产生 10 个可追溯 artifact，可比较和回滚 | 模型/prompt/参数变化、历史删除、当前版本保护 | `pages` 始终投影当前 active |
| OCR-04 | 结果完成但 URL 延迟时进入 `result_pending`，在 grace 内继续等待 | success 无 URL、100% 非 final、有 URL 非 final、超时 | phase、按钮和恢复动作一致 |
| OCR-05 | queue full/429 不占用睡眠中的提交槽，遵守 Retry-After 与 jitter | 连续 240 次繁忙、服务恢复、多任务公平性 | 旧任务不丢失，可手动立即重试 |
| OCR-06 | 任意数量文献可留库排队，活跃 Promise、请求、内存和写事务有明确上限 | 1、1000、10 万任务；大文献与小单页混合 | 用户设置控制预算，不控制总任务数 |
| OCR-07 | cancel 在规定时间内终止 Paddle、vision、local、图片准备和后处理 | 上传、轮询、sleep、本地卡死、DB busy 时取消 | 已提交 artifact 保留，未提交无副作用 |
| OCR-08 | 重启只恢复 lease 过期且未提交 attempt，不重复已激活页 | 每个阶段强退、重复启动、时钟漂移 | 旧 batch queue 可迁移、可回滚 |
| OCR-09 | 单页激活是短事务，partial run 能精确说明新旧版本分布 | 第 50/51 页之间强退、单页校验失败 | 失败页继续显示旧 active |
| OCR-10 | 古籍、报纸、论文、表格和原生 PDF 在固定金标集上有可比较质量指标 | 多模型/多参数盲测、坐标/阅读顺序评估 | 不以单一文类优化破坏另一类 |
| OCR-11 | 空结果、真实空白页和图片页被准确区分 | 0 block、纯图、服务空 JSON、解析异常 | 空页不再默认得到健康分 |
| OCR-12 | 大 PDF 不被预检和 IR 重复整本 hydrate | 1000/5000 页、缓存 8 文献、取消 | 峰值 RSS、event-loop delay 有发布阈值 |
| OCR-13 | 本地 OCR 模型只加载有限次，worker 卡死可杀死重建 | 连续 100 页、崩溃、超时、坏 stdout | runtime/model 仍不进默认 Release |
| OCR-14 | 除用户当前输入草稿外，renderer、普通备份和普通日志不包含三类明文凭据或整页原文 | SQLite/WAL 扫描、IPC/表单捕获、Paddle/视觉模型列表、历史与新备份解包、日志容量 | vault 跨存储故障只留下完整旧/新状态，迁移失败可恢复旧库 |
| OCR-15 | 搜索、阅读、AI、翻译和导出对同一页使用相同 canonical text | 有校对、切换 OCR、校对基线变化 | 旧页面字段继续可读 |
| OCR-16 | 校对保存失败可见且可重试，自己的保存回显不清空 undo/redo | false 返回、异常、乱序 response、保存后 undo/redo | 本地草稿不丢，revision 单调 |
| OCR-17 | block 拆分和旧坐标经过保存、重载、IR 重建后几何不变 | xywh/xyxy/polygon、竖列拆分、叠块拆分 | 原始坐标和推断来源可追溯 |
| OCR-18 | PDF 页图请求永不把最后一页冒充越界页 | DB 11 页/PDF 10 页、损坏图片、并发失败重试 | 越界明确失败，旧缓存可诊断清理 |
| OCR-19 | hybrid 页面改一个字后视觉校正、warnings、TOC 和 provenance 仍完整 | TextEditor、Guji、版本切换后编辑 | 校对只写 proof layer，不覆盖 artifact |
| OCR-20 | OCR 校对和异常状态可用键盘及辅助技术完成 | Tab/Enter/Space/Escape、aria-live、长页性能 | 鼠标路径保持，减少动效设置生效 |

性能阈值必须先测当前基线再定。首轮发布门槛至少包括：任务运行时 renderer 心跳不被 OCR 主线程长任务阻塞；活跃请求和本地 worker 不超过全局预算；取消时延、峰值 RSS、首个可用页时延和每页吞吐可重复测量。不得在没有固定硬件和语料时承诺虚假百分比。

### 8.1 现有测试处置

- **保留**：IR、去重、坐标、PDF 文本层、OCR 恢复、启动恢复和真实 Electron 阅读链行为测试。
- **修复**：`ocr-pdf-resume-regression` 的 mock 必须读取 `pageRanges`；`ocr-async-pdf-complete-pending-regression` 改为 fake clock 状态机测试。
- **降级为结构守卫**：progress、upload、result-save、batch-save、facsimile、reading-order 等源码字符串测试可以保留，但不能单独作为功能通过证据。
- **新增**：proof 保留、artifact 历史、staging 激活、错页 fail-closed、vision/local cancel、服务 cooldown、公平调度、无限任务有界资源、大 PDF RSS、日志/密钥脱敏、乱序校对保存和跨模块 canonical text。
- **不得删除**：现有飞桨分片回退、原生文本层、古籍竖排、表格、局部重识别、坐标兼容、搜索标脏和启动恢复回归。

## 9. 新功能建议

### 9.1 OCR 异常审查队列

**MVP：** 按页列出低置信度、空结果、坐标越界、可疑重复、page mapping 不确定和人工校对基线变化，支持筛选、批量重跑、忽略和确认。

**实现影响：** 直接读取 artifact quality 和 attempt error，不复制正文；队列分页并复用统一任务中心。

**验收与回退：** 关闭功能不改变 OCR；忽略只写审查状态；每条异常能回到原图坐标。无需新依赖。

### 9.2 OCR 版本对比、按页回滚与校对三方合并

**MVP：** 对比旧 OCR、新 OCR 和人工校对，按字符与 block 显示差异，支持逐块接受和一键回滚。

**实现影响：** 依赖 immutable artifact 和 proof base hash；第一版使用现有文本 diff 能力或小型自有算法。若引入新的 diff 依赖，实施前确认许可证和包体。

**验收与回退：** 回滚只切 active 指针，不删除历史；合并失败保留草稿；坐标块和纯文本都可处理。

### 9.3 可复现 OCR 配方

**MVP：** 保存“引擎、模型、prompt、图像缩放、JPEG 质量、古籍 profile、二次识别、后处理版本”的命名配方，可在选定页预演再批量应用。

**实现影响：** 配方是版本化 JSON，可先存 settings；run 永久保存实际展开后的 snapshot，避免后来修改配方影响历史解释。

**验收与回退：** 同一输入与同一配方能复现相同请求参数；删除配方不删除历史 run。无需新依赖。

### 9.4 自适应引擎路由与成本预估

**MVP：** 根据原生文本层、页面方向、扫描质量、表格/公式、隐私模式和历史质量，在 Paddle、vision、hybrid、local 间给出可解释建议；默认由用户确认。

**实现影响：** 只用本地特征和历史 metrics，不自动上传抽样页。自动路由作为后续 opt-in。

**验收与回退：** 每页记录路由原因、预计费用和最终质量；关闭后回到用户固定引擎。任何新模型或服务实施前确认。

### 9.5 OCR 基准实验室

**MVP：** 用户导入少量金标页，比较不同配方的文字、表格、版面、坐标、耗时和费用，生成本地报告。

**实现影响：** 复用 artifact 和 metrics；金标默认只保存在本地，不进入开源仓库或云端。

**验收与回退：** 相同数据集结果可复跑；报告记录软件、pipeline、模型和语料版本。无需新依赖。

### 9.6 隐私优先离线模式

**MVP：** 强制禁用所有外部 OCR/视觉请求，只允许原生 PDF 文本层和已安装本地 OCR；任务创建时即校验，不到执行中途才失败。

**实现影响：** 复用现有 local Paddle 和设置合同；界面明确哪些功能会外发。

**验收与回退：** 网络抓包下零 OCR 外发；关闭模式后恢复原配置但不自动启动旧云任务。新增本地模型仍需确认。

### 9.7 OCR 运行检查器

**MVP：** 单页展示 source fingerprint、chunk/pageRanges、服务 request ID、模型、耗时、重试、坐标基准、quality、active/proof 关系和恢复动作。

**实现影响：** 只显示结构化 provenance，默认隐藏原文和 secret；可导出脱敏诊断包。

**验收与回退：** 任一错页或失败都能定位到 run/attempt；诊断包通过 secret/原文扫描。无需新依赖。

## 10. 依赖、迁移与审批

- 阶段 A 可以完全使用现有 TypeScript、Electron、better-sqlite3、AbortController、streams 和测试工具完成。
- `task_jobs/task_items` 复用模块 02 的统一调度结构；OCR 只增加领域表，不另建第二套 scheduler。
- `ocr_runs/ocr_page_attempts/ocr_artifact_versions` 属于收益明显的 additive migration：它们解决错页追踪、崩溃恢复、真正版本和原子激活，建议批准，但必须先自动备份、可重入、失败回滚和旧库演练。
- `safeStorage` 为 Electron 现有能力，不算新增依赖；密钥迁移复用模块 01/07 的 CredentialVault sidecar/journal，并与模块 11 的备份/恢复、历史备份脱敏方案一起实施。
- 常驻本地 runner 可先用现有 child_process 与 JSONL 协议；新的 Python runtime、OCR 模型、第三方流解析器、diff 库或云服务一律标记 **实施前需用户确认**。
- 默认安装包和公开 Release 不新增本地模型；模型下载来源、hash、许可证、大小和卸载必须可查。

## 11. 与其他模块的约束

- 导入模块只负责持久投递 OCR job，不持有整批 renderer Promise；导入完成不等于 OCR 完成。
- 文库组织模块接收 OCR/AI 元数据建议时必须保留来源、置信度和 artifact/run ID，人工标签优先。
- 模块 03 拥有 `CanonicalContentProvider.resolvePage(...) -> CanonicalPageContent` 的 active proof/OCR/source 选择；阅读器、搜索、翻译、AI 和导出统一消费该合同，不另建 canonical text provider。
- 搜索索引只在 artifact 激活或校对 revision 提交后更新；staging 结果不得进入用户检索。
- AI 目录和研究不得读取失败、未激活或未授权外发的 OCR artifact。
- 数据库备份必须同时保护 active 投影、artifact 历史、外置 payload、任务 lease 和 proof revision，并默认排除 secret/原文诊断日志。
- UI/交互模块负责 run 级任务中心、暂停/取消、异常审查、版本 diff、费用与隐私提示；完整性校验必须留在 main。
- 正式实现前先把本章 OCR-01 至 OCR-20 写入目标成品验收方案；正确性、校对保留、错页 fail-closed、可取消恢复和有界资源属于发布阻断门槛。
