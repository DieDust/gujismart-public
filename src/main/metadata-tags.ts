import { nanoid } from 'nanoid'
import { queryAll, queryOne, refreshTagUsage, run, saveDatabase, transaction } from './database'
import { HISTORY_DOC_TYPE_OPTIONS, LEGACY_DOC_TYPE_MAP, normalizeHistoryDocType } from '../shared/history-citation'
import type { DocumentMetadataResult, MetadataTagBindingCleanupResult, MetadataTagBindingRebuildResult } from '../shared/types'

export const METADATA_TAG_BINDING_SETTING_KEY = 'metadata_tag_binding_enabled'

export interface MetadataTagSuggestion {
  name: string
  sourceField: string
  confidence: number
}

interface MetadataTagBaseInfo {
  author?: string | null
  dynasty?: string | null
  source?: string | null
}

interface MetadataTagSyncStats {
  suggestions: number
  linkedRelations: number
  removedRelations: number
}

interface MetadataTagRebuildDocumentRow {
  id: string
  author: string | null
  dynasty: string | null
  source: string | null
  doc_type: string | null
  metadata: string | null
}

const SAFE_METADATA_JSON_SQL = "CASE WHEN json_valid(COALESCE(metadata, '')) THEN metadata ELSE '{}' END"

const METADATA_TAG_CANDIDATE_PREDICATE = `(
  TRIM(COALESCE(author, '')) != ''
  OR TRIM(COALESCE(dynasty, '')) != ''
  OR TRIM(COALESCE(source, '')) != ''
  OR TRIM(COALESCE(doc_type, '')) NOT IN ('', 'unknown', '其他', '鍏朵粬')
  OR (
    json_extract(${SAFE_METADATA_JSON_SQL}, '$.author') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.book_author') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.editor') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.translator') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.journal') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.newspaper') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.publisher') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.publish_place') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.publication_time') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.publication_year') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.issue_date') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.engraving_style') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.dynasty') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.version') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.volume_info') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.collection') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.series') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.university') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.meeting_name') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.book_title') IS NOT NULL
    OR json_extract(${SAFE_METADATA_JSON_SQL}, '$.keywords') IS NOT NULL
  )
)`

const TAGGABLE_FIELDS: Record<string, string> = {
  author: 'author',
  book_author: 'author',
  editor: 'author',
  translator: 'author',
  journal: 'journal',
  newspaper: 'journal',
  publisher: 'publisher',
  publish_place: 'publish_place',
  publication_time: 'publication_time',
  publication_year: 'publication_time',
  issue_date: 'publication_time',
  engraving_style: 'engraving_style',
  dynasty: 'dynasty',
  version: 'version',
  volume_info: 'version',
  collection: 'collection',
  series: 'collection',
  university: 'collection',
  meeting_name: 'collection',
  book_title: 'collection',
  馆藏: 'collection',
}

export const FIELD_TAG_COLORS: Record<string, string> = {
  author: '#f5222d',
  journal: '#2f54eb',
  publisher: '#722ed1',
  publish_place: '#fa8c16',
  publication_time: '#faad14',
  engraving_style: '#13c2c2',
  dynasty: '#722ed1',
  version: '#13c2c2',
  _doc_type: '#1890ff',
  keywords: '#52c41a',
  collection: '#fa8c16',
}

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase()
}

function normalizeScalarValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value.trim() : String(value).trim()
  return text || null
}

function normalizeListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\n，；;、]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return []
}

function normalizeComparableTagName(name: string): string {
  return normalizeTagName(name).replace(/\s+/g, '')
}

function extractYear(value: unknown): string | null {
  const match = String(value || '').match(/(?:18|19|20)\d{2}/)
  return match ? match[0] : null
}

function isDateLikeKeyword(value: string): boolean {
  const text = String(value || '').trim()
  return /^(?:18|19|20)\d{2}\s*年?(?:\s*第\s*\d+\s*期)?$/.test(text)
    || /^(?:第\s*)?\d+\s*(?:卷|期)$/.test(text)
    || /^(?:18|19|20)\d{2}\s*年\s*第\s*\d+\s*期$/.test(text)
}

function shouldSkipTimeTag(field: string, value: unknown, merged: DocumentMetadataResult): boolean {
  if (field === 'publication_year' && (merged.issue_date || merged.publication_time)) return true
  if (field === 'publication_time' && merged.issue_date) {
    const issueYear = extractYear(merged.issue_date)
    const publicationYear = extractYear(value)
    return !!issueYear && issueYear === publicationYear
  }
  return false
}

const DOC_TYPE_TAG_NAMES = new Set<string>([
  ...HISTORY_DOC_TYPE_OPTIONS,
  ...Object.keys(LEGACY_DOC_TYPE_MAP),
  ...Object.values(LEGACY_DOC_TYPE_MAP),
  '论文',
  '期刊',
  '学术论文',
  '古籍',
  'unknown',
  '其他',
].map(normalizeComparableTagName))

