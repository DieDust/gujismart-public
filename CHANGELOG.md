# 更新日志 / Changelog

## Unreleased

## 1.1.11 - 2026-07-22

### 中文

#### 修复

- **标签拖拽分组防误触**：默认仅目标标签中间 50% 建组，左右 25% 只换序。
- **Shift/Alt + 拖拽建组**：按住 Shift 或 Alt 拖动后，丢到任意未分组标签的任意位置即可建组；纯点击不会建组。
- **建组动效**：拖拽高亮、预览发光、新建分组动画，落点更清晰。
- **折叠分组参与缩放**：折叠后按折叠后的可见宽度重算密度，不再按全展开标签挤压。
- **拖到最右侧分组后**：分组左右缘可插到整组前/后，中间仍加入该组。
- **拖拽更顺滑**：预览跟手、落点指示线、拖动中避免多余 React 重渲染。

#### 下载

- `GujiSmart-1.1.11-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.11-Portable-x64.exe`：适合免安装便携使用。

### English

#### Fixed

- **Safer tab-group drag zones**: middle 50% creates a group; side 25% only reorders.
- **Shift/Alt drag-to-group**: hold modifier while dragging to group on any part of an ungrouped tab; click alone does not group.
- **Group create feedback**: target highlight, preview glow, and create animation.
- **Collapsed groups in density math**: folded groups no longer reserve expanded tab width.
- **Insert after rightmost group**: group edge zones place before/after the whole block.
- **Smoother tab dragging**: immediate preview tracking, insertion indicator, fewer re-renders mid-drag.

#### Downloads

- `GujiSmart-1.1.11-Setup-x64.exe`
- `GujiSmart-1.1.11-Portable-x64.exe`

## 1.1.10 - 2026-07-22

### 中文

#### 新增

- **PDF 补回「仅登记路径」**：设置 → PDF 原件仓库可开启；补回时不整本复制进软件目录，大书更快；清理原图仍绝不删除外部源文件。
- **OCR 错页短提示 + 鸟瞰定位**：文案形如「OCR完成，第 3、7-9 页 OCR 未成功」；鸟瞰页可筛选/跳转失败页。

#### 修复

- **OCR 单页失败不再拖垮整本**：未完成/失败页 settle 为页级复核，文献仍 `completed` 入库。
- **「先 OCR 再向量」不重跑已 OCR 书**：仅缺正文时才自动飞桨。
- **批量 OCR 连续性**：取消后槽位释放、按 `batch_size` 并发、单本墙钟超时跳过、排队与自动续跑更稳。
- **导出页码模式**：支持「文献页码 / 自然页码」，默认文献页码。
- **Toast 堆叠**：限制并发提示条数，避免刷屏。
- **豆包视觉 OCR 连接测试**：探测图改为 32×32，避免「最短边 ≥ 14 像素」导致 HTTP 400。
- **清理 OCR 原图**：仅删 `storage/{docId}/` 托管副本；链接原文/原件仓库永不删除。

#### 下载

- `GujiSmart-1.1.10-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.10-Portable-x64.exe`：适合免安装便携使用。

### English

#### Added

- **Link-only PDF restore** option (register external path, no copy); cleanup still never deletes external originals.
- **Short OCR failed-page notices** and birdseye jump/filter for failed pages.

#### Fixed

- **Page-level OCR failures no longer fail the whole document**.
- **Vectorize-after-OCR skips books that already have OCR body**.
- **Bulk OCR continuity**: cancel slot release, concurrency, per-doc wall timeout, resume.
- **Export page-number mode**: literature vs natural; literature default.
- **Toast stacking** capped.
- **Doubao vision connection test** uses a 32×32 probe image (min 14px).
- **Cleanup OCR assets** only removes managed `storage/{docId}/` files.

#### Downloads

- `GujiSmart-1.1.10-Setup-x64.exe`
- `GujiSmart-1.1.10-Portable-x64.exe`

## 1.1.8 - 2026-07-21

### 中文

#### 新增

- **智能视图增强**：可自定义显示/隐藏分类；新增未向量化、向量排队、向量化中、向量失败；可与文件夹/标签组合筛选。
- **文本向量化（当前仅正文）**：基于 OCR/校对正文建向量；「批量向量化 · 先 OCR(飞桨) 再向量」；停止队列/单本/所选；跳过已完成。
- **文内向量检索与高亮**：从向量结果进入阅读后按语义命中导航；前 3 / 后 3 字锚定整段高亮；右上角可切换「文本 / 向量」并自动重搜。
- **向量侧栏**：显示「向量命中」与相似度，不再误用关键词高亮/全文回落。
- **向量证据导出**：导出含相似度分数与中文定位标签，不误走全文检索。

#### 下载

- `GujiSmart-1.1.8-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.8-Portable-x64.exe`：适合免安装便携使用。

### English

#### Added

- **Smarter library smart views** with embedding status chips and compose filters.
- **Text embeddings + OCR→embed pipeline**, queue cancel, skip-ready.
- **In-document vector search** with paragraph highlight; reader toolbar text/vector mode switch.
- **Vector evidence export** with similarity scores and Chinese locators.

#### Downloads

- `GujiSmart-1.1.8-Setup-x64.exe`
- `GujiSmart-1.1.8-Portable-x64.exe`

## 1.1.7 - 2026-07-20

### 中文

#### 新增

- **向量库检索**：检索页独立「向量库检索」模式（与全文检索分开）；设置 →「向量索引」配置 OpenAI 兼容 Embeddings；文献库可批量向量化；MCP `vector_search` / `vector_index_stats`。
- **文献页码（印刷页）**：OCR 后按连续关系推断印刷页码；阅读页显示「影像 / 文献」页码；点文献页可手动校准并顺延；支持「重置全文」恢复自动识别；导出 TXT/MD 等优先使用文献页；普遍无页码时回退物理页 1、2、3…
- **校对删除文本块**：版式还原与普通文本校对均支持右键/按钮删除 OCR 文本块，并写回数据库。
- **复制直接引用快捷键**：默认 `Ctrl+D`（设置 → 快捷键可改）；阅读/校对选中文本后一键复制带引用格式。
- **版式还原校对**：支持划选/点块「复制原文」「复制直接引用」。
- **默认打开阅读模式**：设置项「默认使用阅读模式」默认开启；单篇手动切换的模式仍优先。

#### 修复

