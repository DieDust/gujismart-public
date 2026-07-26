import { app, ipcMain, nativeImage } from 'electron'
import { existsSync, mkdirSync, statSync } from 'fs'
import { readdir, readFile, rm, writeFile } from 'fs/promises'
import { basename, delimiter, dirname, join, parse } from 'path'
import { nanoid } from 'nanoid'
import { autoExtractAndApply } from '../ai'
import { clearPageSearchIndexForDocuments, getDataDir, queryAll, queryOne, run, saveDatabase, scheduleDatabaseSave, transaction } from '../database'
import { autoCleanupPdfAssetsIfEnabled, restorePdfAssetForDocument } from '../pdf-assets'
import { analyzePdfTextLayer } from '../pdf-preflight'
import { allowFileAccessPath } from '../file-access'
import { markLibraryStateCacheDirty } from '../library-state-cache'
import { recomputeLiteraturePageMap } from '../literature-page-map'
import { getPdfJsNodeDocumentOptions } from '../pdfjs-assets'
import {
  findSuspiciousRepeatedOcrText,
  formatSuspiciousRepeatedOcrTextIssue,
  getOcrDocumentConcurrency,
  type OcrRepeatedTextIssue,
  type OcrPageRecord,
  type OcrPageProgressPayload,
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
  normalizePageResult,
  mapClockwiseOcrResultToSourcePage,
  shouldUseAsyncPdfOcr,
} from '../ocr'
import { emitBackgroundTaskStatus } from '../background-tasks'
import {
  markSearchIndexStaleForDocuments,
  markSearchIndexStaleForPages,
  notifySearchContentChanged,
  pauseBackgroundSearchReindex,
  resumeBackgroundSearchReindex,
} from '../semantic-search'
import { clearDocumentTocAutogenAttempt, saveDocumentToc } from '../toc-service'
import { hydratePagePayloadRows, preparePagePayloadUpdate } from '../page-payload-store'
import { hasVisionOcrConfig, recognizePagesWithVisionModel, refinePagesWithVisionModel } from '../vision-ocr'
import { readProtectedSetting } from '../settings-security'
import {
  completeLegacyBatchItem,
  createLegacyBatchTask,
  failLegacyBatchItem,
  releaseAllLegacyBatchClaims,
  startLegacyBatchItem,
} from '../task-batch-compat'
import {
  appendImportAutoOcrItems,
  createImportAutoOcrTask,
  getImportAutoOcrTask,
  listResumableImportAutoOcrTasks,
  recoverInterruptedImportAutoOcrTasks,
} from '../import-auto-ocr-task'
import {
  cancelTaskJob,
  claimTaskItems,
  completeTaskItem,
  failTaskItem,
  heartbeatTaskLease,
  releaseTaskItemLease,
} from '../task-scheduler'
import { applyCjkTextRenderFallback } from '../../shared/pdf-text-render-fallback'
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
import type { BatchOcrOptions, Document, DocumentPage, ImportAutoOcrTaskCreateOptions, ImportAutoOcrTaskItemInput, ImportAutoOcrTaskStartResult, OcrEngine, OcrProgressEvent, OcrRecognizeMode, OcrRecognizeResult, OcrRegionRerecognitionOptions, OcrRegionRerecognitionResult, PdfTextLayerAnalysis, PdfTextLayerPageAnalysis, TocItemV2 } from '../../shared/types'
import { DEFAULT_LIBRARY_PROJECT_ID } from '../../shared/types'
import { ocrRunMetadataFromProgress } from '../../shared/ocr-run-metadata'
import { statusEnvelopeFromOcrProgress } from '../../shared/status-envelope'
import { recordCompatibilityOcrArtifacts } from '../ocr-artifacts'
import { globalOcrDocumentWindow } from '../ocr-document-window'
import {
  getActiveLibraryProjectId,
  requireLibraryProjectId,
  withLibraryProjectContext,
} from '../library-projects'

const AUTO_METADATA_TIMEOUT_MS = 120_000
const AUTO_METADATA_QUEUE_TIMEOUT_MS = 30 * 60_000
const AUTO_METADATA_START_DELAY_MS = 5_000
const OCR_PAGE_INSERT_CHUNK_SIZE = 50
// Small SQL transactions so the main process can still handle UI IPC while OCR is saving.
const OCR_RESULT_SAVE_CHUNK_SIZE = 3
const OCR_RESULT_POSTPROCESS_CHUNK_SIZE = 16
const OCR_DOCUMENT_REPROCESS_CHUNK_SIZE = 8
const OCR_ASYNC_PDF_GUJI_PAGE_RANGE_CHUNK_SIZE = 25
const OCR_ASYNC_PDF_GUJI_LARGE_PAGE_RANGE_CHUNK_SIZE = 80
const OCR_ASYNC_PDF_GUJI_LARGE_PAGE_THRESHOLD = 180
const OCR_ORIGINAL_PDF_RETRY_PAGE_RANGE_CHUNK_SIZE = 10
const OCR_AUTO_FAILED_PAGE_RETRY_LIMIT = 24
const OCR_FINALIZE_PAGE_CHUNK_SIZE = 250
const OCR_FINALIZE_PAGE_LOOKUP_CHUNK_SIZE = 500
const OCR_STATUS_EVENT_THROTTLE_MS = 250
const OCR_SLOW_STEP_MS = 800
const OCR_CANCELED_MESSAGE = 'OCR 已取消'
/** One book hung too long — free the slot and continue the rest of the batch. */
const OCR_DOCUMENT_TIMEOUT_MESSAGE = '单本 OCR 超时，已跳过并继续其他文献（可稍后单独重试）'
const DEFAULT_OCR_DOCUMENT_TIMEOUT_MINUTES = 45
const MAX_OCR_DOCUMENT_TIMEOUT_MINUTES = 720
const HEAVY_PDF_DOC_SIZE_BYTES = 200 * 1024 * 1024
const HEAVY_PDF_DOC_PAGE_COUNT = 1000
const RECOVERABLE_BATCH_OCR_PREFIX = 'recoverable_ocr'
// Long leases + frequent heartbeats keep multi-hour bulk OCR from being re-queued mid-book.
const IMPORT_AUTO_OCR_LEASE_MS = 30 * 60 * 1000
const IMPORT_AUTO_OCR_HEARTBEAT_MS = 20 * 1000
const OCR_LAYOUT_QUALITY_REJECTED_PREFIX = '[layout_quality_rejected]'
const OCR_ASYNC_RESULT_FILE_NOT_READY_PREFIX = '[async_result_file_not_ready]'
const OCR_ASYNC_JOB_STALLED_PREFIX = '[async_job_stalled]'
const OCR_ASYNC_PDF_QUALITY_RETRYABLE_PREFIX = '[async_pdf_quality_retryable]'
const OCR_ORIGINAL_PDF_RETRY_ATTEMPTS = 3
const OCR_FEIJIANG_REFERENCE_ENV = 'GUJISMART_OCR_REFERENCE_JSON_DIR'

type JsonRecord = Record<string, unknown>
type OcrDocumentRow = Document
type OcrPageRow = DocumentPage
type OcrPageWithImage = OcrPageRow & { image_path: string }
type OcrPageResultPayload = NonNullable<OcrPageResult['result']>
type OcrVersionPageRow = Pick<DocumentPage, 'id' | 'doc_id' | 'page_num'>
type QualityFailureOcrSaveResult = 'not_quality_failure' | 'saved_error' | 'recovered'
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
interface FeijiangOcrReference {
  path: string
  pages: unknown[]
}
type OcrResultRecord = OcrRecognizeResult & JsonRecord
type PdfJsDocument = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfJsPage>
  destroy?: () => Promise<void> | void
}
type PdfJsPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  getTextContent?: (options?: Record<string, unknown>) => Promise<{ items?: unknown[] }>
  render: (options: Record<string, unknown>) => { promise: Promise<void> }
  cleanup?: () => void
}
type PdfJsModule = {
  getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfJsDocument> }
  AnnotationMode?: { DISABLE?: number }
}
type CanvasLike = {
  getContext: (context: '2d') => CanvasContextLike
  toBuffer: (mime: 'image/jpeg', quality?: number) => Buffer
}
type CanvasImageLike = { width: number; height: number }
type CanvasContextLike = Record<string, unknown> & {
  translate: (x: number, y: number) => void
  rotate: (angle: number) => void
  drawImage: (image: CanvasImageLike, x: number, y: number) => void
  getImageData?: (sx: number, sy: number, sw: number, sh: number) => { data: Uint8ClampedArray | Uint8Array }
  fillText?: (text: string, x: number, y: number, maxWidth?: number) => void
  save?: () => void
  restore?: () => void
}
type CanvasModule = {
  createCanvas: (width: number, height: number) => CanvasLike
  loadImage: (source: string | Buffer) => Promise<CanvasImageLike>
}

const feijiangOcrReferenceCache = new Map<string, Promise<FeijiangOcrReference | null>>()

interface ActiveOcrTask {
  controller: AbortController
  done: Promise<void>
  /** Resolves `done` so waiters / cancel-all can unblock even if OCR I/O is hung. */
  finish: () => void
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
interface SavePageQualityFailureOptions {
  pageOptions?: PageOcrOptions
  ocrOptions?: Required<PageOcrOptions>
  signal?: AbortSignal
}

interface AsyncPdfOcrRouteRisk {
  reason: string
  ocrOptions: Required<PageOcrOptions>
  requireFullFileUpload?: boolean
  pageRangeChunkSize?: number
  preferPageImage?: boolean
}

interface RiskyPageImageOcrRouteOptions {
  docType?: string | null
  signal?: AbortSignal
  onProgress?: (payload: OcrPageProgressPayload) => void
}

interface PageImageCropSpec {
  id: string
  x: number
  y: number
  width: number
  height: number
  readingOrder: number
}

type OcrStatusEvent = Pick<Electron.IpcMainInvokeEvent, 'sender'>

const activeOcrTasks = new Map<string, ActiveOcrTask>()
const activeImportAutoOcrRuns = new Map<string, Promise<void>>()
const queuedOcrDocIds = new Set<string>()
const canceledOcrDocIds = new Set<string>()
/** Docs aborted by per-document wall-clock timeout; blocks late writers from re-marking processing. */
const timedOutOcrDocIds = new Set<string>()
const pendingOcrFinalizePageIds = new Set<string>()
const displayedOcrProgressByDoc = new Map<string, { completedPages: number; progress: number; totalPages?: number }>()
const pendingOcrStatusEventsByDoc = new Map<string, {
  sender: Electron.WebContents
  payload: OcrProgressEvent
  timer: ReturnType<typeof setTimeout> | null
}>()
const lastOcrStatusSentAtByDoc = new Map<string, number>()
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

function createActiveOcrTask(controller: AbortController): ActiveOcrTask {
  let settled = false
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const finish = () => {
    if (settled) return
    settled = true
    resolveDone()
  }
  return { controller, done, finish }
}

/**
 * Abort + drop in-memory slot so cancel/restart cannot be blocked by a hung OCR
 * request that never reaches its `finally` cleanup.
 */
function forceReleaseActiveOcrTask(docId: string): void {
  const safeDocId = String(docId || '').trim()
  if (!safeDocId) return
  const task = activeOcrTasks.get(safeDocId)
  if (!task) {
    queuedOcrDocIds.delete(safeDocId)
    return
  }
  try {
    task.controller.abort()
  } catch {
    // ignore
  }
  try {
    task.finish()
  } catch {
    // ignore
  }
  if (activeOcrTasks.get(safeDocId) === task) {
    activeOcrTasks.delete(safeDocId)
  }
  queuedOcrDocIds.delete(safeDocId)
}

function forceReleaseAllActiveOcrTasks(): string[] {
  const docIds = [...activeOcrTasks.keys()]
  for (const docId of docIds) {
    forceReleaseActiveOcrTask(docId)
  }
  queuedOcrDocIds.clear()
  return docIds
}

function isDocumentOcrCanceled(docId: string, signal?: AbortSignal): boolean {
  const id = String(docId || '').trim()
  return Boolean(
    ocrRuntimeShuttingDown
    || signal?.aborted
    || canceledOcrDocIds.has(id)
    || timedOutOcrDocIds.has(id),
  )
}

/**
 * Max wall-clock time for OCR of one document. 0 = unlimited.
 * Large page counts get modest extra headroom (capped at 12h).
 */
function getDocumentOcrWallTimeoutMs(pageCount = 0): number {
  const row = queryOne<{ value: string | null }>(
    "SELECT value FROM settings WHERE key = 'ocr_document_timeout_minutes'",
  )
  const raw = String(row?.value ?? '').trim()
  if (raw === '0') return 0
  const parsed = Number(raw)
  const minutes = Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_OCR_DOCUMENT_TIMEOUT_MINUTES, Math.max(5, Math.floor(parsed)))
    : DEFAULT_OCR_DOCUMENT_TIMEOUT_MINUTES
  let ms = minutes * 60_000
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0))
  // Extra 5 minutes per 100 pages beyond 300, still capped at 12h.
  if (pages > 300) {
    ms = Math.min(
      MAX_OCR_DOCUMENT_TIMEOUT_MINUTES * 60_000,
      ms + Math.floor((pages - 300) / 100) * 5 * 60_000,
    )
  }
  return ms
}

function markDocumentOcrTimedOut(event: OcrStatusEvent, docId: string, pageCount?: number): void {
  const safeDocId = String(docId || '').trim()
  if (!safeDocId) return
  timedOutOcrDocIds.add(safeDocId)
  const timeoutMs = getDocumentOcrWallTimeoutMs(pageCount)
  const minutes = timeoutMs > 0 ? Math.round(timeoutMs / 60_000) : DEFAULT_OCR_DOCUMENT_TIMEOUT_MINUTES
  const message = `${OCR_DOCUMENT_TIMEOUT_MESSAGE}（已等待约 ${minutes} 分钟）`
  run(
    `UPDATE documents
     SET ocr_status = 'error',
         import_status = CASE WHEN COALESCE(import_status, '') = 'processing' THEN 'stored' ELSE import_status END,
         error_message = ?,
         updated_at = ?
     WHERE id = ?`,
    [message.slice(0, 1000), new Date().toISOString(), safeDocId],
  )
  run(
    "UPDATE pages SET ocr_status = 'pending' WHERE doc_id = ? AND ocr_status IN ('queued', 'processing')",
    [safeDocId],
  )
  scheduleDatabaseSave()
  emitOcrStatus(event, {
    docId: safeDocId,
    status: 'error',
    phase: 'error',
    progress: 0,
    totalPages: pageCount && pageCount > 0 ? pageCount : undefined,
    message,
    errorMessage: message,
  })
}

/**
 * Run one document OCR with a wall-clock cap so a hung book cannot block the batch forever.
 * On timeout: abort signal, force-release the in-memory slot, mark error, return timed-out result.
 */
async function runDocumentOcrWithWallTimeout(
  event: OcrStatusEvent,
  docId: string,
  totalDocs: number,
  getCompleted: () => number,
  engine: OcrEngine | undefined,
  forceFullRerun: boolean,
  controller: AbortController,
  pageCount = 0,
): Promise<{ success: boolean; errorMessage?: string; timedOut?: boolean }> {
  const timeoutMs = getDocumentOcrWallTimeoutMs(pageCount)
  timedOutOcrDocIds.delete(docId)

  if (timeoutMs <= 0) {
    return processDocumentOcr(event, docId, totalDocs, getCompleted, engine, forceFullRerun, {
      signal: controller.signal,
    })
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let forceReleaseTimer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  const timeoutPromise = new Promise<{ success: boolean; errorMessage?: string; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      try {
        controller.abort()
      } catch {
        // ignore
      }
      // Give abort a moment to unwind; then hard-free the slot so other books continue.
      forceReleaseTimer = setTimeout(() => {
        forceReleaseActiveOcrTask(docId)
      }, 1500)
      markDocumentOcrTimedOut(event, docId, pageCount)
      resolve({
        success: false,
        errorMessage: OCR_DOCUMENT_TIMEOUT_MESSAGE,
        timedOut: true,
      })
    }, timeoutMs)
  })

  try {
    const work = processDocumentOcr(event, docId, totalDocs, getCompleted, engine, forceFullRerun, {
      signal: controller.signal,
    })
    const result = await Promise.race([
      work.then((value) => ({ ...value, timedOut: false as const })),
      timeoutPromise,
    ])
    if (timedOut || result.timedOut || timedOutOcrDocIds.has(docId)) {
      return {
        success: false,
        errorMessage: OCR_DOCUMENT_TIMEOUT_MESSAGE,
        timedOut: true,
      }
    }
    return {
      success: result.success,
      errorMessage: result.errorMessage,
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (forceReleaseTimer) clearTimeout(forceReleaseTimer)
  }
}

/**
 * Always persist batch OCR rows so a large upload/queue survives app restart.
 * Previously only plain Paddle (non force-rerun) was persisted, so vision/hybrid
 * and many bulk runs looked “cut off” after relaunch.
 */
function shouldPersistBatchOcrForRecovery(_options?: BatchOcrOptions): boolean {
  return true
}

function createRecoverableBatchOcrItems(docIds: string[], batchSize: number): Map<string, string> {
  const uniqueDocIds = [...new Set((docIds || []).map((docId) => String(docId || '').trim()).filter(Boolean))]
  if (uniqueDocIds.length === 0) return new Map<string, string>()
  const persisted = createLegacyBatchTask(uniqueDocIds, batchSize, {
    batchId: `${RECOVERABLE_BATCH_OCR_PREFIX}_${Date.now()}_${nanoid(6)}`,
  })
  return new Map(persisted.items.map((item) => [item.docId, item.legacyItemId]))
}

function updateRecoverableBatchOcrItem(
  itemIdsByDocId: Map<string, string>,
  docId: string,
  status: 'processing' | 'completed' | 'failed',
  errorMessage?: string,
): void {
  const itemId = itemIdsByDocId.get(docId)
  if (!itemId) return

  if (status === 'processing') {
    startLegacyBatchItem(itemId, `documents-batch-ocr:${docId}`)
  } else if (status === 'completed') {
    completeLegacyBatchItem(itemId, { message: errorMessage })
  } else {
    failLegacyBatchItem(itemId, { errorMessage: errorMessage || 'OCR 处理失败', recoverable: true })
  }
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
  const activeDoneTasks = [
    ...[...activeOcrTasks.values()].map((task) => task.done),
    ...activeImportAutoOcrRuns.values(),
  ]
  clearAllPendingOcrStatuses()
  activeDocIds.forEach((docId) => canceledOcrDocIds.add(docId))
  forceReleaseAllActiveOcrTasks()

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

  if (docIds.length > 0 || finalizePageIds.length > 0) {
    saveDatabase()
  }
  await waitForOcrShutdown(activeDoneTasks, timeoutMs)
  releaseAllLegacyBatchClaims()
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

function clearDocumentOcrRoutePreference(docId: string): void {
  const currentMetadata = queryOne<Pick<OcrDocumentRow, 'metadata'>>(
    'SELECT metadata FROM documents WHERE id = ?',
    [docId],
  )?.metadata
  const metadata = parseMetadata(currentMetadata)
  if (
    !metadata.ocr_route_preference
    && !metadata.ocr_route_reason
    && !metadata.ocr_route_updated_at
    && !metadata.ocr_last_quality_issue
    && !metadata.ocr_last_quality_issue_updated_at
  ) return
  delete metadata.ocr_route_preference
  delete metadata.ocr_route_reason
  delete metadata.ocr_route_updated_at
  delete metadata.ocr_last_quality_issue
  delete metadata.ocr_last_quality_issue_updated_at
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(metadata),
    new Date().toISOString(),
    docId,
  ])
  markLibraryStateCacheDirty()
  scheduleDatabaseSave()
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
  sender.send('ocr:statusChanged', {
    ...payload,
    statusEnvelope: statusEnvelopeFromOcrProgress(payload),
    runMetadata: ocrRunMetadataFromProgress(payload),
  } satisfies OcrProgressEvent)
}

function flushPendingOcrStatus(docId: string): void {
  const pending = pendingOcrStatusEventsByDoc.get(docId)
  if (!pending) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingOcrStatusEventsByDoc.delete(docId)
  lastOcrStatusSentAtByDoc.set(docId, Date.now())
  sendOcrStatus(pending.sender, pending.payload)
}

function clearOcrStatusRuntimeForDoc(docId: string): void {
  flushPendingOcrStatus(docId)
  lastOcrStatusSentAtByDoc.delete(docId)
  displayedOcrProgressByDoc.delete(docId)
}

function clearAllPendingOcrStatuses(): void {
  ;[...pendingOcrStatusEventsByDoc.keys()].forEach(clearOcrStatusRuntimeForDoc)
  lastOcrStatusSentAtByDoc.clear()
}

function emitOcrStatus(event: OcrStatusEvent, payload: OcrProgressEvent): void {
  const next = getMonotonicOcrStatusPayload(payload)
  const docId = String(next.docId || '').trim()
  if (!docId || isTerminalOcrProgressPayload(next)) {
    if (docId) flushPendingOcrStatus(docId)
    sendOcrStatus(event.sender, next)
    if (docId) {
      lastOcrStatusSentAtByDoc.delete(docId)
      displayedOcrProgressByDoc.delete(docId)
    }
    return
  }

  if (!isActiveOcrProgressPayload(next)) {
    sendOcrStatus(event.sender, next)
    return
  }

  const now = Date.now()
  const pending = pendingOcrStatusEventsByDoc.get(docId)
  const lastSentAt = lastOcrStatusSentAtByDoc.get(docId) || 0
  if (now - lastSentAt >= OCR_STATUS_EVENT_THROTTLE_MS) {
    if (pending?.timer) clearTimeout(pending.timer)
    pendingOcrStatusEventsByDoc.delete(docId)
    lastOcrStatusSentAtByDoc.set(docId, now)
    sendOcrStatus(event.sender, next)
    return
  }

  const nextPending = pending || {
    sender: event.sender,
    payload: next,
    timer: null,
  }
  nextPending.sender = event.sender
  nextPending.payload = next
  pendingOcrStatusEventsByDoc.set(docId, nextPending)
  if (nextPending.timer) return
  nextPending.timer = setTimeout(() => {
    const latest = pendingOcrStatusEventsByDoc.get(docId)
    if (!latest) return
    pendingOcrStatusEventsByDoc.delete(docId)
    lastOcrStatusSentAtByDoc.set(docId, Date.now())
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
  if (message.includes(OCR_LAYOUT_QUALITY_REJECTED_PREFIX)) {
    return message.replace(OCR_LAYOUT_QUALITY_REJECTED_PREFIX, '').trim()
  }
  if (message.includes(OCR_ASYNC_RESULT_FILE_NOT_READY_PREFIX)) {
    return message.replace(OCR_ASYNC_RESULT_FILE_NOT_READY_PREFIX, '').trim()
  }
  if (message.includes(OCR_ASYNC_JOB_STALLED_PREFIX)) {
    return message.replace(OCR_ASYNC_JOB_STALLED_PREFIX, '').trim()
  }
  if (message.includes(OCR_ASYNC_PDF_QUALITY_RETRYABLE_PREFIX)) {
    return message.replace(OCR_ASYNC_PDF_QUALITY_RETRYABLE_PREFIX, '').trim()
  }
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
  const rawMessage = (error as Error)?.message || String(error || '')
  if (rawMessage.includes(OCR_LAYOUT_QUALITY_REJECTED_PREFIX)) return false
  if (rawMessage.includes(OCR_ASYNC_RESULT_FILE_NOT_READY_PREFIX)) return false
  if (rawMessage.includes(OCR_ASYNC_JOB_STALLED_PREFIX)) return false
  const message = formatOcrError(error)
  if (message.includes('vision') || message.includes('Vision') || message.includes('视觉模型')) return false
  if (message.includes('API Token') || message.includes('Token 无效') || message.includes('没有权限')) return false
  if (message.includes('单页超过')) return false
  if (isOcrQualityFailureMessage(message) || message.includes('缺少可读取页图')) return false
  if (isPdfChunkStructureError(error)) return false
  return true
}

function isAsyncPdfRecoverableStallError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '')
  return message.includes(OCR_ASYNC_JOB_STALLED_PREFIX)
}

function throwIfOcrCanceled(signal?: AbortSignal, docId?: string): void {
  if (signal?.aborted || (docId ? isDocumentOcrCanceled(docId, signal) : false)) {
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

async function loadPdfJs(): Promise<PdfJsModule> {
  return await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfJsModule
}

async function loadCanvas(): Promise<CanvasModule> {
  return await import('@napi-rs/canvas') as unknown as CanvasModule
}

async function loadPdfForRendering(pdfPath: string): Promise<{ pdfjs: PdfJsModule; canvasModule: CanvasModule; pdf: PdfJsDocument }> {
  const [pdfjs, canvasModule] = await Promise.all([loadPdfJs(), loadCanvas()])
  const sourceBytes = await readFile(pdfPath)
  const loadingTask = pdfjs.getDocument(getPdfJsNodeDocumentOptions({
    data: new Uint8Array(sourceBytes),
    disableWorker: true,
  }))
  const pdf = await loadingTask.promise
  return { pdfjs, canvasModule, pdf }
}

async function renderLoadedPdfPageToImageBuffer(
  pdfjs: PdfJsModule,
  canvasModule: CanvasModule,
  pdf: PdfJsDocument,
  pageNum: number,
  scale = 2,
  quality = 82,
): Promise<Buffer> {
  const safePageNum = Math.max(1, Math.min(pdf.numPages, Math.round(Number(pageNum || 1))))
  const page = await pdf.getPage(safePageNum)
  try {
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.ceil(viewport.width))
    const height = Math.max(1, Math.ceil(viewport.height))
    const canvas = canvasModule.createCanvas(width, height)
    const canvasContext = canvas.getContext('2d')
    await page.render({
      canvasContext,
      viewport,
      annotationMode: pdfjs.AnnotationMode?.DISABLE ?? 0,
      background: 'rgb(255,255,255)',
    }).promise
    await applyCjkTextRenderFallback(page, viewport, canvasContext, width, height).catch((error) => {
      console.warn('[OCR] PDF CJK text render fallback failed', error)
    })
    return canvas.toBuffer('image/jpeg', quality)
  } finally {
    page.cleanup?.()
  }
}

async function renderPdfPageToImageBuffer(pdfPath: string, pageNum: number, scale = 2, quality = 82): Promise<Buffer> {
  const { pdfjs, canvasModule, pdf } = await loadPdfForRendering(pdfPath)

  try {
    return await renderLoadedPdfPageToImageBuffer(pdfjs, canvasModule, pdf, pageNum, scale, quality)
  } finally {
    await pdf.destroy?.()
  }
}

async function ensurePageImageForOcrFallback(
  page: OcrPageRow,
  pdfPath?: string | null,
  signal?: AbortSignal,
): Promise<OcrPageWithImage | null> {
  throwIfOcrCanceled(signal)
  if (hasReadablePageImage(page)) return withRequiredImage(page)
  const safePdfPath = String(pdfPath || '').trim()
  const safePageNum = Math.round(Number(page.page_num || 0))
  if (!safePdfPath || !existsSync(safePdfPath) || safePageNum <= 0) return null

  const storageDir = join(getDataDir(), 'storage', page.doc_id)
  if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true })
  const destPath = join(storageDir, `page_${safePageNum}.jpg`)
  const imageBuffer = await renderPdfPageToImageBuffer(safePdfPath, safePageNum)
  throwIfOcrCanceled(signal)
  if (imageBuffer.length <= 0) return null
  await writeFile(destPath, imageBuffer)
  const writtenStat = statSync(destPath)
  if (!writtenStat.isFile() || writtenStat.size <= 0) return null
  allowFileAccessPath(destPath)
  run('UPDATE pages SET image_path = ? WHERE id = ?', [destPath, page.id])
  if (safePageNum === 1) {
    run('UPDATE documents SET thumb_path = ?, updated_at = ? WHERE id = ?', [destPath, new Date().toISOString(), page.doc_id])
  }
  markLibraryStateCacheDirty()
  return { ...page, image_path: destPath }
}

async function ensurePageImagesForOcrRoute(
  pages: OcrPageRow[],
  pdfPath?: string | null,
  signal?: AbortSignal,
): Promise<OcrPageWithImage[]> {
  throwIfOcrCanceled(signal)
  if (pages.length === 0) return []
  const missingImagePage = findMissingReadablePageImage(pages)
  if (!missingImagePage) return pages.map(withRequiredImage)

  const safePdfPath = String(pdfPath || '').trim()
  if (!safePdfPath || !existsSync(safePdfPath)) {
    throw new Error(`第 ${missingImagePage.page_num || ''} 页缺少可读取页图，且当前文献没有可用 PDF 原文，无法继续 OCR。`)
  }

  const storageDir = join(getDataDir(), 'storage', pages[0].doc_id)
  if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true })
  const renderedPages: OcrPageWithImage[] = []
  const { pdfjs, canvasModule, pdf } = await loadPdfForRendering(safePdfPath)
  let wroteImage = false

  try {
    for (let index = 0; index < pages.length; index += 1) {
      throwIfOcrCanceled(signal)
      const page = pages[index]
      if (hasReadablePageImage(page)) {
        renderedPages.push(withRequiredImage(page))
        continue
      }
      const pageNum = Math.round(Number(page.page_num || 0))
      if (pageNum <= 0) {
        throw new Error('页码异常，无法从 PDF 渲染页图。')
      }
      const destPath = join(storageDir, `page_${pageNum}.jpg`)
      const imageBuffer = await renderLoadedPdfPageToImageBuffer(pdfjs, canvasModule, pdf, pageNum)
      throwIfOcrCanceled(signal)
      if (imageBuffer.length <= 0) {
        throw new Error(`第 ${pageNum} 页 PDF 渲染为空，无法继续 OCR。`)
      }
      await writeFile(destPath, imageBuffer)
      const writtenStat = statSync(destPath)
      if (!writtenStat.isFile() || writtenStat.size <= 0) {
        throw new Error(`第 ${pageNum} 页页图写入失败，无法继续 OCR。`)
      }
      allowFileAccessPath(destPath)
      run('UPDATE pages SET image_path = ? WHERE id = ?', [destPath, page.id])
      if (pageNum === 1) {
        run('UPDATE documents SET thumb_path = ?, updated_at = ? WHERE id = ?', [destPath, new Date().toISOString(), page.doc_id])
      }
      wroteImage = true
      renderedPages.push({ ...page, image_path: destPath })
      if ((index + 1) % 8 === 0) await yieldToEventLoop()
    }
  } finally {
    await pdf.destroy?.()
  }

  if (wroteImage) {
    markLibraryStateCacheDirty()
    scheduleDatabaseSave()
  }
  return renderedPages
}

