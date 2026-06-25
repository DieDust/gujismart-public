import { ipcMain, nativeImage } from 'electron'
import { statSync } from 'fs'
import { nanoid } from 'nanoid'
import { autoExtractAndApply } from '../ai'
import { clearPageSearchIndexForDocuments, queryAll, queryOne, run, saveDatabase, scheduleDatabaseSave, transaction } from '../database'
import { autoCleanupPdfAssetsIfEnabled, restorePdfAssetForDocument } from '../pdf-assets'
import { analyzePdfTextLayer } from '../pdf-preflight'
import {
  findSuspiciousRepeatedOcrText,
  formatSuspiciousRepeatedOcrTextIssue,
  getOcrDocumentConcurrency,
  type OcrPageRecord,
  type OcrPageResult,
  type PageOcrOptions,
  postProcessRecognizedPageResult,
  prepareImageForOcrUpload,
  isOcrAbortError,
  recognizeImage,
  recognizeImageRegion,
  recognizePages,
  recognizePdfAsync,
  recognizeTraditional,
  shouldUseAsyncPdfOcr,
} from '../ocr'
import { emitBackgroundTaskStatus } from '../background-tasks'
import { markSearchIndexStaleForDocuments, markSearchIndexStaleForPages, notifySearchContentChanged } from '../semantic-search'
import { clearDocumentTocAutogenAttempt, saveDocumentToc } from '../toc-service'
import { hydratePagePayloadRows, preparePagePayloadUpdate } from '../page-payload-store'
import { hasVisionOcrConfig, recognizePagesWithVisionModel, refinePagesWithVisionModel } from '../vision-ocr'
import {
  OCR_IR_PIPELINE_VERSION,
  OCR_IR_SCHEMA_VERSION,
  applyOcrRegionTextReplacement,
  buildOcrDocumentV1,
  buildOcrPageIr,
  deriveOcrTextFromIr,
  deriveOcrWordsResultFromIr,
  ensureOcrResultIr,
  getOcrPageIr,
  getOcrRegionRerecognitionCandidates,
} from '../../shared/ocr-ir'
import type { BatchOcrOptions, Document, DocumentPage, OcrEngine, OcrProgressEvent, OcrRecognizeMode, OcrRecognizeResult, OcrRegionRerecognitionOptions, OcrRegionRerecognitionResult, PdfTextLayerAnalysis, PdfTextLayerPageAnalysis, TocItemV2 } from '../../shared/types'

const AUTO_METADATA_TIMEOUT_MS = 120_000
const AUTO_METADATA_QUEUE_TIMEOUT_MS = 30 * 60_000
const AUTO_METADATA_START_DELAY_MS = 5_000
const OCR_PAGE_INSERT_CHUNK_SIZE = 50
const OCR_RESULT_SAVE_CHUNK_SIZE = 50
const OCR_RESULT_POSTPROCESS_CHUNK_SIZE = 50
const OCR_FINALIZE_PAGE_CHUNK_SIZE = 250
const OCR_FINALIZE_PAGE_LOOKUP_CHUNK_SIZE = 500
const OCR_STATUS_EVENT_THROTTLE_MS = 250
const OCR_SLOW_STEP_MS = 800
const OCR_CANCELED_MESSAGE = 'OCR 已取消'
const HEAVY_PDF_DOC_SIZE_BYTES = 200 * 1024 * 1024
const HEAVY_PDF_DOC_PAGE_COUNT = 1000
const RECOVERABLE_BATCH_OCR_PREFIX = 'recoverable_ocr'

type JsonRecord = Record<string, unknown>
type OcrDocumentRow = Document
type OcrPageRow = DocumentPage
type OcrPageWithImage = OcrPageRecord & { image_path: string }
type OcrVersionPageRow = Pick<DocumentPage, 'id' | 'doc_id' | 'page_num'>
type OcrSavePageSnapshot = OcrVersionPageRow & {
  image_path: string | null
  proofed_text: string | null
  ocr_text: string | null
  ocr_result: string | null
  ocr_text_ref?: string | null
  ocr_result_ref?: string | null
  ocr_status: string | null
}
interface OcrVersionWrite {
  pageId: string
  page?: OcrVersionPageRow | null
  result: unknown
  text: string
  status: string
}
type OcrResultRecord = OcrRecognizeResult & JsonRecord

interface ActiveOcrTask {
  controller: AbortController
  done: Promise<void>
}

interface OcrProcessOptions {
  signal?: AbortSignal
  pageConcurrency?: number
}

interface SavePageOcrResultsOptions {
  refreshSearch?: boolean
  markTocDirty?: boolean
  onTocDirtyDocIds?: (docIds: string[]) => void
  deferFinalize?: boolean
  deferDatabaseSave?: boolean
}

const activeOcrTasks = new Map<string, ActiveOcrTask>()
const queuedOcrDocIds = new Set<string>()
const canceledOcrDocIds = new Set<string>()
const pendingOcrFinalizePageIds = new Set<string>()
const displayedOcrProgressByDoc = new Map<string, { completedPages: number; progress: number; totalPages?: number }>()
const pendingOcrStatusEventsByDoc = new Map<string, {
  sender: Electron.WebContents
  payload: OcrProgressEvent
  timer: ReturnType<typeof setTimeout> | null
  lastSentAt: number
}>()
let autoMetadataQueue = Promise.resolve()
let ocrFinalizeTimer: ReturnType<typeof setTimeout> | null = null
let ocrFinalizeRunning = false
let ocrRuntimeShuttingDown = false

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function logSlowOcrStep(label: string, startedAt: number): void {
  const elapsed = Date.now() - startedAt
  if (elapsed >= OCR_SLOW_STEP_MS) {
    console.warn(`[OCR] Slow step: ${label} took ${elapsed}ms`)
  }
}

function emitOcrFinalizeTaskStatus(payload: {
  status: 'queued' | 'processing' | 'completed' | 'error'
  progress?: number
  message?: string
  totalCount?: number
  completedCount?: number
  errorMessage?: string
}): void {
  emitBackgroundTaskStatus({
    taskId: 'ocr-finalize',
    kind: 'ocr-finalize',
    ...payload,
  })
}

function scheduleOcrFinalizeTimer(): void {
  if (ocrFinalizeTimer || ocrFinalizeRunning || pendingOcrFinalizePageIds.size === 0) return
  ocrFinalizeTimer = setTimeout(() => {
    ocrFinalizeTimer = null
    const ids = [...pendingOcrFinalizePageIds]
    pendingOcrFinalizePageIds.clear()
    if (ids.length === 0) return
    ocrFinalizeRunning = true
    emitOcrFinalizeTaskStatus({
      status: 'processing',
      progress: 0.2,
      totalCount: ids.length,
      completedCount: 0,
      message: '正在后台整理 OCR 文本，不影响阅读',
    })
    setImmediate(() => {
      void (async () => {
        try {
          let completedCount = 0
          const docIds = new Set<string>()
          for (let index = 0; index < ids.length; index += OCR_FINALIZE_PAGE_CHUNK_SIZE) {
            const chunk = ids.slice(index, index + OCR_FINALIZE_PAGE_CHUNK_SIZE)
            completedCount += chunk.length
            emitOcrFinalizeTaskStatus({
              status: 'processing',
              progress: Math.min(0.95, 0.2 + (completedCount / ids.length) * 0.75),
              totalCount: ids.length,
              completedCount,
              message: '正在后台整理 OCR 文本，不影响阅读',
            })
            if (completedCount < ids.length) {
              await yieldToEventLoop()
            }
          }
          for (let index = 0; index < ids.length; index += OCR_FINALIZE_PAGE_LOOKUP_CHUNK_SIZE) {
            const chunk = ids.slice(index, index + OCR_FINALIZE_PAGE_LOOKUP_CHUNK_SIZE)
            const placeholders = chunk.map(() => '?').join(', ')
            queryAll<{ doc_id: string }>(
              `SELECT DISTINCT doc_id FROM pages WHERE id IN (${placeholders})`,
              chunk,
            ).forEach((row) => {
              if (row.doc_id) docIds.add(row.doc_id)
            })
            await yieldToEventLoop()
          }
          if (docIds.size > 0) {
            markSearchIndexStaleForDocuments([...docIds])
          } else {
            markSearchIndexStaleForPages(ids)
          }
          notifySearchContentChanged()
          scheduleDatabaseSave()
          emitOcrFinalizeTaskStatus({
            status: 'completed',
            progress: 1,
            totalCount: ids.length,
            completedCount: ids.length,
            message: 'OCR 文本整理完成，搜索索引已进入后台更新',
          })
        } catch (error: unknown) {
          emitOcrFinalizeTaskStatus({
            status: 'error',
            progress: 1,
            totalCount: ids.length,
            completedCount: 0,
            message: 'OCR 文本整理失败，可稍后重试',
            errorMessage: (error as Error)?.message || String(error || 'OCR 文本整理失败'),
          })
        } finally {
          ocrFinalizeRunning = false
          scheduleOcrFinalizeTimer()
        }
      })()
    })
  }, 250)
}

