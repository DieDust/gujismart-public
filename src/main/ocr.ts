import { spawn } from 'child_process'
import { basename, dirname, extname, join } from 'path'
import { existsSync, mkdirSync, openAsBlob, statSync } from 'fs'
import { readFile, rm, stat, writeFile } from 'fs/promises'
import { app, nativeImage } from 'electron'
import { PDFDocument } from 'pdf-lib'
import { getDataDir, queryOne } from './database'
import { isAbortError } from '../shared/errors'
import { ensureOcrResultIr } from '../shared/ocr-ir'
import {
  acquirePaddleOcrToken,
  isPaddleOcrTokenFailure,
  markPaddleOcrTokenFailure,
  type PaddleOcrTokenLease,
} from './paddle-ocr-token-pool'
import type { OcrBoundingBox, OcrProfile, OcrRecognizeLayoutBlock, OcrRecognizeResult, OcrRecognizeWordResult, OcrSecondPass, PageOcrOptions } from '../shared/types'
export type { OcrProfile, OcrSecondPass, PageOcrOptions } from '../shared/types'

type JsonRecord = Record<string, unknown>
type OcrWordResult = OcrRecognizeWordResult & JsonRecord
type OcrResultPayload = OcrRecognizeResult & JsonRecord & {
  words_result?: OcrWordResult[]
  layout_result?: OcrRecognizeLayoutBlock[]
  guji_processing?: JsonRecord
}

interface OcrUploadImage {
  buffer: Buffer
  width: number | null
  height: number | null
  originalWidth: number | null
  originalHeight: number | null
  resized: boolean
}

export interface OcrPageRecord {
  id: string
  image_path?: string | null
  page_num?: number | null
}

interface LayoutLocation {
  left: number
  top: number
  width: number
  height: number
}

type OcrRect = LayoutLocation

interface LayoutBlockResult {
  [key: string]: unknown
  words: string
  raw_words?: string
  location: LayoutLocation
  label?: string
  rows?: string[][]
  table_rows?: string[][]
  cells?: Array<Record<string, unknown>>
  table_cells?: Array<Record<string, unknown>>
  html?: string
  table_html?: string
  markdown?: string
  score?: number
  reading_order?: number
  block_order?: number
  column_index?: number
  line_index?: number
  orientation?: 'vertical' | 'horizontal'
  confidence?: number
  is_guji_candidate?: boolean
  segmentation_source?: 'ocr' | 'local_second_pass' | 'manual' | 'cloud_column_ocr'
  slot_count?: number
  baseline?: [number, number, number, number] | null
  mask_polygon?: Array<{ x: number; y: number }> | null
  needs_enhancement?: boolean
  dedupe_fallback_key?: string
}

interface MarkdownImageBlock {
  location: LayoutLocation
  src: string
  alt: string
  index: number
}

export interface OcrPageResult {
  pageId: string
  result: OcrResultPayload | null
  text: string
  status: 'completed' | 'error'
  error?: string
}

export interface OcrPageProgressPayload {
  pageId: string
  pageNum?: number
  completedPages: number
  totalPages: number
  status: 'completed' | 'error'
  error?: string
  result?: OcrResultPayload | null
  text?: string
}

export interface OcrRepeatedTextIssue {
  source: string
  unit: string
  repeatCount: number
  repeatChars: number
  compactLength: number
  ratio: number
  sample: string
}

export class OcrAbortError extends Error {
  constructor(message = 'OCR 已取消') {
    super(message)
    this.name = 'AbortError'
  }
}

export function isOcrAbortError(error: unknown): boolean {
  return isAbortError(error) || (error instanceof Error && error.message.includes('OCR 已取消'))
}

interface AsyncJobStatusPayload {
  status?: string
  state?: string
  progress?: number
  pollCount?: number
  waitingMs?: number
  retryingStatusQuery?: boolean
  statusQueryError?: string
  awaitingResultFile?: boolean
  totalPages?: number
  completedPages?: number
  successPages?: number
  chunkIndex?: number
  totalChunks?: number
  chunkStartPage?: number
  chunkEndPage?: number
  fallbackWholePdf?: boolean
  fallbackReason?: string
  fullFileUpload?: boolean
  uploadPageCount?: number
  extractProgress?: {
    extractedPages?: number
    totalPages?: number
  }
  resultUrl?: {
    jsonUrl?: string
    [key: string]: unknown
  } | string
  jsonUrl?: string
  errorMsg?: string
  errorMessage?: string
}

const SYNC_OCR_ENDPOINT = 'https://xdaecbr3g41df7o7.aistudio-app.com/layout-parsing'
const ASYNC_OCR_ENDPOINT = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs'
export type AsyncOcrModel = 'PaddleOCR-VL-1.6' | 'PaddleOCR-VL-1.5' | 'PP-StructureV3' | (string & {})
const DEFAULT_ASYNC_OCR_MODEL: AsyncOcrModel = 'PaddleOCR-VL-1.6'
const DEFAULT_OCR_CONCURRENCY = 6
const MAX_OCR_CONCURRENCY = 32
const DEFAULT_DOC_CONCURRENCY = 3
export const MAX_DOC_CONCURRENCY = 20
const DEFAULT_ASYNC_PDF_CHUNK_CONCURRENCY = 1
const MAX_ASYNC_PDF_CHUNK_CONCURRENCY = 1
const MAX_RETRY_ATTEMPTS = 4
const ASYNC_OCR_QUEUE_BUSY_RETRY_ATTEMPTS = 240
const DEFAULT_OCR_UPLOAD_TIMEOUT_SECONDS = 3600
const MAX_OCR_UPLOAD_TIMEOUT_SECONDS = 86400
const DEFAULT_OCR_MAX_IMAGE_SIDE = 2200
const MAX_OCR_MAX_IMAGE_SIDE = 4096
const DEFAULT_OCR_JPEG_QUALITY = 82
const ASYNC_PDF_PAGE_THRESHOLD = 1
const OCR_LOCAL_IMAGE_COORDINATE_ALIGNMENT_VERSION = 1
const ASYNC_PDF_MAX_FILE_SIZE = 50 * 1024 * 1024
const ASYNC_PDF_TARGET_CHUNK_SIZE = 49 * 1024 * 1024
const ASYNC_PDF_HEAVY_TARGET_CHUNK_SIZE = 32 * 1024 * 1024
// The official hosted API only processes the first 100 pages of one submitted
// file. This boundary also lets a failed chunk switch tokens without re-running
// chunks whose results have already been persisted.
const ASYNC_PDF_MAX_PAGES_PER_JOB = 100
const PDF_LIB_CHUNK_PLAN_MAX_FILE_SIZE = ASYNC_PDF_MAX_FILE_SIZE
const ASYNC_POLL_MIN_INTERVAL_MS = 1200
const ASYNC_POLL_BASE_INTERVAL_MS = 5000
const ASYNC_POLL_MAX_INTERVAL_MS = 12000
const ASYNC_STATUS_QUERY_TIMEOUT_MS = 30 * 1000
const ASYNC_RESULT_FILE_NOT_READY_PREFIX = '[async_result_file_not_ready]'
const ASYNC_JOB_STALLED_PREFIX = '[async_job_stalled]'
const ASYNC_RESULT_READY_GRACE_MS = 3 * 60 * 1000
const ASYNC_RESULT_DOWNLOAD_IDLE_TIMEOUT_MS = 3 * 60 * 1000
const ASYNC_JOB_STALLED_TIMEOUT_MS = 10 * 60 * 1000
const ASYNC_JOB_STALLED_AFTER_PROGRESS_TIMEOUT_MS = 3 * 60 * 1000
const ASYNC_PDF_STALLED_PAGE_RANGE_CHUNK_SIZE = 10
const ASYNC_RESULT_PARSE_YIELD_LINE_INTERVAL = 100
const ASYNC_RESULT_NORMALIZE_CHUNK_SIZE = 50
const OCR_REPEATED_TEXT_SCAN_LIMIT = 60_000
const OCR_REPEATED_TEXT_MAX_UNIT_LENGTH = 18
const OCR_REPEATED_TEXT_MIN_COMPACT_LENGTH = 1_200
const QPDF_CHUNK_TIMEOUT_MS = 120 * 1000
const QPDF_HEAVY_CHUNK_TIMEOUT_MS = 240 * 1000
const QPDF_PAGE_COUNT_TIMEOUT_MS = 30 * 1000
const DEFAULT_GUJI_OPTIONS: Required<PageOcrOptions> = {
  profile: 'guji_print_vertical',
  secondPass: 'local_segmentation',
  imageRotation: 0,
}
const DEFAULT_GENERAL_OPTIONS: Required<PageOcrOptions> = {
  profile: 'general',
  secondPass: 'none',
  imageRotation: 0,
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecordValue(source: unknown, key: string): unknown {
  return isJsonRecord(source) ? source[key] : undefined
}

function firstRecordValue(source: unknown, keys: string[]): unknown {
  for (const key of keys) {
    const value = readRecordValue(source, key)
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isJsonRecord) : []
}

function firstNonEmptyArray(values: unknown[]): unknown[] {
  for (const value of values) {
    const arrayValue = asUnknownArray(value)
    if (arrayValue.length > 0) return arrayValue
  }
  return []
}

function valueText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).replace(/\s+/g, ' ').trim()
  }
  return ''
}

function rawPrimitiveText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim()
  }
  return ''
}

function firstText(source: unknown, keys: string[]): string {
  for (const key of keys) {
    const text = valueText(readRecordValue(source, key))
    if (text) return text
  }
  return ''
}

function firstRawText(source: unknown, keys: string[]): string {
  for (const key of keys) {
    const text = rawPrimitiveText(readRecordValue(source, key))
    if (text) return text
  }
  return ''
}

function finiteNumber(value: unknown): number | null {
  const next = Number(value)
  return Number.isFinite(next) ? next : null
}

function nonNegativeIntField(source: unknown, keys: string[], fallback = 0): number {
  const value = finiteNumber(firstRecordValue(source, keys))
  return value === null ? fallback : Math.max(0, Math.floor(value))
}

function positiveNumber(value: unknown): number | null {
  const numberValue = finiteNumber(value)
  return numberValue && numberValue > 0 ? numberValue : null
}

function isOcrResultPayload(value: unknown): value is OcrResultPayload {
  if (!isJsonRecord(value)) return false
  return Array.isArray(value.layout_result)
    || Array.isArray(value.words_result)
    || isJsonRecord(value.gujismart_ir)
    || typeof value.text === 'string'
    || typeof value.ir_text === 'string'
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

const asyncSubmitLimit = createLimiter(MAX_DOC_CONCURRENCY)
const asyncPollLimit = createLimiter(16)
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OcrAbortError()
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new OcrAbortError())
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function getNumericSetting(key: string, fallback: number, max: number): number {
  const row = queryOne("SELECT value FROM settings WHERE key = ?", [key]) as { value?: string } | null
  const parsed = Number(row?.value || fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.round(parsed)))
}

function getNumericSettingInRange(key: string, fallback: number, min: number, max: number): number {
  const row = queryOne("SELECT value FROM settings WHERE key = ?", [key]) as { value?: string } | null
  const parsed = Number(row?.value || fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

export function getOcrConcurrency(): number {
  return getNumericSetting('ocr_concurrency', DEFAULT_OCR_CONCURRENCY, MAX_OCR_CONCURRENCY)
}

function normalizeOcrPageConcurrency(value: unknown, fallback = DEFAULT_OCR_CONCURRENCY): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(MAX_OCR_CONCURRENCY, Math.round(parsed)))
}

export function normalizeOcrDocumentConcurrency(value: unknown, fallback = DEFAULT_DOC_CONCURRENCY): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(MAX_DOC_CONCURRENCY, Math.round(parsed)))
}

export function getOcrDocumentConcurrency(requested?: unknown): number {
  if (requested !== undefined && requested !== null) {
    return normalizeOcrDocumentConcurrency(requested)
  }
  return getNumericSetting('batch_size', DEFAULT_DOC_CONCURRENCY, MAX_DOC_CONCURRENCY)
}

function getAsyncPdfChunkConcurrency(): number {
  return getNumericSetting('ocr_async_pdf_chunk_concurrency', DEFAULT_ASYNC_PDF_CHUNK_CONCURRENCY, MAX_ASYNC_PDF_CHUNK_CONCURRENCY)
}

function normalizeAsyncOcrModel(model: unknown): AsyncOcrModel {
  const value = String(model || '').trim()
  if (/^PaddleOCR-VL(?:-|$)/i.test(value) || /^PP-Structure/i.test(value)) return value
  if (value === 'PaddleOCR-VL') return DEFAULT_ASYNC_OCR_MODEL
  return DEFAULT_ASYNC_OCR_MODEL
}

function getAsyncOcrModel(): AsyncOcrModel {
  const row = queryOne("SELECT value FROM settings WHERE key = 'ocr_async_model'") as { value?: string } | null
  return normalizeAsyncOcrModel(row?.value || DEFAULT_ASYNC_OCR_MODEL)
}

function getOcrUploadTimeoutMs(): number {
  return getNumericSettingInRange(
    'ocr_upload_timeout_seconds',
    DEFAULT_OCR_UPLOAD_TIMEOUT_SECONDS,
    0,
    MAX_OCR_UPLOAD_TIMEOUT_SECONDS,
  ) * 1000
}

function getOcrImageUploadSettings(): { maxImageSide: number; jpegQuality: number } {
  return {
    maxImageSide: getNumericSettingInRange('ocr_max_image_side', DEFAULT_OCR_MAX_IMAGE_SIDE, 800, MAX_OCR_MAX_IMAGE_SIDE),
    jpegQuality: getNumericSettingInRange('ocr_jpeg_quality', DEFAULT_OCR_JPEG_QUALITY, 50, 95),
  }
}

async function fetchWithTimeout(input: Parameters<typeof fetch>[0], init: RequestInit, timeoutMs: number, timeoutMessage: string): Promise<Response> {
  const externalSignal = init.signal ?? undefined
  throwIfAborted(externalSignal)
  if (timeoutMs <= 0 && !externalSignal) {
    return fetch(input, init)
  }

  const controller = new AbortController()
  let didTimeout = false
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        didTimeout = true
        controller.abort()
      }, timeoutMs)
    : null
  const onAbort = () => controller.abort()
  externalSignal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } catch (error: unknown) {
    if (isAbortError(error)) {
      if (externalSignal?.aborted && !didTimeout) {
        throw new OcrAbortError()
      }
      throw new Error(timeoutMessage)
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onAbort)
  }
}

function getAsyncPdfWorkerCount(plan: PdfChunkPlan): number {
  const configured = getAsyncPdfChunkConcurrency()
  if (plan.sourceSize >= 900 * 1024 * 1024 || plan.totalPages >= 2500) {
    return Math.min(2, configured, Math.max(1, plan.estimatedTotalChunks))
  }
  return Math.min(configured, Math.max(1, plan.estimatedTotalChunks))
}

function isRetryableFailure(status?: number, code?: number | string): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true
  const codeText = String(code || '')
  return codeText === '10010' || codeText === '12002' || codeText === '408' || codeText === '409' || codeText === '425' || codeText === '429' || codeText === '500' || codeText === '502' || codeText === '503' || codeText === '504'
}

function isAsyncOcrQueueBusyError(error: Error & { status?: number; code?: number | string }): boolean {
  const message = String(error.message || '').toLowerCase()
  return (
    String(error.code || '') === '10010'
    || /queue|busy|submission queue|capacity/.test(message)
    || /队列|排队|繁忙|稍后|限流|频繁|并发|提交队列已满/.test(message)
  )
}

function isRetryableNetworkFailure(error: Error & { status?: number; code?: number | string }): boolean {
  if (isAsyncOcrQueueBusyError(error)) return true
  if (isRetryableFailure(error.status, error.code)) return true
  const message = String(error.message || '').toLowerCase()
  return /fetch|network|socket|econn|etimedout|eai_again|aborted|timeout|超时|网络/.test(message)
}

function isAsyncPdfUploadUnsupportedError(error: unknown): boolean {
  if (isOcrAbortError(error)) return false
  const failure = error as Error & { status?: number }
  if (isAsyncOcrQueueBusyError(failure)) return false
  if (failure.status === 400 || failure.status === 404 || failure.status === 413 || failure.status === 415 || failure.status === 422) return true
  const message = String(failure?.message || error || '').toLowerCase()
  return /async pdf|pdf job|job upload|unsupported.*pdf|file too large|too many pages|payload too large|status(?: code)? 4(?:00|04|13|15|22)|状态码 4(?:00|04|13|15|22)/i.test(message)
}

function isAsyncJobStalledError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '')
  return message.includes(ASYNC_JOB_STALLED_PREFIX)
    || /异步任务长时间没有进展|状态查询长时间没有进展|long time without progress|stalled/i.test(message)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function resolveOcrOptions(options?: PageOcrOptions): Required<PageOcrOptions> {
  if (options?.profile === 'guji_print_vertical') {
    return {
      profile: 'guji_print_vertical',
      secondPass: options.secondPass || 'local_segmentation',
      imageRotation: options.imageRotation === 90 ? 90 : 0,
    }
  }
  return {
    profile: 'general',
    secondPass: options?.secondPass || 'none',
    imageRotation: options?.imageRotation === 90 ? 90 : 0,
  }
}

function createMaskPolygon(location: LayoutLocation): Array<{ x: number; y: number }> {
  return [
    { x: location.left, y: location.top },
    { x: location.left + location.width, y: location.top },
    { x: location.left + location.width, y: location.top + location.height },
    { x: location.left, y: location.top + location.height },
  ]
}

function getImageFingerprint(filePath?: string | null): string {
  if (!filePath) return ''
  try {
    const stats = statSync(filePath)
    return `${stats.size}:${Math.round(stats.mtimeMs)}`
  } catch {
    return ''
  }
}

function getImageDimensions(filePath?: string | null): { width: number; height: number } | null {
  if (!filePath) return null
  try {
    const image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) return null
    return image.getSize()
  } catch {
    return null
  }
}

export function getPageImageSize(imagePath?: string | null): { width: number; height: number } | null {
  return getImageDimensions(imagePath)
}

function mergeNumericRuns(runs: Array<[number, number]>, maxGap: number): Array<[number, number]> {
  if (runs.length === 0) return []
  const merged: Array<[number, number]> = [[runs[0][0], runs[0][1]]]
  for (let index = 1; index < runs.length; index += 1) {
    const current = runs[index]
    const previous = merged[merged.length - 1]
    if (current[0] - previous[1] <= maxGap) {
      previous[1] = Math.max(previous[1], current[1])
    } else {
      merged.push([current[0], current[1]])
    }
  }
  return merged
}

function findNumericRuns(values: number[], threshold: number, minLength: number, maxGap = 2): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let start = -1
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] >= threshold) {
      if (start < 0) start = index
    } else if (start >= 0) {
      if (index - start >= minLength) runs.push([start, index])
      start = -1
    }
  }
  if (start >= 0 && values.length - start >= minLength) runs.push([start, values.length])
  return mergeNumericRuns(runs, maxGap)
}

function getBitmapLuminance(bitmap: Buffer, imageWidth: number, x: number, y: number): number {
  const index = (y * imageWidth + x) * 4
  const b = bitmap[index]
  const g = bitmap[index + 1]
  const r = bitmap[index + 2]
  return r * 0.299 + g * 0.587 + b * 0.114
}

export function detectLocalLargeImageRegions(imagePath?: string | null): OcrRect[] {
  const path = String(imagePath || '').trim()
  if (!path) return []
  try {
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return []
    const size = image.getSize()
    if (size.width <= 0 || size.height <= 0) return []
    const bitmap = image.toBitmap()
    const sampleStep = Math.max(1, Math.ceil(Math.max(size.width, size.height) / 1400))
    const sampleWidth = Math.ceil(size.width / sampleStep)
    const sampleHeight = Math.ceil(size.height / sampleStep)
    const rowInk = new Array<number>(sampleHeight).fill(0)

    for (let sampleY = 0; sampleY < sampleHeight; sampleY += 1) {
      const y = Math.min(size.height - 1, sampleY * sampleStep)
      let count = 0
      for (let sampleX = 0; sampleX < sampleWidth; sampleX += 1) {
        const x = Math.min(size.width - 1, sampleX * sampleStep)
        if (getBitmapLuminance(bitmap, size.width, x, y) < 210) count += 1
      }
      rowInk[sampleY] = count
    }

    const rowRuns = findNumericRuns(
      rowInk,
      Math.max(10, Math.round(sampleWidth * 0.2)),
      Math.max(8, Math.round(sampleHeight * 0.035)),
      Math.max(2, Math.round(sampleHeight * 0.006)),
    )
    const regions: OcrRect[] = []

    for (const [rowStart, rowEnd] of rowRuns) {
      const bandSampleHeight = Math.max(1, rowEnd - rowStart)
      const colInk = new Array<number>(sampleWidth).fill(0)
      for (let sampleX = 0; sampleX < sampleWidth; sampleX += 1) {
        const x = Math.min(size.width - 1, sampleX * sampleStep)
        let count = 0
        for (let sampleY = rowStart; sampleY < rowEnd; sampleY += 1) {
          const y = Math.min(size.height - 1, sampleY * sampleStep)
          if (getBitmapLuminance(bitmap, size.width, x, y) < 210) count += 1
        }
        colInk[sampleX] = count
      }

      const colRuns = findNumericRuns(
        colInk,
        Math.max(4, Math.round(bandSampleHeight * 0.12)),
        Math.max(8, Math.round(sampleWidth * 0.06)),
        Math.max(2, Math.round(sampleWidth * 0.006)),
      )
      const widestColRun = colRuns
        .map((run) => ({ run, width: run[1] - run[0] }))
        .sort((left, right) => right.width - left.width)[0]?.run
      if (!widestColRun) continue

      const left = Math.max(0, widestColRun[0] * sampleStep)
      const top = Math.max(0, rowStart * sampleStep)
      const right = Math.min(size.width, widestColRun[1] * sampleStep)
      const bottom = Math.min(size.height, rowEnd * sampleStep)
      const rect = { left, top, width: right - left, height: bottom - top }
      if (rect.width < size.width * 0.18 || rect.height < size.height * 0.08) continue
      regions.push(rect)
    }

    return regions.sort((left, right) => left.top - right.top || left.left - right.left)
  } catch {
    return []
  }
}

export async function prepareImageForOcrUpload(filePath: string): Promise<OcrUploadImage> {
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) {
    return {
      buffer: await readFile(filePath),
      width: null,
      height: null,
      originalWidth: null,
      originalHeight: null,
      resized: false,
    }
  }

  const settings = getOcrImageUploadSettings()
  const originalBytes = (await stat(filePath)).size
  const size = image.getSize()
  const longestSide = Math.max(size.width, size.height)
  const resized = longestSide > settings.maxImageSide
    ? image.resize({
        width: size.width >= size.height
          ? settings.maxImageSide
          : Math.max(1, Math.round(size.width * settings.maxImageSide / size.height)),
        height: size.height > size.width
          ? settings.maxImageSide
          : Math.max(1, Math.round(size.height * settings.maxImageSide / size.width)),
        quality: 'best',
      })
    : image
  const compressed = resized.toJPEG(settings.jpegQuality)
  const resizedSize = resized.getSize()

  if (compressed.length > 0 && compressed.length < originalBytes) {
    return {
      buffer: compressed,
      width: resizedSize.width,
      height: resizedSize.height,
      originalWidth: size.width,
      originalHeight: size.height,
      resized: resizedSize.width !== size.width || resizedSize.height !== size.height,
    }
  }

  return {
    buffer: await readFile(filePath),
    width: size.width,
    height: size.height,
    originalWidth: size.width,
    originalHeight: size.height,
    resized: false,
  }
}

function smoothSeries(values: number[], radius = 2): number[] {
  return values.map((_, index) => {
    let total = 0
    let count = 0
    for (let offset = -radius; offset <= radius; offset += 1) {
      const nextIndex = index + offset
      if (nextIndex >= 0 && nextIndex < values.length) {
        total += values[nextIndex]
        count += 1
      }
    }
    return count > 0 ? total / count : values[index]
  })
}

function mergeRuns(runs: Array<{ start: number; end: number }>, gap = 3): Array<{ start: number; end: number }> {
  if (runs.length === 0) return []
  const merged = [{ ...runs[0] }]
  for (let index = 1; index < runs.length; index += 1) {
    const last = merged[merged.length - 1]
    const current = runs[index]
    if (current.start - last.end <= gap) {
      last.end = current.end
    } else {
      merged.push({ ...current })
    }
  }
  return merged
}

function findInkRuns(series: number[], threshold: number, minSize: number): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = []
  let start = -1
  for (let index = 0; index < series.length; index += 1) {
    if (series[index] >= threshold) {
      if (start === -1) start = index
    } else if (start !== -1) {
      if (index - start >= minSize) {
        runs.push({ start, end: index })
      }
      start = -1
    }
  }
  if (start !== -1 && series.length - start >= minSize) {
    runs.push({ start, end: series.length })
  }
  return mergeRuns(runs)
}

function hasHorizontalTextSignals(box: { words?: string; label?: string }): boolean {
  const label = String(box.label || '').toLowerCase()
  if (/vertical[_\s-]*text|col[_\s-]*text|column[_\s-]*text|vertical|竖排|豎排|直排|縦書き|縦組み/i.test(label)) return false
  if (/horizontal[_\s-]*text|row[_\s-]*text|horizontal|横排|橫排|横書き|横組み/i.test(label)) return true
  if (isNaturallyHorizontalLabel(label)) return true
  if (/toc|contents|catalog|table_of_contents|目录|目次/.test(label)) return true
  const text = String(box.words || '')
  if (!text.trim()) return false
  const compact = text.replace(/\s+/g, '')
  const lines = text.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean)
  const asciiCount = Array.from(compact).filter((char) => /[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)).length
  const asciiRatio = asciiCount / Math.max(1, compact.length)
  const leaderLineCount = lines.filter((line) => /[.．·•]{3,}|…{2,}/.test(line)).length
  const pageNumberLineCount = lines.filter((line) => /(?:[.．·•…]\s*){2,}(?:[ivxlcdm]+|\d{1,4})\s*$/i.test(line) || /\s(?:[ivxlcdm]+|\d{1,4})\s*$/i.test(line)).length
  if (lines.length >= 3 && (leaderLineCount >= 1 || pageNumberLineCount >= Math.min(3, lines.length))) return true
  return asciiRatio > 0.18
}

function isNaturallyHorizontalLabel(label: string): boolean {
  const normalized = String(label || '').toLowerCase().replace(/[_-]+/g, ' ')
  return /\b(?:doc title|document title|paragraph title|title|heading|section title|abstract|reference|references|caption|figure caption|table caption|header|footer|number|page number|keyword|keywords|author|journal|date)\b/.test(normalized)
    || /标题|题名|篇题|摘要|关键词|作者|页眉|页脚|页码|参考/.test(normalized)
}

function hasModernHorizontalParagraphSignals(box: { location?: { width: number; height: number }; words?: string; label?: string }): boolean {
  const label = String(box.label || '').toLowerCase()
  if (!/^(?:text|paragraph|body)$/.test(label)) return false
  const rect = box.location
  const text = String(box.words || '').trim()
  const compact = text.replace(/\s+/g, '')
  if (!rect || compact.length < 80) return false
  if (rect.width < 160) return false
  const punctuationCount = Array.from(compact).filter((char) => /[，。；：！？、“”‘’（）《》,.!?;:]/.test(char)).length
  return punctuationCount / Math.max(1, compact.length) >= 0.045
}

function inferOrientation(box: { location?: { width: number; height: number }; words?: string; label?: string }): 'vertical' | 'horizontal' {
  const label = String(box.label || '').toLowerCase()
  const width = box.location?.width || 0
  const height = box.location?.height || 0
  const stronglyVerticalShape = width > 0 && height >= width * 1.8
  const stronglyHorizontalShape = width > 0 && height > 0 && width >= height * 1.72
  const explicitOrientation = readRecordValue(box, 'orientation')
  if (hasModernHorizontalParagraphSignals(box)) return 'horizontal'
  if (explicitOrientation === 'vertical' || explicitOrientation === 'horizontal') return explicitOrientation
  if (/vertical[_\s-]*text|col[_\s-]*text|column[_\s-]*text|vertical|竖排|豎排|直排|縦書き|縦組み/i.test(label)) return 'vertical'
  if (/horizontal[_\s-]*text|row[_\s-]*text|horizontal|横排|橫排|横書き|横組み/i.test(label)) return 'horizontal'
  if ((isNaturallyHorizontalLabel(label) || stronglyHorizontalShape) && !stronglyVerticalShape) return 'horizontal'
  if (hasHorizontalTextSignals(box)) return 'horizontal'
  return height >= width * 1.2 ? 'vertical' : 'horizontal'
}

