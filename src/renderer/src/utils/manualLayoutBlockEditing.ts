import type { ManualLayoutBlockKind } from '@shared/manual-layout'

export type ManualLayoutTool = 'select' | ManualLayoutBlockKind
export type ManualLayoutResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export interface ManualLayoutRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ManualLayoutBounds extends ManualLayoutRect {}

export interface ManualLayoutMinimumSize {
  width: number
  height: number
}

export type ManualLayoutEditableBlock = Record<string, unknown> & {
  manual_block_id?: string
  label?: string
}

export interface ManualLayoutGeometryPreview<T extends ManualLayoutEditableBlock = ManualLayoutEditableBlock> {
  blockId: string
  baseline: readonly T[]
  blocks: readonly T[]
}

export interface ManualLayoutEditEntryPreparation {
  imageUnderlayMode: 'on'
  showRules: true
  translationOpen: false
  pageRotation: 0
  tool: 'select'
  layoutEditMode: true
}

export function getManualLayoutEditEntryPreparation(): ManualLayoutEditEntryPreparation {
  return {
    imageUnderlayMode: 'on',
    showRules: true,
    translationOpen: false,
    pageRotation: 0,
    tool: 'select',
    layoutEditMode: true,
  }
}

export interface ManualLayoutPointerFrameScheduler<T> {
  schedule(value: T): void
  flush(): boolean
  cancel(): void
}

export function createManualLayoutPointerFrameScheduler<T>(
  requestFrame: (callback: () => void) => number,
  cancelFrame: (frameId: number) => void,
  applyLatest: (value: T) => void,
): ManualLayoutPointerFrameScheduler<T> {
  let frameId: number | null = null
  let latestValue: T
  let hasLatestValue = false

  const apply = () => {
    frameId = null
    if (!hasLatestValue) return false
    const value = latestValue
    hasLatestValue = false
    applyLatest(value)
    return true
  }

  return {
    schedule(value) {
      latestValue = value
      hasLatestValue = true
      if (frameId !== null) return
      frameId = requestFrame(() => { apply() })
    },
    flush() {
      if (frameId !== null) {
        cancelFrame(frameId)
        frameId = null
      }
      return apply()
    },
    cancel() {
      if (frameId !== null) cancelFrame(frameId)
      frameId = null
      hasLatestValue = false
    },
  }
}

export const MANUAL_LAYOUT_BLOCK_KINDS: readonly ManualLayoutBlockKind[] = [
  'text',
  'title',
  'paragraph_title',
  'note',
  'abstract',
  'reference',
  'header',
  'footer',
  'number',
  'table',
  'image',
  'seal',
]

export const MANUAL_LAYOUT_QUICK_KINDS: readonly ManualLayoutBlockKind[] = [
  'text',
  'note',
  'table',
  'image',
]

export const MANUAL_LAYOUT_MORE_KINDS: readonly ManualLayoutBlockKind[] = [
  'title',
  'paragraph_title',
  'abstract',
  'reference',
  'header',
  'footer',
  'number',
  'seal',
]

export type ManualLayoutToolAction =
  | { type: 'choose-select' }
  | { type: 'choose-kind'; kind: ManualLayoutBlockKind }
  | { type: 'escape' }
  | { type: 'created' }

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function isManualLayoutBlockKind(value: unknown): value is ManualLayoutBlockKind {
  return typeof value === 'string' && MANUAL_LAYOUT_BLOCK_KINDS.includes(value as ManualLayoutBlockKind)
}

export function reduceManualLayoutTool(
  current: ManualLayoutTool,
  action: ManualLayoutToolAction,
): ManualLayoutTool {
  if (action.type === 'choose-kind') return action.kind
  if (action.type === 'choose-select' || action.type === 'escape') return 'select'
  return current
}

export function getManualLayoutBlockVisualState(
  blockId: string,
  activeBlockId: string | null,
  sourceIndex: number,
  highlightedSourceIndex: number,
): { editingActive: boolean; parentHighlighted: boolean } {
  return {
    editingActive: Boolean(activeBlockId) && blockId === activeBlockId,
    parentHighlighted: sourceIndex === highlightedSourceIndex,
  }
}

export function normalizeManualLayoutBlockRect(rect: ManualLayoutRect): ManualLayoutRect {
  const rawLeft = finite(rect.left)
  const rawTop = finite(rect.top)
  const rawWidth = finite(rect.width)
  const rawHeight = finite(rect.height)
  return {
    left: rawWidth < 0 ? rawLeft + rawWidth : rawLeft,
    top: rawHeight < 0 ? rawTop + rawHeight : rawTop,
    width: Math.abs(rawWidth),
    height: Math.abs(rawHeight),
  }
}