- **全局检索 → 打开文献 → 再点另一篇**：不再因 `last_opened_at` 误判检索快照过期而提示「请重新检索」；快照失效时自动恢复。
- **校对模式左侧无原图**：不再把双页阅读样式塞进窄栏；显示明确「本页暂无原图」并提供补 PDF / 生成页图 / 改阅读模式。
- **阅读 ↔ 校对切换**：保留当前影像页，避免进度跳回首页或首次切换需点两次。
- **期刊页脚页码**：改进 `·-63-·` / 多位印刷页识别，减少默认显示成个位数的问题。

#### 下载

- `GujiSmart-1.1.7-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.7-Portable-x64.exe`：适合免安装便携使用。

### English

#### Added

- **Vector search mode** separate from full-text; embeddings settings; batch vectorize; MCP `vector_search` / `vector_index_stats`.
- **Literature (printed) page numbers** with continuity inference, manual calibrate/reset, reading chrome labels; exports prefer literature pages; sparse anchors fall back to physical 1..N.
- **Proof block delete** in facsimile and text proof modes (persisted to DB).
- **Copy direct-quote shortcut** default `Ctrl+D` (configurable in Settings → Shortcuts).
- **Facsimile proof**: copy plain text / direct citation from selection or block.
- **Prefer read mode on open** setting (default on); per-document manual mode still wins.

#### Fixes

- **Search return flow**: opening a document no longer invalidates the search snapshot via `last_opened_at`; soft-recover when snapshots expire.
- **Proof left pane without image**: clear empty state instead of dual-page reading chrome crammed into the side panel.
- **Read ↔ proof switch**: keep the current source page; avoid first-switch bounce.
- **Journal footer page labels**: better multi-digit / dotted footer extraction.

#### Downloads

- `GujiSmart-1.1.7-Setup-x64.exe`
- `GujiSmart-1.1.7-Portable-x64.exe`

## 1.1.6 - 2026-07-18

### 中文

#### 修复

- **Codex / Windows MCP 连不上**：修复在 Windows 上将完整 Electron 进程直接作为 MCP 时 stdin 立即断开、导致「正在重新连接」、工具列表为空的问题。现改为 `ELECTRON_RUN_AS_NODE` + `mcp-host.cjs` 宿主，一键写入 Codex 配置会带上必要环境变量。
- 设置页 Codex 表单对照补充环境变量说明；打包产物包含 MCP 宿主脚本。

#### 改进

- **MCP 默认返回精简（compact）**：检索结果默认只返回标题、页码、短摘录与 `ref{docId,pageNum}`，不再默认灌入 locator/hash 等机读字段，减少 AI 上下文噪音；需要完整定位时传 `detail:"full"`。桌面端界面检索不受影响。

#### 下载

- `GujiSmart-1.1.6-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.6-Portable-x64.exe`：适合免安装便携使用。

### English

#### Fixes

- **Codex / Windows MCP disconnect**: Fixed stdin closing immediately when the full Electron app was used as an MCP server on Windows (endless reconnect, empty tool list). MCP now runs via `ELECTRON_RUN_AS_NODE` + `mcp-host.cjs`; one-click Codex config writes the required env vars.
- Codex form map documents env vars; packages ship the MCP host script.

#### Improvements

- **Compact MCP responses by default**: search hits return title, page, short excerpt, and `ref{docId,pageNum}` without locator/hash blobs; use `detail:"full"` for full locators. Desktop UI search is unchanged.

#### Downloads

- `GujiSmart-1.1.6-Setup-x64.exe`
- `GujiSmart-1.1.6-Portable-x64.exe`

## 1.1.5 - 2026-07-17

### 中文

#### 新增

- **AI 工具连接（小白向）**：设置 →「AI 工具连接」可切换 **Trae（默认）/ Cursor / Claude / Codex / 其他**；JSON 客户端一键复制 MCP 配置，Codex 支持一键写入配置或手动表单对照（名称 / STDIO / 启动命令 / 参数）。
- Headless MCP：本机 Agent 可不打开界面只读检索文献库（`library_search` 等工具）。见设置页与 `docs/MCP.md`。

#### 下载

- `GujiSmart-1.1.5-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.5-Portable-x64.exe`：适合免安装便携使用。

### English

#### Added

- Beginner-friendly **AI tool connection** in Settings with a client switcher (**Trae** default / Cursor / Claude / Codex / Other): copy MCP JSON for JSON clients; Codex one-click config write or form field map (name / STDIO / command / args).
- Headless MCP for read-only library access without opening the UI. See Settings and `docs/MCP.md`.

#### Downloads

- `GujiSmart-1.1.5-Setup-x64.exe`
- `GujiSmart-1.1.5-Portable-x64.exe`

## 1.1.4 - 2026-07-17

### 中文

#### 新增

- **AI 工具连接（MCP）**：设置里「AI 工具连接」一键开关 + **一键复制配置**；AI 客户端用本机程序 `--mcp` 只读访问文献库，**不必打开界面、不必手填盘符**。见设置页与 `docs/MCP.md`。

#### 改进

- 修正飞桨多 Token 对 HTTP 429 的误判：接口返回「请求频率过高」时只做短时限流冷却（约 90 秒），不再标成「今日额度已用完」并整天禁用该 Token。
- 真正的单日页数/额度耗尽与限流分开处理；升级后会清理此前误存的「假额度」记录。
- 继续减轻 OCR 写库与批量删除对主进程的阻塞：payload 先落盘再短事务、删除分批分片并让出事件循环，降低点设置/列表时的未响应概率。

#### 下载

- `GujiSmart-1.1.4-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.4-Portable-x64.exe`：适合免安装便携使用。

### English

#### Added

- **AI tool connection (MCP)**: Settings → “AI 工具连接” with enable switch and one-click copy config. Clients launch the app with `--mcp` for read-only library access without opening the UI or hand-editing drive letters. See Settings and `docs/MCP.md`.

#### Improvements

- Fixed multi-token Paddle OCR mishandling of HTTP 429: rate-limit responses (“too many requests”) now cool down for about 90 seconds instead of being marked as daily quota exhausted for the rest of the day.
- Daily page/credit exhaustion and temporary rate limiting are classified separately; false “quota exhausted” runtime marks from earlier builds are cleared on upgrade.
- Further reduced main-process freezes during OCR saves and bulk deletes via short SQL transactions, batched deletes, and deferred WAL checkpoints.