function scheduleOcrFinalizeForPages(pageIds: string[]): void {
  const uniquePageIds = [...new Set((pageIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (uniquePageIds.length === 0) return
  const previousPendingPageCount = pendingOcrFinalizePageIds.size
  uniquePageIds.forEach((pageId) => pendingOcrFinalizePageIds.add(pageId))
  const addedPageCount = pendingOcrFinalizePageIds.size - previousPendingPageCount
  if (addedPageCount > 0 && !ocrFinalizeTimer && !ocrFinalizeRunning) {
    emitOcrFinalizeTaskStatus({
      status: 'queued',
      progress: 0,
      totalCount: pendingOcrFinalizePageIds.size,
      completedCount: 0,
      message: '正在后台整理 OCR 文本，不影响阅读',
    })
  }
  scheduleOcrFinalizeTimer()
}

function waitForOcrShutdown(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
  if (tasks.length === 0) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    Promise.allSettled(tasks).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function shouldPersistBatchOcrForRecovery(options?: BatchOcrOptions): boolean {
  const engine = options?.engine || 'paddle'
  return engine === 'paddle' && options?.forceFullRerun !== true
}

function createRecoverableBatchOcrItems(docIds: string[], batchSize: number): Map<string, string> {
  const uniqueDocIds = [...new Set((docIds || []).map((docId) => String(docId || '').trim()).filter(Boolean))]
  const itemIdsByDocId = new Map<string, string>()
  if (uniqueDocIds.length === 0) return itemIdsByDocId

  const batchId = `${RECOVERABLE_BATCH_OCR_PREFIX}_${Date.now()}_${nanoid(6)}`
  const now = new Date().toISOString()
  transaction(() => {
    uniqueDocIds.forEach((docId) => {
      const itemId = nanoid()
      run(
        'INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [itemId, batchId, docId, 'pending', batchSize, 0, null, now],
      )
      itemIdsByDocId.set(docId, itemId)
    })
  })
  saveDatabase()
  return itemIdsByDocId
}

function updateRecoverableBatchOcrItem(
  itemIdsByDocId: Map<string, string>,
  docId: string,
  status: 'processing' | 'completed' | 'failed',
  errorMessage?: string,
): void {
  const itemId = itemIdsByDocId.get(docId)
  if (!itemId) return

  const now = new Date().toISOString()
  if (status === 'processing') {
    run(
      'UPDATE batch_queue SET status = ?, progress = ?, error_message = NULL, started_at = COALESCE(started_at, ?), completed_at = NULL WHERE id = ?',
      ['processing', 0, now, itemId],
    )
  } else {
    run(
      'UPDATE batch_queue SET status = ?, progress = ?, error_message = ?, completed_at = ? WHERE id = ?',
      [status, 100, errorMessage ? errorMessage.slice(0, 1000) : null, now, itemId],
    )
  }
  scheduleDatabaseSave()
}

export async function shutdownOcrRuntime(timeoutMs = 3000): Promise<void> {
  if (ocrRuntimeShuttingDown) return
  ocrRuntimeShuttingDown = true

  if (ocrFinalizeTimer) {
    clearTimeout(ocrFinalizeTimer)
    ocrFinalizeTimer = null
  }

  const activeDocIds = [...activeOcrTasks.keys()]
  const queuedDocIds = [...queuedOcrDocIds]
  const activeDoneTasks = [...activeOcrTasks.values()].map((task) => task.done)
  activeOcrTasks.forEach((task) => task.controller.abort())
  activeDocIds.forEach((docId) => canceledOcrDocIds.add(docId))

  const finalizePageIds = [...pendingOcrFinalizePageIds]
  pendingOcrFinalizePageIds.clear()
  if (finalizePageIds.length > 0) {
    markSearchIndexStaleForPages(finalizePageIds)
    notifySearchContentChanged()
  }

  const docIds = [...new Set([...activeDocIds, ...queuedDocIds])]
  for (const docId of docIds) {
    updateDocumentCanceledStatus(docId)
  }
  queuedOcrDocIds.clear()

  if (docIds.length > 0 || finalizePageIds.length > 0) {
    saveDatabase()
  }
  await waitForOcrShutdown(activeDoneTasks, timeoutMs)
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(value: unknown): JsonRecord | null {
  if (isJsonRecord(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value) as unknown
    return isJsonRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function getOcrResultText(result: unknown): string {
  if (!isJsonRecord(result)) return ''
  const text = String(result.text || '').trim()
  if (text) return text
  const wordsResult = Array.isArray(result.words_result) ? result.words_result : []
  return wordsResult
    .map((item) => isJsonRecord(item) ? String(item.words || '') : '')
    .filter(Boolean)
    .join('\n')
}

function getPageResultRecord(pageResult: OcrPageResult): OcrResultRecord | null {
  return isJsonRecord(pageResult.result) ? pageResult.result as OcrResultRecord : null
}

function withRequiredImage(page: OcrPageRow): OcrPageWithImage {
  return { ...page, image_path: page.image_path as string }
}

function syncDocumentProofStatus(docId: string): void {
  const stats = queryOne<{ total: number; completed: number }>(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN proof_status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM pages
    WHERE doc_id = ?`,
    [docId],
  )

  const total = Number(stats?.total || 0)
  const completed = Number(stats?.completed || 0)
  const nextStatus = total > 0 && completed === total ? 'completed' : 'pending'
  run('UPDATE documents SET proof_status = ?, updated_at = ? WHERE id = ?', [nextStatus, new Date().toISOString(), docId])
}

function isActiveOcrProgressPayload(payload: OcrProgressEvent): boolean {
  return payload.status === 'processing'
    || payload.phase === 'ocr'
    || payload.phase === 'saving'
    || payload.aiStatus === 'processing'
}

function isTerminalOcrProgressPayload(payload: OcrProgressEvent): boolean {
  return Boolean(
    payload.canceled
    || payload.status === 'completed'
    || payload.status === 'error'
    || payload.status === 'pending'
    || payload.status === 'canceled'
    || payload.phase === 'completed'
    || payload.phase === 'error'
    || payload.phase === 'canceled',
  )
}

function getFiniteProgressNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function getMonotonicOcrStatusPayload(payload: OcrProgressEvent): OcrProgressEvent {
  const docId = String(payload.docId || '').trim()
  if (!docId) return payload

  const previous = displayedOcrProgressByDoc.get(docId)
  const next: OcrProgressEvent = { ...payload }
  const totalPages = getFiniteProgressNumber(next.totalPages) ?? previous?.totalPages
  const completedPages = getFiniteProgressNumber(next.completedPages)
  const progress = getFiniteProgressNumber(next.progress)

  if (isActiveOcrProgressPayload(next)) {
    const nextCompletedPages = Math.max(
      previous?.completedPages || 0,
      completedPages ?? 0,
    )
    const nextProgress = Math.max(
      previous?.progress || 0,
      progress ?? 0,
    )

    if (totalPages !== undefined && totalPages > 0) next.totalPages = totalPages
    if (nextCompletedPages > 0 || completedPages !== null) next.completedPages = nextCompletedPages
    next.progress = Math.max(0, Math.min(1, nextProgress))
    displayedOcrProgressByDoc.set(docId, {
      completedPages: nextCompletedPages,
      progress: next.progress,
      totalPages,
    })
  }

  if (isTerminalOcrProgressPayload(next)) {
    if (previous && next.status !== 'completed' && next.status !== 'error') {
      if (next.completedPages === undefined && previous.completedPages > 0) {
        next.completedPages = previous.completedPages
      }
      if (next.totalPages === undefined && previous.totalPages) {
        next.totalPages = previous.totalPages
      }
      next.progress = Math.max(Number(next.progress || 0), previous.progress)
    }
    displayedOcrProgressByDoc.delete(docId)
  }

  return next
}

function sendOcrStatus(sender: Electron.WebContents, payload: OcrProgressEvent): void {
  if (sender.isDestroyed()) return
  sender.send('ocr:statusChanged', payload)
}

function flushPendingOcrStatus(docId: string): void {
  const pending = pendingOcrStatusEventsByDoc.get(docId)
  if (!pending) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingOcrStatusEventsByDoc.delete(docId)
  if (pending.timer) {
    sendOcrStatus(pending.sender, pending.payload)
  }
}

function emitOcrStatus(event: Electron.IpcMainInvokeEvent, payload: OcrProgressEvent): void {
  const next = getMonotonicOcrStatusPayload(payload)
  const docId = String(next.docId || '').trim()
  if (!docId || isTerminalOcrProgressPayload(next)) {
    if (docId) flushPendingOcrStatus(docId)
    sendOcrStatus(event.sender, next)
    return
  }

  if (!isActiveOcrProgressPayload(next)) {
    sendOcrStatus(event.sender, next)
    return
  }

  const now = Date.now()
  const pending = pendingOcrStatusEventsByDoc.get(docId)
  const lastSentAt = pending?.lastSentAt || 0
  if (!pending || now - lastSentAt >= OCR_STATUS_EVENT_THROTTLE_MS) {
    if (pending?.timer) clearTimeout(pending.timer)
    pendingOcrStatusEventsByDoc.set(docId, {
      sender: event.sender,
      payload: next,
      timer: null,
      lastSentAt: now,
    })
    sendOcrStatus(event.sender, next)
    return
  }

  pending.sender = event.sender
  pending.payload = next
  if (pending.timer) return
  pending.timer = setTimeout(() => {
    const latest = pendingOcrStatusEventsByDoc.get(docId)
    if (!latest) return
    latest.timer = null
    latest.lastSentAt = Date.now()
    sendOcrStatus(latest.sender, latest.payload)
  }, Math.max(0, OCR_STATUS_EVENT_THROTTLE_MS - (now - lastSentAt)))
}

function getDocProgress(completedDocs: number, totalDocs: number, docFraction = 0): number {
  return (completedDocs + Math.max(0, Math.min(1, docFraction))) / Math.max(totalDocs, 1)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer))
  })
}

function createLimiter(concurrency: number) {
  let activeCount = 0
  const queue: Array<() => void> = []

  const next = () => {
    activeCount -= 1
    const task = queue.shift()
    if (task) task()
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (activeCount >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }

    activeCount += 1
    try {
      return await fn()
    } finally {
      next()
    }
  }
}

function queuedAutoExtractAndApply(docId: string): Promise<Awaited<ReturnType<typeof autoExtractAndApply>>> {
  const next = autoMetadataQueue
    .catch(() => undefined)
    .then(async () => {
      await sleep(AUTO_METADATA_START_DELAY_MS)
      if (ocrRuntimeShuttingDown) {
        throw new Error('OCR runtime is shutting down')
      }
      return withTimeout(
        autoExtractAndApply(docId),
        AUTO_METADATA_TIMEOUT_MS,
        'AI 元数据提取超时，OCR 结果已保存，可稍后手动重新提取元数据。',
      )
    })
  autoMetadataQueue = next.then(() => undefined, () => undefined)
  return next
}

function getRetryLimit(): number {
  const row = queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'retry_count'")
  const parsed = Number(row?.value || 3)
  if (!Number.isFinite(parsed)) return 3
  return Math.max(0, Math.min(5, Math.round(parsed)))
}

function getNumericSetting(key: string, fallback: number, min: number, max: number): number {
  const row = queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  const parsed = Number(row?.value || fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 秒'
  const totalSeconds = Math.max(1, Math.round(value / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds} 秒`
  if (seconds <= 0) return `${minutes} 分钟`
  return `${minutes} 分 ${seconds} 秒`
}

function formatOcrError(error: unknown): string {
  if (isOcrAbortError(error)) return OCR_CANCELED_MESSAGE
  const message = (error as Error)?.message || String(error || '')
  if (!message) return '处理失败：未知错误'
  if (message.includes('API Token') || message.includes('paddleocr_api_key')) {
    return '未配置 PaddleOCR API Token，请先到设置页填写 Token 后再重试。'
  }
  if (message.includes('401') || message.includes('403')) {
    return 'PaddleOCR API Token 无效或没有权限，请检查设置页中的 Token。'
  }
  if (message.includes('429')) {
    return 'PaddleOCR 接口请求过于频繁或额度受限，请稍后重试。'
  }
  if (message.includes('50MB')) {
    return message
  }
  if (message.includes('返回页数不足')) {
    return 'PaddleOCR 返回的页数少于文献页数，可能是接口处理异常或 PDF 页面解析失败。'
  }
  if (message.includes('fetch') || message.includes('network') || message.includes('ECONN')) {
    return '网络请求失败，请检查网络连接后重试。'
  }
  return message
}

function isRetryableOcrError(error: unknown): boolean {
  if (isOcrAbortError(error)) return false
  const message = formatOcrError(error)
  if (message.includes('vision') || message.includes('Vision') || message.includes('视觉模型')) return false
  if (message.includes('API Token') || message.includes('Token 无效') || message.includes('没有权限')) return false
  if (message.includes('单页超过')) return false
  if (isPdfChunkStructureError(error)) return false
  return true
}

function throwIfOcrCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(OCR_CANCELED_MESSAGE)
  }
}

function isPdfChunkStructureError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '')
  return /PDFDict|pdf-lib|copyPages|qpdf 不可用|无法安全处理 PDF 分片|无法安全分片|PDF chunking failed|PDF 第 \d+ 页结构异常|instance of undefined/i.test(message)
}

function hasReadablePageImage(page: Pick<OcrPageRow, 'image_path'>): boolean {
  const imagePath = String(page?.image_path || '').trim()
  if (!imagePath) return false
  try {
    return statSync(imagePath).isFile()
  } catch {
    return false
  }
}

function findMissingReadablePageImage(pages: Array<Pick<OcrPageRow, 'page_num' | 'image_path'>>): Pick<OcrPageRow, 'page_num' | 'image_path'> | undefined {
  return pages.find((page) => !hasReadablePageImage(page))
}

function canFallbackToImageOcr(pages: OcrPageRow[]): boolean {
  return pages.length > 0 && pages.every(hasReadablePageImage)
}

function resolveUsablePdfPath(doc: Pick<OcrDocumentRow, 'id' | 'file_path' | 'metadata'>, pageCount = 0): string | null {
  const filePath = typeof doc.file_path === 'string' ? doc.file_path.trim() : ''
  if (shouldUseAsyncPdfOcr(filePath, pageCount)) return filePath

  const metadata = parseMetadata(doc.metadata)
  const looksLikePdf = filePath.toLowerCase().endsWith('.pdf')
    || String(metadata.pdf_sha256 || '').trim().length > 0
    || String(metadata.file_ext || '').toLowerCase() === '.pdf'
    || String(metadata.file_kind || '').toLowerCase() === 'pdf'
  if (!looksLikePdf) return null

  const restored = restorePdfAssetForDocument(doc.id)
  if (restored.restored && restored.path && shouldUseAsyncPdfOcr(restored.path, pageCount)) {
    return restored.path
  }
  return null
}

function getDocumentPdfSizeBytes(filePath?: string | null): number {
  const safePath = String(filePath || '').trim()
  if (!safePath || !safePath.toLowerCase().endsWith('.pdf')) return 0
  try {
    return statSync(safePath).size
  } catch {
    return 0
  }
}

function isHeavyPdfOcrDocument(docId: string): boolean {
  const doc = queryOne<Pick<OcrDocumentRow, 'file_path' | 'page_count' | 'metadata'>>(
    'SELECT file_path, page_count, metadata FROM documents WHERE id = ?',
    [docId],
  )
  if (!doc) return false
  const filePath = String(doc.file_path || '').trim()
  if (!shouldUseAsyncPdfOcr(filePath, Number(doc.page_count || 0) || 0)) return false
  const metadata = parseJsonRecord(doc.metadata) || {}
  const metadataPageCount = Number(metadata.pdf_page_count || metadata.page_count || 0)
  const pageCount = Math.max(Number(doc.page_count || 0), Number.isFinite(metadataPageCount) ? metadataPageCount : 0)
  const fileSize = getDocumentPdfSizeBytes(filePath)
  return fileSize >= HEAVY_PDF_DOC_SIZE_BYTES || pageCount >= HEAVY_PDF_DOC_PAGE_COUNT
}

function shouldUsePdfOcrForWork(pdfPath: string | null, pages: OcrPageRow[], pagesForOcr: OcrPageRow[], pageCount = 0): boolean {
  if (!shouldUseAsyncPdfOcr(pdfPath, Math.max(pageCount, pages.length, pagesForOcr.length))) return false
  if (pages.length === 0) return true
  if (pageCount > pages.length) return true
  if (pagesForOcr.length === pages.length) return true
  return Boolean(findMissingReadablePageImage(pagesForOcr))
}

function updateDocumentStatus(docId: string, ocrStatus: string, importStatus: string, errorMessage?: string | null): void {
  const errorValue = errorMessage ? String(errorMessage).slice(0, 1000) : null
  run(
    'UPDATE documents SET ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    [ocrStatus, importStatus, errorValue, new Date().toISOString(), docId],
  )
  scheduleDatabaseSave()
}

function getZeroPageOcrError(engine: OcrEngine): string {
  return `${getEngineLabel(engine)}没有返回任何页面，已按 OCR 异常处理。请重新导入原文件或重新 OCR；如果仍为 0 页，可在文献库使用“清除零页文献”清理空记录。`
}

function resolveDocOcrOptions(docType?: string | null, overrides?: PageOcrOptions): Required<PageOcrOptions> {
  const base = docType === '\u53e4\u7c4d'
    ? { profile: 'guji_print_vertical' as const, secondPass: 'local_segmentation' as const }
    : { profile: 'general' as const, secondPass: 'none' as const }

  return {
    profile: overrides?.profile || base.profile,
    secondPass: overrides?.secondPass || base.secondPass,
  }
}

async function postProcessPdfOcrResultsBatched(
  pages: Array<{ page: OcrPageRow; sourcePageIndex: number; resultIndex: number }>,
  rawResults: unknown[],
  ocrOptions: Required<PageOcrOptions>,
  signal?: AbortSignal,
  getMissingResultError?: (item: { sourcePageIndex: number; resultIndex: number }) => string,
): Promise<OcrPageResult[]> {
  const pageResults: OcrPageResult[] = []
  for (let index = 0; index < pages.length; index += OCR_RESULT_POSTPROCESS_CHUNK_SIZE) {
    const batch = pages.slice(index, index + OCR_RESULT_POSTPROCESS_CHUNK_SIZE)
    const batchResults = await Promise.all(batch.map(async (item) => {
      throwIfOcrCanceled(signal)
      const rawResult = rawResults[item.resultIndex]
      const result = rawResult ? await postProcessRecognizedPageResult(rawResult, item.page.image_path, ocrOptions, { signal }) : null
      if (!result) {
        return {
          pageId: item.page.id,
          result: null,
          text: '',
          status: 'error',
          error: getMissingResultError?.(item) || `PaddleOCR async result missing for page ${item.sourcePageIndex + 1}`,
        } satisfies OcrPageResult
      }
      const repeatedIssue = findSuspiciousRepeatedOcrText(result)
      if (repeatedIssue) {
        return {
          pageId: item.page.id,
          result: null,
          text: '',
          status: 'error',
          error: formatSuspiciousRepeatedOcrTextIssue(repeatedIssue),
        } satisfies OcrPageResult
      }

      return {
        pageId: item.page.id,
        result,
        text: getOcrResultText(result),
        status: 'completed',
      } satisfies OcrPageResult
    }))
    pageResults.push(...batchResults)
    if (index + OCR_RESULT_POSTPROCESS_CHUNK_SIZE < pages.length) {
      await yieldToEventLoop()
    }
  }
  return pageResults
}

async function recognizeSinglePage(page: OcrPageWithImage, doc: Pick<OcrDocumentRow, 'doc_type'>, options?: PageOcrOptions): Promise<OcrRecognizeResult> {
  const resolvedOptions = resolveDocOcrOptions(doc.doc_type, options)
  const imageBuffer = await prepareImageForOcrUpload(page.image_path)
  const base64Image = imageBuffer.toString('base64')
  const initialResult = resolvedOptions.profile === 'guji_print_vertical'
    ? await recognizeTraditional(base64Image)
    : await recognizeImage(base64Image)
  return postProcessRecognizedPageResult(initialResult, page.image_path, resolvedOptions)
}

async function rerunPageLayoutOnly(
  page: Pick<OcrPageRow, 'ocr_result' | 'image_path'>,
  doc: Pick<OcrDocumentRow, 'doc_type'>,
  options?: PageOcrOptions,
): Promise<OcrRecognizeResult> {
  let currentResult = page.ocr_result
  if (typeof currentResult === 'string') {
    currentResult = JSON.parse(currentResult)
  }
  if (!currentResult) {
    throw new Error('当前页面尚无 OCR 结果，无法重做版面切分')
  }
  const resolvedOptions = resolveDocOcrOptions(doc.doc_type, options)
  return postProcessRecognizedPageResult(currentResult, page.image_path, {
    ...resolvedOptions,
    secondPass: 'local_segmentation',
  })
}

function getEngineLabel(engine: string): string {
  if (engine === 'vision_model') return '视觉 OCR'
  if (engine === 'hybrid') return '混合 OCR'
  return '飞桨 OCR'
}

function getPageSnapshotsForOcrSave(pageIds: string[]): Map<string, OcrSavePageSnapshot> {
  const uniquePageIds = [...new Set(pageIds.map((pageId) => String(pageId || '').trim()).filter(Boolean))]
  if (uniquePageIds.length === 0) return new Map()
  const placeholders = uniquePageIds.map(() => '?').join(', ')
  const rows = queryAll<OcrSavePageSnapshot>(
    `SELECT id, doc_id, page_num, image_path, proofed_text, ocr_text, ocr_text_ref, ocr_result, ocr_result_ref, ocr_status
     FROM pages
     WHERE id IN (${placeholders})`,
    uniquePageIds,
  )
  return new Map(hydratePagePayloadRows(rows).map((row) => [row.id, row]))
}

function markPageOcrVersionsInactive(pageIds: string[]): void {
  const uniquePageIds = [...new Set(pageIds.map((pageId) => String(pageId || '').trim()).filter(Boolean))]
  if (uniquePageIds.length === 0) return
  const placeholders = uniquePageIds.map(() => '?').join(', ')
  run(`UPDATE page_ocr_versions SET is_active = 0 WHERE page_id IN (${placeholders})`, uniquePageIds)
}

function upsertPageOcrVersion(
  pageId: string,
  engine: OcrEngine,
  result: unknown,
  text: string,
  status = 'completed',
  pageSnapshot?: OcrVersionPageRow | null,
  options: { deactivateExisting?: boolean } = {},
): void {
  const page = pageSnapshot || queryOne<OcrVersionPageRow>('SELECT id, doc_id, page_num FROM pages WHERE id = ?', [pageId])
  if (!page) return
  const now = new Date().toISOString()
  if (options.deactivateExisting !== false) {
    markPageOcrVersionsInactive([pageId])
  }
  const preparedText = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_text', text || '')
  const preparedResult = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_result', result ? JSON.stringify(result) : null)
  run(
    `INSERT INTO page_ocr_versions (
      id, doc_id, page_id, page_num, engine, label, ocr_text, ocr_text_ref, ocr_result, ocr_result_ref, status, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(page_id, engine) DO UPDATE SET
      page_num = excluded.page_num,
      label = excluded.label,
      ocr_text = excluded.ocr_text,
      ocr_text_ref = excluded.ocr_text_ref,
      ocr_result = excluded.ocr_result,
      ocr_result_ref = excluded.ocr_result_ref,
      status = excluded.status,
      is_active = excluded.is_active,
      updated_at = excluded.updated_at`,
    [nanoid(), page.doc_id, pageId, page.page_num || null, engine, getEngineLabel(engine), preparedText.value, preparedText.ref, preparedResult.value, preparedResult.ref, status, 1, now, now],
  )
}

function persistPdfTextLayerSummary(doc: OcrDocumentRow, analysis: PdfTextLayerAnalysis): void {
  const currentMetadata = queryOne<Pick<OcrDocumentRow, 'metadata'>>(
    'SELECT metadata FROM documents WHERE id = ?',
    [doc.id],
  )?.metadata
  const metadata = parseMetadata(currentMetadata ?? doc.metadata)
  metadata.pdf_text_layer_analysis = {
    mode: analysis.mode,
    page_count: analysis.pageCount,
    sampled_page_nums: analysis.sampledPageNums,
    native_text_page_count: analysis.nativeTextPageCount,
    ocr_page_count: analysis.ocrPageCount,
    average_clean_characters: analysis.averageCleanCharacters,
    analyzed_at: analysis.analyzedAt,
    analyzer_version: 'gujismart-pdf-text-layer/v1',
  }
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(metadata),
    new Date().toISOString(),
    doc.id,
  ])
}

function buildNativePdfPageResult(page: OcrPageRow, analysis: PdfTextLayerPageAnalysis): OcrPageResult {
  return {
    pageId: page.id,
    status: 'completed',
    text: analysis.text,
    result: {
      source_type: 'native_pdf_text',
      text: analysis.text,
      page_num: analysis.pageNum,
      page_width: analysis.pageWidth,
      page_height: analysis.pageHeight,
      layout_result: analysis.layoutBlocks,
      words_result: analysis.layoutBlocks.map((block) => ({ words: String(block.words || '') })),
      pdf_text_layer_quality: {
        mode: analysis.mode,
        clean_character_count: analysis.cleanCharacterCount,
        invalid_unicode_ratio: analysis.invalidUnicodeRatio,
        replacement_character_ratio: analysis.replacementCharacterRatio,
        coordinate_coverage: analysis.coordinateCoverage,
        image_object_count: analysis.imageObjectCount,
        reasons: analysis.reasons,
      },
    },
  }
}

function getPageImageSize(imagePath?: string | null): { width: number; height: number } | null {
  const path = String(imagePath || '').trim()
  if (!path) return null
  try {
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return null
    const size = image.getSize()
    return size.width > 0 && size.height > 0 ? size : null
  } catch {
    return null
  }
}

function normalizeOcrResultForStorage(
  result: unknown,
  page: Pick<OcrSavePageSnapshot, 'page_num' | 'image_path' | 'ocr_result'> | null | undefined,
  engine: OcrEngine,
): { result: OcrRecognizeResult; text: string } {
  const imageSize = getPageImageSize(page?.image_path)
  const normalized = ensureOcrResultIr(result, {
    pageIndex: Number(page?.page_num || 0) || 1,
    pageWidth: imageSize?.width,
    pageHeight: imageSize?.height,
    engine,
    generatedAt: getOcrPageIr(page?.ocr_result)?.generatedAt,
    forceRebuild: true,
  })
  return {
    result: normalized,
    text: normalized.gujismart_ir ? deriveOcrTextFromIr(normalized.gujismart_ir) : getOcrResultText(normalized),
  }
}

function getRegionResultText(result: OcrRecognizeResult): string {
  if (Array.isArray(result.words_result)) {
    const text = result.words_result.map((item) => String(item?.words || '')).filter(Boolean).join('\n').trim()
    if (text) return text
  }
  return String(result.text || '').trim()
}

function getRegionResultConfidence(result: OcrRecognizeResult): number | undefined {
  if (!Array.isArray(result.words_result)) return undefined
  const scores = result.words_result
    .map((item) => Number(item?.confidence ?? item?.score))
    .filter((score) => Number.isFinite(score))
  if (scores.length === 0) return undefined
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

async function rerecognizeLowQualityPageRegions(
  page: OcrPageRow,
  options: OcrRegionRerecognitionOptions = {},
): Promise<OcrRegionRerecognitionResult> {
  if (!page.image_path) throw new Error('当前页缺少图像，无法局部重识别')
  const currentResult = parseJsonRecord(page.ocr_result)
  if (!currentResult) throw new Error('当前页没有可用于局部重识别的 OCR 结果')
  const imageSize = getPageImageSize(page.image_path)
  const envelope = getOcrPageIr(currentResult) || buildOcrPageIr(currentResult, {
    pageIndex: Number(page.page_num || 0) || 1,
    pageWidth: imageSize?.width,
    pageHeight: imageSize?.height,
    forceRebuild: true,
  })
  const maxBlocks = Math.max(1, Math.min(20, Math.floor(options.maxBlocks || 8)))
  const candidates = getOcrRegionRerecognitionCandidates(envelope, maxBlocks)
  if (candidates.length === 0) {
    return {
      attemptedBlockCount: 0,
      updatedBlockCount: 0,
      skippedBlockCount: 0,
      failedBlockCount: 0,
      updatedBlockIds: [],
    }
  }

  let nextResult = JSON.parse(JSON.stringify(currentResult)) as OcrResultRecord
  const updatedBlockIds: string[] = []
  let skippedBlockCount = 0
  let failedBlockCount = 0
  let firstError: Error | null = null
  for (const candidate of candidates) {
    try {
      const recognized = await recognizeImageRegion(page.image_path, candidate.bbox, candidate.orientation === 'vertical')
      const nextText = getRegionResultText(recognized)
      const replacement = applyOcrRegionTextReplacement(nextResult, {
        sourceIndex: candidate.sourceIndex,
        text: nextText,
        confidence: getRegionResultConfidence(recognized),
        reasons: candidate.reasons,
      })
      if (!replacement.updated) {
        skippedBlockCount += 1
        continue
      }
      nextResult = replacement.result as OcrResultRecord
      updatedBlockIds.push(candidate.blockId)
    } catch (error) {
      failedBlockCount += 1
      if (!firstError) firstError = error instanceof Error ? error : new Error(String(error || '局部 OCR 失败'))
    }
  }

  if (updatedBlockIds.length === 0) {
    if (firstError && failedBlockCount === candidates.length) throw firstError
    return {
      attemptedBlockCount: candidates.length,
      updatedBlockCount: 0,
      skippedBlockCount,
      failedBlockCount,
      updatedBlockIds,
    }
  }

  const normalized = normalizeOcrResultForStorage(nextResult, page, 'paddle')
  const preparedResult = preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_result', normalized.result)
  const preparedText = preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_text', normalized.text)
  const updatedAt = new Date().toISOString()
  transaction(() => {
    run(
      'UPDATE pages SET ocr_result = ?, ocr_result_ref = ?, ocr_text = ?, ocr_text_ref = ? WHERE id = ?',
      [preparedResult.value, preparedResult.ref, preparedText.value, preparedText.ref, page.id],
    )
    run(
      `UPDATE page_ocr_versions
       SET ocr_result = ?, ocr_result_ref = ?, ocr_text = ?, ocr_text_ref = ?, updated_at = ?
       WHERE page_id = ? AND is_active = 1`,
      [preparedResult.value, preparedResult.ref, preparedText.value, preparedText.ref, updatedAt, page.id],
    )
  })
  markDocumentTocDirty(page.doc_id)
  markSearchIndexStaleForPages([page.id])
  notifySearchContentChanged()
  scheduleDatabaseSave()
  return {
    attemptedBlockCount: candidates.length,
    updatedBlockCount: updatedBlockIds.length,
    skippedBlockCount,
    failedBlockCount,
    updatedBlockIds,
  }
}

function reprocessDocumentOcrStructure(docId: string): string[] {
  const rows = hydratePagePayloadRows(queryAll<DocumentPage>(
    `SELECT *
     FROM pages
     WHERE doc_id = ? AND ocr_status = 'completed'
     ORDER BY page_num`,
    [docId],
  ))
  const pagesWithResults = rows
    .map((page) => ({ page, result: parseJsonRecord(page.ocr_result) }))
    .filter((item): item is { page: DocumentPage; result: OcrResultRecord } => Boolean(item.result))
  if (pagesWithResults.length === 0) return []

  const generatedAt = new Date().toISOString()
  const documentIr = buildOcrDocumentV1(
    pagesWithResults.map((item) => item.result),
    { forceRebuild: true, generatedAt },
  )
  const changedPageIds: string[] = []

  transaction(() => {
    pagesWithResults.forEach(({ page, result }, index) => {
      const irPage = documentIr.pages[index]
      if (!irPage) return
      const envelope = {
        schemaVersion: OCR_IR_SCHEMA_VERSION,
        generator: 'GujiSmart' as const,
        pipelineVersion: OCR_IR_PIPELINE_VERSION,
        generatedAt,
        page: {
          ...irPage,
          pageIndex: Number(page.page_num || irPage.pageIndex || index + 1),
        },
      }
      const text = deriveOcrTextFromIr(envelope)
      const nextResult: OcrResultRecord = {
        ...result,
        text,
        words_result: deriveOcrWordsResultFromIr(envelope),
        gujismart_ir: envelope,
        ir_text: text,
        normalization: {
          ...(isJsonRecord(result.normalization) ? result.normalization : {}),
          schema_version: OCR_IR_SCHEMA_VERSION,
          pipeline_version: OCR_IR_PIPELINE_VERSION,
          generated_at: generatedAt,
          document_postprocessed: true,
        },
      }
      const preparedResult = preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_result', JSON.stringify(nextResult))
      const preparedText = preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_text', text)
      run(
        'UPDATE pages SET ocr_result = ?, ocr_result_ref = ?, ocr_text = ?, ocr_text_ref = ? WHERE id = ?',
        [preparedResult.value, preparedResult.ref, preparedText.value, preparedText.ref, page.id],
      )
      run(
        `UPDATE page_ocr_versions
         SET ocr_result = ?, ocr_result_ref = ?, ocr_text = ?, ocr_text_ref = ?, updated_at = ?
         WHERE page_id = ? AND is_active = 1`,
        [preparedResult.value, preparedResult.ref, preparedText.value, preparedText.ref, generatedAt, page.id],
      )
      changedPageIds.push(page.id)
    })
  })
  return changedPageIds
}

function updatePageOcrState(pageId: string, result: OcrRecognizeResult, engine: OcrEngine = 'paddle'): void {
  const page = queryOne<OcrSavePageSnapshot>('SELECT id, doc_id, page_num, image_path, proofed_text, ocr_text, ocr_result, ocr_status FROM pages WHERE id = ?', [pageId])
  if (!page) return
  const repeatedIssue = findSuspiciousRepeatedOcrText(result)
  if (repeatedIssue) {
    throw new Error(formatSuspiciousRepeatedOcrTextIssue(repeatedIssue))
  }
  const normalized = normalizeOcrResultForStorage(result, page, engine)
  const text = normalized.text
  const preparedText = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_text', text)
  const preparedResult = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_result', normalized.result)
  run(
    'UPDATE pages SET ocr_result = ?, ocr_result_ref = ?, ocr_text = ?, ocr_text_ref = ?, proofed_text = ?, proofed_text_ref = ?, ocr_status = ?, proof_status = ? WHERE id = ?',
    [preparedResult.value, preparedResult.ref, preparedText.value, preparedText.ref, null, null, 'completed', 'pending', pageId],
  )
  upsertPageOcrVersion(pageId, engine, normalized.result, text, 'completed', page)
  markDocumentTocDirty(page.doc_id)
}

function parseMetadata(value: unknown): JsonRecord {
  if (!value) return {}
  return parseJsonRecord(value) || {}
}

function resolveOcrEngine(doc: Pick<OcrDocumentRow, 'metadata'>, requested?: OcrEngine): OcrEngine {
  if (requested === 'paddle' || requested === 'vision_model' || requested === 'hybrid') return requested
  const storedEngine = parseMetadata(doc.metadata).ocr_engine
  if (storedEngine === 'vision_model' || storedEngine === 'hybrid') return storedEngine
  return 'paddle'
}

function getOcrResultSourceType(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const sourceType = (result as { source_type?: unknown }).source_type
  return typeof sourceType === 'string' ? sourceType : ''
}

function hasHybridVisionRefineFallback(pageResults: OcrPageResult[]): boolean {
  return pageResults.some((item) => {
    if (!item.result || typeof item.result !== 'object') return true
    const result = item.result as { source_type?: unknown; vision_refine_error?: unknown }
    return result.source_type === 'hybrid_ocr_fallback' || !!result.vision_refine_error
  })
}

function hasCompletedHybridVisionRefine(pageResults: OcrPageResult[]): boolean {
  return pageResults.length > 0 && pageResults.every((item) => (
    item.status === 'completed'
    && getOcrResultSourceType(item.result) === 'hybrid_ocr'
  ))
}

function updateDocumentOcrEngine(doc: Pick<OcrDocumentRow, 'id' | 'metadata'>, engine: OcrEngine): void {
  const latest = queryOne<{ metadata: string | null }>('SELECT metadata FROM documents WHERE id = ?', [doc.id])
  const metadata = { ...parseMetadata(latest?.metadata ?? doc.metadata), ocr_engine: engine }
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(metadata), new Date().toISOString(), doc.id])
}

function clearDeferredPdfPageRecordMarker(docId: string): void {
  const row = queryOne<{ metadata: string | null }>('SELECT metadata FROM documents WHERE id = ?', [docId])
  const metadata = parseMetadata(row?.metadata)
  if (metadata.pdf_page_records_deferred === undefined) return
  delete metadata.pdf_page_records_deferred
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(metadata), new Date().toISOString(), docId])
}

