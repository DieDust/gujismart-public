import { Children, cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { lazy, Suspense } from 'react'
import { Button, Dropdown, Empty, Input, Modal, Pagination, Popover, Radio, Select, Segmented, Slider, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import { useLayoutEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import OpenCC from 'opencc-js'
import type { MenuProps } from 'antd'
import {
  ArrowLeftOutlined,
  BarsOutlined,
  BookOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  ExportOutlined,
  FileImageOutlined,
  FolderOpenOutlined,
  FontSizeOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  RobotOutlined,
  ScanOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { ViewerViewport } from '../components/ImageViewer'
import GujiFacsimileProofreader, { getFacsimileTranslationSourceText, isFacsimileProofCandidate } from '../components/GujiFacsimileProofreader'
import EbookReader, { isManagedTextDocument } from '../components/EbookReader'
import {
  isParallelTranslationDisplayReady,
  projectParallelTranslationTextToSource,
} from '@shared/parallel-translation'
import { releaseCachedPdfDocument, renderPdfFilePageToImage } from '../utils/pdf'
import { ensurePdfPageImagesForOcr as ensureOcrPageImages, isReadablePageImagePath } from '../utils/ocrPageImages'
import { extractPageText, getCitationPageNumber, getOcrBlockText, getOrderedOcrBlocks, getReadablePageElements, getReadablePageText, getTextFlowOcrBlocks, normalizeOcrTextForReading, type ReadablePageElement } from '../utils/ocrText'
import { clampAiButtonPosition, clampFloatingPanelState, getDefaultFloatingPanelState } from '../utils/floatingViewport'
import { hasShortcutBlockingOverlay, isEditableShortcutTarget, loadShortcutSettings, SHORTCUTS_CHANGED_EVENT, shortcutMatches, type ShortcutMap } from '../utils/shortcuts'
import { buildDirectQuoteCitationText, resolveDocumentCitation } from '../utils/citations'
import { findSearchOccurrences, uniqueSearchTerms } from '../utils/searchHitCount'
import { getErrorMessage } from '@shared/errors'
import {
  DEFAULT_TRANSLATION_STYLE,
  buildTranslationCacheKey,
  normalizeTranslationSourceText,
} from '@shared/translation-cache'
import { getCanonicalPageTranslationSourceText } from '@shared/translation-source'
import { shouldTranslatePageText } from '@shared/translation-text'
import { getOrBuildOcrPageIr, getOcrPageIr, getOcrRegionRerecognitionCandidates } from '@shared/ocr-ir'
import { getManualBlockId, parseManualLayoutLocationKey } from '@shared/manual-layout'
import { DEFAULT_HIGHLIGHT_COLOR } from '../utils/highlightColors'
import { LIBRARY_RELATIONS_CHANGED_EVENT } from '../utils/libraryEvents'
import { toLocalResourceUrl } from '../utils/localResource'
import { isDocumentPagePayloadHydrated, retainDocumentPagePayloadWindow } from '../utils/documentPageRetention'
import { findFirstSearchHitAtOrAfterPage, findSearchOccurrenceContainer, findSearchOccurrenceIndexNearChar } from '../utils/readerSearchNavigation'
import type { DocumentDetail, DocumentExportFormat, DocumentExportOptions, DocumentLightDetail, DocumentPage, DocumentUpdatePayload, ExportPageNumberMode, LlmProviderProfile, LlmProviderProfileState, ManualPageInsertRequest, OcrEngine, OcrRecognizeLayoutBlock, OcrRecognizeResult, OpenDocumentTarget, PageOcrVersion, PageTranslationCacheItem, PageTranslationProgressEvent, PageUpdatePayload, ReaderState, ReaderStateSavePayload, ReaderTranslationOptions, ReaderTranslationPayload, ReaderTranslationPriority, ResearchProject, SearchHit, SearchHitLocator, SearchSessionState, StableReaderLocator, TranslationGlossaryScope, TranslationMode, TranslationUnitV1, VectorSearchHit } from '@shared/types'

const { Title, Text } = Typography
const AiPanel = lazy(() => import('../components/AiPanel'))
const ImageViewer = lazy(() => import('../components/ImageViewer'))
const MetadataEditor = lazy(() => import('../components/MetadataEditor'))
const PageBirdseyeGrid = lazy(() => import('../components/PageBirdseyeGrid'))
const SourcePageReader = lazy(() => import('../components/SourcePageReader'))
const TextEditor = lazy(() => import('../components/TextEditor'))

function DocumentLazyFallback() {
  return (
    <div style={{ height: '100%', minHeight: 220, display: 'grid', placeItems: 'center' }}>
      <Spin />
    </div>
  )
}

const LLM_PROFILE_SYNC_EVENT = 'gujismart:llm-profile-changed'
const FACSIMILE_FONT_SCALE_STORAGE_KEY = 'gujismart.facsimileProof.fontScale'
const FACSIMILE_FONT_SCALE_DEFAULT = 1.1
const FACSIMILE_FONT_SCALE_MIN = 0.5
const FACSIMILE_FONT_SCALE_MAX = 1.35
const READER_DISPLAY_SCRIPT_STORAGE_KEY = 'gujismart.reader.displayScript'
const READER_GLOBAL_PREFERENCES_SETTING_KEY = 'reader_global_preferences'
const SOURCE_PAGE_READER_RESET_VIEW_EVENT = 'gujismart:source-page-reader-reset-view'
const READER_SEARCH_RESULT_PAGE_SIZE = 10
const READER_FULL_PAGE_RETENTION_RADIUS = 12
const PROOF_PAGE_WINDOW_RADIUS = 1
const PROOF_IMAGE_PREFETCH_DELAY_MS = 260
const PROOF_IMAGE_PREFETCH_OFFSETS = [1, -1]
const PROOF_IMAGE_PREWARM_DELAY_MS = 650
const PROOF_IMAGE_PREWARM_WINDOW_RADIUS = 2
const EMPTY_SEARCH_HITS: SearchSessionState['hits'] = []
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })

interface DocumentViewProps {
  documentId: string
  initialPageIndex?: number
  searchKeyword?: string
  sourceId?: string
  locator?: SearchHitLocator
  stableLocator?: StableReaderLocator
  searchSession?: SearchSessionState
  revealToc?: boolean
  highlightExcerpt?: string
  highlightColor?: string
  sourceLabel?: string
  startReaderBookTranslation?: boolean
  openTranslation?: boolean
  onBack: () => void
  onOpenDocument?: (target: OpenDocumentTarget) => void
  compactHeader?: boolean
}

function getOcrQualityIssueLabel(code: string): string {
  const labels: Record<string, string> = {
    empty_text: '存在空文本块',
    missing_coordinates: '部分文本缺少坐标',
    low_confidence: '存在低置信度文本',
    invalid_unicode: '存在异常字符',
    suspicious_repetition: '存在疑似重复识别',
    reading_order_gap: '阅读顺序不连续',
    fallback_used: '使用了回退结果',
    needs_enhancement: '存在需要局部增强的文本块',
    discarded_content: '已分离页眉页脚等非正文内容',
  }
  return labels[code] || code
}

type ReaderTranslationQueueItem = ReaderTranslationPayload & {
  priority: ReaderTranslationPriority
  generation: number
  force?: boolean
}

function getReaderTranslationKey(payload: Pick<ReaderTranslationPayload, 'pageId' | 'readerPageKey'>): string {
  return String(payload.readerPageKey || payload.pageId || '')
}

function getReaderTranslationCachePageId(payload: Pick<ReaderTranslationPayload, 'pageId' | 'cachePageId'>): string {
  return String(payload.cachePageId || payload.pageId || '')
}

type PageViewMode = 'single' | 'bird'
type BirdDensity = 'small' | 'medium' | 'large'
type ReaderTheme = 'paper' | 'sepia' | 'dark'
type ReaderDisplayScript = 'original' | 'simplified' | 'traditional'
type ReaderViewMode = 'single' | 'spread'
type ReaderSidebarTab = 'toc' | 'search'
type DocumentMode = 'read' | 'proof'
type ProofViewMode = 'facsimile' | 'text'
type ReaderTocItem = { pageIndex: number; pageNum: number; title: string; level: number }
type JsonRecord = Record<string, unknown>
type DocumentViewDocument = DocumentDetail
type DocumentViewPage = DocumentPage
type NormalizableDocumentPage = Partial<DocumentPage> & Pick<DocumentPage, 'id' | 'doc_id' | 'page_num' | 'image_path' | 'ocr_status' | 'proof_status' | 'created_at'> & {
  has_ocr_result?: boolean | number
}
type TranslationSourcePage = Partial<DocumentPage> & { text?: string | null }
type TranslatablePage = TranslationSourcePage & { id: string; sourcePageNum?: number }
type TranslationCacheMatch = { row: PageTranslationCacheItem; sourceHash: string; translationText?: string }
type ParallelReaderTranslationRequest = {
  pageId: string
  cachePageId?: string
  pageNum: number
  sourceText: string
  force?: boolean
  isStale?: () => boolean
}
type DragTimer = ReturnType<typeof window.setTimeout> | 0
type LlmProfileSyncDetail = Partial<LlmProviderProfileState> | null | undefined
type FacsimileLayoutBlock = OcrRecognizeLayoutBlock & JsonRecord & {
  raw_words?: unknown
  block_type?: unknown
  category?: unknown
  orientation?: unknown
  rect?: unknown
  points?: unknown
  block_bbox?: unknown
  bbox?: unknown
  coordinate?: unknown
  coordinate_box?: unknown
  box?: unknown
  poly?: unknown
  polygon?: unknown
  needs_enhancement?: unknown
}
type FacsimileOcrResult = OcrRecognizeResult & JsonRecord & {
  base_ocr_result?: unknown
  guji_processing?: JsonRecord
  raw_layout_result?: FacsimileLayoutBlock[]
  layout_result?: FacsimileLayoutBlock[]
  words_result?: FacsimileLayoutBlock[]
  image_width?: unknown
  image_height?: unknown
  page_width?: unknown
  page_height?: unknown
}
type ReaderPage = {
  id: string
  sourcePageIndex: number
  sourcePageNum: number
  /** Printed / literature page for display (same as citation / TXT export). */
  literaturePageNum: number
  sourcePageId?: string
  sourceStartChar: number
  sourceEndChar: number
  segmentIndex: number
  text: string
  elements?: ReadablePageElement[]
  sourcePage?: DocumentViewPage
}
type ReaderThemeStyle = { shell: string; page: string; text: string; muted: string; border: string }
type SearchMatch = {
  pageIndex: number
  boxIndex: number
  textFlowIndex?: number
  charIndex: number
  boxTop: number
  boxLeft: number
  keyword: string
  hitIndex?: number
  boxOccurrenceIndex?: number
  locator?: SearchHitLocator
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMaybeJson(value: unknown): JsonRecord | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return isJsonRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isJsonRecord(value) ? value : null
}

function readRecordValue(source: unknown, key: string): unknown {
  return isJsonRecord(source) ? source[key] : undefined
}

function getNumericRecordValue(source: unknown, key: string): number | null {
  const value = readRecordValue(source, key)
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function getNestedNumericRecordValue(source: unknown, path: string[]): number | null {
  let current = source
  for (const key of path) {
    current = readRecordValue(current, key)
    if (current === undefined || current === null) return null
  }
  const numberValue = Number(current)
  return Number.isFinite(numberValue) ? numberValue : null
}

function getOcrCoordinateSourceSize(ocrResult: unknown): { width?: number | null; height?: number | null; preserveServiceCoordinates?: boolean } {
  const parsed = parseMaybeJson(ocrResult)
  const gujiProcessing = readRecordValue(parsed, 'guji_processing')
  const preserveServiceCoordinates = readRecordValue(gujiProcessing, 'ocr_service_coordinates_preserved') === true
  const irPage = readRecordValue(readRecordValue(parsed, 'gujismart_ir'), 'page')
  const width = preserveServiceCoordinates
    ? getNumericRecordValue(parsed, 'page_width')
      ?? getNumericRecordValue(parsed, 'image_width')
      ?? getNumericRecordValue(parsed, 'source_image_width')
      ?? getNumericRecordValue(gujiProcessing, 'source_image_width')
    : getNumericRecordValue(gujiProcessing, 'source_image_width')
      ?? getNumericRecordValue(parsed, 'source_image_width')
      ?? getNumericRecordValue(parsed, 'image_width')
      ?? getNumericRecordValue(parsed, 'page_width')
      ?? getNumericRecordValue(irPage, 'width')
      ?? getNestedNumericRecordValue(parsed, ['normalization', 'page_width'])
  const height = preserveServiceCoordinates
    ? getNumericRecordValue(parsed, 'page_height')
      ?? getNumericRecordValue(parsed, 'image_height')
      ?? getNumericRecordValue(parsed, 'source_image_height')
      ?? getNumericRecordValue(gujiProcessing, 'source_image_height')
    : getNumericRecordValue(gujiProcessing, 'source_image_height')
      ?? getNumericRecordValue(parsed, 'source_image_height')
      ?? getNumericRecordValue(parsed, 'image_height')
      ?? getNumericRecordValue(parsed, 'page_height')
      ?? getNumericRecordValue(irPage, 'height')
      ?? getNestedNumericRecordValue(parsed, ['normalization', 'page_height'])
  return {
    width,
    height,
    preserveServiceCoordinates,
  }
}

function isReaderViewMode(value: unknown): value is ReaderViewMode {
  return value === 'single' || value === 'spread'
}

function isReaderTheme(value: unknown): value is ReaderTheme {
  return value === 'paper' || value === 'sepia' || value === 'dark'
}

function isReaderDisplayScript(value: unknown): value is ReaderDisplayScript {
  return value === 'original' || value === 'simplified' || value === 'traditional'
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.max(min, Math.min(max, numberValue))
}

function readReaderViewMode(value: unknown): ReaderViewMode | null {
  return isReaderViewMode(value) ? value : null
}

function readReaderTheme(value: unknown): ReaderTheme | null {
  return isReaderTheme(value) ? value : null
}

function readReaderDisplayScript(value: unknown): ReaderDisplayScript | null {
  return isReaderDisplayScript(value) ? value : null
}

function parseReaderGlobalPreferences(value: unknown): ReaderGlobalPreferences {
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : isJsonRecord(value) ? value : null
  const viewMode = readReaderViewMode(readRecordValue(parsed, 'view_mode'))
  const theme = readReaderTheme(readRecordValue(parsed, 'theme'))
  const displayScript = readReaderDisplayScript(readRecordValue(parsed, 'display_script'))
  return {
    view_mode: viewMode || DEFAULT_READER_GLOBAL_PREFERENCES.view_mode,
    font_family: typeof readRecordValue(parsed, 'font_family') === 'string' && String(readRecordValue(parsed, 'font_family')).trim()
      ? String(readRecordValue(parsed, 'font_family'))
      : DEFAULT_READER_GLOBAL_PREFERENCES.font_family,
    font_size: clampNumber(readRecordValue(parsed, 'font_size'), DEFAULT_READER_GLOBAL_PREFERENCES.font_size, 13, 26),
    line_height: clampNumber(readRecordValue(parsed, 'line_height'), DEFAULT_READER_GLOBAL_PREFERENCES.line_height, 1.3, 2.4),
    page_width: clampNumber(readRecordValue(parsed, 'page_width'), DEFAULT_READER_GLOBAL_PREFERENCES.page_width, 380, 680),
    theme: theme || DEFAULT_READER_GLOBAL_PREFERENCES.theme,
    display_script: displayScript || DEFAULT_READER_GLOBAL_PREFERENCES.display_script,
  }
}

function looksLikeMetadataMojibake(value: string): boolean {
  const text = String(value || '').trim()
  if (!text) return false
  if (/[�锟]/.test(text)) return true
  if (/[\u00c0-\u00ff]{2,}/.test(text)) return true
  if (/(?:[鍔鏈璇鏂瀵鐢鍙榛鍏浠搴鐗浣璁鑷杞閫闈閲鎻]){2,}/.test(text)) return true
  const rareNoiseMatches = text.match(/[鑾闔囚峴閲皆閭闢闗]/g) || []
  if (rareNoiseMatches.length >= 2) return true
  return /(?:鑾|闔|峴).*(?:囚|皆|閲)|(?:囚|皆|閲).*(?:鑾|闔|峴)/.test(text)
}

function getDisplayMetadataText(value?: string | null, options?: { hideOther?: boolean }): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^(unknown|null|undefined|none|n\/a|-)+$/i.test(raw)) return null
  if (options?.hideOther && raw === '其他') return null
  if (looksLikeMetadataMojibake(raw)) return null
  return raw
}

function getDisplayDocType(value?: string | null, fallback = '未知类型'): string {
  return getDisplayMetadataText(value, { hideOther: true }) || fallback
}

function asFacsimileOcrResult(value: unknown): FacsimileOcrResult | null {
  const parsed = parseMaybeJson(value)
  return parsed ? parsed as FacsimileOcrResult : null
}

function asFacsimileBlocks(value: unknown): FacsimileLayoutBlock[] {
  return Array.isArray(value) ? value.filter(isJsonRecord).map((block) => block as FacsimileLayoutBlock) : []
}

function getPointCoordinate(point: unknown, axis: 'x' | 'y'): number {
  const raw = isJsonRecord(point)
    ? point[axis]
    : Array.isArray(point)
      ? point[axis === 'x' ? 0 : 1]
      : undefined
  return Number(raw)
}

function getBoxLocation(box: FacsimileLayoutBlock): unknown {
  return box.location || box.rect || box.points || box.block_bbox || box.bbox || box.box || box.coordinate || box.coordinate_box || box.poly || box.polygon
}

function normalizeDocumentPage(page: NormalizableDocumentPage): DocumentPage {
  const literaturePageNum = Number((page as { literature_page_num?: number | null }).literature_page_num || 0)
  const ocrPageLabel = Number((page as { ocr_page_label?: number | null }).ocr_page_label || 0)
  return {
    id: page.id,
    doc_id: page.doc_id,
    page_num: page.page_num,
    image_path: page.image_path ?? null,
    ocr_text: page.ocr_text ?? null,
    ocr_result: page.ocr_result ?? null,
    proofed_text: page.proofed_text ?? null,
    ocr_status: page.ocr_status,
    proof_status: page.proof_status,
    created_at: page.created_at,
    // Keep printed-page calibration fields — dropping them made UI fall back to physical 1..N
    // even after applyLiteraturePageAnchor succeeded in the database.
    literature_page_num: Number.isFinite(literaturePageNum) && literaturePageNum > 0
      ? Math.floor(literaturePageNum)
      : ((page as { literature_page_num?: number | null }).literature_page_num ?? null),
    literature_page_source: (page as { literature_page_source?: string | null }).literature_page_source ?? null,
    ocr_page_label: Number.isFinite(ocrPageLabel) && ocrPageLabel > 0
      ? Math.floor(ocrPageLabel)
      : ((page as { ocr_page_label?: number | null }).ocr_page_label ?? null),
    has_ocr_text: page.has_ocr_text ?? (page.has_ocr_result ? true : undefined),
    needs_layout_attention: page.needs_layout_attention,
    has_text: page.has_text,
    __full: page.__full,
    __light: page.__light,
    __search_text_only: page.__search_text_only,
  }
}

function isDocumentPageForDoc(page: Partial<DocumentPage> | null | undefined, docId: string): boolean {
  return !!page?.id && String(page.doc_id || '') === docId
}

function normalizeDocumentDetail(data: DocumentDetail | DocumentLightDetail | null, expectedDocId?: string): DocumentViewDocument | null {
  if (!data) return null
  const docId = String(data.id || '')
  if (expectedDocId && docId !== expectedDocId) return null
  return {
    ...data,
    pages: data.pages
      .filter((page) => isDocumentPageForDoc(page, docId))
      .map(normalizeDocumentPage),
  }
}

function clampPageIndex(index: number, pageCount: number) {
  if (pageCount <= 0) return 0
  return Math.max(0, Math.min(pageCount - 1, index))
}

function getFinitePageIndex(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const next = Number(value)
  return Number.isFinite(next) && next >= 0 ? Math.floor(next) : null
}

function resolveLocatorPageIndex(
  pages: Array<Pick<DocumentViewPage, 'id' | 'page_num'>>,
  locator: SearchHitLocator | null | undefined,
  fallbackIndex = 0,
): number {
  if (pages.length === 0) return Math.max(0, getFinitePageIndex(locator?.pageIndex) ?? fallbackIndex)
  if (locator?.pageId) {
    const byId = pages.findIndex((page) => String(page.id) === String(locator.pageId))
    if (byId >= 0) return byId
  }
  const pageNum = Number(locator?.pageNum)
  if (Number.isFinite(pageNum) && pageNum > 0) {
    const byPageNum = pages.findIndex((page) => Number(page.page_num) === pageNum)
    if (byPageNum >= 0) return byPageNum
  }
  return clampPageIndex(getFinitePageIndex(locator?.pageIndex) ?? fallbackIndex, pages.length)
}

function getSearchLocatorKey(locator: SearchHitLocator | null | undefined, keyword = ''): string {
  if (!locator) return ''
  return [
    locator.segmentId || '',
    locator.pageId || '',
    locator.pageNum ?? '',
    locator.pageIndex ?? '',
    locator.charStart ?? '',
    locator.charEnd ?? '',
    locator.queryTerm || keyword,
  ].join('|')
}

function resolveStableLocatorPageIndex(
  pages: Array<Pick<DocumentViewPage, 'id' | 'page_num'>>,
  stableLocator: StableReaderLocator | null | undefined,
  legacyLocator: SearchHitLocator | null | undefined,
  fallbackIndex = 0,
): number {
  if (!stableLocator) return resolveLocatorPageIndex(pages, legacyLocator, fallbackIndex)
  if (pages.length === 0) {
    if (stableLocator.pageNum) return Math.max(0, stableLocator.pageNum - 1)
    return Math.max(0, fallbackIndex)
  }
  if (stableLocator.sourcePageId) {
    const byId = pages.findIndex((page) => String(page.id) === stableLocator.sourcePageId)
    if (byId >= 0) return byId
  }
  if (stableLocator.pageNum) {
    const byPageNum = pages.findIndex((page) => Number(page.page_num) === stableLocator.pageNum)
    if (byPageNum >= 0) return byPageNum
  }
  if (stableLocator.progressFallback !== undefined) {
    return clampPageIndex(Math.round(stableLocator.progressFallback * Math.max(0, pages.length - 1)), pages.length)
  }
  return resolveLocatorPageIndex(pages, legacyLocator, fallbackIndex)
}

type ReaderGlobalPreferences = {
  view_mode: ReaderViewMode
  font_family: string
  font_size: number
  line_height: number
  page_width: number
  theme: ReaderTheme
  display_script: ReaderDisplayScript
}

const DEFAULT_READER_GLOBAL_PREFERENCES: ReaderGlobalPreferences = {
  view_mode: 'spread',
  font_family: "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif",
  font_size: 17,
  line_height: 1.9,
  page_width: 520,
  theme: 'paper',
  display_script: 'original',
}

function getDocumentOpenContextKey(
  documentId: string,
  locator: SearchHitLocator | null | undefined,
  stableLocator: StableReaderLocator | null | undefined,
  initialPageIndex = 0,
  searchKeyword = '',
  sourceId = '',
  highlightExcerpt = '',
  revealToc = false,
  searchSession?: SearchSessionState,
): string {
  return [
    documentId,
    getSearchLocatorKey(locator, searchKeyword),
    stableLocator ? `${stableLocator.precision}:${stableLocator.sourcePageId || ''}:${stableLocator.pageNum || ''}` : '',
    initialPageIndex,
    searchKeyword,
    sourceId,
    highlightExcerpt,
    revealToc ? 'toc' : '',
    searchSession?.query || '',
    searchSession?.activeHitIndex ?? '',
    searchSession?.hits?.[0]?.id || '',
    searchSession?.hits?.length || 0,
  ].join('::')
}

function doSearchLocatorsMatch(left: SearchHitLocator | null | undefined, right: SearchHitLocator | null | undefined): boolean {
  if (!left || !right) return false
  if (left.docId && right.docId && left.docId !== right.docId) return false
  if (left.segmentId && right.segmentId && left.segmentId === right.segmentId) {
    const leftNormalized = Number(left.normalizedCharStart)
    const rightNormalized = Number(right.normalizedCharStart)
    if (Number.isFinite(leftNormalized) && Number.isFinite(rightNormalized) && Math.abs(leftNormalized - rightNormalized) <= 2) return true
    const leftChar = Number(left.charStart)
    const rightChar = Number(right.charStart)
    if (Number.isFinite(leftChar) && Number.isFinite(rightChar) && Math.abs(leftChar - rightChar) <= 2) return true
    return Number(left.occurrenceIndex) === Number(right.occurrenceIndex)
  }
  if (left.pageId && right.pageId && String(left.pageId) !== String(right.pageId)) return false
  const leftPageIndex = getFinitePageIndex(left.pageIndex)
  const rightPageIndex = getFinitePageIndex(right.pageIndex)
  if (leftPageIndex !== null && rightPageIndex !== null && leftPageIndex !== rightPageIndex) return false
  const leftPageNum = Number(left.pageNum)
  const rightPageNum = Number(right.pageNum)
  if (Number.isFinite(leftPageNum) && Number.isFinite(rightPageNum) && leftPageNum > 0 && rightPageNum > 0 && leftPageNum !== rightPageNum) return false
  const leftNormalized = Number(left.normalizedCharStart)
  const rightNormalized = Number(right.normalizedCharStart)
  if (Number.isFinite(leftNormalized) && Number.isFinite(rightNormalized)) return Math.abs(leftNormalized - rightNormalized) <= 2
  const leftChar = Number(left.charStart)
  const rightChar = Number(right.charStart)
  if (Number.isFinite(leftChar) && Number.isFinite(rightChar)) return Math.abs(leftChar - rightChar) <= 2
  return Number(left.occurrenceIndex) === Number(right.occurrenceIndex)
}

function alignSearchSessionToLocator(session: SearchSessionState | undefined, locator: SearchHitLocator | null | undefined): SearchSessionState | undefined {
  if (!session?.hits?.length || !locator) return session
  const index = session.hits.findIndex((hit) => doSearchLocatorsMatch(hit.locator, locator))
  if (index < 0 || index === session.activeHitIndex) return session
  return { ...session, activeHitIndex: index }
}

function findSearchMatchIndexForLocator(
  matches: SearchMatch[],
  pages: Array<Pick<DocumentViewPage, 'id' | 'page_num'>>,
  locator: SearchHitLocator | null | undefined,
  fallbackIndex = 0,
): number {
  if (!locator || matches.length === 0) return -1
  const targetPageIndex = resolveLocatorPageIndex(pages, locator, fallbackIndex)
  const samePage = matches
    .map((match, index) => ({
      index,
      distance: Math.abs(Number(match.charIndex || 0) - Number(locator.charStart || 0)),
      occurrenceDistance: Math.abs(Number(match.locator?.occurrenceIndex ?? index) - Number(locator.occurrenceIndex || 0)),
      match,
    }))
    .filter(({ match }) => match.pageIndex === targetPageIndex)
    .sort((left, right) => left.distance - right.distance || left.occurrenceDistance - right.occurrenceDistance || left.index - right.index)
  return samePage[0]?.index ?? -1
}

function isOcrEngine(value: unknown): value is OcrEngine {
  return value === 'local_paddle' || value === 'paddle' || value === 'vision_model' || value === 'hybrid'
}

function getFacsimileExportOptions(format: DocumentExportFormat): DocumentExportOptions | undefined {
  if (!format.startsWith('layout-')) return undefined
  try {
    const storedScale = Number(window.localStorage.getItem(FACSIMILE_FONT_SCALE_STORAGE_KEY))
    const facsimileFontScale = Number.isFinite(storedScale)
      ? Math.max(FACSIMILE_FONT_SCALE_MIN, Math.min(FACSIMILE_FONT_SCALE_MAX, storedScale))
      : FACSIMILE_FONT_SCALE_DEFAULT
    return { facsimileFontScale, facsimileShowRules: true }
  } catch {
    return { facsimileFontScale: FACSIMILE_FONT_SCALE_DEFAULT, facsimileShowRules: true }
  }
}

function getOcrEngineLabel(engine: string): string {
  if (engine === 'local_paddle') return '本地 OCR'
  if (engine === 'vision_model') return '大模型 OCR'
  if (engine === 'hybrid') return '混合 OCR'
  return '飞桨 OCR'
}

function getProofingOcrResult(page?: DocumentViewPage | null): FacsimileOcrResult | null {
  const parsed = parseMaybeJson(page?.ocr_result)
  const sourceType = String(parsed?.source_type || '')
  const baseOcrResult = readRecordValue(parsed, 'base_ocr_result')
  if ((sourceType === 'hybrid_ocr' || sourceType === 'hybrid_ocr_fallback') && baseOcrResult) {
    return asFacsimileOcrResult(baseOcrResult)
  }
  const blocks = page ? getOrderedOcrBlocks(page) : []
  if (blocks.length > 0) {
    return {
      ...(parsed || {}),
      layout_result: blocks.map((block) => ({ ...block, raw_words: block?.raw_words || block?.words, words: getOcrBlockText(block) })),
      words_result: blocks.map((block) => ({ words: getOcrBlockText(block) })).filter((block) => block.words),
    }
  }

  const fallbackText = getPageDisplayText(page)
  const lines = fallbackText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return parsed

  return {
    ...(parsed || {}),
    source_type: String(readRecordValue(parsed, 'source_type') || 'text_fallback'),
    words_result: lines.map((line) => ({ words: line })),
  }
}

function getOcrBlocksForFacsimile(ocrResult: unknown): FacsimileLayoutBlock[] {
  const parsed = getFacsimileOcrResult(ocrResult)
  return getOrderedOcrBlocks({ ocr_result: parsed }) as FacsimileLayoutBlock[]
}

function hasBlockCoordinates(block: FacsimileLayoutBlock): boolean {
  return !!(block?.location || block?.points || block?.block_bbox || block?.bbox || block?.coordinate || block?.coordinate_box || block?.box)
}

function getCompactOcrTextLength(value: string): number {
  return String(value || '').replace(/\s+/g, '').length
}

function mergeFacsimileRawLayoutText(rawLayoutBlocks: FacsimileLayoutBlock[], wordsResult: FacsimileLayoutBlock[]): FacsimileLayoutBlock[] {
  if (rawLayoutBlocks.length === 0 || wordsResult.length === 0) return rawLayoutBlocks
  if (wordsResult.length < Math.ceil(rawLayoutBlocks.length * 0.85)) return rawLayoutBlocks
  return rawLayoutBlocks.map((block, index) => {
    const candidateText = getOcrBlockText(wordsResult[index]).trim()
    if (!candidateText) return block
    const currentText = getOcrBlockText(block).trim()
    const shouldPreferLineText = wordsResult.length === rawLayoutBlocks.length
      || getCompactOcrTextLength(candidateText) >= getCompactOcrTextLength(currentText) + 4
      || getCompactOcrTextLength(currentText) <= 12
    if (!shouldPreferLineText) return block
    return {
      ...block,
      raw_words: block?.raw_words || block?.words || block?.text,
      words: candidateText,
      facsimile_text_source: 'words_result',
    }
  })
}

function getFacsimileOcrResult(ocrResult: unknown): FacsimileOcrResult | null {
  const parsed = asFacsimileOcrResult(ocrResult)
  if (!parsed) return null
  const normalization = readRecordValue(parsed, 'normalization')
  if (
    parsed.gujismart_recovered_from_feijiang_json === true
    && isJsonRecord(normalization)
    && normalization.discarded_untrusted_feijiang_reference_layout === true
  ) {
    return {
      ...parsed,
      layout_result: [],
      raw_layout_result: [],
      words_result: [],
      facsimile_layout_source: 'feijiang_reference_text_only',
    }
  }
  const layoutBlocks = asFacsimileBlocks(parsed.layout_result)
  const rawLayoutBlocks = asFacsimileBlocks(parsed.raw_layout_result)
  const nestedBoxes = asFacsimileBlocks(readRecordValue(readRecordValue(parsed, 'layout_det_res'), 'boxes'))
  const rootBoxes = asFacsimileBlocks(parsed.boxes)
  const wordsResult = asFacsimileBlocks(parsed.words_result)
  const layoutCoordinateCount = layoutBlocks.filter(hasBlockCoordinates).length
  const rawCoordinateCount = rawLayoutBlocks.filter(hasBlockCoordinates).length
  const nestedBoxCoordinateCount = nestedBoxes.filter(hasBlockCoordinates).length
  const rootBoxCoordinateCount = rootBoxes.filter(hasBlockCoordinates).length
  if (rawCoordinateCount > layoutCoordinateCount) {
    const mergedRawLayoutBlocks = mergeFacsimileRawLayoutText(rawLayoutBlocks, wordsResult)
    return {
      ...parsed,
      layout_result: mergedRawLayoutBlocks,
      facsimile_layout_source: 'raw_layout_result',
    }
  }
  if (layoutCoordinateCount > 0) {
    return {
      ...parsed,
      layout_result: layoutBlocks,
      facsimile_layout_source: 'layout_result',
    }
  }
  if (nestedBoxCoordinateCount > 0) {
    return {
      ...parsed,
      layout_result: nestedBoxes,
      facsimile_layout_source: 'layout_det_res.boxes',
    }
  }
  if (rootBoxCoordinateCount > 0) {
    return {
      ...parsed,
      layout_result: rootBoxes,
      facsimile_layout_source: 'boxes',
    }
  }
  return parsed
}

function hasFacsimileCoordinates(ocrResult: unknown): boolean {
  const blocks = getOcrBlocksForFacsimile(ocrResult)
  return blocks.some(hasBlockCoordinates)
}

function chooseFacsimileOcrResult(rawOcrResult: unknown, proofingOcrResult: unknown): FacsimileOcrResult | null {
  const rawFacsimileResult = getFacsimileOcrResult(rawOcrResult)
  const proofingFacsimileResult = getFacsimileOcrResult(proofingOcrResult)
  if (hasFacsimileCoordinates(rawFacsimileResult)) return rawFacsimileResult
  if (hasFacsimileCoordinates(proofingFacsimileResult)) return proofingFacsimileResult
  if (getOcrBlocksForFacsimile(rawFacsimileResult).length > 0) return rawFacsimileResult
  if (getOcrBlocksForFacsimile(proofingFacsimileResult).length > 0) return proofingFacsimileResult
  return proofingFacsimileResult || rawFacsimileResult
}

export function __getFacsimileOcrResultForTest(ocrResult: unknown): FacsimileOcrResult | null {
  return getFacsimileOcrResult(ocrResult)
}

function getBoxText(box: FacsimileLayoutBlock): string {
  return getOcrBlockText(box)
}

function getBoxIdentityPart(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function getBoxIdentity(box: FacsimileLayoutBlock): string {
  const stableId = getBoxIdentityPart(box.id || box.block_id || box.uuid || box.key).trim()
  if (stableId) return `id:${stableId}`
  return [
    getBoxIdentityPart(box.reading_order),
    getBoxIdentityPart(box.block_order),
    getBoxText(box).replace(/\s+/g, ' ').trim(),
    getBoxIdentityPart(getBoxLocation(box)),
  ].join('|')
}

function buildBoxIndexMap(sourceBoxes: FacsimileLayoutBlock[], targetBoxes: FacsimileLayoutBlock[]): number[] {
  const targetIndexes = new Map<string, number[]>()
  targetBoxes.forEach((box, index) => {
    const key = getBoxIdentity(box)
    const indexes = targetIndexes.get(key) || []
    indexes.push(index)
    targetIndexes.set(key, indexes)
  })

  const usedIndexes = new Map<string, number>()
  return sourceBoxes.map((box) => {
    const key = getBoxIdentity(box)
    const usedIndex = usedIndexes.get(key) || 0
    usedIndexes.set(key, usedIndex + 1)
    return targetIndexes.get(key)?.[usedIndex] ?? -1
  })
}

function getMappedBoxIndex(indexMap: number[], index: number): number {
  const mappedIndex = indexMap[index]
  return Number.isInteger(mappedIndex) && mappedIndex >= 0 ? mappedIndex : index
}

function findBoxIndexByIdentity(boxes: FacsimileLayoutBlock[], box: FacsimileLayoutBlock): number {
  const identity = getBoxIdentity(box)
  return boxes.findIndex((candidate) => getBoxIdentity(candidate) === identity)
}

function getBoxSortPoint(box: FacsimileLayoutBlock): { top: number; left: number } {
  const loc = getBoxLocation(box)
  if (isJsonRecord(loc) && (loc.top !== undefined || loc.left !== undefined)) {
    return {
      top: Number.isFinite(Number(loc.top)) ? Number(loc.top) : Number.MAX_SAFE_INTEGER,
      left: Number.isFinite(Number(loc.left)) ? Number(loc.left) : Number.MAX_SAFE_INTEGER,
    }
  }
  if (Array.isArray(loc) && loc.length > 0) {
    const xs = typeof loc[0] === 'number'
      ? (loc.length >= 8 ? [loc[0], loc[2], loc[4], loc[6]] : [loc[0], loc[2]]).map(Number).filter(Number.isFinite)
      : loc.map((point) => getPointCoordinate(point, 'x')).filter(Number.isFinite)
    const ys = typeof loc[0] === 'number'
      ? (loc.length >= 8 ? [loc[1], loc[3], loc[5], loc[7]] : [loc[1], loc[3]]).map(Number).filter(Number.isFinite)
      : loc.map((point) => getPointCoordinate(point, 'y')).filter(Number.isFinite)
    return {
      top: ys.length > 0 ? Math.min(...ys) : Number.MAX_SAFE_INTEGER,
      left: xs.length > 0 ? Math.min(...xs) : Number.MAX_SAFE_INTEGER,
    }
  }
  return { top: Number.MAX_SAFE_INTEGER, left: Number.MAX_SAFE_INTEGER }
}

function getBoxRectForOrientation(box: FacsimileLayoutBlock): { width: number; height: number } | null {
  const loc = getBoxLocation(box)
  if (!loc) return null
  if (isJsonRecord(loc) && (loc.width !== undefined || loc.height !== undefined)) {
    const width = Number(loc.width)
    const height = Number(loc.height)
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null
  }
  if (Array.isArray(loc) && loc.length > 0) {
    const xs = typeof loc[0] === 'number'
      ? (loc.length >= 8 ? [loc[0], loc[2], loc[4], loc[6]] : [loc[0], loc[2]]).map(Number).filter(Number.isFinite)
      : loc.map((point) => getPointCoordinate(point, 'x')).filter(Number.isFinite)
    const ys = typeof loc[0] === 'number'
      ? (loc.length >= 8 ? [loc[1], loc[3], loc[5], loc[7]] : [loc[1], loc[3]]).map(Number).filter(Number.isFinite)
      : loc.map((point) => getPointCoordinate(point, 'y')).filter(Number.isFinite)
    if (xs.length > 0 && ys.length > 0) return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
  }
  return null
}

function hasVerticalPageSignals(blocks: FacsimileLayoutBlock[]): boolean {
  const candidates = blocks.filter((block) => {
    const text = getBoxText(block)
    return !!text.trim() && !!getBoxRectForOrientation(block)
  })
  if (candidates.length < 2) return false
  const verticalCount = candidates.filter((block) => {
    const labelText = String(block?.label || block?.block_label || block?.type || block?.block_type || block?.category || '').toLowerCase()
    if (/vertical[_\s-]*text|col[_\s-]*text|column[_\s-]*text|vertical|竖排|豎排|直排|縦書き|縦組み/i.test(labelText)) return true
    if (block?.orientation === 'vertical') return true
    const rect = getBoxRectForOrientation(block)
    return !!rect && rect.height >= rect.width * 1.28
  }).length
  return verticalCount >= 2 && verticalCount / candidates.length >= 0.5
}

function findBoxForLocator(page: DocumentViewPage | undefined, locator: SearchHitLocator, query: string): { boxIndex: number; boxTop: number; boxLeft: number; boxOccurrenceIndex: number } {
  const parsed = parseMaybeJson(page?.ocr_result)
  const orderedBoxes = getOrderedOcrBlocks({ ...(page || {}), ocr_result: parsed }) as FacsimileLayoutBlock[]
  const textFlowBoxes = getTextFlowOcrBlocks({ ...(page || {}), ocr_result: parsed }) as FacsimileLayoutBlock[]
  const manualLocation = parseManualLayoutLocationKey(locator.locationKey)
  const targetManualBlockId = locator.blockId || manualLocation?.blockId
  if (targetManualBlockId) {
    const manualIndex = orderedBoxes.findIndex((block) => getManualBlockId(block) === targetManualBlockId)
    if (manualIndex >= 0) {
      const block = orderedBoxes[manualIndex]
      const point = getBoxSortPoint(block)
      return { boxIndex: manualIndex, boxTop: point.top, boxLeft: point.left, boxOccurrenceIndex: 0 }
    }
  }
  if (!Array.isArray(textFlowBoxes) || textFlowBoxes.length === 0) {
    return { boxIndex: -1, boxTop: Number.MAX_SAFE_INTEGER, boxLeft: Number.MAX_SAFE_INTEGER, boxOccurrenceIndex: -1 }
  }
  const matchText = String(locator.matchText || '').replace(/\s+/g, ' ').trim()
  const queryTerm = String(locator.queryTerm || query || '').trim()
  // Vector excerpts: prefer head/tail anchors so long semantic text still lands on a block.
  const needleCandidates: string[] = []
  if (matchText.length >= 6) {
    needleCandidates.push(matchText.slice(0, 3), matchText.slice(-3), matchText.slice(0, Math.min(16, matchText.length)))
  }
  if (matchText) needleCandidates.push(matchText)
  needleCandidates.push(...uniqueSearchTerms(matchText || queryTerm || query))
  const pageText = String(page?.proofed_text || page?.ocr_text || '')
  const targetCharStart = Number(locator.charStart || 0)
  const textFlowToLayoutIndex = buildBoxIndexMap(textFlowBoxes, orderedBoxes)
  const boxTexts = textFlowBoxes.map(getBoxText)

  for (const needle of needleCandidates) {
    if (!needle) continue
    const nearestPageOccurrence = findSearchOccurrenceIndexNearChar(pageText, needle, targetCharStart)
    const targetOccurrence = nearestPageOccurrence >= 0 ? nearestPageOccurrence : Number(locator.occurrenceIndex || 0)
    const container = findSearchOccurrenceContainer(boxTexts, needle, targetOccurrence)
    if (!container) continue
    const boxIndex = getMappedBoxIndex(textFlowToLayoutIndex, container.containerIndex)
    const point = getBoxSortPoint(textFlowBoxes[container.containerIndex])
    return { boxIndex, boxTop: point.top, boxLeft: point.left, boxOccurrenceIndex: container.occurrenceIndex }
  }
  return { boxIndex: -1, boxTop: Number.MAX_SAFE_INTEGER, boxLeft: Number.MAX_SAFE_INTEGER, boxOccurrenceIndex: -1 }
}

function putLimitedPageImageCache(cache: Map<string, string>, key: string, value: string, maxEntries = 18, maxTotalChars = 96 * 1024 * 1024) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  const getTotalChars = () => Array.from(cache.values()).reduce((total, item) => total + item.length, 0)
  while (cache.size > maxEntries || getTotalChars() > maxTotalChars) {
    const oldestKey = Array.from(cache.keys()).find((candidate) => candidate !== key)
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
}

function getPageImageCacheKey(page: DocumentViewPage | null | undefined, docId: string | undefined, fallbackDocumentId: string): string {
  return String(page?.id || `${docId || fallbackDocumentId}:${page?.page_num || ''}`)
}

function getProofImagePrewarmPageNums(
  pages: DocumentViewPage[],
  currentIndex: number,
  pageCount: number,
): number[] {
  const normalizedPageCount = Math.max(0, Math.round(Number(pageCount || pages.length || 0)))
  if (normalizedPageCount === 0 || pages.length === 0) return []
  const sourcePages = pages
    .map((page) => Math.round(Number(page.page_num || 0)))
    .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0)
  if (sourcePages.length === 0) return []
  const start = Math.max(0, currentIndex - PROOF_IMAGE_PREWARM_WINDOW_RADIUS)
  const end = Math.min(pages.length - 1, currentIndex + PROOF_IMAGE_PREWARM_WINDOW_RADIUS)
  return Array.from(new Set(
    pages
      .slice(start, end + 1)
      .map((page) => Math.round(Number(page.page_num || 0)))
      .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0),
  )).sort((left, right) => left - right)
}

