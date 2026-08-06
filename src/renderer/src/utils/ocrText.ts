import { isTocLabel, looksLikeTocText, parseTocEntries, type TocFormattedEntry } from '@shared/toc-format'
import {
  getLayoutBlockSearchText,
  getLosslessLayoutTableRows,
  getManualBlockId,
  getManualLayoutBlockKind,
  getManualLayoutSignatureSnapshot,
  isManualLayoutBlock,
  type ManualLayoutBlockMeta,
} from '@shared/manual-layout'
import type { DocumentPage, OcrRecognizeLayoutBlock, OcrRecognizeResult } from '@shared/types'

type JsonRecord = Record<string, unknown>
type OcrTextBlock = OcrRecognizeLayoutBlock & JsonRecord
type OcrTextResult = OcrRecognizeResult & JsonRecord
type Rect = { left: number; top: number; width: number; height: number }
type MarkdownImageBlock = { rect: Rect; src: string; alt: string }
type OcrTextPage = Omit<Partial<DocumentPage>, 'ocr_result'> & {
  doc_type?: string | null
  title?: string | null
  ocr_text?: unknown
  proofed_text?: unknown
  ocr_result?: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMaybeJson(value: unknown): unknown {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

function asOcrResult(value: unknown): OcrTextResult | null {
  const parsed = parseMaybeJson(value)
  return isRecord(parsed) ? parsed as OcrTextResult : null
}

function shouldSuppressUntrustedFeijiangReferenceLayout(result: OcrTextResult | null): boolean {
  if (!result || result.gujismart_recovered_from_feijiang_json !== true) return false
  const normalization = isRecord(result.normalization) ? result.normalization : {}
  return normalization.discarded_untrusted_feijiang_reference_layout === true
}

function asBlock(value: unknown): OcrTextBlock {
  return isRecord(value) ? value as OcrTextBlock : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asBlockArray(value: unknown): OcrTextBlock[] {
  return Array.isArray(value) ? value.filter(isRecord).map((item) => item as OcrTextBlock) : []
}

function getPathValue(source: unknown, path: readonly string[]): unknown {
  let current = source
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    const items = asArray(value)
    if (items.length > 0) return items
  }
  return []
}

function firstBlockArray(...values: unknown[]): OcrTextBlock[] {
  for (const value of values) {
    const blocks = asBlockArray(value)
    if (blocks.length > 0) return blocks
  }
  return []
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function firstNonEmptyText(values: readonly unknown[]): string {
  for (const value of values) {
    const text = valueToString(value).trim()
    if (text) return text
  }
  return ''
}

export type OcrInlineStyle = {
  underline?: boolean
  overline?: boolean
  bold?: boolean
  italic?: boolean
  sup?: boolean
  sub?: boolean
}

export type OcrInlineSegment = {
  text: string
  style: OcrInlineStyle
}

const OCR_INLINE_STYLE_COMMANDS: Record<string, Partial<OcrInlineStyle>> = {
  underline: { underline: true },
  overline: { overline: true },
  textbf: { bold: true },
  mathbf: { bold: true },
  bf: { bold: true },
  emph: { italic: true },
  textit: { italic: true },
  mathit: { italic: true },
}

const OCR_INLINE_TEXT_COMMANDS = new Set(['text', 'mathrm', 'operatorname', 'mbox'])

const OCR_INLINE_SYMBOLS: Record<string, string> = {
  dagger: '†',
  ddagger: '‡',
  ast: '*',
  star: '*',
  S: '§',
  P: '¶',
  cdot: '·',
  times: '×',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
}

function mergeOcrInlineStyle(base: OcrInlineStyle, extra?: Partial<OcrInlineStyle>): OcrInlineStyle {
  return extra ? { ...base, ...extra } : { ...base }
}

function sameOcrInlineStyle(left: OcrInlineStyle, right: OcrInlineStyle): boolean {
  return Boolean(left.underline) === Boolean(right.underline)
    && Boolean(left.overline) === Boolean(right.overline)
    && Boolean(left.bold) === Boolean(right.bold)
    && Boolean(left.italic) === Boolean(right.italic)
    && Boolean(left.sup) === Boolean(right.sup)
    && Boolean(left.sub) === Boolean(right.sub)
}

function pushOcrInlineSegment(parts: OcrInlineSegment[], text: string, style: OcrInlineStyle) {
  if (!text) return
  const previous = parts[parts.length - 1]
  if (previous && sameOcrInlineStyle(previous.style, style)) {
    previous.text += text
    return
  }
  parts.push({ text, style: { ...style } })
}

function findBalancedBraceEnd(source: string, openIndex: number): number {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function parseOcrInlineGroup(source: string, start: number, end: number, style: OcrInlineStyle, parts: OcrInlineSegment[]) {
  let index = start
  while (index < end) {
    const char = source[index]

    if (char === '$') {
      index += 1
      continue
    }

    if (char === '\\') {
      if (/^[,;:!]$/.test(source[index + 1] || '')) {
        pushOcrInlineSegment(parts, ' ', style)
        index += 2
        continue
      }
      const commandMatch = /^\\([a-zA-Z]+)\s*/.exec(source.slice(index))
      if (!commandMatch) {
        pushOcrInlineSegment(parts, char, style)
        index += 1
        continue
      }

      const command = commandMatch[1]
      const lowerCommand = command.toLowerCase()
      let nextIndex = index + commandMatch[0].length
      const symbol = OCR_INLINE_SYMBOLS[command] ?? OCR_INLINE_SYMBOLS[lowerCommand]
      if (symbol) {
        pushOcrInlineSegment(parts, symbol, style)
        index = nextIndex
        continue
      }
      if (/^(?:quad|qquad)$/.test(lowerCommand)) {
        pushOcrInlineSegment(parts, ' ', style)
        index = nextIndex
        continue
      }
      if (/^[,;:!]$/.test(command)) {
        pushOcrInlineSegment(parts, ' ', style)
        index = nextIndex
        continue
      }

      if (source[nextIndex] === '{') {
        const closeIndex = findBalancedBraceEnd(source, nextIndex)
        if (closeIndex > nextIndex) {
          const nextStyle = OCR_INLINE_TEXT_COMMANDS.has(lowerCommand)
            ? style
            : mergeOcrInlineStyle(style, OCR_INLINE_STYLE_COMMANDS[lowerCommand])
          parseOcrInlineGroup(source, nextIndex + 1, closeIndex, nextStyle, parts)
          index = closeIndex + 1
          continue
        }
      }

      index = nextIndex
      continue
    }

    if ((char === '^' || char === '_') && index + 1 < end) {
      const isSup = char === '^'
      const nextStyle = mergeOcrInlineStyle(style, isSup ? { sup: true } : { sub: true })
      if (source[index + 1] === '{') {
        const closeIndex = findBalancedBraceEnd(source, index + 1)
        if (closeIndex > index + 1 && closeIndex - index <= 34) {
          parseOcrInlineGroup(source, index + 2, closeIndex, nextStyle, parts)
          index = closeIndex + 1
          continue
        }
      } else if (isSup && /\d/.test(source[index + 1])) {
        const token = /^[0-9]{1,6}/.exec(source.slice(index + 1))?.[0] || ''
        if (token) {
          pushOcrInlineSegment(parts, token, nextStyle)
          index += 1 + token.length
          continue
        }
      }
    }

    pushOcrInlineSegment(parts, char, style)
    index += 1
  }
}

export function parseOcrInlineText(value: string): OcrInlineSegment[] {
  const source = decodeHtmlEntities(String(value || '')).replace(/\r/g, '\n')
  const parts: OcrInlineSegment[] = []
  parseOcrInlineGroup(source, 0, source.length, {}, parts)
  return parts.filter((part) => part.text)
}

export function flattenOcrInlineSegments(segments: OcrInlineSegment[]): string {
  return segments.map((segment) => segment.text).join('')
}

export function normalizeOcrInlineText(value: string): string {
  let text = flattenOcrInlineSegments(parseOcrInlineText(value))
    .replace(/[{}]/g, '')
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?([，。；：！？、,.!?;:]) ?/g, '$1')
    .trim()
  return text
}

export function getRawOcrBlockText(block: unknown): string {
  const record = asBlock(block)
  return firstNonEmptyText([
    record.raw_words,
    record.raw_text,
    record.words,
    record.word,
    record.text,
    record.block_content,
    record.content,
    record.transcription,
    readStructureResText(record.res),
  ])
}

function getPreferredOcrBlockText(block: unknown): string {
  const record = asBlock(block)
  return firstNonEmptyText([
    record.words,
    record.word,
    record.text,
    record.block_content,
    record.content,
    record.transcription,
    record.raw_words,
    record.raw_text,
    readStructureResText(record.res),
  ])
}

function readTupleText(item: unknown): string {
  if (Array.isArray(item)) return valueToString(item[0])
  if (isRecord(item)) return firstNonEmptyText([item.text, item.words, item.word, item.value])
  return valueToString(item)
}

function readStructureResText(res: unknown): string {
  if (!res) return ''
  if (typeof res === 'string' || typeof res === 'number') return String(res)
  if (Array.isArray(res)) {
    const tupleRec = Array.isArray(res[1]) ? res[1] : []
    const tupleText = tupleRec
      .map(readTupleText)
      .filter(Boolean)
      .join('\n')
    if (tupleText) return tupleText
    return res.map(readStructureResText).filter(Boolean).join('\n')
  }
  if (!isRecord(res)) return ''
  const html = firstNonEmptyText([res.html, res.table_html])
  if (html) return html
  const recRes = asArray(res.rec_res)
  if (recRes.length > 0) {
    return recRes.map(readTupleText).filter(Boolean).join('\n')
  }
  const recTexts = asArray(res.rec_texts)
  if (recTexts.length > 0) return recTexts.map(valueToString).filter(Boolean).join('\n')
  return firstNonEmptyText([res.text, res.words, res.content])
}

export function getOcrBlockText(block: unknown): string {
  return normalizeOcrInlineText(getPreferredOcrBlockText(block))
}

export type ReadablePageElement = {
  type: 'heading' | 'paragraph' | 'table' | 'image' | 'toc'
  visualKind?: 'image' | 'seal'
  text: string
  displayText?: string
  rows?: string[][]
  tocEntries?: TocFormattedEntry[]
  label?: string
  blockId?: string
  rect?: Rect
  imagePath?: string
  imageCrop?: ManualLayoutBlockMeta['image_crop']
  caption?: string
  charStart: number
  charEnd: number
}

function stripHtml(value: string): string {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
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

function decodeEmbeddedTableMarkup(value: string): string {
  const source = String(value || '')
  return /&lt;\s*table|&lt;\s*tr|&lt;\s*td|&lt;\s*th/i.test(source) ? decodeHtmlEntities(source) : source
}

function getBlockTableMarkup(block: unknown): string {
  const structure = asArray(getPathValue(block, ['res', 'structure']))
  const candidates = [
    getPathValue(block, ['html']),
    getPathValue(block, ['table_html']),
    getPathValue(block, ['tableHtml']),
    getPathValue(block, ['table', 'html']),
    getPathValue(block, ['markdown']),
    getPathValue(block, ['md']),
    getPathValue(block, ['words']),
    getPathValue(block, ['word']),
    getPathValue(block, ['text']),
    getPathValue(block, ['block_content']),
    getPathValue(block, ['res', 'html']),
    getPathValue(block, ['res', 'table_html']),
    structure.length > 0 ? structure.map(valueToString).join('') : '',
  ]
  for (const candidate of candidates) {
    const value = decodeEmbeddedTableMarkup(valueToString(candidate))
    if (/<table|<tr|<td|<th/i.test(value)) return value
  }
  return decodeEmbeddedTableMarkup(firstNonEmptyText(candidates))
}

function getBlockText(block: unknown): string {
  if (isManualLayoutBlock(block)) return getLayoutBlockSearchText(block)
  return getOcrBlockText(block)
}

function getBlockDisplayText(block: unknown): string {
  if (isManualLayoutBlock(block)) return getLayoutBlockSearchText(block)
  return getPreferredOcrBlockText(block) || getRawOcrBlockText(block) || getOcrBlockText(block)
}

function getBlockMarkdownTableText(block: unknown): string {
  const record = asBlock(block)
  return firstNonEmptyText([
    record.markdown,
    record.md,
    record.words,
    record.text,
    record.block_content,
    readStructureResText(record.res),
    getOcrBlockText(block),
  ])
}

function getBlockLabel(block: unknown): string {
  const record = asBlock(block)
  return firstNonEmptyText([record.label, record.block_label, record.type, record.block_type, record.category]).toLowerCase()
}

function normalizeLayoutLabel(label: string): string {
  return String(label || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getNormalizedBlockLabel(block: unknown): string {
  return normalizeLayoutLabel(getBlockLabel(block))
}

function isLayoutHeadingLabel(label: string): boolean {
  const normalized = normalizeLayoutLabel(label)
  return /^(?:doc title|document title|paragraph title|title|heading|section title)$/.test(normalized)
    || /标题|段题|篇名|题名/.test(normalized)
}

function isLayoutTextLabel(label: string): boolean {
  const normalized = normalizeLayoutLabel(label)
  return /^(?:text|body|content|toc|table of contents|contents|catalog|catalogue|sidebar text|abstract|reference|references|footnote|footnotes|note|annotation|algorithm|formula|formula number|figure caption|table caption|caption)$/.test(normalized)
    || /正文|内容|摘要|参考|注释|脚注|注文|图题|表题|题注/.test(normalized)
}

function isVerticalTextLabel(label: string): boolean {
  return /\bvertical text\b|vertical_text|竖排|豎排|直排/.test(normalizeLayoutLabel(label))
}

function isLayoutTableLabel(label: string): boolean {
  const normalized = normalizeLayoutLabel(label)
  return /^(?:table)$/.test(normalized) || /表格/.test(normalized)
}

function isLayoutImageLabel(label: string): boolean {
  const normalized = normalizeLayoutLabel(label)
  return /^(?:image|figure|picture|chart|diagram|photo|illustration)$/.test(normalized)
    || /图片|图像|插图|示意图|图表|照片/.test(normalized)
}

function getManualVisualKind(block: unknown): 'image' | 'seal' | undefined {
  const kind = getManualLayoutBlockKind(block)
  return kind === 'image' || kind === 'seal' ? kind : undefined
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
      blocks.push({ src, alt, rect: { left, top, width: right - left, height: bottom - top } })
    }
  })
  return blocks
}

function getMarkdownTextAndImages(parsed: OcrTextResult | null): { text: string; images: JsonRecord } {
  const markdown = parsed?.markdown
  if (typeof markdown === 'string') return { text: markdown, images: {} }
  if (markdown && typeof markdown === 'object' && !Array.isArray(markdown)) {
    const record = markdown as JsonRecord
    return {
      text: typeof record.text === 'string' ? record.text : '',
      images: record.images && typeof record.images === 'object' && !Array.isArray(record.images) ? record.images as JsonRecord : {},
    }
  }
  return { text: '', images: {} }
}

function resolveMarkdownImageSrc(src: string, images: JsonRecord): string {
  const value = String(src || '').trim()
  if (!value) return ''
  const mapped = images[value]
  return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : value
}

function getBlockImagePath(block: OcrTextBlock): string {
  return String(block?.image_asset_path || block?.asset_path || block?.image_path || '').trim()
}

function isRenderableImagePath(value: string): boolean {
  const path = String(value || '').trim()
  return Boolean(path) && !/^(?:imgs?|images?)\//i.test(path)
}

function rectOverlapRatio(left: Rect, right: Rect): number {
  const x1 = Math.max(left.left, right.left)
  const y1 = Math.max(left.top, right.top)
  const x2 = Math.min(left.left + left.width, right.left + right.width)
  const y2 = Math.min(left.top + left.height, right.top + right.height)
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const minArea = Math.min(Math.max(1, left.width * left.height), Math.max(1, right.width * right.height))
  return intersection / minArea
}

function isLayoutDecorativeLabel(label: string): boolean {
  const normalized = normalizeLayoutLabel(label)
  return /^(?:header|footer|page number|number|header image|footer image|watermark|stamp|seal|barcode|qrcode)$/.test(normalized)
    || /页眉|页脚|页码|页号|印章|水印|版权/.test(normalized)
}

function hasPositiveBlockOrder(block: OcrTextBlock): boolean {
  const order = Number(block?.block_order)
  return Number.isFinite(order) && order > 0
}

function shouldPreferPositiveBlockOrder(blocks: OcrTextBlock[]): boolean {
  const contentBlocks = blocks.filter((block) => !isLayoutDecorativeLabel(getBlockLabel(block)))
  if (contentBlocks.length === 0) return false
  const orderedCount = contentBlocks.filter(hasPositiveBlockOrder).length
  return orderedCount >= Math.max(2, Math.ceil(contentBlocks.length * 0.6))
}

function compareByPositiveBlockOrder(left: OcrTextBlock, right: OcrTextBlock): number {
  const leftOrder = Number(left?.block_order)
  const rightOrder = Number(right?.block_order)
  const leftHasOrder = Number.isFinite(leftOrder) && leftOrder > 0
  const rightHasOrder = Number.isFinite(rightOrder) && rightOrder > 0
  if (leftHasOrder !== rightHasOrder) return leftHasOrder ? -1 : 1
  if (leftHasOrder && rightHasOrder) return leftOrder - rightOrder
  const leftReadingOrder = Number(left?.reading_order)
  const rightReadingOrder = Number(right?.reading_order)
  if (Number.isFinite(leftReadingOrder) || Number.isFinite(rightReadingOrder)) {
    return (Number.isFinite(leftReadingOrder) ? leftReadingOrder : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(rightReadingOrder) ? rightReadingOrder : Number.MAX_SAFE_INTEGER)
  }
  const leftPoint = getBlockPoint(left)
  const rightPoint = getBlockPoint(right)
  return leftPoint.top - rightPoint.top || leftPoint.left - rightPoint.left
}

function parseArabicPageNumber(value: string): number | null {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[［【\[(（〔〈《「『]/g, '')
    .replace(/[］】\])）〕〉》」』]/g, '')
    .replace(/\s+/g, '')
    .trim()
  if (!text) return null
  const direct = text.match(/^(?:第)?([0-9]{1,5})(?:页|頁|面)?$/)
  if (direct) {
    const pageNum = Number(direct[1])
    return Number.isFinite(pageNum) && pageNum > 0 ? pageNum : null
  }
  const labeled = text.match(/(?:页码|頁碼|页号|頁號|page|p\.?)(?:[:：])?([0-9]{1,5})/i)
  if (labeled) {
    const pageNum = Number(labeled[1])
    return Number.isFinite(pageNum) && pageNum > 0 ? pageNum : null
  }
  return null
}

function isPageNumberLabel(label: string): boolean {
  const normalized = normalizeLayoutLabel(label)
  return /^(?:page number|page no|pageno|page-num|number)$/.test(normalized)
    || /页码|頁碼|页号|頁號/.test(normalized)
}

export function getOriginalPageNumber(page: OcrTextPage | null | undefined): number | null {
  if (!page) return null
  const parsed = asOcrResult(page.ocr_result)
  const directCandidates = [
    parsed?.page_number,
    parsed?.pageNumber,
    parsed?.original_page_number,
    parsed?.originalPageNumber,
    getPathValue(parsed, ['page', 'number']),
    getPathValue(parsed, ['page', 'page_number']),
  ]
  for (const candidate of directCandidates) {
    const pageNum = parseArabicPageNumber(valueToString(candidate))
    if (pageNum) return pageNum
  }

  const blocks = [
    ...getLayoutAwareBlocks(page),
    ...getOrderedOcrBlocks(page),
  ]
  for (const block of blocks) {
    const label = getBlockLabel(block)
    if (!isPageNumberLabel(label)) continue
    const pageNum = parseArabicPageNumber(getBlockText(block) || getRawOcrBlockText(block))
    if (pageNum) return pageNum
  }
  return null
}

export function getCitationPageNumber(page: OcrTextPage | null | undefined, fallback?: number | null): number | null {
  // Prefer continuity-resolved literature page (DB field) when present.
  const literature = Number((page as { literature_page_num?: number | null } | null | undefined)?.literature_page_num || 0)
  if (Number.isFinite(literature) && literature > 0) return Math.floor(literature)

  // Then raw OCR label, but only as a hint — full continuity is applied at OCR finalize.
  const originalPageNum = getOriginalPageNumber(page)
  if (originalPageNum) return originalPageNum
  const fallbackPageNum = Number(fallback ?? page?.page_num ?? 0)
  return Number.isFinite(fallbackPageNum) && fallbackPageNum > 0 ? fallbackPageNum : null
}

function getCellText(cell: unknown): string {
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    return String(cell).replace(/\s+/g, ' ').trim()
  }
  if (!isRecord(cell)) return ''
  return firstNonEmptyText([cell.text, cell.words, cell.word, cell.value]).replace(/\s+/g, ' ').trim()
}

function getCellRow(cell: unknown): number {
  const record = isRecord(cell) ? cell : {}
  const value = Number(record.row ?? record.row_index ?? record.rowIndex ?? record.start_row ?? record.startRow ?? 0)
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function getCellCol(cell: unknown): number {
  const record = isRecord(cell) ? cell : {}
  const value = Number(record.col ?? record.column ?? record.col_index ?? record.column_index ?? record.colIndex ?? record.columnIndex ?? record.start_col ?? record.startCol ?? 0)
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function parseHtmlTableRows(html: string): string[][] {
  const rows: string[][] = []
  const rowMatches = decodeEmbeddedTableMarkup(html).match(/<tr[\s\S]*?<\/tr>/gi) || []
  const pendingRowspans = new Map<number, Map<number, string>>()
  rowMatches.forEach((rowHtml, rowIndex) => {
    const cells = rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []
    const row: string[] = []
    let columnIndex = 0
    const fillPending = () => {
      const pending = pendingRowspans.get(rowIndex)
      while (pending?.has(columnIndex)) {
        row[columnIndex] = pending.get(columnIndex) || ''
        pending.delete(columnIndex)
        columnIndex += 1
      }
    }
    fillPending()
    for (const cellHtml of cells) {
      const text = stripHtml(cellHtml)
      const colspan = getHtmlSpan(cellHtml, 'colspan')
      const rowspan = getHtmlSpan(cellHtml, 'rowspan')
      for (let offset = 0; offset < colspan; offset += 1) {
        row[columnIndex + offset] = offset === 0 ? text : ''
        if (rowspan > 1) {
          for (let rowOffset = 1; rowOffset < rowspan; rowOffset += 1) {
            const targetRow = rowIndex + rowOffset
            const pending = pendingRowspans.get(targetRow) || new Map<number, string>()
            pending.set(columnIndex + offset, text)
            pendingRowspans.set(targetRow, pending)
          }
        }
      }
      columnIndex += colspan
      fillPending()
    }
    if (row.some((cell) => cell.length > 0)) rows.push(row)
  })
  return rows
}

function getHtmlSpan(cellHtml: string, attribute: 'colspan' | 'rowspan'): number {
  const match = String(cellHtml || '').match(new RegExp(`${attribute}\\s*=\\s*["']?(\\d+)`, 'i'))
  const value = match ? Number(match[1]) : 1
  return Number.isFinite(value) ? Math.max(1, Math.min(50, Math.floor(value))) : 1
}

function splitHtmlTables(text: string): Array<{ type: 'text' | 'table'; value: string }> {
  const source = decodeEmbeddedTableMarkup(text)
  if (!/<table[\s\S]*?>/i.test(source)) return [{ type: 'text', value: source }]
  const parts: Array<{ type: 'text' | 'table'; value: string }> = []
  const tablePattern = /<table[\s\S]*?<\/table>/gi
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tablePattern.exec(source))) {
    if (match.index > cursor) {
      parts.push({ type: 'text', value: source.slice(cursor, match.index) })
    }
    parts.push({ type: 'table', value: match[0] })
    cursor = match.index + match[0].length
  }
  if (cursor < source.length) parts.push({ type: 'text', value: source.slice(cursor) })
  return parts.filter((part) => part.value.trim())
}

function parseMarkdownTableRows(text: string): string[][] {
  const lines = String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^\|.+\|$/.test(line))
  if (lines.length < 2) return []
  return lines
    .filter((line) => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))
}

