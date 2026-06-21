import { existsSync } from 'fs'
import { readdir, rename, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, extname, join } from 'path'
import { getDataDir, queryAll, run, saveDatabase, transaction } from './database'
import { recoverInterruptedOcrJobs, type OcrRecoverySummary } from './ocr-recovery'
import { resumeInterruptedDocumentDeletes, type InterruptedDocumentDeleteRecoverySummary } from './ipc/documents'
import { batchProcessor, type BatchQueueResumeSummary } from './batch-processor'
import { getPdfPageCountFast } from './pdf-info'
import { isSearchIndexReindexQueuedInMemory, isSearchIndexUsableForDocument, markSearchIndexStaleForDocuments } from './semantic-search'
import { emitBackgroundTaskStatus } from './background-tasks'
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
const STARTUP_PDF_PAGE_RECORD_INIT_LIMIT = 1000
const RESERVED_STORAGE_DIR_NAMES = new Set(['page-payloads'])

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

async function startupRecoveryCheckpoint(): Promise<boolean> {
  await yieldToEventLoop()
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
  const count = countRows("SELECT COUNT(*) as count FROM page_translation_cache WHERE status = 'processing'")
  if (count <= 0) return 0
  run(
    `UPDATE page_translation_cache
     SET status = 'error',
         error_message = ?,
         updated_at = ?
     WHERE status = 'processing'`,
    ['Interrupted by previous app shutdown; restart translation to continue cache generation.', new Date().toISOString()],
  )
  return count
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
  const rows = queryAll<{ id: string }>(
    `SELECT d.id
     FROM documents d
     WHERE COALESCE(d.import_status, '') <> 'deleting'
       AND COALESCE(d.page_count, 0) > 0
       AND (
         COALESCE(d.ocr_status, '') <> 'completed'
         OR COALESCE(d.import_status, '') <> 'processed'
         OR d.error_message IS NOT NULL
       )
       AND (
         SELECT COUNT(*)
         FROM pages p
         WHERE p.doc_id = d.id
           AND (
             p.ocr_status = 'completed'
             OR ${completedPageContentPredicate('p')}
           )
       ) >= COALESCE(d.page_count, 0)`,
  )
  const docIds = rows.map((row) => row.id).filter(Boolean)
  if (docIds.length === 0) return 0

  const placeholders = docIds.map(() => '?').join(', ')
  run(
    `UPDATE documents
     SET ocr_status = 'completed',
         import_status = 'processed',
         error_message = NULL,
         updated_at = ?
     WHERE id IN (${placeholders})`,
    [new Date().toISOString(), ...docIds],
  )
  markSearchIndexPendingForRecoveredDocuments(docIds)
  return docIds.length
}

