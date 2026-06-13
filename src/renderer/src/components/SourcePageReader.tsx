import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Empty, Input, Modal, Pagination, Popover, Segmented, Select, Slider, Space, Spin, Switch, Typography, message } from 'antd'
import type { InputRef } from 'antd/es/input'
import {
  BarsOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  LeftOutlined,
  LinkOutlined,
  PushpinOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import OpenCC from 'opencc-js'
import type { AiLayoutCacheItem, Document, DocumentPage, ReaderTranslationOptions, ReaderTranslationPayload, ResearchNote, ResearchProject, SearchHitLocator, SearchSessionState, TocItemSource, TocItemV2 } from '@shared/types'
import { getCitationPageNumber, getReadablePageElements, getReadablePageText, type ReadablePageElement } from '../utils/ocrText'
import { renderOcrInlineText } from '../utils/ocrInlineRender'
import { buildViewerSearchHits } from '../utils/searchHitCount'
import { buildDirectQuoteCitationText, resolveDocumentCitation } from '../utils/citations'
import { getErrorMessage } from '@shared/errors'
import { isParallelTranslationDisplayReady } from '@shared/parallel-translation'
import { normalizeTranslationSourceText } from '@shared/translation-cache'
import { getCanonicalPageTranslationSourceText } from '@shared/translation-source'
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
type TocDraftItem = TocItemV2 & { draftKey: string; originalSignature?: string }
type ReaderSearchMatch = {
  pageIndex: number
  charIndex: number
  elementIndex: number
  occurrenceIndex: number
  pageOccurrenceIndex?: number
  globalIndex?: number
  sessionIndex?: number
}
type PendingSearchTarget = { anchorId: string; active?: boolean; text?: string; hitIndex?: number; token?: number }
type SearchDirectoryItem = { index: number; key: string; pageLabel: string; snippet: string; active: boolean; session: boolean }
type PageLocatorIndex = { byId: Map<string, number>; byNum: Map<number, number> }
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
  elementIndex: number
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
type TocResolveState = { resolved: number; total: number; running: boolean; unresolved: number }
type JsonRecord = Record<string, unknown>
type ReaderDocument = Partial<Document>
type ReaderSourcePage = Partial<DocumentPage> & {
  title?: string | null
  href?: string | null
  source_hrefs?: string[]
  source_page_start_num?: number
  source_page_end_num?: number
  source_page_id?: string
}
type ReaderSourcePageWithId = ReaderSourcePage & { id: string }
type ReaderVirtualPage = ReaderSourcePage
type TocPageScan = {
  normalized: string
  lineKeys: string[]
  headingKeys: string[]
  isTocPage: boolean
}
const TOC_PAGE_REF_SUFFIX_RE = /(?:\.{2,}|…{1,}|·{2,}|-{2,}|—{2,}|[|｜/／]|\s|第\s*)(?:\d{1,5}|[一二两兩三四五六七八九十百千〇零○]{1,8})(?:\s*(?:页|頁|p\.?|P\.?))?\s*$/i
const BODY_LIKE_LAYOUT_LABEL_RE = /^(?:text|body|paragraph|content|main text|body text|article|section|ai layout|ocr layout)$/
const STRUCTURAL_LAYOUT_LABEL_RE = /^(?:reference|references|abstract|caption|figure caption|table caption|title|heading|section title|doc title|document title|toc|table of contents|contents|catalog|catalogue)$/
const MARKED_FOOTNOTE_TEXT_RE = /^(?:\[\d+\]|[①②③④⑤⑥⑦⑧⑨⑩]|注[:：]|註[:：])/
const BARE_NUMBERED_FOOTNOTE_TEXT_RE = /^\d{1,3}[).、．]/
const TOC_AUTO_ANCHOR_SCAN_MAX_PAGES = 500
type ReaderElementGroup = {
  element: ReadablePageElement
  index: number
  anchorId: string
  activeHit: number | null
  activeGlobalHitIndex?: number | null
  globalSearchStartIndex?: number | null
  globalSearchHitIndexes?: number[] | null
}
type ReaderPageMetrics = {
  pageWidth: number
  pageHeight: number
  textWidth: number
  textHeight: number
  charsPerLine: number
  linesPerPage: number
  limit: number
}
const AI_LAYOUT_FRONTEND_TIMEOUT_MS = 90_000
const READER_IMAGE_CACHE_LIMIT = 24
const readerImageDataUrlCache = new Map<string, string>()
const readerImageDataUrlPromises = new Map<string, Promise<string>>()

interface SourcePageReaderProps {
  document: ReaderDocument
  pages: ReaderSourcePage[]
  searchPages?: ReaderSourcePage[]
  currentPageIndex: number
  searchKeyword?: string
  highlightColor?: string
  sourceLabel?: string
  searchSession?: SearchSessionState
  pageTranslations?: Record<string, string>
  translatingPageIds?: Record<string, boolean>
  skippedTranslationPageIds?: Record<string, boolean>
  translationGlossaryProjectId?: string
  translationGlossaryProjects?: ResearchProject[]
  selectedTextForGlossary?: string
  displayScript?: ReaderDisplayScript
  bookTranslationRequest?: number
  onDisplayScriptChange?: (script: ReaderDisplayScript) => void
  onPageIndexChange: (pageIndex: number) => void
  onSearchKeywordChange?: (keyword: string) => void
  onSelectedTextChange?: (text: string) => void
  onContextTextChange?: (text: string) => void
  onDocumentMetadataChange?: (metadata: JsonRecord) => void
  onTranslateCurrentPage?: (payload: ReaderTranslationPayload, options?: ReaderTranslationOptions) => void
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
  paper: { shell: 'linear-gradient(90deg, #1d1712, #241b14)', page: '#fff8e9', text: '#382718', muted: '#9c7d57', border: 'rgba(120,80,42,0.2)' },
  sepia: { shell: '#17130f', page: '#f4ead5', text: '#3b2c1e', muted: '#8d6e4c', border: 'rgba(120,80,42,0.24)' },
  dark: { shell: '#0f1114', page: '#171a1f', text: '#d8d3c8', muted: '#8d9096', border: 'rgba(255,255,255,0.1)' },
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReaderSourcePageWithId(page: ReaderSourcePage | null | undefined): page is ReaderSourcePageWithId {
  return Boolean(page?.id)
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

function parseMaybeRecord(value: unknown): JsonRecord {
  const parsed = parseMaybeJson(value, {})
  return isJsonRecord(parsed) ? parsed : {}
}

function parseMetadata(doc: ReaderDocument | null | undefined): JsonRecord {
  return parseMaybeRecord(doc?.metadata)
}

function normalizeTitle(value: string): string {
  return String(value || '').replace(/^#{1,6}\s*/, '').replace(/\s+/g, ' ').trim()
}

function normalizeForMatch(value: string): string {
  return toSimplified(normalizeTitle(value))
    .normalize('NFKC')
    .replace(/[《》「」『』“”‘’()[\]{}<>（）【】〈〉、，。；：:;,.!?！？·\-—–\s]/g, '')
    .toLowerCase()
}

function getPageText(page: ReaderSourcePage | null | undefined): string {
  return page ? getReadablePageText(page).trim() : ''
}

function getAiLayoutPageText(page: ReaderSourcePage | null | undefined, aiLayoutEnabled: boolean, aiLayoutByPageId: Record<string, string>): string {
  const pageId = page?.id
  const aiText = aiLayoutEnabled && pageId ? String(aiLayoutByPageId[pageId] || '').trim() : ''
  if (!aiText) return getPageText(page)
  return aiLayoutTextToElements(aiText)
    .map((element) => String(element.text || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function getCanonicalTranslationPageText(page: ReaderSourcePage | null | undefined, aiLayoutEnabled: boolean, aiLayoutByPageId: Record<string, string>): string {
  const sourceText = getCanonicalPageTranslationSourceText(page)
    || normalizeTranslationSourceText(getAiLayoutPageText(page, aiLayoutEnabled, aiLayoutByPageId))
  return sourceText
}

function getTranslationCachePageId(page: ReaderSourcePage | null | undefined): string {
  return String(page?.source_page_id || page?.id || '')
}

function getPageElements(page: ReaderSourcePage | null | undefined): ReadablePageElement[] {
  return page ? getReadablePageElements(page) : []
}

function isEbookReaderDocument(document: ReaderDocument, pages: ReaderSourcePage[]): boolean {
  const metadata = parseMetadata(document)
  const manifest = readRecordValue(metadata, 'ebook_manifest')
  if (metadata.file_kind === 'ebook' || metadata.file_kind === 'text' || metadata.import_source_type === 'epub' || readRecordValue(manifest, 'format') === 'epub') return true
  return (pages || []).some((page) => {
    const parsed = parseMaybeRecord(page?.ocr_result)
    return ['ebook_section', 'ebook_text'].includes(String(readRecordValue(parsed, 'source_type') || ''))
  })
}

function estimateTextUnits(text: string): number {
  let units = 0
  for (const char of String(text || '')) {
    if (/\s/.test(char)) units += 0.35
    else if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)) units += 1
    else units += 0.58
  }
  return units
}

function getReaderPageMetrics(viewMode: ViewMode, fontSize: number, lineHeight: number, viewportHeight: number, viewportWidth: number): ReaderPageMetrics {
  const verticalChrome = 56
  const horizontalChrome = viewMode === 'spread' ? 84 : 68
  const spreadGap = viewMode === 'spread' ? 24 : 0
  const availableHeight = Math.max(420, viewportHeight - verticalChrome)
  const availableWidth = Math.max(360, viewportWidth - horizontalChrome - spreadGap)
  const pageHeight = availableHeight
  const pageWidth = viewMode === 'spread'
    ? Math.min(820, Math.max(320, availableWidth / 2))
    : Math.min(920, Math.max(320, availableWidth))
  const textWidth = Math.max(240, pageWidth - 84)
  const textHeight = Math.max(300, pageHeight - 92)
  const charsPerLine = Math.max(18, Math.floor(textWidth / Math.max(8, fontSize * 0.86)))
  const linesPerPage = Math.max(12, Math.floor(textHeight / Math.max(18, fontSize * lineHeight)))
  const layoutReserveLines = viewMode === 'spread' ? 1.4 : 1.1
  return {
    pageWidth,
    pageHeight,
    textWidth,
    textHeight,
    charsPerLine,
    linesPerPage,
    limit: Math.max(420, Math.floor(charsPerLine * Math.max(8, linesPerPage - layoutReserveLines) * 0.86)),
  }
}

function getEbookPaginationLimit(viewMode: ViewMode, fontSize: number, lineHeight: number, viewportHeight: number, viewportWidth: number): number {
  return getReaderPageMetrics(viewMode, fontSize, lineHeight, viewportHeight, viewportWidth).limit
}

function estimateEbookLines(text: string, metrics: ReaderPageMetrics, type: ReadablePageElement['type'], isFootnote: boolean): number {
  const rawUnits = estimateTextUnits(text)
  const charsPerLine = Math.max(12, metrics.charsPerLine)
  const contentLines = Math.max(1, Math.ceil(rawUnits / charsPerLine))
  if (isFootnote) return contentLines * 0.72 + 0.45
  if (type === 'heading') return contentLines * 1.08 + 0.95
  if (type === 'table') return Math.max(3, contentLines * 1.15 + 1.35)
  if (type === 'toc') return Math.max(3, contentLines * 1.05 + 1.2)
  if (type === 'image') return 8.5
  return contentLines + 0.58
}

function splitEbookTextAtUnits(text: string, targetUnits: number): [string, string] {
  const source = String(text || '').trim()
  if (!source || estimateTextUnits(source) <= targetUnits) return [source, '']
  const chars = Array.from(source)
  let units = 0
  let targetIndex = 0
  const breakIndexes: number[] = []

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (/\s/.test(char)) units += 0.35
    else if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)) units += 1
    else units += 0.58
    if (/[。！？!?；;：:，,、\s]/.test(char)) breakIndexes.push(index + 1)
    if (units <= targetUnits) targetIndex = index + 1
  }

  const minBreakIndex = Math.max(80, Math.floor(targetIndex * 0.58))
  const breakIndex = [...breakIndexes].reverse().find((index) => index <= targetIndex && index >= minBreakIndex)
    || Math.max(80, targetIndex)
  const head = chars.slice(0, breakIndex).join('').trim()
  const tail = chars.slice(breakIndex).join('').trim()
  return head && tail ? [head, tail] : [source, '']
}

function getEbookElementUnits(element: ReadablePageElement, text: string, type: ReadablePageElement['type'], isFootnote: boolean): number {
  const rawUnits = estimateTextUnits(text)
  if (isFootnote) return rawUnits * 0.62 + 38
  if (type === 'heading') return Math.max(110, rawUnits * 1.45 + 60)
  if (type === 'table') return rawUnits * 1.35 + 90
  if (type === 'toc') return rawUnits * 1.25 + 80
  if (type === 'image') return Math.max(260, rawUnits + 220)
  return rawUnits + Math.min(90, Math.max(28, rawUnits * 0.12))
}

function splitEbookParagraphText(text: string, limit: number): string[] {
  const source = String(text || '').trim()
  if (estimateTextUnits(source) <= limit) return [source]
  const chunks: string[] = []
  let current = ''
  const pieces = source.split(/(?<=[。！？!?；;：:])|(?<=\.)\s+|\n+/).map((item) => item.trim()).filter(Boolean)
  const sourcePieces = pieces.length ? pieces : source.match(/.{1,180}/g) || [source]
  sourcePieces.forEach((piece) => {
    if (!current) {
      current = piece
      return
    }
    if (estimateTextUnits(`${current}${piece}`) > limit) {
      chunks.push(current.trim())
      current = piece
    } else {
      current = `${current}${/[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(piece) ? ' ' : ''}${piece}`
    }
  })
  if (current.trim()) chunks.push(current.trim())
  return chunks.flatMap((chunk) => estimateTextUnits(chunk) > limit * 1.35 ? (chunk.match(new RegExp(`.{1,${Math.max(120, Math.floor(limit))}}`, 'g')) || [chunk]) : [chunk])
}

function buildEbookVirtualPages(pages: ReaderSourcePage[], viewMode: ViewMode, fontSize: number, lineHeight: number, viewportHeight: number, viewportWidth: number): ReaderVirtualPage[] {
  const metrics = getReaderPageMetrics(viewMode, fontSize, lineHeight, viewportHeight, viewportWidth)
  const limit = metrics.limit
  const pageLineLimit = Math.max(10, metrics.linesPerPage - 0.25)
  const virtualPages: ReaderVirtualPage[] = []
  let buffer: ReadablePageElement[] = []
  let bufferLines = 0
  let sourceStartPageNum = Number(pages[0]?.page_num || 1)
  let sourceEndPageNum = sourceStartPageNum
  let sourceStartHref = ''
  let sourceEndHref = ''
  let sourceHrefs: string[] = []
  let virtualPageNum = 1
  let cursor = 0

  const pushVirtualPage = () => {
    if (!buffer.length) return
    const text = buffer.map((element) => element.text).filter(Boolean).join('\n\n')
    const pageSourceHrefs = Array.from(new Set(sourceHrefs.filter(Boolean)))
    virtualPages.push({
      id: `ebook-virtual-${virtualPageNum}`,
      source_page_id: buffer[0]?.label || '',
      source_page_start_num: sourceStartPageNum,
      source_page_end_num: sourceEndPageNum,
      source_hrefs: pageSourceHrefs,
      page_num: virtualPageNum,
      ocr_text: text,
      proofed_text: null,
      proof_status: 'completed',
      ocr_status: 'completed',
      has_text: true,
      ocr_result: JSON.stringify({
        source_type: 'ebook_virtual_page',
        ebook: {
          source_start_page_num: sourceStartPageNum,
          source_end_page_num: sourceEndPageNum,
          source_start_href: sourceStartHref,
          source_end_href: sourceEndHref,
          source_href: sourceStartHref,
          source_hrefs: pageSourceHrefs,
        },
        layout_result: buffer.map((element) => ({
          type: element.type,
          label: element.label,
          text: element.text,
          rows: element.rows,
          rect: element.rect,
          imagePath: element.imagePath,
          charStart: element.charStart,
          charEnd: element.charEnd,
        })),
      }),
    })
    virtualPageNum += 1
    buffer = []
    bufferLines = 0
    cursor = 0
    sourceStartHref = ''
    sourceEndHref = ''
    sourceHrefs = []
  }

  pages.forEach((page) => {
    const sourcePageNum = Number(page?.page_num || sourceEndPageNum)
    const pageParsed = parseMaybeRecord(page?.ocr_result)
    const ebookMeta = readRecordValue(pageParsed, 'ebook')
    const pageHref = String(readRecordValue(ebookMeta, 'href') || readRecordValue(ebookMeta, 'source_href') || page?.href || '')
    const elements = getPageElements(page)
    elements.forEach((element) => {
      const elementIsFootnote = isFootnoteElement(element)
      const parts = element.type === 'paragraph' ? splitEbookParagraphText(element.text, limit) : [element.text || element.label || 'image']
      parts.forEach((part, partIndex) => {
        let remaining = String(part || '').trim()
        while (remaining) {
          const rows = partIndex === 0 ? element.rows : undefined
          const type = element.type === 'heading' || element.type === 'table' || element.type === 'image' || element.type === 'toc' ? element.type : 'paragraph'
          const lines = estimateEbookLines(remaining, metrics, type, elementIsFootnote)
          const remainingLines = Math.max(0, pageLineLimit - bufferLines)
          let text = remaining

          if (!elementIsFootnote && buffer.length && lines > remainingLines && type === 'paragraph' && remainingLines >= 3) {
            const [head, tail] = splitEbookTextAtUnits(remaining, metrics.charsPerLine * Math.max(2, remainingLines - 0.7))
            if (head && tail) {
              text = head
              remaining = tail
            }
          }

          let nextLines = estimateEbookLines(text, metrics, type, elementIsFootnote)
          if (!elementIsFootnote && buffer.length && bufferLines + nextLines > pageLineLimit) {
            pushVirtualPage()
            if (text === remaining && nextLines > pageLineLimit && type === 'paragraph') {
              const [head, tail] = splitEbookTextAtUnits(remaining, metrics.charsPerLine * Math.max(8, pageLineLimit - 1))
              if (head && tail) {
                text = head
                remaining = tail
                nextLines = estimateEbookLines(text, metrics, type, elementIsFootnote)
              }
            }
          } else if (text === remaining) {
            remaining = ''
          }

          if (!text) {
            remaining = ''
            return
          }
          if (!buffer.length) {
            sourceStartPageNum = sourcePageNum
            sourceStartHref = pageHref
          }
          sourceEndPageNum = sourcePageNum
          sourceEndHref = pageHref || sourceEndHref
          if (pageHref && !sourceHrefs.includes(pageHref)) sourceHrefs.push(pageHref)
          const charStart = cursor
          buffer.push({
            ...element,
            type,
            text,
            rows,
            rect: element.rect,
            imagePath: element.imagePath,
            label: page?.id || element.label || 'ebook',
            charStart,
            charEnd: charStart + text.length,
          })
          cursor += text.length + 2
          bufferLines += nextLines
          if (text === remaining) remaining = ''
        }
      })
    })
  })
  pushVirtualPage()
  return virtualPages.length ? virtualPages : pages
}

function normalizeLayoutLabel(label?: string): string {
  return String(label || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isFootnoteElement(element: ReadablePageElement): boolean {
  const label = normalizeLayoutLabel(element.label)
  if (/^(?:footnote|footnotes|note|annotation|comment)$/.test(label)) return true
  if (/脚注|注释|注文|页注/.test(label)) return true
  if (STRUCTURAL_LAYOUT_LABEL_RE.test(label)) return false
  const text = String(element.text || '').trim()
  if (TOC_PAGE_REF_SUFFIX_RE.test(text)) return false
  if (text.length > 260) return false
  if (MARKED_FOOTNOTE_TEXT_RE.test(text)) return true
  if (BODY_LIKE_LAYOUT_LABEL_RE.test(label)) return false
  return BARE_NUMBERED_FOOTNOTE_TEXT_RE.test(text)
}

function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function getPageSourceHash(page: ReaderSourcePage): string {
  const normalizedText = getPageText(page).replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return hashText(`${page?.id || ''}:${normalizedText}`)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => window.clearTimeout(timer))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function parseMarkdownTableRows(text: string): string[][] {
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter((line) => /^\|.+\|$/.test(line))
  if (lines.length < 2) return []
  return lines
    .filter((line) => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))
}

function aiLayoutTextToElements(text: string): ReadablePageElement[] {
  const elements: ReadablePageElement[] = []
  let cursor = 0
  const blocks: string[] = []
  let current: string[] = []
  for (const line of String(text || '').replace(/\r/g, '\n').split('\n')) {
    const trimmed = line.trim()
    const isTableLine = /^\|.+\|$/.test(trimmed)
    const currentIsTable = current.length > 0 && current.every((item) => /^\|.+\|$/.test(item.trim()))
    if (!trimmed) {
      if (current.length) blocks.push(current.join('\n').trim())
      current = []
      continue
    }
    if (current.length && isTableLine !== currentIsTable) {
      blocks.push(current.join('\n').trim())
      current = [line]
      continue
    }
    current.push(line)
  }
  if (current.length) blocks.push(current.join('\n').trim())
  for (const block of blocks) {
    const tableRows = parseMarkdownTableRows(block)
    const normalized = tableRows.length > 0 ? tableRows.flat().join('\n') : block.replace(/^#{1,6}\s+/, '').trim()
    const isHeading = tableRows.length === 0 && normalized.length <= 80 && /^(?:第.{1,12}[章节卷]|[一二三四五六七八九十百千万\d]+[、.)）])/.test(normalized)
    elements.push({
      type: tableRows.length > 0 ? 'table' : isHeading ? 'heading' : 'paragraph',
      text: normalized,
      rows: tableRows.length > 0 ? tableRows : undefined,
      label: 'ai_layout',
      charStart: cursor,
      charEnd: cursor + normalized.length,
    })
    cursor += normalized.length + 2
  }
  return elements
}

function normalizeTableMatchText(value: string): string {
  return toSimplified(String(value || ''))
    .normalize('NFKC')
    .replace(/[《》「」『』“”‘’()[\]{}<>（）【】〈〉、，。；：:;,.!?！？·\-—–\s|｜]/g, '')
    .toLowerCase()
}

function getTableRowMatchFragments(table: ReadablePageElement): string[] {
  return (table.rows || [])
    .map((row) => normalizeTableMatchText(row.join('')))
    .filter((text) => text.length >= 2)
}

function countTableFragmentMatches(text: string, fragments: string[]): number {
  const normalized = normalizeTableMatchText(text)
  if (!normalized) return 0
  return fragments.reduce((count, fragment) => count + (fragment && normalized.includes(fragment) ? 1 : 0), 0)
}

function sourceTableIsPreserved(aiElements: ReadablePageElement[], sourceTable: ReadablePageElement): boolean {
  const sourceRowCount = sourceTable.rows?.length || 0
  if (sourceRowCount === 0) return true
  const fragments = getTableRowMatchFragments(sourceTable)
  return aiElements.some((element) => {
    const elementRowCount = element.rows?.length || 0
    if (element.type === 'table' && elementRowCount >= sourceRowCount) return true
    return element.type === 'table' && countTableFragmentMatches(element.text, fragments) >= Math.max(1, Math.min(2, fragments.length))
  })
}

function mergeAiLayoutElementsWithSourceTables(page: ReaderSourcePage, aiElements: ReadablePageElement[]): ReadablePageElement[] {
  const sourceElements = getPageElements(page)
  const sourceTables = sourceElements.filter((element) => element.type === 'table' && element.rows?.length)
  if (sourceTables.length === 0) return aiElements

  const next = [...aiElements]
  for (const sourceTable of sourceTables) {
    if (sourceTableIsPreserved(next, sourceTable)) continue
    const fragments = getTableRowMatchFragments(sourceTable)
    const hostIndex = next.findIndex((element) => (
      element.type !== 'table'
      && countTableFragmentMatches(element.text, fragments) >= Math.max(1, Math.min(2, fragments.length))
    ))
    const tableElement: ReadablePageElement = {
      ...sourceTable,
      label: sourceTable.label || 'source_table',
      charStart: hostIndex >= 0 ? next[hostIndex].charStart : Math.max(0, Number(next[next.length - 1]?.charEnd || 0) + 2),
      charEnd: hostIndex >= 0 ? next[hostIndex].charStart + sourceTable.text.length : Math.max(0, Number(next[next.length - 1]?.charEnd || 0) + 2) + sourceTable.text.length,
    }
    if (hostIndex >= 0) {
      next.splice(hostIndex, 1, tableElement)
      continue
    }

    const sourceIndex = sourceElements.indexOf(sourceTable)
    const previousText = [...sourceElements.slice(0, sourceIndex)].reverse().find((element) => element.type !== 'table' && element.text.trim())?.text || ''
    const previousKey = normalizeTableMatchText(previousText).slice(-48)
    const insertAfter = previousKey
      ? next.findIndex((element) => normalizeTableMatchText(element.text).includes(previousKey))
      : -1
    if (insertAfter >= 0) next.splice(insertAfter + 1, 0, tableElement)
    else next.push(tableElement)
  }
  let cursor = 0
  return next.map((element) => {
    const charStart = cursor
    const textLength = String(element.text || '').length
    cursor += textLength + 2
    return {
      ...element,
      charStart,
      charEnd: charStart + textLength,
    }
  })
}

function getDisplayPageElements(page: ReaderSourcePage, aiText: string): ReadablePageElement[] {
  if (!aiText) return getPageElements(page)
  return mergeAiLayoutElementsWithSourceTables(page, aiLayoutTextToElements(aiText))
}

function getPageTitle(page: ReaderSourcePage, pageIndex: number): string {
  const firstLine = getPageText(page).split(/\n+/).map(normalizeTitle).find(Boolean)
  return firstLine && firstLine.length <= 80 ? firstLine : `第 ${Number(page?.page_num || pageIndex + 1)} 页`
}

function getReaderPageHeaderTitle(page: ReaderSourcePage, pageIndex: number): string {
  const parsed = parseMaybeRecord(page?.ocr_result)
  if (String(parsed.source_type || '') === 'ebook_section' || readRecordValue(parsed, 'ebook')) return ''
  return getPageTitle(page, pageIndex)
}

function getPageSourceSize(page?: ReaderSourcePage): { width: number; height: number } | null {
  const parsed = parseMaybeRecord(page?.ocr_result)
  const gujiProcessing = readRecordValue(parsed, 'guji_processing')
  const candidates = [
    {
      width: readRecordValue(gujiProcessing, 'source_image_width'),
      height: readRecordValue(gujiProcessing, 'source_image_height'),
    },
    { width: parsed.source_image_width, height: parsed.source_image_height },
    { width: parsed.image_width, height: parsed.image_height },
    { width: parsed.page_width, height: parsed.page_height },
    { width: parsed.width, height: parsed.height },
  ]
  for (const candidate of candidates) {
    const width = Number(candidate.width || 0)
    const height = Number(candidate.height || 0)
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height }
    }
  }
  return null
}

