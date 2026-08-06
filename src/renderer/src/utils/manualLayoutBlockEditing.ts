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
  'html', 'table_html', 'tableHtml',
  'markdown', 'md',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotTableStructure(block: ManualLayoutEditableBlock): Record<string, unknown> {
  return Object.fromEntries(TABLE_STRUCTURE_KEYS
    .filter((key) => block[key] !== undefined)
    .map((key) => [key, block[key]]))
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
  if (currentCategory === 'table') return '切换类型后会隐藏表格网格，但表格结构会保留，可随时切回表格。'
  if (currentCategory === 'image') return '切换类型后会隐藏图片预览，但图片资源与裁剪信息会保留，可随时切回图片或印章。'
  if (nextCategory === 'table') return '切换为表格会启用网格编辑；原文字会保留。'
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
    nextBlock.manual_preserved_table = snapshotTableStructure(block)
    for (const key of TABLE_STRUCTURE_KEYS) nextBlock[key] = undefined
  } else if (nextCategory === 'table' && currentCategory !== 'table' && isRecord(block.manual_preserved_table)) {
    Object.assign(nextBlock, block.manual_preserved_table)
  }
  return { blocked: false, warning, block: nextBlock as T }
}
