# 更新日志 / Changelog

## Unreleased

## 1.2.16 - 2026-07-29

### 中文

#### OCR 重试即时入队与锁等待

- 修复点击“继续 OCR”或“重新 OCR”后只显示顶部“正在重新处理”，文献没有进度条、没有“停止全部 OCR”，也迟迟未进入 OCR 队列的问题。
- OCR 重试不再在入队前额外等待文献状态写入和详情读取；当前文献使用原有 OCR 引擎直接提交，完整队列状态由主进程统一持久化。
- 前端会立即显示“正在加入 OCR 队列”、0% 进度和停止入口；主进程也会先发布可取消的排队状态，再异步等待 SQLite 写入机会。数据库正被导入、删除或其他任务占用时，界面仍保持响应。
- 队列写入成功后会原子清除旧的重试计数和错误时间；写入失败会释放内存中的排队占位并显示明确原因，不再留下无法取消的假队列状态。
- 保留原有断点恢复、OCR 引擎选择、批量并发、页图准备和结果保存逻辑，不减少 OCR 功能。

#### 下载

- `GujiSmart-1.2.16-Setup-x64.exe`
- `GujiSmart-1.2.16-Portable-x64.exe`

### English

#### Immediate OCR Retry Queueing and Writer-Lock Waiting

- Fixed “Continue OCR” or “Retry OCR” showing only the top processing notice while no document progress bar, cancel-all action, or visible OCR queue entry appeared.
- OCR retry no longer waits for a separate document status write and detail read before enqueueing. It submits with the document's existing OCR engine, while the main process persists the complete queue state.
- The renderer now immediately shows “Joining OCR queue,” 0% progress, and a stop action. The main process also publishes a cancellable queued state before asynchronously waiting for a SQLite writer opportunity, keeping the interface responsive while imports, deletion, or another task is writing.
- Successful queue persistence atomically clears stale retry counters and timestamps. Failed persistence releases in-memory queue reservations and reports the reason instead of leaving an uncancellable phantom queue state.
- Existing restart recovery, OCR engine selection, batch concurrency, page-image preparation, and result persistence behavior remain intact.

#### Downloads

- `GujiSmart-1.2.16-Setup-x64.exe`
- `GujiSmart-1.2.16-Portable-x64.exe`

## 1.2.15 - 2026-07-29

### 中文

#### 大批量删除锁死、进度与退出恢复

- 修复永久删除数百至上千篇文献时，删除 worker 在真正处理文献前为整座数据库同步创建多组索引，长时间独占 SQLite 写锁，继而导致删除无进度、OCR 停止、智能视图刷新失败、文件夹删除失败和文献详情无法打开的问题。正常删除不再执行全库建索引。
- OCR 记录现在沿数据库已有的 `ocr_runs -> attempts -> artifacts` 索引关系级联清理，向量、全文索引、标签、摘录、项目关系及原文文件仍按原有永久删除语义完整清除，不阉割删除范围。
- 大批量删除继续使用独立 worker 和 25 篇一批的事务边界，并在批次之间短暂释放写入机会，让 OCR、导入和前台状态保存能够继续推进。
- 新增可见的后台删除进度，显示等待、准备、已完成篇数、原文清理、完成或失败状态；失败后先恢复未删除文献，再刷新列表。
- 打开文献详情、轻量详情和阅读窗口时，最近打开时间改为后台尽力写入。即使另一个任务短暂持有写锁，文献内容仍可正常读取。
- 退出软件时优先终止删除 worker，再等待 OCR、导入等任务保存状态；未完成且已标记为删除中的文献会在下次启动继续恢复，不再让退出长期卡死。

#### 下载

- `GujiSmart-1.2.15-Setup-x64.exe`
- `GujiSmart-1.2.15-Portable-x64.exe`

### English

#### Bulk-Delete Lockups, Progress, and Shutdown Recovery

- Fixed bulk permanent deletion creating several whole-library indexes before processing documents. That schema write could monopolize SQLite and stall deletion progress, OCR, Smart View refresh, folder deletion, and document detail loading. Normal deletion no longer performs global index creation.
- OCR history now cascades through the existing indexed `ocr_runs -> attempts -> artifacts` relations. Vectors, full-text indexes, tags, excerpts, project memberships, and source files retain their complete permanent-delete semantics.
- Bulk deletion remains isolated in a worker with 25-document transaction boundaries and now leaves a short writer opportunity between batches so OCR, imports, and foreground state updates can continue.
- Added visible background deletion progress for queued, preparing, completed-count, source-file cleanup, completion, and failure states. Failed rows are restored before the library refreshes.
- Document detail, lightweight detail, and reading-window loads now record recent-open timestamps on a best-effort background path, so content reads remain available during brief writer contention.
- Application shutdown now terminates delete workers before OCR and import runtimes persist their state. Interrupted rows remain recoverable on the next start instead of keeping the application stuck during exit.

#### Downloads

- `GujiSmart-1.2.15-Setup-x64.exe`
- `GujiSmart-1.2.15-Portable-x64.exe`

## 1.2.14 - 2026-07-29

### 中文

#### 永久删除写锁与中断导入恢复