function inferGujiVerticalOrientation(box: { location?: { width: number; height: number }; words?: string; label?: string }): 'vertical' | 'horizontal' {
  const label = String(box.label || '').toLowerCase()
  const width = box.location?.width || 0
  const height = box.location?.height || 0
  const words = String(box.words || '')
  const textLength = words.replace(/\s+/g, '').length
  const tallBodyShape = width > 0 && height >= width * 1.28
  const stronglyTallBodyShape = width > 0 && height >= width * 1.65
  const naturalHorizontal = isNaturallyHorizontalLabel(label) || hasModernHorizontalParagraphSignals(box)
  if (/vertical[_\s-]*text|col[_\s-]*text|column[_\s-]*text|vertical/i.test(label)) return 'vertical'
  if (stronglyTallBodyShape && textLength >= 2) return 'vertical'
  if (width > 0 && height >= width * 1.05 && textLength >= 24 && looksLikeCjkDominantText(words)) return 'vertical'
  if ((stronglyTallBodyShape || (tallBodyShape && textLength >= 8)) && !naturalHorizontal) return 'vertical'
  return inferOrientation(box)
}

function annotateReadingOrder<T extends {
  location: { left: number; top: number; width: number; height: number }
  score?: number
  slot_count?: number
  segmentation_source?: LayoutBlockResult['segmentation_source']
  block_order?: number
  reading_order?: number
  column_index?: number
  line_index?: number
  label?: string
}>(
  boxes: T[],
  preferGujiVertical = false,
): Array<T & {
  reading_order: number
  column_index: number
  line_index: number
  orientation: 'vertical' | 'horizontal'
  confidence: number
  is_guji_candidate: boolean
  segmentation_source: NonNullable<LayoutBlockResult['segmentation_source']>
  slot_count: number
  baseline: null
  mask_polygon: Array<{ x: number; y: number }>
}> {
  if (boxes.length === 0) return []

  const sourceOrderCandidates = boxes.filter((box) => !isDecorativeOcrLabel(box.label))
  const hasStableSourceOrder = sourceOrderCandidates
    .filter((box) => Number.isFinite(Number(box.block_order)) && Number(box.block_order) > 0)
    .length >= Math.max(2, Math.ceil(Math.max(1, sourceOrderCandidates.length) * 0.6))
  if (hasStableSourceOrder) {
    return boxes
      .map((box, index) => ({ box, index }))
      .sort((left, right) => {
        const leftOrder = Number(left.box.block_order)
        const rightOrder = Number(right.box.block_order)
        const leftHasContentOrder = Number.isFinite(leftOrder) && leftOrder > 0
        const rightHasContentOrder = Number.isFinite(rightOrder) && rightOrder > 0
        if (leftHasContentOrder !== rightHasContentOrder) return leftHasContentOrder ? -1 : 1
        if (leftHasContentOrder && rightHasContentOrder) return leftOrder - rightOrder || left.index - right.index
        return left.index - right.index
      })
      .map(({ box }, index) => {
        const orientation = preferGujiVertical ? inferGujiVerticalOrientation(box) : inferOrientation(box)
        return {
          ...(box as T),
          reading_order: index,
          column_index: Number.isFinite(Number(box.column_index)) ? Number(box.column_index) : 0,
          line_index: Number.isFinite(Number(box.line_index)) ? Number(box.line_index) : index,
          orientation,
          confidence: typeof box.score === 'number' ? box.score : 1,
          is_guji_candidate: orientation === 'vertical',
          segmentation_source: box.segmentation_source || 'ocr',
          slot_count: Number.isFinite(box.slot_count) ? Number(box.slot_count) : Math.max(1, Math.round((box.location.height || 0) / Math.max(12, box.location.width || 1))),
          baseline: null,
          mask_polygon: createMaskPolygon(box.location),
        }
      })
  }

  const avgWidth = boxes.reduce((sum, box) => sum + box.location.width, 0) / boxes.length
  const threshold = Math.max(20, avgWidth * 0.65)

  const candidates = boxes
    .map((box, index) => ({
      ...box,
      __index: index,
      __centerX: box.location.left + box.location.width / 2,
    }))
    .sort((left, right) => right.__centerX - left.__centerX)

  const columns: Array<{ centerX: number; items: typeof candidates }> = []
  candidates.forEach((box) => {
    const column = columns.find((item) => Math.abs(item.centerX - box.__centerX) <= threshold)
    if (column) {
      column.items.push(box)
      column.centerX = (column.centerX * (column.items.length - 1) + box.__centerX) / column.items.length
    } else {
      columns.push({ centerX: box.__centerX, items: [box] })
    }
  })

  columns.sort((left, right) => right.centerX - left.centerX)

  const ordered: Array<T & {
    reading_order: number
    column_index: number
    line_index: number
    orientation: 'vertical' | 'horizontal'
    confidence: number
    is_guji_candidate: boolean
    segmentation_source: NonNullable<LayoutBlockResult['segmentation_source']>
    slot_count: number
    baseline: null
    mask_polygon: Array<{ x: number; y: number }>
  }> = []

  columns.forEach((column, columnIndex) => {
    column.items
      .sort((left, right) => left.location.top - right.location.top || right.location.left - left.location.left)
      .forEach((box, lineIndex) => {
        const orientation = preferGujiVertical ? inferGujiVerticalOrientation(box) : inferOrientation(box)
        ordered.push({
          ...(box as T),
          reading_order: ordered.length,
          column_index: columnIndex,
          line_index: lineIndex,
          orientation,
          confidence: typeof box.score === 'number' ? box.score : 1,
          is_guji_candidate: orientation === 'vertical',
          segmentation_source: box.segmentation_source || 'ocr',
          slot_count: Number.isFinite(box.slot_count) ? Number(box.slot_count) : Math.max(1, Math.round((box.location.height || 0) / Math.max(12, box.location.width || 1))),
          baseline: null,
          mask_polygon: createMaskPolygon(box.location),
        })
      })
  })

  return ordered
}

function shouldPreferVerticalOrder(boxes: Array<{ orientation?: 'vertical' | 'horizontal' }>): boolean {
  if (boxes.length < 3) return false
  const verticalCount = boxes.filter((box) => box.orientation === 'vertical').length
  return verticalCount / boxes.length >= 0.4
}

function shouldAutoUseVerticalPostProcessing(result: unknown): boolean {
  const normalized = normalizePageResult(result)
  const boxes = asLayoutBlockResults(normalized.layout_result)
  if (boxes.length < 3) return false
  const textBoxes = boxes.filter((box) => String(box.words || '').trim())
  if (textBoxes.length < 3) return false
  const verticalCount = textBoxes.filter((box) => {
    if (box.orientation === 'vertical') return true
    const width = Number(box.location?.width || 0)
    const height = Number(box.location?.height || 0)
    return width > 0 && height >= width * 1.28
  }).length
  return verticalCount >= 3 && verticalCount / textBoxes.length >= 0.55
}

function shouldSplitVerticalBlock(block: LayoutBlockResult): boolean {
  if (inferOrientation(block) !== 'vertical') return false
  const text = String(block.words || '').replace(/\s+/g, '')
  const width = block.location?.width || 0
  const height = block.location?.height || 0
  if (text.length < 12) return false
  if (width < 42 || height < 160) return false
  return width >= Math.max(48, height * 0.08)
}

function looksLikeCjkVerticalCandidateText(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  if (compact.length < 24) return false
  const cjkCount = Array.from(compact).filter((char) => /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(char)).length
  const latinCount = Array.from(compact).filter((char) => /[A-Za-z]/.test(char)).length
  const bulletCount = Array.from(compact).filter((char) => /[○〇●◎・]/.test(char)).length
  return cjkCount / Math.max(1, compact.length) >= 0.55
    && latinCount / Math.max(1, compact.length) <= 0.28
    && (bulletCount >= 2 || /[。．、，]/.test(compact))
}

function looksLikeCjkDominantText(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  if (compact.length < 24) return false
  const cjkCount = Array.from(compact).filter((char) => /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(char)).length
  const latinCount = Array.from(compact).filter((char) => /[A-Za-z]/.test(char)).length
  return cjkCount / Math.max(1, compact.length) >= 0.5
    && latinCount / Math.max(1, compact.length) <= 0.35
}

function shouldProbeHorizontalBlockForVerticalColumns(block: LayoutBlockResult, forceVerticalProfile = false): boolean {
  if (inferOrientation(block) === 'vertical') return false
  const text = String(block.words || '')
  const compact = text.replace(/\s+/g, '')
  const rect = block.location
  if (!rect || compact.length < 36) return false
  if (!/^(?:text|paragraph|body|paragraph_title|title)?$/i.test(String(block.label || 'text'))) return false
  if (forceVerticalProfile) {
    if (!looksLikeCjkDominantText(text)) return false
  } else if (!looksLikeCjkVerticalCandidateText(text)) {
    return false
  }
  if (rect.height < 90 || rect.width < 90) return false
  if (rect.height >= rect.width * (forceVerticalProfile ? 0.55 : 1.08)) return true
  return rect.width >= 180 && rect.height >= 90 && compact.length >= (forceVerticalProfile ? 36 : 60)
}

function getPixelLuminance(bitmap: Buffer, width: number, x: number, y: number): number {
  const index = (y * width + x) * 4
  const b = bitmap[index]
  const g = bitmap[index + 1]
  const r = bitmap[index + 2]
  return r * 0.299 + g * 0.587 + b * 0.114
}

interface LocalColumnSlice {
  left: number
  width: number
  top: number
  height: number
  slotCount: number
}

function analyzeVerticalColumnsFromImage(image: Electron.NativeImage, block: LayoutBlockResult): LocalColumnSlice[] {
  if (!block.location) return []
  if (image.isEmpty()) return []

  const rect = {
    x: Math.max(0, Math.round(block.location.left)),
    y: Math.max(0, Math.round(block.location.top)),
    width: Math.max(1, Math.round(block.location.width)),
    height: Math.max(1, Math.round(block.location.height)),
  }

  const cropped = image.crop(rect)
  const { width, height } = cropped.getSize()
  if (width <= 0 || height <= 0) return []
  const bitmap = cropped.toBitmap()

  const xInk = new Array<number>(width).fill(0)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const luminance = getPixelLuminance(bitmap, width, x, y)
      if (luminance < 214) {
        xInk[x] += 1
      }
    }
  }

  const smoothedX = smoothSeries(xInk, 2)
  const maxX = Math.max(...smoothedX, 0)
  if (maxX <= 0) return []

  const xThreshold = Math.max(3, maxX * 0.2)
  const rawRuns = findInkRuns(smoothedX, xThreshold, Math.max(4, Math.round(width * 0.035)))
    .filter((run) => run.end - run.start >= Math.max(6, Math.round(width * 0.04)))

  if (rawRuns.length <= 1) return []

  const estimatedCharWidth = rawRuns.reduce((sum, run) => sum + (run.end - run.start), 0) / rawRuns.length
  const charSize = clamp(estimatedCharWidth * 0.92, 10, 160)

  return rawRuns
    .map((run) => {
      const yInk = new Array<number>(height).fill(0)
      for (let y = 0; y < height; y += 1) {
        let count = 0
        for (let x = run.start; x < run.end; x += 1) {
          const luminance = getPixelLuminance(bitmap, width, x, y)
          if (luminance < 214) {
            count += 1
          }
        }
        yInk[y] = count
      }

      const smoothedY = smoothSeries(yInk, 2)
      const maxY = Math.max(...smoothedY, 0)
      const yThreshold = Math.max(1, maxY * 0.16)
      const yRuns = findInkRuns(smoothedY, yThreshold, Math.max(6, Math.round(height * 0.03)))
      const first = yRuns[0]
      const last = yRuns[yRuns.length - 1]
      const top = first ? first.start : 0
      const bottom = last ? last.end : height
      const activeHeight = Math.max(24, bottom - top)
      const detectedSlots = Math.max(1, yRuns.length)
      const estimatedSlots = Math.max(1, Math.round(activeHeight / (charSize * 1.02)))
      const slotCount = Math.max(detectedSlots, Math.min(estimatedSlots, detectedSlots + 2))

      return {
        left: run.start + rect.x,
        width: run.end - run.start,
        top: top + rect.y,
        height: activeHeight,
        slotCount,
      }
    })
    .sort((left, right) => right.left - left.left)
}

function sliceVerticalText(words: string, capacities: number[]): string[] {
  const text = String(words || '').replace(/\s+/g, '')
  if (!text) return capacities.map(() => '')
  const segments: string[] = []
  let offset = 0
  capacities.forEach((capacity, index) => {
    const remainingColumns = capacities.length - index - 1
    const remainingText = text.length - offset
    const minimumTail = remainingColumns
    const take = Math.max(1, Math.min(capacity, remainingText - minimumTail))
    segments.push(text.slice(offset, offset + take))
    offset += take
  })
  if (offset < text.length && segments.length > 0) {
    segments[segments.length - 1] += text.slice(offset)
  }
  return segments
}

function getVerticalTextHardLines(text: string): string[] {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, '').trim())
    .filter(Boolean)
}

function getMergedWideVerticalTextLines(block: LayoutBlockResult): string[] {
  if (inferGujiVerticalOrientation(block) !== 'vertical') return []
  if (isTableLabel(block.label) || isImageLabel(block.label) || isDecorativeOcrLabel(block.label)) return []
  const rect = block.location
  const lines = getVerticalTextHardLines(block.words || '')
  if (lines.length < 2 || lines.length > 18) return []
  const compactLength = lines.join('').length
  if (compactLength < 48) return []
  const longLineCount = lines.filter((line) => line.length >= 8).length
  if (longLineCount < Math.min(2, lines.length)) return []
  if (rect.width < 96 || rect.height < 120) return []
  const columnWidth = rect.width / lines.length
  if (columnWidth < 18 || columnWidth > Math.max(88, rect.width * 0.68)) return []
  return lines
}

function isLikelyGujiTinyNoiseBlock(block: LayoutBlockResult): boolean {
  if (!block.location) return false
  if (isTableLabel(block.label) || isImageLabel(block.label)) return false
  const text = String(block.words || '').trim()
  if (!text) return false
  const compact = text.replace(/\s+/g, '')
  const width = Number(block.location.width || 0)
  const height = Number(block.location.height || 0)
  if (width <= 0 || height <= 0) return true
  const minSide = Math.min(width, height)
  const maxSide = Math.max(width, height)
  if (minSide <= 2 && maxSide >= 20) return true
  const hasCjkOrKana = /[\u3040-\u30ff\u3400-\u9fff]/.test(compact)
  if (minSide < 8 && compact.length <= 3 && !hasCjkOrKana) return true
  return false
}

function filterGujiTinyNoiseBlocks(
  result: OcrResultPayload,
  options: Required<PageOcrOptions>,
): OcrResultPayload {
  if (options.profile !== 'guji_print_vertical') return result
  const blocks = asLayoutBlockResults(result.layout_result)
  if (blocks.length === 0) return result
  const nextBlocks = blocks.filter((block) => !isLikelyGujiTinyNoiseBlock(block))
  const removedCount = blocks.length - nextBlocks.length
  if (removedCount === 0 || nextBlocks.length === 0) return result
  const orderedBlocks = annotateReadingOrder(nextBlocks, true)
  return rebuildWordsResultFromLayout({
    ...result,
    layout_result: orderedBlocks,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      removed_tiny_noise_blocks: removedCount,
    },
  })
}

function splitMergedWideVerticalTextBlock(block: LayoutBlockResult): LayoutBlockResult[] {
  const lines = getMergedWideVerticalTextLines(block)
  if (lines.length <= 1) return [block]
  const rect = block.location
  const columnWidth = rect.width / lines.length
  return lines.map((line, index) => {
    const left = rect.left + rect.width - (index + 1) * columnWidth
    const location = {
      left: Math.round(left),
      top: rect.top,
      width: Math.max(1, Math.round(columnWidth)),
      height: rect.height,
    }
    return {
      ...block,
      words: line,
      raw_words: line,
      location,
      orientation: 'vertical',
      segmentation_source: 'local_second_pass',
      column_index: index,
      line_index: 0,
      slot_count: Math.max(1, line.length),
      mask_polygon: createMaskPolygon(location),
      needs_enhancement: true,
      merged_vertical_line_split: true,
    }
  })
}

function splitMergedWideVerticalTextLineBlocks(
  result: OcrResultPayload,
  options: Required<PageOcrOptions>,
): OcrResultPayload {
  if (options.profile !== 'guji_print_vertical') return result
  const blocks = asLayoutBlockResults(result.layout_result)
  if (blocks.length === 0) return result
  const nextBlocks: LayoutBlockResult[] = []
  let splitBlockCount = 0
  let splitColumnCount = 0
  for (const block of blocks) {
    const splitBlocks = splitMergedWideVerticalTextBlock(block)
    if (splitBlocks.length > 1) {
      splitBlockCount += 1
      splitColumnCount += splitBlocks.length
    }
    nextBlocks.push(...splitBlocks)
  }
  if (splitBlockCount === 0) return result
  const orderedBlocks = annotateReadingOrder(nextBlocks, true)
  return rebuildWordsResultFromLayout({
    ...result,
    layout_result: orderedBlocks,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      merged_wide_vertical_line_blocks_split: splitBlockCount,
      merged_wide_vertical_line_columns: splitColumnCount,
    },
  })
}

function getCoordinateSourceDimensions(result: OcrResultPayload): { width?: number; height?: number } {
  const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  const preserveServiceCoordinates = readRecordValue(gujiProcessing, 'ocr_service_coordinates_preserved') === true
  const width = positiveNumber(firstRecordValue(result, ['page_width', 'image_width', 'width', 'source_image_width']))
    ?? (!preserveServiceCoordinates ? positiveNumber(readRecordValue(gujiProcessing, 'source_image_width')) : null)
  const height = positiveNumber(firstRecordValue(result, ['page_height', 'image_height', 'height', 'source_image_height']))
    ?? (!preserveServiceCoordinates ? positiveNumber(readRecordValue(gujiProcessing, 'source_image_height')) : null)
  return {
    width: width || undefined,
    height: height || undefined,
  }
}

function attachProcessingMeta(
  result: OcrResultPayload,
  options: Required<PageOcrOptions>,
  imagePath?: string | null,
  metaOptions: { preserveServiceCoordinates?: boolean } = {},
): OcrResultPayload {
  const dimensions = metaOptions.preserveServiceCoordinates ? getCoordinateSourceDimensions(result) : getImageDimensions(imagePath)
  return {
    ...result,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      profile: options.profile,
      second_pass: options.secondPass,
      source_image_fingerprint: metaOptions.preserveServiceCoordinates ? '' : getImageFingerprint(imagePath),
      source_image_width: dimensions?.width || null,
      source_image_height: dimensions?.height || null,
      updated_at: new Date().toISOString(),
    },
  }
}

function pointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number {
  if (isJsonRecord(point)) return Number(point[key] ?? 0)
  if (Array.isArray(point)) return Number(point[tupleIndex] ?? 0)
  return 0
}

function toLocationRect(coord: unknown): LayoutLocation | null {
  if (!coord) return null

  if (Array.isArray(coord) && coord.length >= 4) {
    if (typeof coord[0] === 'number') {
      const numericCoords = coord.map(Number)
      if (coord.length >= 8) {
        const xs = [numericCoords[0], numericCoords[2], numericCoords[4], numericCoords[6]]
        const ys = [numericCoords[1], numericCoords[3], numericCoords[5], numericCoords[7]]
        const left = Math.min(...xs)
        const top = Math.min(...ys)
        return {
          left: Math.round(left),
          top: Math.round(top),
          width: Math.round(Math.max(...xs) - left),
          height: Math.round(Math.max(...ys) - top),
        }
      }

      const [xmin, ymin, xmax, ymax] = numericCoords
      return {
        left: Math.round(xmin),
        top: Math.round(ymin),
        width: Math.round(xmax - xmin),
        height: Math.round(ymax - ymin),
      }
    }

    if (typeof coord[0] === 'object') {
      const xs = coord.map((point) => pointCoordinate(point, 'x', 0))
      const ys = coord.map((point) => pointCoordinate(point, 'y', 1))
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return {
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(Math.max(...xs) - left),
        height: Math.round(Math.max(...ys) - top),
      }
    }
  }

  if (
    isJsonRecord(coord)
    && coord.left !== undefined
    && coord.top !== undefined
    && coord.width !== undefined
    && coord.height !== undefined
  ) {
    return {
      left: Math.round(Number(coord.left)),
      top: Math.round(Number(coord.top)),
      width: Math.round(Number(coord.width)),
      height: Math.round(Number(coord.height)),
    }
  }

  return null
}

function asSegmentationSource(value: unknown): LayoutBlockResult['segmentation_source'] | undefined {
  if (value === 'ocr' || value === 'local_second_pass' || value === 'manual' || value === 'cloud_column_ocr') return value
  return undefined
}

function scalePoint(value: unknown, scaleX: number, scaleY: number): unknown {
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      const next = [...value]
      next[0] = Math.round(Number(value[0]) * scaleX)
      next[1] = Math.round(Number(value[1]) * scaleY)
      return next
    }
    return value.map((point) => scalePoint(point, scaleX, scaleY))
  }
  if (!isJsonRecord(value)) return value
  const next = { ...value }
  if (Number.isFinite(Number(next.x))) next.x = Math.round(Number(next.x) * scaleX)
  if (Number.isFinite(Number(next.y))) next.y = Math.round(Number(next.y) * scaleY)
  return next
}

function scaleCoordinateValue(value: unknown, scaleX: number, scaleY: number): unknown {
  if (Array.isArray(value)) {
    if (value.length >= 8 && value.every((item) => typeof item === 'number')) {
      return value.map((item, index) => Math.round(Number(item) * (index % 2 === 0 ? scaleX : scaleY)))
    }
    if (value.length >= 4 && value.every((item) => typeof item === 'number')) {
      return [
        Math.round(Number(value[0]) * scaleX),
        Math.round(Number(value[1]) * scaleY),
        Math.round(Number(value[2]) * scaleX),
        Math.round(Number(value[3]) * scaleY),
        ...value.slice(4),
      ]
    }
    return value.map((point) => scalePoint(point, scaleX, scaleY))
  }
  if (!isJsonRecord(value)) return value
  const next = { ...value }
  if (Number.isFinite(Number(next.left))) next.left = Math.round(Number(next.left) * scaleX)
  if (Number.isFinite(Number(next.top))) next.top = Math.round(Number(next.top) * scaleY)
  if (Number.isFinite(Number(next.width))) next.width = Math.round(Number(next.width) * scaleX)
  if (Number.isFinite(Number(next.height))) next.height = Math.round(Number(next.height) * scaleY)
  if (Number.isFinite(Number(next.x))) next.x = Math.round(Number(next.x) * scaleX)
  if (Number.isFinite(Number(next.y))) next.y = Math.round(Number(next.y) * scaleY)
  return next
}

function rotateClockwiseCoordinatePointToSource(point: { x: number; y: number }, sourceWidth: number): { x: number; y: number } {
  return {
    x: Math.round(sourceWidth - point.y),
    y: Math.round(point.x),
  }
}

function markServiceCoordinatesPreserved(result: OcrResultPayload): OcrResultPayload {
  const dimensions = getCoordinateSourceDimensions(result)
  const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  const fallbackWidth = finiteNumber(readRecordValue(gujiProcessing, 'service_coordinate_fallback_width'))
  const fallbackHeight = finiteNumber(readRecordValue(gujiProcessing, 'service_coordinate_fallback_height'))
  const hasServiceSize = Boolean(dimensions.width && dimensions.height)
  const hasFallbackSize = Boolean(fallbackWidth && fallbackHeight && fallbackWidth > 0 && fallbackHeight > 0)
  const sourceImageWidth = dimensions.width || readRecordValue(result, 'source_image_width') || fallbackWidth || null
  const sourceImageHeight = dimensions.height || readRecordValue(result, 'source_image_height') || fallbackHeight || null
  return {
    ...result,
    source_image_width: sourceImageWidth,
    source_image_height: sourceImageHeight,
    guji_processing: {
      ...gujiProcessing,
      source_image_width: sourceImageWidth,
      source_image_height: sourceImageHeight,
      ocr_service_coordinates_preserved: true,
      service_coordinate_source: 'paddle_async_pdf',
      service_coordinate_size_source: hasServiceSize ? 'service' : hasFallbackSize ? 'page_image_fallback' : 'missing',
    },
  }
}

function getPositiveCoordinateNumber(value: unknown): number | null {
  return positiveNumber(value)
}

function getServiceCoordinateSize(result: OcrResultPayload): { width?: number; height?: number; source: string } {
  const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  const explicitWidth = getPositiveCoordinateNumber(readRecordValue(result, 'page_width'))
    ?? getPositiveCoordinateNumber(readRecordValue(result, 'image_width'))
    ?? getPositiveCoordinateNumber(readRecordValue(result, 'source_image_width'))
    ?? getPositiveCoordinateNumber(readRecordValue(gujiProcessing, 'source_image_width'))
  const explicitHeight = getPositiveCoordinateNumber(readRecordValue(result, 'page_height'))
    ?? getPositiveCoordinateNumber(readRecordValue(result, 'image_height'))
    ?? getPositiveCoordinateNumber(readRecordValue(result, 'source_image_height'))
    ?? getPositiveCoordinateNumber(readRecordValue(gujiProcessing, 'source_image_height'))
  if (explicitWidth && explicitHeight) {
    return {
      width: explicitWidth,
      height: explicitHeight,
      source: String(readRecordValue(gujiProcessing, 'service_coordinate_size_source') || 'service'),
    }
  }

  const fallbackWidth = getPositiveCoordinateNumber(readRecordValue(gujiProcessing, 'service_coordinate_fallback_width'))
  const fallbackHeight = getPositiveCoordinateNumber(readRecordValue(gujiProcessing, 'service_coordinate_fallback_height'))
  if (fallbackWidth && fallbackHeight) {
    return {
      width: fallbackWidth,
      height: fallbackHeight,
      source: 'page_image_fallback',
    }
  }

  return { source: 'missing' }
}

function isServiceCoordinatePreservedPayload(result: OcrResultPayload): boolean {
  const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  return readRecordValue(gujiProcessing, 'ocr_service_coordinates_preserved') === true
}

function scaleOcrResultCoordinates(
  result: OcrResultPayload,
  scaleX: number,
  scaleY: number,
): OcrResultPayload {
  return {
    ...result,
    layout_result: Array.isArray(result.layout_result)
      ? result.layout_result.map((block) => scaleLayoutBlockCoordinates(block, scaleX, scaleY))
      : result.layout_result,
    words_result: Array.isArray(result.words_result)
      ? result.words_result.map((word) => scaleWordCoordinates(word, scaleX, scaleY))
      : result.words_result,
  }
}

