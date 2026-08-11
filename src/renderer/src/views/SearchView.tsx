import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Card, Collapse, Empty, Input, InputNumber, List, Modal, Pagination, Progress, Radio, Select, Space, Spin, Switch, Tag, Tooltip, Typography, message, type InputRef } from 'antd'
import { BulbOutlined, DeleteOutlined, DownOutlined, FileTextOutlined, RightOutlined, RobotOutlined, SaveOutlined, SearchOutlined, StarOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useSearchStore, type SearchFilters } from '../stores/useSearchStore'
import { hasShortcutBlockingOverlay, isEditableShortcutTarget, loadShortcutSettings, SHORTCUTS_CHANGED_EVENT, shortcutMatches, type ShortcutMap } from '../utils/shortcuts'
import { getErrorMessage } from '@shared/errors'
import { buildSearchExcerptSourceHashInput } from '@shared/search-evidence'
import { stableLocatorFromLegacySearchLocator } from '@shared/stable-reader-locator'
import { resolveDocumentCitation } from '../utils/citations'
import {
  VECTOR_SEARCH_DEFAULT_LIMIT,
  VECTOR_SEARCH_MAX_LIMIT,
  normalizeVectorSearchLimit,
} from '@shared/vector-search'
import type {
  CitationStyle,
  CitationTemplate,
  BackgroundTaskProgressEvent,
  DocumentListItem,
  Folder,
  LibraryAiOpenPayload,
  OpenDocumentTarget,
  SavedSearch,
  SearchDocumentGroup,
  SearchDocumentHitPage,
  ExportPageNumberMode,
  SearchExportFormat,
  SearchExportPreviewResult,
  SearchExportCount,
  SearchGroupedResponse,
  SearchHit,
  SearchHitLocator,
  SearchOptions,
  SearchResult as FlatSearchResult,
  SearchSessionState,
  Tag as SharedTag,
  VectorSearchHit,
} from '@shared/types'
import { DEFAULT_SEARCH_EXPORT_COUNT } from '@shared/search-export'

const { Text, Title } = Typography

type SearchMode = 'fulltext' | 'ai' | 'vector'
type SearchSort = NonNullable<SearchOptions['sort']>
type ContextMode = NonNullable<SearchOptions['contextMode']>
type ExportFormat = SearchExportFormat

const SEARCH_SORT_VALUES: SearchSort[] = ['relevance', 'hitCount', 'updated', 'lastOpened', 'title']
const CONTEXT_MODE_VALUES: ContextMode[] = ['short', 'standard', 'long']

interface SearchViewProps {
  onSelectDoc?: (target: OpenDocumentTarget) => void
  initialKeyword?: string
  onOpenLibraryAi?: (payload?: LibraryAiOpenPayload) => void
}

type FilterDocumentItem = Pick<DocumentListItem, 'id' | 'title' | 'author' | 'doc_type'>
type FilterTagItem = Pick<SharedTag, 'id' | 'name' | 'color'>
type FilterFolderItem = Pick<Folder, 'id' | 'name'>

interface AiSearchState {
  plan?: {
    intent?: string
    keywords?: string[]
    expandedKeywords?: string[]
    inferredFilters?: Record<string, unknown>
  }
  expandedQueries?: string[]
  effectiveFilters?: SearchOptions
  warnings?: string[]
}

interface SearchHistoryEntry {
  id: string
  keyword: string
  mode: SearchMode
  filters: SearchFilters
  results: FlatSearchResult[]
  totalHits?: number
  totalDocuments?: number
  aiSearchState: AiSearchState | null
  groupedResponse?: SearchGroupedResponse | null
  vectorLimit?: number
  historyTruncated?: boolean
  createdAt: string
}

interface SearchDocumentHitPageState {
  page: number
  loading: boolean
  payload?: SearchDocumentHitPage
  error?: string
}

interface PendingSearchScrollRestore {
  scrollTop: number
  anchorDocId?: string
  anchorTop?: number
}

const SEARCH_HISTORY_STORAGE_KEY = 'gujismart.search.history.v1'
const SEARCH_RETURN_STATE_STORAGE_KEY = 'gujismart.search.return-state.v1'
/** Remember last vector-export min similarity (0 = no filter). */
const VECTOR_EXPORT_MIN_SCORE_STORAGE_KEY = 'gujismart.search.export.minVectorScore.v1'
/** Remember last export max record count. */
const EXPORT_MAX_RECORDS_STORAGE_KEY = 'gujismart.search.export.maxRecords.v1'
/** Remember the vector Top-K selection shown before search. */
const VECTOR_SEARCH_LIMIT_STORAGE_KEY = 'gujismart.search.vector.limit.v1'
const DEFAULT_SEARCH_GROUP_LIMIT = 120
/** Keep historical cache payloads at the old maximum; larger searches rerun when restored. */
const VECTOR_SEARCH_HISTORY_HIT_LIMIT = 200
const DEFAULT_EXPORT_MAX_RECORDS = DEFAULT_SEARCH_EXPORT_COUNT
const SEARCH_PAGE_SIZE = 10
const SEARCH_DOCUMENT_HIT_PAGE_SIZE = 10
const SEARCH_VIEWER_COUNT_CONCURRENCY = 4
const SEARCH_FILTER_POPUP_WIDTH = 460
const SEARCH_HIGHLIGHT_STYLE = {
  backgroundColor: '#ffd54f',
  color: '#1f1608',
  padding: '0 3px',
  borderRadius: 2,
  fontWeight: 700,
}

interface SearchReturnState {
  searchSignature: string
  expandedHitDocId: string
  documentHitPages: Record<string, SearchDocumentHitPageState>
  scrollTop: number
  savedAt: string
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

function renderSelectEllipsisLabel(label: string): ReactNode {
  return <span className="gs-select-option-ellipsis" title={label}>{label}</span>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSearchSort(value: unknown): value is SearchSort {
  return SEARCH_SORT_VALUES.includes(value as SearchSort)
}

function isContextMode(value: unknown): value is ContextMode {
  return CONTEXT_MODE_VALUES.includes(value as ContextMode)
}

function compactFilterOptions(filters: SearchOptions | SearchFilters | Record<string, unknown> | null | undefined): SearchOptions {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(filters || {})) {
    if (Array.isArray(value)) {
      if (value.length > 0) next[key] = value
      continue
    }
    if (value !== undefined && value !== null && value !== '') next[key] = value
  }
  return next as SearchOptions
}

function compactSearchFilters(filters: SearchOptions | SearchFilters | Record<string, unknown> | null | undefined): SearchFilters {
  const compacted = compactFilterOptions(filters) as Record<string, unknown>
  delete compacted.limit
  return compacted as SearchFilters
}

function loadSearchHistory(): SearchHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveSearchHistory(entries: SearchHistoryEntry[]) {
  window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, 30)))
}

function normalizeExportMinVectorScore(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(1, Math.max(0, Math.round(raw * 1000) / 1000))
}

function loadExportMinVectorScore(): number {
  try {
    const raw = window.localStorage.getItem(VECTOR_EXPORT_MIN_SCORE_STORAGE_KEY)
    if (raw == null || raw === '') return 0
    return normalizeExportMinVectorScore(raw)
  } catch {
    return 0
  }
}

function saveExportMinVectorScore(value: number) {
  try {
    window.localStorage.setItem(
      VECTOR_EXPORT_MIN_SCORE_STORAGE_KEY,
      String(normalizeExportMinVectorScore(value)),
    )
  } catch {
    // ignore quota / private mode
  }
}

function normalizeExportMaxRecords(value: unknown): SearchExportCount {
  if (value === 'all') return 'all'
  const raw = Math.round(Number(value))
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_EXPORT_MAX_RECORDS
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, raw))
}

function loadExportMaxRecords(): SearchExportCount {
  try {
    const raw = window.localStorage.getItem(EXPORT_MAX_RECORDS_STORAGE_KEY)
    if (raw == null || raw === '') return DEFAULT_EXPORT_MAX_RECORDS
    return normalizeExportMaxRecords(raw)
  } catch {
    return DEFAULT_EXPORT_MAX_RECORDS
  }
}

function saveExportMaxRecords(value: SearchExportCount) {
  try {
    window.localStorage.setItem(
      EXPORT_MAX_RECORDS_STORAGE_KEY,
      String(normalizeExportMaxRecords(value)),
    )
  } catch {
    // ignore
  }
}

function formatSearchExportProgressCounter(event: BackgroundTaskProgressEvent): string {
  const completed = Number(event.completedCount)
  const total = Number(event.totalCount)
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return ''
  return `已处理 ${Math.max(0, completed).toLocaleString()} / ${Math.max(0, total).toLocaleString()} 条原始命中`
}

function loadVectorSearchLimit(): number {
  try {
    return normalizeVectorSearchLimit(
      window.localStorage.getItem(VECTOR_SEARCH_LIMIT_STORAGE_KEY),
      VECTOR_SEARCH_DEFAULT_LIMIT,
    )
  } catch {
    return VECTOR_SEARCH_DEFAULT_LIMIT
  }
}

function saveVectorSearchLimit(value: number): void {
  try {
    window.localStorage.setItem(
      VECTOR_SEARCH_LIMIT_STORAGE_KEY,
      String(normalizeVectorSearchLimit(value, VECTOR_SEARCH_DEFAULT_LIMIT)),
    )
  } catch {
    // ignore quota / private mode
  }
}

/** Keep only top-N hits (by score) that pass minScore — shrinks IPC and export work. */
function trimGroupsForExport(
  groups: SearchDocumentGroup[],
  maxRecords: SearchExportCount,
  minScore: number,
): SearchDocumentGroup[] {
  const flat: Array<{ group: SearchDocumentGroup; hit: SearchHit }> = []
  groups.forEach((group) => {
    ;(group.hits || []).forEach((hit) => flat.push({ group, hit }))
  })
  flat.sort((a, b) => (Number(b.hit.score) || 0) - (Number(a.hit.score) || 0))
  const filtered = flat.filter(({ hit }) => {
    if (minScore <= 0) return true
    const score = Number(hit.score)
    return Number.isFinite(score) && score >= minScore
  })
  const kept = maxRecords === 'all' ? filtered : filtered.slice(0, Math.max(1, maxRecords))

  const byDoc = new Map<string, SearchDocumentGroup>()
  for (const { group, hit } of kept) {
    const existing = byDoc.get(group.docId)
    if (existing) {
      existing.hits.push(hit)
      existing.totalHits = existing.hits.length
      existing.score = Math.max(existing.score, Number(hit.score) || 0)
      existing.topHits = existing.hits.slice(0, 3)
      continue
    }
    byDoc.set(group.docId, {
      ...group,
      hits: [hit],
      topHits: [hit],
      totalHits: 1,
      score: Number(hit.score) || group.score || 0,
    })
  }
  return [...byDoc.values()].sort((a, b) => b.score - a.score)
}

function compactVectorGroupedResponseForHistory(response: SearchGroupedResponse): SearchGroupedResponse {
  return {
    ...response,
    groups: trimGroupsForExport(response.groups || [], VECTOR_SEARCH_HISTORY_HIT_LIMIT, 0),
  }
}

function loadSearchReturnState(): SearchReturnState | null {
  try {
    const raw = window.sessionStorage.getItem(SEARCH_RETURN_STATE_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const searchSignature = typeof parsed.searchSignature === 'string' ? parsed.searchSignature : ''
    if (!searchSignature) return null
    const expandedHitDocId = typeof parsed.expandedHitDocId === 'string' ? parsed.expandedHitDocId : ''
    const scrollTop = Number(parsed.scrollTop || 0)
    const documentHitPages = isRecord(parsed.documentHitPages)
      ? Object.fromEntries(Object.entries(parsed.documentHitPages).map(([docId, value]) => {
        const state = isRecord(value) ? value : {}
        const payload = isRecord(state.payload) ? state.payload as unknown as SearchDocumentHitPage : undefined
        return [docId, {
          page: Math.max(1, Number(state.page || payload?.page || 1)),
          loading: false,
          payload,
          error: typeof state.error === 'string' ? state.error : undefined,
        }]
      }))
      : {}
    return {
      searchSignature,
      expandedHitDocId,
      documentHitPages,
      scrollTop: Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    }
  } catch {
    return null
  }
}

function clearSearchReturnState(): void {
  window.sessionStorage.removeItem(SEARCH_RETURN_STATE_STORAGE_KEY)
}

function saveSearchReturnState(state: SearchReturnState): void {
  window.sessionStorage.setItem(SEARCH_RETURN_STATE_STORAGE_KEY, JSON.stringify(state))
}

function normalizeSnippetInlineToken(value: string): string {
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

function normalizeSearchSnippet(value: string): string {
  const openToken = 'GUJISMARTSEARCHMARKOPEN'
  const closeToken = 'GUJISMARTSEARCHMARKCLOSE'
  return String(value || '')
    .replace(/<</g, openToken)
    .replace(/>>/g, closeToken)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\$\s*\^\s*\{([^}]*)\}\s*\$/g, (_match, text) => normalizeSnippetInlineToken(text))
    .replace(/\$\s*\^\s*([^\s$]+)\s*\$/g, (_match, text) => normalizeSnippetInlineToken(text))
    .replace(/\$\s*_\s*\{([^}]*)\}\s*\$/g, (_match, text) => normalizeSnippetInlineToken(text))
    .replace(/\$\s*_\s*([^\s$]+)\s*\$/g, (_match, text) => normalizeSnippetInlineToken(text))
    .replace(/\^\{([^}]*)\}/g, (_match, text) => normalizeSnippetInlineToken(text))
    .replace(/(?<![a-zA-Z])\^(\d+)/g, '$1')
    .replace(/_\{([^}]*)\}/g, (_match, text) => normalizeSnippetInlineToken(text))
    .replace(/\$(\\(?:dagger|ddagger|ast|star|S|P|cdot|times|alpha|beta|gamma|delta))\$/g, (_match, text) => normalizeSnippetInlineToken(text))
    .split(openToken).join('<<')
    .split(closeToken).join('>>')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripSnippetMarkers(value: string): string {
  return normalizeSearchSnippet(value).replace(/<</g, '').replace(/>>/g, '')
}

