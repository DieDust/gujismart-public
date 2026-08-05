type LayoutBlockRecord = Record<string, unknown>

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

export function projectLayoutBlocksToPageText(
  blocks: readonly unknown[] | null | undefined,
): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block, index) => ({ block, index, order: isRecord(block) ? readingOrder(block) : null }))
    .sort((left, right) => {
      if (left.order !== null || right.order !== null) {
        const orderDelta = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
        if (orderDelta !== 0) return orderDelta
      }
      return left.index - right.index
    })
    .map(({ block }) => getLayoutBlockSearchText(block))
    .filter((text) => /\S/.test(text))
    .join('\n')
}