function parseDelimitedTableRows(text: string): string[][] {
  const lines = String(text || '')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return []

  const rows = lines
    .map((line) => {
      if (line.includes('\t')) return line.split(/\t+/).map((cell) => cell.trim())
      if (line.includes('|')) return line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
      if (/\s{2,}/.test(line)) return line.split(/\s{2,}/).map((cell) => cell.trim())
      return []
    })
    .filter((row) => row.length > 1 && row.some(Boolean))

  return rows.length > 0 ? rows : []
}

function normalizeTableRows(rows: unknown): string[][] {
  const rowValues = asArray(rows)
  if (rowValues.length === 0) return []
  return rowValues
    .map((row) => Array.isArray(row)
      ? row.map(getCellText)
      : Array.isArray(getPathValue(row, ['cells']))
        ? asArray(getPathValue(row, ['cells'])).map(getCellText)
        : [])
    .filter((row: string[]) => row.some((cell: string) => cell.trim()))
}

export function getBlockTableRows(block: unknown): string[][] {
  const html = getBlockTableMarkup(block)
  const htmlRows = /<table|<tr/i.test(html) ? parseHtmlTableRows(html) : []
  const directRows = normalizeTableRows(firstArray(
    getPathValue(block, ['rows']),
    getPathValue(block, ['table_rows']),
    getPathValue(block, ['tableRows']),
    getPathValue(block, ['table', 'rows']),
  ))
  if (htmlRows.length > 0 && (directRows.length === 0 || isUnevenTableRows(directRows))) return htmlRows
  if (directRows.length > 0) return directRows

  const cells = firstArray(
    getPathValue(block, ['cells']),
    getPathValue(block, ['table_cells']),
    getPathValue(block, ['tableCells']),
    getPathValue(block, ['table', 'cells']),
  )
  if (cells.length > 0) {
    const table: string[][] = []
    for (const cell of cells) {
      const rowIndex = getCellRow(cell)
      const colIndex = getCellCol(cell)
      if (!table[rowIndex]) table[rowIndex] = []
      table[rowIndex][colIndex] = getCellText(cell)
    }
    const rows = table.map((row) => (row || []).map((cell) => cell || '')).filter((row) => row.some(Boolean))
    if (rows.length > 0) return rows
  }

  if (htmlRows.length > 0) return htmlRows

  const markdownRows = parseMarkdownTableRows(getBlockMarkdownTableText(block))
  if (markdownRows.length > 0) return markdownRows

  return parseDelimitedTableRows(getBlockText(block))
}

