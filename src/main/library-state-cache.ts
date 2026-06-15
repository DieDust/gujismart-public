import type { LibrarySmartViewCounts, LibraryStateCache } from '../shared/types'
import { queryAll, queryOne, run, scheduleDatabaseSave } from './database'

const CACHE_KEY = 'library-sidebar-v1'

const EMPTY_SMART_VIEW_COUNTS: LibrarySmartViewCounts = {
  all: 0,
  missingMetadata: 0,
  unrecognized: 0,
  suspiciousTitle: 0,
  unknownType: 0,
  favorite: 0,
  unread: 0,
  proofed: 0,
  unproofed: 0,
  metadataPending: 0,
  unstored: 0,
}

interface CacheRow {
  cache_json?: string | null
  dirty?: number | null
  updated_at?: string | null
}

interface CountRow {
  count?: number | null
}

interface IdCountRow {
  id: string
  count?: number | null
}

function numberValue(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function count(sql: string, params?: unknown[]): number {
  return numberValue(queryOne<CountRow>(sql, params)?.count)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCounts(value: unknown): LibrarySmartViewCounts {
  const source = isRecord(value) ? value : {}
  return {
    all: numberValue(source.all),
    missingMetadata: numberValue(source.missingMetadata),
    unrecognized: numberValue(source.unrecognized),
    suspiciousTitle: numberValue(source.suspiciousTitle),
    unknownType: numberValue(source.unknownType),
    favorite: numberValue(source.favorite),
    unread: numberValue(source.unread),
    proofed: numberValue(source.proofed),
    unproofed: numberValue(source.unproofed),
    metadataPending: numberValue(source.metadataPending),
    unstored: numberValue(source.unstored),
  }
}

function parseCountMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const next: Record<string, number> = {}
  Object.entries(value).forEach(([key, raw]) => {
    if (key) next[key] = numberValue(raw)
  })
  return next
}

function emptyCache(dirty = true): LibraryStateCache {
  return {
    smartViewCounts: { ...EMPTY_SMART_VIEW_COUNTS },
    unfiledDocumentTotal: 0,
    folderDocumentCounts: {},
    tagDocumentCounts: {},
    dirty,
    updatedAt: null,
  }
}

function normalizeCache(payload: unknown, row?: CacheRow | null): LibraryStateCache {
  if (!isRecord(payload)) return emptyCache(row?.dirty !== 0)
  return {
    smartViewCounts: parseCounts(payload.smartViewCounts),
    unfiledDocumentTotal: numberValue(payload.unfiledDocumentTotal),
    folderDocumentCounts: parseCountMap(payload.folderDocumentCounts),
    tagDocumentCounts: parseCountMap(payload.tagDocumentCounts),
    dirty: row?.dirty !== 0,
    updatedAt: typeof row?.updated_at === 'string' ? row.updated_at : null,
  }
}

function readCacheRow(): CacheRow | null {
  return queryOne<CacheRow>('SELECT cache_json, dirty, updated_at FROM library_state_cache WHERE cache_key = ?', [CACHE_KEY])
}

export function getLibraryStateCache(): LibraryStateCache {
  const row = readCacheRow()
  if (!row?.cache_json) return buildLightweightCache(true)
  if (row.dirty !== 0) return buildLightweightCache(true)
  try {
    return normalizeCache(JSON.parse(row.cache_json), row)
  } catch {
    return buildLightweightCache(true)
  }
}

function buildMissingMetadataCondition(keys: string[]): string {
  const checks = keys.map((key) => `json_extract(COALESCE(d.metadata, '{}'), '$.${key}')`).join(', ')
  return `TRIM(COALESCE(${checks}, '')) = ''`
}

function buildPageContentAvailableCondition(alias = 'p'): string {
  return `TRIM(COALESCE(NULLIF(${alias}.proofed_text, ''), NULLIF(${alias}.ocr_text, ''), NULLIF(${alias}.ocr_result, ''), '')) <> ''`
}

function buildDocumentTextPageCountExpression(alias = 'd'): string {
  return `(SELECT COUNT(*) FROM pages p_text_count WHERE p_text_count.doc_id = ${alias}.id AND ${buildPageContentAvailableCondition('p_text_count')})`
}

function buildDocumentCompletedPageCountExpression(alias = 'd'): string {
  return `(SELECT COUNT(*) FROM pages p_ocr_count WHERE p_ocr_count.doc_id = ${alias}.id AND p_ocr_count.ocr_status = 'completed')`
}

function buildDocumentOcrCompleteCondition(alias = 'd'): string {
  const pageCount = `COALESCE(${alias}.page_count, 0)`
  return `(
    ${pageCount} > 0
    AND (
      ${buildDocumentCompletedPageCountExpression(alias)} >= ${pageCount}
      OR ${buildDocumentTextPageCountExpression(alias)} >= ${pageCount}
    )
  )`
}

function buildOcrIncompleteCondition(): string {
  return `(
    NOT EXISTS (
      SELECT 1
      FROM pages p_any
      WHERE p_any.doc_id = d.id
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM pages p_incomplete
      WHERE p_incomplete.doc_id = d.id
        AND COALESCE(p_incomplete.ocr_status, '') <> 'completed'
        AND NOT (${buildPageContentAvailableCondition('p_incomplete')})
      LIMIT 1
    )
  )`
}

function buildMissingMetadataFilter(): string {
  const authorExpression = `(
    TRIM(COALESCE(d.author, '')) = ''
    AND ${buildMissingMetadataCondition(['author', 'authors', 'creator', 'editor', 'translator'])}
  )`
  const yearExpression = `(${buildMissingMetadataCondition(['publication_year', 'year', 'publish_year', 'date', 'issue_date', 'publication_time'])})`
  const identifierExpression = `(${buildMissingMetadataCondition(['doi', 'DOI', 'isbn', 'ISBN', 'issn', 'identifier'])})`
  const publisherExpression = `(${buildMissingMetadataCondition(['publisher', 'press', 'publisher_name'])})`
  const sourceExpression = `(
    TRIM(COALESCE(d.source, '')) = ''
    AND ${buildMissingMetadataCondition(['source', 'journal', 'newspaper', 'book_title', 'collection', 'series', 'container_title'])}
  )`
  return `(${authorExpression} OR ${yearExpression} OR ${identifierExpression} OR ${publisherExpression} OR ${sourceExpression})`
}

function suspiciousTitleFilter(): string {
  return `(TRIM(COALESCE(d.title, '')) = '' OR LOWER(TRIM(d.title)) GLOB 'pdf合并*' OR LOWER(TRIM(d.title)) GLOB '扫描*' OR LOWER(TRIM(d.title)) GLOB '未命名*' OR LOWER(TRIM(d.title)) GLOB 'document*' OR LOWER(TRIM(d.title)) GLOB 'scan*' OR LOWER(TRIM(d.title)) GLOB 'image*' OR LOWER(TRIM(d.title)) GLOB 'new document*')`
}

function unknownTypeFilter(): string {
  return `(TRIM(COALESCE(d.doc_type, '')) = '' OR d.doc_type IN ('unknown', '其他'))`
}

function activeDocumentWhere(extra = '1 = 1'): string {
  return `WHERE COALESCE(d.import_status, '') <> 'deleting' AND ${extra}`
}

function buildFolderCounts(): Record<string, number> {
  const rows = queryAll<IdCountRow>(
    `SELECT f.id, COUNT(DISTINCT d.id) AS count
     FROM folders f
     LEFT JOIN document_folders df ON df.folder_id = f.id
     LEFT JOIN documents d ON d.id = df.doc_id AND COALESCE(d.import_status, '') <> 'deleting'
     GROUP BY f.id`,
  )
  return Object.fromEntries(rows.map((row) => [row.id, numberValue(row.count)]))
}

function buildTagCounts(): Record<string, number> {
  const rows = queryAll<IdCountRow>(
    `SELECT t.id, COUNT(DISTINCT d.id) AS count
     FROM tags t
     LEFT JOIN document_tags dt ON dt.tag_id = t.id
     LEFT JOIN documents d ON d.id = dt.doc_id AND COALESCE(d.import_status, '') <> 'deleting'
     GROUP BY t.id`,
  )
  return Object.fromEntries(rows.map((row) => [row.id, numberValue(row.count)]))
}

function buildCache(): LibraryStateCache {
  const smartViewCounts: LibrarySmartViewCounts = {
    all: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere()}`),
    missingMetadata: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere(buildMissingMetadataFilter())}`),
    unrecognized: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere(buildOcrIncompleteCondition())}`),
    suspiciousTitle: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere(suspiciousTitleFilter())}`),
    unknownType: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere(unknownTypeFilter())}`),
    favorite: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere('d.is_favorite = 1')}`),
    unread: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere("d.read_status = 'unread'")}`),
    proofed: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere("d.proof_status = 'completed'")}`),
    unproofed: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere("COALESCE(d.proof_status, 'pending') <> 'completed'")}`),
    metadataPending: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere("d.metadata_status IN ('pending', 'review')")}`),
    unstored: count(`SELECT COUNT(*) AS count FROM documents d WHERE d.import_status = 'unstored'`),
  }
  return {
    smartViewCounts,
    unfiledDocumentTotal: count(
      `SELECT COUNT(*) AS count
       FROM documents d
       WHERE COALESCE(d.import_status, '') <> 'deleting'
         AND NOT EXISTS (SELECT 1 FROM document_folders df_unfiled WHERE df_unfiled.doc_id = d.id)`,
    ),
    folderDocumentCounts: buildFolderCounts(),
    tagDocumentCounts: buildTagCounts(),
    dirty: false,
    updatedAt: new Date().toISOString(),
  }
}

