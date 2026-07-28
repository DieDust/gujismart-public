const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert(start >= 0, `${label} start marker not found`)
  const end = source.indexOf(endMarker, start)
  assert(end > start, `${label} end marker not found`)
  return source.slice(start, end)
}

const root = path.join(__dirname, '..')
const databaseSource = fs.readFileSync(path.join(root, 'src', 'main', 'database.ts'), 'utf8')
const documentsSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'documents.ts'), 'utf8')
const ocrSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
const batchSource = fs.readFileSync(path.join(root, 'src', 'main', 'batch-processor.ts'), 'utf8')
const librarySource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')
const sharedTypesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')

assert(
  databaseSource.includes('CREATE INDEX IF NOT EXISTS idx_pages_doc_page_num ON pages(doc_id, page_num);'),
  'pages should have a composite doc/page index for large PDF page initialization',
)

const initializePdfPages = sliceBetween(
  documentsSource,
  "ipcMain.handle('documents:initializePdfPages'",
  "ipcMain.handle('documents:cachePageImage'",
  'documents:initializePdfPages',
)
const importHandler = sliceBetween(
  documentsSource,
  "ipcMain.handle('documents:import'",
  "ipcMain.handle('documents:list'",
  'documents:import',
)
const sharedPageRecordHelper = sliceBetween(
  documentsSource,
  'async function insertMissingDocumentPageRecords',
  'function logSlowDocumentStep',
  'insertMissingDocumentPageRecords',
)
const initializePdfPagesLazily = sliceBetween(
  librarySource,
  'const initializePdfPagesLazily = async',
  'const preparePdfPagesForOcrAfterImport',
  'initializePdfPagesLazily',
)
const ocrEnsurePageRecords = sliceBetween(
  ocrSource,
  'async function ensurePageRecords(docId: string, pageCount: number): Promise<OcrPageRow[]>',
  'function isPageOcrCompleted',
  'ocr ensurePageRecords',
)
const batchEnsurePageRecords = sliceBetween(
  batchSource,
  'private async ensurePageRecords(docId: string, pageCount: number): Promise<BatchPageRow[]>',
  'private async savePageResults',
  'batch ensurePageRecords',
)

for (const [label, source] of [
  ['insertMissingDocumentPageRecords', sharedPageRecordHelper],
  ['ocr ensurePageRecords', ocrEnsurePageRecords],
  ['batch ensurePageRecords', batchEnsurePageRecords],
]) {
  assert(
    source.includes('SELECT page_num FROM pages WHERE doc_id = ? AND page_num BETWEEN 1 AND ?'),
    `${label} should read existing page numbers once`,
  )
  assert(
    !source.includes('SELECT id FROM pages WHERE doc_id = ? AND page_num = ?'),
    `${label} should not query once per page before inserting missing records`,
  )
}

assert(
  ocrSource.includes('const OCR_PAGE_INSERT_CHUNK_SIZE = 50')
    && ocrEnsurePageRecords.includes('index += OCR_PAGE_INSERT_CHUNK_SIZE')
    && ocrEnsurePageRecords.includes('await yieldToEventLoop()')
    && ocrSource.includes('pages = await ensurePageRecords(docId, Number(doc.page_count || 0) || 0)')
    && ocrSource.includes('pages = await ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, chunk.totalPages))')
    && ocrSource.includes('pages = await ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, asyncResults.length))'),
  'OCR PDF page-record initialization should insert missing pages in small async chunks so large PDFs do not block the main process.',
)

