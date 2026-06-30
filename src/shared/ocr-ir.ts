import type {
  OcrAssetRef,
  OcrBlockV1,
  OcrBoundingBox,
  OcrDocumentV1,
  OcrEngine,
  OcrFormulaV1,
  OcrIrOrientation,
  OcrIrOrientationSource,
  OcrIrSemanticType,
  OcrIrSource,
  OcrPageIrEnvelopeV1,
  OcrPageV1,
  OcrParagraphV1,
  OcrProcessingEvent,
  OcrQualityIssue,
  OcrQualityReport,
  OcrRecognizeLayoutBlock,
  OcrRecognizeResult,
  OcrSpanV1,
  OcrTableCellV1,
  OcrTableV1,
} from './types'

type JsonRecord = Record<string, unknown>

export const OCR_IR_SCHEMA_VERSION = 'gujismart-ocr-ir/v1' as const
export const OCR_IR_PIPELINE_VERSION = '1.2.1'

export interface BuildOcrIrOptions {
  pageIndex?: number
  pageWidth?: number
  pageHeight?: number
  engine?: OcrEngine | 'native_pdf_text' | 'imported' | 'unknown'
  provider?: string
  model?: string
  generatedAt?: string
  forceRebuild?: boolean
}

export interface OcrRegionRerecognitionCandidate {
  blockId: string
  bbox: OcrBoundingBox
  orientation: OcrIrOrientation
  sourceIndex: number
  reasons: OcrQualityIssue['code'][]
}

export interface OcrRegionTextReplacement {
  sourceIndex: number
  text: string
  confidence?: number
  reasons?: OcrQualityIssue['code'][]
  recognizedAt?: string
}

const DISCARDED_TYPES = new Set<OcrIrSemanticType>([
  'page_header',
  'page_footer',
  'page_number',
  'aside',
])

