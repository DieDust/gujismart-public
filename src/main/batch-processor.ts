import { BrowserWindow } from 'electron'
import { nanoid } from 'nanoid'
import { autoExtractAndApply } from './ai'
import { queryAll, queryOne, run, saveDatabase, scheduleDatabaseSave, transaction } from './database'
import {
  OcrAbortError,
  getOcrDocumentConcurrency,
  getPageImageSize,
  isOcrAbortError,
  postProcessRecognizedPageResult,
  recognizePages,
  recognizePdfAsync,
  shouldUseAsyncPdfOcr,
} from './ocr'
import { globalOcrDocumentWindow } from './ocr-document-window'
import { markSearchIndexStaleForPages, notifySearchContentChanged } from './semantic-search'
import { preparePagePayloadUpdate } from './page-payload-store'
import {
  cancelLegacyBatchTask,
  completeLegacyBatchItem,
  failLegacyBatchItem,
  hasActiveLegacyBatchClaim,
  pauseLegacyBatchTask,
  releaseAllLegacyBatchClaims,
  releaseLegacyBatchItem,
  resumeLegacyBatchTask,
  startLegacyBatchItem,
} from './task-batch-compat'
import { bridgeLegacyBatchQueue } from './task-scheduler'
import type { OcrPageResult } from './ocr'
import type { BatchJob, BatchProgressEvent, Document, DocumentPage, PageOcrOptions } from '../shared/types'

type BatchDocumentRow = Document
type BatchPageRow = DocumentPage
type JsonRecord = Record<string, unknown>

export interface BatchQueueResumeSummary {
  resumedJobs: number
  resumedItems: number
  completedItems: number
  skippedItems: number
}

interface BatchQueueResumeRow {
  id: string
  batch_id: string
  doc_id: string
  batch_size: number | null
}

const BATCH_PAGE_INSERT_CHUNK_SIZE = 50
const BATCH_RESULT_SAVE_CHUNK_SIZE = 12
const BATCH_RESULT_POSTPROCESS_CHUNK_SIZE = 12
const BATCH_GUJI_ASYNC_PDF_PAGE_RANGE_CHUNK_SIZE = 25
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))
const ZERO_PAGE_OCR_ERROR = 'OCR 没有返回任何页面，已按异常处理。请重新导入原文件或重新 OCR；如果仍为 0 页，可在文献库使用“清除零页文献”清理空记录。'

function pageContentAvailableCondition(alias = 'p'): string {
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

function getTextFromUnknown(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim()
  }
  return ''
}

function getBatchDocumentOcrReviewMessage(docId: string): string {
  const rows = queryAll<{ page_num: number | null; ocr_result: string | null }>(
    `SELECT page_num, ocr_result
     FROM pages
     WHERE doc_id = ? AND ocr_status = 'error'
     ORDER BY page_num
     LIMIT 3`,
    [docId],
  )
  const messages = rows
    .map((row) => {
      const parsed = parseJsonRecord(row.ocr_result)
      const errorMessage = String(parsed?.error || parsed?.message || '').trim()
      return errorMessage
        ? `第 ${row.page_num || '?'} 页：${errorMessage}`
        : `第 ${row.page_num || '?'} 页 OCR 需要复核`
    })
    .filter(Boolean)
  return messages.length > 0
    ? `部分页面 OCR 需要复核，文献已按识别完成保存：${messages.join('；')}`
    : '部分页面 OCR 需要复核，文献已按识别完成保存。'
}

function getMarkdownTextFromUnknown(value: unknown): string {
  const directText = getTextFromUnknown(value)
  if (directText) return directText
  const record = parseJsonRecord(value)
  if (!record) return ''
  return getTextFromUnknown(record.text)
}

function getOcrWordsText(result: unknown): string {
  const record = parseJsonRecord(result)
  if (!record) return ''
  const text = getTextFromUnknown(record.text)
  if (text) return text
  const markdownText = getMarkdownTextFromUnknown(record.markdown)
  if (markdownText) return markdownText
  const wordsResult = record.words_result
  if (!Array.isArray(wordsResult)) return ''
  return wordsResult
    .map((item) => {
      const word = parseJsonRecord(item)
      return getTextFromUnknown(word?.words)
    })
    .filter(Boolean)
    .join('\n')
}

