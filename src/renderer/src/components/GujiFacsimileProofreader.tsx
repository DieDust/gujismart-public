import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent } from 'react'
import { Button, Dropdown, Empty, InputNumber, Modal, Popover, Segmented, Slider, Space, Switch, Tag, message } from 'antd'
import type { MenuProps } from 'antd'
import {
  CheckOutlined,
  ColumnWidthOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FormOutlined,
  MinusOutlined,
  PlusOutlined,
  RotateRightOutlined,
  ReloadOutlined,
  SettingOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { getErrorMessage } from '@shared/errors'
import { buildDirectQuoteCitationText, resolveDocumentCitation } from '../utils/citations'
import OpenCC from 'opencc-js'
import { getOrderedOcrBlocks, isTableBlock } from '../utils/ocrText'
import ManualBlockInspector from './ManualBlockInspector'
import ManualLayoutToolbar from './ManualLayoutToolbar'
import {
  normalizeFacsimileTableColumnWidths,
  normalizeFacsimileTableRowHeights,
  type FacsimileTableMerge,
} from '../utils/facsimileTableEditing'
import { renderOcrInlineText } from '../utils/ocrInlineRender'
import {
  ensureManualLayoutBlockIdentity,
  getPendingManualLayoutPageAction,
  getManualLayoutDraftBlockId,
  useManualLayoutDraft,
} from '../hooks/useManualLayoutDraft'
import { getManualLayoutUnderlayImageStyle } from '../utils/manualLayoutUnderlay'
import {
  applyManualLayoutBlockConversion,
  applyManualLayoutTableEditorValue,
  clampManualLayoutBlockRect,
  commitManualLayoutGeometryPreview,
  createManualLayoutGeometryPreview,
  createManualLayoutPointerFrameScheduler,
  createManualLayoutTableProjection,
  createManualLayoutTableSnapshot,
  getManualLayoutBlockConversionWarning,
  getManualLayoutBlockVisualState,
  getManualLayoutEditEntryPreparation,
  moveManualLayoutBlockRect,
  normalizeManualLayoutBlockRect,
  reduceManualLayoutTool,
  resizeManualLayoutBlockRect,
  rollbackManualLayoutGeometryPreview,
  updateManualLayoutGeometryPreview,
  type ManualLayoutGeometryPreview,
  type ManualLayoutPointerFrameScheduler,
  type ManualLayoutResizeHandle,
  type ManualLayoutTableProjection,
  type ManualLayoutTool,
} from '../utils/manualLayoutBlockEditing'
import {
  getOcrBlockRect,
  getOcrCoordinateExtent,
  getOcrLayoutBounds,
  scaleOcrRectToWidth,
} from '../utils/ocrCoordinates'
import {
  buildParallelTranslationSegments,
  isParallelTranslationDisplayReady,
  normalizeParallelSegmentForMatch,
} from '@shared/parallel-translation'
import {
  getCanonicalPageTranslationSourceText,
  getCanonicalTranslationBlockText,
} from '@shared/translation-source'
import type { Document, DocumentPage, OcrRecognizeLayoutBlock, OcrRecognizeResult, PageUpdatePayload, TranslationMode, TranslationUnitV1 } from '@shared/types'
import type { ManualLayoutBlockKind } from '@shared/manual-layout'
import './ManualLayoutEditor.css'

type ProofDisplayScript = 'original' | 'simplified' | 'traditional'
type BlockRect = { left: number; top: number; width: number; height: number }
type LayoutPointerInteraction =
  | { kind: 'create'; pointerId: number; captureTarget: HTMLElement; tool: ManualLayoutTool; start: { x: number; y: number }; current: { x: number; y: number } }
  | {
      kind: 'move' | 'resize'
      pointerId: number
      captureTarget: HTMLElement
      blockId: string
      baselineBlockId: string
      sourceIndex: number
      handle?: ManualLayoutResizeHandle
      start: { x: number; y: number }
      startRect: BlockRect
      preview: ManualLayoutGeometryPreview<LayoutBlock>
      changed: boolean
    }

type LayoutPointerFrame = {
  pointerId: number
  clientX: number
  clientY: number
}

function releaseCapturedLayoutPointer(interaction: LayoutPointerInteraction | null): void {
  if (!interaction) return
  if (interaction.captureTarget.hasPointerCapture(interaction.pointerId)) {
    interaction.captureTarget.releasePointerCapture(interaction.pointerId)
  }
}
type JsonRecord = Record<string, unknown>
type FacsimileOcrResult = OcrRecognizeResult & JsonRecord
type LayoutBlock = OcrRecognizeLayoutBlock & JsonRecord & {
  words?: string
  displayWords?: string
  label?: string
  block_label?: string
  type?: string
  block_type?: string
  category?: string
  class?: string
  layout_label?: string
  orientation?: 'vertical' | 'horizontal' | string
  orientation_source?: string
  source_orientation?: string
  source_orientation_source?: string
  segmentation_source?: string
  reading_order?: number
  column_index?: number
  line_index?: number
  image_asset_path?: string
  asset_path?: string
  image_path?: string
  __rect?: BlockRect
  __synthetic?: boolean
  __sourceIndex?: number
  __manualDraftId?: string
  manual_block_id?: string
  ir_block_id?: string
}
type MarkdownImageBlock = {
  location: BlockRect
  src: string
  alt: string
}
type FacsimileLayoutProfile = 'paddle' | 'vision'

type TranslationBlockCoverage = {
  blockIndex: number
  startOffset: number
  endOffset: number
}

type TranslationCoverageCursor = {
  blockIndex: number
  offset: number
}

type FacsimileTranslationOverlay = {
  id: string
  sourceIndexes: number[]
  text: string
  rect: BlockRect
  label: string
  orientation: 'vertical' | 'horizontal'
}

type FacsimileBlockRenderLayout = {
  block: LayoutBlock
  blockId: string
  sourceIndex: number
  rect: BlockRect
  cropBounds: { width: number; height: number; offsetLeft: number; offsetTop: number }
  left: number
  top: number
  width: number
  height: number
  label: string
  labelColor: string
  labelName: string
  isImage: boolean
  tableRows: string[][]
  tableMerges: FacsimileTableMerge[]
  orientation: 'vertical' | 'horizontal'
  originalText: string
  shouldRenderTable: boolean
  displayText: string
  fittedLayout: FittedTextLayout
  fontSize: number
  fittedDisplayText: string
  searchableText: string
  normalizedSearchableText: string
  padding: number
}

type FacsimileTranslationRenderLayout = {
  overlay: FacsimileTranslationOverlay
  left: number
  top: number
  width: number
  height: number
  labelColor: string
  displayText: string
  fittedLayout: FittedTextLayout
  normalizedSearchableText: string
  sourceIndex: number
  padding: number
  lineHeight: number
}

interface GujiFacsimileProofreaderProps {
  draftIdentity: string
  pageId: string
  ocrResult: unknown
  pageImageSrc?: string
  pageProofStatus?: 'completed' | 'pending'
  activeBoxIndex?: number
  activeSearchHitOrdinal?: number
  searchKeyword?: string
  coordinateSourceSize?: { width?: number | null; height?: number | null; preserveServiceCoordinates?: boolean }
  preferVerticalLayout?: boolean
  translationText?: string
  translationUnits?: TranslationUnitV1[]
  translationLoading?: boolean
  translationSkipped?: boolean
  translationOpen?: boolean
  translationMode?: TranslationMode
  /** Citation context for "复制直接引用" (same contract as reading mode). */
  documentId?: string
  documentTitle?: string
  documentType?: string | null
  pageNum?: number | null
  literaturePageNum?: number | null
  onTranslationOpenChange?: (open: boolean) => void
  onTranslationModeChange?: (mode: TranslationMode) => void
  onTranslateCurrentPage?: (text: string) => void
  onRetranslateCurrentPage?: (text: string) => void
  onSelectBox?: (index: number) => void
  onSave: (pageId: string, data: PageUpdatePayload) => void | Promise<void>
  onTextSelectionChange?: (text: string) => void
}

type FacsimileTextSelection = {
  text: string
  x: number
  y: number
}

function isUsableTranslationUnit(unit: TranslationUnitV1): boolean {
  return unit.skipped || (unit.status === 'ready' && !unit.stale && Boolean(String(unit.translationText || '').trim()))
}

const FONT_FAMILY = "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif"
const FACSIMILE_BASE_PAGE_WIDTH = 760
const FACSIMILE_MIN_ZOOM = 0.45
const FACSIMILE_MAX_ZOOM = 2.4
const FACSIMILE_FONT_SCALE_STORAGE_KEY = 'gujismart.facsimileProof.fontScale'
const FACSIMILE_FONT_SCALE_STORAGE_VERSION_KEY = 'gujismart.facsimileProof.fontScaleVersion'
const FACSIMILE_SHOW_RULES_STORAGE_KEY = 'gujismart.facsimileProof.showRules'
const FACSIMILE_IMAGE_UNDERLAY_MODE_STORAGE_KEY = 'gujismart.facsimileProof.imageUnderlayMode'
const FACSIMILE_IMAGE_UNDERLAY_BLUR_STORAGE_KEY = 'gujismart.facsimileProof.imageUnderlayBlur'
const FACSIMILE_FONT_SCALE_DEFAULT = 1.1
const FACSIMILE_FONT_SCALE_STORAGE_VERSION = '5'
const FACSIMILE_FONT_SCALE_MIN = 0.1
const FACSIMILE_FONT_SCALE_MAX = 5
const FACSIMILE_FONT_SCALE_STEP = 0.02
const FACSIMILE_TEXT_FIT_ITERATIONS = 7
const FACSIMILE_SPLIT_COLUMN_SOURCE_INDEX_BASE = 1_000_000
type ImageUnderlayMode = 'auto' | 'on' | 'off'

const LABEL_COLORS: Record<string, string> = {
  doc_title: '#7b3f00',
  paragraph_title: '#8c5a18',
  title: '#7b3f00',
  text: '#4a3728',
  note: '#6f5a46',
  abstract: '#6f5a46',
  reference: '#6f5a46',
  table: '#5a4634',
  image: '#3b6d8c',
  header: '#8a7662',
  footer: '#8a7662',
  number: '#8a7662',
  seal: '#b42318',
}

const LABEL_NAMES: Record<string, string> = {
  doc_title: '题名',
  paragraph_title: '篇题',
  title: '标题',
  text: '正文',
  note: '夹注',
  abstract: '摘要',
  reference: '参考',
  table: '表格',
  image: '图片',
  header: '页眉',
  footer: '页脚',
  number: '页码',
  seal: '印章',
}

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeFontScale(value: number): number {
  if (!Number.isFinite(value)) return FACSIMILE_FONT_SCALE_DEFAULT
  return Math.round(clamp(value, FACSIMILE_FONT_SCALE_MIN, FACSIMILE_FONT_SCALE_MAX) * 100) / 100
}

function loadPersistedFontScale(): number {
  try {
    const stored = window.localStorage.getItem(FACSIMILE_FONT_SCALE_STORAGE_KEY)
    if (!stored) return FACSIMILE_FONT_SCALE_DEFAULT
    const storedScale = normalizeFontScale(Number(stored))
    const storedVersion = window.localStorage.getItem(FACSIMILE_FONT_SCALE_STORAGE_VERSION_KEY)
    if (!storedVersion && Math.abs(storedScale - 1) < 0.01) return FACSIMILE_FONT_SCALE_DEFAULT
    if (storedVersion !== FACSIMILE_FONT_SCALE_STORAGE_VERSION && storedScale < 0.85) return FACSIMILE_FONT_SCALE_DEFAULT
    return storedScale
  } catch {
    return FACSIMILE_FONT_SCALE_DEFAULT
  }
}

function loadPersistedShowRules(): boolean {
  try {
    const stored = window.localStorage.getItem(FACSIMILE_SHOW_RULES_STORAGE_KEY)
    return stored == null ? true : stored !== 'false'
  } catch {
    return true
  }
}

function loadPersistedImageUnderlayMode(): ImageUnderlayMode {
  try {
    const stored = window.localStorage.getItem(FACSIMILE_IMAGE_UNDERLAY_MODE_STORAGE_KEY)
    return stored === 'on' || stored === 'off' || stored === 'auto' ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

function normalizeImageUnderlayBlur(value: number): number {
  if (!Number.isFinite(value)) return 65
  return Math.round(clamp(value, 0, 100))
}

function loadPersistedImageUnderlayBlur(): number {
  try {
    const stored = window.localStorage.getItem(FACSIMILE_IMAGE_UNDERLAY_BLUR_STORAGE_KEY)
    return stored == null ? 65 : normalizeImageUnderlayBlur(Number(stored))
  } catch {
    return 65
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecordValue(source: unknown, key: string): unknown {
  return isJsonRecord(source) ? source[key] : undefined
}

function firstRecordValue(source: unknown, keys: string[]): unknown {
  for (const key of keys) {
    const value = readRecordValue(source, key)
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function primitiveText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function getOrientationValue(block: unknown): 'vertical' | 'horizontal' | null {
  const orientation = readRecordValue(block, 'orientation')
  return orientation === 'vertical' || orientation === 'horizontal' ? orientation : null
}

function normalizeOrientationSource(value: unknown): string {
  return primitiveText(value).trim().toLowerCase().replace(/[_-]+/g, ' ')
}

function isManualOrientationSource(value: unknown): boolean {
  const normalized = normalizeOrientationSource(value)
  return normalized === 'manual' || normalized === 'manual override' || normalized === 'user' || normalized === 'user override'
}

function getManualOrientation(block: unknown): 'vertical' | 'horizontal' | null {
  const orientation = getOrientationValue(block)
  if (!orientation) return null
  const source = firstRecordValue(block, ['orientation_source', 'orientationSource'])
  return isManualOrientationSource(source) ? orientation : null
}

function asOcrResult(value: unknown): FacsimileOcrResult {
  const parsed = parseMaybeJson(value, {})
  return isJsonRecord(parsed) ? parsed as FacsimileOcrResult : {}
}

function parseMaybeJson(value: unknown, fallback: unknown = null): unknown {
  if (!value) return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function pointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number | null {
  if (isJsonRecord(point)) return Number(point[key])
  if (Array.isArray(point)) return Number(point[tupleIndex])
  return null
}

function getRect(block: unknown): BlockRect | null {
  const rect = getOcrBlockRect(block)
  return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null
}

function getBlockText(block: unknown): string {
  return getCanonicalTranslationBlockText(block)
}

function getLabel(block: unknown): string {
  return String(firstRecordValue(block, ['label', 'block_label', 'type']) || 'text').toLowerCase()
}

function getOrientationLabelText(block: unknown): string {
  return [
    readRecordValue(block, 'label'),
    readRecordValue(block, 'block_label'),
    readRecordValue(block, 'type'),
    readRecordValue(block, 'block_type'),
    readRecordValue(block, 'category'),
    readRecordValue(block, 'class'),
    readRecordValue(block, 'layout_label'),
  ].map((value) => String(value || '').toLowerCase()).filter(Boolean).join(' ')
}

function isTitleLabel(label: string): boolean {
  return /title|heading|题名|标题|篇题/.test(label)
}

function isNoteLabel(label: string): boolean {
  return /note|annotation|footnote|夹注|注释|注解/.test(label)
}

function isDecorativeLabel(label: string): boolean {
  return /header|footer|number|page|seal|stamp|页眉|頁眉|页脚|頁腳|页码|頁碼|印章/.test(label)
}

function isTocLabel(label: string): boolean {
  return /^(?:toc|content|contents|catalog|table_of_contents)$/.test(label) || /目录|目錄/.test(label)
}

function isExplicitVerticalLabel(label: string): boolean {
  return /vertical[_\s-]*text|col[_\s-]*text|column[_\s-]*text|vertical|竖排|縦書き|縦組み/i.test(label)
}

function isExplicitHorizontalLabel(label: string): boolean {
  return /horizontal[_\s-]*text|row[_\s-]*text|horizontal|横排|橫排|横書き|横組み/i.test(label)
}

function getExplicitOcrOrientation(block: unknown): 'vertical' | 'horizontal' | null {
  const orientation = readRecordValue(block, 'orientation')
  if (orientation === 'vertical' || orientation === 'horizontal') return orientation
  const label = getOrientationLabelText(block)
  if (isExplicitVerticalLabel(label)) return 'vertical'
  if (isExplicitHorizontalLabel(label)) return 'horizontal'
  return null
}

function isBodyTextLabel(label: string): boolean {
  return /^(?:text|paragraph|body)$/.test(label) || /正文/.test(label)
}

function isOrdinaryVerticalPageTextBlock(
  block: unknown,
  tableProjection?: ManualLayoutTableProjection | null,
): boolean {
  const resolvedTableProjection = tableProjection
    || (isTableBlock(block) ? createManualLayoutTableProjection(block, getBlockText(block)) : null)
  const label = getLabel(block)
  if (isLikelyVerticalPseudoTableBlock(block, resolvedTableProjection)) return true
  if (!isBodyTextLabel(label)) return false
  if (isTocLabel(label) || isDecorativeLabel(label) || isImageLabel(label) || isRenderableTableBlock(block, resolvedTableProjection)) return false
  const text = getBlockText(block)
  const rect = getRect(block)
  if (!rect || !text.trim()) return false
  const compactLength = Array.from(text.replace(/\s+/g, '')).length
  if (compactLength < 12) return false
  const wideShortLine = rect.width >= rect.height * 2.1 && rect.height <= 82
  if (wideShortLine && compactLength < 72) return false
  return getVerticalScriptRatio(text) >= 0.35
}

function hasVerticalColumnTextShape(
  block: unknown,
  tableProjection?: ManualLayoutTableProjection | null,
): boolean {
  const resolvedTableProjection = tableProjection
    || (isTableBlock(block) ? createManualLayoutTableProjection(block, getBlockText(block)) : null)
  const label = getLabel(block)
  if (isLikelyVerticalPseudoTableBlock(block, resolvedTableProjection)) return true
  if (!isBodyTextLabel(label) && !isNoteLabel(label) && !isTitleLabel(label)) return false
  if (isTocLabel(label) || isDecorativeLabel(label) || isImageLabel(label) || isRenderableTableBlock(block, resolvedTableProjection)) return false
  const rect = getRect(block)
  const text = getBlockText(block)
  if (!rect || !text.trim() || getVerticalScriptRatio(text) < 0.42) return false
  const compactLength = Array.from(text.replace(/\s+/g, '')).length
  if (isTallVerticalTextBlock(block)) return true
  const columns = getVerticalColumns(text)
  if (columns.length >= 2 && columns.filter((column) => column.length >= 2).length >= 2) return true
  if (rect.height < 90 || compactLength < 42) return false
  if (rect.width >= 120 && rect.height >= 90 && compactLength >= 60) return true
  return rect.height >= rect.width * 0.72 && compactLength >= 36
}

function isNaturallyHorizontalLabel(label: string): boolean {
  const normalized = String(label || '').toLowerCase().replace(/[_-]+/g, ' ')
  return /\b(?:doc title|document title|paragraph title|title|heading|section title|abstract|reference|references|caption|figure caption|table caption|header|footer|number|page number|keyword|keywords|author|journal|date)\b/.test(normalized)
}

function isImageLabel(label: string): boolean {
  return /^(?:image|figure|picture|chart|diagram|photo|illustration|seal|stamp)$/i.test(label)
    || /图片|图像|插图|示意图|图表|照片|印章|藏书印/.test(label)
}

function isRenderableTableBlock(
  block: unknown,
  tableProjection?: ManualLayoutTableProjection | null,
): boolean {
  if (!isTableBlock(block)) return false
  const resolvedTableProjection = tableProjection || createManualLayoutTableProjection(block, getBlockText(block))
  return resolvedTableProjection.snapshot.rows.length > 0
}

function tableRowsToPlainText(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => String(cell || '').trim()).filter(Boolean).join('')).filter(Boolean).join('\n')
}

function getPseudoTableText(
  block: unknown,
  tableProjection?: ManualLayoutTableProjection | null,
): string {
  if (!isTableBlock(block)) return getBlockText(block)
  const resolvedTableProjection = tableProjection || createManualLayoutTableProjection(block, getBlockText(block))
  return resolvedTableProjection.verticalText || getBlockText(block)
}

function isLikelyVerticalPseudoTableBlock(
  block: unknown,
  tableProjection?: ManualLayoutTableProjection | null,
): boolean {
  if (!isTableBlock(block)) return false
  const resolvedTableProjection = tableProjection || createManualLayoutTableProjection(block, getBlockText(block))
  if (!isRenderableTableBlock(block, resolvedTableProjection)) return false
  const rows = resolvedTableProjection.snapshot.rows
  const rect = getRect(block)
  const text = getPseudoTableText(block, resolvedTableProjection)
  const compactCells = rows.flat().map((cell) => String(cell || '').replace(/\s+/g, '')).filter(Boolean)
  const compactText = compactCells.join('')
  if (!rect || compactCells.length < 4 || compactText.length < 16) return false
  if (getVerticalScriptRatio(compactText) < 0.58) return false

  const rowCount = rows.length
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const maxCellLength = Math.max(0, ...compactCells.map((cell) => cell.length))
  const shortCellRatio = compactCells.filter((cell) => cell.length <= 8).length / Math.max(1, compactCells.length)
  const numericCellCount = compactCells.filter((cell) => /(?:\d|[０-９]|[一二三四五六七八九十百千万]+(?:年|月|日|時|时|分|円|元|割|％|%))/.test(cell)).length
  if (numericCellCount >= Math.max(3, Math.ceil(compactCells.length * 0.25))) return false
  const expandedVerticalLineShape = rect.height >= rect.width * 0.42 || columnCount >= 4
  const denseVerticalTextGrid = compactCells.length >= 12
    && shortCellRatio >= 0.68
    && maxCellLength <= 18
    && (rowCount >= 5 || columnCount >= 4)
  const expandedSparseVocabularyGrid = rowCount <= 4
    && columnCount >= 4
    && compactCells.length >= 6
    && shortCellRatio >= 0.72
    && maxCellLength <= 14
  if (expandedVerticalLineShape && (denseVerticalTextGrid || expandedSparseVocabularyGrid)) return true
  const longCellCount = compactCells.filter((cell) => cell.length >= 18).length
  const punctuationCount = Array.from(compactText).filter((char) => /[，。；：！？、“”‘’（）《》,.!?;:]/.test(char)).length
  const hasNarrativeCells = longCellCount >= 2 || maxCellLength >= 42 || punctuationCount >= 8
  if (hasNarrativeCells) return false

  const verticalLineShape = rect.height >= rect.width * 0.55 || columnCount >= 4
  const manyShortCjkCells = compactCells.length >= 6 && maxCellLength <= 14
  const sparseVocabularyGrid = rowCount <= 4 && columnCount >= 4 && manyShortCjkCells
  return verticalLineShape && sparseVocabularyGrid
}

function shouldRenderAsTableBlock(
  block: unknown,
  pageVerticalMode = false,
  tableProjection?: ManualLayoutTableProjection | null,
): boolean {
  const resolvedTableProjection = tableProjection
    || (isTableBlock(block) ? createManualLayoutTableProjection(block, getBlockText(block)) : null)
  const manuallyEdited = String(readRecordValue(block, 'segmentation_source') || '').toLowerCase() === 'manual'
  return isRenderableTableBlock(block, resolvedTableProjection)
    && (manuallyEdited || !(pageVerticalMode && isLikelyVerticalPseudoTableBlock(block, resolvedTableProjection)))
}

function getBlockImagePath(block: unknown): string {
  return String(firstRecordValue(block, ['image_asset_path', 'asset_path', 'image_path']) || '').trim()
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
      blocks.push({ src, alt, location: { left, top, width: right - left, height: bottom - top } })
    }
  })
  return blocks
}

function getMarkdownTextAndImages(parsed: FacsimileOcrResult): { text: string; images: JsonRecord } {
  const markdown = parsed.markdown
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

function rectOverlapRatio(left: BlockRect, right: BlockRect): number {
  const x1 = Math.max(left.left, right.left)
  const y1 = Math.max(left.top, right.top)
  const x2 = Math.min(left.left + left.width, right.left + right.width)
  const y2 = Math.min(left.top + left.height, right.top + right.height)
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const minArea = Math.min(Math.max(1, left.width * left.height), Math.max(1, right.width * right.height))
  return intersection / minArea
}

function hasHorizontalTextSignals(block: unknown): boolean {
  const label = getLabel(block)
  if (isTocLabel(label)) return true
  const text = getBlockText(block)
  if (!text) return false
  const compact = text.replace(/\s+/g, '')
  const lines = text.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean)
  const asciiCount = Array.from(compact).filter((char) => /[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)).length
  const asciiRatio = asciiCount / Math.max(1, compact.length)
  const leaderLineCount = lines.filter((line) => /[.．·•]{3,}|…{2,}/.test(line)).length
  const pageNumberLineCount = lines.filter((line) => /(?:[.．·•…]\s*){2,}(?:[ivxlcdm]+|\d{1,4})\s*$/i.test(line) || /\s(?:[ivxlcdm]+|\d{1,4})\s*$/i.test(line)).length
  const hasTocShape = lines.length >= 3 && (leaderLineCount >= 1 || pageNumberLineCount >= Math.min(3, lines.length))
  if (hasTocShape) return true
  if (asciiRatio > 0.18) return true
  return false
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
  const rect = getRect(block)
  const text = getBlockText(block)
  if (!rect || !text.trim()) return false
  if (rect.height < rect.width * 1.28) return false
  return getVerticalScriptRatio(text) >= 0.42
}

function hasModernHorizontalParagraphShape(block: unknown): boolean {
  const label = getOrientationLabelText(block)
  if (!/^(?:text|paragraph|body)$/.test(label)) return false
  const rect = getRect(block)
  const text = getBlockText(block)
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
  const rect = getRect(block)
  const text = getBlockText(block)
  if (!rect || !text.trim()) return false
  if (/^(?:text|paragraph|body)$/.test(label)) {
    const compact = text.replace(/\s+/g, '')
    const punctuationCount = Array.from(compact).filter((char) => /[，。；：！？、“”‘’（）《》,.!?;:]/.test(char)).length
    if (compact.length >= 80 && rect.width >= 160 && punctuationCount / Math.max(1, compact.length) >= 0.045) return true
  }
  if (isNaturallyHorizontalLabel(label) && !isTallVerticalTextBlock(block)) return true
  const compact = text.replace(/\s+/g, '')
  const asciiCount = Array.from(compact).filter((char) => /[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)).length
  const asciiRatio = asciiCount / Math.max(1, compact.length)
  if (rect.width >= rect.height * 1.72) return true
  return rect.width >= rect.height * 1.35 && (asciiRatio > 0.18 || getVerticalScriptRatio(text) < 0.32)
}

function isVerticalPage(blocks: LayoutBlock[]): boolean {
  const meaningfulBlocks = blocks.filter((block) => {
    const label = getLabel(block)
    const tableProjection = isTableBlock(block)
      ? createManualLayoutTableProjection(block, getBlockText(block))
      : null
    return (!isRenderableTableBlock(block, tableProjection) || isLikelyVerticalPseudoTableBlock(block, tableProjection))
      && !isImageLabel(label)
      && !!getRect(block)
      && !!getBlockText(block).trim()
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

function inferOrientation(
  block: unknown,
  tableProjection?: ManualLayoutTableProjection | null,
): 'vertical' | 'horizontal' {
  const resolvedTableProjection = tableProjection
    || (isTableBlock(block) ? createManualLayoutTableProjection(block, getBlockText(block)) : null)
  if (isRenderableTableBlock(block, resolvedTableProjection)
    && !isLikelyVerticalPseudoTableBlock(block, resolvedTableProjection)) return 'horizontal'
  const manualOrientation = getManualOrientation(block)
  if (manualOrientation) return manualOrientation
  if (isStrongHorizontalTextBlock(block)) return 'horizontal'
  const explicitOrientation = getExplicitOcrOrientation(block)
  if (explicitOrientation) return explicitOrientation
  if (isTallVerticalTextBlock(block)) return 'vertical'
  if (hasHorizontalTextSignals(block)) return 'horizontal'
  const rect = getRect(block)
  const text = getBlockText(block)
  if (!rect) return 'vertical'
  const asciiRatio = Array.from(text.replace(/\s+/g, '')).filter((char) => /[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)).length / Math.max(1, text.length)
  if (asciiRatio > 0.18) return 'horizontal'
  return rect.height >= rect.width * 1.12 ? 'vertical' : 'horizontal'
}

function inferPageAwareOrientation(
  block: unknown,
  pageVerticalMode: boolean,
  tableProjection?: ManualLayoutTableProjection | null,
): 'vertical' | 'horizontal' {
  const resolvedTableProjection = tableProjection
    || (isTableBlock(block) ? createManualLayoutTableProjection(block, getBlockText(block)) : null)
  if (shouldRenderAsTableBlock(block, pageVerticalMode, resolvedTableProjection) || isImageLabel(getLabel(block))) return 'horizontal'
  const manualOrientation = getManualOrientation(block)
  if (manualOrientation) return manualOrientation
  if (!pageVerticalMode) return inferOrientation(block, resolvedTableProjection)
  if (isTocLabel(getLabel(block))) return 'horizontal'
  if (isLikelyVerticalPseudoTableBlock(block, resolvedTableProjection)) return 'vertical'
  if (hasVerticalColumnTextShape(block, resolvedTableProjection)) return 'vertical'
  if (isOrdinaryVerticalPageTextBlock(block, resolvedTableProjection)) return 'vertical'
  if (isStrongHorizontalTextBlock(block)) return 'horizontal'
  const explicitOrientation = getExplicitOcrOrientation(block)
  if (explicitOrientation) return explicitOrientation
  return 'vertical'
}

function normalizeBlocks(ocrResult: unknown): LayoutBlock[] {
  const parsed = asOcrResult(ocrResult)
  const rawBlocks = getOrderedOcrBlocks({ ocr_result: parsed })
  const blocks = rawBlocks
    .map((block, index): LayoutBlock | null => {
      const label = getLabel(block)
      const words = getBlockText(block)
      const rect = getRect(block)
      const isImage = isImageLabel(label) && !!rect
      const isManualBlock = Boolean(String(readRecordValue(block, 'manual_block_id') || '').trim())
        || String(readRecordValue(block, 'segmentation_source') || '').trim().toLowerCase() === 'manual'
      if (!words && !isImage && !isManualBlock) return null
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
    .filter((block): block is LayoutBlock => block !== null)

  const markdown = getMarkdownTextAndImages(parsed)
  const markdownText = markdown.text
  const fallbackText = typeof parsed.text === 'string' ? parsed.text : ''
  if (blocks.length === 0 && fallbackText) {
    return fallbackText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index): LayoutBlock => ({ words: line, label: 'text', reading_order: index, orientation: 'vertical', __sourceIndex: index }))
  }

  const imageBlocks = parseMarkdownImageBlocks(markdownText)
    .filter((imageBlock) => !blocks.some((block) => isImageLabel(getLabel(block)) && block.__rect && rectOverlapRatio(block.__rect, imageBlock.location) >= 0.6))
    .map((imageBlock, index): LayoutBlock => {
      const followingBlock = blocks
        .filter((block) => block.__rect && !isDecorativeLabel(getLabel(block)) && block.__rect.top >= imageBlock.location.top + imageBlock.location.height - Math.max(12, imageBlock.location.height * 0.08))
        .sort((left, right) => Number(left.__rect?.top || 0) - Number(right.__rect?.top || 0) || Number(left.reading_order || 0) - Number(right.reading_order || 0))[0]
      const readingOrder = followingBlock && Number.isFinite(Number(followingBlock.reading_order))
        ? Number(followingBlock.reading_order) - 0.5
        : blocks.length + index + 0.5
      return {
        words: imageBlock.alt || 'image',
        label: 'image',
        reading_order: readingOrder,
        orientation: 'horizontal',
        image_asset_path: resolveMarkdownImageSrc(imageBlock.src, markdown.images),
        asset_path: resolveMarkdownImageSrc(imageBlock.src, markdown.images),
        image_path: resolveMarkdownImageSrc(imageBlock.src, markdown.images),
        __rect: imageBlock.location,
        __sourceIndex: blocks.length + index,
      }
    })

  return [...blocks, ...imageBlocks].sort((left, right) => Number(left.reading_order || 0) - Number(right.reading_order || 0))
}

function normalizePageOrientations(blocks: LayoutBlock[], preferVerticalLayout = false): LayoutBlock[] {
  const pageVerticalMode = preferVerticalLayout || isVerticalPage(blocks)
  return blocks.map((block) => {
    const sourceOrientation = block.source_orientation === 'vertical' || block.source_orientation === 'horizontal'
      ? block.source_orientation
      : getOrientationValue(block)
    const orientation = inferPageAwareOrientation(block, pageVerticalMode)
    const orientationSource = getManualOrientation(block)
      ? 'manual'
      : block.orientation_source || (pageVerticalMode && sourceOrientation && sourceOrientation !== orientation ? 'page_consensus' : undefined)
    return {
      ...block,
      orientation,
      orientation_source: orientationSource,
      source_orientation: block.source_orientation || sourceOrientation || orientation,
      source_orientation_source: block.source_orientation_source || (sourceOrientation ? 'ocr' : undefined),
    }
  })
}

function splitWideVerticalBlocks(blocks: LayoutBlock[]): LayoutBlock[] {
  const nextBlocks: LayoutBlock[] = []
  blocks.forEach((block, blockIndex) => {
    const rect = block.__rect
    const label = getLabel(block)
    const tableProjection = isTableBlock(block)
      ? createManualLayoutTableProjection(block, getBlockText(block))
      : null
    if (
      !rect
      || block.orientation !== 'vertical'
      || shouldRenderAsTableBlock(block, true, tableProjection)
      || isImageLabel(label)
      || isDecorativeLabel(label)
      || rect.width < 72
      || rect.width < rect.height * 0.1
    ) {
      nextBlocks.push(block)
      return
    }

    const columnSourceText = isLikelyVerticalPseudoTableBlock(block, tableProjection)
      ? getPseudoTableText(block, tableProjection)
      : getBlockText(block)
    const columns = getVerticalColumns(columnSourceText)
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
      const sourceIndex = getBlockSourceIndex(block, blockIndex)
      const left = rect.left + rect.width - (columnIndex + 1) * columnWidth
      nextBlocks.push({
        ...block,
        words: columnText,
        displayWords: columnText,
        reading_order: Number(block.reading_order ?? blockIndex) + columnIndex / 100,
        column_index: columnIndex,
        line_index: 0,
        __rect: {
          left,
          top: rect.top,
          width: columnWidth,
          height: rect.height,
        },
        __sourceIndex: FACSIMILE_SPLIT_COLUMN_SOURCE_INDEX_BASE + sourceIndex * 1000 + columnIndex,
      })
    })
  })
  return nextBlocks.sort((left, right) => Number(left.reading_order || 0) - Number(right.reading_order || 0))
}

function getStackedVerticalBlockKey(block: LayoutBlock): string {
  const rect = block.__rect
  if (!rect) return ''
  const snap = (value: number) => Math.round(value / 2) * 2
  return [
    snap(rect.left),
    snap(rect.top),
    snap(rect.width),
    snap(rect.height),
    getLabel(block),
  ].join(':')
}

function splitStackedVerticalBlocks(blocks: LayoutBlock[]): LayoutBlock[] {
  const groups = new Map<string, LayoutBlock[]>()
  blocks.forEach((block) => {
    const rect = block.__rect
    const label = getLabel(block)
    if (
      !rect
      || block.orientation !== 'vertical'
      || shouldRenderAsTableBlock(block, true)
      || isImageLabel(label)
      || isDecorativeLabel(label)
      || shouldPreserveVerticalColumns(label)
      || !getBlockText(block).trim()
    ) {
      return
    }
    const key = getStackedVerticalBlockKey(block)
    if (!key) return
    const current = groups.get(key) || []
    current.push(block)
    groups.set(key, current)
  })

  const movedSourceIndexes = new Set<number>()
  const replacementBySourceIndex = new Map<number, LayoutBlock[]>()
  groups.forEach((group) => {
    if (group.length <= 1) return
    const firstRect = group[0].__rect
    if (!firstRect) return

    const normalizedTexts = group.map((block) => normalizeParallelSegmentForMatch(getBlockText(block)))
    const uniqueTextCount = new Set(normalizedTexts.filter(Boolean)).size
    if (uniqueTextCount <= 1) {
      const keep = group.reduce((best, block) => (
        getTextLength(getBlockText(block)) > getTextLength(getBlockText(best)) ? block : best
      ), group[0])
      group.forEach((block) => {
        if (block === keep) return
        movedSourceIndexes.add(getBlockSourceIndex(block, -1))
      })
      return
    }

    const columnWidth = firstRect.width / group.length
    if (columnWidth < 8) return
    const sortedGroup = [...group].sort((left, right) => Number(left.reading_order || 0) - Number(right.reading_order || 0))
    sortedGroup.forEach((block, columnIndex) => {
      const sourceIndex = getBlockSourceIndex(block, columnIndex)
      const left = firstRect.left + firstRect.width - (columnIndex + 1) * columnWidth
      replacementBySourceIndex.set(sourceIndex, [{
        ...block,
        column_index: Number(block.column_index ?? columnIndex),
        reading_order: Number(block.reading_order ?? sourceIndex) + columnIndex / 1000,
        __rect: {
          left,
          top: firstRect.top,
          width: columnWidth,
          height: firstRect.height,
        },
      }])
      movedSourceIndexes.add(sourceIndex)
    })
  })

  const nextBlocks = blocks.flatMap((block, index) => {
    const sourceIndex = getBlockSourceIndex(block, index)
    return replacementBySourceIndex.get(sourceIndex) || (movedSourceIndexes.has(sourceIndex) ? [] : [block])
  })
  return nextBlocks.sort((left, right) => Number(left.reading_order || 0) - Number(right.reading_order || 0))
}

function shouldUseImageUnderlay(blocks: LayoutBlock[], pageVerticalMode: boolean): boolean {
  const contentBlocks = blocks.filter((block) => {
    const label = getLabel(block)
    return !isDecorativeLabel(label) && !shouldRenderAsTableBlock(block, pageVerticalMode) && !!block.__rect && !!getBlockText(block).trim()
  })
  const imageBlockCount = blocks.filter((block) => isImageLabel(getLabel(block)) || !!getBlockImagePath(block)).length
  if (pageVerticalMode && contentBlocks.length >= 6 && imageBlockCount === 0) return false
  if (pageVerticalMode) return imageBlockCount > 0 || contentBlocks.length < 4
  if (contentBlocks.length < 3) return imageBlockCount > 0
  const verticalCount = contentBlocks.filter((block) => block.orientation === 'vertical' || isTallVerticalTextBlock(block)).length
  const verticalRatio = verticalCount / contentBlocks.length
  const denseHorizontal = contentBlocks.length >= 8 && verticalRatio < 0.35
  if (denseHorizontal) return false
  if (imageBlockCount > 0 && contentBlocks.length <= 16) return true
  return verticalRatio >= 0.55 || imageBlockCount >= 2
}

function getBlockSourceIndex(block: LayoutBlock, fallbackIndex: number): number {
  const sourceIndex = Number(block.__sourceIndex)
  return Number.isFinite(sourceIndex) && sourceIndex >= 0 ? sourceIndex : fallbackIndex
}

function getLayoutBounds(blocks: LayoutBlock[], coordinateSourceSize?: { width?: number | null; height?: number | null }) {
  return getOcrLayoutBounds(blocks, coordinateSourceSize)
}

function getCoordinateExtent(blocks: LayoutBlock[]): { minLeft: number; minTop: number; maxRight: number; maxBottom: number } | null {
  return getOcrCoordinateExtent(blocks)
}

function isPositiveSize(value?: { width?: number | null; height?: number | null } | null): value is { width: number; height: number } {
  return Number(value?.width || 0) > 0 && Number(value?.height || 0) > 0
}

function sizeDeltaRatio(left: { width: number; height: number }, right: { width: number; height: number }): number {
  return Math.max(
    Math.abs(left.width - right.width) / Math.max(1, right.width),
    Math.abs(left.height - right.height) / Math.max(1, right.height),
  )
}

function coordinateExtentFitsSize(
  extent: { minLeft: number; minTop: number; maxRight: number; maxBottom: number } | null,
  size: { width: number; height: number },
): boolean {
  if (!extent) return false
  return extent.minLeft >= -size.width * 0.04
    && extent.minTop >= -size.height * 0.04
    && extent.maxRight <= size.width * 1.08
    && extent.maxBottom <= size.height * 1.08
}

function resolveCoordinateSourceSizeForImage(
  coordinateSourceSize: { width?: number | null; height?: number | null; preserveServiceCoordinates?: boolean } | undefined,
  pageImageNaturalSize: { width: number; height: number } | null,
  coordinateExtent: { minLeft: number; minTop: number; maxRight: number; maxBottom: number } | null,
): { width?: number | null; height?: number | null } | undefined {
  const explicitSize = isPositiveSize(coordinateSourceSize)
    ? { width: Number(coordinateSourceSize.width), height: Number(coordinateSourceSize.height) }
    : null
  if (coordinateSourceSize?.preserveServiceCoordinates) {
    return explicitSize || pageImageNaturalSize || coordinateSourceSize
  }
  if (!pageImageNaturalSize) return explicitSize || coordinateSourceSize
  if (!explicitSize) return pageImageNaturalSize
  if (sizeDeltaRatio(explicitSize, pageImageNaturalSize) <= 0.02) return pageImageNaturalSize

  const fitsImage = coordinateExtentFitsSize(coordinateExtent, pageImageNaturalSize)
  const fitsExplicit = coordinateExtentFitsSize(coordinateExtent, explicitSize)
  if (fitsImage && !fitsExplicit) return pageImageNaturalSize
  if (!fitsImage && fitsExplicit) return explicitSize
  if (fitsImage && fitsExplicit) return explicitSize
  return explicitSize
}

function buildSyntheticRects(blocks: LayoutBlock[], bounds: { width: number; height: number }): LayoutBlock[] {
  const marginX = bounds.width * 0.09
  const marginY = bounds.height * 0.08
  const contentHeight = bounds.height - marginY * 2
  const columnGap = bounds.width * 0.025
  const columnWidth = Math.max(36, Math.min(76, (bounds.width - marginX * 2) / Math.max(4, blocks.length)))
  let cursorRight = bounds.width - marginX
  return blocks.map((block, index) => {
    const text = getBlockText(block)
    const width = Math.min(bounds.width * 0.34, columnWidth * Math.max(1, Math.ceil(text.length / 42)))
    cursorRight -= width
    const rect = { left: Math.max(marginX, cursorRight), top: marginY, width, height: contentHeight }
    cursorRight -= columnGap
    return { ...block, __rect: rect, __synthetic: true, reading_order: Number.isFinite(Number(block.reading_order)) ? Number(block.reading_order) : index, orientation: 'vertical', __sourceIndex: getBlockSourceIndex(block, index) }
  })
}

function getUnionRect(rects: BlockRect[]): BlockRect | null {
  if (rects.length === 0) return null
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.left + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height))
  return { left, top, width: right - left, height: bottom - top }
}

function getCoverageRect(block: LayoutBlock, coverage: TranslationBlockCoverage, pageVerticalMode: boolean): BlockRect | null {
  const rect = block.__rect
  if (!rect) return null
  const compactLength = normalizeParallelSegmentForMatch(getBlockText(block)).length
  if (compactLength <= 1) return rect
  const startRatio = clamp(coverage.startOffset / compactLength, 0, 1)
  const endRatio = clamp(coverage.endOffset / compactLength, startRatio, 1)
  const spanRatio = Math.max(0.02, endRatio - startRatio)
  const orientation = inferPageAwareOrientation(block, pageVerticalMode)
  if (orientation === 'vertical') {
    return {
      left: rect.left,
      top: rect.top + rect.height * startRatio,
      width: rect.width,
      height: rect.height * spanRatio,
    }
  }
  return {
    left: rect.left + rect.width * startRatio,
    top: rect.top,
    width: rect.width * spanRatio,
    height: rect.height,
  }
}

function getSegmentCoverage(
  blockTexts: string[],
  segmentSource: string,
  cursor: TranslationCoverageCursor,
): { coverage: TranslationBlockCoverage[]; nextCursor: TranslationCoverageCursor } {
  let remaining = normalizeParallelSegmentForMatch(segmentSource)
  if (!remaining) return { coverage: [], nextCursor: cursor }
  const coverage: TranslationBlockCoverage[] = []
  let nextCursor = cursor

  for (let blockIndex = cursor.blockIndex; blockIndex < blockTexts.length && remaining; blockIndex += 1) {
    const blockText = normalizeParallelSegmentForMatch(blockTexts[blockIndex])
    if (!blockText) continue
    let offset = blockIndex === cursor.blockIndex ? Math.max(0, cursor.offset) : 0
    if (offset >= blockText.length) continue
    let matchStart = -1
    let matchEnd = offset
    while (remaining && offset < blockText.length) {
      const segmentRest = remaining
      const blockRest = blockText.slice(offset)
      if (segmentRest.startsWith(blockRest)) {
        if (matchStart < 0) matchStart = offset
        matchEnd = blockText.length
        remaining = segmentRest.slice(blockRest.length)
        offset = blockText.length
        break
      }
      if (blockRest.startsWith(segmentRest)) {
        if (matchStart < 0) matchStart = offset
        matchEnd = offset + segmentRest.length
        remaining = ''
        offset = matchEnd
        break
      }
      if (matchStart >= 0) break
      offset += 1
    }
    if (matchStart >= 0) {
      coverage.push({ blockIndex, startOffset: matchStart, endOffset: matchEnd })
      nextCursor = matchEnd >= blockText.length
        ? { blockIndex: blockIndex + 1, offset: 0 }
        : { blockIndex, offset: matchEnd }
    }
  }

  return remaining ? { coverage: [], nextCursor: cursor } : { coverage, nextCursor }
}

function buildFacsimileTranslationOverlays(
  pageBlocks: LayoutBlock[],
  pageSourceText: string,
  translationText: string,
  preferVerticalLayout = false,
): FacsimileTranslationOverlay[] {
  if (!isParallelTranslationDisplayReady(pageSourceText, translationText)) return []
  const blockTexts = pageBlocks.map((block) => getBlockText(block))
  const segments = buildParallelTranslationSegments(pageSourceText, translationText)
  const overlays: FacsimileTranslationOverlay[] = []
  let coverageCursor: TranslationCoverageCursor = { blockIndex: 0, offset: 0 }
  const pageVerticalMode = preferVerticalLayout || isVerticalPage(pageBlocks)

  segments.forEach((segment, segmentIndex) => {
    const translation = segment.translation.trim()
    if (!translation) return
    const result = getSegmentCoverage(blockTexts, segment.source, coverageCursor)
    const coverage = result.coverage
    if (coverage.length === 0) return
    coverageCursor = result.nextCursor
    const coveredBlocks = coverage
      .map((item) => pageBlocks[item.blockIndex])
      .filter((block): block is LayoutBlock => Boolean(block?.__rect))
    const coverageRects = coverage
      .map((item) => {
        const block = pageBlocks[item.blockIndex]
        return block ? getCoverageRect(block, item, pageVerticalMode) : null
      })
      .filter((rect): rect is BlockRect => Boolean(rect))
    const rect = getUnionRect(coverageRects)
    if (!rect) return
    const firstBlock = coveredBlocks[0]
    const labels = coveredBlocks.map((block) => getLabel(block)).filter(Boolean)
    const label = labels.find((item) => !isDecorativeLabel(item)) || labels[0] || 'text'
    if (isImageLabel(label)) return
    const verticalCount = coveredBlocks.filter((block) => inferPageAwareOrientation(block, pageVerticalMode) === 'vertical').length
    overlays.push({
      id: segment.id || `translation-segment-${segmentIndex}`,
      sourceIndexes: coverage.map((item) => getBlockSourceIndex(pageBlocks[item.blockIndex], item.blockIndex)),
      text: translation,
      rect,
      label,
      orientation: verticalCount >= coveredBlocks.length / 2 ? 'vertical' : (firstBlock ? inferPageAwareOrientation(firstBlock, pageVerticalMode) : 'horizontal'),
    })
  })

  return overlays
}

function getTextLength(text: string): number {
  return Math.max(1, Array.from(String(text || '').replace(/\s+/g, '')).length)
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

function buildFacsimileTranslationOverlaysFromUnits(
  pageBlocks: LayoutBlock[],
  units: TranslationUnitV1[],
  preferVerticalLayout = false,
): FacsimileTranslationOverlay[] {
  const pageVerticalMode = preferVerticalLayout || isVerticalPage(pageBlocks)
  return units.flatMap((unit, unitIndex) => {
    if (!isUsableTranslationUnit(unit)) return []
    const text = String(unit.translationText || (unit.skipped ? unit.sourceText : '')).trim()
    const rect = unit.sourceRect
    if (!text || !rect || rect.width <= 0 || rect.height <= 0) return []
    const sourceIndex = Number.isFinite(Number(unit.sourceIndex)) ? Number(unit.sourceIndex) : unit.blockIndex
    const block = pageBlocks.find((item, index) => getBlockSourceIndex(item, index) === sourceIndex)
      || pageBlocks[unit.blockIndex]
    const label = block ? getLabel(block) : unit.blockType || 'text'
    if (isImageLabel(label)) return []
    return [{
      id: unit.id || `translation-unit-${unitIndex}`,
      sourceIndexes: [sourceIndex],
      text,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      label,
      orientation: block ? inferPageAwareOrientation(block, pageVerticalMode) : 'horizontal',
    }]
  })
}

function shouldPreserveVerticalColumns(label: string): boolean {
  return isTitleLabel(label) || isTocLabel(label)
}

function getFacsimileLayoutProfile(ocrResult: unknown): FacsimileLayoutProfile {
  const parsed = asOcrResult(ocrResult)
  const sourceType = String(parsed.source_type || '').toLowerCase()
  if (sourceType.includes('vision') || sourceType.includes('hybrid_ocr')) return 'vision'
  return 'paddle'
}

function getBlockPadding(label: string, orientation: 'vertical' | 'horizontal', profile: FacsimileLayoutProfile): number {
  if (isImageLabel(label)) return 0
  const base = isDecorativeLabel(label) ? 1 : isNoteLabel(label) ? 2 : 3
  if (isTitleLabel(label)) return profile === 'vision' ? 0 : 1
  if (orientation === 'horizontal' || profile === 'vision') return Math.max(0, base - 1)
  return base
}

function getBlockFontWeight(label: string, profile: FacsimileLayoutProfile): number {
  if (isTitleLabel(label)) return 650
  return profile === 'vision' ? 560 : 540
}

function getBlockLineHeight(label: string, orientation: 'vertical' | 'horizontal', profile: FacsimileLayoutProfile): number {
  if (orientation === 'horizontal') return isTitleLabel(label) ? 1.08 : profile === 'vision' ? 1.18 : 1.24
  if (isNoteLabel(label)) return profile === 'vision' ? 1.28 : 1.32
  return profile === 'vision' ? 1.34 : 1.38
}

type FittedTextLayout = {
  fontSize: number
  text: string
  overflow: boolean
}

let measureCanvasContext: CanvasRenderingContext2D | null = null

function getMeasureCanvasContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  if (measureCanvasContext) return measureCanvasContext
  const canvas = document.createElement('canvas')
  measureCanvasContext = canvas.getContext('2d')
  return measureCanvasContext
}

function getMeasureFont(fontSize: number, label: string, profile: FacsimileLayoutProfile): string {
  return `${getBlockFontWeight(label, profile)} ${fontSize}px ${FONT_FAMILY}`
}

function measureTextWidth(text: string, fontSize: number, label: string, profile: FacsimileLayoutProfile): number {
  const value = String(text || '')
  if (!value) return 0
  const context = getMeasureCanvasContext()
  if (!context) return getTextLength(value) * fontSize * (/[A-Za-z0-9]/.test(value) ? 0.62 : 0.92)
  context.font = getMeasureFont(fontSize, label, profile)
  return context.measureText(value).width
}

function tokenizeForLineBreak(text: string): string[] {
  const source = String(text || '')
  const tokens: string[] = []
  let latinBuffer = ''
  const flushLatin = () => {
    if (latinBuffer) {
      tokens.push(latinBuffer)
      latinBuffer = ''
    }
  }
  for (const char of Array.from(source)) {
    if (/\s/.test(char)) {
      flushLatin()
      tokens.push(char)
    } else if (/[A-Za-z0-9()[\]{}.,;:!?/"'%-]/.test(char)) {
      latinBuffer += char
    } else {
      flushLatin()
      tokens.push(char)
    }
  }
  flushLatin()
  return tokens
}

const LINE_START_FORBIDDEN = '，。、；：？！）》】」』”’、,;:?!%)]}…'
const LINE_END_FORBIDDEN = '（《【「『“‘([{'

function wrapParagraphToWidth(paragraph: string, maxWidth: number, fontSize: number, label: string, profile: FacsimileLayoutProfile): string[] {
  const source = String(paragraph || '').trim()
  if (!source) return ['']
  const tokens = tokenizeForLineBreak(source)
  const lines: string[] = []
  let current = ''
  const pushCurrent = () => {
    const value = current.trim()
    if (value) lines.push(value)
    current = ''
  }

  tokens.forEach((token) => {
    if (!token) return
    const isWhitespace = /^\s+$/.test(token)
    const next = isWhitespace
      ? (current && !current.endsWith(' ') ? `${current} ` : current)
      : `${current}${token}`
    if (!current || measureTextWidth(next, fontSize, label, profile) <= maxWidth) {
      current = next
      return
    }

    const tokenFirst = Array.from(token)[0] || ''
    if (LINE_START_FORBIDDEN.includes(tokenFirst)) {
      current = next
      return
    }

    const currentLast = Array.from(current).at(-1) || ''
    if (LINE_END_FORBIDDEN.includes(currentLast)) {
      current = next
      return
    }

    pushCurrent()
    if (measureTextWidth(token, fontSize, label, profile) <= maxWidth || token.length <= 1) {
      current = isWhitespace ? '' : token
      return
    }

    let chunk = ''
    Array.from(token).forEach((char) => {
      const candidate = `${chunk}${char}`
      if (chunk && measureTextWidth(candidate, fontSize, label, profile) > maxWidth) {
        lines.push(chunk)
        chunk = char
      } else {
        chunk = candidate
      }
    })
    current = chunk
  })

  pushCurrent()
  return lines.length ? lines : ['']
}

function wrapTextToWidth(text: string, maxWidth: number, fontSize: number, label: string, profile: FacsimileLayoutProfile): string[] {
  return String(text || '')
    .split(/\n+/)
    .flatMap((paragraph) => wrapParagraphToWidth(paragraph, maxWidth, fontSize, label, profile))
}

function measureTextLayout(rect: BlockRect, text: string, label: string, fontSize: number, orientation: 'vertical' | 'horizontal', profile: FacsimileLayoutProfile): { fittedText: string; overflow: boolean } {
  const padding = getBlockPadding(label, orientation, profile)
  const usableWidth = Math.max(4, rect.width - padding * 2 - 2)
  const usableHeight = Math.max(8, rect.height - padding * 2 - 2)
  const length = getTextLength(text)
  const lineHeight = getBlockLineHeight(label, orientation, profile)
  if (orientation === 'horizontal') {
    const lines = wrapTextToWidth(text, usableWidth, fontSize, label, profile)
    return {
      fittedText: text,
      overflow: lines.length * fontSize * lineHeight > usableHeight + 0.5,
    }
  }
  const hardColumns = getVerticalColumns(text)
  if (hardColumns.length <= 1) {
    const columnCount = Math.max(1, Math.ceil((length * fontSize * 1.02) / usableHeight))
    return {
      fittedText: text,
      overflow: columnCount * fontSize * lineHeight > usableWidth + 0.5,
    }
  }
  const maxColumnLength = Math.max(...hardColumns.map((column) => getTextLength(column)))
  return {
    fittedText: text,
    overflow: hardColumns.length * fontSize * lineHeight > usableWidth + 0.5
      || maxColumnLength * fontSize * 1.02 > usableHeight + 0.5,
  }
}

function fitTextLayout(rect: BlockRect, text: string, label: string, baseFontSize: number, orientation: 'vertical' | 'horizontal', profile: FacsimileLayoutProfile): FittedTextLayout {
  const targetFont = clamp(
    baseFontSize * (isTitleLabel(label) ? 1.08 : isDecorativeLabel(label) ? 0.76 : isNoteLabel(label) ? 0.86 : 1),
    4,
    isTitleLabel(label) ? 34 : isDecorativeLabel(label) ? 18 : 30,
  )
  const targetLayout = measureTextLayout(rect, text, label, targetFont, orientation, profile)
  if (!targetLayout.overflow) return { fontSize: targetFont, text: targetLayout.fittedText, overflow: false }

  const minReadableFont = isBodyTextLabel(label)
    ? Math.max(10, baseFontSize * 0.82)
    : isNoteLabel(label)
      ? Math.max(7, targetFont * 0.75)
      : Math.max(8, targetFont * 0.85)
  const minFont = Math.min(targetFont, minReadableFont)
  let low = minFont
  let high = targetFont
  let bestLayout = measureTextLayout(rect, text, label, low, orientation, profile)
  for (let index = 0; index < FACSIMILE_TEXT_FIT_ITERATIONS; index += 1) {
    const mid = (low + high) / 2
    const midLayout = measureTextLayout(rect, text, label, mid, orientation, profile)
    if (!midLayout.overflow) {
      bestLayout = midLayout
      low = mid
    } else {
      high = mid
    }
  }
  const finalFontSize = bestLayout.overflow ? minFont : low
  const finalLayout = measureTextLayout(rect, text, label, finalFontSize, orientation, profile)
  return { fontSize: finalFontSize, text: finalLayout.fittedText, overflow: finalLayout.overflow }
}

function measureTableLayout(rect: BlockRect, rows: string[][], fontSize: number): { overflow: boolean } {
  const rowCount = Math.max(1, rows.length)
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const cellWidth = Math.max(4, (rect.width - 4) / columnCount - 2)
  const cellHeight = Math.max(4, (rect.height - 4) / rowCount - 2)
  const overflow = rows.some((row) => row.some((cell) => (
    wrapTextToWidth(cell, cellWidth, fontSize, 'table', 'vision').length * fontSize * 1.18 > cellHeight + 0.5
  )))
  return { overflow }
}

function fitTableLayout(rect: BlockRect, rows: string[][], baseFontSize: number): FittedTextLayout {
  const targetFont = clamp(baseFontSize * 0.88, 3.5, 22)
  const targetLayout = measureTableLayout(rect, rows, targetFont)
  if (!targetLayout.overflow) return { fontSize: targetFont, text: '', overflow: false }

  const minFont = Math.max(3, targetFont * 0.75)
  let low = minFont
  let high = targetFont
  let bestOverflow = measureTableLayout(rect, rows, low).overflow
  for (let index = 0; index < FACSIMILE_TEXT_FIT_ITERATIONS; index += 1) {
    const mid = (low + high) / 2
    const midOverflow = measureTableLayout(rect, rows, mid).overflow
    if (!midOverflow) {
      bestOverflow = false
      low = mid
    } else {
      high = mid
    }
  }
  return { fontSize: bestOverflow ? minFont : low, text: '', overflow: bestOverflow }
}

function getBlockBorderStyle(orientation: 'vertical' | 'horizontal', showRules: boolean): CSSProperties {
  if (!showRules) return {}
  if (orientation === 'vertical') return { borderLeft: '1px solid rgba(36,25,15,0.32)', borderRight: '1px solid rgba(36,25,15,0.32)' }
  return { border: '1px solid rgba(36,25,15,0.22)' }
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
  if (LINE_START_FORBIDDEN.includes(right)) return ''
  if (LINE_END_FORBIDDEN.includes(left)) return ''
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

function normalizeDisplayText(text: string, orientation: 'vertical' | 'horizontal', _profile: FacsimileLayoutProfile, label: string, _rect?: BlockRect | null): string {
  const normalized = String(text || '').replace(/\r\n/g, '\n')
  if (orientation === 'vertical') {
    const columns = getVerticalColumns(normalized)
    if (columns.length > 1) return columns.join('\n')
    return columns.join('')
  }
  if (isTocLabel(label)) {
    return normalized
      .split(/\n+/)
      .map((part) => part.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
  }
  return mergeSoftLineBreaks(normalized)
    .split('\n')
    .map((part) => part.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function normalizeTranslatedTextForLayout(text: string, orientation: 'vertical' | 'horizontal'): string {
  const normalized = String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/^\s*\[?S\d{1,4}\]?\s*[:：.)、-]?\s*/gmi, '')
    .trim()
  if (!normalized) return ''
  const merged = mergeSoftLineBreaks(normalized)
  if (orientation === 'vertical') {
    return merged
      .split(/\n+/)
      .map((line) => line.replace(/[ \t]+/g, '').trim())
      .filter(Boolean)
      .join('')
  }
  return merged
}

function transformText(text: string, script: ProofDisplayScript): string {
  if (script === 'simplified') return toSimplified(text)
  if (script === 'traditional') return toTraditional(text)
  return text
}

function normalizeSearchText(value: string): string {
  return toSimplified(String(value || '')).toLowerCase()
}

function renderInlineAnnotations(text: string, keyPrefix: string): ReactNode[] {
  return renderOcrInlineText(text, keyPrefix)
}

function renderFormattedText(text: string, keyword: string, highlight: boolean, activeHitOrdinal = -1): ReactNode {
  const query = String(keyword || '').trim()
  if (!highlight || !query) return renderInlineAnnotations(text, 'text')
  const normalizedText = normalizeSearchText(text)
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedText || !normalizedQuery) return renderInlineAnnotations(text, 'text')
  const nodes: ReactNode[] = []
  let cursor = 0
  let hitOrdinal = 0
  for (;;) {
    const index = normalizedText.indexOf(normalizedQuery, cursor)
    if (index < 0) break
    if (index > cursor) {
      nodes.push(...renderInlineAnnotations(text.slice(cursor, index), `before-${nodes.length}`))
    }
    const end = index + query.length
    const isActiveHit = hitOrdinal === activeHitOrdinal
    nodes.push(
      <mark
        key={`hit-${hitOrdinal}-${index}`}
        data-search-hit="true"
        data-search-active={isActiveHit ? 'true' : undefined}
        style={{
          background: isActiveHit ? '#fa8c16' : '#fadb14',
          color: 'inherit',
          padding: '0 2px',
          borderRadius: 2,
          boxShadow: isActiveHit ? '0 0 0 1px rgba(120, 53, 15, 0.6)' : undefined,
        }}
      >
        {text.slice(index, end)}
      </mark>,
    )
    hitOrdinal += 1
    cursor = Math.max(end, index + 1)
  }
  if (nodes.length === 0) return renderInlineAnnotations(text, 'text')
  if (cursor < text.length) {
    nodes.push(...renderInlineAnnotations(text.slice(cursor), `after-${nodes.length}`))
  }
  return nodes
}

function renderFacsimileTable(
  rows: string[][],
  merges: FacsimileTableMerge[],
  keyword: string,
  highlight: boolean,
  activeHitOrdinal = -1,
) {
  let cellHitCursor = 0
  return (
    <table style={{ width: '100%', height: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => {
              const merge = merges.find((item) => (
                rowIndex >= item.row && rowIndex < item.row + item.rowSpan
                && cellIndex >= item.col && cellIndex < item.col + item.colSpan
              ))
              if (merge && (merge.row !== rowIndex || merge.col !== cellIndex)) return null
              const normalizedCell = normalizeSearchText(cell)
              const normalizedKeyword = normalizeSearchText(keyword)
              let cellHitCount = 0
              if (highlight && normalizedCell && normalizedKeyword) {
                let cursor = 0
                for (;;) {
                  const next = normalizedCell.indexOf(normalizedKeyword, cursor)
                  if (next < 0) break
                  cellHitCount += 1
                  cursor = next + Math.max(1, normalizedKeyword.length)
                }
              }
              const activeCellOrdinal = activeHitOrdinal >= cellHitCursor && activeHitOrdinal < cellHitCursor + cellHitCount
                ? activeHitOrdinal - cellHitCursor
                : -1
              cellHitCursor += cellHitCount
              return (
                <td key={cellIndex} rowSpan={merge?.rowSpan} colSpan={merge?.colSpan} style={{ border: '1px solid rgba(64,48,32,0.28)', padding: 2, verticalAlign: 'top', wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'normal', lineHeight: 1.18, overflow: 'hidden' }}>
                  {renderFormattedText(cell, keyword, highlight && cellHitCount > 0, activeCellOrdinal)}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function getScaledRect(rect: BlockRect, bounds: { width: number; height: number; offsetLeft: number; offsetTop: number }, pagePixelWidth: number): BlockRect {
  return scaleOcrRectToWidth(rect, bounds, pagePixelWidth)
}

function clampZoom(value: number): number {
  return Math.round(clamp(value, FACSIMILE_MIN_ZOOM, FACSIMILE_MAX_ZOOM) * 100) / 100
}

const BLOCK_RESIZE_HANDLES: Array<{ handle: ManualLayoutResizeHandle; left: number; top: number; cursor: CSSProperties['cursor'] }> = [
  { handle: 'nw', left: 0, top: 0, cursor: 'nwse-resize' },
  { handle: 'n', left: 50, top: 0, cursor: 'ns-resize' },
  { handle: 'ne', left: 100, top: 0, cursor: 'nesw-resize' },
  { handle: 'e', left: 100, top: 50, cursor: 'ew-resize' },
  { handle: 'se', left: 100, top: 100, cursor: 'nwse-resize' },
  { handle: 's', left: 50, top: 100, cursor: 'ns-resize' },
  { handle: 'sw', left: 0, top: 100, cursor: 'nesw-resize' },
  { handle: 'w', left: 0, top: 50, cursor: 'ew-resize' },
]

function rectFromPointerPoints(start: { x: number; y: number }, current: { x: number; y: number }): BlockRect {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  }
}

function shouldIgnoreCanvasDrag(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest(
    'button,input,textarea,.ant-slider,.ant-switch,[data-guji-block-index],[data-facsimile-translation-overlay],.reader-selection-toolbar',
  )
}

function isGujiVerticalOcrResult(ocrResult: unknown): boolean {
  const parsed = asOcrResult(ocrResult)
  const processing = readRecordValue(parsed, 'guji_processing')
  const profile = isJsonRecord(processing) ? String(processing.profile || '').toLowerCase() : ''
  return profile === 'guji_print_vertical'
}

function buildOcrPayload(baseOcrResult: unknown, blocks: LayoutBlock[], proofStatus: 'completed' | 'pending', preferVerticalLayout = false): PageUpdatePayload {
  const pageVerticalMode = preferVerticalLayout || isVerticalPage(blocks)
  const normalizedBlocks = blocks.map((block, index) => {
    const { __rect, __synthetic, __sourceIndex, __manualDraftId, ...rest } = block
    const tableProjection = isTableBlock(block)
      ? createManualLayoutTableProjection(block, getBlockText(block))
      : null
    const orientation = inferPageAwareOrientation(block, pageVerticalMode, tableProjection)
    const pseudoTable = pageVerticalMode
      && String(block.segmentation_source || '').toLowerCase() !== 'manual'
      && isLikelyVerticalPseudoTableBlock(block, tableProjection)
    const words = pseudoTable ? getPseudoTableText(block, tableProjection) : getBlockText(block)
    return {
      ...rest,
      words,
      label: pseudoTable ? 'text' : rest.label,
      type: pseudoTable && rest.type === 'table' ? 'text' : rest.type,
      block_type: pseudoTable && rest.block_type === 'table' ? 'text' : rest.block_type,
      rows: pseudoTable ? undefined : rest.rows,
      table_rows: pseudoTable ? undefined : rest.table_rows,
      tableRows: pseudoTable ? undefined : rest.tableRows,
      cells: pseudoTable ? undefined : rest.cells,
      table_cells: pseudoTable ? undefined : rest.table_cells,
      tableCells: pseudoTable ? undefined : rest.tableCells,
      html: pseudoTable ? undefined : rest.html,
      table_html: pseudoTable ? undefined : rest.table_html,
      tableHtml: pseudoTable ? undefined : rest.tableHtml,
      markdown: pseudoTable ? undefined : rest.markdown,
      md: pseudoTable ? undefined : rest.md,
      reading_order: index,
      orientation,
      orientation_source: isManualOrientationSource(block.orientation_source) ? 'manual' : block.orientation_source,
      source_orientation: block.source_orientation || getOrientationValue(block) || orientation,
      source_orientation_source: block.source_orientation_source || 'ocr',
      location: block.location || (__rect ? { left: __rect.left, top: __rect.top, width: __rect.width, height: __rect.height } : undefined),
    }
  })
  const fullText = normalizedBlocks.map((block) => String(block.words || '').trim()).filter(Boolean).join('\n')
  return {
    ocr_result: { ...asOcrResult(baseOcrResult), layout_result: normalizedBlocks, words_result: normalizedBlocks.map((block) => ({ words: block.words || '' })) },
    ocr_text: fullText,
    proofed_text: fullText,
    ...(fullText ? { ocr_status: 'completed' as const } : {}),
    proof_status: proofStatus,
  }
}

function FacsimileImageBlock({
  assetPath,
  pageImageSrc,
  rect,
  bounds,
}: {
  assetPath: string
  pageImageSrc: string
  rect: BlockRect
  bounds: { width: number; height: number; offsetLeft: number; offsetTop: number }
}) {
  const [assetSrc, setAssetSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    const normalizedAssetPath = String(assetPath || '').trim()
    const isLocalImageAsset = normalizedAssetPath && !/^(?:https?:|data:|blob:)/i.test(normalizedAssetPath) && !/^(?:imgs?|images?)\//i.test(normalizedAssetPath)
    if (!isLocalImageAsset) {
      setAssetSrc('')
      return () => { cancelled = true }
    }
    void window.api.readImageAsDataURL(normalizedAssetPath)
      .then((dataUrl) => { if (!cancelled) setAssetSrc(dataUrl || '') })
      .catch(() => { if (!cancelled) setAssetSrc('') })
    return () => { cancelled = true }
  }, [assetPath])
  const src = assetSrc || pageImageSrc || ''
  if (!src) return null
  const imageLeft = rect.left - bounds.offsetLeft
  const imageTop = rect.top - bounds.offsetTop
  const imageWidth = bounds.width
  const imageHeight = bounds.height
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', background: 'rgba(255,253,247,0.5)' }}>
      {assetSrc ? (
        <img src={assetSrc} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', userSelect: 'none' }} />
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            left: `${-(imageLeft / Math.max(rect.width, 1)) * 100}%`,
            top: `${-(imageTop / Math.max(rect.height, 1)) * 100}%`,
            width: `${(imageWidth / Math.max(rect.width, 1)) * 100}%`,
            height: `${(imageHeight / Math.max(rect.height, 1)) * 100}%`,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />
      )}
    </div>
  )
}

export function getFacsimileTranslationSourceText(ocrResult: unknown): string {
  return getCanonicalPageTranslationSourceText({ ocr_result: ocrResult })
}

export function isFacsimileProofCandidate(doc: Partial<Document> | null | undefined, page: Partial<DocumentPage> | null | undefined, ocrResult: unknown): boolean {
  const metadata = asOcrResult(doc?.metadata)
  const pageOcrResult = asOcrResult(page?.ocr_result)
  const sourceType = String(pageOcrResult.source_type || '')
  if (metadata.file_kind === 'ebook' || metadata.file_kind === 'text' || sourceType.startsWith('ebook_')) return false
  const blocks = normalizeBlocks(ocrResult)
  const parsed = asOcrResult(ocrResult)
  const pageText = String(page?.proofed_text || page?.ocr_text || parsed.text || '').trim()
  const hasVisualSource = Boolean(String(page?.image_path || '').trim() || String(doc?.file_path || '').trim())
  return blocks.length > 0 || pageText.length > 0 || hasVisualSource || doc?.doc_type === '古籍'
}

export default function GujiFacsimileProofreader({
  draftIdentity,
  pageId,
  ocrResult,
  pageImageSrc = '',
  pageProofStatus = 'pending',
  activeBoxIndex = -1,
  activeSearchHitOrdinal = -1,
  searchKeyword = '',
  coordinateSourceSize,
  preferVerticalLayout = false,
  translationText = '',
  translationUnits = [],
  translationLoading = false,
  translationSkipped = false,
  translationOpen: controlledTranslationOpen,
  translationMode = 'balanced',
  documentId = '',
  documentTitle = '',
  documentType = null,
  pageNum = null,
  literaturePageNum = null,
  onTranslationOpenChange,
  onTranslationModeChange,
  onTranslateCurrentPage,
  onRetranslateCurrentPage,
  onSelectBox,
  onSave,
  onTextSelectionChange,
}: GujiFacsimileProofreaderProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pageFrameRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const wheelAnchorFrameRef = useRef<number | null>(null)
  const wheelZoomCommitTimerRef = useRef<number | null>(null)
  const pageRecenterFrameRef = useRef<number | null>(null)
  const translationRequestKeyRef = useRef('')
  const pendingDraftIdentityRef = useRef('')
  const historyPageRef = useRef('')
  const proofreaderMountedRef = useRef(true)
  const pageZoomRef = useRef(1)
  const fitWidthRef = useRef(true)
  const pageRotationRef = useRef(0)
  const dragStartRef = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 })
  const blocksRef = useRef<LayoutBlock[]>([])
  const layoutInteractionRef = useRef<LayoutPointerInteraction | null>(null)
  const applyLayoutPointerFrameRef = useRef<(frame: LayoutPointerFrame) => void>(() => undefined)
  const layoutPointerFrameSchedulerRef = useRef<ManualLayoutPointerFrameScheduler<LayoutPointerFrame> | null>(null)
  if (!layoutPointerFrameSchedulerRef.current) {
    layoutPointerFrameSchedulerRef.current = createManualLayoutPointerFrameScheduler(
      (callback) => window.requestAnimationFrame(callback),
      (frameId) => window.cancelAnimationFrame(frameId),
      (frame) => applyLayoutPointerFrameRef.current(frame),
    )
  }
  const [history, setHistory] = useState<LayoutBlock[][]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [tableDraftRows, setTableDraftRows] = useState<string[][]>([['']])
  const [tableDraftMerges, setTableDraftMerges] = useState<FacsimileTableMerge[]>([])
  const [tableDraftRowHeights, setTableDraftRowHeights] = useState<number[]>([])
  const [tableDraftColumnWidths, setTableDraftColumnWidths] = useState<number[]>([])
  const [layoutEditMode, setLayoutEditMode] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [manualLayoutTool, setManualLayoutTool] = useState<ManualLayoutTool>('select')
  const [altShowsClearUnderlay, setAltShowsClearUnderlay] = useState(false)
  const [draftCreateRect, setDraftCreateRect] = useState<BlockRect | null>(null)
  const [pendingCreateRect, setPendingCreateRect] = useState<BlockRect | null>(null)
  const [showRules, setShowRules] = useState(loadPersistedShowRules)
  const [fontScale, setFontScale] = useState(loadPersistedFontScale)
  const [pageZoom, setPageZoom] = useState(1)
  const [pageRotation, setPageRotation] = useState(0)
  const [displayScript, setDisplayScript] = useState<ProofDisplayScript>('original')
  const [fitWidth, setFitWidth] = useState(true)
  const [imageUnderlayMode, setImageUnderlayMode] = useState<ImageUnderlayMode>(loadPersistedImageUnderlayMode)
  const [imageUnderlayBlur, setImageUnderlayBlur] = useState(loadPersistedImageUnderlayBlur)
  const [internalTranslationOpen, setInternalTranslationOpen] = useState(false)
  const [pagePixelWidth, setPagePixelWidth] = useState(0)
  const [proofViewportSize, setProofViewportSize] = useState({ width: 0, height: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [fontReadyVersion, setFontReadyVersion] = useState(0)
  const [pageImageNaturalSize, setPageImageNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [textSelection, setTextSelection] = useState<FacsimileTextSelection | null>(null)
  const [quoteCopying, setQuoteCopying] = useState(false)
  const layoutProfile = useMemo(() => getFacsimileLayoutProfile(ocrResult), [ocrResult])
  const effectivePreferVerticalLayout = useMemo(
    () => preferVerticalLayout || isGujiVerticalOcrResult(ocrResult),
    [ocrResult, preferVerticalLayout],
  )
  const incomingBlocks = useMemo(() => (
    splitStackedVerticalBlocks(splitWideVerticalBlocks(normalizePageOrientations(normalizeBlocks(ocrResult), effectivePreferVerticalLayout)))
  ), [effectivePreferVerticalLayout, ocrResult])
  const saveContextRef = useRef(new Map<string, {
    ocrResult: unknown
    pageProofStatus: 'completed' | 'pending'
    preferVerticalLayout: boolean
  }>())
  saveContextRef.current.set(pageId, { ocrResult, pageProofStatus, preferVerticalLayout: effectivePreferVerticalLayout })
  const buildCurrentPageOcrPayload = useCallback((nextBlocks: LayoutBlock[]) => (
    buildOcrPayload(ocrResult, nextBlocks, pageProofStatus, effectivePreferVerticalLayout)
  ), [effectivePreferVerticalLayout, ocrResult, pageProofStatus])
  const persistManualLayoutDraft = useCallback(async (savePageId: string, nextBlocks: Record<string, unknown>[]) => {
    const context = saveContextRef.current.get(savePageId)
    if (!context) throw new Error('Manual layout save context is unavailable')
    const payload = savePageId === pageId
      ? buildCurrentPageOcrPayload(nextBlocks as LayoutBlock[])
      : buildOcrPayload(
          context.ocrResult,
          nextBlocks as LayoutBlock[],
          context.pageProofStatus,
          context.preferVerticalLayout,
        )
    await Promise.resolve(onSave(
      savePageId,
      payload,
    ))
  }, [buildCurrentPageOcrPayload, onSave, pageId])
  const manualLayoutDraft = useManualLayoutDraft({
    draftIdentity,
    pageId,
    blocks: incomingBlocks,
    save: persistManualLayoutDraft,
  })
  if (saveContextRef.current.size > 4) {
    for (const savedPageId of saveContextRef.current.keys()) {
      if (saveContextRef.current.size <= 4) break
      if (savedPageId !== pageId && savedPageId !== manualLayoutDraft.state.pageId) {
        saveContextRef.current.delete(savedPageId)
      }
    }
  }
  const blocks = manualLayoutDraft.state.blocks as LayoutBlock[]
  const editingBlockId = layoutEditMode ? manualLayoutDraft.state.activeBlockId : null
  useEffect(() => {
    if (!layoutEditMode || !editingBlockId) {
      setInspectorOpen(false)
      return
    }
    setInspectorOpen(true)
  }, [editingBlockId, layoutEditMode])
  const layoutEditingLocked = manualLayoutDraft.state.discardPending
  const pageSourceText = useMemo(() => blocks.map((block) => getBlockText(block)).filter(Boolean).join('\n\n'), [blocks])
  const translationOpen = controlledTranslationOpen ?? internalTranslationOpen
  const setTranslationOpen = useCallback((open: boolean) => {
    setInternalTranslationOpen(open)
    onTranslationOpenChange?.(open)
  }, [onTranslationOpenChange])
  const schedulePageRecenter = useCallback(() => {
    if (pageRecenterFrameRef.current != null) {
      window.cancelAnimationFrame(pageRecenterFrameRef.current)
    }
    pageRecenterFrameRef.current = window.requestAnimationFrame(() => {
      pageRecenterFrameRef.current = null
      const root = rootRef.current
      if (!root) return
      root.scrollLeft = Math.max(0, Math.round((root.scrollWidth - root.clientWidth) / 2))
      root.scrollTop = 0
    })
  }, [])
  const handleTranslationOpenChange = useCallback((checked: boolean) => {
    setTranslationOpen(checked)
    if (checked && pageSourceText.trim() && !translationText.trim() && !translationLoading) {
      onTranslateCurrentPage?.(pageSourceText)
    }
  }, [onTranslateCurrentPage, pageSourceText, translationLoading, translationText])
  useEffect(() => {
    const pageAction = getPendingManualLayoutPageAction(
      manualLayoutDraft.state.draftIdentity,
      manualLayoutDraft.state.pageId,
      draftIdentity,
      pageId,
      manualLayoutDraft.state.saveState,
      pendingDraftIdentityRef.current,
    )
    if (pageAction === 'same-page') {
      pendingDraftIdentityRef.current = ''
      manualLayoutDraft.receiveServerEcho(pageId, incomingBlocks)
      return
    }
    const resetPageEditorUi = () => {
      if (!proofreaderMountedRef.current) return
      const activeInteraction = layoutInteractionRef.current
      layoutPointerFrameSchedulerRef.current?.cancel()
      if (activeInteraction && activeInteraction.kind !== 'create') {
        blocksRef.current = rollbackManualLayoutGeometryPreview(activeInteraction.preview) as LayoutBlock[]
      }
      layoutInteractionRef.current = null
      releaseCapturedLayoutPointer(activeInteraction)
      blocksRef.current = incomingBlocks
      setHistory([incomingBlocks.map((block) => ({ ...block }))])
      setHistoryIndex(0)
      setTableDraftRows([['']])
      setTableDraftMerges([])
      setTableDraftRowHeights([])
      setTableDraftColumnWidths([])
      setDraftCreateRect(null)
      setPendingCreateRect(null)
      setManualLayoutTool('select')
      setAltShowsClearUnderlay(false)
      translationRequestKeyRef.current = ''
      pendingDraftIdentityRef.current = ''
    }
    const applyPageChange = () => {
      manualLayoutDraft.changePage(pageId, draftIdentity, incomingBlocks)
      resetPageEditorUi()
    }
    const discardAndApplyPageChange = async () => {
      const appliedTarget = await manualLayoutDraft.discardAndChangePage(pageId, draftIdentity, incomingBlocks)
      if (appliedTarget?.draftIdentity === draftIdentity) {
        resetPageEditorUi()
      } else if (!appliedTarget && proofreaderMountedRef.current) {
        message.error('撤销旧页修改失败，已保留基准草稿，请重试保存')
      }
    }
    if (pageAction === 'apply-target') {
      applyPageChange()
      return
    }
    if (pageAction === 'wait-for-save') return
    pendingDraftIdentityRef.current = draftIdentity
    const confirmation = Modal.confirm({
      title: '当前页还有未保存的版式修改',
      content: '可以先保存旧页面再切换；如果直接切换，未保存的修改将被丢弃。',
      okText: '放弃修改并切换',
      okButtonProps: { danger: true },
      cancelText: '保存后切换',
      onOk: discardAndApplyPageChange,
      onCancel: async () => {
        const saved = await manualLayoutDraft.flush()
        if (!saved && proofreaderMountedRef.current) message.error('版式保存失败，旧页面草稿已保留，请重试')
      },
    })
    return () => {
      confirmation.destroy()
    }
  }, [
    draftIdentity,
    incomingBlocks,
    manualLayoutDraft.changePage,
    manualLayoutDraft.discardAndChangePage,
    manualLayoutDraft.flush,
    manualLayoutDraft.receiveServerEcho,
    manualLayoutDraft.state.draftIdentity,
    manualLayoutDraft.state.pageId,
    manualLayoutDraft.state.saveState,
    pageId,
  ])

  useEffect(() => {
    blocksRef.current = blocks
  }, [blocks])

  useEffect(() => {
    if (historyPageRef.current === manualLayoutDraft.state.pageId) return
    historyPageRef.current = manualLayoutDraft.state.pageId
    const initialHistory = (manualLayoutDraft.state.blocks as LayoutBlock[]).map((block) => ({ ...block }))
    setHistory([initialHistory])
    setHistoryIndex(0)
  }, [manualLayoutDraft.state.blocks, manualLayoutDraft.state.pageId])

  useEffect(() => {
    setIsPanning(false)
    if (wheelAnchorFrameRef.current != null) {
      window.cancelAnimationFrame(wheelAnchorFrameRef.current)
      wheelAnchorFrameRef.current = null
    }
    if (wheelZoomCommitTimerRef.current != null) {
      window.clearTimeout(wheelZoomCommitTimerRef.current)
      wheelZoomCommitTimerRef.current = null
    }
    schedulePageRecenter()
  }, [pageId, schedulePageRecenter])

  useEffect(() => {
    if (!translationOpen || !pageSourceText.trim() || translationLoading || translationSkipped || translationText.trim() || !onTranslateCurrentPage) return
    const requestKey = `${pageId}:${pageSourceText.length}:${pageSourceText.slice(0, 120)}`
    if (translationRequestKeyRef.current === requestKey) return
    translationRequestKeyRef.current = requestKey
    onTranslateCurrentPage(pageSourceText)
  }, [onTranslateCurrentPage, pageId, pageSourceText, translationLoading, translationOpen, translationSkipped, translationText])

  useEffect(() => {
    setPageImageNaturalSize(null)
    if (!pageImageSrc) return undefined
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      const width = image.naturalWidth || image.width
      const height = image.naturalHeight || image.height
      if (width > 0 && height > 0) setPageImageNaturalSize({ width, height })
    }
    image.src = pageImageSrc
    return () => {
      cancelled = true
    }
  }, [pageImageSrc, pageId])

  useEffect(() => {
    try {
      window.localStorage.setItem(FACSIMILE_FONT_SCALE_STORAGE_KEY, String(fontScale))
      window.localStorage.setItem(FACSIMILE_FONT_SCALE_STORAGE_VERSION_KEY, FACSIMILE_FONT_SCALE_STORAGE_VERSION)
    } catch {
      // Ignore storage failures.
    }
  }, [fontScale])

  useEffect(() => {
    try {
      window.localStorage.setItem(FACSIMILE_SHOW_RULES_STORAGE_KEY, String(showRules))
    } catch {
      // Ignore storage failures.
    }
  }, [showRules])

  useEffect(() => {
    try {
      window.localStorage.setItem(FACSIMILE_IMAGE_UNDERLAY_MODE_STORAGE_KEY, imageUnderlayMode)
    } catch {
      // Ignore storage failures.
    }
  }, [imageUnderlayMode])

  useEffect(() => {
    try {
      window.localStorage.setItem(FACSIMILE_IMAGE_UNDERLAY_BLUR_STORAGE_KEY, String(imageUnderlayBlur))
    } catch {
      // Ignore storage failures.
    }
  }, [imageUnderlayBlur])

  useEffect(() => {
    if (!layoutEditMode) {
      setAltShowsClearUnderlay(false)
      return undefined
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Alt') setAltShowsClearUnderlay(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt') setAltShowsClearUnderlay(false)
    }
    const restoreBlur = () => setAltShowsClearUnderlay(false)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', restoreBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', restoreBlur)
    }
  }, [layoutEditMode])

  useEffect(() => {
    if (!layoutEditingLocked) return
    const activeInteraction = layoutInteractionRef.current
    layoutPointerFrameSchedulerRef.current?.cancel()
    if (activeInteraction && activeInteraction.kind !== 'create') {
      blocksRef.current = rollbackManualLayoutGeometryPreview(activeInteraction.preview) as LayoutBlock[]
    }
    layoutInteractionRef.current = null
    releaseCapturedLayoutPointer(activeInteraction)
    setDraftCreateRect(null)
    setPendingCreateRect(null)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }, [layoutEditingLocked])

  useEffect(() => {
    let cancelled = false
    const fontSet = document.fonts
    if (!fontSet?.ready) return () => { cancelled = true }
    void fontSet.ready.then(() => {
      if (!cancelled) setFontReadyVersion((version) => version + 1)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    proofreaderMountedRef.current = true
    return () => {
      proofreaderMountedRef.current = false
      const activeInteraction = layoutInteractionRef.current
      layoutPointerFrameSchedulerRef.current?.cancel()
      if (activeInteraction && activeInteraction.kind !== 'create') {
        blocksRef.current = rollbackManualLayoutGeometryPreview(activeInteraction.preview) as LayoutBlock[]
      }
      layoutInteractionRef.current = null
      releaseCapturedLayoutPointer(activeInteraction)
      if (wheelAnchorFrameRef.current != null) window.cancelAnimationFrame(wheelAnchorFrameRef.current)
      if (wheelZoomCommitTimerRef.current != null) window.clearTimeout(wheelZoomCommitTimerRef.current)
      if (pageRecenterFrameRef.current != null) window.cancelAnimationFrame(pageRecenterFrameRef.current)
    }
  }, [])

  useEffect(() => {
    pageZoomRef.current = pageZoom
  }, [pageZoom])

  useEffect(() => {
    pageRotationRef.current = pageRotation
  }, [pageRotation])

  useEffect(() => {
    fitWidthRef.current = fitWidth
  }, [fitWidth])

  useEffect(() => {
    if (activeBoxIndex < 0) return
    const root = rootRef.current
    const activeHit = root?.querySelector<HTMLElement>('[data-search-active="true"]')
    if (activeHit) {
      activeHit.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
      return
    }
    root?.querySelector<HTMLElement>(`[data-guji-block-index="${activeBoxIndex}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
  }, [activeBoxIndex, activeSearchHitOrdinal])

  useLayoutEffect(() => {
    const target = pageRef.current
    if (!target) return undefined
    const syncWidth = () => {
      const nextWidth = Math.round(target.clientWidth || target.getBoundingClientRect().width)
      setPagePixelWidth((current) => current === nextWidth ? current : nextWidth)
    }
    syncWidth()
    const observer = new ResizeObserver(syncWidth)
    observer.observe(target)
    return () => observer.disconnect()
  }, [blocks.length, fitWidth, pageZoom])

  useLayoutEffect(() => {
    const target = rootRef.current
    if (!target) return undefined
    const syncSize = () => {
      const nextSize = { width: Math.max(0, target.clientWidth - 36), height: Math.max(0, target.clientHeight - 36) }
      setProofViewportSize((current) => current.width === nextSize.width && current.height === nextSize.height ? current : nextSize)
    }
    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(target)
    return () => observer.disconnect()
  }, [blocks.length])

  const coordinateExtent = useMemo(() => getCoordinateExtent(blocks), [blocks])
  const effectiveCoordinateSourceSize = useMemo(
    () => resolveCoordinateSourceSizeForImage(coordinateSourceSize, pageImageNaturalSize, coordinateExtent),
    [coordinateExtent, coordinateSourceSize, pageImageNaturalSize],
  )
  const baseBounds = useMemo(() => getLayoutBounds(blocks, effectiveCoordinateSourceSize), [blocks, effectiveCoordinateSourceSize])
  const hasOriginalLayoutCoordinates = useMemo(() => blocks.some((block) => block.__rect), [blocks])
  const pageBlocks = useMemo(() => hasOriginalLayoutCoordinates ? blocks : buildSyntheticRects(blocks, baseBounds), [baseBounds, blocks, hasOriginalLayoutCoordinates])
  const isSyntheticLayoutFallback = blocks.length > 0 && !hasOriginalLayoutCoordinates
  const pageVerticalMode = useMemo(() => effectivePreferVerticalLayout || isVerticalPage(pageBlocks), [effectivePreferVerticalLayout, pageBlocks])
  const autoImageUnderlay = useMemo(() => shouldUseImageUnderlay(pageBlocks, pageVerticalMode), [pageBlocks, pageVerticalMode])
  const showImageUnderlay = !!pageImageSrc && (imageUnderlayMode === 'on' || (imageUnderlayMode === 'auto' && autoImageUnderlay))
  const imageUnderlayImageStyle = useMemo(() => getManualLayoutUnderlayImageStyle({
    layoutEditMode,
    altShowsClearUnderlay,
    blur: imageUnderlayBlur,
  }), [altShowsClearUnderlay, imageUnderlayBlur, layoutEditMode])
  const bounds = useMemo(() => getLayoutBounds(pageBlocks, effectiveCoordinateSourceSize), [effectiveCoordinateSourceSize, pageBlocks])
  const pageAspect = bounds.width / Math.max(1, bounds.height)
  const fitPageWidth = useMemo(() => {
    if (!fitWidth) return FACSIMILE_BASE_PAGE_WIDTH
    const widthLimit = proofViewportSize.width > 0 ? proofViewportSize.width : 760
    const heightLimit = proofViewportSize.height > 0 ? proofViewportSize.height * pageAspect : 760
    return Math.round(Math.max(240, Math.min(760, widthLimit, heightLimit) * 0.95))
  }, [fitWidth, pageAspect, proofViewportSize.height, proofViewportSize.width])
  const pageVisualScale = fitWidth ? 1 : pageZoom
  const visualPageWidth = Math.round(fitPageWidth * pageVisualScale)
  const visualPageHeight = Math.round((fitPageWidth / Math.max(0.1, pageAspect)) * pageVisualScale)
  const rotatedQuarterTurns = pageRotation % 180 !== 0
  const visualFrameWidth = rotatedQuarterTurns ? visualPageHeight : visualPageWidth
  const visualFrameHeight = rotatedQuarterTurns ? visualPageWidth : visualPageHeight
  const canUndo = historyIndex > 0
  const getPageTransform = useCallback((zoom: number, rotation: number) => (
    `translate(-50%, -50%) rotate(${rotation}deg) scale(${zoom})`
  ), [])

  useLayoutEffect(() => {
    const frame = pageFrameRef.current
    const page = pageRef.current
    if (!frame || !page) return
    frame.style.width = `${visualFrameWidth}px`
    frame.style.height = `${visualFrameHeight}px`
    page.style.transform = getPageTransform(pageVisualScale, pageRotation)
    page.style.transformOrigin = 'center center'
    page.style.willChange = pageVisualScale === 1 && pageRotation === 0 ? '' : 'transform'
  }, [getPageTransform, pageRotation, pageVisualScale, visualFrameHeight, visualFrameWidth])

  useLayoutEffect(() => {
    schedulePageRecenter()
  }, [pageId, pageImageNaturalSize?.height, pageImageNaturalSize?.width, schedulePageRecenter])

  const translationOverlays = useMemo(() => {
    if (translationOpen && translationUnits.length > 0) {
      return buildFacsimileTranslationOverlaysFromUnits(pageBlocks, translationUnits, pageVerticalMode)
    }
    if (!translationOpen || translationLoading || translationSkipped || !translationText.trim() || !pageSourceText.trim()) return []
    return buildFacsimileTranslationOverlays(pageBlocks, pageSourceText, translationText, pageVerticalMode)
  }, [pageBlocks, pageSourceText, pageVerticalMode, translationLoading, translationOpen, translationSkipped, translationText, translationUnits])
  const hasTranslationOverlay = translationOverlays.length > 0
  const translationStatusText = translationOpen
    ? translationLoading
      ? '正在翻译...'
      : translationSkipped
        ? '本页以中文为主，已保留原文'
        : hasTranslationOverlay
          ? ''
          : translationText.trim()
            ? '正在整理版面翻译...'
            : '等待翻译结果...'
    : ''
  const pageBaseFontSize = useMemo(() => {
    const renderedWidth = pagePixelWidth || fitPageWidth || FACSIMILE_BASE_PAGE_WIDTH
    const widthScale = renderedWidth / FACSIMILE_BASE_PAGE_WIDTH
    const underlayScale = showImageUnderlay ? 0.72 : 1
    return clamp(13 * widthScale * fontScale * underlayScale, 1, 80)
  }, [fitPageWidth, fontReadyVersion, fontScale, pagePixelWidth, showImageUnderlay])
  const normalizedSearchKeyword = useMemo(() => normalizeSearchText(searchKeyword), [searchKeyword])
  const pageBlockLayouts = useMemo<FacsimileBlockRenderLayout[]>(() => pageBlocks.flatMap((block, index) => {
    const rect = block.__rect
    if (!rect) return []
    const sourceIndex = getBlockSourceIndex(block, index)
    const left = ((rect.left - bounds.offsetLeft) / bounds.width) * 100
    const top = ((rect.top - bounds.offsetTop) / bounds.height) * 100
    const width = (rect.width / bounds.width) * 100
    const height = (rect.height / bounds.height) * 100
    const label = getLabel(block)
    const labelColor = LABEL_COLORS[label] || LABEL_COLORS.text
    const labelName = LABEL_NAMES[label] || label
    const tableProjection = isTableBlock(block) ? createManualLayoutTableProjection(block, getBlockText(block)) : null
    const isTable = shouldRenderAsTableBlock(block, pageVerticalMode, tableProjection)
    const isImage = isImageLabel(label)
    const tableSnapshot = isTable ? tableProjection?.snapshot || null : null
    const tableRows = tableSnapshot?.rows || []
    const tableMerges = tableSnapshot?.merges || []
    const orientation = isTable ? 'horizontal' : inferPageAwareOrientation(block, pageVerticalMode, tableProjection)
    const originalText = !isTable && isLikelyVerticalPseudoTableBlock(block, tableProjection)
      ? getPseudoTableText(block, tableProjection)
      : getBlockText(block)
    const shouldRenderTable = isTable
    const scaledRect = pagePixelWidth > 0 ? getScaledRect(rect, bounds, pagePixelWidth) : rect
    const displayText = transformText(normalizeDisplayText(originalText, orientation, layoutProfile, label, scaledRect), displayScript)
    const fittedLayout = isImage
      ? { fontSize: pageBaseFontSize, text: displayText, overflow: false }
      : shouldRenderTable
        ? fitTableLayout(scaledRect, tableRows, pageBaseFontSize)
        : fitTextLayout(scaledRect, displayText, label, pageBaseFontSize, orientation, layoutProfile)
    const fittedDisplayText = shouldRenderTable ? displayText : fittedLayout.text
    const searchableText = shouldRenderTable ? tableRows.flat().join('\n') : fittedDisplayText
    const normalizedSearchableText = normalizeSearchText(searchableText)
    const padding = isImage ? 0 : shouldRenderTable ? 1 : getBlockPadding(label, orientation, layoutProfile)
    const verticalDisplayColumnCount = orientation === 'vertical'
      ? Math.max(1, getVerticalColumns(fittedDisplayText).length)
      : 1
    return [{
      block,
      blockId: getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, block, index),
      sourceIndex,
      rect,
      cropBounds: bounds,
      left,
      top,
      width,
      height,
      label,
      labelColor,
      labelName,
      isImage,
      tableRows,
      tableMerges,
      orientation,
      originalText,
      shouldRenderTable,
      displayText,
      fittedLayout,
      fontSize: fittedLayout.fontSize,
      fittedDisplayText,
      searchableText,
      normalizedSearchableText,
      padding,
    }]
  }), [bounds, displayScript, layoutProfile, manualLayoutDraft.state.pageId, pageBaseFontSize, pageBlocks, pagePixelWidth, pageVerticalMode])
  const translationOverlayLayouts = useMemo<FacsimileTranslationRenderLayout[]>(() => translationOverlays.map((overlay) => {
    const left = ((overlay.rect.left - bounds.offsetLeft) / bounds.width) * 100
    const top = ((overlay.rect.top - bounds.offsetTop) / bounds.height) * 100
    const width = (overlay.rect.width / bounds.width) * 100
    const height = (overlay.rect.height / bounds.height) * 100
    const labelColor = LABEL_COLORS[overlay.label] || LABEL_COLORS.text
    const scaledRect = pagePixelWidth > 0 ? getScaledRect(overlay.rect, bounds, pagePixelWidth) : overlay.rect
    const displayText = transformText(
      normalizeDisplayText(
        normalizeTranslatedTextForLayout(overlay.text, overlay.orientation),
        overlay.orientation,
        layoutProfile,
        overlay.label,
        scaledRect,
      ),
      displayScript,
    )
    const fittedLayout = fitTextLayout(scaledRect, displayText, overlay.label, pageBaseFontSize, overlay.orientation, layoutProfile)
    const normalizedSearchableText = normalizeSearchText(fittedLayout.text)
    return {
      overlay,
      left,
      top,
      width,
      height,
      labelColor,
      displayText,
      fittedLayout,
      normalizedSearchableText,
      sourceIndex: overlay.sourceIndexes[0] ?? -1,
      padding: getBlockPadding(overlay.label, overlay.orientation, layoutProfile),
      lineHeight: getBlockLineHeight(overlay.label, overlay.orientation, layoutProfile),
    }
  }), [bounds, displayScript, layoutProfile, pageBaseFontSize, pagePixelWidth, translationOverlays])
  const translatedSourceIndexes = useMemo(
    () => new Set(translationOverlays.flatMap((overlay) => overlay.sourceIndexes)),
    [translationOverlays],
  )
  const editingBlock = useMemo(() => (
    !editingBlockId
      ? null
      : blocks.find((block, index) => getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, block, index) === editingBlockId) || null
  ), [blocks, editingBlockId, manualLayoutDraft.state.pageId])
  useEffect(() => {
    if (!editingBlock || !editingBlockId) return
    if (isTableBlock(editingBlock)) {
      const snapshot = createManualLayoutTableSnapshot(editingBlock)
      setTableDraftRows(snapshot.rows)
      setTableDraftMerges(snapshot.merges)
      setTableDraftRowHeights(snapshot.rowHeights)
      setTableDraftColumnWidths(snapshot.columnWidths)
    } else {
      setTableDraftRows([['']])
      setTableDraftMerges([])
      setTableDraftRowHeights([])
      setTableDraftColumnWidths([])
    }
  }, [editingBlockId])

  const resetBlockEditor = useCallback(() => {
    manualLayoutDraft.setActiveBlockId(null)
    setTableDraftRows([['']])
    setTableDraftMerges([])
    setTableDraftRowHeights([])
    setTableDraftColumnWidths([])
  }, [manualLayoutDraft.setActiveBlockId])

  const stageTextBlockChange = useCallback((value: string) => {
    if (layoutEditingLocked) return
    if (!editingBlockId) return
    manualLayoutDraft.updateBlock(editingBlockId, {
      words: value,
    })
  }, [editingBlockId, layoutEditingLocked, manualLayoutDraft.updateBlock])

  const stageTableBlockChange = useCallback((
    rows: string[][],
    merges: FacsimileTableMerge[],
    rowHeights: number[],
    columnWidths: number[],
  ) => {
    if (layoutEditingLocked) return
    const stagedBlock = applyManualLayoutTableEditorValue(editingBlock || {}, {
      rows,
      merges,
      rowHeights,
      columnWidths,
    })
    const snapshot = createManualLayoutTableSnapshot(stagedBlock)
    setTableDraftRows(snapshot.rows)
    setTableDraftMerges(snapshot.merges)
    setTableDraftRowHeights(snapshot.rowHeights)
    setTableDraftColumnWidths(snapshot.columnWidths)
    if (!editingBlockId || !editingBlock) return
    manualLayoutDraft.updateBlock(editingBlockId, stagedBlock)
  }, [editingBlock, editingBlockId, layoutEditingLocked, manualLayoutDraft.updateBlock])

  const applyInspectorTypeChange = useCallback((nextKind: ManualLayoutBlockKind, confirmed: boolean) => {
    if (!editingBlock || !editingBlockId || layoutEditingLocked) return
    const conversion = applyManualLayoutBlockConversion(editingBlock, nextKind, confirmed)
    if (conversion.blocked) return
    let convertedBlock = conversion.block as LayoutBlock
    if (nextKind === 'table') {
      const snapshot = createManualLayoutTableSnapshot(convertedBlock, getBlockText(editingBlock))
      convertedBlock = {
        ...convertedBlock,
        rows: snapshot.rows,
        merges: snapshot.merges,
        rowHeights: snapshot.rowHeights,
        columnWidths: snapshot.columnWidths,
        words: tableRowsToPlainText(snapshot.rows),
      }
      setTableDraftRows(snapshot.rows)
      setTableDraftMerges(snapshot.merges)
      setTableDraftRowHeights(snapshot.rowHeights)
      setTableDraftColumnWidths(snapshot.columnWidths)
    } else if ((nextKind === 'image' || nextKind === 'seal') && !String(convertedBlock.caption || '').trim()) {
      convertedBlock = { ...convertedBlock, caption: getBlockText(editingBlock), alt_text: String(convertedBlock.alt_text || '') }
    }
    manualLayoutDraft.updateBlock(editingBlockId, convertedBlock)
  }, [editingBlock, editingBlockId, layoutEditingLocked, manualLayoutDraft.updateBlock])

  const handleInspectorTypeChange = useCallback((nextKind: ManualLayoutBlockKind) => {
    if (!editingBlock || !editingBlockId || layoutEditingLocked || getLabel(editingBlock) === nextKind) return
    const warning = getManualLayoutBlockConversionWarning(editingBlock, nextKind)
    if (!warning) {
      applyInspectorTypeChange(nextKind, true)
      return
    }
    Modal.confirm({
      title: `切换为${LABEL_NAMES[nextKind] || nextKind}？`,
      content: warning,
      okText: '保留数据并切换',
      cancelText: '取消',
      onOk: () => applyInspectorTypeChange(nextKind, true),
    })
  }, [applyInspectorTypeChange, editingBlock, editingBlockId, layoutEditingLocked])

  const pushHistory = useCallback((nextBlocks: LayoutBlock[]) => {
    setHistory((previous) => {
      const base = previous.slice(0, historyIndex + 1)
      base.push(nextBlocks.map((block) => ({ ...block })))
      return base.slice(-50)
    })
    setHistoryIndex((previous) => Math.min(previous + 1, 49))
  }, [historyIndex])

  const commitBlocks = useCallback((
    nextBlocks: LayoutBlock[],
    options: { activeBlockId?: string | null; selectedSourceIndex?: number } = {},
  ) => {
    if (layoutEditingLocked) return
    const nextPageVerticalMode = effectivePreferVerticalLayout || isVerticalPage(nextBlocks)
    const normalizedBlocks = nextBlocks.map((block, index) => ({
      ...block,
      reading_order: index,
      orientation: inferPageAwareOrientation(block, nextPageVerticalMode),
      orientation_source: isManualOrientationSource(block.orientation_source) ? 'manual' : block.orientation_source,
      __sourceIndex: getBlockSourceIndex(block, index),
    }))
    blocksRef.current = normalizedBlocks
    pushHistory(normalizedBlocks)
    manualLayoutDraft.replaceBlocks(normalizedBlocks, options.activeBlockId)
    if (typeof options.selectedSourceIndex === 'number') onSelectBox?.(options.selectedSourceIndex)
  }, [effectivePreferVerticalLayout, layoutEditingLocked, manualLayoutDraft.replaceBlocks, onSelectBox, pushHistory])

  const handleInspectorChange = useCallback((changes: Record<string, unknown>) => {
    if (!editingBlockId || !editingBlock || layoutEditingLocked) return
    if (Object.keys(changes).length === 1 && typeof changes.words === 'string') {
      stageTextBlockChange(changes.words)
      return
    }
    if (typeof changes.reading_order === 'number') {
      const currentIndex = blocks.findIndex((block, index) => (
        getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, block, index) === editingBlockId
      ))
      if (currentIndex < 0) return
      const targetIndex = clamp(Math.floor(changes.reading_order), 0, Math.max(0, blocks.length - 1))
      const nextBlocks = [...blocks]
      const [targetBlock] = nextBlocks.splice(currentIndex, 1)
      nextBlocks.splice(targetIndex, 0, targetBlock)
      commitBlocks(nextBlocks, { activeBlockId: editingBlockId })
      return
    }
    manualLayoutDraft.updateBlock(editingBlockId, changes)
  }, [blocks, commitBlocks, editingBlock, editingBlockId, layoutEditingLocked, manualLayoutDraft.state.pageId, manualLayoutDraft.updateBlock, stageTextBlockChange])

  const handleUndo = useCallback(() => {
    if (!canUndo || layoutEditingLocked) return
    const nextBlocks = history[historyIndex - 1].map((block) => ({ ...block }))
    setHistoryIndex(historyIndex - 1)
    blocksRef.current = nextBlocks
    manualLayoutDraft.replaceBlocks(nextBlocks, null)
    setTableDraftRows([['']])
    setTableDraftMerges([])
    setTableDraftRowHeights([])
    setTableDraftColumnWidths([])
  }, [canUndo, history, historyIndex, layoutEditingLocked, manualLayoutDraft.replaceBlocks])

  const enterLayoutEditForBlock = useCallback((sourceIndex?: number) => {
    if (layoutEditingLocked) return
    const currentBlocks = blocksRef.current
    const targetIndex = typeof sourceIndex === 'number'
      ? currentBlocks.findIndex((block, index) => getBlockSourceIndex(block, index) === sourceIndex)
      : -1
    const target = targetIndex < 0 ? undefined : currentBlocks[targetIndex]
    if (typeof sourceIndex === 'number' && (!target || isImageLabel(getLabel(target)))) return
    const preparation = getManualLayoutEditEntryPreparation()
    setImageUnderlayMode(preparation.imageUnderlayMode)
    setShowRules(preparation.showRules)
    setTranslationOpen(preparation.translationOpen)
    pageRotationRef.current = preparation.pageRotation
    setPageRotation(preparation.pageRotation)
    setManualLayoutTool(preparation.tool)
    setPendingCreateRect(null)
    setDraftCreateRect(null)
    setLayoutEditMode(preparation.layoutEditMode)
    if (!target || typeof sourceIndex !== 'number') return
    const targetBlockId = getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, target, targetIndex)
    manualLayoutDraft.setActiveBlockId(targetBlockId)
    if (isTableBlock(target)) {
      const snapshot = createManualLayoutTableSnapshot(target)
      setTableDraftRows(snapshot.rows)
      setTableDraftMerges(snapshot.merges)
      setTableDraftRowHeights(snapshot.rowHeights)
      setTableDraftColumnWidths(snapshot.columnWidths)
    } else {
      setTableDraftRows([['']])
      setTableDraftMerges([])
      setTableDraftRowHeights([])
      setTableDraftColumnWidths([])
    }
    onSelectBox?.(sourceIndex)
  }, [layoutEditingLocked, manualLayoutDraft.setActiveBlockId, manualLayoutDraft.state.pageId, onSelectBox, setTranslationOpen])

  const selectLayoutBlock = useCallback((sourceIndex: number, fallbackBlockId: string) => {
    onSelectBox?.(sourceIndex)
    if (!layoutEditMode) return
    const currentIndex = blocksRef.current.findIndex((block, index) => getBlockSourceIndex(block, index) === sourceIndex)
    const currentBlockId = currentIndex >= 0
      ? getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, blocksRef.current[currentIndex], currentIndex)
      : fallbackBlockId
    manualLayoutDraft.setActiveBlockId(currentBlockId)
  }, [layoutEditMode, manualLayoutDraft.setActiveBlockId, manualLayoutDraft.state.pageId, onSelectBox])

  const handleDeleteBlock = useCallback((blockId: string) => {
    if (layoutEditingLocked) return
    const targetIndex = blocks.findIndex((block, index) => (
      getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, block, index) === blockId
    ))
    const target = targetIndex < 0 ? undefined : blocks[targetIndex]
    if (!target) {
      message.warning('未找到要删除的文本块')
      return
    }
    const preview = getBlockText(target).replace(/\s+/g, ' ').trim().slice(0, 48)
    Modal.confirm({
      title: '删除此文本块？',
      content: preview
        ? `将从本页版式与数据库中移除该块（${preview}${preview.length >= 48 ? '…' : ''}）。可用撤销恢复本次删除。`
        : '将从本页版式与数据库中移除该块。可用撤销恢复本次删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        const nextBlocks = blocks
          .filter((block, index) => getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, block, index) !== blockId)
          .map((block, index) => ({
            ...block,
            reading_order: index,
            __sourceIndex: getBlockSourceIndex(block, index),
          }))
        if (nextBlocks.length === blocks.length) return
        const reindexedActive = nextBlocks.length === 0
          ? -1
          : getBlockSourceIndex(nextBlocks[Math.min(targetIndex, nextBlocks.length - 1)], Math.min(targetIndex, nextBlocks.length - 1))
        commitBlocks(nextBlocks, { activeBlockId: editingBlockId === blockId ? null : undefined, selectedSourceIndex: reindexedActive >= 0 ? reindexedActive : undefined })
        if (editingBlockId === blockId) resetBlockEditor()
        if (reindexedActive < 0) onSelectBox?.(-1)
        message.success('已删除文本块，正在后台保存')
      },
    })
  }, [blocks, commitBlocks, editingBlockId, layoutEditingLocked, manualLayoutDraft.state.pageId, onSelectBox, resetBlockEditor])

  const handleToggleBlockOrientation = useCallback((blockId: string) => {
    if (layoutEditingLocked) return
    const pageVerticalModeForToggle = effectivePreferVerticalLayout || isVerticalPage(blocks)
    const targetIndex = blocks.findIndex((block, index) => (
      getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, block, index) === blockId
    ))
    const nextBlocks = blocks.map((block, index) => {
      if (getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, block, index) !== blockId) return block
      const currentOrientation = inferPageAwareOrientation(block, pageVerticalModeForToggle)
      const sourceOrientation = block.source_orientation === 'vertical' || block.source_orientation === 'horizontal'
        ? block.source_orientation
        : getOrientationValue(block) || currentOrientation
      return ensureManualLayoutBlockIdentity(manualLayoutDraft.state.pageId, {
        ...block,
        orientation: currentOrientation === 'vertical' ? 'horizontal' : 'vertical',
        orientation_source: 'manual',
        source_orientation: sourceOrientation,
        source_orientation_source: block.source_orientation_source || 'ocr',
        segmentation_source: 'manual',
      }, index, true) as LayoutBlock
    })
    const nextBlockId = targetIndex >= 0
      ? getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, nextBlocks[targetIndex], targetIndex)
      : null
    commitBlocks(nextBlocks, { activeBlockId: editingBlockId === blockId ? nextBlockId : undefined })
  }, [blocks, commitBlocks, editingBlockId, effectivePreferVerticalLayout, layoutEditingLocked, manualLayoutDraft.state.pageId])

  const getPointerCoordinate = useCallback((clientX: number, clientY: number) => {
    const page = pageRef.current
    if (!page) return null
    const rect = page.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: bounds.offsetLeft + clamp((clientX - rect.left) / rect.width, 0, 1) * bounds.width,
      y: bounds.offsetTop + clamp((clientY - rect.top) / rect.height, 0, 1) * bounds.height,
    }
  }, [bounds.height, bounds.offsetLeft, bounds.offsetTop, bounds.width])

  const geometryBounds = useMemo(() => ({
    left: bounds.offsetLeft,
    top: bounds.offsetTop,
    width: bounds.width,
    height: bounds.height,
  }), [bounds.height, bounds.offsetLeft, bounds.offsetTop, bounds.width])
  const geometryMinimum = useMemo(() => ({
    width: Math.max(8, bounds.width * 0.008),
    height: Math.max(8, bounds.height * 0.008),
  }), [bounds.height, bounds.width])

  const createTypedManualBlock = useCallback((kind: ManualLayoutBlockKind, sourceRect: BlockRect) => {
    if (layoutEditingLocked) return
    const rect = clampManualLayoutBlockRect(normalizeManualLayoutBlockRect(sourceRect), geometryBounds, geometryMinimum)
    const sourceIndex = blocksRef.current.reduce((maximum, block, index) => (
      Math.max(maximum, getBlockSourceIndex(block, index))
    ), -1) + 1
    const orientation = pageVerticalMode ? 'vertical' : 'horizontal'
    const tableRows = kind === 'table' ? [['']] : undefined
    const nextBlock = ensureManualLayoutBlockIdentity(manualLayoutDraft.state.pageId, {
      words: '',
      label: kind,
      type: kind,
      block_type: kind,
      reading_order: blocksRef.current.length,
      orientation,
      orientation_source: 'manual',
      source_orientation: orientation,
      source_orientation_source: 'manual',
      segmentation_source: 'manual',
      location: rect,
      rows: tableRows,
      merges: tableRows ? [] : undefined,
      rowHeights: tableRows ? normalizeFacsimileTableRowHeights([], tableRows.length) : undefined,
      columnWidths: tableRows ? normalizeFacsimileTableColumnWidths([], tableRows[0]?.length || 1) : undefined,
      caption: kind === 'image' || kind === 'seal' ? '' : undefined,
      alt_text: kind === 'image' || kind === 'seal' ? '' : undefined,
      __rect: rect,
      __synthetic: false,
      __sourceIndex: sourceIndex,
    }, blocksRef.current.length, true) as LayoutBlock
    const nextBlocks = [...blocksRef.current, nextBlock]
    blocksRef.current = nextBlocks
    pushHistory(nextBlocks)
    manualLayoutDraft.createBlock(nextBlock)
    setTableDraftRows(tableRows || [['']])
    setTableDraftMerges([])
    setTableDraftRowHeights(tableRows ? normalizeFacsimileTableRowHeights([], tableRows.length) : [])
    setTableDraftColumnWidths(tableRows ? normalizeFacsimileTableColumnWidths([], tableRows[0]?.length || 1) : [])
    setPendingCreateRect(null)
    setManualLayoutTool((current) => reduceManualLayoutTool(current, { type: 'created' }))
    onSelectBox?.(sourceIndex)
  }, [geometryBounds, geometryMinimum, layoutEditingLocked, manualLayoutDraft.createBlock, manualLayoutDraft.state.pageId, onSelectBox, pageVerticalMode, pushHistory])

  const startBlockInteraction = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    sourceIndex: number,
    rect: BlockRect,
    handle?: ManualLayoutResizeHandle,
  ) => {
    if (!layoutEditMode || layoutEditingLocked || event.button !== 0) return
    const point = getPointerCoordinate(event.clientX, event.clientY)
    if (!point) return
    const targetIndex = blocksRef.current.findIndex((block, index) => getBlockSourceIndex(block, index) === sourceIndex)
    if (targetIndex < 0) return
    event.preventDefault()
    event.stopPropagation()
    layoutPointerFrameSchedulerRef.current?.cancel()
    setPendingCreateRect(null)
    const baselineBlocks = blocksRef.current
    const baselineBlock = baselineBlocks[targetIndex]
    const baselineBlockId = getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, baselineBlock, targetIndex)
    if (manualLayoutTool !== 'select') {
      manualLayoutDraft.setActiveBlockId(baselineBlockId)
      onSelectBox?.(sourceIndex)
      return
    }
    const identifiedBlock = ensureManualLayoutBlockIdentity(
      manualLayoutDraft.state.pageId,
      baselineBlock,
      targetIndex,
      true,
    ) as LayoutBlock
    const nextBlockId = getManualLayoutDraftBlockId(manualLayoutDraft.state.pageId, identifiedBlock, targetIndex)
    const nextBlocks = baselineBlocks.map((block, index) => index === targetIndex ? identifiedBlock : block)
    blocksRef.current = nextBlocks
    manualLayoutDraft.previewBlocks(nextBlocks)
    manualLayoutDraft.setActiveBlockId(nextBlockId)
    onSelectBox?.(sourceIndex)
    const captureTarget = event.currentTarget
    captureTarget.setPointerCapture(event.pointerId)
    layoutInteractionRef.current = {
      kind: handle ? 'resize' : 'move',
      pointerId: event.pointerId,
      captureTarget,
      blockId: nextBlockId,
      baselineBlockId,
      sourceIndex,
      handle,
      start: point,
      startRect: { ...rect },
      preview: createManualLayoutGeometryPreview(nextBlocks, nextBlockId, baselineBlocks),
      changed: false,
    }
  }, [getPointerCoordinate, layoutEditMode, layoutEditingLocked, manualLayoutDraft.previewBlocks, manualLayoutDraft.setActiveBlockId, manualLayoutDraft.state.pageId, manualLayoutTool, onSelectBox])

  const handlePageLayoutPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!layoutEditMode || layoutEditingLocked || event.button !== 0) return
    if (event.target instanceof HTMLElement && event.target.closest('[data-guji-block-index],button,input,textarea,[data-manual-layout-type-picker]')) return
    const point = getPointerCoordinate(event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    layoutPointerFrameSchedulerRef.current?.cancel()
    setPendingCreateRect(null)
    manualLayoutDraft.setActiveBlockId(null)
    const captureTarget = event.currentTarget
    captureTarget.setPointerCapture(event.pointerId)
    layoutInteractionRef.current = {
      kind: 'create',
      pointerId: event.pointerId,
      captureTarget,
      tool: manualLayoutTool,
      start: point,
      current: point,
    }
    setDraftCreateRect({ left: point.x, top: point.y, width: 0, height: 0 })
    onSelectBox?.(-1)
  }, [getPointerCoordinate, layoutEditMode, layoutEditingLocked, manualLayoutDraft.setActiveBlockId, manualLayoutTool, onSelectBox])

  const cancelLayoutInteraction = useCallback(() => {
    layoutPointerFrameSchedulerRef.current?.cancel()
    const interaction = layoutInteractionRef.current
    if (!interaction) {
      setDraftCreateRect(null)
      setPendingCreateRect(null)
      return
    }
    layoutInteractionRef.current = null
    releaseCapturedLayoutPointer(interaction)
    setDraftCreateRect(null)
    if (interaction.kind === 'create') return
    const restoredBlocks = rollbackManualLayoutGeometryPreview(interaction.preview) as LayoutBlock[]
    blocksRef.current = restoredBlocks
    manualLayoutDraft.clearPreview()
    manualLayoutDraft.setActiveBlockId(interaction.baselineBlockId)
  }, [manualLayoutDraft.clearPreview, manualLayoutDraft.setActiveBlockId])

  const applyLayoutPointerFrame = useCallback((frame: LayoutPointerFrame) => {
    const interaction = layoutInteractionRef.current
    if (!interaction || interaction.pointerId !== frame.pointerId) return
    const point = getPointerCoordinate(frame.clientX, frame.clientY)
    if (!point) return
    if (interaction.kind === 'create') {
      interaction.current = point
      setDraftCreateRect(clampManualLayoutBlockRect(
        rectFromPointerPoints(interaction.start, point),
        geometryBounds,
        geometryMinimum,
      ))
      return
    }
    const deltaX = point.x - interaction.start.x
    const deltaY = point.y - interaction.start.y
    const nextRect = interaction.kind === 'move'
      ? moveManualLayoutBlockRect(interaction.startRect, deltaX, deltaY, geometryBounds, geometryMinimum)
      : resizeManualLayoutBlockRect(
          interaction.startRect,
          interaction.handle || 'se',
          deltaX,
          deltaY,
          geometryBounds,
          geometryMinimum,
        )
    interaction.preview = updateManualLayoutGeometryPreview(interaction.preview, nextRect)
    interaction.changed = interaction.changed || Math.abs(deltaX) > 0.01 || Math.abs(deltaY) > 0.01
    const nextBlocks = interaction.preview.blocks as LayoutBlock[]
    blocksRef.current = nextBlocks
    manualLayoutDraft.previewBlocks(nextBlocks)
  }, [geometryBounds, geometryMinimum, getPointerCoordinate, manualLayoutDraft.previewBlocks])

  applyLayoutPointerFrameRef.current = applyLayoutPointerFrame

  const handlePageLayoutPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = layoutInteractionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    layoutPointerFrameSchedulerRef.current?.schedule({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    })
  }, [])

  const handlePageLayoutPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (layoutInteractionRef.current?.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    layoutPointerFrameSchedulerRef.current?.schedule({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    })
    layoutPointerFrameSchedulerRef.current?.flush()
    const interaction = layoutInteractionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    layoutInteractionRef.current = null
    releaseCapturedLayoutPointer(interaction)
    if (interaction.kind === 'create') {
      const rect = clampManualLayoutBlockRect(
        rectFromPointerPoints(interaction.start, interaction.current),
        geometryBounds,
        geometryMinimum,
      )
      setDraftCreateRect(null)
      if (rect.width < bounds.width * 0.012 || rect.height < bounds.height * 0.012) return
      if (interaction.tool === 'select') {
        setPendingCreateRect(rect)
        return
      }
      createTypedManualBlock(interaction.tool, rect)
      return
    }
    if (!interaction.changed) {
      const restoredBlocks = rollbackManualLayoutGeometryPreview(interaction.preview) as LayoutBlock[]
      blocksRef.current = restoredBlocks
      manualLayoutDraft.clearPreview()
      manualLayoutDraft.setActiveBlockId(interaction.baselineBlockId)
      return
    }
    const committedBlocks = commitManualLayoutGeometryPreview(interaction.preview) as LayoutBlock[]
    blocksRef.current = committedBlocks
    commitBlocks(committedBlocks, {
      activeBlockId: interaction.blockId,
      selectedSourceIndex: interaction.sourceIndex,
    })
  }, [bounds.height, bounds.width, commitBlocks, createTypedManualBlock, geometryBounds, geometryMinimum, manualLayoutDraft.clearPreview, manualLayoutDraft.setActiveBlockId])

  const handlePageLayoutPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = layoutInteractionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    event.preventDefault()
    cancelLayoutInteraction()
  }, [cancelLayoutInteraction])

  const handlePageLayoutLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = layoutInteractionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    cancelLayoutInteraction()
  }, [cancelLayoutInteraction])

  const toggleLayoutEditMode = useCallback(() => {
    if (layoutEditingLocked) return
    if (!layoutEditMode) {
      enterLayoutEditForBlock()
      return
    }
    const finishEditing = () => {
      if (!proofreaderMountedRef.current) return
      cancelLayoutInteraction()
      setDraftCreateRect(null)
      setPendingCreateRect(null)
      setManualLayoutTool('select')
      setAltShowsClearUnderlay(false)
      setLayoutEditMode(false)
    }
    const saveAndFinish = async () => {
      const saved = await manualLayoutDraft.flush()
      if (saved) {
        finishEditing()
        return
      }
      if (proofreaderMountedRef.current) message.error('版式保存失败，草稿仍保留在当前页面')
      throw new Error('Manual layout save failed')
    }
    if (manualLayoutDraft.state.saveState === 'clean') {
      finishEditing()
      return
    }
    Modal.confirm({
      title: '保存版式修改后退出？',
      content: manualLayoutDraft.state.saveState === 'failed'
        ? '上一次保存失败，草稿仍然保留。请重试保存后再退出编辑模式。'
        : '当前页面还有未保存的版式修改。',
      okText: '保存并退出',
      cancelText: '继续编辑',
      onOk: saveAndFinish,
    })
  }, [cancelLayoutInteraction, enterLayoutEditForBlock, layoutEditMode, layoutEditingLocked, manualLayoutDraft.flush, manualLayoutDraft.state.saveState])

  useEffect(() => {
    if (editingBlockId && !editingBlock) {
      manualLayoutDraft.setActiveBlockId(null)
    }
  }, [editingBlock, editingBlockId, manualLayoutDraft.setActiveBlockId])

  useEffect(() => {
    if (!layoutEditMode || layoutEditingLocked) return undefined
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const targetIsEditor = event.target instanceof HTMLElement && !!event.target.closest('input,textarea,[role="gridcell"]')
        if (!layoutInteractionRef.current && !pendingCreateRect && manualLayoutTool === 'select' && targetIsEditor) return
        event.preventDefault()
        cancelLayoutInteraction()
        setManualLayoutTool((current) => reduceManualLayoutTool(current, { type: 'escape' }))
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void manualLayoutDraft.flush().then((saved) => {
        if (!saved && proofreaderMountedRef.current) message.error('版式保存失败，草稿已保留')
      })
    }
    window.addEventListener('keydown', handleSaveShortcut, true)
    return () => window.removeEventListener('keydown', handleSaveShortcut, true)
  }, [cancelLayoutInteraction, layoutEditMode, layoutEditingLocked, manualLayoutDraft.flush, manualLayoutTool, pendingCreateRect])

  const citationPageNum = useMemo(() => {
    const literature = Number(literaturePageNum || 0)
    if (Number.isFinite(literature) && literature > 0) return Math.floor(literature)
    const physical = Number(pageNum || 0)
    return Number.isFinite(physical) && physical > 0 ? Math.floor(physical) : null
  }, [literaturePageNum, pageNum])

  const resolveCitationText = useCallback(async (): Promise<string> => {
    const fallback = `${documentTitle || '未命名文献'}${citationPageNum ? `，第 ${citationPageNum} 页` : ''}`
    const docId = String(documentId || '').trim()
    if (!docId) return fallback
    try {
      return await resolveDocumentCitation(docId, {
        docType: documentType,
        pageNum: citationPageNum,
      }) || fallback
    } catch (error) {
      console.warn('Failed to generate facsimile citation from active style, falling back to simple citation.', error)
      return fallback
    }
  }, [citationPageNum, documentId, documentTitle, documentType])

  const copyPlainSelection = useCallback(async (text: string) => {
    const selected = String(text || '').trim()
    if (!selected) {
      message.info('请先选择需要复制的文本')
      return
    }
    try {
      await navigator.clipboard.writeText(selected)
      message.success('已复制原文')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '复制失败'))
    }
  }, [])

  const copyDirectQuote = useCallback(async (text: string) => {
    const selected = String(text || '').replace(/\s+/g, ' ').trim()
    if (!selected) {
      message.info('请先选择需要引用的文本')
      return
    }
    setQuoteCopying(true)
    try {
      const citationText = await resolveCitationText()
      const quote = buildDirectQuoteCitationText(selected, citationText)
      await navigator.clipboard.writeText(quote)
      message.success('已复制直接引用')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '复制直接引用失败'))
    } finally {
      setQuoteCopying(false)
    }
  }, [resolveCitationText])

  const captureSelection = useCallback(() => {
    const selection = window.getSelection()
    const selected = selection?.toString().replace(/\u00a0/g, ' ').trim() || ''
    if (!selected || !selection?.rangeCount) {
      setTextSelection(null)
      onTextSelectionChange?.('')
      return
    }
    const range = selection.getRangeAt(0)
    const root = rootRef.current
    const anchorNode = range.commonAncestorContainer
    const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode.parentElement
    if (root && anchorElement && !root.contains(anchorElement)) {
      setTextSelection(null)
      return
    }
    const rect = range.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setTextSelection(null)
      onTextSelectionChange?.(selected)
      return
    }
    setTextSelection({
      text: selected,
      x: rect.left + rect.width / 2,
      y: Math.max(12, rect.top - 42),
    })
    onTextSelectionChange?.(selected)
  }, [onTextSelectionChange])

  // Clear floating selection UI when page changes.
  useEffect(() => {
    setTextSelection(null)
  }, [pageId])

  const applyPageZoomDom = useCallback((zoom: number) => {
    const frame = pageFrameRef.current
    const page = pageRef.current
    if (!frame || !page) return
    const layoutWidth = Math.max(1, page.clientWidth || page.getBoundingClientRect().width || fitPageWidth || FACSIMILE_BASE_PAGE_WIDTH)
    const visualWidth = Math.round(FACSIMILE_BASE_PAGE_WIDTH * zoom)
    const visualHeight = Math.round(visualWidth / Math.max(0.1, pageAspect))
    const rotated = pageRotationRef.current % 180 !== 0
    const visualScale = visualWidth / layoutWidth
    frame.style.width = `${rotated ? visualHeight : visualWidth}px`
    frame.style.height = `${rotated ? visualWidth : visualHeight}px`
    page.style.transform = getPageTransform(visualScale, pageRotationRef.current)
    page.style.transformOrigin = 'center center'
    page.style.willChange = visualScale === 1 ? '' : 'transform'
  }, [fitPageWidth, getPageTransform, pageAspect])

  const rotatePage = useCallback(() => {
    const nextRotation = (pageRotationRef.current + 90) % 360
    pageRotationRef.current = nextRotation
    setPageRotation(nextRotation)
    if (fitWidthRef.current) return
    applyPageZoomDom(pageZoomRef.current)
  }, [applyPageZoomDom])

  const handleCanvasWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('button,input,textarea,.ant-slider,.ant-switch')) return
    event.preventDefault()
    const root = rootRef.current
    const frame = pageFrameRef.current
    const page = pageRef.current
    if (!root || !frame || !page) return
    const rootRect = root.getBoundingClientRect()
    const pageRect = frame.getBoundingClientRect()
    const anchorX = pageRect.width > 0 ? (event.clientX - pageRect.left) / pageRect.width : 0.5
    const anchorY = pageRect.height > 0 ? (event.clientY - pageRect.top) / pageRect.height : 0.5
    const viewportX = event.clientX - rootRect.left
    const viewportY = event.clientY - rootRect.top
    const baseZoom = fitWidthRef.current ? pageRect.width / FACSIMILE_BASE_PAGE_WIDTH : pageZoomRef.current
    const nextZoom = clampZoom(baseZoom * (event.deltaY > 0 ? 0.9 : 1.1))
    pageZoomRef.current = nextZoom
    fitWidthRef.current = false
    applyPageZoomDom(nextZoom)
    if (wheelAnchorFrameRef.current != null) window.cancelAnimationFrame(wheelAnchorFrameRef.current)
    wheelAnchorFrameRef.current = window.requestAnimationFrame(() => {
      wheelAnchorFrameRef.current = null
      const nextPage = pageRef.current
      const nextFrame = pageFrameRef.current
      const nextRoot = rootRef.current
      if (!nextPage || !nextFrame || !nextRoot) return
      nextRoot.scrollLeft = Math.max(0, nextFrame.offsetLeft + anchorX * nextFrame.offsetWidth - viewportX)
      nextRoot.scrollTop = Math.max(0, nextFrame.offsetTop + anchorY * nextFrame.offsetHeight - viewportY)
    })
    if (wheelZoomCommitTimerRef.current != null) window.clearTimeout(wheelZoomCommitTimerRef.current)
    wheelZoomCommitTimerRef.current = window.setTimeout(() => {
      wheelZoomCommitTimerRef.current = null
      setFitWidth(false)
      setPageZoom(pageZoomRef.current)
    }, 120)
  }, [applyPageZoomDom])

  const handleCanvasMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || shouldIgnoreCanvasDrag(event.target)) return
    const root = rootRef.current
    if (!root) return
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, y: event.clientY, scrollLeft: root.scrollLeft, scrollTop: root.scrollTop }
    setIsPanning(true)
  }, [])

  useEffect(() => {
    if (!isPanning) return undefined
    const handleMove = (event: MouseEvent) => {
      const root = rootRef.current
      if (!root) return
      root.scrollLeft = dragStartRef.current.scrollLeft - (event.clientX - dragStartRef.current.x)
      root.scrollTop = dragStartRef.current.scrollTop - (event.clientY - dragStartRef.current.y)
    }
    const handleUp = () => setIsPanning(false)
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [isPanning])

  const displaySettingsContent = (
    <div style={{ width: 278 }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>栏线</span>
          <Switch size="small" checked={showRules} onChange={setShowRules} checkedChildren={<ColumnWidthOutlined />} unCheckedChildren={<ColumnWidthOutlined />} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>底图</span>
          <Segmented
            size="small"
            block
            value={imageUnderlayMode}
            onChange={(value) => setImageUnderlayMode(value as ImageUnderlayMode)}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'on', label: '开启' },
              { value: 'off', label: '关闭' },
            ]}
          />
        </div>
        {showImageUnderlay ? (
          <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 32px', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>模糊</span>
            <Slider
              min={0}
              max={100}
              step={1}
              value={imageUnderlayBlur}
              onChange={(value) => setImageUnderlayBlur(normalizeImageUnderlayBlur(Number(value)))}
              style={{ margin: 0 }}
            />
            <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12, textAlign: 'right' }}>{imageUnderlayBlur}</span>
          </div>
        ) : null}
      </Space>
    </div>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }}>
      {textSelection ? (
        <div
          className="reader-selection-toolbar"
          style={{ left: textSelection.x, top: textSelection.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Button
            className="reader-selection-icon-button"
            size="small"
            icon={<CopyOutlined />}
            title="复制原文"
            onClick={() => void copyPlainSelection(textSelection.text)}
          />
          <Button
            className="reader-selection-icon-button"
            size="small"
            icon={<FormOutlined />}
            title="复制直接引用（Ctrl+D）"
            loading={quoteCopying}
            onClick={() => void copyDirectQuote(textSelection.text)}
          />
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <Space size={8} wrap>
          <Segmented size="small" value={displayScript} onChange={(value) => setDisplayScript(value as ProofDisplayScript)} options={[{ value: 'original', label: '原文' }, { value: 'simplified', label: '简' }, { value: 'traditional', label: '繁' }]} />
          <Space size={4}>
            <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>字体</span>
            <Button size="small" icon={<MinusOutlined />} disabled={fontScale <= FACSIMILE_FONT_SCALE_MIN} onClick={() => setFontScale((value) => normalizeFontScale(value - FACSIMILE_FONT_SCALE_STEP))} />
            <InputNumber size="small" controls={false} min={Math.round(FACSIMILE_FONT_SCALE_MIN * 100)} max={Math.round(FACSIMILE_FONT_SCALE_MAX * 100)} step={1} value={Math.round(fontScale * 100)} formatter={(value) => `${value || 100}%`} parser={(value) => Number(String(value || '').replace(/[^\d.]/g, ''))} onChange={(value) => setFontScale(normalizeFontScale(Number(value || 100) / 100))} style={{ width: 76 }} />
            <Button size="small" icon={<PlusOutlined />} disabled={fontScale >= FACSIMILE_FONT_SCALE_MAX} onClick={() => setFontScale((value) => normalizeFontScale(value + FACSIMILE_FONT_SCALE_STEP))} />
          </Space>
          <Switch size="small" checked={fitWidth} onChange={setFitWidth} checkedChildren="适宽" unCheckedChildren="缩放" />
          <Button size="small" icon={<RotateRightOutlined />} disabled={layoutEditMode} onClick={rotatePage}>
            旋转
          </Button>
          <Space size={6}>
            <Switch
              size="small"
              data-reader-translation-toggle="true"
              checked={translationOpen}
              disabled={!pageSourceText.trim() && !translationOpen}
              loading={translationLoading}
              onChange={handleTranslationOpenChange}
            />
            <span style={{ color: translationOpen ? '#d6a85f' : 'var(--gs-text-secondary)', fontSize: 12 }}>翻译模式</span>
            {translationOpen ? (
              <>
                <Segmented
                  size="small"
                  value={translationMode}
                  onChange={(value) => onTranslationModeChange?.(value as TranslationMode)}
                  options={[
                    { value: 'fast', label: '快速' },
                    { value: 'balanced', label: '均衡' },
                    { value: 'quality', label: '高质量' },
                  ]}
                />
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  disabled={!pageSourceText.trim() || translationLoading}
                  onClick={() => onRetranslateCurrentPage?.(pageSourceText)}
                >
                  重译本页
                </Button>
              </>
            ) : null}
            {translationStatusText ? (
              <span data-facsimile-translation-status="true" style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
                {translationStatusText}
              </span>
            ) : null}
          </Space>
          <Popover trigger="click" placement="bottomLeft" title="显示设置" content={displaySettingsContent}>
            <Button size="small" icon={<SettingOutlined />}>显示设置</Button>
          </Popover>
          <Button size="small" type={layoutEditMode ? 'primary' : 'default'} icon={<EditOutlined />} disabled={layoutEditingLocked} onClick={toggleLayoutEditMode}>
            {layoutEditMode ? '完成版式编辑' : '编辑版式'}
          </Button>
          {layoutEditMode || manualLayoutDraft.state.saveState !== 'clean' ? (
            <>
              <Tag
                color={manualLayoutDraft.state.saveState === 'failed'
                  ? 'error'
                  : manualLayoutDraft.state.saveState === 'clean'
                    ? 'success'
                    : manualLayoutDraft.state.saveState === 'saving'
                      ? 'processing'
                      : 'warning'}
                style={{ marginInlineEnd: 0 }}
              >
                {layoutEditingLocked
                  ? '正在撤销修改'
                  : manualLayoutDraft.state.saveState === 'failed'
                  ? '保存失败'
                  : manualLayoutDraft.state.saveState === 'clean'
                    ? '已保存'
                    : manualLayoutDraft.state.saveState === 'saving'
                      ? '保存中'
                      : '未保存'}
              </Tag>
              {manualLayoutDraft.state.saveState === 'failed' ? (
                <Button size="small" danger icon={<ReloadOutlined />} onClick={manualLayoutDraft.retry}>重试</Button>
              ) : null}
            </>
          ) : null}
          {layoutEditMode ? <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>{layoutEditingLocked ? '正在等待旧保存结束并恢复数据库基准，编辑已暂时锁定' : '空白处拖拽新建；拖动框移动或缩放；Alt 临时看清底图；Ctrl+S 立即保存'}</span> : null}
        </Space>
        <Button size="small" icon={<UndoOutlined />} disabled={!canUndo || layoutEditingLocked} onClick={handleUndo}>撤销</Button>
      </div>

      {layoutEditMode ? (
        <ManualLayoutToolbar
          tool={manualLayoutTool}
          disabled={layoutEditingLocked}
          onToolChange={(tool) => {
            cancelLayoutInteraction()
            setPendingCreateRect(null)
            setManualLayoutTool(tool)
          }}
        />
      ) : null}
      <div className={`manual-layout-editor-workspace${layoutEditMode ? ' is-editing' : ''}`}>
      <div
        ref={rootRef}
        className="manual-layout-editor-canvas"
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onWheel={handleCanvasWheel}
        onMouseDown={handleCanvasMouseDown}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#d4dbea', borderRadius: 6, padding: 18, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', cursor: layoutEditMode ? 'default' : isPanning ? 'grabbing' : 'grab', userSelect: isPanning || layoutEditMode ? 'none' : undefined }}
      >
        <div ref={pageFrameRef} style={{ width: `${visualFrameWidth}px`, height: `${visualFrameHeight}px`, position: 'relative', flexShrink: 0 }}>
        <div
          ref={pageRef}
          aria-busy={layoutEditingLocked}
          onPointerDown={handlePageLayoutPointerDown}
          onPointerMove={handlePageLayoutPointerMove}
          onPointerUp={handlePageLayoutPointerUp}
          onPointerCancel={handlePageLayoutPointerCancel}
          onLostPointerCapture={handlePageLayoutLostPointerCapture}
          style={{ width: `${fitPageWidth}px`, aspectRatio: `${pageAspect}`, minWidth: fitWidth ? 420 : undefined, maxWidth: fitWidth ? 760 : undefined, position: 'absolute', left: '50%', top: '50%', background: '#fffdf7', color: '#24190f', boxShadow: '0 16px 36px rgba(33, 27, 18, 0.22)', border: '2px solid #21170f', outline: '5px solid #fffdf7', fontFamily: FONT_FAMILY, flexShrink: 0, containerType: 'inline-size', transform: getPageTransform(pageVisualScale, pageRotation), transformOrigin: 'center center', willChange: pageVisualScale === 1 && pageRotation === 0 ? undefined : 'transform', overflow: 'hidden', cursor: layoutEditingLocked ? 'wait' : layoutEditMode ? 'crosshair' : undefined, pointerEvents: layoutEditingLocked ? 'none' : undefined, touchAction: layoutEditMode ? 'none' : undefined }}
        >
          {showImageUnderlay ? (
            <img
              src={pageImageSrc}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'fill',
                ...imageUnderlayImageStyle,
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            />
          ) : null}
          {blocks.length === 0 ? (
            <div
              data-manual-layout-empty-state="true"
              style={{
                position: 'absolute',
                inset: '10% 8%',
                zIndex: 20,
                display: 'grid',
                placeItems: 'center',
                padding: 24,
                color: '#7b6040',
                background: pageImageSrc ? 'rgba(255, 253, 247, 0.74)' : 'rgba(255, 253, 247, 0.96)',
                border: '1px dashed rgba(123, 96, 64, 0.48)',
                textAlign: 'center',
                lineHeight: 1.7,
                pointerEvents: 'none',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{pageImageSrc ? '本页暂未识别出 OCR 区块' : '这是一个空白编辑页'}</div>
                <div>{layoutEditMode ? '请在页面空白处拖动，创建文本、表格、图片或注释区块。' : '点击“编辑版式”，即可在页面上手动创建文本、表格、图片或注释区块。'}</div>
              </div>
            </div>
          ) : null}
          <div style={{ position: 'absolute', inset: '1.2%', border: showImageUnderlay ? '1px solid rgba(45,33,21,0.35)' : '1px solid #2d2115', pointerEvents: 'none' }} />
          {draftCreateRect ? (
            <div
              style={{
                position: 'absolute',
                left: `${((draftCreateRect.left - bounds.offsetLeft) / bounds.width) * 100}%`,
                top: `${((draftCreateRect.top - bounds.offsetTop) / bounds.height) * 100}%`,
                width: `${(draftCreateRect.width / bounds.width) * 100}%`,
                height: `${(draftCreateRect.height / bounds.height) * 100}%`,
                border: '2px dashed #1677ff',
                background: 'rgba(22,119,255,0.12)',
                boxSizing: 'border-box',
                zIndex: 120,
                pointerEvents: 'none',
              }}
            />
          ) : null}
          {pendingCreateRect ? (
            <div
              data-manual-layout-type-picker="true"
              style={{
                position: 'absolute',
                left: `${clamp(((pendingCreateRect.left - bounds.offsetLeft) / bounds.width) * 100, 1, 66)}%`,
                top: `${clamp(((pendingCreateRect.top + pendingCreateRect.height - bounds.offsetTop) / bounds.height) * 100 + 0.8, 1, 88)}%`,
                zIndex: 150,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: 5,
                borderRadius: 7,
                background: 'rgba(20, 20, 20, 0.94)',
                boxShadow: '0 10px 26px rgba(0,0,0,0.3)',
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {(['text', 'note', 'table', 'image'] as const).map((kind) => (
                <Button key={kind} size="small" type={kind === 'text' ? 'primary' : 'default'} onClick={() => createTypedManualBlock(kind, pendingCreateRect)}>
                  {LABEL_NAMES[kind] || kind}
                </Button>
              ))}
              <Dropdown
                trigger={['click']}
                menu={{
                  items: (['title', 'paragraph_title', 'abstract', 'reference', 'header', 'footer', 'number', 'seal'] as const).map((kind) => ({
                    key: kind,
                    label: LABEL_NAMES[kind] || kind,
                    onClick: () => createTypedManualBlock(kind, pendingCreateRect),
                  })),
                }}
              >
                <Button size="small">更多</Button>
              </Dropdown>
              <Button size="small" type="text" style={{ color: '#fff' }} onClick={() => setPendingCreateRect(null)}>取消</Button>
            </div>
          ) : null}
          {translationStatusText ? (
            <div
              style={{
                position: 'absolute',
                top: '2.2%',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 30,
                padding: '4px 10px',
                borderRadius: 6,
                background: 'rgba(36, 25, 15, 0.82)',
                color: '#fff8e8',
                fontSize: 12,
                boxShadow: '0 8px 22px rgba(0,0,0,0.18)',
                pointerEvents: 'none',
              }}
            >
              {translationStatusText}
            </div>
          ) : null}
          {isSyntheticLayoutFallback ? (
            <div
              data-facsimile-missing-layout-warning="true"
              style={{
                position: 'absolute',
                left: '50%',
                top: 20,
                transform: 'translateX(-50%)',
                zIndex: 60,
                maxWidth: 'calc(100% - 28px)',
                padding: '7px 12px',
                borderRadius: 6,
                background: 'rgba(36, 25, 15, 0.88)',
                color: '#fff8e8',
                fontSize: 12,
                lineHeight: 1.5,
                boxShadow: '0 8px 22px rgba(0,0,0,0.18)',
                pointerEvents: 'none',
              }}
            >
              当前 OCR 缺少版式坐标，已切换为临时文本排布；请重新 OCR 本页或修复数据库外置大字段后再使用按位置还原。
            </div>
          ) : null}
          {pageBlockLayouts.map((layout) => {
            const {
              block,
              blockId,
              sourceIndex,
              rect,
              left,
              top,
              width,
              height,
              label,
              labelColor,
              labelName,
              isImage,
              tableRows,
              tableMerges,
              orientation,
              originalText,
              shouldRenderTable,
              fittedLayout,
              fontSize,
              fittedDisplayText,
              normalizedSearchableText,
              padding,
              cropBounds,
            } = layout
            const shouldUseOverlayTranslation = translationOpen && translatedSourceIndexes.has(sourceIndex) && !isImage
            const hasOverflow = fittedLayout.overflow
            const { editingActive: isEditingActive, parentHighlighted } = getManualLayoutBlockVisualState(
              blockId,
              editingBlockId,
              sourceIndex,
              activeBoxIndex,
            )
            const isActive = isEditingActive || parentHighlighted
            const keywordMatch = !!normalizedSearchKeyword && normalizedSearchableText.includes(normalizedSearchKeyword)
            const isEditing = isEditingActive
            const ruleBorder = shouldRenderTable ? { border: showRules ? '1px solid rgba(64,48,32,0.34)' : undefined } : getBlockBorderStyle(orientation, showRules)
            const shouldShowOverflowHint = hasOverflow && isActive && !isEditing && !isImage
            const shouldHideBlockContent = shouldUseOverlayTranslation && !isImage
            const overflowInset = shouldShowOverflowHint ? 'inset 0 -16px 14px -14px rgba(180, 92, 20, 0.82)' : undefined
            const blockBoxShadow = isEditingActive
              ? ['inset 0 0 0 2px #1677ff', overflowInset].filter(Boolean).join(', ')
              : parentHighlighted
                ? ['inset 0 0 0 2px #52c41a', overflowInset].filter(Boolean).join(', ')
              : keywordMatch
                ? ['inset 0 0 0 2px #d48806', overflowInset].filter(Boolean).join(', ')
                : overflowInset
            const toolbarAlignRight = left > 58
            const toolbarEdgeStyle = toolbarAlignRight
              ? { right: `${Math.max(0.6, 100 - left - width)}%` }
              : { left: `${Math.max(0.6, left)}%` }
            const blockLineHeight = getBlockLineHeight(label, orientation, layoutProfile)
            const preserveVerticalColumns = orientation === 'vertical' && shouldPreserveVerticalColumns(label)
            const verticalColumnCount = orientation === 'vertical'
              ? Math.max(1, getVerticalColumns(fittedDisplayText).length)
              : 1
            const textWhiteSpace = orientation === 'vertical' ? (verticalColumnCount > 1 || preserveVerticalColumns ? 'pre' : 'normal') : 'pre-wrap'
            const textWordBreak = orientation === 'vertical' || isTocLabel(label) ? 'normal' : 'break-all'
            const textOverflowWrap = orientation === 'vertical' || isTocLabel(label) ? 'normal' : 'anywhere'

            return (
              <Fragment key={`${sourceIndex}-${block.reading_order ?? sourceIndex}`}>
                {!layoutEditMode && (isActive || isEditing) ? (
                  <div
                    style={{
                      position: 'absolute',
                      top: `${Math.max(0.6, top + 0.35)}%`,
                      ...toolbarEdgeStyle,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      zIndex: 90,
                      maxWidth: 'min(320px, calc(100% - 8px))',
                      padding: '2px 4px',
                      borderRadius: 6,
                      background: 'rgba(18, 18, 18, 0.92)',
                      boxShadow: '0 8px 22px rgba(34, 24, 14, 0.22)',
                      border: '1px solid rgba(255, 255, 255, 0.16)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    {!isEditing && !shouldRenderTable && !isImage ? (
                      <Button
                        size="small"
                        title={orientation === 'vertical' ? '改横排' : '改竖排'}
                        aria-label={orientation === 'vertical' ? '改横排' : '改竖排'}
                        onClick={(event) => {
                          event.stopPropagation()
                          handleToggleBlockOrientation(blockId)
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <span>{orientation === 'vertical' ? '改横排' : '改竖排'}</span>
                          <RotateRightOutlined style={{ fontSize: 12 }} />
                        </span>
                      </Button>
                    ) : (
                      <Tag color={orientation === 'vertical' ? 'purple' : 'geekblue'} style={{ marginInlineEnd: 0, flexShrink: 0 }}>{orientation === 'vertical' ? '竖排' : '横排'}</Tag>
                    )}
                    {!isEditing && originalText.trim() ? (
                      <Button
                        size="small"
                        icon={<CopyOutlined />}
                        title="复制本块原文"
                        aria-label="复制本块原文"
                        onClick={(event) => {
                          event.stopPropagation()
                          void copyPlainSelection(originalText)
                        }}
                      />
                    ) : null}
                    {!isEditing && originalText.trim() ? (
                      <Button
                        size="small"
                        icon={<FormOutlined />}
                        title="复制直接引用（Ctrl+D）"
                        aria-label="复制直接引用"
                        loading={quoteCopying}
                        onClick={(event) => {
                          event.stopPropagation()
                          void copyDirectQuote(originalText)
                        }}
                      />
                    ) : null}
                    {!isEditing ? <Button size="small" icon={<EditOutlined />} title={shouldRenderTable ? '编辑表格' : '编辑文字'} aria-label={shouldRenderTable ? '编辑表格' : '编辑文字'} onClick={(event) => { event.stopPropagation(); enterLayoutEditForBlock(sourceIndex) }} /> : null}
                    {!isEditing ? (
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        title="删除此文本块"
                        aria-label="删除此文本块"
                        onClick={(event) => {
                          event.stopPropagation()
                          handleDeleteBlock(blockId)
                        }}
                      />
                    ) : null}
                  </div>
                ) : null}
              <Dropdown
                trigger={['contextMenu']}
                menu={{
                  items: [
                    {
                      key: 'edit',
                      icon: <EditOutlined />,
                      label: shouldRenderTable ? '编辑表格' : '编辑文字',
                      disabled: isEditing || isImage,
                      onClick: () => enterLayoutEditForBlock(sourceIndex),
                    },
                    {
                      key: 'copy',
                      icon: <CopyOutlined />,
                      label: '复制本块原文',
                      disabled: !originalText.trim(),
                      onClick: () => { void copyPlainSelection(originalText) },
                    },
                    {
                      key: 'quote',
                      icon: <FormOutlined />,
                      label: '复制直接引用',
                      disabled: !originalText.trim(),
                      onClick: () => { void copyDirectQuote(originalText) },
                    },
                    { type: 'divider' },
                    {
                      key: 'delete',
                      icon: <DeleteOutlined />,
                      label: '删除此文本块',
                      danger: true,
                      onClick: () => handleDeleteBlock(blockId),
                    },
                  ] satisfies MenuProps['items'],
                }}
              >
              <div
                data-guji-block-index={sourceIndex}
                onClick={(event) => { event.stopPropagation(); selectLayoutBlock(sourceIndex, blockId) }}
                onDoubleClick={(event) => { event.stopPropagation(); enterLayoutEditForBlock(sourceIndex) }}
                onContextMenu={() => selectLayoutBlock(sourceIndex, blockId)}
                onPointerDown={(event) => startBlockInteraction(event, sourceIndex, rect)}
                style={{ position: 'absolute', left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%`, boxSizing: 'border-box', ...ruleBorder, border: layoutEditMode ? (isEditingActive ? '2px solid #1677ff' : parentHighlighted ? '1px solid #52c41a' : '1px dashed rgba(22,119,255,0.72)') : ruleBorder.border, boxShadow: blockBoxShadow || undefined, background: isEditingActive ? 'rgba(22,119,255,0.08)' : parentHighlighted ? 'rgba(82,196,26,0.08)' : keywordMatch ? 'rgba(250,219,20,0.14)' : layoutEditMode ? 'rgba(255,255,255,0.18)' : 'transparent', color: label === 'seal' ? '#b42318' : labelColor, cursor: layoutEditMode ? (isEditingActive ? 'move' : 'pointer') : 'text', overflow: 'hidden', padding, zIndex: isEditingActive ? 10 : parentHighlighted ? 9 : keywordMatch ? 8 : isDecorativeLabel(label) ? 2 : 4, userSelect: layoutEditMode ? 'none' : 'text' }}
              >
                {shouldHideBlockContent ? null : isImage ? (
                  <FacsimileImageBlock assetPath={getBlockImagePath(block)} pageImageSrc={pageImageSrc} rect={rect} bounds={cropBounds} />
                ) : shouldRenderTable ? (
                  <div style={{ width: '100%', height: '100%', overflow: 'hidden', fontSize, lineHeight: 1.18, fontFamily: FONT_FAMILY }}>
                    {renderFacsimileTable(tableRows, tableMerges, searchKeyword, keywordMatch, parentHighlighted ? activeSearchHitOrdinal : -1)}
                  </div>
                ) : (
                  <div style={{ width: '100%', height: '100%', writingMode: orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb', textOrientation: orientation === 'vertical' ? 'mixed' : undefined, whiteSpace: textWhiteSpace, wordBreak: textWordBreak, overflowWrap: textOverflowWrap, lineHeight: blockLineHeight, fontSize, fontWeight: getBlockFontWeight(label, layoutProfile), letterSpacing: 0, textAlign: isTitleLabel(label) ? 'center' : 'start', textIndent: orientation === 'horizontal' && isBodyTextLabel(label) ? '2em' : undefined }}>
                    {renderFormattedText(fittedDisplayText, searchKeyword, keywordMatch, parentHighlighted ? activeSearchHitOrdinal : -1)}
                  </div>
                )}
                {shouldShowOverflowHint ? (
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 14, pointerEvents: 'none', background: 'linear-gradient(to bottom, rgba(255,253,247,0), rgba(255,253,247,0.92))' }} />
                ) : null}
                {layoutEditMode && isEditingActive ? BLOCK_RESIZE_HANDLES.map((item) => (
                  <span
                    key={item.handle}
                    role="presentation"
                    onPointerDown={(event) => startBlockInteraction(event, sourceIndex, rect, item.handle)}
                    style={{
                      position: 'absolute',
                      left: `${item.left}%`,
                      top: `${item.top}%`,
                      width: 10,
                      height: 10,
                      transform: 'translate(-50%, -50%)',
                      borderRadius: 2,
                      border: '1px solid #fff',
                      background: '#1677ff',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
                      cursor: item.cursor,
                      zIndex: 130,
                    }}
                  />
                )) : null}
              </div>
              </Dropdown>
              </Fragment>
            )
          })}
          {translationOpen && translationOverlayLayouts.map((layout) => {
            const {
              overlay,
              left,
              top,
              width,
              height,
              labelColor,
              fittedLayout,
              sourceIndex,
              padding,
              lineHeight,
              normalizedSearchableText,
            } = layout
            const isActive = sourceIndex >= 0 && overlay.sourceIndexes.includes(activeBoxIndex)
            const keywordMatch = !!normalizedSearchKeyword && normalizedSearchableText.includes(normalizedSearchKeyword)

            return (
              <div
                key={overlay.id}
                data-facsimile-translation-overlay="true"
                data-translation-source-indexes={overlay.sourceIndexes.join(',')}
                onClick={(event) => { event.stopPropagation(); if (sourceIndex >= 0) onSelectBox?.(sourceIndex) }}
                style={{
                  position: 'absolute',
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                  boxSizing: 'border-box',
                  border: showRules ? '1px solid rgba(45, 33, 21, 0.18)' : undefined,
                  boxShadow: isActive
                    ? 'inset 0 0 0 2px #1677ff'
                    : keywordMatch
                      ? 'inset 0 0 0 2px #d48806'
                      : undefined,
                  background: isActive
                    ? 'rgba(235, 246, 255, 0.1)'
                    : keywordMatch
                      ? 'rgba(255, 248, 204, 0.14)'
                      : 'transparent',
                  color: labelColor,
                  cursor: 'text',
                  overflow: 'hidden',
                  padding,
                  zIndex: isActive ? 18 : keywordMatch ? 16 : 12,
                  userSelect: 'text',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    writingMode: overlay.orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
                    textOrientation: overlay.orientation === 'vertical' ? 'mixed' : undefined,
                    whiteSpace: 'pre-wrap',
                    wordBreak: isTocLabel(overlay.label) ? 'normal' : 'break-all',
                    overflowWrap: isTocLabel(overlay.label) ? 'normal' : 'anywhere',
                    lineHeight,
                    fontSize: fittedLayout.fontSize,
                    fontWeight: getBlockFontWeight(overlay.label, layoutProfile),
                    letterSpacing: 0,
                    textAlign: isTitleLabel(overlay.label) ? 'center' : 'start',
                    textIndent: overlay.orientation === 'horizontal' && isBodyTextLabel(overlay.label) ? '2em' : undefined,
                    userSelect: 'text',
                  }}
                >
                  {renderFormattedText(fittedLayout.text, searchKeyword, keywordMatch, isActive ? activeSearchHitOrdinal : -1)}
                </div>
              </div>
            )
          })}
          <div style={{ position: 'absolute', right: '2%', bottom: '1.2%', color: '#8a7662', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, pointerEvents: 'none' }}>
            <CheckOutlined />
            {pageProofStatus === 'completed' ? '已校' : '待校'}
          </div>
        </div>
        </div>
      </div>
      {layoutEditMode ? (
        <div className={`manual-block-inspector-floating${inspectorOpen ? ' is-open' : ''}`}>
          <Button
            className="manual-block-inspector-toggle"
            size="small"
            type={inspectorOpen ? 'primary' : 'default'}
            icon={<SettingOutlined />}
            aria-expanded={inspectorOpen}
            aria-label={inspectorOpen ? '收起区块属性' : '打开区块属性'}
            onClick={() => setInspectorOpen((value) => !value)}
          >
            {inspectorOpen ? '收起属性' : '区块属性'}
          </Button>
          {inspectorOpen ? (
            <div className="manual-block-inspector-floating-surface">
              <ManualBlockInspector
                pageId={pageId}
                coordinateSourceSize={effectiveCoordinateSourceSize}
                pageImageNaturalSize={pageImageNaturalSize}
                blockId={editingBlockId}
                block={editingBlock}
                disabled={layoutEditingLocked}
                tableRows={tableDraftRows}
                tableMerges={tableDraftMerges}
                tableRowHeights={tableDraftRowHeights}
                tableColumnWidths={tableDraftColumnWidths}
                onChange={handleInspectorChange}
                onTableChange={(value) => stageTableBlockChange(
                  value.rows,
                  value.merges,
                  value.rowHeights,
                  value.columnWidths,
                )}
                onTypeChange={handleInspectorTypeChange}
                onDelete={() => editingBlockId && handleDeleteBlock(editingBlockId)}
                onDeselect={resetBlockEditor}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  )
}
