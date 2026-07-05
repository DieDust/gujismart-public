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
const processImportJobBody = sliceBetween(
  librarySource,
  'const processImportJob = async',
  'const drainImportQueue = async',
  'Library import job processor',
)
const flushOcrStatusBufferBody = sliceBetween(
  librarySource,
  'const flushOcrStatusBuffer = useCallback',
  'useEffect(() => {\n    void loadBaseData()',
  'OCR status UI flush',
)
const runImportOcrQueueBody = sliceBetween(
  librarySource,
  'const runImportOcrQueue = async',
  'const getQueuedImportFileCount =',
  'Import OCR queue',
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
  'Library import queue should have a versioned localStorage key',
)
assert(
  librarySource.includes('interface PersistedImportQueueState') && librarySource.includes('type PersistedImportQueueJob'),
  'Library import queue should persist a structured queue snapshot',
)
assert(
  librarySource.includes('activeImportJobRef') && librarySource.includes('restoredImportQueueRef'),
  'Library import queue should track the active job and restore only once',
)
assert(
  librarySource.includes('function LibraryView') && librarySource.includes('persistImportQueueSnapshot'),
  'Library import queue should persist snapshots from the LibraryView workflow',
)
assert(
  librarySource.includes('window.localStorage.setItem(LIBRARY_IMPORT_QUEUE_STORAGE_KEY, JSON.stringify(payload))'),
  'Library import queue should write pending jobs to localStorage',
)
assert(
  librarySource.includes('window.localStorage.removeItem(LIBRARY_IMPORT_QUEUE_STORAGE_KEY)'),
  'Library import queue should clear localStorage when no jobs remain',
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
  librarySource.includes('importQueueRef.current.unshift(job)') && librarySource.includes('if (job.filePaths.length > 0) break'),
  'Library import queue should keep unfinished paths queued after an outer import failure instead of dropping them',
)
assert(
  librarySource.includes('function rebuildQueuedImportPathSet') || librarySource.includes('const rebuildQueuedImportPathSet'),
  'Library import queue should rebuild duplicate tracking after preserving unfinished queued paths',
)
assert(
  librarySource.includes('if (!libraryInitialLoadDone) return') && librarySource.includes('parsePersistedImportQueue()'),
  'Library import queue should wait for the first document list load before restoring',
)
assert(
  librarySource.includes('filterRestoredImportFilePaths(job.filePaths)'),
  'Restored import queue should filter already-loaded non-PDF duplicates before enqueueing',
)
assert(
  librarySource.includes("if (doc.import_status === 'error' || doc.import_status === 'processing' || doc.import_status === 'deleting') return")
    && librarySource.includes('restorableExistingNames'),
  'Restored import queue should not let half-written or failed imports block re-importing the original file',
)
assert(
  librarySource.includes('enqueueImportJob(filePaths, job.folderId, job.folderAssignments, { engine: job.engine, restored: true })'),
  'Restored import queue should preserve the OCR engine and folder assignments',
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
  librarySource.includes('const IMPORT_LIST_REFRESH_BATCHES = 1')
    && processImportJobBody.includes("if ((batchIndex + 1) % IMPORT_LIST_REFRESH_BATCHES === 0 && batchIndex !== importBatches.length - 1) {\n          scheduleImportListRefresh()\n        }"),
  'Library import should schedule a debounced list refresh after every completed import batch so new documents appear promptly.',
)
assert(
  processImportJobBody.includes('const previewAutoOcrBackground = await window.api.getSetting(\'auto_ocr_after_import\')')
    && processImportJobBody.includes('const shouldDeferImportPdfPreview = shouldAttemptAutoOcrForPreview && previewAutoOcrConfigReady')
    && processImportJobBody.includes('const autoOcrBackground = await window.api.getSetting(\'auto_ocr_after_import\')')
    && processImportJobBody.includes('const hasConfig = await hasOcrEngineConfig(engine)'),
  'Library import should defer PDF preview work only from an early auto-OCR readiness snapshot while final auto-OCR launch still rechecks settings.',
)
assert(
  runImportOcrQueueBody.includes("successCount += await runOcrInConfiguredBatches(batch, engine, 'auto-ocr')")
    && !runImportOcrQueueBody.includes("successCount += await runOcrInConfiguredBatches(batch, engine, 'auto-ocr')\n      await loadDocuments(filter, { silent: true })"),
  'Import auto-OCR should rely on runOcrInConfiguredBatches refreshes instead of awaiting a duplicate outer list reload after every batch.',
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
  runImportOcrQueueBody.includes('scheduleImportListRefresh()')
    && !runImportOcrQueueBody.includes("if (!ready) continue\n        await loadDocuments(filter, { silent: true })"),
  'Import auto-OCR PDF page preparation should schedule a debounced list refresh instead of blocking the OCR queue.',
)
assert(
  handleBatchOcrBody.includes("await runOcrInConfiguredBatches(targetIds, engine, 'batch-ocr'")
    && handleBatchOcrBody.includes("message.success({")
    && handleBatchOcrBody.includes("message.error({ content: '批量 OCR 识别失败', key: 'batch-ocr' })"),
  'Manual batch OCR handler structure should remain recognizable for duplicate refresh checks.',
)
assert(
  !handleBatchOcrBody.includes("key: 'batch-ocr',\n      })\n      await loadDocuments()")
    && handleBatchOcrBody.includes("message.error({ content: '批量 OCR 识别失败', key: 'batch-ocr' })\n      await loadDocuments(filter, { silent: true })"),
  'Manual batch OCR success path should rely on runOcrInConfiguredBatches refreshes while failure still refreshes the list.',
)
assert(
  handleRetryDocumentBody.includes('const successCount = await runOcrInConfiguredBatches([doc.id], retryEngine || \'paddle\', `retry-${doc.id}`)')
    && !handleRetryDocumentBody.includes("message.warning({ content: '重新处理未完成，请查看失败原因后再试', key: `retry-${doc.id}`, duration: 5 })\n      }\n      await loadDocuments(filter, { silent: true })"),
  'Single document retry success path should not await an extra list reload after runOcrInConfiguredBatches.',
)
assert(
  handleForceRerunDocumentBody.includes('const successCount = await runOcrInConfiguredBatches([doc.id], engine, `rerun-ocr-${doc.id}`, { forceFullRerun: true })')
    && !handleForceRerunDocumentBody.includes("message.warning({ content: '重新 OCR 未完成，请查看失败原因后再试', key: `rerun-ocr-${doc.id}`, duration: 5 })\n          }\n          await loadDocuments(filter, { silent: true })"),
  'Single document full OCR rerun success path should not await an extra list reload after runOcrInConfiguredBatches.',
)
assert(
  !handleForceRerunDocumentBody.includes('Modal.confirm(')
    && !confirmBatchForceRerunOcrBody.includes('Modal.confirm('),
  'Full OCR rerun should not block the library with a modal confirmation.',
)
assert(
  handleRetryFailedDocumentsBody.includes("const successCount = await runOcrInConfiguredBatches(failedDocs.map((doc) => doc.id), 'paddle', 'retry-failed')")
    && !handleRetryFailedDocumentsBody.includes("message.success({ content: `重试完成，成功处理 ${successCount}/${failedDocs.length} 篇`, key: 'retry-failed' })\n      await loadDocuments(filter, { silent: true })"),
  'Failed-document retry success path should not await an extra list reload after runOcrInConfiguredBatches.',
)
assert(
  handleBatchImportBody.includes('const followEngine = importOcrEngine')
    && handleBatchImportBody.includes('const hasConfig = await hasOcrEngineConfig(followEngine)')
    && handleBatchImportBody.includes("const count = await runOcrInConfiguredBatches(targetIds, followEngine, 'batch-follow-ocr')")
    && handleBatchImportBody.includes('} else {\n        await loadDocuments()\n      }')
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
