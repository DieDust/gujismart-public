import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Card, Empty, Input, List, Modal, Pagination, Select, Space, Spin, Switch, Tag, Typography, message, type InputRef } from 'antd'
import { BulbOutlined, DeleteOutlined, DownOutlined, FileTextOutlined, RightOutlined, RobotOutlined, SaveOutlined, SearchOutlined, StarOutlined } from '@ant-design/icons'
import { useSearchStore, type SearchFilters } from '../stores/useSearchStore'
import { hasShortcutBlockingOverlay, isEditableShortcutTarget, loadShortcutSettings, SHORTCUTS_CHANGED_EVENT, shortcutMatches, type ShortcutMap } from '../utils/shortcuts'
import { getErrorMessage } from '@shared/errors'
import { resolveDocumentCitation } from '../utils/citations'
import type {
  CitationStyle,
  CitationTemplate,
  DocumentListItem,
  Folder,
  LibraryAiOpenPayload,
  OpenDocumentTarget,
  SavedSearch,
  SearchDocumentGroup,
  SearchDocumentHitPage,
  SearchExportFormat,
  SearchExportPreviewResult,
  SearchGroupedResponse,
  SearchHit,
  SearchHitLocator,
  SearchOptions,
  SearchResult as FlatSearchResult,
  SearchSessionState,
  Tag as SharedTag,
} from '@shared/types'

const { Text, Title } = Typography

type SearchMode = 'fulltext' | 'ai'
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
const DEFAULT_SEARCH_GROUP_LIMIT = 120
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
  return compactFilterOptions(filters) as SearchFilters
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

