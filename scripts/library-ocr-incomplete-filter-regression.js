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

assert(
  documentsSource.includes('function attachPageStatsForDocuments')
    && documentsSource.includes('WHERE p.doc_id IN (${placeholders})')
    && !/LEFT JOIN \(\s*SELECT[\s\S]{0,400}FROM pages p[\s\S]{0,200}GROUP BY p\.doc_id/.test(documentsSource),
  'document list should attach page stats only for the current result page, not full-table page aggregation.',
)

const lightweightCacheBlock = sliceBetween(
  libraryCacheSource,
  'function buildLightweightCache',
  'export function refreshLibraryStateCache',
  'library sidebar lightweight cache',
)

assert(
  lightweightCacheBlock.includes('activeDocumentWhere(buildOcrIncompleteCondition())')
    && !lightweightCacheBlock.includes("COALESCE(d.ocr_status, 'pending') <> 'completed' OR COALESCE(d.page_count, 0) = 0"),
  'dirty sidebar cache should use the same OCR incomplete condition as the document list instead of over-counting legacy pending documents with OCR text.',
)

assert(
  documentsSource.includes('actual_page_count: Number(stats?.actual_page_count || 0)')
    && documentsSource.includes('page_count: Math.max(storedPageCount, actualPageCount)')
    && documentsSource.includes('const pageCount = Math.max(Number(doc.page_count || 0), actualPageCount)'),
  'document list and health rows should use actual page rows as a fallback when legacy document page_count is zero.',
)

assert(
  documentsSource.includes('function getDocumentListOcrPageSummaries')
    && documentsSource.includes('function isDocumentListOcrSettledWithReviewPages')
    && documentsSource.includes('function getDocumentListOcrReviewMessage')
    && documentsSource.includes("return doc.ocr_status === 'error' || doc.import_status === 'error'")
    && documentsSource.includes('summary.pending === 0')
    && documentsSource.includes('summary.failed > 0')
    && documentsSource.includes("ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?")
    && documentsSource.includes('reviewMessage.slice(0, 1000)'),
  'document list normalization should migrate old document-level OCR failures with only settled page errors into completed review warnings.',
)

assert(
  libraryViewSource.includes('function shouldShowDocumentReviewMessage')
    && libraryViewSource.includes("return doc.ocr_status === 'completed' && doc.import_status === 'processed'")
    && libraryViewSource.includes('if (shouldShowDocumentReviewMessage(doc, info)) return false')
    && libraryViewSource.includes('patch.error_message = data.errorMessage || null')
    && libraryViewSource.includes('页面待复核：{doc.error_message}')
    && libraryViewSource.includes('OCR 已保存：${data.errorMessage}'),
  'Library cards should show completed OCR page-level issues as review warnings instead of clearing them or rendering failure banners.',
)

console.log('Library OCR incomplete filter regression passed.')