- 修复永久删除或批量永久删除在真正进入后台队列之前，因同步刷新项目侧栏缓存而直接提示 `documents:deleteBatch: database is locked`、导致文献根本无法删除的问题。删除入口现在只进行异步读取，删除标记、项目缓存失效和完整清理统一在后台写入队列中依次执行。
- 删除请求会在数据库被导入、OCR 或其他任务短暂占用时异步等待，不阻塞 Electron 主进程；向量、OCR、全文索引、标签、摘录、项目关系和原文文件仍按原有永久删除语义完整清理。
- 修复中断导入后把已经处理完成的文件名继续保存为“待重新授权”，从而反复要求重新选择、选择后却显示“已加入导入队列：0 个文件”的问题。
- 重新授权大目录时，即使前一个扫描批次没有找到目标文件也会继续扫描；全部目标已匹配后会及时停止，不再无意义扫描整个目录。选择不匹配时会明确提示重新选择原文件或包含它的目录。
- 重新授权提示新增“放弃任务”。它只移除未完成的断点续传记录，不会删除已导入文献、原文、OCR 或其他数据。
- 修复手动或自动刷新智能视图时，为了保存统计快照而同步争抢 SQLite 写锁，导致提示“智能视图状态刷新失败”的问题。统计读取现在异步执行，快照写入在后台合并并重试；即使 OCR、导入或删除正在写库，刷新结果也能先正常显示。
- 修复取消单篇 OCR 时，任务已经收到终止信号但持久化取消状态被 SQLite 写锁拦截，导致提示 `ocr:cancelDocument: database is locked` 的问题。现在会先立即中止运行和释放 OCR 槽位，再异步等待写锁，将任务队列、文献和页面状态原子保存。
- “取消全部 OCR”同步使用非阻塞写锁等待，避免任务在当前界面看似取消、重启后却又被恢复。

#### 下载

- `GujiSmart-1.2.14-Setup-x64.exe`
- `GujiSmart-1.2.14-Portable-x64.exe`

### English

#### Permanent-Deletion Writer Lock and Interrupted Import Recovery

- Fixed permanent and batch deletion failing before reaching the background queue because synchronous project-cache invalidation surfaced `documents:deleteBatch: database is locked`. The submission path is now read-only and asynchronous; delete markers, project-cache invalidation, and complete cleanup run serially on the background writer queue.
- Delete requests now wait asynchronously while import, OCR, or another task briefly owns SQLite's writer lock without blocking Electron's main process. Vectors, OCR, full-text indexes, tags, excerpts, project memberships, and source files retain their complete permanent-delete semantics.
- Fixed completed file names remaining in interrupted-import authorization snapshots, which caused repeated reauthorization prompts followed by “0 files added to the import queue.”
- Directory reauthorization now continues after empty intermediate scan batches and stops as soon as every requested file is matched. A completed but unmatched selection now gives an actionable explanation.
- Added a “Discard task” action that removes only the stale resume record; already imported documents, source files, OCR, and all other data are preserved.
- Fixed manual and automatic Smart View refreshes competing synchronously for SQLite's writer lock merely to persist a count snapshot. Count reads are now asynchronous, while snapshot writes are coalesced and retried in the background so current results can render while OCR, imports, or deletion are writing.
- Fixed single-document OCR cancellation aborting the live task but then surfacing `ocr:cancelDocument: database is locked` before its cancellation state could be persisted. The live request and OCR slot are released first, followed by an asynchronously acquired transaction that atomically updates task, document, and page state.
- “Cancel all OCR” now uses the same nonblocking writer-lock path so canceled work cannot silently return after restart.

#### Downloads

- `GujiSmart-1.2.14-Setup-x64.exe`
- `GujiSmart-1.2.14-Portable-x64.exe`

## 1.2.12 - 2026-07-29

### 中文

#### 文件夹删除写锁恢复

- 修复 OCR、导入、批量删除或后台数据库任务持有 SQLite 写锁时，删除文件夹直接提示 `database is locked` 的问题。
- 文件夹删除现在会异步等待写锁释放，等待期间窗口和其他交互保持响应；获得写锁后，解除文件夹归属、将直接子文件夹移到根层并删除目标文件夹仍在同一事务内原子完成。
- 删除文件夹仍只删除文件夹及其归属关系，不会删除文件夹中的文献、OCR、向量或原文文件。
- 删除完成后的 WAL 检查点改为延迟后台执行，避免刚释放写锁后再次同步阻塞 Electron 主进程。

#### 下载

- `GujiSmart-1.2.12-Setup-x64.exe`
- `GujiSmart-1.2.12-Portable-x64.exe`

### English

#### Folder-Deletion Writer-Lock Recovery

- Fixed folder deletion surfacing `database is locked` while OCR, imports, bulk deletion, or another background database task owns SQLite's writer lock.
- Folder deletion now waits asynchronously for the writer lock while the window and other interactions remain responsive. Once acquired, detaching document memberships, moving direct child folders to the root, and deleting the target folder still complete atomically in one transaction.
- Deleting a folder continues to remove only the folder and its memberships; documents, OCR, vectors, and source files are preserved.
- The post-delete WAL checkpoint is now deferred to the background instead of synchronously blocking Electron's main process immediately after the writer lock is released.

#### Downloads

- `GujiSmart-1.2.12-Setup-x64.exe`
- `GujiSmart-1.2.12-Portable-x64.exe`

## 1.2.11 - 2026-07-28

### 中文

#### 批量导入后的 OCR 队列恢复

- 修复一次导入几十本文献时，自动 OCR 必须等全部导入和大库列表刷新结束后才启动的问题。现在每个已完成的导入小批次都会先完整持久化，再立即启动 OCR，后续文献可继续导入。
- 修复旧版在项目后台恢复与导入任务同时发生时，OCR 任务已进入错误状态、后续文献却仍被追加为排队状态，导致重启或换版本后一直显示“待 OCR”的问题；项目恢复时会自动重新打开这类遗留任务并继续处理。
- 文献写入持久化 OCR 队列后会立即显示“已入队”，无需等待 worker 真正领取任务才更新界面状态。
- 保留全局 OCR 文档窗口与大型 PDF 单本处理限制。批量任务可持续推进，但不会把几十本文献无上限地同时提交给 OCR 服务。

