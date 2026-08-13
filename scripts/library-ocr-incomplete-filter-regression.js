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
const libraryCacheSource = fs.readFileSync(path.join(root, 'src', 'main', 'library-state-cache.ts'), 'utf8')
const ocrFiltersSource = fs.readFileSync(path.join(root, 'src', 'main', 'ocr-library-filters.ts'), 'utf8')
const libraryViewSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')
const documentViewSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'DocumentView.tsx'), 'utf8')
const facsimileSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'GujiFacsimileProofreader.tsx'), 'utf8')
const overlaySource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'OverlayProofreader.tsx'), 'utf8')

assert(
  databaseSource.includes('CREATE INDEX IF NOT EXISTS idx_pages_doc_ocr_status ON pages(doc_id, ocr_status);'),
  'pages should have a composite doc/OCR status index for large-library incomplete OCR filters.',
)

const incompleteFilterBlock = sliceBetween(
  documentsSource,
  'if (options?.ocrIncomplete) {',
  '} else if (options?.ocrNeedsRepair) {',
  'ocrIncomplete list filter',
)

assert(
  incompleteFilterBlock.includes('buildOcrIncompleteCondition()')
    && !incompleteFilterBlock.includes('FROM pages p_any')
    && !incompleteFilterBlock.includes('FROM pages p_incomplete'),
  'ocrIncomplete filter should use document-level OCR status so large libraries do not scan page rows on every list query.',
)

assert(
  !/SELECT\s+COUNT\(\*\)\s+FROM\s+pages\s+p_(done|text)/i.test(incompleteFilterBlock),
  'ocrIncomplete filter should not count completed/text pages per candidate document; it becomes too expensive at page size 100.',
)

const repairFilterBlock = sliceBetween(
  documentsSource,
  '} else if (options?.ocrNeedsRepair) {',
  '} else if (options?.ocrStatus) {',
  'ocrNeedsRepair list filter',
)

assert(
  repairFilterBlock.includes('buildOcrNeedsRepairCondition()'),
  'ocrNeedsRepair list filtering should share the exact condition used by sidebar counts.',
)

const pageContentStatusBlock = sliceBetween(
  ocrFiltersSource,
  'export function buildPageContentAvailableConditionStatusOnly',
  'export function buildPageNeedsOcrRepairCondition',
  'lightweight OCR page content predicate',
)

assert(
  ocrFiltersSource.includes("COALESCE(${documentAlias}.ocr_status, '') IN ('completed', 'error')")
    && ocrFiltersSource.includes("buildPageNeedsOcrRepairCondition('p_ocr_repair')")
    && ocrFiltersSource.includes('p_ocr_repair.doc_id = ${documentAlias}.id')
    && ocrFiltersSource.includes('p_ocr_repair_any.doc_id = ${documentAlias}.id')
    && ocrFiltersSource.includes('p_ocr_repair_none.doc_id = ${documentAlias}.id')
    && ocrFiltersSource.indexOf('p_ocr_repair_any.doc_id = ${documentAlias}.id')
      < ocrFiltersSource.indexOf("LOWER(${documentAlias}.error_message) LIKE '%ocr%'")
    && pageContentStatusBlock.includes("COALESCE(${pageAlias}.ocr_text, '') <> ''")
    && pageContentStatusBlock.includes("COALESCE(${pageAlias}.proofed_text, '') <> ''")
    && pageContentStatusBlock.includes("COALESCE(${pageAlias}.ocr_result_ref, '') <> ''")
    && !pageContentStatusBlock.includes('TRIM(')
    && !pageContentStatusBlock.includes("LIKE '%\"error\"%'"),
  'ocrNeedsRepair should ignore stale page status when usable OCR text/refs exist, without parsing large OCR JSON bodies.',
)

const attachPageStatsBlock = sliceBetween(
  documentsSource,
  'function attachPageStatsForDocuments',
  'function resolveListPdfAssetInfo',
  'attachPageStatsForDocuments',
)

assert(
  !attachPageStatsBlock.includes('FROM pages p')
    && (
      attachPageStatsBlock.includes('must not re-aggregate the pages table')
      || attachPageStatsBlock.includes('page_count and ocr_status are written at import')
    ),
  'document list attachPageStats must read fixed document fields only and never re-aggregate the pages table.',
)

assert(
  attachPageStatsBlock.includes('actual_page_count: pageCount')
    && attachPageStatsBlock.includes("String(doc.ocr_status || '') === 'completed'"),
  'list page stats should trust document.page_count / ocr_status instead of scanning page rows.',
)

const sidebarCacheBlock = sliceBetween(
  libraryCacheSource,
  'function smartViewCountSql',
  'function buildCache',
  'library sidebar smart-view aggregate',
)

