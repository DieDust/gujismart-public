import { Children, cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Empty, Input, Modal, Pagination, Popover, Segmented, Select, Slider, Space, Spin, Switch, Typography, message } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import OpenCC from 'opencc-js'
import {
  BarsOutlined,
  CopyOutlined,
  DeleteOutlined,
  FileTextOutlined,
  LeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import ePub from 'epubjs'
import type { Document as LibraryDocument, DocumentPage, ReaderTranslationOptions, ReaderTranslationPayload, ResearchNote, ResearchProject, SearchHitLocator, SearchSessionState, TocItemV2, TranslationMode, TranslationUnitV1 } from '@shared/types'
import { getCitationPageNumber, getReadablePageElements, getReadablePageText, normalizeOcrTextForReading, type ReadablePageElement } from '../utils/ocrText'
import { buildDirectQuoteCitationText, resolveDocumentCitation } from '../utils/citations'
import { getErrorMessage } from '@shared/errors'
import { legacySearchLocatorFromUnknown } from '@shared/stable-reader-locator'
import ParallelTranslationView from './ParallelTranslationView'
import LlmProfileSelector from './LlmProfileSelector'
import AiMarkdown from './AiMarkdown'
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLOR_OPTIONS,
  getHighlightTextColor,
  hexToRgba,
  normalizeHighlightColor,
} from '../utils/highlightColors'

const { Text } = Typography
const READER_SEARCH_RESULT_PAGE_SIZE = 10
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })

type ReaderTheme = 'paper' | 'sepia' | 'dark'
type ReaderDisplayScript = 'original' | 'simplified' | 'traditional'
type ViewMode = 'single' | 'spread'
type ReaderSidebarTab = 'toc' | 'search'
type TocNode = {
  id: string
  label: string
  href: string
  level: number
  subitems?: TocNode[]
}
type TextPage = {
  id: string
  pageIndex: number
  sourcePageNum: number
  sourcePage?: EbookPage
  title: string
  text: string
  href?: string
}
type TextSearchHit = { pageIndex: number; sourcePageNum: number; charIndex: number; occurrenceIndex: number; globalIndex: number }
type EpubSearchHit = {
  cfi: string
  excerpt: string
  href: string
  sectionIndex: number
  segmentId: string
  charStart: number
  occurrenceIndex: number
  globalIndex: number
}
type SearchDirectoryItem = {
  index: number
  key: string
  pageLabel: string
  snippet: string
  active: boolean
}
type ReaderNoteItem = Pick<ResearchNote, 'id' | 'doc_id' | 'page_num' | 'excerpt' | 'note' | 'kind' | 'color' | 'locator_json' | 'source_id' | 'created_at' | 'updated_at'>
type ReaderNoteHighlight = {
  noteId: string
  text: string
  color: string
  localCharStart: number
  localCharEnd: number
  occurrenceIndex: number
}
type ReaderSelectionState = {
  text: string
  x: number
  y: number
  pageIndex: number
  charStart: number
  charEnd: number
  occurrenceIndex: number
}
type ReaderNoteMenuState = {
  noteId: string
  x: number
  y: number
}
type SelectionMouseEvent = import('react').MouseEvent<HTMLElement>
type JsonRecord = Record<string, unknown>
type EpubLocation = {
  start?: {
    href?: unknown
    index?: unknown
    cfi?: unknown
    percentage?: unknown
    displayed?: {
      page?: unknown
      total?: unknown
    }
  }
}
type EbookPage = Partial<DocumentPage> & {
  title?: string | null
}
type EpubSpineItem = JsonRecord & {
  href?: string
  url?: string
  canonical?: string
  cfiBase?: string
  linear?: boolean
  index?: number
  load?: (loader: unknown) => Promise<unknown>
  unload?: () => void
  search?: (query: string) => Array<{ cfi?: unknown; excerpt?: unknown }>
  find?: (query: string) => Array<{ cfi?: unknown; excerpt?: unknown }>
}
type EpubContent = {
  document?: globalThis.Document
  window?: Window
}
type EpubRendition = JsonRecord & {
  display: (target?: string) => Promise<unknown>
  on: (eventName: string, handler: (payload: unknown) => void) => void
  prev?: () => Promise<unknown>
  next?: () => Promise<unknown>
  destroy?: () => void
  themes: {
    register: (name: string, rules: JsonRecord) => void
    select: (name: string) => void
    fontSize: (value: string) => void
    override: (property: string, value: string) => void
  }
  hooks: {
    content: {
      register: (handler: (contents: EpubContent) => void) => void
    }
  }
  getContents?: () => EpubContent | EpubContent[]
  annotations?: {
    remove?: (cfi: string, type: string) => void
    highlight?: (
      cfi: string,
      data: JsonRecord,
      callback: undefined,
      className: string,
      styles: JsonRecord,
    ) => void
  }
  spread?: (value: string) => void
  resize?: () => void
}
type EpubBook = JsonRecord & {
  ready?: Promise<unknown>
  loaded?: {
    navigation?: Promise<{ toc?: unknown[] }>
  }
  rendition?: {
    location?: EpubLocation
  }
  spine?: {
    spineItems?: unknown[]
    items?: unknown[]
    _items?: unknown[]
  }
  renderTo: (element: HTMLElement, options: JsonRecord) => EpubRendition
  load: (href: string) => Promise<unknown>
  destroy?: () => void
  navigation?: {
    toc?: unknown[]
  }
}

interface EbookReaderProps {
  document: Partial<LibraryDocument>
  pages: EbookPage[]
  currentPageIndex: number
  searchKeyword?: string
  highlightColor?: string
  sourceLabel?: string
  initialLocationKey?: string
  locator?: SearchHitLocator
  searchSession?: SearchSessionState
  pageTranslations?: Record<string, string>
  pageTranslationUnits?: Record<string, TranslationUnitV1[]>
  translatingPageIds?: Record<string, boolean>
  skippedTranslationPageIds?: Record<string, boolean>
  translationGlossaryProjectId?: string
  translationGlossaryProjects?: ResearchProject[]
  selectedTextForGlossary?: string
  displayScript?: ReaderDisplayScript
  bookTranslationRequest?: number
  translationMode?: TranslationMode
  onDisplayScriptChange?: (script: ReaderDisplayScript) => void
  onPageIndexChange: (pageIndex: number) => void
  onSearchKeywordChange?: (keyword: string) => void
  onSelectedTextChange?: (text: string) => void
  onContextTextChange?: (text: string) => void
  onTranslateCurrentPage?: (payload: ReaderTranslationPayload, options?: ReaderTranslationOptions) => void
  onTranslationModeChange?: (mode: TranslationMode) => void
  onUpdateTranslationUnit?: (pageId: string, unitId: string, translationText: string) => Promise<void> | void
  onRetranslateTranslationUnit?: (payload: ReaderTranslationPayload, unitId: string) => Promise<void> | void
  onTranslationGlossaryProjectChange?: (projectId: string) => void
  onAddSelectedTerm?: () => void
  onReaderStateChange?: (state: {
    location_key: string
    progress: number
    view_mode: ViewMode
    font_size: number
    line_height: number
    theme: ReaderTheme
  }) => void
}