function isUnevenTableRows(rows: string[][]): boolean {
  const widths = rows.map((row) => row.length).filter((width) => width > 0)
  if (widths.length < 2) return false
  const maxWidth = Math.max(...widths)
  return maxWidth > 1 && widths.some((width) => width < maxWidth)
}

export function tableRowsToText(rows: string[][]): string {
  return rows.map((row) => row.join('\t')).join('\n')
}

export function isTableBlock(block: unknown): boolean {
  const label = getBlockLabel(block)
  const htmlLike = getBlockTableMarkup(block)
  return isLayoutTableLabel(label)
    || Array.isArray(getPathValue(block, ['cells']))
    || Array.isArray(getPathValue(block, ['table_cells']))
    || Array.isArray(getPathValue(block, ['table', 'cells']))
    || Array.isArray(getPathValue(block, ['rows']))
    || Array.isArray(getPathValue(block, ['table_rows']))
    || Array.isArray(getPathValue(block, ['tableRows']))
    || Array.isArray(getPathValue(block, ['table', 'rows']))
    || /^\s*\|.+\|/m.test(getBlockMarkdownTableText(block))
    || /<table|<tr/i.test(htmlLike)
}

function getPointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number | null {
  const rawValue = isRecord(point)
    ? point[key]
    : Array.isArray(point)
      ? point[tupleIndex]
      : undefined
  const value = Number(rawValue)
  return Number.isFinite(value) ? value : null
}

function arrayToRect(loc: unknown): Rect | null {
  if (!Array.isArray(loc) || loc.length < 4) return null
  if (typeof loc[0] === 'number') {
    const [x1, y1, x2, y2] = loc.map(Number)
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    }
  }
  const xs = loc.map((point) => getPointCoordinate(point, 'x', 0)).filter((value): value is number => value !== null)
  const ys = loc.map((point) => getPointCoordinate(point, 'y', 1)).filter((value): value is number => value !== null)
  if (xs.length === 0 || ys.length === 0) return null
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

function getRawBlockLocation(block: unknown): unknown {
  const record = asBlock(block)
  return record.location
    || record.rect
    || record.points
    || record.block_bbox
    || record.bbox
    || record.box
    || record.coordinate
    || record.coordinate_box
    || record.poly
    || record.polygon
}

