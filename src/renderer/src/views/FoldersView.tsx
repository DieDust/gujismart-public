import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type UIEvent, type WheelEvent } from 'react'
import { Button, Dropdown, Empty, Input, Layout, Modal, Radio, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import type { MenuProps } from 'antd'
import {
  BookOutlined,
  CheckSquareOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FileSearchOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  InboxOutlined,
  ImportOutlined,
  PictureOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  RightOutlined,
  SwapOutlined,
  TagOutlined,
  ThunderboltOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons'
import type { DocumentExportFormat, DocumentExportOptions, ExportPageNumberMode, FolderContentOptions, FolderContentResult, FolderOverviewDocument, FolderOverviewItem, FolderOverviewResult, ImportDocumentResult, LibraryDocumentSortDirection, LibraryDocumentSortKey, OcrEngine } from '@shared/types'
import { LIBRARY_RELATIONS_CHANGED_EVENT } from '../utils/libraryEvents'
import { sameStringArray, useDragMultiSelect } from '../utils/dragMultiSelect'
import { buildFolderTree, flattenVisibleFolders, isFolderDescendant, sortFolders, type FolderTreeNode } from '../utils/folders'
import { buildDocumentFolderMenuItems } from '../utils/documentFolderMenu'
import { getErrorMessage } from '@shared/errors'
import { getPdfFileInfo, renderPdfFilePageToImage } from '../utils/pdf'
import { ensurePdfPageImagesForOcr as ensureOcrPageImages } from '../utils/ocrPageImages'

const { Sider, Content } = Layout
const { Title, Text } = Typography

const ROOT_FOLDER_ID = '__root__'
const UNFILED_FOLDER_ID = '__gujismart_unfiled__'
const UNFILED_FOLDER_NAME = '未分类'
const FOLDER_DRAG_MIME = 'application/x-gujismart-folder-id'
const DOCUMENT_DRAG_MIME = 'application/x-gujismart-document-ids'
const FOLDER_CONTENT_PAGE_SIZE = 80
const DOCUMENT_CARD_SIZE_MIN = 88
const DOCUMENT_CARD_SIZE_MAX = 176
const DOCUMENT_CARD_SIZE_STEP = 8
const DOCUMENT_CARD_SIZE_PRESETS = {
  small: 96,
  medium: 120,
  large: 152,
} as const
const DEFAULT_IMPORT_BATCH_SIZE = 5
const MAX_IMPORT_BATCH_SIZE = 20
const FOLDERS_IMPORT_MESSAGE_KEY = 'folders-import'
const FOLDERS_AUTO_OCR_MESSAGE_KEY = 'folders-auto-ocr'
const FOLDERS_BATCH_OCR_MESSAGE_KEY = 'folders-batch-ocr'
const FOLDERS_BATCH_EXPORT_MESSAGE_KEY = 'folders-batch-export'
const FOLDERS_DOCUMENT_SORT_STORAGE_KEY = 'gujismart.folders.documentSort.v1'

type FolderDropPosition = 'inside' | 'before' | 'after'
type DocumentSizePreset = keyof typeof DOCUMENT_CARD_SIZE_PRESETS
type FolderDocumentSortValue = 'default' | `${Exclude<LibraryDocumentSortKey, 'default'>}:${LibraryDocumentSortDirection}`

const DOCUMENT_EXPORT_FORMAT_NAMES: Record<DocumentExportFormat, string> = {
  markdown: 'Markdown',
  'tei-xml': 'TEI-XML',
  'page-xml': 'PAGE XML',
  'paddle-json': 'Paddle JSON',
  txt: 'TXT',
  'reading-pdf': '阅读模式 PDF',
  'layout-pdf': '排版模式 PDF',
  'layout-searchable-pdf': '原图可搜索 PDF',
}

const FOLDER_DOCUMENT_SORT_OPTIONS: Array<{ value: FolderDocumentSortValue; label: string }> = [
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

interface FoldersViewProps {
  onOpenFolder?: (folderId: string) => void
  onOpenDocument?: (docId: string, state: FoldersViewState) => void
  initialState?: FoldersViewState | null
  onStateChange?: (state: FoldersViewState) => void
}

interface FoldersViewState {
  selectedFolderId: string | null
  selectedFolderName?: string
  scrollTop: number
}

function createEmptyFolderContent(folderId: string | null, unfiled = false): FolderContentResult {
  return {
    folder_id: folderId,
    unfiled,
    documents: [],
    total_document_count: 0,
    limit: FOLDER_CONTENT_PAGE_SIZE,
    offset: 0,
    has_more: false,
  }
}

function isFolderDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(FOLDER_DRAG_MIME)
}

function isDocumentDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(DOCUMENT_DRAG_MIME)
}

function isExternalFileDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes('Files')
}

function getDragFolderId(event: DragEvent<HTMLElement>): string {
  return event.dataTransfer.getData(FOLDER_DRAG_MIME).trim()
}

function getDragDocumentIds(event: DragEvent<HTMLElement>): string[] {
  const raw = event.dataTransfer.getData(DOCUMENT_DRAG_MIME) || event.dataTransfer.getData('text/plain')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean)
    }
  } catch {
    // Fall back to plain text payloads from older drags.
  }
  return raw.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)
}

function getFolderDropPosition(event: DragEvent<HTMLElement>): FolderDropPosition {
  const rect = event.currentTarget.getBoundingClientRect()
  const offsetY = event.clientY - rect.top
  if (offsetY < rect.height * 0.25) return 'before'
  if (offsetY > rect.height * 0.75) return 'after'
  return 'inside'
}

function getDroppedFiles(event: DragEvent<HTMLElement>): File[] {
  return Array.from(event.dataTransfer.files)
}

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.round(size))
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize))
  }
  return chunks
}

function getFolderOcrEngineLabel(engine: OcrEngine | string): string {
  return engine === 'local_paddle' ? '本地 OCR' : engine === 'vision_model' ? '大模型 OCR' : engine === 'hybrid' ? '混合 OCR' : '飞桨 OCR'
}

async function getConfiguredDefaultFolderOcrEngine(): Promise<OcrEngine> {
  const rawValue = await window.api.getSetting('ocr_default_engine')
  return rawValue === 'paddle' || rawValue === 'vision_model' ? rawValue : 'paddle'
}

async function hasFolderOcrEngineConfig(engine: OcrEngine): Promise<boolean> {
  if (engine === 'local_paddle') {
    const status = await window.api.getLocalPaddleOcrStatus()
    return status.installed
  }
  if (engine === 'paddle') return window.api.checkOcrToken()
  if (engine === 'hybrid') {
    return (await Promise.all([window.api.checkOcrToken(), window.api.checkVisionOcrConfig()])).every(Boolean)
  }
  return window.api.checkVisionOcrConfig()
}

function getFolderOcrConfigWarning(engine: OcrEngine): string {
  if (engine === 'local_paddle') return '请先在设置页下载本地 OCR 模型。'
  if (engine === 'vision_model') return '请先在设置页配置视觉模型 OCR。'
  if (engine === 'hybrid') return '混合 OCR 需要同时配置飞桨 OCR 和视觉模型 OCR。'
  return '请先在设置页配置 PaddleOCR API Token。'
}

async function getConfiguredFolderBatchSize(): Promise<number> {
  try {
    const rawValue = await window.api.getSetting('batch_size')
    const parsed = Number.parseInt(String(rawValue || ''), 10)
    const batchSize = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IMPORT_BATCH_SIZE
    return Math.max(1, Math.min(MAX_IMPORT_BATCH_SIZE, batchSize))
  } catch (error) {
    console.warn('[FoldersView] 读取批量处理数量失败，使用默认值', error)
    return DEFAULT_IMPORT_BATCH_SIZE
  }
}

function isFolderDocumentSortValue(value: string): value is FolderDocumentSortValue {
  return FOLDER_DOCUMENT_SORT_OPTIONS.some((option) => option.value === value)
}

function getInitialFolderDocumentSort(): FolderDocumentSortValue {
  try {
    const stored = window.localStorage.getItem(FOLDERS_DOCUMENT_SORT_STORAGE_KEY) || 'default'
    return isFolderDocumentSortValue(stored) ? stored : 'default'
  } catch {
    return 'default'
  }
}

function buildFolderDocumentMenuItems(input: {
  folderTree: Array<FolderTreeNode<FolderOverviewItem>>
  assignedFolderIds: string[]
  documentCount: number
  includeOpenActions?: boolean
  canRemoveFromCurrentFolder: boolean
}): MenuProps['items'] {
  const batch = input.documentCount > 1
  return [
    ...(input.includeOpenActions === false
      ? []
      : [
          { key: 'open_new_tab', label: '在新标签页打开', icon: <BookOutlined /> },
          { key: 'open', label: '打开文献', icon: <BookOutlined /> },
        ]),
    {
      key: 'add_folder',
      label: batch ? `批量加入文件夹（${input.documentCount} 篇）` : '加入文件夹',
      icon: <FolderAddOutlined />,
      popupClassName: 'library-document-folder-submenu',
      children: buildDocumentFolderMenuItems(input.folderTree, input.assignedFolderIds),
    },
    {
      key: 'move',
      label: batch ? `移动到其他文件夹（${input.documentCount} 篇）` : '移动到其他文件夹',
      icon: <SwapOutlined />,
    },
    { type: 'divider' },
    {
      key: 'group_ocr',
      label: 'OCR 识别',
      icon: <ThunderboltOutlined />,
      children: [
        { key: 'ocr:paddle', label: batch ? '批量 OCR（飞桨）' : 'OCR（飞桨）' },
        { key: 'ocr:vision_model', label: batch ? '批量 OCR（大模型）' : 'OCR（大模型）' },
        { type: 'divider' },
        { key: 'ocr_force:paddle', label: batch ? '重新 OCR 所选文献（飞桨）' : '重新 OCR（飞桨）' },
        { key: 'ocr_force:vision_model', label: batch ? '重新 OCR 所选文献（大模型）' : '重新 OCR（大模型）' },
      ],
    },
    {
      key: 'group_organize',
      label: '整理与 AI',
      icon: <RobotOutlined />,
      children: [
        { key: 'metadata_extract', label: batch ? '批量抓取元数据' : '抓取元数据' },
        { key: 'add_tags', label: batch ? '批量添加标签' : '添加标签', icon: <TagOutlined /> },
      ],
    },
    {
      key: 'export',
      label: batch ? '批量导出' : '导出',
      icon: <ExportOutlined />,
      children: [
        { key: 'export:txt', label: '导出为 TXT 纯文本' },
        { key: 'export:markdown', label: '导出为 Markdown' },
        { key: 'export:tei-xml', label: '导出为 TEI-XML' },
        { key: 'export:page-xml', label: '导出为 PAGE XML' },
        { key: 'export:paddle-json', label: '导出为 Paddle JSON' },
        { key: 'export:reading-pdf', label: batch ? '批量导出阅读模式 PDF' : '导出阅读模式 PDF' },
        { key: 'export:layout-pdf', label: batch ? '批量导出排版模式 PDF' : '导出排版模式 PDF' },
      ],
    },
    { type: 'divider' },
    {
      key: 'group_storage',
      label: '原文与存储',
      icon: <PictureOutlined />,
      children: [
        { key: 'cleanup_pdf_assets', label: batch ? '删除所选原文件' : '删除原文件' },
        { key: 'restore_pdf_assets', label: batch ? '补回所选原文' : '补回原文', icon: <ImportOutlined /> },
      ],
    },
    {
      key: 'group_danger',
      label: '移除与删除',
      icon: <DeleteOutlined />,
      children: [
        ...(input.canRemoveFromCurrentFolder
          ? [{ key: 'remove_current', label: batch ? '从当前文件夹移出所选文献' : '从当前文件夹移出', icon: <CloseOutlined /> }]
          : []),
        ...(input.canRemoveFromCurrentFolder ? [{ type: 'divider' as const }] : []),
        { key: 'delete', label: batch ? `从总库永久删除（${input.documentCount} 篇）` : '从总库永久删除', icon: <DeleteOutlined />, danger: true },
      ],
    },
  ]
}