#### Downloads

- `GujiSmart-1.1.4-Setup-x64.exe`
- `GujiSmart-1.1.4-Portable-x64.exe`

## 1.1.3 - 2026-07-17

### 中文

#### 改进

- 重写启动 OCR 恢复逻辑：打开时只重置明确中断的 `queued/processing` 状态，不再对全库 `pages` 做正文内容扫描与批量重写，避免大库存启动后长时间“未响应”、磁盘占满。
- 启动恢复不再自动续跑批量 OCR / 导入自动 OCR；未完成任务保持排队，需用户手动继续，避免打开瞬间磁盘打满。
- 搜索索引恢复改为仅处理本轮已触碰的文献 ID，避免打开路径上的全库正文谓词扫描。
- 大幅减轻写库/删除卡主进程：OCR 结果先写 payload 文件再做短事务；删除按小批次与小行块推进并让出事件循环；推迟 WAL checkpoint。
- OCR 队列调度改为有界 worker 池，按并发分波领取任务；大批量续跑不再一次挂起上百个 Promise 或对每篇文献做重 SQL。
- 单篇/全部取消 OCR 会同步清理持久化队列，避免“点了取消仍被续跑”。
- 文献库列表在数据库忙碌时保留已有数据并自动重试，不再误显示“还没有文献”。
- 正在 OCR 的文献在列表刷新后仍会显示进度条。

#### 下载

- `GujiSmart-1.1.3-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.3-Portable-x64.exe`：适合免安装便携使用。

### English

#### Improvements

- Rewrote startup OCR recovery to only reset clearly interrupted `queued/processing` rows instead of full-table page content scans/rewrites that froze large libraries on open.
- Startup recovery no longer auto-starts batch OCR / import-auto OCR; unfinished work stays queued until the user continues, preventing disk saturation right after open.
- Search-index recovery is limited to document IDs touched in the current recovery pass, avoiding full-library content predicates on the open path.
- Reduced freezes during library writes/deletes: OCR payload files are prepared outside short SQL transactions; deletes advance in small document/row batches with event-loop yields; WAL checkpoints are deferred.
- OCR scheduling now uses a bounded worker pool and concurrency-sized claim waves so large resume queues no longer hang the main process.
- Cancel OCR now clears persisted queue rows so canceled work is not revived after restart.
- Library list keeps existing data and retries on transient database busy/timeout instead of showing a false empty library.
- Active OCR documents keep a progress bar after list refresh.

#### Downloads

- `GujiSmart-1.1.3-Setup-x64.exe`
- `GujiSmart-1.1.3-Portable-x64.exe`

## 1.1.2 - 2026-07-17

### 中文

#### 新增

- 飞桨云端 OCR 支持配置多个 API Token。用户可设置主 Token、启用或停用备用 Token，并查看各 Token 的可用、限额或失效状态；额度耗尽或凭证失效时会自动切换到下一枚可用 Token。
- 大型 PDF 的异步 OCR 支持按失败分段续跑：已完成的分段不会重复识别，仅重试失败或结果异常的部分，兼顾处理速度、额度消耗与结果完整性。
- 单页重新 OCR 增加“顺时针旋转后识别”，适合横置表格和横向页面；识别结果会映射回原始页面坐标，继续兼容校对与版式还原。

#### 改进

- 优化数百页、数百 MB PDF 的导入与保存流程：不再于异步 PDF OCR 前预先生成全部页面图片，并将结果保存、结构整理和质量检查拆成小批次执行，减少长时间停在 0%、界面无响应和保存阶段卡顿。
- 优化首次启动和文献库加载：延后后台恢复任务、放宽大型文献库加载超时并为瞬时失败增加重试，降低首次进入空白、加载错误或切换页面后才恢复的概率。
- 新文献或没有阅读偏好记录的文献默认进入版式还原模式；已有用户明确保存的阅读模式偏好保持不变。
- 修正横置真实表格可能被异步 PDF OCR 的异常结果检测误判、导致单页 OCR 回退失败的问题，同时保留可疑重复内容的质量保护。
- OCR Token 继续由主进程安全保存，旧版单 Token 设置可直接升级，无需迁移数据库或重新导入文献。

#### 下载

- `GujiSmart-1.1.2-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.2-Portable-x64.exe`：适合免安装便携使用。

### English

#### Added

- Paddle cloud OCR now supports multiple API tokens. Users can select a primary token, enable or disable fallbacks, inspect token status, and automatically rotate when a token is exhausted or invalid.
- Large-PDF asynchronous OCR can resume by failed segment: completed segments are preserved while only failed or suspicious parts are retried, reducing repeated work and quota usage without sacrificing completeness.
- Single-page OCR now offers clockwise-rotated recognition for sideways tables and landscape content, with coordinates mapped back to the original page for proofreading and facsimile rendering.

#### Improvements

- Optimized import and persistence for PDFs with hundreds of pages or hundreds of megabytes. Page images are no longer generated up front for asynchronous PDF OCR, and saving, structure processing, and quality checks yield in small batches to reduce frozen progress and interface stalls.
- Improved first launch and library loading by delaying background recovery, allowing more time for large libraries, and retrying transient failures.
- New documents, or documents without a saved reader preference, now open in facsimile mode by default; explicitly saved preferences remain unchanged.
- Fixed genuine sideways tables being rejected by the asynchronous PDF OCR anomaly detector and then failing single-page fallback, while retaining protection against suspicious repeated output.
- Paddle OCR credentials remain securely stored in the main process. Existing single-token settings upgrade directly without a database migration or document re-import.

#### Downloads

- `GujiSmart-1.1.2-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.1.2-Portable-x64.exe` for portable use.

## 1.1.1 - 2026-07-13

### 中文

#### 改进

- 优化阅读模式“上一处/下一处”检索定位，降低同页和跨页连续切换的停顿，并保持完整命中、当前页优先和正确阅读顺序。
- 修复版式还原模式的关键词高亮、当前页起始与回车确认检索，并修正全库检索的文献数量、命中数量和分页说明。
- 优化批量文献与文件夹删除反馈：界面先移除项目，数据库与索引清理在后台继续，减少大批量删除时的卡顿。
- 新安装默认关闭“OCR 后自动 AI 分析”，需要时可在设置中手动开启；已有用户明确保存的设置保持不变。

#### 下载