#### 下载

- `GujiSmart-1.2.11-Setup-x64.exe`
- `GujiSmart-1.2.11-Portable-x64.exe`

### English

#### OCR Queue Recovery After Bulk Imports

- Fixed automatic OCR waiting for every imported book and the final large-library refresh before it could start. Each completed import batch is now persisted as a self-contained task and starts immediately while later files continue importing.
- Fixed a legacy race where project background recovery could start a still-growing import task, leave the job in an error state, and then append more queued documents that were never selected after restart or upgrade. Project recovery now reopens these stranded jobs and resumes their queued documents.
- Documents now become visibly queued as soon as they are persisted to the OCR task instead of waiting for a worker claim.
- Preserved the global OCR document window and single-heavy-PDF limit, so bulk work continues without submitting dozens of books to the OCR service without bounds.

#### Downloads

- `GujiSmart-1.2.11-Setup-x64.exe`
- `GujiSmart-1.2.11-Portable-x64.exe`

## 1.2.10 - 2026-07-28

### 中文

#### 批量删除吞吐与写锁恢复

- 永久删除改为单一后台写入队列：连续提交多批删除时，界面会立即移除所选文献，数据库标记和物理清理依次执行，不再让两个删除任务争抢 SQLite 写锁并向用户显示 `database is locked`。
- 删除状态写入遇到 OCR、导入等短暂占锁时改为异步等待重试，Electron 主进程仍可处理窗口与交互；SQLite 的向量、OCR、全文索引及其他关联数据仍会完整清理。
- 后台 worker 的文献批次由 4 篇提升到 25 篇，关联行批次由 80 条提升到 2,000 条；全文索引删除由逐条命令改为批量 `INSERT ... SELECT`，显著减少事务和 WAL 提交次数。
- 在删除 worker 中按需补齐 OCR 产物、翻译上下文和研究证据等外键子表索引，避免删除父记录时反复全表扫描；索引创建不占用软件启动主线程。
- 新增真实写锁恢复测试和大批量向量删除压力回归。自动化夹具中 320 篇文献及 32,000 条向量记录约 0.25 秒完成清理，同时主进程心跳持续响应。

#### 下载

- `GujiSmart-1.2.10-Setup-x64.exe`
- `GujiSmart-1.2.10-Portable-x64.exe`

### English

#### Bulk-Deletion Throughput and Writer-Lock Recovery

- Serialized permanent deletion through one background writer queue. Consecutive submissions disappear from the UI immediately, while database markers and physical cleanup run in order instead of competing for SQLite's writer lock and surfacing `database is locked`.
- Delete-state writes now wait and retry asynchronously when OCR, import, or another short write temporarily owns the database. Electron's main process remains responsive while vectors, OCR, full-text indexes, and all other related data are still cleaned completely.
- Increased worker batches from 4 to 25 documents and relation drains from 80 to 2,000 rows. Full-text index cleanup now uses batched `INSERT ... SELECT` delete commands to eliminate thousands of small transactions and WAL commits.
- Added delete-time child-key indexes for OCR artifacts, translation contexts, and research evidence inside the worker, preventing repeated full-table scans without moving index creation onto the startup main thread.
- Added a real writer-lock recovery test and a high-volume vector deletion regression. The automated fixture cleans 320 documents and 32,000 vector rows in about 0.25 seconds while Electron main-process heartbeats continue.

#### Downloads

- `GujiSmart-1.2.10-Setup-x64.exe`
- `GujiSmart-1.2.10-Portable-x64.exe`

## 1.2.9 - 2026-07-28

### 中文

#### 批量删除无响应修复

- 修复批量永久删除中的 SQLite `rowid` 字段名兼容问题：部分关联表会把未显式命名的 `rowid` 返回为主键字段，旧代码因此反复读取同一批记录而无法完成；现在所有分批清理都使用稳定别名，重启后也能继续完成此前卡住的删除任务。
- 将向量、OCR、全文索引及其他关联数据的完整删除流水线移到独立数据库 worker。即使用户库中的某条 SQLite 清理语句耗时较长，Electron 主进程和窗口仍保持响应。
- 增加真实 worker 压力回归：用故意变慢的同步 SQLite 删除语句验证主线程心跳持续运行，并覆盖向量行、标签关系、项目关系和最终文献记录的完整清理。

#### 下载

- `GujiSmart-1.2.9-Setup-x64.exe`
- `GujiSmart-1.2.9-Portable-x64.exe`

### English

#### Responsive Bulk-Deletion Recovery

- Fixed SQLite `rowid` result-name handling during batched permanent deletion. Some relation tables returned an implicit rowid under the primary-key column name, causing the old loop to repeatedly select the same rows forever. Every row drain now uses an explicit stable alias, including startup recovery of already-stuck deletions.
- Moved the complete vector, OCR, full-text index, and related-data deletion pipeline to a dedicated database worker. A slow synchronous SQLite cleanup statement can no longer block Electron's main process or freeze the window.
- Added a real worker stress regression that deliberately slows a synchronous SQLite delete while verifying continuous main-thread heartbeats and complete cleanup of vector rows, tags, project relations, and document records.

#### Downloads

