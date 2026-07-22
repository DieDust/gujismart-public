import { existsSync } from 'fs'
import { readdir, rename, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, extname, join } from 'path'
import { getDataDir, queryAll, run, scheduleDatabaseSave, transaction } from './database'
import { recoverInterruptedOcrJobs, type OcrRecoverySummary } from './ocr-recovery'
import { resumeInterruptedDocumentDeletes, type InterruptedDocumentDeleteRecoverySummary } from './ipc/documents'
import type { BatchQueueResumeSummary } from './batch-processor'
import { getPdfPageCountFast } from './pdf-info'
import { isSearchIndexReindexQueuedInMemory, isSearchIndexUsableForDocument, markSearchIndexStaleForDocuments } from './semantic-search'
import { emitBackgroundTaskStatus } from './background-tasks'
import { inspectManagedDeleteTarget } from './managed-path-boundary'
import { beginStartupPhase, logStartupTimingSummary, markStartupEvent, recordStartupPhaseSpan } from './startup-timing'
import { keepStartupSplashForDiagnostics } from './startup-splash'
import { nanoid } from 'nanoid'

export interface StartupRecoverySummary {
  ocr: OcrRecoverySummary
  deletingDocuments: InterruptedDocumentDeleteRecoverySummary
  canceled?: boolean
  completedOcrDocuments: number
  repairedInterruptedImports: number
  initializedPdfPageRecords: number
  recoveredPdfCompressionSources: number
  reindexedRecoveredOcrDocuments: number
  resumedBatchQueue: BatchQueueResumeSummary
  resetSearchIndexJobs: number
  resetAiLayoutCacheRows: number
  resetTranslationCacheRows: number
  orphanStorageDirs: number
  removedTempDirs: number
}

interface InterruptedImportDocumentRow {
  id: string
  file_path: string | null
  page_count: number | null
  ocr_status: string | null
  import_status: string | null
  doc_type: string | null
  metadata: string | null
}

interface DocumentFilePathRow {
  id: string
  file_path: string | null
}

let startupRecoveryRunning = false
let startupRecoveryPromise: Promise<void> | null = null
let startupRecoveryCancelRequested = false

const RECOVERABLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp'])
const ORPHAN_STORAGE_CLEANUP_YIELD_INTERVAL = 4
const ORPHAN_STORAGE_CLEANUP_MAX_PER_STARTUP = 40
const STARTUP_PDF_PAGE_RECORD_INIT_LIMIT = 1000
const RESERVED_STORAGE_DIR_NAMES = new Set(['page-payloads'])

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))
// Defer only to the next macrotask so createWindow/ready-to-show can finish first.
// A multi-second fixed wait made cold start feel ~8s slower without helping large-library UX.
const STARTUP_RECOVERY_DELAY_MS = 0
/** Only record event-loop waits that are long enough to matter in diagnostics. */
const EVENT_LOOP_WAIT_PHASE_THRESHOLD_MS = 50

/**
 * Yield so cancel / UI can run. Long waits mean the main thread was busy elsewhere
 * (renderer IPC, AV, library list, etc.) — record that span so diagnostics are honest.
 */
async function startupRecoveryCheckpoint(): Promise<boolean> {
  const waitStartedAt = Date.now()
  await yieldToEventLoop()
  const waitedMs = Date.now() - waitStartedAt
  if (waitedMs >= EVENT_LOOP_WAIT_PHASE_THRESHOLD_MS) {
    recordStartupPhaseSpan('startup-recovery.event-loop-wait', waitStartedAt, waitStartedAt + waitedMs)
    console.log(`[Startup Recovery] Event-loop wait ${waitedMs}ms (main thread busy elsewhere)`)
  }
  return startupRecoveryCancelRequested
}

function emitStartupRecoveryStatus(payload: {
  status: 'queued' | 'processing' | 'completed' | 'error'
  progress?: number
  message?: string
  totalCount?: number
  completedCount?: number
  errorMessage?: string
}): void {
  emitBackgroundTaskStatus({
    taskId: 'startup-recovery',
    kind: 'startup-recovery',
    ...payload,
  })
}

function countRows(sql: string, params?: unknown[]): number {
  return Number(queryAll<{ count: number }>(sql, params)[0]?.count || 0)
}

function createEmptyOcrRecoverySummary(): OcrRecoverySummary {
  return {
    recoveredDocuments: 0,
    recoveredPages: 0,
    recoveredCompletedPages: 0,
    recoveredBatchItems: 0,
    removedOrphanedBatchItems: 0,
    completedDocuments: 0,
    pendingDocuments: 0,
  }
}

function resetInterruptedSearchIndexJobs(): string[] {
  const docIds = queryAll<{ doc_id: string }>(
    "SELECT doc_id FROM search_index_status WHERE status IN ('queued', 'processing')",
  )
    .map((row) => row.doc_id)
    .filter((docId) => docId && !isSearchIndexReindexQueuedInMemory(docId) && !isSearchIndexUsableForDocument(docId))
  if (docIds.length === 0) return []
  const placeholders = docIds.map(() => '?').join(', ')
  run(
    `UPDATE search_index_status
     SET status = 'pending',
         error_message = NULL,
         updated_at = ?
     WHERE doc_id IN (${placeholders})
       AND status IN ('queued', 'processing')`,
    [new Date().toISOString(), ...docIds],
  )
  return docIds
}

