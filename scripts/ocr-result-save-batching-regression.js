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
const ocrIpcSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
const semanticSearchSource = fs.readFileSync(path.join(root, 'src', 'main', 'semantic-search.ts'), 'utf8')
const searchIndexConstantsSource = fs.readFileSync(path.join(root, 'src', 'main', 'search-index-constants.ts'), 'utf8')
const pdfAssetsSource = fs.readFileSync(path.join(root, 'src', 'main', 'pdf-assets.ts'), 'utf8')
const markSearchIndexStaleForDocumentsBody = sliceBetween(
  semanticSearchSource,
  'export function markSearchIndexStaleForDocuments',
  'export function markSearchIndexStaleForPages',
  'search stale document marker body',
)
const scheduleBackgroundReindexBody = sliceBetween(
  semanticSearchSource,
  'function scheduleBackgroundReindex',
  'function parseSegmentMeta',
  'search background reindex scheduler body',
)
const drainReindexQueueBody = sliceBetween(
  semanticSearchSource,
  'async function drainReindexQueue',
  'function scheduleBackgroundReindex',
  'search background reindex drain body',
)
const saveOptions = sliceBetween(
  ocrIpcSource,
  'interface SavePageOcrResultsOptions',
  'const activeOcrTasks',
  'OCR save options',
)
const savePageOcrResultsBody = sliceBetween(
  ocrIpcSource,
  'function savePageOcrResults',
  'async function savePageOcrResultsBatched',
  'OCR page result save body',
)
const savePageOcrResultsBatchedBody = sliceBetween(
  ocrIpcSource,
  'async function savePageOcrResultsBatched',
  'async function processDocumentOcr',
  'batched OCR page result save body',
)
const scheduleOcrFinalizeForPagesBody = sliceBetween(
  ocrIpcSource,
  'function scheduleOcrFinalizeForPages',
  'function waitForOcrShutdown',
  'OCR finalize scheduling body',
)
const processDocumentOcrBody = sliceBetween(
  ocrIpcSource,
  'async function processDocumentOcr',
  'export function registerOcrIpc',
  'OCR document process body',
)
const postProcessPdfOcrResultsBatchedBody = sliceBetween(
  ocrIpcSource,
  'async function postProcessPdfOcrResultsBatched',
  'async function recognizeSinglePage',
  'batched PDF OCR result post-processing helper',
)
const deferredSingleSaveBody = sliceBetween(
  processDocumentOcrBody,
  'const savePageOcrResultsDeferred =',
  'const savePageOcrResultsBatchedDeferred =',
  'deferred single OCR save helper',
)
const deferredBatchedSaveBody = sliceBetween(
  processDocumentOcrBody,
  'const savePageOcrResultsBatchedDeferred =',
  'try {',
  'deferred batched OCR save helper',
)
const finallyBody = sliceBetween(
  processDocumentOcrBody,
  '} finally {',
  'const finalStatus =',
  'OCR process finally body',
)
const asyncPdfBranchBody = sliceBetween(
  processDocumentOcrBody,
  '} else if (canUsePdfAsync && pdfPath) {',
  'const missingImagePage = findMissingReadablePageImage',
  'async PDF OCR branch',
)
const asyncChunkCompleteBody = sliceBetween(
  asyncPdfBranchBody,
  'onChunkComplete: async (chunk) => {',
  '          },',
  'async PDF chunk completion body',
)
const autoCleanupPdfAssetsIfEnabledBody = sliceBetween(
  pdfAssetsSource,
  'export function autoCleanupPdfAssetsIfEnabled',
  'export async function shutdownPdfAssetRuntime',
  'auto PDF asset cleanup body',
)
const ocrSaveChunkSize = Number((ocrIpcSource.match(/const OCR_RESULT_SAVE_CHUNK_SIZE = (\d+)/) || [])[1] || 0)
const ocrPostprocessChunkSize = Number((ocrIpcSource.match(/const OCR_RESULT_POSTPROCESS_CHUNK_SIZE = (\d+)/) || [])[1] || 0)

