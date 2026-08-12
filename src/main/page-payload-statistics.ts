import type Database from 'better-sqlite3'
import {
  canonicalizePagePayloadRef,
  pagePayloadRefExists,
  scanPayloadDirectory,
} from './page-payload-files'

type NativeDatabase = Database.Database

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

interface AggregateRow {
  rows?: number | null
  bytes?: number | null
}

export const INLINE_TEXT_MAX_CHARS = 4096
export const INLINE_JSON_MAX_CHARS = 8192

const PAYLOAD_REF_COLUMNS = [
  { table: 'pages', columns: ['ocr_text_ref', 'ocr_result_ref', 'proofed_text_ref'] },
  { table: 'page_ocr_versions', columns: ['ocr_text_ref', 'ocr_result_ref'] },
  { table: 'ocr_artifact_versions', columns: ['ocr_text_ref', 'ocr_result_ref'] },
  { table: 'page_ai_layout_cache', columns: ['result_text_ref'] },
  { table: 'page_translation_cache', columns: ['source_text_ref', 'translation_text_ref'] },
] as const

function queryAll<T>(sqlite: NativeDatabase, sql: string, params: unknown[] = []): T[] {
  return sqlite.prepare(sql).all(...params) as T[]
}

function queryOne<T>(sqlite: NativeDatabase, sql: string, params: unknown[] = []): T | null {
  return (sqlite.prepare(sql).get(...params) as T | undefined) || null
}

export function collectReferencedPagePayloadRefsFromDatabase(sqlite: NativeDatabase): Set<string> {
  const refs = new Set<string>()
  for (const source of PAYLOAD_REF_COLUMNS) {
    const rows = queryAll<Record<string, unknown>>(
      sqlite,
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

export function getPagePayloadStorageStatsForDatabase(sqlite: NativeDatabase): PagePayloadStorageStats {
  const external = scanPayloadDirectory()
  const referencedRefs = collectReferencedPagePayloadRefsFromDatabase(sqlite)
  let referencedFileCount = 0
  let missingReferencedFileCount = 0
  let orphanedFileCount = 0
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
  const orphanedBytes = external.fileCount > 0
    ? Math.round((external.bytes / external.fileCount) * orphanedFileCount)
    : 0
  const estimatedMissingReferencedBytes = external.fileCount > 0
    ? Math.round((external.bytes / external.fileCount) * missingReferencedFileCount)
    : 0
  const pageRow = queryOne<AggregateRow>(
    sqlite,
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
  const versionRow = queryOne<AggregateRow>(
    sqlite,
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(length(COALESCE(ocr_text, '')) + length(COALESCE(ocr_result, ''))), 0) AS bytes
     FROM page_ocr_versions
     WHERE (
       ((ocr_text_ref IS NULL OR ocr_text_ref = '') AND length(COALESCE(ocr_text, '')) > ?)
       OR ((ocr_result_ref IS NULL OR ocr_result_ref = '') AND length(COALESCE(ocr_result, '')) > ?)
     )`,
    [INLINE_TEXT_MAX_CHARS, INLINE_JSON_MAX_CHARS],
  )
  const aiCacheRow = queryOne<AggregateRow>(
    sqlite,
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(length(COALESCE(result_text, ''))), 0) AS bytes
     FROM page_ai_layout_cache
     WHERE (result_text_ref IS NULL OR result_text_ref = '')
       AND length(COALESCE(result_text, '')) > ?`,
    [INLINE_TEXT_MAX_CHARS],
  )
  const translationCacheRow = queryOne<AggregateRow>(
    sqlite,
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
