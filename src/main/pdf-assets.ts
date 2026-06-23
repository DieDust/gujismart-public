import { createHash } from 'crypto'
import { nativeImage } from 'electron'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { copyFile, mkdir, open, readdir, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, normalize } from 'path'
import { getDataDir, queryAll, queryOne, resolveManagedStoragePath, run, scheduleDatabaseSave } from './database'
import { hydratePagePayloadRows, preparePagePayloadUpdate } from './page-payload-store'
import { buildPdfCompressionMetadata, storePdfWithCompression, storePdfWithCompressionSync } from './pdf-compression'
import type {
  CompletedPdfAssetCleanupResult,
  DocumentMetadataResult,
  PdfAssetCleanupResult,
  PdfAssetRestoreResult,
  PdfRepositoryIndexResult,
  PdfRepositoryStatus,
} from '../shared/types'

type PdfAssetState = 'available' | 'text_only'
type FingerprintKind = 'pdf' | 'ebook' | 'text' | 'file'
type FileFingerprint = { sha256: string; sizeBytes: number; mtimeMs: number; ext: string; kind: FingerprintKind }
export type PdfFingerprint = { sha256: string; sizeBytes: number; mtimeMs: number }
export type CopiedFileFingerprints = {
  sourceFingerprint: FileFingerprint
  storedFingerprint: FileFingerprint
}
export type CopyFileProgress = {
  bytesDone: number
  totalBytes: number
}

interface DocumentRow {
  id: string
  title: string
  file_path: string | null
  thumb_path: string | null
  page_count: number | null
  metadata: string | null
}

interface RepositoryIndexRow {
  path: string
  sha256: string
  size_bytes: number
  mtime_ms: number
  indexed_at: string
}

interface PageAssetRow {
  id: string
  doc_id: string
  page_num: number | null
  image_path: string | null
  ocr_result: string | null
  ocr_result_ref?: string | null
}

type JsonRecord = Record<string, unknown>
type OcrLayoutBlock = JsonRecord

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