assert(
  saveOptions.includes('deferDatabaseSave?: boolean'),
  'OCR result save options should explicitly support deferring database checkpoints.',
)
assert(
  saveOptions.includes('onTocDirtyDocIds?:'),
  'OCR result save options should allow callers to collect dirty TOC document ids for deferred invalidation.',
)
assert(
  savePageOcrResultsBody.includes('if (!options.deferDatabaseSave)')
    && savePageOcrResultsBody.includes('scheduleDatabaseSave()'),
  'savePageOcrResults should skip scheduleDatabaseSave when deferred by its caller.',
)
assert(
  savePageOcrResultsBody.includes('options.onTocDirtyDocIds?.([...tocDirtyDocIds])'),
  'savePageOcrResults should report dirty TOC document ids to callers that defer TOC invalidation.',
)
assert(
  ocrIpcSource.includes('function getPageSnapshotsForOcrSave')
    && ocrIpcSource.includes('SELECT id, doc_id, page_num, proofed_text, ocr_text, ocr_text_ref, ocr_result, ocr_result_ref, ocr_status')
    && ocrIpcSource.includes('hydratePagePayloadRows(rows)')
    && savePageOcrResultsBody.includes('const guardedPageResults = pageResults.map(guardRepeatedOcrPageResult)')
    && savePageOcrResultsBody.includes('pageSnapshots = getPageSnapshotsForOcrSave(guardedPageResults.map((pageResult) => pageResult.pageId))')
    && savePageOcrResultsBody.includes('const existingPage = pageSnapshots.get(pageResult.pageId)'),
  'savePageOcrResults should prefetch and hydrate page save snapshots once per save batch.',
)
assert(
  ocrIpcSource.includes('function guardRepeatedOcrPageResult')
    && ocrIpcSource.includes('findSuspiciousRepeatedOcrText(pageResult.result || pageResult.text)')
    && ocrIpcSource.includes('formatSuspiciousRepeatedOcrTextIssue(repeatedIssue)')
    && savePageOcrResultsBody.indexOf('const guardedPageResults = pageResults.map(guardRepeatedOcrPageResult)') < savePageOcrResultsBody.indexOf('transaction(() => {'),
  'savePageOcrResults should guard suspicious repeated OCR text before writing page rows.',
)
assert(
  !savePageOcrResultsBody.includes("queryOne<{")
    && !savePageOcrResultsBody.includes("SELECT doc_id, proofed_text, ocr_text, ocr_result, ocr_status FROM pages WHERE id = ?")
    && savePageOcrResultsBody.includes('const existingPage = pageSnapshots.get(pageResult.pageId)'),
  'savePageOcrResults should not query page metadata once per result while saving a batch.',
)
assert(
  ocrIpcSource.includes('function markPageOcrVersionsInactive')
    && ocrIpcSource.includes('UPDATE page_ocr_versions SET is_active = 0 WHERE page_id IN')
    && savePageOcrResultsBody.includes('const versionWrites: OcrVersionWrite[] = []')
    && savePageOcrResultsBody.includes('versionWrites.push({')
    && savePageOcrResultsBody.includes('markPageOcrVersionsInactive(versionWrites.map((item) => item.pageId))')
    && savePageOcrResultsBody.includes('upsertPageOcrVersion(item.pageId, engine, item.result, item.text, item.status, item.page')
    && savePageOcrResultsBody.includes('deactivateExisting: false'),
  'savePageOcrResults should mark previous OCR versions inactive once per save batch before upserting active versions.',
)
assert(
  !savePageOcrResultsBody.includes("run('UPDATE page_ocr_versions SET is_active = 0 WHERE page_id = ?'")
    && !savePageOcrResultsBody.includes('markPageOcrVersionsInactive([pageId])'),
  'savePageOcrResults should not mark OCR versions inactive once per saved page.',
)
assert(
  scheduleOcrFinalizeForPagesBody.includes('const previousPendingPageCount = pendingOcrFinalizePageIds.size')
    && scheduleOcrFinalizeForPagesBody.includes('const addedPageCount = pendingOcrFinalizePageIds.size - previousPendingPageCount')
    && scheduleOcrFinalizeForPagesBody.includes('if (addedPageCount > 0 && !ocrFinalizeTimer && !ocrFinalizeRunning)')
    && scheduleOcrFinalizeForPagesBody.includes("status: 'queued'"),
  'OCR finalize scheduling should coalesce queued status events instead of emitting one for every save batch.',
)
assert(
  !markSearchIndexStaleForDocumentsBody.includes('resolveSearchableDocumentIds')
    && markSearchIndexStaleForDocumentsBody.includes('scheduleBackgroundReindex(uniqueDocIds, { activeResolved: true })'),
  'OCR save finalization should queue changed documents for background search indexing without synchronously scanning their pages first.',
)
assert(
  savePageOcrResultsBatchedBody.includes('const tocDirtyDocIds = new Set<string>()')
    && savePageOcrResultsBatchedBody.includes('markTocDirty: false')
    && savePageOcrResultsBatchedBody.includes('deferFinalize: true')
    && savePageOcrResultsBatchedBody.includes('deferDatabaseSave: true')
    && savePageOcrResultsBatchedBody.includes('onTocDirtyDocIds: (docIds) => docIds.forEach((docId) => tocDirtyDocIds.add(docId))'),
  'batched OCR saves should defer per-chunk TOC invalidation, finalization, and database checkpoints.',
)
assert(
  ocrSaveChunkSize >= 50,
  'OCR result save batches should be large enough to avoid hundreds of SQLite transactions for multi-thousand-page PDFs.',
)
assert(
  savePageOcrResultsBatchedBody.includes('tocDirtyDocIds.forEach(markDocumentTocDirty)')
    && savePageOcrResultsBatchedBody.includes('options.onTocDirtyDocIds?.([...tocDirtyDocIds])')
    && savePageOcrResultsBatchedBody.includes('scheduleOcrFinalizeForPages(changedPageIds)')
    && savePageOcrResultsBatchedBody.includes('scheduleDatabaseSave()'),
  'batched OCR saves should coalesce TOC invalidation, finalization, and checkpointing once after all chunks.',
)
assert(
  !savePageOcrResultsBatchedBody.includes('savePageOcrResults(pageResults.slice(index, index + OCR_RESULT_SAVE_CHUNK_SIZE), engine, options)'),
  'batched OCR saves should not pass caller options directly to each chunk because that schedules repeated finalize/checkpoint work.',
)
assert(
  processDocumentOcrBody.includes('let deferredDatabaseSaveNeeded = false'),
  'processDocumentOcr should track whether deferred OCR saves need a final database checkpoint.',
)
assert(
  ocrIpcSource.includes('let autoMetadataQueue = Promise.resolve()')
    && ocrIpcSource.includes('const AUTO_METADATA_START_DELAY_MS = 5_000')
    && ocrIpcSource.includes('const AUTO_METADATA_QUEUE_TIMEOUT_MS = 30 * 60_000')
    && ocrIpcSource.includes('function queuedAutoExtractAndApply')
    && ocrIpcSource.includes('autoExtractAndApply(docId)')
    && ocrIpcSource.includes('AUTO_METADATA_TIMEOUT_MS')
    && processDocumentOcrBody.includes('AUTO_METADATA_QUEUE_TIMEOUT_MS')
    && processDocumentOcrBody.includes('queuedAutoExtractAndApply(docId)'),
  'Automatic AI metadata extraction after OCR should run through a delayed serial queue instead of competing immediately with upload/save work.',
)
assert(
  deferredSingleSaveBody.includes('deferFinalize: true')
    && deferredSingleSaveBody.includes('deferDatabaseSave: true'),
  'single deferred OCR result saves should defer both finalization and database checkpointing.',
)
assert(
  deferredSingleSaveBody.includes('markTocDirty: false')
    && deferredSingleSaveBody.includes('onTocDirtyDocIds:')
    && deferredSingleSaveBody.includes('deferredTocDirtyDocIds.add(tocDocId)'),
  'single deferred OCR result saves should collect TOC dirty doc ids instead of invalidating TOC per save.',
)
assert(
  deferredSingleSaveBody.includes('if (changedPageIds.length > 0) deferredDatabaseSaveNeeded = true'),
  'single deferred OCR saves should request a final checkpoint after changed pages.',
)
assert(
  deferredBatchedSaveBody.includes('deferFinalize: true')
    && deferredBatchedSaveBody.includes('deferDatabaseSave: true'),
  'batched deferred OCR result saves should defer both finalization and database checkpointing.',
)
assert(
  deferredBatchedSaveBody.includes('markTocDirty: false')
    && deferredBatchedSaveBody.includes('onTocDirtyDocIds:')
    && deferredBatchedSaveBody.includes('deferredTocDirtyDocIds.add(tocDocId)'),
  'batched deferred OCR result saves should collect TOC dirty doc ids instead of invalidating TOC per save.',
)
assert(
  deferredBatchedSaveBody.includes('if (changedPageIds.length > 0) deferredDatabaseSaveNeeded = true'),
  'batched deferred OCR saves should request a final checkpoint after changed pages.',
)
assert(
  finallyBody.includes('if (deferredDatabaseSaveNeeded)')
    && finallyBody.includes('scheduleDatabaseSave()')
    && finallyBody.includes('deferredDatabaseSaveNeeded = false'),
  'processDocumentOcr finally block should schedule one database checkpoint for deferred OCR saves.',
)
assert(
  finallyBody.includes('deferredTocDirtyDocIds.forEach(markDocumentTocDirty)')
    && finallyBody.includes('deferredTocDirtyDocIds.clear()')
    && finallyBody.includes('deferredDatabaseSaveNeeded = true'),
  'processDocumentOcr finally block should coalesce deferred TOC invalidation and checkpoint it once.',
)
assert(
  ocrPostprocessChunkSize >= 50,
  'OCR result post-processing batches should be large enough to avoid hundreds of scheduling rounds for multi-thousand-page PDFs.',
)
assert(
  postProcessPdfOcrResultsBatchedBody.includes('index += OCR_RESULT_POSTPROCESS_CHUNK_SIZE')
    && postProcessPdfOcrResultsBatchedBody.includes('await yieldToEventLoop()')
    && postProcessPdfOcrResultsBatchedBody.includes('postProcessRecognizedPageResult'),
  'PDF OCR async results should be post-processed in small chunks while yielding between chunks.',
)
assert(
  !processDocumentOcrBody.includes('Promise.all(chunkPages.map')
    && !processDocumentOcrBody.includes('Promise.all(pages.map(async (page, index)'),
  'PDF OCR async result handling should not post-process whole chunks or full documents in one Promise.all.',
)
assert(
  processDocumentOcrBody.includes('await savePageOcrResultsBatchedDeferred(chunkPageResults, \'paddle\'')
    && processDocumentOcrBody.includes('pageResults = await postProcessPdfOcrResultsBatched(')
    && asyncPdfBranchBody.includes('collectChunkResults: false'),
  'PDF OCR chunk completion should batch both result post-processing and database saves without retaining the whole document result array.',
)
assert(
  asyncPdfBranchBody.indexOf('if (asyncResults.length === 0)') > asyncPdfBranchBody.indexOf('} else {')
    && asyncPdfBranchBody.indexOf('if (asyncResults.length === 0)') < asyncPdfBranchBody.indexOf('pageResults = await postProcessPdfOcrResultsBatched('),
  'PDF OCR should not treat an empty async return as zero-page failure after chunks were already saved to the database.',
)
assert(
  asyncPdfBranchBody.includes('pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)')
    && asyncPdfBranchBody.includes('pagesForOcr.map((page, index) => ({ page, sourcePageIndex: Number(page.page_num || index + 1) - 1, resultIndex: index }))')
    && !asyncPdfBranchBody.includes('pages.map((page, index) => ({ page, sourcePageIndex: index, resultIndex: index }))'),
  'PDF OCR async fallback save path should post-process only unfinished resume pages and map results by original page number.',
)
assert(
  ocrIpcSource.includes('function hasSequentialPageRecords')
    && ocrIpcSource.includes('function ensurePageRecordsIfNeeded')
    && ocrIpcSource.includes('hasSequentialPageRecords(pages, pageCount) ? pages : ensurePageRecords(docId, pageCount)')
    && asyncChunkCompleteBody.includes('pages = await ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, chunk.totalPages))')
    && processDocumentOcrBody.includes('pages = await ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, asyncResults.length))'),
  'PDF OCR async result handling should reuse complete in-memory page records instead of forcing page table rescans for every chunk.',
)
assert(
  !asyncChunkCompleteBody.includes('pages = ensurePageRecords(docId'),
  'PDF OCR chunk completion should not force ensurePageRecords when current page records are already complete.',
)
assert(
  asyncPdfBranchBody.includes('const savedAsyncPageIds = new Set')
    && asyncChunkCompleteBody.includes('savedAsyncPageIds.add(pageResult.pageId)')
    && asyncPdfBranchBody.includes('const savedAsyncFailedPageIds = new Set<string>()')
    && asyncChunkCompleteBody.includes('savedAsyncFailedPageIds.delete(pageResult.pageId)')
    && asyncChunkCompleteBody.includes('savedAsyncFailedPageIds.add(pageResult.pageId)')
    && asyncChunkCompleteBody.includes('savedAsyncPageCount = Math.max(savedAsyncPageCount, savedAsyncPageIds.size)'),
  'PDF OCR chunk completion should track saved progress and failures incrementally instead of recounting the whole document after each chunk.',
)
assert(
  !asyncChunkCompleteBody.includes("queryAll<OcrPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num'")
    && !asyncChunkCompleteBody.includes('getCompletedOcrPageCount(pages)'),
  'PDF OCR chunk completion should not rescan every page after saving each chunk.',
)
assert(
  processDocumentOcrBody.includes('let streamedAsyncPageSummary:')
    && asyncPdfBranchBody.includes('streamedAsyncPageSummary = {')
    && asyncPdfBranchBody.includes('completed: savedAsyncPageIds.size')
    && asyncPdfBranchBody.includes('failed: savedAsyncFailedPageIds.size')
    && processDocumentOcrBody.includes('streamedAsyncPageSummary || summarizeDocumentOcrPages(docId)'),
  'PDF OCR final status should reuse the streamed chunk summary and only fall back to a full page summary when streaming summary is unavailable.',
)
assert(
  markSearchIndexStaleForDocumentsBody.includes('scheduleBackgroundReindex(uniqueDocIds, { activeResolved: true })'),
  'search stale document marker should pass already-resolved active doc ids to the reindex scheduler.',
)
assert(
  !markSearchIndexStaleForDocumentsBody.includes("status = 'pending'")
    && !markSearchIndexStaleForDocumentsBody.includes("[docId, 'pending'")
    && !markSearchIndexStaleForDocumentsBody.includes("'pending', '', 0"),
  'search stale document marker should not write a redundant pending status before queueing reindex.',
)
assert(
  scheduleBackgroundReindexBody.includes('const newlyQueuedDocIds: string[] = []')
    && scheduleBackgroundReindexBody.includes('if (queuedReindexDocIds.has(docId)) return')
    && scheduleBackgroundReindexBody.includes('newlyQueuedDocIds.push(docId)')
    && scheduleBackgroundReindexBody.includes("updateSearchIndexStatus(docId, 'queued')")
    && scheduleBackgroundReindexBody.includes('if (newlyQueuedDocIds.length > 0)'),
  'search background reindex scheduling should only write queued status for newly queued documents.',
)
assert(
  searchIndexConstantsSource.includes('BACKGROUND_REINDEX_DRAIN_BATCH_SIZE')
    && searchIndexConstantsSource.includes('BACKGROUND_REINDEX_DRAIN_PAUSE_MS')
    && semanticSearchSource.includes('BACKGROUND_REINDEX_DRAIN_BATCH_SIZE')
    && semanticSearchSource.includes('BACKGROUND_REINDEX_DRAIN_PAUSE_MS'),
  'search background reindexing should expose explicit drain batch and pause controls.',
)
assert(
  drainReindexQueueBody.includes('let processedThisDrain = 0')
    && drainReindexQueueBody.includes('processedThisDrain < BACKGROUND_REINDEX_DRAIN_BATCH_SIZE')
    && drainReindexQueueBody.includes('processedThisDrain += 1'),
  'search background reindexing should process a bounded number of documents per drain cycle.',
)
assert(
  drainReindexQueueBody.includes('scheduleBackgroundReindex([], { delayMs: BACKGROUND_REINDEX_DRAIN_PAUSE_MS })')
    && scheduleBackgroundReindexBody.includes('options: { activeResolved?: boolean; delayMs?: number }')
    && scheduleBackgroundReindexBody.includes('options.delayMs ?? BACKGROUND_REINDEX_DELAY_MS'),
  'search background reindexing should pause before continuing a non-empty queue after each drain batch.',
)
assert(
  semanticSearchSource.includes('let reindexDrainCompletedCount = 0')
    && semanticSearchSource.includes('let reindexDrainErrorCount = 0')
    && semanticSearchSource.includes('let reindexDrainTotalCount = 0')
    && drainReindexQueueBody.includes('reindexDrainCompletedCount += 1')
    && drainReindexQueueBody.includes('const completedCount = reindexDrainCompletedCount')
    && drainReindexQueueBody.includes('reindexDrainCompletedCount = 0')
    && drainReindexQueueBody.includes('reindexDrainTotalCount = 0'),
  'search background reindexing should preserve progress across paused drain cycles and reset it only after the queue is empty.',
)
assert(
  processDocumentOcrBody.includes('autoCleanupPdfAssetsIfEnabled(docId)')
    && autoCleanupPdfAssetsIfEnabledBody.includes('new Promise<void>((resolve) => setImmediate(resolve))')
    && autoCleanupPdfAssetsIfEnabledBody.includes('cleanupPdfAssetsAsync(docId)')
    && autoCleanupPdfAssetsIfEnabledBody.includes('activeAutoCleanupPdfAssetJobs.add(job)')
    && !autoCleanupPdfAssetsIfEnabledBody.includes('cleanupPdfAssets(docId)'),
  'Automatic PDF asset cleanup after OCR should be queued asynchronously instead of blocking the OCR completion path.',
)

console.log('OCR result save batching regression passed.')