function buildReaderTocFromVisionResults(pageResults: OcrPageResult[]): Array<Partial<TocItemV2> & JsonRecord> {
  const entries: Array<Partial<TocItemV2> & JsonRecord> = []
  const seen = new Set<string>()
  for (const pageResult of pageResults) {
    const result = getPageResultRecord(pageResult)
    const candidates = Array.isArray(result?.toc_candidates) ? result.toc_candidates.filter(isJsonRecord) : []
    for (const candidate of candidates) {
      const title = String(candidate.title || '').replace(/\s+/g, ' ').trim()
      const pageNum = Number(candidate.pageNum || result?.page_num || 0)
      const confidence = Number(candidate.confidence)
      if (!title || title.length < 2 || !Number.isFinite(pageNum) || pageNum <= 0) continue
      if (Number.isFinite(confidence) && confidence < 0.45) continue
      const key = `${title}:${pageNum}`
      if (seen.has(key)) continue
      seen.add(key)
      const pageText = String(result?.corrected_text || result?.text || '').trim()
      const candidateCharIndex = Number(candidate.charIndex ?? candidate.char_index ?? candidate.charStart ?? candidate.char_start)
      const charIndex = Number.isFinite(candidateCharIndex) && candidateCharIndex >= 0
        ? Math.floor(candidateCharIndex)
        : Math.max(0, pageText.indexOf(title))
      entries.push({
        id: `vision-toc-${entries.length}`,
        title,
        href: `page:${Math.floor(pageNum)}:char:${charIndex}`,
        level: Math.max(1, Math.min(6, Number(candidate.level) || 2)),
        entry_type: String(candidate.entry_type || candidate.type || '').trim() || null,
        parent_title: String(candidate.parent_title || candidate.parentTitle || '').replace(/\s+/g, ' ').trim() || null,
        order: entries.length,
        parent_id: null,
        anchor_text: title,
        anchor_context: pageText.slice(Math.max(0, charIndex - 80), charIndex + title.length + 160),
        anchor_key: `page:${Math.floor(pageNum)}:char:${charIndex}`,
        source_page_num: Math.floor(pageNum),
      })
    }
  }
  return entries.slice(0, 240).map((item, index) => ({ ...item, order: index }))
}