function getKeywordCandidates(keyword: string): string[] {
  const trimmed = keyword.trim()
  if (!trimmed) return []
  const tokens = trimmed
    .split(/[\s,，。；;、/\\()[\]{}"'“”‘’<>《》]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return uniqueStrings([trimmed, ...tokens]).sort((left, right) => right.length - left.length)
}

function highlightSnippet(snippet: string, keywords: string | string[]): ReactNode {
  if (!snippet) return null
  const markedSnippet = normalizeSearchSnippet(snippet).replace(/<</g, '\uE000').replace(/>>/g, '\uE001')
  const normalizedKeywords = (Array.isArray(keywords) ? keywords : [keywords])
    .map((keyword) => String(keyword || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const normalizeComparable = (value: string) => value.replace(/\s+/g, '').toLowerCase()
  const primaryKeyword = normalizedKeywords[0] || ''

  try {
    const escaped = normalizedKeywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const regex = escaped.length > 0 ? new RegExp(`(${escaped.join('|')})`, 'gi') : null
    const markerParts = markedSnippet.split(/(\uE000|\uE001)/)
    let markedByBackend = false
    let backendBuffer = ''
    let backendBufferIndex = 0

    const renderText = (part: string, keyPrefix: string, forceMark: boolean) => {
      if (forceMark || !regex) {
        return forceMark
          ? <mark key={keyPrefix} style={SEARCH_HIGHLIGHT_STYLE}>{part}</mark>
          : <span key={keyPrefix}>{part}</span>
      }

      return part.split(regex).map((piece, index) => (
        normalizedKeywords.some((keyword) => keyword.toLowerCase() === piece.toLowerCase())
          ? <mark key={`${keyPrefix}-${index}`} style={SEARCH_HIGHLIGHT_STYLE}>{piece}</mark>
          : <span key={`${keyPrefix}-${index}`}>{piece}</span>
      ))
    }

    const renderBackendMark = (part: string, keyPrefix: string) => {
      if (!part) return null
      const comparablePart = normalizeComparable(part)
      const comparablePrimary = normalizeComparable(primaryKeyword)
      const shouldTrustBackendMark = !comparablePrimary
        || comparablePart.length >= comparablePrimary.length
        || comparablePart === comparablePrimary
      return renderText(part, keyPrefix, shouldTrustBackendMark)
    }

    return (
      <>
        {markerParts.map((part, index) => {
          if (part === '\uE000') {
            markedByBackend = true
            backendBuffer = ''
            backendBufferIndex = index
            return null
          }
          if (part === '\uE001') {
            markedByBackend = false
            return renderBackendMark(backendBuffer, `snippet-backend-${backendBufferIndex}`)
          }
          if (markedByBackend) {
            backendBuffer += part
            return null
          }
          return renderText(part, `snippet-${index}`, markedByBackend)
        })}
      </>
    )
  } catch {
    return <span>{stripSnippetMarkers(snippet)}</span>
  }
}

function getResultHitTerms(item: FlatSearchResult, candidates: string[]): string[] {
  const text = `${item.doc_title || ''} ${item.snippet || ''} ${item.tag_names || ''}`.toLowerCase()
  return uniqueStrings([
    item.matched_query || '',
    ...getKeywordCandidates(candidates.join(' ')),
    ...candidates.filter((keyword) => {
      const normalized = String(keyword || '').trim()
      if (!normalized || normalized.length > 32) return false
      return text.includes(normalized.toLowerCase())
    }),
  ])
    .filter((keyword) => {
      const normalized = String(keyword || '').trim()
      if (!normalized || normalized.length > 64) return false
      return text.includes(normalized.toLowerCase()) || normalized === item.matched_query
    })
    .slice(0, 6)
}

function normalizeTagLabel(value: string): string {
  return String(value || '').replace(/\s+/g, '').toLowerCase()
}

function getVisibleTags(tagNames: string[] | undefined, docType?: string | null, limit = 6): string[] {
  const docTypeKey = normalizeTagLabel(docType || '')
  const seen = new Set<string>()
  const visible: string[] = []
  for (const tagName of tagNames || []) {
    const label = String(tagName || '').trim()
    const key = normalizeTagLabel(label)
    if (!label || !key || key === docTypeKey || seen.has(key)) continue
    seen.add(key)
    visible.push(label)
    if (visible.length >= limit) break
  }
  return visible
}

function parseSearchMode(value: unknown): SearchMode {
  if (value === 'ai') return 'ai'
  if (value === 'vector') return 'vector'
  return 'fulltext'
}

function searchModeLabel(mode: SearchMode): string {
  if (mode === 'ai') return 'AI'
  if (mode === 'vector') return '向量'
  return '全文'
}

function searchModeTagColor(mode: SearchMode): string {
  if (mode === 'ai') return 'gold'
  if (mode === 'vector') return 'cyan'
  return 'blue'
}

function parseSavedSearchPayload(entry: SavedSearch): {
  keyword: string
  mode: SearchMode
  filters: SearchFilters
  sort: SearchSort
  contextMode: ContextMode
  vectorLimit: number
} {
  try {
    const parsed = typeof entry.filters === 'string'
      ? JSON.parse(entry.filters || '{}') as unknown
      : entry.filters
    const raw = isRecord(parsed) ? parsed : {}
    const filterPayload = isRecord(raw.filters) ? raw.filters : raw
    return {
      keyword: typeof raw.keyword === 'string' ? raw.keyword.trim() : '',
      mode: parseSearchMode(raw.mode),
      filters: compactSearchFilters(filterPayload),
      sort: isSearchSort(raw.sort) ? raw.sort : 'relevance',
      contextMode: isContextMode(raw.contextMode) ? raw.contextMode : 'standard',
      vectorLimit: normalizeVectorSearchLimit(
        filterPayload.limit ?? raw.limit,
        VECTOR_SEARCH_DEFAULT_LIMIT,
      ),
    }
  } catch {
    return {
      keyword: '',
      mode: 'fulltext',
      filters: {},
      sort: 'relevance',
      contextMode: 'standard',
      vectorLimit: VECTOR_SEARCH_DEFAULT_LIMIT,
    }
  }
}

/** Convert embedding hits into the same flat result shape used by the search UI (not merged with FTS). */
function vectorHitsToFlatResults(hits: VectorSearchHit[], query: string): FlatSearchResult[] {
  return (hits || []).map((hit, index) => {
    const pageNum = Number(hit.pageNum || hit.ref?.pageNum || 1) || 1
    const docId = String(hit.documentId || hit.ref?.docId || '')
    const segmentId = String(hit.ref?.segmentId || `${docId}:${pageNum}:${index}`)
    const score = Number(hit.score) || 0
    const excerpt = String(hit.excerpt || '').replace(/\s+/g, ' ').trim()
    // matchText is the paragraph excerpt so the reader can highlight semantic text, not the query string.
    const matchText = excerpt
      ? (excerpt.length <= 160 ? excerpt : excerpt.slice(0, 160))
      : query
    return {
      doc_id: docId,
      page_num: pageNum,
      occurrence_index: index,
      snippet: excerpt,
      rank: score,
      relevance_score: score,
      doc_title: String(hit.title || 'Untitled'),
      doc_author: hit.author ?? null,
      doc_type: '',
      hit_field: 'vector',
      matched_query: query,
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
    }
  }).filter((item) => item.doc_id)
}

function getJumpKeyword(item: FlatSearchResult, inputValue: string, hitTerms: string[]): string {
  const snippet = stripSnippetMarkers(String(item.snippet || ''))
  const candidates = uniqueStrings([
    ...hitTerms,
    item.matched_query || '',
    ...getKeywordCandidates(inputValue),
    inputValue,
  ]).filter(Boolean)
  const lowerSnippet = snippet.toLowerCase()
  return candidates.find((term) => lowerSnippet.includes(term.toLowerCase())) || candidates[0] || inputValue
}

function flattenGroupedResults(grouped: SearchGroupedResponse, hitField: string): FlatSearchResult[] {
  return (grouped.groups || []).flatMap((group: SearchDocumentGroup) => group.hits.map((hit: SearchHit) => ({
    doc_id: group.docId,
    page_num: hit.locator.pageNum || 1,
    occurrence_index: hit.locator.occurrenceIndex,
    snippet: hit.snippet,
    rank: hit.score,
    doc_title: group.title,
    doc_author: group.author,
    doc_type: group.docType,
    hit_field: hitField,
    matched_query: hit.locator.queryTerm,
    tag_names: group.tagNames?.join('|'),
    folder_names: group.folderNames?.join('|'),
    read_status: group.readStatus,
    is_favorite: group.isFavorite,
    metadata_status: group.metadataStatus,
    locator: hit.locator,
  })))
}

function groupFlatResults(results: FlatSearchResult[], query: string, warnings: string[] = []): SearchGroupedResponse {
  const byDoc = new Map<string, SearchDocumentGroup>()
  results.forEach((item, index) => {
    if (!item.doc_id) return
    const pageNum = Number(item.page_num || item.locator?.pageNum || 1)
    const locator: SearchHitLocator = item.locator || {
      docId: item.doc_id,
      segmentId: `${item.doc_id}:${pageNum}:${item.occurrence_index ?? index}`,
      pageId: null,
      pageNum,
      pageIndex: Math.max(0, pageNum - 1),
      href: null,
      segmentOrdinal: pageNum - 1,
      charStart: 0,
      charEnd: 0,
      matchText: item.matched_query || query,
      queryTerm: item.matched_query || query,
      occurrenceIndex: Number(item.occurrence_index || index),
    }
    const hit: SearchHit = {
      id: `${locator.segmentId}:${locator.occurrenceIndex}:${index}`,
      locator,
      stableLocator: stableLocatorFromLegacySearchLocator(locator),
      snippet: item.snippet || '',
      score: Number(item.rank || index),
    }
    const group = byDoc.get(item.doc_id) || {
      docId: item.doc_id,
      title: item.doc_title || 'Untitled',
      author: item.doc_author || null,
      docType: item.doc_type || '',
      readStatus: item.read_status,
      isFavorite: item.is_favorite,
      metadataStatus: item.metadata_status,
      tagNames: String(item.tag_names || '').split('|').filter(Boolean),
      folderNames: String(item.folder_names || '').split('|').filter(Boolean),
      totalHits: 0,
      topHits: [] as SearchHit[],
      hits: [] as SearchHit[],
      score: 0,
    }
    group.hits.push(hit)
    group.totalHits = group.hits.length
    group.topHits = group.hits.slice(0, 3)
    group.score += Math.max(1, 1000 - hit.score)
    byDoc.set(item.doc_id, group)
  })
  const groups = [...byDoc.values()].sort((left, right) => right.totalHits - left.totalHits || right.score - left.score)
  return {
    query,
    totalDocuments: groups.length,
    totalHits: groups.reduce((sum, group) => sum + group.totalHits, 0),
    groups,
    warnings,
  }
}

async function mapWithLimitedConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Math.floor(concurrency)))
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: safeConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  })
  await Promise.all(workers)
  return results
}

async function applyViewerHitCounts(
  response: SearchGroupedResponse,
  keyword: string,
  sort: SearchSort,
): Promise<SearchGroupedResponse> {
  const query = keyword.trim()
  if (!query || response.groups.length === 0) return response

  const countRows = await mapWithLimitedConcurrency(response.groups, SEARCH_VIEWER_COUNT_CONCURRENCY, async (group) => {
    try {
      const payload = await window.api.getDocumentSearchHitPage(group.docId, query, {
        page: 1,
        pageSize: SEARCH_DOCUMENT_HIT_PAGE_SIZE,
        resultMode: 'all',
      })
      return { docId: group.docId, count: payload.totalHits, hits: payload.hits, ok: true }
    } catch (error) {
      console.warn('[Search] Failed to count viewer-visible hits', group.docId, error)
      return { docId: group.docId, count: group.totalHits, hits: [] as SearchHit[], ok: false }
    }
  })

  const counts = new Map(countRows.map((item) => [item.docId, item]))
  const groups = response.groups
    .map((group) => {
      const row = counts.get(group.docId)
      if (!row?.ok) return group
      return { ...group, totalHits: row.count, hits: row.hits, topHits: row.hits.slice(0, 3) }
    })
    .filter((group) => {
      const row = counts.get(group.docId)
      return !row?.ok || group.totalHits > 0
    })

  if (sort === 'hitCount') {
    groups.sort((left, right) => right.totalHits - left.totalHits || right.score - left.score)
  }

  return {
    ...response,
    groups,
  }
}

function buildFocusedSearchSession(query: string, hit?: SearchHit | null): SearchSessionState | undefined {
  if (!hit) return undefined
  return {
    query,
    hits: [hit],
    activeHitIndex: 0,
    status: 'ready',
  }
}

/** Prefer a stable excerpt substring so the reader can highlight semantic paragraphs (not the query term). */
function pickVectorMatchText(snippet: string, query: string): string {
  const clean = stripSnippetMarkers(snippet).replace(/\s+/g, ' ').trim()
  if (!clean) return String(query || '').trim()
  if (clean.length <= 160) return clean
  return clean.slice(0, 160)
}

function normalizeVectorHitForReader(hit: SearchHit, query: string): SearchHit {
  const matchText = pickVectorMatchText(hit.snippet || '', query)
  return {
    ...hit,
    locator: {
      ...hit.locator,
      matchText,
      queryTerm: query || hit.locator.queryTerm || matchText,
      charStart: Number(hit.locator.charStart || 0),
      charEnd: Math.max(Number(hit.locator.charEnd || 0), matchText.length),
    },
  }
}

/** In-document vector session: navigate/highlight semantic hits without full-text search. */
function buildVectorDocumentSearchSession(
  query: string,
  hits: SearchHit[],
  activeHit?: SearchHit | null,
): SearchSessionState {
  const q = String(query || '').trim()
  const normalized = (hits || []).map((hit) => normalizeVectorHitForReader(hit, q))
  let activeHitIndex = 0
  if (activeHit) {
    const byId = normalized.findIndex((hit) => hit.id === activeHit.id)
    if (byId >= 0) {
      activeHitIndex = byId
    } else {
      const bySeg = normalized.findIndex((hit) => (
        hit.locator.segmentId === activeHit.locator.segmentId
        && Number(hit.locator.pageNum || 0) === Number(activeHit.locator.pageNum || 0)
      ))
      activeHitIndex = bySeg >= 0 ? bySeg : 0
    }
  }
  return {
    query: q,
    hits: normalized,
    activeHitIndex: normalized.length ? Math.min(activeHitIndex, normalized.length - 1) : -1,
    status: normalized.length > 0 ? 'ready' : 'empty',
    engine: 'vector',
  }
}