function buildLightweightCache(dirty: boolean): LibraryStateCache {
  const smartViewCounts: LibrarySmartViewCounts = {
    all: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere()}`),
    missingMetadata: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere(buildMissingMetadataFilter())}`),
    unrecognized: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere(buildOcrIncompleteCondition())}`),
    suspiciousTitle: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere(suspiciousTitleFilter())}`),
    unknownType: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere(unknownTypeFilter())}`),
    favorite: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere('d.is_favorite = 1')}`),
    unread: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere("d.read_status = 'unread'")}`),
    proofed: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere("d.proof_status = 'completed'")}`),
    unproofed: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere("COALESCE(d.proof_status, 'pending') <> 'completed'")}`),
    metadataPending: count(`SELECT COUNT(*) AS count FROM documents d ${activeDocumentWhere("d.metadata_status IN ('pending', 'review')")}`),
    unstored: count(`SELECT COUNT(*) AS count FROM documents d WHERE d.import_status = 'unstored'`),
  }
  return {
    smartViewCounts,
    unfiledDocumentTotal: count(
      `SELECT COUNT(*) AS count
       FROM documents d
       WHERE COALESCE(d.import_status, '') <> 'deleting'
         AND NOT EXISTS (SELECT 1 FROM document_folders df_unfiled WHERE df_unfiled.doc_id = d.id)`,
    ),
    folderDocumentCounts: buildFolderCounts(),
    tagDocumentCounts: buildTagCounts(),
    dirty,
    updatedAt: null,
  }
}

export function refreshLibraryStateCache(): LibraryStateCache {
  const cache = buildCache()
  run(
    `INSERT INTO library_state_cache (cache_key, cache_json, dirty, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       cache_json = excluded.cache_json,
       dirty = 0,
       updated_at = excluded.updated_at`,
    [CACHE_KEY, JSON.stringify({
      smartViewCounts: cache.smartViewCounts,
      unfiledDocumentTotal: cache.unfiledDocumentTotal,
      folderDocumentCounts: cache.folderDocumentCounts,
      tagDocumentCounts: cache.tagDocumentCounts,
    }), cache.updatedAt],
  )
  scheduleDatabaseSave()
  return cache
}

export function markLibraryStateCacheDirty(): LibraryStateCache {
  const row = readCacheRow()
  const now = new Date().toISOString()
  const cache = buildLightweightCache(true)
  const cacheJson = JSON.stringify({
    smartViewCounts: cache.smartViewCounts,
    unfiledDocumentTotal: cache.unfiledDocumentTotal,
    folderDocumentCounts: cache.folderDocumentCounts,
    tagDocumentCounts: cache.tagDocumentCounts,
  })
  if (row?.cache_json) {
    run(
      'UPDATE library_state_cache SET cache_json = ?, dirty = 1, updated_at = ? WHERE cache_key = ?',
      [cacheJson, now, CACHE_KEY],
    )
  } else {
    run(
      'INSERT INTO library_state_cache (cache_key, cache_json, dirty, updated_at) VALUES (?, ?, 1, ?)',
      [CACHE_KEY, cacheJson, now],
    )
  }
  scheduleDatabaseSave()
  return getLibraryStateCache()
}