assert(
  initializePdfPages.includes('await insertMissingDocumentPageRecords(docId, safePageCount, now)'),
  'documents:initializePdfPages should reuse the shared page-record initializer',
)
assert(
  documentsSource.includes("import { getPdfInfo, getPdfPageCountFast } from '../pdf-info'"),
  'documents import should use fast qpdf page count from the main process',
)
assert(
  documentsSource.includes('const PDF_IMPORT_PAGE_RECORD_INIT_LIMIT = 1000')
    && documentsSource.includes('function shouldDeferImportPdfPageRecordInit(pageCount: number): boolean')
    && documentsSource.includes('return safePageCount > PDF_IMPORT_PAGE_RECORD_INIT_LIMIT'),
  'PDF import should define an explicit large-PDF page-record deferral threshold',
)
assert(
  importHandler.includes('const pdfPageCount = copiedPdf ? Math.max(0, Math.round(Number(await getPdfPageCountFast(destPath) || 0))) : 0'),
  'PDF import should compute page count in the main process after the streamed copy',
)
assert(
  importHandler.includes('const deferPdfPageRecords = isPdfFile && shouldDeferImportPdfPageRecordInit(pdfPageCount)')
    && importHandler.includes('...(deferPdfPageRecords ? { pdf_page_records_deferred: true } : {})')
    && importHandler.includes('pdfPageCount > 0 && !deferPdfPageRecords')
    && importHandler.includes('await insertMissingDocumentPageRecords(id, pdfPageCount, now)'),
  'PDF import should defer empty page-record initialization for large PDFs while preserving it for smaller PDFs',
)
assert(
  documentsSource.includes('async function ensureDeferredPdfPageRecordsReadyForRead')
    && documentsSource.includes("ipcMain.handle('documents:get'")
    && documentsSource.includes('await ensureDeferredPdfPageRecordsReadyForRead(doc)')
    && documentsSource.includes("ipcMain.handle('documents:getLight'")
    && documentsSource.includes('clearDeferredPdfPageRecordMarker(doc.id)'),
  'Document detail reads should complete deferred large-PDF page records before returning pages',
)
assert(
  ocrSource.includes('function clearDeferredPdfPageRecordMarker(docId: string)')
    && ocrSource.includes('delete metadata.pdf_page_records_deferred')
    && ocrEnsurePageRecords.includes('clearDeferredPdfPageRecordMarker(docId)'),
  'OCR page-record initialization should clear the deferred-page marker after records are available',
)
assert(
  batchSource.includes('function clearDeferredPdfPageRecordMarker(docId: string)')
    && batchSource.includes('delete metadata.pdf_page_records_deferred')
    && batchEnsurePageRecords.includes('clearDeferredPdfPageRecordMarker(docId)'),
  'Batch OCR page-record initialization should clear the deferred-page marker after records are available',
)
assert(
  importHandler.includes('pageCount: pdfPageCount > 0 ? pdfPageCount : undefined'),
  'PDF import should return the initialized page count to the renderer',
)
assert(
  sharedTypesSource.includes('pageCount?: number'),
  'ImportDocumentResult should expose an optional pageCount summary',
)
assert(
  initializePdfPagesLazily.includes('pageCount?: number')
    && initializePdfPagesLazily.includes('if (importedPageCount <= 0)')
    && initializePdfPagesLazily.includes('const info = await getPdfFileInfo(filePath)'),
  'Renderer PDF preview initialization should skip duplicate PDF page-count reads when import returned pageCount',
)
assert(
  librarySource.includes('pageCount: result.pageCount')
    && librarySource.includes('initializePdfPagesLazily(item.docId, item.filePath, item.fileIndex, item.totalFiles, item.pageCount)'),
  'Renderer PDF preview queue should carry import pageCount through to lazy initialization',
)
assert(
  librarySource.includes('const LARGE_PDF_PREVIEW_DEFER_PAGE_COUNT = 1000')
    && librarySource.includes('const LARGE_PDF_PREVIEW_IDLE_DELAY_MS = 30_000')
    && librarySource.includes('const AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS = 60_000'),
  'Renderer should have explicit large-PDF and auto-OCR preview deferral delays',
)
assert(
  librarySource.includes('const PDF_PREVIEW_LIST_REFRESH_BATCH_SIZE = 10')
    && librarySource.includes('let pendingPreviewRefreshCount = 0')
    && librarySource.includes('pendingPreviewRefreshCount >= PDF_PREVIEW_LIST_REFRESH_BATCH_SIZE')
    && librarySource.includes('index === queueItems.length - 1')
    && librarySource.includes('scheduleImportListRefresh()')
    && !librarySource.includes("pendingPreviewRefreshCount = 0\n          await loadDocuments(filter, { silent: true })"),
  'Renderer PDF preview queue should coalesce non-blocking list refreshes instead of awaiting reloads during preview generation',
)
assert(
  librarySource.includes('deferredPdfPreviewQueueRef.current.push(...items)')
    && librarySource.includes('if (deferredPdfPreviewTimerRef.current) return')
    && librarySource.includes('const queueItems = deferredPdfPreviewQueueRef.current.splice(0)'),
  'Deferred large-PDF preview work should accumulate behind a single timer instead of replacing queued work',
)
assert(
  librarySource.includes('Number(result.pageCount || 0) >= LARGE_PDF_PREVIEW_DEFER_PAGE_COUNT')
    && librarySource.includes('shouldDeferImportPdfPreview ? { delayMs: AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS } : undefined')
    && librarySource.includes('Math.max(LARGE_PDF_PREVIEW_IDLE_DELAY_MS, AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS)'),
  'Large imported PDFs should defer renderer preview generation away from the OCR upload hot path',
)

assert(
  librarySource.includes("const previewAutoOcrBackground = await window.api.getSetting('auto_ocr_after_import')")
    && librarySource.includes('const shouldAttemptAutoOcrForPreview = previewAutoOcrBackground !== \'false\'')
    && librarySource.includes('const previewAutoOcrConfigReady = shouldAttemptAutoOcrForPreview ? await hasOcrEngineConfig(engine) : false')
    && librarySource.includes('const shouldDeferImportPdfPreview = shouldAttemptAutoOcrForPreview && previewAutoOcrConfigReady')
    && librarySource.includes('createImportAutoOcrTask({')
    && librarySource.includes('startImportAutoOcrTask(task.jobId)'),
  'Import preview deferral and persistent auto-OCR execution should share one stable readiness/config snapshot.',
)

console.log('PDF page initialization regression passed.')