function getReliableLocatorPageIndex(locator: SearchHitLocator | null | undefined): number | undefined {
  const rawValue = locator?.pageIndex
  if (rawValue === null || rawValue === undefined) return undefined
  const value = Number(rawValue)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function getStableLocatorPageIndex(hit: SearchHit | null | undefined): number | undefined {
  const pageNum = Number(hit?.stableLocator?.pageNum)
  if (Number.isFinite(pageNum) && pageNum > 0) return Math.floor(pageNum) - 1
  return getReliableLocatorPageIndex(hit?.locator)
}

function buildSearchHitFromFlatResult(item: FlatSearchResult, query: string, fallbackKeyword: string): SearchHit | undefined {
  if (!item.locator) return undefined
  const matchText = item.locator.matchText || item.matched_query || fallbackKeyword || query
  return {
    id: item.locator.segmentId || `${item.doc_id}:${item.page_num || 0}:${item.occurrence_index ?? 0}`,
    locator: {
      ...item.locator,
      matchText,
      queryTerm: item.locator.queryTerm || item.matched_query || fallbackKeyword || query,
    },
    stableLocator: item.stableLocator || stableLocatorFromLegacySearchLocator(item.locator),
    snippet: String(item.snippet || ''),
    score: Number(item.rank || 0),
  }
}

async function sha1Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return ''
  const bytes = new TextEncoder().encode(value)
  const digest = await subtle.digest('SHA-1', bytes)
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('')
}

async function buildSearchExcerptSourceHash(item: FlatSearchResult, excerpt: string): Promise<string> {
  try {
    const source = buildSearchExcerptSourceHashInput({
      docId: item.doc_id,
      pageNum: item.page_num || item.locator?.pageNum || '',
      excerpt,
    })
    return (await sha1Hex(source)).slice(0, 16)
  } catch {
    return ''
  }
}