function alignServiceCoordinatesToLocalImage(
  result: OcrResultPayload,
  imagePath: string | null | undefined,
): OcrResultPayload {
  if (!isServiceCoordinatePreservedPayload(result)) return result
  const localImageSize = getImageDimensions(imagePath)
  if (!localImageSize || localImageSize.width <= 0 || localImageSize.height <= 0) return result

  const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  const alreadyAligned = readRecordValue(gujiProcessing, 'service_coordinates_aligned_to_local_image') === OCR_LOCAL_IMAGE_COORDINATE_ALIGNMENT_VERSION
  const storedWidth = getPositiveCoordinateNumber(readRecordValue(gujiProcessing, 'source_image_width'))
    ?? getPositiveCoordinateNumber(readRecordValue(result, 'source_image_width'))
  const storedHeight = getPositiveCoordinateNumber(readRecordValue(gujiProcessing, 'source_image_height'))
    ?? getPositiveCoordinateNumber(readRecordValue(result, 'source_image_height'))
  if (
    alreadyAligned
    && storedWidth === localImageSize.width
    && storedHeight === localImageSize.height
  ) {
    return result
  }

  const serviceSize = getServiceCoordinateSize(result)
  const sourceWidth = serviceSize.width || localImageSize.width
  const sourceHeight = serviceSize.height || localImageSize.height
  const scaleX = localImageSize.width / Math.max(1, sourceWidth)
  const scaleY = localImageSize.height / Math.max(1, sourceHeight)
  const shouldScale = Math.abs(scaleX - 1) > 0.002 || Math.abs(scaleY - 1) > 0.002
  const scaled = shouldScale ? scaleOcrResultCoordinates(result, scaleX, scaleY) : result
  const alignedBase: OcrResultPayload = {
    ...scaled,
    page_width: localImageSize.width,
    page_height: localImageSize.height,
    image_width: localImageSize.width,
    image_height: localImageSize.height,
    source_image_width: localImageSize.width,
    source_image_height: localImageSize.height,
    guji_processing: {
      ...(isJsonRecord(scaled.guji_processing) ? scaled.guji_processing : {}),
      source_image_width: localImageSize.width,
      source_image_height: localImageSize.height,
      service_coordinate_original_width: sourceWidth,
      service_coordinate_original_height: sourceHeight,
      service_coordinate_original_size_source: serviceSize.source,
      service_coordinate_aligned_width: localImageSize.width,
      service_coordinate_aligned_height: localImageSize.height,
      service_coordinate_align_scale_x: Number(scaleX.toFixed(6)),
      service_coordinate_align_scale_y: Number(scaleY.toFixed(6)),
      service_coordinates_aligned_to_local_image: OCR_LOCAL_IMAGE_COORDINATE_ALIGNMENT_VERSION,
      service_coordinate_size_source: 'local_page_image',
    },
  }
  return alignedBase
}

function locationToCornerPoints(location: LayoutLocation): Array<{ x: number; y: number }> {
  return [
    { x: location.left, y: location.top },
    { x: location.left + location.width, y: location.top },
    { x: location.left + location.width, y: location.top + location.height },
    { x: location.left, y: location.top + location.height },
  ]
}

function boundingRectFromPoints(points: Array<{ x: number; y: number }>): LayoutLocation | null {
  const finitePoints = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (finitePoints.length === 0) return null
  const xs = finitePoints.map((point) => point.x)
  const ys = finitePoints.map((point) => point.y)
  const left = Math.round(Math.min(...xs))
  const top = Math.round(Math.min(...ys))
  const right = Math.round(Math.max(...xs))
  const bottom = Math.round(Math.max(...ys))
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  }
}

function rotateClockwiseLocationToSource(location: LayoutLocation, sourceWidth: number): LayoutLocation {
  return boundingRectFromPoints(
    locationToCornerPoints(location).map((point) => rotateClockwiseCoordinatePointToSource(point, sourceWidth)),
  ) || location
}

function rotateClockwiseCoordinateValueToSource(value: unknown, sourceWidth: number): unknown {
  if (Array.isArray(value)) {
    if (value.length >= 8 && value.every((item) => typeof item === 'number')) {
      const points: Array<{ x: number; y: number }> = []
      for (let index = 0; index + 1 < value.length; index += 2) {
        points.push(rotateClockwiseCoordinatePointToSource({
          x: Number(value[index]),
          y: Number(value[index + 1]),
        }, sourceWidth))
      }
      return points.flatMap((point) => [point.x, point.y])
    }
    if (value.length >= 4 && value.every((item) => typeof item === 'number')) {
      const rect = toLocationRect(value)
      const rotated = rect ? rotateClockwiseLocationToSource(rect, sourceWidth) : null
      return rotated
        ? [rotated.left, rotated.top, rotated.left + rotated.width, rotated.top + rotated.height, ...value.slice(4)]
        : value
    }
    return value.map((point) => rotateClockwiseCoordinateValueToSource(point, sourceWidth))
  }
  if (!isJsonRecord(value)) return value
  if (
    Number.isFinite(Number(value.left))
    || Number.isFinite(Number(value.top))
    || Number.isFinite(Number(value.width))
    || Number.isFinite(Number(value.height))
  ) {
    const rect = toLocationRect(value)
    if (rect) {
      return {
        ...value,
        ...rotateClockwiseLocationToSource(rect, sourceWidth),
      }
    }
  }
  if (Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) {
    return {
      ...value,
      ...rotateClockwiseCoordinatePointToSource({ x: Number(value.x), y: Number(value.y) }, sourceWidth),
    }
  }
  return value
}

function toLayoutBlockResult(block: unknown, index = 0): LayoutBlockResult | null {
  const location = toLocationRect(firstRecordValue(block, ['location', 'bbox', 'box', 'coordinate', 'points', 'block_bbox']))
  if (!location) return null
  const record = isJsonRecord(block) ? block : {}
  const score = finiteNumber(readRecordValue(block, 'score'))
  const readingOrder = finiteNumber(firstRecordValue(block, ['reading_order', 'block_order']))
  const columnIndex = finiteNumber(readRecordValue(block, 'column_index'))
  const lineIndex = finiteNumber(readRecordValue(block, 'line_index'))
  const confidence = finiteNumber(readRecordValue(block, 'confidence'))
  const words = firstRawText(block, ['words', 'text']) || getPreferredOcrBlockText(block).trim()
  return {
    ...record,
    words,
    raw_words: rawPrimitiveText(readRecordValue(block, 'raw_words')) || undefined,
    location,
    label: rawPrimitiveText(firstRecordValue(block, ['label', 'block_label', 'type'])) || undefined,
    score: score ?? undefined,
    reading_order: readingOrder ?? index,
    block_order: finiteNumber(readRecordValue(block, 'block_order')) ?? undefined,
    column_index: columnIndex ?? undefined,
    line_index: lineIndex ?? undefined,
    confidence: confidence ?? undefined,
    segmentation_source: asSegmentationSource(readRecordValue(block, 'segmentation_source')),
  }
}

function scaleLayoutLocation(location: LayoutLocation, scaleX: number, scaleY: number): LayoutLocation {
  return {
    left: Math.round(location.left * scaleX),
    top: Math.round(location.top * scaleY),
    width: Math.max(1, Math.round(location.width * scaleX)),
    height: Math.max(1, Math.round(location.height * scaleY)),
  }
}

function scaleLayoutBlockCoordinates(block: OcrRecognizeLayoutBlock, scaleX: number, scaleY: number): OcrRecognizeLayoutBlock {
  const next = { ...block } as OcrRecognizeLayoutBlock & JsonRecord
  const coordinateKeys = ['bbox', 'box', 'coordinate', 'coordinate_box', 'points', 'block_bbox']
  coordinateKeys.forEach((key) => {
    if (next[key] !== undefined) next[key] = scaleCoordinateValue(next[key], scaleX, scaleY)
  })
  if (block.location) next.location = scaleLayoutLocation(block.location as LayoutLocation, scaleX, scaleY)
  if (next.mask_polygon !== undefined) next.mask_polygon = scaleCoordinateValue(next.mask_polygon, scaleX, scaleY)
  if (Array.isArray(next.baseline) && next.baseline.length >= 4) {
    next.baseline = [
      Math.round(Number(next.baseline[0] || 0) * scaleX),
      Math.round(Number(next.baseline[1] || 0) * scaleY),
      Math.round(Number(next.baseline[2] || 0) * scaleX),
      Math.round(Number(next.baseline[3] || 0) * scaleY),
    ]
  }
  return next
}

function scaleWordCoordinates(word: OcrWordResult, scaleX: number, scaleY: number): OcrWordResult {
  const next = { ...word }
  const coordinateKeys = ['bbox', 'box', 'coordinate', 'points', 'location']
  coordinateKeys.forEach((key) => {
    if (next[key] !== undefined) next[key] = scaleCoordinateValue(next[key], scaleX, scaleY)
  })
  return next
}

function rotateClockwiseLayoutBlockCoordinatesToSource(block: OcrRecognizeLayoutBlock, sourceWidth: number): OcrRecognizeLayoutBlock {
  const next = { ...block } as OcrRecognizeLayoutBlock & JsonRecord
  const coordinateKeys = ['bbox', 'box', 'coordinate', 'coordinate_box', 'points', 'block_bbox']
  coordinateKeys.forEach((key) => {
    if (next[key] !== undefined) next[key] = rotateClockwiseCoordinateValueToSource(next[key], sourceWidth)
  })
  if (block.location) next.location = rotateClockwiseLocationToSource(block.location as LayoutLocation, sourceWidth)
  if (next.mask_polygon !== undefined) next.mask_polygon = rotateClockwiseCoordinateValueToSource(next.mask_polygon, sourceWidth)
  if (Array.isArray(next.baseline) && next.baseline.length >= 4) {
    const first = rotateClockwiseCoordinatePointToSource({ x: Number(next.baseline[0] || 0), y: Number(next.baseline[1] || 0) }, sourceWidth)
    const second = rotateClockwiseCoordinatePointToSource({ x: Number(next.baseline[2] || 0), y: Number(next.baseline[3] || 0) }, sourceWidth)
    next.baseline = [first.x, first.y, second.x, second.y]
  }
  return next
}

function rotateClockwiseWordCoordinatesToSource(word: OcrWordResult, sourceWidth: number): OcrWordResult {
  const next = { ...word }
  const coordinateKeys = ['bbox', 'box', 'coordinate', 'points', 'location']
  coordinateKeys.forEach((key) => {
    if (next[key] !== undefined) next[key] = rotateClockwiseCoordinateValueToSource(next[key], sourceWidth)
  })
  return next
}

function getRectOutOfBoundsRatio(rect: LayoutLocation, pageWidth: number, pageHeight: number): number {
  const clippedLeft = clamp(rect.left, 0, pageWidth)
  const clippedTop = clamp(rect.top, 0, pageHeight)
  const clippedRight = clamp(rect.left + rect.width, 0, pageWidth)
  const clippedBottom = clamp(rect.top + rect.height, 0, pageHeight)
  const clippedArea = Math.max(0, clippedRight - clippedLeft) * Math.max(0, clippedBottom - clippedTop)
  return 1 - Math.min(1, clippedArea / Math.max(1, rect.width * rect.height))
}

function scoreOcrCoordinateFit(blocks: LayoutBlockResult[], pageWidth: number, pageHeight: number): {
  score: number
  outOfBoundsCount: number
  verticalShapeCount: number
  totalCount: number
  maxBottom: number
  maxRight: number
} {
  const textBlocks = blocks.filter((block) => getOcrBlockText(block).replace(/\s+/g, '').length > 0)
  let score = 0
  let outOfBoundsCount = 0
  let verticalShapeCount = 0
  let maxBottom = 0
  let maxRight = 0
  textBlocks.forEach((block) => {
    const rect = block.location
    const outOfBoundsRatio = getRectOutOfBoundsRatio(rect, pageWidth, pageHeight)
    const textLength = getOcrBlockText(block).replace(/\s+/g, '').length
    const textWeight = Math.min(4, Math.max(1, textLength / 32))
    const verticalShape = rect.width > 0 && rect.height >= rect.width * 1.28
    if (outOfBoundsRatio > 0.04) outOfBoundsCount += 1
    if (verticalShape) verticalShapeCount += 1
    maxBottom = Math.max(maxBottom, rect.top + rect.height)
    maxRight = Math.max(maxRight, rect.left + rect.width)
    score += textWeight * (1 - outOfBoundsRatio * 2.5)
    if (verticalShape) score += 1.2
    if (rect.left < -pageWidth * 0.03 || rect.top < -pageHeight * 0.03) score -= 2
    if (rect.left + rect.width > pageWidth * 1.03 || rect.top + rect.height > pageHeight * 1.03) score -= 2
  })
  return {
    score,
    outOfBoundsCount,
    verticalShapeCount,
    totalCount: textBlocks.length,
    maxBottom,
    maxRight,
  }
}

function normalizeGujiVerticalBlockOrientation(result: OcrResultPayload): OcrResultPayload {
  const blocks = asLayoutBlockResults(result.layout_result)
  if (blocks.length === 0) return result
  let changedCount = 0
  const nextBlocks = blocks.map((block) => {
    const orientation = inferGujiVerticalOrientation(block)
    if (orientation === block.orientation) return block
    changedCount += 1
    return {
      ...block,
      orientation,
    }
  })
  if (changedCount === 0) return result
  return {
    ...result,
    layout_result: nextBlocks,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      guji_orientation_normalized_blocks: changedCount,
    },
  }
}

function correctRotatedOcrCoordinatesForSourceImage(
  result: OcrResultPayload,
  imagePath: string | null | undefined,
  options: Required<PageOcrOptions>,
): OcrResultPayload {
  if (options.profile !== 'guji_print_vertical') return result
  const dimensions = getImageDimensions(imagePath)
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return result
  if (readRecordValue(result.guji_processing, 'ocr_coordinate_rotation_corrected')) return result

  const sourceBlocks = asLayoutBlockResults(result.layout_result)
  if (sourceBlocks.length < 2) return result
  const rotatedRawBlocks = Array.isArray(result.layout_result)
    ? result.layout_result.map((block) => rotateClockwiseLayoutBlockCoordinatesToSource(block, dimensions.width))
    : result.layout_result
  const rotatedBlocks = asLayoutBlockResults(rotatedRawBlocks)
  const originalFit = scoreOcrCoordinateFit(sourceBlocks, dimensions.width, dimensions.height)
  const rotatedFit = scoreOcrCoordinateFit(rotatedBlocks, dimensions.width, dimensions.height)
  const originalOutRatio = originalFit.outOfBoundsCount / Math.max(1, originalFit.totalCount)
  const rotatedOutRatio = rotatedFit.outOfBoundsCount / Math.max(1, rotatedFit.totalCount)
  const originalVerticalRatio = originalFit.verticalShapeCount / Math.max(1, originalFit.totalCount)
  const rotatedVerticalRatio = rotatedFit.verticalShapeCount / Math.max(1, rotatedFit.totalCount)
  const clearlyOutOfBounds = originalOutRatio >= 0.08
    || originalFit.maxBottom > dimensions.height * 1.04
    || originalFit.maxRight > dimensions.width * 1.04
  const rotationImprovesBounds = rotatedOutRatio + 0.05 < originalOutRatio
    || rotatedFit.score >= originalFit.score + Math.max(3, originalFit.totalCount * 0.35)
  const rotationImprovesVerticalLayout = rotatedVerticalRatio >= originalVerticalRatio + 0.25
    || (rotatedVerticalRatio >= 0.45 && originalVerticalRatio < 0.25)
  if (!clearlyOutOfBounds || !rotationImprovesBounds || !rotationImprovesVerticalLayout) return result

  return {
    ...result,
    layout_result: rotatedRawBlocks,
    words_result: Array.isArray(result.words_result)
      ? result.words_result.map((word) => rotateClockwiseWordCoordinatesToSource(word, dimensions.width))
      : result.words_result,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      ocr_coordinate_rotation_corrected: 'clockwise_to_source',
      ocr_coordinate_rotation_original_score: Number(originalFit.score.toFixed(2)),
      ocr_coordinate_rotation_corrected_score: Number(rotatedFit.score.toFixed(2)),
      ocr_coordinate_rotation_original_out_of_bounds: originalFit.outOfBoundsCount,
      ocr_coordinate_rotation_corrected_out_of_bounds: rotatedFit.outOfBoundsCount,
    },
  }
}

function clampLocationToImage(location: LayoutLocation, imageWidth: number, imageHeight: number): LayoutLocation {
  const left = clamp(Math.round(location.left), 0, Math.max(0, imageWidth - 1))
  const top = clamp(Math.round(location.top), 0, Math.max(0, imageHeight - 1))
  const right = clamp(Math.round(location.left + location.width), left + 1, imageWidth)
  const bottom = clamp(Math.round(location.top + location.height), top + 1, imageHeight)
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  }
}

interface LocalInkBounds {
  location: LayoutLocation
  inkPixels: number
}

interface LocalInkBitmap {
  bitmap: Buffer
  width: number
  height: number
}

function createLocalInkBitmap(imagePath: string | null | undefined): LocalInkBitmap | null {
  const path = String(imagePath || '').trim()
  if (!path) return null
  try {
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return null
    const size = image.getSize()
    if (size.width <= 0 || size.height <= 0) return null
    return {
      bitmap: image.toBitmap(),
      width: size.width,
      height: size.height,
    }
  } catch {
    return null
  }
}

function findActiveExtent(values: number[], threshold: number): { start: number; end: number } | null {
  let start = -1
  let end = -1
  values.forEach((value, index) => {
    if (value >= threshold) {
      if (start < 0) start = index
      end = index + 1
    }
  })
  return start >= 0 && end > start ? { start, end } : null
}

interface ActiveInkRun {
  start: number
  end: number
  total: number
  max: number
}

function findActiveInkRuns(values: number[], threshold: number, minLength = 2, maxGap = 2): ActiveInkRun[] {
  const runs = findNumericRuns(values, threshold, minLength, maxGap)
  return runs.map(([start, end]) => {
    const slice = values.slice(start, end)
    return {
      start,
      end,
      total: slice.reduce((sum, value) => sum + value, 0),
      max: Math.max(...slice, 0),
    }
  })
}

function trimDetachedWeakEdgeRuns(runs: ActiveInkRun[], fullHeight: number): ActiveInkRun[] {
  if (runs.length <= 1) return runs
  const nextRuns = runs.map((run) => ({ ...run }))
  const strongestMax = Math.max(...nextRuns.map((run) => run.max), 0)
  const strongestTotal = Math.max(...nextRuns.map((run) => run.total), 0)
  if (strongestMax <= 0 || strongestTotal <= 0) return nextRuns

  const isWeakDetachedRun = (candidate: ActiveInkRun, neighbor: ActiveInkRun, edge: 'start' | 'end'): boolean => {
    const gap = edge === 'start' ? neighbor.start - candidate.end : candidate.start - neighbor.end
    const weakInk = candidate.max <= strongestMax * 0.34 && candidate.total <= strongestTotal * 0.28
    const detached = gap >= Math.max(12, fullHeight * 0.045)
    return weakInk && detached
  }

  while (nextRuns.length > 1 && isWeakDetachedRun(nextRuns[0], nextRuns[1], 'start')) {
    nextRuns.shift()
  }
  while (nextRuns.length > 1 && isWeakDetachedRun(nextRuns[nextRuns.length - 1], nextRuns[nextRuns.length - 2], 'end')) {
    nextRuns.pop()
  }
  return nextRuns
}

function findDominantActiveExtent(values: number[], threshold: number): { start: number; end: number } | null {
  const runs = trimDetachedWeakEdgeRuns(findActiveInkRuns(values, threshold, 2, 2), values.length)
  if (runs.length === 0) return findActiveExtent(values, threshold)
  return {
    start: Math.min(...runs.map((run) => run.start)),
    end: Math.max(...runs.map((run) => run.end)),
  }
}

function getLocalInkBoundsForLocation(source: LocalInkBitmap, location: LayoutLocation): LocalInkBounds | null {
  const left = clamp(Math.floor(location.left), 0, Math.max(0, source.width - 1))
  const top = clamp(Math.floor(location.top), 0, Math.max(0, source.height - 1))
  const right = clamp(Math.ceil(location.left + location.width), left + 1, source.width)
  const bottom = clamp(Math.ceil(location.top + location.height), top + 1, source.height)
  const width = right - left
  const height = bottom - top
  if (width <= 1 || height <= 1) return null

  const rowInk = new Array<number>(height).fill(0)
  const columnInk = new Array<number>(width).fill(0)
  let inkPixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (getPixelLuminance(source.bitmap, source.width, left + x, top + y) < 214) {
        rowInk[y] += 1
        columnInk[x] += 1
        inkPixels += 1
      }
    }
  }
  if (inkPixels < Math.max(12, Math.min(width, height))) return null

  const smoothedRows = smoothSeries(rowInk, 1)
  const smoothedColumns = smoothSeries(columnInk, 1)
  const rowMax = Math.max(...smoothedRows, 0)
  const columnMax = Math.max(...smoothedColumns, 0)
  if (rowMax <= 0 || columnMax <= 0) return null

  const rowExtent = findDominantActiveExtent(smoothedRows, Math.max(2, rowMax * 0.08))
  const columnExtent = findActiveExtent(smoothedColumns, Math.max(2, columnMax * 0.08))
  if (!rowExtent || !columnExtent) return null

  const padX = Math.max(2, Math.min(10, Math.round(width * 0.012)))
  const padY = Math.max(2, Math.min(8, Math.round(height * 0.01)))
  const inkLeft = clamp(left + columnExtent.start - padX, left, right - 1)
  const inkTop = clamp(top + rowExtent.start - padY, top, bottom - 1)
  const inkRight = clamp(left + columnExtent.end + padX, inkLeft + 1, right)
  const inkBottom = clamp(top + rowExtent.end + padY, inkTop + 1, bottom)
  return {
    location: {
      left: inkLeft,
      top: inkTop,
      width: Math.max(1, inkRight - inkLeft),
      height: Math.max(1, inkBottom - inkTop),
    },
    inkPixels,
  }
}

function shouldSearchNearbyTextInk(source: LocalInkBitmap, block: LayoutBlockResult): boolean {
  if (!isTightenableTextCoordinateBlock(block)) return false
  if (isDecorativeOcrLabel(block.label) || isShortFootnoteCoordinateBlock(block)) return false
  const rect = block.location
  const compactTextLength = getOcrBlockText(block).replace(/\s+/g, '').length
  if (compactTextLength < 12) return false
  if (rect.height > Math.max(112, source.height * 0.08)) return false
  if (rect.height > 96 && compactTextLength > 160) return false
  return true
}

function getNearbyTextLocalInkBoundsForBlock(source: LocalInkBitmap, block: LayoutBlockResult): LocalInkBounds | null {
  const rect = block.location
  const padX = Math.max(10, Math.min(72, Math.round(rect.width * 0.08)))
  const padTop = Math.max(18, Math.min(74, Math.round(rect.height * 0.95)))
  const padBottom = Math.max(22, Math.min(92, Math.round(rect.height * 1.3)))
  const left = clamp(Math.floor(rect.left - padX), 0, Math.max(0, source.width - 1))
  const top = clamp(Math.floor(rect.top - padTop), 0, Math.max(0, source.height - 1))
  const right = clamp(Math.ceil(rect.left + rect.width + padX), left + 1, source.width)
  const bottom = clamp(Math.ceil(rect.top + rect.height + padBottom), top + 1, source.height)
  const width = right - left
  const height = bottom - top
  if (width <= 1 || height <= 1) return null

  const rowInk = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (getPixelLuminance(source.bitmap, source.width, left + x, top + y) < 214) {
        rowInk[y] += 1
      }
    }
  }
  const smoothedRows = smoothSeries(rowInk, 1)
  const rowMax = Math.max(...smoothedRows, 0)
  if (rowMax <= 0) return null
  const rowRuns = findActiveInkRuns(
    smoothedRows,
    Math.max(2, rowMax * 0.08),
    2,
    2,
  )
  if (rowRuns.length === 0) return null

  const originalCenterY = rect.top + rect.height / 2
  const maxCenterDy = Math.max(42, rect.height * 1.35, source.height * 0.038)
  const candidateRows = rowRuns.filter((run) => {
    const runTop = top + run.start
    const runBottom = top + run.end
    const runCenterY = (runTop + runBottom) / 2
    return Math.abs(runCenterY - originalCenterY) <= maxCenterDy
      && runBottom >= rect.top - maxCenterDy
      && runTop <= rect.top + rect.height + maxCenterDy
  })
  if (candidateRows.length === 0) return null
  const anchorRow = candidateRows
    .slice()
    .sort((leftRun, rightRun) => {
      const leftCenterY = top + (leftRun.start + leftRun.end) / 2
      const rightCenterY = top + (rightRun.start + rightRun.end) / 2
      return Math.abs(leftCenterY - originalCenterY) - Math.abs(rightCenterY - originalCenterY)
        || rightRun.total - leftRun.total
    })[0]
  const anchorCenterY = top + (anchorRow.start + anchorRow.end) / 2
  const rowMergeSlack = Math.max(10, Math.min(34, rect.height * 0.42))
  const selectedRows = candidateRows.filter((run) => {
    const runTop = top + run.start
    const runBottom = top + run.end
    const runCenterY = (runTop + runBottom) / 2
    const gapToAnchor = run.end < anchorRow.start
      ? anchorRow.start - run.end
      : run.start > anchorRow.end
        ? run.start - anchorRow.end
        : 0
    return Math.abs(runCenterY - anchorCenterY) <= Math.max(rowMergeSlack, rect.height * 0.58)
      || gapToAnchor <= rowMergeSlack
  })
  if (selectedRows.length === 0) return null

  const rowStart = clamp(Math.min(...selectedRows.map((run) => run.start)) - 2, 0, height - 1)
  const rowEnd = clamp(Math.max(...selectedRows.map((run) => run.end)) + 2, rowStart + 1, height)
  const columnInk = new Array<number>(width).fill(0)
  let inkPixels = 0
  for (let y = rowStart; y < rowEnd; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (getPixelLuminance(source.bitmap, source.width, left + x, top + y) < 214) {
        columnInk[x] += 1
        inkPixels += 1
      }
    }
  }
  if (inkPixels < Math.max(10, Math.min(rect.width, rect.height) * 0.55)) return null
  const smoothedColumns = smoothSeries(columnInk, 1)
  const columnMax = Math.max(...smoothedColumns, 0)
  if (columnMax <= 0) return null
  const columnRuns = findActiveInkRuns(
    smoothedColumns,
    Math.max(1, columnMax * 0.08),
    2,
    8,
  )
  if (columnRuns.length === 0) return null
  const columnStart = clamp(Math.min(...columnRuns.map((run) => run.start)) - 2, 0, width - 1)
  const columnEnd = clamp(Math.max(...columnRuns.map((run) => run.end)) + 2, columnStart + 1, width)
  return {
    location: clampLocationToImage({
      left: left + columnStart,
      top: top + rowStart,
      width: columnEnd - columnStart,
      height: rowEnd - rowStart,
    }, source.width, source.height),
    inkPixels,
  }
}

function isTightenableTextCoordinateBlock(block: LayoutBlockResult): boolean {
  if (!block.location) return false
  if (isTableLabel(block.label) || isImageLabel(block.label)) return false
  if (normalizeTableRows(firstRecordValue(block, ['rows', 'table_rows'])).length > 0) return false
  const text = getOcrBlockText(block).replace(/\s+/g, '')
  const decorative = isDecorativeOcrLabel(block.label)
  const shortFootnote = isShortFootnoteCoordinateBlock(block)
  const label = String(block.label || '').toLowerCase()
  const titleLike = /title|author|doc_title/.test(label)
  if (text.length < (decorative || shortFootnote || titleLike ? 1 : 12)) return false
  if (decorative || shortFootnote) return text.length <= 120
  if (titleLike) return text.length <= 120
  if (!label) return true
  return /text|paragraph|body|note|footnote|reference|abstract|title/i.test(label)
}

function isShortFootnoteCoordinateBlock(block: LayoutBlockResult): boolean {
  if (!block.location) return false
  if (!/footnote/.test(String(block.label || '').toLowerCase())) return false
  if (block.location.height >= 40) return false
  const compactTextLength = getOcrBlockText(block).replace(/\s+/g, '').length
  return compactTextLength > 0 && compactTextLength <= 80
}

function getDecorativeInkSearchLocation(source: LocalInkBitmap, location: LayoutLocation, label: unknown): LayoutLocation {
  const lowerLabel = String(label || '').toLowerCase()
  const shortFootnote = /footnote/.test(lowerLabel) && location.height < 40
  const padX = Math.max(18, Math.round(location.width * (/number|page/.test(lowerLabel) ? 0.9 : /header/.test(lowerLabel) ? 1.25 : shortFootnote ? 0.8 : 0.75)))
  const upwardPad = /footer/.test(lowerLabel)
    ? Math.max(48, Math.round(location.height * 3))
    : shortFootnote
      ? Math.max(6, Math.round(location.height * 0.35))
      : Math.max(12, Math.round(location.height * 0.8))
  const downwardPad = /footer/.test(lowerLabel)
    ? Math.max(40, Math.round(location.height * 2))
    : Math.max(/number|page/.test(lowerLabel) ? 54 : shortFootnote ? 44 : 72, Math.round(location.height * (/number|page/.test(lowerLabel) ? 2.2 : shortFootnote ? 2 : 3)))
  const left = clamp(Math.round(location.left - padX), 0, Math.max(0, source.width - 1))
  const top = clamp(Math.round(location.top - upwardPad), 0, Math.max(0, source.height - 1))
  const right = clamp(Math.round(location.left + location.width + padX), left + 1, source.width)
  const bottom = clamp(Math.round(location.top + location.height + downwardPad), top + 1, source.height)
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  }
}

