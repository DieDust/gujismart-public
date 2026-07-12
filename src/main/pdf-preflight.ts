import { stat } from 'fs/promises'
import { readFile } from 'fs/promises'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { getPdfJsNodeDocumentOptions } from './pdfjs-assets'
import type { OcrRecognizeLayoutBlock, PdfTextLayerAnalysis, PdfTextLayerPageAnalysis } from '../shared/types'

interface PdfTextItem {
  str: string
  transform: number[]
  width?: number
  height?: number
  fontName?: string
  hasEOL?: boolean
}

interface PositionedTextItem {
  text: string
  left: number
  top: number
  width: number
  height: number
  hasEOL: boolean
}

interface CachedPdfPreflight {
  signature: string
  analysis: PdfTextLayerAnalysis
}

const MAX_PREFLIGHT_CACHE_ENTRIES = 8
const preflightCache = new Map<string, CachedPdfPreflight>()

function isTextItem(value: unknown): value is PdfTextItem {
  if (typeof value !== 'object' || value === null || !('str' in value) || !('transform' in value)) return false
  const item = value as { str?: unknown; transform?: unknown }
  return typeof item.str === 'string' && Array.isArray(item.transform) && item.transform.length >= 6
}

function samplePageNumbers(pageCount: number, maxSamples: number): number[] {
  const count = Math.max(1, Math.min(pageCount, Math.floor(maxSamples)))
  if (count >= pageCount) return Array.from({ length: pageCount }, (_item, index) => index + 1)
  const pages = new Set<number>()
  for (let index = 0; index < count; index += 1) {
    pages.add(Math.max(1, Math.min(pageCount, Math.round(1 + index * (pageCount - 1) / Math.max(1, count - 1)))))
  }
  return [...pages].sort((left, right) => left - right)
}

function invalidUnicodeRatio(text: string): number {
  if (!text) return 0
  let invalid = 0
  const characters = [...text]
  for (const char of characters) {
    const code = char.codePointAt(0) || 0
    if (
      char === '\uFFFD'
      || (code >= 0xE000 && code <= 0xF8FF)
      || (code < 0x20 && !/[\n\r\t]/.test(char))
    ) {
      invalid += 1
    }
  }
  return invalid / Math.max(1, characters.length)
}

function replacementCharacterRatio(text: string): number {
  if (!text) return 0
  const characters = [...text]
  const replacementCount = characters.filter((char) => char === '\uFFFD' || char === '□').length
  return replacementCount / Math.max(1, characters.length)
}

function cleanCharacterCount(text: string): number {
  return [...text].filter((char) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(char) && char !== '\uFFFD').length
}

function hasSuspiciousPunctuationRun(text: string): boolean {
  return /([^\p{L}\p{N}\s])\1{7,}/u.test(text)
}

function joinLineItems(items: PositionedTextItem[]): string {
  let text = ''
  let previous: PositionedTextItem | null = null
  for (const item of items) {
    if (previous) {
      const previousRight = previous.left + previous.width
      const gap = item.left - previousRight
      const averageHeight = Math.max(1, (previous.height + item.height) / 2)
      if (gap > averageHeight * 0.28 && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(item.text)) text += ' '
    }
    text += item.text
    previous = item
  }
  return text.trim()
}

function splitLineAtColumnGaps(items: PositionedTextItem[], pageWidth: number): PositionedTextItem[][] {
  const sorted = [...items].sort((left, right) => left.left - right.left)
  if (sorted.length < 2) return [sorted]

  const positiveHeights = sorted.map((item) => item.height).filter((height) => height > 0)
  const averageHeight = positiveHeights.length > 0
    ? positiveHeights.reduce((sum, height) => sum + height, 0) / positiveHeights.length
    : 1
  const minimumColumnGap = Math.max(8, averageHeight * 1.45, pageWidth * 0.025)
  const groups: PositionedTextItem[][] = [[sorted[0]]]

  for (let index = 1; index < sorted.length; index += 1) {
    const item = sorted[index]
    const previous = sorted[index - 1]
    const gap = item.left - (previous.left + previous.width)
    const currentGroup = groups[groups.length - 1]
    const leftTextLength = joinLineItems(currentGroup).replace(/\s+/g, '').length
    const rightTextLength = joinLineItems(sorted.slice(index)).replace(/\s+/g, '').length
    if (gap >= minimumColumnGap && leftTextLength >= 4 && rightTextLength >= 4) {
      groups.push([item])
    } else {
      currentGroup.push(item)
    }
  }

  return groups
}