const PARAGRAPH_TYPES = new Set<OcrIrSemanticType>([
  'paragraph',
  'abstract',
  'reference',
  'note',
  'caption',
  'footnote',
])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function firstValue(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

function firstText(record: JsonRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function normalizeText(value: unknown): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function normalizeLabel(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getBlockText(block: JsonRecord): string {
  const rows = getTableRows(block)
  if (rows.length > 0) return rows.map((row) => row.join('\t')).join('\n')
  return normalizeText(firstText(block, [
    'words',
    'word',
    'text',
    'block_content',
    'content',
    'transcription',
    'raw_words',
    'raw_text',
  ]))
}

function point(value: unknown): { x: number; y: number } | null {
  if (Array.isArray(value) && value.length >= 2) {
    const x = finiteNumber(value[0])
    const y = finiteNumber(value[1])
    return x === null || y === null ? null : { x, y }
  }
  if (isRecord(value)) {
    const x = finiteNumber(firstValue(value, ['x', 'left']))
    const y = finiteNumber(firstValue(value, ['y', 'top']))
    return x === null || y === null ? null : { x, y }
  }
  return null
}

export function toOcrBoundingBox(value: unknown): OcrBoundingBox | undefined {
  if (isRecord(value)) {
    const left = finiteNumber(firstValue(value, ['left', 'x', 'x1']))
    const top = finiteNumber(firstValue(value, ['top', 'y', 'y1']))
    const width = finiteNumber(firstValue(value, ['width', 'w']))
    const height = finiteNumber(firstValue(value, ['height', 'h']))
    const right = finiteNumber(firstValue(value, ['right', 'x2']))
    const bottom = finiteNumber(firstValue(value, ['bottom', 'y2']))
    if (left !== null && top !== null) {
      const resolvedWidth = width ?? (right !== null ? right - left : null)
      const resolvedHeight = height ?? (bottom !== null ? bottom - top : null)
      if (resolvedWidth !== null && resolvedHeight !== null && resolvedWidth >= 0 && resolvedHeight >= 0) {
        return { left, top, width: resolvedWidth, height: resolvedHeight }
      }
    }
  }

  if (!Array.isArray(value)) return undefined
  if (value.length >= 4 && value.every((item) => finiteNumber(item) !== null)) {
    const numbers = value.map(Number)
    if (numbers.length === 4) {
      const [left, top, right, bottom] = numbers
      if (right >= left && bottom >= top) return { left, top, width: right - left, height: bottom - top }
    }
  }
  const points = value.map(point).filter((item): item is { x: number; y: number } => item !== null)
  if (points.length < 2) return undefined
  const xs = points.map((item) => item.x)
  const ys = points.map((item) => item.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return {
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  }
}

function getBlockBbox(block: JsonRecord): OcrBoundingBox | undefined {
  return toOcrBoundingBox(firstValue(block, [
    'location',
    'bbox',
    'box',
    'block_bbox',
    'coordinate',
    'coordinate_box',
    'points',
  ]))
}

function normalizeBbox(bbox: OcrBoundingBox | undefined, width: number, height: number): OcrBoundingBox | undefined {
  if (!bbox || width <= 0 || height <= 0) return undefined
  const scaleX = 1000 / width
  const scaleY = 1000 / height
  return {
    left: Math.max(0, Math.min(1000, bbox.left * scaleX)),
    top: Math.max(0, Math.min(1000, bbox.top * scaleY)),
    width: Math.max(0, Math.min(1000, bbox.width * scaleX)),
    height: Math.max(0, Math.min(1000, bbox.height * scaleY)),
  }
}

function getSourceBlocks(result: JsonRecord): JsonRecord[] {
  const directCandidates = [
    result.layout_result,
    result.layout_blocks,
    result.parsing_res_list,
    isRecord(result.prunedResult) ? result.prunedResult.parsing_res_list : null,
    isRecord(result.layout_det_res) ? result.layout_det_res.boxes : null,
    result.boxes,
    result.words_result,
  ]
  for (const candidate of directCandidates) {
    const records = asRecords(candidate)
    if (records.length > 0) return records
  }

  const overall = isRecord(result.overall_ocr_res) ? result.overall_ocr_res : null
  const texts = Array.isArray(overall?.rec_texts) ? overall.rec_texts : Array.isArray(result.rec_texts) ? result.rec_texts : []
  const boxes = Array.isArray(overall?.rec_boxes)
    ? overall.rec_boxes
    : Array.isArray(overall?.rec_polys)
      ? overall.rec_polys
      : Array.isArray(result.rec_boxes)
        ? result.rec_boxes
        : Array.isArray(result.rec_polys)
          ? result.rec_polys
          : []
  const scores = Array.isArray(overall?.rec_scores) ? overall.rec_scores : Array.isArray(result.rec_scores) ? result.rec_scores : []
  return texts.map((text, index) => ({
    words: String(text || ''),
    label: 'text',
    location: boxes[index],
    score: scores[index],
  }))
}

function semanticTypeForLabel(labelValue: unknown, text: string): OcrIrSemanticType {
  const label = normalizeLabel(labelValue)
  if (/^(?:doc title|document title|book title)$|文档标题|书名|篇名/.test(label)) return 'document_title'
  if (/title|heading|section|paragraph title|标题|段题|章名/.test(label)) return 'heading'
  if (/abstract|摘要/.test(label)) return 'abstract'
  if (/reference|bibliograph|参考文献/.test(label)) return 'reference'
  if (/footnote|page footnote|脚注/.test(label)) return 'footnote'
  if (/header|页眉/.test(label)) return 'page_header'
  if (/footer|页脚/.test(label)) return 'page_footer'
  if (/page number|page no|页码|页号/.test(label) || /^(?:第)?\d{1,5}(?:页)?$/.test(text.replace(/\s+/g, ''))) return 'page_number'
  if (/aside|sidebar|边栏|旁注|侧批/.test(label)) return 'aside'
  if (/caption|figure caption|table caption|图题|表题|题注/.test(label)) return 'caption'
  if (/table|表格/.test(label)) return 'table'
  if (/chart|diagram|图表/.test(label)) return 'chart'
  if (/image|figure|picture|photo|illustration|图片|图像|插图|照片/.test(label)) return 'image'
  if (/formula number/.test(label)) return 'caption'
  if (/inline formula|inline equation/.test(label)) return 'formula_inline'
  if (/formula|equation|公式/.test(label)) return 'formula_display'
  if (/list|列表/.test(label)) return 'list'
  if (/index|目录|索引/.test(label)) return 'index'
  if (/note|annotation|comment|注释|注文/.test(label)) return 'note'
  if (/code|algorithm|代码|算法/.test(label)) return 'code'
  if (/seal|stamp|印章/.test(label)) return 'seal'
  if (/^(?:[（(]?[一二三四五六七八九十百\d]+[、.)）．]|[-*•·])\s*\S/.test(text)) return 'list'
  return text ? 'paragraph' : 'unknown'
}

interface OrientationInference {
  orientation: OcrIrOrientation
  source: OcrIrOrientationSource
}

function parseOrientation(value: unknown): OcrIrOrientation {
  const normalized = normalizeLabel(value)
  if (/vertical|top to bottom|ttb|竖排|直排/.test(normalized)) return 'vertical'
  if (/horizontal|横排/.test(normalized)) return 'horizontal'
  return 'unknown'
}

function parseOrientationSource(value: unknown): OcrIrOrientationSource | null {
  const normalized = normalizeLabel(value)
  if (normalized === 'ocr') return 'ocr'
  if (normalized === 'coordinate') return 'coordinate'
  if (normalized === 'page consensus') return 'page_consensus'
  if (normalized === 'document consensus') return 'document_consensus'
  if (normalized === 'manual' || normalized === 'manual override' || normalized === 'user' || normalized === 'user override') return 'manual'
  if (normalized === 'unknown') return 'unknown'
  return null
}

function inferOrientation(block: JsonRecord, bbox: OcrBoundingBox | undefined): OrientationInference {
  const explicit = parseOrientation(firstValue(block, [
    'orientation',
    'text_orientation',
    'text_direction',
    'writing_mode',
    'writing_direction',
  ]))
  if (explicit !== 'unknown') return { orientation: explicit, source: 'ocr' }
  if (bbox && bbox.height > bbox.width * 2.4) {
    return { orientation: 'vertical', source: 'coordinate' }
  }
  if (bbox) return { orientation: 'horizontal', source: 'coordinate' }
  return { orientation: 'unknown', source: 'unknown' }
}

function getTableRows(block: JsonRecord): string[][] {
  const raw = firstValue(block, ['rows', 'table_rows', 'tableRows'])
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) => Array.isArray(row) ? row.map((cell) => normalizeText(cell)) : [])
    .filter((row) => row.length > 0)
}

function getTableCells(block: JsonRecord, width: number, height: number): OcrTableCellV1[] {
  return asRecords(firstValue(block, ['cells', 'table_cells', 'tableCells']))
    .map((cell, index): OcrTableCellV1 => {
      const bbox = getBlockBbox(cell)
      return {
        row: Math.max(0, finiteNumber(firstValue(cell, ['row', 'row_index', 'rowIndex'])) ?? 0),
        column: Math.max(0, finiteNumber(firstValue(cell, ['column', 'col', 'column_index', 'colIndex'])) ?? index),
        rowSpan: Math.max(1, finiteNumber(firstValue(cell, ['row_span', 'rowspan', 'rowSpan'])) ?? 1),
        columnSpan: Math.max(1, finiteNumber(firstValue(cell, ['column_span', 'colspan', 'columnSpan'])) ?? 1),
        text: normalizeText(firstValue(cell, ['text', 'words', 'content'])),
        bbox,
        normalizedBbox: normalizeBbox(bbox, width, height),
      }
    })
}

function getTable(block: JsonRecord, width: number, height: number): OcrTableV1 | undefined {
  const rows = getTableRows(block)
  const cells = getTableCells(block, width, height)
  const html = firstText(block, ['html', 'table_html', 'tableHtml'])
  const markdown = firstText(block, ['markdown', 'md'])
  if (rows.length === 0 && cells.length === 0 && !html && !markdown) return undefined
  const complex = cells.some((cell) => cell.rowSpan > 1 || cell.columnSpan > 1)
  return {
    rows,
    cells,
    html: html || undefined,
    markdown: markdown || undefined,
    complexity: complex ? 'complex' : rows.length > 0 || cells.length > 0 ? 'simple' : 'unknown',
  }
}

function getFormula(block: JsonRecord, type: OcrIrSemanticType): OcrFormulaV1 | undefined {
  if (type !== 'formula_inline' && type !== 'formula_display') return undefined
  const latex = firstText(block, ['latex', 'formula', 'text', 'words', 'content'])
  if (!latex) return undefined
  return {
    latex,
    display: type === 'formula_display',
    sourceText: firstText(block, ['raw_words', 'raw_text']) || undefined,
  }
}

function getAssetPath(block: JsonRecord): string {
  return firstText(block, ['image_asset_path', 'asset_path', 'image_path', 'crop_path', 'src'])
}

function splitLines(text: string): string[] {
  const lines = normalizeText(text).split(/\n+/).map((line) => line.trim()).filter(Boolean)
  return lines.length > 0 ? lines : text ? [text] : []
}

function lineBbox(blockBbox: OcrBoundingBox | undefined, index: number, count: number, orientation: OcrIrOrientation): OcrBoundingBox | undefined {
  if (!blockBbox || count <= 0) return undefined
  if (orientation === 'vertical') {
    const width = blockBbox.width / count
    return {
      left: blockBbox.left + blockBbox.width - width * (index + 1),
      top: blockBbox.top,
      width,
      height: blockBbox.height,
    }
  }
  const height = blockBbox.height / count
  return {
    left: blockBbox.left,
    top: blockBbox.top + height * index,
    width: blockBbox.width,
    height,
  }
}

function sourceForBlock(result: JsonRecord, block: JsonRecord, options: BuildOcrIrOptions, sourceIndex: number): OcrIrSource {
  const resultSource = normalizeLabel(result.source_type)
  const blockStage = normalizeLabel(firstText(block, ['segmentation_source']))
  const inferredEngine = blockStage.includes('region rerecognition')
    ? 'paddle'
    : resultSource.includes('native pdf')
    ? 'native_pdf_text'
    : resultSource.includes('hybrid')
      ? 'hybrid'
      : resultSource.includes('vision')
        ? 'vision_model'
        : options.engine || 'paddle'
  return {
    engine: inferredEngine,
    provider: options.provider || firstText(result, ['provider']) || undefined,
    model: options.model || firstText(result, ['model']) || undefined,
    stage: blockStage || resultSource || 'ocr',
    sourceIndex,
  }
}

function compareBlocks(left: OcrBlockV1, right: OcrBlockV1): number {
  const leftManual = left.manualReadingOrder
  const rightManual = right.manualReadingOrder
  if (leftManual !== undefined || rightManual !== undefined) {
    const delta = (leftManual ?? Number.MAX_SAFE_INTEGER) - (rightManual ?? Number.MAX_SAFE_INTEGER)
    if (delta !== 0) return delta
  }
  if (
    left.readingOrderSource === 'ocr'
    && right.readingOrderSource === 'ocr'
    && left.sourceReadingOrder !== undefined
    && right.sourceReadingOrder !== undefined
    && left.sourceReadingOrder !== right.sourceReadingOrder
  ) {
    return left.sourceReadingOrder - right.sourceReadingOrder
  }
  if (
    left.columnIndex !== undefined
    && right.columnIndex !== undefined
    && left.columnIndex !== right.columnIndex
  ) {
    return left.columnIndex - right.columnIndex
  }
  if (!left.bbox || !right.bbox) {
    return (left.source.sourceIndex ?? Number.MAX_SAFE_INTEGER)
      - (right.source.sourceIndex ?? Number.MAX_SAFE_INTEGER)
  }
  if (left.orientation === 'vertical' && right.orientation === 'vertical') {
    return right.bbox.left - left.bbox.left
      || left.bbox.top - right.bbox.top
      || (left.source.sourceIndex ?? 0) - (right.source.sourceIndex ?? 0)
  }
  return left.bbox.top - right.bbox.top
    || left.bbox.left - right.bbox.left
    || (left.source.sourceIndex ?? 0) - (right.source.sourceIndex ?? 0)
}

function shouldPreferSourceBlockOrder(blocks: JsonRecord[]): boolean {
  const contentBlocks = blocks.filter((block) => {
    const text = getBlockText(block)
    const label = firstValue(block, ['label', 'block_label', 'type', 'block_type', 'category'])
    const type = semanticTypeForLabel(label, text)
    return !DISCARDED_TYPES.has(type) && type !== 'seal'
  })
  if (contentBlocks.length === 0) return false
  const orderedCount = contentBlocks.filter((block) => {
    const readingOrder = finiteNumber(block.reading_order)
    const blockOrder = finiteNumber(block.block_order)
    return readingOrder !== null || (blockOrder !== null && blockOrder > 0)
  }).length
  return orderedCount >= Math.max(2, Math.ceil(contentBlocks.length * 0.6))
}

function sentenceComplete(text: string): boolean {
  return /[。！？!?；;：:…」』”’）)\]】]$/.test(text.trim())
}