const FINGERPRINT_EXTENSIONS = new Set(['.pdf', '.epub', '.txt', '.md', '.markdown'])
const EBOOK_EXTENSIONS = new Set(['.epub'])
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown'])
const HASH_CHUNK_BYTES = 8 * 1024 * 1024
const activeAutoCleanupPdfAssetDocIds = new Set<string>()
const activeAutoCleanupPdfAssetJobs = new Set<Promise<void>>()
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonValue(value: unknown): unknown {
  if (!value || typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function parseMetadata(value: unknown): DocumentMetadataResult {
  const parsed = parseJsonValue(value)
  return isRecord(parsed) ? parsed : {}
}

function parseJsonObject(value: unknown): JsonRecord | null {
  const parsed = parseJsonValue(value)
  return isRecord(parsed) ? parsed : null
}

function getPathValue(source: JsonRecord, path: string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function getPointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number {
  if (isRecord(point)) return Number(point[key])
  if (Array.isArray(point)) return Number(point[tupleIndex])
  return Number.NaN
}

function getBlockLabel(block: OcrLayoutBlock): string {
  return String(block?.label || block?.block_label || block?.type || block?.block_type || '').toLowerCase()
}

function isImageBlock(block: OcrLayoutBlock): boolean {
  const label = getBlockLabel(block).replace(/[_-]+/g, ' ').trim()
  return /^(?:image|figure|picture|chart|diagram|photo|illustration)$/.test(label)
    || /图片|图像|插图|示意图|图表|照片/.test(label)
}

function getBlockRect(block: OcrLayoutBlock): Rect | null {
  const loc = block?.location || block?.rect || block?.points || block?.block_bbox || block?.bbox
  if (isRecord(loc) && (loc.left !== undefined || loc.top !== undefined || loc.width !== undefined || loc.height !== undefined)) {
    const left = Number(loc.left ?? loc.x)
    const top = Number(loc.top ?? loc.y)
    const width = Number(loc.width)
    const height = Number(loc.height)
    if ([left, top, width, height].every(Number.isFinite) && width > 0 && height > 0) return { left, top, width, height }
  }
  if (Array.isArray(loc) && loc.length > 0) {
    const xs = loc.map((point) => getPointCoordinate(point, 'x', 0)).filter(Number.isFinite)
    const ys = loc.map((point) => getPointCoordinate(point, 'y', 1)).filter(Number.isFinite)
    if (xs.length > 1 && ys.length > 1) {
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
    }
  }
  return null
}

function getCoordinateSourceSize(parsed: JsonRecord, imageSize: { width: number; height: number }): { width: number; height: number } {
  const candidates = [
    { width: getPathValue(parsed, ['guji_processing', 'source_image_width']), height: getPathValue(parsed, ['guji_processing', 'source_image_height']) },
    { width: parsed.source_image_width, height: parsed.source_image_height },
    { width: parsed.image_width, height: parsed.image_height },
    { width: parsed.page_width, height: parsed.page_height },
    { width: parsed.width, height: parsed.height },
  ]
  for (const candidate of candidates) {
    const width = Number(candidate.width || 0)
    const height = Number(candidate.height || 0)
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height }
  }
  return imageSize
}

function materializeContentImageAssets(docId: string): number {
  const pages = hydratePagePayloadRows(queryAll<PageAssetRow>(
    'SELECT id, doc_id, page_num, image_path, ocr_result, ocr_result_ref FROM pages WHERE doc_id = ? AND image_path IS NOT NULL AND TRIM(image_path) != ?',
    [docId, ''],
  ))
  if (pages.length === 0) return 0

  const assetDir = join(getDataDir(), 'storage', docId, 'extracted-images')
  let savedCount = 0
  for (const page of pages) {
    if (!page.image_path || !existsSync(page.image_path)) continue
    const parsed = parseJsonObject(page.ocr_result)
    const layoutBlocks: OcrLayoutBlock[] = Array.isArray(parsed?.layout_result) ? parsed.layout_result.filter(isRecord) : []
    if (!parsed || layoutBlocks.length === 0) continue

    const image = nativeImage.createFromPath(page.image_path)
    if (image.isEmpty()) continue
    const imageSize = image.getSize()
    if (imageSize.width <= 0 || imageSize.height <= 0) continue
    const sourceSize = getCoordinateSourceSize(parsed, imageSize)
    const scaleX = imageSize.width / Math.max(1, sourceSize.width)
    const scaleY = imageSize.height / Math.max(1, sourceSize.height)
    let changed = false

    layoutBlocks.forEach((block, index) => {
      if (!isImageBlock(block)) return
      const existingPath = String(block?.image_asset_path || block?.asset_path || block?.image_path || '').trim()
      if (existingPath && existsSync(existingPath)) return
      const rect = getBlockRect(block)
      if (!rect || rect.width < 8 || rect.height < 8) return
      const cropRect = {
        x: Math.max(0, Math.round(rect.left * scaleX)),
        y: Math.max(0, Math.round(rect.top * scaleY)),
        width: Math.max(1, Math.min(imageSize.width, Math.round(rect.width * scaleX))),
        height: Math.max(1, Math.min(imageSize.height, Math.round(rect.height * scaleY))),
      }
      if (cropRect.x >= imageSize.width || cropRect.y >= imageSize.height) return
      cropRect.width = Math.max(1, Math.min(cropRect.width, imageSize.width - cropRect.x))
      cropRect.height = Math.max(1, Math.min(cropRect.height, imageSize.height - cropRect.y))

      const cropped = image.crop(cropRect)
      if (cropped.isEmpty()) return
      const fileName = `page-${Number(page.page_num || 0) || 'x'}-block-${index + 1}.jpg`
      const assetPath = join(assetDir, fileName)
      mkdirSync(assetDir, { recursive: true })
      writeFileSync(assetPath, cropped.toJPEG(88))
      block.image_asset_path = assetPath
      block.asset_path = assetPath
      block.image_path = assetPath
      changed = true
      savedCount += 1
    })

    if (changed) {
      const preparedResult = preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_result', parsed)
      run('UPDATE pages SET ocr_result = ?, ocr_result_ref = ? WHERE id = ?', [preparedResult.value, preparedResult.ref, page.id])
    }
  }
  return savedCount
}

async function materializeContentImageAssetsAsync(docId: string): Promise<number> {
  const pages = hydratePagePayloadRows(queryAll<PageAssetRow>(
    'SELECT id, doc_id, page_num, image_path, ocr_result, ocr_result_ref FROM pages WHERE doc_id = ? AND image_path IS NOT NULL AND TRIM(image_path) != ?',
    [docId, ''],
  ))
  if (pages.length === 0) return 0

  const assetDir = join(getDataDir(), 'storage', docId, 'extracted-images')
  let savedCount = 0
  for (const page of pages) {
    if (!page.image_path || !(await pathExists(page.image_path))) continue
    const parsed = parseJsonObject(page.ocr_result)
    const layoutBlocks: OcrLayoutBlock[] = Array.isArray(parsed?.layout_result) ? parsed.layout_result.filter(isRecord) : []
    if (!parsed || layoutBlocks.length === 0) continue

    const image = nativeImage.createFromPath(page.image_path)
    if (image.isEmpty()) continue
    const imageSize = image.getSize()
    if (imageSize.width <= 0 || imageSize.height <= 0) continue
    const sourceSize = getCoordinateSourceSize(parsed, imageSize)
    const scaleX = imageSize.width / Math.max(1, sourceSize.width)
    const scaleY = imageSize.height / Math.max(1, sourceSize.height)
    let changed = false

    for (const [index, block] of layoutBlocks.entries()) {
      if (!isImageBlock(block)) continue
      const existingPath = String(block?.image_asset_path || block?.asset_path || block?.image_path || '').trim()
      if (existingPath && await pathExists(existingPath)) continue
      const rect = getBlockRect(block)
      if (!rect || rect.width < 8 || rect.height < 8) continue
      const cropRect = {
        x: Math.max(0, Math.round(rect.left * scaleX)),
        y: Math.max(0, Math.round(rect.top * scaleY)),
        width: Math.max(1, Math.min(imageSize.width, Math.round(rect.width * scaleX))),
        height: Math.max(1, Math.min(imageSize.height, Math.round(rect.height * scaleY))),
      }
      if (cropRect.x >= imageSize.width || cropRect.y >= imageSize.height) continue
      cropRect.width = Math.max(1, Math.min(cropRect.width, imageSize.width - cropRect.x))
      cropRect.height = Math.max(1, Math.min(cropRect.height, imageSize.height - cropRect.y))

      const cropped = image.crop(cropRect)
      if (cropped.isEmpty()) continue
      const fileName = `page-${Number(page.page_num || 0) || 'x'}-block-${index + 1}.jpg`
      const assetPath = join(assetDir, fileName)
      await mkdir(assetDir, { recursive: true })
      await writeFile(assetPath, cropped.toJPEG(88))
      block.image_asset_path = assetPath
      block.asset_path = assetPath
      block.image_path = assetPath
      changed = true
      savedCount += 1
    }

    if (changed) {
      const preparedResult = preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_result', parsed)
      run('UPDATE pages SET ocr_result = ?, ocr_result_ref = ? WHERE id = ?', [preparedResult.value, preparedResult.ref, page.id])
    }
    await yieldToEventLoop()
  }
  return savedCount
}

function updateMetadata(docId: string, patch: DocumentMetadataResult): DocumentMetadataResult {
  const row = queryOne<{ metadata: string | null }>('SELECT metadata FROM documents WHERE id = ?', [docId])
  const metadata = { ...parseMetadata(row?.metadata), ...patch }
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(metadata), new Date().toISOString(), docId])
  return metadata
}

function readRepositoryPaths(): string[] {
  const row = queryOne<{ value: string | null }>("SELECT value FROM settings WHERE key = 'pdf_repository_paths'")
  const parsed = parseJsonValue(row?.value || '[]')
  if (Array.isArray(parsed)) {
    return Array.from(new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean)))
  }
  return []
}