function isDocTypeTagName(name: string): boolean {
  const normalized = normalizeComparableTagName(name)
  if (DOC_TYPE_TAG_NAMES.has(normalized)) return true
  return /^(期刊)?论文$|^学位论文$|^会议论文$|^专著$|^图书$|^报纸$|^档案/.test(name.trim())
}

function isMetadataTagBindingEnabled(): boolean {
  const row = queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [METADATA_TAG_BINDING_SETTING_KEY])
  return row?.value === 'true'
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function parseMetadata(value: unknown): DocumentMetadataResult {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as DocumentMetadataResult
  } catch {
    return {}
  }
}

export function clearMetadataTagBindings(docId?: string): MetadataTagBindingCleanupResult {
  const relationFilter = docId ? 'doc_id = ? AND ' : ''
  const relationFilterWithAlias = docId ? 'dt.doc_id = ? AND ' : ''
  const params = docId ? [docId] : []
  const countParams = docId ? [docId] : []
  const metadataBindingPredicate = `(
        COALESCE(dt.is_metadata, 0) = 1
        OR TRIM(COALESCE(dt.source_field, '')) != ''
        OR (
          COALESCE(dt.is_manual, 0) = 0
          AND COALESCE(t.source, 'manual') != 'manual'
        )
      )`
  const metadataBindingPredicateWithoutAlias = `(
        COALESCE(is_metadata, 0) = 1
        OR TRIM(COALESCE(source_field, '')) != ''
        OR (
          COALESCE(is_manual, 0) = 0
          AND tag_id IN (
            SELECT id
            FROM tags
            WHERE COALESCE(source, 'manual') != 'manual'
          )
        )
      )`
  const keepManualCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM document_tags dt
     INNER JOIN tags t ON t.id = dt.tag_id
     WHERE ${relationFilterWithAlias}${metadataBindingPredicate}
       AND COALESCE(dt.is_manual, 0) = 1
       AND COALESCE(t.source, 'manual') = 'manual'`,
    countParams,
  )?.count || 0
  const deleteCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM document_tags dt
     INNER JOIN tags t ON t.id = dt.tag_id
     WHERE ${relationFilterWithAlias}${metadataBindingPredicate}
       AND (
         COALESCE(dt.is_manual, 0) = 0
         OR COALESCE(t.source, 'manual') != 'manual'
       )`,
    countParams,
  )?.count || 0
  const tagCountBefore = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM tags')?.count || 0

  transaction(() => {
    run(
      `DELETE FROM document_tags
       WHERE ${relationFilter}${metadataBindingPredicateWithoutAlias}
         AND (
           COALESCE(is_manual, 0) = 0
           OR tag_id IN (
             SELECT id
             FROM tags
             WHERE COALESCE(source, 'manual') != 'manual'
           )
         )`,
      params,
    )
    run(
      `UPDATE document_tags
       SET is_metadata = 0, source_field = NULL, confidence = NULL, updated_at = ?
       WHERE ${relationFilter}${metadataBindingPredicateWithoutAlias}`,
      [new Date().toISOString(), ...params],
    )
  })
  refreshTagUsage()
  saveDatabase()
  const tagCountAfter = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM tags')?.count || 0
  return {
    removedRelations: deleteCount,
    keptManualRelations: keepManualCount,
    removedTags: Math.max(0, tagCountBefore - tagCountAfter),
  }
}

