import type Database from 'better-sqlite3'
import { queryAll, queryOne, run } from './database'
import {
  canonicalizePagePayloadRef,
  deleteUnreferencedPayloadFiles,
  pagePayloadRefExists,
  readPagePayloadValue,
  scanPayloadDirectory,
  writePagePayloadRef,
} from './page-payload-files'

type NativeDatabase = Database.Database

export type PagePayloadField =
  | 'ocr_text'
  | 'ocr_result'
  | 'proofed_text'
  | 'result_text'
  | 'source_text'
  | 'translation_text'

export interface PagePayloadRefs {
  ocr_text_ref?: string | null
  ocr_result_ref?: string | null
  proofed_text_ref?: string | null
  result_text_ref?: string | null
  source_text_ref?: string | null
  translation_text_ref?: string | null
}

export type PagePayloadRow<T> = T & PagePayloadRefs

export interface PagePayloadStorageStats {
  externalFileCount: number
  externalBytes: number
  referencedFileCount: number
  missingReferencedFileCount: number
  orphanedFileCount: number
  orphanedBytes: number
  estimatedMissingReferencedBytes: number
  inlineCandidateRows: number
  inlineCandidateBytes: number
}

export interface PagePayloadCleanupResult {
  scannedFiles: number
  deletedFiles: number
  deletedBytes: number
}

export interface PagePayloadExternalizeOptions {
  limit?: number
}

export interface PagePayloadExternalizeResult {
  scannedRows: number
  externalizedRows: number
  externalizedFields: number
  externalizedBytes: number
}

const INLINE_TEXT_MAX_CHARS = 4096
const INLINE_JSON_MAX_CHARS = 8192
const PAYLOAD_REF_COLUMNS = [
  { table: 'pages', columns: ['ocr_text_ref', 'ocr_result_ref', 'proofed_text_ref'] },
  { table: 'page_ocr_versions', columns: ['ocr_text_ref', 'ocr_result_ref'] },
  { table: 'page_ai_layout_cache', columns: ['result_text_ref'] },
  { table: 'page_translation_cache', columns: ['source_text_ref', 'translation_text_ref'] },
] as const
function normalizeFieldValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function shouldExternalizeField(field: PagePayloadField, value: string | null): boolean {
  if (!value) return false
  const threshold = field === 'ocr_result' ? INLINE_JSON_MAX_CHARS : INLINE_TEXT_MAX_CHARS
  return value.length > threshold
}

export function writePagePayload(docId: string, pageId: string, field: PagePayloadField, value: string): string {
  return writePagePayloadRef(docId, pageId, field, value)
}

export function readPagePayload(ref: string | null | undefined): string | null {
  return readPagePayloadValue(ref)
}

export function preparePagePayloadUpdate(
  docId: string,
  pageId: string,
  field: PagePayloadField,
  value: unknown,
): { value: string | null; ref: string | null } {
  const normalizedValue = normalizeFieldValue(value)
  if (!shouldExternalizeField(field, normalizedValue)) {
    return { value: normalizedValue, ref: null }
  }
  if (normalizedValue === null) return { value: null, ref: null }
  return {
    value: field === 'ocr_result' ? '{"externalized":true}' : '',
    ref: writePagePayload(docId, pageId, field, normalizedValue),
  }
}

export function hydratePagePayloadRow<T>(row: PagePayloadRow<T>): T {
  const next = { ...(row as object) } as Record<string, unknown>
  for (const field of ['ocr_text', 'ocr_result', 'proofed_text', 'result_text', 'source_text', 'translation_text'] as PagePayloadField[]) {
    const refKey = `${field}_ref`
    const ref = typeof next[refKey] === 'string' ? String(next[refKey]) : ''
    if (ref) {
      const external = readPagePayload(ref)
      if (external !== null) next[field] = external
    }
  }
  return next as T
}

export function hydratePagePayloadRows<T>(rows: Array<PagePayloadRow<T>>): T[] {
  return rows.map((row) => hydratePagePayloadRow(row))
}

export function collectReferencedPagePayloadRefs(): Set<string> {
  const refs = new Set<string>()
  for (const source of PAYLOAD_REF_COLUMNS) {
    const rows = queryAll<Record<string, unknown>>(
      `SELECT ${source.columns.join(', ')} FROM ${source.table}`,
    )
    for (const row of rows) {
      for (const column of source.columns) {
        const canonical = canonicalizePagePayloadRef(typeof row[column] === 'string' ? String(row[column]) : null)
        if (canonical) refs.add(canonical)
      }
    }
  }
  return refs
}

export function cleanupUnreferencedPagePayloads(): PagePayloadCleanupResult {
  return deleteUnreferencedPayloadFiles(collectReferencedPagePayloadRefs())
}