export function getPdfRepositoryPaths(): string[] {
  return readRepositoryPaths()
}

function writeRepositoryPaths(paths: string[]): void {
  const normalized = Array.from(new Set(paths.map((item) => normalize(String(item || '').trim())).filter(Boolean)))
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['pdf_repository_paths', JSON.stringify(normalized)])
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export function hashFile(filePath: string): string {
  const hash = createHash('sha256')
  const fd = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
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

async function hashFileAsync(filePath: string, onProgress?: (progress: CopyFileProgress) => void, totalBytes = 0): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(filePath, 'r')
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  let bytesDone = 0
  let lastProgressAt = 0
  let lastProgressBytes = 0
  const emitProgress = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (
      !force
      && now - lastProgressAt < 250
      && bytesDone - lastProgressBytes < 32 * 1024 * 1024
    ) {
      return
    }
    lastProgressAt = now
    lastProgressBytes = bytesDone
    onProgress({ bytesDone, totalBytes })
  }
  try {
    emitProgress(true)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
      bytesDone += bytesRead
      emitProgress()
      await yieldToEventLoop()
    }
    emitProgress(true)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

export function getFileFingerprint(filePath: string): { sha256: string; sizeBytes: number; mtimeMs: number; ext: string; kind: FingerprintKind } {
  const stats = statSync(filePath)
  const ext = extname(filePath).toLowerCase()
  const kind: FingerprintKind = ext === '.pdf'
    ? 'pdf'
    : EBOOK_EXTENSIONS.has(ext)
      ? 'ebook'
      : TEXT_EXTENSIONS.has(ext)
        ? 'text'
        : 'file'
  return {
    sha256: hashFile(filePath),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    ext,
    kind,
  }
}

async function getFileFingerprintAsync(filePath: string, onProgress?: (progress: CopyFileProgress) => void): Promise<FileFingerprint> {
  const stats = await stat(filePath)
  const ext = extname(filePath).toLowerCase()
  const kind: FingerprintKind = ext === '.pdf'
    ? 'pdf'
    : EBOOK_EXTENSIONS.has(ext)
      ? 'ebook'
      : TEXT_EXTENSIONS.has(ext)
        ? 'text'
        : 'file'
  return {
    sha256: await hashFileAsync(filePath, onProgress, stats.size),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    ext,
    kind,
  }
}

async function writeBufferFully(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null)
    if (bytesWritten <= 0) throw new Error('Failed to write copied file chunk')
    offset += bytesWritten
  }
}

export async function copyFileWithFingerprintAsync(
  sourcePath: string,
  destPath: string,
  knownSourceFingerprint?: PdfFingerprint,
  onProgress?: (progress: CopyFileProgress) => void,
): Promise<CopiedFileFingerprints> {
  const sourceStats = await stat(sourcePath)
  const ext = extname(sourcePath).toLowerCase()
  const kind: FingerprintKind = ext === '.pdf'
    ? 'pdf'
    : EBOOK_EXTENSIONS.has(ext)
      ? 'ebook'
      : TEXT_EXTENSIONS.has(ext)
        ? 'text'
        : 'file'
  const sourceFingerprint = knownSourceFingerprint
    ? {
      sha256: knownSourceFingerprint.sha256,
      sizeBytes: knownSourceFingerprint.sizeBytes,
      mtimeMs: knownSourceFingerprint.mtimeMs,
      ext,
      kind,
    }
    : null
  const hash = sourceFingerprint ? null : createHash('sha256')
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  let readHandle: Awaited<ReturnType<typeof open>> | null = null
  let writeHandle: Awaited<ReturnType<typeof open>> | null = null
  let bytesDone = 0
  let lastProgressAt = 0
  let lastProgressBytes = 0
  const emitProgress = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (
      !force
      && now - lastProgressAt < 250
      && bytesDone - lastProgressBytes < 32 * 1024 * 1024
    ) {
      return
    }
    lastProgressAt = now
    lastProgressBytes = bytesDone
    onProgress({ bytesDone, totalBytes: sourceStats.size })
  }

  try {
    await mkdir(dirname(destPath), { recursive: true })
    readHandle = await open(sourcePath, 'r')
    writeHandle = await open(destPath, 'w')
    emitProgress(true)
    while (true) {
      const { bytesRead } = await readHandle.read(buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash?.update(chunk)
      await writeBufferFully(writeHandle, chunk)
      bytesDone += bytesRead
      emitProgress()
      await yieldToEventLoop()
    }
    emitProgress(true)
  } catch (error) {
    await rm(destPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await writeHandle?.close().catch(() => undefined)
    await readHandle?.close().catch(() => undefined)
  }

  const sha256 = sourceFingerprint?.sha256 || hash?.digest('hex') || ''
  const storedStats = await stat(destPath)
  return {
    sourceFingerprint: sourceFingerprint || {
      sha256,
      sizeBytes: sourceStats.size,
      mtimeMs: sourceStats.mtimeMs,
      ext,
      kind,
    },
    storedFingerprint: {
      sha256,
      sizeBytes: storedStats.size,
      mtimeMs: storedStats.mtimeMs,
      ext,
      kind,
    },
  }
}

export function getPdfFingerprint(filePath: string): { sha256: string; sizeBytes: number; mtimeMs: number } {
  const fingerprint = getFileFingerprint(filePath)
  return {
    sha256: fingerprint.sha256,
    sizeBytes: fingerprint.sizeBytes,
    mtimeMs: fingerprint.mtimeMs,
  }
}

export async function getPdfFingerprintAsync(filePath: string, onProgress?: (progress: CopyFileProgress) => void): Promise<PdfFingerprint> {
  const fingerprint = await getFileFingerprintAsync(filePath, onProgress)
  return {
    sha256: fingerprint.sha256,
    sizeBytes: fingerprint.sizeBytes,
    mtimeMs: fingerprint.mtimeMs,
  }
}

function collectPdfFiles(dirPath: string, output: string[] = []): string[] {
  if (!existsSync(dirPath)) return output
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      collectPdfFiles(fullPath, output)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.pdf') {
      output.push(fullPath)
    }
  }
  return output
}