function getBlockPoint(block: unknown): { top: number; left: number } {
  const loc = getRawBlockLocation(block)
  if (isRecord(loc) && (loc.top !== undefined || loc.left !== undefined)) {
    return {
      top: Number.isFinite(Number(loc.top)) ? Number(loc.top) : Number.MAX_SAFE_INTEGER,
      left: Number.isFinite(Number(loc.left)) ? Number(loc.left) : Number.MAX_SAFE_INTEGER,
    }
  }
  const rect = arrayToRect(loc)
  if (rect) return { top: rect.top, left: rect.left }
  return { top: Number.MAX_SAFE_INTEGER, left: Number.MAX_SAFE_INTEGER }
}

function getBlockSize(block: unknown): { width: number; height: number } {
  const loc = getRawBlockLocation(block)
  if (isRecord(loc) && (loc.width !== undefined || loc.height !== undefined)) {
    return {
      width: Number.isFinite(Number(loc.width)) ? Number(loc.width) : 0,
      height: Number.isFinite(Number(loc.height)) ? Number(loc.height) : 0,
    }
  }
  const rect = arrayToRect(loc)
  if (rect) return { width: rect.width, height: rect.height }
  return { width: 0, height: 0 }
}

function getBlockRect(block: unknown): Rect | null {
  const point = getBlockPoint(block)
  const size = getBlockSize(block)
  if (!Number.isFinite(point.left) || !Number.isFinite(point.top) || size.width <= 0 || size.height <= 0) return null
  return { left: point.left, top: point.top, width: size.width, height: size.height }
}

function isDecorativeLayoutBlock(block: unknown, text: string): boolean {
  if (getManualVisualKind(block)) return false
  const label = getBlockLabel(block)
  if (isLayoutDecorativeLabel(label)) return true
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return true
  if (/^(?:page|p\.?)?\d{1,5}$/i.test(compact)) return true
  if (/^第?\d{1,5}[页頁]?$/.test(compact)) return true
  const size = getBlockSize(block)
  return compact.length <= 2 && size.height > 0 && size.height < 18
}

function getLayoutBlockType(block: unknown, text: string): 'heading' | 'paragraph' | 'table' {
  if (isTableBlock(block)) return 'table'
  const label = getBlockLabel(block)
  if (isLayoutTextLabel(label)) return 'paragraph'
  if (isLayoutHeadingLabel(label)) return 'heading'
  if (isStructuralLine(text)) return 'heading'
  const size = getBlockSize(block)
  return size.height > 0 && size.height < 28 && text.length <= 60 ? 'heading' : 'paragraph'
}

function getLayoutAwareBlocks(page: OcrTextPage): OcrTextBlock[] {
  const parsed = asOcrResult(page.ocr_result)
  if (!parsed) return []
  if (shouldSuppressUntrustedFeijiangReferenceLayout(parsed)) return []
  const withMarkdownImages = (blocks: OcrTextBlock[]): OcrTextBlock[] => {
    const markdown = getMarkdownTextAndImages(parsed)
    const markdownText = markdown.text || String(page.ocr_text || '')
    const markdownImageBlocks = parseMarkdownImageBlocks(markdownText)
    const enrichedBlocks = blocks.map((block) => {
      if (!isLayoutImageLabel(getBlockLabel(block)) || isRenderableImagePath(getBlockImagePath(block))) return block
      const rect = getBlockRect(block)
      if (!rect) return block
      const markdownImage = markdownImageBlocks.find((imageBlock) => rectOverlapRatio(rect, imageBlock.rect) >= 0.6)
      if (!markdownImage) return block
      const imagePath = resolveMarkdownImageSrc(markdownImage.src, markdown.images)
      if (!isRenderableImagePath(imagePath)) return block
      return {
        ...block,
        words: getBlockText(block) || markdownImage.alt || 'image',
        image_path: imagePath,
        image_asset_path: imagePath,
        asset_path: imagePath,
      }
    })
    const imageBlocks = markdownImageBlocks
      .filter((imageBlock) => !enrichedBlocks.some((block) => (
        isLayoutImageLabel(getBlockLabel(block))
        && isRenderableImagePath(getBlockImagePath(block))
        && getBlockRect(block)
        && rectOverlapRatio(getBlockRect(block) as Rect, imageBlock.rect) >= 0.6
      )))
      .map((imageBlock, index): OcrTextBlock => {
        const followingBlock = enrichedBlocks
          .filter((block) => {
            const rect = getBlockRect(block)
            return rect && !isLayoutDecorativeLabel(getBlockLabel(block)) && rect.top >= imageBlock.rect.top + imageBlock.rect.height - Math.max(12, imageBlock.rect.height * 0.08)
          })
          .sort((left, right) => Number(getBlockRect(left)?.top || 0) - Number(getBlockRect(right)?.top || 0))[0]
        const readingOrder = followingBlock && Number.isFinite(Number(followingBlock.reading_order))
          ? Number(followingBlock.reading_order) - 0.5
          : blocks.length + index + 0.5
        return {
          words: imageBlock.alt || 'image',
          label: 'image',
          reading_order: readingOrder,
          location: imageBlock.rect,
          image_path: resolveMarkdownImageSrc(imageBlock.src, markdown.images),
          image_asset_path: resolveMarkdownImageSrc(imageBlock.src, markdown.images),
          asset_path: resolveMarkdownImageSrc(imageBlock.src, markdown.images),
        } as OcrTextBlock
      })
    return [...enrichedBlocks, ...imageBlocks]
  }
  const layoutBlocks = asBlockArray(parsed.layout_result)
  const rawLayoutBlocks = asBlockArray(parsed.raw_layout_result)
  if (layoutBlocks.length > 0) {
    return withMarkdownImages(shouldPreferRawLayoutBlocks(layoutBlocks, rawLayoutBlocks) ? rawLayoutBlocks : layoutBlocks)
  }
  const layoutBoxes = firstBlockArray(
    getPathValue(parsed, ['layout_det_res', 'boxes']),
    getPathValue(parsed, ['res', 'layout_det_res', 'boxes']),
    parsed.boxes,
  )
  if (layoutBoxes.length > 0) return withMarkdownImages(layoutBoxes)
  const parsingBlocks = firstBlockArray(
    parsed.parsing_res_list,
    getPathValue(parsed, ['prunedResult', 'parsing_res_list']),
  )
  if (parsingBlocks.length > 0) return withMarkdownImages(parsingBlocks)
  return []
}

function compactBlockTextLength(blocks: OcrTextBlock[]): number {
  return blocks
    .map((block) => getBlockText(block).replace(/\s+/g, ''))
    .reduce((sum, text) => sum + text.length, 0)
}

function blockCoordinateCount(blocks: OcrTextBlock[]): number {
  return blocks.filter((block) => !!getBlockRect(block)).length
}

function shouldPreferRawLayoutBlocks(layoutBlocks: OcrTextBlock[], rawLayoutBlocks: OcrTextBlock[]): boolean {
  if (rawLayoutBlocks.length === 0) return false
  if (rawLayoutBlocks.length <= layoutBlocks.length) return false
  const layoutTextLength = compactBlockTextLength(layoutBlocks)
  const rawTextLength = compactBlockTextLength(rawLayoutBlocks)
  if (rawTextLength < 80) return false
  const rawHasMoreText = rawTextLength >= layoutTextLength * 1.35 && rawTextLength - layoutTextLength >= 40
  if (!rawHasMoreText) return false
  return blockCoordinateCount(rawLayoutBlocks) >= blockCoordinateCount(layoutBlocks)
}

function recognizedTextBlocksFrom(source: unknown): OcrTextBlock[] {
  if (!isRecord(source)) return []
  const recTexts = asArray(source.rec_texts)
  if (recTexts.length === 0) return []
  const locations = firstArray(source.rec_boxes, source.rec_polys, source.dt_polys)
  const scores = asArray(source.rec_scores)
  return recTexts.map((text, index): OcrTextBlock => ({
    words: valueToString(text),
    label: 'text',
    reading_order: index,
    location: locations[index],
    score: scores[index],
  }))
}

function getOcrTextBlocks(page: OcrTextPage): OcrTextBlock[] {
  const parsed = asOcrResult(page.ocr_result)
  if (!parsed) return []
  if (shouldSuppressUntrustedFeijiangReferenceLayout(parsed)) return []

  const directBlocks = firstBlockArray(
    parsed.layout_result,
    parsed.layout_blocks,
    getPathValue(parsed, ['layout_det_res', 'boxes']),
    getPathValue(parsed, ['res', 'layout_det_res', 'boxes']),
    parsed.boxes,
    parsed.parsing_res_list,
    getPathValue(parsed, ['prunedResult', 'parsing_res_list']),
    getPathValue(parsed, ['res', 'prunedResult', 'parsing_res_list']),
  )
  if (directBlocks.length > 0) return directBlocks

  const recognizedBlocks = recognizedTextBlocksFrom(getPathValue(parsed, ['overall_ocr_res']))
  if (recognizedBlocks.length > 0) return recognizedBlocks

  const nestedRecognizedBlocks = recognizedTextBlocksFrom(getPathValue(parsed, ['res', 'overall_ocr_res']))
  if (nestedRecognizedBlocks.length > 0) return nestedRecognizedBlocks

  const rootRecognizedBlocks = recognizedTextBlocksFrom(parsed)
  if (rootRecognizedBlocks.length > 0) return rootRecognizedBlocks

  return asBlockArray(parsed.words_result)
}

export function getOrderedOcrBlocks(page: OcrTextPage): OcrTextBlock[] {
  const blocks = getOcrTextBlocks(page)

  if (blocks.length === 0) return []

  if (shouldPreferPositiveBlockOrder(blocks)) {
    return [...blocks].sort(compareByPositiveBlockOrder)
  }

  return [...blocks].sort(compareByOriginalReadingOrder)
}