function mergeVisionTocIntoMetadata(doc: Pick<OcrDocumentRow, 'id' | 'metadata' | 'title' | 'page_count'>, pageResults: OcrPageResult[]): void {
  const toc = buildReaderTocFromVisionResults(pageResults)
  if (toc.length === 0) return
  const metadata = parseMetadata(doc.metadata)
  const manifest = metadata.ebook_manifest && typeof metadata.ebook_manifest === 'object' && !Array.isArray(metadata.ebook_manifest)
    ? metadata.ebook_manifest as JsonRecord
    : null
  const hasHybridResult = pageResults.some((pageResult) => String(getPageResultRecord(pageResult)?.source_type || '').startsWith('hybrid_ocr'))
  const nextMetadata: JsonRecord = {
    ...metadata,
    ocr_engine: hasHybridResult ? 'hybrid' : 'vision_model',
    ebook_manifest: manifest
      ? { ...manifest, toc: undefined }
      : {
          format: 'plain_text',
          title: doc.title || '',
          section_count: Number(doc.page_count || pageResults.length || 0),
          spine: [],
        },
  }
  delete nextMetadata.reader_toc
  delete nextMetadata.manual_toc
  delete nextMetadata.ai_toc
  delete nextMetadata.vision_toc
  delete nextMetadata.toc_source
  delete nextMetadata.toc_updated_at
  if (nextMetadata.ebook_manifest && typeof nextMetadata.ebook_manifest === 'object') {
    delete (nextMetadata.ebook_manifest as JsonRecord).toc
  }
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(nextMetadata), new Date().toISOString(), doc.id])
  saveDocumentToc(doc.id, toc.map((item, index): TocItemV2 => ({
    id: String(item.id || `vision-toc-${index}`),
    title: String(item.title || ''),
    href: String(item.href || ''),
    level: Math.max(1, Math.min(6, Number(item.level) || 2)),
    order: index,
    parent_id: item.parent_id ?? null,
    anchor_text: typeof item.anchor_text === 'string' ? item.anchor_text : String(item.title || ''),
    anchor_context: typeof item.anchor_context === 'string' ? item.anchor_context : null,
    anchor_key: typeof item.anchor_key === 'string' ? item.anchor_key : null,
    source_page_num: Number.isFinite(Number(item.source_page_num)) ? Number(item.source_page_num) : null,
    source: hasHybridResult ? 'ai' : 'imported',
    confidence: Number(item.confidence) || 0.72,
    status: 'active',
  })), hasHybridResult ? 'ai' : 'imported')
}

async function ensurePageRecords(docId: string, pageCount: number): Promise<OcrPageRow[]> {
  const safePageCount = Math.max(0, Math.round(Number(pageCount || 0)))
  if (safePageCount <= 0) {
    return queryAll<OcrPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
  }

  const now = new Date().toISOString()
  const existingPageNums = new Set(
    queryAll<{ page_num: number | null }>('SELECT page_num FROM pages WHERE doc_id = ? AND page_num BETWEEN 1 AND ?', [docId, safePageCount])
      .map((row) => Number(row.page_num || 0))
      .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0),
  )

  for (let index = 0; index < safePageCount; index += OCR_PAGE_INSERT_CHUNK_SIZE) {
    const pageNums = Array.from(
      { length: Math.min(OCR_PAGE_INSERT_CHUNK_SIZE, safePageCount - index) },
      (_, offset) => index + offset + 1,
    ).filter((pageNum) => !existingPageNums.has(pageNum))

    if (pageNums.length > 0) {
      transaction(() => {
        pageNums.forEach((pageNum) => {
          run(
            'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [nanoid(), docId, pageNum, null, null, null, null, 'pending', 'pending', now],
          )
          existingPageNums.add(pageNum)
        })
      })
    }

    if (index + OCR_PAGE_INSERT_CHUNK_SIZE < safePageCount) {
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
  return queryAll<OcrPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
}

function hasSequentialPageRecords(pages: OcrPageRow[], pageCount: number): boolean {
  const safePageCount = Math.max(0, Math.round(Number(pageCount || 0)))
  if (safePageCount <= 0 || pages.length < safePageCount) return false
  for (let index = 0; index < safePageCount; index += 1) {
    if (Number(pages[index]?.page_num || 0) !== index + 1) return false
  }
  return true
}

async function ensurePageRecordsIfNeeded(docId: string, pages: OcrPageRow[], pageCount: number): Promise<OcrPageRow[]> {
  return hasSequentialPageRecords(pages, pageCount) ? pages : ensurePageRecords(docId, pageCount)
}

function getExpectedPdfPageCount(doc: Pick<OcrDocumentRow, 'page_count' | 'metadata'>, pages: OcrPageRow[] = []): number {
  const metadata = parseJsonRecord(doc.metadata) || {}
  const metadataPageCount = Number(metadata.pdf_page_count || metadata.page_count || 0)
  return Math.max(
    pages.length,
    Number(doc.page_count || 0) || 0,
    Number.isFinite(metadataPageCount) ? Math.floor(metadataPageCount) : 0,
  )
}

function isPageOcrCompleted(page: Pick<OcrPageRow, 'ocr_status'>): boolean {
  return String(page?.ocr_status || '') === 'completed'
}

function getCompletedOcrPageCount(pages: OcrPageRow[]): number {
  return pages.filter(isPageOcrCompleted).length
}

function getPagesNeedingOcr(pages: OcrPageRow[], resumeExisting: boolean): OcrPageRow[] {
  if (!resumeExisting) return pages
  return pages.filter((page) => !isPageOcrCompleted(page))
}

function resetPagesForFullOcrRerun(docId: string): void {
  run(
    `UPDATE pages
     SET ocr_result = NULL,
         ocr_result_ref = NULL,
         ocr_text = NULL,
         ocr_text_ref = NULL,
         proofed_text = NULL,
         proofed_text_ref = NULL,
         ocr_status = ?,
         proof_status = ?
     WHERE doc_id = ?`,
    ['pending', 'pending', docId],
  )
  const pageIds = queryAll<{ id: string }>('SELECT id FROM pages WHERE doc_id = ?', [docId]).map((page) => page.id)
  clearPageSearchIndexForDocuments([docId])
  markSearchIndexStaleForPages(pageIds)
  scheduleDatabaseSave()
}

function hasIncompleteOcrPages(docId: string): boolean {
  const stats = queryOne<{ total: number; completed: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN ocr_status = 'completed' THEN 1 ELSE 0 END) as completed
     FROM pages
     WHERE doc_id = ?`,
    [docId],
  )
  const total = Number(stats?.total || 0)
  const completed = Number(stats?.completed || 0)
  return total === 0 || completed < total
}

function summarizeDocumentOcrPages(docId: string): { total: number; completed: number; failed: number; pending: number } {
  const stats = queryOne<{ total: number; completed: number; failed: number; pending: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN ocr_status = 'completed' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN ocr_status = 'error' THEN 1 ELSE 0 END) as failed,
       SUM(CASE WHEN ocr_status IS NULL OR ocr_status IN ('pending', 'queued', 'processing') THEN 1 ELSE 0 END) as pending
     FROM pages
     WHERE doc_id = ?`,
    [docId],
  )
  return {
    total: Number(stats?.total || 0),
    completed: Number(stats?.completed || 0),
    failed: Number(stats?.failed || 0),
    pending: Number(stats?.pending || 0),
  }
}

function isDocumentOcrCompleteFromPages(docId: string): boolean {
  const stats = summarizeDocumentOcrPages(docId)
  return stats.total > 0 && stats.completed === stats.total
}

function getDocumentTotalPages(docId: string, pageSummary?: { total: number }): number | undefined {
  const doc = queryOne<{ page_count: number | null }>('SELECT page_count FROM documents WHERE id = ?', [docId])
  const totalPages = Number(doc?.page_count || 0) || Number(pageSummary?.total || 0)
  return totalPages > 0 ? totalPages : undefined
}

function emitOcrAlreadyRunningStatus(event: Electron.IpcMainInvokeEvent, docId: string): void {
  const stats = summarizeDocumentOcrPages(docId)
  const totalPages = getDocumentTotalPages(docId, stats)
  if (stats.total > 0 && stats.completed === stats.total) {
    updateDocumentStatus(docId, 'completed', 'processed', null)
    emitOcrStatus(event, {
      docId,
      status: 'completed',
      phase: 'completed',
      progress: 1,
      completedPages: stats.completed,
      totalPages,
      message: 'OCR 已完成',
    })
    return
  }
  emitOcrStatus(event, {
    docId,
    status: 'processing',
    phase: 'ocr',
    progress: totalPages ? Math.min(0.99, stats.completed / Math.max(totalPages, 1)) : 0,
    completedPages: stats.completed,
    totalPages,
    message: 'OCR 已在继续处理中，请等待当前任务完成',
  })
}

function emitOcrCanceledOrCompletedStatus(
  event: Electron.IpcMainInvokeEvent,
  docId: string,
  progress = 0,
  totalPages?: number,
): boolean {
  const stats = summarizeDocumentOcrPages(docId)
  const completed = stats.total > 0 && stats.completed === stats.total
  const resolvedTotalPages = totalPages || getDocumentTotalPages(docId, stats)
  emitOcrStatus(event, {
    docId,
    status: completed ? 'completed' : 'canceled',
    phase: completed ? 'completed' : 'canceled',
    progress: completed ? 1 : progress,
    completedPages: stats.completed,
    totalPages: resolvedTotalPages,
    message: completed ? 'OCR 已完成' : OCR_CANCELED_MESSAGE,
    errorMessage: completed ? undefined : OCR_CANCELED_MESSAGE,
    canceled: !completed,
  })
  return completed
}

function getDocumentOcrFailureMessage(docId: string): string {
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
        : `第 ${row.page_num || '?'} 页 OCR 失败`
    })
    .filter(Boolean)
  return messages.join('；') || '部分页面 OCR 未完成'
}

function updateDocumentStatusFromPages(docId: string, errorMessage?: string | null): void {
  const stats = summarizeDocumentOcrPages(docId)
  const now = new Date().toISOString()
  const nextStatus = stats.total > 0 && stats.completed === stats.total
    ? 'completed'
    : stats.failed > 0
      ? 'error'
      : stats.pending > 0
        ? 'processing'
        : 'pending'
  const importStatus = nextStatus === 'completed' ? 'processed' : nextStatus === 'error' ? 'error' : nextStatus
  const errorValue = nextStatus === 'completed' ? null : errorMessage ? String(errorMessage).slice(0, 1000) : null
  run(
    'UPDATE documents SET ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    [nextStatus, importStatus, errorValue, now, docId],
  )
  scheduleDatabaseSave()
}

function updateDocumentCanceledStatus(docId: string): void {
  const stats = summarizeDocumentOcrPages(docId)
  const nextStatus = stats.total > 0 && stats.completed === stats.total ? 'completed' : 'pending'
  const importStatus = nextStatus === 'completed' ? 'processed' : 'stored'
  const errorMessage = nextStatus === 'completed' ? null : OCR_CANCELED_MESSAGE
  run(
    'UPDATE documents SET ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    [nextStatus, importStatus, errorMessage, new Date().toISOString(), docId],
  )
  run(
    "UPDATE pages SET ocr_status = ? WHERE doc_id = ? AND ocr_status IN ('queued', 'processing')",
    ['pending', docId],
  )
  scheduleDatabaseSave()
}

function markDocumentTocDirty(docId: string): void {
  run("DELETE FROM document_toc_items WHERE doc_id = ? AND source != 'manual'", [docId])
  clearDocumentTocAutogenAttempt(docId)
}

function guardRepeatedOcrPageResult(pageResult: OcrPageResult): OcrPageResult {
  if (pageResult.status !== 'completed') return pageResult
  const repeatedIssue = findSuspiciousRepeatedOcrText(pageResult.result || pageResult.text)
  if (!repeatedIssue) return pageResult
  const message = formatSuspiciousRepeatedOcrTextIssue(repeatedIssue)
  return {
    pageId: pageResult.pageId,
    result: null,
    text: '',
    status: 'error',
    error: message,
  }
}