- `GujiSmart-1.1.1-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.1-Portable-x64.exe`：适合免安装便携使用。

### English

#### Improvements

- Optimized Previous/Next reader search navigation to reduce pauses across same-page and cross-page matches while preserving complete results, current-page priority, and reading order.
- Fixed keyword highlighting, current-page start, and Enter-to-search behavior in facsimile mode, and corrected document counts, hit counts, and pagination text in library-wide search.
- Improved bulk document and folder deletion feedback: items disappear from the interface first while database and search-index cleanup continues in the background.
- New installations now keep “Automatically run AI analysis after OCR” disabled until the user enables it; explicitly saved settings for existing users remain unchanged.

#### Downloads

- `GujiSmart-1.1.1-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.1.1-Portable-x64.exe` for portable use.

## 1.1.0 - 2026-07-12

### 中文

#### 新增

- 新增可恢复的持久任务调度、稳定阅读定位、搜索快照与研究证据谱系，为大批量导入、OCR、检索、翻译和 AI 研究提供统一的状态与追溯能力。
- 新增 AI OCR 服务商配置管理和真实图片连接测试；只有测试成功且 URL、模型、API Key 均未变化的配置才能保存、切换、设为默认或执行 OCR。
- 新增引用快照、导出快照、研究输出版本、翻译修订与冲突保护，降低后台结果覆盖人工修改或正式研究成果失去来源的问题。
- 新增本地 RC 证据、SPDX SBOM、vendor 文件哈希清单和 packaged smoke，为后续开源发布提供可复核材料。

#### 改进

- 批量导入改为按用户设置的并发数量持续补位处理，队列可容纳大量文件，并强化中断恢复、授权恢复和进度一致性。
- OCR 结果使用不可变产物和唯一正文解析链路，优先保护人工校对；改进整本 PDF 双栏文本层、纵横排阅读顺序、坐标、图片和表格数据的兼容性。
- 改进文献批量删除、多选取消、文件夹与标签管理、工作区恢复和阅读器定位，减少大批量操作卡顿及交互状态意外退出。
- 改进设置与凭据安全，API Key 仅由主进程安全存储，备份、日志、IPC 和渲染进程不再暴露明文密钥。
- 改进全库/全文检索、研究证据、翻译、引用和导出的版本化与原子写入，增强结果稳定性和可追溯性。

#### 调整

- 暂停本地 PaddleOCR 功能。当前继续使用飞桨云端 OCR 或通过测试的 AI OCR，以确保坐标、图片和表格能力完整。
- 本版本可直接从 GitHub Release 升级；继续兼容原有数据库和文献目录，首次启动后会在后台恢复未完成任务，无需手动迁移数据。

#### 下载

- `GujiSmart-1.1.0-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.0-Portable-x64.exe`：适合免安装便携使用。

### English

#### Added

- Added a recoverable persistent task scheduler, stable reader locators, search snapshots, and research evidence lineage for consistent state and traceability across large imports, OCR, search, translation, and AI research.
- Added AI OCR provider management with a real image connection test. A configuration can only be saved, activated, selected as default, or used for OCR after a successful test, and any URL, model, or API key change invalidates that result.
- Added citation snapshots, export snapshots, research output versions, translation revisions, and conflict protection to prevent background results from overwriting manual work or detaching formal research outputs from their sources.
- Added local RC evidence, an SPDX SBOM, bundled-vendor file hashes, and packaged smoke testing for later open-source release review.

#### Improvements

- Changed bulk import to continuously refill the user-configured concurrency window, support large queues, and improve interruption recovery, authorization recovery, and progress consistency.
- Moved OCR results to immutable artifacts and a single canonical content path that protects manual proofreading, with improved compatibility for whole-PDF two-column text layers, mixed reading directions, coordinates, images, and tables.
- Improved bulk document deletion, selection toggling, folder and tag management, workspace restoration, and reader positioning to reduce freezes and unexpected interaction exits during large operations.
- Hardened settings and credential storage so API keys remain main-process-only and are not exposed through backups, logs, IPC payloads, or renderer state snapshots.
- Improved versioning and atomic persistence for library/full-text search, research evidence, translation, citation, and export results.

#### Changes

- Temporarily retired local PaddleOCR. Cloud PaddleOCR or a successfully tested AI OCR provider should be used to retain coordinate, image, and table support.
- This release can be installed directly from GitHub Releases. Existing databases and document directories remain compatible, and unfinished tasks resume in the background after startup without a manual data migration.

#### Downloads

- `GujiSmart-1.1.0-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.1.0-Portable-x64.exe` for portable use.

## 1.0.9 - 2026-07-03

### 中文

#### 新增

- 新增浏览器式标签页分组管理：右键标签页可关闭所有标签页、关闭其他标签页、新建分组并加入、移动到已有分组、关闭分组、取消分组。
- 新增标签页分组设置面板，支持修改分组名称、选择分组颜色、展开/折叠分组、在组内添加首页标签页，并用分组色条和分组胶囊在标签栏中区分不同分组。
- 新增标签页分组拖拽逻辑：拖入分组可直接加入，拖出分组会自动脱离，把两个未分组标签拖到一起会自动建立新分组；在选中分组内打开的新页面会自动继承该分组。
- 新增标签栏空白处“重新打开刚关闭的标签页/分组”，关闭整组后可像浏览器一样恢复。

#### 改进

- 改进工作区恢复，保存并恢复标签页分组、分组颜色、折叠状态和标签归属，减少重启后工作上下文丢失。
- 改进标签栏在大量标签和分组场景下的压缩、拖拽反馈和视觉连贯性，让分组边界更清晰且减少突兀高亮。
- 改进 OCR、导入、搜索索引和 AI 研究等后台任务状态，统一进度状态封装并记录 OCR 运行元数据，便于排查任务卡住、重跑或失败原因。
- 改进 AI、研究、引用、搜索、备份和设置链路的结构化校验：新增 AI 响应封装、研究完整性报告、引用字段解析诊断、搜索索引健康诊断、备份完整性报告和配置校验。
- 改进元数据标签同步保护，降低自动清理标签关系时误删手动标签绑定的风险。
- 扩展开源回归检查，覆盖函数契约、模块分层、状态封装、配置校验、OCR 运行元数据、搜索证据、备份完整性和研究完整性。

#### 修复