function compareByOriginalReadingOrder(left: OcrTextBlock, right: OcrTextBlock): number {
  const leftOrder = Number(left?.reading_order)
  const rightOrder = Number(right?.reading_order)
  const leftBlockOrder = Number(left?.block_order)
  const rightBlockOrder = Number(right?.block_order)
  if (Number.isFinite(leftOrder) || Number.isFinite(rightOrder)) {
    return (Number.isFinite(leftOrder) ? leftOrder : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(rightOrder) ? rightOrder : Number.MAX_SAFE_INTEGER)
  }
  if (Number.isFinite(leftBlockOrder) || Number.isFinite(rightBlockOrder)) {
    return (Number.isFinite(leftBlockOrder) ? leftBlockOrder : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(rightBlockOrder) ? rightBlockOrder : Number.MAX_SAFE_INTEGER)
  }
  const leftPoint = getBlockPoint(left)
  const rightPoint = getBlockPoint(right)
  return leftPoint.top - rightPoint.top || leftPoint.left - rightPoint.left
}

function getManualReadingOrder(block: OcrTextBlock): number | null {
  const order = Number(block?.manual_reading_order)
  return Number.isFinite(order) ? order : null
}

function compareByManualReadingOrder(left: OcrTextBlock, right: OcrTextBlock, preferPositiveBlockOrder: boolean): number {
  const leftOrder = getManualReadingOrder(left)
  const rightOrder = getManualReadingOrder(right)
  if (leftOrder !== null || rightOrder !== null) {
    const orderDelta = (leftOrder !== null ? leftOrder : Number.MAX_SAFE_INTEGER)
      - (rightOrder !== null ? rightOrder : Number.MAX_SAFE_INTEGER)
    if (orderDelta !== 0) return orderDelta
  }

  if (preferPositiveBlockOrder) return compareByPositiveBlockOrder(left, right)
  return compareByOriginalReadingOrder(left, right)
}

export function getTextFlowOcrBlocks(page: OcrTextPage): OcrTextBlock[] {
  const blocks = getOcrTextBlocks(page)
  if (blocks.length === 0) return []
  if (!blocks.some((block) => getManualReadingOrder(block) !== null)) return getOrderedOcrBlocks(page)
  const preferPositiveBlockOrder = shouldPreferPositiveBlockOrder(blocks)

  return [...blocks].sort((left, right) => {
    const manualDelta = compareByManualReadingOrder(left, right, preferPositiveBlockOrder)
    if (manualDelta !== 0) return manualDelta
    const leftPoint = getBlockPoint(left)
    const rightPoint = getBlockPoint(right)
    return leftPoint.top - rightPoint.top || leftPoint.left - rightPoint.left
  })
}

function isHorizontalReaderLineBlock(block: OcrTextBlock): boolean {
  const rect = getBlockRect(block)
  const text = getBlockText(block)
  const label = getBlockLabel(block)
  if (!rect || text.length < 4) return false
  if (isLayoutImageLabel(label) || isTableBlock(block) || isVerticalTextLabel(label) || isDecorativeLayoutBlock(block, text)) return false
  return rect.width >= Math.max(48, rect.height * 2.2) && rect.height <= 96
}

function unionBlockRects(blocks: OcrTextBlock[]): Rect | null {
  const rects = blocks.map(getBlockRect).filter((rect): rect is Rect => rect !== null)
  if (rects.length === 0) return null
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.left + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height))
  return { left, top, width: right - left, height: bottom - top }
}

function mergeReaderLineRun(blocks: OcrTextBlock[]): OcrTextBlock {
  if (blocks.length === 1) return blocks[0]
  const first = blocks[0]
  const words = blocks.map(getBlockDisplayText).filter(Boolean).join('\n')
  const rawWords = blocks.map(getRawOcrBlockText).filter(Boolean).join('\n')
  return {
    ...first,
    words,
    raw_words: rawWords || words,
    location: unionBlockRects(blocks) || first.location,
  }
}

function canMergeReaderLines(run: OcrTextBlock[], next: OcrTextBlock): boolean {
  const previous = run[run.length - 1]
  if (!isHorizontalReaderLineBlock(previous) || !isHorizontalReaderLineBlock(next)) return false
  if (!isLayoutTextLabel(getBlockLabel(previous)) || !isLayoutTextLabel(getBlockLabel(next))) return false
  const previousRect = getBlockRect(previous)
  const nextRect = getBlockRect(next)
  const firstRect = getBlockRect(run[0])
  if (!previousRect || !nextRect || !firstRect) return false
  const verticalGap = nextRect.top - (previousRect.top + previousRect.height)
  if (verticalGap < -Math.max(previousRect.height, nextRect.height) * 0.35) return false
  if (verticalGap > Math.max(10, Math.max(previousRect.height, nextRect.height) * 0.75)) return false
  const startsIndentedParagraph = endsSentence(getBlockText(previous))
    && nextRect.left - firstRect.left > Math.max(12, nextRect.height * 0.75)
  return !startsIndentedParagraph
}

function mergeReaderColumnLines(blocks: OcrTextBlock[]): OcrTextBlock[] {
  const ordered = [...blocks].sort((left, right) => {
    const a = getBlockPoint(left)
    const b = getBlockPoint(right)
    return a.top - b.top || a.left - b.left
  })
  const merged: OcrTextBlock[] = []
  let run: OcrTextBlock[] = []
  const flush = () => {
    if (run.length > 0) merged.push(mergeReaderLineRun(run))
    run = []
  }
  for (const block of ordered) {
    if (run.length === 0 || canMergeReaderLines(run, block)) {
      run.push(block)
    } else {
      flush()
      run.push(block)
    }
  }
  flush()
  return merged
}

function orderReaderColumnBand(blocks: OcrTextBlock[], splitX: number): OcrTextBlock[] {
  const left: OcrTextBlock[] = []
  const right: OcrTextBlock[] = []
  for (const block of blocks) {
    const rect = getBlockRect(block)
    if (!rect || rect.left + rect.width / 2 <= splitX) left.push(block)
    else right.push(block)
  }
  return [...mergeReaderColumnLines(left), ...mergeReaderColumnLines(right)]
}

function inferReadableMultiColumnBlocks(blocks: OcrTextBlock[]): OcrTextBlock[] {
  if (blocks.some((block) => getManualReadingOrder(block) !== null)) return blocks
  const candidates = blocks.filter(isHorizontalReaderLineBlock)
  if (candidates.length < 8) return blocks

  const positioned = candidates
    .map((block) => ({ block, rect: getBlockRect(block) as Rect }))
    .sort((left, right) => (left.rect.left + left.rect.width / 2) - (right.rect.left + right.rect.width / 2))
  let splitIndex = -1
  let largestGap = 0
  for (let index = 1; index < positioned.length; index += 1) {
    const previousCenter = positioned[index - 1].rect.left + positioned[index - 1].rect.width / 2
    const nextCenter = positioned[index].rect.left + positioned[index].rect.width / 2
    const gap = nextCenter - previousCenter
    if (gap > largestGap) {
      largestGap = gap
      splitIndex = index
    }
  }
  if (splitIndex < 3 || positioned.length - splitIndex < 3) return blocks

  const pageLeft = Math.min(...positioned.map((item) => item.rect.left))
  const pageRight = Math.max(...positioned.map((item) => item.rect.left + item.rect.width))
  const pageWidth = Math.max(1, pageRight - pageLeft)
  if (largestGap < Math.max(36, pageWidth * 0.12)) return blocks

  const leftCluster = positioned.slice(0, splitIndex)
  const rightCluster = positioned.slice(splitIndex)
  const leftCenter = leftCluster[leftCluster.length - 1].rect.left + leftCluster[leftCluster.length - 1].rect.width / 2
  const rightCenter = rightCluster[0].rect.left + rightCluster[0].rect.width / 2
  const splitX = (leftCenter + rightCenter) / 2
  let bodyStart = Number.POSITIVE_INFINITY
  for (const left of leftCluster) {
    for (const right of rightCluster) {
      const tolerance = Math.max(left.rect.height, right.rect.height) * 1.35
      if (Math.abs(left.rect.top - right.rect.top) <= tolerance) {
        bodyStart = Math.min(bodyStart, Math.max(left.rect.top, right.rect.top))
      }
    }
  }
  if (!Number.isFinite(bodyStart)) return blocks

  const ordered = [...blocks].sort((left, right) => {
    const a = getBlockPoint(left)
    const b = getBlockPoint(right)
    return a.top - b.top || a.left - b.left
  })
  const preamble = ordered.filter((block) => (getBlockRect(block)?.top ?? Number.POSITIVE_INFINITY) < bodyStart)
  const body = ordered.filter((block) => (getBlockRect(block)?.top ?? Number.NEGATIVE_INFINITY) >= bodyStart)
  const spanning = body.filter((block) => {
    const rect = getBlockRect(block)
    return !!rect
      && rect.width >= pageWidth * 0.58
      && rect.left < splitX
      && rect.left + rect.width > splitX
  })
  const result = [...preamble]
  const consumed = new Set<OcrTextBlock>(preamble)
  for (const separator of spanning) {
    const separatorRect = getBlockRect(separator)
    if (!separatorRect) continue
    const band = body.filter((block) => {
      if (consumed.has(block) || block === separator || spanning.includes(block)) return false
      const top = getBlockRect(block)?.top ?? Number.POSITIVE_INFINITY
      return top < separatorRect.top
    })
    band.forEach((block) => consumed.add(block))
    consumed.add(separator)
    result.push(...orderReaderColumnBand(band, splitX), separator)
  }
  const tail = body.filter((block) => !consumed.has(block))
  result.push(...orderReaderColumnBand(tail, splitX))
  return result
}