function shouldUseDecorativeLocalInkLocation(
  original: LayoutLocation,
  tightened: LayoutLocation,
  source: LocalInkBitmap,
  label: unknown,
  compactTextLength = 0,
): boolean {
  const lowerLabel = String(label || '').toLowerCase()
  const originalCenterX = original.left + original.width / 2
  const originalCenterY = original.top + original.height / 2
  const tightenedCenterX = tightened.left + tightened.width / 2
  const tightenedCenterY = tightened.top + tightened.height / 2
  const maxCenterDx = Math.max(36, original.width * 1.35, source.width * 0.12)
  const maxCenterDy = /number|page/.test(lowerLabel)
    ? Math.max(28, original.height * 1.6, source.height * 0.025)
    : /footnote/.test(lowerLabel) && original.height < 40
      ? Math.max(38, original.height * 2.2, source.height * 0.055)
    : Math.max(72, original.height * 4.5, source.height * 0.1)
  if (Math.abs(tightenedCenterX - originalCenterX) > maxCenterDx) return false
  if (Math.abs(tightenedCenterY - originalCenterY) > maxCenterDy) return false
  const maxWidth = /number|page/.test(lowerLabel)
    ? Math.max(22, Math.min(original.width * 1.7, source.width * 0.12))
    : /header/.test(lowerLabel)
      ? Math.max(40, Math.min(
        source.width * 0.34,
        Math.max(original.width * 2.5, compactTextLength * 14),
      ))
      : /footnote/.test(lowerLabel) && original.height < 40
        ? Math.max(24, Math.min(source.width * 0.28, Math.max(original.width * 1.4, compactTextLength * 10)))
      : Math.max(original.width * 3.4, source.width * 0.36)
  const maxHeight = /number|page/.test(lowerLabel)
    ? Math.max(20, Math.min(original.height * 1.45, source.height * 0.05))
    : /header/.test(lowerLabel)
      ? Math.max(18, Math.min(original.height * 1.7, source.height * 0.055))
      : /footnote/.test(lowerLabel) && original.height < 40
        ? Math.max(12, Math.min(original.height * 1.5, source.height * 0.045))
      : Math.max(original.height * 3.2, source.height * 0.075)
  if (tightened.width > maxWidth) return false
  if (tightened.height > maxHeight) return false
  return tightened.width >= 3 && tightened.height >= 3
}

function getDecorativeLocalInkBoundsForBlock(source: LocalInkBitmap, block: LayoutBlockResult): LocalInkBounds | null {
  const search = getDecorativeInkSearchLocation(source, block.location, block.label)
  const left = clamp(Math.floor(search.left), 0, Math.max(0, source.width - 1))
  const top = clamp(Math.floor(search.top), 0, Math.max(0, source.height - 1))
  const right = clamp(Math.ceil(search.left + search.width), left + 1, source.width)
  const bottom = clamp(Math.ceil(search.top + search.height), top + 1, source.height)
  const width = right - left
  const height = bottom - top
  if (width <= 1 || height <= 1) return null

  const rowInk = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (getPixelLuminance(source.bitmap, source.width, left + x, top + y) < 214) {
        rowInk[y] += 1
      }
    }
  }
  const smoothedRows = smoothSeries(rowInk, 1)
  const rowMax = Math.max(...smoothedRows, 0)
  if (rowMax <= 0) return null
  const rowRuns = findNumericRuns(
    smoothedRows,
    Math.max(1, Math.min(8, rowMax * 0.1)),
    3,
    2,
  )
  if (rowRuns.length === 0) return null

  const originalCenterX = block.location.left + block.location.width / 2
  const originalCenterY = block.location.top + block.location.height / 2
  let best: (LocalInkBounds & { score: number }) | null = null

  for (const [rawRowStart, rawRowEnd] of rowRuns) {
    const rowStart = clamp(rawRowStart - 1, 0, height - 1)
    const rowEnd = clamp(rawRowEnd + 1, rowStart + 1, height)
    const colInk = new Array<number>(width).fill(0)
    let inkPixels = 0
    for (let y = rowStart; y < rowEnd; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (getPixelLuminance(source.bitmap, source.width, left + x, top + y) < 214) {
          colInk[x] += 1
          inkPixels += 1
        }
      }
    }
    if (inkPixels < 4) continue
    const smoothedColumns = smoothSeries(colInk, 1)
    const colMax = Math.max(...smoothedColumns, 0)
    if (colMax <= 0) continue
    const columnRuns = findNumericRuns(
      smoothedColumns,
      Math.max(1, Math.min(5, colMax * 0.08)),
      3,
      /footer/.test(String(block.label || '').toLowerCase()) ? 8 : 2,
    )
    if (columnRuns.length === 0) continue

    const lowerLabel = String(block.label || '').toLowerCase()
    const candidateRuns = /footer/.test(lowerLabel)
      ? [[columnRuns[0][0], columnRuns[columnRuns.length - 1][1]]]
      : /header/.test(lowerLabel) || (/footnote/.test(lowerLabel) && block.location.height < 40)
        ? columnRuns.flatMap((_, runIndex) => {
          const groups: Array<[number, number]> = []
          const compactTextLength = getOcrBlockText(block).replace(/\s+/g, '').length
          const headerLike = /header/.test(lowerLabel)
          const maxGroupWidth = Math.max(
            block.location.width * (headerLike ? 2.4 : 1.4),
            Math.min(
              source.width * (headerLike ? 0.34 : 0.28),
              Math.max(headerLike ? 140 : 34, compactTextLength * (headerLike ? 14 : 10)),
            ),
          )
          const maxGroupGap = Math.max(headerLike ? 24 : 8, Math.min(headerLike ? 72 : 28, block.location.width * 0.42))
          for (let endIndex = runIndex; endIndex < columnRuns.length; endIndex += 1) {
            if (endIndex > runIndex && columnRuns[endIndex][0] - columnRuns[endIndex - 1][1] > maxGroupGap) break
            const group: [number, number] = [columnRuns[runIndex][0], columnRuns[endIndex][1]]
            if (group[1] - group[0] > maxGroupWidth) break
            groups.push(group)
          }
          return groups
        })
        : columnRuns

    for (const [columnStart, columnEnd] of candidateRuns) {
      const padX = 2
      const padY = 2
      const location = clampLocationToImage({
        left: left + columnStart - padX,
        top: top + rowStart - padY,
        width: columnEnd - columnStart + padX * 2,
        height: rowEnd - rowStart + padY * 2,
      }, source.width, source.height)
      const compactTextLength = getOcrBlockText(block).replace(/\s+/g, '').length
      const shortFootnote = /footnote/.test(lowerLabel) && block.location.height < 40
      if (shortFootnote) {
        const locationCenterY = location.top + location.height / 2
        const maxCenterShiftY = Math.max(16, block.location.height * 0.85)
        if (Math.abs(locationCenterY - originalCenterY) > maxCenterShiftY) continue
      }
      if (!shouldUseDecorativeLocalInkLocation(block.location, location, source, block.label, compactTextLength)) continue
      const centerX = location.left + location.width / 2
      const centerY = location.top + location.height / 2
      const expectedHeaderWidth = /header/.test(lowerLabel)
        ? Math.min(source.width * 0.34, Math.max(0, compactTextLength * 10))
        : 0
      const expectedShortFootnoteWidth = /footnote/.test(lowerLabel) && block.location.height < 40
        ? Math.min(source.width * 0.28, Math.max(0, compactTextLength * 7))
        : 0
      const shortFootnoteCenterWeight = shortFootnote ? 4.5 : 1.45
      const score = Math.abs(centerX - originalCenterX)
        + Math.abs(centerY - originalCenterY) * shortFootnoteCenterWeight
        + Math.max(0, expectedHeaderWidth - location.width) * 1.6
        + Math.max(0, expectedShortFootnoteWidth - location.width) * (shortFootnote ? 0.12 : 1.2)
        + Math.max(0, location.width - block.location.width) * 0.08
        + Math.max(0, location.height - block.location.height) * 0.25
      if (!best || score < best.score) {
        best = { location, inkPixels, score }
      }
    }
  }

  return best ? { location: best.location, inkPixels: best.inkPixels } : null
}

function getLocalInkBoundsForBlock(
  source: LocalInkBitmap,
  block: LayoutBlockResult,
  options: { searchNearbyTextInk?: boolean } = {},
): LocalInkBounds | null {
  const localBounds = getLocalInkBoundsForLocation(source, block.location)
  const shouldSearchNearbyInk = isDecorativeOcrLabel(block.label) || isShortFootnoteCoordinateBlock(block)
  if (options.searchNearbyTextInk && shouldSearchNearbyTextInk(source, block)) {
    return getNearbyTextLocalInkBoundsForBlock(source, block) || localBounds
  }
  if (!shouldSearchNearbyInk) return localBounds

  return getDecorativeLocalInkBoundsForBlock(source, block) || localBounds
}

function getShortFootnoteLocalLineBounds(source: LocalInkBitmap, search: LayoutLocation): LayoutLocation[] {
  const left = clamp(Math.floor(search.left), 0, Math.max(0, source.width - 1))
  const top = clamp(Math.floor(search.top), 0, Math.max(0, source.height - 1))
  const right = clamp(Math.ceil(search.left + search.width), left + 1, source.width)
  const bottom = clamp(Math.ceil(search.top + search.height), top + 1, source.height)
  const width = right - left
  const height = bottom - top
  if (width <= 1 || height <= 1) return []

  const rowInk = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (getPixelLuminance(source.bitmap, source.width, left + x, top + y) < 214) {
        rowInk[y] += 1
      }
    }
  }
  const smoothedRows = smoothSeries(rowInk, 1)
  const rowMax = Math.max(...smoothedRows, 0)
  if (rowMax <= 0) return []
  const rowRuns = findNumericRuns(
    smoothedRows,
    Math.max(2, Math.min(12, rowMax * 0.12)),
    3,
    2,
  )

  return rowRuns.flatMap(([rawRowStart, rawRowEnd]) => {
    const rowStart = clamp(rawRowStart - 2, 0, height - 1)
    const rowEnd = clamp(rawRowEnd + 2, rowStart + 1, height)
    const rowHeight = rowEnd - rowStart
    if (rowHeight > Math.max(30, height * 0.55)) return []
    const columnInk = new Array<number>(width).fill(0)
    let inkPixels = 0
    for (let y = rowStart; y < rowEnd; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (getPixelLuminance(source.bitmap, source.width, left + x, top + y) < 214) {
          columnInk[x] += 1
          inkPixels += 1
        }
      }
    }
    if (inkPixels < 6) return []
    const smoothedColumns = smoothSeries(columnInk, 1)
    const columnMax = Math.max(...smoothedColumns, 0)
    if (columnMax <= 0) return []
    const columnRuns = findNumericRuns(
      smoothedColumns,
      Math.max(1, Math.min(5, columnMax * 0.08)),
      2,
      14,
    )
    if (columnRuns.length === 0) return []
    const columnStart = columnRuns[0][0]
    const columnEnd = columnRuns[columnRuns.length - 1][1]
    const location = clampLocationToImage({
      left: left + columnStart - 2,
      top: top + rowStart - 2,
      width: columnEnd - columnStart + 4,
      height: rowEnd - rowStart + 4,
    }, source.width, source.height)
    return [location]
  }).sort((leftLocation, rightLocation) => leftLocation.top - rightLocation.top || leftLocation.left - rightLocation.left)
}

function getShortFootnoteGroupLocalInkLocations(source: LocalInkBitmap, blocks: LayoutBlockResult[]): Map<number, LayoutLocation> {
  const candidates = blocks
    .map((block, index) => ({ block, index }))
    .filter((item) => isShortFootnoteCoordinateBlock(item.block))
    .sort((left, right) => left.block.location.top - right.block.location.top || left.index - right.index)
  const locations = new Map<number, LayoutLocation>()
  if (candidates.length < 2) return locations

  const groups: Array<Array<{ block: LayoutBlockResult; index: number }>> = []
  for (const item of candidates) {
    const previousGroup = groups[groups.length - 1]
    const previousItem = previousGroup?.[previousGroup.length - 1]
    const itemCenterX = item.block.location.left + item.block.location.width / 2
    const itemCenterY = item.block.location.top + item.block.location.height / 2
    const previousCenterX = previousItem ? previousItem.block.location.left + previousItem.block.location.width / 2 : 0
    const previousCenterY = previousItem ? previousItem.block.location.top + previousItem.block.location.height / 2 : 0
    const closeEnough = previousItem
      && Math.abs(itemCenterY - previousCenterY) <= Math.max(62, (item.block.location.height + previousItem.block.location.height) * 1.8)
      && Math.abs(itemCenterX - previousCenterX) <= Math.max(96, Math.max(item.block.location.width, previousItem.block.location.width) * 1.2)
    if (!previousGroup || !closeEnough) {
      groups.push([item])
    } else {
      previousGroup.push(item)
    }
  }

  for (const group of groups) {
    if (group.length < 2) continue
    const groupLeft = Math.min(...group.map((item) => item.block.location.left))
    const groupTop = Math.min(...group.map((item) => item.block.location.top))
    const groupRight = Math.max(...group.map((item) => item.block.location.left + item.block.location.width))
    const groupBottom = Math.max(...group.map((item) => item.block.location.top + item.block.location.height))
    const averageHeight = group.reduce((sum, item) => sum + item.block.location.height, 0) / group.length
    const search = {
      left: groupLeft - Math.max(24, (groupRight - groupLeft) * 0.35),
      top: groupTop - Math.max(34, averageHeight * 1.6),
      width: (groupRight - groupLeft) + Math.max(48, (groupRight - groupLeft) * 0.7),
      height: (groupBottom - groupTop) + Math.max(48, averageHeight * 2.2),
    }
    const lineBounds = getShortFootnoteLocalLineBounds(source, search)
      .filter((location) => {
        const centerY = location.top + location.height / 2
        return centerY >= groupTop - Math.max(38, averageHeight * 1.9)
          && centerY <= groupBottom + Math.max(20, averageHeight * 0.9)
      })
    if (lineBounds.length < group.length) continue
    const selected = lineBounds.slice(0, group.length)
    group
      .slice()
      .sort((leftItem, rightItem) => leftItem.index - rightItem.index)
      .forEach((item, index) => {
        locations.set(item.index, selected[index])
      })
  }

  return locations
}

function shouldUseLocalInkLocation(
  original: LayoutLocation,
  tightened: LayoutLocation,
  compactTextLength: number,
): boolean {
  const originalArea = Math.max(1, original.width * original.height)
  const tightenedArea = Math.max(1, tightened.width * tightened.height)
  const areaRatio = tightenedArea / originalArea
  if (areaRatio < (compactTextLength >= 80 ? 0.2 : 0.08)) return false
  const shrinkLeft = tightened.left - original.left
  const shrinkTop = tightened.top - original.top
  const shrinkRight = original.left + original.width - tightened.left - tightened.width
  const shrinkBottom = original.top + original.height - tightened.top - tightened.height
  const meaningfulShrink = Math.max(shrinkLeft, shrinkTop, shrinkRight, shrinkBottom)
    >= Math.max(6, Math.min(original.width, original.height) * 0.025)
  if (!meaningfulShrink) return false
  return tightened.width >= Math.max(8, original.width * 0.28)
    && tightened.height >= Math.max(8, original.height * 0.08)
}

function isOverTightenedSmallTextBlock(
  block: LayoutBlockResult,
  tightened: LayoutLocation,
): boolean {
  const label = String(block.label || '').toLowerCase()
  if (/title/.test(label)) {
    return tightened.height < Math.max(10, block.location.height * 0.16)
      || tightened.width < Math.max(24, block.location.width * 0.32)
  }
  if (/footnote|reference|caption/.test(label) && block.location.height >= 40) {
    return tightened.height < Math.max(8, block.location.height * 0.12)
      || tightened.width < Math.max(48, block.location.width * 0.28)
  }
  return false
}

export function tightenOcrTextCoordinatesToLocalInk(
  result: OcrResultPayload,
  imagePath: string | null | undefined,
  options: { searchNearbyTextInk?: boolean } = {},
): OcrResultPayload {
  const source = createLocalInkBitmap(imagePath)
  if (!source) return result
  const blocks = asLayoutBlockResults(result.layout_result)
  if (blocks.length === 0) return result
  const shortFootnoteGroupLocations = getShortFootnoteGroupLocalInkLocations(source, blocks)

  let tightenedCount = 0
  const nextBlocks = blocks.map((block, index) => {
    if (!isTightenableTextCoordinateBlock(block)) return block
    const groupedLocation = shortFootnoteGroupLocations.get(index)
    const inkBounds = groupedLocation ? { location: groupedLocation, inkPixels: 0 } : getLocalInkBoundsForBlock(source, block, options)
    if (!inkBounds) return block
    const tightenedLocation = clampLocationToImage(inkBounds.location, source.width, source.height)
    const compactTextLength = getOcrBlockText(block).replace(/\s+/g, '').length
    if (isOverTightenedSmallTextBlock(block, tightenedLocation)) return block
    if (!groupedLocation && (isDecorativeOcrLabel(block.label) || isShortFootnoteCoordinateBlock(block))) {
      if (!shouldUseDecorativeLocalInkLocation(block.location, tightenedLocation, source, block.label, compactTextLength)) return block
    } else if (!shouldUseLocalInkLocation(block.location, tightenedLocation, compactTextLength)) {
      return block
    }
    tightenedCount += 1
    return {
      ...block,
      location: tightenedLocation,
      mask_polygon: createMaskPolygon(tightenedLocation),
      coordinate_source: 'local_ink_tightened',
    }
  })
  if (tightenedCount === 0) return result
  return rebuildWordsResultFromLayout({
    ...result,
    layout_result: nextBlocks,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      ocr_coordinate_tightened_to_local_ink: tightenedCount,
    },
  })
}

function clampGujiOcrResultToSourceImage(
  result: OcrResultPayload,
  imagePath: string | null | undefined,
): OcrResultPayload {
  const dimensions = getImageDimensions(imagePath)
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return result
  const blocks = asLayoutBlockResults(result.layout_result)
  if (blocks.length === 0) return result
  let clampedCount = 0
  const nextBlocks = blocks.map((block) => {
    const clampedLocation = clampLocationToImage(block.location, dimensions.width, dimensions.height)
    if (
      clampedLocation.left === block.location.left
      && clampedLocation.top === block.location.top
      && clampedLocation.width === block.location.width
      && clampedLocation.height === block.location.height
    ) {
      return block
    }
    clampedCount += 1
    return {
      ...block,
      location: clampedLocation,
      mask_polygon: createMaskPolygon(clampedLocation),
    }
  })
  if (clampedCount === 0) return result
  return {
    ...result,
    layout_result: nextBlocks,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      ocr_coordinate_clamped_to_source: clampedCount,
    },
  }
}

export function normalizeStoredOcrResultForRead(
  result: unknown,
  imagePath: string | null | undefined,
  pageIndex = 1,
): OcrResultPayload | null {
  if (!isOcrResultPayload(result)) return null
  const gujiProcessing = isJsonRecord(result.guji_processing) ? result.guji_processing : {}
  const preserveServiceCoordinates = readRecordValue(gujiProcessing, 'ocr_service_coordinates_preserved') === true
  const coordinateAligned = preserveServiceCoordinates
    ? alignServiceCoordinatesToLocalImage(result, imagePath)
    : result
  const dimensions = preserveServiceCoordinates ? undefined : getImageDimensions(imagePath)
  return ensureOcrResultIr(coordinateAligned, {
    pageIndex,
    pageWidth: dimensions?.width,
    pageHeight: dimensions?.height,
    forceRebuild: coordinateAligned !== result,
  }) as OcrResultPayload
}

export const normalizeStoredGujiOcrResultForRead = normalizeStoredOcrResultForRead

function scaleOcrResultToOriginalImage(result: OcrResultPayload, uploadImage?: OcrUploadImage | null): OcrResultPayload {
  if (!uploadImage?.resized) return result
  const uploadWidth = Number(uploadImage.width || 0)
  const uploadHeight = Number(uploadImage.height || 0)
  const originalWidth = Number(uploadImage.originalWidth || 0)
  const originalHeight = Number(uploadImage.originalHeight || 0)
  if (uploadWidth <= 0 || uploadHeight <= 0 || originalWidth <= 0 || originalHeight <= 0) return result
  const scaleX = originalWidth / uploadWidth
  const scaleY = originalHeight / uploadHeight
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return result
  if (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001) return result

  return {
    ...result,
    layout_result: Array.isArray(result.layout_result)
      ? result.layout_result.map((block) => scaleLayoutBlockCoordinates(block, scaleX, scaleY))
      : result.layout_result,
    words_result: Array.isArray(result.words_result)
      ? result.words_result.map((word) => scaleWordCoordinates(word, scaleX, scaleY))
      : result.words_result,
    guji_processing: {
      ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
      ocr_upload_image_width: uploadWidth,
      ocr_upload_image_height: uploadHeight,
      ocr_upload_resized: true,
      ocr_coordinate_rescaled_to_source: true,
    },
  }
}

function asLayoutBlockResults(value: unknown): LayoutBlockResult[] {
  return asUnknownArray(value)
    .map((block, index) => toLayoutBlockResult(block, index))
    .filter((block): block is LayoutBlockResult => Boolean(block))
}

function decodeHtmlEntities(value: string): string {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getCellText(cell: unknown): string {
  return valueText(cell) || firstText(cell, ['text', 'words', 'word', 'value', 'content'])
}

function getCellRow(cell: unknown): number {
  return nonNegativeIntField(cell, ['row', 'row_index', 'rowIndex', 'start_row', 'startRow'], 0)
}

function getCellCol(cell: unknown): number {
  return nonNegativeIntField(cell, ['col', 'column', 'col_index', 'column_index', 'colIndex', 'columnIndex', 'start_col', 'startCol'], 0)
}

function normalizeTableRows(rows: unknown): string[][] {
  if (!Array.isArray(rows) || rows.length === 0) return []
  return rows
    .map((row) => Array.isArray(row)
      ? row.map(getCellText)
      : Array.isArray(readRecordValue(row, 'cells'))
        ? asUnknownArray(readRecordValue(row, 'cells')).map(getCellText)
        : [])
    .filter((row: string[]) => row.some((cell) => cell.trim()))
}

function tableRowsFromCells(cells: unknown): string[][] {
  if (!Array.isArray(cells) || cells.length === 0) return []
  const table: string[][] = []
  for (const cell of cells) {
    const rowIndex = getCellRow(cell)
    const colIndex = getCellCol(cell)
    if (!table[rowIndex]) table[rowIndex] = []
    table[rowIndex][colIndex] = getCellText(cell)
  }
  return table.map((row) => (row || []).map((cell) => cell || '')).filter((row) => row.some(Boolean))
}

function parseHtmlTableRows(value: string): string[][] {
  const source = decodeHtmlEntities(value)
  const rowMatches = source.match(/<tr[\s\S]*?<\/tr>/gi) || []
  const rows: string[][] = []
  for (const rowHtml of rowMatches) {
    const cells = rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []
    const row = cells.map(stripHtml)
    if (row.some(Boolean)) rows.push(row)
  }
  return rows
}

function parseMarkdownTableRows(value: string): string[][] {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\|.+\|$/.test(line))
  if (lines.length < 2) return []
  return lines
    .filter((line) => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))
}

function tableRowsToText(rows: string[][]): string {
  return rows.map((row) => row.join('\t')).join('\n')
}

function tableRowsToVerticalColumnText(rows: string[][]): string {
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const columns: string[] = []
  for (let columnIndex = columnCount - 1; columnIndex >= 0; columnIndex -= 1) {
    const columnText = rows.map((row) => String(row[columnIndex] || '').trim()).filter(Boolean).join('')
    if (columnText) columns.push(columnText)
  }
  return columns.join('\n')
}

function getOcrVerticalScriptRatio(text: string): number {
  const chars = Array.from(String(text || '').replace(/\s+/g, ''))
  if (chars.length === 0) return 0
  const verticalChars = chars.filter((char) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(char)).length
  return verticalChars / chars.length
}

function getCompactTableCells(rows: string[][]): string[] {
  return rows.flat().map((cell) => String(cell || '').replace(/\s+/g, '')).filter(Boolean)
}

function hasStructuredTableMarkup(block: unknown): boolean {
  const html = String(firstRecordValue(block, ['html', 'table_html', 'tableHtml']) || '')
  return /\b(?:rowspan|colspan|thead|tbody|tfoot)\b/i.test(html)
}

function hasNumericTableSignals(cells: string[]): boolean {
  if (cells.length < 4) return false
  const numericCells = cells.filter((cell) => /(?:\d|[０-９]|[一二三四五六七八九十百千万]+(?:年|月|日|時|时|分|円|元|割|％|%))/.test(cell)).length
  return numericCells >= Math.max(3, Math.ceil(cells.length * 0.25))
}

function isLikelyVerticalPseudoTableBlock(block: LayoutBlockResult): boolean {
  if (!isTableLabel(block.label)) return false
  const rows = normalizeTableRows(firstRecordValue(block, ['rows', 'table_rows']))
  if (rows.length < 2) return false

  const compactCells = getCompactTableCells(rows)
  const compactText = compactCells.join('')
  if (compactCells.length < 6 || compactText.length < 16) return false
  if (getOcrVerticalScriptRatio(compactText) < 0.55) return false
  if (hasStructuredTableMarkup(block) || hasNumericTableSignals(compactCells)) return false

  const rowCount = rows.length
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const maxCellLength = Math.max(0, ...compactCells.map((cell) => cell.length))
  const shortCellRatio = compactCells.filter((cell) => cell.length <= 8).length / Math.max(1, compactCells.length)
  const rect = block.location
  const gridLikeVerticalText = compactCells.length >= 12
    && shortCellRatio >= 0.68
    && maxCellLength <= 18
    && (rowCount >= 5 || columnCount >= 4)
  const oldStyleSparseColumns = rowCount <= 4
    && columnCount >= 4
    && shortCellRatio >= 0.72
    && maxCellLength <= 14
  const verticalPageShape = !rect || rect.height >= rect.width * 0.42 || columnCount >= 4
  return verticalPageShape && (gridLikeVerticalText || oldStyleSparseColumns)
}

function downgradeVerticalPseudoTableBlocks(result: OcrResultPayload, options: Required<PageOcrOptions>): OcrResultPayload {
  if (options.profile !== 'guji_print_vertical') return result
  const blocks = asLayoutBlockResults(result.layout_result)
  if (blocks.length === 0) return result
  let downgradedCount = 0
  const nextBlocks = blocks.map((block) => {
    if (!isTableLabel(block.label)) return block
    downgradedCount += 1
    const rows = normalizeTableRows(firstRecordValue(block, ['rows', 'table_rows']))
    const words = tableRowsToVerticalColumnText(rows) || tableRowsToText(rows) || getOcrBlockText(block)
    const nextBlock: LayoutBlockResult = {
      ...block,
      words,
      raw_words: words,
      label: 'text',
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
      md: undefined,
      orientation: 'vertical',
      segmentation_source: 'ocr',
      pseudo_table_downgraded: true,
    }
    return nextBlock
  })
  if (downgradedCount === 0) return result
  return rebuildWordsResultFromLayout({
    ...result,
    layout_result: nextBlocks,
      guji_processing: {
        ...(isJsonRecord(result.guji_processing) ? result.guji_processing : {}),
        downgraded_vertical_pseudo_tables: downgradedCount,
        downgraded_vertical_tables: downgradedCount,
      },
  })
}