- 修复古籍 OCR 重新识别后，PaddleOCR 已返回的插图/图片块在保存阶段被当成纯文本占位内容清理，导致版式还原和阅读模式看不到图片的问题。
- 修复古籍 OCR 文本清理时把带 `<img>` 的 markdown 结果重建为纯文本的问题，保留 OCR 返回的图片引用、坐标和后续本地图片资产生成链路。
- 修复/加固部分后台任务在异常状态下只返回散乱错误信息的问题，让导入、OCR、搜索索引、AI 研究等状态更容易被前端和回归测试一致处理。

#### 下载

- `GujiSmart-1.0.9-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.0.9-Portable-x64.exe`：适合免安装便携使用。

### English

#### Added

- Added browser-like tab group management: right-click a tab to close all tabs, close other tabs, create a new group, move into an existing group, close a group, or ungroup tabs.
- Added a tab group settings panel with group renaming, color selection, expand/collapse controls, adding a home tab inside a group, and clearer group chips/color bars in the tab strip.
- Added richer tab group drag behavior: drag a tab into a group to join it, drag it out to ungroup it, drag two ungrouped tabs together to create a group, and open new pages inside the currently active group.
- Added “reopen recently closed tab/group” from the blank tab-strip area, including restoring a whole closed group.

#### Improvements

- Improved workspace restore so tab groups, colors, collapsed state, and tab membership are preserved across restarts.
- Improved tab-strip compression, drag feedback, and grouped-tab visuals for large numbers of tabs and groups.
- Improved background task status for OCR, import, search indexing, and AI research with shared status envelopes and OCR run metadata for easier diagnosis.
- Improved structured validation across AI, research, citation, search, backup, and settings with AI response envelopes, research integrity reports, citation field diagnostics, search-index health diagnostics, backup integrity reports, and config validation.
- Improved metadata-tag synchronization safeguards to reduce the risk of removing manual tag bindings during automated cleanup.
- Expanded open-source regression coverage for function contracts, module layering, status envelopes, config validation, OCR run metadata, search evidence, backup integrity, and research integrity.

#### Fixes

- Fixed a Guji OCR re-recognition issue where PaddleOCR-returned illustration/image blocks were treated as plain placeholder text during persistence, so layout restoration and reading mode no longer showed images.
- Fixed Guji OCR text cleanup replacing image-bearing markdown with plain text, preserving OCR-returned image references, coordinates, and the downstream local image asset path.
- Hardened task status/error handling so import, OCR, search indexing, and AI research states can be handled consistently by the UI and regression checks.

#### Downloads

- `GujiSmart-1.0.9-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.0.9-Portable-x64.exe` for portable use.

## 1.0.8 - 2026-06-30

### 中文

#### 改进

- 改进整本 PDF 异步 OCR 的坐标保存方式，优先保留 PaddleOCR 返回的每页坐标尺寸，减少版式还原、校对和源图叠加时的上下偏移。
- 优化整本 OCR 结果回写流程，保存阶段不再为了坐标兜底批量渲染缺失页面图，恢复大文件异步 OCR 的快速处理路径。
- 补充 OCR 坐标与异步 PDF 上传回归检查，防止后续修改重新引入坐标漂移或整本 OCR 保存变慢的问题。

#### 修复

- 修复整本异步 OCR 后 OCR 块在部分文献中整体上移或下移的问题。
- 修复整本 OCR 完成后结果保存阶段额外生成大量页面图，导致看起来像上传或 OCR 过程从十几秒变成数分钟的问题。

#### 下载

- `GujiSmart-1.0.8-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.0.8-Portable-x64.exe`：适合免安装便携使用。

### English

#### Improvements

- Improved coordinate persistence for whole-PDF asynchronous OCR by preserving PaddleOCR's per-page coordinate dimensions, reducing vertical drift in layout restoration, proofing, and source-image overlays.
- Optimized whole-document OCR result saving so missing local page images are no longer rendered in bulk during persistence, restoring the fast asynchronous PDF OCR path for larger files.
- Added OCR coordinate and asynchronous PDF upload regression checks to guard against future coordinate drift and save-time slowdowns.

#### Fixes

- Fixed OCR blocks shifting upward or downward after whole-document asynchronous OCR on some documents.
- Fixed an OCR result-save regression that generated many page images after whole-PDF OCR, making upload/OCR appear to take minutes instead of seconds.

#### Downloads

- `GujiSmart-1.0.8-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.0.8-Portable-x64.exe` for portable use.

## 1.0.7 - 2026-06-27

### 中文

#### 改进

- 优化整本 PDF 异步 OCR 的上传、回写和状态统计流程，减少整本处理时出现缺页、空白页、重复重试或结果未正确落库的情况。
- 调整 OCR 结果保存逻辑，尽量保留飞桨 OCR / PaddleOCR 返回的页码、文本块和坐标信息，减少保存阶段对坐标或正文的额外改写。
- 改进古籍 OCR 的异常内容拦截和阅读方向处理，减少纵排正文被误并入表格、横排块或无关内容的情况。
- 改进重新 OCR 与失败页补救流程，异常页会记录到任务状态中，便于继续补跑和排查。
- 改进翻译模式和整本翻译：按 OCR 块保存译文，翻译模式再次打开时可复用已有译文，并支持在检索中搜索译文内容。
- 版式还原翻译改为在原 OCR 块位置显示译文，关闭翻译模式后恢复原文显示。
- 改进标签页拥挤时的压缩显示，打开较多页面时仍尽量保留在可视区域内。
- 补充首页文件夹入口、文件夹页框选多选和工作区恢复等体验调整，这些改动随 1.0.7 一并进入公开发行版。
- 改进 PDF 原图、页图资源加载与后台任务关闭流程，降低重启、退出或删除文献时的状态残留。

#### 修复

- 修复已定位的整本 OCR 回写问题，包括部分页面缺失、失败状态不准确、任务进度回跳、重复补跑和无关识别内容混入正文。
- 修复部分纵排古籍页面被误判为表格或局部横排后影响正文阅读顺序的问题。
- 修复文献删除后搜索索引残留可能导致删除失败、检索异常或库状态不一致的问题。
- 修复翻译模式下版式还原显示为额外译文页，而不是替换原 OCR 块的问题。
- 修复关闭或退出应用时，OCR、批处理、导入、删除、翻译等后台任务可能在数据库关闭后继续写入的问题。

#### 下载

- `GujiSmart-1.0.7-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.0.7-Portable-x64.exe`：适合免安装便携使用。