function getAsyncPdfPostProcessOptions(ocrOptions: Required<PageOcrOptions>): Required<PageOcrOptions> {
  if (ocrOptions.profile !== 'guji_print_vertical') return ocrOptions
  return {
    ...ocrOptions,
    secondPass: 'none',
  }
}

function clearDeferredPdfPageRecordMarker(docId: string): void {
  const row = queryOne<{ metadata: string | null }>('SELECT metadata FROM documents WHERE id = ?', [docId])
  const metadata = parseJsonRecord(row?.metadata) || {}
  if (metadata.pdf_page_records_deferred === undefined) return
  delete metadata.pdf_page_records_deferred
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(metadata), new Date().toISOString(), docId])
}

class BatchProcessor {
  private jobs = new Map<string, BatchJob>()
  private queueItemIdsByJob = new Map<string, Map<string, string>>()
  private activeControllers = new Set<AbortController>()
  private activeControllersByJob = new Map<string, Set<AbortController>>()
  private activeJobRuns = new Set<Promise<void>>()
  private mainWindow: BrowserWindow | null = null
  private processing = false
  private shuttingDown = false

  private resolveOcrOptions(docType?: string | null): Required<PageOcrOptions> {
    return docType === '\u53e4\u7c4d'
      ? { profile: 'guji_print_vertical' as const, secondPass: 'local_segmentation' as const, imageRotation: 0 as const }
      : { profile: 'general' as const, secondPass: 'none' as const, imageRotation: 0 as const }
  }

  private async ensurePageRecords(docId: string, pageCount: number): Promise<BatchPageRow[]> {
    const safePageCount = Math.max(0, Math.round(Number(pageCount || 0)))
    if (safePageCount <= 0) {
      return queryAll<BatchPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
    }

    const now = new Date().toISOString()
    const existingPageNums = new Set(
      queryAll<{ page_num: number | null }>('SELECT page_num FROM pages WHERE doc_id = ? AND page_num BETWEEN 1 AND ?', [docId, safePageCount])
        .map((row) => Number(row.page_num || 0))
        .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0),
    )
    for (let index = 0; index < safePageCount; index += BATCH_PAGE_INSERT_CHUNK_SIZE) {
      const pageNums = Array.from(
        { length: Math.min(BATCH_PAGE_INSERT_CHUNK_SIZE, safePageCount - index) },
        (_, offset) => index + offset + 1,
      ).filter((pageNum) => !existingPageNums.has(pageNum))
      if (pageNums.length === 0) {
        if (index + BATCH_PAGE_INSERT_CHUNK_SIZE < safePageCount) {
          await yieldToEventLoop()
        }
        continue
      }
      transaction(() => {
        pageNums.forEach((pageNum) => {
          run(
            'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [nanoid(), docId, pageNum, null, null, null, null, 'pending', 'pending', now],
          )
          existingPageNums.add(pageNum)
        })
      })
      if (index + BATCH_PAGE_INSERT_CHUNK_SIZE < safePageCount) {
        await yieldToEventLoop()
      }
    }