function resetInterruptedTranslationCacheRows(): number {
  const cacheCount = countRows("SELECT COUNT(*) as count FROM page_translation_cache WHERE status = 'processing'")
  const unitCount = countRows("SELECT COUNT(*) as count FROM page_translation_units WHERE status = 'processing'")
  const now = new Date().toISOString()
  if (cacheCount > 0) {
    run(
      `UPDATE page_translation_cache
       SET status = 'error',
           error_message = ?,
           updated_at = ?
       WHERE status = 'processing'`,
      ['Interrupted by previous app shutdown; restart translation to continue cache generation.', now],
    )
  }
  if (unitCount > 0) {
    run(
      `UPDATE page_translation_units
       SET status = CASE WHEN TRIM(COALESCE(translation_text, '')) <> '' THEN 'stale' ELSE 'pending' END,
           stale = CASE WHEN TRIM(COALESCE(translation_text, '')) <> '' THEN 1 ELSE stale END,
           updated_at = ?
       WHERE status = 'processing'`,
      [now],
    )
  }
  return cacheCount + unitCount
}

function resetInterruptedAiLayoutCacheRows(): number {
  const count = countRows("SELECT COUNT(*) as count FROM page_ai_layout_cache WHERE status = 'processing'")
  if (count <= 0) return 0
  run(
    `UPDATE page_ai_layout_cache
     SET status = 'error',
         error_message = ?,
         updated_at = ?
     WHERE status = 'processing'`,
    ['Interrupted by previous app shutdown; rerun AI layout analysis to rebuild this cache.', new Date().toISOString()],
  )
  return count
}

function reconcileCompletedOcrDocuments(): number {
  // Open path: status-only promotion. Never scan page body text on startup.
  // Only look at documents already marked incomplete to keep the probe bounded.
  const rows = queryAll<{ id: string }>(
    `SELECT d.id
     FROM documents d
     WHERE COALESCE(d.import_status, '') <> 'deleting'
       AND COALESCE(d.page_count, 0) > 0
       AND COALESCE(d.ocr_status, '') IN ('pending', 'queued', 'processing')
       AND NOT EXISTS (
         SELECT 1
         FROM pages p
         WHERE p.doc_id = d.id
           AND COALESCE(p.ocr_status, '') <> 'completed'
         LIMIT 1
       )
       AND EXISTS (
         SELECT 1
         FROM pages p
         WHERE p.doc_id = d.id
         LIMIT 1
       )`,
  )
  const docIds = rows.map((row) => row.id).filter(Boolean)
  if (docIds.length === 0) return 0

  const now = new Date().toISOString()
  for (let index = 0; index < docIds.length; index += 200) {
    const chunk = docIds.slice(index, index + 200)
    const placeholders = chunk.map(() => '?').join(', ')
    run(
      `UPDATE documents
       SET ocr_status = 'completed',
           import_status = 'processed',
           error_message = NULL,
           updated_at = ?
       WHERE id IN (${placeholders})`,
      [now, ...chunk],
    )
  }
  markSearchIndexPendingForRecoveredDocuments(docIds)
  return docIds.length
}

/**
 * Open-path search recovery must stay ID-scoped.
 * Full-library content predicates on pages freeze multi-GB installs for minutes.
 */
function findRecoveredOcrDocumentsNeedingSearchIndex(candidateDocIds: string[]): string[] {
  const uniqueDocIds = [...new Set(candidateDocIds.map((id) => String(id || '').trim()).filter(Boolean))]
  if (uniqueDocIds.length === 0) return []

  const needing: string[] = []
  for (let index = 0; index < uniqueDocIds.length; index += 200) {
    const chunk = uniqueDocIds.slice(index, index + 200)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = queryAll<{ id: string }>(
      `SELECT d.id
       FROM documents d
       WHERE d.id IN (${placeholders})
         AND COALESCE(d.import_status, '') <> 'deleting'
         AND (
           NOT EXISTS (
             SELECT 1
             FROM search_index_status s
             WHERE s.doc_id = d.id
               AND s.status = 'ready'
           )
           OR EXISTS (
             SELECT 1
             FROM search_index_status s
             WHERE s.doc_id = d.id
               AND s.status IN ('queued', 'processing', 'pending', 'error')
           )
         )`,
      chunk,
    )
    for (const row of rows) {
      if (row.id && !isSearchIndexUsableForDocument(row.id)) needing.push(row.id)
    }
  }
  return needing
}