### English

#### Improvements

- Improved whole-PDF asynchronous OCR upload, persistence, and status accounting to reduce missing pages, blank pages, repeated retries, and unsaved page results during full-document runs.
- Adjusted OCR persistence to preserve page numbers, text blocks, and coordinates returned by PaddleOCR as much as possible, reducing extra coordinate or text rewriting during save.
- Improved classic-book OCR handling for anomalous content and reading direction, reducing vertical body text being merged into tables, horizontal blocks, or unrelated content.
- Improved re-OCR and failed-page recovery tracking so affected pages are recorded for follow-up processing and diagnosis.
- Improved translation mode and whole-book translation with OCR-block translation units. Saved translations can be reused when translation mode is reopened and included in translation-scoped search.
- Facsimile translation now displays translated text in place on the original OCR blocks, then restores the source text when translation mode is disabled.
- Improved crowded tab compression so more open tabs stay inside the visible area.
- Included home-folder entry, folder multi-select, and workspace restoration improvements in the 1.0.7 public release.
- Improved PDF source/page-image resource loading and background-task shutdown to reduce stale states after restart, exit, or document deletion.

#### Fixes

- Fixed identified whole-document OCR persistence issues around missing pages, inaccurate failed states, progress resets, duplicate recovery, and unrelated OCR text leaking into body text.
- Fixed some vertical classic-book pages being treated as tables or local horizontal blocks that affected the reading order.
- Fixed stale search-index entries after document deletion that could cause delete failures, search anomalies, or inconsistent library state.
- Fixed facsimile translation rendering as an extra translated page instead of replacing the original OCR blocks.
- Fixed shutdown handling so OCR, batch processing, import, delete, and translation jobs stop before the database is closed.

#### Downloads

- `GujiSmart-1.0.7-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.0.7-Portable-x64.exe` for portable use.

## 1.0.6 - 2026-06-25

### 中文

#### 改进

- 校对模式的右侧文本块列表支持拖拽重排，适合修正 OCR 在多栏、插图或复杂版式下产生的阅读顺序问题。
- 扩大文本块拖拽热区，并增加行间插入提示和拖动反馈，让手动重排更容易命中。
- 拖放后会保存当前页新的阅读顺序，并同步刷新普通阅读模式、搜索和摘录读取到的文本顺序。
- 手动顺序写入独立字段，不改 OCR 块坐标，也不影响版式还原视图的坐标排版。
- PDF 导入增加文本层预检基础能力，优先保留可用原生文本，扫描页再进入 OCR 流程。
- 阅读、搜索和纯文本导出改为使用更稳定的结构化正文流；校对编辑和版式还原仍保留原始块与坐标。

#### 修复

- 修复文本块拖拽完成后高亮可能落到目标位置原有文本块的问题；现在高亮会继续跟随被拖动的同一个文本块。

#### 发布说明

- 1.0.6 是 1.0.7 之前的过渡版本，未单独上传发行包；以上核心改动随 1.0.7 的安装版和便携版一并提供。

### English

#### Improvements

- Added drag-and-drop reordering for OCR text blocks in the proofing text list, useful for correcting reading-order issues from multi-column pages, figures, or complex layouts.
- Expanded the drag hit area with insertion hints and drag feedback so manual reordering is easier to target.
- Dropping a block saves the current page's reading order and refreshes the text order used by normal reading mode, search, and excerpts.
- Manual order is stored separately, leaving OCR block coordinates and the facsimile/layout restoration view unchanged.
- Added the foundation for PDF text-layer preflight, preserving usable native text first and sending scanned pages through OCR.
- Reading, search, and plain-text export now use a more stable structured body flow, while proofing and facsimile restoration retain original blocks and coordinates.

#### Fixes

- Fixed the active highlight after dragging a text block so it stays on the dragged block instead of the block that previously occupied the drop position.

#### Release Note

- 1.0.6 was a transitional version before 1.0.7 and was not published as a separate package. These core changes are included in the 1.0.7 installer and portable builds.

## 1.0.5 - 2026-06-23

### 中文

#### 改进

- 新增独立“文件夹”页面，支持类似资源管理器的目录树、文件夹卡片和文献封面预览。
- 支持文件夹拖拽归类与同级排序，禁止拖入自身或子文件夹，避免误操作破坏层级。
- 文件夹页面支持文献封面网格、未分类入口、滚动加载、多选拖拽和文献卡片大小调整。
- 文件夹页面支持选中文献后的批量移入文件夹、从当前文件夹移出、删除文献本体和右键操作。
- 文件夹页面新增文献排序，可按题名、导入时间、更新时间、页数、文献年代、最后打开时间排序。
- 文件夹页面拖入文件或目录时，会在当前页面原地导入并写入目标文件夹，不再跳转到文献库。
- 从文件夹页面打开文献后返回，会恢复之前选中的文件夹和滚动位置。
- 手动导出完整备份时，现在会生成单个 `.zip` 备份包，导入时可直接选择压缩包；旧版备份文件夹仍然兼容。
- 导入备份前会自动写入一份当前数据安全备份包，方便用户在导入后不满意或选错备份时再恢复。
- 设置页数据管理支持直接拖入 `.zip` 备份包导入，减少手动选择步骤；导入前仍会确认并写入安全备份包。
- 统一标签管理、引用格式、研究工作台和文件夹页面的基础视觉样式，减少内联样式并统一页面标题、卡片和拖拽反馈。

#### 修复