    run('UPDATE documents SET page_count = CASE WHEN page_count > ? THEN page_count ELSE ? END, updated_at = ? WHERE id = ?', [
      safePageCount,
      safePageCount,
      now,
      docId,
    ])
    clearDeferredPdfPageRecordMarker(docId)
    scheduleDatabaseSave()
    return queryAll<BatchPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
  }

  private hasSequentialPageRecords(pages: BatchPageRow[], pageCount: number): boolean {
    const safePageCount = Math.max(0, Math.round(Number(pageCount || 0)))
    if (safePageCount <= 0 || pages.length < safePageCount) return false
    for (let index = 0; index < safePageCount; index += 1) {
      if (Number(pages[index]?.page_num || 0) !== index + 1) return false
    }
    return true
  }

  private async ensurePageRecordsIfNeeded(docId: string, pages: BatchPageRow[], pageCount: number): Promise<BatchPageRow[]> {
    return this.hasSequentialPageRecords(pages, pageCount) ? pages : this.ensurePageRecords(docId, pageCount)
  }

  private getExpectedPdfPageCount(doc: Pick<BatchDocumentRow, 'page_count' | 'metadata'> | null | undefined, pages: BatchPageRow[] = []): number {
    const metadata = parseJsonRecord(doc?.metadata) || {}
    const metadataPageCount = Number(metadata.pdf_page_count || metadata.page_count || 0)
    return Math.max(
      pages.length,
      Number(doc?.page_count || 0) || 0,
      Number.isFinite(metadataPageCount) ? Math.floor(metadataPageCount) : 0,
    )
  }

  private isPageOcrCompleted(page: Pick<BatchPageRow, 'ocr_status' | 'proofed_text' | 'ocr_text' | 'ocr_result' | 'proofed_text_ref' | 'ocr_text_ref' | 'ocr_result_ref'>): boolean {
    const inlineText = String(page.proofed_text || page.ocr_text || '').trim()
    const textRefs = String(page.proofed_text_ref || page.ocr_text_ref || '').trim()
    const resultRef = String(page.ocr_result_ref || '').trim()
    const result = String(page.ocr_result || '').trim()
    const hasInlineText = Boolean(inlineText && inlineText !== '{"externalized":true}')
    const hasUsableResult = Boolean(result && result !== '{"externalized":true}' && !(/"error"\s*:/.test(result) && /"failed_at"\s*:/.test(result)))
    return String(page?.ocr_status || '') === 'completed' && (hasInlineText || Boolean(textRefs) || Boolean(resultRef) || hasUsableResult)
  }

  private getPagesNeedingOcr(pages: BatchPageRow[]): BatchPageRow[] {
    return pages.filter((page) => !this.isPageOcrCompleted(page))
  }

  private async savePageResults(pageResults: OcrPageResult[], options: { deferSearchRefresh?: boolean; deferDatabaseSave?: boolean } = {}): Promise<string[]> {
    if (pageResults.length === 0) return []

    const changedPageIds: string[] = []
    for (let index = 0; index < pageResults.length; index += BATCH_RESULT_SAVE_CHUNK_SIZE) {
      const chunk = pageResults.slice(index, index + BATCH_RESULT_SAVE_CHUNK_SIZE)
      transaction(() => {
        const pageIds = chunk.map((pageResult) => pageResult.pageId).filter(Boolean)
        const placeholders = pageIds.map(() => '?').join(', ')
        const pageById = new Map((placeholders
          ? queryAll<Pick<BatchPageRow, 'id' | 'doc_id'>>(`SELECT id, doc_id FROM pages WHERE id IN (${placeholders})`, pageIds)
          : []
        ).map((page) => [page.id, page]))
        chunk.forEach((pageResult) => {
          if (pageResult.status === 'error') {
            console.error(`[Batch] Page OCR failed: ${pageResult.pageId}`, pageResult.error)
          }
          const page = pageById.get(pageResult.pageId)
          if (!page) return
          const preparedResult = preparePagePayloadUpdate(
            page.doc_id,
            pageResult.pageId,
            'ocr_result',
            pageResult.result ? JSON.stringify(pageResult.result) : null,
          )
          const preparedText = preparePagePayloadUpdate(page.doc_id, pageResult.pageId, 'ocr_text', pageResult.text)

          run(
            `UPDATE pages SET ocr_result = ?, ocr_result_ref = ?, ocr_text = ?, ocr_text_ref = ?, ocr_status = ?,
             proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END
             WHERE id = ?`,
            [
              preparedResult.value,
              preparedResult.ref,
              preparedText.value,
              preparedText.ref,
              pageResult.status,
              pageResult.pageId,
            ],
          )
          changedPageIds.push(pageResult.pageId)
        })
      })

      if (index + BATCH_RESULT_SAVE_CHUNK_SIZE < pageResults.length) {
        await yieldToEventLoop()
      }
    }

    if (!options.deferSearchRefresh) {
      markSearchIndexStaleForPages(changedPageIds)
      notifySearchContentChanged()
    }
    if (!options.deferDatabaseSave) {
      scheduleDatabaseSave()
    }
    return changedPageIds
  }

  private async postProcessPdfResultsBatched(
    pages: Array<{ page: BatchPageRow; sourcePageIndex: number; resultIndex: number }>,
    results: Array<unknown | null>,
    ocrOptions: Required<PageOcrOptions>,
    signal?: AbortSignal,
  ): Promise<OcrPageResult[]> {
    const pageResults: OcrPageResult[] = []
    const postProcessOptions = getAsyncPdfPostProcessOptions(ocrOptions)
    for (let index = 0; index < pages.length; index += BATCH_RESULT_POSTPROCESS_CHUNK_SIZE) {
      const chunk = pages.slice(index, index + BATCH_RESULT_POSTPROCESS_CHUNK_SIZE)
      const chunkResults = await Promise.all(chunk.map(async (item) => {
        if (signal?.aborted) throw new OcrAbortError()
        const rawResult = results[item.resultIndex] || null
        const result = rawResult
          ? await postProcessRecognizedPageResult(rawResult, item.page.image_path, postProcessOptions, {
            signal,
            preserveServiceCoordinates: true,
            serviceCoordinateFallbackSize: getPageImageSize(item.page.image_path),
          })
          : null
        return {
          pageId: item.page.id,
          result,
          text: getOcrWordsText(result),
          status: result ? 'completed' as const : 'error' as const,
          error: result ? undefined : `PaddleOCR async result returned fewer pages than expected: expected ${pages.length}, got ${results.length}`,
        }
      }))
      pageResults.push(...chunkResults)
      if (index + BATCH_RESULT_POSTPROCESS_CHUNK_SIZE < pages.length) {
        await yieldToEventLoop()
      }
    }
    return pageResults
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  createJob(docIds: string[], batchSize = 5, options?: { id?: string; queueItemIdsByDocId?: Map<string, string> }): BatchJob {
    const id = options?.id || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const existing = this.jobs.get(id)
    if (existing) return existing
    const job: BatchJob = {
      id,
      docIds,
      batchSize,
      currentBatch: 0,
      totalBatches: Math.ceil(docIds.length / batchSize),
      status: 'pending',
      processedCount: 0,
      failedCount: 0,
      startTime: null,
    }
    this.jobs.set(id, job)
    if (options?.queueItemIdsByDocId && options.queueItemIdsByDocId.size > 0) {
      this.queueItemIdsByJob.set(id, options.queueItemIdsByDocId)
    }
    return job
  }

  private getQueueItemId(job: BatchJob, docId: string): string | null {
    return this.queueItemIdsByJob.get(job.id)?.get(docId) || null
  }

  private updateQueueItemStatus(job: BatchJob, docId: string, status: 'processing' | 'completed' | 'failed', errorMessage?: string): void {
    const itemId = this.getQueueItemId(job, docId)
    if (!itemId) return
    if (status === 'processing') {
      startLegacyBatchItem(itemId, `batch-processor:${job.id}`)
      return
    }
    if (status === 'completed') {
      completeLegacyBatchItem(itemId, { message: errorMessage })
      return
    }
    failLegacyBatchItem(itemId, { errorMessage: errorMessage || 'OCR 处理失败', recoverable: true })
  }

  private resetQueueItemForResume(job: BatchJob, docId: string): void {
    const itemId = this.getQueueItemId(job, docId)
    const now = new Date().toISOString()
    if (itemId) {
      if (hasActiveLegacyBatchClaim(itemId)) {
        releaseLegacyBatchItem(itemId)
      } else {
        run(
          `UPDATE batch_queue
           SET status = 'pending',
               progress = 0,
               error_message = NULL,
               started_at = NULL,
               completed_at = NULL
           WHERE id = ?`,
          [itemId],
        )
      }
    }
    run(
      `UPDATE pages
       SET ocr_status = 'pending'
       WHERE doc_id = ?
         AND ocr_status IN ('queued', 'processing')`,
      [docId],
    )
    run(
      `UPDATE documents
       SET ocr_status = 'pending',
           import_status = 'stored',
           error_message = NULL,
           updated_at = ?
       WHERE id = ?
         AND COALESCE(import_status, '') <> 'deleting'`,
      [now, docId],
    )
    scheduleDatabaseSave()
  }

  private reconcileFinishedQueueItems(): number {
    const ids = queryAll<{ id: string }>(
      `SELECT b.id
       FROM batch_queue b
       INNER JOIN documents d ON d.id = b.doc_id
       WHERE b.status IN ('pending', 'processing')
         AND COALESCE(d.import_status, '') <> 'deleting'
         AND COALESCE(d.page_count, 0) > 0
         AND (
           COALESCE(d.ocr_status, '') = 'completed'
           OR (
             SELECT COUNT(*)
             FROM pages p
             WHERE p.doc_id = d.id
               AND p.ocr_status = 'completed'
               AND ${pageContentAvailableCondition('p')}
           ) >= COALESCE(d.page_count, 0)
         )`,
    ).map((row) => row.id).filter(Boolean)
    if (ids.length === 0) return 0

    const now = new Date().toISOString()
    for (let index = 0; index < ids.length; index += 200) {
      const chunk = ids.slice(index, index + 200)
      const placeholders = chunk.map(() => '?').join(', ')
      run(
        `UPDATE batch_queue
         SET status = 'completed',
             progress = 100,
             error_message = NULL,
             completed_at = COALESCE(completed_at, ?)
         WHERE id IN (${placeholders})`,
        [now, ...chunk],
      )
    }
    scheduleDatabaseSave()
    return ids.length
  }

  resumePendingQueueFromDatabase(): BatchQueueResumeSummary {
    if (this.shuttingDown) {
      return { resumedJobs: 0, resumedItems: 0, completedItems: 0, skippedItems: 0 }
    }
    const completedItems = this.reconcileFinishedQueueItems()
    bridgeLegacyBatchQueue()
    const skippedItems = queryAll<{ id: string }>(
      `SELECT b.id
       FROM batch_queue b
       LEFT JOIN documents d ON d.id = b.doc_id
       WHERE b.status IN ('pending', 'processing')
         AND (d.id IS NULL OR COALESCE(d.import_status, '') = 'deleting')`,
    ).length
    run(
      `DELETE FROM batch_queue
       WHERE status IN ('pending', 'processing')
         AND doc_id NOT IN (SELECT id FROM documents)`,
    )

    const rows = queryAll<BatchQueueResumeRow>(
      `SELECT b.id, b.batch_id, b.doc_id, b.batch_size
       FROM batch_queue b
       INNER JOIN documents d ON d.id = b.doc_id
       WHERE b.status IN ('pending', 'processing')
         AND COALESCE(d.import_status, '') <> 'deleting'
       ORDER BY COALESCE(b.created_at, ''), b.rowid`,
    )

    const groups = new Map<string, BatchQueueResumeRow[]>()
    rows.forEach((row) => {
      const batchId = String(row.batch_id || 'default')
      groups.set(batchId, [...(groups.get(batchId) || []), row])
    })

    let resumedJobs = 0
    let resumedItems = 0
    groups.forEach((items, batchId) => {
      const docIds = [...new Set(items.map((item) => item.doc_id).filter(Boolean))]
      if (docIds.length === 0) return
      const queueItemIdsByDocId = new Map<string, string>()
      items.forEach((item) => {
        if (!queueItemIdsByDocId.has(item.doc_id)) queueItemIdsByDocId.set(item.doc_id, item.id)
      })
      const batchSize = Math.max(1, Number(items[0]?.batch_size || 5) || 5)
      const taskJobId = queryOne<{ id: string }>(
        'SELECT id FROM task_jobs WHERE kind = ? AND idempotency_key = ?',
        ['ocr.batch', `legacy:batch_queue:${batchId}`],
      )?.id
      const job = this.createJob(docIds, batchSize, {
        id: taskJobId || `resume_${batchId}`,
        queueItemIdsByDocId,
      })
      resumedJobs += 1
      resumedItems += docIds.length
      void this.startJob(job.id)
    })

    return { resumedJobs, resumedItems, completedItems, skippedItems }
  }

  async startJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('任务不存在')
    if (job.status === 'running') return
    if (this.shuttingDown) {
      job.status = 'paused'
      this.sendProgress(job)
      return
    }

    const run = this.runJob(job)
    this.activeJobRuns.add(run)
    try {
      await run
    } finally {
      this.activeJobRuns.delete(run)
    }
  }

  private async runJob(job: BatchJob): Promise<void> {
    job.status = 'running'
    if (!job.startTime) {
      job.startTime = Date.now()
    }
    this.processing = true
    this.sendProgress(job)

    try {
      for (let batchIndex = 0; batchIndex < job.totalBatches; batchIndex += 1) {
        if (job.status !== 'running' || this.shuttingDown) break
        job.currentBatch = batchIndex + 1
        const start = batchIndex * job.batchSize
        const end = Math.min(start + job.batchSize, job.docIds.length)
        await this.processBatch(job, job.docIds.slice(start, end))
        this.sendProgress(job)
      }

      if (job.status === 'running' && !this.shuttingDown) {
        job.status = 'completed'
      } else if (job.status === 'running' && this.shuttingDown) {
        job.status = 'paused'
      }
    } catch (error) {
      console.error('[Batch] Job failed:', error)
      job.status = 'error'
    } finally {
      this.processing = [...this.jobs.values()].some((item) => item.status === 'running')
      this.sendProgress(job)
      this.queueItemIdsByJob.delete(job.id)
    }
  }

  private async processBatch(job: BatchJob, docIds: string[]): Promise<void> {
    for (const docId of docIds) {
      if (job.status !== 'running' || this.shuttingDown) return
      await globalOcrDocumentWindow.run(getOcrDocumentConcurrency(), async () => {
      const controller = new AbortController()
      this.activeControllers.add(controller)
      const jobControllers = this.activeControllersByJob.get(job.id) || new Set<AbortController>()
      jobControllers.add(controller)
      this.activeControllersByJob.set(job.id, jobControllers)

      try {
        this.updateQueueItemStatus(job, docId, 'processing')
        run(
          'UPDATE documents SET ocr_status = ?, import_status = ?, metadata_status = ?, updated_at = ? WHERE id = ?',
          ['processing', 'processing', 'pending', new Date().toISOString(), docId],
        )
        scheduleDatabaseSave()

        const doc = queryOne<BatchDocumentRow>('SELECT * FROM documents WHERE id = ?', [docId])
        let pages = queryAll<BatchPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
        let pagesForOcr = this.getPagesNeedingOcr(pages)
        const ocrOptions = this.resolveOcrOptions(doc?.doc_type)
        const pdfPath = typeof doc?.file_path === 'string' ? doc.file_path : null
        const expectedPdfPageCount = this.getExpectedPdfPageCount(doc, pages)
        const canUsePdfAsync = shouldUseAsyncPdfOcr(pdfPath, Math.max(pagesForOcr.length, pages.length, expectedPdfPageCount))

        if (pages.length === 0 && !canUsePdfAsync) {
          run(
            'UPDATE documents SET ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
            ['error', 'error', ZERO_PAGE_OCR_ERROR, new Date().toISOString(), docId],
          )
          scheduleDatabaseSave()
          job.failedCount += 1
          this.updateQueueItemStatus(job, docId, 'failed', ZERO_PAGE_OCR_ERROR)
          this.sendProgress(job)
          return
        }
        if (pages.length > 0 && pagesForOcr.length === 0 && this.hasSequentialPageRecords(pages, expectedPdfPageCount)) {
          run('UPDATE documents SET ocr_status = ?, import_status = ?, error_message = NULL, updated_at = ? WHERE id = ?', [
            'completed',
            'processed',
            new Date().toISOString(),
            docId,
          ])
          scheduleDatabaseSave()
          job.processedCount += 1
          this.updateQueueItemStatus(job, docId, 'completed')
          this.sendProgress(job)
          return
        }

        let pageResults: OcrPageResult[] = []
        let pageResultsPersistedInChunks = false
        let streamedPageSummary = { total: 0, completed: 0, failed: 0, pending: 0 }
        const deferredChangedPageIds = new Set<string>()
        let deferredDatabaseSaveNeeded = false
        if (canUsePdfAsync && pdfPath) {
          if (!this.hasSequentialPageRecords(pages, expectedPdfPageCount)) {
            pages = await this.ensurePageRecordsIfNeeded(docId, pages, expectedPdfPageCount)
            pagesForOcr = this.getPagesNeedingOcr(pages)
          }
          const savedPageIds = new Set(pages.filter((page) => this.isPageOcrCompleted(page)).map((page) => page.id))
          const failedPageIds = new Set<string>()
          const targetPageNums = pagesForOcr.length > 0
            ? pagesForOcr
              .map((page) => Number(page.page_num))
              .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0)
            : undefined
          const requireFullFileUpload = false
          const pageRangeChunkSize = ocrOptions.profile === 'guji_print_vertical'
            ? BATCH_GUJI_ASYNC_PDF_PAGE_RANGE_CHUNK_SIZE
            : undefined
          const targetPageNumSet = new Set(targetPageNums || [])
          const results = await recognizePdfAsync(pdfPath, undefined, {
            fallbackPageCount: Math.max(pages.length, Number(doc?.page_count || 0) || 0),
            signal: controller.signal,
            ocrOptions,
            requireFullFileUpload,
            pageRangeChunkSize,
            targetPageNums,
            collectChunkResults: false,
            onChunkComplete: async (chunk) => {
              if (controller.signal.aborted) throw new OcrAbortError()
              pages = await this.ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, chunk.totalPages))
              pagesForOcr = this.getPagesNeedingOcr(pages)
              const chunkPages = chunk.sourcePageIndexes
                .map((sourcePageIndex, resultIndex) => ({
                  page: pages[sourcePageIndex],
                  sourcePageIndex,
                  resultIndex: requireFullFileUpload ? sourcePageIndex : resultIndex,
                }))
                .filter((item): item is { page: BatchPageRow; sourcePageIndex: number; resultIndex: number } => {
                  if (!item.page) return false
                  if (!requireFullFileUpload || targetPageNumSet.size === 0) return true
                  return targetPageNumSet.has(Number(item.page.page_num || item.sourcePageIndex + 1))
                })
              const chunkPageResults = await this.postProcessPdfResultsBatched(
                chunkPages,
                chunk.results,
                ocrOptions,
                controller.signal,
              )
              if (controller.signal.aborted) throw new OcrAbortError()
              const changedPageIds = await this.savePageResults(chunkPageResults, {
                deferSearchRefresh: true,
                deferDatabaseSave: true,
              })
              changedPageIds.forEach((pageId) => deferredChangedPageIds.add(pageId))
              if (changedPageIds.length > 0) deferredDatabaseSaveNeeded = true
              chunkPageResults.forEach((pageResult) => {
                if (pageResult.status === 'completed') {
                  savedPageIds.add(pageResult.pageId)
                  failedPageIds.delete(pageResult.pageId)
                } else if (pageResult.status === 'error') {
                  failedPageIds.add(pageResult.pageId)
                }
              })
              const total = Math.max(pages.length, chunk.totalPages, Number(doc?.page_count || 0) || 0)
              streamedPageSummary = {
                total,
                completed: savedPageIds.size,
                failed: failedPageIds.size,
                pending: Math.max(0, total - savedPageIds.size - failedPageIds.size),
              }
              pageResultsPersistedInChunks = true
            },
          })
          if (!pageResultsPersistedInChunks) {
            pages = await this.ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, results.length))
            pagesForOcr = this.getPagesNeedingOcr(pages)
            pageResults = await this.postProcessPdfResultsBatched(
              pagesForOcr.map((page, index) => {
                const sourcePageIndex = Number(page.page_num || index + 1) - 1
                return { page, sourcePageIndex, resultIndex: requireFullFileUpload ? sourcePageIndex : index }
              }),
              results,
              ocrOptions,
              controller.signal,
            )
          }
        } else {
          pageResults = await recognizePages(pagesForOcr, ocrOptions, undefined, { signal: controller.signal })
        }

        if (!pageResultsPersistedInChunks && pageResults.length === 0) {
          throw new Error(ZERO_PAGE_OCR_ERROR)
        }
        const hasPendingPageFailure = pageResultsPersistedInChunks
          ? streamedPageSummary.pending > 0
          : false
        const hasReviewPageFailure = pageResultsPersistedInChunks
          ? streamedPageSummary.pending === 0 && streamedPageSummary.failed > 0
          : pageResults.some((item) => item.status === 'error')
        const hasPageFailure = hasPendingPageFailure
        if (!pageResultsPersistedInChunks) {
          await this.savePageResults(pageResults)
        } else if (deferredChangedPageIds.size > 0) {
          markSearchIndexStaleForPages([...deferredChangedPageIds])
          notifySearchContentChanged()
          if (deferredDatabaseSaveNeeded) scheduleDatabaseSave()
        }

        const reviewMessage = hasReviewPageFailure ? getBatchDocumentOcrReviewMessage(docId) : null
        run('UPDATE documents SET ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?', [
          hasPageFailure ? 'error' : 'completed',
          hasPageFailure ? 'error' : 'processed',
          hasPageFailure ? 'OCR page processing failed' : reviewMessage,
          new Date().toISOString(),
          docId,
        ])
        scheduleDatabaseSave()

        if (!hasPageFailure && !hasReviewPageFailure) {
          void autoExtractAndApply(docId)
            .then(() => {
              scheduleDatabaseSave()
            })
            .catch((error) => {
              console.error(`[Batch] AI extraction failed for ${docId}:`, error)
            })
        }

        if (hasPageFailure) {
          job.failedCount += 1
          this.updateQueueItemStatus(job, docId, 'failed', 'OCR page processing failed')
        } else {
          job.processedCount += 1
          this.updateQueueItemStatus(job, docId, 'completed', reviewMessage || undefined)
        }
      } catch (error) {
        if (job.status === 'canceled') return
        if (this.shuttingDown || isOcrAbortError(error)) {
          this.resetQueueItemForResume(job, docId)
          return
        }
        console.error(`[Batch] Document processing failed: ${docId}`, error)
        job.failedCount += 1
        const errorMessage = (error as Error)?.message || 'OCR 处理失败'
        run('UPDATE documents SET ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?', [
          'error',
          'error',
          errorMessage.slice(0, 1000),
          new Date().toISOString(),
          docId,
        ])
        scheduleDatabaseSave()
        this.updateQueueItemStatus(job, docId, 'failed', errorMessage)
      } finally {
        this.activeControllers.delete(controller)
        const controllers = this.activeControllersByJob.get(job.id)
        controllers?.delete(controller)
        if (controllers?.size === 0) this.activeControllersByJob.delete(job.id)
      }

      this.sendProgress(job)
      })
    }
  }

  pauseJob(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'running') return
    job.status = 'paused'
    pauseLegacyBatchTask(jobId)
    this.processing = [...this.jobs.values()].some((item) => item.status === 'running')
    this.sendProgress(job)
  }

  resumeJob(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'paused') return
    resumeLegacyBatchTask(jobId)
    void this.startJob(jobId)
  }

  cancelJob(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.status = 'canceled'
    cancelLegacyBatchTask(jobId)
    this.activeControllersByJob.get(jobId)?.forEach((controller) => controller.abort())
    this.jobs.delete(jobId)
    this.processing = [...this.jobs.values()].some((item) => item.status === 'running')
    this.sendProgress(job)
  }

  getJob(jobId: string): BatchJob | undefined {
    return this.jobs.get(jobId)
  }

  isProcessing(): boolean {
    return this.processing
  }

  async shutdownRuntime(timeoutMs = 3000): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.activeControllers.forEach((controller) => controller.abort())
    this.jobs.forEach((job) => {
      if (job.status === 'running') {
        job.status = 'paused'
        this.sendProgress(job)
      }
    })
    this.processing = false

    if (this.activeJobRuns.size > 0) {
      let timer: ReturnType<typeof setTimeout> | null = null
      await Promise.race([
        Promise.allSettled([...this.activeJobRuns]).then(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer)
      })
    }

    releaseAllLegacyBatchClaims()
    saveDatabase()
  }

  private sendProgress(job: BatchJob): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return

    const elapsedSeconds = job.startTime ? (Date.now() - job.startTime) / 1000 : 0
    const completedCount = job.processedCount + job.failedCount
    const avgTimePerDoc = completedCount > 0 ? elapsedSeconds / completedCount : 0
    const remaining = Math.max(0, job.docIds.length - completedCount)
    const estimatedTime = Math.round(avgTimePerDoc * remaining)

    const payload: BatchProgressEvent = {
      jobId: job.id,
      status: job.status,
      currentBatch: job.currentBatch,
      totalBatches: job.totalBatches,
      processedCount: job.processedCount,
      failedCount: job.failedCount,
      totalCount: job.docIds.length,
      progress: job.docIds.length > 0 ? (completedCount / job.docIds.length) * 100 : 0,
      estimatedTime,
    }
    this.mainWindow.webContents.send('batch:progress', payload)
  }
}

export const batchProcessor = new BatchProcessor()