- `GujiSmart-1.2.9-Setup-x64.exe`
- `GujiSmart-1.2.9-Portable-x64.exe`

## 1.2.8 - 2026-07-28

### 中文

#### 大批量永久删除恢复

- 修复一次永久删除数百篇文献后，向量 BLOB、OCR 记录和其他关联数据由 SQLite 主线程级联清理，导致窗口长时间无响应的问题；现在会按小批次清理并在批次之间让出事件循环。
- 自动 WAL 检查点改由数据库工作线程执行，批量删除期间暂停自动检查点，避免重启后恢复删除任务与数据库检查点同时争用主线程。
- 已中断的永久删除会跨项目继续完成，不再因为用户重启后选择了其他项目而残留在“正在删除”状态。

#### 下载

- `GujiSmart-1.2.8-Setup-x64.exe`
- `GujiSmart-1.2.8-Portable-x64.exe`

### English

#### Bulk Permanent-Deletion Recovery

- Fixed long window hangs after permanently deleting hundreds of documents. Vector BLOBs, OCR records, and other related rows are now drained in small yielding batches before the final document rows are removed.
- Moved automatic WAL checkpoints to the database worker and suppresses them while a bulk delete is active, preventing startup delete recovery and checkpoints from competing on Electron's main thread.
- Interrupted permanent deletions now resume across projects instead of remaining stuck when the user opens a different project after restarting.

#### Downloads

- `GujiSmart-1.2.8-Setup-x64.exe`
- `GujiSmart-1.2.8-Portable-x64.exe`

## 1.2.7 - 2026-07-28

### 中文

#### 文献移除与智能视图同步

- 文献删除拆分为“从当前项目移除”和“从总库永久删除”：项目移除只解除当前项目关联并清理项目专属整理数据，PDF、OCR、校对、向量及其他项目中的同一文献保持不变；永久删除仍会从所有项目删除完整文献数据。
- 单篇操作、右键菜单和批量处理均提供两种删除方式，并使用独立确认说明避免误删。
- 修复导入文献后智能视图计数仍显示旧状态的问题；导入、OCR 和向量状态变化会合并为约 5 秒一次的轻量项目统计刷新，避免重复执行完整侧栏统计。
- 智能视图标题增加手动刷新按钮；项目或筛选范围变化时会取消旧刷新任务，避免过期状态写回当前界面。

#### 下载

- `GujiSmart-1.2.7-Setup-x64.exe`
- `GujiSmart-1.2.7-Portable-x64.exe`

### English

#### Project Removal and Smart View Sync

- Split document removal into “remove from current project” and “permanently delete from library.” Project removal only detaches the active project and clears project-specific organization data while preserving PDFs, OCR, proofreading, vectors, and memberships in other projects; permanent deletion still removes the complete document from every project.
- Added both removal choices to single-document actions, context menus, and batch actions, with distinct confirmation text to reduce accidental deletion.
- Fixed stale Smart View counts after imports. Import, OCR, and embedding status changes now coalesce into a lightweight project-scoped refresh about once every five seconds instead of rebuilding all sidebar statistics.
- Added a manual Smart View refresh button; stale scheduled refreshes are canceled when the active project or list scope changes.

#### Downloads

- `GujiSmart-1.2.7-Setup-x64.exe`
- `GujiSmart-1.2.7-Portable-x64.exe`

## 1.2.6 - 2026-07-28

### 中文

#### 项目进入与后台维护响应

- 将进入项目后自动执行的数据库完整诊断移到独立只读 worker，保留自动升级提示、设置页诊断和导出诊断功能，同时避免页面大字段与外置文件扫描阻塞 Electron 主进程。
- 大库保护现在同时按数据库文件、WAL 体积、页面数和检索段数判断；体积较大但页面数不多的文献库不再于启动 45 秒后自动执行全库维护。
- 数据库诊断复用同一次页面大字段统计，不再为了存储分层重复扫描整库。

#### 下载

- `GujiSmart-1.2.6-Setup-x64.exe`
- `GujiSmart-1.2.6-Portable-x64.exe`

### English

#### Responsive Project Entry and Background Maintenance

- Moved automatic full database diagnostics to a read-only worker, preserving upgrade prompts, settings diagnostics, and diagnostic exports without blocking Electron's main process.
- Large-library protection now considers database and WAL bytes in addition to page and search-segment counts, so byte-heavy libraries no longer run full automatic maintenance 45 seconds after startup.
- Reuses one page-payload statistics pass per diagnostic instead of scanning the same large tables twice.

#### Downloads

- `GujiSmart-1.2.6-Setup-x64.exe`
- `GujiSmart-1.2.6-Portable-x64.exe`

## 1.2.5 - 2026-07-27

### 中文

#### 项目选择首屏响应

- 优化从启动软件到项目选择页可操作之间的顿卡：项目选择页改为独立轻量入口，完整工作区、Ant Design 和各业务模块仅在选择或新建项目后加载。
- 所选项目直接作为工作区初始状态传入，避免完整界面加载后重复读取项目与闪回选择页；项目新建、切换、恢复任务和单库隔离逻辑保持不变。
- 在约 835 MB 的真实数据库副本上，项目选择页稳定可操作时间由约 2.3-2.6 秒降至约 0.84-0.96 秒；首屏 JavaScript 由约 1.48 MB 降至约 166 KB。

#### 下载

- `GujiSmart-1.2.5-Setup-x64.exe`
- `GujiSmart-1.2.5-Portable-x64.exe`

### English

#### Responsive Project Selection Startup

