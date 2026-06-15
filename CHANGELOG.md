# 更新日志 / Changelog

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