function savePageOcrResults(pageResults: OcrPageResult[], engine: OcrEngine = 'paddle', options: SavePageOcrResultsOptions = {}): string[] {
  if (pageResults.length === 0) return []
  const guardedPageResults = pageResults.map(guardRepeatedOcrPageResult)
  const startedAt = Date.now()
  const changedPageIds: string[] = []
  const changedDocIds = new Set<string>()
  const tocDirtyDocIds = new Set<string>()
  let pageSnapshots = new Map<string, OcrSavePageSnapshot>()
  const versionWrites: OcrVersionWrite[] = []

  transaction(() => {
    pageSnapshots = getPageSnapshotsForOcrSave(guardedPageResults.map((pageResult) => pageResult.pageId))
    for (const pageResult of guardedPageResults) {
      const existingPage = pageSnapshots.get(pageResult.pageId)
      const hasProofedText = String(existingPage?.proofed_text || '').trim().length > 0
      const hasExistingCompletedText = String(existingPage?.ocr_status || '') === 'completed'
        && String(existingPage?.ocr_text || '').trim().length > 0
      if (pageResult.status === 'error' && hasExistingCompletedText) {
        continue
      }
      const normalizedCompleted = pageResult.status === 'completed' && pageResult.result
        ? normalizeOcrResultForStorage(pageResult.result, existingPage, engine)
        : null
      const resultPayload = normalizedCompleted?.result || pageResult.result || (pageResult.error
        ? {
            source_type: 'ocr_error',
            error: pageResult.error,
            failed_at: new Date().toISOString(),
          }
        : null)
      const resultText = normalizedCompleted?.text || pageResult.text
      const resultJson = resultPayload ? JSON.stringify(resultPayload) : null
      if (
        existingPage
        && String(existingPage.ocr_status || '') === pageResult.status
        && String(existingPage.ocr_text || '') === String(resultText || '')
        && String(existingPage.ocr_result || '') === String(resultJson || '')
      ) {
        continue
      }
      const preparedResult = existingPage
        ? preparePagePayloadUpdate(existingPage.doc_id, pageResult.pageId, 'ocr_result', resultJson)
        : { value: resultJson, ref: null }
      const preparedText = existingPage
        ? preparePagePayloadUpdate(existingPage.doc_id, pageResult.pageId, 'ocr_text', resultText)
        : { value: String(resultText || ''), ref: null }
      run(
        `UPDATE pages
         SET ocr_result = ?,
             ocr_result_ref = ?,
             ocr_text = ?,
             ocr_text_ref = ?,
             ocr_status = ?,
             proof_status = CASE WHEN ? THEN proof_status ELSE ? END
         WHERE id = ?`,
        [
          preparedResult.value,
          preparedResult.ref,
          preparedText.value,
          preparedText.ref,
          pageResult.status,
          hasProofedText ? 1 : 0,
          'pending',
          pageResult.pageId,
        ],
      )
      changedPageIds.push(pageResult.pageId)
      if (existingPage?.doc_id) changedDocIds.add(existingPage.doc_id)
      const existingText = String(existingPage?.ocr_text || '').trim()
      const nextText = String(resultText || '').trim()
      const existingResult = String(existingPage?.ocr_result || '')
      const nextResult = String(resultJson || '')
      const shouldInvalidateToc = pageResult.status === 'completed'
        && existingPage?.doc_id
        && (
          String(existingPage.ocr_status || '') !== 'completed'
          || existingText !== nextText
          || existingResult !== nextResult
      )
      if (shouldInvalidateToc) tocDirtyDocIds.add(existingPage.doc_id)
      if (pageResult.status === 'completed' && resultPayload && existingPage) {
        versionWrites.push({
          pageId: pageResult.pageId,
          page: existingPage,
          result: resultPayload,
          text: resultText,
          status: pageResult.status,
        })
      }
    }
    markPageOcrVersionsInactive(versionWrites.map((item) => item.pageId))
    versionWrites.forEach((item) => {
      upsertPageOcrVersion(item.pageId, engine, item.result, item.text, item.status, item.page, { deactivateExisting: false })
    })
  })

  if (changedPageIds.length > 0) {
    if (options.markTocDirty !== false) {
      tocDirtyDocIds.forEach(markDocumentTocDirty)
    }
    if (tocDirtyDocIds.size > 0) {
      options.onTocDirtyDocIds?.([...tocDirtyDocIds])
    }
    if (options.refreshSearch === true) {
      console.warn('[OCR] Synchronous OCR search refresh requested; deferring to background indexer.')
    }
    if (!options.deferFinalize) {
      scheduleOcrFinalizeForPages(changedPageIds)
    }
    if (!options.deferDatabaseSave) {
      scheduleDatabaseSave()
    }
  }
  logSlowOcrStep(`save ${guardedPageResults.length} OCR page result(s), changed ${changedPageIds.length}`, startedAt)
  return changedPageIds
}

async function savePageOcrResultsBatched(pageResults: OcrPageResult[], engine: OcrEngine = 'paddle', options: SavePageOcrResultsOptions = {}): Promise<string[]> {
  if (pageResults.length === 0) return []
  const changedPageIds: string[] = []
  const tocDirtyDocIds = new Set<string>()
  for (let index = 0; index < pageResults.length; index += OCR_RESULT_SAVE_CHUNK_SIZE) {
    changedPageIds.push(...savePageOcrResults(pageResults.slice(index, index + OCR_RESULT_SAVE_CHUNK_SIZE), engine, {
      ...options,
      refreshSearch: false,
      markTocDirty: false,
      deferFinalize: true,
      deferDatabaseSave: true,
      onTocDirtyDocIds: (docIds) => docIds.forEach((docId) => tocDirtyDocIds.add(docId)),
    }))
    if (index + OCR_RESULT_SAVE_CHUNK_SIZE < pageResults.length) {
      await yieldToEventLoop()
    }
  }
  if (changedPageIds.length > 0) {
    if (tocDirtyDocIds.size > 0) {
      if (options.markTocDirty !== false) {
        tocDirtyDocIds.forEach(markDocumentTocDirty)
      }
      options.onTocDirtyDocIds?.([...tocDirtyDocIds])
    }
    if (options.refreshSearch === true) {
      console.warn('[OCR] Synchronous OCR search refresh requested; deferring to background indexer.')
    }
    if (!options.deferFinalize) {
      scheduleOcrFinalizeForPages(changedPageIds)
    }
    if (!options.deferDatabaseSave) {
      scheduleDatabaseSave()
    }
  }
  return changedPageIds
}