- Moved the project selection screen into a lightweight entry so the full workspace, Ant Design, and feature modules load only after a project is selected or created.
- Passes the selected project directly into the workspace initial state, avoiding a duplicate project fetch and project-gate flash while preserving project creation, switching, recovery, and single-library isolation behavior.
- On an approximately 835 MB real database copy, stable project-gate readiness improved from about 2.3-2.6 seconds to about 0.84-0.96 seconds, while initial JavaScript dropped from about 1.48 MB to about 166 KB.

#### Downloads

- `GujiSmart-1.2.5-Setup-x64.exe`
- `GujiSmart-1.2.5-Portable-x64.exe`

## 1.2.4 - 2026-07-27

### 中文

#### 项目选择与新建响应

- 修复主窗口显示后立即执行全库启动恢复，导致用户虽然看到项目选择页，但点击已有项目或新建项目后主进程长时间无响应的问题。
- 启动恢复改为项目成功进入后再等待 15 秒启动，并在各个有界恢复阶段之间主动让出事件循环；同一会话只执行一次，不会随着后续项目切换重复运行。
- 项目切换不再无意义地把侧栏统计缓存标记为需要重建；大库发生真实数据变化时保留旧统计快照，不再自动触发可能阻塞界面的全库计数。
- 选择项目改为按项目主键读取，不再为了返回一个项目而聚合全部项目；新建空项目直接返回创建结果，项目数量刷新移到进入工作区之后异步执行。
- 新增 20,000 篇文献项目压力回归及真实 Electron 操作回归，覆盖启动页选择、新建并进入、再次切换项目以及原有共享、复制、转移和隔离功能。

#### 下载

- `GujiSmart-1.2.4-Setup-x64.exe`
- `GujiSmart-1.2.4-Portable-x64.exe`

## 1.2.3 - 2026-07-27

### 中文

#### 标签栏显示比例响应

- 修复 Windows 显示比例或 Electron 页面缩放变化后，标签栏仍沿用旧槽位宽度、无法自动压缩并导致右侧标签移出可视区域的问题。
- 同时监听窗口尺寸、可视视口与显示分辨率变化，并为 Electron 偶发漏发缩放事件的情况增加轻量 DPI 检测；仅在 DPI 实际变化时触发重新排版。
- 缩放后分阶段复测标签栏最终宽度，兼容 Chromium 视口延迟更新；保留 1.2.2 的分组边界约束，标签不会重叠或被分组遮盖。
- 扩充真实 Chromium 回归测试，覆盖 100%、125%、150%、175% 显示比例来回切换以及多分组、折叠分组和普通标签共存的布局。

#### 下载

- `GujiSmart-1.2.3-Setup-x64.exe`
- `GujiSmart-1.2.3-Portable-x64.exe`

## 1.2.2 - 2026-07-27

### 中文

#### 标签分组响应式布局

- 修复应用从全屏切换到较小窗口后，展开分组中的标签越过分组边界并与后续分组或标签重叠的问题。
- 顶部标签栏现在统一计算分组按钮、分组内边距、标签间距和所有可见标签的槽位宽度；普通标签与分组内标签使用同一套压缩结果。
- 窗口尺寸变化时会丢弃旧窗口坐标并取消尚未结束的标签位移动画，避免缩放前的动画位置残留。
- 新增真实 Chromium 多分组缩放回归，覆盖全屏、缩小和恢复窗口的连续切换；分组、折叠、拖拽、重命名和颜色功能保持不变。

#### 下载

- `GujiSmart-1.2.2-Setup-x64.exe`
- `GujiSmart-1.2.2-Portable-x64.exe`

## 1.2.1 - 2026-07-27

### 中文

#### 大型文献库启动与项目切换

- 修复大型旧库首次升级时同步回填全文检索段和向量块、创建无用项目索引而导致启动数分钟无响应的问题。
- 项目选择现在先完成界面切换，再延迟恢复所选项目的向量、自动 OCR 和批处理队列；项目选择页不再等待后台任务。
- 禁用 SQLite 提交线程上的自动 WAL 检查点，并移除项目切换与向量队列恢复路径中的同步检查点，避免窗口显示“未响应”。
- 文献项目仍通过总库关联表隔离；检索、向量、OCR、转移、复制和旧数据兼容逻辑保持不变。

#### 下载

- `GujiSmart-1.2.1-Setup-x64.exe`
- `GujiSmart-1.2.1-Portable-x64.exe`

## 1.2.0 - 2026-07-26

### 中文

#### 摘录库

- 摘录页新增跨表格、列表和卡片视图的多选、全选已加载及批量删除；删除前明确显示数量并通过单次数据库事务提交。
- 摘录页改为数据库分页：默认加载 200 条，向下滚动或点击“加载更多”继续追加；筛选、排序、AI 文献范围和“复制当前视图”仍覆盖完整结果集。

#### 文献项目

- 新增文献项目隔离：启动时选择本次加载的项目，一次只加载一个项目；旧版本文献自动归入“默认项目”。
- 支持创建和切换项目，并可批量转移文献；正文、OCR、向量、标签、文件夹、摘录和研究关联均完整保留。
- 文献右键菜单新增“转移到文献项目”一级操作；单篇右键只转移当前文献，多选后右键可转移全部选中文献。
- 项目选择界面统一为软件原有的深色水墨与暖金交互风格。

#### 下载

- `GujiSmart-1.2.0-Setup-x64.exe`
- `GujiSmart-1.2.0-Portable-x64.exe`

## 1.1.33 - 2026-07-26

### 中文

#### 向量检索与导出

