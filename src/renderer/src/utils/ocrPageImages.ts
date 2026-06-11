import type { DocumentDetail, DocumentListItem, DocumentPage, OcrEngine } from '@shared/types'
import { getErrorMessage } from '@shared/errors'
import { getPdfFileInfo, renderPdfFilePageToImage } from './pdf'

const VISION_PAGE_IMAGE_PREP_MAX_CONCURRENCY = 4
const PAGE_IMAGE_READ_CHECK_CONCURRENCY = 12

type OcrPageImageDocument = Pick<DocumentListItem | DocumentDetail, 'id'> & Partial<Pick<DocumentListItem | DocumentDetail, 'file_path' | 'page_count' | 'title'>> & {
  pages?: Array<Partial<DocumentPage>>
}

interface EnsurePdfPageImagesForOcrOptions {
  engine?: OcrEngine | string
  fileIndex?: number
  totalFiles?: number
  getEngineLabel?: (engine: OcrEngine | string) => string
  messageKey?: string
  onProgress?: (content: string, messageKey?: string) => void
  onPageCached?: (pageNum: number, imagePath: string, dataUrl: string) => void | Promise<void>
  pageNums?: number[]
  sourceFilePath?: string | null
}

export interface EnsurePdfPageImagesForOcrResult {
  ready: boolean
  docId: string
  pageCount: number
  missingPageNums: number[]
  cachedPageNums: number[]
  filePath?: string
}

export async function runLimited<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Math.round(concurrency)))
  let nextIndex = 0
  const workers = Array.from({ length: safeConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      await worker(items[currentIndex], currentIndex)
    }
  })
  await Promise.all(workers)
}

export async function isReadablePageImagePath(imagePath: unknown): Promise<boolean> {
  const normalizedPath = typeof imagePath === 'string' ? imagePath.trim() : ''
  if (!normalizedPath) return false
  try {
    await window.api.readImageAsDataURL(normalizedPath)
    return true
  } catch {
    return false
  }
}

function normalizePageNums(values: Array<number | string | null | undefined>): number[] {
  return Array.from(new Set(
    values
      .map((value) => Math.round(Number(value || 0)))
      .filter((value) => Number.isFinite(value) && value > 0),
  )).sort((left, right) => left - right)
}

function getDocumentPageNums(detail: OcrPageImageDocument | DocumentDetail | null | undefined, fallbackPageCount = 0): number[] {
  const pageCount = Math.max(0, Math.round(Number(detail?.page_count || fallbackPageCount || 0)))
  if (pageCount > 0) return Array.from({ length: pageCount }, (_item, index) => index + 1)
  return normalizePageNums((detail?.pages || []).map((page) => page.page_num))
}

export async function getMissingReadablePageImageNums(
  detail: Pick<DocumentDetail, 'pages'> | OcrPageImageDocument,
  pageNums: number[],
): Promise<number[]> {
  const pagesByNum = new Map(
    (detail.pages || [])
      .map((page) => [Number(page.page_num || 0), page] as const)
      .filter(([pageNum]) => Number.isFinite(pageNum) && pageNum > 0),
  )
  const missing: number[] = []
  await runLimited(pageNums, PAGE_IMAGE_READ_CHECK_CONCURRENCY, async (pageNum) => {
    const page = pagesByNum.get(pageNum)
    if (!page || !(await isReadablePageImagePath(page.image_path))) missing.push(pageNum)
  })
  return missing.sort((left, right) => left - right)
}

function isPdfPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().toLowerCase().endsWith('.pdf')
}

async function restorePdfPath(docId: string, reason?: string): Promise<string> {
  const restored = await window.api.restorePdfForDocument(docId).catch((restoreError) => ({
    restored: false,
    error: getErrorMessage(restoreError, 'PDF 恢复失败'),
  }))
  const restoredPath = restored && 'path' in restored ? restored.path : undefined
  if (restored?.restored && isPdfPath(restoredPath)) return restoredPath

  const errorReason = restored?.error || reason || ''
  throw new Error(`当前文献缺少可读取页图，且无法从该文献 PDF 自动补齐。请确认该文献所在数据库包含 PDF/页图资源，或把原 PDF 加入“PDF 原件仓库”后重试。${errorReason ? `原因：${errorReason}` : ''}`)
}