function startsNewParagraph(text: string): boolean {
  const value = text.trim()
  return /^(?:第[一二三四五六七八九十百千万\d]+[章节卷篇部]|[一二三四五六七八九十百\d]+[、.．)]|[（(][一二三四五六七八九十百\d]+[）)]|[-*•·])/.test(value)
}

function paragraphType(type: OcrIrSemanticType): OcrParagraphV1['type'] {
  if (type === 'heading' || type === 'document_title') return 'heading'
  if (type === 'list' || type === 'index') return 'list'
  if (type === 'note' || type === 'caption' || type === 'footnote') return 'note'
  if (type === 'reference') return 'reference'
  return 'paragraph'
}

function unionBbox(left: OcrBoundingBox | undefined, right: OcrBoundingBox | undefined): OcrBoundingBox | undefined {
  if (!left) return right ? { ...right } : undefined
  if (!right) return { ...left }
  const minLeft = Math.min(left.left, right.left)
  const minTop = Math.min(left.top, right.top)
  const maxRight = Math.max(left.left + left.width, right.left + right.width)
  const maxBottom = Math.max(left.top + left.height, right.top + right.height)
  return {
    left: minLeft,
    top: minTop,
    width: maxRight - minLeft,
    height: maxBottom - minTop,
  }
}

function overlapRatio(
  leftStart: number,
  leftSize: number,
  rightStart: number,
  rightSize: number,
): number {
  const overlap = Math.max(0, Math.min(leftStart + leftSize, rightStart + rightSize) - Math.max(leftStart, rightStart))
  return overlap / Math.max(1, Math.min(leftSize, rightSize))
}

function sameTextFlow(left: OcrBlockV1, right: OcrBlockV1): boolean {
  if (!left.bbox || !right.bbox) return left.text.length < 48
  if (left.orientation === 'vertical') {
    if (left.columnIndex !== undefined && right.columnIndex !== undefined && Math.abs(left.columnIndex - right.columnIndex) > 1) return false
    const verticalOverlap = overlapRatio(left.bbox.top, left.bbox.height, right.bbox.top, right.bbox.height)
    const centerGap = Math.abs(
      (left.bbox.left + left.bbox.width / 2) - (right.bbox.left + right.bbox.width / 2),
    )
    const adjacentColumns = centerGap <= Math.max(left.bbox.width, right.bbox.width) * 2.5
    const topAligned = Math.abs(left.bbox.top - right.bbox.top) <= Math.max(left.bbox.width, right.bbox.width) * 1.8
    return adjacentColumns && (verticalOverlap >= 0.45 || topAligned)
  }

  if (left.columnIndex !== undefined && right.columnIndex !== undefined && left.columnIndex !== right.columnIndex) return false
  const horizontalOverlap = overlapRatio(left.bbox.left, left.bbox.width, right.bbox.left, right.bbox.width)
  const verticalGap = right.bbox.top - (left.bbox.top + left.bbox.height)
  const typicalLineHeight = Math.max(
    8,
    left.bbox.height / Math.max(1, left.lines.length),
    right.bbox.height / Math.max(1, right.lines.length),
  )
  const leftEdgeDelta = Math.abs(left.bbox.left - right.bbox.left)
  const alignedLeftEdge = leftEdgeDelta <= Math.max(18, Math.min(left.bbox.width, right.bbox.width) * 0.1)
  return verticalGap >= -typicalLineHeight * 0.75
    && verticalGap <= typicalLineHeight * 2.2
    && (horizontalOverlap >= 0.5 || alignedLeftEdge)
}

function canMergeParagraph(left: OcrBlockV1, right: OcrBlockV1): boolean {
  if (!PARAGRAPH_TYPES.has(left.type) || !PARAGRAPH_TYPES.has(right.type)) return false
  if (left.orientation !== 'unknown' && right.orientation !== 'unknown' && left.orientation !== right.orientation) return false
  if (left.type === 'caption' || right.type === 'caption' || left.type === 'footnote' || right.type === 'footnote') return false
  if (left.type === 'reference' !== (right.type === 'reference')) return false
  if (sentenceComplete(left.text)) return false
  if (startsNewParagraph(right.text)) return false
  return sameTextFlow(left, right)
}

function joinParagraphText(left: string, right: string): string {
  const a = left.trim()
  const b = right.trim()
  if (!a) return b
  if (!b) return a
  if (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)) {
    if (/-$/.test(a) && /^[a-z]/.test(b)) return `${a.slice(0, -1)}${b}`
    return `${a} ${b}`
  }
  return `${a}${b}`
}

export function rebuildOcrParagraphs(blocks: OcrBlockV1[], pageIndex: number): OcrParagraphV1[] {
  const paragraphs: OcrParagraphV1[] = []
  let previousBlock: OcrBlockV1 | null = null
  for (const block of [...blocks].sort(compareBlocks)) {
    if (!block.text || block.type === 'image' || block.type === 'chart' || block.type === 'table' || block.type === 'formula_display' || block.type === 'seal') {
      previousBlock = null
      continue
    }
    const previous = paragraphs[paragraphs.length - 1]
    if (previous && previousBlock && canMergeParagraph(previousBlock, block)) {
      previous.text = joinParagraphText(previous.text, block.text)
      previous.blockIds.push(block.id)
      previous.bbox = unionBbox(previous.bbox, block.bbox)
      previous.normalizedBbox = unionBbox(previous.normalizedBbox, block.normalizedBbox)
      previousBlock = block
      continue
    }
    paragraphs.push({
      id: `p${pageIndex}-paragraph-${paragraphs.length + 1}`,
      type: paragraphType(block.type),
      text: block.text,
      blockIds: [block.id],
      readingOrder: paragraphs.length,
      orientation: block.orientation,
      columnIndex: block.columnIndex,
      bbox: block.bbox ? { ...block.bbox } : undefined,
      normalizedBbox: block.normalizedBbox ? { ...block.normalizedBbox } : undefined,
    })
    previousBlock = block
  }
  return paragraphs
}

function invalidUnicodeRatio(text: string): number {
  if (!text) return 0
  let invalid = 0
  for (const char of text) {
    const code = char.codePointAt(0) || 0
    if (char === '\uFFFD' || (code >= 0xE000 && code <= 0xF8FF) || (code < 0x20 && !/[\n\r\t]/.test(char))) invalid += 1
  }
  return invalid / Math.max(1, [...text].length)
}