export function ensureDisabledMetadataTagBindingsCleared(): MetadataTagBindingCleanupResult | null {
  if (isMetadataTagBindingEnabled()) return null

  const pendingCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM document_tags dt
     INNER JOIN tags t ON t.id = dt.tag_id
     WHERE COALESCE(dt.is_metadata, 0) = 1
       OR TRIM(COALESCE(dt.source_field, '')) != ''
       OR (
         COALESCE(dt.is_manual, 0) = 0
         AND COALESCE(t.source, 'manual') != 'manual'
       )`,
  )?.count || 0
  if (pendingCount === 0) return null

  return clearMetadataTagBindings()
}

export function collectMetadataTagValues(
  metadata: DocumentMetadataResult,
  docType: string,
  baseInfo?: MetadataTagBaseInfo,
): MetadataTagSuggestion[] {
  const values: MetadataTagSuggestion[] = []
  const merged: DocumentMetadataResult = {
    ...metadata,
    author: baseInfo?.author || metadata.author,
    dynasty: baseInfo?.dynasty || metadata.dynasty,
    source: baseInfo?.source || metadata.source,
  }

  for (const [field, mappedField] of Object.entries(TAGGABLE_FIELDS)) {
    const value = merged[field]
    if (!value) continue
    if (mappedField === 'publication_time' && shouldSkipTimeTag(field, value, merged)) continue

    if (mappedField === 'author') {
      for (const item of normalizeListValue(value)) {
        values.push({ name: item, sourceField: mappedField, confidence: 0.72 })
      }
      continue
    }

    const text = normalizeScalarValue(value)
    if (text) {
      values.push({ name: text, sourceField: mappedField, confidence: 0.7 })
    }
  }

  const normalizedDocType = normalizeHistoryDocType(docType)
  if (normalizedDocType && normalizedDocType !== '其他' && normalizedDocType !== 'unknown') {
    values.push({ name: normalizedDocType, sourceField: '_doc_type', confidence: 0.85 })
  }

  for (const keyword of normalizeListValue(metadata.keywords)) {
    if (isDateLikeKeyword(keyword)) continue
    values.push({ name: keyword, sourceField: 'keywords', confidence: 0.76 })
  }

  const seen = new Set<string>()
  return values.filter((item) => {
    const key = normalizeTagName(item.name)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function upsertTag(
  name: string,
  color: string,
  source: string,
  confidence: number | null,
): string | null {
  const normalizedName = name.trim()
  if (!normalizedName) return null
  const existing = queryOne<{ id: string; color?: string | null; source?: string | null; confidence?: number | null }>(
    'SELECT id, color, source, confidence FROM tags WHERE normalized_name = ?',
    [normalizeTagName(normalizedName)],
  )
  if (existing) {
    const existingSource = existing.source || 'manual'
    const shouldFillMissingSource = !existing.source
    const shouldFillMissingColor = !existing.color
    run(
      `UPDATE tags
       SET color = ?, source = ?, confidence = ?, normalized_name = ?
       WHERE id = ?`,
      [
        shouldFillMissingColor ? color : existing.color,
        shouldFillMissingSource ? source : existingSource,
        Math.max(Number(existing.confidence || 0), Number(confidence || 0)) || null,
        normalizeTagName(normalizedName),
        existing.id,
      ],
    )
    return existing.id
  }

  const id = nanoid()
  const now = new Date().toISOString()
  run(
    'INSERT INTO tags (id, name, color, parent_id, source, confidence, usage_count, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, normalizedName, color, null, source, confidence, 0, normalizeTagName(normalizedName), now, now],
  )
  return id
}

function linkMetadataTag(docId: string, tagId: string, sourceField: string, confidence: number): boolean {
  const now = new Date().toISOString()
  const relationTargets = queryOne<{ doc_exists: number; tag_exists: number }>(
    `SELECT
      EXISTS(SELECT 1 FROM documents WHERE id = ?) as doc_exists,
      EXISTS(SELECT 1 FROM tags WHERE id = ?) as tag_exists`,
    [docId, tagId],
  )
  if (!relationTargets?.doc_exists || !relationTargets?.tag_exists) return false
  const existing = queryOne<{ is_manual?: number }>(
    'SELECT is_manual FROM document_tags WHERE doc_id = ? AND tag_id = ?',
    [docId, tagId],
  )
  if (existing) {
    run(
      `UPDATE document_tags
       SET is_metadata = 1, source_field = ?, confidence = ?, updated_at = ?
       WHERE doc_id = ? AND tag_id = ?`,
      [sourceField, confidence, now, docId, tagId],
    )
    return true
  }

  run(
    `INSERT INTO document_tags (
      doc_id, tag_id, is_manual, is_metadata, source_field, confidence, created_at, updated_at
    ) VALUES (?, ?, 0, 1, ?, ?, ?, ?)`,
    [docId, tagId, sourceField, confidence, now, now],
  )
  return true
}

function detachStaleDocTypeTags(docId: string, nextDocType: string): void {
  const normalizedNext = normalizeComparableTagName(nextDocType)
  const rows = queryAll<{
    tag_id: string
    name: string
    source?: string | null
    is_manual?: number | null
    is_metadata?: number | null
    source_field?: string | null
  }>(
    `SELECT dt.tag_id, t.name, t.source, dt.is_manual, dt.is_metadata, dt.source_field
     FROM document_tags dt
     INNER JOIN tags t ON t.id = dt.tag_id
     WHERE dt.doc_id = ?`,
    [docId],
  )

  for (const row of rows) {
    const tagName = String(row.name || '').trim()
    if (!tagName || normalizeComparableTagName(tagName) === normalizedNext) continue

    const isDocTypeRelation = row.source_field === '_doc_type'
      || row.source === '_doc_type'
      || row.source === 'doc_type'
      || isDocTypeTagName(tagName)
      || normalizeComparableTagName(normalizeHistoryDocType(tagName)) !== normalizeComparableTagName(tagName)

    if (!isDocTypeRelation) continue

    run('DELETE FROM document_tags WHERE doc_id = ? AND tag_id = ?', [docId, row.tag_id])
  }
}

function syncMetadataTagsForDocument(
  docId: string,
  metadata: DocumentMetadataResult,
  docType: string,
  baseInfo?: MetadataTagBaseInfo,
): MetadataTagSyncStats {
  const normalizedDocType = normalizeHistoryDocType(docType)
  const suggestions = collectMetadataTagValues(metadata, normalizedDocType, baseInfo)
  const existingMetadataRelations = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM document_tags
     WHERE doc_id = ?
       AND (
         COALESCE(is_metadata, 0) = 1
         OR TRIM(COALESCE(source_field, '')) != ''
       )`,
    [docId],
  )?.count || 0
  let linkedRelations = 0

  transaction(() => {
    detachStaleDocTypeTags(docId, normalizedDocType)
    run(
      `DELETE FROM document_tags
       WHERE doc_id = ?
         AND is_metadata = 1
         AND COALESCE(is_manual, 0) = 0`,
      [docId],
    )
    run(
      `UPDATE document_tags
       SET is_metadata = 0, source_field = NULL, confidence = NULL, updated_at = ?
       WHERE doc_id = ? AND is_metadata = 1`,
      [new Date().toISOString(), docId],
    )

    for (const suggestion of suggestions) {
      const tagId = upsertTag(
        suggestion.name,
        FIELD_TAG_COLORS[suggestion.sourceField] || '#52c41a',
        suggestion.sourceField,
        suggestion.confidence,
      )
      if (!tagId) continue
      if (linkMetadataTag(docId, tagId, suggestion.sourceField, suggestion.confidence)) {
        linkedRelations += 1
      }
    }
  })

  return {
    suggestions: suggestions.length,
    linkedRelations,
    removedRelations: existingMetadataRelations,
  }
}