async function collectPdfFilesAsync(paths: string[]): Promise<string[]> {
  const output: string[] = []
  const pendingDirs = [...paths]
  let scannedDirs = 0
  while (pendingDirs.length > 0) {
    const dirPath = pendingDirs.shift()
    if (!dirPath) continue
    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        pendingDirs.push(fullPath)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.pdf') {
        output.push(fullPath)
      }
    }
    scannedDirs += 1
    if (scannedDirs % 20 === 0) await yieldToEventLoop()
  }
  return output
}

function buildFileFingerprintPatch(filePath: string, fingerprint = getFileFingerprint(filePath), pageCount?: number): DocumentMetadataResult {
  const patch: DocumentMetadataResult = {
    file_sha256: fingerprint.sha256,
    file_size_bytes: fingerprint.sizeBytes,
    file_mtime_ms: fingerprint.mtimeMs,
    file_ext: fingerprint.ext,
    file_kind: fingerprint.kind,
    original_file_name: basename(filePath),
  }
  if (fingerprint.kind === 'pdf') {
    patch.pdf_sha256 = fingerprint.sha256
    patch.pdf_size_bytes = fingerprint.sizeBytes
    patch.pdf_mtime_ms = fingerprint.mtimeMs
    patch.pdf_asset_state = 'available' as PdfAssetState
    patch.pdf_asset_deleted_at = null
    if (pageCount) patch.pdf_page_count = pageCount
  }
  return patch
}

function getLibraryPdfTargets(): Array<{ docId: string; sha256: string; sizeBytes: number }> {
  return queryAll<{ docId: string; sha256: string; sizeBytes: number }>(`
    SELECT id as docId,
      json_extract(metadata, '$.pdf_sha256') as sha256,
      COALESCE(json_extract(metadata, '$.pdf_size_bytes'), json_extract(metadata, '$.file_size_bytes'), 0) as sizeBytes
    FROM documents
    WHERE json_extract(metadata, '$.pdf_sha256') IS NOT NULL
      AND json_extract(metadata, '$.pdf_sha256') != ''
  `).map((row) => ({
    docId: row.docId,
    sha256: String(row.sha256 || ''),
    sizeBytes: Number(row.sizeBytes || 0),
  })).filter((row) => row.sha256)
}

function isPathInsideDirectory(filePath: string, dirPath: string): boolean {
  const normalizedFile = normalize(filePath).toLowerCase()
  const normalizedDir = normalize(dirPath).toLowerCase()
  const prefix = normalizedDir.endsWith('\\') || normalizedDir.endsWith('/')
    ? normalizedDir
    : `${normalizedDir}\\`
  return normalizedFile === normalizedDir || normalizedFile.startsWith(prefix)
}

function isPathInsideAny(filePath: string, dirPaths: string[]): boolean {
  return dirPaths.some((dirPath) => isPathInsideDirectory(filePath, dirPath))
}

function existingRepositoryRowsForTargets(targetHashes: Set<string>): RepositoryIndexRow[] {
  if (targetHashes.size === 0) return []
  return queryAll<RepositoryIndexRow>('SELECT * FROM pdf_repository_index')
    .filter((row) => targetHashes.has(row.sha256))
}

export function annotateDocumentFileFingerprint(docId: string, filePath: string, pageCount?: number): void {
  if (!filePath || !existsSync(filePath)) return
  const ext = extname(filePath).toLowerCase()
  if (!FINGERPRINT_EXTENSIONS.has(ext)) return
  updateMetadata(docId, buildFileFingerprintPatch(filePath, undefined, pageCount))
  scheduleDatabaseSave()
}

export function backfillLibraryFileFingerprints(): { scannedCount: number; updatedCount: number } {
  const docs = queryAll<DocumentRow>(`
    SELECT id, title, file_path, thumb_path, page_count, metadata
    FROM documents
    WHERE file_path IS NOT NULL AND file_path != ''
  `)
  let scannedCount = 0
  let updatedCount = 0
  for (const doc of docs) {
    const filePath = resolveManagedStoragePath(doc.file_path, doc.id)
    if (!filePath || !existsSync(filePath)) continue
    const ext = extname(filePath).toLowerCase()
    if (!FINGERPRINT_EXTENSIONS.has(ext)) continue

    scannedCount += 1
    const metadata = parseMetadata(doc.metadata)
    const needsGeneric = !metadata.file_sha256
    const needsPdf = ext === '.pdf' && !metadata.pdf_sha256
    if (!needsGeneric && !needsPdf) continue

    updateMetadata(doc.id, buildFileFingerprintPatch(filePath, undefined, doc.page_count || undefined))
    updatedCount += 1
  }
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['library_file_fingerprints_backfilled_at', new Date().toISOString()])
  scheduleDatabaseSave()
  return { scannedCount, updatedCount }
}

async function backfillLibraryFileFingerprintsAsync(): Promise<{ scannedCount: number; updatedCount: number }> {
  const docs = queryAll<DocumentRow>(`
    SELECT id, title, file_path, thumb_path, page_count, metadata
    FROM documents
    WHERE file_path IS NOT NULL AND file_path != ''
  `)
  let scannedCount = 0
  let updatedCount = 0
  for (const doc of docs) {
    const filePath = resolveManagedStoragePath(doc.file_path, doc.id)
    if (!filePath || !(await pathExists(filePath))) continue
    const ext = extname(filePath).toLowerCase()
    if (!FINGERPRINT_EXTENSIONS.has(ext)) continue

    scannedCount += 1
    const metadata = parseMetadata(doc.metadata)
    const needsGeneric = !metadata.file_sha256
    const needsPdf = ext === '.pdf' && !metadata.pdf_sha256
    if (!needsGeneric && !needsPdf) continue

    const fingerprint = await getFileFingerprintAsync(filePath)
    updateMetadata(doc.id, buildFileFingerprintPatch(filePath, fingerprint, doc.page_count || undefined))
    updatedCount += 1
    await yieldToEventLoop()
  }
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['library_file_fingerprints_backfilled_at', new Date().toISOString()])
  scheduleDatabaseSave()
  return { scannedCount, updatedCount }
}