- 修复文件夹页面上传文件后自动切到文献库的问题。
- 修复文件夹页面打开文献再返回后回到初始页面的问题。
- 修复手动数据备份只导出文件夹、不方便转移和再次导入的问题。
- 修复文件夹拖拽反馈依赖内联边框、视觉状态不统一的问题。
- 修复部分标签批量操作入口占用顶部空间、页面操作不够清晰的问题。
- 修复安装在带空格、中文或特殊路径时，PDF 本地资源地址可能解析异常，导致原 PDF/校对原图无法加载的问题。
- 修复部分 Windows/Electron 环境下 PDF.js 把本地 PDF 协议响应识别为状态 0，导致仍然提示 `Unexpected server response (0)` 的问题；现在会自动回退到安全的文件缓冲加载。
- 修复旧 PDF 路径不可读时，校对模式直接弹出 `fs:readFileBuffer` 底层错误的问题；已有页图会继续显示，手动选择 PDF 时也会真正使用新选择的文件。
- 修复从移动硬盘、旧电脑或旧安装目录恢复整套软件数据后，数据库里的旧绝对路径导致全部 PDF 原图无法读取、自动补回失败的问题；安装版和便携版都会优先使用当前软件目录下的 `data`，不再默认迁到 C 盘 AppData。
- 修复旧 `storage/文献ID/...` 路径搬家后无法自愈的问题；打开文献、检查原图状态和补回 PDF 时会按当前库目录重新定位，并把可读的新路径写回数据库。
- 修复从校对模式切回阅读模式后，源图/版式阅读器的单页设置被重置为双页的问题；普通阅读模式和源图/版式阅读器会分别保存自己的阅读偏好。
- 修正文件夹来源状态文案：拖入电脑文件夹只会创建同名分类并导入当时的 PDF，不会绑定、扫描或自动同步后续变动；移除容易误解的“绑定磁盘目录”入口。

#### 下载

- `GujiSmart-1.0.5-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.0.5-Portable-x64.exe`：适合免安装便携使用。

### English

#### Improvements

- Added a dedicated Folders page with an Explorer-like tree, folder cards, and document cover previews.
- Added folder drag-and-drop classification and sibling ordering, with safeguards against moving a folder into itself or its descendants.
- Added document cover grids, an Unfiled entry, incremental loading, multi-select dragging, and adjustable document card sizes in the Folders page.
- Added batch actions after selecting documents in the Folders page, including move to folder, remove from current folder, delete document records, and context-menu actions.
- Added document sorting in the Folders page by title, import time, update time, page count, publication year, and last opened time.
- Dropping files or directories into the Folders page now imports them in place and assigns them to the target folder without switching to the Library page.
- Returning from a document opened through the Folders page now restores the previously selected folder and scroll position.
- Manual full backup export now creates a single `.zip` backup package that can be selected directly during import, while legacy backup folders remain supported.
- Before importing a backup, the app now automatically writes a restorable safety backup package of the current data.
- The Settings data management page now supports importing a `.zip` backup package by drag-and-drop, while still confirming the operation and writing a safety backup first.
- Unified baseline visual styling across Tags, Citation, Research, and Folders views, reducing inline styles and standardizing headers, cards, and drag feedback.

#### Fixes

- Fixed Folders page imports unexpectedly navigating to the Library page.
- Fixed returning from a document opened in the Folders page resetting the folder view to its initial state.
- Fixed manual data backup exporting only a folder, which made transfer and later import inconvenient.
- Fixed inconsistent folder drag feedback caused by inline border styles.
- Fixed unclear top-bar batch actions in Tags management by moving selected-tag actions into a floating action bar.
- Fixed local PDF resource parsing in installation paths with spaces, Chinese characters, or special characters, which could prevent the original PDF/proof image view from loading.
- Fixed a PDF.js compatibility issue in some Windows/Electron environments where local PDF protocol responses were reported as status 0 and still showed `Unexpected server response (0)`; the app now falls back to safe file-buffer loading automatically.
- Fixed raw `fs:readFileBuffer` errors when an old PDF path is no longer readable; existing page images continue to display, and manually selected replacement PDFs are now used instead of being short-circuited by stale paths.
- Fixed whole-library restores from an external drive, an old computer, or an old install directory where stale absolute paths could make all original PDFs unreadable and automatic restoration fail. Installer and portable builds now prefer the current software directory's `data` folder instead of moving the library to AppData by default.
- Fixed stale `storage/document-id/...` paths after moving a library. Document open, source-state checks, and PDF restoration now relocate managed files into the active library storage directory and write readable paths back to the database.
- Fixed source/facsimile reader single-page layout resetting to two-page layout after switching from proof mode back to reading mode. The ordinary text reader and source/facsimile reader now keep separate reading preferences.
- Clarified folder source wording: dropping a computer folder only creates a same-named category and imports the PDFs at that moment; it does not bind, scan, or auto-sync future changes. Misleading disk-binding actions were removed.

#### Downloads

- `GujiSmart-1.0.5-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.0.5-Portable-x64.exe` for portable use.

## 1.0.4 - 2026-06-21

### 中文

#### 改进

- 改进 PDF 原图与页图缓存恢复逻辑：旧缓存缺失、空文件或损坏时，会优先识别为不可用，并在源 PDF 可读时自动重建当前页图。
- 改进 PDF 本地资源路径处理，兼容中文路径、Windows 盘符以及文件名中的 `#`、`?` 等特殊字符。
- 改进阅读模式与校对模式的切换稳定性，避免异步补图、恢复阅读状态或保存状态晚到后把用户刚选择的模式抢回去。
- 改进补回 PDF 后的当前页预览恢复流程，补回后会立即缓存并显示当前页原图。
- 增强文献资源状态判断，空文件、目录路径或不可读页图不再被误判为可用原图。
- 改进安装版后台检索索引更新流程，上传或 OCR 后的索引 worker 不再依赖 Electron 主进程模块。
- 改进重新 OCR 的交互体验，整本/批量重新 OCR 不再弹出阻塞式确认框，任务会直接进入后台处理并显示非阻塞进度提示。

#### 修复

- 修复部分文献显示“有原图”但左侧原图无法加载的问题。
- 修复删除旧页图缓存后重新上传才恢复正常的缓存状态错误。
- 修复从阅读模式切到校对模式时偶发闪回阅读模式的问题。
- 修复从校对模式切回阅读模式时偶发闪回校对模式的问题。
- 修复本地 PDF 路径被错误编码后导致 `Invalid PDF url data` 的问题。
- 修复安装版上传或 OCR 后后台索引更新提示 `Cannot find module 'electron'` 的问题。
- 修复重新 OCR 确认弹窗遮挡文献库、影响继续操作的问题。
- 修复版式还原校对中，大块竖排识别区域被强制挤成单列、无法自动换列阅读的问题。

#### 下载

- `GujiSmart-1.0.4-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.0.4-Portable-x64.exe`：适合免安装便携使用。

### English

#### Improvements

