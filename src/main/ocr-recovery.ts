import { queryAll, queryOne, run, scheduleDatabaseSave, transaction } from './database'

export interface OcrRecoverySummary {
  recoveredDocuments: number
  recoveredPages: number
  recoveredCompletedPages: number
  recoveredBatchItems: number
  removedOrphanedBatchItems: number
  completedDocuments: number
  pendingDocuments: number
}

interface RecoveryDocumentRow {
  id: string
  page_count: number | null
}

function countRows(sql: string, params?: unknown[]): number {
  return Number(queryOne<{ count: number }>(sql, params)?.count || 0)
}

/**
 * Startup recovery must stay index-friendly.
 *
 * The previous implementation scanned/updated the entire `pages` table with
 * TRIM/COALESCE content predicates on every open. On large libraries that
 * causes multi-ten-minute freezes: high disk, ~0% CPU, window "Not Responding".
 *
 * Cold-start only resets clearly interrupted statuses (queued/processing).
 * Deeper content validation belongs in deferred maintenance, not open path.
 */
export function recoverInterruptedOcrJobs(): OcrRecoverySummary {
  // Prefer document-status index probes first. Avoid EXISTS-over-pages unless needed.
  const interruptedDocs = queryAll<RecoveryDocumentRow>(
    `SELECT d.id, d.page_count
     FROM documents d
     WHERE COALESCE(d.import_status, '') <> 'deleting'
       AND (
         d.ocr_status IN ('queued', 'processing')
         OR d.import_status = 'processing'
       )`,
  ).filter((row) => row.id)

  // Pages still marked in-flight even when document status already drifted.
  const orphanInFlightPageDocIds = queryAll<{ doc_id: string }>(
    `SELECT DISTINCT p.doc_id as doc_id
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE p.ocr_status IN ('queued', 'processing')
       AND COALESCE(d.import_status, '') <> 'deleting'
       AND COALESCE(d.ocr_status, '') NOT IN ('queued', 'processing')
       AND COALESCE(d.import_status, '') <> 'processing'`,
  ).map((row) => row.doc_id).filter(Boolean)

  const seen = new Set(interruptedDocs.map((row) => row.id))
  for (const docId of orphanInFlightPageDocIds) {
    if (seen.has(docId)) continue
    seen.add(docId)
    interruptedDocs.push({ id: docId, page_count: null })
  }

  const interruptedPageCount = countRows(
    `SELECT COUNT(*) as count
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE p.ocr_status IN ('queued', 'processing')
       AND COALESCE(d.import_status, '') <> 'deleting'`,
  )
  const inFlightBatchItems = countRows(
    "SELECT COUNT(*) as count FROM batch_queue WHERE status IN ('queued', 'processing')",
  )
  const removedOrphanedBatchItems = countRows(
    `SELECT COUNT(*) as count
     FROM batch_queue b
     WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = b.doc_id)`,
  )

  const summary: OcrRecoverySummary = {
    recoveredDocuments: interruptedDocs.length,
    recoveredPages: interruptedPageCount,
    recoveredCompletedPages: 0,
    recoveredBatchItems: inFlightBatchItems,
    removedOrphanedBatchItems,
    completedDocuments: 0,
    pendingDocuments: 0,
  }

  if (
    summary.recoveredDocuments === 0
    && interruptedPageCount === 0
    && inFlightBatchItems === 0
    && removedOrphanedBatchItems === 0
  ) {
    return summary
  }

  const now = new Date().toISOString()

  transaction(() => {
    // Only reset clearly in-flight page rows. No full-table content predicate rewrites.
    // Skip pages for documents currently being deleted.
    run(
      `UPDATE pages
       SET ocr_status = 'pending'
       WHERE ocr_status IN ('queued', 'processing')
         AND doc_id IN (
           SELECT id FROM documents WHERE COALESCE(import_status, '') <> 'deleting'
         )`,
    )

    run(
      `UPDATE batch_queue
       SET status = 'pending',
           progress = 0,
           error_message = NULL,
           started_at = NULL,
           completed_at = NULL
       WHERE status IN ('queued', 'processing')`,
    )

    run(
      `DELETE FROM batch_queue
       WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = batch_queue.doc_id)`,
    )

    for (const doc of interruptedDocs) {
      // Keep document pending so the bounded OCR worker pool can resume later.
      // Do not re-scan page text content on open.
      run(
        `UPDATE documents
         SET ocr_status = 'pending',
             import_status = CASE
               WHEN COALESCE(import_status, '') = 'processing' THEN 'stored'
               ELSE import_status
             END,
             error_message = COALESCE(error_message, '应用上次退出时 OCR 未完成，可继续识别'),
             updated_at = ?
         WHERE id = ?
           AND COALESCE(import_status, '') <> 'deleting'`,
        [now, doc.id],
      )
      summary.pendingDocuments += 1
    }
  })

  // Never checkpoint here — large WAL rewrite freezes open.
  scheduleDatabaseSave({ minDelayMs: 60_000 })
  console.log(
    `[OCR Recovery] Light recovery: ${summary.recoveredDocuments} document(s), ` +
    `${summary.recoveredPages} in-flight page(s), ` +
    `${summary.recoveredBatchItems} batch item(s), ` +
    `removed ${summary.removedOrphanedBatchItems} orphaned batch item(s)`,
  )
  return summary
}
