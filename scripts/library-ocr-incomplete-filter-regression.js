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
  incompleteFilterBlock.includes('NOT EXISTS (')
    && incompleteFilterBlock.includes('FROM pages p_any')
    && incompleteFilterBlock.includes('p_any.doc_id = d.id'),
  'ocrIncomplete filter should treat only documents without page rows as zero-page records.',
)

assert(
  incompleteFilterBlock.includes('EXISTS (')
    && incompleteFilterBlock.includes('FROM pages p_incomplete')
    && incompleteFilterBlock.includes("COALESCE(p_incomplete.ocr_status, '') <> 'completed'")
    && incompleteFilterBlock.includes("AND NOT (${buildPageContentAvailableCondition('p_incomplete')})")
    && incompleteFilterBlock.includes("LIMIT 1"),
  'ocrIncomplete filter should use an indexed EXISTS page probe for unfinished pages without usable text.',
)

assert(
  !/SELECT\s+COUNT\(\*\)\s+FROM\s+pages\s+p_(done|text)/i.test(incompleteFilterBlock),
  'ocrIncomplete filter should not count completed/text pages per candidate document; it becomes too expensive at page size 100.',
)

assert(
  documentsSource.includes('(SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id) as actual_page_count')
    && documentsSource.includes('page_count: Math.max(storedPageCount, actualPageCount)')
    && documentsSource.includes('const pageCount = Math.max(Number(doc.page_count || 0), actualPageCount)'),
  'document list and health rows should use actual page rows as a fallback when legacy document page_count is zero.',
)

console.log('Library OCR incomplete filter regression passed.')
