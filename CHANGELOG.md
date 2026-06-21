# 更新日志 / Changelog

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