function normalizeOcrInlineText(value: string): string {
  let text = decodeHtmlEntities(String(value || '')).replace(/\r/g, '\n')
  for (let index = 0; index < 8; index += 1) {
    const next = text
      .replace(/\$\s*\\?([a-zA-Z]+)\s*\{([^{}]*)\}\s*\$/g, '$2')
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|mbox|underline|overline|emph|textbf|textit)\s*\{([^{}]*)\}/gi, '$1')
      .replace(/\^\{([^{}]{1,30})\}/g, '$1')
      .replace(/_\{([^{}]{1,30})\}/g, '$1')
    if (next === text) break
    text = next
  }
  return text
    .replace(/\$+\s*/g, '')
    .replace(/\\(?:dagger)/g, '†')
    .replace(/\\(?:ddagger)/g, '‡')
    .replace(/\\(?:ast|star)/g, '*')
    .replace(/\\S/g, '§')
    .replace(/\\P/g, '¶')
    .replace(/\\(?:cdot)/g, '·')
    .replace(/\\(?:times)/g, '×')
    .replace(/\\(?:quad|qquad|,|;|:|!)/g, ' ')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?([，。；：！？、,.!?;:]) ?/g, '$1')
    .trim()
}

interface OcrRepeatedTextCandidate {
  source: string
  text: string
}

function compactOcrRepeatedTextScanValue(value: string): string {
  return normalizeOcrInlineText(value)
    .replace(/\s+/g, '')
    .slice(0, OCR_REPEATED_TEXT_SCAN_LIMIT)
}

function addOcrRepeatedTextCandidate(candidates: OcrRepeatedTextCandidate[], source: string, value: unknown): void {
  const text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).trim()
    : ''
  if (text) candidates.push({ source, text })
}

function getMarkdownCandidateText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isJsonRecord(value)) return ''
  return rawPrimitiveText(readRecordValue(value, 'text'))
}

function getOcrRepeatedTextCandidates(value: unknown): OcrRepeatedTextCandidate[] {
  const candidates: OcrRepeatedTextCandidate[] = []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    addOcrRepeatedTextCandidate(candidates, 'text', value)
    return candidates
  }
  if (!isJsonRecord(value)) return candidates

  addOcrRepeatedTextCandidate(candidates, 'text', readRecordValue(value, 'text'))
  addOcrRepeatedTextCandidate(candidates, 'markdown.text', getMarkdownCandidateText(readRecordValue(value, 'markdown')))

  const wordsResult = asRecordArray(readRecordValue(value, 'words_result'))
  const wordsText = wordsResult.map((item) => rawPrimitiveText(readRecordValue(item, 'words'))).filter(Boolean).join('\n')
  addOcrRepeatedTextCandidate(candidates, 'words_result', wordsText)

  const layoutResult = asRecordArray(readRecordValue(value, 'layout_result'))
  const layoutText = layoutResult.map((item) => rawPrimitiveText(readRecordValue(item, 'words'))).filter(Boolean).join('\n')
  addOcrRepeatedTextCandidate(candidates, 'layout_result.words', layoutText)
  layoutResult.forEach((item, index) => {
    addOcrRepeatedTextCandidate(candidates, `layout_result[${index}].words`, readRecordValue(item, 'words'))
    addOcrRepeatedTextCandidate(candidates, `layout_result[${index}].raw_words`, readRecordValue(item, 'raw_words'))
    addOcrRepeatedTextCandidate(candidates, `layout_result[${index}].table_html`, readRecordValue(item, 'table_html') || readRecordValue(item, 'html'))
  })

  return candidates
}

function isSuspiciousRepeatedTextIssue(issue: OcrRepeatedTextIssue): boolean {
  if (issue.compactLength < OCR_REPEATED_TEXT_MIN_COMPACT_LENGTH) return false
  if (issue.repeatChars >= 1_800 && issue.repeatCount >= 120 && issue.ratio >= 0.35) return true
  if (issue.unit.length <= 2 && issue.repeatChars >= 1_200 && issue.repeatCount >= 500 && issue.ratio >= 0.35) return true
  return issue.repeatChars >= 3_600 && issue.repeatCount >= 80 && issue.ratio >= 0.25
}

function findRepeatedTextIssueInCandidate(candidate: OcrRepeatedTextCandidate): OcrRepeatedTextIssue | null {
  const compact = compactOcrRepeatedTextScanValue(candidate.text)
  if (compact.length < OCR_REPEATED_TEXT_MIN_COMPACT_LENGTH) return null
  let bestUnit = ''
  let bestCount = 0
  let bestChars = 0
  let bestStart = 0

  for (let unitLength = 1; unitLength <= OCR_REPEATED_TEXT_MAX_UNIT_LENGTH; unitLength += 1) {
    let index = 0
    while (index + unitLength * 3 <= compact.length) {
      const unit = compact.slice(index, index + unitLength)
      if (!unit.trim()) {
        index += 1
        continue
      }
      let cursor = index + unitLength
      let repeatCount = 1
      while (cursor + unitLength <= compact.length && compact.slice(cursor, cursor + unitLength) === unit) {
        repeatCount += 1
        cursor += unitLength
      }
      const repeatChars = repeatCount * unitLength
      if (repeatCount >= 3 && repeatChars > bestChars) {
        bestUnit = unit
        bestCount = repeatCount
        bestChars = repeatChars
        bestStart = index
      }
      index = repeatCount >= 3 ? Math.max(cursor, index + 1) : index + 1
    }
  }

  if (!bestUnit) return null
  const issue: OcrRepeatedTextIssue = {
    source: candidate.source,
    unit: bestUnit,
    repeatCount: bestCount,
    repeatChars: bestChars,
    compactLength: compact.length,
    ratio: bestChars / Math.max(1, compact.length),
    sample: compact.slice(bestStart, Math.min(compact.length, bestStart + 120)),
  }
  return isSuspiciousRepeatedTextIssue(issue) ? issue : null
}

export function findSuspiciousRepeatedOcrText(value: unknown): OcrRepeatedTextIssue | null {
  let bestIssue: OcrRepeatedTextIssue | null = null
  for (const candidate of getOcrRepeatedTextCandidates(value)) {
    const issue = findRepeatedTextIssueInCandidate(candidate)
    if (!issue) continue
    if (!bestIssue || issue.repeatChars > bestIssue.repeatChars) {
      bestIssue = issue
    }
  }
  return bestIssue
}

export function formatSuspiciousRepeatedOcrTextIssue(issue: OcrRepeatedTextIssue): string {
  const unit = issue.unit.length > 24 ? `${issue.unit.slice(0, 24)}...` : issue.unit
  const ratio = Math.round(issue.ratio * 100)
  return `OCR 结果疑似重复生成：“${unit}”连续出现 ${issue.repeatCount} 次，占该页文本约 ${ratio}%。本页结果未写入正文，请重新 OCR 该页或切换 OCR 模型后再试。`
}

function getRawOcrBlockText(block: unknown): string {
  return String(
    firstRecordValue(block, ['raw_words', 'raw_text', 'words', 'word', 'text', 'block_content', 'content', 'transcription'])
    || readStructureResText(readRecordValue(block, 'res'))
    || '',
  )
}

function getPreferredOcrBlockText(block: unknown): string {
  return String(
    firstRecordValue(block, ['words', 'word', 'text', 'block_content', 'content', 'transcription', 'raw_words', 'raw_text'])
    || readStructureResText(readRecordValue(block, 'res'))
    || '',
  )
}

function readStructureResText(res: unknown): string {
  if (!res) return ''
  if (typeof res === 'string' || typeof res === 'number') return String(res)
  if (Array.isArray(res)) {
    const tupleRec = Array.isArray(res[1]) ? res[1] : []
    const tupleText = tupleRec
      .map((item) => Array.isArray(item) ? item[0] : firstRecordValue(item, ['text', 'words']) || item)
      .filter(Boolean)
      .join('\n')
    if (tupleText) return tupleText
    return res.map(readStructureResText).filter(Boolean).join('\n')
  }
  const html = firstRawText(res, ['html', 'table_html'])
  if (html) return html
  const recRes = asUnknownArray(readRecordValue(res, 'rec_res'))
  if (recRes.length > 0) {
    return recRes.map((item) => Array.isArray(item) ? item[0] : firstRecordValue(item, ['text', 'words']) || item).filter(Boolean).join('\n')
  }
  const recTexts = asUnknownArray(readRecordValue(res, 'rec_texts'))
  if (recTexts.length > 0) return recTexts.join('\n')
  return firstRawText(res, ['text', 'words', 'content'])
}

function getOcrBlockText(block: unknown): string {
  return normalizeOcrInlineText(getPreferredOcrBlockText(block))
}