function parseFolderDocumentSortValue(value: FolderDocumentSortValue): Pick<FolderContentOptions, 'sortKey' | 'sortDirection'> {
  if (value === 'default') return { sortKey: 'default', sortDirection: 'desc' }
  const [sortKey, sortDirection] = value.split(':') as [Exclude<LibraryDocumentSortKey, 'default'>, LibraryDocumentSortDirection]
  return { sortKey, sortDirection }
}

function normalizeImportQueuePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/').toLowerCase()
}

function getFolderPath(folder: FolderOverviewItem | null, folders: FolderOverviewItem[]): FolderOverviewItem[] {
  if (!folder) return []
  const byId = new Map(folders.map((item) => [item.id, item]))
  const path: FolderOverviewItem[] = []
  let current: FolderOverviewItem | undefined = folder
  const visited = new Set<string>()
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    path.unshift(current)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
  }
  return path
}

function getDocumentTypeLabel(docType?: string | null): string {
  const raw = String(docType || '').trim()
  if (!raw || raw === 'unknown' || raw === '其他') return '文献'
  if (/journal|article|期刊|论文|杂志/i.test(raw)) return '期刊'
  if (/newspaper|报纸|报刊/i.test(raw)) return '报纸'
  if (/book|monograph|图书|专著|古籍/i.test(raw)) return '图书'
  if (/archive|档案/i.test(raw)) return '档案'
  if (/thesis|学位|硕士|博士/i.test(raw)) return '论文'
  if (/local|gazetteer|方志|地方志/i.test(raw)) return '方志'
  return raw.length > 6 ? raw.slice(0, 6) : raw
}

function getDocumentCoverClass(docType?: string | null): string {
  const label = getDocumentTypeLabel(docType)
  if (label === '期刊') return 'is-journal'
  if (label === '报纸') return 'is-newspaper'
  if (label === '档案') return 'is-archive'
  if (label === '论文') return 'is-thesis'
  if (label === '方志') return 'is-gazetteer'
  return 'is-book'
}

function isFoldersMarqueeBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true
  return !!target.closest([
    '[data-folder-document-card="true"]',
    '.folder-card',
    '.folders-tree-row',
    '.folders-root-drop',
    '.folders-selection-bar',
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

export default function FoldersView({ onOpenFolder, onOpenDocument, initialState, onStateChange }: FoldersViewProps) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const suppressDocumentClickRef = useRef(false)
  const lastSelectedDocumentIdRef = useRef<string | null>(null)
  const restoredStateRef = useRef(false)
  const activeImportFilePathsRef = useRef<Set<string>>(new Set())
  const [overview, setOverview] = useState<FolderOverviewResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(initialState?.selectedFolderId ?? null)
  const [collapsedIds, setCollapsedIds] = useState<string[]>([])
  const [dropTarget, setDropTarget] = useState<{ id: string; position: FolderDropPosition } | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<FolderOverviewItem | null>(null)
  const [editorName, setEditorName] = useState('')
  const [editorParentId, setEditorParentId] = useState<string | null>(null)
  const [folderContent, setFolderContent] = useState<FolderContentResult | null>(createEmptyFolderContent(null))
  const [contentLoading, setContentLoading] = useState(false)
  const [contentLoadingMore, setContentLoadingMore] = useState(false)
  const [coverSources, setCoverSources] = useState<Record<string, string>>({})
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([])
  const [documentSort, setDocumentSort] = useState<FolderDocumentSortValue>(() => getInitialFolderDocumentSort())
  const [documentSizePreset, setDocumentSizePreset] = useState<DocumentSizePreset>('medium')
  const [documentCardSize, setDocumentCardSize] = useState<number>(DOCUMENT_CARD_SIZE_PRESETS.medium)
  const [moveModalOpen, setMoveModalOpen] = useState(false)
  const [moveModalDocIds, setMoveModalDocIds] = useState<string[]>([])
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string | null>(null)
  const [tagModalOpen, setTagModalOpen] = useState(false)
  const [tagModalDocIds, setTagModalDocIds] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [exportModalDocIds, setExportModalDocIds] = useState<string[]>([])
  const [pendingExportFormat, setPendingExportFormat] = useState<DocumentExportFormat | null>(null)
  const [exportPageNumberMode, setExportPageNumberMode] = useState<ExportPageNumberMode>('literature')
  const [exportingFolderDocs, setExportingFolderDocs] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgressText, setImportProgressText] = useState('')

  const folders = overview?.folders || []
  const folderTree = useMemo(() => buildFolderTree(folders), [folders])
  const visibleTree = useMemo(() => flattenVisibleFolders(folderTree, collapsedIds), [collapsedIds, folderTree])
  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders])
  const selectedIsUnfiled = selectedFolderId === UNFILED_FOLDER_ID
  const selectedFolder = selectedFolderId && !selectedIsUnfiled ? folderById.get(selectedFolderId) || null : null
  const selectedDocumentIdSet = useMemo(() => new Set(selectedDocumentIds), [selectedDocumentIds])
  const documentIdOrder = useMemo(() => folderContent?.documents.map((doc) => doc.id) || [], [folderContent])
  const childFolders = useMemo(() => (
    selectedIsUnfiled
      ? []
      : folders
        .filter((folder) => (selectedFolderId ? folder.parent_id === selectedFolderId : !folder.parent_id))
        .sort(sortFolders)
  ), [folders, selectedFolderId, selectedIsUnfiled])
  const folderPath = useMemo(() => getFolderPath(selectedFolder, folders), [folders, selectedFolder])
  const folderMoveOptions = useMemo(() => (
    flattenVisibleFolders(buildFolderTree(folders), []).map((folder) => ({
      label: `${'　'.repeat(folder.depth)}${folder.name}`,
      value: folder.id,
      disabled: folder.id === selectedFolder?.id,
    }))
  ), [folders, selectedFolder])

  const clearDocumentSelection = useCallback(() => {
    setSelectedDocumentIds([])
    lastSelectedDocumentIdRef.current = null
  }, [])

  const removeDeletedDocumentsFromFolderContent = useCallback((deletedIds: string[]) => {
    const deletedIdSet = new Set(deletedIds)
    if (deletedIdSet.size === 0) return
    setFolderContent((current) => {
      if (!current) return current
      const documents = current.documents.filter((document) => !deletedIdSet.has(document.id))
      const removedLoadedCount = current.documents.length - documents.length
      if (removedLoadedCount === 0) return current
      const totalDocumentCount = Math.max(0, current.total_document_count - removedLoadedCount)
      return {
        ...current,
        documents,
        total_document_count: totalDocumentCount,
        has_more: documents.length < totalDocumentCount,
      }
    })
    setSelectedDocumentIds((current) => current.filter((id) => !deletedIdSet.has(id)))
    setCoverSources((current) => {
      let changed = false
      const next = { ...current }
      deletedIdSet.forEach((id) => {
        if (!Object.prototype.hasOwnProperty.call(next, id)) return
        delete next[id]
        changed = true
      })
      return changed ? next : current
    })
  }, [])

  const emitStateChange = useCallback((folderId = selectedFolderId) => {
    onStateChange?.({
      selectedFolderId: folderId,
      selectedFolderName: folderId === UNFILED_FOLDER_ID
        ? UNFILED_FOLDER_NAME
        : folders.find((folder) => folder.id === folderId)?.name || '',
      scrollTop: contentRef.current?.scrollTop || 0,
    })
  }, [folders, onStateChange, selectedFolderId])

  const buildContentOptions = useCallback((folderId: string | null, offset = 0): FolderContentOptions => ({
    ...parseFolderDocumentSortValue(documentSort),
    folderId: folderId && folderId !== UNFILED_FOLDER_ID ? folderId : null,
    unfiledOnly: folderId === UNFILED_FOLDER_ID,
    limit: FOLDER_CONTENT_PAGE_SIZE,
    offset,
  }), [documentSort])

  const loadFolderContent = useCallback(async (folderId: string | null, options?: { append?: boolean; offset?: number }) => {
    if (!folderId) {
      setFolderContent(createEmptyFolderContent(null))
      setSelectedDocumentIds([])
      return
    }

    const offset = options?.append ? Math.max(0, Number(options.offset || 0)) : 0
    if (options?.append) {
      setContentLoadingMore(true)
    } else {
      setContentLoading(true)
      setSelectedDocumentIds([])
    }

    try {
      const nextContent = await window.api.getFolderContent(buildContentOptions(folderId, offset))
      setFolderContent((current) => {
        if (!options?.append) return nextContent
        const existing = current?.documents || []
        const existingIds = new Set(existing.map((doc) => doc.id))
        return {
          ...nextContent,
          documents: [...existing, ...nextContent.documents.filter((doc) => !existingIds.has(doc.id))],
          offset: current?.offset || 0,
        }
      })
    } catch (error) {
      message.error(getErrorMessage(error, '加载文件夹文献失败'))
    } finally {
      setContentLoading(false)
      setContentLoadingMore(false)
    }
  }, [buildContentOptions])

  const loadOverview = useCallback(async () => {
    setLoading(true)
    try {
      const nextOverview = await window.api.getFolderOverview()
      setOverview(nextOverview)
      setSelectedFolderId((current) => (
        current && current !== UNFILED_FOLDER_ID && !nextOverview.folders.some((folder) => folder.id === current) ? null : current
      ))
    } catch (error) {
      message.error(getErrorMessage(error, '加载文件夹失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    emitStateChange(selectedFolderId)
  }, [emitStateChange, selectedFolderId])

  useEffect(() => {
    setCoverSources({})
    void loadFolderContent(selectedFolderId)
  }, [documentSort, loadFolderContent, selectedFolderId])

  useEffect(() => {
    try {
      window.localStorage.setItem(FOLDERS_DOCUMENT_SORT_STORAGE_KEY, documentSort)
    } catch {
      // Local storage is optional; sorting still works for this session.
    }
  }, [documentSort])

  useEffect(() => {
    const anchorId = lastSelectedDocumentIdRef.current
    if (selectedDocumentIds.length === 0 || (anchorId && !documentIdOrder.includes(anchorId))) {
      lastSelectedDocumentIdRef.current = null
    }
  }, [documentIdOrder, selectedDocumentIds.length])

  useEffect(() => {
    if (restoredStateRef.current || !initialState || !contentRef.current || loading || contentLoading) return
    if (initialState.selectedFolderId !== selectedFolderId) return
    const timer = window.setTimeout(() => {
      if (contentRef.current) contentRef.current.scrollTop = Math.max(0, Number(initialState.scrollTop || 0))
      restoredStateRef.current = true
    }, 0)
    return () => window.clearTimeout(timer)
  }, [contentLoading, folderContent?.documents.length, initialState, loading, selectedFolderId])

  useEffect(() => {
    const handleChanged = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.source === 'folders-delete') return
      void loadOverview()
      void loadFolderContent(selectedFolderId)
    }
    window.addEventListener(LIBRARY_RELATIONS_CHANGED_EVENT, handleChanged)
    return () => window.removeEventListener(LIBRARY_RELATIONS_CHANGED_EVENT, handleChanged)
  }, [loadFolderContent, loadOverview, selectedFolderId])

  useEffect(() => {
    let cancelled = false
    const loadCovers = async () => {
      const documents = folderContent?.documents || []
      const missing = documents.filter((doc) => coverSources[doc.id] === undefined)
      if (missing.length === 0) return
      const entries = await Promise.all(missing.map(async (doc) => {
        const imagePath = doc.thumb_path || doc.first_page_image_path
        if (!imagePath) return [doc.id, ''] as const
        try {
          const dataUrl = await window.api.readImageAsDataURL(imagePath)
          return [doc.id, dataUrl] as const
        } catch {
          return [doc.id, ''] as const
        }
      }))
      if (cancelled) return
      setCoverSources((current) => ({ ...current, ...Object.fromEntries(entries) }))
    }
    void loadCovers()
    return () => {
      cancelled = true
    }
  }, [coverSources, folderContent])

  const openCreateFolder = (parentId: string | null) => {
    setEditingFolder(null)
    setEditorName('')
    setEditorParentId(parentId)
    setEditorOpen(true)
  }

  const openRenameFolder = (folder: FolderOverviewItem) => {
    setEditingFolder(folder)
    setEditorName(folder.name)
    setEditorParentId(folder.parent_id || null)
    setEditorOpen(true)
  }

  const reloadAfterMutation = async () => {
    await loadOverview()
    await loadFolderContent(selectedFolderId)
    window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
  }

  const handleSaveFolder = async () => {
    const name = editorName.trim()
    if (!name) {
      message.info('请输入文件夹名称')
      return
    }
    try {
      if (editingFolder) {
        await window.api.updateFolder(editingFolder.id, { name, parent_id: editorParentId || null })
        message.success('文件夹已更新')
      } else {
        await window.api.createFolder({ name, parent_id: editorParentId || undefined })
        message.success('已创建文件夹')
      }
      setEditorOpen(false)
      setEditingFolder(null)
      setEditorName('')
      setEditorParentId(null)
      await reloadAfterMutation()
    } catch (error) {
      message.error(getErrorMessage(error, editingFolder ? '更新文件夹失败' : '创建文件夹失败'))
    }
  }

  const handleDeleteFolder = (folder: FolderOverviewItem) => {
    Modal.confirm({
      title: `删除文件夹“${folder.name}”？`,
      content: '只删除文件夹和归类关系，不会删除文献本体。子文件夹会移动到顶层。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        await window.api.deleteFolder(folder.id)
        if (selectedFolderId === folder.id) setSelectedFolderId(null)
        await reloadAfterMutation()
      },
    })
  }

  const buildFolderContextMenuItems = (folder: FolderOverviewItem): MenuProps['items'] => [
    { key: 'open_here', label: '打开文件夹', icon: <FolderOpenOutlined /> },
    { key: 'open_library', label: '在文献库中打开', icon: <BookOutlined /> },
    { type: 'divider' },
    { key: 'create_child', label: '新建子文件夹', icon: <FolderAddOutlined /> },
    { key: 'rename', label: '重命名', icon: <EditOutlined /> },
    { type: 'divider' },
    { key: 'delete', label: '删除文件夹', icon: <DeleteOutlined />, danger: true },
  ]

  const handleFolderContextMenuClick = (folder: FolderOverviewItem, key: string) => {
    if (key === 'open_here') setSelectedFolderId(folder.id)
    if (key === 'open_library') onOpenFolder?.(folder.id)
    if (key === 'create_child') openCreateFolder(folder.id)
    if (key === 'rename') openRenameFolder(folder)
    if (key === 'delete') handleDeleteFolder(folder)
  }

  const handleMoveFolder = useCallback(async (folderId: string, parentId: string | null, options?: { beforeId?: string | null; afterId?: string | null }) => {
    if (!folderId) return
    if (folderId === parentId) {
      message.warning('不能把文件夹移动到自己里面')
      return
    }
    if (parentId && isFolderDescendant(folders, parentId, folderId)) {
      message.warning('不能把文件夹移动到自己的子文件夹里面')
      return
    }
    try {
      await window.api.moveFolder({
        id: folderId,
        parent_id: parentId,
        before_id: options?.beforeId || null,
        after_id: options?.afterId || null,
      })
      await loadOverview()
      await loadFolderContent(selectedFolderId)
      window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
      message.success('文件夹位置已更新')
    } catch (error) {
      message.error(getErrorMessage(error, '移动文件夹失败'))
    }
  }, [folders, loadFolderContent, loadOverview, selectedFolderId])

  const handleMoveDocumentsToFolder = useCallback(async (docIds: string[], targetFolderId: string) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) return
    const sourceFolderId = selectedFolder?.id || null
    if (sourceFolderId === targetFolderId) {
      message.info('这些文献已经在当前文件夹中')
      return
    }
    try {
      await window.api.moveDocumentsToFolder({
        docIds: uniqueDocIds,
        source_folder_id: sourceFolderId,
        target_folder_id: targetFolderId,
      })
      const targetName = folderById.get(targetFolderId)?.name || '目标文件夹'
      message.success(`已移动 ${uniqueDocIds.length} 篇文献到“${targetName}”`)
      setSelectedDocumentIds([])
      await loadOverview()
      await loadFolderContent(selectedFolderId)
      window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
    } catch (error) {
      message.error(getErrorMessage(error, '移动文献失败'))
    }
  }, [folderById, loadFolderContent, loadOverview, selectedFolder, selectedFolderId])

  const handleAddDocumentsToFolder = useCallback(async (docIds: string[], targetFolderId: string) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    if (!targetFolderId) return
    try {
      await window.api.addDocumentsToFolder(uniqueDocIds, targetFolderId)
      const targetName = folderById.get(targetFolderId)?.name || '目标文件夹'
      message.success(`已将 ${uniqueDocIds.length} 篇文献加入文件夹“${targetName}”`)
      await loadOverview()
      await loadFolderContent(selectedFolderId)
      window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
    } catch (error) {
      message.error(getErrorMessage(error, '加入文件夹失败'))
    }
  }, [folderById, loadFolderContent, loadOverview, selectedFolderId])

  const openMoveDocumentsModal = useCallback((docIds: string[]) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    if (folders.length === 0) {
      message.info('请先创建目标文件夹')
      return
    }
    const defaultTarget = folders.find((folder) => folder.id !== selectedFolder?.id)?.id || null
    setMoveModalDocIds(uniqueDocIds)
    setMoveTargetFolderId(defaultTarget)
    setMoveModalOpen(true)
  }, [folders, selectedFolder])

  const handleConfirmMoveDocuments = useCallback(async () => {
    if (!moveTargetFolderId) {
      message.info('请选择目标文件夹')
      return
    }
    await handleMoveDocumentsToFolder(moveModalDocIds, moveTargetFolderId)
    setMoveModalOpen(false)
    setMoveModalDocIds([])
    setMoveTargetFolderId(null)
  }, [handleMoveDocumentsToFolder, moveModalDocIds, moveTargetFolderId])

  const handleRemoveDocumentsFromCurrentFolder = useCallback(async (docIds: string[]) => {
    const currentFolderId = selectedFolder?.id || null
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (!currentFolderId) {
      message.info('当前不是具体文件夹，不能执行移出操作')
      return
    }
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    try {
      for (const batch of chunkArray(uniqueDocIds, 50)) {
        await Promise.all(batch.map((docId) => window.api.removeDocumentFromFolder(docId, currentFolderId)))
        await delay(0)
      }
      message.success(`已从当前文件夹移出 ${uniqueDocIds.length} 篇文献`)
      setSelectedDocumentIds([])
      await loadOverview()
      await loadFolderContent(selectedFolderId)
      window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
    } catch (error) {
      message.error(getErrorMessage(error, '移出文献失败'))
    }
  }, [loadFolderContent, loadOverview, selectedFolder, selectedFolderId])

  const handleDeleteDocuments = useCallback((docIds: string[]) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    Modal.confirm({
      title: `删除 ${uniqueDocIds.length} 篇文献？`,
      content: '这会删除文献本体、页面和相关缓存，不只是从当前文件夹移出。',
      okText: '删除文献',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await window.api.deleteDocumentsBatch(uniqueDocIds)
          removeDeletedDocumentsFromFolderContent(result.deletedIds)
          if (result.failedIds.length > 0) {
            message.warning(`已提交 ${result.successCount} 篇后台删除，${result.failedIds.length} 篇提交失败`)
          } else {
            message.success(`已提交 ${result.successCount} 篇文献后台删除`)
          }
          void loadOverview()
          window.dispatchEvent(new CustomEvent(LIBRARY_RELATIONS_CHANGED_EVENT, { detail: { source: 'folders-delete' } }))
        } catch (error) {
          message.error(getErrorMessage(error, '删除文献失败'))
        }
      },
    })
  }, [loadOverview, removeDeletedDocumentsFromFolderContent])

  const getActionDocIds = useCallback((docId: string) => {
    return selectedDocumentIdSet.has(docId) && selectedDocumentIds.length > 0 ? selectedDocumentIds : [docId]
  }, [selectedDocumentIdSet, selectedDocumentIds])

  const runFolderOcrInConfiguredBatches = useCallback(async (
    docIds: string[],
    engine: OcrEngine,
    messageKey: string,
    options?: { forceFullRerun?: boolean },
  ) => {
    const uniqueDocIds = Array.from(new Set(docIds.filter(Boolean)))
    if (uniqueDocIds.length === 0) return 0

    // Setting value = max concurrent docs; whole selection is enqueued once.
    const documentConcurrency = await getConfiguredFolderBatchSize()
    let successCount = 0
    let shouldRefreshAfterBatches = false
    const requiresPageImagesBeforeOcr = engine === 'local_paddle' || engine === 'vision_model' || engine === 'hybrid'

    let ocrBatch = uniqueDocIds
    if (requiresPageImagesBeforeOcr) {
      ocrBatch = []
      for (let docIndex = 0; docIndex < uniqueDocIds.length; docIndex += 1) {
        const docId = uniqueDocIds[docIndex]
        try {
          const result = await ensureOcrPageImages(docId, {
            fileIndex: docIndex,
            totalFiles: uniqueDocIds.length,
            engine,
            messageKey,
            getEngineLabel: getFolderOcrEngineLabel,
            onProgress: (content, key) => {
              setImportProgressText(content)
              if (key) message.loading({ content, key, duration: 0 })
            },
          })
          if (result.ready) ocrBatch.push(docId)
        } catch (error) {
          const reason = getErrorMessage(error, '未知错误')
          console.warn('[FoldersView] OCR 前补齐 PDF 页图失败', docId, error)
          await window.api.updateDocument(docId, {
            ocr_status: 'error',
            import_status: 'error',
            error_message: `OCR 页图补齐失败：${reason}。请确认该文献所属数据库包含 PDF/页图资源，或把原 PDF 加入“PDF 原件仓库”后重试。`,
          })
          shouldRefreshAfterBatches = true
        }
        await delay(0)
      }
    }

    if (ocrBatch.length > 0) {
      message.loading({
        content: `正在用${getFolderOcrEngineLabel(engine)}识别 ${ocrBatch.length} 篇文献…`,
        key: messageKey,
        duration: 0,
      })
      successCount = await window.api.batchOcr(ocrBatch, {
        engine,
        forceFullRerun: options?.forceFullRerun,
        concurrency: documentConcurrency,
      })
      shouldRefreshAfterBatches = true
    }

    if (shouldRefreshAfterBatches) {
      await loadOverview()
      await loadFolderContent(selectedFolderId)
    }
    return successCount
  }, [loadFolderContent, loadOverview, selectedFolderId])

  const handleFolderBatchOcr = useCallback(async (docIds: string[], engine: OcrEngine, forceFullRerun = false) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    const hasConfig = await hasFolderOcrEngineConfig(engine)
    if (!hasConfig) {
      message.warning(getFolderOcrConfigWarning(engine))
      return
    }

    const engineLabel = getFolderOcrEngineLabel(engine)
    message.loading({
      content: forceFullRerun
        ? `正在用${engineLabel}重新 OCR ${uniqueDocIds.length} 篇文献…`
        : `正在用${engineLabel}识别 ${uniqueDocIds.length} 篇文献…`,
      key: FOLDERS_BATCH_OCR_MESSAGE_KEY,
      duration: 0,
    })
    try {
      const successCount = await runFolderOcrInConfiguredBatches(uniqueDocIds, engine, FOLDERS_BATCH_OCR_MESSAGE_KEY, { forceFullRerun })
      message.success({
        content: forceFullRerun
          ? `${engineLabel}重新 OCR 已加入队列，成功处理 ${successCount} 篇`
          : `${engineLabel}OCR 已加入队列，成功处理 ${successCount} 篇`,
        key: FOLDERS_BATCH_OCR_MESSAGE_KEY,
        duration: 5,
      })
      await loadOverview()
      await loadFolderContent(selectedFolderId)
    } catch (error) {
      message.error({ content: getErrorMessage(error, 'OCR 操作失败'), key: FOLDERS_BATCH_OCR_MESSAGE_KEY })
    }
  }, [loadFolderContent, loadOverview, runFolderOcrInConfiguredBatches, selectedFolderId])

  const handleFolderBatchMetadataExtract = useCallback(async (docIds: string[]) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    message.loading({ content: `正在抓取 ${uniqueDocIds.length} 篇文献的元数据…`, key: 'folders-batch-metadata', duration: 0 })
    try {
      const result = await window.api.batchAutoExtract(uniqueDocIds)
      message.success({
        content: `元数据抓取完成：成功 ${result.successCount} 篇，跳过 ${result.skippedCount} 篇，失败 ${result.failedCount} 篇`,
        key: 'folders-batch-metadata',
        duration: 6,
      })
      await loadOverview()
      await loadFolderContent(selectedFolderId)
    } catch (error) {
      message.error({ content: getErrorMessage(error, '批量抓取元数据失败'), key: 'folders-batch-metadata' })
    }
  }, [loadFolderContent, loadOverview, selectedFolderId])

  const openTagDocumentsModal = useCallback((docIds: string[]) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    setTagModalDocIds(uniqueDocIds)
    setTagInput('')
    setTagModalOpen(true)
  }, [])

  const handleConfirmTagDocuments = useCallback(async () => {
    const name = tagInput.trim()
    if (!name) {
      message.info('请输入标签名称')
      return
    }
    try {
      const tag = await window.api.createTag({ name, source: 'manual' })
      if (!tag?.id) {
        message.error('创建标签失败')
        return
      }
      await window.api.addDocumentTags(tagModalDocIds, [tag.id])
      message.success(`已为 ${tagModalDocIds.length} 篇文献添加标签“${tag.name}”`)
      setTagModalOpen(false)
      setTagModalDocIds([])
      setTagInput('')
      await loadOverview()
      await loadFolderContent(selectedFolderId)
      window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
    } catch (error) {
      message.error(getErrorMessage(error, '批量添加标签失败'))
    }
  }, [loadFolderContent, loadOverview, selectedFolderId, tagInput, tagModalDocIds])

  const openFolderBatchExportModal = useCallback((docIds: string[], format: DocumentExportFormat) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    setExportModalDocIds(uniqueDocIds)
    setPendingExportFormat(format)
    setExportPageNumberMode('literature')
    setExportModalOpen(true)
  }, [])

  const handleFolderBatchExport = useCallback(async () => {
    const format = pendingExportFormat
    const uniqueDocIds = exportModalDocIds
    if (!format || uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    setExportingFolderDocs(true)
    setExportModalOpen(false)
    message.loading({ content: `正在导出 ${uniqueDocIds.length} 篇文献…`, key: FOLDERS_BATCH_EXPORT_MESSAGE_KEY, duration: 0 })
    try {
      const exportOptions: DocumentExportOptions = { pageNumberMode: exportPageNumberMode }
      const result = await window.api.exportDocumentsBatch(uniqueDocIds, format, exportOptions)
      if (result?.canceled) {
        message.destroy(FOLDERS_BATCH_EXPORT_MESSAGE_KEY)
        return
      }
      if (result.failedCount > 0) {
        message.warning({
          content: `已导出 ${result.successCount} 篇，失败 ${result.failedCount} 篇。目录：${result.directoryPath || ''}`,
          key: FOLDERS_BATCH_EXPORT_MESSAGE_KEY,
          duration: 8,
        })
      } else {
        message.success({
          content: `已导出 ${result.successCount} 篇为 ${DOCUMENT_EXPORT_FORMAT_NAMES[format]}`,
          key: FOLDERS_BATCH_EXPORT_MESSAGE_KEY,
          duration: 5,
        })
      }
    } catch (error) {
      message.error({ content: getErrorMessage(error, '批量导出失败'), key: FOLDERS_BATCH_EXPORT_MESSAGE_KEY })
    } finally {
      setExportingFolderDocs(false)
      setPendingExportFormat(null)
      setExportModalDocIds([])
    }
  }, [exportModalDocIds, exportPageNumberMode, pendingExportFormat])

  const handleFolderBatchCleanupPdfAssets = useCallback((docIds: string[]) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    Modal.confirm({
      title: `删除 ${uniqueDocIds.length} 篇文献的本地原文件？`,
      content: '只会删除软件数据目录（storage）内的 PDF 副本和页图缓存。绝不删除 OCR 文本，也绝不删除 PDF 原件仓库 / NAS / 链接的外部源文件。',
      okText: '删除原文件',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        let successCount = 0
        for (const docId of uniqueDocIds) {
          const result = await window.api.cleanupPdfAssets(docId).catch(() => null)
          if (result?.cleaned) successCount += 1
        }
        message.success(`已清理 ${successCount} 篇文献原文件`)
        await loadOverview()
        await loadFolderContent(selectedFolderId)
      },
    })
  }, [loadFolderContent, loadOverview, selectedFolderId])

  const handleFolderBatchRestorePdfAssets = useCallback(async (docIds: string[]) => {
    const uniqueDocIds = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
    if (uniqueDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    message.loading({ content: `正在补回 ${uniqueDocIds.length} 篇文献原文…`, key: 'folders-batch-restore-pdf', duration: 0 })
    let restoredCount = 0
    let failedCount = 0
    for (const docId of uniqueDocIds) {
      try {
        const result = await window.api.restorePdfForDocument(docId)
        if (result?.restored) restoredCount += 1
        else failedCount += 1
      } catch {
        failedCount += 1
      }
    }
    if (restoredCount > 0) {
      message.success({ content: `已补回 ${restoredCount} 篇原文${failedCount ? `，${failedCount} 篇未找到` : ''}（模式见设置 → PDF 原件仓库）`, key: 'folders-batch-restore-pdf', duration: 5 })
    } else {
      message.warning({ content: '未能补回原文，请检查 PDF 原件仓库索引', key: 'folders-batch-restore-pdf', duration: 6 })
    }
    await loadOverview()
    await loadFolderContent(selectedFolderId)
  }, [loadFolderContent, loadOverview, selectedFolderId])

  const handleDocumentSortChange = (value: FolderDocumentSortValue) => {
    setDocumentSort(value)
    clearDocumentSelection()
    setCoverSources({})
    if (contentRef.current) contentRef.current.scrollTop = 0
  }

  const getConfiguredImportBatchSize = useCallback(async () => {
    try {
      const rawValue = await window.api.getSetting('batch_size')
      const parsed = Number.parseInt(String(rawValue || ''), 10)
      const batchSize = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IMPORT_BATCH_SIZE
      return Math.max(1, Math.min(MAX_IMPORT_BATCH_SIZE, batchSize))
    } catch (error) {
      console.warn('[FoldersView] 读取批量导入数量失败，使用默认值', error)
      return DEFAULT_IMPORT_BATCH_SIZE
    }
  }, [])

  const initializeImportedPdfPreview = useCallback(async (
    docId: string,
    filePath: string,
    fileIndex: number,
    totalFiles: number,
    pageCount?: number,
  ) => {
    try {
      const importedPageCount = Math.max(0, Math.round(Number(pageCount || 0)))
      if (importedPageCount <= 0) {
        setImportProgressText(`正在读取第 ${fileIndex + 1}/${totalFiles} 个 PDF 的页数`)
        const info = await getPdfFileInfo(filePath)
        await window.api.initializePdfPages(docId, info.pageCount)
      } else {
        await window.api.initializePdfPages(docId, importedPageCount)
      }

      setImportProgressText(`正在生成第 ${fileIndex + 1}/${totalFiles} 个 PDF 的首页预览`)
      const firstPage = await renderPdfFilePageToImage(filePath, 1)
      await window.api.cachePageImage(docId, 1, firstPage.dataUrl)
    } catch (error) {
      console.warn('[FoldersView] PDF 首页预览生成失败，稍后打开文档时会重试', error)
    }
  }, [])

  const maybeRunAutoOcr = useCallback(async (docIds: string[]) => {
    const uniqueDocIds = Array.from(new Set(docIds.filter(Boolean)))
    if (uniqueDocIds.length === 0) return
    try {
      const autoOcr = await window.api.getSetting('auto_ocr_after_import')
      if (autoOcr === 'false') return
      const engine = await getConfiguredDefaultFolderOcrEngine()
      const ready = await hasFolderOcrEngineConfig(engine)
      if (!ready) {
        message.warning({
          content: `已导入，但${getFolderOcrEngineLabel(engine)}尚未配置完成；${getFolderOcrConfigWarning(engine)}`,
          key: FOLDERS_AUTO_OCR_MESSAGE_KEY,
          duration: 6,
        })
        return
      }
      message.loading({
        content: `已加入 OCR 队列，将按设置分批处理 ${uniqueDocIds.length} 篇文献…`,
        key: FOLDERS_AUTO_OCR_MESSAGE_KEY,
        duration: 0,
      })
      const successCount = await runFolderOcrInConfiguredBatches(uniqueDocIds, engine, FOLDERS_AUTO_OCR_MESSAGE_KEY)
      message.success({
        content: `OCR 已完成，成功处理 ${successCount} 篇文献`,
        key: FOLDERS_AUTO_OCR_MESSAGE_KEY,
      })
      await loadOverview()
      await loadFolderContent(selectedFolderId)
    } catch (error) {
      console.error('[FoldersView] 自动 OCR 失败', error)
      message.error({
        content: `后台 OCR 失败：${getErrorMessage(error, '未知错误')}`,
        key: FOLDERS_AUTO_OCR_MESSAGE_KEY,
        duration: 6,
      })
    }
  }, [loadFolderContent, loadOverview, runFolderOcrInConfiguredBatches, selectedFolderId])

  const importFilesToFolder = useCallback(async (files: File[], folderId?: string | null) => {
    if (files.length === 0) {
      message.info('没有识别到可导入的文件')
      return
    }
    const selectionResult = await window.api.grantDroppedImportSources(files)
    if (!selectionResult.ok) {
      message.error(selectionResult.error.message)
      return
    }
    const selection = selectionResult.value
    let ownershipTransferred = false
    let registeredActive = false
    const newPathKeys = [selection.selectionId]
    try {
    const alreadyActive = newPathKeys.every((key) => activeImportFilePathsRef.current.has(key))
    if (alreadyActive) {
      message.info('这些文件正在导入中')
      return
    }
    newPathKeys.forEach((key) => activeImportFilePathsRef.current.add(key))
    registeredActive = true

    setImporting(true)
    setImportProgressText('正在解析拖入的文件')
    message.loading({ content: '正在解析拖入的文件…', key: FOLDERS_IMPORT_MESSAGE_KEY, duration: 0 })

      const sources = selection.sources
      const sourceFolderIds = new Map<string, string>()

      for (const source of sources.filter((item) => item.isDirectory)) {
        const folder = await window.api.createFolderFromImportSource(selection.selectionId, source.sourceId, folderId || null)
        if (folder?.id) sourceFolderIds.set(source.sourceId, folder.id)
        await delay(0)
      }

      const importBatchSize = await getConfiguredImportBatchSize()
      const defaultOcrEngine = await getConfiguredDefaultFolderOcrEngine()
      let importedCount = 0
      let duplicateCount = 0
      const failedResults: ImportDocumentResult[] = []
      const autoOcrDocIds: string[] = []
      const pdfPreviewQueue: Array<{ docId: string; filePath: string; fileIndex: number; totalFiles: number; pageCount?: number }> = []
      const folderAssociationMap = new Map<string, string[]>()
      const queueFolderAssociation = (docId: string, targetFolderId: string | null) => {
        if (!docId || !targetFolderId) return
        const current = folderAssociationMap.get(targetFolderId) || []
        current.push(docId)
        folderAssociationMap.set(targetFolderId, current)
      }

      let cursor: string | null = null
      let batchIndex = 0
      let processedFileCount = 0
      let selectionDone = false
      while (!selectionDone) {
        const selectionBatchResult = await window.api.readImportSelectionBatch(selection.selectionId, cursor, importBatchSize)
        if (!selectionBatchResult.ok) throw new Error(selectionBatchResult.error.message)
        const selectionBatch = selectionBatchResult.value
        selectionDone = selectionBatch.done
        cursor = selectionBatch.nextCursor
        if (selectionBatch.items.length === 0) {
          if (selectionDone) await window.api.releaseImportSelection(selection.selectionId)
          continue
        }
        batchIndex += 1
        const batch = selectionBatch.items.map((item) => item.grantId)
        const sourceIdByGrantId = new Map(selectionBatch.items.map((item) => [item.grantId, item.sourceId]))
        const start = processedFileCount
        processedFileCount += batch.length
        const progressText = `正在导入第 ${batchIndex} 批（本批 ${batch.length} 个文件）`
        setImportProgressText(progressText)
        message.loading({ content: progressText, key: FOLDERS_IMPORT_MESSAGE_KEY, duration: 0 })

        const batchResults = await window.api.importDocuments(batch, { ocrEngine: defaultOcrEngine })
        for (let resultIndex = 0; resultIndex < batchResults.length; resultIndex += 1) {
          const result = batchResults[resultIndex]
          const sourceGrantId = result.sourceGrantId || batch[resultIndex] || ''
          if (!result.success) {
            failedResults.push(result)
            continue
          }

          const sourceId = sourceIdByGrantId.get(sourceGrantId)
          const targetFolderId = (sourceId && sourceFolderIds.get(sourceId)) || folderId || null
          queueFolderAssociation(result.id, targetFolderId)

          if (result.sourceType === 'duplicate-pdf' || result.sourceType === 'restored-pdf') {
            duplicateCount += 1
            continue
          }

          importedCount += 1
          if (result.sourceType === 'image-file') {
            autoOcrDocIds.push(result.id)
          }

          const pdfWorkPath = result.storedPath || ''
          if (pdfWorkPath.toLowerCase().endsWith('.pdf')) {
            autoOcrDocIds.push(result.id)
            pdfPreviewQueue.push({
              docId: result.id,
              filePath: pdfWorkPath,
              fileIndex: start + resultIndex,
              totalFiles: processedFileCount,
              pageCount: result.pageCount,
            })
          }
        }
        await delay(0)
        if (selectionDone) await window.api.releaseImportSelection(selection.selectionId)
      }

      for (const [targetFolderId, docIds] of folderAssociationMap.entries()) {
        const uniqueDocIds = Array.from(new Set(docIds))
        const associationBatches = chunkArray(uniqueDocIds, importBatchSize)
        for (let batchIndex = 0; batchIndex < associationBatches.length; batchIndex += 1) {
          setImportProgressText(`正在写入文件夹归属 ${batchIndex + 1}/${associationBatches.length}`)
          await window.api.addDocumentsToFolder(associationBatches[batchIndex], targetFolderId)
          await delay(0)
        }
      }

      for (const item of pdfPreviewQueue.slice(0, 24)) {
        await initializeImportedPdfPreview(item.docId, item.filePath, item.fileIndex, item.totalFiles, item.pageCount)
        await delay(0)
      }

      if (importedCount > 0) {
        message.success({
          content: `成功导入 ${importedCount} 篇文献${duplicateCount > 0 ? `；发现 ${duplicateCount} 个重复文件，未重复导入` : ''}`,
          key: FOLDERS_IMPORT_MESSAGE_KEY,
          duration: 5,
        })
      } else if (duplicateCount > 0) {
        message.warning({
          content: `发现 ${duplicateCount} 个重复文件，未重复导入`,
          key: FOLDERS_IMPORT_MESSAGE_KEY,
          duration: 5,
        })
      } else if (failedResults.length > 0) {
        message.error({
          content: failedResults[0].error || '导入文献失败',
          key: FOLDERS_IMPORT_MESSAGE_KEY,
          duration: 6,
        })
      }

      if ((importedCount > 0 || duplicateCount > 0) && failedResults.length > 0) {
        message.warning(`${failedResults.length} 个文件未能导入：${failedResults[0].error || '未知错误'}`)
      }

      await loadOverview()
      await loadFolderContent(selectedFolderId)
      window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
      void maybeRunAutoOcr(autoOcrDocIds)
    } catch (error) {
      console.error('[FoldersView] 拖拽导入失败', error)
      message.error({
        content: `拖拽导入失败：${getErrorMessage(error, '未知错误')}`,
        key: FOLDERS_IMPORT_MESSAGE_KEY,
        duration: 6,
      })
    } finally {
      if (!ownershipTransferred) await window.api.releaseImportSelection(selection.selectionId)
      if (registeredActive) {
        newPathKeys.forEach((key) => activeImportFilePathsRef.current.delete(key))
        setImporting(false)
        setImportProgressText('')
      }
    }
  }, [
    getConfiguredImportBatchSize,
    initializeImportedPdfPreview,
    loadFolderContent,
    loadOverview,
    maybeRunAutoOcr,
    selectedFolderId,
  ])

  const handleImportFilesToFolder = useCallback((event: DragEvent<HTMLElement>, folderId?: string | null) => {
    const files = getDroppedFiles(event)
    if (files.length === 0) {
      message.info('没有识别到可导入的文件')
      return
    }
    void importFilesToFolder(files, folderId || null)
  }, [importFilesToFolder])

  const handleFolderDragStart = (event: DragEvent<HTMLElement>, folderId: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(FOLDER_DRAG_MIME, folderId)
    event.dataTransfer.setData('text/plain', folderId)
  }

  const handleDocumentDragStart = (event: DragEvent<HTMLElement>, docId: string) => {
    const docIds = selectedDocumentIdSet.has(docId) && selectedDocumentIds.length > 0 ? selectedDocumentIds : [docId]
    if (!selectedDocumentIdSet.has(docId)) {
      setSelectedDocumentIds([docId])
      lastSelectedDocumentIdRef.current = docId
    }
    suppressDocumentClickRef.current = true
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DOCUMENT_DRAG_MIME, JSON.stringify(docIds))
    event.dataTransfer.setData('text/plain', docIds.join('\n'))
  }

  const finishDocumentDrag = () => {
    window.setTimeout(() => {
      suppressDocumentClickRef.current = false
    }, 0)
  }

  const handleFolderDrop = async (event: DragEvent<HTMLElement>, targetFolder: FolderOverviewItem) => {
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)

    if (isFolderDrag(event)) {
      const folderId = getDragFolderId(event)
      const position = getFolderDropPosition(event)
      if (position === 'inside') {
        await handleMoveFolder(folderId, targetFolder.id)
      } else {
        await handleMoveFolder(folderId, targetFolder.parent_id || null, {
          beforeId: position === 'before' ? targetFolder.id : null,
          afterId: position === 'after' ? targetFolder.id : null,
        })
      }
      return
    }

    if (isDocumentDrag(event)) {
      await handleMoveDocumentsToFolder(getDragDocumentIds(event), targetFolder.id)
      return
    }

    if (isExternalFileDrag(event)) {
      handleImportFilesToFolder(event, targetFolder.id)
    }
  }

  const updateFolderDropTarget = (event: DragEvent<HTMLElement>, targetId: string) => {
    if (isFolderDrag(event)) {
      setDropTarget({ id: targetId, position: getFolderDropPosition(event) })
    } else if (isDocumentDrag(event) || isExternalFileDrag(event)) {
      setDropTarget({ id: targetId, position: 'inside' })
    }
  }

  const handleDocumentCardClick = (event: MouseEvent<HTMLButtonElement>, docId: string) => {
    if (suppressDocumentClickRef.current) return
    if (event.shiftKey) {
      event.preventDefault()
      const anchorId = lastSelectedDocumentIdRef.current || selectedDocumentIds[selectedDocumentIds.length - 1]
      setSelectedDocumentIds((current) => {
        const start = anchorId ? documentIdOrder.indexOf(anchorId) : -1
        const end = documentIdOrder.indexOf(docId)
        if (start >= 0 && end >= 0) {
          const [from, to] = start <= end ? [start, end] : [end, start]
          const rangeIds = documentIdOrder.slice(from, to + 1)
          if (event.ctrlKey || event.metaKey) return Array.from(new Set([...current, ...rangeIds]))
          return rangeIds
        }
        return current.includes(docId) ? current.filter((id) => id !== docId) : [...current, docId]
      })
      lastSelectedDocumentIdRef.current = docId
      return
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      setSelectedDocumentIds((current) => (
        current.includes(docId) ? current.filter((id) => id !== docId) : [...current, docId]
      ))
      lastSelectedDocumentIdRef.current = docId
      return
    }
    lastSelectedDocumentIdRef.current = docId
    setSelectedDocumentIds([docId])
  }

  const openDocumentInTab = (docId: string) => {
    emitStateChange(selectedFolderId)
    onOpenDocument?.(docId, {
      selectedFolderId,
      scrollTop: contentRef.current?.scrollTop || 0,
    })
  }

  const handleFolderDocumentMenuClick = (docIds: string[], key: string, primaryDocId?: string) => {
    if (key === 'open' || key === 'open_new_tab') {
      if (primaryDocId) openDocumentInTab(primaryDocId)
      return
    }
    if (key.startsWith('folder_')) {
      void handleAddDocumentsToFolder(docIds, key.replace('folder_', ''))
      return
    }
    if (key.startsWith('ocr_force:')) {
      void handleFolderBatchOcr(docIds, key.replace('ocr_force:', '') as OcrEngine, true)
      return
    }
    if (key.startsWith('ocr:')) {
      void handleFolderBatchOcr(docIds, key.replace('ocr:', '') as OcrEngine)
      return
    }
    if (key === 'metadata_extract') void handleFolderBatchMetadataExtract(docIds)
    if (key === 'add_tags') openTagDocumentsModal(docIds)
    if (key === 'move') openMoveDocumentsModal(docIds)
    if (key === 'remove_current') void handleRemoveDocumentsFromCurrentFolder(docIds)
    if (key.startsWith('export:')) openFolderBatchExportModal(docIds, key.replace('export:', '') as DocumentExportFormat)
    if (key === 'cleanup_pdf_assets') handleFolderBatchCleanupPdfAssets(docIds)
    if (key === 'restore_pdf_assets') void handleFolderBatchRestorePdfAssets(docIds)
    if (key === 'delete') handleDeleteDocuments(docIds)
  }

  const loadMoreDocuments = useCallback(async () => {
    if (!selectedFolderId || contentLoading || contentLoadingMore || !folderContent?.has_more) return
    await loadFolderContent(selectedFolderId, { append: true, offset: folderContent.documents.length })
  }, [contentLoading, contentLoadingMore, folderContent, loadFolderContent, selectedFolderId])

  const handleContentScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    const remaining = target.scrollHeight - target.scrollTop - target.clientHeight
    if (remaining < 360) {
      void loadMoreDocuments()
    }
  }

  const handleContentDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!(isExternalFileDrag(event) || isDocumentDrag(event))) return
    event.preventDefault()
    event.stopPropagation()
    if (isExternalFileDrag(event)) {
      handleImportFilesToFolder(event, selectedFolder?.id || null)
      return
    }
    if (!selectedFolder?.id) {
      message.info('请把文献拖到具体文件夹，或先进入目标文件夹')
      return
    }
    void handleMoveDocumentsToFolder(getDragDocumentIds(event), selectedFolder.id)
  }

  const handleContentDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!(isExternalFileDrag(event) || isDocumentDrag(event))) return
    event.preventDefault()
    event.dataTransfer.dropEffect = isExternalFileDrag(event) ? 'copy' : 'move'
  }

  const handleDocumentSizePreset = (preset: DocumentSizePreset) => {
    setDocumentSizePreset(preset)
    setDocumentCardSize(DOCUMENT_CARD_SIZE_PRESETS[preset])
  }

  const adjustDocumentCardSize = (delta: number) => {
    setDocumentCardSize((current) => Math.max(DOCUMENT_CARD_SIZE_MIN, Math.min(DOCUMENT_CARD_SIZE_MAX, current + delta)))
  }

  const handleContentWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    adjustDocumentCardSize(event.deltaY > 0 ? -DOCUMENT_CARD_SIZE_STEP : DOCUMENT_CARD_SIZE_STEP)
  }

  const selectAllLoadedDocuments = useCallback(() => {
    setSelectedDocumentIds(documentIdOrder)
    lastSelectedDocumentIdRef.current = documentIdOrder[documentIdOrder.length - 1] || null
  }, [documentIdOrder])

  const invertLoadedDocumentSelection = useCallback(() => {
    setSelectedDocumentIds((current) => {
      const currentSet = new Set(current)
      const nextIds = documentIdOrder.filter((id) => !currentSet.has(id))
      lastSelectedDocumentIdRef.current = nextIds[nextIds.length - 1] || null
      return nextIds
    })
  }, [documentIdOrder])

  const handleContentClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (suppressDocumentClickRef.current) return
    if (selectedDocumentIds.length === 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (isFoldersMarqueeBlockedTarget(target)) return
    clearDocumentSelection()
  }, [clearDocumentSelection, selectedDocumentIds.length])

  const { startDragSelect: handleContentMouseDown } = useDragMultiSelect<HTMLDivElement>({
    rootRef: contentRef,
    itemSelector: '[data-folder-document-card="true"]',
    selectedIds: selectedDocumentIds,
    orderedIds: documentIdOrder,
    enabled: !contentLoading && documentIdOrder.length > 0,
    getItemId: (element) => element.dataset.documentId,
    isBlockedTarget: isFoldersMarqueeBlockedTarget,
    activeClassName: 'is-marquee-selecting',
    previewClassName: 'is-drag-select-preview',
    reactPreview: false,
    onCommit: (nextIds) => {
      if (!sameStringArray(selectedDocumentIds, nextIds)) {
        setSelectedDocumentIds(nextIds)
      }
      lastSelectedDocumentIdRef.current = nextIds[nextIds.length - 1] || null
    },
    onDragEnd: () => {
      suppressDocumentClickRef.current = true
      window.setTimeout(() => {
        suppressDocumentClickRef.current = false
      }, 0)
    },
  })

  const renderFolderTreeRow = (node: FolderTreeNode<FolderOverviewItem>) => {
    const collapsed = collapsedIds.includes(node.id)
    const hasChildren = node.children.length > 0
    const active = dropTarget?.id === node.id
    const position = active ? dropTarget.position : null
    return (
      <Dropdown
        key={node.id}
        trigger={['contextMenu']}
        menu={{
          items: buildFolderContextMenuItems(node),
          onClick: ({ key }) => handleFolderContextMenuClick(node, String(key)),
        }}
      >
        <div
          className="folders-tree-row"
          draggable
          onDragStart={(event) => handleFolderDragStart(event, node.id)}
          onDragEnd={() => setDropTarget(null)}
          onDragEnter={(event) => {
            if (!(isFolderDrag(event) || isDocumentDrag(event) || isExternalFileDrag(event))) return
            event.preventDefault()
            event.stopPropagation()
            updateFolderDropTarget(event, node.id)
          }}
          onDragOver={(event) => {
            if (!(isFolderDrag(event) || isDocumentDrag(event) || isExternalFileDrag(event))) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = isExternalFileDrag(event) ? 'copy' : 'move'
            updateFolderDropTarget(event, node.id)
          }}
          onDragLeave={(event) => {
            if (!(isFolderDrag(event) || isDocumentDrag(event) || isExternalFileDrag(event))) return
            event.stopPropagation()
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropTarget((current) => current?.id === node.id ? null : current)
            }
          }}
          onDrop={(event) => void handleFolderDrop(event, node)}
          onClick={() => setSelectedFolderId(node.id)}
          onDoubleClick={() => onOpenFolder?.(node.id)}
          data-drag-active={active ? 'true' : 'false'}
          data-drag-pos={position || 'none'}
          style={{ paddingLeft: 10 + node.depth * 18 }}
        >
          <Button
            size="small"
            type="text"
            icon={<RightOutlined style={{ transform: hasChildren && !collapsed ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.18s ease' }} />}
            disabled={!hasChildren}
            onClick={(event) => {
              event.stopPropagation()
              setCollapsedIds((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id])
            }}
          />
          <FolderOutlined />
          <span className="folders-tree-name">{node.name}</span>
          <span className="folders-tree-count">{node.cumulative_document_count}</span>
        </div>
      </Dropdown>
    )
  }

  const renderFolderCard = (folder: FolderOverviewItem) => {
    const active = dropTarget?.id === folder.id
    const position = active ? dropTarget.position : null
    return (
      <Dropdown
        key={folder.id}
        trigger={['contextMenu']}
        menu={{
          items: buildFolderContextMenuItems(folder),
          onClick: ({ key }) => handleFolderContextMenuClick(folder, String(key)),
        }}
      >
        <article
          className="folder-card"
          draggable
          onDragStart={(event) => handleFolderDragStart(event, folder.id)}
          onDragEnd={() => setDropTarget(null)}
          onDragEnter={(event) => {
            if (!(isFolderDrag(event) || isDocumentDrag(event) || isExternalFileDrag(event))) return
            event.preventDefault()
            event.stopPropagation()
            updateFolderDropTarget(event, folder.id)
          }}
          onDragOver={(event) => {
            if (!(isFolderDrag(event) || isDocumentDrag(event) || isExternalFileDrag(event))) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = isExternalFileDrag(event) ? 'copy' : 'move'
            updateFolderDropTarget(event, folder.id)
          }}
          onDragLeave={(event) => {
            if (!(isFolderDrag(event) || isDocumentDrag(event) || isExternalFileDrag(event))) return
            event.stopPropagation()
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropTarget((current) => current?.id === folder.id ? null : current)
            }
          }}
          onDrop={(event) => void handleFolderDrop(event, folder)}
          onClick={() => setSelectedFolderId(folder.id)}
          onDoubleClick={() => onOpenFolder?.(folder.id)}
          data-drag-active={active ? 'true' : 'false'}
          data-drag-pos={position || 'none'}
        >
          <div className="folder-card-main">
            <FolderOpenOutlined className="folder-card-icon" />
            <div className="folder-card-title-area">
              <Tooltip title={folder.name}>
                <h3>{folder.name}</h3>
              </Tooltip>
              <Text type="secondary">
                {folder.cumulative_document_count} 篇文献 · {folder.child_folder_count} 个子文件夹
              </Text>
            </div>
          </div>
          <div className="folder-card-meta">
            <Tag color="blue">直接 {folder.direct_document_count}</Tag>
            {folder.external_path ? (
              <Tooltip title="这个分类由拖入电脑文件夹导入时创建；之后电脑文件夹变化不会自动同步到软件内。">
                <Tag color="gold">拖入导入</Tag>
              </Tooltip>
            ) : null}
          </div>
          {folder.recent_documents.length > 0 ? (
            <div className="folder-card-preview">
              {folder.recent_documents.slice(0, 3).map((doc) => (
                <span key={doc.id}>{doc.title}</span>
              ))}
            </div>
          ) : null}
        </article>
      </Dropdown>
    )
  }

  const renderUnfiledFolderCard = () => {
    const count = overview?.unfiled_document_count || 0
    if (count <= 0) return null
    return (
      <article
        className={`folder-card folder-card-unfiled ${selectedIsUnfiled ? 'is-selected' : ''}`}
        onClick={() => setSelectedFolderId(UNFILED_FOLDER_ID)}
        onDoubleClick={() => onOpenFolder?.(UNFILED_FOLDER_ID)}
        onDragOver={(event) => {
          if (!isExternalFileDrag(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(event) => {
          if (!isExternalFileDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          handleImportFilesToFolder(event, null)
        }}
      >
        <div className="folder-card-main">
          <InboxOutlined className="folder-card-icon" />
          <div className="folder-card-title-area">
            <h3>{UNFILED_FOLDER_NAME}</h3>
            <Text type="secondary">{count} 篇尚未加入任何文件夹的文献</Text>
          </div>
        </div>
        <div className="folder-card-meta">
          <Tag>自动归集</Tag>
        </div>
      </article>
    )
  }

  const renderDocumentCard = (doc: FolderOverviewDocument) => {
    const coverSrc = coverSources[doc.id] || ''
    const typeLabel = getDocumentTypeLabel(doc.doc_type)
    const selected = selectedDocumentIdSet.has(doc.id)
    const actionDocIds = getActionDocIds(doc.id)
    const menuItems = buildFolderDocumentMenuItems({
      folderTree,
      assignedFolderIds: selectedFolder ? [selectedFolder.id] : [],
      documentCount: actionDocIds.length,
      canRemoveFromCurrentFolder: Boolean(selectedFolder),
    })
    return (
      <Dropdown
        key={doc.id}
        trigger={['contextMenu']}
        menu={{
          items: menuItems,
          onClick: ({ key }) => handleFolderDocumentMenuClick(actionDocIds, String(key), doc.id),
        }}
      >
        <button
          type="button"
          className={`folder-document-card ${selected ? 'is-selected' : ''}`}
          draggable
          data-folder-document-card="true"
          data-document-id={doc.id}
          onContextMenu={() => {
            if (!selected) {
              setSelectedDocumentIds([doc.id])
              lastSelectedDocumentIdRef.current = doc.id
            }
          }}
          onDragStart={(event) => handleDocumentDragStart(event, doc.id)}
          onDragEnd={finishDocumentDrag}
          onClick={(event) => handleDocumentCardClick(event, doc.id)}
          onDoubleClick={() => openDocumentInTab(doc.id)}
          title={doc.title}
        >
          <span className={`folder-document-cover ${getDocumentCoverClass(doc.doc_type)}`}>
            {coverSrc ? (
              <img src={coverSrc} alt="" />
            ) : (
              <span className="folder-document-cover-fallback">
                <BookOutlined className="folder-document-cover-icon" />
                <span>{typeLabel}</span>
              </span>
            )}
          </span>
          <span className="folder-document-title">{doc.title}</span>
          <span className="folder-document-meta">
            {doc.page_count ? `${doc.page_count} 页` : typeLabel}
          </span>
        </button>
      </Dropdown>
    )
  }

  const renderDocumentSelectionBar = () => {
    if (selectedDocumentIds.length === 0) return null
    const loadedCount = documentIdOrder.length
    return (
      <div className="folders-selection-bar">
        <div className="folders-selection-info">
          <span>已选 {selectedDocumentIds.length} 篇文献</span>
          <Tooltip title="Ctrl 点击可增减选择；Shift 点击可连续选择；点击空白处退出多选。">
            <QuestionCircleOutlined className="folders-selection-help" />
          </Tooltip>
        </div>
        <Space size={8} wrap>
          <Button size="small" icon={<CheckSquareOutlined />} disabled={loadedCount === 0} onClick={selectAllLoadedDocuments}>
            全选已加载
          </Button>
          <Button size="small" disabled={loadedCount === 0} onClick={invertLoadedDocumentSelection}>
            反选
          </Button>
          <Dropdown
            menu={{
              items: buildFolderDocumentMenuItems({
                folderTree,
                assignedFolderIds: selectedFolder ? [selectedFolder.id] : [],
                documentCount: selectedDocumentIds.length,
                includeOpenActions: false,
                canRemoveFromCurrentFolder: Boolean(selectedFolder),
              }),
              onClick: ({ key }) => handleFolderDocumentMenuClick(selectedDocumentIds, String(key)),
            }}
          >
            <Button size="small" icon={<CheckSquareOutlined />}>
              批量处理
            </Button>
          </Dropdown>
          <Button size="small" onClick={clearDocumentSelection}>
            取消选择
          </Button>
        </Space>
      </div>
    )
  }

  const rootFolderCards = (
    <>
      {childFolders.map(renderFolderCard)}
      {!selectedFolderId ? renderUnfiledFolderCard() : null}
    </>
  )
  const hasFolderCards = childFolders.length > 0 || (!selectedFolderId && Number(overview?.unfiled_document_count || 0) > 0)
  const canShowDocuments = selectedFolderId !== null
  const contentTitle = selectedIsUnfiled ? UNFILED_FOLDER_NAME : selectedFolder?.name || '顶层文件夹'
  const contentDescription = selectedIsUnfiled
    ? `${overview?.unfiled_document_count || 0} 篇尚未加入任何文件夹的文献`
    : selectedFolder
      ? `${selectedFolder.cumulative_document_count} 篇累计文献，${selectedFolder.child_folder_count} 个直接子文件夹`
      : `${overview?.total_document_count || 0} 篇文献，${overview?.unfiled_document_count || 0} 篇未分类`

  return (
    <Layout className="folders-view">
      <Sider width={292} className="folders-view-sider">
        <div className="folders-sider-header">
          <div>
            <Title level={4}>文件夹</Title>
            <Text type="secondary">{overview?.total_folder_count || 0} 个文件夹</Text>
          </div>
          <Space size={6}>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadOverview()} />
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreateFolder(selectedFolder?.id || null)} />
          </Space>
        </div>
        <div
          className={`folders-root-drop ${dropTarget?.id === ROOT_FOLDER_ID ? 'is-active' : ''}`}
          onDragEnter={(event) => {
            if (!(isFolderDrag(event) || isExternalFileDrag(event))) return
            event.preventDefault()
            event.stopPropagation()
            setDropTarget({ id: ROOT_FOLDER_ID, position: 'inside' })
          }}
          onDragOver={(event) => {
            if (!(isFolderDrag(event) || isExternalFileDrag(event))) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = isExternalFileDrag(event) ? 'copy' : 'move'
            setDropTarget({ id: ROOT_FOLDER_ID, position: 'inside' })
          }}
          onDragLeave={(event) => {
            if (!(isFolderDrag(event) || isExternalFileDrag(event))) return
            event.stopPropagation()
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropTarget((current) => current?.id === ROOT_FOLDER_ID ? null : current)
            }
          }}
          onDrop={(event) => {
            if (!(isFolderDrag(event) || isExternalFileDrag(event))) return
            event.preventDefault()
            event.stopPropagation()
            setDropTarget(null)
            if (isExternalFileDrag(event)) {
              handleImportFilesToFolder(event, null)
              return
            }
            const folderId = getDragFolderId(event)
            void handleMoveFolder(folderId, null)
          }}
        >
          拖到这里：文件夹移到顶层，文件导入文库
        </div>
        <Spin spinning={loading}>
          <div className="folders-tree-list">
            <div
              className={`folders-tree-row ${selectedFolderId === null ? 'is-selected' : ''}`}
              onClick={() => setSelectedFolderId(null)}
            >
              <Button size="small" type="text" icon={<RightOutlined style={{ opacity: 0 }} />} disabled />
              <FolderOutlined />
              <span className="folders-tree-name">全部顶层文件夹</span>
              <span className="folders-tree-count">{overview?.root_folder_count || 0}</span>
            </div>
            {(overview?.unfiled_document_count || 0) > 0 ? (
              <div
                className={`folders-tree-row ${selectedIsUnfiled ? 'is-selected' : ''}`}
                onClick={() => setSelectedFolderId(UNFILED_FOLDER_ID)}
                onDoubleClick={() => onOpenFolder?.(UNFILED_FOLDER_ID)}
              >
                <Button size="small" type="text" icon={<RightOutlined style={{ opacity: 0 }} />} disabled />
                <InboxOutlined />
                <span className="folders-tree-name">{UNFILED_FOLDER_NAME}</span>
                <span className="folders-tree-count">{overview?.unfiled_document_count || 0}</span>
              </div>
            ) : null}
            {visibleTree.map(renderFolderTreeRow)}
          </div>
        </Spin>
      </Sider>

      <Content
        ref={contentRef}
        className="folders-view-content"
        style={{ '--folder-document-card-size': `${documentCardSize}px` } as CSSProperties}
        onScroll={handleContentScroll}
        onMouseDown={handleContentMouseDown}
        onClick={handleContentClick}
        onWheel={handleContentWheel}
        onDragOver={handleContentDragOver}
        onDrop={handleContentDrop}
      >
        <div className="folders-content-header">
          <div>
            <div className="folders-breadcrumb">
              <button onClick={() => setSelectedFolderId(null)}>文件夹</button>
              {selectedIsUnfiled ? (
                <span>
                  <RightOutlined />
                  <button onClick={() => setSelectedFolderId(UNFILED_FOLDER_ID)}>{UNFILED_FOLDER_NAME}</button>
                </span>
              ) : folderPath.map((folder) => (
                <span key={folder.id}>
                  <RightOutlined />
                  <button onClick={() => setSelectedFolderId(folder.id)}>{folder.name}</button>
                </span>
              ))}
            </div>
            <Title level={3}>{contentTitle}</Title>
            <Text type="secondary">{contentDescription}</Text>
            {importing || importProgressText ? (
              <div className="folders-inline-progress">
                <Spin size="small" spinning={importing} />
                <span>{importProgressText || '正在导入文献'}</span>
              </div>
            ) : null}
          </div>
          <Space wrap>
            {selectedFolder || selectedIsUnfiled ? (
              <Button icon={<FolderOpenOutlined />} onClick={() => onOpenFolder?.(selectedIsUnfiled ? UNFILED_FOLDER_ID : selectedFolder?.id || '')}>在文献库中打开</Button>
            ) : null}
            <Button type="primary" icon={<FolderAddOutlined />} onClick={() => openCreateFolder(selectedFolder?.id || null)}>新建文件夹</Button>
          </Space>
        </div>

        <Spin spinning={loading || contentLoading}>
          <section className="folder-explorer-section">
            <div className="folder-explorer-section-header">
              <Title level={5}>{selectedIsUnfiled ? '未分类文献' : '子文件夹'}</Title>
              <Text type="secondary">{selectedIsUnfiled ? `${folderContent?.total_document_count || 0} 篇` : `${hasFolderCards ? childFolders.length + (!selectedFolderId && Number(overview?.unfiled_document_count || 0) > 0 ? 1 : 0) : 0} 个`}</Text>
            </div>
            {!selectedIsUnfiled && hasFolderCards ? (
              <div className="folder-card-grid">
                {rootFolderCards}
              </div>
            ) : selectedIsUnfiled ? null : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前层级还没有子文件夹" />
            )}
          </section>

          {canShowDocuments ? (
            <section className="folder-explorer-section">
              <div className="folder-explorer-section-header">
                <Title level={5}>文献</Title>
                <Space size={8} wrap>
                  {selectedDocumentIds.length > 0 ? <Text type="secondary">已选 {selectedDocumentIds.length} 篇</Text> : null}
                  <Text type="secondary">
                    {folderContent?.documents.length || 0}/{folderContent?.total_document_count || 0} 篇
                  </Text>
                  <Select
                    size="small"
                    value={documentSort}
                    options={FOLDER_DOCUMENT_SORT_OPTIONS}
                    onChange={handleDocumentSortChange}
                    style={{ width: 148 }}
                    popupMatchSelectWidth={false}
                  />
                  <Segmented
                    size="small"
                    value={documentSizePreset}
                    options={[
                      { label: '小', value: 'small' },
                      { label: '中', value: 'medium' },
                      { label: '大', value: 'large' },
                    ]}
                    onChange={(value) => handleDocumentSizePreset(value as DocumentSizePreset)}
                  />
                  <Tooltip title="Ctrl + 滚轮也可以调整大小">
                    <Space size={2}>
                      <Button size="small" icon={<ZoomOutOutlined />} onClick={() => adjustDocumentCardSize(-DOCUMENT_CARD_SIZE_STEP)} />
                      <Button size="small" icon={<ZoomInOutlined />} onClick={() => adjustDocumentCardSize(DOCUMENT_CARD_SIZE_STEP)} />
                    </Space>
                  </Tooltip>
                </Space>
              </div>
              {renderDocumentSelectionBar()}
              {folderContent?.documents.length ? (
                <>
                  <div className="folder-document-grid">
                    {folderContent.documents.map(renderDocumentCard)}
                  </div>
                  <div className="folder-content-load-more">
                    {folderContent.has_more ? (
                      <Button loading={contentLoadingMore} onClick={() => void loadMoreDocuments()}>
                        加载更多
                      </Button>
                    ) : (
                      <Text type="secondary">已显示全部文献</Text>
                    )}
                  </div>
                </>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={selectedIsUnfiled ? '当前没有未分类文献' : '当前文件夹没有直接归类的文献'}
                />
              )}
            </section>
          ) : null}
        </Spin>

        {!selectedFolderId ? (
          <div className="folders-root-hint">
            顶层只展示文件夹入口。未分类文献已放入“未分类”，进入具体文件夹后再按需滚动加载文献。
          </div>
        ) : null}
      </Content>

      <Modal
        title={editingFolder ? '重命名文件夹' : '新建文件夹'}
        open={editorOpen}
        onOk={() => void handleSaveFolder()}
        onCancel={() => setEditorOpen(false)}
        okText={editingFolder ? '保存' : '创建'}
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input value={editorName} onChange={(event) => setEditorName(event.target.value)} placeholder="文件夹名称" autoFocus />
          <select className="folders-parent-select" value={editorParentId || ''} onChange={(event) => setEditorParentId(event.target.value || null)}>
            <option value="">顶层文件夹</option>
            {folders
              .filter((folder) => !editingFolder || (folder.id !== editingFolder.id && !isFolderDescendant(folders, folder.id, editingFolder.id)))
              .sort(sortFolders)
              .map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.name}</option>
              ))}
          </select>
        </Space>
      </Modal>

      <Modal
        title={`移入文件夹（${moveModalDocIds.length} 篇）`}
        open={moveModalOpen}
        onOk={() => void handleConfirmMoveDocuments()}
        onCancel={() => {
          setMoveModalOpen(false)
          setMoveModalDocIds([])
          setMoveTargetFolderId(null)
        }}
        okText="移动"
        cancelText="取消"
        okButtonProps={{ disabled: !moveTargetFolderId }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary">移动后会从当前文件夹移出，并加入到目标文件夹；未分类中的文献会直接加入目标文件夹。</Text>
          <Select
            value={moveTargetFolderId || undefined}
            options={folderMoveOptions}
            placeholder="选择目标文件夹"
            showSearch
            optionFilterProp="label"
            style={{ width: '100%' }}
            onChange={(value) => setMoveTargetFolderId(value)}
          />
        </Space>
      </Modal>

      <Modal
        title={`批量添加标签（${tagModalDocIds.length} 篇）`}
        open={tagModalOpen}
        onOk={() => void handleConfirmTagDocuments()}
        onCancel={() => {
          setTagModalOpen(false)
          setTagModalDocIds([])
          setTagInput('')
        }}
        okText="添加标签"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary">输入一个标签名，系统会自动创建或复用同名标签，并添加到所选文献。</Text>
          <Input
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onPressEnter={() => void handleConfirmTagDocuments()}
            placeholder="标签名称"
            autoFocus
          />
        </Space>
      </Modal>

      <Modal
        title="批量导出文献"
        open={exportModalOpen}
        onCancel={() => {
          setExportModalOpen(false)
          setPendingExportFormat(null)
          setExportModalDocIds([])
        }}
        onOk={() => void handleFolderBatchExport()}
        okText="导出"
        cancelText="取消"
        confirmLoading={exportingFolderDocs}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary">
            已选 {exportModalDocIds.length} 篇 · 格式：{pendingExportFormat ? DOCUMENT_EXPORT_FORMAT_NAMES[pendingExportFormat] : ''}
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

    </Layout>
  )
}
