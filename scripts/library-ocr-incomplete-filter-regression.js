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
const libraryViewSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')

assert(
  databaseSource.includes('CREATE INDEX IF NOT EXISTS idx_pages_doc_ocr_status ON pages(doc_id, ocr_status);'),
  'pages should have a composite doc/OCR status index for large-library incomplete OCR filters.',
)

const incompleteFilterBlock = sliceBetween(
  documentsSource,
  'if (options?.ocrIncomplete) {',
  '} else if (options?.ocrStatus) {',
  'ocrIncomplete list filter',
)

assert(
  incompleteFilterBlock.includes("COALESCE(d.ocr_status, '') <> 'completed'")
    && !incompleteFilterBlock.includes('FROM pages p_any')
    && !incompleteFilterBlock.includes('FROM pages p_incomplete'),
  'ocrIncomplete filter should use document-level OCR status so large libraries do not scan page rows on every list query.',
)

assert(
  !/SELECT\s+COUNT\(\*\)\s+FROM\s+pages\s+p_(done|text)/i.test(incompleteFilterBlock),
  'ocrIncomplete filter should not count completed/text pages per candidate document; it becomes too expensive at page size 100.',
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
const statusOnlyContentBlock = sliceBetween(
  documentsSource,
  'function buildPageContentAvailableConditionStatusOnly',
  'function buildDocumentOcrCompleteCondition',
  'status-only OCR content predicate',
)

assert(
  ocrNormalizationBlock.includes('const candidates = documents.filter')
    && ocrNormalizationBlock.includes('getDocumentListOcrPageSummaries(candidates.map')
    && ocrNormalizationBlock.includes('if (candidates.length === 0) return documents')
    && documentsSource.includes('WHERE doc_id IN (${placeholders})')
    && documentsSource.includes('buildPageContentAvailableConditionStatusOnly')
    && !statusOnlyContentBlock.includes('TRIM('),
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

console.log('Library OCR incomplete filter regression passed.')