function getOcrDedupeText(block: unknown): string {
  return getOcrBlockText(block)
    .replace(/\s+/g, '')
    .replace(/[，。；：！？、,.!?;:()[\]{}「」『』《》〈〉“”"']/g, '')
}

function isTableLabel(label: unknown): boolean {
  return /table|表格|excel|sheet/i.test(String(label || ''))
}

function isImageLabel(label: unknown): boolean {
  return /^(?:image|figure|picture|chart|diagram|photo|illustration)$/i.test(String(label || ''))
}

function getLargeOcrImageBlocks(result: unknown, pageSize: { width: number; height: number }): OcrRect[] {
  const pageArea = Math.max(1, pageSize.width * pageSize.height)
  const layoutResult = isJsonRecord(result) ? result.layout_result : undefined
  return asLayoutBlockResults(layoutResult)
    .filter((block) => isImageLabel(block.label))
    .map((block) => block.location)
    .filter((rect) => {
      const areaRatio = (rect.width * rect.height) / pageArea
      const widthRatio = rect.width / Math.max(1, pageSize.width)
      const heightRatio = rect.height / Math.max(1, pageSize.height)
      return areaRatio >= 0.1 || (widthRatio >= 0.45 && heightRatio >= 0.1)
    })
    .sort((left, right) => left.top - right.top || left.left - right.left)
}

function getRectBoundaryDelta(left: OcrRect, right: OcrRect): number {
  return Math.abs(left.left - right.left)
    + Math.abs(left.top - right.top)
    + Math.abs(left.left + left.width - right.left - right.width)
    + Math.abs(left.top + left.height - right.top - right.height)
}

function findNearestLocalImageRegion(source: OcrRect, regions: OcrRect[]): OcrRect | null {
  let best: { region: OcrRect; distance: number } | null = null
  const sourceCenterY = source.top + source.height / 2
  const sourceCenterX = source.left + source.width / 2
  for (const region of regions) {
    const regionCenterY = region.top + region.height / 2
    const regionCenterX = region.left + region.width / 2
    const distance = Math.abs(sourceCenterY - regionCenterY) * 2 + Math.abs(sourceCenterX - regionCenterX)
    if (!best || distance < best.distance) best = { region, distance }
  }
  return best?.region || null
}

export function getLikelyAsyncPdfImageCoordinateMismatchIssue(
  result: unknown,
  imagePath: string | null | undefined,
): string | null {
  if (!isJsonRecord(result)) return null
  const pageSize = getPageImageSize(imagePath)
  if (!pageSize) return null
  const ocrImageBlocks = getLargeOcrImageBlocks(result, pageSize)
  if (ocrImageBlocks.length === 0) return null
  const localImageRegions = detectLocalLargeImageRegions(imagePath)
  if (localImageRegions.length === 0) return null

  const pageWidth = Math.max(1, pageSize.width)
  const pageHeight = Math.max(1, pageSize.height)
  for (const blockRect of ocrImageBlocks.slice(0, 6)) {
    const localRegion = findNearestLocalImageRegion(blockRect, localImageRegions)
    if (!localRegion) continue
    const boundaryDelta = getRectBoundaryDelta(blockRect, localRegion)
    const touchesPageWidth = blockRect.left <= pageWidth * 0.025
      && blockRect.width >= pageWidth * 0.86
    const localHasVisibleMargins = localRegion.left >= pageWidth * 0.035
      && localRegion.left + localRegion.width <= pageWidth * 0.965
    const horizontalDelta = Math.abs(blockRect.left - localRegion.left)
      + Math.abs(blockRect.left + blockRect.width - localRegion.left - localRegion.width)
    const verticalDelta = Math.abs(blockRect.top - localRegion.top)
      + Math.abs(blockRect.top + blockRect.height - localRegion.top - localRegion.height)
    const largeBoundaryDelta = boundaryDelta >= Math.max(60, Math.min(pageWidth, pageHeight) * 0.11)
    const croppedPdfImageBlock = touchesPageWidth
      && localHasVisibleMargins
      && (horizontalDelta >= pageWidth * 0.07 || verticalDelta >= pageHeight * 0.06)
    if (largeBoundaryDelta && croppedPdfImageBlock) {
      return 'Async PDF OCR image block coordinates do not match the local page image; rerunning this page with page-image OCR.'
    }
  }
  return null
}

function isDecorativeOcrLabel(label: unknown): boolean {
  return /header|footer|number|page/i.test(String(label || ''))
}

function parseMarkdownImageBlocks(markdownText: string): MarkdownImageBlock[] {
  const text = String(markdownText || '')
  if (!text) return []
  const blocks: MarkdownImageBlock[] = []
  const patterns = [
    /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*\balt=(["'])(.*?)\3[^>]*>/gi,
    /<img\b[^>]*\balt=(["'])(.*?)\1[^>]*\bsrc=(["'])(.*?)\3[^>]*>/gi,
    /!\[([^\]]*)\]\(([^)]+)\)/g,
  ]
  patterns.forEach((pattern, patternIndex) => {
    for (const match of text.matchAll(pattern)) {
      const src = patternIndex === 1 ? String(match[4] || '') : String(match[2] || '')
      const alt = patternIndex === 1 ? String(match[2] || '') : String(match[4] || match[1] || '')
      const coordinateMatch = src.match(/(?:image[_-]?box|box)[_-](\d+)[_-](\d+)[_-](\d+)[_-](\d+)/i)
      if (!coordinateMatch) continue
      const left = Number(coordinateMatch[1])
      const top = Number(coordinateMatch[2])
      const right = Number(coordinateMatch[3])
      const bottom = Number(coordinateMatch[4])
      if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue
      blocks.push({
        src: src.trim(),
        alt: alt.trim(),
        index: match.index ?? 0,
        location: {
          left,
          top,
          width: right - left,
          height: bottom - top,
        },
      })
    }
  })
  return blocks
}

function resolveMarkdownImageSrc(src: string, markdownValue: unknown): string {
  const value = String(src || '').trim()
  if (!value) return ''
  const images = readRecordValue(markdownValue, 'images')
  const mapped = readRecordValue(images, value)
  return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : value
}

function getLayoutBlockImagePath(block: LayoutBlockResult): string {
  return String(block?.image_asset_path || block?.asset_path || block?.image_path || '').trim()
}

function isRenderableOcrImagePath(value: string): boolean {
  const path = String(value || '').trim()
  return Boolean(path) && !/^(?:imgs?|images?)\//i.test(path)
}

function isDedupeCandidateBlock(block: LayoutBlockResult): boolean {
  if (!block?.location) return false
  if (isTableLabel(block.label)) return false
  if (isImageLabel(block.label)) return false
  const compact = getOcrDedupeText(block)
  if (compact.length < 18) return false
  const orientation = inferOrientation(block)
  const label = String(block.label || '').toLowerCase()
  return orientation === 'vertical' || /text|paragraph|title|vertical|column|ocr/i.test(label)
}

function textSimilarity(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (longer.includes(shorter) && shorter.length >= 18) return shorter.length / longer.length
  const grams = new Map<string, number>()
  for (let index = 0; index < shorter.length - 1; index += 1) {
    const gram = shorter.slice(index, index + 2)
    grams.set(gram, (grams.get(gram) || 0) + 1)
  }
  if (grams.size === 0) return 0
  let overlap = 0
  for (let index = 0; index < longer.length - 1; index += 1) {
    const gram = longer.slice(index, index + 2)
    const count = grams.get(gram) || 0
    if (count > 0) {
      overlap += 1
      grams.set(gram, count - 1)
    }
  }
  return (overlap * 2) / Math.max(1, shorter.length + longer.length - 2)
}

function rectIntersectionArea(left: LayoutLocation, right: LayoutLocation): number {
  const x1 = Math.max(left.left, right.left)
  const y1 = Math.max(left.top, right.top)
  const x2 = Math.min(left.left + left.width, right.left + right.width)
  const y2 = Math.min(left.top + left.height, right.top + right.height)
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

function rectArea(rect: LayoutLocation): number {
  return Math.max(1, rect.width) * Math.max(1, rect.height)
}

function rectOverlapRatio(left: LayoutLocation, right: LayoutLocation): number {
  const intersection = rectIntersectionArea(left, right)
  if (intersection <= 0) return 0
  return intersection / Math.min(rectArea(left), rectArea(right))
}

function shouldTreatAsDuplicateBlock(left: LayoutBlockResult, right: LayoutBlockResult): boolean {
  if (!isDedupeCandidateBlock(left) || !isDedupeCandidateBlock(right)) return false
  const leftText = getOcrDedupeText(left)
  const rightText = getOcrDedupeText(right)
  const similarity = textSimilarity(leftText, rightText)
  if (similarity < 0.92) return false
  const overlap = rectOverlapRatio(left.location, right.location)
  if (overlap >= 0.48) return true
  if (similarity >= 0.98 && Math.min(leftText.length, rightText.length) >= 28) return true
  return similarity >= 0.95 && overlap >= 0.2
}

function scoreDedupeBlock(block: LayoutBlockResult): number {
  const textLength = getOcrDedupeText(block).length
  const confidence = Number.isFinite(Number(block.confidence ?? block.score)) ? Number(block.confidence ?? block.score) : 1
  const area = rectArea(block.location)
  const sourceBonus = block.segmentation_source === 'cloud_column_ocr' ? 8 : block.segmentation_source === 'local_second_pass' ? 4 : 0
  const orderPenalty = Number.isFinite(Number(block.reading_order)) ? Number(block.reading_order) * 0.01 : 0
  return confidence * 10 + Math.min(textLength, 220) + Math.min(area / 10000, 30) + sourceBonus - orderPenalty
}

export function dedupeOcrLayoutBlocks(blocks: LayoutBlockResult[]): {
  blocks: LayoutBlockResult[]
  removed: LayoutBlockResult[]
  removedIndexes: number[]
} {
  if (!Array.isArray(blocks) || blocks.length < 2) return { blocks: blocks || [], removed: [], removedIndexes: [] }
  const removedIndexes = new Set<number>()
  const removed: LayoutBlockResult[] = []

  for (let leftIndex = 0; leftIndex < blocks.length; leftIndex += 1) {
    if (removedIndexes.has(leftIndex)) continue
    for (let rightIndex = leftIndex + 1; rightIndex < blocks.length; rightIndex += 1) {
      if (removedIndexes.has(rightIndex)) continue
      const left = blocks[leftIndex]
      const right = blocks[rightIndex]
      if (!shouldTreatAsDuplicateBlock(left, right)) continue
      const removeIndex = scoreDedupeBlock(left) >= scoreDedupeBlock(right) ? rightIndex : leftIndex
      removedIndexes.add(removeIndex)
      removed.push(blocks[removeIndex])
      if (removeIndex === leftIndex) break
    }
  }

  return {
    blocks: blocks.filter((_, index) => !removedIndexes.has(index)),
    removed,
    removedIndexes: Array.from(removedIndexes),
  }
}

function getDedupeTextBlocks(blocks: LayoutBlockResult[]): {
  textBlocks: LayoutBlockResult[]
  removed: LayoutBlockResult[]
} {
  const deduped = dedupeOcrLayoutBlocks(blocks)
  if (deduped.removedIndexes.length === 0) return { textBlocks: blocks, removed: [] }
  const removedIndexes = new Set(deduped.removedIndexes)
  return {
    textBlocks: blocks.filter((_, index) => !removedIndexes.has(index)),
    removed: deduped.removed,
  }
}

function collectBlockTableData(block: unknown): {
  rows: string[][]
  html?: string
  markdown?: string
  cells?: Array<Record<string, unknown>>
} {
  const directRows = normalizeTableRows(firstRecordValue(block, ['rows', 'table_rows', 'tableRows']))
  const rawCells = firstRecordValue(block, ['cells', 'table_cells', 'tableCells'])
  const cells = asRecordArray(rawCells)
  const cellRows = directRows.length > 0 ? [] : tableRowsFromCells(cells)
  const blockContent = rawPrimitiveText(readRecordValue(block, 'block_content'))
  const html = String(firstRecordValue(block, ['html', 'table_html', 'tableHtml']) || (/</.test(blockContent) ? blockContent : '') || '').trim()
  const htmlRows = directRows.length || cellRows.length ? [] : parseHtmlTableRows(html)
  const markdown = String(firstRecordValue(block, ['markdown', 'md']) || (!html && /^\s*\|.+\|/m.test(blockContent) ? blockContent : '') || '').trim()
  const markdownRows = directRows.length || cellRows.length || htmlRows.length ? [] : parseMarkdownTableRows(markdown || blockContent || rawPrimitiveText(readRecordValue(block, 'text')))
  return {
    rows: directRows.length ? directRows : cellRows.length ? cellRows : htmlRows.length ? htmlRows : markdownRows,
    html: html || undefined,
    markdown: markdown || undefined,
    cells: cells.length ? cells : undefined,
  }
}

function rebuildWordsResultFromLayout(result: OcrResultPayload): OcrResultPayload {
  const sourceBlocks = asLayoutBlockResults(result.layout_result)
  const deduped = getDedupeTextBlocks(sourceBlocks)
  const textBlocks = deduped.textBlocks
  const text = textBlocks.map((block) => {
    const rows = normalizeTableRows(firstRecordValue(block, ['rows', 'table_rows']))
    if (rows.length > 0) return tableRowsToText(rows)
    return getOcrBlockText(block)
  }).filter(Boolean).join('\n')
  return {
    ...result,
    dedupe_meta: {
      ...(isJsonRecord(result.dedupe_meta) ? result.dedupe_meta : {}),
      removed_duplicate_blocks: deduped.removed.length,
      removed_samples: deduped.removed.slice(0, 12).map((block) => ({
        words: getOcrBlockText(block).slice(0, 120),
        location: block.location,
        reading_order: block.reading_order,
      })),
    },
    layout_result: sourceBlocks,
    words_result: text.split('\n').map((line) => ({ words: line })),
  }
}

function applyLocalSecondPassSegmentation(result: OcrResultPayload, imagePath: string, options: Required<PageOcrOptions>): OcrResultPayload {
  const blocks = asLayoutBlockResults(result.layout_result)
  if (blocks.length === 0) return attachProcessingMeta(result, options, imagePath)

  const nextBlocks: LayoutBlockResult[] = []
  let pageImage: Electron.NativeImage | null | undefined
  const getPageImage = (): Electron.NativeImage | null => {
    if (pageImage !== undefined) return pageImage
    const image = nativeImage.createFromPath(imagePath)
    pageImage = image.isEmpty() ? null : image
    return pageImage
  }
  blocks.forEach((rawBlock) => {
    const block: LayoutBlockResult = {
      ...rawBlock,
      orientation: options.profile === 'guji_print_vertical'
        ? inferGujiVerticalOrientation(rawBlock)
        : inferOrientation(rawBlock),
      segmentation_source: asSegmentationSource(rawBlock.segmentation_source) || 'ocr',
    }

    const shouldSplitBlock = shouldSplitVerticalBlock(block)
      || shouldProbeHorizontalBlockForVerticalColumns(block, options.profile === 'guji_print_vertical')
    if (!shouldSplitBlock) {
      nextBlocks.push(block)
      return
    }

    const image = getPageImage()
    const columns = image ? analyzeVerticalColumnsFromImage(image, block) : []
    if (columns.length <= 1) {
      nextBlocks.push(...splitMergedWideVerticalTextBlock(block))
      return
    }

    const capacities = columns.map((column) => column.slotCount)
    const segments = sliceVerticalText(block.words, capacities)
    columns.forEach((column, columnIndex) => {
      const segment = segments[columnIndex]
      if (!segment) return
      nextBlocks.push({
        ...block,
        words: segment,
        location: {
          left: column.left,
          top: column.top,
          width: column.width,
          height: column.height,
        },
        orientation: 'vertical',
        segmentation_source: 'local_second_pass',
        slot_count: column.slotCount,
        mask_polygon: createMaskPolygon({
          left: column.left,
          top: column.top,
          width: column.width,
          height: column.height,
        }),
        needs_enhancement: true,
      })
    })
  })

  const orderedBlocks = annotateReadingOrder(nextBlocks, options.profile === 'guji_print_vertical')
  const rebuilt = rebuildWordsResultFromLayout({
    ...result,
    layout_result: orderedBlocks,
  })
  const split = splitMergedWideVerticalTextLineBlocks(rebuilt, options)
  return filterGujiTinyNoiseBlocks(attachProcessingMeta(split, options, imagePath), options)
}

function cropImageToDataUrl(filePath: string, location: LayoutLocation): string {
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) {
    throw new Error('无法读取页面图像')
  }
  const size = image.getSize()
  const x = clamp(Math.round(location.left), 0, Math.max(0, size.width - 1))
  const y = clamp(Math.round(location.top), 0, Math.max(0, size.height - 1))
  const width = clamp(Math.round(location.width), 1, Math.max(1, size.width - x))
  const height = clamp(Math.round(location.height), 1, Math.max(1, size.height - y))
  const cropped = image.crop({
    x,
    y,
    width,
    height,
  })
  return cropped.toDataURL()
}

export async function recognizeImageRegion(
  filePath: string,
  location: OcrBoundingBox,
  preferVertical = false,
): Promise<OcrRecognizeResult> {
  const dataUrl = cropImageToDataUrl(filePath, location)
  return recognizeImage(dataUrl, { preferVertical })
}

function getResultPlainText(result: OcrResultPayload): string {
  return result.words_result?.map((item) => item.words || '').join('') || ''
}

function getCompactText(value: string): string {
  return normalizeOcrInlineText(value).replace(/\s+/g, '')
}

function shouldUseEnhancedColumnText(block: LayoutBlockResult, enhancedText: string): boolean {
  const nextText = getCompactText(enhancedText)
  if (!nextText) return false

  const localText = getCompactText(block.words || '')
  if (!localText) return nextText.length <= Math.max(24, Number(block.slot_count || 0) * 3)

  const slotLimit = Math.max(12, Number(block.slot_count || 0) * 3)
  const lengthLimit = Math.max(24, Math.min(Math.max(localText.length * 2.4, slotLimit), localText.length + 36))
  if (nextText.length > lengthLimit) return false

  return true
}

function getColumnFallbackKey(block: LayoutBlockResult): string {
  const location = block.location || { left: 0, top: 0, width: 0, height: 0 }
  return [
    Math.round(location.left),
    Math.round(location.top),
    Math.round(location.width),
    Math.round(location.height),
    getCompactText(block.words || '').slice(0, 24),
  ].join(':')
}

async function applyCloudColumnSecondPass(
  result: OcrResultPayload,
  imagePath: string,
  options: Required<PageOcrOptions>,
  runtimeOptions: OcrRuntimeOptions = {},
): Promise<OcrResultPayload> {
  const locallySegmented = applyLocalSecondPassSegmentation(result, imagePath, {
    ...options,
    secondPass: 'local_segmentation',
  })
  const blocks = asLayoutBlockResults(locallySegmented.layout_result)
  const nextBlocks: LayoutBlockResult[] = []

  for (const block of blocks) {
    throwIfAborted(runtimeOptions.signal)
    if ((block.segmentation_source !== 'local_second_pass' && !block.needs_enhancement) || inferOrientation(block) !== 'vertical') {
      nextBlocks.push({
        ...block,
        segmentation_source: block.segmentation_source || 'ocr',
      })
      continue
    }

    try {
      const dataUrl = cropImageToDataUrl(imagePath, block.location)
      const enhanced = await recognizeImage(dataUrl, { preferVertical: true, signal: runtimeOptions.signal })
      const enhancedText = getResultPlainText(enhanced)
      const useEnhancedText = shouldUseEnhancedColumnText(block, enhancedText)
      const fallbackKey = getColumnFallbackKey(block)
      nextBlocks.push({
        ...block,
        words: useEnhancedText ? enhancedText : block.words,
        dedupe_fallback_key: fallbackKey,
        segmentation_source: useEnhancedText ? 'cloud_column_ocr' : 'local_second_pass',
        needs_enhancement: !useEnhancedText,
      })
    } catch (error) {
      if (isOcrAbortError(error)) throw error
      nextBlocks.push(block)
    }
  }

  // Cloud OCR can occasionally return the same long paragraph for several
  // narrow vertical columns. Keep the local column layout intact; text
  // dedupe happens when words_result is rebuilt below.

  const orderedBlocks = annotateReadingOrder(nextBlocks, options.profile === 'guji_print_vertical')
  const rebuilt = attachProcessingMeta(rebuildWordsResultFromLayout({
    ...locallySegmented,
    layout_result: orderedBlocks,
  }), options, imagePath)
  return filterGujiTinyNoiseBlocks(rebuilt, options)
}

export async function postProcessRecognizedPageResult(
  result: unknown,
  imagePath: string | null | undefined,
  options?: PageOcrOptions,
  runtimeOptions: OcrRuntimeOptions = {},
): Promise<OcrResultPayload> {
  throwIfAborted(runtimeOptions.signal)
  let resolved = resolveOcrOptions(options)
  const normalizedInput = isOcrResultPayload(result) ? result : normalizePageResult(result)
  const preserveServiceCoordinates = runtimeOptions.preserveServiceCoordinates === true
  const scaledInput = preserveServiceCoordinates
    ? normalizedInput
    : scaleOcrResultToOriginalImage(normalizedInput, runtimeOptions.uploadImage)
  const coordinateCorrectedInput = preserveServiceCoordinates
    ? scaledInput
    : correctRotatedOcrCoordinatesForSourceImage(scaledInput, imagePath, resolved)
  const orientationNormalizedInput = !preserveServiceCoordinates && resolved.profile === 'guji_print_vertical'
    ? normalizeGujiVerticalBlockOrientation(coordinateCorrectedInput)
    : coordinateCorrectedInput
  const downgradedInput = preserveServiceCoordinates
    ? orientationNormalizedInput
    : downgradeVerticalPseudoTableBlocks(orientationNormalizedInput, resolved)
  const clampedInput = !preserveServiceCoordinates && resolved.profile === 'guji_print_vertical'
    ? clampGujiOcrResultToSourceImage(downgradedInput, imagePath)
    : downgradedInput
  const workingResult = clampedInput
  const coordinateTightenedInput = !preserveServiceCoordinates && runtimeOptions.tightenTextCoordinatesToLocalInk
    ? tightenOcrTextCoordinatesToLocalInk(workingResult, imagePath)
    : workingResult
  const autoVertical = !preserveServiceCoordinates && imagePath && resolved.profile !== 'guji_print_vertical' && shouldAutoUseVerticalPostProcessing(coordinateTightenedInput)
  if (autoVertical) {
    resolved = { ...resolved, profile: 'guji_print_vertical', secondPass: 'local_segmentation' }
  }
  if (preserveServiceCoordinates) {
    const serviceCoordinateResult = isOcrResultPayload(coordinateTightenedInput) ? coordinateTightenedInput : normalizePageResult(coordinateTightenedInput)
    const fallbackSize = runtimeOptions.serviceCoordinateFallbackSize || getImageDimensions(imagePath)
    const serviceCoordinateWithFallback = fallbackSize && fallbackSize.width > 0 && fallbackSize.height > 0
      ? {
        ...serviceCoordinateResult,
        guji_processing: {
          ...(isJsonRecord(serviceCoordinateResult.guji_processing) ? serviceCoordinateResult.guji_processing : {}),
          service_coordinate_fallback_width: fallbackSize.width,
          service_coordinate_fallback_height: fallbackSize.height,
        },
      }
      : serviceCoordinateResult
    const preserved = markServiceCoordinatesPreserved(attachProcessingMeta(serviceCoordinateWithFallback, resolved, imagePath, {
      preserveServiceCoordinates: true,
    }))
    return runtimeOptions.alignServiceCoordinatesToLocalImage === false
      ? preserved
      : alignServiceCoordinatesToLocalImage(preserved, imagePath)
  }
  if (!imagePath || resolved.profile !== 'guji_print_vertical') {
    return attachProcessingMeta(isOcrResultPayload(coordinateTightenedInput) ? coordinateTightenedInput : normalizePageResult(coordinateTightenedInput), resolved, imagePath)
  }

  const normalizedWorkingResult = isOcrResultPayload(coordinateTightenedInput) ? coordinateTightenedInput : normalizePageResult(coordinateTightenedInput)
  const existingMeta = normalizedWorkingResult.guji_processing
  const currentFingerprint = getImageFingerprint(imagePath)
  if (
    readRecordValue(existingMeta, 'profile') === resolved.profile &&
    readRecordValue(existingMeta, 'second_pass') === resolved.secondPass &&
    readRecordValue(existingMeta, 'source_image_fingerprint') === currentFingerprint
  ) {
    return normalizedWorkingResult
  }

  if (resolved.secondPass === 'cloud_column_ocr') {
    return applyCloudColumnSecondPass(normalizedWorkingResult, imagePath, resolved, runtimeOptions)
  }

  if (resolved.secondPass === 'local_segmentation') {
    return applyLocalSecondPassSegmentation(normalizedWorkingResult, imagePath, resolved)
  }

  return attachProcessingMeta(normalizedWorkingResult, resolved, imagePath)
}

export function normalizePageResult(layoutPage: unknown): OcrResultPayload {
  const layoutPageRecord = isJsonRecord(layoutPage) ? layoutPage : {}
  const resValue = readRecordValue(layoutPageRecord, 'res')
  const sourcePage: JsonRecord = isJsonRecord(resValue) ? { ...resValue, ...layoutPageRecord } : layoutPageRecord
  const sourceRes = readRecordValue(sourcePage, 'res')
  const sourcePruned = readRecordValue(sourcePage, 'prunedResult')
  const resPruned = readRecordValue(sourceRes, 'prunedResult')
  const servicePageWidth = positiveNumber(firstRecordValue(sourcePage, ['page_width', 'image_width', 'width', 'source_image_width']))
    ?? positiveNumber(firstRecordValue(sourcePruned, ['page_width', 'image_width', 'width', 'source_image_width']))
    ?? positiveNumber(firstRecordValue(resPruned, ['page_width', 'image_width', 'width', 'source_image_width']))
  const servicePageHeight = positiveNumber(firstRecordValue(sourcePage, ['page_height', 'image_height', 'height', 'source_image_height']))
    ?? positiveNumber(firstRecordValue(sourcePruned, ['page_height', 'image_height', 'height', 'source_image_height']))
    ?? positiveNumber(firstRecordValue(resPruned, ['page_height', 'image_height', 'height', 'source_image_height']))
  const markdownValue = readRecordValue(sourcePage, 'markdown')
  const markdownText = typeof markdownValue === 'string'
    ? markdownValue
    : rawPrimitiveText(readRecordValue(markdownValue, 'text'))
  let fullText = normalizeOcrInlineText(markdownText || rawPrimitiveText(readRecordValue(sourcePage, 'text')))
  const regionBoxes: LayoutBlockResult[] = []

  const parsingResList = firstNonEmptyArray([
    readRecordValue(sourcePage, 'parsing_res_list'),
    readRecordValue(sourcePruned, 'parsing_res_list'),
    readRecordValue(resPruned, 'parsing_res_list'),
  ])
  if (parsingResList.length > 0) {
    for (const block of parsingResList) {
      const rect = toLocationRect(firstRecordValue(block, ['block_bbox', 'bbox', 'box', 'coordinate', 'points', 'location']))
      if (!rect) continue
      const tableData = collectBlockTableData(block)
      const rawLabel = rawPrimitiveText(readRecordValue(block, 'block_label'))
      const label = tableData.rows.length > 0 || isTableLabel(rawLabel) ? 'table' : rawLabel
      const preferredText = getPreferredOcrBlockText(block).trim()
      const rawText = getRawOcrBlockText(block).trim()
      const blockOrder = finiteNumber(readRecordValue(block, 'block_order'))
      regionBoxes.push({
        words: tableData.rows.length > 0 ? tableRowsToText(tableData.rows) : preferredText,
        raw_words: tableData.rows.length > 0 ? undefined : rawText,
        location: rect,
        label,
        rows: tableData.rows.length > 0 ? tableData.rows : undefined,
        table_rows: tableData.rows.length > 0 ? tableData.rows : undefined,
        cells: tableData.cells,
        table_cells: tableData.cells,
        html: tableData.html,
        table_html: tableData.html,
        markdown: tableData.markdown,
        reading_order: blockOrder ?? undefined,
        block_order: blockOrder ?? undefined,
        score: finiteNumber(readRecordValue(block, 'score')) ?? undefined,
      })
    }
  } else {
    const layoutDet = readRecordValue(sourcePage, 'layout_det_res')
    const resLayoutDet = readRecordValue(sourceRes, 'layout_det_res')
    const boxes = firstNonEmptyArray([
      readRecordValue(sourcePage, 'layout_result'),
      readRecordValue(layoutDet, 'boxes'),
      readRecordValue(resLayoutDet, 'boxes'),
      readRecordValue(sourcePage, 'boxes'),
      readRecordValue(sourcePage, 'regions'),
      readRecordValue(sourcePage, 'layout'),
    ])
    for (const box of boxes) {
      const rect = toLocationRect(firstRecordValue(box, ['coordinate', 'bbox', 'box', 'coordinate_box', 'points', 'location', 'block_bbox']))
      if (!rect) continue
      const tableData = collectBlockTableData(box)
      const rawLabel = firstRawText(box, ['label', 'block_label', 'type'])
      const label = tableData.rows.length > 0 || isTableLabel(rawLabel) ? 'table' : rawLabel
      const preferredText = getPreferredOcrBlockText(box).trim()
      const rawText = getRawOcrBlockText(box).trim()
      const blockOrder = finiteNumber(firstRecordValue(box, ['block_order', 'reading_order']))
      regionBoxes.push({
        words: tableData.rows.length > 0 ? tableRowsToText(tableData.rows) : preferredText,
        raw_words: tableData.rows.length > 0 ? undefined : rawText,
        location: rect,
        label,
        rows: tableData.rows.length > 0 ? tableData.rows : undefined,
        table_rows: tableData.rows.length > 0 ? tableData.rows : undefined,
        cells: tableData.cells,
        table_cells: tableData.cells,
        html: tableData.html,
        table_html: tableData.html,
        markdown: tableData.markdown,
        reading_order: blockOrder ?? undefined,
        block_order: blockOrder ?? undefined,
        score: finiteNumber(readRecordValue(box, 'score')) ?? undefined,
      })
    }
  }

  const overallOcr = firstRecordValue(sourcePage, ['overall_ocr_res']) || readRecordValue(sourceRes, 'overall_ocr_res')
  if (regionBoxes.length === 0) {
    const recTexts = firstNonEmptyArray([
      readRecordValue(sourcePage, 'rec_texts'),
      readRecordValue(overallOcr, 'rec_texts'),
    ])
    const recCoords = firstNonEmptyArray([
      readRecordValue(sourcePage, 'rec_boxes'),
      readRecordValue(sourcePage, 'rec_polys'),
      readRecordValue(sourcePage, 'dt_polys'),
      readRecordValue(overallOcr, 'rec_boxes'),
      readRecordValue(overallOcr, 'rec_polys'),
      readRecordValue(overallOcr, 'dt_polys'),
    ])
    const recScores = firstNonEmptyArray([
      readRecordValue(sourcePage, 'rec_scores'),
      readRecordValue(overallOcr, 'rec_scores'),
    ])

    recTexts.forEach((text, index) => {
      const rect = toLocationRect(recCoords[index])
      if (!rect) return
      const rawText = rawPrimitiveText(text)
      regionBoxes.push({
        words: rawText,
        raw_words: rawText,
        location: rect,
        label: 'text',
        score: Number(recScores[index] || 0),
      })
    })

    if (!fullText && recTexts.length > 0) {
      fullText = recTexts.map((item) => normalizeOcrInlineText(rawPrimitiveText(item))).filter(Boolean).join('\n')
    }
  }

  if (regionBoxes.length > 0) {
    const recTexts = asUnknownArray(readRecordValue(overallOcr, 'rec_texts'))
    const recCoords = firstNonEmptyArray([
      readRecordValue(overallOcr, 'rec_boxes'),
      readRecordValue(overallOcr, 'rec_polys'),
      readRecordValue(overallOcr, 'dt_polys'),
    ])
    if (recTexts.length > 0 && recCoords.length > 0) {
      regionBoxes.forEach((box) => {
        if (box.words) return
        const blockCenterX = box.location.left + box.location.width / 2
        const blockCenterY = box.location.top + box.location.height / 2
        const lines = recTexts
          .map((text, index): { text: string; rect: LayoutLocation; distance: number } | null => {
            const rect = toLocationRect(recCoords[index])
            if (!rect) return null
            const centerX = rect.left + rect.width / 2
            const centerY = rect.top + rect.height / 2
            const inside = centerX >= box.location.left - 3
              && centerX <= box.location.left + box.location.width + 3
              && centerY >= box.location.top - 3
              && centerY <= box.location.top + box.location.height + 3
            if (!inside) return null
            return { text: rawPrimitiveText(text), rect, distance: Math.abs(centerY - blockCenterY) + Math.abs(centerX - blockCenterX) * 0.05 }
          })
          .filter((item): item is { text: string; rect: LayoutLocation; distance: number } => item !== null)
          .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left || left.distance - right.distance)
          .map((item) => item.text)
          .filter(Boolean)
        if (lines.length > 0) {
          box.words = lines.join('\n')
          box.raw_words = box.words
        }
      })
    }
  }

  const markdownImageBlocks = parseMarkdownImageBlocks(markdownText)
  for (const imageBlock of markdownImageBlocks) {
    const imagePath = resolveMarkdownImageSrc(imageBlock.src, markdownValue)
    const overlappingImageBox = regionBoxes.find((box) => (
      isImageLabel(box.label)
      && rectOverlapRatio(box.location, imageBlock.location) >= 0.6
    ))
    if (overlappingImageBox) {
      if (!isRenderableOcrImagePath(getLayoutBlockImagePath(overlappingImageBox)) && isRenderableOcrImagePath(imagePath)) {
        overlappingImageBox.words = getOcrBlockText(overlappingImageBox) || imageBlock.alt || 'image'
        overlappingImageBox.raw_words = overlappingImageBox.words
        overlappingImageBox.image_path = imagePath
        overlappingImageBox.asset_path = imagePath
        overlappingImageBox.image_asset_path = imagePath
      }
      continue
    }
    const imageBottom = imageBlock.location.top + imageBlock.location.height
    const followingBlock = regionBoxes
      .filter((box) => !isDecorativeOcrLabel(box.label) && Number.isFinite(Number(box.block_order)))
      .filter((box) => box.location.top >= imageBottom - Math.max(12, imageBlock.location.height * 0.08))
      .sort((left, right) => left.location.top - right.location.top || Number(left.block_order) - Number(right.block_order))[0]
    const maxBlockOrder = regionBoxes.reduce((max, box) => Number.isFinite(Number(box.block_order)) ? Math.max(max, Number(box.block_order)) : max, 0)
    const imageBlockOrder = followingBlock && Number(followingBlock.block_order) > 0
      ? Number(followingBlock.block_order) - 0.5
      : maxBlockOrder + 0.5
    regionBoxes.push({
      words: imageBlock.alt || 'image',
      raw_words: imageBlock.alt || 'image',
      location: imageBlock.location,
      label: 'image',
      image_path: imagePath,
      asset_path: imagePath,
      image_asset_path: imagePath,
      block_order: imageBlockOrder,
      segmentation_source: 'ocr',
    })
  }

  const orderedBoxes = annotateReadingOrder(regionBoxes.filter((box) => box.words || isTableLabel(box.label) || isImageLabel(box.label)))
  const orderedDedupe = getDedupeTextBlocks(orderedBoxes)
  const textBoxes = orderedDedupe.textBlocks

  if ((!fullText || orderedDedupe.removed.length > 0) && textBoxes.length > 0) {
    fullText = textBoxes.map((item) => getOcrBlockText(item)).filter(Boolean).join('\n')
  } else if (shouldPreferVerticalOrder(orderedBoxes)) {
    fullText = textBoxes.map((item) => getOcrBlockText(item)).filter(Boolean).join('\n')
  }

  const lines = fullText.split('\n').map((line) => line.trim()).filter(Boolean)
  const servicePageSize = servicePageWidth && servicePageHeight
    ? {
      page_width: servicePageWidth,
      page_height: servicePageHeight,
      image_width: servicePageWidth,
      image_height: servicePageHeight,
    }
    : {}
  return {
    ...servicePageSize,
    markdown: markdownValue || null,
    words_result: lines.map((line) => ({ words: line })),
    layout_result: orderedBoxes,
    dedupe_meta: {
      removed_duplicate_blocks: orderedDedupe.removed.length,
      removed_samples: orderedDedupe.removed.slice(0, 12).map((block) => ({
        words: getOcrBlockText(block).slice(0, 120),
        location: block.location,
        reading_order: block.reading_order,
      })),
    },
  }
}

interface SyncRecognitionOptions {
  preferVertical?: boolean
  signal?: AbortSignal
}

interface OcrRuntimeOptions {
  signal?: AbortSignal
  concurrency?: number
  uploadImage?: OcrUploadImage | null
  tightenTextCoordinatesToLocalInk?: boolean
  preserveServiceCoordinates?: boolean
  serviceCoordinateFallbackSize?: { width: number; height: number } | null
  alignServiceCoordinatesToLocalImage?: boolean
}

async function requestSyncRecognition(base64Image: string, options: SyncRecognitionOptions = {}): Promise<OcrResultPayload> {
  throwIfAborted(options.signal)
  const imageBase64 = base64Image.replace(/^data:image\/[a-z]+;base64,/, '')
  const preferVertical = Boolean(options.preferVertical)

  const payload = {
    file: imageBase64,
    fileType: 1,
    useDocOrientationClassify: preferVertical,
    useTextlineOrientation: preferVertical,
    useDocUnwarping: false,
    useChartRecognition: !preferVertical,
    textDetLimitType: preferVertical ? 'max' : undefined,
    textDetLimitSideLen: preferVertical ? 2000 : undefined,
  }

  const excludedTokenIds = new Set<string>()
  while (true) {
    const lease = acquirePaddleOcrToken(excludedTokenIds)
    try {
      const response = await fetchWithTimeout(SYNC_OCR_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `token ${lease.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      }, getOcrUploadTimeoutMs(), 'OCR 上传超时，请在设置中调大“上传超时”，或降低上传最长边/JPEG 质量后重试。')

      const data = await response.json().catch(() => ({})) as JsonRecord
      if (!response.ok) {
        const detail = getApiErrorMessage(data, '')
        const error = new Error(`OCR 接口请求失败，状态码 ${response.status}${detail ? `：${detail}` : ''}`) as Error & { status?: number; code?: number | string }
        error.status = response.status
        const code = getApiErrorCode(data)
        if (code !== undefined) error.code = code
        throw error
      }

      const errorCode = readRecordValue(data, 'errorCode')
      if (errorCode && errorCode !== 0) {
        const error = new Error(`OCR 失败：${data.errorMsg || '未知错误'}`) as Error & { code?: number | string }
        error.code = errorCode as number | string
        throw error
      }

      const snakeErrorCode = readRecordValue(data, 'error_code')
      if (snakeErrorCode && snakeErrorCode !== 0) {
        const error = new Error(`OCR 失败：${data.error_msg || '未知错误'}`) as Error & { code?: number | string }
        error.code = snakeErrorCode as number | string
        throw error
      }

      const resultPayload = readRecordValue(data, 'result')
      if (!resultPayload) {
        throw new Error('OCR 失败：接口没有返回识别结果')
      }

      const layoutResults = asUnknownArray(readRecordValue(resultPayload, 'layoutParsingResults'))
      const firstPage = layoutResults[0] || {}
      return normalizePageResult(firstPage)
    } catch (error) {
      if (isOcrAbortError(error)) throw error
      if (!isPaddleOcrTokenFailure(error)) throw error
      markPaddleOcrTokenFailure(lease, error)
      excludedTokenIds.add(lease.id)
    }
  }
}

export function mapClockwiseOcrResultToSourcePage(
  result: OcrRecognizeResult,
  sourceWidth: number,
  sourceHeight: number,
): OcrRecognizeResult {
  const record = result as OcrResultPayload
  const processing = isJsonRecord(record.guji_processing) ? record.guji_processing : {}
  const mapped: OcrResultPayload = {
    ...record,
    page_width: sourceWidth,
    page_height: sourceHeight,
    source_image_width: sourceWidth,
    source_image_height: sourceHeight,
    layout_result: Array.isArray(record.layout_result)
      ? record.layout_result.map((block) => rotateClockwiseLayoutBlockCoordinatesToSource(block, sourceWidth))
      : record.layout_result,
    words_result: Array.isArray(record.words_result)
      ? record.words_result.map((word) => rotateClockwiseWordCoordinatesToSource(word, sourceWidth))
      : record.words_result,
    guji_processing: {
      ...processing,
      manual_image_rotation: 'clockwise_90',
      ocr_coordinate_rotation_corrected: 'clockwise_to_source',
    },
  }
  // The IR was built against the temporary rotated image. Removing it forces
  // the storage normalizer to rebuild IR coordinates from the mapped blocks.
  delete mapped.gujismart_ir
  delete mapped.ir_text
  return mapped
}

export async function recognizeImage(base64Image: string, options: SyncRecognitionOptions = {}): Promise<OcrResultPayload> {
  let attempt = 0
  let lastError: Error | null = null

  while (attempt < MAX_RETRY_ATTEMPTS) {
    throwIfAborted(options.signal)
    try {
      return await requestSyncRecognition(base64Image, options)
    } catch (error) {
      if (isOcrAbortError(error)) throw error
      const failure = error as Error & { status?: number; code?: number | string }
      lastError = failure
      attempt += 1

      if (attempt >= MAX_RETRY_ATTEMPTS || !isRetryableNetworkFailure(failure)) {
        break
      }

      const waitMs = Math.min(8000, 600 * 2 ** (attempt - 1))
      await sleep(waitMs, options.signal)
    }
  }

  throw lastError || new Error('OCR 失败')
}

export async function recognizePages(
  pages: OcrPageRecord[],
  options?: PageOcrOptions,
  onProgress?: (payload: OcrPageProgressPayload) => void,
  runtimeOptions: OcrRuntimeOptions = {},
): Promise<OcrPageResult[]> {
  const resolvedOptions = resolveOcrOptions(options)
  const pageConcurrency = normalizeOcrPageConcurrency(runtimeOptions.concurrency, getOcrConcurrency())
  const limit = createLimiter(Math.min(pageConcurrency, getOcrConcurrency()))
  const totalPages = pages.length
  let completedPages = 0

  const reportProgress = (page: OcrPageRecord, status: 'completed' | 'error', error?: string, result?: OcrResultPayload | null, text?: string) => {
    completedPages += 1
    onProgress?.({
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

  return Promise.all(
    pages.map((page) => limit(async (): Promise<OcrPageResult> => {
      throwIfAborted(runtimeOptions.signal)
      if (!page.image_path) {
        const error = `第 ${page.page_num || ''} 页缺少图像路径`
        reportProgress(page, 'error', error)
        return {
          pageId: page.id,
          result: null,
          text: '',
          status: 'error',
          error,
        }
      }

      try {
        throwIfAborted(runtimeOptions.signal)
        const uploadImage = await prepareImageForOcrUpload(page.image_path)
        throwIfAborted(runtimeOptions.signal)
        const initialResult = resolvedOptions.profile === 'guji_print_vertical'
          ? await recognizeTraditional(uploadImage.buffer.toString('base64'), runtimeOptions)
          : await recognizeImage(uploadImage.buffer.toString('base64'), runtimeOptions)
        const result = await postProcessRecognizedPageResult(initialResult, page.image_path, resolvedOptions, {
          ...runtimeOptions,
          uploadImage,
        })
        const text = result.words_result?.map((item) => item.words || '').join('\n') || ''
        const repeatedIssue = findSuspiciousRepeatedOcrText(result)
        if (repeatedIssue) {
          const message = formatSuspiciousRepeatedOcrTextIssue(repeatedIssue)
          reportProgress(page, 'error', message)
          return {
            pageId: page.id,
            result: null,
            text: '',
            status: 'error',
            error: message,
          }
        }
        reportProgress(page, 'completed', undefined, result, text)
        return {
          pageId: page.id,
          result,
          text,
          status: 'completed',
        }
      } catch (error) {
        if (isOcrAbortError(error)) throw error
        const message = (error as Error).message
        reportProgress(page, 'error', message)
        return {
          pageId: page.id,
          result: null,
          text: '',
          status: 'error',
          error: message,
        }
      }
    }))
  )
}

export function shouldUseAsyncPdfOcr(filePath?: string | null, pageCount = 0): boolean {
  if (!filePath || extname(filePath).toLowerCase() !== '.pdf') return false
  if (!existsSync(filePath)) return false
  if (pageCount > 0 && pageCount < ASYNC_PDF_PAGE_THRESHOLD) return false
  return true
}

interface PdfChunk {
  filePath: string
  startPageIndex: number
  pageCount: number
  sourcePageIndexes: number[]
  resultPageIndexes?: number[]
  pageRanges?: string
  uploadPageCount?: number
  totalChunks?: number
  fallbackWholePdf?: boolean
  fallbackReason?: string
  fullFileUpload?: boolean
  cleanup?: boolean
}

interface PdfChunkPlan {
  sourcePdf: PDFDocument | null
  sourcePath: string
  totalPages: number
  targetPageIndexes: number[]
  sourceSize: number
  estimatedPagesPerChunk: number
  estimatedTotalChunks: number
  tempRoot: string | null
  directFilePath: string | null
  wholePdfFallback?: boolean
  fallbackReason?: string
  fullFileUpload?: boolean
  requireFullFileUpload?: boolean
  qpdfEnabled?: boolean
}

interface AsyncPdfChunkResult {
  startPageIndex: number
  pageCount: number
  sourcePageIndexes: number[]
  chunkIndex: number
  totalChunks: number
  totalPages: number
  results: Array<OcrResultPayload | null>
}

interface RecognizePdfAsyncOptions {
  model?: AsyncOcrModel
  onChunkComplete?: (payload: AsyncPdfChunkResult) => void | Promise<void>
  collectChunkResults?: boolean
  signal?: AbortSignal
  targetPageNums?: number[]
  fallbackPageCount?: number
  ocrOptions?: PageOcrOptions
  requireFullFileUpload?: boolean
  pageRangeChunkSize?: number
}

interface AsyncPdfSubmitOptions {
  pageRanges?: string
  optionalPayload?: JsonRecord
}

interface AsyncPdfJobSubmission {
  jobId: string
  lease: PaddleOcrTokenLease
}

function getAsyncPdfOptionalPayload(_options?: PageOcrOptions, model?: AsyncOcrModel): JsonRecord | undefined {
  if (model && !/^PaddleOCR-VL(?:-|$)/i.test(model) && !/^PP-Structure/i.test(model)) {
    return undefined
  }

  // PaddleOCR official API expects camelCase request fields. Snake-case fields
  // are silently ignored by the async PDF endpoint, leaving doc preprocessing on
  // and causing block boxes to drift on some scanned PDFs.
  return {
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useLayoutDetection: true,
    useChartRecognition: false,
    layoutMergeBboxesMode: 'small',
    markdownIgnoreLabels: ['number', 'footnote', 'header', 'header_image', 'footer', 'footer_image', 'aside_text'],
    returnLayoutPolygonPoints: true,
  }
}

function getAsyncAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  }
}

function getJsonUrl(payload: AsyncJobStatusPayload): string {
  if (payload.jsonUrl) return payload.jsonUrl
  if (typeof payload.resultUrl === 'string') return payload.resultUrl
  return payload.resultUrl?.jsonUrl || ''
}

function getApiErrorMessage(payload: unknown, fallback = '未知错误'): string {
  if (!isJsonRecord(payload)) return fallback
  const nestedData = readRecordValue(payload, 'data')
  const nestedResult = readRecordValue(payload, 'result')
  const message = firstRawText(payload, ['error_msg', 'errorMsg', 'message', 'msg', 'detail'])
    || firstRawText(nestedData, ['error_msg', 'errorMsg', 'message', 'msg', 'detail'])
    || firstRawText(nestedResult, ['error_msg', 'errorMsg', 'message', 'msg', 'detail'])
  return message || fallback
}

function getApiErrorCode(payload: unknown): number | string | undefined {
  if (!isJsonRecord(payload)) return undefined
  const code = firstRecordValue(payload, ['error_code', 'errorCode', 'code', 'statusCode'])
  if (code === undefined || code === null || code === 0 || code === '0') return undefined
  return code as number | string
}

function getCompletedPages(payload: AsyncJobStatusPayload): number {
  return Number(payload.completedPages || payload.successPages || payload.extractProgress?.extractedPages || 0)
}

function getTotalPages(payload: AsyncJobStatusPayload, fallback = 0): number {
  return Number(payload.totalPages || payload.extractProgress?.totalPages || fallback || 0)
}

function getAsyncPollDelayMs(options: {
  pollCount: number
  changed: boolean
  completedPages: number
  totalPages: number
  allPagesCompleted: boolean
}): number {
  const { pollCount, changed, completedPages, totalPages, allPagesCompleted } = options
  if (allPagesCompleted) return ASYNC_POLL_MIN_INTERVAL_MS
  if (pollCount <= 3) return ASYNC_POLL_MIN_INTERVAL_MS
  if (changed) return Math.min(2500, ASYNC_POLL_BASE_INTERVAL_MS)
  if (totalPages > 0 && completedPages > 0) {
    const ratio = completedPages / Math.max(totalPages, 1)
    if (ratio >= 0.9) return 2000
    if (ratio >= 0.5) return Math.min(3500, ASYNC_POLL_BASE_INTERVAL_MS)
  }
  const backoffSteps = Math.max(0, pollCount - 6)
  return Math.min(ASYNC_POLL_MAX_INTERVAL_MS, ASYNC_POLL_BASE_INTERVAL_MS + backoffSteps * 1000)
}

function normalizeTargetPageIndexes(totalPages: number, targetPageNums?: number[]): number[] {
  const allIndexes = Array.from({ length: Math.max(0, totalPages) }, (_, index) => index)
  if (!targetPageNums) return allIndexes
  if (targetPageNums.length === 0) return []

  const indexes = [...new Set(targetPageNums
    .map((pageNum) => Math.floor(Number(pageNum)))
    .filter((pageNum) => Number.isFinite(pageNum) && pageNum >= 1 && pageNum <= totalPages)
    .map((pageNum) => pageNum - 1))]
    .sort((left, right) => left - right)
  return indexes
}

function normalizeAsyncPdfPageRangeChunkSize(value: unknown, totalPages: number): number {
  const pageCount = Math.max(0, Math.floor(Number(totalPages || 0)))
  const requested = Math.floor(Number(value || 0))
  if (!Number.isFinite(requested) || requested <= 0 || pageCount <= 0 || requested >= pageCount) return 0
  return Math.max(1, Math.min(ASYNC_PDF_MAX_PAGES_PER_JOB, requested))
}

function isPdfStructureError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '')
  return /PDFDict|pdf-lib|copyPages|PDF 第 \d+ 页结构异常|Expected instance|instance of undefined/i.test(message)
}

function getFallbackPdfPageCount(targetPageNums?: number[], fallbackPageCount = 0): number {
  const targetMaxPage = Math.max(0, ...(targetPageNums || [])
    .map((pageNum) => Math.floor(Number(pageNum)))
    .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0))
  const fallbackTotal = Math.floor(Number(fallbackPageCount || 0))
  return Math.max(0, targetMaxPage, Number.isFinite(fallbackTotal) ? fallbackTotal : 0)
}

function supportsFileBackedPdfUpload(): boolean {
  return typeof openAsBlob === 'function'
}

function canAttemptWholePdfUpload(sourceSize: number, totalPages: number): boolean {
  if (totalPages <= 0) return false
  return supportsFileBackedPdfUpload() || sourceSize <= ASYNC_PDF_MAX_FILE_SIZE
}

function isLocalWholePdfUploadUnavailableError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '').toLowerCase()
  return message.includes('low-memory pdf upload')
    || message.includes('低内存 pdf')
    || message.includes('不支持低内存 pdf')
}

function shouldRetryWholePdfUploadWithChunking(error: unknown, plan: PdfChunkPlan): boolean {
  if (plan.requireFullFileUpload) return false
  if (!plan.directFilePath || !(plan.fullFileUpload || plan.wholePdfFallback)) return false
  if (isOcrAbortError(error)) return false
  return isAsyncPdfUploadUnsupportedError(error) || isLocalWholePdfUploadUnavailableError(error) || isAsyncJobStalledError(error)
}

function shouldAvoidPdfLibChunkPlanFallback(sourceSize: number): boolean {
  return sourceSize > PDF_LIB_CHUNK_PLAN_MAX_FILE_SIZE
}

function shouldAvoidPdfLibChunkCopyFallback(plan: Pick<PdfChunkPlan, 'sourceSize'>): boolean {
  return shouldAvoidPdfLibChunkPlanFallback(plan.sourceSize)
}

function getPdfTargetChunkSize(sourceSize: number, totalPages: number): number {
  if (sourceSize >= 900 * 1024 * 1024 || totalPages >= 2500) {
    return ASYNC_PDF_HEAVY_TARGET_CHUNK_SIZE
  }
  return ASYNC_PDF_TARGET_CHUNK_SIZE
}

function getQpdfChunkTimeoutMs(plan: Pick<PdfChunkPlan, 'sourceSize' | 'totalPages'>): number {
  if (plan.sourceSize >= 900 * 1024 * 1024 || plan.totalPages >= 2500) {
    return QPDF_HEAVY_CHUNK_TIMEOUT_MS
  }
  return QPDF_CHUNK_TIMEOUT_MS
}

function getResourceRoot(): string {
  if (app && typeof app === 'object' && 'isPackaged' in app && app.isPackaged) {
    return process.resourcesPath
  }
  return process.cwd()
}

function qpdfCandidatePaths(): string[] {
  const exeName = process.platform === 'win32' ? 'qpdf.exe' : 'qpdf'
  return [
    join(getResourceRoot(), 'vendor', 'qpdf', 'bin', exeName),
    join(getResourceRoot(), 'resources', 'vendor', 'qpdf', 'bin', exeName),
    join(process.cwd(), 'resources', 'vendor', 'qpdf', 'bin', exeName),
  ]
}

function resolveQpdfExecutable(): string {
  for (const candidate of qpdfCandidatePaths()) {
    if (existsSync(candidate)) return candidate
  }
  return 'qpdf'
}

function runQpdf(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(resolveQpdfExecutable(), args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = () => {
      child.kill()
      finish(() => reject(new OcrAbortError()))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error(`qpdf timed out after ${Math.round(timeoutMs / 1000)} seconds`)))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish(() => reject(error))
    })
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) {
        finish(() => resolvePromise({ stdout, stderr }))
      } else {
        finish(() => reject(new Error((stderr || stdout || `qpdf exited with code ${code}`).trim())))
      }
    })
  })
}

async function getQpdfPageCount(filePath: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const result = await runQpdf(['--show-npages', filePath], QPDF_PAGE_COUNT_TIMEOUT_MS, signal)
    const pageCount = Number(String(result.stdout || result.stderr || '').trim())
    return Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : null
  } catch (error) {
    if (isOcrAbortError(error)) throw error
    console.warn('[OCR] qpdf page count failed; falling back to pdf-lib', error)
    return null
  }
}

function isQpdfPdfChunkingEnabled(): boolean {
  return process.env.GUJISMART_OCR_QPDF_CHUNKING !== '0'
}

function toQpdfPageRange(pageIndexes: number[]): string {
  const pageNums = [...new Set(pageIndexes.map((pageIndex) => pageIndex + 1))]
    .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0)
    .sort((left, right) => left - right)
  if (pageNums.length === 0) return ''
  const ranges: string[] = []
  let start = pageNums[0]
  let previous = pageNums[0]
  for (let index = 1; index <= pageNums.length; index += 1) {
    const current = pageNums[index]
    if (current === previous + 1) {
      previous = current
      continue
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`)
    start = current
    previous = current
  }
  return ranges.join(',')
}

async function createQpdfPageSelectionChunk(sourcePath: string, outputPath: string, pageIndexes: number[], timeoutMs = QPDF_CHUNK_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
  const pageRange = toQpdfPageRange(pageIndexes)
  if (!pageRange) throw new Error('qpdf chunk page range is empty')
  await runQpdf([
    '--empty',
    '--pages',
    sourcePath,
    pageRange,
    '--',
    outputPath,
  ], timeoutMs, signal)
}

async function loadPdfDocumentForChunkPlan(filePath: string, signal?: AbortSignal): Promise<{ sourcePdf: PDFDocument; totalPages: number }> {
  throwIfAborted(signal)
  const sourceBytes = await readFile(filePath)
  throwIfAborted(signal)
  const sourcePdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
  return {
    sourcePdf,
    totalPages: sourcePdf.getPageCount(),
  }
}

async function ensurePlanSourcePdfLoaded(plan: PdfChunkPlan, signal?: AbortSignal): Promise<PDFDocument> {
  if (plan.sourcePdf) return plan.sourcePdf
  const loaded = await loadPdfDocumentForChunkPlan(plan.sourcePath, signal)
  plan.sourcePdf = loaded.sourcePdf
  if (plan.totalPages <= 0) {
    plan.totalPages = loaded.totalPages
  }
  return plan.sourcePdf
}

async function createPdfChunkPlan(
  filePath: string,
  targetPageNums?: number[],
  signal?: AbortSignal,
  fallbackPageCount = 0,
  forceChunking = false,
  requireFullFileUpload = false,
  pageRangeChunkSize = 0,
): Promise<PdfChunkPlan> {
  throwIfAborted(signal)
  const stats = await stat(filePath)
  throwIfAborted(signal)
  const fallbackTotalPages = getFallbackPdfPageCount(targetPageNums, fallbackPageCount)
  const hasKnownFallbackPageCount = Number.isFinite(Number(fallbackPageCount))
    && Math.floor(Number(fallbackPageCount)) > 0
  if (
    !forceChunking
    && hasKnownFallbackPageCount
    && canAttemptWholePdfUpload(stats.size, fallbackTotalPages)
    && fallbackTotalPages <= ASYNC_PDF_MAX_PAGES_PER_JOB
  ) {
    const targetPageIndexes = normalizeTargetPageIndexes(fallbackTotalPages, targetPageNums)
    const requestedPageRangeChunkSize = normalizeAsyncPdfPageRangeChunkSize(pageRangeChunkSize, targetPageIndexes.length)
    const directPageRangeChunkSize = requireFullFileUpload
      ? 0
      : requestedPageRangeChunkSize || Math.min(ASYNC_PDF_MAX_PAGES_PER_JOB, targetPageIndexes.length)
    return {
      sourcePdf: null,
      sourcePath: filePath,
      totalPages: fallbackTotalPages,
      targetPageIndexes,
      sourceSize: stats.size,
      estimatedPagesPerChunk: directPageRangeChunkSize || fallbackTotalPages,
      estimatedTotalChunks: targetPageIndexes.length > 0
        ? directPageRangeChunkSize
          ? Math.ceil(targetPageIndexes.length / directPageRangeChunkSize)
          : 1
        : 0,
      tempRoot: null,
      directFilePath: filePath,
      fullFileUpload: true,
      requireFullFileUpload,
      qpdfEnabled: false,
    }
  }
  let sourcePdf: PDFDocument | null = null
  let totalPages = isQpdfPdfChunkingEnabled() ? await getQpdfPageCount(filePath, signal) || 0 : 0
  const qpdfEnabled = totalPages > 0
  const largePdfWithoutQpdf = !qpdfEnabled && shouldAvoidPdfLibChunkPlanFallback(stats.size)
  try {
    if (!qpdfEnabled && !largePdfWithoutQpdf) {
      const loaded = await loadPdfDocumentForChunkPlan(filePath, signal)
      sourcePdf = loaded.sourcePdf
      totalPages = loaded.totalPages
    }
  } catch (error) {
    if (!isPdfStructureError(error)) throw error
    totalPages = getFallbackPdfPageCount(targetPageNums, fallbackPageCount)
    const targetPageIndexes = normalizeTargetPageIndexes(totalPages, targetPageNums)
    const fallbackReason = String((error as Error)?.message || error || 'PDF 结构异常')
    console.warn('[OCR] PDF load failed; falling back to whole PDF upload', error)
    return {
      sourcePdf: null,
      sourcePath: filePath,
      totalPages,
      targetPageIndexes,
      sourceSize: stats.size,
      estimatedPagesPerChunk: Math.max(1, targetPageIndexes.length || totalPages),
      estimatedTotalChunks: 1,
      tempRoot: null,
      directFilePath: filePath,
      wholePdfFallback: true,
      fallbackReason,
      requireFullFileUpload,
      qpdfEnabled,
    }
  }
  if (largePdfWithoutQpdf) {
    if (forceChunking) {
      throw new Error('整本 PDF 上传被服务端拒绝，当前环境无法安全处理 PDF 分片。请稍后重试，或重新导入该 PDF 后再试。')
    }
    totalPages = getFallbackPdfPageCount(targetPageNums, fallbackPageCount)
    const targetPageIndexes = normalizeTargetPageIndexes(totalPages, targetPageNums)
    const fallbackReason = 'qpdf page count unavailable for a large PDF; skipped pdf-lib full-file load to avoid blocking the app'
    console.warn('[OCR] qpdf page count unavailable for a large PDF; falling back to whole PDF upload without pdf-lib preload')
    return {
      sourcePdf: null,
      sourcePath: filePath,
      totalPages,
      targetPageIndexes,
      sourceSize: stats.size,
      estimatedPagesPerChunk: Math.max(1, targetPageIndexes.length || totalPages),
      estimatedTotalChunks: 1,
      tempRoot: null,
      directFilePath: filePath,
      wholePdfFallback: true,
      fallbackReason,
      requireFullFileUpload,
      qpdfEnabled,
    }
  }
  const targetPageIndexes = normalizeTargetPageIndexes(totalPages, targetPageNums)

  if (totalPages <= 0 || targetPageIndexes.length <= 0) {
    return {
      sourcePdf,
      sourcePath: filePath,
      totalPages,
      targetPageIndexes,
      sourceSize: stats.size,
      estimatedPagesPerChunk: 0,
      estimatedTotalChunks: 0,
      tempRoot: null,
      directFilePath: null,
      requireFullFileUpload,
      qpdfEnabled,
    }
  }

  if (
    !forceChunking
    && canAttemptWholePdfUpload(stats.size, totalPages)
    && totalPages <= ASYNC_PDF_MAX_PAGES_PER_JOB
  ) {
    const requestedPageRangeChunkSize = normalizeAsyncPdfPageRangeChunkSize(pageRangeChunkSize, targetPageIndexes.length)
    const directPageRangeChunkSize = requireFullFileUpload
      ? 0
      : requestedPageRangeChunkSize || Math.min(ASYNC_PDF_MAX_PAGES_PER_JOB, targetPageIndexes.length)
    return {
      sourcePdf,
      sourcePath: filePath,
      totalPages,
      targetPageIndexes,
      sourceSize: stats.size,
      estimatedPagesPerChunk: directPageRangeChunkSize || totalPages,
      estimatedTotalChunks: directPageRangeChunkSize
        ? Math.ceil(targetPageIndexes.length / directPageRangeChunkSize)
        : 1,
      tempRoot: null,
      directFilePath: filePath,
      fullFileUpload: true,
      requireFullFileUpload,
      qpdfEnabled,
    }
  }

  if (requireFullFileUpload) {
    throw new Error('古籍竖排 OCR 需要整本 PDF 原文件上传；当前 PDF 必须分片或选择页码上传，已停止以避免单页 PDF 坐标偏移。')
  }

  // Keep OCR session temps under the managed data dir (not Windows %TEMP%).
  // That makes cleanup scoped to the app and avoids open/idle freezes from scanning system TEMP.
  const ocrTempRoot = join(getDataDir(), 'temp', 'ocr')
  mkdirSync(ocrTempRoot, { recursive: true })
  const tempRoot = join(ocrTempRoot, `gujismart-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(tempRoot, { recursive: true })
  const targetChunkSize = getPdfTargetChunkSize(stats.size, totalPages)
  let estimatedPagesPerChunk = Math.max(1, Math.floor((totalPages * targetChunkSize) / Math.max(stats.size, 1)))
  estimatedPagesPerChunk = Math.min(estimatedPagesPerChunk, ASYNC_PDF_MAX_PAGES_PER_JOB)

  return {
    sourcePdf,
    sourcePath: filePath,
    totalPages,
    targetPageIndexes,
    sourceSize: stats.size,
    estimatedPagesPerChunk,
    estimatedTotalChunks: Math.ceil(targetPageIndexes.length / Math.max(1, estimatedPagesPerChunk)),
    tempRoot,
    directFilePath: null,
    qpdfEnabled,
  }
}

async function createPdfChunkFromPlan(plan: PdfChunkPlan, targetCursor: number, chunkIndex: number, signal?: AbortSignal): Promise<PdfChunk | null> {
  throwIfAborted(signal)
  if (plan.totalPages <= 0 || targetCursor >= plan.targetPageIndexes.length) {
    if (plan.wholePdfFallback && targetCursor === 0 && plan.directFilePath) {
      return {
        filePath: plan.directFilePath,
        startPageIndex: 0,
        pageCount: 0,
        sourcePageIndexes: [],
        uploadPageCount: plan.totalPages,
        totalChunks: 1,
        fallbackWholePdf: true,
        fallbackReason: plan.fallbackReason,
        fullFileUpload: true,
      }
    }
    return null
  }

  if (plan.directFilePath) {
    const allPageIndexes = Array.from({ length: plan.totalPages }, (_, index) => index)
    const targetPageIndexes = plan.requireFullFileUpload ? allPageIndexes : plan.targetPageIndexes
    const pagesPerChunk = plan.requireFullFileUpload
      ? targetPageIndexes.length
      : Math.min(
        Math.max(1, plan.estimatedPagesPerChunk || targetPageIndexes.length),
        ASYNC_PDF_MAX_PAGES_PER_JOB,
        targetPageIndexes.length - targetCursor,
      )
    const sourcePageIndexes = plan.requireFullFileUpload
      ? allPageIndexes
      : targetPageIndexes.slice(targetCursor, targetCursor + Math.max(0, pagesPerChunk))
    const isFullPageSelection = sourcePageIndexes.length === allPageIndexes.length
      && sourcePageIndexes.every((pageIndex, index) => pageIndex === index)
    const pageRanges = isFullPageSelection ? undefined : toQpdfPageRange(sourcePageIndexes)
    const resultPageIndexes = pageRanges
      ? sourcePageIndexes
      : plan.fullFileUpload || plan.wholePdfFallback
      ? allPageIndexes
      : undefined
    return {
      filePath: plan.directFilePath,
      startPageIndex: sourcePageIndexes[0] ?? 0,
      pageCount: sourcePageIndexes.length,
      sourcePageIndexes,
      resultPageIndexes,
      pageRanges,
      uploadPageCount: resultPageIndexes ? (pageRanges ? sourcePageIndexes.length : plan.totalPages) : undefined,
      totalChunks: resultPageIndexes ? Math.max(1, plan.estimatedTotalChunks || 1) : undefined,
      fallbackWholePdf: plan.wholePdfFallback,
      fallbackReason: plan.fallbackReason,
      fullFileUpload: Boolean(resultPageIndexes),
    }
  }

  if (!plan.tempRoot) return null

  let pageCount = Math.min(plan.estimatedPagesPerChunk, ASYNC_PDF_MAX_PAGES_PER_JOB, plan.targetPageIndexes.length - targetCursor)
  let sourcePageIndexes: number[] = []

  if (plan.qpdfEnabled) {
    while (pageCount >= 1) {
      throwIfAborted(signal)
      sourcePageIndexes = plan.targetPageIndexes.slice(targetCursor, targetCursor + pageCount)
      const chunkPath = join(plan.tempRoot, `chunk_${String(chunkIndex + 1).padStart(4, '0')}.pdf`)
      try {
        await createQpdfPageSelectionChunk(plan.sourcePath, chunkPath, sourcePageIndexes, getQpdfChunkTimeoutMs(plan), signal)
        const chunkStats = await stat(chunkPath)
        if (chunkStats.size <= ASYNC_PDF_MAX_FILE_SIZE || pageCount === 1) {
          if (chunkStats.size > ASYNC_PDF_MAX_FILE_SIZE) {
            throw new Error('PDF 单页超过 PaddleOCR 本地上传 50MB 限制，无法自动分片提交')
          }
          return {
            filePath: chunkPath,
            startPageIndex: sourcePageIndexes[0] || 0,
            pageCount,
            sourcePageIndexes,
            cleanup: true,
          }
        }
        await rm(chunkPath, { force: true })
        pageCount = Math.max(1, Math.floor(pageCount / 2))
      } catch (error) {
        await rm(chunkPath, { force: true }).catch(() => undefined)
        if (isOcrAbortError(error)) throw error
        if (pageCount > 1) {
          const firstPage = sourcePageIndexes[0] + 1
          const lastPage = sourcePageIndexes[sourcePageIndexes.length - 1] + 1
          console.warn(`[OCR] qpdf chunk failed for pages ${firstPage}-${lastPage}; retrying with a smaller chunk`, error)
          pageCount = Math.max(1, Math.floor(pageCount / 2))
          continue
        }
        if (shouldAvoidPdfLibChunkCopyFallback(plan)) {
          throw new Error(`PDF chunking failed for a large file; skipped pdf-lib full-file load: ${(error as Error)?.message || String(error)}`)
        }
        console.warn('[OCR] qpdf chunking failed; falling back to pdf-lib chunking', error)
        break
      }
    }

    pageCount = Math.min(plan.estimatedPagesPerChunk, ASYNC_PDF_MAX_PAGES_PER_JOB, plan.targetPageIndexes.length - targetCursor)
  }

  const sourcePdf = await ensurePlanSourcePdfLoaded(plan, signal)
  let chunkBytes: Uint8Array | null = null

  while (pageCount >= 1) {
    throwIfAborted(signal)
    try {
      const nextPdf = await PDFDocument.create()
      sourcePageIndexes = plan.targetPageIndexes.slice(targetCursor, targetCursor + pageCount)
      const copiedPages = await nextPdf.copyPages(sourcePdf, sourcePageIndexes)
      copiedPages.forEach((page) => nextPdf.addPage(page))
      chunkBytes = await nextPdf.save()
    } catch (error) {
      if (pageCount > 1) {
        const firstPage = plan.targetPageIndexes[targetCursor] + 1
        const lastPage = plan.targetPageIndexes[Math.min(targetCursor + pageCount - 1, plan.targetPageIndexes.length - 1)] + 1
        console.warn(`[OCR] PDF chunk copy failed for pages ${firstPage}-${lastPage}; retrying with a smaller chunk`, error)
        pageCount = Math.max(1, Math.floor(pageCount / 2))
        continue
      }
      throw new Error(`PDF 第 ${plan.targetPageIndexes[targetCursor] + 1} 页结构异常，无法用 pdf-lib 复制分片：${(error as Error)?.message || String(error)}`)
    }

    if (chunkBytes.byteLength <= ASYNC_PDF_MAX_FILE_SIZE || pageCount === 1) break
    pageCount = Math.max(1, Math.floor(pageCount / 2))
  }

  if (!chunkBytes) return null
  if (chunkBytes.byteLength > ASYNC_PDF_MAX_FILE_SIZE) {
    throw new Error('PDF 单页超过 PaddleOCR 本地上传 50MB 限制，无法自动分片提交')
  }

  const chunkPath = join(plan.tempRoot, `chunk_${String(chunkIndex + 1).padStart(4, '0')}.pdf`)
  throwIfAborted(signal)
  await writeFile(chunkPath, Buffer.from(chunkBytes))
  return {
    filePath: chunkPath,
    startPageIndex: sourcePageIndexes[0] || 0,
    pageCount,
    sourcePageIndexes,
    cleanup: true,
  }
}

function createWholePdfFallbackChunk(plan: PdfChunkPlan, filePath: string, targetCursor: number, chunkIndex: number, error: unknown): PdfChunk | null {
  const sourcePageIndexes = plan.targetPageIndexes.slice(targetCursor)
  if (sourcePageIndexes.length <= 0) return null

  if (plan.totalPages > ASYNC_PDF_MAX_PAGES_PER_JOB) {
    throw new Error(`PDF has ${plan.totalPages} pages and cannot be uploaded as one PaddleOCR job after chunking failed: ${(error as Error)?.message || String(error)}`)
  }

  const fallbackReason = String((error as Error)?.message || error || 'PDF 分片失败')
  console.warn('[OCR] PDF chunking failed; falling back to whole PDF upload', error)
  return {
    filePath,
    startPageIndex: sourcePageIndexes[0] ?? 0,
    pageCount: sourcePageIndexes.length,
    sourcePageIndexes,
    resultPageIndexes: Array.from({ length: plan.totalPages }, (_, index) => index),
    uploadPageCount: plan.totalPages,
    totalChunks: chunkIndex + 1,
    fallbackWholePdf: true,
    fallbackReason,
    fullFileUpload: true,
  }
}

function createPageRangeRetryPlanFromWholePdf(plan: PdfChunkPlan): PdfChunkPlan | null {
  if (!plan.directFilePath || plan.requireFullFileUpload || plan.targetPageIndexes.length <= 0) return null
  const pagesPerChunk = Math.max(
    1,
    Math.min(
      ASYNC_PDF_MAX_PAGES_PER_JOB,
      ASYNC_PDF_STALLED_PAGE_RANGE_CHUNK_SIZE,
      plan.targetPageIndexes.length,
    ),
  )
  return {
    ...plan,
    sourcePdf: null,
    sourcePath: plan.sourcePath,
    estimatedPagesPerChunk: pagesPerChunk,
    estimatedTotalChunks: Math.ceil(plan.targetPageIndexes.length / pagesPerChunk),
    directFilePath: plan.directFilePath,
    wholePdfFallback: false,
    fallbackReason: undefined,
    fullFileUpload: true,
    requireFullFileUpload: false,
  }
}

async function cleanupPdfChunk(chunk: PdfChunk): Promise<void> {
  if (!chunk.cleanup) return
  try {
    await rm(chunk.filePath, { force: true })
  } catch (error) {
    console.warn('[OCR] Failed to cleanup PDF chunk file', error)
  }
}

async function cleanupPdfChunkPlan(plan: PdfChunkPlan): Promise<void> {
  if (!plan.tempRoot) return
  try {
    await rm(plan.tempRoot, { recursive: true, force: true })
  } catch (error) {
    console.warn('[OCR] Failed to cleanup PDF chunk directory', error)
  }
}

async function createPdfUploadBlob(filePath: string): Promise<Blob> {
  if (typeof openAsBlob === 'function') {
    return openAsBlob(filePath, { type: 'application/pdf' })
  }

  const stats = await stat(filePath)
  if (stats.size > ASYNC_PDF_MAX_FILE_SIZE) {
    throw new Error('当前运行环境不支持低内存 PDF 文件上传，且 PDF 超过 50MB；请升级 Electron/Node 后重试，或安装 qpdf 让软件先分片。')
  }
  const fileBuffer = await readFile(filePath)
  return new Blob([fileBuffer], { type: 'application/pdf' })
}

function getSafeOcrUploadFilename(filePath: string): string {
  const rawBase = basename(filePath || 'document.pdf')
  const rawExt = extname(rawBase).toLowerCase()
  const extension = rawExt === '.pdf' ? '.pdf' : '.pdf'
  const rawStem = rawExt ? rawBase.slice(0, -rawExt.length) : rawBase
  const safeStem = rawStem
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.\-\s]+|[_.\-\s]+$/g, '')
    .slice(0, 80)
  return `${safeStem || 'gujismart-document'}${extension}`
}

async function submitAsyncPdfJob(
  filePath: string,
  model: AsyncOcrModel,
  signal?: AbortSignal,
  onQueueBusy?: (payload: { attempt: number; waitMs: number; errorMessage: string }) => void,
  submitOptions: AsyncPdfSubmitOptions = {},
  excludedTokenIds: Set<string> = new Set(),
): Promise<AsyncPdfJobSubmission> {
  return asyncSubmitLimit(async () => {
    let attempt = 0
    let lastError: Error | null = null
    throwIfAborted(signal)
    const fileBlob = await createPdfUploadBlob(filePath)
    let maxAttempts = MAX_RETRY_ATTEMPTS
    let lease = acquirePaddleOcrToken(excludedTokenIds)

    while (attempt < maxAttempts) {
      throwIfAborted(signal)
      try {
        const formData = new FormData()
        formData.append('model', model)
        if (submitOptions.pageRanges) {
          formData.append('pageRanges', submitOptions.pageRanges)
        }
        if (submitOptions.optionalPayload) {
          formData.append('optionalPayload', JSON.stringify(submitOptions.optionalPayload))
        }
        formData.append('file', fileBlob, getSafeOcrUploadFilename(filePath))

        const response = await fetchWithTimeout(ASYNC_OCR_ENDPOINT, {
          method: 'POST',
          headers: getAsyncAuthHeaders(lease.token),
          body: formData,
          signal,
        }, getOcrUploadTimeoutMs(), 'PDF 上传超时，请在设置中调大“上传超时”，或稍后重试。')

        const payload = await response.json().catch(() => ({}))
        const apiErrorDetail = getApiErrorMessage(payload, '')
        const apiErrorCode = getApiErrorCode(payload)
        if (!response.ok) {
          const error = new Error(`Async OCR submit failed, status ${response.status}${apiErrorDetail ? `: ${apiErrorDetail}` : ''}`) as Error & { status?: number; code?: number | string }
          error.status = response.status
          if (apiErrorCode !== undefined) error.code = apiErrorCode
          throw error
        }

        if (apiErrorCode !== undefined) {
          const error = new Error(`Async OCR submit failed: ${getApiErrorMessage(payload)}`) as Error & { code?: number | string }
          error.code = apiErrorCode
          throw error
        }
        const jobId = payload?.data?.jobId || payload?.result?.jobId || payload?.jobId
        if (!jobId) {
          throw new Error('异步 OCR 提交失败：未返回 jobId')
        }
        return { jobId: jobId as string, lease }
      } catch (error) {
        if (isOcrAbortError(error)) throw error
        const failure = error as Error & { status?: number; code?: number | string }
        lastError = failure
        if (isPaddleOcrTokenFailure(failure)) {
          markPaddleOcrTokenFailure(lease, failure)
          excludedTokenIds.add(lease.id)
          lease = acquirePaddleOcrToken(excludedTokenIds)
          continue
        }
        attempt += 1
        const queueBusy = isAsyncOcrQueueBusyError(failure)
        if (queueBusy) {
          maxAttempts = Math.max(maxAttempts, ASYNC_OCR_QUEUE_BUSY_RETRY_ATTEMPTS)
        }
        if (attempt >= maxAttempts || !isRetryableNetworkFailure(failure)) {
          break
        }
        const waitMs = queueBusy
          ? Math.min(60000, 15000 * attempt)
          : String(failure.code || '') === '10010'
          ? Math.min(60000, 5000 * 2 ** (attempt - 1))
          : Math.min(20000, 1200 * 2 ** (attempt - 1))
        if (queueBusy) {
          onQueueBusy?.({ attempt, waitMs, errorMessage: failure.message || 'PaddleOCR submission queue is full' })
        }
        await sleep(waitMs, signal)
      }
    }

    throw lastError || new Error('异步 OCR 提交失败')
  })
}

async function queryAsyncPdfJob(jobId: string, lease: PaddleOcrTokenLease, signal?: AbortSignal): Promise<AsyncJobStatusPayload> {
  return asyncPollLimit(async () => {
    throwIfAborted(signal)
    const response = await fetchWithTimeout(`${ASYNC_OCR_ENDPOINT}/${jobId}`, {
      method: 'GET',
      headers: getAsyncAuthHeaders(lease.token),
      signal,
    }, ASYNC_STATUS_QUERY_TIMEOUT_MS, 'PDF OCR 状态查询超时，正在重新查询服务端处理进度。')

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = getApiErrorMessage(payload, '')
      const error = new Error(`异步 OCR 查询失败，状态码 ${response.status}${detail ? `：${detail}` : ''}`) as Error & { status?: number; code?: number | string }
      error.status = response.status
      const code = getApiErrorCode(payload)
      if (code !== undefined) error.code = code
      throw error
    }

    if (payload?.error_code && payload.error_code !== 0) {
      const error = new Error(`异步 OCR 查询失败：${payload.error_msg || '未知错误'}`) as Error & { code?: number | string }
      error.code = payload.error_code
      throw error
    }

    return (payload?.data || payload?.result || payload) as AsyncJobStatusPayload
  })
}

async function waitForAsyncPdfResult(jobId: string, lease: PaddleOcrTokenLease, onProgress?: (payload: AsyncJobStatusPayload) => void, signal?: AbortSignal): Promise<string> {
  let allPagesCompletedAt = 0
  let lastProgressAt = Date.now()
  let lastProgressSignature = ''
  let pollCount = 0
  while (true) {
    throwIfAborted(signal)
    pollCount += 1
    let statusPayload: AsyncJobStatusPayload
    try {
      statusPayload = await queryAsyncPdfJob(jobId, lease, signal)
    } catch (error) {
      if (isOcrAbortError(error)) throw error
      const failure = error as Error & { status?: number; code?: number | string }
      if (isPaddleOcrTokenFailure(failure)) throw failure
      if (!isRetryableNetworkFailure(failure)) throw failure
      const waitingMs = Date.now() - lastProgressAt
      if (waitingMs > ASYNC_JOB_STALLED_TIMEOUT_MS) {
        throw new Error(`${ASYNC_JOB_STALLED_PREFIX} PaddleOCR 状态查询长时间没有进展：${failure.message || '服务端未返回处理状态'}。软件会自动改用原 PDF 分段补跑未完成页。`)
      }
      onProgress?.({
        status: 'queued',
        state: 'queued',
        retryingStatusQuery: true,
        statusQueryError: failure.message,
        pollCount,
        waitingMs,
      })
      await sleep(getAsyncPollDelayMs({
        pollCount,
        changed: false,
        completedPages: 0,
        totalPages: 0,
        allPagesCompleted: false,
      }), signal)
      continue
    }

    const state = String(statusPayload.status || statusPayload.state || '').toLowerCase()
    const jsonUrl = getJsonUrl(statusPayload)
    const completedPages = getCompletedPages(statusPayload)
    const totalPages = getTotalPages(statusPayload)
    const allPagesCompleted = totalPages > 0 && completedPages >= totalPages
    const progressSignature = [
      state,
      jsonUrl,
      completedPages,
      totalPages,
      statusPayload.progress ?? '',
      statusPayload.extractProgress?.extractedPages ?? '',
      statusPayload.extractProgress?.totalPages ?? '',
    ].join('|')
    const progressChanged = progressSignature !== lastProgressSignature
    if (progressChanged) {
      lastProgressSignature = progressSignature
      lastProgressAt = Date.now()
    } else if (Date.now() - lastProgressAt > (completedPages > 0 ? ASYNC_JOB_STALLED_AFTER_PROGRESS_TIMEOUT_MS : ASYNC_JOB_STALLED_TIMEOUT_MS)) {
      throw new Error(`${ASYNC_JOB_STALLED_PREFIX} PaddleOCR 异步任务长时间没有进展，已停在 ${completedPages}/${totalPages || '?'} 页。软件会自动改用原 PDF 分段补跑未完成页。`)
    }
    if (allPagesCompleted && !jsonUrl) {
      statusPayload.awaitingResultFile = true
    }
    statusPayload.pollCount = pollCount
    statusPayload.waitingMs = Date.now() - lastProgressAt
    onProgress?.(statusPayload)
    if (state === 'success' || state === 'completed' || state === 'succeeded' || state === 'done') {
      if (!jsonUrl) {
        throw new Error(`${ASYNC_RESULT_FILE_NOT_READY_PREFIX} 异步 OCR 已完成，但未返回结果地址`)
      }
      return jsonUrl
    }

    if (allPagesCompleted && jsonUrl) {
      return jsonUrl
    }

    if (allPagesCompleted) {
      allPagesCompletedAt = allPagesCompletedAt || Date.now()
      if (Date.now() - allPagesCompletedAt > ASYNC_RESULT_READY_GRACE_MS) {
        throw new Error(`${ASYNC_RESULT_FILE_NOT_READY_PREFIX} PaddleOCR 已显示全部页面处理完成，但结果文件长时间未生成。请稍后点击“继续 OCR”重试，已保存的页面会自动跳过。`)
      }
    } else {
      allPagesCompletedAt = 0
    }

    if (state === 'failed' || state === 'error') {
      const error = new Error(statusPayload.errorMsg || statusPayload.errorMessage || 'PaddleOCR 异步任务失败，但接口没有返回失败原因。请稍后重试，或在设置中切换 OCR 模型后再试。') as Error & { code?: number | string }
      const code = getApiErrorCode(statusPayload)
      if (code !== undefined) error.code = code
      throw error
    }

    await sleep(getAsyncPollDelayMs({
      pollCount,
      changed: progressChanged,
      completedPages,
      totalPages,
      allPagesCompleted,
    }), signal)
  }
}

function collectAsyncPagePayloads(payload: unknown, model?: AsyncOcrModel): unknown[] {
  const result = firstRecordValue(payload, ['result', 'data']) || payload
  const pagePayloads: unknown[] = []

  if (((model && model.startsWith('PaddleOCR-VL-')) || model === 'PP-StructureV3') && Array.isArray(readRecordValue(result, 'layoutParsingResults'))) {
    pagePayloads.push(...asUnknownArray(readRecordValue(result, 'layoutParsingResults')))
  } else if (Array.isArray(readRecordValue(result, 'layoutParsingResults'))) {
    pagePayloads.push(...asUnknownArray(readRecordValue(result, 'layoutParsingResults')))
  } else if (Array.isArray(readRecordValue(result, 'ocrResults'))) {
    pagePayloads.push(...asUnknownArray(readRecordValue(result, 'ocrResults')))
  } else if (Array.isArray(readRecordValue(result, 'pages'))) {
    pagePayloads.push(...asUnknownArray(readRecordValue(result, 'pages')))
  } else if (Array.isArray(result)) {
    for (const item of result) {
      pagePayloads.push(...collectAsyncPagePayloads(item, model))
    }
  } else if (
    isJsonRecord(result)
    && (result.markdown || result.prunedResult || result.rec_texts || result.boxes)
  ) {
    pagePayloads.push(result)
  }

  return pagePayloads
}

function parseAsyncPdfResultPayloadText(content: string, model: AsyncOcrModel): unknown[] {
  const pagePayloads: unknown[] = []
  const trimmedContent = content.trim()
  if (!trimmedContent) return pagePayloads

  if (trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) {
    try {
      pagePayloads.push(...collectAsyncPagePayloads(JSON.parse(trimmedContent), model))
      if (pagePayloads.length > 0) return pagePayloads
    } catch {
      // Fall through to JSONL parsing.
    }
  }

  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    try {
      pagePayloads.push(...collectAsyncPagePayloads(JSON.parse(trimmed), model))
    } catch (error) {
      console.warn('[OCR] Failed to parse async result line', error)
    }
  }
  return pagePayloads
}

function collectAsyncPdfJsonLine(line: string, model: AsyncOcrModel, pagePayloads: unknown[], warnOnError: boolean): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  try {
    pagePayloads.push(...collectAsyncPagePayloads(JSON.parse(trimmed), model))
    return true
  } catch (error) {
    if (warnOnError) console.warn('[OCR] Failed to parse async result line', error)
    return false
  }
}

function looksLikeWholeJsonFallback(value: string): boolean {
  const trimmed = value.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function getAsyncResultDownloadTimeoutError(): Error {
  return new Error(`${ASYNC_RESULT_FILE_NOT_READY_PREFIX} 异步 OCR 结果下载长时间没有返回数据。请稍后点击“继续 OCR”重试，已保存的页面会自动跳过。`)
}

function readAsyncResultChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      void reader.cancel().catch(() => undefined)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(getAsyncResultDownloadTimeoutError())
    }, ASYNC_RESULT_DOWNLOAD_IDLE_TIMEOUT_MS)
    const onAbort = () => {
      fail(new OcrAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    reader.read()
      .then((chunk) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(chunk)
      })
      .catch((error) => {
        fail(error instanceof Error ? error : new Error(String(error || '异步 OCR 结果下载失败')))
      })
  })
}

async function fetchAsyncPdfJsonLines(jsonUrl: string, model: AsyncOcrModel, signal?: AbortSignal): Promise<unknown[]> {
  throwIfAborted(signal)
  const response = await fetchWithTimeout(jsonUrl, { signal }, ASYNC_RESULT_DOWNLOAD_IDLE_TIMEOUT_MS, `${ASYNC_RESULT_FILE_NOT_READY_PREFIX} 异步 OCR 结果下载超时，请稍后重试。`)
  if (!response.ok) {
    throw new Error(`${ASYNC_RESULT_FILE_NOT_READY_PREFIX} 异步 OCR 结果下载失败，状态码 ${response.status}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    return parseAsyncPdfResultPayloadText(await response.text(), model)
  }

  const pagePayloads: unknown[] = []
  const decoder = new TextDecoder()
  let buffer = ''
  let fallbackContent = ''
  let parsedJsonLine = false
  let processedLineCount = 0

  while (true) {
    throwIfAborted(signal)
    const { value, done } = await readAsyncResultChunkWithTimeout(reader, signal)
    const chunk = value ? decoder.decode(value, { stream: !done }) : ''
    if (chunk) {
      buffer += chunk
      if (!parsedJsonLine) fallbackContent += chunk
    }

    let newlineIndex = buffer.search(/\r?\n/)
    while (newlineIndex >= 0) {
      const newlineLength = buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + newlineLength)
      const warnOnLineError = parsedJsonLine || !looksLikeWholeJsonFallback(fallbackContent)
      if (collectAsyncPdfJsonLine(line, model, pagePayloads, warnOnLineError)) {
        parsedJsonLine = true
        fallbackContent = ''
      }
      processedLineCount += 1
      if (processedLineCount % ASYNC_RESULT_PARSE_YIELD_LINE_INTERVAL === 0) {
        throwIfAborted(signal)
        await yieldToEventLoop()
      }
      newlineIndex = buffer.search(/\r?\n/)
    }

    if (done) break
  }

  const tail = `${buffer}${decoder.decode()}`
  if (tail.trim() && collectAsyncPdfJsonLine(tail, model, pagePayloads, false)) {
    parsedJsonLine = true
    fallbackContent = ''
  }

  if (!parsedJsonLine && fallbackContent.trim()) {
    return parseAsyncPdfResultPayloadText(fallbackContent, model)
  }

  return pagePayloads
}

function getChunkCompletedPages(chunk: PdfChunk, payload: AsyncJobStatusPayload): number {
  const reportedCompletedPages = getCompletedPages(payload)
  if (!chunk.uploadPageCount || chunk.uploadPageCount <= chunk.pageCount) {
    return Math.min(reportedCompletedPages, chunk.pageCount)
  }

  const uploadPageCount = Math.max(1, chunk.uploadPageCount || chunk.pageCount)
  const uploadRatio = Math.min(1, Math.max(0, reportedCompletedPages / uploadPageCount))
  return Math.min(chunk.pageCount, Math.floor(uploadRatio * chunk.pageCount))
}

async function normalizeAsyncPdfChunkResults(pagePayloads: unknown[], chunk: PdfChunk, signal?: AbortSignal): Promise<Array<OcrResultPayload | null>> {
  const normalizedPageResults: Array<OcrResultPayload | null> = []
  for (let index = 0; index < pagePayloads.length; index += ASYNC_RESULT_NORMALIZE_CHUNK_SIZE) {
    throwIfAborted(signal)
    const slice = pagePayloads.slice(index, index + ASYNC_RESULT_NORMALIZE_CHUNK_SIZE)
    slice.forEach((payload) => {
      normalizedPageResults.push(normalizePageResult(payload))
    })
    if (index + ASYNC_RESULT_NORMALIZE_CHUNK_SIZE < pagePayloads.length) {
      await yieldToEventLoop()
    }
  }

  if (chunk.fallbackWholePdf && chunk.sourcePageIndexes.length === 0) {
    return normalizedPageResults
  }
  // Some Paddle deployments ignore pageRanges and return the whole uploaded
  // PDF. Detect that wider result instead of assigning its first pages to the
  // requested sparse page indexes.
  const resultPageIndexes = chunk.fullFileUpload && normalizedPageResults.length > chunk.sourcePageIndexes.length
    ? normalizedPageResults.map((_, index) => index)
    : chunk.resultPageIndexes || chunk.sourcePageIndexes
  const resultsByPageIndex = new Map<number, OcrResultPayload>()
  resultPageIndexes.forEach((pageIndex, index) => {
    const result = normalizedPageResults[index]
    if (result) resultsByPageIndex.set(pageIndex, result)
  })

  return chunk.sourcePageIndexes.map((sourcePageIndex) => resultsByPageIndex.get(sourcePageIndex) || null)
}

export async function recognizePdfAsync(filePath: string, onProgress?: (payload: AsyncJobStatusPayload) => void, options?: RecognizePdfAsyncOptions): Promise<Array<OcrResultPayload | null>> {
  const model = normalizeAsyncOcrModel(options?.model || getAsyncOcrModel())
  const signal = options?.signal
  const optionalPayload = getAsyncPdfOptionalPayload(options?.ocrOptions, model)
  throwIfAborted(signal)
  let plan = await createPdfChunkPlan(
    filePath,
    options?.targetPageNums,
    signal,
    options?.fallbackPageCount,
    false,
    Boolean(options?.requireFullFileUpload),
    options?.pageRangeChunkSize,
  )
  let retriedWholePdfUploadWithChunks = false

  while (true) {
  const totalPages = plan.totalPages
  const collectChunkResults = options?.collectChunkResults !== false
  const chunkResults: Array<Array<OcrResultPayload | null>> = []
  const completedByChunk: number[] = []
  let nextChunkIndex = 0
  let nextTargetCursor = 0
  let chunkCreationQueue = Promise.resolve()
  let chunkCompleteQueue = Promise.resolve()

  const getCompletedPagesAcrossChunks = () => completedByChunk.reduce((sum, value) => sum + value, 0)

  const runChunkCompleteCallbackSerially = async (payload: AsyncPdfChunkResult): Promise<void> => {
    if (!options?.onChunkComplete) return
    const next = chunkCompleteQueue.then(async () => {
      throwIfAborted(signal)
      await options.onChunkComplete?.(payload)
    })
    chunkCompleteQueue = next.then(() => undefined, () => undefined)
    return next
  }

  const getNextChunk = async (): Promise<{ chunk: PdfChunk; chunkIndex: number } | null> => {
    const next = chunkCreationQueue.then(async () => {
      throwIfAborted(signal)
      if (nextTargetCursor >= plan.targetPageIndexes.length && !(plan.wholePdfFallback && nextTargetCursor === 0 && plan.directFilePath)) {
        return null
      }
      const chunkIndex = nextChunkIndex
      nextChunkIndex += 1
      let chunk: PdfChunk | null = null
      try {
        if (!plan.directFilePath) {
          const plannedPageCount = Math.min(
            plan.estimatedPagesPerChunk,
            ASYNC_PDF_MAX_PAGES_PER_JOB,
            plan.targetPageIndexes.length - nextTargetCursor,
          )
          const plannedSourcePageIndexes = plan.targetPageIndexes.slice(nextTargetCursor, nextTargetCursor + Math.max(0, plannedPageCount))
          if (plannedSourcePageIndexes.length > 0) {
            onProgress?.({
              status: 'preparing',
              chunkIndex: chunkIndex + 1,
              totalChunks: Math.max(plan.estimatedTotalChunks, chunkIndex + 1),
              chunkStartPage: plannedSourcePageIndexes[0] + 1,
              chunkEndPage: plannedSourcePageIndexes[plannedSourcePageIndexes.length - 1] + 1,
              completedPages: Math.min(getCompletedPagesAcrossChunks(), totalPages),
              totalPages,
              progress: getCompletedPagesAcrossChunks() / Math.max(1, totalPages),
            })
          }
        }
        chunk = await createPdfChunkFromPlan(plan, nextTargetCursor, chunkIndex, signal)
      } catch (error) {
        if (!isPdfStructureError(error)) throw error
        chunk = createWholePdfFallbackChunk(plan, filePath, nextTargetCursor, chunkIndex, error)
        nextTargetCursor = plan.targetPageIndexes.length
      }
      if (!chunk) return null
      nextTargetCursor = chunk.pageCount > 0
        ? nextTargetCursor + chunk.pageCount
        : plan.targetPageIndexes.length + 1
      return { chunk, chunkIndex }
    })
    chunkCreationQueue = next.then(() => undefined, () => undefined)
    return next
  }

  const processChunk = async (chunk: PdfChunk, chunkIndex: number): Promise<void> => {
    completedByChunk[chunkIndex] = 0

    try {
      throwIfAborted(signal)
      const totalChunks = chunk.totalChunks || Math.max(plan.estimatedTotalChunks, chunkIndex + 1)
      const chunkStartPage = (chunk.sourcePageIndexes[0] ?? chunk.startPageIndex) + 1
      const chunkEndPage = (chunk.sourcePageIndexes[chunk.sourcePageIndexes.length - 1] ?? (chunk.startPageIndex + chunk.pageCount - 1)) + 1
      onProgress?.({
        status: 'preparing',
        chunkIndex: chunkIndex + 1,
        totalChunks,
        chunkStartPage,
        chunkEndPage,
        completedPages: Math.min(getCompletedPagesAcrossChunks(), totalPages),
        totalPages,
        fallbackWholePdf: chunk.fallbackWholePdf,
        fallbackReason: chunk.fallbackReason,
        fullFileUpload: chunk.fullFileUpload,
        uploadPageCount: chunk.uploadPageCount,
        progress: getCompletedPagesAcrossChunks() / Math.max(1, totalPages)
      })

      onProgress?.({
        status: 'uploading',
        state: 'uploading',
        chunkIndex: chunkIndex + 1,
        totalChunks,
        chunkStartPage,
        chunkEndPage,
        completedPages: Math.min(getCompletedPagesAcrossChunks(), totalPages),
        totalPages,
        fallbackWholePdf: chunk.fallbackWholePdf,
        fallbackReason: chunk.fallbackReason,
        fullFileUpload: chunk.fullFileUpload,
        uploadPageCount: chunk.uploadPageCount,
        progress: getCompletedPagesAcrossChunks() / Math.max(1, totalPages),
      })
      const excludedTokenIds = new Set<string>()
      let jsonUrl = ''
      while (!jsonUrl) {
        const submission = await submitAsyncPdfJob(chunk.filePath, model, signal, (queuePayload) => {
          onProgress?.({
            status: 'queued',
            state: 'queued',
            errorMessage: queuePayload.errorMessage,
            chunkIndex: chunkIndex + 1,
            totalChunks,
            chunkStartPage,
            chunkEndPage,
            completedPages: Math.min(getCompletedPagesAcrossChunks(), totalPages),
            totalPages,
            fallbackWholePdf: chunk.fallbackWholePdf,
            fallbackReason: chunk.fallbackReason,
            fullFileUpload: chunk.fullFileUpload,
            uploadPageCount: chunk.uploadPageCount,
            progress: getCompletedPagesAcrossChunks() / Math.max(1, totalPages),
          })
        }, { pageRanges: chunk.pageRanges, optionalPayload }, excludedTokenIds)
        try {
          jsonUrl = await waitForAsyncPdfResult(submission.jobId, submission.lease, (payload) => {
            const chunkCompleted = getChunkCompletedPages(chunk, payload)
            const chunkTotal = getTotalPages(payload, chunk.uploadPageCount || chunk.pageCount)
            completedByChunk[chunkIndex] = Math.max(completedByChunk[chunkIndex] || 0, chunkCompleted)
            const completedPages = Math.min(getCompletedPagesAcrossChunks(), totalPages)
            onProgress?.({
              ...payload,
              chunkIndex: chunkIndex + 1,
              totalChunks,
              chunkStartPage,
              chunkEndPage,
              completedPages,
              totalPages,
              fallbackWholePdf: chunk.fallbackWholePdf,
              fallbackReason: chunk.fallbackReason,
              fullFileUpload: chunk.fullFileUpload,
              uploadPageCount: chunk.uploadPageCount,
              progress: chunkTotal > 0 ? completedPages / Math.max(1, totalPages) : payload.progress,
            })
          }, signal)
        } catch (error) {
          if (!isPaddleOcrTokenFailure(error)) throw error
          markPaddleOcrTokenFailure(submission.lease, error)
          excludedTokenIds.add(submission.lease.id)
          completedByChunk[chunkIndex] = 0
          onProgress?.({
            status: 'queued',
            state: 'queued',
            errorMessage: `${submission.lease.label} 额度已用完或 Token 无效，正在切换下一个 Token，只重试第 ${chunkStartPage}-${chunkEndPage} 页。`,
            chunkIndex: chunkIndex + 1,
            totalChunks,
            chunkStartPage,
            chunkEndPage,
            completedPages: Math.min(getCompletedPagesAcrossChunks(), totalPages),
            totalPages,
            progress: getCompletedPagesAcrossChunks() / Math.max(1, totalPages),
          })
        }
      }
      throwIfAborted(signal)
      const pagePayloads = await fetchAsyncPdfJsonLines(jsonUrl, model, signal)
      const normalizedChunkResults = await normalizeAsyncPdfChunkResults(pagePayloads, chunk, signal)
      const sourcePageIndexes = chunk.sourcePageIndexes.length > 0
        ? chunk.sourcePageIndexes
        : normalizedChunkResults.map((_, index) => index)
      const chunkPageCount = sourcePageIndexes.length
      const callbackTotalPages = totalPages || Math.max(chunk.uploadPageCount || 0, chunkPageCount)
      if (collectChunkResults) {
        chunkResults[chunkIndex] = normalizedChunkResults
      }
      completedByChunk[chunkIndex] = chunkPageCount || chunk.pageCount
      throwIfAborted(signal)
      await runChunkCompleteCallbackSerially({
        startPageIndex: sourcePageIndexes[0] ?? chunk.startPageIndex,
        pageCount: chunkPageCount || chunk.pageCount,
        sourcePageIndexes,
        chunkIndex: chunkIndex + 1,
        totalChunks,
        totalPages: callbackTotalPages,
        results: normalizedChunkResults,
      })
    } finally {
      await cleanupPdfChunk(chunk)
    }
  }

  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(signal)
      const next = await getNextChunk()
      if (!next) return
      await processChunk(next.chunk, next.chunkIndex)
    }
  }

  let retryPlan: PdfChunkPlan | null = null
  try {
    const workerCount = getAsyncPdfWorkerCount(plan)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } catch (error) {
    if (!retriedWholePdfUploadWithChunks && shouldRetryWholePdfUploadWithChunking(error, plan)) {
      retriedWholePdfUploadWithChunks = true
      const stalledWholePdfJob = isAsyncJobStalledError(error)
      onProgress?.({
        status: 'preparing',
        state: 'preparing',
        completedPages: Math.min(getCompletedPagesAcrossChunks(), totalPages),
        totalPages,
        progress: getCompletedPagesAcrossChunks() / Math.max(1, totalPages),
        fallbackReason: stalledWholePdfJob
          ? '整本 PDF 处理进度停住，正在改用原 PDF 分段提交'
          : '整本 PDF 上传失败，正在重新提交 PDF',
      })
      retryPlan = stalledWholePdfJob
        ? createPageRangeRetryPlanFromWholePdf(plan)
        : null
      retryPlan = retryPlan || await createPdfChunkPlan(
          filePath,
          options?.targetPageNums,
          signal,
          options?.fallbackPageCount,
          true,
          Boolean(options?.requireFullFileUpload),
          options?.pageRangeChunkSize,
        )
    } else {
      throw error
    }
  } finally {
    await cleanupPdfChunkPlan(plan)
  }

  if (retryPlan) {
    plan = retryPlan
    continue
  }

  return collectChunkResults ? chunkResults.flat() : []
  }
}

export async function recognizeTraditional(base64Image: string, options: OcrRuntimeOptions = {}): Promise<OcrResultPayload> {
  return recognizeImage(base64Image, { preferVertical: true, signal: options.signal })
}