function getTranslationModelSignatureFromState(state: LlmProfileSyncDetail): string {
  const current = state?.current || (Array.isArray(state?.profiles)
    ? state.profiles.find((profile: LlmProviderProfile) => profile?.id === state?.activeId) || state.profiles[0]
    : null)
  return [
    current?.id || state?.activeId || '',
    current?.provider || current?.name || '',
    current?.baseUrl || '',
    current?.model || '',
  ].map((part) => String(part || '').trim()).filter(Boolean).join('|') || 'default'
}

function getTranslationSourceText(page: TranslationSourcePage | null | undefined): string {
  return getCanonicalPageTranslationSourceText(page)
}

function isReadyTranslationUnit(unit: TranslationUnitV1): boolean {
  if (unit.skipped) return true
  return unit.status === 'ready' && !unit.stale && Boolean(String(unit.translationText || '').trim())
}

function getReadyTranslationTextFromUnits(units: TranslationUnitV1[]): string {
  if (units.length === 0 || !units.every(isReadyTranslationUnit)) return ''
  return units
    .map((unit) => String(unit.translationText || (unit.skipped ? unit.sourceText : '')).trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function areAllTranslationUnitsSkipped(units: TranslationUnitV1[]): boolean {
  return units.length > 0 && units.every((unit) => unit.skipped)
}

function getPageDisplayText(page?: DocumentViewPage | null): string {
  if (!page) return ''
  return extractPageText(page)
}

function getPageReadingText(page: DocumentViewPage): string {
  const elements = getReadablePageElements(page)
  if (elements.length > 0) {
    return elements.map((element) => element.type === 'table' && element.rows?.length
      ? tableRowsToHtml(element.rows)
      : String(element.text || '').trim()).filter(Boolean).join('\n\n')
  }
  return getReadablePageText(page)
}

function hasReadablePageTextCandidate(page?: DocumentViewPage | null): boolean {
  if (!page) return false
  if (String(page.proofed_text || page.ocr_text || '').trim()) return true
  if (page.has_text || page.has_ocr_text) return true
  if (!page.ocr_result) return false
  return getPageDisplayText(page).trim().length > 0
}

function normalizeInlineMathToken(value: string): string {
  return String(value || '')
    .replace(/\\dagger/g, '†')
    .replace(/\\ddagger/g, '‡')
    .replace(/\\ast/g, '*')
    .replace(/\\star/g, '*')
    .replace(/\\S/g, '§')
    .replace(/\\P/g, '¶')
    .replace(/\\cdot/g, '·')
    .replace(/\\times/g, '×')
    .replace(/\\alpha/g, 'α')
    .replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\delta/g, 'δ')
    .replace(/\\[a-zA-Z]+/g, (match) => match.slice(1))
    .replace(/[{}]/g, '')
    .trim()
}

function stripReaderHtml(value: string): string {
  const decoded = String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  return decoded
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function htmlTablesToMarkdown(value: string): string {
  return String(value || '').replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows = (tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [])
      .map((rowHtml) => (rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripReaderHtml))
      .filter((row) => row.some((cell) => cell.trim()))
    if (rows.length === 0) return stripReaderHtml(tableHtml)
    const columnCount = Math.max(...rows.map((row) => row.length), 1)
    const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_item, index) => row[index] || ' '))
    const header = normalizedRows[0]
    const body = normalizedRows.slice(1)
    const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || ' '
    return [
      `| ${header.map(escapeCell).join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
    ].join('\n')
  })
}

function escapeHtmlText(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function tableRowsToHtml(rows: string[][]): string {
  const normalizedRows = (rows || [])
    .map((row) => (row || []).map((cell) => String(cell || '').replace(/\s+/g, ' ').trim()))
    .filter((row) => row.some(Boolean))
  if (!normalizedRows.length) return ''
  const columnCount = Math.max(...normalizedRows.map((row) => row.length), 1)
  const paddedRows = normalizedRows.map((row) => Array.from({ length: columnCount }, (_item, index) => row[index] || ' '))
  const header = paddedRows[0]
  const body = paddedRows.slice(1)
  const escapeCell = (cell: string) => escapeHtmlText(cell.trim() || ' ')
  return [
    '<table>',
    '<tbody>',
    `<tr>${header.map((cell) => `<th>${escapeCell(cell)}</th>`).join('')}</tr>`,
    ...body.map((row) => `<tr>${row.map((cell) => `<td>${escapeCell(cell)}</td>`).join('')}</tr>`),
    '</tbody>',
    '</table>',
  ].join('')
}

function normalizeTextWithProtectedHtmlTables(source: string): string {
  const tables: string[] = []
  const protectedText = String(source || '').replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const token = `\n\n__GUJISMART_HTML_TABLE_${tables.length}__\n\n`
    tables.push(tableHtml.trim())
    return token
  })
  const normalized = normalizeOcrTextForReading(protectedText)
  return normalized.replace(/__GUJISMART_HTML_TABLE_(\d+)__/g, (_match, index) => {
    const table = tables[Number(index)] || ''
    return table ? `\n\n${table}\n\n` : ''
  })
}

function normalizeReaderMarkdown(text: string): string {
  const source = String(text || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
  return normalizeTextWithProtectedHtmlTables(source)
    .replace(/\r/g, '')
    .replace(/\$\s*\^\s*\{([^}]*)\}\s*\$/g, (_match, value) => `<sup>${normalizeInlineMathToken(value)}</sup>`)
    .replace(/\$\s*\^\s*([^\s$]+)\s*\$/g, (_match, value) => `<sup>${normalizeInlineMathToken(value)}</sup>`)
    .replace(/\$\s*_\s*\{([^}]*)\}\s*\$/g, (_match, value) => `<sub>${normalizeInlineMathToken(value)}</sub>`)
    .replace(/\$\s*_\s*([^\s$]+)\s*\$/g, (_match, value) => `<sub>${normalizeInlineMathToken(value)}</sub>`)
    .replace(/\^\{([^}]*)\}/g, (_match, value) => `<sup>${normalizeInlineMathToken(value)}</sup>`)
    .replace(/(?<![a-zA-Z])\^(\d+)/g, '<sup>$1</sup>')
    .replace(/_\{([^}]*)\}/g, (_match, value) => `<sub>${normalizeInlineMathToken(value)}</sub>`)
    .replace(/\$(\\(?:dagger|ddagger|ast|star|S|P|cdot|times|alpha|beta|gamma|delta))\$/g, (_match, value) => normalizeInlineMathToken(value))
    .replace(/([^\n|])\n([^\n#>*\-\d|])/g, '$1\n\n$2')
}

function transformReaderDisplayText(text: string, script: ReaderDisplayScript): string {
  if (script === 'simplified') return toSimplified(text)
  if (script === 'traditional') return toTraditional(text)
  return text
}

function highlightTextNode(
  text: string,
  keyword: string,
  activeIndex = -1,
  cursorState = { value: 0 },
): ReactNode {
  if (!keyword.trim()) return text
  try {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escaped})`, 'gi')
    return text.split(regex).map((part, index) => {
      if (index % 2 !== 1) return <span key={index}>{part}</span>
      const hitIndex = cursorState.value
      cursorState.value += 1
      const active = hitIndex === activeIndex
      return (
        <mark
          key={index}
          data-search-hit-index={hitIndex}
          data-search-active={active ? 'true' : undefined}
          style={{
            background: active ? '#ffb020' : 'rgba(255, 229, 143, 0.56)',
            color: '#1f1608',
            padding: '0 2px',
            borderRadius: 3,
            fontWeight: 700,
            position: 'relative',
            zIndex: active ? 3 : 0,
            border: active ? '1px solid rgba(120, 53, 15, 0.92)' : '1px solid rgba(189, 138, 42, 0.28)',
            outline: active ? '2px solid rgba(255, 255, 255, 0.88)' : 'none',
            outlineOffset: 0,
            boxShadow: active
              ? '0 0 0 3px rgba(120, 53, 15, 0.82), 0 0 0 6px rgba(255, 176, 32, 0.26)'
              : '0 0 0 1px rgba(189, 138, 42, 0.08)',
          }}
        >
          {part}
        </mark>
      )
    })
  } catch {
    return text
  }
}

function stripSnippetMarkers(value: string): string {
  return String(value || '')
    .replace(/<</g, '')
    .replace(/>>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripSnippetHtmlPreservingMarkers(value: string): string {
  const openToken = 'GUJISMARTSEARCHMARKOPEN'
  const closeToken = 'GUJISMARTSEARCHMARKCLOSE'
  const normalized = normalizeReaderMarkdown(String(value || '').replace(/<</g, openToken).replace(/>>/g, closeToken))
  return stripReaderHtml(normalized)
    .split(openToken).join('<<')
    .split(closeToken).join('>>')
    .replace(/\s+/g, ' ')
    .trim()
}

function markSnippetAround(text: string, keyword: string, charIndex: number, contextSize = 58): string {
  const source = String(text || '')
  if (!source) return ''
  const query = String(keyword || '').trim()
  const boundedIndex = Math.max(0, Math.min(source.length, Number.isFinite(charIndex) ? charIndex : 0))
  const directIndex = query ? source.toLowerCase().indexOf(query.toLowerCase(), boundedIndex) : -1
  const matchStart = directIndex >= 0 && directIndex <= boundedIndex + Math.max(24, query.length + 8)
    ? directIndex
    : boundedIndex
  const matchLength = query && source.slice(matchStart, matchStart + query.length).toLowerCase() === query.toLowerCase()
    ? query.length
    : Math.max(1, Math.min(query.length || 16, source.length - matchStart))
  const start = Math.max(0, matchStart - contextSize)
  const end = Math.min(source.length, matchStart + matchLength + contextSize)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < source.length ? '…' : ''
  return `${prefix}${source.slice(start, matchStart)}<<${source.slice(matchStart, matchStart + matchLength)}>>${source.slice(matchStart + matchLength, end)}${suffix}`
}

function renderMarkedSnippet(snippet: string, keyword: string, displayScript: ReaderDisplayScript): ReactNode {
  const source = transformReaderDisplayText(stripSnippetHtmlPreservingMarkers(String(snippet || '')), displayScript)
  const displayKeyword = transformReaderDisplayText(keyword, displayScript)
  if (!source) return null
  if (!source.includes('<<')) {
    return highlightTextNode(stripSnippetMarkers(source), displayKeyword)
  }

  const nodes: ReactNode[] = []
  let cursor = 0
  let keyIndex = 0
  while (cursor < source.length) {
    const start = source.indexOf('<<', cursor)
    if (start < 0) {
      const tail = source.slice(cursor).replace(/>>/g, '')
      if (tail) nodes.push(<span key={`tail-${keyIndex}`}>{tail}</span>)
      break
    }
    const plain = source.slice(cursor, start).replace(/>>/g, '')
    if (plain) nodes.push(<span key={`plain-${keyIndex}`}>{plain}</span>)
    const end = source.indexOf('>>', start + 2)
    const marked = end >= 0 ? source.slice(start + 2, end) : source.slice(start + 2)
    if (marked) {
      nodes.push(
        <mark key={`mark-${keyIndex}`} style={{ background: '#ffe58f', color: '#1f1608', padding: '0 2px', borderRadius: 2, fontWeight: 700 }}>
          {marked}
        </mark>,
      )
    }
    keyIndex += 1
    if (end < 0) break
    cursor = end + 2
  }
  return nodes
}

function highlightMarkdownChildren(
  children: ReactNode,
  keyword: string,
  activeIndex = -1,
  cursorState = { value: 0 },
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') return highlightTextNode(child, keyword, activeIndex, cursorState)
    if (isValidElement(child)) {
      return cloneElement(child, {
        ...child.props,
        children: highlightMarkdownChildren(child.props.children, keyword, activeIndex, cursorState),
      })
    }
    return child
  })
}