export function getPdfRepositoryStatus(): PdfRepositoryStatus {
  const paths = readRepositoryPaths()
  const stats = queryOne<{ fileCount: number; totalBytes: number; lastIndexedAt: string | null }>(`
    SELECT COUNT(*) as fileCount, COALESCE(SUM(size_bytes), 0) as totalBytes, MAX(indexed_at) as lastIndexedAt
    FROM pdf_repository_index
  `)
  return {
    paths,
    stats: {
      fileCount: Number(stats?.fileCount || 0),
      totalBytes: Number(stats?.totalBytes || 0),
    },
    lastIndexedAt: stats?.lastIndexedAt || null,
  }
}

export function addPdfRepositoryPath(dirPath: string): PdfRepositoryStatus {
  const paths = readRepositoryPaths()
  const nextPaths = [...paths, dirPath]
  writeRepositoryPaths(nextPaths)
  scheduleDatabaseSave()
  return getPdfRepositoryStatus()
}

export function setPdfRepositoryPaths(paths: string[]): PdfRepositoryStatus {
  writeRepositoryPaths(paths)
  scheduleDatabaseSave()
  return getPdfRepositoryStatus()
}

export function indexPdfRepositories(paths = readRepositoryPaths()): PdfRepositoryIndexResult {
  const now = new Date().toISOString()
  const normalizedPaths = paths.map((item) => normalize(item)).filter(Boolean)
  writeRepositoryPaths(normalizedPaths)

  backfillLibraryFileFingerprints()
  const targets = getLibraryPdfTargets()
  const targetHashes = new Set(targets.map((item) => item.sha256))
  const canFilterBySize = targets.length > 0 && targets.every((item) => item.sizeBytes > 0)
  const targetSizes = new Set(targets.map((item) => item.sizeBytes).filter((size) => size > 0))
  const candidateExistingRows = existingRepositoryRowsForTargets(targetHashes)
  const files = normalizedPaths.flatMap((dirPath) => collectPdfFiles(dirPath))
  const matchedPaths = new Set<string>()
  const existingRows = queryAll<RepositoryIndexRow>('SELECT * FROM pdf_repository_index')
  const existingByPath = new Map(existingRows.map((row) => [normalize(row.path), row]))
  let totalBytes = 0

  for (const row of candidateExistingRows) {
    const filePath = normalize(row.path)
    if (!existsSync(filePath)) continue
    if (!isPathInsideAny(filePath, normalizedPaths)) continue
    matchedPaths.add(filePath)
    totalBytes += Number(row.size_bytes || 0)
  }

  for (const rawPath of files) {
    const filePath = normalize(rawPath)
    if (matchedPaths.has(filePath)) {
      continue
    }
    const stats = statSync(filePath)
    if (canFilterBySize && !targetSizes.has(stats.size)) {
      continue
    }
    const existing = existingByPath.get(filePath)
    let sha256 = existing?.sha256 || ''
    if (!existing || Number(existing.size_bytes) !== stats.size || Math.abs(Number(existing.mtime_ms) - stats.mtimeMs) >= 1) {
      sha256 = hashFile(filePath)
    }
    if (!targetHashes.has(sha256)) {
      continue
    }

    matchedPaths.add(filePath)
    totalBytes += stats.size
    if (existing && existing.sha256 === sha256 && Number(existing.size_bytes) === stats.size && Math.abs(Number(existing.mtime_ms) - stats.mtimeMs) < 1) {
      continue
    }
    run(
      'INSERT OR REPLACE INTO pdf_repository_index (path, sha256, size_bytes, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)',
      [filePath, sha256, stats.size, stats.mtimeMs, now],
    )
  }

  for (const row of existingRows) {
    if (!matchedPaths.has(normalize(row.path)) || !existsSync(row.path) || !targetHashes.has(row.sha256)) {
      run('DELETE FROM pdf_repository_index WHERE path = ?', [row.path])
    }
  }

  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['pdf_repository_last_indexed_at', now])
  scheduleDatabaseSave()

  const matchedCount = queryOne<{ cnt: number }>(`
    SELECT COUNT(DISTINCT d.id) as cnt
    FROM documents d
    INNER JOIN pdf_repository_index p
      ON p.sha256 = json_extract(d.metadata, '$.pdf_sha256')
  `)?.cnt || 0

  return { fileCount: matchedPaths.size, totalBytes, matchedCount: Number(matchedCount || 0) }
}