assert(
  sidebarCacheBlock.includes('CASE WHEN ${buildOcrIncompleteCondition()} THEN 1 ELSE 0 END')
    && sidebarCacheBlock.includes('CASE WHEN ${buildOcrNeedsRepairCondition()} THEN 1 ELSE 0 END')
    && sidebarCacheBlock.includes('FROM library_project_documents project_scope')
    && sidebarCacheBlock.includes('WHERE project_scope.project_id = ?')
    && !sidebarCacheBlock.includes("COALESCE(d.ocr_status, 'pending') <> 'completed' OR COALESCE(d.page_count, 0) = 0"),
  'project smart-view counts should use the same OCR incomplete condition as the document list instead of over-counting legacy pending documents with OCR text.',
)

assert(
  documentsSource.includes('page_count: Math.max(storedPageCount, actualPageCount)')
    && documentsSource.includes('const pageCount = Math.max(Number(doc.page_count || 0), actualPageCount)'),
  'document list and health rows should use actual page rows as a fallback when legacy document page_count is zero.',
)

const ocrNormalizationBlock = sliceBetween(
  documentsSource,
  'function normalizeCompletedOcrDocuments',
  'function scheduleDocumentHealthReportRefresh',
  'bounded OCR status normalization',
)
assert(
  ocrNormalizationBlock.includes('const candidates = options?.inspectOcrRepairPages')
    && ocrNormalizationBlock.includes(': documents.filter')
    && ocrNormalizationBlock.includes('getDocumentListOcrPageSummaries(candidates.map')
    && ocrNormalizationBlock.includes('inspectOcrRepairPages')
    && documentsSource.includes('OCR待修复')
    && ocrNormalizationBlock.includes('if (candidates.length === 0) return documents')
    && documentsSource.includes('WHERE doc_id IN (${placeholders})')
    && documentsSource.includes('buildPageContentAvailableConditionStatusOnly')
    && documentsSource.includes('SUM(CASE WHEN ${contentOk} THEN 1 ELSE 0 END) as completed')
    && documentsSource.includes("SUM(CASE WHEN ocr_status = 'error' AND NOT (${contentOk}) THEN 1 ELSE 0 END) as failed"),
  'document list may repair inconsistent OCR status only for bounded current-page candidates, without full-library/body normalization.',
)

assert(
  libraryViewSource.includes('function shouldShowDocumentReviewMessage')
    && libraryViewSource.includes("return doc.ocr_status === 'completed' && doc.import_status === 'processed'")
    && libraryViewSource.includes('if (shouldShowDocumentReviewMessage(doc, info)) return false')
    && libraryViewSource.includes('patch.error_message = data.errorMessage || null')
    && libraryViewSource.includes('{doc.error_message}')
    && libraryViewSource.includes('shouldShowDocumentReviewMessage')
    && libraryViewSource.includes('OCR 已保存：${data.errorMessage}'),
  'Library cards should show completed OCR page-level issues as short review warnings instead of clearing them or rendering failure banners.',
)

assert(
  documentsSource.includes('inspectOcrRepairPages: options?.ocrNeedsRepair === true')
    && documentsSource.includes('failedPageNums')
    && documentsSource.includes('pendingPageNums')
    && documentsSource.includes('summary.pending > 0'),
  'OCR repair list responses should inspect page-level pending rows and expose their page numbers instead of showing an unexplained card.',
)

const pageUpdateBlock = sliceBetween(
  documentsSource,
  "ipcMain.handle('pages:update'",
  "ipcMain.handle('pages:insertManual'",
  'page update OCR reconciliation',
)
assert(
  pageUpdateBlock.includes("normalizedData.ocr_status = 'completed'")
    && pageUpdateBlock.includes('syncDocumentOcrStatusAfterPageEdit(page.doc_id)')
    && pageUpdateBlock.includes('refreshLibraryOcrStateAfterPageEdit(page.doc_id)')
    && documentsSource.includes('buildPageNeedsOcrRepairCondition')
    && documentsSource.includes('scheduleLibrarySmartViewCountsRefresh(projectIds)'),
  'Manual page text saves should atomically complete the page/document and refresh project-scoped OCR repair counts.',
)

assert(
  facsimileSource.includes("...(fullText ? { ocr_status: 'completed' as const } : {})")
    && overlaySource.includes("...(fullText ? { ocr_status: 'completed' as const } : {})")
    && documentViewSource.includes("detail: { source: 'ocr-page-content-saved' }")
    && libraryViewSource.includes("event.detail?.source === 'ocr-page-content-saved'")
    && libraryViewSource.includes('loadSmartViewCounts({ refresh: true })'),
  'Both manual proofreaders should send completed OCR status and refresh a mounted OCR repair list without a manual reload.',
)

console.log('Library OCR incomplete filter regression passed.')
