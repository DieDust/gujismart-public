type LayoutBlockRecord = Record<string, unknown>

let manualLayoutBlockSequence = 0

export type ManualLayoutBlockKind =
  | 'text'
  | 'title'
  | 'paragraph_title'
  | 'note'
  | 'abstract'
  | 'reference'
  | 'header'
  | 'footer'
  | 'number'
  | 'table'
  | 'image'
  | 'seal'

export interface ManualLayoutBlockMeta {
  manual_block_id: string
  segmentation_source: 'manual'
  label: ManualLayoutBlockKind
  location: { left: number; top: number; width: number; height: number }
  reading_order: number
  orientation?: 'horizontal' | 'vertical'
  caption?: string
  alt_text?: string
  image_asset_path?: string
  image_asset_width?: number
  image_asset_height?: number
  image_crop?: {
    source_page_id: string
    left: number
    top: number
    width: number
    height: number
  }
}

export interface ManualLayoutSignatureSnapshot {
  id: string
  kind?: ManualLayoutBlockKind
  text: string
  location?: ManualLayoutBlockMeta['location']
  readingOrder: number | null
  rows?: string[][]
  caption?: string
  altText?: string
  imageAssetPath?: string
  imageCrop?: ManualLayoutBlockMeta['image_crop']
}

export interface LayoutBlockSearchSegment {
  blockId?: string
  kind?: ManualLayoutBlockKind
  text: string
  location?: ManualLayoutBlockMeta['location']
  readingOrder: number | null
  source: 'manual' | 'ocr'
}

export const MANUAL_LAYOUT_LOCATION_KEY_PREFIX = 'manual-block:'

export function createManualLayoutLocationKey(
  blockId: string,
  location?: ManualLayoutBlockMeta['location'],
): string {
  const id = String(blockId || '').trim()
  if (!id) return ''
  if (!location) return `${MANUAL_LAYOUT_LOCATION_KEY_PREFIX}${encodeURIComponent(id)}`
  const coordinates = [location.left, location.top, location.width, location.height]
  if (!coordinates.every(Number.isFinite)) return `${MANUAL_LAYOUT_LOCATION_KEY_PREFIX}${encodeURIComponent(id)}`
  return `${MANUAL_LAYOUT_LOCATION_KEY_PREFIX}${encodeURIComponent(id)}:${coordinates.join(',')}`
}

export function parseManualLayoutLocationKey(value: unknown): {
  blockId: string
  location?: ManualLayoutBlockMeta['location']
} | null {
  const source = String(value || '').trim()
  if (!source.startsWith(MANUAL_LAYOUT_LOCATION_KEY_PREFIX)) return null
  const body = source.slice(MANUAL_LAYOUT_LOCATION_KEY_PREFIX.length)
  const separator = body.indexOf(':')
  const encodedId = separator >= 0 ? body.slice(0, separator) : body
  let blockId = ''
  try {
    blockId = decodeURIComponent(encodedId).trim()
  } catch {
    return null
  }
  if (!blockId) return null
  if (separator < 0) return { blockId }
  const coordinates = body.slice(separator + 1).split(',').map(Number)
  if (coordinates.length !== 4 || !coordinates.every(Number.isFinite)) return { blockId }
  const [left, top, width, height] = coordinates
  if (width <= 0 || height <= 0) return { blockId }
  return { blockId, location: { left, top, width, height } }
}

export interface ManualLayoutStructuredBlock extends LayoutBlockRecord {
  manual_block_id: string
  segmentation_source: 'manual'
  label: ManualLayoutBlockKind
  location?: ManualLayoutBlockMeta['location']
  reading_order?: number
  orientation?: 'horizontal' | 'vertical'
  words?: string
  rows?: string[][]
  cells?: unknown[]
  merges?: unknown[]
  rowHeights?: number[]
  columnWidths?: number[]
  caption?: string
  alt_text?: string
  image_asset_path?: string
  image_asset_width?: number
  image_asset_height?: number
  image_asset_reference?: {
    path: string
    width?: number
    height?: number
  }
  image_crop?: ManualLayoutBlockMeta['image_crop']
}

export type ManualLayoutBlockIdentity = LayoutBlockRecord & {
  manual_block_id: string
}

const MANUAL_LAYOUT_BLOCK_KINDS = new Set<ManualLayoutBlockKind>([
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
])

function safeManualLayoutPageId(pageId: string): string {
  return String(pageId || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 36) || 'page'
}