export async function indexPdfRepositoriesAsync(paths = readRepositoryPaths()): Promise<PdfRepositoryIndexResult> {
  const now = new Date().toISOString()
  const normalizedPaths = paths.map((item) => normalize(item)).filter(Boolean)
  writeRepositoryPaths(normalizedPaths)

  await backfillLibraryFileFingerprintsAsync()
  const targets = getLibraryPdfTargets()
  const targetHashes = new Set(targets.map((item) => item.sha256))
  if (targetHashes.size === 0) {
    run('DELETE FROM pdf_repository_index')
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['pdf_repository_last_indexed_at', now])
    scheduleDatabaseSave()
    return { fileCount: 0, totalBytes: 0, matchedCount: 0 }
  }
  const canFilterBySize = targets.length > 0 && targets.every((item) => item.sizeBytes > 0)
  const targetSizes = new Set(targets.map((item) => item.sizeBytes).filter((size) => size > 0))
  const candidateExistingRows = existingRepositoryRowsForTargets(targetHashes)
  const files = await collectPdfFilesAsync(normalizedPaths)
  const matchedPaths = new Set<string>()
  const existingRows = queryAll<RepositoryIndexRow>('SELECT * FROM pdf_repository_index')
  const existingByPath = new Map(existingRows.map((row) => [normalize(row.path), row]))
  let totalBytes = 0

  for (const row of candidateExistingRows) {
    const filePath = normalize(row.path)
    if (!(await pathExists(filePath))) continue
    if (!isPathInsideAny(filePath, normalizedPaths)) continue
    matchedPaths.add(filePath)
    totalBytes += Number(row.size_bytes || 0)
  }

  let processedFiles = 0
  for (const rawPath of files) {
    const filePath = normalize(rawPath)
    if (matchedPaths.has(filePath)) continue

    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(filePath)
    } catch {
      continue
    }
    if (canFilterBySize && !targetSizes.has(stats.size)) continue

    const existing = existingByPath.get(filePath)
    let sha256 = existing?.sha256 || ''
    if (!existing || Number(existing.size_bytes) !== stats.size || Math.abs(Number(existing.mtime_ms) - stats.mtimeMs) >= 1) {
      sha256 = await hashFileAsync(filePath)
    }
    if (!targetHashes.has(sha256)) continue

    matchedPaths.add(filePath)
    totalBytes += stats.size
    if (existing && existing.sha256 === sha256 && Number(existing.size_bytes) === stats.size && Math.abs(Number(existing.mtime_ms) - stats.mtimeMs) < 1) {
      continue
    }
    run(
      'INSERT OR REPLACE INTO pdf_repository_index (path, sha256, size_bytes, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)',
      [filePath, sha256, stats.size, stats.mtimeMs, now],
    )

    processedFiles += 1
    if (processedFiles % 10 === 0) await yieldToEventLoop()
  }

  for (const row of existingRows) {
    if (!matchedPaths.has(normalize(row.path)) || !(await pathExists(row.path)) || !targetHashes.has(row.sha256)) {
      run('DELETE FROM pdf_repository_index WHERE path = ?', [row.path])
    }
  }

  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['pdf_repository_last_indexed_at', now])
  scheduleDatabaseSave()

  const matchedCount = queryOne<{ cnt: number }>(`
    SELECT COUNT(DISTINCT d.id) as cnt
    FROM documents d
    INNER JOIN pdf_repository_index p
      ON p.sha256 = json_extract(d.metadata, '$.pdf_sha256')
  `)?.cnt || 0

  return { fileCount: matchedPaths.size, totalBytes, matchedCount: Number(matchedCount || 0) }
}

export function annotatePdfMetadata(docId: string, filePath: string, pageCount?: number): void {
  if (!filePath || extname(filePath).toLowerCase() !== '.pdf' || !existsSync(filePath)) return
  updateMetadata(docId, buildFileFingerprintPatch(filePath, undefined, pageCount))
  scheduleDatabaseSave()
}

export function cleanupPdfAssets(docId: string): PdfAssetCleanupResult {
  const doc = queryOne<DocumentRow>('SELECT id, title, file_path, thumb_path, page_count, metadata FROM documents WHERE id = ?', [docId])
  if (!doc) throw new Error('文献不存在')

  let bytesFreed = 0
  const preservedImageCount = materializeContentImageAssets(docId)
  const storageDir = join(getDataDir(), 'storage', docId)
  const metadata = parseMetadata(doc.metadata)
  const filePath = resolveManagedStoragePath(doc.file_path, docId)
  if (filePath && extname(filePath).toLowerCase() === '.pdf' && existsSync(filePath) && !metadata.pdf_sha256) {
    const fingerprint = getPdfFingerprint(filePath)
    updateMetadata(docId, {
      pdf_sha256: fingerprint.sha256,
      pdf_size_bytes: fingerprint.sizeBytes,
      pdf_page_count: doc.page_count || undefined,
      original_file_name: basename(filePath),
    })
  }
  const pathsToDelete = new Set<string>()
  const addPath = (value?: string | null) => {
    if (!value) return
    const normalizedPath = normalize(resolveManagedStoragePath(value, docId))
    if (isPathInsideDirectory(normalizedPath, storageDir) && existsSync(normalizedPath)) {
      pathsToDelete.add(normalizedPath)
    }
  }

  addPath(doc.file_path)
  addPath(doc.thumb_path)
  queryAll<{ image_path: string | null }>('SELECT image_path FROM pages WHERE doc_id = ?', [docId]).forEach((page) => addPath(page.image_path))

  for (const filePath of pathsToDelete) {
    try {
      const stats = statSync(filePath)
      if (stats.isFile()) {
        bytesFreed += stats.size
        rmSync(filePath, { force: true })
      }
    } catch {
      // Ignore files that disappeared while cleanup was running.
    }
  }

  run('UPDATE pages SET image_path = NULL WHERE doc_id = ?', [docId])
  run('UPDATE documents SET file_path = NULL, thumb_path = NULL, updated_at = ? WHERE id = ?', [new Date().toISOString(), docId])
  updateMetadata(docId, {
    pdf_asset_state: 'text_only' as PdfAssetState,
    pdf_asset_deleted_at: new Date().toISOString(),
    preserved_content_image_count: preservedImageCount,
  })
  scheduleDatabaseSave()
  return { cleaned: true, bytesFreed }
}

