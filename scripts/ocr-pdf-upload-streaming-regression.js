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
const ocrSource = fs.readFileSync(path.join(root, 'src', 'main', 'ocr.ts'), 'utf8')
const ocrIpcSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
const librarySource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')
const uploadBlobHelper = sliceBetween(
  ocrSource,
  'async function createPdfUploadBlob',
  'async function submitAsyncPdfJob',
  'PDF upload Blob helper',
)
const submitAsyncPdfJobBody = sliceBetween(
  ocrSource,
  'async function submitAsyncPdfJob',
  'async function queryAsyncPdfJob',
  'async PDF submit',
)
const queryAsyncPdfJobBody = sliceBetween(
  ocrSource,
  'async function queryAsyncPdfJob',
  'async function waitForAsyncPdfResult',
  'async PDF status query',
)
const waitForAsyncPdfResultBody = sliceBetween(
  ocrSource,
  'async function waitForAsyncPdfResult',
  'function collectAsyncPagePayloads',
  'async PDF status polling',
)
const createPdfChunkPlanBody = sliceBetween(
  ocrSource,
  'async function createPdfChunkPlan',
  'async function createPdfChunkFromPlan',
  'PDF chunk plan',
)
const createPdfChunkFromPlanBody = sliceBetween(
  ocrSource,
  'async function createPdfChunkFromPlan',
  'function createWholePdfFallbackChunk',
  'PDF chunk creation',
)
const recognizePdfAsyncBody = sliceBetween(
  ocrSource,
  'export async function recognizePdfAsync',
  'export async function recognizeTraditional',
  'async PDF OCR recognition',
)
const prepareImageForOcrUploadBody = sliceBetween(
  ocrSource,
  'export async function prepareImageForOcrUpload',
  'function smoothSeries',
  'OCR image upload preparation',
)
const fetchAsyncPdfJsonLinesBody = sliceBetween(
  ocrSource,
  'async function fetchAsyncPdfJsonLines',
  'function getChunkCompletedPages',
  'async PDF result parsing',
)
const normalizeAsyncPdfChunkResultsBody = sliceBetween(
  ocrSource,
  'async function normalizeAsyncPdfChunkResults',
  'export async function recognizePdfAsync',
  'async PDF result normalization',
)