export function clampManualLayoutBlockRect(
  rect: ManualLayoutRect,
  bounds: ManualLayoutBounds,
  minimum: ManualLayoutMinimumSize,
): ManualLayoutRect {
  const normalized = normalizeManualLayoutBlockRect(rect)
  const boundsWidth = Math.max(0, finite(bounds.width))
  const boundsHeight = Math.max(0, finite(bounds.height))
  const minimumWidth = Math.min(boundsWidth, Math.max(0, finite(minimum.width)))
  const minimumHeight = Math.min(boundsHeight, Math.max(0, finite(minimum.height)))
  const width = clamp(normalized.width, minimumWidth, boundsWidth)
  const height = clamp(normalized.height, minimumHeight, boundsHeight)
  const minimumLeft = finite(bounds.left)
  const minimumTop = finite(bounds.top)
  return {
    left: clamp(normalized.left, minimumLeft, minimumLeft + boundsWidth - width),
    top: clamp(normalized.top, minimumTop, minimumTop + boundsHeight - height),
    width,
    height,
  }
}

export function moveManualLayoutBlockRect(
  rect: ManualLayoutRect,
  deltaX: number,
  deltaY: number,
  bounds: ManualLayoutBounds,
  minimum: ManualLayoutMinimumSize,
): ManualLayoutRect {
  const clamped = clampManualLayoutBlockRect(rect, bounds, minimum)
  return clampManualLayoutBlockRect({
    ...clamped,
    left: clamped.left + finite(deltaX),
    top: clamped.top + finite(deltaY),
  }, bounds, minimum)
}

export function resizeManualLayoutBlockRect(
  rect: ManualLayoutRect,
  handle: ManualLayoutResizeHandle,
  deltaX: number,
  deltaY: number,
  bounds: ManualLayoutBounds,
  minimum: ManualLayoutMinimumSize,
): ManualLayoutRect {
  const start = clampManualLayoutBlockRect(rect, bounds, minimum)
  const boundsRight = bounds.left + Math.max(0, bounds.width)
  const boundsBottom = bounds.top + Math.max(0, bounds.height)
  const minWidth = Math.min(Math.max(0, minimum.width), Math.max(0, bounds.width))
  const minHeight = Math.min(Math.max(0, minimum.height), Math.max(0, bounds.height))
  let left = start.left
  let top = start.top
  let right = start.left + start.width
  let bottom = start.top + start.height
  const horizontalDelta = finite(deltaX)
  const verticalDelta = finite(deltaY)

  if (handle.includes('w')) left = clamp(left + horizontalDelta, bounds.left, right - minWidth)
  if (handle.includes('e')) right = clamp(right + horizontalDelta, left + minWidth, boundsRight)
  if (handle.includes('n')) top = clamp(top + verticalDelta, bounds.top, bottom - minHeight)
  if (handle.includes('s')) bottom = clamp(bottom + verticalDelta, top + minHeight, boundsBottom)

  return { left, top, width: right - left, height: bottom - top }
}

export function createManualLayoutGeometryPreview<T extends ManualLayoutEditableBlock>(
  blocks: readonly T[],
  blockId: string,
  baseline: readonly T[] = blocks,
): ManualLayoutGeometryPreview<T> {
  return { blockId, baseline, blocks }
}

export function updateManualLayoutGeometryPreview<T extends ManualLayoutEditableBlock>(
  preview: ManualLayoutGeometryPreview<T>,
  location: ManualLayoutRect,
): ManualLayoutGeometryPreview<T> {
  return {
    ...preview,
    blocks: preview.blocks.map((block) => block.manual_block_id === preview.blockId
      ? { ...block, location: { ...location }, __rect: { ...location }, segmentation_source: 'manual' } as T
      : block),
  }
}

export function commitManualLayoutGeometryPreview<T extends ManualLayoutEditableBlock>(
  preview: ManualLayoutGeometryPreview<T>,
): T[] {
  return [...preview.blocks]
}

export function rollbackManualLayoutGeometryPreview<T extends ManualLayoutEditableBlock>(
  preview: ManualLayoutGeometryPreview<T>,
): T[] {
  return [...preview.baseline]
}

type ManualLayoutBlockCategory = 'text' | 'table' | 'image'

