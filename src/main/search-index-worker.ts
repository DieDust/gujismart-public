import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { parentPort } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import { deriveOcrReadingBlocksFromIr, deriveOcrTextFromIr, getOrBuildOcrPageIr } from '../shared/ocr-ir'
import {
  createManualLayoutLocationKey,
  getLayoutBlockSearchSegments,
  getManualLayoutSearchSegments,
  projectLayoutBlocksToPageText,
} from '../shared/manual-layout'
import {
  BACKGROUND_REINDEX_DELETE_BATCH_SIZE,
  BACKGROUND_REINDEX_PAGE_BATCH_SIZE,
  BACKGROUND_REINDEX_NGRAM_WRITE_BATCH_SIZE,
  BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE,
  BACKGROUND_REINDEX_TIME_SLICE_MS,
  SEARCH_INDEX_SEGMENT_MAX_CHARS,
  SEARCH_INDEX_SEGMENT_OVERLAP_CHARS,
  SEARCH_INDEX_SEGMENT_STORED_TEXT_MAX_CHARS,
  SEARCH_INDEX_VERSION,
  SEARCH_NGRAM_INDEX_ENABLED,
  SEARCH_NGRAM_MAX_POSITIONS_STORED,
  SEARCH_TRIGRAM_FTS_ENABLED,
} from './search-index-constants'
import { normalizeChineseSearchText } from './text-normalization'
import { readPagePayloadValue, setPayloadDataDir } from './page-payload-files'
import type { SearchIndexWorkerProgress, SearchIndexWorkerTask } from './search-index-worker-client'
import type { SearchReindexDocumentResult } from '../shared/types'

type NativeDatabase = Database.Database
type JsonRecord = Record<string, unknown>
type SearchIndexStagingTable = 'search_ngram_index_staging' | 'search_index_segments_staging'
const WORKER_DATABASE_BUSY_TIMEOUT_MS = 10000
const WORKER_DATABASE_BUSY_RETRY_DELAYS_MS = [50, 100, 250, 500, 1000]

interface OcrBlockPoint {
  x?: number | string | null
  y?: number | string | null
}

interface OcrBlockLocation {
  top?: number | string | null
  left?: number | string | null
  width?: number | string | null
  height?: number | string | null
}

interface OcrBlock {
  words?: string | null
  word?: string | null
  text?: string | null
  label?: string | null
  type?: string | null
  block_type?: string | null
  category?: string | null
  reading_order?: number | string | null
  location?: OcrBlockLocation | OcrBlockPoint[] | null
  points?: OcrBlockPoint[] | null
  rect?: OcrBlockLocation | null
  bbox?: OcrBlockLocation | OcrBlockPoint[] | null
  box?: OcrBlockLocation | OcrBlockPoint[] | null
  block_bbox?: OcrBlockLocation | OcrBlockPoint[] | null
  coordinate?: OcrBlockLocation | OcrBlockPoint[] | null
  coordinate_box?: OcrBlockLocation | OcrBlockPoint[] | null
}

interface OcrResultPayload {
  source_type?: string | null
  ebook?: {
    href?: string | null
    title?: string | null
  } | null
  layout_result?: OcrBlock[]
  raw_layout_result?: OcrBlock[]
  layout_blocks?: OcrBlock[]
  words_result?: OcrBlock[]
}

interface SearchPageRow {
  id: string
  doc_id: string
  page_num: number | null
  proofed_text?: string | null
  ocr_text?: string | null
  ocr_result?: unknown
  ocr_text_ref?: string | null
  ocr_result_ref?: string | null
  proofed_text_ref?: string | null
  has_ocr_result?: number | null
  text?: string | null
  doc_type?: string | null
  title?: string | null
  file_path?: string | null
}

interface SearchIndexSegmentDraft {
  segmentId: string
  pageId: string
  pageNum: number
  sourceKind: string
  href: string | null
  title: string
  ordinal: number
  sourceStart: number
  text: string
  normalizedText: string
  offsetMap: number[]
  textHash: string
}

interface SearchIndexTextPart {
  text: string
  originalStart: number
  partIndex: number
}

interface SearchDocumentRow {
  id: string
  import_status?: string | null
}

const DELETING_IMPORT_STATUS = 'deleting'
const INDEXABLE_PAGE_OCR_RESULT_CONDITION = `(
  TRIM(COALESCE(NULLIF(p.proofed_text, ''), NULLIF(p.ocr_text, ''), '')) = ''
  OR
  d.doc_type IN ('电子书', '文本')
  OR d.file_path LIKE '%.epub'
  OR d.file_path LIKE '%.txt'
  OR d.file_path LIKE '%.md'
  OR d.metadata LIKE '%"file_kind":"ebook"%'
  OR d.metadata LIKE '%"file_kind":"text"%'
  OR d.metadata LIKE '%"import_source_type":"epub"%'
  OR d.metadata LIKE '%"format":"epub"%'
  OR d.doc_type LIKE '%报纸%'
  OR d.doc_type LIKE '%古籍%'
  OR d.doc_type LIKE '%地方志%'
)`
const INDEXABLE_PAGE_BASE_SELECT = `
  SELECT
    p.id,
    p.doc_id,
    p.page_num,
    p.proofed_text,
    p.proofed_text_ref,
    p.ocr_text,
    p.ocr_text_ref,
    COALESCE(NULLIF(p.proofed_text, ''), NULLIF(p.ocr_text, ''), '') as text,
    NULL as ocr_result,
    p.ocr_result_ref,
    CASE WHEN (p.ocr_result IS NOT NULL AND p.ocr_result <> '') OR COALESCE(p.ocr_result_ref, '') <> '' THEN 1 ELSE 0 END as has_ocr_result,
    d.doc_type,
    d.title,
    d.file_path
  FROM pages p
  INNER JOIN documents d ON d.id = p.doc_id
`

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

