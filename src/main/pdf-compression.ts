import { app } from 'electron'
import { createHash } from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'fs'
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, resolve } from 'path'
import { PDFDocument } from 'pdf-lib'
import { getDataDir, queryOne, run, scheduleDatabaseSave } from './database'
import { getPdfJsNodeDocumentOptions } from './pdfjs-assets'
import { applyCjkTextRenderFallback } from '../shared/pdf-text-render-fallback'
import type { DocumentMetadataResult, PdfCompressionSummary } from '../shared/types'

export const PDF_COMPRESSION_ENABLED_KEY = 'pdf_compression_enabled'
export const PDF_COMPRESSION_MIN_SIZE_MB_KEY = 'pdf_compression_min_size_mb'
export const PDF_COMPRESSION_QUALITY_KEY = 'pdf_compression_quality'

const DEFAULT_PDF_COMPRESSION_MIN_SIZE_MB = 10
const DEFAULT_PDF_COMPRESSION_QUALITY = 80
const DEFAULT_PDF_RASTER_MAX_IMAGE_SIDE = 2200
const DEFAULT_PDF_COMPRESSION_ENABLED = false
const MIN_PDF_COMPRESSION_QUALITY = 50
const MAX_PDF_COMPRESSION_QUALITY = 95
const MIN_PDF_RASTER_MAX_IMAGE_SIDE = 800
const MAX_PDF_RASTER_MAX_IMAGE_SIDE = 4096
const QPDF_TIMEOUT_MS = 20 * 1000
const QPDF_CHECK_TIMEOUT_MS = 10 * 1000
const HASH_CHUNK_BYTES = 4 * 1024 * 1024

type JsonRecord = Record<string, unknown>
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
  version?: string
}
type CanvasLike = {
  getContext: (context: '2d') => Record<string, unknown>
  toBuffer: (mime: 'image/jpeg', quality?: number) => Buffer
}
type CanvasModule = {
  createCanvas: (width: number, height: number) => CanvasLike
}
type CompressionToolResult = { tool: string; toolVersion?: string }

export interface PdfFileFingerprint {
  sha256: string
  sizeBytes: number
  mtimeMs: number
}

export interface PdfCompressionSettings {
  enabled: boolean
  minSizeMb: number
  minSizeBytes: number
  quality: number
  maxImageSide: number
}

export interface StorePdfResult {
  storedPath: string
  storedFingerprint: PdfFileFingerprint
  compression: PdfCompressionSummary
}

