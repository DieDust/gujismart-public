import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react'
import {
  AppstoreOutlined,
  BookOutlined,
  CheckOutlined,
  CheckSquareOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FileSearchOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  ImportOutlined,
  InboxOutlined,
  MoreOutlined,
  ExportOutlined,
  PictureOutlined,
  PlusOutlined,
  ReadOutlined,
  ReloadOutlined,
  RobotOutlined,
  StarFilled,
  StarOutlined,
  TagOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'
import { startTransition } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Layout,
  Modal,
  Popconfirm,
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  message
} from 'antd'
import type { MenuProps } from 'antd'
import { List } from 'react-window'
import { getPdfFileInfo, renderPdfFilePageToImage } from '../utils/pdf'
import { ensurePdfPageImagesForOcr as ensureOcrPageImages } from '../utils/ocrPageImages'
import { useDocumentStore } from '../stores/useDocumentStore'
import { useFolderStore } from '../stores/useFolderStore'
import AiSynthesisModal from '../components/AiSynthesisModal'
import MetadataEditor from '../components/MetadataEditor'
import { hasShortcutBlockingOverlay, isEditableShortcutTarget, loadShortcutSettings, SHORTCUTS_CHANGED_EVENT, shortcutMatches, type ShortcutMap } from '../utils/shortcuts'
import { LIBRARY_RELATIONS_CHANGED_EVENT } from '../utils/libraryEvents'
import { sameStringArray, useDragMultiSelect } from '../utils/dragMultiSelect'
import { toggleSelectionId } from '../utils/interactionKernel'
import { buildOcrActivitySummary } from '../utils/ocrActivitySummary'
import { buildFolderTree, collectFolderDescendantIds, flattenVisibleFolders, isFolderDescendant, type FolderTreeNode } from '../utils/folders'
import { getErrorMessage } from '@shared/errors'
import { matchReauthorizedItems, matchReauthorizedSources, transitionAuthorizationJobs } from '../utils/importQueueReauthorization'
import type { BackgroundTaskProgressEvent, BatchOcrOptions, BookTranslationOptions, DocumentDetail, DocumentExportFormat, DocumentExportOptions, DocumentHealthIssue, DocumentHealthReport, DocumentHealthRow, DocumentListItem, DocumentUpdatePayload, EmbeddingProgressEvent, Folder, ImportDocumentResult, ImportSelection, LibraryAiOpenPayload, LibraryAiTab, LibraryDocumentSearchField, LibraryDocumentSortDirection, LibraryDocumentSortKey, LibraryFilter, LibraryHealthFilterType, LibraryImportQueueJobSnapshotV2, LibraryImportQueueState, LibraryStateCache, ListDocumentOptions, MetadataStatus, OcrEngine, OcrProgressEvent, OpenDocumentTarget, ReadStatus, Tag as SharedTag } from '@shared/types'
import { IMPORT_STATUS_MAP, METADATA_STATUS_MAP, OCR_STATUS_MAP, READ_STATUS_MAP } from '@shared/types'
import { HISTORY_DOC_TYPE_ICON_MAP, normalizeHistoryDocType } from '@shared/history-citation'
import { DEFAULT_TRANSLATION_STYLE } from '@shared/translation-cache'

const { Sider, Content } = Layout

const LIBRARY_SIDEBAR_LAYOUT_KEY = 'gujismart.library.sidebarLayout.v1'
const LIBRARY_SORT_STORAGE_KEY = 'gujismart.library.sort.v1'
const LIBRARY_PAGE_SIZE_STORAGE_KEY = 'gujismart.library.pageSize.v1'
const LIBRARY_IMPORT_QUEUE_STORAGE_KEY = 'gujismart.library.importQueue.v1'
const DEFAULT_LIBRARY_PAGE_SIZE = 10
const LIBRARY_PAGE_SIZE_OPTIONS = [10, 50, 100] as const
const LIST_ROW_MIN_HEIGHT = 96
const LIST_ROW_MAX_HEIGHT = 188
const DEFAULT_IMPORT_BATCH_SIZE = 5
const MAX_IMPORT_BATCH_SIZE = 20
const IMPORT_LIST_REFRESH_BATCHES = 4
const LARGE_PDF_PREVIEW_DEFER_PAGE_COUNT = 1000
const LARGE_PDF_PREVIEW_IDLE_DELAY_MS = 30_000
const AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS = 60_000
const PDF_PREVIEW_LIST_REFRESH_BATCH_SIZE = 10
const PDF_PREVIEW_THUMBNAIL_SCALE = 0.9
const MAX_EAGER_PDF_PREVIEW_PER_BATCH = 8
const BULK_IMPORT_PREVIEW_DEFER_FILE_COUNT = 30
const VIRTUAL_LIST_MIN_DOCUMENTS = 8
const GRID_CARD_INITIAL_RENDER_COUNT = 72
const GRID_CARD_RENDER_BATCH_SIZE = 48
const IMPORT_LIST_REFRESH_DEBOUNCE_MS = 350
const UNFILED_FOLDER_ID = '__gujismart_unfiled__'
const UNFILED_FOLDER_NAME = '未分类'
const FOLDER_DRAG_MIME = 'application/x-gujismart-folder-id'

type TagSemanticKind = 'manual' | 'docType' | 'responsibility' | 'carrier' | 'publication' | 'subject' | 'other'
type StatusMeta = { text: string; color: string }
type TagPickerMode = 'single' | 'batch'
type LibrarySortValue = 'default' | `${Exclude<LibraryDocumentSortKey, 'default'>}:${LibraryDocumentSortDirection}`
type LibraryPageSize = typeof LIBRARY_PAGE_SIZE_OPTIONS[number]
type FolderDropPosition = 'inside' | 'before' | 'after'

const LIBRARY_SORT_OPTIONS: Array<{ value: LibrarySortValue; label: string }> = [
  { value: 'default', label: '默认排序' },
  { value: 'title:asc', label: '题名 A-Z' },
  { value: 'title:desc', label: '题名 Z-A' },
  { value: 'createdAt:desc', label: '导入时间 新-旧' },
  { value: 'createdAt:asc', label: '导入时间 旧-新' },
  { value: 'updatedAt:desc', label: '更新时间 新-旧' },
  { value: 'updatedAt:asc', label: '更新时间 旧-新' },
  { value: 'pageCount:desc', label: '页数 多-少' },
  { value: 'pageCount:asc', label: '页数 少-多' },
  { value: 'publicationYear:asc', label: '文献年代 早-晚' },
  { value: 'publicationYear:desc', label: '文献年代 晚-早' },
  { value: 'lastOpened:desc', label: '最后打开 新-旧' },
  { value: 'lastOpened:asc', label: '最后打开 旧-新' },
]
const DEFAULT_LIBRARY_SEARCH_FIELDS: LibraryDocumentSearchField[] = ['title', 'author', 'folder', 'tag']
const LIBRARY_SEARCH_FIELD_OPTIONS: Array<{ value: LibraryDocumentSearchField; label: string }> = [
  { value: 'title', label: '标题' },
  { value: 'author', label: '作者' },
  { value: 'folder', label: '文件夹' },
  { value: 'tag', label: '标签' },
]
const OCR_STATUS_UI_FLUSH_INTERVAL_MS = 300
const BACKGROUND_SEARCH_INDEX_MESSAGE_KEY = 'background-search-index'
const BACKGROUND_HEALTH_REPORT_MESSAGE_KEY = 'background-health-report'
const BACKGROUND_OCR_FINALIZE_MESSAGE_KEY = 'background-ocr-finalize'
const BACKGROUND_STARTUP_RECOVERY_MESSAGE_KEY = 'background-startup-recovery'
const BACKGROUND_EMBEDDING_MESSAGE_KEY = 'background-embedding-index'
const HEALTH_REPORT_REFRESH_DEBOUNCE_MS = 800
const BASE_DATA_REFRESH_DEBOUNCE_MS = 600
const SMART_COUNTS_REFRESH_DEBOUNCE_MS = 800
const BASE_DATA_BUSY_RETRY_DELAYS_MS = [800, 1600, 3200]
const LIBRARY_LIST_REQUEST_TIMEOUT_MS = 90_000
const LIBRARY_LIST_BUSY_RETRY_DELAYS_MS = [800, 2000, 4000, 8000]

type SmartViewCountKey =
  | 'all'
  | 'missingMetadata'
  | 'unrecognized'
  | 'suspiciousTitle'
  | 'unknownType'
  | 'favorite'
  | 'unread'
  | 'proofed'
  | 'unproofed'
  | 'metadataPending'
  | 'unstored'
  | 'vectorized'

const EMPTY_SMART_VIEW_COUNTS: Record<SmartViewCountKey, number> = {
  all: 0,
  missingMetadata: 0,
  unrecognized: 0,
  suspiciousTitle: 0,
  unknownType: 0,
  favorite: 0,
  unread: 0,
  proofed: 0,
  unproofed: 0,
  metadataPending: 0,
  unstored: 0,
  vectorized: 0,
}

interface LibraryWarmCache {
  scopeKey: string
  documents: DocumentItem[]
  folders: Folder[]
  tags: TagItem[]
  smartViewCounts: Record<SmartViewCountKey, number>
  healthReport: DocumentHealthReport | null
  documentTotal: number
  unfiledDocumentTotal: number
  listOffset: number
  listHasMore: boolean
}

let libraryWarmCache: LibraryWarmCache | null = null

function getFallbackLibraryWarmCache(scopeKey: string): LibraryWarmCache {
  return {
    scopeKey,
    documents: [],
    folders: [],
    tags: [],
    smartViewCounts: { ...EMPTY_SMART_VIEW_COUNTS },
    healthReport: null,
    documentTotal: 0,
    unfiledDocumentTotal: 0,
    listOffset: 0,
    listHasMore: false,
  }
}

function patchLibraryWarmCache(scopeKey: string, patch: Partial<Omit<LibraryWarmCache, 'scopeKey'>>): void {
  const base = libraryWarmCache?.scopeKey === scopeKey
    ? libraryWarmCache
    : getFallbackLibraryWarmCache(scopeKey)
  libraryWarmCache = { ...base, ...patch, scopeKey }
}

function applyLibraryStateCacheToFolders(folders: Folder[], cache?: LibraryStateCache | null): Folder[] {
  if (!cache || cache.dirty) return folders
  return folders.map((folder) => ({
    ...folder,
    document_count: Number(cache.folderDocumentCounts[folder.id] ?? folder.document_count ?? 0),
  }))
}

function applyLibraryStateCacheToTags(tags: TagItem[], cache?: LibraryStateCache | null): TagItem[] {
  if (!cache || cache.dirty) return tags
  return tags.map((tag) => ({
    ...tag,
    usage_count: Number(cache.tagDocumentCounts[tag.id] ?? tag.usage_count ?? 0),
  }))
}

function isTransientDatabaseBusyError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return /database is locked|database is busy|sqlite_busy|sqlite_locked|busy timeout/.test(message)
}

function isTransientLibraryLoadError(error: unknown): boolean {
  const errorMessage = getErrorMessage(error, '').toLowerCase()
  return isTransientDatabaseBusyError(error)
    || /文献列表加载超时|request timed out|ipc.*timeout|temporarily unavailable/.test(errorMessage)
}

function waitForLibraryRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs))
}

function withLibraryRequestTimeout<T>(promise: Promise<T>, timeoutMs = LIBRARY_LIST_REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: number | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error('文献列表加载超时，主进程可能无响应。请重启软件后再试。'))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) window.clearTimeout(timer)
  })
}

function parseLibrarySortValue(value: LibrarySortValue): Pick<ListDocumentOptions, 'sortKey' | 'sortDirection'> {
  if (value === 'default') return {}
  const [sortKey, sortDirection] = value.split(':') as [Exclude<LibraryDocumentSortKey, 'default'>, LibraryDocumentSortDirection]
  return { sortKey, sortDirection }
}

function isLibrarySortValue(value: unknown): value is LibrarySortValue {
  return LIBRARY_SORT_OPTIONS.some((item) => item.value === value)
}

function getStoredLibrarySort(): LibrarySortValue {
  try {
    const value = window.localStorage.getItem(LIBRARY_SORT_STORAGE_KEY)
    return isLibrarySortValue(value) ? value : 'default'
  } catch {
    return 'default'
  }
}

function normalizeLibraryPageSize(value: unknown): LibraryPageSize {
  const parsed = Math.round(Number(value))
  return LIBRARY_PAGE_SIZE_OPTIONS.includes(parsed as LibraryPageSize)
    ? parsed as LibraryPageSize
    : DEFAULT_LIBRARY_PAGE_SIZE
}

function getStoredLibraryPageSize(): LibraryPageSize {
  try {
    return normalizeLibraryPageSize(window.localStorage.getItem(LIBRARY_PAGE_SIZE_STORAGE_KEY))
  } catch {
    return DEFAULT_LIBRARY_PAGE_SIZE
  }
}

function buildLibraryListScopeKey(input: {
  filter: LibraryFilter
  searchKey: string
  searchFields: LibraryDocumentSearchField[]
  sort: LibrarySortValue
  pageSize: LibraryPageSize
}): string {
  return JSON.stringify({
    filter: input.filter,
    searchKey: input.searchKey.trim(),
    searchFields: input.searchFields,
    sort: input.sort,
    pageSize: input.pageSize,
  })
}

function getLibrarySearchFieldsLabel(fields: LibraryDocumentSearchField[]): string {
  if (fields.length === DEFAULT_LIBRARY_SEARCH_FIELDS.length) return '范围：全部'
  const labels = LIBRARY_SEARCH_FIELD_OPTIONS
    .filter((item) => fields.includes(item.value))
    .map((item) => item.label)
  if (labels.length <= 2) return `范围：${labels.join('、')}`
  return `范围：${labels.length}项`
}

type DocumentItem = DocumentListItem
type DocumentMetadata = Record<string, unknown>
type ImportQueueJob = {
  id: number
  filePaths: string[]
  selectionId: string
  nextCursor: string | null
  selectionDone: boolean
  sourceLabels: string[]
  displayNames?: Map<string, string>
  remainingAuthorizationLabels?: string[]
  authorizationHasUndiscoveredSources?: boolean
  allowedReauthorizationSourceIds?: Set<string>
  directorySourceIds?: Set<string>
  sourceFolderIds?: Map<string, string>
  folderId?: string | null
  folderAssignments?: Map<string, string>
  engine: OcrEngine
}

type PdfPreviewQueueItem = {
  docId: string
  filePath: string
  fileIndex: number
  totalFiles: number
  pageCount?: number
}

type PersistedImportQueueJob = LibraryImportQueueJobSnapshotV2

type ImportBatchQueueResult = {
  result: ImportDocumentResult
  grantId: string
  fileIndex: number
}

type PersistedImportQueueState = LibraryImportQueueState

function getStatusMeta(map: Partial<Record<string, StatusMeta>>, status: unknown): StatusMeta {
  const key = String(status || '')
  return map[key] || { text: key || '未知', color: 'default' }
}

