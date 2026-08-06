import { randomUUID } from 'crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { readFile } from 'fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import type {
  ManualPageImageAsset,
  ManualPageImageCrop,
} from '../shared/types'
import { isStableManualLayoutBlockId } from '../shared/manual-layout'
export { isStableManualLayoutBlockId } from '../shared/manual-layout'
import { getPdfJsNodeDocumentOptions } from './pdfjs-assets'

export type ManualPageAssetErrorCode =
  | 'invalid-request'
  | 'invalid-crop'
  | 'source-unavailable'
  | 'source-outside-library'
  | 'managed-boundary'
  | 'decode-failed'
  | 'write-failed'

export class ManualPageAssetError extends Error {
  readonly code: ManualPageAssetErrorCode

  constructor(code: ManualPageAssetErrorCode, message: string) {
    super(`[manual-page-assets/${code}] ${message}`)
    this.name = 'ManualPageAssetError'
    this.code = code
  }
}

export interface ManualPageImageSize {
  width: number
  height: number
}

export interface ManualPagePixelCrop {
  x: number
  y: number
  width: number
  height: number
}

export interface ManualPageDecodedImage {
  isEmpty: () => boolean
  getSize: () => ManualPageImageSize
}

export function assertDecodedManualPageImage(image: ManualPageDecodedImage): ManualPageImageSize {
  if (!image || image.isEmpty()) throw new ManualPageAssetError('decode-failed', '图片解码失败')
  const size = image.getSize()
  const width = Math.round(finitePositive(size?.width))
  const height = Math.round(finitePositive(size?.height))
  if (!width || !height || width * height > MAX_CROP_PIXELS) {
    throw new ManualPageAssetError('decode-failed', '图片尺寸无效或过大')
  }
  return { width, height }
}

export interface ManualPageAssetCommitOperations {
  writeTemp: (tempPath: string, bytes: Uint8Array) => void
  getTempSize: (tempPath: string) => number
  renameTemp: (tempPath: string, targetPath: string) => void
  removeTemp: (tempPath: string) => void
}

export function commitManualPageAssetFile(input: {
  tempPath: string
  targetPath: string
  pngBytes: Uint8Array
  operations: ManualPageAssetCommitOperations
}): void {
  try {
    input.operations.writeTemp(input.tempPath, input.pngBytes)
    if (input.operations.getTempSize(input.tempPath) <= 0) {
      throw new ManualPageAssetError('write-failed', '临时资源写入失败')
    }
    input.operations.renameTemp(input.tempPath, input.targetPath)
  } catch (error) {
    try {
      input.operations.removeTemp(input.tempPath)
    } catch {
      // Cleanup is best effort; the previous committed target is never removed here.
    }
    if (error instanceof ManualPageAssetError) throw error
    throw new ManualPageAssetError('write-failed', String((error as Error)?.message || error || '资源写入失败'))
  }
}

export interface ManualPageAssetOwnershipInput {
  pageId: string
  docId: string
  activeProjectId: string
  ownsDocument: (docId: string, projectId: string) => boolean
}

export function assertManualPageAssetOwnership(input: ManualPageAssetOwnershipInput): void {
  const pageId = String(input?.pageId || '').trim()
  const docId = String(input?.docId || '').trim()
  const projectId = String(input?.activeProjectId || '').trim()
  if (!pageId || !docId || !projectId || pageId.length > 220 || docId.length > 180 || projectId.length > 220) {
    throw new ManualPageAssetError('invalid-request', '页面或项目标识无效')
  }
  if (!input.ownsDocument(docId, projectId)) {
    throw new ManualPageAssetError('invalid-request', '页面不属于当前项目')
  }
}

export function assertStableManualPageBlockId(pageId: string, blockId: string): string {
  const normalized = String(blockId || '').trim()
  if (!isStableManualLayoutBlockId(pageId, normalized)) {
    throw new ManualPageAssetError('invalid-request', 'blockId 不是当前页面的稳定人工区块 ID')
  }
  return normalized
}

export async function selectManualPageAssetOnly<T>(input: {
  selectSource: () => Promise<string | null>
  copySource: (sourcePath: string) => Promise<T>
}): Promise<T | null> {
  const sourcePath = await input.selectSource()
  if (!sourcePath) return null
  return input.copySource(sourcePath)
}

type PdfJsPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  render: (options: Record<string, unknown>) => { promise: Promise<void> }
  cleanup?: () => void
}

