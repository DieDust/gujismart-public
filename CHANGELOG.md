# 更新日志 / Changelog

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
- PDF 导入增加文本层质量预检，优先保留可用原生文本，扫描页再进入 OCR 流程。
- 阅读、搜索、翻译和纯文本导出统一使用结构化正文流；校对编辑和版式还原仍保留原始块与坐标。
- 首页新增“文件夹”入口卡片，可直接进入文件夹页面，让欢迎页功能入口形成完整两行布局。
- 优化文件夹页和文献库的框选多选体验：多选框会跟随滚动内容移动，拖到边缘时会自动滚动，空白处点击可退出多选。
- 文件夹页新增“全选已加载”“反选”和 Ctrl/Shift 多选提示，使操作更接近系统文件管理器。
- 新增工作区自动保存与恢复：退出软件后重新打开，会恢复此前打开的标签页、标签顺序、当前标签、文献目标、文件夹位置和侧栏折叠状态。
- 工作区只保存轻量导航信息，不写入 OCR 全文或检索结果大对象；文献阅读进度继续使用现有阅读状态单独恢复。

#### 修复

- 修复文本块拖拽完成后高亮可能落到目标位置原有文本块的问题；现在高亮会继续跟随被拖动的同一个文本块。

#### 发布说明

- 1.0.6 未单独上传发行包；以上改动随 1.0.7 的安装版和便携版一并提供。

### English

#### Improvements

- Added drag-and-drop reordering for OCR text blocks in the proofing text list, useful for correcting reading-order issues from multi-column pages, figures, or complex layouts.
- Expanded the drag hit area with insertion hints and drag feedback so manual reordering is easier to target.
- Dropping a block saves the current page's reading order and refreshes the text order used by normal reading mode, search, and excerpts.
- Manual order is stored separately, leaving OCR block coordinates and the facsimile/layout restoration view unchanged.
- Added PDF text-layer quality preflight, preserving usable native text first and sending scanned pages through OCR.
- Reading, search, translation, and plain-text export now share the structured body flow, while proofing and facsimile restoration retain original blocks and coordinates.
- Added a Folders entry card to the welcome page, linking directly to the folder overview and completing the two-row shortcut layout.
- Improved drag multi-select in the Folders page and Library: the marquee is anchored to the scrolling content, edge-dragging auto-scrolls, and blank-space clicks exit multi-select.
- Added "select loaded", invert selection, and Ctrl/Shift selection hints in the Folders page for a more Explorer-like workflow.
- Added automatic workspace persistence and restoration. Reopening the app restores open tabs, tab order, the active tab, document targets, folder context, and sidebar collapse state.
- Workspace snapshots store only lightweight navigation data, excluding OCR text and large search-result objects; document reading progress continues to restore through the existing reader-state storage.

#### Fixes

- Fixed the active highlight after dragging a text block so it stays on the dragged block instead of the block that previously occupied the drop position.

#### Release Note

- 1.0.6 was not published as a separate package. These changes are included in the 1.0.7 installer and portable builds.

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