const TABLE_STRUCTURE_KEYS = [
  'rows', 'table_rows', 'tableRows',
  'cells', 'table_cells', 'tableCells',
  'merges', 'table_merges', 'tableMerges',
  'rowHeights', 'row_heights', 'rowSizes', 'row_sizes',
  'columnWidths', 'column_widths', 'colSizes', 'col_sizes',
  'html', 'table_html', 'tableHtml',
  'markdown', 'md',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ManualLayoutTableMerge {
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

export interface ManualLayoutTableSnapshot {
  version: 1
  rows: string[][]
  merges: ManualLayoutTableMerge[]
  rowHeights: number[]
  columnWidths: number[]
}

const MANUAL_LAYOUT_TABLE_MAX_ROWS = 2_000
const MANUAL_LAYOUT_TABLE_MAX_COLUMNS = 256
const MANUAL_LAYOUT_TABLE_DEFAULT_ROW_HEIGHT = 40
const MANUAL_LAYOUT_TABLE_DEFAULT_COLUMN_WIDTH = 120

function firstArrayValue(block: ManualLayoutEditableBlock, keys: readonly string[]): unknown[] {
  for (const key of keys) {
    const value = block[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function firstStringValue(block: ManualLayoutEditableBlock, keys: readonly string[]): string {
  for (const key of keys) {
    const value = block[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function cellInteger(cell: Record<string, unknown>, keys: readonly string[], fallback = 0): number {
  for (const key of keys) {
    const value = Number(cell[key])
    if (Number.isFinite(value)) return Math.max(0, Math.floor(value))
  }
  return fallback
}

function cellText(cell: Record<string, unknown>): string {
  for (const key of ['text', 'words', 'content', 'value']) {
    const value = cell[key]
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function rowsFromCells(cells: unknown[]): string[][] {
  const rows: string[][] = []
  for (const rawCell of cells) {
    if (!isRecord(rawCell)) continue
    const row = Math.min(MANUAL_LAYOUT_TABLE_MAX_ROWS - 1, cellInteger(rawCell, ['row', 'row_index', 'rowIndex']))
    const col = Math.min(MANUAL_LAYOUT_TABLE_MAX_COLUMNS - 1, cellInteger(rawCell, ['col', 'col_index', 'colIndex']))
    if (!rows[row]) rows[row] = []
    rows[row][col] = cellText(rawCell)
  }
  return rows
}

function parsePositiveSpan(attributes: string, name: 'rowspan' | 'colspan'): number {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'))
  const maximum = name === 'rowspan' ? MANUAL_LAYOUT_TABLE_MAX_ROWS : MANUAL_LAYOUT_TABLE_MAX_COLUMNS
  return match ? Math.min(maximum, Math.max(1, Math.floor(Number(match[1])))) : 1
}

function tableFromHtml(block: ManualLayoutEditableBlock): { rows: string[][]; merges: ManualLayoutTableMerge[] } {
  const html = firstStringValue(block, ['html', 'table_html', 'tableHtml'])
  if (!html) return { rows: [], merges: [] }
  const rows: string[][] = []
  const merges: ManualLayoutTableMerge[] = []
  const occupied = new Set<string>()
  const rawRows = Array.from(html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)).slice(0, MANUAL_LAYOUT_TABLE_MAX_ROWS)
  rawRows.forEach((rowMatch, row) => {
    const cells = Array.from(rowMatch[1].matchAll(/<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi))
      .slice(0, MANUAL_LAYOUT_TABLE_MAX_COLUMNS)
    if (cells.length === 0) return
    if (!rows[row]) rows[row] = []
    let col = 0
    for (const cellMatch of cells) {
      while (occupied.has(`${row}:${col}`)) col += 1
      if (col >= MANUAL_LAYOUT_TABLE_MAX_COLUMNS) break
      const rowSpan = Math.min(MANUAL_LAYOUT_TABLE_MAX_ROWS - row, parsePositiveSpan(cellMatch[1], 'rowspan'))
      const colSpan = Math.min(MANUAL_LAYOUT_TABLE_MAX_COLUMNS - col, parsePositiveSpan(cellMatch[1], 'colspan'))
      rows[row][col] = cellMatch[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim()
      for (let coveredRow = row; coveredRow < row + rowSpan; coveredRow += 1) {
        for (let coveredCol = col; coveredCol < col + colSpan; coveredCol += 1) {
          if (coveredRow !== row || coveredCol !== col) occupied.add(`${coveredRow}:${coveredCol}`)
        }
      }
      if (rowSpan > 1 || colSpan > 1) merges.push({ row, col, rowSpan, colSpan })
      col += colSpan
    }
  })
  return { rows, merges }
}

function rowsFromMarkup(block: ManualLayoutEditableBlock): string[][] {
  const htmlTable = tableFromHtml(block)
  if (htmlTable.rows.length > 0) return htmlTable.rows
  const markdown = firstStringValue(block, ['markdown', 'md'])
  if (!markdown) return []
  return markdown.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\|.*\|$/.test(line) && !/^\|?\s*:?-{3,}/.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
}

function normalizeTableRows(block: ManualLayoutEditableBlock): string[][] {
  const directRows = firstArrayValue(block, ['rows', 'table_rows', 'tableRows'])
  const rawRows = directRows.length > 0
    ? directRows
    : rowsFromCells(firstArrayValue(block, ['cells', 'table_cells', 'tableCells']))
  const sourceRows = (rawRows.length > 0 ? rawRows : rowsFromMarkup(block)).slice(0, MANUAL_LAYOUT_TABLE_MAX_ROWS)
  const rows = Array.from({ length: sourceRows.length }, (_, rowIndex) => {
    const rawRow = sourceRows[rowIndex]
    const rowValues = Array.isArray(rawRow)
      ? rawRow
      : isRecord(rawRow) && Array.isArray(rawRow.cells)
        ? rawRow.cells
        : []
    return rowValues.slice(0, MANUAL_LAYOUT_TABLE_MAX_COLUMNS).map((value) => (
      isRecord(value)
        ? cellText(value)
        : typeof value === 'string'
          ? value
          : value == null
            ? ''
            : String(value)
    ))
  })
  if (rows.length === 0) return [['']]
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  return rows.map((row) => Array.from({ length: columnCount }, (_, col) => row[col] || ''))
}

function normalizeTableMerges(block: ManualLayoutEditableBlock, rows: string[][]): ManualLayoutTableMerge[] {
  const rowCount = rows.length
  const colCount = rows[0]?.length || 1
  const directMerges = firstArrayValue(block, ['merges', 'table_merges', 'tableMerges'])
  const legacyCells = firstArrayValue(block, ['cells', 'table_cells', 'tableCells'])
  const source = directMerges.length > 0
    ? directMerges
    : legacyCells.length > 0
      ? legacyCells
      : tableFromHtml(block).merges
  const candidates = source.slice(0, MANUAL_LAYOUT_TABLE_MAX_ROWS * MANUAL_LAYOUT_TABLE_MAX_COLUMNS).flatMap((rawMerge) => {
    if (!isRecord(rawMerge)) return []
    const row = cellInteger(rawMerge, ['row', 'row_index', 'rowIndex'])
    const col = cellInteger(rawMerge, ['col', 'col_index', 'colIndex'])
    if (row >= rowCount || col >= colCount) return []
    const rowSpan = Math.max(1, Math.min(rowCount - row, cellInteger(rawMerge, ['rowSpan', 'row_span', 'rowspan'], 1)))
    const colSpan = Math.max(1, Math.min(colCount - col, cellInteger(rawMerge, ['colSpan', 'col_span', 'colspan'], 1)))
    return rowSpan === 1 && colSpan === 1 ? [] : [{ row, col, rowSpan, colSpan }]
  })
  const accepted: ManualLayoutTableMerge[] = []
  const occupied = new Set<string>()
  for (const merge of candidates.sort((left, right) => left.row - right.row || left.col - right.col)) {
    let overlaps = false
    for (let row = merge.row; row < merge.row + merge.rowSpan && !overlaps; row += 1) {
      for (let col = merge.col; col < merge.col + merge.colSpan; col += 1) {
        if (occupied.has(`${row}:${col}`)) {
          overlaps = true
          break
        }
      }
    }
    if (overlaps) continue
    accepted.push(merge)
    for (let row = merge.row; row < merge.row + merge.rowSpan; row += 1) {
      for (let col = merge.col; col < merge.col + merge.colSpan; col += 1) occupied.add(`${row}:${col}`)
    }
  }
  return accepted
}

function normalizeTableSizes(
  block: ManualLayoutEditableBlock,
  keys: readonly string[],
  count: number,
  fallback: number,
): number[] {
  const source = firstArrayValue(block, keys)
  return Array.from({ length: count }, (_, index) => {
    const value = source[index]
    const size = Number(value)
    return Number.isFinite(size) && size > 0 ? size : fallback
  })
}

export function createManualLayoutTableSnapshot(block: ManualLayoutEditableBlock): ManualLayoutTableSnapshot {
  const rows = normalizeTableRows(block)
  return {
    version: 1,
    rows,
    merges: normalizeTableMerges(block, rows),
    rowHeights: normalizeTableSizes(
      block,
      ['rowHeights', 'row_heights', 'rowSizes', 'row_sizes'],
      rows.length,
      MANUAL_LAYOUT_TABLE_DEFAULT_ROW_HEIGHT,
    ),
    columnWidths: normalizeTableSizes(
      block,
      ['columnWidths', 'column_widths', 'colSizes', 'col_sizes'],
      rows[0]?.length || 1,
      MANUAL_LAYOUT_TABLE_DEFAULT_COLUMN_WIDTH,
    ),
  }
}

function kindCategory(kind: ManualLayoutBlockKind): ManualLayoutBlockCategory {
  if (kind === 'table') return 'table'
  if (kind === 'image' || kind === 'seal') return 'image'
  return 'text'
}

function currentBlockKind(block: ManualLayoutEditableBlock): ManualLayoutBlockKind {
  return isManualLayoutBlockKind(block.label) ? block.label : 'text'
}

export function getManualLayoutBlockConversionWarning(
  block: ManualLayoutEditableBlock,
  nextKind: ManualLayoutBlockKind,
): string | null {
  const currentKind = currentBlockKind(block)
  const currentCategory = kindCategory(currentKind)
  const nextCategory = kindCategory(nextKind)
  if (currentCategory === nextCategory) return null
  if (currentCategory === 'table') return '切换类型后会隐藏表格网格；表格结构会独立归档。若此前编辑过正文，将优先恢复最近一次人工正文。'
  if (currentCategory === 'image') return '切换类型后会隐藏图片预览，但图片资源与裁剪信息会保留，可随时切回图片或印章。'
  if (nextCategory === 'table') return '切换为表格会启用网格编辑；当前人工文字会独立归档，切回正文时恢复，不会混入表格内容。'
  return '切换为图片或印章后，原文字会作为说明保留，不会被删除。'
}

export function applyManualLayoutBlockConversion<T extends ManualLayoutEditableBlock>(
  block: T,
  nextKind: ManualLayoutBlockKind,
  confirmed: boolean,
): { blocked: boolean; warning: string | null; block: T } {
  const warning = getManualLayoutBlockConversionWarning(block, nextKind)
  if (warning && !confirmed) return { blocked: true, warning, block }
  const currentCategory = kindCategory(currentBlockKind(block))
  const nextCategory = kindCategory(nextKind)
  const nextBlock: ManualLayoutEditableBlock = {
    ...block,
    label: nextKind,
    type: nextKind,
    block_type: nextKind,
    segmentation_source: 'manual',
  }
  if (currentCategory === 'table' && nextCategory !== 'table') {
    nextBlock.manual_preserved_table = createManualLayoutTableSnapshot(block)
    for (const key of TABLE_STRUCTURE_KEYS) nextBlock[key] = undefined
    if (nextCategory === 'text'
      && isRecord(block.manual_preserved_text)
      && typeof block.manual_preserved_text.text === 'string') {
      nextBlock.words = block.manual_preserved_text.text
    }
  } else if (nextCategory === 'table' && currentCategory !== 'table') {
    for (const key of TABLE_STRUCTURE_KEYS) nextBlock[key] = undefined
    if (isRecord(block.manual_preserved_table)) {
      const snapshot = createManualLayoutTableSnapshot(block.manual_preserved_table)
      nextBlock.rows = snapshot.rows
      nextBlock.merges = snapshot.merges
      nextBlock.rowHeights = snapshot.rowHeights
      nextBlock.columnWidths = snapshot.columnWidths
    }
    nextBlock.manual_preserved_table = undefined
  }
  if (currentCategory === 'text' && nextCategory === 'table') {
    const previousVersion = isRecord(block.manual_preserved_text)
      && typeof block.manual_preserved_text.version === 'number'
      && Number.isFinite(block.manual_preserved_text.version)
      ? Math.max(0, Math.floor(block.manual_preserved_text.version))
      : 0
    nextBlock.manual_preserved_text = {
      text: typeof block.words === 'string' ? block.words : '',
      source: 'manual-type-conversion',
      version: previousVersion + 1,
    }
  }
  return { blocked: false, warning, block: nextBlock as T }
}