function createNativeLayoutBlocks(
  rawItems: PdfTextItem[],
  pageWidth: number,
  pageHeight: number,
): OcrRecognizeLayoutBlock[] {
  const items = rawItems
    .map((item): PositionedTextItem | null => {
      const left = Number(item.transform[4])
      const baseline = Number(item.transform[5])
      const height = Math.max(1, Math.abs(Number(item.height || item.transform[3] || item.transform[0] || 1)))
      const width = Math.max(1, Math.abs(Number(item.width || item.str.length * height * 0.55)))
      if (![left, baseline, height, width].every(Number.isFinite) || !item.str.trim()) return null
      return {
        text: item.str,
        left,
        top: Math.max(0, pageHeight - baseline - height),
        width,
        height,
        hasEOL: Boolean(item.hasEOL),
      }
    })
    .filter((item): item is PositionedTextItem => item !== null)
    .sort((left, right) => left.top - right.top || left.left - right.left)

  const lines: PositionedTextItem[][] = []
  for (const item of items) {
    const line = lines.find((candidate) => {
      const first = candidate[0]
      return Math.abs(first.top - item.top) <= Math.max(3, Math.min(first.height, item.height) * 0.45)
    })
    if (line) line.push(item)
    else lines.push([item])
  }

  return lines
    .flatMap((line) => splitLineAtColumnGaps(line, pageWidth))
    .map((line, index): OcrRecognizeLayoutBlock | null => {
      const sorted = [...line].sort((left, right) => left.left - right.left)
      const text = joinLineItems(sorted)
      if (!text) return null
      const left = Math.min(...sorted.map((item) => item.left))
      const top = Math.min(...sorted.map((item) => item.top))
      const right = Math.max(...sorted.map((item) => item.left + item.width))
      const bottom = Math.max(...sorted.map((item) => item.top + item.height))
      return {
        words: text,
        raw_words: text,
        label: 'text',
        reading_order: index,
        block_order: index + 1,
        location: {
          left: Math.max(0, Math.min(pageWidth, left)),
          top: Math.max(0, Math.min(pageHeight, top)),
          width: Math.max(1, Math.min(pageWidth - left, right - left)),
          height: Math.max(1, Math.min(pageHeight - top, bottom - top)),
        },
        confidence: 1,
        segmentation_source: 'native_pdf_text',
      }
    })
    .filter((block): block is OcrRecognizeLayoutBlock => block !== null)
}

async function getImageObjectCount(page: {
  getOperatorList: () => Promise<{ fnArray: number[] }>
}, imageOperatorCodes: Set<number>): Promise<number> {
  try {
    const operators = await page.getOperatorList()
    return operators.fnArray.filter((code) => imageOperatorCodes.has(code)).length
  } catch {
    return 0
  }
}

async function analyzePage(
  pdf: PDFDocumentProxy,
  pageNum: number,
  imageOperatorCodes: Set<number>,
): Promise<PdfTextLayerPageAnalysis> {
  const page = await pdf.getPage(pageNum)
  try {
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items = content.items.reduce<PdfTextItem[]>((collected, item) => {
      if (isTextItem(item)) collected.push(item)
      return collected
    }, [])
    const text = items.map((item) => item.str).join('\n').trim()
    const cleanCount = cleanCharacterCount(text)
    const invalidRatio = invalidUnicodeRatio(text)
    const replacementRatio = replacementCharacterRatio(text)
    const coordinateCount = items.filter((item) => item.transform.every((value) => Number.isFinite(Number(value)))).length
    const coordinateCoverage = items.length > 0 ? coordinateCount / items.length : 0
    const imageObjectCount = await getImageObjectCount(page, imageOperatorCodes)
    const reasons: string[] = []
    if (cleanCount < 50) reasons.push('too_few_clean_characters')
    if (invalidRatio >= 0.04) reasons.push('invalid_unicode_ratio')
    if (replacementRatio >= 0.02) reasons.push('replacement_character_ratio')
    if (coordinateCoverage < 0.6) reasons.push('insufficient_text_coordinates')
    if (Math.max(viewport.width, viewport.height) / Math.max(1, Math.min(viewport.width, viewport.height)) > 10) reasons.push('extreme_page_aspect_ratio')
    if (hasSuspiciousPunctuationRun(text)) reasons.push('suspicious_punctuation_run')
    if (imageObjectCount > 0 && cleanCount < 20) reasons.push('image_dominant_page')
    const mode: PdfTextLayerPageAnalysis['mode'] = reasons.length === 0 ? 'native_text' : 'ocr'
    return {
      pageNum,
      mode,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      text,
      cleanCharacterCount: cleanCount,
      invalidUnicodeRatio: invalidRatio,
      replacementCharacterRatio: replacementRatio,
      coordinateCoverage,
      imageObjectCount,
      reasons,
      layoutBlocks: mode === 'native_text' ? createNativeLayoutBlocks(items, viewport.width, viewport.height) : [],
    }
  } finally {
    page.cleanup()
  }
}