export async function cleanupPdfAssetsAsync(docId: string): Promise<PdfAssetCleanupResult> {
  const doc = queryOne<DocumentRow>('SELECT id, title, file_path, thumb_path, page_count, metadata FROM documents WHERE id = ?', [docId])
  if (!doc) throw new Error('文献不存在')

  let bytesFreed = 0
  const preservedImageCount = await materializeContentImageAssetsAsync(docId)
  const storageDir = join(getDataDir(), 'storage', docId)
  const metadata = parseMetadata(doc.metadata)
  const filePath = resolveManagedStoragePath(doc.file_path, docId)
  if (filePath && extname(filePath).toLowerCase() === '.pdf' && await pathExists(filePath) && !metadata.pdf_sha256) {
    const fingerprint = await getPdfFingerprintAsync(filePath)
    updateMetadata(docId, {
      pdf_sha256: fingerprint.sha256,
      pdf_size_bytes: fingerprint.sizeBytes,
      pdf_page_count: doc.page_count || undefined,
      original_file_name: basename(filePath),
    })
  }
  const pathsToDelete = new Set<string>()
  const addPath = async (value?: string | null) => {
    if (!value) return
    const normalizedPath = normalize(resolveManagedStoragePath(value, docId))
    if (isPathInsideDirectory(normalizedPath, storageDir) && await pathExists(normalizedPath)) {
      pathsToDelete.add(normalizedPath)
    }
  }

  await addPath(doc.file_path)
  await addPath(doc.thumb_path)
  for (const page of queryAll<{ image_path: string | null }>('SELECT image_path FROM pages WHERE doc_id = ?', [docId])) {
    await addPath(page.image_path)
  }

  for (const filePath of pathsToDelete) {
    try {
      const stats = await stat(filePath)
      if (stats.isFile()) {
        bytesFreed += stats.size
        await rm(filePath, { force: true })
      }
    } catch {
      // Ignore files that disappeared while cleanup was running.
    }
    await yieldToEventLoop()
  }

  run('UPDATE pages SET image_path = NULL WHERE doc_id = ?', [docId])
  run('UPDATE documents SET file_path = NULL, thumb_path = NULL, updated_at = ? WHERE id = ?', [new Date().toISOString(), docId])
  updateMetadata(docId, {
    pdf_asset_state: 'text_only' as PdfAssetState,
    pdf_asset_deleted_at: new Date().toISOString(),
    preserved_content_image_count: preservedImageCount,
  })
  scheduleDatabaseSave()
  return { cleaned: true, bytesFreed }
}

export function cleanupCompletedPdfAssets(): CompletedPdfAssetCleanupResult {
  const docs = queryAll<DocumentRow>(`
    SELECT id, title, file_path, thumb_path, page_count, metadata
    FROM documents
    WHERE ocr_status = 'completed'
      AND (LOWER(COALESCE(file_path, '')) LIKE '%.pdf' OR json_extract(metadata, '$.pdf_asset_state') = 'available')
  `)
  let cleanedCount = 0
  let bytesFreed = 0
  for (const doc of docs) {
    const result = cleanupPdfAssets(doc.id)
    if (result.cleaned) {
      cleanedCount += 1
      bytesFreed += result.bytesFreed
    }
  }
  return { cleanedCount, bytesFreed }
}

export async function cleanupCompletedPdfAssetsAsync(): Promise<CompletedPdfAssetCleanupResult> {
  const docs = queryAll<DocumentRow>(`
    SELECT id, title, file_path, thumb_path, page_count, metadata
    FROM documents
    WHERE ocr_status = 'completed'
      AND (LOWER(COALESCE(file_path, '')) LIKE '%.pdf' OR json_extract(metadata, '$.pdf_asset_state') = 'available')
  `)
  let cleanedCount = 0
  let bytesFreed = 0
  for (const doc of docs) {
    const result = await cleanupPdfAssetsAsync(doc.id)
    if (result.cleaned) {
      cleanedCount += 1
      bytesFreed += result.bytesFreed
    }
    await yieldToEventLoop()
  }
  return { cleanedCount, bytesFreed }
}

export function autoCleanupPdfAssetsIfEnabled(docId: string): void {
  const setting = queryOne<{ value: string | null }>("SELECT value FROM settings WHERE key = 'auto_delete_pdf_assets_after_ocr'")
  if (setting?.value !== 'true') return
  const doc = queryOne<{ file_path: string | null; ocr_status: string; metadata: string | null }>('SELECT file_path, ocr_status, metadata FROM documents WHERE id = ?', [docId])
  if (!doc || doc.ocr_status !== 'completed') return
  if (!doc.file_path || extname(doc.file_path).toLowerCase() !== '.pdf') return
  if (activeAutoCleanupPdfAssetDocIds.has(docId)) return
  activeAutoCleanupPdfAssetDocIds.add(docId)
  let job: Promise<void>
  job = new Promise<void>((resolve) => setImmediate(resolve))
    .then(async () => {
      await cleanupPdfAssetsAsync(docId)
    })
    .catch((error) => {
      console.warn('[PDF Assets] Auto cleanup after OCR failed', docId, error)
    })
    .finally(() => {
      activeAutoCleanupPdfAssetDocIds.delete(docId)
      activeAutoCleanupPdfAssetJobs.delete(job)
    })
  activeAutoCleanupPdfAssetJobs.add(job)
}

