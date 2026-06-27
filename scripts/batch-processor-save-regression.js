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
const batchSource = fs.readFileSync(path.join(root, 'src', 'main', 'batch-processor.ts'), 'utf8')
const savePageResultsBody = sliceBetween(
  batchSource,
  'private async savePageResults',
  'private async postProcessPdfResultsBatched',
  'batch page result save body',
)
const postProcessPdfResultsBatchedBody = sliceBetween(
  batchSource,
  'private async postProcessPdfResultsBatched',
  'setMainWindow',
  'batch PDF result post-processing helper',
)
const processBatchBody = sliceBetween(
  batchSource,
  'private async processBatch',
  'pauseJob',
  'batch document processing body',
)
const asyncPdfBranchBody = sliceBetween(
  processBatchBody,
  'if (canUsePdfAsync && pdfPath) {',
  '} else {',
  'batch async PDF branch',
)

assert(
  batchSource.includes('const BATCH_RESULT_POSTPROCESS_CHUNK_SIZE = 12'),
  'Legacy batch OCR processor should have an explicit PDF result post-processing chunk size.',
)
assert(
  postProcessPdfResultsBatchedBody.includes('index += BATCH_RESULT_POSTPROCESS_CHUNK_SIZE')
    && postProcessPdfResultsBatchedBody.includes('await yieldToEventLoop()')
    && postProcessPdfResultsBatchedBody.includes('postProcessRecognizedPageResult')
    && postProcessPdfResultsBatchedBody.includes('const postProcessOptions = getAsyncPdfPostProcessOptions(ocrOptions)')
    && postProcessPdfResultsBatchedBody.includes('postProcessRecognizedPageResult(rawResult, item.page.image_path, postProcessOptions')
    && batchSource.includes('function getAsyncPdfPostProcessOptions')
    && batchSource.includes("secondPass: 'none'"),
  'Legacy batch PDF OCR results should be post-processed in small chunks while yielding between chunks.',
)
assert(
  asyncPdfBranchBody.includes('onChunkComplete: async (chunk) => {')
    && asyncPdfBranchBody.includes('await this.postProcessPdfResultsBatched(')
    && asyncPdfBranchBody.includes('await this.savePageResults(chunkPageResults,')
    && asyncPdfBranchBody.includes('pageResultsPersistedInChunks = true')
    && asyncPdfBranchBody.includes('collectChunkResults: false'),
  'Legacy batch PDF OCR should save completed async chunks and avoid retaining the whole document result array.',
)
assert(
  processBatchBody.includes('let streamedPageSummary = { total: 0, completed: 0, failed: 0, pending: 0 }')
    && asyncPdfBranchBody.includes('const savedPageIds = new Set')
    && asyncPdfBranchBody.includes('const failedPageIds = new Set<string>()')
    && asyncPdfBranchBody.includes('savedPageIds.add(pageResult.pageId)')
    && asyncPdfBranchBody.includes('failedPageIds.delete(pageResult.pageId)')
    && asyncPdfBranchBody.includes('failedPageIds.add(pageResult.pageId)')
    && asyncPdfBranchBody.includes('streamedPageSummary = {')
    && processBatchBody.includes('streamedPageSummary.failed > 0 || streamedPageSummary.pending > 0'),
  'Legacy batch PDF OCR should keep streamed completion/failure counts instead of rescanning page rows after chunk saves.',
)
assert(
  !processBatchBody.includes("SELECT COUNT(*) as count FROM pages WHERE doc_id = ? AND ocr_status != 'completed'"),
  'Legacy batch PDF OCR should not rescan all page rows to detect failures after streamed chunk saves.',
)
assert(
  batchSource.includes('private hasSequentialPageRecords')
    && batchSource.includes('private async ensurePageRecordsIfNeeded')
    && asyncPdfBranchBody.includes('pages = await this.ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, chunk.totalPages))')
    && asyncPdfBranchBody.includes('pages = await this.ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, results.length))'),
  'Legacy batch PDF OCR should reuse complete in-memory page records instead of rescanning the page table for every async chunk.',
)
assert(
  !asyncPdfBranchBody.includes('pages = await this.ensurePageRecords(docId'),
  'Legacy batch PDF OCR chunk completion should not force a full page table rescan when page records are already complete.',
)
assert(
  !asyncPdfBranchBody.includes('Promise.all(pages.map(async (page, index)'),
  'Legacy batch PDF OCR should not post-process the whole document in one Promise.all.',
)
assert(
  !batchSource.includes('refreshSearchIndexForPages')
    && savePageResultsBody.includes('const changedPageIds: string[] = []')
    && savePageResultsBody.includes('changedPageIds.push(pageResult.pageId)')
    && savePageResultsBody.includes('options: { deferSearchRefresh?: boolean; deferDatabaseSave?: boolean } = {}')
    && savePageResultsBody.includes('if (!options.deferSearchRefresh)')
    && savePageResultsBody.includes('markSearchIndexStaleForPages(changedPageIds)')
    && savePageResultsBody.includes('notifySearchContentChanged()')
    && savePageResultsBody.includes('if (!options.deferDatabaseSave)')
    && savePageResultsBody.includes('return changedPageIds'),
  'Legacy batch saves should use the background search indexer instead of synchronously refreshing old FTS rows.',
)
assert(
  savePageResultsBody.indexOf('markSearchIndexStaleForPages(changedPageIds)') > savePageResultsBody.lastIndexOf('await yieldToEventLoop()'),
  'Legacy batch saves should coalesce search stale marking until all save chunks have been written.',
)
assert(
  processBatchBody.includes('const deferredChangedPageIds = new Set<string>()')
    && processBatchBody.includes('let deferredDatabaseSaveNeeded = false')
    && asyncPdfBranchBody.includes('await this.savePageResults(chunkPageResults, {')
    && asyncPdfBranchBody.includes('deferSearchRefresh: true')
    && asyncPdfBranchBody.includes('deferDatabaseSave: true')
    && asyncPdfBranchBody.includes('changedPageIds.forEach((pageId) => deferredChangedPageIds.add(pageId))')
    && processBatchBody.includes('} else if (deferredChangedPageIds.size > 0) {')
    && processBatchBody.includes('markSearchIndexStaleForPages([...deferredChangedPageIds])')
    && processBatchBody.includes('if (deferredDatabaseSaveNeeded) scheduleDatabaseSave()'),
  'Legacy batch async PDF chunk saves should defer search refresh and checkpoint scheduling until the document finishes.',
)
assert(
  batchSource.includes('resumePendingQueueFromDatabase()')
    && batchSource.includes('reconcileFinishedQueueItems()')
    && batchSource.includes('queueItemIdsByJob')
    && batchSource.includes("UPDATE batch_queue SET status = ?, progress = ?"),
  'Legacy batch processor should be able to resume persisted queue items and write terminal item status back to batch_queue.',
)
assert(
  batchSource.includes("AND p.ocr_status = 'completed'\n               AND ${pageContentAvailableCondition('p')}")
    && !batchSource.includes("p.ocr_status = 'completed'\n                 OR ${pageContentAvailableCondition('p')}"),
  'Legacy batch queue reconciliation should not treat false-completed OCR error placeholders as finished pages.',
)
assert(
  batchSource.includes('private getPagesNeedingOcr')
    && processBatchBody.includes('let pagesForOcr = this.getPagesNeedingOcr(pages)')
    && processBatchBody.includes('recognizePages(pagesForOcr')
    && asyncPdfBranchBody.includes('targetPageNums')
    && asyncPdfBranchBody.includes('targetPageNums,')
    && asyncPdfBranchBody.includes('pagesForOcr = this.getPagesNeedingOcr(pages)'),
  'Legacy batch OCR resume should process only unfinished pages and pass target page numbers to async PDF OCR.',
)
assert(
  batchSource.includes('const BATCH_GUJI_ASYNC_PDF_PAGE_RANGE_CHUNK_SIZE = 25')
    && asyncPdfBranchBody.includes('const requireFullFileUpload = false')
    && asyncPdfBranchBody.includes("const pageRangeChunkSize = ocrOptions.profile === 'guji_print_vertical'")
    && asyncPdfBranchBody.includes('pageRangeChunkSize,')
    && asyncPdfBranchBody.includes('const targetPageNumSet = new Set(targetPageNums || [])')
    && asyncPdfBranchBody.includes('resultIndex: requireFullFileUpload ? sourcePageIndex : resultIndex')
    && asyncPdfBranchBody.includes('return targetPageNumSet.has(Number(item.page.page_num || item.sourcePageIndex + 1))')
    && asyncPdfBranchBody.includes('return { page, sourcePageIndex, resultIndex: requireFullFileUpload ? sourcePageIndex : index }')
    && !asyncPdfBranchBody.includes('pages.map((page, index) => ({ page, sourcePageIndex: index, resultIndex: index }))'),
  'Legacy batch async PDF resume should save only target pages and use Feijiang-compatible original-PDF pageRanges chunks for guji OCR.',
)

console.log('Batch processor OCR save regression passed.')
