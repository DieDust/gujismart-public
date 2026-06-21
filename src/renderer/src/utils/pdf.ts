// PDF 处理工具
// 在渲染进程中使用 pdfjs-dist 将 PDF 转为图片

import * as pdfjsLib from 'pdfjs-dist'
import type { DocumentInitParameters, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'

// 设置 worker 的路径
// Vite 环境下可以使用 ?url 来获取资源路径
// 这里假设通过网络路径加载或者使用 electron-vite 的特定配置
// 临时将 worker 设为 null，或者直接引入 pdfjs-dist/build/pdf.worker.mjs
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

export interface PdfExtractResult {
  title: string
  pageCount: number
  images: string[] // base64 格式
}

export interface PdfPageImage {
  pageNum: number
  pageCount: number
  dataUrl: string
}

export interface PdfInfo {
  title: string
  pageCount: number
}

export interface PdfConvertOptions {
  scale?: number
  collectImages?: boolean
  onPage?: (page: PdfPageImage) => void | Promise<void>
}

interface CachedPdfDocument {
  promise: Promise<PDFDocumentProxy>
  lastUsed: number
}

type PdfLoadSource = Pick<DocumentInitParameters, 'data' | 'url'>

interface PdfMetadataInfo {
  Title?: unknown
}

const pdfDocumentCache = new Map<string, CachedPdfDocument>()
const MAX_CACHED_PDF_DOCUMENTS = 2

function normalizePdfFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string') {
    throw new Error('PDF 文件路径无效，请重新导入该文献。')
  }

  const normalized = filePath.trim()
  if (!normalized) {
    throw new Error('PDF 文件路径为空，请重新导入该文献。')
  }

  return normalized
}

async function readPdfFileBuffer(filePath: unknown): Promise<ArrayBuffer> {
  return window.api.readFileBuffer(normalizePdfFilePath(filePath))
}

function buildPdfLoadParams(source: PdfLoadSource): DocumentInitParameters {
  return {
    ...source,
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/'
  }
}

function toLocalResourceUrl(filePath: unknown): string {
  const normalized = normalizePdfFilePath(filePath).replace(/\\/g, '/')
  const pathname = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encodedPathname = encodeURI(pathname).replace(/#/g, '%23').replace(/\?/g, '%3F')
  return `local-resource://${encodedPathname}`
}

function normalizePdfCacheKey(filePath: unknown): string {
  return normalizePdfFilePath(filePath)
}

async function getCachedPdfDocument(filePath: unknown): Promise<PDFDocumentProxy> {
  const cacheKey = normalizePdfCacheKey(filePath)
  const cached = pdfDocumentCache.get(cacheKey)
  if (cached) {
    cached.lastUsed = Date.now()
    return cached.promise
  }

  const loadingTask = pdfjsLib.getDocument(buildPdfLoadParams({ url: toLocalResourceUrl(cacheKey) }))
  const promise = withTimeout(loadingTask.promise, 30000, 'PDF 页面加载超时，请确认文件未损坏后重试。')

  pdfDocumentCache.set(cacheKey, { promise, lastUsed: Date.now() })

  if (pdfDocumentCache.size > MAX_CACHED_PDF_DOCUMENTS) {
    const staleEntries = [...pdfDocumentCache.entries()]
      .filter(([key]) => key !== cacheKey)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)

    for (const [key, entry] of staleEntries.slice(0, pdfDocumentCache.size - MAX_CACHED_PDF_DOCUMENTS)) {
      pdfDocumentCache.delete(key)
      void entry.promise.then((pdf) => pdf?.destroy?.()).catch(() => undefined)
    }
  }

  return promise
}

export function releaseCachedPdfDocument(filePath: unknown): void {
  try {
    const cacheKey = normalizePdfCacheKey(filePath)
    const entry = pdfDocumentCache.get(cacheKey)
    if (!entry) return
    pdfDocumentCache.delete(cacheKey)
    void entry.promise.then((pdf) => pdf?.destroy?.()).catch(() => undefined)
  } catch {
    // Ignore invalid paths during cleanup.
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer)
  })
}