function formatBytes(value?: number): string {
  const size = Number(value || 0)
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let next = size
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024
    index += 1
  }
  return `${next.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size || DEFAULT_IMPORT_BATCH_SIZE))
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize))
  }
  return chunks
}

function filterTagsByKeyword(tags: TagItem[], keyword: string): TagItem[] {
  const trimmed = keyword.trim().toLowerCase()
  if (!trimmed) return tags
  return tags.filter((tag) => tag.name.toLowerCase().includes(trimmed))
}

function getDragDocumentIds(event: DragEvent<HTMLElement>): string[] {
  const raw = event.dataTransfer.getData('application/x-gujismart-document-ids') || event.dataTransfer.getData('text/plain')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '')).filter(Boolean)
    }
  } catch {
    // Fall back to newline/comma separated text payloads.
  }
  return raw.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)
}

function isDocumentDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes('application/x-gujismart-document-ids')
}

function isExternalFileDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes('Files')
}

function isFolderDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(FOLDER_DRAG_MIME)
}

function getDragFolderId(event: DragEvent<HTMLElement>): string {
  return event.dataTransfer.getData(FOLDER_DRAG_MIME).trim()
}

function getFolderDropPosition(event: DragEvent<HTMLElement>): FolderDropPosition {
  const rect = event.currentTarget.getBoundingClientRect()
  const offsetY = event.clientY - rect.top
  if (offsetY < rect.height * 0.25) return 'before'
  if (offsetY > rect.height * 0.75) return 'after'
  return 'inside'
}

function isFolderDropDrag(event: DragEvent<HTMLElement>): boolean {
  return isDocumentDrag(event) || isExternalFileDrag(event) || isFolderDrag(event)
}

type FolderItem = Folder

type TagItem = SharedTag

const FACSIMILE_FONT_SCALE_STORAGE_KEY = 'gujismart.facsimileProof.fontScale'
const FACSIMILE_FONT_SCALE_DEFAULT = 1.1
const FACSIMILE_FONT_SCALE_MIN = 0.5
const FACSIMILE_FONT_SCALE_MAX = 1.35

function isOcrEngine(value: unknown): value is OcrEngine {
  return value === 'local_paddle' || value === 'paddle' || value === 'vision_model' || value === 'hybrid'
}

function normalizeVisibleOcrEngine(value: unknown): OcrEngine {
  return value === 'paddle' || value === 'vision_model' ? value : 'paddle'
}

function needsOcrWork(doc: DocumentItem, engine?: OcrEngine): boolean {
  if (isDocumentOcrTextComplete(doc)) return false
  if (doc.import_status === 'error' || doc.ocr_status === 'error') return true
  if (doc.ocr_status !== 'completed') return true
  if ((engine === 'local_paddle' || engine === 'vision_model' || engine === 'hybrid') && getEffectivePageCount(doc) > Number(doc.image_page_count || 0)) return true
  return false
}

function shouldShowRetryAction(doc: DocumentItem): boolean {
  if (isDocumentOcrTextComplete(doc)) return false
  if (doc.import_status === 'error' || doc.ocr_status === 'error') return true
  return doc.import_status === 'stored'
    && doc.ocr_status === 'pending'
    && getEffectivePageCount(doc) > 0
}

function getRetryActionLabel(doc: DocumentItem): string {
  return doc.import_status === 'error' || doc.ocr_status === 'error' ? '重试处理' : '继续 OCR'
}

function getEffectivePageCount(doc: Pick<DocumentItem, 'page_count' | 'actual_page_count'>): number {
  return Math.max(Number(doc.page_count || 0), Number(doc.actual_page_count || 0))
}

function isDocumentOcrTextComplete(doc: Pick<DocumentItem, 'page_count' | 'actual_page_count' | 'text_page_count' | 'ocr_completed_page_count'>): boolean {
  const pageCount = getEffectivePageCount(doc)
  if (pageCount <= 0) return false
  const completedPages = Number(doc.ocr_completed_page_count || 0)
  const textPages = Number(doc.text_page_count || 0)
  return completedPages >= pageCount || textPages >= pageCount
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

interface LibraryViewProps {
  onSelectDoc?: (target: OpenDocumentTarget) => void
  initialFilter?: LibraryFilter
  initialFocusSection?: 'tags' | 'folders' | 'smart'
  importRequest?: number
  droppedImportRequest?: { id: number; selection: ImportSelection; folderId?: string | null } | null
  onDroppedImportHandled?: (requestId: number) => void
  onOpenLibraryAi?: (payload?: LibraryAiOpenPayload) => void
}

interface SidebarLayoutState {
  width: number
  heights: { smart: number; folder: number; tag: number }
  collapsed: { smart: boolean; folder: boolean; tag: boolean }
}

interface DragSourceItem {
  path: string
  isDirectory: boolean
}

function isLibraryMarqueeBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true
  return !!target.closest([
    '[data-library-document-card="true"]',
    '[data-library-selection-ignore="true"]',
    'button',
    'input',
    'textarea',
    'select',
    'a',
    '[contenteditable="true"]',
    '.ant-select',
    '.ant-segmented',
    '.ant-slider',
    '.ant-checkbox-wrapper',
    '.ant-dropdown',
    '.ant-popover',
    '.ant-modal',
  ].join(','))
}

function isLibraryDocumentActionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest([
    '[data-library-document-action="true"]',
    '[data-library-selection-ignore="true"]',
    'button',
    'input',
    'textarea',
    'select',
    'a',
    '[role="button"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '.ant-dropdown',
    '.ant-dropdown-menu',
    '.ant-popover',
    '.ant-modal',
    '.ant-select-dropdown',
    '.ant-tag',
  ].join(','))
}

function stopLibraryDocumentActionPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation()
}

const ALLOWED_HEALTH_ISSUE_TYPES = new Set([
  'missing_author',
  'missing_year',
  'missing_identifier',
  'missing_publisher',
  'missing_source',
  'suspicious_title',
  'unknown_type',
  'zero_page',
  'missing_metadata',
  'title_cleanup',
])

const HEALTH_SEVERITY_SCORE: Record<DocumentHealthIssue['severity'], number> = {
  high: 5,
  medium: 3,
  low: 1,
}

interface OcrProgressInfo {
  docId: string
  status: string
  progress: number
  phase?: OcrProgressEvent['phase']
  message?: string
  completedPages?: number
  totalPages?: number
  pageNum?: number
  aiStatus?: OcrProgressEvent['aiStatus']
  errorMessage?: string
  canceled?: boolean
  updatedAt: number
}

interface BookTranslationProgressInfo {
  jobId?: string
  docId: string
  status: string
  progress: number
  completedPages?: number
  failedPages?: number
  cachedPages?: number
  stalePages?: number
  translatedPages?: number
  skippedPages?: number
  totalPages?: number
  pageNum?: number
  outputPath?: string
  message?: string
  errorMessage?: string
  updatedAt: number
}

interface EmbeddingProgressInfo {
  docId: string
  status: string
  progress: number
  message?: string
  embeddedCount?: number
  segmentCount?: number
  errorMessage?: string
  updatedAt: number
}

const OCR_AI_TOAST_TIMEOUT_MS = 125_000
const OCR_ACTIVITY_MESSAGE_KEY = 'ocr-activity'
type StopPropagationEvent = Pick<MouseEvent, 'stopPropagation'>

function isImmediateOcrProgressEvent(data: OcrProgressEvent): boolean {
  return Boolean(
    data.canceled
    || data.status === 'completed'
    || data.status === 'error'
    || data.status === 'canceled'
    || data.status === 'pending'
    || data.phase === 'completed'
    || data.phase === 'error'
    || data.phase === 'canceled'
    || data.aiStatus === 'completed'
    || data.aiStatus === 'error'
  )
}

function isActiveOcrProgressEvent(data: Pick<OcrProgressEvent, 'status' | 'phase' | 'aiStatus'>): boolean {
  return data.status === 'processing'
    || data.phase === 'ocr'
    || data.phase === 'saving'
    || data.aiStatus === 'processing'
}

function getFiniteProgressValue(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function mergeMonotonicOcrProgress(
  previous: Pick<OcrProgressInfo, 'completedPages' | 'totalPages' | 'progress'> | OcrProgressEvent | undefined,
  incoming: OcrProgressEvent,
): OcrProgressEvent {
  if (!previous || !isActiveOcrProgressEvent(incoming)) return incoming

  const next: OcrProgressEvent = { ...incoming }
  const previousCompleted = getFiniteProgressValue(previous.completedPages)
  const incomingCompleted = getFiniteProgressValue(incoming.completedPages)
  const previousProgress = getFiniteProgressValue(previous.progress)
  const incomingProgress = getFiniteProgressValue(incoming.progress)
  const previousTotal = getFiniteProgressValue(previous.totalPages)
  const incomingTotal = getFiniteProgressValue(incoming.totalPages)

  if (previousCompleted !== null || incomingCompleted !== null) {
    next.completedPages = Math.max(previousCompleted || 0, incomingCompleted || 0)
  }
  if (previousTotal !== null || incomingTotal !== null) {
    next.totalPages = Math.max(previousTotal || 0, incomingTotal || 0)
  }
  next.progress = Math.max(previousProgress || 0, incomingProgress || 0)

  return next
}

function buildDocumentPatchForOcrProgress(data: OcrProgressEvent): Partial<DocumentItem> {
  const patch: Partial<DocumentItem> = { ocr_status: data.status }

  if (data.phase === 'ai' && data.aiStatus === 'completed') {
    patch.metadata_status = 'auto'
    patch.ocr_status = 'completed'
    patch.import_status = 'processed'
    patch.error_message = null
    return patch
  }

  if (data.canceled || data.phase === 'canceled' || data.status === 'canceled') {
    patch.ocr_status = 'pending'
    patch.import_status = 'stored'
    patch.error_message = data.errorMessage || 'OCR 已取消'
    return patch
  }

  if (data.status === 'queued') {
    patch.import_status = 'processing'
    patch.error_message = null
  }
  if (data.status === 'processing') {
    patch.import_status = 'processing'
    patch.error_message = data.errorMessage || null
  }
  if (data.status === 'completed') {
    patch.import_status = 'processed'
    patch.error_message = data.errorMessage || null
  }
  if (data.status === 'error') {
    patch.import_status = 'error'
    patch.error_message = data.errorMessage || '处理失败，未返回具体原因'
  }
  if (data.status === 'pending') {
    patch.import_status = 'stored'
    patch.error_message = data.errorMessage || null
  }

  return patch
}

interface DocumentCardContext {
  viewMode: 'list' | 'grid'
  batchMode: boolean
  selectedIds: string[]
  selectedIdSet: Set<string>
  folders: FolderItem[]
  tags: TagItem[]
  sortedSidebarTags: TagItem[]
  ocrProgressByDoc: Record<string, OcrProgressInfo>
  bookTranslationProgressByDoc: Record<string, BookTranslationProgressInfo>
  embeddingProgressByDoc: Record<string, EmbeddingProgressInfo>
  taggingDocId: string | null
  taggingChecked: string[]
  handleRowClick: (docId: string, event?: MouseEvent<HTMLElement>) => void
  handleDocumentOpen: (docId: string) => void
  handleDocumentContextMenu: (docId: string) => void
  getDocumentContextMenuItems: (docId: string, singleItems: MenuProps['items']) => MenuProps['items']
  handleDocumentContextMenuClick: (docId: string, singleHandler: MenuProps['onClick']) => MenuProps['onClick']
  openMetadataEditor: (docId: string) => Promise<void>
  applyLibraryFilter: (filter: LibraryFilter) => Promise<void>
  toggleTagFilter: (tagId: string) => Promise<void>
  handleRetryDocument: (doc: DocumentItem) => Promise<void>
  handleToggleFavorite: (doc: DocumentItem) => Promise<void>
  handleSetReadStatus: (docId: string, readStatus: ReadStatus) => Promise<void>
  handleSetRating: (docId: string, rating: number | null) => Promise<void>
  handleTaggingChange: (docId: string, nextChecked: string[]) => Promise<void>
  handleForceRerunDocument: (doc: DocumentItem, engine: OcrEngine) => Promise<void>
  handleCancelOcr: (docId: string, event?: MouseEvent<HTMLElement>) => Promise<void>
  handleQuickAddTagToDocument: (docId: string, tagName: string) => Promise<void>
  openDocumentTagModal: (docId: string) => void
  handleAddToFolder: (docId: string, folderId: string) => Promise<void>
  handleRemoveFromFolder: (docId: string, folderId: string) => Promise<void>
  getDragDocIds: (docId: string) => string[]
  handleDocumentDragStart: (event: DragEvent<HTMLElement>, docId: string) => void
  handleBatchMenu: MenuProps['onClick']
  handleDelete: (event: StopPropagationEvent, docId: string) => Promise<void>
  handleCleanupPdfAssets: (doc: DocumentItem) => Promise<void>
  handleRestorePdfAssets: (doc: DocumentItem) => Promise<void>
  handleAiExtractForDoc: (docId: string) => Promise<void>
  handleTranslateBook: (doc: DocumentItem, options?: BookTranslationOptions) => Promise<void>
  setTaggingDocId: (docId: string | null) => void
  setTaggingChecked: (ids: string[]) => void
}

const DOC_TYPE_ICON_MAP: Record<string, string> = {
  ...HISTORY_DOC_TYPE_ICON_MAP,
  古籍: '古',
  论文: '论',
  图书: '书',
  档案: '档',
  手稿: '稿',
  期刊: '刊',
  报告: '报',
  unknown: '文'
}

const TAG_KIND_META: Record<TagSemanticKind, { order: number; color: string; label: string }> = {
  manual: { order: 0, color: '#faad14', label: '自建标签' },
  docType: { order: 1, color: '#1890ff', label: '文献类型' },
  responsibility: { order: 2, color: '#f5222d', label: '责任者' },
  carrier: { order: 3, color: '#2f54eb', label: '载体与出处' },
  publication: { order: 4, color: '#722ed1', label: '出版与版本' },
  subject: { order: 5, color: '#52c41a', label: '主题关键词' },
  other: { order: 6, color: '#13c2c2', label: '其他标签' }
}

function getDocIcon(docType: string): string {
  const normalized = normalizeHistoryDocType(docType)
  return DOC_TYPE_ICON_MAP[normalized] || DOC_TYPE_ICON_MAP[docType] || DOC_TYPE_ICON_MAP.unknown
}

function splitPipe(value?: string | null): string[] {
  return value ? value.split('|').map((item) => item.trim()).filter(Boolean) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDocMetadata(doc: Pick<DocumentItem, 'metadata'>): DocumentMetadata {
  if (!doc.metadata) return {}
  try {
    const parsed: unknown = JSON.parse(doc.metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getPdfAssetState(doc: DocumentItem): 'available' | 'text_only' | 'unknown' {
  const verifiedState = String(doc.pdf_asset_state || '').trim()
  if (verifiedState === 'available' || verifiedState === 'text_only' || verifiedState === 'unknown') return verifiedState
  const metadata = parseDocMetadata(doc)
  const state = String(metadata.pdf_asset_state || '').trim()
  if (state === 'available' || state === 'text_only') return state
  if (metadata.pdf_sha256 || metadata.pdf_size_bytes || metadata.pdf_page_count) return 'text_only'
  return 'unknown'
}

function getMetadataValue(metadata: DocumentMetadata, keys: string[]): unknown {
  for (const key of keys) {
    const value = metadata[key]
    if (Array.isArray(value) && value.some((item) => String(item ?? '').trim())) return value
    if (String(value ?? '').trim()) return value
  }
  return null
}

function hasMissingCoreMetadata(doc: DocumentItem): boolean {
  const metadata = parseDocMetadata(doc)
  const missingAuthor = !String(doc.author || '').trim() && !getMetadataValue(metadata, ['author', 'authors', 'creator', 'editor', 'translator'])
  const missingYear = !getMetadataValue(metadata, ['publication_year', 'year', 'publish_year', 'date', 'issue_date', 'publication_time'])
  const missingIdentifier = !getMetadataValue(metadata, ['doi', 'DOI', 'isbn', 'ISBN', 'issn', 'identifier'])
  const missingPublisher = !getMetadataValue(metadata, ['publisher', 'press', 'publisher_name'])
  const missingSource = !String(doc.source || '').trim() && !getMetadataValue(metadata, ['source', 'journal', 'newspaper', 'book_title', 'collection', 'series', 'container_title'])
  return missingAuthor || missingYear || missingIdentifier || missingPublisher || missingSource
}

function hasSuspiciousImportTitle(doc: DocumentItem): boolean {
  const title = String(doc.title || '').trim()
  return !title || /^(pdf合并|扫描|未命名|document|scan|image|new document)/i.test(title)
}

function hasUnknownDocumentType(doc: DocumentItem): boolean {
  return doc.doc_type === '其他' || doc.doc_type === 'unknown'
}

function hasZeroPages(doc: DocumentItem): boolean {
  return getEffectivePageCount(doc) <= 0
}

function needsTitleCleanup(doc: DocumentItem): boolean {
  return hasSuspiciousImportTitle(doc) || hasUnknownDocumentType(doc)
}

function getHealthIssuesForDocument(doc: DocumentItem): DocumentHealthIssue[] {
  const issues: DocumentHealthIssue[] = []
  if (hasMissingCoreMetadata(doc)) {
    issues.push({ type: 'missing_metadata', severity: 'medium', label: '缺元数据', detail: '作者、年份、来源、出版社或标识符仍需补齐。' })
  }
  if (needsTitleCleanup(doc)) {
    issues.push({ type: 'title_cleanup', severity: 'medium', label: '待整理', detail: '题名或类型需要清理。' })
  }
  if (hasZeroPages(doc)) {
    issues.push({ type: 'zero_page', severity: 'high', label: '零页', detail: '这篇文献页数为 0，通常是导入或 OCR 初始化失败留下的空记录。' })
  }
  return issues
}

function sanitizeHealthReport(report: DocumentHealthReport): DocumentHealthReport {
  const rows = (report.rows || []).map((row) => {
    const issues = (row.issues || []).filter((issue) => ALLOWED_HEALTH_ISSUE_TYPES.has(issue.type))
    return {
      ...row,
      issues,
      risk_score: issues.reduce((sum, issue) => sum + HEALTH_SEVERITY_SCORE[issue.severity], 0),
    }
  })

  return {
    ...report,
    rows,
    stats: {
      ...report.stats,
      missingAuthor: rows.filter((row) => row.issues.some((issue) => issue.type === 'missing_author')).length,
      missingYear: rows.filter((row) => row.issues.some((issue) => issue.type === 'missing_year')).length,
      missingIdentifier: rows.filter((row) => row.issues.some((issue) => issue.type === 'missing_identifier')).length,
      missingPublisher: rows.filter((row) => row.issues.some((issue) => issue.type === 'missing_publisher')).length,
      missingSource: rows.filter((row) => row.issues.some((issue) => issue.type === 'missing_source')).length,
      suspiciousTitle: rows.filter((row) => row.issues.some((issue) => issue.type === 'suspicious_title')).length,
      unknownType: rows.filter((row) => row.issues.some((issue) => issue.type === 'unknown_type')).length,
      zeroPage: rows.filter((row) => row.issues.some((issue) => issue.type === 'zero_page')).length,
    },
  }
}

function getPdfAssetTagMeta(doc: DocumentItem): { text: string; color: string; title: string } {
  const state = getPdfAssetState(doc)
  if (state === 'available') {
    return { text: '有原文', color: 'green', title: '软件目录中保留了 PDF 原文件或可用原图' }
  }
  if (state === 'text_only') {
    return { text: '仅文本', color: 'orange', title: '本地 PDF 原文件或页图不可读，可从原件仓库或手动选择 PDF 补回' }
  }
  return { text: '原文未知', color: 'default', title: '未记录 PDF 原文件状态' }
}

function getEmbeddingStatusTagMeta(doc: DocumentItem): { text: string; color: string; title: string } | null {
  const status = String(doc.embedding_status || '').trim()
  const chunks = Number(doc.embedding_chunk_count || 0)
  if (status === 'ready' || chunks > 0) {
    return {
      text: '已向量化',
      color: 'cyan',
      title: chunks > 0 ? `向量索引就绪（${chunks} 段）` : '向量索引就绪，可用于向量库检索',
    }
  }
  if (status === 'processing') {
    return { text: '向量化中', color: 'processing', title: '正在写入向量索引' }
  }
  if (status === 'queued') {
    return { text: '向量排队', color: 'gold', title: '已排队等待向量化' }
  }
  if (status === 'error') {
    return { text: '向量失败', color: 'error', title: '向量化失败，可在设置 → 向量索引重试' }
  }
  return null
}

function renderEmbeddingStatusTag(doc: DocumentItem) {
  const meta = getEmbeddingStatusTagMeta(doc)
  if (!meta) return null
  return (
    <Tooltip title={meta.title}>
      <Tag color={meta.color} style={{ margin: 0 }}>{meta.text}</Tag>
    </Tooltip>
  )
}

function renderPdfAssetTag(doc: DocumentItem) {
  const meta = getPdfAssetTagMeta(doc)
  return (
    <Tooltip title={meta.title}>
      <Tag color={meta.color} style={{ margin: 0 }}>{meta.text}</Tag>
    </Tooltip>
  )
}

function normalizeColor(color?: string | null): string {
  return (color || '').trim().toLowerCase()
}

function truncateLabel(value: string, maxLength = 18): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

function getTooltipTitle(value: string, maxLength: number): string | undefined {
  return value.length > maxLength ? value : undefined
}

function repairKnownMetadataNoise(value: string): string {
  return value
    .replace(/^獲拳(?=[\u3400-\u9fff])/u, '')
    .trim()
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
  const repaired = repairKnownMetadataNoise(raw)
  if (!repaired || looksLikeMetadataMojibake(repaired)) return null
  return repaired
}

function getDisplayTagText(value?: string | null): string | null {
  return getDisplayMetadataText(value, { hideOther: true })
}

function getReadStatusIcon(status: ReadStatus) {
  if (status === 'unread') return <BookOutlined />
  if (status === 'reading') return <ReadOutlined />
  return <CheckOutlined />
}

function renderRatingStars(rating: number) {
  return `${'★'.repeat(rating)}${'☆'.repeat(Math.max(0, 5 - rating))}`
}

function getOcrBatchProgressMessage(engineLabel: string, batchIndex: number, totalBatches: number, batchSize: number, documentConcurrency: number): string {
  const concurrencySuffix = documentConcurrency < batchSize
    ? `，当前并发 ${documentConcurrency} 篇，其余自动排队`
    : ''
  return `正在用${engineLabel}后台识别第 ${batchIndex}/${totalBatches} 批（每批 ${batchSize} 篇${concurrencySuffix}）…`
}

function getOcrProgressText(info: OcrProgressInfo): string {
  if (info.canceled || info.phase === 'canceled' || info.status === 'canceled') {
    return info.message || 'OCR 已取消，可稍后继续识别'
  }

  if (info.phase === 'queued' || info.status === 'queued') {
    return info.message || 'OCR 已排队：等待前面文献让出识别通道（大 PDF 通常串行，不是卡死）'
  }

  if (info.phase === 'ai') {
    if (info.aiStatus === 'completed') return 'AI 元数据提取完成'
    if (info.aiStatus === 'error') return info.errorMessage ? `AI 元数据提取失败：${info.errorMessage}` : 'AI 元数据提取失败'
    return 'OCR 完成，正在 AI 提取元数据'
  }

  if (info.phase === 'saving') return info.message || '正在保存 OCR 结果'
  if (info.message) return info.message
  if (info.completedPages !== undefined && info.totalPages) {
    return `OCR 识别中：${info.completedPages}/${info.totalPages} 页`
  }
  return info.message || 'OCR 识别中'
}

function getOcrProgressPercent(info: OcrProgressInfo): number {
  if (info.completedPages !== undefined && (info.totalPages || 0) > 0) {
    return Math.round((Number(info.completedPages) / Math.max(1, Number(info.totalPages))) * 100)
  }
  if (info.status === 'queued' || info.phase === 'queued') return 0
  return Math.round((Number(info.progress) || 0) * 100)
}

function renderOcrProgress(info?: OcrProgressInfo, onCancel?: (docId: string, event: MouseEvent<HTMLElement>) => void) {
  if (!info) return null
  if (!(info.status === 'queued' || info.phase === 'queued' || shouldShowOcrProgress(info) || info.status === 'processing' || info.phase === 'ocr' || info.phase === 'saving')) {
    return null
  }
  const percent = Math.max(0, Math.min(100, getOcrProgressPercent(info)))
  const barColor = info.status === 'error' || info.aiStatus === 'error'
    ? '#ff4d4f'
    : info.canceled || info.phase === 'canceled' || info.status === 'canceled'
      ? '#8c8c8c'
    : info.phase === 'ai'
      ? '#722ed1'
      : info.status === 'queued' || info.phase === 'queued'
        ? '#faad14'
      : '#1890ff'
  const canCancel = Boolean(onCancel) && (
    info.status === 'queued'
    || info.status === 'processing'
    || info.phase === 'queued'
    || info.phase === 'ocr'
    || info.phase === 'saving'
  )

  return (
    <div
      style={{
        marginTop: 8,
        padding: '7px 8px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.045)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--gs-text-secondary)', fontSize: 12, lineHeight: 1.4 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{getOcrProgressText(info)}</span>
        <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span>{percent}%</span>
          {canCancel ? (
            <Button
              size="small"
              danger
              type="link"
              style={{ height: 18, padding: 0, fontSize: 12, lineHeight: '18px' }}
              onClick={(event) => onCancel?.(info.docId, event)}
            >
              {info.phase === 'saving' ? '停止等待' : '停止上传'}
            </Button>
          ) : null}
        </span>
      </div>
      <div style={{ height: 4, marginTop: 6, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: barColor, transition: 'width 0.2s ease' }} />
      </div>
    </div>
  )
}

function getBookTranslationProgressText(info: BookTranslationProgressInfo): string {
  const stats = [
    info.cachedPages ? `缓存 ${info.cachedPages}` : '',
    info.stalePages ? `失配重译 ${info.stalePages}` : '',
    info.translatedPages ? `新译 ${info.translatedPages}` : '',
    info.skippedPages ? `跳过 ${info.skippedPages}` : '',
    info.failedPages ? `失败 ${info.failedPages}` : '',
  ].filter(Boolean).join(' / ')
  const suffix = stats ? `（${stats}）` : ''
  if (info.status === 'completed') {
    return info.message || (info.outputPath ? `整书翻译完成：${info.outputPath}${suffix}` : `整书翻译完成${suffix}`)
  }
  if (info.status === 'partial') {
    return info.message || `整书翻译部分完成${suffix}`
  }
  if (info.status === 'error') {
    return info.errorMessage ? `整书翻译失败：${info.errorMessage}` : (info.message || '整书翻译失败，下次会从断点继续')
  }
  if (info.completedPages !== undefined && info.totalPages) {
    return info.message || `整书翻译中：${info.completedPages}/${info.totalPages} 页${suffix}`
  }
  return info.message || '准备整书翻译'
}

function getBookTranslationProgressPercent(info: BookTranslationProgressInfo): number {
  if (info.status === 'completed' || info.status === 'partial') return 100
  const progressPercent = Math.round((Number(info.progress) || 0) * 100)
  if (progressPercent > 0) return progressPercent
  const finishedPages = Number(info.completedPages || 0) + Number(info.failedPages || 0)
  if (finishedPages > 0 && (info.totalPages || 0) > 0) {
    return Math.round((finishedPages / Math.max(1, Number(info.totalPages))) * 100)
  }
  return 0
}

function shouldShowBookTranslationProgress(info?: BookTranslationProgressInfo): boolean {
  if (!info) return false
  if (info.status === 'processing' || info.status === 'queued' || info.status === 'started') return true
  const age = Date.now() - Number(info.updatedAt || 0)
  if (info.status === 'completed' && age < 15000) return true
  if (info.status === 'partial' && age < 60000) return true
  if (info.status === 'error' && age < 60000) return true
  return false
}

function shouldShowEmbeddingProgress(info?: EmbeddingProgressInfo): boolean {
  if (!info) return false
  if (info.status === 'processing' || info.status === 'queued') return true
  const age = Date.now() - Number(info.updatedAt || 0)
  if (info.status === 'ready' && age < 12_000) return true
  if (info.status === 'error' && age < 60_000) return true
  if (info.status === 'pending' && age < 30_000) return true
  return false
}

function getEmbeddingProgressText(info: EmbeddingProgressInfo): string {
  if (info.status === 'ready') return info.message || '向量化完成'
  if (info.status === 'error') {
    return info.errorMessage ? `向量化失败：${info.errorMessage}` : (info.message || '向量化失败')
  }
  if (info.status === 'queued') return info.message || '已排队，等待向量化'
  if (info.status === 'pending') return info.message || '等待正文分段就绪后再向量化'
  if (info.embeddedCount !== undefined && info.segmentCount) {
    return info.message || `向量化中：${info.embeddedCount}/${info.segmentCount} 段`
  }
  return info.message || '向量化中'
}

function renderEmbeddingProgress(info?: EmbeddingProgressInfo) {
  if (!info || !shouldShowEmbeddingProgress(info)) return null
  const percent = Math.max(0, Math.min(100, Math.round(Number(info.progress) || 0)))
  const barColor = info.status === 'error'
    ? '#ff4d4f'
    : info.status === 'ready'
      ? '#52c41a'
      : info.status === 'queued' || info.status === 'pending'
        ? '#faad14'
        : '#13c2c2'
  return (
    <div
      style={{
        marginTop: 8,
        padding: '7px 8px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.045)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--gs-text-secondary)', fontSize: 12, lineHeight: 1.4 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{getEmbeddingProgressText(info)}</span>
        <span style={{ flexShrink: 0 }}>{percent}%</span>
      </div>
      <div style={{ height: 4, marginTop: 6, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: barColor, transition: 'width 0.2s ease' }} />
      </div>
    </div>
  )
}

function renderBookTranslationProgress(info?: BookTranslationProgressInfo) {
  if (!info || !shouldShowBookTranslationProgress(info)) return null
  const percent = Math.max(0, Math.min(100, getBookTranslationProgressPercent(info)))
  const barColor = info.status === 'error'
    ? '#ff4d4f'
    : info.status === 'partial'
      ? '#faad14'
      : info.status === 'completed'
        ? '#52c41a'
        : '#13c2c2'

  return (
    <div
      style={{
        marginTop: 8,
        padding: '7px 8px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.045)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--gs-text-secondary)', fontSize: 12, lineHeight: 1.4 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{getBookTranslationProgressText(info)}</span>
        <span style={{ flexShrink: 0 }}>{percent}%</span>
      </div>
      <div style={{ height: 4, marginTop: 6, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: barColor, transition: 'width 0.2s ease' }} />
      </div>
    </div>
  )
}

function isDocumentOcrJobActive(doc: Pick<DocumentItem, 'ocr_status' | 'import_status'>): boolean {
  return doc.ocr_status === 'queued'
    || doc.ocr_status === 'processing'
    || doc.import_status === 'processing'
}

function shouldShowOcrProgress(info?: OcrProgressInfo): boolean {
  if (!info) return false
  if (info.status === 'queued' || info.phase === 'queued') return true
  const isActive = info.status === 'processing' || info.aiStatus === 'processing' || (info.phase === 'saving' && info.status !== 'completed')
  const age = Date.now() - Number(info.updatedAt || 0)
  const isRecentFinal = (
    (info.phase === 'ai' && info.aiStatus === 'completed' && age < 5000)
    || (info.phase === 'ai' && info.aiStatus === 'error' && age < 30000)
    || (info.status === 'error' && age < 30000)
    || ((info.canceled || info.phase === 'canceled' || info.status === 'canceled') && age < 30000)
  )
  return isActive || isRecentFinal
}

function isActiveOcrProgress(info?: OcrProgressInfo): boolean {
  if (!info) return false
  const isFinalStatus = info.status === 'completed' || info.status === 'error' || info.status === 'pending' || info.status === 'canceled' || info.canceled
  return info.status === 'queued'
    || info.status === 'processing'
    || info.phase === 'queued'
    || (info.phase === 'ocr' && !isFinalStatus)
    || info.aiStatus === 'processing'
    || (info.phase === 'saving' && info.status !== 'completed')
}

function isStaleOcrProgressForDocument(info: OcrProgressInfo | undefined, doc: DocumentItem): boolean {
  if (!info) return false
  // Live OCR jobs must keep their progress bar even when page-text heuristics look "complete"
  // (common during force re-run / partial page completion).
  if (isDocumentOcrJobActive(doc)) return false
  if (isDocumentOcrTextComplete(doc)) {
    if (info.aiStatus === 'processing') {
      return doc.metadata_status === 'auto' || doc.metadata_status === 'confirmed'
    }
    return true
  }

  if (info.aiStatus === 'processing') {
    return doc.metadata_status === 'auto' || doc.metadata_status === 'confirmed'
  }

  if (info.status === 'processing' || info.status === 'queued' || (info.phase === 'saving' && info.status !== 'completed')) {
    return true
  }

  const age = Date.now() - Number(info.updatedAt || 0)
  if (info.aiStatus === 'completed' && age >= 5000) return true
  if ((info.aiStatus === 'error' || info.status === 'error') && age >= 30000) return true
  return false
}

function buildFallbackOcrProgressInfo(doc: DocumentItem, previous?: OcrProgressInfo): OcrProgressInfo {
  const queued = doc.ocr_status === 'queued'
  const totalPages = Number(previous?.totalPages || doc.page_count || 0) || undefined
  return {
    docId: doc.id,
    status: queued ? 'queued' : 'processing',
    phase: queued ? 'queued' : (previous?.phase === 'saving' ? 'saving' : 'ocr'),
    progress: Number(previous?.progress || 0),
    completedPages: previous?.completedPages,
    totalPages,
    message: previous?.message || (queued
      ? 'OCR 已排队：等待前面文献让出识别通道'
      : 'OCR 进行中（若刚刷新列表，进度会在下一轮状态推送后更新）'),
    errorMessage: previous?.errorMessage,
    aiStatus: previous?.aiStatus,
    canceled: previous?.canceled,
    updatedAt: previous?.updatedAt || Date.now(),
  }
}

/**
 * Prefer live IPC progress; if missing, reconstruct a bar from document DB status
 * so cards still show progress after list refresh / missed events / pagination.
 */
function resolveOcrProgressInfo(doc: DocumentItem, info?: OcrProgressInfo): OcrProgressInfo | undefined {
  if (info && !isStaleOcrProgressForDocument(info, doc) && shouldShowOcrProgress(info)) {
    return info
  }
  if (isDocumentOcrJobActive(doc)) {
    if (info && !isStaleOcrProgressForDocument(info, doc)) {
      return {
        ...buildFallbackOcrProgressInfo(doc, info),
        ...info,
        status: info.status === 'completed' || info.status === 'error' || info.status === 'canceled'
          ? (doc.ocr_status === 'queued' ? 'queued' : 'processing')
          : info.status,
        updatedAt: info.updatedAt || Date.now(),
      }
    }
    return buildFallbackOcrProgressInfo(doc, info)
  }
  if (info && shouldShowOcrProgress(info) && !isStaleOcrProgressForDocument(info, doc)) {
    return info
  }
  return undefined
}

function shouldShowOcrProgressForDocument(doc: DocumentItem, info?: OcrProgressInfo): boolean {
  return Boolean(resolveOcrProgressInfo(doc, info))
}

function shouldShowDocumentErrorMessage(doc: DocumentItem, info?: OcrProgressInfo): boolean {
  if (!doc.error_message) return false
  if (shouldShowDocumentReviewMessage(doc, info)) return false
  if (isDocumentOcrTextComplete(doc)) return false
  if (isActiveOcrProgress(info)) return false
  return true
}

function shouldShowDocumentReviewMessage(doc: DocumentItem, info?: OcrProgressInfo): boolean {
  if (!doc.error_message) return false
  if (isActiveOcrProgress(info)) return false
  return doc.ocr_status === 'completed' && doc.import_status === 'processed'
}

function renderDocumentHealthTags(doc: DocumentItem) {
  const issues = getHealthIssuesForDocument(doc)
  if (issues.length === 0) return null

  const visibleIssues = issues
    .sort((left, right) => {
      const order = { high: 0, medium: 1, low: 2 }
      return order[left.severity] - order[right.severity]
    })
    .slice(0, 3)

  return visibleIssues.map((issue) => (
    <Tooltip key={`${doc.id}-${issue.type}`} title={issue.detail}>
      <Tag
        color={issue.severity === 'high' ? 'red' : issue.severity === 'medium' ? 'orange' : 'blue'}
        style={{ margin: 0 }}
      >
        {issue.label}
      </Tag>
    </Tooltip>
  ))
}

/** Grouped batch actions — short top level, submenus expand to the right (Ant Design children). */
function buildBatchMenuItems(): MenuProps['items'] {
  return [
    { key: 'import', label: '批量入库', icon: <InboxOutlined /> },
    { key: 'select_all', label: '全选已加载', icon: <CheckSquareOutlined /> },
    { type: 'divider' },
    {
      key: 'group_ocr',
      label: 'OCR 识别',
      icon: <ThunderboltOutlined />,
      children: [
        { key: 'ocr:paddle', label: '批量 OCR · 飞桨' },
        { key: 'ocr:vision_model', label: '批量 OCR · 大模型' },
        { type: 'divider' },
        { key: 'ocr_force:paddle', label: '重新 OCR · 飞桨覆盖' },
        { key: 'ocr_force:vision_model', label: '重新 OCR · 大模型覆盖' },
        { key: 'retry_failed', label: '重试失败文献' },
      ],
    },
    {
      key: 'group_vector',
      label: '向量索引',
      icon: <ThunderboltOutlined />,
      children: [
        { key: 'vectorize', label: '向量化所选文献' },
        { key: 'revectorize', label: '重新向量化所选（当前模型）' },
      ],
    },
    {
      key: 'group_organize',
      label: '整理与 AI',
      icon: <RobotOutlined />,
      children: [
        { key: 'metadata_extract', label: '批量抓取元数据' },
        { key: 'add_tags', label: '批量添加标签' },
        { key: 'add_folder', label: '批量加入文件夹' },
        { key: 'synthesize', label: 'AI 文献综述' },
      ],
    },
    {
      key: 'export',
      label: '批量导出',
      icon: <ExportOutlined />,
      children: [
        { key: 'export:txt', label: '导出为 TXT 纯文本' },
        { key: 'export:markdown', label: '导出为 Markdown' },
        { key: 'export:tei-xml', label: '导出为 TEI-XML' },
        { key: 'export:page-xml', label: '导出为 PAGE XML' },
        { key: 'export:paddle-json', label: '导出为 Paddle JSON' },
        { key: 'export:reading-pdf', label: '批量导出阅读模式 PDF' },
        { key: 'export:layout-pdf', label: '批量导出排版模式 PDF' },
      ],
    },
    { type: 'divider' },
    {
      key: 'group_storage',
      label: '原文与存储',
      icon: <PictureOutlined />,
      children: [
        { key: 'cleanup_pdf_assets', label: '删除所选原文件' },
        { key: 'restore_pdf_assets', label: '补回所选原文' },
      ],
    },
    {
      key: 'group_danger',
      label: '删除',
      icon: <DeleteOutlined />,
      danger: true,
      children: [
        { key: 'delete_selected', label: '删除所选文献', danger: true },
        { key: 'delete_zero_page', label: '清除零页文献', danger: true },
      ],
    },
  ]
}

/** Single-document context / more menu — primary actions first, heavy groups nested. */
function buildDocumentMoreMenuItems(input: {
  doc: DocumentItem
  availableFolders: FolderItem[]
  docFolderIds: string[]
  docFolderNames: string[]
  pdfAssetState: 'available' | 'text_only' | 'unknown'
}): MenuProps['items'] {
  const { doc, availableFolders, docFolderIds, docFolderNames, pdfAssetState } = input
  const readMenuItems: MenuProps['items'] = (Object.keys(READ_STATUS_MAP) as ReadStatus[]).map((status) => ({
    key: status,
    label: READ_STATUS_MAP[status].text,
    icon: getReadStatusIcon(status),
  }))
  const ratingMenuItems: MenuProps['items'] = [
    { key: '0', label: '清除评分' },
    ...[1, 2, 3, 4, 5].map((value) => ({
      key: String(value),
      label: `${'★'.repeat(value)}${'☆'.repeat(5 - value)}`,
    })),
  ]

  return [
    { key: 'open_new_tab', label: '在新标签页打开', icon: <BookOutlined /> },
    { key: 'edit', label: '编辑元数据', icon: <EditOutlined /> },
    { key: 'favorite', label: doc.is_favorite ? '取消星标' : '加入星标', icon: doc.is_favorite ? <StarFilled /> : <StarOutlined /> },
    { type: 'divider' },
    {
      key: 'group_ocr',
      label: 'OCR',
      icon: <ThunderboltOutlined />,
      children: [
        ...(shouldShowRetryAction(doc)
          ? [{ key: 'retry', label: getRetryActionLabel(doc), icon: <ReloadOutlined /> }]
          : []),
        { key: 'rerun_ocr_book:paddle', label: '重新 OCR · 飞桨覆盖' },
        { key: 'rerun_ocr_book:vision_model', label: '重新 OCR · 大模型覆盖' },
      ],
    },
    {
      key: 'group_ai',
      label: 'AI 与翻译',
      icon: <RobotOutlined />,
      children: [
        { key: 'ai_extract', label: 'AI 提取元数据' },
        { type: 'divider' },
        { key: 'translate_book:start:balanced', label: '整书翻译 · 均衡' },
        { key: 'translate_book:start:fast', label: '整书翻译 · 快速' },
        { key: 'translate_book:start:quality', label: '整书翻译 · 高质量' },
        { key: 'translate_book:retry_failed', label: '仅重试失败页' },
        { key: 'translate_book:clear_cache', label: '清除本书翻译缓存', danger: true },
      ],
    },
    {
      key: 'group_organize',
      label: '整理',
      icon: <TagOutlined />,
      children: [
        {
          key: 'read_status',
          label: '阅读状态',
          icon: <ReadOutlined />,
          children: readMenuItems,
        },
        {
          key: 'rating',
          label: '评分',
          icon: <BookOutlined />,
          children: ratingMenuItems,
        },
        { key: 'add_tag', label: '添加标签', icon: <TagOutlined /> },
        {
          key: 'add_to_folder',
          label: '加入文件夹',
          icon: <FolderAddOutlined />,
          children: availableFolders.length > 0
            ? availableFolders.map((item) => ({ key: `folder_${item.id}`, label: item.name }))
            : [{ key: 'folder_none', label: '没有可加入的文件夹', disabled: true }],
        },
        ...(docFolderIds.length > 0
          ? [{
              key: 'remove_from_folder',
              label: '移出文件夹',
              icon: <FolderOpenOutlined />,
              children: docFolderIds.map((folderId, folderIndex) => ({
                key: `remove_folder_${folderId}`,
                label: docFolderNames[folderIndex] || '未命名文件夹',
              })),
            }]
          : []),
      ],
    },
    ...(pdfAssetState === 'available' || pdfAssetState === 'text_only'
      ? [
          { type: 'divider' as const },
          {
            key: 'group_storage',
            label: '原文与缓存',
            icon: <PictureOutlined />,
            children: [
              ...(pdfAssetState === 'available'
                ? [{ key: 'cleanup_pdf_assets', label: '删除原文件/页图缓存', icon: <PictureOutlined /> }]
                : []),
              ...(pdfAssetState === 'text_only'
                ? [{ key: 'restore_pdf_assets', label: '补回原文', icon: <ImportOutlined /> }]
                : []),
            ],
          },
        ]
      : []),
  ]
}

function renderTagSummaryPopover(items: Array<import('react').ReactNode>, overflowLabel: string) {
  if (items.length === 0) return null
  return (
    <Popover
      trigger="click"
      title="更多"
      content={(
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 280 }}>
          {items}
        </div>
      )}
    >
      <Tag style={{ margin: 0, cursor: 'pointer', flexShrink: 0 }}>{overflowLabel}</Tag>
    </Popover>
  )
}

function getTagKind(tag: { color?: string | null; source?: string | null }): TagSemanticKind {
  const source = tag.source || ''
  if (source === 'manual') return 'manual'
  if (source === '_doc_type' || source === 'doc_type') return 'docType'
  if (['author', 'editor', 'translator'].includes(source)) return 'responsibility'
  if (['journal', 'newspaper', 'collection', 'book_title', 'meeting_name', 'university'].includes(source)) return 'carrier'
  if (['publisher', 'publish_place', 'publication_time', 'publication_year', 'issue_date', 'engraving_style', 'dynasty', 'version'].includes(source)) return 'publication'
  if (source === 'keywords') return 'subject'

  const color = normalizeColor(tag.color)
  if (color === normalizeColor(TAG_KIND_META.docType.color)) return 'docType'
  if (color === normalizeColor(TAG_KIND_META.responsibility.color)) return 'responsibility'
  if (color === normalizeColor(TAG_KIND_META.carrier.color)) return 'carrier'
  if (color === normalizeColor(TAG_KIND_META.subject.color)) return 'subject'
  if (color === normalizeColor(TAG_KIND_META.publication.color)) return 'publication'
  return 'other'
}

function getActiveTagIds(filter: LibraryFilter): string[] {
  if (filter.type !== 'tag') return []
  if (filter.tagIds && filter.tagIds.length > 0) return filter.tagIds
  return filter.value ? [filter.value] : []
}

function getLocalSmartFilterPredicate(filter: LibraryFilter): ((doc: DocumentItem) => boolean) | null {
  if (filter.type === 'proofStatus') {
    if (filter.value === 'completed') return (doc) => doc.proof_status === 'completed'
    if (filter.value === 'pending') return (doc) => doc.proof_status !== 'completed'
  }

  if (filter.type === 'metadataPending') {
    return (doc) => doc.metadata_status === 'pending' || doc.metadata_status === 'review'
  }

  if (filter.type === 'ocrIncomplete') {
    return (doc) => doc.ocr_status !== 'completed' || hasZeroPages(doc)
  }

  if (filter.type === 'embeddingReady') {
    return (doc) => String(doc.embedding_status || '') === 'ready' || Number(doc.embedding_chunk_count || 0) > 0
  }

  return null
}

function isSameFilter(left: LibraryFilter, right: LibraryFilter): boolean {
  if (left.type !== right.type) return false
  if ((left.value || '') !== (right.value || '')) return false
  const leftIds = getActiveTagIds(left)
  const rightIds = getActiveTagIds(right)
  if (leftIds.length !== rightIds.length) return false
  return leftIds.every((id, index) => id === rightIds[index])
}

function applySmartFilterDocuments(documents: DocumentItem[], filter: LibraryFilter): DocumentItem[] {
  const predicate = getLocalSmartFilterPredicate(filter)
  return predicate ? documents.filter(predicate) : documents
}

function isHealthFilter(filter: LibraryFilter): filter is LibraryFilter & { type: LibraryHealthFilterType } {
  return filter.type === 'healthMissingMetadata'
    || filter.type === 'healthSuspiciousTitle'
    || filter.type === 'healthUnknownType'
    || filter.type === 'healthTitleCleanup'
}

function getFilterTitle(filter: LibraryFilter, folders: FolderItem[], tags: TagItem[]): string {
  if (filter.type === 'all') return '\u6587\u732e\u7ba1\u7406'
  if (filter.type === 'folder') {
    if (filter.value === UNFILED_FOLDER_ID) return UNFILED_FOLDER_NAME
    return folders.find((item) => item.id === filter.value)?.name || '\u6587\u4ef6\u5939'
  }
  if (filter.type === 'tag') {
    const names = getActiveTagIds(filter)
      .map((id) => tags.find((item) => item.id === id)?.name)
      .filter(Boolean)
    return names.length > 0 ? names.join('\u3001') : '\u6807\u7b7e\u7b5b\u9009'
  }
  if (filter.type === 'favorite') return '\u661f\u6807\u6587\u732e'
  if (filter.type === 'readStatus') return READ_STATUS_MAP[(filter.value as ReadStatus) || 'unread']?.text || '\u9605\u8bfb\u72b6\u6001'
  if (filter.type === 'metadataStatus') return METADATA_STATUS_MAP[(filter.value as MetadataStatus) || 'review']?.text || '\u5143\u6570\u636e\u72b6\u6001'
  if (filter.type === 'ocrIncomplete') return 'OCR 未完成文献'
  if (filter.type === 'ocrStatus') return filter.value === 'pending' ? 'OCR 未完成文献' : getStatusMeta(OCR_STATUS_MAP, filter.value).text
  if (filter.type === 'proofStatus') {
    return filter.value === 'completed' ? '\u5df2\u6821\u5bf9' : '\u672a\u6821\u5bf9'
  }
  if (filter.type === 'metadataPending') return '\u672a\u786e\u8ba4\u5143\u6570\u636e'
  if (filter.type === 'healthMissingMetadata') return '缺元数据'
  if (filter.type === 'healthSuspiciousTitle') return '题名疑似导入名'
  if (filter.type === 'healthUnknownType') return '待分类'
  if (filter.type === 'healthTitleCleanup') return '标题/类型待整理'
  if (filter.type === 'importStatus') return '\u672a\u5165\u5e93\u6587\u732e'
  if (filter.type === 'embeddingReady') return '已向量化'
  if (filter.type === 'docType') return filter.value || '\u6587\u732e\u7c7b\u578b'
  return '\u6587\u732e\u7ba1\u7406'
}

function getFilterChipLabel(filter: LibraryFilter, folders: FolderItem[], tags: TagItem[]): string {
  if (filter.type === 'folder' && filter.value) {
    if (filter.value === UNFILED_FOLDER_ID) return `文件夹 / ${UNFILED_FOLDER_NAME}`
    return `文件夹 / ${folders.find((item) => item.id === filter.value)?.name || '未命名'}`
  }
  if (filter.type === 'tag') {
    const names = getActiveTagIds(filter)
      .map((id) => tags.find((item) => item.id === id)?.name)
      .filter(Boolean)
    return names.length > 0 ? `标签 / ${names.join('、')}` : '标签筛选'
  }
  if (filter.type === 'favorite') return '\u661f\u6807\u6587\u732e'
  if (filter.type === 'readStatus') return `阅读状态 / ${READ_STATUS_MAP[(filter.value as ReadStatus) || 'unread']?.text || '未读'}`
  if (filter.type === 'metadataStatus') return `元数据 / ${METADATA_STATUS_MAP[(filter.value as MetadataStatus) || 'review']?.text || '待确认'}`
  if (filter.type === 'ocrIncomplete') return 'OCR / 未完成'
  if (filter.type === 'ocrStatus') return `OCR / ${filter.value === 'pending' ? '未完成' : getStatusMeta(OCR_STATUS_MAP, filter.value).text}`
  if (filter.type === 'proofStatus') {
    return filter.value === 'completed' ? '\u5df2\u6821\u5bf9' : '\u672a\u6821\u5bf9'
  }
  if (filter.type === 'metadataPending') return '\u672a\u786e\u8ba4\u5143\u6570\u636e'
  if (filter.type === 'healthMissingMetadata') return '健康检查 / 缺元数据'
  if (filter.type === 'healthSuspiciousTitle') return '健康检查 / 题名疑似导入名'
  if (filter.type === 'healthUnknownType') return '健康检查 / 待分类'
  if (filter.type === 'healthTitleCleanup') return '健康检查 / 标题或类型待整理'
  if (filter.type === 'importStatus') return '\u672a\u5165\u5e93\u6587\u732e'
  if (filter.type === 'embeddingReady') return '智能视窗 / 已向量化'
  return ''
}

function sortDocumentTags<T extends { name: string; color?: string | null; source?: string | null }>(tags: T[]): T[] {
  return [...tags].sort((left, right) => {
    const leftKind = getTagKind(left)
    const rightKind = getTagKind(right)
    const orderGap = TAG_KIND_META[leftKind].order - TAG_KIND_META[rightKind].order
    if (orderGap !== 0) return orderGap
    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })
}

function renderSelectableTagList(
  tags: TagItem[],
  checkedIds: string[],
  onToggle: (tagId: string) => void,
  emptyText = '没有找到标签',
) {
  if (tags.length === 0) {
    return <span style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>{emptyText}</span>
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignContent: 'flex-start' }}>
      {tags.map((item) => {
        const checked = checkedIds.includes(item.id)
        return (
          <Tooltip key={item.id} title={getTooltipTitle(item.name, 22)}>
            <Tag
              color={checked ? TAG_KIND_META[getTagKind(item)].color : undefined}
              style={{
                margin: 0,
                cursor: 'pointer',
                opacity: checked ? 1 : 0.72,
                border: checked ? `1px solid ${TAG_KIND_META[getTagKind(item)].color}` : '1px solid rgba(255,255,255,0.16)',
                maxWidth: 220,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis'
              }}
              onClick={() => onToggle(item.id)}
            >
              {checked ? '✓ ' : ''}{truncateLabel(item.name, 22)}
            </Tag>
          </Tooltip>
        )
      })}
    </div>
  )
}

function getDocumentListRowHeight(doc: DocumentItem | undefined, context: DocumentCardContext): number {
  if (!doc) return LIST_ROW_MIN_HEIGHT

  const folderCount = splitPipe(doc.folder_names).length
  const tagCount = splitPipe(doc.tag_names).length
  let height = LIST_ROW_MIN_HEIGHT

  if (folderCount > 0) height += 28
  if (shouldShowDocumentErrorMessage(doc, resolveOcrProgressInfo(doc, context.ocrProgressByDoc[doc.id]))) height += 36
  if (shouldShowDocumentReviewMessage(doc, resolveOcrProgressInfo(doc, context.ocrProgressByDoc[doc.id]))) height += 36
  if (shouldShowOcrProgressForDocument(doc, context.ocrProgressByDoc[doc.id])) height += 48
  if (shouldShowBookTranslationProgress(context.bookTranslationProgressByDoc[doc.id])) height += 48
  if (shouldShowEmbeddingProgress(context.embeddingProgressByDoc[doc.id])) height += 48
  if (tagCount > 0) height += 30

  return Math.min(LIST_ROW_MAX_HEIGHT, Math.max(LIST_ROW_MIN_HEIGHT, height))
}

function DocumentVirtualRow({
  index,
  style,
  ariaAttributes,
  documents,
  context,
}: {
  index: number
  style: CSSProperties
  ariaAttributes: Record<string, unknown>
} & DocumentVirtualRowProps) {
  const doc = documents[index]
  if (!doc) return null

  const isSelected = context.selectedIdSet.has(doc.id)
  const docTagNames = splitPipe(doc.tag_names)
  const docTagColors = splitPipe(doc.tag_colors)
  const docTagIds = splitPipe(doc.tag_ids)
  const docTagSources = splitPipe(doc.tag_sources)
  const docFolderIds = splitPipe(doc.folder_ids)
  const docFolderNames = splitPipe(doc.folder_names)
  const orderedDocTags = sortDocumentTags(docTagNames.map((name, tagIndex) => ({
    id: docTagIds[tagIndex],
    name,
    color: docTagColors[tagIndex],
    source: docTagSources[tagIndex],
  }))).filter((tag) => !!getDisplayTagText(tag.name))
  const visibleTags = orderedDocTags.slice(0, 6)
  const displayAuthor = getDisplayMetadataText(doc.author)
  const displayDynasty = getDisplayMetadataText(doc.dynasty)
  const availableFolders = context.folders.filter((item) => !docFolderIds.includes(item.id))
  const progressInfo = resolveOcrProgressInfo(doc, context.ocrProgressByDoc[doc.id])
  const bookTranslationProgressInfo = context.bookTranslationProgressByDoc[doc.id]
  const pdfAssetState = getPdfAssetState(doc)

  const readMenuItems: MenuProps['items'] = (Object.keys(READ_STATUS_MAP) as ReadStatus[]).map((status) => ({
    key: status,
    label: READ_STATUS_MAP[status].text,
    icon: getReadStatusIcon(status),
  }))
  const ratingMenuItems: MenuProps['items'] = [
    { key: '0', label: '清除评分' },
    ...[1, 2, 3, 4, 5].map((value) => ({ key: String(value), label: `${'★'.repeat(value)}${'☆'.repeat(5 - value)}` })),
  ]
  const moreMenuItems: MenuProps['items'] = buildDocumentMoreMenuItems({
    doc,
    availableFolders,
    docFolderIds,
    docFolderNames,
    pdfAssetState,
  })

  const handleMoreClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation()
    if (key === 'open_new_tab') {
      context.handleDocumentOpen(doc.id)
      return
    }
    if (key === 'edit') {
      void context.openMetadataEditor(doc.id)
      return
    }
    if (key === 'retry') {
      void context.handleRetryDocument(doc)
      return
    }
    if (String(key).startsWith('rerun_ocr_book:')) {
      void context.handleForceRerunDocument(doc, String(key).replace('rerun_ocr_book:', '') as OcrEngine)
      return
    }
    if (key === 'ai_extract') {
      void context.handleAiExtractForDoc(doc.id)
      return
    }
    if (String(key).startsWith('translate_book:start:')) {
      const mode = String(key).replace('translate_book:start:', '') as BookTranslationOptions['mode']
      void context.handleTranslateBook(doc, { style: DEFAULT_TRANSLATION_STYLE, mode })
      return
    }
    if (key === 'translate_book:retry_failed') {
      void context.handleTranslateBook(doc, { style: DEFAULT_TRANSLATION_STYLE, retryFailedOnly: true })
      return
    }
    if (key === 'translate_book:clear_cache') {
      Modal.confirm({
        title: '清除本书翻译缓存',
        content: '会清除这本文献的页面译文缓存。原文和 OCR 结果不会受影响，之后可以重新整书翻译。',
        okText: '清除缓存',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => context.handleTranslateBook(doc, { clearCache: true }),
      })
      return
    }
    if (key === 'favorite') {
      void context.handleToggleFavorite(doc)
      return
    }
    if (key === 'add_tag') {
      context.openDocumentTagModal(doc.id)
      return
    }
    if (key.startsWith('folder_')) {
      void context.handleAddToFolder(doc.id, key.replace('folder_', ''))
      return
    }
    if (key.startsWith('remove_folder_')) {
      void context.handleRemoveFromFolder(doc.id, key.replace('remove_folder_', ''))
      return
    }
    if (key === 'cleanup_pdf_assets') {
      Modal.confirm({
        title: '删除原文件/页图缓存',
        content: '只会删除软件数据目录里的 PDF 副本和页图缓存，不会删除 OCR 文本、检索结果，也不会修改 PDF 原件仓库。以后可从原件仓库补回。',
        okText: '删除原文件',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => context.handleCleanupPdfAssets(doc),
      })
      return
    }
    if (key === 'restore_pdf_assets') {
      void context.handleRestorePdfAssets(doc)
      return
    }
    if (key === '0') {
      void context.handleSetRating(doc.id, null)
      return
    }
    if (/^[1-5]$/.test(key)) {
      void context.handleSetRating(doc.id, Number(key))
    }
  }

  return (
    <div {...ariaAttributes} style={{ ...style, padding: '0 24px 4px', boxSizing: 'border-box' }}>
      <Dropdown
        menu={{
          items: context.getDocumentContextMenuItems(doc.id, moreMenuItems),
          onClick: context.handleDocumentContextMenuClick(doc.id, handleMoreClick),
        }}
        trigger={['contextMenu']}
      >
        <div
          draggable
          onDragStart={(event) => context.handleDocumentDragStart(event, doc.id)}
          data-library-document-card="true"
          data-document-id={doc.id}
          onMouseDown={(event) => {
            if (event.button === 2) context.handleDocumentContextMenu(doc.id)
          }}
          onContextMenu={() => context.handleDocumentContextMenu(doc.id)}
          onClick={(event) => context.handleRowClick(doc.id, event)}
          onDoubleClick={() => context.handleDocumentOpen(doc.id)}
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            padding: '10px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            borderLeft: isSelected ? '3px solid #1890ff' : '3px solid transparent',
            background: isSelected ? 'rgba(24, 144, 255, 0.15)' : 'transparent',
            cursor: 'pointer',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minHeight: 0 }}>
            {context.batchMode ? (
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                border: isSelected ? '2px solid #1890ff' : '2px solid rgba(255,255,255,0.3)',
                background: isSelected ? '#1890ff' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: 2,
                flexShrink: 0,
              }}
            >
              {isSelected ? <span style={{ color: '#fff', fontSize: 11 }}>✓</span> : null}
            </div>
            ) : null}
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: 'rgba(255,255,255,0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {getDocIcon(doc.doc_type)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--gs-text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {doc.title || '未命名文献'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 8px', marginTop: 6, color: 'var(--gs-text-secondary)', fontSize: 12 }}>
              {displayAuthor ? <span>{displayAuthor}</span> : null}
              {displayDynasty ? <span>{displayDynasty}</span> : null}
              <span>{getEffectivePageCount(doc)} 页</span>
              <Tag color={getStatusMeta(OCR_STATUS_MAP, doc.ocr_status).color} style={{ margin: 0 }}>{getStatusMeta(OCR_STATUS_MAP, doc.ocr_status).text}</Tag>
              <Tag color={getStatusMeta(IMPORT_STATUS_MAP, doc.import_status).color} style={{ margin: 0 }}>{getStatusMeta(IMPORT_STATUS_MAP, doc.import_status).text}</Tag>
              {renderPdfAssetTag(doc)}
              {renderEmbeddingStatusTag(doc)}
              {renderDocumentHealthTags(doc)}
              <Tag color={READ_STATUS_MAP[doc.read_status]?.color || 'default'} style={{ margin: 0 }}>{READ_STATUS_MAP[doc.read_status]?.text || doc.read_status}</Tag>
              <Tag color={METADATA_STATUS_MAP[doc.metadata_status]?.color || 'default'} style={{ margin: 0 }}>{METADATA_STATUS_MAP[doc.metadata_status]?.text || doc.metadata_status}</Tag>
              {typeof doc.rating === 'number' && doc.rating > 0 ? <Tag color="gold" style={{ margin: 0 }}>{renderRatingStars(doc.rating)}</Tag> : null}
            </div>
            {docFolderNames.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {docFolderNames.map((name, folderIndex) => (
                  <Tag
                    key={`${doc.id}-virtual-folder-${docFolderIds[folderIndex] || folderIndex}`}
                    style={{ margin: 0, cursor: 'pointer' }}
                    onClick={(event) => {
                      event.stopPropagation()
                      void context.applyLibraryFilter({ type: 'folder', value: docFolderIds[folderIndex] })
                    }}
                  >
                    {name}
                  </Tag>
                ))}
              </div>
            ) : null}
            {shouldShowDocumentErrorMessage(doc, progressInfo) ? (
              <div
                style={{
                  marginTop: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'rgba(255, 77, 79, 0.10)',
                  border: '1px solid rgba(255, 77, 79, 0.22)',
                  color: '#ffccc7',
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                失败原因：{doc.error_message}
              </div>
            ) : null}
            {shouldShowDocumentReviewMessage(doc, progressInfo) ? (
              <div
                style={{
                  marginTop: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'rgba(250, 173, 20, 0.12)',
                  border: '1px solid rgba(250, 173, 20, 0.28)',
                  color: '#ffd666',
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                页面待复核：{doc.error_message}
              </div>
            ) : null}
            {progressInfo ? renderOcrProgress(progressInfo, context.handleCancelOcr) : null}
            {renderBookTranslationProgress(bookTranslationProgressInfo)}
            {renderEmbeddingProgress(context.embeddingProgressByDoc[doc.id])}
            {visibleTags.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {visibleTags.map((tagItem) => {
                  const tagText = getDisplayTagText(tagItem.name) || tagItem.name
                  return (
                  <Tooltip key={`${doc.id}-virtual-tag-${tagItem.id || tagItem.name}`} title={getTooltipTitle(tagText, 22)}>
                    <Tag
                      color={TAG_KIND_META[getTagKind(tagItem)].color}
                      style={{ margin: 0, cursor: 'pointer', maxWidth: 220, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (tagItem.id) void context.toggleTagFilter(tagItem.id)
                      }}
                    >
                      {truncateLabel(tagText, 22)}
                    </Tag>
                  </Tooltip>
                  )
                })}
              </div>
            ) : null}
          </div>
            {!context.batchMode ? (
              <div
                data-library-document-action="true"
                style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                onPointerDown={stopLibraryDocumentActionPropagation}
                onMouseDown={stopLibraryDocumentActionPropagation}
                onClick={stopLibraryDocumentActionPropagation}
              >
              {shouldShowRetryAction(doc) ? (
                <Tooltip title={getRetryActionLabel(doc)}>
                  <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => void context.handleRetryDocument(doc)} />
                </Tooltip>
              ) : null}
              <Tooltip title={doc.is_favorite ? '取消星标' : '加入星标'}>
                <Button
                  type="text"
                  size="small"
                  icon={doc.is_favorite ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                  onClick={() => void context.handleToggleFavorite(doc)}
                />
              </Tooltip>
              <Dropdown menu={{ items: readMenuItems, onClick: ({ key }) => void context.handleSetReadStatus(doc.id, key as ReadStatus) }}>
                <Button type="text" size="small" icon={getReadStatusIcon(doc.read_status)} />
              </Dropdown>
              <Dropdown menu={{ items: moreMenuItems, onClick: handleMoreClick }}>
                <Button type="text" size="small" icon={<MoreOutlined />} />
              </Dropdown>
              <Popconfirm
                title="删除文献"
                description="确定要删除这篇文献吗？后台删除提交后不会阻塞界面。"
                onConfirm={(event) => void context.handleDelete(event ?? { stopPropagation() {} }, doc.id)}
                onCancel={(event) => event?.stopPropagation()}
                okText="删除"
                cancelText="取消"
              >
                <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={(event) => event.stopPropagation()} />
              </Popconfirm>
              </div>
            ) : null}
          </div>
        </div>
      </Dropdown>
    </div>
  )
}

type DocumentVirtualRowProps = {
  documents: DocumentItem[]
  context: DocumentCardContext
}

export default function LibraryView({
  onSelectDoc,
  initialFilter = { type: 'all' },
  initialFocusSection,
  importRequest = 0,
  droppedImportRequest,
  onDroppedImportHandled,
  onOpenLibraryAi
}: LibraryViewProps): JSX.Element {
  const layoutRef = useRef<HTMLDivElement | null>(null)
  const libraryContentRef = useRef<HTMLDivElement | null>(null)
  const {
    documents,
    selectedIds,
    loading,
    filter,
    searchKey,
    setDocuments,
    setSelectedIds,
    selectAll,
    clearSelection,
    setLoading,
    setFilter,
    setSearchKey,
    updateDocumentInList,
    updateDocumentsInList,
    removeDocumentFromList,
    removeDocumentsFromList
  } = useDocumentStore()
  const { folders, setFolders } = useFolderStore()

  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')
  const [gridRenderLimit, setGridRenderLimit] = useState(GRID_CARD_INITIAL_RENDER_COUNT)
  const [tags, setTags] = useState<TagItem[]>([])
  const [batchMode, setBatchMode] = useState(false)
  const [showSynthesisModal, setShowSynthesisModal] = useState(false)
  const [metadataEditorVisible, setMetadataEditorVisible] = useState(false)
  const [editingDoc, setEditingDoc] = useState<Pick<DocumentDetail, 'id' | 'title' | 'author' | 'doc_type' | 'metadata'> | null>(null)
  const [taggingDocId, setTaggingDocId] = useState<string | null>(null)
  const [taggingChecked, setTaggingChecked] = useState<string[]>([])
  const [newFolderName, setNewFolderName] = useState('')
  const [newTagName, setNewTagName] = useState('')
  const [folderCollapsedIds, setFolderCollapsedIds] = useState<string[]>([])
  const [folderEditorOpen, setFolderEditorOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<FolderItem | null>(null)
  const [folderEditorName, setFolderEditorName] = useState('')
  const [folderEditorParentId, setFolderEditorParentId] = useState<string | null>(null)
  const [batchTagModalOpen, setBatchTagModalOpen] = useState(false)
  const [batchTagCheckedIds, setBatchTagCheckedIds] = useState<string[]>([])
  const [batchNewTagName, setBatchNewTagName] = useState('')
  const [documentTagModalDocId, setDocumentTagModalDocId] = useState<string | null>(null)
  const [documentTagNameInput, setDocumentTagNameInput] = useState('')
  const [documentTagCheckedIds, setDocumentTagCheckedIds] = useState<string[]>([])
  const [documentTagSearch, setDocumentTagSearch] = useState('')
  const [batchFolderModalOpen, setBatchFolderModalOpen] = useState(false)
  const [batchFolderTargetId, setBatchFolderTargetId] = useState<string | null>(null)
  const [folderDropTarget, setFolderDropTarget] = useState<{ id: string; position: FolderDropPosition } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(250)
  const [sectionHeights, setSectionHeights] = useState({ smart: 24, folder: 30, tag: 46 })
  const [collapsedSections, setCollapsedSections] = useState({ smart: false, folder: false, tag: false })
  const [dragActive, setDragActive] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgressText, setImportProgressText] = useState('')
  const [importQueueLength, setImportQueueLength] = useState(0)
  const [authorizationRequiredJobs, setAuthorizationRequiredJobs] = useState<LibraryImportQueueJobSnapshotV2[]>([])
  const [importOcrEngine, setImportOcrEngine] = useState<OcrEngine>('paddle')
  const [libraryInitialLoadDone, setLibraryInitialLoadDone] = useState(false)
  const [libraryListLoadError, setLibraryListLoadError] = useState<string | null>(null)
  const [documentTotal, setDocumentTotal] = useState(0)
  const [unfiledDocumentTotal, setUnfiledDocumentTotal] = useState(0)
  const [smartViewCounts, setSmartViewCounts] = useState<Record<SmartViewCountKey, number>>(EMPTY_SMART_VIEW_COUNTS)
  const [listLoadingMore, setListLoadingMore] = useState(false)
  const [listHasMore, setListHasMore] = useState(false)
  const [searchInput, setSearchInput] = useState(searchKey)
  const [librarySearchFields, setLibrarySearchFields] = useState<LibraryDocumentSearchField[]>(DEFAULT_LIBRARY_SEARCH_FIELDS)
  const [librarySort, setLibrarySort] = useState<LibrarySortValue>(() => getStoredLibrarySort())
  const [libraryPageSize, setLibraryPageSize] = useState<LibraryPageSize>(() => getStoredLibraryPageSize())
  const [ocrProgressByDoc, setOcrProgressByDoc] = useState<Record<string, OcrProgressInfo>>({})
  const [bookTranslationProgressByDoc, setBookTranslationProgressByDoc] = useState<Record<string, BookTranslationProgressInfo>>({})
  const [embeddingProgressByDoc, setEmbeddingProgressByDoc] = useState<Record<string, EmbeddingProgressInfo>>({})
  const [healthReport, setHealthReport] = useState<DocumentHealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthPanelCollapsed, setHealthPanelCollapsed] = useState(true)
  const [shortcuts, setShortcuts] = useState<ShortcutMap | null>(null)
  const lastImportRequestRef = useRef(importRequest)
  const lastDroppedImportRequestRef = useRef(0)
  const lastInitialFilterRef = useRef<LibraryFilter | null>(null)
  const listRequestSeqRef = useRef(0)
  const visibleListLoadingRequestRef = useRef(0)
  const listOffsetRef = useRef(0)
  const listLoadingMoreRef = useRef(false)
  const listHasMoreRef = useRef(false)
  const libraryListScopeRef = useRef('')
  const metadataRefreshTimerRef = useRef<number | null>(null)
  const baseDataRefreshTimerRef = useRef<number | null>(null)
  const smartCountsRefreshTimerRef = useRef<number | null>(null)
  const baseDataBusyRetryCountRef = useRef(0)
  const documentsRef = useRef<DocumentItem[]>([])
  const hasHydratedWarmCacheRef = useRef(false)
  const activeOcrToastKeysRef = useRef<Set<string>>(new Set())
  const ocrProgressByDocRef = useRef<Record<string, OcrProgressInfo>>({})
  const ocrStatusBufferRef = useRef<Map<string, OcrProgressEvent>>(new Map())
  const ocrStatusFlushTimerRef = useRef<number | null>(null)
  const healthRefreshTimerRef = useRef<number | null>(null)
  const importListRefreshTimerRef = useRef<number | null>(null)
  const importListRefreshBatchCountRef = useRef<Map<number, number>>(new Map())
  const deferredPdfPreviewQueueRef = useRef<PdfPreviewQueueItem[]>([])
  const deferredPdfPreviewTimerRef = useRef<number | null>(null)
  const smartSectionRef = useRef<HTMLDivElement | null>(null)
  const folderSectionRef = useRef<HTMLDivElement | null>(null)
  const tagSectionRef = useRef<HTMLDivElement | null>(null)
  const sectionStackRef = useRef<HTMLDivElement | null>(null)
  const dragCounterRef = useRef(0)
  const importQueueRef = useRef<ImportQueueJob[]>([])
  const importQueueRunningRef = useRef(false)
  const importJobSeqRef = useRef(0)
  const activeImportJobRef = useRef<ImportQueueJob | null>(null)
  const restoredImportQueueRef = useRef(false)
  const authorizationRequiredJobsRef = useRef<LibraryImportQueueJobSnapshotV2[]>([])
  const importQueuePersistenceChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const activeImportFilePathsRef = useRef<Set<string>>(new Set())
  const queuedImportFilePathsRef = useRef<Set<string>>(new Set())
  const lastClickedDocIdRef = useRef<string | null>(null)
  const suppressLibraryClickRef = useRef(false)
  const resizeStateRef = useRef<{
    mode: 'sidebar' | 'smart-folder' | 'folder-tag' | null
    startX: number
    startY: number
    startWidth: number
    startHeights: { smart: number; folder: number; tag: number }
    stackHeight: number
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    startWidth: 250,
    startHeights: { smart: 24, folder: 30, tag: 46 },
    stackHeight: 0
  })

  const currentLibraryScopeKey = useMemo(() => buildLibraryListScopeKey({
    filter,
    searchKey,
    searchFields: librarySearchFields,
    sort: librarySort,
    pageSize: libraryPageSize,
  }), [filter, libraryPageSize, librarySearchFields, librarySort, searchKey])

  useEffect(() => {
    let active = true
    void window.api.getSetting('ocr_default_engine')
      .then((value) => {
        if (active) setImportOcrEngine(normalizeVisibleOcrEngine(value))
      })
      .catch((error) => console.warn('[LibraryView] 读取默认 OCR 引擎失败', error))
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    documentsRef.current = documents
  }, [documents])

  useEffect(() => {
    if (hasHydratedWarmCacheRef.current || !libraryWarmCache) return
    if (libraryWarmCache.scopeKey !== currentLibraryScopeKey) return
    hasHydratedWarmCacheRef.current = true
    setDocuments(libraryWarmCache.documents)
    documentsRef.current = libraryWarmCache.documents
    setFolders(libraryWarmCache.folders)
    setTags(libraryWarmCache.tags)
    setSmartViewCounts(libraryWarmCache.smartViewCounts)
    setHealthReport(libraryWarmCache.healthReport)
    setDocumentTotal(libraryWarmCache.documentTotal)
    setUnfiledDocumentTotal(libraryWarmCache.unfiledDocumentTotal)
    listOffsetRef.current = libraryWarmCache.listOffset
    listHasMoreRef.current = libraryWarmCache.listHasMore
    setListHasMore(libraryWarmCache.listHasMore)
    libraryListScopeRef.current = libraryWarmCache.scopeKey
    setLibraryInitialLoadDone(true)
    visibleListLoadingRequestRef.current = 0
    setLoading(false)
  }, [currentLibraryScopeKey, setDocuments, setFolders, setLoading])

  useEffect(() => {
    if (!libraryWarmCache || libraryWarmCache.scopeKey !== currentLibraryScopeKey) return
    libraryWarmCache = {
      ...libraryWarmCache,
      documents,
      listOffset: listOffsetRef.current,
      listHasMore: listHasMoreRef.current,
    }
  }, [currentLibraryScopeKey, documents])

  useEffect(() => {
    ocrProgressByDocRef.current = ocrProgressByDoc
  }, [ocrProgressByDoc])

  const documentIdOrder = useMemo(() => documents.map((doc) => doc.id), [documents])
  const gridRenderedDocuments = useMemo(() => {
    if (viewMode !== 'grid') return documents
    return documents.slice(0, Math.min(documents.length, gridRenderLimit))
  }, [documents, gridRenderLimit, viewMode])
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])

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
    if (!shortcuts) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (hasShortcutBlockingOverlay()) return

      if (shortcutMatches(event, shortcuts.search)) {
        event.preventDefault()
        const input = layoutRef.current?.querySelector<HTMLInputElement>('input[data-library-search-input="true"]')
        if (!input) return
        if (document.activeElement === input) {
          input.blur()
          return
        }
        input.focus()
        input.select()
        return
      }

      if (isEditableShortcutTarget(event.target)) return

      if (shortcutMatches(event, shortcuts.selectAll)) {
        event.preventDefault()
        setBatchMode(true)
        selectAll()
        return
      }

      if (shortcutMatches(event, shortcuts.invertSelection)) {
        event.preventDefault()
        setBatchMode(true)
        setSelectedIds(documentIdOrder.filter((id) => !selectedIdSet.has(id)))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [documentIdOrder, selectAll, selectedIdSet, setSelectedIds, shortcuts])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LIBRARY_SIDEBAR_LAYOUT_KEY)
      if (!raw) return

      const parsed = JSON.parse(raw) as Partial<SidebarLayoutState>
      if (typeof parsed.width === 'number') {
        setSidebarWidth(Math.max(220, Math.min(420, parsed.width)))
      }

      if (parsed.heights) {
        const nextHeights = {
          smart: typeof parsed.heights.smart === 'number' ? parsed.heights.smart : 24,
          folder: typeof parsed.heights.folder === 'number' ? parsed.heights.folder : 30,
          tag: typeof parsed.heights.tag === 'number' ? parsed.heights.tag : 46
        }
        setSectionHeights(nextHeights)
      }

      if (parsed.collapsed) {
        setCollapsedSections({
          smart: !!parsed.collapsed.smart,
          folder: !!parsed.collapsed.folder,
          tag: !!parsed.collapsed.tag
        })
      }
    } catch (error) {
      console.warn('[LibraryView] Failed to restore sidebar layout', error)
    }
  }, [])

  useEffect(() => {
    const payload: SidebarLayoutState = {
      width: sidebarWidth,
      heights: sectionHeights,
      collapsed: collapsedSections
    }

    try {
      window.localStorage.setItem(LIBRARY_SIDEBAR_LAYOUT_KEY, JSON.stringify(payload))
    } catch (error) {
      console.warn('[LibraryView] Failed to persist sidebar layout', error)
    }
  }, [collapsedSections, sectionHeights, sidebarWidth])

  useEffect(() => {
    try {
      window.localStorage.setItem(LIBRARY_SORT_STORAGE_KEY, librarySort)
    } catch (error) {
      console.warn('[LibraryView] Failed to persist library sort', error)
    }
  }, [librarySort])

  useEffect(() => {
    try {
      window.localStorage.setItem(LIBRARY_PAGE_SIZE_STORAGE_KEY, String(libraryPageSize))
    } catch (error) {
      console.warn('[LibraryView] Failed to persist library page size', error)
    }
  }, [libraryPageSize])

  const loadBaseData = useCallback(async () => {
    try {
      const [folderItems, tagItems, stateCache] = await Promise.all([
        window.api.listFolders(),
        window.api.listTags(),
        window.api.getLibraryStateCache(),
      ])
      const foldersWithCounts = applyLibraryStateCacheToFolders(folderItems, stateCache)
      const tagsWithCounts = applyLibraryStateCacheToTags(tagItems as TagItem[], stateCache)
      baseDataBusyRetryCountRef.current = 0
      setFolders(foldersWithCounts)
      setTags(tagsWithCounts)
      setUnfiledDocumentTotal(Number(stateCache.unfiledDocumentTotal || 0))
      setSmartViewCounts(stateCache.smartViewCounts)
      patchLibraryWarmCache(currentLibraryScopeKey, {
        documents: documentsRef.current,
        folders: foldersWithCounts,
        tags: tagsWithCounts,
        smartViewCounts: stateCache.smartViewCounts,
        unfiledDocumentTotal: Number(stateCache.unfiledDocumentTotal || 0),
        listOffset: listOffsetRef.current,
        listHasMore: listHasMoreRef.current,
      })
    } catch (error) {
      console.error(error)
      if (isTransientDatabaseBusyError(error)) {
        const retryIndex = Math.min(baseDataBusyRetryCountRef.current, BASE_DATA_BUSY_RETRY_DELAYS_MS.length - 1)
        baseDataBusyRetryCountRef.current += 1
        if (baseDataRefreshTimerRef.current) {
          window.clearTimeout(baseDataRefreshTimerRef.current)
        }
        baseDataRefreshTimerRef.current = window.setTimeout(() => {
          baseDataRefreshTimerRef.current = null
          void loadBaseData()
        }, BASE_DATA_BUSY_RETRY_DELAYS_MS[retryIndex])
        return
      }
      message.error({ content: '加载目录和标签失败', key: 'library-base-data-load', duration: 4 })
    }
  }, [currentLibraryScopeKey, setFolders])

  const loadSmartViewCounts = useCallback(async (options?: { refresh?: boolean }) => {
    try {
      const stateCache = options?.refresh
        ? await window.api.refreshLibraryStateCache()
        : await window.api.getLibraryStateCache()
      setSmartViewCounts(stateCache.smartViewCounts)
      setUnfiledDocumentTotal(Number(stateCache.unfiledDocumentTotal || 0))
      const nextFolders = applyLibraryStateCacheToFolders(folders, stateCache)
      const nextTags = applyLibraryStateCacheToTags(tags, stateCache)
      setFolders(nextFolders)
      setTags(nextTags)
      patchLibraryWarmCache(currentLibraryScopeKey, {
        smartViewCounts: stateCache.smartViewCounts,
        unfiledDocumentTotal: Number(stateCache.unfiledDocumentTotal || 0),
        folders: nextFolders,
        tags: nextTags,
      })
    } catch (error) {
      console.warn('[LibraryView] Failed to load smart view counts', error)
    }
  }, [currentLibraryScopeKey, folders, setFolders, tags])

  const scheduleSmartViewCountsRefresh = useCallback((delayMs = SMART_COUNTS_REFRESH_DEBOUNCE_MS) => {
    if (smartCountsRefreshTimerRef.current) {
      window.clearTimeout(smartCountsRefreshTimerRef.current)
    }

    smartCountsRefreshTimerRef.current = window.setTimeout(() => {
      smartCountsRefreshTimerRef.current = null
      void loadSmartViewCounts()
    }, delayMs)
  }, [loadSmartViewCounts])

  const scheduleBaseDataRefresh = useCallback((delayMs = BASE_DATA_REFRESH_DEBOUNCE_MS) => {
    if (baseDataRefreshTimerRef.current) {
      window.clearTimeout(baseDataRefreshTimerRef.current)
    }

    baseDataRefreshTimerRef.current = window.setTimeout(() => {
      baseDataRefreshTimerRef.current = null
      void loadBaseData()
    }, delayMs)
  }, [loadBaseData])

  const loadHealthReport = useCallback(async (options?: { silent?: boolean; refresh?: boolean }) => {
    try {
      if (!options?.silent) setHealthLoading(true)
      const report = await window.api.getDocumentHealthReport({ refresh: options?.refresh })
      const nextReport = sanitizeHealthReport(report as DocumentHealthReport)
      setHealthReport(nextReport)
      patchLibraryWarmCache(currentLibraryScopeKey, { healthReport: nextReport })
    } catch (error) {
      console.error(error)
      if (!options?.silent) message.error('加载文献健康检查失败')
    } finally {
      if (!options?.silent) setHealthLoading(false)
    }
  }, [currentLibraryScopeKey])

  const scheduleHealthReportRefresh = useCallback((delayMs = HEALTH_REPORT_REFRESH_DEBOUNCE_MS) => {
    if (healthPanelCollapsed) return
    if (healthRefreshTimerRef.current) {
      window.clearTimeout(healthRefreshTimerRef.current)
    }

    healthRefreshTimerRef.current = window.setTimeout(() => {
      healthRefreshTimerRef.current = null
      void loadHealthReport({ silent: true, refresh: true })
    }, delayMs)
  }, [healthPanelCollapsed, loadHealthReport])

  const buildListOptions = useCallback((activeFilter = filter, paging?: { limit?: number; offset?: number; search?: string }): ListDocumentOptions => {
    const options: ListDocumentOptions = {}
    const keyword = (paging?.search ?? searchKey).trim()
    const sortOptions = parseLibrarySortValue(librarySort)
    if (keyword) {
      options.search = keyword
      options.searchFields = librarySearchFields
    }
    if (sortOptions.sortKey) {
      options.sortKey = sortOptions.sortKey
      options.sortDirection = sortOptions.sortDirection
    }
    if (paging?.limit !== undefined) options.limit = paging.limit
    if (paging?.offset !== undefined) options.offset = paging.offset

    if (activeFilter.type === 'docType' && activeFilter.value) options.docType = activeFilter.value
    if (activeFilter.type === 'ocrIncomplete') options.ocrIncomplete = true
    if (activeFilter.type === 'ocrStatus' && activeFilter.value) options.ocrStatus = activeFilter.value
    if (activeFilter.type === 'importStatus' && activeFilter.value) options.importStatus = activeFilter.value
    if (activeFilter.type === 'folder' && activeFilter.value) {
      if (activeFilter.value === UNFILED_FOLDER_ID) {
        options.unfiledOnly = true
      } else {
        options.folderIds = collectFolderDescendantIds(folders, activeFilter.value)
      }
    }
    if (activeFilter.type === 'favorite') options.favoritesOnly = true
    if (activeFilter.type === 'readStatus' && activeFilter.value) options.readStatus = activeFilter.value
    if (activeFilter.type === 'metadataStatus' && activeFilter.value) options.metadataStatus = activeFilter.value
    if (activeFilter.type === 'proofStatus' && activeFilter.value) options.proofStatus = activeFilter.value
    if (activeFilter.type === 'metadataPending') options.metadataPending = true
    if (activeFilter.type === 'embeddingReady') options.embeddingReady = true
    if (isHealthFilter(activeFilter)) options.healthFilter = activeFilter.type

    if (activeFilter.type === 'tag') {
      const tagIds = getActiveTagIds(activeFilter)
      if (tagIds.length > 0) options.tagIds = tagIds
    }

    return options
  }, [filter, folders, librarySearchFields, librarySort, searchKey])

  const loadDocuments = useCallback(async (activeFilter = filter, options?: { silent?: boolean; reset?: boolean; append?: boolean; search?: string }) => {
    const append = !!options?.append
    if (append && (listLoadingMoreRef.current || !listHasMoreRef.current)) return

    const requestId = ++listRequestSeqRef.current
    const reset = !!options?.reset
    const offset = append ? listOffsetRef.current : 0
    const limit = append
      ? libraryPageSize
      : reset
        ? libraryPageSize
        : Math.max(libraryPageSize, listOffsetRef.current || documentsRef.current.length || libraryPageSize)

    if (append) {
      listLoadingMoreRef.current = true
      setListLoadingMore(true)
    } else {
      listLoadingMoreRef.current = false
      setListLoadingMore(false)
      if (!options?.silent) {
        visibleListLoadingRequestRef.current = requestId
        setLoading(true)
      }
    }

    try {
      const listOptions = buildListOptions(activeFilter, {
        limit,
        offset,
        search: options?.search,
      })
      let page: Awaited<ReturnType<typeof window.api.listDocumentsPage>> | null = null
      let lastError: unknown = null
      for (let attempt = 0; attempt <= LIBRARY_LIST_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          page = await withLibraryRequestTimeout(window.api.listDocumentsPage(listOptions))
          break
        } catch (error) {
          lastError = error
          if (!isTransientLibraryLoadError(error) || attempt >= LIBRARY_LIST_BUSY_RETRY_DELAYS_MS.length) throw error
          await waitForLibraryRetry(LIBRARY_LIST_BUSY_RETRY_DELAYS_MS[attempt])
          if (requestId !== listRequestSeqRef.current) return
        }
      }
      if (!page) throw lastError || new Error('加载文献列表失败')
      if (requestId !== listRequestSeqRef.current) return

      const nextItems = applySmartFilterDocuments(page.items, activeFilter)
      const nextDocs = append
        ? [...documentsRef.current, ...nextItems.filter((item) => !documentsRef.current.some((doc) => doc.id === item.id))]
        : nextItems
      const nextOffset = append ? offset + page.items.length : page.items.length

      setDocuments(nextDocs)
      documentsRef.current = nextDocs
      listOffsetRef.current = nextOffset
      listHasMoreRef.current = nextOffset < page.total
      setListHasMore(listHasMoreRef.current)
      setOcrProgressByDoc((current) => {
        let changed = false
        const next = { ...current }
        for (const doc of nextDocs) {
          if (isStaleOcrProgressForDocument(next[doc.id], doc)) {
            delete next[doc.id]
            changed = true
          }
          // Seed missing progress for active OCR jobs so bars survive list refresh / pagination.
          if (!next[doc.id] && isDocumentOcrJobActive(doc)) {
            next[doc.id] = buildFallbackOcrProgressInfo(doc)
            changed = true
          }
        }
        if (changed) ocrProgressByDocRef.current = next
        return changed ? next : current
      })
      setDocumentTotal(page.total)
      patchLibraryWarmCache(buildLibraryListScopeKey({
          filter: activeFilter,
          searchKey: options?.search ?? searchKey,
          searchFields: librarySearchFields,
          sort: librarySort,
          pageSize: libraryPageSize,
        }), {
        documents: nextDocs,
        documentTotal: page.total,
        listOffset: nextOffset,
        listHasMore: listHasMoreRef.current,
      })
      if (!append) {
        setLibraryInitialLoadDone(true)
        setLibraryListLoadError(null)
      }
    } catch (error) {
      console.error(error)
      // Never blank an existing library on transient load failure (busy DB / timeout during OCR).
      // Keep previous documents and schedule a silent retry so the UI does not look like an empty library.
      const keepExisting = !append && documentsRef.current.length > 0
      const errorMessage = getErrorMessage(error, '数据库正忙或加载超时')
      if (!append) setLibraryListLoadError(errorMessage)
      message.error({
        content: keepExisting
          ? `文献列表暂时加载失败：${errorMessage}。已保留当前列表，稍后自动重试。`
          : `加载文献列表失败：${errorMessage}。正在自动重试，请稍候…`,
        key: 'library-list-load',
        duration: 6,
      })
      if (!append && requestId === listRequestSeqRef.current) {
        window.setTimeout(() => {
          if (listRequestSeqRef.current !== requestId) return
          void loadDocuments(activeFilter, { silent: true, reset: true, search: options?.search })
        }, 3500)
      }
    } finally {
      if (append) {
        listLoadingMoreRef.current = false
        setListLoadingMore(false)
      } else if (visibleListLoadingRequestRef.current === requestId) {
        visibleListLoadingRequestRef.current = 0
        setLoading(false)
      }
    }
  }, [buildListOptions, filter, libraryPageSize, librarySearchFields, librarySort, searchKey, setDocuments, setLoading])

  const submitLibrarySearch = useCallback((value = searchInput) => {
    const keyword = value.trim()
    setSearchInput(keyword)
    listOffsetRef.current = 0
    listHasMoreRef.current = false
    setListHasMore(false)
    setSearchKey(keyword)
    void loadDocuments(filter, { reset: true, search: keyword })
  }, [filter, loadDocuments, searchInput, setSearchKey])

  const loadMoreDocuments = useCallback(() => {
    if (loading || listLoadingMoreRef.current || !listHasMoreRef.current) return
    void loadDocuments(filter, { append: true, silent: true })
  }, [filter, loadDocuments, loading])

  const scheduleImportListRefresh = useCallback((delayMs = IMPORT_LIST_REFRESH_DEBOUNCE_MS) => {
    if (importListRefreshTimerRef.current) {
      window.clearTimeout(importListRefreshTimerRef.current)
    }

    importListRefreshTimerRef.current = window.setTimeout(() => {
      importListRefreshTimerRef.current = null
      listOffsetRef.current = 0
      listHasMoreRef.current = false
      setListHasMore(false)
      void loadDocuments(filter, { reset: true, silent: true })
    }, delayMs)
  }, [filter, loadDocuments])

  const cancelScheduledImportListRefresh = useCallback(() => {
    if (!importListRefreshTimerRef.current) return
    window.clearTimeout(importListRefreshTimerRef.current)
    importListRefreshTimerRef.current = null
  }, [])

  const refreshLibraryAfterImport = useCallback(async () => {
    listOffsetRef.current = 0
    listHasMoreRef.current = false
    setListHasMore(false)
    libraryContentRef.current?.scrollTo({ top: 0 })
    await loadDocuments(filter, { reset: true, silent: true })
  }, [filter, loadDocuments])

  const maybeLoadMoreFromScroll = useCallback((target: HTMLElement) => {
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    if (distanceToBottom > 180) return
    if (viewMode === 'grid') {
      const renderedCount = Math.min(gridRenderLimit, documents.length)
      if (renderedCount < documents.length) {
        setGridRenderLimit((current) => Math.min(documents.length, Math.max(current, renderedCount) + GRID_CARD_RENDER_BATCH_SIZE))
        return
      }
    }
    loadMoreDocuments()
  }, [documents.length, gridRenderLimit, loadMoreDocuments, viewMode])

  const handleLibrarySearchFieldsChange = useCallback((values: LibraryDocumentSearchField[]) => {
    const allowedFields = new Set<LibraryDocumentSearchField>(DEFAULT_LIBRARY_SEARCH_FIELDS)
    const nextFields = values.filter((value): value is LibraryDocumentSearchField => allowedFields.has(value))
    if (nextFields.length === 0) {
      message.warning('至少选择一个搜索范围')
      return
    }

    setLibrarySearchFields([...new Set(nextFields)])
  }, [])

  const applyLibraryFilter = useCallback(async (nextFilter: LibraryFilter) => {
    setFilter(nextFilter)
  }, [setFilter])

  const toggleLibraryFilter = useCallback(async (nextFilter: LibraryFilter) => {
    setFilter(isSameFilter(filter, nextFilter) ? { type: 'all' } : nextFilter)
  }, [filter, setFilter])

  const closeHealthPanel = useCallback(() => {
    setHealthPanelCollapsed(true)
    if (isHealthFilter(filter)) {
      setFilter({ type: 'all' })
    }
  }, [filter, setFilter])

  const focusSection = useCallback((section?: 'tags' | 'folders' | 'smart') => {
    const refs = {
      smart: smartSectionRef,
      folders: folderSectionRef,
      tags: tagSectionRef
    }
    refs[section || 'tags']?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const flushOcrStatusBuffer = useCallback(() => {
    if (ocrStatusFlushTimerRef.current) {
      window.clearTimeout(ocrStatusFlushTimerRef.current)
      ocrStatusFlushTimerRef.current = null
    }

    const events = [...ocrStatusBufferRef.current.values()]
    ocrStatusBufferRef.current.clear()
    if (events.length === 0) return

    const updates: Array<{ data: OcrProgressEvent; nextInfo: OcrProgressInfo }> = []
    const nextProgressByDoc = { ...ocrProgressByDocRef.current }
    const now = Date.now()
    for (const event of events) {
      const data = mergeMonotonicOcrProgress(nextProgressByDoc[event.docId], event)
      const nextInfo: OcrProgressInfo = { ...data, updatedAt: now }
      updates.push({ data, nextInfo })
      nextProgressByDoc[data.docId] = nextInfo
    }
    ocrProgressByDocRef.current = nextProgressByDoc
    setOcrProgressByDoc(nextProgressByDoc)

    const patches = updates.map(({ data }) => ({ id: data.docId, data: buildDocumentPatchForOcrProgress(data) }))
    updateDocumentsInList(patches)

    for (const { data, nextInfo } of updates) {
      const toastKey = `ocr-progress-${data.docId}`
      message.destroy(toastKey)

      if (data.status === 'queued' || data.status === 'processing' || data.status === 'pending') {
        message.destroy(`ocr-error-${data.docId}`)
      }

      if (data.status === 'processing' || data.aiStatus === 'processing') {
        if (data.phase === 'ai' && data.aiStatus === 'processing') {
          window.setTimeout(() => {
            setOcrProgressByDoc((current) => {
              const existing = current[data.docId]
              if (!existing || existing.updatedAt !== nextInfo.updatedAt || existing.aiStatus !== 'processing') return current
              message.warning({
                content: 'AI 元数据提取用时较长，已关闭提示；OCR 文本已保存，可稍后手动重新提取元数据。',
                key: toastKey,
                duration: 6,
              })
              activeOcrToastKeysRef.current.delete(toastKey)
              const { [data.docId]: _removed, ...rest } = current
              return rest
            })
          }, OCR_AI_TOAST_TIMEOUT_MS)
        }
      }

      if (
        data.status === 'completed'
        && !(data.phase === 'ai' && data.aiStatus === 'processing')
        && !(data.phase === 'ai' && data.aiStatus === 'completed')
      ) {
        activeOcrToastKeysRef.current.delete(toastKey)
        message.destroy(toastKey)
        message.destroy(`ocr-error-${data.docId}`)
        if (data.errorMessage) {
          message.warning({
            content: `OCR 已保存：${data.errorMessage}`,
            key: `ocr-review-${data.docId}`,
            duration: 8,
          })
        }
        window.setTimeout(() => {
          setOcrProgressByDoc((current) => {
            const existing = current[data.docId]
            if (!existing || existing.updatedAt !== nextInfo.updatedAt) return current
            const { [data.docId]: _removed, ...rest } = current
            return rest
          })
        }, data.errorMessage ? 30000 : 1200)
        scheduleImportListRefresh()
      }

      if (data.phase === 'ai' && data.aiStatus === 'completed') {
        activeOcrToastKeysRef.current.delete(toastKey)
        message.success({ content: 'AI 元数据提取完成', key: toastKey, duration: 3 })
        window.setTimeout(() => {
          setOcrProgressByDoc((current) => {
            const existing = current[data.docId]
            if (!existing || existing.updatedAt !== nextInfo.updatedAt) return current
            const { [data.docId]: _removed, ...rest } = current
            return rest
          })
        }, 5000)
        scheduleBaseDataRefresh()
      }

      if (data.phase === 'ai' && data.aiStatus === 'error') {
        activeOcrToastKeysRef.current.delete(toastKey)
        message.warning({
          content: data.errorMessage ? `AI 元数据提取失败：${data.errorMessage}` : 'AI 元数据提取失败',
          key: toastKey,
          duration: 6,
        })
        window.setTimeout(() => {
          setOcrProgressByDoc((current) => {
            const existing = current[data.docId]
            if (!existing || existing.updatedAt !== nextInfo.updatedAt) return current
            const { [data.docId]: _removed, ...rest } = current
            return rest
          })
        }, 30000)
      }

      if (data.status === 'error') {
        const errorMessage = data.errorMessage || '处理失败，未返回具体原因'
        activeOcrToastKeysRef.current.delete(toastKey)
        message.destroy(toastKey)
        message.error({
          content: `OCR 失败：${errorMessage}`,
          key: `ocr-error-${data.docId}`,
          duration: 6,
        })
      }

      if (data.status === 'pending') {
        activeOcrToastKeysRef.current.delete(toastKey)
        message.destroy(toastKey)
        if (data.errorMessage) {
          message.warning({ content: data.errorMessage, key: `ocr-error-${data.docId}`, duration: 6 })
        }
      }
    }

    const activitySummary = buildOcrActivitySummary(Object.values(nextProgressByDoc))
    if (activitySummary) {
      activeOcrToastKeysRef.current.add(OCR_ACTIVITY_MESSAGE_KEY)
      message.loading({ content: activitySummary, key: OCR_ACTIVITY_MESSAGE_KEY, duration: 0 })
    } else {
      activeOcrToastKeysRef.current.delete(OCR_ACTIVITY_MESSAGE_KEY)
      message.destroy(OCR_ACTIVITY_MESSAGE_KEY)
    }

    if (events.some(isImmediateOcrProgressEvent)) {
      scheduleHealthReportRefresh()
    }
  }, [scheduleBaseDataRefresh, scheduleHealthReportRefresh, scheduleImportListRefresh, updateDocumentsInList])

  useEffect(() => {
    // Yield one frame so the shell can paint before the first heavy IPC burst.
    const timer = window.setTimeout(() => {
      void loadBaseData()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadBaseData])

  useEffect(() => {
    return () => {
      if (smartCountsRefreshTimerRef.current) {
        window.clearTimeout(smartCountsRefreshTimerRef.current)
        smartCountsRefreshTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (lastInitialFilterRef.current && isSameFilter(lastInitialFilterRef.current, initialFilter)) return
    lastInitialFilterRef.current = initialFilter
    if (!isSameFilter(filter, initialFilter)) {
      setFilter(initialFilter)
    }
  }, [filter, initialFilter, setFilter])

  useEffect(() => {
    if (!initialFocusSection) return undefined
    const timer = window.setTimeout(() => focusSection(initialFocusSection), 150)
    return () => window.clearTimeout(timer)
  }, [focusSection, initialFocusSection])

  useEffect(() => {
    const unsubscribe = window.api.onImportProgress((event) => {
      if (event.phase === 'stored') {
        const totalFiles = Math.max(1, Number(event.totalFiles || 1))
        const completedFiles = typeof event.progress === 'number'
          ? Math.max(0, Math.min(totalFiles, Math.round(event.progress * totalFiles)))
          : Math.max(0, Math.min(totalFiles, Number(event.fileIndex || 0) + 1))
        const content = totalFiles > 1
          ? `已完成文件写入：${completedFiles}/${totalFiles}`
          : `已完成文件写入：${event.fileName}`
        setImportProgressText(content)
        message.loading({ content, key: 'import', duration: 0 })
        return
      }
      const percent = typeof event.progress === 'number'
        ? Math.max(0, Math.min(100, Math.round(event.progress * 100)))
        : null
      const bytesText = event.totalBytes
        ? `${formatBytes(event.bytesDone)} / ${formatBytes(event.totalBytes)}`
        : formatBytes(event.bytesDone)
      const actionText = event.phase === 'hashing' ? '正在校验' : '正在复制'
      const content = percent === null
        ? `${actionText}第 ${event.fileIndex + 1}/${event.totalFiles} 个文件：${event.fileName}（${bytesText}）`
        : `${actionText}第 ${event.fileIndex + 1}/${event.totalFiles} 个文件：${event.fileName}（${percent}%，${bytesText}）`
      setImportProgressText(content)
      message.loading({ content, key: 'import', duration: 0 })
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onOcrStatusChanged((data) => {
      const buffered = ocrStatusBufferRef.current.get(data.docId)
      const nextData = mergeMonotonicOcrProgress(buffered, data)
      ocrStatusBufferRef.current.set(nextData.docId, nextData)
      if (isImmediateOcrProgressEvent(nextData)) {
        flushOcrStatusBuffer()
        return
      }

      if (ocrStatusFlushTimerRef.current) return
      ocrStatusFlushTimerRef.current = window.setTimeout(() => {
        flushOcrStatusBuffer()
      }, OCR_STATUS_UI_FLUSH_INTERVAL_MS)
    })
    return () => {
      unsubscribe()
      if (ocrStatusFlushTimerRef.current) {
        window.clearTimeout(ocrStatusFlushTimerRef.current)
        ocrStatusFlushTimerRef.current = null
      }
      ocrStatusBufferRef.current.clear()
      activeOcrToastKeysRef.current.forEach((key) => message.destroy(key))
      activeOcrToastKeysRef.current.clear()
    }
  }, [flushOcrStatusBuffer])

  useEffect(() => {
    const handleBackgroundTaskStatus = (event: BackgroundTaskProgressEvent) => {
      const countText = event.totalCount && event.totalCount > 0
        ? `（${Math.min(Number(event.completedCount || 0), Number(event.totalCount))}/${event.totalCount}）`
        : ''

      if (event.kind === 'ocr-finalize') {
        if (event.status === 'queued' || event.status === 'processing') {
          message.loading({
            content: event.message || 'OCR 已完成，正在后台整理文本，不影响阅读',
            key: BACKGROUND_OCR_FINALIZE_MESSAGE_KEY,
            duration: 0,
          })
          return
        }

        if (event.status === 'completed') {
          message.success({
            content: event.message || '文本整理完成，搜索和统计已更新',
            key: BACKGROUND_OCR_FINALIZE_MESSAGE_KEY,
            duration: 3,
          })
          scheduleHealthReportRefresh()
          scheduleSmartViewCountsRefresh()
          return
        }

        if (event.status === 'error') {
          message.warning({
            content: event.errorMessage ? `OCR 文本整理失败：${event.errorMessage}` : 'OCR 文本整理失败，可稍后重试',
            key: BACKGROUND_OCR_FINALIZE_MESSAGE_KEY,
            duration: 6,
          })
          scheduleHealthReportRefresh()
          scheduleSmartViewCountsRefresh()
        }
        return
      }

      if (event.kind === 'search-index') {
        if (event.status === 'queued' || event.status === 'processing') {
          message.loading({
            content: `${event.message || '正在后台更新搜索索引，不影响阅读和浏览'}${countText}`,
            key: BACKGROUND_SEARCH_INDEX_MESSAGE_KEY,
            duration: 0,
          })
          return
        }

        if (event.status === 'completed') {
          message.success({
            content: event.message || '搜索索引更新完成，搜索结果已可用',
            key: BACKGROUND_SEARCH_INDEX_MESSAGE_KEY,
            duration: 5,
          })
          scheduleHealthReportRefresh()
          return
        }

        if (event.status === 'error') {
          message.warning({
            content: event.errorMessage ? `后台索引更新失败：${event.errorMessage}` : event.message || '后台索引更新失败，可稍后在健康检查中重试',
            key: BACKGROUND_SEARCH_INDEX_MESSAGE_KEY,
            duration: 6,
          })
          scheduleHealthReportRefresh()
        }
        return
      }

      if (event.kind === 'health-report') {
        if (event.status === 'queued' || event.status === 'processing') {
          message.loading({
            content: event.message || '正在后台刷新健康统计，不影响阅读和浏览',
            key: BACKGROUND_HEALTH_REPORT_MESSAGE_KEY,
            duration: 0,
          })
          return
        }

        if (event.status === 'completed') {
          message.success({
            content: event.message || '健康统计更新完成',
            key: BACKGROUND_HEALTH_REPORT_MESSAGE_KEY,
            duration: 4,
          })
          void loadHealthReport({ silent: true, refresh: false })
          return
        }

        if (event.status === 'error') {
          message.warning({
            content: event.errorMessage ? `健康统计更新失败：${event.errorMessage}` : '健康统计更新失败，可稍后重试',
            key: BACKGROUND_HEALTH_REPORT_MESSAGE_KEY,
            duration: 6,
          })
        }
        return
      }

      if (event.kind === 'startup-recovery') {
        if (event.status === 'queued' || event.status === 'processing') {
          message.loading({
            content: event.message || '正在后台检查上次未完成的任务',
            key: BACKGROUND_STARTUP_RECOVERY_MESSAGE_KEY,
            duration: 0,
          })
          return
        }

        if (event.status === 'completed') {
          message.destroy(BACKGROUND_STARTUP_RECOVERY_MESSAGE_KEY)
          void Promise.all([
            loadBaseData(),
            loadDocuments(filter, { silent: true }),
          ])
          scheduleHealthReportRefresh(200)
          const recoveredCount = Number(event.totalCount || 0)
          if (recoveredCount > 0) {
            message.success({
              content: event.message || '已恢复上次未完成的任务',
              key: BACKGROUND_STARTUP_RECOVERY_MESSAGE_KEY,
              duration: 4,
            })
          }
          return
        }

        if (event.status === 'error') {
          message.warning({
            content: event.errorMessage ? `启动恢复失败：${event.errorMessage}` : event.message || '启动恢复失败，可重启后再试',
            key: BACKGROUND_STARTUP_RECOVERY_MESSAGE_KEY,
            duration: 6,
          })
        }
        return
      }

      if (event.kind === 'embedding-index') {
        if (event.status === 'queued' || event.status === 'processing') {
          message.loading({
            content: `${event.message || '正在向量化文献'}${countText}`,
            key: BACKGROUND_EMBEDDING_MESSAGE_KEY,
            duration: 0,
          })
          return
        }
        if (event.status === 'completed') {
          message.success({
            content: event.message || '向量化完成',
            key: BACKGROUND_EMBEDDING_MESSAGE_KEY,
            duration: 4,
          })
          scheduleSmartViewCountsRefresh(200)
          void loadDocuments(filter, { silent: true })
          return
        }
        if (event.status === 'error') {
          message.warning({
            content: event.errorMessage ? `向量化失败：${event.errorMessage}` : event.message || '向量化失败',
            key: BACKGROUND_EMBEDDING_MESSAGE_KEY,
            duration: 6,
          })
          scheduleSmartViewCountsRefresh(200)
        }
      }
    }

    const unsubscribe = window.api.onBackgroundTaskStatusChanged(handleBackgroundTaskStatus)
    return () => {
      unsubscribe()
      message.destroy(BACKGROUND_SEARCH_INDEX_MESSAGE_KEY)
      message.destroy(BACKGROUND_HEALTH_REPORT_MESSAGE_KEY)
      message.destroy(BACKGROUND_OCR_FINALIZE_MESSAGE_KEY)
      message.destroy(BACKGROUND_STARTUP_RECOVERY_MESSAGE_KEY)
      message.destroy(BACKGROUND_EMBEDDING_MESSAGE_KEY)
    }
  }, [filter, loadBaseData, loadDocuments, loadHealthReport, scheduleHealthReportRefresh, scheduleSmartViewCountsRefresh])

  useEffect(() => {
    const applyEmbeddingEvent = (event: EmbeddingProgressEvent) => {
      if (!event.docId) return
      const docId = event.docId
      setEmbeddingProgressByDoc((current) => ({
        ...current,
        [docId]: {
          docId,
          status: event.status,
          progress: Number(event.progress) || 0,
          message: event.message,
          embeddedCount: event.embeddedCount,
          segmentCount: event.segmentCount,
          errorMessage: event.errorMessage,
          updatedAt: Date.now(),
        },
      }))
      // Mirror status onto the library card tags immediately (ready / queued / error…).
      if (event.status === 'ready' || event.status === 'queued' || event.status === 'processing' || event.status === 'error') {
        updateDocumentInList(docId, {
          embedding_status: event.status === 'ready' ? 'ready' : event.status,
          embedding_chunk_count: event.status === 'ready'
            ? Math.max(Number(event.embeddedCount || 0), Number(event.segmentCount || 0))
            : undefined,
        })
      }
      if (event.status === 'ready' || event.status === 'error' || event.status === 'idle') {
        scheduleSmartViewCountsRefresh(400)
      }
    }
    const unsubscribe = window.api.onEmbeddingProgress(applyEmbeddingEvent)
    return () => {
      unsubscribe()
    }
  }, [scheduleSmartViewCountsRefresh, updateDocumentInList])

  useEffect(() => () => {
    if (healthRefreshTimerRef.current) {
      window.clearTimeout(healthRefreshTimerRef.current)
      healthRefreshTimerRef.current = null
    }
    if (baseDataRefreshTimerRef.current) {
      window.clearTimeout(baseDataRefreshTimerRef.current)
      baseDataRefreshTimerRef.current = null
    }
    if (importListRefreshTimerRef.current) {
      window.clearTimeout(importListRefreshTimerRef.current)
      importListRefreshTimerRef.current = null
    }
    if (deferredPdfPreviewTimerRef.current) {
      window.clearTimeout(deferredPdfPreviewTimerRef.current)
      deferredPdfPreviewTimerRef.current = null
    }
    deferredPdfPreviewQueueRef.current = []
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onMetadataReclassificationProgress((payload) => {
      if (payload.currentDocId) {
        updateDocumentInList(payload.currentDocId, { metadata_status: 'auto' })
      }

      if (payload.status !== 'progress' && payload.status !== 'completed') return
      if (metadataRefreshTimerRef.current) {
        window.clearTimeout(metadataRefreshTimerRef.current)
      }

      metadataRefreshTimerRef.current = window.setTimeout(() => {
        void Promise.all([
          loadBaseData(),
          loadDocuments(filter, { silent: true }),
        ])
        metadataRefreshTimerRef.current = null
      }, payload.status === 'completed' ? 80 : 600)
    })

    return () => {
      unsubscribe()
      if (metadataRefreshTimerRef.current) {
        window.clearTimeout(metadataRefreshTimerRef.current)
        metadataRefreshTimerRef.current = null
      }
    }
  }, [filter, loadBaseData, loadDocuments, updateDocumentInList])

  useEffect(() => {
    const handleLibraryRelationsChanged = () => {
      void Promise.all([
        loadBaseData(),
        loadDocuments(filter, { silent: true }),
      ])
    }

    window.addEventListener(LIBRARY_RELATIONS_CHANGED_EVENT, handleLibraryRelationsChanged)
    return () => window.removeEventListener(LIBRARY_RELATIONS_CHANGED_EVENT, handleLibraryRelationsChanged)
  }, [filter, loadBaseData, loadDocuments])

  useEffect(() => {
    const unsubscribe = window.api.onBookTranslationProgress((payload) => {
      const nextInfo: BookTranslationProgressInfo = { ...payload, updatedAt: Date.now() }
      const toastKey = `book-translation-${payload.docId}`
      setBookTranslationProgressByDoc((current) => ({
        ...current,
        [payload.docId]: nextInfo,
      }))

      if (payload.status === 'processing' || payload.status === 'started') {
        message.loading({
          content: getBookTranslationProgressText(nextInfo),
          key: toastKey,
          duration: 0,
        })
        return
      }

      if (payload.status === 'completed') {
        message.success({
          content: payload.outputPath ? `整书翻译完成，已保存到：${payload.outputPath}` : '整书翻译完成',
          key: toastKey,
          duration: 8,
        })
        window.setTimeout(() => {
          setBookTranslationProgressByDoc((current) => {
            const existing = current[payload.docId]
            if (!existing || existing.updatedAt !== nextInfo.updatedAt) return current
            const { [payload.docId]: _removed, ...rest } = current
            return rest
          })
        }, 15000)
        return
      }

      if (payload.status === 'partial') {
        message.warning({
          content: getBookTranslationProgressText(nextInfo),
          key: toastKey,
          duration: 10,
        })
        window.setTimeout(() => {
          setBookTranslationProgressByDoc((current) => {
            const existing = current[payload.docId]
            if (!existing || existing.updatedAt !== nextInfo.updatedAt) return current
            const { [payload.docId]: _removed, ...rest } = current
            return rest
          })
        }, 60000)
        return
      }

      if (payload.status === 'error') {
        message.error({
          content: payload.errorMessage ? `整书翻译失败：${payload.errorMessage}` : '整书翻译失败，下次会从断点继续',
          key: toastKey,
          duration: 8,
        })
        window.setTimeout(() => {
          setBookTranslationProgressByDoc((current) => {
            const existing = current[payload.docId]
            if (!existing || existing.updatedAt !== nextInfo.updatedAt) return current
            const { [payload.docId]: _removed, ...rest } = current
            return rest
          })
        }, 60000)
      }
    })

    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    setSearchInput(searchKey)
  }, [searchKey])

  useEffect(() => {
    const scopeKey = currentLibraryScopeKey
    const shouldResetList = libraryListScopeRef.current !== scopeKey
    libraryListScopeRef.current = scopeKey
    if (shouldResetList) {
      listOffsetRef.current = 0
      listHasMoreRef.current = false
      setListHasMore(false)
      setGridRenderLimit(GRID_CARD_INITIAL_RENDER_COUNT)
      clearSelection()
      libraryContentRef.current?.scrollTo({ top: 0 })
    }
    const canWarmRefresh = libraryWarmCache?.scopeKey === scopeKey && libraryWarmCache.documents.length > 0
    // Stagger list load slightly after base data so main process is not hit by
    // folders+listPage+cache rebuild at the exact same tick after open.
    const timer = window.setTimeout(() => {
      void loadDocuments(filter, { reset: shouldResetList, silent: canWarmRefresh })
    }, shouldResetList ? 40 : 0)
    return () => window.clearTimeout(timer)
  }, [clearSelection, currentLibraryScopeKey, filter, loadDocuments])

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const state = resizeStateRef.current
      if (!state.mode) return

      if (state.mode === 'sidebar') {
        const deltaX = event.clientX - state.startX
        setSidebarWidth(Math.max(220, Math.min(420, state.startWidth + deltaX)))
        return
      }

      if (state.stackHeight <= 0) return
      const deltaPercent = ((event.clientY - state.startY) / state.stackHeight) * 100

      if (state.mode === 'smart-folder') {
        const nextSmart = Math.max(16, Math.min(60, state.startHeights.smart + deltaPercent))
        const nextFolder = Math.max(18, Math.min(60, state.startHeights.folder - deltaPercent))
        const used = nextSmart + nextFolder
        const nextTag = Math.max(18, 100 - used)
        setSectionHeights({ smart: nextSmart, folder: nextFolder, tag: nextTag })
      }

      if (state.mode === 'folder-tag') {
        const nextFolder = Math.max(18, Math.min(60, state.startHeights.folder + deltaPercent))
        const nextTag = Math.max(18, Math.min(64, state.startHeights.tag - deltaPercent))
        const used = nextFolder + nextTag
        const nextSmart = Math.max(16, 100 - used)
        setSectionHeights({ smart: nextSmart, folder: nextFolder, tag: nextTag })
      }
    }

    const handleMouseUp = () => {
      if (!resizeStateRef.current.mode) return
      resizeStateRef.current.mode = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const smartFilters = useMemo(() => {
    return [
      { key: 'all', label: `全部文献 ${smartViewCounts.all}`, filter: { type: 'all' as const } },
      { key: 'missing-metadata', label: `缺元数据 ${smartViewCounts.missingMetadata}`, filter: { type: 'healthMissingMetadata' as const } },
      { key: 'unrecognized', label: `OCR 未完成 ${smartViewCounts.unrecognized}`, filter: { type: 'ocrIncomplete' as const } },
      { key: 'suspicious-title', label: `题名疑似导入名 ${smartViewCounts.suspiciousTitle}`, filter: { type: 'healthSuspiciousTitle' as const } },
      { key: 'unknown-type', label: `待分类 ${smartViewCounts.unknownType}`, filter: { type: 'healthUnknownType' as const } },
      { key: 'favorite', label: `星标 ${smartViewCounts.favorite}`, filter: { type: 'favorite' as const } },
      { key: 'unread', label: `未读 ${smartViewCounts.unread}`, filter: { type: 'readStatus' as const, value: 'unread' } },
      { key: 'proofed', label: `已校对 ${smartViewCounts.proofed}`, filter: { type: 'proofStatus' as const, value: 'completed' } },
      { key: 'unproofed', label: `未校对 ${smartViewCounts.unproofed}`, filter: { type: 'proofStatus' as const, value: 'pending' } },
      { key: 'metadata-pending', label: `未确认元数据 ${smartViewCounts.metadataPending}`, filter: { type: 'metadataPending' as const } },
      { key: 'vectorized', label: `已向量化 ${smartViewCounts.vectorized ?? 0}`, filter: { type: 'embeddingReady' as const } },
      { key: 'unstored', label: `未入库 ${smartViewCounts.unstored}`, filter: { type: 'importStatus' as const, value: 'unstored' } }
    ]
  }, [smartViewCounts])

  const healthMetricItems = useMemo(() => {
    const countRowsWithIssues = (types: string[]) => healthReport?.rows.filter((row) => row.issues.some((issue) => types.includes(issue.type))).length || 0
    const getStat = (key: string, fallback: number): number => {
      const value = Number(healthReport?.stats?.[key])
      return Number.isFinite(value) ? value : fallback
    }
    return [
      {
        label: '缺元数据',
        value: healthReport ? countRowsWithIssues(['missing_metadata', 'missing_author', 'missing_year', 'missing_identifier', 'missing_publisher', 'missing_source']) : 0,
        filter: { type: 'healthMissingMetadata' as const },
      },
      {
        label: '题名疑似导入名',
        value: healthReport ? getStat('suspiciousTitle', countRowsWithIssues(['suspicious_title', 'title_cleanup'])) : 0,
        filter: { type: 'healthSuspiciousTitle' as const },
      },
      {
        label: '待分类',
        value: healthReport ? getStat('unknownType', countRowsWithIssues(['unknown_type', 'title_cleanup'])) : 0,
        filter: { type: 'healthUnknownType' as const },
      },
    ]
  }, [healthReport])

  const filterTitle = useMemo(() => getFilterTitle(filter, folders, tags), [filter, folders, tags])
  const filterLabel = useMemo(() => getFilterChipLabel(filter, folders, tags), [filter, folders, tags])
  const activeTagIds = useMemo(() => getActiveTagIds(filter), [filter])
  const librarySearchFieldsLabel = useMemo(() => getLibrarySearchFieldsLabel(librarySearchFields), [librarySearchFields])
  const sortedSidebarTags = useMemo(() => sortDocumentTags(tags), [tags])
  const visibleDocumentTagOptions = useMemo(() => filterTagsByKeyword(sortedSidebarTags, documentTagSearch), [documentTagSearch, sortedSidebarTags])
  const visibleBatchTagOptions = useMemo(() => filterTagsByKeyword(sortedSidebarTags, batchNewTagName), [batchNewTagName, sortedSidebarTags])
  const folderItems = folders
  const folderTree = useMemo(() => buildFolderTree(folderItems), [folderItems])
  const visibleFolders = useMemo(() => flattenVisibleFolders(folderTree, folderCollapsedIds), [folderCollapsedIds, folderTree])
  const topRiskDocuments = useMemo(() => (healthReport?.rows || []).filter((row) => row.risk_score > 0).slice(0, 5), [healthReport])
  const activeBookTranslations = useMemo(
    () => Object.values(bookTranslationProgressByDoc)
      .filter(shouldShowBookTranslationProgress)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0)),
    [bookTranslationProgressByDoc],
  )
  const documentTitleById = useMemo(
    () => new Map(documents.map((doc) => [doc.id, doc.title || '未命名文献'])),
    [documents],
  )

  const toggleTagFilter = useCallback(async (tagId: string) => {
    const active = filter.type === 'tag' && activeTagIds.includes(tagId)
    const nextIds = active
      ? activeTagIds.filter((id) => id !== tagId)
      : [...activeTagIds, tagId]

    await applyLibraryFilter(nextIds.length > 0 ? { type: 'tag', tagIds: nextIds } : { type: 'all' })
    focusSection('tags')
  }, [activeTagIds, applyLibraryFilter, filter.type, focusSection])

  const handleCreateFolder = async (parentId?: string | null) => {
    const name = newFolderName.trim()
    if (!name) {
      message.info('请输入文件夹名称')
      return
    }

    try {
      const nextParentId = parentId !== undefined
        ? parentId
        : filter.type === 'folder' && filter.value
          ? filter.value
          : null
      await window.api.createFolder({ name, parent_id: nextParentId || undefined })
      setNewFolderName('')
      message.success('已创建文件夹')
      await loadBaseData()
    } catch (error) {
      console.error(error)
      message.error('创建文件夹失败')
    }
  }

  const openCreateChildFolder = (parentId: string | null) => {
    setEditingFolder(null)
    setFolderEditorName('')
    setFolderEditorParentId(parentId)
    setFolderEditorOpen(true)
  }

  const openRenameFolder = (folder: FolderItem) => {
    setEditingFolder(folder)
    setFolderEditorName(folder.name)
    setFolderEditorParentId(folder.parent_id || null)
    setFolderEditorOpen(true)
  }

  const handleSaveFolderEditor = async () => {
    const name = folderEditorName.trim()
    if (!name) {
      message.info('请输入文件夹名称')
      return
    }

    try {
      if (editingFolder) {
        await window.api.updateFolder(editingFolder.id, {
          name,
          parent_id: folderEditorParentId || null,
        })
        message.success('文件夹已更新')
      } else {
        await window.api.createFolder({ name, parent_id: folderEditorParentId || undefined })
        if (folderEditorParentId) {
          setFolderCollapsedIds((current) => current.filter((id) => id !== folderEditorParentId))
        }
        message.success('已创建文件夹')
      }
      setFolderEditorOpen(false)
      setEditingFolder(null)
      setFolderEditorName('')
      setFolderEditorParentId(null)
      await loadBaseData()
    } catch (error) {
      console.error(error)
      message.error(editingFolder ? '更新文件夹失败' : '创建文件夹失败')
    }
  }

  const handleDeleteFolder = async (folder: FolderItem) => {
    Modal.confirm({
      title: `删除文件夹“${folder.name}”？`,
      content: '只删除文件夹和归类关系，不会删除文献本体。子文件夹会移到根层级。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.api.deleteFolder(folder.id)
          setFolderCollapsedIds((current) => current.filter((id) => id !== folder.id))
          if (filter.type === 'folder' && filter.value === folder.id) {
            setFilter({ type: 'all' })
            await loadDocuments({ type: 'all' }, { silent: true })
          } else {
            await loadDocuments(filter, { silent: true })
          }
          await loadBaseData()
          message.success('文件夹已删除')
        } catch (error: unknown) {
          console.error(error)
          message.error(getErrorMessage(error, '删除文件夹失败'))
        }
      }
    })
  }

  const buildLibraryFolderMenuItems = (folder: FolderItem): MenuProps['items'] => [
    { key: 'open', label: '打开文件夹', icon: <FolderOpenOutlined /> },
    { type: 'divider' },
    { key: 'create_child', label: '新建子文件夹', icon: <FolderAddOutlined /> },
    { key: 'rename', label: '重命名', icon: <EditOutlined /> },
    { type: 'divider' },
    { key: 'delete', label: '删除文件夹', icon: <DeleteOutlined />, danger: true },
  ]

  const handleLibraryFolderMenuClick = (folder: FolderItem, key: string) => {
    if (key === 'open') void toggleLibraryFilter({ type: 'folder', value: folder.id })
    if (key === 'create_child') openCreateChildFolder(folder.id)
    if (key === 'rename') openRenameFolder(folder)
    if (key === 'delete') void handleDeleteFolder(folder)
  }

  const toggleFolderCollapsed = (folderId: string) => {
    setFolderCollapsedIds((current) => (
      current.includes(folderId)
        ? current.filter((id) => id !== folderId)
        : [...current, folderId]
    ))
  }

  const handleCreateTag = async () => {
    const name = newTagName.trim()
    if (!name) {
      message.info('请输入标签名称')
      return
    }

    try {
      await window.api.createTag({ name, source: 'manual' })
      setNewTagName('')
      message.success('已创建标签')
      await loadBaseData()
      focusSection('tags')
    } catch (error) {
      console.error(error)
      message.error('创建标签失败')
    }
  }

  const ensureManualTag = async (name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) return null
    const tag = await window.api.createTag({ name: trimmedName, source: 'manual' })
    return tag
  }

  const handleApplyTagsToDocuments = async (docIds: string[], tagIds: string[], successText?: string) => {
    const uniqueDocIds = [...new Set(docIds)]
    const uniqueTagIds = [...new Set(tagIds)]
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return false
    }
    if (uniqueTagIds.length === 0) {
      message.info('请先选择标签')
      return false
    }

    try {
      await window.api.addDocumentTags(uniqueDocIds, uniqueTagIds)
      message.success(successText || `已为 ${uniqueDocIds.length} 篇文献添加标签`)
      await Promise.all([loadDocuments(filter, { silent: true }), loadBaseData()])
      return true
    } catch (error) {
      console.error(error)
      message.error('添加标签失败')
      return false
    }
  }

  const handleQuickAddTagToDocument = async (docId: string, tagName: string) => {
    const tag = await ensureManualTag(tagName)
    if (!tag?.id) {
      message.info('请输入标签名称')
      return
    }
    await handleApplyTagsToDocuments([docId], [tag.id], `已添加标签“${tag.name}”`)
    setDocumentTagModalDocId(null)
    setDocumentTagNameInput('')
  }

  const handleApplyDocumentsToFolder = async (docIds: string[], folderId: string, options?: { keepSelection?: boolean }) => {
    const uniqueDocIds = [...new Set(docIds)]
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return false
    }
    if (!folderId) {
      message.info('请先选择文件夹')
      return false
    }

    try {
      await window.api.addDocumentsToFolder(uniqueDocIds, folderId)
      const folder = folderItems.find((item) => item.id === folderId)
      message.success(`已将 ${uniqueDocIds.length} 篇文献加入文件夹“${folder?.name || '未命名'}”`)
      await Promise.all([loadDocuments(filter, { silent: true }), loadBaseData()])
      if (!options?.keepSelection) {
        clearSelection()
      }
      return true
    } catch (error) {
      console.error(error)
      message.error('加入文件夹失败')
      return false
    }
  }

  const handleBatchApplyFolder = async () => {
    if (!batchFolderTargetId) {
      message.info('请先选择文件夹')
      return
    }
    const ok = await handleApplyDocumentsToFolder(selectedIds, batchFolderTargetId)
    if (!ok) return
    setBatchFolderModalOpen(false)
    setBatchFolderTargetId(null)
  }

  const handleSaveDocumentTagModal = async () => {
    if (!documentTagModalDocId) return
    const docId = documentTagModalDocId
    const newTagName = documentTagNameInput.trim()
    const tagIds = [...documentTagCheckedIds]

    if (newTagName) {
      const tag = await ensureManualTag(newTagName)
      if (tag?.id && !tagIds.includes(tag.id)) tagIds.push(tag.id)
      await loadBaseData()
    }

    if (tagIds.length === 0) {
      message.info('请先选择标签或输入新标签')
      return
    }

    const ok = await handleApplyTagsToDocuments([docId], tagIds, `已为文献添加 ${tagIds.length} 个标签`)
    if (!ok) return
    setDocumentTagModalDocId(null)
    setDocumentTagNameInput('')
    setDocumentTagCheckedIds([])
    setDocumentTagSearch('')
  }

  const handleAddBatchNewTag = async () => {
    const tag = await ensureManualTag(batchNewTagName)
    if (!tag?.id) {
      message.info('请输入标签名称')
      return
    }
    setBatchNewTagName('')
    setBatchTagCheckedIds((current) => current.includes(tag.id) ? current : [...current, tag.id])
    await loadBaseData()
  }

  const handleBatchApplyTags = async () => {
    const newTagName = batchNewTagName.trim()
    const tagIds = [...batchTagCheckedIds]
    if (newTagName) {
      const tag = await ensureManualTag(newTagName)
      if (tag?.id && !tagIds.includes(tag.id)) tagIds.push(tag.id)
      await loadBaseData()
    }

    const ok = await handleApplyTagsToDocuments(selectedIds, tagIds, `已为 ${selectedIds.length} 篇文献添加标签`)
    if (!ok) return
    setBatchTagModalOpen(false)
    setBatchTagCheckedIds([])
    setBatchNewTagName('')
  }

  const applySubmittedDocumentDeletion = useCallback((deletedIds: string[], exitBatchMode: boolean) => {
    const uniqueDeletedIds = Array.from(new Set(deletedIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDeletedIds.length === 0) return
    const deletedIdSet = new Set(uniqueDeletedIds)
    const previousDocuments = documentsRef.current
    const nextDocuments = previousDocuments.filter((document) => !deletedIdSet.has(document.id))
    const removedLoadedCount = previousDocuments.length - nextDocuments.length
    const nextDocumentTotal = Math.max(0, documentTotal - uniqueDeletedIds.length)
    documentsRef.current = nextDocuments
    listOffsetRef.current = Math.max(0, listOffsetRef.current - removedLoadedCount)
    patchLibraryWarmCache(currentLibraryScopeKey, {
      documents: nextDocuments,
      documentTotal: nextDocumentTotal,
      listOffset: listOffsetRef.current,
      listHasMore: listHasMoreRef.current,
    })
    libraryContentRef.current
      ?.querySelectorAll<HTMLElement>('[data-library-document-card="true"]')
      .forEach((card) => {
        if (!deletedIdSet.has(String(card.dataset.documentId || ''))) return
        card.hidden = true
      })
    window.requestAnimationFrame(() => {
      startTransition(() => {
        setDocumentTotal(nextDocumentTotal)
        removeDocumentsFromList(uniqueDeletedIds)
        if (exitBatchMode) setBatchMode(false)
      })
    })
  }, [currentLibraryScopeKey, documentTotal, removeDocumentsFromList])

  const handleDelete = async (event: StopPropagationEvent, docId: string) => {
    event.stopPropagation()
    try {
      const success = await window.api.deleteDocument(docId)
      if (success) {
        applySubmittedDocumentDeletion([docId], false)
        message.success('已提交后台删除')
      }
    } catch (error) {
      console.error(error)
      message.error('删除文献失败')
    }
  }

  const handleCleanupPdfAssets = async (doc: DocumentItem) => {
    try {
      const result = await window.api.cleanupPdfAssets(doc.id)
      updateDocumentInList(doc.id, { file_path: null })
      await loadDocuments(filter, { silent: true })
      if (result.cleaned) {
        message.success(`已删除原图副本和页图缓存，释放 ${formatBytes(result.bytesFreed)}`)
      } else {
        message.info('这篇文献没有可清理的本地原图副本')
      }
    } catch (error) {
      console.error(error)
      message.error((error as Error)?.message || '删除原图失败')
    }
  }

  const handleRestorePdfAssets = async (doc: DocumentItem) => {
    try {
      message.loading({ content: `正在补回“${doc.title || '未命名文献'}”的原文…`, key: `restore-pdf-${doc.id}`, duration: 0 })
      const result = await window.api.restorePdfForDocument(doc.id)
      if (result?.restored) {
        message.success({ content: '原文已补回，可以进入校对模式', key: `restore-pdf-${doc.id}` })
        await loadDocuments(filter, { silent: true })
      } else {
        message.warning({ content: result?.error || '未在 PDF 原件仓库找到同内容文件', key: `restore-pdf-${doc.id}`, duration: 6 })
      }
    } catch (error) {
      console.error(error)
      message.error({ content: (error as Error)?.message || '补回原文失败', key: `restore-pdf-${doc.id}` })
    }
  }

  const handleToggleFavorite = async (doc: DocumentItem) => {
    try {
      const nextValue = doc.is_favorite !== 1
      await window.api.toggleFavorite(doc.id, nextValue)
      updateDocumentInList(doc.id, {
        is_favorite: nextValue ? 1 : 0,
        favorite_at: nextValue ? new Date().toISOString() : null
      })
    } catch (error) {
      console.error(error)
      message.error('更新星标失败')
    }
  }

  const handleSetReadStatus = async (docId: string, readStatus: ReadStatus) => {
    try {
      await window.api.setReadStatus(docId, readStatus)
      updateDocumentInList(docId, { read_status: readStatus })
      message.success('阅读状态已更新')
    } catch (error) {
      console.error(error)
      message.error('更新阅读状态失败')
    }
  }

  const handleSetRating = async (docId: string, rating: number | null) => {
    try {
      await window.api.setRating(docId, rating)
      updateDocumentInList(docId, { rating })
      message.success('评分已更新')
    } catch (error) {
      console.error(error)
      message.error('更新评分失败')
    }
  }

  const handleAiExtractForDoc = async (docId: string) => {
    try {
      message.loading({ content: 'AI 正在提取并写入元数据…', key: 'ai-extract', duration: 0 })
      const result = await window.api.autoExtract(docId)
      if (result && Object.keys(result).length > 0) {
        message.success({ content: 'AI 提取完成，元数据和标签已自动写入', key: 'ai-extract' })
      } else {
        message.warning({ content: 'AI 未提取到有效元数据', key: 'ai-extract' })
      }
      await Promise.all([loadDocuments(), loadBaseData()])
    } catch (error: unknown) {
      console.error(error)
      message.error({ content: `AI 提取失败：${getErrorMessage(error, '未知错误')}`, key: 'ai-extract' })
    }
  }

  const handleTranslateBook = async (doc: DocumentItem, options: BookTranslationOptions = {}) => {
    const normalizedOptions: BookTranslationOptions = {
      style: DEFAULT_TRANSLATION_STYLE,
      mode: 'balanced',
      ...options,
    }
    const isClearCache = Boolean(normalizedOptions.clearCache)
    const isRetryFailedOnly = Boolean(normalizedOptions.retryFailedOnly)

    const preparingText = isClearCache
      ? '正在清除本书翻译缓存'
      : isRetryFailedOnly
        ? '准备重试失败页对照翻译'
        : '准备整书对照翻译'
    const nextInfo: BookTranslationProgressInfo = {
      docId: doc.id,
      status: 'processing',
      progress: 0,
      message: preparingText,
      updatedAt: Date.now(),
    }
    setBookTranslationProgressByDoc((current) => ({
      ...current,
      [doc.id]: nextInfo,
    }))
    message.loading({ content: `${preparingText}：“${doc.title || '未命名文献'}”…`, key: `book-translation-${doc.id}`, duration: 0 })

    try {
      const result = await window.api.translateBook(doc.id, normalizedOptions)
      if (result?.status === 'running') {
        message.info({ content: '这本书已经在翻译中', key: `book-translation-${doc.id}` })
      } else if (isClearCache) {
        message.success({ content: '已开始清除本书翻译缓存', key: `book-translation-${doc.id}`, duration: 4 })
      } else if (isRetryFailedOnly) {
        message.success({ content: '已在文献库后台重试失败页，会继续复用已有缓存', key: `book-translation-${doc.id}`, duration: 4 })
      } else {
        message.success({ content: '已在文献库后台开始整书对照翻译，进度会显示在外面', key: `book-translation-${doc.id}`, duration: 4 })
      }
    } catch (error: unknown) {
      console.error(error)
      const errorMessage = getErrorMessage(error, '启动整书翻译失败')
      setBookTranslationProgressByDoc((current) => ({
        ...current,
        [doc.id]: {
          ...nextInfo,
          status: 'error',
          errorMessage,
          message: errorMessage,
          updatedAt: Date.now(),
        },
      }))
      message.error({ content: errorMessage, key: `book-translation-${doc.id}`, duration: 6 })
    }
  }

  const handleAddToFolder = async (docId: string, folderId: string) => {
    try {
      await window.api.addDocumentToFolder(docId, folderId)
      const folder = folders.find((item) => item.id === folderId)
      message.success(`已加入文件夹“${folder?.name || '未命名'}”`)
      await Promise.all([loadDocuments(filter, { silent: true }), loadBaseData()])
    } catch (error) {
      console.error(error)
      message.error('加入文件夹失败')
    }
  }

  const handleRemoveFromFolder = async (docId: string, folderId: string) => {
    try {
      await window.api.removeDocumentFromFolder(docId, folderId)
      const folder = folders.find((item) => item.id === folderId)
      message.success(`已从文件夹“${folder?.name || '未命名'}”移出`)
      await Promise.all([loadDocuments(filter, { silent: true }), loadBaseData()])
    } catch (error) {
      console.error(error)
      message.error('移出文件夹失败')
    }
  }

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) {
      message.info('请先选择文献')
      return
    }

    try {
      const targetIds = [...selectedIds]
      const result = await window.api.deleteDocumentsBatch(targetIds)
      applySubmittedDocumentDeletion(result.deletedIds, true)
      if (result.failedIds.length > 0) {
        message.warning(`已提交 ${result.successCount} 篇后台删除，${result.failedIds.length} 篇提交失败`)
      } else {
        message.success(`已提交 ${result.successCount} 篇文献后台删除`)
      }
    } catch (error) {
      console.error('[Library] 批量删除文献失败:', error)
      message.error('批量删除文献失败')
    }
  }

  const handleDeleteZeroPageDocuments = () => {
    Modal.confirm({
      title: '清除零页文献',
      content: '将扫描并提交后台删除所有页数为 0 的文献。适合清理导入或 OCR 异常后留下的空记录；不会阻塞当前界面。',
      okText: '清除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const result = await window.api.deleteZeroPageDocuments()
          removeDocumentsFromList(result.deletedIds)
          if (result.successCount === 0) {
            message.info('没有发现零页文献')
          } else if (result.failedIds.length > 0) {
            message.warning(`已提交 ${result.successCount} 篇零页文献后台删除，${result.failedIds.length} 篇提交失败`)
          } else {
            message.success(`已提交 ${result.successCount} 篇零页文献后台删除`)
          }
          clearSelection()
          await loadDocuments(filter, { silent: true })
          scheduleHealthReportRefresh(0)
        } catch (error) {
          console.error('[Library] 清除零页文献失败:', error)
          message.error(getErrorMessage(error, '清除零页文献失败'))
        }
      },
    })
  }

  const handleBatchCleanupPdfAssets = () => {
    const targets = documents.filter((doc) => selectedIdSet.has(doc.id) && getPdfAssetState(doc) === 'available')
    if (targets.length === 0) {
      message.info('已选文献中没有可删除的本地原文件')
      return
    }

    Modal.confirm({
      title: '批量删除原文件',
      content: `将删除 ${targets.length} 篇文献的软件目录内 PDF 副本和页图缓存；不会删除 OCR 文本，也不会修改 PDF 原件仓库。`,
      okText: '删除原文件',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        let successCount = 0
        let freed = 0
        for (const doc of targets) {
          try {
            const result = await window.api.cleanupPdfAssets(doc.id)
            if (result?.cleaned) {
              successCount += 1
              freed += Number(result.bytesFreed || 0)
            }
          } catch (error) {
            console.error(`[Library] 批量删除原文件失败: ${doc.id}`, error)
          }
        }
        message.success(`已清理 ${successCount} 篇文献原文件，释放 ${formatBytes(freed)}`)
        await loadDocuments(filter, { silent: true })
      },
    })
  }

  const handleBatchRestorePdfAssets = async () => {
    const targets = documents.filter((doc) => selectedIdSet.has(doc.id) && getPdfAssetState(doc) === 'text_only')
    if (targets.length === 0) {
      message.info('已选文献中没有需要补回的原文')
      return
    }

    message.loading({ content: `正在补回 ${targets.length} 篇文献原文…`, key: 'batch-restore-pdf', duration: 0 })
    let restoredCount = 0
    let failedCount = 0
    for (const doc of targets) {
      try {
        const result = await window.api.restorePdfForDocument(doc.id)
        if (result?.restored) restoredCount += 1
        else failedCount += 1
      } catch (error) {
        failedCount += 1
        console.error(`[Library] 批量补回原文失败: ${doc.id}`, error)
      }
    }
    if (restoredCount > 0) {
      message.success({ content: `已补回 ${restoredCount} 篇原文${failedCount ? `，${failedCount} 篇未找到` : ''}`, key: 'batch-restore-pdf', duration: 5 })
    } else {
      message.warning({ content: '未能补回原文，请检查 PDF 原件仓库索引', key: 'batch-restore-pdf', duration: 6 })
    }
    await loadDocuments(filter, { silent: true })
  }

  const handleBatchExport = async (format: DocumentExportFormat) => {
    if (selectedIds.length === 0) {
      message.info('请先选择文献')
      return
    }

    const names: Record<DocumentExportFormat, string> = {
      markdown: 'Markdown',
      'tei-xml': 'TEI-XML',
      'page-xml': 'PAGE XML',
      'paddle-json': 'Paddle JSON',
      txt: 'TXT',
      'reading-pdf': '阅读模式 PDF',
      'layout-pdf': '排版模式 PDF',
      'layout-searchable-pdf': '原图可搜索 PDF',
    }

    message.loading({ content: `正在准备导出 ${selectedIds.length} 篇文献…`, key: 'batch-export', duration: 0 })
    try {
      const result = await window.api.exportDocumentsBatch(selectedIds, format, getFacsimileExportOptions(format))
      if (result?.canceled) {
        message.destroy('batch-export')
        return
      }

      if (result.failedCount > 0) {
        message.warning({
          content: `已导出 ${result.successCount} 篇，失败 ${result.failedCount} 篇。目录：${result.directoryPath || ''}`,
          key: 'batch-export',
          duration: 8,
        })
      } else {
        message.success({
          content: `已批量导出 ${result.successCount} 篇为 ${names[format]}`,
          key: 'batch-export',
          duration: 5,
        })
      }
    } catch (error) {
      console.error(error)
      message.error({ content: `批量导出失败：${(error as Error)?.message || '未知错误'}`, key: 'batch-export', duration: 6 })
    }
  }

  const initializePdfPagesLazily = async (docId: string, filePath: string, fileIndex: number, totalFiles: number, pageCount?: number) => {
    const importedPageCount = Math.max(0, Math.round(Number(pageCount || 0)))
    if (importedPageCount <= 0) {
      setImportProgressText(`正在读取第 ${fileIndex + 1}/${totalFiles} 个 PDF 的页数`)
      const info = await getPdfFileInfo(filePath)
      await window.api.initializePdfPages(docId, info.pageCount)
    }

    try {
      setImportProgressText(`正在生成第 ${fileIndex + 1}/${totalFiles} 个 PDF 的首页预览`)
      // Thumbnail scale keeps bulk import from saturating renderer CPU/GPU.
      const firstPage = await renderPdfFilePageToImage(filePath, 1, PDF_PREVIEW_THUMBNAIL_SCALE)
      await window.api.cachePageImage(docId, 1, firstPage.dataUrl)
    } catch (error) {
      console.warn('[Library] PDF 首页预览生成失败，稍后打开文档时会重试', error)
    }
  }

  const preparePdfPagesForOcrAfterImport = async (docId: string, filePath: string, fileIndex: number, totalFiles: number, engine: OcrEngine): Promise<boolean> => {
    try {
      const result = await ensureOcrPageImages(docId, {
        sourceFilePath: filePath,
        fileIndex,
        totalFiles,
        engine,
        messageKey: 'auto-ocr',
        getEngineLabel: (value) => getOcrEngineLabel(value as OcrEngine),
        onProgress: (content, key) => {
          setImportProgressText(content)
          if (key) message.loading({ content, key, duration: 0 })
        },
      })
      return result.ready
    } catch (error) {
      const reason = getErrorMessage(error, '未知错误')
      console.warn('[Library] PDF OCR 页图准备失败，文献已导入但 OCR 暂不启动', error)
      await window.api.updateDocument(docId, {
        ocr_status: 'pending',
        import_status: 'stored',
        error_message: `${getOcrEngineLabel(engine)}页图准备失败：${reason}。文献已导入，可稍后点击重试处理。`,
      })
      return false
    }
  }

  const ensurePdfPageImagesForOcr = async (
    docOrId: DocumentItem | DocumentDetail | string,
    messageKey: string,
    options?: { fileIndex?: number; totalFiles?: number; engine?: OcrEngine },
  ): Promise<boolean> => {
    const docId = typeof docOrId === 'string' ? docOrId : docOrId.id
    const baseDoc = typeof docOrId === 'string' ? documentsRef.current.find((item) => item.id === docId) : docOrId
    const result = await ensureOcrPageImages(baseDoc || docId, {
      fileIndex: options?.fileIndex,
      totalFiles: options?.totalFiles,
      engine: options?.engine,
      messageKey,
      getEngineLabel: (value) => getOcrEngineLabel(value as OcrEngine),
      onProgress: (content, key) => {
        setImportProgressText(content)
        if (key) message.loading({ content, key, duration: 0 })
      },
    })
    return result.ready
  }

  const getConfiguredBatchSize = async () => {
    try {
      const rawValue = await window.api.getSetting('batch_size')
      const parsed = Number.parseInt(String(rawValue || ''), 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IMPORT_BATCH_SIZE
    } catch (error) {
      console.warn('[Library] 读取批量处理数量失败，使用默认值', error)
      return DEFAULT_IMPORT_BATCH_SIZE
    }
  }

  const getConfiguredImportBatchSize = async () => {
    const batchSize = await getConfiguredBatchSize()
    return Math.max(1, Math.min(MAX_IMPORT_BATCH_SIZE, batchSize))
  }

  const runOcrInConfiguredBatches = async (
    docIds: string[],
    engine: OcrEngine,
    messageKey: string,
    options?: BatchOcrOptions,
  ) => {
    const uniqueDocIds = Array.from(new Set(docIds.filter(Boolean)))
    if (uniqueDocIds.length === 0) return 0

    const configuredBatchSize = await getConfiguredBatchSize()
    const ocrBatchSize = Math.max(1, Math.min(MAX_IMPORT_BATCH_SIZE, configuredBatchSize))
    const documentConcurrency = ocrBatchSize
    const batches = chunkArray(uniqueDocIds, ocrBatchSize)
    let successCount = 0
    let shouldRefreshAfterBatches = false
    const requiresPageImagesBeforeOcr = engine === 'local_paddle' || engine === 'vision_model' || engine === 'hybrid'

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex]
      let ocrBatch = batch
      if (requiresPageImagesBeforeOcr) {
        ocrBatch = []
        for (let docIndex = 0; docIndex < batch.length; docIndex += 1) {
          const docId = batch[docIndex]
          try {
            const ready = await ensurePdfPageImagesForOcr(docId, messageKey, {
              fileIndex: batchIndex * ocrBatchSize + docIndex,
              totalFiles: uniqueDocIds.length,
              engine,
            })
            if (ready) ocrBatch.push(docId)
          } catch (error) {
            const reason = getErrorMessage(error, '未知错误')
            console.warn('[Library] OCR 前补齐 PDF 页图失败', docId, error)
            const errorMessage = `OCR 页图补齐失败：${reason}。请确认该文献所属数据库包含 PDF/页图资源，或把原 PDF 加入“PDF 原件仓库”后重试。`
            await window.api.updateDocument(docId, {
              ocr_status: 'error',
              import_status: 'error',
              error_message: errorMessage,
            })
            updateDocumentInList(docId, {
              ocr_status: 'error',
              import_status: 'error',
              error_message: errorMessage,
            })
            shouldRefreshAfterBatches = true
          }
          await delay(0)
        }
      }
      if (ocrBatch.length === 0) {
        scheduleImportListRefresh()
        continue
      }
      message.loading({
        content: getOcrBatchProgressMessage(getOcrEngineLabel(engine), batchIndex + 1, batches.length, ocrBatchSize, documentConcurrency),
        key: messageKey,
        duration: 0,
      })
      successCount += await window.api.batchOcr(ocrBatch, { engine, forceFullRerun: options?.forceFullRerun, concurrency: documentConcurrency })
      shouldRefreshAfterBatches = true
      scheduleImportListRefresh()
      await delay(0)
    }

    if (shouldRefreshAfterBatches) {
      cancelScheduledImportListRefresh()
      await loadDocuments(filter, { silent: true })
    }
    return successCount
  }

  const handleCancelOcr = async (docId: string, event?: MouseEvent<HTMLElement>) => {
    event?.stopPropagation()
    setOcrProgressByDoc((current) => ({
      ...current,
      [docId]: {
        ...(current[docId] || { docId, status: 'processing', progress: 0 }),
        docId,
        status: 'canceled',
        phase: 'canceled',
        message: '正在停止 OCR 上传...',
        errorMessage: 'OCR 已取消',
        canceled: true,
        updatedAt: Date.now(),
      },
    }))
    message.loading({ content: '正在停止 OCR 上传...', key: `ocr-progress-${docId}`, duration: 0 })
    try {
      await window.api.cancelOcr(docId)
      message.info({ content: '已取消 OCR，已完成页面会保留；该文献不会再被旧队列自动续跑', key: `ocr-progress-${docId}`, duration: 4 })
      updateDocumentInList(docId, { ocr_status: 'pending', import_status: 'stored', error_message: 'OCR 已取消' })
    } catch (error) {
      console.error('[Library] 取消 OCR 失败', error)
      message.error({ content: `取消 OCR 失败：${getErrorMessage(error, '未知错误')}`, key: `ocr-progress-${docId}`, duration: 5 })
    }
  }

  const handleCancelAllPendingOcr = async () => {
    message.loading({ content: '正在停止全部 OCR 队列…', key: 'ocr-cancel-all', duration: 0 })
    try {
      const result = await window.api.cancelAllPendingOcr()
      setOcrProgressByDoc((current) => {
        const next: Record<string, OcrProgressInfo> = {}
        Object.entries(current).forEach(([docId, info]) => {
          if (info.status === 'queued' || info.status === 'processing' || info.phase === 'queued' || info.phase === 'ocr' || info.phase === 'saving') {
            next[docId] = {
              ...info,
              status: 'canceled',
              phase: 'canceled',
              message: 'OCR 已取消',
              errorMessage: 'OCR 已取消',
              canceled: true,
              updatedAt: Date.now(),
            }
          } else {
            next[docId] = info
          }
        })
        ocrProgressByDocRef.current = next
        return next
      })
      message.success({
        content: `已停止 OCR 队列：取消 ${result.canceledDocuments} 篇文献、${result.canceledJobs} 个后台任务。已完成页面会保留。`,
        key: 'ocr-cancel-all',
        duration: 6,
      })
      message.destroy(OCR_ACTIVITY_MESSAGE_KEY)
      await loadDocuments(filter, { silent: true })
    } catch (error) {
      console.error('[Library] 全部停止 OCR 失败', error)
      message.error({ content: `全部停止 OCR 失败：${getErrorMessage(error, '未知错误')}`, key: 'ocr-cancel-all', duration: 6 })
    }
  }

  const startPdfImageWorkflowQueue = (items: PdfPreviewQueueItem[], options?: { delayMs?: number }) => {
    if (items.length === 0) return

    const runQueue = (queueItems: PdfPreviewQueueItem[]) => void (async () => {
      let pendingPreviewRefreshCount = 0
      for (let index = 0; index < queueItems.length; index += 1) {
        const item = queueItems[index]
        try {
          await initializePdfPagesLazily(item.docId, item.filePath, item.fileIndex, item.totalFiles, item.pageCount)
        } catch (error) {
          console.warn('[Library] PDF 页面/预览后台初始化失败，OCR 仍会继续使用原始 PDF', error)
          await window.api.updateDocument(item.docId, {
            error_message: `PDF 页面预览后台生成失败：${(error as Error)?.message || '未知错误'}。OCR 将继续使用原始 PDF。`,
          })
        }
        pendingPreviewRefreshCount += 1
        if (
          pendingPreviewRefreshCount >= PDF_PREVIEW_LIST_REFRESH_BATCH_SIZE
          || index === queueItems.length - 1
        ) {
          pendingPreviewRefreshCount = 0
          scheduleImportListRefresh()
        }
        await delay(0)
      }
    })()

    const delayMs = Math.max(0, Math.round(Number(options?.delayMs || 0)))
    if (delayMs <= 0) {
      runQueue(items)
      return
    }

    deferredPdfPreviewQueueRef.current.push(...items)
    if (deferredPdfPreviewTimerRef.current) return
    deferredPdfPreviewTimerRef.current = window.setTimeout(() => {
      deferredPdfPreviewTimerRef.current = null
      const queueItems = deferredPdfPreviewQueueRef.current.splice(0)
      runQueue(queueItems)
    }, delayMs)
  }

  const getQueuedImportFileCount = () => importQueueRef.current.reduce((sum, job) => sum + job.filePaths.length, 0)

  const refreshImportQueueLength = () => {
    setImportQueueLength(getQueuedImportFileCount())
  }

  const normalizeImportQueuePath = (filePath: string) => filePath.trim().toLowerCase()

  const countSettledImportBatchPaths = (
    batch: string[],
    results: ImportBatchQueueResult[],
  ): number => {
    if (batch.length === 0 || results.length === 0) return 0
    const pendingKeys = batch.map(normalizeImportQueuePath)
    let settled = 0
    for (const item of results) {
      const key = normalizeImportQueuePath(item.result.sourceGrantId || item.grantId || '')
      if (!key) continue
      const index = pendingKeys.indexOf(key)
      if (index < 0) continue
      pendingKeys.splice(index, 1)
      settled += 1
    }
    return settled
  }

  const rebuildQueuedImportPathSet = () => {
    queuedImportFilePathsRef.current.clear()
    importQueueRef.current.forEach((job) => {
      job.filePaths.map(normalizeImportQueuePath).forEach((filePath) => {
        if (filePath) queuedImportFilePathsRef.current.add(filePath)
      })
    })
  }

  const getLoadedImportBaseNames = () => {
    const existingNames = new Set<string>()
    documentsRef.current.forEach((doc) => {
      if (doc.title) existingNames.add(doc.title.toLowerCase())
      if (doc.file_path) {
        const existingName = doc.file_path.split(/[/\\]/).pop() || ''
        existingNames.add(existingName.replace(/\.[^.]+$/, '').toLowerCase())
      }
    })
    return existingNames
  }

  const filterRestoredImportFilePaths = (filePaths: string[]): string[] => {
    const restorableExistingNames = new Set<string>()
    documentsRef.current.forEach((doc) => {
      if (doc.import_status === 'error' || doc.import_status === 'processing' || doc.import_status === 'deleting') return
      if (doc.title) restorableExistingNames.add(doc.title.toLowerCase())
      if (doc.file_path) {
        const existingName = doc.file_path.split(/[/\\]/).pop() || ''
        restorableExistingNames.add(existingName.replace(/\.[^.]+$/, '').toLowerCase())
      }
    })
    return filePaths.filter((filePath) => {
      const fileName = filePath.split(/[/\\]/).pop() || ''
      if (fileName.toLowerCase().endsWith('.pdf')) return true
      const baseName = fileName.replace(/\.[^.]+$/, '').toLowerCase()
      return !restorableExistingNames.has(baseName)
    })
  }

  const serializeImportQueueJob = (job: ImportQueueJob): PersistedImportQueueJob | null => {
    const isReauthorization = Array.isArray(job.remainingAuthorizationLabels)
    const hasUndiscoveredSources = job.authorizationHasUndiscoveredSources === true || !job.selectionDone
    const sourceLabels = isReauthorization
      ? job.remainingAuthorizationLabels || []
      : hasUndiscoveredSources
        ? job.sourceLabels
        : [...(job.displayNames?.values() || [])]
    const pendingCount = job.filePaths.length
      + (isReauthorization ? sourceLabels.length : 0)
      + (hasUndiscoveredSources ? 1 : 0)
    if (pendingCount === 0) return null
    return {
      id: job.id,
      selectionId: null,
      sourceLabels,
      pendingCount,
      folderId: job.folderId || null,
      engine: job.engine,
      authorizationStatus: 'authorization-required',
      hasUndiscoveredSources,
    }
  }

  const buildImportQueueSnapshot = (): PersistedImportQueueState | null => {
    const activeJobs = [
      ...(activeImportJobRef.current ? [activeImportJobRef.current] : []),
      ...importQueueRef.current,
    ].map(serializeImportQueueJob).filter((job): job is PersistedImportQueueJob => Boolean(job))
    const jobs = [...authorizationRequiredJobsRef.current, ...activeJobs]

    if (jobs.length === 0) return null
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      jobs,
    }
  }

  const clearLegacyPersistedImportQueue = () => {
    try {
      window.localStorage.removeItem(LIBRARY_IMPORT_QUEUE_STORAGE_KEY)
    } catch {
      // Ignore legacy storage cleanup failures.
    }
  }

  const enqueueImportQueuePersistence = (task: () => Promise<unknown>) => {
    importQueuePersistenceChainRef.current = importQueuePersistenceChainRef.current
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        console.warn('[Library] Failed to persist import queue', error)
      })
    return importQueuePersistenceChainRef.current
  }

  const replaceAuthorizationRequiredJobs = (jobs: LibraryImportQueueJobSnapshotV2[]) => {
    authorizationRequiredJobsRef.current = jobs
    setAuthorizationRequiredJobs(jobs)
  }

  const persistImportQueueSnapshot = () => {
    const snapshot = buildImportQueueSnapshot()
    void enqueueImportQueuePersistence(() => window.api.saveImportQueueState(snapshot))
    if (snapshot) clearLegacyPersistedImportQueue()
  }

  const clearPersistedImportQueue = () => {
    void enqueueImportQueuePersistence(() => window.api.clearImportQueueState())
    clearLegacyPersistedImportQueue()
  }

  const getLegacyPersistedImportQueueJobs = (): LibraryImportQueueJobSnapshotV2[] => {
    try {
      const raw = window.localStorage.getItem(LIBRARY_IMPORT_QUEUE_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as { version?: unknown; jobs?: Array<Record<string, unknown>> }
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) return []
      return parsed.jobs.map((job, index) => ({
        id: Number(job.id || 0) || Date.now() + index,
        selectionId: null,
        sourceLabels: [],
        pendingCount: Array.isArray(job.filePaths) ? job.filePaths.length : 1,
        folderId: typeof job.folderId === 'string' ? job.folderId : null,
        engine: isOcrEngine(job.engine) ? job.engine : 'paddle',
        authorizationStatus: 'authorization-required',
        hasUndiscoveredSources: true,
      }))
    } catch (error) {
      console.warn('[Library] Failed to restore legacy import queue', error)
      return []
    }
  }

  const getPersistedImportAuthorizationRequiredJobs = async (): Promise<LibraryImportQueueJobSnapshotV2[]> => {
    try {
      const parsed = await window.api.getImportQueueState()
      if (parsed?.version === 2) return parsed.jobs
      return getLegacyPersistedImportQueueJobs()
    } catch (error) {
      console.warn('[Library] Failed to restore import queue', error)
      return getLegacyPersistedImportQueueJobs()
    }
  }

  const processImportJob = async (job: ImportQueueJob) => {
    const { folderId, folderAssignments, engine } = job
    const totalFileCount = job.filePaths.length
    if (totalFileCount === 0) return
    setImportProgressText(`准备导入 ${totalFileCount} 个文件`)
    message.loading({ content: '正在排队导入文献…', key: 'import', duration: 0 })

    try {
      const importBatchSize = await getConfiguredImportBatchSize()
      const importBatches = chunkArray([...job.filePaths], importBatchSize)
      const previewAutoOcrBackground = await window.api.getSetting('auto_ocr_after_import')
      const shouldAttemptAutoOcrForPreview = previewAutoOcrBackground !== 'false'
      const previewAutoOcrConfigReady = shouldAttemptAutoOcrForPreview ? await hasOcrEngineConfig(engine) : false
      const shouldDeferImportPdfPreview = shouldAttemptAutoOcrForPreview && previewAutoOcrConfigReady
      const autoOcrBatchSize = await getConfiguredBatchSize()
      let autoOcrTask: Awaited<ReturnType<typeof window.api.createImportAutoOcrTask>> | null = null
      let autoOcrTaskJobId: string | null = null
      let autoOcrCandidateCount = 0
      let persistedAutoOcrCount = 0
      const ensureAutoOcrTask = async () => {
        if (!autoOcrTask) {
          autoOcrTask = await window.api.createImportAutoOcrTask({
            engine,
            batchSize: autoOcrBatchSize,
            sourceImportJobId: String(job.id),
          })
          autoOcrTaskJobId = autoOcrTask.jobId
        }
        return autoOcrTask
      }
      let importedCount = 0
      let restoredDuplicateCount = 0
      let skippedDuplicateCount = 0
      let compressedPdfCount = 0
      let compressedPdfBytesSaved = 0
      const failedResults: ImportDocumentResult[] = []

      const processImportedBatchResults = async (
        queuedResults: ImportBatchQueueResult[],
      ): Promise<{
        pdfPreviewQueue: PdfPreviewQueueItem[]
        deferredPdfPreviewQueue: PdfPreviewQueueItem[]
        autoOcrItems: Array<{ docId: string; sourceOrder: number; sourceType: string | null }>
      }> => {
        const pdfPreviewQueue: PdfPreviewQueueItem[] = []
        const deferredPdfPreviewQueue: PdfPreviewQueueItem[] = []
        const autoOcrItems: Array<{ docId: string; sourceOrder: number; sourceType: string | null }> = []
        const folderAssociationMap = new Map<string, string[]>()
        const queueFolderAssociation = (docId: string, targetFolderId: string | null) => {
          if (!docId || !targetFolderId) return
          const current = folderAssociationMap.get(targetFolderId) || []
          current.push(docId)
          folderAssociationMap.set(targetFolderId, current)
        }

        for (const item of queuedResults) {
          const { result, grantId, fileIndex } = item
          if (!result.success) {
            failedResults.push(result)
            continue
          }
          const targetFolderId = (grantId && folderAssignments?.get(grantId)) || folderId || null

          if (result.sourceType === 'restored-pdf') {
            restoredDuplicateCount += 1
            queueFolderAssociation(result.id, targetFolderId)
            continue
          }

          if (result.sourceType === 'duplicate-pdf') {
            skippedDuplicateCount += 1
            queueFolderAssociation(result.id, targetFolderId)
            continue
          }

          queueFolderAssociation(result.id, targetFolderId)

          if (!grantId) continue

          if (result.sourceType === 'paddle-json' || result.sourceType === 'ebook-text') {
            importedCount += 1
            continue
          }

          if (result.pdfCompression?.compressed) {
            compressedPdfCount += 1
            compressedPdfBytesSaved += Number(result.pdfCompression.savedBytes || 0)
          }

          const pdfWorkPath = result.storedPath || ''
          if (pdfWorkPath.toLowerCase().endsWith('.pdf')) {
            importedCount += 1
            autoOcrCandidateCount += 1
            let readyForAutoOcr = true
            if (previewAutoOcrConfigReady && engine !== 'paddle') {
              message.loading({
                content: `正在准备${getOcrEngineLabel(engine)}页图：${fileIndex + 1}/${totalFileCount}`,
                key: 'auto-ocr',
                duration: 0,
              })
              readyForAutoOcr = await preparePdfPagesForOcrAfterImport(result.id, pdfWorkPath, fileIndex, totalFileCount, engine)
            }
            if (previewAutoOcrConfigReady && readyForAutoOcr) {
              autoOcrItems.push({ docId: result.id, sourceOrder: fileIndex, sourceType: result.sourceType || 'pdf-file' })
            }
            if (engine !== 'local_paddle' && engine !== 'vision_model' && engine !== 'hybrid') {
              const previewItem = { docId: result.id, filePath: pdfWorkPath, fileIndex, totalFiles: totalFileCount, pageCount: result.pageCount }
              const bulkImport = totalFileCount >= BULK_IMPORT_PREVIEW_DEFER_FILE_COUNT
              const largePdf = Number(result.pageCount || 0) >= LARGE_PDF_PREVIEW_DEFER_PAGE_COUNT
              // Keep only a small eager preview window so bulk import stays interactive.
              if (largePdf || bulkImport || pdfPreviewQueue.length >= MAX_EAGER_PDF_PREVIEW_PER_BATCH) {
                deferredPdfPreviewQueue.push(previewItem)
              } else {
                pdfPreviewQueue.push(previewItem)
              }
            }
          } else {
            importedCount += 1
            if (result.ocrReady || result.sourceType === 'image-file') {
              autoOcrCandidateCount += 1
              if (previewAutoOcrConfigReady) {
                autoOcrItems.push({ docId: result.id, sourceOrder: fileIndex, sourceType: result.sourceType || null })
              }
            }
          }
        }

        for (const [targetFolderId, docIds] of folderAssociationMap.entries()) {
          const uniqueDocIds = Array.from(new Set(docIds))
          const associationBatches = chunkArray(uniqueDocIds, importBatchSize)
          for (let batchIndex = 0; batchIndex < associationBatches.length; batchIndex += 1) {
            try {
              setImportProgressText(`正在写入文件夹归属 ${batchIndex + 1}/${associationBatches.length}`)
              await window.api.addDocumentsToFolder(associationBatches[batchIndex], targetFolderId)
            } catch (error) {
              console.error('加入导入文件夹失败', error)
            }
            await delay(0)
          }
        }

        return { pdfPreviewQueue, deferredPdfPreviewQueue, autoOcrItems }
      }

      for (let batchIndex = 0; batchIndex < importBatches.length; batchIndex += 1) {
        const batch = importBatches[batchIndex]
        const start = batchIndex * importBatchSize
        const end = Math.min(start + batch.length, totalFileCount)
        const progressText = `正在导入第 ${batchIndex + 1}/${importBatches.length} 批（${start + 1}-${end}/${totalFileCount}）`
        setImportProgressText(progressText)
        message.loading({ content: progressText, key: 'import', duration: 0 })
        const batchQueuedResults: ImportBatchQueueResult[] = []

        try {
          const batchResults = await window.api.importDocuments(batch, { ocrEngine: engine })
          batchResults.forEach((result, resultIndex) => {
            batchQueuedResults.push({
              result,
              grantId: result.sourceGrantId || batch[resultIndex] || '',
              fileIndex: start + resultIndex,
            })
          })
        } catch (error) {
          const errorMessage = getErrorMessage(error) || '导入失败'
          failedResults.push({
            id: '',
            title: batch[0]?.split(/[/\\]/).pop() || '导入批次',
            success: false,
            sourceGrantId: batch[0] || '',
            displayName: job.displayNames?.get(batch[0] || '') || '导入批次',
            error: errorMessage,
          })
          message.warning({ content: `当前导入批次中断：${errorMessage}。未确认完成的文件会保留在队列中。`, key: 'import', duration: 6 })
        }

        const settledBatchFileCount = countSettledImportBatchPaths(batch, batchQueuedResults)
        job.filePaths = job.filePaths.slice(settledBatchFileCount)
        persistImportQueueSnapshot()

        const { pdfPreviewQueue, deferredPdfPreviewQueue, autoOcrItems } = await processImportedBatchResults(batchQueuedResults)
        if (autoOcrItems.length > 0) {
          const task = await ensureAutoOcrTask()
          for (const appendBatch of chunkArray(autoOcrItems, 200)) {
            const appended = await window.api.appendImportAutoOcrItems(task.jobId, appendBatch)
            persistedAutoOcrCount = appended.totalCount
          }
        }

        if (settledBatchFileCount > 0) {
          const completedRefreshBatches = (importListRefreshBatchCountRef.current.get(job.id) || 0) + 1
          importListRefreshBatchCountRef.current.set(job.id, completedRefreshBatches)
          const hasMoreImportBatches = batchIndex !== importBatches.length - 1
            || Boolean(job.selectionId && !job.selectionDone)
          if (completedRefreshBatches % IMPORT_LIST_REFRESH_BATCHES === 0 && hasMoreImportBatches) {
            scheduleImportListRefresh()
          }
        }
        startPdfImageWorkflowQueue(
          pdfPreviewQueue,
          shouldDeferImportPdfPreview ? { delayMs: AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS } : undefined,
        )
        startPdfImageWorkflowQueue(deferredPdfPreviewQueue, {
          delayMs: shouldDeferImportPdfPreview
            ? Math.max(LARGE_PDF_PREVIEW_IDLE_DELAY_MS, AUTO_OCR_PDF_PREVIEW_IDLE_DELAY_MS)
            : LARGE_PDF_PREVIEW_IDLE_DELAY_MS,
        })
        await delay(0)
        if (settledBatchFileCount < batch.length) break
      }

      const duplicateCount = restoredDuplicateCount + skippedDuplicateCount
      if (importedCount > 0) {
        const duplicateNote = duplicateCount > 0
          ? `；发现 ${duplicateCount} 个重复文件，未重复导入${restoredDuplicateCount > 0 ? `，其中 ${restoredDuplicateCount} 个已补回原文` : ''}`
          : ''
        const compressionNote = compressedPdfCount > 0
          ? `；已压缩 ${compressedPdfCount} 份 PDF，节省 ${formatBytes(compressedPdfBytesSaved)}`
          : ''
        message.success({ content: `成功导入 ${importedCount} 篇文献${compressionNote}${duplicateNote}`, key: 'import' })
      } else if (duplicateCount > 0) {
        const content = restoredDuplicateCount > 0
          ? `发现 ${duplicateCount} 个重复文件，未重复导入；已为 ${restoredDuplicateCount} 篇已有文献补回原文`
          : `发现 ${duplicateCount} 个重复文件，未重复导入`
        message.warning({ content, key: 'import', duration: 6 })
      } else if (failedResults.length > 0) {
        message.error({ content: failedResults[0].error || '导入文献失败', key: 'import', duration: 6 })
      }
      if ((importedCount > 0 || duplicateCount > 0) && failedResults.length > 0) {
        message.warning({ content: `${failedResults.length} 个文件未能导入：${failedResults[0].error || '未知错误'}`, duration: 6 })
      }
      const hasMoreSelectionBatches = Boolean(job.selectionId && !job.selectionDone)
      if (!hasMoreSelectionBatches) {
        importListRefreshBatchCountRef.current.delete(job.id)
        await refreshLibraryAfterImport()
      } else if (job.filePaths.length > 0 && (importedCount > 0 || duplicateCount > 0)) {
        scheduleImportListRefresh()
      }

      if (autoOcrTaskJobId && persistedAutoOcrCount > 0) {
        const started = await window.api.startImportAutoOcrTask(autoOcrTaskJobId)
        message.success({
          content: `已持久化并启动 OCR 任务，共 ${started.totalCount} 篇；关闭软件后仍会按原顺序续跑。`,
          key: 'auto-ocr',
          duration: 6,
        })
      } else if (shouldAttemptAutoOcrForPreview && autoOcrCandidateCount > 0 && !previewAutoOcrConfigReady) {
          message.warning({
            content: engine === 'vision_model'
              ? '已导入，但未配置视觉模型 OCR；请在设置页填写端点、API Key 和模型 ID 后再重试。'
              : engine === 'hybrid'
              ? '已导入，但混合 OCR 需要同时配置 PaddleOCR Token 和视觉模型 OCR。请在设置页补齐后再重试。'
              : engine === 'local_paddle'
              ? '已导入，但本地 OCR 模型尚未安装；请在设置页下载本地 OCR 后再重试。'
              : '已导入，但未配置 PaddleOCR API Token；请在设置页填写后再点击“批量 OCR”或“重试处理”。',
            key: 'auto-ocr',
            duration: 6,
          })
      }
    } catch (error) {
      console.error(error)
      message.error({ content: `导入文献失败：${(error as Error)?.message || '未知错误'}`, key: 'import', duration: 6 })
    }
  }

  const refillImportSelectionJob = async (job: ImportQueueJob): Promise<void> => {
    if (!job.selectionId || job.selectionDone || job.filePaths.length > 0) return
    const batchResult = await window.api.readImportSelectionBatch(job.selectionId, job.nextCursor, await getConfiguredImportBatchSize())
    if (!batchResult.ok) {
      job.selectionDone = true
      message.warning(batchResult.error.message)
      return
    }
    let items = batchResult.value.items
    if (job.authorizationHasUndiscoveredSources) {
      items = items.filter((item) => job.allowedReauthorizationSourceIds?.has(item.sourceId))
    } else if (job.remainingAuthorizationLabels) {
      const matched = matchReauthorizedItems(job.remainingAuthorizationLabels, items)
      items = matched.matchedItems
      job.remainingAuthorizationLabels = matched.remainingLabels
    }
    const acceptedDirectorySourceIds = [...new Set(items.map((item) => item.sourceId))]
      .filter((sourceId) => job.directorySourceIds?.has(sourceId) && !job.sourceFolderIds?.has(sourceId))
    for (const sourceId of acceptedDirectorySourceIds) {
      const folder = await window.api.createFolderFromImportSource(job.selectionId, sourceId, job.folderId || null)
      if (folder?.id) {
        if (!job.sourceFolderIds) job.sourceFolderIds = new Map()
        job.sourceFolderIds.set(sourceId, folder.id)
      }
    }
    job.filePaths = items.map((item) => item.grantId)
    job.displayNames = new Map(items.map((item) => [item.grantId, item.displayName]))
    job.folderAssignments = new Map(items
      .map((item) => [item.grantId, job.sourceFolderIds?.get(item.sourceId)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])))
    job.nextCursor = batchResult.value.nextCursor
    job.selectionDone = batchResult.value.done
    if (batchResult.value.done) await window.api.releaseImportSelection(job.selectionId)
  }

  const drainImportQueue = async () => {
    if (importQueueRunningRef.current) return
    importQueueRunningRef.current = true
    setImporting(true)
    persistImportQueueSnapshot()

    try {
      while (importQueueRef.current.length > 0) {
        const job = importQueueRef.current.shift()
        refreshImportQueueLength()
        if (!job) continue
        activeImportJobRef.current = job
        persistImportQueueSnapshot()

        const jobPathKeys = job.filePaths.map(normalizeImportQueuePath)
        jobPathKeys.forEach((filePath) => {
          queuedImportFilePathsRef.current.delete(filePath)
          activeImportFilePathsRef.current.add(filePath)
        })

        let remainingBeforeRefill = 0
        try {
          await processImportJob(job)
        } finally {
          remainingBeforeRefill = job.filePaths.length
          await refillImportSelectionJob(job)
          if (job.filePaths.length > 0) {
            importQueueRef.current.unshift(job)
          } else if (job.selectionDone && (job.remainingAuthorizationLabels?.length || 0) > 0) {
            replaceAuthorizationRequiredJobs([
              ...authorizationRequiredJobsRef.current.filter((item) => item.id !== job.id),
              {
                id: job.id,
                selectionId: null,
                sourceLabels: job.remainingAuthorizationLabels || [],
                pendingCount: job.remainingAuthorizationLabels?.length || 0,
                folderId: job.folderId || null,
                engine: job.engine,
                authorizationStatus: 'authorization-required',
                hasUndiscoveredSources: job.authorizationHasUndiscoveredSources,
              },
            ])
          }
          activeImportJobRef.current = null
          jobPathKeys.forEach((filePath) => activeImportFilePathsRef.current.delete(filePath))
          refreshImportQueueLength()
          persistImportQueueSnapshot()
        }
        if (remainingBeforeRefill > 0) break
        if (job.filePaths.length === 0) {
          await loadBaseData()
        } else {
          scheduleBaseDataRefresh()
        }
        await delay(0)
      }
    } finally {
      importQueueRunningRef.current = false
      setImporting(false)
      setImportProgressText('')
      activeImportFilePathsRef.current.clear()
      if (importQueueRef.current.length === 0
        && !activeImportJobRef.current
        && authorizationRequiredJobsRef.current.length === 0) {
        importListRefreshBatchCountRef.current.clear()
        setImportQueueLength(0)
        queuedImportFilePathsRef.current.clear()
        clearPersistedImportQueue()
      } else {
        rebuildQueuedImportPathSet()
        refreshImportQueueLength()
      }
    }
  }

  const enqueueImportJob = (
    filePaths: string[],
    folderId?: string | null,
    folderAssignments?: Map<string, string>,
    options?: {
      engine?: OcrEngine
      selectionId?: string
      nextCursor?: string | null
      selectionDone?: boolean
      sourceLabels?: string[]
      sourceFolderIds?: Map<string, string>
      displayNames?: Map<string, string>
      remainingAuthorizationLabels?: string[]
      authorizationHasUndiscoveredSources?: boolean
      allowedReauthorizationSourceIds?: Set<string>
      directorySourceIds?: Set<string>
      jobId?: number
    },
  ) => {
    const seen = new Set<string>()
    const nextFilePaths: string[] = []

    for (const filePath of filePaths) {
      const key = normalizeImportQueuePath(filePath)
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (activeImportFilePathsRef.current.has(key) || queuedImportFilePathsRef.current.has(key)) continue
      nextFilePaths.push(filePath)
    }

    if (nextFilePaths.length === 0
      && (options?.selectionDone ?? true)
      && (options?.remainingAuthorizationLabels?.length || 0) === 0) {
      message.info({ content: '这些文件已在当前导入队列中', key: 'import-queue-duplicate', duration: 3 })
      return false
    }

    const nextAssignments = folderAssignments
      ? new Map(nextFilePaths.map((filePath) => [filePath, folderAssignments.get(filePath)]).filter((entry): entry is [string, string] => Boolean(entry[1])))
      : undefined
    if (options?.jobId) importJobSeqRef.current = Math.max(importJobSeqRef.current, options.jobId)
    const job: ImportQueueJob = {
      id: options?.jobId || (importJobSeqRef.current += 1),
      filePaths: nextFilePaths,
      selectionId: options?.selectionId || '',
      nextCursor: options?.nextCursor ?? null,
      selectionDone: options?.selectionDone ?? true,
      sourceLabels: options?.sourceLabels || [],
      sourceFolderIds: options?.sourceFolderIds,
      displayNames: options?.displayNames,
      remainingAuthorizationLabels: options?.remainingAuthorizationLabels,
      authorizationHasUndiscoveredSources: options?.authorizationHasUndiscoveredSources,
      allowedReauthorizationSourceIds: options?.allowedReauthorizationSourceIds,
      directorySourceIds: options?.directorySourceIds,
      folderId,
      folderAssignments: nextAssignments,
      engine: options?.engine || importOcrEngine,
    }

    importQueueRef.current.push(job)
    nextFilePaths.map(normalizeImportQueuePath).forEach((filePath) => queuedImportFilePathsRef.current.add(filePath))
    refreshImportQueueLength()
    persistImportQueueSnapshot()

    if (importQueueRunningRef.current) {
      message.success({ content: `已加入导入队列：${nextFilePaths.length} 个文件，将在当前任务后自动处理`, key: 'import-queued', duration: 4 })
    } else {
      message.loading({ content: `已加入导入队列：${nextFilePaths.length} 个文件`, key: 'import', duration: 0 })
    }

    void drainImportQueue()
    return true
  }

  const handleImport = async () => {
    const result = await window.api.selectImportSources()
    if (result.ok) {
      await importDroppedSources(result.value)
    } else if (result.error.code !== 'CAPABILITY_INVALID_REQUEST') {
      message.error(result.error.message)
    }
  }

  const hasOcrEngineConfig = async (engine: OcrEngine): Promise<boolean> => {
    if (engine === 'local_paddle') {
      const status = await window.api.getLocalPaddleOcrStatus()
      return status.installed
    }
    if (engine === 'paddle') return window.api.checkOcrToken()
    if (engine === 'hybrid') {
      const [paddleReady, visionReady] = await Promise.all([
        window.api.checkOcrToken(),
        window.api.checkVisionOcrConfig(),
      ])
      return paddleReady && visionReady
    }
    return window.api.checkVisionOcrConfig()
  }

  const getOcrEngineLabel = (engine: OcrEngine): string => engine === 'local_paddle' ? '本地 OCR' : engine === 'vision_model' ? '大模型 OCR' : engine === 'hybrid' ? '混合 OCR' : '飞桨 OCR'

  const importDroppedSources = async (
    selection: ImportSelection,
    targetFolderId?: string | null,
    reauthorizationJob?: LibraryImportQueueJobSnapshotV2,
  ): Promise<boolean> => {
    let ownershipTransferred = false
    try {
    const sourceMatch = reauthorizationJob?.hasUndiscoveredSources
      ? reauthorizationJob.sourceLabels.length > 0
        ? matchReauthorizedSources(reauthorizationJob.sourceLabels, selection.sources)
        : { allowedSourceIds: new Set(selection.sources.map((source) => source.sourceId)), remainingLabels: [] }
      : null
    const sourceFolderIds = new Map<string, string>()
    const directorySourceIds = new Set(selection.sources.filter((source) => source.isDirectory).map((source) => source.sourceId))
    const importBatchSize = await getConfiguredImportBatchSize()
    const batchResult = await window.api.readImportSelectionBatch(selection.selectionId, null, importBatchSize)
    if (!batchResult.ok) {
      message.error(batchResult.error.message)
      return false
    }
    let items = batchResult.value.items
    let remainingAuthorizationLabels = reauthorizationJob?.sourceLabels
      ? [...reauthorizationJob.sourceLabels]
      : undefined
    if (sourceMatch) {
      items = items.filter((item) => sourceMatch.allowedSourceIds.has(item.sourceId))
      remainingAuthorizationLabels = sourceMatch.remainingLabels
    } else if (reauthorizationJob) {
      const matched = matchReauthorizedItems(reauthorizationJob.sourceLabels, items)
      items = matched.matchedItems
      remainingAuthorizationLabels = matched.remainingLabels
    }
    const acceptedDirectorySourceIds = [...new Set(items.map((item) => item.sourceId))]
      .filter((sourceId) => directorySourceIds.has(sourceId))
    for (const sourceId of acceptedDirectorySourceIds) {
      const folder = await window.api.createFolderFromImportSource(selection.selectionId, sourceId, targetFolderId || null)
      if (folder?.id) sourceFolderIds.set(sourceId, folder.id)
    }
    const grantIds = items.map((item) => item.grantId)
    const folderAssignments = new Map(items
      .map((item) => [item.grantId, sourceFolderIds.get(item.sourceId)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])))
    if (grantIds.length === 0 && batchResult.value.done && !reauthorizationJob) {
      message.info('没有找到可导入的文件')
      return false
    }
    const replacementEstablished = enqueueImportJob(grantIds, targetFolderId || null, folderAssignments, {
      selectionId: selection.selectionId,
      nextCursor: batchResult.value.nextCursor,
      selectionDone: batchResult.value.done,
      sourceLabels: selection.sources.map((source) => source.displayName),
      sourceFolderIds,
      displayNames: new Map(items.map((item) => [item.grantId, item.displayName])),
      engine: reauthorizationJob?.engine,
      remainingAuthorizationLabels,
      authorizationHasUndiscoveredSources: reauthorizationJob?.hasUndiscoveredSources,
      allowedReauthorizationSourceIds: sourceMatch?.allowedSourceIds,
      directorySourceIds,
      jobId: reauthorizationJob?.id,
    })
    ownershipTransferred = replacementEstablished && !batchResult.value.done
    return replacementEstablished
    } finally {
      if (!ownershipTransferred) await window.api.releaseImportSelection(selection.selectionId)
    }
  }

  const promptImportQueueReauthorization = (job: LibraryImportQueueJobSnapshotV2) => {
    Modal.confirm({
      title: '继续上次未完成的导入？',
      content: `该任务还有约 ${job.pendingCount} 个文件需要重新授权。重新选择原文件或原目录后会继续处理，取消不会删除任务。`,
      okText: '重新选择',
      cancelText: '稍后处理',
      onOk: async () => {
        const result = await window.api.selectImportSources()
        if (!result.ok) return
        const replacementEstablished = await importDroppedSources(result.value, job.folderId || null, job)
        if (!replacementEstablished) return
        const nextJobs = transitionAuthorizationJobs(authorizationRequiredJobsRef.current, job.id, {
          replacementEstablished: true,
        })
        replaceAuthorizationRequiredJobs(nextJobs)
        persistImportQueueSnapshot()
        const nextJob = nextJobs[0]
        if (nextJob) window.setTimeout(() => promptImportQueueReauthorization(nextJob), 0)
      },
      onCancel: () => undefined,
    })
  }

  useEffect(() => {
    if (!libraryInitialLoadDone || restoredImportQueueRef.current) return
    restoredImportQueueRef.current = true
    let cancelled = false
    void getPersistedImportAuthorizationRequiredJobs()
      .then((jobs) => {
        if (cancelled || jobs.length === 0) return
        replaceAuthorizationRequiredJobs(jobs)
        promptImportQueueReauthorization(jobs[0])
      })
      .catch((error) => console.warn('[Library] Failed to restore import queue', error))
    return () => {
      cancelled = true
    }
  }, [libraryInitialLoadDone])

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (isDocumentDrag(event)) return
    dragCounterRef.current += 1
    if (isExternalFileDrag(event)) {
      setDragActive(true)
    }
  }

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = isDocumentDrag(event) ? 'none' : 'copy'
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (isDocumentDrag(event)) return
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounterRef.current = 0
    setDragActive(false)

    if (isDocumentDrag(event)) return

    try {
      const result = await window.api.grantDroppedImportSources(Array.from(event.dataTransfer.files))
      if (result.ok) await importDroppedSources(result.value)
      else message.error(result.error.message)
    } catch (error) {
      console.error(error)
      message.error('拖拽导入失败')
    }
  }

  useEffect(() => {
    if (importRequest === lastImportRequestRef.current) return
    lastImportRequestRef.current = importRequest
    void handleImport()
  }, [importRequest])

  useEffect(() => {
    if (!droppedImportRequest) return
    if (droppedImportRequest.id === lastDroppedImportRequestRef.current) return
    lastDroppedImportRequestRef.current = droppedImportRequest.id
    const request = droppedImportRequest
    void importDroppedSources(request.selection, request.folderId || null).finally(() => {
      onDroppedImportHandled?.(request.id)
    })
  }, [droppedImportRequest, onDroppedImportHandled])

  const handleBatchOcr = async (engine: OcrEngine = 'paddle', options?: BatchOcrOptions) => {
    const sourceIds = batchMode && selectedIds.length > 0
      ? selectedIds
      : documents.map((item) => item.id)
    const targetIds = options?.forceFullRerun
      ? sourceIds
      : sourceIds.filter((id) => {
        const doc = documents.find((item) => item.id === id)
        return doc && needsOcrWork(doc, engine)
      })
    const skippedCount = sourceIds.length - targetIds.length

    if (targetIds.length === 0) {
      message.info(options?.forceFullRerun ? '请先选择需要重新 OCR 的文献' : '当前没有需要 OCR 识别的文献')
      return
    }

    const hasConfig = await hasOcrEngineConfig(engine)
    if (!hasConfig) {
      message.warning(engine === 'local_paddle'
        ? '请先在设置页下载本地 OCR 模型。'
        : engine === 'vision_model'
        ? '请先在设置页配置视觉模型 OCR 的端点、API Key 和模型 ID。'
        : engine === 'hybrid'
        ? '混合 OCR 需要同时配置 PaddleOCR Token 和视觉模型 OCR。'
        : '请先在设置页配置 PaddleOCR API Token。')
      return
    }

    message.loading({
      content: options?.forceFullRerun
        ? `正在用${getOcrEngineLabel(engine)}重新 OCR ${targetIds.length} 篇文献…`
        : `正在用${getOcrEngineLabel(engine)}批量识别 ${targetIds.length} 篇文献${skippedCount > 0 ? `，已跳过 ${skippedCount} 篇已完成文献` : ''}…`,
      key: 'batch-ocr',
      duration: 0,
    })
    try {
      const successCount = await runOcrInConfiguredBatches(targetIds, engine, 'batch-ocr', {
        forceFullRerun: options?.forceFullRerun,
      })
      message.success({
        content: options?.forceFullRerun
          ? `${getOcrEngineLabel(engine)}重新 OCR 完成，成功处理 ${successCount} 篇文献`
          : `${getOcrEngineLabel(engine)}批量识别完成，成功处理 ${successCount} 篇文献${skippedCount > 0 ? `，跳过 ${skippedCount} 篇已完成文献` : ''}`,
        key: 'batch-ocr',
      })
    } catch (error) {
      console.error(error)
      message.error({ content: '批量 OCR 识别失败', key: 'batch-ocr' })
      await loadDocuments(filter, { silent: true })
    }
  }

  const confirmBatchForceRerunOcr = (engine: OcrEngine) => {
    const targetCount = batchMode && selectedIds.length > 0 ? selectedIds.length : documents.length
    if (targetCount === 0) {
      message.info('请先选择需要重新 OCR 的文献')
      return
    }

    message.info({
      content: `已开始用${getOcrEngineLabel(engine)}重新 OCR ${targetCount} 篇文献，会覆盖整本 OCR 结果并清空已校对文本。`,
      key: 'batch-ocr-rerun-start',
      duration: 4,
    })
    void handleBatchOcr(engine, { forceFullRerun: true })
  }

  const handleBatchMetadataExtract = async () => {
    const targetIds = batchMode && selectedIds.length > 0
      ? selectedIds
      : documents
        .filter((item) => item.ocr_status === 'completed' && item.metadata_status !== 'confirmed')
        .map((item) => item.id)

    if (targetIds.length === 0) {
      message.info('请先选择需要抓取元数据的文献，或切换到包含已 OCR 文献的列表')
      return
    }

    const confirmedCount = targetIds.filter((id) => {
      const doc = documents.find((item) => item.id === id)
      return doc?.metadata_status === 'confirmed'
    }).length

    message.loading({
      content: `正在批量抓取 ${targetIds.length} 篇文献的元数据${confirmedCount > 0 ? `，已确认元数据会自动跳过` : ''}…`,
      key: 'batch-metadata',
      duration: 0,
    })

    try {
      const result = await window.api.batchAutoExtract(targetIds)
      const summary = `成功 ${result.successCount} 篇，跳过 ${result.skippedCount} 篇，失败 ${result.failedCount} 篇`
      if (result.failedCount > 0) {
        const firstError = result.errors[0]
        message.warning({
          content: `批量抓取元数据完成：${summary}${firstError ? `。首个失败：${firstError.title || firstError.docId}：${firstError.error}` : ''}`,
          key: 'batch-metadata',
          duration: 8,
        })
      } else {
        message.success({ content: `批量抓取元数据完成：${summary}`, key: 'batch-metadata' })
      }
      await Promise.all([loadDocuments(), loadBaseData()])
    } catch (error: unknown) {
      console.error(error)
      message.error({ content: `批量抓取元数据失败：${getErrorMessage(error, '未知错误')}`, key: 'batch-metadata', duration: 6 })
    }
  }

  const handleRetryDocument = async (doc: DocumentItem) => {
    const progressInfo = resolveOcrProgressInfo(doc, ocrProgressByDoc[doc.id])
    // Only treat as finished when the document is no longer in an active OCR job.
    if (isDocumentOcrTextComplete(doc) && !isDocumentOcrJobActive(doc)) {
      message.destroy(`ocr-error-${doc.id}`)
      message.success({ content: '这篇文献 OCR 已完成，已为你刷新列表状态', key: `retry-${doc.id}`, duration: 3 })
      setOcrProgressByDoc((current) => {
        const { [doc.id]: _removed, ...rest } = current
        return rest
      })
      updateDocumentInList(doc.id, {
        ocr_status: 'completed',
        import_status: 'processed',
        error_message: null,
      })
      await window.api.updateDocument(doc.id, {
        ocr_status: 'completed',
        import_status: 'processed',
        error_message: null,
      })
      await loadDocuments(filter, { silent: true })
      return
    }

    if (isDocumentOcrJobActive(doc) || isActiveOcrProgress(progressInfo)) {
      message.info({ content: '该文献 OCR 正在继续处理中，请等待完成或先停止上传', key: `retry-${doc.id}`, duration: 4 })
      return
    }

    message.loading({ content: `正在重新处理“${doc.title || '未命名文献'}”…`, key: `retry-${doc.id}`, duration: 0 })
    message.destroy(`ocr-error-${doc.id}`)
    setOcrProgressByDoc((current) => {
      const { [doc.id]: _removed, ...rest } = current
      return rest
    })
    updateDocumentInList(doc.id, {
      ocr_status: 'pending',
      import_status: 'stored',
      error_message: null,
      retry_count: 0,
      last_retry_at: null,
    })
    try {
      await window.api.updateDocument(doc.id, {
        ocr_status: 'pending',
        import_status: 'stored',
        error_message: null,
        retry_count: 0,
        last_retry_at: null,
      })
      const latestDoc = await window.api.getDocumentLight(doc.id)
      const storedEngine = parseDocMetadata(latestDoc || doc).ocr_engine
      const retryEngine = isOcrEngine(storedEngine) ? storedEngine : undefined
      const successCount = await runOcrInConfiguredBatches([doc.id], retryEngine || 'paddle', `retry-${doc.id}`)
      if (successCount > 0) {
        message.success({ content: '重新处理完成', key: `retry-${doc.id}` })
      } else {
        message.warning({ content: '重新处理未完成，请查看失败原因后再试', key: `retry-${doc.id}`, duration: 5 })
      }
    } catch (error) {
      console.error(error)
      const reason = (error as Error)?.message || '未知错误'
      await window.api.updateDocument(doc.id, {
        import_status: 'error',
        ocr_status: 'error',
        error_message: `重试失败：${reason}`,
      })
      message.error({ content: `重试失败：${reason}`, key: `retry-${doc.id}`, duration: 6 })
      await loadDocuments(filter, { silent: true })
    } finally {
      setImportProgressText('')
    }
  }

  const handleForceRerunDocument = async (doc: DocumentItem, engine: OcrEngine) => {
    const hasConfig = await hasOcrEngineConfig(engine)
    if (!hasConfig) {
      message.warning(engine === 'local_paddle'
        ? '请先在设置页下载本地 OCR 模型。'
        : engine === 'vision_model'
        ? '请先在设置页配置视觉模型 OCR 的端点、API Key 和模型 ID。'
        : engine === 'hybrid'
        ? '混合 OCR 需要同时配置 PaddleOCR Token 和视觉模型 OCR。'
        : '请先在设置页配置 PaddleOCR API Token。')
      return
    }

    message.loading({ content: `正在用${getOcrEngineLabel(engine)}重新 OCR“${doc.title || '未命名文献'}”…`, key: `rerun-ocr-${doc.id}`, duration: 0 })
    try {
      const successCount = await runOcrInConfiguredBatches([doc.id], engine, `rerun-ocr-${doc.id}`, { forceFullRerun: true })
      if (successCount > 0) {
        message.success({ content: '整本文献已重新 OCR', key: `rerun-ocr-${doc.id}` })
      } else {
        message.warning({ content: '重新 OCR 未完成，请查看失败原因后再试', key: `rerun-ocr-${doc.id}`, duration: 5 })
      }
    } catch (error) {
      console.error(error)
      message.error({ content: `重新 OCR 失败：${(error as Error)?.message || '未知错误'}`, key: `rerun-ocr-${doc.id}`, duration: 6 })
      await loadDocuments(filter, { silent: true })
    }
  }

  const handleRetryFailedDocuments = async () => {
    const failedDocs = documents.filter((doc) => doc.import_status === 'error' || doc.ocr_status === 'error')
    if (failedDocs.length === 0) {
      message.info('当前没有处理失败的文献')
      return
    }

    message.loading({ content: `正在重试 ${failedDocs.length} 篇失败文献…`, key: 'retry-failed', duration: 0 })
    failedDocs.forEach((doc) => {
      message.destroy(`ocr-error-${doc.id}`)
    })
    const failedDocIds = new Set(failedDocs.map((doc) => doc.id))
    setOcrProgressByDoc((current) => {
      let next = current
      failedDocIds.forEach((docId) => {
        if (!(docId in next)) return
        if (next === current) next = { ...current }
        delete next[docId]
      })
      return next
    })
    updateDocumentsInList(failedDocs.map((doc) => ({
      id: doc.id,
      data: {
        ocr_status: 'pending',
        import_status: 'stored',
        error_message: null,
        retry_count: 0,
        last_retry_at: null,
      },
    })))
    try {
      for (const doc of failedDocs) {
        await window.api.updateDocument(doc.id, {
          ocr_status: 'pending',
          import_status: 'stored',
          error_message: null,
          retry_count: 0,
          last_retry_at: null,
        })
      }
      const successCount = await runOcrInConfiguredBatches(failedDocs.map((doc) => doc.id), 'paddle', 'retry-failed')
      message.success({ content: `重试完成，成功处理 ${successCount}/${failedDocs.length} 篇`, key: 'retry-failed' })
    } catch (error) {
      console.error(error)
      message.error({ content: `重试失败：${(error as Error)?.message || '未知错误'}`, key: 'retry-failed', duration: 6 })
      await loadDocuments(filter, { silent: true })
    } finally {
      setImportProgressText('')
    }
  }

  const handleBatchImport = async () => {
    if (selectedIds.length === 0) {
      message.info('请先选择文献')
      return
    }

    const targetIds = selectedIds.filter((id) => {
      const doc = documents.find((item) => item.id === id)
      return doc?.import_status === 'unstored' || doc?.import_status === 'stored'
    })

    if (targetIds.length === 0) {
      message.info('选中的文献都已经处理完成')
      return
    }

    setLoading(true)
    message.loading({ content: `正在入库 ${targetIds.length} 篇文献…`, key: 'batch-import', duration: 0 })
    try {
      for (const id of targetIds) {
        await window.api.updateDocument(id, { import_status: 'stored' })
        updateDocumentInList(id, { import_status: 'stored' })
      }

      message.success({ content: `已入库 ${targetIds.length} 篇文献`, key: 'batch-import' })

      const followEngine = importOcrEngine
      const hasConfig = await hasOcrEngineConfig(followEngine)
      if (hasConfig) {
        message.loading({ content: '正在继续执行 OCR…', key: 'batch-follow-ocr', duration: 0 })
        const count = await runOcrInConfiguredBatches(targetIds, followEngine, 'batch-follow-ocr')
        message.success({ content: `OCR 完成，成功识别 ${count} 篇文献`, key: 'batch-follow-ocr' })
      } else {
        await loadDocuments()
      }
    } catch (error) {
      console.error(error)
      message.error({ content: '批量入库失败', key: 'batch-import' })
    } finally {
      setLoading(false)
    }
  }

  const handleTaggingChange = async (docId: string, nextChecked: string[]) => {
    const previous = taggingChecked
    setTaggingChecked(nextChecked)

    const added = nextChecked.filter((id) => !previous.includes(id))
    const removed = previous.filter((id) => !nextChecked.includes(id))

    for (const tagId of added) {
      try {
        await window.api.addDocumentTag(docId, tagId)
      } catch (error) {
        console.error(error)
      }
    }

    for (const tagId of removed) {
      try {
        await window.api.removeDocumentTag(docId, tagId)
      } catch (error) {
        console.error(error)
      }
    }

    await Promise.all([loadDocuments(), loadBaseData()])
  }

  const openMetadataEditor = async (docId: string) => {
    try {
      // Metadata editor only needs document fields, not full page OCR payloads.
      const doc = await window.api.getDocumentLight(docId)
      if (!doc) throw new Error('文献不存在')
      setEditingDoc({
        id: doc.id,
        title: doc.title,
        author: doc.author,
        doc_type: doc.doc_type,
        metadata: doc.metadata,
      })
      setMetadataEditorVisible(true)
    } catch (error) {
      console.error(error)
      message.error('加载文献详情失败')
    }
  }

  const handleSaveMetadata = async (
    newMetadata: Record<string, unknown>,
    newBaseInfo: Pick<DocumentUpdatePayload, 'title' | 'author' | 'doc_type' | 'metadata_status'>,
  ) => {
    if (!editingDoc) return
    const metadata = JSON.stringify(newMetadata)
    await window.api.updateDocument(editingDoc.id, { ...newBaseInfo, metadata })
    await Promise.all([loadDocuments(), loadBaseData()])
  }

  const handleRowClick = useCallback((docId: string, event?: MouseEvent<HTMLElement>) => {
    if (suppressLibraryClickRef.current) {
      return
    }

    if (isLibraryDocumentActionTarget(event?.target || null)) {
      return
    }

    if (event?.shiftKey && lastClickedDocIdRef.current) {
      const startIndex = documents.findIndex((doc) => doc.id === lastClickedDocIdRef.current)
      const endIndex = documents.findIndex((doc) => doc.id === docId)
      if (startIndex >= 0 && endIndex >= 0) {
        const [from, to] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
        const rangeIds = documents.slice(from, to + 1).map((doc) => doc.id)
        const nextIds = new Set(event.ctrlKey || event.metaKey || batchMode ? selectedIds : [])
        rangeIds.forEach((id) => nextIds.add(id))
        setSelectedIds(documentIdOrder.filter((id) => nextIds.has(id)))
        setBatchMode(true)
        lastClickedDocIdRef.current = docId
        return
      }
    }

    if (batchMode) {
      setSelectedIds(toggleSelectionId(selectedIds, docId))
      lastClickedDocIdRef.current = docId
      return
    }

    if (event?.ctrlKey || event?.metaKey) {
      setSelectedIds(toggleSelectionId(selectedIds, docId))
      setBatchMode(true)
      lastClickedDocIdRef.current = docId
      return
    }
    lastClickedDocIdRef.current = docId
    setSelectedIds([docId])
    setBatchMode(false)
  }, [batchMode, documentIdOrder, documents, selectedIds, setSelectedIds])

  const handleDocumentOpen = useCallback((docId: string) => {
    onSelectDoc?.({ docId })
  }, [onSelectDoc])

  const openDocumentTagModal = useCallback((docId: string) => {
    const doc = documentsRef.current.find((item) => item.id === docId)
    setDocumentTagModalDocId(docId)
    setDocumentTagNameInput('')
    setDocumentTagCheckedIds(splitPipe(doc?.tag_ids))
    setDocumentTagSearch('')
  }, [])

  const getDragDocIds = useCallback((docId: string) => {
    return selectedIdSet.has(docId) && selectedIds.length > 0 ? selectedIds : [docId]
  }, [selectedIdSet, selectedIds])

  const handleDocumentDragStart = useCallback((event: DragEvent<HTMLElement>, docId: string) => {
    const docIds = getDragDocIds(docId)
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/x-gujismart-document-ids', JSON.stringify(docIds))
    event.dataTransfer.setData('text/plain', docIds.join('\n'))
  }, [getDragDocIds])

  const handleFolderDragStart = useCallback((event: DragEvent<HTMLElement>, folderId: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(FOLDER_DRAG_MIME, folderId)
    event.dataTransfer.setData('text/plain', folderId)
  }, [])

  const handleMoveFolder = useCallback(async (folderId: string, parentId: string | null, options?: { beforeId?: string | null; afterId?: string | null }) => {
    if (!folderId) return
    if (folderId === parentId) {
      message.warning('不能把文件夹移动到自己里面')
      return
    }
    if (parentId && isFolderDescendant(folderItems, parentId, folderId)) {
      message.warning('不能把文件夹移动到自己的子文件夹里面')
      return
    }

    try {
      const nextFolders = await window.api.moveFolder({
        id: folderId,
        parent_id: parentId,
        before_id: options?.beforeId || null,
        after_id: options?.afterId || null,
      })
      const stateCache = await window.api.refreshLibraryStateCache()
      const foldersWithCounts = applyLibraryStateCacheToFolders(nextFolders, stateCache)
      setFolders(foldersWithCounts)
      setUnfiledDocumentTotal(Number(stateCache.unfiledDocumentTotal || 0))
      setSmartViewCounts(stateCache.smartViewCounts)
      patchLibraryWarmCache(currentLibraryScopeKey, {
        folders: foldersWithCounts,
        smartViewCounts: stateCache.smartViewCounts,
        unfiledDocumentTotal: Number(stateCache.unfiledDocumentTotal || 0),
      })
      window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
      message.success('文件夹位置已更新')
    } catch (error) {
      message.error(getErrorMessage(error, '移动文件夹失败'))
    }
  }, [currentLibraryScopeKey, folderItems, setFolders])

  const handleFolderDrop = async (event: DragEvent<HTMLElement>, folderId: string) => {
    event.preventDefault()
    event.stopPropagation()
    setFolderDropTarget(null)

    if (isFolderDrag(event)) {
      const draggedFolderId = getDragFolderId(event)
      const targetFolder = folderItems.find((item) => item.id === folderId)
      if (!targetFolder) return
      const position = getFolderDropPosition(event)
      if (position === 'inside') {
        await handleMoveFolder(draggedFolderId, folderId)
      } else {
        await handleMoveFolder(draggedFolderId, targetFolder.parent_id || null, {
          beforeId: position === 'before' ? targetFolder.id : null,
          afterId: position === 'after' ? targetFolder.id : null,
        })
      }
      return
    }

    if (isDocumentDrag(event)) {
      const docIds = getDragDocumentIds(event)
      if (docIds.length === 0) return
      await handleApplyDocumentsToFolder(docIds, folderId, { keepSelection: true })
      return
    }

    if (!isExternalFileDrag(event)) return

    try {
      const result = await window.api.grantDroppedImportSources(Array.from(event.dataTransfer.files))
      if (result.ok) await importDroppedSources(result.value, folderId)
      else message.error(result.error.message)
    } catch (error) {
      console.error(error)
      message.error('拖拽导入到文件夹失败')
    }
  }

  const openCurrentScopeAi = (initialTab: LibraryAiTab = 'qa') => {
    if (!onOpenLibraryAi) return

    const docIds = batchMode && selectedIds.length > 0
      ? selectedIds
      : documents.map((item) => item.id)

    onOpenLibraryAi({
      scope: { type: 'documents', docIds },
      scopeLabel: batchMode && selectedIds.length > 0
        ? `当前已选文献（${selectedIds.length} 篇）`
        : `${filterTitle}已加载文献（${documents.length}/${documentTotal} 篇）`,
      initialTab
    })
  }

  const batchMenuItems: MenuProps['items'] = buildBatchMenuItems()

  const handleBatchMenu: MenuProps['onClick'] = ({ key }) => {
    if (key === 'import') void handleBatchImport()
    if (String(key).startsWith('ocr:')) void handleBatchOcr(String(key).replace('ocr:', '') as OcrEngine)
    if (String(key).startsWith('ocr_force:')) confirmBatchForceRerunOcr(String(key).replace('ocr_force:', '') as OcrEngine)
    if (key === 'metadata_extract') void handleBatchMetadataExtract()
    if (key === 'vectorize') {
      if (selectedIds.length === 0) {
        message.info('请先选择文献')
        return
      }
      void (async () => {
        try {
          const result = await window.api.enqueueDocumentsForEmbedding(selectedIds)
          if (result.queued > 0) {
            message.loading({
              content: `已入队向量化 ${result.queued} 篇${result.skipped > 0 ? `，跳过 ${result.skipped} 篇` : ''}。进度见文献卡片与「处理队列」。`,
              key: BACKGROUND_EMBEDDING_MESSAGE_KEY,
              duration: 0,
            })
          } else {
            message.warning(
              result.skipped > 0
                ? `没有可向量化的文献（跳过 ${result.skipped} 篇：正文分段未就绪或文献无效）`
                : '没有可向量化的文献',
            )
          }
        } catch (error: unknown) {
          message.error(getErrorMessage(error, '向量化入队失败'))
        }
      })()
    }
    if (key === 'revectorize') {
      if (selectedIds.length === 0) {
        message.info('请先选择文献')
        return
      }
      Modal.confirm({
        title: '按当前模型重新向量化？',
        content: `将清除所选 ${selectedIds.length} 篇已有向量，并用设置中当前的 Embedding 模型重新生成。适合升级到更强模型后重建索引。会消耗 API 额度。`,
        okText: '重新向量化',
        cancelText: '取消',
        onOk: async () => {
          try {
            const result = await window.api.reindexDocumentsForEmbedding(selectedIds)
            if (result.queued > 0) {
              message.loading({
                content: `已入队重新向量化 ${result.queued} 篇（清除旧向量 ${result.clearedChunks} 段）。进度见卡片与处理队列。`,
                key: BACKGROUND_EMBEDDING_MESSAGE_KEY,
                duration: 0,
              })
            } else {
              message.warning(
                result.skipped > 0
                  ? `没有可重建的文献（跳过 ${result.skipped} 篇：正文分段未就绪）`
                  : '没有可重新向量化的文献',
              )
            }
          } catch (error: unknown) {
            message.error(getErrorMessage(error, '重新向量化入队失败'))
          }
        },
      })
    }
    if (key === 'add_tags') {
      if (selectedIds.length === 0) {
        message.info('请先选择文献')
        return
      }
      setBatchTagModalOpen(true)
    }
    if (key === 'add_folder') {
      if (selectedIds.length === 0) {
        message.info('请先选择文献')
        return
      }
      setBatchFolderTargetId(null)
      setBatchFolderModalOpen(true)
    }
    if (key === 'retry_failed') void handleRetryFailedDocuments()
    if (key === 'select_all') selectAll()
    if (String(key).startsWith('export:')) {
      void handleBatchExport(String(key).replace('export:', '') as DocumentExportFormat)
    }
    if (key === 'delete_selected') {
      Modal.confirm({
        title: `删除 ${selectedIds.length} 篇文献？`,
        content: '会提交后台删除所选文献，不会阻塞当前界面。',
        okText: '删除文献',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => void handleBatchDelete(),
      })
    }
    if (key === 'delete_zero_page') handleDeleteZeroPageDocuments()
    if (key === 'cleanup_pdf_assets') handleBatchCleanupPdfAssets()
    if (key === 'restore_pdf_assets') void handleBatchRestorePdfAssets()
    if (key === 'synthesize') {
      if (onOpenLibraryAi) {
        openCurrentScopeAi('analysis')
      } else {
        setShowSynthesisModal(true)
      }
    }
  }

  const handleDocumentContextMenu = useCallback((docId: string) => {
    if (selectedIdSet.has(docId) && selectedIds.length > 0) {
      setBatchMode(true)
      return
    }
    setSelectedIds([docId])
    setBatchMode(true)
    lastClickedDocIdRef.current = docId
  }, [selectedIdSet, selectedIds.length, setSelectedIds])

  const getDocumentContextMenuItems = useCallback((docId: string, singleItems: MenuProps['items']) => {
    if (selectedIdSet.has(docId) && selectedIds.length > 0) {
      return [
        { key: 'open_new_tab', label: '在新标签页打开', icon: <BookOutlined /> },
        { type: 'divider' as const },
        ...(batchMenuItems || []),
      ]
    }
    return singleItems
  }, [batchMenuItems, selectedIdSet, selectedIds.length])

  const handleDocumentContextMenuClick = useCallback((docId: string, singleHandler: MenuProps['onClick']): MenuProps['onClick'] => {
    return (info) => {
      if (info.key === 'open_new_tab') {
        handleDocumentOpen(docId)
        return
      }
      if (selectedIdSet.has(docId) && selectedIds.length > 0) {
        handleBatchMenu(info)
        return
      }
      singleHandler?.(info)
    }
  }, [handleBatchMenu, handleDocumentOpen, selectedIdSet, selectedIds.length])

  const toggleSectionCollapsed = (section: 'smart' | 'folder' | 'tag') => {
    setCollapsedSections((current) => ({ ...current, [section]: !current[section] }))
  }

  const startSidebarResize = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeStateRef.current = {
      ...resizeStateRef.current,
      mode: 'sidebar',
      startX: event.clientX,
      startY: event.clientY,
      startWidth: sidebarWidth,
      startHeights: sectionHeights,
      stackHeight: sectionStackRef.current?.clientHeight || 0
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const startSectionResize = (mode: 'smart-folder' | 'folder-tag') => (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeStateRef.current = {
      ...resizeStateRef.current,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: sidebarWidth,
      startHeights: sectionHeights,
      stackHeight: sectionStackRef.current?.clientHeight || 0
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  const getSectionWrapperStyle = (section: 'smart' | 'folder' | 'tag') => {
    if (collapsedSections[section]) {
      return {
        flex: '0 0 auto',
        minHeight: 42
      }
    }

    return {
      flex: `0 0 ${sectionHeights[section]}%`,
      minHeight: section === 'smart' ? 140 : 170
    }
  }

  const { startDragSelect: handleLibraryContentMouseDown } = useDragMultiSelect<HTMLDivElement>({
    rootRef: libraryContentRef,
    itemSelector: '[data-library-document-card="true"]',
    selectedIds,
    orderedIds: documentIdOrder,
    enabled: !loading && documents.length > 0,
    getItemId: (element) => element.dataset.documentId,
    isBlockedTarget: isLibraryMarqueeBlockedTarget,
    activeClassName: 'is-marquee-selecting',
    previewClassName: 'is-drag-select-preview',
    includeOrderedRangeBetweenHits: viewMode === 'list',
    reactPreview: false,
    onCommit: (nextIds) => {
      if (!sameStringArray(selectedIds, nextIds)) {
        setSelectedIds(nextIds)
      }
      if (nextIds.length > 0) setBatchMode(true)
    },
    onDragEnd: () => {
      suppressLibraryClickRef.current = true
      window.setTimeout(() => {
        suppressLibraryClickRef.current = false
      }, 0)
    },
  })

  const handleLibraryContentClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (suppressLibraryClickRef.current) return
    if (!batchMode && selectedIds.length === 0) return
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (isLibraryMarqueeBlockedTarget(target)) return
    clearSelection()
    setBatchMode(false)
  }, [batchMode, clearSelection, selectedIds.length])

  const listCardContext = useMemo<DocumentCardContext>(() => ({
    viewMode,
    batchMode,
    selectedIds,
    selectedIdSet,
    folders,
    tags,
    sortedSidebarTags,
    ocrProgressByDoc,
    bookTranslationProgressByDoc,
    embeddingProgressByDoc,
    taggingDocId,
    taggingChecked,
    handleRowClick,
    handleDocumentOpen,
    handleDocumentContextMenu,
    getDocumentContextMenuItems,
    handleDocumentContextMenuClick,
    openMetadataEditor,
    applyLibraryFilter,
    toggleTagFilter,
    handleRetryDocument,
    handleToggleFavorite,
    handleSetReadStatus,
    handleSetRating,
    handleTaggingChange,
    handleForceRerunDocument,
    handleCancelOcr,
    handleQuickAddTagToDocument,
    openDocumentTagModal,
    handleAddToFolder,
    handleRemoveFromFolder,
    getDragDocIds,
    handleDocumentDragStart,
    handleBatchMenu,
    handleDelete,
    handleCleanupPdfAssets,
    handleRestorePdfAssets,
    handleAiExtractForDoc,
    handleTranslateBook,
    setTaggingDocId,
    setTaggingChecked,
  }), [
    applyLibraryFilter,
    batchMode,
    bookTranslationProgressByDoc,
    embeddingProgressByDoc,
    folders,
    handleAddToFolder,
    handleBatchMenu,
    handleCancelOcr,
    handleDocumentContextMenu,
    getDocumentContextMenuItems,
    handleDocumentContextMenuClick,
    handleDocumentDragStart,
    handleDocumentOpen,
    handleCleanupPdfAssets,
    handleForceRerunDocument,
    handleQuickAddTagToDocument,
    handleRestorePdfAssets,
    handleAiExtractForDoc,
    handleTranslateBook,
    handleRemoveFromFolder,
    handleRowClick,
    getDragDocIds,
    openDocumentTagModal,
    ocrProgressByDoc,
    selectedIds,
    selectedIdSet,
    sortedSidebarTags,
    taggingChecked,
    taggingDocId,
    tags,
    toggleTagFilter,
    viewMode,
  ])

  return (
    <Layout ref={layoutRef} className="library-view" style={{ height: '100%', background: 'transparent' }}>
      <Sider
        width={sidebarWidth}
        style={{
          background: 'rgba(0,0,0,0.18)',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          padding: '16px 10px',
          overflow: 'hidden'
        }}
      >
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          <div ref={sectionStackRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              ref={smartSectionRef}
              style={{ ...getSectionWrapperStyle('smart'), display: 'flex', flexDirection: 'column', minHeight: 0, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: 10 }}
            >
              <div
                onClick={() => toggleSectionCollapsed('smart')}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: collapsedSections.smart ? 0 : 8 }}
              >
                <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12, fontWeight: 600 }}>智能视图</span>
                <DownOutlined style={{ fontSize: 12, transform: collapsedSections.smart ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }} />
              </div>
              {!collapsedSections.smart ? (
                <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    {smartFilters.map((item) => {
                      const active = filter.type === item.filter.type && filter.value === item.filter.value
                      return (
                        <Button
                          key={item.key}
                          type={active ? 'primary' : 'text'}
                          block
                          size="small"
                          style={{ justifyContent: 'flex-start' }}
                          onClick={() => void applyLibraryFilter(item.filter)}
                        >
                          {item.label}
                        </Button>
                      )
                    })}
                  </Space>
                </div>
              ) : null}
            </div>

            {!collapsedSections.smart && !collapsedSections.folder ? (
              <div onMouseDown={startSectionResize('smart-folder')} style={{ height: 6, cursor: 'row-resize', borderRadius: 999, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
            ) : null}

            <div
              ref={folderSectionRef}
              style={{ ...getSectionWrapperStyle('folder'), display: 'flex', flexDirection: 'column', minHeight: 0, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: 10 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: collapsedSections.folder ? 0 : 8 }}>
                <div onClick={() => toggleSectionCollapsed('folder')} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1, minWidth: 0 }}>
                  <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12, fontWeight: 600 }}>文件夹</span>
                  <DownOutlined style={{ fontSize: 12, transform: collapsedSections.folder ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }} />
                </div>
                <Tooltip title="新建文件夹">
                  <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => void handleCreateFolder()} />
                </Tooltip>
              </div>
              {!collapsedSections.folder ? (
                <>
                  <Input
                    size="small"
                    placeholder="新建文件夹"
                    value={newFolderName}
                    onChange={(event) => setNewFolderName(event.target.value)}
                    onPressEnter={() => void handleCreateFolder()}
                    style={{ marginBottom: 8 }}
                  />
                  <Dropdown
                    trigger={['contextMenu']}
                    menu={{
                      items: [{ key: 'create_root', label: '新建文件夹', icon: <FolderAddOutlined /> }],
                      onClick: ({ key }) => {
                        if (key === 'create_root') openCreateChildFolder(null)
                      }
                    }}
                  >
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
                      <Space direction="vertical" size={6} style={{ width: '100%', minHeight: '100%' }}>
                        {(() => {
                          const active = filter.type === 'folder' && filter.value === UNFILED_FOLDER_ID
                          return (
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => void toggleLibraryFilter({ type: 'folder', value: UNFILED_FOLDER_ID })}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') void toggleLibraryFilter({ type: 'folder', value: UNFILED_FOLDER_ID })
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                minHeight: 28,
                                padding: '3px 6px',
                                borderRadius: 6,
                                background: active ? 'rgba(24,144,255,0.86)' : 'transparent',
                                border: '1px solid transparent',
                                color: active ? '#fff' : 'var(--gs-text-primary)',
                                cursor: 'pointer',
                                outline: 'none'
                              }}
                            >
                              <Button
                                size="small"
                                type="text"
                                disabled
                                icon={<DownOutlined style={{ fontSize: 10 }} />}
                                style={{ width: 18, minWidth: 18, height: 22, padding: 0, opacity: 0 }}
                              />
                              <InboxOutlined style={{ flexShrink: 0 }} />
                              <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                                {UNFILED_FOLDER_NAME}
                              </span>
                              <span style={{ color: active ? 'rgba(255,255,255,0.82)' : 'var(--gs-text-tertiary)', fontSize: 12, flexShrink: 0 }}>
                                {unfiledDocumentTotal}
                              </span>
                            </div>
                          )
                        })()}
                        <div
                          onDragEnter={(event) => {
                            if (!isFolderDrag(event)) return
                            event.preventDefault()
                            event.stopPropagation()
                            setFolderDropTarget({ id: '__root__', position: 'inside' })
                          }}
                          onDragOver={(event) => {
                            if (!isFolderDrag(event)) return
                            event.preventDefault()
                            event.stopPropagation()
                            event.dataTransfer.dropEffect = 'move'
                            setFolderDropTarget({ id: '__root__', position: 'inside' })
                          }}
                          onDragLeave={(event) => {
                            if (!isFolderDrag(event)) return
                            event.stopPropagation()
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                              setFolderDropTarget((current) => current?.id === '__root__' ? null : current)
                            }
                          }}
                          onDrop={(event) => {
                            if (!isFolderDrag(event)) return
                            event.preventDefault()
                            event.stopPropagation()
                            const folderId = getDragFolderId(event)
                            setFolderDropTarget(null)
                            void handleMoveFolder(folderId, null)
                          }}
                          style={{
                            minHeight: 26,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: 6,
                            border: folderDropTarget?.id === '__root__' ? '1px dashed rgba(196,149,106,0.72)' : '1px dashed rgba(255,255,255,0.08)',
                            color: 'var(--gs-text-tertiary)',
                            fontSize: 12,
                            background: folderDropTarget?.id === '__root__' ? 'rgba(196,149,106,0.16)' : 'rgba(255,255,255,0.02)',
                          }}
                        >
                          拖到这里移为顶层文件夹
                        </div>
                        {visibleFolders.map((item) => {
                          const active = filter.type === 'folder' && filter.value === item.id
                          const collapsed = folderCollapsedIds.includes(item.id)
                          const hasChildren = item.children.length > 0
                          const dropActive = folderDropTarget?.id === item.id
                          const dropPosition = dropActive ? folderDropTarget.position : null
                          return (
                            <Dropdown
                              key={item.id}
                              trigger={['contextMenu']}
                              menu={{
                                items: buildLibraryFolderMenuItems(item),
                                onClick: ({ key }) => handleLibraryFolderMenuClick(item, String(key))
                              }}
                            >
                              <div
                                role="button"
                                tabIndex={0}
                                draggable
                                onDragStart={(event) => handleFolderDragStart(event, item.id)}
                                onDragEnd={() => setFolderDropTarget(null)}
                                onClick={() => void toggleLibraryFilter({ type: 'folder', value: item.id })}
                                onDoubleClick={() => openRenameFolder(item)}
                                onDragEnter={(event) => {
                                  if (!isFolderDropDrag(event)) return
                                  event.preventDefault()
                                  event.stopPropagation()
                                  setFolderDropTarget({ id: item.id, position: isFolderDrag(event) ? getFolderDropPosition(event) : 'inside' })
                                }}
                                onDragOver={(event) => {
                                  if (!isFolderDropDrag(event)) return
                                  event.preventDefault()
                                  event.stopPropagation()
                                  event.dataTransfer.dropEffect = isFolderDrag(event) ? 'move' : 'copy'
                                  setFolderDropTarget({ id: item.id, position: isFolderDrag(event) ? getFolderDropPosition(event) : 'inside' })
                                }}
                                onDragLeave={(event) => {
                                  if (!isFolderDropDrag(event)) return
                                  event.stopPropagation()
                                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                    setFolderDropTarget((current) => current?.id === item.id ? null : current)
                                  }
                                }}
                                onDrop={(event) => void handleFolderDrop(event, item.id)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') void toggleLibraryFilter({ type: 'folder', value: item.id })
                                }}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  minHeight: 28,
                                  padding: '3px 6px',
                                  paddingLeft: 6 + item.depth * 16,
                                  borderRadius: 6,
                                  background: dropActive
                                    ? 'rgba(196,149,106,0.24)'
                                    : active
                                      ? 'rgba(24,144,255,0.86)'
                                      : 'transparent',
                                  borderTop: dropPosition === 'before' ? '2px solid rgba(196,149,106,0.95)' : '1px solid transparent',
                                  borderBottom: dropPosition === 'after' ? '2px solid rgba(196,149,106,0.95)' : '1px solid transparent',
                                  borderLeft: dropPosition === 'inside' ? '1px dashed rgba(196,149,106,0.72)' : '1px solid transparent',
                                  borderRight: dropPosition === 'inside' ? '1px dashed rgba(196,149,106,0.72)' : '1px solid transparent',
                                  color: active ? '#fff' : 'var(--gs-text-primary)',
                                  cursor: 'pointer',
                                  outline: 'none'
                                }}
                              >
                                <Button
                                  size="small"
                                  type="text"
                                  disabled={!hasChildren}
                                  icon={<DownOutlined style={{ fontSize: 10, transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }} />}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (hasChildren) toggleFolderCollapsed(item.id)
                                  }}
                                  style={{ width: 18, minWidth: 18, height: 22, padding: 0, opacity: hasChildren ? 1 : 0 }}
                                />
                                <FolderOpenOutlined style={{ flexShrink: 0 }} />
                                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                                  {item.name}
                                </span>
                                <span style={{ color: active ? 'rgba(255,255,255,0.82)' : 'var(--gs-text-tertiary)', fontSize: 12, flexShrink: 0 }}>
                                  {Number(item.document_count || 0)}
                                </span>
                              </div>
                            </Dropdown>
                          )
                        })}
                        {folders.length === 0 ? <span style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>还没有文件夹</span> : null}
                      </Space>
                    </div>
                  </Dropdown>
                </>
              ) : null}
            </div>

            {!collapsedSections.folder && !collapsedSections.tag ? (
              <div onMouseDown={startSectionResize('folder-tag')} style={{ height: 6, cursor: 'row-resize', borderRadius: 999, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
            ) : null}

            <div
              ref={tagSectionRef}
              style={{ ...getSectionWrapperStyle('tag'), display: 'flex', flexDirection: 'column', minHeight: 0, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: 10 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: collapsedSections.tag ? 0 : 8 }}>
                <div onClick={() => toggleSectionCollapsed('tag')} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1, minWidth: 0 }}>
                  <span style={{ color: 'var(--gs-text-secondary)', fontSize: 12, fontWeight: 600 }}>标签筛选</span>
                  <DownOutlined style={{ fontSize: 12, transform: collapsedSections.tag ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }} />
                </div>
                <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => void handleCreateTag()} />
              </div>
              {!collapsedSections.tag ? (
                <>
                  <Input
                    size="small"
                    placeholder="新建标签"
                    value={newTagName}
                    onChange={(event) => setNewTagName(event.target.value)}
                    onPressEnter={() => void handleCreateTag()}
                    style={{ marginBottom: 8 }}
                  />
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignContent: 'flex-start' }}>
                      {sortedSidebarTags.map((item) => {
                        const active = filter.type === 'tag' && activeTagIds.includes(item.id)
                        return (
                          <Tooltip key={item.id} title={getTooltipTitle(item.name, 18)}>
                            <Tag
                              color={TAG_KIND_META[getTagKind(item)].color}
                              style={{
                                cursor: 'pointer',
                                margin: 0,
                                border: active ? '2px solid currentColor' : '1px solid transparent',
                                padding: '2px 8px',
                                maxWidth: 188,
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis'
                              }}
                              onClick={() => void toggleTagFilter(item.id)}
                            >
                              {truncateLabel(item.name, 18)}
                            </Tag>
                          </Tooltip>
                        )
                      })}
                      {tags.length === 0 ? <span style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>还没有标签</span> : null}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </Sider>

      <div
        onMouseDown={startSidebarResize}
        style={{
          width: 6,
          cursor: 'col-resize',
          background: 'rgba(255,255,255,0.06)',
          borderRight: '1px solid rgba(255,255,255,0.04)',
          flexShrink: 0
        }}
      />

      <Content
        style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => void handleDrop(event)}
      >
        <div className="library-toolbar">
          <div className="library-toolbar-left">
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
              {filterTitle}
              <span style={{ color: 'var(--gs-text-tertiary)', fontWeight: 400, marginLeft: 8, fontSize: 13 }}>
                已加载 {documents.length}/{documentTotal} 篇{listHasMore ? ' · 向下滚动加载更多' : ''}{batchMode && selectedIds.length > 0 ? ` / 已选 ${selectedIds.length} 篇` : ''}
              </span>
            </h2>
            <Space.Compact style={{ width: 460, maxWidth: 'min(46vw, 520px)' }}>
              <Input
                data-library-search-input="true"
                placeholder="搜索所选范围"
                allowClear
                size="small"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  submitLibrarySearch(event.currentTarget.value)
                }}
              />
              <Button
                data-library-search-submit="true"
                size="small"
                type="primary"
                onClick={() => submitLibrarySearch()}
              >
                搜索
              </Button>
            </Space.Compact>
            <Popover
              trigger="click"
              placement="bottomLeft"
              content={(
                <div data-library-search-fields-menu="true" style={{ width: 168 }}>
                  <div style={{ color: 'var(--gs-text-secondary)', fontSize: 12, marginBottom: 8 }}>搜索范围</div>
                  <Checkbox.Group
                    value={librarySearchFields}
                    onChange={(values) => handleLibrarySearchFieldsChange(values as LibraryDocumentSearchField[])}
                    style={{ display: 'grid', gap: 8 }}
                  >
                    {LIBRARY_SEARCH_FIELD_OPTIONS.map((item) => (
                      <Checkbox key={item.value} value={item.value}>{item.label}</Checkbox>
                    ))}
                  </Checkbox.Group>
                  <Button
                    data-library-search-fields-all="true"
                    size="small"
                    block
                    type={librarySearchFields.length === DEFAULT_LIBRARY_SEARCH_FIELDS.length ? 'primary' : 'default'}
                    onClick={() => setLibrarySearchFields(DEFAULT_LIBRARY_SEARCH_FIELDS)}
                    style={{ marginTop: 10 }}
                  >
                    全选
                  </Button>
                </div>
              )}
            >
              <Button
                data-library-search-fields-trigger="true"
                size="small"
                icon={<DownOutlined />}
              >
                {librarySearchFieldsLabel}
              </Button>
            </Popover>
            <Select
              size="small"
              value={librarySort}
              onChange={(value) => setLibrarySort(value as LibrarySortValue)}
              options={LIBRARY_SORT_OPTIONS}
              style={{ width: 168 }}
            />
            <Select
              size="small"
              value={libraryPageSize}
              onChange={(value) => setLibraryPageSize(normalizeLibraryPageSize(value))}
              options={LIBRARY_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `每次 ${value} 篇` }))}
              style={{ width: 112 }}
            />
            {filter.type !== 'all' && filterLabel ? (
              <Tag
                closable
                onClose={(event) => {
                  event.preventDefault()
                  void applyLibraryFilter({ type: 'all' })
                }}
                color="blue"
                style={{ marginTop: 4, fontSize: 12 }}
              >
                {filterLabel}
              </Tag>
            ) : null}
          </div>

          <div className="library-toolbar-right">
            <Segmented
              size="small"
              value={viewMode}
              onChange={(value) => setViewMode(value as 'list' | 'grid')}
              options={[
                { value: 'list', icon: <UnorderedListOutlined /> },
                { value: 'grid', icon: <AppstoreOutlined /> }
              ]}
            />
            {batchMode ? (
              <>
                <Button size="small" icon={<CloseOutlined />} onClick={() => { setBatchMode(false); clearSelection() }}>
                  取消
                </Button>
                <Dropdown menu={{ items: batchMenuItems, onClick: handleBatchMenu }}>
                  <Button size="small" type="primary" icon={<DownOutlined />}>
                    批量操作{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
                  </Button>
                </Dropdown>
                <Popconfirm
                  title="批量删除"
                  description={`提交后台删除 ${selectedIds.length} 篇文献，不会阻塞当前界面。`}
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => void handleBatchDelete()}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} disabled={selectedIds.length === 0}>
                    删除
                  </Button>
                </Popconfirm>
              </>
            ) : (
              <>
                <Button
                  size="small"
                  icon={<RobotOutlined />}
                  onClick={() => openCurrentScopeAi('qa')}
                  disabled={documents.length === 0}
                >
                  AI 助手
                </Button>
                <Button size="small" icon={<CheckSquareOutlined />} onClick={() => setBatchMode(true)}>
                  批量处理
                </Button>
                <Popconfirm
                  title="停止全部 OCR 队列？"
                  description="会取消排队中和正在处理的 OCR（已完成页面保留）。重启后也不会再自动续跑这些任务。"
                  okText="全部停止"
                  cancelText="返回"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void handleCancelAllPendingOcr()}
                >
                  <Button size="small" danger icon={<CloseCircleOutlined />}>
                    停止全部 OCR
                  </Button>
                </Popconfirm>
                <Button
                  size="small"
                  icon={<FileSearchOutlined />}
                  loading={healthLoading}
                  data-library-health-button="true"
                  onClick={() => {
                    const shouldOpenPanel = healthPanelCollapsed
                    setHealthPanelCollapsed(!healthPanelCollapsed)
                    if (shouldOpenPanel && !healthReport) void loadHealthReport()
                  }}
                >
                  健康检查
                </Button>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => {
                    void loadDocuments()
                  }}
                />
                <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => void handleImport()} style={{ display: 'none' }} aria-hidden>
                  导入
                </Button>
              </>
            )}
          </div>
        </div>

        {activeBookTranslations.length > 0 ? (
          <div className="library-book-translation-panel" data-library-book-translation-panel="true">
            <div className="library-book-translation-panel-header">
              <span className="library-book-translation-panel-title">
                <ThunderboltOutlined />
                后台整书翻译
              </span>
              <span className="library-book-translation-panel-count">
                {activeBookTranslations.length} 个任务
              </span>
            </div>
            <div className="library-book-translation-list">
              {activeBookTranslations.map((info) => {
                const percent = Math.max(0, Math.min(100, getBookTranslationProgressPercent(info)))
                const statusClass = info.status === 'error'
                  ? 'error'
                  : info.status === 'partial'
                    ? 'partial'
                    : info.status === 'completed'
                      ? 'completed'
                      : 'processing'
                const title = documentTitleById.get(info.docId) || '当前文献'
                return (
                  <div key={info.docId} className={`library-book-translation-item ${statusClass}`}>
                    <div className="library-book-translation-main">
                      <div className="library-book-translation-title" title={title}>{title}</div>
                      <div className="library-book-translation-message" title={getBookTranslationProgressText(info)}>
                        {getBookTranslationProgressText(info)}
                      </div>
                    </div>
                    <div className="library-book-translation-meter" aria-label={`整书翻译进度 ${percent}%`}>
                      <div style={{ width: `${percent}%` }} />
                    </div>
                    <div className="library-book-translation-percent">{percent}%</div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {authorizationRequiredJobs.length > 0 ? (
          <Alert
            className="import-reauthorization-banner"
            type="warning"
            showIcon
            message={`有 ${authorizationRequiredJobs.length} 个导入任务需要重新授权`}
            description={(
              <Space wrap size={8}>
                {authorizationRequiredJobs.map((job) => (
                  <Button key={job.id} size="small" onClick={() => promptImportQueueReauthorization(job)}>
                    重新选择（约 {job.pendingCount} 个文件）
                  </Button>
                ))}
              </Space>
            )}
          />
        ) : null}

        <div className={`library-drop-hint ${dragActive ? 'drag-over' : ''}`}>
          <InboxOutlined />
          <span>{importing ? '正在后台导入文献，当前页面可继续使用' : '拖拽 PDF、图片、JSON、EPUB、TXT、Markdown 或文件夹到这里导入'}</span>
          <small>
            {importing
              ? `${importProgressText || '正在处理文件和页面'}${importQueueLength > 0 ? `；队列中还有 ${importQueueLength} 个文件` : ''}`
              : '拖拽文件夹时会创建同名文件夹，并导入其中的 PDF、图片、JSON、EPUB、TXT 或 Markdown'}
          </small>
          {!importing ? (
            <Segmented
              size="small"
              value={importOcrEngine}
              onChange={(value) => setImportOcrEngine(value as OcrEngine)}
              options={[
                { value: 'paddle', label: '飞桨 OCR' },
                { value: 'vision_model', label: '大模型 OCR' },
              ]}
            />
          ) : null}
        </div>

        {!healthPanelCollapsed ? (
          <div className="library-health-panel" data-library-health-panel="true">
            <div className="library-health-header">
              <div>
                <div className="library-health-title">文献健康检查</div>
                <div className="library-health-subtitle">
                  {healthReport
                    ? `${healthReport.stats.totalDocuments || 0} 篇 / ${healthReport.stats.totalPages || 0} 页 / ${healthReport.stats.segments || 0} 个检索段 / ${healthReport.stats.researchNotes || 0} 条摘录`
                    : '正在读取真实文献库状态'}
                </div>
              </div>
              <Space size={6}>
                <Button size="small" loading={healthLoading} icon={<ReloadOutlined />} onClick={() => void loadHealthReport()}>
                  刷新
                </Button>
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={closeHealthPanel} />
              </Space>
            </div>

            <div className="library-health-metrics">
              {healthMetricItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className={`library-health-metric ${isSameFilter(filter, item.filter) ? 'active' : ''}`}
                  onClick={() => void toggleLibraryFilter(item.filter)}
                >
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </button>
              ))}
            </div>

            <div className="library-health-risk-list">
              {topRiskDocuments.length > 0 ? topRiskDocuments.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="library-health-risk-item"
                  onClick={() => onSelectDoc?.({ docId: row.id })}
                >
                  <span className="library-health-risk-title">{row.title}</span>
                  <span className="library-health-risk-tags">
                    {row.issues.slice(0, 3).map((issue) => (
                      <Tag key={`${row.id}-${issue.type}`} color={issue.severity === 'high' ? 'red' : issue.severity === 'medium' ? 'orange' : 'blue'} style={{ margin: 0 }}>
                        {issue.label}
                      </Tag>
                    ))}
                  </span>
                </button>
              )) : (
                <div className="library-health-empty">{healthLoading ? '正在生成风险清单' : '暂未发现高风险文献'}</div>
              )}
            </div>
          </div>
        ) : null}

        <div
          ref={libraryContentRef}
          className="library-content"
          onMouseDown={handleLibraryContentMouseDown}
          onClick={handleLibraryContentClick}
          onScroll={(event) => {
            if (viewMode === 'grid') maybeLoadMoreFromScroll(event.currentTarget)
          }}
          onWheel={(event) => {
            if (viewMode === 'grid' && event.deltaY > 0) maybeLoadMoreFromScroll(event.currentTarget)
          }}
          style={viewMode === 'grid'
            ? {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 340px))',
                gap: 12,
                padding: 14,
                justifyContent: 'start',
                alignContent: 'start',
                alignItems: 'start',
                overflow: 'auto'
              }
            : undefined}
        >
          {loading ? (
            <div className="empty-state"><Spin size="large" /></div>
          ) : documents.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={libraryListLoadError
                ? `文献列表暂时无法加载：${libraryListLoadError}。这通常是启动恢复/OCR 占用数据库导致，正在自动重试…`
                : '还没有文献，把 PDF、图片或文件夹拖到这里开始导入'}
            />
          ) : viewMode === 'list' && documents.length < VIRTUAL_LIST_MIN_DOCUMENTS ? (
            <div style={{ width: '100%', paddingTop: 4 }}>
              {documents.map((doc, index) => (
                <DocumentVirtualRow
                  key={doc.id}
                  index={index}
                  style={{ height: getDocumentListRowHeight(doc, listCardContext), position: 'relative' }}
                  ariaAttributes={{}}
                  documents={documents}
                  context={listCardContext}
                />
              ))}
            </div>
          ) : viewMode === 'list' ? (
            <List<DocumentVirtualRowProps>
              rowCount={documents.length}
              rowHeight={(index, rowProps) => getDocumentListRowHeight(rowProps.documents[index], rowProps.context)}
              rowComponent={DocumentVirtualRow}
              rowProps={{
                documents,
                context: listCardContext,
              }}
              onScroll={(event) => {
                maybeLoadMoreFromScroll(event.currentTarget)
              }}
              onWheel={(event) => {
                if (event.deltaY > 0) maybeLoadMoreFromScroll(event.currentTarget)
              }}
              overscanCount={6}
              defaultHeight={720}
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            gridRenderedDocuments.map((doc) => {
              const isSelected = selectedIdSet.has(doc.id)
              const docTagNames = splitPipe(doc.tag_names)
              const docTagColors = splitPipe(doc.tag_colors)
              const docTagIds = splitPipe(doc.tag_ids)
              const docTagSources = splitPipe(doc.tag_sources)
              const docFolderIds = splitPipe(doc.folder_ids)
              const docFolderNames = splitPipe(doc.folder_names)
              const orderedDocTags = sortDocumentTags(docTagNames.map((name, index) => ({
                id: docTagIds[index],
                name,
                color: docTagColors[index],
                source: docTagSources[index]
              }))).filter((tagItem) => !!getDisplayTagText(tagItem.name))
              const availableFolders = folderItems.filter((item) => !docFolderIds.includes(item.id))
              const visibleTagCount = viewMode === 'grid'
                ? (docFolderNames.length > 0 ? 1 : 2)
                : 6
              const visibleTags = orderedDocTags.slice(0, visibleTagCount)
              const hiddenTags = orderedDocTags.slice(visibleTagCount)
              const visibleFolderEntries = viewMode === 'grid'
                ? docFolderNames.slice(0, 1)
                : docFolderNames
              const hiddenFolderEntries = viewMode === 'grid'
                ? docFolderNames.slice(1)
                : []
              const displayAuthor = getDisplayMetadataText(doc.author)
              const displayDynasty = getDisplayMetadataText(doc.dynasty)
              const progressInfo = resolveOcrProgressInfo(doc, ocrProgressByDoc[doc.id])
              const bookTranslationProgressInfo = bookTranslationProgressByDoc[doc.id]
              const pdfAssetState = getPdfAssetState(doc)

              const readMenuItems: MenuProps['items'] = (Object.keys(READ_STATUS_MAP) as ReadStatus[]).map((status) => ({
                key: status,
                label: READ_STATUS_MAP[status].text,
                icon: getReadStatusIcon(status)
              }))

              const ratingMenuItems: MenuProps['items'] = [
                { key: '0', label: '清除评分' },
                ...[1, 2, 3, 4, 5].map((value) => ({
                  key: String(value),
                  label: `${'★'.repeat(value)}${'☆'.repeat(5 - value)}`
                }))
              ]

              const moreMenuItems: MenuProps['items'] = buildDocumentMoreMenuItems({
                doc,
                availableFolders,
                docFolderIds,
                docFolderNames,
                pdfAssetState,
              })

              const handleMoreClick: MenuProps['onClick'] = ({ key, domEvent }) => {
                domEvent.stopPropagation()
                if (key === 'open_new_tab') {
                  handleDocumentOpen(doc.id)
                  return
                }
                if (key === 'edit') {
                  void openMetadataEditor(doc.id)
                  return
                }
                if (key === 'retry') {
                  void handleRetryDocument(doc)
                  return
                }
                if (String(key).startsWith('rerun_ocr_book:')) {
                  void handleForceRerunDocument(doc, String(key).replace('rerun_ocr_book:', '') as OcrEngine)
                  return
                }
                if (key === 'ai_extract') {
                  void handleAiExtractForDoc(doc.id)
                  return
                }
                if (String(key).startsWith('translate_book:start:')) {
                  const mode = String(key).replace('translate_book:start:', '') as BookTranslationOptions['mode']
                  void handleTranslateBook(doc, { style: DEFAULT_TRANSLATION_STYLE, mode })
                  return
                }
                if (key === 'translate_book' || key === 'translate_book:start') {
                  void handleTranslateBook(doc, { style: DEFAULT_TRANSLATION_STYLE })
                  return
                }
                if (key === 'translate_book:retry_failed') {
                  void handleTranslateBook(doc, { style: DEFAULT_TRANSLATION_STYLE, retryFailedOnly: true })
                  return
                }
                if (key === 'translate_book:clear_cache') {
                  Modal.confirm({
                    title: '清除本书翻译缓存',
                    content: '会清除这本文献的页面译文缓存。原文和 OCR 结果不会受影响，之后可以重新整书翻译。',
                    okText: '清除缓存',
                    cancelText: '取消',
                    okButtonProps: { danger: true },
                    onOk: () => handleTranslateBook(doc, { clearCache: true })
                  })
                  return
                }
                if (key === 'favorite') {
                  void handleToggleFavorite(doc)
                  return
                }
                if (key === 'add_tag') {
                  openDocumentTagModal(doc.id)
                  return
                }
                if (key.startsWith('folder_')) {
                  void handleAddToFolder(doc.id, key.replace('folder_', ''))
                  return
                }
                if (key.startsWith('remove_folder_')) {
                  void handleRemoveFromFolder(doc.id, key.replace('remove_folder_', ''))
                  return
                }
                if (key === 'cleanup_pdf_assets') {
                  Modal.confirm({
                    title: '删除原文件/页图缓存',
                    content: '只会删除软件数据目录里的 PDF 副本和页图缓存，不会删除 OCR 文本、检索结果，也不会修改 PDF 原件仓库。以后可从原件仓库补回。',
                    okText: '删除原文件',
                    cancelText: '取消',
                    okButtonProps: { danger: true },
                    onOk: () => handleCleanupPdfAssets(doc)
                  })
                  return
                }
                if (key === 'restore_pdf_assets') {
                  void handleRestorePdfAssets(doc)
                  return
                }
                if (key === '0') {
                  void handleSetRating(doc.id, null)
                  return
                }
                if (/^[1-5]$/.test(key)) {
                  void handleSetRating(doc.id, Number(key))
                }
              }

              return (
                <Dropdown
                  key={doc.id}
                  menu={{
                    items: getDocumentContextMenuItems(doc.id, moreMenuItems),
                    onClick: handleDocumentContextMenuClick(doc.id, handleMoreClick),
                  }}
                  trigger={['contextMenu']}
                >
                  <div
                    draggable
                    onDragStart={(event) => handleDocumentDragStart(event, doc.id)}
                    data-library-document-card="true"
                    data-document-id={doc.id}
                    onMouseDown={(event) => {
                      if (event.button === 2) handleDocumentContextMenu(doc.id)
                    }}
                    onContextMenu={() => handleDocumentContextMenu(doc.id)}
                    onClick={(event) => handleRowClick(doc.id, event)}
                    onDoubleClick={() => handleDocumentOpen(doc.id)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      padding: 12,
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 8,
                      background: isSelected ? 'rgba(24, 144, 255, 0.15)' : 'rgba(255,255,255,0.03)',
                      cursor: 'pointer',
                      transition: 'background 0.15s ease',
                      minHeight: shouldShowDocumentErrorMessage(doc, progressInfo) || shouldShowDocumentReviewMessage(doc, progressInfo) || shouldShowOcrProgressForDocument(doc, progressInfo) || shouldShowBookTranslationProgress(bookTranslationProgressInfo) || shouldShowEmbeddingProgress(embeddingProgressByDoc[doc.id]) ? 176 : 140,
                      overflow: 'hidden'
                    }}
                    onMouseEnter={(event) => {
                      if (!isSelected) {
                        event.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                      }
                    }}
                    onMouseLeave={(event) => {
                      if (!isSelected) {
                        event.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                      }
                    }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      {batchMode ? (
                        <div
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 4,
                            border: isSelected ? '2px solid #1890ff' : '2px solid rgba(255,255,255,0.3)',
                            background: isSelected ? '#1890ff' : 'transparent',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0
                          }}
                        >
                          {isSelected ? <span style={{ color: '#fff', fontSize: 11 }}>✓</span> : null}
                        </div>
                      ) : null}
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 14,
                          fontWeight: 600,
                          color: 'var(--gs-text-primary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}
                      >
                        {doc.title || '未命名文献'}
                      </div>
                    </div>

                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8, minWidth: 0 }}>
                        <span
                          style={{
                            minWidth: 0,
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: 'var(--gs-text-secondary)',
                            fontSize: 12,
                            lineHeight: '22px',
                            flex: '1 1 100%',
                          }}
                        >
                          {[displayAuthor, displayDynasty, `${getEffectivePageCount(doc)} 页`].filter(Boolean).join(' · ')}
                        </span>
                        <Tag color={getStatusMeta(OCR_STATUS_MAP, doc.ocr_status).color} style={{ margin: 0, flexShrink: 0, height: 22, lineHeight: '20px' }}>
                          {getStatusMeta(OCR_STATUS_MAP, doc.ocr_status).text}
                        </Tag>
                        <Tag color={getStatusMeta(IMPORT_STATUS_MAP, doc.import_status).color} style={{ margin: 0, flexShrink: 0, height: 22, lineHeight: '20px' }}>
                          {getStatusMeta(IMPORT_STATUS_MAP, doc.import_status).text}
                        </Tag>
                        {renderEmbeddingStatusTag(doc)}
                        {!batchMode ? (
                          <div
                            data-library-document-action="true"
                            style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: 2,
                            minWidth: 0,
                            maxWidth: 174,
                            flexWrap: 'nowrap',
                            overflow: 'hidden'
                          }}
                          onPointerDown={stopLibraryDocumentActionPropagation}
                          onMouseDown={stopLibraryDocumentActionPropagation}
                          onClick={stopLibraryDocumentActionPropagation}
                        >
                          {shouldShowRetryAction(doc) ? (
                            <Tooltip title={getRetryActionLabel(doc)}>
                              <Button
                                type="text"
                                size="small"
                                icon={<ReloadOutlined />}
                                style={{ width: 24, height: 24, padding: 0 }}
                                onClick={() => void handleRetryDocument(doc)}
                              />
                            </Tooltip>
                          ) : null}

                          <Tooltip title={doc.is_favorite ? '取消星标' : '加入星标'}>
                            <Button
                              type="text"
                              size="small"
                              icon={doc.is_favorite ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                              style={{ width: 24, height: 24, padding: 0 }}
                              onClick={() => void handleToggleFavorite(doc)}
                            />
                          </Tooltip>

                          <Dropdown
                            menu={{
                              items: readMenuItems,
                              onClick: ({ key }) => void handleSetReadStatus(doc.id, key as ReadStatus)
                            }}
                          >
                            <Button type="text" size="small" icon={getReadStatusIcon(doc.read_status)} style={{ width: 24, height: 24, padding: 0 }} />
                          </Dropdown>

                          <Popover
                            open={taggingDocId === doc.id}
                            onOpenChange={(open) => {
                              if (open) {
                                setTaggingDocId(doc.id)
                                setTaggingChecked(docTagIds)
                              } else {
                                setTaggingDocId(null)
                              }
                            }}
                            trigger="click"
                            title="标签"
                            content={(
                              <div style={{ minWidth: 180, maxWidth: 280 }}>
                                {tags.length === 0 ? (
                                  <span style={{ fontSize: 12, color: 'var(--gs-text-tertiary)' }}>还没有标签，请先创建</span>
                                ) : (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                    {sortedSidebarTags.map((item) => {
                                      const checked = taggingChecked.includes(item.id)
                                      return (
                                        <Tooltip key={item.id} title={getTooltipTitle(item.name, 18)}>
                                          <Tag
                                            color={checked ? TAG_KIND_META[getTagKind(item)].color : undefined}
                                            style={{
                                              cursor: 'pointer',
                                              margin: 0,
                                              opacity: checked ? 1 : 0.6,
                                              maxWidth: 220,
                                              overflow: 'hidden',
                                              whiteSpace: 'nowrap',
                                              textOverflow: 'ellipsis',
                                              border: checked
                                                ? `1px solid ${item.color || '#1677ff'}`
                                                : '1px solid rgba(255,255,255,0.2)'
                                            }}
                                            onClick={() => {
                                              const nextChecked = checked
                                                ? taggingChecked.filter((id) => id !== item.id)
                                                : [...taggingChecked, item.id]
                                              void handleTaggingChange(doc.id, nextChecked)
                                            }}
                                          >
                                            {checked ? '✓ ' : ''}{truncateLabel(item.name, 18)}
                                          </Tag>
                                        </Tooltip>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          >
                            <Button type="text" size="small" icon={<TagOutlined />} style={{ width: 24, height: 24, padding: 0 }} />
                          </Popover>

                          <Dropdown menu={{ items: moreMenuItems, onClick: handleMoreClick }}>
                            <Button type="text" size="small" icon={<MoreOutlined />} style={{ width: 24, height: 24, padding: 0 }} />
                          </Dropdown>

                          <Popconfirm
                            title="删除文献"
                            description="确定要删除这篇文献吗？"
                            onConfirm={(event) => void handleDelete(event ?? { stopPropagation() {} }, doc.id)}
                            onCancel={(event) => event?.stopPropagation()}
                            okText="删除"
                            cancelText="取消"
                          >
                            <Button type="text" danger size="small" icon={<DeleteOutlined />} style={{ width: 24, height: 24, padding: 0 }} onClick={(event) => event.stopPropagation()} />
                          </Popconfirm>
                          </div>
                        ) : null}
                      </div>

                    {(docFolderNames.length > 0 || visibleTags.length > 0) ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, minWidth: 0, height: 24, maxHeight: 24, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                        {docFolderNames.length > 0 ? (
                          <>
                          {visibleFolderEntries.map((name, index) => (
                            <Tag
                              key={`${doc.id}-folder-${docFolderIds[index] || index}`}
                              style={{ margin: 0, cursor: 'pointer', maxWidth: 110, height: 22, lineHeight: '20px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', flexShrink: 0 }}
                              onClick={(event) => {
                                event.stopPropagation()
                                void applyLibraryFilter({ type: 'folder', value: docFolderIds[index] })
                              }}
                            >
                              {name}
                            </Tag>
                          ))}
                          {hiddenFolderEntries.length > 0 ? renderTagSummaryPopover(
                            hiddenFolderEntries.map((name, index) => (
                              <Tag key={`${doc.id}-hidden-folder-${docFolderIds[index + visibleFolderEntries.length] || index}`} style={{ margin: 0 }}>{name}</Tag>
                            )),
                            `+${hiddenFolderEntries.length}`,
                          ) : null}
                          </>
                        ) : null}

                        {visibleTags.map((tagItem) => {
                          const tagText = getDisplayTagText(tagItem.name) || tagItem.name
                          return (
                          <Tooltip
                            key={`${doc.id}-tag-${tagItem.id || tagItem.name}`}
                            title={getTooltipTitle(tagText, viewMode === 'grid' ? 12 : 22)}
                          >
                            <Tag
                              color={TAG_KIND_META[getTagKind(tagItem)].color}
                              style={{
                                margin: 0,
                                cursor: 'pointer',
                                maxWidth: viewMode === 'grid' ? 92 : 220,
                                height: 22,
                                lineHeight: '20px',
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis',
                                flexShrink: 0
                              }}
                              onClick={(event) => {
                                event.stopPropagation()
                                if (tagItem.id) {
                                  void toggleTagFilter(tagItem.id)
                                }
                              }}
                            >
                              {truncateLabel(tagText, viewMode === 'grid' ? 12 : 22)}
                            </Tag>
                          </Tooltip>
                          )
                        })}
                        {hiddenTags.length > 0 ? (
                          <Popover
                            trigger="click"
                            title="其余标签"
                            content={(
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 320 }}>
                                {hiddenTags.map((tagItem) => {
                                  const tagText = getDisplayTagText(tagItem.name) || tagItem.name
                                  return (
                                  <Tooltip
                                    key={`${doc.id}-hidden-${tagItem.id || tagItem.name}`}
                                    title={getTooltipTitle(tagText, 22)}
                                  >
                                    <Tag
                                      color={TAG_KIND_META[getTagKind(tagItem)].color}
                                      style={{
                                        margin: 0,
                                        cursor: 'pointer',
                                        maxWidth: 220,
                                        overflow: 'hidden',
                                        whiteSpace: 'nowrap',
                                        textOverflow: 'ellipsis'
                                      }}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        if (tagItem.id) {
                                          void toggleTagFilter(tagItem.id)
                                        }
                                      }}
                                    >
                                      {truncateLabel(tagText, 22)}
                                    </Tag>
                                  </Tooltip>
                                  )
                                })}
                              </div>
                            )}
                          >
                            <Tag
                              style={{ margin: 0, cursor: 'pointer', flexShrink: 0 }}
                              onClick={(event) => event.stopPropagation()}
                            >
                              +{hiddenTags.length}
                            </Tag>
                          </Popover>
                        ) : null}
                      </div>
                    ) : null}

                    {shouldShowDocumentErrorMessage(doc, progressInfo) ? (
                      <div
                        style={{
                          marginTop: 8,
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: 'rgba(255, 77, 79, 0.10)',
                          border: '1px solid rgba(255, 77, 79, 0.22)',
                          color: '#ffccc7',
                          fontSize: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        失败原因：{doc.error_message}
                      </div>
                    ) : null}

                    {shouldShowDocumentReviewMessage(doc, progressInfo) ? (
                      <div
                        style={{
                          marginTop: 8,
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: 'rgba(250, 173, 20, 0.12)',
                          border: '1px solid rgba(250, 173, 20, 0.28)',
                          color: '#ffd666',
                          fontSize: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        页面待复核：{doc.error_message}
                      </div>
                    ) : null}

                    {progressInfo ? renderOcrProgress(progressInfo, handleCancelOcr) : null}
                    {renderBookTranslationProgress(bookTranslationProgressInfo)}
                    {renderEmbeddingProgress(embeddingProgressByDoc[doc.id])}
                  </div>
                </Dropdown>
              )
            })
          )}
        </div>
        {!loading && listLoadingMore ? (
          <div className="library-load-more-indicator" data-library-load-more-indicator="true">
            <Spin size="small" />
          </div>
        ) : null}
      </Content>

      <AiSynthesisModal
        visible={showSynthesisModal}
        preSelectedIds={selectedIds}
        tags={tags}
        folders={folders}
        onOpenDocument={onSelectDoc}
        onClose={() => setShowSynthesisModal(false)}
      />

      <Modal
        title={editingFolder ? '重命名文件夹' : '新建文件夹'}
        open={folderEditorOpen}
        onCancel={() => {
          setFolderEditorOpen(false)
          setEditingFolder(null)
          setFolderEditorName('')
          setFolderEditorParentId(null)
        }}
        onOk={() => void handleSaveFolderEditor()}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input
            autoFocus
            placeholder="文件夹名称"
            value={folderEditorName}
            onChange={(event) => setFolderEditorName(event.target.value)}
            onPressEnter={() => void handleSaveFolderEditor()}
          />
          <Select
            value={folderEditorParentId || ''}
            onChange={(value) => setFolderEditorParentId(value || null)}
            options={[
              { value: '', label: '顶层文件夹' },
              ...visibleFolders
                .filter((item) => !editingFolder || (item.id !== editingFolder.id && !isFolderDescendant(folderItems, item.id, editingFolder.id)))
                .map((item) => ({
                  value: item.id,
                  label: `${'  '.repeat(item.depth)}${item.name}`,
                }))
            ]}
            style={{
              width: '100%',
            }}
          />
        </Space>
      </Modal>

      <Modal
        title="添加标签"
        open={!!documentTagModalDocId}
        onCancel={() => {
          setDocumentTagModalDocId(null)
          setDocumentTagNameInput('')
          setDocumentTagCheckedIds([])
          setDocumentTagSearch('')
        }}
        onOk={() => void handleSaveDocumentTagModal()}
        okText="添加"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input
            autoFocus
            allowClear
            placeholder="筛选已有标签"
            value={documentTagSearch}
            onChange={(event) => setDocumentTagSearch(event.target.value)}
          />
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="新建自建标签"
              value={documentTagNameInput}
              onChange={(event) => setDocumentTagNameInput(event.target.value)}
              onPressEnter={() => void handleSaveDocumentTagModal()}
            />
            <Button icon={<PlusOutlined />} onClick={() => void handleSaveDocumentTagModal()}>
              添加
            </Button>
          </Space.Compact>
          <div style={{ maxHeight: 280, overflowY: 'auto', padding: 2 }}>
            {renderSelectableTagList(
              visibleDocumentTagOptions,
              documentTagCheckedIds,
              (tagId) => {
                setDocumentTagCheckedIds((current) => (
                  current.includes(tagId)
                    ? current.filter((id) => id !== tagId)
                    : [...current, tagId]
                ))
              },
              tags.length === 0 ? '还没有标签' : '没有匹配的标签',
            )}
          </div>
        </Space>
      </Modal>

      <Modal
        title="批量加入文件夹"
        open={batchFolderModalOpen}
        onCancel={() => {
          setBatchFolderModalOpen(false)
          setBatchFolderTargetId(null)
        }}
        onOk={() => void handleBatchApplyFolder()}
        okText="加入文件夹"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ color: 'var(--gs-text-secondary)', fontSize: 13 }}>
            已选 {selectedIds.length} 篇文献
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visibleFolders.map((item) => {
              const selected = batchFolderTargetId === item.id
              return (
                <Button
                  key={item.id}
                  type={selected ? 'primary' : 'text'}
                  icon={<FolderOpenOutlined />}
                  style={{ justifyContent: 'flex-start', paddingLeft: 8 + item.depth * 16 }}
                  onClick={() => setBatchFolderTargetId(item.id)}
                >
                  {item.name}
                </Button>
              )
            })}
            {folderItems.length === 0 ? <span style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>还没有文件夹</span> : null}
          </div>
        </Space>
      </Modal>

      <Modal
        title="批量添加标签"
        open={batchTagModalOpen}
        onCancel={() => {
          setBatchTagModalOpen(false)
          setBatchTagCheckedIds([])
          setBatchNewTagName('')
        }}
        onOk={() => void handleBatchApplyTags()}
        okText="添加到所选文献"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ color: 'var(--gs-text-secondary)', fontSize: 13 }}>
            已选 {selectedIds.length} 篇文献
          </div>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              allowClear
              placeholder="筛选或新建自建标签"
              value={batchNewTagName}
              onChange={(event) => setBatchNewTagName(event.target.value)}
              onPressEnter={() => void handleAddBatchNewTag()}
            />
            <Button icon={<PlusOutlined />} onClick={() => void handleAddBatchNewTag()}>
              添加
            </Button>
          </Space.Compact>
          <div style={{ maxHeight: 280, overflowY: 'auto', padding: 2 }}>
            {renderSelectableTagList(
              visibleBatchTagOptions,
              batchTagCheckedIds,
              (tagId) => {
                setBatchTagCheckedIds((current) => (
                  current.includes(tagId)
                    ? current.filter((id) => id !== tagId)
                    : [...current, tagId]
                ))
              },
              tags.length === 0 ? '还没有标签' : '没有匹配的标签',
            )}
          </div>
        </Space>
      </Modal>

      <MetadataEditor
        visible={metadataEditorVisible}
        document={editingDoc}
        onCancel={() => {
          setMetadataEditorVisible(false)
          setEditingDoc(null)
        }}
        onSave={handleSaveMetadata}
      />
    </Layout>
  )
}