function getReaderPageImageDataUrl(imagePath: string): Promise<string> {
  const cached = readerImageDataUrlCache.get(imagePath)
  if (cached) return Promise.resolve(cached)
  const pending = readerImageDataUrlPromises.get(imagePath)
  if (pending) return pending
  const promise = window.api.readImageAsDataURL(imagePath)
    .then((dataUrl) => {
      readerImageDataUrlPromises.delete(imagePath)
      if (dataUrl) {
        readerImageDataUrlCache.set(imagePath, dataUrl)
        while (readerImageDataUrlCache.size > READER_IMAGE_CACHE_LIMIT) {
          const oldestKey = readerImageDataUrlCache.keys().next().value
          if (!oldestKey) break
          readerImageDataUrlCache.delete(oldestKey)
        }
      }
      return dataUrl
    })
    .catch((error) => {
      readerImageDataUrlPromises.delete(imagePath)
      throw error
    })
  readerImageDataUrlPromises.set(imagePath, promise)
  return promise
}

function getTocPageHint(href: string | undefined | null): number | null {
  const match = String(href || '').match(/(?:page|p|source-page)[:/_-]?(\d+)/i)
  return match ? Number(match[1]) : null
}

function getTocCharHint(item: Partial<TocItemV2> | undefined | null): number | null {
  const raw = String(item?.anchor_key || item?.href || '')
  const match = raw.match(/(?:char|offset)[:/_-]?(\d+)/i)
  return match ? Number(match[1]) : null
}

function stripEbookHrefHash(value: string | undefined | null): string {
  return String(value || '').split('#')[0].replace(/\\/g, '/').replace(/^\/+/, '')
}

function getEbookHrefCandidates(value: string | undefined | null): string[] {
  const raw = String(value || '').trim()
  if (!raw || /^page:/i.test(raw)) return []
  const noHash = stripEbookHrefHash(raw)
  const candidates = [raw, noHash]
  const fileName = noHash.split('/').filter(Boolean).pop()
  if (fileName) candidates.push(fileName)
  return Array.from(new Set(candidates.filter(Boolean)))
}

function getPrioritizedEbookHrefCandidateGroups(value: string | undefined | null): string[][] {
  const raw = String(value || '').trim()
  if (!raw || /^page:/i.test(raw)) return []
  const noHash = stripEbookHrefHash(raw)
  const fileName = noHash.split('/').filter(Boolean).pop()
  const groups: string[][] = []
  if (raw.includes('#')) groups.push([raw])
  groups.push(Array.from(new Set([noHash, fileName].filter((candidate): candidate is string => !!candidate))))
  return groups.filter((group) => group.length > 0)
}

function getPageEbookHrefCandidates(page: ReaderSourcePage): string[] {
  const parsed = parseMaybeRecord(page?.ocr_result)
  const ebookMeta = readRecordValue(parsed, 'ebook')
  const sourceHrefs = readRecordValue(ebookMeta, 'source_hrefs')
  const hrefs = [
    readRecordValue(ebookMeta, 'href'),
    readRecordValue(ebookMeta, 'source_href'),
    readRecordValue(ebookMeta, 'source_start_href'),
    readRecordValue(ebookMeta, 'source_end_href'),
    ...(Array.isArray(sourceHrefs) ? sourceHrefs : []),
    ...(Array.isArray(page?.source_hrefs) ? page.source_hrefs : []),
    page?.href,
  ]
  return Array.from(new Set(hrefs.flatMap((href) => (typeof href === 'string' ? getEbookHrefCandidates(href) : []))))
}

function findPageIndexByEbookHref(pages: ReaderSourcePage[], hrefOrAnchor: string | undefined | null): number {
  const groups = getPrioritizedEbookHrefCandidateGroups(hrefOrAnchor)
  for (const group of groups) {
    const pageIndex = pages.findIndex((page) => {
      const pageCandidates = getPageEbookHrefCandidates(page)
      return group.some((candidate) => pageCandidates.includes(candidate))
    })
    if (pageIndex >= 0) return pageIndex
  }
  return -1
}

function normalizeSource(value: unknown): TocItemSource {
  return value === 'manual' || value === 'ai' || value === 'rule' || value === 'imported' || value === 'legacy' ? value : 'manual'
}

function normalizeStatus(value: unknown): TocItemV2['status'] {
  return value === 'active' || value === 'unresolved' || value === 'disabled' ? value : 'active'
}

function isLikelyHeadingLine(line: string): boolean {
  const text = normalizeTitle(line)
  if (!text || text.length < 2 || text.length > 80) return false
  if (/^\d+$/.test(text)) return false
  if (/^(目录|目次|CONTENTS)$/i.test(text)) return false
  if (/^(中文摘要|摘要|Abstract|前言|引言|绪论|结论|参考文献|引用书目|附录|后记)$/i.test(text)) return true
  if (/^第\s*[一二两三四五六七八九十百千万〇零\d]+\s*[章节卷编篇部]/.test(text)) return true
  if (/^[一二两三四五六七八九十百千万〇零\d]+[、.)）]\s*.{2,65}$/.test(text)) return true
  if (/^[（(][一二两三四五六七八九十百千万〇零\d]+[)）]\s*.{2,65}$/.test(text)) return true
  return /^#{1,4}\s+.{2,70}$/.test(line)
}

function isLikelyTocPageText(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  const hasKeyword = /(目录|目次|CONTENTS?)/i.test(compact)
  let pageRefCount = 0
  let headingCount = 0
  String(text || '').split(/\n+/).forEach((line) => {
    const clean = normalizeTitle(line)
    if (clean.length < 3) return
    if (TOC_PAGE_REF_SUFFIX_RE.test(clean)) pageRefCount += 1
    else if (isLikelyHeadingLine(clean)) headingCount += 1
  })
  const chapterCount = (compact.match(/第[一二两兩三四五六七八九十百千〇零○\d]{1,4}章/g) || []).length
  const sectionCount = (compact.match(/[（(]?[一二两兩三四五六七八九十百千〇零○\d]{1,4}[)）、.]/g) || []).length
  return (hasKeyword && (pageRefCount >= 3 || headingCount >= 8 || chapterCount >= 2 || sectionCount >= 8)) || pageRefCount >= 8
}

function buildTocPageScan(page: ReaderSourcePage): TocPageScan {
  const text = getPageText(page)
  if (!text) return { normalized: '', lineKeys: [], headingKeys: [], isTocPage: false }
  const lines = text.split(/\n+/).map(normalizeTitle).filter(Boolean)
  return {
    normalized: normalizeForMatch(text),
    lineKeys: lines.map(normalizeForMatch).filter(Boolean),
    headingKeys: lines.filter(isLikelyHeadingLine).map(normalizeForMatch).filter(Boolean),
    isTocPage: isLikelyTocPageText(text),
  }
}

function scoreTocScanForKey(scan: TocPageScan, key: string, isExactCandidate: boolean): number {
  if (!key || !scan.normalized.includes(key)) return 0
  if (scan.isTocPage && !isExactCandidate) return 0
  let score = 18
  scan.lineKeys.slice(0, 36).forEach((lineKey, index) => {
    if (lineKey === key) score = Math.max(score, 100 - index)
    else if (lineKey.startsWith(key) && lineKey.length <= key.length + 12) score = Math.max(score, 84 - index)
    else if (key.startsWith(lineKey) && lineKey.length >= Math.min(6, key.length)) score = Math.max(score, 64 - index)
  })
  if (scan.headingKeys.some((headingKey) => headingKey === key || headingKey.includes(key) || key.includes(headingKey))) score += 18
  if (scan.isTocPage) score -= 80
  return score
}

function getHeadingLevel(line: string): number {
  const text = normalizeTitle(line)
  if (/^(中文摘要|摘要|Abstract|目录|目次|前言|引言|绪论|结论|参考文献|引用书目|附录|后记)$/i.test(text)) return 1
  if (/^第\s*[一二两三四五六七八九十百千万〇零\d]+\s*[卷编篇部]/.test(text)) return 1
  if (/^第\s*[一二两三四五六七八九十百千万〇零\d]+\s*章/.test(text)) return 1
  if (/^第\s*[一二两三四五六七八九十百千万〇零\d]+\s*节/.test(text)) return 2
  if (/^[（(][一二两三四五六七八九十百千万〇零\d]+[)）]/.test(text)) return 3
  return 2
}

function getTocItemKey(item: TocItemV2): string {
  return `${item.order ?? 0}:${item.id}:${normalizeForMatch(item.title)}:${item.source_page_num || getTocPageHint(item.href) || ''}:${getTocCharHint(item) ?? ''}`
}

function getTocSourceLabel(source: TocItemSource): string {
  switch (source) {
    case 'manual':
      return '手动'
    case 'ai':
      return 'AI'
    case 'imported':
      return '内置'
    case 'legacy':
      return '旧版'
    case 'rule':
    default:
      return '规则'
  }
}

function getTocQualityLabel(item: TocItemV2, bound: boolean): string {
  if (!bound || item.status === 'unresolved') return '待定位'
  const confidence = Number(item.confidence || 0)
  if (item.source === 'manual' || confidence >= 0.9) return '精确'
  if (confidence >= 0.72) return '较准'
  return '待校'
}

function normalizeTocItems(items: TocItemV2[]): TocItemV2[] {
  const seen = new Set<string>()
  return items.map((item, index) => {
    const title = normalizeTitle(item.title)
    const key = normalizeForMatch(title)
    if (!title || !key || seen.has(key)) return null
    seen.add(key)
    const pageNum = Number(item.source_page_num || getTocPageHint(item.href))
    return {
      ...item,
      id: item.id || `toc-${index}`,
      title,
      href: item.href || (pageNum ? `page:${pageNum}` : ''),
      level: Math.max(1, Math.min(6, Number(item.level) || getHeadingLevel(title))),
      order: index,
      parent_id: item.parent_id ?? null,
      anchor_text: item.anchor_text || title,
      anchor_context: item.anchor_context ?? null,
      anchor_key: item.anchor_key ?? (pageNum ? `page:${pageNum}` : null),
      source_page_num: Number.isFinite(pageNum) && pageNum > 0 ? pageNum : (item.source_page_num ?? null),
      source: normalizeSource(item.source),
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0.5,
      status: Number.isFinite(pageNum) && pageNum > 0 ? 'active' : normalizeStatus(item.status || 'unresolved'),
    } as TocItemV2
  }).filter((item): item is TocItemV2 => !!item)
}

function getEditableTocSignature(item: Partial<TocItemV2>): string {
  return JSON.stringify({
    title: normalizeTitle(String(item.title || '')),
    href: String(item.href || ''),
    level: Math.max(1, Math.min(6, Number(item.level) || 1)),
    parent_id: item.parent_id ?? null,
    anchor_text: item.anchor_text ?? null,
    anchor_context: item.anchor_context ?? null,
    anchor_key: item.anchor_key ?? null,
    source_page_num: item.source_page_num ?? null,
  })
}

function toTocDraftItems(items: TocItemV2[]): TocDraftItem[] {
  return normalizeTocItems(items).map((item, index) => ({
    ...item,
    order: index,
    draftKey: `${item.id || item.title}-${index}-${Date.now().toString(36)}`,
    originalSignature: getEditableTocSignature(item),
  }))
}

function normalizeManualTocForSave(items: TocDraftItem[]): TocItemV2[] {
  return normalizeTocItems(items.map((item, index) => {
    const changed = !item.originalSignature || item.originalSignature !== getEditableTocSignature(item)
    const source = changed ? 'manual' : normalizeSource(item.source)
    return {
      ...item,
      id: item.id || `manual-toc-${index}`,
      order: index,
      source,
      confidence: source === 'manual' ? 1 : item.confidence,
      status: item.source_page_num ? 'active' : normalizeStatus(item.status || 'unresolved'),
    }
  }))
}

function createPageTocItem(page: ReaderSourcePage, pageIndex: number, order: number, title?: string): TocItemV2 {
  const pageNum = Number(page?.page_num || pageIndex + 1)
  const cleanTitle = normalizeTitle(title || '') || getPageTitle(page, pageIndex)
  const text = getPageText(page)
  const charIndex = cleanTitle ? Math.max(0, text.indexOf(cleanTitle)) : 0
  return {
    id: `manual-page-toc-${Date.now().toString(36)}-${order}`,
    title: cleanTitle,
    href: `page:${pageNum}`,
    level: 1,
    order,
    parent_id: null,
    anchor_text: cleanTitle,
    anchor_context: text.slice(0, 180),
    anchor_key: `page:${pageNum}:char:${charIndex}`,
    source_page_num: pageNum,
    source: 'manual',
    confidence: 1,
    status: 'active',
  }
}

function buildFallbackToc(pages: ReaderSourcePage[]): TocItemV2[] {
  const items: TocItemV2[] = []
  const seen = new Set<string>()
  pages.forEach((page, index) => {
    if (items.length >= 300) return
    const text = getPageText(page)
    if (!text || isLikelyTocPageText(text)) return
    const pageNum = Number(page?.page_num || index + 1)
    const lines = text.split(/\n+/).map(normalizeTitle).filter(Boolean)
    const title = lines.slice(0, 12).find(isLikelyHeadingLine) || (index % 20 === 0 ? getPageTitle(page, index) : '')
    const key = normalizeForMatch(title)
    if (!title || !key || seen.has(key)) return
    const charIndex = Math.max(0, text.indexOf(title))
    seen.add(key)
    items.push({
      id: `source-page-nav-${pageNum}`,
      title,
      href: `page:${pageNum}`,
      level: isLikelyHeadingLine(title) ? getHeadingLevel(title) : 3,
      order: items.length,
      parent_id: null,
      anchor_text: title,
      anchor_context: lines.slice(0, 4).join('\n').slice(0, 220),
      anchor_key: `page:${pageNum}:char:${charIndex}`,
      source_page_num: pageNum,
      source: 'rule',
      confidence: 0.45,
      status: 'active',
    })
  })
  return items
}

function findPageIndexByNum(pages: ReaderSourcePage[], pageNum: number | null | undefined): number {
  if (!Number.isFinite(Number(pageNum))) return -1
  return pages.findIndex((page) => Number(page?.page_num || 0) === Number(pageNum))
}

function findPageIndexByTocItem(pages: ReaderSourcePage[], item: TocItemV2): number {
  if (item.status === 'disabled') return -1
  const directIndex = findPageIndexByNum(pages, item.source_page_num || getTocPageHint(item.href))
  if (directIndex >= 0) return directIndex
  const hrefIndex = findPageIndexByEbookHref(pages, item.href || item.anchor_key)
  if (hrefIndex >= 0) return hrefIndex
  const key = normalizeForMatch(item.anchor_text || item.title)
  if (!key) return -1
  return resolveTocItemByFullScan(pages, item, new Map())
}

function buildDirectTocPageIndexMap(pages: ReaderSourcePage[], items: TocItemV2[]): Map<string, number> {
  const pageIndexByNum = new Map<number, number>()
  pages.forEach((page, index) => {
    const pageNum = Number(page?.page_num || index + 1)
    if (Number.isFinite(pageNum) && pageNum > 0 && !pageIndexByNum.has(pageNum)) pageIndexByNum.set(pageNum, index)
  })

  const result = new Map<string, number>()
  items.forEach((item) => {
    const itemKey = getTocItemKey(item)
    if (item.status === 'disabled') {
      result.set(itemKey, -1)
      return
    }
    const pageNum = Number(item.source_page_num || getTocPageHint(item.href))
    const directIndex = Number.isFinite(pageNum) ? pageIndexByNum.get(pageNum) : undefined
    if (directIndex !== undefined) {
      result.set(itemKey, directIndex)
      return
    }
    const hrefIndex = findPageIndexByEbookHref(pages, item.href || item.anchor_key)
    if (hrefIndex >= 0) {
      result.set(itemKey, hrefIndex)
      return
    }
    result.set(itemKey, -1)
  })

  return result
}

function resolveTocItemByFullScan(pages: ReaderSourcePage[], item: TocItemV2, cache: Map<number, TocPageScan>): number {
  const key = normalizeForMatch(item.anchor_text || item.title)
  if (!key) return -1
  const hintedIndex = findPageIndexByNum(pages, item.source_page_num || getTocPageHint(item.href))
  let bestIndex = -1
  let bestScore = 0
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    let scan = cache.get(pageIndex)
    if (!scan) {
      scan = buildTocPageScan(pages[pageIndex])
      cache.set(pageIndex, scan)
    }
    const score = scoreTocScanForKey(scan, key, hintedIndex === pageIndex)
    if (score > bestScore) {
      bestScore = score
      bestIndex = pageIndex
      if (score >= 96) break
    }
  }
  return bestScore > 0 ? bestIndex : -1
}

function getElementAnchorId(page: ReaderSourcePage, pageIndex: number, elementIndex: number): string {
  return `source-anchor-${page?.id || pageIndex}-${elementIndex}`
}

function findAnchorElementIndex(page: ReaderSourcePage, item: TocItemV2): number {
  const elements = getPageElements(page)
  if (!elements.length) return -1
  const key = normalizeForMatch(item.anchor_text || item.title)
  const charHint = getTocCharHint(item)
  if (Number.isFinite(Number(charHint))) {
    const direct = elements.findIndex((element) => Number(charHint) >= element.charStart && Number(charHint) <= element.charEnd)
    if (direct >= 0) return direct
  }
  if (key) {
    let fuzzy = -1
    for (let index = 0; index < elements.length; index += 1) {
      const elementKey = normalizeForMatch(elements[index].text)
      if (!elementKey) continue
      if (elementKey === key || elementKey.startsWith(key) || key.startsWith(elementKey)) return index
      if (fuzzy < 0 && elementKey.includes(key)) fuzzy = index
    }
    if (fuzzy >= 0) return fuzzy
  }
  return -1
}

function normalizeReaderText(value: string): string {
  return toSimplified(String(value || '')).toLocaleLowerCase()
}

function transformReaderDisplayText(text: string, script: ReaderDisplayScript = 'original'): string {
  if (script === 'simplified') return toSimplified(text)
  if (script === 'traditional') return toTraditional(text)
  return text
}

function makeMarkedSnippet(text: string, keyword: string, center: number, size = 180): string {
  const source = String(text || '')
  if (!source) return ''
  const query = String(keyword || '').trim()
  const boundedCenter = Math.max(0, Math.min(source.length, Number.isFinite(center) ? center : 0))
  const start = Math.max(0, boundedCenter - Math.floor(size / 2))
  const end = Math.min(source.length, start + size)
  const localCenter = boundedCenter - start
  const matchLength = Math.max(1, Math.min(query.length || 1, end - start - localCenter))
  const prefix = start > 0 ? '…' : ''
  const suffix = end < source.length ? '…' : ''
  return `${prefix}${source.slice(start, start + localCenter)}<<${source.slice(start + localCenter, start + localCenter + matchLength)}>>${source.slice(start + localCenter + matchLength, end)}${suffix}`
}

function stripSnippetMarkers(value: string): string {
  return String(value || '').replace(/<</g, '').replace(/>>/g, '').replace(/\s+/g, ' ').trim()
}