function getOrderedBlockText(page: OcrTextPage): string {
  const ordered = getTextFlowOcrBlocks(page)
  if (ordered.length === 0) return ''

  return ordered.map((block) => {
    if (isTableBlock(block)) {
      const rows = getBlockTableRows(block)
      if (rows.length > 0) return tableRowsToText(rows)
    }
    return getBlockText(block)
  }).filter(Boolean).join('\n')
}

function isEbookPage(page: OcrTextPage): boolean {
  const parsed = asOcrResult(page.ocr_result)
  const sourceType = String(parsed?.source_type || '')
  return sourceType === 'ebook_section'
    || sourceType === 'ebook_text'
    || !!parsed?.ebook
    || page?.doc_type === '电子书'
}

function shouldPreferOcrBlocksForReading(page: OcrTextPage, blocks: OcrTextBlock[]): boolean {
  if (blocks.length < 3) return false
  if (isEbookPage(page)) return false
  const parsed = asOcrResult(page.ocr_result)
  const sourceType = String(parsed?.source_type || '')
  const docText = `${page?.doc_type || ''} ${page?.title || ''} ${sourceType}`
  if (/报|報|newspaper|古籍|地方志|hybrid|vision_model_ocr|ocr_layout/i.test(docText)) return true
  const ocrText = String(page?.ocr_text || '').trim()
  const blockText = blocks.map(getBlockText).filter(Boolean).join('')
  return blockText.length >= 80 && ocrText.length > blockText.length * 0.7
}

export function extractPageText(page: OcrTextPage): string {
  const canonicalText = String(page?.canonical_content?.text || '').trim()
  if (canonicalText) return canonicalText

  const blocks = getTextFlowOcrBlocks(page)
  if (shouldPreferOcrBlocksForReading(page, blocks)) {
    const blockText = blocks.map(getBlockText).filter(Boolean).join('\n\n')
    if (blockText.trim()) return blockText
  }

  const proofedText = String(page?.proofed_text || '').trim()
  if (proofedText) return proofedText

  const ocrText = String(page?.ocr_text || '').trim()
  if (ocrText) return ocrText

  return getOrderedBlockText(page)
}

function isNoiseLine(line: string): boolean {
  const compact = line.replace(/\s+/g, '')
  if (!compact) return true
  if (/^(?:第?\d{1,5}[页頁]?|[-_—–]{1,}|[·•.。]{1,})$/.test(compact)) return true
  if (/^(?:page|p\.?)\d{1,5}$/i.test(compact)) return true
  if (/^(?:blankpage|thispageintentionallyleftblank)$/i.test(compact)) return true
  return false
}