function getPdfMetadataTitle(metadata: Awaited<ReturnType<PDFDocumentProxy['getMetadata']>>): string | null {
  const info = metadata.info as PdfMetadataInfo | null
  const title = info?.Title
  return typeof title === 'string' && title.trim() ? title : null
}

/**
 * 将 PDF 文件转换为 Base64 图片数组
 * @param fileBuffer PDF 文件的 ArrayBuffer
 * @param scale 渲染缩放比例，影响清晰度
 */
export async function convertPdfToImages(fileBuffer: ArrayBuffer, scaleOrOptions: number | PdfConvertOptions = 2.0): Promise<PdfExtractResult> {
  return convertPdfSourceToImages({ data: fileBuffer }, scaleOrOptions)
}

export async function convertPdfFileToImages(filePath: unknown, scaleOrOptions: number | PdfConvertOptions = 2.0): Promise<PdfExtractResult> {
  return convertPdfSourceToImages({ url: toLocalResourceUrl(filePath) }, scaleOrOptions)
}

export async function getPdfFileInfo(filePath: unknown): Promise<PdfInfo> {
  const normalizedPath = normalizePdfFilePath(filePath)
  const info = await window.api.getPdfInfo(normalizedPath)
  return {
    title: info.title || '未命名文档',
    pageCount: info.pageCount,
  }
}

export async function renderPdfFilePageToImage(filePath: unknown, pageNum: number, scale = 2.0): Promise<PdfPageImage> {
  const pdf = await getCachedPdfDocument(filePath)
  const safePageNum = Math.max(1, Math.min(pdf.numPages, Math.round(pageNum)))
  const page = await pdf.getPage(safePageNum)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 Canvas 2D Context')

  canvas.height = viewport.height
  canvas.width = viewport.width
  await withTimeout(page.render({ canvasContext: ctx, viewport }).promise, 30000, 'PDF 首页预览生成超时，稍后可再次重试。')
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
  canvas.width = 1
  canvas.height = 1
  page.cleanup()

  return {
    pageNum: safePageNum,
    pageCount: pdf.numPages,
    dataUrl
  }
}

async function convertPdfSourceToImages(source: PdfLoadSource, scaleOrOptions: number | PdfConvertOptions = 2.0): Promise<PdfExtractResult> {
  const options: PdfConvertOptions = typeof scaleOrOptions === 'number'
    ? { scale: scaleOrOptions, collectImages: true }
    : { collectImages: true, ...scaleOrOptions }
  const scale = options.scale ?? 2.0
  const loadingTask = pdfjsLib.getDocument(buildPdfLoadParams(source))
  const pdf = await withTimeout(loadingTask.promise, 30000, 'PDF 页面加载超时，请确认文件未损坏后重试。')
  
  const pageCount = pdf.numPages
  const images: string[] = []

  // 获取 PDF 元数据（标题等）
  let title = '未命名文档'
  try {
    const metadata = await pdf.getMetadata()
    title = getPdfMetadataTitle(metadata) ?? title
  } catch (e) {
    console.warn('获取 PDF 元数据失败', e)
  }

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale })

    // 创建离屏 canvas
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建 Canvas 2D Context')

    canvas.height = viewport.height
    canvas.width = viewport.width

    const renderContext = {
      canvasContext: ctx,
      viewport: viewport
    }

    await withTimeout(page.render(renderContext).promise, 30000, 'PDF 页面渲染超时，请确认文件未损坏后重试。')
    
    // 转换为 JPEG Base64
    const base64 = canvas.toDataURL('image/jpeg', 0.8)
    if (options.collectImages !== false) {
      images.push(base64)
    }
    await options.onPage?.({ pageNum, pageCount, dataUrl: base64 })
    canvas.width = 1
    canvas.height = 1
    page.cleanup()
  }

  return {
    title,
    pageCount,
    images
  }
}
