import { getDataDir, queryAll, queryOne } from './database'
import { extname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { pathToFileURL } from 'url'
import { BrowserWindow, nativeImage } from 'electron'
import { marked } from 'marked'
import OpenCC from 'opencc-js'
import { PDFDocument, rgb, StandardFonts, type PDFImage, type PDFPage, type PDFFont } from 'pdf-lib'
import * as fontkit from '@pdf-lib/fontkit'
import { isTocLabel, looksLikeTocText, parseTocEntries, type TocFormattedEntry } from '../shared/toc-format'
import { deriveOcrTextFromIr, getOrBuildOcrPageIr } from '../shared/ocr-ir'
import { hydratePagePayloadRows } from './page-payload-store'
import type { Document, DocumentExportFormat, DocumentExportOptions } from '../shared/types'

marked.setOptions({
  gfm: true,
  breaks: false,
})

const MAX_VISUAL_PDF_PAGES = 160

interface ExportPage {
  id: string
  page_num: number
  image_path?: string | null
  ocr_text?: string | null
  ocr_result?: string | null
  proofed_text?: string | null
  ocr_text_ref?: string | null
  ocr_result_ref?: string | null
  proofed_text_ref?: string | null
  proof_status?: string | null
}

interface ExportPageOcrVersion {
  page_id: string
  ocr_text?: string | null
  ocr_result?: string | null
  ocr_text_ref?: string | null
  ocr_result_ref?: string | null
}

interface LayoutBlock {
  [key: string]: unknown
  words: string
  displayWords?: string
  label?: string
  reading_order?: number
  column_index?: number
  line_index?: number
  orientation?: 'vertical' | 'horizontal'
  segmentation_source?: string
  slot_count?: number
  needs_enhancement?: boolean
  image_asset_path?: string
  asset_path?: string
  image_path?: string
  tableRows?: string[][]
  location?: {
    left: number
    top: number
    width: number
    height: number
  }
}

type PageBounds = { width: number; height: number; offsetLeft: number; offsetTop: number }

type JsonRecord = Record<string, unknown>
type PdfFontkit = Parameters<PDFDocument['registerFontkit']>[0]

interface OcrLayoutBlockPayload extends JsonRecord {
  raw_words?: unknown
  raw_text?: unknown
  words?: unknown
  word?: unknown
  text?: unknown
  block_content?: unknown
  content?: unknown
  transcription?: unknown
  res?: unknown
  label?: unknown
  block_label?: unknown
  type?: unknown
  block_type?: unknown
  category?: unknown
  class?: unknown
  layout_label?: unknown
  table_rows?: unknown
  tableRows?: unknown
  rows?: unknown
  cells?: unknown
  table_cells?: unknown
  tableCells?: unknown
  location?: unknown
  rect?: unknown
  points?: unknown
  block_bbox?: unknown
  bbox?: unknown
  box?: unknown
  coordinate?: unknown
  coordinate_box?: unknown
  poly?: unknown
  polygon?: unknown
  reading_order?: unknown
  column_index?: unknown
  line_index?: unknown
  orientation?: unknown
  segmentation_source?: unknown
  slot_count?: unknown
  needs_enhancement?: unknown
  image_asset_path?: unknown
  asset_path?: unknown
  image_path?: unknown
}

interface OcrWordPayload extends JsonRecord {
  words?: unknown
}

interface OcrOverallResultPayload extends JsonRecord {
  rec_texts?: unknown[]
  rec_boxes?: unknown[]
  rec_polys?: unknown[]
  dt_polys?: unknown[]
  rec_scores?: unknown[]
}

interface OcrResultPayload extends JsonRecord {
  res?: OcrResultPayload
  prunedResult?: OcrResultPayload
  parsing_res_list?: OcrLayoutBlockPayload[]
  layout_det_res?: JsonRecord & { boxes?: OcrLayoutBlockPayload[] }
  boxes?: OcrLayoutBlockPayload[]
  overall_ocr_res?: OcrOverallResultPayload | null
  layout_result?: OcrLayoutBlockPayload[]
  words_result?: OcrWordPayload[]
  rec_texts?: unknown[]
  rec_boxes?: unknown[]
  rec_polys?: unknown[]
  dt_polys?: unknown[]
  rec_scores?: unknown[]
  guji_processing?: JsonRecord
  source_image_width?: unknown
  source_image_height?: unknown
  image_width?: unknown
  image_height?: unknown
  page_width?: unknown
  page_height?: unknown
  width?: unknown
  height?: unknown
}

type ExportOptions = DocumentExportOptions
type InternalDocumentExportFormat = DocumentExportFormat | 'pdf' | 'html'

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })
const PDF_PAGE_WIDTH = 595.28
const PDF_PAGE_HEIGHT = 841.89
const PDF_FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\STSONG.TTF',
  'C:\\Windows\\Fonts\\NotoSerifSC-VF.ttf',
  'C:\\Windows\\Fonts\\simkai.ttf',
  'C:\\Windows\\Fonts\\simsunb.ttf',
  'C:\\Windows\\Fonts\\simfang.ttf',
  'C:\\Windows\\Fonts\\Deng.ttf',
]

function normalizeFontScale(value: unknown): number {
  const scale = Number(value)
  if (!Number.isFinite(scale)) return 1.1
  return Math.max(0.5, Math.min(1.35, scale))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeXml(value: string): string {
  return escapeHtml(value)
}

function preprocessMarkdown(text: string): string {
  return text
    .replace(/\$\s*\^\{([^}]*)\}\s*\$/g, '<sup>$1</sup>')
    .replace(/\$\s*\^(\S+)\s*\$/g, '<sup>$1</sup>')
    .replace(/\^\{([^}]*)\}/g, '<sup>$1</sup>')
    .replace(/(?<![a-zA-Z])\^(\d+)/g, '<sup>$1</sup>')
    .replace(/\$\s*_\{([^}]*)\}\s*\$/g, '<sub>$1</sub>')
    .replace(/\$\s*_(\S+)\s*\$/g, '<sub>$1</sub>')
}

function normalizeInlineMathToken(value: string): string {
  return String(value || '')
    .replace(/\\dagger/g, '†')
    .replace(/\\ddagger/g, '‡')
    .replace(/\\ast|\\star/g, '*')
    .replace(/\\S/g, '§')
    .replace(/\\P/g, '¶')
    .replace(/\\cdot/g, '·')
    .replace(/\\times/g, '×')
    .replace(/\\alpha/g, 'α')
    .replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\delta/g, 'δ')
}

function renderInlineAnnotationsHtml(text: string): string {
  return renderOcrStyledHtml(text)
}

function transformDisplayScript(text: string, script?: ExportOptions['facsimileDisplayScript'] | ExportOptions['readingDisplayScript']): string {
  if (script === 'simplified') return toSimplified(text)
  if (script === 'traditional') return toTraditional(text)
  return text
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function isCjkChar(char: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(char)
}

function getLastVisibleChar(value: string): string {
  return Array.from(String(value || '').trim()).at(-1) || ''
}

function getFirstVisibleChar(value: string): string {
  return Array.from(String(value || '').trim())[0] || ''
}

function getSoftLineJoiner(previous: string, next: string): string {
  const left = getLastVisibleChar(previous)
  const right = getFirstVisibleChar(next)
  if (!left || !right) return ''
  if (left === '-') return ''
  if (/[,.;:?!%)]/.test(right)) return ''
  if (/[(\[]/.test(left)) return ''
  if (isCjkChar(left) || isCjkChar(right)) return ''
  return ' '
}

function mergeSoftLineBreaks(text: string): string {
  return String(text || '')
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split(/\n+/).map((line) => line.trim()).filter(Boolean)
      if (lines.length <= 1) return lines[0] || ''
      return lines.reduce((merged, line) => `${merged}${getSoftLineJoiner(merged, line)}${line}`)
    })
    .filter(Boolean)
    .join('\n')
}

function getVerticalColumns(text: string): string[] {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const hardLines = source.includes('\n')
    ? source.split(/\n+/)
    : source.split(/[ \t]+/)
  return hardLines
    .map((line) => line.replace(/[ \t]+/g, '').trim())
    .filter(Boolean)
}