async function processDocumentOcr(
  event: Electron.IpcMainInvokeEvent,
  docId: string,
  totalDocs: number,
  getCompleted: () => number,
  requestedEngine?: OcrEngine,
  forceFullRerun = false,
  processOptions: OcrProcessOptions = {},
): Promise<{ success: boolean; errorMessage?: string }> {
  const signal = processOptions.signal
  if (signal?.aborted) {
    updateDocumentCanceledStatus(docId)
    const completed = emitOcrCanceledOrCompletedStatus(event, docId, getDocProgress(getCompleted(), totalDocs))
    if (completed) return { success: true }
    return { success: false, errorMessage: OCR_CANCELED_MESSAGE }
  }
  const doc = queryOne<OcrDocumentRow>('SELECT * FROM documents WHERE id = ?', [docId])
  if (!doc) {
    return { success: false }
  }
  const completedDocHasIncompletePages = doc.ocr_status === 'completed' && hasIncompleteOcrPages(docId)
  if (doc.ocr_status === 'completed' && !forceFullRerun && !requestedEngine && !completedDocHasIncompletePages) {
    return { success: false }
  }

  let pages = queryAll<OcrPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
  const resumeExisting = !forceFullRerun
  if (forceFullRerun && pages.length > 0) {
    resetPagesForFullOcrRerun(docId)
    pages = queryAll<OcrPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
  }
  let pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
  let completedBefore = resumeExisting ? getCompletedOcrPageCount(pages) : 0
  const getDocTotalPages = () => Math.max(pages.length, Number(doc.page_count || 0) || 0)
  const getCombinedPageCount = (completedPages: number) => completedBefore + completedPages
  const getCombinedDocFraction = (completedPages: number, totalPages?: number) => {
    const total = getDocTotalPages() || totalPages || pagesForOcr.length || 1
    return Math.min(0.95, getCombinedPageCount(completedPages) / Math.max(total, 1))
  }
  let pdfPath = resolveUsablePdfPath(doc, Math.max(pages.length, Number(doc.page_count || 0) || 0))
  let canUsePdfAsync = shouldUsePdfOcrForWork(pdfPath, pages, pagesForOcr, Number(doc.page_count || 0) || 0)
  const ocrOptions = resolveDocOcrOptions(doc.doc_type)
  const engine = resolveOcrEngine(doc, requestedEngine)
  updateDocumentOcrEngine(doc, engine)

  if (pages.length === 0 && !canUsePdfAsync && engine !== 'vision_model') {
    const errorMessage = '文献没有可处理的页面。若这是 PDF，请先重新导入或点击“重试处理”让软件重新读取页数。'
    updateDocumentStatus(docId, 'error', 'error', errorMessage)
    return { success: false, errorMessage }
  }

  if (pages.length > 0 && pagesForOcr.length === 0 && hasSequentialPageRecords(pages, getExpectedPdfPageCount(doc, pages))) {
    updateDocumentStatus(docId, 'completed', 'processed', null)
    syncDocumentProofStatus(docId)
    return { success: true }
  }

  run(
    'UPDATE documents SET ocr_status = ?, import_status = ?, metadata_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    ['processing', 'processing', 'pending', null, new Date().toISOString(), docId],
  )
  scheduleDatabaseSave()
  emitOcrStatus(event, {
    docId,
    status: 'processing',
    phase: 'ocr',
    progress: getDocProgress(getCompleted(), totalDocs),
    completedPages: completedBefore,
    totalPages: getDocTotalPages(),
    message: completedBefore > 0
      ? `继续 OCR：已完成 ${completedBefore}/${getDocTotalPages()} 页`
      : 'OCR 识别中',
  })

  const maxAttempts = getRetryLimit() + 1
  let lastErrorMessage = ''
  let aiExtractionStarted = false
  const deferredFinalizePageIds = new Set<string>()
  const deferredTocDirtyDocIds = new Set<string>()
  let deferredDatabaseSaveNeeded = false
  const savePageOcrResultsDeferred = (
    pageResults: OcrPageResult[],
    resultEngine: OcrEngine = 'paddle',
    options: SavePageOcrResultsOptions = {},
  ): string[] => {
    const changedPageIds = savePageOcrResults(pageResults, resultEngine, {
      ...options,
      markTocDirty: false,
      deferFinalize: true,
      deferDatabaseSave: true,
      onTocDirtyDocIds: (docIds) => docIds.forEach((tocDocId) => deferredTocDirtyDocIds.add(tocDocId)),
    })
    changedPageIds.forEach((pageId) => deferredFinalizePageIds.add(pageId))
    if (changedPageIds.length > 0) deferredDatabaseSaveNeeded = true
    return changedPageIds
  }
  const savePageOcrResultsBatchedDeferred = async (
    pageResults: OcrPageResult[],
    resultEngine: OcrEngine = 'paddle',
    options: SavePageOcrResultsOptions = {},
  ): Promise<string[]> => {
    const changedPageIds = await savePageOcrResultsBatched(pageResults, resultEngine, {
      ...options,
      markTocDirty: false,
      deferFinalize: true,
      deferDatabaseSave: true,
      onTocDirtyDocIds: (docIds) => docIds.forEach((tocDocId) => deferredTocDirtyDocIds.add(tocDocId)),
    })
    changedPageIds.forEach((pageId) => deferredFinalizePageIds.add(pageId))
    if (changedPageIds.length > 0) deferredDatabaseSaveNeeded = true
    return changedPageIds
  }

  try {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfOcrCanceled(signal)
    if (attempt > 1) {
      const previousReason = lastErrorMessage || queryOne<{ error_message: string | null }>(
        'SELECT error_message FROM documents WHERE id = ?',
        [docId],
      )?.error_message || ''
      const retryMessage = previousReason && !previousReason.includes('自动重试中')
        ? `第 ${attempt} 次自动重试中... 上次失败：${previousReason}`
        : `第 ${attempt} 次自动重试中...`
      run(
        'UPDATE documents SET retry_count = COALESCE(retry_count, 0) + 1, last_retry_at = ?, error_message = ? WHERE id = ?',
        [new Date().toISOString(), retryMessage.slice(0, 1000), docId],
      )
      scheduleDatabaseSave()
      emitOcrStatus(event, {
        docId,
        status: 'processing',
        phase: 'ocr',
        progress: getDocProgress(getCompleted(), totalDocs),
        errorMessage: retryMessage,
      })
    }

    pages = queryAll<OcrPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
    pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
    completedBefore = resumeExisting ? getCompletedOcrPageCount(pages) : 0
    pdfPath = resolveUsablePdfPath(doc, Math.max(pages.length, Number(doc.page_count || 0) || 0))
    canUsePdfAsync = shouldUsePdfOcrForWork(pdfPath, pages, pagesForOcr, Number(doc.page_count || 0) || 0)
    if (pages.length > 0 && pagesForOcr.length === 0 && hasSequentialPageRecords(pages, getExpectedPdfPageCount(doc, pages))) {
      updateDocumentStatus(docId, 'completed', 'processed', null)
      syncDocumentProofStatus(docId)
      scheduleOcrFinalizeForPages(pages.map((page) => page.id))
      return { success: true }
    }

    try {
    throwIfOcrCanceled(signal)
    let pageResults: OcrPageResult[] = []
    let pageResultsPersistedInChunks = false
    let streamedAsyncPageSummary: { total: number; completed: number; failed: number; pending: number } | null = null
    let usedNativePdfTextOnly = false

    if (engine === 'paddle' && pdfPath && !forceFullRerun && pagesForOcr.length > 0) {
      try {
        const preflight = await analyzePdfTextLayer(pdfPath, { maxSamplePages: 10, analyzeAllPages: true })
        persistPdfTextLayerSummary(doc, preflight)
        if (preflight.mode !== 'ocr') {
          pages = await ensurePageRecordsIfNeeded(docId, pages, preflight.pageCount)
          pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
          const pendingPageNumbers = new Set(pagesForOcr.map((page) => Number(page.page_num || 0)).filter((pageNum) => pageNum > 0))
          const nativeAnalysisByPage = new Map(
            preflight.pages
              .filter((page) => page.mode === 'native_text' && pendingPageNumbers.has(page.pageNum))
              .map((page) => [page.pageNum, page]),
          )
          const nativeResults = pagesForOcr
            .map((page) => {
              const analysis = nativeAnalysisByPage.get(Number(page.page_num || 0))
              return analysis ? buildNativePdfPageResult(page, analysis) : null
            })
            .filter((item): item is OcrPageResult => item !== null)
          const scanPages = pagesForOcr.filter((page) => !nativeAnalysisByPage.has(Number(page.page_num || 0)))
          const canSelectPagesSafely = scanPages.length === 0 || !findMissingReadablePageImage(scanPages)

          if (nativeResults.length > 0 && canSelectPagesSafely) {
            emitOcrStatus(event, {
              docId,
              status: 'processing',
              phase: 'ocr',
              progress: getDocProgress(getCompleted(), totalDocs, getCombinedDocFraction(nativeResults.length, pagesForOcr.length)),
              completedPages: completedBefore + nativeResults.length,
              totalPages: getDocTotalPages() || preflight.pageCount,
              message: scanPages.length === 0
                ? `已验证 PDF 原生文本层，直接读取 ${nativeResults.length} 页`
                : `已读取 ${nativeResults.length} 页原生文本，剩余 ${scanPages.length} 页进行 OCR`,
            })
            if (scanPages.length === 0) {
              pageResults = nativeResults
              pagesForOcr = []
              canUsePdfAsync = false
              usedNativePdfTextOnly = true
            } else {
              await savePageOcrResultsBatchedDeferred(nativeResults, 'paddle', { refreshSearch: false })
              pages = queryAll<OcrPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
              pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
              completedBefore = getCompletedOcrPageCount(pages)
              canUsePdfAsync = false
            }
          }
        }
      } catch (error) {
        console.warn('[OCR] PDF text-layer preflight failed; continuing with OCR', error)
      }
    }

    if (usedNativePdfTextOnly) {
      // pageResults already contains the trusted native PDF text pages.
    } else if (engine === 'hybrid') {
      if (!hasVisionOcrConfig()) {
        throw new Error('请先配置视觉模型 OCR 后再使用混合 OCR。')
      }
      const baseResults = await recognizePages(pagesForOcr, ocrOptions, (payload) => {
        throwIfOcrCanceled(signal)
        const combinedPages = getCombinedPageCount(payload.completedPages)
        const totalPages = getDocTotalPages() || payload.totalPages
        const docFraction = totalPages > 0 ? Math.min(0.55, combinedPages / totalPages * 0.55) : 0
        emitOcrStatus(event, {
          docId,
          status: 'processing',
          phase: 'ocr',
          progress: getDocProgress(getCompleted(), totalDocs, docFraction),
          completedPages: combinedPages,
          totalPages,
          pageNum: payload.pageNum,
          errorMessage: payload.error,
          message: `混合 OCR 第 1 步：传统 OCR 底稿 ${combinedPages}/${totalPages} 页`,
        })
      }, { signal, concurrency: processOptions.pageConcurrency })
      const failedBasePages = baseResults.filter((item) => item.status === 'error')
      if (failedBasePages.length > 0) {
        pageResults = baseResults
      } else {
        emitOcrStatus(event, {
          docId,
          status: 'processing',
          phase: 'ocr',
          progress: getDocProgress(getCompleted(), totalDocs, 0.55),
          completedPages: completedBefore,
          totalPages: getDocTotalPages(),
          message: '混合 OCR 第 2 步：正在启动视觉整理，完成后才会提取元数据',
        })
        pageResults = await refinePagesWithVisionModel(
          pagesForOcr.map((page, index) => ({
            ...page,
            ocr_text: baseResults[index]?.text || '',
            ocr_result: baseResults[index]?.result || null,
          })),
          doc.doc_type,
          (payload) => {
            throwIfOcrCanceled(signal)
            const combinedPages = getCombinedPageCount(payload.completedPages)
            const totalPages = getDocTotalPages() || payload.totalPages
            const remainingPages = Math.max(totalPages - completedBefore, 1)
            const docFraction = payload.totalPages > 0 ? 0.55 + Math.min(0.4, payload.completedPages / remainingPages * 0.4) : 0.55
            if (payload.status === 'completed' && payload.result) {
              savePageOcrResultsDeferred([{
                pageId: payload.pageId,
                result: payload.result,
                text: payload.text || String(payload.result?.text || ''),
                status: 'completed',
              }], 'hybrid', { refreshSearch: false })
            }
            emitOcrStatus(event, {
              docId,
              status: 'processing',
              phase: 'ocr',
              progress: getDocProgress(getCompleted(), totalDocs, docFraction),
              completedPages: combinedPages,
              totalPages,
              pageNum: payload.pageNum,
              errorMessage: payload.error,
              message: `混合 OCR 第 2 步：视觉整理 ${combinedPages}/${totalPages} 页`,
            })
          },
        )
      }
    } else if (engine === 'vision_model') {
      if (!hasVisionOcrConfig()) {
        throw new Error('未配置视觉模型 OCR，请先到设置页填写端点、API Key 和模型 ID。')
      }
      if (pages.length === 0) {
        pages = await ensurePageRecords(docId, Number(doc.page_count || 0) || 0)
        pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
        completedBefore = resumeExisting ? getCompletedOcrPageCount(pages) : 0
      }
      if (pagesForOcr.length === 0) {
        throw new Error('文献已导入但没有可恢复的页记录或页图，无法继续视觉 OCR。请先重新打开文献生成页图，或重新导入该文件后再重试。')
      }
      const missingImagePage = findMissingReadablePageImage(pagesForOcr)
      if (missingImagePage) {
        throw new Error(`第 ${missingImagePage.page_num || ''} 页缺少可读取页图，无法使用大模型 OCR。请先用飞桨 OCR 或从 PDF 重新生成页图后再试。`)
      }
      pageResults = await recognizePagesWithVisionModel(pagesForOcr, doc.doc_type, (payload) => {
        throwIfOcrCanceled(signal)
        const combinedPages = getCombinedPageCount(payload.completedPages)
        const totalPages = getDocTotalPages() || payload.totalPages
        const docFraction = getCombinedDocFraction(payload.completedPages, payload.totalPages)
        if (payload.status === 'completed' && payload.result) {
          savePageOcrResultsDeferred([{
            pageId: payload.pageId,
            result: payload.result,
            text: payload.text || String(payload.result?.text || ''),
            status: 'completed',
          }], 'vision_model', { refreshSearch: false })
        }
        const sizeNote = payload.uploadBytes
          ? `，上传图约 ${(payload.uploadBytes / 1024 / 1024).toFixed(1)} MB`
          : ''
        const elapsedNote = payload.elapsedMs
          ? `，耗时 ${Math.round(payload.elapsedMs / 1000)} 秒`
          : ''
        const actionText = payload.status === 'processing' ? '正在提交' : payload.status === 'completed' ? '已完成' : '失败'
        const activeNote = payload.activePages ? `，并发中 ${payload.activePages} 页` : ''
        emitOcrStatus(event, {
          docId,
          status: 'processing',
          phase: 'ocr',
          progress: getDocProgress(getCompleted(), totalDocs, docFraction),
          completedPages: combinedPages,
          totalPages,
          pageNum: payload.pageNum,
          errorMessage: payload.error,
          message: `大模型 OCR ${actionText}：${combinedPages}/${totalPages} 页${activeNote}${sizeNote}${elapsedNote}`,
        })
      })
    } else if (canUsePdfAsync && pdfPath) {
      const expectedPdfPageCount = getExpectedPdfPageCount(doc, pages)
      if (!hasSequentialPageRecords(pages, expectedPdfPageCount)) {
        pages = await ensurePageRecordsIfNeeded(docId, pages, expectedPdfPageCount)
        pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
        completedBefore = resumeExisting ? getCompletedOcrPageCount(pages) : 0
      }
      let savedAsyncPageCount = completedBefore
      let lastAsyncDisplayedPageCount = completedBefore
      const savedAsyncPageIds = new Set(
        resumeExisting
          ? pages.filter(isPageOcrCompleted).map((page) => page.id)
          : [],
      )
      const savedAsyncFailedPageIds = new Set<string>()
      let savedAsyncChunksToDatabase = false
      const sourcePdfBytes = statSync(pdfPath).size
      const targetPageNums = pages.length > 0
        ? pagesForOcr
          .map((page) => Number(page.page_num))
          .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0)
        : undefined
      const fallbackPageCount = Math.max(getDocTotalPages(), pages.length, Number(doc.page_count || 0) || 0)
      const willPreferWholePdfUpload = fallbackPageCount > 0
      emitOcrStatus(event, {
        docId,
        status: 'processing',
        phase: 'ocr',
        progress: getDocProgress(getCompleted(), totalDocs, getCombinedDocFraction(0, pagesForOcr.length)),
        completedPages: completedBefore,
        totalPages: fallbackPageCount || getDocTotalPages(),
        message: willPreferWholePdfUpload
          ? `准备上传 PDF：${formatBytes(sourcePdfBytes)} / ${fallbackPageCount} 页`
          : `准备上传 PDF：${formatBytes(sourcePdfBytes)}`,
      })
      let asyncResults: unknown[] | null = null
      try {
        asyncResults = await recognizePdfAsync(pdfPath, (payload) => {
          throwIfOcrCanceled(signal)
          const newlyFinishedPages = payload.completedPages || payload.successPages || 0
          const totalPages = payload.totalPages || getDocTotalPages() || pages.length || 1
          const finishedPages = Math.min(totalPages, Math.max(
            lastAsyncDisplayedPageCount,
            savedAsyncPageCount,
            completedBefore + newlyFinishedPages,
          ))
          lastAsyncDisplayedPageCount = finishedPages
          const docFraction = totalPages > 0 ? Math.min(0.95, finishedPages / totalPages) : 0
          const isPreparing = String(payload.status || payload.state || '').toLowerCase() === 'preparing'
          const isUploading = String(payload.status || payload.state || '').toLowerCase() === 'uploading'
          const isWaitingForServerQueue = String(payload.status || payload.state || '').toLowerCase() === 'queued'
          const isWholePdfFallback = Boolean(payload.fallbackWholePdf)
          const isFullFileUpload = Boolean(payload.fullFileUpload)
          const isAwaitingAsyncResult = totalPages > 0 && finishedPages >= totalPages
          const hasServerProgress = newlyFinishedPages > 0 || Number(payload.progress || 0) > 0
          const fallbackRetryMessage = isPreparing && payload.fallbackReason ? '正在重新提交 PDF' : ''
          const waitingText = payload.waitingMs ? `，已等待 ${formatDurationMs(payload.waitingMs)}` : ''
          const pollText = payload.pollCount ? `，第 ${payload.pollCount} 次查询` : ''
          const statusQueryRetryMessage = payload.retryingStatusQuery
            ? isFullFileUpload
              ? `PDF 已提交，正在重新查询处理进度${waitingText}${pollText}：${formatBytes(sourcePdfBytes)} / ${totalPages} 页`
              : `PDF 分片已提交，正在重新查询处理进度${waitingText}${pollText}：第 ${payload.chunkIndex || 1}/${payload.totalChunks || 1} 片`
            : ''
          const asyncProgressMessage = isUploading && isFullFileUpload
            ? `正在上传 PDF：${formatBytes(sourcePdfBytes)} / ${totalPages} 页`
            : isUploading
            ? `正在上传 PDF 分片：第 ${payload.chunkIndex || 1}/${payload.totalChunks || 1} 片`
            : !hasServerProgress && finishedPages === 0 && isFullFileUpload && !isPreparing && !isWaitingForServerQueue
            ? `PDF 已提交，等待处理：${formatBytes(sourcePdfBytes)} / ${totalPages} 页`
            : !hasServerProgress && finishedPages === 0 && !isPreparing && !isWaitingForServerQueue
            ? `PDF 分片已提交，等待处理：第 ${payload.chunkIndex || 1}/${payload.totalChunks || 1} 片`
            : ''
          const uploadModeMessage = isFullFileUpload
            ? isUploading
              ? `正在上传 PDF：${formatBytes(sourcePdfBytes)} / ${totalPages} 页`
              : isWaitingForServerQueue
                ? `PDF 已提交，等待处理：${formatBytes(sourcePdfBytes)} / ${totalPages} 页`
                : isAwaitingAsyncResult
                  ? `OCR 结果保存中：${finishedPages}/${totalPages} 页`
                  : !hasServerProgress && finishedPages === 0 && !isPreparing
                    ? `PDF 已提交，等待处理：${formatBytes(sourcePdfBytes)} / ${totalPages} 页`
                    : `OCR 处理中：${finishedPages}/${totalPages} 页`
            : payload.chunkIndex && payload.totalChunks
              ? isUploading
                ? `正在上传 PDF 分片：第 ${payload.chunkIndex}/${payload.totalChunks} 片`
                : isPreparing
                  ? `正在准备 PDF 分片：第 ${payload.chunkIndex}/${payload.totalChunks} 片`
                  : isWaitingForServerQueue
                    ? `PDF 分片已提交，等待处理：第 ${payload.chunkIndex}/${payload.totalChunks} 片`
                    : `OCR 处理中：${finishedPages}/${totalPages} 页`
              : ''
          emitOcrStatus(event, {
            docId,
            status: 'processing',
            phase: isWaitingForServerQueue ? 'queued' : isAwaitingAsyncResult ? 'saving' : 'ocr',
            progress: getDocProgress(getCompleted(), totalDocs, isAwaitingAsyncResult ? 0.97 : docFraction),
            completedPages: finishedPages,
            totalPages,
            message: fallbackRetryMessage || statusQueryRetryMessage || uploadModeMessage || asyncProgressMessage || (isWaitingForServerQueue
              ? `排队中：${finishedPages}/${totalPages} 页`
              : isWholePdfFallback && isPreparing
              ? `正在重新提交 PDF：${formatBytes(sourcePdfBytes)}`
              : isWholePdfFallback
              ? `OCR 处理中：${finishedPages}/${totalPages} 页`
              : isFullFileUpload && isPreparing
              ? `正在上传 PDF：${formatBytes(sourcePdfBytes)} / ${totalPages} 页`
              : isAwaitingAsyncResult
              ? `OCR 结果保存中：${finishedPages}/${totalPages} 页`
              : isFullFileUpload
              ? `OCR 处理中：${finishedPages}/${totalPages} 页`
              : isPreparing && payload.chunkIndex && payload.totalChunks
              ? `正在准备 PDF 分片：第 ${payload.chunkIndex}/${payload.totalChunks} 片`
              : payload.chunkIndex && payload.totalChunks
              ? `OCR 处理中：${finishedPages}/${totalPages} 页`
              : `OCR 识别中：${finishedPages}/${totalPages} 页`),
          })
        }, {
          signal,
          targetPageNums,
          fallbackPageCount,
          collectChunkResults: false,
          onChunkComplete: async (chunk) => {
            throwIfOcrCanceled(signal)
            pages = await ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, chunk.totalPages))
            const chunkPages = chunk.sourcePageIndexes
              .map((sourcePageIndex) => ({
                page: pages[sourcePageIndex],
                sourcePageIndex,
              }))
              .filter((item): item is { page: OcrPageRow; sourcePageIndex: number } => Boolean(item.page))
            const chunkPageResults = await postProcessPdfOcrResultsBatched(
              chunkPages.map((item, index) => ({ ...item, resultIndex: index })),
              chunk.results,
              ocrOptions,
              signal,
              (item) => `PaddleOCR 异步结果页数不足：第 ${item.sourcePageIndex + 1} 页缺少结果。`,
            )
            await savePageOcrResultsBatchedDeferred(chunkPageResults, 'paddle', { refreshSearch: false })
            savedAsyncChunksToDatabase = true
            chunkPageResults.forEach((pageResult) => {
              if (pageResult.status === 'completed') {
                savedAsyncPageIds.add(pageResult.pageId)
                savedAsyncFailedPageIds.delete(pageResult.pageId)
              } else if (pageResult.status === 'error') {
                savedAsyncFailedPageIds.add(pageResult.pageId)
              }
            })
            savedAsyncPageCount = Math.max(savedAsyncPageCount, savedAsyncPageIds.size)
            const totalPages = chunk.totalPages || getDocTotalPages() || pages.length || 1
            const completedPages = Math.min(totalPages, Math.max(lastAsyncDisplayedPageCount, savedAsyncPageCount))
            lastAsyncDisplayedPageCount = completedPages
            emitOcrStatus(event, {
              docId,
              status: 'processing',
              phase: 'saving',
              progress: getDocProgress(getCompleted(), totalDocs, Math.min(0.97, completedPages / Math.max(totalPages, 1))),
              completedPages,
              totalPages,
              message: `已保存 OCR 结果：${completedPages}/${totalPages} 页（第 ${chunk.chunkIndex}/${chunk.totalChunks} 片完成）`,
            })
          },
        })
      } catch (error) {
        if (isOcrAbortError(error)) throw error
        pages = queryAll<OcrPageRow>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
        pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
        completedBefore = resumeExisting ? getCompletedOcrPageCount(pages) : 0
        if (!isPdfChunkStructureError(error) || !canFallbackToImageOcr(pagesForOcr)) throw error
        emitOcrStatus(event, {
          docId,
          status: 'processing',
          phase: 'ocr',
          progress: getDocProgress(getCompleted(), totalDocs, getCombinedDocFraction(0, pagesForOcr.length)),
          completedPages: completedBefore,
          totalPages: getDocTotalPages(),
          message: `OCR 处理中：${completedBefore}/${getDocTotalPages()} 页`,
          errorMessage: (error as Error)?.message || String(error),
        })
        pageResults = await recognizePages(pagesForOcr, ocrOptions, (payload) => {
          throwIfOcrCanceled(signal)
          const combinedPages = getCombinedPageCount(payload.completedPages)
          const totalPages = getDocTotalPages() || payload.totalPages
          const docFraction = getCombinedDocFraction(payload.completedPages, payload.totalPages)
          if (payload.status === 'completed' && payload.result) {
            savePageOcrResultsDeferred([{
              pageId: payload.pageId,
              result: payload.result,
              text: payload.text || getOcrResultText(payload.result),
              status: 'completed',
            }], 'paddle', { refreshSearch: false })
          }
          emitOcrStatus(event, {
            docId,
            status: 'processing',
            phase: 'ocr',
            progress: getDocProgress(getCompleted(), totalDocs, docFraction),
            completedPages: combinedPages,
            totalPages,
            pageNum: payload.pageNum,
            errorMessage: payload.error,
            message: `OCR 处理中：${combinedPages}/${totalPages} 页`,
          })
        }, { signal, concurrency: processOptions.pageConcurrency })
      }

      if (asyncResults) {
        throwIfOcrCanceled(signal)
        if (savedAsyncChunksToDatabase) {
          const total = getDocTotalPages() || pages.length || savedAsyncPageIds.size + savedAsyncFailedPageIds.size
          streamedAsyncPageSummary = {
            total,
            completed: savedAsyncPageIds.size,
            failed: savedAsyncFailedPageIds.size,
            pending: Math.max(0, total - savedAsyncPageIds.size - savedAsyncFailedPageIds.size),
          }
          pageResultsPersistedInChunks = true
          pageResults = []
        } else {
          if (asyncResults.length === 0) {
            throw new Error(getZeroPageOcrError('paddle'))
          }
          pages = await ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, asyncResults.length))
          pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
          pageResults = await postProcessPdfOcrResultsBatched(
            pagesForOcr.map((page, index) => ({ page, sourcePageIndex: Number(page.page_num || index + 1) - 1, resultIndex: index })),
            asyncResults,
            ocrOptions,
            signal,
            () => `PaddleOCR 异步结果页数不足：预期 ${pages.length} 页，实际返回 ${asyncResults.length} 页。可能是接口未完整处理该 PDF，建议稍后重试或切换 PP-StructureV3。`,
          )
        }
      }
    } else {
      const missingImagePage = findMissingReadablePageImage(pagesForOcr)
      if (missingImagePage) {
        throw new Error(`第 ${missingImagePage.page_num || ''} 页缺少可读取页图，且当前文献没有可用 PDF 原文，无法继续 OCR。请确认该文献所在数据库包含 PDF/页图资源，或把原 PDF 加入“PDF 原件仓库”后重试。`)
      }
      pageResults = await recognizePages(pagesForOcr, ocrOptions, (payload) => {
        throwIfOcrCanceled(signal)
        const combinedPages = getCombinedPageCount(payload.completedPages)
        const totalPages = getDocTotalPages() || payload.totalPages
        const docFraction = getCombinedDocFraction(payload.completedPages, payload.totalPages)
        if (payload.status === 'completed' && payload.result) {
          savePageOcrResultsDeferred([{
            pageId: payload.pageId,
            result: payload.result,
            text: payload.text || getOcrResultText(payload.result),
            status: 'completed',
          }], 'paddle', { refreshSearch: false })
        }
        emitOcrStatus(event, {
          docId,
          status: 'processing',
          phase: 'ocr',
          progress: getDocProgress(getCompleted(), totalDocs, docFraction),
          completedPages: combinedPages,
          totalPages,
          pageNum: payload.pageNum,
          errorMessage: payload.error,
          message: `OCR 识别中：${combinedPages}/${totalPages} 页`,
        })
      }, { signal, concurrency: processOptions.pageConcurrency })
    }

    throwIfOcrCanceled(signal)
    if (!pageResultsPersistedInChunks && pageResults.length === 0) {
      throw new Error(getZeroPageOcrError(engine))
    }
    const dbPageSummary = pageResultsPersistedInChunks ? (streamedAsyncPageSummary || summarizeDocumentOcrPages(docId)) : null
    const completedResultPages = pageResultsPersistedInChunks
      ? Number(dbPageSummary?.completed || 0)
      : pageResults.filter((item) => item.status === 'completed').length
    const completedPagesForStatus = pageResultsPersistedInChunks
      ? completedResultPages
      : getCombinedPageCount(completedResultPages)
    const totalPagesForStatus = getDocTotalPages() || dbPageSummary?.total || pageResults.length
    emitOcrStatus(event, {
      docId,
      status: 'processing',
      phase: 'saving',
      progress: getDocProgress(getCompleted(), totalDocs, 0.97),
      completedPages: completedPagesForStatus,
      totalPages: totalPagesForStatus,
      message: '正在保存 OCR 结果',
    })

    const failedPages = pageResultsPersistedInChunks ? [] : pageResults.filter((item) => item.status === 'error')
    const hasPageFailure = pageResultsPersistedInChunks
      ? Number(dbPageSummary?.failed || 0) > 0 || Number(dbPageSummary?.pending || 0) > 0
      : failedPages.length > 0
    if (!pageResultsPersistedInChunks) {
      await savePageOcrResultsBatchedDeferred(pageResults, engine, { refreshSearch: false })
    }
    if (!pageResultsPersistedInChunks && (engine === 'vision_model' || engine === 'hybrid')) {
      mergeVisionTocIntoMetadata(doc, pageResults)
    }

    if (hasPageFailure) {
      throw new Error(
        pageResultsPersistedInChunks
          ? getDocumentOcrFailureMessage(docId)
          : failedPages.map((item) => item.error).filter(Boolean).slice(0, 3).join('；') || '部分页面 OCR 失败',
      )
    }

    const reprocessedPageIds = reprocessDocumentOcrStructure(docId)
    reprocessedPageIds.forEach((pageId) => deferredFinalizePageIds.add(pageId))
    if (reprocessedPageIds.length > 0) deferredDatabaseSaveNeeded = true

    updateDocumentStatus(docId, 'completed', 'processed', null)
    syncDocumentProofStatus(docId)
    autoCleanupPdfAssetsIfEnabled(docId)

    const autoAi = queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'auto_ai_after_ocr'")
    const hybridReadyForAutoAi = engine !== 'hybrid' || (!pageResultsPersistedInChunks && hasCompletedHybridVisionRefine(pageResults))
    const hybridRefineFallback = engine === 'hybrid' && !pageResultsPersistedInChunks && hasHybridVisionRefineFallback(pageResults)
    if (autoAi?.value !== 'false' && !hasPageFailure && hybridReadyForAutoAi) {
      aiExtractionStarted = true
      emitOcrStatus(event, {
        docId,
        status: 'completed',
        phase: 'ai',
        aiStatus: 'processing',
        progress: getDocProgress(getCompleted(), totalDocs, 1),
        completedPages: totalPagesForStatus,
        totalPages: totalPagesForStatus,
        message: 'OCR 完成，正在 AI 提取元数据',
      })
      void withTimeout(
        queuedAutoExtractAndApply(docId),
        AUTO_METADATA_QUEUE_TIMEOUT_MS,
        'AI 元数据提取超时，OCR 结果已保存，可稍后手动重新提取元数据。',
      )
        .then(() => {
          scheduleDatabaseSave()
          emitOcrStatus(event, {
            docId,
            status: 'completed',
            phase: 'ai',
            aiStatus: 'completed',
            progress: getDocProgress(getCompleted(), totalDocs, 1),
            completedPages: totalPagesForStatus,
            totalPages: totalPagesForStatus,
            message: 'AI 元数据提取完成',
          })
        })
        .catch((error) => {
          console.error(`[OCR] AI extraction failed for ${docId}:`, error)
          emitOcrStatus(event, {
            docId,
            status: 'completed',
            phase: 'ai',
            aiStatus: 'error',
            progress: getDocProgress(getCompleted(), totalDocs, 1),
            completedPages: totalPagesForStatus,
            totalPages: totalPagesForStatus,
            errorMessage: (error as Error)?.message || 'AI 元数据提取失败',
            message: 'AI 元数据提取失败',
          })
        })
    } else if (hybridRefineFallback) {
      emitOcrStatus(event, {
        docId,
        status: 'completed',
        phase: 'completed',
        progress: getDocProgress(getCompleted(), totalDocs, 1),
        completedPages: totalPagesForStatus,
        totalPages: totalPagesForStatus,
        errorMessage: '混合 OCR 第二轮视觉整理失败，已使用飞桨版面生成临时阅读结构；请稍后重试大模型整理。',
        message: '混合 OCR 第二轮失败，已保留临时结构',
      })
    }

    return { success: true }
    } catch (error) {
      if (isOcrAbortError(error)) {
        updateDocumentCanceledStatus(docId)
        const completed = emitOcrCanceledOrCompletedStatus(
          event,
          docId,
          getDocProgress(getCompleted(), totalDocs, getCombinedDocFraction(0)),
          getDocTotalPages(),
        )
        if (completed) return { success: true }
        return { success: false, errorMessage: OCR_CANCELED_MESSAGE }
      }
      lastErrorMessage = formatOcrError(error)
      const canRetry = attempt < maxAttempts && isRetryableOcrError(error)
      console.error(`[OCR] Document OCR failed: ${docId} (attempt ${attempt}/${maxAttempts})`, error)
      if (canRetry) {
        const retryMessage = `${lastErrorMessage}；将自动重试（${attempt}/${maxAttempts - 1}）`
        run('UPDATE documents SET error_message = ?, updated_at = ? WHERE id = ?', [
          retryMessage.slice(0, 1000),
          new Date().toISOString(),
          docId,
        ])
        scheduleDatabaseSave()
        await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 1000 * 2 ** (attempt - 1))))
        continue
      }

      const pageSummary = summarizeDocumentOcrPages(docId)
      if (pageSummary.completed > 0 || pageSummary.failed > 0) {
        updateDocumentStatusFromPages(docId, lastErrorMessage)
      } else {
        const nextStatus = lastErrorMessage.includes('API Token') ? 'pending' : 'error'
        updateDocumentStatus(docId, nextStatus, nextStatus === 'error' ? 'error' : 'stored', lastErrorMessage)
      }
      return { success: false, errorMessage: lastErrorMessage }
    }
  }

  updateDocumentStatus(docId, 'error', 'error', lastErrorMessage || '处理失败：已达到最大重试次数')
  return { success: false, errorMessage: lastErrorMessage || '处理失败：已达到最大重试次数' }
  } finally {
    if (deferredTocDirtyDocIds.size > 0) {
      deferredTocDirtyDocIds.forEach(markDocumentTocDirty)
      deferredTocDirtyDocIds.clear()
      deferredDatabaseSaveNeeded = true
    }
    if (deferredFinalizePageIds.size > 0) {
      scheduleOcrFinalizeForPages([...deferredFinalizePageIds])
      deferredFinalizePageIds.clear()
    }
    if (deferredDatabaseSaveNeeded) {
      scheduleDatabaseSave()
      deferredDatabaseSaveNeeded = false
    }
    if (signal?.aborted) {
      if (isDocumentOcrCompleteFromPages(docId)) {
        updateDocumentStatus(docId, 'completed', 'processed', null)
        emitOcrCanceledOrCompletedStatus(event, docId, 1)
        return { success: true }
      }
      return { success: false, errorMessage: OCR_CANCELED_MESSAGE }
    }
    const finalStatus = queryOne<{ ocr_status: string }>('SELECT ocr_status FROM documents WHERE id = ?', [docId])?.ocr_status || 'error'
    if (!(aiExtractionStarted && finalStatus === 'completed')) {
      emitOcrStatus(event, {
        docId,
        status: finalStatus,
        phase: finalStatus === 'error' ? 'error' : 'completed',
        progress: getDocProgress(getCompleted(), totalDocs, 1),
        errorMessage: queryOne<{ error_message: string | null }>('SELECT error_message FROM documents WHERE id = ?', [docId])?.error_message || undefined,
      })
    }
  }
}