function addRepeatCandidate(candidates: Array<{ source: string; text: string }>, source: string, value: unknown): void {
  const text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).trim()
    : ''
  if (text) candidates.push({ source, text })
}

function getRunawayRepeatCandidates(value: unknown): Array<{ source: string; text: string }> {
  const candidates: Array<{ source: string; text: string }> = []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    addRepeatCandidate(candidates, 'text', value)
    return candidates
  }
  if (!isJsonRecord(value)) return candidates

  addRepeatCandidate(candidates, 'text', value.text)
  const wordsResult = Array.isArray(value.words_result) ? value.words_result : []
  addRepeatCandidate(
    candidates,
    'words_result',
    wordsResult.map((item) => isJsonRecord(item) ? String(item.words || '') : '').filter(Boolean).join('\n'),
  )
  const layoutResult = Array.isArray(value.layout_result) ? value.layout_result : []
  addRepeatCandidate(
    candidates,
    'layout_result.words',
    layoutResult.map((item) => isJsonRecord(item) ? String(item.words || '') : '').filter(Boolean).join('\n'),
  )
  return candidates
}

function compactRunawayRepeatText(value: string): string {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '')
    .slice(0, 60_000)
}

function findRunawayRepeatInCandidate(candidate: { source: string; text: string }): OcrRepeatedTextIssue | null {
  const compact = compactRunawayRepeatText(candidate.text)
  if (compact.length < 360) return null
  let bestIssue: OcrRepeatedTextIssue | null = null

  for (let unitLength = 8; unitLength <= 64; unitLength += 1) {
    let index = 0
    while (index + unitLength * 3 <= compact.length) {
      const unit = compact.slice(index, index + unitLength)
      let cursor = index + unitLength
      let repeatCount = 1
      while (cursor + unitLength <= compact.length && compact.slice(cursor, cursor + unitLength) === unit) {
        repeatCount += 1
        cursor += unitLength
      }
      const repeatChars = repeatCount * unitLength
      const ratio = repeatChars / Math.max(1, compact.length)
      if (
        repeatCount >= 8
        && repeatChars >= 320
        && (
          ratio >= 0.62
          || (repeatCount >= 16 && ratio >= 0.45)
        )
        && (!bestIssue || repeatChars > bestIssue.repeatChars)
      ) {
        bestIssue = {
          source: candidate.source,
          unit,
          repeatCount,
          repeatChars,
          compactLength: compact.length,
          ratio,
          sample: compact.slice(index, Math.min(compact.length, index + 120)),
        }
      }
      index = repeatCount >= 3 ? Math.max(cursor, index + 1) : index + 1
    }
  }

  return bestIssue
}

function findLikelyRunawayRepeatedOcrText(value: unknown): OcrRepeatedTextIssue | null {
  const strictIssue = findSuspiciousRepeatedOcrText(value)
  if (strictIssue) return strictIssue
  let bestIssue: OcrRepeatedTextIssue | null = null
  for (const candidate of getRunawayRepeatCandidates(value)) {
    const issue = findRunawayRepeatInCandidate(candidate)
    if (!issue) continue
    if (!bestIssue || issue.repeatChars > bestIssue.repeatChars) {
      bestIssue = issue
    }
  }
  return bestIssue
}

function getRecordFirstValue(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function getTextFromUnknown(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim()
  }
  return ''
}

function getRawTextFromUnknown(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return ''
}

function getMarkdownTextFromUnknown(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim()
  }
  if (!isJsonRecord(value)) return ''
  return getTextFromUnknown(getRecordFirstValue(value, ['text', 'markdown', 'md', 'content']))
}

function getRawMarkdownTextFromUnknown(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (!isJsonRecord(value)) return ''
  return getRawTextFromUnknown(getRecordFirstValue(value, ['text', 'markdown', 'md', 'content']))
}

function isUnsafeGujiPreferredServiceText(text: string): boolean {
  const value = String(text || '')
  if (/<(?:table|img)\b/i.test(value)) return true
  if (findLikelyRunawayRepeatedOcrText(value)) return true
  return hasGujiWebMetadataHallucination(value)
    || hasGujiModernDateHallucination(value)
    || hasGujiMachineTokenHallucination(value)
    || hasGujiUnexpectedScriptHallucination(value)
    || hasGujiKanaPunctuationSubstitutionIssue(value)
    || hasGujiVerticalQuestionPhrasePollution(value)
}

function getPreferredGujiServiceText(result: unknown): string {
  if (!isJsonRecord(result)) return ''
  const markdownText = cleanGujiPlaceholderText(getMarkdownTextFromUnknown(result.markdown))
  if (markdownText && !isUnsafeGujiPreferredServiceText(markdownText)) return markdownText
  const sourceText = cleanGujiPlaceholderText(getTextFromUnknown(getRecordFirstValue(result, [
    'paddle_markdown_text',
    'ocr_source_text',
    'source_text',
  ])))
  return sourceText && !isUnsafeGujiPreferredServiceText(sourceText) ? sourceText : ''
}

function preservePreferredGujiServiceText<T extends OcrRecognizeResult>(result: T, preferredText: string): T {
  const text = String(preferredText || '').trim()
  if (!text) return result
  return {
    ...result,
    text,
    paddle_markdown_text: text,
    normalization: {
      ...(isJsonRecord(result.normalization) ? result.normalization : {}),
      text_source: 'paddle_markdown',
      preserved_paddle_markdown_text: true,
    },
  } as T
}

function getPositiveNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null
}

function countArrayField(record: JsonRecord, path: readonly string[]): number {
  let current: unknown = record
  for (const key of path) {
    if (!isJsonRecord(current)) return 0
    current = current[key]
  }
  return Array.isArray(current) ? current.length : 0
}

function summarizeDiscardedFeijiangLayoutSources(source: JsonRecord): JsonRecord {
  const summary: JsonRecord = {}
  const candidates: Array<[string, readonly string[]]> = [
    ['layout_result', ['layout_result']],
    ['raw_layout_result', ['raw_layout_result']],
    ['layout_blocks', ['layout_blocks']],
    ['parsing_res_list', ['parsing_res_list']],
    ['prunedResult.parsing_res_list', ['prunedResult', 'parsing_res_list']],
    ['layout_det_res.boxes', ['layout_det_res', 'boxes']],
    ['boxes', ['boxes']],
    ['words_result', ['words_result']],
    ['overall_ocr_res.rec_texts', ['overall_ocr_res', 'rec_texts']],
    ['overall_ocr_res.rec_boxes', ['overall_ocr_res', 'rec_boxes']],
    ['overall_ocr_res.rec_polys', ['overall_ocr_res', 'rec_polys']],
    ['rec_texts', ['rec_texts']],
    ['rec_boxes', ['rec_boxes']],
    ['rec_polys', ['rec_polys']],
  ]
  for (const [key, path] of candidates) {
    const count = countArrayField(source, path)
    if (count > 0) summary[key] = count
  }
  return summary
}

function createFeijiangReferenceTextOnlyIr(
  source: JsonRecord,
  page: Pick<OcrSavePageSnapshot, 'page_num' | 'image_path' | 'ocr_result'> | null | undefined,
  generatedAt?: string,
): NonNullable<OcrRecognizeResult['gujismart_ir']> {
  const size = getFeijiangReferencePageSize(source, page)
  return {
    schemaVersion: OCR_IR_SCHEMA_VERSION,
    generator: 'GujiSmart',
    pipelineVersion: OCR_IR_PIPELINE_VERSION,
    generatedAt: generatedAt || getOcrPageIr(page?.ocr_result)?.generatedAt || new Date().toISOString(),
    page: {
      pageIndex: Number(page?.page_num || source.page_num || 0) || 1,
      width: size.width,
      height: size.height,
      orientation: 'unknown',
      orientationSource: 'unknown',
      blocks: [],
      discardedBlocks: [],
      paragraphs: [],
      assets: [],
      quality: {
        score: 0,
        coordinateCoverage: 0,
        confidenceCoverage: 0,
        lowConfidenceBlockCount: 0,
        missingCoordinateBlockCount: 0,
        discardedBlockCount: 0,
        issues: [],
      },
    },
  }
}

function getFeijiangReferencePageSize(
  source: JsonRecord,
  page: Pick<OcrSavePageSnapshot, 'page_num' | 'image_path'> | null | undefined,
): { width: number; height: number } {
  const imageSize = getPageImageSize(page?.image_path)
  const gujiProcessing = isJsonRecord(source.guji_processing) ? source.guji_processing : {}
  const width = imageSize?.width
    || getPositiveNumber(source.page_width)
    || getPositiveNumber(source.image_width)
    || getPositiveNumber(source.width)
    || getPositiveNumber(gujiProcessing.source_image_width)
    || 1
  const height = imageSize?.height
    || getPositiveNumber(source.page_height)
    || getPositiveNumber(source.image_height)
    || getPositiveNumber(source.height)
    || getPositiveNumber(gujiProcessing.source_image_height)
    || 1
  return { width, height }
}

function getFeijiangReferenceLayoutSafetyIssue(
  source: JsonRecord,
  page: Pick<OcrSavePageSnapshot, 'page_num' | 'image_path'> | null | undefined,
): string | null {
  const blocks = getOcrLayoutBlocks(source)
  if (blocks.length === 0) return 'reference_layout_missing'
  const size = getFeijiangReferencePageSize(source, page)
  if (size.width <= 1 || size.height <= 1) return 'reference_page_size_missing'
  let coordinateCount = 0
  let outOfBoundsCount = 0
  let readableBlockCount = 0
  const margin = Math.max(8, Math.min(size.width, size.height) * 0.012)
  for (const block of blocks) {
    const rect = getOcrBlockRect(block)
    const text = (getOcrBlockTableText(block) || getOcrBlockTextValue(block)).replace(/\s+/g, '')
    if (text || isOcrImageLikeLabel(getOcrBlockLabel(block))) readableBlockCount += 1
    if (!rect) continue
    coordinateCount += 1
    const right = rect.left + rect.width
    const bottom = rect.top + rect.height
    if (
      rect.width <= 0
      || rect.height <= 0
      || rect.left < -margin
      || rect.top < -margin
      || right > size.width + margin
      || bottom > size.height + margin
    ) {
      outOfBoundsCount += 1
    }
  }
  if (readableBlockCount === 0) return 'reference_layout_empty_text'
  const requiredCoordinates = blocks.length <= 2
    ? blocks.length
    : Math.max(2, Math.ceil(blocks.length * 0.7))
  if (coordinateCount < requiredCoordinates) return 'reference_layout_low_coordinate_coverage'
  if (outOfBoundsCount > 0) return 'reference_layout_out_of_bounds'
  return null
}

function preserveTrustedFeijiangReferenceLayout(
  result: OcrRecognizeResult,
  rawText: string,
  options: {
    page?: Pick<OcrSavePageSnapshot, 'page_num' | 'image_path' | 'ocr_result'> | null
    generatedAt?: string
  } = {},
): OcrRecognizeResult {
  const text = String(rawText || '')
  const source: JsonRecord = isJsonRecord(result) ? result : {}
  const normalization = isJsonRecord(source.normalization) ? source.normalization : {}
  const gujiProcessing = isJsonRecord(source.guji_processing) ? source.guji_processing : {}
  const size = getFeijiangReferencePageSize(source, options.page)
  const pageNum = getPositiveNumber(source.page_num) || getPositiveNumber(options.page?.page_num) || undefined
  const layoutSource = {
    ...source,
    text,
    markdown: { text },
    paddle_markdown_text: text,
    page_num: pageNum,
    page_width: size.width,
    page_height: size.height,
    image_width: size.width,
    image_height: size.height,
  }
  const envelope = buildOcrPageIr(layoutSource, {
    pageIndex: Number(pageNum || 0) || 1,
    pageWidth: size.width,
    pageHeight: size.height,
    engine: 'paddle',
    generatedAt: options.generatedAt || getOcrPageIr(options.page?.ocr_result)?.generatedAt,
    forceRebuild: true,
  })
  const irText = deriveOcrTextFromIr(envelope)
  return {
    ...layoutSource,
    source_type: String(source.source_type || 'feijiang_reference_layout'),
    words_result: deriveOcrWordsResultFromIr(envelope),
    gujismart_ir: envelope,
    ir_text: irText,
    gujismart_async_pdf_result: source.gujismart_async_pdf_result === true,
    gujismart_recovered_from_feijiang_json: true,
    gujismart_feijiang_reference_path: source.gujismart_feijiang_reference_path,
    guji_processing: {
      ...gujiProcessing,
      source: 'feijiang_reference_json',
      reference_layout_preserved: true,
    },
    normalization: {
      ...normalization,
      text_source: 'feijiang_reference_markdown',
      preserved_feijiang_reference_text: true,
      preserved_feijiang_reference_layout: true,
      discarded_untrusted_feijiang_reference_layout: false,
      schema_version: OCR_IR_SCHEMA_VERSION,
      pipeline_version: OCR_IR_PIPELINE_VERSION,
      generated_at: envelope.generatedAt,
    },
  }
}

function preserveRawGujiReferenceText(
  result: OcrRecognizeResult,
  rawText: string,
  options: {
    page?: Pick<OcrSavePageSnapshot, 'page_num' | 'image_path' | 'ocr_result'> | null
    generatedAt?: string
  } = {},
): OcrRecognizeResult {
  const text = String(rawText || '')
  if (!text) return result
  const source: JsonRecord = isJsonRecord(result) ? result : {}
  const layoutSafetyIssue = getFeijiangReferenceLayoutSafetyIssue(source, options.page)
  if (!layoutSafetyIssue) {
    return preserveTrustedFeijiangReferenceLayout(result, text, options)
  }
  const normalization = isJsonRecord(source.normalization) ? source.normalization : {}
  const gujiProcessing = isJsonRecord(source.guji_processing) ? source.guji_processing : {}
  const discardedLayoutSummary = summarizeDiscardedFeijiangLayoutSources(source)
  const textOnlyIr = createFeijiangReferenceTextOnlyIr(source, options.page, options.generatedAt)
  return {
    source_type: String(source.source_type || 'feijiang_reference_text'),
    text,
    markdown: { text },
    paddle_markdown_text: text,
    page_num: getPositiveNumber(source.page_num) || getPositiveNumber(options.page?.page_num) || undefined,
    page_width: textOnlyIr.page.width,
    page_height: textOnlyIr.page.height,
    image_width: textOnlyIr.page.width,
    image_height: textOnlyIr.page.height,
    layout_result: [],
    words_result: [],
    gujismart_ir: textOnlyIr,
    ir_text: '',
    gujismart_async_pdf_result: source.gujismart_async_pdf_result === true,
    gujismart_recovered_from_feijiang_json: true,
    gujismart_feijiang_reference_path: source.gujismart_feijiang_reference_path,
    guji_processing: {
      ...gujiProcessing,
      source: 'feijiang_reference_json',
    },
    normalization: {
      ...normalization,
      text_source: 'feijiang_reference_markdown',
      preserved_feijiang_reference_text: true,
      discarded_untrusted_feijiang_reference_layout: true,
      discarded_untrusted_feijiang_reference_layout_issue: layoutSafetyIssue,
      discarded_untrusted_feijiang_reference_layout_summary: discardedLayoutSummary,
      schema_version: OCR_IR_SCHEMA_VERSION,
      pipeline_version: OCR_IR_PIPELINE_VERSION,
      generated_at: textOnlyIr.generatedAt,
    },
  }
}

function normalizeFeijiangReferenceTextOnlyResult(
  result: unknown,
  rawText: string,
  page: Pick<OcrSavePageSnapshot, 'page_num' | 'image_path' | 'ocr_result'> | null | undefined,
  engine: OcrEngine,
): OcrRecognizeResult {
  const source = isJsonRecord(result) ? result : {}
  const generatedAt = getOcrPageIr(page?.ocr_result)?.generatedAt
  return preserveRawGujiReferenceText({
    ...source,
    text: rawText,
    markdown: { text: rawText },
    guji_processing: {
      ...(isJsonRecord(source.guji_processing) ? source.guji_processing : {}),
      source: 'feijiang_reference_json',
      engine,
    },
  } as OcrRecognizeResult, rawText, { page, generatedAt })
}

function isFeijiangReferenceRecoveredResult(result: unknown): result is OcrPageResultPayload {
  return isJsonRecord(result) && result.gujismart_recovered_from_feijiang_json === true
}

function getRawFeijiangReferenceText(result: unknown): string {
  if (!isJsonRecord(result)) return ''
  return getRawMarkdownTextFromUnknown(result.markdown) || getRawTextFromUnknown(result.text)
}

function stripOcrHtml(value: string): string {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getUsableGujiAsyncPdfServiceText(result: unknown, minCompactLength = 12): string {
  if (!isJsonRecord(result)) return ''
  const markdownText = cleanGujiPlaceholderText(getMarkdownTextFromUnknown(result.markdown))
  const sourceText = cleanGujiPlaceholderText(getTextFromUnknown(getRecordFirstValue(result, [
    'text',
    'paddle_markdown_text',
    'ocr_source_text',
    'source_text',
  ])))
  const candidate = markdownText || sourceText
  const visibleText = stripOcrHtml(candidate)
  if (visibleText.replace(/\s+/g, '').length < minCompactLength) return ''
  if (findLikelyRunawayRepeatedOcrText(candidate)) return ''
  if (hasGujiWebMetadataHallucination(candidate)) return ''
  if (hasGujiModernDateHallucination(candidate)) return ''
  if (hasGujiMachineTokenHallucination(candidate)) return ''
  return candidate
}

function getOcrBlockLabel(block: JsonRecord): string {
  return getTextFromUnknown(getRecordFirstValue(block, ['label', 'block_label', 'type', 'block_type', 'category'])).toLowerCase()
}

function getOcrBlockTextValue(block: JsonRecord): string {
  return getTextFromUnknown(getRecordFirstValue(block, ['words', 'text', 'content', 'block_content', 'raw_words', 'raw_text']))
}

function getOcrBlockHtmlValue(block: JsonRecord): string {
  return getTextFromUnknown(getRecordFirstValue(block, ['html', 'table_html', 'tableHtml', 'markdown']))
}

function getOcrBlockRows(block: JsonRecord): string[][] {
  const rawRows = getRecordFirstValue(block, ['rows', 'table_rows', 'tableRows'])
  if (!Array.isArray(rawRows)) return []
  return rawRows
    .map((row) => Array.isArray(row) ? row.map((cell) => getTextFromUnknown(cell)).filter(Boolean) : [])
    .filter((row) => row.length > 0)
}

function getOcrBlockCellCount(block: JsonRecord): number {
  const cells = getRecordFirstValue(block, ['cells', 'table_cells', 'tableCells'])
  return Array.isArray(cells) ? cells.length : 0
}

function countHtmlMatches(value: string, pattern: RegExp): number {
  return (value.match(pattern) || []).length
}

function extractHtmlTableCellTexts(value: string): string[] {
  const cells = String(value || '').match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []
  return cells.map(stripOcrHtml).filter(Boolean)
}

function getRowsText(rows: string[][]): string {
  return rows.flat().join('')
}

function getOcrBlockTableText(block: JsonRecord): string {
  const rows = getOcrBlockRows(block)
  if (rows.length > 0) return getRowsText(rows)
  const html = getOcrBlockHtmlValue(block)
  const htmlCells = extractHtmlTableCellTexts(html)
  if (htmlCells.length > 0) return htmlCells.join('')
  return getOcrBlockTextValue(block)
}

function hasNarrativeTableCells(block: JsonRecord): boolean {
  const rows = getOcrBlockRows(block)
  const html = getOcrBlockHtmlValue(block)
  const cells = rows.length > 0 ? rows.flat() : extractHtmlTableCellTexts(html)
  if (cells.length < 2) return false
  const compactCells = cells.map((cell) => String(cell || '').replace(/\s+/g, '')).filter(Boolean)
  if (compactCells.length < 2) return false
  const longCellCount = compactCells.filter((cell) => cell.length >= 24).length
  const maxCellLength = Math.max(...compactCells.map((cell) => cell.length), 0)
  const punctuationText = compactCells.join('')
  const punctuationCount = (punctuationText.match(/[。．、，；：？！「」『』（）()]/g) || []).length
  return longCellCount >= 2 || maxCellLength >= 80 || punctuationCount >= 8
}

function hasCjkOrKanaText(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(value)
}

function isLikelyBookishPdfTableResult(blocks: JsonRecord[], totalText: string): boolean {
  const compactText = totalText.replace(/\s+/g, '')
  if (compactText.length < 80 || !hasCjkOrKanaText(compactText)) return false
  const tableBlocks = blocks.filter((block) => /table|sheet|excel/.test(getOcrBlockLabel(block)))
  if (tableBlocks.length === 0) return false
  const hasNarrativeTable = tableBlocks.some(hasNarrativeTableCells)
  return hasNarrativeTable
}

function getOcrBlockRect(block: JsonRecord): { left: number; top: number; width: number; height: number } | null {
  const rect = getRecordFirstValue(block, ['location', 'bbox', 'box', 'block_bbox', 'coordinate'])
  if (Array.isArray(rect) && rect.length >= 4) {
    const numbers = rect.map(Number)
    if (numbers.every(Number.isFinite)) {
      if (numbers.length >= 8) {
        const xs = [numbers[0], numbers[2], numbers[4], numbers[6]]
        const ys = [numbers[1], numbers[3], numbers[5], numbers[7]]
        const left = Math.min(...xs)
        const top = Math.min(...ys)
        const width = Math.max(...xs) - left
        const height = Math.max(...ys) - top
        return width > 0 && height > 0 ? { left, top, width, height } : null
      }
      const [left, top, right, bottom] = numbers
      const width = right - left
      const height = bottom - top
      return width > 0 && height > 0 ? { left, top, width, height } : null
    }
    const points = rect.filter(isJsonRecord)
    if (points.length >= 2) {
      const xs = points.map((point) => Number(point.x ?? point.left ?? 0))
      const ys = points.map((point) => Number(point.y ?? point.top ?? 0))
      if (xs.every(Number.isFinite) && ys.every(Number.isFinite)) {
        const left = Math.min(...xs)
        const top = Math.min(...ys)
        const width = Math.max(...xs) - left
        const height = Math.max(...ys) - top
        return width > 0 && height > 0 ? { left, top, width, height } : null
      }
    }
    return null
  }
  if (!isJsonRecord(rect)) return null
  const left = Number(rect.left ?? rect.x ?? 0)
  const top = Number(rect.top ?? rect.y ?? 0)
  const width = Number(rect.width ?? (rect.right !== undefined ? Number(rect.right) - left : 0))
  const height = Number(rect.height ?? (rect.bottom !== undefined ? Number(rect.bottom) - top : 0))
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { left, top, width, height }
}

function getOcrLayoutBlocks(result: unknown): JsonRecord[] {
  if (!isJsonRecord(result)) return []
  const blocks = getRecordFirstValue(result, ['layout_result', 'layout_blocks', 'parsing_res_list'])
  return Array.isArray(blocks) ? blocks.filter(isJsonRecord) : []
}

function getOcrPageSizeForResult(result: unknown, imagePath?: string | null): { width: number; height: number } | null {
  const imageSize = getPageImageSize(imagePath)
  if (imageSize) return imageSize
  if (!isJsonRecord(result)) return null
  const width = Number(getRecordFirstValue(result, ['page_width', 'image_width', 'width']))
  const height = Number(getRecordFirstValue(result, ['page_height', 'image_height', 'height']))
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height }
  }
  return null
}

function getLikelyGujiPdfTableMisclassification(
  result: unknown,
  imagePath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
): string | null {
  if (ocrOptions.profile !== 'guji_print_vertical') return null
  const blocks = getOcrLayoutBlocks(result)
  if (blocks.length === 0) return null
  const pageSize = getOcrPageSizeForResult(result, imagePath)
  const pageArea = pageSize ? pageSize.width * pageSize.height : 0
  const totalTextLength = Math.max(1, blocks.map(getOcrBlockTextValue).join('').replace(/\s+/g, '').length)
  let bestTableTextLength = 0

  for (const block of blocks) {
    const label = getOcrBlockLabel(block)
    const rows = getOcrBlockRows(block)
    const cellCount = getOcrBlockCellCount(block)
    const html = getTextFromUnknown(getRecordFirstValue(block, ['html', 'table_html', 'tableHtml', 'markdown']))
    const looksTable = /table|表格|sheet|excel/.test(label)
      || rows.length >= 4
      || cellCount >= 8
      || /<table|<tr|<td|<th/i.test(html)
    if (!looksTable) continue

    const rect = getOcrBlockRect(block)
    const widthRatio = rect && pageSize ? rect.width / Math.max(1, pageSize.width) : 0
    const heightRatio = rect && pageSize ? rect.height / Math.max(1, pageSize.height) : 0
    const areaRatio = rect && pageArea > 0 ? (rect.width * rect.height) / pageArea : 0
    const textLength = (rows.length > 0 ? rows.flat().join('') : getOcrBlockTextValue(block)).replace(/\s+/g, '').length
    bestTableTextLength = Math.max(bestTableTextLength, textLength)
    const rowCount = Math.max(rows.length, String(getOcrBlockTextValue(block) || html).split(/\r?\n/).filter((line) => line.trim()).length)
    const dominantText = textLength / totalTextLength >= 0.45
    const largePageBlock = areaRatio >= 0.22 || (widthRatio >= 0.5 && heightRatio >= 0.3)
    const manyTableRows = rowCount >= 8 || cellCount >= 16 || /<tr[\s\S]*<tr[\s\S]*<tr[\s\S]*<tr/i.test(html)
    if (dominantText && largePageBlock && manyTableRows) {
      return 'PDF 异步 OCR 疑似把古籍竖排版面误判成表格，已改用本页图片 OCR 回退。'
    }
  }

  if (bestTableTextLength / totalTextLength >= 0.75 && blocks.length <= 3) {
    return 'PDF 异步 OCR 疑似把整页古籍文本误判成表格，已改用本页图片 OCR 回退。'
  }
  return null
}

function getLikelyAsyncPdfTableMisclassification(
  result: unknown,
  imagePath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
): string | null {
  const legacyGujiIssue = getLikelyGujiPdfTableMisclassification(result, imagePath, ocrOptions)
  if (legacyGujiIssue) return legacyGujiIssue

  const blocks = getOcrLayoutBlocks(result)
  if (blocks.length === 0) return null
  const pageSize = getOcrPageSizeForResult(result, imagePath)
  const pageArea = pageSize ? pageSize.width * pageSize.height : 0
  const totalText = blocks.map((block) => getOcrBlockTableText(block) || getOcrBlockTextValue(block)).join('\n')
  const totalTextLength = Math.max(1, totalText.replace(/\s+/g, '').length)
  if (!isLikelyBookishPdfTableResult(blocks, totalText)) return null

  let bestTableTextLength = 0
  for (const block of blocks) {
    const label = getOcrBlockLabel(block)
    const rows = getOcrBlockRows(block)
    const cellCount = getOcrBlockCellCount(block)
    const html = getOcrBlockHtmlValue(block)
    const htmlCellCount = extractHtmlTableCellTexts(html).length
    const htmlRowCount = countHtmlMatches(html, /<tr\b/gi)
    const looksTable = /table|sheet|excel/.test(label)
      || rows.length >= 4
      || cellCount >= 8
      || htmlCellCount >= 8
      || /<table|<tr|<td|<th/i.test(html)
    if (!looksTable) continue

    const rect = getOcrBlockRect(block)
    const widthRatio = rect && pageSize ? rect.width / Math.max(1, pageSize.width) : 0
    const heightRatio = rect && pageSize ? rect.height / Math.max(1, pageSize.height) : 0
    const areaRatio = rect && pageArea > 0 ? (rect.width * rect.height) / pageArea : 0
    const textLength = getOcrBlockTableText(block).replace(/\s+/g, '').length
    bestTableTextLength = Math.max(bestTableTextLength, textLength)
    const rowCount = Math.max(
      rows.length,
      htmlRowCount,
      String(getOcrBlockTextValue(block) || stripOcrHtml(html)).split(/\r?\n/).filter((line) => line.trim()).length,
    )
    const dominantText = textLength / totalTextLength >= 0.45
    const largePageBlock = areaRatio >= 0.22 || (widthRatio >= 0.5 && heightRatio >= 0.3) || !pageSize
    const manyTableRows = rowCount >= 8 || cellCount >= 16 || htmlCellCount >= 16 || /<tr[\s\S]*<tr[\s\S]*<tr[\s\S]*<tr/i.test(html)
    if (dominantText && largePageBlock && manyTableRows) {
      return 'PDF 异步 OCR 疑似把书页误判成表格，已改用本页图片 OCR 回退。'
    }
  }

  if (bestTableTextLength / totalTextLength >= 0.75 && blocks.length <= 6) {
    return 'PDF 异步 OCR 疑似把整页文字误判成表格，已改用本页图片 OCR 回退。'
  }
  return null
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
    imageRotation: overrides?.imageRotation === 90 ? 90 : 0,
  }
}