function findRecoveredOcrDocumentsNeedingSearchIndex(): string[] {
  return queryAll<{ id: string }>(
    `SELECT DISTINCT d.id
     FROM documents d
     WHERE COALESCE(d.import_status, '') <> 'deleting'
       AND EXISTS (
         SELECT 1
         FROM pages p
         WHERE p.doc_id = d.id
           AND ${completedPageContentPredicate('p')}
       )
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
  ).map((row) => row.id).filter((docId) => docId && !isSearchIndexUsableForDocument(docId))
}

function markSearchIndexPendingForRecoveredDocuments(docIds: string[]): void {
  const uniqueDocIds = [...new Set(docIds.map((docId) => String(docId || '').trim()).filter(Boolean))]
  if (uniqueDocIds.length === 0) return

  for (let index = 0; index < uniqueDocIds.length; index += 200) {
    const chunk = uniqueDocIds.slice(index, index + 200)
    const placeholders = chunk.map(() => '?').join(', ')
    const searchableDocIds = queryAll<{ id: string }>(
      `SELECT d.id
       FROM documents d
       WHERE d.id IN (${placeholders})
         AND COALESCE(d.import_status, '') <> 'deleting'
         AND EXISTS (
           SELECT 1
           FROM pages p
           WHERE p.doc_id = d.id
             AND ${completedPageContentPredicate('p')}
         )`,
      chunk,
    ).map((row) => row.id).filter(Boolean)
    if (searchableDocIds.length === 0) continue

    const now = new Date().toISOString()
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
  return `TRIM(COALESCE(NULLIF(${alias}.proofed_text, ''), NULLIF(${alias}.ocr_text, ''), NULLIF(${alias}.ocr_result, ''), '')) <> ''`
}

function summarizeDocumentPages(docId: string): { total: number; completed: number } {
  const row = queryAll<{ total: number; completed: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN ocr_status = 'completed' OR ${completedPageContentPredicate('pages')} THEN 1 ELSE 0 END) as completed
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

  const knownDocIds = new Set(queryAll<{ id: string }>('SELECT id FROM documents').map((row) => row.id).filter(Boolean))
  const entries = await readdir(storageRoot, { withFileTypes: true })
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (RESERVED_STORAGE_DIR_NAMES.has(entry.name)) continue
    if (knownDocIds.has(entry.name)) continue
    await rm(join(storageRoot, entry.name), { recursive: true, force: true })
    removed += 1
    if (removed % ORPHAN_STORAGE_CLEANUP_YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
      if (startupRecoveryCancelRequested) break
    }
  }
  return removed
}

async function recoverInterruptedPdfCompressionSources(): Promise<number> {
  const rows = queryAll<DocumentFilePathRow>(
    `SELECT id, file_path
     FROM documents
     WHERE COALESCE(import_status, '') <> 'deleting'
       AND lower(COALESCE(file_path, '')) LIKE '%.pdf'`,
  )

  let recovered = 0
  for (const row of rows) {
    const filePath = String(row.file_path || '').trim()
    if (!filePath || existsSync(filePath)) continue

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
      saveDatabase()
    }
    emitStartupRecoveryStatus({
      status: 'completed',
      progress: 1,
      message: '启动恢复已暂停，下次打开会继续检查未完成任务',
    })
    return summary
  }

  if (await startupRecoveryCheckpoint()) return finishCanceled()
  ocr = recoverInterruptedOcrJobs()
  if (await startupRecoveryCheckpoint()) return finishCanceled()

  transaction(() => {
    resetSearchIndexDocIds = resetInterruptedSearchIndexJobs()
    resetSearchIndexJobs = resetSearchIndexDocIds.length
    resetAiLayoutCacheRows = resetInterruptedAiLayoutCacheRows()
    resetTranslationCacheRows = resetInterruptedTranslationCacheRows()
  })
  if (await startupRecoveryCheckpoint()) return finishCanceled()

  emitStartupRecoveryStatus({
    status: 'processing',
    progress: 0.45,
    message: '正在修复中断的导入记录',
  })
  recoveredPdfCompressionSources = await recoverInterruptedPdfCompressionSources()
  if (await startupRecoveryCheckpoint()) return finishCanceled()
  interruptedImports = await repairInterruptedImports()
  if (await startupRecoveryCheckpoint()) return finishCanceled()

  transaction(() => {
    completedOcrDocuments = reconcileCompletedOcrDocuments()
  })
  if (await startupRecoveryCheckpoint()) return finishCanceled()

  emitStartupRecoveryStatus({
    status: 'processing',
    progress: 0.75,
    message: '正在恢复搜索索引和清理孤立文件',
  })
  markSearchIndexStaleForDocuments(resetSearchIndexDocIds)
  const recoveredOcrSearchDocIds = (
    ocr.recoveredDocuments > 0
    || ocr.recoveredPages > 0
    || ocr.completedDocuments > 0
    || completedOcrDocuments > 0
  )
    ? findRecoveredOcrDocumentsNeedingSearchIndex()
    : []
  reindexedRecoveredOcrDocuments = recoveredOcrSearchDocIds.length
  markSearchIndexStaleForDocuments(recoveredOcrSearchDocIds)

  removedTempDirs = await removeStartupTempDirs(recoveryStartedAtMs)
  if (await startupRecoveryCheckpoint()) return finishCanceled()
  orphanStorageDirs = await removeOrphanStorageDirs()
  if (await startupRecoveryCheckpoint()) return finishCanceled()

  emitStartupRecoveryStatus({
    status: 'processing',
    progress: 0.9,
    message: '正在接续未完成的删除任务',
  })
  deletingDocuments = resumeInterruptedDocumentDeletes()
  resumedBatchQueue = batchProcessor.resumePendingQueueFromDatabase()

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
    saveDatabase()
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

  return summary
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
  startupRecoveryPromise = new Promise((resolve) => {
    setImmediate(() => {
      void runStartupRecovery()
      .catch((error) => {
        console.warn('[Main] Startup recovery failed', error)
        emitStartupRecoveryStatus({
          status: 'error',
          progress: 1,
          message: '启动恢复失败，可重启后再试',
          errorMessage: (error as Error)?.message || String(error || '启动恢复失败'),
        })
      })
      .finally(() => {
        startupRecoveryRunning = false
        startupRecoveryPromise = null
        resolve()
      })
    })
  })
}

export async function shutdownStartupRecovery(): Promise<void> {
  if (!startupRecoveryPromise) return
  startupRecoveryCancelRequested = true
  await startupRecoveryPromise
}