function stripSnippetHtmlPreservingMarkers(value: string): string {
  const openToken = '__GUJISMART_SEARCH_MARK_OPEN__'
  const closeToken = '__GUJISMART_SEARCH_MARK_CLOSE__'
  const decoded = String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<</g, openToken)
    .replace(/>>/g, closeToken)
  return decoded
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .split(openToken).join('<<')
    .split(closeToken).join('>>')
    .replace(/\$\s*\^\s*\{([^}]*)\}\s*\$/g, (_match, text) => String(text || '').replace(/\\[a-zA-Z]+/g, (name) => name.slice(1)).replace(/[{}]/g, '').trim())
    .replace(/\$\s*\^\s*([^\s$]+)\s*\$/g, (_match, text) => String(text || '').replace(/\\[a-zA-Z]+/g, (name) => name.slice(1)).replace(/[{}]/g, '').trim())
    .replace(/\$\s*_\s*\{([^}]*)\}\s*\$/g, (_match, text) => String(text || '').replace(/\\[a-zA-Z]+/g, (name) => name.slice(1)).replace(/[{}]/g, '').trim())
    .replace(/\$\s*_\s*([^\s$]+)\s*\$/g, (_match, text) => String(text || '').replace(/\\[a-zA-Z]+/g, (name) => name.slice(1)).replace(/[{}]/g, '').trim())
    .replace(/\^\{([^}]*)\}/g, (_match, text) => String(text || '').replace(/\\[a-zA-Z]+/g, (name) => name.slice(1)).replace(/[{}]/g, '').trim())
    .replace(/(?<![a-zA-Z])\^(\d+)/g, '$1')
    .replace(/_\{([^}]*)\}/g, (_match, text) => String(text || '').replace(/\\[a-zA-Z]+/g, (name) => name.slice(1)).replace(/[{}]/g, '').trim())
    .replace(/\$(\\(?:dagger|ddagger|ast|star|S|P|cdot|times|alpha|beta|gamma|delta))\$/g, (_match, text) => String(text || '').replace(/\\dagger/g, '†').replace(/\\ddagger/g, '‡').replace(/\\ast|\\star/g, '*').replace(/\\S/g, '§').replace(/\\P/g, '¶').replace(/\\cdot/g, '·').replace(/\\times/g, '×').replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β').replace(/\\gamma/g, 'γ').replace(/\\delta/g, 'δ').replace(/\\[a-zA-Z]+/g, (name) => name.slice(1)).trim())
    .replace(/\s+/g, ' ')
    .trim()
}

function renderMarkedSnippet(snippet: string, keyword: string, displayScript: ReaderDisplayScript = 'original'): ReactNode {
  const source = transformReaderDisplayText(stripSnippetHtmlPreservingMarkers(String(snippet || '')), displayScript)
  if (!source.includes('<<')) return highlightPlainText(stripSnippetMarkers(source), keyword, null, null, null, displayScript)
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

function buildReaderOffsetMap(value: string): { normalized: string; offsets: number[] } {
  const source = String(value || '')
  let normalized = ''
  const offsets: number[] = []
  for (let index = 0; index < source.length; index += 1) {
    const piece = normalizeReaderText(source[index])
    if (!piece) continue
    for (let offset = 0; offset < piece.length; offset += 1) offsets.push(index)
    normalized += piece
  }
  return { normalized, offsets }
}

function renderInlineAnnotations(text: string, keyPrefix: string, displayScript: ReaderDisplayScript = 'original'): ReactNode[] {
  return renderOcrInlineText(text, keyPrefix, { transformText: (value) => transformReaderDisplayText(value, displayScript) })
}

function findSearchOccurrences(text: string, keyword: string): number[] {
  const source = String(text || '')
  const query = String(keyword || '').trim()
  if (!source || !query) return []
  const sourceMap = buildReaderOffsetMap(source)
  const normalizedSource = sourceMap.normalized
  const normalizedQuery = normalizeReaderText(query)
  const positions: number[] = []
  let cursor = 0
  while (cursor <= normalizedSource.length) {
    const next = normalizedSource.indexOf(normalizedQuery, cursor)
    if (next < 0) break
    positions.push(sourceMap.offsets[next] ?? next)
    cursor = next + Math.max(1, normalizedQuery.length)
    if (positions.length >= 20000) break
  }
  return positions
}

function findSearchOccurrenceRanges(text: string, keyword: string): Array<{ start: number; end: number }> {
  const source = String(text || '')
  const query = String(keyword || '').trim()
  if (!source || !query) return []
  const sourceMap = buildReaderOffsetMap(source)
  const normalizedSource = sourceMap.normalized
  const normalizedQuery = normalizeReaderText(query)
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor <= normalizedSource.length) {
    const next = normalizedSource.indexOf(normalizedQuery, cursor)
    if (next < 0) break
    const start = sourceMap.offsets[next] ?? next
    const end = (sourceMap.offsets[next + normalizedQuery.length - 1] ?? start) + 1
    ranges.push({ start, end })
    cursor = next + Math.max(1, normalizedQuery.length)
    if (ranges.length >= 20000) break
  }
  return ranges
}

function getSelectionOccurrenceIndexInContainer(container: HTMLElement | null | undefined, range: Range, query: string): number {
  if (!container || !query.trim()) return 0
  try {
    const prefixRange = range.cloneRange()
    prefixRange.selectNodeContents(container)
    prefixRange.setEnd(range.startContainer, range.startOffset)
    return findSearchOccurrences(prefixRange.toString(), query).length
  } catch {
    return 0
  }
}

function getExcerptHighlightText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180)
}

function getElementSearchText(element: ReadablePageElement): string {
  return element.type === 'table' && element.rows?.length ? element.rows.flat().join('\n') : element.text
}

function locateSearchMatchInPage(page: ReaderSourcePage, pageIndex: number, keyword: string, charIndex: number): ReaderSearchMatch {
  const elements = getPageElements(page)
  const candidates: ReaderSearchMatch[] = []
  elements.forEach((element, elementIndex) => {
    findSearchOccurrences(getElementSearchText(element), keyword).forEach((offset, occurrenceIndex) => {
      candidates.push({ pageIndex, charIndex: element.charStart + offset, elementIndex, occurrenceIndex })
    })
  })
  if (candidates.length > 0) {
    const target = Number.isFinite(Number(charIndex)) ? Number(charIndex) : 0
    return candidates.sort((left, right) => Math.abs(left.charIndex - target) - Math.abs(right.charIndex - target) || left.charIndex - right.charIndex)[0]
  }
  return { pageIndex, charIndex, elementIndex: 0, occurrenceIndex: 0 }
}

function locateNthSearchMatchInPage(page: ReaderSourcePage, pageIndex: number, keyword: string, pageOccurrenceIndex: number, fallbackCharIndex: number): ReaderSearchMatch {
  const elements = getPageElements(page)
  const candidates: ReaderSearchMatch[] = []
  elements.forEach((element, elementIndex) => {
    findSearchOccurrences(getElementSearchText(element), keyword).forEach((offset, occurrenceIndex) => {
      candidates.push({ pageIndex, charIndex: element.charStart + offset, elementIndex, occurrenceIndex })
    })
  })
  const sorted = candidates.sort((left, right) => left.charIndex - right.charIndex)
  const targetIndex = Math.max(0, Math.min(sorted.length - 1, Number(pageOccurrenceIndex) || 0))
  return sorted[targetIndex] || locateSearchMatchInPage(page, pageIndex, keyword, fallbackCharIndex)
}

function locateSearchMatchByLocator(page: ReaderSourcePage, pageIndex: number, locator: SearchHitLocator, fallbackKeyword: string): ReaderSearchMatch {
  const keyword = locator.matchText || locator.queryTerm || fallbackKeyword
  const elements = getPageElements(page)
  const locatorCharStart = Number(locator.charStart || 0)
  const segmentOrdinal = Number(locator.segmentOrdinal)
  const segmentOrdinalIndex = Number.isFinite(segmentOrdinal) && segmentOrdinal >= 0 ? Math.floor(segmentOrdinal) : -1
  const segmentIdIndex = getElementIndexFromSearchHitSegment(locator.segmentId)
  const elementIndex = [segmentOrdinalIndex, segmentIdIndex]
    .find((candidate) => {
      const element = elements[candidate]
      return !!element
        && locatorCharStart >= Number(element.charStart || 0)
        && locatorCharStart <= Number(element.charEnd || 0)
    }) ?? -1
  const element = elements[elementIndex]
  if (element && keyword) {
    const offsets = findSearchOccurrences(getElementSearchText(element), keyword)
    if (offsets.length > 0) {
      const occurrenceIndex = Math.max(0, Math.min(offsets.length - 1, Number(locator.occurrenceIndex || 0)))
      const localCharStart = Math.max(0, locatorCharStart - Number(element.charStart || 0))
      const nearestOffset = offsets
        .map((offset, index) => ({ offset, index, distance: Math.abs(offset - localCharStart) }))
        .sort((left, right) => left.distance - right.distance)[0]
      const chosen = offsets[occurrenceIndex] != null ? { offset: offsets[occurrenceIndex], index: occurrenceIndex } : nearestOffset
      if (chosen) {
        return {
          pageIndex,
          charIndex: Number(element.charStart || 0) + chosen.offset,
          elementIndex,
          occurrenceIndex: chosen.index,
        }
      }
    }
  }
  if (Number.isFinite(Number(locator.occurrenceIndex))) {
    return locateNthSearchMatchInPage(page, pageIndex, keyword, Number(locator.occurrenceIndex), locatorCharStart)
  }
  return locateSearchMatchInPage(page, pageIndex, keyword, locatorCharStart)
}

function findPageIndexForLocator(sortedPages: ReaderSourcePage[], locator: SearchHitLocator | null | undefined): number {
  if (!locator) return -1
  if (locator.pageId) {
    const byId = sortedPages.findIndex((page) => page.id === locator.pageId)
    if (byId >= 0) return byId
  }
  const byPageNum = findPageIndexByNum(sortedPages, locator.pageNum)
  if (byPageNum >= 0) return byPageNum
  const locatorPageIndex = locator.pageIndex
  if (locatorPageIndex !== null && locatorPageIndex !== undefined && Number.isFinite(Number(locatorPageIndex))) {
    return Number(locatorPageIndex)
  }
  return -1
}

function buildPageLocatorIndex(pages: ReaderSourcePage[]): PageLocatorIndex {
  const byId = new Map<string, number>()
  const byNum = new Map<number, number>()
  pages.forEach((page, index) => {
    if (page?.id && !byId.has(page.id)) byId.set(page.id, index)
    const pageNum = Number(page?.page_num || 0)
    if (Number.isFinite(pageNum) && pageNum > 0 && !byNum.has(pageNum)) byNum.set(pageNum, index)
  })
  return { byId, byNum }
}

function findPageIndexForLocatorFast(locatorIndex: PageLocatorIndex, locator: SearchHitLocator | null | undefined): number {
  if (!locator) return -1
  if (locator.pageId) {
    const byId = locatorIndex.byId.get(locator.pageId)
    if (byId !== undefined) return byId
  }
  const pageNum = Number(locator.pageNum)
  if (Number.isFinite(pageNum)) {
    const byNum = locatorIndex.byNum.get(pageNum)
    if (byNum !== undefined) return byNum
  }
  const locatorPageIndex = locator.pageIndex
  if (locatorPageIndex !== null && locatorPageIndex !== undefined && Number.isFinite(Number(locatorPageIndex))) {
    return Number(locatorPageIndex)
  }
  return -1
}

function getReaderCitationPageNum(page: ReaderSourcePage | null | undefined, fallback?: number | null): number | null {
  return getCitationPageNumber(page, fallback ?? page?.page_num ?? null)
}

function buildReaderCitationText(title: string | null | undefined, pageNum: number | null): string {
  return `${title || '未命名文献'}${pageNum ? `，第 ${pageNum} 页` : ''}`
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const next = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(next) ? next : fallback
}

function asSearchHitLocator(value: unknown): SearchHitLocator | null {
  if (!isJsonRecord(value)) return null
  const matchText = String(readRecordValue(value, 'matchText') || readRecordValue(value, 'queryTerm') || '').trim()
  const charStart = Math.max(0, toFiniteNumber(readRecordValue(value, 'charStart'), 0))
  const charEnd = Math.max(charStart, toFiniteNumber(readRecordValue(value, 'charEnd'), charStart + matchText.length))
  const segmentOrdinal = Math.max(0, toFiniteNumber(readRecordValue(value, 'segmentOrdinal'), getElementIndexFromSearchHitSegment(readRecordValue(value, 'segmentId'))))
  return {
    docId: String(readRecordValue(value, 'docId') || ''),
    segmentId: String(readRecordValue(value, 'segmentId') || ''),
    sourceType: String(readRecordValue(value, 'sourceType') || ''),
    pageId: readRecordValue(value, 'pageId') == null ? null : String(readRecordValue(value, 'pageId')),
    pageNum: readRecordValue(value, 'pageNum') == null ? null : toFiniteNumber(readRecordValue(value, 'pageNum'), 0),
    pageIndex: readRecordValue(value, 'pageIndex') == null ? null : toFiniteNumber(readRecordValue(value, 'pageIndex'), 0),
    href: readRecordValue(value, 'href') == null ? null : String(readRecordValue(value, 'href')),
    locationKey: String(readRecordValue(value, 'locationKey') || ''),
    segmentOrdinal,
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
  const source = parseMaybeRecord(note.source_id)
  return asSearchHitLocator(readRecordValue(source, 'locator'))
}

function getSourceString(source: JsonRecord | null | undefined, key: string): string {
  return String(source ? readRecordValue(source, key) || '' : '').trim()
}

function getReaderNoteHighlightText(note: ReaderNoteItem, locator: SearchHitLocator | null = getReaderNoteLocator(note)): string {
  const source = parseMaybeRecord(note.source_id)
  return [
    locator?.matchText,
    locator?.queryTerm,
    getSourceString(source, 'searchKeyword'),
    getSourceString(source, 'matchedQuery'),
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
  if (!ranked.length) return ''
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
    .map((hit, index) => `${index}:${hit.id}:${hit.locator?.pageId || ''}:${hit.locator?.pageNum || ''}:${hit.locator?.pageIndex ?? ''}:${hit.locator?.segmentOrdinal ?? ''}:${hit.locator?.charStart ?? ''}:${hit.locator?.queryTerm || hit.locator?.matchText || ''}`)
    .join('|')
  return `${session.query || ''}:${session.activeHitIndex}:${session.status}:${hitKeys}`
}

function chooseReaderNoteHighlightRange(text: string, highlight: ReaderNoteHighlight): { start: number; end: number } | null {
  const source = String(text || '')
  const ranges = findSearchOccurrenceRanges(source, highlight.text)
  const targetStart = Math.max(0, Number(highlight.localCharStart || 0))
  if (ranges.length > 0) {
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
  keyPrefix = 'reader-note',
) {
  if (!highlights.length) return renderInlineAnnotations(text, keyPrefix, displayScript)
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
  if (!ranges.length) return renderInlineAnnotations(text, keyPrefix, displayScript)

  const normalizedRanges: Array<{ start: number; end: number; highlight: ReaderNoteHighlight }> = []
  ranges
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .forEach((range) => {
      const previous = normalizedRanges[normalizedRanges.length - 1]
      if (previous && range.start < previous.end) return
      if (range.end > range.start) normalizedRanges.push(range)
    })

  const parts: ReactNode[] = []
  let cursor = 0
  normalizedRanges.forEach((range, index) => {
    if (range.start > cursor) {
      parts.push(...renderInlineAnnotations(source.slice(cursor, range.start), `${keyPrefix}-plain-${cursor}`, 'original'))
    }
    const markColor = normalizeHighlightColor(range.highlight.color)
    parts.push(
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
        {renderInlineAnnotations(source.slice(range.start, range.end), `${keyPrefix}-note-${range.highlight.noteId}-${range.start}`, 'original')}
      </mark>,
    )
    cursor = range.end
  })
  if (cursor < source.length) parts.push(...renderInlineAnnotations(source.slice(cursor), `${keyPrefix}-plain-${cursor}`, 'original'))
  return parts
}

function buildReaderNoteHighlightsByElement(notes: ReaderNoteItem[], pages: ReaderSourcePage[]): Map<string, ReaderNoteHighlight[]> {
  const map = new Map<string, ReaderNoteHighlight[]>()
  notes.forEach((note) => {
    if (note.kind !== 'quote') return
    const locator = getReaderNoteLocator(note)
    const text = getReaderNoteHighlightText(note, locator)
    if (!locator || !text) return
    const pageIndex = findPageIndexForLocator(pages, locator)
    if (pageIndex < 0 || pageIndex >= pages.length) return
    const page = pages[pageIndex]
    const elements = getPageElements(page)
    if (!elements.length) return
    let elementIndex = Number.isFinite(Number(locator.segmentOrdinal))
      ? Number(locator.segmentOrdinal)
      : getElementIndexFromSearchHitSegment(locator.segmentId)
    if (!elements[elementIndex]) {
      const charStart = Number(locator.charStart || 0)
      const byChar = elements.findIndex((element) => charStart >= Number(element.charStart || 0) && charStart <= Number(element.charEnd || 0))
      if (byChar >= 0) elementIndex = byChar
    }
    const element = elements[elementIndex]
    if (!element) return
    const elementText = getElementSearchText(element)
    const elementCharStart = Number(element.charStart || 0)
    const locatorCharStart = Math.max(0, Number(locator.charStart || 0) - elementCharStart)
    const ranges = findSearchOccurrenceRanges(elementText, text)
    const chosen = ranges.length
      ? ranges
        .map((range, index) => ({ range, index, distance: Math.abs(range.start - locatorCharStart) }))
        .sort((left, right) => left.distance - right.distance || left.index - right.index)[0]
      : null
    const localCharStart = chosen?.range.start ?? locatorCharStart
    const localCharEnd = chosen?.range.end ?? Math.max(localCharStart + text.length, Number(locator.charEnd || 0) - elementCharStart)
    const highlight: ReaderNoteHighlight = {
      noteId: note.id,
      text,
      color: normalizeHighlightColor(note.color),
      localCharStart,
      localCharEnd,
      occurrenceIndex: chosen?.index ?? Math.max(0, Number(locator.occurrenceIndex || 0)),
    }
    const key = `${pageIndex}:${elementIndex}`
    const list = map.get(key)
    if (list) list.push(highlight)
    else map.set(key, [highlight])
  })
  map.forEach((highlights) => {
    highlights.sort((left, right) => left.localCharStart - right.localCharStart || left.localCharEnd - right.localCharEnd)
  })
  return map
}

function getElementIndexFromSearchHitSegment(segmentId: unknown): number {
  const raw = String(segmentId || '')
  const value = Number(raw.split(':').pop())
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function getPageElementRenderOrder(page: ReaderSourcePage): Map<number, number> {
  const order = new Map<number, number>()
  const elements = getPageElements(page)
  let cursor = 0
  elements.forEach((element, elementIndex) => {
    if (!isFootnoteElement(element)) {
      order.set(elementIndex, cursor)
      cursor += 1
    }
  })
  elements.forEach((element, elementIndex) => {
    if (isFootnoteElement(element)) {
      order.set(elementIndex, cursor)
      cursor += 1
    }
  })
  return order
}

function readerSearchHitsToMatches(pages: ReaderSourcePage[], keyword: string, docId = ''): ReaderSearchMatch[] {
  const elementOccurrenceBySegment = new Map<string, number>()
  const renderOrderByPage = new Map<number, Map<number, number>>()
  const matches = buildViewerSearchHits(pages, keyword, docId)
    .map((hit, index) => {
      const locator = hit.locator
      const pageIndex = findPageIndexForLocator(pages, locator)
      if (pageIndex < 0) return null
      const elementIndex = getElementIndexFromSearchHitSegment(locator.segmentId)
      const segmentKey = String(locator.segmentId || `${pageIndex}:${elementIndex}`)
      const elementOccurrenceIndex = elementOccurrenceBySegment.get(segmentKey) || 0
      elementOccurrenceBySegment.set(segmentKey, elementOccurrenceIndex + 1)
      return {
        pageIndex,
        charIndex: locator.charStart,
        elementIndex,
        occurrenceIndex: elementOccurrenceIndex,
        pageOccurrenceIndex: locator.occurrenceIndex,
        globalIndex: index,
        sessionIndex: index,
      }
    })
    .filter(Boolean) as ReaderSearchMatch[]

  matches.sort((left, right) => {
    if (left.pageIndex !== right.pageIndex) return left.pageIndex - right.pageIndex
    if (!renderOrderByPage.has(left.pageIndex)) renderOrderByPage.set(left.pageIndex, getPageElementRenderOrder(pages[left.pageIndex]))
    const renderOrder = renderOrderByPage.get(left.pageIndex)
    const leftOrder = renderOrder?.get(left.elementIndex) ?? left.elementIndex
    const rightOrder = renderOrder?.get(right.elementIndex) ?? right.elementIndex
    return leftOrder - rightOrder
      || left.occurrenceIndex - right.occurrenceIndex
      || left.charIndex - right.charIndex
      || left.elementIndex - right.elementIndex
  })

  return matches.map((match, index) => ({
    ...match,
    globalIndex: index,
    sessionIndex: index,
  }))
}

function highlightPlainText(
  text: string,
  keyword: string,
  activeOccurrenceIndex?: number | null,
  globalHitStartIndex?: number | number[] | null,
  activeGlobalHitIndex?: number | null,
  displayScript: ReaderDisplayScript = 'original',
  highlightColor = DEFAULT_HIGHLIGHT_COLOR,
  activeOnly = false,
) {
  const value = transformReaderDisplayText(String(keyword || '').trim(), displayScript)
  if (!value) return renderInlineAnnotations(text, 'plain', displayScript)
  const source = transformReaderDisplayText(String(text || ''), displayScript)
  const sourceMap = buildReaderOffsetMap(source)
  const normalizedSource = sourceMap.normalized
  const normalizedQuery = normalizeReaderText(value)
  const parts: ReactNode[] = []
  let sourceCursor = 0
  let normalizedCursor = 0
  let index = normalizedSource.indexOf(normalizedQuery, normalizedCursor)
  let occurrence = 0
  while (index >= 0) {
    const originalStart = sourceMap.offsets[index] ?? index
    const originalEnd = (sourceMap.offsets[index + normalizedQuery.length - 1] ?? originalStart) + 1
    if (originalStart > sourceCursor) parts.push(...renderInlineAnnotations(source.slice(sourceCursor, originalStart), `plain-${sourceCursor}`))
    const explicitGlobalHitIndexes = Array.isArray(globalHitStartIndex) ? globalHitStartIndex : null
    const globalHitIndex = explicitGlobalHitIndexes
      ? explicitGlobalHitIndexes[occurrence]
      : Number.isFinite(Number(globalHitStartIndex))
        ? Number(globalHitStartIndex) + occurrence
        : undefined
    const hasGlobalHitIndex = Number.isFinite(Number(globalHitIndex)) && Number.isFinite(Number(activeGlobalHitIndex))
    const active = hasGlobalHitIndex
      ? activeGlobalHitIndex === globalHitIndex
      : activeOccurrenceIndex === occurrence
    if (activeOnly && !active) {
      parts.push(...renderInlineAnnotations(source.slice(originalStart, originalEnd), `plain-hit-${originalStart}`, displayScript))
      sourceCursor = originalEnd
      normalizedCursor = index + Math.max(1, normalizedQuery.length)
      occurrence += 1
      index = normalizedSource.indexOf(normalizedQuery, normalizedCursor)
      continue
    }
    const markColor = normalizeHighlightColor(highlightColor)
    const activeColor = markColor.toLowerCase() === DEFAULT_HIGHLIGHT_COLOR
      ? '#ffb020'
      : markColor
    const inactiveColor = hexToRgba(markColor, 0.56)
    const borderColor = active ? 'rgba(120, 53, 15, 0.92)' : hexToRgba(markColor, 0.28)
    parts.push(
      <mark
        key={`${originalStart}-${parts.length}`}
        data-reader-search-hit={active ? 'active' : 'true'}
        data-reader-search-hit-index={globalHitIndex}
        data-search-active={active ? 'true' : undefined}
        data-search-hit-index={globalHitIndex}
        style={{
          background: active ? activeColor : inactiveColor,
          color: getHighlightTextColor(markColor),
          padding: '0 2px',
          borderRadius: 3,
          fontWeight: active ? 700 : 600,
          position: 'relative',
          zIndex: active ? 3 : 0,
          border: `1px solid ${borderColor}`,
          outline: active ? '2px solid rgba(255, 255, 255, 0.88)' : 'none',
          outlineOffset: 0,
          boxShadow: active
            ? `0 0 0 3px rgba(120, 53, 15, 0.82), 0 0 0 6px ${hexToRgba(activeColor, 0.26)}`
            : `0 0 0 1px ${hexToRgba(markColor, 0.08)}`,
          textDecoration: 'none',
        }}
      >
        {source.slice(originalStart, originalEnd)}
      </mark>,
    )
    sourceCursor = originalEnd
    normalizedCursor = index + Math.max(1, normalizedQuery.length)
    occurrence += 1
    index = normalizedSource.indexOf(normalizedQuery, normalizedCursor)
  }
  if (sourceCursor < source.length) parts.push(...renderInlineAnnotations(source.slice(sourceCursor), `plain-${sourceCursor}`))
  return parts
}

function renderTocAnchoredText(text: string, pendingTarget?: PendingSearchTarget | null, displayScript: ReaderDisplayScript = 'original') {
  const targetText = transformReaderDisplayText(String(pendingTarget?.text || '').trim(), displayScript)
  if (!targetText) return highlightPlainText(text, '', null, null, null, displayScript)
  const source = transformReaderDisplayText(String(text || ''), displayScript)
  let directIndex = source.indexOf(targetText)
  let directEnd = directIndex + targetText.length
  if (directIndex < 0) {
    const targetKey = normalizeForMatch(targetText)
    let normalized = ''
    const indexMap: number[] = []
    for (let index = 0; index < source.length; index += 1) {
      const piece = normalizeForMatch(source[index])
      if (!piece) continue
      for (let offset = 0; offset < piece.length; offset += 1) indexMap.push(index)
      normalized += piece
    }
    const normalizedIndex = targetKey ? normalized.indexOf(targetKey) : -1
    if (normalizedIndex >= 0) {
      directIndex = indexMap[normalizedIndex] ?? -1
      directEnd = (indexMap[normalizedIndex + targetKey.length - 1] ?? directIndex) + 1
    }
  }
  if (directIndex < 0) return highlightPlainText(text, '', null, null, null, displayScript)
  return [
    ...renderInlineAnnotations(source.slice(0, directIndex), 'toc-before'),
    <span key="toc-target" data-reader-toc-target="active">
      {renderInlineAnnotations(source.slice(directIndex, directEnd), 'toc-target')}
    </span>,
    ...renderInlineAnnotations(source.slice(directEnd), 'toc-after'),
  ]
}

function ReaderCroppedImage({
  page,
  element,
  theme,
  themeStyle,
  anchorId,
  pageIndex,
  elementIndex,
  onReaderSelection,
  displayScript = 'original',
}: {
  page?: ReaderSourcePage
  element: ReadablePageElement
  theme: ReaderTheme
  themeStyle: typeof themeStyles[ReaderTheme]
  anchorId: string
  pageIndex?: number
  elementIndex: number
  onReaderSelection?: (pageIndex: number, elementIndex: number) => void
  displayScript?: ReaderDisplayScript
}) {
  const [src, setSrc] = useState('')
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const rect = element.rect
  const sourceSize = getPageSourceSize(page) || naturalSize
  const directImagePath = String(element.imagePath || '').trim()
  const imagePath = directImagePath || String(page?.image_path || '')

  useEffect(() => {
    let cancelled = false
    setNaturalSize(null)
    if (!imagePath) {
      setSrc('')
      return undefined
    }
    const cached = readerImageDataUrlCache.get(imagePath)
    if (cached) {
      setSrc(cached)
      return undefined
    }
    void getReaderPageImageDataUrl(imagePath)
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl || '')
      })
      .catch(() => {
        if (!cancelled) setSrc('')
      })
    return () => {
      cancelled = true
    }
  }, [imagePath])

  const fallbackSize = rect ? {
    width: Math.max(1, rect.left + rect.width),
    height: Math.max(1, rect.top + rect.height),
  } : null
  const effectiveSize = sourceSize || fallbackSize
  const aspect = rect ? Math.max(0.45, Math.min(2.6, rect.width / Math.max(1, rect.height))) : 1.5
  const caption = String(element.text || '').trim()

  return (
    <figure
      id={anchorId}
      key={anchorId}
      data-source-anchor="true"
      data-reader-page-index={pageIndex}
      data-reader-element-index={elementIndex}
      onMouseUp={() => pageIndex != null && onReaderSelection?.(pageIndex, elementIndex)}
      style={{
        margin: '0.35em auto 1.15em',
        maxWidth: '100%',
        color: themeStyle.text,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 620,
          margin: '0 auto',
          aspectRatio: `${aspect}`,
          overflow: 'hidden',
          border: `1px solid ${themeStyle.border}`,
          background: theme === 'dark' ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.44)',
        }}
      >
        {src && directImagePath ? (
          <img
            src={src}
            alt={caption || '文献图片'}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          />
        ) : src && rect && effectiveSize ? (
          <img
            src={src}
            alt={caption || '文献图片'}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
              }
            }}
            style={{
              position: 'absolute',
              left: `${-(rect.left / Math.max(rect.width, 1)) * 100}%`,
              top: `${-(rect.top / Math.max(rect.height, 1)) * 100}%`,
              width: `${(effectiveSize.width / Math.max(rect.width, 1)) * 100}%`,
              height: `${(effectiveSize.height / Math.max(rect.height, 1)) * 100}%`,
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          />
        ) : (
          <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: themeStyle.muted, fontSize: '0.86em' }}>
            图像区域
          </div>
        )}
      </div>
      {caption && !/^(?:image|figure|picture|chart|diagram|photo|illustration)$/i.test(caption) ? (
        <figcaption style={{ marginTop: 6, color: themeStyle.muted, fontSize: '0.82em', textAlign: 'center', lineHeight: 1.5 }}>
          {highlightPlainText(caption, '', null, null, null, displayScript)}
        </figcaption>
      ) : null}
    </figure>
  )
}

