import type { DocumentPage, OcrRecognizeLayoutBlock, OcrRecognizeResult } from './types'
import { normalizeTranslationSourceText } from './translation-cache'

type JsonRecord = Record<string, unknown>
type TranslationOcrResult = OcrRecognizeResult & JsonRecord
type TranslationBlock = OcrRecognizeLayoutBlock & JsonRecord
type Rect = { left: number; top: number; width: number; height: number }

export type CanonicalTranslationBlock = TranslationBlock & {
  words?: string
  displayWords?: string
  label?: string
  orientation?: 'vertical' | 'horizontal' | string
  reading_order?: number
  column_index?: number
  line_index?: number
  __rect?: Rect
  __sourceIndex?: number
}

export type TranslationSourcePage = Omit<Partial<DocumentPage>, 'ocr_result'> & {
  text?: unknown
  title?: unknown
  doc_type?: unknown
  ocr_result?: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMaybeJson(value: unknown): unknown {
  if (!value) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function asOcrResult(value: unknown): TranslationOcrResult | null {
  const parsed = parseMaybeJson(value)
  return isRecord(parsed) ? parsed as TranslationOcrResult : null
}

function asBlock(value: unknown): TranslationBlock {
  return isRecord(value) ? value as TranslationBlock : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asBlockArray(value: unknown): TranslationBlock[] {
  return Array.isArray(value) ? value.filter(isRecord).map((item) => item as TranslationBlock) : []
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

function firstBlockArray(...values: unknown[]): TranslationBlock[] {
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
  return decodeHtmlEntities(String(value || ''))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function decodeEmbeddedTableMarkup(value: string): string {
  const source = String(value || '')
  return /&lt;\s*table|&lt;\s*tr|&lt;\s*td|&lt;\s*th/i.test(source) ? decodeHtmlEntities(source) : source
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
    const tupleText = tupleRec.map(readTupleText).filter(Boolean).join('\n')
    if (tupleText) return tupleText
    return res.map(readStructureResText).filter(Boolean).join('\n')
  }
  if (!isRecord(res)) return ''
  const html = firstNonEmptyText([res.html, res.table_html])
  if (html) return html
  const recRes = asArray(res.rec_res)
  if (recRes.length > 0) return recRes.map(readTupleText).filter(Boolean).join('\n')
  const recTexts = asArray(res.rec_texts)
  if (recTexts.length > 0) return recTexts.map(valueToString).filter(Boolean).join('\n')
  return firstNonEmptyText([res.text, res.words, res.content])
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

function normalizeInlineMathToken(value: string): string {
  return String(value || '')
    .replace(/\\dagger/g, '\u2020')
    .replace(/\\ddagger/g, '\u2021')
    .replace(/\\ast|\\star/g, '*')
    .replace(/\\S/g, '\u00a7')
    .replace(/\\P/g, '\u00b6')
    .replace(/\\cdot/g, '\u00b7')
    .replace(/\\times/g, '\u00d7')
    .replace(/\\alpha/g, '\u03b1')
    .replace(/\\beta/g, '\u03b2')
    .replace(/\\gamma/g, '\u03b3')
    .replace(/\\delta/g, '\u03b4')
    .replace(/\\[a-zA-Z]+/g, (match) => match.slice(1))
    .replace(/[{}]/g, '')
    .trim()
}

function stripInlineCommands(source: string, start = 0, end = source.length): string {
  let output = ''
  let index = start
  while (index < end) {
    const char = source[index]
    if (char === '$') {
      index += 1
      continue
    }
    if (char !== '\\') {
      output += char
      index += 1
      continue
    }
    if (/^[,;:!]$/.test(source[index + 1] || '')) {
      output += ' '
      index += 2
      continue
    }
    const commandMatch = /^\\([a-zA-Z]+)\s*/.exec(source.slice(index))
    if (!commandMatch) {
      output += char
      index += 1
      continue
    }
    const command = commandMatch[1]
    let nextIndex = index + commandMatch[0].length
    const symbol = normalizeInlineMathToken(`\\${command}`)
    if (symbol && symbol !== command) {
      output += symbol
      index = nextIndex
      continue
    }
    if (/^(?:quad|qquad)$/i.test(command)) {
      output += ' '
      index = nextIndex
      continue
    }
    if (source[nextIndex] === '{') {
      const closeIndex = findBalancedBraceEnd(source, nextIndex)
      if (closeIndex > nextIndex) {
        output += stripInlineCommands(source, nextIndex + 1, closeIndex)
        index = closeIndex + 1
        continue
      }
    }
    index = nextIndex
  }
  return output
}

export function normalizeTranslationBlockInlineText(value: string): string {
  return stripInlineCommands(decodeHtmlEntities(String(value || '')).replace(/\r/g, '\n'))
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?([\uff0c\u3002\uff1b\uff1a\uff01\uff1f\u3001,.!?;:]) ?/g, '$1')
    .trim()
}

function getPreferredBlockText(block: unknown): string {
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

function getCellText(cell: unknown): string {
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return String(cell).replace(/\s+/g, ' ').trim()
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

function parseHtmlTableRows(html: string): string[][] {
  const rows: string[][] = []
  const rowMatches = decodeEmbeddedTableMarkup(html).match(/<tr[\s\S]*?<\/tr>/gi) || []
  for (const rowHtml of rowMatches) {
    const cells = rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []
    const row = cells.map(stripHtml)
    if (row.some((cell) => cell.length > 0)) rows.push(row)
  }
  return rows
}

function parseMarkdownTableRows(text: string): string[][] {
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter((line) => /^\|.+\|$/.test(line))
  if (lines.length < 2) return []
  return lines
    .filter((line) => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))
}

function parseDelimitedTableRows(text: string): string[][] {
  const lines = String(text || '').split(/\r?\n+/).map((line) => line.trim()).filter(Boolean)
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
  return rowValues
    .map((row) => Array.isArray(row)
      ? row.map(getCellText)
      : Array.isArray(getPathValue(row, ['cells']))
        ? asArray(getPathValue(row, ['cells'])).map(getCellText)
        : [])
    .filter((row: string[]) => row.some((cell) => cell.trim()))
}

function getBlockTableRows(block: unknown): string[][] {
  const directRows = normalizeTableRows(firstArray(
    getPathValue(block, ['rows']),
    getPathValue(block, ['table_rows']),
    getPathValue(block, ['tableRows']),
    getPathValue(block, ['table', 'rows']),
  ))
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

  const html = getBlockTableMarkup(block)
  if (/<table|<tr/i.test(html)) {
    const rows = parseHtmlTableRows(html)
    if (rows.length > 0) return rows
  }
  const markdownRows = parseMarkdownTableRows(firstNonEmptyText([
    getPathValue(block, ['markdown']),
    getPathValue(block, ['md']),
    getPathValue(block, ['words']),
    getPathValue(block, ['text']),
    readStructureResText(getPathValue(block, ['res'])),
  ]))
  if (markdownRows.length > 0) return markdownRows
  return parseDelimitedTableRows(getPreferredBlockText(block))
}

function tableRowsToText(rows: string[][]): string {
  return rows.map((row) => row.join('\t')).join('\n')
}

function getBlockLabel(block: unknown): string {
  const record = asBlock(block)
  return firstNonEmptyText([record.label, record.block_label, record.type, record.block_type, record.category]).toLowerCase()
}

function isTableBlock(block: unknown): boolean {
  const label = getBlockLabel(block)
  const htmlLike = getBlockTableMarkup(block)
  return /^(?:table|table body|table_cell|table row)$/i.test(label)
    || Array.isArray(getPathValue(block, ['cells']))
    || Array.isArray(getPathValue(block, ['table_cells']))
    || Array.isArray(getPathValue(block, ['table', 'cells']))
    || Array.isArray(getPathValue(block, ['rows']))
    || Array.isArray(getPathValue(block, ['table_rows']))
    || Array.isArray(getPathValue(block, ['tableRows']))
    || Array.isArray(getPathValue(block, ['table', 'rows']))
    || /^\s*\|.+\|/m.test(firstNonEmptyText([getPathValue(block, ['markdown']), getPathValue(block, ['md']), getPreferredBlockText(block)]))
    || /<table|<tr/i.test(htmlLike)
}

export function getCanonicalTranslationBlockText(block: unknown): string {
  const text = normalizeTranslationBlockInlineText(getPreferredBlockText(block))
  if (text) return text
  const rows = getBlockTableRows(block)
  return rows.length > 0 ? tableRowsToText(rows) : ''
}

function getPointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number | null {
  const rawValue = isRecord(point) ? point[key] : Array.isArray(point) ? point[tupleIndex] : undefined
  const value = Number(rawValue)
  return Number.isFinite(value) ? value : null
}

function arrayToRect(loc: unknown): Rect | null {
  if (!Array.isArray(loc) || loc.length < 4) return null
  if (typeof loc[0] === 'number') {
    const [x1, y1, x2, y2] = loc.map(Number)
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
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

function hasPositiveBlockOrder(block: TranslationBlock): boolean {
  const order = Number(block?.block_order)
  return Number.isFinite(order) && order > 0
}

function shouldPreferPositiveBlockOrder(blocks: TranslationBlock[]): boolean {
  const contentBlocks = blocks.filter((block) => !isDecorativeLabel(getBlockLabel(block)))
  if (contentBlocks.length === 0) return false
  const orderedCount = contentBlocks.filter(hasPositiveBlockOrder).length
  return orderedCount >= Math.max(2, Math.ceil(contentBlocks.length * 0.6))
}

function compareByPositiveBlockOrder(left: TranslationBlock, right: TranslationBlock): number {
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

function hasBlockCoordinates(block: unknown): boolean {
  return Boolean(getRawBlockLocation(block))
}

function getCompactTextLength(value: string): number {
  return String(value || '').replace(/\s+/g, '').length
}

function mergeRawLayoutText(rawLayoutBlocks: TranslationBlock[], wordsResult: TranslationBlock[]): TranslationBlock[] {
  if (rawLayoutBlocks.length === 0 || wordsResult.length === 0) return rawLayoutBlocks
  if (wordsResult.length < Math.ceil(rawLayoutBlocks.length * 0.85)) return rawLayoutBlocks
  return rawLayoutBlocks.map((block, index) => {
    const candidateText = getCanonicalTranslationBlockText(wordsResult[index]).trim()
    if (!candidateText) return block
    const currentText = getCanonicalTranslationBlockText(block).trim()
    const shouldPreferLineText = wordsResult.length === rawLayoutBlocks.length
      || getCompactTextLength(candidateText) >= getCompactTextLength(currentText) + 4
      || getCompactTextLength(currentText) <= 12
    if (!shouldPreferLineText) return block
    return {
      ...block,
      raw_words: block?.raw_words || block?.words || block?.text,
      words: candidateText,
      facsimile_text_source: 'words_result',
    }
  })
}

function recognizedTextBlocksFrom(source: unknown): TranslationBlock[] {
  if (!isRecord(source)) return []
  const recTexts = asArray(source.rec_texts)
  if (recTexts.length === 0) return []
  const locations = firstArray(source.rec_boxes, source.rec_polys, source.dt_polys)
  const scores = asArray(source.rec_scores)
  return recTexts.map((text, index): TranslationBlock => ({
    words: valueToString(text),
    label: 'text',
    reading_order: index,
    location: locations[index],
    score: scores[index],
  }))
}

function getOcrBlocks(ocrResult: unknown): TranslationBlock[] {
  const parsed = asOcrResult(ocrResult)
  if (!parsed) return []
  const layoutBlocks = asBlockArray(parsed.layout_result)
  const rawLayoutBlocks = asBlockArray(parsed.raw_layout_result)
  const wordsResult = asBlockArray(parsed.words_result)
  const layoutCoordinateCount = layoutBlocks.filter(hasBlockCoordinates).length
  const rawCoordinateCount = rawLayoutBlocks.filter(hasBlockCoordinates).length
  if (rawCoordinateCount > layoutCoordinateCount) {
    return mergeRawLayoutText(rawLayoutBlocks, wordsResult)
  }
  const directBlocks = firstBlockArray(
    layoutBlocks,
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

function getOrderedTranslationBlocks(ocrResult: unknown): TranslationBlock[] {
  const blocks = getOcrBlocks(ocrResult)
  if (shouldPreferPositiveBlockOrder(blocks)) {
    return [...blocks].sort(compareByPositiveBlockOrder)
  }
  return [...blocks].sort((left, right) => {
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
  })
}

function getOrientationLabelText(block: unknown): string {
  return [
    getPathValue(block, ['label']),
    getPathValue(block, ['block_label']),
    getPathValue(block, ['type']),
    getPathValue(block, ['block_type']),
    getPathValue(block, ['category']),
    getPathValue(block, ['class']),
    getPathValue(block, ['layout_label']),
  ].map((value) => String(value || '').toLowerCase()).filter(Boolean).join(' ')
}

function isTocLabel(label: string): boolean {
  return /^(?:toc|content|contents|catalog|catalogue|table[_\s-]*of[_\s-]*contents)$/.test(label) || /\u76ee\u5f55|\u76ee\u9304/.test(label)
}

function isDecorativeLabel(label: string): boolean {
  return /header|footer|number|page|seal|stamp|\u9875\u7709|\u9801\u7709|\u9875\u811a|\u9801\u8173|\u9875\u7801|\u9801\u78bc|\u5370\u7ae0/.test(label)
}

function isImageLabel(label: string): boolean {
  return /^(?:image|figure|picture|chart|diagram|photo|illustration)$/i.test(label) || /\u56fe\u7247|\u5716\u50cf|\u63d2\u56fe|\u63d2\u5716|\u7167\u7247/.test(label)
}

function isExplicitVerticalLabel(label: string): boolean {
  return /vertical[_\s-]*text|col[_\s-]*text|column[_\s-]*text|vertical|\u7ad6\u6392|\u8c4e\u6392|\u76f4\u6392/i.test(label)
}

function isExplicitHorizontalLabel(label: string): boolean {
  return /horizontal[_\s-]*text|row[_\s-]*text|horizontal|\u6a2a\u6392|\u6a6b\u6392/i.test(label)
}

function getExplicitOcrOrientation(block: unknown): 'vertical' | 'horizontal' | null {
  const orientation = getPathValue(block, ['orientation'])
  if (orientation === 'vertical' || orientation === 'horizontal') return orientation
  const label = getOrientationLabelText(block)
  if (isExplicitVerticalLabel(label)) return 'vertical'
  if (isExplicitHorizontalLabel(label)) return 'horizontal'
  return null
}

function isNaturallyHorizontalLabel(label: string): boolean {
  const normalized = String(label || '').toLowerCase().replace(/[_-]+/g, ' ')
  return /\b(?:doc title|document title|paragraph title|title|heading|section title|abstract|reference|references|caption|figure caption|table caption|header|footer|number|page number|keyword|keywords|author|journal|date)\b/.test(normalized)
}

function hasHorizontalTextSignals(block: unknown): boolean {
  const label = getBlockLabel(block)
  if (isTocLabel(label)) return true
  const text = getCanonicalTranslationBlockText(block)
  const compact = text.replace(/\s+/g, '')
  if (!compact) return false
  const lines = text.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean)
  const asciiCount = Array.from(compact).filter((char) => /[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)).length
  const asciiRatio = asciiCount / Math.max(1, compact.length)
  const leaderLineCount = lines.filter((line) => /[.\u00b7\u2026]{3,}/.test(line)).length
  const pageNumberLineCount = lines.filter((line) => /(?:[.\u00b7\u2026]\s*){2,}(?:[ivxlcdm]+|\d{1,4})\s*$/i.test(line) || /\s(?:[ivxlcdm]+|\d{1,4})\s*$/i.test(line)).length
  return (lines.length >= 3 && (leaderLineCount >= 1 || pageNumberLineCount >= Math.min(3, lines.length))) || asciiRatio > 0.18
}

function getVerticalScriptRatio(text: string): number {
  const chars = Array.from(String(text || '').replace(/\s+/g, ''))
  if (chars.length === 0) return 0
  const verticalChars = chars.filter((char) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(char)).length
  return verticalChars / chars.length
}

function isTallVerticalTextBlock(block: unknown): boolean {
  const label = getOrientationLabelText(block)
  if (isTocLabel(label) || isExplicitHorizontalLabel(label)) return false
  const rect = getBlockRect(block)
  const text = getCanonicalTranslationBlockText(block)
  if (!rect || !text.trim() || rect.height < rect.width * 1.28) return false
  return getVerticalScriptRatio(text) >= 0.42
}

function hasModernHorizontalParagraphShape(block: unknown): boolean {
  const label = getOrientationLabelText(block)
  if (!/^(?:text|paragraph|body)$/.test(label)) return false
  const rect = getBlockRect(block)
  const text = getCanonicalTranslationBlockText(block)
  if (!rect || !text.trim()) return false
  const compact = text.replace(/\s+/g, '')
  const punctuationCount = Array.from(compact).filter((char) => /[，。；：！？、“”‘’（）《》,.!?;:]/.test(char)).length
  return compact.length >= 80
    && rect.width >= 160
    && punctuationCount / Math.max(1, compact.length) >= 0.035
}

function isStrongHorizontalTextBlock(block: unknown): boolean {
  const label = getOrientationLabelText(block)
  if (isTocLabel(label) || isExplicitHorizontalLabel(label)) return true
  if (hasModernHorizontalParagraphShape(block)) return true
  if (isExplicitVerticalLabel(label)) return false
  const rect = getBlockRect(block)
  const text = getCanonicalTranslationBlockText(block)
  if (!rect || !text.trim()) return false
  if (/^(?:text|paragraph|body)$/.test(label)) {
    const paragraphCompact = text.replace(/\s+/g, '')
    const punctuationCount = Array.from(paragraphCompact).filter((char) => /[，。；：！？、“”‘’（）《》,.!?;:]/.test(char)).length
    if (paragraphCompact.length >= 80 && rect.width >= 160 && punctuationCount / Math.max(1, paragraphCompact.length) >= 0.045) return true
  }
  if (isNaturallyHorizontalLabel(label) && !isTallVerticalTextBlock(block)) return true
  const compact = text.replace(/\s+/g, '')
  const asciiCount = Array.from(compact).filter((char) => /[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)).length
  const asciiRatio = asciiCount / Math.max(1, compact.length)
  if (rect.width >= rect.height * 1.72) return true
  return rect.width >= rect.height * 1.35 && (asciiRatio > 0.18 || getVerticalScriptRatio(text) < 0.32)
}

function isVerticalPage(blocks: CanonicalTranslationBlock[]): boolean {
  const meaningfulBlocks = blocks.filter((block) => {
    const label = getBlockLabel(block)
    return !isTableBlock(block) && !isImageLabel(label) && !!block.__rect && !!getCanonicalTranslationBlockText(block).trim()
  })
  if (meaningfulBlocks.length < 3) return false
  const verticalCount = meaningfulBlocks.filter((block) => (
    isExplicitVerticalLabel(getOrientationLabelText(block))
    || block.orientation === 'vertical'
    || isTallVerticalTextBlock(block)
  )).length
  const horizontalCount = meaningfulBlocks.filter(isStrongHorizontalTextBlock).length
  return verticalCount >= 3 && verticalCount / meaningfulBlocks.length >= 0.58 && horizontalCount / meaningfulBlocks.length <= 0.35
}

function inferOrientation(block: unknown): 'vertical' | 'horizontal' {
  if (isTableBlock(block)) return 'horizontal'
  if (isStrongHorizontalTextBlock(block)) return 'horizontal'
  const explicitOrientation = getExplicitOcrOrientation(block)
  if (explicitOrientation) return explicitOrientation
  if (isTallVerticalTextBlock(block)) return 'vertical'
  if (hasHorizontalTextSignals(block)) return 'horizontal'
  const rect = getBlockRect(block)
  const text = getCanonicalTranslationBlockText(block)
  if (!rect) return 'vertical'
  const asciiRatio = Array.from(text.replace(/\s+/g, '')).filter((char) => /[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)).length / Math.max(1, text.length)
  if (asciiRatio > 0.18) return 'horizontal'
  return rect.height >= rect.width * 1.12 ? 'vertical' : 'horizontal'
}

function inferPageAwareOrientation(block: CanonicalTranslationBlock, pageVerticalMode: boolean): 'vertical' | 'horizontal' {
  if (isTableBlock(block) || isImageLabel(getBlockLabel(block))) return 'horizontal'
  const explicitOrientation = getExplicitOcrOrientation(block)
  if (explicitOrientation) return explicitOrientation
  if (!pageVerticalMode) return inferOrientation(block)
  if (isStrongHorizontalTextBlock(block)) return 'horizontal'
  if (isTocLabel(getBlockLabel(block))) return 'horizontal'
  return 'vertical'
}

function getVerticalColumns(text: string): string[] {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const hardLines = source.includes('\n') ? source.split(/\n+/) : source.split(/[ \t]+/)
  return hardLines.map((line) => line.replace(/[ \t]+/g, '').trim()).filter(Boolean)
}

function normalizeInitialTranslationBlocks(ocrResult: unknown): CanonicalTranslationBlock[] {
  const parsed = asOcrResult(ocrResult)
  const rawBlocks = getOrderedTranslationBlocks(parsed)
  const blocks = rawBlocks
    .map((block, index): CanonicalTranslationBlock | null => {
      const label = getBlockLabel(block) || 'text'
      const words = getCanonicalTranslationBlockText(block)
      const rect = getBlockRect(block)
      const isImage = isImageLabel(label) && !!rect
      if (!words && !isImage) return null
      return {
        ...block,
        words,
        label,
        reading_order: index,
        orientation: inferOrientation(block),
        __rect: rect || undefined,
        __sourceIndex: index,
      }
    })
    .filter((block): block is CanonicalTranslationBlock => block !== null)

  if (blocks.length === 0 && typeof parsed?.text === 'string') {
    return parsed.text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index): CanonicalTranslationBlock => ({
        words: line,
        label: 'text',
        reading_order: index,
        orientation: 'vertical',
        __sourceIndex: index,
      }))
  }

  return blocks
}

function normalizePageOrientations(blocks: CanonicalTranslationBlock[]): CanonicalTranslationBlock[] {
  const pageVerticalMode = isVerticalPage(blocks)
  return blocks.map((block) => ({ ...block, orientation: inferPageAwareOrientation(block, pageVerticalMode) }))
}

function splitWideVerticalBlocks(blocks: CanonicalTranslationBlock[]): CanonicalTranslationBlock[] {
  const nextBlocks: CanonicalTranslationBlock[] = []
  blocks.forEach((block, blockIndex) => {
    const rect = block.__rect
    const label = getBlockLabel(block)
    if (
      !rect
      || block.orientation !== 'vertical'
      || isTableBlock(block)
      || isImageLabel(label)
      || isDecorativeLabel(label)
      || rect.width < 72
      || rect.width < rect.height * 0.1
    ) {
      nextBlocks.push(block)
      return
    }
    const columns = getVerticalColumns(getCanonicalTranslationBlockText(block))
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
      const left = rect.left + rect.width - (columnIndex + 1) * columnWidth
      nextBlocks.push({
        ...block,
        words: columnText,
        displayWords: columnText,
        reading_order: Number(block.reading_order ?? blockIndex) + columnIndex / 100,
        column_index: columnIndex,
        line_index: 0,
        __rect: { left, top: rect.top, width: columnWidth, height: rect.height },
        __sourceIndex: Number(block.__sourceIndex ?? blockIndex) * 100 + columnIndex,
      })
    })
  })
  return nextBlocks.sort((left, right) => Number(left.reading_order || 0) - Number(right.reading_order || 0))
}

export function getCanonicalTranslationBlocksFromOcrResult(ocrResult: unknown): CanonicalTranslationBlock[] {
  return splitWideVerticalBlocks(normalizePageOrientations(normalizeInitialTranslationBlocks(ocrResult)))
}

function hasCanonicalBlockCoordinates(blocks: CanonicalTranslationBlock[]): boolean {
  return blocks.some((block) => Boolean(block.__rect))
}

function getCanonicalTranslationBlocksForPage(page: TranslationSourcePage): CanonicalTranslationBlock[] {
  const parsed = asOcrResult(page.ocr_result)
  const sourceType = String(parsed?.source_type || '')
  const baseOcrResult = (sourceType === 'hybrid_ocr' || sourceType === 'hybrid_ocr_fallback')
    ? getPathValue(parsed, ['base_ocr_result'])
    : null
  const primaryBlocks = getCanonicalTranslationBlocksFromOcrResult(page.ocr_result)
  if (!baseOcrResult) return primaryBlocks

  const baseBlocks = getCanonicalTranslationBlocksFromOcrResult(baseOcrResult)
  if (hasCanonicalBlockCoordinates(primaryBlocks)) return primaryBlocks
  if (hasCanonicalBlockCoordinates(baseBlocks)) return baseBlocks
  if (primaryBlocks.length > 0) return primaryBlocks
  return baseBlocks
}

function getOcrResultText(ocrResult: unknown): string {
  const parsed = asOcrResult(ocrResult)
  return String(parsed?.text || '').trim()
}

function isEbookLikePage(page: TranslationSourcePage | null | undefined): boolean {
  const parsed = asOcrResult(page?.ocr_result)
  const sourceType = String(parsed?.source_type || '').toLowerCase()
  const docType = String(page?.doc_type || '').toLowerCase()
  return sourceType === 'ebook_section'
    || sourceType === 'ebook_text'
    || sourceType.startsWith('ebook_')
    || Boolean(parsed?.ebook)
    || /ebook|epub|\u7535\u5b50\u4e66|\u96fb\u5b50\u66f8/.test(docType)
}

function getFallbackPageText(page: TranslationSourcePage | null | undefined): string {
  return String(page?.text || page?.proofed_text || page?.ocr_text || getOcrResultText(page?.ocr_result) || '').trim()
}

export function getCanonicalPageTranslationSourceText(page: TranslationSourcePage | null | undefined): string {
  if (!page) return ''
  if (!isEbookLikePage(page)) {
    const blockText = getCanonicalTranslationBlocksForPage(page)
      .map((block) => getCanonicalTranslationBlockText(block))
      .filter(Boolean)
      .join('\n\n')
      .trim()
    if (blockText) return normalizeTranslationSourceText(blockText)
  }
  return normalizeTranslationSourceText(getFallbackPageText(page))
}