function markSearchIndexPendingForRecoveredDocuments(docIds: string[]): void {
  const uniqueDocIds = [...new Set(docIds.map((docId) => String(docId || '').trim()).filter(Boolean))]
  if (uniqueDocIds.length === 0) return

  const now = new Date().toISOString()
  for (let index = 0; index < uniqueDocIds.length; index += 200) {
    const chunk = uniqueDocIds.slice(index, index + 200)
    const placeholders = chunk.map(() => '?').join(', ')
    // Status-only gate: do not TRIM/scan page text bodies during open recovery.
    const searchableDocIds = queryAll<{ id: string }>(
      `SELECT d.id
       FROM documents d
       WHERE d.id IN (${placeholders})
         AND COALESCE(d.import_status, '') <> 'deleting'`,
      chunk,
    ).map((row) => row.id).filter(Boolean)
    if (searchableDocIds.length === 0) continue

    searchableDocIds.forEach((docId) => {
      run(
        `INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET
           status = excluded.status,
           error_message = excluded.error_message,
           updated_at = excluded.updated_at`,
        [docId, 'pending', '', 0, null, null, now],
      )
    })
  }
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function metadataPageCount(metadata: Record<string, unknown>): number {
  const value = Number(metadata.pdf_page_count || metadata.page_count || 0)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function completedPageContentPredicate(alias = 'p'): string {
  return `(
    TRIM(COALESCE(NULLIF(${alias}.proofed_text, ''), NULLIF(${alias}.ocr_text, ''), '')) <> ''
    OR TRIM(COALESCE(${alias}.proofed_text_ref, ${alias}.ocr_text_ref, '')) <> ''
    OR (
      COALESCE(${alias}.ocr_status, '') = 'completed'
      AND TRIM(COALESCE(${alias}.ocr_result_ref, '')) <> ''
    )
    OR (
      TRIM(COALESCE(${alias}.ocr_result, '')) <> ''
      AND TRIM(COALESCE(${alias}.ocr_result, '')) <> '{"externalized":true}'
      AND NOT (
        COALESCE(${alias}.ocr_result, '') LIKE '%"error"%'
        AND COALESCE(${alias}.ocr_result, '') LIKE '%"failed_at"%'
      )
    )
  )`
}

function summarizeDocumentPages(docId: string): { total: number; completed: number } {
  const row = queryAll<{ total: number; completed: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN ocr_status = 'completed' AND ${completedPageContentPredicate('pages')} THEN 1 ELSE 0 END) as completed
     FROM pages
     WHERE doc_id = ?`,
    [docId],
  )[0]
  return {
    total: Number(row?.total || 0),
    completed: Number(row?.completed || 0),
  }
}

function markInterruptedImportForCleanup(docId: string, message: string): void {
  run(
    `UPDATE documents
     SET import_status = 'deleting',
         error_message = ?,
         updated_at = ?
     WHERE id = ?
       AND COALESCE(import_status, '') <> 'deleting'`,
    [message.slice(0, 1000), new Date().toISOString(), docId],
  )
}

function updateRecoveredPdfMetadataPageCount(
  docId: string,
  currentMetadata: Record<string, unknown>,
  pageCount: number,
  pageRecordsDeferred: boolean,
): void {
  const safePageCount = Math.max(0, Math.floor(Number(pageCount || 0)))
  if (safePageCount <= 0) return

  const metadata = {
    ...currentMetadata,
    pdf_page_count: safePageCount,
    pdf_asset_state: currentMetadata.pdf_asset_state || 'available',
    pdf_asset_deleted_at: null,
    pdf_page_records_deferred: pageRecordsDeferred ? true : undefined,
  }
  if (!pageRecordsDeferred) delete metadata.pdf_page_records_deferred
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(metadata), new Date().toISOString(), docId])
}

function shouldDeferStartupPdfPageRecordInit(pageCount: number, pageStats: { total: number; completed: number }): boolean {
  const safePageCount = Math.max(0, Math.floor(Number(pageCount || 0)))
  return safePageCount > STARTUP_PDF_PAGE_RECORD_INIT_LIMIT && pageStats.total < safePageCount
}

async function insertMissingPdfPageRecords(docId: string, pageCount: number): Promise<number> {
  const safePageCount = Math.max(0, Math.floor(Number(pageCount || 0)))
  if (safePageCount <= 0) return 0

  const now = new Date().toISOString()
  const existingPageNums = new Set(
    queryAll<{ page_num: number | null }>(
      'SELECT page_num FROM pages WHERE doc_id = ? AND page_num BETWEEN 1 AND ?',
      [docId, safePageCount],
    )
      .map((row) => Number(row.page_num || 0))
      .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0),
  )

  let inserted = 0
  const rows: Array<{ id: string; pageNum: number }> = []
  for (let pageNum = 1; pageNum <= safePageCount; pageNum += 1) {
    if (existingPageNums.has(pageNum)) continue
    rows.push({ id: nanoid(), pageNum })
  }

  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200)
    if (chunk.length === 0) continue
    transaction(() => {
      chunk.forEach((row) => {
        run(
          'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [row.id, docId, row.pageNum, null, null, null, null, 'pending', 'pending', now],
        )
        inserted += 1
      })
    })
    if (index + 200 < rows.length) {
      await yieldToEventLoop()
      if (startupRecoveryCancelRequested) break
    }
  }

  return inserted
}

async function repairInterruptedImports(): Promise<{ repairedDocuments: number; initializedPageRecords: number }> {
  const candidates = queryAll<InterruptedImportDocumentRow>(
    `SELECT id, file_path, page_count, ocr_status, import_status, doc_type, metadata
     FROM documents
     WHERE COALESCE(import_status, '') <> 'deleting'
       AND (
         COALESCE(import_status, '') IN ('processing', 'unstored', '')
         OR (
           lower(file_path) LIKE '%.pdf'
           AND COALESCE(ocr_status, '') IN ('queued', 'processing')
         )
         OR (
           lower(file_path) LIKE '%.pdf'
           AND COALESCE(page_count, 0) <= 0
         )
         OR (
           lower(file_path) LIKE '%.pdf'
           AND
           COALESCE(page_count, 0) > 0
           AND (SELECT COUNT(*) FROM pages p WHERE p.doc_id = documents.id) < COALESCE(page_count, 0)
           AND COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.pdf_page_records_deferred') ELSE 0 END, 0) <> 1
         )
         OR (
           lower(file_path) NOT LIKE '%.pdf'
           AND
           COALESCE(page_count, 0) > 0
           AND (SELECT COUNT(*) FROM pages p WHERE p.doc_id = documents.id) < COALESCE(page_count, 0)
         )
       )`,
  )

  let repairedDocuments = 0
  let initializedPageRecords = 0
  const repairedDocIds: string[] = []
  for (const doc of candidates) {
    if (startupRecoveryCancelRequested) break
    const filePath = String(doc.file_path || '').trim()
    const metadata = parseMetadata(doc.metadata)
    const ext = extname(filePath).toLowerCase()
    const isPdf = ext === '.pdf'
    const isImage = RECOVERABLE_IMAGE_EXTENSIONS.has(ext)
    const pageStats = summarizeDocumentPages(doc.id)
    const expectedPageCount = Math.max(Number(doc.page_count || 0), metadataPageCount(metadata))
    const hasIncompletePageRows = expectedPageCount > 0 && pageStats.total < expectedPageCount
    if (!filePath || !existsSync(filePath)) {
      const hasExpectedCompletedPages = expectedPageCount > 0
        && pageStats.total >= expectedPageCount
        && pageStats.completed >= expectedPageCount
      if (hasExpectedCompletedPages) {
        run(
          `UPDATE documents
           SET ocr_status = 'completed',
               import_status = 'processed',
               error_message = NULL,
               metadata_status = COALESCE(NULLIF(metadata_status, ''), 'pending'),
               updated_at = ?
           WHERE id = ?
             AND COALESCE(import_status, '') <> 'deleting'`,
          [new Date().toISOString(), doc.id],
        )
        repairedDocuments += 1
        repairedDocIds.push(doc.id)
        continue
      }

      if (hasIncompletePageRows || String(doc.import_status || '') === 'processing') {
        markInterruptedImportForCleanup(
          doc.id,
          '上次导入在写入文件或页面记录时中断，库内记录不完整；请重新导入原文件。',
        )
        repairedDocuments += 1
      }
      continue
    }

    const wasCompleted = String(doc.ocr_status || '') === 'completed'
    if (!isPdf) {
      if (isImage && pageStats.total === 0) {
        run(
          'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [nanoid(), doc.id, 1, filePath, null, null, null, 'pending', 'pending', new Date().toISOString()],
        )
        initializedPageRecords += 1
        run(
          `UPDATE documents
           SET page_count = 1,
               thumb_path = COALESCE(NULLIF(thumb_path, ''), ?),
               ocr_status = CASE WHEN ocr_status = 'completed' THEN 'completed' ELSE 'pending' END,
               import_status = CASE WHEN ocr_status = 'completed' THEN 'processed' ELSE 'stored' END,
               error_message = NULL,
               metadata_status = COALESCE(NULLIF(metadata_status, ''), 'pending'),
               updated_at = ?
           WHERE id = ?
             AND COALESCE(import_status, '') <> 'deleting'`,
          [filePath, new Date().toISOString(), doc.id],
        )
        repairedDocuments += 1
        repairedDocIds.push(doc.id)
        continue
      }

      if (hasIncompletePageRows) {
        markInterruptedImportForCleanup(
          doc.id,
          '上次导入在写入页面/章节记录时中断，已保存内容不完整；请重新导入原文件。',
        )
        repairedDocuments += 1
        continue
      }

      const completedFromPages = pageStats.total > 0 && pageStats.completed === pageStats.total
      const nextOcrStatus = wasCompleted || completedFromPages ? 'completed' : 'pending'
      const nextImportStatus = nextOcrStatus === 'completed' ? 'processed' : 'stored'
      run(
        `UPDATE documents
         SET ocr_status = ?,
             import_status = ?,
             error_message = NULL,
             metadata_status = COALESCE(NULLIF(metadata_status, ''), 'pending'),
             updated_at = ?
         WHERE id = ?
           AND COALESCE(import_status, '') <> 'deleting'`,
        [nextOcrStatus, nextImportStatus, new Date().toISOString(), doc.id],
      )
      repairedDocuments += 1
      if (nextOcrStatus === 'completed') repairedDocIds.push(doc.id)
      continue
    }

    const knownPageCount = Math.max(Number(doc.page_count || 0), metadataPageCount(metadata))
    const fastPageCount = knownPageCount > 0 ? knownPageCount : Number(await getPdfPageCountFast(filePath) || 0)
    const pageCount = Number.isFinite(fastPageCount) && fastPageCount > 0 ? Math.floor(fastPageCount) : 0
    const now = new Date().toISOString()

    if (pageCount > 0) {
      const deferPageRecords = shouldDeferStartupPdfPageRecordInit(pageCount, pageStats)
      const insertedPageRecords = deferPageRecords ? 0 : await insertMissingPdfPageRecords(doc.id, pageCount)
      initializedPageRecords += insertedPageRecords
      run(
        `UPDATE documents
         SET page_count = ?,
             ocr_status = CASE WHEN ? > 0 OR ? > 0 THEN 'pending' WHEN ocr_status = 'completed' THEN 'completed' ELSE 'pending' END,
             import_status = CASE WHEN ? > 0 OR ? > 0 THEN 'stored' WHEN ocr_status = 'completed' THEN 'processed' ELSE 'stored' END,
             error_message = NULL,
             metadata_status = COALESCE(NULLIF(metadata_status, ''), 'pending'),
             updated_at = ?
         WHERE id = ?
           AND COALESCE(import_status, '') <> 'deleting'`,
        [pageCount, insertedPageRecords, deferPageRecords ? 1 : 0, insertedPageRecords, deferPageRecords ? 1 : 0, now, doc.id],
      )
      updateRecoveredPdfMetadataPageCount(doc.id, metadata, pageCount, deferPageRecords)
    } else {
      run(
        `UPDATE documents
         SET ocr_status = CASE WHEN ocr_status = 'completed' THEN 'completed' ELSE 'pending' END,
             import_status = CASE WHEN ocr_status = 'completed' THEN 'processed' ELSE 'stored' END,
             error_message = NULL,
             updated_at = ?
         WHERE id = ?
           AND COALESCE(import_status, '') <> 'deleting'`,
        [now, doc.id],
      )
    }
    repairedDocuments += 1
    repairedDocIds.push(doc.id)
    if (startupRecoveryCancelRequested) break
  }

  markSearchIndexPendingForRecoveredDocuments(repairedDocIds)

  return { repairedDocuments, initializedPageRecords }
}

async function removeOrphanStorageDirs(): Promise<number> {
  const storageRoot = join(getDataDir(), 'storage')
  if (!existsSync(storageRoot)) return 0

  // Large libraries: scanning/deleting storage trees on open causes sustained disk
  // I/O with a frozen UI (CPU near 0%, disk high). Skip automatic orphan cleanup;
  // manual maintenance / next idle session can reclaim later.
  const documentCount = Number(queryAll<{ count: number }>('SELECT COUNT(*) as count FROM documents')[0]?.count || 0)
  if (documentCount >= 200) {
    console.log(`[Startup Recovery] Skipping orphan storage cleanup on open for large library (documents=${documentCount})`)
    return 0
  }

  const knownDocIds = new Set(queryAll<{ id: string }>('SELECT id FROM documents').map((row) => row.id).filter(Boolean))
  const entries = await readdir(storageRoot, { withFileTypes: true })
  let removed = 0
  let scanned = 0
  for (const entry of entries) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith('.')) continue
    if (RESERVED_STORAGE_DIR_NAMES.has(entry.name)) continue
    if (knownDocIds.has(entry.name)) continue
    if (removed >= ORPHAN_STORAGE_CLEANUP_MAX_PER_STARTUP) {
      console.log(`[Startup Recovery] Orphan storage cleanup capped at ${ORPHAN_STORAGE_CLEANUP_MAX_PER_STARTUP} dirs for this startup`)
      break
    }
    const targetPath = join(storageRoot, entry.name)
    const decision = inspectManagedDeleteTarget({
      dataDir: getDataDir(),
      docId: entry.name,
      targetPath,
      kind: 'document-root',
    })
    if (!decision.allowed || !decision.canonicalTarget) {
      console.warn(`[Startup Recovery] Skipped unsafe orphan cleanup for ${entry.name}: ${decision.reason || 'unknown-reason'}`)
      continue
    }
    await rm(decision.canonicalTarget, { recursive: true, force: true })
    removed += 1
    scanned += 1
    if (scanned % ORPHAN_STORAGE_CLEANUP_YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
      if (startupRecoveryCancelRequested) break
    }
  }
  return removed
}

async function recoverInterruptedPdfCompressionSources(): Promise<number> {
  // Limit cold-start recovery work. Full-library PDF existsSync walks make
  // just-opened windows look frozen on large corpora.
  const MAX_PDF_COMPRESSION_RECOVERY_CANDIDATES = 80
  const rows = queryAll<DocumentFilePathRow>(
    `SELECT id, file_path
     FROM documents
     WHERE COALESCE(import_status, '') <> 'deleting'
       AND lower(COALESCE(file_path, '')) LIKE '%.pdf'
       AND (
         COALESCE(import_status, '') IN ('processing', 'unstored', '')
         OR COALESCE(error_message, '') LIKE '%压缩%'
         OR lower(COALESCE(error_message, '')) LIKE '%compression%'
         OR COALESCE(error_message, '') LIKE '%qpdf%'
         OR COALESCE(error_message, '') LIKE '%.original-%'
       )
     ORDER BY updated_at DESC
     LIMIT ?`,
    [MAX_PDF_COMPRESSION_RECOVERY_CANDIDATES],
  )

  let recovered = 0
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const filePath = String(row.file_path || '').trim()
    if (!filePath || existsSync(filePath)) {
      if (index % 20 === 0) {
        await yieldToEventLoop()
        if (startupRecoveryCancelRequested) break
      }
      continue
    }

    const storageDir = dirname(filePath)
    if (!existsSync(storageDir)) continue

    const entries = await readdir(storageDir, { withFileTypes: true }).catch(() => [])
    const candidates = (
      await Promise.all(entries
        .filter((entry) => entry.isFile() && /^\.original-\d+-[a-z0-9]+\.pdf$/i.test(entry.name))
        .map(async (entry) => {
          const path = join(storageDir, entry.name)
          const info = await stat(path).catch(() => null)
          return info && info.size > 0 ? { path, mtimeMs: info.mtimeMs } : null
        }))
    )
      .filter((item): item is { path: string; mtimeMs: number } => Boolean(item))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)

    const source = candidates[0]
    if (!source) continue

    await rename(source.path, filePath)
    run('UPDATE documents SET file_path = ?, error_message = NULL, updated_at = ? WHERE id = ?', [
      filePath,
      new Date().toISOString(),
      row.id,
    ])
    recovered += 1
    await yieldToEventLoop()
    if (startupRecoveryCancelRequested) break
  }

  return recovered
}

async function removeStartupTempDirs(recoveryStartedAtMs: number): Promise<number> {
  let removed = 0
  const roots = [
    { path: tmpdir(), pattern: /^gujismart-ocr-/ },
    { path: join(getDataDir(), 'temp'), pattern: /^pdf-compression$/ },
  ]

  for (const root of roots) {
    if (!existsSync(root.path)) continue
    const entries = await readdir(root.path, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !root.pattern.test(entry.name)) continue
      const tempPath = join(root.path, entry.name)
      const info = await stat(tempPath).catch(() => null)
      if (info && info.mtimeMs >= recoveryStartedAtMs) continue
      await rm(tempPath, { recursive: true, force: true })
      removed += 1
      if (removed % ORPHAN_STORAGE_CLEANUP_YIELD_INTERVAL === 0) {
        await yieldToEventLoop()
        if (startupRecoveryCancelRequested) break
      }
    }
    if (startupRecoveryCancelRequested) break
  }

  return removed
}

export async function runStartupRecovery(): Promise<StartupRecoverySummary> {
  const recoveryStartedAtMs = Date.now()
  const endRecovery = beginStartupPhase('startup-recovery')
  emitStartupRecoveryStatus({
    status: 'processing',
    progress: 0.05,
    message: '正在恢复上次未完成的任务',
  })
  let ocr = createEmptyOcrRecoverySummary()
  let resetSearchIndexJobs = 0
  let resetSearchIndexDocIds: string[] = []
  let resetAiLayoutCacheRows = 0
  let resetTranslationCacheRows = 0
  let completedOcrDocuments = 0
  let deletingDocuments: InterruptedDocumentDeleteRecoverySummary = { queuedDocuments: 0, cleanupTasks: 0 }
  let recoveredPdfCompressionSources = 0
  let reindexedRecoveredOcrDocuments = 0
  let removedTempDirs = 0
  let orphanStorageDirs = 0
  let resumedBatchQueue: BatchQueueResumeSummary = { resumedJobs: 0, resumedItems: 0, completedItems: 0, skippedItems: 0 }
  let interruptedImports = { repairedDocuments: 0, initializedPageRecords: 0 }

  const finishCanceled = (): StartupRecoverySummary => {
    const summary: StartupRecoverySummary = {
      ocr,
      deletingDocuments,
      canceled: true,
      completedOcrDocuments,
      repairedInterruptedImports: interruptedImports.repairedDocuments,
      initializedPdfPageRecords: interruptedImports.initializedPageRecords,
      recoveredPdfCompressionSources,
      reindexedRecoveredOcrDocuments,
      resumedBatchQueue,
      resetSearchIndexJobs,
      resetAiLayoutCacheRows,
      resetTranslationCacheRows,
      orphanStorageDirs,
      removedTempDirs,
    }
    if (
      resetSearchIndexJobs > 0
      || resetAiLayoutCacheRows > 0
      || resetTranslationCacheRows > 0
      || completedOcrDocuments > 0
      || interruptedImports.repairedDocuments > 0
      || interruptedImports.initializedPageRecords > 0
      || recoveredPdfCompressionSources > 0
      || reindexedRecoveredOcrDocuments > 0
      || removedTempDirs > 0
      || orphanStorageDirs > 0
      || ocr.recoveredDocuments > 0
      || ocr.recoveredPages > 0
      || ocr.recoveredCompletedPages > 0
      || ocr.recoveredBatchItems > 0
      || ocr.removedOrphanedBatchItems > 0
    ) {
      scheduleDatabaseSave({ minDelayMs: 30_000 })
    }
    emitStartupRecoveryStatus({
      status: 'completed',
      progress: 1,
      message: '启动恢复已暂停，下次打开会继续检查未完成任务',
    })
    markStartupEvent('startup-recovery-canceled')
    logStartupTimingSummary('startup-recovery-canceled', true)
    try {
      keepStartupSplashForDiagnostics({ reason: 'recovery-canceled' })
    } catch {
      // ignore
    }
    return summary
  }

  try {

  // One short yield so ready-to-show / first paint can land, then run the critical
  // DB recovery path without intermediate setImmediate yields. Frequent yields were
  // letting large-library renderer IPC monopolize the main thread for minutes while
  // "启动恢复（整体）" stayed open and looked like recovery SQL was slow.
  if (await startupRecoveryCheckpoint()) return finishCanceled()

  // Critical path: no intermediate setImmediate. Keep sub-phases for diagnostics only.
  {
    const endPhase = beginStartupPhase('startup-recovery.ocr-jobs')
    try {
      ocr = recoverInterruptedOcrJobs()
    } finally {
      endPhase()
    }
  }

  {
    const endPhase = beginStartupPhase('startup-recovery.reset-interrupted-jobs')
    try {
      transaction(() => {
        resetSearchIndexDocIds = resetInterruptedSearchIndexJobs()
        resetSearchIndexJobs = resetSearchIndexDocIds.length
        resetAiLayoutCacheRows = resetInterruptedAiLayoutCacheRows()
        resetTranslationCacheRows = resetInterruptedTranslationCacheRows()
      })
    } finally {
      endPhase()
    }
  }

  emitStartupRecoveryStatus({
    status: 'processing',
    progress: 0.45,
    message: '正在修复中断的导入记录',
  })
  {
    const endPhase = beginStartupPhase('startup-recovery.pdf-compression-sources')
    try {
      recoveredPdfCompressionSources = await recoverInterruptedPdfCompressionSources()
    } finally {
      endPhase()
    }
  }
  {
    const endPhase = beginStartupPhase('startup-recovery.interrupted-imports')
    try {
      interruptedImports = await repairInterruptedImports()
    } finally {
      endPhase()
    }
  }

  {
    const endPhase = beginStartupPhase('startup-recovery.reconcile-completed-ocr')
    try {
      transaction(() => {
        completedOcrDocuments = reconcileCompletedOcrDocuments()
      })
    } finally {
      endPhase()
    }
  }

  emitStartupRecoveryStatus({
    status: 'processing',
    progress: 0.75,
    message: '正在恢复搜索索引和清理孤立文件',
  })
  // Mark search status only. Do NOT schedule background reindex during recovery —
  // reindex workers rewrite large segment tables and dominate disk right after open.
  // Never full-scan pages content for "documents needing index" — only the IDs we
  // already touched in this recovery pass.
  {
    const endPhase = beginStartupPhase('startup-recovery.search-status')
    try {
      markSearchIndexPendingForRecoveredDocuments(resetSearchIndexDocIds)
      const recoveredOcrSearchDocIds = findRecoveredOcrDocumentsNeedingSearchIndex(resetSearchIndexDocIds)
      reindexedRecoveredOcrDocuments = recoveredOcrSearchDocIds.length
      markSearchIndexPendingForRecoveredDocuments(recoveredOcrSearchDocIds)
      const deferredReindexDocIds = [...new Set([...resetSearchIndexDocIds, ...recoveredOcrSearchDocIds].filter(Boolean))]
      if (deferredReindexDocIds.length > 0) {
        setTimeout(() => {
          try {
            markSearchIndexStaleForDocuments(deferredReindexDocIds)
            console.log(`[Startup Recovery] Deferred search reindex queued for ${deferredReindexDocIds.length} document(s)`)
          } catch (error) {
            console.warn('[Startup Recovery] Deferred search reindex failed', error)
          }
        }, 90_000).unref?.()
      }
    } finally {
      endPhase()
    }
  }

  {
    const endPhase = beginStartupPhase('startup-recovery.resume-deletes')
    try {
      deletingDocuments = resumeInterruptedDocumentDeletes()
    } finally {
      endPhase()
    }
  }

  // FS cleanup can take longer; yield once so UI stays responsive, then finish.
  if (await startupRecoveryCheckpoint()) return finishCanceled()
  emitStartupRecoveryStatus({
    status: 'processing',
    progress: 0.85,
    message: '正在清理临时与孤立文件',
  })
  {
    const endPhase = beginStartupPhase('startup-recovery.temp-dirs')
    try {
      removedTempDirs = await removeStartupTempDirs(recoveryStartedAtMs)
    } finally {
      endPhase()
    }
  }
  if (await startupRecoveryCheckpoint()) return finishCanceled()
  {
    const endPhase = beginStartupPhase('startup-recovery.orphan-storage')
    try {
      orphanStorageDirs = await removeOrphanStorageDirs()
    } finally {
      endPhase()
    }
  }
  // Count interrupted batch items only. Actual worker start is deferred in main
  // (BATCH_OCR_RESUME_DELAY_MS) so first paint stays responsive; bulk OCR then
  // continues automatically without requiring a manual click.
  const pendingBatchRows = queryAll<{ id: string; batch_id: string | null }>(
    `SELECT b.id, b.batch_id
     FROM batch_queue b
     INNER JOIN documents d ON d.id = b.doc_id
     WHERE b.status IN ('pending', 'processing')
       AND COALESCE(d.import_status, '') <> 'deleting'`,
  )
  resumedBatchQueue = {
    resumedJobs: new Set(pendingBatchRows.map((row) => String(row.batch_id || 'default'))).size,
    resumedItems: pendingBatchRows.length,
    completedItems: 0,
    skippedItems: 0,
  }
  if (pendingBatchRows.length > 0) {
    console.log(
      `[Startup Recovery] ${pendingBatchRows.length} batch OCR item(s) queued for deferred auto-resume after interactive grace`,
    )
  }

  if (
    resetSearchIndexJobs > 0
    || resetAiLayoutCacheRows > 0
    || resetTranslationCacheRows > 0
    || completedOcrDocuments > 0
    || interruptedImports.repairedDocuments > 0
    || interruptedImports.initializedPageRecords > 0
    || recoveredPdfCompressionSources > 0
    || reindexedRecoveredOcrDocuments > 0
    || removedTempDirs > 0
    || orphanStorageDirs > 0
    || deletingDocuments.queuedDocuments > 0
    || resumedBatchQueue.resumedItems > 0
    || resumedBatchQueue.completedItems > 0
    || resumedBatchQueue.skippedItems > 0
    || ocr.recoveredDocuments > 0
    || ocr.recoveredPages > 0
    || ocr.recoveredCompletedPages > 0
    || ocr.recoveredBatchItems > 0
    || ocr.removedOrphanedBatchItems > 0
  ) {
    // Long delay: keep UI interactive after recovery mutations.
    scheduleDatabaseSave({ minDelayMs: 30_000 })
    console.log(
      `[Startup Recovery] OCR docs=${ocr.recoveredDocuments}, pages=${ocr.recoveredPages}, completedPages=${ocr.recoveredCompletedPages}, ` +
      `batch=${ocr.recoveredBatchItems}; orphanBatch=${ocr.removedOrphanedBatchItems}; ` +
      `resumedBatchQueue=${resumedBatchQueue.resumedItems}/${resumedBatchQueue.resumedJobs}; ` +
      `delete resumes=${deletingDocuments.queuedDocuments}; ` +
      `completedOcr=${completedOcrDocuments}; interruptedImports=${interruptedImports.repairedDocuments}; ` +
      `pdfPages=${interruptedImports.initializedPageRecords}; ` +
      `pdfCompressionSources=${recoveredPdfCompressionSources}; recoveredOcrSearch=${reindexedRecoveredOcrDocuments}; ` +
      `tempDirs=${removedTempDirs}; ` +
      `search=${resetSearchIndexJobs}; aiLayout=${resetAiLayoutCacheRows}; ` +
      `translation=${resetTranslationCacheRows}; orphanStorage=${orphanStorageDirs}`,
    )
  }

  const summary = {
    ocr,
    deletingDocuments,
    completedOcrDocuments,
    repairedInterruptedImports: interruptedImports.repairedDocuments,
    initializedPdfPageRecords: interruptedImports.initializedPageRecords,
    recoveredPdfCompressionSources,
    reindexedRecoveredOcrDocuments,
    resumedBatchQueue,
    resetSearchIndexJobs,
    resetAiLayoutCacheRows,
    resetTranslationCacheRows,
    orphanStorageDirs,
    removedTempDirs,
  }

  emitStartupRecoveryStatus({
    status: 'completed',
    progress: 1,
    message: '已恢复上次未完成的任务',
    totalCount:
      ocr.recoveredDocuments
      + ocr.recoveredCompletedPages
      + ocr.removedOrphanedBatchItems
      + deletingDocuments.queuedDocuments
      + resumedBatchQueue.resumedItems
      + resumedBatchQueue.completedItems
      + resumedBatchQueue.skippedItems
      + completedOcrDocuments
      + interruptedImports.repairedDocuments
      + recoveredPdfCompressionSources
      + reindexedRecoveredOcrDocuments
      + resetSearchIndexJobs
      + resetAiLayoutCacheRows
      + resetTranslationCacheRows
      + removedTempDirs
      + orphanStorageDirs,
    completedCount:
      ocr.recoveredDocuments
      + ocr.recoveredCompletedPages
      + ocr.removedOrphanedBatchItems
      + deletingDocuments.queuedDocuments
      + resumedBatchQueue.resumedItems
      + resumedBatchQueue.completedItems
      + resumedBatchQueue.skippedItems
      + completedOcrDocuments
      + interruptedImports.repairedDocuments
      + recoveredPdfCompressionSources
      + reindexedRecoveredOcrDocuments
      + resetSearchIndexJobs
      + resetAiLayoutCacheRows
      + resetTranslationCacheRows
      + removedTempDirs
      + orphanStorageDirs,
  })

  markStartupEvent(
    'startup-recovery-complete',
    `batchPending=${resumedBatchQueue.resumedItems} ocrDocs=${ocr.recoveredDocuments} orphanStorage=${orphanStorageDirs}`,
  )
  logStartupTimingSummary('startup-recovery-complete', true)
  // Test build: leave diagnostic splash open with full phase table for remote screenshot feedback.
  try {
    keepStartupSplashForDiagnostics({
      reason: `recovery-complete batchPending=${resumedBatchQueue.resumedItems} ocrDocs=${ocr.recoveredDocuments}`,
    })
  } catch (error) {
    console.warn('[Startup Recovery] Failed to finalize diagnostic splash', error)
  }
  return summary
  } finally {
    endRecovery()
  }
}

export function scheduleStartupRecovery(): void {
  if (startupRecoveryRunning) return
  startupRecoveryRunning = true
  startupRecoveryCancelRequested = false
  emitStartupRecoveryStatus({
    status: 'queued',
    progress: 0,
    message: '准备检查上次未完成的任务',
  })
  // Explicit timed wait so the diagnostic UI accounts for the 8s grace (otherwise wall clock ≫ sum of work ms).
  const endRecoveryDelay = beginStartupPhase('startup-recovery-delay')
  markStartupEvent('startup-recovery-delay', `delayMs=${STARTUP_RECOVERY_DELAY_MS}`)
  startupRecoveryPromise = new Promise((resolve) => {
    setTimeout(() => {
      endRecoveryDelay()
      markStartupEvent('startup-recovery-begin')
      void runStartupRecovery()
      .catch((error) => {
        console.warn('[Main] Startup recovery failed', error)
        emitStartupRecoveryStatus({
          status: 'error',
          progress: 1,
          message: '启动恢复失败，可重启后再试',
          errorMessage: (error as Error)?.message || String(error || '启动恢复失败'),
        })
        logStartupTimingSummary('startup-recovery-error', true)
      })
      .finally(() => {
        startupRecoveryRunning = false
        startupRecoveryPromise = null
        resolve()
      })
    }, STARTUP_RECOVERY_DELAY_MS).unref?.()
  })
}

export async function shutdownStartupRecovery(): Promise<void> {
  if (!startupRecoveryPromise) return
  startupRecoveryCancelRequested = true
  await startupRecoveryPromise
}