function parseSavedSearchPayload(entry: SavedSearch): { keyword: string; mode: SearchMode; filters: SearchFilters; sort: SearchSort; contextMode: ContextMode } {
  try {
    const parsed = typeof entry.filters === 'string'
      ? JSON.parse(entry.filters || '{}') as unknown
      : entry.filters
    const raw = isRecord(parsed) ? parsed : {}
    const filterPayload = isRecord(raw.filters) ? raw.filters : raw
    return {
      keyword: typeof raw.keyword === 'string' ? raw.keyword.trim() : '',
      mode: raw.mode === 'ai' ? 'ai' : 'fulltext',
      filters: compactSearchFilters(filterPayload),
      sort: isSearchSort(raw.sort) ? raw.sort : 'relevance',
      contextMode: isContextMode(raw.contextMode) ? raw.contextMode : 'standard',
    }
  } catch {
    return {
      keyword: '',
      mode: 'fulltext',
      filters: {},
      sort: 'relevance',
      contextMode: 'standard',
    }
  }
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

function getReliableLocatorPageIndex(locator: SearchHitLocator | null | undefined): number | undefined {
  const rawValue = locator?.pageIndex
  if (rawValue === null || rawValue === undefined) return undefined
  const value = Number(rawValue)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
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
    snippet: String(item.snippet || ''),
    score: Number(item.rank || 0),
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
  const [searchSort, setSearchSort] = useState<SearchSort>('relevance')
  const [contextMode, setContextMode] = useState<ContextMode>('standard')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('txt')
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
  const [searchPage, setSearchPage] = useState(groupedResponse?.page || 1)
  const [expandedHitDocId, setExpandedHitDocId] = useState('')
  const [documentHitPages, setDocumentHitPages] = useState<Record<string, SearchDocumentHitPageState>>({})
  const [shortcuts, setShortcuts] = useState<ShortcutMap | null>(null)
  const searchInputRef = useRef<InputRef>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pendingScrollRestoreRef = useRef<PendingSearchScrollRestore | null>(null)
  const returnStateRestoredRef = useRef(false)

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
    options: { paged?: boolean; page?: number; resultMode?: 'preview' | 'all' } = {},
  ) => ({
    ...compactFilterOptions(overrideFilters),
    limit: DEFAULT_SEARCH_GROUP_LIMIT,
    sort: searchSort,
    contextMode,
    resultMode: options.resultMode || 'preview' as const,
    ...(options.paged ? { page: options.page || 1, pageSize: SEARCH_PAGE_SIZE } : {}),
  })

  const buildSearchSignature = (
    activeKeyword = inputValue,
    activeFilters = filters,
    activeMode: SearchMode = searchMode,
    activeSort: SearchSort = searchSort,
    activeContextMode: ContextMode = contextMode,
  ) => JSON.stringify({
    keyword: String(activeKeyword || '').trim(),
    mode: activeMode,
    filters: compactFilterOptions(activeFilters),
    sort: activeSort,
    contextMode: activeContextMode,
  })

  const pendingSearchSignature = useMemo(
    () => buildSearchSignature(inputValue, filters, searchMode, searchSort, contextMode),
    [inputValue, filters, searchMode, searchSort, contextMode],
  )
  const hasSearchSnapshot = !!groupedResponse || results.length > 0
  const searchConditionsChanged = hasSearchSnapshot && !!executedSearchSignature && pendingSearchSignature !== executedSearchSignature

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
    const searchSignature = executedSearchSignature || buildSearchSignature(keyword || inputValue, filters, searchMode, searchSort, contextMode)
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
  ) => {
    const entry: SearchHistoryEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      keyword: activeKeyword,
      mode,
      filters: compactSearchFilters(filterSnapshot),
      results: resultSnapshot.slice(0, 80),
      totalHits: groupedSnapshot?.totalHits ?? resultSnapshot.length,
      totalDocuments: groupedSnapshot?.totalDocuments ?? uniqueStrings(resultSnapshot.map((item) => item.doc_id || '')).length,
      aiSearchState: aiSnapshot,
      groupedResponse: groupedSnapshot,
      createdAt: new Date().toISOString(),
    }
    updateSearchHistory((previous) => {
      const deduped = previous.filter((item) => !(item.keyword === entry.keyword && item.mode === entry.mode && JSON.stringify(item.filters) === JSON.stringify(entry.filters)))
      return [entry, ...deduped]
    })
  }

  const loadFilterOptions = async () => {
    try {
      const [docs, tags, folders] = await Promise.all([
        window.api.listDocuments({ limit: 1000 }),
        window.api.listTags(),
        window.api.listFolders(),
      ])
      setFilterDocuments(docs)
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

  const loadExportPreview = async (citationStyleIdOverride?: string) => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      return
    }
    setExportPreviewLoading(true)
    try {
      const payload = await window.api.previewSearchExportExcerpts(activeKeyword, {
        ...buildSearchOptions(),
        limit: 1000,
        format: exportFormat,
        citationMode,
        citationStyleId: citationMode === 'auto' ? citationStyleIdOverride || selectedCitationStyleId : undefined,
        citationTemplateId: citationMode === 'template' ? selectedCitationTemplateId : undefined,
      })
      setExportPreview(payload)
    } catch (error) {
      console.error(error)
      setExportPreview(null)
    } finally {
      setExportPreviewLoading(false)
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
      setExportPreview(null)
      setExportModalOpen(true)
      window.setTimeout(() => void loadExportPreview(defaultStyleId), 0)
    })()
  }

  const handleSearch = async (
    overrideKeyword?: string,
    overrideFilters = filters,
    overrideMode: SearchMode = searchMode,
    overridePage = 1,
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
        const readerCountedGrouped = await applyViewerHitCounts(grouped, activeKeyword, searchSort)
        setAiSearchState(nextAiState)
        setResults(nextResults)
        setGroupedResponse(readerCountedGrouped)
        setExecutedSearchSignature(buildSearchSignature(activeKeyword, overrideFilters, 'ai', searchSort, contextMode))
        persistHistoryEntry(activeKeyword, 'ai', overrideFilters, nextResults, nextAiState, readerCountedGrouped)
      } else {
        const grouped = await window.api.querySearchV2(activeKeyword, buildSearchOptions(overrideFilters, { paged: true, page: overridePage }))
        const readerCountedGrouped = await applyViewerHitCounts(grouped, activeKeyword, searchSort)
        const nextResults = flattenGroupedResults(readerCountedGrouped, 'fulltext').slice(0, 360)
        setGroupedResponse(readerCountedGrouped)
        setAiSearchState(null)
        setResults(nextResults)
        setExecutedSearchSignature(buildSearchSignature(activeKeyword, overrideFilters, 'fulltext', searchSort, contextMode))
        persistHistoryEntry(activeKeyword, 'fulltext', overrideFilters, nextResults, null, readerCountedGrouped)
      }
    } catch (error) {
      console.error(error)
      message.error('检索失败')
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
    if (!exportModalOpen) return
    void loadExportPreview()
  }, [exportModalOpen, exportFormat, citationMode, selectedCitationStyleId, selectedCitationTemplateId, searchSort, contextMode, filterSignature])

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
    setInputValue(entry.keyword)
    setKeyword(entry.keyword)
    setSearchMode(entry.mode)
    setSearchPage(entry.groupedResponse?.page || 1)
    setExpandedHitDocId('')
    setDocumentHitPages({})
    clearSearchReturnState()
    replaceFilters(entry.filters)
    setAiSearchState(entry.aiSearchState)
    const restoredGrouped = entry.groupedResponse || (entry.results?.length ? groupFlatResults(entry.results, entry.keyword, entry.aiSearchState?.warnings || []) : null)
    setGroupedResponse(restoredGrouped)
    setResults(entry.results || [])
    setExecutedSearchSignature(buildSearchSignature(entry.keyword, entry.filters, entry.mode, searchSort, contextMode))
    if (restoredGrouped) {
      void applyViewerHitCounts(restoredGrouped, entry.keyword, searchSort).then((readerCountedGrouped) => {
        setGroupedResponse(readerCountedGrouped)
      })
    }
    message.success('已恢复历史检索')
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
          filters: compactFilterOptions(filters),
          sort: searchSort,
          contextMode,
          cache: groupedResponse
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
      const restoredMode = savedPayload?.mode || payload.mode
      const restoredFilters = compactSearchFilters(savedPayload?.filters || payload.filters)
      const restoredSort = savedPayload?.sort || payload.sort
      const restoredContextMode = savedPayload?.contextMode || payload.contextMode
      const restoredGrouped = savedPayload?.grouped || null
      const restoredResults = Array.isArray(savedPayload?.results) ? savedPayload.results : []
      setInputValue(restoredKeyword)
      setKeyword(restoredKeyword)
      setSearchMode(restoredMode)
      setSearchSort(restoredSort)
      setContextMode(restoredContextMode)
      replaceFilters(restoredFilters)
      setAiSearchState(null)
      setGroupedResponse(restoredGrouped)
      setResults(restoredResults)
      setSearchPage(restoredGrouped?.page || 1)
      setExpandedHitDocId('')
      setDocumentHitPages({})
      clearSearchReturnState()
      setExecutedSearchSignature(buildSearchSignature(restoredKeyword, restoredFilters, restoredMode, restoredSort, restoredContextMode))
      await loadSavedSearches()
      message.success(savedPayload?.cacheHit ? '已从缓存恢复检索结果' : '文献库已变化，已重新检索并刷新缓存')
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
      await window.api.createResearchNote({
        doc_id: item.doc_id,
        page_num: item.page_num || null,
        excerpt,
        note: inputValue ? `来自检索：${inputValue}` : '来自检索结果',
        source_type: 'search',
        kind: 'quote',
        locator: item.locator || null,
        citation_text: citationText,
        source_id: JSON.stringify({
          sourceType: 'search',
          locator: item.locator || null,
          citation: citationText || null,
          page_num: item.page_num || null,
          pageNum: item.page_num || null,
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
    setExportingExcerpts(true)
    try {
      const activeCitationStyleId = citationMode === 'auto'
        ? selectedCitationStyleId || await loadCitationTemplates(true)
        : undefined
      const payload = await window.api.exportSearchExcerpts(activeKeyword, {
        ...buildSearchOptions(),
        limit: 1000,
        format: exportFormat,
        citationMode,
        citationStyleId: activeCitationStyleId,
        citationTemplateId: citationMode === 'template' ? selectedCitationTemplateId : undefined,
      })
      if (!payload?.canceled) {
        setExportModalOpen(false)
        message.success(`已导出 ${payload.exportableParagraphs ?? payload.totalHits} 个完整段落，跳过 ${payload.skippedHits ?? 0} 条无法还原的命中`)
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
      const payload = await window.api.saveSearchExcerpts(activeKeyword, {
        ...buildSearchOptions(),
        limit: 1000,
      })
      message.success(`已保存 ${payload.savedCount} 条完整摘录，跳过 ${payload.skippedCount} 条重复摘录`)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '批量保存摘录失败'))
    } finally {
      setSavingExcerpts(false)
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
      const payload = await window.api.exportSearchDiagnostics(activeKeyword, {
        ...buildSearchOptions(),
        limit: 1000,
      })
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
    if (!activeKeyword || searchMode === 'ai') return
    if (searchConditionsChanged) {
      message.info('检索条件已变化，请先点击搜索')
      return
    }
    rememberSearchScrollPosition()
    void handleSearch(activeKeyword, filters, 'fulltext', page)
  }

  const openGroupedDocument = (group: SearchDocumentGroup, hit?: SearchHit) => {
    const activeHit = hit || group.hits[0]
    const activeKeyword = (keyword || inputValue || activeHit?.locator.queryTerm || '').trim()
    persistCurrentSearchReturnState()
    onSelectDoc?.({
      docId: group.docId,
      pageIndex: getReliableLocatorPageIndex(activeHit?.locator),
      keyword: activeKeyword || activeHit?.locator.queryTerm || inputValue,
      excerpt: activeHit ? stripSnippetMarkers(activeHit.snippet).slice(0, 120) : undefined,
      sourceId: 'search',
      locator: activeHit?.locator,
      openTranslation: Boolean(activeHit?.locator.translationSource),
      searchSession: buildFocusedSearchSession(activeKeyword || activeHit?.locator.queryTerm || inputValue, activeHit),
    })
  }

  const loadGroupedDocumentHitPage = async (group: SearchDocumentGroup, page = 1) => {
    const activeKeyword = (keyword || inputValue).trim()
    if (!activeKeyword) {
      message.info('请先输入检索词')
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
    if (!state?.payload || state.payload.query !== activeKeyword) {
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
            <Text strong style={{ color: 'var(--gs-text-primary)' }}>本文命中目录</Text>
            <Tag color="gold">{payload?.totalHits ?? group.totalHits} 处</Tag>
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
                  {hit.locator.translationSource ? <Tag color="gold">译文</Tag> : null}
                  <Tag color="default">#{globalIndex + 1}</Tag>
                  {highlightSnippet(hit.snippet, highlightTerms)}
                </button>
              )
            })}
          </Space>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无命中" />
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
  const showGroupedPagination = searchMode === 'fulltext'
    && !!groupedResponse
    && groupedResponse.totalDocuments > SEARCH_PAGE_SIZE
    && !searchConditionsChanged

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
          placeholder="输入关键词、主题或研究问题..."
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
          <Button type={searchMode === 'fulltext' ? 'primary' : 'default'} onClick={() => setSearchMode('fulltext')}>全文检索</Button>
          <Button type={searchMode === 'ai' ? 'primary' : 'default'} onClick={() => setSearchMode('ai')}>AI 检索</Button>
        </Button.Group>
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

      <Modal
        title={'导出命中摘录'}
        open={exportModalOpen}
        onCancel={() => setExportModalOpen(false)}
        onOk={() => void handleExportSearchExcerpts()}
        okText={'导出'}
        cancelText={'取消'}
        confirmLoading={exportingExcerpts}
      >
        <Space direction={'vertical'} size={12} style={{ width: '100%' }}>
          <Text type={'secondary'}>{'导出关键词所在完整自然段，并附带引用、命中词和 locator。'}</Text>
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
          <Card size={'small'} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Space direction={'vertical'} size={10} style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>导出预览</Text>
                <Space size={8} wrap>
                  <Tag color={'blue'}>{exportPreview?.exportableParagraphs ?? 0} 段</Tag>
                  <Tag color={(exportPreview?.skippedHits || 0) > 0 ? 'orange' : 'green'}>跳过 {exportPreview?.skippedHits ?? 0}</Tag>
                  {exportPreview?.exporterVersion ? <Tag>{exportPreview.exporterVersion}</Tag> : null}
                </Space>
              </div>
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
                        <Tag color={item.sourceType === 'page' ? 'green' : 'orange'}>{item.sourceType}</Tag>
                        {item.hitTerms.slice(0, 3).map((term) => <Tag key={term} color={'gold'}>{term}</Tag>)}
                      </Space>
                      <Text style={{ display: 'block', color: 'var(--gs-text-secondary)' }}>
                        {item.paragraph.length > 220 ? `${item.paragraph.slice(0, 220)}...` : item.paragraph}
                      </Text>
                      <Text type={'secondary'} style={{ fontSize: 12 }}>{item.locatorText}</Text>
                    </div>
                  ))}
                </Space>
              ) : (
                <Text type={'secondary'}>{'没有可预览的完整段落。可以先运行诊断导出查看缺失原因。'}</Text>
              )}
            </Space>
          </Card>
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
                <Tag color={payload.mode === 'ai' ? 'gold' : 'blue'}>{payload.mode === 'ai' ? 'AI' : '全文'}</Tag>
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
                <Tag color={entry.mode === 'ai' ? 'gold' : 'blue'}>{entry.mode === 'ai' ? 'AI' : '全文'}</Tag>
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

      <div style={{ marginBottom: 12, color: 'var(--gs-text-secondary)' }}>
        {loading
          ? '正在检索...'
          : groupedResponse
            ? `找到 ${groupedResponse.totalDocuments} 篇文献，${groupedResponse.totalHits} 处命中；第 ${groupedPage}/${groupedTotalPages} 页，每页 ${SEARCH_PAGE_SIZE} 篇；列表仅展示每篇前几条片段，导出会使用完整命中`
            : results.length > 0 ? `找到 ${results.length} 条结果` : ''}
      </div>
      {searchConditionsChanged ? (
        <Alert
          type={'info'}
          showIcon
          message={'检索条件已变化，当前仍显示上一次检索结果；点击搜索后才会按新条件检索。'}
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
                      {searchMode === 'ai' ? <Tag color={'purple'}>AI 检索</Tag> : null}
                      <Tag color={'gold'}>{group.totalHits} 处命中</Tag>
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
                        {hit.locator.translationSource ? <Tag color="gold">译文</Tag> : null}
                        {highlightSnippet(hit.snippet, highlightTerms)}
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
              : getKeywordCandidates(inputValue)
            const baseHighlightKeywords = inputHighlightKeywords
            const hitTerms = getResultHitTerms(item, baseHighlightKeywords)
            const highlightTerms = inputHighlightKeywords
            const jumpKeyword = getJumpKeyword(item, inputValue, hitTerms)
            const activeKeyword = (keyword || inputValue || item.locator?.queryTerm || jumpKeyword).trim()
            const focusedHit = buildSearchHitFromFlatResult(item, activeKeyword, jumpKeyword)
            return (
              <Card
                size={'small'}
                hoverable
                style={{ marginBottom: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
                onClick={() => {
                  persistCurrentSearchReturnState()
                  onSelectDoc?.({
                    docId: item.doc_id,
                    pageIndex: getReliableLocatorPageIndex(item.locator),
                    keyword: activeKeyword,
                    excerpt: stripSnippetMarkers(String(item.snippet || '')).slice(0, 120),
                    sourceId: item.hit_field || 'search',
                    locator: item.locator,
                    searchSession: buildFocusedSearchSession(activeKeyword, focusedHit),
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