function summarizeMode(pages: PdfTextLayerPageAnalysis[]): PdfTextLayerAnalysis['mode'] {
  const nativeCount = pages.filter((page) => page.mode === 'native_text').length
  if (nativeCount === 0) return 'ocr'
  if (nativeCount === pages.length) return 'native_text'
  return 'mixed'
}

function trimCache(): void {
  while (preflightCache.size > MAX_PREFLIGHT_CACHE_ENTRIES) {
    const oldest = preflightCache.keys().next().value
    if (typeof oldest !== 'string') break
    preflightCache.delete(oldest)
  }
}

export async function analyzePdfTextLayer(
  filePath: string,
  options: { maxSamplePages?: number; analyzeAllPages?: boolean } = {},
): Promise<PdfTextLayerAnalysis> {
  const fileStat = await stat(filePath)
  const signature = `${fileStat.size}:${fileStat.mtimeMs}:${options.maxSamplePages || 10}:${options.analyzeAllPages === true}`
  const cached = preflightCache.get(filePath)
  if (cached?.signature === signature) return cached.analysis

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(filePath))
  const loadingTask = pdfjs.getDocument(getPdfJsNodeDocumentOptions({
    data,
  }))
  const pdf = await loadingTask.promise
  try {
    const sampledPageNums = samplePageNumbers(pdf.numPages, options.maxSamplePages || 10)
    const imageOperatorCodes = new Set<number>([
      pdfjs.OPS.paintImageXObject,
      pdfjs.OPS.paintInlineImageXObject,
      pdfjs.OPS.paintImageMaskXObject,
      pdfjs.OPS.paintSolidColorImageMask,
    ].filter((value) => Number.isFinite(value)))
    const sampledPages: PdfTextLayerPageAnalysis[] = []
    for (const pageNum of sampledPageNums) {
      sampledPages.push(await analyzePage(pdf, pageNum, imageOperatorCodes))
    }
    const sampledMode = summarizeMode(sampledPages)
    let pages = sampledPages
    if (options.analyzeAllPages && sampledMode !== 'ocr' && sampledPageNums.length < pdf.numPages) {
      const sampledByPage = new Map(sampledPages.map((page) => [page.pageNum, page]))
      pages = []
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
        pages.push(sampledByPage.get(pageNum) || await analyzePage(pdf, pageNum, imageOperatorCodes))
      }
    }
    const nativeTextPageCount = pages.filter((page) => page.mode === 'native_text').length
    const analysis: PdfTextLayerAnalysis = {
      mode: summarizeMode(pages),
      pageCount: pdf.numPages,
      sampledPageNums,
      nativeTextPageCount,
      ocrPageCount: pages.length - nativeTextPageCount,
      averageCleanCharacters: pages.reduce((sum, page) => sum + page.cleanCharacterCount, 0) / Math.max(1, pages.length),
      analyzedAt: new Date().toISOString(),
      pages,
    }
    preflightCache.set(filePath, { signature, analysis })
    trimCache()
    return analysis
  } finally {
    await pdf.destroy()
  }
}

export function clearPdfTextLayerPreflightCache(filePath?: string): void {
  if (filePath) preflightCache.delete(filePath)
  else preflightCache.clear()
}
