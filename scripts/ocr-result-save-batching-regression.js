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

function hasLikelyHardcodedPrivateDocId(source) {
  return /\b(?:docId|documentId|pageId|sourceId|id)\b\s*[:=]\s*['"][A-Za-z0-9_-]{20,}['"]/.test(source)
}

const root = path.join(__dirname, '..')
const ocrIpcSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
const ocrCoreSource = fs.readFileSync(path.join(root, 'src', 'main', 'ocr.ts'), 'utf8')
const ocrTextSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'utils', 'ocrText.ts'), 'utf8')
const documentViewSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'DocumentView.tsx'), 'utf8')
const libraryViewSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')
const textEditorSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'TextEditor.tsx'), 'utf8')
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
const savePageQualityFailureOcrErrorBody = sliceBetween(
  ocrIpcSource,
  'async function savePageQualityFailureOcrError',
  'function finishRecoveredPageQualityFailure',
  'OCR quality failure save body',
)
const retryIncompletePagesWithSinglePageOcrBody = sliceBetween(
  ocrIpcSource,
  'async function retryIncompletePagesWithSinglePageOcr',
  'function getRiskyPageImageRetryOptions',
  'single-page incomplete OCR retry body',
)
const singlePageRetryCatchBody = sliceBetween(
  retryIncompletePagesWithSinglePageOcrBody,
  '    } catch (error) {',
  '    }\n  }\n  }',
  'single-page incomplete OCR retry catch body',
)
const resetPagesForFullOcrRerunBody = sliceBetween(
  ocrIpcSource,
  'function resetPagesForFullOcrRerun',
  'function hasIncompleteOcrPages',
  'full OCR rerun reset body',
)
const isLikelyBookishPdfTableResultBody = sliceBetween(
  ocrIpcSource,
  'function isLikelyBookishPdfTableResult',
  'function getOcrBlockRect',
  'bookish PDF table detection body',
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
const batchOcrBody = sliceBetween(
  ocrIpcSource,
  "ipcMain.handle('documents:batchOcr'",
  "ipcMain.handle('pages:rerunOcr'",
  'batch OCR IPC body',
)
const postProcessPdfOcrResultsBatchedBody = sliceBetween(
  ocrIpcSource,
  'async function postProcessPdfOcrResultsBatched',
  'async function recognizeSinglePage',
  'batched PDF OCR result post-processing helper',
)
const riskyPageImageOcrBody = sliceBetween(
  ocrIpcSource,
  'async function recognizeRiskyPageImageOcrPages',
  'async function rerunPageLayoutOnly',
  'risky page-image OCR route body',
)
const reprocessDocumentOcrStructureBody = sliceBetween(
  ocrIpcSource,
  'function reprocessDocumentOcrStructure',
  'function updatePageOcrState',
  'document OCR structure reprocess body',
)
const preserveRawGujiReferenceTextBody = sliceBetween(
  ocrIpcSource,
  'function preserveRawGujiReferenceText',
  'function normalizeFeijiangReferenceTextOnlyResult',
  'Feijiang reference text-only preservation body',
)
const normalizeFeijiangReferenceTextOnlyResultBody = sliceBetween(
  ocrIpcSource,
  'function normalizeFeijiangReferenceTextOnlyResult',
  'function isFeijiangReferenceRecoveredResult',
  'Feijiang reference text-only normalization body',
)
const getFacsimileOcrResultBody = sliceBetween(
  documentViewSource,
  'function getFacsimileOcrResult',
  'function hasFacsimileCoordinates',
  'facsimile OCR result body',
)
const flushOcrStatusBufferBody = sliceBetween(
  libraryViewSource,
  'const flushOcrStatusBuffer = useCallback',
  '  useEffect(() => {',
  'library OCR status flush body',
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
const qualityFailureSaveCallCount = (ocrIpcSource.match(/savePageQualityFailureOcrError\(/g) || []).length

assert(
  ocrIpcSource.includes('function hasGujiVerticalQuestionPhrasePollution')
    && ocrIpcSource.includes('malformedQuotePhraseCount')
    && ocrIpcSource.includes('repeatedBarePhraseCount')
    && ocrIpcSource.includes('hasGujiVerticalQuestionPhrasePollution(totalText)')
    && ocrIpcSource.includes('短语被反复插入并把原句切碎'),
  'Guji OCR quality checks should reject repeated short phrase pollution that breaks vertical question sentences into fragments.',
)
assert(
  ocrIpcSource.includes('const OCR_AUTO_FAILED_PAGE_RETRY_LIMIT')
    && ocrIpcSource.includes('const OCR_ASYNC_PDF_QUALITY_RETRYABLE_PREFIX')
    && ocrIpcSource.includes('const OCR_ORIGINAL_PDF_RETRY_ATTEMPTS = 3')
    && ocrIpcSource.includes('function retryIncompletePagesWithSinglePageOcr')
    && ocrIpcSource.includes('function retryIncompletePagesWithOriginalPdfOcr')
    && ocrIpcSource.includes('function getOriginalPdfRetryPageRangeTargetNums')
    && ocrIpcSource.includes('function getOriginalPdfRetryStrategies')
    && ocrIpcSource.includes('requireFullFileUpload: true')
    && ocrIpcSource.includes('const originalPdfRetryResults = await retryIncompletePagesWithOriginalPdfOcr(doc, pdfPath, signal, onProgress)')
    && ocrIpcSource.includes('targetPageNums,')
    && ocrIpcSource.includes('targetPageNums: retryStrategy.targetPageNums')
    && ocrIpcSource.includes('pageRangeChunkSize,')
    && ocrIpcSource.includes('const maxAttempts = retryOptions.profile === \'guji_print_vertical\' ? OCR_ORIGINAL_PDF_RETRY_ATTEMPTS : 1')
    && ocrIpcSource.includes('let remainingPages = pages')
    && ocrIpcSource.includes('const retryStrategy = getOriginalPdfRetryStrategies(')
    && ocrIpcSource.includes('pageRangeChunkSize: retryStrategy.pageRangeChunkSize')
    && ocrIpcSource.includes('requireFullFileUpload: retryStrategy.requireFullFileUpload')
    && ocrIpcSource.includes('? pageNum - 1')
    && ocrIpcSource.includes('resultIndexByPageNum.get(pageNum)')
    && ocrIpcSource.includes('const rawResults = await recognizePdfAsync(pdfPath')
    && ocrIpcSource.includes('const resultsByPageId = new Map<string, OcrPageResult>()')
    && ocrIpcSource.includes('originalPdfRetryResults.forEach((pageResult) => {')
    && ocrIpcSource.includes("filter((pageResult) => pageResult.status === 'completed')")
    && ocrIpcSource.includes('resultsByPageId.set(originalPage.id, {')
    && !ocrIpcSource.includes('if (pdfPath) return []')
    && ocrIpcSource.includes('const baseRetryOptions = resolveDocOcrOptions(doc.doc_type)')
    && ocrIpcSource.includes('hasOldBookRouteHints(doc)')
    && ocrIpcSource.includes('oldSchoolBookSignals')
    && ocrIpcSource.includes('教科書|讀本|読本')
    && ocrIpcSource.includes('? getVerticalFallbackOcrOptions(baseRetryOptions)')
    && ocrIpcSource.includes('const attemptedPageIds = new Set(')
    && ocrIpcSource.includes('while (true)')
    && ocrIpcSource.includes('getIncompletePagesForSinglePageRetry(doc.id, attemptedPageIds)')
    && ocrIpcSource.includes('attemptedPageIds.add(originalPage.id)')
    && ocrIpcSource.includes('function getAutomaticSinglePageRetryOptions')
    && !ocrIpcSource.includes("routePreference === 'page_image_vertical'")
    && ocrIpcSource.includes('hasOldBookRouteHints(doc)')
    && processDocumentOcrBody.includes('await retryIncompletePagesWithSinglePageOcr(')
    && processDocumentOcrBody.includes('await savePageOcrResultsBatchedDeferred(retryResults')
    && processDocumentOcrBody.indexOf('await retryIncompletePagesWithSinglePageOcr(') < processDocumentOcrBody.indexOf('const hasPageFailure = persistedPageSummary.failed > 0 || persistedPageSummary.pending > 0'),
  'Document OCR should automatically retry failed or incomplete PDF pages with original-PDF pageRanges, then continue to single-page image OCR for pages that still failed.',
)
assert(
  ocrIpcSource.includes('function isOcrPageSummaryComplete')
    && ocrIpcSource.includes('stats.completed === stats.total && stats.failed === 0 && stats.pending === 0')
    && ocrIpcSource.includes('return isOcrPageSummaryComplete(stats)')
    && ocrIpcSource.includes('const completed = isOcrPageSummaryComplete(stats)')
    && ocrIpcSource.includes('const nextStatus = isOcrPageSummaryComplete(stats)'),
  'Document OCR completion should require all pages completed and no failed or pending pages.',
)
assert(
  ocrIpcSource.includes('function getPreferredGujiServiceText')
    && ocrIpcSource.includes('function preservePreferredGujiServiceText')
    && ocrIpcSource.includes('function isUnsafeGujiPreferredServiceText')
    && ocrIpcSource.includes('/<(?:table|img)\\b/i.test(value)')
    && ocrIpcSource.includes('findLikelyRunawayRepeatedOcrText(value)')
    && ocrIpcSource.includes('hasGujiWebMetadataHallucination(value)')
    && ocrIpcSource.includes('hasGujiVerticalQuestionPhrasePollution(value)')
    && ocrIpcSource.includes("text_source: 'paddle_markdown'")
    && ocrIpcSource.includes('const preferredGujiText = gujiOptions')
    && ocrIpcSource.includes('|| getPreferredGujiServiceText(normalized)')
    && ocrIpcSource.includes('|| getUsableGujiAsyncPdfServiceText(result)')
    && ocrIpcSource.includes('const storageResult = gujiOptions && preferredGujiText')
    && reprocessDocumentOcrStructureBody.includes('getGujiOcrOptionsForResult(sourceResult)')
    && reprocessDocumentOcrStructureBody.includes('? getPreferredGujiServiceText(sourceResult)')
    && reprocessDocumentOcrStructureBody.includes('preservePreferredGujiServiceText(nextResultBase, preferredGujiText)')
    && ocrIpcSource.includes('const text = preferredGujiText || irText')
    && ocrIpcSource.includes('ir_text: irText'),
  'Guji OCR saves should preserve PaddleOCR markdown text as the page text instead of overwriting it with IR paragraph reconstruction.',
)
assert(
  ocrIpcSource.includes('function getUsableGujiAsyncPdfServiceText')
    && ocrIpcSource.includes('function getGujiAsyncPdfRetryableQualityIssue')
    && ocrIpcSource.includes('formatAsyncPdfRetryableQualityIssue(formatSuspiciousRepeatedOcrTextIssue(repeatedIssue))')
    && ocrIpcSource.includes('delete metadata.ocr_last_quality_issue')
    && ocrIpcSource.includes('hasGujiWebMetadataHallucination(candidate)')
    && ocrIpcSource.includes('hasGujiMachineTokenHallucination(candidate)')
    && ocrIpcSource.includes('|| getUsableGujiAsyncPdfServiceText(result)')
    && ocrIpcSource.includes('gujismart_async_pdf_result: true')
    && ocrIpcSource.includes('pageResult.result.gujismart_async_pdf_result === true')
    && postProcessPdfOcrResultsBatchedBody.includes("if (ocrOptions.profile === 'guji_print_vertical') {")
    && postProcessPdfOcrResultsBatchedBody.includes('const qualityIssue = getGujiAsyncPdfRetryableQualityIssue(result, item.page.image_path, ocrOptions)')
    && postProcessPdfOcrResultsBatchedBody.includes("status: 'error'")
    && postProcessPdfOcrResultsBatchedBody.indexOf('const qualityIssue = getGujiAsyncPdfRetryableQualityIssue(result, item.page.image_path, ocrOptions)') < postProcessPdfOcrResultsBatchedBody.indexOf('gujismart_async_pdf_result: true')
    && !postProcessPdfOcrResultsBatchedBody.includes('const tableMisclassification = safePreferredText ? null : getLikelyAsyncPdfTableMisclassification')
    && !postProcessPdfOcrResultsBatchedBody.includes('const hardQualityIssue = safePreferredText ? null : getRiskyPageImageNonTableHardIssue')
    && !postProcessPdfOcrResultsBatchedBody.includes('const underSegmented = !safePreferredText'),
  'Guji async PDF OCR should preserve PaddleOCR PDF coordinates and only reject retryable runaway or hallucinated PDF results before saving them as completed.',
)
assert(
  ocrIpcSource.includes("const OCR_FEIJIANG_REFERENCE_ENV = 'GUJISMART_OCR_REFERENCE_JSON_DIR'")
    && ocrIpcSource.includes('function findFeijiangReferenceJsonPath')
    && ocrIpcSource.includes('function loadFeijiangOcrReference')
    && ocrIpcSource.includes('function recoverGujiPageFromFeijiangReference')
    && ocrIpcSource.includes('function recoverGujiPagesFromFeijiangReference')
    && ocrIpcSource.includes('function getGujiFeijiangReferenceMismatchIssue')
    && ocrIpcSource.includes('function recoverCompletedGujiPagesWithReferenceMismatch')
    && ocrIpcSource.includes('function recoverCompletedGujiPagesFromFeijiangReference')
    && ocrIpcSource.includes('const syncGujiPaddleReferenceResults = async')
    && ocrIpcSource.includes("lowerName.includes('paddleocr')")
    && ocrIpcSource.includes("filter((key) => /^\\d+$/.test(key))")
    && ocrIpcSource.includes('function normalizeFeijiangReferencePayloadForRecovery')
    && ocrIpcSource.includes('normalizePageResult(payload) as OcrPageResultPayload')
    && ocrIpcSource.includes("source: 'feijiang_reference_json'")
    && ocrIpcSource.includes('function preserveRawGujiReferenceText')
    && ocrIpcSource.includes('function getRawFeijiangReferenceText')
    && ocrIpcSource.includes("text_source: 'feijiang_reference_markdown'")
    && ocrIpcSource.includes('if (isFeijiangReferenceRecoveredResult(result) && rawFeijiangReferenceText)')
    && ocrIpcSource.indexOf('if (isFeijiangReferenceRecoveredResult(result) && rawFeijiangReferenceText)') < ocrIpcSource.indexOf('const storageResultBase = gujiOptions')
    && reprocessDocumentOcrStructureBody.includes('const rawFeijiangReferenceText = getRawFeijiangReferenceText(result)')
    && reprocessDocumentOcrStructureBody.includes('isFeijiangReferenceRecoveredResult(result) && rawFeijiangReferenceText')
    && reprocessDocumentOcrStructureBody.includes('const structureResults = pagesWithResults.map')
    && reprocessDocumentOcrStructureBody.includes('preserveRawGujiReferenceText(result as OcrRecognizeResult, rawFeijiangReferenceText, { page, generatedAt })')
    && reprocessDocumentOcrStructureBody.includes('? preserveRawGujiReferenceText(nextResultBase, preferredGujiText, { page, generatedAt })')
    && !ocrIpcSource.includes('E:\\\\Download\\\\edge')
    && !hasLikelyHardcodedPrivateDocId(ocrIpcSource)
    && postProcessPdfOcrResultsBatchedBody.includes('const feijiangReference = ocrOptions.profile === \'guji_print_vertical\'')
    && postProcessPdfOcrResultsBatchedBody.includes('recoverGujiPageFromFeijiangReference(item.page, feijiangReference, ocrOptions, signal)')
    && postProcessPdfOcrResultsBatchedBody.includes('const referenceMismatchIssue = referencePayload')
    && postProcessPdfOcrResultsBatchedBody.includes('getGujiFeijiangReferenceMismatchIssue(result, referencePayload)')
    && !ocrIpcSource.includes('postProcessRecognizedPageResult(payload, page.image_path, getAsyncPdfPostProcessOptions(ocrOptions), { signal })')
    && !ocrIpcSource.includes('const qualityIssue = getGujiAsyncPdfRetryableQualityIssue(result, page.image_path, ocrOptions)')
    && ocrIpcSource.includes('gujismart_recovered_from_feijiang_json: true')
    && processDocumentOcrBody.includes('await recoverCompletedGujiPagesFromFeijiangReference(')
    && processDocumentOcrBody.includes('persistedPageSummary = await syncGujiPaddleReferenceResults(persistedPageSummary)')
    && processDocumentOcrBody.includes('await savePageOcrResultsBatchedDeferred(retryResults')
    && processDocumentOcrBody.indexOf('await savePageOcrResultsBatchedDeferred(retryResults') < processDocumentOcrBody.lastIndexOf('persistedPageSummary = await syncGujiPaddleReferenceResults(persistedPageSummary)')
    && ocrIpcSource.includes('const recoveredResults = await recoverGujiPagesFromFeijiangReference(remainingPages, pdfPath, retryOptions, signal)'),
  'Guji async PDF OCR should sync all recoverable pages from a same-name PaddleOCR reference JSON after async save and after incomplete-page retries, without hardcoded private paths.',
)
assert(
  ocrIpcSource.includes('function createFeijiangReferenceTextOnlyIr')
    && ocrIpcSource.includes('function getFeijiangReferenceLayoutSafetyIssue')
    && ocrIpcSource.includes('function preserveTrustedFeijiangReferenceLayout')
    && ocrIpcSource.includes('function summarizeDiscardedFeijiangLayoutSources')
    && preserveRawGujiReferenceTextBody.includes('source_type: String(source.source_type || \'feijiang_reference_text\')')
    && preserveRawGujiReferenceTextBody.includes('const layoutSafetyIssue = getFeijiangReferenceLayoutSafetyIssue(source, options.page)')
    && preserveRawGujiReferenceTextBody.includes('return preserveTrustedFeijiangReferenceLayout(result, text, options)')
    && preserveRawGujiReferenceTextBody.includes('layout_result: []')
    && preserveRawGujiReferenceTextBody.includes('words_result: []')
    && preserveRawGujiReferenceTextBody.includes('gujismart_ir: textOnlyIr')
    && preserveRawGujiReferenceTextBody.includes('ir_text: \'\'')
    && preserveRawGujiReferenceTextBody.includes('discarded_untrusted_feijiang_reference_layout: true')
    && preserveRawGujiReferenceTextBody.includes('discarded_untrusted_feijiang_reference_layout_issue: layoutSafetyIssue')
    && preserveRawGujiReferenceTextBody.includes('discarded_untrusted_feijiang_reference_layout_summary: discardedLayoutSummary')
    && !normalizeFeijiangReferenceTextOnlyResultBody.includes('ensureOcrResultIr(textOnlyResult')
    && !normalizeFeijiangReferenceTextOnlyResultBody.includes('forceRebuild: true'),
  'Recovered Feijiang reference pages should keep safe reference layout coordinates, and fall back to text-only OCR only when the reference layout fails safety checks.',
)
assert(
  ocrTextSource.includes('function shouldSuppressUntrustedFeijiangReferenceLayout')
    && ocrTextSource.includes('normalization.discarded_untrusted_feijiang_reference_layout === true')
    && ocrTextSource.includes('if (shouldSuppressUntrustedFeijiangReferenceLayout(parsed)) return []')
    && getFacsimileOcrResultBody.includes('normalization.discarded_untrusted_feijiang_reference_layout === true')
    && getFacsimileOcrResultBody.includes('layout_result: []')
    && getFacsimileOcrResultBody.includes('raw_layout_result: []')
    && getFacsimileOcrResultBody.includes('words_result: []')
    && getFacsimileOcrResultBody.includes("facsimile_layout_source: 'feijiang_reference_text_only'")
    && textEditorSource.includes('function buildPlainTextWordsResult')
    && textEditorSource.includes('getMarkdownText(ocrResult?.markdown) || getTextValue(ocrResult?.text)'),
  'Renderer should suppress untrusted Feijiang reference layout boxes while still showing text-only OCR content in the proofing editor.',
)
assert(
  flushOcrStatusBufferBody.includes('data.status === \'completed\'')
    && flushOcrStatusBufferBody.includes('message.destroy(`ocr-error-${data.docId}`)')
    && flushOcrStatusBufferBody.indexOf('if (data.status === \'error\')') > flushOcrStatusBufferBody.indexOf('data.status === \'completed\''),
  'A final successful OCR completion event should clear stale page-level OCR error toasts from earlier retryable chunk failures.',
)
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
    && ocrIpcSource.includes('SELECT id, doc_id, page_num, image_path, proofed_text, ocr_text, ocr_text_ref, ocr_result, ocr_result_ref, ocr_status')
    && ocrIpcSource.includes('hydratePagePayloadRows(rows)')
    && savePageOcrResultsBody.includes('const guardedPageResults = pageResults.map(guardRepeatedOcrPageResult)')
    && savePageOcrResultsBody.includes('pageSnapshots = getPageSnapshotsForOcrSave(guardedPageResults.map((pageResult) => pageResult.pageId))')
    && savePageOcrResultsBody.includes('const existingPage = pageSnapshots.get(pageResult.pageId)'),
  'savePageOcrResults should prefetch and hydrate page save snapshots once per save batch.',
)
assert(
  ocrIpcSource.includes('function guardRepeatedOcrPageResult')
    && ocrIpcSource.includes('findLikelyRunawayRepeatedOcrText(pageResult.result || pageResult.text)')
    && ocrIpcSource.includes('formatSuspiciousRepeatedOcrTextIssue(repeatedIssue)')
    && ocrIpcSource.includes('OCR_ASYNC_PDF_QUALITY_RETRYABLE_PREFIX')
    && ocrIpcSource.includes('isOcrQualityFailureMessage(pageResult.error)')
    && savePageOcrResultsBody.indexOf('const guardedPageResults = pageResults.map(guardRepeatedOcrPageResult)') < savePageOcrResultsBody.indexOf('transaction(() => {'),
  'savePageOcrResults should guard suspicious runaway repeated OCR text and persist async PDF quality failures as retryable error pages.',
)
assert(
  resetPagesForFullOcrRerunBody.includes('SET proofed_text = NULL')
    && !resetPagesForFullOcrRerunBody.includes('ocr_result = NULL')
    && !resetPagesForFullOcrRerunBody.includes('ocr_text = NULL')
    && savePageOcrResultsBody.includes('const hasExistingOcrText = String(existingPage?.ocr_text || \'\').trim().length > 0')
    && savePageOcrResultsBody.includes("if (pageResult.status === 'error' && existingPage && hasExistingOcrText && !isOcrQualityFailureMessage(pageResult.error))")
    && savePageOcrResultsBody.includes("SET ocr_status = ?")
    && savePageOcrResultsBody.includes("'completed',"),
  'Full-document OCR reruns should keep existing OCR text for transient failures, but quality failures must not restore bad old OCR as completed.',
)
assert(
  ocrIpcSource.includes('function isOcrQualityFailureMessage')
    && ocrIpcSource.includes('少量横排大块')
    && ocrIpcSource.includes('本页结果未写入正文'),
  'OCR quality failures should be distinguished from transient upload/network failures before preserving old page text.',
)
assert(
  ocrIpcSource.includes('function savePageQualityFailureOcrError')
    && ocrIpcSource.includes('async function savePageQualityFailureOcrError')
    && ocrIpcSource.includes('function recoverPageQualityFailureFromFeijiangReference')
    && savePageQualityFailureOcrErrorBody.includes('const recovered = await recoverPageQualityFailureFromFeijiangReference(page, doc, options)')
    && savePageQualityFailureOcrErrorBody.includes("return 'recovered'")
    && savePageQualityFailureOcrErrorBody.includes('savePageOcrResults([{')
    && savePageQualityFailureOcrErrorBody.includes("text: '',")
    && savePageQualityFailureOcrErrorBody.includes("status: 'error',")
    && savePageQualityFailureOcrErrorBody.indexOf('recoverPageQualityFailureFromFeijiangReference') < savePageQualityFailureOcrErrorBody.indexOf('savePageOcrResults([{')
    && qualityFailureSaveCallCount >= 4,
  'Manual page OCR actions should recover trusted Feijiang reference pages before persisting layout-quality failures through the normal OCR save path.',
)
assert(
  singlePageRetryCatchBody.includes('if (isOcrQualityFailureMessage(message))')
    && singlePageRetryCatchBody.includes('const recovered = await recoverPageQualityFailureFromFeijiangReference(originalPage, doc, {')
    && singlePageRetryCatchBody.includes('resultsByPageId.set(originalPage.id, recovered)')
    && singlePageRetryCatchBody.indexOf('const recovered = await recoverPageQualityFailureFromFeijiangReference(originalPage, doc, {') < singlePageRetryCatchBody.indexOf("status: 'error'"),
  'Automatic failed-page OCR retries should restore quality-rejected guji pages from the same-name Feijiang reference JSON before saving an error placeholder.',
)
assert(
  ocrIpcSource.includes('function isRetryableOcrError')
    && ocrIpcSource.includes("if (isOcrQualityFailureMessage(message) || message.includes('缺少可读取页图')) return false"),
  'OCR quality failures should stop the document attempt instead of triggering repeated full-document retries.',
)
assert(
  ocrIpcSource.includes('OCR_ASYNC_RESULT_FILE_NOT_READY_PREFIX')
    && ocrIpcSource.includes('rawMessage.includes(OCR_ASYNC_RESULT_FILE_NOT_READY_PREFIX)')
    && ocrIpcSource.includes('waitingResultFileMessage')
    && ocrCoreSource.includes('ASYNC_RESULT_FILE_NOT_READY_PREFIX')
    && ocrCoreSource.includes('ASYNC_RESULT_DOWNLOAD_IDLE_TIMEOUT_MS')
    && ocrCoreSource.includes('readAsyncResultChunkWithTimeout')
    && ocrCoreSource.includes('awaitingResultFile?: boolean')
    && ocrCoreSource.includes('statusPayload.awaitingResultFile = true'),
  'Async PDF OCR should show the result-file wait state and must not automatically rerun the whole document when the service never returns a result URL.',
)
assert(
  ocrIpcSource.includes("const OCR_ASYNC_JOB_STALLED_PREFIX = '[async_job_stalled]'")
    && ocrIpcSource.includes('function isAsyncPdfRecoverableStallError')
    && ocrIpcSource.includes('rawMessage.includes(OCR_ASYNC_JOB_STALLED_PREFIX)')
    && processDocumentOcrBody.includes('if (isAsyncPdfRecoverableStallError(error))')
    && processDocumentOcrBody.includes('异步 PDF OCR 进度停住，正在自动补跑未完成页')
    && processDocumentOcrBody.includes('pageResults = await retryIncompletePagesWithSinglePageOcr(')
    && processDocumentOcrBody.includes('正在自动补跑未完成页')
    && ocrIpcSource.includes('const OCR_ORIGINAL_PDF_RETRY_PAGE_RANGE_CHUNK_SIZE = 10')
    && ocrIpcSource.includes('pageRangeChunkSize: pageRangeChunkSize || OCR_ORIGINAL_PDF_RETRY_PAGE_RANGE_CHUNK_SIZE'),
  'Document OCR should recover from async PDF jobs stuck at a partial page count by auto-rerunning incomplete pages with original-PDF pageRanges, not full-document retries.',
)
assert(
  ocrIpcSource.includes('function getLikelyGujiPdfTableMisclassification')
    && ocrIpcSource.includes('PDF 异步 OCR 疑似把古籍竖排版面误判成表格')
    && ocrIpcSource.includes('function getLikelyAsyncPdfTableMisclassification')
    && ocrIpcSource.includes('function ensurePageImageForOcrFallback')
    && ocrIpcSource.includes('function renderPdfPageToImageBuffer')
    && ocrIpcSource.includes('function getVerticalFallbackOcrOptions')
    && ocrIpcSource.includes('delete metadata.ocr_route_preference')
    && ocrIpcSource.includes('function clearDocumentOcrRoutePreference')
    && ocrIpcSource.includes('function resolveFallbackPdfPathForPostProcess')
    && postProcessPdfOcrResultsBatchedBody.includes('const fallbackPdfPath = pdfPath || resolveFallbackPdfPathForPostProcess(pages)')
    && postProcessPdfOcrResultsBatchedBody.includes('preserveServiceCoordinates: true')
    && !postProcessPdfOcrResultsBatchedBody.includes('const imageCoordinateMismatchIssue = getLikelyAsyncPdfImageCoordinateMismatchIssue(result, item.page.image_path)')
    && !postProcessPdfOcrResultsBatchedBody.includes('const tableMisclassification = safePreferredText ? null : getLikelyAsyncPdfTableMisclassification(result, item.page.image_path, ocrOptions)')
    && !postProcessPdfOcrResultsBatchedBody.includes('const fallbackOptions = getRiskyPageImagePageOptions(fallbackPage, ocrOptions)')
    && !postProcessPdfOcrResultsBatchedBody.includes('recognizeSplitPageImageFallback(fallbackPage, fallbackOptions, signal, fallbackIssue)'),
  'PDF async OCR should preserve service-returned page coordinates and not fall back to vertical page-image OCR before saving returned results.',
)
assert(
  isLikelyBookishPdfTableResultBody.includes('tableBlocks.length === 0')
    && isLikelyBookishPdfTableResultBody.includes('tableBlocks.some(hasNarrativeTableCells)')
    && !isLikelyBookishPdfTableResultBody.includes('hasBookChrome')
    && !isLikelyBookishPdfTableResultBody.includes('blocks.length <= 8'),
  'Book-page table fallback detection should be conservative and must not treat any table plus header/footer chrome as a bad OCR page.',
)
assert(
  ocrIpcSource.includes('const horizontalDominatedBookPage = textBlocks.length <= 24')
    && ocrIpcSource.includes('verticalRatio < 0.12')
    && ocrIpcSource.includes('pageSize.width >= pageSize.height * 1.05')
    && ocrIpcSource.includes('getUnderSegmentedRiskyPageImageMessage')
    && ocrIpcSource.includes('reportProgress(page, \'error\', message)')
    && ocrIpcSource.includes("if (underSegmented)")
    && ocrIpcSource.includes("status: 'error'"),
  'Risky page-image OCR should reject under-segmented double-page facsimile results instead of saving few horizontal blocks as completed.',
)
assert(
  ocrIpcSource.includes("if (primaryOptions.profile === 'guji_print_vertical') return null")
    && !ocrIpcSource.includes("primaryOptions.profile === 'guji_print_vertical' && docType !== '\\u53e4\\u7c4d'"),
  'Risky page-image OCR should not replace a vertical guji result with a general retry that can reintroduce table-shaped vertical text.',
)
assert(
  ocrIpcSource.includes('function getRiskyPageImagePageOptions')
    && ocrIpcSource.includes('hasVerticalGujiProcessingMeta(pageResult) || hasVerticalBlockLayoutSignals(pageResult, page.image_path)')
    && riskyPageImageOcrBody.includes('for (const page of pages)')
    && riskyPageImageOcrBody.includes('const pageOptions = getRiskyPageImagePageOptions(page, primaryOptions)')
    && riskyPageImageOcrBody.includes('recognizeSinglePageWithResolvedOptions(page, pageOptions, options.signal)')
    && !riskyPageImageOcrBody.includes('Promise.all(pages.map')
    && !riskyPageImageOcrBody.includes('createLimiter')
    && !riskyPageImageOcrBody.includes('limit(async'),
  'Risky whole-document page-image OCR should use the same per-page single-page wrapper and vertical option resolution as manual current-page OCR, not concurrent batch OCR.',
)
assert(
  ocrIpcSource.includes('const OCR_LAYOUT_QUALITY_REJECTED_PREFIX')
    && ocrIpcSource.includes('function getLikelyGujiNonBookHallucinationIssue')
    && ocrIpcSource.includes('hasGujiWebMetadataHallucination(totalText)')
    && ocrIpcSource.includes('hasGujiModernDateHallucination(totalText)')
    && ocrIpcSource.includes('hasGujiMachineTokenHallucination(text)')
    && ocrIpcSource.includes('function hasGujiUnexpectedScriptHallucination')
    && ocrIpcSource.includes('function hasGujiKanaPunctuationSubstitutionIssue')
    && ocrIpcSource.includes('throw new Error(hardIssue)')
    && ocrIpcSource.includes('function sanitizeGujiNonBookHallucinations')
    && ocrIpcSource.includes('function getGujiOcrOptionsForResult')
    && ocrIpcSource.includes('function stripGujiStoragePlaceholders')
    && ocrIpcSource.includes('function filterGujiPlaceholderBlocks')
    && ocrIpcSource.includes('function isGujiDuplicateHeaderBlock')
    && ocrIpcSource.includes('removed_duplicate_header_blocks')
    && ocrIpcSource.includes('function isGujiPageEdgeMarkerBlock')
    && ocrIpcSource.includes('function isGujiNoisyPageMarkerLikeText')
    && ocrIpcSource.includes('removed_page_marker_blocks')
    && ocrIpcSource.includes('function isGujiTinyNoiseBlock')
    && ocrIpcSource.includes('removed_tiny_noise_blocks')
    && ocrIpcSource.includes('const storageResultBase = gujiOptions')
    && ocrIpcSource.includes('ensureOcrResultIr(stripGujiStoragePlaceholders(sanitizeGujiNonBookHallucinations(normalized, gujiOptions, page?.image_path))')
    && ocrIpcSource.includes('layout_result: nextLayout')
    && ocrIpcSource.includes('const storageText = gujiOptions && preferredGujiText')
    && ocrIpcSource.includes('isEmptyTableMarkupPlaceholder(text)')
    && ocrIpcSource.includes('rebuilt_text_without_ocr_placeholders')
    && ocrIpcSource.includes('function getRiskyPageImageLayoutQualityIssue')
    && ocrIpcSource.includes('const hallucinationIssue = getLikelyGujiNonBookHallucinationIssue(result, imagePath, ocrOptions)')
    && !postProcessPdfOcrResultsBatchedBody.includes('const hardQualityIssue = safePreferredText ? null : getRiskyPageImageNonTableHardIssue(result, item.page.image_path, ocrOptions)')
    && ocrIpcSource.includes('message.includes(OCR_LAYOUT_QUALITY_REJECTED_PREFIX)')
    && ocrIpcSource.includes('String(message || \'\').includes(OCR_LAYOUT_QUALITY_REJECTED_PREFIX)')
    && ocrIpcSource.includes('return message.replace(OCR_LAYOUT_QUALITY_REJECTED_PREFIX, \'\').trim()'),
  'Risky page-image OCR should reject obvious layout-quality failures and non-book hallucinations without triggering full-document retries or showing internal markers.',
)
assert(
  ocrIpcSource.includes('function isLikelyMergedWideVerticalGujiBlock')
    && ocrIpcSource.includes('isLikelyMergedWideVerticalGujiBlock(block, pageSize)')
    && ocrIpcSource.includes('|| mergedWideVerticalBlocks > 0')
    && ocrCoreSource.includes('function splitMergedWideVerticalTextLineBlocks')
    && ocrCoreSource.includes('function splitMergedWideVerticalTextBlock')
    && ocrCoreSource.includes('function filterGujiTinyNoiseBlocks')
    && ocrCoreSource.includes('merged_wide_vertical_line_blocks_split')
    && ocrCoreSource.includes('removed_tiny_noise_blocks')
    && ocrCoreSource.includes('nextBlocks.push(...splitMergedWideVerticalTextBlock(block))')
    && ocrCoreSource.includes('filterGujiTinyNoiseBlocks(rebuilt, options)')
    && !ocrCoreSource.includes('filterGujiTinyNoiseBlocks(splitMergedWideVerticalTextLineBlocks(tightened, options), options)'),
  'Guji vertical page-image OCR may split line-delimited wide blocks and remove tiny noise, while async PDF readback/storage must not silently move saved coordinates.',
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
    && savePageOcrResultsBody.includes('const shouldWriteOcrVersion = resultPayload && existingPage')
    && savePageOcrResultsBody.includes("pageResult.status === 'error' && isOcrQualityFailureMessage(pageResult.error)")
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
  ocrIpcSource.includes('function getPagesForOcrAttempt')
    && ocrIpcSource.includes('return getPagesNeedingOcr(pages, resumeExisting || attempt > 1)')
    && processDocumentOcrBody.includes('const resumeThisAttempt = resumeExisting || attempt > 1')
    && processDocumentOcrBody.includes('pagesForOcr = getPagesForOcrAttempt(pages, resumeExisting, attempt)'),
  'document OCR retries should resume already completed pages after the first failed attempt, even when the original request was a full rerun.',
)
assert(
  asyncPdfBranchBody.includes('pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)')
    && asyncPdfBranchBody.includes('const asyncResultPageItems = pagesForOcr.map((page, index) => {')
    && asyncPdfBranchBody.includes('const resultIndex = asyncPdfRouteRisk?.requireFullFileUpload ? sourcePageIndex : index')
    && asyncPdfBranchBody.includes('asyncResultPageItems,')
    && !asyncPdfBranchBody.includes('pages.map((page, index) => ({ page, sourcePageIndex: index, resultIndex: index }))'),
  'PDF OCR async fallback save path should post-process only unfinished resume pages and map whole-PDF guarded results by original page number.',
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
    && drainReindexQueueBody.includes('processedThisDrain += 1')
    && drainReindexQueueBody.includes('!isBackgroundReindexPaused()'),
  'search background reindexing should process a bounded number of documents per drain cycle.',
)
assert(
  drainReindexQueueBody.includes('scheduleBackgroundReindex([], { delayMs: BACKGROUND_REINDEX_DRAIN_PAUSE_MS })')
    && scheduleBackgroundReindexBody.includes('options: { activeResolved?: boolean; delayMs?: number; reason?: SearchIndexReindexReason }')
    && scheduleBackgroundReindexBody.includes('options.delayMs ?? BACKGROUND_REINDEX_DELAY_MS'),
  'search background reindexing should pause before continuing a non-empty queue after each drain batch.',
)
assert(
  semanticSearchSource.includes('export function pauseBackgroundSearchReindex')
    && semanticSearchSource.includes('export function resumeBackgroundSearchReindex')
    && semanticSearchSource.includes('let backgroundReindexPauseDepth = 0')
    && scheduleBackgroundReindexBody.includes('if (isBackgroundReindexPaused()) return')
    && drainReindexQueueBody.includes('if (isBackgroundReindexPaused())'),
  'search background reindexing should support an explicit pause gate for heavy foreground work.',
)
assert(
  batchOcrBody.includes('pauseBackgroundSearchReindex()')
    && batchOcrBody.includes('try {')
    && batchOcrBody.includes("resumeBackgroundSearchReindex({ reason: 'ocr-batch-deferred' })")
    && batchOcrBody.indexOf('pauseBackgroundSearchReindex()') < batchOcrBody.indexOf('createRecoverableBatchOcrItems')
    && batchOcrBody.indexOf('resumeBackgroundSearchReindex') > batchOcrBody.indexOf('await Promise.all('),
  'batch OCR should pause background search reindexing before recovery/status writes and resume it after the batch settles.',
)
assert(
  ocrIpcSource.includes('function createRecoverableBatchOcrItems')
    && sliceBetween(ocrIpcSource, 'function createRecoverableBatchOcrItems', 'function updateRecoverableBatchOcrItem', 'recoverable batch OCR item body').includes('scheduleDatabaseSave()')
    && !sliceBetween(ocrIpcSource, 'function createRecoverableBatchOcrItems', 'function updateRecoverableBatchOcrItem', 'recoverable batch OCR item body').includes('saveDatabase()'),
  'batch OCR recovery queue creation should defer checkpoints instead of synchronously blocking upload startup.',
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