function isLikelyBlankText(text: string): boolean {
  const compact = text
    .replace(/\s+/g, '')
    .replace(/[，,。．.、；;：:！？!?'"“”‘’（）()［\][\]【】<>《》·•\-—–_~*#=+|\\/]/g, '')
  if (!compact) return true
  if (/^(?:第?\d{1,5}[页頁]?|[ivxlcdm]{1,8})$/i.test(compact)) return true
  return compact.length <= 1
}

function normalizeLine(line: string): string {
  return line
    .replace(/\u000c/g, '\n')
    .replace(/[\u200b-\u200f\uFEFF]/g, '')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collapseConsecutiveTokenRuns(line: string): string {
  let nextLine = line
  for (let size = 1; size <= 4; size += 1) {
    const pattern = new RegExp(`([\\u4e00-\\u9fff]{${size}})\\1{5,}`, 'g')
    nextLine = nextLine.replace(pattern, '$1')
  }
  return nextLine
}

function suppressOverrepresentedShortTokens(line: string): string {
  const compact = line.replace(/\s+/g, '')
  if (compact.length < 36) return line

  let bestToken = ''
  let bestCount = 0
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      const token = compact.slice(index, index + size)
      if (!/^[\u4e00-\u9fff]+$/.test(token)) continue
      if (/^(.)\1+$/.test(token)) continue
      const count = compact.split(token).length - 1
      if (count > bestCount) {
        bestToken = token
        bestCount = count
      }
    }
  }

  if (!bestToken || bestCount < 8 || bestCount * bestToken.length < compact.length * 0.24) {
    return line
  }

  let seen = 0
  return line
    .replace(new RegExp(escapeRegExp(bestToken), 'g'), (match) => {
      seen += 1
      return seen <= 2 ? match : ''
    })
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function normalizeRepetitiveOcrLine(line: string): string {
  return suppressOverrepresentedShortTokens(collapseConsecutiveTokenRuns(line))
}

function suppressRepeatedShortLines(lines: string[]): string[] {
  const counts = new Map<string, number>()
  return lines.filter((line) => {
    const compact = line.replace(/\s+/g, '')
    if (!/^[\u4e00-\u9fff]{1,4}$/.test(compact)) return true
    const count = counts.get(compact) || 0
    counts.set(compact, count + 1)
    return count < 2
  })
}

function suppressOverrepresentedLines(lines: string[]): string[] {
  if (lines.length < 24) return lines
  const normalizedLines = lines.map((line) => line.replace(/\s+/g, '').trim())
  const totals = new Map<string, number>()
  normalizedLines.forEach((line) => {
    if (line.length >= 4) totals.set(line, (totals.get(line) || 0) + 1)
  })
  const repeatedLines = [...totals.entries()].filter(([, count]) => count >= 4)
  if (repeatedLines.length === 0) return lines
  const repeatedTotal = repeatedLines.reduce((sum, [, count]) => sum + count, 0)
  if (repeatedTotal < lines.length * 0.35) return lines

  const seen = new Map<string, number>()
  return lines.filter((_line, index) => {
    const normalized = normalizedLines[index]
    const total = totals.get(normalized) || 0
    if (normalized.length < 4 || total < 4) return true
    const count = seen.get(normalized) || 0
    seen.set(normalized, count + 1)
    return count < 1
  })
}

function isStructuralLine(line: string): boolean {
  if (line.length <= 2) return false
  if (/^#{1,6}\s+/.test(line)) return true
  if (/^(?:第[一二三四五六七八九十百千万\d]+[章节卷编部篇]|[一二三四五六七八九十\d]+[、.．])/.test(line)) return true
  if (/^(?:摘要|关键词|参考文献|注释|附录|目录|序言|前言|结语|后记)[:：]?$/.test(line)) return true
  if (/^[（(][一二三四五六七八九十\d]+[）)]/.test(line)) return true
  return line.length <= 28 && /[：:]$/.test(line)
}

function isClassicalReaderHeadingLine(line: string): boolean {
  const text = normalizeLine(line).replace(/\s+/g, '')
  if (text.length < 2 || text.length > 22) return false
  if (/^(?:卷(?:之)?[一二两兩三四五六七八九十百千〇零○\d]{1,6}[\u4e00-\u9fff]{0,16}|[\u4e00-\u9fff]{1,18}卷(?:之)?[一二两兩三四五六七八九十百千〇零○\d]{1,6})$/.test(text)) return true
  if (/^(?:凡例|序|原序|自序|跋|目錄|目次|圖|輿圖|舆图|疆域|沿革|星野|山川|城池|公署|官署|營建|营建|營建志|营建志|民政|民政志|職官|职官|選舉|选举|人物|人物志|列女|女貞|女贞|藝文|艺文|藝文志|艺文志|金石|雜志|杂志|災祥|灾祥|書目|书目|補遺|补遗|新城記|新城记)(?:志|表|考|略|記|记|錄|录|目|上|中|下)?$/.test(text)) return true
  return text.length <= 6 && /^[\u4e00-\u9fff]+(?:志|表|考|略|記|记|錄|录|目)$/.test(text)
}

function endsSentence(line: string): boolean {
  return /[。！？!?；;：:]$/.test(line) || /[.!?]$/.test(line)
}

function joinLines(left: string, right: string): string {
  if (/[A-Za-z]-$/.test(left) && /^[A-Za-z]/.test(right)) {
    return `${left.slice(0, -1)}${right}`
  }
  if (/[\u4e00-\u9fff]$/.test(left) && /^[\u4e00-\u9fff]/.test(right)) {
    return `${left}${right}`
  }
  if (/[A-Za-z0-9,;:]$/.test(left) && /^[a-z0-9(]/.test(right)) {
    return `${left} ${right}`
  }
  return `${left} ${right}`
}

export function normalizeOcrTextForReading(value: string): string {
  const source = String(value || '').replace(/\r/g, '\n').replace(/\u000c/g, '\n')
  const lines = suppressOverrepresentedLines(suppressRepeatedShortLines(
    source
      .split(/\n+/)
      .map(normalizeLine)
      .map(normalizeRepetitiveOcrLine)
      .filter((line) => !isNoiseLine(line)),
  ))

  if (isLikelyBlankText(lines.join(''))) return ''

  const paragraphs: string[] = []
  let current = ''

  for (const line of lines) {
    if (!line) continue
    if (isStructuralLine(line)) {
      if (current) paragraphs.push(current)
      paragraphs.push(line)
      current = ''
      continue
    }
    if (!current) {
      current = line
      continue
    }
    const shouldStartNewParagraph = endsSentence(current) && current.length >= 34
    if (shouldStartNewParagraph) {
      paragraphs.push(current)
      current = line
      continue
    }
    current = joinLines(current, line)
  }

  if (current) paragraphs.push(current)
  return paragraphs
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => !isLikelyBlankText(paragraph))
    .join('\n\n')
}

export function getReadablePageText(page: OcrTextPage): string {
  const elements = getReadablePageElements(page)
  if (elements.length > 0) {
    return elements.map((element) => element.type === 'table' && element.rows?.length
      ? tableRowsToText(element.rows)
      : element.text).filter(Boolean).join('\n\n')
  }

  const blocks = getTextFlowOcrBlocks(page)
  if (shouldPreferOcrBlocksForReading(page, blocks)) {
    const blockText = blocks
      .map((block) => normalizeOcrTextForReading(getBlockText(block)))
      .filter(Boolean)
      .join('\n\n')
    if (blockText.trim()) return blockText
  }

  return normalizeOcrTextForReading(extractPageText(page))
}

function isHeadingBlock(block: unknown, text: string): boolean {
  const label = getBlockLabel(block)
  if (isLayoutTextLabel(label)) return false
  return isLayoutHeadingLabel(label) || isStructuralLine(text)
}

function isLongHeadingCandidate(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  return compact.length > 72 || /[。！？!?].{12,}/.test(compact)
}

function splitInlineHeadingParagraph(text: string): { heading: string; body: string } | null {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!isLongHeadingCandidate(normalized)) return null

  const match = normalized.match(/^((?:(?:\d{1,3}|[一二三四五六七八九十百千]+)[、.．]|[（(][一二三四五六七八九十百千\d]+[）)]|第[一二三四五六七八九十百千\d]+[章节篇卷部])[^\n。！？!?]{2,48}[。！？!?])(.{8,})$/)
  if (!match) return null

  const heading = match[1].trim()
  const body = match[2].trim()
  return heading && body ? { heading, body } : null
}

function pushReadableTextElement(
  elements: ReadablePageElement[],
  text: string,
  type: 'heading' | 'paragraph',
  label: string,
  cursor: { value: number },
  displayText?: string,
  rect?: { left: number; top: number; width: number; height: number } | null,
  blockId?: string,
) {
  const normalized = text.trim()
  if (!normalized) return
  const normalizedDisplayText = String(displayText || '').trim()
  const charStart = cursor.value
  elements.push({
    type,
    text: normalized,
    displayText: normalizedDisplayText && normalizeOcrInlineText(normalizedDisplayText) === normalized ? normalizedDisplayText : undefined,
    label,
    blockId,
    rect: rect || undefined,
    charStart,
    charEnd: charStart + normalized.length,
  })
  cursor.value = charStart + normalized.length + 2
}

function pushTocElement(
  elements: ReadablePageElement[],
  text: string,
  label: string,
  cursor: { value: number },
  rect?: { left: number; top: number; width: number; height: number } | null,
  blockId?: string,
): boolean {
  if (!looksLikeTocText(text, label)) return false
  const entries = parseTocEntries(text)
  if (entries.length < 2 && !isTocLabel(label)) return false
  const normalizedText = entries.length > 0
    ? entries.map((entry) => `${entry.title} ${entry.pageLabel}`.trim()).join('\n')
    : String(text || '').trim()
  if (!normalizedText) return false

  const charStart = cursor.value
  elements.push({
    type: 'toc',
    text: normalizedText,
    tocEntries: entries,
    label: label || 'toc',
    blockId,
    rect: rect || undefined,
    charStart,
    charEnd: charStart + normalizedText.length,
  })
  cursor.value = charStart + normalizedText.length + 2
  return true
}

function pushParagraphWithResolvedType(
  elements: ReadablePageElement[],
  paragraph: string,
  type: 'heading' | 'paragraph',
  label: string,
  cursor: { value: number },
  displayParagraph?: string,
  rect?: { left: number; top: number; width: number; height: number } | null,
  blockId?: string,
) {
  const normalized = paragraph.trim()
  if (!normalized) return
  const normalizedDisplay = String(displayParagraph || '').trim()
  const usableDisplay = normalizedDisplay && normalizeOcrInlineText(normalizedDisplay) === normalized ? normalizedDisplay : undefined

  const inlineSplit = splitInlineHeadingParagraph(normalized)
  if (inlineSplit && !usableDisplay) {
    pushReadableTextElement(elements, inlineSplit.heading, 'heading', label, cursor, undefined, rect, blockId)
    pushReadableTextElement(elements, inlineSplit.body, 'paragraph', label, cursor, undefined, rect, blockId)
    return
  }

  if (type === 'heading') {
    pushReadableTextElement(elements, normalized, isLongHeadingCandidate(normalized) ? 'paragraph' : 'heading', label, cursor, usableDisplay, rect, blockId)
    return
  }

  pushReadableTextElement(elements, normalized, isStructuralLine(normalized) ? 'heading' : 'paragraph', label, cursor, usableDisplay, rect, blockId)
}

function pushTextElements(
  elements: ReadablePageElement[],
  text: string,
  type: 'heading' | 'paragraph',
  label: string,
  cursor: { value: number },
  displayText?: string,
  rect?: { left: number; top: number; width: number; height: number } | null,
  blockId?: string,
) {
  const paragraphs = normalizeOcrTextForReading(text).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
  const displayParagraphs = displayText
    ? normalizeOcrTextForReading(displayText).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
    : []
  for (let index = 0; index < paragraphs.length; index += 1) {
    pushParagraphWithResolvedType(elements, paragraphs[index], type, label, cursor, displayParagraphs[index], rect, blockId)
  }
}

function pushVerticalTextElements(
  elements: ReadablePageElement[],
  text: string,
  type: 'heading' | 'paragraph',
  label: string,
  cursor: { value: number },
  displayText?: string,
  rect?: { left: number; top: number; width: number; height: number } | null,
  blockId?: string,
) {
  const lines = String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map(normalizeLine)
    .map(normalizeRepetitiveOcrLine)
    .filter((line) => !isNoiseLine(line))
  if (lines.length === 0) return

  const firstLine = lines[0]
  if (lines.length > 1 && (type === 'heading' || isStructuralLine(firstLine) || isClassicalReaderHeadingLine(firstLine))) {
    pushReadableTextElement(elements, firstLine, 'heading', label, cursor, undefined, rect, blockId)
    const body = normalizeOcrTextForReading(lines.slice(1).join('\n'))
    if (body) pushPlainTextElements(elements, body, 'paragraph', label, cursor, rect, blockId)
    return
  }

  if (lines.length === 1) {
    const displayLine = displayText ? normalizeOcrTextForReading(displayText).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)[0] : undefined
    pushParagraphWithResolvedType(elements, lines[0], type, label, cursor, displayLine, rect, blockId)
    return
  }

  const body = normalizeOcrTextForReading(lines.join('\n'))
  if (body) pushPlainTextElements(elements, body, type, label, cursor, rect, blockId)
}

function pushPlainTextElements(
  elements: ReadablePageElement[],
  text: string,
  type: 'heading' | 'paragraph',
  label: string,
  cursor: { value: number },
  rect?: { left: number; top: number; width: number; height: number } | null,
  blockId?: string,
) {
  const paragraphs = String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n{2,}/)
    .map((item) => item.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
  for (const paragraph of paragraphs) {
    const normalized = paragraph.replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim()
    if (!normalized) continue
    pushParagraphWithResolvedType(elements, normalized, type, label, cursor, undefined, rect, blockId)
  }
}

function pushEbookTextElements(
  elements: ReadablePageElement[],
  text: string,
  type: 'heading' | 'paragraph',
  label: string,
  cursor: { value: number },
) {
  const source = stripHtml(decodeEmbeddedTableMarkup(text)).replace(/\r/g, '\n').trim()
  const rawBlocks = type === 'heading'
    ? source.split(/\n+/)
    : source.includes('\n\n')
      ? source.split(/\n{2,}/)
      : normalizeOcrTextForReading(source).split(/\n{2,}/)
  for (const block of rawBlocks) {
    const normalized = block.replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    pushParagraphWithResolvedType(elements, normalized, type, label, cursor)
  }
}

function normalizeCompactText(value: string): string {
  return String(value || '').replace(/\s+/g, '').trim()
}

function normalizeComparableTitle(value: string): string {
  return normalizeCompactText(value)
    .replace(/^#{1,6}/, '')
    .replace(/[《》「」『』“”‘’"'.,，。；;：:、!！?？（）()\[\]【】\-—–·\s]/g, '')
    .toLowerCase()
}

function isSameHeadingText(left: string, right: string): boolean {
  const a = normalizeComparableTitle(left)
  const b = normalizeComparableTitle(right)
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a))
}

function normalizeEbookSectionTitle(value: string): string {
  return String(value || '')
    .replace(/\s*[（(]\d+[）)]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripEbookRunningTitle(rawText: string, sectionTitle: string): string {
  let text = String(rawText || '').replace(/\r/g, '\n').trim()
  const title = normalizeEbookSectionTitle(sectionTitle)
  if (!text) return ''

  if (title && text.length <= 90 && normalizeCompactText(text) === normalizeCompactText(title)) {
    return ''
  }

  const lines = text.split(/\n+/)
  const firstLine = (lines[0] || '').trim()
  const rest = lines.slice(1).join('\n').trim()
  if (
    title
    && firstLine
    && normalizeCompactText(firstLine) !== normalizeCompactText(title)
    && normalizeCompactText(rest).includes(normalizeCompactText(title))
    && firstLine.length <= 80
  ) {
    text = rest
  }

  if (title && normalizeCompactText(text).startsWith(normalizeCompactText(title))) {
    const directIndex = text.indexOf(title)
    if (directIndex >= 0 && directIndex <= 12) {
      text = text.slice(directIndex + title.length).trim()
    } else {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
      text = text.replace(new RegExp(`^\\s*${escaped}\\s*`), '').trim()
    }
  }

  if (title && text.startsWith(title)) {
    text = text.slice(title.length).trim()
  }

  return text
}

function getEbookBlocks(page: OcrTextPage): OcrTextBlock[] {
  const parsed = asOcrResult(page.ocr_result)
  if (!parsed) return []
  const ebookBlocks = asBlockArray(getPathValue(parsed, ['ebook', 'html_blocks']))
  if (ebookBlocks.length > 0) return ebookBlocks
  const layoutBlocks = asBlockArray(parsed.layout_result)
  if (layoutBlocks.length > 0 && isEbookPage(page)) return layoutBlocks
  return []
}

function getEbookReadableElements(page: OcrTextPage): ReadablePageElement[] {
  const cursor = { value: 0 }
  const elements: ReadablePageElement[] = []
  const blocks = getEbookBlocks(page)
  const parsed = asOcrResult(page.ocr_result)
  const sectionTitle = normalizeEbookSectionTitle(valueToString(getPathValue(parsed, ['ebook', 'title'])).trim())
  let seenMeaningfulContent = false

  for (const block of blocks) {
    const label = getBlockLabel(block)
    const rawType = String(block?.type || block?.label || '').toLowerCase()
    const rows = getBlockTableRows(block)
    if ((rawType === 'table' || rows.length > 0) && rows.length > 0) {
      const text = tableRowsToText(rows)
      const charStart = cursor.value
      elements.push({
        type: 'table',
        text,
        rows,
        label: label || 'ebook_table',
        charStart,
        charEnd: charStart + text.length,
      })
      cursor.value = charStart + text.length + 2
      continue
    }
    const blockText = getBlockText(block)
    if (
      sectionTitle
      && !seenMeaningfulContent
      && (rawType === 'heading' || /^h[1-6]$/.test(rawType))
      && isSameHeadingText(blockText, sectionTitle)
    ) {
      seenMeaningfulContent = true
      continue
    }
    const parts = splitHtmlTables(blockText)
    if (parts.some((part) => part.type === 'table')) {
      for (const part of parts) {
        if (part.type === 'table') {
          const tableRows = parseHtmlTableRows(part.value)
          if (tableRows.length > 0) {
            const text = tableRowsToText(tableRows)
            const charStart = cursor.value
            elements.push({
              type: 'table',
              text,
              rows: tableRows,
              label: label || 'ebook_table',
              charStart,
              charEnd: charStart + text.length,
            })
            cursor.value = charStart + text.length + 2
            continue
          }
        }
        pushEbookTextElements(elements, part.value, rawType === 'heading' || /^h[1-6]$/.test(rawType) ? 'heading' : 'paragraph', label || 'ebook', cursor)
      }
      seenMeaningfulContent = true
      continue
    }
    if (!blockText) continue
    seenMeaningfulContent = true
    pushEbookTextElements(elements, blockText, rawType === 'heading' || /^h[1-6]$/.test(rawType) ? 'heading' : 'paragraph', label || 'ebook', cursor)
  }

  if (elements.length > 0) return elements

  const title = sectionTitle
  const rawText = stripEbookRunningTitle(extractPageText(page), title)
  const firstRawLine = rawText.split(/\n+/).map((line) => line.trim()).find(Boolean) || ''
  if (title && !isSameHeadingText(firstRawLine, title)) pushEbookTextElements(elements, title, 'heading', 'ebook_title', cursor)
  pushEbookTextElements(elements, rawText, 'paragraph', 'ebook_text', cursor)
  return elements
}

export function getReadablePageElements(page: OcrTextPage): ReadablePageElement[] {
  if (isEbookPage(page)) return getEbookReadableElements(page)

  const blocks = getTextFlowOcrBlocks(page)
  const cursor = { value: 0 }
  const elements: ReadablePageElement[] = []
  const layoutBlocks = getLayoutAwareBlocks(page)

  if (layoutBlocks.length > 0) {
    const textFlowLayoutBlocks = getTextFlowOcrBlocks({ ...page, ocr_result: { layout_result: layoutBlocks } })
    for (const block of inferReadableMultiColumnBlocks(textFlowLayoutBlocks)) {
      const label = getBlockLabel(block)
      const blockId = getManualBlockId(block)
      const manualSnapshot = getManualLayoutSignatureSnapshot(block)
      const visualKind = getManualVisualKind(block)
      const rawText = getBlockText(block)
      const displayText = getBlockDisplayText(block)
      const imageRect = getBlockRect(block)
      if ((isLayoutImageLabel(label) || visualKind) && imageRect && imageRect.width > 12 && imageRect.height > 12) {
        const charStart = cursor.value
        const imagePath = String(block?.image_asset_path || block?.asset_path || block?.image_path || '').trim()
        elements.push({
          type: 'image',
          visualKind: visualKind || 'image',
          text: visualKind ? manualSnapshot?.caption || manualSnapshot?.altText || '' : rawText || label || 'image',
          label: label || 'image',
          blockId,
          rect: imageRect,
          imagePath: imagePath || undefined,
          imageCrop: manualSnapshot?.imageCrop,
          caption: manualSnapshot?.caption,
          charStart,
          charEnd: charStart,
        })
        cursor.value = charStart + 2
        continue
      }
      if (!visualKind && isDecorativeLayoutBlock(block, rawText)) continue
      if (rawText && pushTocElement(elements, rawText, label, cursor, imageRect, blockId)) continue
      const rows = getLosslessLayoutTableRows(block) || getBlockTableRows(block)
      if (rows.length > 0) {
        const text = tableRowsToText(rows)
        const charStart = cursor.value
        elements.push({
          type: 'table',
          text,
          rows,
          label: label || 'layout_table',
          blockId,
          rect: imageRect || undefined,
          charStart,
          charEnd: charStart + text.length,
        })
        cursor.value = charStart + text.length + 2
        continue
      }
      const parts = splitHtmlTables(rawText)
      if (parts.some((part) => part.type === 'table')) {
        for (const part of parts) {
          if (part.type === 'table') {
            const tableRows = parseHtmlTableRows(part.value)
            if (tableRows.length > 0) {
              const text = tableRowsToText(tableRows)
              const charStart = cursor.value
              elements.push({
                type: 'table',
                text,
                rows: tableRows,
                label: label || 'layout_table',
                blockId,
                rect: imageRect || undefined,
                charStart,
                charEnd: charStart + text.length,
              })
              cursor.value = charStart + text.length + 2
              continue
            }
          }
          const partType = getLayoutBlockType(block, part.value)
          pushTextElements(elements, part.value, partType === 'table' ? 'paragraph' : partType, label, cursor, undefined, imageRect, blockId)
        }
        continue
      }
      if (!rawText) continue
      const blockType = getLayoutBlockType(block, rawText)
      if (isVerticalTextLabel(label)) {
        pushVerticalTextElements(elements, rawText, blockType === 'table' ? 'paragraph' : blockType, label, cursor, displayText, imageRect, blockId)
      } else {
        pushTextElements(elements, rawText, blockType === 'table' ? 'paragraph' : blockType, label, cursor, displayText, imageRect, blockId)
      }
    }
    if (elements.length > 0) return elements
  }

  if (shouldPreferOcrBlocksForReading(page, blocks)) {
    for (const block of blocks) {
      const label = getBlockLabel(block)
      const blockId = getManualBlockId(block)
      const visualKind = getManualVisualKind(block)
      const blockRect = getBlockRect(block)
      if (visualKind && blockRect && blockRect.width > 12 && blockRect.height > 12) {
        const manualSnapshot = getManualLayoutSignatureSnapshot(block)
        const charStart = cursor.value
        elements.push({
          type: 'image',
          visualKind,
          text: manualSnapshot?.caption || manualSnapshot?.altText || '',
          caption: manualSnapshot?.caption,
          label,
          blockId,
          rect: blockRect,
          imagePath: String(block.image_asset_path || block.asset_path || block.image_path || '').trim() || undefined,
          imageCrop: manualSnapshot?.imageCrop,
          charStart,
          charEnd: charStart,
        })
        cursor.value = charStart + 2
        continue
      }
      if (isTableBlock(block)) {
        const rows = getLosslessLayoutTableRows(block) || getBlockTableRows(block)
        const text = rows.length > 0 ? tableRowsToText(rows) : normalizeOcrTextForReading(getBlockText(block))
        if (!text) continue
        const charStart = cursor.value
        elements.push({
          type: rows.length > 0 ? 'table' : 'paragraph',
          text,
          rows: rows.length > 0 ? rows : undefined,
          label,
          blockId,
          rect: blockRect || undefined,
          charStart,
          charEnd: charStart + text.length,
        })
        cursor.value = charStart + text.length + 2
        continue
      }
      const text = getBlockText(block)
      const displayText = getBlockDisplayText(block)
      if (!text) continue
      if (pushTocElement(elements, text, label, cursor, blockRect, blockId)) continue
      if (isVerticalTextLabel(label)) {
        pushVerticalTextElements(elements, text, isHeadingBlock(block, text) ? 'heading' : 'paragraph', label, cursor, displayText, blockRect, blockId)
      } else {
        pushTextElements(elements, text, isHeadingBlock(block, text) ? 'heading' : 'paragraph', label, cursor, displayText, blockRect, blockId)
      }
    }
    if (elements.length > 0) return elements
  }

  const rawText = extractPageText(page)
  const parts = splitHtmlTables(rawText)
  if (parts.some((part) => part.type === 'table')) {
    for (const part of parts) {
      if (part.type === 'table') {
        const rows = parseHtmlTableRows(part.value)
        if (rows.length === 0) {
          pushTextElements(elements, stripHtml(part.value), 'paragraph', '', cursor)
          continue
        }
        const text = tableRowsToText(rows)
        const charStart = cursor.value
        elements.push({
          type: 'table',
          text,
          rows,
          label: 'html_table',
          charStart,
          charEnd: charStart + text.length,
        })
        cursor.value = charStart + text.length + 2
        continue
      }
      pushTextElements(elements, part.value, 'paragraph', '', cursor)
    }
    return elements
  }

  const text = normalizeOcrTextForReading(rawText)
  if (!text) return []
  if (pushTocElement(elements, rawText, '', cursor)) return elements
  pushTextElements(elements, text, 'paragraph', '', cursor)
  return elements
}