function buildQualityReport(blocks: OcrBlockV1[], discardedBlocks: OcrBlockV1[]): OcrQualityReport {
  const issues: OcrQualityIssue[] = []
  const allBlocks = [...blocks, ...discardedBlocks]
  const missingCoordinateBlockCount = allBlocks.filter((block) => !block.bbox).length
  const confidenceBlocks = allBlocks.filter((block) => block.confidence !== undefined)
  const lowConfidence = confidenceBlocks.filter((block) => Number(block.confidence) < 0.55)
  allBlocks.forEach((block) => {
    if (!block.text && !block.table && !block.assetId) {
      issues.push({ code: 'empty_text', severity: 'warning', message: 'Block has no readable content.', blockId: block.id })
    }
    if (!block.bbox) {
      issues.push({ code: 'missing_coordinates', severity: 'info', message: 'Block has no source coordinates.', blockId: block.id })
    }
    if (block.confidence !== undefined && block.confidence < 0.55) {
      issues.push({ code: 'low_confidence', severity: 'warning', message: 'Block confidence is below 0.55.', blockId: block.id })
    }
    if (invalidUnicodeRatio(block.text) >= 0.04) {
      issues.push({ code: 'invalid_unicode', severity: 'warning', message: 'Block contains suspicious Unicode characters.', blockId: block.id })
    }
    if (/fallback|回退/.test(String(block.source.stage || '').toLowerCase())) {
      issues.push({ code: 'fallback_used', severity: 'warning', message: 'A fallback OCR result was used.', blockId: block.id })
    }
    if (block.processing.some((event) => event.action === 'needs_region_rerecognition')) {
      issues.push({ code: 'needs_enhancement', severity: 'warning', message: 'Block is marked for local OCR enhancement.', blockId: block.id })
    }
  })
  const repeatedText = new Map<string, OcrBlockV1[]>()
  allBlocks.forEach((block) => {
    const compact = block.text.replace(/\s+/g, '')
    if (compact.length < 24) return
    const key = compact.slice(0, 160)
    const list = repeatedText.get(key) || []
    list.push(block)
    repeatedText.set(key, list)
  })
  repeatedText.forEach((duplicates) => {
    if (duplicates.length < 3) return
    issues.push({
      code: 'suspicious_repetition',
      severity: 'warning',
      message: `${duplicates.length} blocks contain the same long text.`,
      blockId: duplicates[0].id,
    })
  })
  if (discardedBlocks.length > 0) {
    issues.push({
      code: 'discarded_content',
      severity: 'info',
      message: `${discardedBlocks.length} decorative block(s) were preserved outside the reading flow.`,
    })
  }
  const coordinateCoverage = allBlocks.length > 0 ? (allBlocks.length - missingCoordinateBlockCount) / allBlocks.length : 0
  const confidenceCoverage = allBlocks.length > 0 ? confidenceBlocks.length / allBlocks.length : 0
  const warningPenalty = issues.filter((issue) => issue.severity === 'warning').length * 0.06
  const errorPenalty = issues.filter((issue) => issue.severity === 'error').length * 0.2
  return {
    score: Math.max(0, Math.min(1, 0.55 + coordinateCoverage * 0.25 + confidenceCoverage * 0.2 - warningPenalty - errorPenalty)),
    coordinateCoverage,
    confidenceCoverage,
    lowConfidenceBlockCount: lowConfidence.length,
    missingCoordinateBlockCount,
    discardedBlockCount: discardedBlocks.length,
    issues,
  }
}

function resolvePageSize(result: JsonRecord, blocks: JsonRecord[], options: BuildOcrIrOptions): { width: number; height: number } {
  const gujiProcessing = isRecord(result.guji_processing) ? result.guji_processing : null
  const preserveServiceCoordinates = gujiProcessing?.ocr_service_coordinates_preserved === true
  const localImageAlignedServiceCoordinates = preserveServiceCoordinates && (
    gujiProcessing?.service_coordinate_size_source === 'local_page_image'
    || Number(gujiProcessing?.service_coordinates_aligned_to_local_image || 0) > 0
  )
  const width = options.pageWidth
    || finiteNumber(firstValue(result, ['page_width', 'image_width', 'width']))
    || ((!preserveServiceCoordinates || localImageAlignedServiceCoordinates) && gujiProcessing ? finiteNumber(gujiProcessing.source_image_width) : null)
    || finiteNumber(result.source_image_width)
  const height = options.pageHeight
    || finiteNumber(firstValue(result, ['page_height', 'image_height', 'height']))
    || ((!preserveServiceCoordinates || localImageAlignedServiceCoordinates) && gujiProcessing ? finiteNumber(gujiProcessing.source_image_height) : null)
    || finiteNumber(result.source_image_height)
  if (width && height && width > 0 && height > 0) return { width, height }
  const boxes = blocks.map(getBlockBbox).filter((bbox): bbox is OcrBoundingBox => bbox !== undefined)
  return {
    width: Math.max(1, ...boxes.map((bbox) => bbox.left + bbox.width)),
    height: Math.max(1, ...boxes.map((bbox) => bbox.top + bbox.height)),
  }
}

function buildBlock(
  result: JsonRecord,
  block: JsonRecord,
  sourceIndex: number,
  pageIndex: number,
  width: number,
  height: number,
  options: BuildOcrIrOptions,
  assets: OcrAssetRef[],
  preferBlockOrder: boolean,
): OcrBlockV1 {
  const text = getBlockText(block)
  const rawText = normalizeText(firstValue(block, ['raw_words', 'raw_text']))
  const label = firstValue(block, ['label', 'block_label', 'type', 'block_type', 'category'])
  const type = semanticTypeForLabel(label, text)
  const bbox = getBlockBbox(block)
  const orientationInference = inferOrientation(block, bbox)
  const persistedSourceOrientation = parseOrientation(block.source_orientation)
  const sourceOrientation = persistedSourceOrientation !== 'unknown'
    ? persistedSourceOrientation
    : orientationInference.orientation
  const sourceOrientationSource = persistedSourceOrientation !== 'unknown'
    ? parseOrientationSource(block.source_orientation_source) || orientationInference.source
    : orientationInference.source
  const confidence = finiteNumber(firstValue(block, ['confidence', 'score']))
  const preferredBlockOrder = finiteNumber(block.block_order)
  const persistedReadingOrderSource = normalizeLabel(block.reading_order_source)
  const persistedSourceReadingOrder = finiteNumber(block.source_reading_order)
  const explicitReadingOrder = finiteNumber(block.reading_order)
  const sourceReadingOrder = persistedReadingOrderSource === 'ocr' && persistedSourceReadingOrder !== null
    ? persistedSourceReadingOrder
    : persistedReadingOrderSource === 'coordinate' || persistedReadingOrderSource === 'source'
      ? null
      : preferBlockOrder && preferredBlockOrder !== null && preferredBlockOrder > 0
        ? preferredBlockOrder
        : explicitReadingOrder ?? (
          preferredBlockOrder !== null && preferredBlockOrder > 0
            ? preferredBlockOrder
            : null
        )
  const readingOrderSource = persistedReadingOrderSource === 'coordinate'
    ? 'coordinate' as const
    : persistedReadingOrderSource === 'source'
      ? 'source' as const
      : sourceReadingOrder !== null
        ? 'ocr' as const
        : bbox
          ? 'coordinate' as const
          : 'source' as const
  const manualReadingOrder = finiteNumber(block.manual_reading_order)
  const source = sourceForBlock(result, block, options, sourceIndex)
  const assetPath = getAssetPath(block)
  const assetKind = type === 'table' ? 'table' : type === 'formula_inline' || type === 'formula_display' ? 'formula' : type === 'chart' ? 'chart' : 'image'
  const assetId = assetPath || ['image', 'chart', 'table', 'formula_inline', 'formula_display'].includes(type)
    ? `p${pageIndex}-asset-${assets.length + 1}`
    : undefined
  if (assetId) {
    assets.push({
      id: assetId,
      kind: assetKind,
      path: assetPath || undefined,
      bbox,
      normalizedBbox: normalizeBbox(bbox, width, height),
    })
  }
  const lines = splitLines(text).map((lineText, lineIndex) => {
    const bboxForLine = lineBbox(bbox, lineIndex, splitLines(text).length, orientationInference.orientation)
    const span: OcrSpanV1 = {
      id: `p${pageIndex}-b${sourceIndex + 1}-l${lineIndex + 1}-s1`,
      type: 'text',
      text: lineText,
      bbox: bboxForLine,
      normalizedBbox: normalizeBbox(bboxForLine, width, height),
      confidence: confidence ?? undefined,
      source,
    }
    return {
      id: `p${pageIndex}-b${sourceIndex + 1}-l${lineIndex + 1}`,
      text: lineText,
      bbox: bboxForLine,
      normalizedBbox: normalizeBbox(bboxForLine, width, height),
      confidence: confidence ?? undefined,
      spans: [span],
    }
  })
  const processing: OcrProcessingEvent[] = [{
    stage: 'normalize',
    action: 'legacy_result_to_ir',
    reason: firstText(block, ['segmentation_source']) || undefined,
  }]
  if (block.needs_enhancement === true) {
    processing.push({
      stage: 'quality',
      action: 'needs_region_rerecognition',
      reason: 'legacy_block_needs_enhancement',
    })
  }
  return {
    id: `p${pageIndex}-block-${sourceIndex + 1}`,
    type,
    text,
    rawText: rawText || undefined,
    bbox,
    normalizedBbox: normalizeBbox(bbox, width, height),
    confidence: confidence ?? undefined,
    orientation: orientationInference.orientation,
    orientationSource: parseOrientationSource(block.orientation_source) || orientationInference.source,
    sourceOrientation,
    sourceOrientationSource,
    readingOrder: sourceReadingOrder ?? sourceIndex,
    sourceReadingOrder: sourceReadingOrder ?? undefined,
    readingOrderSource,
    manualReadingOrder: manualReadingOrder ?? undefined,
    columnIndex: finiteNumber(block.column_index) ?? undefined,
    lines,
    table: type === 'table' ? getTable(block, width, height) : undefined,
    formula: getFormula(block, type),
    assetId,
    source,
    processing,
  }
}