export function syncDocumentMetadataTags(
  docId: string,
  metadata: DocumentMetadataResult,
  docType: string,
  baseInfo?: MetadataTagBaseInfo,
): void {
  const docExists = queryOne<{ id: string }>('SELECT id FROM documents WHERE id = ?', [docId])
  if (!docExists) return
  if (!isMetadataTagBindingEnabled()) {
    clearMetadataTagBindings(docId)
    return
  }

  syncMetadataTagsForDocument(docId, metadata, docType, baseInfo)
  refreshTagUsage()
  saveDatabase()
}

export async function rebuildMetadataTagBindings(batchSize = 50): Promise<MetadataTagBindingRebuildResult> {
  if (!isMetadataTagBindingEnabled()) {
    return {
      processedDocuments: 0,
      syncedDocuments: 0,
      skippedDocuments: 0,
      createdOrUpdatedRelations: 0,
    }
  }

  const documents = queryAll<MetadataTagRebuildDocumentRow>(
    `SELECT id, author, dynasty, source, doc_type, metadata
     FROM documents
     WHERE ${METADATA_TAG_CANDIDATE_PREDICATE}`,
  )
  const safeBatchSize = Math.max(1, Math.min(200, Math.floor(batchSize)))
  const result: MetadataTagBindingRebuildResult = {
    processedDocuments: 0,
    syncedDocuments: 0,
    skippedDocuments: 0,
    createdOrUpdatedRelations: 0,
  }

  for (const doc of documents) {
    const metadata = parseMetadata(doc.metadata)
    const stats = syncMetadataTagsForDocument(doc.id, metadata, doc.doc_type || 'unknown', {
      author: doc.author,
      dynasty: doc.dynasty,
      source: doc.source,
    })
    result.processedDocuments += 1
    result.createdOrUpdatedRelations += stats.linkedRelations
    if (stats.suggestions > 0 || stats.removedRelations > 0 || stats.linkedRelations > 0) {
      result.syncedDocuments += 1
    } else {
      result.skippedDocuments += 1
    }

    if (result.processedDocuments % safeBatchSize === 0) {
      await yieldToEventLoop()
    }
  }

  if (result.processedDocuments > 0) {
    refreshTagUsage()
    saveDatabase()
  }

  return result
}

export async function ensureEnabledMetadataTagBindingsRebuilt(): Promise<MetadataTagBindingRebuildResult | null> {
  if (!needsMetadataTagBindingRebuild()) return null
  return rebuildMetadataTagBindings()
}

export function needsMetadataTagBindingRebuild(): boolean {
  if (!isMetadataTagBindingEnabled()) return false

  const missingBoundCandidates = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM documents
     WHERE ${METADATA_TAG_CANDIDATE_PREDICATE}
       AND NOT EXISTS (
         SELECT 1
         FROM document_tags dt
         WHERE dt.doc_id = documents.id
           AND (
             COALESCE(dt.is_metadata, 0) = 1
             OR TRIM(COALESCE(dt.source_field, '')) != ''
           )
       )`,
  )?.count || 0

  return missingBoundCandidates > 0
}