function isDatabaseBusyError(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : {}
  const code = String(record.code || '')
  const message = String(record.message || error || '')
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|database table is locked/i.test(message)
}

function runWithBusyRetry<T>(operation: () => T): T {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= WORKER_DATABASE_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      lastError = error
      if (!isDatabaseBusyError(error) || attempt >= WORKER_DATABASE_BUSY_RETRY_DELAYS_MS.length) throw error
      sleepSync(WORKER_DATABASE_BUSY_RETRY_DELAYS_MS[attempt])
    }
  }
  throw lastError
}

function runOn(sqlite: NativeDatabase, sql: string, params?: unknown[]): void {
  runWithBusyRetry(() => {
    if (params) {
      sqlite.prepare(sql).run(...params)
      return
    }
    sqlite.exec(sql)
  })
}

function queryAll<T = Record<string, unknown>>(sqlite: NativeDatabase, sql: string, params?: unknown[]): T[] {
  return runWithBusyRetry(() => {
    const statement = sqlite.prepare(sql)
    return params ? statement.all(...params) as T[] : statement.all() as T[]
  })
}

function queryOne<T = Record<string, unknown>>(sqlite: NativeDatabase, sql: string, params?: unknown[]): T | null {
  const row = runWithBusyRetry(() => {
    const statement = sqlite.prepare(sql)
    return params ? statement.get(...params) : statement.get()
  })
  return (row as T | undefined) || null
}

function transaction(sqlite: NativeDatabase, fn: () => void): void {
  runWithBusyRetry(() => sqlite.exec('BEGIN IMMEDIATE TRANSACTION'))
  try {
    fn()
    runWithBusyRetry(() => sqlite.exec('COMMIT'))
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK')
    } catch (rollbackError) {
      if (!isDatabaseBusyError(rollbackError)) throw rollbackError
    }
    throw error
  }
}

function getTableCreateSql(sqlite: NativeDatabase, tableName: string): string {
  try {
    const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { sql?: string } | undefined
    return String(row?.sql || '')
  } catch {
    return ''
  }
}

function dropFtsTableIfNotExternalContent(sqlite: NativeDatabase, tableName: string): boolean {
  const createSql = getTableCreateSql(sqlite, tableName).toLowerCase()
  if (!createSql) return false
  if (createSql.includes("content='search_index_segments'") || createSql.includes('content="search_index_segments"')) return false
  sqlite.exec(`DROP TABLE IF EXISTS ${tableName}`)
  return true
}