interface OrientationConsensus {
  orientation: OcrIrOrientation
  confidence: number
  evidenceSource: Extract<OcrIrOrientationSource, 'ocr' | 'coordinate' | 'unknown'>
}

const BODY_ORIENTATION_TYPES = new Set<OcrIrSemanticType>([
  'paragraph',
  'abstract',
  'reference',
  'list',
  'index',
  'note',
  'code',
])

const READING_FLOW_ORIENTATION_TYPES = new Set<OcrIrSemanticType>([
  ...BODY_ORIENTATION_TYPES,
  'document_title',
  'heading',
  'caption',
  'footnote',
])

function orientationConsensus(blocks: OcrBlockV1[]): OrientationConsensus {
  const readableBlocks = blocks.filter((block) => (
    Boolean(block.text.trim())
    && READING_FLOW_ORIENTATION_TYPES.has(block.type)
    && block.sourceOrientation !== 'unknown'
  ))
  const bodyBlocks = readableBlocks.filter((block) => BODY_ORIENTATION_TYPES.has(block.type))
  const evidencePool = bodyBlocks.length > 0 ? bodyBlocks : readableBlocks
  const ocrEvidence = evidencePool.filter((block) => block.sourceOrientationSource === 'ocr')
  const coordinateEvidence = evidencePool.filter((block) => block.sourceOrientationSource === 'coordinate')
  const selected = ocrEvidence.length > 0 ? ocrEvidence : coordinateEvidence
  if (selected.length === 0) {
    return { orientation: 'unknown', confidence: 0, evidenceSource: 'unknown' }
  }

  let horizontalWeight = 0
  let verticalWeight = 0
  selected.forEach((block) => {
    const textLength = block.text.replace(/\s+/g, '').length
    const textWeight = Math.max(1, Math.min(12, Math.sqrt(Math.max(1, textLength))))
    const confidenceWeight = block.confidence === undefined
      ? 1
      : Math.max(0.35, Math.min(1, block.confidence))
    const weight = textWeight * confidenceWeight
    if (block.sourceOrientation === 'vertical') verticalWeight += weight
    if (block.sourceOrientation === 'horizontal') horizontalWeight += weight
  })
  const total = horizontalWeight + verticalWeight
  if (total <= 0) {
    return { orientation: 'unknown', confidence: 0, evidenceSource: 'unknown' }
  }
  const orientation = verticalWeight > horizontalWeight ? 'vertical' : 'horizontal'
  return {
    orientation,
    confidence: Math.max(horizontalWeight, verticalWeight) / total,
    evidenceSource: ocrEvidence.length > 0 ? 'ocr' : 'coordinate',
  }
}

function applyReadingOrientation(
  blocks: OcrBlockV1[],
  orientation: OcrIrOrientation,
  source: Extract<OcrIrOrientationSource, 'page_consensus' | 'document_consensus'>,
): void {
  if (orientation === 'unknown') return
  blocks.forEach((block) => {
    if (!READING_FLOW_ORIENTATION_TYPES.has(block.type) || !block.text.trim()) return
    if (block.orientationSource === 'manual') return
    if (block.orientation !== orientation) {
      block.processing.push({
        stage: source === 'document_consensus' ? 'document_postprocess' : 'page_postprocess',
        action: 'apply_dominant_reading_orientation',
        reason: orientation === 'vertical' ? 'vertical_right_to_left' : 'horizontal',
      })
    }
    block.orientation = orientation
    block.orientationSource = source
  })
}

function orderReadingBlocks(blocks: OcrBlockV1[]): OcrBlockV1[] {
  const ordered = [...blocks].sort(compareBlocks)
  ordered.forEach((block, index) => {
    block.readingOrder = index
  })
  return ordered
}

function rebuildPageReadingFlow(page: OcrPageV1): void {
  page.blocks = orderReadingBlocks(page.blocks)
  page.blocks.forEach((block) => {
    delete block.parentBlockId
    delete block.childBlockIds
  })
  groupRelatedBlocks(page.blocks)
  page.paragraphs = rebuildOcrParagraphs(page.blocks, page.pageIndex)
  page.quality = buildQualityReport(page.blocks, page.discardedBlocks)
}

function relationDistance(parent: OcrBlockV1, child: OcrBlockV1): number {
  if (!parent.bbox || !child.bbox) return Math.abs(parent.readingOrder - child.readingOrder) * 100
  const horizontalOverlap = overlapRatio(parent.bbox.left, parent.bbox.width, child.bbox.left, child.bbox.width)
  const verticalOverlap = overlapRatio(parent.bbox.top, parent.bbox.height, child.bbox.top, child.bbox.height)
  const parentCenterX = parent.bbox.left + parent.bbox.width / 2
  const parentCenterY = parent.bbox.top + parent.bbox.height / 2
  const childCenterX = child.bbox.left + child.bbox.width / 2
  const childCenterY = child.bbox.top + child.bbox.height / 2
  const axisDistance = child.orientation === 'vertical'
    ? Math.abs(parentCenterX - childCenterX)
    : Math.abs(parentCenterY - childCenterY)
  const overlapBonus = Math.max(horizontalOverlap, verticalOverlap) * 120
  return axisDistance - overlapBonus + Math.abs(parent.readingOrder - child.readingOrder) * 8
}

function attachChild(parent: OcrBlockV1, child: OcrBlockV1, reason: string): void {
  child.parentBlockId = parent.id
  parent.childBlockIds = [...new Set([...(parent.childBlockIds || []), child.id])]
  child.processing.push({ stage: 'relation', action: 'attach_to_parent', reason })
}