export function registerOcrIpc(): void {
  ipcMain.handle('ocr:checkToken', async () => {
    const row = queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'paddleocr_api_key'")
    return !!row?.value
  })

  ipcMain.handle('ocr:checkVisionConfig', async () => hasVisionOcrConfig())

  ipcMain.handle('ocr:cancelDocument', async (event, docId: string) => {
    const safeDocId = String(docId || '').trim()
    if (!safeDocId) return false
    canceledOcrDocIds.add(safeDocId)
    const activeTask = activeOcrTasks.get(safeDocId)
    activeTask?.controller.abort()
    updateDocumentCanceledStatus(safeDocId)
    emitOcrCanceledOrCompletedStatus(event, safeDocId, 0)
    return Boolean(activeTask)
  })

  ipcMain.handle('ocr:recognize', async (_event, base64Image: string, mode: OcrRecognizeMode = 'accurate'): Promise<OcrRecognizeResult> => {
    try {
      return mode === 'traditional'
        ? await recognizeTraditional(base64Image)
        : await recognizeImage(base64Image)
    } catch (error) {
      console.error('OCR error:', error)
      throw new Error((error as Error).message)
    }
  })

  ipcMain.handle('documents:reprocessOcrStructure', async (_event, docId: string): Promise<number> => {
    const safeDocId = String(docId || '').trim()
    if (!safeDocId) return 0
    const changedPageIds = reprocessDocumentOcrStructure(safeDocId)
    if (changedPageIds.length > 0) {
      markDocumentTocDirty(safeDocId)
      markSearchIndexStaleForPages(changedPageIds)
      notifySearchContentChanged()
      scheduleDatabaseSave()
    }
    return changedPageIds.length
  })

  ipcMain.handle('documents:batchOcr', async (event, docIds: string[], options?: BatchOcrOptions) => {
    if (ocrRuntimeShuttingDown) return 0
    let successCount = 0
    let completedCount = 0
    const documentConcurrency = getOcrDocumentConcurrency(options?.concurrency)
    const docLimit = createLimiter(documentConcurrency)
    const heavyPdfLimit = createLimiter(1)
    const persistForRecovery = shouldPersistBatchOcrForRecovery(options)
    const forceFullRerunByDocId = new Map<string, boolean>()
    const heavyPdfDocIds = new Set<string>()
    const queuedDocIds: string[] = []
    for (const docId of [...new Set(docIds.map((item) => String(item || '').trim()).filter(Boolean))]) {
      const doc = queryOne<{ ocr_status: string }>('SELECT ocr_status FROM documents WHERE id = ?', [docId])
      if (!doc) continue
      if (activeOcrTasks.has(docId) || queuedOcrDocIds.has(docId)) {
        emitOcrAlreadyRunningStatus(event, docId)
        continue
      }
      const hasIncompletePages = hasIncompleteOcrPages(docId)
      const forceFullRerun = options?.forceFullRerun === true
      forceFullRerunByDocId.set(docId, forceFullRerun)
      canceledOcrDocIds.delete(docId)
      if (forceFullRerun || doc.ocr_status !== 'completed' || hasIncompletePages) {
        queuedOcrDocIds.add(docId)
        queuedDocIds.push(docId)
        if (isHeavyPdfOcrDocument(docId)) heavyPdfDocIds.add(docId)
      }
    }
    const recoverableQueueItemIdsByDocId = persistForRecovery
      ? createRecoverableBatchOcrItems(queuedDocIds, documentConcurrency)
      : new Map<string, string>()

    if (queuedDocIds.length > 0) {
      const placeholders = queuedDocIds.map(() => '?').join(', ')
      run(
        `UPDATE documents SET ocr_status = ?, import_status = ?, metadata_status = ?, error_message = ?, updated_at = ? WHERE id IN (${placeholders})`,
        ['queued', 'processing', 'pending', null, new Date().toISOString(), ...queuedDocIds],
      )
      scheduleDatabaseSave()

      for (const docId of queuedDocIds) {
        const doc = queryOne<{ page_count: number | null }>('SELECT page_count FROM documents WHERE id = ?', [docId])
        emitOcrStatus(event, {
          docId,
          status: 'queued',
          phase: 'queued',
          progress: 0,
          completedPages: 0,
          totalPages: Number(doc?.page_count || 0) || undefined,
          message: '已加入本批 OCR 队列，等待空闲识别通道',
        })
      }
    }

    await Promise.all(
      queuedDocIds.map((docId) => {
        const limit = heavyPdfDocIds.has(docId) ? heavyPdfLimit : docLimit
        return limit(async () => {
        if (ocrRuntimeShuttingDown) {
          queuedOcrDocIds.delete(docId)
          return
        }
        const controller = new AbortController()
        const preCanceled = canceledOcrDocIds.has(docId)
        if (activeOcrTasks.has(docId)) {
          queuedOcrDocIds.delete(docId)
          emitOcrAlreadyRunningStatus(event, docId)
          return
        }
        queuedOcrDocIds.delete(docId)
        updateRecoverableBatchOcrItem(recoverableQueueItemIdsByDocId, docId, 'processing')
        let resolveDone: () => void = () => undefined
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve
        })
        activeOcrTasks.set(docId, { controller, done })
        if (preCanceled) controller.abort()
        try {
          const doc = queryOne<{ page_count: number | null }>('SELECT page_count FROM documents WHERE id = ?', [docId])
          emitOcrStatus(event, {
            docId,
            status: 'processing',
            phase: 'ocr',
            progress: completedCount / Math.max(queuedDocIds.length, 1),
            completedPages: 0,
            totalPages: Number(doc?.page_count || 0) || undefined,
            message: 'OCR 识别中',
          })
          const result = await processDocumentOcr(
            event,
            docId,
            Math.max(queuedDocIds.length, 1),
            () => completedCount,
            options?.engine,
            forceFullRerunByDocId.get(docId) || false,
            { signal: controller.signal },
          )
          completedCount += 1
          if (result.success) successCount += 1
          if (result.success || result.errorMessage !== OCR_CANCELED_MESSAGE || !ocrRuntimeShuttingDown) {
            updateRecoverableBatchOcrItem(
              recoverableQueueItemIdsByDocId,
              docId,
              result.success ? 'completed' : 'failed',
              result.success ? undefined : result.errorMessage || OCR_CANCELED_MESSAGE,
            )
          }
          if (!result.success && result.errorMessage && result.errorMessage !== OCR_CANCELED_MESSAGE) {
            emitOcrStatus(event, {
              docId,
              status: queryOne<{ ocr_status: string }>('SELECT ocr_status FROM documents WHERE id = ?', [docId])?.ocr_status || 'error',
              progress: completedCount / Math.max(queuedDocIds.length, 1),
              errorMessage: result.errorMessage,
            })
          }
        } finally {
          if (activeOcrTasks.get(docId)?.controller === controller) {
            activeOcrTasks.delete(docId)
          }
          queuedOcrDocIds.delete(docId)
          canceledOcrDocIds.delete(docId)
          resolveDone()
        }
      })
      }),
    )

    return successCount
  })

  ipcMain.handle('pages:rerunOcr', async (event, pageId: string, options?: PageOcrOptions) => {
    const page = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
    if (!page?.image_path) {
      throw new Error('当前页面缺少图像，无法重新 OCR')
    }

    const doc = queryOne<OcrDocumentRow>('SELECT * FROM documents WHERE id = ?', [page.doc_id])
    if (!doc) {
      throw new Error('当前页面所属文献不存在')
    }

    run('UPDATE pages SET ocr_status = ?, proof_status = ?, proofed_text = ? WHERE id = ?', ['processing', 'pending', null, pageId])
    run('UPDATE documents SET ocr_status = ?, import_status = ?, proof_status = ?, updated_at = ? WHERE id = ?', [
      'processing',
      'processing',
      'pending',
      new Date().toISOString(),
      page.doc_id,
    ])
    scheduleDatabaseSave()
    emitOcrStatus(event, { docId: page.doc_id, status: 'processing', progress: 0 })

    try {
      const result = await recognizeSinglePage(withRequiredImage(page), doc, options)
      updatePageOcrState(pageId, result, 'paddle')

      updateDocumentStatusFromPages(page.doc_id)
      run('UPDATE documents SET metadata_status = ?, updated_at = ? WHERE id = ?', ['pending', new Date().toISOString(), page.doc_id])
      syncDocumentProofStatus(page.doc_id)
      scheduleOcrFinalizeForPages([pageId])
      scheduleDatabaseSave()
      const currentDocStatus = queryOne<{ ocr_status: string }>('SELECT ocr_status FROM documents WHERE id = ?', [page.doc_id])?.ocr_status || 'completed'
      emitOcrStatus(event, {
        docId: page.doc_id,
        status: currentDocStatus,
        progress: 1,
      })
      return true
    } catch (error) {
      run('UPDATE pages SET ocr_status = ? WHERE id = ?', ['error', pageId])
      updateDocumentStatusFromPages(page.doc_id, (error as Error)?.message || String(error || 'OCR 失败'))
      syncDocumentProofStatus(page.doc_id)
      scheduleDatabaseSave()
      emitOcrStatus(event, { docId: page.doc_id, status: 'error', progress: 1 })
      console.error('[OCR] Rerun current page failed:', error)
      throw error
    }
  })

  ipcMain.handle(
    'pages:rerecognizeLowQualityBlocks',
    async (_event, pageId: string, options?: OcrRegionRerecognitionOptions): Promise<OcrRegionRerecognitionResult> => {
      const storedPage = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
      const page = storedPage ? hydratePagePayloadRows([storedPage])[0] : null
      if (!page) throw new Error('当前页面不存在')
      return rerecognizeLowQualityPageRegions(page, options)
    },
  )

  ipcMain.handle('pages:rerunVisionOcr', async (event, pageId: string) => {
    const page = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
    if (!page?.image_path) {
      throw new Error('当前页缺少图像，无法重新进行视觉 OCR')
    }

    const doc = queryOne<OcrDocumentRow>('SELECT * FROM documents WHERE id = ?', [page.doc_id])
    if (!doc) {
      throw new Error('当前页面所属文献不存在')
    }
    if (!hasVisionOcrConfig()) {
      throw new Error('未配置视觉模型 OCR，请先到设置页填写端点、API Key 和视觉模型 ID。')
    }

    run('UPDATE pages SET ocr_status = ?, proof_status = ?, proofed_text = ? WHERE id = ?', ['processing', 'pending', null, pageId])
    run('UPDATE documents SET ocr_status = ?, import_status = ?, proof_status = ?, updated_at = ? WHERE id = ?', [
      'processing',
      'processing',
      'pending',
      new Date().toISOString(),
      page.doc_id,
    ])
    scheduleDatabaseSave()
    emitOcrStatus(event, { docId: page.doc_id, status: 'processing', progress: 0 })

    try {
      const [pageResult] = await recognizePagesWithVisionModel([page], doc.doc_type)
      if (!pageResult || pageResult.status === 'error') {
        throw new Error(pageResult?.error || '视觉 OCR 失败')
      }
      savePageOcrResults([pageResult], 'vision_model')
      mergeVisionTocIntoMetadata(doc, [pageResult])
      updateDocumentStatusFromPages(page.doc_id)
      run('UPDATE documents SET metadata_status = ?, updated_at = ? WHERE id = ?', ['pending', new Date().toISOString(), page.doc_id])
      updateDocumentOcrEngine(doc, 'vision_model')
      syncDocumentProofStatus(page.doc_id)
      scheduleDatabaseSave()
      const currentDocStatus = queryOne<{ ocr_status: string }>('SELECT ocr_status FROM documents WHERE id = ?', [page.doc_id])?.ocr_status || 'completed'
      emitOcrStatus(event, { docId: page.doc_id, status: currentDocStatus, progress: 1 })
      return true
    } catch (error) {
      run('UPDATE pages SET ocr_status = ? WHERE id = ?', ['error', pageId])
      updateDocumentStatusFromPages(page.doc_id, (error as Error)?.message || String(error || '视觉 OCR 失败'))
      syncDocumentProofStatus(page.doc_id)
      scheduleDatabaseSave()
      emitOcrStatus(event, { docId: page.doc_id, status: 'error', progress: 1 })
      console.error('[OCR] Rerun current page vision OCR failed:', error)
      throw error
    }
  })

  ipcMain.handle('pages:enhanceGuji', async (event, pageId: string, options?: PageOcrOptions) => {
    const page = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
    if (!page?.image_path) {
      throw new Error('当前页面缺少图像，无法增强古籍识别')
    }
    const doc = queryOne<OcrDocumentRow>('SELECT * FROM documents WHERE id = ?', [page.doc_id])
    if (!doc) {
      throw new Error('当前页面所属文献不存在')
    }

    const resolvedOptions = resolveDocOcrOptions(doc.doc_type, {
      profile: 'guji_print_vertical',
      secondPass: options?.secondPass || 'cloud_column_ocr',
    })

    run('UPDATE pages SET ocr_status = ?, proof_status = ?, proofed_text = ? WHERE id = ?', ['processing', 'pending', null, pageId])
    run('UPDATE documents SET ocr_status = ?, import_status = ?, proof_status = ?, updated_at = ? WHERE id = ?', [
      'processing',
      'processing',
      'pending',
      new Date().toISOString(),
      page.doc_id,
    ])
    scheduleDatabaseSave()
    emitOcrStatus(event, { docId: page.doc_id, status: 'processing', progress: 0 })

    try {
      let currentResult = page.ocr_result
      if (typeof currentResult === 'string') {
        currentResult = JSON.parse(currentResult)
      }

      const result = currentResult
        ? await postProcessRecognizedPageResult(currentResult, page.image_path, resolvedOptions)
        : await recognizeSinglePage(withRequiredImage(page), doc, resolvedOptions)
      updatePageOcrState(pageId, result, 'paddle')
      run('UPDATE documents SET ocr_status = ?, import_status = ?, metadata_status = ?, updated_at = ? WHERE id = ?', [
        'completed',
        'processed',
        'pending',
        new Date().toISOString(),
        page.doc_id,
      ])
      syncDocumentProofStatus(page.doc_id)
      scheduleOcrFinalizeForPages([pageId])
      scheduleDatabaseSave()
      emitOcrStatus(event, { docId: page.doc_id, status: 'completed', progress: 1 })
      return true
    } catch (error) {
      run('UPDATE pages SET ocr_status = ? WHERE id = ?', ['error', pageId])
      run('UPDATE documents SET ocr_status = ?, import_status = ?, updated_at = ? WHERE id = ?', [
        'error',
        'error',
        new Date().toISOString(),
        page.doc_id,
      ])
      syncDocumentProofStatus(page.doc_id)
      scheduleDatabaseSave()
      emitOcrStatus(event, { docId: page.doc_id, status: 'error', progress: 1 })
      console.error('[OCR] Enhance guji page failed:', error)
      throw error
    }
  })

  ipcMain.handle('pages:rerunLayout', async (event, pageId: string, options?: PageOcrOptions) => {
    const page = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
    if (!page?.image_path) {
      throw new Error('当前页面缺少图像，无法重做版面切分')
    }
    const doc = queryOne<OcrDocumentRow>('SELECT * FROM documents WHERE id = ?', [page.doc_id])
    if (!doc) {
      throw new Error('当前页面所属文献不存在')
    }

    run('UPDATE pages SET proof_status = ?, proofed_text = ? WHERE id = ?', ['pending', null, pageId])
    run('UPDATE documents SET proof_status = ?, updated_at = ? WHERE id = ?', ['pending', new Date().toISOString(), page.doc_id])
    scheduleDatabaseSave()
    emitOcrStatus(event, { docId: page.doc_id, status: doc.ocr_status || 'completed', progress: 0.5 })

    try {
      const result = await rerunPageLayoutOnly(page, doc, options)
      updatePageOcrState(pageId, result, 'paddle')
      run('UPDATE documents SET metadata_status = ?, updated_at = ? WHERE id = ?', ['pending', new Date().toISOString(), page.doc_id])
      syncDocumentProofStatus(page.doc_id)
      scheduleOcrFinalizeForPages([pageId])
      scheduleDatabaseSave()
      emitOcrStatus(event, { docId: page.doc_id, status: 'completed', progress: 1 })
      return true
    } catch (error) {
      console.error('[OCR] Rerun page layout failed:', error)
      throw error
    }
  })
}