export async function shutdownPdfAssetRuntime(timeoutMs = 3000): Promise<void> {
  if (activeAutoCleanupPdfAssetJobs.size === 0) return
  await Promise.race([
    Promise.allSettled([...activeAutoCleanupPdfAssetJobs]).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

export function restorePdfAssetForDocument(docId: string, manualPath?: string): PdfAssetRestoreResult {
  const doc = queryOne<DocumentRow>('SELECT id, title, file_path, thumb_path, page_count, metadata FROM documents WHERE id = ?', [docId])
  if (!doc) return { restored: false, error: '文献不存在' }
  const existingPdfPath = resolveManagedStoragePath(doc.file_path, docId)
  if (!manualPath && existingPdfPath && existsSync(existingPdfPath)) {
    if (existingPdfPath !== doc.file_path) {
      run('UPDATE documents SET file_path = ?, updated_at = ? WHERE id = ?', [existingPdfPath, new Date().toISOString(), docId])
    }
    updateMetadata(docId, { pdf_asset_state: 'available' as PdfAssetState })
    scheduleDatabaseSave()
    return { restored: true, path: existingPdfPath }
  }

  const metadata = parseMetadata(doc.metadata)
  const targetHash = String(metadata.pdf_sha256 || '')
  let sourcePath = manualPath || ''

  if (sourcePath) {
    if (!existsSync(sourcePath) || extname(sourcePath).toLowerCase() !== '.pdf') {
      return { restored: false, error: '请选择有效的 PDF 文件' }
    }
    const fingerprint = getPdfFingerprint(sourcePath)
    if (targetHash && fingerprint.sha256 !== targetHash) {
      return { restored: false, error: '选择的 PDF 与该文献原始文件内容不一致' }
    }
    if (!targetHash) {
      metadata.pdf_sha256 = fingerprint.sha256
      metadata.pdf_size_bytes = fingerprint.sizeBytes
    }
  } else {
    if (!targetHash) {
      return { restored: false, error: '该文献缺少 PDF 指纹，请手动选择 PDF 补回' }
    }
    indexPdfRepositories(readRepositoryPaths())
    const match = queryOne<{ path: string }>('SELECT path FROM pdf_repository_index WHERE sha256 = ? ORDER BY indexed_at DESC LIMIT 1', [targetHash])
    if (!match?.path || !existsSync(match.path)) {
      return { restored: false, error: '未在 PDF 原件仓库找到同内容 PDF' }
    }
    sourcePath = match.path
  }

  const storageDir = join(getDataDir(), 'storage', docId)
  mkdirSync(storageDir, { recursive: true })
  const sourceFingerprint = getPdfFingerprint(sourcePath)
  const originalFingerprint = {
    sha256: targetHash || sourceFingerprint.sha256,
    sizeBytes: Number(metadata.pdf_size_bytes || metadata.pdf_original_size_bytes || sourceFingerprint.sizeBytes),
    mtimeMs: Number(metadata.pdf_mtime_ms || sourceFingerprint.mtimeMs),
  }
  const stored = storePdfWithCompressionSync(sourcePath, storageDir, originalFingerprint)
  const nextMetadata: DocumentMetadataResult = {
    ...metadata,
    ...buildPdfCompressionMetadata(basename(sourcePath), originalFingerprint, stored.storedFingerprint, stored.compression),
    pdf_asset_state: 'available' as PdfAssetState,
    pdf_asset_deleted_at: null,
    restored_from_repository_at: new Date().toISOString(),
    restored_source_name: basename(sourcePath),
  }
  if (!nextMetadata.pdf_sha256) {
    nextMetadata.pdf_sha256 = originalFingerprint.sha256
  }

  run('UPDATE documents SET file_path = ?, metadata = ?, updated_at = ? WHERE id = ?', [
    stored.storedPath,
    JSON.stringify(nextMetadata),
    new Date().toISOString(),
    docId,
  ])
  scheduleDatabaseSave()
  return { restored: true, path: stored.storedPath, pdfCompression: stored.compression }
}

export async function restorePdfAssetForDocumentAsync(docId: string, manualPath?: string, knownSourceFingerprint?: PdfFingerprint): Promise<PdfAssetRestoreResult> {
  const doc = queryOne<DocumentRow>('SELECT id, title, file_path, thumb_path, page_count, metadata FROM documents WHERE id = ?', [docId])
  if (!doc) return { restored: false, error: '文献不存在' }
  const existingPdfPath = resolveManagedStoragePath(doc.file_path, docId)
  if (!manualPath && existingPdfPath && await pathExists(existingPdfPath)) {
    if (existingPdfPath !== doc.file_path) {
      run('UPDATE documents SET file_path = ?, updated_at = ? WHERE id = ?', [existingPdfPath, new Date().toISOString(), docId])
    }
    updateMetadata(docId, { pdf_asset_state: 'available' as PdfAssetState })
    scheduleDatabaseSave()
    return { restored: true, path: existingPdfPath }
  }

  const metadata = parseMetadata(doc.metadata)
  const targetHash = String(metadata.pdf_sha256 || '')
  let sourcePath = manualPath || ''
  let sourceFingerprint: PdfFingerprint | null = null

  if (sourcePath) {
    if (!(await pathExists(sourcePath)) || extname(sourcePath).toLowerCase() !== '.pdf') {
      return { restored: false, error: '请选择有效的 PDF 文件' }
    }
    sourceFingerprint = knownSourceFingerprint || await getPdfFingerprintAsync(sourcePath)
    if (targetHash && sourceFingerprint.sha256 !== targetHash) {
      return { restored: false, error: '选择的 PDF 与该文献原始文件内容不一致' }
    }
    if (!targetHash) {
      metadata.pdf_sha256 = sourceFingerprint.sha256
      metadata.pdf_size_bytes = sourceFingerprint.sizeBytes
    }
  } else {
    if (!targetHash) {
      return { restored: false, error: '该文献缺少 PDF 指纹，请手动选择 PDF 补回' }
    }
    await indexPdfRepositoriesAsync(readRepositoryPaths())
    const match = queryOne<{ path: string }>('SELECT path FROM pdf_repository_index WHERE sha256 = ? ORDER BY indexed_at DESC LIMIT 1', [targetHash])
    if (!match?.path || !(await pathExists(match.path))) {
      return { restored: false, error: '未在 PDF 原件仓库找到同内容 PDF' }
    }
    sourcePath = match.path
  }

  const storageDir = join(getDataDir(), 'storage', docId)
  await mkdir(storageDir, { recursive: true })
  const finalSourceFingerprint = sourceFingerprint || await getPdfFingerprintAsync(sourcePath)
  const originalFingerprint = {
    sha256: targetHash || finalSourceFingerprint.sha256,
    sizeBytes: Number(metadata.pdf_size_bytes || metadata.pdf_original_size_bytes || finalSourceFingerprint.sizeBytes),
    mtimeMs: Number(metadata.pdf_mtime_ms || finalSourceFingerprint.mtimeMs),
  }
  const stored = await storePdfWithCompression(sourcePath, storageDir, originalFingerprint)
  const nextMetadata: DocumentMetadataResult = {
    ...metadata,
    ...buildPdfCompressionMetadata(basename(sourcePath), originalFingerprint, stored.storedFingerprint, stored.compression),
    pdf_asset_state: 'available' as PdfAssetState,
    pdf_asset_deleted_at: null,
    restored_from_repository_at: new Date().toISOString(),
    restored_source_name: basename(sourcePath),
  }
  if (!nextMetadata.pdf_sha256) {
    nextMetadata.pdf_sha256 = originalFingerprint.sha256
  }

  run('UPDATE documents SET file_path = ?, metadata = ?, updated_at = ? WHERE id = ?', [
    stored.storedPath,
    JSON.stringify(nextMetadata),
    new Date().toISOString(),
    docId,
  ])
  scheduleDatabaseSave()
  return { restored: true, path: stored.storedPath, pdfCompression: stored.compression }
}