type PdfJsDocument = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfJsPage>
  destroy?: () => Promise<void> | void
}

type PdfJsModule = {
  getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfJsDocument> }
  AnnotationMode?: { DISABLE?: number }
}

type CanvasLike = {
  getContext: (context: '2d') => Record<string, unknown>
  toBuffer: (mime: 'image/png') => Buffer
}

type CanvasModule = {
  createCanvas: (width: number, height: number) => CanvasLike
}

const MAX_CROP_PIXELS = 120_000_000
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,180}$/
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'])

function assertSafeSegment(value: string, label: string): string {
  const normalized = String(value || '').trim()
  if (!SAFE_SEGMENT.test(normalized) || normalized === '.' || normalized === '..') {
    throw new ManualPageAssetError('invalid-request', `${label} 无效`)
  }
  return normalized
}

function finitePositive(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

export function validateManualPageImageCrop(
  crop: ManualPageImageCrop,
  sourceSize: ManualPageImageSize,
): ManualPageImageCrop {
  const values = [crop?.left, crop?.top, crop?.width, crop?.height]
  if (!values.every((value) => Number.isFinite(Number(value)))) {
    throw new ManualPageAssetError('invalid-crop', '裁剪坐标必须是有限数字')
  }
  const normalized = {
    left: Number(crop.left),
    top: Number(crop.top),
    width: Number(crop.width),
    height: Number(crop.height),
  }
  const sourceWidth = finitePositive(sourceSize?.width)
  const sourceHeight = finitePositive(sourceSize?.height)
  if (!sourceWidth || !sourceHeight) {
    throw new ManualPageAssetError('invalid-crop', '原图尺寸无效')
  }
  if (normalized.left < 0 || normalized.top < 0 || normalized.width <= 0 || normalized.height <= 0) {
    throw new ManualPageAssetError('invalid-crop', '裁剪区域必须位于原图内且宽高大于零')
  }
  const epsilon = 0.001
  if (normalized.left + normalized.width > sourceWidth + epsilon
    || normalized.top + normalized.height > sourceHeight + epsilon) {
    throw new ManualPageAssetError('invalid-crop', '裁剪区域超出原图边界')
  }
  if (normalized.width * normalized.height > MAX_CROP_PIXELS) {
    throw new ManualPageAssetError('invalid-crop', '裁剪区域过大')
  }
  return normalized
}

export function toManualPagePixelCrop(
  crop: ManualPageImageCrop,
  coordinateSize: ManualPageImageSize,
  imageSize: ManualPageImageSize,
): ManualPagePixelCrop {
  const normalized = validateManualPageImageCrop(crop, coordinateSize)
  const imageWidth = Math.max(1, Math.round(finitePositive(imageSize?.width)))
  const imageHeight = Math.max(1, Math.round(finitePositive(imageSize?.height)))
  const scaleX = imageWidth / coordinateSize.width
  const scaleY = imageHeight / coordinateSize.height
  const x = Math.max(0, Math.min(imageWidth - 1, Math.round(normalized.left * scaleX)))
  const y = Math.max(0, Math.min(imageHeight - 1, Math.round(normalized.top * scaleY)))
  const right = Math.max(x + 1, Math.min(imageWidth, Math.round((normalized.left + normalized.width) * scaleX)))
  const bottom = Math.max(y + 1, Math.min(imageHeight, Math.round((normalized.top + normalized.height) * scaleY)))
  const pixelCrop = { x, y, width: right - x, height: bottom - y }
  if (pixelCrop.width * pixelCrop.height > MAX_CROP_PIXELS) {
    throw new ManualPageAssetError('invalid-crop', '裁剪后的像素区域过大')
  }
  return pixelCrop
}

export function getManualPageCoordinateSize(
  ocrResult: unknown,
  imageSize: ManualPageImageSize,
): ManualPageImageSize {
  const root = typeof ocrResult === 'object' && ocrResult !== null && !Array.isArray(ocrResult)
    ? ocrResult as Record<string, unknown>
    : {}
  const processing = typeof root.guji_processing === 'object' && root.guji_processing !== null
    ? root.guji_processing as Record<string, unknown>
    : {}
  const candidates = [
    [processing.source_image_width, processing.source_image_height],
    [root.source_image_width, root.source_image_height],
    [root.image_width, root.image_height],
    [root.page_width, root.page_height],
    [root.width, root.height],
  ]
  for (const [width, height] of candidates) {
    const nextWidth = finitePositive(width)
    const nextHeight = finitePositive(height)
    if (nextWidth && nextHeight) return { width: nextWidth, height: nextHeight }
  }
  return {
    width: Math.max(1, Math.round(finitePositive(imageSize.width))),
    height: Math.max(1, Math.round(finitePositive(imageSize.height))),
  }
}

export function assertContainedPath(candidatePath: string, rootPath: string): boolean {
  const candidate = resolve(String(candidatePath || ''))
  const root = resolve(String(rootPath || ''))
  if (!candidate || !root) return false
  const relativePath = relative(root, candidate)
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

function canonicalRegularFile(filePath: string): string | null {
  try {
    const initial = lstatSync(filePath)
    if (initial.isSymbolicLink() || !initial.isFile()) return null
    const canonical = realpathSync(filePath)
    const final = statSync(canonical)
    return final.isFile() && final.size > 0 ? canonical : null
  } catch {
    return null
  }
}

function canonicalDirectory(dirPath: string): string | null {
  try {
    const initial = lstatSync(dirPath)
    if (initial.isSymbolicLink() || !initial.isDirectory()) return null
    const canonical = realpathSync(dirPath)
    const final = statSync(canonical)
    return final.isDirectory() ? canonical : null
  } catch {
    return null
  }
}

export function resolveRepositoryImageSource(
  sourcePath: string,
  repositoryRoots: readonly string[],
  options?: { allowPdf?: boolean },
): string | null {
  const canonicalSource = canonicalRegularFile(String(sourcePath || '').trim())
  if (!canonicalSource) return null
  const extension = extname(canonicalSource).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(extension) && !(options?.allowPdf && extension === '.pdf')) return null
  for (const repositoryRoot of repositoryRoots) {
    const canonicalRoot = canonicalDirectory(String(repositoryRoot || '').trim())
    if (canonicalRoot && assertContainedPath(canonicalSource, canonicalRoot)) return canonicalSource
  }
  return null
}

export function resolveManagedManualPageSource(
  sourcePath: string,
  documentRoot: string,
  options?: { allowPdf?: boolean },
): string | null {
  const canonicalSource = canonicalRegularFile(String(sourcePath || '').trim())
  const canonicalRoot = canonicalDirectory(String(documentRoot || '').trim())
  if (!canonicalSource || !canonicalRoot || !assertContainedPath(canonicalSource, canonicalRoot)) return null
  const extension = extname(canonicalSource).toLowerCase()
  return IMAGE_EXTENSIONS.has(extension) || (options?.allowPdf && extension === '.pdf') ? canonicalSource : null
}

export function buildManualPageAssetPath(
  dataDir: string,
  docId: string,
  pageId: string,
  blockId: string,
  revision: number,
): string {
  const safeDocId = assertSafeSegment(docId, 'documentId')
  const safePageId = assertSafeSegment(pageId, 'pageId')
  const safeBlockId = assertSafeSegment(blockId, 'blockId')
  const safeRevision = Math.floor(Number(revision))
  if (!Number.isSafeInteger(safeRevision) || safeRevision < 1) {
    throw new ManualPageAssetError('invalid-request', 'revision 无效')
  }
  const storageRoot = resolve(dataDir, 'storage')
  const target = resolve(storageRoot, safeDocId, 'page-assets', safePageId, safeBlockId, `${safeRevision}.png`)
  if (!assertContainedPath(target, storageRoot)) {
    throw new ManualPageAssetError('managed-boundary', '受管资源路径越界')
  }
  return target
}

export function buildManualPageSelectedAssetPath(
  dataDir: string,
  docId: string,
  pageId: string,
  revision: number,
): string {
  return buildManualPageAssetPath(dataDir, docId, pageId, 'selected', revision)
}

function prepareManagedAssetTarget(targetPath: string, documentRoot: string): string {
  const absoluteDocumentRoot = resolve(documentRoot)
  const storageRoot = dirname(absoluteDocumentRoot)
  const canonicalStorageRoot = canonicalDirectory(storageRoot)
  if (!canonicalStorageRoot) {
    throw new ManualPageAssetError('managed-boundary', '受管 storage 目录不存在或不安全')
  }
  if (!existsSync(absoluteDocumentRoot)) mkdirSync(absoluteDocumentRoot)
  const canonicalDocumentRoot = canonicalDirectory(absoluteDocumentRoot)
  if (!canonicalDocumentRoot || !assertContainedPath(canonicalDocumentRoot, canonicalStorageRoot)) {
    throw new ManualPageAssetError('managed-boundary', '文献受管目录不存在或已越界')
  }
  const absoluteTarget = resolve(targetPath)
  if (!assertContainedPath(absoluteTarget, canonicalDocumentRoot)) {
    throw new ManualPageAssetError('managed-boundary', '受管图片写入路径越界')
  }
  const relativeDir = relative(canonicalDocumentRoot, dirname(absoluteTarget))
  let current = canonicalDocumentRoot
  for (const segment of relativeDir.split(/[\\/]+/).filter(Boolean)) {
    if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new ManualPageAssetError('managed-boundary', '受管图片目录名无效')
    }
    current = join(current, segment)
    if (!existsSync(current)) mkdirSync(current)
    const canonicalCurrent = canonicalDirectory(current)
    if (!canonicalCurrent || !assertContainedPath(canonicalCurrent, canonicalDocumentRoot)) {
      throw new ManualPageAssetError('managed-boundary', '受管图片目录包含符号链接或越界路径')
    }
    current = canonicalCurrent
  }
  if (existsSync(absoluteTarget)) {
    const targetInfo = lstatSync(absoluteTarget)
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw new ManualPageAssetError('managed-boundary', '受管图片目标不是普通文件')
    }
    const canonicalTarget = realpathSync(absoluteTarget)
    if (!assertContainedPath(canonicalTarget, canonicalDocumentRoot)) {
      throw new ManualPageAssetError('managed-boundary', '受管图片目标越界')
    }
  }
  return absoluteTarget
}