function renderBookText(
  text: string,
  keyword: string,
  displayScript: ReaderDisplayScript = 'original',
  activeIndex = -1,
  startIndex = 0,
) {
  const content = transformReaderDisplayText(normalizeReaderMarkdown(text || '本页暂无文本'), displayScript)
  const displayKeyword = transformReaderDisplayText(keyword, displayScript)
  const cursorState = { value: startIndex }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      components={{
        p: ({ children }) => <p style={{ margin: '0 0 0.85em' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</p>,
        h1: ({ children }) => <h1 style={{ fontSize: '1.55em', lineHeight: 1.35, margin: '0.1em 0 0.75em' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</h1>,
        h2: ({ children }) => <h2 style={{ fontSize: '1.3em', lineHeight: 1.38, margin: '0.1em 0 0.65em' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</h2>,
        h3: ({ children }) => <h3 style={{ fontSize: '1.12em', lineHeight: 1.42, margin: '0.1em 0 0.55em' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</h3>,
        ul: ({ children }) => <ul style={{ paddingLeft: '1.5em', margin: '0 0 0.9em' }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ paddingLeft: '1.5em', margin: '0 0 0.9em' }}>{children}</ol>,
        li: ({ children }) => <li style={{ margin: '0.2em 0' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</li>,
        blockquote: ({ children }) => <blockquote style={{ margin: '0 0 1em', padding: '0.2em 0 0.2em 0.9em', borderLeft: '3px solid rgba(184,134,83,0.45)' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</blockquote>,
        table: ({ children }) => <table style={{ width: '100%', borderCollapse: 'collapse', margin: '0 0 1em', fontSize: '0.92em' }}>{children}</table>,
        th: ({ children }) => <th style={{ border: '1px solid rgba(120,80,30,0.28)', padding: '4px 6px', background: 'rgba(120,80,30,0.08)' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</th>,
        td: ({ children }) => <td style={{ border: '1px solid rgba(120,80,30,0.18)', padding: '4px 6px' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</td>,
        code: ({ children }) => <code style={{ fontFamily: 'Consolas, monospace', fontSize: '0.92em', background: 'rgba(120,80,30,0.12)', padding: '1px 4px', borderRadius: 3 }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</code>,
        sup: ({ children }) => <sup style={{ fontSize: '0.72em', lineHeight: 0, verticalAlign: 'super', color: 'inherit' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</sup>,
        sub: ({ children }) => <sub style={{ fontSize: '0.72em', lineHeight: 0, verticalAlign: 'sub', color: 'inherit' }}>{highlightMarkdownChildren(children, displayKeyword, activeIndex, cursorState)}</sub>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function ManualLayoutReaderImage({
  page,
  element,
  themeStyle,
}: {
  page?: DocumentViewPage
  element: ReadablePageElement
  themeStyle: ReaderThemeStyle
}) {
  const [assetUrl, setAssetUrl] = useState('')
  const [pageUrl, setPageUrl] = useState('')
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const assetPath = String(element.imagePath || '').trim()
  const pagePath = String(page?.image_path || '').trim()
  const crop = element.imageCrop || element.rect

  useEffect(() => {
    let canceled = false
    setAssetUrl('')
    setPageUrl('')
    setNaturalSize(null)
    const load = async (filePath: string): Promise<string> => {
      if (!filePath) return ''
      if (/^(?:data:|blob:|https?:\/\/)/i.test(filePath)) return filePath
      try {
        return await window.api.isReadableFile(filePath) ? toLocalResourceUrl(filePath) : ''
      } catch {
        return ''
      }
    }
    void Promise.all([load(assetPath), load(pagePath)]).then(([nextAssetUrl, nextPageUrl]) => {
      if (canceled) return
      setAssetUrl(nextAssetUrl)
      setPageUrl(nextPageUrl)
    })
    return () => {
      canceled = true
    }
  }, [assetPath, pagePath])

  const sourceSize = getOcrCoordinateSourceSize(page?.ocr_result)
  const sourceWidth = Number(sourceSize.width || naturalSize?.width || (crop ? crop.left + crop.width : 1))
  const sourceHeight = Number(sourceSize.height || naturalSize?.height || (crop ? crop.top + crop.height : 1))
  const cropWidth = Math.max(1, crop?.width || sourceWidth)
  const cropHeight = Math.max(1, crop?.height || sourceHeight)
  const cropLeft = Math.max(0, crop?.left || 0)
  const cropTop = Math.max(0, crop?.top || 0)
  const usingAsset = Boolean(assetUrl)
  const sourceUrl = assetUrl || pageUrl

  return (
    <figure style={{ margin: '0.35em auto 1em', maxWidth: '100%', color: themeStyle.text }}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 620,
          margin: '0 auto',
          aspectRatio: `${cropWidth} / ${cropHeight}`,
          overflow: 'hidden',
          border: `1px solid ${themeStyle.border}`,
          background: 'rgba(120,80,30,0.06)',
        }}
      >
        {sourceUrl ? (
          <img
            src={sourceUrl}
            alt={element.caption || element.visualKind || '文献图片'}
            draggable={false}
            onError={() => {
              if (usingAsset) setAssetUrl('')
              else setPageUrl('')
            }}
            onLoad={(event) => {
              const image = event.currentTarget
              if (image.naturalWidth > 0 && image.naturalHeight > 0) setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
            }}
            style={usingAsset || !crop ? {
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              pointerEvents: 'none',
              userSelect: 'none',
            } : {
              position: 'absolute',
              left: `${-(cropLeft / Math.max(cropWidth, 1)) * 100}%`,
              top: `${-(cropTop / Math.max(cropHeight, 1)) * 100}%`,
              width: `${(sourceWidth / Math.max(cropWidth, 1)) * 100}%`,
              height: `${(sourceHeight / Math.max(cropHeight, 1)) * 100}%`,
              maxWidth: 'none',
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          />
        ) : (
          <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: themeStyle.muted, fontSize: 12 }}>
            图像区域暂不可用
          </div>
        )}
      </div>
      {element.caption ? (
        <figcaption style={{ marginTop: 6, color: themeStyle.muted, fontSize: 13, textAlign: 'center', lineHeight: 1.5 }}>
          {element.caption}
        </figcaption>
      ) : null}
    </figure>
  )
}

function renderReaderPageElements(
  page: ReaderPage,
  keyword: string,
  displayScript: ReaderDisplayScript,
  activeIndex: number,
  pageHitStartIndex: number,
  themeStyle: ReaderThemeStyle,
) {
  const elements = page.elements || []
  if (elements.length === 0) return renderBookText(page.text, keyword, displayScript, activeIndex, pageHitStartIndex)
  return (
    <div>
      {elements.map((element, index) => {
        const elementStart = pageHitStartIndex + element.charStart
        if (element.type === 'image') {
          return <ManualLayoutReaderImage key={`${page.id}-image-${index}`} page={page.sourcePage} element={element} themeStyle={themeStyle} />
        }
        const elementText = element.type === 'table' && element.rows?.length ? tableRowsToHtml(element.rows) : element.text
        if (!elementText.trim()) return null
        return <div key={`${page.id}-text-${index}`}>{renderBookText(elementText, keyword, displayScript, activeIndex, elementStart)}</div>
      })}
    </div>
  )
}

function buildReaderPages(sourcePages: DocumentViewPage[], fontSize: number, lineHeight: number, pageWidth: number, viewportHeight: number): ReaderPage[] {
  const usableHeight = Math.max(360, viewportHeight - 310)
  const horizontalPadding = 76
  const verticalPadding = 104
  const usableWidth = Math.max(260, pageWidth - horizontalPadding)
  const linePx = Math.max(18, fontSize * lineHeight)
  const charsPerLine = Math.max(14, Math.floor(usableWidth / Math.max(8, fontSize * 0.58)))
  const linesPerPage = Math.max(8, Math.floor((usableHeight - verticalPadding) / linePx))
  const charsPerPage = Math.max(220, Math.floor(charsPerLine * linesPerPage * 0.92))
  const readerPages: ReaderPage[] = []

  sourcePages.forEach((page, sourcePageIndex) => {
    const elements = getReadablePageElements(page)
    const hasVisualElements = elements.some((element) => element.type === 'image')
    const text = getPageReadingText(page)
    if (!text && !hasVisualElements) return
    if (hasVisualElements) {
      const physicalPageNum = page.page_num || sourcePageIndex + 1
      const literaturePageNum = getCitationPageNumber(page, physicalPageNum) || physicalPageNum
      readerPages.push({
        id: `${page.id || sourcePageIndex}-visual`,
        sourcePageIndex,
        sourcePageNum: physicalPageNum,
        literaturePageNum,
        sourcePageId: page.id,
        sourceStartChar: 0,
        sourceEndChar: text.length,
        segmentIndex: 0,
        text,
        elements,
        sourcePage: page,
      })
      return
    }
    let rest = text.replace(/\r/g, '').trim()
    let sourceCursor = text.replace(/\r/g, '').indexOf(rest)
    if (sourceCursor < 0) sourceCursor = 0
    let segmentIndex = 0

    while (rest.length > 0) {
      let take = Math.min(charsPerPage, rest.length)
      if (take < rest.length) {
        const windowStart = Math.max(0, take - 160)
        const slice = rest.slice(windowStart, take)
        const breakCandidates = ['\n\n', '\n', '?', '?', '?', '?', ';', '.', ' ']
        for (const marker of breakCandidates) {
          const offset = slice.lastIndexOf(marker)
          if (offset > 40) {
            take = windowStart + offset + marker.length
            break
          }
        }
      }

      const chunk = rest.slice(0, take).trim()
      if (chunk) {
        const leadingTrim = rest.slice(0, take).indexOf(chunk)
        const sourceStartChar = sourceCursor + Math.max(0, leadingTrim)
        const physicalPageNum = page.page_num || sourcePageIndex + 1
        const literaturePageNum = getCitationPageNumber(page, physicalPageNum) || physicalPageNum
        readerPages.push({
          id: `${page.id || sourcePageIndex}-${segmentIndex}`,
          sourcePageIndex,
          sourcePageNum: physicalPageNum,
          literaturePageNum,
          sourcePageId: page.id,
          sourceStartChar,
          sourceEndChar: sourceStartChar + chunk.length,
          segmentIndex,
          text: chunk,
          sourcePage: page,
        })
      }
      rest = rest.slice(take).trim()
      sourceCursor += take
      segmentIndex += 1
    }
  })

  return readerPages
}

export default function DocumentView({
  documentId,
  initialPageIndex = 0,
  searchKeyword = '',
  sourceId,
  locator,
  stableLocator,
  searchSession,
  revealToc = false,
  highlightExcerpt = '',
  highlightColor = '',
  sourceLabel = '',
  startReaderBookTranslation = false,
  openTranslation = false,
  onBack,
  onOpenDocument,
  compactHeader = false,
}: DocumentViewProps) {
  const openContextKey = getDocumentOpenContextKey(documentId, locator, stableLocator, initialPageIndex, searchKeyword, sourceId, highlightExcerpt, revealToc, searchSession)
  const [doc, setDoc] = useState<DocumentViewDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [ocrProcessing, setOcrProcessing] = useState(false)
  const [manualPageInsertionLoading, setManualPageInsertionLoading] = useState(false)
  const [manualPageDeletionLoading, setManualPageDeletionLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [restoringPdf, setRestoringPdf] = useState(false)
  const [exportingDocument, setExportingDocument] = useState(false)
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [pendingExportFormat, setPendingExportFormat] = useState<DocumentExportFormat | null>(null)
  const [exportPageNumberMode, setExportPageNumberMode] = useState<ExportPageNumberMode>('literature')
  const [editorVisible, setEditorVisible] = useState(false)
  const [activeBoxIndex, setActiveBoxIndex] = useState(-1)
  const [switchToRegion, setSwitchToRegion] = useState(false)
  const [currentPageIndex, setCurrentPageIndex] = useState(0)
  const [pageInput, setPageInput] = useState('1')
  const [imageDataUrl, setImageDataUrl] = useState('')
  const [nextImageDataUrl, setNextImageDataUrl] = useState('')
  /** True while the left-pane page image is being resolved (path / PDF render). */
  const [pageImageLoading, setPageImageLoading] = useState(false)
  const [floatPanelOpen, setFloatPanelOpen] = useState(false)
  const [localSearchKeyword, setLocalSearchKeyword] = useState(searchKeyword)
  const [searchInputDraft, setSearchInputDraft] = useState(searchKeyword)
  const [readerSearchEngine, setReaderSearchEngine] = useState<'fulltext' | 'vector'>(
    searchSession?.engine === 'vector' || sourceId === 'vector-search' ? 'vector' : 'fulltext',
  )
  /** Bumped on every in-reader search commit so same keyword can re-run after engine switch / Enter. */
  const [readerSearchRevision, setReaderSearchRevision] = useState(0)
  const [readerSearchPages, setReaderSearchPages] = useState<DocumentPage[]>([])
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1)
  const [documentSearchSession, setDocumentSearchSession] = useState<SearchSessionState | undefined>(searchSession)
  const [searchFocused, setSearchFocused] = useState(false)
  const [leftWidth, setLeftWidth] = useState(50)
  const [isDraggingDivider, setIsDraggingDivider] = useState(false)
  const [pageViewMode, setPageViewMode] = useState<PageViewMode>('single')
  const [birdDensity, setBirdDensity] = useState<BirdDensity>('medium')
  const [sharedViewport, setSharedViewport] = useState<ViewerViewport | undefined>(undefined)
  const [imageViewerResetToken, setImageViewerResetToken] = useState(0)
  const [pageTranslations, setPageTranslations] = useState<Record<string, string>>({})
  const [pageTranslationUnits, setPageTranslationUnits] = useState<Record<string, TranslationUnitV1[]>>({})
  const [pageTranslationHashes, setPageTranslationHashes] = useState<Record<string, string>>({})
  const [skippedTranslationPageIds, setSkippedTranslationPageIds] = useState<Record<string, boolean>>({})
  const [translatingPageIds, setTranslatingPageIds] = useState<Record<string, boolean>>({})
  const [translationModelSignature, setTranslationModelSignature] = useState('default')
  const [translationGlossaryProjectId, setTranslationGlossaryProjectId] = useState('')
  const [translationGlossarySignature, setTranslationGlossarySignature] = useState('none')
  const [translationGlossaryProjects, setTranslationGlossaryProjects] = useState<ResearchProject[]>([])
  const [translationMode, setTranslationMode] = useState<TranslationMode>('balanced')
  const [quickGlossaryModalOpen, setQuickGlossaryModalOpen] = useState(false)
  const [quickGlossaryScope, setQuickGlossaryScope] = useState<TranslationGlossaryScope>('global')
  const [quickGlossarySourceTerm, setQuickGlossarySourceTerm] = useState('')
  const [quickGlossaryTargetTerm, setQuickGlossaryTargetTerm] = useState('')
  const [quickGlossaryNote, setQuickGlossaryNote] = useState('')
  const [selectedTextForAi, setSelectedTextForAi] = useState('')
  const [readerContextTextForAi, setReaderContextTextForAi] = useState('')
  const [readerViewMode, setReaderViewMode] = useState<ReaderViewMode>(DEFAULT_READER_GLOBAL_PREFERENCES.view_mode)
  const [readerFontFamily, setReaderFontFamily] = useState(DEFAULT_READER_GLOBAL_PREFERENCES.font_family)
  const [readerFontSize, setReaderFontSize] = useState(DEFAULT_READER_GLOBAL_PREFERENCES.font_size)
  const [readerLineHeight, setReaderLineHeight] = useState(DEFAULT_READER_GLOBAL_PREFERENCES.line_height)
  const [readerPageWidth, setReaderPageWidth] = useState(DEFAULT_READER_GLOBAL_PREFERENCES.page_width)
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(DEFAULT_READER_GLOBAL_PREFERENCES.theme)
  const [readerDisplayScript, setReaderDisplayScript] = useState<ReaderDisplayScript>(() => {
    try {
      const stored = window.localStorage.getItem(READER_DISPLAY_SCRIPT_STORAGE_KEY)
      return isReaderDisplayScript(stored) ? stored : DEFAULT_READER_GLOBAL_PREFERENCES.display_script
    } catch {
      return DEFAULT_READER_GLOBAL_PREFERENCES.display_script
    }
  })
  const [readerTocOpen, setReaderTocOpen] = useState(true)
  const [readerSidebarTab, setReaderSidebarTab] = useState<ReaderSidebarTab>('toc')
  const [readerSearchResultPage, setReaderSearchResultPage] = useState(1)
  const [readerViewportHeight, setReaderViewportHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 800)
  const [readerPageIndex, setReaderPageIndex] = useState(0)
  const [documentMode, setDocumentMode] = useState<DocumentMode>('proof')
  const [proofViewMode, setProofViewMode] = useState<ProofViewMode>('facsimile')
  const [proofViewTouched, setProofViewTouched] = useState(false)
  const [facsimileTranslationOpen, setFacsimileTranslationOpen] = useState(false)
  const [preferFacsimileProofLayout, setPreferFacsimileProofLayout] = useState(true)
  /** Global default when a document has no manual mode yet. Default ON = open in reading mode. */
  const [preferReadModeOnOpen, setPreferReadModeOnOpen] = useState(true)
  const preferReadModeOnOpenRef = useRef(true)
  const [initialReaderLocationKey, setInitialReaderLocationKey] = useState('')
  const [readerStateReady, setReaderStateReady] = useState(false)
  const [pageOcrVersions, setPageOcrVersions] = useState<PageOcrVersion[]>([])
  const [ocrVersionLoading, setOcrVersionLoading] = useState(false)
  const [shortcuts, setShortcuts] = useState<ShortcutMap | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const draggingDivider = useRef(false)
  const floatingPanelRef = useRef<HTMLDivElement>(null)
  const panelState = useRef({ x: 0, y: 0, w: 420, h: 600 })
  const draggingPanel = useRef(false)
  const resizingPanel = useRef<string | null>(null)
  const interactStart = useRef({ mouseX: 0, mouseY: 0, panelX: 0, panelY: 0, panelW: 0, panelH: 0 })
  const panelFrameRef = useRef<number | null>(null)
  const pendingPanelStyleRef = useRef<{ x: number; y: number; w?: number; h?: number } | null>(null)
  const aiButtonRef = useRef<HTMLDivElement>(null)
  const btnPosRef = useRef({ x: 0, y: 0 })
  const btnDragState = useRef({ isDragging: false, startX: 0, startY: 0, btnX: 0, btnY: 0, moved: false, timer: 0 as DragTimer })
  const hasInitializedPageRef = useRef(false)
  const translationInFlightRef = useRef<Set<string>>(new Set())
  const translationInFlightGenerationRef = useRef<Map<string, number>>(new Map())
  const translationQueueRef = useRef<ReaderTranslationQueueItem[]>([])
  const translationCurrentPageIdRef = useRef('')
  const translationCurrentGenerationRef = useRef(0)
  const translationCurrentActiveGenerationRef = useRef(0)
  const translationWorkerActiveRef = useRef(false)
  const translationTaskIdsRef = useRef<Map<string, string>>(new Map())
  const pageImageCacheRef = useRef<Map<string, string>>(new Map())
  const proofImagePrewarmKeyRef = useRef('')
  const readerVisiblePageIndexRef = useRef(initialPageIndex)
  const readerStateLoadedRef = useRef(false)
  const documentModeTouchedRef = useRef(false)
  /** Last mode the user explicitly requested; blocks stale restores from snapping the Segmented back. */
  const intendedDocumentModeRef = useRef<DocumentMode>('proof')
  const documentModeSwitchSerialRef = useRef(0)
  const readerSaveTimerRef = useRef<number | null>(null)
  const readerPreferencesLoadedRef = useRef(false)
  const readerPreferencesSaveTimerRef = useRef<number | null>(null)
  const latestReaderPreferencesRef = useRef<ReaderGlobalPreferences>(DEFAULT_READER_GLOBAL_PREFERENCES)
  const latestReaderStateRef = useRef<ReaderStateSavePayload>({})
  const searchRequestIdRef = useRef(0)
  const searchPagesRequestIdRef = useRef(0)
  const incomingSearchSessionKeyRef = useRef('')
  /** Prevents re-fetch loops when a focused open expands to 0–1 fulltext hits. */
  const documentSearchFetchedKeyRef = useRef('')
  /** Doc-scoped vector expand (in-document semantic hits). */
  const documentVectorExpandKeyRef = useRef('')
  const searchAutoNavigationKeyRef = useRef('')
  const appliedInitialSearchLocatorKeyRef = useRef('')
  const temporaryNavigationRef = useRef(false)
  const pageRangeRequestRef = useRef(0)
  const pageRangeInFlightRef = useRef<Map<string, Promise<DocumentPage[]>>>(new Map())
  const handledBookTranslationRequestRef = useRef('')
  const activeDocumentIdRef = useRef(documentId)
  const sortedPagesRef = useRef<DocumentViewPage[]>([])
  const pageCountRef = useRef(0)
  const readerVirtualPagesRef = useRef<ReaderPage[]>([])
  const isEbookDocumentRef = useRef(false)

  const effectiveSearchKeyword = localSearchKeyword
  const releaseTemporaryNavigation = useCallback(() => {
    temporaryNavigationRef.current = false
  }, [])
  const handleAiOpenDocument = useCallback((target: OpenDocumentTarget) => {
    if (target.docId && target.docId !== documentId) {
      onOpenDocument?.(target)
      return
    }
    const targetPageIndex = resolveStableLocatorPageIndex(sortedPagesRef.current, target.stableLocator, target.locator, target.pageIndex ?? initialPageIndex)
    const keyword = target.keyword || target.highlightExcerpt || target.locator?.queryTerm || target.excerpt?.slice(0, 40) || ''
    temporaryNavigationRef.current = true
    setDocumentMode('read')
    setLocalSearchKeyword(keyword)
    setDocumentSearchSession(target.searchSession)
    setCurrentMatchIndex(target.searchSession?.activeHitIndex ?? -1)
    setActiveBoxIndex(-1)
    setCurrentPageIndex(targetPageIndex)
    setReaderPageIndex(targetPageIndex)
    if (target.revealToc) setReaderTocOpen(true)
  }, [documentId, initialPageIndex, onOpenDocument])
  const activeTranslationGlossaryProjectId = translationGlossaryProjectId || null
  const translationGlossaryCacheSignature = `${activeTranslationGlossaryProjectId || 'global'}:${translationGlossarySignature || 'none'}`
  const getTranslationSourceHash = useCallback((pageId: string, sourceText: string) => (
    buildTranslationCacheKey({
      docId: doc?.id || documentId,
      pageId,
      sourceText,
      modelSignature: translationModelSignature,
      glossarySignature: translationGlossaryCacheSignature,
      style: DEFAULT_TRANSLATION_STYLE,
    })
  ), [doc?.id, documentId, translationGlossaryCacheSignature, translationModelSignature])

  const findTranslationCacheMatch = useCallback((rows: PageTranslationCacheItem[], pageId: string, sourceText: string): TranslationCacheMatch | null => {
    const sourceHash = getTranslationSourceHash(pageId, sourceText)
    const canUseSkippedCache = !shouldTranslatePageText(sourceText).shouldTranslate
    const readyRows = (rows || []).filter((row) => (
      String(row?.page_id || '') === pageId
      && row?.status === 'ready'
      && !!String(row?.translation_text || '').trim()
    ))
    const exactRows = readyRows.filter((row) => String(row?.source_hash || '') === sourceHash)
    for (const row of exactRows) {
      if (row.skipped && canUseSkippedCache) return { row, sourceHash }
      if (!row.skipped && isParallelTranslationDisplayReady(sourceText, String(row.translation_text || ''))) {
        return { row, sourceHash }
      }
    }
    const normalizedSourceText = normalizeTranslationSourceText(sourceText)
    const skippedRows = readyRows.filter((row) => (
      String(row?.source_hash || '') !== sourceHash
      && row.skipped
      && canUseSkippedCache
    ))
    for (const row of skippedRows) {
      const cachedSourceText = String(row.source_text || '').trim()
      if (cachedSourceText && normalizeTranslationSourceText(cachedSourceText) === normalizedSourceText) {
        return { row, sourceHash }
      }
    }
    const compatibleRows = readyRows.filter((row) => (
      String(row?.source_hash || '') !== sourceHash
      && !row.skipped
    )).sort((left, right) => {
      const leftSameModel = String(left.model || '').trim() === translationModelSignature ? 1 : 0
      const rightSameModel = String(right.model || '').trim() === translationModelSignature ? 1 : 0
      return rightSameModel - leftSameModel
    })
    for (const row of compatibleRows) {
      const cachedSourceText = String(row.source_text || '').trim()
      const cachedTranslationText = String(row.translation_text || '').trim()
      if (!cachedSourceText || !cachedTranslationText) continue
      if (
        normalizeTranslationSourceText(cachedSourceText) === normalizedSourceText
        && isParallelTranslationDisplayReady(sourceText, cachedTranslationText)
      ) {
        return { row, sourceHash, translationText: cachedTranslationText }
      }
      const projectedText = projectParallelTranslationTextToSource(sourceText, cachedSourceText, cachedTranslationText)
      if (projectedText) return { row, sourceHash, translationText: projectedText }
    }
    return null
  }, [getTranslationSourceHash, translationModelSignature])

  const migrateTranslationCacheMatch = useCallback((pageId: string, pageNum: number, sourceText: string, match: TranslationCacheMatch) => {
    if (!doc?.id || (match.row.source_hash === match.sourceHash && !match.translationText)) return
    const normalizedSourceText = normalizeTranslationSourceText(sourceText)
    void window.api.saveTranslationCache(doc.id, pageId, {
      sourceHash: match.sourceHash,
      sourceText: normalizedSourceText,
      translationText: String(match.translationText || match.row.translation_text || ''),
      skipped: Boolean(match.row.skipped && !match.translationText),
      status: 'ready',
      model: translationModelSignature,
      style: DEFAULT_TRANSLATION_STYLE,
    }).catch((error: unknown) => {
      console.error('Failed to migrate translation cache', error)
    })
  }, [doc?.id, translationModelSignature])

  const hasReadyTranslationForSource = useCallback((pageId: string, sourceText: string) => {
    const units = pageTranslationUnits[pageId] || []
    if (getReadyTranslationTextFromUnits(units)) return true
    const translationText = pageTranslations[pageId]
    if (!pageId || !sourceText || !translationText) return false
    if (pageTranslationHashes[pageId] !== getTranslationSourceHash(pageId, sourceText)) return false
    return !!skippedTranslationPageIds[pageId] || isParallelTranslationDisplayReady(sourceText, translationText)
  }, [getTranslationSourceHash, pageTranslationHashes, pageTranslationUnits, pageTranslations, skippedTranslationPageIds])

  const clearReaderTranslationRuntime = useCallback(() => {
    translationTaskIdsRef.current.forEach((taskId) => {
      void window.api.cancelTranslationTask(taskId)
    })
    translationTaskIdsRef.current.clear()
    setPageTranslations({})
    setPageTranslationUnits({})
    setPageTranslationHashes({})
    setSkippedTranslationPageIds({})
    setTranslatingPageIds({})
    translationInFlightRef.current.clear()
    translationInFlightGenerationRef.current.clear()
    translationQueueRef.current = []
    translationCurrentPageIdRef.current = ''
    translationCurrentActiveGenerationRef.current = 0
    translationCurrentGenerationRef.current += 1
  }, [])

  useEffect(() => {
    let active = true
    const loadProjects = async () => {
      try {
        const projects = await window.api.listResearchProjects()
        if (active) setTranslationGlossaryProjects(Array.isArray(projects) ? projects : [])
      } catch (error) {
        console.error('Failed to load research projects for glossary', error)
      }
    }
    void loadProjects()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!startReaderBookTranslation) {
      handledBookTranslationRequestRef.current = ''
      return
    }
    const requestKey = `book-translation:${documentId}`
    if (handledBookTranslationRequestRef.current === requestKey) return
    handledBookTranslationRequestRef.current = requestKey
    setDocumentMode('read')
    void window.api.translateBook(documentId, {
      glossaryProjectId: activeTranslationGlossaryProjectId || null,
      mode: translationMode,
    }).then((result) => {
      if (result?.status === 'running') message.info('这本书已经在翻译中')
      else message.success('已在后台开始整书翻译')
    }).catch((error: unknown) => {
      console.error('Failed to start full-book translation', error)
      message.error(getErrorMessage(error, '启动整书翻译失败'))
    })
  }, [activeTranslationGlossaryProjectId, documentId, startReaderBookTranslation, translationMode])

  useEffect(() => {
    if (!openTranslation || !readerStateReady) return
    const timer = window.setTimeout(() => {
      const toggle = document.querySelector<HTMLInputElement>('[data-reader-translation-toggle="true"]')
      if (toggle && !toggle.checked) toggle.click()
    }, 120)
    return () => window.clearTimeout(timer)
  }, [openTranslation, readerStateReady])

  useEffect(() => {
    let active = true
    const refreshSignature = async () => {
      try {
        const signature = await window.api.getTranslationGlossaryVersionSignature(activeTranslationGlossaryProjectId)
        if (!active) return
        setTranslationGlossarySignature((current) => {
          const next = signature || 'none'
          if (current === next) return current
          clearReaderTranslationRuntime()
          return next
        })
      } catch (error) {
        console.error('Failed to refresh translation glossary signature', error)
        if (active) {
          setTranslationGlossarySignature('none')
        }
      }
    }
    void refreshSignature()
    return () => {
      active = false
    }
  }, [activeTranslationGlossaryProjectId, clearReaderTranslationRuntime])

  useEffect(() => {
    let active = true
    const refreshShortcuts = () => {
      void loadShortcutSettings().then((nextShortcuts) => {
        if (active) setShortcuts(nextShortcuts)
      })
    }
    refreshShortcuts()
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, refreshShortcuts)
    return () => {
      active = false
      window.removeEventListener(SHORTCUTS_CHANGED_EVENT, refreshShortcuts)
    }
  }, [])

  useEffect(() => {
    let active = true
    const refreshTranslationModelSignature = async (detail?: LlmProfileSyncDetail) => {
      try {
        const state = detail?.profiles || detail?.current || detail?.activeId
          ? detail
          : await window.api.listLlmProviderProfiles()
        const signature = getTranslationModelSignatureFromState(state)
        if (!active) return
        setTranslationModelSignature((current) => {
          if (current === signature) return current
          clearReaderTranslationRuntime()
          return signature
        })
      } catch {
        if (active) setTranslationModelSignature('default')
      }
    }
    const handleProfileSync = (event: Event) => {
      void refreshTranslationModelSignature((event as CustomEvent<LlmProfileSyncDetail>).detail)
    }
    void refreshTranslationModelSignature()
    window.addEventListener(LLM_PROFILE_SYNC_EVENT, handleProfileSync)
    return () => {
      active = false
      window.removeEventListener(LLM_PROFILE_SYNC_EVENT, handleProfileSync)
    }
  }, [clearReaderTranslationRuntime])

  const shouldPreferLocalSearchMatches = sourceId === 'search' || sourceId === 'fulltext' || sourceId === 'semantic' || sourceId === 'ai_search'
  const locatorHits = !shouldPreferLocalSearchMatches && documentSearchSession?.query === effectiveSearchKeyword
    ? (documentSearchSession.hits || EMPTY_SEARCH_HITS)
    : EMPTY_SEARCH_HITS
  const readerDocumentSearchSession = useMemo(
    () => alignSearchSessionToLocator(documentSearchSession, locator),
    [documentSearchSession, locator],
  )
  const sortedPages = useMemo(
    () => (doc?.id === documentId && doc.pages
      ? doc.pages
        .filter((page) => isDocumentPageForDoc(page, doc.id))
        .sort((left, right) => left.page_num - right.page_num)
      : []),
    [doc, documentId],
  )
  const getAdjacentTranslationContext = useCallback((pageId: string, direction: -1 | 1) => {
    const pageIndex = sortedPages.findIndex((page) => page.id === pageId)
    const contextPage = pageIndex >= 0 ? sortedPages[pageIndex + direction] : null
    return contextPage ? getTranslationSourceText(contextPage).slice(0, 360) : ''
  }, [sortedPages])
  const pageCount = sortedPages.length
  const currentPage = sortedPages[currentPageIndex]
  const nextSpreadPage = sortedPages[currentPageIndex + 1]
  const ocrFailedPageEntries = useMemo(
    () => sortedPages
      .map((page, pageIndex) => ({ page, pageIndex }))
      .filter(({ page }) => String(page.ocr_status || '').trim() === 'error'),
    [sortedPages],
  )
  const ocrFailedPageLabel = useMemo(() => {
    const nums = [...new Set(
      ocrFailedPageEntries
        .map(({ page }) => Math.floor(Number(page.page_num || 0)))
        .filter((value) => Number.isFinite(value) && value > 0),
    )].sort((left, right) => left - right)
    if (nums.length === 0) return ''
    const parts: string[] = []
    let start = nums[0]
    let end = nums[0]
    for (let index = 1; index <= nums.length; index += 1) {
      const current = nums[index]
      if (current === end + 1) {
        end = current
        continue
      }
      parts.push(start === end ? `${start}` : `${start}-${end}`)
      start = current
      end = current
    }
    return parts.join('、')
  }, [ocrFailedPageEntries])
  const jumpToOcrFailedBirdseye = useCallback(() => {
    setDocumentMode('proof')
    setPageViewMode('bird')
    if (ocrFailedPageEntries[0]) {
      setCurrentPageIndex(clampPageIndex(ocrFailedPageEntries[0].pageIndex, pageCount))
    }
  }, [ocrFailedPageEntries, pageCount])
  const ocrResultObj = useMemo(() => parseMaybeJson(currentPage?.ocr_result), [currentPage])
  const proofingOcrResultObj = useMemo(() => getProofingOcrResult(currentPage), [currentPage])
  const facsimileOcrResultObj = useMemo(
    () => chooseFacsimileOcrResult(ocrResultObj, proofingOcrResultObj),
    [ocrResultObj, proofingOcrResultObj],
  )
  const editableFacsimileOcrResult = useMemo<FacsimileOcrResult>(
    () => facsimileOcrResultObj || {
      source_type: 'manual_layout_empty',
      layout_result: [],
      words_result: [],
    },
    [facsimileOcrResultObj],
  )
  const facsimileTranslationSourceText = useMemo(
    () => getFacsimileTranslationSourceText(facsimileOcrResultObj),
    [facsimileOcrResultObj],
  )
  const docMetadataObj = useMemo(() => parseMaybeJson(doc?.metadata) || {}, [doc?.metadata])
  const layoutBoxes = useMemo(() => (currentPage ? getOrderedOcrBlocks(currentPage) as FacsimileLayoutBlock[] : []), [currentPage])
  const textFlowBoxes = useMemo(() => (currentPage ? getTextFlowOcrBlocks(currentPage) as FacsimileLayoutBlock[] : []), [currentPage])
  const layoutToTextFlowBoxIndex = useMemo(() => buildBoxIndexMap(layoutBoxes, textFlowBoxes), [layoutBoxes, textFlowBoxes])
  const textFlowToLayoutBoxIndex = useMemo(() => buildBoxIndexMap(textFlowBoxes, layoutBoxes), [layoutBoxes, textFlowBoxes])
  const activeTextEditorBoxIndex = activeBoxIndex >= 0 ? getMappedBoxIndex(layoutToTextFlowBoxIndex, activeBoxIndex) : -1
  const handleTextEditorLineFocus = useCallback((textFlowIndex: number, textFlowBox?: FacsimileLayoutBlock) => {
    if (textFlowBox) {
      const layoutIndex = findBoxIndexByIdentity(layoutBoxes, textFlowBox)
      if (layoutIndex >= 0) {
        setActiveBoxIndex(layoutIndex)
        return
      }
    }
    setActiveBoxIndex(getMappedBoxIndex(textFlowToLayoutBoxIndex, textFlowIndex))
  }, [layoutBoxes, textFlowToLayoutBoxIndex])
  const imageCoordinateSourceSize = useMemo(
    () => getOcrCoordinateSourceSize(proofingOcrResultObj || ocrResultObj),
    [ocrResultObj, proofingOcrResultObj],
  )
  const facsimileCoordinateSourceSize = useMemo(
    () => getOcrCoordinateSourceSize(facsimileOcrResultObj),
    [facsimileOcrResultObj],
  )
  const resultText = currentPage?.ocr_text || ''
  const shouldPreferSourcePageReader = documentMode === 'read' && (
    readRecordValue(ocrResultObj, 'source_type') === 'ebook_section'
    || readRecordValue(ocrResultObj, 'source_type') === 'ebook_text'
    || !!readRecordValue(docMetadataObj, 'ebook_manifest')
    || readRecordValue(docMetadataObj, 'file_kind') === 'ebook'
    || readRecordValue(docMetadataObj, 'file_kind') === 'text'
  )
  const hasAnyOcrText = useMemo(
    () => sortedPages.some(hasReadablePageTextCandidate),
    [sortedPages],
  )
  const isGujiDocument = doc?.doc_type === '\u53e4\u7c4d'
  const isCurrentPageVerticalLayout = useMemo(
    () => hasVerticalPageSignals(layoutBoxes),
    [layoutBoxes],
  )
  const shouldUseVerticalOcr = isGujiDocument || isCurrentPageVerticalLayout
  const facsimileProofCandidate = useMemo(
    () => isFacsimileProofCandidate(doc, currentPage, facsimileOcrResultObj),
    [currentPage, doc, facsimileOcrResultObj],
  )
  const currentPageProofStatus = currentPage?.proof_status === 'completed' ? 'completed' : 'pending'
  const currentPageOcrQuality = useMemo(
    () => getOrBuildOcrPageIr(ocrResultObj, { pageIndex: Number(currentPage?.page_num || 0) || 1 })?.page.quality || null,
    [currentPage?.page_num, ocrResultObj],
  )
  const currentPageRegionCandidateCount = useMemo(() => {
    const ir = getOrBuildOcrPageIr(ocrResultObj, { pageIndex: Number(currentPage?.page_num || 0) || 1 })
    return ir ? getOcrRegionRerecognitionCandidates(ir, 20).length : 0
  }, [currentPage?.page_num, ocrResultObj])
  const currentPageLayoutAttention = !!currentPage?.needs_layout_attention
  const metadataOcrEngine = readRecordValue(docMetadataObj, 'ocr_engine')
  const currentOcrEngine = isOcrEngine(metadataOcrEngine) ? metadataOcrEngine : 'paddle'
  const activeOcrVersion = pageOcrVersions.find((version) => Number(version.is_active) === 1)
  const currentOcrEngineForUi = activeOcrVersion?.engine || currentOcrEngine
  const ocrSwitchableVersions = pageOcrVersions.filter((version) => version.status === 'completed')
  const isPdfSource = !!doc?.file_path && String(doc.file_path).toLowerCase().endsWith('.pdf')
  const pdfAssetState = String(readRecordValue(docMetadataObj, 'pdf_asset_state') || '').trim()
  const isTextOnlyPdf = pdfAssetState === 'text_only'
  /** text_only + unknown: both need restore / manual PDF pick (unknown often lacks fingerprint until first manual restore). */
  const needsPdfAssetRestore = isTextOnlyPdf || pdfAssetState === 'unknown'
  const hasCurrentPageImage = !!currentPage?.image_path || !!imageDataUrl
  const isTextDocumentType = readRecordValue(docMetadataObj, 'file_kind') === 'ebook' || readRecordValue(docMetadataObj, 'file_kind') === 'text'
  const readerPageTranslations = useMemo(() => {
    const next: Record<string, string> = {}
    sortedPages.forEach((page) => {
      const pageId = String(page?.id || '')
      const sourceText = getTranslationSourceText(page)
      if (!pageId || !sourceText || !pageTranslations[pageId]) return
      if (pageTranslationHashes[pageId] === getTranslationSourceHash(pageId, sourceText)) {
        const translationText = pageTranslations[pageId]
        if (skippedTranslationPageIds[pageId] || isParallelTranslationDisplayReady(sourceText, translationText)) {
          next[pageId] = translationText
        }
      }
    })
    return next
  }, [getTranslationSourceHash, pageTranslationHashes, pageTranslations, skippedTranslationPageIds, sortedPages])
  const sourceReaderPageTranslations = useMemo(() => {
    const next = { ...readerPageTranslations }
    sortedPages.forEach((page) => {
      const pageId = String(page?.id || '')
      const sourceText = normalizeTranslationSourceText(getTranslationSourceText(page))
      const translationText = pageTranslations[pageId]
      if (!pageId || !sourceText || !translationText) return
      if (pageTranslationHashes[pageId] !== getTranslationSourceHash(pageId, sourceText)) return
      if (skippedTranslationPageIds[pageId] || isParallelTranslationDisplayReady(sourceText, translationText)) {
        next[pageId] = translationText
      }
    })
    Object.entries(pageTranslations).forEach(([pageId, translationText]) => {
      if (/^ebook-virtual-\d+$/.test(pageId) && String(translationText || '').trim()) {
        next[pageId] = translationText
      }
    })
    return next
  }, [getTranslationSourceHash, pageTranslationHashes, pageTranslations, readerPageTranslations, skippedTranslationPageIds, sortedPages])
  const currentFacsimileTranslationReady = !!currentPage?.id
    && !!facsimileTranslationSourceText
    && hasReadyTranslationForSource(currentPage.id, facsimileTranslationSourceText)
  const currentFacsimileTranslationText = currentPage?.id && currentFacsimileTranslationReady
    ? pageTranslations[currentPage.id] || ''
    : ''
  const currentFacsimileTranslationSkipped = currentPage?.id && currentFacsimileTranslationReady
    ? !!skippedTranslationPageIds[currentPage.id]
    : false
  const isEbookDocument = isManagedTextDocument(doc, sortedPages)
  const hasCurrentPageReadableText = hasReadablePageTextCandidate(currentPage)
  const canUseManualFacsimileLayout = facsimileProofCandidate
    || (!!currentPage && !isEbookDocument && !isTextDocumentType && hasCurrentPageImage)
  const hasOcrReaderCandidate = hasAnyOcrText && !isEbookDocument && documentMode === 'read'
  const shouldUseEbookReader = !!currentPage
    && documentMode === 'read'
    && hasCurrentPageReadableText
    && isEbookDocument
  const shouldUseOcrSourceReader = !!currentPage
    && documentMode === 'read'
    && (hasCurrentPageReadableText || hasOcrReaderCandidate)
    && !shouldUseEbookReader
    && hasAnyOcrText
  const shouldUseSourcePageReader = shouldUseOcrSourceReader
  const shouldUseTextReaderMode = !!currentPage
    && documentMode === 'read'
    && hasCurrentPageReadableText
    && !shouldUseEbookReader
    && !shouldUseOcrSourceReader
    && isTextDocumentType
  const shouldUseManagedTextReader = shouldUseEbookReader || shouldUseTextReaderMode || shouldUseOcrSourceReader
  const shouldUseProofLayout = documentMode === 'proof'
  const shouldUseImageReaderMode = documentMode === 'read' && !shouldUseManagedTextReader
  // Book-style text preview is only for pure-text reading without images.
  // Never use it in proof mode (left pane must be original image or a clear empty state).
  const shouldShowBookPreview = documentMode === 'read'
    && shouldUseImageReaderMode
    && !!currentPage
    && !isPdfSource
    && !hasCurrentPageImage
    && !pageImageLoading
    && !!getPageDisplayText(currentPage)
  const canAttemptPageImageRecovery = isPdfSource || needsPdfAssetRestore || !!String(doc?.file_path || '').trim()
  const readerVirtualPages = useMemo(
    () => documentMode !== 'read' || shouldPreferSourcePageReader
      ? []
      : buildReaderPages(sortedPages, readerFontSize, readerLineHeight, readerPageWidth, readerViewportHeight),
    [documentMode, readerFontSize, readerLineHeight, readerPageWidth, readerViewportHeight, shouldPreferSourcePageReader, sortedPages],
  )
  const readerVirtualPageCount = readerVirtualPages.length
  const readerCurrentPage = readerVirtualPages[readerPageIndex]
  const readerNextPage = readerVirtualPages[readerPageIndex + 1]
  const proofSearchFallbackPage = useMemo(
    () => documentMode === 'proof' && readerSearchPages.length === 0 && currentPage
      ? { page: currentPage, pageIndex: currentPageIndex }
      : null,
    [currentPage, currentPageIndex, documentMode, readerSearchPages.length],
  )
  sortedPagesRef.current = sortedPages
  pageCountRef.current = pageCount
  readerVirtualPagesRef.current = readerVirtualPages
  isEbookDocumentRef.current = isEbookDocument
  const textReaderMatches = useMemo<SearchMatch[]>(() => {
    if (locatorHits.length === 0) return []
    const matches: SearchMatch[] = []
    locatorHits.forEach((hit, hitIndex) => {
        const locator = hit.locator
        const virtualIndex = readerVirtualPages.findIndex((page) => {
          const samePage = (locator.pageId && String(locator.pageId) === String(page.sourcePageId))
            || (locator.pageNum && locator.pageNum === page.sourcePageNum)
            || (typeof locator.pageIndex === 'number' && locator.pageIndex === page.sourcePageIndex)
          if (!samePage) return false
          return locator.charStart >= page.sourceStartChar && locator.charStart <= page.sourceEndChar
        })
        const pageIndex = virtualIndex >= 0
          ? virtualIndex
          : readerVirtualPages.findIndex((page) => (
            (locator.pageNum && locator.pageNum === page.sourcePageNum)
            || (typeof locator.pageIndex === 'number' && locator.pageIndex === page.sourcePageIndex)
          ))
        if (pageIndex < 0) return
        const page = readerVirtualPages[pageIndex]
        matches.push({
          pageIndex,
          boxIndex: -1,
          charIndex: Math.max(0, locator.charStart - page.sourceStartChar),
          boxTop: Number.MAX_SAFE_INTEGER,
          boxLeft: Number.MAX_SAFE_INTEGER,
          keyword: locator.queryTerm || effectiveSearchKeyword || locator.matchText,
          hitIndex,
          locator,
        })
      })
    return matches
  }, [effectiveSearchKeyword, locatorHits, readerVirtualPages])
  const readerTocItems = useMemo<ReaderTocItem[]>(() => {
    if (documentMode !== 'read') return []
    if (shouldPreferSourcePageReader) return []
    const items: ReaderTocItem[] = []
    const looksLikeReaderHeading = (line: string) => line.length <= 44 && !/^\d+$/.test(line) && (/^#{1,6}\s+/.test(line) || /^\s*(?:\d+|[IVXLCDM]+)[.)??]\s+\S+/i.test(line) || line.length <= 16)

    sortedPages.forEach((page, pageIndex) => {
      const lines = getPageDisplayText(page)
        .split(/\n+/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      const heading = lines.find((line) => {
        if (line.length > 44) return false
        if (/^\d+$/.test(line)) return false
        return looksLikeReaderHeading(line)
      })
      if (!heading) return
      const level = /^#{1,2}\s+/.test(heading) ? 1 : /^#{3}\s+/.test(heading) ? 2 : 3
      if (items.some((item) => item.title === heading && Math.abs(item.pageIndex - pageIndex) <= 2)) return
      items.push({ pageIndex, pageNum: page.page_num || pageIndex + 1, title: heading, level })
    })

    if (items.length >= 3) return items.slice(0, 240)
    return sortedPages
      .filter((_page, pageIndex) => pageIndex % 10 === 0 || pageIndex === sortedPages.length - 1)
      .map((page, index) => ({
        pageIndex: sortedPages.findIndex((item) => item.id === page.id),
        pageNum: page.page_num || index + 1,
        title: `? ${page.page_num || index + 1} ?`,
        level: 3,
      }))
  }, [documentMode, shouldPreferSourcePageReader, sortedPages])

  const isVectorReaderSearch = readerSearchEngine === 'vector' || documentSearchSession?.engine === 'vector'

  const searchMatches = useMemo<SearchMatch[]>(() => {
    if (shouldPreferSourcePageReader) return []

    // Vector session hits (proof mode): never fall back to keyword FTS for the match list.
    const vectorHits = (
      isVectorReaderSearch
      && documentSearchSession?.query === effectiveSearchKeyword
      && (documentSearchSession.hits?.length || 0) > 0
    )
      ? documentSearchSession.hits
      : null

    const sessionHits = vectorHits || (locatorHits.length > 0 ? locatorHits : null)
    if (sessionHits && sessionHits.length > 0) {
      return sessionHits
        .map((hit, hitIndex) => {
          const locator = hit.locator
          const pageIndex = resolveLocatorPageIndex(sortedPages, locator)
          const box = findBoxForLocator(sortedPages[pageIndex], locator, effectiveSearchKeyword)
          const matchText = String(locator.matchText || hit.snippet || '').replace(/\s+/g, ' ').trim()
          // Facsimile highlighter matches short substrings; head-3 works for whole-block yellow tint.
          const highlightKeyword = isVectorReaderSearch && matchText.length >= 3
            ? matchText.slice(0, 3)
            : (locator.queryTerm || effectiveSearchKeyword || matchText)
          return {
            pageIndex,
            boxIndex: box.boxIndex,
            charIndex: Number(locator.charStart || 0),
            boxTop: box.boxTop,
            boxLeft: box.boxLeft,
            keyword: highlightKeyword,
            hitIndex,
            boxOccurrenceIndex: box.boxOccurrenceIndex,
            locator,
          }
        })
        .sort((left, right) => (
          left.pageIndex - right.pageIndex
          || (left.locator?.segmentOrdinal || 0) - (right.locator?.segmentOrdinal || 0)
          || left.boxTop - right.boxTop
          || left.boxLeft - right.boxLeft
          || left.charIndex - right.charIndex
        ))
    }

    // Vector mode with no hits yet (searching/empty): do not invent keyword matches.
    if (isVectorReaderSearch) return []

    if (!effectiveSearchKeyword.trim()) return []
    const matches: SearchMatch[] = []
    const pagesToSearch: Array<{ page: DocumentViewPage; pageIndex: number }> = documentMode === 'proof'
      ? (readerSearchPages.length > 0
        ? readerSearchPages.map((page, fallbackIndex) => {
          const sortedIndex = sortedPages.findIndex((item) => String(item.id) === String(page.id))
          return {
            page,
            pageIndex: sortedIndex >= 0
              ? sortedIndex
              : clampPageIndex(Number(page.page_num || fallbackIndex + 1) - 1, pageCount),
          }
        })
        : (proofSearchFallbackPage ? [proofSearchFallbackPage] : []))
      : sortedPages.map((page, pageIndex) => ({ page, pageIndex }))

    pagesToSearch.forEach(({ page, pageIndex }) => {
      const text = String(page.proofed_text || page.ocr_text || '')
      const pageHits = findSearchOccurrences(text, effectiveSearchKeyword)
      if (pageHits.length === 0) return

      const boxes = getTextFlowOcrBlocks(page) as FacsimileLayoutBlock[]
      const textFlowToLayoutIndex = buildBoxIndexMap(boxes, getOrderedOcrBlocks(page) as FacsimileLayoutBlock[])
      let boxHitCount = 0
      boxes.forEach((box, boxIndex) => {
        const boxText = getBoxText(box)
        const boxHits = findSearchOccurrences(boxText, effectiveSearchKeyword)
        if (boxHits.length === 0) return
        boxHitCount += boxHits.length
        const point = getBoxSortPoint(box)
        boxHits.forEach((hit, boxOccurrenceIndex) => {
          matches.push({
            pageIndex,
            boxIndex: getMappedBoxIndex(textFlowToLayoutIndex, boxIndex),
            textFlowIndex: boxIndex,
            charIndex: hit.charIndex,
            boxTop: point.top,
            boxLeft: point.left,
            keyword: hit.keyword,
            boxOccurrenceIndex,
          })
        })
      })

      if (boxes.length === 0 || boxHitCount === 0) {
        pageHits.forEach((hit) => {
          matches.push({
            pageIndex,
            boxIndex: -1,
            charIndex: hit.charIndex,
            boxTop: Number.MAX_SAFE_INTEGER,
            boxLeft: Number.MAX_SAFE_INTEGER,
            keyword: hit.keyword,
          })
        })
      }
    })

    return matches.sort((left, right) => (
      left.pageIndex - right.pageIndex
      || (left.textFlowIndex ?? Number.MAX_SAFE_INTEGER) - (right.textFlowIndex ?? Number.MAX_SAFE_INTEGER)
      || left.boxTop - right.boxTop
      || left.boxLeft - right.boxLeft
      || left.boxIndex - right.boxIndex
      || left.charIndex - right.charIndex
    ))
  }, [documentMode, documentSearchSession?.engine, documentSearchSession?.hits, documentSearchSession?.query, effectiveSearchKeyword, isVectorReaderSearch, locatorHits, pageCount, proofSearchFallbackPage, readerSearchPages, shouldPreferSourcePageReader, sortedPages])
  const activeProofSearchHitOrdinal = useMemo(() => {
    if (documentMode !== 'proof') return -1
    if (currentMatchIndex < 0 || currentMatchIndex >= searchMatches.length) return -1
    const selectedMatch = searchMatches[currentMatchIndex]
    if (!selectedMatch || selectedMatch.pageIndex !== currentPageIndex || selectedMatch.boxIndex < 0) return -1
    if (Number.isFinite(Number(selectedMatch.boxOccurrenceIndex))) {
      return Number(selectedMatch.boxOccurrenceIndex)
    }
    return searchMatches
      .slice(0, currentMatchIndex)
      .filter((match) => match.pageIndex === selectedMatch.pageIndex && match.boxIndex === selectedMatch.boxIndex)
      .length
  }, [currentMatchIndex, currentPageIndex, documentMode, searchMatches])

  const mergeDocumentPages = useCallback((nextPages: DocumentPage[], targetDocId = documentId, retainedPageIndex = 0) => {
    if (!Array.isArray(nextPages) || nextPages.length === 0) return
    const safePages = nextPages.filter((page) => isDocumentPageForDoc(page, targetDocId))
    if (safePages.length === 0) return
    setDoc((previous) => {
      if (!previous?.pages || previous.id !== targetDocId || activeDocumentIdRef.current !== targetDocId) return previous
      const pageMap = new Map(previous.pages.map((page) => [String(page.id), page]))
      safePages.forEach((page) => {
        pageMap.set(String(page.id), normalizeDocumentPage({ ...(pageMap.get(String(page.id)) || {}), ...page }))
      })
      const mergedPages = Array.from(pageMap.values()).sort((left, right) => Number(left.page_num || 0) - Number(right.page_num || 0))
      return {
        ...previous,
        pages: retainDocumentPagePayloadWindow(mergedPages, retainedPageIndex, READER_FULL_PAGE_RETENTION_RADIUS),
      }
    })
  }, [documentId])

  const requestDocumentPageWindow = useCallback((targetDocId: string, pageIndex: number, radius: number): Promise<DocumentPage[]> => {
    const requestKey = `${targetDocId}:${pageIndex}:${radius}`
    const existingRequest = pageRangeInFlightRef.current.get(requestKey)
    if (existingRequest) return existingRequest
    const startPageNum = Math.max(1, pageIndex + 1 - radius)
    const endPageNum = pageIndex + 1 + radius
    const request = window.api.getDocumentReadingWindow(targetDocId, pageIndex, radius)
      .then((readingWindow) => Array.isArray(readingWindow?.pages)
        ? readingWindow.pages
        : window.api.getDocumentPagesRange(targetDocId, startPageNum, endPageNum))
      .finally(() => {
        if (pageRangeInFlightRef.current.get(requestKey) === request) {
          pageRangeInFlightRef.current.delete(requestKey)
        }
      })
    pageRangeInFlightRef.current.set(requestKey, request)
    return request
  }, [])

  const loadPagesAround = useCallback(async (pageIndex: number, radius = 3) => {
    if (!documentId) return
    const targetDocId = documentId
    const requestId = ++pageRangeRequestRef.current
    try {
      const pages = await requestDocumentPageWindow(targetDocId, pageIndex, radius)
      if (activeDocumentIdRef.current !== targetDocId) return
      if (requestId !== pageRangeRequestRef.current) return
      mergeDocumentPages(pages, targetDocId, pageIndex)
    } catch (error) {
      console.error('Failed to load page range', error)
    }
  }, [documentId, mergeDocumentPages, requestDocumentPageWindow])

  const loadProofPageWindow = useCallback(async (pageIndex: number) => {
    if (!documentId) return
    const targetDocId = documentId
    const requestId = ++pageRangeRequestRef.current
    const radius = PROOF_PAGE_WINDOW_RADIUS
    try {
      const pages = await requestDocumentPageWindow(targetDocId, pageIndex, radius)
      if (activeDocumentIdRef.current !== targetDocId) return
      if (requestId !== pageRangeRequestRef.current) return
      mergeDocumentPages(pages, targetDocId, pageIndex)
    } catch (error) {
      console.error('Failed to load proof page window', error)
    }
  }, [documentId, mergeDocumentPages, requestDocumentPageWindow])

  const loadDocument = useCallback(async () => {
    const targetDocId = documentId
    setLoading(true)
    try {
      const data = await window.api.getDocumentLight(targetDocId)
      if (activeDocumentIdRef.current !== targetDocId) return
      const normalizedDoc = normalizeDocumentDetail(data, targetDocId)
      if (!normalizedDoc) {
        throw new Error('Document detail is empty')
      }
      setDoc(normalizedDoc)
      const targetIndex = resolveStableLocatorPageIndex(normalizedDoc.pages || [], stableLocator, locator, initialPageIndex)
      // First paint with a smaller window, then expand for adjacent-page readiness.
      // Completeness is unchanged: any page is still loaded on demand when navigated.
      void loadPagesAround(targetIndex, 2).then(() => {
        if (activeDocumentIdRef.current !== targetDocId) return
        window.setTimeout(() => {
          if (activeDocumentIdRef.current !== targetDocId) return
          void loadPagesAround(targetIndex, 4)
        }, 280)
      })
    } catch (error) {
      console.error(error)
      message.error('加载文献详情失败')
    } finally {
      if (activeDocumentIdRef.current === targetDocId) setLoading(false)
    }
  }, [documentId, initialPageIndex, loadPagesAround, locator, stableLocator])

  const saveReaderStateSoon = useCallback((state: ReaderStateSavePayload) => {
    if (temporaryNavigationRef.current) return
    latestReaderStateRef.current = { ...latestReaderStateRef.current, ...state }
    if (readerSaveTimerRef.current) {
      window.clearTimeout(readerSaveTimerRef.current)
    }
    readerSaveTimerRef.current = window.setTimeout(() => {
      readerSaveTimerRef.current = null
      void window.api.saveReaderState(documentId, latestReaderStateRef.current).catch((error: unknown) => {
        console.error('Failed to save reader state', error)
      })
    }, 450)
  }, [documentId])

  const saveReaderStateNow = useCallback((state: ReaderStateSavePayload) => {
    if (temporaryNavigationRef.current) return
    if (readerSaveTimerRef.current) {
      window.clearTimeout(readerSaveTimerRef.current)
      readerSaveTimerRef.current = null
    }
    latestReaderStateRef.current = { ...latestReaderStateRef.current, ...state }
    void window.api.saveReaderState(documentId, latestReaderStateRef.current).catch((error: unknown) => {
      console.error('Failed to save reader state', error)
    })
  }, [documentId])

  const buildPageReaderState = useCallback((pageIndex: number): ReaderStateSavePayload | null => {
    if (!doc?.id || pageCount === 0) return null
    const nextIndex = clampPageIndex(pageIndex, pageCount)
    const page = sortedPages[nextIndex] || (nextIndex === currentPageIndex ? currentPage : null)
    return {
      document_mode: 'read',
      location_key: `page:${page?.page_num || nextIndex + 1}`,
      progress: pageCount <= 1 ? 1 : nextIndex / Math.max(1, pageCount - 1),
      view_mode: readerViewMode,
      font_size: readerFontSize,
      line_height: readerLineHeight,
      theme: readerTheme,
    }
  }, [currentPage, currentPageIndex, doc?.id, pageCount, readerFontSize, readerLineHeight, readerTheme, readerViewMode, sortedPages])

  const buildTextReaderState = useCallback((pageIndex: number): ReaderStateSavePayload | null => {
    if (!doc?.id || readerVirtualPageCount === 0) return null
    const nextIndex = clampPageIndex(pageIndex, readerVirtualPageCount)
    const page = readerVirtualPages[nextIndex]
    if (!page) return null
    return {
      document_mode: 'read',
      location_key: `text-reader:${nextIndex + 1}`,
      progress: readerVirtualPageCount <= 1 ? 1 : nextIndex / Math.max(1, readerVirtualPageCount - 1),
      view_mode: readerViewMode,
      font_size: readerFontSize,
      line_height: readerLineHeight,
      theme: readerTheme,
    }
  }, [doc?.id, readerFontSize, readerLineHeight, readerTheme, readerViewMode, readerVirtualPageCount, readerVirtualPages])

  const buildProofReaderState = useCallback((pageIndex: number): ReaderStateSavePayload | null => {
    if (!doc?.id || pageCount === 0) return null
    const nextIndex = clampPageIndex(pageIndex, pageCount)
    const page = sortedPages[nextIndex] || (nextIndex === currentPageIndex ? currentPage : null)
    return {
      document_mode: 'proof',
      proof_location_key: `page:${page?.page_num || nextIndex + 1}`,
      proof_progress: pageCount <= 1 ? 1 : nextIndex / Math.max(1, pageCount - 1),
      proof_view_mode: proofViewMode,
      font_size: readerFontSize,
      line_height: readerLineHeight,
      theme: readerTheme,
    }
  }, [currentPage, currentPageIndex, doc?.id, pageCount, proofViewMode, readerFontSize, readerLineHeight, readerTheme, sortedPages])

  const getCurrentReaderState = useCallback((): ReaderStateSavePayload | null => {
    if (!doc?.id) return null
    if (documentMode === 'proof') return buildProofReaderState(currentPageIndex)
    if (shouldUseTextReaderMode) return buildTextReaderState(readerPageIndex)
    if (shouldUseSourcePageReader) return buildPageReaderState(readerVisiblePageIndexRef.current ?? currentPageIndex)
    if (shouldUseManagedTextReader && latestReaderStateRef.current.location_key) return latestReaderStateRef.current
    return buildPageReaderState(readerVisiblePageIndexRef.current ?? currentPageIndex)
  }, [
    buildPageReaderState,
    buildProofReaderState,
    buildTextReaderState,
    currentPageIndex,
    documentMode,
    doc?.id,
    readerPageIndex,
    shouldUseManagedTextReader,
    shouldUseSourcePageReader,
    shouldUseTextReaderMode,
  ])

  const flushReaderStateNow = useCallback(async (state?: ReaderStateSavePayload) => {
    if (temporaryNavigationRef.current) return
    const nextState = { ...latestReaderStateRef.current, ...(state || {}) }
    if (!nextState.location_key && !nextState.proof_location_key) return
    latestReaderStateRef.current = nextState
    if (readerSaveTimerRef.current) {
      window.clearTimeout(readerSaveTimerRef.current)
      readerSaveTimerRef.current = null
    }
    try {
      await window.api.saveReaderState(documentId, nextState)
    } catch (error) {
      console.error('Failed to flush reader state', error)
    }
  }, [documentId])

  const handleBack = useCallback(async () => {
    await flushReaderStateNow(getCurrentReaderState() || undefined)
    onBack()
  }, [flushReaderStateNow, getCurrentReaderState, onBack])

  const refreshDocumentKeepPage = useCallback(async (targetPageId?: string) => {
    const targetDocId = documentId
    const manifest = await window.api.getDocumentLight(targetDocId)
    if (activeDocumentIdRef.current !== targetDocId) return null
    const normalizedManifest = normalizeDocumentDetail(manifest, targetDocId)
    if (!normalizedManifest) return null
    const targetIndex = targetPageId
      ? Math.max(0, normalizedManifest.pages.findIndex((page) => page.id === targetPageId))
      : clampPageIndex(currentPageIndex, normalizedManifest.pages.length)
    const readingWindow = await window.api.getDocumentReadingWindow(targetDocId, targetIndex, 4)
    if (activeDocumentIdRef.current !== targetDocId) return null
    const pageMap = new Map(normalizedManifest.pages.map((page) => [String(page.id), page]))
    for (const page of readingWindow?.pages || []) {
      if (!isDocumentPageForDoc(page, targetDocId)) continue
      const existing = pageMap.get(String(page.id))
      pageMap.set(String(page.id), normalizeDocumentPage({ ...(existing || {}), ...page }))
    }
    const normalized: DocumentViewDocument = {
      ...normalizedManifest,
      pages: retainDocumentPagePayloadWindow(
        Array.from(pageMap.values()).sort((left, right) => left.page_num - right.page_num),
        targetIndex,
        READER_FULL_PAGE_RETENTION_RADIUS,
      ),
    }
    setDoc(normalized)
    if (targetPageId) {
      const nextPages = [...normalized.pages].sort((left, right) => left.page_num - right.page_num)
      const nextIndex = nextPages.findIndex((page) => page.id === targetPageId)
      if (nextIndex >= 0) {
        setCurrentPageIndex(nextIndex)
      }
    }
    return normalized
  }, [currentPageIndex, documentId])

  const loadCurrentPageOcrVersions = useCallback(async (pageId?: string) => {
    if (!pageId) {
      setPageOcrVersions([])
      return
    }
    setOcrVersionLoading(true)
    try {
      const versions = await window.api.listPageOcrVersions(pageId)
      setPageOcrVersions(Array.isArray(versions) ? versions : [])
    } catch (error) {
      console.error('Failed to load OCR versions', error)
      setPageOcrVersions([])
    } finally {
      setOcrVersionLoading(false)
    }
  }, [])

  const loadTranslationCacheForPages = useCallback(async (pages: DocumentViewPage[]) => {
    if (!doc?.id) return
    const targetDocId = doc.id
    const candidates = (pages || [])
      .filter((page) => isDocumentPageForDoc(page, targetDocId) && getTranslationSourceText(page))
    if (candidates.length === 0) return
    try {
      const pageIds = candidates.map((page) => page.id)
      const [rows, unitsByPage] = await Promise.all([
        window.api.getTranslationCache(targetDocId, pageIds),
        window.api.getPagesTranslationUnits(pageIds),
      ])
      if (activeDocumentIdRef.current !== targetDocId) return
      setPageTranslationUnits((current) => ({ ...current, ...unitsByPage }))
      const nextTranslations: Record<string, string> = {}
      const nextHashes: Record<string, string> = {}
      const nextSkipped: Record<string, boolean> = {}
      for (const page of candidates) {
        const pageId = String(page.id || '')
        const sourceText = getTranslationSourceText(page)
        const readyUnitText = getReadyTranslationTextFromUnits(unitsByPage[pageId] || [])
        if (readyUnitText) {
          nextTranslations[pageId] = readyUnitText
          nextHashes[pageId] = getTranslationSourceHash(pageId, sourceText)
          if (areAllTranslationUnitsSkipped(unitsByPage[pageId] || [])) nextSkipped[pageId] = true
          continue
        }
        if (!Array.isArray(rows) || rows.length === 0) continue
        const match = findTranslationCacheMatch(rows, pageId, sourceText)
        if (!match) continue
        nextTranslations[pageId] = String(match.translationText || match.row.translation_text)
        nextHashes[pageId] = match.sourceHash
        if (match.row.skipped && !match.translationText) nextSkipped[pageId] = true
        migrateTranslationCacheMatch(pageId, Number(page.page_num || 0), sourceText, match)
      }
      if (Object.keys(nextTranslations).length === 0) return
      setPageTranslations((current) => ({ ...nextTranslations, ...current }))
      setPageTranslationHashes((current) => ({ ...nextHashes, ...current }))
      setSkippedTranslationPageIds((current) => ({ ...nextSkipped, ...current }))
    } catch (error) {
      console.error('Failed to load translation cache', error)
    }
  }, [doc?.id, findTranslationCacheMatch, migrateTranslationCacheMatch])

  useEffect(() => {
    if (!doc?.id || sortedPages.length === 0) return
    void loadTranslationCacheForPages(sortedPages)
  }, [doc?.id, loadTranslationCacheForPages, sortedPages])

  const restoreTranslationFromCache = useCallback(async (pageId: string, pageNum: number, sourceText: string, cachePageId = pageId) => {
    if (!doc?.id || !pageId || !cachePageId || !sourceText) return false
    const targetDocId = doc.id
    try {
      const [rows, units] = await Promise.all([
        window.api.getTranslationCache(targetDocId, [cachePageId]),
        window.api.getPageTranslationUnits(cachePageId).catch(() => []),
      ])
      if (activeDocumentIdRef.current !== targetDocId) return false
      if (units.length > 0) {
        setPageTranslationUnits((current) => ({ ...current, [pageId]: units }))
      }
      const readyUnitText = getReadyTranslationTextFromUnits(units)
      if (readyUnitText) {
        setPageTranslations((current) => ({ ...current, [pageId]: readyUnitText }))
        setPageTranslationHashes((current) => ({ ...current, [pageId]: getTranslationSourceHash(pageId, sourceText) }))
        setSkippedTranslationPageIds((current) => {
          const next = { ...current }
          if (areAllTranslationUnitsSkipped(units)) next[pageId] = true
          else delete next[pageId]
          return next
        })
        return true
      }
      const match = Array.isArray(rows) ? findTranslationCacheMatch(rows, cachePageId, sourceText) : null
      if (!match) return false
      setPageTranslations((current) => ({ ...current, [pageId]: String(match.translationText || match.row.translation_text) }))
      setPageTranslationHashes((current) => ({ ...current, [pageId]: getTranslationSourceHash(pageId, sourceText) }))
      setSkippedTranslationPageIds((current) => {
        const next = { ...current }
        if (match.row.skipped && !match.translationText) next[pageId] = true
        else delete next[pageId]
        return next
      })
      migrateTranslationCacheMatch(cachePageId, pageNum, sourceText, match)
      return true
    } catch (error) {
      console.error('Failed to restore translation cache', error)
      return false
    }
  }, [doc?.id, findTranslationCacheMatch, getTranslationSourceHash, migrateTranslationCacheMatch])

  useEffect(() => {
    if (documentMode !== 'proof' || proofViewMode !== 'facsimile') return
    if (!currentPage?.id || !facsimileTranslationSourceText.trim()) return
    if (currentFacsimileTranslationReady || translatingPageIds[currentPage.id]) return
    void restoreTranslationFromCache(
      currentPage.id,
      Number(currentPage.page_num || 0),
      facsimileTranslationSourceText,
    )
  }, [
    currentFacsimileTranslationReady,
    currentPage?.id,
    currentPage?.page_num,
    documentMode,
    facsimileTranslationSourceText,
    proofViewMode,
    restoreTranslationFromCache,
    translatingPageIds,
  ])

  const persistTranslationCache = useCallback((pageId: string, pageNum: number, sourceText: string, translationText: string, skipped = false) => {
    if (!doc?.id || !pageId || !sourceText || !translationText) return
    const sourceHash = getTranslationSourceHash(pageId, sourceText)
    const normalizedSourceText = normalizeTranslationSourceText(sourceText)
    void window.api.saveTranslationCache(doc.id, pageId, {
      sourceHash,
      sourceText: normalizedSourceText,
      translationText,
      skipped,
      status: 'ready',
      model: translationModelSignature,
      style: DEFAULT_TRANSLATION_STYLE,
    }).catch((error: unknown) => {
      console.error('Failed to save translation cache', error)
    })
  }, [doc?.id, getTranslationSourceHash, translationModelSignature])

  const translateTextAsParallelSegments = useCallback(async ({
    pageId,
    cachePageId = pageId,
    pageNum,
    sourceText,
    force = false,
    isStale,
  }: ParallelReaderTranslationRequest): Promise<string | null> => {
    if (!doc?.id || !pageId || !sourceText) return null
    if (isStale?.()) return null
    const taskId = `reader-${cachePageId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    translationTaskIdsRef.current.set(pageId, taskId)
    try {
      const result = await window.api.translatePageUnits({
        taskId,
        docId: doc.id,
        pageId: cachePageId,
        mode: translationMode,
        glossaryProjectId: activeTranslationGlossaryProjectId,
        style: DEFAULT_TRANSLATION_STYLE,
        force,
        priority: 'current',
        documentTitle: doc.title || '',
        pageContextBefore: getAdjacentTranslationContext(cachePageId, -1),
        pageContextAfter: getAdjacentTranslationContext(cachePageId, 1),
      })
      if (isStale?.()) return null
      setPageTranslationUnits((current) => ({ ...current, [pageId]: result.units }))
      return result.translationText
    } finally {
      if (translationTaskIdsRef.current.get(pageId) === taskId) {
        translationTaskIdsRef.current.delete(pageId)
      }
    }
  }, [activeTranslationGlossaryProjectId, doc?.id, doc?.title, getAdjacentTranslationContext, translationMode])

  useEffect(() => {
    void loadCurrentPageOcrVersions(currentPage?.id)
  }, [currentPage?.id, loadCurrentPageOcrVersions])

  useEffect(() => {
    let cancelled = false
    const loadProofLayoutPreference = async () => {
      try {
        const [facsimileValue, readModeValue] = await Promise.all([
          window.api.getSetting('prefer_facsimile_proof_layout'),
          window.api.getSetting('prefer_read_mode_on_open'),
        ])
        if (cancelled) return
        setPreferFacsimileProofLayout(facsimileValue !== 'false')
        // Missing key → default true (prefer reading mode on first open).
        const preferRead = readModeValue !== 'false'
        preferReadModeOnOpenRef.current = preferRead
        setPreferReadModeOnOpen(preferRead)
      } catch (error) {
        console.error('Failed to load proof/read layout preference', error)
      }
    }
    void loadProofLayoutPreference()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (documentMode !== 'proof' || proofViewTouched) return
    setProofViewMode(canUseManualFacsimileLayout && preferFacsimileProofLayout ? 'facsimile' : 'text')
  }, [canUseManualFacsimileLayout, documentMode, preferFacsimileProofLayout, proofViewTouched])

  useEffect(() => {
    if (!canUseManualFacsimileLayout && proofViewMode === 'facsimile') {
      setProofViewMode('text')
    }
  }, [canUseManualFacsimileLayout, proofViewMode])

  useLayoutEffect(() => {
    activeDocumentIdRef.current = documentId
    documentModeSwitchSerialRef.current += 1
    const targetDocId = documentId
    setLoading(true)
    setDoc(null)
    setReaderSearchPages([])
    setImageDataUrl('')
    setNextImageDataUrl('')
    setSharedViewport(undefined)
    setActiveBoxIndex(-1)
    setPageOcrVersions([])
    pageImageCacheRef.current.clear()
    pageRangeRequestRef.current += 1
    searchPagesRequestIdRef.current += 1
    clearReaderTranslationRuntime()
    hasInitializedPageRef.current = false
    readerStateLoadedRef.current = false
    documentModeTouchedRef.current = false
    // First open default: reading mode when setting is on (default); proof when off.
    // Per-document reader_state still overrides after user manually toggled mode.
    const defaultMode: DocumentMode = preferReadModeOnOpenRef.current ? 'read' : 'proof'
    intendedDocumentModeRef.current = defaultMode
    const initialTargetPageIndex = resolveStableLocatorPageIndex([], stableLocator, locator, initialPageIndex)
    setCurrentPageIndex(initialTargetPageIndex)
    setReaderPageIndex(initialTargetPageIndex)
    setDocumentMode(defaultMode)
    setProofViewMode('facsimile')
    setProofViewTouched(false)
    setFacsimileTranslationOpen(false)
    setLocalSearchKeyword(highlightExcerpt || searchKeyword)
    setSearchInputDraft(highlightExcerpt || searchKeyword)
    setReaderSearchEngine(searchSession?.engine === 'vector' || sourceId === 'vector-search' ? 'vector' : 'fulltext')
    setInitialReaderLocationKey('')
    setReaderStateReady(false)
    latestReaderStateRef.current = {}
    if (readerSaveTimerRef.current) {
      window.clearTimeout(readerSaveTimerRef.current)
      readerSaveTimerRef.current = null
    }
    searchRequestIdRef.current += 1
    incomingSearchSessionKeyRef.current = ''
    documentSearchFetchedKeyRef.current = ''
    documentVectorExpandKeyRef.current = ''
    appliedInitialSearchLocatorKeyRef.current = ''
    temporaryNavigationRef.current = !!(sourceId || locator || stableLocator || searchSession?.hits?.length || searchKeyword || highlightExcerpt)
    setDocumentSearchSession(searchSession)
    setCurrentMatchIndex(searchSession?.activeHitIndex ?? -1)
    if (revealToc) {
      setReaderTocOpen(true)
    }
    void (async () => {
      try {
        // Recompute printed/literature page map before first read so citations don't
        // stick to physical 1..N when OCR labels already exist on older books.
        try {
          await window.api.recomputeLiteraturePages(targetDocId)
        } catch (error) {
          console.warn('[DocumentView] literature page recompute failed', targetDocId, error)
        }
        if (activeDocumentIdRef.current !== targetDocId) return
        const data = await window.api.getDocumentLight(targetDocId)
        if (activeDocumentIdRef.current !== targetDocId) return
        const normalizedDoc = normalizeDocumentDetail(data, targetDocId)
        if (!normalizedDoc) {
          throw new Error('Document detail is empty')
        }
        setDoc(normalizedDoc)
        const targetIndex = resolveStableLocatorPageIndex(normalizedDoc.pages || [], stableLocator, locator, initialPageIndex)
        void loadPagesAround(targetIndex, 4)
      } catch (error) {
        console.error(error)
        message.error('加载文献详情失败')
      } finally {
        if (activeDocumentIdRef.current === targetDocId) setLoading(false)
      }
    })()
  }, [openContextKey])

  // Ebooks never use proof layout — force read without fighting user mode toggles on scanned books.
  useEffect(() => {
    if (!doc || !isEbookDocument) return
    if (documentMode === 'proof' || intendedDocumentModeRef.current === 'proof') {
      intendedDocumentModeRef.current = 'read'
      setDocumentMode('read')
    }
  }, [doc, documentMode, isEbookDocument])

  useEffect(() => {
    if (!doc) return
    const maxIndex = doc.pages ? doc.pages.length - 1 : 0
    if (!hasInitializedPageRef.current) {
      hasInitializedPageRef.current = true
      const initialIndex = resolveStableLocatorPageIndex(sortedPages, stableLocator, locator, initialPageIndex)
      setCurrentPageIndex(initialIndex)
      readerVisiblePageIndexRef.current = initialIndex
      return
    }
    // Only clamp when page count shrinks. Do NOT depend on documentMode — mode toggles
    // must not re-enter page init logic (that caused Segmented flash / bounce).
    setCurrentPageIndex((value) => {
      const next = Math.min(value, Math.max(0, maxIndex))
      if (next !== value) readerVisiblePageIndexRef.current = next
      return next
    })
  }, [doc, initialPageIndex, locator, sortedPages, stableLocator])

  /**
   * Imperative in-document search. Always runs when called (engine switch / Enter / commit).
   * Does not rely on React effect dependency equality for the same keyword.
   */
  const runInDocumentSearch = useCallback((queryRaw: string, engineRaw: 'fulltext' | 'vector') => {
    const query = String(queryRaw || '').trim()
    const engine: 'fulltext' | 'vector' = engineRaw === 'vector' ? 'vector' : 'fulltext'
    const docId = activeDocumentIdRef.current || documentId

    searchRequestIdRef.current += 1
    const requestId = searchRequestIdRef.current
    documentVectorExpandKeyRef.current = ''

    if (!docId || !query) {
      documentSearchFetchedKeyRef.current = ''
      setDocumentSearchSession({ query: '', hits: [], activeHitIndex: -1, status: 'idle', engine })
      setCurrentMatchIndex(-1)
      setActiveBoxIndex(-1)
      return
    }

    const fetchKey = `${docId}\0${engine}\0${query}`
    // Claim immediately so the auto-effect does not start a duplicate request.
    documentSearchFetchedKeyRef.current = fetchKey

    if (engine === 'vector') {
      // Keep existing vector hits (e.g. from search-page open) while expanding, so the left
      // list never flashes keyword-FTS fallback content.
      setDocumentSearchSession((previous) => {
        const keepSeed = previous?.engine === 'vector'
          && previous.query === query
          && (previous.hits?.length || 0) > 0
        return {
          query,
          hits: keepSeed ? previous.hits : [],
          activeHitIndex: keepSeed ? Math.max(0, previous.activeHitIndex ?? 0) : -1,
          status: 'searching',
          engine: 'vector',
        }
      })
      void window.api.vectorSearch(query, { docId, limit: 200 })
        .then((response) => {
          if (searchRequestIdRef.current !== requestId) return
          documentSearchFetchedKeyRef.current = fetchKey
          if (!response || !('ok' in response) || !response.ok) {
            setDocumentSearchSession((previous) => ({
              query,
              hits: previous?.engine === 'vector' && previous.query === query ? previous.hits : [],
              activeHitIndex: previous?.engine === 'vector' && previous.query === query
                ? Math.max(0, previous.activeHitIndex ?? 0)
                : -1,
              status: (previous?.hits?.length || 0) > 0 ? 'ready' : 'error',
              engine: 'vector',
            }))
            if (!response || !('ok' in response) || !response.ok) {
              message.warning(response && 'message' in response ? String(response.message) : '向量检索失败')
            }
            return
          }
          const hits = (response.hits || [])
            .filter((hit: VectorSearchHit) => {
              const hitDocId = String(hit.documentId || hit.ref?.docId || '').trim()
              return hitDocId === docId
            })
            .map((hit: VectorSearchHit, index: number): SearchHit => {
              const pageNum = Number(hit.pageNum || hit.ref?.pageNum || 1) || 1
              const segmentId = String(hit.ref?.segmentId || `${docId}:${pageNum}:${index}`)
              const excerpt = String(hit.excerpt || '').replace(/\s+/g, ' ').trim()
              const matchText = excerpt
                ? (excerpt.length <= 160 ? excerpt : excerpt.slice(0, 160))
                : query
              return {
                id: `${segmentId}:${index}`,
                locator: {
                  docId,
                  segmentId,
                  pageId: null,
                  pageNum,
                  pageIndex: Math.max(0, pageNum - 1),
                  href: null,
                  segmentOrdinal: 0,
                  charStart: 0,
                  charEnd: matchText.length,
                  matchText,
                  queryTerm: query,
                  occurrenceIndex: index,
                },
                snippet: excerpt,
                score: Number(hit.score) || 0,
              }
            })
          setDocumentSearchSession({
            query,
            hits,
            activeHitIndex: hits.length ? 0 : -1,
            status: hits.length ? 'ready' : 'empty',
            engine: 'vector',
          })
          setCurrentMatchIndex(hits.length ? 0 : -1)
        })
        .catch((error: unknown) => {
          if (searchRequestIdRef.current !== requestId) return
          documentSearchFetchedKeyRef.current = fetchKey
          console.error('Failed to load in-document vector hits', error)
          setDocumentSearchSession((previous) => ({
            query,
            hits: previous?.engine === 'vector' && previous.query === query ? previous.hits : [],
            activeHitIndex: previous?.engine === 'vector' && previous.query === query
              ? Math.max(0, previous.activeHitIndex ?? 0)
              : -1,
            status: (previous?.hits?.length || 0) > 0 ? 'ready' : 'error',
            engine: 'vector',
          }))
        })
      return
    }

    // fulltext
    setDocumentSearchSession({
      query,
      hits: [],
      activeHitIndex: -1,
      status: 'searching',
      engine: 'fulltext',
    })
    setCurrentMatchIndex(-1)
    void window.api.getDocumentSearchHits(docId, query, { limit: 20000, resultMode: 'all' })
      .then((session: SearchSessionState) => {
        if (searchRequestIdRef.current !== requestId) return
        documentSearchFetchedKeyRef.current = fetchKey
        const searchStartPageIndex = documentMode === 'proof'
          ? currentPageIndex
          : readerVisiblePageIndexRef.current ?? currentPageIndex
        const pageAnchoredIndex = findFirstSearchHitAtOrAfterPage(
          session.hits.map((hit) => ({ pageIndex: resolveLocatorPageIndex(sortedPagesRef.current, hit.locator) })),
          searchStartPageIndex,
        )
        const nextActiveIndex = pageAnchoredIndex >= 0 ? pageAnchoredIndex : (session.hits.length ? 0 : -1)
        setDocumentSearchSession({ ...session, engine: 'fulltext', activeHitIndex: nextActiveIndex })
        setCurrentMatchIndex(nextActiveIndex)
      })
      .catch((error: unknown) => {
        if (searchRequestIdRef.current !== requestId) return
        documentSearchFetchedKeyRef.current = fetchKey
        console.error('Failed to load document search hits', error)
        setDocumentSearchSession({ query, hits: [], activeHitIndex: -1, status: 'error', engine: 'fulltext' })
        setCurrentMatchIndex(-1)
      })
  }, [currentPageIndex, documentId, documentMode])

  // Open / prop keyword: seed multi-hit FTS once, otherwise kick off search if not already claimed.
  useEffect(() => {
    const query = effectiveSearchKeyword.trim()
    const engine = readerSearchEngine === 'vector' ? 'vector' : 'fulltext'
    if (!documentId || !query) {
      if (!query) {
        documentSearchFetchedKeyRef.current = ''
        setDocumentSearchSession({ query: '', hits: [], activeHitIndex: -1, status: 'idle', engine })
        setCurrentMatchIndex(-1)
      }
      return
    }
    const fetchKey = `${documentId}\0${engine}\0${query}`
    // Already in-flight or finished for this engine+query (UI commits claim the key first).
    if (documentSearchFetchedKeyRef.current === fetchKey) return
    // Prefer incoming multi-hit fulltext session from search page (one-shot).
    if (
      engine === 'fulltext'
      && searchSession?.query === query
      && searchSession.engine !== 'vector'
      && (searchSession.hits?.length || 0) > 1
      && searchSession.status !== 'searching'
    ) {
      const incomingKey = `${documentId}:fts:${query}:${searchSession.hits.length}`
      if (incomingSearchSessionKeyRef.current !== incomingKey) {
        incomingSearchSessionKeyRef.current = incomingKey
        documentSearchFetchedKeyRef.current = fetchKey
        const nextActiveIndex = searchSession.activeHitIndex >= 0 ? searchSession.activeHitIndex : 0
        setDocumentSearchSession({ ...searchSession, engine: 'fulltext', activeHitIndex: nextActiveIndex })
        setCurrentMatchIndex(nextActiveIndex)
      }
      return
    }
    runInDocumentSearch(query, engine)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, effectiveSearchKeyword, readerSearchEngine, runInDocumentSearch, searchSession])

  useEffect(() => {
    if (effectiveSearchKeyword.trim()) {
      setReaderTocOpen(true)
      setReaderSidebarTab('search')
      setReaderSearchResultPage(1)
      return
    }
    setReaderSidebarTab('toc')
    setReaderSearchResultPage(1)
  }, [effectiveSearchKeyword])

  const hasReaderSearchQuery = Boolean(localSearchKeyword.trim())
  useEffect(() => {
    const requestId = ++searchPagesRequestIdRef.current
    // Only proof mode needs whole-book page payloads for local layout/text match expansion.
    // Read mode already uses indexed document search hits (complete) without this bulk hydrate.
    const shouldLoadSearchPages = documentMode === 'proof'
    if (!documentId || !hasReaderSearchQuery || !shouldLoadSearchPages) {
      setReaderSearchPages([])
      return
    }
    if (readerSearchPages.length >= pageCount && readerSearchPages.some((page) => String(page?.proofed_text || page?.ocr_text || '').trim())) return
    void window.api.getDocumentSearchPages(documentId)
      .then((pages) => {
        if (searchPagesRequestIdRef.current !== requestId) return
        if (activeDocumentIdRef.current !== documentId) return
        setReaderSearchPages(Array.isArray(pages)
          ? pages.filter((page) => isDocumentPageForDoc(page, documentId))
          : [])
      })
      .catch((error: unknown) => {
        if (searchPagesRequestIdRef.current !== requestId) return
        console.error('Failed to load reader search pages', error)
        setReaderSearchPages([])
      })
  }, [documentId, documentMode, hasReaderSearchQuery, pageCount, readerSearchPages.length])

  useEffect(() => {
    if (!doc || readerStateLoadedRef.current || searchKeyword) return
    const targetDocId = documentId
    readerStateLoadedRef.current = true
    // Capture open generation so a later mode click (which bumps the serial) voids mode restore.
    const restoreSerial = documentModeSwitchSerialRef.current
    let cancelled = false
    const applyRestoredPageIndex = (pageIndex: number) => {
      // Page restore is fine even after mode click; only mode restore is gated.
      if (cancelled || activeDocumentIdRef.current !== targetDocId) return
      const nextIndex = clampPageIndex(pageIndex, pageCountRef.current)
      setCurrentPageIndex(nextIndex)
      readerVisiblePageIndexRef.current = nextIndex
      void loadPagesAround(nextIndex, 5)
    }
    /** Only apply saved mode if user has not clicked 阅读/校对 during this open. */
    const tryRestoreDocumentMode = (mode: DocumentMode): boolean => {
      if (cancelled || activeDocumentIdRef.current !== targetDocId) return false
      if (documentModeSwitchSerialRef.current !== restoreSerial) return false
      if (documentModeTouchedRef.current) return false
      intendedDocumentModeRef.current = mode
      setDocumentMode(mode)
      return true
    }
    void window.api.getReaderState(targetDocId).then((state: ReaderState | null) => {
      if (cancelled || activeDocumentIdRef.current !== targetDocId || !state) return
      const latestPageCount = pageCountRef.current
      const latestReaderVirtualPages = readerVirtualPagesRef.current
      const latestSortedPages = sortedPagesRef.current
      const savedLocationKey = String(state.location_key || '')
      setInitialReaderLocationKey(savedLocationKey)

      // Mode restore is re-checked at apply time (not once at the start of this callback).
      if (state.document_mode === 'read') {
        tryRestoreDocumentMode('read')
      } else if (state.document_mode === 'proof' && !isEbookDocumentRef.current) {
        if (tryRestoreDocumentMode('proof')) {
          if (state.proof_view_mode === 'facsimile' || state.proof_view_mode === 'text') {
            setProofViewMode(state.proof_view_mode)
            setProofViewTouched(true)
          }
        }
        const savedProofLocationKey = String(state.proof_location_key || '')
        const proofPageMatch = savedProofLocationKey.match(/^page:(\d+)$/)
        if (proofPageMatch) {
          applyRestoredPageIndex(Number(proofPageMatch[1]) - 1)
          return
        }
        if (typeof state.proof_progress === 'number' && state.proof_progress > 0 && latestPageCount > 0) {
          applyRestoredPageIndex(Math.round(state.proof_progress * Math.max(0, latestPageCount - 1)))
          return
        }
      }

      const pageMatch = savedLocationKey.match(/^page:(\d+)$/)
      if (pageMatch) {
        applyRestoredPageIndex(Number(pageMatch[1]) - 1)
        return
      }

      const textReaderMatch = savedLocationKey.match(/^text-reader:(\d+)$/)
      if (textReaderMatch) {
        const nextIndex = Math.max(0, Number(textReaderMatch[1]) - 1)
        setReaderPageIndex(nextIndex)
        const virtualPage = latestReaderVirtualPages[nextIndex]
        if (virtualPage) {
          applyRestoredPageIndex(virtualPage.sourcePageIndex)
        } else if (typeof state.progress === 'number' && state.progress > 0 && latestPageCount > 0) {
          applyRestoredPageIndex(Math.round(state.progress * Math.max(0, latestPageCount - 1)))
        }
        return
      }

      const textMatch = savedLocationKey.match(/^text:(.+)$/)
      if (textMatch) {
        const href = textMatch[1]
        const pageIndex = latestSortedPages.findIndex((page) => {
          const parsed = parseMaybeJson(page.ocr_result) || {}
          const ebook = readRecordValue(parsed, 'ebook')
          return String(readRecordValue(ebook, 'href') || `page:${page.page_num}`) === href
        })
        if (pageIndex >= 0) {
          applyRestoredPageIndex(pageIndex)
          return
        }
      }

      const sectionMatch = savedLocationKey.match(/^section:(.+)#column:(\d+)$/)
      if (sectionMatch) {
        const href = sectionMatch[1]
        const pageIndex = latestSortedPages.findIndex((page) => {
          const parsed = parseMaybeJson(page.ocr_result) || {}
          const ebook = readRecordValue(parsed, 'ebook')
          return String(readRecordValue(ebook, 'href') || '') === href
        })
        if (pageIndex >= 0) {
          applyRestoredPageIndex(pageIndex)
        }
      } else if (typeof state.progress === 'number' && state.progress > 0 && latestPageCount > 0) {
        applyRestoredPageIndex(Math.round(state.progress * Math.max(0, latestPageCount - 1)))
      }
    }).catch((error: unknown) => {
      console.error('Failed to load reader state', error)
    }).finally(() => {
      if (!cancelled && activeDocumentIdRef.current === targetDocId) setReaderStateReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [doc?.id, documentId, loadPagesAround, searchKeyword])

  useEffect(() => {
    if (!doc || readerStateLoadedRef.current || !searchKeyword) return
    readerStateLoadedRef.current = true
    setReaderStateReady(true)
  }, [doc, searchKeyword])

  useEffect(() => () => {
    if (readerSaveTimerRef.current) {
      window.clearTimeout(readerSaveTimerRef.current)
      readerSaveTimerRef.current = null
    }
    void flushReaderStateNow()
  }, [flushReaderStateNow])

  useEffect(() => {
    setSharedViewport(undefined)
    setActiveBoxIndex(-1)
  }, [currentPageIndex])

  useEffect(() => {
    setCurrentMatchIndex(-1)
    searchAutoNavigationKeyRef.current = ''
  }, [effectiveSearchKeyword])

  useEffect(() => {
    if (!locator || !effectiveSearchKeyword.trim()) return
    const locatorKey = getSearchLocatorKey(locator, effectiveSearchKeyword)
    if (!locatorKey || appliedInitialSearchLocatorKeyRef.current === locatorKey) return
    const matches = shouldUseTextReaderMode ? textReaderMatches : searchMatches
    const targetIndex = findSearchMatchIndexForLocator(matches, sortedPages, locator, initialPageIndex)
    if (targetIndex < 0) return
    appliedInitialSearchLocatorKeyRef.current = locatorKey
    const targetMatch = matches[targetIndex]
    setCurrentMatchIndex(targetIndex)
    setReaderSearchResultPage(Math.floor(targetIndex / READER_SEARCH_RESULT_PAGE_SIZE) + 1)
    setActiveBoxIndex(targetMatch.boxIndex)
    if (shouldUseTextReaderMode) {
      setReaderPageIndex(targetMatch.pageIndex)
    } else if (targetMatch.pageIndex !== currentPageIndex) {
      setCurrentPageIndex(targetMatch.pageIndex)
    }
  }, [currentPageIndex, effectiveSearchKeyword, initialPageIndex, locator, searchMatches, shouldUseTextReaderMode, sortedPages, textReaderMatches])

  useEffect(() => {
    if (documentMode !== 'proof') return
    if (!effectiveSearchKeyword.trim() || searchMatches.length === 0) return
    if (pageCount > 1 && readerSearchPages.length === 0) return
    const sessionMatchIndex = documentSearchSession?.query === effectiveSearchKeyword && documentSearchSession.activeHitIndex >= 0
      ? searchMatches.findIndex((match) => match.hitIndex === documentSearchSession.activeHitIndex)
      : -1
    const firstMatchAtOrAfterCurrentPage = findFirstSearchHitAtOrAfterPage(searchMatches, currentPageIndex)
    const selectedIndex = sessionMatchIndex >= 0
      ? sessionMatchIndex
      : currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length
      ? currentMatchIndex
      : firstMatchAtOrAfterCurrentPage
    const selectedMatch = searchMatches[selectedIndex]
    if (!selectedMatch) return
    if (selectedMatch.pageIndex !== currentPageIndex) {
      const navigationKey = [
        effectiveSearchKeyword,
        selectedIndex,
        selectedMatch.hitIndex ?? selectedIndex,
        selectedMatch.pageIndex,
        searchMatches.length,
      ].join(':')
      if (searchAutoNavigationKeyRef.current !== navigationKey) {
        searchAutoNavigationKeyRef.current = navigationKey
        setCurrentPageIndex(selectedMatch.pageIndex)
        void loadPagesAround(selectedMatch.pageIndex, 5)
      }
      return
    }
    setActiveBoxIndex(selectedMatch.boxIndex)
    if (currentMatchIndex !== selectedIndex) {
      setCurrentMatchIndex(selectedIndex)
      setDocumentSearchSession((previous) => previous?.query === effectiveSearchKeyword
        ? { ...previous, activeHitIndex: selectedMatch.hitIndex ?? selectedIndex }
        : previous)
    }
  }, [currentMatchIndex, currentPageIndex, documentMode, documentSearchSession?.activeHitIndex, documentSearchSession?.query, effectiveSearchKeyword, loadPagesAround, pageCount, readerSearchPages.length, searchMatches])

  useEffect(() => {
    setPageInput(String(Math.max(1, currentPageIndex + 1)))
  }, [currentPageIndex])

  useEffect(() => {
    let active = true
    void window.api.getSetting(READER_GLOBAL_PREFERENCES_SETTING_KEY)
      .then((stored) => {
        if (!active) return
        const preferences = parseReaderGlobalPreferences(stored)
        setReaderViewMode(preferences.view_mode)
        setReaderFontFamily(preferences.font_family)
        setReaderFontSize(preferences.font_size)
        setReaderLineHeight(preferences.line_height)
        setReaderPageWidth(preferences.page_width)
        setReaderTheme(preferences.theme)
        setReaderDisplayScript(preferences.display_script)
        latestReaderPreferencesRef.current = preferences
        try {
          window.localStorage.setItem(READER_DISPLAY_SCRIPT_STORAGE_KEY, preferences.display_script)
        } catch {
          // The settings table remains the source of truth.
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load reader global preferences', error)
      })
      .finally(() => {
        if (active) readerPreferencesLoadedRef.current = true
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => window.api.onPageTranslationProgress((event: PageTranslationProgressEvent) => {
    if (!doc?.id || event.docId !== doc.id) return
    setPageTranslationUnits((current) => ({ ...current, [event.pageId]: event.units }))
    setPageTranslations((current) => ({ ...current, [event.pageId]: event.translationText }))
  }), [doc?.id])

  useEffect(() => {
    try {
      window.localStorage.setItem(READER_DISPLAY_SCRIPT_STORAGE_KEY, readerDisplayScript)
    } catch {
      // Ignore storage failures; the switch still works for the current session.
    }
  }, [readerDisplayScript])

  useEffect(() => {
    if (!readerPreferencesLoadedRef.current) return
    if (readerPreferencesSaveTimerRef.current) {
      window.clearTimeout(readerPreferencesSaveTimerRef.current)
    }
    const preferences: ReaderGlobalPreferences = {
      view_mode: readerViewMode,
      font_family: readerFontFamily,
      font_size: readerFontSize,
      line_height: readerLineHeight,
      page_width: readerPageWidth,
      theme: readerTheme,
      display_script: readerDisplayScript,
    }
    latestReaderPreferencesRef.current = preferences
    readerPreferencesSaveTimerRef.current = window.setTimeout(() => {
      readerPreferencesSaveTimerRef.current = null
      void window.api.setSetting(READER_GLOBAL_PREFERENCES_SETTING_KEY, JSON.stringify(preferences)).catch((error: unknown) => {
        console.error('Failed to save reader global preferences', error)
      })
    }, 350)
  }, [readerDisplayScript, readerFontFamily, readerFontSize, readerLineHeight, readerPageWidth, readerTheme, readerViewMode])

  useEffect(() => () => {
    if (readerPreferencesSaveTimerRef.current) {
      window.clearTimeout(readerPreferencesSaveTimerRef.current)
      readerPreferencesSaveTimerRef.current = null
      if (readerPreferencesLoadedRef.current) {
        void window.api.setSetting(READER_GLOBAL_PREFERENCES_SETTING_KEY, JSON.stringify(latestReaderPreferencesRef.current)).catch((error: unknown) => {
          console.error('Failed to flush reader global preferences', error)
        })
      }
    }
  }, [])

  useEffect(() => {
    if (!doc?.id || pageCount === 0 || shouldUseManagedTextReader || documentMode !== 'read') return
    if (intendedDocumentModeRef.current !== 'read') return
    if (!readerStateReady) return
    if (temporaryNavigationRef.current) return
    const progress = pageCount <= 1 ? 1 : currentPageIndex / Math.max(1, pageCount - 1)
    saveReaderStateSoon({
      document_mode: 'read',
      location_key: `page:${currentPage?.page_num || currentPageIndex + 1}`,
      progress,
      view_mode: readerViewMode,
      font_size: readerFontSize,
      line_height: readerLineHeight,
      theme: readerTheme,
    })
    if (progress >= 0.95 && doc.read_status !== 'read') {
      void window.api.setReadStatus(doc.id, 'read').then(() => {
        setDoc((previous) => previous ? { ...previous, read_status: 'read' } : previous)
      }).catch(() => {})
    }
  }, [
    currentPage?.page_num,
    currentPageIndex,
    documentMode,
    doc?.id,
    doc?.read_status,
    pageCount,
    readerFontSize,
    readerLineHeight,
    readerViewMode,
    readerStateReady,
    readerTheme,
    saveReaderStateSoon,
    shouldUseManagedTextReader,
  ])

  useEffect(() => {
    if (!doc?.id || pageCount === 0 || documentMode !== 'proof') return
    if (intendedDocumentModeRef.current !== 'proof') return
    if (!readerStateReady) return
    if (temporaryNavigationRef.current) return
    const nextState = buildProofReaderState(currentPageIndex)
    if (nextState) saveReaderStateSoon(nextState)
  }, [
    buildProofReaderState,
    currentPageIndex,
    documentMode,
    doc?.id,
    pageCount,
    proofViewMode,
    readerStateReady,
    saveReaderStateSoon,
  ])

  useEffect(() => {
    const handleResize = () => setReaderViewportHeight(window.innerHeight)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    setReaderPageIndex((value) => clampPageIndex(value, readerVirtualPageCount))
  }, [readerVirtualPageCount])

  useEffect(() => {
    if (!shouldUseTextReaderMode) return
    const virtualPage = readerVirtualPages[readerPageIndex]
    if (!virtualPage) return
    const nextState = buildTextReaderState(readerPageIndex)
    if (nextState && readerStateReady && !temporaryNavigationRef.current) {
      saveReaderStateSoon(nextState)
    }
    const sourceIndex = clampPageIndex(virtualPage.sourcePageIndex, pageCount)
    readerVisiblePageIndexRef.current = sourceIndex
    if (sourceIndex !== currentPageIndex) {
      setCurrentPageIndex(sourceIndex)
    }
    setPageInput(String(readerPageIndex + 1))
  }, [buildTextReaderState, currentPageIndex, pageCount, readerPageIndex, readerStateReady, readerVirtualPages, saveReaderStateSoon, shouldUseTextReaderMode])

  // Keep the shared "where am I" index in sync for every reading surface so
  // read ↔ proof mode switches never fall back to a stale page 0/1.
  useEffect(() => {
    if (documentMode !== 'read') return
    readerVisiblePageIndexRef.current = clampPageIndex(currentPageIndex, pageCount)
  }, [currentPageIndex, documentMode, pageCount])

  const loadPageImage = useCallback(async (page: DocumentViewPage | undefined, options?: { updateDoc?: boolean }): Promise<string> => {
    if (!page) return ''
    const cacheKey = getPageImageCacheKey(page, doc?.id, documentId)
    const cached = pageImageCacheRef.current.get(cacheKey)
    if (cached) return cached

    if (page.image_path) {
      try {
        if (!(await window.api.isReadableFile(page.image_path as string))) {
          throw new Error('page image is not readable')
        }
        const localResourceUrl = toLocalResourceUrl(page.image_path)
        putLimitedPageImageCache(pageImageCacheRef.current, cacheKey, localResourceUrl)
        return localResourceUrl
      } catch (error) {
        console.warn('[DocumentView] page image path is not readable, falling back to PDF render', error)
      }
    }

    if (doc?.file_path && String(doc.file_path).toLowerCase().endsWith('.pdf') && page.page_num) {
      try {
        const rendered = await renderPdfFilePageToImage(doc.file_path, page.page_num)
        putLimitedPageImageCache(pageImageCacheRef.current, cacheKey, rendered.dataUrl)
        if (options?.updateDoc !== false && doc?.id && page.id) {
          const imagePath = await window.api.cachePageImage(doc.id, page.page_num, rendered.dataUrl)
          setDoc((previous) => {
            if (!previous?.pages) return previous
            return {
              ...previous,
              pages: previous.pages.map((item) => item.id === page.id ? { ...item, image_path: imagePath } : item),
            }
          })
        }
        return rendered.dataUrl
      } catch (error) {
        console.warn('[DocumentView] PDF source is not readable, keeping page image unavailable', error)
      }
    }

    return ''
  }, [doc?.file_path, doc?.id, documentId])

  const getCachedPageImage = useCallback((page: DocumentViewPage | undefined): string => {
    if (!page) return ''
    return pageImageCacheRef.current.get(getPageImageCacheKey(page, doc?.id, documentId)) || ''
  }, [doc?.id, documentId])

  const ensureCurrentPageImageCached = useCallback(async (page: DocumentViewPage | undefined): Promise<boolean> => {
    if (!page?.id) return false
    if (await isReadablePageImagePath(page.image_path)) return true
    if (!doc?.id || !page.page_num) {
      return false
    }
    const messageKey = `page-image-${page.id}`
    try {
      const result = await ensureOcrPageImages(doc, {
        pageNums: [page.page_num],
        messageKey,
        onProgress: (content, key) => message.loading({ content, key: key || messageKey, duration: 0 }),
        onPageCached: async (pageNum, _imagePath, dataUrl) => {
          if (pageNum !== page.page_num) return
          putLimitedPageImageCache(pageImageCacheRef.current, getPageImageCacheKey(page, doc.id, documentId), dataUrl)
        },
      })
      if (result.cachedPageNums.includes(page.page_num)) return true
      const latestPages = await window.api.getDocumentPagesRange(doc.id, page.page_num, page.page_num).catch(() => [])
      const latestPage = latestPages.find((item) => item.id === page.id || Number(item.page_num || 0) === page.page_num)
      return result.ready && await isReadablePageImagePath(latestPage?.image_path || page.image_path)
    } finally {
      message.destroy(messageKey)
    }
  }, [doc, documentId])

  const forceRenderCurrentPageImageFromPdf = useCallback(async (page: DocumentViewPage | undefined): Promise<boolean> => {
    if (!doc?.id || !page?.id || !page.page_num) return false
    const sourceFilePath = String(doc.file_path || '').trim()
    if (!sourceFilePath.toLowerCase().endsWith('.pdf')) {
      return ensureCurrentPageImageCached(page)
    }

    const cacheKey = getPageImageCacheKey(page, doc.id, documentId)
    const messageKey = `page-image-rerender-${page.id}`
    try {
      message.loading({ content: '正在重新生成当前页原图…', key: messageKey, duration: 0 })
      pageImageCacheRef.current.delete(cacheKey)
      releaseCachedPdfDocument(sourceFilePath)
      const rendered = await renderPdfFilePageToImage(sourceFilePath, page.page_num)
      const imagePath = await window.api.cachePageImage(doc.id, page.page_num, rendered.dataUrl)
      putLimitedPageImageCache(pageImageCacheRef.current, cacheKey, rendered.dataUrl)
      setDoc((previous) => {
        if (!previous?.pages) return previous
        return {
          ...previous,
          pages: previous.pages.map((item) => (
            item.id === page.id || item.page_num === page.page_num
              ? { ...item, image_path: imagePath }
              : item
          )),
        }
      })
      if (page.id === currentPage?.id || page.page_num === currentPage?.page_num) {
        setImageDataUrl(rendered.dataUrl)
      }
      return true
    } catch (error) {
      console.warn('[DocumentView] failed to force-render current PDF page image', error)
      return ensureCurrentPageImageCached(page)
    } finally {
      message.destroy(messageKey)
    }
  }, [currentPage?.id, currentPage?.page_num, doc?.file_path, doc?.id, documentId, ensureCurrentPageImageCached])

  useEffect(() => {
    const filePath = doc?.file_path
    return () => {
      pageImageCacheRef.current.clear()
      if (filePath && String(filePath).toLowerCase().endsWith('.pdf')) {
        releaseCachedPdfDocument(filePath)
      }
    }
  }, [doc?.file_path])

  useLayoutEffect(() => {
    if (!doc || !(shouldUseImageReaderMode || shouldUseProofLayout)) return
    setImageDataUrl(getCachedPageImage(currentPage))
    setNextImageDataUrl(shouldUseImageReaderMode ? getCachedPageImage(nextSpreadPage) : '')
  }, [
    currentPage?.id,
    doc,
    getCachedPageImage,
    nextSpreadPage?.id,
    shouldUseImageReaderMode,
    shouldUseProofLayout,
  ])

  useEffect(() => {
    let canceled = false

    const loadCurrentImage = async () => {
      if (!currentPage) {
        setImageDataUrl('')
        setPageImageLoading(false)
        return
      }

      const cached = getCachedPageImage(currentPage)
      if (cached) {
        setImageDataUrl(cached)
        setPageImageLoading(false)
      } else {
        setPageImageLoading(true)
      }

      try {
        let dataUrl = await loadPageImage(currentPage)
        // Proof needs a real page image for side-by-side comparison; try harder via PDF.
        if (!dataUrl && shouldUseProofLayout && doc && currentPage.page_num) {
          const recovered = await ensureCurrentPageImageCached(currentPage).catch(() => false)
          if (recovered) {
            dataUrl = await loadPageImage(currentPage)
          }
        }
        const nextDataUrl = shouldUseImageReaderMode && nextSpreadPage
          ? await loadPageImage(nextSpreadPage)
          : ''
        if (canceled) return
        setImageDataUrl(dataUrl)
        setNextImageDataUrl(nextDataUrl)
      } catch (error) {
        console.error('[DocumentView] failed to load image', error)
        if (!canceled) setImageDataUrl('')
        if (!canceled) setNextImageDataUrl('')
      } finally {
        if (!canceled) setPageImageLoading(false)
      }
    }

    if (doc && (shouldUseImageReaderMode || shouldUseProofLayout)) {
      void loadCurrentImage()
    } else {
      setPageImageLoading(false)
    }

    return () => {
      canceled = true
    }
  }, [
    currentPage,
    doc,
    ensureCurrentPageImageCached,
    getCachedPageImage,
    loadPageImage,
    nextSpreadPage,
    shouldUseImageReaderMode,
    shouldUseProofLayout,
  ])

  useEffect(() => {
    if (!shouldUseSourcePageReader) return
    if (!isDocumentPagePayloadHydrated(sortedPages[currentPageIndex])) {
      void loadPagesAround(currentPageIndex, 5)
    }
  }, [currentPageIndex, loadPagesAround, shouldUseSourcePageReader, sortedPages])

  useEffect(() => {
    if (documentMode !== 'proof' || !currentPage?.id) return
    void loadProofPageWindow(currentPageIndex)
  }, [currentPage?.id, currentPageIndex, documentMode, loadProofPageWindow])

  useEffect(() => {
    if (!doc || !currentPage || !shouldUseProofLayout) return undefined
    let canceled = false
    const prefetchProofImages = async () => {
      const candidates = PROOF_IMAGE_PREFETCH_OFFSETS
        .map((offset) => sortedPages[currentPageIndex + offset])
        .filter((page): page is DocumentViewPage => Boolean(page?.image_path))
      for (const page of candidates) {
        if (canceled) return
        if (getCachedPageImage(page)) continue
        try {
          await loadPageImage(page, { updateDoc: false })
        } catch (error) {
          console.warn('[DocumentView] failed to prefetch proof page image', error)
        }
        if (canceled) return
      }
    }

    const timer = window.setTimeout(() => {
      void prefetchProofImages()
    }, PROOF_IMAGE_PREFETCH_DELAY_MS)
    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
  }, [currentPage, currentPageIndex, doc, getCachedPageImage, loadPageImage, shouldUseProofLayout, sortedPages])

  useEffect(() => {
    if (!doc?.id || !shouldUseProofLayout || proofViewMode !== 'facsimile') return undefined
    const pageNums = getProofImagePrewarmPageNums(sortedPages, currentPageIndex, pageCount)
    if (pageNums.length === 0) return undefined
    const prewarmKey = `${doc.id}:${pageNums[0]}-${pageNums[pageNums.length - 1]}:${pageNums.length}`
    if (proofImagePrewarmKeyRef.current === prewarmKey) return undefined
    proofImagePrewarmKeyRef.current = prewarmKey

    let canceled = false
    const cachedImagePaths = new Map<number, string>()
    const timer = window.setTimeout(() => {
      void ensureOcrPageImages(doc, {
        pageNums,
        onPageCached: async (pageNum, imagePath, dataUrl) => {
          if (canceled) return
          cachedImagePaths.set(pageNum, imagePath)
          const cachedPage = sortedPages.find((page) => Number(page.page_num || 0) === pageNum)
          if (cachedPage) {
            putLimitedPageImageCache(pageImageCacheRef.current, getPageImageCacheKey(cachedPage, doc.id, documentId), dataUrl)
          }
          if (Number(currentPage?.page_num || 0) === pageNum) {
            setImageDataUrl(dataUrl)
          }
        },
      }).then(() => {
        if (canceled || cachedImagePaths.size === 0) return
        setDoc((previous) => {
          if (!previous?.pages) return previous
          return {
            ...previous,
            pages: previous.pages.map((page) => {
              const imagePath = cachedImagePaths.get(Number(page.page_num || 0))
              return imagePath ? { ...page, image_path: imagePath } : page
            }),
          }
        })
      }).catch((error) => {
        if (!canceled) console.warn('[DocumentView] failed to prewarm proof page images', error)
      })
    }, PROOF_IMAGE_PREWARM_DELAY_MS)

    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
  }, [currentPage?.page_num, currentPageIndex, doc, documentId, pageCount, proofViewMode, shouldUseProofLayout, sortedPages])

  useEffect(() => {
    if (!doc || !currentPage) return undefined
    if (shouldUseManagedTextReader || shouldUseProofLayout) return undefined
    let canceled = false

    const prefetchNeighbors = async () => {
      const neighbors = [sortedPages[currentPageIndex - 1], sortedPages[currentPageIndex + 1]]
        .filter((page): page is DocumentViewPage => Boolean(page))
      await Promise.all(neighbors.map(async (page) => {
        if (canceled) return
        try {
          await loadPageImage(page, { updateDoc: false })
        } catch (error) {
          console.warn('[DocumentView] failed to prefetch neighbor page', error)
        }
      }))
    }

    void prefetchNeighbors()

    return () => {
      canceled = true
    }
  }, [currentPage, currentPageIndex, doc, loadPageImage, shouldUseManagedTextReader, shouldUseProofLayout, sortedPages])

  useEffect(() => {
    panelState.current = getDefaultFloatingPanelState()
    if (floatingPanelRef.current) {
      floatingPanelRef.current.style.transform = `translate(${panelState.current.x}px, ${panelState.current.y}px)`
      floatingPanelRef.current.style.width = `${panelState.current.w}px`
      floatingPanelRef.current.style.height = `${panelState.current.h}px`
    }
  }, [])

  useEffect(() => {
    const flushPanelStyle = () => {
      panelFrameRef.current = null
      const next = pendingPanelStyleRef.current
      const panel = floatingPanelRef.current
      if (!next || !panel) return
      panel.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`
      if (next.w != null) panel.style.width = `${next.w}px`
      if (next.h != null) panel.style.height = `${next.h}px`
      pendingPanelStyleRef.current = null
    }
    const schedulePanelStyle = (next: { x: number; y: number; w?: number; h?: number }) => {
      pendingPanelStyleRef.current = next
      if (panelFrameRef.current == null) panelFrameRef.current = window.requestAnimationFrame(flushPanelStyle)
    }
    const applyPanelState = (next: { x: number; y: number; w: number; h: number }) => {
      const clamped = clampFloatingPanelState(next)
      panelState.current = clamped
      schedulePanelStyle(clamped)
    }
    const applyButtonPosition = (next: { x: number; y: number }, scale = false) => {
      const clamped = clampAiButtonPosition(next)
      btnPosRef.current = clamped
      if (aiButtonRef.current) {
        aiButtonRef.current.style.transform = `translate(${clamped.x}px, ${clamped.y}px)${scale ? ' scale(1.05)' : ''}`
      }
    }
    const handlePanelMouseMove = (event: MouseEvent) => {
      if (!floatingPanelRef.current) return

      if (draggingPanel.current) {
        const dx = event.clientX - interactStart.current.mouseX
        const dy = event.clientY - interactStart.current.mouseY
        const newX = interactStart.current.panelX + dx
        const newY = interactStart.current.panelY + dy
        applyPanelState({ ...panelState.current, x: newX, y: newY })
      } else if (resizingPanel.current) {
        const dx = event.clientX - interactStart.current.mouseX
        const dy = event.clientY - interactStart.current.mouseY
        let { panelX, panelY, panelW, panelH } = interactStart.current
        const dir = resizingPanel.current

        if (dir.includes('e')) panelW = Math.max(320, panelW + dx)
        if (dir.includes('s')) panelH = Math.max(400, panelH + dy)
        if (dir.includes('w')) {
          const nextW = Math.max(320, panelW - dx)
          if (nextW > 320) {
            panelW = nextW
            panelX += dx
          }
        }
        if (dir.includes('n')) {
          const nextH = Math.max(400, panelH - dy)
          if (nextH > 400) {
            panelH = nextH
            panelY += dy
          }
        }

        applyPanelState({ x: panelX, y: panelY, w: panelW, h: panelH })
      }

      if (btnDragState.current.isDragging && aiButtonRef.current) {
        btnDragState.current.moved = true
        const dx = event.clientX - btnDragState.current.startX
        const dy = event.clientY - btnDragState.current.startY
        const newX = btnDragState.current.btnX + dx
        const newY = btnDragState.current.btnY + dy
        applyButtonPosition({ x: newX, y: newY }, true)
      }
    }

    const handlePanelMouseUp = () => {
      if (draggingPanel.current || resizingPanel.current) {
        draggingPanel.current = false
        resizingPanel.current = null
        document.body.style.cursor = ''
      }

      if (btnDragState.current.timer) {
        clearTimeout(btnDragState.current.timer)
        btnDragState.current.timer = 0
      }

      if (btnDragState.current.isDragging) {
        btnDragState.current.isDragging = false
        if (aiButtonRef.current) aiButtonRef.current.style.transition = ''
        applyButtonPosition(btnPosRef.current)
        document.body.style.cursor = ''
        setTimeout(() => {
          btnDragState.current.moved = false
        }, 50)
      }
    }

    const handleViewportResize = () => {
      applyPanelState(panelState.current)
      applyButtonPosition(btnPosRef.current)
    }

    document.addEventListener('mousemove', handlePanelMouseMove)
    document.addEventListener('mouseup', handlePanelMouseUp)
    window.addEventListener('resize', handleViewportResize)
    return () => {
      if (panelFrameRef.current != null) window.cancelAnimationFrame(panelFrameRef.current)
      pendingPanelStyleRef.current = null
      document.removeEventListener('mousemove', handlePanelMouseMove)
      document.removeEventListener('mouseup', handlePanelMouseUp)
      window.removeEventListener('resize', handleViewportResize)
    }
  }, [])

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!draggingDivider.current || !containerRef.current) return
      const containerWidth = containerRef.current.clientWidth
      const dividerOffset = event.clientX - containerRef.current.getBoundingClientRect().left
      const nextPercent = Math.max(20, Math.min(80, (dividerOffset / containerWidth) * 100))
      setLeftWidth(nextPercent)
    }

    const handleMouseUp = () => {
      if (draggingDivider.current) {
        draggingDivider.current = false
        setIsDraggingDivider(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const handlePanelDragStart = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest('.resize-handle') || (event.target as HTMLElement).closest('button')) return
    draggingPanel.current = true
    interactStart.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      panelX: panelState.current.x,
      panelY: panelState.current.y,
      panelW: panelState.current.w,
      panelH: panelState.current.h,
    }
    document.body.style.cursor = 'grabbing'
  }

  const handleResizeStart = (event: ReactMouseEvent, dir: string) => {
    event.stopPropagation()
    event.preventDefault()
    resizingPanel.current = dir
    interactStart.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      panelX: panelState.current.x,
      panelY: panelState.current.y,
      panelW: panelState.current.w,
      panelH: panelState.current.h,
    }
    document.body.style.cursor = `${dir}-resize`
  }

  const handleDividerMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    draggingDivider.current = true
    setIsDraggingDivider(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const activateReaderSearchMatch = (matchIndex: number) => {
    const matches = shouldUseTextReaderMode ? textReaderMatches : searchMatches
    if (matches.length === 0) return
    const nextIndex = (matchIndex + matches.length) % matches.length
    const match = matches[nextIndex]
    setCurrentMatchIndex(nextIndex)
    setReaderSearchResultPage(Math.floor(nextIndex / READER_SEARCH_RESULT_PAGE_SIZE) + 1)
    setDocumentSearchSession((previous) => previous?.query === effectiveSearchKeyword ? { ...previous, activeHitIndex: match.hitIndex ?? nextIndex } : previous)
    if (shouldUseTextReaderMode) {
      setReaderPageIndex(match.pageIndex)
    } else if (match.pageIndex !== currentPageIndex) {
      setCurrentPageIndex(match.pageIndex)
      void loadPagesAround(match.pageIndex, 5)
    }
    setActiveBoxIndex(match.boxIndex)
  }

  const handleSearchNext = () => {
    const matches = shouldUseTextReaderMode ? textReaderMatches : searchMatches
    if (matches.length === 0) return
    activateReaderSearchMatch(currentMatchIndex < matches.length - 1 ? currentMatchIndex + 1 : 0)
  }

  const handleSearchPrev = () => {
    const matches = shouldUseTextReaderMode ? textReaderMatches : searchMatches
    if (matches.length === 0) return
    activateReaderSearchMatch(currentMatchIndex > 0 ? currentMatchIndex - 1 : matches.length - 1)
  }

  const commitSearchInputDraft = () => {
    const nextKeyword = searchInputDraft.trim()
    // Same keyword still re-runs when engine differs or user hits Enter after 向量→文本.
    setLocalSearchKeyword(nextKeyword)
    setCurrentMatchIndex(-1)
    setActiveBoxIndex(-1)
    runInDocumentSearch(nextKeyword, readerSearchEngine)
  }

  const proofSearchHighlightKeyword = useMemo(() => {
    if (!isVectorReaderSearch) return effectiveSearchKeyword
    const hit = documentSearchSession?.hits?.[Math.max(0, documentSearchSession.activeHitIndex ?? 0)]
    const matchText = String(hit?.locator?.matchText || hit?.snippet || '').replace(/\s+/g, ' ').trim()
    if (matchText.length >= 3) return matchText.slice(0, 3)
    return effectiveSearchKeyword
  }, [documentSearchSession?.activeHitIndex, documentSearchSession?.hits, effectiveSearchKeyword, isVectorReaderSearch])

  const handleStartOcr = async () => {
    if (!doc?.pages?.length) return
    setOcrProcessing(true)
    try {
      const forceFullRerun = doc.ocr_status === 'completed'
      if (forceFullRerun) {
        await window.api.updateDocument(doc.id, { ocr_status: 'pending' })
      }
      const storedEngine = parseMaybeJson(doc.metadata)?.ocr_engine
      const targetEngine = isOcrEngine(storedEngine)
        ? storedEngine === 'local_paddle' || storedEngine === 'hybrid' ? 'paddle' : storedEngine
        : undefined
      if (targetEngine === 'vision_model') {
        const messageKey = `document-ocr-${doc.id}`
        try {
          await ensureOcrPageImages(doc, {
            engine: targetEngine,
            messageKey,
            getEngineLabel: getOcrEngineLabel,
            onProgress: (content, key) => message.loading({ content, key: key || messageKey, duration: 0 }),
          })
        } finally {
          message.destroy(messageKey)
        }
      }
      const count = await window.api.batchOcr([doc.id], {
        ...(targetEngine ? { engine: targetEngine } : {}),
        forceFullRerun,
      })
      if (count > 0) {
        message.success('OCR 识别成功')
      } else {
        const latest = await window.api.getDocumentLight(doc.id)
        message.error(`OCR failed: ${latest?.error_message || 'Unknown error'}`)
      }
      if (currentPage?.id) {
        await refreshDocumentKeepPage(currentPage.id)
      } else {
        await loadDocument()
      }
    } catch (error: unknown) {
      console.error(error)
      message.error(`OCR failed: ${getErrorMessage(error, 'Unknown error')}`)
      if (currentPage?.id) {
        await refreshDocumentKeepPage(currentPage.id)
      } else {
        await loadDocument()
      }
    } finally {
      setOcrProcessing(false)
    }
  }

  const handleExtractMetadata = async () => {
    if (!doc) return
    setExtracting(true)
    try {
      const result = await window.api.autoExtract(doc.id)
      if (result && Object.keys(result).length > 0) {
        const docType = result._doc_type || '未知类型'
        message.success(`AI extraction completed: ${docType}`)
      } else {
        message.warning('AI did not extract valid metadata')
      }
      await loadDocument()
    } catch (error: unknown) {
      console.error(error)
      message.error(`提取失败：${getErrorMessage(error, '未知错误')}`)
    } finally {
      setExtracting(false)
    }
  }

  const handleSaveMetadata = async (
    newMetadata: Record<string, unknown>,
    newBaseInfo: Pick<DocumentUpdatePayload, 'title' | 'author' | 'doc_type' | 'metadata_status'>,
  ) => {
    if (!doc?.id) return
    await window.api.updateDocument(doc.id, { ...newBaseInfo, metadata: JSON.stringify(newMetadata) })
    await loadDocument()
  }

  const handleSavePage = async (pageId: string, data: PageUpdatePayload): Promise<boolean> => {
    const previousPageOcrStatus = doc?.pages?.find((page) => page.id === pageId)?.ocr_status
    try {
      await window.api.updatePage(pageId, data)
      if (data.ocr_result !== undefined || data.ocr_text !== undefined || data.proofed_text !== undefined) {
        setPageTranslations((current) => {
          const next = { ...current }
          delete next[pageId]
          return next
        })
        setPageTranslationHashes((current) => {
          const next = { ...current }
          delete next[pageId]
          return next
        })
        setSkippedTranslationPageIds((current) => {
          const next = { ...current }
          delete next[pageId]
          return next
        })
      }
      setDoc((previous) => {
        if (!previous?.pages) return previous

        const nextPages = previous.pages.map((page) => {
          if (page.id !== pageId) return page
          const nextOcrResult = data.ocr_result === undefined
            ? page.ocr_result
            : typeof data.ocr_result === 'string'
              ? data.ocr_result
              : JSON.stringify(data.ocr_result)
          return {
            ...page,
            ocr_result: nextOcrResult,
            ocr_text: data.ocr_text ?? page.ocr_text,
            proofed_text: data.proofed_text ?? page.proofed_text,
            ocr_status: data.ocr_status ?? page.ocr_status,
            proof_status: data.proof_status ?? page.proof_status,
            has_ocr_text: data.ocr_text !== undefined || data.proofed_text !== undefined
              ? String(data.proofed_text ?? data.ocr_text ?? page.proofed_text ?? page.ocr_text ?? '').trim().length > 0
              : page.has_ocr_text,
            needs_layout_attention: data.ocr_result !== undefined
              ? (() => {
                  const parsedResult = parseMaybeJson(data.ocr_result)
                  const ir = getOcrPageIr(parsedResult)
                  return asFacsimileBlocks(readRecordValue(parsedResult, 'layout_result')).some((block) => !!block?.needs_enhancement)
                    || Boolean(ir && (
                      ir.page.quality.score < 0.65
                      || ir.page.quality.issues.some((issue) => issue.severity === 'error' || issue.severity === 'warning')
                    ))
                })()
              : page.needs_layout_attention,
          }
        })

        const allPagesHaveOcrContent = nextPages.length > 0 && nextPages.every((page) => (
          page.ocr_status === 'completed' || page.has_ocr_text
        ))
        return {
          ...previous,
          ...(allPagesHaveOcrContent ? {
            ocr_status: 'completed' as const,
            import_status: 'processed' as const,
            error_message: null,
          } : {}),
          proof_status: nextPages.length > 0 && nextPages.every((page) => page.proof_status === 'completed') ? 'completed' : 'pending',
          pages: nextPages,
        }
      })
      if (data.ocr_status === 'completed' && previousPageOcrStatus !== 'completed') {
        window.dispatchEvent(new CustomEvent(LIBRARY_RELATIONS_CHANGED_EVENT, {
          detail: { source: 'ocr-page-content-saved' },
        }))
      }
      return true
    } catch (error) {
      console.error(error)
      message.error('保存失败')
      return false
    }
  }

  const handleSaveFacsimilePage = async (pageId: string, data: PageUpdatePayload): Promise<void> => {
    const saved = await handleSavePage(pageId, data)
    if (!saved) throw new Error('Facsimile page save failed')
  }

  const handleResetPage = async (pageId: string) => {
    try {
      await window.api.resetPageOcr(pageId)
      setPageTranslations((current) => {
        const next = { ...current }
        delete next[pageId]
        return next
      })
      setPageTranslationHashes((current) => {
        const next = { ...current }
        delete next[pageId]
        return next
      })
      setSkippedTranslationPageIds((current) => {
        const next = { ...current }
        delete next[pageId]
        return next
      })
      await loadDocument()
      message.success('已还原为原始识别结果')
    } catch (error) {
      console.error(error)
      message.error('还原失败')
    }
  }

  const cacheRestoredPdfCurrentPage = async (
    sourceFilePath?: string | null,
    targetPage: DocumentViewPage | undefined = currentPage,
  ): Promise<boolean> => {
    if (!doc?.id || !targetPage?.page_num) return false
    const cacheKey = getPageImageCacheKey(targetPage, doc.id, documentId)
    pageImageCacheRef.current.delete(cacheKey)
    if (doc.file_path && String(doc.file_path).toLowerCase().endsWith('.pdf')) {
      releaseCachedPdfDocument(doc.file_path)
    }
    const messageKey = `restore-pdf-page-${doc.id}-${targetPage.page_num}`
    try {
      if (sourceFilePath) {
        message.loading({ content: '正在生成当前页预览…', key: messageKey, duration: 0 })
        const rendered = await renderPdfFilePageToImage(sourceFilePath, targetPage.page_num)
        const imagePath = await window.api.cachePageImage(doc.id, targetPage.page_num, rendered.dataUrl)
        putLimitedPageImageCache(pageImageCacheRef.current, cacheKey, rendered.dataUrl)
        setDoc((previous) => {
          if (!previous?.pages) return previous
          const nextMetadata = parseMaybeJson(previous.metadata)
          return {
            ...previous,
            file_path: sourceFilePath || previous.file_path,
            metadata: JSON.stringify({ ...nextMetadata, pdf_asset_state: 'available' }),
            pages: previous.pages.map((page) => (
              page.id === targetPage.id || page.page_num === targetPage.page_num
                ? { ...page, image_path: imagePath }
                : page
            )),
          }
        })
        if (targetPage.id === currentPage?.id || targetPage.page_num === currentPage?.page_num) {
          setImageDataUrl(rendered.dataUrl)
        }
        return true
      }

      const result = await ensureOcrPageImages(doc, {
        pageNums: [targetPage.page_num],
        sourceFilePath,
        messageKey,
        onProgress: (content, key) => message.loading({ content, key: key || messageKey, duration: 0 }),
        onPageCached: async (pageNum, _imagePath, dataUrl) => {
          if (pageNum !== targetPage.page_num) return
          putLimitedPageImageCache(pageImageCacheRef.current, cacheKey, dataUrl)
          if (targetPage.id === currentPage?.id || targetPage.page_num === currentPage?.page_num) {
            setImageDataUrl(dataUrl)
          }
        },
      })
      return result.ready && (
        result.cachedPageNums.includes(targetPage.page_num)
        || await isReadablePageImagePath(targetPage.image_path)
      )
    } catch (error) {
      console.warn('[DocumentView] restored PDF is not readable for current page preview', error)
      return isReadablePageImagePath(targetPage.image_path)
    } finally {
      message.destroy(messageKey)
    }
  }

  const handleRestorePdfAsset = async (
    targetPage: DocumentViewPage | undefined = currentPage,
    manual = false,
    options?: { quietFailure?: boolean },
  ) => {
    if (!doc?.id) return false
    setRestoringPdf(true)
    try {
      const result = manual
        ? await window.api.selectAndRestorePdfForDocument(doc.id)
        : await window.api.restorePdfForDocument(doc.id)
      if (result?.restored) {
        const refreshed = await refreshDocumentKeepPage(targetPage?.id || currentPage?.id)
        const refreshedPage = refreshed?.pages?.find((page) => (
          (targetPage?.id && page.id === targetPage.id)
          || (targetPage?.page_num && page.page_num === targetPage.page_num)
        ))
        const pageReady = await cacheRestoredPdfCurrentPage(result.path, refreshedPage || targetPage)
        window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
        const linked = result.storageMode === 'link'
        const base = linked
          ? 'PDF 已链接补回（未复制到软件目录）'
          : 'PDF 原图已补回'
        if (!options?.quietFailure && pageReady) {
          message.success(`${base}，当前页预览已恢复`)
        } else if (!pageReady) {
          message.warning(options?.quietFailure
            ? '已连接 PDF 原件，但当前页预览生成失败；请重新打开文献，或手动选择原件'
            : `${base}；当前页预览生成失败，可手动重新选择 PDF 或重新打开文献`)
        }
        return true
      }
      if (!options?.quietFailure) {
        message.warning(result?.error || '未能补回 PDF 原图')
      }
      return false
    } catch (error: unknown) {
      console.error(error)
      if (!options?.quietFailure) {
        message.error(getErrorMessage(error, '补回 PDF 原图失败'))
      }
      return false
    } finally {
      setRestoringPdf(false)
    }
  }

  const handleRestorePdfManually = async () => {
    await handleRestorePdfAsset(currentPage, true)
  }

  const switchDocumentMode = async (nextMode: DocumentMode) => {
    // Always re-assert intention + serial first so in-flight getReaderState cannot snap back.
    const previousMode = documentMode
    const alreadyOnTarget = nextMode === documentMode && nextMode === intendedDocumentModeRef.current
    documentModeTouchedRef.current = true
    intendedDocumentModeRef.current = nextMode
    const switchSerial = ++documentModeSwitchSerialRef.current

    // Cancel any pending debounced save (often still carrying the previous mode).
    if (readerSaveTimerRef.current) {
      window.clearTimeout(readerSaveTimerRef.current)
      readerSaveTimerRef.current = null
    }

    // Optimistic UI: flip Segmented immediately so the first click sticks.
    setDocumentMode(nextMode)
    if (alreadyOnTarget) {
      // Still re-pin mode after a failed bounce, then stop if nothing else to do.
      return
    }

    // Resolve the *source* page the user is currently looking at.
    const resolveViewingSourcePageIndex = (): number => {
      if (previousMode === 'read') {
        if (shouldUseTextReaderMode) {
          const virtual = readerVirtualPages[readerPageIndex]
          if (virtual && Number.isFinite(Number(virtual.sourcePageIndex))) {
            return clampPageIndex(Number(virtual.sourcePageIndex), pageCount)
          }
        }
        const fromRef = Number(readerVisiblePageIndexRef.current)
        if (Number.isFinite(fromRef) && fromRef >= 0) {
          return clampPageIndex(fromRef, pageCount)
        }
      }
      return clampPageIndex(currentPageIndex, pageCount)
    }

    const syncedPageIndex = resolveViewingSourcePageIndex()
    readerVisiblePageIndexRef.current = syncedPageIndex

    if (nextMode === 'proof' && needsPdfAssetRestore) {
      // Prefer auto warehouse restore; fall back to manual pick when fingerprint is missing (unknown).
      let restored = await handleRestorePdfAsset(sortedPages[syncedPageIndex] || currentPage, false, { quietFailure: true })
      if (documentModeSwitchSerialRef.current !== switchSerial || intendedDocumentModeRef.current !== nextMode) return
      if (!restored) {
        restored = await handleRestorePdfAsset(sortedPages[syncedPageIndex] || currentPage, true)
      }
      if (documentModeSwitchSerialRef.current !== switchSerial || intendedDocumentModeRef.current !== nextMode) return
      if (!restored) {
        // Revert optimistic mode if PDF cannot be restored for proof.
        intendedDocumentModeRef.current = previousMode
        setDocumentMode(previousMode)
        message.warning('无法补回原始 PDF，请手动选择 PDF 后再进入校对模式')
        return
      }
    }
    if (documentModeSwitchSerialRef.current !== switchSerial || intendedDocumentModeRef.current !== nextMode) return

    setCurrentPageIndex(syncedPageIndex)
    setPageInput(String((sortedPages[syncedPageIndex]?.page_num || syncedPageIndex + 1)))
    const activeSearchMatch = currentMatchIndex >= 0
      ? (shouldUseTextReaderMode ? textReaderMatches[currentMatchIndex] : searchMatches[currentMatchIndex])
      : null
    if (nextMode === 'proof' && activeSearchMatch && activeSearchMatch.pageIndex === syncedPageIndex) {
      setActiveBoxIndex(activeSearchMatch.boxIndex)
    } else if (nextMode === 'proof') {
      setActiveBoxIndex(-1)
    }
    if (nextMode === 'read') {
      const nextReaderPageIndex = getReaderPageIndexForSourcePage(syncedPageIndex)
      setReaderPageIndex(nextReaderPageIndex)
    } else {
      setImageDataUrl('')
      setNextImageDataUrl('')
      setPageImageLoading(false)
      pageImageCacheRef.current.clear()
      if (doc?.file_path && String(doc.file_path).toLowerCase().endsWith('.pdf')) {
        releaseCachedPdfDocument(doc.file_path)
      }
    }

    const nextState = nextMode === 'proof'
      ? buildProofReaderState(syncedPageIndex)
      : buildPageReaderState(syncedPageIndex)
    // Always persist the intended mode immediately (even during temporary search navigation).
    if (nextState) {
      if (readerSaveTimerRef.current) {
        window.clearTimeout(readerSaveTimerRef.current)
        readerSaveTimerRef.current = null
      }
      latestReaderStateRef.current = { ...latestReaderStateRef.current, ...nextState, document_mode: nextMode }
      void window.api.saveReaderState(documentId, latestReaderStateRef.current).catch((error: unknown) => {
        console.error('Failed to save reader state after mode switch', error)
      })
    }
    void loadPagesAround(syncedPageIndex, 4)
  }

  const handleRerunCurrentPageOcr = async (imageRotation: 0 | 90 = 0) => {
    if (!currentPage?.id) return
    const targetPageId = currentPage.id
    setOcrProcessing(true)
    try {
      const hasPageImage = await forceRenderCurrentPageImageFromPdf(currentPage)
      if (!hasPageImage) {
        throw new Error('当前页缺少图像，且没有可用于重建页图的 PDF 原稿')
      }
      await window.api.rerunPageOcr(targetPageId, {
        profile: shouldUseVerticalOcr ? 'guji_print_vertical' : 'general',
        secondPass: shouldUseVerticalOcr ? 'local_segmentation' : 'none',
        imageRotation,
      })
      await refreshDocumentKeepPage(targetPageId)
      await loadCurrentPageOcrVersions(targetPageId)
      setPageTranslations((current) => {
        const next = { ...current }
        delete next[targetPageId]
        return next
      })
      setSkippedTranslationPageIds((current) => {
        const next = { ...current }
        delete next[targetPageId]
        return next
      })
      message.success(imageRotation === 90 ? '已横向重新识别本页 OCR' : '已重新识别本页 OCR')
    } catch (error: unknown) {
      console.error(error)
      message.error(`OCR failed: ${getErrorMessage(error, 'Unknown error')}`)
    } finally {
      setOcrProcessing(false)
    }
  }

  const handleRerunCurrentPageVisionOcr = async () => {
    if (!currentPage?.id) return
    const targetPageId = currentPage.id
    setOcrProcessing(true)
    try {
      const hasPageImage = await forceRenderCurrentPageImageFromPdf(currentPage)
      if (!hasPageImage) {
        throw new Error('当前页缺少图像，且没有可用于重建页图的 PDF 原稿')
      }
      await window.api.rerunPageVisionOcr(targetPageId)
      await refreshDocumentKeepPage(targetPageId)
      await loadCurrentPageOcrVersions(targetPageId)
      setPageTranslations((current) => {
        const next = { ...current }
        delete next[targetPageId]
        return next
      })
      setSkippedTranslationPageIds((current) => {
        const next = { ...current }
        delete next[targetPageId]
        return next
      })
      message.success('已用视觉 OCR 重新识别本页')
    } catch (error: unknown) {
      console.error(error)
      message.error(`视觉 OCR failed: ${getErrorMessage(error, 'Unknown error')}`)
    } finally {
      setOcrProcessing(false)
    }
  }

  const handleReprocessDocumentOcrStructure = async () => {
    if (!doc?.id) return
    const targetPageId = currentPage?.id
    setOcrProcessing(true)
    try {
      const changedPageCount = await window.api.reprocessOcrStructure(doc.id)
      if (targetPageId) await refreshDocumentKeepPage(targetPageId)
      setPageTranslations({})
      setSkippedTranslationPageIds({})
      message.success(changedPageCount > 0
        ? `已重新整理 ${changedPageCount} 页文本结构，未重新调用 OCR`
        : '没有可重新整理的 OCR 页面')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '重新整理 OCR 结构失败'))
    } finally {
      setOcrProcessing(false)
    }
  }

  const handleRerecognizeLowQualityBlocks = async () => {
    if (!currentPage?.id) return
    const targetPageId = currentPage.id
    setOcrProcessing(true)
    try {
      const hasPageImage = await forceRenderCurrentPageImageFromPdf(currentPage)
      if (!hasPageImage) {
        throw new Error('当前页缺少图像，且没有可用于局部重识别的 PDF 原稿')
      }
      const result = await window.api.rerecognizeLowQualityOcrBlocks(targetPageId, { maxBlocks: 8 })
      if (result.updatedBlockCount > 0) {
        await refreshDocumentKeepPage(targetPageId)
        await loadCurrentPageOcrVersions(targetPageId)
        setPageTranslations((current) => {
          const next = { ...current }
          delete next[targetPageId]
          return next
        })
        setSkippedTranslationPageIds((current) => {
          const next = { ...current }
          delete next[targetPageId]
          return next
        })
        message.success(`已局部重识别 ${result.updatedBlockCount} 个异常文本块，人工校对文本未改动`)
      } else if (result.attemptedBlockCount === 0) {
        message.info('当前页没有适合局部重识别的异常文本块')
      } else {
        message.info('异常区域已检查，但没有质量更好的识别结果')
      }
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '局部重识别失败'))
    } finally {
      setOcrProcessing(false)
    }
  }

  const handleSwitchCurrentPageOcrVersion = async (engine: string) => {
    if (!currentPage?.id || !engine) return
    const targetPageId = currentPage.id
    setOcrVersionLoading(true)
    try {
      await window.api.switchPageOcrVersion(targetPageId, engine)
      await refreshDocumentKeepPage(targetPageId)
      await loadCurrentPageOcrVersions(targetPageId)
      setActiveBoxIndex(-1)
      message.success(`已切换到${getOcrEngineLabel(engine)}`)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '切换 OCR 结果失败'))
    } finally {
      setOcrVersionLoading(false)
    }
  }

  const handleEnhanceCurrentGujiPage = async () => {
    if (!currentPage?.id) return
    const targetPageId = currentPage.id
    setOcrProcessing(true)
    try {
      const hasPageImage = await forceRenderCurrentPageImageFromPdf(currentPage)
      if (!hasPageImage) {
        throw new Error('当前页缺少图像，且没有可用于重建页图的 PDF 原稿')
      }
      await window.api.enhanceGujiPage(targetPageId, {
        profile: 'guji_print_vertical',
        secondPass: 'cloud_column_ocr',
      })
      await refreshDocumentKeepPage(targetPageId)
      await loadCurrentPageOcrVersions(targetPageId)
      setPageTranslations((current) => {
        const next = { ...current }
        delete next[targetPageId]
        return next
      })
      setSkippedTranslationPageIds((current) => {
        const next = { ...current }
        delete next[targetPageId]
        return next
      })
      message.success('Page enhanced')
    } catch (error: unknown) {
      console.error(error)
      message.error(`Enhance failed: ${getErrorMessage(error, 'Unknown error')}`)
    } finally {
      setOcrProcessing(false)
    }
  }

  const handleRerunCurrentPageLayout = async () => {
    if (!currentPage?.id) return
    const targetPageId = currentPage.id
    setOcrProcessing(true)
    try {
      const hasPageImage = await forceRenderCurrentPageImageFromPdf(currentPage)
      if (!hasPageImage) {
        throw new Error('当前页缺少图像，且没有可用于重建页图的 PDF 原稿')
      }
      await window.api.rerunPageLayout(targetPageId, {
        profile: shouldUseVerticalOcr ? 'guji_print_vertical' : 'general',
        secondPass: 'local_segmentation',
      })
      await refreshDocumentKeepPage(targetPageId)
      await loadCurrentPageOcrVersions(targetPageId)
      setPageTranslations((current) => {
        const next = { ...current }
        delete next[targetPageId]
        return next
      })
      setSkippedTranslationPageIds((current) => {
        const next = { ...current }
        delete next[targetPageId]
        return next
      })
      message.success('已重排本页版面')
    } catch (error: unknown) {
      console.error(error)
      message.error(`Layout failed: ${getErrorMessage(error, 'Unknown error')}`)
    } finally {
      setOcrProcessing(false)
    }
  }

  const jumpToPage = useCallback((value: string | number) => {
    if (pageCount === 0) return
    const nextValue = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10)
    if (!Number.isFinite(nextValue)) {
      message.warning('请输入有效页码')
      setPageInput(String(currentPageIndex + 1))
      return
    }

    const nextPage = Math.max(1, Math.min(pageCount, nextValue))
    setCurrentPageIndex(nextPage - 1)
    setPageInput(String(nextPage))
  }, [currentPageIndex, pageCount])

  const handleInsertManualPage = useCallback(async (position: ManualPageInsertRequest['position']) => {
    const targetPageId = currentPage?.id
    if (!documentId || !targetPageId || manualPageInsertionLoading) return
    pageRangeInFlightRef.current.clear()
    pageRangeRequestRef.current += 1
    searchPagesRequestIdRef.current += 1
    setManualPageInsertionLoading(true)
    try {
      const result = await window.api.insertManualPage({
        documentId,
        anchorPageId: targetPageId,
        position,
      })
      pageRangeInFlightRef.current.clear()
      pageRangeRequestRef.current += 1
      searchPagesRequestIdRef.current += 1
      pageImageCacheRef.current.delete(targetPageId)
      pageImageCacheRef.current.delete(result.inserted.id)
      setImageDataUrl('')
      setNextImageDataUrl('')
      setImageViewerResetToken((value) => value + 1)
      setActiveBoxIndex(-1)
      setSwitchToRegion(false)
      const refreshed = await refreshDocumentKeepPage(result.inserted.id)
      if (!refreshed) throw new Error('插入后无法刷新文献页面')
      pageRangeInFlightRef.current.clear()
      pageRangeRequestRef.current += 1
      searchPagesRequestIdRef.current += 1
      setPageInput(String(result.inserted.page_num))
      message.success(position === 'before' ? '已在当前页前插入空白页' : '已在当前页后插入空白页')
    } catch (error: unknown) {
      console.error('Failed to insert manual blank page', error)
      message.error(`插入空白页失败：${getErrorMessage(error, '未知错误')}`)
    } finally {
      setManualPageInsertionLoading(false)
    }
  }, [currentPage?.id, documentId, manualPageInsertionLoading, refreshDocumentKeepPage])

  const handleDeleteManualPage = useCallback(() => {
    const targetPageId = currentPage?.id
    if (!documentId || !targetPageId || manualPageDeletionLoading) return
    if (pageCount <= 1) {
      message.warning('文献至少需要保留一页，无法删除最后一页')
      return
    }

    Modal.confirm({
      title: '删除当前页面？',
      content: '该页面的 OCR、版式、翻译、向量和检索缓存会一并移除，但不会删除外部仓库或原始 PDF 文件。删除后后续页面会自动前移。',
      okText: '删除页面',
      cancelText: '取消',
      okType: 'danger',
      onOk: async () => {
        pageRangeInFlightRef.current.clear()
        pageRangeRequestRef.current += 1
        searchPagesRequestIdRef.current += 1
        setManualPageDeletionLoading(true)
        try {
          const result = await window.api.deleteManualPage({ documentId, pageId: targetPageId })
          pageRangeInFlightRef.current.clear()
          pageRangeRequestRef.current += 1
          searchPagesRequestIdRef.current += 1
          pageImageCacheRef.current.delete(targetPageId)
          setImageDataUrl('')
          setNextImageDataUrl('')
          setImageViewerResetToken((value) => value + 1)
          setActiveBoxIndex(-1)
          setSwitchToRegion(false)
          setPageOcrVersions([])
          setPageTranslations((current) => {
            const next = { ...current }
            delete next[targetPageId]
            return next
          })
          setSkippedTranslationPageIds((current) => {
            const next = { ...current }
            delete next[targetPageId]
            return next
          })
          const refreshed = await refreshDocumentKeepPage(result.nextPageId || undefined)
          if (!refreshed) throw new Error('删除后无法刷新文献页面')
          const refreshedPage = result.nextPageId
            ? refreshed.pages.find((page) => page.id === result.nextPageId)
            : null
          setPageInput(String(refreshedPage?.page_num || Math.max(1, result.deletedPageNum)))
          message.success(`已删除第 ${result.deletedPageNum} 页`)
        } catch (error: unknown) {
          console.error('Failed to delete manual page', error)
          message.error(`删除页面失败：${getErrorMessage(error, '未知错误')}`)
        } finally {
          setManualPageDeletionLoading(false)
        }
      },
    })
  }, [currentPage?.id, documentId, manualPageDeletionLoading, pageCount, refreshDocumentKeepPage])

  const getReaderSearchInput = useCallback(() => {
    return containerRef.current?.querySelector<HTMLInputElement>('input[data-reader-search-input="true"]')
      || document.querySelector<HTMLInputElement>('.document-view input[data-reader-search-input="true"]')
  }, [])

  const focusReaderSearch = useCallback(() => {
    const input = getReaderSearchInput()
    if (!input) return false
    if (document.activeElement === input) {
      input.blur()
      return true
    }
    input.focus()
    input.select()
    return true
  }, [getReaderSearchInput])

  const clickReaderControl = useCallback((selector: string): boolean => {
    const button = containerRef.current?.querySelector<HTMLElement>(selector)
      || document.querySelector<HTMLElement>(`.document-view ${selector}`)
    if (!button) return false
    const disabled = button.getAttribute('aria-disabled') === 'true'
      || button.hasAttribute('disabled')
      || button.classList.contains('ant-btn-disabled')
      || button.closest('.ant-switch-disabled')
    if (disabled) return false
    button.click()
    return true
  }, [])

  const navigateShortcutPage = useCallback((direction: -1 | 1) => {
    const selector = direction < 0 ? '[data-reader-page-prev="true"]' : '[data-reader-page-next="true"]'
    if (clickReaderControl(selector)) return
    if (shouldUseTextReaderMode) {
      setReaderPageIndex((value) => clampPageIndex(value + (direction < 0 ? -2 : 2), readerVirtualPageCount))
      return
    }
    setCurrentPageIndex((value) => clampPageIndex(value + direction, pageCount))
  }, [clickReaderControl, pageCount, readerVirtualPageCount, shouldUseTextReaderMode])

  const scrollReaderContent = useCallback((direction: -1 | 1) => {
    const container = containerRef.current
    const scrollTarget = container?.querySelector<HTMLElement>('[data-reader-scroll="true"]')
      || container?.querySelector<HTMLElement>('[data-reader-page-viewport="true"]')?.parentElement
      || document.querySelector<HTMLElement>('.document-view [data-reader-scroll="true"]')
      || document.querySelector<HTMLElement>('.document-view [data-reader-page-viewport="true"]')?.parentElement
    const target = scrollTarget || container
    if (!target) return
    const amount = Math.max(160, Math.floor(target.clientHeight * 0.78))
    target.scrollBy({ top: direction * amount, behavior: 'smooth' })
  }, [])

  const handleTogglePageProofStatus = async () => {
    if (!currentPage?.id) return
    try {
      if (currentPageProofStatus === 'completed') {
        const saved = await handleSavePage(currentPage.id, { proof_status: 'pending' })
        if (!saved) return
        message.success('已取消本页校对完成')
      } else {
        const saved = await handleSavePage(currentPage.id, {
          proof_status: 'completed',
          proofed_text: currentPage.proofed_text || currentPage.ocr_text || '',
        })
        if (!saved) return
        message.success('已标记本页校对完成')
      }
    } catch (error) {
      console.error(error)
      message.error('更新校对状态失败')
    }
  }

  const handleExport: MenuProps['onClick'] = (event) => {
    if (exportingDocument || !doc?.id) return
    setPendingExportFormat(event.key as DocumentExportFormat)
    setExportPageNumberMode('literature')
    setExportModalOpen(true)
  }

  const confirmDocumentExport = async () => {
    const format = pendingExportFormat
    if (!format || exportingDocument || !doc?.id) return
    setExportingDocument(true)
    setExportModalOpen(false)
    message.loading({ content: '正在导出中，请稍候…', key: 'document-export', duration: 0 })
    try {
      const baseOptions: DocumentExportOptions = format === 'reading-pdf'
        ? {
            readingFontFamily: readerFontFamily,
            readingFontSize: readerFontSize,
            readingLineHeight: readerLineHeight,
            readingPageWidth: readerPageWidth,
            readingTheme: readerTheme,
            readingDisplayScript: readerDisplayScript,
            pageNumberMode: exportPageNumberMode,
          }
        : {
            ...(getFacsimileExportOptions(format) || {}),
            pageNumberMode: exportPageNumberMode,
          }
      const success = await window.api.exportDocument(doc.id, format, baseOptions)
      if (success) {
        const names: Record<string, string> = {
          markdown: 'Markdown',
          'tei-xml': 'TEI-XML',
          'page-xml': 'PAGE XML',
          'paddle-json': 'Paddle JSON',
          txt: 'TXT',
          'reading-pdf': '阅读模式 PDF',
          'layout-pdf': '排版模式 PDF',
          'layout-searchable-pdf': '原图可搜索 PDF',
        }
        message.success({ content: `已导出为 ${names[format] || format.toUpperCase()}`, key: 'document-export', duration: 4 })
      } else {
        message.destroy('document-export')
      }
    } catch (error) {
      console.error(error)
      message.error({ content: (error as Error)?.message || '导出失败', key: 'document-export', duration: 6 })
    } finally {
      setExportingDocument(false)
      setPendingExportFormat(null)
    }
  }

  const handleSaveCurrentPageExcerpt = async () => {
    if (!doc?.id || !currentPage) return
    const excerpt = String(currentPage.proofed_text || currentPage.ocr_text || '').trim()
    if (!excerpt) {
      message.info('本页还没有可保存的 OCR 文本')
      return
    }
    const internalPageNum = Number(currentPage.page_num || currentPageIndex + 1)
    const citationPageNum = getCitationPageNumber(
      currentPage,
      Number((currentPage as { literature_page_num?: number | null } | null)?.literature_page_num || 0) > 0
        ? Number((currentPage as { literature_page_num?: number | null }).literature_page_num)
        : internalPageNum,
    )
    const displayPageNum = citationPageNum || internalPageNum
    const fallbackCitationText = `${doc.title || '未命名文献'}${displayPageNum ? `，第 ${displayPageNum} 页` : ''}`
    let citationText = fallbackCitationText
    try {
      citationText = await resolveDocumentCitation(doc.id, { docType: doc.doc_type, pageNum: displayPageNum }) || fallbackCitationText
    } catch (error) {
      console.warn('Failed to generate page citation from active style, falling back to simple citation.', error)
    }

    try {
      await window.api.createResearchNote({
        doc_id: doc.id,
        page_num: displayPageNum,
        excerpt: excerpt.slice(0, 1200),
        note: '从文献页保存',
        source_type: 'manual',
        kind: 'quote',
        color: highlightColor || DEFAULT_HIGHLIGHT_COLOR,
        locator: locator || null,
        citation_text: citationText,
        source_id: JSON.stringify({
          sourceType: 'reader',
          locator: locator || null,
          citation: citationText,
          page_num: internalPageNum,
          pageNum: internalPageNum,
          citationPageNum,
          displayPageNum,
          sourcePageNum: internalPageNum,
          internalPageNum,
          searchKeyword: effectiveSearchKeyword || null,
          matchedQuery: effectiveSearchKeyword || null,
          locationKey: `page:${internalPageNum}`,
          sourceId: sourceId || null,
          href: null,
          chapterTitle: null,
        }),
      })
      message.success('已保存为研究摘录')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存摘录失败'))
    }
  }

  const translatePage = useCallback(async (page: TranslatablePage, silent = false, force = false) => {
    if (!doc?.id || !page?.id) return
    const targetDocId = doc.id
    if (page.doc_id && !isDocumentPageForDoc(page, targetDocId)) return
    const sourceText = getTranslationSourceText(page)
    if (!sourceText) {
      if (!silent) message.info('本页没有可翻译的文本')
      return
    }
    if ((!force && hasReadyTranslationForSource(page.id, sourceText)) || translationInFlightRef.current.has(page.id)) return
    const sourceHash = getTranslationSourceHash(page.id, sourceText)
    if (!force && await restoreTranslationFromCache(page.id, Number(page.page_num || page.sourcePageNum || 0), sourceText)) return
    if (activeDocumentIdRef.current !== targetDocId) return

    translationInFlightRef.current.add(page.id)
    setTranslatingPageIds((current) => ({ ...current, [page.id]: true }))
    try {
      const pageNum = Number(page.page_num || page.sourcePageNum || 0)
      const nextResult = await translateTextAsParallelSegments({
        pageId: page.id,
        pageNum,
        sourceText,
        force,
      })
      if (!nextResult) return
      if (activeDocumentIdRef.current !== targetDocId) return
      setPageTranslations((current) => ({ ...current, [page.id]: nextResult }))
      setPageTranslationHashes((current) => ({ ...current, [page.id]: sourceHash }))
      setSkippedTranslationPageIds((current) => {
        const next = { ...current }
        delete next[page.id]
        return next
      })
    } catch (error: unknown) {
      console.error(error)
      if (!silent) message.error(getErrorMessage(error, '翻译失败'))
    } finally {
      if (activeDocumentIdRef.current === targetDocId) {
        translationInFlightRef.current.delete(page.id)
        setTranslatingPageIds((current) => {
          const next = { ...current }
          delete next[page.id]
          return next
        })
      }
    }
  }, [doc?.id, getTranslationSourceHash, hasReadyTranslationForSource, restoreTranslationFromCache, translateTextAsParallelSegments])

  const toggleReaderTranslation = useCallback(() => {
    if (clickReaderControl('[data-reader-translation-toggle="true"]')) return
    if (currentPage) void translatePage(currentPage)
  }, [clickReaderControl, currentPage, translatePage])

  const runQueuedReaderTranslation = useCallback(async (item: ReaderTranslationQueueItem, silent = true) => {
    if (!doc?.id || !item?.pageId) return
    const targetDocId = doc.id
    const translationKey = getReaderTranslationKey(item)
    const cachePageId = getReaderTranslationCachePageId(item)
    const sourceText = String(item.text || '').trim()
    if (!sourceText) {
      if (!silent) message.info('当前阅读页还没有可整理的文本')
      return
    }
    if (!item.force && hasReadyTranslationForSource(translationKey, sourceText)) return
    const sourceHash = getTranslationSourceHash(translationKey, sourceText)
    if (!item.force && await restoreTranslationFromCache(translationKey, Number(item.pageNum || 0), sourceText, cachePageId)) return
    if (activeDocumentIdRef.current !== targetDocId) return
    if (item.generation !== translationCurrentGenerationRef.current) return
    if (translationInFlightGenerationRef.current.get(translationKey) === item.generation) return

    translationInFlightRef.current.add(translationKey)
    translationInFlightGenerationRef.current.set(translationKey, item.generation)
    setTranslatingPageIds((current) => ({ ...current, [translationKey]: true }))
    try {
      const nextResult = await translateTextAsParallelSegments({
        pageId: translationKey,
        cachePageId,
        pageNum: item.pageNum,
        sourceText,
        force: item.force,
        isStale: () => (
          item.generation !== translationCurrentGenerationRef.current
          || translationInFlightGenerationRef.current.get(translationKey) !== item.generation
        ),
      })
      if (!nextResult) return
      if (activeDocumentIdRef.current !== targetDocId) return
      if (item.generation !== translationCurrentGenerationRef.current) return
      if (translationInFlightGenerationRef.current.get(translationKey) !== item.generation) return
      setPageTranslations((current) => ({ ...current, [translationKey]: nextResult }))
      setPageTranslationHashes((current) => ({ ...current, [translationKey]: sourceHash }))
      setSkippedTranslationPageIds((current) => {
        const next = { ...current }
        delete next[translationKey]
        return next
      })
    } catch (error: unknown) {
      console.error(error)
      if (!silent) message.error(getErrorMessage(error, '翻译失败'))
    } finally {
      if (activeDocumentIdRef.current === targetDocId && translationInFlightGenerationRef.current.get(translationKey) === item.generation) {
        translationInFlightGenerationRef.current.delete(translationKey)
        translationInFlightRef.current.delete(translationKey)
        setTranslatingPageIds((current) => {
          const next = { ...current }
          delete next[translationKey]
          return next
        })
      }
      if (item.priority === 'current' && translationCurrentActiveGenerationRef.current === item.generation) {
        translationCurrentActiveGenerationRef.current = 0
      }
    }
  }, [doc?.id, getTranslationSourceHash, hasReadyTranslationForSource, restoreTranslationFromCache, translateTextAsParallelSegments])

  const drainReaderTranslationQueue = useCallback(() => {
    if (translationWorkerActiveRef.current) return
    translationWorkerActiveRef.current = true

    const runNext = async () => {
      try {
        while (translationQueueRef.current.length > 0) {
          const item = translationQueueRef.current.shift()
          if (!item) continue
          if (item.generation !== translationCurrentGenerationRef.current) continue
          if (item.priority === 'prefetch' && translationCurrentActiveGenerationRef.current === item.generation) {
            translationQueueRef.current.unshift(item)
            break
          }
          const translationKey = getReaderTranslationKey(item)
          if (hasReadyTranslationForSource(translationKey, item.text)) continue
          if (translationInFlightGenerationRef.current.get(translationKey) === item.generation) continue
          await runQueuedReaderTranslation(item, true)
        }
      } finally {
        translationWorkerActiveRef.current = false
        const currentGeneration = translationCurrentGenerationRef.current
        const waitingForCurrentPage = translationCurrentActiveGenerationRef.current === currentGeneration
        const hasReadyItem = translationQueueRef.current.some((item) => (
          item.generation === currentGeneration
          && !(waitingForCurrentPage && item.priority === 'prefetch')
        ))
        if (hasReadyItem) {
          drainReaderTranslationQueue()
        }
      }
    }

    void runNext()
  }, [hasReadyTranslationForSource, runQueuedReaderTranslation])

  const requestReaderTranslation = useCallback((payload: ReaderTranslationPayload, options: ReaderTranslationOptions = {}) => {
    if (!payload?.pageId) return
    const sourceText = String(payload.text || '').trim()
    if (!sourceText) return

    const translationKey = getReaderTranslationKey(payload)
    const priority = options.priority || 'current'
    const alreadyTranslated = !options.force && hasReadyTranslationForSource(translationKey, sourceText)
    if (priority === 'current') {
      const activeGeneration = translationCurrentActiveGenerationRef.current
      if (translationCurrentPageIdRef.current === translationKey && alreadyTranslated) {
        return
      }
      if (
        activeGeneration > 0
        && translationInFlightGenerationRef.current.get(translationKey) === activeGeneration
      ) {
        return
      }
      translationCurrentGenerationRef.current += 1
      const generation = translationCurrentGenerationRef.current
      translationCurrentPageIdRef.current = translationKey
      translationCurrentActiveGenerationRef.current = generation
      translationQueueRef.current = []
      if (alreadyTranslated) {
        translationCurrentActiveGenerationRef.current = 0
        return
      }
      const currentItem: ReaderTranslationQueueItem = { ...payload, text: sourceText, priority, generation, force: options.force }
      void runQueuedReaderTranslation(currentItem, false).finally(() => drainReaderTranslationQueue())
      drainReaderTranslationQueue()
      return
    }

    if (alreadyTranslated) return
    const generation = translationCurrentGenerationRef.current
    if (generation <= 0 && priority !== 'book') return
    const effectiveGeneration = generation > 0 ? generation : translationCurrentGenerationRef.current + 1
    if (generation <= 0 && priority === 'book') translationCurrentGenerationRef.current = effectiveGeneration
    if (translationInFlightGenerationRef.current.get(translationKey) === effectiveGeneration) return
    const prefetchItem: ReaderTranslationQueueItem = { ...payload, text: sourceText, priority, generation: effectiveGeneration, force: options.force }
    const queue = translationQueueRef.current
      .filter((item) => item.generation === effectiveGeneration && getReaderTranslationKey(item) !== translationKey)
    translationQueueRef.current = priority === 'book'
      ? [...queue, prefetchItem]
      : [...queue.filter((item) => item.priority === 'prefetch'), prefetchItem].slice(0, 2)
    drainReaderTranslationQueue()
  }, [drainReaderTranslationQueue, hasReadyTranslationForSource])

  const updateReaderTranslationUnit = useCallback(async (pageId: string, unitId: string, translationText: string) => {
    const expectedRevisionId = (pageTranslationUnits[pageId] || []).find((unit) => unit.id === unitId)?.currentRevisionId || null
    const updated = await window.api.updateTranslationUnit(unitId, {
      translationText,
      manualOverride: true,
      expectedRevisionId,
    })
    if (!updated) throw new Error('翻译单元不存在')
    setPageTranslationUnits((current) => {
      const nextUnits = (current[pageId] || []).map((unit) => unit.id === unitId ? updated : unit)
      const readyText = getReadyTranslationTextFromUnits(nextUnits)
      setPageTranslations((translations) => ({
        ...translations,
        [pageId]: readyText,
      }))
      return { ...current, [pageId]: nextUnits }
    })
  }, [pageTranslationUnits])

  const retranslateReaderTranslationUnit = useCallback(async (payload: ReaderTranslationPayload, unitId: string) => {
    if (!doc?.id) return
    const translationKey = getReaderTranslationKey(payload)
    const cachePageId = getReaderTranslationCachePageId(payload)
    setTranslatingPageIds((current) => ({ ...current, [translationKey]: true }))
    try {
      const result = await window.api.translatePageUnits({
        docId: doc.id,
        pageId: cachePageId,
        mode: translationMode,
        glossaryProjectId: activeTranslationGlossaryProjectId,
        style: DEFAULT_TRANSLATION_STYLE,
        force: true,
        unitIds: [unitId],
        priority: 'current',
        documentTitle: doc.title || '',
        pageContextBefore: getAdjacentTranslationContext(cachePageId, -1),
        pageContextAfter: getAdjacentTranslationContext(cachePageId, 1),
      })
      setPageTranslationUnits((current) => ({ ...current, [translationKey]: result.units }))
      setPageTranslations((current) => ({ ...current, [translationKey]: getReadyTranslationTextFromUnits(result.units) || result.translationText }))
      setPageTranslationHashes((current) => ({
        ...current,
        [translationKey]: getTranslationSourceHash(translationKey, payload.text),
      }))
    } finally {
      setTranslatingPageIds((current) => {
        const next = { ...current }
        delete next[translationKey]
        return next
      })
    }
  }, [activeTranslationGlossaryProjectId, doc?.id, doc?.title, getAdjacentTranslationContext, getTranslationSourceHash, translationMode])

  const openQuickGlossaryTermModal = useCallback(() => {
    const sourceTerm = selectedTextForAi.replace(/\s+/g, ' ').trim()
    if (!sourceTerm) {
      message.info('请先在阅读器中选中文本')
      return
    }
    setQuickGlossaryScope(activeTranslationGlossaryProjectId ? 'project' : 'global')
    setQuickGlossarySourceTerm(sourceTerm.slice(0, 160))
    setQuickGlossaryTargetTerm('')
    setQuickGlossaryNote('')
    setQuickGlossaryModalOpen(true)
  }, [activeTranslationGlossaryProjectId, selectedTextForAi])

  const saveQuickGlossaryTerm = useCallback(async () => {
    const sourceTerm = quickGlossarySourceTerm.trim()
    const targetTerm = quickGlossaryTargetTerm.trim()
    if (!sourceTerm || !targetTerm) {
      message.warning('请填写原词和建议译名')
      return
    }
    if (quickGlossaryScope === 'project' && !activeTranslationGlossaryProjectId) {
      message.warning('请先选择研究项目')
      return
    }
    try {
      await window.api.upsertTranslationGlossaryTerm({
        scope: quickGlossaryScope,
        projectId: quickGlossaryScope === 'project' ? activeTranslationGlossaryProjectId : null,
        sourceTerm,
        targetTerm,
        note: quickGlossaryNote.trim(),
        enabled: true,
        caseSensitive: false,
      })
      const signature = await window.api.getTranslationGlossaryVersionSignature(activeTranslationGlossaryProjectId)
      setTranslationGlossarySignature(signature || 'none')
      clearReaderTranslationRuntime()
      setQuickGlossaryModalOpen(false)
      setQuickGlossaryTargetTerm('')
      message.success('术语已加入术语表')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存术语失败'))
    }
  }, [activeTranslationGlossaryProjectId, clearReaderTranslationRuntime, quickGlossaryNote, quickGlossaryScope, quickGlossarySourceTerm, quickGlossaryTargetTerm])

  const handleOcrActionMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'rerun-ocr') {
      void handleRerunCurrentPageOcr()
      return
    }

    if (key === 'rerun-ocr-landscape') {
      void handleRerunCurrentPageOcr(90)
      return
    }

    if (key === 'rerun-vision-ocr') {
      void handleRerunCurrentPageVisionOcr()
      return
    }

    if (key === 'enhance-guji') {
      void handleEnhanceCurrentGujiPage()
      return
    }

    if (key === 'rerun-layout') {
      void handleRerunCurrentPageLayout()
      return
    }

    if (key === 'reprocess-structure') {
      void handleReprocessDocumentOcrStructure()
    }
  }

  const resetReaderViewScale = useCallback(() => {
    setReaderFontSize(DEFAULT_READER_GLOBAL_PREFERENCES.font_size)
    setReaderLineHeight(DEFAULT_READER_GLOBAL_PREFERENCES.line_height)
    setReaderPageWidth(DEFAULT_READER_GLOBAL_PREFERENCES.page_width)
    setPageViewMode('single')
    setSharedViewport(undefined)
    setImageViewerResetToken((value) => value + 1)
    window.dispatchEvent(new Event(SOURCE_PAGE_READER_RESET_VIEW_EVENT))
  }, [])

  const copySelectedDirectQuote = useCallback(async () => {
    const selected = (
      window.getSelection()?.toString()
      || selectedTextForAi
      || ''
    ).replace(/\s+/g, ' ').trim()
    if (!selected) {
      message.info('请先选择需要引用的文本')
      return
    }
    if (!doc?.id) {
      message.warning('当前文献尚未加载完成')
      return
    }
    const page = currentPage || sortedPages[currentPageIndex] || null
    const internalPageNum = Number(page?.page_num || currentPageIndex + 1) || null
    const literaturePageNum = Number((page as { literature_page_num?: number | null } | null | undefined)?.literature_page_num || 0)
    const citationPageNum = getCitationPageNumber(
      page,
      literaturePageNum > 0 ? literaturePageNum : internalPageNum,
    ) || internalPageNum
    const fallbackCitationText = `${doc.title || '未命名文献'}${citationPageNum ? `，第 ${citationPageNum} 页` : ''}`
    let citationText = fallbackCitationText
    try {
      citationText = await resolveDocumentCitation(doc.id, {
        docType: doc.doc_type,
        pageNum: citationPageNum,
      }) || fallbackCitationText
    } catch (error) {
      console.warn('Failed to generate direct-quote citation from active style, falling back to simple citation.', error)
    }
    const quote = buildDirectQuoteCitationText(selected, citationText)
    try {
      await navigator.clipboard.writeText(quote)
      message.success('已复制直接引用')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '复制直接引用失败'))
    }
  }, [currentPage, currentPageIndex, doc, selectedTextForAi, sortedPages])

  useEffect(() => {
    if (!shortcuts) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (hasShortcutBlockingOverlay()) return

      if (shortcutMatches(event, shortcuts.back) && !isEditableShortcutTarget(event.target)) {
        event.preventDefault()
        void handleBack()
        return
      }

      if (shortcutMatches(event, shortcuts.search)) {
        const input = getReaderSearchInput()
        const isReaderSearchTarget = !!input && event.target === input
        if (!isEditableShortcutTarget(event.target) || isReaderSearchTarget) {
          event.preventDefault()
          focusReaderSearch()
          return
        }
      }

      if (shortcutMatches(event, shortcuts.copyDirectQuote) && !isEditableShortcutTarget(event.target)) {
        event.preventDefault()
        void copySelectedDirectQuote()
        return
      }

      if (isEditableShortcutTarget(event.target)) return

      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === '0' || event.code === 'Digit0')) {
        event.preventDefault()
        resetReaderViewScale()
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        scrollReaderContent(-1)
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        scrollReaderContent(1)
        return
      }

      if (shortcutMatches(event, shortcuts.previousPage)) {
        event.preventDefault()
        navigateShortcutPage(-1)
        return
      }

      if (shortcutMatches(event, shortcuts.nextPage)) {
        event.preventDefault()
        navigateShortcutPage(1)
        return
      }

      if (shortcutMatches(event, shortcuts.translate)) {
        event.preventDefault()
        toggleReaderTranslation()
        return
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [copySelectedDirectQuote, focusReaderSearch, getReaderSearchInput, handleBack, navigateShortcutPage, resetReaderViewScale, scrollReaderContent, shortcuts, toggleReaderTranslation])

  const exportMenuItems: MenuProps['items'] = [
    { key: 'reading-pdf', label: '导出阅读模式 PDF' },
    { key: 'layout-pdf', label: '导出排版模式 PDF' },
    { key: 'paddle-json', label: '导出为 Paddle JSON' },
    { key: 'markdown', label: '导出为 Markdown' },
    { key: 'tei-xml', label: '导出为 TEI-XML' },
    { key: 'txt', label: '导出为 TXT' },
    { key: 'page-xml', label: '导出为 PAGE XML' },
  ]

  const ocrActionItems: MenuProps['items'] = [
    { key: 'rerun-ocr', label: '用飞桨 OCR 重识别本页' },
    { key: 'rerun-ocr-landscape', label: '横向 OCR 本页（顺时针旋转）' },
    { key: 'rerun-vision-ocr', label: '用视觉 OCR 重识别本页' },
    ...(shouldUseVerticalOcr || facsimileProofCandidate ? [{ key: 'enhance-guji', label: '增强本页竖排识别' }] : []),
    { key: 'rerun-layout', label: '重排本页版面' },
    { key: 'reprocess-structure', label: '重新整理全文结构（不重新 OCR）' },
  ]

  const readerPages = (readerViewMode === 'spread'
    ? [readerCurrentPage, readerNextPage]
    : [readerCurrentPage]).filter(Boolean)
  const readerSearchMatches = shouldUseTextReaderMode ? textReaderMatches : searchMatches
  const readerSearchResultTotalPages = Math.max(1, Math.ceil(readerSearchMatches.length / READER_SEARCH_RESULT_PAGE_SIZE))
  const readerSearchResultPageSafe = Math.max(1, Math.min(readerSearchResultPage, readerSearchResultTotalPages))
  const readerSearchResultItems = readerSearchMatches.slice(
    (readerSearchResultPageSafe - 1) * READER_SEARCH_RESULT_PAGE_SIZE,
    readerSearchResultPageSafe * READER_SEARCH_RESULT_PAGE_SIZE,
  )
  const readerThemeStyle: ReaderThemeStyle = {
    paper: {
      shell: '#1c1712',
      page: '#fffaf0',
      text: '#24190f',
      muted: '#8a6a3c',
      border: 'rgba(120,80,30,0.15)',
    },
    sepia: {
      shell: '#21180f',
      page: '#f2e0bd',
      text: '#2d2115',
      muted: '#8a6534',
      border: 'rgba(120,80,30,0.22)',
    },
    dark: {
      shell: '#101112',
      page: '#1f2226',
      text: '#e8e2d8',
      muted: '#9a8f80',
      border: 'rgba(232,226,216,0.18)',
    },
  }[readerTheme]
  const readerAvailableHeight = Math.max(420, readerViewportHeight - 235)
  const readerSpreadPageHeight = Math.max(360, readerAvailableHeight - 36)
  const jumpToReaderPage = (pageIndex: number) => {
    const virtualIndex = readerVirtualPages.findIndex((page) => page.sourcePageIndex >= pageIndex)
    const nextIndex = virtualIndex >= 0 ? virtualIndex : pageIndex
    setReaderPageIndex(clampPageIndex(nextIndex, readerVirtualPageCount))
  }
  const getReaderPageIndexForSourcePage = (pageIndex: number) => {
    const virtualIndex = readerVirtualPages.findIndex((page) => page.sourcePageIndex >= pageIndex)
    if (virtualIndex >= 0) return clampPageIndex(virtualIndex, readerVirtualPageCount)
    const previousIndex = [...readerVirtualPages].reverse().find((page) => page.sourcePageIndex <= pageIndex)
    if (previousIndex) {
      return clampPageIndex(readerVirtualPages.findIndex((page) => page.id === previousIndex.id), readerVirtualPageCount)
    }
    return clampPageIndex(readerVirtualPageCount - 1, readerVirtualPageCount)
  }
  useEffect(() => {
    if (readerSearchResultPage !== readerSearchResultPageSafe) {
      setReaderSearchResultPage(readerSearchResultPageSafe)
    }
  }, [readerSearchResultPage, readerSearchResultPageSafe])

  const getReaderSearchResultPageNum = (match: SearchMatch): number => {
    if (match.locator?.pageNum) return match.locator.pageNum
    if (shouldUseTextReaderMode) return readerVirtualPages[match.pageIndex]?.sourcePageNum || match.pageIndex + 1
    return sortedPages[match.pageIndex]?.page_num || match.pageIndex + 1
  }

  const getReaderSearchResultSnippet = (match: SearchMatch): string => {
    const sessionHit = Number.isFinite(Number(match.hitIndex)) ? documentSearchSession?.hits?.[Number(match.hitIndex)] : null
    if (isVectorReaderSearch) {
      return String(sessionHit?.snippet || match.locator?.matchText || '').replace(/\s+/g, ' ').trim()
    }
    if (sessionHit?.snippet) return sessionHit.snippet
    if (shouldUseTextReaderMode) {
      const page = readerVirtualPages[match.pageIndex]
      return markSnippetAround(page?.text || '', match.keyword || effectiveSearchKeyword, match.charIndex)
    }
    const page = sortedPages[match.pageIndex]
    return markSnippetAround(String(page?.proofed_text || page?.ocr_text || ''), match.keyword || effectiveSearchKeyword, match.charIndex)
  }

  const renderReaderTocList = () => (
    readerTocItems.length > 0 ? readerTocItems.map((item) => {
      const active = currentPageIndex >= item.pageIndex && currentPageIndex < item.pageIndex + 2
      return (
        <button
          key={`${item.pageIndex}-${item.title}`}
          type="button"
          onClick={() => jumpToReaderPage(item.pageIndex)}
          title={transformReaderDisplayText(item.title, readerDisplayScript)}
          style={{
            width: '100%',
            border: 'none',
            borderRadius: 6,
            padding: `7px 8px 7px ${8 + item.level * 8}px`,
            marginBottom: 2,
            textAlign: 'left',
            background: active ? 'rgba(184, 134, 83, 0.28)' : 'transparent',
            color: active ? '#ffd8a8' : 'var(--gs-text-secondary)',
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: 1.4,
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{transformReaderDisplayText(item.title, readerDisplayScript)}</span>
          <span style={{ opacity: 0.65 }}>{item.pageNum}</span>
        </button>
      )
    }) : (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无目录" />
    )
  )

  const renderReaderSearchResultList = () => {
    if (!effectiveSearchKeyword.trim()) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请输入文内检索词" />
    }
    if (documentSearchSession?.status === 'searching' && readerSearchMatches.length === 0) {
      return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>
    }
    if (readerSearchMatches.length === 0) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无命中" />
    }
    return (
      <div
        data-reader-search-result-list="true"
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100%',
          padding: 6,
          borderRadius: 6,
          border: '1px solid rgba(196,149,106,0.12)',
          background: 'rgba(8,6,4,0.32)',
        }}
      >
        <Space direction="vertical" size={6} style={{ width: '100%', flex: 1 }}>
          {readerSearchResultItems.map((match, index) => {
            const matchIndex = (readerSearchResultPageSafe - 1) * READER_SEARCH_RESULT_PAGE_SIZE + index
            const active = matchIndex === currentMatchIndex
            const snippet = getReaderSearchResultSnippet(match)
            return (
              <button
                key={`${match.pageIndex}-${match.boxIndex}-${match.charIndex}-${matchIndex}`}
                type="button"
                data-reader-search-result-item="true"
                data-reader-search-result-active={active ? 'true' : undefined}
                onClick={() => activateReaderSearchMatch(matchIndex)}
                style={{
                  width: '100%',
                  border: `1px solid ${active ? 'rgba(255,216,168,0.46)' : 'rgba(196,149,106,0.12)'}`,
                  borderRadius: 6,
                  padding: '8px 9px',
                  textAlign: 'left',
                  background: active ? 'rgba(184, 134, 83, 0.26)' : 'rgba(16,12,8,0.52)',
                  color: active ? '#ffd8a8' : 'var(--gs-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                  <span style={{ color: active ? '#ffd8a8' : 'var(--gs-text-primary)', fontWeight: 600 }}>#{matchIndex + 1}</span>
                  <span style={{ opacity: 0.72 }}>第 {getReaderSearchResultPageNum(match)} 页</span>
                </div>
                <span>
                  {isVectorReaderSearch
                    ? snippet
                    : renderMarkedSnippet(snippet, match.keyword || effectiveSearchKeyword, readerDisplayScript)}
                </span>
              </button>
            )
          })}
        </Space>
        {readerSearchMatches.length > READER_SEARCH_RESULT_PAGE_SIZE ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid rgba(196,149,106,0.14)',
              background: 'rgba(10,7,4,0.48)',
            }}
          >
            <Pagination
              className="gs-hit-pagination"
              size="small"
              simple
              current={readerSearchResultPageSafe}
              pageSize={READER_SEARCH_RESULT_PAGE_SIZE}
              total={readerSearchMatches.length}
              showSizeChanger={false}
              onChange={(page) => setReaderSearchResultPage(page)}
            />
          </div>
        ) : null}
      </div>
    )
  }

  const renderReaderSidebarPanel = () => (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        borderRight: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.18)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Segmented
          size="small"
          block
          value={readerSidebarTab}
          onChange={(value) => setReaderSidebarTab(value as ReaderSidebarTab)}
          options={[
            { value: 'toc', label: '目录' },
            {
              value: 'search',
              label: isVectorReaderSearch
                ? `向量命中${readerSearchMatches.length ? ` ${readerSearchMatches.length}` : ''}`
                : `检索结果${readerSearchMatches.length ? ` ${readerSearchMatches.length}` : ''}`,
            },
          ]}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {readerSidebarTab === 'search' ? renderReaderSearchResultList() : renderReaderTocList()}
      </div>
    </div>
  )
  const goReaderPrevSpread = () => setReaderPageIndex((value) => clampPageIndex(value - (readerViewMode === 'spread' ? 2 : 1), readerVirtualPageCount))
  const goReaderNextSpread = () => setReaderPageIndex((value) => clampPageIndex(value + (readerViewMode === 'spread' ? 2 : 1), readerVirtualPageCount))
  const handleReaderPageClick = (side: 'left' | 'right') => (event: ReactMouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection()?.toString()
    if (selection) return
    const target = event.target as HTMLElement
    if (target.closest('button,input,textarea,select,a')) return
    if (readerViewMode === 'single') {
      goReaderNextSpread()
      return
    }
    if (side === 'left') {
      goReaderPrevSpread()
    } else {
      goReaderNextSpread()
    }
  }
  const renderPageControls = () => (
    (shouldUseTextReaderMode ? readerVirtualPageCount : pageCount) > 0 ? (
      <Space size={4} wrap>
        <Button size="small" disabled={shouldUseTextReaderMode ? readerPageIndex === 0 : currentPageIndex === 0} onClick={() => {
          if (shouldUseTextReaderMode) {
            setReaderPageIndex((value) => clampPageIndex(value - (readerViewMode === 'spread' ? 2 : 1), readerVirtualPageCount))
          } else {
            setCurrentPageIndex((value) => clampPageIndex(value - 1, pageCount))
          }
        }}>
          上一页
        </Button>
        <Input
          size="small"
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onPressEnter={() => {
            if (shouldUseTextReaderMode) {
              setReaderPageIndex(clampPageIndex(Number(pageInput) - 1, readerVirtualPageCount))
            } else {
              jumpToPage(pageInput)
            }
          }}
          style={{ width: 72, textAlign: 'center' }}
        />
        <Text style={{ color: 'var(--gs-text-secondary)', fontSize: 13 }}>/ {shouldUseTextReaderMode ? readerVirtualPageCount : pageCount}</Text>
        <Button size="small" onClick={() => {
          if (shouldUseTextReaderMode) {
            setReaderPageIndex(clampPageIndex(Number(pageInput) - 1, readerVirtualPageCount))
          } else {
            jumpToPage(pageInput)
          }
        }}>
          跳转
        </Button>
        <Button size="small" disabled={shouldUseTextReaderMode ? readerPageIndex >= readerVirtualPageCount - 1 : currentPageIndex >= pageCount - 1} onClick={() => {
          if (shouldUseTextReaderMode) {
            setReaderPageIndex((value) => clampPageIndex(value + (readerViewMode === 'spread' ? 2 : 1), readerVirtualPageCount))
          } else {
            setCurrentPageIndex((value) => clampPageIndex(value + 1, pageCount))
          }
        }}>
          下一页
        </Button>
      </Space>
    ) : null
  )

  const readerDisplaySettingsPanel = (
    <div style={{ width: 306, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>字体</span>
        <Select
          size="small"
          value={readerFontFamily}
          onChange={setReaderFontFamily}
          style={{ width: 186 }}
          options={[
            { value: "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif", label: '宋体 / 书籍' },
            { value: "'Microsoft YaHei', 'Noto Sans SC', sans-serif", label: '雅黑 / 屏幕' },
            { value: "KaiTi, 'STKaiti', serif", label: '楷体' },
            { value: "SimSun, 'Noto Serif SC', serif", label: '宋体' },
          ]}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '42px 1fr 34px', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>字号</span>
        <Slider min={13} max={26} value={readerFontSize} onChange={setReaderFontSize} style={{ margin: 0 }} />
        <Text style={{ color: 'var(--gs-text-secondary)', fontSize: 12, textAlign: 'right' }}>{readerFontSize}</Text>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '42px 1fr 34px', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>行距</span>
        <Slider min={1.3} max={2.4} step={0.1} value={readerLineHeight} onChange={setReaderLineHeight} style={{ margin: 0 }} />
        <Text style={{ color: 'var(--gs-text-secondary)', fontSize: 12, textAlign: 'right' }}>{readerLineHeight.toFixed(1)}</Text>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '42px 1fr 34px', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>版心</span>
        <Slider min={380} max={680} step={20} value={readerPageWidth} onChange={setReaderPageWidth} style={{ margin: 0 }} />
        <Text style={{ color: 'var(--gs-text-secondary)', fontSize: 12, textAlign: 'right' }}>{readerPageWidth}</Text>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>版式</span>
        <Segmented
          size="small"
          value={readerViewMode}
          onChange={(value) => setReaderViewMode(value as ReaderViewMode)}
          options={[
            { value: 'spread', label: '双页' },
            { value: 'single', label: '单页' },
          ]}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>主题</span>
        <Segmented
          size="small"
          value={readerTheme}
          onChange={(value) => setReaderTheme(value as ReaderTheme)}
          options={[
            { value: 'paper', label: '纸白' },
            { value: 'sepia', label: '护眼' },
            { value: 'dark', label: '夜间' },
          ]}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>简繁</span>
        <Segmented
          size="small"
          value={readerDisplayScript}
          onChange={(value) => setReaderDisplayScript(value as ReaderDisplayScript)}
          options={[
            { value: 'original', label: '原文' },
            { value: 'simplified', label: '简体' },
            { value: 'traditional', label: '繁体' },
          ]}
        />
      </div>
    </div>
  )

  const renderBookSpread = () => (
    <div style={{ height: '100%', padding: 18, background: readerThemeStyle.shell, overflow: 'hidden', boxSizing: 'border-box' }}>
      <div
        style={{
          height: '100%',
          display: 'grid',
          gridTemplateColumns: readerPages.length > 1 ? `minmax(260px, min(${readerPageWidth}px, 48%)) minmax(260px, min(${readerPageWidth}px, 48%))` : `minmax(260px, min(${Math.min(readerPageWidth + 120, 760)}px, 94%))`,
          justifyContent: 'center',
          gap: 18,
          alignItems: 'stretch',
        }}
      >
        {readerPages.map((page, index) => {
          const pageIndex = readerPageIndex + index
          const pageHitStartIndex = readerSearchMatches.filter((match) => match.pageIndex < pageIndex).length
          const imageLabel = `自然页码 第 ${page.sourcePageNum} / ${pageCount} 页`
          const literatureLabel = `文献页码 第 ${page.literaturePageNum || page.sourcePageNum} 页`
          return (
            <div
              key={page.id}
              onClick={handleReaderPageClick(index === 0 ? 'left' : 'right')}
              style={{
                position: 'relative',
                background: readerThemeStyle.page,
                color: readerThemeStyle.text,
                borderRadius: 6,
                padding: '34px 38px 44px',
                boxShadow: '0 16px 40px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(120,80,30,0.15)',
                fontFamily: readerFontFamily,
                fontSize: readerFontSize,
                lineHeight: readerLineHeight,
                height: readerSpreadPageHeight,
                cursor: 'pointer',
                userSelect: 'text',
                overflowY: 'auto',
                overflowWrap: 'break-word',
                boxSizing: 'border-box',
              }}
            >
              <div
                title="自然页码：PDF/扫描物理页序，用于翻页定位"
                style={{
                  color: readerThemeStyle.muted,
                  fontSize: 12,
                  marginBottom: 18,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  userSelect: 'none',
                }}
              >
                {imageLabel}
              </div>
              {renderReaderPageElements(page, effectiveSearchKeyword, readerDisplayScript, currentMatchIndex, pageHitStartIndex, readerThemeStyle)}
              <div
                aria-label={literatureLabel}
                title="文献页码：书上印刷/校准页码，与引用、TXT 导出默认一致"
                style={{
                  position: 'sticky',
                  bottom: 0,
                  marginTop: 18,
                  color: readerThemeStyle.muted,
                  fontSize: 12,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  userSelect: 'none',
                  pointerEvents: 'none',
                }}
              >
                {literatureLabel}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  const renderImageReaderSpread = () => (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
        <Space size={8} wrap>
          <span style={{ fontWeight: 500, color: 'var(--gs-text-primary)' }}>双页阅读</span>
          <Tag color="purple">{getDisplayDocType(doc?.doc_type, 'PDF')}</Tag>
        </Space>
        {renderPageControls()}
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 18, background: '#171411', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            display: 'grid',
            gridTemplateColumns: nextSpreadPage ? 'minmax(260px, 1fr) minmax(260px, 1fr)' : 'minmax(260px, 760px)',
            gap: 18,
            justifyContent: 'center',
            alignItems: 'stretch',
          }}
        >
          {[{ page: currentPage, src: imageDataUrl }, { page: nextSpreadPage, src: nextImageDataUrl }]
            .filter((item): item is { page: DocumentViewPage; src: string } => Boolean(item.page))
            .map((item, index) => {
              const physical = Number(item.page.page_num || 0)
              const literature = getCitationPageNumber(item.page, physical) || physical
              const imageLabel = physical > 0 ? `自然页码 第 ${physical} / ${pageCount} 页` : ''
              const literatureLabel = literature > 0 ? `文献页码 第 ${literature} 页` : ''
              return (
            <button
              key={item.page.id}
              type="button"
              onClick={() => setCurrentPageIndex((value) => clampPageIndex(value + (index === 0 ? -2 : 2), pageCount))}
              style={{
                position: 'relative',
                border: 'none',
                borderRadius: 6,
                padding: 0,
                background: '#0f0f0f',
                height: readerSpreadPageHeight,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
                cursor: 'pointer',
                overflow: 'hidden',
              }}
              title={index === 0 ? '点击左页向前翻页' : '点击右页向后翻页'}
            >
              {item.src ? (
                <img src={item.src} alt={imageLabel || `第 ${item.page.page_num} 页`} style={{ maxWidth: '100%', maxHeight: readerSpreadPageHeight, objectFit: 'contain', display: 'block' }} />
              ) : (
                <Spin />
              )}
              {imageLabel ? (
                <span
                  title="自然页码：PDF/扫描物理页序"
                  style={{
                    position: 'absolute',
                    right: 14,
                    top: 12,
                    color: 'rgba(255,245,220,0.88)',
                    fontSize: 12,
                    fontVariantNumeric: 'tabular-nums',
                    textShadow: '0 1px 3px rgba(0,0,0,0.75)',
                    pointerEvents: 'none',
                    userSelect: 'none',
                  }}
                >
                  {imageLabel}
                </span>
              ) : null}
              {literatureLabel ? (
                <span
                  title="文献页码：书上印刷/校准页码"
                  style={{
                    position: 'absolute',
                    left: 14,
                    bottom: 12,
                    color: 'rgba(255,245,220,0.88)',
                    fontSize: 12,
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    textShadow: '0 1px 3px rgba(0,0,0,0.75)',
                    pointerEvents: 'none',
                    userSelect: 'none',
                  }}
                >
                  {literatureLabel}
                </span>
              ) : null}
            </button>
              )
            })}
        </div>
      </div>
    </div>
  )

  if (loading || (doc && doc.id !== documentId)) {
    return (
      <div className="empty-state">
        <Spin size="large" />
      </div>
    )
  }

  if (!doc) {
    return <Empty description="未找到文献" />
  }

  return (
    <div style={{ padding: '16px 24px', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={{ marginBottom: compactHeader ? 8 : 12 }}>
        {!compactHeader ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Button className="document-back-button" icon={<ArrowLeftOutlined />} onClick={() => void handleBack()} type="text" style={{ flexShrink: 0 }}>
              返回
            </Button>
            <Title
              level={4}
              style={{
                margin: 0,
                color: 'var(--gs-text-primary)',
                cursor: 'pointer',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: '1 1 auto',
                minWidth: 0,
              }}
              onDoubleClick={() => setEditorVisible(true)}
              title={doc.title}
            >
              {doc.title}
            </Title>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'center', marginBottom: 8, paddingLeft: compactHeader ? 0 : 52 }}>
          <Tag color="purple">{getDisplayDocType(doc.doc_type)}</Tag>
          {getDisplayMetadataText(doc.author) ? <Tag color="blue">{getDisplayMetadataText(doc.author)}</Tag> : null}
          {getDisplayMetadataText(doc.dynasty) ? <Tag color="gold">{getDisplayMetadataText(doc.dynasty)}</Tag> : null}
          {shouldUseManagedTextReader ? null : (
            <>
              <Tag color={doc.ocr_status === 'completed' ? 'success' : doc.ocr_status === 'processing' ? 'processing' : 'default'}>
                {`OCR: ${doc.ocr_status === 'completed' ? '已完成' : doc.ocr_status === 'processing' ? '处理中' : '待处理'}`}
              </Tag>
              {ocrFailedPageEntries.length > 0 ? (
                <Tooltip title="点击打开鸟瞰页，可筛选并跳转全部 OCR 失败页">
                  <Tag
                    color="error"
                    style={{ cursor: 'pointer', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    onClick={jumpToOcrFailedBirdseye}
                  >
                    {ocrFailedPageLabel
                      ? `OCR完成，第 ${ocrFailedPageLabel} 页 OCR 未成功`
                      : `OCR完成，${ocrFailedPageEntries.length} 页 OCR 未成功`}
                  </Tag>
                </Tooltip>
              ) : null}
              {String(currentPage?.ocr_status || '') === 'error' ? (
                <Tag color="error">当前页 OCR 未成功</Tag>
              ) : null}
              <Tag color={currentPageProofStatus === 'completed' ? 'gold' : 'default'}>
                {`校对：${currentPageProofStatus === 'completed' ? '已完成' : '待处理'}`}
              </Tag>
              {currentPageLayoutAttention ? (
                <Popover
                  title="OCR 质量检查"
                  content={(
                    <div style={{ maxWidth: 320 }}>
                      {currentPageOcrQuality ? (
                        <>
                          <div style={{ marginBottom: 6 }}>质量评分：{Math.round(currentPageOcrQuality.score * 100)}</div>
                          {[...new Set(currentPageOcrQuality.issues
                            .filter((issue) => issue.severity !== 'info')
                            .map((issue) => getOcrQualityIssueLabel(issue.code)))]
                             .slice(0, 6)
                             .map((label) => <div key={label}>{label}</div>)}
                          {currentPageRegionCandidateCount > 0 ? (
                            <Button
                              size="small"
                              loading={ocrProcessing}
                              style={{ marginTop: 10 }}
                              onClick={() => void handleRerecognizeLowQualityBlocks()}
                            >
                              局部重识别异常块（{currentPageRegionCandidateCount}）
                            </Button>
                          ) : null}
                        </>
                      ) : '当前版面包含需要人工确认的区域'}
                    </div>
                  )}
                >
                  <Tag color="orange" style={{ cursor: 'help' }}>版面需复核</Tag>
                </Popover>
              ) : null}
            </>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingLeft: compactHeader ? 0 : 52 }}>
          <Segmented
            size="small"
            value={isEbookDocument ? 'read' : documentMode}
            onChange={(value) => {
              const nextMode = value as DocumentMode
              // Pin intention immediately so any in-flight restore cannot snap Segmented back.
              intendedDocumentModeRef.current = nextMode
              documentModeTouchedRef.current = true
              void switchDocumentMode(nextMode)
            }}
            options={isEbookDocument
              ? [{ value: 'read', label: '阅读模式' }]
              : [
                { value: 'read', label: '阅读模式' },
                { value: 'proof', label: '校对模式 · 实验' },
              ]}
          />
          {documentMode === 'read' ? (
            <Segmented
              size="small"
              value={readerDisplayScript}
              onChange={(value) => setReaderDisplayScript(value as ReaderDisplayScript)}
              options={[
                { value: 'original', label: '原文' },
                { value: 'simplified', label: '简体' },
                { value: 'traditional', label: '繁体' },
              ]}
            />
          ) : null}
          <Dropdown menu={{ items: exportMenuItems, onClick: handleExport }} placement="bottomRight" disabled={exportingDocument}>
            <Button size="small" loading={exportingDocument}>
              <ExportOutlined /> 导出 <DownOutlined />
            </Button>
          </Dropdown>
          <Button
            size="small"
            icon={<RobotOutlined />}
            loading={extracting}
            onClick={handleExtractMetadata}
            disabled={!hasAnyOcrText}
            style={{ borderColor: 'var(--gs-gold)', color: 'var(--gs-gold)' }}
          >
            AI 提取元数据
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => setEditorVisible(true)}>
            查看 / 编辑元数据
          </Button>
          {shouldUseManagedTextReader ? null : (
          <Button size="small" icon={<FileImageOutlined />} onClick={() => void handleSaveCurrentPageExcerpt()} disabled={!currentPage || !hasAnyOcrText}>
            保存本页摘录
          </Button>
          )}
          {shouldUseManagedTextReader ? null : (
            <Button size="small" type="primary" icon={<ScanOutlined />} loading={ocrProcessing} onClick={handleStartOcr}>
              开始 OCR 识别
            </Button>
          )}
          {needsPdfAssetRestore ? (
            <Space.Compact size="small">
              <Button loading={restoringPdf} onClick={() => void handleRestorePdfAsset(currentPage, false)}>
                补回原文
              </Button>
              <Button loading={restoringPdf} onClick={() => void handleRestorePdfManually()}>
                手动选择 PDF
              </Button>
            </Space.Compact>
          ) : null}
        </div>
      </div>

      {shouldUseEbookReader ? (
        <div ref={containerRef} style={{ flex: 1, minHeight: 0 }}>
          {readerStateReady ? (
          <EbookReader
              document={doc}
              pages={sortedPages}
              currentPageIndex={currentPageIndex}
              searchKeyword={localSearchKeyword}
              highlightColor={highlightColor}
              sourceLabel={sourceLabel}
              initialLocationKey={initialReaderLocationKey}
              locator={locator}
              searchSession={readerDocumentSearchSession}
              pageTranslations={readerPageTranslations}
              pageTranslationUnits={pageTranslationUnits}
              translatingPageIds={translatingPageIds}
              skippedTranslationPageIds={skippedTranslationPageIds}
              translationGlossaryProjectId={translationGlossaryProjectId}
              translationGlossaryProjects={translationGlossaryProjects}
              selectedTextForGlossary={selectedTextForAi}
              displayScript={readerDisplayScript}
              translationMode={translationMode}
              onDisplayScriptChange={setReaderDisplayScript}
              onPageIndexChange={(pageIndex) => {
                const nextIndex = clampPageIndex(pageIndex, pageCount)
                releaseTemporaryNavigation()
                readerVisiblePageIndexRef.current = nextIndex
                setCurrentPageIndex((value) => (value === nextIndex ? value : nextIndex))
                const nextState = buildPageReaderState(nextIndex)
                if (nextState && readerStateReady) saveReaderStateSoon(nextState)
                void loadPagesAround(nextIndex, 5)
              }}
              onSearchKeywordChange={(keyword) => {
                setLocalSearchKeyword(keyword)
                setCurrentMatchIndex(-1)
                setDocumentSearchSession({ query: '', hits: [], activeHitIndex: -1, status: 'idle' })
              }}
              onSelectedTextChange={setSelectedTextForAi}
              onContextTextChange={(text) => setReaderContextTextForAi(text.slice(0, 2200))}
              onTranslateCurrentPage={(payload, options) => {
                requestReaderTranslation(payload, options)
              }}
              onTranslationModeChange={setTranslationMode}
              onUpdateTranslationUnit={updateReaderTranslationUnit}
              onRetranslateTranslationUnit={retranslateReaderTranslationUnit}
              onTranslationGlossaryProjectChange={(projectId) => {
                setTranslationGlossaryProjectId(projectId)
                clearReaderTranslationRuntime()
              }}
              onAddSelectedTerm={openQuickGlossaryTermModal}
              onReaderStateChange={(state) => {
                if (temporaryNavigationRef.current) return
                saveReaderStateSoon({
                  document_mode: 'read',
                  location_key: state.location_key,
                  progress: state.progress,
                  view_mode: state.view_mode,
                  font_size: state.font_size,
                  line_height: state.line_height,
                  theme: state.theme,
                })
                if (state.progress >= 0.95 && doc?.read_status !== 'read') {
                  void window.api.setReadStatus(doc.id, 'read').then(() => {
                    setDoc((previous) => previous ? { ...previous, read_status: 'read' } : previous)
                  }).catch(() => {})
                }
              }}
            />
          ) : (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
              <Spin />
            </div>
          )}
        </div>
      ) : shouldUseSourcePageReader ? (
        <div ref={containerRef} style={{ flex: 1, minHeight: 0 }}>
          {readerStateReady ? (
          <SourcePageReader
            document={doc}
            pages={sortedPages}
            searchPages={readerSearchPages}
            currentPageIndex={currentPageIndex}
            searchKeyword={localSearchKeyword}
            searchEngine={readerSearchEngine}
            highlightColor={highlightColor}
            sourceLabel={sourceLabel}
            searchSession={readerDocumentSearchSession}
            pageTranslations={sourceReaderPageTranslations}
            pageTranslationUnits={pageTranslationUnits}
            translatingPageIds={translatingPageIds}
            skippedTranslationPageIds={skippedTranslationPageIds}
            translationGlossaryProjectId={translationGlossaryProjectId}
            translationGlossaryProjects={translationGlossaryProjects}
            selectedTextForGlossary={selectedTextForAi}
            displayScript={readerDisplayScript}
            translationMode={translationMode}
            onDisplayScriptChange={setReaderDisplayScript}
            onPageIndexChange={(pageIndex) => {
              const nextIndex = clampPageIndex(pageIndex, pageCount)
              releaseTemporaryNavigation()
              readerVisiblePageIndexRef.current = nextIndex
              setCurrentPageIndex((value) => (value === nextIndex ? value : nextIndex))
              const nextState = buildPageReaderState(nextIndex)
              if (nextState && readerStateReady) saveReaderStateSoon(nextState)
              if (!isDocumentPagePayloadHydrated(sortedPagesRef.current[nextIndex])) {
                void loadPagesAround(nextIndex, 5)
              }
            }}
            onSearchEngineChange={(engine) => {
              setReaderSearchEngine(engine)
              const keyword = localSearchKeyword.trim()
              if (!keyword) {
                documentSearchFetchedKeyRef.current = ''
                setDocumentSearchSession({ query: '', hits: [], activeHitIndex: -1, status: 'idle', engine })
                setCurrentMatchIndex(-1)
                return
              }
              // Direct re-search under the new engine (vector ↔ 文本).
              runInDocumentSearch(keyword, engine)
            }}
            onSearchKeywordChange={(keyword, meta) => {
              const engine = meta?.engine === 'vector' || meta?.engine === 'fulltext'
                ? meta.engine
                : readerSearchEngine
              if (meta?.engine === 'vector' || meta?.engine === 'fulltext') {
                setReaderSearchEngine(meta.engine)
              }
              setLocalSearchKeyword(keyword)
              // Imperative: same keyword Enter / engine switch always hits the API.
              runInDocumentSearch(keyword, engine)
            }}
            onSelectedTextChange={setSelectedTextForAi}
            onContextTextChange={(text) => setReaderContextTextForAi(text.slice(0, 2200))}
            onDocumentMetadataChange={(metadata) => {
              setDoc((previous) => previous ? { ...previous, metadata: JSON.stringify(metadata) } : previous)
            }}
            onTranslateCurrentPage={(payload, options) => {
              requestReaderTranslation(payload, options)
            }}
            onTranslationModeChange={setTranslationMode}
            onUpdateTranslationUnit={updateReaderTranslationUnit}
            onRetranslateTranslationUnit={retranslateReaderTranslationUnit}
            onTranslationGlossaryProjectChange={(projectId) => {
              setTranslationGlossaryProjectId(projectId)
              clearReaderTranslationRuntime()
            }}
            onAddSelectedTerm={openQuickGlossaryTermModal}
            onLiteraturePagesCalibrated={async (calibratedPages) => {
              // Apply mapping from main process immediately (no re-fetch race).
              if (Array.isArray(calibratedPages) && calibratedPages.length > 0) {
                const litById = new Map(
                  calibratedPages.map((page) => [
                    String(page.id),
                    {
                      literature_page_num: page.literature_page_num,
                      literature_page_source: page.literature_page_source,
                    },
                  ]),
                )
                const litByPhysical = new Map(
                  calibratedPages.map((page) => [
                    Number(page.page_num || 0),
                    {
                      literature_page_num: page.literature_page_num,
                      literature_page_source: page.literature_page_source,
                    },
                  ]),
                )
                setDoc((previous) => {
                  if (!previous || previous.id !== documentId) return previous
                  return {
                    ...previous,
                    pages: previous.pages.map((page) => {
                      const lit = litById.get(String(page.id))
                        || litByPhysical.get(Number(page.page_num || 0))
                      if (!lit) return page
                      return normalizeDocumentPage({ ...page, ...lit })
                    }),
                  }
                })
              }
              // Also refresh payloads so later navigations keep the calibrated numbers.
              pageRangeInFlightRef.current.clear()
              pageRangeRequestRef.current += 1
              await loadPagesAround(currentPageIndex, Math.max(8, Math.min(40, pageCount || 8)))
            }}
            onReaderStateChange={(state) => {
              if (!readerStateReady) return
              if (temporaryNavigationRef.current) return
              saveReaderStateSoon({
                document_mode: 'read',
                location_key: state.location_key,
                progress: state.progress,
                view_mode: state.view_mode,
                font_size: state.font_size,
                line_height: state.line_height,
                theme: state.theme,
              })
              if (state.progress >= 0.95 && doc?.read_status !== 'read') {
                void window.api.setReadStatus(doc.id, 'read').then(() => {
                  setDoc((previous) => previous ? { ...previous, read_status: 'read' } : previous)
                }).catch(() => {})
              }
            }}
          />
          ) : (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
              <Spin />
            </div>
          )}
        </div>
      ) : shouldUseImageReaderMode ? (
        renderImageReaderSpread()
      ) : shouldUseTextReaderMode || !shouldUseProofLayout ? (
        <div
          ref={containerRef}
          style={{
            flex: 1,
            display: 'flex',
            minHeight: 0,
            flexDirection: 'column',
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              flexWrap: 'wrap',
            }}
          >
            <Space size={8} wrap>
              <Button
                size="small"
                icon={<BarsOutlined />}
                type={readerTocOpen ? 'primary' : 'default'}
                onClick={() => setReaderTocOpen((value) => !value)}
              >
                目录
              </Button>
              <span style={{ fontWeight: 500, color: 'var(--gs-text-primary)' }}>双页阅读</span>
              <Tag color="purple">{getDisplayDocType(doc.doc_type)}</Tag>
            </Space>
            {renderPageControls()}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              flexWrap: 'wrap',
            }}
          >
            <Space size={6} wrap>
              <Space.Compact size="small">
                <Select
                  size="small"
                  value={readerSearchEngine}
                  onChange={(engine) => {
                    setReaderSearchEngine(engine)
                    const keyword = searchInputDraft.trim() || effectiveSearchKeyword.trim()
                    if (keyword) {
                      setLocalSearchKeyword(keyword)
                      runInDocumentSearch(keyword, engine)
                    }
                  }}
                  style={{ width: 92 }}
                  options={[
                    {
                      value: 'fulltext',
                      label: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <FontSizeOutlined />
                          文本
                        </span>
                      ),
                    },
                    {
                      value: 'vector',
                      label: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <ThunderboltOutlined />
                          向量
                        </span>
                      ),
                    },
                  ]}
                />
                <Input
                  data-reader-search-input="true"
                  size="small"
                  placeholder={readerSearchEngine === 'vector' ? '语义检索' : '搜索正文'}
                  prefix={
                    readerSearchEngine === 'vector'
                      ? <ThunderboltOutlined style={{ color: 'var(--gs-gold)' }} />
                      : <SearchOutlined style={{ color: searchFocused && effectiveSearchKeyword ? 'var(--gs-gold)' : 'rgba(255,255,255,0.25)' }} />
                  }
                  value={searchInputDraft}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setSearchInputDraft(nextValue)
                    if (!nextValue) {
                      setLocalSearchKeyword('')
                      runInDocumentSearch('', readerSearchEngine)
                    }
                  }}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  onPressEnter={commitSearchInputDraft}
                  allowClear
                  style={{
                    width: 180,
                    background: searchFocused && effectiveSearchKeyword ? 'rgba(255,192,105,0.1)' : 'rgba(255,255,255,0.04)',
                    borderColor: searchFocused && effectiveSearchKeyword ? '#ffc069' : 'rgba(255,255,255,0.12)',
                  }}
                />
              </Space.Compact>
              <Button size="small" icon={<LeftOutlined />} onClick={handleSearchPrev} disabled={readerSearchMatches.length === 0} />
              <span data-reader-search-counter="true" style={{ fontSize: 12, color: 'var(--gs-text-secondary)', minWidth: 56, textAlign: 'center' }}>
                {effectiveSearchKeyword
                  ? `${isVectorReaderSearch ? '向量 ' : ''}${readerSearchMatches.length ? Math.max(1, currentMatchIndex + 1) : 0}/${readerSearchMatches.length}`
                  : '0/0'}
              </span>
              <Button size="small" icon={<RightOutlined />} data-reader-search-next="true" onClick={handleSearchNext} disabled={readerSearchMatches.length === 0} />
            </Space>

            <Popover trigger="click" placement="bottomRight" content={readerDisplaySettingsPanel}>
              <Button size="small" icon={<SettingOutlined />}>显示设置</Button>
            </Popover>
          </div>

          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
            {readerTocOpen ? renderReaderSidebarPanel() : null}
            <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
              {readerPages.length > 0 ? renderBookSpread() : <Empty description="未找到可阅读内容" style={{ marginTop: '20%' }} />}
            </div>
          </div>
        </div>
      ) : (
      <div ref={containerRef} style={{ flex: 1, display: 'flex', minHeight: 0, gap: 0 }}>
        <div
          style={{
            width: `${leftWidth}%`,
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '8px 0 0 8px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              flexWrap: 'wrap',
            }}
          >
            <Space size={8} wrap>
              <span style={{ fontWeight: 500, color: 'var(--gs-text-primary)' }}>
                {pageViewMode === 'bird' ? '页面鸟瞰' : shouldShowBookPreview ? '书页' : '原图'}
              </span>
              <Segmented
                size="small"
                value={pageViewMode}
                onChange={(value) => setPageViewMode(value as PageViewMode)}
                options={[
                  { value: 'single', label: '单页' },
                  { value: 'bird', label: '鸟瞰' },
                ]}
              />
            </Space>

            {pageCount > 0 ? (
              <Space size={4} wrap>
                <Button size="small" disabled={currentPageIndex === 0} onClick={() => { releaseTemporaryNavigation(); setCurrentPageIndex((value) => clampPageIndex(value - 1, pageCount)) }}>
                  上一页
                </Button>
                <Input
                  size="small"
                  value={pageInput}
                  onChange={(event) => setPageInput(event.target.value)}
                  onPressEnter={() => jumpToPage(pageInput)}
                  style={{ width: 72, textAlign: 'center' }}
                />
                <Text style={{ color: 'var(--gs-text-secondary)', fontSize: 13 }}>/ {pageCount}</Text>
                <Button size="small" onClick={() => jumpToPage(pageInput)}>
                  跳转
                </Button>
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  disabled={manualPageInsertionLoading || !currentPage?.id}
                  menu={{
                    items: [
                      { key: 'before', label: '在当前页前插入空白页' },
                      { key: 'after', label: '在当前页后插入空白页' },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'before' || key === 'after') void handleInsertManualPage(key)
                    },
                  }}
                >
                  <Button size="small" icon={<PlusOutlined />} loading={manualPageInsertionLoading}>
                    插入空白页
                  </Button>
                </Dropdown>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  loading={manualPageDeletionLoading}
                  disabled={manualPageInsertionLoading || manualPageDeletionLoading || !currentPage?.id || pageCount <= 1}
                  onClick={handleDeleteManualPage}
                >
                  删除当前页
                </Button>
                <Button size="small" disabled={currentPageIndex === pageCount - 1} onClick={() => { releaseTemporaryNavigation(); setCurrentPageIndex((value) => clampPageIndex(value + 1, pageCount)) }}>
                  下一页
                </Button>
              </Space>
            ) : null}
          </div>

          <div style={{ flex: 1, overflow: 'hidden' }}>
            {pageViewMode === 'bird' ? (
              <PageBirdseyeGrid
                pages={sortedPages}
                currentPageIndex={currentPageIndex}
                density={birdDensity}
                onDensityChange={setBirdDensity}
                onSelectPage={(pageIndex) => {
                  setCurrentPageIndex(clampPageIndex(pageIndex, pageCount))
                  setPageViewMode('single')
                }}
              />
            ) : imageDataUrl ? (
              <ImageViewer
                src={imageDataUrl}
                ocrBoxes={layoutBoxes}
                coordinateSourceSize={imageCoordinateSourceSize}
                activeBoxIndex={activeBoxIndex}
                searchKeyword={effectiveSearchKeyword}
                viewport={sharedViewport}
                onViewportChange={setSharedViewport}
                resetToken={imageViewerResetToken}
                onBoxClick={(index) => {
                  setActiveBoxIndex(index)
                  setSwitchToRegion(true)
                }}
                hasPrevPage={currentPageIndex > 0}
                hasNextPage={currentPageIndex < pageCount - 1}
                onPrevPage={() => { releaseTemporaryNavigation(); setCurrentPageIndex((value) => clampPageIndex(value - 1, pageCount)) }}
                onNextPage={() => { releaseTemporaryNavigation(); setCurrentPageIndex((value) => clampPageIndex(value + 1, pageCount)) }}
              />
            ) : pageImageLoading ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Spin tip="正在加载原图…" />
              </div>
            ) : shouldUseProofLayout ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Empty
                  image={<FileImageOutlined style={{ fontSize: 48, opacity: 0.28 }} />}
                  description={
                    <div style={{ maxWidth: 320 }}>
                      <div style={{ color: 'var(--gs-text-primary)', fontWeight: 600, marginBottom: 6 }}>本页暂无原图</div>
                      <div style={{ color: 'var(--gs-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                        校对左侧应显示扫描页图。当前没有可用页图
                        {canAttemptPageImageRecovery ? '（可尝试补回 PDF 或重新生成）' : '（也没有关联 PDF 源文件）'}
                        。右侧仍可对照 OCR 文本校对。
                      </div>
                    </div>
                  }
                >
                  <Space wrap style={{ marginTop: 12, justifyContent: 'center' }}>
                    {canAttemptPageImageRecovery ? (
                      <Button
                        type="primary"
                        size="small"
                        loading={restoringPdf}
                        onClick={() => void handleRestorePdfManually()}
                      >
                        补回 / 选择 PDF
                      </Button>
                    ) : null}
                    {isPdfSource && currentPage ? (
                      <Button
                        size="small"
                        onClick={() => void forceRenderCurrentPageImageFromPdf(currentPage)}
                      >
                        从 PDF 生成页图
                      </Button>
                    ) : null}
                    {hasCurrentPageReadableText || hasAnyOcrText ? (
                      <Button size="small" onClick={() => void switchDocumentMode('read')}>
                        改用阅读模式
                      </Button>
                    ) : null}
                  </Space>
                </Empty>
              </div>
            ) : shouldShowBookPreview && currentPage ? (
              <div style={{ height: '100%', padding: 24, background: '#1c1712', overflow: 'auto' }}>
                <div
                  style={{
                    minHeight: '100%',
                    display: 'grid',
                    // Left pane is narrow — always single column, never dual-page reading chrome.
                    gridTemplateColumns: 'minmax(0, 720px)',
                    justifyContent: 'center',
                    gap: 18,
                    alignItems: 'stretch',
                  }}
                >
                  {(() => {
                    const page = currentPage
                    const pageIndex = currentPageIndex
                    const pageHitStartIndex = searchMatches.filter((match) => match.pageIndex < pageIndex).length
                    return (
                      <div
                        key={page.id}
                        style={{
                          background: '#fffaf0',
                          color: '#24190f',
                          borderRadius: 6,
                          padding: '34px 38px',
                          boxShadow: '0 16px 40px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(120,80,30,0.15)',
                          fontFamily: "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif",
                          fontSize: 17,
                          lineHeight: 1.9,
                          whiteSpace: 'pre-wrap',
                          minHeight: 420,
                        }}
                      >
                        <div style={{ color: '#8a6a3c', fontSize: 12, marginBottom: 18, textAlign: 'center' }}>
                          第 {page.page_num} 页 · 无页图文本预览
                        </div>
                        {renderReaderPageElements({
                          id: `${page.id}-preview`,
                          sourcePageIndex: pageIndex,
                          sourcePageNum: page.page_num,
                          literaturePageNum: getCitationPageNumber(page, page.page_num) || page.page_num,
                          sourcePageId: page.id,
                          sourceStartChar: 0,
                          sourceEndChar: getPageReadingText(page).length,
                          segmentIndex: 0,
                          text: getPageReadingText(page),
                          elements: getReadablePageElements(page),
                          sourcePage: page,
                        }, effectiveSearchKeyword, readerDisplayScript, currentMatchIndex, pageHitStartIndex, {
                          shell: '#1c1712',
                          page: '#fffaf0',
                          text: '#24190f',
                          muted: '#8a6a3c',
                          border: 'rgba(120,80,30,0.15)',
                        })}
                      </div>
                    )
                  })()}
                </div>
              </div>
            ) : (
              <Empty description="未找到可预览内容" style={{ marginTop: '20%' }} />
            )}
          </div>
        </div>

        <div
          onMouseDown={handleDividerMouseDown}
          style={{
            width: 5,
            cursor: 'col-resize',
            background: isDraggingDivider ? 'rgba(24,144,255,0.5)' : 'rgba(255,255,255,0.06)',
            transition: isDraggingDivider ? 'none' : 'background 0.2s',
            zIndex: 10,
            flexShrink: 0,
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 3,
              height: 32,
              borderRadius: 2,
              background: isDraggingDivider ? 'rgba(24,144,255,0.8)' : 'rgba(255,255,255,0.15)',
              transition: 'background 0.2s',
            }}
          />
        </div>

        <div
          style={{
            width: `${100 - leftWidth}%`,
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '0 8px 8px 0',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <Space size={8} wrap>
              <span style={{ fontWeight: 500, color: 'var(--gs-text-primary)' }}>
                {proofViewMode === 'facsimile' ? '版式还原校对' : '文本校对'}
              </span>
              {canUseManualFacsimileLayout ? <Tag color="purple">版式还原</Tag> : null}
            </Space>

            <Space size={4} wrap>
              {canUseManualFacsimileLayout ? (
                <Segmented
                  size="small"
                  value={proofViewMode}
                  onChange={(value) => {
                    setProofViewMode(value as ProofViewMode)
                    setProofViewTouched(true)
                  }}
                  options={[
                    { value: 'facsimile', label: '版式还原' },
                    { value: 'text', label: '文本列表' },
                  ]}
                />
              ) : null}
              <Button
                size="small"
                type={currentPageProofStatus === 'completed' ? 'default' : 'primary'}
                onClick={handleTogglePageProofStatus}
                disabled={!currentPage?.id}
              >
                {currentPageProofStatus === 'completed' ? '取消本页校对完成' : '标记本页校对完成'}
              </Button>
              <Space.Compact size="small">
                <Button size="small" icon={<ScanOutlined />} loading={ocrProcessing} onClick={() => void handleRerunCurrentPageOcr()} disabled={!currentPage?.id}>
                  重新 OCR 本页
                </Button>
                <Dropdown menu={{ items: ocrActionItems, onClick: handleOcrActionMenuClick }} trigger={['click']} disabled={!currentPage?.id}>
                  <Button size="small" icon={<DownOutlined />} disabled={!currentPage?.id} />
                </Dropdown>
              </Space.Compact>
              {ocrSwitchableVersions.length > 1 ? (
                <Select
                  size="small"
                  value={String(currentOcrEngineForUi)}
                  loading={ocrVersionLoading}
                  disabled={!currentPage?.id}
                  onChange={(engine) => void handleSwitchCurrentPageOcrVersion(engine)}
                  style={{ width: 132 }}
                  options={ocrSwitchableVersions.map((version) => ({
                    value: String(version.engine),
                    label: version.label || getOcrEngineLabel(String(version.engine)),
                  }))}
                />
              ) : (
                <Tag color={String(currentOcrEngineForUi) === 'vision_model' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
                  {getOcrEngineLabel(String(currentOcrEngineForUi))}
                </Tag>
              )}
              <Space.Compact size="small">
                <Select
                  size="small"
                  value={readerSearchEngine}
                  onChange={(engine) => {
                    setReaderSearchEngine(engine)
                    const keyword = searchInputDraft.trim() || effectiveSearchKeyword.trim()
                    if (keyword) {
                      setLocalSearchKeyword(keyword)
                      runInDocumentSearch(keyword, engine)
                    }
                  }}
                  style={{ width: 92 }}
                  options={[
                    {
                      value: 'fulltext',
                      label: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <FontSizeOutlined />
                          文本
                        </span>
                      ),
                    },
                    {
                      value: 'vector',
                      label: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <ThunderboltOutlined />
                          向量
                        </span>
                      ),
                    },
                  ]}
                />
                <Input
                  data-reader-search-input="true"
                  size="small"
                  placeholder={readerSearchEngine === 'vector' ? '语义检索' : '搜索本页文本'}
                  prefix={
                    readerSearchEngine === 'vector'
                      ? <ThunderboltOutlined style={{ color: 'var(--gs-gold)' }} />
                      : <SearchOutlined style={{ color: searchFocused && effectiveSearchKeyword ? 'var(--gs-gold)' : 'rgba(255,255,255,0.25)' }} />
                  }
                  value={searchInputDraft}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setSearchInputDraft(nextValue)
                    if (!nextValue) {
                      setLocalSearchKeyword('')
                      runInDocumentSearch('', readerSearchEngine)
                    }
                  }}
                  onPressEnter={commitSearchInputDraft}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  allowClear
                  style={{
                    width: 160,
                    background: searchFocused && effectiveSearchKeyword ? 'rgba(255,192,105,0.1)' : 'rgba(255,255,255,0.04)',
                    borderColor: searchFocused && effectiveSearchKeyword ? '#ffc069' : 'rgba(255,255,255,0.12)',
                  }}
                />
              </Space.Compact>
              {effectiveSearchKeyword && searchMatches.length > 0 ? (
                <>
                  <Button size="small" icon={<LeftOutlined />} onClick={handleSearchPrev} type="text" style={{ color: 'var(--gs-text-secondary)' }} />
                  <span data-reader-search-counter="true" style={{ fontSize: 12, color: 'var(--gs-text-secondary)', minWidth: 56, textAlign: 'center' }}>
                    {isVectorReaderSearch ? '向量 ' : ''}{currentMatchIndex >= 0 ? currentMatchIndex + 1 : 1}/{searchMatches.length}
                  </span>
                  <Button size="small" icon={<RightOutlined />} data-reader-search-next="true" onClick={handleSearchNext} type="text" style={{ color: 'var(--gs-text-secondary)' }} />
                </>
              ) : null}
              {effectiveSearchKeyword && documentSearchSession?.status === 'searching' && searchMatches.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--gs-text-tertiary)' }}>检索中</span>
              ) : null}
              {effectiveSearchKeyword && documentSearchSession?.status !== 'searching' && searchMatches.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--gs-text-tertiary)' }}>无命中</span>
              ) : null}
            </Space>
          </div>

          <div style={{ flex: 1, overflow: 'hidden', padding: 8 }}>
            {ocrProcessing ? (
              <div className="empty-state">
                <Spin tip="正在调用 PaddleOCR API..." />
              </div>
            ) : canUseManualFacsimileLayout && proofViewMode === 'facsimile' ? (
              <GujiFacsimileProofreader
                draftIdentity={`${doc?.library_project_id || 'unknown-project'}/${doc?.id || documentId}/${currentPage?.id || 'unknown-page'}`}
                ocrResult={editableFacsimileOcrResult}
                pageId={currentPage?.id || ''}
                pageImageSrc={imageDataUrl}
                pageProofStatus={currentPageProofStatus}
                activeBoxIndex={activeBoxIndex}
                activeSearchHitOrdinal={activeProofSearchHitOrdinal}
                searchKeyword={proofSearchHighlightKeyword}
                coordinateSourceSize={facsimileCoordinateSourceSize}
                preferVerticalLayout={shouldUseVerticalOcr}
                translationText={currentFacsimileTranslationText}
                translationUnits={currentPage?.id ? pageTranslationUnits[currentPage.id] || [] : []}
                translationLoading={currentPage?.id ? !!translatingPageIds[currentPage.id] : false}
                translationSkipped={currentFacsimileTranslationSkipped}
                translationOpen={facsimileTranslationOpen}
                translationMode={translationMode}
                documentId={doc?.id || ''}
                documentTitle={doc?.title || ''}
                documentType={doc?.doc_type || null}
                pageNum={currentPage?.page_num ?? null}
                literaturePageNum={
                  Number((currentPage as { literature_page_num?: number | null } | null | undefined)?.literature_page_num || 0) > 0
                    ? Number((currentPage as { literature_page_num?: number | null }).literature_page_num)
                    : null
                }
                onTranslationOpenChange={setFacsimileTranslationOpen}
                onTranslationModeChange={setTranslationMode}
                onTranslateCurrentPage={(text) => {
                  if (!currentPage?.id) return
                  requestReaderTranslation(
                    { pageId: currentPage.id, pageNum: currentPage.page_num, text },
                    { priority: 'current' },
                  )
                }}
                onRetranslateCurrentPage={(text) => {
                  if (!currentPage?.id) return
                  requestReaderTranslation(
                    { pageId: currentPage.id, pageNum: currentPage.page_num, text },
                    { priority: 'current', force: true },
                  )
                }}
                onSave={handleSaveFacsimilePage}
                onSelectBox={setActiveBoxIndex}
                onTextSelectionChange={setSelectedTextForAi}
              />
            ) : proofingOcrResultObj ? (
              <TextEditor
                ocrResult={proofingOcrResultObj}
                pageId={currentPage?.id || ''}
                onSave={handleSavePage}
                onReset={handleResetPage}
                onModeChange={(mode) => {
                  if (mode === 'region' && needsPdfAssetRestore) {
                    void handleRestorePdfAsset(currentPage, false, { quietFailure: true }).then((ok) => {
                      if (!ok) void handleRestorePdfAsset(currentPage, true)
                    })
                  }
                }}
                onTextSelectionChange={setSelectedTextForAi}
                activeBoxIndex={activeTextEditorBoxIndex}
                onLineFocus={handleTextEditorLineFocus}
                switchToRegion={switchToRegion}
                onSwitchToRegionConsumed={() => setSwitchToRegion(false)}
                searchKeyword={proofSearchHighlightKeyword}
              />
            ) : (
              <Empty image={<FileImageOutlined style={{ fontSize: 48, opacity: 0.2 }} />} description="暂无可校对文本" />
            )}
          </div>
        </div>
      </div>
      )}

      {!floatPanelOpen ? (
        <div
          ref={aiButtonRef}
          className="ai-float-button-rect"
          title="AI 智能助手（长按拖动）"
          style={{ transform: `translate(${btnPosRef.current.x}px, ${btnPosRef.current.y}px)` }}
          onMouseDown={(event) => {
            event.preventDefault()
            btnDragState.current.moved = false
            btnDragState.current.timer = setTimeout(() => {
              btnDragState.current.isDragging = true
              btnDragState.current.startX = event.clientX
              btnDragState.current.startY = event.clientY
              btnDragState.current.btnX = btnPosRef.current.x
              btnDragState.current.btnY = btnPosRef.current.y
              if (aiButtonRef.current) {
                aiButtonRef.current.style.transition = 'none'
                aiButtonRef.current.style.transform = `translate(${btnPosRef.current.x}px, ${btnPosRef.current.y}px) scale(1.05)`
              }
              document.body.style.cursor = 'grabbing'
            }, 200)
          }}
          onClick={() => {
            if (!btnDragState.current.moved) {
              setFloatPanelOpen(true)
            }
          }}
        >
          AI
        </div>
      ) : null}

      <div
        ref={floatingPanelRef}
        className={`ai-floating-panel ${!floatPanelOpen ? 'hidden' : ''}`}
        style={{ transform: `translate(${panelState.current.x}px, ${panelState.current.y}px)`, width: panelState.current.w, height: panelState.current.h }}
      >
        {['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) => (
          <div key={dir} className={`resize-handle ${dir}`} onMouseDown={(event) => handleResizeStart(event, dir)} />
        ))}

        <div className="ai-floating-panel-header" onMouseDown={handlePanelDragStart}>
          <div className="ai-floating-panel-title">
            <RobotOutlined style={{ color: 'var(--gs-gold)' }} />
            <span>智能助手</span>
          </div>
          <Button
            type="text"
            icon={<CloseOutlined />}
            size="small"
            style={{ color: 'var(--gs-text-secondary)' }}
            onClick={() => setFloatPanelOpen(false)}
          />
        </div>

        <div style={{ padding: '8px 16px', height: 'calc(100% - 48px)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {floatPanelOpen ? (
            <Suspense fallback={<DocumentLazyFallback />}>
              <AiPanel
                key={doc.id}
                mode="document"
                documentId={doc.id}
                documentTitle={doc.title}
                documentText={readerContextTextForAi || resultText}
                selectedText={selectedTextForAi}
                onOpenDocument={handleAiOpenDocument}
              />
            </Suspense>
          ) : null}
        </div>
      </div>

      {editorVisible ? (
        <Suspense fallback={null}>
          <MetadataEditor
            visible={editorVisible}
            document={doc}
            onCancel={() => setEditorVisible(false)}
            onSave={handleSaveMetadata}
          />
        </Suspense>
      ) : null}
      <Modal
        title="导出文献"
        open={exportModalOpen}
        onCancel={() => {
          setExportModalOpen(false)
          setPendingExportFormat(null)
        }}
        onOk={() => void confirmDocumentExport()}
        okText="导出"
        cancelText="取消"
        confirmLoading={exportingDocument}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary">
            格式：{{
              markdown: 'Markdown',
              'tei-xml': 'TEI-XML',
              'page-xml': 'PAGE XML',
              'paddle-json': 'Paddle JSON',
              txt: 'TXT',
              'reading-pdf': '阅读模式 PDF',
              'layout-pdf': '排版模式 PDF',
              'layout-searchable-pdf': '原图可搜索 PDF',
            }[pendingExportFormat || 'txt'] || pendingExportFormat}
          </Text>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>页码类型</Text>
            <Radio.Group
              value={exportPageNumberMode}
              onChange={(event) => setExportPageNumberMode(event.target.value)}
              optionType="button"
              buttonStyle="solid"
              options={[
                { value: 'literature', label: '文献页码' },
                { value: 'natural', label: '自然页码' },
              ]}
            />
            <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              {exportPageNumberMode === 'natural'
                ? '自然页码：PDF/扫描影像的物理页序（第 1…N 页）。'
                : '文献页码：书上印刷/校准后的连续页码（默认，与阅读模式「文献页码」一致）。'}
            </Text>
          </div>
        </Space>
      </Modal>
      <Modal
        title="加入翻译术语表"
        open={quickGlossaryModalOpen}
        onCancel={() => setQuickGlossaryModalOpen(false)}
        onOk={() => void saveQuickGlossaryTerm()}
        okText="保存术语"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text type="secondary">保存位置</Text>
            <Select
              value={quickGlossaryScope}
              onChange={(value) => setQuickGlossaryScope(value)}
              style={{ width: '100%', marginTop: 6 }}
              options={[
                { value: 'global', label: '全局术语表' },
                {
                  value: 'project',
                  label: activeTranslationGlossaryProjectId
                    ? `当前项目：${translationGlossaryProjects.find((project) => project.id === activeTranslationGlossaryProjectId)?.name || '项目术语表'}`
                    : '项目术语表（请先在阅读器选择项目）',
                  disabled: !activeTranslationGlossaryProjectId,
                },
              ]}
            />
          </div>
          <div>
            <Text type="secondary">原词</Text>
            <Input
              value={quickGlossarySourceTerm}
              onChange={(event) => setQuickGlossarySourceTerm(event.target.value)}
              maxLength={160}
              style={{ marginTop: 6 }}
            />
          </div>
          <div>
            <Text type="secondary">建议译名</Text>
            <Input
              value={quickGlossaryTargetTerm}
              onChange={(event) => setQuickGlossaryTargetTerm(event.target.value)}
              maxLength={160}
              autoFocus
              style={{ marginTop: 6 }}
            />
          </div>
          <div>
            <Text type="secondary">备注</Text>
            <Input.TextArea
              value={quickGlossaryNote}
              onChange={(event) => setQuickGlossaryNote(event.target.value)}
              rows={3}
              maxLength={600}
              placeholder="可选：写入语境、学科说明或例外情况"
              style={{ marginTop: 6 }}
            />
          </div>
        </Space>
      </Modal>
    </div>
  )
}