function normalizeFacsimileDisplayText(text: string, orientation: 'vertical' | 'horizontal', label: string, options: ExportOptions): string {
  const normalized = String(text || '').replace(/\r\n/g, '\n')
  const displayText = orientation === 'vertical'
    ? getVerticalColumns(normalized).join('\n')
    : mergeSoftLineBreaks(normalized)
      .split('\n')
      .map((part) => part.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
  return transformDisplayScript(displayText, options.facsimileDisplayScript)
}

function parseMaybeJson<T>(value: unknown, fallback: T): T {
  if (!value) return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asLayoutBlocks(value: unknown): OcrLayoutBlockPayload[] {
  return Array.isArray(value) ? value.filter(isJsonRecord).map((item) => item as OcrLayoutBlockPayload) : []
}

function valueText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function firstText(values: readonly unknown[]): string {
  for (const value of values) {
    const text = valueText(value).trim()
    if (text) return text
  }
  return ''
}

function pointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number | null {
  const value = isJsonRecord(point)
    ? Number(point[key])
    : Array.isArray(point)
      ? Number(point[tupleIndex])
      : Number.NaN
  return Number.isFinite(value) ? value : null
}

function metadataText(metadata: JsonRecord, key: string, fallback = ''): string {
  const value = metadata[key]
  return value === undefined || value === null ? fallback : String(value)
}

function getPageText(page: ExportPage): string {
  const proofedText = String(page.proofed_text || '').trim()
  if (proofedText) return proofedText
  const ir = getOrBuildOcrPageIr(page.ocr_result, { pageIndex: Number(page.page_num || 0) || 1 })
  return String((ir ? deriveOcrTextFromIr(ir) : '') || page.ocr_text || '').trim()
}

function getBlockLabel(block: OcrLayoutBlockPayload): string {
  return String(block?.label || block?.block_label || block?.type || '').toLowerCase()
}

function getOrientationLabelText(block: OcrLayoutBlockPayload): string {
  return [
    block?.label,
    block?.block_label,
    block?.type,
    block?.block_type,
    block?.category,
    block?.class,
    block?.layout_label,
  ].map((value) => String(value || '').toLowerCase()).filter(Boolean).join(' ')
}

type OcrInlineStyle = {
  underline?: boolean
  overline?: boolean
  bold?: boolean
  italic?: boolean
  sup?: boolean
  sub?: boolean
}

type OcrInlineSegment = {
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

function parseOcrInlineText(value: string): OcrInlineSegment[] {
  const source = decodeHtmlEntities(String(value || '')).replace(/\r/g, '\n')
  const parts: OcrInlineSegment[] = []
  parseOcrInlineGroup(source, 0, source.length, {}, parts)
  return parts.filter((part) => part.text)
}

function renderOcrStyledHtml(text: string): string {
  return parseOcrInlineText(text).map((segment) => {
    const content = escapeHtml(segment.text)
    const decorations = [
      segment.style.underline ? 'underline' : '',
      segment.style.overline ? 'overline' : '',
    ].filter(Boolean)
    const style = [
      decorations.length ? `text-decoration:${decorations.join(' ')}` : '',
      decorations.length ? 'text-decoration-thickness:0.08em' : '',
      segment.style.underline ? 'text-underline-offset:0.12em' : '',
      segment.style.bold ? 'font-weight:700' : '',
      segment.style.italic ? 'font-style:italic' : '',
    ].filter(Boolean).join(';')
    const styled = style ? `<span style="${style}">${content}</span>` : content
    if (segment.style.sup) return `<sup>${styled}</sup>`
    if (segment.style.sub) return `<sub>${styled}</sub>`
    return styled
  }).join('')
}

function normalizeOcrInlineText(value: string): string {
  return parseOcrInlineText(value).map((segment) => segment.text).join('')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?([，。；：！？、,.!?;:]) ?/g, '$1')
    .trim()
}

function readStructureTupleText(item: unknown): string {
  if (Array.isArray(item)) return valueText(item[0])
  if (isJsonRecord(item)) return firstText([item.text, item.words, item.word, item.value])
  return valueText(item)
}

function readStructureResText(res: unknown): string {
  if (!res) return ''
  if (typeof res === 'string' || typeof res === 'number') return String(res)
  if (Array.isArray(res)) {
    const tupleRec = Array.isArray(res[1]) ? res[1] : []
    const tupleText = tupleRec
      .map(readStructureTupleText)
      .filter(Boolean)
      .join('\n')
    if (tupleText) return tupleText
    return res.map(readStructureResText).filter(Boolean).join('\n')
  }
  if (!isJsonRecord(res)) return ''
  const html = firstText([res.html, res.table_html])
  if (html) return html
  const recRes = asArray(res.rec_res)
  if (recRes.length > 0) {
    return recRes.map(readStructureTupleText).filter(Boolean).join('\n')
  }
  const recTexts = asArray(res.rec_texts)
  if (recTexts.length > 0) return recTexts.map(valueText).filter(Boolean).join('\n')
  return firstText([res.text, res.words, res.content])
}

function getRawBlockWords(block: OcrLayoutBlockPayload): string {
  return firstText([
    block.raw_words,
    block.raw_text,
    block.words,
    block.word,
    block.text,
    block.block_content,
    block.content,
    block.transcription,
    readStructureResText(block.res),
  ])
}

function getBlockWords(block: OcrLayoutBlockPayload): string {
  const text = normalizeOcrInlineText(getRawBlockWords(block))
  if (text) return text
  const rows = getBlockTableRows(block)
  return rows.length > 0 ? rows.map((row) => row.join('\t')).join('\n') : ''
}

function getBlockTableRows(block: OcrLayoutBlockPayload): string[][] {
  const rawRows = block.table_rows || block.tableRows || block.rows || block.cells || block.table_cells || block.tableCells
  if (!Array.isArray(rawRows)) return []
  if (rawRows.every((row) => Array.isArray(row))) {
    return rawRows.map((row) => row.map((cell) => (
      isJsonRecord(cell)
        ? firstText([cell.text, cell.words, cell.word, cell.value])
        : valueText(cell).trim()
    )))
  }
  return []
}

function getBlockRect(block: OcrLayoutBlockPayload): LayoutBlock['location'] | undefined {
  const loc = block.location || block.rect || block.points || block.block_bbox || block.bbox || block.box || block.coordinate || block.coordinate_box || block.poly || block.polygon
  if (!loc) return undefined
  if (isJsonRecord(loc) && (loc.left !== undefined || loc.top !== undefined || loc.width !== undefined || loc.height !== undefined)) {
    const left = Number(loc.left ?? loc.x)
    const top = Number(loc.top ?? loc.y)
    const width = Number(loc.width)
    const height = Number(loc.height)
    if ([left, top, width, height].every(Number.isFinite) && width > 0 && height > 0) return { left, top, width, height }
  }
  if (Array.isArray(loc) && loc.length >= 4) {
    if (typeof loc[0] === 'number') {
      const numbers = loc.map(Number)
      const xs = numbers.length >= 8 ? [numbers[0], numbers[2], numbers[4], numbers[6]] : [numbers[0], numbers[2]]
      const ys = numbers.length >= 8 ? [numbers[1], numbers[3], numbers[5], numbers[7]] : [numbers[1], numbers[3]]
      if ([...xs, ...ys].every(Number.isFinite)) {
        const left = Math.min(...xs)
        const top = Math.min(...ys)
        return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
      }
    }
    const xs = loc.map((point) => pointCoordinate(point, 'x', 0)).filter((value): value is number => value !== null)
    const ys = loc.map((point) => pointCoordinate(point, 'y', 1)).filter((value): value is number => value !== null)
    if (xs.length > 1 && ys.length > 1) {
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
    }
  }
  return undefined
}

function isImageLabel(label: string): boolean {
  return /^(?:image|figure|picture|chart|diagram|photo|illustration)$/i.test(label)
    || /图片|图像|插图|示意图|图表|照片|鍥剧墖|鍥惧儚|鎻掑浘|绀烘剰鍥緗鍥捐〃|鐓х墖/.test(label)
}

function isTableLabel(label: string): boolean {
  return /table|表格|琛ㄦ牸/.test(label)
}

function isTitleLabel(label: string): boolean {
  return /title|heading|题名|标题|篇题|棰樺悕|鏍囬|绡囬/.test(label)
}

function isNoteLabel(label: string): boolean {
  return /note|annotation|footnote|夹注|注文|注释|澶规敞|澶炬敞|娉ㄦ枃|娉ㄩ噴/.test(label)
}

function isDecorativeLabel(label: string): boolean {
  return /header|footer|number|page|seal|stamp|页眉|页脚|页码|印章/.test(label)
}

function isBodyTextLabel(label: string): boolean {
  return /^(?:text|paragraph|body)$/.test(label) || /正文|姝ｆ枃/.test(label)
}

function isExplicitVerticalLabel(label: string): boolean {
  return /vertical[_\s-]*text|col[_\s-]*text|column[_\s-]*text|vertical|竖排|豎排|直排|縦書き|縦組み/i.test(label)
}

function isExplicitHorizontalLabel(label: string): boolean {
  return /horizontal[_\s-]*text|row[_\s-]*text|horizontal|横排|橫排|横書き|横組み/i.test(label)
}

function isNaturallyHorizontalLabel(label: string): boolean {
  const normalized = String(label || '').toLowerCase().replace(/[_-]+/g, ' ')
  return /\b(?:doc title|document title|paragraph title|title|heading|section title|abstract|reference|references|caption|figure caption|table caption|header|footer|number|page number|keyword|keywords|author|journal|date)\b/.test(normalized)
    || /标题|题名|篇题|摘要|关键词|作者|页眉|页脚|页码|参考/.test(normalized)
}

function getBlockImagePath(block: LayoutBlock): string {
  return String(block.image_asset_path || block.asset_path || block.image_path || '').trim()
}

function hasHorizontalTextSignals(block: OcrLayoutBlockPayload): boolean {
  const label = getOrientationLabelText(block)
  if (isExplicitVerticalLabel(label)) return false
  if (isExplicitHorizontalLabel(label)) return true
  if (isNaturallyHorizontalLabel(label)) return true
  const text = getBlockWords(block)
  if (!text) return false
  const compact = text.replace(/\s+/g, '')
  const asciiCount = Array.from(compact).filter((char) => /[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)).length
  const asciiRatio = asciiCount / Math.max(1, compact.length)
  return asciiRatio > 0.18
}

function getVerticalScriptRatio(text: string): number {
  const chars = Array.from(String(text || '').replace(/\s+/g, ''))
  if (chars.length === 0) return 0
  const verticalChars = chars.filter((char) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(char)).length
  return verticalChars / chars.length
}

function isTallVerticalTextBlock(block: OcrLayoutBlockPayload): boolean {
  const label = getOrientationLabelText(block)
  if (isExplicitHorizontalLabel(label)) return false
  const rect = getBlockRect(block)
  const text = getBlockWords(block)
  if (!rect || !text.trim()) return false
  if (rect.height < rect.width * 1.28) return false
  return getVerticalScriptRatio(text) >= 0.42
}

function inferExportOrientation(block: OcrLayoutBlockPayload): 'vertical' | 'horizontal' {
  const label = getOrientationLabelText(block)
  if (block.orientation === 'vertical' || block.orientation === 'horizontal') return block.orientation
  if (isTableLabel(label) || isImageLabel(label) || /caption|abstract|reference|footnote/.test(label)) return 'horizontal'
  if (isExplicitVerticalLabel(label)) return 'vertical'
  if (isExplicitHorizontalLabel(label)) return 'horizontal'
  const rect = getBlockRect(block)
  const stronglyHorizontalShape = !!rect && rect.width >= rect.height * 1.72
  if ((isNaturallyHorizontalLabel(label) || stronglyHorizontalShape) && !isTallVerticalTextBlock(block)) return 'horizontal'
  if (isTallVerticalTextBlock(block)) return 'vertical'
  if (hasHorizontalTextSignals(block)) return 'horizontal'
  if (!rect) return 'horizontal'
  return rect.height >= rect.width * 1.12 ? 'vertical' : 'horizontal'
}

function splitWideVerticalLayoutBlocks(blocks: LayoutBlock[]): LayoutBlock[] {
  const nextBlocks: LayoutBlock[] = []
  blocks.forEach((block, blockIndex) => {
    const rect = block.location
    const label = String(block.label || '').toLowerCase()
    if (
      !rect
      || block.orientation !== 'vertical'
      || isTableLabel(label)
      || isImageLabel(label)
      || isDecorativeLabel(label)
      || rect.width < 72
      || rect.width < rect.height * 0.1
    ) {
      nextBlocks.push(block)
      return
    }

    const rawText = String(block.displayWords || block.words || '')
    const columns = getVerticalColumns(rawText)
    if (columns.length < 2) {
      nextBlocks.push(block)
      return
    }

    const columnWidth = rect.width / columns.length
    if (columnWidth < 12) {
      nextBlocks.push(block)
      return
    }

    columns.forEach((columnText, columnIndex) => {
      nextBlocks.push({
        ...block,
        words: columnText,
        displayWords: columnText,
        reading_order: Number(block.reading_order ?? blockIndex) + columnIndex / 100,
        column_index: columnIndex,
        line_index: 0,
        location: {
          left: rect.left + rect.width - (columnIndex + 1) * columnWidth,
          top: rect.top,
          width: columnWidth,
          height: rect.height,
        },
      })
    })
  })
  return nextBlocks.sort((left, right) => (left.reading_order ?? 0) - (right.reading_order ?? 0))
}

function getSortedLayoutBlocks(page: ExportPage): LayoutBlock[] {
  const parsed = parseMaybeJson<OcrResultPayload | null>(page.ocr_result, null)
  const source = parsed?.res && typeof parsed.res === 'object' ? { ...parsed.res, ...parsed } : parsed
  const parsingBlocks = asLayoutBlocks(source?.parsing_res_list).length > 0
    ? asLayoutBlocks(source?.parsing_res_list)
    : asLayoutBlocks(source?.prunedResult?.parsing_res_list)
  const layoutBoxes = asLayoutBlocks(source?.layout_det_res?.boxes).length > 0
    ? asLayoutBlocks(source?.layout_det_res?.boxes)
    : asLayoutBlocks(source?.boxes)
  const overallOcr = source?.overall_ocr_res || null
  const layoutResult: OcrLayoutBlockPayload[] = asLayoutBlocks(source?.layout_result).length > 0
    ? asLayoutBlocks(source?.layout_result)
    : parsingBlocks.length > 0
      ? parsingBlocks
      : layoutBoxes.length > 0
        ? layoutBoxes
        : asLayoutBlocks(source?.words_result).length > 0
          ? asLayoutBlocks(source?.words_result)
          : Array.isArray(overallOcr?.rec_texts)
            ? overallOcr.rec_texts.map((text, index): OcrLayoutBlockPayload => ({
                words: String(text || ''),
                label: 'text',
                reading_order: index,
                location: (overallOcr.rec_boxes || overallOcr.rec_polys || overallOcr.dt_polys || [])[index],
                score: (overallOcr.rec_scores || [])[index],
              }))
            : Array.isArray(source?.rec_texts)
              ? source.rec_texts.map((text, index): OcrLayoutBlockPayload => ({
                  words: String(text || ''),
                  label: 'text',
                  reading_order: index,
                  location: (source.rec_boxes || source.rec_polys || source.dt_polys || [])[index],
                  score: (source.rec_scores || [])[index],
                }))
              : []

  const blocks = layoutResult
    .map((block, index) => {
      const label = getBlockLabel(block) || 'text'
      const location = getBlockRect(block)

      return {
        words: getBlockWords(block),
        displayWords: getRawBlockWords(block),
        label,
        reading_order: Number.isFinite(Number(block.reading_order)) ? Number(block.reading_order) : index,
        column_index: Number.isFinite(Number(block.column_index)) ? Number(block.column_index) : 0,
        line_index: Number.isFinite(Number(block.line_index)) ? Number(block.line_index) : index,
        orientation: inferExportOrientation(block),
        segmentation_source: valueText(block.segmentation_source) || 'ocr',
        slot_count: Number.isFinite(Number(block.slot_count)) ? Number(block.slot_count) : undefined,
        needs_enhancement: !!block.needs_enhancement,
        image_asset_path: valueText(block.image_asset_path),
        asset_path: valueText(block.asset_path),
        image_path: valueText(block.image_path),
        tableRows: getBlockTableRows(block),
        location,
      } as LayoutBlock
    })
    .filter((block: LayoutBlock) => block.words || (block.location && isImageLabel(String(block.label || ''))))
    .sort((left: LayoutBlock, right: LayoutBlock) => (left.reading_order ?? 0) - (right.reading_order ?? 0))

  if (blocks.some((block: LayoutBlock) => !!block.location)) return splitWideVerticalLayoutBlocks(blocks)

  const textBlocks = blocks.length > 0
    ? blocks
    : getPageText(page)
      .split(/\n{2,}|\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => ({
        words: line,
        label: 'text',
        reading_order: index,
        column_index: 0,
        line_index: index,
        orientation: 'horizontal' as const,
      }))

  return synthesizeFallbackLayoutBlocks(textBlocks)
}

function synthesizeFallbackLayoutBlocks(blocks: LayoutBlock[]): LayoutBlock[] {
  if (blocks.length === 0) return []
  const pageWidth = 1000
  const pageHeight = 1414
  const marginX = 82
  const marginY = 90
  const gap = 18
  const contentWidth = pageWidth - marginX * 2
  const blockHeight = Math.max(34, Math.min(120, (pageHeight - marginY * 2 - gap * Math.max(0, blocks.length - 1)) / Math.max(1, blocks.length)))
  let cursorTop = marginY
  return blocks.map((block, index) => {
    const height = Math.max(34, Math.min(blockHeight, 42 + Math.ceil(getBlockWords(block).length / 42) * 18))
    const nextBlock = {
      ...block,
      reading_order: Number.isFinite(block.reading_order) ? block.reading_order : index,
      orientation: 'horizontal' as const,
      location: {
        left: marginX,
        top: cursorTop,
        width: contentWidth,
        height,
      },
    }
    cursorTop += height + gap
    return nextBlock
  })
}

function hasLayoutBlocks(page: ExportPage): boolean {
  return getSortedLayoutBlocks(page).some((block) => !!block.location && (block.words || isImageLabel(String(block.label || ''))))
}

function withActiveOcrVersions(docId: string, pages: ExportPage[]): ExportPage[] {
  const versions = hydratePagePayloadRows(queryAll<ExportPageOcrVersion>(
    `SELECT page_id, ocr_text, ocr_text_ref, ocr_result, ocr_result_ref
     FROM page_ocr_versions
     WHERE doc_id = ? AND is_active = 1 AND status = ?
     ORDER BY page_num`,
    [docId, 'completed'],
  ))
  if (versions.length === 0) return pages

  const versionByPageId = new Map(versions.map((version) => [version.page_id, version]))
  return pages.map((page) => {
    const version = versionByPageId.get(page.id)
    if (!version?.ocr_result) return page
    const activePage = {
      ...page,
      ocr_text: version.ocr_text || page.ocr_text,
      ocr_result: version.ocr_result,
    }
    return hasLayoutBlocks(page) ? page : activePage
  })
}

function getCoordinateSourceSize(page: ExportPage, fallback?: { width: number; height: number }): { width: number; height: number } | null {
  const parsed = parseMaybeJson<OcrResultPayload>(page.ocr_result, {})
  const candidates = [
    { width: parsed?.guji_processing?.source_image_width, height: parsed?.guji_processing?.source_image_height },
    { width: parsed?.source_image_width, height: parsed?.source_image_height },
    { width: parsed?.image_width, height: parsed?.image_height },
    { width: parsed?.page_width, height: parsed?.page_height },
    { width: parsed?.width, height: parsed?.height },
    fallback,
  ]
  for (const candidate of candidates) {
    const width = Number(candidate?.width || 0)
    const height = Number(candidate?.height || 0)
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height }
  }
  return null
}

function getImageSize(filePath?: string | null): { width: number; height: number } | null {
  const resolvedPath = String(filePath || '').trim()
  if (!resolvedPath || !existsSync(resolvedPath)) return null
  const image = nativeImage.createFromPath(resolvedPath)
  if (image.isEmpty()) return null
  const size = image.getSize()
  return size.width > 0 && size.height > 0 ? size : null
}

function getPageBounds(blocks: LayoutBlock[], page?: ExportPage): PageBounds {
  const imageSize = getImageSize(page?.image_path)
  const coordinateSize = page ? getCoordinateSourceSize(page, imageSize || undefined) : null
  if (coordinateSize) return { ...coordinateSize, offsetLeft: 0, offsetTop: 0 }
  if (blocks.length === 0) return { width: 900, height: 1280, offsetLeft: 0, offsetTop: 0 }

  let minLeft = Number.POSITIVE_INFINITY
  let minTop = Number.POSITIVE_INFINITY
  let maxRight = Number.NEGATIVE_INFINITY
  let maxBottom = Number.NEGATIVE_INFINITY
  blocks.forEach((block) => {
    if (!block.location) return
    minLeft = Math.min(minLeft, block.location.left)
    minTop = Math.min(minTop, block.location.top)
    maxRight = Math.max(maxRight, block.location.left + block.location.width)
    maxBottom = Math.max(maxBottom, block.location.top + block.location.height)
  })
  if (![minLeft, minTop, maxRight, maxBottom].every(Number.isFinite)) return { width: 900, height: 1280, offsetLeft: 0, offsetTop: 0 }

  const contentWidth = Math.max(1, maxRight - minLeft)
  const contentHeight = Math.max(1, maxBottom - minTop)
  const padX = Math.max(24, contentWidth * 0.06)
  const padY = Math.max(24, contentHeight * 0.05)

  return {
    width: Math.ceil(contentWidth + padX * 2),
    height: Math.ceil(contentHeight + padY * 2),
    offsetLeft: minLeft - padX,
    offsetTop: minTop - padY,
  }
}

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff'
  return 'image/jpeg'
}