assert(
  ocrSource.includes('openAsBlob'),
  'OCR PDF upload should import fs.openAsBlob for low-memory file uploads',
)
assert(
  uploadBlobHelper.includes('openAsBlob(filePath, { type: \'application/pdf\' })'),
  'OCR PDF upload should create the upload Blob directly from the file path',
)
assert(
  uploadBlobHelper.includes('await readFile(filePath)'),
  'OCR PDF upload may keep a readFile fallback for small files on runtimes without fs.openAsBlob',
)
assert(
  uploadBlobHelper.includes('const stats = await stat(filePath)')
    && uploadBlobHelper.includes('if (stats.size > ASYNC_PDF_MAX_FILE_SIZE)')
    && uploadBlobHelper.includes('不支持低内存 PDF 文件上传'),
  'OCR PDF upload readFile fallback should reject large PDFs instead of loading them fully into memory',
)
assert(
  !submitAsyncPdfJobBody.includes('await readFile(filePath)'),
  'submitAsyncPdfJob should not eagerly read the whole PDF into memory before uploading',
)
assert(
  submitAsyncPdfJobBody.includes('const fileBlob = await createPdfUploadBlob(filePath)'),
  'submitAsyncPdfJob should use the upload Blob helper',
)
assert(
  ocrSource.includes('function getSafeOcrUploadFilename')
    && submitAsyncPdfJobBody.includes("formData.append('file', fileBlob, getSafeOcrUploadFilename(filePath))")
    && !submitAsyncPdfJobBody.includes("formData.append('file', fileBlob, basename(filePath))"),
  'submitAsyncPdfJob should upload PDFs with an ASCII-safe filename so PaddleOCR jobs do not stall on CJK filenames.',
)
assert(
  !submitAsyncPdfJobBody.includes("formData.append('optionalPayload'")
    && !ocrSource.includes('function getAsyncPdfOptionalPayload'),
  'submitAsyncPdfJob should not force-disable PaddleOCR orientation, unwarping, or chart recognition for async PDF OCR.',
)
assert(
  submitAsyncPdfJobBody.includes("formData.append('pageRanges', submitOptions.pageRanges)")
    && createPdfChunkFromPlanBody.includes('const pageRanges = isFullPageSelection ? undefined : toQpdfPageRange(sourcePageIndexes)')
    && createPdfChunkFromPlanBody.includes('pageRanges,')
    && recognizePdfAsyncBody.includes('}, { pageRanges: chunk.pageRanges })'),
  'Async PDF OCR should use official pageRanges for partial resume instead of asking PaddleOCR to parse the whole PDF again.',
)
assert(
  ocrSource.includes('const DEFAULT_ASYNC_PDF_CHUNK_CONCURRENCY = 1')
    && ocrSource.includes('const MAX_ASYNC_PDF_CHUNK_CONCURRENCY = 1')
    && ocrSource.includes('const asyncSubmitLimit = createLimiter(MAX_DOC_CONCURRENCY)')
    && !ocrSource.includes('asyncPdfJobLimit'),
  'Async PDF OCR should respect the configured document batch concurrency while keeping per-document chunk concurrency conservative.',
)
assert(
  ocrSource.includes('const ASYNC_OCR_QUEUE_BUSY_RETRY_ATTEMPTS = 240')
    && ocrSource.includes('function isAsyncOcrQueueBusyError')
    && ocrSource.includes('提交队列已满')
    && submitAsyncPdfJobBody.includes('const queueBusy = isAsyncOcrQueueBusyError(failure)')
    && submitAsyncPdfJobBody.includes('maxAttempts = Math.max(maxAttempts, ASYNC_OCR_QUEUE_BUSY_RETRY_ATTEMPTS)')
    && submitAsyncPdfJobBody.includes('? Math.min(60000, 15000 * attempt)')
    && ocrSource.includes('if (isAsyncOcrQueueBusyError(failure)) return false'),
  'Async PDF OCR should wait and retry when PaddleOCR reports a full submission queue instead of marking documents failed.',
)
assert(
  !ocrIpcSource.includes('SMALL_PDF_IMAGE_OCR_PAGE_LIMIT')
    && !ocrIpcSource.includes('workPageCount <= SMALL_PDF_IMAGE_OCR_PAGE_LIMIT')
    && ocrIpcSource.includes('if (!shouldUseAsyncPdfOcr(pdfPath, Math.max(pageCount, pages.length, pagesForOcr.length))) return false')
    && ocrIpcSource.indexOf('if (!shouldUseAsyncPdfOcr(pdfPath, Math.max(pageCount, pages.length, pagesForOcr.length))) return false') < ocrIpcSource.indexOf('if (pages.length === 0) return true'),
  'Usable PDFs should prefer async PDF OCR; readable page images are only a fallback path, not a reason to bypass PDF upload.',
)
assert(
  ocrSource.includes('const PDF_LIB_CHUNK_PLAN_MAX_FILE_SIZE = ASYNC_PDF_MAX_FILE_SIZE')
    && ocrSource.includes('function shouldAvoidPdfLibChunkPlanFallback'),
  'PDF chunk planning should have an explicit size guard for pdf-lib fallback',
)
assert(
  createPdfChunkPlanBody.includes('const fallbackTotalPages = getFallbackPdfPageCount(targetPageNums, fallbackPageCount)')
    && createPdfChunkPlanBody.includes('forceChunking = false')
    && createPdfChunkPlanBody.includes('!forceChunking')
    && createPdfChunkPlanBody.includes('canAttemptWholePdfUpload(stats.size, fallbackTotalPages)')
    && createPdfChunkPlanBody.includes('canAttemptWholePdfUpload(stats.size, totalPages)')
    && createPdfChunkPlanBody.includes('fullFileUpload: true')
    && createPdfChunkPlanBody.indexOf('const fallbackTotalPages = getFallbackPdfPageCount(targetPageNums, fallbackPageCount)') < createPdfChunkPlanBody.indexOf('let totalPages = isQpdfPdfChunkingEnabled()'),
  'PDFs with a known page count should prefer full-file async upload instead of preemptively chunking by local 50MB/1000-page guards.',
)
assert(
  recognizePdfAsyncBody.includes("status: 'uploading'")
    && recognizePdfAsyncBody.includes("state: 'uploading'")
    && recognizePdfAsyncBody.indexOf("status: 'uploading'") < recognizePdfAsyncBody.indexOf('const jobId = await submitAsyncPdfJob'),
  'Async PDF OCR should emit an uploading phase before the fetch upload blocks on the network.',
)
assert(
  ocrIpcSource.includes('const asyncProgressMessage = isUploading && isFullFileUpload')
    && ocrIpcSource.includes('const uploadModeMessage = isFullFileUpload')
    && ocrIpcSource.includes('准备上传 PDF')
    && ocrIpcSource.includes('PDF 已提交，等待处理')
    && ocrIpcSource.includes('OCR 处理中')
    && !ocrIpcSource.includes('不是本地逐页上传')
    && !ocrIpcSource.includes('当前文档并发')
    && !ocrIpcSource.includes('服务端处理中')
    && !ocrIpcSource.includes('正在上传整本 PDF 到飞桨')
    && !ocrIpcSource.includes('逐页图片 OCR')
    && !ocrIpcSource.includes('上传设置')
    && !ocrIpcSource.includes('getOcrImageUploadSettingsText')
    && ocrIpcSource.includes("const fallbackRetryMessage = isPreparing && payload.fallbackReason ? '正在重新提交 PDF' : ''")
    && ocrIpcSource.includes('message: fallbackRetryMessage || statusQueryRetryMessage || uploadModeMessage || asyncProgressMessage || (isWaitingForServerQueue'),
  'OCR IPC progress should use concise user-facing upload/server messages instead of debug explanations.',
)
assert(
  ocrSource.includes('function shouldRetryWholePdfUploadWithChunking')
    && recognizePdfAsyncBody.includes('let retriedWholePdfUploadWithChunks = false')
    && recognizePdfAsyncBody.includes('shouldRetryWholePdfUploadWithChunking(error, plan)')
    && recognizePdfAsyncBody.includes('createPdfChunkPlan(filePath, options?.targetPageNums, signal, options?.fallbackPageCount, true)'),
  'Async PDF OCR should retry with chunking only after a whole-PDF upload is actually rejected.',
)
assert(
  librarySource.includes("if (info.phase === 'saving') return info.message || '正在保存 OCR 结果'")
    && librarySource.includes('if (info.message) return info.message')
    && librarySource.indexOf('if (info.message) return info.message') < librarySource.indexOf("return `OCR 识别中：${info.completedPages}/${info.totalPages} 页`"),
  'Library OCR progress text should prefer explicit upload/server messages over the generic 0/N page label.',
)
assert(
  ocrSource.includes('const ASYNC_PDF_HEAVY_TARGET_CHUNK_SIZE = 32 * 1024 * 1024')
    && ocrSource.includes('function getPdfTargetChunkSize')
    && createPdfChunkPlanBody.includes('const targetChunkSize = getPdfTargetChunkSize(stats.size, totalPages)')
    && createPdfChunkPlanBody.includes('(totalPages * targetChunkSize)'),
  'Heavy PDFs should use a smaller target chunk size to reduce qpdf chunking and upload stall risk.',
)
assert(
  ocrSource.includes('const QPDF_HEAVY_CHUNK_TIMEOUT_MS = 240 * 1000')
    && ocrSource.includes("function getQpdfChunkTimeoutMs(plan: Pick<PdfChunkPlan, 'sourceSize' | 'totalPages'>)")
    && createPdfChunkFromPlanBody.includes('createQpdfPageSelectionChunk(plan.sourcePath, chunkPath, sourcePageIndexes, getQpdfChunkTimeoutMs(plan), signal)'),
  'Heavy PDFs should allow a longer qpdf chunk timeout without changing the normal timeout.',
)
assert(
  createPdfChunkPlanBody.includes('const largePdfWithoutQpdf = !qpdfEnabled && shouldAvoidPdfLibChunkPlanFallback(stats.size)'),
  'PDF chunk planning should detect large PDFs when qpdf page counting is unavailable',
)
assert(
  createPdfChunkPlanBody.includes('if (!qpdfEnabled && !largePdfWithoutQpdf)')
    && createPdfChunkPlanBody.includes('if (largePdfWithoutQpdf)'),
  'Large PDFs without qpdf should not be loaded through pdf-lib before falling back',
)
assert(
  ocrSource.includes('function shouldAvoidPdfLibChunkCopyFallback'),
  'PDF chunk creation should have an explicit size guard for pdf-lib copy fallback',
)
assert(
  createPdfChunkFromPlanBody.includes('if (shouldAvoidPdfLibChunkCopyFallback(plan))')
    && createPdfChunkFromPlanBody.includes('skipped pdf-lib full-file load'),
  'Large PDFs should not fall back to pdf-lib chunk copying when qpdf chunking fails',
)
assert(
  prepareImageForOcrUploadBody.includes('const originalBytes = (await stat(filePath)).size'),
  'OCR image upload preparation should compare compressed bytes with file size instead of eagerly reading the original image',
)
assert(
  !prepareImageForOcrUploadBody.includes('const originalBuffer = await readFile(filePath)'),
  'OCR image upload preparation should not eagerly read the original image before attempting compression',
)
assert(
  prepareImageForOcrUploadBody.includes('compressed.length > 0 && compressed.length < originalBytes'),
  'OCR image upload preparation should keep the smaller upload payload decision',
)
assert(
  prepareImageForOcrUploadBody.includes(': readFile(filePath)'),
  'OCR image upload preparation should still fall back to the original image when compression is not smaller',
)
assert(
  ocrIpcSource.includes('const HEAVY_PDF_DOC_SIZE_BYTES = 200 * 1024 * 1024')
    && ocrIpcSource.includes('const HEAVY_PDF_DOC_PAGE_COUNT = 1000')
    && ocrIpcSource.includes('function isHeavyPdfOcrDocument'),
  'OCR IPC should identify very large PDF documents before scheduling batch OCR work',
)
assert(
  ocrIpcSource.includes('const heavyPdfLimit = createLimiter(1)')
    && ocrIpcSource.includes('const heavyPdfDocIds = new Set<string>()')
    && ocrIpcSource.includes('heavyPdfDocIds.has(docId) ? heavyPdfLimit : docLimit'),
  'Heavy PDF OCR documents should use a dedicated single-document limiter instead of the normal batch concurrency',
)
assert(
  recognizePdfAsyncBody.includes('let chunkCompleteQueue = Promise.resolve()')
    && recognizePdfAsyncBody.includes('const runChunkCompleteCallbackSerially = async')
    && recognizePdfAsyncBody.includes('chunkCompleteQueue = next.then(() => undefined, () => undefined)'),
  'Async PDF chunk completion callbacks should be serialized to avoid concurrent database writes',
)
assert(
  recognizePdfAsyncBody.includes('const plannedPageCount = Math.min(')
    && recognizePdfAsyncBody.indexOf("status: 'preparing'") < recognizePdfAsyncBody.indexOf('chunk = await createPdfChunkFromPlan(plan, nextTargetCursor, chunkIndex, signal)'),
  'Async PDF OCR should emit chunk preparation progress before qpdf starts creating the temporary chunk.',
)
assert(
  ocrSource.includes('collectChunkResults?: boolean')
    && recognizePdfAsyncBody.includes('const collectChunkResults = options?.collectChunkResults !== false')
    && recognizePdfAsyncBody.includes('if (collectChunkResults) {')
    && recognizePdfAsyncBody.includes('chunkResults[chunkIndex] = normalizedChunkResults')
    && recognizePdfAsyncBody.includes('return collectChunkResults ? chunkResults.flat() : []'),
  'Async PDF recognition should allow streaming callers to skip retaining every chunk result after onChunkComplete saves it',
)
assert(
  recognizePdfAsyncBody.includes('await runChunkCompleteCallbackSerially({')
    && !recognizePdfAsyncBody.includes('await options?.onChunkComplete?.({'),
  'Async PDF chunk processing should use the serialized completion callback wrapper',
)
assert(
  recognizePdfAsyncBody.includes('const workerCount = getAsyncPdfWorkerCount(plan)')
    && recognizePdfAsyncBody.includes('Promise.all(Array.from({ length: workerCount }, () => worker()))'),
  'Async PDF upload and polling workers should remain concurrent while completion saves are serialized',
)
assert(
  ocrSource.includes('ASYNC_POLL_MIN_INTERVAL_MS')
    && ocrSource.includes('ASYNC_POLL_BASE_INTERVAL_MS')
    && ocrSource.includes('ASYNC_POLL_MAX_INTERVAL_MS')
    && ocrSource.includes('function getAsyncPollDelayMs')
    && ocrSource.includes('let pollCount = 0')
    && ocrSource.includes('pollCount += 1')
    && ocrSource.includes('await sleep(getAsyncPollDelayMs({'),
  'Async PDF status polling should adaptively poll faster near submission/completion instead of always waiting a fixed interval.',
)
assert(
  ocrSource.includes('const ASYNC_STATUS_QUERY_TIMEOUT_MS = 30 * 1000')
    && queryAsyncPdfJobBody.includes('ASYNC_STATUS_QUERY_TIMEOUT_MS')
    && !queryAsyncPdfJobBody.includes('getOcrUploadTimeoutMs()'),
  'Async PDF status queries should use a short dedicated timeout instead of the long upload timeout.',
)
assert(
  waitForAsyncPdfResultBody.includes('try {')
    && waitForAsyncPdfResultBody.includes('statusPayload = await queryAsyncPdfJob(jobId, signal)')
    && waitForAsyncPdfResultBody.includes('retryingStatusQuery: true')
    && waitForAsyncPdfResultBody.includes('statusQueryError: failure.message')
    && waitForAsyncPdfResultBody.includes('waitingMs > ASYNC_JOB_STALLED_TIMEOUT_MS')
    && waitForAsyncPdfResultBody.includes('await sleep(getAsyncPollDelayMs({'),
  'Async PDF polling should retry transient status-query failures and fail recoverably after a real no-progress stall.',
)
assert(
  ocrIpcSource.includes('function formatDurationMs')
    && ocrIpcSource.includes('const statusQueryRetryMessage = payload.retryingStatusQuery')
    && ocrIpcSource.includes('正在重新查询处理进度')
    && ocrIpcSource.includes('message: fallbackRetryMessage || statusQueryRetryMessage || uploadModeMessage || asyncProgressMessage || (isWaitingForServerQueue'),
  'OCR IPC progress should surface status-query retries with elapsed time instead of leaving documents at a silent 0% wait.',
)
assert(
  ocrSource.includes('ASYNC_RESULT_PARSE_YIELD_LINE_INTERVAL')
    && fetchAsyncPdfJsonLinesBody.includes('await yieldToEventLoop()')
    && fetchAsyncPdfJsonLinesBody.includes('throwIfAborted(signal)')
    && fetchAsyncPdfJsonLinesBody.includes('response.body?.getReader()')
    && fetchAsyncPdfJsonLinesBody.includes('new TextDecoder()')
    && fetchAsyncPdfJsonLinesBody.includes('await reader.read()')
    && fetchAsyncPdfJsonLinesBody.includes('buffer.search(/\\r?\\n/)')
    && fetchAsyncPdfJsonLinesBody.includes('collectAsyncPdfJsonLine(line, model, pagePayloads')
    && fetchAsyncPdfJsonLinesBody.includes('parseAsyncPdfResultPayloadText(await response.text(), model)')
    && fetchAsyncPdfJsonLinesBody.includes('parseAsyncPdfResultPayloadText(fallbackContent, model)'),
  'Async PDF JSONL result parsing should stream response.body incrementally, remain cancelable, and preserve whole-JSON fallback',
)
assert(
  !fetchAsyncPdfJsonLinesBody.includes('const content = await response.text()')
    && !fetchAsyncPdfJsonLinesBody.includes('const lines = content.split'),
  'Async PDF result parsing should not eagerly read and split the whole result file in the streaming path',
)
assert(
  ocrSource.includes('ASYNC_RESULT_NORMALIZE_CHUNK_SIZE')
    && normalizeAsyncPdfChunkResultsBody.includes('for (let index = 0; index < pagePayloads.length; index += ASYNC_RESULT_NORMALIZE_CHUNK_SIZE)')
    && normalizeAsyncPdfChunkResultsBody.includes('normalizePageResult(payload)')
    && normalizeAsyncPdfChunkResultsBody.includes('await yieldToEventLoop()')
    && normalizeAsyncPdfChunkResultsBody.includes('throwIfAborted(signal)'),
  'Async PDF result normalization should process large result sets in cancelable event-loop friendly chunks',
)
assert(
  !normalizeAsyncPdfChunkResultsBody.includes('pagePayloads.map((payload) => normalizePageResult(payload))'),
  'Async PDF result normalization should not synchronously map every returned page payload at once',
)
assert(
  recognizePdfAsyncBody.includes('await normalizeAsyncPdfChunkResults(pagePayloads, chunk, signal)'),
  'Async PDF chunk processing should await cancelable chunked result normalization',
)

console.log('OCR PDF upload streaming regression passed.')