- 向量召回数量改为在检索前选择：默认 200 条，可提高到 5000 条，并记住上次设置。
- 大结果集改用有界 Top-K 堆、SQLite 游标分页和批量元数据回填，避免候选越多时反复排序与逐条查库。
- 导出复用当前向量结果；预览按需展开且只构建 3 条样例，正式导出批量解析页码并异步写盘。
- 导出弹窗重排为紧凑双列布局，引用与预览收进折叠区，保留数量、最低相似度、格式、页码与引用模板等原功能。

#### 启动与兼容

- 保留列表首屏不做全库页面扫描/文件探测的启动优化；仅对当前列表页中的矛盾 OCR 状态做有界兼容修复，恢复旧库的完成状态与复核提示。

#### 安装包体积

- 本地与 GitHub Actions 共用同一套精简规则：前端依赖只参与 Vite 构建，不再重复打入生产依赖；仅保留中英文 Electron 语言包。
- 删除数据库/PDF/简繁转换依赖中的编译中间文件、source map 与重复发行格式，同时保留 SQLite 原生模块、PDF 解析/导出字体、OCR、QPDF、MCP 和全部运行功能。
- 新增安装包体积回归检查与更细的 `size:build` 报告，防止后续升级悄悄恢复冗余文件。

#### 下载

- `GujiSmart-1.1.33-Setup-x64.exe`
- `GujiSmart-1.1.33-Portable-x64.exe`

## 1.1.32 - 2026-07-26

### 中文

#### 向量 / 检索导出

- **导出弹窗可选一次条数**：20 / 50 / 100 / 200（默认 50，可改并记住）。
- **最低相似度**控件加高亮区块，向量模式下更易发现；全文模式会提示需先用向量检索。
- **减轻导出卡死**：前端先截断再 IPC；向量导出优先用摘录、轻量引用，避免每条查库拼模板。

#### 下载

- `GujiSmart-1.1.32-Setup-x64.exe`
- `GujiSmart-1.1.32-Portable-x64.exe`

## 1.1.31 - 2026-07-26

### 中文

#### 启动体验

- **关闭启动诊断窗口**：不再弹出「启动诊断完成（请截图）」测试窗；启动计时仍写日志，正常只进主界面。

#### 下载

- `GujiSmart-1.1.31-Setup-x64.exe`
- `GujiSmart-1.1.31-Portable-x64.exe`

## 1.1.30 - 2026-07-26

### 中文

#### 向量检索与导出

- **向量命中上限**：界面与引擎由约 40/50 提升到 **200** 条（`VECTOR_SEARCH_MAX_LIMIT`）。
- **导出不再二次全库扫描**：预览/导出/批量保存复用当前检索结果（`exportGroups`），避免大向量库导出时主进程「未响应」。
- **向量扫描让出事件循环**：无复用结果时分批扫描 embedding 并 `setImmediate`，减轻标题栏卡死。
- **导出预览**：统计为「预计可导出全部条数」，界面仅展示前 3 条样例，文案不再误导为只能导 3 条。
- 向量导出优先段文本/摘录，整页 OCR 作最后回退，降低导出时同步读盘压力。
- **最低相似度筛选**：向量导出弹窗可设「关联度门槛」（如 ≥0.6 才导出）；选择后写入本地默认，下次打开仍可改；预览会显示因相似度过滤的条数。

#### 下载

- `GujiSmart-1.1.30-Setup-x64.exe`
- `GujiSmart-1.1.30-Portable-x64.exe`

## 1.1.29 - 2026-07-24

### 中文

#### 设计对齐

- **列表按「导入/OCR 写死的字段」展示**：`page_count` / `ocr_status` 只在导入、识别完成、删除等路径维护；列表/筛选项只读这些字段，**不再每次打开重算 pages 表**。
- 新增 `documents:listFilterOptions`：检索筛选项拉**全库轻量元数据**（id/title/author/doc_type/page_count/ocr_status），不扫 pages、不探盘，也**不人为砍成 100 本**。
- 检索**结果**仍是独立分页搜索接口，与筛选项名单无关。

#### 下载

- `GujiSmart-1.1.29-Setup-x64.exe`
- `GujiSmart-1.1.29-Portable-x64.exe`

## 1.1.28 - 2026-07-24

### 中文

#### 性能

- **关检索仍卡死的根因**：不只是检索页；**任意文献列表**（文献库/标签/研究等）在 attach 时都会碰 `pages` 表整行（含 OCR 正文）。现列表路径**一律不查 pages**，页数只信 `documents` 字段。
- 列表不再做 OCR 状态“顺手改写/扫页”逻辑，避免首屏二次扫库。

#### 下载

- `GujiSmart-1.1.28-Setup-x64.exe`
- `GujiSmart-1.1.28-Portable-x64.exe`

## 1.1.27 - 2026-07-24

### 中文

#### 性能

- **修复「诊断很快但界面仍卡很久」**：文献列表路径解析不再对每一行 `existsSync`（杀毒下 1000 条列表可卡数分钟）；打开/阅读时再校验文件是否存在。
- **检索页首屏**：不再 `listDocuments({ limit: 1000 })` 拉全量列表做筛选项，改为最近 100 条分页轻量加载。

#### 下载

- `GujiSmart-1.1.27-Setup-x64.exe`
- `GujiSmart-1.1.27-Portable-x64.exe`

## 1.1.26 - 2026-07-24

### 中文

#### 性能