async function resolveReadablePdfPath(
  docId: string,
  detail: OcrPageImageDocument | DocumentDetail | null | undefined,
  sourceFilePath?: string | null,
): Promise<{ filePath: string; pageCount: number }> {
  let filePath = isPdfPath(sourceFilePath)
    ? sourceFilePath.trim()
    : isPdfPath(detail?.file_path)
      ? String(detail?.file_path || '').trim()
      : ''

  if (!filePath) filePath = await restorePdfPath(docId)

  try {
    const info = await getPdfFileInfo(filePath)
    return { filePath, pageCount: Math.max(0, Math.round(Number(info.pageCount || 0))) }
  } catch (error) {
    const restoredPath = await restorePdfPath(docId, getErrorMessage(error, 'PDF 原文不可读取'))
    const info = await getPdfFileInfo(restoredPath)
    return { filePath: restoredPath, pageCount: Math.max(0, Math.round(Number(info.pageCount || 0))) }
  }
}

export async function ensurePdfPageImagesForOcr(
  docOrId: OcrPageImageDocument | DocumentDetail | string,
  options: EnsurePdfPageImagesForOcrOptions = {},
): Promise<EnsurePdfPageImagesForOcrResult> {
  const docId = typeof docOrId === 'string' ? docOrId : docOrId.id
  const baseDoc = typeof docOrId === 'string' ? null : docOrId
  const latestDoc = await window.api.getDocument(docId).catch(() => null)
  const detail = latestDoc || baseDoc
  const initialPageNums = options.pageNums?.length
    ? normalizePageNums(options.pageNums)
    : getDocumentPageNums(detail)

  if (initialPageNums.length > 0 && detail?.pages) {
    const initialMissingPageNums = await getMissingReadablePageImageNums(detail, initialPageNums)
    if (initialMissingPageNums.length === 0) {
      return {
        ready: true,
        docId,
        pageCount: Math.max(Number(detail.page_count || 0), initialPageNums.length),
        missingPageNums: [],
        cachedPageNums: [],
        filePath: isPdfPath(detail.file_path) ? detail.file_path : undefined,
      }
    }
  }

  const resolvedPdf = await resolveReadablePdfPath(docId, detail, options.sourceFilePath)
  const pageCount = Math.max(resolvedPdf.pageCount, Math.round(Number(detail?.page_count || 0)), ...initialPageNums)
  if (pageCount <= 0) {
    return { ready: true, docId, pageCount: 0, missingPageNums: [], cachedPageNums: [], filePath: resolvedPdf.filePath }
  }

  await window.api.initializePdfPages(docId, pageCount)
  const refreshedDoc = await window.api.getDocument(docId)
  const pageNums = options.pageNums?.length
    ? normalizePageNums(options.pageNums).filter((pageNum) => pageNum <= pageCount)
    : Array.from({ length: pageCount }, (_item, index) => index + 1)
  const missingPageNums = refreshedDoc ? await getMissingReadablePageImageNums(refreshedDoc, pageNums) : pageNums
  if (missingPageNums.length === 0) {
    return { ready: true, docId, pageCount, missingPageNums: [], cachedPageNums: [], filePath: resolvedPdf.filePath }
  }

  const engineLabel = options.engine && options.getEngineLabel ? options.getEngineLabel(options.engine) : options.engine ? String(options.engine) : 'OCR'
  const totalFiles = Math.max(1, Number(options.totalFiles || 1))
  const fileIndex = Math.max(0, Number(options.fileIndex || 0))
  const prepConcurrency = Math.min(VISION_PAGE_IMAGE_PREP_MAX_CONCURRENCY, Math.max(1, missingPageNums.length))
  const cachedPageNums: number[] = []

  await runLimited(missingPageNums, prepConcurrency, async (pageNum) => {
    const prefix = totalFiles > 1 ? `第 ${fileIndex + 1}/${totalFiles} 篇，` : ''
    const progress = `${cachedPageNums.length}/${missingPageNums.length}`
    const content = `正在补齐${engineLabel}页图：${prefix}${progress} 页（缺 ${missingPageNums.length}/${pageCount} 页，并发 ${prepConcurrency}）`
    options.onProgress?.(content, options.messageKey)
    const pageImage = await renderPdfFilePageToImage(resolvedPdf.filePath, pageNum)
    const imagePath = await window.api.cachePageImage(docId, pageNum, pageImage.dataUrl)
    cachedPageNums.push(pageNum)
    await options.onPageCached?.(pageNum, imagePath, pageImage.dataUrl)
    const nextContent = `正在补齐${engineLabel}页图：${prefix}${cachedPageNums.length}/${missingPageNums.length} 页（缺 ${missingPageNums.length}/${pageCount} 页，并发 ${prepConcurrency}）`
    options.onProgress?.(nextContent, options.messageKey)
  })

  await window.api.updateDocument(docId, { error_message: null })
  return {
    ready: true,
    docId,
    pageCount,
    missingPageNums,
    cachedPageNums: cachedPageNums.sort((left, right) => left - right),
    filePath: resolvedPdf.filePath,
  }
}