export function getPagePayloadStorageStats(): PagePayloadStorageStats {
  const external = scanPayloadDirectory()
  const referencedRefs = collectReferencedPagePayloadRefs()
  let referencedFileCount = 0
  let missingReferencedFileCount = 0
  let orphanedFileCount = 0
  let orphanedBytes = 0
  for (const ref of external.refs) {
    if (referencedRefs.has(ref)) {
      referencedFileCount += 1
    } else {
      orphanedFileCount += 1
    }
  }
  for (const ref of referencedRefs) {
    if (!pagePayloadRefExists(ref)) missingReferencedFileCount += 1
  }
  orphanedBytes = external.fileCount > 0
    ? Math.round((external.bytes / external.fileCount) * orphanedFileCount)
    : 0
  const estimatedMissingReferencedBytes = external.fileCount > 0
    ? Math.round((external.bytes / external.fileCount) * missingReferencedFileCount)
    : 0
  const pageRow = queryOne<{ rows?: number | null; bytes?: number | null }>(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(length(COALESCE(ocr_text, '')) + length(COALESCE(ocr_result, '')) + length(COALESCE(proofed_text, ''))), 0) AS bytes
     FROM pages
     WHERE (
       ((ocr_text_ref IS NULL OR ocr_text_ref = '') AND length(COALESCE(ocr_text, '')) > ?)
       OR ((ocr_result_ref IS NULL OR ocr_result_ref = '') AND length(COALESCE(ocr_result, '')) > ?)
       OR ((proofed_text_ref IS NULL OR proofed_text_ref = '') AND length(COALESCE(proofed_text, '')) > ?)
     )`,
    [INLINE_TEXT_MAX_CHARS, INLINE_JSON_MAX_CHARS, INLINE_TEXT_MAX_CHARS],
  )
  const versionRow = queryOne<{ rows?: number | null; bytes?: number | null }>(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(length(COALESCE(ocr_text, '')) + length(COALESCE(ocr_result, ''))), 0) AS bytes
     FROM page_ocr_versions
     WHERE (
       ((ocr_text_ref IS NULL OR ocr_text_ref = '') AND length(COALESCE(ocr_text, '')) > ?)
       OR ((ocr_result_ref IS NULL OR ocr_result_ref = '') AND length(COALESCE(ocr_result, '')) > ?)
     )`,
    [INLINE_TEXT_MAX_CHARS, INLINE_JSON_MAX_CHARS],
  )
  const aiCacheRow = queryOne<{ rows?: number | null; bytes?: number | null }>(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(length(COALESCE(result_text, ''))), 0) AS bytes
     FROM page_ai_layout_cache
     WHERE (result_text_ref IS NULL OR result_text_ref = '')
       AND length(COALESCE(result_text, '')) > ?`,
    [INLINE_TEXT_MAX_CHARS],
  )
  const translationCacheRow = queryOne<{ rows?: number | null; bytes?: number | null }>(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(length(COALESCE(source_text, '')) + length(COALESCE(translation_text, ''))), 0) AS bytes
     FROM page_translation_cache
     WHERE (
       ((source_text_ref IS NULL OR source_text_ref = '') AND length(COALESCE(source_text, '')) > ?)
       OR ((translation_text_ref IS NULL OR translation_text_ref = '') AND length(COALESCE(translation_text, '')) > ?)
     )`,
    [INLINE_TEXT_MAX_CHARS, INLINE_TEXT_MAX_CHARS],
  )
  const inlineCandidateRows = Number(pageRow?.rows || 0)
    + Number(versionRow?.rows || 0)
    + Number(aiCacheRow?.rows || 0)
    + Number(translationCacheRow?.rows || 0)
  const inlineCandidateBytes = Number(pageRow?.bytes || 0)
    + Number(versionRow?.bytes || 0)
    + Number(aiCacheRow?.bytes || 0)
    + Number(translationCacheRow?.bytes || 0)
  return {
    externalFileCount: external.fileCount,
    externalBytes: external.bytes,
    referencedFileCount,
    missingReferencedFileCount,
    orphanedFileCount,
    orphanedBytes,
    estimatedMissingReferencedBytes,
    inlineCandidateRows,
    inlineCandidateBytes,
  }
}