function openWorkerDatabase(dbFilePath: string): { sqlite: NativeDatabase; ftsAvailable: boolean; trigramFtsAvailable: boolean; recreatedSearchSegmentsFts: boolean } {
  const sqlite = new Database(dbFilePath)
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma(`busy_timeout = ${WORKER_DATABASE_BUSY_TIMEOUT_MS}`)
  let ftsAvailable = false
  let trigramFtsAvailable = false
  let recreatedSearchSegmentsFts = false
  try {
    recreatedSearchSegmentsFts = dropFtsTableIfNotExternalContent(sqlite, 'search_segments_fts') || recreatedSearchSegmentsFts
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_segments_fts USING fts5(
        title,
        normalized_text,
        content='search_index_segments',
        content_rowid='rowid'
      );
    `)
    ftsAvailable = true
  } catch {
    ftsAvailable = false
  }
  if (ftsAvailable && SEARCH_TRIGRAM_FTS_ENABLED) {
    try {
      recreatedSearchSegmentsFts = dropFtsTableIfNotExternalContent(sqlite, 'search_segments_trigram') || recreatedSearchSegmentsFts
      sqlite.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_segments_trigram USING fts5(
          normalized_text,
          content='search_index_segments',
          content_rowid='rowid',
          tokenize='trigram'
        );
      `)
      trigramFtsAvailable = true
    } catch {
      trigramFtsAvailable = false
    }
  }
  if (recreatedSearchSegmentsFts) {
    try {
      runOn(sqlite, "INSERT INTO search_segments_fts(search_segments_fts) VALUES('rebuild')")
      if (trigramFtsAvailable) {
        runOn(sqlite, "INSERT INTO search_segments_trigram(search_segments_trigram) VALUES('rebuild')")
      }
    } catch {
      // A worker can still rebuild the current document below; startup maintenance handles full rebuilds.
    }
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS search_index_segments_staging (
      job_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      page_id TEXT,
      page_num INTEGER,
      source_kind TEXT DEFAULT 'page',
      href TEXT,
      title TEXT,
      ordinal INTEGER DEFAULT 0,
      source_start INTEGER DEFAULT 0,
      text TEXT DEFAULT '',
      normalized_text TEXT DEFAULT '',
      offset_map TEXT DEFAULT '',
      text_hash TEXT DEFAULT '',
      updated_at TEXT,
      PRIMARY KEY (job_id, segment_id)
    );

    CREATE TABLE IF NOT EXISTS search_ngram_index_staging (
      job_id TEXT NOT NULL,
      gram TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      positions TEXT NOT NULL,
      hit_count INTEGER DEFAULT 0,
      PRIMARY KEY (job_id, gram, segment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_search_segments_staging_doc ON search_index_segments_staging(job_id, doc_id);
    CREATE INDEX IF NOT EXISTS idx_search_ngram_staging_doc ON search_ngram_index_staging(job_id, doc_id);
  `)
  return { sqlite, ftsAvailable, trigramFtsAvailable, recreatedSearchSegmentsFts }
}

function createSearchIndexStagingJobId(docId: string): string {
  return `${docId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function activeDocumentCondition(alias = 'd'): string {
  return `COALESCE(${alias}.import_status, '') <> '${DELETING_IMPORT_STATUS}'`
}

function isDeletingImportStatus(value: unknown): boolean {
  return String(value || '') === DELETING_IMPORT_STATUS
}

function normalizeSearchText(value: string): string {
  return normalizeChineseSearchText(value)
}

function normalizeSearchTextWithOffsetMap(value: string): { text: string; offsets: number[] } {
  const source = String(value || '')
  const offsets: number[] = []
  let normalized = ''
  for (let index = 0; index < source.length; index += 1) {
    const part = normalizeSearchText(source[index])
    for (let partIndex = 0; partIndex < part.length; partIndex += 1) {
      normalized += part[partIndex]
      offsets.push(index)
    }
  }
  return { text: normalized, offsets }
}

function parseMaybeJson<T = unknown>(value: unknown): T | null {
  if (!value) return null
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function getBlockText(block: OcrBlock): string {
  return String(block?.words || block?.word || block?.text || '').trim()
}

function getBlockLocation(block: OcrBlock): OcrBlock['location'] {
  return block?.location || block?.rect || block?.points || block?.block_bbox || block?.bbox || block?.box || block?.coordinate || block?.coordinate_box || null
}

function getBlockPoint(block: OcrBlock): { top: number; left: number } {
  const loc = getBlockLocation(block)
  if (Array.isArray(loc)) {
    if (loc.length > 0) {
      const xs = loc.map((point) => Number(point?.x)).filter(Number.isFinite)
      const ys = loc.map((point) => Number(point?.y)).filter(Number.isFinite)
      return {
        top: ys.length > 0 ? Math.min(...ys) : Number.MAX_SAFE_INTEGER,
        left: xs.length > 0 ? Math.min(...xs) : Number.MAX_SAFE_INTEGER,
      }
    }
    return { top: Number.MAX_SAFE_INTEGER, left: Number.MAX_SAFE_INTEGER }
  }
  if (loc && typeof loc === 'object') {
    return {
      top: Number.isFinite(Number(loc.top)) ? Number(loc.top) : Number.MAX_SAFE_INTEGER,
      left: Number.isFinite(Number(loc.left)) ? Number(loc.left) : Number.MAX_SAFE_INTEGER,
    }
  }
  return { top: Number.MAX_SAFE_INTEGER, left: Number.MAX_SAFE_INTEGER }
}

function blockHasCoordinates(block: OcrBlock): boolean {
  const point = getBlockPoint(block)
  return Number.isFinite(point.top) && Number.isFinite(point.left) && point.top < Number.MAX_SAFE_INTEGER && point.left < Number.MAX_SAFE_INTEGER
}

function compactBlockTextLength(blocks: OcrBlock[]): number {
  return blocks.reduce((sum, block) => sum + getBlockText(block).replace(/\s+/g, '').length, 0)
}

function shouldPreferRawLayoutBlocks(layoutBlocks: OcrBlock[], rawLayoutBlocks: OcrBlock[]): boolean {
  if (rawLayoutBlocks.length === 0 || rawLayoutBlocks.length <= layoutBlocks.length) return false
  const layoutTextLength = compactBlockTextLength(layoutBlocks)
  const rawTextLength = compactBlockTextLength(rawLayoutBlocks)
  if (rawTextLength < 80 || rawTextLength < layoutTextLength * 1.35 || rawTextLength - layoutTextLength < 40) return false
  return rawLayoutBlocks.filter(blockHasCoordinates).length >= layoutBlocks.filter(blockHasCoordinates).length
}

function suppressOverrepresentedLines(text: string): string {
  const lines = String(text || '').replace(/\r/g, '\n').split(/\n+/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 24) return String(text || '').trim()
  const normalizedLines = lines.map((line) => line.replace(/\s+/g, '').trim())
  const totals = new Map<string, number>()
  normalizedLines.forEach((line) => {
    if (line.length >= 4) totals.set(line, (totals.get(line) || 0) + 1)
  })
  const repeatedLines = [...totals.entries()].filter(([, count]) => count >= 4)
  if (repeatedLines.length === 0) return lines.join('\n')
  const repeatedTotal = repeatedLines.reduce((sum, [, count]) => sum + count, 0)
  if (repeatedTotal < lines.length * 0.35) return lines.join('\n')
  const seen = new Map<string, number>()
  return lines.filter((_line, index) => {
    const normalized = normalizedLines[index]
    const total = totals.get(normalized) || 0
    if (normalized.length < 4 || total < 4) return true
    const count = seen.get(normalized) || 0
    seen.set(normalized, count + 1)
    return count < 1
  }).join('\n')
}

function getOrderedOcrBlocksFromPayload(parsed: OcrResultPayload | null): OcrBlock[] {
  const ir = getOrBuildOcrPageIr(parsed)
  if (ir) return deriveOcrReadingBlocksFromIr(ir) as OcrBlock[]
  const layoutBlocks = Array.isArray(parsed?.layout_result) ? parsed.layout_result : []
  const rawLayoutBlocks = Array.isArray(parsed?.raw_layout_result) ? parsed.raw_layout_result : []
  const blocks = layoutBlocks.length > 0
    ? shouldPreferRawLayoutBlocks(layoutBlocks, rawLayoutBlocks) ? rawLayoutBlocks : layoutBlocks
    : Array.isArray(parsed?.layout_blocks) && parsed.layout_blocks.length > 0
      ? parsed.layout_blocks
      : Array.isArray(parsed?.words_result)
        ? parsed.words_result
        : []
  return [...blocks].sort((left, right) => {
    const leftOrder = Number(left?.reading_order)
    const rightOrder = Number(right?.reading_order)
    if (Number.isFinite(leftOrder) || Number.isFinite(rightOrder)) {
      return (Number.isFinite(leftOrder) ? leftOrder : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(rightOrder) ? rightOrder : Number.MAX_SAFE_INTEGER)
    }
    const leftPoint = getBlockPoint(left)
    const rightPoint = getBlockPoint(right)
    return leftPoint.top - rightPoint.top || leftPoint.left - rightPoint.left
  })
}

function pageHasLazyOcrResult(page: SearchPageRow): boolean {
  return !!page?.ocr_result || !!page?.ocr_result_ref || Number(page?.has_ocr_result || 0) > 0
}

function loadPageOcrResultForSearch(sqlite: NativeDatabase, page: SearchPageRow): SearchPageRow {
  if (page.ocr_result || !page.id || !pageHasLazyOcrResult(page)) return page
  const row = queryOne<{ ocr_result?: string | null; ocr_result_ref?: string | null }>(
    sqlite,
    'SELECT ocr_result, ocr_result_ref FROM pages WHERE id = ?',
    [page.id],
  )
  if (!row) return page
  const external = readPagePayloadValue(row.ocr_result_ref)
  return external || row.ocr_result ? { ...page, ...row, ocr_result: external || row.ocr_result } : page
}

function isManagedTextSearchPage(page: SearchPageRow): boolean {
  const docText = `${page?.doc_type || ''} ${page?.file_path || ''}`
  return /电子书|文本|\.epub|\.txt|\.md/i.test(docText)
}

function shouldConsiderOcrBlocksForSearch(page: SearchPageRow): boolean {
  if (!pageHasLazyOcrResult(page)) return false
  if (!String(getHydratedPageTextField(page, 'proofed_text') || getHydratedPageTextField(page, 'ocr_text') || '').trim()) return true
  if (isManagedTextSearchPage(page)) return true
  const docText = `${page?.doc_type || ''} ${page?.title || ''}`
  return /报纸|newspaper|古籍|地方志|hybrid|vision_model_ocr|ocr_layout/i.test(docText)
}

function shouldPreferOcrBlocksForSearch(page: SearchPageRow, blocks: OcrBlock[], parsed: OcrResultPayload | null): boolean {
  if (blocks.length < 3) return false
  const sourceType = String(parsed?.source_type || '')
  const docText = `${page?.doc_type || ''} ${page?.title || ''} ${sourceType}`
  if (/报纸|newspaper|古籍|地方志|hybrid|vision_model_ocr|ocr_layout/i.test(docText)) return true
  const ocrText = String(getHydratedPageTextField(page, 'ocr_text') || '').trim()
  const blockText = blocks.map(getBlockText).filter(Boolean).join('')
  return blockText.length >= 80 && ocrText.length > blockText.length * 0.7
}

function getHydratedPageTextField(page: SearchPageRow, field: 'proofed_text' | 'ocr_text'): string {
  const inline = String(page?.[field] || '')
  if (inline.trim()) return inline
  const ref = String(page?.[`${field}_ref`] || '')
  if (!ref) return ''
  return readPagePayloadValue(ref) || ''
}

function getIndexablePageText(sqlite: NativeDatabase, page: SearchPageRow): string {
  const pageWithManualLayout = pageHasLazyOcrResult(page) ? loadPageOcrResultForSearch(sqlite, page) : page
  const manualPayload = parseMaybeJson<OcrResultPayload>(pageWithManualLayout.ocr_result)
  const manualLayoutBlocks = Array.isArray(manualPayload?.layout_result) ? manualPayload.layout_result : []
  if (getManualLayoutSearchSegments(manualLayoutBlocks).length > 0) {
    return projectLayoutBlocksToPageText(manualLayoutBlocks)
  }
  const proofed = String(getHydratedPageTextField(page, 'proofed_text') || '').trim()
  if (proofed) return proofed

  const ocrText = String(getHydratedPageTextField(page, 'ocr_text') || '').trim()
  const shouldLoadBlocks = shouldConsiderOcrBlocksForSearch(page) && (!!page.ocr_result || !ocrText)
  const pageWithOcrResult = shouldLoadBlocks ? loadPageOcrResultForSearch(sqlite, page) : page
  const parsed = shouldLoadBlocks ? parseMaybeJson<OcrResultPayload>(pageWithOcrResult?.ocr_result) : null
  const ir = getOrBuildOcrPageIr(parsed, { pageIndex: Number(page.page_num || 0) || 1 })
  const blocks = parsed ? getOrderedOcrBlocksFromPayload(parsed) : []
  if (blocks.length > 0 && shouldPreferOcrBlocksForSearch(page, blocks, parsed)) {
    const blockText = suppressOverrepresentedLines(blocks.map((block) => getBlockText(block)).filter(Boolean).join('\n\n'))
    if (blockText.trim()) return blockText.trim()
  }

  const irText = ir ? deriveOcrTextFromIr(ir) : ''
  if (irText) return suppressOverrepresentedLines(irText)
  if (ocrText) return suppressOverrepresentedLines(ocrText)
  return suppressOverrepresentedLines(blocks.map((block) => getBlockText(block)).filter(Boolean).join('\n\n')).trim()
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function getSearchNgrams(text: string, maxGramSize = 3, maxStoredPositions = Number.POSITIVE_INFINITY): Array<{ gram: string; positions: number[]; hitCount: number }> {
  if (!SEARCH_NGRAM_INDEX_ENABLED) return []
  const normalized = normalizeSearchText(text)
  const byGram = new Map<string, { positions: number[]; hitCount: number }>()
  for (let index = 0; index < normalized.length; index += 1) {
    for (let size = 2; size <= maxGramSize; size += 1) {
      if (index + size > normalized.length) break
      const gram = normalized.slice(index, index + size)
      if (!gram.trim() || /\s/.test(gram)) continue
      const item = byGram.get(gram) || { positions: [], hitCount: 0 }
      item.hitCount += 1
      if (maxStoredPositions > 0 && item.positions.length < maxStoredPositions) item.positions.push(index)
      byGram.set(gram, item)
    }
  }
  return [...byGram.entries()].map(([gram, item]) => ({ gram, positions: item.positions, hitCount: item.hitCount }))
}

function versionedSourceHash(segmentHashes: string[]): string {
  return `${SEARCH_INDEX_VERSION}:${hashText(segmentHashes.join('|'))}`
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

async function yieldAfterSearchIndexSlice(startedAt: number): Promise<number> {
  if (Date.now() - startedAt < BACKGROUND_REINDEX_TIME_SLICE_MS) return startedAt
  await yieldToEventLoop()
  return Date.now()
}

function emitProgress(payload: SearchIndexWorkerProgress): void {
  parentPort?.postMessage({ type: 'progress', payload })
}

function updateSearchIndexStatus(
  sqlite: NativeDatabase,
  docId: string,
  status: string,
  options: { sourceHash?: string; segmentCount?: number; errorMessage?: string | null; indexedAt?: string | null } = {},
): void {
  const now = new Date().toISOString()
  runOn(
    sqlite,
    `INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET
       status = excluded.status,
       source_hash = CASE
         WHEN excluded.status = 'ready' OR excluded.source_hash <> '' THEN excluded.source_hash
         ELSE search_index_status.source_hash
       END,
       segment_count = CASE
         WHEN excluded.status = 'ready' OR excluded.segment_count > 0 THEN excluded.segment_count
         ELSE search_index_status.segment_count
       END,
       error_message = excluded.error_message,
       indexed_at = CASE
         WHEN excluded.status = 'ready' OR excluded.indexed_at IS NOT NULL THEN excluded.indexed_at
         ELSE search_index_status.indexed_at
       END,
       updated_at = excluded.updated_at`,
    [
      docId,
      status,
      options.sourceHash || '',
      Number(options.segmentCount || 0),
      options.errorMessage ?? null,
      options.indexedAt ?? null,
      now,
    ],
  )
}

function getIndexablePagesWhereClause(): string {
  return `p.doc_id = ?
    AND ${activeDocumentCondition('d')}
    AND (
      TRIM(COALESCE(NULLIF(p.proofed_text, ''), NULLIF(p.ocr_text, ''), '')) <> ''
      OR COALESCE(p.proofed_text_ref, p.ocr_text_ref, '') <> ''
      OR (${INDEXABLE_PAGE_OCR_RESULT_CONDITION} AND p.ocr_result IS NOT NULL AND p.ocr_result <> '')
      OR (${INDEXABLE_PAGE_OCR_RESULT_CONDITION} AND COALESCE(p.ocr_result_ref, '') <> '')
    )`
}

function countIndexablePagesForDocument(sqlite: NativeDatabase, docId: string): number {
  const row = queryOne<{ count?: number | null }>(
    sqlite,
    `SELECT COUNT(*) as count
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE ${getIndexablePagesWhereClause()}`,
    [docId],
  )
  return Number(row?.count || 0)
}

function loadIndexablePagesForDocument(sqlite: NativeDatabase, docId: string, limit?: number, offset = 0): SearchPageRow[] {
  const params: Array<string | number> = [docId]
  let sql = `${INDEXABLE_PAGE_BASE_SELECT}
     WHERE ${getIndexablePagesWhereClause()}
     ORDER BY p.page_num ASC`
  if (typeof limit === 'number') {
    sql += ' LIMIT ? OFFSET ?'
    params.push(Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(offset)))
  }
  return queryAll<SearchPageRow>(sqlite, sql, params)
}

async function deleteRowsByJobIdInBackground(sqlite: NativeDatabase, tableName: SearchIndexStagingTable, jobId: string, sliceStartedAt: number): Promise<number> {
  let nextSliceStartedAt = sliceStartedAt
  while (true) {
    const rows = queryAll<{ rowid: number }>(
      sqlite,
      `SELECT rowid FROM ${tableName} WHERE job_id = ? LIMIT ?`,
      [jobId, BACKGROUND_REINDEX_DELETE_BATCH_SIZE],
    )
    if (rows.length === 0) break
    const rowIds = rows.map((row) => Number(row.rowid)).filter(Number.isFinite)
    if (rowIds.length === 0) break
    runOn(sqlite, `DELETE FROM ${tableName} WHERE rowid IN (${rowIds.map(() => '?').join(', ')})`, rowIds)
    nextSliceStartedAt = await yieldAfterSearchIndexSlice(nextSliceStartedAt)
  }
  return nextSliceStartedAt
}

async function cleanupSearchIndexStagingRows(sqlite: NativeDatabase, jobId: string, sliceStartedAt = Date.now()): Promise<number> {
  let nextSliceStartedAt = await deleteRowsByJobIdInBackground(sqlite, 'search_ngram_index_staging', jobId, sliceStartedAt)
  nextSliceStartedAt = await deleteRowsByJobIdInBackground(sqlite, 'search_index_segments_staging', jobId, nextSliceStartedAt)
  return nextSliceStartedAt
}

function splitSearchIndexText(text: string): SearchIndexTextPart[] {
  const source = String(text || '').trim()
  if (!source) return []
  if (source.length <= SEARCH_INDEX_SEGMENT_MAX_CHARS) {
    return [{ text: source, originalStart: 0, partIndex: 0 }]
  }

  const parts: SearchIndexTextPart[] = []
  let cursor = 0
  let partIndex = 0
  while (cursor < source.length) {
    let end = Math.min(source.length, cursor + SEARCH_INDEX_SEGMENT_MAX_CHARS)
    if (end < source.length) {
      const minBoundary = cursor + Math.floor(SEARCH_INDEX_SEGMENT_MAX_CHARS * 0.65)
      const boundaryCandidates = [
        source.lastIndexOf('\n\n', end),
        source.lastIndexOf('\n', end),
        source.lastIndexOf('。', end),
        source.lastIndexOf('.', end),
        source.lastIndexOf(' ', end),
      ].filter((value) => value > minBoundary)
      if (boundaryCandidates.length > 0) {
        end = Math.max(...boundaryCandidates) + 1
      }
    }

    const raw = source.slice(cursor, end)
    const trimmedStart = raw.length - raw.trimStart().length
    const partText = raw.trim()
    if (partText) {
      parts.push({
        text: partText,
        originalStart: cursor + trimmedStart,
        partIndex,
      })
      partIndex += 1
    }
    if (end >= source.length) break
    cursor = Math.max(cursor + 1, end - SEARCH_INDEX_SEGMENT_OVERLAP_CHARS)
  }
  return parts
}

function parseSegmentMeta(sqlite: NativeDatabase, page: SearchPageRow): { sourceKind: string; href: string | null; title: string | null } {
  if (!isManagedTextSearchPage(page)) return { sourceKind: 'page', href: null, title: null }
  try {
    const pageWithOcrResult = loadPageOcrResultForSearch(sqlite, page)
    const parsed = parseMaybeJson<OcrResultPayload>(pageWithOcrResult.ocr_result) || {}
    const ebook = parsed?.ebook || {}
    return {
      sourceKind: parsed?.source_type || (ebook.href ? 'ebook_section' : 'page'),
      href: ebook.href || null,
      title: ebook.title || null,
    }
  } catch {
    return { sourceKind: 'page', href: null, title: null }
  }
}

function buildSearchIndexSegmentDrafts(sqlite: NativeDatabase, docId: string, page: SearchPageRow, index: number): SearchIndexSegmentDraft[] {
  const pageWithOcrResult = pageHasLazyOcrResult(page) ? loadPageOcrResultForSearch(sqlite, page) : page
  const parsed = parseMaybeJson<OcrResultPayload>(pageWithOcrResult.ocr_result)
  const layoutBlocks = Array.isArray(parsed?.layout_result) ? parsed.layout_result : []
  const manualSegments = getManualLayoutSearchSegments(layoutBlocks)
  if (manualSegments.length > 0) {
    const meta = parseSegmentMeta(sqlite, pageWithOcrResult)
    const pageId = String(page.id || '')
    const pageNum = Number(page.page_num || index + 1)
    return getLayoutBlockSearchSegments(layoutBlocks).flatMap((segment, segmentIndex) => (
      splitSearchIndexText(segment.text).map((part) => {
        const normalized = normalizeSearchTextWithOffsetMap(part.text)
        const segmentKey = segment.blockId ? encodeURIComponent(segment.blockId) : `ocr-${segmentIndex}`
        const locationKey = segment.blockId
          ? createManualLayoutLocationKey(segment.blockId, segment.location)
          : null
        return {
          segmentId: `${docId}:${page.id || index}:manual-layout:${segmentKey}:${part.partIndex}`,
          pageId,
          pageNum,
          sourceKind: segment.source === 'manual' ? 'manual-layout' : meta.sourceKind,
          href: locationKey,
          title: meta.title || `第 ${page.page_num || index + 1} 页`,
          ordinal: index * 1000 + segmentIndex + part.partIndex / 1000,
          sourceStart: part.originalStart,
          text: part.text,
          normalizedText: normalized.text,
          offsetMap: normalized.offsets,
          textHash: hashText(`${docId}:${page.id}:${segment.blockId || segmentIndex}:${part.originalStart}:${normalized.text}:${locationKey || ''}`),
        }
      })
    ))
  }
  const text = getIndexablePageText(sqlite, page).trim()
  if (!text) return []
  const meta = parseSegmentMeta(sqlite, page)
  const pageId = String(page.id || '')
  const pageNum = Number(page.page_num || index + 1)
  return splitSearchIndexText(text).map((part) => {
    const normalized = normalizeSearchTextWithOffsetMap(part.text)
    return {
      segmentId: `${docId}:${page.id || index}:${part.partIndex}`,
      pageId,
      pageNum,
      sourceKind: meta.sourceKind,
      href: meta.href,
      title: meta.title || `第 ${page.page_num || index + 1} 页`,
      ordinal: index * 1000 + part.partIndex,
      sourceStart: part.originalStart,
      text: part.text,
      normalizedText: normalized.text,
      offsetMap: normalized.offsets,
      textHash: hashText(`${docId}:${page.id}:${part.originalStart}:${normalized.text}`),
    }
  })
}

function buildTranslationSearchIndexSegmentDrafts(sqlite: NativeDatabase, docId: string): SearchIndexSegmentDraft[] {
  const rows = queryAll<{
    page_id: string
    page_num: number
    unit_id: string
    block_id: string
    unit_order: number
    translation_text: string
  }>(
    sqlite,
    `SELECT page_id, page_num, unit_id, block_id, unit_order, translation_text
     FROM page_translation_units
     WHERE doc_id = ?
       AND status = 'ready'
       AND stale = 0
       AND skipped = 0
       AND TRIM(COALESCE(translation_text, '')) <> ''
     ORDER BY page_num, unit_order`,
    [docId],
  )
  return rows.map((row) => {
    const text = String(row.translation_text || '').trim()
    const normalized = normalizeSearchTextWithOffsetMap(text)
    return {
      segmentId: `translation:${row.unit_id}:${row.block_id}`,
      pageId: row.page_id,
      pageNum: Number(row.page_num || 0),
      sourceKind: 'translation',
      href: null,
      title: `第 ${row.page_num || '?'} 页 · 译文`,
      ordinal: Math.max(0, Number(row.page_num || 1) - 1) * 1000 + 500 + Number(row.unit_order || 0),
      sourceStart: 0,
      text,
      normalizedText: normalized.text,
      offsetMap: normalized.offsets,
      textHash: hashText(`${docId}:${row.unit_id}:${normalized.text}`),
    }
  })
}

function insertSearchIndexSegmentDraftIntoStaging(sqlite: NativeDatabase, jobId: string, docId: string, segment: SearchIndexSegmentDraft, now: string): void {
  runOn(
    sqlite,
    `INSERT INTO search_index_segments_staging (
      job_id, segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start, text, normalized_text, offset_map, text_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      segment.segmentId,
      docId,
      segment.pageId,
      segment.pageNum,
      segment.sourceKind,
      segment.href,
      segment.title,
      segment.ordinal,
      segment.sourceStart,
      segment.text,
      segment.normalizedText,
      JSON.stringify(segment.offsetMap),
      segment.textHash,
      now,
    ],
  )
}

function upsertSearchNgramStagingRows(
  sqlite: NativeDatabase,
  jobId: string,
  docId: string,
  segmentId: string,
  grams: Array<{ gram: string; positions: number[]; hitCount: number }>,
): void {
  grams.forEach(({ gram, positions, hitCount }) => {
    runOn(
      sqlite,
      `INSERT INTO search_ngram_index_staging (job_id, gram, segment_id, doc_id, positions, hit_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, gram, segment_id) DO UPDATE SET
         positions = excluded.positions,
         hit_count = excluded.hit_count,
         doc_id = excluded.doc_id`,
      [jobId, gram, segmentId, docId, JSON.stringify(positions), hitCount],
    )
  })
}

async function insertSearchNgramsForStagedSegmentInBackground(sqlite: NativeDatabase, jobId: string, docId: string, segment: SearchIndexSegmentDraft, sliceStartedAt: number): Promise<number> {
  const grams = getSearchNgrams(segment.normalizedText, 3, SEARCH_NGRAM_MAX_POSITIONS_STORED)
  let nextSliceStartedAt = sliceStartedAt
  for (let index = 0; index < grams.length; index += BACKGROUND_REINDEX_NGRAM_WRITE_BATCH_SIZE) {
    const chunk = grams.slice(index, index + BACKGROUND_REINDEX_NGRAM_WRITE_BATCH_SIZE)
    transaction(sqlite, () => {
      upsertSearchNgramStagingRows(sqlite, jobId, docId, segment.segmentId, chunk)
    })
    nextSliceStartedAt = await yieldAfterSearchIndexSlice(nextSliceStartedAt)
  }
  return nextSliceStartedAt
}

function commitStagedSearchIndexForDocument(
  sqlite: NativeDatabase,
  jobId: string,
  docId: string,
  sourceHash: string,
  segmentCount: number,
  now: string,
  ftsAvailable: boolean,
  trigramFtsAvailable: boolean,
  skipFtsDelete = false,
): void {
  transaction(sqlite, () => {
    if (ftsAvailable && !skipFtsDelete) {
      runOn(
        sqlite,
        `INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
         SELECT 'delete', rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId],
      )
    }
    if (trigramFtsAvailable && !skipFtsDelete) {
      runOn(
        sqlite,
        `INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)
         SELECT 'delete', rowid, COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId],
      )
    }
    runOn(sqlite, 'DELETE FROM search_ngram_index WHERE doc_id = ?', [docId])
    runOn(sqlite, 'DELETE FROM search_index_segments WHERE doc_id = ?', [docId])
    runOn(
      sqlite,
      `INSERT INTO search_index_segments (
        segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start, text, normalized_text, offset_map, text_hash, updated_at
      )
       SELECT segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start,
              CASE
                WHEN length(COALESCE(text, '')) > ${SEARCH_INDEX_SEGMENT_STORED_TEXT_MAX_CHARS}
                THEN substr(text, 1, ${SEARCH_INDEX_SEGMENT_STORED_TEXT_MAX_CHARS})
                ELSE text
              END,
              normalized_text,
              '',
              text_hash,
              updated_at
       FROM search_index_segments_staging
       WHERE job_id = ?
       ORDER BY ordinal ASC`,
      [jobId],
    )
    runOn(
      sqlite,
      `INSERT INTO search_ngram_index (gram, segment_id, doc_id, positions, hit_count)
       SELECT gram, segment_id, doc_id, positions, hit_count
       FROM search_ngram_index_staging
       WHERE job_id = ?`,
      [jobId],
    )
    if (ftsAvailable) {
      runOn(
        sqlite,
        `INSERT INTO search_segments_fts (rowid, title, normalized_text)
         SELECT rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId],
      )
    }
    if (trigramFtsAvailable) {
      runOn(
        sqlite,
        `INSERT INTO search_segments_trigram (rowid, normalized_text)
         SELECT rowid, COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId],
      )
    }
    runOn(
      sqlite,
      `INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET
         status = excluded.status,
         source_hash = excluded.source_hash,
         segment_count = excluded.segment_count,
         error_message = excluded.error_message,
         indexed_at = excluded.indexed_at,
         updated_at = excluded.updated_at`,
      [docId, 'ready', sourceHash, segmentCount, null, now, now],
    )
  })

  try {
    transaction(sqlite, () => {
      runOn(sqlite, 'DELETE FROM search_ngram_index_staging WHERE job_id = ?', [jobId])
      runOn(sqlite, 'DELETE FROM search_index_segments_staging WHERE job_id = ?', [jobId])
    })
  } catch (error) {
    console.warn('[SearchIndexWorker] Failed to clean staging rows after index commit', error)
  }
}

async function reindexDocument(task: SearchIndexWorkerTask): Promise<SearchReindexDocumentResult> {
  if (task.dataDir) {
    setPayloadDataDir(task.dataDir)
  }
  const { sqlite, ftsAvailable, trigramFtsAvailable, recreatedSearchSegmentsFts } = openWorkerDatabase(task.dbFilePath)
  const { docId, totalCount, completedCount } = task
  let stagingJobId = ''
  try {
    const doc = queryOne<SearchDocumentRow>(sqlite, 'SELECT id, import_status FROM documents WHERE id = ?', [docId])
    if (!doc) return { docId, status: 'missing', segmentCount: 0, error: '文献不存在' }
    if (isDeletingImportStatus(doc.import_status)) {
      return { docId, status: 'skipped', segmentCount: 0, error: '文献正在后台删除' }
    }

    const now = new Date().toISOString()
    stagingJobId = createSearchIndexStagingJobId(docId)
    updateSearchIndexStatus(sqlite, docId, 'processing')
    emitProgress({
      status: 'processing',
      docId,
      totalCount,
      completedCount,
      progress: completedCount / Math.max(totalCount, 1),
      message: '正在后台更新搜索索引，不影响阅读和浏览',
    })

    const totalPages = countIndexablePagesForDocument(sqlite, docId)
    const segmentHashes: string[] = []
    let segmentCount = 0
    let processedPages = 0
    let sliceStartedAt = await cleanupSearchIndexStagingRows(sqlite, stagingJobId, Date.now())
    for (let offset = 0; ; offset += BACKGROUND_REINDEX_PAGE_BATCH_SIZE) {
      const pages = loadIndexablePagesForDocument(sqlite, docId, BACKGROUND_REINDEX_PAGE_BATCH_SIZE, offset)
      if (pages.length === 0) break
      const segments = pages.flatMap((page, pageIndex) => buildSearchIndexSegmentDrafts(sqlite, docId, page, offset + pageIndex))
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE) {
        const segmentChunk = segments.slice(segmentIndex, segmentIndex + BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE)
        transaction(sqlite, () => {
          segmentChunk.forEach((segment) => insertSearchIndexSegmentDraftIntoStaging(sqlite, stagingJobId, docId, segment, now))
        })
        segmentChunk.forEach((segment) => segmentHashes.push(segment.textHash))
        segmentCount += segmentChunk.length
        for (const segment of segmentChunk) {
          sliceStartedAt = await insertSearchNgramsForStagedSegmentInBackground(sqlite, stagingJobId, docId, segment, sliceStartedAt)
        }
        sliceStartedAt = await yieldAfterSearchIndexSlice(sliceStartedAt)
      }
      processedPages += pages.length
      emitProgress({
        status: 'processing',
        docId,
        totalCount,
        completedCount,
        progress: (completedCount + Math.min(0.95, processedPages / Math.max(totalPages, 1))) / Math.max(totalCount, 1),
        message: '正在后台更新搜索索引，不影响阅读和浏览',
      })
      sliceStartedAt = await yieldAfterSearchIndexSlice(sliceStartedAt)
    }

    const translationSegments = buildTranslationSearchIndexSegmentDrafts(sqlite, docId)
    for (let segmentIndex = 0; segmentIndex < translationSegments.length; segmentIndex += BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE) {
      const segmentChunk = translationSegments.slice(segmentIndex, segmentIndex + BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE)
      transaction(sqlite, () => {
        segmentChunk.forEach((segment) => insertSearchIndexSegmentDraftIntoStaging(sqlite, stagingJobId, docId, segment, now))
      })
      segmentChunk.forEach((segment) => segmentHashes.push(segment.textHash))
      segmentCount += segmentChunk.length
      for (const segment of segmentChunk) {
        sliceStartedAt = await insertSearchNgramsForStagedSegmentInBackground(sqlite, stagingJobId, docId, segment, sliceStartedAt)
      }
    }

    const readyAt = new Date().toISOString()
    const sourceHash = versionedSourceHash(segmentHashes)
    commitStagedSearchIndexForDocument(sqlite, stagingJobId, docId, sourceHash, segmentCount, readyAt, ftsAvailable, trigramFtsAvailable, recreatedSearchSegmentsFts)
    return { docId, status: 'ready', segmentCount }
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error)
    if (stagingJobId) {
      try {
        await cleanupSearchIndexStagingRows(sqlite, stagingJobId)
      } catch (cleanupError) {
        console.warn('[SearchWorker] Failed to clean staged search index rows', cleanupError)
      }
    }
    updateSearchIndexStatus(sqlite, docId, 'error', { errorMessage })
    return { docId, status: 'error', segmentCount: 0, error: errorMessage }
  } finally {
    sqlite.close()
  }
}

parentPort?.on('message', (message: { type?: string; task?: SearchIndexWorkerTask }) => {
  if (message?.type !== 'indexDocument' || !message.task) return
  void reindexDocument(message.task)
    .then((result) => {
      parentPort?.postMessage({ type: 'result', result })
    })
    .catch((error: unknown) => {
      parentPort?.postMessage({ type: 'error', error: getErrorMessage(error) })
    })
})
