const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert(start >= 0, `${label} start marker not found`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(end > start, `${label} end marker not found`)
  return source.slice(start, end)
}

const root = path.join(__dirname, '..')
const librarySource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')
  .replace(/\r\n?/g, '\n')
const databaseSource = fs.readFileSync(path.join(root, 'src', 'main', 'database.ts'), 'utf8')
  .replace(/\r\n?/g, '\n')
const documentIpcSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'documents.ts'), 'utf8')
  .replace(/\r\n?/g, '\n')
const preloadSource = fs.readFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'utf8')
  .replace(/\r\n?/g, '\n')
const sharedTypesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  .replace(/\r\n?/g, '\n')
const processImportJobBody = sliceBetween(
  librarySource,
  'const processImportJob = async',
  'const drainImportQueue = async',
  'Library import job processor',
)
const drainImportQueueBody = sliceBetween(
  librarySource,
  'const drainImportQueue = async',
  'const enqueueImportJob =',
  'Library import queue drain',
)
const flushOcrStatusBufferBody = sliceBetween(
  librarySource,
  'const flushOcrStatusBuffer = useCallback',
  'useEffect(() => {\n    // Yield one frame so the shell can paint before the first heavy IPC burst.\n    const timer = window.setTimeout(() => {\n      void loadBaseData()',
  'OCR status UI flush',
)
const handleBatchOcrBody = sliceBetween(
  librarySource,
  'const handleBatchOcr = async',
  'const confirmBatchForceRerunOcr =',
  'Manual batch OCR handler',
)
const confirmBatchForceRerunOcrBody = sliceBetween(
  librarySource,
  'const confirmBatchForceRerunOcr =',
  'const handleBatchMetadataExtract =',
  'Batch force OCR rerun handler',
)
const handleRetryDocumentBody = sliceBetween(
  librarySource,
  'const handleRetryDocument = async',
  'const handleForceRerunDocument =',
  'Single document retry handler',
)
const handleForceRerunDocumentBody = sliceBetween(
  librarySource,
  'const handleForceRerunDocument = async',
  'const handleRetryFailedDocuments =',
  'Single document force rerun handler',
)
const handleRetryFailedDocumentsBody = sliceBetween(
  librarySource,
  'const handleRetryFailedDocuments = async',
  'const handleBatchImport =',
  'Failed document retry handler',
)
const handleBatchImportBody = sliceBetween(
  librarySource,
  'const handleBatchImport = async',
  'const handleTaggingChange =',
  'Batch import handler',
)

