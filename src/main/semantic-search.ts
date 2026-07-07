import { Index as FlexSearchIndex } from 'flexsearch'
import { nanoid } from 'nanoid'
import { buildAiContextForDocuments, runAiTask } from './ai'
import { createHash } from 'crypto'
import { deriveOcrReadingBlocksFromIr, deriveOcrTextFromIr, getOrBuildOcrPageIr } from '../shared/ocr-ir'
import { buildSearchIndexHealthDiagnostics } from '../shared/search-index-health'
import { statusEnvelopeFromSearchIndexStatus } from '../shared/status-envelope'
import { getDataDir, getDatabaseFilePath, isFtsAvailable, isSearchSegmentsFtsRebuildNeeded, isSearchTrigramFtsAvailable, queryAll, queryOne, refreshSearchSegmentsFtsForDocument, run, saveDatabase, scheduleDatabaseSave, transaction } from './database'
import { normalizeChineseSearchText, normalizeWhitespace } from './text-normalization'
import { getErrorMessage } from '../shared/errors'
import { emitBackgroundTaskStatus } from './background-tasks'
import {
  BACKGROUND_REINDEX_DELETE_BATCH_SIZE,
  BACKGROUND_REINDEX_DRAIN_BATCH_SIZE,
  BACKGROUND_REINDEX_DRAIN_PAUSE_MS,
  BACKGROUND_REINDEX_NGRAM_WRITE_BATCH_SIZE,
  BACKGROUND_REINDEX_PAGE_BATCH_SIZE,
  BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE,
  BACKGROUND_REINDEX_TASK_ID,
  BACKGROUND_REINDEX_TIME_SLICE_MS,
  SEARCH_INDEX_SEGMENT_MAX_CHARS,
  SEARCH_INDEX_SEGMENT_OVERLAP_CHARS,
  SEARCH_INDEX_SEGMENT_STORED_TEXT_MAX_CHARS,
  SEARCH_NGRAM_INDEX_ENABLED,
  SEARCH_INDEX_VERSION,
  SEARCH_NGRAM_MAX_POSITIONS_STORED,
  SEARCH_TRIGRAM_FTS_ENABLED,
  SEARCH_TRIGRAM_MIN_QUERY_LENGTH,
} from './search-index-constants'
import { isSearchIndexWorkerAvailable, runSearchIndexWorkerTask } from './search-index-worker-client'
import { hydratePagePayloadRow, readPagePayload } from './page-payload-store'
import { resolveFolderAndDescendantIds } from './folder-scope'
import type {
  AiPlannedSearchResponse,
  AiSearchPlan,
  LibraryAiScope,
  LibraryAiScopePreview,
  LibraryAiSearchResponse,
  MetadataStatus,
  ReadStatus,
  SavedSearch,
  SavedSearchPayload,
  SavedSearchRunResult,
  ScopedLibraryAiResponse,
  SearchDocumentGroup,
  SearchDocumentHitPage,
  SearchGroupedResponse,
  SearchHit,
  SearchHitLocator,
  SearchIndexStatus,
  SearchOptions,
  SearchReindexAllResult,
  SearchReindexDocumentResult,
  SearchResult,
  SearchSessionState,
} from '../shared/types'

interface SearchRow {
  page_id: string
  doc_id: string
  page_num: number
  snippet: string
  rank: number
  occurrence_index?: number
}

interface SearchSegmentRow {
  segment_id: string
  doc_id: string
  page_id: string | null
  page_num: number | null
  source_kind: string
  href: string | null
  title: string | null
  ordinal: number
  source_start?: number | null
  text: string
  normalized_text: string
  offset_map?: string | null
}

interface SearchHitRow extends SearchSegmentRow {
  rank: number
  positions?: string
  hit_count?: number
  doc_total_hits?: number
}

interface SearchNgramCandidateRow extends SearchSegmentRow {
  positions: string
  hit_count: number
  rank: number
  doc_total_hits?: number
}

type CurrentSearchIndexStatus = Pick<SearchIndexStatus, 'status' | 'source_hash' | 'segment_count' | 'error_message' | 'updated_at'>
type SearchIndexReindexReason =
  | 'manual'
  | 'content-changed'
  | 'ocr-batch-deferred'
  | 'search-scope-stale'
  | 'search-managed-text-stale'
  | 'search-hit-locator'
  | 'global-stale-suppressed'

type JsonRecord = Record<string, unknown>

interface SearchIndexSegmentStats {
  segmentCount: number
  pageCount: number
  ftsCount: number
  trigramFtsCount: number
  minHash: string
  maxHash: string
  indexedAt: string | null
}

interface SearchIndexContentSignature {
  segmentCount: number
  pageCount: number
  minHash: string
  maxHash: string
  hashSignature: string
}

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
  needs_enhancement?: boolean
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
  title: string
  author: string | null
  doc_author?: string | null
  dynasty?: string | null
  doc_type: string
  file_path?: string | null
  import_status?: string | null
  ocr_status?: string | null
  read_status?: string | null
  metadata_status?: string | null
  metadata?: string | null
  is_favorite?: number | null
  updated_at?: string | null
  last_opened_at?: string | null
  tag_names?: string | null
  tag_ids?: string | null
  folder_names?: string | null
  folder_ids?: string | null
}

interface SearchLibraryStatsRow {
  count?: number | null
  updatedAt?: string | null
}

interface FallbackRecord {
  id: string
  docId: string
  pageNum: number
  content: string
}

const fallbackIndex = new FlexSearchIndex({
  preset: 'score',
  tokenize: 'forward',
  cache: 100
})

let fallbackDirty = true
const fallbackRecords = new Map<string, FallbackRecord>()
const SEARCH_CACHE_TTL_MS = 30_000
const SEARCH_FILTER_CACHE_TTL_MS = 30_000
const POSTING_CACHE_TTL_MS = 30_000
const SEARCH_METRICS_ENABLED = process.env.GUJISMART_SEARCH_METRICS === '1'
const AUTO_BACKGROUND_REINDEX_ENABLED = process.env.GUJISMART_AUTO_REINDEX !== '0'
const BACKGROUND_REINDEX_DELAY_MS = 1500
const SEARCH_FALLBACK_MAX_DOCS = 8
const SEARCH_SCOPED_FALLBACK_MAX_DOCS = 24
const SEARCH_STALE_GLOBAL_SCAN_LIMIT = 40
const SEARCH_LEGACY_SEGMENT_SCAN_DOC_LIMIT = 160
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
const searchResponseCache = new Map<string, { createdAt: number; response: SearchGroupedResponse }>()
const searchFilterDocIdsCache = new Map<string, { createdAt: number; docIds: string[] | undefined }>()
const folderScopeIdsCache = new Map<string, { createdAt: number; folderIds: string[] }>()
const postingRowsCache = new Map<string, { createdAt: number; rows: SearchHitRow[] }>()
const trigramCoverageCache = new Map<string, { createdAt: number; missingDocIds: string[] }>()

type TimedSearchCacheEntry = { createdAt: number }

function getFreshSearchCacheEntry<T extends TimedSearchCacheEntry>(cache: Map<string, T>, cacheKey: string, ttlMs: number): T | null {
  const cached = cache.get(cacheKey)
  if (!cached) return null
  if (Date.now() - cached.createdAt < ttlMs) return cached
  cache.delete(cacheKey)
  return null
}

function setBoundedSearchCacheEntry<T extends TimedSearchCacheEntry>(cache: Map<string, T>, cacheKey: string, value: T, maxSize: number, ttlMs: number): void {
  const now = Date.now()
  for (const [key, entry] of cache.entries()) {
    if (now - entry.createdAt >= ttlMs) cache.delete(key)
  }
  cache.set(cacheKey, value)
  if (cache.size <= maxSize) return
  const overflowCount = cache.size - maxSize
  ;[...cache.entries()]
    .sort((left, right) => left[1].createdAt - right[1].createdAt)
    .slice(0, overflowCount)
    .forEach(([key]) => cache.delete(key))
}

const queuedReindexDocIds = new Set<string>()
let reindexTimer: NodeJS.Timeout | null = null
let reindexWorkerRunning = false
let reindexDrainCompletedCount = 0
let reindexDrainErrorCount = 0
let reindexDrainLastErrorMessage = ''
let reindexDrainTotalCount = 0
let backgroundReindexPauseDepth = 0
const MAX_PREVIEW_HITS_PER_DOC = 24
const MAX_DOCUMENT_SEARCH_SESSION_HITS = 20000
const SHORT_QUERY_PREVIEW_SEGMENTS_PER_DOC = 6
const MAX_AI_EXPANDED_KEYWORDS = 36
const MAX_AI_SEARCH_QUERIES = 32
const MULTILINGUAL_SEARCH_LANGUAGES = 'English, Japanese, Russian, German, French, Spanish, and Korean'
const DELETING_IMPORT_STATUS = 'deleting'

function normalizeReadStatus(value: unknown): ReadStatus | undefined {
  return value === 'unread' || value === 'reading' || value === 'read' ? value : undefined
}

