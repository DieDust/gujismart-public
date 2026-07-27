import type Database from 'better-sqlite3'
import { getDatabase, queryAll, run } from './database'
import {
  deleteUnreferencedPayloadFiles,
  readPagePayloadValue,
  writePagePayloadRef,
} from './page-payload-files'
import {
  collectReferencedPagePayloadRefsFromDatabase,
  getPagePayloadStorageStatsForDatabase,
  INLINE_JSON_MAX_CHARS,
  INLINE_TEXT_MAX_CHARS,
  type PagePayloadStorageStats,
} from './page-payload-statistics'

export type { PagePayloadStorageStats } from './page-payload-statistics'

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
  return collectReferencedPagePayloadRefsFromDatabase(getDatabase())
}

export function cleanupUnreferencedPagePayloads(): PagePayloadCleanupResult {
  return deleteUnreferencedPayloadFiles(collectReferencedPagePayloadRefs())
}

export function getPagePayloadStorageStats(): PagePayloadStorageStats {
  return getPagePayloadStorageStatsForDatabase(getDatabase())
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