function renderReaderElementGroup(
  group: ReaderElementGroup,
  theme: ReaderTheme,
  themeStyle: typeof themeStyles[ReaderTheme],
  searchKeyword: string,
  highlightColor?: string,
  pendingTocTarget?: PendingSearchTarget | null,
  page?: ReaderSourcePage,
  pageIndex?: number,
  onReaderSelection?: (pageIndex: number, elementIndex: number, event?: SelectionMouseEvent) => void,
  noteHighlights: ReaderNoteHighlight[] = [],
  displayScript: ReaderDisplayScript = 'original',
  searchActiveOnly = false,
) {
  const { element, anchorId, activeHit } = group
  if (element.type === 'image') {
    return (
      <ReaderCroppedImage
        page={page}
        element={element}
        theme={theme}
        themeStyle={themeStyle}
        anchorId={anchorId}
        pageIndex={pageIndex}
        elementIndex={group.index}
        onReaderSelection={(nextPageIndex, nextElementIndex) => onReaderSelection?.(nextPageIndex, nextElementIndex)}
        displayScript={displayScript}
      />
    )
  }
  if (element.type === 'table' && element.rows?.length) {
    const columnCount = Math.max(1, ...element.rows.map((row) => row.length))
    const rows = element.rows.map((row) => Array.from({ length: columnCount }, (_item, index) => row[index] || ''))
    let tableOccurrenceCursor = 0
    let tableTextCursor = 0
    return (
      <div id={anchorId} key={anchorId} data-source-anchor="true" data-reader-page-index={pageIndex} data-reader-element-index={group.index} onMouseUp={(event) => pageIndex != null && onReaderSelection?.(pageIndex, group.index, event)} style={{ overflowX: 'auto', margin: '0 0 1.1em', textAlign: 'left', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', minWidth: Math.min(720, Math.max(360, columnCount * 96)), borderCollapse: 'collapse', tableLayout: 'auto', fontSize: '0.82em', lineHeight: 1.42, whiteSpace: 'normal', background: theme === 'dark' ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.35)' }}>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => {
                  const cellHits = findSearchOccurrences(cell, searchKeyword).length
                  const activeCellHit = activeHit !== null && activeHit >= tableOccurrenceCursor && activeHit < tableOccurrenceCursor + cellHits ? activeHit - tableOccurrenceCursor : null
                  const cellGlobalStartIndex = Number.isFinite(Number(group.globalSearchStartIndex)) ? Number(group.globalSearchStartIndex) + tableOccurrenceCursor : null
                  const cellGlobalHitIndexes = Array.isArray(group.globalSearchHitIndexes)
                    ? group.globalSearchHitIndexes.slice(tableOccurrenceCursor, tableOccurrenceCursor + cellHits)
                    : cellGlobalStartIndex
                  tableOccurrenceCursor += cellHits
                  const cellStart = tableTextCursor
                  const cellEnd = cellStart + String(cell || '').length
                  const cellNoteHighlights = searchKeyword.trim()
                    ? []
                    : noteHighlights
                      .filter((highlight) => highlight.localCharStart < cellEnd && highlight.localCharEnd > cellStart)
                      .map((highlight) => ({
                        ...highlight,
                        localCharStart: Math.max(0, highlight.localCharStart - cellStart),
                        localCharEnd: Math.min(String(cell || '').length, highlight.localCharEnd - cellStart),
                      }))
                  tableTextCursor = cellEnd + 1
                  return (
                    <td key={cellIndex} style={{ border: `1px solid ${themeStyle.border}`, padding: '5px 7px', verticalAlign: 'top', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', minWidth: columnCount >= 5 ? 82 : 96, fontWeight: rowIndex === 0 ? 700 : undefined }}>
                      {searchKeyword.trim()
                        ? highlightPlainText(cell, searchKeyword, activeCellHit, cellGlobalHitIndexes, group.activeGlobalHitIndex, displayScript, highlightColor, searchActiveOnly)
                        : renderReaderNoteHighlightedText(cell, cellNoteHighlights, displayScript, `reader-table-${anchorId}-${rowIndex}-${cellIndex}`)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  if (element.type === 'toc') {
    if (searchActiveOnly && searchKeyword.trim()) {
      return (
        <div id={anchorId} key={anchorId} data-source-anchor="true" data-reader-page-index={pageIndex} data-reader-element-index={group.index} onMouseUp={(event) => pageIndex != null && onReaderSelection?.(pageIndex, group.index, event)} style={{ margin: '0.15em 0 1.2em', textAlign: 'left', whiteSpace: 'pre-wrap' }}>
          {highlightPlainText(element.text, searchKeyword, activeHit, group.globalSearchHitIndexes ?? group.globalSearchStartIndex, group.activeGlobalHitIndex, displayScript, highlightColor, true)}
        </div>
      )
    }
    if (!searchKeyword.trim() && noteHighlights.length) {
      return (
        <div id={anchorId} key={anchorId} data-source-anchor="true" data-reader-page-index={pageIndex} data-reader-element-index={group.index} onMouseUp={(event) => pageIndex != null && onReaderSelection?.(pageIndex, group.index, event)} style={{ margin: '0.15em 0 1.2em', textAlign: 'left', whiteSpace: 'pre-wrap' }}>
          {renderReaderNoteHighlightedText(element.text, noteHighlights, displayScript, `reader-toc-note-${anchorId}`)}
        </div>
      )
    }
    const entries = element.tocEntries?.length
      ? element.tocEntries
      : element.text.split(/\n+/).map((line) => ({ title: line.trim(), pageLabel: '', level: 1, rawText: line.trim() })).filter((entry) => entry.title)
    let tocOccurrenceCursor = 0
    return (
      <div id={anchorId} key={anchorId} data-source-anchor="true" data-reader-page-index={pageIndex} data-reader-element-index={group.index} onMouseUp={(event) => pageIndex != null && onReaderSelection?.(pageIndex, group.index, event)} style={{ margin: '0.15em 0 1.2em', textAlign: 'left' }}>
        {entries.map((entry, entryIndex) => {
          const level = Math.max(1, Math.min(4, Number(entry.level || 1)))
          const title = transformReaderDisplayText(entry.title, displayScript)
          const pageLabel = transformReaderDisplayText(entry.pageLabel, displayScript)
          const titleHitCount = searchKeyword.trim() ? findSearchOccurrences(entry.title, searchKeyword).length : 0
          const titleGlobalHitIndexes = Array.isArray(group.globalSearchHitIndexes)
            ? group.globalSearchHitIndexes.slice(tocOccurrenceCursor, tocOccurrenceCursor + titleHitCount)
            : Number.isFinite(Number(group.globalSearchStartIndex))
              ? Number(group.globalSearchStartIndex) + tocOccurrenceCursor
              : null
          tocOccurrenceCursor += titleHitCount
          return (
            <div key={`${entry.title}-${entry.pageLabel}-${entryIndex}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, paddingLeft: (level - 1) * 22, margin: level === 1 ? '0.55em 0 0.28em' : '0.2em 0', fontWeight: level === 1 ? 700 : 500, lineHeight: 1.65 }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {searchKeyword.trim()
                  ? highlightPlainText(entry.title, searchKeyword, null, titleGlobalHitIndexes, group.activeGlobalHitIndex, displayScript, highlightColor)
                  : renderInlineAnnotations(title, `reader-toc-${anchorId}-${entryIndex}`, 'original')}
              </span>
              <span aria-hidden="true" style={{ flex: 1, minWidth: 18, borderBottom: `1px dotted ${theme === 'dark' ? 'rgba(232,226,216,0.45)' : 'rgba(80,57,34,0.42)'}`, transform: 'translateY(-0.18em)' }} />
              {pageLabel ? <span style={{ flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>{pageLabel}</span> : null}
            </div>
          )
        })}
      </div>
    )
  }

  const TagName = element.type === 'heading' ? 'h3' : 'p'
  const displayText = element.displayText || element.text
  return (
    <TagName id={anchorId} key={anchorId} data-source-anchor="true" data-reader-page-index={pageIndex} data-reader-element-index={group.index} onMouseUp={(event) => pageIndex != null && onReaderSelection?.(pageIndex, group.index, event)} style={{ margin: element.type === 'heading' ? '0.15em 0 0.85em' : '0 0 1em', fontSize: element.type === 'heading' ? '1.08em' : undefined, fontWeight: element.type === 'heading' ? 700 : undefined, textAlign: element.type === 'heading' ? 'left' : 'justify' }}>
      {pendingTocTarget?.anchorId === anchorId
        ? renderTocAnchoredText(displayText, pendingTocTarget, displayScript)
        : searchKeyword.trim()
          ? highlightPlainText(element.text, searchKeyword, activeHit, group.globalSearchHitIndexes ?? group.globalSearchStartIndex, group.activeGlobalHitIndex, displayScript, highlightColor, searchActiveOnly)
          : noteHighlights.length
            ? renderReaderNoteHighlightedText(element.text, noteHighlights, displayScript, `reader-note-${anchorId}`)
            : renderInlineAnnotations(displayText, `reader-${anchorId}`, displayScript)}
    </TagName>
  )
}

function renderFootnoteGroup(
  footnoteElementGroups: ReaderElementGroup[],
  theme: ReaderTheme,
  pendingTocTarget: PendingSearchTarget | null | undefined,
  searchKeyword: string,
  highlightColor?: string,
  displayScript: ReaderDisplayScript = 'original',
  searchActiveOnly = false,
  noteHighlightsByElement: Map<string, ReaderNoteHighlight[]> = new Map(),
  pageIndex?: number,
) {
  if (footnoteElementGroups.length === 0) return null
  return (
    <section aria-label="footnotes" style={{ marginTop: '2.2em', paddingTop: '0.72em', borderTop: `1px solid ${theme === 'dark' ? 'rgba(216,211,200,0.32)' : 'rgba(94,68,42,0.34)'}`, color: theme === 'dark' ? 'rgba(216,211,200,0.78)' : 'rgba(72,51,31,0.78)', fontSize: '0.78em', lineHeight: 1.55, textAlign: 'left' }}>
      {footnoteElementGroups.map(({ element, index, anchorId, activeHit, globalSearchStartIndex, globalSearchHitIndexes, activeGlobalHitIndex }) => {
        const noteHighlights = pageIndex == null || searchKeyword.trim() ? [] : noteHighlightsByElement.get(`${pageIndex}:${index}`) || []
        return (
          <p id={anchorId} key={anchorId} data-source-anchor="true" data-reader-page-index={pageIndex} data-reader-element-index={index} style={{ margin: '0 0 0.45em', paddingLeft: '1.4em', textIndent: '-1.4em', overflowWrap: 'break-word' }}>
            {pendingTocTarget?.anchorId === anchorId
              ? renderTocAnchoredText(element.text, pendingTocTarget, displayScript)
              : searchKeyword.trim()
                ? highlightPlainText(element.text, searchKeyword, activeHit, globalSearchHitIndexes ?? globalSearchStartIndex, activeGlobalHitIndex, displayScript, highlightColor, searchActiveOnly)
                : noteHighlights.length
                  ? renderReaderNoteHighlightedText(element.text, noteHighlights, displayScript, `reader-footnote-note-${anchorId}`)
                  : renderInlineAnnotations(element.text, `reader-footnote-${anchorId}`, displayScript)}
          </p>
        )
      })}
    </section>
  )
}

function SourcePageSpread({
  rowPages,
  pageIndices,
  pageCount,
  pageMetrics,
  adaptivePages,
  fontSize,
  lineHeight,
  theme,
  searchKeyword,
  activeSearchHit,
  searchMatches,
  pendingTocTarget,
  aiLayoutEnabled,
  aiLayoutByPageId,
  aiLayoutLoading,
  aiLayoutErrors,
  highlightColor,
  noteHighlightsByElement,
  onSelectedTextChange,
  onReaderSelection,
  displayScript = 'original',
  searchActiveOnly = false,
}: {
  rowPages: ReaderSourcePage[]
  pageIndices: number[]
  pageCount: number
  pageMetrics: ReaderPageMetrics
  adaptivePages?: boolean
  fontSize: number
  lineHeight: number
  theme: ReaderTheme
  searchKeyword: string
  activeSearchHit?: ReaderSearchMatch | null
  searchMatches: ReaderSearchMatch[]
  pendingTocTarget?: PendingSearchTarget | null
  aiLayoutEnabled?: boolean
  aiLayoutByPageId?: Record<string, string>
  aiLayoutLoading?: Record<string, boolean>
  aiLayoutErrors?: Record<string, string>
  highlightColor?: string
  noteHighlightsByElement: Map<string, ReaderNoteHighlight[]>
  onSelectedTextChange?: (text: string) => void
  onReaderSelection?: (pageIndex: number, elementIndex: number, event?: SelectionMouseEvent) => void
  displayScript?: ReaderDisplayScript
  searchActiveOnly?: boolean
}) {
  const themeStyle = themeStyles[theme]
  const effectiveHighlightColor = normalizeHighlightColor(highlightColor)
  const isSpread = rowPages.length > 1
  const shellStyle = adaptivePages
    ? { width: '100%', minHeight: '100%', overflow: 'visible', padding: '14px 18px 18px', display: 'flex', justifyContent: 'center', alignItems: 'center' as const }
    : { width: '100%', minHeight: '100%', overflow: 'visible', padding: '14px 18px 18px' }
  const gridStyle = adaptivePages
    ? { display: 'grid', gridTemplateColumns: isSpread ? `${pageMetrics.pageWidth}px ${pageMetrics.pageWidth}px` : `${pageMetrics.pageWidth}px`, gap: isSpread ? 24 : 0, justifyContent: 'center', alignItems: 'center' }
    : { display: 'grid', gridTemplateColumns: isSpread ? 'minmax(360px, 1fr) minmax(360px, 1fr)' : 'minmax(360px, 860px)', gap: isSpread ? 24 : 0, justifyContent: 'center', alignItems: 'start' }
  const searchMatchesByElement = useMemo(() => {
    const map = new Map<string, ReaderSearchMatch[]>()
    searchMatches.forEach((match) => {
      const key = `${match.pageIndex}:${match.elementIndex}`
      const list = map.get(key)
      if (list) list.push(match)
      else map.set(key, [match])
    })
    return map
  }, [searchMatches])
  return (
    <div style={shellStyle}>
      <div style={gridStyle}>
        {rowPages.map((page, offset) => {
          const pageIndex = pageIndices[offset] ?? offset
          const pageId = page?.id
          const aiText = aiLayoutEnabled && pageId ? String(aiLayoutByPageId?.[pageId] || '').trim() : ''
          const elements = getDisplayPageElements(page, aiText)
          const elementGroups: ReaderElementGroup[] = elements.map((element, index) => {
            const activeHitElementIndex = Number(activeSearchHit?.elementIndex)
            const hasActiveHitElementIndex = Number.isFinite(activeHitElementIndex) && activeHitElementIndex >= 0
            const activeElementByChar = !hasActiveHitElementIndex
              && activeSearchHit?.pageIndex === pageIndex
              && activeSearchHit.charIndex >= element.charStart
              && activeSearchHit.charIndex <= element.charEnd
            const activeElementByIndex = activeSearchHit?.pageIndex === pageIndex && activeSearchHit.elementIndex === index
            const elementMatches = searchMatchesByElement.get(`${pageIndex}:${index}`) || []
            const orderedElementMatches = elementMatches
              .slice()
              .sort((left, right) => left.occurrenceIndex - right.occurrenceIndex || left.charIndex - right.charIndex || Number(left.globalIndex ?? 0) - Number(right.globalIndex ?? 0))
            const globalMatchIndexes = orderedElementMatches
              .map((match) => Number(match.globalIndex))
              .filter((value) => Number.isFinite(value))
            const globalSearchStartIndex = globalMatchIndexes.length
              ? Math.min(...globalMatchIndexes)
              : null
            const activeGlobalIndex = Number.isFinite(Number(activeSearchHit?.globalIndex)) ? Number(activeSearchHit?.globalIndex) : null
            const activeByGlobalIndex = activeGlobalIndex !== null
            const activeOccurrenceByGlobalIndex = activeGlobalIndex !== null
              ? orderedElementMatches
                .findIndex((match) => Number(match.globalIndex) === activeGlobalIndex)
              : -1
            const activeOccurrenceIndex = activeByGlobalIndex
              ? activeOccurrenceByGlobalIndex >= 0 ? activeOccurrenceByGlobalIndex : null
              : activeElementByChar || activeElementByIndex
                ? activeSearchHit?.occurrenceIndex ?? 0
                : null
            return {
              element,
              index,
              anchorId: getElementAnchorId(page, pageIndex, index),
              activeHit: activeOccurrenceIndex,
              activeGlobalHitIndex: activeGlobalIndex,
              globalSearchStartIndex,
              globalSearchHitIndexes: globalMatchIndexes.length ? globalMatchIndexes : null,
            }
          })
          const bodyElementGroups = elementGroups.filter((item) => !isFootnoteElement(item.element))
          const footnoteElementGroups = elementGroups.filter((item) => isFootnoteElement(item.element))
          const isAiLoading = !!(aiLayoutEnabled && pageId && aiLayoutLoading?.[pageId] && !aiText)
          const aiError = aiLayoutEnabled && pageId ? String(aiLayoutErrors?.[pageId] || '') : ''
          const pageTitle = getReaderPageHeaderTitle(page, pageIndex)
          return (
            <article
              key={page?.id || pageIndex}
              data-source-reader-page="true"
              data-reader-page="true"
              data-reader-page-viewport="true"
              data-reader-page-index={pageIndex}
              data-reader-leaf-index={pageIndex}
              onMouseUp={(event) => {
                const text = window.getSelection()?.toString()?.trim() || ''
                onSelectedTextChange?.(text)
                const target = event.target
                const handledByElement = target instanceof HTMLElement && !!target.closest('[data-source-anchor="true"]')
                if (text && !handledByElement) onReaderSelection?.(pageIndex, 0, event)
              }}
              style={adaptivePages
                ? { width: pageMetrics.pageWidth, height: pageMetrics.pageHeight, margin: '0 auto', background: themeStyle.page, color: themeStyle.text, border: `1px solid ${themeStyle.border}`, borderRadius: 6, boxShadow: '0 16px 40px rgba(0,0,0,0.35)', position: 'relative', overflow: 'hidden' }
                : { minHeight: 'calc(100vh - 220px)', background: themeStyle.page, color: themeStyle.text, border: `1px solid ${themeStyle.border}`, borderRadius: 6, boxShadow: '0 16px 40px rgba(0,0,0,0.35)', position: 'relative', overflow: 'visible' }}
            >
              <div style={{ position: 'absolute', top: 14, left: 24, right: 24, display: 'flex', justifyContent: 'space-between', color: themeStyle.muted, fontSize: 12, gap: 12 }}>
                <span style={{ maxWidth: '68%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{transformReaderDisplayText(pageTitle, displayScript)}</span>
                <span>{String(parseMaybeRecord(page?.ocr_result).source_type || '') === 'ebook_virtual_page' ? `阅读页 ${pageIndex + 1}/${pageCount}` : `第 ${page?.page_num || pageIndex + 1}/${pageCount} 页`}</span>
              </div>
              {aiLayoutEnabled && (isAiLoading || aiError) ? (
                <div style={{ position: 'absolute', top: 34, left: 42, right: 42, zIndex: 4, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
                  <div style={{
                    padding: '6px 12px',
                    borderRadius: 999,
                    border: `1px solid ${aiError ? 'rgba(190,62,48,0.36)' : 'rgba(214,168,95,0.45)'}`,
                    background: aiError ? 'rgba(255,235,230,0.92)' : 'rgba(255,248,230,0.96)',
                    color: aiError ? '#9f2d20' : '#8b5c16',
                    fontSize: 13,
                    fontWeight: 700,
                    boxShadow: '0 8px 22px rgba(70,42,10,0.16)',
                  }}>
                    {aiError ? `AI 排版失败：${aiError}` : 'AI 正在排版当前页...'}
                  </div>
                </div>
              ) : null}
              <div data-reader-content="true" style={adaptivePages
                ? { height: pageMetrics.textHeight, margin: '48px 42px 24px', fontFamily: "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif", fontSize, lineHeight, whiteSpace: 'normal', overflowWrap: 'break-word', textAlign: 'justify', overflow: 'hidden' }
                : { margin: '58px 48px 42px', fontFamily: "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif", fontSize, lineHeight, whiteSpace: 'normal', overflowWrap: 'break-word', textAlign: 'justify', overflow: 'visible' }}>
                {bodyElementGroups.length
                  ? bodyElementGroups.map((group) => renderReaderElementGroup(group, theme, themeStyle, searchKeyword, effectiveHighlightColor, pendingTocTarget, page, pageIndex, onReaderSelection, searchKeyword.trim() || aiText ? [] : noteHighlightsByElement.get(`${pageIndex}:${group.index}`) || [], displayScript, searchActiveOnly))
                  : <Text style={{ color: themeStyle.muted }}>本页暂无可阅读文本</Text>}
                {renderFootnoteGroup(footnoteElementGroups, theme, pendingTocTarget, searchKeyword, effectiveHighlightColor, displayScript, searchActiveOnly, noteHighlightsByElement, pageIndex)}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
export default function SourcePageReader({
  document,
  pages,
  searchPages,
  currentPageIndex,
  searchKeyword = '',
  highlightColor = '',
  sourceLabel = '',
  searchSession,
  pageTranslations = {},
  translatingPageIds = {},
  skippedTranslationPageIds = {},
  translationGlossaryProjectId = '',
  translationGlossaryProjects = [],
  selectedTextForGlossary = '',
  displayScript = 'original',
  bookTranslationRequest = 0,
  onDisplayScriptChange,
  onPageIndexChange,
  onSearchKeywordChange,
  onSelectedTextChange,
  onContextTextChange,
  onDocumentMetadataChange,
  onTranslateCurrentPage,
  onTranslationGlossaryProjectChange,
  onAddSelectedTerm,
  onReaderStateChange,
}: SourcePageReaderProps) {
  const [tocOpen, setTocOpen] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('spread')
  const [fontSize, setFontSize] = useState(17)
  const [lineHeight, setLineHeight] = useState(1.9)
  const [theme, setTheme] = useState<ReaderTheme>('paper')
  const [translationOpen, setTranslationOpen] = useState(false)
  const [activeParallelSegmentId, setActiveParallelSegmentId] = useState('')
  const [localSearchInput, setLocalSearchInput] = useState(searchKeyword)
  const [searchCursor, setSearchCursor] = useState(-1)
  const [sessionSearchCursor, setSessionSearchCursor] = useState(-1)
  const [toc, setToc] = useState<TocItemV2[]>([])
  const [tocDraft, setTocDraft] = useState<TocDraftItem[]>([])
  const [tocLoading, setTocLoading] = useState(false)
  const [tocEditMode, setTocEditMode] = useState(false)
  const [tocSaving, setTocSaving] = useState(false)
  const [ruleTocLoading, setRuleTocLoading] = useState(false)
  const [aiTocLoading, setAiTocLoading] = useState(false)
  const [aiLayoutEnabled, setAiLayoutEnabled] = useState(false)
  const [aiLayoutByPageId, setAiLayoutByPageId] = useState<Record<string, string>>({})
  const [aiLayoutLoading, setAiLayoutLoading] = useState<Record<string, boolean>>({})
  const [aiLayoutErrors, setAiLayoutErrors] = useState<Record<string, string>>({})
  const [localSearchEdited, setLocalSearchEdited] = useState(false)
  const [tocPageIndexMap, setTocPageIndexMap] = useState<Map<string, number>>(() => new Map())
  const [tocResolveState, setTocResolveState] = useState<TocResolveState>({ resolved: 0, total: 0, running: false, unresolved: 0 })
  const [pendingTocTarget, setPendingTocTarget] = useState<PendingSearchTarget | null>(null)
  const [activeTocJumpKey, setActiveTocJumpKey] = useState('')
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
  const incomingSearchSessionKey = getSearchSessionStateKey(searchSession)
  const incomingSearchSession = incomingSearchSessionKey && incomingSearchSessionKey === dismissedSearchSessionKey ? undefined : searchSession
  const effectiveSearchSession = localSearchSession || incomingSearchSession || undefined

  const readerScrollRef = useRef<HTMLDivElement | null>(null)
  const tocScrollRef = useRef<HTMLDivElement | null>(null)
  const pageInputRef = useRef<InputRef | null>(null)
  const pendingAnchorRef = useRef<string | null>(null)
  const pendingSearchTargetRef = useRef<PendingSearchTarget | null>(null)
  const searchNavigationTokenRef = useRef(0)
  const localSearchCursorRef = useRef(-1)
  const sessionSearchCursorRef = useRef(-1)
  const appliedIndexedSearchKeyRef = useRef('')
  const activeTocJumpKeyRef = useRef('')
  const tocJumpSuppressUntilRef = useRef(0)
  const aiLayoutInFlightRef = useRef<Set<string>>(new Set())
  const aiLayoutGenerationRef = useRef(0)
  const handledBookTranslationRequestRef = useRef(0)
  const indexedSearchRequestRef = useRef(0)
  const emittedLocalSearchKeywordRef = useRef('')
  const localSearchEditedRef = useRef(false)
  const [readerViewportHeight, setReaderViewportHeight] = useState(720)
  const [readerViewportWidth, setReaderViewportWidth] = useState(1100)
  const readerPageMetrics = useMemo(
    () => getReaderPageMetrics(viewMode, fontSize, lineHeight, readerViewportHeight, readerViewportWidth),
    [fontSize, lineHeight, readerViewportHeight, readerViewportWidth, viewMode],
  )

  const sourcePages = useMemo(() => [...(pages || [])].sort((left, right) => Number(left?.page_num || 0) - Number(right?.page_num || 0)), [pages])
  const isEbook = useMemo(() => isEbookReaderDocument(document, sourcePages), [document, sourcePages])
  const sortedPages = useMemo(
    () => isEbook ? buildEbookVirtualPages(sourcePages, viewMode, fontSize, lineHeight, readerViewportHeight, readerViewportWidth) : sourcePages,
    [fontSize, isEbook, lineHeight, readerViewportHeight, readerViewportWidth, sourcePages, viewMode],
  )
  const pageCount = sortedPages.length
  const safeIndex = Math.max(0, Math.min(pageCount - 1, currentPageIndex || 0))
  const sortedPagesRef = useRef<ReaderSourcePage[]>([])
  const safeIndexRef = useRef(0)
  const activePage = sortedPages[safeIndex]
  const activeText = getPageText(activePage)
  const visiblePageIndices = useMemo(() => {
    if (!pageCount) return []
    if (viewMode === 'single') return [safeIndex]
    const start = safeIndex % 2 === 0 ? safeIndex : safeIndex - 1
    return [start, start + 1].filter((index) => index >= 0 && index < pageCount)
  }, [pageCount, safeIndex, viewMode])
  const visiblePageKey = visiblePageIndices.join('|')
  const visiblePages = useMemo(() => visiblePageIndices.map((index) => sortedPages[index]), [sortedPages, visiblePageIndices])
  const pageLocatorIndex = useMemo(() => buildPageLocatorIndex(sortedPages), [sortedPages])
  useEffect(() => {
    sortedPagesRef.current = sortedPages
    safeIndexRef.current = safeIndex
  }, [safeIndex, sortedPages])
  const translationPageIndex = safeIndex
  const translationPage = sortedPages[translationPageIndex] || activePage
  const translationPageId = translationPage?.id
  const translationSourceText = getCanonicalTranslationPageText(translationPage, aiLayoutEnabled, aiLayoutByPageId)
  const rawActiveTranslationText = translationPageId ? pageTranslations[translationPageId] || '' : ''
  const activeTranslationLoading = translationPageId ? !!translatingPageIds[translationPageId] : false
  const activeTranslationSkipped = translationPageId ? !!skippedTranslationPageIds[translationPageId] : false
  const activeTranslationText = activeTranslationSkipped || isParallelTranslationDisplayReady(translationSourceText, rawActiveTranslationText)
    ? rawActiveTranslationText
    : ''
  const translationPageTitle = translationPage ? getReaderPageHeaderTitle(translationPage, translationPageIndex) : ''
  const translationPageLabel = translationPage ? (isEbook ? `阅读页 ${translationPageIndex + 1}/${pageCount}` : `第 ${translationPage.page_num || translationPageIndex + 1}/${pageCount} 页`) : ''
  const pageStep = translationOpen ? 1 : viewMode === 'spread' ? 2 : 1
  const queuedTranslationPages = useMemo(() => {
    if (!translationOpen) return []
    return [translationPageIndex, translationPageIndex + 1, translationPageIndex + 2]
      .map((index) => sortedPages[index])
      .filter((page): page is ReaderSourcePageWithId => isReaderSourcePageWithId(page) && Boolean(getCanonicalTranslationPageText(page, aiLayoutEnabled, aiLayoutByPageId)))
  }, [aiLayoutByPageId, aiLayoutEnabled, sortedPages, translationOpen, translationPageIndex])
  const visibleAiLoadingCount = visiblePages.filter((page) => {
    const pageId = page?.id
    return Boolean(pageId && aiLayoutLoading[pageId] && !aiLayoutByPageId[pageId])
  }).length
  const visibleAiReadyCount = visiblePages.filter((page) => {
    const pageId = page?.id
    return Boolean(pageId && aiLayoutByPageId[pageId])
  }).length
  const visibleAiErrorCount = visiblePages.filter((page) => {
    const pageId = page?.id
    return Boolean(pageId && aiLayoutErrors[pageId])
  }).length
  const style = themeStyles[theme]
  const tocPageIndexVersion = useMemo(() => toc.map(getTocItemKey).join('|'), [toc])
  const shouldHideUnresolvedToc = pageCount >= 500
  const visibleToc = useMemo(() => (
    shouldHideUnresolvedToc ? toc.filter((item) => item.status !== 'unresolved') : toc
  ), [shouldHideUnresolvedToc, toc])
  const hiddenUnresolvedTocCount = toc.length - visibleToc.length
  const tocBusy = ruleTocLoading || aiTocLoading || tocResolveState.running
  const tocBusyTitle = aiTocLoading
    ? '正在整理目录'
    : ruleTocLoading
      ? '正在生成目录'
      : tocLoading
        ? '正在读取目录'
        : '正在匹配目录'
  const tocBusyHint = tocResolveState.running
    ? `正在精准匹配目录锚点 ${tocResolveState.resolved}/${tocResolveState.total}`
    : '正在读取目录或执行手动生成，长文献可能会短暂卡顿。'
  const effectiveHighlightColor = normalizeHighlightColor(readerHighlightColor || highlightColor)
  const readerNoteHighlightsByElement = useMemo(
    () => buildReaderNoteHighlightsByElement(readerNotes, sortedPages),
    [readerNotes, sortedPages],
  )

  const aiLayoutCandidatePages = useMemo(() => {
    const result: ReaderSourcePageWithId[] = []
    const prefetchCount = viewMode === 'spread' ? 2 : 1
    for (let offset = 0; offset < prefetchCount; offset += 1) {
      const page = sortedPages[safeIndex + offset]
      if (isReaderSourcePageWithId(page)) result.push(page)
    }
    return result
  }, [safeIndex, sortedPages, viewMode])

  useEffect(() => {
    localSearchEditedRef.current = localSearchEdited
  }, [localSearchEdited])

  useEffect(() => {
    const nextSearchKeyword = searchKeyword || ''
    const isLocalSearchEcho = localSearchEditedRef.current && emittedLocalSearchKeywordRef.current === nextSearchKeyword
    setLocalSearchInput(nextSearchKeyword)
    if (isLocalSearchEcho) {
      if (nextSearchKeyword.trim()) setDismissedSearchSessionKey('')
      return
    }
    setSearchCursor(-1)
    setSessionSearchCursor(-1)
    localSearchCursorRef.current = -1
    sessionSearchCursorRef.current = -1
    setLocalSearchEdited(false)
    localSearchEditedRef.current = false
    emittedLocalSearchKeywordRef.current = ''
    setLocalSearchSession(null)
    indexedSearchRequestRef.current += 1
    if (searchKeyword.trim()) setDismissedSearchSessionKey('')
  }, [searchKeyword])

  useEffect(() => {
    const query = localSearchInput.trim()
    const docId = document?.id
    if (!localSearchEdited || !docId || !query) return
    const requestId = ++indexedSearchRequestRef.current
    setLocalSearchSession((previous) => {
      if (previous?.query === query && previous.status === 'searching') return previous
      return { query, hits: [], activeHitIndex: -1, status: 'searching' }
    })
    const timer = window.setTimeout(() => {
      window.api.getDocumentSearchHits(docId, query, { limit: 20000, resultMode: 'all' })
        .then((session) => {
          if (indexedSearchRequestRef.current !== requestId) return
          const hits = Array.isArray(session?.hits) ? session.hits : []
          const latestPages = sortedPagesRef.current
          const latestLocatorIndex = buildPageLocatorIndex(latestPages)
          const latestSafeIndex = safeIndexRef.current
          const currentPageIndex = hits.findIndex((hit) => findPageIndexForLocatorFast(latestLocatorIndex, hit.locator) === latestSafeIndex)
          const activeHitIndex = currentPageIndex >= 0
            ? currentPageIndex
            : Number(session?.activeHitIndex) >= 0
              ? Math.min(hits.length - 1, Number(session.activeHitIndex))
              : hits.length > 0
                ? 0
                : -1
          localSearchCursorRef.current = -1
          sessionSearchCursorRef.current = activeHitIndex
          setSearchCursor(-1)
          setSessionSearchCursor(activeHitIndex)
          setLocalSearchSession({
            query,
            hits,
            activeHitIndex,
            status: session?.status === 'error' ? 'error' : 'ready',
          })
        })
        .catch((error: unknown) => {
          if (indexedSearchRequestRef.current !== requestId) return
          console.error('Failed to load source reader search hits', error)
          localSearchCursorRef.current = -1
          sessionSearchCursorRef.current = -1
          setSearchCursor(-1)
          setSessionSearchCursor(-1)
          setLocalSearchSession({ query, hits: [], activeHitIndex: -1, status: 'error' })
        })
    }, 180)
    return () => {
      window.clearTimeout(timer)
    }
  }, [document?.id, localSearchEdited, localSearchInput])

  useEffect(() => {
    if (localSearchInput.trim()) {
      setTocOpen(true)
      setReaderSidebarTab('search')
      setSearchResultPage(1)
      return
    }
    setSearchResultPage(1)
  }, [localSearchInput])

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
    if (!isEbook) return
    if ((currentPageIndex || 0) !== safeIndex) onPageIndexChange(safeIndex)
  }, [currentPageIndex, isEbook, onPageIndexChange, safeIndex])

  useEffect(() => {
    setActiveParallelSegmentId('')
  }, [translationPage?.id, translationOpen])

  useEffect(() => {
    if (!bookTranslationRequest || !sortedPages.length) return
    if (handledBookTranslationRequestRef.current === bookTranslationRequest) return
    handledBookTranslationRequestRef.current = bookTranslationRequest
    const bookPages = sortedPages
      .map((page, index) => ({ page, index }))
      .filter((item): item is { page: ReaderSourcePageWithId; index: number } => isReaderSourcePageWithId(item.page))
    if (!bookPages.length) {
      message.info('当前阅读器没有可翻译页面')
      return
    }
    setTranslationOpen(true)
    let queuedCount = 0
    bookPages.forEach(({ page, index }) => {
      const text = getCanonicalTranslationPageText(page, aiLayoutEnabled, aiLayoutByPageId)
      if (!text) return
      queuedCount += 1
      onTranslateCurrentPage?.(
        {
          pageId: page.id,
          readerPageKey: page.id,
          cachePageId: getTranslationCachePageId(page),
          pageNum: Number(page.page_num || index + 1),
          text,
        },
        { priority: 'book' },
      )
    })
    if (queuedCount > 0) message.success(`已按阅读器页面加入整书翻译队列：${queuedCount} 页`)
    else message.info('当前阅读器没有可翻译文本')
  }, [aiLayoutByPageId, aiLayoutEnabled, bookTranslationRequest, onTranslateCurrentPage, sortedPages])

  useEffect(() => {
    if (!translationOpen || !queuedTranslationPages.length) return
    queuedTranslationPages.forEach((page, index) => {
      const text = getCanonicalTranslationPageText(page, aiLayoutEnabled, aiLayoutByPageId)
      if (!text) return
      onTranslateCurrentPage?.(
        {
          pageId: page.id,
          readerPageKey: page.id,
          cachePageId: getTranslationCachePageId(page),
          pageNum: Number(page.page_num || translationPageIndex + index + 1),
          text,
        },
        { priority: index === 0 ? 'current' : 'prefetch' },
      )
    })
  }, [aiLayoutByPageId, aiLayoutEnabled, onTranslateCurrentPage, queuedTranslationPages, translationOpen, translationPageIndex])

  useEffect(() => {
    setSessionSearchCursor(effectiveSearchSession?.activeHitIndex ?? -1)
  }, [effectiveSearchSession?.activeHitIndex, effectiveSearchSession?.query, effectiveSearchSession?.hits?.length])

  useEffect(() => {
    aiLayoutGenerationRef.current += 1
    aiLayoutInFlightRef.current.clear()
    setAiLayoutByPageId({})
    setAiLayoutLoading({})
    setAiLayoutErrors({})
  }, [document?.id])

  useEffect(() => {
    const measure = () => {
      const nextHeight = readerScrollRef.current?.clientHeight || window.innerHeight || 720
      const nextWidth = readerScrollRef.current?.clientWidth || window.innerWidth || 1100
      setReaderViewportHeight((current) => Math.abs(current - nextHeight) > 24 ? nextHeight : current)
      setReaderViewportWidth((current) => Math.abs(current - nextWidth) > 24 ? nextWidth : current)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    const docId = document?.id
    if (!docId) return
    let cancelled = false
    let timer: number | null = null
    setTocLoading(true)
    setToc([])
    setTocDraft([])
    timer = window.setTimeout(() => {
      window.api.getDocumentToc(docId)
        .then((items: TocItemV2[]) => {
          if (cancelled) return
          const normalized = normalizeTocItems(items || [])
          setToc(normalized)
          setTocDraft(toTocDraftItems(normalized))
        })
        .catch(() => {
          if (!cancelled) {
            setToc([])
            setTocDraft([])
          }
        })
        .finally(() => {
          if (!cancelled) setTocLoading(false)
        })
    }, 60)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [document?.id])

  useEffect(() => {
    if (!toc.length || !sortedPages.length) {
      setTocPageIndexMap(new Map())
      setTocResolveState({ resolved: 0, total: 0, running: false, unresolved: 0 })
      return
    }

    let cancelled = false
    const directMap = buildDirectTocPageIndexMap(sortedPages, toc)
    const unresolved = toc.filter((item) => (directMap.get(getTocItemKey(item)) ?? -1) < 0 && item.status !== 'disabled')
    setTocPageIndexMap(directMap)
    setTocResolveState({
      resolved: 0,
      total: 0,
      running: false,
      unresolved: unresolved.length,
    })

    return () => {
      cancelled = true
    }
  }, [sortedPages, toc, tocPageIndexVersion])

  useEffect(() => {
    const pageContext = visiblePages.map(getPageText).filter(Boolean).join('\n\n')
    const notesContext = buildReaderNotesContext(readerNotes, activePage?.page_num, safeIndex)
    onContextTextChange?.([notesContext, pageContext].filter(Boolean).join('\n\n'))
    onReaderStateChange?.({
      location_key: isEbook
        ? `ebook:${activePage?.source_page_start_num || activePage?.page_num || safeIndex + 1}:${safeIndex + 1}`
        : `page:${activePage?.page_num || safeIndex + 1}`,
      progress: pageCount <= 1 ? 1 : safeIndex / Math.max(1, pageCount - 1),
      view_mode: viewMode,
      font_size: fontSize,
      line_height: lineHeight,
      theme,
    })
  }, [activePage?.page_num, activePage?.source_page_start_num, fontSize, isEbook, lineHeight, onContextTextChange, onReaderStateChange, pageCount, readerNotes, safeIndex, theme, viewMode, visiblePages])

  useEffect(() => {
    const docId = document?.id
    if (!aiLayoutEnabled || !docId || aiLayoutCandidatePages.length === 0) return
    let cancelled = false
    const sourceHashByPageId = new Map(aiLayoutCandidatePages.map((page) => [page.id, getPageSourceHash(page)]))
    window.api.getAiLayoutCache(docId, aiLayoutCandidatePages.map((page) => page.id), 'reading_layout')
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return
        setAiLayoutByPageId((current) => {
          const next = { ...current }
          rows.forEach((row) => {
            if (row.status === 'ready' && row.result_text && sourceHashByPageId.get(row.page_id) === row.source_hash) {
              next[row.page_id] = row.result_text
            }
          })
          return next
        })
      })
      .catch((error: unknown) => console.error(error))
    return () => {
      cancelled = true
    }
  }, [aiLayoutCandidatePages, aiLayoutEnabled, document?.id])

  useEffect(() => {
    const docId = document?.id
    if (!aiLayoutEnabled || !docId || aiLayoutCandidatePages.length === 0) return
    const generation = aiLayoutGenerationRef.current
    const timers: number[] = []
    const pendingFlights: string[] = []
    aiLayoutCandidatePages.forEach((page, index) => {
      const sourceText = getPageText(page)
      if (!sourceText || aiLayoutByPageId[page.id]) return
      if (aiLayoutErrors[page.id]) return
      const sourceHash = getPageSourceHash(page)
      const flightKey = `${page.id}:${sourceHash}`
      if (aiLayoutInFlightRef.current.has(flightKey)) return
      aiLayoutInFlightRef.current.add(flightKey)
      pendingFlights.push(flightKey)
      setAiLayoutErrors((current) => {
        if (!current[page.id]) return current
        const next = { ...current }
        delete next[page.id]
        return next
      })
      const timer = window.setTimeout(async () => {
        setAiLayoutLoading((current) => ({ ...current, [page.id]: true }))
        try {
          const row = await withTimeout<AiLayoutCacheItem | null>(
            window.api.runAiLayoutPage(docId, page.id, 'reading_layout', sourceText, sourceHash),
            AI_LAYOUT_FRONTEND_TIMEOUT_MS,
            'AI 排版超时，已恢复原文显示。可稍后重试或换用更快的模型。',
          )
          if (aiLayoutGenerationRef.current === generation && row?.result_text && row.source_hash === sourceHash) {
            setAiLayoutByPageId((current) => ({ ...current, [page.id]: row.result_text }))
          }
        } catch (error: unknown) {
          console.error(error)
          const errorMessage = getErrorMessage(error, 'AI 排版失败')
          try {
            const rows = await window.api.getAiLayoutCache(docId, [page.id], 'reading_layout')
            const cached = rows.find((row) => row?.status === 'ready' && row?.result_text && row.source_hash === sourceHash)
            if (cached?.result_text) {
              setAiLayoutByPageId((current) => ({ ...current, [page.id]: cached.result_text }))
              setAiLayoutErrors((current) => {
                if (!current[page.id]) return current
                const next = { ...current }
                delete next[page.id]
                return next
              })
              return
            }
          } catch (cacheError) {
            console.error(cacheError)
          }
          if (/超时|timeout/i.test(errorMessage)) {
            for (let attempt = 0; attempt < 4; attempt += 1) {
              await delay(2500)
              try {
                const rows = await window.api.getAiLayoutCache(docId, [page.id], 'reading_layout')
                const cached = rows.find((row) => row?.status === 'ready' && row?.result_text && row.source_hash === sourceHash)
                if (cached?.result_text) {
                  setAiLayoutByPageId((current) => ({ ...current, [page.id]: cached.result_text }))
                  setAiLayoutErrors((current) => {
                    if (!current[page.id]) return current
                    const next = { ...current }
                    delete next[page.id]
                    return next
                  })
                  return
                }
              } catch (cacheError) {
                console.error(cacheError)
              }
            }
          }
          setAiLayoutErrors((current) => ({ ...current, [page.id]: errorMessage }))
          if (index === 0) message.error(errorMessage)
        } finally {
          aiLayoutInFlightRef.current.delete(flightKey)
          setAiLayoutLoading((current) => ({ ...current, [page.id]: false }))
        }
      }, index === 0 ? 0 : 2200 + index * 1200)
      timers.push(timer)
    })
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      pendingFlights.forEach((flightKey) => aiLayoutInFlightRef.current.delete(flightKey))
      setAiLayoutLoading((current) => {
        const next = { ...current }
        aiLayoutCandidatePages.forEach((page) => {
          if (page?.id && !aiLayoutByPageId[page.id]) next[page.id] = false
        })
        return next
      })
    }
  }, [aiLayoutByPageId, aiLayoutCandidatePages, aiLayoutEnabled, aiLayoutErrors, document?.id])

  const effectiveSessionHits = effectiveSearchSession?.hits || []
  const hasIncomingLocatorSession = !localSearchEdited && effectiveSessionHits.length > 0
  const hasMatchingSearchSession = effectiveSearchSession?.query?.trim() === localSearchInput.trim() && effectiveSessionHits.length > 0
  const hasFullLocalSearchPages = !isEbook && Array.isArray(searchPages) && searchPages.length >= sortedPages.length
  const searchSourcePages = useMemo(() => {
    if (!isEbook && Array.isArray(searchPages) && searchPages.length >= sortedPages.length) {
      return [...searchPages].sort((left, right) => Number(left?.page_num || 0) - Number(right?.page_num || 0))
    }
    return sortedPages
  }, [isEbook, searchPages, sortedPages])

  const allSearchMatches = useMemo(() => {
    const keyword = localSearchInput.trim()
    if (!keyword) return []
    if (localSearchEdited || hasMatchingSearchSession || !hasFullLocalSearchPages) return []
    return readerSearchHitsToMatches(searchSourcePages, keyword, document?.id)
  }, [document?.id, hasFullLocalSearchPages, hasMatchingSearchSession, localSearchEdited, localSearchInput, searchSourcePages])

  const hasReaderNavigation = allSearchMatches.length > 0 && !hasIncomingLocatorSession
  const hasSessionNavigation = hasMatchingSearchSession
  const sessionHitIndexesByPage = useMemo(() => {
    const map = new Map<number, number[]>()
    if (!hasSessionNavigation) return map
    effectiveSessionHits.forEach((hit, index) => {
      const pageIndex = findPageIndexForLocatorFast(pageLocatorIndex, hit.locator)
      if (pageIndex < 0) return
      const list = map.get(pageIndex)
      if (list) list.push(index)
      else map.set(pageIndex, [index])
    })
    return map
  }, [effectiveSessionHits, hasSessionNavigation, pageLocatorIndex])
  const searchIndexLoading = Boolean(localSearchInput.trim())
    && effectiveSearchSession?.query?.trim() === localSearchInput.trim()
    && effectiveSearchSession.status === 'searching'
  const currentPageSessionHitIndex = hasSessionNavigation
    ? sessionHitIndexesByPage.get(safeIndex)?.[0] ?? -1
    : -1
  const effectiveSessionHitIndex = hasSessionNavigation
    ? sessionSearchCursor >= 0 && sessionSearchCursor < effectiveSessionHits.length
      ? sessionSearchCursor
      : currentPageSessionHitIndex >= 0
        ? currentPageSessionHitIndex
      : effectiveSearchSession && effectiveSearchSession.activeHitIndex >= 0
        ? Math.min(effectiveSessionHits.length - 1, effectiveSearchSession.activeHitIndex)
        : 0
    : -1

  const sessionActiveHit = useMemo(() => {
    if (!effectiveSearchSession?.hits?.length || effectiveSessionHitIndex < 0) return null
    const hit = effectiveSearchSession.hits[effectiveSessionHitIndex]
    if (!hit?.locator) return null
    const pageIndex = findPageIndexForLocatorFast(pageLocatorIndex, hit.locator)
    if (pageIndex < 0 || pageIndex >= sortedPages.length) return null
    const match = locateSearchMatchByLocator(sortedPages[pageIndex], pageIndex, hit.locator, hit.locator.queryTerm || localSearchInput)
    return { ...match, globalIndex: effectiveSessionHitIndex, sessionIndex: effectiveSessionHitIndex }
  }, [effectiveSearchSession, effectiveSessionHitIndex, localSearchInput, sortedPages])
  const sessionLocalSearchIndex = useMemo(() => {
    if (!sessionActiveHit || !allSearchMatches.length) return -1
    return allSearchMatches
      .map((hit, index) => ({
        index,
        distance: hit.pageIndex === sessionActiveHit.pageIndex
          ? Math.abs(Number(hit.charIndex || 0) - Number(sessionActiveHit.charIndex || 0))
          : Number.MAX_SAFE_INTEGER,
      }))
      .filter((item) => item.distance < Number.MAX_SAFE_INTEGER)
      .sort((left, right) => left.distance - right.distance || left.index - right.index)[0]?.index ?? -1
  }, [allSearchMatches, sessionActiveHit])

  const searchMatches = useMemo(() => {
    const pageIndices = new Set<number>([
      ...visiblePageIndices,
      Math.max(0, safeIndex - 1),
      safeIndex,
      Math.min(pageCount - 1, safeIndex + 1),
    ])
    const visibleLocalMatches = allSearchMatches.filter((match) => pageIndices.has(match.pageIndex))
    if (hasSessionNavigation) {
      const sessionIndexes = Array.from(pageIndices)
        .flatMap((pageIndex) => sessionHitIndexesByPage.get(pageIndex) || [])
      if (effectiveSessionHitIndex >= 0 && !sessionIndexes.includes(effectiveSessionHitIndex)) {
        sessionIndexes.push(effectiveSessionHitIndex)
      }
      const visibleSessionMatches = sessionIndexes
        .map((index) => {
          const hit = effectiveSessionHits[index]
          if (!hit?.locator) return null
          const pageIndex = findPageIndexForLocatorFast(pageLocatorIndex, hit.locator)
          if (pageIndex < 0 || pageIndex >= sortedPages.length) return null
          const match = locateSearchMatchByLocator(sortedPages[pageIndex], pageIndex, hit.locator, hit.locator.queryTerm || localSearchInput)
          return { ...match, globalIndex: index, sessionIndex: index }
        })
        .filter(Boolean) as ReaderSearchMatch[]
      if (!sessionActiveHit) return visibleSessionMatches
      const hasActive = visibleSessionMatches.some((match) => (
        match.pageIndex === sessionActiveHit.pageIndex
        && match.elementIndex === sessionActiveHit.elementIndex
        && Math.abs(Number(match.charIndex || 0) - Number(sessionActiveHit.charIndex || 0)) <= 2
      ))
      return hasActive ? visibleSessionMatches : [...visibleSessionMatches, sessionActiveHit]
    }
    if (!allSearchMatches.length) return []
    return visibleLocalMatches
  }, [allSearchMatches, effectiveSessionHitIndex, effectiveSessionHits, hasSessionNavigation, localSearchInput, pageCount, pageLocatorIndex, safeIndex, sessionActiveHit, sessionHitIndexesByPage, sortedPages, visiblePageIndices])

  const hasMatchingSessionCursor = effectiveSearchSession?.query?.trim() === localSearchInput.trim()
  const shouldAnchorSearchAtFirstHit = !!localSearchInput.trim() && !hasSessionNavigation && allSearchMatches.length > 0 && searchCursor < 0
  const activeLocalHitIndex = shouldAnchorSearchAtFirstHit ? -1 : searchMatches.findIndex((hit) => hit.pageIndex === safeIndex || visiblePageIndices.includes(hit.pageIndex))
  const sessionCursorLocalIndex = hasMatchingSessionCursor && !hasSessionNavigation && sessionSearchCursor >= 0
    ? searchMatches.findIndex((hit) => hit.sessionIndex === sessionSearchCursor)
    : -1
  const activeSearchHit = hasIncomingLocatorSession && sessionLocalSearchIndex >= 0
    ? allSearchMatches[sessionLocalSearchIndex]
    : hasSessionNavigation
    ? sessionActiveHit
    : (searchCursor >= 0 ? allSearchMatches[searchCursor] : shouldAnchorSearchAtFirstHit ? allSearchMatches[0] || null : sessionCursorLocalIndex >= 0 ? searchMatches[sessionCursorLocalIndex] : activeLocalHitIndex >= 0 ? searchMatches[activeLocalHitIndex] : allSearchMatches[0] || null)
  const renderedActiveSearchHit = Number.isFinite(Number(activeSearchHit?.globalIndex))
    ? searchMatches.find((hit) => hit.globalIndex === activeSearchHit?.globalIndex) || activeSearchHit
    : activeSearchHit
  const renderedSearchKeyword = hasSessionNavigation && effectiveSessionHitIndex >= 0
    ? effectiveSessionHits[effectiveSessionHitIndex]?.locator?.queryTerm || effectiveSessionHits[effectiveSessionHitIndex]?.locator?.matchText || localSearchInput
    : localSearchInput
  const totalSearchHitCount = hasSessionNavigation ? effectiveSessionHits.length : allSearchMatches.length || effectiveSessionHits.length || 0
  const visibleSearchHitIndex = hasSessionNavigation
    ? effectiveSessionHitIndex
    : allSearchMatches.length
      ? searchCursor >= 0
        ? searchCursor
        : Number.isFinite(Number(activeSearchHit?.globalIndex))
          ? Number(activeSearchHit?.globalIndex)
          : -1
      : -1
  const searchCounterText = searchIndexLoading
    ? '检索中'
    : totalSearchHitCount
      ? `${Math.max(0, visibleSearchHitIndex) + 1}/${totalSearchHitCount}`
      : '0/0'
  const canNavigateSearchHits = totalSearchHitCount > 0 && !searchIndexLoading

  useEffect(() => {
    localSearchCursorRef.current = searchCursor
  }, [searchCursor])

  useEffect(() => {
    sessionSearchCursorRef.current = effectiveSessionHitIndex
  }, [effectiveSessionHitIndex])

  const searchDirectoryItemCount = localSearchInput.trim()
    ? hasSessionNavigation || effectiveSearchSession?.hits?.length
      ? effectiveSearchSession?.hits?.length || 0
      : allSearchMatches.length
    : 0
  const searchResultTotalPages = Math.max(1, Math.ceil(searchDirectoryItemCount / READER_SEARCH_RESULT_PAGE_SIZE))
  const searchResultPageSafe = Math.max(1, Math.min(searchResultPage, searchResultTotalPages))
  const visibleSearchDirectoryItems = useMemo<SearchDirectoryItem[]>(() => {
    if (!localSearchInput.trim() || searchDirectoryItemCount <= 0) return []
    const start = (searchResultPageSafe - 1) * READER_SEARCH_RESULT_PAGE_SIZE
    const end = Math.min(searchDirectoryItemCount, start + READER_SEARCH_RESULT_PAGE_SIZE)
    if (!hasSessionNavigation && allSearchMatches.length) {
      return allSearchMatches.slice(start, end).map((hit, offset) => {
        const index = start + offset
        const page = searchSourcePages[hit.pageIndex] || sortedPages[hit.pageIndex]
        const element = page ? getPageElements(page)[hit.elementIndex] : null
        const pageNum = page?.page_num || hit.pageIndex + 1
        const elementText = element ? getElementSearchText(element) : getPageText(page)
        const localChar = Math.max(0, hit.charIndex - Number(element?.charStart || 0))
        return {
          index,
          key: `local-${hit.pageIndex}-${hit.elementIndex}-${hit.charIndex}-${index}`,
          pageLabel: `第 ${pageNum} 页`,
          snippet: makeMarkedSnippet(elementText, localSearchInput, localChar),
          active: index === visibleSearchHitIndex,
          session: false,
        }
      })
    }
    const hits = effectiveSearchSession?.hits || []
    return hits.slice(start, end).map((hit, offset) => {
      const index = start + offset
      const pageIndex = findPageIndexForLocatorFast(pageLocatorIndex, hit.locator)
      const page = pageIndex >= 0 ? sortedPages[pageIndex] : null
      const pageNum = hit.locator.pageNum || page?.page_num || (hit.locator.pageIndex ?? -1) + 1
      const pageText = getPageText(page)
      return {
        index,
        key: `session-${hit.id}-${index}`,
        pageLabel: pageNum > 0 ? `第 ${pageNum} 页` : '正文',
        snippet: hit.snippet || makeMarkedSnippet(pageText, hit.locator.queryTerm || localSearchInput, hit.locator.charStart || 0),
        active: index === effectiveSessionHitIndex,
        session: true,
      }
    })
  }, [allSearchMatches, effectiveSearchSession, effectiveSessionHitIndex, hasSessionNavigation, localSearchInput, pageLocatorIndex, searchDirectoryItemCount, searchResultPageSafe, searchSourcePages, sortedPages, visibleSearchHitIndex])
  const [readerScrollVersion, setReaderScrollVersion] = useState(0)
  const readerScrollVersionRef = useRef(0)
  const refreshReaderPosition = () => {
    readerScrollVersionRef.current += 1
    setReaderScrollVersion(readerScrollVersionRef.current)
  }
  useEffect(() => {
    activeTocJumpKeyRef.current = activeTocJumpKey
  }, [activeTocJumpKey])

  useEffect(() => {
    if (searchResultPage !== searchResultPageSafe) {
      setSearchResultPage(searchResultPageSafe)
    }
  }, [searchResultPage, searchResultPageSafe])

  useEffect(() => {
    const scroller = readerScrollRef.current
    if (!scroller) return
    let frame = 0
    const handleScroll = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (activeTocJumpKeyRef.current && performance.now() > tocJumpSuppressUntilRef.current) {
          activeTocJumpKeyRef.current = ''
          setActiveTocJumpKey('')
        }
        refreshReaderPosition()
      })
    }
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', handleScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [visiblePageKey])

  useEffect(() => {
    const timer = window.setTimeout(refreshReaderPosition, 80)
    return () => window.clearTimeout(timer)
  }, [safeIndex, visiblePageKey])

  const scrollFocusPageIndex = useMemo(() => {
    const scroller = readerScrollRef.current
    if (!scroller || visiblePageIndices.length <= 1) return safeIndex
    const pages = Array.from(scroller.querySelectorAll<HTMLElement>('[data-source-reader-page="true"]'))
    const viewportTop = scroller.getBoundingClientRect().top
    const focusLine = viewportTop + Math.min(scroller.clientHeight * 0.38, 260)
    let bestIndex = safeIndex
    let bestDistance = Number.POSITIVE_INFINITY
    pages.forEach((pageNode) => {
      const index = Number(pageNode.dataset.readerPageIndex)
      if (!Number.isFinite(index)) return
      const rect = pageNode.getBoundingClientRect()
      const distance = rect.top <= focusLine && rect.bottom >= focusLine
        ? 0
        : Math.min(Math.abs(rect.top - focusLine), Math.abs(rect.bottom - focusLine))
      if (distance < bestDistance || (distance === bestDistance && index === safeIndex)) {
        bestDistance = distance
        bestIndex = index
      }
    })
    return bestIndex
  }, [readerScrollVersion, safeIndex, visiblePageKey])
  const computedActiveTocKey = useMemo(() => {
    const focusIndex = scrollFocusPageIndex
    const visible = visibleToc.filter((item) => {
      const pageIndex = tocPageIndexMap.get(getTocItemKey(item)) ?? -1
      return pageIndex >= 0 && pageIndex <= focusIndex
    })
    if (!visible.length) return ''

    const samePageItems = visible.filter((item) => (tocPageIndexMap.get(getTocItemKey(item)) ?? -1) === focusIndex)
    if (!samePageItems.length) return getTocItemKey(visible[visible.length - 1])

    const scroller = readerScrollRef.current
    const focusPage = sortedPages[focusIndex]
    if (scroller && focusPage) {
      const viewportTop = scroller.getBoundingClientRect().top
      const focusLine = viewportTop + Math.min(scroller.clientHeight * 0.38, 260)
      let bestItem: TocItemV2 | null = null
      let bestTop = Number.NEGATIVE_INFINITY
      samePageItems.forEach((item) => {
        const anchorIndex = findAnchorElementIndex(focusPage, item)
        if (anchorIndex < 0) return
        const anchor = window.document.getElementById(getElementAnchorId(focusPage, focusIndex, anchorIndex))
        if (!anchor) return
        const top = anchor.getBoundingClientRect().top
        if (top <= focusLine + 8 && top > bestTop) {
          bestTop = top
          bestItem = item
        }
      })
      if (bestItem) return getTocItemKey(bestItem)
    }

    const previousPageItems = visible.filter((item) => (tocPageIndexMap.get(getTocItemKey(item)) ?? -1) < focusIndex)
    return previousPageItems.length ? getTocItemKey(previousPageItems[previousPageItems.length - 1]) : getTocItemKey(samePageItems[0])
  }, [readerScrollVersion, scrollFocusPageIndex, sortedPages, tocPageIndexMap, visibleToc])
  const activeTocKey = activeTocJumpKey || computedActiveTocKey

  const findTocKeyForPageIndex = (pageIndex: number): string => {
    let bestKey = ''
    let bestPageIndex = -1
    visibleToc.forEach((item) => {
      const itemPageIndex = tocPageIndexMap.get(getTocItemKey(item)) ?? -1
      if (itemPageIndex >= 0 && itemPageIndex <= pageIndex && itemPageIndex >= bestPageIndex) {
        bestKey = getTocItemKey(item)
        bestPageIndex = itemPageIndex
      }
    })
    return bestKey
  }

  useEffect(() => {
    if (!activeTocKey || tocEditMode) return
    const container = tocScrollRef.current
    const target = container?.querySelector<HTMLElement>('[data-reader-toc-active="true"]')
    if (!container || !target) return
    const containerRect = container.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    if (targetRect.top < containerRect.top + 12) {
      container.scrollTop -= containerRect.top + 12 - targetRect.top
    } else if (targetRect.bottom > containerRect.bottom - 12) {
      container.scrollTop += targetRect.bottom - (containerRect.bottom - 12)
    }
  }, [activeTocKey, tocEditMode])

  const jumpToIndex = (nextIndex: number) => {
    onPageIndexChange(Math.max(0, Math.min(pageCount - 1, nextIndex)))
  }

  const nextSearchNavigationToken = () => {
    searchNavigationTokenRef.current += 1
    return searchNavigationTokenRef.current
  }

  const isSearchNavigationCurrent = (token?: number) => !token || token === searchNavigationTokenRef.current

  const scrollToPendingAnchor = (delay = 0, token?: number) => {
    const pendingSearchTarget = pendingSearchTargetRef.current
    const anchorId = pendingSearchTarget?.anchorId || pendingAnchorRef.current
    const expectedToken = token ?? pendingSearchTarget?.token
    if (!anchorId) return
    window.setTimeout(() => {
      if (!isSearchNavigationCurrent(expectedToken)) return
      const anchor = document?.id ? window.document.getElementById(anchorId) : null
      const activeMark = pendingSearchTarget?.active
        ? Number.isFinite(Number(pendingSearchTarget.hitIndex))
          ? anchor?.querySelector(`[data-reader-search-hit-index="${pendingSearchTarget.hitIndex}"]`)
            || readerScrollRef.current?.querySelector(`[data-reader-search-hit-index="${pendingSearchTarget.hitIndex}"]`)
          : anchor?.querySelector('[data-reader-search-hit="active"]')
          || readerScrollRef.current?.querySelector('[data-reader-search-hit="active"]')
        : null
      const tocTarget = pendingSearchTarget?.text
        ? anchor?.querySelector('[data-reader-toc-target="active"]')
        : null
      const target = activeMark || tocTarget || anchor
      if (pendingSearchTarget?.text) tocJumpSuppressUntilRef.current = performance.now() + 1200
      const scroller = readerScrollRef.current
      if (target && scroller) {
        const targetRect = (target as HTMLElement).getBoundingClientRect()
        const scrollerRect = scroller.getBoundingClientRect()
        const comfortableTop = scrollerRect.top + scroller.clientHeight * 0.18
        const comfortableBottom = scrollerRect.top + scroller.clientHeight * 0.78
        const needsScroll = targetRect.top < comfortableTop || targetRect.bottom > comfortableBottom
        if (needsScroll) {
          scroller.scrollTo({
            top: scroller.scrollTop + targetRect.top - scrollerRect.top - (scroller.clientHeight * 0.42),
            behavior: pendingSearchTarget?.active ? 'auto' : 'smooth',
          })
        }
      } else {
        target?.scrollIntoView({ block: 'center', behavior: pendingSearchTarget?.active ? 'auto' : 'smooth' })
      }
      if (!pendingSearchTarget?.active) {
        refreshReaderPosition()
        window.setTimeout(() => {
          if (isSearchNavigationCurrent(expectedToken)) refreshReaderPosition()
        }, 260)
      }
      if (isSearchNavigationCurrent(expectedToken)) pendingSearchTargetRef.current = null
      if (pendingSearchTarget?.text) setPendingTocTarget(null)
      pendingAnchorRef.current = null
    }, delay)
  }

  const jumpToTocItem = (item: TocItemV2, pageIndex: number) => {
    const itemKey = getTocItemKey(item)
    activeTocJumpKeyRef.current = itemKey
    tocJumpSuppressUntilRef.current = performance.now() + 1400
    setActiveTocJumpKey(itemKey)
    const page = sortedPages[pageIndex]
    const anchorIndex = findAnchorElementIndex(page, item)
    const fallbackIndex = anchorIndex >= 0
      ? anchorIndex
      : page
        ? getPageElements(page).findIndex((element) => {
            const elementKey = normalizeForMatch(element.text)
            const targetKey = normalizeForMatch(item.anchor_text || item.title)
            return !!elementKey && !!targetKey && (elementKey.includes(targetKey) || targetKey.includes(elementKey))
          })
        : -1
    const targetIndex = fallbackIndex >= 0 ? fallbackIndex : (page ? 0 : -1)
    const anchorId = targetIndex >= 0 && page ? getElementAnchorId(page, pageIndex, targetIndex) : ''
    if (targetIndex >= 0) {
      pendingAnchorRef.current = anchorId
      pendingSearchTargetRef.current = {
        anchorId,
        text: normalizeTitle(item.anchor_text || item.title),
      }
      setPendingTocTarget(pendingSearchTargetRef.current)
    } else {
      pendingAnchorRef.current = null
      pendingSearchTargetRef.current = null
      setPendingTocTarget(null)
    }
    jumpToIndex(pageIndex)
  }

  useEffect(() => {
    scrollToPendingAnchor(80)
  }, [safeIndex, viewMode, renderedActiveSearchHit?.pageIndex, renderedActiveSearchHit?.elementIndex, renderedActiveSearchHit?.occurrenceIndex])

  useEffect(() => {
    if (pendingTocTarget) scrollToPendingAnchor(60)
  }, [pendingTocTarget])

  const commitPageInput = () => {
    const value = Number(pageInputRef.current?.input?.value)
    if (!Number.isFinite(value)) return
    const pageIndex = findPageIndexByNum(sortedPages, value)
    jumpToIndex(pageIndex >= 0 ? pageIndex : value - 1)
  }

  const activateReaderSearchHit = (hit: ReaderSearchMatch, cursorIndex: number, token = nextSearchNavigationToken()) => {
    localSearchCursorRef.current = cursorIndex
    sessionSearchCursorRef.current = -1
    setSearchCursor(cursorIndex)
    setSessionSearchCursor(-1)
    pendingSearchTargetRef.current = {
      anchorId: sortedPages[hit.pageIndex] ? getElementAnchorId(sortedPages[hit.pageIndex], hit.pageIndex, hit.elementIndex) : '',
      active: true,
      hitIndex: hit.globalIndex ?? cursorIndex,
      token,
    }
    if (hit.pageIndex === safeIndex || visiblePageIndices.includes(hit.pageIndex)) {
      scrollToPendingAnchor(0, token)
    } else {
      jumpToIndex(hit.pageIndex)
    }
  }

  const activateSessionSearchHit = (sessionIndex: number, sessionOverride?: SearchSessionState | null, token = nextSearchNavigationToken()) => {
    const session = sessionOverride || effectiveSearchSession
    if (!session?.hits?.length) return false
    const boundedIndex = (sessionIndex + session.hits.length) % session.hits.length
    const hit = session.hits[boundedIndex]
    const pageIndex = findPageIndexForLocatorFast(pageLocatorIndex, hit?.locator)
    sessionSearchCursorRef.current = boundedIndex
    localSearchCursorRef.current = -1
    setSessionSearchCursor(boundedIndex)
    setSearchCursor(-1)
    if (pageIndex >= 0) {
      const anchorHit = locateSearchMatchByLocator(sortedPages[pageIndex], pageIndex, hit.locator, hit.locator.queryTerm || localSearchInput)
      pendingSearchTargetRef.current = {
        anchorId: getElementAnchorId(sortedPages[pageIndex], pageIndex, anchorHit.elementIndex),
        active: true,
        hitIndex: boundedIndex,
        token,
      }
      const shouldSyncToc = tocOpen && readerSidebarTab === 'toc'
      const tocKey = shouldSyncToc ? findTocKeyForPageIndex(pageIndex) : ''
      if (tocKey) {
        const previousTocKey = activeTocJumpKeyRef.current
        activeTocJumpKeyRef.current = tocKey
        tocJumpSuppressUntilRef.current = performance.now() + 900
        if (previousTocKey !== tocKey) setActiveTocJumpKey(tocKey)
      }
      if (pageIndex === safeIndex || visiblePageIndices.includes(pageIndex)) scrollToPendingAnchor(0, token)
      else jumpToIndex(pageIndex)
      if (tocKey) {
        window.setTimeout(() => {
          if (!isSearchNavigationCurrent(token)) return
          if (activeTocJumpKeyRef.current === tocKey) {
            activeTocJumpKeyRef.current = ''
            setActiveTocJumpKey('')
          }
        }, 360)
      }
    }
    return pageIndex >= 0
  }

  useLayoutEffect(() => {
    if (!localSearchEdited || !hasSessionNavigation || searchIndexLoading || !effectiveSearchSession?.hits?.length) return
    const targetIndex = effectiveSessionHitIndex >= 0 ? effectiveSessionHitIndex : 0
    const targetHit = effectiveSearchSession.hits[targetIndex]
    const applyKey = `${effectiveSearchSession.query}:${effectiveSearchSession.hits.length}:${targetIndex}:${targetHit?.id || ''}`
    if (appliedIndexedSearchKeyRef.current === applyKey) return
    appliedIndexedSearchKeyRef.current = applyKey
    activateSessionSearchHit(targetIndex, effectiveSearchSession)
  }, [effectiveSearchSession, effectiveSessionHitIndex, hasSessionNavigation, localSearchEdited, searchIndexLoading])

  const clearReaderSearchStateForNotes = () => {
    setLocalSearchEdited(true)
    setLocalSearchInput('')
    setSearchCursor(-1)
    setSessionSearchCursor(-1)
    localSearchCursorRef.current = -1
    sessionSearchCursorRef.current = -1
    setLocalSearchSession(null)
    appliedIndexedSearchKeyRef.current = ''
    setSearchResultPage(1)
    if (incomingSearchSessionKey) setDismissedSearchSessionKey(incomingSearchSessionKey)
    onSearchKeywordChange?.('')
  }

  const resolveReaderNoteAnchor = (note: ReaderNoteItem): { pageIndex: number; elementIndex: number; anchorId: string } | null => {
    const locator = getReaderNoteLocator(note)
    if (!locator) return null
    const pageIndex = findPageIndexForLocatorFast(pageLocatorIndex, locator)
    if (pageIndex < 0 || pageIndex >= sortedPages.length) return null
    const page = sortedPages[pageIndex]
    const elements = getPageElements(page)
    if (!elements.length) return null
    let elementIndex = Number.isFinite(Number(locator.segmentOrdinal))
      ? Number(locator.segmentOrdinal)
      : getElementIndexFromSearchHitSegment(locator.segmentId)
    if (!elements[elementIndex]) {
      const charStart = Number(locator.charStart || 0)
      const byChar = elements.findIndex((element) => charStart >= Number(element.charStart || 0) && charStart <= Number(element.charEnd || 0))
      elementIndex = byChar >= 0 ? byChar : 0
    }
    return {
      pageIndex,
      elementIndex,
      anchorId: getElementAnchorId(page, pageIndex, elementIndex),
    }
  }

  const focusReaderNote = (note: ReaderNoteItem) => {
    const target = resolveReaderNoteAnchor(note)
    if (!target) {
      message.warning('这条摘录缺少可定位的阅读器锚点')
      return false
    }
    clearReaderSearchStateForNotes()
    setReaderHighlightColor(normalizeHighlightColor(note.color))
    setReaderSidebarTab('search')
    setTocOpen(true)
    setPendingTocTarget(null)
    pendingAnchorRef.current = target.anchorId
    pendingSearchTargetRef.current = null
    const tocKey = findTocKeyForPageIndex(target.pageIndex)
    if (tocKey) {
      activeTocJumpKeyRef.current = tocKey
      tocJumpSuppressUntilRef.current = performance.now() + 900
      setActiveTocJumpKey(tocKey)
    }
    if (target.pageIndex === safeIndex || visiblePageIndices.includes(target.pageIndex)) {
      scrollToPendingAnchor(0)
    } else {
      jumpToIndex(target.pageIndex)
    }
    window.setTimeout(refreshReaderPosition, 120)
    window.setTimeout(() => {
      if (activeTocJumpKeyRef.current === tocKey) {
        activeTocJumpKeyRef.current = ''
        setActiveTocJumpKey('')
      }
      refreshReaderPosition()
    }, 520)
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

  useLayoutEffect(() => {
    if (!localSearchInput.trim() || hasSessionNavigation || searchCursor >= 0 || !allSearchMatches.length) return
    const targetIndex = sessionLocalSearchIndex >= 0 ? sessionLocalSearchIndex : 0
    activateReaderSearchHit(allSearchMatches[targetIndex], targetIndex)
  }, [allSearchMatches, hasSessionNavigation, localSearchInput, searchCursor, sessionLocalSearchIndex])

  const jumpToSearchHit = (direction: 1 | -1) => {
    const token = nextSearchNavigationToken()
    if (hasSessionNavigation && effectiveSessionHits.length) {
      const current = sessionSearchCursorRef.current >= 0 ? sessionSearchCursorRef.current : effectiveSessionHitIndex >= 0 ? effectiveSessionHitIndex : direction > 0 ? -1 : 0
      activateSessionSearchHit(current + direction, undefined, token)
      return
    }
    if (allSearchMatches.length) {
      const current = localSearchCursorRef.current >= 0
        ? localSearchCursorRef.current
        : searchCursor >= 0
        ? searchCursor
        : Number.isFinite(Number(activeSearchHit?.globalIndex))
          ? Number(activeSearchHit?.globalIndex)
          : 0
      const next = (current + direction + allSearchMatches.length) % allSearchMatches.length
      const hit = allSearchMatches[next]
      activateReaderSearchHit(hit, next, token)
      return
    }
    if (effectiveSessionHits.length) {
      const current = sessionSearchCursorRef.current >= 0
        ? sessionSearchCursorRef.current
        : sessionSearchCursor >= 0
        ? sessionSearchCursor
        : effectiveSearchSession && effectiveSearchSession.activeHitIndex >= 0
          ? effectiveSearchSession.activeHitIndex
          : 0
      activateSessionSearchHit(current + direction, undefined, token)
      return
    }
    if (searchMatches.length) {
      const current = localSearchCursorRef.current >= 0 ? localSearchCursorRef.current : searchCursor >= 0 ? searchCursor : Math.max(0, activeLocalHitIndex)
      const next = (current + direction + searchMatches.length) % searchMatches.length
      const hit = searchMatches[next]
      activateReaderSearchHit(hit, next, token)
      return
    }
  }

  const jumpToSearchDirectoryItem = (item: SearchDirectoryItem) => {
    if (item.session || (!allSearchMatches.length && effectiveSessionHits.length)) {
      activateSessionSearchHit(item.index)
      return
    }
    const hit = allSearchMatches[item.index]
    if (hit) activateReaderSearchHit(hit, item.index)
  }

  const openReaderNote = (note: ReaderNoteItem) => {
    focusReaderNote(note)
  }

  const resolveReaderCitationText = async (pageNum: number | null): Promise<string> => {
    const fallback = buildReaderCitationText(document.title, pageNum)
    if (!document?.id) return fallback
    try {
      return await resolveDocumentCitation(document.id, { docType: document.doc_type, pageNum }) || fallback
    } catch (error) {
      console.warn('Failed to generate reader citation from active style, falling back to simple citation.', error)
      return fallback
    }
  }

  const saveExcerpt = async (colorOverride?: string) => {
    if (!document?.id || !activePage) return
    const selected = readerSelection?.text || window.getSelection()?.toString()?.trim() || ''
    const excerpt = (selected || activeText).trim().slice(0, 1200)
    if (!excerpt) {
      message.info('当前没有可保存的文本')
      return
    }
    const sourcePageIndex = readerSelection?.pageIndex ?? safeIndex
    const sourcePage = sortedPages[sourcePageIndex] || activePage
    const internalPageNum = Number(sourcePage.page_num || sourcePageIndex + 1)
    const citationPageNum = getReaderCitationPageNum(sourcePage, internalPageNum)
    const citationText = await resolveReaderCitationText(citationPageNum || internalPageNum)
    const highlightText = getExcerptHighlightText(selected || excerpt)
    const fallbackCharStart = readerSelection?.charStart ?? 0
    const charStart = Math.max(0, fallbackCharStart)
    const charEnd = Math.max(charStart + highlightText.length, readerSelection?.charEnd ?? charStart + highlightText.length)
    const locator: SearchHitLocator = {
      docId: document.id,
      segmentId: `${document.id}:source-page-reader-v2:${sourcePage.id || sourcePage.page_num || sourcePageIndex}:${readerSelection?.elementIndex ?? 0}`,
      sourceType: 'source-page-reader-v2',
      pageId: sourcePage.id || null,
      pageNum: internalPageNum,
      pageIndex: sourcePageIndex,
      locationKey: `page:${internalPageNum}`,
      segmentOrdinal: readerSelection?.elementIndex ?? 0,
      charStart,
      charEnd,
      matchText: highlightText,
      queryTerm: highlightText,
      occurrenceIndex: readerSelection?.occurrenceIndex ?? 0,
    }
    const sourceMeta = {
      sourceType: 'reader',
      reader: 'source-page-reader-v2',
      pageNum: locator.pageNum,
      citationPageNum,
      displayPageNum: citationPageNum,
      citation: citationText,
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
        source_id: JSON.stringify(sourceMeta),
      })
      const nextNote: ReaderNoteItem = savedNote
      setReaderNotes((notes) => [nextNote, ...notes.filter((note) => note.id !== nextNote.id)])
      setReaderSelection(null)
      window.getSelection()?.removeAllRanges()
      clearReaderSearchStateForNotes()
      setReaderHighlightColor(noteColor)
      focusReaderNote(nextNote)
      message.success('已标记为摘录')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存摘录失败'))
    }
  }

  const updateReaderSelection = (pageIndex: number, elementIndex: number, event?: SelectionMouseEvent) => {
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
    const page = sortedPages[pageIndex]
    const elements = getPageElements(page)
    const element = elements[elementIndex]
    const elementText = element ? getElementSearchText(element) : getPageText(page)
    const highlightText = getExcerptHighlightText(text)
    const offsets = findSearchOccurrences(elementText, highlightText)
    const container = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
    const occurrenceHint = Math.max(0, getSelectionOccurrenceIndexInContainer(container, range, highlightText))
    const occurrenceIndex = offsets.length > 0 ? Math.max(0, Math.min(offsets.length - 1, occurrenceHint)) : 0
    const localOffset = offsets[occurrenceIndex] ?? Math.max(0, elementText.indexOf(highlightText))
    const charStart = Math.max(0, Number(element?.charStart || 0) + (localOffset >= 0 ? localOffset : 0))
    setReaderSelection({
      text,
      x: rect.left + rect.width / 2,
      y: Math.max(12, rect.top - 42),
      pageIndex,
      elementIndex,
      charStart,
      charEnd: charStart + highlightText.length,
      occurrenceIndex,
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
    const sourcePageIndex = readerSelection?.pageIndex ?? safeIndex
    const sourcePage = sortedPages[sourcePageIndex] || activePage
    const internalPageNum = Number(sourcePage?.page_num || sourcePageIndex + 1)
    const citationPageNum = getReaderCitationPageNum(sourcePage, internalPageNum)
    const citationText = await resolveReaderCitationText(citationPageNum || internalPageNum)
    const quote = buildDirectQuoteCitationText(selected, citationText)
    try {
      await navigator.clipboard.writeText(quote)
      message.success('已复制直接引用')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '复制直接引用失败'))
    }
  }

  const summarizeSelectionText = async (text: string, scope: 'selection' | 'basket' = 'selection') => {
    if (!text.trim()) {
      message.info('请先选择需要摘要的文本')
      return
    }
    const docId = document?.id
    if (!docId) {
      message.warning('当前文献尚未加载完成')
      return
    }
    const summaryPageIndex = readerSelection?.pageIndex ?? safeIndex
    const summaryPage = sortedPages[summaryPageIndex] || activePage
    const internalPageNum = Number(summaryPage?.page_num || summaryPageIndex + 1)
    const citationPageNum = getReaderCitationPageNum(summaryPage, internalPageNum)
    setSummaryModalOpen(true)
    setSummaryLoading(true)
    try {
      const result = await window.api.summarizeSelection({
        text,
        scope,
        title: document?.title || '当前文献',
        source: {
          docId,
          docTitle: document.title,
          pageNum: citationPageNum || internalPageNum,
          locator: {
            docId,
            segmentId: `${docId}:source-summary:${summaryPage?.id || internalPageNum || summaryPageIndex}`,
            sourceType: 'source-page-reader-v2',
            pageId: summaryPage?.id || null,
            pageNum: internalPageNum,
            pageIndex: summaryPageIndex,
            segmentOrdinal: readerSelection?.elementIndex ?? 0,
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
    if (!document?.id || !summaryMarkdown.trim()) return
    const summaryPageIndex = readerSelection?.pageIndex ?? safeIndex
    const summaryPage = sortedPages[summaryPageIndex] || activePage
    const internalPageNum = Number(summaryPage?.page_num || summaryPageIndex + 1)
    const citationPageNum = getReaderCitationPageNum(summaryPage, internalPageNum)
    const citationText = await resolveReaderCitationText(citationPageNum || internalPageNum)
    const sourceMeta = {
      sourceType: 'ai_summary',
      reader: 'source-page-reader-v2',
      citationPageNum,
      displayPageNum: citationPageNum,
      citation: citationText,
      sourcePageNum: internalPageNum,
      internalPageNum,
      pageNum: internalPageNum,
      pageIndex: summaryPageIndex,
      locator: { sourceType: 'source-page-reader-summary', pageNum: internalPageNum, pageIndex: summaryPageIndex },
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
        locator: { sourceType: 'source-page-reader-summary', pageNum: internalPageNum, pageIndex: summaryPageIndex },
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

  const updateToc = async (nextItems: TocItemV2[], source?: TocItemSource) => {
    const docId = document?.id
    if (!docId) {
      message.warning('当前文献尚未加载完成')
      return []
    }
    const saved = normalizeTocItems(await window.api.saveDocumentToc(docId, nextItems, source))
    setToc(saved)
    onDocumentMetadataChange?.({ ...parseMetadata(document), toc_v2_updated_at: new Date().toISOString() })
    return saved
  }

  const handleAiTocOrganize = async () => {
    if (!document?.id || aiTocLoading) return
    setAiTocLoading(true)
    try {
      const nextItems = normalizeTocItems(await window.api.runAiToc(document.id))
      if (!nextItems.length) {
        message.warning('AI 没有整理出可用目录')
        return
      }
      setToc(nextItems)
      setTocDraft(toTocDraftItems(nextItems))
      message.success(`AI 已整理并保存 ${nextItems.length} 条目录`)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, 'AI 整理目录失败'))
    } finally {
      setAiTocLoading(false)
    }
  }

  const handleRuleTocRebuild = async () => {
    if (!document?.id || ruleTocLoading) return
    setRuleTocLoading(true)
    message.loading({
      content: '正在生成目录，长文献可能会短暂卡顿；识别完成后会恢复。',
      key: 'rule-toc-rebuild',
      duration: 0,
    })
    try {
      const nextItems = normalizeTocItems(await window.api.rebuildRuleToc(document.id))
      if (!nextItems.length) {
        message.warning({ content: '生成目录暂时没有识别出可用条目', key: 'rule-toc-rebuild', duration: 4 })
        return
      }
      setToc(nextItems)
      setTocDraft(toTocDraftItems(nextItems))
      onDocumentMetadataChange?.({ ...parseMetadata(document), toc_v2_updated_at: new Date().toISOString() })
      message.success({ content: `生成目录已更新，共 ${nextItems.length} 条`, key: 'rule-toc-rebuild', duration: 4 })
    } catch (error: unknown) {
      console.error(error)
      message.error({ content: getErrorMessage(error, '生成目录更新失败'), key: 'rule-toc-rebuild', duration: 5 })
    } finally {
      setRuleTocLoading(false)
    }
  }

  const bindTocItemToCurrentPage = async (item: TocItemV2) => {
    if (!document?.id || !activePage) return
    const selectedTitle = normalizeTitle(window.getSelection()?.toString() || '')
    const pageNum = Number(activePage.page_num || safeIndex + 1)
    const anchorText = selectedTitle || item.anchor_text || item.title
    const charIndex = anchorText ? Math.max(0, activeText.indexOf(anchorText)) : 0
    const itemKey = getTocItemKey(item)
    const nextItems = toc.map((target) => getTocItemKey(target) === itemKey ? {
      ...target,
      ...(selectedTitle ? { title: selectedTitle.slice(0, 80) } : {}),
      href: `page:${pageNum}`,
      anchor_text: anchorText,
      anchor_context: activeText.slice(Math.max(0, charIndex - 80), charIndex + 180),
      anchor_key: `page:${pageNum}:char:${charIndex}`,
      source_page_num: pageNum,
      source: 'manual' as TocItemSource,
      status: 'active' as const,
      confidence: 1,
    } : target)
    setTocSaving(true)
    try {
      const saved = await updateToc(nextItems)
      setTocDraft(toTocDraftItems(saved))
      message.success(selectedTitle ? '已把该目录绑定到选中文字' : '已把该目录绑定到当前页')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '绑定目录失败'))
    } finally {
      setTocSaving(false)
    }
  }

  const bindDraftItemToCurrentPage = (draftKey: string) => {
    if (!activePage) return
    const selectedTitle = normalizeTitle(window.getSelection()?.toString() || '')
    const pageNum = Number(activePage.page_num || safeIndex + 1)
    const charIndex = selectedTitle ? Math.max(0, activeText.indexOf(selectedTitle)) : 0
    setTocDraft((items) => items.map((item) => item.draftKey === draftKey ? {
      ...item,
      ...(selectedTitle ? { title: selectedTitle.slice(0, 80) } : {}),
      href: `page:${pageNum}`,
      anchor_text: selectedTitle || null,
      anchor_context: activeText.slice(0, 180),
      anchor_key: `page:${pageNum}:char:${charIndex}`,
      source_page_num: pageNum,
      source: 'manual',
      status: 'active',
      confidence: 1,
    } : item))
    message.success(selectedTitle ? '已绑定到选中文字所在页' : '已绑定到当前页')
  }

  const addCurrentPageToToc = () => {
    if (!activePage) return
    const selectedTitle = normalizeTitle(window.getSelection()?.toString() || '').slice(0, 80)
    const insertAt = tocDraft.findIndex((item) => getTocItemKey(item) === activeTocKey) + 1 || tocDraft.length
    const nextItem = { ...createPageTocItem(activePage, safeIndex, insertAt, selectedTitle), draftKey: `draft-${Date.now().toString(36)}` }
    setTocDraft((items) => {
      const nextItems = [...items]
      nextItems.splice(insertAt, 0, nextItem)
      return nextItems.map((item, index) => ({ ...item, order: index }))
    })
    message.success(selectedTitle ? `已添加“${selectedTitle}”` : '已把当前页加入目录草稿')
  }

  const saveManualToc = async () => {
    if (!document?.id || tocSaving) return
    const nextItems = normalizeManualTocForSave(tocDraft)
    if (!nextItems.length) {
      message.warning('目录至少需要保留一条有效标题')
      return
    }
    setTocSaving(true)
    try {
      const saved = await updateToc(nextItems)
      setTocDraft(toTocDraftItems(saved))
      setTocEditMode(false)
      message.success(`目录已保存，共 ${saved.length} 条`)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存目录失败'))
    } finally {
      setTocSaving(false)
    }
  }

  const tocStyle = theme === 'dark'
    ? { background: '#1b1d20', text: '#f0dfc6', muted: '#b7a182', activeBg: 'rgb(184, 134, 83)', activeText: 'rgb(255, 213, 145)', border: 'rgba(235,190,120,0.3)', marker: '#ffd591', shadow: '0 16px 32px rgba(0,0,0,0.35)' }
    : { background: '#efe3ce', text: '#3e2b18', muted: '#7d6648', activeBg: 'rgb(184, 134, 83)', activeText: 'rgb(255, 213, 145)', border: 'rgba(112,75,35,0.22)', marker: '#6b4218', shadow: '0 16px 32px rgba(48,30,12,0.18)' }
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

  const renderSearchDirectory = () => {
    if (!localSearchInput.trim()) {
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
                  border: `1px solid ${tocStyle.border}`,
                  background: theme === 'dark' ? 'rgba(214,168,95,0.10)' : 'rgba(72,45,18,0.10)',
                  color: tocStyle.text,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 12, fontWeight: 700 }}>
                    <span className="reader-note-color-dot" style={{ background: noteColor }} />
                    <span>{pageLabel}</span>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }}>
                    {createdAt ? <span style={{ color: tocStyle.muted, fontSize: 11 }}>{createdAt}</span> : null}
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
                <div style={{ color: tocStyle.text, fontSize: 12, lineHeight: 1.6 }}>
                  {transformReaderDisplayText(String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180), displayScript)}
                </div>
              </div>
            )
          })}
        </div>
      )
    }
    if (!searchDirectoryItemCount) {
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
          border: `1px solid ${tocStyle.border}`,
          background: theme === 'dark' ? '#14110e' : '#dcc8aa',
        }}
      >
        <Space direction="vertical" size={6} style={{ width: '100%', flex: 1 }}>
          {visibleSearchDirectoryItems.map((item) => (
            <button
              key={item.key}
              type="button"
              data-reader-search-result-item="true"
              data-reader-search-result-active={item.active ? 'true' : undefined}
              onClick={() => jumpToSearchDirectoryItem(item)}
              style={{
                width: '100%',
                border: `1px solid ${item.active ? 'rgba(255,216,168,0.38)' : tocStyle.border}`,
                borderRadius: 6,
                padding: '8px 9px',
                textAlign: 'left',
                cursor: 'pointer',
                background: item.active ? tocStyle.activeBg : theme === 'dark' ? 'rgba(214,168,95,0.10)' : 'rgba(72,45,18,0.10)',
                color: item.active ? tocStyle.activeText : tocStyle.text,
                fontSize: 12,
                lineHeight: 1.55,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700 }}>#{item.index + 1}</span>
                <span style={{ color: item.active ? 'rgba(255,245,220,0.82)' : tocStyle.muted }}>{item.pageLabel}</span>
              </div>
              <span>{renderMarkedSnippet(item.snippet, localSearchInput, displayScript)}</span>
            </button>
          ))}
        </Space>
        {searchDirectoryItemCount > READER_SEARCH_RESULT_PAGE_SIZE ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 6,
              border: `1px solid ${tocStyle.border}`,
              background: theme === 'dark' ? 'rgba(10,7,4,0.56)' : 'rgba(72,45,18,0.30)',
            }}
          >
            <Pagination
              className="gs-hit-pagination"
              size="small"
              simple
              current={searchResultPageSafe}
              pageSize={READER_SEARCH_RESULT_PAGE_SIZE}
              total={searchDirectoryItemCount}
              showSizeChanger={false}
              onChange={(page) => setSearchResultPage(page)}
            />
          </div>
        ) : null}
      </div>
    )
  }

  const renderToc = () => (
    <aside style={{ width: 282, flex: '0 0 282px', border: `1px solid ${tocStyle.border}`, borderRadius: 8, background: tocStyle.background, boxShadow: tocStyle.shadow, display: 'flex', flexDirection: 'column', overflow: 'hidden', margin: 12, marginRight: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${tocStyle.border}` }}>
        <Segmented
          size="small"
          block
          value={readerSidebarTab}
          onChange={(value) => setReaderSidebarTab(value as ReaderSidebarTab)}
          options={[
            { value: 'toc', label: '目录' },
            {
              value: 'search',
              label: localSearchInput.trim()
                ? `检索结果${searchDirectoryItemCount ? ` ${searchDirectoryItemCount}` : ''}`
                : `摘录${readerNotes.length ? ` ${readerNotes.length}` : ''}`,
            },
          ]}
        />
      </div>
      {readerSidebarTab === 'search' ? (
        <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
          {renderSearchDirectory()}
        </div>
      ) : (
        <>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${tocStyle.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Text strong style={{ color: tocStyle.text }}>目录</Text>
        {tocEditMode ? (
          <Space size={4}>
            <Button size="small" onClick={() => { setTocDraft(toTocDraftItems(toc)); setTocEditMode(false) }}>取消</Button>
            <Button size="small" type="primary" loading={tocSaving} onClick={() => void saveManualToc()}>保存</Button>
          </Space>
        ) : (
          <Space size={4}>
            <Button size="small" icon={<ReloadOutlined />} loading={ruleTocLoading} onClick={() => void handleRuleTocRebuild()}>生成目录</Button>
            <Button size="small" icon={<RobotOutlined />} loading={aiTocLoading} onClick={() => void handleAiTocOrganize()}>AI</Button>
            <Button size="small" icon={<EditOutlined />} onClick={() => setTocEditMode(true)}>编辑</Button>
          </Space>
        )}
      </div>
      {tocEditMode ? (
        <div style={{ padding: 10, borderBottom: `1px solid ${tocStyle.border}` }}>
          <Button size="small" block icon={<PlusOutlined />} onClick={addCurrentPageToToc}>添加当前页</Button>
        </div>
      ) : null}
      {!tocEditMode && tocResolveState.total > 0 && (tocResolveState.running || tocResolveState.unresolved > 0) ? (
        <div style={{ margin: '8px 10px 0', padding: '7px 9px', borderRadius: 6, background: theme === 'dark' ? 'rgba(214,168,95,0.12)' : 'rgba(112,75,35,0.1)', color: tocStyle.muted, fontSize: 12, lineHeight: 1.5 }}>
          {tocResolveState.running
            ? `正在精准匹配目录锚点 ${tocResolveState.resolved}/${tocResolveState.total}`
            : `还有 ${tocResolveState.unresolved} 条目录未能精确定位`}
        </div>
      ) : null}
      {!tocEditMode && hiddenUnresolvedTocCount > 0 ? (
        <div style={{ margin: '8px 10px 0', padding: '7px 9px', borderRadius: 6, background: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(112,75,35,0.08)', color: tocStyle.muted, fontSize: 12, lineHeight: 1.5 }}>
          已隐藏 {hiddenUnresolvedTocCount} 条未能精确定位的目录
        </div>
      ) : null}
      <div ref={tocScrollRef} style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {tocEditMode ? (
          tocDraft.length ? tocDraft.map((item) => (
            <div key={item.draftKey} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 4, alignItems: 'center', marginBottom: 6, paddingLeft: Math.max(0, Number(item.level || 1) - 1) * 12 }}>
              <Input size="small" value={item.title} onChange={(event) => setTocDraft((items) => items.map((target) => target.draftKey === item.draftKey ? { ...target, title: event.target.value } : target))} />
              <Button size="small" icon={<LinkOutlined />} onClick={() => bindDraftItemToCurrentPage(item.draftKey)} />
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setTocDraft((items) => items.filter((target) => target.draftKey !== item.draftKey))} />
            </div>
          )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无目录草稿" />
        ) : tocLoading ? (
          <div style={{ padding: '24px 8px', color: tocStyle.muted, fontSize: 13, lineHeight: 1.7 }}>
            正在读取已保存目录...
          </div>
        ) : visibleToc.length ? visibleToc.map((item) => {
          const pageIndex = tocPageIndexMap.get(getTocItemKey(item)) ?? -1
          const bound = pageIndex >= 0
          const active = getTocItemKey(item) === activeTocKey
          const qualityLabel = getTocQualityLabel(item, bound)
          const sourceLabel = getTocSourceLabel(item.source)
          const displayTitle = transformReaderDisplayText(item.title, displayScript)
          return (
            <div key={getTocItemKey(item)} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, alignItems: 'stretch', marginBottom: 4 }}>
              <button
                type="button"
                title={`${displayTitle} · ${sourceLabel} · ${qualityLabel}${item.source_page_num ? ` · 第 ${item.source_page_num} 页` : ''}`}
                disabled={!bound}
                data-reader-toc-active={active ? 'true' : undefined}
                onClick={() => {
                  if (!bound) return
                  jumpToTocItem(item, pageIndex)
                }}
                style={{ width: '100%', minWidth: 0, border: `1px solid ${active ? 'rgba(255,245,220,0.36)' : 'transparent'}`, borderRadius: 6, padding: '6px 8px', paddingLeft: 10 + Math.max(0, Number(item.level || 1) - 1) * 14, textAlign: 'left', cursor: bound ? 'pointer' : 'not-allowed', background: active ? tocStyle.activeBg : 'transparent', color: active ? tocStyle.activeText : bound ? tocStyle.text : tocStyle.muted, opacity: bound ? 1 : 0.58, fontWeight: active ? 700 : bound ? 500 : 400, position: 'relative', overflow: 'hidden' }}
              >
                {active ? <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 5, bottom: 5, width: 3, borderRadius: 3, background: tocStyle.marker }} /> : null}
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle}</span>
                <span style={{ display: 'block', marginTop: 2, fontSize: 11, fontWeight: 400, color: active ? 'rgba(255,245,220,0.82)' : tocStyle.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sourceLabel} · {qualityLabel}{item.source_page_num ? ` · 第${item.source_page_num}页` : ''}
                </span>
              </button>
              {!bound ? (
                <Button
                  size="small"
                  icon={<PushpinOutlined />}
                  loading={tocSaving}
                  title="绑定到当前页或选中文字"
                  onClick={() => void bindTocItemToCurrentPage(item)}
                  style={{ alignSelf: 'center' }}
                />
              ) : null}
            </div>
          )
        }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可靠目录" />}
      </div>
      </>
      )}
    </aside>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
      {readerSelection ? (
        <div className="reader-selection-toolbar" style={{ left: readerSelection.x, top: readerSelection.y }}>
          <div className="reader-highlight-palette" aria-label="摘录高亮颜色">
            {HIGHLIGHT_COLOR_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="reader-highlight-swatch"
                title={option.label}
                aria-label={option.label}
                style={{ background: option.value }}
                onClick={() => void saveExcerpt(option.value)}
              />
            ))}
          </div>
          <Button
            className="reader-selection-icon-button"
            size="small"
            icon={<RobotOutlined />}
            title="AI 摘要选中内容"
            loading={summaryLoading}
            onClick={() => void summarizeSelectionText(readerSelection.text, 'selection')}
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
            {isEbook ? `阅读页 ${safeIndex + 1} / ${pageCount}` : `第 ${activePage?.page_num || safeIndex + 1} / ${pageCount} 页`}
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
          <Button size="small" icon={<LeftOutlined />} data-reader-page-prev="true" disabled={safeIndex <= 0} onClick={() => jumpToIndex(safeIndex - pageStep)} />
          <Input ref={pageInputRef} size="small" defaultValue={String(activePage?.page_num || safeIndex + 1)} key={activePage?.page_num || safeIndex} onPressEnter={commitPageInput} onBlur={commitPageInput} style={{ width: 72, textAlign: 'center' }} />
          <Button size="small" icon={<RightOutlined />} data-reader-page-next="true" disabled={safeIndex >= pageCount - 1} onClick={() => jumpToIndex(safeIndex + pageStep)} />
        </Space>
        <Space size={4} wrap>
          <Switch
            size="small"
            checked={aiLayoutEnabled}
            onChange={(checked) => {
              setAiLayoutEnabled(checked)
              if (checked) setAiLayoutErrors({})
            }}
          />
          <span style={{ color: aiLayoutEnabled ? '#d6a85f' : 'var(--gs-text-secondary)', fontSize: 12 }}>AI 排版</span>
          {aiLayoutEnabled ? (
            <span style={{
              color: visibleAiErrorCount ? '#ffccc7' : visibleAiLoadingCount ? '#ffd591' : visibleAiReadyCount ? '#b7eb8f' : 'var(--gs-text-secondary)',
              background: visibleAiErrorCount ? 'rgba(190,62,48,0.18)' : visibleAiLoadingCount ? 'rgba(214,168,95,0.18)' : visibleAiReadyCount ? 'rgba(80,150,80,0.16)' : 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 999,
              padding: '2px 8px',
              fontSize: 12,
              fontWeight: 700,
            }}>
              {visibleAiErrorCount ? `失败 ${visibleAiErrorCount}` : visibleAiLoadingCount ? `排版中 ${visibleAiLoadingCount}` : visibleAiReadyCount ? `已应用 ${visibleAiReadyCount}` : '等待排版'}
            </span>
          ) : null}
          <Switch
            data-reader-translation-toggle="true"
            size="small"
            checked={translationOpen}
            disabled={!translationPageId || !translationSourceText}
            loading={activeTranslationLoading}
            onChange={(checked) => {
              setTranslationOpen(checked)
              if (checked && translationPageId && translationPage && translationSourceText) {
                onTranslateCurrentPage?.(
                  {
                    pageId: translationPageId,
                    readerPageKey: translationPageId,
                    cachePageId: getTranslationCachePageId(translationPage),
                    pageNum: Number(translationPage.page_num || translationPageIndex + 1),
                    text: translationSourceText,
                  },
                  { priority: 'current' },
                )
              }
            }}
          />
          <span style={{ color: translationOpen ? '#d6a85f' : 'var(--gs-text-secondary)', fontSize: 12 }}>翻译模式</span>
          {translationOpen ? (
            <>
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
            </>
          ) : null}
          <Input
            data-reader-search-input="true"
            size="small"
            prefix={<SearchOutlined />}
            allowClear
            value={localSearchInput}
            onChange={(event) => {
              const nextKeyword = event.target.value
              const trimmed = nextKeyword.trim()
              emittedLocalSearchKeywordRef.current = nextKeyword
              localSearchEditedRef.current = true
              setLocalSearchEdited(true)
              setLocalSearchInput(nextKeyword)
              localSearchCursorRef.current = -1
              sessionSearchCursorRef.current = -1
              setSearchCursor(-1)
              setSessionSearchCursor(-1)
              setLocalSearchSession(trimmed ? { query: trimmed, hits: [], activeHitIndex: -1, status: 'searching' } : null)
              setReaderHighlightColor('')
              onSearchKeywordChange?.(nextKeyword)
            }}
            placeholder="页内检索"
            style={{ width: 170 }}
          />
          <Button size="small" title="上一处页内命中" icon={<LeftOutlined />} disabled={!canNavigateSearchHits} onClick={() => jumpToSearchHit(-1)} />
          <Text data-reader-search-counter="true" style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>{searchCounterText}</Text>
          <Button size="small" title="下一处页内命中" icon={<RightOutlined />} data-reader-search-next="true" disabled={!canNavigateSearchHits} onClick={() => jumpToSearchHit(1)} />
          <Popover trigger="click" placement="bottomRight" content={displaySettingsPanel}>
            <Button size="small" icon={<SettingOutlined />}>显示设置</Button>
          </Popover>
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
        {tocOpen ? renderToc() : null}
        <div style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden', background: style.shell }}>
          {tocBusy ? (
            <div className="reader-toc-busy-overlay">
              <Spin size="small" />
              <div>
                <div className="reader-toc-busy-title">{tocBusyTitle}</div>
                <div className="reader-toc-busy-hint">{tocBusyHint}</div>
              </div>
            </div>
          ) : null}
          {visiblePages.length ? (
            <div
              ref={readerScrollRef}
              data-reader-scroll="true"
              data-reader-current-leaf={safeIndex}
              data-reader-active-section={activeTocKey}
              data-reader-column-index={0}
              data-reader-column-count={translationOpen ? 2 : visiblePageIndices.length}
              data-search-navigation-epoch={Math.max(0, visibleSearchHitIndex)}
              onClick={handleReaderNoteClick}
              style={{ width: '100%', height: '100%', overflow: 'auto' }}
            >
              {translationOpen ? (
                <ParallelTranslationView
                  title={translationPageTitle}
                  pageLabel={translationPageLabel}
                  sourceText={translationSourceText}
                  translationText={activeTranslationText}
                  loading={activeTranslationLoading}
                  skipped={activeTranslationSkipped}
                  themeName={theme}
                  themeStyle={style}
                  fontSize={fontSize}
                  lineHeight={lineHeight}
                  pageMetrics={readerPageMetrics}
                  adaptivePages={isEbook}
                  activeSegmentId={activeParallelSegmentId}
                  onActiveSegmentChange={setActiveParallelSegmentId}
                  onSelectedTextChange={onSelectedTextChange}
                  onClose={() => setTranslationOpen(false)}
                />
              ) : (
                <SourcePageSpread rowPages={visiblePages} pageIndices={visiblePageIndices} pageCount={pageCount} pageMetrics={readerPageMetrics} adaptivePages={isEbook} fontSize={fontSize} lineHeight={lineHeight} theme={theme} searchKeyword={renderedSearchKeyword} activeSearchHit={renderedActiveSearchHit} searchMatches={searchMatches} pendingTocTarget={pendingTocTarget} aiLayoutEnabled={aiLayoutEnabled} aiLayoutByPageId={aiLayoutByPageId} aiLayoutLoading={aiLayoutLoading} aiLayoutErrors={aiLayoutErrors} highlightColor={effectiveHighlightColor} noteHighlightsByElement={readerNoteHighlightsByElement} onSelectedTextChange={onSelectedTextChange} onReaderSelection={updateReaderSelection} displayScript={displayScript} searchActiveOnly={false} />
              )}
            </div>
          ) : (
            <Empty image={<FileTextOutlined style={{ fontSize: 48, opacity: 0.2 }} />} description="未找到可阅读内容" style={{ marginTop: '20%' }} />
          )}
          {visiblePages.length && pageCount > 1 ? (
            <>
              <Button aria-label="上一页" icon={<LeftOutlined />} disabled={safeIndex <= 0} onClick={() => jumpToIndex(safeIndex - pageStep)} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', zIndex: 8, width: 38, height: 54, borderRadius: 10, borderColor: style.border, color: style.text, background: theme === 'dark' ? 'rgba(15,16,18,0.72)' : 'rgba(255,250,240,0.78)', boxShadow: '0 10px 26px rgba(0,0,0,0.24)' }} />
              <Button aria-label="下一页" icon={<RightOutlined />} disabled={safeIndex >= pageCount - 1} onClick={() => jumpToIndex(safeIndex + pageStep)} style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', zIndex: 8, width: 38, height: 54, borderRadius: 10, borderColor: style.border, color: style.text, background: theme === 'dark' ? 'rgba(15,16,18,0.72)' : 'rgba(255,250,240,0.78)', boxShadow: '0 10px 26px rgba(0,0,0,0.24)' }} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