function getVerticalFallbackOcrOptions(ocrOptions: Required<PageOcrOptions>): Required<PageOcrOptions> {
  if (ocrOptions.profile === 'guji_print_vertical') return ocrOptions
  return { ...ocrOptions, profile: 'guji_print_vertical', secondPass: 'local_segmentation' }
}

function getPageOcrResultRecord(page: Pick<OcrPageRow, 'ocr_result'>): JsonRecord | null {
  return parseJsonRecord(page.ocr_result)
}

function hasVerticalGujiProcessingMeta(result: JsonRecord | null): boolean {
  if (!result) return false
  const processing = result.guji_processing
  if (!isJsonRecord(processing)) return false
  return String(processing.profile || '') === 'guji_print_vertical'
}

function hasVerticalBlockLayoutSignals(result: JsonRecord | null, imagePath?: string | null): boolean {
  if (!result) return false
  const blocks = getOcrLayoutBlocks(result)
  if (blocks.length < 3) return false
  const pageSize = getOcrPageSizeForResult(result, imagePath)
  const textBlocks = blocks.filter((block) => getOcrBlockTextValue(block).replace(/\s+/g, '').length >= 2)
  if (textBlocks.length < 3) return false
  const verticalBlocks = textBlocks.filter((block) => {
    const orientation = String(block.orientation || '').toLowerCase()
    if (orientation === 'vertical') return true
    const label = getOcrBlockLabel(block)
    if (/vertical|column|col_text|竖排|豎排|直排|縦書き|縦組み/.test(label)) return true
    const rect = getOcrBlockRect(block)
    if (!rect) return false
    const heightRatio = pageSize ? rect.height / Math.max(1, pageSize.height) : 0
    return rect.width > 0 && rect.height >= rect.width * 1.25 && heightRatio >= 0.08
  })
  return verticalBlocks.length >= 3 && verticalBlocks.length / textBlocks.length >= 0.45
}

function hasExistingVerticalPageOcrSignals(pages: OcrPageRow[]): boolean {
  const sampledPages = pages.filter((page) => page.ocr_result || page.image_path).slice(0, 24)
  if (sampledPages.length === 0) return false
  let verticalPages = 0
  let explicitVerticalPages = 0

  for (const page of sampledPages) {
    const result = getPageOcrResultRecord(page)
    if (hasVerticalGujiProcessingMeta(result)) {
      explicitVerticalPages += 1
      verticalPages += 1
      continue
    }
    if (hasVerticalBlockLayoutSignals(result, page.image_path)) {
      verticalPages += 1
    }
  }

  if (explicitVerticalPages > 0) return true
  return verticalPages >= 2 && verticalPages / sampledPages.length >= 0.35
}

function hasBookFacsimileImageSignals(pages: OcrPageRow[]): boolean {
  const imagePages = pages
    .map((page) => getPageImageSize(page.image_path))
    .filter((size): size is { width: number; height: number } => Boolean(size))
    .slice(0, 12)
  if (imagePages.length === 0) return false
  const landscapePages = imagePages.filter((size) => size.width >= size.height * 1.12).length
  const portraitTallPages = imagePages.filter((size) => size.height >= size.width * 1.18).length
  return landscapePages >= 2 || portraitTallPages >= Math.max(3, Math.ceil(imagePages.length * 0.6))
}

function getDocumentRouteHintText(doc: Pick<OcrDocumentRow, 'title' | 'author' | 'source' | 'doc_type' | 'metadata'>): string {
  const metadata = parseMetadata(doc.metadata)
  return [
    doc.title,
    doc.author,
    doc.source,
    doc.doc_type,
    metadata.title,
    metadata.original_title,
    metadata.filename,
    metadata.file_name,
  ].map((value) => String(value || '')).join(' ')
}

function hasOldBookRouteHints(doc: Pick<OcrDocumentRow, 'title' | 'author' | 'source' | 'doc_type' | 'metadata'>): boolean {
  const text = getDocumentRouteHintText(doc)
  if (/古籍|影印|善本|刻本|鈔本|抄本|線裝|线装|竪排|豎排|縦書|縦組/.test(text)) return true
  const earlyYear = (text.match(/(?:18|19)\d{2}/g) || [])
    .map((year) => Number(year))
    .some((year) => Number.isFinite(year) && year <= 1955)
  const oldOrthography = /[學國讀會卷舊舆臺]|假名|尋常|初等|小學|小学|文部省/.test(text)
  const oldSchoolBookSignals = /(?:學校|学校|小學|小学|初等|尋常|教本|教科書|讀本|読本|國語|国語|日本語|漢文|修身|地理|歴史|历史|算術|算术)/.test(text)
  return (earlyYear || oldOrthography) && oldSchoolBookSignals
}

function getGujiAsyncPdfPageRangeChunkSize(pageCount: number): number {
  const safePageCount = Math.max(0, Math.floor(Number(pageCount || 0)))
  if (safePageCount >= OCR_ASYNC_PDF_GUJI_LARGE_PAGE_THRESHOLD) {
    return OCR_ASYNC_PDF_GUJI_LARGE_PAGE_RANGE_CHUNK_SIZE
  }
  return OCR_ASYNC_PDF_GUJI_PAGE_RANGE_CHUNK_SIZE
}

function getAsyncPdfOcrRouteRisk(
  doc: Pick<OcrDocumentRow, 'title' | 'author' | 'source' | 'doc_type' | 'metadata'>,
  pages: OcrPageRow[],
  pagesForOcr: OcrPageRow[],
  ocrOptions: Required<PageOcrOptions>,
): AsyncPdfOcrRouteRisk | null {
  const routePageCount = Math.max(pages.length, pagesForOcr.length)
  const pageRangeChunkSize = getGujiAsyncPdfPageRangeChunkSize(routePageCount)
  if (ocrOptions.profile === 'guji_print_vertical') {
    return {
      reason: `文献类型为古籍，使用整本原 PDF 的 ${pageRangeChunkSize} 页 pageRanges 异步 OCR，对齐飞桨网页导出的任务形态。`,
      ocrOptions,
      pageRangeChunkSize,
    }
  }
  if (hasExistingVerticalPageOcrSignals(pages)) {
    return {
      reason: `已检测到页面存在竖排/古籍 OCR 信号，使用整本原 PDF 的 ${pageRangeChunkSize} 页 pageRanges 异步 OCR。`,
      ocrOptions: getVerticalFallbackOcrOptions(ocrOptions),
      pageRangeChunkSize,
    }
  }
  if (hasOldBookRouteHints(doc) && (hasBookFacsimileImageSignals(pages) || pages.length === 0 || pagesForOcr.length === pages.length)) {
    return {
      reason: `文献标题或元数据像旧式影印书，使用整本原 PDF 的 ${pageRangeChunkSize} 页 pageRanges 异步 OCR。`,
      ocrOptions: getVerticalFallbackOcrOptions(ocrOptions),
      pageRangeChunkSize,
    }
  }
  return null
}

function resolveFallbackPdfPathForPostProcess(
  pages: Array<{ page: OcrPageRow; sourcePageIndex: number; resultIndex: number }>,
): string | null {
  const firstPage = pages.find((item) => item.page?.doc_id)?.page
  if (!firstPage) return null
  const maxPage = Math.max(0, ...pages.map((item) => Number(item.page?.page_num || 0)).filter(Number.isFinite))
  const doc = queryOne<Pick<OcrDocumentRow, 'id' | 'file_path' | 'metadata'>>(
    'SELECT id, file_path, metadata FROM documents WHERE id = ?',
    [firstPage.doc_id],
  )
  return doc ? resolveUsablePdfPath(doc, maxPage) : null
}

function getAsyncPdfPostProcessOptions(ocrOptions: Required<PageOcrOptions>): Required<PageOcrOptions> {
  if (ocrOptions.profile !== 'guji_print_vertical') return ocrOptions
  return {
    ...ocrOptions,
    secondPass: 'none',
  }
}

async function recoverGujiAsyncPdfQualityIssueWithPageImage(
  page: OcrPageRow,
  pdfPath: string | null,
  ocrOptions: Required<PageOcrOptions>,
  signal?: AbortSignal,
): Promise<OcrPageResult | null> {
  if (ocrOptions.profile !== 'guji_print_vertical') return null
  const doc = queryOne<OcrDocumentRow>('SELECT * FROM documents WHERE id = ?', [page.doc_id])
  if (!doc) return null
  try {
    const imagePage = await ensurePageImageForOcrFallback(page, pdfPath, signal)
    if (!imagePage) return null
    const retryOptions = getAutomaticSinglePageRetryOptions(doc, imagePage)
    const result = await recognizeSinglePage(imagePage, doc, retryOptions)
    const recoveredResult = isJsonRecord(result)
      ? {
        ...result,
        gujismart_async_pdf_quality_fallback: true,
        gujismart_async_pdf_quality_fallback_source: 'page_image_ocr',
      }
      : result
    return {
      pageId: page.id,
      result: recoveredResult,
      text: getOcrResultText(recoveredResult),
      status: 'completed',
    } satisfies OcrPageResult
  } catch (error) {
    if (isOcrAbortError(error)) throw error
    console.warn('[OCR] Failed to recover async PDF quality issue with page-image OCR:', page.page_num, error)
    return null
  }
}

function formatAsyncPdfRetryableQualityIssue(message: string): string {
  return `${OCR_ASYNC_PDF_QUALITY_RETRYABLE_PREFIX} ${message}`
}

function getGujiAsyncPdfRetryableQualityIssue(
  result: OcrPageResultPayload,
  _imagePath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
): string | null {
  if (ocrOptions.profile !== 'guji_print_vertical') return null
  const repeatedIssue = findLikelyRunawayRepeatedOcrText(result)
  if (repeatedIssue) return formatAsyncPdfRetryableQualityIssue(formatSuspiciousRepeatedOcrTextIssue(repeatedIssue))
  return null
}

function uniqueExistingDirectories(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of paths) {
    const dir = String(item || '').trim()
    if (!dir || seen.has(dir) || !existsSync(dir)) continue
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    seen.add(dir)
    result.push(dir)
  }
  return result
}

function getFeijiangReferenceSearchDirectories(pdfPath: string | null | undefined): string[] {
  const envDirs = String(process.env[OCR_FEIJIANG_REFERENCE_ENV] || '')
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
  let downloadsDir = ''
  try {
    downloadsDir = app.getPath('downloads')
  } catch {
    downloadsDir = ''
  }
  return uniqueExistingDirectories([
    pdfPath ? dirname(pdfPath) : null,
    ...envDirs,
    downloadsDir,
    downloadsDir ? join(downloadsDir, 'edge') : null,
  ])
}

function isLikelyFeijiangReferenceJsonName(fileName: string, pdfPath: string | null | undefined): boolean {
  const lowerName = fileName.toLowerCase()
  if (!lowerName.endsWith('.json') || !lowerName.includes('paddleocr')) return false
  const pdfName = pdfPath ? basename(pdfPath).toLowerCase() : ''
  if (pdfName && lowerName.startsWith(`${pdfName}_by_paddleocr`)) return true
  if (pdfName && lowerName.includes(pdfName) && lowerName.includes('_by_paddleocr')) return true
  const parsed = pdfPath ? parse(pdfPath) : null
  const stem = parsed?.name?.toLowerCase() || ''
  return Boolean(stem && lowerName.includes(stem) && lowerName.includes('_by_paddleocr'))
}

async function findFeijiangReferenceJsonPath(pdfPath: string | null | undefined): Promise<string | null> {
  if (!pdfPath) return null
  const candidates: Array<{ path: string; mtimeMs: number }> = []
  for (const dir of getFeijiangReferenceSearchDirectories(pdfPath)) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !isLikelyFeijiangReferenceJsonName(entry.name, pdfPath)) continue
        const fullPath = join(dir, entry.name)
        try {
          candidates.push({ path: fullPath, mtimeMs: statSync(fullPath).mtimeMs })
        } catch {
          candidates.push({ path: fullPath, mtimeMs: 0 })
        }
      }
    } catch {
      continue
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.path || null
}

function extractFeijiangReferencePages(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isJsonRecord(payload)) return []
  const result = payload.result
  if (Array.isArray(result)) return result
  const pages = payload.pages
  if (Array.isArray(pages)) return pages
  const pagePayloads = payload.pagePayloads
  if (Array.isArray(pagePayloads)) return pagePayloads
  const data = payload.data
  if (Array.isArray(data)) return data
  if (isJsonRecord(data)) return extractFeijiangReferencePages(data)
  const numericKeys = Object.keys(payload)
    .filter((key) => /^\d+$/.test(key))
    .sort((left, right) => Number(left) - Number(right))
  if (numericKeys.length > 0) {
    const numericPages = numericKeys
      .map((key) => payload[key])
      .filter((item) => item !== undefined && item !== null)
    if (numericPages.length > 0) return numericPages
  }
  return []
}

function attachGujiReferenceProcessingMeta(
  payload: OcrPageResultPayload,
  ocrOptions: Required<PageOcrOptions>,
  referencePath: string,
): OcrPageResultPayload {
  return {
    ...payload,
    gujismart_async_pdf_result: true,
    gujismart_recovered_from_feijiang_json: true,
    gujismart_feijiang_reference_path: referencePath,
    guji_processing: {
      ...(isJsonRecord(payload.guji_processing) ? payload.guji_processing : {}),
      profile: ocrOptions.profile,
      second_pass: 'none',
      source: 'feijiang_reference_json',
    },
  }
}

function normalizeFeijiangReferencePayloadForRecovery(
  payload: unknown,
  ocrOptions: Required<PageOcrOptions>,
  referencePath: string,
): OcrPageResultPayload | null {
  if (!isJsonRecord(payload)) return null
  const normalized = normalizePageResult(payload) as OcrPageResultPayload
  return attachGujiReferenceProcessingMeta(normalized, ocrOptions, referencePath)
}

async function loadFeijiangOcrReference(pdfPath: string | null | undefined): Promise<FeijiangOcrReference | null> {
  const normalizedPdfPath = String(pdfPath || '').trim()
  if (!normalizedPdfPath) return null
  const cached = feijiangOcrReferenceCache.get(normalizedPdfPath)
  if (cached) return cached
  const loadPromise = (async () => {
    const referencePath = await findFeijiangReferenceJsonPath(normalizedPdfPath)
    if (!referencePath) return null
    try {
      const parsed = JSON.parse(await readFile(referencePath, 'utf8')) as unknown
      const pages = extractFeijiangReferencePages(parsed)
      return pages.length > 0 ? { path: referencePath, pages } : null
    } catch (error) {
      console.warn('[OCR] Failed to read PaddleOCR reference JSON:', referencePath, error)
      return null
    }
  })()
  feijiangOcrReferenceCache.set(normalizedPdfPath, loadPromise)
  return loadPromise
}

function getFeijiangReferencePagePayload(reference: FeijiangOcrReference, pageNum: number): unknown | null {
  const index = Math.max(0, Math.round(pageNum) - 1)
  return reference.pages[index] ?? null
}

function getQualityFailureReferenceRecoveryOptions(
  doc: Pick<OcrDocumentRow, 'title' | 'author' | 'source' | 'doc_type' | 'metadata'>,
  options?: SavePageQualityFailureOptions,
): Required<PageOcrOptions> {
  const resolved = options?.ocrOptions || resolveDocOcrOptions(doc.doc_type, options?.pageOptions)
  return resolved.profile === 'guji_print_vertical' || hasOldBookRouteHints(doc)
    ? getVerticalFallbackOcrOptions(resolved)
    : resolved
}

async function recoverPageQualityFailureFromFeijiangReference(
  page: OcrPageRow,
  doc: Pick<OcrDocumentRow, 'id' | 'title' | 'author' | 'source' | 'doc_type' | 'metadata'> & Partial<Pick<OcrDocumentRow, 'file_path'>>,
  options: SavePageQualityFailureOptions = {},
): Promise<OcrPageResult | null> {
  const recoveryOptions = getQualityFailureReferenceRecoveryOptions(doc, options)
  if (recoveryOptions.profile !== 'guji_print_vertical') return null
  const docPathInfo = typeof doc.file_path === 'string'
    ? { id: doc.id, file_path: doc.file_path, metadata: doc.metadata }
    : queryOne<Pick<OcrDocumentRow, 'id' | 'file_path' | 'metadata'>>('SELECT id, file_path, metadata FROM documents WHERE id = ?', [doc.id])
  const pdfPath = docPathInfo ? resolveUsablePdfPath(docPathInfo, Number(page.page_num || 0)) : null
  const reference = await loadFeijiangOcrReference(pdfPath)
  return recoverGujiPageFromFeijiangReference(page, reference, recoveryOptions, options.signal)
}

function normalizeFeijiangComparableText(value: string): string {
  return stripOcrHtml(value)
    .replace(/&(?:nbsp|ensp|emsp);/gi, '')
    .replace(/\s+/g, '')
    .trim()
}

function getGujiReferenceComparableText(result: unknown): string {
  const text = getPreferredGujiServiceText(result)
    || getUsableGujiAsyncPdfServiceText(result, 1)
    || getOcrResultText(result)
  return normalizeFeijiangComparableText(text)
}

function getCharNgrams(value: string, size = 2, maxLength = 6000): Set<string> {
  const text = value.slice(0, maxLength)
  const grams = new Set<string>()
  if (text.length <= size) {
    if (text) grams.add(text)
    return grams
  }
  for (let index = 0; index + size <= text.length; index += 1) {
    grams.add(text.slice(index, index + size))
  }
  return grams
}

function getNgramContainment(left: string, right: string, size = 2): number {
  const leftGrams = getCharNgrams(left, size)
  const rightGrams = getCharNgrams(right, size)
  const smaller = leftGrams.size <= rightGrams.size ? leftGrams : rightGrams
  const larger = leftGrams.size <= rightGrams.size ? rightGrams : leftGrams
  if (smaller.size === 0 && larger.size === 0) return 1
  if (smaller.size === 0 || larger.size === 0) return 0
  let shared = 0
  smaller.forEach((gram) => {
    if (larger.has(gram)) shared += 1
  })
  return shared / Math.max(1, smaller.size)
}