function imagePathToDataUrl(filePath?: string | null): string {
  const resolvedPath = String(filePath || '').trim()
  if (!resolvedPath || !existsSync(resolvedPath)) return ''
  const buffer = readFileSync(resolvedPath)
  return `data:${getMimeType(resolvedPath)};base64,${buffer.toString('base64')}`
}

function buildFullText(pages: ExportPage[]): string {
  return pages
    .map((page) => {
      const text = getPageText(page)
      return text ? `\n\n=== 第 ${page.page_num} 页 ===\n\n${text}` : ''
    })
    .join('')
    .trim()
}

function getStandardExportHtml(title: string, fullText: string, metadata: JsonRecord): string {
  const processedText = preprocessMarkdown(fullText)
    .replace(/\n{2,}/g, '\n\n')
    .replace(/([^\n])\n([^\n#])/g, '$1\n\n$2')

  const bodyHtml = marked.parse(processedText)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 2cm 2.5cm; }
    * { box-sizing: border-box; }
    body { font-family: 'Noto Serif SC', 'SimSun', 'STSong', serif; font-size: 14px; line-height: 1.8; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 20px; background: #fff; }
    h1 { font-size: 22px; text-align: center; margin-bottom: 8px; border-bottom: 2px solid #333; padding-bottom: 8px; }
    .doc-meta { text-align: center; color: #666; font-size: 13px; margin-bottom: 24px; }
    .doc-meta span { margin: 0 8px; }
    h2 { font-size: 18px; margin: 20px 0 10px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    h3 { font-size: 16px; margin: 16px 0 8px; }
    h4 { font-size: 15px; margin: 12px 0 6px; }
    p { margin: 8px 0; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
    th, td { border: 1px solid #999; padding: 6px 10px; text-align: left; }
    th { background: #f0f0f0; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    sup { font-size: 0.7em; vertical-align: super; color: #d48806; }
    sub { font-size: 0.7em; vertical-align: sub; color: #1890ff; }
    blockquote { border-left: 3px solid #d48806; padding-left: 12px; margin: 8px 0; color: #666; }
    hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
    code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="doc-meta">
    ${metadata.author ? `<span>作者：${escapeHtml(String(metadata.author))}</span>` : ''}
    ${metadata.dynasty ? `<span>朝代：${escapeHtml(String(metadata.dynasty))}</span>` : ''}
    ${metadata.source ? `<span>来源：${escapeHtml(String(metadata.source))}</span>` : ''}
  </div>
  ${bodyHtml}
</body>
</html>`
}

function getReadingThemeStyle(theme?: ExportOptions['readingTheme']): { shell: string; page: string; text: string; muted: string; border: string } {
  if (theme === 'dark') return { shell: '#101112', page: '#1f2226', text: '#e8e2d8', muted: '#9a8f80', border: 'rgba(255,255,255,0.10)' }
  if (theme === 'sepia') return { shell: '#21180f', page: '#f2e0bd', text: '#2d2115', muted: '#8a6534', border: 'rgba(120,80,30,0.20)' }
  return { shell: '#1c1712', page: '#fffaf0', text: '#24190f', muted: '#8a6a3c', border: 'rgba(120,80,30,0.15)' }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.max(min, Math.min(max, numberValue))
}

function getReadingPageTocEntries(page: ExportPage): TocFormattedEntry[] {
  const blocks = getSortedLayoutBlocks(page)
  for (const block of blocks) {
    const label = String(block.label || '')
    const text = block.displayWords || block.words || ''
    if (text && looksLikeTocText(text, label)) {
      const entries = parseTocEntries(text)
      if (entries.length > 0) return entries
    }
  }

  const text = getPageText(page)
  if (!looksLikeTocText(text)) return []
  return parseTocEntries(text)
}

function renderTocEntriesHtml(entries: TocFormattedEntry[], script?: ExportOptions['readingDisplayScript'] | ExportOptions['facsimileDisplayScript']): string {
  if (entries.length === 0) return ''
  return `<div class="toc-list">
    ${entries.map((entry) => {
      const level = clamp(Number(entry.level || 1), 1, 4)
      const title = transformDisplayScript(entry.title, script)
      const pageLabel = transformDisplayScript(entry.pageLabel, script)
      return `<div class="toc-entry toc-level-${level}">
        <span class="toc-title">${renderInlineAnnotationsHtml(title)}</span>
        <span class="toc-leader"></span>
        <span class="toc-page">${escapeHtml(pageLabel)}</span>
      </div>`
    }).join('\n')}
  </div>`
}

function getReadingPageContentHtml(page: ExportPage, options: ExportOptions): string {
  const tocEntries = getReadingPageTocEntries(page)
  if (tocEntries.length > 0) return renderTocEntriesHtml(tocEntries, options.readingDisplayScript)

  const text = getPageText(page)
  const displayText = transformDisplayScript(text, options.readingDisplayScript)
  return displayText ? String(marked.parse(preprocessMarkdown(displayText))) : '<p>本页暂无文本</p>'
}

function getReadingExportHtml(title: string, pages: ExportPage[], metadata: JsonRecord, options: ExportOptions = {}): string {
  const theme = getReadingThemeStyle(options.readingTheme)
  const fontFamily = String(options.readingFontFamily || "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif")
  const fontSize = clampNumber(options.readingFontSize, 17, 13, 26)
  const lineHeight = clampNumber(options.readingLineHeight, 1.9, 1.3, 2.4)
  const pageWidth = clampNumber(options.readingPageWidth, 520, 380, 680)
  const pageHtml = pages.map((page) => {
    const content = getReadingPageContentHtml(page, options)
    return `<section class="reader-page">
      <div class="reader-page-marker">第 ${page.page_num} 页</div>
      ${content}
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 16mm 18mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: ${theme.shell}; }
    body {
      font-family: ${fontFamily};
      font-size: ${fontSize}px;
      line-height: ${lineHeight};
      color: ${theme.text};
      background: ${theme.shell};
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    .reader-document {
      width: min(${pageWidth + 120}px, 100%);
      margin: 0 auto;
      padding: 18px 0;
    }
    .reader-page {
      background: ${theme.page};
      color: ${theme.text};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      padding: 34px 38px;
      margin: 0 auto 18px;
      max-width: ${pageWidth + 76}px;
      min-height: 220px;
      break-inside: avoid;
      page-break-inside: avoid;
      overflow-wrap: break-word;
      box-shadow: 0 8px 26px rgba(0,0,0,0.18);
    }
    .reader-page-marker {
      color: ${theme.muted};
      font-size: 12px;
      margin-bottom: 18px;
      text-align: center;
      user-select: none;
    }
    p { margin: 0 0 0.85em; }
    h1 { font-size: 1.55em; line-height: 1.35; margin: 0.1em 0 0.75em; }
    h2 { font-size: 1.3em; line-height: 1.38; margin: 0.1em 0 0.65em; }
    h3 { font-size: 1.12em; line-height: 1.42; margin: 0.1em 0 0.55em; }
    ul, ol { padding-left: 1.5em; margin: 0 0 0.9em; }
    li { margin: 0.2em 0; }
    blockquote { margin: 0 0 1em; padding: 0.2em 0 0.2em 0.9em; border-left: 3px solid rgba(184,134,83,0.45); }
    table { width: 100%; border-collapse: collapse; margin: 0 0 1em; font-size: 0.92em; }
    th { border: 1px solid rgba(120,80,30,0.28); padding: 4px 6px; background: rgba(120,80,30,0.08); }
    td { border: 1px solid rgba(120,80,30,0.18); padding: 4px 6px; }
    .toc-list { margin: 0.2em 0 1.15em; text-align: left; }
    .toc-entry { display: flex; align-items: baseline; gap: 8px; line-height: 1.65; margin: 0.2em 0; break-inside: avoid; }
    .toc-level-1 { margin-top: 0.55em; font-weight: 700; }
    .toc-level-2 { padding-left: 1.45em; font-weight: 550; }
    .toc-level-3 { padding-left: 2.75em; font-size: 0.96em; }
    .toc-level-4 { padding-left: 4em; font-size: 0.94em; }
    .toc-title { min-width: 0; overflow-wrap: anywhere; }
    .toc-leader { flex: 1; min-width: 18px; border-bottom: 1px dotted currentColor; opacity: 0.5; transform: translateY(-0.2em); }
    .toc-page { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    code { font-family: Consolas, monospace; font-size: 0.92em; background: rgba(120,80,30,0.12); padding: 1px 4px; border-radius: 3px; }
    sup { font-size: 0.72em; line-height: 0; vertical-align: super; color: inherit; }
    sub { font-size: 0.72em; line-height: 0; vertical-align: sub; color: inherit; }
  </style>
</head>
<body>
  <main class="reader-document">
    <section class="reader-page">
      <h1>${escapeHtml(title)}</h1>
      <div class="reader-page-marker">
        ${metadata.author ? `<span>作者：${escapeHtml(String(metadata.author))}</span>` : ''}
        ${metadata.dynasty ? `<span> ${escapeHtml(String(metadata.dynasty))}</span>` : ''}
      </div>
    </section>
    ${pageHtml}
  </main>
</body>
</html>`
}

function getGujiExportHtml(title: string, pages: ExportPage[], metadata: JsonRecord): string {
  const pageHtml = pages.map((page) => {
    const blocks = getSortedLayoutBlocks(page)
    const bounds = getPageBounds(blocks, page)
    const imageUrl = page.image_path ? pathToFileURL(page.image_path).href : ''
    const proofStatus = page.proof_status === 'completed' ? '已校对' : '未校对'

    const blocksHtml = blocks.map((block) => {
      if (!block.location) return ''
      const left = ((block.location.left - bounds.offsetLeft) / bounds.width) * 100
      const top = ((block.location.top - bounds.offsetTop) / bounds.height) * 100
      const width = (block.location.width / bounds.width) * 100
      const height = (block.location.height / bounds.height) * 100
      const writingMode = block.orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb'
      return `<div class="guji-block" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;writing-mode:${writingMode};">${renderOcrStyledHtml(block.displayWords || block.words)}</div>`
    }).join('\n')

    return `<section class="guji-page">
      <div class="guji-page-header"><span>第 ${page.page_num} 页</span><span class="status">${proofStatus}</span></div>
      <div class="guji-canvas" style="aspect-ratio:${bounds.width} / ${bounds.height};">
        ${imageUrl ? `<img class="guji-image" src="${imageUrl}" alt="page-${page.page_num}" />` : ''}
        <div class="guji-overlay">${blocksHtml}</div>
      </div>
      <div class="guji-text">${escapeHtml(getPageText(page))}</div>
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 1.2cm; }
    * { box-sizing: border-box; }
    body { font-family: 'Noto Serif SC', 'SimSun', 'STSong', serif; color: #1a1a1a; margin: 0; padding: 20px; background: #f6f1e7; }
    h1 { text-align: center; margin: 0 0 12px; font-size: 24px; }
    .meta { text-align: center; margin-bottom: 20px; color: #6b5b45; font-size: 13px; }
    .meta span { margin: 0 8px; }
    .guji-page { break-inside: avoid; page-break-inside: avoid; margin: 0 auto 24px; max-width: 980px; background: #fffdf8; border: 1px solid #d6c7a5; border-radius: 10px; padding: 14px; box-shadow: 0 6px 20px rgba(40, 28, 8, 0.08); }
    .guji-page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 13px; color: #6b5b45; }
    .guji-page-header .status { background: #efe3bf; border-radius: 999px; padding: 2px 10px; }
    .guji-canvas { position: relative; width: 100%; overflow: hidden; background: #f8f3e6; border: 1px solid #e2d4b3; border-radius: 6px; }
    .guji-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    .guji-overlay { position: absolute; inset: 0; }
    .guji-block { position: absolute; padding: 2px 3px; background: rgba(255, 251, 240, 0.82); border: 1px solid rgba(107, 91, 69, 0.24); border-radius: 3px; line-height: 1.45; font-size: 14px; text-orientation: mixed; overflow: hidden; white-space: pre-wrap; }
    .guji-text { margin-top: 10px; font-size: 13px; line-height: 1.8; color: #4d4336; border-top: 1px dashed #d9ccb0; padding-top: 10px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    ${metadata.author ? `<span>作者：${escapeHtml(String(metadata.author))}</span>` : ''}
    ${metadata.dynasty ? `<span>朝代：${escapeHtml(String(metadata.dynasty))}</span>` : ''}
    ${metadata.version ? `<span>版本：${escapeHtml(String(metadata.version))}</span>` : ''}
    ${metadata.source ? `<span>来源：${escapeHtml(String(metadata.source))}</span>` : ''}
  </div>
  ${pageHtml}
</body>
</html>`
}

type ExportBlockRect = { width: number; height: number }

function getApproxTextLength(value: string): number {
  return Array.from(String(value || '')).reduce((total, char) => {
    if (/\s/.test(char)) return total + 0.35
    if (/[A-Za-z0-9]/.test(char)) return total + 0.62
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(char)) return total + 1
    return total + 0.55
  }, 0)
}

function measureExportTextWidth(value: string, fontSize: number): number {
  return getApproxTextLength(value) * fontSize
}

function tokenizeExportText(value: string): string[] {
  const tokens: string[] = []
  let latin = ''
  const flushLatin = () => {
    if (latin) {
      tokens.push(latin)
      latin = ''
    }
  }
  for (const char of Array.from(String(value || ''))) {
    if (/\s/.test(char)) {
      flushLatin()
      tokens.push(char)
    } else if (/[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)) {
      latin += char
    } else {
      flushLatin()
      tokens.push(char)
    }
  }
  flushLatin()
  return tokens
}

function wrapExportParagraph(paragraph: string, maxWidth: number, fontSize: number): string[] {
  const source = String(paragraph || '').trim()
  if (!source) return ['']
  const lines: string[] = []
  let current = ''

  for (const token of tokenizeExportText(source)) {
    if (!token) continue
    const isWhitespace = /^\s+$/.test(token)
    const next = isWhitespace
      ? (current && !current.endsWith(' ') ? `${current} ` : current)
      : `${current}${token}`
    if (!current || measureExportTextWidth(next, fontSize) <= maxWidth) {
      current = next
      continue
    }

    if (current.trim()) lines.push(current.trim())
    current = ''

    if (isWhitespace) continue
    if (measureExportTextWidth(token, fontSize) <= maxWidth || Array.from(token).length <= 1) {
      current = token
      continue
    }

    let chunk = ''
    for (const char of Array.from(token)) {
      const candidate = `${chunk}${char}`
      if (chunk && measureExportTextWidth(candidate, fontSize) > maxWidth) {
        lines.push(chunk)
        chunk = char
      } else {
        chunk = candidate
      }
    }
    current = chunk
  }

  if (current.trim()) lines.push(current.trim())
  return lines.length ? lines : ['']
}

function wrapExportText(value: string, maxWidth: number, fontSize: number): string[] {
  return String(value || '').split(/\n+/).flatMap((paragraph) => wrapExportParagraph(paragraph, maxWidth, fontSize))
}

function measureFacsimileTextOverflow(rect: ExportBlockRect, text: string, label: string, fontSize: number, orientation: 'vertical' | 'horizontal'): boolean {
  const padding = getFacsimileBlockPadding(label, orientation)
  const usableWidth = Math.max(4, rect.width - padding * 2 - 2)
  const usableHeight = Math.max(8, rect.height - padding * 2 - 2)
  const lineHeight = getFacsimileBlockLineHeight(label, orientation)

  if (orientation === 'horizontal') {
    const lines = wrapExportText(text, usableWidth, fontSize)
    return lines.length * fontSize * lineHeight > usableHeight + 0.5
  }

  const hardColumns = getVerticalColumns(text)
  const charsPerColumn = Math.max(1, Math.floor(usableHeight / Math.max(1, fontSize * 1.02)))
  const columns = hardColumns.length > 1
    ? hardColumns.length
    : Math.max(1, Math.ceil(getApproxTextLength(text) / charsPerColumn))
  const maxColumnLength = hardColumns.length > 1
    ? Math.max(...hardColumns.map((column) => getApproxTextLength(column)))
    : getApproxTextLength(text)
  return columns * fontSize * lineHeight > usableWidth + 0.5
    || maxColumnLength * fontSize * 1.02 > usableHeight + 0.5
}

function fitFacsimileBlockFontSize(block: LayoutBlock, rect: ExportBlockRect, baseFontSize: number, orientation: 'vertical' | 'horizontal', displayText?: string): number {
  const label = String(block.label || 'text').toLowerCase()
  const text = displayText ?? block.words
  const targetFontSize = getFacsimileBlockFontSize(block, baseFontSize)
  if (!text || !measureFacsimileTextOverflow(rect, text, label, targetFontSize, orientation)) return targetFontSize

  let low = Math.max(2.5, targetFontSize * 0.45)
  let high = targetFontSize
  let best = low

  for (let index = 0; index < 14; index += 1) {
    const mid = (low + high) / 2
    if (measureFacsimileTextOverflow(rect, text, label, mid, orientation)) {
      high = mid
    } else {
      best = mid
      low = mid
    }
  }

  return best
}

function getLayoutPdfHtml(title: string, pages: ExportPage[], options: ExportOptions = {}, forceHorizontal = false): string {
  const fontScale = normalizeFontScale(options.facsimileFontScale)
  const showRules = options.facsimileShowRules !== false
  const pageHtml = pages.map((page) => {
    const blocks = getSortedLayoutBlocks(page)
    const bounds = getPageBounds(blocks, page)
    const pageAspect = bounds.width / Math.max(1, bounds.height)
    const pageWidthPx = Math.max(120, Math.round(Math.min(760, 1086 * pageAspect)))
    const pageHeightPx = Math.round(pageWidthPx / Math.max(0.1, pageAspect))
    const baseFontSize = Math.max(4, Math.min(22, 13 * (pageWidthPx / 760) * fontScale))
    const pageImageDataUrl = imagePathToDataUrl(page.image_path)
    const blocksHtml = blocks.map((block) => {
      if (!block.location) return ''
      const label = String(block.label || 'text').toLowerCase()
      const left = ((block.location.left - bounds.offsetLeft) / bounds.width) * 100
      const top = ((block.location.top - bounds.offsetTop) / bounds.height) * 100
      const width = (block.location.width / bounds.width) * 100
      const height = (block.location.height / bounds.height) * 100
      const isImage = isImageLabel(label)
      const isTable = isTableLabel(label) && (block.tableRows?.length || 0) > 0
      const orientation = forceHorizontal || isTable || isImage ? 'horizontal' : block.orientation === 'vertical' ? 'vertical' : 'horizontal'
      const writingMode = orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb'
      const displayText = normalizeFacsimileDisplayText(block.words, orientation, label, options)
      const scaledRect = {
        width: (block.location.width / bounds.width) * pageWidthPx,
        height: (block.location.height / bounds.height) * pageHeightPx,
      }
      const fontSize = isImage ? getFacsimileBlockFontSize(block, baseFontSize) : fitFacsimileBlockFontSize(block, scaledRect, baseFontSize, orientation, displayText)
      const lineHeight = getFacsimileBlockLineHeight(label, orientation)
      const padding = isImage ? 0 : isTable ? 1 : getFacsimileBlockPadding(label, orientation)
      const ruleStyle = getFacsimileRuleStyle(orientation, showRules)
      const zIndex = isDecorativeLabel(label) ? 2 : 4
      const blockStyle = [
        `left:${left.toFixed(5)}%`,
        `top:${top.toFixed(5)}%`,
        `width:${width.toFixed(5)}%`,
        `height:${height.toFixed(5)}%`,
        `padding:${padding}px`,
        `z-index:${zIndex}`,
        ruleStyle,
      ].filter(Boolean).join(';')

      if (isImage) {
        const assetDataUrl = imagePathToDataUrl(getBlockImagePath(block))
        const imageHtml = assetDataUrl
          ? `<img class="facsimile-image-asset" src="${assetDataUrl}" alt="" />`
          : pageImageDataUrl
            ? `<img class="facsimile-image-crop" src="${pageImageDataUrl}" alt="" style="left:${(-left / Math.max(width, 0.0001) * 100).toFixed(5)}%;top:${(-top / Math.max(height, 0.0001) * 100).toFixed(5)}%;width:${(10000 / Math.max(width, 0.0001)).toFixed(5)}%;height:${(10000 / Math.max(height, 0.0001)).toFixed(5)}%;" />`
            : ''
        return `<div class="facsimile-block facsimile-image-block" style="${blockStyle}">${imageHtml}</div>`
      }

      if (isTable) {
        const rows = block.tableRows || []
        const tableHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineAnnotationsHtml(transformDisplayScript(cell, options.facsimileDisplayScript))}</td>`).join('')}</tr>`).join('')
        return `<div class="facsimile-block facsimile-table-block" style="${blockStyle}"><table style="font-size:${fontSize.toFixed(2)}px;line-height:1.18;">${tableHtml}</table></div>`
      }

      const classNames = [
        'facsimile-block',
        orientation === 'vertical' ? 'facsimile-vertical' : 'facsimile-horizontal',
        isTitleLabel(label) ? 'facsimile-title' : '',
        isDecorativeLabel(label) ? 'facsimile-decorative' : '',
      ].filter(Boolean).join(' ')
      return `<div class="${classNames}" style="${blockStyle}"><div class="facsimile-text" style="writing-mode:${writingMode};font-size:${fontSize.toFixed(2)}px;line-height:${lineHeight};font-weight:${getFacsimileBlockFontWeight(label)};text-align:${isTitleLabel(label) ? 'center' : 'start'};text-indent:${orientation === 'horizontal' && isBodyTextLabel(label) ? '2em' : '0'};">${renderInlineAnnotationsHtml(displayText)}</div></div>`
    }).join('\n')

    return `<section class="layout-page" aria-label="page-${page.page_num}">
      <div class="facsimile-page" style="width:${pageWidthPx}px;height:${pageHeightPx}px;">
        <div class="facsimile-inner-rule"></div>
        ${blocksHtml}
      </div>
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { font-family: 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif; }
    .layout-page {
      width: 794px;
      height: 1122px;
      page-break-after: always;
      break-after: page;
      position: relative;
      overflow: hidden;
      background: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .layout-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .facsimile-page {
      position: relative;
      flex: 0 0 auto;
      background: #fffdf7;
      color: #24190f;
      overflow: hidden;
      box-sizing: border-box;
    }
    .facsimile-inner-rule {
      position: absolute;
      inset: 1.2%;
      border: 1px solid #2d2115;
      pointer-events: none;
    }
    .facsimile-block {
      position: absolute;
      box-sizing: border-box;
      overflow: hidden;
      color: #4a3728;
      background: transparent;
    }
    .facsimile-text {
      width: 100%;
      height: 100%;
      text-orientation: mixed;
      white-space: pre-wrap;
      word-break: break-all;
      overflow-wrap: anywhere;
      letter-spacing: 0;
      overflow: hidden;
    }
    .facsimile-text sup,
    .facsimile-text sub,
    .facsimile-table-block sup,
    .facsimile-table-block sub {
      font-size: 0.72em;
      line-height: 0;
      margin: 0 1px;
    }
    .facsimile-vertical .facsimile-text {
      white-space: pre-wrap;
    }
    .facsimile-title {
      color: #7b3f00;
    }
    .facsimile-decorative {
      color: #8a7662;
    }
    .facsimile-image-block {
      background: rgba(255, 253, 247, 0.5);
    }
    .facsimile-image-asset,
    .facsimile-image-crop {
      position: absolute;
      object-fit: contain;
      pointer-events: none;
      user-select: none;
    }
    .facsimile-image-asset {
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .facsimile-table-block table {
      width: 100%;
      height: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-family: inherit;
    }
    .facsimile-table-block td {
      border: 1px solid rgba(64, 48, 32, 0.24);
      padding: 1px 2px;
      overflow: hidden;
      word-break: break-all;
      vertical-align: top;
    }
  </style>
</head>
<body>
  ${pageHtml}
</body>
</html>`
}

function getImageOnlyLayoutPdfHtml(title: string, pages: ExportPage[]): string {
  const pageHtml = pages.map((page) => {
    const imageDataUrl = imagePathToDataUrl(page.image_path)
    const imageSize = getImageSize(page.image_path)
    const aspect = imageSize ? imageSize.width / Math.max(1, imageSize.height) : 210 / 297
    const pageWidthPx = Math.max(120, Math.round(Math.min(794, 1122 * aspect)))
    const pageHeightPx = Math.round(pageWidthPx / Math.max(0.1, aspect))
    return `<section class="layout-page" aria-label="page-${page.page_num}">
      <img class="layout-page-image" src="${imageDataUrl}" alt="page-${page.page_num}" style="width:${pageWidthPx}px;height:${pageHeightPx}px;" />
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .layout-page {
      width: 794px;
      height: 1122px;
      page-break-after: always;
      break-after: page;
      position: relative;
      overflow: hidden;
      background: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .layout-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .layout-page-image {
      display: block;
      object-fit: contain;
      object-position: center center;
    }
  </style>
</head>
<body>
  ${pageHtml}
</body>
</html>`
}

function getFacsimileBlockFontSize(block: LayoutBlock, baseFontSize: number): number {
  const label = String(block.label || 'text').toLowerCase()
  const ratio = isTitleLabel(label)
    ? 1.08
    : isDecorativeLabel(label)
      ? 0.76
      : isNoteLabel(label)
        ? 0.86
        : isTableLabel(label)
          ? 0.88
          : 1
  const maxSize = isTitleLabel(label) ? 24 : isDecorativeLabel(label) ? 14 : isTableLabel(label) ? 14 : 18
  return Math.max(3.5, Math.min(maxSize, baseFontSize * ratio))
}

function getFacsimileBlockPadding(label: string, orientation: 'vertical' | 'horizontal'): number {
  const base = isDecorativeLabel(label) ? 1 : isNoteLabel(label) ? 2 : 3
  if (isTitleLabel(label)) return 1
  if (orientation === 'horizontal') return Math.max(0, base - 1)
  return base
}

function getFacsimileBlockLineHeight(label: string, orientation: 'vertical' | 'horizontal'): number {
  if (orientation === 'horizontal') return isTitleLabel(label) ? 1.08 : 1.24
  if (isNoteLabel(label)) return 1.02
  return 1.08
}

function getFacsimileBlockFontWeight(label: string): number {
  return isTitleLabel(label) ? 650 : 540
}

function getFacsimileRuleStyle(orientation: 'vertical' | 'horizontal', showRules: boolean): string {
  if (!showRules) return ''
  if (orientation === 'vertical') return 'border-left:1px solid rgba(36,25,15,0.32);border-right:1px solid rgba(36,25,15,0.32)'
  return 'border:1px solid rgba(36,25,15,0.22)'
}

function getTextLayerFontSize(block: LayoutBlock, bounds: { width: number; height: number }): number {
  if (!block.location) return 10
  if (block.orientation === 'vertical') {
    return Math.max(5, Math.min(18, (block.location.width / Math.max(1, bounds.width)) * 210 * 2.9))
  }
  return Math.max(5, Math.min(18, (block.location.height / Math.max(1, bounds.height)) * 297 * 2.4))
}

function getTextLayerBlocksHtml(page: ExportPage): string {
  const blocks = getSortedLayoutBlocks(page)
  const bounds = getPageBounds(blocks, page)
  const positionedBlocks = blocks.map((block) => {
    if (!block.location) return ''
    if (!block.words) return ''
    const left = ((block.location.left - bounds.offsetLeft) / bounds.width) * 100
    const top = ((block.location.top - bounds.offsetTop) / bounds.height) * 100
    const width = (block.location.width / bounds.width) * 100
    const height = (block.location.height / bounds.height) * 100
    const writingMode = block.orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb'
    const fontSize = getTextLayerFontSize(block, bounds)
    return `<div class="text-layer-block" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;writing-mode:${writingMode};font-size:${fontSize.toFixed(2)}pt;">${renderOcrStyledHtml(block.displayWords || block.words)}</div>`
  }).join('\n')

  if (positionedBlocks.trim()) return positionedBlocks

  const pageText = getPageText(page)
  if (!pageText) return ''
  return `<div class="text-layer-page-fallback searchable-fallback">${escapeHtml(pageText)}</div>`
}

function getTextLayerPdfHtml(title: string, pages: ExportPage[]): string {
  const pageHtml = pages.map((page) => {
    const imageDataUrl = imagePathToDataUrl(page.image_path)
    const textLayer = getTextLayerBlocksHtml(page)
    return `<section class="layout-page layout-searchable" aria-label="page-${page.page_num}">
      ${imageDataUrl ? `<img class="layout-page-image" src="${imageDataUrl}" alt="page-${page.page_num}" />` : ''}
      <div class="text-layer">${textLayer}</div>
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { font-family: 'Noto Serif SC', 'SimSun', 'STSong', serif; }
    .layout-page {
      width: 210mm;
      height: 297mm;
      page-break-after: always;
      break-after: page;
      position: relative;
      overflow: hidden;
      background: #fff;
    }
    .layout-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .layout-page-image {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: center center;
      display: block;
    }
    .text-layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      user-select: text;
    }
    .text-layer-block {
      position: absolute;
      padding: 0;
      border: 0;
      line-height: 1.25;
      text-orientation: mixed;
      overflow: hidden;
      white-space: pre-wrap;
      user-select: text;
    }
    .layout-searchable .text-layer-block,
    .layout-searchable .text-layer-page-fallback {
      color: rgba(0, 0, 0, 0.01);
      opacity: 0.01;
      background: transparent;
    }
    .text-layer-page-fallback {
      position: absolute;
      left: 8%;
      right: 8%;
      top: 7%;
      bottom: 7%;
      font-size: 10.5pt;
      line-height: 1.65;
      white-space: pre-wrap;
      overflow: hidden;
      color: #111;
      background: rgba(255, 255, 255, 0.88);
    }
    .searchable-fallback {
      background: transparent;
    }
  </style>
</head>
<body>
  ${pageHtml}
</body>
</html>`
}

type PdfTextToken = { text: string; style: OcrInlineStyle }
type PdfTextLine = PdfTextToken[]

function resolveEditablePdfFontPath(): string {
  return PDF_FONT_CANDIDATES.find((filePath) => existsSync(filePath)) || ''
}

async function embedEditablePdfFont(pdfDoc: PDFDocument): Promise<PDFFont> {
  const fontPath = resolveEditablePdfFontPath()
  if (fontPath) {
    pdfDoc.registerFontkit(fontkit as PdfFontkit)
    return pdfDoc.embedFont(readFileSync(fontPath), { subset: false })
  }
  return pdfDoc.embedFont(StandardFonts.Helvetica)
}

function assertPdfHasNoType3Fonts(exportPath: string, exportLabel: string): void {
  try {
    const pdfText = readFileSync(exportPath, 'latin1')
    if (/\/Subtype\s*\/Type3\b/.test(pdfText)) {
      throw new Error(`${exportLabel} 仍包含 Type 3 字体，WPS PDF 无法直接编辑。请换用系统 TrueType/OpenType 中文字体后重试。`)
    }
  } catch (error) {
    if (error instanceof Error && /Type 3/.test(error.message)) throw error
    console.warn('[Export] Failed to inspect PDF font subtype:', error)
  }
}

async function embedImageFromPath(pdfDoc: PDFDocument, filePath?: string | null): Promise<PDFImage | null> {
  const resolvedPath = String(filePath || '').trim()
  if (!resolvedPath || !existsSync(resolvedPath)) return null
  const ext = extname(resolvedPath).toLowerCase()
  try {
    const buffer = readFileSync(resolvedPath)
    if (ext === '.jpg' || ext === '.jpeg') return await pdfDoc.embedJpg(buffer)
    if (ext === '.png') return await pdfDoc.embedPng(buffer)

    const image = nativeImage.createFromPath(resolvedPath)
    if (!image.isEmpty()) return await pdfDoc.embedPng(image.toPNG())
  } catch (error) {
    console.warn('[Export] Failed to embed image in editable layout PDF:', resolvedPath, error)
  }
  return null
}

async function embedCroppedPageImage(
  pdfDoc: PDFDocument,
  pageImagePath: string | null | undefined,
  block: LayoutBlock,
  bounds: PageBounds,
): Promise<PDFImage | null> {
  const resolvedPath = String(pageImagePath || '').trim()
  if (!resolvedPath || !existsSync(resolvedPath) || !block.location) return null
  try {
    const image = nativeImage.createFromPath(resolvedPath)
    if (image.isEmpty()) return null
    const imageSize = image.getSize()
    if (imageSize.width <= 0 || imageSize.height <= 0) return null
    const leftRatio = (block.location.left - bounds.offsetLeft) / Math.max(1, bounds.width)
    const topRatio = (block.location.top - bounds.offsetTop) / Math.max(1, bounds.height)
    const widthRatio = block.location.width / Math.max(1, bounds.width)
    const heightRatio = block.location.height / Math.max(1, bounds.height)
    const x = clamp(Math.round(leftRatio * imageSize.width), 0, Math.max(0, imageSize.width - 1))
    const y = clamp(Math.round(topRatio * imageSize.height), 0, Math.max(0, imageSize.height - 1))
    const width = clamp(Math.round(widthRatio * imageSize.width), 1, Math.max(1, imageSize.width - x))
    const height = clamp(Math.round(heightRatio * imageSize.height), 1, Math.max(1, imageSize.height - y))
    const cropped = image.crop({ x, y, width, height })
    if (cropped.isEmpty()) return null
    return await pdfDoc.embedPng(cropped.toPNG())
  } catch (error) {
    console.warn('[Export] Failed to crop page image for editable layout PDF:', resolvedPath, error)
    return null
  }
}

function getPdfSafeText(value: string, supportedCodePoints: Set<number>): string {
  const cleaned = String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  if (supportedCodePoints.size === 0) return cleaned
  return Array.from(cleaned).map((char) => supportedCodePoints.has(char.codePointAt(0) || 0) ? char : '□').join('')
}

function getPdfTextSize(fontSize: number, style: OcrInlineStyle): number {
  return fontSize * (style.sup || style.sub ? 0.72 : 1)
}

function measurePdfTokenWidth(font: PDFFont, token: PdfTextToken, fontSize: number): number {
  if (!token.text) return 0
  return font.widthOfTextAtSize(token.text, getPdfTextSize(fontSize, token.style))
}

function tokenizePdfSegments(segments: OcrInlineSegment[]): PdfTextToken[] {
  const tokens: PdfTextToken[] = []
  const push = (text: string, style: OcrInlineStyle) => {
    if (text) tokens.push({ text, style: { ...style } })
  }

  for (const segment of segments) {
    let latin = ''
    const flushLatin = () => {
      if (latin) {
        push(latin, segment.style)
        latin = ''
      }
    }
    for (const char of Array.from(segment.text)) {
      if (char === '\n') {
        flushLatin()
        push('\n', segment.style)
      } else if (/\s/.test(char)) {
        flushLatin()
        push(' ', segment.style)
      } else if (/[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)) {
        latin += char
      } else {
        flushLatin()
        push(char, segment.style)
      }
    }
    flushLatin()
  }
  return tokens
}

function wrapPdfTextLines(font: PDFFont, text: string, fontSize: number, maxWidth: number, supportedCodePoints: Set<number>): PdfTextLine[] {
  const tokens = tokenizePdfSegments(parseOcrInlineText(getPdfSafeText(text, supportedCodePoints)))
  const lines: PdfTextLine[] = []
  let current: PdfTextLine = []
  let currentWidth = 0

  const pushLine = () => {
    while (current.length > 0 && /^\s+$/.test(current[current.length - 1].text)) current.pop()
    if (current.length > 0) lines.push(current)
    current = []
    currentWidth = 0
  }

  for (const token of tokens) {
    if (token.text === '\n') {
      pushLine()
      continue
    }
    const isSpace = /^\s+$/.test(token.text)
    if (isSpace && current.length === 0) continue
    const width = measurePdfTokenWidth(font, token, fontSize)
    if (current.length > 0 && currentWidth + width > maxWidth) {
      pushLine()
      if (isSpace) continue
    }
    current.push(token)
    currentWidth += width
  }
  pushLine()
  return lines
}

function drawPdfHorizontalText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  rect: { x: number; y: number; width: number; height: number },
  fontSize: number,
  lineHeight: number,
  supportedCodePoints: Set<number>,
  options: { color?: ReturnType<typeof rgb>; indentFirstLine?: boolean; center?: boolean } = {},
) {
  const padding = Math.max(1.5, Math.min(4, fontSize * 0.22))
  const lineHeightPt = fontSize * lineHeight
  const maxWidth = Math.max(1, rect.width - padding * 2 - (options.indentFirstLine ? fontSize * 2 : 0))
  const lines = wrapPdfTextLines(font, text, fontSize, maxWidth, supportedCodePoints)
  const maxLines = Math.max(1, Math.floor((rect.height - padding * 1.5) / Math.max(1, lineHeightPt)))
  const visibleLines = lines.slice(0, maxLines)
  visibleLines.forEach((line, lineIndex) => {
    const indent = options.indentFirstLine && lineIndex === 0 ? fontSize * 2 : 0
    const lineWidth = line.reduce((sum, token) => sum + measurePdfTokenWidth(font, token, fontSize), 0)
    let cursorX = rect.x + padding + indent
    if (options.center) cursorX = rect.x + Math.max(padding, (rect.width - lineWidth) / 2)
    const baselineY = rect.y + rect.height - padding - fontSize - lineIndex * lineHeightPt
    line.forEach((token) => {
      const size = getPdfTextSize(fontSize, token.style)
      const yOffset = token.style.sup ? fontSize * 0.36 : token.style.sub ? -fontSize * 0.2 : 0
      page.drawText(token.text, {
        x: cursorX,
        y: baselineY + yOffset,
        size,
        font,
        color: options.color || rgb(0.16, 0.1, 0.06),
      })
      cursorX += measurePdfTokenWidth(font, token, fontSize)
    })
  })
}

function fitPdfSingleLineText(font: PDFFont, text: string, fontSize: number, maxWidth: number, supportedCodePoints: Set<number>): string {
  const safeText = getPdfSafeText(text, supportedCodePoints).replace(/\s+/g, ' ').trim()
  if (!safeText || font.widthOfTextAtSize(safeText, fontSize) <= maxWidth) return safeText
  const ellipsis = '...'
  const ellipsisWidth = font.widthOfTextAtSize(ellipsis, fontSize)
  let result = ''
  for (const char of Array.from(safeText)) {
    const candidate = `${result}${char}`
    if (font.widthOfTextAtSize(candidate, fontSize) + ellipsisWidth > maxWidth) break
    result = candidate
  }
  return result ? `${result}${ellipsis}` : ''
}

function drawPdfTocEntries(
  page: PDFPage,
  font: PDFFont,
  entries: TocFormattedEntry[],
  rect: { x: number; y: number; width: number; height: number },
  fontSize: number,
  supportedCodePoints: Set<number>,
  color = rgb(0.29, 0.22, 0.16),
) {
  if (entries.length === 0) return
  const padding = Math.max(1.5, Math.min(4, fontSize * 0.22))
  const lineHeightPt = fontSize * 1.38
  const maxLines = Math.max(1, Math.floor((rect.height - padding * 1.5) / Math.max(1, lineHeightPt)))
  const visibleEntries = entries.slice(0, maxLines)

  visibleEntries.forEach((entry, index) => {
    const level = clamp(Number(entry.level || 1), 1, 4)
    const baselineY = rect.y + rect.height - padding - fontSize - index * lineHeightPt
    const indent = (level - 1) * fontSize * 1.55
    const entryFontSize = level === 1 ? fontSize * 1.02 : fontSize * 0.96
    const pageLabel = getPdfSafeText(entry.pageLabel, supportedCodePoints)
    const pageWidth = font.widthOfTextAtSize(pageLabel, entryFontSize)
    const leftX = rect.x + padding + indent
    const pageX = rect.x + rect.width - padding - pageWidth
    const titleMaxWidth = Math.max(fontSize * 2, pageX - leftX - fontSize * 1.6)
    const title = fitPdfSingleLineText(font, entry.title, entryFontSize, titleMaxWidth, supportedCodePoints)
    const titleWidth = font.widthOfTextAtSize(title, entryFontSize)

    page.drawText(title, { x: leftX, y: baselineY, size: entryFontSize, font, color })
    if (pageLabel) {
      const leaderStart = leftX + titleWidth + fontSize * 0.45
      const leaderEnd = pageX - fontSize * 0.45
      if (leaderEnd > leaderStart + fontSize) {
        page.drawLine({
          start: { x: leaderStart, y: baselineY + fontSize * 0.32 },
          end: { x: leaderEnd, y: baselineY + fontSize * 0.32 },
          thickness: 0.45,
          color,
          opacity: 0.55,
          dashArray: [1, 2],
        })
      }
      page.drawText(pageLabel, { x: pageX, y: baselineY, size: entryFontSize, font, color })
    }
  })
}

function drawPdfVerticalText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  rect: { x: number; y: number; width: number; height: number },
  fontSize: number,
  lineHeight: number,
  supportedCodePoints: Set<number>,
  color = rgb(0.16, 0.1, 0.06),
) {
  const padding = Math.max(1.5, Math.min(4, fontSize * 0.22))
  const stepY = fontSize * 1.04
  const stepX = fontSize * lineHeight
  let cursorX = rect.x + rect.width - padding - fontSize
  const startY = rect.y + rect.height - padding - fontSize
  let cursorY = startY
  const minY = rect.y + padding
  const minX = rect.x + padding
  const columns = getVerticalColumns(text)
  const sourceColumns = columns.length > 0 ? columns : [String(text || '').replace(/\s+/g, '')]
  for (const column of sourceColumns) {
    cursorY = startY
    for (const char of Array.from(getPdfSafeText(column, supportedCodePoints))) {
      if (!char.trim()) continue
      if (cursorY < minY) {
        cursorY = startY
        cursorX -= stepX
      }
      if (cursorX < minX) break
      page.drawText(char, {
        x: cursorX,
        y: cursorY,
        size: fontSize,
        font,
        color,
      })
      cursorY -= stepY
    }
    cursorX -= stepX
    if (cursorY < minY) {
      cursorY = startY
    }
    if (cursorX < minX) break
  }
}

function drawPdfTableText(
  page: PDFPage,
  font: PDFFont,
  rows: string[][],
  rect: { x: number; y: number; width: number; height: number },
  fontSize: number,
  supportedCodePoints: Set<number>,
) {
  const rowCount = Math.max(1, rows.length)
  const colCount = Math.max(1, ...rows.map((row) => row.length))
  const rowHeight = rect.height / rowCount
  const colWidth = rect.width / colCount
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      const cellRect = {
        x: rect.x + colWidth * colIndex,
        y: rect.y + rect.height - rowHeight * (rowIndex + 1),
        width: colWidth,
        height: rowHeight,
      }
      page.drawRectangle({
        x: cellRect.x,
        y: cellRect.y,
        width: cellRect.width,
        height: cellRect.height,
        borderColor: rgb(0.45, 0.36, 0.25),
        borderWidth: 0.35,
        opacity: 0,
        borderOpacity: 0.35,
      })
      drawPdfHorizontalText(page, font, cell, cellRect, fontSize, 1.18, supportedCodePoints)
    })
  })
}

async function exportLayoutPdfNative(
  title: string,
  pages: ExportPage[],
  exportPath: string,
  options: ExportOptions = {},
  forceHorizontal = false,
): Promise<boolean> {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.setTitle(title || '文献内容')
  pdfDoc.setCreator('GujiSmart Native Layout PDF Exporter')
  pdfDoc.setProducer('GujiSmart Native Layout PDF Exporter')
  pdfDoc.setSubject('layout-pdf-native-no-type3')
  pdfDoc.setKeywords(['GujiSmart', 'layout-pdf', 'native-font', 'no-type3'])
  const font = await embedEditablePdfFont(pdfDoc)
  const supportedCodePoints = new Set(font.getCharacterSet())
  const imageCache = new Map<string, PDFImage | null>()
  const getEmbeddedImage = async (filePath?: string | null) => {
    const key = String(filePath || '').trim()
    if (!key) return null
    if (!imageCache.has(key)) imageCache.set(key, await embedImageFromPath(pdfDoc, key))
    return imageCache.get(key) || null
  }

  const fontScale = normalizeFontScale(options.facsimileFontScale)
  const showRules = options.facsimileShowRules !== false

  for (const sourcePage of pages) {
    const pdfPage = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
    const blocks = getSortedLayoutBlocks(sourcePage)
    const bounds = getPageBounds(blocks, sourcePage)
    const pageAspect = bounds.width / Math.max(1, bounds.height)
    let pageWidth = Math.min(PDF_PAGE_WIDTH * 0.96, PDF_PAGE_HEIGHT * 0.96 * pageAspect)
    let pageHeight = pageWidth / Math.max(0.1, pageAspect)
    if (pageHeight > PDF_PAGE_HEIGHT * 0.96) {
      pageHeight = PDF_PAGE_HEIGHT * 0.96
      pageWidth = pageHeight * pageAspect
    }
    const pageX = (PDF_PAGE_WIDTH - pageWidth) / 2
    const pageY = (PDF_PAGE_HEIGHT - pageHeight) / 2
    const baseFontSize = clamp(13 * (pageWidth / 570) * fontScale, 4, 22)

    pdfPage.drawRectangle({
      x: pageX,
      y: pageY,
      width: pageWidth,
      height: pageHeight,
      color: rgb(1, 0.992, 0.969),
    })
    pdfPage.drawRectangle({
      x: pageX + pageWidth * 0.012,
      y: pageY + pageHeight * 0.012,
      width: pageWidth * 0.976,
      height: pageHeight * 0.976,
      borderColor: rgb(0.18, 0.13, 0.08),
      borderWidth: 0.6,
      opacity: 0,
      borderOpacity: 0.85,
    })

    for (const block of blocks) {
      if (!block.location) continue
      const label = String(block.label || 'text').toLowerCase()
      const left = ((block.location.left - bounds.offsetLeft) / bounds.width) * pageWidth
      const top = ((block.location.top - bounds.offsetTop) / bounds.height) * pageHeight
      const width = (block.location.width / bounds.width) * pageWidth
      const height = (block.location.height / bounds.height) * pageHeight
      const rect = {
        x: pageX + left,
        y: pageY + pageHeight - top - height,
        width,
        height,
      }
      const isImage = isImageLabel(label)
      const isTable = isTableLabel(label) && (block.tableRows?.length || 0) > 0
      const orientation = forceHorizontal || isTable || isImage ? 'horizontal' : block.orientation === 'vertical' ? 'vertical' : 'horizontal'
      const displayText = normalizeFacsimileDisplayText(block.words, orientation, label, options)
      const scaledRect = { width, height }
      const fontSize = isImage
        ? getFacsimileBlockFontSize(block, baseFontSize)
        : fitFacsimileBlockFontSize(block, scaledRect, baseFontSize, orientation, displayText)
      const lineHeight = getFacsimileBlockLineHeight(label, orientation)

      if (showRules && !isImage) {
        pdfPage.drawRectangle({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          borderColor: rgb(0.18, 0.13, 0.08),
          borderWidth: orientation === 'vertical' ? 0.45 : 0.35,
          opacity: 0,
          borderOpacity: orientation === 'vertical' ? 0.32 : 0.22,
        })
      }

      if (isImage) {
        const image = await getEmbeddedImage(getBlockImagePath(block))
          || await embedCroppedPageImage(pdfDoc, sourcePage.image_path, block, bounds)
        if (image) {
          pdfPage.drawImage(image, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        }
        continue
      }

      const color = isTitleLabel(label)
        ? rgb(0.48, 0.25, 0)
        : isDecorativeLabel(label)
          ? rgb(0.54, 0.46, 0.38)
          : rgb(0.29, 0.22, 0.16)

      if (isTable) {
        drawPdfTableText(pdfPage, font, block.tableRows || [], rect, fontSize, supportedCodePoints)
      } else if (looksLikeTocText(displayText, label)) {
        const tocEntries = parseTocEntries(displayText)
        if (tocEntries.length > 0) {
          drawPdfTocEntries(pdfPage, font, tocEntries, rect, fontSize, supportedCodePoints, color)
        } else {
          drawPdfHorizontalText(pdfPage, font, displayText, rect, fontSize, lineHeight, supportedCodePoints, { color })
        }
      } else if (orientation === 'vertical') {
        drawPdfVerticalText(pdfPage, font, displayText, rect, fontSize, lineHeight, supportedCodePoints, color)
      } else {
        drawPdfHorizontalText(pdfPage, font, displayText, rect, fontSize, lineHeight, supportedCodePoints, {
          color,
          indentFirstLine: isBodyTextLabel(label),
          center: isTitleLabel(label),
        })
      }
    }
  }

  const pdfBytes = await pdfDoc.save({ useObjectStreams: false })
  writeFileSync(exportPath, Buffer.from(pdfBytes))
  assertPdfHasNoType3Fonts(exportPath, '排版模式 PDF')
  return true
}

async function exportImageOnlyLayoutPdfNative(title: string, pages: ExportPage[], exportPath: string): Promise<boolean> {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.setTitle(title || '文献内容')
  pdfDoc.setCreator('GujiSmart Native Image PDF Exporter')
  pdfDoc.setProducer('GujiSmart Native Image PDF Exporter')
  pdfDoc.setSubject('layout-pdf-native-image-only-no-type3')
  pdfDoc.setKeywords(['GujiSmart', 'layout-pdf', 'native-image', 'no-type3'])

  for (const sourcePage of pages) {
    const pdfPage = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
    const image = await embedImageFromPath(pdfDoc, sourcePage.image_path)
    const imageSize = getImageSize(sourcePage.image_path)
    const aspect = imageSize ? imageSize.width / Math.max(1, imageSize.height) : 210 / 297
    let pageWidth = Math.min(PDF_PAGE_WIDTH * 0.96, PDF_PAGE_HEIGHT * 0.96 * aspect)
    let pageHeight = pageWidth / Math.max(0.1, aspect)
    if (pageHeight > PDF_PAGE_HEIGHT * 0.96) {
      pageHeight = PDF_PAGE_HEIGHT * 0.96
      pageWidth = pageHeight * aspect
    }
    const pageX = (PDF_PAGE_WIDTH - pageWidth) / 2
    const pageY = (PDF_PAGE_HEIGHT - pageHeight) / 2
    if (image) {
      pdfPage.drawImage(image, { x: pageX, y: pageY, width: pageWidth, height: pageHeight })
    }
  }

  const pdfBytes = await pdfDoc.save({ useObjectStreams: false })
  writeFileSync(exportPath, Buffer.from(pdfBytes))
  assertPdfHasNoType3Fonts(exportPath, '排版模式 PDF')
  return true
}

function buildGujiTei(doc: Pick<Document, 'title' | 'author'>, pages: ExportPage[], metadata: JsonRecord): string {
  const facsimile = pages.map((page) => {
    const blocks = getSortedLayoutBlocks(page)
    const imageUrl = page.image_path ? pathToFileURL(page.image_path).href : ''
    const zones = blocks.map((block, index) => {
      if (!block.location) return ''
      const ulx = Math.round(block.location.left)
      const uly = Math.round(block.location.top)
      const lrx = Math.round(block.location.left + block.location.width)
      const lry = Math.round(block.location.top + block.location.height)
      return `<zone xml:id="p${page.page_num}-z${index + 1}" type="${escapeXml(block.label || 'text')}" rendition="${escapeXml(block.orientation || 'horizontal')}" ulx="${ulx}" uly="${uly}" lrx="${lrx}" lry="${lry}" />`
    }).join('\n        ')

    return `<surface xml:id="surface-${page.page_num}" n="${page.page_num}" ana="${escapeXml(page.proof_status === 'completed' ? 'proofed' : 'pending')}">
        ${imageUrl ? `<graphic url="${escapeXml(imageUrl)}" />` : ''}
        ${zones}
      </surface>`
  }).join('\n      ')

  const body = pages.map((page) => {
    const blocks = getSortedLayoutBlocks(page)
    const segments = blocks.map((block, index) => `<ab facs="#p${page.page_num}-z${index + 1}" ana="${escapeXml(block.orientation || 'horizontal')}">${escapeXml(block.words)}</ab>`).join('\n        ')
    return `<div type="page" n="${page.page_num}" ana="${escapeXml(page.proof_status === 'completed' ? 'proofed' : 'pending')}">
        <pb n="${page.page_num}" />
        ${segments || `<p>${escapeXml(getPageText(page))}</p>`}
      </div>`
  }).join('\n      ')

  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>${escapeXml(doc.title || '未命名文献')}</title>
        <author>${escapeXml(doc.author || '未知')}</author>
      </titleStmt>
      <publicationStmt><p>Exported by 文献管理（GujiSmart）</p></publicationStmt>
      <sourceDesc><p>${escapeXml(metadataText(metadata, 'source', '未知来源'))}</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <facsimile>
      ${facsimile}
  </facsimile>
  <text>
    <body>
      <div type="guji" subtype="${escapeXml(metadataText(metadata, 'version'))}">
      ${body}
      </div>
    </body>
  </text>
</TEI>`
}

function buildGujiPageXml(doc: Pick<Document, 'title'>, pages: ExportPage[]): string {
  const pageNodes = pages.map((page) => {
    const blocks = getSortedLayoutBlocks(page)
    const bounds = getPageBounds(blocks, page)
    const imageUrl = page.image_path ? pathToFileURL(page.image_path).href : ''
    const regionNodes = blocks.map((block, index) => {
      if (!block.location) return ''
      const left = Math.round(block.location.left)
      const top = Math.round(block.location.top)
      const right = Math.round(block.location.left + block.location.width)
      const bottom = Math.round(block.location.top + block.location.height)
      const coords = `${left},${top} ${right},${top} ${right},${bottom} ${left},${bottom}`
      return `<TextRegion id="r_${page.page_num}_${index + 1}" type="${escapeXml(block.label || 'text')}" custom="column:${block.column_index ?? 0};line:${block.line_index ?? index};orientation:${block.orientation || 'horizontal'};source:${block.segmentation_source || 'ocr'};slots:${block.slot_count || 0};needsEnhancement:${block.needs_enhancement ? 'true' : 'false'}">
        <Coords points="${coords}" />
        <TextLine id="l_${page.page_num}_${index + 1}">
          <Coords points="${coords}" />
          <TextEquiv><Unicode>${escapeXml(block.words)}</Unicode></TextEquiv>
        </TextLine>
      </TextRegion>`
    }).join('\n      ')

    return `<Page imageFilename="${escapeXml(imageUrl || `page_${page.page_num}.jpg`)}" imageWidth="${bounds.width}" imageHeight="${bounds.height}" custom="proof:${escapeXml(page.proof_status === 'completed' ? 'completed' : 'pending')}">
      ${regionNodes}
    </Page>`
  }).join('\n  ')

  return `<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Metadata>
    <Creator>文献管理（GujiSmart）</Creator>
    <Created>${new Date().toISOString()}</Created>
    <LastChange>${new Date().toISOString()}</LastChange>
    <Comments>${escapeXml(String(doc.title || '未命名文献'))}</Comments>
  </Metadata>
  ${pageNodes}
</PcGts>`
}

function buildPaddleJsonExport(
  doc: Pick<Document, 'id' | 'title' | 'author' | 'dynasty' | 'doc_type'>,
  pages: ExportPage[],
  metadata: JsonRecord,
): string {
  return JSON.stringify({
    source: '文献管理（GujiSmart）',
    export_type: 'paddle-json',
    exported_at: new Date().toISOString(),
    document: {
      id: doc.id,
      title: doc.title || '',
      author: doc.author || '',
      dynasty: doc.dynasty || '',
      source: metadataText(metadata, 'source'),
      doc_type: doc.doc_type || 'unknown',
      page_count: pages.length,
    },
    pages: pages.map((page, index) => {
      const parsed = parseMaybeJson<OcrResultPayload>(page.ocr_result, {})
      const layoutResult = Array.isArray(parsed?.layout_result) ? parsed.layout_result : []
      const wordsResult = Array.isArray(parsed?.words_result) ? parsed.words_result : []
      const recTexts = layoutResult.length > 0
        ? layoutResult.map((block) => String(block.words || ''))
        : wordsResult.map((item) => String(item.words || ''))
      const recBoxes = layoutResult
        .filter((block) => block?.location)
        .map((block) => {
          const location = isJsonRecord(block.location) ? block.location : {}
          const left = Number(location.left || 0)
          const top = Number(location.top || 0)
          const width = Number(location.width || 0)
          const height = Number(location.height || 0)
          return [left, top, left + width, top + height]
        })

      return {
        page_index: index,
        page_num: page.page_num,
        image_path: page.image_path || null,
        proof_status: page.proof_status || 'pending',
        ocr_text: getPageText(page),
        rec_texts: recTexts,
        rec_boxes: recBoxes,
        ocr_result: parsed,
      }
    }),
  }, null, 2)
}

async function exportPdfFromHtml(htmlContent: string, exportPath: string): Promise<boolean> {
  const tempDir = join(getDataDir(), 'temp')
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true })

  const tempHtmlPath = join(tempDir, `_export_${Date.now()}.html`)
  writeFileSync(tempHtmlPath, htmlContent, 'utf-8')

  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      width: 1000,
      height: 1280,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    await win.loadFile(tempHtmlPath)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 12000)
      win!.webContents.once('did-fail-load', (_event, _code, description) => {
        clearTimeout(timer)
        reject(new Error(description || '导出页面加载失败'))
      })
      win!.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
      if (!win || win.isDestroyed()) {
        clearTimeout(timer)
        reject(new Error('导出窗口已关闭'))
      }
    })

    await win.webContents.executeJavaScript(`
      Promise.race([
        Promise.all(Array.from(document.images).map((img) => img.complete
          ? true
          : new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            })
        )),
        new Promise((resolve) => setTimeout(resolve, 8000))
      ])
    `, true)

    const pdfBuffer = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'default' },
    })

    writeFileSync(exportPath, Buffer.from(pdfBuffer))
    return true
  } finally {
    if (win && !win.isDestroyed()) win.close()
    try {
      unlinkSync(tempHtmlPath)
    } catch {
      // ignore cleanup error
    }
  }
}

export async function exportDocument(
  docId: string,
  format: InternalDocumentExportFormat,
  exportPath: string,
  options: ExportOptions = {},
) {
  const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [docId])
  if (!doc) throw new Error('文献不存在')

  const pages = withActiveOcrVersions(docId, hydratePagePayloadRows(queryAll<ExportPage>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])))
  const metadataObj = parseMaybeJson<JsonRecord>(doc.metadata, {})
  const metadataSource = metadataText(metadataObj, 'source')
  const metadataVersion = metadataText(metadataObj, 'version')
  const fullText = buildFullText(pages)
  const docTitle = String(doc.title || '文献内容')
  const isGuji = doc.doc_type === '古籍' || doc.doc_type === '\u53e4\u7c4d'

  const dir = join(exportPath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (format === 'pdf' || format === 'reading-pdf') {
    const textPdfHtml = format === 'reading-pdf'
      ? getReadingExportHtml(docTitle, pages, { ...metadataObj, author: doc.author, dynasty: doc.dynasty, source: metadataSource }, options)
      : getStandardExportHtml(docTitle, fullText, { ...metadataObj, author: doc.author, dynasty: doc.dynasty, source: metadataSource })
    return exportPdfFromHtml(textPdfHtml, exportPath)
  }

  if (format === 'layout-pdf') {
    const hasLayoutBlocks = pages.some((page) => getSortedLayoutBlocks(page).some((block) => !!block.location && (block.words || isImageLabel(String(block.label || '')))))
    if (hasLayoutBlocks) {
      try {
        return await exportLayoutPdfNative(docTitle, pages, exportPath, options, !isGuji)
      } catch (error) {
        console.error('[Export] Layout PDF export failed:', error)
        throw new Error(`排版模式 PDF 导出失败：${(error as Error)?.message || '未知错误'}`)
      }
    }

    const hasAllPageImages = pages.length > 0 && pages.every((page) => !!page.image_path && existsSync(page.image_path))
    if (hasAllPageImages) {
      try {
        return await exportImageOnlyLayoutPdfNative(docTitle, pages, exportPath)
      } catch (error) {
        console.error('[Export] Layout PDF image export failed:', error)
        throw new Error(`排版模式 PDF 导出失败：${(error as Error)?.message || '未知错误'}`)
      }
    }

    throw new Error('缺少版式还原数据，无法导出排版模式 PDF。请先完成 OCR/版式还原后再导出。')
  }

  if (format === 'layout-searchable-pdf') {
    const hasTextLayer = pages.some((page) => getPageText(page) || getSortedLayoutBlocks(page).some((block) => block.words))
    if (!hasTextLayer) {
      throw new Error('缺少 OCR/校对文本，无法生成带文字层的 PDF。请先完成 OCR 或校对后再导出。')
    }

    if (!pages.every((page) => !!page.image_path && existsSync(page.image_path))) {
      throw new Error('缺少页图，无法生成保留原版式的可搜索 PDF。请先打开文献生成页图，或补回 PDF 原文后再导出。')
    }

    const htmlContent = getTextLayerPdfHtml(docTitle, pages)
    try {
      return await exportPdfFromHtml(htmlContent, exportPath)
    } catch (error) {
      console.error('[Export] Text layer PDF export failed:', error)
      throw new Error(`带文字层 PDF 导出失败：${(error as Error)?.message || '未知错误'}`)
    }
  }

  if (format === 'html') {
    const htmlContent = isGuji
      ? getGujiExportHtml(docTitle, pages, { ...metadataObj, author: doc.author, dynasty: doc.dynasty, version: metadataVersion, source: metadataSource })
      : getStandardExportHtml(docTitle, fullText, { ...metadataObj, author: doc.author, dynasty: doc.dynasty, source: metadataSource })
    writeFileSync(exportPath, htmlContent, 'utf-8')
    return true
  }

  let content = ''

  if (format === 'markdown') {
    content = `---\ntitle: ${doc.title || '未命名'}\nauthor: ${doc.author || '未知'}\ndynasty: ${doc.dynasty || '未知'}\ntype: ${doc.doc_type || '未分类'}\ndate_exported: ${new Date().toISOString()}\n---\n\n# ${doc.title || '文献内容'}\n\n${fullText}\n`
  } else if (format === 'tei-xml') {
    content = isGuji
      ? buildGujiTei(doc, pages, metadataObj)
      : `<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0">\n  <teiHeader>\n    <fileDesc>\n      <titleStmt>\n        <title>${escapeXml(doc.title || '未命名')}</title>\n        <author>${escapeXml(doc.author || '未知')}</author>\n      </titleStmt>\n      <publicationStmt><p>Exported by 文献管理（GujiSmart）</p></publicationStmt>\n      <sourceDesc><p>${escapeXml(metadataSource || '未知来源')}</p></sourceDesc>\n    </fileDesc>\n  </teiHeader>\n  <text>\n    <body>\n      <div type="document">\n        <p>${escapeXml(fullText).replace(/\n/g, '</p>\n        <p>')}</p>\n      </div>\n    </body>\n  </text>\n</TEI>`
  } else if (format === 'page-xml') {
    content = buildGujiPageXml(doc, pages)
  } else if (format === 'paddle-json') {
    content = buildPaddleJsonExport(doc, pages, metadataObj)
  } else {
    content = `标题：${doc.title || ''}\n作者：${doc.author || ''}\n\n${fullText}`
  }

  writeFileSync(exportPath, content, 'utf-8')
  return true
}