function groupRelatedBlocks(blocks: OcrBlockV1[]): void {
  blocks.forEach((block, index) => {
    if (block.type === 'caption') {
      const parent = blocks
        .filter((candidate) => candidate.id !== block.id && ['image', 'chart', 'table', 'formula_display'].includes(candidate.type))
        .filter((candidate) => Math.abs(candidate.readingOrder - block.readingOrder) <= 5)
        .sort((left, right) => relationDistance(left, block) - relationDistance(right, block))[0]
      if (parent && relationDistance(parent, block) <= 220) attachChild(parent, block, 'nearest_rich_content')
      return
    }

    if (block.type === 'footnote') {
      const parent = blocks
        .slice(Math.max(0, index - 8), index)
        .filter((candidate) => ['paragraph', 'abstract', 'reference', 'note', 'formula_display'].includes(candidate.type))
        .sort((left, right) => relationDistance(left, block) - relationDistance(right, block))[0]
      if (parent) attachChild(parent, block, 'nearest_preceding_text')
      return
    }

    if (block.type === 'formula_inline' && block.bbox) {
      const parent = blocks
        .filter((candidate) => candidate.id !== block.id && ['paragraph', 'abstract', 'note', 'reference'].includes(candidate.type))
        .filter((candidate) => candidate.bbox
          && overlapRatio(candidate.bbox.left, candidate.bbox.width, block.bbox!.left, block.bbox!.width) > 0
          && overlapRatio(candidate.bbox.top, candidate.bbox.height, block.bbox!.top, block.bbox!.height) > 0)
        .sort((left, right) => relationDistance(left, block) - relationDistance(right, block))[0]
      if (parent) attachChild(parent, block, 'inline_formula_overlap')
    }
  })
}

export function buildOcrPageIr(resultValue: unknown, options: BuildOcrIrOptions = {}): OcrPageIrEnvelopeV1 {
  const parsed = parseMaybeJson(resultValue)
  const result = isRecord(parsed) ? parsed : {}
  const existing = result.gujismart_ir
  if (
    !options.forceRebuild
    && isRecord(existing)
    && existing.schemaVersion === OCR_IR_SCHEMA_VERSION
    && existing.pipelineVersion === OCR_IR_PIPELINE_VERSION
    && isRecord(existing.page)
  ) {
    return existing as unknown as OcrPageIrEnvelopeV1
  }
  const sourceBlocks = getSourceBlocks(result)
  const size = resolvePageSize(result, sourceBlocks, options)
  const pageIndex = Math.max(1, Math.floor(options.pageIndex || finiteNumber(result.page_num) || 1))
  const assets: OcrAssetRef[] = []
  const preferBlockOrder = shouldPreferSourceBlockOrder(sourceBlocks)
  const built = sourceBlocks.map((block, index) => buildBlock(
    result,
    block,
    index,
    pageIndex,
    size.width,
    size.height,
    options,
    assets,
    preferBlockOrder,
  ))
  const consensus = orientationConsensus(built)
  applyReadingOrientation(built, consensus.orientation, 'page_consensus')
  const ordered = orderReadingBlocks(built)
  groupRelatedBlocks(ordered)
  const blocks = ordered.filter((block) => !DISCARDED_TYPES.has(block.type))
  const discardedBlocks = ordered.filter((block) => DISCARDED_TYPES.has(block.type))
  const paragraphs = rebuildOcrParagraphs(blocks, pageIndex)
  return {
    schemaVersion: OCR_IR_SCHEMA_VERSION,
    generator: 'GujiSmart',
    pipelineVersion: OCR_IR_PIPELINE_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    page: {
      pageIndex,
      width: size.width,
      height: size.height,
      orientation: consensus.orientation,
      orientationSource: consensus.evidenceSource,
      blocks,
      discardedBlocks,
      paragraphs,
      assets,
      quality: buildQualityReport(blocks, discardedBlocks),
    },
  }
}

export function getOcrPageIr(value: unknown): OcrPageIrEnvelopeV1 | null {
  const parsed = parseMaybeJson(value)
  if (!isRecord(parsed) || !isRecord(parsed.gujismart_ir)) return null
  const envelope = parsed.gujismart_ir
  return envelope.schemaVersion === OCR_IR_SCHEMA_VERSION && isRecord(envelope.page)
    ? envelope as unknown as OcrPageIrEnvelopeV1
    : null
}

export function getOrBuildOcrPageIr(
  value: unknown,
  options: BuildOcrIrOptions = {},
): OcrPageIrEnvelopeV1 | null {
  const existing = getOcrPageIr(value)
  if (existing?.pipelineVersion === OCR_IR_PIPELINE_VERSION) return existing
  const parsed = parseMaybeJson(value)
  if (!isRecord(parsed)) return null
  const envelope = buildOcrPageIr(parsed, {
    ...options,
    forceRebuild: true,
  })
  return envelope.page.blocks.length > 0 || envelope.page.discardedBlocks.length > 0
    ? envelope
    : null
}

export function getOcrRegionRerecognitionCandidates(
  value: OcrPageIrEnvelopeV1 | OcrPageV1,
  limit = 8,
): OcrRegionRerecognitionCandidate[] {
  const page = 'page' in value ? value.page : value
  const eligibleCodes = new Set<OcrQualityIssue['code']>([
    'empty_text',
    'low_confidence',
    'invalid_unicode',
    'fallback_used',
    'needs_enhancement',
  ])
  const reasonsByBlockId = new Map<string, OcrQualityIssue['code'][]>() 
  page.quality.issues.forEach((issue) => {
    if (!issue.blockId || !eligibleCodes.has(issue.code)) return
    const reasons = reasonsByBlockId.get(issue.blockId) || []
    if (!reasons.includes(issue.code)) reasons.push(issue.code)
    reasonsByBlockId.set(issue.blockId, reasons)
  })
  return page.blocks
    .filter((block) => block.bbox && block.source.sourceIndex !== undefined && reasonsByBlockId.has(block.id))
    .filter((block) => ['paragraph', 'abstract', 'reference', 'note', 'caption', 'footnote', 'list', 'index'].includes(block.type))
    .sort((left, right) => {
      const leftReasons = reasonsByBlockId.get(left.id) || []
      const rightReasons = reasonsByBlockId.get(right.id) || []
      const leftPriority = leftReasons.includes('empty_text') || leftReasons.includes('invalid_unicode') ? 0 : leftReasons.includes('low_confidence') ? 1 : 2
      const rightPriority = rightReasons.includes('empty_text') || rightReasons.includes('invalid_unicode') ? 0 : rightReasons.includes('low_confidence') ? 1 : 2
      return leftPriority - rightPriority
        || (left.confidence ?? 1) - (right.confidence ?? 1)
        || left.readingOrder - right.readingOrder
    })
    .slice(0, Math.max(1, Math.min(20, Math.floor(limit))))
    .map((block) => ({
      blockId: block.id,
      bbox: { ...block.bbox! },
      orientation: block.orientation,
      sourceIndex: block.source.sourceIndex!,
      reasons: reasonsByBlockId.get(block.id) || [],
    }))
}

function blockTextForReading(block: OcrBlockV1): string {
  if (block.table?.rows.length) return block.table.rows.map((row) => row.join('\t')).join('\n')
  if (block.formula?.latex) return block.formula.display ? `$$${block.formula.latex}$$` : `$${block.formula.latex}$`
  return block.text
}

function blockToRecognizeLayoutBlock(page: OcrPageV1, block: OcrBlockV1): OcrRecognizeLayoutBlock {
  return {
    words: blockTextForReading(block),
    raw_words: block.rawText,
    label: block.type,
    location: block.bbox,
    normalized_location: block.normalizedBbox,
    confidence: block.confidence,
    reading_order: block.readingOrder,
    source_reading_order: block.sourceReadingOrder,
    reading_order_source: block.readingOrderSource,
    manual_reading_order: block.manualReadingOrder,
    column_index: block.columnIndex,
    orientation: block.orientation,
    orientation_source: block.orientationSource,
    source_orientation: block.sourceOrientation,
    source_orientation_source: block.sourceOrientationSource,
    rows: block.table?.rows,
    cells: block.table?.cells,
    html: block.table?.html,
    markdown: block.table?.markdown,
    latex: block.formula?.latex,
    image_path: page.assets.find((asset) => asset.id === block.assetId)?.path,
    ir_block_id: block.id,
    parent_ir_block_id: block.parentBlockId,
    child_ir_block_ids: block.childBlockIds,
  }
}

