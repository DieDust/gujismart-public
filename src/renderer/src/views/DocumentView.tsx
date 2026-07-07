import { Children, cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { lazy, Suspense } from 'react'
import { Button, Dropdown, Empty, Input, Modal, Pagination, Popover, Select, Segmented, Slider, Space, Spin, Tag, Typography, message } from 'antd'
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
  DownOutlined,
  EditOutlined,
  ExportOutlined,
  FileImageOutlined,
  FolderOpenOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  RobotOutlined,
  ScanOutlined,
  SearchOutlined,
  SettingOutlined,
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
import { extractPageText, getCitationPageNumber, getOcrBlockText, getOrderedOcrBlocks, getReadablePageElements, getReadablePageText, getTextFlowOcrBlocks, normalizeOcrTextForReading } from '../utils/ocrText'
import { clampAiButtonPosition, clampFloatingPanelState, getDefaultFloatingPanelState } from '../utils/floatingViewport'
import { hasShortcutBlockingOverlay, isEditableShortcutTarget, loadShortcutSettings, SHORTCUTS_CHANGED_EVENT, shortcutMatches, type ShortcutMap } from '../utils/shortcuts'
import { resolveDocumentCitation } from '../utils/citations'
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
import { DEFAULT_HIGHLIGHT_COLOR } from '../utils/highlightColors'
import { LIBRARY_RELATIONS_CHANGED_EVENT } from '../utils/libraryEvents'
import type { DocumentDetail, DocumentExportFormat, DocumentExportOptions, DocumentLightDetail, DocumentPage, DocumentUpdatePayload, LlmProviderProfile, LlmProviderProfileState, OcrEngine, OcrRecognizeLayoutBlock, OcrRecognizeResult, OpenDocumentTarget, PageOcrVersion, PageTranslationCacheItem, PageTranslationProgressEvent, PageUpdatePayload, ReaderState, ReaderStateSavePayload, ReaderTranslationOptions, ReaderTranslationPayload, ReaderTranslationPriority, ResearchProject, SearchHitLocator, SearchSessionState, TranslationGlossaryScope, TranslationMode, TranslationUnitV1 } from '@shared/types'

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
const PROOF_PAGE_WINDOW_RADIUS = 1
const PROOF_IMAGE_PREFETCH_DELAY_MS = 260
const PROOF_IMAGE_PREFETCH_OFFSETS = [1, -1]
const PROOF_IMAGE_PREWARM_DELAY_MS = 650
const PROOF_IMAGE_PREWARM_ALL_PAGE_LIMIT = 120
const PROOF_IMAGE_PREWARM_WINDOW_RADIUS = 10
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })

interface DocumentViewProps {
  documentId: string
  initialPageIndex?: number
  searchKeyword?: string
  sourceId?: string
  locator?: SearchHitLocator
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
  sourcePageId?: string
  sourceStartChar: number
  sourceEndChar: number
  segmentIndex: number
  text: string
}
type SearchMatch = {
  pageIndex: number
  boxIndex: number
  textFlowIndex?: number
  charIndex: number
  boxTop: number
  boxLeft: number
  keyword: string
  hitIndex?: number
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

function findBoxForLocator(page: DocumentViewPage | undefined, locator: SearchHitLocator, query: string): { boxIndex: number; boxTop: number; boxLeft: number } {
  const parsed = parseMaybeJson(page?.ocr_result)
  const boxes = getOrderedOcrBlocks({ ...(page || {}), ocr_result: parsed }) as FacsimileLayoutBlock[]
  if (!Array.isArray(boxes) || boxes.length === 0) {
    return { boxIndex: -1, boxTop: Number.MAX_SAFE_INTEGER, boxLeft: Number.MAX_SAFE_INTEGER }
  }
  const terms = uniqueSearchTerms(locator.matchText || locator.queryTerm || query)
  const needle = terms[0]?.toLowerCase() || ''
  const candidates = boxes
    .map((box, boxIndex) => {
      const text = getBoxText(box).toLowerCase()
      if (!needle || !text.includes(needle)) return null
      const point = getBoxSortPoint(box)
      return { boxIndex, boxTop: point.top, boxLeft: point.left }
    })
    .filter((item): item is { boxIndex: number; boxTop: number; boxLeft: number } => !!item)
    .sort((left, right) => left.boxTop - right.boxTop || left.boxLeft - right.boxLeft || left.boxIndex - right.boxIndex)
  return candidates[0] || { boxIndex: -1, boxTop: Number.MAX_SAFE_INTEGER, boxLeft: Number.MAX_SAFE_INTEGER }
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
  const sourcePages = pages
    .map((page) => Math.round(Number(page.page_num || 0)))
    .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0)
  if (normalizedPageCount > 0 && normalizedPageCount <= PROOF_IMAGE_PREWARM_ALL_PAGE_LIMIT) {
    return Array.from({ length: normalizedPageCount }, (_item, index) => index + 1)
  }
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
    const text = getPageReadingText(page)
    if (!text) return
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
        readerPages.push({
          id: `${page.id || sourcePageIndex}-${segmentIndex}`,
          sourcePageIndex,
          sourcePageNum: page.page_num || sourcePageIndex + 1,
          sourcePageId: page.id,
          sourceStartChar,
          sourceEndChar: sourceStartChar + chunk.length,
          segmentIndex,
          text: chunk,
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
  const openContextKey = getDocumentOpenContextKey(documentId, locator, initialPageIndex, searchKeyword, sourceId, highlightExcerpt, revealToc, searchSession)
  const [doc, setDoc] = useState<DocumentViewDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [ocrProcessing, setOcrProcessing] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [restoringPdf, setRestoringPdf] = useState(false)
  const [exportingDocument, setExportingDocument] = useState(false)
  const [editorVisible, setEditorVisible] = useState(false)
  const [activeBoxIndex, setActiveBoxIndex] = useState(-1)
  const [switchToRegion, setSwitchToRegion] = useState(false)
  const [currentPageIndex, setCurrentPageIndex] = useState(0)
  const [pageInput, setPageInput] = useState('1')
  const [imageDataUrl, setImageDataUrl] = useState('')
  const [nextImageDataUrl, setNextImageDataUrl] = useState('')
  const [floatPanelOpen, setFloatPanelOpen] = useState(false)
  const [localSearchKeyword, setLocalSearchKeyword] = useState(searchKeyword)
  const [readerSearchPages, setReaderSearchPages] = useState<DocumentPage[]>([])
  const [readerFullSearchRequested, setReaderFullSearchRequested] = useState(false)
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
  const [readerBookTranslationRequest, setReaderBookTranslationRequest] = useState(0)
  const [readerTocOpen, setReaderTocOpen] = useState(true)
  const [readerSidebarTab, setReaderSidebarTab] = useState<ReaderSidebarTab>('toc')
  const [readerSearchResultPage, setReaderSearchResultPage] = useState(1)
  const [readerViewportHeight, setReaderViewportHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 800)
  const [readerPageIndex, setReaderPageIndex] = useState(0)
  const [documentMode, setDocumentMode] = useState<DocumentMode>('read')
  const [proofViewMode, setProofViewMode] = useState<ProofViewMode>('text')
  const [proofViewTouched, setProofViewTouched] = useState(false)
  const [facsimileTranslationOpen, setFacsimileTranslationOpen] = useState(false)
  const [preferFacsimileProofLayout, setPreferFacsimileProofLayout] = useState(true)
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
  const documentModeSwitchSerialRef = useRef(0)
  const readerSaveTimerRef = useRef<number | null>(null)
  const readerPreferencesLoadedRef = useRef(false)
  const readerPreferencesSaveTimerRef = useRef<number | null>(null)
  const latestReaderPreferencesRef = useRef<ReaderGlobalPreferences>(DEFAULT_READER_GLOBAL_PREFERENCES)
  const latestReaderStateRef = useRef<ReaderStateSavePayload>({})
  const searchRequestIdRef = useRef(0)
  const searchPagesRequestIdRef = useRef(0)
  const incomingSearchSessionKeyRef = useRef('')
  const searchAutoNavigationKeyRef = useRef('')
  const appliedInitialSearchLocatorKeyRef = useRef('')
  const temporaryNavigationRef = useRef(false)
  const pageRangeRequestRef = useRef(0)
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
    const targetPageIndex = resolveLocatorPageIndex(sortedPagesRef.current, target.locator, target.pageIndex ?? initialPageIndex)
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
    if (!startReaderBookTranslation) return
    setDocumentMode('read')
    setReaderBookTranslationRequest((value) => value + 1)
  }, [startReaderBookTranslation])

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
  const locatorHits = !shouldPreferLocalSearchMatches && documentSearchSession?.query === effectiveSearchKeyword ? (documentSearchSession.hits || []) : []
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
  const ocrResultObj = useMemo(() => parseMaybeJson(currentPage?.ocr_result), [currentPage])
  const proofingOcrResultObj = useMemo(() => getProofingOcrResult(currentPage), [currentPage])
  const facsimileOcrResultObj = useMemo(
    () => chooseFacsimileOcrResult(ocrResultObj, proofingOcrResultObj),
    [ocrResultObj, proofingOcrResultObj],
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
  const isTextOnlyPdf = readRecordValue(docMetadataObj, 'pdf_asset_state') === 'text_only'
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
  const shouldShowBookPreview = !!currentPage && !isPdfSource && !hasCurrentPageImage && !!getPageDisplayText(currentPage)
  const readerVirtualPages = useMemo(
    () => documentMode !== 'read' || shouldPreferSourcePageReader
      ? []
      : buildReaderPages(sortedPages, readerFontSize, readerLineHeight, readerPageWidth, readerViewportHeight),
    [documentMode, readerFontSize, readerLineHeight, readerPageWidth, readerViewportHeight, shouldPreferSourcePageReader, sortedPages],
  )
  const readerVirtualPageCount = readerVirtualPages.length
  const readerCurrentPage = readerVirtualPages[readerPageIndex]
  const readerNextPage = readerVirtualPages[readerPageIndex + 1]
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

  const searchMatches = useMemo<SearchMatch[]>(() => {
    if (shouldPreferSourcePageReader) return []
    if (locatorHits.length > 0) {
      return locatorHits
        .map((hit, hitIndex) => {
          const locator = hit.locator
          const pageIndex = resolveLocatorPageIndex(sortedPages, locator)
          const box = findBoxForLocator(sortedPages[pageIndex], locator, effectiveSearchKeyword)
          return {
            pageIndex,
            boxIndex: box.boxIndex,
            charIndex: locator.charStart,
            boxTop: box.boxTop,
            boxLeft: box.boxLeft,
            keyword: locator.queryTerm || effectiveSearchKeyword || locator.matchText,
            hitIndex,
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
        : (currentPage ? [{ page: currentPage, pageIndex: currentPageIndex }] : []))
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
        boxHits.forEach((hit) => {
          matches.push({
            pageIndex,
            boxIndex: getMappedBoxIndex(textFlowToLayoutIndex, boxIndex),
            textFlowIndex: boxIndex,
            charIndex: hit.charIndex,
            boxTop: point.top,
            boxLeft: point.left,
            keyword: hit.keyword,
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
  }, [currentPage, currentPageIndex, documentMode, effectiveSearchKeyword, locatorHits, pageCount, readerSearchPages, shouldPreferSourcePageReader, sortedPages])
  const activeProofSearchHitOrdinal = useMemo(() => {
    if (documentMode !== 'proof') return -1
    if (currentMatchIndex < 0 || currentMatchIndex >= searchMatches.length) return -1
    const selectedMatch = searchMatches[currentMatchIndex]
    if (!selectedMatch || selectedMatch.pageIndex !== currentPageIndex || selectedMatch.boxIndex < 0) return -1
    return searchMatches
      .slice(0, currentMatchIndex)
      .filter((match) => match.pageIndex === selectedMatch.pageIndex && match.boxIndex === selectedMatch.boxIndex)
      .length
  }, [currentMatchIndex, currentPageIndex, documentMode, searchMatches])

  const mergeDocumentPages = useCallback((nextPages: DocumentPage[], targetDocId = documentId) => {
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
      return { ...previous, pages: mergedPages }
    })
  }, [documentId])

  const loadPagesAround = useCallback(async (pageIndex: number, radius = 3) => {
    if (!documentId) return
    const targetDocId = documentId
    const requestId = ++pageRangeRequestRef.current
    const startPageNum = Math.max(1, pageIndex + 1 - radius)
    const endPageNum = pageIndex + 1 + radius
    try {
      const readingWindow = await window.api.getDocumentReadingWindow(targetDocId, pageIndex, radius)
      const pages = Array.isArray(readingWindow?.pages)
        ? readingWindow.pages
        : await window.api.getDocumentPagesRange(targetDocId, startPageNum, endPageNum)
      if (activeDocumentIdRef.current !== targetDocId) return
      if (requestId !== pageRangeRequestRef.current && radius <= 3) return
      mergeDocumentPages(pages, targetDocId)
    } catch (error) {
      console.error('Failed to load page range', error)
    }
  }, [documentId, mergeDocumentPages])

  const loadProofPageWindow = useCallback(async (pageIndex: number) => {
    if (!documentId) return
    const targetDocId = documentId
    const requestId = ++pageRangeRequestRef.current
    const radius = PROOF_PAGE_WINDOW_RADIUS
    const startPageNum = Math.max(1, pageIndex + 1 - radius)
    const endPageNum = Math.min(Math.max(1, pageCount || startPageNum), pageIndex + 1 + radius)
    try {
      const readingWindow = await window.api.getDocumentReadingWindow(targetDocId, pageIndex, radius)
      const pages = Array.isArray(readingWindow?.pages)
        ? readingWindow.pages
        : await window.api.getDocumentPagesRange(targetDocId, startPageNum, endPageNum)
      if (activeDocumentIdRef.current !== targetDocId) return
      if (requestId !== pageRangeRequestRef.current) return
      mergeDocumentPages(pages, targetDocId)
    } catch (error) {
      console.error('Failed to load proof page window', error)
    }
  }, [documentId, mergeDocumentPages, pageCount])

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
      const targetIndex = resolveLocatorPageIndex(normalizedDoc.pages || [], locator, initialPageIndex)
      void loadPagesAround(targetIndex, 4)
    } catch (error) {
      console.error(error)
      message.error('加载文献详情失败')
    } finally {
      if (activeDocumentIdRef.current === targetDocId) setLoading(false)
    }
  }, [documentId, initialPageIndex, loadPagesAround, locator])

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
    const data = await window.api.getDocument(targetDocId)
    if (activeDocumentIdRef.current !== targetDocId) return data
    const normalized = normalizeDocumentDetail(data, targetDocId)
    setDoc(normalized)
    if (targetPageId) {
      const nextPages = normalized?.pages ? [...normalized.pages].sort((left, right) => left.page_num - right.page_num) : []
      const nextIndex = nextPages.findIndex((page) => page.id === targetPageId)
      if (nextIndex >= 0) {
        setCurrentPageIndex(nextIndex)
      }
    }
    return normalized
  }, [documentId])

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
        const value = await window.api.getSetting('prefer_facsimile_proof_layout')
        if (!cancelled) setPreferFacsimileProofLayout(value !== 'false')
      } catch (error) {
        console.error('Failed to load proof layout preference', error)
      }
    }
    void loadProofLayoutPreference()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (documentMode !== 'proof' || proofViewTouched) return
    setProofViewMode(facsimileProofCandidate && preferFacsimileProofLayout ? 'facsimile' : 'text')
  }, [documentMode, facsimileProofCandidate, preferFacsimileProofLayout, proofViewTouched])

  useEffect(() => {
    if (!facsimileOcrResultObj) return
    if (!facsimileProofCandidate && proofViewMode === 'facsimile') {
      setProofViewMode('text')
    }
  }, [facsimileOcrResultObj, facsimileProofCandidate, proofViewMode])

  useLayoutEffect(() => {
    activeDocumentIdRef.current = documentId
    documentModeSwitchSerialRef.current += 1
    const targetDocId = documentId
    setLoading(true)
    setDoc(null)
    setReaderSearchPages([])
    setReaderFullSearchRequested(false)
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
    const initialTargetPageIndex = Math.max(0, getFinitePageIndex(locator?.pageIndex) ?? initialPageIndex)
    setCurrentPageIndex(initialTargetPageIndex)
    setReaderPageIndex(initialTargetPageIndex)
    setDocumentMode('read')
    setProofViewMode('text')
    setProofViewTouched(false)
    setFacsimileTranslationOpen(false)
    setLocalSearchKeyword(highlightExcerpt || searchKeyword)
    setInitialReaderLocationKey('')
    setReaderStateReady(false)
    latestReaderStateRef.current = {}
    if (readerSaveTimerRef.current) {
      window.clearTimeout(readerSaveTimerRef.current)
      readerSaveTimerRef.current = null
    }
    searchRequestIdRef.current += 1
    incomingSearchSessionKeyRef.current = ''
    appliedInitialSearchLocatorKeyRef.current = ''
    temporaryNavigationRef.current = !!(sourceId || locator || searchSession?.hits?.length || searchKeyword || highlightExcerpt)
    setDocumentSearchSession(searchSession)
    setCurrentMatchIndex(searchSession?.activeHitIndex ?? -1)
    if (revealToc) {
      setReaderTocOpen(true)
    }
    void (async () => {
      try {
        const data = await window.api.getDocumentLight(targetDocId)
        if (activeDocumentIdRef.current !== targetDocId) return
        const normalizedDoc = normalizeDocumentDetail(data, targetDocId)
        if (!normalizedDoc) {
          throw new Error('Document detail is empty')
        }
        setDoc(normalizedDoc)
        const targetIndex = resolveLocatorPageIndex(normalizedDoc.pages || [], locator, initialPageIndex)
        void loadPagesAround(targetIndex, 4)
      } catch (error) {
        console.error(error)
        message.error('加载文献详情失败')
      } finally {
        if (activeDocumentIdRef.current === targetDocId) setLoading(false)
      }
    })()
  }, [openContextKey])

  useEffect(() => {
    if (!doc) return
    if (isEbookDocument && documentMode === 'proof') {
      setDocumentMode('read')
      return
    }
    const maxIndex = doc.pages ? doc.pages.length - 1 : 0
    if (!hasInitializedPageRef.current) {
      hasInitializedPageRef.current = true
      setCurrentPageIndex(resolveLocatorPageIndex(sortedPages, locator, initialPageIndex))
      return
    }
    setCurrentPageIndex((value) => Math.min(value, maxIndex))
  }, [doc, documentMode, initialPageIndex, isEbookDocument, locator, sortedPages])

  useEffect(() => {
    const query = effectiveSearchKeyword.trim()
    searchRequestIdRef.current += 1
    const requestId = searchRequestIdRef.current
    if (!documentId || !query) {
      setDocumentSearchSession({ query: '', hits: [], activeHitIndex: -1, status: 'idle' })
      setCurrentMatchIndex(-1)
      setActiveBoxIndex(-1)
      return
    }
    const shouldRefreshFocusedIncomingSession = shouldUseSourcePageReader
      && Boolean(sourceId || locator)
      && (searchSession?.hits?.length || 0) <= 1
    if (searchSession?.query === query && !shouldRefreshFocusedIncomingSession) {
      const incomingKey = `${documentId}:${query}:${searchSession.hits?.length || 0}:${searchSession.hits?.[0]?.id || ''}`
      if (incomingSearchSessionKeyRef.current !== incomingKey) {
        incomingSearchSessionKeyRef.current = incomingKey
        const nextActiveIndex = searchSession.activeHitIndex >= 0 ? searchSession.activeHitIndex : searchSession.hits.length > 0 ? 0 : -1
        setDocumentSearchSession({ ...searchSession, activeHitIndex: nextActiveIndex })
        setCurrentMatchIndex(nextActiveIndex)
      }
      return
    }
    const shouldRefreshCurrentFocusedSession = shouldUseSourcePageReader
      && Boolean(sourceId || locator)
      && documentSearchSession?.query === query
      && (documentSearchSession.hits?.length || 0) <= 1
    if (documentSearchSession?.query === query && documentSearchSession.status !== 'searching' && !shouldRefreshCurrentFocusedSession) return
    if (shouldPreferLocalSearchMatches && locator && !shouldUseSourcePageReader) {
      setDocumentSearchSession({
        query,
        hits: [],
        activeHitIndex: -1,
        status: 'ready',
      })
      return
    }

    setDocumentSearchSession((previous) => ({
      query,
      hits: previous?.query === query ? previous.hits : [],
      activeHitIndex: previous?.query === query ? previous.activeHitIndex : -1,
      status: 'searching',
    }))

    const timer = window.setTimeout(() => {
      window.api.getDocumentSearchHits(documentId, query, { limit: 20000, resultMode: 'all' })
        .then((session: SearchSessionState) => {
          if (searchRequestIdRef.current !== requestId) return
          const targetIndex = locator
            ? session.hits.findIndex((hit) => (
              hit.locator.segmentId === locator.segmentId
              && Math.abs(hit.locator.charStart - locator.charStart) <= 2
            ))
            : -1
          const nextActiveIndex = targetIndex >= 0 ? targetIndex : session.hits.length > 0 ? 0 : -1
          setDocumentSearchSession({ ...session, activeHitIndex: nextActiveIndex })
          setCurrentMatchIndex(nextActiveIndex)
        })
        .catch((error: unknown) => {
          if (searchRequestIdRef.current !== requestId) return
          console.error('Failed to load document search hits', error)
          setDocumentSearchSession({ query, hits: [], activeHitIndex: -1, status: 'error' })
          setCurrentMatchIndex(-1)
        })
    }, 220)

    return () => {
      window.clearTimeout(timer)
    }
  }, [documentId, documentSearchSession?.query, documentSearchSession?.status, effectiveSearchKeyword, locator, searchSession, shouldPreferLocalSearchMatches, shouldUseSourcePageReader, sourceId])

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

  useEffect(() => {
    const query = localSearchKeyword.trim()
    const requestId = ++searchPagesRequestIdRef.current
    const shouldLoadSearchPages = shouldUseSourcePageReader || documentMode === 'proof'
    if (!documentId || !query || !shouldLoadSearchPages) {
      setReaderSearchPages([])
      return
    }
    if (shouldUseSourcePageReader && !readerFullSearchRequested && (sourceId || locator || searchSession?.hits?.length)) {
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
  }, [documentId, documentMode, localSearchKeyword, locator, pageCount, readerFullSearchRequested, readerSearchPages.length, searchSession?.hits?.length, shouldUseSourcePageReader, sourceId])

  useEffect(() => {
    if (!doc || readerStateLoadedRef.current || searchKeyword) return
    const targetDocId = documentId
    readerStateLoadedRef.current = true
    let cancelled = false
    const applyRestoredPageIndex = (pageIndex: number) => {
      const nextIndex = clampPageIndex(pageIndex, pageCountRef.current)
      setCurrentPageIndex(nextIndex)
      void loadPagesAround(nextIndex, 5)
    }
    void window.api.getReaderState(targetDocId).then((state: ReaderState | null) => {
      if (cancelled || activeDocumentIdRef.current !== targetDocId || !state) return
      const latestPageCount = pageCountRef.current
      const latestReaderVirtualPages = readerVirtualPagesRef.current
      const latestSortedPages = sortedPagesRef.current
      const canRestoreDocumentMode = !documentModeTouchedRef.current
      if (canRestoreDocumentMode && state.view_mode === 'single') setDocumentMode('read')
      const savedLocationKey = String(state.location_key || '')
      setInitialReaderLocationKey(savedLocationKey)

      if (canRestoreDocumentMode && state.document_mode === 'proof' && !isEbookDocumentRef.current) {
        setDocumentMode('proof')
        if (state.proof_view_mode === 'facsimile' || state.proof_view_mode === 'text') {
          setProofViewMode(state.proof_view_mode)
          setProofViewTouched(true)
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
    const firstMatchAtOrAfterCurrentPage = searchMatches.findIndex((match) => match.pageIndex >= currentPageIndex)
    const selectedIndex = currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length
      ? currentMatchIndex
      : firstMatchAtOrAfterCurrentPage >= 0 ? firstMatchAtOrAfterCurrentPage : 0
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
  }, [currentMatchIndex, currentPageIndex, documentMode, effectiveSearchKeyword, loadPagesAround, pageCount, readerSearchPages.length, searchMatches])

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
    if (virtualPage.sourcePageIndex !== currentPageIndex) {
      setCurrentPageIndex(virtualPage.sourcePageIndex)
    }
    setPageInput(String(readerPageIndex + 1))
  }, [buildTextReaderState, currentPageIndex, readerPageIndex, readerStateReady, readerVirtualPages, saveReaderStateSoon, shouldUseTextReaderMode])

  useEffect(() => {
    if (documentMode !== 'read' || shouldUseEbookReader || shouldUseTextReaderMode) return
    readerVisiblePageIndexRef.current = currentPageIndex
  }, [currentPageIndex, documentMode, shouldUseEbookReader, shouldUseTextReaderMode])

  const loadPageImage = useCallback(async (page: DocumentViewPage | undefined, options?: { updateDoc?: boolean }): Promise<string> => {
    if (!page) return ''
    const cacheKey = getPageImageCacheKey(page, doc?.id, documentId)
    const cached = pageImageCacheRef.current.get(cacheKey)
    if (cached) return cached

    if (page.image_path) {
      try {
        const dataUrl = await window.api.readImageAsDataURL(page.image_path as string)
        putLimitedPageImageCache(pageImageCacheRef.current, cacheKey, dataUrl)
        return dataUrl
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
          await window.api.updatePage(page.id, { image_path: imagePath })
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
        onPageCached: async (pageNum, imagePath, dataUrl) => {
          if (pageNum !== page.page_num) return
          putLimitedPageImageCache(pageImageCacheRef.current, getPageImageCacheKey(page, doc.id, documentId), dataUrl)
          await window.api.updatePage(page.id, { image_path: imagePath })
        },
      })
      if (result.cachedPageNums.includes(page.page_num)) return true
      const latestDoc = await window.api.getDocument(doc.id).catch(() => null)
      const latestPage = latestDoc?.pages?.find((item) => item.id === page.id || Number(item.page_num || 0) === page.page_num)
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
      await window.api.updatePage(page.id, { image_path: imagePath })
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
        return
      }

      try {
        const dataUrl = await loadPageImage(currentPage)
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
      }
    }

    if (doc && (shouldUseImageReaderMode || shouldUseProofLayout)) {
      void loadCurrentImage()
    }

    return () => {
      canceled = true
    }
  }, [currentPage, doc, loadPageImage, nextSpreadPage, shouldUseImageReaderMode, shouldUseProofLayout])

  useEffect(() => {
    if (!shouldUseSourcePageReader) return
    void loadPagesAround(currentPageIndex, 5)
  }, [currentPageIndex, loadPagesAround, shouldUseSourcePageReader])

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
    const timer = window.setTimeout(() => {
      void ensureOcrPageImages(doc, {
        pageNums,
        onPageCached: async (pageNum, imagePath, dataUrl) => {
          if (canceled) return
          const cachedPage = sortedPages.find((page) => Number(page.page_num || 0) === pageNum)
          if (cachedPage) {
            putLimitedPageImageCache(pageImageCacheRef.current, getPageImageCacheKey(cachedPage, doc.id, documentId), dataUrl)
          }
          setDoc((previous) => {
            if (!previous?.pages) return previous
            return {
              ...previous,
              pages: previous.pages.map((page) => (
                Number(page.page_num || 0) === pageNum
                  ? { ...page, image_path: imagePath }
                  : page
              )),
            }
          })
          if (Number(currentPage?.page_num || 0) === pageNum) {
            setImageDataUrl(dataUrl)
          }
        },
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

  const handleStartOcr = async () => {
    if (!doc?.pages?.length) return
    setOcrProcessing(true)
    try {
      const forceFullRerun = doc.ocr_status === 'completed'
      if (forceFullRerun) {
        await window.api.updateDocument(doc.id, { ocr_status: 'pending' })
      }
      const storedEngine = parseMaybeJson(doc.metadata)?.ocr_engine
      const targetEngine = isOcrEngine(storedEngine) ? storedEngine : undefined
      if (targetEngine === 'local_paddle' || targetEngine === 'vision_model' || targetEngine === 'hybrid') {
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
        const latest = await window.api.getDocument(doc.id)
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

  const handleSavePage = async (pageId: string, data: PageUpdatePayload) => {
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
            image_path: data.image_path ?? page.image_path,
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

        return {
          ...previous,
          proof_status: nextPages.length > 0 && nextPages.every((page) => page.proof_status === 'completed') ? 'completed' : 'pending',
          pages: nextPages,
        }
      })
    } catch (error) {
      console.error(error)
      message.error('保存失败')
    }
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
        if (targetPage.id) {
          await window.api.updatePage(targetPage.id, { image_path: imagePath })
        }
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
        onPageCached: async (pageNum, imagePath, dataUrl) => {
          if (pageNum !== targetPage.page_num) return
          putLimitedPageImageCache(pageImageCacheRef.current, cacheKey, dataUrl)
          if (targetPage.id) {
            await window.api.updatePage(targetPage.id, { image_path: imagePath })
          }
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

  const handleRestorePdfAsset = async (manualPath?: string, targetPage: DocumentViewPage | undefined = currentPage) => {
    if (!doc?.id) return false
    setRestoringPdf(true)
    try {
      const result = await window.api.restorePdfForDocument(doc.id, manualPath)
      if (result?.restored) {
        const refreshed = await refreshDocumentKeepPage(targetPage?.id || currentPage?.id)
        const refreshedPage = refreshed?.pages?.find((page) => (
          (targetPage?.id && page.id === targetPage.id)
          || (targetPage?.page_num && page.page_num === targetPage.page_num)
        ))
        const pageReady = await cacheRestoredPdfCurrentPage(result.path, refreshedPage || targetPage)
        window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
        message.success(pageReady ? 'PDF 原图已补回，当前页预览已恢复' : 'PDF 原图已补回；当前页预览生成失败，可手动重新选择 PDF 或重新打开文献')
        return true
      }
      message.warning(result?.error || '未能补回 PDF 原图')
      return false
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '补回 PDF 原图失败'))
      return false
    } finally {
      setRestoringPdf(false)
    }
  }

  const handleRestorePdfManually = async () => {
    const paths = await window.api.openFileDialog()
    const pdfPath = paths.find((item) => item.toLowerCase().endsWith('.pdf'))
    if (!pdfPath) {
      message.warning('请选择 PDF 文件')
      return
    }
    await handleRestorePdfAsset(pdfPath)
  }

  const switchDocumentMode = async (nextMode: DocumentMode) => {
    if (nextMode === documentMode) return
    documentModeTouchedRef.current = true
    const switchSerial = ++documentModeSwitchSerialRef.current
    if (readerSaveTimerRef.current) {
      window.clearTimeout(readerSaveTimerRef.current)
      readerSaveTimerRef.current = null
    }
    const activeSearchMatch = currentMatchIndex >= 0
      ? (shouldUseTextReaderMode ? textReaderMatches[currentMatchIndex] : searchMatches[currentMatchIndex])
      : null
    const syncedPageIndex = clampPageIndex(
      nextMode === 'proof' && activeSearchMatch
        ? activeSearchMatch.pageIndex
        : documentMode === 'read' ? readerVisiblePageIndexRef.current : currentPageIndex,
      pageCount,
    )
    if (nextMode === 'proof' && isTextOnlyPdf) {
      const restored = await handleRestorePdfAsset(undefined, sortedPages[syncedPageIndex] || currentPage)
      if (documentModeSwitchSerialRef.current !== switchSerial) return
      if (!restored) {
        message.warning('无法自动补回原始 PDF，请手动选择 PDF')
        return
      }
    }
    if (documentModeSwitchSerialRef.current !== switchSerial) return
    setCurrentPageIndex(syncedPageIndex)
    if (nextMode === 'proof' && activeSearchMatch) {
      setActiveBoxIndex(activeSearchMatch.boxIndex)
    }
    if (nextMode === 'read') {
      readerVisiblePageIndexRef.current = syncedPageIndex
      const nextReaderPageIndex = getReaderPageIndexForSourcePage(syncedPageIndex)
      setReaderPageIndex(nextReaderPageIndex)
    } else {
      setImageDataUrl('')
      setNextImageDataUrl('')
      pageImageCacheRef.current.clear()
      if (doc?.file_path && String(doc.file_path).toLowerCase().endsWith('.pdf')) {
        releaseCachedPdfDocument(doc.file_path)
      }
    }
    setDocumentMode(nextMode)
    const nextState = nextMode === 'proof'
      ? buildProofReaderState(syncedPageIndex)
      : buildPageReaderState(syncedPageIndex)
    if (nextState && readerStateReady) saveReaderStateNow(nextState)
  }

  const handleRerunCurrentPageOcr = async () => {
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
      message.success('已重新识别本页 OCR')
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
        await handleSavePage(currentPage.id, { proof_status: 'pending' })
        message.success('已取消本页校对完成')
      } else {
        await handleSavePage(currentPage.id, {
          proof_status: 'completed',
          proofed_text: currentPage.proofed_text || currentPage.ocr_text || '',
        })
        message.success('已标记本页校对完成')
      }
    } catch (error) {
      console.error(error)
      message.error('更新校对状态失败')
    }
  }

  const handleExport: MenuProps['onClick'] = async (event) => {
    const format = event.key as DocumentExportFormat
    if (exportingDocument || !doc?.id) return
    setExportingDocument(true)
    message.loading({ content: '正在导出中，请稍候…', key: 'document-export', duration: 0 })
    try {
      const exportOptions: DocumentExportOptions | undefined = format === 'reading-pdf'
        ? {
            readingFontFamily: readerFontFamily,
            readingFontSize: readerFontSize,
            readingLineHeight: readerLineHeight,
            readingPageWidth: readerPageWidth,
            readingTheme: readerTheme,
            readingDisplayScript: readerDisplayScript,
          }
        : getFacsimileExportOptions(format)
      const success = await window.api.exportDocument(doc.id, format, exportOptions)
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
    const citationPageNum = getCitationPageNumber(currentPage, internalPageNum)
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
    const updated = await window.api.updateTranslationUnit(unitId, {
      translationText,
      manualOverride: true,
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
  }, [])

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
  }, [focusReaderSearch, getReaderSearchInput, handleBack, navigateShortcutPage, resetReaderViewScale, scrollReaderContent, shortcuts, toggleReaderTranslation])

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
  const readerThemeStyle = {
    paper: { shell: '#1c1712', page: '#fffaf0', text: '#24190f', muted: '#8a6a3c' },
    sepia: { shell: '#21180f', page: '#f2e0bd', text: '#2d2115', muted: '#8a6534' },
    dark: { shell: '#101112', page: '#1f2226', text: '#e8e2d8', muted: '#9a8f80' },
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
                <span>{renderMarkedSnippet(snippet, match.keyword || effectiveSearchKeyword, readerDisplayScript)}</span>
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
            { value: 'search', label: `检索结果${readerSearchMatches.length ? ` ${readerSearchMatches.length}` : ''}` },
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
          return (
            <div
              key={page.id}
              onClick={handleReaderPageClick(index === 0 ? 'left' : 'right')}
              style={{
                background: readerThemeStyle.page,
                color: readerThemeStyle.text,
                borderRadius: 6,
                padding: '34px 38px',
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
              <div style={{ color: readerThemeStyle.muted, fontSize: 12, marginBottom: 18, textAlign: 'center', userSelect: 'none' }}>
                阅读页 {readerPageIndex + index + 1} / {readerVirtualPageCount} · 原页 {page.sourcePageNum}{page.segmentIndex > 0 ? `-${page.segmentIndex + 1}` : ''}
              </div>
              {renderBookText(page.text, effectiveSearchKeyword, readerDisplayScript, currentMatchIndex, pageHitStartIndex)}
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
            .map((item, index) => (
            <button
              key={item.page.id}
              type="button"
              onClick={() => setCurrentPageIndex((value) => clampPageIndex(value + (index === 0 ? -2 : 2), pageCount))}
              style={{
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
                <img src={item.src} alt={`第 ${item.page.page_num} 页`} style={{ maxWidth: '100%', maxHeight: readerSpreadPageHeight, objectFit: 'contain', display: 'block' }} />
              ) : (
                <Spin />
              )}
            </button>
          ))}
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
            onChange={(value) => void switchDocumentMode(value as DocumentMode)}
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
          {isTextOnlyPdf ? (
            <Space.Compact size="small">
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
              bookTranslationRequest={readerBookTranslationRequest}
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
                setReaderFullSearchRequested(true)
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
            bookTranslationRequest={readerBookTranslationRequest}
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
              <Input
                data-reader-search-input="true"
                size="small"
                placeholder="搜索正文"
                prefix={<SearchOutlined style={{ color: searchFocused && effectiveSearchKeyword ? 'var(--gs-gold)' : 'rgba(255,255,255,0.25)' }} />}
                value={localSearchKeyword}
                onChange={(event) => {
                  setReaderFullSearchRequested(true)
                  setLocalSearchKeyword(event.target.value)
                }}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onPressEnter={handleSearchNext}
                allowClear
                style={{
                  width: 220,
                  background: searchFocused && effectiveSearchKeyword ? 'rgba(255,192,105,0.1)' : 'rgba(255,255,255,0.04)',
                  borderColor: searchFocused && effectiveSearchKeyword ? '#ffc069' : 'rgba(255,255,255,0.12)',
                }}
              />
              <Button size="small" icon={<LeftOutlined />} onClick={handleSearchPrev} disabled={readerSearchMatches.length === 0} />
              <span data-reader-search-counter="true" style={{ fontSize: 12, color: 'var(--gs-text-secondary)', minWidth: 56, textAlign: 'center' }}>
                {effectiveSearchKeyword ? `${readerSearchMatches.length ? Math.max(1, currentMatchIndex + 1) : 0}/${readerSearchMatches.length}` : '0/0'}
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
            ) : shouldShowBookPreview ? (
              <div style={{ height: '100%', padding: 24, background: '#1c1712', overflow: 'auto' }}>
                <div
                  style={{
                    minHeight: '100%',
                    display: 'grid',
                    gridTemplateColumns: nextSpreadPage ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 720px)',
                    justifyContent: 'center',
                    gap: 18,
                    alignItems: 'stretch',
                  }}
                >
                  {[currentPage, nextSpreadPage].filter((page): page is DocumentViewPage => Boolean(page)).map((page) => {
                    const pageIndex = sortedPages.findIndex((item) => item.id === page.id)
                    const pageHitStartIndex = searchMatches.filter((match) => match.pageIndex < pageIndex).length
                    return (
                      <div
                        key={page.id}
                        onClick={() => setCurrentPageIndex(clampPageIndex(pageIndex, pageCount))}
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
                          minHeight: 620,
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ color: '#8a6a3c', fontSize: 12, marginBottom: 18, textAlign: 'center' }}>
                          第 {page.page_num} 页
                        </div>
                        {renderBookText(getPageReadingText(page), effectiveSearchKeyword, readerDisplayScript, currentMatchIndex, pageHitStartIndex)}
                      </div>
                    )
                  })}
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
              {facsimileProofCandidate ? <Tag color="purple">版式还原</Tag> : null}
            </Space>

            <Space size={4} wrap>
              {facsimileProofCandidate ? (
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
                <Button size="small" icon={<ScanOutlined />} loading={ocrProcessing} onClick={handleRerunCurrentPageOcr} disabled={!currentPage?.id}>
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
              <Input
                data-reader-search-input="true"
                size="small"
                placeholder="搜索本页文本"
                prefix={<SearchOutlined style={{ color: searchFocused && effectiveSearchKeyword ? 'var(--gs-gold)' : 'rgba(255,255,255,0.25)' }} />}
                value={localSearchKeyword}
                onChange={(event) => {
                  setReaderFullSearchRequested(true)
                  setLocalSearchKeyword(event.target.value)
                }}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                allowClear
                style={{
                  width: 180,
                  background: searchFocused && effectiveSearchKeyword ? 'rgba(255,192,105,0.1)' : 'rgba(255,255,255,0.04)',
                  borderColor: searchFocused && effectiveSearchKeyword ? '#ffc069' : 'rgba(255,255,255,0.12)',
                }}
              />
              {effectiveSearchKeyword && searchMatches.length > 0 ? (
                <>
                  <Button size="small" icon={<LeftOutlined />} onClick={handleSearchPrev} type="text" style={{ color: 'var(--gs-text-secondary)' }} />
                  <span data-reader-search-counter="true" style={{ fontSize: 12, color: 'var(--gs-text-secondary)', minWidth: 44, textAlign: 'center' }}>
                    {currentMatchIndex >= 0 ? currentMatchIndex + 1 : 1}/{searchMatches.length}
                  </span>
                  <Button size="small" icon={<RightOutlined />} data-reader-search-next="true" onClick={handleSearchNext} type="text" style={{ color: 'var(--gs-text-secondary)' }} />
                </>
              ) : null}
              {effectiveSearchKeyword && searchMatches.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--gs-text-tertiary)' }}>无命中</span>
              ) : null}
            </Space>
          </div>

          <div style={{ flex: 1, overflow: 'hidden', padding: 8 }}>
            {ocrProcessing ? (
              <div className="empty-state">
                <Spin tip="正在调用 PaddleOCR API..." />
              </div>
            ) : facsimileOcrResultObj && proofViewMode === 'facsimile' ? (
              <GujiFacsimileProofreader
                ocrResult={facsimileOcrResultObj}
                pageId={currentPage?.id || ''}
                pageImageSrc={imageDataUrl}
                pageProofStatus={currentPageProofStatus}
                activeBoxIndex={activeBoxIndex}
                activeSearchHitOrdinal={activeProofSearchHitOrdinal}
                searchKeyword={effectiveSearchKeyword}
                coordinateSourceSize={facsimileCoordinateSourceSize}
                preferVerticalLayout={shouldUseVerticalOcr}
                translationText={currentFacsimileTranslationText}
                translationUnits={currentPage?.id ? pageTranslationUnits[currentPage.id] || [] : []}
                translationLoading={currentPage?.id ? !!translatingPageIds[currentPage.id] : false}
                translationSkipped={currentFacsimileTranslationSkipped}
                translationOpen={facsimileTranslationOpen}
                translationMode={translationMode}
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
                onSave={handleSavePage}
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
                  if (mode === 'region' && isTextOnlyPdf) {
                    void handleRestorePdfAsset()
                  }
                }}
                onTextSelectionChange={setSelectedTextForAi}
                activeBoxIndex={activeTextEditorBoxIndex}
                onLineFocus={handleTextEditorLineFocus}
                switchToRegion={switchToRegion}
                onSwitchToRegionConsumed={() => setSwitchToRegion(false)}
                searchKeyword={effectiveSearchKeyword}
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