function normalizeMetadataStatus(value: unknown): MetadataStatus | undefined {
  return value === 'pending' || value === 'review' || value === 'confirmed' || value === 'auto' ? value : undefined
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function buildInClause(values: string[]): string {
  return values.map(() => '?').join(', ')
}

function resolveSearchFolderScopeIds(folderIds: string[]): string[] {
  const uniqueFolderIds = uniqueIds(folderIds)
  if (uniqueFolderIds.length === 0) return []
  const cacheKey = stableStringify(uniqueFolderIds)
  const cached = getFreshSearchCacheEntry(folderScopeIdsCache, cacheKey, SEARCH_FILTER_CACHE_TTL_MS)
  if (cached) return [...cached.folderIds]
  const resolved = resolveFolderAndDescendantIds(uniqueFolderIds)
  setBoundedSearchCacheEntry(folderScopeIdsCache, cacheKey, { createdAt: Date.now(), folderIds: resolved }, 40, SEARCH_FILTER_CACHE_TTL_MS)
  return resolved
}

function chunkValues<T>(values: T[], size = 800): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function activeDocumentCondition(alias = 'd'): string {
  return `COALESCE(${alias}.import_status, '') <> '${DELETING_IMPORT_STATUS}'`
}

function isDeletingImportStatus(value: unknown): boolean {
  return String(value || '') === DELETING_IMPORT_STATUS
}

function resolveActiveDocumentIds(docIds?: string[]): string[] {
  const uniqueDocIds = uniqueIds(docIds || [])
  if (uniqueDocIds.length === 0) {
    return queryAll<{ id: string }>(
      `SELECT id FROM documents WHERE ${activeDocumentCondition('documents')}`,
    ).map((item) => item.id)
  }

  const activeIds = new Set<string>()
  for (const chunk of chunkValues(uniqueDocIds)) {
    const placeholders = buildInClause(chunk)
    queryAll<{ id: string }>(
      `SELECT id FROM documents WHERE id IN (${placeholders}) AND ${activeDocumentCondition('documents')}`,
      chunk,
    ).forEach((item) => activeIds.add(item.id))
  }

  return uniqueDocIds.filter((docId) => activeIds.has(docId))
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sanitizeFtsQuery(keyword: string): string {
  return normalizeSearchText(keyword)
    .trim()
    .split(/\s+/)
    .map((term) => `"${term.replace(/"/g, '')}"`)
    .join(' ')
}

function normalizeScope(scope?: LibraryAiScope): LibraryAiScope {
  if (!scope || scope.type === 'all') return { type: 'all' }
  if (scope.type === 'tags') return { type: 'tags', tagIds: uniqueIds(scope.tagIds || []) }
  if (scope.type === 'folders') return { type: 'folders', folderIds: uniqueIds(scope.folderIds || []) }
  return { type: 'documents', docIds: uniqueIds(scope.docIds || []) }
}

function resolveScopeDocumentIds(scope?: LibraryAiScope): string[] {
  const normalized = normalizeScope(scope)

  if (normalized.type === 'all') {
    return queryAll<{ id: string }>(
      `SELECT id FROM documents WHERE ${activeDocumentCondition('documents')} ORDER BY is_favorite DESC, updated_at DESC`,
    ).map((item) => item.id)
  }

  if (normalized.type === 'documents') {
    if (normalized.docIds.length === 0) return []
    const placeholders = buildInClause(normalized.docIds)
    return queryAll<{ id: string }>(
      `SELECT id
       FROM documents
       WHERE id IN (${placeholders})
         AND ${activeDocumentCondition('documents')}
       ORDER BY is_favorite DESC, updated_at DESC`,
      normalized.docIds
    ).map((item) => item.id)
  }

  if (normalized.type === 'folders') {
    const folderIds = resolveSearchFolderScopeIds(normalized.folderIds)
    if (folderIds.length === 0) return []
    const placeholders = buildInClause(folderIds)
    return queryAll<{ id: string }>(
      `SELECT DISTINCT d.id
       FROM documents d
       INNER JOIN document_folders df ON d.id = df.doc_id
       WHERE df.folder_id IN (${placeholders})
         AND ${activeDocumentCondition('d')}
       ORDER BY d.is_favorite DESC, d.updated_at DESC`,
      folderIds
    ).map((item) => item.id)
  }

  if (normalized.tagIds.length === 0) return []

  let sql = 'SELECT d.id FROM documents d'
  const params: string[] = []
  normalized.tagIds.forEach((tagId, index) => {
    const alias = `dt_scope_${index}`
    sql += ` INNER JOIN document_tags ${alias} ON d.id = ${alias}.doc_id AND ${alias}.tag_id = ?`
    params.push(tagId)
  })
  sql += ` WHERE ${activeDocumentCondition('d')} GROUP BY d.id ORDER BY d.is_favorite DESC, d.updated_at DESC`

  return queryAll<{ id: string }>(sql, params).map((item) => item.id)
}

function buildScopePreview(docIds: string[]): LibraryAiScopePreview {
  if (docIds.length === 0) {
    return { count: 0, ocrReadyCount: 0, documents: [] }
  }

  const placeholders = buildInClause(docIds)
  const documents = queryAll<{ id: string; title: string }>(
    `SELECT id, title
     FROM documents
     WHERE id IN (${placeholders})
       AND ${activeDocumentCondition('documents')}
     ORDER BY is_favorite DESC, updated_at DESC
     LIMIT 500`,
    docIds
  )
  const ocrReady = queryOne<{ count: number }>(
    `SELECT COUNT(DISTINCT doc_id) as count
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE p.doc_id IN (${placeholders})
       AND ${activeDocumentCondition('d')}
       AND TRIM(COALESCE(p.proofed_text, '') || COALESCE(p.ocr_text, '')) != ''`,
    docIds
  )

  return {
    count: docIds.length,
    ocrReadyCount: Number(ocrReady?.count || 0),
    documents
  }
}

function resolveSearchableDocumentIds(docIds: string[]): string[] {
  if (docIds.length === 0) return []
  const searchableIds = new Set<string>()
  for (const chunk of chunkValues(uniqueIds(docIds))) {
    const placeholders = buildInClause(chunk)
    queryAll<{ doc_id: string }>(
      `SELECT DISTINCT doc_id
       FROM pages p
       INNER JOIN documents d ON d.id = p.doc_id
       WHERE p.doc_id IN (${placeholders})
         AND ${activeDocumentCondition('d')}
         AND (
           TRIM(COALESCE(NULLIF(p.proofed_text, ''), NULLIF(p.ocr_text, ''), '')) <> ''
           OR COALESCE(p.proofed_text_ref, p.ocr_text_ref, '') <> ''
           OR (${INDEXABLE_PAGE_OCR_RESULT_CONDITION} AND p.ocr_result IS NOT NULL AND p.ocr_result <> '')
           OR (${INDEXABLE_PAGE_OCR_RESULT_CONDITION} AND COALESCE(p.ocr_result_ref, '') <> '')
         )`,
      chunk,
    ).forEach((item) => searchableIds.add(item.doc_id))
  }
  return uniqueIds(docIds).filter((docId) => searchableIds.has(docId))
}

function markSearchIndexDirty(): void {
  fallbackDirty = true
  searchResponseCache.clear()
  searchFilterDocIdsCache.clear()
  postingRowsCache.clear()
  trigramCoverageCache.clear()
}

export function isSearchIndexReindexQueuedInMemory(docId: string): boolean {
  return queuedReindexDocIds.has(String(docId || '').trim())
}

export function notifySearchContentChanged(): void {
  markSearchIndexDirty()
}

export function markSearchIndexStaleForDocuments(docIds: string[]): void {
  const requestedDocIds = uniqueIds(docIds || [])
  if (requestedDocIds.length === 0) return
  const uniqueDocIds = resolveActiveDocumentIds(requestedDocIds)
  if (requestedDocIds.length > 0 && uniqueDocIds.length === 0) {
    markSearchIndexDirty()
    return
  }
  if (uniqueDocIds.length === 0) return

  markSearchIndexDirty()
  scheduleBackgroundReindex(uniqueDocIds, { activeResolved: true })
}

export function markSearchIndexStaleForPages(pageIds: string[]): void {
  const uniquePageIds = uniqueIds(pageIds || [])
  if (uniquePageIds.length === 0) return

  const placeholders = buildInClause(uniquePageIds)
  const docIds = queryAll<{ doc_id: string }>(
    `SELECT DISTINCT doc_id
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE p.id IN (${placeholders})
       AND ${activeDocumentCondition('d')}`,
    uniquePageIds,
  ).map((item) => item.doc_id)
  markSearchIndexStaleForDocuments(docIds)
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

function parseOffsetMap(value: string | null | undefined): number[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => Number(item)).filter(Number.isFinite) : []
  } catch {
    return []
  }
}

function normalizedRangeToOriginal(row: SearchSegmentRow, hit: { index: number; length: number }): { start: number; end: number } {
  const offsets = parseOffsetMap(row.offset_map)
  if (!offsets.length) return { start: hit.index, end: hit.index + hit.length }
  const start = offsets[Math.max(0, Math.min(hit.index, offsets.length - 1))]
  const endOffset = offsets[Math.max(0, Math.min(hit.index + Math.max(0, hit.length - 1), offsets.length - 1))]
  return {
    start: Math.max(0, start),
    end: Math.max(start + 1, endOffset + 1),
  }
}

function getSegmentSourceStart(row: Pick<SearchSegmentRow, 'source_start'>): number {
  const value = Number(row.source_start || 0)
  return Number.isFinite(value) && value > 0 ? value : 0
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

function getBlockLabel(block: OcrBlock): string {
  return String(block?.label || block?.type || block?.block_type || block?.category || '').toLowerCase()
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

function getOrderedOcrBlocks(page: SearchPageRow): OcrBlock[] {
  const parsed = parseMaybeJson<OcrResultPayload>(page?.ocr_result)
  return getOrderedOcrBlocksFromPayload(parsed)
}

function pageHasLazyOcrResult(page: SearchPageRow): boolean {
  return !!page?.ocr_result || !!page?.ocr_result_ref || Number(page?.has_ocr_result || 0) > 0
}

function loadPageOcrResultForSearch(page: SearchPageRow): SearchPageRow {
  if (page.ocr_result || !page.id || !pageHasLazyOcrResult(page)) return page
  const row = queryOne<{ ocr_result?: string | null; ocr_result_ref?: string | null }>(
    'SELECT ocr_result, ocr_result_ref FROM pages WHERE id = ?',
    [page.id],
  )
  return row ? hydratePagePayloadRow({ ...page, ...row }) : page
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
  return readPagePayload(ref) || ''
}

function getIndexablePageText(page: SearchPageRow): string {
  const proofed = String(getHydratedPageTextField(page, 'proofed_text') || '').trim()
  if (proofed) return proofed

  const ocrText = String(getHydratedPageTextField(page, 'ocr_text') || '').trim()
  const shouldLoadBlocks = shouldConsiderOcrBlocksForSearch(page) && (!!page.ocr_result || !ocrText)
  const pageWithOcrResult = shouldLoadBlocks ? loadPageOcrResultForSearch(page) : page
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

function chooseQueryGram(query: string): string {
  if (!SEARCH_NGRAM_INDEX_ENABLED) return ''
  const normalized = normalizeSearchText(query).trim()
  if (!normalized) return ''
  if (normalized.length <= 3) return normalized
  const grams: string[] = []
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    const gram = normalized.slice(index, index + 3)
    if (gram && !/\s/.test(gram)) grams.push(gram)
  }
  if (grams.length === 0) return normalized.slice(0, Math.min(3, normalized.length))

  const placeholders = buildInClause(grams)
  const rows = queryAll<{ gram: string; total: number }>(
    `SELECT gram, SUM(hit_count) as total
     FROM search_ngram_index
     WHERE gram IN (${placeholders})
     GROUP BY gram`,
    grams,
  )
  const totals = new Map(rows.map((row) => [row.gram, Number(row.total || 0)]))
  return [...grams].sort((left, right) => (
    (totals.get(left) || Number.MAX_SAFE_INTEGER) - (totals.get(right) || Number.MAX_SAFE_INTEGER)
    || right.length - left.length
    || left.localeCompare(right)
  ))[0]
}

function chooseQueryNgramCandidates(query: string): string[] {
  if (!SEARCH_NGRAM_INDEX_ENABLED) return []
  const normalized = normalizeSearchText(query).trim()
  if (!normalized) return []
  if (normalized.length < 2) return []
  if (normalized.length <= 3) return [normalized]
  return [chooseQueryGram(normalized)].filter(Boolean)
}

function versionedSourceHash(segmentHashes: string[]): string {
  return `${SEARCH_INDEX_VERSION}:${hashText(segmentHashes.join('|'))}`
}

function getCurrentSearchIndexStatus(docId: string): CurrentSearchIndexStatus | null {
  return queryOne<CurrentSearchIndexStatus>('SELECT status, source_hash, segment_count, error_message, updated_at FROM search_index_status WHERE doc_id = ?', [docId])
}

function getSearchIndexSegmentStats(docId: string): SearchIndexSegmentStats {
  const segmentStats = queryOne<{
    segmentCount?: number | null
    pageCount?: number | null
    minHash?: string | null
    maxHash?: string | null
    indexedAt?: string | null
  }>(
    `SELECT
       COUNT(*) as segmentCount,
       COUNT(DISTINCT COALESCE(NULLIF(page_id, ''), segment_id)) as pageCount,
       MIN(COALESCE(text_hash, '')) as minHash,
       MAX(COALESCE(text_hash, '')) as maxHash,
       MAX(updated_at) as indexedAt
     FROM search_index_segments
     WHERE doc_id = ?
       AND TRIM(COALESCE(normalized_text, text, '')) <> ''`,
    [docId],
  )
  let ftsCount = 0
  if (isFtsAvailable()) {
    const ftsStats = queryOne<{ count?: number | null }>(
      `SELECT COUNT(*) as count
       FROM search_segments_fts fts
       INNER JOIN search_index_segments s ON s.rowid = fts.rowid
       WHERE s.doc_id = ?`,
      [docId],
    )
    ftsCount = Number(ftsStats?.count || 0)
  }
  let trigramFtsCount = 0
  if (isSearchTrigramFtsAvailable()) {
    const trigramStats = queryOne<{ count?: number | null }>(
      `SELECT COUNT(*) as count
       FROM search_segments_trigram tri
       INNER JOIN search_index_segments s ON s.rowid = tri.rowid
       WHERE s.doc_id = ?`,
      [docId],
    )
    trigramFtsCount = Number(trigramStats?.count || 0)
  }
  return {
    segmentCount: Number(segmentStats?.segmentCount || 0),
    pageCount: Number(segmentStats?.pageCount || 0),
    ftsCount,
    trigramFtsCount,
    minHash: String(segmentStats?.minHash || ''),
    maxHash: String(segmentStats?.maxHash || ''),
    indexedAt: segmentStats?.indexedAt || null,
  }
}

function hasSearchIndexSegments(docId: string): boolean {
  const row = queryOne<{ found?: number | null }>(
    `SELECT 1 as found
     FROM search_index_segments
     WHERE doc_id = ?
       AND TRIM(COALESCE(normalized_text, text, '')) <> ''
     LIMIT 1`,
    [docId],
  )
  return !!row?.found
}

function buildSearchIndexContentSignature(
  items: Array<{ pageId?: string | null; segmentId?: string | null; signatureText?: string | null }>,
): SearchIndexContentSignature {
  const hashes = items.map((item) => hashText(String(item.signatureText || '')))
  const pageIds = new Set(items.map((item) => String(item.pageId || item.segmentId || '')).filter(Boolean))
  return {
    segmentCount: hashes.length,
    pageCount: pageIds.size,
    minHash: hashes.length > 0 ? [...hashes].sort()[0] || '' : '',
    maxHash: hashes.length > 0 ? [...hashes].sort().reverse()[0] || '' : '',
    hashSignature: hashText(hashes.join('|')),
  }
}

function getStoredSearchIndexContentSignature(docId: string): SearchIndexContentSignature {
  const rows = queryAll<{
    segmentId: string
    pageId?: string | null
    pageNum?: number | null
    sourceKind?: string | null
    ordinal?: number | null
    sourceStart?: number | null
    normalizedText?: string | null
    text?: string | null
  }>(
    `SELECT
       segment_id as segmentId,
       page_id as pageId,
       page_num as pageNum,
       source_kind as sourceKind,
       ordinal,
       source_start as sourceStart,
       normalized_text as normalizedText,
       text
     FROM search_index_segments
     WHERE doc_id = ?
       AND TRIM(COALESCE(normalized_text, text, '')) <> ''
     ORDER BY COALESCE(page_num, 0) ASC, ordinal ASC, segment_id ASC`,
    [docId],
  )
  return buildSearchIndexContentSignature(rows.map((row) => ({
    segmentId: row.segmentId,
    pageId: row.pageId,
    signatureText: [
      row.sourceKind || 'page',
      row.pageId || '',
      Number(row.pageNum || 0),
      Number(row.ordinal || 0),
      Number(row.sourceStart || 0),
      row.normalizedText || row.text || '',
    ].join('\u001f'),
  })))
}

function buildCurrentSearchIndexContentSignature(docId: string): SearchIndexContentSignature {
  const pages = loadIndexablePagesForDocument(docId)
  const segments = [
    ...pages.flatMap((page, index) => buildSearchIndexSegmentDrafts(docId, page, index)),
    ...buildTranslationSearchIndexSegmentDrafts(docId),
  ]
  return buildSearchIndexContentSignature(segments.map((segment) => ({
    segmentId: segment.segmentId,
    pageId: segment.pageId,
    signatureText: [
      segment.sourceKind,
      segment.pageId || '',
      segment.pageNum,
      segment.ordinal,
      segment.sourceStart,
      segment.normalizedText,
    ].join('\u001f'),
  })))
}

function isStoredSearchIndexCurrentForDocument(docId: string, stats: SearchIndexSegmentStats): boolean {
  if (stats.segmentCount <= 0 || stats.pageCount <= 0) return false
  const stored = getStoredSearchIndexContentSignature(docId)
  if (stored.segmentCount !== stats.segmentCount || stored.pageCount !== stats.pageCount) return false
  const current = buildCurrentSearchIndexContentSignature(docId)
  return current.segmentCount === stored.segmentCount
    && current.pageCount === stored.pageCount
    && current.minHash === stored.minHash
    && current.maxHash === stored.maxHash
    && current.hashSignature === stored.hashSignature
}

function buildRecoveredSearchIndexSourceHash(docId: string, stats: SearchIndexSegmentStats): string {
  return `legacy-existing-index:${hashText([
    docId,
    stats.segmentCount,
    stats.pageCount,
    stats.minHash,
    stats.maxHash,
  ].join(':'))}`
}

function restoreSearchIndexStatusFromSegments(docId: string, stats: SearchIndexSegmentStats): void {
  const now = new Date().toISOString()
  const sourceHash = buildRecoveredSearchIndexSourceHash(docId, stats)
  run(
    `INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET
       status = excluded.status,
       source_hash = excluded.source_hash,
       segment_count = excluded.segment_count,
       error_message = excluded.error_message,
       indexed_at = excluded.indexed_at,
       updated_at = excluded.updated_at`,
    [docId, 'ready', sourceHash, stats.segmentCount, null, stats.indexedAt || now, now],
  )
  if (
    isFtsAvailable()
    && (
      stats.ftsCount < stats.segmentCount
      || (isSearchTrigramFtsAvailable() && stats.trigramFtsCount < stats.segmentCount)
    )
  ) {
    refreshSearchSegmentsFtsForDocument(docId)
  }
  scheduleDatabaseSave()
  markSearchIndexDirty()
}

function repairUsableLegacySearchIndexStatus(docId: string, status?: CurrentSearchIndexStatus | null): boolean {
  const current = status || getCurrentSearchIndexStatus(docId)
  if (current?.status === 'ready') return false

  const stats = getSearchIndexSegmentStats(docId)
  if (!isStoredSearchIndexCurrentForDocument(docId, stats)) return false

  restoreSearchIndexStatusFromSegments(docId, stats)
  return true
}

function isUsableSearchIndexStatus(docId: string, status?: CurrentSearchIndexStatus | null): boolean {
  const current = status || getCurrentSearchIndexStatus(docId)
  if (!current) return repairUsableLegacySearchIndexStatus(docId, current)
  if (current.status === 'ready') {
    return hasSearchIndexSegments(docId)
  }
  return repairUsableLegacySearchIndexStatus(docId, current)
}

export function isSearchIndexUsableForDocument(docId: string): boolean {
  return isUsableSearchIndexStatus(docId, getCurrentSearchIndexStatus(docId))
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

async function yieldAfterSearchIndexSlice(startedAt: number): Promise<number> {
  if (Date.now() - startedAt < BACKGROUND_REINDEX_TIME_SLICE_MS) return startedAt
  await yieldToEventLoop()
  return Date.now()
}

function emitSearchIndexTaskStatus(payload: {
  status: 'queued' | 'processing' | 'completed' | 'error'
  progress?: number
  message?: string
  docId?: string
  totalCount?: number
  completedCount?: number
  errorMessage?: string
}): void {
  emitBackgroundTaskStatus({
    taskId: BACKGROUND_REINDEX_TASK_ID,
    kind: 'search-index',
    ...payload,
  })
}

function getSearchIndexReindexReasonLabel(reason?: SearchIndexReindexReason): string {
  switch (reason) {
    case 'manual':
      return '手动重建'
    case 'content-changed':
      return '文献内容已更新'
    case 'ocr-batch-deferred':
      return 'OCR 完成后更新'
    case 'search-scope-stale':
      return '当前检索范围索引待更新'
    case 'search-managed-text-stale':
      return '电子书/文本索引待更新'
    case 'search-hit-locator':
      return '命中定位需要补全索引'
    case 'global-stale-suppressed':
      return '全库疑似过期索引已暂缓自动重建'
    default:
      return '搜索索引待更新'
  }
}

function getSearchIndexReindexMessage(reason?: SearchIndexReindexReason): string {
  return `正在后台更新搜索索引（${getSearchIndexReindexReasonLabel(reason)}），不影响阅读和浏览`
}

function isBackgroundReindexPaused(): boolean {
  return backgroundReindexPauseDepth > 0
}

export function pauseBackgroundSearchReindex(): void {
  backgroundReindexPauseDepth += 1
  if (reindexTimer) {
    clearTimeout(reindexTimer)
    reindexTimer = null
  }
}

export function resumeBackgroundSearchReindex(options: { delayMs?: number; reason?: SearchIndexReindexReason } = {}): void {
  backgroundReindexPauseDepth = Math.max(0, backgroundReindexPauseDepth - 1)
  if (backgroundReindexPauseDepth > 0) return
  if (!AUTO_BACKGROUND_REINDEX_ENABLED || queuedReindexDocIds.size === 0 || reindexTimer || reindexWorkerRunning) return
  scheduleBackgroundReindex([], {
    delayMs: options.delayMs ?? BACKGROUND_REINDEX_DRAIN_PAUSE_MS,
    reason: options.reason ?? 'ocr-batch-deferred',
  })
}

function updateSearchIndexStatus(
  docId: string,
  status: string,
  options: { sourceHash?: string; segmentCount?: number; errorMessage?: string | null; indexedAt?: string | null } = {},
): void {
  const now = new Date().toISOString()
  run(
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

function countIndexablePagesForDocument(docId: string): number {
  const row = queryOne<{ count?: number | null }>(
    `SELECT COUNT(*) as count
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE ${getIndexablePagesWhereClause()}`,
    [docId],
  )
  return Number(row?.count || 0)
}

function loadIndexablePagesForDocument(docId: string, limit?: number, offset = 0): SearchPageRow[] {
  const params: Array<string | number> = [docId]
  let sql = `${INDEXABLE_PAGE_BASE_SELECT}
     WHERE ${getIndexablePagesWhereClause()}
     ORDER BY p.page_num ASC`
  if (typeof limit === 'number') {
    sql += ' LIMIT ? OFFSET ?'
    params.push(Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(offset)))
  }
  return queryAll<SearchPageRow>(sql, params)
}

type SearchIndexStagingTable = 'search_ngram_index_staging' | 'search_index_segments_staging'

function createSearchIndexStagingJobId(docId: string): string {
  return `${docId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

async function deleteRowsByJobIdInBackground(tableName: SearchIndexStagingTable, jobId: string, sliceStartedAt: number): Promise<number> {
  let nextSliceStartedAt = sliceStartedAt
  while (true) {
    const rows = queryAll<{ rowid: number }>(
      `SELECT rowid FROM ${tableName} WHERE job_id = ? LIMIT ?`,
      [jobId, BACKGROUND_REINDEX_DELETE_BATCH_SIZE],
    )
    if (rows.length === 0) break
    const rowIds = rows.map((row) => Number(row.rowid)).filter(Number.isFinite)
    if (rowIds.length === 0) break
    run(`DELETE FROM ${tableName} WHERE rowid IN (${rowIds.map(() => '?').join(', ')})`, rowIds)
    nextSliceStartedAt = await yieldAfterSearchIndexSlice(nextSliceStartedAt)
  }
  return nextSliceStartedAt
}

async function cleanupSearchIndexStagingRows(jobId: string, sliceStartedAt = Date.now()): Promise<number> {
  let nextSliceStartedAt = await deleteRowsByJobIdInBackground('search_ngram_index_staging', jobId, sliceStartedAt)
  nextSliceStartedAt = await deleteRowsByJobIdInBackground('search_index_segments_staging', jobId, nextSliceStartedAt)
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

function buildSearchIndexSegmentDrafts(docId: string, page: SearchPageRow, index: number): SearchIndexSegmentDraft[] {
  const text = getIndexablePageText(page).trim()
  if (!text) return []
  const meta = parseSegmentMeta(page)
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

function insertSearchIndexSegmentDraftIntoStaging(jobId: string, docId: string, segment: SearchIndexSegmentDraft, now: string): void {
  run(
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
  jobId: string,
  docId: string,
  segmentId: string,
  grams: Array<{ gram: string; positions: number[]; hitCount: number }>,
): void {
  grams.forEach(({ gram, positions, hitCount }) => {
    run(
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

async function insertSearchNgramsForStagedSegmentInBackground(jobId: string, docId: string, segment: SearchIndexSegmentDraft, sliceStartedAt: number): Promise<number> {
  const grams = getSearchNgrams(segment.normalizedText, 3, SEARCH_NGRAM_MAX_POSITIONS_STORED)
  let nextSliceStartedAt = sliceStartedAt
  for (let index = 0; index < grams.length; index += BACKGROUND_REINDEX_NGRAM_WRITE_BATCH_SIZE) {
    const chunk = grams.slice(index, index + BACKGROUND_REINDEX_NGRAM_WRITE_BATCH_SIZE)
    transaction(() => {
      upsertSearchNgramStagingRows(jobId, docId, segment.segmentId, chunk)
    })
    nextSliceStartedAt = await yieldAfterSearchIndexSlice(nextSliceStartedAt)
  }
  return nextSliceStartedAt
}

function commitStagedSearchIndexForDocument(
  jobId: string,
  docId: string,
  sourceHash: string,
  segmentCount: number,
  now: string,
): void {
  transaction(() => {
    const skipFtsDelete = isSearchSegmentsFtsRebuildNeeded()
    if (isFtsAvailable() && !skipFtsDelete) {
      run(
        `INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
         SELECT 'delete', rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId],
      )
    }
    if (isSearchTrigramFtsAvailable() && !skipFtsDelete) {
      run(
        `INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)
         SELECT 'delete', rowid, COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId],
      )
    }
    run('DELETE FROM search_ngram_index WHERE doc_id = ?', [docId])
    run('DELETE FROM search_index_segments WHERE doc_id = ?', [docId])
    run(
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
    run(
      `INSERT INTO search_ngram_index (gram, segment_id, doc_id, positions, hit_count)
       SELECT gram, segment_id, doc_id, positions, hit_count
       FROM search_ngram_index_staging
       WHERE job_id = ?`,
      [jobId],
    )
    if (isFtsAvailable()) {
      run(
        `INSERT INTO search_segments_fts (rowid, title, normalized_text)
         SELECT rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId],
      )
    }
    if (isSearchTrigramFtsAvailable()) {
      run(
        `INSERT INTO search_segments_trigram (rowid, normalized_text)
         SELECT rowid, COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId],
      )
    }
    run(
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
    run('DELETE FROM search_ngram_index_staging WHERE job_id = ?', [jobId])
    run('DELETE FROM search_index_segments_staging WHERE job_id = ?', [jobId])
  })
}

async function reindexDocumentInBackground(docId: string, totalCount: number, completedCount: number): Promise<SearchReindexDocumentResult> {
  queuedReindexDocIds.delete(docId)
  const doc = queryOne<Pick<SearchDocumentRow, 'id' | 'import_status'>>('SELECT id, import_status FROM documents WHERE id = ?', [docId])
  if (!doc) return { docId, status: 'missing', segmentCount: 0, error: '文献不存在' }
  if (isDeletingImportStatus(doc.import_status)) {
    markSearchIndexDirty()
    return { docId, status: 'skipped', segmentCount: 0, error: '文献正在后台删除' }
  }

  const now = new Date().toISOString()
  const stagingJobId = createSearchIndexStagingJobId(docId)
  try {
    updateSearchIndexStatus(docId, 'processing')
    emitSearchIndexTaskStatus({
      status: 'processing',
      docId,
      totalCount,
      completedCount,
      progress: completedCount / Math.max(totalCount, 1),
      message: '正在后台更新搜索索引，不影响阅读和浏览',
    })

    const totalPages = countIndexablePagesForDocument(docId)
    const segmentHashes: string[] = []
    let segmentCount = 0
    let processedPages = 0
    let sliceStartedAt = await cleanupSearchIndexStagingRows(stagingJobId, Date.now())
    for (let offset = 0; ; offset += BACKGROUND_REINDEX_PAGE_BATCH_SIZE) {
      const pages = loadIndexablePagesForDocument(docId, BACKGROUND_REINDEX_PAGE_BATCH_SIZE, offset)
      if (pages.length === 0) break
      const segments = pages.flatMap((page, pageIndex) => buildSearchIndexSegmentDrafts(docId, page, offset + pageIndex))
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE) {
        const segmentChunk = segments.slice(segmentIndex, segmentIndex + BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE)
        transaction(() => {
          segmentChunk.forEach((segment) => insertSearchIndexSegmentDraftIntoStaging(stagingJobId, docId, segment, now))
        })
        segmentChunk.forEach((segment) => segmentHashes.push(segment.textHash))
        segmentCount += segmentChunk.length
        for (const segment of segmentChunk) {
          sliceStartedAt = await insertSearchNgramsForStagedSegmentInBackground(stagingJobId, docId, segment, sliceStartedAt)
        }
        sliceStartedAt = await yieldAfterSearchIndexSlice(sliceStartedAt)
      }
      processedPages += pages.length
      emitSearchIndexTaskStatus({
        status: 'processing',
        docId,
        totalCount,
        completedCount,
        progress: (completedCount + Math.min(0.95, processedPages / Math.max(totalPages, 1))) / Math.max(totalCount, 1),
        message: '正在后台更新搜索索引，不影响阅读和浏览',
      })
      sliceStartedAt = await yieldAfterSearchIndexSlice(sliceStartedAt)
    }

    const translationSegments = buildTranslationSearchIndexSegmentDrafts(docId)
    for (let segmentIndex = 0; segmentIndex < translationSegments.length; segmentIndex += BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE) {
      const segmentChunk = translationSegments.slice(segmentIndex, segmentIndex + BACKGROUND_REINDEX_SEGMENT_WRITE_BATCH_SIZE)
      transaction(() => {
        segmentChunk.forEach((segment) => insertSearchIndexSegmentDraftIntoStaging(stagingJobId, docId, segment, now))
      })
      segmentChunk.forEach((segment) => segmentHashes.push(segment.textHash))
      segmentCount += segmentChunk.length
      for (const segment of segmentChunk) {
        sliceStartedAt = await insertSearchNgramsForStagedSegmentInBackground(stagingJobId, docId, segment, sliceStartedAt)
      }
    }

    const readyAt = new Date().toISOString()
    const sourceHash = versionedSourceHash(segmentHashes)
    commitStagedSearchIndexForDocument(stagingJobId, docId, sourceHash, segmentCount, readyAt)
    scheduleDatabaseSave()
    markSearchIndexDirty()
    return { docId, status: 'ready', segmentCount }
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error)
    try {
      await cleanupSearchIndexStagingRows(stagingJobId)
    } catch (cleanupError) {
      console.warn('[Search] Failed to clean staged search index rows', cleanupError)
    }
    updateSearchIndexStatus(docId, 'error', { errorMessage })
    scheduleDatabaseSave()
    return { docId, status: 'error', segmentCount: 0, error: errorMessage }
  }
}

async function reindexDocumentThroughWorker(docId: string, totalCount: number, completedCount: number): Promise<SearchReindexDocumentResult> {
  queuedReindexDocIds.delete(docId)
  const doc = queryOne<Pick<SearchDocumentRow, 'id' | 'import_status'>>('SELECT id, import_status FROM documents WHERE id = ?', [docId])
  if (!doc) return { docId, status: 'missing', segmentCount: 0, error: '文献不存在' }
  if (isDeletingImportStatus(doc.import_status)) {
    markSearchIndexDirty()
    return { docId, status: 'skipped', segmentCount: 0, error: '文献正在后台删除' }
  }

  if (!isSearchIndexWorkerAvailable()) {
    queuedReindexDocIds.add(docId)
    return reindexDocumentInBackground(docId, totalCount, completedCount)
  }

  try {
    const result = await runSearchIndexWorkerTask(
      {
        dbFilePath: getDatabaseFilePath(),
        dataDir: getDataDir(),
        docId,
        totalCount,
        completedCount,
      },
      (progress) => {
        emitSearchIndexTaskStatus(progress)
      },
    )
    scheduleDatabaseSave()
    markSearchIndexDirty()
    return result
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error)
    updateSearchIndexStatus(docId, 'error', { errorMessage })
    scheduleDatabaseSave()
    return { docId, status: 'error', segmentCount: 0, error: errorMessage }
  }
}

async function drainReindexQueue(): Promise<void> {
  reindexTimer = null
  if (isBackgroundReindexPaused()) {
    return
  }
  if (reindexWorkerRunning || queuedReindexDocIds.size === 0) return

  reindexWorkerRunning = true
  if (reindexDrainCompletedCount === 0) {
    reindexDrainErrorCount = 0
    reindexDrainLastErrorMessage = ''
    reindexDrainTotalCount = queuedReindexDocIds.size
  } else {
    reindexDrainTotalCount = Math.max(reindexDrainTotalCount, reindexDrainCompletedCount + queuedReindexDocIds.size)
  }
  try {
    emitSearchIndexTaskStatus({
      status: 'processing',
      totalCount: Math.max(reindexDrainTotalCount, queuedReindexDocIds.size),
      completedCount: reindexDrainCompletedCount,
      progress: reindexDrainTotalCount > 0 ? reindexDrainCompletedCount / reindexDrainTotalCount : 0,
      message: '正在后台更新搜索索引，不影响阅读和浏览',
    })

    let processedThisDrain = 0
    while (queuedReindexDocIds.size > 0 && processedThisDrain < BACKGROUND_REINDEX_DRAIN_BATCH_SIZE && !isBackgroundReindexPaused()) {
      const totalCount = Math.max(reindexDrainCompletedCount + queuedReindexDocIds.size, reindexDrainTotalCount, 1)
      const docId = queuedReindexDocIds.values().next().value as string | undefined
      if (!docId) break
      const result = await reindexDocumentThroughWorker(docId, totalCount, reindexDrainCompletedCount)
      reindexDrainCompletedCount += 1
      processedThisDrain += 1
      if (result.status === 'error') {
        reindexDrainErrorCount += 1
        reindexDrainLastErrorMessage = result.error || '后台索引更新失败'
        console.warn('[Search] Background document reindex failed', docId, result.error)
      }
      await yieldToEventLoop()
    }
  } finally {
    reindexWorkerRunning = false
    if (queuedReindexDocIds.size > 0) {
      scheduleBackgroundReindex([], { delayMs: BACKGROUND_REINDEX_DRAIN_PAUSE_MS })
      return
    }

    const completedCount = reindexDrainCompletedCount
    const errorCount = reindexDrainErrorCount
    const lastErrorMessage = reindexDrainLastErrorMessage
    reindexDrainCompletedCount = 0
    reindexDrainErrorCount = 0
    reindexDrainLastErrorMessage = ''
    reindexDrainTotalCount = 0
    emitSearchIndexTaskStatus({
      status: errorCount > 0 ? 'error' : 'completed',
      totalCount: completedCount,
      completedCount,
      progress: 1,
      message: errorCount > 0 ? '后台索引更新失败，可稍后在健康检查中重试' : '搜索索引更新完成，搜索结果已可用',
      errorMessage: errorCount > 0 ? lastErrorMessage : undefined,
    })
  }
}

function scheduleBackgroundReindex(docIds: string[], options: { activeResolved?: boolean; delayMs?: number; reason?: SearchIndexReindexReason } = {}): void {
  const requestedDocIds = uniqueIds(docIds)
  const newDocIds = requestedDocIds.length > 0
    ? options.activeResolved ? requestedDocIds : resolveActiveDocumentIds(requestedDocIds)
    : []
  const newlyQueuedDocIds: string[] = []
  newDocIds.forEach((docId) => {
    if (queuedReindexDocIds.has(docId)) return
    queuedReindexDocIds.add(docId)
    newlyQueuedDocIds.push(docId)
  })
  newlyQueuedDocIds.forEach((docId) => {
    updateSearchIndexStatus(docId, 'queued')
  })
  if (newlyQueuedDocIds.length > 0) {
    emitSearchIndexTaskStatus({
      status: 'queued',
      totalCount: queuedReindexDocIds.size,
      completedCount: 0,
      progress: 0,
      message: getSearchIndexReindexMessage(options.reason),
    })
  }
  if (!AUTO_BACKGROUND_REINDEX_ENABLED) return
  if (isBackgroundReindexPaused()) return
  if (queuedReindexDocIds.size === 0 || reindexTimer || reindexWorkerRunning) return
  reindexTimer = setTimeout(drainReindexQueue, options.delayMs ?? BACKGROUND_REINDEX_DELAY_MS)
}

function parseSegmentMeta(page: SearchPageRow): { sourceKind: string; href: string | null; title: string | null } {
  if (!isManagedTextSearchPage(page)) return { sourceKind: 'page', href: null, title: null }
  try {
    const pageWithOcrResult = loadPageOcrResultForSearch(page)
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

function loadSearchSegmentsForDocument(docId: string): SearchSegmentRow[] {
  if (resolveActiveDocumentIds([docId]).length === 0) return []
  return queryAll<SearchSegmentRow>(
    `SELECT segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start, text, normalized_text, offset_map
     FROM search_index_segments
     WHERE doc_id = ?
     ORDER BY COALESCE(page_num, 0) ASC, ordinal ASC`,
    [docId],
  )
}

function loadPageSegmentsForDocument(docId: string): SearchSegmentRow[] {
  if (resolveActiveDocumentIds([docId]).length === 0) return []
  return queryAll<SearchPageRow>(
    `SELECT
       id,
       doc_id,
       page_num,
       proofed_text,
       proofed_text_ref,
       ocr_text,
       ocr_text_ref,
       NULL as ocr_result,
       ocr_result_ref,
       CASE WHEN (ocr_result IS NOT NULL AND ocr_result <> '') OR COALESCE(ocr_result_ref, '') <> '' THEN 1 ELSE 0 END as has_ocr_result,
       COALESCE(proofed_text, ocr_text, '') as text
     FROM pages
     WHERE doc_id = ?
       AND (TRIM(COALESCE(proofed_text, ocr_text, '')) <> '' OR COALESCE(proofed_text_ref, ocr_text_ref, ocr_result_ref, '') <> '')
     ORDER BY page_num ASC`,
    [docId],
  ).flatMap((page, index) => (
    buildSearchIndexSegmentDrafts(docId, page, index).map((segment) => ({
      segment_id: segment.segmentId,
      doc_id: page.doc_id,
      page_id: segment.pageId,
      page_num: segment.pageNum,
      source_kind: segment.sourceKind,
      href: segment.href,
      title: segment.title,
      ordinal: segment.ordinal,
      source_start: segment.sourceStart,
      text: segment.text,
      normalized_text: segment.normalizedText,
      offset_map: JSON.stringify(segment.offsetMap),
    }))
  ))
}

function insertSearchNgramsForStagedSegment(jobId: string, segment: { segmentId: string; docId: string; normalizedText: string }) {
  const grams = getSearchNgrams(segment.normalizedText, 3, SEARCH_NGRAM_MAX_POSITIONS_STORED)
  upsertSearchNgramStagingRows(jobId, segment.docId, segment.segmentId, grams)
}

export function reindexDocument(docId: string): SearchReindexDocumentResult {
  queuedReindexDocIds.delete(docId)
  const doc = queryOne<Pick<SearchDocumentRow, 'id' | 'import_status'>>('SELECT id, import_status FROM documents WHERE id = ?', [docId])
  if (!doc) return { docId, status: 'missing', segmentCount: 0, error: '文献不存在' }
  if (isDeletingImportStatus(doc.import_status)) {
    markSearchIndexDirty()
    return { docId, status: 'skipped', segmentCount: 0, error: '文献正在后台删除' }
  }

  const now = new Date().toISOString()
  const stagingJobId = createSearchIndexStagingJobId(docId)
  try {
    const pages = loadIndexablePagesForDocument(docId)
    const segments = [
      ...pages.flatMap((page, index) => buildSearchIndexSegmentDrafts(docId, page, index)),
      ...buildTranslationSearchIndexSegmentDrafts(docId),
    ]

    const sourceHash = versionedSourceHash(segments.map((segment) => segment.textHash))
    transaction(() => {
      run('DELETE FROM search_ngram_index_staging WHERE job_id = ?', [stagingJobId])
      run('DELETE FROM search_index_segments_staging WHERE job_id = ?', [stagingJobId])
      segments.forEach((segment) => {
        insertSearchIndexSegmentDraftIntoStaging(stagingJobId, docId, segment, now)
        insertSearchNgramsForStagedSegment(stagingJobId, { segmentId: segment.segmentId, docId, normalizedText: segment.normalizedText })
      })
    })
    commitStagedSearchIndexForDocument(stagingJobId, docId, sourceHash, segments.length, now)
    saveDatabase()
    markSearchIndexDirty()
    return { docId, status: 'ready', segmentCount: segments.length }
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error)
    run('DELETE FROM search_ngram_index_staging WHERE job_id = ?', [stagingJobId])
    run('DELETE FROM search_index_segments_staging WHERE job_id = ?', [stagingJobId])
    run(
      `INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET status = excluded.status, error_message = excluded.error_message, updated_at = excluded.updated_at`,
      [docId, 'error', '', 0, errorMessage, null, now],
    )
    saveDatabase()
    return { docId, status: 'error', segmentCount: 0, error: errorMessage }
  }
}

export function reindexAllDocuments(): SearchReindexAllResult {
  queuedReindexDocIds.clear()
  const docs = queryAll<{ id: string }>(
    `SELECT id FROM documents WHERE ${activeDocumentCondition('documents')} ORDER BY updated_at DESC`,
  )
  let ready = 0
  let errors = 0
  docs.forEach((doc) => {
    const result = reindexDocument(doc.id)
    if (result.status === 'ready') ready += 1
    else if (result.status === 'error') errors += 1
  })
  return { total: docs.length, ready, errors }
}

export function queueDocumentReindex(docId: string): SearchReindexDocumentResult {
  const doc = queryOne<Pick<SearchDocumentRow, 'id' | 'import_status'>>('SELECT id, import_status FROM documents WHERE id = ?', [docId])
  if (!doc) return { docId, status: 'missing', segmentCount: 0, error: '文献不存在' }
  if (isDeletingImportStatus(doc.import_status)) {
    markSearchIndexDirty()
    return { docId, status: 'skipped', segmentCount: 0, error: '文献正在后台删除' }
  }
  scheduleBackgroundReindex([docId], { reason: 'manual' })
  const status = getCurrentSearchIndexStatus(docId)
  return { docId, status: 'queued', segmentCount: Number(status?.segment_count || 0) }
}

export function queueAllDocumentsReindex(): SearchReindexAllResult {
  const docs = queryAll<{ id: string }>(
    `SELECT id FROM documents WHERE ${activeDocumentCondition('documents')} ORDER BY updated_at DESC`,
  )
  scheduleBackgroundReindex(docs.map((doc) => doc.id), { reason: 'manual' })
  return { total: docs.length, ready: 0, errors: 0, queued: docs.length }
}

export function getSearchIndexStatus(docId?: string): SearchIndexStatus[] {
  const rows = docId
    ? queryAll<SearchIndexStatus>('SELECT * FROM search_index_status WHERE doc_id = ?', [docId])
    : queryAll<SearchIndexStatus>('SELECT * FROM search_index_status ORDER BY updated_at DESC LIMIT 200')
  return rows.map((row) => ({
    ...row,
    statusEnvelope: statusEnvelopeFromSearchIndexStatus(row),
    healthDiagnostics: buildSearchIndexHealthDiagnostics(row),
  }))
}

function ensureDocumentIndexed(docId: string): void {
  if (resolveActiveDocumentIds([docId]).length === 0) return
  const status = getCurrentSearchIndexStatus(docId)
  if (!isUsableSearchIndexStatus(docId, status)) {
    scheduleBackgroundReindex([docId], { reason: 'search-scope-stale' })
  }
}

function ensureSearchIndexForScope(docIds?: string[]): void {
  const targetDocIds = docIds && docIds.length > 0
    ? resolveActiveDocumentIds(docIds)
    : resolveActiveDocumentIds()
  targetDocIds.forEach(ensureDocumentIndexed)
}

function ensureManagedTextDocumentsIndexed(docIds?: string[]): string[] {
  const params: string[] = []
  const scopeSql = docIds && docIds.length > 0
    ? `AND d.id IN (${docIds.map(() => '?').join(', ')})`
    : ''
  if (docIds && docIds.length > 0) params.push(...docIds)
  const docs = queryAll<{ id: string }>(
    `SELECT d.id
     FROM documents d
     WHERE (
       d.doc_type IN ('电子书', '文本')
       OR d.file_path LIKE '%.epub'
       OR d.file_path LIKE '%.txt'
       OR d.file_path LIKE '%.md'
       OR d.metadata LIKE '%"file_kind":"ebook"%'
       OR d.metadata LIKE '%"file_kind":"text"%'
       OR d.metadata LIKE '%"import_source_type":"epub"%'
       OR d.metadata LIKE '%"format":"epub"%'
     )
     AND ${activeDocumentCondition('d')}
     ${scopeSql}`,
    params,
  )
  const reindexed: string[] = []
  docs.forEach((doc) => {
    if (isUsableSearchIndexStatus(doc.id, getCurrentSearchIndexStatus(doc.id))) return
    scheduleBackgroundReindex([doc.id], { reason: 'search-managed-text-stale' })
    reindexed.push(doc.id)
  })
  return reindexed
}

function staleSearchIndexSqlCondition(alias = 'sis'): string {
  return `(
    ${alias}.doc_id IS NULL
    OR (
      COALESCE(${alias}.status, '') <> 'ready'
      AND (
        TRIM(COALESCE(${alias}.source_hash, '')) <> ''
        OR COALESCE(${alias}.segment_count, 0) > 0
      )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM search_index_segments sidx
      WHERE sidx.doc_id = d.id
        AND TRIM(COALESCE(sidx.normalized_text, sidx.text, '')) <> ''
      LIMIT 1
    )
  )`
}

function findStaleManagedTextDocIds(docIds?: string[], limit = 80): string[] {
  const params: string[] = []
  const scopeSql = docIds && docIds.length > 0
    ? `AND d.id IN (${docIds.map(() => '?').join(', ')})`
    : ''
  if (docIds && docIds.length > 0) params.push(...docIds)
  return queryAll<{ id: string }>(
    `SELECT d.id
     FROM documents d
     LEFT JOIN search_index_status sis ON sis.doc_id = d.id
     WHERE (
       d.doc_type IN ('电子书', '文本')
       OR d.file_path LIKE '%.epub'
       OR d.file_path LIKE '%.txt'
       OR d.file_path LIKE '%.md'
       OR d.metadata LIKE '%"file_kind":"ebook"%'
       OR d.metadata LIKE '%"file_kind":"text"%'
       OR d.metadata LIKE '%"import_source_type":"epub"%'
       OR d.metadata LIKE '%"format":"epub"%'
     )
     AND ${activeDocumentCondition('d')}
     ${scopeSql}
       AND ${staleSearchIndexSqlCondition('sis')}
     ORDER BY d.updated_at DESC
     LIMIT ?`,
    [...params, limit],
  ).map((item) => item.id)
}

function checkSearchIndexForScope(docIds?: string[], options: { autoReindex?: boolean } = {}): string[] {
  const uniqueDocIds = uniqueIds(docIds || [])
  const scoped = uniqueDocIds.length > 0
  const staleDocIds = uniqueDocIds.length > 0
    ? resolveActiveDocumentIds(uniqueDocIds).filter((docId) => !isUsableSearchIndexStatus(docId, getCurrentSearchIndexStatus(docId)))
    : queryAll<{ id: string }>(
        `SELECT d.id
         FROM documents d
         LEFT JOIN search_index_status sis ON sis.doc_id = d.id
         WHERE ${activeDocumentCondition('d')}
           AND ${staleSearchIndexSqlCondition('sis')}
         ORDER BY d.updated_at DESC
         LIMIT ?`,
        [SEARCH_STALE_GLOBAL_SCAN_LIMIT],
      ).map((row) => row.id)
  if (staleDocIds.length > 0 && scoped && options.autoReindex !== false) {
    scheduleBackgroundReindex(staleDocIds, { reason: 'search-scope-stale' })
  }
  return staleDocIds
}

function matchesDocumentFilters(doc: SearchDocumentRow, options?: SearchOptions): boolean {
  if (!options?.importStatus && isDeletingImportStatus(doc.import_status)) return false
  if (!options) return true
  if (Array.isArray(options.docIds) && options.docIds.length > 0 && !options.docIds.includes(String(doc.id))) return false
  if (options.docType && doc.doc_type !== options.docType) return false
  if (options.author && !(doc.doc_author || doc.author || '').includes(options.author)) return false
  if (options.dynasty) {
    const expected = String(options.dynasty).trim()
    let metadataDynasty = ''
    let metadataDate = ''
    try {
      const metadata = JSON.parse(doc.metadata || '{}')
      metadataDynasty = String(metadata.dynasty || '')
      metadataDate = String(metadata.date || metadata.publication_year || '')
    } catch {
      metadataDynasty = ''
      metadataDate = ''
    }
    const haystack = `${doc.dynasty || ''} ${metadataDynasty} ${metadataDate}`
    if (!haystack.includes(expected)) return false
  }
  if (options.importStatus && doc.import_status !== options.importStatus) return false
  if (options.ocrStatus && doc.ocr_status !== options.ocrStatus) return false
  if (options.readStatus && doc.read_status !== options.readStatus) return false
  if (options.metadataStatus && doc.metadata_status !== options.metadataStatus) return false
  if (options.favoritesOnly && doc.is_favorite !== 1) return false

  if (options.folderId) {
    const folderIds = String(doc.folder_ids || '').split('|').filter(Boolean)
    const acceptedFolderIds = resolveSearchFolderScopeIds([options.folderId])
    if (!acceptedFolderIds.some((folderId) => folderIds.includes(folderId))) return false
  }

  if (Array.isArray(options.folderIds) && options.folderIds.length > 0) {
    const folderIds = String(doc.folder_ids || '').split('|').filter(Boolean)
    const acceptedFolderIds = resolveSearchFolderScopeIds(options.folderIds)
    if (!acceptedFolderIds.some((folderId) => folderIds.includes(folderId))) return false
  }

  if (options.tagId) {
    const tagIds = String(doc.tag_ids || '').split('|').filter(Boolean)
    if (!tagIds.includes(options.tagId)) return false
  }

  if (Array.isArray(options.tagIds) && options.tagIds.length > 0) {
    const tagIds = String(doc.tag_ids || '').split('|').filter(Boolean)
    if (!options.tagIds.every((tagId) => tagIds.includes(tagId))) return false
  }

  if (options.yearFrom || options.yearTo) {
    let publicationYear: number | null = null
    try {
      const metadata = JSON.parse(doc.metadata || '{}')
      const value = metadata.publication_year
      publicationYear = value ? Number(String(value).match(/\d{4}/)?.[0]) : null
    } catch {
      publicationYear = null
    }

    if (options.yearFrom && (!publicationYear || publicationYear < options.yearFrom)) return false
    if (options.yearTo && (!publicationYear || publicationYear > options.yearTo)) return false
  }

  return true
}

function resolveSearchFilterDocIds(options?: SearchOptions): string[] | undefined {
  if (!options) return undefined

  const explicitDocIds = uniqueIds(options.docIds || [])
  const tagIds = uniqueIds([
    ...(options.tagId ? [options.tagId] : []),
    ...(options.tagIds || [])
  ])
  const requestedFolderIds = uniqueIds([
    ...(options.folderId ? [options.folderId] : []),
    ...(options.folderIds || [])
  ])
  const folderIds = resolveSearchFolderScopeIds(requestedFolderIds)

  const needsResolution = explicitDocIds.length > 0
    || tagIds.length > 0
    || requestedFolderIds.length > 0
    || !!options.docType
    || !!options.author
    || !!options.dynasty
    || !!options.importStatus
    || !!options.ocrStatus
    || !!options.readStatus
    || !!options.metadataStatus
    || !!options.favoritesOnly
    || !!options.yearFrom
    || !!options.yearTo

  if (!needsResolution) return undefined

  const cacheKey = stableStringify({
    docType: options.docType || '',
    author: options.author || '',
    dynasty: options.dynasty || '',
    folderId: options.folderId || '',
    folderIds,
    tagId: options.tagId || '',
    tagIds,
    docIds: explicitDocIds,
    importStatus: options.importStatus || '',
    ocrStatus: options.ocrStatus || '',
    readStatus: options.readStatus || '',
    metadataStatus: options.metadataStatus || '',
    favoritesOnly: !!options.favoritesOnly,
    yearFrom: options.yearFrom || null,
    yearTo: options.yearTo || null,
  })
  const cached = getFreshSearchCacheEntry(searchFilterDocIdsCache, cacheKey, SEARCH_FILTER_CACHE_TTL_MS)
  if (cached) {
    return cached.docIds ? [...cached.docIds] : cached.docIds
  }

  let sql = 'SELECT DISTINCT d.id FROM documents d'
  const conditions: string[] = options.importStatus ? [] : [activeDocumentCondition('d')]
  const params: Array<string | number> = []

  if (tagIds.length > 0) {
    tagIds.forEach((tagId, index) => {
      const alias = `dt_scope_${index}`
      sql += ` INNER JOIN document_tags ${alias} ON d.id = ${alias}.doc_id AND ${alias}.tag_id = ?`
      params.push(tagId)
    })
  }

  if (requestedFolderIds.length > 0 && folderIds.length === 0) {
    setBoundedSearchCacheEntry(searchFilterDocIdsCache, cacheKey, { createdAt: Date.now(), docIds: [] }, 80, SEARCH_FILTER_CACHE_TTL_MS)
    return []
  }

  if (folderIds.length > 0) {
    sql += ' INNER JOIN document_folders df_scope ON d.id = df_scope.doc_id'
    conditions.push(`df_scope.folder_id IN (${buildInClause(folderIds)})`)
    params.push(...folderIds)
  }

  if (explicitDocIds.length > 0) {
    conditions.push(`d.id IN (${buildInClause(explicitDocIds)})`)
    params.push(...explicitDocIds)
  }
  if (options.docType) {
    conditions.push('d.doc_type = ?')
    params.push(options.docType)
  }
  if (options.author) {
    conditions.push('COALESCE(d.author, \'\') LIKE ?')
    params.push(`%${options.author}%`)
  }
  if (options.dynasty) {
    conditions.push(`(
      COALESCE(d.dynasty, '') LIKE ?
      OR COALESCE(CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.dynasty') ELSE '' END, '') LIKE ?
      OR COALESCE(CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.date') ELSE '' END, '') LIKE ?
    )`)
    params.push(`%${options.dynasty}%`, `%${options.dynasty}%`, `%${options.dynasty}%`)
  }
  if (options.importStatus) {
    conditions.push('d.import_status = ?')
    params.push(options.importStatus)
  }
  if (options.ocrStatus) {
    conditions.push('d.ocr_status = ?')
    params.push(options.ocrStatus)
  }
  if (options.readStatus) {
    conditions.push('d.read_status = ?')
    params.push(options.readStatus)
  }
  if (options.metadataStatus) {
    conditions.push('d.metadata_status = ?')
    params.push(options.metadataStatus)
  }
  if (options.favoritesOnly) {
    conditions.push('d.is_favorite = 1')
  }
  if (options.yearFrom) {
    conditions.push("CAST(CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.publication_year') ELSE NULL END AS INTEGER) >= ?")
    params.push(options.yearFrom)
  }
  if (options.yearTo) {
    conditions.push("CAST(CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.publication_year') ELSE NULL END AS INTEGER) <= ?")
    params.push(options.yearTo)
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`
  }

  const docIds = queryAll<{ id: string }>(sql, params).map((item) => item.id)
  setBoundedSearchCacheEntry(searchFilterDocIdsCache, cacheKey, { createdAt: Date.now(), docIds }, 80, SEARCH_FILTER_CACHE_TTL_MS)
  return [...docIds]
}

function loadDocumentMap(docIds: string[]): Map<string, SearchDocumentRow> {
  if (docIds.length === 0) return new Map()
  const placeholders = buildInClause(docIds)
  const docs = queryAll<SearchDocumentRow>(
    `SELECT d.*,
      (SELECT GROUP_CONCAT(t2.name, '|') FROM (SELECT DISTINCT t.name FROM document_tags dt2 INNER JOIN tags t ON dt2.tag_id = t.id WHERE dt2.doc_id = d.id ORDER BY t.usage_count DESC, t.name ASC) t2) as tag_names,
      (SELECT GROUP_CONCAT(t2.id, '|') FROM (SELECT DISTINCT t.id FROM document_tags dt2 INNER JOIN tags t ON dt2.tag_id = t.id WHERE dt2.doc_id = d.id ORDER BY t.usage_count DESC, t.name ASC) t2) as tag_ids,
      (SELECT GROUP_CONCAT(f2.id, '|') FROM (SELECT DISTINCT f.id FROM document_folders df2 INNER JOIN folders f ON df2.folder_id = f.id WHERE df2.doc_id = d.id ORDER BY f.sort_order ASC, f.name ASC) f2) as folder_ids,
      (SELECT GROUP_CONCAT(f2.name, '|') FROM (SELECT DISTINCT f.name FROM document_folders df2 INNER JOIN folders f ON df2.folder_id = f.id WHERE df2.doc_id = d.id ORDER BY f.sort_order ASC, f.name ASC) f2) as folder_names
    FROM documents d
    WHERE d.id IN (${placeholders})
      AND ${activeDocumentCondition('d')}`,
    docIds
  )
  return new Map(docs.map((doc) => [doc.id, doc]))
}

function buildSnippet(content: string, keyword: string): string {
  const text = content.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const lowerText = text.toLowerCase()
  const hit = findBestKeywordHit(text, keyword)
  if (!hit) return text.slice(0, 240)
  const index = lowerText.indexOf(hit.toLowerCase())
  if (index < 0) return text.slice(0, 240)
  const start = Math.max(0, index - 80)
  const end = Math.min(text.length, index + hit.length + 120)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

function buildMarkedSnippet(content: string, keyword: string): string {
  const snippet = buildSnippet(content, keyword)
  if (!snippet || !keyword.trim()) return snippet
  const lowerSnippet = snippet.toLowerCase()
  const hit = findBestKeywordHit(snippet, keyword)
  if (!hit) return snippet
  const lowerKeyword = hit.toLowerCase()
  const index = lowerSnippet.indexOf(lowerKeyword)
  if (index < 0) return snippet
  return `${snippet.slice(0, index)}<<${snippet.slice(index, index + hit.length)}>>${snippet.slice(index + hit.length)}`
}

function findKeywordOccurrences(content: string, keyword: string): Array<{ index: number; length: number; term: string }> {
  const text = normalizeWhitespace(content)
  const searchableText = normalizeSearchText(text)
  const lowerText = searchableText.toLowerCase()
  const terms = getKeywordTerms(keyword)
  if (!lowerText || terms.length === 0) return []

  const collect = (term: string) => {
    const lowerTerm = normalizeSearchText(term).toLowerCase()
    if (!lowerTerm) return []
    const hits: Array<{ index: number; length: number; term: string }> = []
    let index = lowerText.indexOf(lowerTerm)
    while (index >= 0) {
      hits.push({ index, length: lowerTerm.length, term: text.slice(index, index + lowerTerm.length) || term })
      index = lowerText.indexOf(lowerTerm, index + Math.max(1, lowerTerm.length))
    }
    return hits
  }

  const exactHits = collect(terms[0])
  const rawHits = exactHits.length > 0 ? exactHits : terms.slice(1).flatMap(collect)
  return rawHits
    .sort((left, right) => left.index - right.index || right.length - left.length)
    .filter((hit, index, hits) => index === 0 || hit.index >= hits[index - 1].index + hits[index - 1].length)
}

function buildMarkedSnippetForOccurrence(content: string, keyword: string, occurrenceIndex: number): string {
  const text = normalizeWhitespace(content)
  if (!text) return ''
  const occurrences = findKeywordOccurrences(text, keyword)
  const hit = occurrences[Math.max(0, Math.min(occurrenceIndex, occurrences.length - 1))]
  if (!hit) return buildMarkedSnippet(text, keyword)

  const start = Math.max(0, hit.index - 80)
  const end = Math.min(text.length, hit.index + hit.length + 120)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  const relativeIndex = hit.index - start
  const snippet = text.slice(start, end)
  return `${prefix}${snippet.slice(0, relativeIndex)}<<${snippet.slice(relativeIndex, relativeIndex + hit.length)}>>${snippet.slice(relativeIndex + hit.length)}${suffix}`
}

function getSnippetContextSize(mode?: SearchOptions['contextMode']): { before: number; after: number } {
  if (mode === 'short') return { before: 40, after: 70 }
  if (mode === 'long') return { before: 180, after: 260 }
  return { before: 80, after: 120 }
}

function buildMarkedSnippetFromHit(content: string, hit: { index: number; length: number }, contextMode?: SearchOptions['contextMode']): string {
  const text = String(content || '')
  const context = getSnippetContextSize(contextMode)
  const start = Math.max(0, hit.index - context.before)
  const end = Math.min(text.length, hit.index + hit.length + context.after)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  const relativeIndex = hit.index - start
  const snippet = text.slice(start, end)
  return `${prefix}${normalizeWhitespace(snippet.slice(0, relativeIndex))}<<${normalizeWhitespace(snippet.slice(relativeIndex, relativeIndex + hit.length))}>>${normalizeWhitespace(snippet.slice(relativeIndex + hit.length))}${suffix}`
}

function markSnippetByOriginalRange(snippet: string, relativeIndex: number, length: number): string {
  return `${normalizeWhitespace(snippet.slice(0, relativeIndex))}<<${normalizeWhitespace(snippet.slice(relativeIndex, relativeIndex + length))}>>${normalizeWhitespace(snippet.slice(relativeIndex + length))}`
}

function markSnippetByQueryTerm(snippet: string, queryTerm?: string): string | null {
  const term = normalizeSearchText(String(queryTerm || '').trim())
  if (!term) return null
  const normalized = normalizeSearchTextWithOffsetMap(snippet)
  const index = normalized.text.toLowerCase().indexOf(term.toLowerCase())
  if (index < 0) return null
  const start = normalized.offsets[Math.max(0, Math.min(index, normalized.offsets.length - 1))]
  const endOffset = normalized.offsets[Math.max(0, Math.min(index + term.length - 1, normalized.offsets.length - 1))]
  if (!Number.isFinite(start) || !Number.isFinite(endOffset)) return null
  return markSnippetByOriginalRange(snippet, start, Math.max(1, endOffset - start + 1))
}

function buildMarkedSnippetFromOriginalHit(content: string, hit: { index: number; length: number }, contextMode?: SearchOptions['contextMode'], queryTerm?: string): string {
  const text = String(content || '')
  const context = getSnippetContextSize(contextMode)
  const start = Math.max(0, hit.index - context.before)
  const end = Math.min(text.length, hit.index + hit.length + context.after)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  const relativeIndex = hit.index - start
  const snippet = text.slice(start, end)
  const queryMarked = markSnippetByQueryTerm(snippet, queryTerm)
  return `${prefix}${queryMarked || markSnippetByOriginalRange(snippet, relativeIndex, hit.length)}${suffix}`
}

function normalizePreviewSnippetKey(snippet: string): string {
  return normalizeWhitespace(String(snippet || '').replace(/<</g, '').replace(/>>/g, ''))
    .replace(/\s+/g, '')
    .slice(0, 160)
}

function getKeywordTerms(keyword: string): string[] {
  const trimmed = keyword.trim()
  if (!trimmed) return []
  const tokens = trimmed
    .split(/[\s,，。；;、|/\\()[\]{}"'“”‘’<>《》]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set([trimmed, normalizeSearchText(trimmed), ...tokens, ...tokens.map(normalizeSearchText)].filter(Boolean))]
    .sort((left, right) => right.length - left.length)
}

function findBestKeywordHit(content: string, keyword: string): string | null {
  const lowerText = normalizeSearchText(content).toLowerCase()
  const terms = getKeywordTerms(keyword)
  if (!lowerText || terms.length === 0) return null
  for (const term of terms) {
    if (lowerText.includes(normalizeSearchText(term).toLowerCase())) return term
  }
  return null
}

function shouldSupplementFtsWithScan(keyword: string, ftsRows: SearchHitRow[], limit: number): boolean {
  const terms = getKeywordTerms(keyword)
  if (terms.length === 0) return false
  const hasCjkTerm = terms.some((term) => /[\u3400-\u9fff]/.test(term))
  const hasShortTerm = terms.some((term) => term.length <= 2)
  if (ftsRows.length < Math.min(limit, 8)) return true
  if (!hasCjkTerm && !hasShortTerm) return false

  const distinctDocuments = new Set(ftsRows.map((row) => row.doc_id)).size
  const enoughRows = ftsRows.length >= Math.max(40, Math.min(limit * 2, 160))
  const enoughDocuments = distinctDocuments >= Math.min(12, Math.max(1, Math.floor(limit / 4)))
  return !(enoughRows || enoughDocuments)
}

function isTrigramSearchEligible(keyword: string): boolean {
  return SEARCH_TRIGRAM_FTS_ENABLED
    && isSearchTrigramFtsAvailable()
    && normalizeSearchText(keyword).replace(/\s+/g, '').length >= SEARCH_TRIGRAM_MIN_QUERY_LENGTH
}

function quoteFtsPhrase(term: string): string {
  const safe = term.trim().replace(/"/g, '""')
  return safe ? `"${safe}"` : ''
}

function getTrigramFtsTerms(keyword: string): string[] {
  const normalized = normalizeSearchText(keyword).trim()
  const expanded = getKeywordTerms(normalized)
    .flatMap((term) => {
      const searchTerm = normalizeSearchText(term).trim()
      const compactTerm = searchTerm.replace(/\s+/g, '')
      return [searchTerm, compactTerm, ...searchTerm.split(/\s+/)]
    })
    .map((term) => term.trim())
    .filter((term) => term.length >= SEARCH_TRIGRAM_MIN_QUERY_LENGTH)
  return [...new Set(expanded)].slice(0, 8)
}

function buildTrigramFtsQuery(keyword: string): string {
  return getTrigramFtsTerms(keyword).map(quoteFtsPhrase).filter(Boolean).join(' OR ')
}

function hasSearchSegmentsTrigramRows(docIds?: string[]): boolean {
  if (!isSearchTrigramFtsAvailable()) return false
  const uniqueDocIds = uniqueIds(docIds || [])
  if (uniqueDocIds.length === 0) {
    return !!queryOne<{ found?: number }>('SELECT 1 as found FROM search_segments_trigram LIMIT 1')?.found
  }
  for (const chunk of chunkValues(uniqueDocIds)) {
    const placeholders = buildInClause(chunk)
    const row = queryOne<{ found?: number }>(
      `SELECT 1 as found
       FROM search_index_segments s
       INNER JOIN search_segments_trigram tri ON tri.rowid = s.rowid
       WHERE s.doc_id IN (${placeholders})
       LIMIT 1`,
      chunk,
    )
    if (row?.found) return true
  }
  return false
}

function findSegmentDocIdsWithoutTrigram(docIds?: string[]): string[] {
  if (!isSearchTrigramFtsAvailable()) return []
  const activeDocIds = Array.isArray(docIds) && docIds.length > 0 ? resolveActiveDocumentIds(docIds) : undefined
  if (Array.isArray(docIds) && docIds.length > 0 && (!activeDocIds || activeDocIds.length === 0)) return []
  const cacheKey = stableStringify({ type: 'trigram-coverage', docIds: uniqueIds(activeDocIds || []) })
  const cached = getFreshSearchCacheEntry(trigramCoverageCache, cacheKey, SEARCH_FILTER_CACHE_TTL_MS)
  if (cached) {
    return [...cached.missingDocIds]
  }
  const rows = new Set<string>()

  const collectRows = (chunk?: string[]) => {
    const params: string[] = []
    let sql = `SELECT DISTINCT s.doc_id
      FROM search_index_segments s
      INNER JOIN documents d ON d.id = s.doc_id
      WHERE ${activeDocumentCondition('d')}
        AND TRIM(COALESCE(s.normalized_text, s.text, '')) <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM search_segments_trigram tri
          WHERE tri.rowid = s.rowid
          LIMIT 1
        )`
    if (chunk && chunk.length > 0) {
      sql += ` AND s.doc_id IN (${buildInClause(chunk)})`
      params.push(...chunk)
    }
    queryAll<{ doc_id: string }>(sql, params).forEach((row) => {
      if (row.doc_id) rows.add(row.doc_id)
    })
  }

  if (activeDocIds && activeDocIds.length > 0) {
    chunkValues(activeDocIds).forEach((chunk) => collectRows(chunk))
  } else {
    collectRows()
  }

  const missingDocIds = [...rows]
  setBoundedSearchCacheEntry(trigramCoverageCache, cacheKey, { createdAt: Date.now(), missingDocIds }, 40, SEARCH_FILTER_CACHE_TTL_MS)
  return missingDocIds
}

function rowKey(row: Pick<SearchSegmentRow, 'segment_id'>): string {
  return row.segment_id
}

function mergeSearchRows(primaryRows: SearchHitRow[], supplementalRows: SearchHitRow[]): SearchHitRow[] {
  const rowsBySegment = new Map<string, SearchHitRow>()
  for (const row of primaryRows) {
    rowsBySegment.set(rowKey(row), row)
  }
  for (const row of supplementalRows) {
    const key = rowKey(row)
    const existing = rowsBySegment.get(key)
    if (!existing) {
      rowsBySegment.set(key, row)
    } else if ((!existing.text && !existing.normalized_text) && (row.text || row.normalized_text)) {
      rowsBySegment.set(key, {
        ...existing,
        text: row.text,
        normalized_text: row.normalized_text,
        offset_map: row.offset_map,
        rank: Math.min(Number(existing.rank || 999), Number(row.rank || 999)),
      })
    }
  }
  return [...rowsBySegment.values()].sort((left, right) => (
    Number(left.rank || 0) - Number(right.rank || 0)
    || left.doc_id.localeCompare(right.doc_id)
    || (left.page_num || 0) - (right.page_num || 0)
    || left.ordinal - right.ordinal
  ))
}

function refineSnippetsAroundKeyword(rows: SearchRow[], keyword: string): SearchRow[] {
  const trimmed = keyword.trim()
  if (!trimmed || rows.length === 0) return rows
  const pageIds = rows.map((row) => row.page_id).filter(Boolean)
  if (pageIds.length === 0) return rows
  const placeholders = buildInClause(pageIds)
  const pageTexts = queryAll<{ id: string; content: string }>(
    `SELECT id, TRIM(COALESCE(proofed_text, '') || ' ' || COALESCE(ocr_text, '')) as content
     FROM pages
     WHERE id IN (${placeholders})`,
    pageIds,
  )
  const contentByPageId = new Map(pageTexts.map((item) => [item.id, item.content || '']))
  return rows.map((row) => {
    const content = contentByPageId.get(row.page_id) || ''
    if (!findBestKeywordHit(content, trimmed)) return row
    return {
      ...row,
      snippet: buildMarkedSnippet(content, trimmed),
    }
  })
}

function expandRowsByOccurrences(rows: SearchRow[], keyword: string, limit: number): SearchRow[] {
  if (rows.length === 0) return rows
  const pageIds = rows.map((row) => row.page_id).filter(Boolean)
  if (pageIds.length === 0) return rows
  const placeholders = buildInClause(pageIds)
  const pageTexts = queryAll<{ id: string; content: string }>(
    `SELECT id, TRIM(COALESCE(proofed_text, '') || ' ' || COALESCE(ocr_text, '')) as content
     FROM pages
     WHERE id IN (${placeholders})`,
    pageIds,
  )
  const contentByPageId = new Map(pageTexts.map((item) => [item.id, item.content || '']))
  const expanded: SearchRow[] = []

  for (const row of rows) {
    const content = contentByPageId.get(row.page_id) || ''
    const occurrences = findKeywordOccurrences(content, keyword)
    if (occurrences.length === 0) {
      expanded.push(row)
    } else {
      occurrences.forEach((_hit, occurrenceIndex) => {
        expanded.push({
          ...row,
          occurrence_index: occurrenceIndex,
          snippet: buildMarkedSnippetForOccurrence(content, keyword, occurrenceIndex),
          rank: row.rank + occurrenceIndex / 1000,
        })
      })
    }
    if (expanded.length >= limit) break
  }

  return expanded.slice(0, limit)
}

function runSegmentFtsSearch(keyword: string, limit: number, docIds?: string[]): SearchHitRow[] {
  const query = sanitizeFtsQuery(keyword)
  try {
    const activeDocIds = Array.isArray(docIds) && docIds.length > 0 ? resolveActiveDocumentIds(docIds) : undefined
    if (Array.isArray(docIds) && docIds.length > 0 && (!activeDocIds || activeDocIds.length === 0)) return []
    const params: Array<string | number> = [query]
    let sql = `SELECT s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title, s.ordinal, s.source_start, s.text, s.normalized_text, s.offset_map,
        bm25(search_segments_fts) as rank
      FROM search_segments_fts
      INNER JOIN search_index_segments s ON s.rowid = search_segments_fts.rowid
      INNER JOIN documents d ON d.id = s.doc_id
      WHERE search_segments_fts MATCH ?
        AND ${activeDocumentCondition('d')}`

    if (activeDocIds && activeDocIds.length > 0) {
      sql += ` AND s.doc_id IN (${buildInClause(activeDocIds)})`
      params.push(...activeDocIds)
    }

    sql += ' ORDER BY rank ASC LIMIT ?'
    params.push(Math.max(limit * 2, 80))
    return queryAll<SearchHitRow>(sql, params)
  } catch (error) {
    console.warn('[Search] segment FTS query failed, falling back to segment scan', error)
    return []
  }
}

function runSegmentTrigramSearch(keyword: string, docIds?: string[]): SearchHitRow[] {
  if (!isTrigramSearchEligible(keyword)) return []
  const query = buildTrigramFtsQuery(keyword)
  if (!query) return []
  try {
    const activeDocIds = Array.isArray(docIds) && docIds.length > 0 ? resolveActiveDocumentIds(docIds) : undefined
    if (Array.isArray(docIds) && docIds.length > 0 && (!activeDocIds || activeDocIds.length === 0)) return []
    const params: Array<string | number> = [query]
    let sql = `SELECT s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title, s.ordinal, s.source_start, s.text, s.normalized_text, s.offset_map,
        bm25(search_segments_trigram) as rank
      FROM search_segments_trigram
      INNER JOIN search_index_segments s ON s.rowid = search_segments_trigram.rowid
      INNER JOIN documents d ON d.id = s.doc_id
      WHERE search_segments_trigram MATCH ?
        AND ${activeDocumentCondition('d')}`

    if (activeDocIds && activeDocIds.length > 0) {
      sql += ` AND s.doc_id IN (${buildInClause(activeDocIds)})`
      params.push(...activeDocIds)
    }

    sql += ' ORDER BY rank ASC, s.doc_id ASC, COALESCE(s.page_num, 0) ASC, s.ordinal ASC'
    return queryAll<SearchHitRow>(sql, params)
  } catch (error) {
    console.warn('[Search] segment trigram FTS query failed, falling back to verified scan', error)
    return []
  }
}

function runSegmentScanSearch(keyword: string, limit: number, docIds?: string[]): SearchHitRow[] {
  const activeDocIds = Array.isArray(docIds) && docIds.length > 0 ? resolveActiveDocumentIds(docIds) : undefined
  if (Array.isArray(docIds) && docIds.length > 0 && (!activeDocIds || activeDocIds.length === 0)) return []
  const params: Array<string | number> = []
  const terms = getKeywordTerms(keyword).map((term) => term.toLowerCase()).slice(0, 12)
  if (terms.length === 0) return []

  let sql = `SELECT s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title, s.ordinal, s.source_start, s.text, s.normalized_text, s.offset_map, 999 as rank
    FROM search_index_segments s
    INNER JOIN documents d ON d.id = s.doc_id
    WHERE ${activeDocumentCondition('d')}
      AND TRIM(COALESCE(s.normalized_text, s.text, '')) != ''`
  if (activeDocIds && activeDocIds.length > 0) {
    sql += ` AND s.doc_id IN (${buildInClause(activeDocIds)})`
    params.push(...activeDocIds)
  }

  sql += ` AND (${terms.map(() => `(
    LOWER(COALESCE(s.title, '')) LIKE ?
    OR LOWER(COALESCE(s.normalized_text, s.text, '')) LIKE ?
  )`).join(' OR ')})`
  terms.forEach((term) => {
    const pattern = `%${term}%`
    params.push(pattern, pattern)
  })

  sql += ' ORDER BY s.doc_id ASC, COALESCE(s.page_num, 0) ASC, s.ordinal ASC'
  const normalizedKeyword = normalizeSearchText(keyword).trim()
  if (SEARCH_NGRAM_INDEX_ENABLED && normalizedKeyword.length > 3) {
    sql += ' LIMIT ?'
    params.push(Math.max(limit * 8, 800))
  }
  return queryAll<SearchHitRow>(sql, params)
}

function runSegmentTargetedScanSearch(keyword: string, limit: number, docIds: string[], capResults = true): SearchHitRow[] {
  const uniqueDocIds = uniqueIds(docIds)
  if (uniqueDocIds.length === 0) return []
  const chunks = chunkValues(uniqueDocIds)
  const perChunkLimit = Math.max(limit * 4, 200)
  const maxRows = Math.max(limit * 8, 800)
  const rows: SearchHitRow[] = []
  for (const chunk of chunks) {
    rows.push(...runSegmentScanSearch(keyword, perChunkLimit, chunk))
    if (capResults && rows.length >= maxRows) break
  }
  return capResults ? rows.slice(0, maxRows) : rows
}

function findLegacySegmentDocIdsWithoutNgrams(docIds?: string[], limit = SEARCH_LEGACY_SEGMENT_SCAN_DOC_LIMIT): string[] {
  const maxDocs = Math.max(0, Math.floor(limit))
  if (maxDocs <= 0) return []
  const activeDocIds = Array.isArray(docIds) && docIds.length > 0 ? resolveActiveDocumentIds(docIds) : undefined
  if (Array.isArray(docIds) && docIds.length > 0 && (!activeDocIds || activeDocIds.length === 0)) return []

  const rows: string[] = []
  const collectRows = (chunk?: string[]) => {
    const params: Array<string | number> = []
    let sql = `SELECT DISTINCT s.doc_id
      FROM search_index_segments s
      INNER JOIN documents d ON d.id = s.doc_id
      WHERE ${activeDocumentCondition('d')}
        AND TRIM(COALESCE(s.normalized_text, s.text, '')) <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM search_ngram_index ngi
          WHERE ngi.doc_id = s.doc_id
          LIMIT 1
        )`
    if (chunk && chunk.length > 0) {
      sql += ` AND s.doc_id IN (${buildInClause(chunk)})`
      params.push(...chunk)
    }
    sql += ' ORDER BY s.doc_id ASC LIMIT ?'
    params.push(maxDocs - rows.length)
    rows.push(...queryAll<{ doc_id: string }>(sql, params).map((row) => row.doc_id).filter(Boolean))
  }

  if (activeDocIds && activeDocIds.length > 0) {
    for (const chunk of chunkValues(activeDocIds)) {
      collectRows(chunk)
      if (rows.length >= maxDocs) break
    }
  } else {
    collectRows()
  }
  return uniqueIds(rows).slice(0, maxDocs)
}

function runSegmentExactPhraseSearch(keyword: string, docIds?: string[]): SearchHitRow[] {
  const query = normalizeSearchText(keyword).trim().toLowerCase()
  if (!query) return []
  const activeDocIds = Array.isArray(docIds) && docIds.length > 0 ? resolveActiveDocumentIds(docIds) : undefined
  if (Array.isArray(docIds) && docIds.length > 0 && (!activeDocIds || activeDocIds.length === 0)) return []
  const rows: SearchHitRow[] = []
  const scanChunk = (chunk?: string[]) => {
    const params: Array<string | number> = [`%${query}%`]
    let sql = `SELECT s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title, s.ordinal, s.source_start, s.text, s.normalized_text, s.offset_map, 50 as rank
      FROM search_index_segments s
      INNER JOIN documents d ON d.id = s.doc_id
      WHERE ${activeDocumentCondition('d')}
        AND TRIM(COALESCE(s.normalized_text, s.text, '')) != ''
        AND LOWER(COALESCE(s.normalized_text, s.text, '')) LIKE ?`
    if (chunk && chunk.length > 0) {
      sql += ` AND s.doc_id IN (${buildInClause(chunk)})`
      params.push(...chunk)
    }
    sql += ' ORDER BY s.doc_id ASC, COALESCE(s.page_num, 0) ASC, s.ordinal ASC'
    rows.push(...queryAll<SearchHitRow>(sql, params))
  }

  const uniqueDocIds = uniqueIds(activeDocIds || [])
  if (uniqueDocIds.length > 0) {
    chunkValues(uniqueDocIds).forEach((chunk) => scanChunk(chunk))
  } else {
    scanChunk()
  }
  return rows
}

function loadPageFallbackRowsForDocuments(docIds: string[], keyword?: string, maxDocs = SEARCH_SCOPED_FALLBACK_MAX_DOCS): SearchHitRow[] {
  if (docIds.length === 0) return []
  const uniqueDocIds = resolveActiveDocumentIds(docIds).slice(0, Math.max(0, maxDocs))
  if (uniqueDocIds.length === 0) return []
  const rows: SearchHitRow[] = []
  const query = normalizeSearchText(keyword || '').trim()
  for (const chunk of chunkValues(uniqueDocIds)) {
    const placeholders = buildInClause(chunk)
    const params: Array<string | number> = [...chunk]
    let sql = `SELECT
         p.id,
         p.doc_id,
         p.page_num,
         p.proofed_text,
         p.proofed_text_ref,
         p.ocr_text,
         p.ocr_text_ref,
         NULL as ocr_result,
         p.ocr_result_ref,
         CASE WHEN (p.ocr_result IS NOT NULL AND p.ocr_result <> '') OR COALESCE(p.ocr_result_ref, '') <> '' THEN 1 ELSE 0 END as has_ocr_result,
         d.doc_type,
         d.title,
         d.file_path,
         COALESCE(NULLIF(p.proofed_text, ''), NULLIF(p.ocr_text, ''), '') as text
       FROM pages p
       INNER JOIN documents d ON d.id = p.doc_id
       WHERE p.doc_id IN (${placeholders})
         AND ${activeDocumentCondition('d')}
         AND (
           TRIM(COALESCE(NULLIF(p.proofed_text, ''), NULLIF(p.ocr_text, ''), '')) <> ''
           OR (p.ocr_result IS NOT NULL AND p.ocr_result <> '')
           OR COALESCE(p.proofed_text_ref, p.ocr_text_ref, p.ocr_result_ref, '') <> ''
         )`
    sql += ' ORDER BY p.doc_id ASC, p.page_num ASC'
    queryAll<SearchPageRow>(sql, params).forEach((page, index) => {
      const text = getIndexablePageText(page) || String(page.text || '')
      const normalized = normalizeSearchTextWithOffsetMap(text)
      if (query && findKeywordOccurrences(normalized.text || text, query).length === 0) return
      rows.push({
        segment_id: `${page.doc_id}:page-fallback:${page.id || index}`,
        doc_id: page.doc_id,
        page_id: page.id,
        page_num: Number(page.page_num || index + 1),
        source_kind: 'page',
        href: null,
        title: `第 ${page.page_num || index + 1} 页`,
        ordinal: Number(page.page_num || index + 1),
        source_start: 0,
        text,
        normalized_text: normalized.text,
        offset_map: JSON.stringify(normalized.offsets),
        rank: 2000,
      })
    })
  }
  return rows
}

function runSegmentNgramSearch(keyword: string, limit: number, docIds?: string[], exhaustive = false, includeText = true): SearchHitRow[] {
  const query = normalizeSearchText(keyword).trim()
  const grams = chooseQueryNgramCandidates(query)
  if (!query || grams.length === 0) return []
  const previewShortQuery = !exhaustive && query.length <= 3
  const cacheKey = stableStringify({
    type: 'ngram',
    grams,
    query,
    limit,
    docIds: uniqueIds(docIds || []),
    exhaustive,
    includeText,
    previewShortQuery,
  })
  const cached = getFreshSearchCacheEntry(postingRowsCache, cacheKey, POSTING_CACHE_TTL_MS)
  if (cached) {
    return cached.rows.map((row) => ({ ...row }))
  }

  const params: Array<string | number> = []
  const textSelect = includeText ? 's.text, s.normalized_text, s.offset_map' : "'' as text, '' as normalized_text, '' as offset_map"
  if (previewShortQuery) {
    const rows: SearchHitRow[] = []
    const totalHitsByDocId = new Map<string, number>()
    const seenSegments = new Set<string>()
    const scanParams: Array<string | number> = [...grams]
    let scanFilter = ''
    if (Array.isArray(docIds) && docIds.length > 0) {
      scanFilter = ` AND ngi.doc_id IN (${buildInClause(docIds)})`
      scanParams.push(...docIds)
    }
    const totalRows = queryAll<{ doc_id: string; total_hits: number }>(
      `SELECT doc_id, SUM(hit_count) as total_hits
       FROM search_ngram_index ngi
       WHERE ngi.gram IN (${buildInClause(grams)})${scanFilter}
       GROUP BY doc_id
       ORDER BY total_hits DESC, doc_id ASC`,
      scanParams,
    )
    totalRows.forEach((row) => totalHitsByDocId.set(row.doc_id, Number(row.total_hits || 0)))
    const candidateDocIds = totalRows.map((row) => row.doc_id).filter(Boolean)
    if (candidateDocIds.length === 0) return []
    for (const candidateChunk of chunkValues(candidateDocIds)) {
      const candidateRows = queryAll<SearchNgramCandidateRow>(
        `SELECT s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title, s.ordinal, s.source_start, ${textSelect},
           GROUP_CONCAT(ngi.positions, '|') as positions, SUM(ngi.hit_count) as hit_count, (1000000.0 / MAX(1, SUM(ngi.hit_count))) as rank
         FROM search_ngram_index ngi
         INNER JOIN search_index_segments s ON s.segment_id = ngi.segment_id
         WHERE ngi.gram IN (${buildInClause(grams)}) AND ngi.doc_id IN (${buildInClause(candidateChunk)})
         GROUP BY s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title, s.ordinal, s.source_start
         ORDER BY ngi.doc_id ASC, COALESCE(s.page_num, 0) ASC, s.ordinal ASC`,
        [...grams, ...candidateChunk],
      )
      candidateRows.forEach((row) => {
        if (seenSegments.has(row.segment_id)) return
        const existingForDoc = rows.filter((item) => item.doc_id === row.doc_id).length
        if (existingForDoc >= SHORT_QUERY_PREVIEW_SEGMENTS_PER_DOC) return
        seenSegments.add(row.segment_id)
        rows.push({
          segment_id: row.segment_id,
          doc_id: row.doc_id,
          page_id: row.page_id,
          page_num: row.page_num,
          source_kind: row.source_kind,
          href: row.href,
          title: row.title,
          ordinal: row.ordinal,
          source_start: row.source_start,
          text: row.text,
          normalized_text: row.normalized_text,
          offset_map: row.offset_map,
          positions: row.positions,
          hit_count: row.hit_count,
          rank: Number(row.rank || 1000),
        })
      })
    }
    if (rows.length === 0) return []
    rows.forEach((row) => {
      row.doc_total_hits = totalHitsByDocId.get(row.doc_id) || row.hit_count || 0
    })
    setBoundedSearchCacheEntry(postingRowsCache, cacheKey, { createdAt: Date.now(), rows }, 80, POSTING_CACHE_TTL_MS)
    return rows.map((row) => ({ ...row }))
  }

  let sql = `SELECT s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title, s.ordinal, s.source_start, ${textSelect},
      GROUP_CONCAT(ngi.positions, '|') as positions, SUM(ngi.hit_count) as hit_count, (1000000.0 / MAX(1, SUM(ngi.hit_count))) as rank
    FROM search_ngram_index ngi
    INNER JOIN search_index_segments s ON s.segment_id = ngi.segment_id
    WHERE ngi.gram IN (${buildInClause(grams)})`
  params.push(...grams)

  if (Array.isArray(docIds) && docIds.length > 0) {
    sql += ` AND s.doc_id IN (${buildInClause(docIds)})`
    params.push(...docIds)
  }

  sql += ' GROUP BY s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title, s.ordinal, s.source_start'
  sql += ' ORDER BY hit_count ASC, s.doc_id ASC, COALESCE(s.page_num, 0) ASC, s.ordinal ASC'
  const shouldLimitCandidates = !exhaustive && query.length > 3
  if (shouldLimitCandidates) {
    sql += ' LIMIT ?'
    params.push(Math.max(limit * 12, 1200))
  }

  const rows = queryAll<SearchNgramCandidateRow>(sql, params)
  const mapped = rows.map((row) => ({
    segment_id: row.segment_id,
    doc_id: row.doc_id,
    page_id: row.page_id,
    page_num: row.page_num,
    source_kind: row.source_kind,
    href: row.href,
    title: row.title,
    ordinal: row.ordinal,
    source_start: row.source_start,
    text: row.text,
    normalized_text: row.normalized_text,
    offset_map: row.offset_map,
    positions: row.positions,
    hit_count: row.hit_count,
    rank: Number(row.rank || 1000),
  }))
  setBoundedSearchCacheEntry(postingRowsCache, cacheKey, { createdAt: Date.now(), rows: mapped }, 80, POSTING_CACHE_TTL_MS)
  return mapped.map((row) => ({ ...row }))
}

function createSearchHit(
  row: SearchSegmentRow,
  hit: { index: number; length: number; term: string; originalIndex?: number; originalLength?: number },
  occurrenceIndex: number,
  rank: number,
  contextMode?: SearchOptions['contextMode'],
  queryTerm?: string,
  snippetText?: string,
): SearchHit {
  const pageNum = row.page_num ? Number(row.page_num) : null
  const ordinal = Number(row.ordinal)
  const pageIndex = Number.isFinite(ordinal) && !String(row.segment_id || '').includes(':page-fallback:')
    ? Math.max(0, Math.floor(ordinal / 1000))
    : null
  const hasOriginalRange = Number.isFinite(Number(hit.originalIndex)) && Number.isFinite(Number(hit.originalLength))
  const originalRange = hasOriginalRange
    ? {
      start: Math.max(0, Number(hit.originalIndex)),
      end: Math.max(1, Number(hit.originalIndex) + Math.max(1, Number(hit.originalLength))),
    }
    : normalizedRangeToOriginal(row, hit)
  const sourceStart = getSegmentSourceStart(row)
  const locator: SearchHitLocator = {
    docId: row.doc_id,
    segmentId: row.segment_id,
    sourceType: row.source_kind || 'page',
    blockId: row.source_kind === 'translation' ? row.segment_id.split(':')[2] || null : null,
    translationUnitId: row.source_kind === 'translation' ? row.segment_id.split(':')[1] || null : null,
    translationSource: row.source_kind === 'translation',
    pageId: row.page_id || null,
    pageNum,
    pageIndex,
    href: row.href || null,
    segmentOrdinal: Number(row.ordinal || 0),
    charStart: sourceStart + originalRange.start,
    charEnd: sourceStart + originalRange.end,
    normalizedCharStart: hit.index,
    normalizedCharEnd: hit.index + hit.length,
    matchText: hit.term,
    queryTerm: queryTerm || hit.term,
    occurrenceIndex,
  }
  return {
    id: `${row.segment_id}:${occurrenceIndex}:${hit.index}`,
    locator,
    snippet: buildMarkedSnippetFromOriginalHit(
      snippetText || row.text || row.normalized_text || '',
      { index: originalRange.start, length: Math.max(1, originalRange.end - originalRange.start) },
      contextMode,
      queryTerm || hit.term,
    ),
    score: Number.isFinite(rank) ? Number(rank) : 999,
  }
}

function buildHitsFromRows(rows: SearchHitRow[], keyword: string, limit: number, options?: SearchOptions): SearchHit[] {
  const hits: SearchHit[] = []
  const queryTerm = keyword.trim()
  const sessionLimit = options?.resultMode === 'all' ? MAX_DOCUMENT_SEARCH_SESSION_HITS : 1200
  const hardLimit = Math.max(1, Math.min(limit, sessionLimit))
  for (const row of hydrateSearchRowsText(rows).filter((item) => (
    options?.translationScope === 'translation'
      ? item.source_kind === 'translation'
      : options?.translationScope === 'source'
        ? item.source_kind !== 'translation'
        : true
  ))) {
    const sourceText = row.text || row.normalized_text || ''
    const occurrences = buildOccurrencesForRow(row, keyword)
    for (let occurrenceIndex = 0; occurrenceIndex < occurrences.length; occurrenceIndex += 1) {
      if (hits.length >= hardLimit) return hits
      const hit = occurrences[occurrenceIndex]
      const originalIndex = Number.isFinite(Number(hit.originalIndex)) ? Number(hit.originalIndex) : hit.index
      const originalLength = Number.isFinite(Number(hit.originalLength)) ? Number(hit.originalLength) : hit.length
      const sourceTerm = sourceText.slice(originalIndex, originalIndex + originalLength) || hit.term
      hits.push(createSearchHit(
        row,
        { index: hit.index, length: hit.length, term: sourceTerm, originalIndex, originalLength },
        occurrenceIndex,
        Number(row.rank || 0) + occurrenceIndex / 1000,
        options?.contextMode,
        queryTerm,
        sourceText,
      ))
    }
    if (hits.length >= hardLimit) return hits
  }
  return hits
}

function parseNgramPositions(value?: string): number[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0)
      : []
  } catch {
    return []
  }
}

function shouldHydrateSearchRowText(row: SearchHitRow): boolean {
  if (!row.page_id) return !row.text && !row.normalized_text
  if (!row.text && !row.normalized_text) return true
  if (!row.offset_map) return true
  return Boolean(row.normalized_text && row.text && row.text.length + 16 < row.normalized_text.length)
}

function hydrateSearchRowsText(rows: SearchHitRow[]): SearchHitRow[] {
  const rowsNeedingHydration = rows.filter(shouldHydrateSearchRowText)
  if (rowsNeedingHydration.length === 0) return rows

  const wantedSegmentIds = new Set(rowsNeedingHydration.map((row) => row.segment_id))
  const textBySegmentId = new Map<string, { text: string; normalized_text: string; offset_map?: string | null }>()
  const docIds = [...new Set(rowsNeedingHydration.map((row) => row.doc_id).filter(Boolean))]

  for (const docId of docIds) {
    for (const segment of loadPageSegmentsForDocument(docId)) {
      if (!wantedSegmentIds.has(segment.segment_id)) continue
      textBySegmentId.set(segment.segment_id, {
        text: segment.text || '',
        normalized_text: segment.normalized_text || '',
        offset_map: segment.offset_map || '',
      })
    }
  }

  const stillMissingSegmentIds = [...wantedSegmentIds].filter((segmentId) => !textBySegmentId.has(segmentId))
  for (const chunk of chunkValues(stillMissingSegmentIds)) {
    const placeholders = buildInClause(chunk)
    queryAll<{ segment_id: string; text: string; normalized_text: string; offset_map?: string | null }>(
      `SELECT segment_id, text, normalized_text, offset_map FROM search_index_segments WHERE segment_id IN (${placeholders})`,
      chunk,
    ).forEach((item) => {
      textBySegmentId.set(item.segment_id, {
        text: item.text || '',
        normalized_text: item.normalized_text || '',
        offset_map: item.offset_map || '',
      })
    })
  }

  return rows.map((row) => {
    const text = textBySegmentId.get(row.segment_id)
    return text
      ? { ...row, text: text.text, normalized_text: text.normalized_text, offset_map: text.offset_map || '' }
      : row
  })
}

function buildTranslationSearchIndexSegmentDrafts(docId: string): SearchIndexSegmentDraft[] {
  const rows = queryAll<{
    page_id: string
    page_num: number
    unit_id: string
    block_id: string
    unit_order: number
    translation_text: string
  }>(
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

function buildOccurrencesForRow(row: SearchHitRow, keyword: string): Array<{ index: number; length: number; term: string; originalIndex?: number; originalLength?: number }> {
  const sourceText = row.text || row.normalized_text || ''
  const normalizedKeyword = normalizeSearchText(keyword).trim()
  if (row.positions && normalizedKeyword && normalizedKeyword.length <= 3) {
    const positions = parseNgramPositions(row.positions)
    if (positions.length > 0) {
      return positions.map((index) => {
        const range = normalizedRangeToOriginal(row, { index, length: normalizedKeyword.length })
        return {
          index,
          length: normalizedKeyword.length,
          originalIndex: range.start,
          originalLength: Math.max(1, range.end - range.start),
          term: sourceText.slice(range.start, range.end) || normalizedKeyword,
        }
      })
    }
  }
  return findKeywordOccurrences(row.normalized_text || normalizeSearchText(sourceText), keyword).map((hit) => {
    const range = normalizedRangeToOriginal(row, hit)
    return {
      ...hit,
      originalIndex: range.start,
      originalLength: Math.max(1, range.end - range.start),
      term: sourceText.slice(range.start, range.end) || hit.term,
    }
  })
}

function groupRowsByOccurrences(rows: SearchHitRow[], keyword: string, options?: SearchOptions, warnings: string[] = []): SearchGroupedResponse {
  rows = rows.filter((item) => (
    options?.translationScope === 'translation'
      ? item.source_kind === 'translation'
      : options?.translationScope === 'source'
        ? item.source_kind !== 'translation'
        : true
  ))
  const docMap = loadDocumentMap([...new Set(rows.map((row) => row.doc_id))])
  const grouped = new Map<string, SearchDocumentGroup>()
  const resultMode = options?.resultMode || 'preview'
  const shouldPage = resultMode !== 'all'
  const requestedPageSize = Math.floor(Number(options?.pageSize || 10))
  const requestedPage = Math.floor(Number(options?.page || 1))
  const pageSize = shouldPage
    ? Math.max(1, Math.min(100, Number.isFinite(requestedPageSize) ? requestedPageSize : 10))
    : 0
  const page = shouldPage
    ? Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1)
    : 1
  const queryTerm = keyword.trim()
  const rowTextBySegmentId = new Map<string, SearchHitRow>()
  const previewSnippetKeysByDocId = new Map<string, Set<string>>()
  const previewSourceKeysByDocId = new Map<string, Set<string>>()
  const countedDocTotals = new Set<string>()
  const sortedRows = [...rows].sort((left, right) => (
    left.doc_id.localeCompare(right.doc_id)
    || (left.page_num || 0) - (right.page_num || 0)
    || left.ordinal - right.ordinal
  ))
  const previewRowIds = new Set<string>()
  const previewHitCounts = new Map<string, number>()

  sortedRows
    .forEach((row) => {
      const doc = docMap.get(row.doc_id)
      if (!doc || !matchesDocumentFilters(doc, options)) return
      const occurrences = buildOccurrencesForRow(row, keyword)
      if (occurrences.length === 0) return

      const existing = grouped.get(row.doc_id)
      const group: SearchDocumentGroup = existing || {
        docId: row.doc_id,
        title: doc.title || '未命名文献',
        author: doc.author || null,
        docType: doc.doc_type || '',
        readStatus: normalizeReadStatus(doc.read_status),
        isFavorite: doc.is_favorite ?? undefined,
        metadataStatus: normalizeMetadataStatus(doc.metadata_status),
        tagNames: String(doc.tag_names || '').split('|').filter(Boolean),
        folderNames: String(doc.folder_names || '').split('|').filter(Boolean),
        totalHits: 0,
        topHits: [] as SearchHit[],
        hits: [] as SearchHit[],
        score: 0,
        updatedAt: doc.updated_at ?? undefined,
        lastOpenedAt: doc.last_opened_at || null,
      }

      const rowDocTotal = Number(row.doc_total_hits || 0)
      if (rowDocTotal > 0) {
        if (!countedDocTotals.has(row.doc_id)) {
          group.totalHits += rowDocTotal
          countedDocTotals.add(row.doc_id)
        }
      } else {
        group.totalHits += occurrences.length
      }
      group.score += Math.max(0.1, 1000 - Number(row.rank || 0)) + occurrences.length

      grouped.set(row.doc_id, group)
    })

  const allGroups = [...grouped.values()]
    .sort((left, right) => compareSearchGroups(left, right, options?.sort))
  const totalDocuments = allGroups.length
  const totalHits = allGroups.reduce((sum, group) => sum + group.totalHits, 0)
  const totalPages = shouldPage ? Math.max(1, Math.ceil(totalDocuments / pageSize)) : 1
  const safePage = shouldPage ? Math.min(page, totalPages) : 1
  const pageStart = shouldPage ? (safePage - 1) * pageSize : 0
  const pageEnd = shouldPage ? pageStart + pageSize : Number.POSITIVE_INFINITY
  const pageDocIds = new Set(
    shouldPage
      ? allGroups.slice(pageStart, pageEnd).map((group) => group.docId)
      : allGroups.map((group) => group.docId),
  )

  sortedRows
    .forEach((row) => {
      if (!pageDocIds.has(row.doc_id)) return
      const occurrences = buildOccurrencesForRow(row, keyword)
      if (occurrences.length === 0) return
      const previewCandidateLimit = MAX_PREVIEW_HITS_PER_DOC * 3
      if (resultMode === 'all' || (previewHitCounts.get(row.doc_id) || 0) < previewCandidateLimit) {
        previewRowIds.add(row.segment_id)
        previewHitCounts.set(
          row.doc_id,
          Math.min(previewCandidateLimit, (previewHitCounts.get(row.doc_id) || 0) + occurrences.length),
        )
      }
    })

  hydrateSearchRowsText(resultMode === 'all' ? sortedRows : sortedRows.filter((row) => pageDocIds.has(row.doc_id) && previewRowIds.has(row.segment_id)))
    .forEach((row) => rowTextBySegmentId.set(row.segment_id, row))

  sortedRows
    .forEach((row) => {
      if (!pageDocIds.has(row.doc_id)) return
      const group = grouped.get(row.doc_id)
      if (!group) return
      if (resultMode !== 'all' && group.hits.length >= MAX_PREVIEW_HITS_PER_DOC) return
      const hydratedRow = rowTextBySegmentId.get(row.segment_id)
      if (!hydratedRow) return
      const occurrences = buildOccurrencesForRow(hydratedRow, keyword)
      if (occurrences.length === 0) return
        const sourceText = hydratedRow.text || hydratedRow.normalized_text || ''
        for (let index = 0; index < occurrences.length; index += 1) {
          if (resultMode !== 'all' && group.hits.length >= MAX_PREVIEW_HITS_PER_DOC) break
          const occurrence = occurrences[index]
          const originalIndex = Number.isFinite(Number(occurrence.originalIndex)) ? Number(occurrence.originalIndex) : occurrence.index
          const originalLength = Number.isFinite(Number(occurrence.originalLength)) ? Number(occurrence.originalLength) : occurrence.length
          const sourceTerm = sourceText.slice(originalIndex, originalIndex + originalLength) || occurrence.term
          const nextHit = createSearchHit(
            hydratedRow,
            { index: occurrence.index, length: occurrence.length, term: sourceTerm, originalIndex, originalLength },
            index,
            Number(row.rank || 0) + index / 1000,
            options?.contextMode,
            queryTerm,
            sourceText,
          )
          if (resultMode !== 'all') {
            const sourceKey = `${hydratedRow.page_id || hydratedRow.page_num || ''}:${hydratedRow.segment_id}`
            const existingSourceKeys = previewSourceKeysByDocId.get(row.doc_id) || new Set<string>()
            if (existingSourceKeys.has(sourceKey)) break
            existingSourceKeys.add(sourceKey)
            previewSourceKeysByDocId.set(row.doc_id, existingSourceKeys)
            const previewKey = `${hydratedRow.page_id || hydratedRow.segment_id}:${normalizePreviewSnippetKey(nextHit.snippet)}`
            const existingKeys = previewSnippetKeysByDocId.get(row.doc_id) || new Set<string>()
            if (existingKeys.has(previewKey)) continue
            existingKeys.add(previewKey)
            previewSnippetKeysByDocId.set(row.doc_id, existingKeys)
          }
          group.hits.push(nextHit)
        }
        group.topHits = group.hits.slice(0, 3)
    })

  const groups = allGroups.filter((group) => pageDocIds.has(group.docId))

  return {
    query: '',
    totalDocuments,
    totalHits,
    groups,
    warnings,
    status: 'complete',
    page: safePage,
    pageSize: shouldPage ? pageSize : totalDocuments,
    totalPages,
  }
}

function compareSearchGroups(left: SearchDocumentGroup, right: SearchDocumentGroup, sort: SearchOptions['sort'] = 'relevance'): number {
  const byRelevance = right.score - left.score || right.totalHits - left.totalHits
  const byHitCount = right.totalHits - left.totalHits || right.score - left.score
  const byTitle = left.title.localeCompare(right.title, 'zh-Hans-CN')
  if (sort === 'hitCount') return byHitCount || byTitle
  if (sort === 'updated') {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0
    return rightTime - leftTime || byRelevance || byTitle
  }
  if (sort === 'lastOpened') {
    const leftTime = left.lastOpenedAt ? Date.parse(left.lastOpenedAt) : 0
    const rightTime = right.lastOpenedAt ? Date.parse(right.lastOpenedAt) : 0
    return rightTime - leftTime || byRelevance || byTitle
  }
  if (sort === 'title') return byTitle || byRelevance
  return byRelevance || byTitle
}

function groupHits(hits: SearchHit[], options?: SearchOptions, warnings: string[] = []): SearchGroupedResponse {
  const docIds = [...new Set(hits.map((hit) => hit.locator.docId))]
  const docMap = loadDocumentMap(docIds)
  const grouped = new Map<string, SearchDocumentGroup>()
  const resultMode = options?.resultMode || 'preview'

  hits
    .sort((left, right) => (
      left.locator.docId.localeCompare(right.locator.docId)
      || (left.locator.pageNum || 0) - (right.locator.pageNum || 0)
      || left.locator.segmentOrdinal - right.locator.segmentOrdinal
      || left.locator.charStart - right.locator.charStart
    ))
    .forEach((hit) => {
      const doc = docMap.get(hit.locator.docId)
      if (!doc || !matchesDocumentFilters(doc, options)) return
      const existing = grouped.get(hit.locator.docId)
      const group: SearchDocumentGroup = existing || {
        docId: hit.locator.docId,
        title: doc.title || '未命名文献',
        author: doc.author || null,
        docType: doc.doc_type || '',
        readStatus: normalizeReadStatus(doc.read_status),
        isFavorite: doc.is_favorite ?? undefined,
        metadataStatus: normalizeMetadataStatus(doc.metadata_status),
        tagNames: String(doc.tag_names || '').split('|').filter(Boolean),
        folderNames: String(doc.folder_names || '').split('|').filter(Boolean),
        totalHits: 0,
        topHits: [] as SearchHit[],
        hits: [] as SearchHit[],
        score: 0,
        updatedAt: doc.updated_at ?? undefined,
        lastOpenedAt: doc.last_opened_at || null,
      }
      group.totalHits += 1
      group.score += Math.max(0.1, 1000 - hit.score)
      if (resultMode === 'all' || group.hits.length < MAX_PREVIEW_HITS_PER_DOC) {
        group.hits.push(hit)
      }
      group.topHits = group.hits.slice(0, 3)
      grouped.set(hit.locator.docId, group)
    })

  const groups = [...grouped.values()]
    .sort((left, right) => compareSearchGroups(left, right, options?.sort))
    .slice(0, options?.limit || 50)

  return {
    query: '',
    totalDocuments: groups.length,
    totalHits: groups.reduce((sum, group) => sum + group.totalHits, 0),
    groups,
    warnings,
    status: 'complete',
  }
}

export function querySearchV2(keyword: string, options?: SearchOptions): SearchGroupedResponse {
  const startedAt = Date.now()
  const query = keyword.trim()
  if (!query) return { query: '', totalDocuments: 0, totalHits: 0, groups: [], warnings: [], status: 'preview' }
  const normalizedQuery = normalizeSearchText(query)
  const limit = options?.limit || 50
  const exhaustive = !!options?.exhaustive
  const scopedDocIds = resolveSearchFilterDocIds(options)
  if (scopedDocIds && scopedDocIds.length === 0) {
    return { query, totalDocuments: 0, totalHits: 0, groups: [], warnings: ['当前筛选范围为空。'], status: 'complete' }
  }
  const autoReindex = options?.autoReindex !== false
  if (autoReindex && scopedDocIds && scopedDocIds.length > 0 && scopedDocIds.length <= 8) {
    const staleManagedTextDocIds = findStaleManagedTextDocIds(scopedDocIds, 8)
    if (staleManagedTextDocIds.length > 0) {
      scheduleBackgroundReindex(staleManagedTextDocIds, { reason: 'search-managed-text-stale' })
    }
  }

  const cacheKey = stableStringify({
    query: normalizedQuery,
    limit,
    page: options?.page || 1,
    pageSize: options?.pageSize || null,
    exhaustive,
    resultMode: options?.resultMode || 'preview',
    sort: options?.sort || 'relevance',
    contextMode: options?.contextMode || 'standard',
    docType: options?.docType || '',
    author: options?.author || '',
    dynasty: options?.dynasty || '',
    folderId: options?.folderId || '',
    folderIds: uniqueIds(options?.folderIds || []),
    tagId: options?.tagId || '',
    tagIds: uniqueIds(options?.tagIds || []),
    docIds: uniqueIds(options?.docIds || []),
    importStatus: options?.importStatus || '',
    ocrStatus: options?.ocrStatus || '',
    readStatus: options?.readStatus || '',
    metadataStatus: options?.metadataStatus || '',
    favoritesOnly: !!options?.favoritesOnly,
    yearFrom: options?.yearFrom || null,
    yearTo: options?.yearTo || null,
    translationScope: options?.translationScope || 'all',
  })
  const cached = getFreshSearchCacheEntry(searchResponseCache, cacheKey, SEARCH_CACHE_TTL_MS)
  if (cached) {
    if (SEARCH_METRICS_ENABLED) {
      console.info('[SearchMetrics]', JSON.stringify({
        query,
        cached: true,
        elapsedMs: Date.now() - startedAt,
        totalDocuments: cached.response.totalDocuments,
        totalHits: cached.response.totalHits,
        previewHits: cached.response.groups.reduce((sum, group) => sum + group.hits.length, 0),
      }))
    }
    return {
      ...cached.response,
      groups: cached.response.groups.map((group) => ({
        ...group,
        hits: [...group.hits],
        topHits: [...group.topHits],
        tagNames: [...(group.tagNames || [])],
        folderNames: [...(group.folderNames || [])],
      })),
    }
  }

  if (options?.translationScope === 'source' || options?.translationScope === 'translation') {
    const params: Array<string | number> = [normalizedQuery]
    const sourceCondition = options.translationScope === 'translation'
      ? "s.source_kind = 'translation'"
      : "s.source_kind <> 'translation'"
    let sql = `SELECT s.segment_id, s.doc_id, s.page_id, s.page_num, s.source_kind, s.href, s.title,
                      s.ordinal, s.source_start, s.text, s.normalized_text, s.offset_map, 10 as rank
               FROM search_index_segments s
               WHERE ${sourceCondition}
                 AND instr(COALESCE(s.normalized_text, s.text, ''), ?) > 0`
    if (scopedDocIds && scopedDocIds.length > 0) {
      sql += ` AND s.doc_id IN (${buildInClause(scopedDocIds)})`
      params.push(...scopedDocIds)
    }
    sql += ' ORDER BY s.doc_id, s.page_num, s.ordinal LIMIT ?'
    params.push(options.resultMode === 'all' ? MAX_DOCUMENT_SEARCH_SESSION_HITS : Math.max(1000, limit * 80))
    return groupRowsByOccurrences(queryAll<SearchHitRow>(sql, params), query, options)
  }

  const staleDocIds = checkSearchIndexForScope(scopedDocIds, { autoReindex })
  const needsCandidateText = (options?.resultMode || 'preview') === 'all' || normalizedQuery.length > 3
  const ngramRows = runSegmentNgramSearch(normalizedQuery, limit, scopedDocIds, exhaustive, needsCandidateText)
  const trigramEligible = isTrigramSearchEligible(normalizedQuery)
  const trigramHasRowsForScope = trigramEligible && hasSearchSegmentsTrigramRows(scopedDocIds)
  const missingTrigramDocIds = trigramEligible ? findSegmentDocIdsWithoutTrigram(scopedDocIds) : []
  const trigramRows = trigramHasRowsForScope
    ? runSegmentTrigramSearch(normalizedQuery, scopedDocIds)
    : []
  const ftsRows = isFtsAvailable()
    ? runSegmentFtsSearch(normalizedQuery, limit, scopedDocIds)
    : []
  const legacySegmentDocIds = SEARCH_NGRAM_INDEX_ENABLED
    ? findLegacySegmentDocIdsWithoutNgrams(
        scopedDocIds,
        scopedDocIds && scopedDocIds.length > 0
          ? Math.min(Math.max(scopedDocIds.length, 1), SEARCH_LEGACY_SEGMENT_SCAN_DOC_LIMIT)
          : SEARCH_LEGACY_SEGMENT_SCAN_DOC_LIMIT,
      )
    : []
  const scopedScanAllowed = !!scopedDocIds && scopedDocIds.length <= 800
  const needsScan = normalizedQuery.length < SEARCH_TRIGRAM_MIN_QUERY_LENGTH
    || scopedScanAllowed
    || legacySegmentDocIds.length > 0
    || missingTrigramDocIds.length > 0
    || (!SEARCH_NGRAM_INDEX_ENABLED && (!trigramEligible || !trigramHasRowsForScope))
    || ((!trigramEligible || !trigramHasRowsForScope) && trigramRows.length === 0 && ngramRows.length === 0 && (!isFtsAvailable() || shouldSupplementFtsWithScan(normalizedQuery, ftsRows, limit)))
  const scanRows = needsScan
    ? legacySegmentDocIds.length > 0
      ? runSegmentTargetedScanSearch(normalizedQuery, limit, legacySegmentDocIds)
      : missingTrigramDocIds.length > 0
      ? runSegmentTargetedScanSearch(normalizedQuery, limit, missingTrigramDocIds, false)
      : scopedDocIds && scopedDocIds.length > 800
      ? runSegmentTargetedScanSearch(normalizedQuery, limit, scopedDocIds)
      : runSegmentScanSearch(normalizedQuery, limit, scopedDocIds)
    : []
  const exactRows = (normalizedQuery.length > 3 || !!scopedDocIds) && (!trigramEligible || !trigramHasRowsForScope || scopedScanAllowed)
    ? runSegmentExactPhraseSearch(normalizedQuery, scopedDocIds)
    : []
  const indexedRows = mergeSearchRows(mergeSearchRows(mergeSearchRows(mergeSearchRows(trigramRows, ngramRows), ftsRows), scanRows), exactRows)
  const indexedDocIds = new Set(indexedRows.map((row) => row.doc_id))
  const managedTextFallbackDocIds = scopedDocIds
    ? []
    : findStaleManagedTextDocIds(undefined, 60)
  const fallbackDocIds = uniqueIds([
    ...staleDocIds.filter((docId) => !indexedDocIds.has(docId)),
    ...managedTextFallbackDocIds.filter((docId) => !indexedDocIds.has(docId)),
  ])
  const allowSynchronousFallback = !!options?.exhaustive
    || (options?.resultMode || 'preview') === 'all'
    || !!scopedDocIds
    || managedTextFallbackDocIds.length > 0
    || staleDocIds.length > 0
  const fallbackRows = allowSynchronousFallback
    ? loadPageFallbackRowsForDocuments(
        fallbackDocIds,
        normalizedQuery,
        scopedDocIds ? SEARCH_SCOPED_FALLBACK_MAX_DOCS : SEARCH_FALLBACK_MAX_DOCS,
      )
      .filter((row) => findKeywordOccurrences(row.normalized_text || row.text || '', normalizedQuery).length > 0)
    : []
  const matchedRows = mergeSearchRows(indexedRows, fallbackRows)
  const warnings = matchedRows.length === 0 ? ['当前范围内没有可匹配的全文索引。'] : []
  if (staleDocIds.length > 0) {
    const staleIndexedHits = indexedRows.some((row) => staleDocIds.includes(row.doc_id))
    if (autoReindex && !!scopedDocIds) {
      warnings.push(
        staleIndexedHits
          ? `有 ${staleDocIds.length} 篇文献的搜索索引正在后台更新；本次先使用已有索引展示结果，更新完成后会自动使用新索引。`
          : allowSynchronousFallback
          ? `有 ${staleDocIds.length} 篇文献的搜索索引正在后台更新；本次已对缺失索引文献使用页面文本兜底。`
          : `有 ${staleDocIds.length} 篇文献的搜索索引正在后台更新；普通检索先显示已就绪索引结果，完整导出/诊断会补扫缺失文献。`,
      )
    } else if (autoReindex) {
      warnings.push(
        staleIndexedHits
          ? `检测到 ${staleDocIds.length} 篇文献的索引状态可能过期；本次先使用已有索引展示结果，不会自动启动全库重建。`
          : allowSynchronousFallback
          ? `检测到 ${staleDocIds.length} 篇文献的索引状态可能过期；本次已使用页面文本兜底，不会自动启动全库重建。`
          : `检测到 ${staleDocIds.length} 篇文献的索引状态可能过期；可在健康检查中手动修复。`,
      )
    } else {
      warnings.push(
        staleIndexedHits
          ? `有 ${staleDocIds.length} 篇文献的搜索索引尚未就绪；本次先使用已有索引和命中页前后文回答，不会自动重建索引。`
          : allowSynchronousFallback
          ? `有 ${staleDocIds.length} 篇文献的搜索索引尚未就绪；本次已使用页面文本兜底，不会自动重建索引。`
          : `有 ${staleDocIds.length} 篇文献的搜索索引尚未就绪；本次只使用已就绪索引结果，不会自动重建索引。`,
      )
    }
  }
  const response = groupRowsByOccurrences(matchedRows, normalizedQuery, options, warnings)
  const searchStatus = needsScan
    ? 'scanning'
    : fallbackRows.length > 0 || staleDocIds.length > 0
      ? 'verifying'
      : matchedRows.length > 0
        ? 'complete'
        : 'candidate'
  const result = { ...response, query, status: searchStatus as SearchGroupedResponse['status'] }
  if (SEARCH_METRICS_ENABLED) {
    console.info('[SearchMetrics]', JSON.stringify({
      query,
      cached: false,
      elapsedMs: Date.now() - startedAt,
      candidateSegments: matchedRows.length,
      trigramSegments: trigramRows.length,
      ngramSegments: ngramRows.length,
      ftsSegments: ftsRows.length,
      scanSegments: scanRows.length,
      legacySegmentDocuments: legacySegmentDocIds.length,
      missingTrigramDocuments: missingTrigramDocIds.length,
      totalDocuments: result.totalDocuments,
      totalHits: result.totalHits,
      previewHits: result.groups.reduce((sum, group) => sum + group.hits.length, 0),
      staleDocuments: staleDocIds.length,
      resultMode: options?.resultMode || 'preview',
    }))
  }
  setBoundedSearchCacheEntry(searchResponseCache, cacheKey, { createdAt: Date.now(), response: result }, 60, SEARCH_CACHE_TTL_MS)
  return result
}

export function getDocumentSearchHits(docId: string, query: string, options?: SearchOptions): SearchSessionState {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery.trim()) {
    return {
      query,
      hits: [],
      activeHitIndex: -1,
      status: 'idle',
    }
  }
  const status = getCurrentSearchIndexStatus(docId)
  const indexReady = isUsableSearchIndexStatus(docId, status)
  if (!indexReady) {
    scheduleBackgroundReindex([docId], { reason: 'search-hit-locator' })
  }
  let segments = indexReady ? loadSearchSegmentsForDocument(docId) : []
  if (segments.length === 0) {
    segments = loadPageSegmentsForDocument(docId)
  }
  const requestedLimit = Number(options?.limit || 600)
  const hits = buildHitsFromRows(
    segments.map((segment) => ({ ...segment, rank: 0 })),
    normalizedQuery,
    Number.isFinite(requestedLimit) ? requestedLimit : 600,
    options,
  )
    .sort((left, right) => (
      (left.locator.pageNum || 0) - (right.locator.pageNum || 0)
      || left.locator.segmentOrdinal - right.locator.segmentOrdinal
      || left.locator.charStart - right.locator.charStart
    ))
  return {
    query,
    hits,
    activeHitIndex: hits.length > 0 ? 0 : -1,
    status: hits.length > 0 ? 'ready' : indexReady ? 'empty' : 'searching',
    phase: indexReady ? 'complete' : 'verifying',
  }
}

export function getDocumentSearchHitPage(docId: string, query: string, options?: SearchOptions): SearchDocumentHitPage {
  const requestedPageSize = Math.floor(Number(options?.pageSize || 10))
  const pageSize = Math.max(1, Math.min(100, Number.isFinite(requestedPageSize) ? requestedPageSize : 10))
  const session = getDocumentSearchHits(docId, query, {
    ...options,
    limit: MAX_DOCUMENT_SEARCH_SESSION_HITS,
    resultMode: 'all',
  })
  const totalHits = session.hits.length
  const totalPages = Math.max(1, Math.ceil(totalHits / pageSize))
  const requestedPage = Math.floor(Number(options?.page || 1))
  const page = Math.max(1, Math.min(totalPages, Number.isFinite(requestedPage) ? requestedPage : 1))
  const start = (page - 1) * pageSize

  return {
    docId,
    query,
    hits: session.hits.slice(start, start + pageSize),
    totalHits,
    page,
    pageSize,
    totalPages,
    status: session.status,
  }
}

function flattenGroupedResponse(response: SearchGroupedResponse, hitField: string): SearchResult[] {
  return response.groups.flatMap((group) => group.hits.map((hit) => ({
    doc_id: group.docId,
    page_num: hit.locator.pageNum || 1,
    occurrence_index: hit.locator.occurrenceIndex,
    snippet: hit.snippet,
    rank: hit.score,
    doc_title: group.title,
    doc_author: group.author,
    doc_type: group.docType,
    relevance_score: Math.max(1, group.score),
    hit_field: hitField,
    matched_query: hit.locator.queryTerm,
    folder_names: group.folderNames?.join('|'),
    tag_names: group.tagNames?.join('|'),
    read_status: group.readStatus,
    is_favorite: group.isFavorite,
    metadata_status: group.metadataStatus,
    updated_at: group.updatedAt,
    last_opened_at: group.lastOpenedAt,
    locator: hit.locator,
  } as SearchResult)))
}

function groupFlatSearchResults(results: Array<SearchResult & { locator?: SearchHitLocator }>, query: string, warnings: string[] = [], options?: SearchOptions): SearchGroupedResponse {
  const grouped = new Map<string, SearchDocumentGroup>()
  results.forEach((item, index) => {
    const pageNum = Number(item.page_num || item.locator?.pageNum || 1)
    const locator: SearchHitLocator = item.locator || {
      docId: item.doc_id,
      segmentId: `${item.doc_id}:${pageNum}:${item.occurrence_index ?? index}`,
      pageId: null,
      pageNum,
      pageIndex: Math.max(0, pageNum - 1),
      href: null,
      segmentOrdinal: pageNum - 1,
      charStart: 0,
      charEnd: 0,
      matchText: item.matched_query || query,
      queryTerm: item.matched_query || query,
      occurrenceIndex: Number(item.occurrence_index || index),
    }
    const hit: SearchHit = {
      id: `${locator.segmentId}:${locator.occurrenceIndex}:${index}`,
      locator,
      snippet: item.snippet || '',
      score: Number(item.rank || index),
    }
    const group: SearchDocumentGroup = grouped.get(item.doc_id) || {
      docId: item.doc_id,
      title: item.doc_title || '未命名文献',
      author: item.doc_author || null,
      docType: item.doc_type || '',
      readStatus: normalizeReadStatus(item.read_status),
      isFavorite: item.is_favorite,
      metadataStatus: normalizeMetadataStatus(item.metadata_status),
      tagNames: String(item.tag_names || '').split('|').filter(Boolean),
      folderNames: String(item.folder_names || '').split('|').filter(Boolean),
      totalHits: 0,
      topHits: [],
      hits: [],
      score: 0,
      updatedAt: item.updated_at,
      lastOpenedAt: item.last_opened_at || null,
    }
    group.hits.push(hit)
    group.totalHits = group.hits.length
    group.topHits = group.hits.slice(0, 3)
    group.score += Math.max(1, 1000 - hit.score)
    grouped.set(item.doc_id, group)
  })
  const groups = [...grouped.values()].sort((left, right) => compareSearchGroups(left, right, options?.sort))
  return {
    query,
    totalDocuments: groups.length,
    totalHits: groups.reduce((sum, group) => sum + group.totalHits, 0),
    groups,
    warnings,
  }
}

function ensureFallbackIndex(): void {
  if (!fallbackDirty) return

  fallbackRecords.clear()
  fallbackIndex.export(() => Promise.resolve()).catch(() => {})

  const pages = queryAll<{ id: string; doc_id: string; page_num: number; content: string }>(
    "SELECT id, doc_id, page_num, TRIM(COALESCE(proofed_text, '') || ' ' || COALESCE(ocr_text, '')) as content FROM pages"
  )

  for (const page of pages) {
    const content = String(page.content || '').trim()
    if (!content) continue

    const record: FallbackRecord = {
      id: page.id,
      docId: page.doc_id,
      pageNum: page.page_num,
      content
    }
    fallbackRecords.set(record.id, record)
    fallbackIndex.add(record.id, content)
  }

  fallbackDirty = false
}

function runFtsSearch(keyword: string, limit: number, docIds?: string[]): SearchRow[] {
  const query = sanitizeFtsQuery(keyword)
  try {
    const params: Array<string | number> = [query]
    let sql = `SELECT page_id, doc_id, page_num,
        snippet(pages_fts, 3, '<<', '>>', '...', 24) as snippet,
        bm25(pages_fts) as rank
      FROM pages_fts
      WHERE pages_fts MATCH ?`

    if (Array.isArray(docIds) && docIds.length > 0) {
      sql += ` AND doc_id IN (${buildInClause(docIds)})`
      params.push(...docIds)
    }

    sql += ' ORDER BY rank LIMIT ?'
    params.push(limit)
    return refineSnippetsAroundKeyword(queryAll<SearchRow>(sql, params), keyword)
  } catch (error) {
    console.warn('[Search] FTS query failed, falling back to LIKE', error)
    return []
  }
}

function runFallbackSearch(keyword: string, limit: number, docIds?: string[]): SearchRow[] {
  ensureFallbackIndex()

  const allowedDocIds = Array.isArray(docIds) && docIds.length > 0 ? new Set(docIds) : null
  const ids = fallbackIndex.search(keyword, {
    limit: allowedDocIds ? Math.max(limit * 8, 40) : limit,
    suggest: true
  }) as string[]

  const results = ids
    .map((id, index) => {
      const record = fallbackRecords.get(String(id))
      if (!record) return null
      if (allowedDocIds && !allowedDocIds.has(record.docId)) return null
      return {
        page_id: record.id,
        doc_id: record.docId,
        page_num: record.pageNum,
        snippet: buildMarkedSnippet(record.content, keyword),
        rank: index
      }
    })
    .filter((row): row is SearchRow => !!row)
    .slice(0, limit)

  if (results.length >= limit || !allowedDocIds) {
    return results
  }

  const seenPageIds = new Set(results.map((item) => item.page_id))
  for (const record of fallbackRecords.values()) {
    if (!allowedDocIds.has(record.docId) || seenPageIds.has(record.id)) continue
    if (!findBestKeywordHit(record.content, keyword)) continue

    results.push({
      page_id: record.id,
      doc_id: record.docId,
      page_num: record.pageNum,
      snippet: buildMarkedSnippet(record.content, keyword),
      rank: results.length
    })

    if (results.length >= limit) break
  }

  return results
}

function runLikeSearch(keyword: string, limit: number, docIds?: string[]): SearchRow[] {
  const params: Array<string | number> = [`%${keyword}%`]
  let sql = `SELECT p.id as page_id, p.doc_id, p.page_num,
      COALESCE(p.proofed_text, p.ocr_text, '') as snippet,
      999 as rank
    FROM pages p
    WHERE COALESCE(p.proofed_text, p.ocr_text, '') LIKE ?`

  if (Array.isArray(docIds) && docIds.length > 0) {
    sql += ` AND p.doc_id IN (${buildInClause(docIds)})`
    params.push(...docIds)
  }

  sql += ' ORDER BY p.page_num ASC LIMIT ?'
  params.push(limit)
  return refineSnippetsAroundKeyword(queryAll<SearchRow>(sql, params), keyword)
}

function hydrateResults(rows: SearchRow[], hitField: string, options?: SearchOptions): SearchResult[] {
  const docMap = loadDocumentMap([...new Set(rows.map((row) => row.doc_id))])
  const results: SearchResult[] = []

  for (const row of rows) {
    const doc = docMap.get(row.doc_id)
    if (!doc || !matchesDocumentFilters(doc, options)) continue

    results.push({
      doc_id: row.doc_id,
      page_num: row.page_num,
      occurrence_index: row.occurrence_index,
      snippet: row.snippet || '',
      rank: row.rank,
      doc_title: doc.title,
      doc_author: doc.author,
      doc_type: doc.doc_type,
      folder_names: doc.folder_names ?? undefined,
      tag_names: doc.tag_names ?? undefined,
      read_status: normalizeReadStatus(doc.read_status),
      is_favorite: doc.is_favorite ?? undefined,
      metadata_status: normalizeMetadataStatus(doc.metadata_status),
      updated_at: doc.updated_at ?? undefined,
      last_opened_at: doc.last_opened_at || null,
      hit_field: hitField,
      relevance_score: hitField === 'semantic' ? 2 : 1
    })
  }

  return results
}

export function fullTextSearch(keyword: string, options?: SearchOptions): SearchResult[] {
  return flattenGroupedResponse(querySearchV2(keyword, options), 'fulltext').slice(0, options?.limit || 50)
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const bestByPage = new Map<string, SearchResult>()
  for (const result of results) {
    const key = `${result.doc_id}_${result.page_num}`
    const existing = bestByPage.get(key)
    if (!existing || (existing.relevance_score || 0) < (result.relevance_score || 0)) {
      bestByPage.set(key, result)
    }
  }
  return [...bestByPage.values()]
}

async function expandKeywords(keyword: string): Promise<string[]> {
  try {
    const result = await runAiTask('semantic_expansion', keyword)
    const parsed = JSON.parse(result)
    return [
      keyword,
      ...((parsed.keywords as string[]) || []),
      ...((parsed.synonyms as string[]) || []),
      ...((parsed.related as string[]) || [])
    ]
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12)
  } catch (error) {
    console.warn('[Search] Semantic expansion failed, using original keyword', error)
    return [keyword]
  }
}

function parseExpansionPayload(raw: string): string[] {
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  const jsonText = firstBrace >= 0 && lastBrace >= 0 ? raw.slice(firstBrace, lastBrace + 1) : raw
  const parsed = JSON.parse(jsonText)
  return uniqueIds([
    ...(Array.isArray(parsed?.keywords) ? parsed.keywords.map((item: unknown) => String(item)) : []),
    ...(Array.isArray(parsed?.synonyms) ? parsed.synonyms.map((item: unknown) => String(item)) : []),
    ...(Array.isArray(parsed?.related) ? parsed.related.map((item: unknown) => String(item)) : []),
  ])
}

async function expandMultilingualKeywords(prompt: string, seedTerms: string[]): Promise<string[]> {
  const seeds = uniqueIds([prompt, ...seedTerms])
    .filter((term) => term.length <= 80)
    .slice(0, 12)
  if (seeds.length === 0) return []

  try {
    const raw = await runAiTask('semantic_expansion', [
      `Generate multilingual academic search terms for these concepts: ${seeds.join(' | ')}`,
      `Include concise translated terms and common scholarly expressions in ${MULTILINGUAL_SEARCH_LANGUAGES}.`,
      'Return only directly searchable terms. Do not include language labels, explanations, broad topic words, or invented titles.',
    ].join('\n'))
    return parseExpansionPayload(raw)
      .map(normalizeAiQueryTerm)
      .filter((term) => isUsefulAiQueryTerm(term, prompt))
      .slice(0, 24)
  } catch (error) {
    console.warn('[Search] Multilingual expansion failed, continuing without translated terms', error)
    return []
  }
}

function emptyAiSearchPlan(prompt: string): AiSearchPlan {
  return {
    intent: prompt,
    keywords: [prompt],
    expandedKeywords: [],
    excludeKeywords: [],
    inferredFilters: {},
    notes: ''
  }
}

function parseAiSearchPlan(raw: string, prompt: string): AiSearchPlan {
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  const jsonText = firstBrace >= 0 && lastBrace >= 0 ? raw.slice(firstBrace, lastBrace + 1) : raw
  const parsed = JSON.parse(jsonText)
  const filters = parsed.inferredFilters || {}
  const toStringArray = (value: unknown): string[] => Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : []
  const toNumberOrNull = (value: unknown): number | null => {
    const num = Number(value)
    return Number.isFinite(num) && num > 0 ? num : null
  }

  return {
    intent: String(parsed.intent || prompt).trim(),
    keywords: toStringArray(parsed.keywords).slice(0, 8),
    expandedKeywords: toStringArray(parsed.expandedKeywords).slice(0, MAX_AI_EXPANDED_KEYWORDS),
    excludeKeywords: toStringArray(parsed.excludeKeywords).slice(0, 8),
    inferredFilters: {
      docType: filters.docType ? String(filters.docType).trim() : undefined,
      author: filters.author ? String(filters.author).trim() : undefined,
      dynasty: filters.dynasty ? String(filters.dynasty).trim() : undefined,
      yearFrom: toNumberOrNull(filters.yearFrom),
      yearTo: toNumberOrNull(filters.yearTo)
    },
    notes: parsed.notes ? String(parsed.notes).trim() : ''
  }
}

function enrichPlanWithHeuristics(plan: AiSearchPlan, prompt: string): AiSearchPlan {
  const keywords = [...plan.keywords]
  const expanded = [...plan.expandedKeywords]
  if (/渡口|津渡|渡船|关津|渡\b|津\b/.test(prompt)) {
    expanded.push('渡口', '津渡', '渡船', '关津', '渡', '津')
  }
  if (/偷窃|偷竊|盗窃|盜竊|窃盗|竊盜|偷盗|偷盜|盗取|盜取|行窃|行竊/.test(prompt)) {
    expanded.unshift('偷窃', '盗窃', '窃盗', '偷盗', '盗取', '行窃', '盗', '窃', '盜', '竊')
  }
  const dynastyMatch = prompt.match(/(清朝|清代|明朝|明代|民国|唐朝|唐代|宋朝|宋代|元朝|元代|秦|汉|隋|魏晋|南北朝)/)
  const inferredFilters = { ...plan.inferredFilters }
  if (dynastyMatch && !inferredFilters.dynasty) {
    inferredFilters.dynasty = dynastyMatch[1].replace(/朝|代/g, '')
  }
  const yearRange = prompt.match(/(\d{3,4})\s*[~\-—至到]\s*(\d{3,4})/)
  if (yearRange) {
    inferredFilters.yearFrom = inferredFilters.yearFrom || Number(yearRange[1])
    inferredFilters.yearTo = inferredFilters.yearTo || Number(yearRange[2])
  }

  return {
    ...plan,
    keywords: uniqueIds(keywords.length > 0 ? keywords : [prompt]).slice(0, 8),
    expandedKeywords: uniqueIds(expanded).slice(0, MAX_AI_EXPANDED_KEYWORDS),
    inferredFilters
  }
}

async function buildAiSearchPlan(prompt: string): Promise<{ plan: AiSearchPlan; warnings: string[] }> {
  const warnings: string[] = []
  try {
    const raw = await runAiTask('ai_search_plan', prompt)
    return { plan: enrichPlanWithHeuristics(parseAiSearchPlan(raw, prompt), prompt), warnings }
  } catch (error) {
    console.warn('[Search] AI search plan failed, using fallback plan', error)
    warnings.push('AI 检索计划解析失败，已退回关键词扩展检索。')
    let expanded: string[] = [prompt]
    try {
      expanded = await expandKeywords(prompt)
    } catch (fallbackError) {
      console.warn('[Search] Semantic fallback expansion failed, using original prompt', fallbackError)
      warnings.push('关键词扩展失败，已使用原始检索词。')
    }
    return {
      plan: enrichPlanWithHeuristics({
        ...emptyAiSearchPlan(prompt),
        keywords: expanded.slice(0, 6),
        expandedKeywords: expanded.slice(6, MAX_AI_EXPANDED_KEYWORDS)
      }, prompt),
      warnings
    }
  }
}

function getExplicitAiFilters(prompt: string, inferred: AiSearchPlan['inferredFilters']): AiSearchPlan['inferredFilters'] {
  const explicit: AiSearchPlan['inferredFilters'] = {}
  const text = prompt.trim()

  if (inferred.docType && text.includes(String(inferred.docType))) {
    explicit.docType = inferred.docType
  }

  if (inferred.dynasty && (
    text.includes(String(inferred.dynasty))
    || /(清朝|清代|明朝|明代|民国|唐朝|唐代|宋朝|宋代|元朝|元代|秦|汉|隋|魏晋|南北朝)/.test(text)
  )) {
    explicit.dynasty = inferred.dynasty
  }

  if (inferred.yearFrom && /\d{3,4}/.test(text)) {
    explicit.yearFrom = inferred.yearFrom
  }
  if (inferred.yearTo && /\d{3,4}/.test(text)) {
    explicit.yearTo = inferred.yearTo
  }

  if (inferred.author && /(作者|著者|撰|编|主编|作者是|限定作者)/.test(text)) {
    explicit.author = inferred.author
  }

  return explicit
}

function mergeAiSearchFilters(prompt: string, manual: SearchOptions | undefined, inferred: AiSearchPlan['inferredFilters']): SearchOptions {
  const next: SearchOptions = { ...(manual || {}) }
  const explicit = getExplicitAiFilters(prompt, inferred)
  if (!next.yearFrom && explicit.yearFrom) next.yearFrom = explicit.yearFrom
  if (!next.yearTo && explicit.yearTo) next.yearTo = explicit.yearTo
  return next
}

function scoreAiSearchResult(result: SearchResult, query: string, index: number): SearchResult {
  const text = `${result.snippet || ''} ${result.doc_title || ''} ${result.tag_names || ''}`.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const directHit = lowerQuery && text.includes(lowerQuery) ? 2.5 : 0
  const shortQueryPenalty = query.length <= 1 ? -1.5 : 0
  return {
    ...result,
    hit_field: 'ai_search',
    matched_query: query,
    relevance_score: (result.relevance_score || 1) + directHit + Math.max(0, 20 - index) * 0.08 + shortQueryPenalty
  }
}

function normalizeAiQueryTerm(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function isUsefulAiQueryTerm(term: string, activePrompt: string): boolean {
  const normalized = normalizeAiQueryTerm(term)
  if (!normalized) return false
  const allowSingleChar = /偷窃|偷竊|盗窃|盜竊|窃盗|竊盜|偷盗|偷盜|盗取|盜取|行窃|行竊/.test(activePrompt)
    && /^(?:盗|盜|窃|竊)$/.test(normalized)
  if (normalized.length <= 1 && normalizeAiQueryTerm(activePrompt).length > 1 && !allowSingleChar) return false
  if (/^\d+$/.test(normalized)) return false
  if (/^(?:以及|还有|相关|研究|问题|历史|文化|社会|中国|日本|这个|那个|本书|本文|摘要|关键词|目录)$/.test(normalized) && normalized !== activePrompt) {
    return false
  }
  return true
}

function buildAiSearchQueries(activePrompt: string, plan: AiSearchPlan): string[] {
  const direct = normalizeAiQueryTerm(activePrompt)
  const core = plan.keywords.map(normalizeAiQueryTerm).filter((term) => isUsefulAiQueryTerm(term, direct)).slice(0, 6)
  const priority: string[] = []
  if (/偷窃|偷竊|盗窃|盜竊|窃盗|竊盜|偷盗|偷盜|盗取|盜取|行窃|行竊/.test(direct)) {
    priority.push('盗', '窃', '盜', '竊')
  }
  const expanded = plan.expandedKeywords.map(normalizeAiQueryTerm).filter((term) => isUsefulAiQueryTerm(term, direct)).slice(0, 24)
  return uniqueIds([direct, ...core, ...priority, ...expanded]).slice(0, MAX_AI_SEARCH_QUERIES)
}

function extractSecondPassQueries(results: SearchResult[], usedQueries: string[]): string[] {
  const used = new Set(usedQueries)
  const candidates = new Map<string, number>()
  for (const result of results.slice(0, 20)) {
    const text = `${result.doc_title || ''} ${result.tag_names || ''} ${result.snippet || ''}`
    const matches = text.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}/g) || []
    for (const match of matches) {
      if (used.has(match) || /^\d+$/.test(match)) continue
      candidates.set(match, (candidates.get(match) || 0) + 1)
    }
  }
  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([term]) => term)
    .slice(0, 6)
}

export async function aiPlannedSearch(prompt: string, options?: SearchOptions): Promise<AiPlannedSearchResponse> {
  const activePrompt = prompt.trim()
  if (!activePrompt) {
    return {
      plan: emptyAiSearchPlan(prompt),
      results: [],
      grouped: { query: prompt, totalDocuments: 0, totalHits: 0, groups: [], warnings: [] },
      effectiveFilters: options || {},
      expandedQueries: [],
      warnings: []
    }
  }

  const { plan, warnings } = await buildAiSearchPlan(activePrompt)
  const multilingualKeywords = await expandMultilingualKeywords(activePrompt, [...plan.keywords, ...plan.expandedKeywords])
  if (multilingualKeywords.length > 0) {
    plan.expandedKeywords = uniqueIds([...plan.expandedKeywords, ...multilingualKeywords]).slice(0, MAX_AI_EXPANDED_KEYWORDS)
  }
  const effectiveFilters = mergeAiSearchFilters(activePrompt, options, plan.inferredFilters)
  const limit = options?.limit || 50
  const baseQueries = buildAiSearchQueries(activePrompt, plan)
  const resultPool: SearchResult[] = []

  baseQueries.forEach((query, index) => {
    try {
      const hits = fullTextSearch(query, { ...effectiveFilters, limit: Math.max(Math.min(limit, 50), 24) })
        .map((item) => scoreAiSearchResult(item, query, index))
      resultPool.push(...hits)
    } catch (error) {
      console.warn('[Search] AI search query failed:', query, error)
      warnings.push(`关键词“${query}”检索失败，已跳过。`)
    }
  })

  const shouldRunSecondPass = activePrompt.length >= 3 && baseQueries.length <= 8 && resultPool.length < Math.max(limit, 30)
  const secondPassQueries = shouldRunSecondPass ? extractSecondPassQueries(resultPool, baseQueries).slice(0, 3) : []
  secondPassQueries.forEach((query, index) => {
    if (!isUsefulAiQueryTerm(query, activePrompt)) return
    try {
      const hits = fullTextSearch(query, { ...effectiveFilters, limit: Math.max(20, Math.floor(limit / 2)) })
        .map((item) => ({
          ...scoreAiSearchResult(item, query, baseQueries.length + index),
          relevance_score: (item.relevance_score || 1) + 0.6
        }))
      resultPool.push(...hits)
    } catch (error) {
      console.warn('[Search] AI search second-pass query failed:', query, error)
      warnings.push(`补充关键词“${query}”检索失败，已跳过。`)
    }
  })

  const excludeTerms = new Set(plan.excludeKeywords.map((item) => item.toLowerCase()))
  const results = dedupeResults(resultPool)
    .filter((item) => {
      if (excludeTerms.size === 0) return true
      const text = `${item.snippet || ''} ${item.doc_title || ''}`.toLowerCase()
      return ![...excludeTerms].some((term) => term && text.includes(term))
    })
    .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
    .slice(0, limit)
  const grouped = groupFlatSearchResults(results, activePrompt, warnings, effectiveFilters)

  return {
    plan,
    results,
    grouped,
    effectiveFilters,
    expandedQueries: uniqueIds([...baseQueries, ...secondPassQueries]),
    warnings
  }
}

export async function semanticSearch(keyword: string, options?: SearchOptions): Promise<SearchResult[]> {
  const activeKeyword = keyword.trim()
  if (!activeKeyword) return []

  const baseExpanded = await expandKeywords(activeKeyword)
  const multilingual = await expandMultilingualKeywords(activeKeyword, baseExpanded)
  const expanded = uniqueIds([...baseExpanded, ...multilingual]).slice(0, MAX_AI_SEARCH_QUERIES)
  const resultPool: SearchResult[] = []

  expanded.forEach((term, index) => {
    const hits = fullTextSearch(term, { ...options, limit: options?.limit || 50 }).map((item) => ({
      ...item,
      hit_field: 'semantic',
      relevance_score: (item.relevance_score || 1) + (index === 0 ? 3 : 1) + Math.max(0, 12 - index) * 0.05
    }))
    resultPool.push(...hits)
  })

  return dedupeResults(resultPool)
    .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
    .slice(0, options?.limit || 50)
}

export function listSavedSearches(): SavedSearch[] {
  return queryAll<SavedSearch>('SELECT * FROM saved_searches ORDER BY updated_at DESC, name ASC')
}

function getSearchLibraryFingerprint(): string {
  const documentStats = queryOne<SearchLibraryStatsRow>('SELECT COUNT(*) as count, MAX(updated_at) as updatedAt FROM documents') || {}
  const pageStats = queryOne<SearchLibraryStatsRow>('SELECT COUNT(*) as count, MAX(created_at) as updatedAt FROM pages') || {}
  const indexStats = queryOne<SearchLibraryStatsRow>('SELECT COUNT(*) as count, MAX(updated_at) as updatedAt FROM search_index_status') || {}
  return JSON.stringify({
    documents: Number(documentStats.count || 0),
    documentUpdatedAt: documentStats.updatedAt || '',
    pages: Number(pageStats.count || 0),
    pageUpdatedAt: pageStats.updatedAt || '',
    indexes: Number(indexStats.count || 0),
    indexUpdatedAt: indexStats.updatedAt || '',
  })
}

export function saveSearch(name: string, filters: SavedSearchPayload): SavedSearch | null {
  const now = new Date().toISOString()
  const id = nanoid()
  const payload = {
    ...filters,
    savedAt: now,
    cache: filters?.cache && typeof filters.cache === 'object'
      ? {
          ...filters.cache,
          libraryFingerprint: getSearchLibraryFingerprint(),
          cachedAt: now,
        }
      : undefined,
  }
  run(
    'INSERT INTO saved_searches (id, name, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, name.trim(), JSON.stringify(payload), now, now]
  )
  saveDatabase()
  return queryOne<SavedSearch>('SELECT * FROM saved_searches WHERE id = ?', [id])
}

export function deleteSavedSearch(id: string): boolean {
  run('DELETE FROM saved_searches WHERE id = ?', [id])
  saveDatabase()
  return true
}

export function runSavedSearch(id: string): SavedSearchRunResult {
  const savedSearch = queryOne<SavedSearch>('SELECT * FROM saved_searches WHERE id = ?', [id])
  if (!savedSearch) {
    return { savedSearch: null, keyword: '', mode: 'fulltext', filters: {}, results: [], grouped: null }
  }
  const payload = JSON.parse(savedSearch.filters || '{}') as SavedSearchPayload
  const keyword = String(payload.keyword || '').trim()
  const mode = payload.mode === 'ai' ? 'ai' : 'fulltext'
  const filters: SearchOptions = {
    ...(payload.filters && typeof payload.filters === 'object' ? payload.filters : payload),
    sort: payload.sort,
    contextMode: payload.contextMode,
  }
  delete (filters as SearchOptions & SavedSearchPayload).keyword
  delete (filters as SearchOptions & SavedSearchPayload).mode
  delete (filters as SearchOptions & SavedSearchPayload).filters
  const libraryFingerprint = getSearchLibraryFingerprint()
  const cachedGrouped = payload.cache?.grouped
  const cachedResults = Array.isArray(payload.cache?.results) ? payload.cache.results : []
  const cacheHit = payload.cache?.libraryFingerprint === libraryFingerprint && cachedGrouped && typeof cachedGrouped === 'object'
  if (cacheHit) {
    return {
      savedSearch,
      keyword,
      mode,
      filters,
      sort: payload.sort,
      contextMode: payload.contextMode,
      results: cachedResults,
      grouped: cachedGrouped,
      cacheHit: true,
    }
  }
  const grouped = keyword && mode === 'fulltext' ? querySearchV2(keyword, filters) : null
  const results = grouped ? flattenGroupedResponse(grouped, 'fulltext') : []
  if (keyword && grouped) {
    const now = new Date().toISOString()
    const nextPayload = {
      ...payload,
      cache: {
        libraryFingerprint,
        cachedAt: now,
        grouped,
        results: results.slice(0, 360),
      },
    }
    run('UPDATE saved_searches SET filters = ?, updated_at = ? WHERE id = ?', [JSON.stringify(nextPayload), now, id])
    saveDatabase()
  }
  return {
    savedSearch,
    keyword,
    mode,
    filters,
    sort: payload.sort,
    contextMode: payload.contextMode,
    results,
    grouped,
    cacheHit: false,
  }
}

function buildLibraryQaAnswerPrompt(results: SearchResult[]): string {
  return results
    .slice(0, 8)
    .map((result, index) => `【${index + 1}】${result.doc_title} 第 ${result.page_num} 页\n${result.snippet}`)
    .join('\n\n')
}

async function buildGroundedLibraryPrompt(question: string, results: SearchResult[]): Promise<string> {
  const resultPrompt = buildLibraryQaAnswerPrompt(results)
  const docIds = [...new Set(results.map((item) => item.doc_id).filter(Boolean))].slice(0, 8)
  if (docIds.length === 0) return resultPrompt

  try {
    const context = await buildAiContextForDocuments(docIds, question)
    return [
      context.prompt,
      '',
      '三、检索命中片段（这些是本次问题最直接的命中证据）',
      resultPrompt,
    ].join('\n')
  } catch (error) {
    console.warn('[Search] Failed to build cached AI context, using snippets only', error)
    return resultPrompt
  }
}

export async function runLibraryAiSearch(question: string, options?: SearchOptions): Promise<LibraryAiSearchResponse> {
  const payload = await aiPlannedSearch(question, { ...options, limit: options?.limit || 12 })
  const results = payload.results
  const snippets = await buildGroundedLibraryPrompt(question, results)
  const answer = await runAiTask('library_qa', question, {
    question,
    snippets
  })
  return { answer, results }
}

export function previewLibraryAiScope(scope?: LibraryAiScope): LibraryAiScopePreview {
  return buildScopePreview(resolveScopeDocumentIds(scope))
}

export async function runScopedLibraryAi(
  question: string,
  scope?: LibraryAiScope,
  options?: SearchOptions
): Promise<ScopedLibraryAiResponse> {
  const scopedDocIds = resolveScopeDocumentIds(scope)
  const preview = buildScopePreview(scopedDocIds)

  if (preview.count === 0) {
    throw new Error('当前范围内没有可用文献，请先调整标签、文件夹或论文选择。')
  }

  const searchableDocIds = resolveSearchableDocumentIds(scopedDocIds)
  if (searchableDocIds.length === 0) {
    throw new Error('当前范围内还没有可用的 OCR 文本，请先完成 OCR 或文本校对。')
  }

  const payload = await aiPlannedSearch(question, {
    ...options,
    docIds: searchableDocIds,
    limit: options?.limit || 12
  })
  const results = payload.results

  if (results.length === 0) {
    return {
      answer: '当前范围内没有检索到足够证据来回答这个问题。可以换一种问法，或者缩小到更具体的标签、文件夹或论文。',
      results: [],
      preview
    }
  }

  const answer = await runAiTask('library_qa', question, {
    question,
    snippets: await buildGroundedLibraryPrompt(question, results)
  })

  return { answer, results, preview }
}