export function deriveOcrReadingBlocksFromIr(
  value: OcrPageIrEnvelopeV1 | OcrPageV1,
): OcrRecognizeLayoutBlock[] {
  const page = 'page' in value ? value.page : value
  const paragraphsByFirstBlockId = new Map(
    page.paragraphs
      .filter((paragraph) => paragraph.blockIds.length > 0)
      .map((paragraph) => [paragraph.blockIds[0], paragraph]),
  )
  const paragraphBlockIds = new Set(page.paragraphs.flatMap((paragraph) => paragraph.blockIds))
  const blockById = new Map(page.blocks.map((block) => [block.id, block]))
  const readingBlocks: OcrRecognizeLayoutBlock[] = []

  for (const block of [...page.blocks].sort(compareBlocks)) {
    const paragraph = paragraphsByFirstBlockId.get(block.id)
    if (paragraph) {
      readingBlocks.push({
        words: paragraph.text,
        label: paragraph.blockIds.length === 1 ? block.type : paragraph.type,
        location: paragraph.bbox,
        normalized_location: paragraph.normalizedBbox,
        reading_order: block.readingOrder,
        manual_reading_order: block.manualReadingOrder,
        column_index: paragraph.columnIndex,
        orientation: paragraph.orientation,
        ir_paragraph_id: paragraph.id,
        ir_block_ids: paragraph.blockIds,
        continues_from_previous_page: paragraph.continuesFromPreviousPage,
        continues_to_next_page: paragraph.continuesToNextPage,
        continuation_group_id: paragraph.continuationGroupId,
        source_blocks: paragraph.blockIds
          .map((blockId) => blockById.get(blockId))
          .filter((item): item is OcrBlockV1 => item !== undefined)
          .map((item) => item.id),
      })
      continue
    }
    if (paragraphBlockIds.has(block.id)) continue
    readingBlocks.push(blockToRecognizeLayoutBlock(page, block))
  }
  return readingBlocks
}

function mutableSourceBlocks(result: JsonRecord): unknown[] {
  const directKeys = ['layout_result', 'layout_blocks', 'parsing_res_list', 'boxes', 'words_result'] as const
  for (const key of directKeys) {
    if (Array.isArray(result[key])) return result[key] as unknown[]
  }
  if (isRecord(result.prunedResult) && Array.isArray(result.prunedResult.parsing_res_list)) {
    return result.prunedResult.parsing_res_list
  }
  if (isRecord(result.layout_det_res) && Array.isArray(result.layout_det_res.boxes)) {
    return result.layout_det_res.boxes
  }
  return []
}

function compactRegionText(value: unknown): string {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '')
}

function regionInvalidUnicodeRatio(value: string): number {
  const chars = [...value]
  if (chars.length === 0) return 0
  const invalidCount = chars.filter((char) => {
    const code = char.codePointAt(0) || 0
    return char === '\uFFFD' || (code >= 0xE000 && code <= 0xF8FF) || (code < 0x20 && !/[\n\r\t]/.test(char))
  }).length
  return invalidCount / chars.length
}

export function shouldAcceptOcrRegionText(previousText: string, nextText: string): boolean {
  const previous = compactRegionText(previousText)
  const next = compactRegionText(nextText)
  if (!next || next === previous) return false
  if (regionInvalidUnicodeRatio(next) >= 0.04) return false
  if (!previous) return next.length <= 240
  const previousInvalid = regionInvalidUnicodeRatio(previous)
  if (next.length > Math.max(80, previous.length * 3 + 24)) return false
  if (previous.length >= 16 && next.length < previous.length * 0.25 && previousInvalid < 0.04) return false
  return true
}

export function applyOcrRegionTextReplacement(
  resultValue: unknown,
  replacement: OcrRegionTextReplacement,
): { result: OcrRecognizeResult; updated: boolean } {
  const parsed = parseMaybeJson(resultValue)
  const source = isRecord(parsed) ? parsed : {}
  const result = JSON.parse(JSON.stringify(source)) as OcrRecognizeResult & JsonRecord
  const blocks = mutableSourceBlocks(result)
  const block = blocks[replacement.sourceIndex]
  if (!isRecord(block)) return { result, updated: false }
  const previousText = firstText(block, ['words', 'text', 'content'])
  if (!shouldAcceptOcrRegionText(previousText, replacement.text)) return { result, updated: false }
  block.raw_words = block.raw_words || previousText
  block.words = replacement.text.trim()
  block.text = replacement.text.trim()
  if (replacement.confidence !== undefined && Number.isFinite(replacement.confidence)) {
    block.confidence = replacement.confidence
    block.score = replacement.confidence
  } else {
    delete block.confidence
    delete block.score
  }
  block.segmentation_source = 'region_rerecognition'
  block.needs_enhancement = false
  block.region_rerecognized_at = replacement.recognizedAt || new Date().toISOString()
  block.region_rerecognition_reasons = replacement.reasons || []
  return { result, updated: true }
}

export function deriveOcrTextFromIr(value: OcrPageIrEnvelopeV1 | OcrPageV1, includeDiscarded = false): string {
  const page = 'page' in value ? value.page : value
  const bodyText = deriveOcrReadingBlocksFromIr(page)
    .map((block) => String(block.words || block.text || '').trim())
    .filter(Boolean)
  if (!includeDiscarded) return bodyText.join('\n\n')
  const discardedText = [...page.discardedBlocks]
    .sort(compareBlocks)
    .map(blockTextForReading)
    .filter(Boolean)
  return [...bodyText, ...discardedText].join('\n\n')
}

export function deriveOcrWordsResultFromIr(value: OcrPageIrEnvelopeV1 | OcrPageV1): OcrRecognizeLayoutBlock[] {
  const page = 'page' in value ? value.page : value
  return page.blocks.map((block) => blockToRecognizeLayoutBlock(page, block))
}

export function ensureOcrResultIr(resultValue: unknown, options: BuildOcrIrOptions = {}): OcrRecognizeResult {
  const parsed = parseMaybeJson(resultValue)
  const result: OcrRecognizeResult = isRecord(parsed) ? { ...parsed } : {}
  const envelope = buildOcrPageIr(result, options)
  const text = deriveOcrTextFromIr(envelope)
  return {
    ...result,
    text: text || normalizeText(result.text),
    words_result: text ? deriveOcrWordsResultFromIr(envelope) : result.words_result,
    gujismart_ir: envelope,
    ir_text: text,
    normalization: {
      ...(isRecord(result.normalization) ? result.normalization : {}),
      schema_version: OCR_IR_SCHEMA_VERSION,
      pipeline_version: OCR_IR_PIPELINE_VERSION,
      generated_at: envelope.generatedAt,
    },
  }
}

function combineQuality(reports: OcrQualityReport[]): OcrQualityReport {
  if (reports.length === 0) {
    return {
      score: 0,
      coordinateCoverage: 0,
      confidenceCoverage: 0,
      lowConfidenceBlockCount: 0,
      missingCoordinateBlockCount: 0,
      discardedBlockCount: 0,
      issues: [],
    }
  }
  return {
    score: reports.reduce((sum, report) => sum + report.score, 0) / reports.length,
    coordinateCoverage: reports.reduce((sum, report) => sum + report.coordinateCoverage, 0) / reports.length,
    confidenceCoverage: reports.reduce((sum, report) => sum + report.confidenceCoverage, 0) / reports.length,
    lowConfidenceBlockCount: reports.reduce((sum, report) => sum + report.lowConfidenceBlockCount, 0),
    missingCoordinateBlockCount: reports.reduce((sum, report) => sum + report.missingCoordinateBlockCount, 0),
    discardedBlockCount: reports.reduce((sum, report) => sum + report.discardedBlockCount, 0),
    issues: reports.flatMap((report) => report.issues),
  }
}