interface StorePdfOptions {
  destFileName?: string
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMetadata(value: unknown): JsonRecord {
  if (isJsonRecord(value)) return value
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return isJsonRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getSettingValue(key: string, fallback = ''): string {
  return String(queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [key])?.value || fallback)
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

export function getPdfCompressionSettings(): PdfCompressionSettings {
  const enabled = getSettingValue(PDF_COMPRESSION_ENABLED_KEY, DEFAULT_PDF_COMPRESSION_ENABLED ? 'true' : 'false') === 'true'
  const minSizeMb = clampNumber(
    getSettingValue(PDF_COMPRESSION_MIN_SIZE_MB_KEY, String(DEFAULT_PDF_COMPRESSION_MIN_SIZE_MB)),
    DEFAULT_PDF_COMPRESSION_MIN_SIZE_MB,
    1,
    1024,
  )
  const seededQuality = getSettingValue(PDF_COMPRESSION_QUALITY_KEY, getSettingValue('ocr_jpeg_quality', String(DEFAULT_PDF_COMPRESSION_QUALITY)))
  const quality = clampNumber(seededQuality, DEFAULT_PDF_COMPRESSION_QUALITY, MIN_PDF_COMPRESSION_QUALITY, MAX_PDF_COMPRESSION_QUALITY)
  const maxImageSide = clampNumber(
    getSettingValue('ocr_max_image_side', String(DEFAULT_PDF_RASTER_MAX_IMAGE_SIDE)),
    DEFAULT_PDF_RASTER_MAX_IMAGE_SIDE,
    MIN_PDF_RASTER_MAX_IMAGE_SIDE,
    MAX_PDF_RASTER_MAX_IMAGE_SIDE,
  )
  return {
    enabled,
    minSizeMb,
    minSizeBytes: minSizeMb * 1024 * 1024,
    quality,
    maxImageSide,
  }
}

function makeSummary(payload: {
  attempted: boolean
  compressed: boolean
  skipped?: boolean
  reason?: string
  originalBytes: number
  storedBytes: number
  settings: PdfCompressionSettings
  tool?: string
  toolVersion?: string
}): PdfCompressionSummary {
  const savedBytes = Math.max(0, payload.originalBytes - payload.storedBytes)
  return {
    attempted: payload.attempted,
    compressed: payload.compressed,
    skipped: payload.skipped,
    reason: payload.reason,
    originalBytes: payload.originalBytes,
    storedBytes: payload.storedBytes,
    savedBytes,
    ratio: payload.originalBytes > 0 ? payload.storedBytes / payload.originalBytes : 1,
    quality: payload.settings.quality,
    thresholdBytes: payload.settings.minSizeBytes,
    maxImageSide: payload.settings.maxImageSide,
    tool: payload.tool || 'qpdf',
    toolVersion: payload.toolVersion,
  }
}

function withStoredBytes(summary: PdfCompressionSummary, storedBytes: number): PdfCompressionSummary {
  const savedBytes = Math.max(0, summary.originalBytes - storedBytes)
  return {
    ...summary,
    storedBytes,
    savedBytes,
    ratio: summary.originalBytes > 0 ? storedBytes / summary.originalBytes : 1,
  }
}

function hashFileSync(filePath: string): string {
  const hash = createHash('sha256')
  const fd = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(filePath, 'r')
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

export function getPdfFileFingerprint(filePath: string): PdfFileFingerprint {
  const stats = statSync(filePath)
  return {
    sha256: hashFileSync(filePath),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  }
}

export async function getPdfFileFingerprintAsync(filePath: string): Promise<PdfFileFingerprint> {
  const stats = await stat(filePath)
  return {
    sha256: await hashFile(filePath),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  }
}

function getResourceRoot(): string {
  if (app.isPackaged) return process.resourcesPath
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

function getToolDisplay(executable: string): string {
  return basename(executable).toLowerCase().startsWith('qpdf') ? 'qpdf' : executable
}

function runCommand(executable: string, args: string[], timeoutMs = QPDF_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`qpdf timed out after ${Math.round(timeoutMs / 1000)} seconds`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise({ stdout, stderr })
      } else {
        reject(new Error((stderr || stdout || `qpdf exited with code ${code}`).trim()))
      }
    })
  })
}