function hasLikelyForeignFormulaLeadIn(value: string): boolean {
  return /(?:\$[^$]{0,30}\$|\\(?:frac|begin|sum|int)\b|[a-z]_\{?\d)/i.test(value.slice(0, 240))
}

function getGujiFeijiangReferenceMismatchIssue(candidate: unknown, reference: unknown): string | null {
  const candidateText = getGujiReferenceComparableText(candidate)
  const referenceText = getGujiReferenceComparableText(reference)
  const candidateLength = candidateText.length
  const referenceLength = referenceText.length
  if (referenceLength === 0 && candidateLength === 0) return null
  if (referenceLength < 80 && candidateLength < 80) return null
  if (referenceLength >= 120 && candidateLength === 0) {
    return 'PaddleOCR async PDF result is empty while the same-name PaddleOCR reference JSON has page text.'
  }
  if (referenceLength >= 200 && candidateLength < referenceLength * 0.45) {
    return 'PaddleOCR async PDF result is much shorter than the same-name PaddleOCR reference JSON page.'
  }
  if (candidateLength >= 200 && referenceLength > 0 && candidateLength > referenceLength * 1.8 && candidateLength - referenceLength > 300) {
    return 'PaddleOCR async PDF result is much longer than the same-name PaddleOCR reference JSON page.'
  }
  const containment = getNgramContainment(candidateText, referenceText)
  if (Math.max(candidateLength, referenceLength) >= 180 && containment < 0.42) {
    return 'PaddleOCR async PDF result has low text agreement with the same-name PaddleOCR reference JSON page.'
  }
  const prefixContainment = getNgramContainment(candidateText.slice(0, 220), referenceText.slice(0, 220))
  if (
    referenceLength >= 250
    && candidateLength >= 250
    && prefixContainment < 0.18
    && containment < 0.62
  ) {
    return 'PaddleOCR async PDF result appears to start with text from a different page than the same-name PaddleOCR reference JSON.'
  }
  if (
    hasLikelyForeignFormulaLeadIn(candidateText)
    && !hasLikelyForeignFormulaLeadIn(referenceText)
    && prefixContainment < 0.35
  ) {
    return 'PaddleOCR async PDF result appears to contain formula or foreign-page lead-in text that is absent from the same-name PaddleOCR reference JSON.'
  }
  return null
}

async function recoverGujiPageFromFeijiangReference(
  page: OcrPageRow,
  reference: FeijiangOcrReference | null,
  ocrOptions: Required<PageOcrOptions>,
  signal?: AbortSignal,
): Promise<OcrPageResult | null> {
  if (!reference || ocrOptions.profile !== 'guji_print_vertical') return null
  throwIfOcrCanceled(signal)
  const pageNum = Number(page.page_num || 0)
  if (!Number.isFinite(pageNum) || pageNum <= 0) return null
  const payload = getFeijiangReferencePagePayload(reference, pageNum)
  if (!payload) return null
  try {
    const result = normalizeFeijiangReferencePayloadForRecovery(payload, ocrOptions, reference.path)
    if (!result) return null
    const rawReferenceText = getRawFeijiangReferenceText(result)
    return {
      pageId: page.id,
      result,
      text: rawReferenceText || getOcrResultText(result),
      status: 'completed',
    } satisfies OcrPageResult
  } catch (error) {
    if (isOcrAbortError(error)) throw error
    console.warn('[OCR] Failed to recover page from PaddleOCR reference JSON:', pageNum, reference.path, error)
    return null
  }
}

async function recoverGujiPagesFromFeijiangReference(
  pages: OcrPageRow[],
  pdfPath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
  signal?: AbortSignal,
): Promise<OcrPageResult[]> {
  if (ocrOptions.profile !== 'guji_print_vertical' || pages.length === 0) return []
  const reference = await loadFeijiangOcrReference(pdfPath)
  if (!reference) return []
  const results: OcrPageResult[] = []
  for (const page of pages) {
    throwIfOcrCanceled(signal)
    const recovered = await recoverGujiPageFromFeijiangReference(page, reference, ocrOptions, signal)
    if (recovered) results.push(recovered)
    if (results.length % OCR_RESULT_POSTPROCESS_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }
  return results
}

async function recoverCompletedGujiPagesWithReferenceMismatch(
  docId: string,
  pdfPath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
  signal?: AbortSignal,
): Promise<OcrPageResult[]> {
  if (ocrOptions.profile !== 'guji_print_vertical') return []
  const reference = await loadFeijiangOcrReference(pdfPath)
  if (!reference) return []
  const rows = hydratePagePayloadRows(queryAll<OcrPageRow>(
    `SELECT *
     FROM pages
     WHERE doc_id = ? AND ocr_status = 'completed'
     ORDER BY page_num`,
    [docId],
  ))
  const recoverPages: OcrPageRow[] = []
  for (const page of rows) {
    throwIfOcrCanceled(signal)
    const current = getPageOcrResultRecord(page)
    if (!current) continue
    if (current.gujismart_recovered_from_feijiang_json === true) continue
    const pageNum = Number(page.page_num || 0)
    const referencePayload = getFeijiangReferencePagePayload(reference, pageNum)
    if (!referencePayload) continue
    const mismatchIssue = getGujiFeijiangReferenceMismatchIssue(current, referencePayload)
    if (!mismatchIssue) continue
    recoverPages.push(page)
  }
  if (recoverPages.length === 0) return []
  const results: OcrPageResult[] = []
  for (const page of recoverPages) {
    const recovered = await recoverGujiPageFromFeijiangReference(page, reference, ocrOptions, signal)
    if (recovered) results.push(recovered)
    if (results.length % OCR_RESULT_POSTPROCESS_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }
  return results
}

async function recoverCompletedGujiPagesFromFeijiangReference(
  docId: string,
  pdfPath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
  signal?: AbortSignal,
): Promise<OcrPageResult[]> {
  if (ocrOptions.profile !== 'guji_print_vertical') return []
  const reference = await loadFeijiangOcrReference(pdfPath)
  if (!reference) return []
  const rows = hydratePagePayloadRows(queryAll<OcrPageRow>(
    `SELECT *
     FROM pages
     WHERE doc_id = ?
     ORDER BY page_num`,
    [docId],
  ))
  if (rows.length === 0) return []
  const maxPageNum = Math.max(0, ...rows.map((page) => Number(page.page_num || 0)).filter(Number.isFinite))
  if (reference.pages.length < maxPageNum) return []
  const results: OcrPageResult[] = []
  for (const page of rows) {
    throwIfOcrCanceled(signal)
    const recovered = await recoverGujiPageFromFeijiangReference(page, reference, ocrOptions, signal)
    if (recovered) results.push(recovered)
    if (results.length % OCR_RESULT_POSTPROCESS_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }
  return results
}

async function postProcessPdfOcrResultsBatched(
  pages: Array<{ page: OcrPageRow; sourcePageIndex: number; resultIndex: number }>,
  rawResults: unknown[],
  ocrOptions: Required<PageOcrOptions>,
  signal?: AbortSignal,
  getMissingResultError?: (item: { sourcePageIndex: number; resultIndex: number }) => string,
  pdfPath?: string | null,
): Promise<OcrPageResult[]> {
  const pageResults: OcrPageResult[] = []
  const fallbackPdfPath = pdfPath || resolveFallbackPdfPathForPostProcess(pages)
  const postProcessOptions = getAsyncPdfPostProcessOptions(ocrOptions)
  const feijiangReference = ocrOptions.profile === 'guji_print_vertical'
    ? await loadFeijiangOcrReference(fallbackPdfPath)
    : null
  for (let index = 0; index < pages.length; index += OCR_RESULT_POSTPROCESS_CHUNK_SIZE) {
    const batch = pages.slice(index, index + OCR_RESULT_POSTPROCESS_CHUNK_SIZE)
    const batchResults = await Promise.all(batch.map(async (item) => {
      throwIfOcrCanceled(signal)
      const rawResult = rawResults[item.resultIndex]
      const result = rawResult
        ? await postProcessRecognizedPageResult(rawResult, item.page.image_path, postProcessOptions, {
          signal,
          preserveServiceCoordinates: true,
          serviceCoordinateFallbackSize: getPageImageSize(item.page.image_path),
        })
        : null
      if (!result) {
        const recovered = await recoverGujiPageFromFeijiangReference(item.page, feijiangReference, ocrOptions, signal)
        if (recovered) return recovered
        const missingResultError = getMissingResultError?.(item) || `PaddleOCR async result missing for page ${item.sourcePageIndex + 1}`
        return {
          pageId: item.page.id,
          result: null,
          text: '',
          status: 'error',
          error: ocrOptions.profile === 'guji_print_vertical'
            ? formatAsyncPdfRetryableQualityIssue(missingResultError)
            : missingResultError,
        } satisfies OcrPageResult
      }
      if (ocrOptions.profile === 'guji_print_vertical') {
        const qualityIssue = getGujiAsyncPdfRetryableQualityIssue(result, item.page.image_path, ocrOptions)
        if (qualityIssue) {
          const recovered = await recoverGujiPageFromFeijiangReference(item.page, feijiangReference, ocrOptions, signal)
          if (recovered) return recovered
          const pageImageRecovered = await recoverGujiAsyncPdfQualityIssueWithPageImage(item.page, fallbackPdfPath, ocrOptions, signal)
          if (pageImageRecovered) return pageImageRecovered
          return {
            pageId: item.page.id,
            result: null,
            text: '',
            status: 'error',
            error: qualityIssue,
          } satisfies OcrPageResult
        }
        const referencePayload = feijiangReference
          ? getFeijiangReferencePagePayload(feijiangReference, Number(item.page.page_num || item.sourcePageIndex + 1))
          : null
        const referenceMismatchIssue = referencePayload
          ? getGujiFeijiangReferenceMismatchIssue(result, referencePayload)
          : null
        if (referenceMismatchIssue) {
          const recovered = await recoverGujiPageFromFeijiangReference(item.page, feijiangReference, ocrOptions, signal)
          if (recovered) return recovered
          return {
            pageId: item.page.id,
            result: null,
            text: '',
            status: 'error',
            error: formatAsyncPdfRetryableQualityIssue(referenceMismatchIssue),
          } satisfies OcrPageResult
        }
        const asyncPdfResult = isJsonRecord(result)
          ? {
            ...result,
            gujismart_async_pdf_result: true,
          }
          : result
        return {
          pageId: item.page.id,
          result: asyncPdfResult,
          text: getOcrResultText(asyncPdfResult),
          status: 'completed',
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

async function recognizeSinglePageWithResolvedOptions(
  page: OcrPageWithImage,
  resolvedOptions: Required<PageOcrOptions>,
  signal?: AbortSignal,
): Promise<OcrRecognizeResult> {
  throwIfOcrCanceled(signal)
  const rotatedImagePath = resolvedOptions.imageRotation === 90
    ? await writeTemporaryRotatedOcrImage(page)
    : null
  const recognitionImagePath = rotatedImagePath || page.image_path
  try {
    const uploadImage = await prepareImageForOcrUpload(recognitionImagePath)
    throwIfOcrCanceled(signal)
    const base64Image = uploadImage.buffer.toString('base64')
    const initialResult = resolvedOptions.profile === 'guji_print_vertical'
      ? await recognizeTraditional(base64Image, { signal })
      : await recognizeImage(base64Image, { signal })
    const processed = await postProcessRecognizedPageResult(initialResult, recognitionImagePath, resolvedOptions, { signal, uploadImage })
    if (!rotatedImagePath) return processed
    const sourceSize = getPageImageSize(page.image_path)
    return sourceSize
      ? mapClockwiseOcrResultToSourcePage(processed, sourceSize.width, sourceSize.height)
      : processed
  } finally {
    if (rotatedImagePath) await rm(rotatedImagePath, { force: true }).catch(() => undefined)
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getSplitPageCropSpecs(imagePath?: string | null): PageImageCropSpec[] {
  const size = getPageImageSize(imagePath)
  if (!size || size.width < 900 || size.width < size.height * 1.05) return []
  const centerX = Math.round(size.width / 2)
  const overlap = clampNumber(Math.round(size.width * 0.025), 16, Math.max(16, Math.round(size.width * 0.08)))
  const rightX = clampNumber(centerX - overlap, 0, Math.max(0, size.width - 1))
  const leftWidth = clampNumber(centerX + overlap, 1, size.width)
  const rightWidth = clampNumber(size.width - rightX, 1, size.width)
  return [
    { id: 'right', x: rightX, y: 0, width: rightWidth, height: size.height, readingOrder: 0 },
    { id: 'left', x: 0, y: 0, width: leftWidth, height: size.height, readingOrder: 1 },
  ]
}

function getSplitPageCropSpecSets(imagePath?: string | null): PageImageCropSpec[][] {
  const size = getPageImageSize(imagePath)
  const halves = getSplitPageCropSpecs(imagePath)
  if (!size || halves.length < 2) return halves.length > 0 ? [halves] : []
  const centerY = Math.round(size.height / 2)
  const verticalOverlap = clampNumber(Math.round(size.height * 0.025), 16, Math.max(16, Math.round(size.height * 0.08)))
  const topHeight = clampNumber(centerY + verticalOverlap, 1, size.height)
  const bottomY = clampNumber(centerY - verticalOverlap, 0, Math.max(0, size.height - 1))
  const bottomHeight = clampNumber(size.height - bottomY, 1, size.height)
  const right = halves.find((item) => item.id === 'right') || halves[0]
  const left = halves.find((item) => item.id === 'left') || halves[1]
  const quadrants: PageImageCropSpec[] = [
    { id: 'right-top', x: right.x, y: 0, width: right.width, height: topHeight, readingOrder: 0 },
    { id: 'right-bottom', x: right.x, y: bottomY, width: right.width, height: bottomHeight, readingOrder: 1 },
    { id: 'left-top', x: left.x, y: 0, width: left.width, height: topHeight, readingOrder: 2 },
    { id: 'left-bottom', x: left.x, y: bottomY, width: left.width, height: bottomHeight, readingOrder: 3 },
  ]
  return [halves, quadrants]
}

async function writeTemporaryOcrCropImage(page: OcrPageWithImage, spec: PageImageCropSpec): Promise<string> {
  const source = nativeImage.createFromPath(page.image_path)
  if (source.isEmpty()) throw new Error('无法读取页图，不能执行半页 OCR 兜底。')
  const cropped = source.crop({
    x: spec.x,
    y: spec.y,
    width: spec.width,
    height: spec.height,
  })
  const jpeg = cropped.toJPEG(86)
  if (jpeg.length <= 0) throw new Error('半页 OCR 兜底切图失败。')
  const storageDir = join(getDataDir(), 'storage', page.doc_id, 'ocr-fallback')
  if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true })
  const pageNum = Math.max(1, Math.round(Number(page.page_num || 1)))
  const destPath = join(storageDir, `page_${pageNum}_${spec.id}_${nanoid(8)}.jpg`)
  await writeFile(destPath, jpeg)
  return destPath
}

async function writeTemporaryRotatedOcrImage(page: OcrPageWithImage): Promise<string> {
  const canvasModule = await loadCanvas()
  const source = await canvasModule.loadImage(page.image_path)
  const sourceWidth = Math.max(1, Math.round(Number(source.width || 0)))
  const sourceHeight = Math.max(1, Math.round(Number(source.height || 0)))
  if (sourceWidth <= 1 || sourceHeight <= 1) throw new Error('无法读取当前页图，不能执行横向 OCR。')
  const canvas = canvasModule.createCanvas(sourceHeight, sourceWidth)
  const context = canvas.getContext('2d')
  context.translate(sourceHeight, 0)
  context.rotate(Math.PI / 2)
  context.drawImage(source, 0, 0)
  const jpeg = canvas.toBuffer('image/jpeg', 88)
  if (jpeg.length <= 0) throw new Error('横向 OCR 页图旋转失败。')
  const storageDir = join(getDataDir(), 'storage', page.doc_id, 'ocr-fallback')
  if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true })
  const pageNum = Math.max(1, Math.round(Number(page.page_num || 1)))
  const destPath = join(storageDir, `page_${pageNum}_clockwise_${nanoid(8)}.jpg`)
  await writeFile(destPath, jpeg)
  return destPath
}

function shiftOcrCoordinateValue(value: unknown, offsetX: number, offsetY: number): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
      return value.map((item, index) => Number(item) + (index % 2 === 0 ? offsetX : offsetY))
    }
    return value.map((item) => shiftOcrCoordinateValue(item, offsetX, offsetY))
  }
  if (!isJsonRecord(value)) return value
  const next: JsonRecord = { ...value }
  for (const key of ['x', 'left', 'right']) {
    if (typeof next[key] === 'number' && Number.isFinite(next[key])) {
      next[key] = Number(next[key]) + offsetX
    }
  }
  for (const key of ['y', 'top', 'bottom']) {
    if (typeof next[key] === 'number' && Number.isFinite(next[key])) {
      next[key] = Number(next[key]) + offsetY
    }
  }
  return next
}

function shiftOcrItemCoordinates(item: JsonRecord, spec: PageImageCropSpec, readingOrder: number): JsonRecord {
  const next: JsonRecord = {
    ...item,
    reading_order: readingOrder,
  }
  if (typeof next.block_order === 'number') next.block_order = readingOrder + 1
  if (typeof next.source_reading_order === 'number') next.source_reading_order = readingOrder + 1
  for (const key of ['location', 'bbox', 'block_bbox', 'box', 'coordinate', 'points', 'text_region', 'mask_polygon']) {
    if (next[key] !== undefined) {
      next[key] = shiftOcrCoordinateValue(next[key], spec.x, spec.y)
    }
  }
  delete next.normalized_location
  delete next.ir_block_id
  return next
}

function downgradeSplitFallbackTableBlock(item: JsonRecord): { block: JsonRecord; downgraded: boolean } {
  if (!/table|sheet|excel/.test(getOcrBlockLabel(item))) {
    return { block: item, downgraded: false }
  }
  const text = getOcrBlockTableText(item) || getOcrBlockTextValue(item)
  return {
    block: {
      ...item,
      words: text,
      raw_words: getTextFromUnknown(item.raw_words) || text,
      label: 'text',
      block_label: 'text',
      type: 'text',
      rows: undefined,
      table_rows: undefined,
      tableRows: undefined,
      cells: undefined,
      table_cells: undefined,
      tableCells: undefined,
      html: undefined,
      table_html: undefined,
      tableHtml: undefined,
      markdown: undefined,
      split_fallback_table_downgraded: true,
    },
    downgraded: true,
  }
}

function getResultRecordArray(result: OcrPageResultPayload, key: 'layout_result' | 'words_result'): JsonRecord[] {
  const value = result[key]
  return Array.isArray(value) ? value.filter(isJsonRecord) : []
}

function mergeSplitPageOcrResults(
  page: OcrPageWithImage,
  parts: Array<{ spec: PageImageCropSpec; result: OcrPageResultPayload; text: string }>,
  ocrOptions: Required<PageOcrOptions>,
  reason: string,
): OcrPageResultPayload {
  const orderedParts = [...parts].sort((a, b) => a.spec.readingOrder - b.spec.readingOrder)
  const layoutBlocks: JsonRecord[] = []
  const wordBlocks: JsonRecord[] = []
  let layoutOrder = 0
  let wordOrder = 0
  let downgradedTableCount = 0

  for (const part of orderedParts) {
    for (const block of getResultRecordArray(part.result, 'layout_result')) {
      const shifted = shiftOcrItemCoordinates(block, part.spec, layoutOrder)
      const downgraded = downgradeSplitFallbackTableBlock(shifted)
      if (downgraded.downgraded) downgradedTableCount += 1
      layoutBlocks.push(downgraded.block)
      layoutOrder += 1
    }
    for (const word of getResultRecordArray(part.result, 'words_result')) {
      const shifted = shiftOcrItemCoordinates(word, part.spec, wordOrder)
      const downgraded = downgradeSplitFallbackTableBlock(shifted)
      if (downgraded.downgraded) downgradedTableCount += 1
      wordBlocks.push(downgraded.block)
      wordOrder += 1
    }
  }

  const pageSize = getPageImageSize(page.image_path)
  const text = orderedParts.map((part) => part.text).filter(Boolean).join('\n')
  const markdown = orderedParts
    .map((part) => getTextFromUnknown(isJsonRecord(part.result) ? part.result.markdown : ''))
    .filter(Boolean)
    .join('\n\n')
  const base = orderedParts[0]?.result || {}
  const baseMeta = isJsonRecord(base.guji_processing) ? base.guji_processing : {}
  const merged: OcrPageResultPayload = {
    ...base,
    source_type: 'page_image_split_fallback',
    markdown: markdown || text,
    text,
    layout_result: layoutBlocks,
    words_result: wordBlocks.length > 0
      ? wordBlocks
      : layoutBlocks.map((block) => ({ words: getOcrBlockTextValue(block), location: block.location })),
    guji_processing: {
      ...baseMeta,
      profile: ocrOptions.profile,
      second_pass: ocrOptions.secondPass,
      split_page_image_fallback: true,
      split_page_image_reason: reason,
      split_page_image_parts: orderedParts.map((part) => ({
        id: part.spec.id,
        x: part.spec.x,
        y: part.spec.y,
        width: part.spec.width,
        height: part.spec.height,
      })),
      split_page_image_downgraded_tables: downgradedTableCount,
      source_image_width: pageSize?.width,
      source_image_height: pageSize?.height,
      updated_at: new Date().toISOString(),
    },
  }
  delete merged.gujismart_ir
  delete merged.ir_text
  return merged
}

async function recognizeSplitPageImageFallback(
  page: OcrPageWithImage,
  ocrOptions: Required<PageOcrOptions>,
  signal: AbortSignal | undefined,
  reason: string,
): Promise<OcrPageResultPayload | null> {
  if (ocrOptions.profile !== 'guji_print_vertical') return null
  const specSets = getSplitPageCropSpecSets(page.image_path)
  if (specSets.length === 0) return null

  for (const specs of specSets) {
    const parts: Array<{ spec: PageImageCropSpec; result: OcrPageResultPayload; text: string }> = []
    let setFailed = false
    for (const spec of [...specs].sort((a, b) => a.readingOrder - b.readingOrder)) {
      throwIfOcrCanceled(signal)
      const cropPath = await writeTemporaryOcrCropImage(page, spec)
      try {
        const cropPage: OcrPageWithImage = { ...page, image_path: cropPath }
        const result = sanitizeGujiNonBookHallucinations(
          await recognizeSinglePageWithResolvedOptions(cropPage, ocrOptions, signal),
          ocrOptions,
          cropPath,
        )
        const hardIssue = getRiskyPageImageNonTableHardIssue(result, cropPath, ocrOptions)
        const text = getOcrResultText(result)
        if (hardIssue || text.replace(/\s+/g, '').length < 4) {
          setFailed = true
          break
        }
        parts.push({ spec, result, text })
      } catch (error) {
        if (isOcrAbortError(error)) throw error
        setFailed = true
        break
      } finally {
        await rm(cropPath, { force: true }).catch(() => undefined)
      }
    }

    if (setFailed) continue
    const totalTextLength = parts.map((part) => part.text).join('').replace(/\s+/g, '').length
    if (totalTextLength < 20) continue
    const merged = sanitizeGujiNonBookHallucinations(
      mergeSplitPageOcrResults(page, parts, ocrOptions, reason),
      ocrOptions,
      page.image_path,
    )
    const repeatedIssue = findLikelyRunawayRepeatedOcrText(merged)
    if (repeatedIssue) continue
    if (getRiskyPageImageNonTableHardIssue(merged, page.image_path, ocrOptions)) continue
    return merged
  }
  return null
}

async function recognizeSinglePage(
  page: OcrPageWithImage,
  doc: Pick<OcrDocumentRow, 'doc_type'>,
  options?: PageOcrOptions,
  signal?: AbortSignal,
): Promise<OcrRecognizeResult> {
  throwIfOcrCanceled(signal)
  const resolvedOptions = resolveDocOcrOptions(doc.doc_type, options)
  const result = await recognizeSinglePageWithResolvedOptions(page, resolvedOptions, signal)
  const hardIssue = getRiskyPageImageHardIssue(result, page.image_path, resolvedOptions)
  if (!hardIssue) return result
  throwIfOcrCanceled(signal)
  const splitFallback = await recognizeSplitPageImageFallback(page, resolvedOptions, signal, hardIssue)
  if (splitFallback) return splitFallback
  throw new Error(hardIssue)
}

function getAutomaticSinglePageRetryOptions(
  doc: Pick<OcrDocumentRow, 'title' | 'author' | 'source' | 'doc_type' | 'metadata'>,
  page: Pick<OcrPageRow, 'image_path'>,
): Required<PageOcrOptions> {
  const baseOptions = resolveDocOcrOptions(doc.doc_type)
  const pageSize = getPageImageSize(page.image_path)
  const facsimilePageShape = pageSize
    ? pageSize.width >= pageSize.height * 1.08 || pageSize.height >= pageSize.width * 1.18
    : false
  if (
    baseOptions.profile === 'guji_print_vertical'
    || hasOldBookRouteHints(doc)
    || facsimilePageShape
  ) {
    return getVerticalFallbackOcrOptions(baseOptions)
  }
  return baseOptions
}

function getIncompletePagesForSinglePageRetry(docId: string, excludedPageIds: Set<string> = new Set()): OcrPageRow[] {
  const excludedIds = [...excludedPageIds].map((pageId) => String(pageId || '').trim()).filter(Boolean)
  const exclusionClause = excludedIds.length > 0
    ? `AND id NOT IN (${excludedIds.map(() => '?').join(', ')})`
    : ''
  return hydratePagePayloadRows(queryAll<OcrPageRow>(
    `SELECT *
     FROM pages
     WHERE doc_id = ?
       ${exclusionClause}
       AND (
          ocr_status = 'error'
          OR ocr_status IS NULL
         OR ocr_status IN ('pending', 'queued', 'processing')
         OR (
           ocr_status = 'completed'
           AND NOT (${completedPageContentPredicate('pages')})
         )
        )
      ORDER BY page_num
      LIMIT ?`,
    [docId, ...excludedIds, OCR_AUTO_FAILED_PAGE_RETRY_LIMIT],
  ))
}

function getAutomaticRetryFallbackPageCount(
  doc: Pick<OcrDocumentRow, 'metadata'>,
  pages: Array<Pick<OcrPageRow, 'page_num'>>,
): number {
  const metadata = parseMetadata(doc.metadata)
  const metadataPageCount = Math.max(
    Number(metadata.pdf_page_count || 0),
    Number(metadata.page_count || 0),
  )
  const maxPageNum = Math.max(0, ...pages
    .map((page) => Number(page.page_num || 0))
    .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0))
  return Math.max(
    Number.isFinite(metadataPageCount) ? Math.floor(metadataPageCount) : 0,
    maxPageNum,
  )
}

function getOriginalPdfRetryPageRangeTargetNums(
  pageNums: number[],
  fallbackPageCount: number,
  pageRangeChunkSize?: number,
): number[] {
  const normalizedPageNums = [...new Set(pageNums
    .map((pageNum) => Math.floor(Number(pageNum)))
    .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0))]
    .sort((left, right) => left - right)
  const chunkSize = Math.floor(Number(pageRangeChunkSize || 0))
  if (chunkSize <= 1) return normalizedPageNums
  const maxPageNum = Math.max(
    Math.floor(Number(fallbackPageCount || 0)),
    ...normalizedPageNums,
  )
  const expanded = new Set<number>()
  normalizedPageNums.forEach((pageNum) => {
    const start = Math.floor((pageNum - 1) / chunkSize) * chunkSize + 1
    const end = Math.min(maxPageNum, start + chunkSize - 1)
    for (let current = start; current <= end; current += 1) {
      expanded.add(current)
    }
  })
  return [...expanded].sort((left, right) => left - right)
}

interface OriginalPdfRetryStrategy {
  targetPageNums: number[]
  pageRangeChunkSize?: number
  requireFullFileUpload?: boolean
}

function getOriginalPdfRetryStrategies(
  targetPageNums: number[],
  fallbackPageCount: number,
  pageRangeChunkSize?: number,
  gujiProfile = false,
): OriginalPdfRetryStrategy[] {
  const normalizedTargetPageNums = [...new Set(targetPageNums
    .map((pageNum) => Math.floor(Number(pageNum)))
    .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0))]
    .sort((left, right) => left - right)
  if (!gujiProfile) {
    return [{
      targetPageNums: normalizedTargetPageNums,
      pageRangeChunkSize: pageRangeChunkSize || OCR_ORIGINAL_PDF_RETRY_PAGE_RANGE_CHUNK_SIZE,
    }]
  }
  return [
    {
      targetPageNums: getOriginalPdfRetryPageRangeTargetNums(normalizedTargetPageNums, fallbackPageCount, pageRangeChunkSize),
      pageRangeChunkSize,
    },
    {
      targetPageNums: normalizedTargetPageNums,
    },
    {
      targetPageNums: normalizedTargetPageNums,
      requireFullFileUpload: true,
    },
  ].filter((strategy) => strategy.targetPageNums.length > 0)
}

async function retryIncompletePagesWithOriginalPdfOcr(
  doc: Pick<OcrDocumentRow, 'id' | 'title' | 'author' | 'source' | 'doc_type' | 'metadata'>,
  pdfPath: string | null,
  signal?: AbortSignal,
  onProgress?: (payload: { pageNum?: number; completedPages: number; totalPages: number; error?: string }) => void,
): Promise<OcrPageResult[] | null> {
  if (!pdfPath || !shouldUseAsyncPdfOcr(pdfPath)) return null
  const resultsByPageId = new Map<string, OcrPageResult>()
  const attemptedPageIds = new Set<string>()
  const initialSummary = summarizeDocumentOcrPages(doc.id)
  const totalPages = Math.max(1, initialSummary.failed + initialSummary.pending)
  let completedPages = 0

  while (true) {
    const pages = getIncompletePagesForSinglePageRetry(doc.id, attemptedPageIds)
    if (pages.length === 0) break
    pages.forEach((page) => attemptedPageIds.add(page.id))
    const pageNums = pages
      .map((page) => Number(page.page_num || 0))
      .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0)
    if (pageNums.length === 0) break

    transaction(() => {
      pages.forEach((page) => {
        run(
          `UPDATE pages SET ocr_status = ?,
           proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END
           WHERE id = ?`,
          ['processing', page.id],
        )
      })
    })
    scheduleDatabaseSave()

    const baseRetryOptions = resolveDocOcrOptions(doc.doc_type)
    const retryOptions = baseRetryOptions.profile === 'guji_print_vertical' || hasOldBookRouteHints(doc)
      ? getVerticalFallbackOcrOptions(baseRetryOptions)
      : baseRetryOptions
    const fallbackPageCount = getAutomaticRetryFallbackPageCount(doc, pages)
    const pageRangeChunkSize = retryOptions.profile === 'guji_print_vertical'
      ? OCR_ASYNC_PDF_GUJI_PAGE_RANGE_CHUNK_SIZE
      : undefined
    let remainingPages = pages
    const lastRetryErrorsByPageId = new Map<string, string>()

    const maxAttempts = retryOptions.profile === 'guji_print_vertical' ? OCR_ORIGINAL_PDF_RETRY_ATTEMPTS : 1
    for (let attempt = 1; attempt <= maxAttempts && remainingPages.length > 0; attempt += 1) {
      const targetPageNums = remainingPages
        .map((page) => Number(page.page_num || 0))
        .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0)
      const retryStrategy = getOriginalPdfRetryStrategies(
        targetPageNums,
        fallbackPageCount,
        pageRangeChunkSize,
        retryOptions.profile === 'guji_print_vertical',
      )[Math.min(attempt - 1, maxAttempts - 1)]
      if (!retryStrategy) break
      const resultIndexByPageNum = new Map(retryStrategy.targetPageNums.map((pageNum, index) => [pageNum, index]))
      try {
        const rawResults = await recognizePdfAsync(pdfPath, (payload) => {
          throwIfOcrCanceled(signal)
          const chunkCompleted = Math.min(remainingPages.length, Number(payload.completedPages || 0))
          onProgress?.({
            completedPages: Math.min(totalPages, completedPages + chunkCompleted),
            totalPages,
          })
        }, {
          signal,
          ocrOptions: retryOptions,
          targetPageNums: retryStrategy.targetPageNums,
          fallbackPageCount,
          pageRangeChunkSize: retryStrategy.pageRangeChunkSize,
          requireFullFileUpload: retryStrategy.requireFullFileUpload,
        })
        const pageItems = remainingPages.map((page, index) => {
          const pageNum = Number(page.page_num || index + 1)
          return {
            page,
            sourcePageIndex: pageNum - 1,
            resultIndex: retryStrategy.requireFullFileUpload
              ? pageNum - 1
              : resultIndexByPageNum.get(pageNum) ?? index,
          }
        })
        const pageResults = await postProcessPdfOcrResultsBatched(
          pageItems,
          rawResults,
          retryOptions,
          signal,
          (item) => `PaddleOCR 异步原 PDF 补跑结果页数不足：第 ${item.sourcePageIndex + 1} 页缺少结果。`,
          pdfPath,
        )
        const nextRemainingPages: OcrPageRow[] = []
        pageResults.forEach((pageResult, index) => {
          const page = remainingPages[index]
          const pageNum = Number(page?.page_num || 0) || undefined
          if (pageResult.status === 'error' && (attempt < maxAttempts || retryOptions.profile === 'guji_print_vertical')) {
            if (page) {
              nextRemainingPages.push(page)
              lastRetryErrorsByPageId.set(page.id, pageResult.error || `PaddleOCR async original PDF retry failed for page ${pageNum || '?'}`)
            }
            return
          }
          completedPages += 1
          lastRetryErrorsByPageId.delete(pageResult.pageId)
          resultsByPageId.set(pageResult.pageId, pageResult)
          onProgress?.({
            pageNum,
            completedPages: Math.min(totalPages, completedPages),
            totalPages,
            error: pageResult.status === 'error' ? pageResult.error : undefined,
          })
        })
        remainingPages = nextRemainingPages
      } catch (error) {
        if (isOcrAbortError(error)) throw error
        const message = (error as Error)?.message || String(error || 'OCR failed')
        if (attempt < maxAttempts) continue
        if (retryOptions.profile !== 'guji_print_vertical') {
          remainingPages.forEach((page) => {
            completedPages += 1
            onProgress?.({
              pageNum: Number(page.page_num || 0) || undefined,
              completedPages: Math.min(totalPages, completedPages),
              totalPages,
              error: message,
            })
            resultsByPageId.set(page.id, {
              pageId: page.id,
              result: null,
              text: '',
              status: 'error',
              error: message,
            })
          })
          remainingPages = []
          continue
        }
        remainingPages.forEach((page) => {
          lastRetryErrorsByPageId.set(page.id, message)
        })
      }
    }

    if (remainingPages.length > 0 && retryOptions.profile === 'guji_print_vertical') {
      const recoveredResults = await recoverGujiPagesFromFeijiangReference(remainingPages, pdfPath, retryOptions, signal)
      if (recoveredResults.length > 0) {
        const recoveredPageIds = new Set(recoveredResults.map((item) => item.pageId))
        recoveredResults.forEach((pageResult) => {
          const page = remainingPages.find((item) => item.id === pageResult.pageId)
          completedPages += 1
          resultsByPageId.set(pageResult.pageId, pageResult)
          onProgress?.({
            pageNum: Number(page?.page_num || 0) || undefined,
            completedPages: Math.min(totalPages, completedPages),
            totalPages,
          })
        })
        remainingPages = remainingPages.filter((page) => !recoveredPageIds.has(page.id))
      }
    }

    remainingPages.forEach((page) => {
      const pageNum = Number(page.page_num || 0) || undefined
      const message = formatAsyncPdfRetryableQualityIssue(`PaddleOCR 寮傛鍘?PDF 琛ヨ窇鍚庝粛鏈兘寰楀埌鍙繚瀛樼粨鏋滐細绗?${pageNum || '?'} 椤?`)
      completedPages += 1
      resultsByPageId.set(page.id, {
        pageId: page.id,
        result: null,
        text: '',
        status: 'error',
        error: message,
      })
      onProgress?.({
        pageNum,
        completedPages: Math.min(totalPages, completedPages),
        totalPages,
        error: message,
      })
    })
  }

  return [...resultsByPageId.values()]
}

type FailedPageRetryProgress = {
  pageNum?: number
  completedPages: number
  totalPages: number
  error?: string
  /** Human-readable step for UI (do not hardcode concurrency numbers). */
  message?: string
}

/**
 * After bulk/async OCR, retry pages still incomplete.
 * - Does NOT loop forever: each page is attempted at most once.
 * - skipOriginalPdfRetry: when bulk path already used async PDF, skip a second
 *   full-PDF async job (that is what often freezes UI at “0/1 页”).
 */
async function retryIncompletePagesWithSinglePageOcr(
  doc: Pick<OcrDocumentRow, 'id' | 'title' | 'author' | 'source' | 'doc_type' | 'metadata'>,
  pdfPath: string | null,
  signal?: AbortSignal,
  onProgress?: (payload: FailedPageRetryProgress) => void,
  options?: { skipOriginalPdfRetry?: boolean },
): Promise<OcrPageResult[]> {
  const resultsByPageId = new Map<string, OcrPageResult>()

  // Second full-PDF async pass is expensive and frequently hangs bulk batches.
  // Prefer real single-page image OCR when bulk already used async PDF.
  if (!options?.skipOriginalPdfRetry) {
    onProgress?.({
      completedPages: 0,
      totalPages: 1,
      message: '正在用原 PDF 补跑未完成页…',
    })
    const originalPdfRetryResults = await retryIncompletePagesWithOriginalPdfOcr(doc, pdfPath, signal, onProgress)
    if (originalPdfRetryResults) {
      originalPdfRetryResults.forEach((pageResult) => {
        resultsByPageId.set(pageResult.pageId, pageResult)
      })
      if (originalPdfRetryResults.length > 0 && originalPdfRetryResults.every((pageResult) => pageResult.status === 'completed')) {
        return [...resultsByPageId.values()]
      }
    }
  }

  const attemptedPageIds = new Set(
    [...resultsByPageId.values()]
      .filter((pageResult) => pageResult.status === 'completed')
      .map((pageResult) => pageResult.pageId),
  )
  // One snapshot of incomplete pages only — no while(true) re-scan loop.
  const pages = getIncompletePagesForSinglePageRetry(doc.id, attemptedPageIds)
  const totalPages = Math.max(1, pages.length)
  let completedPages = 0
  if (pages.length === 0) return [...resultsByPageId.values()]

  onProgress?.({
    completedPages: 0,
    totalPages,
    message: `开始单页补跑 ${pages.length} 个未完成页…`,
  })

  for (const originalPage of pages) {
    throwIfOcrCanceled(signal)
    attemptedPageIds.add(originalPage.id)
    const pageNum = typeof originalPage.page_num === 'number' ? originalPage.page_num : undefined
    onProgress?.({
      pageNum,
      completedPages,
      totalPages,
      message: pageNum
        ? `正在单页补跑第 ${pageNum} 页（${completedPages + 1}/${totalPages}）…`
        : `正在单页补跑（${completedPages + 1}/${totalPages}）…`,
    })

    let page = originalPage
    if (!page.image_path || !existsSync(page.image_path)) {
      const fallbackPage = await ensurePageImageForOcrFallback(page, pdfPath, signal)
      if (fallbackPage) page = fallbackPage
    }
    if (!page.image_path || !existsSync(page.image_path)) {
      completedPages += 1
      const error = `第 ${pageNum || '?'} 页缺少可读取页图，无法自动单页补跑 OCR。`
      onProgress?.({
        pageNum,
        completedPages,
        totalPages,
        error,
        message: `单页补跑失败：${error}`,
      })
      resultsByPageId.set(originalPage.id, {
        pageId: originalPage.id,
        result: null,
        text: '',
        status: 'error',
        error,
      })
      continue
    }

    run(
      `UPDATE pages SET ocr_status = ?,
       proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END
       WHERE id = ?`,
      ['processing', originalPage.id],
    )
    scheduleDatabaseSave()

    try {
      const retryOptions = getAutomaticSinglePageRetryOptions(doc, page)
      const result = await recognizeSinglePage(withRequiredImage(page), doc, retryOptions, signal)
      const text = getOcrResultText(result)
      completedPages += 1
      onProgress?.({
        pageNum,
        completedPages,
        totalPages,
        message: pageNum
          ? `已完成第 ${pageNum} 页补跑（${completedPages}/${totalPages}）`
          : `已完成补跑（${completedPages}/${totalPages}）`,
      })
      resultsByPageId.set(originalPage.id, {
        pageId: originalPage.id,
        result,
        text,
        status: 'completed',
      })
    } catch (error) {
      if (isOcrAbortError(error)) throw error
      const message = (error as Error)?.message || String(error || 'OCR failed')
      completedPages += 1
      if (isOcrQualityFailureMessage(message)) {
        const retryOptions = getAutomaticSinglePageRetryOptions(doc, page)
        const recovered = await recoverPageQualityFailureFromFeijiangReference(originalPage, doc, {
          ocrOptions: retryOptions,
          signal,
        })
        if (recovered) {
          onProgress?.({
            pageNum,
            completedPages,
            totalPages,
            message: pageNum ? `第 ${pageNum} 页已从对照结果恢复` : '失败页已从对照结果恢复',
          })
          resultsByPageId.set(originalPage.id, recovered)
          continue
        }
      }
      onProgress?.({
        pageNum,
        completedPages,
        totalPages,
        error: message,
        message: pageNum
          ? `第 ${pageNum} 页补跑仍失败（${completedPages}/${totalPages}），将继续后续文献`
          : `补跑仍失败（${completedPages}/${totalPages}），将继续后续文献`,
      })
      resultsByPageId.set(originalPage.id, {
        pageId: originalPage.id,
        result: null,
        text: '',
        status: 'error',
        error: message,
      })
    }
  }
  return [...resultsByPageId.values()]
}

function getRiskyPageImageRetryOptions(
  primaryOptions: Required<PageOcrOptions>,
  docType?: string | null,
): Required<PageOcrOptions> | null {
  if (primaryOptions.profile === 'guji_print_vertical') return null
  return { ...primaryOptions, profile: 'guji_print_vertical', secondPass: 'local_segmentation' }
}

function getRiskyPageImageResultScore(result: OcrPageResultPayload, imagePath?: string | null): number {
  const blocks = getOcrLayoutBlocks(result)
  const textBlocks = blocks.filter((block) => getOcrBlockTextValue(block).replace(/\s+/g, '').length > 0)
  const totalTextLength = textBlocks
    .map((block) => getOcrBlockTextValue(block))
    .join('')
    .replace(/\s+/g, '')
    .length
  const pageSize = getOcrPageSizeForResult(result, imagePath)
  const pageArea = pageSize ? pageSize.width * pageSize.height : 0
  const verticalBlocks = textBlocks.filter((block) => {
    const orientation = String(block.orientation || '').toLowerCase()
    const label = getOcrBlockLabel(block)
    const rect = getOcrBlockRect(block)
    return orientation === 'vertical'
      || /vertical|column|col_text/.test(label)
      || Boolean(rect && rect.width > 0 && rect.height >= rect.width * 1.28)
  }).length
  const largeBlockPenalty = textBlocks.filter((block) => {
    const rect = getOcrBlockRect(block)
    if (!rect || pageArea <= 0) return false
    const textLength = getOcrBlockTextValue(block).replace(/\s+/g, '').length
    return textLength >= 80 && (rect.width * rect.height) / pageArea >= 0.18
  }).length
  const tablePenalty = textBlocks.filter((block) => /table|sheet|excel/.test(getOcrBlockLabel(block))).length
  return Math.min(40, textBlocks.length)
    + Math.min(30, totalTextLength / 40)
    + verticalBlocks * 1.5
    - largeBlockPenalty * 8
    - tablePenalty * 10
}

function getRiskyPageImagePageOptions(
  page: OcrPageWithImage,
  primaryOptions: Required<PageOcrOptions>,
): Required<PageOcrOptions> {
  if (primaryOptions.profile === 'guji_print_vertical') return primaryOptions
  const pageResult = getPageOcrResultRecord(page)
  if (hasVerticalGujiProcessingMeta(pageResult) || hasVerticalBlockLayoutSignals(pageResult, page.image_path)) {
    return getVerticalFallbackOcrOptions(primaryOptions)
  }
  const imageSize = getPageImageSize(page.image_path)
  if (imageSize && imageSize.width >= imageSize.height * 1.12) {
    return getVerticalFallbackOcrOptions(primaryOptions)
  }
  return primaryOptions
}

function getRiskyPageImageHardIssue(
  result: OcrPageResultPayload,
  imagePath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
): string | null {
  // A table returned from an actual page-image OCR request can be legitimate
  // (especially for sideways statistical tables). The async-PDF detector is
  // only valid for PDF service results and previously rejected genuine tables
  // during "rerun current page".
  return getRiskyPageImageNonTableHardIssue(result, imagePath, ocrOptions)
}

function getRiskyPageImageNonTableHardIssue(
  result: OcrPageResultPayload,
  imagePath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
): string | null {
  const repeatedIssue = findLikelyRunawayRepeatedOcrText(result)
  if (repeatedIssue) return formatSuspiciousRepeatedOcrTextIssue(repeatedIssue)
  const hallucinationIssue = getLikelyGujiNonBookHallucinationIssue(result, imagePath, ocrOptions)
  if (hallucinationIssue) return hallucinationIssue
  return getRiskyPageImageLayoutQualityIssue(result, imagePath, ocrOptions)
}

function formatLayoutQualityRejected(message: string): string {
  return `${OCR_LAYOUT_QUALITY_REJECTED_PREFIX} ${message}`
}

function getGujiCjkKanaRatio(text: string): number {
  const chars = Array.from(String(text || '').replace(/\s+/g, ''))
  if (chars.length === 0) return 0
  const cjkKanaChars = chars.filter((char) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(char)).length
  return cjkKanaChars / chars.length
}

function getAsciiDigitRatio(text: string): number {
  const chars = Array.from(String(text || '').replace(/\s+/g, ''))
  if (chars.length === 0) return 0
  const asciiDigitChars = chars.filter((char) => /[A-Za-z0-9]/.test(char)).length
  return asciiDigitChars / chars.length
}

function hasGujiWebMetadataHallucination(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return false
  const metadataSignals = [
    /\u9875\u7801/.test(compact),
    /\u7f51\u5740/.test(compact),
    /\u53d1\u5e03\u673a\u6784/.test(compact),
    /\u9898\u540d/.test(compact),
    /\u5e8f\u53f7/.test(compact),
  ].filter(Boolean).length
  const governmentTemplate = /\u836f\u54c1\u76d1\u7763|\u56fd\u5bb6\u836f\u54c1|\u4e2d\u534e\u4eba\u6c11\u5171\u548c\u56fd\u836f\u54c1/.test(compact)
  return governmentTemplate || (metadataSignals >= 3 && /[\u4e00-\u9fff]/.test(compact))
}

function hasGujiModernDateHallucination(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return false
  if (/20\d{2}\u5e74\d{1,2}\u6708\d{1,2}\u65e5/.test(compact)) return true
  const modernYearCount = (compact.match(/20\d{2}\u5e74/g) || []).length
  if (modernYearCount >= 2) return true
  const modernMeasureCount = (compact.match(/(?:20\d{2}\u5e74|\d{1,3}\u5206\u4ee5\u4e0b|\d{1,3}\u6642|\d{1,3}\u65f6|\d{1,3}\u00b0)/g) || []).length
  return modernYearCount >= 1 && modernMeasureCount >= 3
}

function hasGujiMachineTokenHallucination(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  if (compact.length < 10) return false
  const hasLongMachineToken = /[A-Z]{2,}[A-Z0-9]{5,}\d{3,}/.test(compact)
    || /\d{3,}[A-Z]{2,}[A-Z0-9]{3,}/.test(compact)
  if (hasLongMachineToken) return true
  if (/(?:OAS|OCR|API|AI)[A-Z0-9]{3,}/i.test(compact) && /\d{3,}/.test(compact)) return true
  return compact.length >= 16
    && getAsciiDigitRatio(compact) >= 0.45
    && getGujiCjkKanaRatio(compact) < 0.45
    && /[A-Z]/i.test(compact)
    && /\d/.test(compact)
}

function hasGujiUnexpectedScriptHallucination(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  if (compact.length < 4) return false
  const unexpectedScriptCount = (compact.match(/[\u0590-\u05ff\u0600-\u06ff\u0e00-\u0e7f\u0400-\u04ff\uac00-\ud7af]/g) || []).length
  if (unexpectedScriptCount === 0) return false
  const cjkKanaCount = (compact.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const unexpectedRatio = unexpectedScriptCount / Math.max(1, compact.length)
  if (cjkKanaCount < 2 || unexpectedRatio < 0.03) return false
  return unexpectedScriptCount >= 4 || (unexpectedScriptCount >= 2 && unexpectedRatio >= 0.08)
}

function hasGujiKanaPunctuationSubstitutionIssue(text: string): boolean {
  const value = String(text || '')
  const compact = value.replace(/\s+/g, '')
  if (compact.length < 120) return false
  const kanaCount = (compact.match(/[\u3040-\u30ff]/g) || []).length
  if (kanaCount < 80) return false
  const inlineMarkerCount = (value.match(/[\u3040-\u30ff\u3400-\u9fff][D=][\u3040-\u30ff\u3400-\u9fff]/g) || []).length
  if (inlineMarkerCount >= 2) return true
  const substitutedSentenceEndCount = (compact.match(/(?:\u30de\u30b7\u30bf|\u30a4\u30de\u30b9|\u30b7\u30bf|\u30c6\u30b9|\u30c7\u30b9|\u30b7\u30e7\u30aa|\u30e8\u30aa)[\u30cb\u30ed]/g) || []).length
  return substitutedSentenceEndCount >= 12
}

function hasGujiVerticalQuestionPhrasePollution(text: string): boolean {
  const value = String(text || '')
  const compact = value.replace(/\s+/g, '')
  if (compact.length < 180) return false
  const questionLineCount = (value.match(/[○〇][^\n]{0,80}(?:か|すか|ですか|ますか|せうか|しょうか)/g) || []).length
  const malformedQuotePhraseCount = (compact.match(/と「(?:いる|ある|する|なる)のは/g) || []).length
  const repeatedBarePhraseCount = (compact.match(/「(?:いる|ある|する|なる)のは/g) || []).length
  if (questionLineCount >= 4 && malformedQuotePhraseCount >= 2 && repeatedBarePhraseCount >= 4) return true

  const phraseCounts = new Map<string, number>()
  const kanaRuns = compact.match(/[\u3040-\u30ffー]{3,6}/g) || []
  kanaRuns.forEach((phrase) => {
    if (!/(?:いる|ある|する|なる|です|ます|せう|しょう|のは)/.test(phrase)) return
    phraseCounts.set(phrase, (phraseCounts.get(phrase) || 0) + 1)
  })
  const repeatedQuestionPhrase = [...phraseCounts.entries()].some(([phrase, count]) => {
    if (count < 6) return false
    const quotedCount = (compact.match(new RegExp(`「${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) || []).length
    return quotedCount >= 3
  })
  return questionLineCount >= 5 && repeatedQuestionPhrase
}

function getLikelyGujiNonBookHallucinationIssue(
  result: OcrPageResultPayload,
  imagePath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
): string | null {
  if (ocrOptions.profile !== 'guji_print_vertical') return null
  const blocks = getOcrLayoutBlocks(result)
  const textBlocks = blocks.filter((block) => getOcrBlockTextValue(block).replace(/\s+/g, '').length > 0)
  if (textBlocks.length === 0) return null
  const totalText = textBlocks.map((block) => getOcrBlockTextValue(block)).join('\n')
  if (hasGujiWebMetadataHallucination(totalText)) {
    return formatLayoutQualityRejected('\u53e4\u7c4d OCR \u8fd4\u56de\u4e86\u7f51\u9875\u5143\u6570\u636e\u6216\u653f\u52a1\u7f51\u7ad9\u5b57\u6bb5\uff0c\u8fd9\u4e9b\u6587\u5b57\u4e0d\u5e94\u5199\u5165\u672c\u9875\u6b63\u6587\uff1b\u5df2\u6539\u7528\u9875\u56fe/\u62c6\u56fe OCR \u515c\u5e95\u3002')
  }
  if (hasGujiModernDateHallucination(totalText)) {
    return formatLayoutQualityRejected('\u53e4\u7c4d OCR \u8fd4\u56de\u4e86\u7591\u4f3c\u73b0\u4ee3\u65e5\u671f/\u6570\u503c\u6a21\u677f\u7684\u6587\u5b57\u5757\uff0c\u8fd9\u4e9b\u6587\u5b57\u4e0d\u5e94\u5199\u5165\u672c\u9875\u6b63\u6587\uff1b\u5df2\u6539\u7528\u9875\u56fe/\u62c6\u56fe OCR \u515c\u5e95\u3002')
  }
  if (hasGujiUnexpectedScriptHallucination(totalText)) {
    return formatLayoutQualityRejected('\u53e4\u7c4d OCR \u8fd4\u56de\u4e86\u7591\u4f3c\u5f02\u79cd\u8bed\u6587\u5b57\u6216\u9519\u8bfb\u5b57\u7b26\uff0c\u8fd9\u4e9b\u6587\u5b57\u4e0d\u5e94\u5199\u5165\u672c\u9875\u6b63\u6587\uff1b\u672c\u9875\u7ed3\u679c\u672a\u6309\u6b63\u5e38 OCR \u4fdd\u5b58\u3002')
  }
  if (hasGujiKanaPunctuationSubstitutionIssue(totalText)) {
    return formatLayoutQualityRejected('\u53e4\u7c4d OCR \u8fd4\u56de\u4e86\u7591\u4f3c\u7247\u5047\u540d\u7ec6\u5b57\u574f\u8bfb\u7ed3\u679c\uff0c\u5b58\u5728\u5927\u91cf\u53e5\u8bfb\u70b9/\u5b57\u7b26\u66ff\u6362\u8bef\u8bfb\uff1b\u672c\u9875\u7ed3\u679c\u672a\u6309\u6b63\u5e38 OCR \u4fdd\u5b58\u3002')
  }
  if (hasGujiVerticalQuestionPhrasePollution(totalText)) {
    return formatLayoutQualityRejected('古籍 OCR 返回了疑似竖排问答坏读结果，短语被反复插入并把原句切碎；本页结果未按正常 OCR 保存。')
  }

  const suspiciousBlocks = textBlocks.filter((block) => {
    const text = getOcrBlockTextValue(block)
    if (!hasGujiMachineTokenHallucination(text) && !hasGujiUnexpectedScriptHallucination(text) && !hasGujiKanaPunctuationSubstitutionIssue(text)) return false
    const rect = getOcrBlockRect(block)
    if (!rect) return true
    const pageSize = getOcrPageSizeForResult(result, imagePath)
    const heightRatio = pageSize ? rect.height / Math.max(1, pageSize.height) : 0
    return heightRatio >= 0.08 || text.replace(/\s+/g, '').length >= 16
  })
  if (suspiciousBlocks.length > 0) {
    return formatLayoutQualityRejected('\u53e4\u7c4d OCR \u8fd4\u56de\u4e86\u7591\u4f3c\u673a\u5668\u7801/\u7f51\u9875\u6b8b\u7247\u7684\u6587\u5b57\u5757\uff0c\u8fd9\u4e9b\u6587\u5b57\u4e0d\u5e94\u5199\u5165\u672c\u9875\u6b63\u6587\uff1b\u5df2\u6539\u7528\u9875\u56fe/\u62c6\u56fe OCR \u515c\u5e95\u3002')
  }
  return null
}

function isOcrImageLikeLabel(label: string): boolean {
  return /^(?:image|figure|picture|chart|diagram|photo|illustration)$/i.test(String(label || ''))
}

function stripOcrMarkupText(value: string): string {
  return stripOcrHtml(String(value || '')).replace(/\s+/g, '')
}

function isEmptyTableMarkupPlaceholder(text: string): boolean {
  const value = String(text || '').trim()
  return /^<table[\s\S]*<\/table>$/i.test(value) && stripOcrMarkupText(value).length === 0
}

function isGujiNonBookHallucinatedBlock(block: JsonRecord): boolean {
  const text = getOcrBlockTextValue(block)
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 4) return false
  if (isEmptyTableMarkupPlaceholder(text)) return true
  return hasGujiWebMetadataHallucination(text)
    || hasGujiModernDateHallucination(text)
    || hasGujiMachineTokenHallucination(text)
    || hasGujiUnexpectedScriptHallucination(text)
    || hasGujiKanaPunctuationSubstitutionIssue(text)
}

function normalizeGujiDuplicateBlockText(text: string): string {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[、。，．,.·・:：;；'"“”‘’「」『』（）()［］\[\]【】]/g, '')
}

function getRectIntersectionArea(
  left: { left: number; top: number; width: number; height: number },
  right: { left: number; top: number; width: number; height: number },
): number {
  const x1 = Math.max(left.left, right.left)
  const y1 = Math.max(left.top, right.top)
  const x2 = Math.min(left.left + left.width, right.left + right.width)
  const y2 = Math.min(left.top + left.height, right.top + right.height)
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

function isGujiHeaderLikeLabel(label: string): boolean {
  return /(?:^|[_\s-])header$|^header$|page_header|running_header/.test(label)
}

function isGujiDuplicateHeaderBlock(block: JsonRecord, allBlocks: JsonRecord[]): boolean {
  const label = getOcrBlockLabel(block)
  if (!isGujiHeaderLikeLabel(label)) return false
  const text = normalizeGujiDuplicateBlockText(getOcrBlockTextValue(block))
  if (text.length < 4) return false
  const rect = getOcrBlockRect(block)
  if (!rect) return false
  const rectArea = Math.max(1, rect.width * rect.height)
  return allBlocks.some((candidate) => {
    if (candidate === block) return false
    if (isGujiHeaderLikeLabel(getOcrBlockLabel(candidate))) return false
    const candidateText = normalizeGujiDuplicateBlockText(getOcrBlockTextValue(candidate))
    if (candidateText !== text) return false
    const candidateRect = getOcrBlockRect(candidate)
    if (!candidateRect) return false
    const candidateArea = Math.max(1, candidateRect.width * candidateRect.height)
    const overlap = getRectIntersectionArea(rect, candidateRect)
    return overlap / Math.min(rectArea, candidateArea) >= 0.72
  })
}

function isGujiPageNumberLikeLabel(label: string): boolean {
  return /^(?:number|page[_\s-]*number|page-no|pageno|folio)$/i.test(label)
}

function normalizeGujiPageMarkerText(text: string): string {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[、。，．,.·・:：;；'"“”‘’「」『』（）()［］\[\]【】]/g, '')
}

function stripGujiPageMarkerLineNoise(text: string): string {
  return text.replace(/[\|\uFF5C\u4E28\u2500-\u257F\u2010-\u2015_\-=＝]+/g, '')
}

function isGujiLineOnlyPageMarkerText(text: string): boolean {
  const compact = normalizeGujiPageMarkerText(text)
  return compact.length > 0 && compact.length <= 12 && stripGujiPageMarkerLineNoise(compact).length === 0
}

function isGujiPageMarkerLikeText(text: string): boolean {
  const compact = normalizeGujiPageMarkerText(text)
  if (!compact || compact.length > 12) return false
  const withoutLineNoise = stripGujiPageMarkerLineNoise(compact)
  if (!withoutLineNoise) return true
  return /^[0-9\uFF10-\uFF19\u3007\u96F6\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341\u767E\u5343\u4E07\u842C\u5EFF\u5344\u5345\u534C\u58F9\u8D30\u8CB3\u53C1\u8086\u4F0D\u9678\u67D2\u634C\u7396\u62FE\u4F70\u4EDF]+$/.test(withoutLineNoise)
}

function isGujiNoisyPageMarkerLikeText(text: string): boolean {
  const compact = normalizeGujiPageMarkerText(text)
  if (!compact || compact.length > 10) return false
  const withoutLineNoise = stripGujiPageMarkerLineNoise(compact)
  if (isGujiPageMarkerLikeText(withoutLineNoise)) return true
  const match = /^([0-9\uFF10-\uFF19\u3007\u96F6\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341\u767E\u5343\u4E07\u842C\u5EFF\u5344\u5345\u534C]+)([\u3040-\u30ff\u3400-\u9fff]{1,4})$/.exec(withoutLineNoise)
  if (!match) return false
  const numeric = match[1]
  const numericLooksLikePage = numeric.length >= 2 || /[\u5341\u767E\u5343\u4E07\u842C]/.test(numeric)
  return numericLooksLikePage
}

function isGujiPageEdgeMarkerBlock(
  block: JsonRecord,
  pageSize: { width: number; height: number } | null,
): boolean {
  const label = getOcrBlockLabel(block)
  const pageNumberLabel = isGujiPageNumberLikeLabel(label)
  const text = getOcrBlockTextValue(block)
  if (!pageNumberLabel && !isGujiNoisyPageMarkerLikeText(text)) return false
  if (pageNumberLabel && !isGujiPageMarkerLikeText(text) && !isGujiNoisyPageMarkerLikeText(text)) return false
  if (isGujiLineOnlyPageMarkerText(text)) return true
  const rect = getOcrBlockRect(block)
  if (!rect || !pageSize) return true
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const horizontalMargin = Math.max(64, pageSize.width * (pageNumberLabel ? 0.2 : 0.17))
  const verticalMargin = Math.max(48, pageSize.height * (pageNumberLabel ? 0.14 : 0.11))
  return centerX <= horizontalMargin
    || centerX >= pageSize.width - horizontalMargin
    || centerY <= verticalMargin
    || centerY >= pageSize.height - verticalMargin
}

function isGujiTinyNoiseBlock(block: JsonRecord): boolean {
  const label = getOcrBlockLabel(block)
  if (isOcrImageLikeLabel(label) || /table|sheet|excel/.test(label)) return false
  const text = getOcrBlockTextValue(block).trim()
  if (!text) return false
  const rect = getOcrBlockRect(block)
  if (!rect) return false
  const width = Number(rect.width || 0)
  const height = Number(rect.height || 0)
  if (width <= 0 || height <= 0) return true
  const minSide = Math.min(width, height)
  const maxSide = Math.max(width, height)
  if (minSide <= 2 && maxSide >= 20) return true
  const compact = text.replace(/\s+/g, '')
  const hasCjkOrKana = /[\u3040-\u30ff\u3400-\u9fff]/.test(compact)
  return minSide < 8 && compact.length <= 3 && !hasCjkOrKana
}

function getReadableGujiBlockText(block: JsonRecord): string {
  const label = getOcrBlockLabel(block)
  const text = getOcrBlockTextValue(block).trim()
  if (!text) return ''
  if (isOcrImageLikeLabel(label) && /^image$/i.test(text)) return ''
  if (isEmptyTableMarkupPlaceholder(text)) return ''
  const compact = text.replace(/\s+/g, '')
  if (isGujiPageNumberLikeLabel(label) && isGujiPageMarkerLikeText(compact)) return ''
  return text
}

function hasGujiMarkdownImageContent(markdown: unknown): boolean {
  const markdownText = getMarkdownTextFromUnknown(markdown)
  if (/<img\b/i.test(markdownText) || /!\[[^\]]*\]\([^)]+\)/.test(markdownText)) return true
  if (!isJsonRecord(markdown)) return false
  const images = markdown.images
  return isJsonRecord(images) && Object.keys(images).length > 0
}

function getRebuiltGujiMarkdownValue(result: OcrPageResultPayload, text: string): unknown {
  return hasGujiMarkdownImageContent(result.markdown)
    ? result.markdown
    : text || getMarkdownTextFromUnknown(result.markdown)
}

function rebuildGujiResultTextFromLayout(result: OcrPageResultPayload, blocks: JsonRecord[]): OcrPageResultPayload {
  const text = blocks.map(getReadableGujiBlockText).filter(Boolean).join('\n')
  return {
    ...result,
    text,
    markdown: getRebuiltGujiMarkdownValue(result, text),
    layout_result: blocks,
    words_result: blocks
      .filter((block) => !isOcrImageLikeLabel(getOcrBlockLabel(block)))
      .map((block) => ({
        words: getReadableGujiBlockText(block),
        location: block.location,
        orientation: block.orientation,
        label: block.label,
      }))
      .filter((word) => String(word.words || '').trim()),
  }
}

function sanitizeGujiNonBookHallucinations(
  result: OcrPageResultPayload,
  ocrOptions: Required<PageOcrOptions>,
  imagePath?: string | null,
): OcrPageResultPayload {
  if (ocrOptions.profile !== 'guji_print_vertical') return result
  const blocks = getOcrLayoutBlocks(result)
  if (blocks.length === 0) return result
  let removedNonBookBlocks = 0
  let removedDuplicateHeaderBlocks = 0
  let removedPageMarkerBlocks = 0
  let removedTinyNoiseBlocks = 0
  const pageSize = getOcrPageSizeForResult(result, imagePath)
  const nextBlocks = blocks.filter((block) => {
    if (isGujiNonBookHallucinatedBlock(block)) {
      removedNonBookBlocks += 1
      return false
    }
    if (isGujiDuplicateHeaderBlock(block, blocks)) {
      removedDuplicateHeaderBlocks += 1
      return false
    }
    if (isGujiPageEdgeMarkerBlock(block, pageSize)) {
      removedPageMarkerBlocks += 1
      return false
    }
    if (isGujiTinyNoiseBlock(block)) {
      removedTinyNoiseBlocks += 1
      return false
    }
    return true
  })
  const removedCount = blocks.length - nextBlocks.length
  if (nextBlocks.length === 0) return result
  const nextText = nextBlocks.map(getReadableGujiBlockText).filter(Boolean).join('\n').trim()
  const preferredText = getPreferredGujiServiceText(result)
  const currentText = getTextFromUnknown(result.text).trim() || preferredText
  const placeholderTextChanged = nextText !== currentText
  if (removedCount === 0 && !placeholderTextChanged) return result
  const rebuilt = rebuildGujiResultTextFromLayout({
    ...result,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      ...(removedNonBookBlocks > 0 ? { removed_non_book_hallucination_blocks: removedNonBookBlocks } : {}),
      ...(removedDuplicateHeaderBlocks > 0 ? { removed_duplicate_header_blocks: removedDuplicateHeaderBlocks } : {}),
      ...(removedPageMarkerBlocks > 0 ? { removed_page_marker_blocks: removedPageMarkerBlocks } : {}),
      ...(removedTinyNoiseBlocks > 0 ? { removed_tiny_noise_blocks: removedTinyNoiseBlocks } : {}),
      ...(placeholderTextChanged ? { rebuilt_text_without_ocr_placeholders: true } : {}),
    },
  }, nextBlocks)
  return preferredText ? preservePreferredGujiServiceText(rebuilt, preferredText) : rebuilt
}

function hasGujiImageBlockEvidence(item: JsonRecord): boolean {
  if (getOcrBlockRect(item)) return true
  const imagePath = String(getRecordFirstValue(item, ['image_asset_path', 'asset_path', 'image_path', 'crop_path', 'src']) || '').trim()
  return Boolean(imagePath)
}

function isGujiPlaceholderWord(item: unknown): boolean {
  if (!isJsonRecord(item)) return false
  const label = getOcrBlockLabel(item)
  const text = getOcrBlockTextValue(item)
  if (isOcrImageLikeLabel(label) && /^image$/i.test(text.trim())) return !hasGujiImageBlockEvidence(item)
  return isEmptyTableMarkupPlaceholder(text)
}

function filterGujiPlaceholderBlocks<T>(items: T[] | undefined): T[] | undefined {
  if (!Array.isArray(items)) return items
  return items.filter((item) => !isGujiPlaceholderWord(item))
}

function cleanGujiPlaceholderText(text: string): string {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^image$/i.test(line) && !isEmptyTableMarkupPlaceholder(line))
    .join('\n')
}

function stripGujiStoragePlaceholders(result: OcrRecognizeResult): OcrRecognizeResult {
  const nextLayout = filterGujiPlaceholderBlocks(result.layout_result)
  const nextWords = filterGujiPlaceholderBlocks(result.words_result)
  const nextText = cleanGujiPlaceholderText(getTextFromUnknown(result.text))
  const currentMarkdownText = getMarkdownTextFromUnknown(result.markdown)
  const nextMarkdown = cleanGujiPlaceholderText(currentMarkdownText)
  const layoutChanged = Array.isArray(result.layout_result) && Array.isArray(nextLayout) && nextLayout.length !== result.layout_result.length
  const wordsChanged = Array.isArray(result.words_result) && Array.isArray(nextWords) && nextWords.length !== result.words_result.length
  const textChanged = nextText !== getTextFromUnknown(result.text).trim()
  const markdownChanged = nextMarkdown !== currentMarkdownText.trim()
  if (!layoutChanged && !wordsChanged && !textChanged && !markdownChanged) return result
  const nextMarkdownValue = isJsonRecord(result.markdown)
    ? { ...result.markdown, text: nextMarkdown }
    : nextMarkdown
  return {
    ...result,
    layout_result: nextLayout,
    text: nextText,
    markdown: nextMarkdownValue,
    words_result: nextWords,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      rebuilt_text_without_ocr_placeholders: true,
    },
  }
}

function getGujiOcrOptionsForResult(result: OcrRecognizeResult): Required<PageOcrOptions> | null {
  const meta = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  if (String(meta.profile || '') !== 'guji_print_vertical') return null
  const secondPass = String(meta.second_pass || '')
  return {
    profile: 'guji_print_vertical',
    secondPass: secondPass === 'cloud_column_ocr'
      ? 'cloud_column_ocr'
      : secondPass === 'none'
        ? 'none'
        : 'local_segmentation',
    imageRotation: 0,
  }
}

function isLikelyMergedWideVerticalGujiBlock(
  block: JsonRecord,
  pageSize: { width: number; height: number },
): boolean {
  const text = getOcrBlockTextValue(block)
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 72 || getGujiCjkKanaRatio(compact) < 0.55) return false
  const label = getOcrBlockLabel(block)
  if (/table|sheet|excel|image|figure|picture|chart|diagram|photo|illustration|header|footer|number|folio/.test(label)) return false
  const rect = getOcrBlockRect(block)
  if (!rect) return false
  const orientation = String(block.orientation || '').toLowerCase()
  const verticalSignal = orientation === 'vertical'
    || /vertical|column|col_text/.test(label)
    || rect.height >= rect.width * 0.72
  if (!verticalSignal) return false
  const hardLines = text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, '').trim())
    .filter(Boolean)
  const columnWidthFromLines = hardLines.length > 1 ? rect.width / hardLines.length : rect.width
  const widthThreshold = Math.max(140, pageSize.width * 0.07)
  const tooWideForSingleColumn = rect.width >= widthThreshold
    && rect.width >= Math.max(90, rect.height * 0.26)
  const stillTooWideAfterLineSplit = hardLines.length > 1
    && columnWidthFromLines >= 76
    && compact.length / hardLines.length >= 18
  return tooWideForSingleColumn || stillTooWideAfterLineSplit
}

function getRiskyPageImageLayoutQualityIssue(
  result: OcrPageResultPayload,
  imagePath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
): string | null {
  if (ocrOptions.profile !== 'guji_print_vertical') return null
  const pageSize = getOcrPageSizeForResult(result, imagePath)
  if (!pageSize) return null
  const blocks = getOcrLayoutBlocks(result)
  const textBlocks = blocks.filter((block) => getOcrBlockTextValue(block).replace(/\s+/g, '').length > 0)
  if (textBlocks.length === 0) return null
  const pageArea = Math.max(1, pageSize.width * pageSize.height)
  const outOfBoundsCount = textBlocks.filter((block) => {
    const rect = getOcrBlockRect(block)
    if (!rect) return false
    const right = rect.left + rect.width
    const bottom = rect.top + rect.height
    return rect.left < -pageSize.width * 0.04
      || rect.top < -pageSize.height * 0.04
      || right > pageSize.width * 1.04
      || bottom > pageSize.height * 1.04
  }).length
  if (outOfBoundsCount >= Math.max(2, Math.ceil(textBlocks.length * 0.18))) {
    return formatLayoutQualityRejected('安全页图 OCR 返回的版面坐标明显超出页图范围，本页结果未写入正文；请重新 OCR 本页。')
  }

  const largeHorizontalBlocks = textBlocks.filter((block) => {
    const rect = getOcrBlockRect(block)
    if (!rect) return false
    const textLength = getOcrBlockTextValue(block).replace(/\s+/g, '').length
    const label = getOcrBlockLabel(block)
    const orientation = String(block.orientation || '').toLowerCase()
    const areaRatio = (rect.width * rect.height) / pageArea
    return textLength >= 48
      && orientation !== 'vertical'
      && !/vertical|column|col_text/.test(label)
      && rect.width >= Math.max(160, rect.height * 1.35)
      && areaRatio >= 0.04
  }).length
  const verticalBlocks = textBlocks.filter((block) => {
    const rect = getOcrBlockRect(block)
    const orientation = String(block.orientation || '').toLowerCase()
    const label = getOcrBlockLabel(block)
    return orientation === 'vertical'
      || /vertical|column|col_text/.test(label)
      || Boolean(rect && rect.width > 0 && rect.height >= rect.width * 1.28)
  }).length
  if (largeHorizontalBlocks >= 2 && verticalBlocks / Math.max(1, textBlocks.length) < 0.55) {
    return formatLayoutQualityRejected('安全页图 OCR 仍把竖排页面识别成横排大块，本页结果未写入正文；请重新 OCR 本页。')
  }
  return null
}

function isLikelyUnderSegmentedRiskyPageImageResult(
  result: OcrPageResultPayload,
  imagePath: string | null | undefined,
  ocrOptions: Required<PageOcrOptions>,
): boolean {
  if (ocrOptions.profile !== 'guji_print_vertical') return false
  const blocks = getOcrLayoutBlocks(result)
  const textBlocks = blocks.filter((block) => getOcrBlockTextValue(block).replace(/\s+/g, '').length > 0)
  const totalTextLength = textBlocks
    .map((block) => getOcrBlockTextValue(block))
    .join('')
    .replace(/\s+/g, '')
    .length
  if (totalTextLength < 120 || textBlocks.length === 0) return false

  const pageSize = getOcrPageSizeForResult(result, imagePath)
  const pageArea = pageSize ? pageSize.width * pageSize.height : 0
  const mergedWideVerticalBlocks = pageSize
    ? textBlocks.filter((block) => isLikelyMergedWideVerticalGujiBlock(block, pageSize)).length
    : 0
  const verticalBlocks = textBlocks.filter((block) => {
    const orientation = String(block.orientation || '').toLowerCase()
    const label = getOcrBlockLabel(block)
    const rect = getOcrBlockRect(block)
    return orientation === 'vertical'
      || /vertical|column|col_text/.test(label)
      || Boolean(rect && rect.width > 0 && rect.height >= rect.width * 1.28)
  }).length
  const largeTextBlocks = textBlocks.filter((block) => {
    const rect = getOcrBlockRect(block)
    if (!rect || pageArea <= 0) return false
    const textLength = getOcrBlockTextValue(block).replace(/\s+/g, '').length
    return textLength >= 80 && (rect.width * rect.height) / pageArea >= 0.18
  }).length
  const verticalRatio = verticalBlocks / Math.max(1, textBlocks.length)
  const horizontalDominatedBookPage = textBlocks.length <= 24
    && totalTextLength >= 420
    && verticalRatio < 0.12
    && Boolean(pageSize && pageSize.width >= pageSize.height * 1.05)
  return (textBlocks.length <= 5 && totalTextLength >= 180)
    || (largeTextBlocks > 0 && textBlocks.length <= 8 && verticalRatio < 0.45)
    || mergedWideVerticalBlocks > 0
    || horizontalDominatedBookPage
}

function getUnderSegmentedRiskyPageImageMessage(): string {
  return 'OCR 结果疑似把竖排/双页影印书页切成少量横排大块，本页结果未写入正文；请用“重新 OCR 本页”或切换 OCR 模型后重试。'
}

async function recognizeRiskyPageImageOcrPages(
  pages: OcrPageWithImage[],
  primaryOptions: Required<PageOcrOptions>,
  options: RiskyPageImageOcrRouteOptions = {},
): Promise<OcrPageResult[]> {
  const totalPages = pages.length
  let completedPages = 0

  const reportProgress = (
    page: OcrPageWithImage,
    status: 'completed' | 'error',
    error?: string,
    result?: OcrPageResultPayload | null,
    text?: string,
  ) => {
    completedPages += 1
    options.onProgress?.({
      pageId: page.id,
      pageNum: typeof page.page_num === 'number' ? page.page_num : undefined,
      completedPages,
      totalPages,
      status,
      error,
      result,
      text,
    })
  }

  const pageResults: OcrPageResult[] = []
  for (const page of pages) {
    try {
      throwIfOcrCanceled(options.signal)
      const pageOptions = getRiskyPageImagePageOptions(page, primaryOptions)
      const primaryResult = await recognizeSinglePageWithResolvedOptions(page, pageOptions, options.signal)
      const hardIssue = getRiskyPageImageHardIssue(primaryResult, page.image_path, pageOptions)
      const underSegmented = isLikelyUnderSegmentedRiskyPageImageResult(primaryResult, page.image_path, pageOptions)
      const retryOptions = hardIssue || underSegmented
        ? getRiskyPageImageRetryOptions(pageOptions, options.docType)
        : null

      if (retryOptions) {
        try {
          const retryResult = await recognizeSinglePageWithResolvedOptions(page, retryOptions, options.signal)
          const retryHardIssue = getRiskyPageImageHardIssue(retryResult, page.image_path, retryOptions)
          const primaryScore = getRiskyPageImageResultScore(primaryResult, page.image_path)
          const retryScore = getRiskyPageImageResultScore(retryResult, page.image_path)
          if (!retryHardIssue && (hardIssue || retryScore >= primaryScore + 6)) {
            const retryText = getOcrResultText(retryResult)
            reportProgress(page, 'completed', undefined, retryResult, retryText)
            pageResults.push({
              pageId: page.id,
              result: retryResult,
              text: retryText,
              status: 'completed',
            })
            continue
          }
        } catch (error) {
          if (isOcrAbortError(error)) throw error
        }
      }

      if (hardIssue || underSegmented) {
        const splitReason = hardIssue || getUnderSegmentedRiskyPageImageMessage()
        const splitFallbackResult = await recognizeSplitPageImageFallback(page, pageOptions, options.signal, splitReason)
        if (splitFallbackResult) {
          const splitText = getOcrResultText(splitFallbackResult)
          reportProgress(page, 'completed', undefined, splitFallbackResult, splitText)
          pageResults.push({
            pageId: page.id,
            result: splitFallbackResult,
            text: splitText,
            status: 'completed',
          })
          continue
        }
      }

      if (hardIssue) {
        reportProgress(page, 'error', hardIssue)
        pageResults.push({
          pageId: page.id,
          result: null,
          text: '',
          status: 'error',
          error: hardIssue,
        })
        continue
      }

      if (underSegmented) {
        const message = getUnderSegmentedRiskyPageImageMessage()
        reportProgress(page, 'error', message)
        pageResults.push({
          pageId: page.id,
          result: null,
          text: '',
          status: 'error',
          error: message,
        })
        continue
      }

      const text = getOcrResultText(primaryResult)
      reportProgress(page, 'completed', undefined, primaryResult, text)
      pageResults.push({
        pageId: page.id,
        result: primaryResult,
        text,
        status: 'completed',
      })
    } catch (error) {
      if (isOcrAbortError(error)) throw error
      const message = (error as Error)?.message || String(error || 'OCR failed')
      reportProgress(page, 'error', message)
      pageResults.push({
        pageId: page.id,
        result: null,
        text: '',
        status: 'error',
        error: message,
      })
    }
    await yieldToEventLoop()
  }
  return pageResults
}

async function rerunPageLayoutOnly(
  page: Pick<OcrPageRow, 'ocr_result' | 'ocr_result_ref' | 'image_path'>,
  doc: Pick<OcrDocumentRow, 'doc_type'>,
  options?: PageOcrOptions,
): Promise<OcrRecognizeResult> {
  const hydratedPage = hydratePagePayloadRows([page])[0]
  let currentResult = hydratedPage.ocr_result
  if (typeof currentResult === 'string') {
    currentResult = JSON.parse(currentResult)
  }
  if (!currentResult) {
    throw new Error('当前页面尚无 OCR 结果，无法重做版面切分')
  }
  const resolvedOptions = resolveDocOcrOptions(doc.doc_type, options)
  return postProcessRecognizedPageResult(currentResult, hydratedPage.image_path, {
    ...resolvedOptions,
    secondPass: 'local_segmentation',
  })
}

function getEngineLabel(engine: string): string {
  if (engine === 'vision_model') return '视觉 OCR'
  if (engine === 'hybrid') return '混合 OCR'
  return '飞桨 OCR'
}

function normalizeAvailableOcrEngine(engine: OcrEngine): OcrEngine {
  if (engine === 'local_paddle') return 'paddle'
  return engine === 'hybrid' ? 'paddle' : engine
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

function isServiceCoordinatePreservedResult(result: unknown): boolean {
  if (!isJsonRecord(result)) return false
  const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  return gujiProcessing.ocr_service_coordinates_preserved === true
}

function getStoredOcrIrSize(
  result: unknown,
  imagePath?: string | null,
): { width?: number; height?: number } {
  const imageSize = getPageImageSize(imagePath)
  if (isServiceCoordinatePreservedResult(result)) {
    if (!isJsonRecord(result)) return {}
    const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
    const explicitWidth = getPositiveNumber(result.page_width)
      || getPositiveNumber(result.image_width)
      || getPositiveNumber(result.source_image_width)
      || getPositiveNumber(gujiProcessing.source_image_width)
    const explicitHeight = getPositiveNumber(result.page_height)
      || getPositiveNumber(result.image_height)
      || getPositiveNumber(result.source_image_height)
      || getPositiveNumber(gujiProcessing.source_image_height)
    return {
      width: explicitWidth || imageSize?.width,
      height: explicitHeight || imageSize?.height,
    }
  }
  return {
    width: imageSize?.width,
    height: imageSize?.height,
  }
}

function ensureServiceCoordinatePageSizeForStorage<T extends OcrRecognizeResult>(
  result: T,
  imagePath?: string | null,
): T {
  if (!isServiceCoordinatePreservedResult(result)) return result
  const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  const explicitWidth = getPositiveNumber(result.page_width)
    || getPositiveNumber(result.image_width)
    || getPositiveNumber(result.source_image_width)
    || getPositiveNumber(gujiProcessing.source_image_width)
  const explicitHeight = getPositiveNumber(result.page_height)
    || getPositiveNumber(result.image_height)
    || getPositiveNumber(result.source_image_height)
    || getPositiveNumber(gujiProcessing.source_image_height)
  if (explicitWidth && explicitHeight) return result
  const imageSize = getPageImageSize(imagePath)
  if (!imageSize) return result
  return {
    ...result,
    source_image_width: imageSize.width,
    source_image_height: imageSize.height,
    guji_processing: {
      ...gujiProcessing,
      source_image_width: imageSize.width,
      source_image_height: imageSize.height,
      service_coordinate_size_source: gujiProcessing.service_coordinate_size_source || 'page_image_fallback',
    },
  } as T
}

function normalizeOcrResultForStorage(
  result: unknown,
  page: Pick<OcrSavePageSnapshot, 'page_num' | 'image_path' | 'ocr_result'> | null | undefined,
  engine: OcrEngine,
): { result: OcrRecognizeResult; text: string } {
  const rawFeijiangReferenceText = getRawFeijiangReferenceText(result)
  if (isFeijiangReferenceRecoveredResult(result) && rawFeijiangReferenceText) {
    return {
      result: normalizeFeijiangReferenceTextOnlyResult(result, rawFeijiangReferenceText, page, engine),
      text: rawFeijiangReferenceText,
    }
  }
  const sizeNormalizedResult = isJsonRecord(result)
    ? ensureServiceCoordinatePageSizeForStorage(result as OcrRecognizeResult, page?.image_path)
    : result
  const irSize = getStoredOcrIrSize(sizeNormalizedResult, page?.image_path)
  const normalized = ensureOcrResultIr(sizeNormalizedResult, {
    pageIndex: Number(page?.page_num || 0) || 1,
    pageWidth: irSize.width,
    pageHeight: irSize.height,
    engine,
    generatedAt: getOcrPageIr(page?.ocr_result)?.generatedAt,
    forceRebuild: true,
  })
  const gujiOptions = getGujiOcrOptionsForResult(normalized)
  const preferredGujiText = gujiOptions
    ? getPreferredGujiServiceText(sizeNormalizedResult)
      || getPreferredGujiServiceText(normalized)
      || getUsableGujiAsyncPdfServiceText(sizeNormalizedResult)
      || getUsableGujiAsyncPdfServiceText(normalized)
    : ''
  const storageResultBase = gujiOptions
    ? ensureOcrResultIr(stripGujiStoragePlaceholders(sanitizeGujiNonBookHallucinations(normalized, gujiOptions, page?.image_path)), {
        pageIndex: Number(page?.page_num || 0) || 1,
        pageWidth: irSize.width,
        pageHeight: irSize.height,
        engine,
        generatedAt: getOcrPageIr(page?.ocr_result)?.generatedAt,
        forceRebuild: true,
      })
    : normalized
  const storageResult = gujiOptions && preferredGujiText
    ? preservePreferredGujiServiceText(storageResultBase, preferredGujiText)
    : storageResultBase
  const storageText = gujiOptions && preferredGujiText
    ? preferredGujiText
    : gujiOptions
      ? getOcrResultText(storageResult)
      : storageResult.gujismart_ir
        ? deriveOcrTextFromIr(storageResult.gujismart_ir)
        : getOcrResultText(storageResult)
  return {
    result: storageResult,
    text: storageText,
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

async function reprocessDocumentOcrStructure(docId: string): Promise<string[]> {
  const rawRows = queryAll<DocumentPage>(
    `SELECT *
     FROM pages
     WHERE doc_id = ? AND ocr_status = 'completed'
     ORDER BY page_num`,
    [docId],
  )
  const pagesWithResults: Array<{ page: DocumentPage; result: OcrResultRecord }> = []
  for (let index = 0; index < rawRows.length; index += OCR_DOCUMENT_REPROCESS_CHUNK_SIZE) {
    const rows = hydratePagePayloadRows(rawRows.slice(index, index + OCR_DOCUMENT_REPROCESS_CHUNK_SIZE))
    rows.forEach((page) => {
      const result = parseJsonRecord(page.ocr_result)
      if (result) pagesWithResults.push({ page, result })
    })
    if (index + OCR_DOCUMENT_REPROCESS_CHUNK_SIZE < rawRows.length) await yieldToEventLoop()
  }
  if (pagesWithResults.length === 0) return []

  const generatedAt = new Date().toISOString()
  const structureResults = pagesWithResults.map(({ page, result }) => {
    const rawFeijiangReferenceText = getRawFeijiangReferenceText(result)
    return isFeijiangReferenceRecoveredResult(result) && rawFeijiangReferenceText
      ? preserveRawGujiReferenceText(result as OcrRecognizeResult, rawFeijiangReferenceText, { page, generatedAt })
      : result
  })
  const documentIr = buildOcrDocumentV1(
    structureResults,
    { forceRebuild: true, generatedAt },
  )
  const changedPageIds: string[] = []

  for (let offset = 0; offset < pagesWithResults.length; offset += OCR_DOCUMENT_REPROCESS_CHUNK_SIZE) {
    const batch = pagesWithResults.slice(offset, offset + OCR_DOCUMENT_REPROCESS_CHUNK_SIZE)
    transaction(() => {
      batch.forEach(({ page, result }, batchIndex) => {
        const index = offset + batchIndex
        const irPage = documentIr.pages[index]
        if (!irPage) return
        const sourceResult = structureResults[index] || result
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
        const rawFeijiangReferenceText = getRawFeijiangReferenceText(result)
        const preferredGujiText = isFeijiangReferenceRecoveredResult(result) && rawFeijiangReferenceText
          ? rawFeijiangReferenceText
          : getGujiOcrOptionsForResult(sourceResult)
            ? getPreferredGujiServiceText(sourceResult)
            : ''
        const irText = deriveOcrTextFromIr(envelope)
        const text = preferredGujiText || irText
        const nextResultBase: OcrResultRecord = {
          ...sourceResult,
          text,
          words_result: deriveOcrWordsResultFromIr(envelope),
          gujismart_ir: envelope,
          ir_text: irText,
          normalization: {
            ...(isJsonRecord(result.normalization) ? result.normalization : {}),
            schema_version: OCR_IR_SCHEMA_VERSION,
            pipeline_version: OCR_IR_PIPELINE_VERSION,
            generated_at: generatedAt,
            document_postprocessed: true,
          },
        }
        const nextResult = preferredGujiText
          ? isFeijiangReferenceRecoveredResult(result)
            ? preserveRawGujiReferenceText(nextResultBase, preferredGujiText, { page, generatedAt })
            : preservePreferredGujiServiceText(nextResultBase, preferredGujiText)
          : nextResultBase
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
    if (offset + OCR_DOCUMENT_REPROCESS_CHUNK_SIZE < pagesWithResults.length) await yieldToEventLoop()
  }
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
    `UPDATE pages SET ocr_result = ?, ocr_result_ref = ?, ocr_text = ?, ocr_text_ref = ?, ocr_status = ?,
     proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END
     WHERE id = ?`,
    [preparedResult.value, preparedResult.ref, preparedText.value, preparedText.ref, 'completed', pageId],
  )
  upsertPageOcrVersion(pageId, engine, normalized.result, text, 'completed', page)
  recordCompatibilityOcrArtifacts([{ pageId, engine, result: normalized.result, text }])
  markDocumentTocDirty(page.doc_id)
  try {
    recomputeLiteraturePageMap(page.doc_id)
  } catch (error) {
    console.warn('[OCR] literature page map recompute failed', page.doc_id, error)
  }
}

async function savePageQualityFailureOcrError(
  pageId: string,
  error: unknown,
  fallbackMessage: string,
  engine: OcrEngine = 'paddle',
  options: SavePageQualityFailureOptions = {},
): Promise<QualityFailureOcrSaveResult> {
  const message = (error as Error)?.message || String(error || fallbackMessage)
  if (!isOcrQualityFailureMessage(message)) return 'not_quality_failure'
  const rawPage = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
  const page = rawPage ? hydratePagePayloadRows([rawPage])[0] : null
  const doc = page
    ? queryOne<OcrDocumentRow>('SELECT * FROM documents WHERE id = ?', [page.doc_id])
    : null
  if (page && doc) {
    try {
      const recovered = await recoverPageQualityFailureFromFeijiangReference(page, doc, options)
      if (recovered) {
        savePageOcrResults([recovered], engine)
        return 'recovered'
      }
    } catch (recoveryError) {
      if (isOcrAbortError(recoveryError)) throw recoveryError
      console.warn('[OCR] Failed to recover quality-rejected page from PaddleOCR reference JSON:', page.page_num, recoveryError)
    }
  }
  savePageOcrResults([{
    pageId,
    result: null,
    text: '',
    status: 'error',
    error: message,
  }], engine)
  return 'saved_error'
}

function finishRecoveredPageQualityFailure(
  event: OcrStatusEvent,
  page: Pick<OcrPageRow, 'id' | 'doc_id'>,
): void {
  updateDocumentStatusFromPages(page.doc_id)
  run('UPDATE documents SET metadata_status = ?, updated_at = ? WHERE id = ?', ['pending', new Date().toISOString(), page.doc_id])
  syncDocumentProofStatus(page.doc_id)
  scheduleOcrFinalizeForPages([page.id])
  scheduleDatabaseSave()
  const currentDocStatus = queryOne<{ ocr_status: string }>('SELECT ocr_status FROM documents WHERE id = ?', [page.doc_id])?.ocr_status || 'completed'
  emitOcrStatus(event, { docId: page.doc_id, status: currentDocStatus, progress: 1 })
}

function parseMetadata(value: unknown): JsonRecord {
  if (!value) return {}
  return parseJsonRecord(value) || {}
}

function resolveOcrEngine(doc: Pick<OcrDocumentRow, 'metadata'>, requested?: OcrEngine): OcrEngine {
  if (requested === 'local_paddle' || requested === 'paddle' || requested === 'vision_model' || requested === 'hybrid') return normalizeAvailableOcrEngine(requested)
  const storedEngine = parseMetadata(doc.metadata).ocr_engine
  if (storedEngine === 'local_paddle' || storedEngine === 'paddle' || storedEngine === 'vision_model' || storedEngine === 'hybrid') {
    return normalizeAvailableOcrEngine(storedEngine)
  }
  const configuredEngine = queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', ['ocr_default_engine'])?.value
  if (configuredEngine === 'local_paddle' || configuredEngine === 'paddle' || configuredEngine === 'vision_model' || configuredEngine === 'hybrid') {
    return normalizeAvailableOcrEngine(configuredEngine)
  }
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

function isOcrErrorPlaceholderResult(value: unknown): boolean {
  const text = String(value || '').trim()
  if (!text) return false
  try {
    const parsed = JSON.parse(text)
    if (!isJsonRecord(parsed)) return false
    return Boolean(parsed.error && parsed.failed_at)
  } catch {
    return /"error"\s*:/.test(text) && /"failed_at"\s*:/.test(text)
  }
}

function hasUsablePageOcrContent(page: Pick<OcrPageRow, 'proofed_text' | 'ocr_text' | 'ocr_result' | 'proofed_text_ref' | 'ocr_text_ref' | 'ocr_result_ref'> & { ocr_status?: string | null }): boolean {
  const inlineText = String(page.proofed_text || page.ocr_text || '').trim()
  if (inlineText && inlineText !== '{"externalized":true}') return true
  if (String(page.proofed_text_ref || page.ocr_text_ref || '').trim()) return true
  if (String(page.ocr_status || '') === 'completed' && String(page.ocr_result_ref || '').trim()) return true
  const resultText = String(page.ocr_result || '').trim()
  if (!resultText || resultText === '{"externalized":true}') return false
  return !isOcrErrorPlaceholderResult(resultText)
}

function completedPageContentPredicate(alias = 'pages'): string {
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

function isPageOcrCompleted(page: Pick<OcrPageRow, 'ocr_status' | 'proofed_text' | 'ocr_text' | 'ocr_result' | 'proofed_text_ref' | 'ocr_text_ref' | 'ocr_result_ref'>): boolean {
  return String(page?.ocr_status || '') === 'completed' && hasUsablePageOcrContent(page)
}

function isOcrPageSummaryComplete(stats: { total: number; completed: number; failed: number; pending: number }): boolean {
  return stats.total > 0 && stats.completed === stats.total && stats.failed === 0 && stats.pending === 0
}

function isOcrPageSummarySettled(stats: { total: number; completed: number; failed: number; pending: number }): boolean {
  return stats.total > 0 && stats.pending === 0 && stats.completed + stats.failed >= stats.total
}

function hasOcrReviewPages(stats: { total: number; completed: number; failed: number; pending: number }): boolean {
  return isOcrPageSummarySettled(stats) && !isOcrPageSummaryComplete(stats) && stats.failed > 0
}

/**
 * Turn leftover incomplete pages into settled `error` pages so the document can
 * still complete/入库. Page-level failures must not fail the whole book.
 */
function settleIncompleteOcrPagesAsReviewFailures(docId: string): number {
  const needsWrite = queryAll<{ id: string; page_num: number | null }>(
    `SELECT id, page_num
     FROM pages
     WHERE doc_id = ?
       AND (
          ocr_status IS NULL
          OR ocr_status IN ('pending', 'queued', 'processing')
          OR (
            ocr_status = 'completed'
            AND NOT (${completedPageContentPredicate('pages')})
          )
        )
     ORDER BY page_num`,
    [docId],
  )
  if (needsWrite.length === 0) return 0

  const results: OcrPageResult[] = needsWrite.map((row) => ({
    pageId: row.id,
    result: null,
    text: '',
    status: 'error',
    error: `第 ${row.page_num || '?'} 页 OCR 未成功`,
  }))
  savePageOcrResults(results, 'paddle', { refreshSearch: false, markTocDirty: false })
  return results.length
}

function getCompletedOcrPageCount(pages: OcrPageRow[]): number {
  return pages.filter(isPageOcrCompleted).length
}

function getPagesNeedingOcr(pages: OcrPageRow[], resumeExisting: boolean): OcrPageRow[] {
  if (!resumeExisting) return pages
  return pages.filter((page) => !isPageOcrCompleted(page))
}

function getPagesForOcrAttempt(pages: OcrPageRow[], resumeExisting: boolean, attempt: number): OcrPageRow[] {
  return getPagesNeedingOcr(pages, resumeExisting || attempt > 1)
}

function resetPagesForFullOcrRerun(docId: string): void {
  clearDocumentOcrRoutePreference(docId)
  run(
    `UPDATE pages SET ocr_status = ?,
       proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END
     WHERE doc_id = ?`,
    ['pending', docId],
  )
  const pageIds = queryAll<{ id: string }>('SELECT id FROM pages WHERE doc_id = ?', [docId]).map((page) => page.id)
  clearPageSearchIndexForDocuments([docId])
  markSearchIndexStaleForPages(pageIds)
  scheduleDatabaseSave()
}

function hasIncompleteOcrPages(docId: string): boolean {
  // Keep this cheap for batch enqueue of large queues. Content-predicate scans on
  // every page row freeze the main process before any OCR work starts.
  const stats = queryOne<{ total: number; completed: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN COALESCE(ocr_status, '') = 'completed' THEN 1 ELSE 0 END) as completed
     FROM pages
     WHERE doc_id = ?`,
    [docId],
  )
  const total = Number(stats?.total || 0)
  const completed = Number(stats?.completed || 0)
  return total === 0 || completed < total
}

/** True worker pool: only `concurrency` tasks exist at once, pull next id when free. */
async function runBoundedDocumentWorkers<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length))
  const runners = Array.from({ length: workerCount }, async () => {
    while (!ocrRuntimeShuttingDown) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      await worker(items[index], index)
      // Keep the main event loop free for list/UI IPC between documents.
      await yieldToEventLoop()
    }
  })
  await Promise.all(runners)
}

function summarizeDocumentOcrPages(docId: string): { total: number; completed: number; failed: number; pending: number } {
  const stats = queryOne<{ total: number; completed: number; failed: number; pending: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN ocr_status = 'completed' AND ${completedPageContentPredicate('pages')} THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN ocr_status = 'error' THEN 1 ELSE 0 END) as failed,
       SUM(CASE WHEN ocr_status IS NULL OR ocr_status IN ('pending', 'queued', 'processing') OR (ocr_status = 'completed' AND NOT (${completedPageContentPredicate('pages')})) THEN 1 ELSE 0 END) as pending
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
  return isOcrPageSummaryComplete(stats)
}

function isDocumentOcrSettledFromPages(docId: string): boolean {
  const stats = summarizeDocumentOcrPages(docId)
  return isOcrPageSummaryComplete(stats) || hasOcrReviewPages(stats)
}

function getDocumentTotalPages(docId: string, pageSummary?: { total: number }): number | undefined {
  const doc = queryOne<{ page_count: number | null }>('SELECT page_count FROM documents WHERE id = ?', [docId])
  const totalPages = Number(doc?.page_count || 0) || Number(pageSummary?.total || 0)
  return totalPages > 0 ? totalPages : undefined
}

function emitOcrAlreadyRunningStatus(event: OcrStatusEvent, docId: string): void {
  const stats = summarizeDocumentOcrPages(docId)
  const totalPages = getDocumentTotalPages(docId, stats)
  const completed = isOcrPageSummaryComplete(stats)
  const settledWithReviewPages = hasOcrReviewPages(stats)
  if (completed || settledWithReviewPages) {
    const reviewMessage = settledWithReviewPages ? getDocumentOcrReviewMessage(docId) : undefined
    updateDocumentStatusFromPages(docId, reviewMessage)
    emitOcrStatus(event, {
      docId,
      status: 'completed',
      phase: 'completed',
      progress: 1,
      completedPages: stats.completed,
      totalPages,
      message: settledWithReviewPages ? (reviewMessage || 'OCR完成，部分页面 OCR 未成功') : 'OCR 已完成',
      errorMessage: reviewMessage,
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
  event: OcrStatusEvent,
  docId: string,
  progress = 0,
  totalPages?: number,
): boolean {
  const stats = summarizeDocumentOcrPages(docId)
  const completed = isOcrPageSummaryComplete(stats)
  const settledWithReviewPages = hasOcrReviewPages(stats)
  const settled = completed || settledWithReviewPages
  const reviewMessage = settledWithReviewPages ? getDocumentOcrReviewMessage(docId) : undefined
  const resolvedTotalPages = totalPages || getDocumentTotalPages(docId, stats)
  emitOcrStatus(event, {
    docId,
    status: settled ? 'completed' : 'canceled',
    phase: settled ? 'completed' : 'canceled',
    progress: settled ? 1 : progress,
    completedPages: stats.completed,
    totalPages: resolvedTotalPages,
    message: settledWithReviewPages ? (reviewMessage || 'OCR完成，部分页面 OCR 未成功') : settled ? 'OCR 已完成' : OCR_CANCELED_MESSAGE,
    errorMessage: settledWithReviewPages ? reviewMessage : settled ? undefined : OCR_CANCELED_MESSAGE,
    canceled: !settled,
  })
  return settled
}

/** Compact page list: 3、7-9、12 */
function formatOcrFailedPageNumberList(pageNums: Array<number | null | undefined>): string {
  const nums = [...new Set(
    pageNums
      .map((value) => Number(value || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.floor(value)),
  )].sort((left, right) => left - right)
  if (nums.length === 0) return ''
  const parts: string[] = []
  let rangeStart = nums[0]
  let rangeEnd = nums[0]
  for (let index = 1; index <= nums.length; index += 1) {
    const current = nums[index]
    if (current === rangeEnd + 1) {
      rangeEnd = current
      continue
    }
    parts.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`)
    rangeStart = current
    rangeEnd = current
  }
  return parts.join('、')
}

function listDocumentOcrFailedPageNums(docId: string): number[] {
  const rows = queryAll<{ page_num: number | null }>(
    `SELECT page_num
     FROM pages
     WHERE doc_id = ? AND ocr_status = 'error'
     ORDER BY page_num`,
    [docId],
  )
  return rows
    .map((row) => Math.floor(Number(row.page_num || 0)))
    .filter((value) => Number.isFinite(value) && value > 0)
}

/** Short library/card notice: list failed page numbers only (no long API error dump). */
function getDocumentOcrFailureMessage(docId: string): string {
  const pageList = formatOcrFailedPageNumberList(listDocumentOcrFailedPageNums(docId))
  return pageList ? `第 ${pageList} 页 OCR 未成功` : '部分页面 OCR 未成功'
}

function getDocumentOcrReviewMessage(docId: string): string {
  const pageList = formatOcrFailedPageNumberList(listDocumentOcrFailedPageNums(docId))
  return pageList
    ? `OCR完成，第 ${pageList} 页 OCR 未成功`
    : 'OCR完成，部分页面 OCR 未成功'
}

function updateDocumentStatusFromPages(docId: string, errorMessage?: string | null): void {
  const stats = summarizeDocumentOcrPages(docId)
  const now = new Date().toISOString()
  const completed = isOcrPageSummaryComplete(stats)
  const settledWithReviewPages = hasOcrReviewPages(stats)
  const nextStatus = completed || settledWithReviewPages
    ? 'completed'
    : stats.failed > 0
      ? 'error'
      : stats.pending > 0
        ? 'processing'
        : 'pending'
  const importStatus = nextStatus === 'completed' ? 'processed' : nextStatus === 'error' ? 'error' : nextStatus
  const reviewMessage = settledWithReviewPages ? (errorMessage || getDocumentOcrReviewMessage(docId)) : null
  const errorValue = completed
    ? null
    : settledWithReviewPages
      ? String(reviewMessage || '').slice(0, 1000) || null
      : errorMessage ? String(errorMessage).slice(0, 1000) : null
  run(
    'UPDATE documents SET ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    [nextStatus, importStatus, errorValue, now, docId],
  )
  if (nextStatus === 'completed' || completed || settledWithReviewPages) {
    try {
      recomputeLiteraturePageMap(docId)
    } catch (error) {
      console.warn('[OCR] literature page map recompute failed', docId, error)
    }
  }
  scheduleDatabaseSave()
}

function updateDocumentCanceledStatus(docId: string): void {
  const stats = summarizeDocumentOcrPages(docId)
  const completed = isOcrPageSummaryComplete(stats)
  const settledWithReviewPages = hasOcrReviewPages(stats)
  const nextStatus = completed || settledWithReviewPages ? 'completed' : 'pending'
  const importStatus = nextStatus === 'completed' ? 'processed' : 'stored'
  const errorMessage = completed
    ? null
    : settledWithReviewPages
      ? getDocumentOcrReviewMessage(docId).slice(0, 1000)
      : OCR_CANCELED_MESSAGE
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

/** Cancel persisted queue rows for one document so resume cannot pick it up again. */
function cancelPersistedOcrQueueForDocument(docId: string): void {
  const safeDocId = String(docId || '').trim()
  if (!safeDocId) return
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  transaction(() => {
    run(
      `UPDATE batch_queue
       SET status = 'failed',
           error_message = ?,
           completed_at = ?
       WHERE doc_id = ?
         AND status IN ('pending', 'processing')`,
      [OCR_CANCELED_MESSAGE, nowIso, safeDocId],
    )
    // Import-auto OCR items store docId in domain_ref and input_json.
    run(
      `UPDATE task_items
       SET status = 'canceled',
           completion_kind = NULL,
           active_attempt_id = NULL,
           lease_owner = NULL,
           lease_token = NULL,
           leased_at = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           completed_at = ?,
           updated_at = ?,
           error_json = ?
       WHERE status IN ('queued', 'running', 'paused', 'error')
         AND (
           domain_ref = ?
           OR json_extract(input_json, '$.docId') = ?
         )`,
      [
        nowMs,
        nowMs,
        JSON.stringify({ code: 'ocr_canceled', message: OCR_CANCELED_MESSAGE, recoverable: false }),
        safeDocId,
        safeDocId,
      ],
    )
  })
  scheduleDatabaseSave()
}

function cancelAllPersistedOcrQueues(): { canceledJobs: number; canceledDocuments: number } {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const resumableJobs = listResumableImportAutoOcrTasks()
  resumableJobs.forEach((job) => {
    try {
      cancelTaskJob(job.id, { nowMs })
    } catch (error) {
      console.warn('[OCR] Failed to cancel import-auto job', job.id, error)
    }
  })

  const queuedDocs = queryAll<{ id: string }>(
    `SELECT id FROM documents
     WHERE ocr_status IN ('queued', 'processing')
        OR import_status = 'processing'`,
  ).map((row) => row.id).filter(Boolean)

  // Sticky cancel marks stop any in-flight processDocumentOcr from re-marking
  // these documents as processing after cancel-all.
  for (const docId of queuedDocs) {
    canceledOcrDocIds.add(docId)
  }

  transaction(() => {
    run(
      `UPDATE batch_queue
       SET status = 'failed',
           error_message = ?,
           completed_at = ?
       WHERE status IN ('pending', 'processing')`,
      [OCR_CANCELED_MESSAGE, nowIso],
    )
    if (queuedDocs.length > 0) {
      for (let index = 0; index < queuedDocs.length; index += 200) {
        const chunk = queuedDocs.slice(index, index + 200)
        const placeholders = chunk.map(() => '?').join(', ')
        run(
          `UPDATE documents
           SET ocr_status = CASE
                 WHEN ocr_status IN ('queued', 'processing') THEN 'pending'
                 ELSE ocr_status
               END,
               import_status = CASE
                 WHEN import_status = 'processing' THEN 'stored'
                 ELSE import_status
               END,
               error_message = ?,
               updated_at = ?
           WHERE id IN (${placeholders})`,
          [OCR_CANCELED_MESSAGE, nowIso, ...chunk],
        )
        run(
          `UPDATE pages
           SET ocr_status = 'pending'
           WHERE doc_id IN (${placeholders})
             AND ocr_status IN ('queued', 'processing')`,
          chunk,
        )
      }
    }
  })
  scheduleDatabaseSave()
  return { canceledJobs: resumableJobs.length, canceledDocuments: queuedDocs.length }
}

function markDocumentTocDirty(docId: string): void {
  run("DELETE FROM document_toc_items WHERE doc_id = ? AND source != 'manual'", [docId])
  clearDocumentTocAutogenAttempt(docId)
}

function guardRepeatedOcrPageResult(pageResult: OcrPageResult): OcrPageResult {
  if (pageResult.status !== 'completed') return pageResult
  if (isJsonRecord(pageResult.result) && pageResult.result.gujismart_async_pdf_result === true) return pageResult
  const repeatedIssue = findLikelyRunawayRepeatedOcrText(pageResult.result || pageResult.text)
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

function isOcrQualityFailureMessage(message?: string): boolean {
  if (String(message || '').includes(OCR_ASYNC_PDF_QUALITY_RETRYABLE_PREFIX)) return true
  if (String(message || '').includes(OCR_LAYOUT_QUALITY_REJECTED_PREFIX)) return true
  return /疑似.*(?:误判|重复|少量横排大块|竖排\/双页影印)|误判成表格|重复 OCR|重复文本|版面误判|本页结果未写入正文/.test(String(message || ''))
}

function savePageOcrResults(pageResults: OcrPageResult[], engine: OcrEngine = 'paddle', options: SavePageOcrResultsOptions = {}): string[] {
  if (pageResults.length === 0) return []
  const guardedPageResults = pageResults.map(guardRepeatedOcrPageResult)
  const startedAt = Date.now()
  const changedPageIds: string[] = []
  const tocDirtyDocIds = new Set<string>()
  const versionWrites: OcrVersionWrite[] = []

  // Phase 1 — read/hydrate + gzip payload files outside any SQL transaction.
  // Holding a write transaction while doing disk I/O is the main freeze source.
  const pageSnapshots = getPageSnapshotsForOcrSave(guardedPageResults.map((pageResult) => pageResult.pageId))
  type PendingPageWrite = {
    pageId: string
    docId: string
    status: string
    hasProofedText: boolean
    preparedResult: { value: string | null; ref: string | null }
    preparedText: { value: string | null; ref: string | null }
    invalidateToc: boolean
  }
  const pendingWrites: PendingPageWrite[] = []
  const statusOnlyCompletions: Array<{ pageId: string; docId: string; hasProofedText: boolean }> = []

  for (const pageResult of guardedPageResults) {
    const existingPage = pageSnapshots.get(pageResult.pageId)
    const hasProofedText = String(existingPage?.proofed_text || '').trim().length > 0
    const hasExistingOcrText = String(existingPage?.ocr_text || '').trim().length > 0
    if (pageResult.status === 'error' && existingPage && hasExistingOcrText && !isOcrQualityFailureMessage(pageResult.error)) {
      if (String(existingPage.ocr_status || '') !== 'completed') {
        statusOnlyCompletions.push({
          pageId: pageResult.pageId,
          docId: existingPage.doc_id,
          hasProofedText,
        })
      }
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
    if (!existingPage) continue
    const existingText = String(existingPage.ocr_text || '').trim()
    const nextText = String(resultText || '').trim()
    const existingResult = String(existingPage.ocr_result || '')
    const nextResult = String(resultJson || '')
    const invalidateToc = pageResult.status === 'completed'
      && (
        String(existingPage.ocr_status || '') !== 'completed'
        || existingText !== nextText
        || existingResult !== nextResult
      )
    pendingWrites.push({
      pageId: pageResult.pageId,
      docId: existingPage.doc_id,
      status: pageResult.status,
      hasProofedText,
      preparedResult,
      preparedText,
      invalidateToc,
    })
    const shouldWriteOcrVersion = resultPayload && (
      pageResult.status === 'completed'
      || (pageResult.status === 'error' && isOcrQualityFailureMessage(pageResult.error))
    )
    if (shouldWriteOcrVersion) {
      versionWrites.push({
        pageId: pageResult.pageId,
        page: existingPage,
        result: resultPayload,
        text: resultText,
        status: pageResult.status,
      })
    }
  }

  // Phase 1b — prepare version payload files outside the transaction as well.
  const preparedVersionWrites = versionWrites.flatMap((item) => {
    if (!item.page) return []
    const preparedText = preparePagePayloadUpdate(item.page.doc_id, item.pageId, 'ocr_text', item.text || '')
    const preparedResult = preparePagePayloadUpdate(
      item.page.doc_id,
      item.pageId,
      'ocr_result',
      item.result ? JSON.stringify(item.result) : null,
    )
    return [{ item: { ...item, page: item.page }, preparedText, preparedResult }]
  })

  // Phase 2 — short SQL-only transaction.
  if (statusOnlyCompletions.length > 0 || pendingWrites.length > 0 || preparedVersionWrites.length > 0) {
    transaction(() => {
      for (const item of statusOnlyCompletions) {
        run(
          `UPDATE pages
           SET ocr_status = ?,
               proof_status = CASE WHEN ? THEN proof_status ELSE ? END
           WHERE id = ?`,
          ['completed', item.hasProofedText ? 1 : 0, 'pending', item.pageId],
        )
        changedPageIds.push(item.pageId)
      }
      for (const write of pendingWrites) {
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
            write.preparedResult.value,
            write.preparedResult.ref,
            write.preparedText.value,
            write.preparedText.ref,
            write.status,
            write.hasProofedText ? 1 : 0,
            'pending',
            write.pageId,
          ],
        )
        changedPageIds.push(write.pageId)
        if (write.invalidateToc) tocDirtyDocIds.add(write.docId)
      }
      markPageOcrVersionsInactive(preparedVersionWrites.map((entry) => entry.item.pageId))
      const now = new Date().toISOString()
      for (const entry of preparedVersionWrites) {
        const page = entry.item.page
        if (!page) continue
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
          [
            nanoid(),
            page.doc_id,
            entry.item.pageId,
            page.page_num || null,
            engine,
            getEngineLabel(engine),
            entry.preparedText.value,
            entry.preparedText.ref,
            entry.preparedResult.value,
            entry.preparedResult.ref,
            entry.item.status,
            1,
            now,
            now,
          ],
        )
      }
    })
  }

  const completedVersionWrites = versionWrites.filter((item) => item.status === 'completed')
  for (let offset = 0; offset < completedVersionWrites.length; offset += 200) {
    recordCompatibilityOcrArtifacts(
      completedVersionWrites.slice(offset, offset + 200).map((item) => ({
        pageId: item.pageId,
        engine,
        result: item.result,
        text: item.text,
      })),
    )
  }

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
      // Prefer deferred checkpoint so OCR save does not stall UI right after write.
      scheduleDatabaseSave({ minDelayMs: 8_000 })
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
  event: OcrStatusEvent,
  docId: string,
  totalDocs: number,
  getCompleted: () => number,
  requestedEngine?: OcrEngine,
  forceFullRerun = false,
  processOptions: OcrProcessOptions = {},
): Promise<{ success: boolean; errorMessage?: string }> {
  const signal = processOptions.signal
  if (isDocumentOcrCanceled(docId, signal)) {
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
  // Already completed with no incomplete pages: never re-enter OCR just because a
  // caller passed engine (e.g. vectorize “先 OCR 再向量”). Full rerun requires forceFullRerun.
  if (doc.ocr_status === 'completed' && !forceFullRerun && !completedDocHasIncompletePages) {
    return { success: true }
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
  let asyncPdfRouteRisk: AsyncPdfOcrRouteRisk | null = canUsePdfAsync
    ? getAsyncPdfOcrRouteRisk(doc, pages, pagesForOcr, ocrOptions)
    : null
  if (asyncPdfRouteRisk && pdfPath && pages.length === 0) {
    const expectedPdfPageCount = getExpectedPdfPageCount(doc, pages)
    if (expectedPdfPageCount > 0) {
      pages = await ensurePageRecordsIfNeeded(docId, pages, expectedPdfPageCount)
      pagesForOcr = getPagesNeedingOcr(pages, resumeExisting)
      completedBefore = resumeExisting ? getCompletedOcrPageCount(pages) : 0
    }
  }

  if (pages.length === 0 && !canUsePdfAsync && engine !== 'vision_model' && engine !== 'local_paddle') {
    const errorMessage = '文献没有可处理的页面。若这是 PDF，请先重新导入或点击“重试处理”让软件重新读取页数。'
    updateDocumentStatus(docId, 'error', 'error', errorMessage)
    return { success: false, errorMessage }
  }

  if (pages.length > 0 && pagesForOcr.length === 0 && hasSequentialPageRecords(pages, getExpectedPdfPageCount(doc, pages))) {
    updateDocumentStatus(docId, 'completed', 'processed', null)
    syncDocumentProofStatus(docId)
    return { success: true }
  }

  // Cancel may have arrived while we prepared pages; never re-mark processing after stop.
  if (isDocumentOcrCanceled(docId, signal)) {
    updateDocumentCanceledStatus(docId)
    const completed = emitOcrCanceledOrCompletedStatus(event, docId, getDocProgress(getCompleted(), totalDocs))
    if (completed) return { success: true }
    return { success: false, errorMessage: OCR_CANCELED_MESSAGE }
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
  const syncGujiPaddleReferenceResults = async (
    currentSummary: { total: number; completed: number; failed: number; pending: number },
  ): Promise<{ total: number; completed: number; failed: number; pending: number }> => {
    const referenceRecoveryOptions = asyncPdfRouteRisk?.ocrOptions || ocrOptions
    if (engine !== 'paddle' || !pdfPath || referenceRecoveryOptions.profile !== 'guji_print_vertical') {
      return currentSummary
    }
    const recoveredReferenceResults = await recoverCompletedGujiPagesFromFeijiangReference(
      docId,
      pdfPath,
      referenceRecoveryOptions,
      signal,
    )
    if (recoveredReferenceResults.length > 0) {
      await savePageOcrResultsBatchedDeferred(recoveredReferenceResults, 'paddle', { refreshSearch: false })
      return summarizeDocumentOcrPages(docId)
    }
    const recoveredMismatchResults = await recoverCompletedGujiPagesWithReferenceMismatch(
      docId,
      pdfPath,
      referenceRecoveryOptions,
      signal,
    )
    if (recoveredMismatchResults.length > 0) {
      await savePageOcrResultsBatchedDeferred(recoveredMismatchResults, 'paddle', { refreshSearch: false })
      return summarizeDocumentOcrPages(docId)
    }
    return currentSummary
  }

  try {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfOcrCanceled(signal)
    const resumeThisAttempt = resumeExisting || attempt > 1
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
    pagesForOcr = getPagesForOcrAttempt(pages, resumeExisting, attempt)
    completedBefore = resumeThisAttempt ? getCompletedOcrPageCount(pages) : 0
    pdfPath = resolveUsablePdfPath(doc, Math.max(pages.length, Number(doc.page_count || 0) || 0))
    canUsePdfAsync = shouldUsePdfOcrForWork(pdfPath, pages, pagesForOcr, Number(doc.page_count || 0) || 0)
    asyncPdfRouteRisk = canUsePdfAsync
      ? getAsyncPdfOcrRouteRisk(doc, pages, pagesForOcr, ocrOptions)
      : null
    if (asyncPdfRouteRisk && pdfPath && pages.length === 0) {
      const expectedPdfPageCount = getExpectedPdfPageCount(doc, pages)
      if (expectedPdfPageCount > 0) {
        pages = await ensurePageRecordsIfNeeded(docId, pages, expectedPdfPageCount)
        pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)
        completedBefore = resumeThisAttempt ? getCompletedOcrPageCount(pages) : 0
      }
    }
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
          pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)
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
              pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)
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
        pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)
        completedBefore = resumeThisAttempt ? getCompletedOcrPageCount(pages) : 0
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
    } else if (engine === 'paddle' && asyncPdfRouteRisk?.preferPageImage && pdfPath && pagesForOcr.length > 0) {
      const expectedPdfPageCount = getExpectedPdfPageCount(doc, pages)
      if (!hasSequentialPageRecords(pages, expectedPdfPageCount)) {
        pages = await ensurePageRecordsIfNeeded(docId, pages, expectedPdfPageCount)
        pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)
        completedBefore = resumeThisAttempt ? getCompletedOcrPageCount(pages) : 0
      }
      emitOcrStatus(event, {
        docId,
        status: 'processing',
        phase: 'ocr',
        progress: getDocProgress(getCompleted(), totalDocs, getCombinedDocFraction(0, pagesForOcr.length)),
        completedPages: completedBefore,
        totalPages: getDocTotalPages(),
        message: '检测到影印/竖排风险，使用安全页图 OCR',
        errorMessage: asyncPdfRouteRisk.reason,
      })
      const pageImageOcrPages = await ensurePageImagesForOcrRoute(pagesForOcr, pdfPath, signal)
      pageResults = await recognizeRiskyPageImageOcrPages(pageImageOcrPages, asyncPdfRouteRisk.ocrOptions, {
        signal,
        docType: doc.doc_type,
        onProgress: (payload) => {
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
          message: `安全页图 OCR：${combinedPages}/${totalPages} 页`,
        })
        },
      })
    } else if (canUsePdfAsync && pdfPath) {
      const expectedPdfPageCount = getExpectedPdfPageCount(doc, pages)
      if (!hasSequentialPageRecords(pages, expectedPdfPageCount)) {
        pages = await ensurePageRecordsIfNeeded(docId, pages, expectedPdfPageCount)
        pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)
        completedBefore = resumeThisAttempt ? getCompletedOcrPageCount(pages) : 0
      }
      // Do not render every page before asynchronous PDF OCR. Large documents
      // can start uploading immediately; only suspicious/failed pages render a
      // local image later through ensurePageImageForOcrFallback().
      let savedAsyncPageCount = completedBefore
      let lastAsyncDisplayedPageCount = completedBefore
      const asyncPdfOcrOptions = asyncPdfRouteRisk?.ocrOptions || ocrOptions
      const savedAsyncPageIds = new Set(
        resumeThisAttempt
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
      const targetPageNumSet = new Set(targetPageNums || [])
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
          const awaitingResultFile = Boolean(payload.awaitingResultFile)
          const isAwaitingAsyncResult = totalPages > 0 && finishedPages >= totalPages && !awaitingResultFile
          const hasServerProgress = newlyFinishedPages > 0 || Number(payload.progress || 0) > 0
          const fallbackRetryMessage = isPreparing && payload.fallbackReason
            ? String(payload.fallbackReason || '正在重新提交 PDF')
            : ''
          const waitingText = payload.waitingMs ? `，已等待 ${formatDurationMs(payload.waitingMs)}` : ''
          const pollText = payload.pollCount ? `，第 ${payload.pollCount} 次查询` : ''
          const waitingResultFileMessage = awaitingResultFile
            ? `OCR 服务已处理完成 ${finishedPages}/${totalPages} 页，正在等待结果文件生成${waitingText}${pollText}`
            : ''
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
            message: fallbackRetryMessage || statusQueryRetryMessage || waitingResultFileMessage || uploadModeMessage || asyncProgressMessage || (isWaitingForServerQueue
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
          ocrOptions: asyncPdfOcrOptions,
          requireFullFileUpload: Boolean(asyncPdfRouteRisk?.requireFullFileUpload),
          pageRangeChunkSize: asyncPdfRouteRisk?.pageRangeChunkSize,
          targetPageNums,
          fallbackPageCount,
          collectChunkResults: false,
          onChunkComplete: async (chunk) => {
            throwIfOcrCanceled(signal)
            pages = await ensurePageRecordsIfNeeded(docId, pages, Math.max(pages.length, chunk.totalPages))
            const chunkPages = chunk.sourcePageIndexes
              .map((sourcePageIndex, resultIndex) => ({
                page: pages[sourcePageIndex],
                sourcePageIndex,
                resultIndex,
              }))
              .filter((item): item is { page: OcrPageRow; sourcePageIndex: number; resultIndex: number } => {
                if (!item.page) return false
                if (!asyncPdfRouteRisk?.requireFullFileUpload) return true
                return targetPageNumSet.has(Number(item.page.page_num || item.sourcePageIndex + 1))
              })
            const chunkPageResults = await postProcessPdfOcrResultsBatched(
              chunkPages,
              chunk.results,
              asyncPdfOcrOptions,
              signal,
              (item) => `PaddleOCR 异步结果页数不足：第 ${item.sourcePageIndex + 1} 页缺少结果。`,
              pdfPath,
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
        pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)
        completedBefore = resumeThisAttempt ? getCompletedOcrPageCount(pages) : 0
        if (isAsyncPdfRecoverableStallError(error)) {
          const stalledMessage = formatOcrError(error)
          emitOcrStatus(event, {
            docId,
            status: 'processing',
            phase: 'ocr',
            progress: getDocProgress(getCompleted(), totalDocs, getCombinedDocFraction(0, pagesForOcr.length)),
            completedPages: completedBefore,
            totalPages: getDocTotalPages(),
            message: `异步 PDF OCR 进度停住，正在自动补跑未完成页：${completedBefore}/${getDocTotalPages()} 页`,
            errorMessage: stalledMessage,
          })
          pageResults = await retryIncompletePagesWithSinglePageOcr(
            {
              id: doc.id,
              title: doc.title,
              author: doc.author,
              source: doc.source,
              doc_type: doc.doc_type,
              metadata: doc.metadata,
            },
            pdfPath,
            signal,
            (payload) => {
              emitOcrStatus(event, {
                docId,
                status: 'processing',
                phase: 'ocr',
                progress: getDocProgress(getCompleted(), totalDocs, 0.97),
                completedPages: Math.min(getDocTotalPages() || payload.totalPages, completedBefore + payload.completedPages),
                totalPages: getDocTotalPages() || payload.totalPages,
                pageNum: payload.pageNum,
                errorMessage: payload.error,
                message: `正在自动补跑未完成页：${payload.completedPages}/${payload.totalPages} 页`,
              })
            },
          )
          canUsePdfAsync = false
        } else if (!isPdfChunkStructureError(error) || !canFallbackToImageOcr(pagesForOcr)) {
          throw error
        } else {
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
          pagesForOcr = getPagesNeedingOcr(pages, resumeThisAttempt)
          const asyncResultPageItems = pagesForOcr.map((page, index) => {
            const sourcePageIndex = Number(page.page_num || index + 1) - 1
            const resultIndex = asyncPdfRouteRisk?.requireFullFileUpload ? sourcePageIndex : index
            return { page, sourcePageIndex, resultIndex }
          })
          pageResults = await postProcessPdfOcrResultsBatched(
            asyncResultPageItems,
            asyncResults,
            asyncPdfOcrOptions,
            signal,
            () => `PaddleOCR 异步结果页数不足：预期 ${pages.length} 页，实际返回 ${asyncResults.length} 页。可能是接口未完整处理该 PDF，建议稍后重试或切换 PP-StructureV3。`,
            pdfPath,
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
    if (!pageResultsPersistedInChunks) {
      await savePageOcrResultsBatchedDeferred(pageResults, engine, { refreshSearch: false })
    }
    if (!pageResultsPersistedInChunks && (engine === 'vision_model' || engine === 'hybrid')) {
      mergeVisionTocIntoMetadata(doc, pageResults)
    }

    let persistedPageSummary = summarizeDocumentOcrPages(docId)
    persistedPageSummary = await syncGujiPaddleReferenceResults(persistedPageSummary)
    if (engine !== 'local_paddle' && (persistedPageSummary.failed > 0 || persistedPageSummary.pending > 0)) {
      const failedOrPending = Math.max(0, persistedPageSummary.failed + persistedPageSummary.pending)
      emitOcrStatus(event, {
        docId,
        status: 'processing',
        phase: 'ocr',
        progress: getDocProgress(getCompleted(), totalDocs, 0.97),
        completedPages: persistedPageSummary.completed,
        totalPages: getDocTotalPages() || persistedPageSummary.total || totalPagesForStatus,
        message: `全书已识别 ${persistedPageSummary.completed} 页，发现 ${failedOrPending} 个未完成页，开始自动补跑…`,
      })
      // If bulk already used async PDF streaming, do not start another full-PDF async
      // job here — that often freezes progress at “0/1 页” until stall/timeout.
      const retryResults = await retryIncompletePagesWithSinglePageOcr(
        {
          id: doc.id,
          title: doc.title,
          author: doc.author,
          source: doc.source,
          doc_type: doc.doc_type,
          metadata: doc.metadata,
        },
        pdfPath,
        signal,
        (payload) => {
          const bookTotal = getDocTotalPages() || persistedPageSummary.total || totalPagesForStatus
          emitOcrStatus(event, {
            docId,
            status: 'processing',
            phase: 'ocr',
            progress: getDocProgress(getCompleted(), totalDocs, 0.97),
            completedPages: Math.min(
              bookTotal,
              persistedPageSummary.completed + payload.completedPages,
            ),
            totalPages: bookTotal,
            pageNum: payload.pageNum,
            errorMessage: payload.error,
            message: payload.message
              || `正在补跑未完成页 ${payload.completedPages}/${payload.totalPages}`,
          })
        },
        { skipOriginalPdfRetry: pageResultsPersistedInChunks },
      )
      if (retryResults.length > 0) {
        await savePageOcrResultsBatchedDeferred(retryResults, 'paddle', { refreshSearch: false })
        persistedPageSummary = summarizeDocumentOcrPages(docId)
        persistedPageSummary = await syncGujiPaddleReferenceResults(persistedPageSummary)
      }
    }

    // Partial page failures must not fail the whole document. Settle leftovers as
    // review errors so the book can 入库 (completed/processed) with a notice below.
    if (persistedPageSummary.pending > 0) {
      const settledCount = settleIncompleteOcrPagesAsReviewFailures(docId)
      if (settledCount > 0) {
        deferredDatabaseSaveNeeded = true
        persistedPageSummary = summarizeDocumentOcrPages(docId)
        persistedPageSummary = await syncGujiPaddleReferenceResults(persistedPageSummary)
      }
    }

    const persistedTotalPagesForStatus = getDocTotalPages() || persistedPageSummary.total || totalPagesForStatus
    const persistedCompletedPagesForStatus = persistedPageSummary.completed || completedPagesForStatus

    const reprocessedPageIds = await reprocessDocumentOcrStructure(docId)
    reprocessedPageIds.forEach((pageId) => deferredFinalizePageIds.add(pageId))
    if (reprocessedPageIds.length > 0) deferredDatabaseSaveNeeded = true

    persistedPageSummary = summarizeDocumentOcrPages(docId)
    // If structure reprocess left anything unsettled, settle again then complete.
    if (persistedPageSummary.pending > 0) {
      settleIncompleteOcrPagesAsReviewFailures(docId)
      persistedPageSummary = summarizeDocumentOcrPages(docId)
    }

    const hasFinalReviewPageFailure = hasOcrReviewPages(persistedPageSummary) || persistedPageSummary.failed > 0
    const reviewMessage = hasFinalReviewPageFailure ? getDocumentOcrReviewMessage(docId) : null
    // Always complete/入库 when OCR attempt finished; page errors only appear as review notes below.
    updateDocumentStatusFromPages(docId, reviewMessage)
    syncDocumentProofStatus(docId)
    autoCleanupPdfAssetsIfEnabled(docId)

    const autoAi = queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'auto_ai_after_ocr'")
    const hybridReadyForAutoAi = engine !== 'hybrid' || (!pageResultsPersistedInChunks && hasCompletedHybridVisionRefine(pageResults))
    const hybridRefineFallback = engine === 'hybrid' && !pageResultsPersistedInChunks && hasHybridVisionRefineFallback(pageResults)
    // Skip auto AI when pages need review so the review notice is not cleared by AI status patches.
    if (autoAi?.value === 'true' && !hasFinalReviewPageFailure && hybridReadyForAutoAi) {
      aiExtractionStarted = true
      emitOcrStatus(event, {
        docId,
        status: 'completed',
        phase: 'ai',
        aiStatus: 'processing',
        progress: getDocProgress(getCompleted(), totalDocs, 1),
        completedPages: persistedPageSummary.completed || persistedCompletedPagesForStatus,
        totalPages: getDocTotalPages() || persistedPageSummary.total || persistedTotalPagesForStatus,
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
            completedPages: persistedPageSummary.completed || persistedCompletedPagesForStatus,
            totalPages: getDocTotalPages() || persistedPageSummary.total || persistedTotalPagesForStatus,
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
            completedPages: persistedPageSummary.completed || persistedCompletedPagesForStatus,
            totalPages: getDocTotalPages() || persistedPageSummary.total || persistedTotalPagesForStatus,
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
        completedPages: persistedPageSummary.completed || persistedCompletedPagesForStatus,
        totalPages: getDocTotalPages() || persistedPageSummary.total || persistedTotalPagesForStatus,
        errorMessage: '混合 OCR 第二轮视觉整理失败，已使用飞桨版面生成临时阅读结构；请稍后重试大模型整理。',
        message: '混合 OCR 第二轮失败，已保留临时结构',
      })
    } else if (hasFinalReviewPageFailure) {
      emitOcrStatus(event, {
        docId,
        status: 'completed',
        phase: 'completed',
        progress: getDocProgress(getCompleted(), totalDocs, 1),
        completedPages: persistedPageSummary.completed || persistedCompletedPagesForStatus,
        totalPages: getDocTotalPages() || persistedPageSummary.total || persistedTotalPagesForStatus,
        errorMessage: reviewMessage || undefined,
        message: reviewMessage || 'OCR完成',
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

      // Hard document-level failures (e.g. missing API token, no pages) still fail the book.
      // Any page-level leftovers settle as review so the document can still 入库.
      const pageSummary = summarizeDocumentOcrPages(docId)
      if (pageSummary.total > 0) {
        if (pageSummary.pending > 0) {
          settleIncompleteOcrPagesAsReviewFailures(docId)
        }
        const settledSummary = summarizeDocumentOcrPages(docId)
        const hasReview = hasOcrReviewPages(settledSummary) || settledSummary.failed > 0
        const reviewMessage = hasReview
          ? (getDocumentOcrReviewMessage(docId) || lastErrorMessage)
          : null
        updateDocumentStatusFromPages(docId, reviewMessage)
        if (isDocumentOcrSettledFromPages(docId) || isDocumentOcrCompleteFromPages(docId)) {
          syncDocumentProofStatus(docId)
          autoCleanupPdfAssetsIfEnabled(docId)
          return { success: true }
        }
      }
      const nextStatus = lastErrorMessage.includes('API Token') ? 'pending' : 'error'
      updateDocumentStatus(docId, nextStatus, nextStatus === 'error' ? 'error' : 'stored', lastErrorMessage)
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
    if (isDocumentOcrCanceled(docId, signal)) {
      if (isDocumentOcrSettledFromPages(docId)) {
        updateDocumentStatusFromPages(docId)
        emitOcrCanceledOrCompletedStatus(event, docId, 1)
        return { success: true }
      }
      // Do not re-emit processing if user already canceled/stopped this document.
      updateDocumentCanceledStatus(docId)
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

function getImportAutoOcrTaskConfig(jobId: string): {
  engine: OcrEngine
  batchSize: number
  totalCount: number
  libraryProjectId: string
} {
  const job = getImportAutoOcrTask(jobId)
  const engineValue = String(job.settingsSnapshot.engine || 'paddle')
  const engine: OcrEngine = engineValue === 'local_paddle' || engineValue === 'vision_model' || engineValue === 'hybrid'
    ? normalizeAvailableOcrEngine(engineValue)
    : 'paddle'
  const rawBatchSize = Number(job.settingsSnapshot.batchSize || 5)
  const batchSize = Math.max(1, Math.min(200, Number.isSafeInteger(rawBatchSize) ? rawBatchSize : 5))
  const libraryProjectId = requireLibraryProjectId(
    String(job.settingsSnapshot.libraryProjectId || DEFAULT_LIBRARY_PROJECT_ID),
  )
  return { engine, batchSize, totalCount: job.totalCount, libraryProjectId }
}

async function acquireDocumentOcrSlot(docId: string): Promise<void> {
  while (!ocrRuntimeShuttingDown) {
    const active = activeOcrTasks.get(docId)
    if (active) {
      await active.done
      continue
    }
    if (!queuedOcrDocIds.has(docId)) {
      queuedOcrDocIds.add(docId)
      return
    }
    await sleep(100)
  }
}

async function processImportAutoOcrClaim(
  event: OcrStatusEvent,
  claim: ReturnType<typeof claimTaskItems>[number],
  engine: OcrEngine,
  libraryProjectId: string,
  totalCount: number,
  getCompleted: () => number,
): Promise<boolean> {
  const docId = String(claim.input.docId || claim.domainRef || '').trim()
  if (!docId) {
    failTaskItem({
      itemId: claim.itemId,
      leaseToken: claim.leaseToken,
      error: { code: 'import_auto_ocr_doc_missing', message: '自动 OCR 任务缺少文献 ID。', recoverable: false },
    })
    return false
  }

  await acquireDocumentOcrSlot(docId)
  if (ocrRuntimeShuttingDown) {
    releaseTaskItemLease({ itemId: claim.itemId, leaseToken: claim.leaseToken })
    return false
  }

  const doc = queryOne<{ id: string; page_count: number | null }>(
    'SELECT id, page_count FROM documents WHERE id = ? AND library_project_id = ?',
    [docId, libraryProjectId],
  )
  if (!doc) {
    failTaskItem({
      itemId: claim.itemId,
      leaseToken: claim.leaseToken,
      error: { code: 'import_auto_ocr_document_not_found', message: '待 OCR 文献已不存在。', recoverable: false },
    })
    return false
  }

  const controller = new AbortController()
  const activeTask = createActiveOcrTask(controller)
  const heartbeat = setInterval(() => {
    try {
      heartbeatTaskLease({ itemId: claim.itemId, leaseToken: claim.leaseToken, leaseMs: IMPORT_AUTO_OCR_LEASE_MS })
    } catch (error) {
      console.warn('[OCR] 自动 OCR 任务续租失败', error)
      controller.abort()
    }
  }, IMPORT_AUTO_OCR_HEARTBEAT_MS)

  // Honor cancel before clearing any cancel mark. Previously this deleted the
  // cancel flag and forced queued docs to start again after user clicked stop.
  if (canceledOcrDocIds.has(docId) || ocrRuntimeShuttingDown) {
    failTaskItem({
      itemId: claim.itemId,
      leaseToken: claim.leaseToken,
      error: {
        code: 'ocr_canceled',
        message: OCR_CANCELED_MESSAGE,
        recoverable: false,
      },
    })
    updateDocumentCanceledStatus(docId)
    emitOcrStatus(event, {
      docId,
      status: 'canceled',
      phase: 'canceled',
      progress: getCompleted() / Math.max(totalCount, 1),
      message: OCR_CANCELED_MESSAGE,
      errorMessage: OCR_CANCELED_MESSAGE,
      canceled: true,
    })
    queuedOcrDocIds.delete(docId)
    activeTask.finish()
    return false
  }

  queuedOcrDocIds.delete(docId)
  activeOcrTasks.set(docId, activeTask)
  run(
    'UPDATE documents SET ocr_status = ?, import_status = ?, metadata_status = ?, error_message = NULL, updated_at = ? WHERE id = ?',
    ['processing', 'processing', 'pending', new Date().toISOString(), docId],
  )
  scheduleDatabaseSave()
  emitOcrStatus(event, {
    docId,
    status: 'processing',
    phase: 'ocr',
    progress: getCompleted() / Math.max(totalCount, 1),
    completedPages: 0,
    totalPages: Number(doc.page_count || 0) || undefined,
    message: '正在执行导入后的自动 OCR',
  })

  try {
    if (canceledOcrDocIds.has(docId)) controller.abort()
    timedOutOcrDocIds.delete(docId)
    const result = await runDocumentOcrWithWallTimeout(
      event,
      docId,
      Math.max(totalCount, 1),
      getCompleted,
      engine,
      false,
      controller,
      Number(doc.page_count || 0) || 0,
    )
    if (result.success) {
      completeTaskItem({ itemId: claim.itemId, leaseToken: claim.leaseToken })
      return true
    }
    if (ocrRuntimeShuttingDown) {
      releaseTaskItemLease({ itemId: claim.itemId, leaseToken: claim.leaseToken })
      return false
    }
    failTaskItem({
      itemId: claim.itemId,
      leaseToken: claim.leaseToken,
      error: {
        code: result.timedOut
          ? 'ocr_document_timeout'
          : result.errorMessage === OCR_CANCELED_MESSAGE
            ? 'ocr_canceled'
            : 'import_auto_ocr_failed',
        message: result.errorMessage || '自动 OCR 未完成。',
        recoverable: true,
        recoveryAction: 'retry_task',
      },
    })
    return false
  } catch (error) {
    if (ocrRuntimeShuttingDown || isOcrAbortError(error)) {
      releaseTaskItemLease({ itemId: claim.itemId, leaseToken: claim.leaseToken })
      return false
    }
    failTaskItem({
      itemId: claim.itemId,
      leaseToken: claim.leaseToken,
      error: {
        code: 'import_auto_ocr_failed',
        message: (error as Error)?.message || '自动 OCR 失败。',
        recoverable: true,
        recoveryAction: 'retry_task',
      },
    })
    return false
  } finally {
    clearInterval(heartbeat)
    if (activeOcrTasks.get(docId)?.controller === controller) activeOcrTasks.delete(docId)
    queuedOcrDocIds.delete(docId)
    // Do not clear canceledOcrDocIds here: a hung OCR that finishes after cancel-all
    // must not erase the cancel mark and re-mark the document as processing.
    activeTask.finish()
  }
}

async function runImportAutoOcrTask(event: OcrStatusEvent, jobId: string): Promise<void> {
  const config = getImportAutoOcrTaskConfig(jobId)
  return withLibraryProjectContext(config.libraryProjectId, async () => {
  // Claim only as many items as we can actually run. Claiming 200 then Promise.all
  // creates 200 status events + lease rows before any OCR page upload starts.
  const concurrency = Math.max(1, getOcrDocumentConcurrency(config.batchSize))
  let completedCount = getImportAutoOcrTask(jobId).completedCount
  const workerId = `import-auto-ocr:${jobId}:${nanoid(6)}`
  pauseBackgroundSearchReindex()
  try {
    while (!ocrRuntimeShuttingDown) {
      const claims = claimTaskItems({
        jobId,
        workerId,
        limit: concurrency,
        leaseMs: IMPORT_AUTO_OCR_LEASE_MS,
      })
      if (claims.length === 0) break

      await runBoundedDocumentWorkers(claims, concurrency, async (claim) => {
        if (ocrRuntimeShuttingDown) {
          releaseTaskItemLease({ itemId: claim.itemId, leaseToken: claim.leaseToken })
          return
        }
        const docId = String(claim.input.docId || claim.domainRef || '').trim()
        const heavy = Boolean(docId && isHeavyPdfOcrDocument(docId))
        // Heavy PDFs share the same global document window with limit 1 effectively
        // via globalOcrDocumentWindow + sequential heavy preference inside process path.
        await globalOcrDocumentWindow.run(heavy ? 1 : concurrency, async () => {
          const success = await processImportAutoOcrClaim(
            event,
            claim,
            config.engine,
            config.libraryProjectId,
            config.totalCount,
            () => completedCount,
          )
          if (success) completedCount += 1
        })
      })
      await yieldToEventLoop()
    }
  } finally {
    resumeBackgroundSearchReindex({ reason: 'ocr-batch-deferred' })
  }
  })
}

function startImportAutoOcrTaskRun(event: OcrStatusEvent, jobId: string): ImportAutoOcrTaskStartResult {
  const job = getImportAutoOcrTask(jobId)
  const config = getImportAutoOcrTaskConfig(jobId)
  if (config.libraryProjectId !== getActiveLibraryProjectId()) {
    throw new Error('Import auto OCR task belongs to a different library project')
  }
  const existing = activeImportAutoOcrRuns.get(jobId)
  if (existing) return { jobId, totalCount: job.totalCount, started: false }
  const taskRun = runImportAutoOcrTask(event, jobId)
    .catch((error) => console.error('[OCR] 导入后自动 OCR 任务失败', error))
    .finally(() => activeImportAutoOcrRuns.delete(jobId))
  activeImportAutoOcrRuns.set(jobId, taskRun)
  return { jobId, totalCount: job.totalCount, started: true }
}

/**
 * Called after first-paint grace (see main process delay). Repairs leases and
 * auto-starts resumable import-auto OCR so large batches are not abandoned
 * until the user manually clicks continue.
 */
export function resumePendingImportAutoOcrTasks(sender: Electron.WebContents): number {
  if (ocrRuntimeShuttingDown || sender.isDestroyed()) return 0
  const recovered = recoverInterruptedImportAutoOcrTasks()
  // Bounded workers only; do not fan out the whole queue at once.
  const started = startAllResumableImportAutoOcrTasks(sender)
  if (recovered > 0 || started > 0) {
    console.log(
      `[OCR] Startup recovered ${recovered} interrupted item(s); auto-started ${started} import-auto OCR job(s) for continuous bulk resume`,
    )
  } else {
    const pending = listResumableImportAutoOcrTasks()
    if (pending.length > 0) {
      console.log(`[OCR] ${pending.length} import-auto job(s) still pending but none newly started (already running or empty)`)
    }
  }
  return started
}

/** User/explicit path: start all resumable import-auto OCR jobs with the bounded worker pool. */
export function startAllResumableImportAutoOcrTasks(sender: Electron.WebContents): number {
  if (ocrRuntimeShuttingDown || sender.isDestroyed()) return 0
  recoverInterruptedImportAutoOcrTasks()
  const event: OcrStatusEvent = { sender }
  const tasks = listResumableImportAutoOcrTasks()
  tasks.forEach((task) => startImportAutoOcrTaskRun(event, task.id))
  return tasks.length
}

export function registerOcrIpc(): void {
  ipcMain.handle('ocr:createImportAutoTask', async (_event, options: ImportAutoOcrTaskCreateOptions) => {
    const task = createImportAutoOcrTask(options)
    const config = getImportAutoOcrTaskConfig(task.id)
    return { jobId: task.id, engine: config.engine, batchSize: config.batchSize, totalCount: task.totalCount }
  })

  ipcMain.handle('ocr:appendImportAutoTask', async (_event, jobId: string, items: ImportAutoOcrTaskItemInput[]) => {
    const before = getImportAutoOcrTask(jobId).totalCount
    const task = appendImportAutoOcrItems(jobId, items)
    return { jobId: task.id, appendedCount: Math.max(0, task.totalCount - before), totalCount: task.totalCount }
  })

  ipcMain.handle('ocr:startImportAutoTask', async (event, jobId: string): Promise<ImportAutoOcrTaskStartResult> => {
    if (ocrRuntimeShuttingDown) {
      const task = getImportAutoOcrTask(jobId)
      return { jobId: task.id, totalCount: task.totalCount, started: false }
    }
    return startImportAutoOcrTaskRun(event, jobId)
  })

  ipcMain.handle('ocr:checkToken', async () => {
    return Boolean(readProtectedSetting('paddleocr_api_key'))
  })

  ipcMain.handle('ocr:checkVisionConfig', async () => hasVisionOcrConfig())

  ipcMain.handle('ocr:cancelDocument', async (event, docId: string) => {
    const safeDocId = String(docId || '').trim()
    if (!safeDocId) return false
    canceledOcrDocIds.add(safeDocId)
    // Force-release in-memory slot even when network OCR never honors AbortSignal.
    forceReleaseActiveOcrTask(safeDocId)
    // Also drop persisted queue rows; otherwise restart/resume re-picks the same doc.
    cancelPersistedOcrQueueForDocument(safeDocId)
    updateDocumentCanceledStatus(safeDocId)
    emitOcrCanceledOrCompletedStatus(event, safeDocId, 0)
    // Always true when status was updated — queued docs have no active AbortController.
    return true
  })

  ipcMain.handle('ocr:cancelAllPending', async (event): Promise<{ canceledJobs: number; canceledDocuments: number }> => {
    // Mark cancel + force-release every in-flight / queued slot so restart is never blocked
    // by a hung OCR HTTP request that never reaches its finally cleanup.
    for (const docId of activeOcrTasks.keys()) {
      canceledOcrDocIds.add(docId)
    }
    for (const docId of queuedOcrDocIds) {
      canceledOcrDocIds.add(docId)
    }
    const releasedActiveIds = forceReleaseAllActiveOcrTasks()

    const summary = cancelAllPersistedOcrQueues()
    // Also mark any DB-updated docs as canceled for UI events.
    const canceledDocIds = queryAll<{ id: string }>(
      `SELECT id FROM documents
       WHERE error_message = ?
         AND ocr_status IN ('pending', 'completed')
       ORDER BY updated_at DESC
       LIMIT 500`,
      [OCR_CANCELED_MESSAGE],
    ).map((row) => row.id)
    const emitIds = [...new Set([...releasedActiveIds, ...canceledDocIds])]
    for (const docId of emitIds) {
      emitOcrCanceledOrCompletedStatus(event, docId, 0)
    }
    console.log(
      `[OCR] cancelAllPending: jobs=${summary.canceledJobs}, documents=${summary.canceledDocuments}, releasedActive=${releasedActiveIds.length}`,
    )
    return summary
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
    const changedPageIds = await reprocessDocumentOcrStructure(safeDocId)
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
    const persistForRecovery = shouldPersistBatchOcrForRecovery(options)
    const forceFullRerunByDocId = new Map<string, boolean>()
    const heavyPdfDocIds = new Set<string>()
    const queuedDocIds: string[] = []
    const uniqueDocIds = [...new Set(docIds.map((item) => String(item || '').trim()).filter(Boolean))]

    // Enqueue scan must stay O(concurrency-friendly): never do heavy per-doc work for
    // the entire 10k list without yielding, and never Promise.all the whole list.
    for (let index = 0; index < uniqueDocIds.length; index += 1) {
      const docId = uniqueDocIds[index]
      const doc = queryOne<{ ocr_status: string; page_count: number | null }>('SELECT ocr_status, page_count FROM documents WHERE id = ?', [docId])
      if (!doc) continue
      // If a previous cancel aborted the controller but the hung task never cleaned up,
      // free the slot so the user can start OCR again instead of seeing "已在继续处理中".
      const existingActive = activeOcrTasks.get(docId)
      if (existingActive?.controller.signal.aborted || canceledOcrDocIds.has(docId)) {
        forceReleaseActiveOcrTask(docId)
      }
      if (activeOcrTasks.has(docId) || queuedOcrDocIds.has(docId)) {
        emitOcrAlreadyRunningStatus(event, docId)
        continue
      }
      const forceFullRerun = options?.forceFullRerun === true
      forceFullRerunByDocId.set(docId, forceFullRerun)
      canceledOcrDocIds.delete(docId)
      timedOutOcrDocIds.delete(docId)
      // Prefer document-level status; only hit pages table when status claims completed.
      const needsWork = forceFullRerun
        || doc.ocr_status !== 'completed'
        || hasIncompleteOcrPages(docId)
      if (!needsWork) continue
      queuedOcrDocIds.add(docId)
      queuedDocIds.push(docId)
      // Do NOT pre-mark medium books (e.g. 200 pages) as "heavy". That forced
      // global concurrency 1 and made “每批 8 篇” look like one-book-at-a-time.
      // True heavy detection (1000+ pages / 200MB+) is deferred to claim time.
      if (index > 0 && index % 25 === 0) await yieldToEventLoop()
    }

    const shouldPauseSearchReindexForBatch = queuedDocIds.length > 0
    if (shouldPauseSearchReindexForBatch) pauseBackgroundSearchReindex()
    let recoverableQueueItemIdsByDocId = new Map<string, string>()

    try {
      // Persist recovery metadata in chunks so a 10k enqueue cannot freeze open.
      if (persistForRecovery && queuedDocIds.length > 0) {
        for (let offset = 0; offset < queuedDocIds.length; offset += 50) {
          const chunk = queuedDocIds.slice(offset, offset + 50)
          const partial = createRecoverableBatchOcrItems(chunk, documentConcurrency)
          partial.forEach((itemId, docId) => recoverableQueueItemIdsByDocId.set(docId, itemId))
          await yieldToEventLoop()
        }
      }

      // Mark queued status in SQL chunks; emit one light progress event per doc so the
      // library can show “N 篇处理中 / M 篇等待” immediately (not only when claimed).
      if (queuedDocIds.length > 0) {
        const now = new Date().toISOString()
        for (let offset = 0; offset < queuedDocIds.length; offset += 100) {
          const chunk = queuedDocIds.slice(offset, offset + 100)
          const placeholders = chunk.map(() => '?').join(', ')
          run(
            `UPDATE documents SET ocr_status = ?, import_status = ?, metadata_status = ?, error_message = ?, updated_at = ? WHERE id IN (${placeholders})`,
            ['queued', 'processing', 'pending', null, now, ...chunk],
          )
          for (const docId of chunk) {
            emitOcrStatus(event, {
              docId,
              status: 'queued',
              phase: 'queued',
              progress: 0,
              message: 'OCR 已入队',
            })
          }
          await yieldToEventLoop()
        }
        scheduleDatabaseSave()
      }

      await runBoundedDocumentWorkers(queuedDocIds, documentConcurrency, async (docId) => {
        if (ocrRuntimeShuttingDown || canceledOcrDocIds.has(docId)) {
          queuedOcrDocIds.delete(docId)
          return
        }
        if (activeOcrTasks.has(docId)) {
          const stale = activeOcrTasks.get(docId)
          if (stale?.controller.signal.aborted || canceledOcrDocIds.has(docId)) {
            forceReleaseActiveOcrTask(docId)
          } else {
            queuedOcrDocIds.delete(docId)
            emitOcrAlreadyRunningStatus(event, docId)
            return
          }
        }

        // Only true monsters serialize (1000+ pages or 200MB+). Otherwise honor user batch_size concurrency.
        const heavy = isHeavyPdfOcrDocument(docId)
        if (heavy) heavyPdfDocIds.add(docId)
        const slotLimit = heavy ? 1 : documentConcurrency

        const controller = new AbortController()
        const preCanceled = canceledOcrDocIds.has(docId)
        const activeTask = createActiveOcrTask(controller)
        activeOcrTasks.set(docId, activeTask)
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
            message: heavy ? '超大 PDF 识别中…' : 'OCR 识别中',
          })
          updateRecoverableBatchOcrItem(recoverableQueueItemIdsByDocId, docId, 'processing')
          await yieldToEventLoop()

          await globalOcrDocumentWindow.run(slotLimit, async () => {
            const pageCount = Number(doc?.page_count || 0) || 0
            const result = await runDocumentOcrWithWallTimeout(
              event,
              docId,
              Math.max(queuedDocIds.length, 1),
              () => completedCount,
              options?.engine,
              forceFullRerunByDocId.get(docId) || false,
              controller,
              pageCount,
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
          })
        } finally {
          if (activeOcrTasks.get(docId)?.controller === controller) {
            activeOcrTasks.delete(docId)
          }
          queuedOcrDocIds.delete(docId)
          activeTask.finish()
        }
      })
    } finally {
      if (shouldPauseSearchReindexForBatch) {
        resumeBackgroundSearchReindex({ reason: 'ocr-batch-deferred' })
      }
    }

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

    run(`UPDATE pages SET ocr_status = ?, proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END WHERE id = ?`, ['processing', pageId])
    run('UPDATE documents SET ocr_status = ?, import_status = ?, updated_at = ? WHERE id = ?', [
      'processing',
      'processing',
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
      const qualityFailureMessage = (error as Error)?.message || String(error || 'OCR failed')
      const qualityFailureSaveResult = await savePageQualityFailureOcrError(pageId, error, qualityFailureMessage, 'paddle', { pageOptions: options })
      if (qualityFailureSaveResult === 'recovered') {
        finishRecoveredPageQualityFailure(event, page)
        return true
      }
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
    const rawPage = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
    const page = rawPage ? hydratePagePayloadRows([rawPage])[0] : null
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

    run(`UPDATE pages SET ocr_status = ?, proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END WHERE id = ?`, ['processing', pageId])
    run('UPDATE documents SET ocr_status = ?, import_status = ?, updated_at = ? WHERE id = ?', [
      'processing',
      'processing',
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
      const previousPageStatus = String(page.ocr_status || '').trim() || 'pending'
      const hasExistingOcr = String(page.ocr_text || '').trim().length > 0 || String(page.ocr_result || '').trim().length > 0
      if (hasExistingOcr) {
        run('UPDATE pages SET ocr_status = ? WHERE id = ?', [previousPageStatus === 'processing' ? 'completed' : previousPageStatus, pageId])
        updateDocumentStatusFromPages(page.doc_id)
        syncDocumentProofStatus(page.doc_id)
        scheduleDatabaseSave()
        const currentDocStatus = queryOne<{ ocr_status: string }>('SELECT ocr_status FROM documents WHERE id = ?', [page.doc_id])?.ocr_status || 'completed'
        emitOcrStatus(event, { docId: page.doc_id, status: currentDocStatus, progress: 1 })
        console.error('[OCR] Rerun current page vision OCR failed:', error)
        throw error
      }
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
    const rawPage = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
    const page = rawPage ? hydratePagePayloadRows([rawPage])[0] : null
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

    run(`UPDATE pages SET ocr_status = ?, proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END WHERE id = ?`, ['processing', pageId])
    run('UPDATE documents SET ocr_status = ?, import_status = ?, updated_at = ? WHERE id = ?', [
      'processing',
      'processing',
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
      const qualityFailureMessage = (error as Error)?.message || String(error || 'Enhance guji page failed')
      const qualityFailureSaveResult = await savePageQualityFailureOcrError(pageId, error, qualityFailureMessage, 'paddle', { ocrOptions: resolvedOptions })
      if (qualityFailureSaveResult === 'recovered') {
        finishRecoveredPageQualityFailure(event, page)
        return true
      }
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
    const rawPage = queryOne<OcrPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
    const page = rawPage ? hydratePagePayloadRows([rawPage])[0] : null
    if (!page?.image_path) {
      throw new Error('当前页面缺少图像，无法重做版面切分')
    }
    const doc = queryOne<OcrDocumentRow>('SELECT * FROM documents WHERE id = ?', [page.doc_id])
    if (!doc) {
      throw new Error('当前页面所属文献不存在')
    }

    run(`UPDATE pages SET proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END WHERE id = ?`, [pageId])
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
      const qualityFailureMessage = (error as Error)?.message || String(error || 'Rerun page layout failed')
      const qualityFailureSaveResult = await savePageQualityFailureOcrError(pageId, error, qualityFailureMessage, 'paddle', { pageOptions: options })
      if (qualityFailureSaveResult === 'recovered') {
        finishRecoveredPageQualityFailure(event, page)
        return true
      }
      if (qualityFailureSaveResult === 'saved_error') {
        updateDocumentStatusFromPages(page.doc_id, qualityFailureMessage)
        syncDocumentProofStatus(page.doc_id)
        scheduleDatabaseSave()
      }
      console.error('[OCR] Rerun page layout failed:', error)
      throw error
    }
  })
}