const themeStyles = {
  paper: { shell: '#1d1712', page: '#fff8e9', text: '#382718', muted: '#9c7d57', border: 'rgba(120,80,42,0.2)' },
  sepia: { shell: '#17130f', page: '#f4ead5', text: '#3b2c1e', muted: '#8d6e4c', border: 'rgba(120,80,42,0.24)' },
  dark: { shell: '#0f1114', page: '#171a1f', text: '#d8d3c8', muted: '#8d9096', border: 'rgba(255,255,255,0.1)' },
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecordValue(source: unknown, key: string): unknown {
  return isJsonRecord(source) ? source[key] : undefined
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

function parseMetadata(doc: Partial<LibraryDocument> | null | undefined): JsonRecord {
  const parsed = parseMaybeJson(doc?.metadata, {})
  return isJsonRecord(parsed) ? parsed : {}
}

export function isManagedTextDocument(document: Partial<LibraryDocument> | null | undefined, pages: EbookPage[] = []): boolean {
  const metadata = parseMetadata(document)
  const manifest = readRecordValue(metadata, 'ebook_manifest')
  const filePath = String(document?.file_path || readRecordValue(metadata, 'original_file_name') || readRecordValue(metadata, 'source_file_name') || '').toLowerCase()
  const ext = filePath.match(/\.[a-z0-9]+$/)?.[0] || String(readRecordValue(metadata, 'file_ext') || '').toLowerCase()
  if (['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(ext) || readRecordValue(metadata, 'file_kind') === 'pdf') return false
  if (ext === '.epub' || ext === '.txt' || ext === '.md' || ext === '.markdown') return true
  if (readRecordValue(metadata, 'file_kind') === 'ebook' || readRecordValue(metadata, 'file_kind') === 'text') return true
  if (readRecordValue(metadata, 'import_source_type') === 'epub' || readRecordValue(manifest, 'format') === 'epub') return true
  return false
}

function isEpubDocument(document: Partial<LibraryDocument>): boolean {
  const metadata = parseMetadata(document)
  return readRecordValue(metadata, 'file_kind') === 'ebook'
    || readRecordValue(metadata, 'import_source_type') === 'epub'
    || readRecordValue(readRecordValue(metadata, 'ebook_manifest'), 'format') === 'epub'
    || String(document?.file_path || '').toLowerCase().endsWith('.epub')
}

function normalizeHref(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^OEBPS\//i, '')
    .replace(/^OPS\//i, '')
}

function stripHash(value: string): string {
  return normalizeHref(value).split('#')[0]
}

function getHash(value: string): string {
  const hash = String(value || '').split('#').slice(1).join('#')
  return hash ? `#${hash}` : ''
}

function getFragment(value: string): string {
  const raw = String(value || '').split('#').slice(1).join('#')
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function sameHrefPath(left: string, right: string): boolean {
  const leftPath = stripHash(left)
  const rightPath = stripHash(right)
  if (!leftPath || !rightPath) return false
  return leftPath === rightPath || leftPath.endsWith(rightPath) || rightPath.endsWith(leftPath)
}

function getSpineItems(book: EpubBook | null | undefined): EpubSpineItem[] {
  const items = book?.spine?.spineItems || book?.spine?.items || book?.spine?._items || []
  return Array.isArray(items) ? items.filter(isJsonRecord).map((item) => item as EpubSpineItem) : []
}

function buildEpubDisplayCandidates(book: EpubBook, target?: string | null): string[] {
  const raw = String(target || '').trim()
  const hash = getHash(raw)
  const normalized = normalizeHref(raw)
  const normalizedPath = stripHash(normalized)
  const candidates = [raw, normalized]

  if (normalizedPath) {
    candidates.push(`${normalizedPath}${hash}`)
  }

  const spineItems = getSpineItems(book)
  for (const item of spineItems) {
    const href = String(item?.href || item?.url || '')
    const normalizedHref = normalizeHref(href)
    const hrefPath = stripHash(normalizedHref)
    if (!hrefPath || !normalizedPath) continue
    if (hrefPath === normalizedPath || normalizedPath.endsWith(hrefPath) || hrefPath.endsWith(normalizedPath)) {
      candidates.push(`${hrefPath}${hash}`)
      candidates.push(href)
      if (item?.canonical) candidates.push(String(item.canonical))
      if (item?.cfiBase) candidates.push(String(item.cfiBase))
    }
  }

  return [...new Set(candidates.map((item) => String(item || '').trim()).filter(Boolean))]
}

async function displayEpubTarget(rendition: EpubRendition, book: EpubBook, target?: string | null): Promise<void> {
  const candidates = buildEpubDisplayCandidates(book, target)
  const displayWithTimeout = (candidate?: string) => Promise.race([
    candidate ? rendition.display(candidate) : rendition.display(),
    new Promise((_resolve, reject) => window.setTimeout(() => reject(new Error('EPUB 章节加载超时')), 8000)),
  ])
  for (const candidate of candidates) {
    try {
      await displayWithTimeout(candidate)
      return
    } catch (error: unknown) {
      const messageText = getErrorMessage(error, '')
      if (!messageText.includes('No Section') && !messageText.includes('章节加载超时')) throw error
    }
  }
  await displayWithTimeout()
}

function flattenToc(items: TocNode[]): TocNode[] {
  return items.flatMap((item) => [item, ...flattenToc(item.subitems || [])])
}

function findFragmentElement(doc: Document, fragment: string): HTMLElement | null {
  if (!fragment) return null
  const candidates = [fragment, fragment.replace(/^#/, '')].filter(Boolean)
  for (const id of candidates) {
    const byId = doc.getElementById(id)
    if (byId instanceof HTMLElement) return byId
    const named = doc.querySelector(`[name="${id.replace(/"/g, '\\"')}"]`)
    if (named instanceof HTMLElement) return named
  }
  return null
}

function findVisibleEpubTocId(rendition: EpubRendition, activeHref: string, items: TocNode[], fallbackId = ''): string {
  const samePathItems = items.filter((item) => sameHrefPath(item.href, activeHref))
  if (samePathItems.length === 0) return ''
  const contents = typeof rendition?.getContents === 'function' ? rendition.getContents() : []
  const contentList = Array.isArray(contents) ? contents : [contents].filter(Boolean)

  let best: { id: string; score: number } | null = null
  for (const content of contentList) {
    const doc = content.document
    const win = content.window || doc?.defaultView
    if (!doc || !win) continue
    const viewportWidth = Number(win.innerWidth || doc.documentElement?.clientWidth || 0)
    const viewportHeight = Number(win.innerHeight || doc.documentElement?.clientHeight || 0)
    for (const item of samePathItems) {
      const fragment = getFragment(item.href)
      if (!fragment) continue
      const element = findFragmentElement(doc, fragment)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      const horizontallyVisible = rect.right >= -16 && rect.left <= viewportWidth + 16
      const verticallyVisible = rect.bottom >= -16 && rect.top <= viewportHeight + 16
      if (!horizontallyVisible || !verticallyVisible) continue
      const score = Math.abs(rect.top - Math.max(24, viewportHeight * 0.08)) + Math.max(0, rect.left) * 0.04
      if (!best || score < best.score) best = { id: item.id, score }
    }
  }

  if (best) return best.id
  if (fallbackId && samePathItems.some((item) => item.id === fallbackId)) return fallbackId
  return samePathItems[0]?.id || fallbackId
}

function normalizeEpubToc(items: unknown[], level = 1): TocNode[] {
  return (items || []).map((item, index) => ({
    id: String(readRecordValue(item, 'id') || readRecordValue(item, 'href') || `${level}-${index}`),
    label: String(readRecordValue(item, 'label') || readRecordValue(item, 'title') || readRecordValue(item, 'text') || `章节 ${index + 1}`),
    href: String(readRecordValue(item, 'href') || ''),
    level,
    subitems: normalizeEpubToc(Array.isArray(readRecordValue(item, 'subitems')) ? readRecordValue(item, 'subitems') as unknown[] : [], level + 1),
  })).filter((item) => item.href || item.subitems?.length)
}

function tocV2ToNodes(items: TocItemV2[]): TocNode[] {
  return (items || []).map((item, index) => ({
    id: String(item.id || item.href || index),
    label: item.title || `章节 ${index + 1}`,
    href: item.href || `page:${item.source_page_num || index + 1}`,
    level: Math.max(1, Number(item.level || 1)),
  }))
}

function getPageHref(page: EbookPage): string {
  const parsed = parseMaybeJson(page?.ocr_result, {})
  return String(readRecordValue(readRecordValue(parsed, 'ebook'), 'href') || '')
}

function getInitialEpubTarget(pages: EbookPage[], currentPageIndex: number): string {
  const sorted = [...(pages || [])].sort((left, right) => Number(left?.page_num || 0) - Number(right?.page_num || 0))
  const page = sorted[Math.max(0, Math.min(sorted.length - 1, currentPageIndex || 0))]
  return getPageHref(page)
}

function buildTextPageSource(page: EbookPage): string {
  const parsed = parseMaybeJson(page?.ocr_result, {})
  const sourceType = String(readRecordValue(parsed, 'source_type') || '')
  const rawText = String(page?.ocr_text || page?.proofed_text || '').trim()
  if (rawText && (sourceType === 'ebook_section' || sourceType === 'ebook_text')) {
    return rawText
  }
  const elements = getReadablePageElements(page)
  return readableElementsToMarkdown(elements) || getReadablePageText(page).trim()
}

function buildTextPages(pages: EbookPage[]): TextPage[] {
  return [...(pages || [])]
    .sort((left, right) => Number(left?.page_num || 0) - Number(right?.page_num || 0))
    .map((page, index) => {
      const parsed = parseMaybeJson(page?.ocr_result, {})
      const ebookMeta = readRecordValue(parsed, 'ebook')
      const href = String(readRecordValue(ebookMeta, 'href') || `page:${page?.page_num || index + 1}`)
      const title = String(readRecordValue(ebookMeta, 'title') || page?.title || `第 ${page?.page_num || index + 1} 节`)
      return {
        id: String(page?.id || index),
        pageIndex: index,
        sourcePageNum: Number(page?.page_num || index + 1),
        sourcePage: page,
        title,
        text: buildTextPageSource(page),
        href,
      }
    })
    .filter((page) => page.text)
}

function getTextPageCitationPageNum(page: TextPage | null | undefined): number | null {
  if (!page) return null
  return getCitationPageNumber(page.sourcePage, page.sourcePageNum)
}

function buildReaderCitationText(title: string | null | undefined, pageNum: number | null): string {
  return `${title || '未命名文献'}${pageNum ? `，第 ${pageNum} 页` : ''}`
}

function findTextMatches(pages: TextPage[], keyword: string): TextSearchHit[] {
  const query = normalizeSelectionText(keyword)
  if (!query) return []
  const hits: TextSearchHit[] = []
  pages.forEach((page, pageIndex) => {
    findNormalizedOffsets(page.text, query).forEach((offset, occurrenceIndex) => {
      hits.push({ pageIndex, sourcePageNum: page.sourcePageNum, charIndex: offset, occurrenceIndex, globalIndex: hits.length })
    })
  })
  return hits
}

function getLocatorPageNum(locator?: SearchHitLocator | null): number {
  if (!locator) return -1
  const pageNum = Number(locator.pageNum)
  if (Number.isFinite(pageNum) && pageNum > 0) return pageNum
  return -1
}

function getLocatorPageIndex(locator?: SearchHitLocator | null): number {
  const rawValue = locator?.pageIndex
  if (rawValue === null || rawValue === undefined) return -1
  const pageIndex = Number(rawValue)
  return Number.isFinite(pageIndex) && pageIndex >= 0 ? Math.floor(pageIndex) : -1
}

function findTextHitIndexByLocator(hits: TextSearchHit[], locator?: SearchHitLocator | null): number {
  if (!hits.length || !locator) return -1
  const targetPageIndex = getLocatorPageIndex(locator)
  const targetPageNum = getLocatorPageNum(locator)
  const samePageHits = hits.filter((hit) => {
    if (targetPageIndex >= 0) return hit.pageIndex === targetPageIndex
    if (targetPageNum >= 0) return hit.sourcePageNum === targetPageNum
    return false
  })
  if (samePageHits.length > 0) {
    const targetChar = Math.max(0, Number(locator.charStart || 0))
    const byChar = samePageHits
      .map((hit) => ({ hit, distance: Math.abs(Number(hit.charIndex || 0) - targetChar) }))
      .sort((left, right) => left.distance - right.distance)[0]?.hit
    if (byChar) return byChar.globalIndex
    const occurrenceIndex = Math.max(0, Number(locator.occurrenceIndex || 0))
    const occurrenceHit = samePageHits[Math.min(samePageHits.length - 1, occurrenceIndex)]
    if (occurrenceHit) return occurrenceHit.globalIndex
    return samePageHits[0].globalIndex
  }
  return -1
}

function findTextPageIndexByLocator(textPages: TextPage[], locator?: SearchHitLocator | null): number {
  if (!textPages.length || !locator) return -1
  const pageId = String(locator.pageId || '')
  if (pageId) {
    const pageIdIndex = textPages.findIndex((page) => String(page.id || '') === pageId)
    if (pageIdIndex >= 0) return pageIdIndex
  }
  const targetPageIndex = getLocatorPageIndex(locator)
  if (targetPageIndex >= 0 && targetPageIndex < textPages.length) {
    return targetPageIndex
  }
  const href = String(locator.href || '')
  if (href) {
    const hrefIndex = textPages.findIndex((page) => sameHrefPath(page.href || '', href))
    if (hrefIndex >= 0) return hrefIndex
  }
  const targetPageNum = getLocatorPageNum(locator)
  if (targetPageNum >= 0) {
    const pageNumIndex = textPages.findIndex((page) => Number(page.sourcePageNum) === targetPageNum)
    if (pageNumIndex >= 0) return pageNumIndex
  }
  return -1
}

function findInitialTextSearchIndex(hits: TextSearchHit[], locator?: SearchHitLocator | null, searchSession?: SearchSessionState): number {
  if (!hits.length) return -1
  const sessionIndex = Number(searchSession?.activeHitIndex)
  const sessionHit = Number.isFinite(sessionIndex) && sessionIndex >= 0 ? searchSession?.hits?.[sessionIndex] : null
  const target = locator || sessionHit?.locator || null
  const targetHitIndex = findTextHitIndexByLocator(hits, target)
  if (targetHitIndex >= 0) {
    return targetHitIndex
  }

  if (Number.isFinite(sessionIndex) && sessionIndex >= 0) return Math.min(hits.length - 1, sessionIndex)
  return 0
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const next = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(next) ? next : fallback
}

function asSearchHitLocator(value: unknown): SearchHitLocator | null {
  if (isJsonRecord(value) && readRecordValue(value, 'schemaVersion') === 'stable-reader-locator/v2') {
    return legacySearchLocatorFromUnknown(value)
  }
  if (!isJsonRecord(value)) return null
  const matchText = String(readRecordValue(value, 'matchText') || readRecordValue(value, 'queryTerm') || '').trim()
  const charStart = Math.max(0, toFiniteNumber(readRecordValue(value, 'charStart'), 0))
  const charEnd = Math.max(charStart, toFiniteNumber(readRecordValue(value, 'charEnd'), charStart + matchText.length))
  return {
    docId: String(readRecordValue(value, 'docId') || ''),
    segmentId: String(readRecordValue(value, 'segmentId') || ''),
    sourceType: String(readRecordValue(value, 'sourceType') || ''),
    pageId: readRecordValue(value, 'pageId') == null ? null : String(readRecordValue(value, 'pageId')),
    pageNum: readRecordValue(value, 'pageNum') == null ? null : toFiniteNumber(readRecordValue(value, 'pageNum'), 0),
    pageIndex: readRecordValue(value, 'pageIndex') == null ? null : toFiniteNumber(readRecordValue(value, 'pageIndex'), 0),
    href: readRecordValue(value, 'href') == null ? null : String(readRecordValue(value, 'href')),
    locationKey: String(readRecordValue(value, 'locationKey') || ''),
    segmentOrdinal: Math.max(0, toFiniteNumber(readRecordValue(value, 'segmentOrdinal'), 0)),
    charStart,
    charEnd,
    normalizedCharStart: readRecordValue(value, 'normalizedCharStart') == null ? undefined : toFiniteNumber(readRecordValue(value, 'normalizedCharStart'), charStart),
    normalizedCharEnd: readRecordValue(value, 'normalizedCharEnd') == null ? undefined : toFiniteNumber(readRecordValue(value, 'normalizedCharEnd'), charEnd),
    matchText,
    queryTerm: String(readRecordValue(value, 'queryTerm') || matchText),
    occurrenceIndex: Math.max(0, toFiniteNumber(readRecordValue(value, 'occurrenceIndex'), 0)),
  }
}

function getReaderNoteLocator(note: ReaderNoteItem): SearchHitLocator | null {
  const directLocator = asSearchHitLocator(parseMaybeJson(note.locator_json, null))
  if (directLocator) return directLocator
  const source = parseMaybeJson(note.source_id, {})
  return asSearchHitLocator(readRecordValue(source, 'locator'))
}

function getSourceString(source: JsonRecord | null | undefined, key: string): string {
  return String(source ? readRecordValue(source, key) || '' : '').trim()
}

function getReaderNoteHighlightText(note: ReaderNoteItem, locator: SearchHitLocator | null = getReaderNoteLocator(note)): string {
  const source = parseMaybeJson(note.source_id, {})
  const sourceRecord = isJsonRecord(source) ? source : null
  return [
    locator?.matchText,
    locator?.queryTerm,
    getSourceString(sourceRecord, 'searchKeyword'),
    getSourceString(sourceRecord, 'matchedQuery'),
    note.excerpt,
  ].map((value) => getExcerptHighlightText(String(value || ''))).find(Boolean) || ''
}

function getReaderNoteDate(value?: string | null): string {
  const timestamp = Date.parse(value || '')
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
}

function buildReaderNotesContext(notes: ReaderNoteItem[], activePageNum?: number | null, activePageIndex = 0): string {
  if (!notes.length) return ''
  const currentPageNum = Number(activePageNum || activePageIndex + 1)
  const ranked = notes
    .map((note, index) => {
      const pageNum = Number(note.page_num || 0)
      const distance = pageNum > 0 && Number.isFinite(currentPageNum) ? Math.abs(pageNum - currentPageNum) : 9999
      return { note, index, distance }
    })
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
    .slice(0, 8)
  return [
    '【本书摘录优先上下文】',
    ...ranked.map(({ note }) => {
      const locator = getReaderNoteLocator(note)
      const text = getReaderNoteHighlightText(note, locator) || note.excerpt
      const pageLabel = note.page_num ? `第${note.page_num}页` : '未分页'
      return `- ${pageLabel}：${String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`
    }),
  ].join('\n')
}

function getSearchSessionStateKey(session?: SearchSessionState | null): string {
  if (!session?.hits?.length) return ''
  const hitKeys = session.hits
    .map((hit, index) => `${index}:${hit.id}:${hit.locator?.pageId || ''}:${hit.locator?.href || ''}:${hit.locator?.pageNum || ''}:${hit.locator?.pageIndex ?? ''}:${hit.locator?.segmentOrdinal ?? ''}:${hit.locator?.charStart ?? ''}:${hit.locator?.queryTerm || hit.locator?.matchText || ''}`)
    .join('|')
  return `${session.query || ''}:${session.activeHitIndex}:${session.status}:${hitKeys}`
}

function getSearchLocatorKey(locator?: SearchHitLocator | null): string {
  if (!locator) return ''
  return [
    locator.docId || '',
    locator.segmentId || '',
    locator.pageId || '',
    locator.pageNum ?? '',
    locator.pageIndex ?? '',
    locator.normalizedCharStart ?? '',
    locator.charStart ?? '',
    locator.occurrenceIndex ?? '',
    locator.queryTerm || locator.matchText || '',
  ].join('|')
}

function doSearchLocatorsMatch(left?: SearchHitLocator | null, right?: SearchHitLocator | null): boolean {
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
  const leftPageIndex = getLocatorPageIndex(left)
  const rightPageIndex = getLocatorPageIndex(right)
  if (leftPageIndex >= 0 && rightPageIndex >= 0 && leftPageIndex !== rightPageIndex) return false
  const leftPageNum = getLocatorPageNum(left)
  const rightPageNum = getLocatorPageNum(right)
  if (leftPageNum >= 0 && rightPageNum >= 0 && leftPageNum !== rightPageNum) return false
  const leftNormalized = Number(left.normalizedCharStart)
  const rightNormalized = Number(right.normalizedCharStart)
  if (Number.isFinite(leftNormalized) && Number.isFinite(rightNormalized)) return Math.abs(leftNormalized - rightNormalized) <= 2
  const leftChar = Number(left.charStart)
  const rightChar = Number(right.charStart)
  if (Number.isFinite(leftChar) && Number.isFinite(rightChar)) return Math.abs(leftChar - rightChar) <= 2
  return Number(left.occurrenceIndex) === Number(right.occurrenceIndex)
}

function findSessionHitIndexByLocator(session: SearchSessionState | undefined, locator?: SearchHitLocator | null): number {
  if (!session?.hits?.length || !locator) return -1
  return session.hits.findIndex((hit) => doSearchLocatorsMatch(hit.locator, locator))
}

function findSessionHitIndexByPage(sessionHits: SearchSessionState['hits'], textPages: TextPage[], pageIndex: number): number {
  if (!sessionHits.length || pageIndex < 0) return -1
  return sessionHits.findIndex((hit) => findTextPageIndexByLocator(textPages, hit.locator) === pageIndex)
}

function findNormalizedRanges(source: string, query: string): Array<{ start: number; end: number }> {
  const normalizedQuery = normalizeSelectionText(query).toLowerCase()
  if (!normalizedQuery) return []
  const sourceMap = buildNormalizedOffsetMap(source)
  const normalizedSource = sourceMap.normalized.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = normalizedSource.indexOf(normalizedQuery)
  while (cursor >= 0) {
    const start = sourceMap.offsets[cursor] ?? cursor
    const end = (sourceMap.offsets[cursor + normalizedQuery.length - 1] ?? start) + 1
    ranges.push({ start, end })
    cursor = normalizedSource.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
    if (ranges.length >= 20000) break
  }
  return ranges
}

function chooseReaderNoteHighlightRange(text: string, highlight: ReaderNoteHighlight): { start: number; end: number } | null {
  const source = String(text || '')
  const ranges = findNormalizedRanges(source, highlight.text)
  const targetStart = Math.max(0, Number(highlight.localCharStart || 0))
  if (ranges.length) {
    const occurrenceRange = ranges[Math.max(0, Math.min(ranges.length - 1, Number(highlight.occurrenceIndex || 0)))]
    const nearestRange = ranges
      .map((range) => ({ range, distance: Math.abs(range.start - targetStart) }))
      .sort((left, right) => left.distance - right.distance)[0]?.range
    if (!occurrenceRange) return nearestRange || null
    if (!nearestRange) return occurrenceRange
    const tolerance = Math.max(12, Math.min(120, String(highlight.text || '').length * 2))
    return Math.abs(occurrenceRange.start - targetStart) <= tolerance ? occurrenceRange : nearestRange
  }
  const fallbackEnd = Math.max(targetStart, Number(highlight.localCharEnd || targetStart))
  if (targetStart < source.length && fallbackEnd > targetStart) {
    return { start: targetStart, end: Math.min(source.length, fallbackEnd) }
  }
  return null
}

function renderReaderNoteHighlightedText(
  text: string,
  highlights: ReaderNoteHighlight[] = [],
  displayScript: ReaderDisplayScript = 'original',
  keyPrefix = 'ebook-note',
) {
  if (!highlights.length) return transformReaderDisplayText(String(text || ''), displayScript)
  const source = transformReaderDisplayText(String(text || ''), displayScript)
  const ranges = highlights
    .map((highlight) => {
      const displayHighlight: ReaderNoteHighlight = {
        ...highlight,
        text: transformReaderDisplayText(highlight.text, displayScript),
      }
      const range = chooseReaderNoteHighlightRange(source, displayHighlight)
      return range ? { ...range, highlight } : null
    })
    .filter(Boolean) as Array<{ start: number; end: number; highlight: ReaderNoteHighlight }>
  if (!ranges.length) return source

  const normalizedRanges: Array<{ start: number; end: number; highlight: ReaderNoteHighlight }> = []
  ranges
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .forEach((range) => {
      const previous = normalizedRanges[normalizedRanges.length - 1]
      if (previous && range.start < previous.end) return
      if (range.end > range.start) normalizedRanges.push(range)
    })

  const nodes: ReactNode[] = []
  let cursor = 0
  normalizedRanges.forEach((range, index) => {
    if (range.start > cursor) nodes.push(source.slice(cursor, range.start))
    const markColor = normalizeHighlightColor(range.highlight.color)
    nodes.push(
      <mark
        key={`${keyPrefix}-${range.highlight.noteId}-${range.start}-${index}`}
        data-reader-note-highlight="true"
        data-reader-note-id={range.highlight.noteId}
        title="点击管理摘录"
        style={{
          background: hexToRgba(markColor, 0.62),
          color: getHighlightTextColor(markColor),
          padding: '0 2px',
          borderRadius: 3,
          border: `1px solid ${hexToRgba(markColor, 0.42)}`,
          boxShadow: `0 0 0 1px ${hexToRgba(markColor, 0.12)}`,
          fontWeight: 600,
        }}
      >
        {source.slice(range.start, range.end)}
      </mark>,
    )
    cursor = range.end
  })
  if (cursor < source.length) nodes.push(source.slice(cursor))
  return nodes
}

function getNodeReaderNoteHighlights(highlights: ReaderNoteHighlight[], nodeStart: number, nodeLength: number): ReaderNoteHighlight[] {
  if (!highlights.length || nodeLength <= 0) return []
  const nodeEnd = nodeStart + nodeLength
  return highlights
    .filter((highlight) => highlight.localCharStart < nodeEnd && highlight.localCharEnd > nodeStart)
    .map((highlight) => ({
      ...highlight,
      localCharStart: Math.max(0, highlight.localCharStart - nodeStart),
      localCharEnd: Math.min(nodeLength, highlight.localCharEnd - nodeStart),
    }))
}

function buildReaderNoteHighlightsByPage(notes: ReaderNoteItem[], textPages: TextPage[]): Map<number, ReaderNoteHighlight[]> {
  const map = new Map<number, ReaderNoteHighlight[]>()
  notes.forEach((note) => {
    if (note.kind !== 'quote') return
    const locator = getReaderNoteLocator(note)
    const text = getReaderNoteHighlightText(note, locator)
    if (!locator || !text) return
    const pageIndex = findTextPageIndexByLocator(textPages, locator)
    if (pageIndex < 0 || pageIndex >= textPages.length) return
    const page = textPages[pageIndex]
    const locatorCharStart = Math.max(0, Number(locator.charStart || 0))
    const ranges = findNormalizedRanges(page.text, text)
    const chosen = ranges.length
      ? ranges
        .map((range, index) => ({ range, index, distance: Math.abs(range.start - locatorCharStart) }))
        .sort((left, right) => left.distance - right.distance || left.index - right.index)[0]
      : null
    const localCharStart = chosen?.range.start ?? locatorCharStart
    const localCharEnd = chosen?.range.end ?? Math.max(localCharStart + text.length, Number(locator.charEnd || 0))
    const highlight: ReaderNoteHighlight = {
      noteId: note.id,
      text,
      color: normalizeHighlightColor(note.color),
      localCharStart,
      localCharEnd,
      occurrenceIndex: chosen?.index ?? Math.max(0, Number(locator.occurrenceIndex || 0)),
    }
    const list = map.get(pageIndex)
    if (list) list.push(highlight)
    else map.set(pageIndex, [highlight])
  })
  map.forEach((highlights) => {
    highlights.sort((left, right) => left.localCharStart - right.localCharStart || left.localCharEnd - right.localCharEnd)
  })
  return map
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
    const markdownTable = [
      `| ${header.map(escapeCell).join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
    ].join('\n')
    return `\n\n${markdownTable}\n\n`
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

function readableElementsToMarkdown(elements: ReadablePageElement[]): string {
  return (elements || [])
    .map((element) => {
      if (element.type === 'table' && element.rows?.length) return tableRowsToHtml(element.rows)
      return String(element.text || '').trim()
    })
    .filter(Boolean)
    .join('\n\n')
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
    .replace(/\\[a-zA-Z]+/g, (match) => match.slice(1))
    .replace(/[{}]/g, '')
    .trim()
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

function transformReaderDisplayText(text: string, script: ReaderDisplayScript = 'original'): string {
  if (script === 'simplified') return toSimplified(text)
  if (script === 'traditional') return toTraditional(text)
  return text
}

function highlightText(
  text: string,
  keyword: string,
  activeIndex = -1,
  cursorState = { value: 0 },
  displayIndexByLocalIndex?: Map<number, number>,
  highlightColor = DEFAULT_HIGHLIGHT_COLOR,
  activeOnly = false,
) {
  const query = normalizeSelectionText(keyword)
  if (!query) return text
  const sourceMap = buildNormalizedOffsetMap(text)
  const lower = sourceMap.normalized.toLowerCase()
  const needle = normalizeSelectionText(query).toLowerCase()
  if (!needle) return text
  const nodes: ReactNode[] = []
  const markColor = normalizeHighlightColor(highlightColor)
  let cursor = 0
  let index = 0
  let normalizedCursor = 0
  let hit = lower.indexOf(needle, normalizedCursor)
  while (hit >= 0) {
    const originalStart = sourceMap.offsets[hit] ?? hit
    const originalEnd = (sourceMap.offsets[hit + needle.length - 1] ?? originalStart) + 1
    if (originalStart > cursor) nodes.push(text.slice(cursor, originalStart))
    const global = cursorState.value
    const displayIndex = displayIndexByLocalIndex?.get(global) ?? global
    const active = displayIndex === activeIndex
    if (activeOnly && !active) {
      nodes.push(text.slice(originalStart, originalEnd))
      cursor = originalEnd
      cursorState.value += 1
      index += 1
      normalizedCursor = hit + Math.max(1, needle.length)
      hit = lower.indexOf(needle, normalizedCursor)
      continue
    }
    const activeColor = markColor.toLowerCase() === DEFAULT_HIGHLIGHT_COLOR
      ? '#ffb020'
      : markColor
    nodes.push(
        <mark
        key={`${hit}-${index}`}
        data-ebook-search-hit={displayIndex}
        data-search-hit-index={displayIndex}
        data-search-active={active ? 'true' : undefined}
        style={{
          background: active ? activeColor : hexToRgba(markColor, 0.56),
          color: getHighlightTextColor(markColor),
          padding: '0 2px',
          borderRadius: 3,
          fontWeight: 700,
          position: 'relative',
          zIndex: active ? 3 : 0,
          border: `1px solid ${active ? 'rgba(120, 53, 15, 0.92)' : hexToRgba(markColor, 0.28)}`,
          outline: active ? '2px solid rgba(255, 255, 255, 0.88)' : 'none',
          outlineOffset: 0,
          boxShadow: active
            ? `0 0 0 3px rgba(120, 53, 15, 0.82), 0 0 0 6px ${hexToRgba(activeColor, 0.26)}`
            : `0 0 0 1px ${hexToRgba(markColor, 0.08)}`,
        }}
      >
        {text.slice(originalStart, originalEnd)}
      </mark>,
    )
    cursor = originalEnd
    cursorState.value += 1
    index += 1
    normalizedCursor = hit + Math.max(1, needle.length)
    hit = lower.indexOf(needle, normalizedCursor)
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function highlightReactNode(
  children: ReactNode,
  keyword: string,
  activeIndex = -1,
  cursorState = { value: 0 },
  displayIndexByLocalIndex?: Map<number, number>,
  highlightColor = DEFAULT_HIGHLIGHT_COLOR,
  activeOnly = false,
  noteHighlights: ReaderNoteHighlight[] = [],
  noteCursorState = { value: 0 },
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') {
      if (normalizeSelectionText(keyword)) return highlightText(child, keyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly)
      const nodeStart = noteCursorState.value
      noteCursorState.value += child.length
      const nodeHighlights = getNodeReaderNoteHighlights(noteHighlights, nodeStart, child.length)
      return nodeHighlights.length ? renderReaderNoteHighlightedText(child, nodeHighlights, 'original', `ebook-node-note-${nodeStart}`) : child
    }
    if (isValidElement(child)) {
      return cloneElement(child, {
        ...child.props,
        children: highlightReactNode(child.props.children, keyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, noteHighlights, noteCursorState),
      })
    }
    return child
  })
}

function renderTextContent(
  text: string,
  keyword: string,
  activeIndex = -1,
  startIndex = 0,
  displayIndexByLocalIndex?: Map<number, number>,
  displayScript: ReaderDisplayScript = 'original',
  highlightColor = DEFAULT_HIGHLIGHT_COLOR,
  activeOnly = false,
  noteHighlights: ReaderNoteHighlight[] = [],
) {
  const content = transformReaderDisplayText(normalizeReaderMarkdown(text || ''), displayScript)
  const displayKeyword = transformReaderDisplayText(keyword, displayScript)
  const displayNoteHighlights = noteHighlights.map((highlight) => ({
    ...highlight,
    text: transformReaderDisplayText(highlight.text, displayScript),
  }))
  const cursorState = { value: startIndex }
  const noteCursorState = { value: 0 }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      components={{
        p: ({ children }) => <p style={{ margin: '0 0 0.85em' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</p>,
        h1: ({ children }) => <h1 style={{ fontSize: '1.55em', lineHeight: 1.35, margin: '0.1em 0 0.75em' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</h1>,
        h2: ({ children }) => <h2 style={{ fontSize: '1.3em', lineHeight: 1.38, margin: '0.1em 0 0.65em' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</h2>,
        h3: ({ children }) => <h3 style={{ fontSize: '1.12em', lineHeight: 1.42, margin: '0.1em 0 0.55em' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</h3>,
        ul: ({ children }) => <ul style={{ paddingLeft: '1.5em', margin: '0 0 0.9em' }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ paddingLeft: '1.5em', margin: '0 0 0.9em' }}>{children}</ol>,
        li: ({ children }) => <li style={{ margin: '0.2em 0' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</li>,
        blockquote: ({ children }) => <blockquote style={{ margin: '0 0 1em', padding: '0.2em 0 0.2em 0.9em', borderLeft: '3px solid rgba(184,134,83,0.45)' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</blockquote>,
        table: ({ children }) => <table style={{ width: '100%', borderCollapse: 'collapse', margin: '0 0 1em', fontSize: '0.92em' }}>{children}</table>,
        th: ({ children }) => <th style={{ border: '1px solid rgba(120,80,30,0.28)', padding: '4px 6px', background: 'rgba(120,80,30,0.08)' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</th>,
        td: ({ children }) => <td style={{ border: '1px solid rgba(120,80,30,0.18)', padding: '4px 6px' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</td>,
        code: ({ children }) => <code style={{ fontFamily: 'Consolas, monospace', fontSize: '0.92em', background: 'rgba(120,80,30,0.12)', padding: '1px 4px', borderRadius: 3 }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</code>,
        sup: ({ children }) => <sup style={{ fontSize: '0.72em', lineHeight: 0, verticalAlign: 'super', color: 'inherit' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</sup>,
        sub: ({ children }) => <sub style={{ fontSize: '0.72em', lineHeight: 0, verticalAlign: 'sub', color: 'inherit' }}>{highlightReactNode(children, displayKeyword, activeIndex, cursorState, displayIndexByLocalIndex, highlightColor, activeOnly, displayNoteHighlights, noteCursorState)}</sub>,
      }}
    >
      {content || '暂无文本'}
    </ReactMarkdown>
  )
}

function makeSnippet(text: string, center: number, size = 420): string {
  const start = Math.max(0, center - Math.floor(size / 2))
  return text.slice(start, start + size)
}

function normalizeSelectionText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function getExcerptHighlightText(text: string): string {
  return normalizeSelectionText(text).slice(0, 180)
}

function buildNormalizedOffsetMap(text: string): { normalized: string; offsets: number[] } {
  let normalized = ''
  const offsets: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (/\s/.test(char)) {
      if (normalized && !normalized.endsWith(' ')) {
        normalized += ' '
        offsets.push(index)
      }
      continue
    }
    normalized += char
    offsets.push(index)
  }
  return { normalized: normalized.trim(), offsets }
}

function findNormalizedOffsets(source: string, query: string): number[] {
  const normalizedQuery = normalizeSelectionText(query).toLowerCase()
  if (!normalizedQuery) return []
  const sourceMap = buildNormalizedOffsetMap(source)
  const normalizedSource = sourceMap.normalized.toLowerCase()
  const offsets: number[] = []
  let cursor = normalizedSource.indexOf(normalizedQuery)
  while (cursor >= 0) {
    offsets.push(sourceMap.offsets[cursor] ?? cursor)
    cursor = normalizedSource.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
    if (offsets.length >= 20000) break
  }
  return offsets
}

function getRenderedSelectionOccurrenceIndex(container: HTMLElement | null | undefined, range: Range, query: string): number {
  if (!container) return 0
  const normalizedQuery = normalizeSelectionText(query).toLowerCase()
  if (!normalizedQuery) return 0
  try {
    const prefixRange = range.cloneRange()
    prefixRange.selectNodeContents(container)
    prefixRange.setEnd(range.startContainer, range.startOffset)
    const before = normalizeSelectionText(prefixRange.toString()).toLowerCase()
    let occurrenceIndex = 0
    let cursor = before.indexOf(normalizedQuery)
    while (cursor >= 0) {
      occurrenceIndex += 1
      cursor = before.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
    }
    return occurrenceIndex
  } catch {
    return 0
  }
}

function locateTextPageSelection(
  page: TextPage | undefined,
  selectedText: string,
  occurrenceHint = 0,
  displayScript: ReaderDisplayScript = 'original',
): { charStart: number; charEnd: number; occurrenceIndex: number; highlightText: string } {
  const highlightText = getExcerptHighlightText(selectedText)
  if (!page || !highlightText) return { charStart: 0, charEnd: 0, occurrenceIndex: 0, highlightText }
  const offsets = findNormalizedOffsets(page.text, highlightText)
  if (offsets.length > 0) {
    const occurrenceIndex = Math.max(0, Math.min(offsets.length - 1, occurrenceHint))
    const charStart = Math.max(0, offsets[occurrenceIndex] ?? 0)
    return {
      charStart,
      charEnd: Math.max(charStart + highlightText.length, charStart),
      occurrenceIndex,
      highlightText,
    }
  }
  const renderedText = transformReaderDisplayText(stripReaderHtml(normalizeReaderMarkdown(page.text)), displayScript)
  const renderedOffsets = findNormalizedOffsets(renderedText, highlightText)
  const occurrenceIndex = Math.max(0, Math.min(Math.max(0, renderedOffsets.length - 1), occurrenceHint))
  const charStart = Math.max(0, renderedOffsets[occurrenceIndex] ?? 0)
  return {
    charStart,
    charEnd: Math.max(charStart + highlightText.length, charStart),
    occurrenceIndex,
    highlightText,
  }
}

function makeMarkedSnippet(text: string, keyword: string, center: number, size = 180): string {
  const source = String(text || '')
  if (!source) return ''
  const query = String(keyword || '').trim()
  const start = Math.max(0, center - Math.floor(size / 2))
  const end = Math.min(source.length, start + size)
  const localCenter = Math.max(0, Math.min(source.length, center)) - start
  const queryLength = Math.max(1, query.length || 1)
  const before = start > 0 ? '…' : ''
  const after = end < source.length ? '…' : ''
  return `${before}${source.slice(start, start + localCenter)}<<${source.slice(start + localCenter, Math.min(end, start + localCenter + queryLength))}>>${source.slice(Math.min(end, start + localCenter + queryLength), end)}${after}`
}

function stripSnippetMarkers(value: string): string {
  return String(value || '').replace(/<</g, '').replace(/>>/g, '').replace(/\s+/g, ' ').trim()
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

function renderMarkedSnippet(snippet: string, keyword: string, displayScript: ReaderDisplayScript): ReactNode {
  const source = transformReaderDisplayText(stripSnippetHtmlPreservingMarkers(String(snippet || '')), displayScript)
  const displayKeyword = transformReaderDisplayText(keyword, displayScript)
  if (!source.includes('<<')) return highlightText(stripSnippetMarkers(source), displayKeyword)
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

function getOccurrenceMetadataForHref(textPages: TextPage[], href: string, keyword: string): Array<{ segmentId: string; charStart: number; occurrenceIndex: number }> {
  const query = keyword.trim().toLowerCase()
  if (!query) return []
  const matches: Array<{ segmentId: string; charStart: number; occurrenceIndex: number }> = []
  for (const page of textPages) {
    if (!sameHrefPath(page.href || '', href)) continue
    const lower = page.text.toLowerCase()
    let cursor = lower.indexOf(query)
    let occurrenceIndex = 0
    while (cursor >= 0) {
      matches.push({
        segmentId: String(page.id || ''),
        charStart: cursor,
        occurrenceIndex,
      })
      occurrenceIndex += 1
      cursor = lower.indexOf(query, cursor + Math.max(1, query.length))
    }
  }
  return matches
}

function clearEpubSearchHighlights(rendition: EpubRendition | null | undefined, cfiList: string[]): void {
  for (const cfi of cfiList) {
    try {
      rendition?.annotations?.remove?.(cfi, 'highlight')
    } catch {}
  }
}

function findInitialEpubSearchIndex(hits: EpubSearchHit[], locator?: SearchHitLocator | null, searchSession?: SearchSessionState): number {
  if (!hits.length) return -1
  const sessionIndex = Number(searchSession?.activeHitIndex)
  const sessionHit = Number.isFinite(sessionIndex) && sessionIndex >= 0 ? searchSession?.hits?.[sessionIndex] : null
  const target = locator || sessionHit?.locator || null
  if (!target) return Math.max(0, Math.min(hits.length - 1, Number.isFinite(sessionIndex) ? sessionIndex : 0))
  const exact = hits.findIndex((hit) => hit.segmentId === target.segmentId && hit.occurrenceIndex === target.occurrenceIndex)
  if (exact >= 0) return exact
  const sameSegment = hits.findIndex((hit) => hit.segmentId === target.segmentId)
  if (sameSegment >= 0) return Math.min(hits.length - 1, sameSegment + Math.max(0, Number(target.occurrenceIndex || 0)))
  const href = String(target.href || '')
  const sameHrefHits = href
    ? hits
      .map((hit, index) => ({ hit, index }))
      .filter(({ hit }) => sameHrefPath(hit.href, href))
    : []
  if (sameHrefHits.length > 0) {
    const byChar = sameHrefHits
      .map(({ hit, index }) => ({ index, distance: Math.abs(Number(hit.charStart || 0) - Number(target.charStart || 0)) }))
      .sort((left, right) => left.distance - right.distance)[0]
    if (byChar) return byChar.index
  }
  if (Number.isFinite(sessionIndex) && sessionIndex >= 0) return Math.min(hits.length - 1, sessionIndex)
  return 0
}

async function buildEpubSearchHits(book: EpubBook | null | undefined, keyword: string, textPages: TextPage[], taskId: number, isCurrentTask: () => boolean): Promise<EpubSearchHit[]> {
  const query = keyword.trim()
  if (!book || !query) return []
  await book.ready
  const spineItems = getSpineItems(book)
  const hits: EpubSearchHit[] = []
  for (const section of spineItems) {
    if (!isCurrentTask()) return []
    if (!section || section.linear === false) continue
    try {
      await section.load?.(book.load.bind(book))
      if (!isCurrentTask()) return []
      const sectionHits = typeof section.search === 'function'
        ? section.search(query)
        : typeof section.find === 'function'
          ? section.find(query)
          : []
      const sectionHref = String(section.href || section.canonical || '')
      const metadata = getOccurrenceMetadataForHref(textPages, sectionHref, query)
      for (const hit of sectionHits || []) {
        const cfi = String(hit.cfi || '')
        if (!cfi) continue
        const occurrence = hits.filter((item) => item.sectionIndex === Number(section.index ?? -1)).length
        const occurrenceMeta = metadata[occurrence]
        const excerpt = String(hit.excerpt || '')
        hits.push({
          cfi,
          excerpt,
          href: sectionHref,
          sectionIndex: Number(section.index ?? hits.length),
          segmentId: occurrenceMeta?.segmentId || '',
          charStart: Number(occurrenceMeta?.charStart || 0),
          occurrenceIndex: Number(occurrenceMeta?.occurrenceIndex ?? occurrence),
          globalIndex: hits.length,
        })
      }
    } catch (error) {
      console.warn('[EbookReader] EPUB search skipped section', { taskId, href: section?.href, error })
    } finally {
      try {
        const visibleIndex = Number(book?.rendition?.location?.start?.index)
        if (Number(section?.index) !== visibleIndex) section?.unload?.()
      } catch {}
    }
  }
  return hits
}

export default function EbookReader({
  document,
  pages,
  currentPageIndex,
  searchKeyword = '',
  highlightColor = '',
  sourceLabel = '',
  initialLocationKey = '',
  locator,
  searchSession,
  pageTranslations = {},
  pageTranslationUnits = {},
  translatingPageIds = {},
  skippedTranslationPageIds = {},
  translationGlossaryProjectId = '',
  translationGlossaryProjects = [],
  selectedTextForGlossary = '',
  displayScript = 'original',
  bookTranslationRequest = 0,
  translationMode = 'balanced',
  onDisplayScriptChange,
  onPageIndexChange,
  onSearchKeywordChange,
  onSelectedTextChange,
  onContextTextChange,
  onTranslateCurrentPage,
  onTranslationModeChange,
  onUpdateTranslationUnit,
  onRetranslateTranslationUnit,
  onTranslationGlossaryProjectChange,
  onAddSelectedTerm,
  onReaderStateChange,
}: EbookReaderProps) {
  const metadata = useMemo(() => parseMetadata(document), [document])
  const isEpub = useMemo(() => isEpubDocument(document), [document])
  const style = themeStyles.paper
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bookRef = useRef<EpubBook | null>(null)
  const renditionRef = useRef<EpubRendition | null>(null)
  const textScrollRef = useRef<HTMLDivElement | null>(null)
  const initialPageIndexRef = useRef(Math.max(0, currentPageIndex || 0))
  const initialLocationKeyRef = useRef(initialLocationKey)
  const onPageIndexChangeRef = useRef(onPageIndexChange)
  const onReaderStateChangeRef = useRef(onReaderStateChange)
  const onContextTextChangeRef = useRef(onContextTextChange)
  const epubFlatTocRef = useRef<TocNode[]>([])
  const epubSearchTaskRef = useRef(0)
  const handledBookTranslationRequestRef = useRef(0)
  const epubHighlightedCfiRef = useRef<string[]>([])
  const textPagesRef = useRef<TextPage[]>([])
  const appliedIncomingLocatorKeyRef = useRef('')
  const [tocOpen, setTocOpen] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('spread')
  const [fontSize, setFontSize] = useState(17)
  const [lineHeight, setLineHeight] = useState(1.85)
  const [theme, setTheme] = useState<ReaderTheme>('paper')
  const [toc, setToc] = useState<TocNode[]>([])
  const [loading, setLoading] = useState(true)
  const [location, setLocation] = useState<EpubLocation | null>(null)
  const [epubActiveTocId, setEpubActiveTocId] = useState('')
  const [epubSearchHits, setEpubSearchHits] = useState<EpubSearchHit[]>([])
  const [epubSearchLoading, setEpubSearchLoading] = useState(false)
  const [epubReadyKey, setEpubReadyKey] = useState(0)
  const [localSearch, setLocalSearch] = useState(searchKeyword)
  const [textPageIndex, setTextPageIndex] = useState(Math.max(0, currentPageIndex || 0))
  const [searchCursor, setSearchCursor] = useState(-1)
  const [searchNavigationEpoch, setSearchNavigationEpoch] = useState(0)
  const [translationOpen, setTranslationOpen] = useState(false)
  const [activeParallelSegmentId, setActiveParallelSegmentId] = useState('')
  const [readerSelection, setReaderSelection] = useState<ReaderSelectionState | null>(null)
  const [readerNoteMenu, setReaderNoteMenu] = useState<ReaderNoteMenuState | null>(null)
  const [summaryModalOpen, setSummaryModalOpen] = useState(false)
  const [summaryMarkdown, setSummaryMarkdown] = useState('')
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [readerSidebarTab, setReaderSidebarTab] = useState<ReaderSidebarTab>('toc')
  const [searchResultPage, setSearchResultPage] = useState(1)
  const [readerNotes, setReaderNotes] = useState<ReaderNoteItem[]>([])
  const [localSearchSession, setLocalSearchSession] = useState<SearchSessionState | null>(null)
  const [dismissedSearchSessionKey, setDismissedSearchSessionKey] = useState('')
  const [readerHighlightColor, setReaderHighlightColor] = useState('')
  const [pendingReaderNoteId, setPendingReaderNoteId] = useState('')
  const incomingSearchSessionKey = getSearchSessionStateKey(searchSession)
  const incomingSearchSession = incomingSearchSessionKey && incomingSearchSessionKey === dismissedSearchSessionKey ? undefined : searchSession
  const effectiveSearchSession = localSearchSession || incomingSearchSession || undefined

  const themed = themeStyles[theme]
  const textPages = useMemo(() => buildTextPages(pages), [pages])
  const textPage = textPages[Math.max(0, Math.min(textPages.length - 1, textPageIndex))]
  const effectiveTextSearchQuery = localSearchSession?.query || localSearch
  const textHits = useMemo(() => findTextMatches(textPages, effectiveTextSearchQuery), [effectiveTextSearchQuery, textPages])
  const hasMatchingSearchSession = effectiveSearchSession?.query?.trim() === effectiveTextSearchQuery.trim()
  const sessionTextHits = !isEpub && hasMatchingSearchSession ? effectiveSearchSession?.hits || [] : []
  const activeSessionHitIndex = sessionTextHits.length
    ? searchCursor >= 0 && searchCursor < sessionTextHits.length
      ? searchCursor
      : Number(effectiveSearchSession?.activeHitIndex) >= 0
        ? Math.min(sessionTextHits.length - 1, Number(effectiveSearchSession?.activeHitIndex))
        : 0
    : -1
  const activeSessionLocator = activeSessionHitIndex >= 0 ? sessionTextHits[activeSessionHitIndex]?.locator : null
  const activeSessionLocalHitIndex = activeSessionLocator ? findTextHitIndexByLocator(textHits, activeSessionLocator) : -1
  const activeTextHit = sessionTextHits.length
    ? activeSessionLocalHitIndex >= 0 ? textHits[activeSessionLocalHitIndex] : null
    : searchCursor >= 0 ? textHits[searchCursor] : null
  const activeTextSearchIndex = sessionTextHits.length ? activeSessionHitIndex : searchCursor
  const textSearchTotal = sessionTextHits.length || textHits.length
  const textSearchLabel = textSearchTotal ? `${Math.max(0, activeTextSearchIndex) + 1}/${textSearchTotal}` : '0/0'
  const canNavigateTextSearch = textSearchTotal > 0
  const searchDirectoryItems = useMemo<SearchDirectoryItem[]>(() => {
    if (!localSearch.trim()) return []
    if (isEpub) {
      return epubSearchHits.map((hit, index) => ({
        index,
        key: `${hit.segmentId}-${hit.occurrenceIndex}-${index}`,
        pageLabel: hit.href || `EPUB ${hit.sectionIndex + 1}`,
        snippet: hit.excerpt || makeMarkedSnippet(hit.href || '', localSearch, 0),
        active: index === searchCursor,
      }))
    }
    if (sessionTextHits.length) {
      return sessionTextHits.map((hit, index) => {
        const pageIndex = findTextPageIndexByLocator(textPages, hit.locator)
        const page = pageIndex >= 0 ? textPages[pageIndex] : null
        const pageLabel = hit.locator.pageNum || page?.sourcePageNum || (hit.locator.pageIndex ?? -1) + 1
        const snippet = hit.snippet || makeMarkedSnippet(page?.text || '', hit.locator.queryTerm || effectiveTextSearchQuery, hit.locator.charStart || 0)
        return {
          index,
          key: `${hit.id}-${index}`,
          pageLabel: pageLabel > 0 ? `第 ${pageLabel} 页` : '文本',
          snippet,
          active: index === activeSessionHitIndex,
        }
      })
    }
    return textHits.map((hit, index) => {
      const page = textPages[hit.pageIndex]
      return {
        index,
        key: `${hit.pageIndex}-${hit.charIndex}-${hit.occurrenceIndex}`,
        pageLabel: page?.sourcePageNum ? `第 ${page.sourcePageNum} 页` : `阅读节 ${hit.pageIndex + 1}`,
        snippet: makeMarkedSnippet(page?.text || '', localSearch, hit.charIndex),
        active: index === searchCursor,
      }
    })
  }, [activeSessionHitIndex, effectiveTextSearchQuery, epubSearchHits, isEpub, localSearch, searchCursor, sessionTextHits, textHits, textPages])
  const searchResultTotalPages = Math.max(1, Math.ceil(searchDirectoryItems.length / READER_SEARCH_RESULT_PAGE_SIZE))
  const searchResultPageSafe = Math.max(1, Math.min(searchResultPage, searchResultTotalPages))
  const visibleSearchDirectoryItems = searchDirectoryItems.slice(
    (searchResultPageSafe - 1) * READER_SEARCH_RESULT_PAGE_SIZE,
    searchResultPageSafe * READER_SEARCH_RESULT_PAGE_SIZE,
  )
  const visibleTextPageIndices = useMemo(() => {
    if (!textPages.length) return []
    const start = Math.max(0, Math.min(textPages.length - 1, textPageIndex))
    if (viewMode !== 'spread') return [start]
    return [start, start + 1].filter((index) => index >= 0 && index < textPages.length)
  }, [textPageIndex, textPages.length, viewMode])
  const visibleTextPages = useMemo(
    () => visibleTextPageIndices.map((index) => textPages[index]).filter(Boolean),
    [textPages, visibleTextPageIndices],
  )
  const effectiveHighlightColor = normalizeHighlightColor(readerHighlightColor || highlightColor)
  const readerNoteHighlightsByPage = useMemo(
    () => buildReaderNoteHighlightsByPage(readerNotes, textPages),
    [readerNotes, textPages],
  )
  const tocBusy = isEpub && loading
  const tocBusyTitle = isEpub ? '正在读取 EPUB 与目录' : '正在读取目录'
  const tocBusyHint = isEpub ? '正在加载 EPUB 内容和章节目录。' : '正在读取已保存目录。'
  const searchActiveOnly = Boolean(localSearchSession)
  const epubSearchLabel = epubSearchLoading
    ? '检索中'
    : epubSearchHits.length
      ? `${Math.max(0, searchCursor) + 1}/${epubSearchHits.length}`
      : '0/0'
  const flatToc = useMemo(() => flattenToc(toc), [toc])
  const activeHref = String(location?.start?.href || textPage?.href || '')
  const activeTocId = useMemo(() => {
    if (isEpub && epubActiveTocId && flatToc.some((item) => item.id === epubActiveTocId)) return epubActiveTocId
    const normalized = stripHash(activeHref)
    const candidates = flatToc.filter((item) => stripHash(item.href) === normalized || normalized.endsWith(stripHash(item.href)))
    return candidates[0]?.id || ''
  }, [activeHref, epubActiveTocId, flatToc, isEpub])

  useEffect(() => {
    onPageIndexChangeRef.current = onPageIndexChange
  }, [onPageIndexChange])

  useEffect(() => {
    onReaderStateChangeRef.current = onReaderStateChange
  }, [onReaderStateChange])

  useEffect(() => {
    onContextTextChangeRef.current = onContextTextChange
  }, [onContextTextChange])

  useEffect(() => {
    epubFlatTocRef.current = flatToc
  }, [flatToc])

  useEffect(() => {
    textPagesRef.current = textPages
  }, [textPages])

  useEffect(() => {
    setLocalSearch(searchKeyword || '')
    setSearchCursor(-1)
    setLocalSearchSession(null)
    setReaderHighlightColor('')
    if (searchKeyword.trim()) setDismissedSearchSessionKey('')
  }, [searchKeyword])

  useEffect(() => {
    if (localSearch.trim()) {
      setTocOpen(true)
      setReaderSidebarTab('search')
      setSearchResultPage(1)
      return
    }
    setSearchResultPage(1)
  }, [localSearch])

  useEffect(() => {
    const docId = document?.id
    if (!docId) {
      setReaderNotes([])
      return
    }
    let cancelled = false
    window.api.listResearchNotes(null)
      .then((notes) => {
        if (cancelled) return
        setReaderNotes(
          notes
            .filter((note) => note.doc_id === docId)
            .sort((left, right) => Date.parse(right.updated_at || right.created_at || '') - Date.parse(left.updated_at || left.created_at || '')),
        )
      })
      .catch((error: unknown) => {
        console.error(error)
        if (!cancelled) setReaderNotes([])
      })
    return () => {
      cancelled = true
    }
  }, [document?.id])

  useEffect(() => {
    if (searchResultPage !== searchResultPageSafe) {
      setSearchResultPage(searchResultPageSafe)
    }
  }, [searchResultPage, searchResultPageSafe])

  useEffect(() => {
    const docId = document.id
    if (isEpub || !docId) return
    if (effectiveTextSearchQuery.trim() && (hasMatchingSearchSession || locator)) return
    const next = Math.max(0, Math.min(textPages.length - 1, currentPageIndex || 0))
    setTextPageIndex(next)
  }, [currentPageIndex, document.id, effectiveTextSearchQuery, hasMatchingSearchSession, isEpub, locator, textPages.length])

  useEffect(() => {
    setActiveParallelSegmentId('')
  }, [textPage?.id, translationOpen])

  useEffect(() => {
    if (isEpub || !document.id) return
    if (!effectiveTextSearchQuery.trim() || !textHits.length) return
    if (hasMatchingSearchSession && sessionTextHits.length) return
    const locatorKey = getSearchLocatorKey(locator)
    if (locatorKey && appliedIncomingLocatorKeyRef.current !== locatorKey) {
      const locatorIndex = findTextHitIndexByLocator(textHits, locator)
      if (locatorIndex >= 0) {
        appliedIncomingLocatorKeyRef.current = locatorKey
        setSearchCursor(locatorIndex)
        const targetPageIndex = textHits[locatorIndex]?.pageIndex ?? findTextPageIndexByLocator(textPages, locator)
        if (Number.isFinite(targetPageIndex) && targetPageIndex >= 0) setTextPageIndex(targetPageIndex)
        return
      }
    }
    if (searchCursor >= 0) return
    const currentPageHitIndex = textHits.findIndex((hit) => hit.pageIndex === Math.max(0, currentPageIndex || 0))
    const currentPageKey = `page:${document.id}:${effectiveTextSearchQuery}:${Math.max(0, currentPageIndex || 0)}`
    if (currentPageHitIndex >= 0 && appliedIncomingLocatorKeyRef.current !== currentPageKey) {
      appliedIncomingLocatorKeyRef.current = currentPageKey
      setSearchCursor(currentPageHitIndex)
      const targetPageIndex = textHits[currentPageHitIndex]?.pageIndex ?? Math.max(0, currentPageIndex || 0)
      if (Number.isFinite(targetPageIndex) && targetPageIndex >= 0) setTextPageIndex(targetPageIndex)
      return
    }
    const locatorHitIndex = locator ? findTextHitIndexByLocator(textHits, locator) : -1
    const initialIndex = locatorHitIndex >= 0
      ? locatorHitIndex
      : currentPageHitIndex >= 0
        ? currentPageHitIndex
        : findInitialTextSearchIndex(textHits, locator, effectiveSearchSession)
    if (initialIndex >= 0) {
      setSearchCursor(initialIndex)
      const targetPageIndex = textHits[initialIndex]?.pageIndex ?? 0
      if (Number.isFinite(targetPageIndex)) setTextPageIndex(targetPageIndex)
    }
  }, [currentPageIndex, effectiveSearchSession, effectiveTextSearchQuery, hasMatchingSearchSession, isEpub, locator, searchCursor, sessionTextHits.length, textHits, textPages])

  useEffect(() => {
    if (isEpub || !hasMatchingSearchSession || !sessionTextHits.length) return
    const locatorKey = getSearchLocatorKey(locator)
    const locatorIndex = findSessionHitIndexByLocator(effectiveSearchSession, locator)
    if (locatorKey && locatorIndex >= 0 && appliedIncomingLocatorKeyRef.current !== locatorKey) {
      appliedIncomingLocatorKeyRef.current = locatorKey
      setSearchCursor(locatorIndex)
      const targetPageIndex = findTextPageIndexByLocator(textPages, sessionTextHits[locatorIndex]?.locator || locator)
      if (targetPageIndex >= 0) setTextPageIndex(targetPageIndex)
      return
    }
    if (searchCursor >= 0 && searchCursor < sessionTextHits.length) return
    const currentPageSessionIndex = findSessionHitIndexByPage(sessionTextHits, textPages, Math.max(0, currentPageIndex || 0))
    const currentPageSessionKey = `session-page:${document.id}:${effectiveTextSearchQuery}:${Math.max(0, currentPageIndex || 0)}`
    if (currentPageSessionIndex >= 0 && appliedIncomingLocatorKeyRef.current !== currentPageSessionKey) {
      appliedIncomingLocatorKeyRef.current = currentPageSessionKey
      setSearchCursor(currentPageSessionIndex)
      const targetPageIndex = findTextPageIndexByLocator(textPages, sessionTextHits[currentPageSessionIndex]?.locator || locator)
      if (targetPageIndex >= 0) setTextPageIndex(targetPageIndex)
      return
    }
    const initialIndex = locatorIndex >= 0
      ? locatorIndex
      : currentPageSessionIndex >= 0
        ? currentPageSessionIndex
      : effectiveSearchSession?.activeHitIndex >= 0 ? effectiveSearchSession.activeHitIndex : 0
    const boundedIndex = Math.max(0, Math.min(sessionTextHits.length - 1, initialIndex))
    setSearchCursor(boundedIndex)
    const targetPageIndex = findTextPageIndexByLocator(textPages, sessionTextHits[boundedIndex]?.locator || locator)
    if (targetPageIndex >= 0) setTextPageIndex(targetPageIndex)
  }, [currentPageIndex, effectiveSearchSession?.activeHitIndex, hasMatchingSearchSession, isEpub, locator, searchCursor, sessionTextHits, textPages])

  useEffect(() => {
    const docId = document.id
    if (isEpub || !docId) return
    let cancelled = false
    let timer: number | null = null
    setLoading(true)
    timer = window.setTimeout(() => {
      window.api.getDocumentToc(docId)
        .then((items) => {
          if (!cancelled) setToc(tocV2ToNodes(items || []))
        })
        .catch(() => {
          if (!cancelled) setToc([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 60)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [document?.id, isEpub])

  useEffect(() => {
    const filePath = document?.file_path
    if (!isEpub || !filePath || !containerRef.current) return
    let cancelled = false
    setLoading(true)
    setToc([])
    setLocation(null)
    setEpubActiveTocId('')
    const mount = containerRef.current

    const run = async () => {
      try {
        const buffer = await window.api.readFileBuffer(filePath)
        if (cancelled) return
        const book = ePub(buffer) as EpubBook
        bookRef.current = book
        const rendition = book.renderTo(mount, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: viewMode === 'spread' ? 'auto' : 'none',
          manager: 'default',
        })
        renditionRef.current = rendition
        rendition.themes.register('gujismart', {
          body: {
            color: `${themeStyles[theme].text} !important`,
            background: `${themeStyles[theme].page} !important`,
            'font-family': "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif !important",
            'font-size': `${fontSize}px !important`,
            'line-height': `${lineHeight} !important`,
          },
          p: {
            'text-align': 'justify',
            'margin-top': '0.55em',
            'margin-bottom': '0.85em',
          },
          img: {
            'max-width': '100%',
            'max-height': '90vh',
            'object-fit': 'contain',
          },
          table: {
            width: '100%',
            'border-collapse': 'collapse',
          },
          td: {
            border: '1px solid rgba(120,80,42,0.22)',
            padding: '4px 6px',
          },
          th: {
            border: '1px solid rgba(120,80,42,0.3)',
            padding: '4px 6px',
            background: 'rgba(120,80,42,0.08)',
          },
        })
        rendition.themes.select('gujismart')
        rendition.on('relocated', (nextLocation: unknown) => {
          const locationRecord = nextLocation as EpubLocation
          setLocation(locationRecord)
          window.setTimeout(() => {
            setEpubActiveTocId((current) => findVisibleEpubTocId(rendition, String(locationRecord.start?.href || ''), epubFlatTocRef.current, current))
          }, 80)
          const spineIndex = Number(locationRecord.start?.index || 0)
          onPageIndexChangeRef.current(Math.max(0, spineIndex))
        })
        rendition.hooks.content.register((contents) => {
          const doc = contents.document
          if (!doc) return
          doc.body.style.background = themeStyles[theme].page
          doc.body.style.color = themeStyles[theme].text
          const linkStyleId = 'gujismart-epub-link-style'
          if (!doc.getElementById(linkStyleId)) {
            const linkStyleNode = doc.createElement('style')
            linkStyleNode.id = linkStyleId
            linkStyleNode.textContent = `
              a, a:visited, a:hover, a:active {
                color: inherit !important;
                text-decoration: none !important;
                border-bottom: 0 !important;
                box-shadow: none !important;
              }
            `
            doc.head?.appendChild(linkStyleNode)
          }
          const styleId = 'gujismart-epub-search-style'
          if (!doc.getElementById(styleId)) {
            const styleNode = doc.createElement('style')
            styleNode.id = styleId
            styleNode.textContent = `
              .gujismart-epub-search-hit {
                fill: #ffe58f;
                fill-opacity: 0.34;
                stroke: rgba(189, 138, 42, 0.12);
                stroke-width: 0.8;
                vector-effect: non-scaling-stroke;
                mix-blend-mode: normal;
              }
              .gujismart-epub-search-active {
                fill: #ffb020;
                fill-opacity: 0.68;
                stroke: rgba(120, 53, 15, 0.9);
                stroke-width: 2.2;
                vector-effect: non-scaling-stroke;
                mix-blend-mode: normal;
              }
            `
            doc.head?.appendChild(styleNode)
          }
        })
        const navigation = await book.loaded?.navigation
        const normalizedToc = normalizeEpubToc(navigation?.toc || [])
        if (!cancelled) setToc(normalizedToc)
        const savedCfi = initialLocationKeyRef.current.startsWith('epub-cfi:')
          ? initialLocationKeyRef.current.slice('epub-cfi:'.length)
          : ''
        const savedEpubTarget = initialLocationKeyRef.current.startsWith('epub:')
          ? initialLocationKeyRef.current.slice('epub:'.length)
          : ''
        const initialTarget = savedCfi || savedEpubTarget || getInitialEpubTarget(pages, initialPageIndexRef.current)
        await displayEpubTarget(rendition, book, initialTarget || undefined)
        if (!cancelled) setEpubReadyKey((value) => value + 1)
      } catch (error: unknown) {
        console.error(error)
        if (!cancelled) message.error(getErrorMessage(error, 'EPUB 阅读器加载失败'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
      try {
        clearEpubSearchHighlights(renditionRef.current, epubHighlightedCfiRef.current)
        epubHighlightedCfiRef.current = []
        renditionRef.current?.destroy?.()
      } catch {}
      try {
        bookRef.current?.destroy?.()
      } catch {}
      renditionRef.current = null
      bookRef.current = null
      mount.innerHTML = ''
    }
  }, [document?.file_path, document?.id, isEpub])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition || !isEpub) return
    rendition.themes.fontSize(`${fontSize}px`)
    rendition.themes.override('line-height', String(lineHeight))
    rendition.themes.override('color', themeStyles[theme].text)
    rendition.themes.override('background', themeStyles[theme].page)
  }, [fontSize, isEpub, lineHeight, theme])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition || !isEpub) return
    rendition.spread?.(viewMode === 'spread' ? 'auto' : 'none')
    rendition.resize?.()
  }, [isEpub, viewMode])

  useEffect(() => {
    const notesContext = buildReaderNotesContext(readerNotes, textPage?.sourcePageNum, textPageIndex)
    if (isEpub) {
      onContextTextChangeRef.current?.(notesContext)
      const cfi = String(location?.start?.cfi || '')
      const percentage = Number(location?.start?.percentage || 0)
      onReaderStateChangeRef.current?.({
        location_key: cfi ? `epub-cfi:${cfi}` : `epub:${activeHref || 'start'}`,
        progress: Number.isFinite(percentage) ? percentage : 0,
        view_mode: viewMode,
        font_size: fontSize,
        line_height: lineHeight,
        theme,
      })
      return
    }
    const bounded = Math.max(0, Math.min(textPages.length - 1, textPageIndex))
    const page = textPages[bounded]
    const pageContext = visibleTextPages.map((item) => item?.text || '').filter(Boolean).join('\n\n')
    onContextTextChangeRef.current?.([notesContext, pageContext || page?.text || ''].filter(Boolean).join('\n\n'))
    onReaderStateChangeRef.current?.({
      location_key: `text:${page?.href || bounded + 1}`,
      progress: textPages.length <= 1 ? 1 : bounded / Math.max(1, textPages.length - 1),
      view_mode: viewMode,
      font_size: fontSize,
      line_height: lineHeight,
      theme,
    })
  }, [activeHref, fontSize, isEpub, lineHeight, location, readerNotes, textPage?.sourcePageNum, textPageIndex, textPages, theme, viewMode, visibleTextPages])

  useEffect(() => {
    if (!activeTextHit || isEpub) return
    const timer = window.setTimeout(() => {
      const node = textScrollRef.current?.querySelector<HTMLElement>(`[data-ebook-search-hit="${activeTextHit.globalIndex}"]`)
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 40)
    return () => window.clearTimeout(timer)
  }, [activeTextHit, isEpub])

  useEffect(() => {
    if (!pendingReaderNoteId || isEpub) return
    const timer = window.setTimeout(() => {
      const node = textScrollRef.current?.querySelector<HTMLElement>(`[data-reader-note-id="${pendingReaderNoteId}"]`)
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      if (node) setPendingReaderNoteId('')
    }, 60)
    return () => window.clearTimeout(timer)
  }, [isEpub, pendingReaderNoteId, searchNavigationEpoch, textPageIndex, viewMode])

  useEffect(() => {
    if (!isEpub) return
    const rendition = renditionRef.current
    const book = bookRef.current
    const query = localSearch.trim()
    const taskId = epubSearchTaskRef.current + 1
    epubSearchTaskRef.current = taskId
    clearEpubSearchHighlights(rendition, epubHighlightedCfiRef.current)
    epubHighlightedCfiRef.current = []
    setSearchCursor(-1)
    setEpubSearchHits([])
    if (!query || !book || !rendition) {
      setEpubSearchLoading(false)
      return
    }
    let cancelled = false
    setEpubSearchLoading(true)
    const timer = window.setTimeout(() => {
      void buildEpubSearchHits(book, query, textPagesRef.current, taskId, () => !cancelled && epubSearchTaskRef.current === taskId)
        .then((hits) => {
          if (cancelled || epubSearchTaskRef.current !== taskId) return
          setEpubSearchHits(hits)
          const initialIndex = findInitialEpubSearchIndex(hits, locator, searchSession)
          if (initialIndex >= 0) {
            setSearchCursor(initialIndex)
            void rendition.display(hits[initialIndex].cfi)
          }
        })
        .catch((error) => {
          if (!cancelled) {
            console.error(error)
            message.error(getErrorMessage(error, 'EPUB 页内检索失败'))
          }
        })
        .finally(() => {
          if (!cancelled && epubSearchTaskRef.current === taskId) setEpubSearchLoading(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [epubReadyKey, isEpub, localSearch, locator, searchSession])

  useEffect(() => {
    if (!isEpub) return
    const rendition = renditionRef.current
    if (!rendition) return
    const markColor = effectiveHighlightColor
    clearEpubSearchHighlights(rendition, epubHighlightedCfiRef.current)
    epubHighlightedCfiRef.current = []
    const activeHit = searchCursor >= 0 ? epubSearchHits[searchCursor] : null
    if (!activeHit) return
    const sameSectionHits = epubSearchHits.filter((hit) => hit.sectionIndex === activeHit.sectionIndex)
    for (const hit of sameSectionHits) {
      try {
        rendition.annotations?.highlight?.(
          hit.cfi,
          { source: 'ebook-page-search', active: hit.globalIndex === activeHit.globalIndex },
          undefined,
          hit.globalIndex === activeHit.globalIndex ? 'gujismart-epub-search-active' : 'gujismart-epub-search-hit',
          hit.globalIndex === activeHit.globalIndex
            ? {
                fill: markColor,
                'fill-opacity': '0.5',
                stroke: hexToRgba(markColor, 0.36),
                'stroke-width': '0.9',
                'vector-effect': 'non-scaling-stroke',
                'mix-blend-mode': 'normal',
              }
            : {
                fill: markColor,
                'fill-opacity': '0.42',
                stroke: hexToRgba(markColor, 0.18),
                'stroke-width': '0.8',
                'vector-effect': 'non-scaling-stroke',
                'mix-blend-mode': 'normal',
              },
        )
        epubHighlightedCfiRef.current.push(hit.cfi)
      } catch (error) {
        console.warn('[EbookReader] EPUB search highlight failed', error)
      }
    }
  }, [effectiveHighlightColor, epubSearchHits, isEpub, searchCursor, location?.start?.index])

  useEffect(() => {
    if (isEpub || !textHits.length) return
    if (sessionTextHits.length) return
    if (searchCursor < 0) {
      const initialIndex = findInitialTextSearchIndex(textHits, locator, effectiveSearchSession)
      if (initialIndex >= 0) setSearchCursor(initialIndex)
      return
    }
    const nextPageIndex = textHits[searchCursor]?.pageIndex
    if (Number.isFinite(nextPageIndex) && !visibleTextPageIndices.includes(nextPageIndex)) setTextPageIndex(nextPageIndex)
  }, [effectiveSearchSession, isEpub, locator, searchCursor, sessionTextHits.length, textHits, visibleTextPageIndices])

  const jumpTextPage = (nextIndex: number) => {
    const bounded = Math.max(0, Math.min(textPages.length - 1, nextIndex))
    setTextPageIndex(bounded)
    onPageIndexChange(bounded)
  }

  const clearReaderSearchStateForNotes = () => {
    setLocalSearch('')
    setSearchCursor(-1)
    setLocalSearchSession(null)
    setSearchResultPage(1)
    if (incomingSearchSessionKey) setDismissedSearchSessionKey(incomingSearchSessionKey)
    onSearchKeywordChange?.('')
  }

  const focusReaderNote = (note: ReaderNoteItem) => {
    const locator = getReaderNoteLocator(note)
    if (!locator) {
      message.warning('这条摘录缺少可定位的阅读器锚点')
      return false
    }
    clearReaderSearchStateForNotes()
    setReaderHighlightColor(normalizeHighlightColor(note.color))
    setReaderSidebarTab('search')
    setTocOpen(true)
    setPendingReaderNoteId(note.id)
    setSearchNavigationEpoch((value) => value + 1)
    if (isEpub) {
      const href = locator.href
      if (href && renditionRef.current && bookRef.current) {
        void displayEpubTarget(renditionRef.current, bookRef.current, href)
        return true
      }
      message.warning('这条摘录缺少可定位的 EPUB 位置')
      return false
    }
    const targetPageIndex = findTextPageIndexByLocator(textPages, locator)
    if (targetPageIndex < 0) {
      message.warning('这条摘录缺少可定位的阅读器锚点')
      return false
    }
    if (viewMode === 'spread' && visibleTextPageIndices.includes(targetPageIndex)) {
      window.setTimeout(() => setSearchNavigationEpoch((value) => value + 1), 40)
    } else {
      jumpTextPage(targetPageIndex)
    }
    return true
  }

  const deleteReaderNote = (note: ReaderNoteItem) => {
    Modal.confirm({
      title: '取消这条摘录？',
      content: '正文高亮和左侧摘录都会移除。',
      okText: '取消摘录',
      okButtonProps: { danger: true },
      cancelText: '保留',
      onOk: async () => {
        try {
          await window.api.deleteResearchNote(note.id)
          setReaderNotes((notes) => notes.filter((item) => item.id !== note.id))
          setPendingReaderNoteId('')
          setReaderSelection(null)
          setReaderNoteMenu(null)
          clearReaderSearchStateForNotes()
          message.success('已取消摘录')
        } catch (error: unknown) {
          console.error(error)
          message.error(getErrorMessage(error, '取消摘录失败'))
          throw error
        }
      },
    })
  }

  const handleReaderNoteClick = (event: import('react').MouseEvent<HTMLElement>) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-reader-note-highlight="true"]')
      : null
    const noteId = target?.dataset.readerNoteId || ''
    if (!target || !noteId) {
      setReaderNoteMenu(null)
      return
    }
    const note = readerNotes.find((item) => item.id === noteId)
    if (!note) {
      setReaderNoteMenu(null)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const rect = target.getBoundingClientRect()
    setReaderSelection(null)
    setReaderNoteMenu({
      noteId,
      x: rect.left + rect.width / 2,
      y: Math.max(12, rect.top - 42),
    })
  }

  const jumpToc = (item: TocNode) => {
    if (isEpub) {
      const rendition = renditionRef.current
      const book = bookRef.current
      if (!rendition || !book) return
      setEpubActiveTocId(item.id)
      void displayEpubTarget(rendition, book, item.href)
        .then(() => {
          window.setTimeout(() => {
            setEpubActiveTocId((current) => findVisibleEpubTocId(rendition, item.href, flatToc, current || item.id))
          }, 120)
        })
      return
    }
    const href = normalizeHref(item.href)
    const index = textPages.findIndex((page) => normalizeHref(page.href || '') === href || stripHash(page.href || '') === stripHash(href))
    if (index >= 0) jumpTextPage(index)
  }

  const goPrevious = () => {
    if (isEpub) {
      void renditionRef.current?.prev?.()
      return
    }
    jumpTextPage(textPageIndex - pageStep)
  }

  const goNext = () => {
    if (isEpub) {
      void renditionRef.current?.next?.()
      return
    }
    jumpTextPage(textPageIndex + pageStep)
  }

  const resolveReaderCitationText = async (pageNum: number | null): Promise<string> => {
    const fallback = buildReaderCitationText(document.title || pageTitle, pageNum)
    if (!document?.id) return fallback
    try {
      return await resolveDocumentCitation(document.id, { docType: document.doc_type, pageNum }) || fallback
    } catch (error) {
      console.warn('Failed to generate reader citation from active style, falling back to simple citation.', error)
      return fallback
    }
  }

  const saveCurrentTextExcerpt = async (colorOverride?: string) => {
    if (isEpub || !document.id) return
    const sourcePageIndex = Math.max(0, Math.min(textPages.length - 1, readerSelection?.pageIndex ?? textPageIndex))
    const sourcePage = textPages[sourcePageIndex] || textPage
    if (!sourcePage) return
    const internalPageNum = Number(sourcePage.sourcePageNum || sourcePageIndex + 1)
    const citationPageNum = getTextPageCitationPageNum(sourcePage)
    const selected = readerSelection?.text || window.getSelection()?.toString()?.trim() || ''
    const excerpt = (selected || makeSnippet(sourcePage.text, 0, 900)).trim().slice(0, 1200)
    if (!excerpt) {
      message.info('当前没有可保存的文本')
      return
    }
    const selectionLocation = locateTextPageSelection(
      sourcePage,
      selected || excerpt,
      readerSelection?.occurrenceIndex ?? 0,
      displayScript,
    )
    const highlightText = selectionLocation.highlightText || getExcerptHighlightText(excerpt)
    const charStart = Math.max(0, readerSelection?.charStart ?? selectionLocation.charStart)
    const charEnd = Math.max(charStart + highlightText.length, readerSelection?.charEnd ?? selectionLocation.charEnd)
    const locator: SearchHitLocator = {
      docId: document.id,
      segmentId: `${document.id}:ebook-reader:${sourcePage.id || sourcePage.href || sourcePage.sourcePageNum || sourcePageIndex}`,
      sourceType: 'ebook-reader',
      pageId: sourcePage.id || null,
      href: sourcePage.href || null,
      pageNum: internalPageNum,
      pageIndex: sourcePageIndex,
      locationKey: `text:${sourcePage.href || sourcePage.sourcePageNum || sourcePageIndex + 1}`,
      segmentOrdinal: sourcePageIndex,
      charStart,
      charEnd,
      matchText: highlightText,
      queryTerm: highlightText,
      occurrenceIndex: readerSelection?.occurrenceIndex ?? selectionLocation.occurrenceIndex,
    }
    const sourceMeta = {
      sourceType: 'reader',
      reader: 'ebook-reader',
      href: sourcePage.href || null,
      pageNum: locator.pageNum,
      citationPageNum,
      displayPageNum: citationPageNum,
      sourcePageNum: internalPageNum,
      internalPageNum,
      pageIndex: locator.pageIndex,
      locationKey: locator.locationKey,
      searchKeyword: highlightText,
      matchedQuery: highlightText,
      locator,
    }
    const noteColor = normalizeHighlightColor(colorOverride || effectiveHighlightColor)
    try {
      const citationText = await resolveReaderCitationText(citationPageNum || internalPageNum)
      const savedNote = await window.api.createResearchNote({
        doc_id: document.id,
        page_num: citationPageNum || internalPageNum,
        excerpt,
        note: '从阅读器保存',
        source_type: 'manual',
        kind: 'quote',
        color: noteColor,
        locator,
        citation_text: citationText,
        source_id: JSON.stringify({ ...sourceMeta, citation: citationText }),
      })
      const nextNote: ReaderNoteItem = savedNote
      setReaderNotes((notes) => [nextNote, ...notes.filter((note) => note.id !== nextNote.id)])
      setReaderSelection(null)
      setReaderNoteMenu(null)
      window.getSelection()?.removeAllRanges()
      setReaderHighlightColor(noteColor)
      focusReaderNote(nextNote)
      message.success('已标记为摘录')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存摘录失败'))
    }
  }

  const updateReaderSelection = (pageIndex: number, event?: SelectionMouseEvent) => {
    const selection = window.getSelection()
    const text = selection?.toString()?.trim() || ''
    if (!text || !selection?.rangeCount) {
      setReaderSelection(null)
      setReaderNoteMenu(null)
      onSelectedTextChange?.('')
      return
    }
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const sourcePageIndex = Math.max(0, Math.min(textPages.length - 1, pageIndex))
    const sourcePage = textPages[sourcePageIndex]
    const container = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
    const occurrenceHint = getRenderedSelectionOccurrenceIndex(container, range, text)
    const selectionLocation = locateTextPageSelection(sourcePage, text, occurrenceHint, displayScript)
    setReaderSelection({
      text,
      x: rect.left + rect.width / 2,
      y: Math.max(12, rect.top - 42),
      pageIndex: sourcePageIndex,
      charStart: selectionLocation.charStart,
      charEnd: selectionLocation.charEnd,
      occurrenceIndex: selectionLocation.occurrenceIndex,
    })
    setReaderNoteMenu(null)
    onSelectedTextChange?.(text)
  }

  const copyDirectQuote = async () => {
    const selected = readerSelection?.text || window.getSelection()?.toString()?.trim() || ''
    if (!selected.trim()) {
      message.info('请先选择需要引用的文本')
      return
    }
    const sourcePageIndex = Math.max(0, Math.min(textPages.length - 1, readerSelection?.pageIndex ?? textPageIndex))
    const sourcePage = textPages[sourcePageIndex] || textPage
    const citationPageNum = getTextPageCitationPageNum(sourcePage) || Number(sourcePage?.sourcePageNum || sourcePageIndex + 1)
    const citationText = await resolveReaderCitationText(citationPageNum)
    const quote = buildDirectQuoteCitationText(selected, citationText)
    try {
      await navigator.clipboard.writeText(quote)
      message.success('已复制直接引用')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '复制直接引用失败'))
    }
  }

  const summarizeText = async (text: string, scope: 'selection' | 'basket' = 'selection') => {
    if (!text.trim()) {
      message.info('请先选择需要摘要的文本')
      return
    }
    const sourcePageIndex = Math.max(0, Math.min(textPages.length - 1, readerSelection?.pageIndex ?? textPageIndex))
    const sourcePage = textPages[sourcePageIndex] || textPage
    const internalPageNum = Number(sourcePage?.sourcePageNum || sourcePageIndex + 1)
    const citationPageNum = getTextPageCitationPageNum(sourcePage) || internalPageNum
    setSummaryModalOpen(true)
    setSummaryLoading(true)
    try {
      const result = await window.api.summarizeSelection({
        text,
        scope,
        title: document?.title || pageTitle,
        source: {
          docId: document.id || '',
          docTitle: document.title,
          pageNum: citationPageNum,
          locator: {
            docId: document.id || '',
            segmentId: `${document.id || 'document'}:ebook-summary:${sourcePage?.href || internalPageNum || 'current'}`,
            sourceType: 'ebook-reader-summary',
            pageId: null,
            href: sourcePage?.href,
            pageNum: internalPageNum,
            pageIndex: sourcePageIndex,
            segmentOrdinal: sourcePageIndex,
            charStart: 0,
            charEnd: text.length,
            matchText: text.slice(0, 80),
            queryTerm: text.slice(0, 40),
            occurrenceIndex: 0,
          },
        },
      })
      setSummaryMarkdown(result.markdown)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '摘要生成失败'))
    } finally {
      setSummaryLoading(false)
    }
  }

  const saveSummaryAsNote = async () => {
    if (!summaryMarkdown.trim() || !document?.id) return
    const summaryPageIndex = Math.max(0, Math.min(textPages.length - 1, readerSelection?.pageIndex ?? textPageIndex))
    const summaryPage = textPages[summaryPageIndex] || textPage
    const internalPageNum = Number(summaryPage?.sourcePageNum || summaryPageIndex + 1)
    const citationPageNum = getTextPageCitationPageNum(summaryPage) || internalPageNum
    const citationText = await resolveReaderCitationText(citationPageNum || internalPageNum)
    const locator = {
      sourceType: 'ebook-reader-summary',
      href: summaryPage?.href,
      pageNum: internalPageNum,
      pageIndex: summaryPageIndex,
    }
    const sourceMeta = {
      sourceType: 'ai_summary',
      reader: 'ebook-reader',
      href: summaryPage?.href || null,
      citationPageNum,
      displayPageNum: citationPageNum,
      citation: citationText,
      sourcePageNum: internalPageNum,
      internalPageNum,
      pageNum: internalPageNum,
      pageIndex: summaryPageIndex,
      locator,
    }
    try {
      const savedNote = await window.api.createResearchNote({
        doc_id: document.id,
        page_num: citationPageNum || internalPageNum || null,
        excerpt: summaryMarkdown.slice(0, 1200),
        note: readerSelection?.text ? `AI 摘要来源：${readerSelection.text.slice(0, 160)}` : 'AI 摘要',
        source_type: 'ai',
        kind: 'summary',
        color: effectiveHighlightColor,
        locator,
        citation_text: citationText,
        source_id: JSON.stringify(sourceMeta),
      })
      const nextNote: ReaderNoteItem = savedNote
      setReaderNotes((notes) => [nextNote, ...notes.filter((note) => note.id !== nextNote.id)])
      setReaderSidebarTab('search')
      setTocOpen(true)
      message.success('摘要已保存为研究笔记')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存摘要失败'))
    }
  }

  const jumpSearch = (direction: 1 | -1) => {
    if (isEpub) {
      if (!epubSearchHits.length) return
      const current = searchCursor >= 0 ? searchCursor : direction > 0 ? -1 : 0
      const next = (current + direction + epubSearchHits.length) % epubSearchHits.length
      const hit = epubSearchHits[next]
      setSearchCursor(next)
      setSearchNavigationEpoch((value) => value + 1)
      void renditionRef.current?.display?.(hit.cfi)
      return
    }
    if (sessionTextHits.length) {
      const current = activeSessionHitIndex >= 0 ? activeSessionHitIndex : direction > 0 ? -1 : 0
      const next = (current + direction + sessionTextHits.length) % sessionTextHits.length
      setSearchCursor(next)
      setSearchNavigationEpoch((value) => value + 1)
      const nextPageIndex = findTextPageIndexByLocator(textPages, sessionTextHits[next]?.locator)
      if (Number.isFinite(nextPageIndex) && nextPageIndex >= 0) jumpTextPage(nextPageIndex)
      return
    }
    if (!textHits.length) return
    const current = searchCursor >= 0 ? searchCursor : 0
    const next = (current + direction + textHits.length) % textHits.length
    setSearchCursor(next)
    setSearchNavigationEpoch((value) => value + 1)
    const nextHit = textHits[next]
    if (viewMode === 'spread' && visibleTextPageIndices.includes(nextHit.pageIndex)) return
    jumpTextPage(nextHit.pageIndex)
  }

  const jumpToSearchDirectoryItem = (index: number) => {
    if (isEpub) {
      const hit = epubSearchHits[index]
      if (!hit) return
      setSearchCursor(index)
      setSearchNavigationEpoch((value) => value + 1)
      void renditionRef.current?.display?.(hit.cfi)
      return
    }
    if (sessionTextHits.length) {
      const hit = sessionTextHits[index]
      if (!hit) return
      setSearchCursor(index)
      setSearchNavigationEpoch((value) => value + 1)
      const nextPageIndex = findTextPageIndexByLocator(textPages, hit.locator)
      if (Number.isFinite(nextPageIndex) && nextPageIndex >= 0) jumpTextPage(nextPageIndex)
      return
    }
    const hit = textHits[index]
    if (!hit) return
    setSearchCursor(index)
    setSearchNavigationEpoch((value) => value + 1)
    if (viewMode === 'spread' && visibleTextPageIndices.includes(hit.pageIndex)) return
    jumpTextPage(hit.pageIndex)
  }

  const openReaderNote = (note: ReaderNoteItem) => {
    focusReaderNote(note)
  }

  const currentText = isEpub ? '' : (textPage?.text || '')
  const activeTranslationText = textPage ? pageTranslations[textPage.id] : ''
  const activeTranslationLoading = textPage ? !!translatingPageIds[textPage.id] : false
  const activeTranslationSkipped = textPage ? !!skippedTranslationPageIds[textPage.id] : false
  const displaySettingsPanel = (
    <div style={{ width: 286, display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '42px 1fr 34px', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>字号</span>
        <Slider min={13} max={26} value={fontSize} onChange={setFontSize} style={{ margin: 0 }} />
        <Text style={{ color: 'var(--gs-text-secondary)', fontSize: 12, textAlign: 'right' }}>{fontSize}</Text>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '42px 1fr 34px', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>行距</span>
        <Slider min={1.3} max={2.4} step={0.1} value={lineHeight} onChange={setLineHeight} style={{ margin: 0 }} />
        <Text style={{ color: 'var(--gs-text-secondary)', fontSize: 12, textAlign: 'right' }}>{lineHeight.toFixed(1)}</Text>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>版式</span>
        <Segmented size="small" value={viewMode} onChange={(value) => setViewMode(value as ViewMode)} options={[{ value: 'spread', label: '双页' }, { value: 'single', label: '单页' }]} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>主题</span>
        <Segmented size="small" value={theme} onChange={(value) => setTheme(value as ReaderTheme)} options={[{ value: 'paper', label: '纸白' }, { value: 'sepia', label: '护眼' }, { value: 'dark', label: '夜间' }]} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>简繁</span>
        <Segmented
          size="small"
          value={displayScript}
          onChange={(value) => onDisplayScriptChange?.(value as ReaderDisplayScript)}
          options={[
            { value: 'original', label: '原文' },
            { value: 'simplified', label: '简体' },
            { value: 'traditional', label: '繁体' },
          ]}
        />
      </div>
    </div>
  )
  const pageStep = translationOpen && !isEpub ? 1 : viewMode === 'spread' ? 2 : 1
  const queuedTranslationPages = useMemo(() => {
    if (isEpub || !translationOpen) return []
    return [textPageIndex, textPageIndex + 1, textPageIndex + 2]
      .map((index) => textPages[index])
      .filter((page) => page?.id && page.text)
  }, [isEpub, textPageIndex, textPages, translationOpen])
  const pageTitle = isEpub
    ? String(location?.start?.href || readRecordValue(readRecordValue(metadata, 'ebook_manifest'), 'title') || document?.title || 'EPUB')
    : textPage?.title || document?.title || '文本'
  const pageLabel = isEpub
    ? location?.start?.displayed
      ? `${location.start.displayed.page || 1}/${location.start.displayed.total || 1}`
      : 'EPUB'
    : `${textPageIndex + 1}/${textPages.length || 1}`

  useEffect(() => {
    if (isEpub || !translationOpen || !queuedTranslationPages.length) return
    queuedTranslationPages.forEach((page, index) => {
      if (pageTranslations[page.id] || skippedTranslationPageIds[page.id]) return
      onTranslateCurrentPage?.(
        {
          pageId: page.id,
          readerPageKey: page.id,
          cachePageId: page.id,
          pageNum: page.sourcePageNum,
          text: page.text,
        },
        { priority: index === 0 ? 'current' : 'prefetch' },
      )
    })
  }, [isEpub, onTranslateCurrentPage, pageTranslations, queuedTranslationPages, skippedTranslationPageIds, translationOpen])

  useEffect(() => {
    if (!bookTranslationRequest) return
    if (handledBookTranslationRequestRef.current === bookTranslationRequest) return
    handledBookTranslationRequestRef.current = bookTranslationRequest
    if (isEpub) {
      message.info('当前 EPUB 原生渲染暂不支持整书对照翻译，请使用导入后的文本阅读器页面')
      return
    }
    const bookPages = textPages.filter((page) => page?.id && page.text)
    if (!bookPages.length) {
      message.info('当前阅读器没有可翻译文本')
      return
    }
    setTranslationOpen(true)
    bookPages.forEach((page) => {
      onTranslateCurrentPage?.(
        {
          pageId: page.id,
          readerPageKey: page.id,
          cachePageId: page.id,
          pageNum: page.sourcePageNum,
          text: page.text,
        },
        { priority: 'book' },
      )
    })
    message.success(`已按阅读器页面加入整书翻译队列：${bookPages.length} 页`)
  }, [bookTranslationRequest, isEpub, onTranslateCurrentPage, textPages])

  const renderTocItems = (items: TocNode[]) => items.map((item) => {
    const active = item.id === activeTocId || (!isEpub && normalizeHref(item.href) === normalizeHref(textPage?.href || ''))
    const displayLabel = transformReaderDisplayText(item.label, displayScript)
    return (
      <div key={item.id}>
        <button
          type="button"
          title={displayLabel}
          onClick={() => jumpToc(item)}
          style={{
            width: '100%',
            border: active ? '1px solid rgba(255,245,220,0.36)' : '1px solid transparent',
            borderRadius: 6,
            padding: '7px 8px',
            paddingLeft: 10 + Math.max(0, item.level - 1) * 14,
            marginBottom: 4,
            textAlign: 'left',
            cursor: item.href ? 'pointer' : 'default',
            background: active ? 'rgb(184, 134, 83)' : 'transparent',
            color: active ? 'rgb(255, 236, 202)' : '#3e2b18',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: active ? 700 : 500,
          }}
        >
          {displayLabel}
        </button>
        {item.subitems?.length ? renderTocItems(item.subitems) : null}
      </div>
    )
  })

  const renderSearchDirectory = () => {
    if (!localSearch.trim()) {
      if (!readerNotes.length) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无摘录" />
      }
      return (
        <div className="reader-note-list">
          {readerNotes.map((note) => {
            const locator = getReaderNoteLocator(note)
            const text = getReaderNoteHighlightText(note, locator) || note.excerpt
            const noteColor = normalizeHighlightColor(note.color)
            const pageLabel = note.page_num ? `第 ${note.page_num} 页` : '未分页'
            const createdAt = getReaderNoteDate(note.updated_at || note.created_at)
            return (
              <div
                key={note.id}
                role="button"
                tabIndex={0}
                className="reader-note-list-item"
                onClick={() => openReaderNote(note)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openReaderNote(note)
                  }
                }}
                style={{
                  border: '1px solid rgba(112,75,35,0.24)',
                  background: 'rgba(72,45,18,0.10)',
                  color: '#3e2b18',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 12, fontWeight: 700 }}>
                    <span className="reader-note-color-dot" style={{ background: noteColor }} />
                    <span>{pageLabel}</span>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }}>
                    {createdAt ? <span style={{ color: '#7d6648', fontSize: 11 }}>{createdAt}</span> : null}
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      title="取消摘录"
                      aria-label="取消摘录"
                      onClick={(event) => {
                        event.stopPropagation()
                        deleteReaderNote(note)
                      }}
                    />
                  </span>
                </div>
                <div style={{ color: '#3e2b18', fontSize: 12, lineHeight: 1.6 }}>
                  {transformReaderDisplayText(String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180), displayScript)}
                </div>
              </div>
            )
          })}
        </div>
      )
    }
    if (isEpub && epubSearchLoading && searchDirectoryItems.length === 0) {
      return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>
    }
    if (searchDirectoryItems.length === 0) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无命中" />
    }
    return (
      <div
        data-reader-search-result-list="true"
        style={{
          minHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: 6,
          borderRadius: 6,
          border: '1px solid rgba(112,75,35,0.22)',
          background: '#dcc8aa',
        }}
      >
        <Space direction="vertical" size={6} style={{ width: '100%', flex: 1 }}>
          {visibleSearchDirectoryItems.map((item) => (
            <button
              key={item.key}
              type="button"
              data-reader-search-result-item="true"
              data-reader-search-result-active={item.active ? 'true' : undefined}
              onClick={() => jumpToSearchDirectoryItem(item.index)}
              style={{
                width: '100%',
                border: `1px solid ${item.active ? 'rgba(112,75,35,0.46)' : 'rgba(112,75,35,0.24)'}`,
                borderRadius: 6,
                padding: '8px 9px',
                textAlign: 'left',
                cursor: 'pointer',
                background: item.active ? 'rgba(184, 134, 83, 0.34)' : 'rgba(72,45,18,0.10)',
                color: '#3e2b18',
                fontSize: 12,
                lineHeight: 1.55,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700 }}>#{item.index + 1}</span>
                <span style={{ color: '#7d6648' }}>{item.pageLabel}</span>
              </div>
              <span>{renderMarkedSnippet(item.snippet, localSearch, displayScript)}</span>
            </button>
          ))}
        </Space>
        {searchDirectoryItems.length > READER_SEARCH_RESULT_PAGE_SIZE ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid rgba(112,75,35,0.20)',
              background: 'rgba(72,45,18,0.30)',
            }}
          >
            <Pagination
              className="gs-hit-pagination"
              size="small"
              simple
              current={searchResultPageSafe}
              pageSize={READER_SEARCH_RESULT_PAGE_SIZE}
              total={searchDirectoryItems.length}
              showSizeChanger={false}
              onChange={(page) => setSearchResultPage(page)}
            />
          </div>
        ) : null}
      </div>
    )
  }

  const renderSidebar = () => (
    <aside className="ebook-reader-sidebar" style={{ width: 282, flex: '0 0 282px', border: '1px solid rgba(112,75,35,0.22)', borderRadius: 8, background: '#efe3ce', boxShadow: '0 16px 32px rgba(48,30,12,0.18)', display: 'flex', flexDirection: 'column', overflow: 'hidden', margin: 12, marginRight: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(112,75,35,0.22)' }}>
        <Segmented
          size="small"
          block
          value={readerSidebarTab}
          onChange={(value) => setReaderSidebarTab(value as ReaderSidebarTab)}
          options={[
            { value: 'toc', label: '目录' },
            {
              value: 'search',
              label: localSearch.trim()
                ? `检索结果${searchDirectoryItems.length ? ` ${searchDirectoryItems.length}` : ''}`
                : `摘录${readerNotes.length ? ` ${readerNotes.length}` : ''}`,
            },
          ]}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {readerSidebarTab === 'search'
          ? renderSearchDirectory()
          : loading
            ? <Spin size="small" />
            : toc.length
              ? renderTocItems(toc)
              : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无目录" />}
      </div>
    </aside>
  )

  const renderTextPage = () => {
    const hitStartIndex = textHits.filter((hit) => hit.pageIndex < textPageIndex).length
    const currentNoteHighlights = effectiveTextSearchQuery.trim() ? [] : readerNoteHighlightsByPage.get(textPageIndex) || []
    return (
      <div ref={textScrollRef} data-reader-scroll="true" onClick={handleReaderNoteClick} style={{ height: '100%', overflow: 'auto', padding: '18px 28px' }}>
        <article
          onMouseUp={(event) => updateReaderSelection(textPageIndex, event)}
          style={{
            width: viewMode === 'spread' ? 'min(980px, 92%)' : 'min(760px, 92%)',
            minHeight: 'calc(100vh - 250px)',
            margin: '0 auto',
            padding: '54px 64px',
            background: themed.page,
            color: themed.text,
            border: `1px solid ${themed.border}`,
            borderRadius: 6,
            boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
            fontFamily: "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif",
            fontSize,
            lineHeight,
            whiteSpace: 'pre-wrap',
            textAlign: 'justify',
          }}
        >
          <div style={{ color: themed.muted, fontSize: 12, display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
            <span>{transformReaderDisplayText(pageTitle, displayScript)}</span>
            <span>阅读节 {pageLabel}</span>
          </div>
          {currentText
            ? effectiveTextSearchQuery.trim()
              ? highlightText(transformReaderDisplayText(currentText, displayScript), transformReaderDisplayText(effectiveTextSearchQuery, displayScript), activeTextHit?.globalIndex ?? -1, { value: hitStartIndex }, undefined, effectiveHighlightColor, searchActiveOnly)
              : renderReaderNoteHighlightedText(currentText, currentNoteHighlights, displayScript, `ebook-page-note-${textPageIndex}`)
            : <Text style={{ color: themed.muted }}>暂无文本</Text>}
        </article>
      </div>
    )
  }

  const renderTextPages = () => {
    return (
      <div
        ref={textScrollRef}
        data-reader-scroll="true"
        data-reader-current-leaf={textPageIndex}
        data-reader-active-section={activeHref}
        data-reader-column-index={0}
        data-reader-column-count={translationOpen ? 2 : visibleTextPageIndices.length}
        data-search-navigation-epoch={searchNavigationEpoch}
        onClick={handleReaderNoteClick}
        style={{ height: '100%', overflow: 'auto', padding: '18px 28px' }}
      >
        {translationOpen && textPage ? (
          <ParallelTranslationView
            title={transformReaderDisplayText(pageTitle, displayScript)}
            pageLabel={pageLabel}
            sourceText={currentText}
            translationText={activeTranslationText}
            units={textPage ? pageTranslationUnits[textPage.id] || [] : []}
            loading={activeTranslationLoading}
            skipped={activeTranslationSkipped}
            themeName={theme}
            themeStyle={themed}
            fontSize={fontSize}
            lineHeight={lineHeight}
            activeSegmentId={activeParallelSegmentId}
            onActiveSegmentChange={setActiveParallelSegmentId}
            onSelectedTextChange={onSelectedTextChange}
            onUpdateUnit={onUpdateTranslationUnit && textPage
              ? (unitId, translationText) => onUpdateTranslationUnit(textPage.id, unitId, translationText)
              : undefined}
            onRetranslateUnit={onRetranslateTranslationUnit && textPage
              ? (unitId) => onRetranslateTranslationUnit({
                  pageId: textPage.id,
                  readerPageKey: textPage.id,
                  cachePageId: textPage.id,
                  pageNum: textPage.sourcePageNum,
                  text: currentText,
                }, unitId)
              : undefined}
            onClose={() => setTranslationOpen(false)}
          />
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: viewMode === 'spread' ? 'minmax(360px, 1fr) minmax(360px, 1fr)' : 'minmax(360px, 860px)',
            gap: viewMode === 'spread' ? 24 : 0,
            justifyContent: 'center',
            alignItems: 'start',
          }}>
            {visibleTextPages.map((page, offset) => {
              if (!page) return null
              const pageIndex = visibleTextPageIndices[offset] ?? textPageIndex + offset
              const pageHitStartIndex = textHits.filter((hit) => hit.pageIndex < pageIndex).length
              const activePageHitIndex = activeTextHit && activeTextHit.pageIndex === pageIndex ? activeTextHit.globalIndex : -1
              const noteHighlights = effectiveTextSearchQuery.trim() ? [] : readerNoteHighlightsByPage.get(pageIndex) || []
              const isCurrent = pageIndex === textPageIndex
              return (
                <article
                  key={page.id}
                  data-reader-page="true"
                  data-reader-page-viewport="true"
                  data-reader-leaf-index={pageIndex}
                  data-reader-content="true"
                  onMouseUp={(event) => updateReaderSelection(pageIndex, event)}
                  style={{
                    width: '100%',
                    minHeight: 'calc(100vh - 250px)',
                    margin: '0 auto',
                    padding: '54px 64px',
                    background: themed.page,
                    color: themed.text,
                    border: `1px solid ${themed.border}`,
                    borderRadius: 6,
                    boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
                    fontFamily: "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif",
                    fontSize,
                    lineHeight,
                    whiteSpace: 'pre-wrap',
                    textAlign: 'justify',
                    opacity: isCurrent || viewMode !== 'spread' ? 1 : 0.98,
                  }}
                >
                  <div style={{ color: themed.muted, fontSize: 12, display: 'flex', justifyContent: 'space-between', marginBottom: 24, gap: 12 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{transformReaderDisplayText(page.title, displayScript)}</span>
                    <span>{pageIndex + 1}/{textPages.length || 1}</span>
                  </div>
                  <div>
                    {page.text
                      ? renderTextContent(page.text, effectiveTextSearchQuery, activePageHitIndex, pageHitStartIndex, undefined, displayScript, effectiveHighlightColor, searchActiveOnly, noteHighlights)
                      : <Text style={{ color: themed.muted }}>暂无文本</Text>}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
      {readerSelection ? (
        <div className="reader-selection-toolbar" style={{ left: readerSelection.x, top: readerSelection.y }}>
          {!isEpub && textPage ? (
            <div className="reader-highlight-palette" aria-label="摘录高亮颜色">
              {HIGHLIGHT_COLOR_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="reader-highlight-swatch"
                  title={option.label}
                  aria-label={option.label}
                  style={{ background: option.value }}
                  onClick={() => void saveCurrentTextExcerpt(option.value)}
                />
              ))}
            </div>
          ) : null}
          <Button
            className="reader-selection-icon-button"
            size="small"
            icon={<RobotOutlined />}
            title="AI 摘要选中内容"
            loading={summaryLoading}
            onClick={() => void summarizeText(readerSelection.text, 'selection')}
          />
          <Button
            className="reader-selection-icon-button"
            size="small"
            icon={<CopyOutlined />}
            title="复制直接引用"
            onClick={() => void copyDirectQuote()}
          />
        </div>
      ) : null}
      {readerNoteMenu ? (
        <div className="reader-selection-toolbar" style={{ left: readerNoteMenu.x, top: readerNoteMenu.y }}>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              const note = readerNotes.find((item) => item.id === readerNoteMenu.noteId)
              if (note) deleteReaderNote(note)
            }}
          >
            取消摘录
          </Button>
        </div>
      ) : null}
      <Modal
        title="AI 摘要"
        open={summaryModalOpen}
        onCancel={() => setSummaryModalOpen(false)}
        width={760}
        footer={[
          <Button key="save" type="primary" disabled={!summaryMarkdown.trim()} onClick={() => void saveSummaryAsNote()}>保存为研究笔记</Button>,
          <Button key="close" onClick={() => setSummaryModalOpen(false)}>关闭</Button>,
        ]}
      >
        {summaryLoading ? <div style={{ padding: 32, textAlign: 'center' }}><RobotOutlined /> 正在生成摘要...</div> : <AiMarkdown content={summaryMarkdown} />}
      </Modal>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
        <Space size={8} wrap>
          <Button size="small" icon={<BarsOutlined />} type={tocOpen ? 'primary' : 'default'} onClick={() => setTocOpen((value) => !value)}>目录</Button>
          <Text style={{ color: 'var(--gs-text-secondary)', fontSize: 13 }}>
            {isEpub ? `EPUB ${pageLabel}` : `阅读节 ${pageLabel}`}
          </Text>
          {sourceLabel ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                minHeight: 22,
                padding: '2px 8px',
                borderRadius: 999,
                border: `1px solid ${hexToRgba(effectiveHighlightColor, 0.34)}`,
                background: hexToRgba(effectiveHighlightColor, 0.16),
                color: 'var(--gs-text-secondary)',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 999, background: effectiveHighlightColor }} />
              {sourceLabel}
            </span>
          ) : null}
          <Button size="small" icon={<LeftOutlined />} onClick={goPrevious} />
          <Button size="small" icon={<RightOutlined />} onClick={goNext} />
        </Space>
        <Space size={4} wrap>
          <Switch
            data-reader-translation-toggle="true"
            size="small"
            checked={translationOpen}
            disabled={isEpub || !textPage || !currentText}
            loading={activeTranslationLoading}
            onChange={(checked) => {
              setTranslationOpen(checked)
              if (checked && textPage && currentText) {
                onTranslateCurrentPage?.(
                  {
                    pageId: textPage.id,
                    readerPageKey: textPage.id,
                    cachePageId: textPage.id,
                    pageNum: textPage.sourcePageNum,
                    text: currentText,
                  },
                  { priority: 'current' },
                )
              }
            }}
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
              <LlmProfileSelector width={170} />
              <Select
                size="small"
                value={translationGlossaryProjectId || ''}
                onChange={(value) => onTranslationGlossaryProjectChange?.(value)}
                style={{ width: 170 }}
                optionFilterProp="label"
                showSearch
                options={[
                  { value: '', label: '全局术语' },
                  ...translationGlossaryProjects.map((project) => ({ value: project.id, label: project.name })),
                ]}
              />
              <Button
                size="small"
                icon={<PlusOutlined />}
                disabled={!selectedTextForGlossary.trim()}
                onClick={() => onAddSelectedTerm?.()}
              >
                加入术语
              </Button>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                disabled={!textPage || !currentText}
                onClick={() => {
                  if (!textPage || !currentText) return
                  onTranslateCurrentPage?.({
                    pageId: textPage.id,
                    readerPageKey: textPage.id,
                    cachePageId: textPage.id,
                    pageNum: textPage.sourcePageNum,
                    text: currentText,
                  }, { priority: 'current', force: true })
                }}
              >
                重译本页
              </Button>
            </>
          ) : null}
          <Input
            data-reader-search-input="true"
            size="small"
            prefix={<SearchOutlined />}
            allowClear
            value={localSearch}
            onChange={(event) => { setLocalSearch(event.target.value); setSearchCursor(-1); setLocalSearchSession(null); setReaderHighlightColor(''); onSearchKeywordChange?.(event.target.value) }}
            placeholder="搜索文内关键词"
            style={{ width: 170 }}
          />
          <Button size="small" icon={<LeftOutlined />} disabled={isEpub ? !epubSearchHits.length : !canNavigateTextSearch} onClick={() => jumpSearch(-1)} />
          <Text data-reader-search-counter="true" style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>{isEpub ? epubSearchLabel : textSearchLabel}</Text>
          <Button size="small" icon={<RightOutlined />} data-reader-search-next="true" disabled={isEpub ? !epubSearchHits.length : !canNavigateTextSearch} onClick={() => jumpSearch(1)} />
          <Popover trigger="click" placement="bottomRight" content={displaySettingsPanel}>
            <Button size="small" icon={<SettingOutlined />}>显示设置</Button>
          </Popover>
        </Space>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {tocOpen ? renderSidebar() : null}
        <main style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden', background: themed.shell }}>
          {tocBusy ? (
            <div className="reader-toc-busy-overlay">
              <Spin size="small" />
              <div>
                <div className="reader-toc-busy-title">{tocBusyTitle}</div>
                <div className="reader-toc-busy-hint">{tocBusyHint}</div>
              </div>
            </div>
          ) : null}
          {isEpub ? (
            <>
              <div ref={containerRef} style={{ position: 'absolute', inset: 18, background: themed.page, border: `1px solid ${themed.border}`, borderRadius: 6, boxShadow: '0 16px 40px rgba(0,0,0,0.35)', overflow: 'hidden' }} />
              {!document?.file_path && !loading ? <Empty image={<FileTextOutlined style={{ fontSize: 48, opacity: 0.2 }} />} description="未找到 EPUB 原始文件" style={{ marginTop: '20%' }} /> : null}
            </>
          ) : (
            textPages.length ? renderTextPages() : <Empty image={<FileTextOutlined style={{ fontSize: 48, opacity: 0.2 }} />} description="未找到可阅读文本" style={{ marginTop: '20%' }} />
          )}
          <Button aria-label="上一页" icon={<LeftOutlined />} data-reader-page-prev="true" onClick={goPrevious} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', zIndex: 8, width: 38, height: 54, borderRadius: 10, borderColor: themed.border, color: themed.text, background: theme === 'dark' ? 'rgba(15,16,18,0.72)' : 'rgba(255,250,240,0.78)', boxShadow: '0 10px 26px rgba(0,0,0,0.24)' }} />
          <Button aria-label="下一页" icon={<RightOutlined />} data-reader-page-next="true" onClick={goNext} style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', zIndex: 8, width: 38, height: 54, borderRadius: 10, borderColor: themed.border, color: themed.text, background: theme === 'dark' ? 'rgba(15,16,18,0.72)' : 'rgba(255,250,240,0.78)', boxShadow: '0 10px 26px rgba(0,0,0,0.24)' }} />
        </main>
      </div>
    </div>
  )
}