- Improved PDF source and page-image cache recovery. Missing, empty, or corrupt cached page images are now treated as unavailable and rebuilt from a readable source PDF when possible.
- Improved local PDF resource URL handling for Chinese paths, Windows drive letters, and special filename characters such as `#` and `?`.
- Improved reading/proof mode switching stability so late async image repair, reader-state restore, or state-save results no longer override the mode the user just selected.
- Improved restored-PDF preview recovery so the current page is cached and shown immediately after the source PDF is restored.
- Improved source asset validation so empty files, directory paths, and unreadable page images are no longer reported as available originals.
- Improved packaged-app background search indexing so the upload/OCR index worker no longer depends on Electron main-process modules.
- Improved full-document and batch OCR rerun interaction by removing the blocking confirmation modal and using non-blocking progress messages instead.

#### Fixes

- Fixed cases where documents appeared to have original page images but the left-side original preview could not load.
- Fixed stale page-image cache state where deleting old cached images and re-uploading was required to recover.
- Fixed occasional flicker back to reading mode when switching into proof mode.
- Fixed occasional flicker back to proof mode when switching from proof mode to reading mode.
- Fixed `Invalid PDF url data` caused by incorrectly encoded local PDF paths.
- Fixed packaged uploads/OCR runs showing `Cannot find module 'electron'` during background index updates.
- Fixed the OCR rerun confirmation modal blocking the library view and preventing continued work.
- Fixed facsimile proofreading rendering where large vertical OCR regions were forced into one unreadable column instead of flowing into additional columns.

#### Downloads

- `GujiSmart-1.0.4-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.0.4-Portable-x64.exe` for portable use.

## 1.0.3 - 2026-06-20

### 中文

#### 改进

- 优化研究工作台体验，新增轻量“专题概览”，让用户更清楚研究专题、证据摘录、AI 结果和写作导出的关系。
- 优化“研究结果”页签性能，进入页签时只显示轻量摘要；提取结果和分析报告改为按需加载。
- 优化专题文献列表，长标题会自动省略并可悬停查看完整标题，避免撑出卡片。
- 优化 AI 研究结果展示，长证据和报告默认显示摘要，完整数据通过复制或导出获取。
- 优化原文补回后的 PDF/图片预览逻辑，减少“显示有原文但无法预览”的情况。
- 优化 OCR 上传、排队、状态显示和批量处理流程，减少处理状态长时间不更新的问题。
- 改进数据库治理、备份导出导入和大库状态缓存，降低大文献库下的重复刷新压力。

#### 修复

- 修复研究工作台部分页面切换卡顿、信息不清晰的问题。
- 修复研究结果页签点击后直接加载大量 AI 数据导致卡顿的问题。
- 修复专题文献标题过长时超出文本框的问题。
- 修复部分补回原文后阅读模式仍无法正常显示原图的问题。
- 修复部分导入排序、OCR 状态和原文资源识别相关的回归问题。

#### 下载

- `GujiSmart-1.0.3-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.0.3-Portable-x64.exe`：适合免安装便携使用。

### English

#### Improvements

- Improved the research workspace with a lightweight topic overview that makes the relationship between topic documents, evidence notes, AI results, and writing/export clearer.
- Improved the Research Results tab performance. The tab now opens with a lightweight summary, while extracted datasets and reports load only when requested.
- Improved the project document list so long titles are ellipsized with full titles available on hover, preventing card overflow.
- Improved AI research result rendering by showing concise previews for long evidence and reports, while full content remains available through copy/export actions.
- Improved restored-source PDF/image preview handling to reduce cases where a document appears to have source files but cannot preview them.
- Improved OCR upload, queueing, status display, and batch processing flows to reduce stale processing states.
- Improved database maintenance, backup/export/import coverage, and large-library state caching to reduce repeated heavy refreshes.

#### Fixes

- Fixed research workspace tab switching stutters and unclear empty/summary states.
- Fixed the Research Results tab loading too much AI data immediately after being opened.
- Fixed long project document titles overflowing their container.
- Fixed cases where restored source files still failed to show original page images in reading mode.
- Fixed regressions around import sorting, OCR status reconciliation, and source asset detection.

#### Downloads

- `GujiSmart-1.0.3-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.0.3-Portable-x64.exe` for portable use.

## 1.0.2 - 2026-06-15

### 中文

#### 改进

- 优化 OCR 导入与批量处理稳定性，包括队列恢复、进度显示、PDF 上传和 OCR 结果保存。
- 为旧版搜索索引用户增加数据库维护指引。
- 增加强制旧数据库维护流程：清理旧搜索索引、压缩数据库，然后在后台继续重建轻量索引。
- 优化大文献库体验，减少重复的全量侧栏/统计刷新，并改进文献库状态缓存。
- 增强数据库空间管理，提供更安全的诊断、旧索引清理、轻量索引重建和手动压缩能力。
- 加固构建工具依赖，使完整依赖审计和生产依赖审计都通过。

#### 修复

- 修复部分已有识别页的文献仍被错误计入“未识别”的问题。
- 修复旧索引已经清理后，“一键瘦身搜索索引”仍会重复触发全量重建的问题。
- 修复启动维护提示流程，旧数据库需要完成升级和压缩后再继续使用。
- 修复原文阅读图片、页面初始化、导入队列、OCR 进度、OCR 版式去重和搜索索引一致性相关回归问题。

#### 下载

- `GujiSmart-1.0.2-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.0.2-Portable-x64.exe`：适合免安装便携使用。

### English

#### Improvements

- Improved OCR import and batch processing stability, including queue recovery, progress reporting, PDF upload handling, and OCR result saving.
- Added database maintenance guidance for users upgrading from older search-index versions.
- Added a required legacy database maintenance flow that cleans old search indexes, compacts the database, and then continues lightweight index rebuilding in the background.
- Improved large-library behavior by reducing repeated full sidebar/statistics refreshes and improving cached library state handling.
- Enhanced database storage management with safer diagnostics, old-index cleanup, lightweight search index rebuilding, and manual compaction.
- Hardened build tool dependencies so both full and production dependency audits pass.

#### Fixes

- Fixed documents with existing recognized pages being incorrectly counted as unrecognized.
- Fixed repeated "one-click search index slimming" after old indexes have already been cleaned.
- Fixed startup maintenance guidance so old databases must be upgraded and compacted before continuing.
- Fixed regressions around source reader images, page initialization, import queues, OCR progress, OCR layout deduplication, and search-index consistency.

#### Downloads

- `GujiSmart-1.0.2-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.0.2-Portable-x64.exe` for portable use.

## 0.9.9 - 2026-06-11

### 中文

- 首次开源发布。

### English

- Initial open-source release.