assert(
  librarySource.includes("LIBRARY_IMPORT_QUEUE_STORAGE_KEY = 'gujismart.library.importQueue.v1'"),
  'Library import queue should keep the legacy localStorage key for authorization-required detection',
)
assert(
  sharedTypesSource.includes('export interface LibraryImportQueueJobSnapshotV1')
    && sharedTypesSource.includes('export interface LibraryImportQueueJobSnapshotV2')
    && sharedTypesSource.includes('export type LibraryImportQueueState =')
    && librarySource.includes('type PersistedImportQueueJob = LibraryImportQueueJobSnapshotV2')
    && librarySource.includes('type PersistedImportQueueState = LibraryImportQueueState'),
  'Library import queue should keep a typed v1 read contract and path-free v2 persistence contract',
)
assert(
  librarySource.includes('activeImportJobRef') && librarySource.includes('restoredImportQueueRef'),
  'Library import queue should track the active job and restore only once',
)
assert(
  librarySource.includes('importQueuePersistenceChainRef')
    && librarySource.includes('const enqueueImportQueuePersistence =')
    && librarySource.includes('importQueuePersistenceChainRef.current = importQueuePersistenceChainRef.current'),
  'Library import queue persistence writes should be serialized so a late save cannot resurrect a cleared queue',
)
assert(
  librarySource.includes('function LibraryView') && librarySource.includes('persistImportQueueSnapshot'),
  'Library import queue should persist snapshots from the LibraryView workflow',
)
assert(
  databaseSource.includes('CREATE TABLE IF NOT EXISTS library_import_queue_state')
    && documentIpcSource.includes('function saveLibraryImportQueueState')
    && documentIpcSource.includes('INSERT INTO library_import_queue_state')
    && preloadSource.includes('saveImportQueueState: (state: LibraryImportQueueState | null)')
    && librarySource.includes('window.api.saveImportQueueState(snapshot)'),
  'Library import queue should write pending jobs through the main-process SQLite snapshot store',
)
assert(
  documentIpcSource.includes('function clearLibraryImportQueueState')
    && documentIpcSource.includes('DELETE FROM library_import_queue_state WHERE id = ?')
    && preloadSource.includes('clearImportQueueState: (): Promise<boolean>')
    && librarySource.includes('window.api.clearImportQueueState()')
    && librarySource.includes('window.localStorage.removeItem(LIBRARY_IMPORT_QUEUE_STORAGE_KEY)'),
  'Library import queue should clear the SQLite snapshot and remove migrated legacy localStorage state when no jobs remain',
)
assert(
  !librarySource.includes('window.localStorage.setItem(LIBRARY_IMPORT_QUEUE_STORAGE_KEY'),
  'Library import queue should not keep writing new recovery snapshots to renderer localStorage',
)
assert(
  documentIpcSource.includes("ipcMain.handle('documents:getImportQueueState'")
    && documentIpcSource.includes("ipcMain.handle('documents:saveImportQueueState'")
    && documentIpcSource.includes("ipcMain.handle('documents:clearImportQueueState'")
    && preloadSource.includes('getImportQueueState: (): Promise<LibraryImportQueueState | null>'),
  'Import queue persistence IPC should expose get/save/clear snapshot operations through preload',
)
assert(
  documentIpcSource.includes("authorizationStatus: 'authorization-required' as const")
    && documentIpcSource.includes('selectionId: null')
    && librarySource.includes('getPersistedImportAuthorizationRequiredJobs()')
    && librarySource.includes("okText: '重新选择'")
    && !librarySource.includes('enqueueImportJob(filePaths, job.folderId'),
  'Restored import queue must redact paths and require a fresh user authorization instead of replaying v1 paths',
)
assert(
  librarySource.includes('const countSettledImportBatchPaths =')
    && librarySource.includes('const settledBatchFileCount = countSettledImportBatchPaths(batch, batchQueuedResults)')
    && librarySource.includes('job.filePaths = job.filePaths.slice(settledBatchFileCount)')
    && librarySource.includes('persistImportQueueSnapshot()'),
  'Library import queue should remove only files that actually returned an import result from the persisted queue',
)
assert(
  processImportJobBody.includes('if (settledBatchFileCount < batch.length) break'),
  'Library import queue should stop the current run after a partial batch result so unfinished files stay recoverable',
)
assert(
  processImportJobBody.includes('未确认完成的文件会保留在队列中')
    && !processImportJobBody.includes('batch.forEach((filePath, resultIndex) => {'),
  'Library import queue should not synthesize per-file failures for an interrupted IPC batch because that would drop unfinished files',
)
assert(
  librarySource.includes('importQueueRef.current.unshift(job)') && librarySource.includes('if (remainingBeforeRefill > 0) break'),
  'Library import queue should keep unfinished paths queued after an outer import failure instead of dropping them',
)
assert(
  librarySource.includes('function rebuildQueuedImportPathSet') || librarySource.includes('const rebuildQueuedImportPathSet'),
  'Library import queue should rebuild duplicate tracking for opaque grant IDs',
)
assert(
  librarySource.includes('if (!libraryInitialLoadDone || restoredImportQueueRef.current) return')
    && librarySource.includes('getPersistedImportAuthorizationRequiredJobs()'),
  'Library import queue should wait for the first document list load before showing reauthorization state',
)
assert(
  librarySource.includes('selectionId: null')
    && librarySource.includes("authorizationStatus: 'authorization-required'")
    && !librarySource.includes('filePaths,\n      folderId: job.folderId'),
  'New persisted queue snapshots must not contain paths or runtime grant IDs',
)
assert(
  processImportJobBody.includes('const processImportedBatchResults = async')
    && processImportJobBody.includes('const batchQueuedResults:')
    && processImportJobBody.includes('await processImportedBatchResults(batchQueuedResults)')
    && processImportJobBody.includes('startPdfImageWorkflowQueue(')
    && processImportJobBody.includes('shouldDeferImportPdfPreview ? { delayMs: AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS } : undefined')
    && processImportJobBody.includes('Math.max(LARGE_PDF_PREVIEW_IDLE_DELAY_MS, AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS)'),
  'Library import processing should pipeline each imported batch into folder assignment and preview work instead of waiting for all batches.',
)
assert(
  librarySource.includes('const IMPORT_LIST_REFRESH_DEBOUNCE_MS = 350')
    && librarySource.includes('const importListRefreshTimerRef = useRef<number | null>(null)')
    && librarySource.includes('const scheduleImportListRefresh = useCallback')
    && librarySource.includes('window.clearTimeout(importListRefreshTimerRef.current)')
    && librarySource.includes('importListRefreshTimerRef.current = null'),
  'Library import list refreshes should be debounced and cleaned up.',
)
assert(
  librarySource.includes('const AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS = 60_000'),
  'Library import should keep PDF preview work out of the way long enough for auto-OCR upload to start.',
)
assert(
  processImportJobBody.includes('scheduleImportListRefresh()')
    && librarySource.includes('const refreshLibraryAfterImport = useCallback')
    && processImportJobBody.includes('await refreshLibraryAfterImport()')
    && !processImportJobBody.includes("if ((batchIndex + 1) % IMPORT_LIST_REFRESH_BATCHES === 0 || batchIndex === importBatches.length - 1) {\n          await loadDocuments(filter, { silent: true })"),
  'Library import batches should schedule non-blocking interim list refreshes while resetting to the first sorted page after import.',
)
assert(
  librarySource.includes('const IMPORT_LIST_REFRESH_BATCHES = 4')
    && librarySource.includes('const importListRefreshBatchCountRef = useRef<Map<number, number>>(new Map())')
    && processImportJobBody.includes('const completedRefreshBatches = (importListRefreshBatchCountRef.current.get(job.id) || 0) + 1')
    && processImportJobBody.includes('completedRefreshBatches % IMPORT_LIST_REFRESH_BATCHES === 0 && hasMoreImportBatches'),
  'Library import should throttle interim list refreshes while keeping progress visible during large jobs.',
)
assert(
  processImportJobBody.includes('const hasMoreSelectionBatches = Boolean(job.selectionId && !job.selectionDone)')
    && processImportJobBody.includes('if (!hasMoreSelectionBatches) {\n        importListRefreshBatchCountRef.current.delete(job.id)\n        await refreshLibraryAfterImport()')
    && processImportJobBody.includes('} else if (job.filePaths.length > 0 && (importedCount > 0 || duplicateCount > 0)) {\n        scheduleImportListRefresh()')
    && !processImportJobBody.includes('cancelScheduledImportListRefresh()\n        await refreshLibraryAfterImport()'),
  'Directory imports should defer the authoritative library refresh until the final selection batch while surfacing partial successes after an interrupted batch.',
)
assert(
  drainImportQueueBody.includes('if (job.filePaths.length === 0) {\n          await loadBaseData()\n        } else {\n          scheduleBaseDataRefresh()')
    && !drainImportQueueBody.includes('await loadBaseData()\n        await delay(0)'),
  'Directory import refills should not recompute sidebar counts after every file batch.',
)
assert(
  processImportJobBody.includes('const previewAutoOcrBackground = await window.api.getSetting(\'auto_ocr_after_import\')')
    && processImportJobBody.includes('const shouldDeferImportPdfPreview = shouldAttemptAutoOcrForPreview && previewAutoOcrConfigReady')
    && processImportJobBody.includes('createImportAutoOcrTask({')
    && processImportJobBody.includes('appendImportAutoOcrItems(task.jobId, appendBatch)')
    && processImportJobBody.includes('startImportAutoOcrTask(autoOcrTaskJobId)'),
  'Library import should snapshot automatic OCR readiness and persist every imported OCR item before starting execution.',
)
assert(
  !processImportJobBody.includes('const autoOcrQueue:')
    && processImportJobBody.includes('for (const appendBatch of chunkArray(autoOcrItems, 200))')
    && processImportJobBody.includes('persistedAutoOcrCount = appended.totalCount'),
  'Import auto-OCR must not retain unsubmitted future batches in renderer memory.',
)
assert(
  librarySource.includes('const cancelScheduledImportListRefresh = useCallback')
    && librarySource.includes('window.clearTimeout(importListRefreshTimerRef.current)')
    && librarySource.includes('importListRefreshTimerRef.current = null'),
  'Library import list refreshes should expose a cancel helper for final awaited refreshes.',
)
assert(
  librarySource.includes('let shouldRefreshAfterBatches = false')
    && librarySource.includes('shouldRefreshAfterBatches = true')
    && librarySource.includes('cancelScheduledImportListRefresh()')
    && librarySource.includes('if (shouldRefreshAfterBatches) {\n      cancelScheduledImportListRefresh()\n      await loadDocuments(filter, { silent: true })\n    }'),
  'OCR batch runner should coalesce document list refreshes and await only one final refresh after all OCR batches.',
)
assert(
  !librarySource.includes("successCount += await window.api.batchOcr(preparedBatch, { engine, forceFullRerun: options?.forceFullRerun, concurrency: documentConcurrency })\n      await loadDocuments(filter, { silent: true })")
    && !librarySource.includes("if (preparedBatch.length === 0) {\n        await loadDocuments(filter, { silent: true })"),
  'OCR batch runner should not block between batches on document list reloads.',
)
assert(
  processImportJobBody.includes('readyForAutoOcr = await preparePdfPagesForOcrAfterImport(')
    && !processImportJobBody.includes('if (readyForAutoOcr) scheduleImportListRefresh()'),
  'Non-Paddle import auto-OCR should prepare page images without reloading the library after every file.',
)
assert(
  librarySource.includes("const OCR_ACTIVITY_MESSAGE_KEY = 'ocr-activity'")
    && librarySource.includes("const OCR_RESULT_MESSAGE_KEY = 'ocr-result'")
    && handleBatchOcrBody.includes('await runOcrInConfiguredBatches(targetIds, engine, OCR_ACTIVITY_MESSAGE_KEY')
    && handleBatchOcrBody.includes('message.success({')
    && handleBatchOcrBody.includes("message.error({ content: '批量 OCR 识别失败', key: OCR_RESULT_MESSAGE_KEY, duration: 6 })"),
  'Manual batch OCR handler structure should remain recognizable for duplicate refresh checks.',
)
assert(
  !handleBatchOcrBody.includes("key: OCR_RESULT_MESSAGE_KEY,\n        duration: 4,\n      })\n      await loadDocuments()")
    && handleBatchOcrBody.includes("message.error({ content: '批量 OCR 识别失败', key: OCR_RESULT_MESSAGE_KEY, duration: 6 })\n      await loadDocuments(filter, { silent: true })"),
  'Manual batch OCR success path should rely on runOcrInConfiguredBatches refreshes while failure still refreshes the list.',
)
assert(
  handleRetryDocumentBody.includes('const successCount = await runOcrInConfiguredBatches([doc.id], retryEngine || \'paddle\', OCR_ACTIVITY_MESSAGE_KEY)')
    && !handleRetryDocumentBody.includes("message.warning({ content: '重新处理未完成，请查看失败原因后再试', key: OCR_RESULT_MESSAGE_KEY, duration: 5 })\n      }\n      await loadDocuments(filter, { silent: true })"),
  'Single document retry success path should not await an extra list reload after runOcrInConfiguredBatches.',
)
assert(
  handleForceRerunDocumentBody.includes('const successCount = await runOcrInConfiguredBatches([doc.id], engine, OCR_ACTIVITY_MESSAGE_KEY, { forceFullRerun: true })')
    && !handleForceRerunDocumentBody.includes("message.warning({ content: '重新 OCR 未完成，请查看失败原因后再试', key: OCR_RESULT_MESSAGE_KEY, duration: 5 })\n      }\n      await loadDocuments(filter, { silent: true })"),
  'Single document full OCR rerun success path should not await an extra list reload after runOcrInConfiguredBatches.',
)
assert(
  !handleForceRerunDocumentBody.includes('Modal.confirm(')
    && !confirmBatchForceRerunOcrBody.includes('Modal.confirm('),
  'Full OCR rerun should not block the library with a modal confirmation.',
)
assert(
  handleRetryFailedDocumentsBody.includes("const successCount = await runOcrInConfiguredBatches(failedDocs.map((doc) => doc.id), 'paddle', OCR_ACTIVITY_MESSAGE_KEY)")
    && !handleRetryFailedDocumentsBody.includes("message.success({ content: `重试完成，成功处理 ${successCount}/${failedDocs.length} 篇`, key: OCR_RESULT_MESSAGE_KEY, duration: 4 })\n      await loadDocuments(filter, { silent: true })"),
  'Failed-document retry success path should not await an extra list reload after runOcrInConfiguredBatches.',
)
assert(
  handleBatchImportBody.includes('const followEngine = importOcrEngine')
    && handleBatchImportBody.includes('const hasConfig = await hasOcrEngineConfig(followEngine)')
    && handleBatchImportBody.includes('const count = await runOcrInConfiguredBatches(targetIds, followEngine, OCR_ACTIVITY_MESSAGE_KEY)')
    && handleBatchImportBody.includes('} else {\n        await loadDocuments()\n      }')
    && handleBatchImportBody.includes("message.success({ content: `OCR 完成，成功识别 ${count} 篇文献`, key: OCR_RESULT_MESSAGE_KEY, duration: 4 })")
    && !handleBatchImportBody.includes("duration: 4 })\n      }\n\n      await loadDocuments()")
    && !handleBatchImportBody.includes("message.success({ content: `OCR 完成，成功识别 ${count} 篇文献`, key: 'batch-follow-ocr' })\n      }\n\n      await loadDocuments()"),
  'Batch import should skip the extra final list reload when follow-up OCR already refreshed, while still refreshing when OCR is not started.',
)
assert(
  !processImportJobBody.includes('const queuedResults: Array')
    && !processImportJobBody.includes('failedResults = queuedResults.map'),
  'Library import processing should not accumulate every batch result before starting follow-up work.',
)
assert(
  librarySource.includes('const BASE_DATA_REFRESH_DEBOUNCE_MS = 600')
    && librarySource.includes('const BASE_DATA_BUSY_RETRY_DELAYS_MS = [800, 1600, 3200]')
    && librarySource.includes('function isTransientDatabaseBusyError')
    && librarySource.includes('const baseDataRefreshTimerRef = useRef<number | null>(null)')
    && librarySource.includes('const baseDataBusyRetryCountRef = useRef(0)')
    && librarySource.includes('const scheduleBaseDataRefresh = useCallback')
    && librarySource.includes('window.clearTimeout(baseDataRefreshTimerRef.current)')
    && librarySource.includes('baseDataRefreshTimerRef.current = null'),
  'Library base data refreshes should be debounced and cleaned up to avoid repeated IPC churn.',
)
assert(
  librarySource.includes('if (isTransientDatabaseBusyError(error))')
    && librarySource.includes('BASE_DATA_BUSY_RETRY_DELAYS_MS[retryIndex]')
    && librarySource.includes("message.error({ content: '加载目录和标签失败', key: 'library-base-data-load', duration: 4 })")
    && !librarySource.includes("message.error('加载目录和标签失败')"),
  'Library folder/tag loading should retry transient SQLite busy errors and avoid duplicate error toasts.',
)
assert(
  flushOcrStatusBufferBody.includes("data.phase === 'ai' && data.aiStatus === 'completed'")
    && flushOcrStatusBufferBody.includes('scheduleBaseDataRefresh()')
    && !flushOcrStatusBufferBody.includes('void loadBaseData()'),
  'AI metadata completion should schedule one debounced base-data refresh instead of reloading folders/tags per document.',
)

console.log('Library import queue persistence regression passed.')