function paragraphBoundaryBlock(page: OcrPageV1, paragraph: OcrParagraphV1, edge: 'first' | 'last'): OcrBlockV1 | undefined {
  const blockId = edge === 'first' ? paragraph.blockIds[0] : paragraph.blockIds[paragraph.blockIds.length - 1]
  return page.blocks.find((block) => block.id === blockId)
}

function crossPageContinuationScore(
  previousPage: OcrPageV1,
  previous: OcrParagraphV1,
  nextPage: OcrPageV1,
  next: OcrParagraphV1,
): number {
  if (previous.type !== 'paragraph' || next.type !== 'paragraph') return -100
  if (sentenceComplete(previous.text) || startsNewParagraph(next.text)) return -100
  const previousBlock = paragraphBoundaryBlock(previousPage, previous, 'last')
  const nextBlock = paragraphBoundaryBlock(nextPage, next, 'first')
  if (!previousBlock || !nextBlock) return 2
  if (
    previousBlock.orientation !== 'unknown'
    && nextBlock.orientation !== 'unknown'
    && previousBlock.orientation !== nextBlock.orientation
  ) return -100

  let score = 2
  if (/^[，。；：、,.;:）)\]】」』”’]/.test(next.text.trim()) || /^[a-z]/.test(next.text.trim())) score += 2
  if (previousBlock.orientation === 'vertical') {
    if (previousBlock.normalizedBbox && previousBlock.normalizedBbox.left <= 360) score += 1
    if (nextBlock.normalizedBbox && nextBlock.normalizedBbox.left + nextBlock.normalizedBbox.width >= 640) score += 1
    const topDelta = previousBlock.normalizedBbox && nextBlock.normalizedBbox
      ? Math.abs(previousBlock.normalizedBbox.top - nextBlock.normalizedBbox.top)
      : 0
    if (topDelta <= 180) score += 1
  } else {
    if (previousBlock.normalizedBbox && previousBlock.normalizedBbox.top + previousBlock.normalizedBbox.height >= 680) score += 1
    if (nextBlock.normalizedBbox && nextBlock.normalizedBbox.top <= 320) score += 1
    if (
      previousBlock.normalizedBbox
      && nextBlock.normalizedBbox
      && Math.abs(previousBlock.normalizedBbox.left - nextBlock.normalizedBbox.left) <= 160
    ) score += 1
  }
  return score
}

function markCrossPageContinuity(pages: OcrPageV1[]): OcrParagraphV1[] {
  const all: OcrParagraphV1[] = []
  pages.forEach((page, pageIndex) => {
    const first = page.paragraphs.find((paragraph) => paragraph.type === 'paragraph')
    const previousPage = pages[pageIndex - 1]
    const previous = previousPage
      ? [...previousPage.paragraphs].reverse().find((paragraph) => paragraph.type === 'paragraph')
      : undefined
    if (first && previous && previousPage && crossPageContinuationScore(previousPage, previous, page, first) >= 4) {
      const groupId = previous.continuationGroupId || `paragraph-flow-${previousPage.pageIndex}-${previous.readingOrder}`
      previous.continuesToNextPage = true
      previous.continuationGroupId = groupId
      first.continuesFromPreviousPage = true
      first.continuationGroupId = groupId
    }
    all.push(...page.paragraphs)
  })
  return all
}

function normalizedRepeatedText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/\d+/g, '#')
    .replace(/[.,，。:：;；\-—_()[\]（）【】]/g, '')
    .toLowerCase()
}

function suppressRepeatedMarginalBlocks(pages: OcrPageV1[]): void {
  if (pages.length < 3) return
  const occurrences = new Map<string, Array<{ page: OcrPageV1; block: OcrBlockV1; edge: 'top' | 'bottom' }>>()
  pages.forEach((page) => {
    page.blocks.forEach((block) => {
      if (!block.normalizedBbox || !block.text || block.text.length > 100) return
      const edge = block.normalizedBbox.top <= 130
        ? 'top'
        : block.normalizedBbox.top + block.normalizedBbox.height >= 870
          ? 'bottom'
          : null
      if (!edge) return
      const key = normalizedRepeatedText(block.text)
      if (key.length < 2) return
      const list = occurrences.get(`${edge}:${key}`) || []
      list.push({ page, block, edge })
      occurrences.set(`${edge}:${key}`, list)
    })
  })
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4))
  occurrences.forEach((items) => {
    if (new Set(items.map((item) => item.page.pageIndex)).size < threshold) return
    items.forEach(({ page, block, edge }) => {
      page.blocks = page.blocks.filter((candidate) => candidate.id !== block.id)
      block.type = edge === 'top' ? 'page_header' : 'page_footer'
      block.processing.push({
        stage: 'document_postprocess',
        action: 'move_repeated_margin_to_discarded',
        reason: `repeated_${edge}_margin`,
      })
      if (!page.discardedBlocks.some((candidate) => candidate.id === block.id)) page.discardedBlocks.push(block)
    })
  })
  pages.forEach((page) => {
    page.paragraphs = rebuildOcrParagraphs(page.blocks, page.pageIndex)
    page.quality = buildQualityReport(page.blocks, page.discardedBlocks)
  })
}

function markCrossPageTables(pages: OcrPageV1[]): void {
  for (let index = 0; index < pages.length - 1; index += 1) {
    const currentTable = [...pages[index].blocks].reverse().find((block) => block.type === 'table' && block.table)
    const nextTable = pages[index + 1].blocks.find((block) => block.type === 'table' && block.table)
    if (!currentTable?.table || !nextTable?.table) continue
    const currentColumns = Math.max(
      0,
      ...currentTable.table.rows.map((row) => row.length),
      ...currentTable.table.cells.map((cell) => cell.column + cell.columnSpan),
    )
    const nextColumns = Math.max(
      0,
      ...nextTable.table.rows.map((row) => row.length),
      ...nextTable.table.cells.map((cell) => cell.column + cell.columnSpan),
    )
    if (currentColumns === 0 || nextColumns === 0 || currentColumns !== nextColumns) continue
    if (currentTable.normalizedBbox && currentTable.normalizedBbox.top + currentTable.normalizedBbox.height < 760) continue
    if (nextTable.normalizedBbox && nextTable.normalizedBbox.top > 240) continue
    currentTable.table.continuesToNextPage = true
    nextTable.table.continuesFromPreviousPage = true
    currentTable.processing.push({ stage: 'document_postprocess', action: 'mark_cross_page_table' })
    nextTable.processing.push({ stage: 'document_postprocess', action: 'mark_cross_page_table' })
  }
}

function applyDocumentReadingOrientation(pages: OcrPageV1[]): OrientationConsensus {
  const consensus = orientationConsensus(pages.flatMap((page) => page.blocks))
  if (consensus.orientation === 'unknown') return consensus
  pages.forEach((page) => {
    applyReadingOrientation(page.blocks, consensus.orientation, 'document_consensus')
    page.orientation = consensus.orientation
    page.orientationSource = 'document_consensus'
    rebuildPageReadingFlow(page)
  })
  return consensus
}

export function buildOcrDocumentV1(pageValues: unknown[], options: Omit<BuildOcrIrOptions, 'pageIndex'> = {}): OcrDocumentV1 {
  const pages = pageValues
    .map((value, index) => buildOcrPageIr(value, { ...options, pageIndex: index + 1 }).page)
    .sort((left, right) => left.pageIndex - right.pageIndex)
  const orientation = applyDocumentReadingOrientation(pages)
  suppressRepeatedMarginalBlocks(pages)
  markCrossPageTables(pages)
  return {
    schemaVersion: OCR_IR_SCHEMA_VERSION,
    generator: 'GujiSmart',
    pipelineVersion: OCR_IR_PIPELINE_VERSION,
    orientation: orientation.orientation,
    orientationConfidence: orientation.confidence,
    pages,
    paragraphs: markCrossPageContinuity(pages),
    quality: combineQuality(pages.map((page) => page.quality)),
  }
}
