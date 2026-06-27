import { queryAll, queryOne, run, saveDatabase, transaction } from './database'

export interface OcrRecoverySummary {
  recoveredDocuments: number
  recoveredPages: number
  recoveredCompletedPages: number
  recoveredBatchItems: number
  removedOrphanedBatchItems: number
  completedDocuments: number
  pendingDocuments: number
}

interface PageStatusSummary {
  total: number
  completed: number
}

interface RecoveryDocumentRow {
  id: string
  page_count: number | null
  metadata: string | null
}

type JsonRecord = Record<string, unknown>

function countRows(sql: string, params?: unknown[]): number {
  return Number(queryOne<{ count: number }>(sql, params)?.count || 0)
}

function summarizePages(docId: string): PageStatusSummary {
  const row = queryOne<PageStatusSummary>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN ocr_status = 'completed' AND ${completedPageContentPredicate('pages')} THEN 1 ELSE 0 END) as completed
     FROM pages
     WHERE doc_id = ?`,
    [docId],
  )
  return {
    total: Number(row?.total || 0),
    completed: Number(row?.completed || 0),
  }
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

function parseJsonRecord(value: unknown): JsonRecord | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null
  } catch {
    return null
  }
}

function getExpectedPageCount(doc: Pick<RecoveryDocumentRow, 'page_count' | 'metadata'>, stats: PageStatusSummary): number {
  const metadata = parseJsonRecord(doc.metadata) || {}
  const metadataPageCount = Number(metadata.pdf_page_count || metadata.page_count || 0)
  return Math.max(
    stats.total,
    Number(doc.page_count || 0) || 0,
    Number.isFinite(metadataPageCount) ? Math.floor(metadataPageCount) : 0,
  )
}

export function recoverInterruptedOcrJobs(): OcrRecoverySummary {
  const interruptedDocs = queryAll<RecoveryDocumentRow>(
    `SELECT DISTINCT d.id
          , d.page_count
          , d.metadata
     FROM documents d
     LEFT JOIN pages p ON p.doc_id = d.id AND p.ocr_status IN ('queued', 'processing')
     WHERE COALESCE(d.import_status, '') <> 'deleting'
       AND (
         d.ocr_status IN ('queued', 'processing')
         OR d.import_status = 'processing'
         OR p.id IS NOT NULL
         OR EXISTS (
           SELECT 1
           FROM pages content_page
           WHERE content_page.doc_id = d.id
             AND COALESCE(content_page.ocr_status, '') <> 'completed'
             AND ${completedPageContentPredicate('content_page')}
         )
         OR EXISTS (
           SELECT 1
           FROM pages invalid_completed_page
           WHERE invalid_completed_page.doc_id = d.id
             AND COALESCE(invalid_completed_page.ocr_status, '') = 'completed'
             AND NOT (${completedPageContentPredicate('invalid_completed_page')})
         )
       )`,
  ).filter((row) => row.id)
  const interruptedDocIds = interruptedDocs.map((row) => row.id)

  const recoveredCompletedPages = countRows(
    `SELECT COUNT(*) as count
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE COALESCE(p.ocr_status, '') <> 'completed'
       AND COALESCE(d.import_status, '') <> 'deleting'
       AND ${completedPageContentPredicate('p')}`,
  )
  const recoveredPages = countRows(
    `SELECT COUNT(*) as count
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE p.ocr_status IN ('queued', 'processing')
       AND COALESCE(d.import_status, '') <> 'deleting'
       AND NOT (${completedPageContentPredicate('p')})`,
  )
  const invalidCompletedPages = countRows(
    `SELECT COUNT(*) as count
     FROM pages p
     INNER JOIN documents d ON d.id = p.doc_id
     WHERE p.ocr_status = 'completed'
       AND COALESCE(d.import_status, '') <> 'deleting'
       AND NOT (${completedPageContentPredicate('p')})`,
  )
  const recoveredBatchItems = countRows("SELECT COUNT(*) as count FROM batch_queue WHERE status IN ('queued', 'processing')")
  const removedOrphanedBatchItems = countRows(
    `SELECT COUNT(*) as count
     FROM batch_queue
     WHERE doc_id NOT IN (SELECT id FROM documents)`,
  )

  const summary: OcrRecoverySummary = {
    recoveredDocuments: interruptedDocIds.length,
    recoveredPages: recoveredPages + invalidCompletedPages,
    recoveredCompletedPages,
    recoveredBatchItems,
    removedOrphanedBatchItems,
    completedDocuments: 0,
    pendingDocuments: 0,
  }

  if (
    summary.recoveredDocuments === 0
    && recoveredPages === 0
    && recoveredCompletedPages === 0
    && recoveredBatchItems === 0
    && removedOrphanedBatchItems === 0
  ) {
    return summary
  }

  const now = new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE pages
       SET ocr_status = 'completed'
       WHERE COALESCE(ocr_status, '') <> 'completed'
         AND doc_id IN (
           SELECT id FROM documents WHERE COALESCE(import_status, '') <> 'deleting'
         )
         AND ${completedPageContentPredicate('pages')}`,
    )

    run(
      `UPDATE pages
       SET ocr_status = 'pending'
       WHERE (
           ocr_status IN ('queued', 'processing')
           OR (
             ocr_status = 'completed'
             AND NOT (${completedPageContentPredicate('pages')})
           )
         )
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

    run('DELETE FROM batch_queue WHERE doc_id NOT IN (SELECT id FROM documents)')

    for (const doc of interruptedDocs) {
      const stats = summarizePages(doc.id)
      const expectedPageCount = getExpectedPageCount(doc, stats)
      const ocrStatus = expectedPageCount > 0 && stats.total >= expectedPageCount && stats.completed >= expectedPageCount ? 'completed' : 'pending'
      const importStatus = ocrStatus === 'completed' ? 'processed' : 'stored'
      if (ocrStatus === 'completed') summary.completedDocuments += 1
      else summary.pendingDocuments += 1

      run(
        `UPDATE documents
         SET ocr_status = ?,
             import_status = ?,
             error_message = NULL,
             updated_at = ?
         WHERE id = ?
           AND COALESCE(import_status, '') <> 'deleting'`,
        [ocrStatus, importStatus, now, doc.id],
      )
    }
  })

  saveDatabase()
  console.log(
    `[OCR Recovery] Recovered ${summary.recoveredDocuments} document(s), ` +
    `${summary.recoveredPages} in-flight page(s), ${summary.recoveredCompletedPages} completed page state(s), ` +
    `${summary.recoveredBatchItems} batch item(s), ` +
    `removed ${summary.removedOrphanedBatchItems} orphaned batch item(s)`,
  )
  return summary
}