export default function SearchView({ onSelectDoc, initialKeyword, onOpenLibraryAi }: SearchViewProps) {
  const {
    keyword,
    results,
    groupedResponse,
    executedSearchSignature,
    loading,
    filters,
    setKeyword,
    setResults,
    setGroupedResponse,
    setExecutedSearchSignature,
    setLoading,
    replaceFilters,
    addHistory,
  } = useSearchStore()

  const [inputValue, setInputValue] = useState(keyword || initialKeyword || '')
  const [searchMode, setSearchMode] = useState<SearchMode>('fulltext')
  /** Mode of the results currently on screen (button may differ until user re-searches). */
  const [executedSearchMode, setExecutedSearchMode] = useState<SearchMode | null>(null)
  const [vectorSearchLimit, setVectorSearchLimit] = useState<number>(() => loadVectorSearchLimit())
  const [searchSort, setSearchSort] = useState<SearchSort>('relevance')
  const [contextMode, setContextMode] = useState<ContextMode>('standard')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('txt')
  /** Default: 文献页码（书上印刷/校准页码）；可选自然页码（PDF/扫描物理页序）。 */
  const [exportPageNumberMode, setExportPageNumberMode] = useState<ExportPageNumberMode>('literature')
  /** Vector export: only keep hits with similarity ≥ this (0 = no filter). Persisted in localStorage. */
  const [exportMinVectorScore, setExportMinVectorScore] = useState<number>(() => loadExportMinVectorScore())
  /** Max evidence rows / paragraphs to export. Persisted. */
  const [exportMaxRecords, setExportMaxRecords] = useState<SearchExportCount>(() => loadExportMaxRecords())
  const [aiSearchState, setAiSearchState] = useState<AiSearchState | null>(null)
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>([])
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([])
  const [historySearch, setHistorySearch] = useState('')
  const [filterDocuments, setFilterDocuments] = useState<FilterDocumentItem[]>([])
  const [filterTags, setFilterTags] = useState<FilterTagItem[]>([])
  const [filterFolders, setFilterFolders] = useState<FilterFolderItem[]>([])
  const [citationStyles, setCitationStyles] = useState<CitationStyle[]>([])
  const [citationTemplates, setCitationTemplates] = useState<CitationTemplate[]>([])
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [citationMode, setCitationMode] = useState<'auto' | 'simple' | 'template'>('auto')
  const [selectedCitationStyleId, setSelectedCitationStyleId] = useState<string | undefined>()
  const [selectedCitationTemplateId, setSelectedCitationTemplateId] = useState<string | undefined>()
  const [askingLibraryAi, setAskingLibraryAi] = useState(false)
  const [exportingExcerpts, setExportingExcerpts] = useState(false)
  const [savingExcerpts, setSavingExcerpts] = useState(false)
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [exportPreviewLoading, setExportPreviewLoading] = useState(false)
  const [exportPreview, setExportPreview] = useState<SearchExportPreviewResult | null>(null)
  const [exportPreviewExpanded, setExportPreviewExpanded] = useState(false)
  const [searchExportTask, setSearchExportTask] = useState<BackgroundTaskProgressEvent | null>(null)
  const [searchPage, setSearchPage] = useState(groupedResponse?.page || 1)
  const [expandedHitDocId, setExpandedHitDocId] = useState('')
  const [documentHitPages, setDocumentHitPages] = useState<Record<string, SearchDocumentHitPageState>>({})
  const [shortcuts, setShortcuts] = useState<ShortcutMap | null>(null)
  const searchInputRef = useRef<InputRef>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pendingScrollRestoreRef = useRef<PendingSearchScrollRestore | null>(null)
  const returnStateRestoredRef = useRef(false)
  const viewerHitCountRefreshSignatureRef = useRef<string | null>(null)
  const exportPreviewRequestIdRef = useRef(0)

  useEffect(() => {
    return window.api.onBackgroundTaskStatusChanged((event) => {
      if (event.kind !== 'search-export') return
      setSearchExportTask(event)
      if (event.status === 'completed') {
        setExportingExcerpts(false)
        message.success(event.message || '后台导出完成')
      } else if (event.status === 'error') {
        setExportingExcerpts(false)
        message.error(event.errorMessage || event.message || '后台导出失败')
      } else if (event.status === 'canceled') {
        setExportingExcerpts(false)
        message.info(event.message || '后台导出已取消')
      }
    })
  }, [])

  const filterSignature = useMemo(() => JSON.stringify({ filters: compactFilterOptions(filters), sort: searchSort, contextMode }), [filters, searchSort, contextMode])
  const selectedDocIds = filters.docIds || []
  const selectedTagIds = filters.tagIds || []
  const selectedFolderIds = filters.folderIds || []
  const docTypeOptions = useMemo(() => uniqueStrings(filterDocuments.map((doc) => doc.doc_type || '').filter(Boolean)), [filterDocuments])
  const aiHighlightKeywords = useMemo(() => (
    searchMode === 'ai'
      ? uniqueStrings([
        inputValue,
        ...(aiSearchState?.expandedQueries || []),
        ...(aiSearchState?.plan?.keywords || []),
        ...(aiSearchState?.plan?.expandedKeywords || []),
      ])
      : [inputValue]
  ), [aiSearchState, inputValue, searchMode])

  const filteredSearchHistory = useMemo(() => {
    const search = historySearch.trim().toLowerCase()
    if (!search) return searchHistory
    return searchHistory.filter((entry) => `${entry.keyword} ${entry.mode}`.toLowerCase().includes(search))
  }, [historySearch, searchHistory])

  const buildSearchOptions = (
    overrideFilters = filters,
    options: {
      paged?: boolean
      page?: number
      resultMode?: 'preview' | 'all'
      snapshotId?: string
      /** When exporting current on-screen vector results, force embedding path. */
      forExport?: boolean
      forceVector?: boolean
    } = {},
  ) => ({
    ...compactFilterOptions(overrideFilters),
    limit: DEFAULT_SEARCH_GROUP_LIMIT,
    sort: searchSort,
    contextMode,
    resultMode: options.resultMode || 'preview' as const,
    ...(options.paged ? { page: options.page || 1, pageSize: SEARCH_PAGE_SIZE } : {}),
    ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
    // Vector hits are not in FTS; export/preview/save must re-run vector_search.
    ...((
      options.forceVector
      || options.forExport
      || searchMode === 'vector'
      || executedSearchMode === 'vector'
    )
      ? { searchEngine: 'vector' as const }
      : {}),
  })

  const formatExportVersionLabel = (version?: string | null): string => {
    const value = String(version || '').trim()
    if (!value) return ''
    if (value === 'vector-evidence-v1' || /vector/i.test(value)) return '向量证据格式'
    if (value === 'full-paragraph-v2' || /full-paragraph/i.test(value)) return '完整段落格式'
    return value
  }

  /** 正文从哪里还原：不是“被截断”，而是导出时选用的文本来源。 */
  const formatExportSourceTypeLabel = (sourceType?: string | null): string => {
    const value = String(sourceType || '').trim()
    if (value === 'page') return '整页文字'
    if (value === 'segment') return '索引段落'
    if (value === 'normalized-segment') return '规范化段落'
    if (value === 'snippet') return '向量摘录'
    return value || '正文来源'
  }

  const formatExportSourceTypeHint = (sourceType?: string | null): string => {
    const value = String(sourceType || '').trim()
    if (value === 'page') return '从该页 OCR/校对全文中还原的自然段（导出文件中为完整段，非界面截断）'
    if (value === 'segment') return '从检索索引分段还原的正文'
    if (value === 'normalized-segment') return '从规范化检索文本还原的正文'
    if (value === 'snippet') return '无法还原整页时，使用向量检索返回的摘录片段'
    return '导出正文的来源'
  }

  /** 预览底部定位行始终中文（兼容旧英文 locatorText）。 */
  const formatExportLocatorDisplay = (locatorText?: string | null, pageNum?: number | null, term?: string | null): string => {
    const raw = String(locatorText || '').trim()
    if (!raw) {
      const parts = [
        pageNum ? `页码 ${pageNum}` : '',
        term ? `检索词「${term}」` : '',
      ].filter(Boolean)
      return parts.join(' · ')
    }
    // English: page=3; segment=0; char=0-120; term=共产党
    // Chinese already: 页码=3；段序=0
    let text = raw
      .replace(/page\s*=\s*/gi, '页码 ')
      .replace(/segment\s*=\s*/gi, '段序 ')
      .replace(/char\s*=\s*/gi, '字符范围 ')
      .replace(/term\s*=\s*/gi, '检索词 ')
      .replace(/segmentId\s*=\s*|分段\s*=\s*/gi, '分段 ')
      .replace(/;/g, ' · ')
      .replace(/；/g, ' · ')
      .replace(/=\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (pageNum && !/页码/.test(text)) text = `页码 ${pageNum} · ${text}`
    return text
  }

  const buildSearchSignature = (
    activeKeyword = inputValue,
    activeFilters = filters,
    activeMode: SearchMode = searchMode,
    activeSort: SearchSort = searchSort,
    activeContextMode: ContextMode = contextMode,
    activeVectorLimit = vectorSearchLimit,
  ) => JSON.stringify({
    keyword: String(activeKeyword || '').trim(),
    mode: activeMode,
    filters: compactFilterOptions(activeFilters),
    sort: activeSort,
    contextMode: activeContextMode,
    ...(activeMode === 'vector'
      ? { vectorLimit: normalizeVectorSearchLimit(activeVectorLimit, VECTOR_SEARCH_DEFAULT_LIMIT) }
      : {}),
  })

  const pendingSearchSignature = useMemo(
    () => buildSearchSignature(inputValue, filters, searchMode, searchSort, contextMode, vectorSearchLimit),
    [inputValue, filters, searchMode, searchSort, contextMode, vectorSearchLimit],
  )
  const hasSearchSnapshot = !!groupedResponse || results.length > 0
  const searchConditionsChanged = hasSearchSnapshot && !!executedSearchSignature && pendingSearchSignature !== executedSearchSignature
  const resultsAreVector = executedSearchMode === 'vector'
    || Boolean(groupedResponse?.warnings?.some((item) => String(item || '').includes('向量库语义检索')))
  const resultsAreAi = executedSearchMode === 'ai'
  const activeResultMode: SearchMode = resultsAreVector ? 'vector' : resultsAreAi ? 'ai' : (executedSearchMode || searchMode)

  const getSearchAnchorTop = (element: HTMLElement, container: HTMLElement) => {
    const elementRect = element.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    return elementRect.top - containerRect.top + container.scrollTop
  }

  const findSearchDocHitPanel = (docId: string) => {
    const container = scrollContainerRef.current
    if (!container) return null
    return Array.from(container.querySelectorAll<HTMLElement>('[data-search-doc-id]'))
      .find((element) => element.dataset.searchDocId === docId) || null
  }

  const blurActiveSearchControl = () => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  }

  const rememberSearchScrollPosition = (anchorDocId?: string) => {
    const container = scrollContainerRef.current
    if (!container) return
    const anchor = anchorDocId ? findSearchDocHitPanel(anchorDocId) : null
    pendingScrollRestoreRef.current = {
      scrollTop: container.scrollTop,
      anchorDocId,
      anchorTop: anchor ? getSearchAnchorTop(anchor, container) : undefined,
    }
    blurActiveSearchControl()
  }

  const persistCurrentSearchReturnState = () => {
    const searchSignature = executedSearchSignature || buildSearchSignature(
      keyword || inputValue,
      filters,
      searchMode,
      searchSort,
      contextMode,
      vectorSearchLimit,
    )
    if (!searchSignature || (!groupedResponse && results.length === 0)) return
    const sanitizedDocumentHitPages = Object.fromEntries(Object.entries(documentHitPages).map(([docId, state]) => [
      docId,
      {
        page: state.payload?.page || state.page || 1,
        loading: false,
        payload: state.payload,
        error: state.error,
      },
    ]))
    saveSearchReturnState({
      searchSignature,
      expandedHitDocId,
      documentHitPages: sanitizedDocumentHitPages,
      scrollTop: scrollContainerRef.current?.scrollTop || 0,
      savedAt: new Date().toISOString(),
    })
  }

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current
    if (loading || pending === null) return
    if (pending.anchorDocId && documentHitPages[pending.anchorDocId]?.loading) return
    const restore = pending
    pendingScrollRestoreRef.current = null
    const applyRestore = () => {
      const container = scrollContainerRef.current
      if (!container) return
      if (restore.anchorDocId && restore.anchorTop !== undefined) {
        const anchor = findSearchDocHitPanel(restore.anchorDocId)
        if (anchor) {
          const nextTop = getSearchAnchorTop(anchor, container)
          container.scrollTop += nextTop - restore.anchorTop
          return
        }
      }
      container.scrollTop = restore.scrollTop
    }
    window.requestAnimationFrame(() => {
      applyRestore()
      window.requestAnimationFrame(applyRestore)
    })
  }, [documentHitPages, expandedHitDocId, groupedResponse, loading, results])

  useEffect(() => {
    if (returnStateRestoredRef.current || loading || (!groupedResponse && results.length === 0)) return
    const savedState = loadSearchReturnState()
    if (!savedState) {
      returnStateRestoredRef.current = true
      return
    }
    const activeSignature = executedSearchSignature || buildSearchSignature(keyword || inputValue, filters, searchMode, searchSort, contextMode)
    if (savedState.searchSignature !== activeSignature) {
      clearSearchReturnState()
      returnStateRestoredRef.current = true
      return
    }
    setExpandedHitDocId(savedState.expandedHitDocId)
    setDocumentHitPages(savedState.documentHitPages)
    pendingScrollRestoreRef.current = { scrollTop: savedState.scrollTop, anchorDocId: savedState.expandedHitDocId || undefined }
    returnStateRestoredRef.current = true
  }, [executedSearchSignature, filters, groupedResponse, inputValue, keyword, loading, results.length, searchMode, searchSort, contextMode])

  const updateSearchHistory = (updater: (entries: SearchHistoryEntry[]) => SearchHistoryEntry[]) => {
    setSearchHistory((previous) => {
      const next = updater(previous).slice(0, 30)
      saveSearchHistory(next)
      return next
    })
  }

  const persistHistoryEntry = (
    activeKeyword: string,
    mode: SearchMode,
    filterSnapshot: SearchFilters,
    resultSnapshot: FlatSearchResult[],
    aiSnapshot: AiSearchState | null,
    groupedSnapshot: SearchGroupedResponse | null = null,
    activeVectorLimit = vectorSearchLimit,
  ) => {
    const vectorLimit = mode === 'vector'
      ? normalizeVectorSearchLimit(activeVectorLimit, VECTOR_SEARCH_DEFAULT_LIMIT)
      : undefined
    const historyTruncated = mode === 'vector'
      && Number(groupedSnapshot?.totalHits || resultSnapshot.length) > VECTOR_SEARCH_HISTORY_HIT_LIMIT
    const entry: SearchHistoryEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      keyword: activeKeyword,
      mode,
      filters: compactSearchFilters(filterSnapshot),
      results: resultSnapshot.slice(0, 80),
      totalHits: groupedSnapshot?.totalHits ?? resultSnapshot.length,
      totalDocuments: groupedSnapshot?.totalDocuments ?? uniqueStrings(resultSnapshot.map((item) => item.doc_id || '')).length,
      aiSearchState: aiSnapshot,
      groupedResponse: groupedSnapshot && mode === 'vector'
        ? compactVectorGroupedResponseForHistory(groupedSnapshot)
        : groupedSnapshot,
      vectorLimit,
      historyTruncated,
      createdAt: new Date().toISOString(),
    }
    updateSearchHistory((previous) => {
      const deduped = previous.filter((item) => !(item.keyword === entry.keyword && item.mode === entry.mode && JSON.stringify(item.filters) === JSON.stringify(entry.filters)))
      return [entry, ...deduped]
    })
  }

  const refreshViewerHitCountsInBackground = (
    response: SearchGroupedResponse,
    activeKeyword: string,
    activeSort: SearchSort,
    activeSignature: string,
    mode: SearchMode,
    filterSnapshot: SearchFilters,
    resultSnapshot: FlatSearchResult[],
    aiSnapshot: AiSearchState | null,
  ) => {
    viewerHitCountRefreshSignatureRef.current = activeSignature
    void applyViewerHitCounts(response, activeKeyword, activeSort)
      .then((readerCountedGrouped) => {
        if (viewerHitCountRefreshSignatureRef.current !== activeSignature) return
        const nextResults = mode === 'fulltext'
          ? flattenGroupedResults(readerCountedGrouped, 'fulltext').slice(0, 360)
          : resultSnapshot
        setGroupedResponse(readerCountedGrouped)
        if (mode === 'fulltext') setResults(nextResults)
        persistHistoryEntry(activeKeyword, mode, filterSnapshot, nextResults, aiSnapshot, readerCountedGrouped)
      })
      .catch((error) => {
        console.warn('[Search] Failed to refresh viewer-visible hit counts', error)
      })
  }

  const loadFilterOptions = async () => {
    try {
      // Design: filter options read fixed documents-table fields only (no pages scan,
      // no artificial "recent 100" cut). Search results remain a separate paginated API.
      const [docs, tags, folders] = await Promise.all([
        window.api.listDocumentFilterOptions(),
        window.api.listTags(),
        window.api.listFolders(),
      ])
      setFilterDocuments(
        (docs || []).map((doc) => ({
          id: doc.id,
          title: String(doc.title || '未命名文献'),
          author: doc.author,
          doc_type: String(doc.doc_type || ''),
        })),
      )
      setFilterTags(tags)
      setFilterFolders(folders)
    } catch (error) {
      console.error(error)
    }
  }

  const loadCitationTemplates = async (preferDefaultStyle = false): Promise<string | undefined> => {
    try {
      const [styles, templates] = await Promise.all([
        window.api.listCitationStyles(),
        window.api.listCitationTemplates(),
      ])
      const styleList = Array.isArray(styles) ? styles : []
      const list = Array.isArray(templates) ? templates : []
      const defaultStyleId = styleList.find((item) => item.is_default)?.id || styleList[0]?.id
      setCitationStyles(styleList)
      setCitationTemplates(list)
      setSelectedCitationStyleId((current) => (preferDefaultStyle ? defaultStyleId || current : current || defaultStyleId))
      setSelectedCitationTemplateId((current) => current || undefined)
      return defaultStyleId
    } catch (error) {
      console.error(error)
      return undefined
    }
  }

  const loadSavedSearches = async () => {
    try {
      const list = await window.api.listSavedSearches()
      setSavedSearches(Array.isArray(list) ? list : [])
    } catch (error) {
      console.error(error)
    }
  }

  useEffect(() => {
    void loadFilterOptions()
    void loadCitationTemplates()
    void loadSavedSearches()
    setSearchHistory(loadSearchHistory())
  }, [])

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

  const isVectorExportContext = () => (
    executedSearchMode === 'vector'
    || searchMode === 'vector'
    || activeResultMode === 'vector'
    || resultsAreVector
    || Boolean(groupedResponse?.warnings?.some((item) => String(item || '').includes('向量库语义检索')))
  )

  const applyExportMinVectorScore = (value: unknown) => {
    const next = normalizeExportMinVectorScore(value)
    setExportMinVectorScore(next)
    setExportPreview(null)
    saveExportMinVectorScore(next)
    return next
  }

  const applyVectorSearchLimit = (value: unknown) => {
    const next = normalizeVectorSearchLimit(value, VECTOR_SEARCH_DEFAULT_LIMIT)
    setVectorSearchLimit(next)
    saveVectorSearchLimit(next)
    return next
  }

  const applyExportMaxRecords = (value: unknown) => {
    const next = normalizeExportMaxRecords(value)
    setExportMaxRecords(next)
    setExportPreview(null)
    saveExportMaxRecords(next)
    return next
  }

  /** Prefer current on-screen groups so export/preview does not re-scan the vector index. */
  const buildExportRequestOptions = (
    extra: Record<string, unknown> = {},
    behavior?: { reuseCurrentGroups?: boolean },
  ) => {
    const useVector = isVectorExportContext()
    const maxRecords = normalizeExportMaxRecords(exportMaxRecords)
    const minScore = useVector ? normalizeExportMinVectorScore(exportMinVectorScore) : 0
    const groups = useVector || behavior?.reuseCurrentGroups ? groupedResponse?.groups : undefined
    const trimmedGroups = groups && groups.length > 0
      ? trimGroupsForExport(groups, maxRecords, minScore)
      : undefined
    return {
      ...buildSearchOptions(filters, {
        forExport: true,
        forceVector: useVector,
      }),
      limit: useVector
        ? normalizeVectorSearchLimit(vectorSearchLimit, VECTOR_SEARCH_DEFAULT_LIMIT)
        : (maxRecords === 'all' ? DEFAULT_SEARCH_EXPORT_COUNT : maxRecords),
      searchEngine: useVector ? 'vector' as const : 'fulltext' as const,
      maxExportRecords: maxRecords,
      ...(useVector ? { minVectorScore: minScore } : {}),
      ...(trimmedGroups && trimmedGroups.length > 0
        ? {
          exportGroups: trimmedGroups,
          exportWarnings: groupedResponse?.warnings || [],
        }
        : {}),
      ...extra,
    }
  }

  const loadExportPreview = async (citationStyleIdOverride?: string) => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      return
    }
    const requestId = exportPreviewRequestIdRef.current + 1
    exportPreviewRequestIdRef.current = requestId
    setExportPreviewLoading(true)
    try {
      const payload = await window.api.previewSearchExportExcerpts(
        activeKeyword,
        buildExportRequestOptions({
          format: exportFormat,
          citationMode,
          citationStyleId: citationMode === 'auto' ? citationStyleIdOverride || selectedCitationStyleId : undefined,
          citationTemplateId: citationMode === 'template' ? selectedCitationTemplateId : undefined,
          pageNumberMode: exportPageNumberMode,
        }, { reuseCurrentGroups: true }),
      )
      if (exportPreviewRequestIdRef.current === requestId) {
        setExportPreview(payload)
      }
    } catch (error) {
      console.error(error)
      if (exportPreviewRequestIdRef.current === requestId) {
        setExportPreview(null)
      }
    } finally {
      if (exportPreviewRequestIdRef.current === requestId) {
        setExportPreviewLoading(false)
      }
    }
  }

  const openExportModal = () => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      message.info('请先输入检索词')
      return
    }
    void (async () => {
      const defaultStyleId = await loadCitationTemplates(true)
      setExportPageNumberMode('literature')
      setExportPreview(null)
      setExportPreviewExpanded(false)
      setExportModalOpen(true)
      if (defaultStyleId) setSelectedCitationStyleId(defaultStyleId)
    })()
  }

  const handleSearch = async (
    overrideKeyword?: string,
    overrideFilters = filters,
    overrideMode: SearchMode = searchMode,
    overridePage = 1,
    overrideVectorLimit = vectorSearchLimit,
  ) => {
    const activeKeyword = (overrideKeyword ?? inputValue).trim()
    if (!activeKeyword) return

    setKeyword(activeKeyword)
    setSearchPage(overridePage)
    setLoading(true)
    setExpandedHitDocId('')
    setDocumentHitPages({})
    clearSearchReturnState()
    addHistory(activeKeyword)
    const activeSort = searchSort
    const activeVectorLimit = normalizeVectorSearchLimit(overrideVectorLimit, VECTOR_SEARCH_DEFAULT_LIMIT)
    const activeSignature = buildSearchSignature(
      activeKeyword,
      overrideFilters,
      overrideMode,
      activeSort,
      contextMode,
      activeVectorLimit,
    )
    viewerHitCountRefreshSignatureRef.current = activeSignature

    try {
      if (overrideMode === 'ai') {
        const payload = await window.api.aiSearch(activeKeyword, buildSearchOptions(overrideFilters))
        const nextAiState: AiSearchState = {
          plan: payload?.plan,
          expandedQueries: payload?.expandedQueries || [],
          effectiveFilters: payload?.effectiveFilters || {},
          warnings: payload?.warnings || [],
        }
        const nextResults = payload?.results || []
        const grouped = payload?.grouped || groupFlatResults(nextResults, activeKeyword, nextAiState.warnings || [])
        const readerCountedGrouped = activeSort === 'hitCount'
          ? await applyViewerHitCounts(grouped, activeKeyword, activeSort)
          : grouped
        setAiSearchState(nextAiState)
        setResults(nextResults)
        setGroupedResponse(readerCountedGrouped)
        setExecutedSearchSignature(activeSignature)
        setExecutedSearchMode('ai')
        persistHistoryEntry(activeKeyword, 'ai', overrideFilters, nextResults, nextAiState, readerCountedGrouped)
        if (activeSort !== 'hitCount') {
          refreshViewerHitCountsInBackground(grouped, activeKeyword, activeSort, activeSignature, 'ai', overrideFilters, nextResults, nextAiState)
        }
      } else if (overrideMode === 'vector') {
        // Standalone embedding search — never mixed into full-text FTS ranking.
        const folderId = (overrideFilters.folderIds || [])[0]
        const tagId = (overrideFilters.tagIds || [])[0]
        const vectorRes = await window.api.vectorSearch(activeKeyword, {
          limit: activeVectorLimit,
          folderId: folderId || undefined,
          tagId: tagId || undefined,
        })
        if (!vectorRes.ok) {
          setAiSearchState(null)
          setResults([])
          setGroupedResponse(null)
          setExecutedSearchSignature(activeSignature)
          setExecutedSearchMode('vector')
          message.warning(vectorRes.message || '向量检索失败')
          return
        }
        const nextResults = vectorHitsToFlatResults(vectorRes.hits, activeKeyword)
        const warnings = [
          `向量库语义检索（与全文检索分开）· 模型 ${vectorRes.modelId || 'embeddings'} · 请求召回 ${activeVectorLimit} 条`,
          vectorRes.hint || '',
          (overrideFilters.folderIds || []).length > 1 ? '向量检索当前仅应用第一个文件夹筛选' : '',
          (overrideFilters.tagIds || []).length > 1 ? '向量检索当前仅应用第一个标签筛选' : '',
        ].filter(Boolean)
        const grouped = groupFlatResults(nextResults, activeKeyword, warnings)
        // Rank groups by vector score (higher first); keep all hits on each group for expand.
        grouped.groups = [...grouped.groups]
          .map((group) => ({
            ...group,
            hits: [...group.hits].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)),
            topHits: [...group.hits].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)).slice(0, 3),
            totalHits: group.hits.length,
          }))
          .sort((a, b) => {
            const scoreA = Math.max(0, ...a.hits.map((h) => Number(h.score) || 0))
            const scoreB = Math.max(0, ...b.hits.map((h) => Number(h.score) || 0))
            return scoreB - scoreA || b.totalHits - a.totalHits
          })
        setAiSearchState(null)
        setResults(nextResults)
        setGroupedResponse(grouped)
        setExecutedSearchSignature(activeSignature)
        setExecutedSearchMode('vector')
        persistHistoryEntry(activeKeyword, 'vector', overrideFilters, nextResults, null, grouped, activeVectorLimit)
      } else {
        const reusableSnapshotId = overridePage > 1 && executedSearchSignature === activeSignature
          ? groupedResponse?.snapshotId
          : undefined
        const runFulltextQuery = async (snapshotId?: string) => window.api.querySearchV2(
          activeKeyword,
          buildSearchOptions(overrideFilters, {
            paged: true,
            page: overridePage,
            snapshotId,
          }),
        )
        let grouped: SearchGroupedResponse
        try {
          grouped = await runFulltextQuery(reusableSnapshotId)
        } catch (error) {
          // Soft-recover: opening a document / snapshot expiry used to hard-fail pagination.
          // Main process also soft-recovers; keep this as a client safety net.
          const errorMessage = getErrorMessage(error, '')
          if (reusableSnapshotId && errorMessage.includes('search_snapshot_')) {
            grouped = await runFulltextQuery(undefined)
          } else {
            throw error
          }
        }
        const readerCountedGrouped = activeSort === 'hitCount'
          ? await applyViewerHitCounts(grouped, activeKeyword, activeSort)
          : grouped
        const nextResults = flattenGroupedResults(readerCountedGrouped, 'fulltext').slice(0, 360)
        setGroupedResponse(readerCountedGrouped)
        setAiSearchState(null)
        setResults(nextResults)
        setExecutedSearchSignature(activeSignature)
        setExecutedSearchMode('fulltext')
        persistHistoryEntry(activeKeyword, 'fulltext', overrideFilters, nextResults, null, readerCountedGrouped)
        if (activeSort !== 'hitCount') {
          refreshViewerHitCountsInBackground(grouped, activeKeyword, activeSort, activeSignature, 'fulltext', overrideFilters, nextResults, null)
        }
      }
    } catch (error) {
      console.error(error)
      const errorMessage = getErrorMessage(error, '')
      if (errorMessage.includes('search_snapshot_')) {
        // Last-resort recovery for any remaining snapshot failures (should be rare).
        message.warning('检索会话已过期，正在自动重新检索…')
        try {
          if (overrideMode === 'fulltext' || (!overrideMode && searchMode === 'fulltext')) {
            const recovered = await window.api.querySearchV2(
              (overrideKeyword ?? inputValue).trim(),
              buildSearchOptions(overrideFilters, { paged: true, page: overridePage || 1 }),
            )
            const nextResults = flattenGroupedResults(recovered, 'fulltext').slice(0, 360)
            setGroupedResponse(recovered)
            setAiSearchState(null)
            setResults(nextResults)
            setExecutedSearchSignature(buildSearchSignature(
              (overrideKeyword ?? inputValue).trim(),
              overrideFilters,
              'fulltext',
              searchSort,
              contextMode,
            ))
            setExecutedSearchMode('fulltext')
            message.success('已自动刷新检索结果，可继续打开文献')
            return
          }
        } catch (recoverError) {
          console.error(recoverError)
        }
        message.warning('检索结果已更新，请点击搜索后继续')
      } else {
        message.error(overrideMode === 'vector' ? getErrorMessage(error, '向量检索失败') : '检索失败')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const initial = (initialKeyword || '').trim()
    const currentKeyword = keyword.trim()
    if (!initial) return
    if (initial !== currentKeyword || (!groupedResponse && !results.length)) void handleSearch(initial)
  }, [])

  useEffect(() => {
    if (!exportModalOpen || !exportPreviewExpanded) return
    const timer = window.setTimeout(() => {
      void loadExportPreview()
    }, 250)
    return () => window.clearTimeout(timer)
  }, [exportModalOpen, exportPreviewExpanded, exportFormat, exportPageNumberMode, exportMinVectorScore, exportMaxRecords, citationMode, selectedCitationStyleId, selectedCitationTemplateId, searchSort, contextMode, filterSignature])

  useEffect(() => {
    if (!shortcuts) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (hasShortcutBlockingOverlay()) return
      if (!shortcutMatches(event, shortcuts.search)) return

      const input = (searchInputRef.current?.input as HTMLInputElement | undefined)
        || document.querySelector<HTMLInputElement>('input[data-search-page-input="true"]')
      if (!input) return

      const isSearchTarget = event.target === input
      if (isEditableShortcutTarget(event.target) && !isSearchTarget) return

      event.preventDefault()
      if (document.activeElement === input) {
        input.blur()
        return
      }
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcuts])

  const setFilterPatch = (patch: Partial<SearchFilters>) => {
    const nextFilters: SearchFilters = { ...filters, ...patch }
    replaceFilters(nextFilters)
  }

  const clearFiltersAndRefresh = () => {
    replaceFilters({})
  }

  const restoreSearchHistory = (entry: SearchHistoryEntry) => {
    const restoredVectorLimit = normalizeVectorSearchLimit(
      entry.vectorLimit,
      VECTOR_SEARCH_DEFAULT_LIMIT,
    )
    setInputValue(entry.keyword)
    setKeyword(entry.keyword)
    setSearchMode(entry.mode)
    setExecutedSearchMode(entry.mode)
    if (entry.mode === 'vector') {
      setVectorSearchLimit(restoredVectorLimit)
      saveVectorSearchLimit(restoredVectorLimit)
    }
    setSearchPage(entry.groupedResponse?.page || 1)
    setExpandedHitDocId('')
    setDocumentHitPages({})
    clearSearchReturnState()
    replaceFilters(entry.filters)
    setAiSearchState(entry.aiSearchState)
    const restoredGrouped = entry.groupedResponse || (entry.results?.length ? groupFlatResults(entry.results, entry.keyword, entry.aiSearchState?.warnings || []) : null)
    const restoredResults = entry.results || []
    const restoredSignature = buildSearchSignature(
      entry.keyword,
      entry.filters,
      entry.mode,
      searchSort,
      contextMode,
      restoredVectorLimit,
    )
    setGroupedResponse(restoredGrouped)
    setResults(restoredResults)
    setExecutedSearchSignature(restoredSignature)
    // Never re-count with full-text API for vector history (would look like keyword search).
    if (restoredGrouped && entry.mode !== 'vector') {
      refreshViewerHitCountsInBackground(restoredGrouped, entry.keyword, searchSort, restoredSignature, entry.mode, entry.filters, restoredResults, entry.aiSearchState)
    }
    if (entry.mode === 'vector' && entry.historyTruncated) {
      void handleSearch(entry.keyword, entry.filters, 'vector', 1, restoredVectorLimit)
      message.info(`历史记录只缓存前 ${VECTOR_SEARCH_HISTORY_HIT_LIMIT} 条，正在按原召回数量重新检索`)
      return
    }
    message.success(entry.mode === 'vector' ? '已恢复向量库检索结果' : '已恢复历史检索')
  }

  const handleSaveCurrentSearch = () => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      message.info('请先输入检索词')
      return
    }
    let searchName = activeKeyword
    Modal.confirm({
      title: '保存检索',
      content: (
        <Input
          defaultValue={searchName}
          placeholder="给这次检索命名"
          onChange={(event) => { searchName = event.target.value.trim() || activeKeyword }}
        />
      ),
      okText: '保存',
      cancelText: '取消',
      onOk: async () => {
        await window.api.saveSearch(searchName, {
          keyword: activeKeyword,
          mode: searchMode,
          filters: {
            ...compactFilterOptions(filters),
            ...(searchMode === 'vector'
              ? { limit: normalizeVectorSearchLimit(vectorSearchLimit, VECTOR_SEARCH_DEFAULT_LIMIT) }
              : {}),
          },
          sort: searchSort,
          contextMode,
          cache: groupedResponse && searchMode !== 'vector'
            ? {
                grouped: groupedResponse,
                results: results.slice(0, 360),
              }
            : undefined,
        })
        await loadSavedSearches()
        message.success('已保存检索')
      },
    })
  }

  const restoreSavedSearch = async (entry: SavedSearch) => {
    try {
      const payload = parseSavedSearchPayload(entry)
      if (!payload.keyword) {
        message.info('保存的检索没有关键词')
        return
      }
      const savedPayload = await window.api.runSavedSearch(entry.id)
      const restoredKeyword = savedPayload?.keyword || payload.keyword
      const restoredMode = parseSearchMode(savedPayload?.mode || payload.mode)
      const restoredFilters = compactSearchFilters(savedPayload?.filters || payload.filters)
      const restoredSort = savedPayload?.sort || payload.sort
      const restoredContextMode = savedPayload?.contextMode || payload.contextMode
      const restoredVectorLimit = normalizeVectorSearchLimit(
        savedPayload?.filters?.limit ?? payload.vectorLimit,
        VECTOR_SEARCH_DEFAULT_LIMIT,
      )
      setInputValue(restoredKeyword)
      setKeyword(restoredKeyword)
      setSearchMode(restoredMode)
      setSearchSort(restoredSort)
      setContextMode(restoredContextMode)
      if (restoredMode === 'vector') {
        setVectorSearchLimit(restoredVectorLimit)
        saveVectorSearchLimit(restoredVectorLimit)
      }
      replaceFilters(restoredFilters)
      setAiSearchState(null)
      setExpandedHitDocId('')
      setDocumentHitPages({})
      clearSearchReturnState()
      // Vector / AI: always re-run live search (vector needs embeddings API; keep modes separate).
      if (restoredMode === 'vector' || restoredMode === 'ai' || !savedPayload?.cacheHit || !savedPayload?.grouped) {
        await handleSearch(restoredKeyword, restoredFilters, restoredMode, 1, restoredVectorLimit)
        message.success(restoredMode === 'vector' ? '已重新执行向量库检索' : '已重新执行检索')
      } else {
        const restoredGrouped = savedPayload.grouped
        const restoredResults = Array.isArray(savedPayload.results) ? savedPayload.results : []
        setGroupedResponse(restoredGrouped)
        setResults(restoredResults)
        setSearchPage(restoredGrouped?.page || 1)
        setExecutedSearchSignature(buildSearchSignature(
          restoredKeyword,
          restoredFilters,
          restoredMode,
          restoredSort,
          restoredContextMode,
          restoredVectorLimit,
        ))
        message.success(savedPayload.cacheHit ? '已从缓存恢复检索结果' : '文献库已变化，已重新检索并刷新缓存')
      }
      await loadSavedSearches()
    } catch (error) {
      console.error(error)
      message.error('恢复保存检索失败')
    }
  }

  const deleteSavedSearchEntry = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation()
    await window.api.deleteSavedSearch(id)
    await loadSavedSearches()
    message.success('已删除保存检索')
  }

  const handleAskLibraryAi = async () => {
    const activeKeyword = inputValue.trim()
    if (!activeKeyword) {
      message.info('请先输入问题或检索词')
      return
    }

    if (onOpenLibraryAi) {
      const docIds = [...new Set(results.map((item) => item.doc_id).filter((docId): docId is string => !!docId))]
      onOpenLibraryAi({
        question: activeKeyword,
        scope: docIds.length > 0 ? { type: 'documents', docIds } : undefined,
        scopeLabel: docIds.length > 0 ? `当前检索结果（${docIds.length} 篇）` : undefined,
      })
      return
    }

    setAskingLibraryAi(true)
    try {
      const payload = await window.api.runLibraryAiSearch(activeKeyword, buildSearchOptions())
      if (Array.isArray(payload.results) && payload.results.length > 0) {
        setResults(payload.results)
      }
    } catch (error) {
      console.error(error)
      message.error('AI 文献库问答失败')
    } finally {
      setAskingLibraryAi(false)
    }
  }

  const handleSaveSearchExcerpt = async (event: React.MouseEvent, item: FlatSearchResult) => {
    event.stopPropagation()
    const excerpt = stripSnippetMarkers(String(item.snippet || '').trim())
    if (!item.doc_id || !excerpt) {
      message.info('这条结果没有可保存的摘录')
      return
    }

    const fallbackCitationText = item.doc_title ? `${item.doc_title}${item.page_num ? `，第 ${item.page_num} 页` : ''}` : ''
    let citationText = fallbackCitationText
    try {
      citationText = await resolveDocumentCitation(item.doc_id, { docType: item.doc_type, pageNum: item.page_num }) || fallbackCitationText
    } catch (error) {
      console.warn('Failed to generate search result citation from active style, falling back to simple citation.', error)
    }

    try {
      const sourceHash = await buildSearchExcerptSourceHash(item, excerpt)
      await window.api.createResearchNote({
        doc_id: item.doc_id,
        page_num: item.page_num || null,
        excerpt,
        note: inputValue ? `来自检索：${inputValue}` : '来自检索结果',
        source_type: 'search',
        kind: 'quote',
        locator: item.locator || null,
        citation_text: citationText,
        source_hash: sourceHash || undefined,
        source_id: JSON.stringify({
          sourceType: 'search',
          locator: item.locator || null,
          citation: citationText || null,
          page_num: item.page_num || null,
          pageNum: item.page_num || null,
          paragraphHash: sourceHash || null,
          searchKeyword: inputValue,
          matchedQuery: item.matched_query || null,
          hitField: item.hit_field || null,
          href: item.locator?.href || null,
          chapterTitle: item.locator?.href || null,
        }),
      })
      message.success('已保存为研究摘录')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存摘录失败'))
    }
  }

  const handleExportSearchExcerpts = async () => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      message.info('请先输入检索词')
      return
    }
    const isLargeExport = exportMaxRecords === 'all'
      || (typeof exportMaxRecords === 'number' && exportMaxRecords > DEFAULT_SEARCH_EXPORT_COUNT)
    if (isLargeExport) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '确认后台大批量导出？',
          content: exportMaxRecords === 'all'
            ? '“全部”可能包含大量命中，导出时间、磁盘占用和内存压力都会增加。任务会在后台分批执行，但仍可能影响整体性能，是否继续？'
            : `本次将导出最多 ${exportMaxRecords.toLocaleString()} 条内容。任务会在后台分批执行，但仍可能耗时较长并占用磁盘，是否继续？`,
          okText: '继续导出',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
      if (!confirmed) return
    }
    setExportingExcerpts(true)
    try {
      const activeCitationStyleId = citationMode === 'auto'
        ? selectedCitationStyleId || await loadCitationTemplates(true)
        : undefined
      const payload = await window.api.startSearchExportTask(activeKeyword, buildExportRequestOptions({
        format: exportFormat,
        citationMode,
        citationStyleId: activeCitationStyleId,
        citationTemplateId: citationMode === 'template' ? selectedCitationTemplateId : undefined,
        pageNumberMode: exportPageNumberMode,
      }))
      if (!payload?.canceled && payload.taskId) {
        setSearchExportTask({
          taskId: payload.taskId,
          kind: 'search-export',
          status: 'queued',
          progress: 0,
          message: '导出任务已加入后台队列。',
          updatedAt: new Date().toISOString(),
          taskState: {
            taskId: payload.taskId,
            kind: 'search-export',
            status: 'queued',
            progress: 0,
            updatedAt: new Date().toISOString(),
          },
        })
        setExportModalOpen(false)
        // Persist the threshold the user just used as the next default.
        saveExportMaxRecords(exportMaxRecords)
        if (isVectorExportContext()) {
          saveExportMinVectorScore(exportMinVectorScore)
        }
        message.info('导出任务已提交，软件可以继续使用；完成后会通知你。')
      }
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '导出检索摘录失败'))
    } finally {
      setExportingExcerpts(false)
    }
  }

  const handleBatchSaveSearchExcerpts = async () => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      message.info('请先输入检索词')
      return
    }
    setSavingExcerpts(true)
    try {
      const payload = await window.api.saveSearchExcerpts(activeKeyword, buildExportRequestOptions())
      message.success(`已保存 ${payload.savedCount} 条完整摘录，跳过 ${payload.skippedCount} 条重复摘录`)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '批量保存摘录失败'))
    } finally {
      setSavingExcerpts(false)
    }
  }

  const handleCancelSearchExportTask = async () => {
    const taskId = searchExportTask?.taskId
    if (!taskId || !['queued', 'processing'].includes(searchExportTask?.status || '')) return
    try {
      await window.api.cancelSearchExportTask(taskId)
      message.info('已请求取消导出，正在清理临时文件。')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '取消导出失败'))
    }
  }

  const handleExportSearchDiagnostics = async () => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      message.info('请先输入检索词')
      return
    }
    setExportingDiagnostics(true)
    try {
      const payload = await window.api.exportSearchDiagnostics(activeKeyword, buildExportRequestOptions())
      if (!payload?.canceled) {
        message.success(`已导出诊断：${payload.totalDocuments} 篇文献、${payload.totalHits} 条命中`)
      }
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '导出检索诊断失败'))
    } finally {
      setExportingDiagnostics(false)
    }
  }

  const handleSearchPageChange = (page: number) => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword || searchMode === 'ai' || searchMode === 'vector') return
    if (searchConditionsChanged) {
      message.info('检索条件已变化，请先点击搜索')
      return
    }
    rememberSearchScrollPosition()
    void handleSearch(activeKeyword, filters, 'fulltext', page)
  }

  const openGroupedDocument = (group: SearchDocumentGroup, hit?: SearchHit) => {
    const activeHit = hit || group.hits[0]
    const isVectorOpen = activeResultMode === 'vector' || resultsAreVector
    const activeKeyword = (keyword || inputValue || activeHit?.locator.queryTerm || '').trim()
    persistCurrentSearchReturnState()
    // Vector open: carry this document's semantic hits into the reader (not FTS keywords).
    if (isVectorOpen) {
      const vectorHits = [...(group.hits || [])]
      onSelectDoc?.({
        docId: group.docId,
        pageIndex: getStableLocatorPageIndex(activeHit),
        keyword: activeKeyword,
        sourceId: 'vector-search',
        stableLocator: activeHit?.stableLocator,
        openTranslation: Boolean(activeHit?.locator?.translationSource),
        searchSession: buildVectorDocumentSearchSession(activeKeyword, vectorHits, activeHit),
      })
      return
    }
    const exactLegacyLocator = activeHit?.stableLocator?.precision === 'exact' ? activeHit.locator : undefined
    onSelectDoc?.({
      docId: group.docId,
      pageIndex: getStableLocatorPageIndex(activeHit),
      keyword: activeKeyword || activeHit?.locator.queryTerm || inputValue,
      excerpt: activeHit ? stripSnippetMarkers(activeHit.snippet).slice(0, 120) : undefined,
      sourceId: 'search',
      locator: exactLegacyLocator,
      stableLocator: activeHit?.stableLocator,
      openTranslation: Boolean(activeHit?.locator.translationSource),
      searchSession: buildFocusedSearchSession(activeKeyword || activeHit?.locator.queryTerm || inputValue, exactLegacyLocator ? activeHit : undefined),
    })
  }

  const loadGroupedDocumentHitPage = async (group: SearchDocumentGroup, page = 1) => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      message.info('请先输入检索词')
      return
    }

    // Use the mode of *results on screen*, not the toolbar button (user may switch button without re-search).
    // Vector hits already live on the group — never call full-text hit API (keyword match would look like FTS).
    if (activeResultMode === 'vector' || resultsAreVector) {
      const allHits = [...(group.hits || [])].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      const pageSize = SEARCH_DOCUMENT_HIT_PAGE_SIZE
      const totalHits = allHits.length > 0 ? allHits.length : Number(group.totalHits || 0)
      const totalPages = Math.max(1, Math.ceil(Math.max(1, totalHits) / pageSize))
      const safePage = Math.min(Math.max(1, page), totalPages)
      const start = (safePage - 1) * pageSize
      const pageHits = allHits.slice(start, start + pageSize)
      setExpandedHitDocId(group.docId)
      setDocumentHitPages((previous) => ({
        ...previous,
        [group.docId]: {
          page: safePage,
          loading: false,
          payload: {
            docId: group.docId,
            query: activeKeyword,
            page: safePage,
            pageSize,
            totalHits: allHits.length || totalHits,
            totalPages,
            hits: pageHits,
            status: pageHits.length > 0 ? 'ready' : 'empty',
          },
        },
      }))
      return
    }

    setExpandedHitDocId(group.docId)
    setDocumentHitPages((previous) => ({
      ...previous,
      [group.docId]: {
        page,
        loading: true,
        payload: previous[group.docId]?.payload,
      },
    }))

    try {
      const payload = await window.api.getDocumentSearchHitPage(group.docId, activeKeyword, {
        page,
        pageSize: SEARCH_DOCUMENT_HIT_PAGE_SIZE,
        contextMode,
        resultMode: 'all',
        translationScope: filters.translationScope,
      })
      setDocumentHitPages((previous) => ({
        ...previous,
        [group.docId]: { page: payload.page, loading: false, payload },
      }))
    } catch (error: unknown) {
      console.error(error)
      setDocumentHitPages((previous) => ({
        ...previous,
        [group.docId]: {
          page,
          loading: false,
          payload: previous[group.docId]?.payload,
          error: getErrorMessage(error, '加载本文命中失败'),
        },
      }))
      message.error(getErrorMessage(error, '加载本文命中失败'))
    }
  }

  const handleToggleDocumentHits = (event: React.MouseEvent, group: SearchDocumentGroup) => {
    event.stopPropagation()
    rememberSearchScrollPosition(group.docId)
    if (expandedHitDocId === group.docId) {
      setExpandedHitDocId('')
      return
    }
    const activeKeyword = (keyword || inputValue).trim()
    const state = documentHitPages[group.docId]
    // Vector / mode switch: always rebuild from current result groups so we never show FTS keyword hits.
    if (activeResultMode === 'vector' || resultsAreVector || !state?.payload || state.payload.query !== activeKeyword) {
      void loadGroupedDocumentHitPage(group, 1)
      return
    }
    setExpandedHitDocId(group.docId)
  }

  const renderDocumentHitDirectory = (group: SearchDocumentGroup, highlightTerms: string[]) => {
    if (expandedHitDocId !== group.docId) return null
    const state = documentHitPages[group.docId]
    const payload = state?.payload
    const visibleHitEntries = payload ? payload.hits.map((hit, index) => ({ hit, index })) : []
    return (
      <div
        data-search-doc-hit-list="true"
        data-search-doc-id={group.docId}
        onClick={(event) => event.stopPropagation()}
        style={{
          marginTop: 0,
          padding: '10px 10px 12px',
          borderRadius: '0 0 6px 6px',
          border: '1px solid rgba(196,149,106,0.16)',
          borderTop: 'none',
          background: 'rgba(8,6,4,0.38)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 8 }}>
          <Space size={6} wrap>
            <Text strong style={{ color: 'var(--gs-text-primary)' }}>
              {resultsAreVector ? '本文语义片段' : '本文命中目录'}
            </Text>
            <Tag color="gold">{payload?.totalHits ?? group.totalHits} {resultsAreVector ? '条' : '处'}</Tag>
          </Space>
        </div>
        {state?.loading ? (
          <div style={{ padding: 18, textAlign: 'center' }}><Spin size="small" /></div>
        ) : state?.error ? (
          <Alert type="warning" showIcon message={state.error} />
        ) : payload && visibleHitEntries.length ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {visibleHitEntries.map(({ hit, index }) => {
              const globalIndex = (payload.page - 1) * payload.pageSize + index
              return (
                <button
                  key={`${hit.id}-${globalIndex}`}
                  type="button"
                  data-search-doc-hit="true"
                  onClick={() => openGroupedDocument(group, hit)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    border: '1px solid rgba(196,149,106,0.14)',
                    borderRadius: 6,
                    background: 'rgba(255,244,224,0.045)',
                    color: 'var(--gs-text-secondary)',
                    padding: '8px 10px',
                    cursor: 'pointer',
                    lineHeight: 1.65,
                  }}
                >
                  <Tag color="blue">第 {hit.locator.pageNum || 1} 页</Tag>
                  {resultsAreVector ? (
                    <Tag color="cyan">相似度 {Number(hit.score || 0).toFixed(3)}</Tag>
                  ) : null}
                  {hit.locator.translationSource ? <Tag color="gold">译文</Tag> : null}
                  <Tag color="default">#{globalIndex + 1}</Tag>
                  {highlightSnippet(hit.snippet, resultsAreVector ? [] : highlightTerms)}
                </button>
              )
            })}
          </Space>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={resultsAreVector ? '暂无语义片段' : '暂无命中'} />
        )}
        {payload && payload.totalHits > payload.pageSize ? (
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
              current={payload.page}
              pageSize={payload.pageSize}
              total={payload.totalHits}
              showSizeChanger={false}
              onChange={(page) => {
                rememberSearchScrollPosition(group.docId)
                void loadGroupedDocumentHitPage(group, page)
              }}
            />
          </div>
        ) : null}
      </div>
    )
  }

  const groupedPage = groupedResponse?.page || searchPage
  const groupedTotalPages = groupedResponse?.totalPages || 1
  const groupedResultStart = groupedResponse?.totalDocuments
    ? (groupedPage - 1) * SEARCH_PAGE_SIZE + 1
    : 0
  const groupedResultEnd = groupedResponse
    ? Math.min(groupedResponse.totalDocuments, groupedPage * SEARCH_PAGE_SIZE)
    : 0
  const showGroupedPagination = searchMode === 'fulltext'
    && !!groupedResponse
    && groupedResponse.totalDocuments > SEARCH_PAGE_SIZE
    && !searchConditionsChanged

  const searchPlaceholder = searchMode === 'vector'
    ? '输入主题或问题做语义检索（如：战犯改造与中日关系）…'
    : searchMode === 'ai'
      ? '输入研究问题，AI 会扩写关键词后检索…'
      : '输入关键词、主题或研究问题...'

  return (
    <div ref={scrollContainerRef} style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <Title level={3} style={{ color: 'var(--gs-gold)', marginTop: 0 }}>文献检索</Title>

      <Space.Compact style={{ width: '100%', maxWidth: 980, marginBottom: 12 }}>
        <Input
          ref={searchInputRef}
          size="large"
          prefix={<SearchOutlined />}
          value={inputValue}
          data-search-page-input="true"
          placeholder={searchPlaceholder}
          onChange={(event) => setInputValue(event.target.value)}
          onPressEnter={() => void handleSearch()}
          allowClear
        />
        <Button size="large" type="primary" data-search-page-submit="true" onClick={() => void handleSearch()} loading={loading}>
          搜索
        </Button>
      </Space.Compact>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <Button.Group>
          <Button
            type={searchMode === 'fulltext' ? 'primary' : 'default'}
            onClick={() => {
              setSearchMode('fulltext')
              const q = inputValue.trim()
              if (q && executedSearchMode && executedSearchMode !== 'fulltext') {
                void handleSearch(q, filters, 'fulltext', 1)
              }
            }}
          >
            全文检索
          </Button>
          <Button
            type={searchMode === 'vector' ? 'primary' : 'default'}
            icon={<ThunderboltOutlined />}
            onClick={() => {
              setSearchMode('vector')
            }}
          >
            向量库检索
          </Button>
          <Button
            type={searchMode === 'ai' ? 'primary' : 'default'}
            onClick={() => {
              setSearchMode('ai')
              const q = inputValue.trim()
              if (q && executedSearchMode !== 'ai') void handleSearch(q, filters, 'ai', 1)
            }}
          >
            AI 检索
          </Button>
        </Button.Group>
        {searchMode === 'vector' ? (
          <Space size={6}>
            <Text style={{ color: 'var(--gs-text-secondary)', whiteSpace: 'nowrap' }}>检索前召回</Text>
            <InputNumber
              aria-label="向量检索召回数量"
              min={1}
              max={VECTOR_SEARCH_MAX_LIMIT}
              step={100}
              value={vectorSearchLimit}
              onChange={applyVectorSearchLimit}
              addonAfter="条"
              style={{ width: 150 }}
            />
          </Space>
        ) : null}
        <Select
          value={filters.translationScope || 'all'}
          onChange={(value) => setFilterPatch({ translationScope: value })}
          style={{ width: 128 }}
          options={[
            { value: 'all', label: '全部文本' },
            { value: 'source', label: '仅原文' },
            { value: 'translation', label: '仅译文' },
          ]}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          maxTagTextLength={18}
          popupMatchSelectWidth={SEARCH_FILTER_POPUP_WIDTH}
          className="search-filter-select search-filter-select-docs"
          optionFilterProp="title"
          placeholder="限定文献"
          value={selectedDocIds}
          onChange={(value) => setFilterPatch({ docIds: value })}
          style={{ width: 300, maxWidth: '100%' }}
          options={filterDocuments.map((doc) => {
            const label = doc.author ? `${doc.title} / ${doc.author}` : doc.title
            return { value: doc.id, label: renderSelectEllipsisLabel(label), title: label }
          })}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          maxTagTextLength={14}
          popupMatchSelectWidth={320}
          className="search-filter-select"
          optionFilterProp="title"
          placeholder="标签筛选"
          value={selectedTagIds}
          onChange={(value) => setFilterPatch({ tagIds: value })}
          style={{ width: 220, maxWidth: '100%' }}
          options={filterTags.map((tag) => ({ value: tag.id, label: renderSelectEllipsisLabel(tag.name), title: tag.name }))}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          maxTagTextLength={14}
          popupMatchSelectWidth={320}
          className="search-filter-select"
          optionFilterProp="title"
          placeholder="文件夹筛选"
          value={selectedFolderIds}
          onChange={(value) => setFilterPatch({ folderIds: value })}
          style={{ width: 220, maxWidth: '100%' }}
          options={filterFolders.map((folder) => ({ value: folder.id, label: renderSelectEllipsisLabel(folder.name), title: folder.name }))}
        />
        <Select
          allowClear
          placeholder="阅读状态"
          value={filters.readStatus}
          onChange={(value) => setFilterPatch({ readStatus: value })}
          style={{ width: 130 }}
          options={[
            { value: 'unread', label: '未读' },
            { value: 'reading', label: '在读' },
            { value: 'read', label: '已读' },
          ]}
        />
        <Select allowClear placeholder="文献类型" value={filters.docType} onChange={(value) => setFilterPatch({ docType: value })} style={{ width: 140 }} options={docTypeOptions.map((item) => ({ value: item, label: item }))} />
        <Select
          allowClear
          placeholder="元数据"
          value={filters.metadataStatus}
          onChange={(value) => setFilterPatch({ metadataStatus: value })}
          style={{ width: 140 }}
          options={[
            { value: 'pending', label: '待补全' },
            { value: 'review', label: '待复核' },
            { value: 'confirmed', label: '已确认' },
            { value: 'auto', label: '自动' },
          ]}
        />
        <Input
          placeholder={'起始年'}
          value={filters.yearFrom || ''}
          onChange={(event) => setFilterPatch({ yearFrom: event.target.value ? Number(event.target.value) : undefined })}
          style={{ width: 96 }}
        />
        <Input
          placeholder={'结束年'}
          value={filters.yearTo || ''}
          onChange={(event) => setFilterPatch({ yearTo: event.target.value ? Number(event.target.value) : undefined })}
          style={{ width: 96 }}
        />
        <Select
          value={searchSort}
          onChange={(value) => setSearchSort(value)}
          style={{ width: 150 }}
          options={[
            { value: 'relevance', label: '相关度优先' },
            { value: 'hitCount', label: '命中数优先' },
            { value: 'updated', label: '最近更新' },
            { value: 'lastOpened', label: '最近阅读' },
            { value: 'title', label: '标题' },
          ]}
        />
        <Select
          value={contextMode}
          onChange={(value) => setContextMode(value)}
          style={{ width: 130 }}
          options={[
            { value: 'short', label: '短上下文' },
            { value: 'standard', label: '标准上下文' },
            { value: 'long', label: '长上下文' },
          ]}
        />
        <Switch
          checked={!!filters.favoritesOnly}
          onChange={(value) => setFilterPatch({ favoritesOnly: value || undefined })}
        />
        <Text style={{ color: 'var(--gs-text-secondary)' }}>星标</Text>
        <Button onClick={clearFiltersAndRefresh}>清空筛选</Button>
      </div>

      <Space style={{ marginBottom: 14 }}>
        <Button icon={<SaveOutlined />} onClick={handleSaveCurrentSearch}>保存检索</Button>
        <Button icon={<FileTextOutlined />} onClick={openExportModal} loading={exportingExcerpts} disabled={!inputValue.trim()}>
          导出命中摘录
        </Button>
        <Button icon={<SaveOutlined />} onClick={() => void handleBatchSaveSearchExcerpts()} loading={savingExcerpts} disabled={!inputValue.trim()}>
          批量保存完整段落
        </Button>
        <Button icon={<FileTextOutlined />} onClick={() => void handleExportSearchDiagnostics()} loading={exportingDiagnostics} disabled={!inputValue.trim()}>
          诊断导出
        </Button>
        <Button icon={<RobotOutlined />} onClick={() => void handleAskLibraryAi()} loading={askingLibraryAi}>AI 库问答</Button>
      </Space>

      {searchExportTask && ['queued', 'processing'].includes(searchExportTask.status) ? (
        <Card size="small" style={{ marginTop: 12 }}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text strong>后台导出任务</Text>
              <Button danger size="small" onClick={() => void handleCancelSearchExportTask()}>取消导出</Button>
            </Space>
            {Number(searchExportTask.totalCount || 0) > 0 ? (
              <Progress
                percent={Math.round(Math.max(0, Math.min(1, Number(searchExportTask.progress || 0))) * 100)}
                status="active"
              />
            ) : (
              <Space size={8}>
                <Spin size="small" />
                <Text type="secondary">正在后台准备，软件仍可继续使用</Text>
              </Space>
            )}
            <Text type="secondary">
              {searchExportTask.message || '正在分批写入文件'}
              {formatSearchExportProgressCounter(searchExportTask)
                ? `（${formatSearchExportProgressCounter(searchExportTask)}）`
                : ''}
            </Text>
          </Space>
        </Card>
      ) : null}

      <Modal
        title={'导出命中摘录'}
        open={exportModalOpen}
        onCancel={() => setExportModalOpen(false)}
        onOk={() => void handleExportSearchExcerpts()}
        okText={'导出'}
        cancelText={'取消'}
        confirmLoading={exportingExcerpts}
        width={760}
        styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
      >
        <Space direction={'vertical'} size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={isVectorExportContext()
              ? '按当前向量检索结果和相似度筛选导出；大数量任务会在后台分批写入，不会一次性渲染全部内容。'
              : '检索页显示的是快速统计；选择“全部”时会在后台完整扫描，原始命中数可能调整。同一完整段落内的多处命中会合并为一个导出段落。'}
          />

          <div style={{
            display: 'grid',
            gridTemplateColumns: isVectorExportContext()
              ? 'repeat(auto-fit, minmax(240px, 1fr))'
              : 'minmax(240px, 1fr)',
            gap: 12,
          }}>
            <div>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>
                {isVectorExportContext() ? '导出证据数量' : '导出段落数量'}
              </Text>
              {exportMaxRecords === 'all' ? (
                <Select
                  value="all"
                  onChange={(value) => {
                    if (value === 'custom') applyExportMaxRecords(DEFAULT_EXPORT_MAX_RECORDS)
                  }}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'custom', label: '指定数量' },
                    { value: 'all', label: '全部命中（耗时可能较长）' },
                  ]}
                />
              ) : (
                <Space.Compact style={{ width: '100%' }}>
                  <InputNumber
                    min={1}
                    step={100}
                    value={exportMaxRecords}
                    onChange={applyExportMaxRecords}
                    style={{ width: '100%' }}
                    addonAfter="条"
                    placeholder="输入数量"
                  />
                  <Select
                    value="custom"
                    onChange={(value) => {
                      if (value === 'all') applyExportMaxRecords('all')
                    }}
                    style={{ width: 160 }}
                    options={[
                      { value: 'custom', label: '指定数量' },
                      { value: 'all', label: '全部命中' },
                    ]}
                  />
                </Space.Compact>
              )}
              <Text type="secondary" style={{ display: 'block', marginTop: 5, fontSize: 12 }}>
                默认 {DEFAULT_SEARCH_EXPORT_COUNT.toLocaleString()} 条；可输入更高数量，或选择“全部”。超大导出会在后台分批执行并显示进度。
              </Text>
            </div>
            {isVectorExportContext() ? (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>最低相似度</Text>
                <InputNumber
                  min={0}
                  max={1}
                  step={0.05}
                  precision={3}
                  value={exportMinVectorScore}
                  onChange={applyExportMinVectorScore}
                  style={{ width: '100%' }}
                  addonBefore="≥"
                />
                <Text type="secondary" style={{ display: 'block', marginTop: 5, fontSize: 12 }}>
                  {exportMinVectorScore > 0
                    ? `仅导出相似度 ≥ ${exportMinVectorScore} 的证据；设为 0 表示不过滤。`
                    : '0 表示不过滤相似度。'}
                </Text>
              </div>
            ) : null}
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 12,
          }}>
            <div>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>文件格式</Text>
              <Select
                value={exportFormat}
                onChange={(value) => setExportFormat(value)}
                style={{ width: '100%' }}
                options={[
                  { value: 'txt', label: 'TXT' },
                  { value: 'markdown', label: 'Markdown' },
                  { value: 'csv', label: 'CSV' },
                  { value: 'json', label: 'JSON' },
                ]}
              />
            </div>
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
              <Text type="secondary" style={{ display: 'block', marginTop: 5, fontSize: 12 }}>
                {exportPageNumberMode === 'natural' ? 'PDF/扫描物理页序' : '印刷或校准后的连续页码'}
              </Text>
            </div>
          </div>

          <Collapse
            size="small"
            items={[{
              key: 'citation',
              label: '引用格式（可选）',
              children: (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Select
                    value={citationMode}
                    onChange={(value) => setCitationMode(value)}
                    style={{ width: '100%' }}
                    options={[
                      { value: 'auto', label: '自动匹配引用格式' },
                      { value: 'template', label: '手动选择引用模板' },
                      { value: 'simple', label: '简明引用' },
                    ]}
                  />
                  {citationMode === 'auto' ? (
                    <>
                      <Select
                        value={selectedCitationStyleId}
                        placeholder={'选择引用标准'}
                        onChange={(value) => setSelectedCitationStyleId(value)}
                        style={{ width: '100%' }}
                        options={citationStyles.map((style) => ({
                          value: style.id,
                          label: `${style.name}${style.is_default ? '（默认）' : ''}`,
                        }))}
                      />
                      <Text type={'secondary'}>{'导出时会按文献类型自动选择对应模板。'}</Text>
                    </>
                  ) : null}
                  {citationMode === 'template' ? (
                    <Select
                      allowClear
                      value={selectedCitationTemplateId}
                      placeholder={'选择引用模板'}
                      onChange={(value) => setSelectedCitationTemplateId(value || undefined)}
                      style={{ width: '100%' }}
                      options={[
                        { value: '', label: '默认简明引用' },
                        ...citationTemplates.map((template) => ({
                          value: template.id,
                          label: `${template.name}${template.is_default ? '（默认）' : ''}`,
                        })),
                      ]}
                    />
                  ) : null}
                  {citationMode === 'simple' ? (
                    <Text type={'secondary'}>{'使用作者、标题、页码组成的简明引用。'}</Text>
                  ) : null}
                </Space>
              ),
            }]}
          />

          <Collapse
            size="small"
            activeKey={exportPreviewExpanded ? ['preview'] : []}
            onChange={(keys) => {
              const expanded = Array.isArray(keys) ? keys.includes('preview') : keys === 'preview'
              setExportPreviewExpanded(expanded)
              if (expanded && !exportPreview && !exportPreviewLoading) {
                void loadExportPreview()
              }
            }}
            items={[{
              key: 'preview',
              label: exportPreview?.previewItems?.length
                ? `导出预览（前 ${exportPreview.previewItems.length} 条）`
                : '导出预览（按需生成）',
              extra: (
                <Button
                  type="link"
                  size="small"
                  loading={exportPreviewLoading}
                  onClick={(event) => {
                    event.stopPropagation()
                    setExportPreviewExpanded(true)
                    void loadExportPreview()
                  }}
                >
                  刷新
                </Button>
              ),
              children: (
                <Space direction={'vertical'} size={10} style={{ width: '100%' }}>
                  {exportPreview ? <Space size={8} wrap>
                    <Tag color={'blue'}>
                      预计导出 {exportPreview?.exportableParagraphs ?? 0}
                      {isVectorExportContext() ? ' 条证据' : ' 段'}
                    </Tag>
                    <Tag>上限 {exportPreview?.maxExportRecords ?? exportMaxRecords}</Tag>
                    <Tag color={(exportPreview?.skippedHits || 0) > 0 ? 'orange' : 'green'}>
                      无法还原 {exportPreview?.skippedHits ?? 0}
                    </Tag>
                    {isVectorExportContext() && (exportPreview?.filteredByMinScore || 0) > 0 ? (
                      <Tag color="purple">相似度不足 {exportPreview?.filteredByMinScore}</Tag>
                    ) : null}
                    {isVectorExportContext() && exportMinVectorScore > 0 ? (
                      <Tag color="cyan">门槛 ≥ {exportMinVectorScore}</Tag>
                    ) : null}
                    {exportPreview?.totalHits != null ? <Tag>命中 {exportPreview.totalHits}</Tag> : null}
                    {exportPreview?.exporterVersion ? (
                      <Tag>{formatExportVersionLabel(exportPreview.exporterVersion)}</Tag>
                    ) : null}
                  </Space> : null}
                  {exportPreviewLoading ? (
                    <Spin size={'small'} />
                  ) : exportPreview?.previewItems?.length ? (
                    <Space direction={'vertical'} size={8} style={{ width: '100%' }}>
                      {exportPreview.previewItems.map((item, index) => (
                        <div
                          key={`${item.sourceKey}-${index}`}
                          style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
                        >
                          <Space size={6} wrap style={{ marginBottom: 6 }}>
                            <Text strong>{item.title}</Text>
                            {item.pageNum ? <Tag>第 {item.pageNum} 页</Tag> : null}
                            {typeof item.score === 'number' && Number.isFinite(item.score) ? (
                              <Tag color="cyan">相似度 {item.score.toFixed(3)}</Tag>
                            ) : null}
                            <Tooltip title={formatExportSourceTypeHint(item.sourceType)}>
                              <Tag color={item.sourceType === 'page' ? 'green' : 'orange'}>
                                {formatExportSourceTypeLabel(item.sourceType)}
                              </Tag>
                            </Tooltip>
                            {item.hitTerms.slice(0, 3).map((term) => <Tag key={term} color={'gold'}>{term}</Tag>)}
                          </Space>
                          <Text style={{
                            display: 'block',
                            color: 'var(--gs-text-secondary)',
                            whiteSpace: 'pre-wrap',
                            maxHeight: 140,
                            overflowY: 'auto',
                          }}>
                            {item.paragraph}
                          </Text>
                          <Text type={'secondary'} style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                            定位：{formatExportLocatorDisplay(item.locatorText, item.pageNum, item.hitTerms[0])}
                          </Text>
                        </div>
                      ))}
                    </Space>
                  ) : exportPreview ? (
                    <Text type={'secondary'}>
                      {activeResultMode === 'vector'
                        ? '没有可预览的向量证据。请确认已向量化且本次检索有命中。'
                        : '没有可预览的完整段落。可以先运行诊断导出查看缺失原因。'}
                    </Text>
                  ) : (
                    <Text type={'secondary'}>预览尚未生成，展开后会自动生成，也可以点击右上角“刷新”。</Text>
                  )}
                </Space>
              ),
            }]}
          />
        </Space>
      </Modal>

      <Card size={'small'} style={{ marginBottom: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <Text strong style={{ color: 'var(--gs-text-primary)' }}><SaveOutlined /> 保存的检索</Text>
          <Button type={'text'} size={'small'} onClick={() => void loadSavedSearches()}>刷新</Button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {savedSearches.slice(0, 18).map((entry) => {
            const payload = parseSavedSearchPayload(entry)
            return (
              <Button
                key={entry.id}
                size={'small'}
                onClick={() => void restoreSavedSearch(entry)}
                style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                <Tag color={searchModeTagColor(payload.mode)}>{searchModeLabel(payload.mode)}</Tag>
                {entry.name || payload.keyword}
                <DeleteOutlined onClick={(event) => void deleteSavedSearchEntry(event, entry.id)} />
              </Button>
            )
          })}
          {savedSearches.length === 0 ? <Text type={'secondary'}>{'暂无保存的检索'}</Text> : null}
        </div>
      </Card>

      <Card size={'small'} style={{ marginBottom: 18, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <Text strong style={{ color: 'var(--gs-text-primary)' }}><SearchOutlined /> 最近检索</Text>
          <Button type={'text'} size={'small'} onClick={() => updateSearchHistory(() => [])}>清空</Button>
        </div>
        <Input
          size={'small'}
          placeholder={'查找历史记录'}
          value={historySearch}
          onChange={(event) => setHistorySearch(event.target.value)}
          style={{ maxWidth: 360, marginBottom: 8 }}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {filteredSearchHistory.slice(0, 18).map((entry) => {
            const totalHits = Number(entry.totalHits ?? entry.groupedResponse?.totalHits ?? entry.results.length)
            const cachedCount = entry.results.length
            const cachedSuffix = totalHits > cachedCount ? `，已缓存前 ${cachedCount} 条用于快速恢复` : ''
            return (
              <Button
                key={entry.id}
                size={'small'}
                title={`${entry.keyword}：共 ${totalHits} 处命中${cachedSuffix}`}
                onClick={() => restoreSearchHistory(entry)}
                style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                <Tag color={searchModeTagColor(entry.mode)}>{searchModeLabel(entry.mode)}</Tag>
                {entry.keyword} {totalHits} 处命中
                <DeleteOutlined
                  onClick={(event) => {
                    event.stopPropagation()
                    updateSearchHistory((items) => items.filter((item) => item.id !== entry.id))
                  }}
                />
              </Button>
            )
          })}
        </div>
      </Card>

      {aiSearchState && searchMode === 'ai' ? (
        <Card size={'small'} style={{ marginBottom: 18, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Space direction={'vertical'} size={8}>
            <Text strong style={{ color: 'var(--gs-text-primary)' }}><BulbOutlined /> AI 检索计划</Text>
            {aiSearchState.plan?.intent ? <Text style={{ color: 'var(--gs-text-primary)' }}>{aiSearchState.plan.intent}</Text> : null}
            <Space wrap>
              {(aiSearchState.plan?.keywords || []).map((item) => <Tag key={`kw-${item}`} color={'gold'}>{item}</Tag>)}
              {(aiSearchState.plan?.expandedKeywords || []).slice(0, 16).map((item) => <Tag key={`ex-${item}`} color={'blue'}>{item}</Tag>)}
            </Space>
            {(aiSearchState.warnings || []).map((warning) => <Alert key={warning} type={'warning'} showIcon message={warning} />)}
          </Space>
        </Card>
      ) : null}

      {resultsAreVector && !loading ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前结果来自：向量库语义检索（不是关键词全文检索）"
          description={`按主题/语义相似度召回已向量化正文；当前已召回 ${groupedResponse?.totalHits || results.length} 条。修改上方召回数量后，点击搜索即可按新数量重新检索。`}
        />
      ) : searchMode === 'vector' && !loading && !resultsAreVector ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="已选中「向量库检索」"
          description={`请先设置召回数量（默认 ${VECTOR_SEARCH_DEFAULT_LIMIT}，最多 ${VECTOR_SEARCH_MAX_LIMIT}），再输入主题并点击搜索。与全文检索互不合并。`}
        />
      ) : null}

      <div style={{ marginBottom: 12, color: 'var(--gs-text-secondary)' }}>
        {loading
          ? (searchMode === 'vector' || activeResultMode === 'vector' ? '正在向量检索...' : '正在检索...')
          : groupedResponse
            ? (resultsAreVector
              ? `语义命中 ${groupedResponse.totalDocuments} 篇文献，${groupedResponse.totalHits} 条片段（按相似度排序 · 非关键词全文）`
              : `找到 ${groupedResponse.totalDocuments} 篇文献，快速统计 ${groupedResponse.totalHits} 处命中；当前显示第 ${groupedResultStart}-${groupedResultEnd} 篇；列表仅展示每篇前几条片段，选择“全部”导出时会重新完整扫描并合并同段重复命中`)
            : results.length > 0 ? `找到 ${results.length} 条结果` : ''}
      </div>
      {searchConditionsChanged ? (
        <Alert
          type={'warning'}
          showIcon
          message={
            searchMode !== activeResultMode
              ? `模式已切换为「${searchModeLabel(searchMode)}」，当前列表仍是上次「${searchModeLabel(activeResultMode)}」的结果；确认检索条件后点击搜索。`
              : '检索条件已变化，当前仍显示上一次检索结果；点击搜索后才会按新条件检索。'
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size={'large'} tip={'正在检索...'} /></div>
      ) : groupedResponse && groupedResponse.groups.length > 0 ? (
        <>
          <List
            dataSource={groupedResponse.groups}
            rowKey={(group) => group.docId}
            renderItem={(group) => {
              const highlightTerms = getKeywordCandidates(inputValue)
              const previewHits = group.topHits.slice(0, 3)
              const isExpanded = expandedHitDocId === group.docId
              return (
                <Card
                  size={'small'}
                  style={{ marginBottom: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <Text strong style={{ color: 'var(--gs-text-primary)', fontSize: 15 }}>
                        {highlightSnippet(group.title || 'Untitled', highlightTerms)}
                      </Text>
                      {group.author ? <Text style={{ color: 'var(--gs-text-secondary)', marginLeft: 8 }}>{group.author}</Text> : null}
                      {group.isFavorite ? <StarOutlined style={{ color: '#faad14', marginLeft: 8 }} /> : null}
                    </div>
                    <Space size={6}>
                      {resultsAreAi ? <Tag color={'purple'}>AI 检索</Tag> : null}
                      {resultsAreVector ? <Tag color={'cyan'}>向量库 · 语义</Tag> : null}
                      <Tag color={'gold'}>{group.totalHits} {resultsAreVector ? '条语义片段' : '处命中'}</Tag>
                      <Button size="small" onClick={() => openGroupedDocument(group)}>
                        打开文献
                      </Button>
                    </Space>
                  </div>
                  <Space size={6} wrap style={{ marginBottom: 8 }}>
                    {group.docType ? <Tag>{group.docType}</Tag> : null}
                    {group.readStatus ? (
                      <Tag color={group.readStatus === 'read' ? 'success' : group.readStatus === 'reading' ? 'processing' : 'default'}>
                        {group.readStatus === 'read' ? '已读' : group.readStatus === 'reading' ? '在读' : '未读'}
                      </Tag>
                    ) : null}
                    {getVisibleTags(group.tagNames, group.docType).map((tagName) => <Tag key={tagName}>{tagName}</Tag>)}
                  </Space>
                  {!isExpanded ? (
                    <Space direction={'vertical'} size={8} style={{ width: '100%' }}>
                      {previewHits.map((hit, index) => (
                      <button
                        key={hit.id}
                        type={'button'}
                        onClick={(event) => {
                          event.stopPropagation()
                          openGroupedDocument(group, hit)
                        }}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          border: '1px solid rgba(255,255,255,0.06)',
                          borderRadius: 6,
                          background: 'rgba(255,255,255,0.025)',
                          color: 'var(--gs-text-secondary)',
                          padding: '8px 10px',
                          cursor: 'pointer',
                          lineHeight: 1.65,
                        }}
                      >
                        <Tag color={'blue'}>第 {hit.locator.pageNum || index + 1} 页</Tag>
                        {resultsAreVector ? (
                          <Tag color="cyan">相似度 {Number(hit.score || 0).toFixed(3)}</Tag>
                        ) : null}
                        {hit.locator.translationSource ? <Tag color="gold">译文</Tag> : null}
                        {highlightSnippet(hit.snippet, resultsAreVector ? [] : highlightTerms)}
                      </button>
                      ))}
                    </Space>
                  ) : null}
                  {group.totalHits > previewHits.length ? (
                    <button
                      type="button"
                      data-search-doc-hits-toggle="true"
                      onClick={(event) => handleToggleDocumentHits(event, group)}
                      style={{
                        width: '100%',
                        marginTop: 8,
                        border: `1px solid ${expandedHitDocId === group.docId ? 'rgba(196,149,106,0.28)' : 'rgba(255,255,255,0.08)'}`,
                        borderRadius: expandedHitDocId === group.docId ? '6px 6px 0 0' : 6,
                        background: expandedHitDocId === group.docId ? 'rgba(8,6,4,0.42)' : 'rgba(196,149,106,0.055)',
                        color: expandedHitDocId === group.docId ? '#ffd8a8' : 'var(--gs-text-secondary)',
                        padding: '8px 10px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                        {isExpanded ? <DownOutlined /> : <RightOutlined />}
                        {isExpanded ? '收起全部命中' : '查看全部命中'}
                      </span>
                      <span style={{ color: 'rgba(255,216,168,0.72)', fontSize: 12 }}>
                        {isExpanded ? `每页 ${SEARCH_DOCUMENT_HIT_PAGE_SIZE} 条完整命中` : `已显示 ${previewHits.length} 条，展开后显示完整目录`}
                      </span>
                    </button>
                  ) : null}
                  {renderDocumentHitDirectory(group, highlightTerms)}
                </Card>
              )
            }}
          />
          {showGroupedPagination ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
              <Pagination
                current={groupedPage}
                pageSize={SEARCH_PAGE_SIZE}
                total={groupedResponse.totalDocuments}
                showSizeChanger={false}
                onChange={handleSearchPageChange}
              />
            </div>
          ) : null}
        </>
      ) : results.length > 0 ? (
        <List
          dataSource={results}
          rowKey={(item: FlatSearchResult) => `${item.doc_id}-${item.page_num}-${item.occurrence_index ?? item.rank ?? stripSnippetMarkers(String(item.snippet || '')).slice(0, 24)}`}
          renderItem={(item: FlatSearchResult) => {
            const inputHighlightKeywords = searchMode === 'ai'
              ? uniqueStrings([...aiHighlightKeywords, ...getKeywordCandidates(inputValue)])
              : searchMode === 'vector'
                ? uniqueStrings([inputValue, item.matched_query || ''].filter(Boolean))
                : getKeywordCandidates(inputValue)
            const baseHighlightKeywords = inputHighlightKeywords
            const hitTerms = getResultHitTerms(item, baseHighlightKeywords)
            const highlightTerms = inputHighlightKeywords
            const jumpKeyword = getJumpKeyword(item, inputValue, hitTerms)
            const activeKeyword = (keyword || inputValue || item.locator?.queryTerm || jumpKeyword).trim()
            const focusedHit = buildSearchHitFromFlatResult(item, activeKeyword, jumpKeyword)
            const exactLegacyLocator = focusedHit?.stableLocator?.precision === 'exact' ? item.locator : undefined
            const isVectorOpen = activeResultMode === 'vector' || resultsAreVector || searchMode === 'vector'
            return (
              <Card
                size={'small'}
                hoverable
                style={{ marginBottom: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
                onClick={() => {
                  persistCurrentSearchReturnState()
                  if (isVectorOpen && focusedHit) {
                    onSelectDoc?.({
                      docId: item.doc_id,
                      pageIndex: getStableLocatorPageIndex(focusedHit),
                      keyword: activeKeyword,
                      sourceId: 'vector-search',
                      stableLocator: focusedHit?.stableLocator,
                      searchSession: buildVectorDocumentSearchSession(activeKeyword, [focusedHit], focusedHit),
                    })
                    return
                  }
                  onSelectDoc?.({
                    docId: item.doc_id,
                    pageIndex: getStableLocatorPageIndex(focusedHit),
                    keyword: activeKeyword,
                    excerpt: stripSnippetMarkers(String(item.snippet || '')).slice(0, 120),
                    sourceId: item.hit_field || 'search',
                    locator: exactLegacyLocator,
                    stableLocator: focusedHit?.stableLocator,
                    searchSession: buildFocusedSearchSession(activeKeyword, exactLegacyLocator ? focusedHit : undefined),
                  })
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <Text strong style={{ color: 'var(--gs-text-primary)', fontSize: 15 }}>
                        {highlightSnippet(item.doc_title || 'Untitled', highlightTerms)}
                      </Text>
                      {item.doc_author ? <Text style={{ color: 'var(--gs-text-secondary)' }}>{item.doc_author}</Text> : null}
                      {item.is_favorite ? <StarOutlined style={{ color: '#faad14' }} /> : null}
                    </div>
                    <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <Tag color={'blue'}>第 {item.page_num} 页</Tag>
                      {item.doc_type ? <Tag>{item.doc_type}</Tag> : null}
                      {item.read_status ? (
                        <Tag color={item.read_status === 'read' ? 'success' : item.read_status === 'reading' ? 'processing' : 'default'}>
                          {item.read_status === 'read' ? '已读' : item.read_status === 'reading' ? '在读' : '未读'}
                        </Tag>
                      ) : null}
                      {item.hit_field === 'semantic' ? <Tag color={'purple'}>语义重排</Tag> : null}
                      {item.hit_field === 'ai_search' ? <Tag color={'purple'}>AI 检索</Tag> : null}
                      {item.hit_field === 'vector' ? <Tag color={'cyan'}>向量 · 相似度 {Number(item.relevance_score ?? item.rank ?? 0).toFixed(3)}</Tag> : null}
                      {hitTerms.map((term) => <Tag key={`hit-${item.doc_id}-${item.page_num}-${term}`} color={'gold'}>命中：{term}</Tag>)}
                    </div>
                    <div style={{ color: 'var(--gs-text-secondary)', fontSize: 13, lineHeight: 1.65 }}>
                      {highlightSnippet(item.snippet || '', highlightTerms)}
                    </div>
                    {item.tag_names ? (
                      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {getVisibleTags(String(item.tag_names).split('|'), item.doc_type).map((tagName: string) => (
                          <Tag key={tagName}>{tagName}</Tag>
                        ))}
                      </div>
                    ) : null}
                    <div style={{ marginTop: 10 }}>
                      <Button size={'small'} icon={<SaveOutlined />} onClick={(event) => void handleSaveSearchExcerpt(event, item)}>
                        保存为摘录
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            )
          }}
        />
      ) : keyword ? (
        <Empty description={`没有找到与“${keyword}”相关的结果`} />
      ) : (
        <Empty description={'输入关键词开始检索'} image={<FileTextOutlined style={{ fontSize: 64, opacity: 0.15 }} />} />
      )}
    </div>
  )
}