export function createManualLayoutBlockId(pageId: string): string {
  manualLayoutBlockSequence += 1
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${manualLayoutBlockSequence.toString(36)}`
  return `manual-${safeManualLayoutPageId(pageId)}-${randomId}`
}

export function isStableManualLayoutBlockId(pageId: string, blockId: string): boolean {
  const normalized = String(blockId || '').trim()
  const prefix = `manual-${safeManualLayoutPageId(pageId)}-`
  if (!normalized.startsWith(prefix) || normalized.length > 180 || /[\\/\0]/.test(normalized)) return false
  const suffix = normalized.slice(prefix.length)
  return /^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(suffix)
}

const LEGACY_TEXT_FIELDS = [
  'words',
  'word',
  'text',
  'block_content',
  'content',
  'transcription',
  'raw_words',
  'raw_text',
] as const

function isRecord(value: unknown): value is LayoutBlockRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/\r\n?/g, '\n').trim()
}

function firstText(record: LayoutBlockRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const text = normalizeText(record[key])
    if (text) return text
  }
  return ''
}

function normalizedBlockLabel(record: LayoutBlockRecord): string {
  return firstText(record, ['label', 'block_label', 'type', 'block_type', 'category'])
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function blockCategory(record: LayoutBlockRecord): 'table' | 'image' | 'seal' | 'other' {
  const label = normalizedBlockLabel(record)
  if (/table|表格/.test(label)) return 'table'
  if (/^(?:image|figure|picture)(?: block)?$|图片|插图|图像/.test(label)) return 'image'
  if (/seal|stamp|印章|藏书印/.test(label)) return 'seal'
  return 'other'
}

function normalizeLosslessTableCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\r\n?/g, '\n')
}

export function getLosslessLayoutTableRows(value: unknown): string[][] | undefined {
  if (!isRecord(value)) return undefined
  const record = value
  const candidate = record.rows ?? record.table_rows ?? record.tableRows
  if (!Array.isArray(candidate)) return undefined
  return candidate
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map(normalizeLosslessTableCell))
}

function projectedTableText(record: LayoutBlockRecord): string {
  const rows = getLosslessLayoutTableRows(record)
  if (rows !== undefined) {
    const projected = rows.map((row) => row.join('\t')).join('\n')
    if (isManualLayoutBlock(record) || rows.some((row) => row.some((cell) => cell.trim()))) {
      return projected
    }
  }
  return firstText(record, LEGACY_TEXT_FIELDS)
}

function projectedImageText(record: LayoutBlockRecord): string {
  const values = [firstText(record, ['caption']), firstText(record, ['alt_text', 'altText'])]
  return values.filter((value, index) => value && values.indexOf(value) === index).join('\n')
}

function readingOrder(record: LayoutBlockRecord): number | null {
  const value = record.reading_order
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const order = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(order) ? order : null
}

function signatureLocation(value: unknown): ManualLayoutBlockMeta['location'] | undefined {
  if (!isRecord(value)) return undefined
  const { left, top, width, height } = value
  if (![left, top, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return undefined
  }
  return {
    left: left as number,
    top: top as number,
    width: width as number,
    height: height as number,
  }
}

function signatureImageCrop(value: unknown): ManualLayoutBlockMeta['image_crop'] | undefined {
  if (!isRecord(value) || typeof value.source_page_id !== 'string') return undefined
  const location = signatureLocation(value)
  if (!location) return undefined
  return { source_page_id: value.source_page_id, ...location }
}

function finiteNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.map(Number)
  return values.every((item) => Number.isFinite(item) && item > 0) ? values : undefined
}

function cloneUnknownArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => isRecord(item) ? { ...item } : item)
}

function sortedLayoutBlocks(blocks: readonly unknown[]): Array<{ block: LayoutBlockRecord; index: number; order: number | null }> {
  return blocks
    .map((block, index) => ({ block: isRecord(block) ? block : {}, index, order: isRecord(block) ? readingOrder(block) : null }))
    .sort((left, right) => {
      if (left.order !== null || right.order !== null) {
        const orderDelta = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
        if (orderDelta !== 0) return orderDelta
      }
      return left.index - right.index
    })
}

export function getManualBlockId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.manual_block_id !== 'string') return undefined
  const blockId = value.manual_block_id.trim()
  return blockId || undefined
}

export function isManualLayoutBlock(value: unknown): value is ManualLayoutBlockIdentity {
  return getManualBlockId(value) !== undefined
}

export function getManualLayoutBlockKind(value: unknown): ManualLayoutBlockKind | undefined {
  if (!isRecord(value)) return undefined
  const label = normalizeText(value.label).toLowerCase() as ManualLayoutBlockKind
  return MANUAL_LAYOUT_BLOCK_KINDS.has(label) ? label : undefined
}

export function getManualLayoutSignatureSnapshot(
  value: unknown,
): ManualLayoutSignatureSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const id = getManualBlockId(value)
  if (!id) return undefined
  return {
    id,
    kind: getManualLayoutBlockKind(value),
    text: getLayoutBlockSearchText(value),
    location: signatureLocation(value.location),
    readingOrder: readingOrder(value),
    rows: getLosslessLayoutTableRows(value),
    caption: firstText(value, ['caption']) || undefined,
    altText: firstText(value, ['alt_text', 'altText']) || undefined,
    imageAssetPath: firstText(value, ['image_asset_path']) || undefined,
    imageCrop: signatureImageCrop(value.image_crop),
  }
}

export function getLayoutBlockSearchText(value: unknown): string {
  if (!isRecord(value)) return ''
  const category = blockCategory(value)
  if (category === 'table') return projectedTableText(value)
  if (category === 'image' || category === 'seal') return projectedImageText(value)
  return firstText(value, LEGACY_TEXT_FIELDS)
}

export function getLayoutBlockSearchSegments(
  blocks: readonly unknown[] | null | undefined,
): LayoutBlockSearchSegment[] {
  if (!Array.isArray(blocks)) return []
  return sortedLayoutBlocks(blocks)
    .map(({ block, order }): LayoutBlockSearchSegment | null => {
      const text = getLayoutBlockSearchText(block)
      if (!/\S/.test(text)) return null
      const blockId = getManualBlockId(block)
      return {
        ...(blockId ? { blockId } : {}),
        kind: getManualLayoutBlockKind(block),
        text,
        location: signatureLocation(block.location),
        readingOrder: order,
        source: blockId ? 'manual' : 'ocr',
      }
    })
    .filter((segment): segment is LayoutBlockSearchSegment => segment !== null)
}

export function getManualLayoutSearchSegments(
  blocks: readonly unknown[] | null | undefined,
): Array<LayoutBlockSearchSegment & { blockId: string; source: 'manual' }> {
  return getLayoutBlockSearchSegments(blocks).filter(
    (segment): segment is LayoutBlockSearchSegment & { blockId: string; source: 'manual' } => (
      segment.source === 'manual' && typeof segment.blockId === 'string'
    ),
  )
}

export function hasManualLayoutBlocks(blocks: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(blocks) && blocks.some((block) => isManualLayoutBlock(block))
}

export function getManualLayoutStructuredBlocks(
  blocks: readonly unknown[] | null | undefined,
): ManualLayoutStructuredBlock[] {
  if (!Array.isArray(blocks)) return []
  return sortedLayoutBlocks(blocks).flatMap(({ block, order }) => {
    const manualBlockId = getManualBlockId(block)
    const kind = getManualLayoutBlockKind(block)
    if (!manualBlockId || !kind) return []
    const location = signatureLocation(block.location)
    const rows = getLosslessLayoutTableRows(block)
    const imageAssetPath = firstText(block, ['image_asset_path']) || undefined
    const imageAssetWidth = Number(block.image_asset_width)
    const imageAssetHeight = Number(block.image_asset_height)
    const structured: ManualLayoutStructuredBlock = {
      manual_block_id: manualBlockId,
      segmentation_source: 'manual',
      label: kind,
      ...(location ? { location } : {}),
      ...(order !== null ? { reading_order: order } : {}),
      ...(block.orientation === 'horizontal' || block.orientation === 'vertical'
        ? { orientation: block.orientation }
        : {}),
    }
    const text = normalizeText(block.words)
    if (text && kind !== 'image' && kind !== 'seal') structured.words = text
    if (rows !== undefined) {
      structured.rows = rows
      const cells = cloneUnknownArray(block.cells ?? block.table_cells ?? block.tableCells)
      structured.cells = cells || rows.flatMap((row, rowIndex) => row.map((cell, columnIndex) => ({
        row: rowIndex,
        column: columnIndex,
        rowSpan: 1,
        columnSpan: 1,
        text: cell,
      })))
    }
    const merges = cloneUnknownArray(block.merges)
    if (merges) structured.merges = merges
    const rowHeights = finiteNumberArray(block.rowHeights ?? block.row_heights)
    if (rowHeights) structured.rowHeights = rowHeights
    const columnWidths = finiteNumberArray(block.columnWidths ?? block.column_widths)
    if (columnWidths) structured.columnWidths = columnWidths
    const caption = firstText(block, ['caption']) || undefined
    if (caption) structured.caption = caption
    const altText = firstText(block, ['alt_text', 'altText']) || undefined
    if (altText) structured.alt_text = altText
    if (imageAssetPath) {
      structured.image_asset_path = imageAssetPath
      if (Number.isFinite(imageAssetWidth) && imageAssetWidth > 0) structured.image_asset_width = imageAssetWidth
      if (Number.isFinite(imageAssetHeight) && imageAssetHeight > 0) structured.image_asset_height = imageAssetHeight
      structured.image_asset_reference = {
        path: imageAssetPath,
        ...(Number.isFinite(imageAssetWidth) && imageAssetWidth > 0 ? { width: imageAssetWidth } : {}),
        ...(Number.isFinite(imageAssetHeight) && imageAssetHeight > 0 ? { height: imageAssetHeight } : {}),
      }
    }
    const imageCrop = signatureImageCrop(block.image_crop)
    if (imageCrop) structured.image_crop = imageCrop
    return [structured]
  })
}

export function projectLayoutBlocksToPageText(
  blocks: readonly unknown[] | null | undefined,
): string {
  if (!Array.isArray(blocks)) return ''
  return getLayoutBlockSearchSegments(blocks)
    .map((segment) => segment.text)
    .join('\n')
}