export function externalizeLargePagePayloads(options: PagePayloadExternalizeOptions = {}): PagePayloadExternalizeResult {
  const limit = Math.max(1, Math.min(10_000, Math.floor(Number(options.limit || 500))))
  const pageFields = ['ocr_text', 'ocr_result', 'proofed_text'] as const
  const rows = queryAll<{
    id: string
    doc_id: string
    ocr_text?: string | null
    ocr_result?: string | null
    proofed_text?: string | null
    ocr_text_ref?: string | null
    ocr_result_ref?: string | null
    proofed_text_ref?: string | null
  }>(
    `SELECT id, doc_id, ocr_text, ocr_result, proofed_text, ocr_text_ref, ocr_result_ref, proofed_text_ref
     FROM pages
     WHERE (
       (ocr_text_ref IS NULL OR ocr_text_ref = '') AND length(COALESCE(ocr_text, '')) > ?
     ) OR (
       (ocr_result_ref IS NULL OR ocr_result_ref = '') AND length(COALESCE(ocr_result, '')) > ?
     ) OR (
       (proofed_text_ref IS NULL OR proofed_text_ref = '') AND length(COALESCE(proofed_text, '')) > ?
     )
     ORDER BY rowid
     LIMIT ?`,
    [INLINE_TEXT_MAX_CHARS, INLINE_JSON_MAX_CHARS, INLINE_TEXT_MAX_CHARS, limit],
  )
  let externalizedRows = 0
  let externalizedFields = 0
  let externalizedBytes = 0
  for (const row of rows) {
    const sets: string[] = []
    const params: unknown[] = []
    for (const field of pageFields) {
      const refKey = `${field}_ref` as keyof typeof row
      const currentRef = String(row[refKey] || '')
      const value = normalizeFieldValue(row[field])
      if (currentRef || !shouldExternalizeField(field, value)) continue
      const prepared = preparePagePayloadUpdate(row.doc_id, row.id, field, value)
      sets.push(`${field} = ?`, `${field}_ref = ?`)
      params.push(prepared.value, prepared.ref)
      externalizedFields += 1
      externalizedBytes += value?.length || 0
    }
    if (sets.length === 0) continue
    params.push(row.id)
    run(`UPDATE pages SET ${sets.join(', ')} WHERE id = ?`, params)
    externalizedRows += 1
  }
  return {
    scannedRows: rows.length,
    externalizedRows,
    externalizedFields,
    externalizedBytes,
  }
}

function externalizeTablePayloads(
  tableName: 'page_ocr_versions' | 'page_ai_layout_cache' | 'page_translation_cache',
  idField: 'id',
  ownerFields: { docId: string; pageId: string },
  fields: PagePayloadField[],
  limit: number,
): PagePayloadExternalizeResult {
  const selectColumns = [
    idField,
    ownerFields.docId,
    ownerFields.pageId,
    ...fields.flatMap((field) => [field, `${field}_ref`]),
  ].join(', ')
  const predicates = fields.map((field) => {
    const threshold = field === 'ocr_result' ? INLINE_JSON_MAX_CHARS : INLINE_TEXT_MAX_CHARS
    return `(( ${field}_ref IS NULL OR ${field}_ref = '' ) AND length(COALESCE(${field}, '')) > ${threshold})`
  }).join(' OR ')
  const rows = queryAll<Record<string, unknown>>(
    `SELECT ${selectColumns}
     FROM ${tableName}
     WHERE ${predicates}
     ORDER BY rowid
     LIMIT ?`,
    [limit],
  )
  let externalizedRows = 0
  let externalizedFields = 0
  let externalizedBytes = 0
  for (const row of rows) {
    const sets: string[] = []
    const params: unknown[] = []
    const docId = String(row[ownerFields.docId] || '')
    const pageId = String(row[ownerFields.pageId] || row[idField] || '')
    const rowId = String(row[idField] || '')
    if (!rowId || !docId || !pageId) continue
    for (const field of fields) {
      const refKey = `${field}_ref`
      if (String(row[refKey] || '')) continue
      const value = normalizeFieldValue(row[field])
      if (!shouldExternalizeField(field, value)) continue
      const prepared = preparePagePayloadUpdate(docId, pageId, field, value)
      sets.push(`${field} = ?`, `${field}_ref = ?`)
      params.push(prepared.value, prepared.ref)
      externalizedFields += 1
      externalizedBytes += value?.length || 0
    }
    if (sets.length === 0) continue
    params.push(rowId)
    run(`UPDATE ${tableName} SET ${sets.join(', ')} WHERE ${idField} = ?`, params)
    externalizedRows += 1
  }
  return {
    scannedRows: rows.length,
    externalizedRows,
    externalizedFields,
    externalizedBytes,
  }
}

export function externalizeLargePayloads(options: PagePayloadExternalizeOptions = {}): PagePayloadExternalizeResult {
  const limit = Math.max(1, Math.min(10_000, Math.floor(Number(options.limit || 500))))
  const results = [
    externalizeLargePagePayloads({ limit }),
    externalizeTablePayloads('page_ocr_versions', 'id', { docId: 'doc_id', pageId: 'page_id' }, ['ocr_text', 'ocr_result'], limit),
    externalizeTablePayloads('page_ai_layout_cache', 'id', { docId: 'doc_id', pageId: 'page_id' }, ['result_text'], limit),
    externalizeTablePayloads('page_translation_cache', 'id', { docId: 'doc_id', pageId: 'page_id' }, ['source_text', 'translation_text'], limit),
  ]
  return results.reduce<PagePayloadExternalizeResult>((sum, item) => ({
    scannedRows: sum.scannedRows + item.scannedRows,
    externalizedRows: sum.externalizedRows + item.externalizedRows,
    externalizedFields: sum.externalizedFields + item.externalizedFields,
    externalizedBytes: sum.externalizedBytes + item.externalizedBytes,
  }), {
    scannedRows: 0,
    externalizedRows: 0,
    externalizedFields: 0,
    externalizedBytes: 0,
  })
}

export function hydratePagePayloadRowWithSqlite<T extends Record<string, unknown>>(
  _sqlite: NativeDatabase,
  row: PagePayloadRow<T>,
): T {
  return hydratePagePayloadRow(row)
}