- **根治「恢复只 1 秒、整窗却卡 4 分钟」**：大库文献列表首屏**完全不查 `pages` 表**（即使只 SELECT 状态也会装入含 OCR 正文的整行，杀毒下可达数分钟）。
- 列表 OCR 汇总不再 `TRIM(ocr_text)`；大库跳过列表侧 OCR 状态改写与 pages 探测。
- 启动恢复中段不再 `setImmediate` 让出主线程，避免首屏 IPC 插队把「启动恢复（整体）」拖成数分钟。
- 诊断增加 `ipc.documents.listPage` 阶段，便于确认首屏列表是否仍慢。

#### 下载

- `GujiSmart-1.1.26-Setup-x64.exe`
- `GujiSmart-1.1.26-Portable-x64.exe`

## 1.1.25 - 2026-07-23

### 中文

#### 存储

- **OCR 会话临时目录改到软件数据目录**：`{数据目录}/temp/ocr/gujismart-ocr-*`，不再写 Windows `%TEMP%`。
- 延迟清理只扫应用自己的 `temp/ocr` 与 `temp/pdf-compression`，范围可控；旧版残留在系统 TEMP 的可手动删，不再自动全盘扫。

#### 下载

- `GujiSmart-1.1.25-Setup-x64.exe`
- `GujiSmart-1.1.25-Portable-x64.exe`

## 1.1.24 - 2026-07-23

### 中文

#### 性能

- **修复「没操作也突然未响应」**：打开后延迟清理不再扫/删 Windows `%TEMP%` 下的 `gujismart-ocr-*`（杀毒下可无故卡死主线程）；只清应用目录内小临时文件夹。
- 大库不再在打开后自动全量重建侧栏计数缓存（`json_extract` 全库 COUNT 很重）；沿用快照，需要时再手动刷新。

#### 下载

- `GujiSmart-1.1.24-Setup-x64.exe`
- `GujiSmart-1.1.24-Portable-x64.exe`

## 1.1.23 - 2026-07-23

### 中文

#### 性能

- **修复「诊断完成立刻卡死」**：文献列表首屏 `attachPageStats` 不再 TRIM/读取 `ocr_text`/`proofed_text` 正文（大库 + 杀毒下可堵主线程数分钟）；仅用 status/ref 统计。
- 启动恢复无实际修复项时，不再立刻二次刷新文件夹+列表。
- 大库跳过启动后本地资源路径全量预加载（避免对数万路径 `existsSync`）。

#### 下载

- `GujiSmart-1.1.23-Setup-x64.exe`
- `GujiSmart-1.1.23-Portable-x64.exe`

## 1.1.22 - 2026-07-23

### 中文

#### 性能

- **启动恢复完全不做临时目录删除**：1.1.21 仍可能因单次 `readdir`/`rm` 无法中断而卡 ~70 秒；现打开路径 0 清理，90 秒后延迟清理。
- 诊断上「清理临时目录」应显示约 0 ms。

#### 下载

- `GujiSmart-1.1.22-Setup-x64.exe`
- `GujiSmart-1.1.22-Portable-x64.exe`

## 1.1.21 - 2026-07-23

### 中文

#### 性能

- **启动时不再递归清理系统 TEMP 里的 OCR 残留**：大库打开路径跳过 `%TEMP%/gujismart-ocr-*` 全量删除（失败 OCR 树 + 杀毒下可达 ~70 秒）；改为 90 秒后延迟清理。
- 1.1.20 已把「修复中断导入」降到毫秒；本版针对新瓶颈「清理临时目录」。

#### 下载

- `GujiSmart-1.1.21-Setup-x64.exe`
- `GujiSmart-1.1.21-Portable-x64.exe`

## 1.1.20 - 2026-07-23

### 中文

#### 性能

- **大库启动导入修复改轻量模式**：文献数 ≥500 或 pages 超阈值时，只清 `import_status=processing`，不做 `existsSync` / 读 PDF / 批量插页（杀毒下单次 `existsSync` 可达秒级）。
- 小库完整修复也限制文件探测次数，避免连环磁盘探测。
- 诊断窗口显示应用版本号；导入修复拆成 collect / light / full 子步骤便于截图定位。

#### 下载

- `GujiSmart-1.1.20-Setup-x64.exe`
- `GujiSmart-1.1.20-Portable-x64.exe`

## 1.1.19 - 2026-07-23

### 中文

#### 性能

- **修复中断导入记录不再拖垮大库冷启动**：去掉全库相关子查询 `(SELECT COUNT(*) FROM pages …)`；候选集上限 + 仅探测最近文档缺页；页统计改为 status-only，不再扫 OCR 正文列。
- 1.1.18 诊断已定位约 70 秒卡在「修复中断的导入记录」；本版针对该路径。

#### 下载

- `GujiSmart-1.1.19-Setup-x64.exe`
- `GujiSmart-1.1.19-Portable-x64.exe`

## 1.1.18 - 2026-07-23

### 中文

#### 性能

- **启动恢复不再被主线程空等拖成两分钟**：关键库内修复路径连续执行，减少 `setImmediate` 让出后被大库首屏 IPC 插队。
- **OCR 恢复快路径**：无中断任务时用 `LIMIT 1` 探测，避免大 `pages` 表无意义的 DISTINCT/COUNT。
- **Dashboard 统计**：改为分页 COUNT，不再一次拉全库列表。
- **`documents:list` 上限 2000**：防止无界列表打爆主线程。

#### 测试诊断

- 长等待单独记为「等待主线程（被其他任务占用）」；父子阶段按名称层级嵌套，不再把延迟维护/预加载误算进启动恢复。
- Smoke 环境不打开诊断闪屏，避免抢主窗口。