async function getQpdfVersion(executable: string): Promise<string | undefined> {
  try {
    const result = await runCommand(executable, ['--version'], 30_000)
    return (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() || undefined
  } catch {
    return undefined
  }
}

function getQpdfVersionSync(executable: string): string | undefined {
  try {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    if (result.error || result.status !== 0) return undefined
    return String(result.stdout || result.stderr || '').split(/\r?\n/)[0]?.trim() || undefined
  } catch {
    return undefined
  }
}

async function assertReadablePdf(filePath: string): Promise<void> {
  const bytes = await readFile(filePath)
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
  if (pdf.getPageCount() < 0) throw new Error('invalid PDF page count')
}

function safePdfFileName(filePathOrName: string): string {
  const base = basename(filePathOrName, extname(filePathOrName)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'document'
  return `${base}.pdf`
}

function createTempPdfPath(label: string): string {
  const dir = join(getDataDir(), 'temp', 'pdf-compression')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`)
}

async function loadPdfJs(): Promise<PdfJsModule> {
  return await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfJsModule
}

async function loadCanvas(): Promise<CanvasModule> {
  return await import('@napi-rs/canvas') as unknown as CanvasModule
}

async function tryCompressWithQpdf(sourcePath: string, outputPath: string, settings: PdfCompressionSettings): Promise<{ tool: string; toolVersion?: string }> {
  const executable = resolveQpdfExecutable()
  const toolVersion = await getQpdfVersion(executable)
  await runCommand(executable, [
    '--recompress-flate',
    '--compression-level=9',
    '--object-streams=generate',
    '--optimize-images',
    `--jpeg-quality=${settings.quality}`,
    sourcePath,
    outputPath,
  ])
  await runCommand(executable, ['--check', outputPath], QPDF_CHECK_TIMEOUT_MS)
  return { tool: getToolDisplay(executable), toolVersion }
}

async function tryCompressWithRasterRebuild(sourcePath: string, outputPath: string, settings: PdfCompressionSettings): Promise<CompressionToolResult> {
  const [pdfjs, canvasModule] = await Promise.all([loadPdfJs(), loadCanvas()])
  const sourceBytes = await readFile(sourcePath)
  const loadingTask = pdfjs.getDocument(getPdfJsNodeDocumentOptions({
    data: new Uint8Array(sourceBytes),
    disableWorker: true,
  }))
  const sourcePdf = await loadingTask.promise
  const outputPdf = await PDFDocument.create()

  try {
    if (!Number.isFinite(sourcePdf.numPages) || sourcePdf.numPages <= 0) {
      throw new Error('PDF has no pages')
    }

    for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
      const page = await sourcePdf.getPage(pageNumber)
      const pageViewport = page.getViewport({ scale: 1 })
      const maxPageSide = Math.max(pageViewport.width, pageViewport.height)
      const scale = maxPageSide > 0 ? Math.max(0.1, settings.maxImageSide / maxPageSide) : 1
      const renderViewport = page.getViewport({ scale })
      const width = Math.max(1, Math.ceil(renderViewport.width))
      const height = Math.max(1, Math.ceil(renderViewport.height))
      const canvas = canvasModule.createCanvas(width, height)
      const canvasContext = canvas.getContext('2d')

      await page.render({
        canvasContext,
        viewport: renderViewport,
        annotationMode: pdfjs.AnnotationMode?.DISABLE ?? 0,
        background: 'rgb(255,255,255)',
      }).promise
      await applyCjkTextRenderFallback(page, renderViewport, canvasContext, width, height).catch((error) => {
        console.warn('[PDF Compression] PDF CJK text render fallback failed', error)
      })

      const jpegBytes = canvas.toBuffer('image/jpeg', settings.quality)
      const embeddedPage = await outputPdf.embedJpg(jpegBytes)
      const outputPage = outputPdf.addPage([pageViewport.width, pageViewport.height])
      outputPage.drawImage(embeddedPage, {
        x: 0,
        y: 0,
        width: pageViewport.width,
        height: pageViewport.height,
      })
      page.cleanup?.()
    }
  } finally {
    await sourcePdf.destroy?.()
  }

  const outputBytes = await outputPdf.save({ useObjectStreams: true })
  await writeFile(outputPath, outputBytes)
  return {
    tool: 'pdfjs-raster',
    toolVersion: pdfjs.version ? `pdfjs ${pdfjs.version}; @napi-rs/canvas` : '@napi-rs/canvas',
  }
}

function truncateReason(value: unknown): string {
  return String((value as Error)?.message || value || 'unknown').replace(/\s+/g, ' ').slice(0, 240)
}

function combineToolInfo(primary: CompressionToolResult | undefined, fallback: CompressionToolResult): CompressionToolResult {
  if (!primary?.tool) return fallback
  return {
    tool: `${primary.tool}+${fallback.tool}`,
    toolVersion: [primary.toolVersion, fallback.toolVersion].filter(Boolean).join('; ') || undefined,
  }
}

async function tryRasterRebuildForSmallerPdf(
  sourcePath: string,
  destPath: string,
  original: PdfFileFingerprint,
  sourceSizeBytes: number,
  settings: PdfCompressionSettings,
  primaryTool?: CompressionToolResult,
): Promise<StorePdfResult | null> {
  const tempPath = createTempPdfPath('pdfjs-raster')
  try {
    const rasterTool = await tryCompressWithRasterRebuild(sourcePath, tempPath, settings)
    await assertReadablePdf(tempPath)
    const rasterStats = await stat(tempPath)
    if (rasterStats.size <= 0) throw new Error('raster PDF is empty')
    if (rasterStats.size >= sourceSizeBytes) return null

    await rm(destPath, { force: true })
    await rename(tempPath, destPath)
    const storedFingerprint = await getPdfFileFingerprintAsync(destPath)
    return {
      storedPath: destPath,
      storedFingerprint,
      compression: makeSummary({
        attempted: true,
        compressed: true,
        originalBytes: original.sizeBytes,
        storedBytes: storedFingerprint.sizeBytes,
        settings,
        ...combineToolInfo(primaryTool, rasterTool),
      }),
    }
  } finally {
    await rm(tempPath, { force: true })
  }
}

async function copyOriginalPdfAsync(sourcePath: string, destPath: string, summary: PdfCompressionSummary): Promise<StorePdfResult> {
  await copyFile(sourcePath, destPath)
  const storedFingerprint = await getPdfFileFingerprintAsync(destPath)
  return {
    storedPath: destPath,
    storedFingerprint,
    compression: withStoredBytes(summary, storedFingerprint.sizeBytes),
  }
}

function copyOriginalPdf(sourcePath: string, destPath: string, summary: PdfCompressionSummary): StorePdfResult {
  copyFileSync(sourcePath, destPath)
  const storedFingerprint = getPdfFileFingerprint(destPath)
  return {
    storedPath: destPath,
    storedFingerprint,
    compression: withStoredBytes(summary, storedFingerprint.sizeBytes),
  }
}

export async function storePdfWithCompression(sourcePath: string, destDir: string, originalFingerprint?: PdfFileFingerprint): Promise<StorePdfResult> {
  return storePdfWithCompressionToPath(sourcePath, destDir, originalFingerprint)
}

export async function storePdfWithCompressionToPath(sourcePath: string, destDir: string, originalFingerprint?: PdfFileFingerprint, options: StorePdfOptions = {}): Promise<StorePdfResult> {
  const settings = getPdfCompressionSettings()
  const original = originalFingerprint || await getPdfFileFingerprintAsync(sourcePath)
  const sourceStats = await stat(sourcePath)
  const sourceSizeBytes = sourceStats.size
  await mkdir(destDir, { recursive: true })
  const destPath = join(destDir, safePdfFileName(options.destFileName || sourcePath))

  if (!settings.enabled) {
    const summary = makeSummary({ attempted: false, compressed: false, skipped: true, reason: 'disabled', originalBytes: original.sizeBytes, storedBytes: original.sizeBytes, settings })
    await copyFile(sourcePath, destPath)
    const storedFingerprint = await getPdfFileFingerprintAsync(destPath)
    return { storedPath: destPath, storedFingerprint, compression: withStoredBytes(summary, storedFingerprint.sizeBytes) }
  }
  if (sourceSizeBytes < settings.minSizeBytes) {
    const summary = makeSummary({ attempted: false, compressed: false, skipped: true, reason: 'below_threshold', originalBytes: original.sizeBytes, storedBytes: original.sizeBytes, settings })
    await copyFile(sourcePath, destPath)
    const storedFingerprint = await getPdfFileFingerprintAsync(destPath)
    return { storedPath: destPath, storedFingerprint, compression: withStoredBytes(summary, storedFingerprint.sizeBytes) }
  }

  const tempPath = createTempPdfPath('qpdf')
  let qpdfTool: CompressionToolResult | undefined
  let qpdfFailureReason = ''
  try {
    qpdfTool = await tryCompressWithQpdf(sourcePath, tempPath, settings)
    await assertReadablePdf(tempPath)
    const compressedStats = await stat(tempPath)
    if (compressedStats.size <= 0) throw new Error('compressed PDF is empty')
    if (compressedStats.size < sourceSizeBytes) {
      await rm(destPath, { force: true })
      await rename(tempPath, destPath)
      const storedFingerprint = await getPdfFileFingerprintAsync(destPath)
      return {
        storedPath: destPath,
        storedFingerprint,
        compression: makeSummary({ attempted: true, compressed: true, originalBytes: original.sizeBytes, storedBytes: storedFingerprint.sizeBytes, settings, ...qpdfTool }),
      }
    }
    qpdfFailureReason = 'qpdf_not_smaller'
  } catch (error) {
    qpdfFailureReason = `qpdf_failed: ${truncateReason(error)}`
  } finally {
    await rm(tempPath, { force: true })
  }

  const summary = makeSummary({
    attempted: true,
    compressed: false,
    skipped: true,
    reason: qpdfFailureReason || 'qpdf_not_smaller',
    originalBytes: original.sizeBytes,
    storedBytes: original.sizeBytes,
    settings,
    ...qpdfTool,
  })
  return copyOriginalPdfAsync(sourcePath, destPath, summary)
}

export function storePdfWithCompressionSync(sourcePath: string, destDir: string, originalFingerprint?: PdfFileFingerprint): StorePdfResult {
  return storePdfWithCompressionSyncToPath(sourcePath, destDir, originalFingerprint)
}

export function storePdfWithCompressionSyncToPath(sourcePath: string, destDir: string, originalFingerprint?: PdfFileFingerprint, options: StorePdfOptions = {}): StorePdfResult {
  const settings = getPdfCompressionSettings()
  const original = originalFingerprint || getPdfFileFingerprint(sourcePath)
  const sourceSizeBytes = statSync(sourcePath).size
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, safePdfFileName(options.destFileName || sourcePath))

  if (!settings.enabled) {
    return copyOriginalPdf(sourcePath, destPath, makeSummary({ attempted: false, compressed: false, skipped: true, reason: 'disabled', originalBytes: original.sizeBytes, storedBytes: original.sizeBytes, settings }))
  }
  if (sourceSizeBytes < settings.minSizeBytes) {
    return copyOriginalPdf(sourcePath, destPath, makeSummary({ attempted: false, compressed: false, skipped: true, reason: 'below_threshold', originalBytes: original.sizeBytes, storedBytes: original.sizeBytes, settings }))
  }

  const tempPath = createTempPdfPath('qpdf-sync')
  try {
    const executable = resolveQpdfExecutable()
    const toolVersion = getQpdfVersionSync(executable)
    const child = spawnSync(executable, [
      '--recompress-flate',
      '--compression-level=9',
      '--object-streams=generate',
      '--optimize-images',
      `--jpeg-quality=${settings.quality}`,
      sourcePath,
      tempPath,
    ], { encoding: 'utf8', timeout: QPDF_TIMEOUT_MS, windowsHide: true })
    if (child.error) throw child.error
    if (child.status !== 0) throw new Error(String(child.stderr || child.stdout || `qpdf exited with code ${child.status}`).trim())
    const compressedStats = statSync(tempPath)
    if (compressedStats.size <= 0) throw new Error('compressed PDF is empty')
    const check = spawnSync(executable, ['--check', tempPath], { encoding: 'utf8', timeout: QPDF_CHECK_TIMEOUT_MS, windowsHide: true })
    if (check.error) throw check.error
    if (check.status !== 0) throw new Error(String(check.stderr || check.stdout || `qpdf --check exited with code ${check.status}`).trim())
    if (compressedStats.size >= sourceSizeBytes) {
      rmSync(tempPath, { force: true })
      return copyOriginalPdf(sourcePath, destPath, makeSummary({ attempted: true, compressed: false, skipped: true, reason: 'not_smaller', originalBytes: original.sizeBytes, storedBytes: original.sizeBytes, settings, tool: getToolDisplay(executable), toolVersion }))
    }
    rmSync(destPath, { force: true })
    renameSync(tempPath, destPath)
    const storedFingerprint = getPdfFileFingerprint(destPath)
    return {
      storedPath: destPath,
      storedFingerprint,
      compression: makeSummary({ attempted: true, compressed: true, originalBytes: original.sizeBytes, storedBytes: storedFingerprint.sizeBytes, settings, tool: getToolDisplay(executable), toolVersion }),
    }
  } catch (error) {
    rmSync(tempPath, { force: true })
    const reason = `failed: ${String((error as Error)?.message || error).slice(0, 240)}`
    return copyOriginalPdf(sourcePath, destPath, makeSummary({ attempted: true, compressed: false, skipped: true, reason, originalBytes: original.sizeBytes, storedBytes: original.sizeBytes, settings }))
  }
}

export function buildPdfCompressionMetadata(originalFileName: string, originalFingerprint: PdfFileFingerprint, storedFingerprint: PdfFileFingerprint, compression: PdfCompressionSummary): DocumentMetadataResult {
  return {
    original_file_name: originalFileName,
    file_sha256: storedFingerprint.sha256,
    file_size_bytes: storedFingerprint.sizeBytes,
    file_mtime_ms: storedFingerprint.mtimeMs,
    file_ext: '.pdf',
    file_kind: 'pdf',
    pdf_sha256: originalFingerprint.sha256,
    pdf_size_bytes: originalFingerprint.sizeBytes,
    pdf_mtime_ms: originalFingerprint.mtimeMs,
    pdf_original_sha256: originalFingerprint.sha256,
    pdf_original_size_bytes: originalFingerprint.sizeBytes,
    pdf_stored_sha256: storedFingerprint.sha256,
    pdf_stored_size_bytes: storedFingerprint.sizeBytes,
    pdf_compressed_size_bytes: storedFingerprint.sizeBytes,
    pdf_compression_attempted: compression.attempted,
    pdf_compression_applied: compression.compressed,
    pdf_compression_skipped: Boolean(compression.skipped),
    pdf_compression_reason: compression.reason || null,
    pdf_compression_quality: compression.quality,
    pdf_compression_max_image_side: compression.maxImageSide || null,
    pdf_compression_ratio: compression.ratio,
    pdf_compression_saved_bytes: compression.savedBytes,
    pdf_compression_tool: compression.tool,
    pdf_compression_tool_version: compression.toolVersion || null,
  }
}

export async function ensureStoredPdfCompressedForUpload(docId: string): Promise<{ path: string | null; compression?: PdfCompressionSummary }> {
  const doc = queryOne<{ file_path: string | null; metadata: string | null }>('SELECT file_path, metadata FROM documents WHERE id = ?', [docId])
  const filePath = String(doc?.file_path || '').trim()
  if (!doc || !filePath || extname(filePath).toLowerCase() !== '.pdf' || !existsSync(filePath)) return { path: filePath || null }
  const metadata = parseMetadata(doc.metadata)
  const compressionTool = String(metadata.pdf_compression_tool || '')
  const alreadyCompressed = metadata.pdf_compression_applied === true || metadata.pdf_compression_applied === 'true'
  const rasterAlreadyTried = compressionTool.includes('pdfjs-raster')
  if (alreadyCompressed || rasterAlreadyTried) {
    return { path: filePath }
  }

  const sourceFingerprint = await getPdfFileFingerprintAsync(filePath)
  const settings = getPdfCompressionSettings()
  if (!settings.enabled || sourceFingerprint.sizeBytes < settings.minSizeBytes) return { path: filePath }

  const storageDir = dirname(filePath)
  const tempSource = join(storageDir, `.original-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`)
  await rename(filePath, tempSource)
  try {
    const originalFingerprint = {
      sha256: String(metadata.pdf_sha256 || metadata.pdf_original_sha256 || sourceFingerprint.sha256),
      sizeBytes: Number(metadata.pdf_size_bytes || metadata.pdf_original_size_bytes || sourceFingerprint.sizeBytes),
      mtimeMs: Number(metadata.pdf_mtime_ms || sourceFingerprint.mtimeMs),
    }
    const result = await storePdfWithCompressionToPath(tempSource, storageDir, originalFingerprint, { destFileName: basename(filePath) })
    if (resolve(result.storedPath) !== resolve(filePath)) {
      await rm(filePath, { force: true })
      await rename(result.storedPath, filePath)
    }
    await rm(tempSource, { force: true })
    const nextMetadata = {
      ...metadata,
      ...buildPdfCompressionMetadata(String(metadata.original_file_name || basename(filePath)), originalFingerprint, result.storedFingerprint, result.compression),
      pdf_asset_state: 'available',
      pdf_asset_deleted_at: null,
    }
    run('UPDATE documents SET file_path = ?, metadata = ?, updated_at = ? WHERE id = ?', [
      filePath,
      JSON.stringify(nextMetadata),
      new Date().toISOString(),
      docId,
    ])
    scheduleDatabaseSave()
    return { path: filePath, compression: result.compression }
  } catch (error) {
    if (!existsSync(filePath) && existsSync(tempSource)) await rename(tempSource, filePath)
    throw error
  } finally {
    await rm(tempSource, { force: true })
  }
}