export function atomicWriteManualPageAsset(
  targetPath: string,
  pngBytes: Uint8Array,
  documentRoot: string,
): ManualPageImageAsset {
  if (!(pngBytes instanceof Uint8Array) || pngBytes.byteLength <= 0) {
    throw new ManualPageAssetError('write-failed', '没有可写入的 PNG 数据')
  }
  const safeTargetPath = prepareManagedAssetTarget(targetPath, documentRoot)
  const targetDir = dirname(safeTargetPath)
  const tempPath = join(targetDir, `.${randomUUID()}.tmp`)
  commitManualPageAssetFile({
    tempPath,
    targetPath: safeTargetPath,
    pngBytes,
    operations: {
      writeTemp: (path, bytes) => writeFileSync(path, bytes, { flag: 'wx' }),
      getTempSize: (path) => existsSync(path) ? statSync(path).size : 0,
      renameTemp: (source, target) => renameSync(source, target),
      removeTemp: (path) => rmSync(path, { force: true }),
    },
  })
  return { assetPath: safeTargetPath, width: 0, height: 0 }
}

export async function renderManualPdfPageToPng(
  pdfPath: string,
  pageNumber: number,
  scale = 2,
): Promise<Buffer> {
  const [pdfjs, canvasModule, sourceBytes] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJsModule>,
    import('@napi-rs/canvas') as unknown as Promise<CanvasModule>,
    readFile(pdfPath),
  ])
  const loadingTask = pdfjs.getDocument(getPdfJsNodeDocumentOptions({
    data: new Uint8Array(sourceBytes),
    disableWorker: true,
  }))
  const pdf = await loadingTask.promise
  try {
    const safePage = Math.floor(Number(pageNumber))
    if (!Number.isSafeInteger(safePage) || safePage < 1 || safePage > pdf.numPages) {
      throw new ManualPageAssetError('source-unavailable', 'PDF 页码无效')
    }
    const page = await pdf.getPage(safePage)
    try {
      const viewport = page.getViewport({ scale: Math.max(0.5, Math.min(4, Number(scale) || 2)) })
      const width = Math.max(1, Math.ceil(viewport.width))
      const height = Math.max(1, Math.ceil(viewport.height))
      if (width * height > MAX_CROP_PIXELS) {
        throw new ManualPageAssetError('source-unavailable', 'PDF 渲染页过大')
      }
      const canvas = canvasModule.createCanvas(width, height)
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        annotationMode: pdfjs.AnnotationMode?.DISABLE ?? 0,
        background: 'rgb(255,255,255)',
      }).promise
      return canvas.toBuffer('image/png')
    } finally {
      page.cleanup?.()
    }
  } finally {
    await pdf.destroy?.()
  }
}