#### 下载

- `GujiSmart-1.1.18-Setup-x64.exe`
- `GujiSmart-1.1.18-Portable-x64.exe`

## 1.1.17 - 2026-07-23

### 中文

#### 性能

- **去掉启动恢复固定 8 秒空等**：主窗口显示后立即排队启动恢复（`setTimeout(0)` 仅让出当前轮次），冷启动体感约快 8 秒。

#### 下载

- `GujiSmart-1.1.17-Setup-x64.exe`
- `GujiSmart-1.1.17-Portable-x64.exe`

## 1.1.16 - 2026-07-22

### 中文

#### 测试诊断

- **修正启动诊断时间口径**：顶部显示墙钟总用时；另列「已计量工作 / 未计量间隔」。
- 阶段列表改为**时间轴**（从启动起的偏移 + 该步耗时），嵌套子步骤缩进且不重复计入已计量。
- 把「等待首屏后再恢复」的固定延迟记为正式阶段，避免总用时与分项对不上。

#### 下载

- `GujiSmart-1.1.16-Setup-x64.exe`
- `GujiSmart-1.1.16-Portable-x64.exe`

## 1.1.15 - 2026-07-22

### 中文

#### 测试诊断（不公开）

- **启动诊断窗口**：冷启动时显示中文阶段进度与耗时；主窗口就绪后**不自动关闭**，便于大库用户截图反馈。
- **启动分段计时**：主进程 `initDatabase` / 窗口 / 启动恢复各子步骤写入诊断列表。
- 完成后提示「请截图本窗口」；可手动关闭。120 秒兜底解锁关闭。

#### 下载

- `GujiSmart-1.1.15-Setup-x64.exe`
- `GujiSmart-1.1.15-Portable-x64.exe`

### English

#### Diagnostics (internal test)

- Persistent startup diagnostics window with phase timings for remote large-library feedback.
- Does not auto-close after main window is ready.

#### Downloads

- `GujiSmart-1.1.15-Setup-x64.exe`
- `GujiSmart-1.1.15-Portable-x64.exe`

## 1.1.14 - 2026-07-22

### 中文

#### 修复

- **补回原文不再全盘重哈希**：一键补回先查索引，未命中时按该文献指纹/大小做定向匹配，避免主进程卡死（尤其在杀软实时扫描时）。
- **全量扫描仅手动/添加目录触发**：设置「立即扫描」与添加仓库后台扫仍可用；日常补回不强制整库重扫。
- **设置说明**：补充杀软白名单与扫描策略提示。

#### 下载

- `GujiSmart-1.1.14-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.14-Portable-x64.exe`：适合免安装便携使用。

### English

#### Fixed

- **No full warehouse rehash on restore**: index lookup first, then targeted size/hash search for the document only — avoids UI freezes under antivirus.
- **Full scans only for manual “Scan now” / add-folder background jobs**.
- **Settings copy** about AV exclusions and scan policy.

#### Downloads

- `GujiSmart-1.1.14-Setup-x64.exe`
- `GujiSmart-1.1.14-Portable-x64.exe`

## 1.1.13 - 2026-07-22

### 中文

#### 修复

- **PDF 原件仓库自动刷新**：一键补回前会软刷新/按需强制重扫索引，云盘/NAS 新上传的 PDF 不必次次手点「立即扫描」。
- **批量补回合并扫描**：多篇补回共用一次索引，避免重复全盘扫描。
- **添加仓库目录后后台建索引**：添加路径后自动启动扫描。
- **设置页说明**：补充「新文件补回时自动刷新索引」的说明。

#### 下载

- `GujiSmart-1.1.13-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.13-Portable-x64.exe`：适合免安装便携使用。

### English

#### Fixed

- **Auto-refresh PDF warehouse index** on one-click restore so newly uploaded cloud/NAS files are found without always clicking “Scan now”.
- **Shared index scan for batch restore** to avoid repeated full rescans.
- **Background index after adding a repository folder**.
- **Settings copy** clarifies automatic refresh behavior.

#### Downloads

- `GujiSmart-1.1.13-Setup-x64.exe`
- `GujiSmart-1.1.13-Portable-x64.exe`

## 1.1.12 - 2026-07-22

### 中文

#### 修复

- **「原文未知」可补回**：文献库右键/批量补回、文档内「补回原文 / 手动选择 PDF」均覆盖 `unknown` 状态。
- **自动补回失败后手选**：无指纹或仓库未命中时，会引导手动选择 PDF。
- **补回后写入指纹**：手动补回会写入 `pdf_sha256` 等元数据并标为有原文，之后可一键自动补回，不再长期显示「原文未知」。
- **校对模式恢复原图**：`unknown` 文献进入校对/区域模式时也可尝试补回 PDF。

#### 下载

- `GujiSmart-1.1.12-Setup-x64.exe`：适合普通 Windows 安装。
- `GujiSmart-1.1.12-Portable-x64.exe`：适合免安装便携使用。

### English

#### Fixed

- **Restore for “unknown” PDF assets**: library context/batch restore and document toolbar cover unknown state.
- **Manual pick fallback** when warehouse auto-restore lacks fingerprint or miss.
- **Stamp fingerprints on restore** so later one-click restore works and the badge is no longer stuck on unknown.
- **Proof mode recovery** for unknown documents when entering proof/region views.

#### Downloads

- `GujiSmart-1.1.12-Setup-x64.exe`
- `GujiSmart-1.1.12-Portable-x64.exe`

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
