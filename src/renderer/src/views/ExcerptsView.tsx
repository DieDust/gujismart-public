import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Key } from 'react'
import {
  AppstoreOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  TableOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import {
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { MenuProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type {
  OpenDocumentTarget,
  ResearchKnowledgeKind,
  ResearchNote,
  ResearchNoteSourceType,
  ResearchNoteUpdatePayload,
  ResearchProject,
  SearchHitLocator,
  SearchResult,
} from '@shared/types'
import { getErrorMessage } from '@shared/errors'
import { legacySearchLocatorFromUnknown } from '@shared/stable-reader-locator'
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLOR_OPTIONS,
  getHighlightColorLabel,
  getHighlightTextColor,
  hexToRgba,
  normalizeHighlightColor,
} from '../utils/highlightColors'
import {
  buildResearchNoteFallbackCitation,
  buildResearchNoteMarkdown,
  resolveResearchNoteCitationMap,
} from '../utils/citations'

const { Text, Title, Paragraph } = Typography
const { TextArea } = Input

interface ExcerptsViewProps {
  onOpenDocument?: (target: OpenDocumentTarget) => void
}

type JsonRecord = Record<string, unknown>
type ViewMode = 'table' | 'list' | 'cards'
type SortKey = 'updated_desc' | 'created_desc' | 'document_asc' | 'page_asc' | 'kind_asc'
type GroupKey = 'none' | 'project' | 'document' | 'kind' | 'source' | 'color'
type SourceFilter = 'all' | ResearchNoteSourceType | 'reader'
type ProjectFilter = 'all' | 'none' | string
type ColorFilter = 'all' | string
type ExcerptSearchMode = 'keyword' | 'ai'
type ExcerptContextMenuState = {
  note: ResearchNote
  x: number
  y: number
}
type ExcerptAiSearchState = {
  question: string
  answer: string
  results: SearchResult[]
  scopedDocCount: number
}

interface EditNoteValues {
  excerpt: string
  note?: string
  tags?: string
  kind: ResearchKnowledgeKind
  project_id?: string
  page_num?: number | null
  citation_text?: string
  color?: string
}

const NO_PROJECT_VALUE = '__none__'

const KIND_OPTIONS: Array<{ value: ResearchKnowledgeKind; label: string; color: string }> = [
  { value: 'quote', label: '摘录', color: 'blue' },
  { value: 'summary', label: '摘要', color: 'green' },
  { value: 'comment', label: '评论', color: 'purple' },
  { value: 'idea', label: '想法', color: 'gold' },
]

const SOURCE_OPTIONS: Array<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'reader', label: '阅读器' },
  { value: 'search', label: '检索' },
  { value: 'ai', label: 'AI' },
  { value: 'manual', label: '手动' },
]

function splitTags(value?: string | null): string[] {
  return String(value || '')
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(value?: string | null): JsonRecord | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function getSourceString(source: JsonRecord | null | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' ? value : undefined
}

function getSourceNumber(source: JsonRecord | null | undefined, key: string): number | undefined {
  const value = source?.[key]
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function asSearchHitLocator(value: unknown): SearchHitLocator | undefined {
  return legacySearchLocatorFromUnknown(value) || undefined
}

function getKindMeta(kind?: string) {
  return KIND_OPTIONS.find((item) => item.value === kind) || KIND_OPTIONS[0]
}

function getNoteColor(note: ResearchNote): string {
  return normalizeHighlightColor(note.color || DEFAULT_HIGHLIGHT_COLOR)
}

function normalizeHighlightCandidate(value: unknown, maxLength = 180): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function getNoteHighlightText(note: ResearchNote, locator?: SearchHitLocator, legacySource?: JsonRecord | null): string {
  const candidates = [
    locator?.matchText,
    locator?.queryTerm,
    getSourceString(legacySource, 'searchKeyword'),
    getSourceString(legacySource, 'matchedQuery'),
  ]
  const best = candidates.map((item) => normalizeHighlightCandidate(item)).find(Boolean)
  return best || normalizeHighlightCandidate(note.excerpt, 120)
}

function getNoteSourceType(note: ResearchNote): SourceFilter {
  const legacySource = parseJson(note.source_id)
  const sourceType = getSourceString(legacySource, 'sourceType') || note.source_type
  if (sourceType === 'reader') return 'reader'
  if (sourceType === 'search' || sourceType === 'ai' || sourceType === 'manual') return sourceType
  return note.source_type || 'manual'
}

function getNoteSourceLabel(note: ResearchNote): string {
  const sourceType = getNoteSourceType(note)
  if (sourceType === 'search') return '检索'
  if (sourceType === 'ai') return 'AI'
  if (sourceType === 'reader') return '阅读器'
  return '手动'
}

function buildNoteCitation(note: ResearchNote): string {
  return buildResearchNoteFallbackCitation(note)
}

function formatDate(value?: string | null): string {
  const timestamp = Date.parse(value || '')
  if (!Number.isFinite(timestamp)) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function getComparableDate(value?: string | null): number {
  const timestamp = Date.parse(value || '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

function stripSnippetMarkers(value: string): string {
  return String(value || '')
    .replace(/<</g, '')
    .replace(/>>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function renderColorOption(color: string, label = getHighlightColorLabel(color)) {
  const normalized = normalizeHighlightColor(color)
  return (
    <span className="excerpt-color-option">
      <span className="excerpt-color-dot" style={{ background: normalized, boxShadow: `0 0 0 1px ${hexToRgba(normalized, 0.34)}` }} />
      <span>{label}</span>
    </span>
  )
}

export default function ExcerptsView({ onOpenDocument }: ExcerptsViewProps) {
  const [notes, setNotes] = useState<ResearchNote[]>([])
  const [projects, setProjects] = useState<ResearchProject[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<ExcerptSearchMode>('keyword')
  const [aiSearchLoading, setAiSearchLoading] = useState(false)
  const [aiSearchState, setAiSearchState] = useState<ExcerptAiSearchState | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>('all')
  const [kindFilter, setKindFilter] = useState<'all' | ResearchKnowledgeKind>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all')
  const [tagFilter, setTagFilter] = useState('all')
  const [sortKey, setSortKey] = useState<SortKey>('updated_desc')
  const [groupKey, setGroupKey] = useState<GroupKey>('none')
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [editingNote, setEditingNote] = useState<ResearchNote | null>(null)
  const [excerptContextMenu, setExcerptContextMenu] = useState<ExcerptContextMenuState | null>(null)
  const [citationByNoteId, setCitationByNoteId] = useState<Record<string, string>>({})
  const [editForm] = Form.useForm<EditNoteValues>()

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [nextNotes, nextProjects] = await Promise.all([
        window.api.listResearchNotes(null),
        window.api.listResearchProjects(),
      ])
      setNotes(nextNotes)
      setProjects(nextProjects)
    } catch (error: unknown) {
      console.error(error)
      message.error(`加载摘录失败：${getErrorMessage(error, '未知错误')}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    let active = true
    if (!notes.length) {
      setCitationByNoteId({})
      return () => {
        active = false
      }
    }
    void resolveResearchNoteCitationMap(notes)
      .then((nextCitations) => {
        if (active) setCitationByNoteId(nextCitations)
      })
      .catch((error) => {
        console.warn('Failed to prepare citation preview for excerpts.', error)
      })
    return () => {
      active = false
    }
  }, [notes])

  const tagOptions = useMemo(() => {
    const tags = new Set<string>()
    notes.forEach((note) => splitTags(note.tags).forEach((tag) => tags.add(tag)))
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [notes])

  const baseFilteredNotes = useMemo(() => {
    const nextNotes = notes.filter((note) => {
      if (projectFilter === 'none' && note.project_id) return false
      if (projectFilter !== 'all' && projectFilter !== 'none' && note.project_id !== projectFilter) return false
      if (kindFilter !== 'all' && note.kind !== kindFilter) return false
      if (sourceFilter !== 'all' && getNoteSourceType(note) !== sourceFilter) return false
      if (colorFilter !== 'all' && getNoteColor(note).toLowerCase() !== colorFilter.toLowerCase()) return false
      if (tagFilter !== 'all' && !splitTags(note.tags).includes(tagFilter)) return false
      return true
    })

    return [...nextNotes].sort((a, b) => {
      if (sortKey === 'created_desc') return getComparableDate(b.created_at) - getComparableDate(a.created_at)
      if (sortKey === 'document_asc') {
        return String(a.doc_title || '').localeCompare(String(b.doc_title || ''), 'zh-CN')
          || Number(a.page_num || 0) - Number(b.page_num || 0)
      }
      if (sortKey === 'page_asc') {
        return String(a.doc_title || '').localeCompare(String(b.doc_title || ''), 'zh-CN')
          || Number(a.page_num || 0) - Number(b.page_num || 0)
      }
      if (sortKey === 'kind_asc') {
        return getKindMeta(a.kind).label.localeCompare(getKindMeta(b.kind).label, 'zh-CN')
          || getComparableDate(b.updated_at) - getComparableDate(a.updated_at)
      }
      return getComparableDate(b.updated_at) - getComparableDate(a.updated_at)
    })
  }, [colorFilter, kindFilter, notes, projectFilter, sortKey, sourceFilter, tagFilter])

  const filteredNotes = useMemo(() => {
    const keyword = searchMode === 'keyword' ? query.trim().toLocaleLowerCase() : ''
    if (!keyword) return baseFilteredNotes
    return baseFilteredNotes.filter((note) => [
      note.excerpt,
      note.note,
      note.tags,
      note.doc_title,
      note.doc_author,
      note.citation_text,
      getHighlightColorLabel(getNoteColor(note)),
      projectById.get(note.project_id || '')?.name,
    ].some((value) => String(value || '').toLocaleLowerCase().includes(keyword)))
  }, [baseFilteredNotes, projectById, query, searchMode])

  const selectedNotes = useMemo(() => {
    const selectedIds = new Set(selectedRowKeys.map(String))
    return notes.filter((note) => selectedIds.has(note.id))
  }, [notes, selectedRowKeys])

  const scopedExcerptDocIds = useMemo(
    () => [...new Set(baseFilteredNotes.map((note) => note.doc_id).filter((docId): docId is string => !!docId))],
    [baseFilteredNotes],
  )

  const getDisplayCitation = useCallback((note: ResearchNote): string => {
    return citationByNoteId[note.id] || buildNoteCitation(note)
  }, [citationByNoteId])

  const buildExcerptAiContext = useCallback((items: ResearchNote[]) => (
    items
      .slice(0, 36)
      .map((note, index) => [
        `【摘录 ${index + 1}】${note.doc_title || '未命名文献'}${note.page_num ? ` 第 ${note.page_num} 页` : ''}`,
        `类型：${getKindMeta(note.kind).label}；来源：${getNoteSourceLabel(note)}；颜色：${getHighlightColorLabel(getNoteColor(note))}`,
        `摘录：${note.excerpt}`,
        note.note ? `备注：${note.note}` : '',
        `引用：${getDisplayCitation(note)}`,
      ].filter(Boolean).join('\n'))
      .join('\n\n')
  ), [getDisplayCitation])

  const openSearchResultSource = useCallback((item: SearchResult) => {
    const excerpt = stripSnippetMarkers(item.snippet || '')
    const keyword = item.locator?.queryTerm || item.matched_query || query.trim() || excerpt.slice(0, 80)
    onOpenDocument?.({
      docId: item.doc_id,
      pageIndex: item.locator?.pageIndex ?? (item.page_num ? item.page_num - 1 : 0),
      keyword,
      excerpt: excerpt.slice(0, 160),
      highlightExcerpt: keyword,
      sourceId: item.hit_field || 'excerpt-ai-search',
      locator: item.locator,
    })
  }, [onOpenDocument, query])

  const runExcerptAiSearch = useCallback(async () => {
    const question = query.trim()
    if (!question) {
      message.info('请先输入要检索或询问的内容')
      return
    }
    if (baseFilteredNotes.length === 0 || scopedExcerptDocIds.length === 0) {
      message.info('当前摘录范围内没有可用于 AI 检索的文献')
      return
    }

    setAiSearchLoading(true)
    try {
      const libraryPayload = await window.api.runLibraryAiSearch(question, {
        docIds: scopedExcerptDocIds,
        limit: 10,
        contextMode: 'standard',
      }).catch((error: unknown) => {
        console.warn('Excerpt scoped library AI search failed; answering from excerpts only.', error)
        return { answer: '', results: [] as SearchResult[] }
      })
      const excerptContext = buildExcerptAiContext(baseFilteredNotes)
      const hitContext = (libraryPayload.results || [])
        .slice(0, 8)
        .map((item, index) => `【命中 ${index + 1}】${item.doc_title || '未命名文献'} 第 ${item.page_num || '?'} 页\n${stripSnippetMarkers(item.snippet || '')}`)
        .join('\n\n')
      const snippets = [
        '一、当前摘录视图中的摘录',
        excerptContext,
        hitContext ? '二、关联文献检索命中' : '',
        hitContext,
      ].filter(Boolean).join('\n\n')
      const answer = await window.api.runAiTask(scopedExcerptDocIds[0], 'library_qa', question, {
        question,
        snippets,
      })
      setAiSearchState({
        question,
        answer: answer || libraryPayload.answer || '',
        results: Array.isArray(libraryPayload.results) ? libraryPayload.results : [],
        scopedDocCount: scopedExcerptDocIds.length,
      })
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, 'AI 摘录检索失败'))
    } finally {
      setAiSearchLoading(false)
    }
  }, [baseFilteredNotes, buildExcerptAiContext, query, scopedExcerptDocIds])

  const groupedNotes = useMemo(() => {
    if (groupKey === 'none') return [{ key: 'all', label: '全部摘录', notes: filteredNotes }]
    const groups = new Map<string, { key: string; label: string; notes: ResearchNote[] }>()
    filteredNotes.forEach((note) => {
      const kind = getKindMeta(note.kind)
      const sourceLabel = getNoteSourceLabel(note)
      const project = note.project_id ? projectById.get(note.project_id) : null
      const key = groupKey === 'project'
        ? note.project_id || NO_PROJECT_VALUE
        : groupKey === 'document'
          ? note.doc_id
          : groupKey === 'kind'
            ? note.kind
            : groupKey === 'source'
              ? getNoteSourceType(note)
              : getNoteColor(note)
      const label = groupKey === 'project'
        ? project?.name || '未归入专题'
        : groupKey === 'document'
          ? note.doc_title || '未命名文献'
          : groupKey === 'kind'
            ? kind.label
            : groupKey === 'source'
              ? sourceLabel
              : getHighlightColorLabel(getNoteColor(note))
      const current = groups.get(key) || { key, label, notes: [] }
      current.notes.push(note)
      groups.set(key, current)
    })
    return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  }, [filteredNotes, groupKey, projectById])

  const openNoteSource = useCallback((note: ResearchNote) => {
    const legacySource = parseJson(note.source_id)
    const locator = asSearchHitLocator(parseJson(note.locator_json)) || asSearchHitLocator(legacySource?.['locator'])
    const legacyPageNum = getSourceNumber(legacySource, 'pageNum')
    const sourceKeyword = getSourceString(legacySource, 'searchKeyword') || getSourceString(legacySource, 'matchedQuery')
    const highlightText = getNoteHighlightText(note, locator, legacySource)
    const keyword = highlightText || normalizeHighlightCandidate(sourceKeyword || locator?.queryTerm || note.excerpt, 120)
    const highlightColor = getNoteColor(note)
    const sourceLabel = getKindMeta(note.kind).label
    onOpenDocument?.({
      docId: note.doc_id,
      pageIndex: locator?.pageIndex ?? (legacyPageNum ? legacyPageNum - 1 : note.page_num ? note.page_num - 1 : 0),
      keyword,
      excerpt: note.excerpt,
      highlightExcerpt: keyword,
      highlightColor,
      sourceLabel,
      sourceId: note.id,
      locator,
      searchSession: locator
        ? {
          query: keyword,
          hits: [{
            id: `${locator.segmentId}:${locator.occurrenceIndex || 0}:note`,
            locator: { ...locator, queryTerm: keyword, matchText: keyword },
            snippet: note.excerpt,
            score: 0,
          }],
          activeHitIndex: 0,
          status: 'ready',
        }
        : undefined,
    })
  }, [onOpenDocument])

  const copyNoteMarkdown = useCallback(async (note: ResearchNote) => {
    await navigator.clipboard.writeText(await buildResearchNoteMarkdown(note, {
      kindLabel: getKindMeta(note.kind).label,
      sourceLabel: getNoteSourceLabel(note),
    }))
    message.success('已复制摘录 Markdown')
  }, [])

  const copyNoteCitation = useCallback(async (note: ResearchNote) => {
    await navigator.clipboard.writeText(getDisplayCitation(note))
    message.success('已复制引用')
  }, [getDisplayCitation])

  const copyNotesMarkdown = useCallback(async (items: ResearchNote[], label: string) => {
    if (items.length === 0) return
    const markdown = await Promise.all(items.map((note) => buildResearchNoteMarkdown(note, {
      kindLabel: getKindMeta(note.kind).label,
      sourceLabel: getNoteSourceLabel(note),
    })))
    await navigator.clipboard.writeText(markdown.join('\n\n---\n\n'))
    message.success(`已复制${label}：${items.length} 条`)
  }, [])

  const deleteNote = useCallback((note: ResearchNote) => {
    setExcerptContextMenu(null)
    Modal.confirm({
      title: '删除摘录',
      content: '这条摘录会从摘录库和研究专题中移除，原文不会受影响。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      centered: true,
      onOk: async () => {
        await window.api.deleteResearchNote(note.id)
        setNotes((current) => current.filter((item) => item.id !== note.id))
        setSelectedRowKeys((current) => current.filter((key) => String(key) !== note.id))
        message.success('已删除摘录')
      },
    })
  }, [])

  const openEditNote = useCallback((note: ResearchNote) => {
    setExcerptContextMenu(null)
    setEditingNote(note)
    editForm.setFieldsValue({
      excerpt: note.excerpt,
      note: note.note,
      tags: splitTags(note.tags).join(' '),
      kind: note.kind,
      project_id: note.project_id || NO_PROJECT_VALUE,
      page_num: note.page_num,
      citation_text: note.citation_text,
      color: getNoteColor(note),
    })
  }, [editForm])

  const saveEditNote = useCallback(async () => {
    if (!editingNote) return
    const values = await editForm.validateFields()
    const payload: ResearchNoteUpdatePayload = {
      excerpt: values.excerpt.trim(),
      note: values.note?.trim() || '',
      tags: splitTags(values.tags).join(' '),
      kind: values.kind,
      project_id: values.project_id === NO_PROJECT_VALUE ? null : values.project_id || null,
      page_num: values.page_num ?? null,
      citation_text: values.citation_text?.trim() || '',
      color: normalizeHighlightColor(values.color || DEFAULT_HIGHLIGHT_COLOR),
    }
    try {
      await window.api.updateResearchNote(editingNote.id, payload)
      message.success('摘录已更新')
      setEditingNote(null)
      await loadData()
    } catch (error: unknown) {
      console.error(error)
      message.error(`更新摘录失败：${getErrorMessage(error, '未知错误')}`)
    }
  }, [editForm, editingNote, loadData])

  const renderKindTag = (note: ResearchNote) => {
    const kind = getKindMeta(note.kind)
    return <Tag color={kind.color}>{kind.label}</Tag>
  }

  const renderColorTag = (note: ResearchNote) => {
    const color = getNoteColor(note)
    return (
      <Tag
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          marginInlineEnd: 0,
          borderColor: hexToRgba(color, 0.38),
          background: hexToRgba(color, 0.16),
          color: getHighlightTextColor(color),
        }}
      >
        <span className="excerpt-color-dot" style={{ background: color }} />
        {getHighlightColorLabel(color)}
      </Tag>
    )
  }

  const renderTags = (note: ResearchNote) => {
    const tags = splitTags(note.tags)
    if (!tags.length) return null
    return (
      <span className="excerpt-tags">
        {tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
      </span>
    )
  }

  const renderActions = (note: ResearchNote) => (
    <Space size={2}>
      <Tooltip title="回到原文">
        <Button size="small" type="text" icon={<FileSearchOutlined />} onClick={() => openNoteSource(note)} />
      </Tooltip>
      <Tooltip title="编辑">
        <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEditNote(note)} />
      </Tooltip>
      <Tooltip title="复制 Markdown">
        <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copyNoteMarkdown(note)} />
      </Tooltip>
      <Tooltip title="删除">
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => deleteNote(note)} />
      </Tooltip>
    </Space>
  )

  const openExcerptContextMenu = useCallback((note: ResearchNote, event: import('react').MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setExcerptContextMenu({ note, x: event.clientX, y: event.clientY })
    setSelectedRowKeys((current) => current.map(String).includes(note.id) ? current : [note.id])
  }, [])

  const excerptContextMenuItems: MenuProps['items'] = [
    { key: 'open', icon: <FileSearchOutlined />, label: '回到原文' },
    { key: 'edit', icon: <EditOutlined />, label: '编辑摘录' },
    { type: 'divider' },
    { key: 'copyMarkdown', icon: <CopyOutlined />, label: '复制 Markdown' },
    { key: 'copyCitation', icon: <CopyOutlined />, label: '复制引用' },
    { type: 'divider' },
    { key: 'delete', icon: <DeleteOutlined />, label: '删除摘录', danger: true },
  ]

  const handleExcerptContextMenuClick: MenuProps['onClick'] = ({ key }) => {
    const note = excerptContextMenu?.note
    if (!note) return
    setExcerptContextMenu(null)
    if (key === 'open') {
      openNoteSource(note)
      return
    }
    if (key === 'edit') {
      openEditNote(note)
      return
    }
    if (key === 'copyMarkdown') {
      void copyNoteMarkdown(note)
      return
    }
    if (key === 'copyCitation') {
      void copyNoteCitation(note)
      return
    }
    if (key === 'delete') deleteNote(note)
  }

  const renderNoteSummary = (note: ResearchNote, compact = false) => (
    <div className="excerpt-summary">
      <Paragraph className="excerpt-snippet" ellipsis={compact ? { rows: 3, expandable: false } : false}>
        <span className="excerpt-highlight-strip" style={{ background: getNoteColor(note) }} />
        <span>{note.excerpt}</span>
      </Paragraph>
      {note.note ? <Text className="excerpt-note">{truncateText(note.note, compact ? 120 : 220)}</Text> : null}
      {renderTags(note)}
    </div>
  )

  const columns: ColumnsType<ResearchNote> = [
    {
      title: '摘录',
      dataIndex: 'excerpt',
      key: 'excerpt',
      width: '38%',
      render: (_value, note) => renderNoteSummary(note, true),
    },
    {
      title: '文献',
      key: 'document',
      width: '22%',
      render: (_value, note) => (
        <div className="excerpt-doc-cell">
          <Text strong>{note.doc_title || '未命名文献'}</Text>
          {note.doc_author ? <Text type="secondary">{note.doc_author}</Text> : null}
        </div>
      ),
    },
    {
      title: '属性',
      key: 'properties',
      width: 150,
      render: (_value, note) => (
        <Space size={4} wrap>
          {renderKindTag(note)}
          <Tag>{getNoteSourceLabel(note)}</Tag>
          {renderColorTag(note)}
        </Space>
      ),
    },
    {
      title: '专题',
      dataIndex: 'project_id',
      key: 'project',
      width: 150,
      render: (projectId: string | null) => projectById.get(projectId || '')?.name || '未归入专题',
    },
    {
      title: '页码',
      dataIndex: 'page_num',
      key: 'page',
      width: 80,
      render: (pageNum: number | null) => pageNum ? `P.${pageNum}` : '-',
    },
    {
      title: '更新',
      dataIndex: 'updated_at',
      key: 'updated',
      width: 110,
      render: (value: string) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      fixed: 'right',
      render: (_value, note) => renderActions(note),
    },
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[]) => setSelectedRowKeys(keys),
  }

  const renderGroupHeader = (label: string, count: number) => (
    <div className="excerpts-group-header">
      <Text strong>{label}</Text>
      <Tag>{count}</Tag>
    </div>
  )

  const renderTableView = () => (
    <div className="excerpts-table">
      {groupedNotes.map((group) => (
        <section key={group.key} className="excerpts-group">
          {groupKey !== 'none' ? renderGroupHeader(group.label, group.notes.length) : null}
          <Table<ResearchNote>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={group.notes}
            rowSelection={rowSelection}
            onRow={(note) => ({
              onContextMenu: (event) => openExcerptContextMenu(note, event),
            })}
            pagination={groupKey === 'none' ? { pageSize: 12, showSizeChanger: false } : false}
            scroll={{ x: 980 }}
          />
        </section>
      ))}
    </div>
  )

  const renderListView = () => (
    <div className="excerpt-list">
      {groupedNotes.map((group) => (
        <section key={group.key} className="excerpts-group">
          {groupKey !== 'none' ? renderGroupHeader(group.label, group.notes.length) : null}
          {group.notes.map((note) => (
            <article key={note.id} className="excerpt-list-item" onContextMenu={(event) => openExcerptContextMenu(note, event)}>
              <Checkbox
                checked={selectedRowKeys.map(String).includes(note.id)}
                onChange={(event) => {
                  setSelectedRowKeys((current) => event.target.checked
                    ? [...current, note.id]
                    : current.filter((key) => String(key) !== note.id))
                }}
              />
              <div className="excerpt-list-main">
                <div className="excerpt-list-meta">
                  <Space size={4} wrap>
                    {renderKindTag(note)}
                    <Tag>{getNoteSourceLabel(note)}</Tag>
                    {renderColorTag(note)}
                    <Tag>{note.page_num ? `P.${note.page_num}` : '无页码'}</Tag>
                    <Text type="secondary">{projectById.get(note.project_id || '')?.name || '未归入专题'}</Text>
                  </Space>
                  {renderActions(note)}
                </div>
                {renderNoteSummary(note)}
                <Text type="secondary">{getDisplayCitation(note)}</Text>
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  )

  const renderCardView = () => (
    <div className="excerpt-cards">
      {groupedNotes.map((group) => (
        <section key={group.key} className="excerpts-group excerpt-card-group">
          {groupKey !== 'none' ? renderGroupHeader(group.label, group.notes.length) : null}
          <div className="excerpt-card-grid">
            {group.notes.map((note) => (
              <article key={note.id} className="excerpt-card" onContextMenu={(event) => openExcerptContextMenu(note, event)}>
                <div className="excerpt-card-header">
                  <Checkbox
                    checked={selectedRowKeys.map(String).includes(note.id)}
                    onChange={(event) => {
                      setSelectedRowKeys((current) => event.target.checked
                        ? [...current, note.id]
                        : current.filter((key) => String(key) !== note.id))
                    }}
                  />
                  <Space size={4} wrap>
                    {renderKindTag(note)}
                    <Tag>{getNoteSourceLabel(note)}</Tag>
                    {renderColorTag(note)}
                  </Space>
                </div>
                {renderNoteSummary(note, true)}
                <div className="excerpt-card-footer">
                  <div className="excerpt-card-meta">
                    <Text strong>{truncateText(note.doc_title || '未命名文献', 30)}</Text>
                    <Text type="secondary">{note.page_num ? `P.${note.page_num}` : '无页码'} · {formatDate(note.updated_at)}</Text>
                  </div>
                  {renderActions(note)}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  )

  const renderAiSearchPanel = () => {
    if (!aiSearchState && !aiSearchLoading) return null
    return (
      <section className="excerpts-ai-results">
        <div className="excerpts-ai-results-header">
          <Space size={8} wrap>
            <RobotOutlined />
            <Text strong>AI 摘录检索</Text>
            {aiSearchState ? <Tag>{aiSearchState.scopedDocCount} 篇相关文献</Tag> : null}
            {aiSearchState?.results.length ? <Tag color="purple">{aiSearchState.results.length} 条命中</Tag> : null}
          </Space>
          {aiSearchState ? <Text type="secondary">{aiSearchState.question}</Text> : null}
        </div>
        {aiSearchLoading ? (
          <div className="excerpts-ai-loading">
            <RobotOutlined /> 正在结合当前摘录和关联文献检索...
          </div>
        ) : aiSearchState ? (
          <>
            <Paragraph className="excerpts-ai-answer">{aiSearchState.answer || '当前摘录范围内没有足够证据回答这个问题。'}</Paragraph>
            {aiSearchState.results.length > 0 ? (
              <div className="excerpts-ai-hit-list">
                {aiSearchState.results.slice(0, 8).map((item, index) => {
                  const snippet = stripSnippetMarkers(item.snippet || '')
                  return (
                    <button
                      key={`${item.doc_id}-${item.page_num}-${item.rank}-${index}`}
                      type="button"
                      className="excerpts-ai-hit"
                      onClick={() => openSearchResultSource(item)}
                    >
                      <span className="excerpts-ai-hit-title">{item.doc_title || '未命名文献'}</span>
                      <span className="excerpts-ai-hit-meta">第 {item.page_num || '?'} 页{item.matched_query ? ` · ${item.matched_query}` : ''}</span>
                      <span className="excerpts-ai-hit-snippet">{truncateText(snippet, 220)}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    )
  }

  const hasActiveFilter = (searchMode === 'keyword' && Boolean(query.trim()))
    || projectFilter !== 'all'
    || kindFilter !== 'all'
    || sourceFilter !== 'all'
    || colorFilter !== 'all'
    || tagFilter !== 'all'

  return (
    <div className="excerpts-workbench">
      {excerptContextMenu ? (
        <Dropdown
          open
          trigger={['contextMenu']}
          placement="bottomLeft"
          menu={{ items: excerptContextMenuItems, onClick: handleExcerptContextMenuClick }}
          onOpenChange={(open) => {
            if (!open) setExcerptContextMenu(null)
          }}
        >
          <span className="excerpt-context-menu-anchor" style={{ left: excerptContextMenu.x, top: excerptContextMenu.y }} />
        </Dropdown>
      ) : null}
      <div className="excerpts-header">
        <div>
          <Title level={3}>摘录库</Title>
          <Text type="secondary">来自阅读器、检索和 AI 的全部摘录</Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void loadData()} loading={loading}>
            刷新
          </Button>
          <Button icon={<CopyOutlined />} disabled={selectedNotes.length === 0} onClick={() => void copyNotesMarkdown(selectedNotes, '选中摘录')}>
            复制选中
          </Button>
          <Button type="primary" icon={<CopyOutlined />} disabled={filteredNotes.length === 0} onClick={() => void copyNotesMarkdown(filteredNotes, '当前视图')}>
            复制当前视图
          </Button>
        </Space>
      </div>

      <div className="excerpts-metrics">
        <div className="excerpts-metric">
          <Text type="secondary">全部摘录</Text>
          <strong>{notes.length}</strong>
        </div>
        <div className="excerpts-metric">
          <Text type="secondary">当前视图</Text>
          <strong>{filteredNotes.length}</strong>
        </div>
        <div className="excerpts-metric">
          <Text type="secondary">相关文献</Text>
          <strong>{new Set(notes.map((note) => note.doc_id)).size}</strong>
        </div>
        <div className="excerpts-metric">
          <Text type="secondary">标签</Text>
          <strong>{tagOptions.length}</strong>
        </div>
        <div className="excerpts-metric">
          <Text type="secondary">荧光笔</Text>
          <strong>{new Set(notes.map((note) => getNoteColor(note))).size}</strong>
        </div>
      </div>

      <div className="excerpts-toolbar">
        <div className="excerpts-search-cluster">
          <Segmented
            value={searchMode}
            onChange={(value) => {
              setSearchMode(value as ExcerptSearchMode)
              setAiSearchState(null)
            }}
            options={[
              { value: 'keyword', icon: <SearchOutlined />, label: '关键词' },
              { value: 'ai', icon: <RobotOutlined />, label: 'AI' },
            ]}
          />
          <Input.Search
            allowClear
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setAiSearchState(null)
            }}
            onSearch={() => {
              if (searchMode === 'ai') void runExcerptAiSearch()
            }}
            enterButton={searchMode === 'ai' ? <RobotOutlined /> : <SearchOutlined />}
            loading={aiSearchLoading}
            placeholder={searchMode === 'ai' ? '询问当前摘录范围，AI 会检索关联文献' : '搜索摘录、文献、备注、标签'}
            className="excerpts-search"
          />
          {searchMode === 'ai' ? (
            <Text type="secondary" className="excerpts-search-scope">
              范围：{baseFilteredNotes.length} 条摘录，{scopedExcerptDocIds.length} 篇文献
            </Text>
          ) : null}
        </div>
        <Segmented
          value={viewMode}
          onChange={(value) => setViewMode(value as ViewMode)}
          options={[
            { value: 'table', icon: <TableOutlined />, label: '表格' },
            { value: 'list', icon: <UnorderedListOutlined />, label: '列表' },
            { value: 'cards', icon: <AppstoreOutlined />, label: '卡片' },
          ]}
        />
      </div>

      <div className="excerpts-filter-row">
        <Select
          value={projectFilter}
          onChange={(value) => setProjectFilter(value)}
          options={[
            { value: 'all', label: '全部专题' },
            { value: 'none', label: '未归入专题' },
            ...projects.map((project) => ({ value: project.id, label: project.name })),
          ]}
        />
        <Select
          value={kindFilter}
          onChange={(value) => setKindFilter(value)}
          options={[
            { value: 'all', label: '全部类型' },
            ...KIND_OPTIONS.map((item) => ({ value: item.value, label: item.label })),
          ]}
        />
        <Select value={sourceFilter} onChange={(value) => setSourceFilter(value)} options={SOURCE_OPTIONS} />
        <Select
          value={colorFilter}
          onChange={(value) => setColorFilter(value)}
          options={[
            { value: 'all', label: '全部颜色' },
            ...HIGHLIGHT_COLOR_OPTIONS.map((item) => ({ value: item.value, label: renderColorOption(item.value, item.label) })),
          ]}
        />
        <Select
          value={tagFilter}
          onChange={(value) => setTagFilter(value)}
          options={[
            { value: 'all', label: '全部标签' },
            ...tagOptions.map((tag) => ({ value: tag, label: tag })),
          ]}
        />
        <Select
          value={sortKey}
          onChange={(value) => setSortKey(value)}
          options={[
            { value: 'updated_desc', label: '最近更新' },
            { value: 'created_desc', label: '最近创建' },
            { value: 'document_asc', label: '文献标题' },
            { value: 'page_asc', label: '文献页码' },
            { value: 'kind_asc', label: '类型' },
          ]}
        />
        <Select
          value={groupKey}
          onChange={(value) => setGroupKey(value)}
          options={[
            { value: 'none', label: '不分组' },
            { value: 'project', label: '按专题' },
            { value: 'document', label: '按文献' },
            { value: 'kind', label: '按类型' },
            { value: 'source', label: '按来源' },
            { value: 'color', label: '按颜色' },
          ]}
        />
        {hasActiveFilter ? (
          <Button
            onClick={() => {
              setQuery('')
              setProjectFilter('all')
              setKindFilter('all')
              setSourceFilter('all')
              setColorFilter('all')
              setTagFilter('all')
              setAiSearchState(null)
            }}
          >
            清除筛选
          </Button>
        ) : null}
      </div>

      {renderAiSearchPanel()}

      <div className="excerpts-view-shell">
        {filteredNotes.length === 0 && !loading ? (
          <Empty description={notes.length === 0 ? '暂无摘录' : '当前筛选下没有摘录'} />
        ) : viewMode === 'table' ? renderTableView() : viewMode === 'list' ? renderListView() : renderCardView()}
      </div>

      <Modal
        title="编辑摘录"
        open={!!editingNote}
        onCancel={() => setEditingNote(null)}
        onOk={() => void saveEditNote()}
        okText="保存"
        cancelText="取消"
        width={720}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="kind" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
            <Select options={KIND_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
          </Form.Item>
          <Form.Item name="color" label="荧光笔颜色">
            <Select options={HIGHLIGHT_COLOR_OPTIONS.map((item) => ({ value: item.value, label: renderColorOption(item.value, item.label) }))} />
          </Form.Item>
          <Form.Item name="excerpt" label="摘录" rules={[{ required: true, message: '请输入摘录内容' }]}>
            <TextArea autoSize={{ minRows: 4, maxRows: 10 }} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
          </Form.Item>
          <div className="excerpt-edit-grid">
            <Form.Item name="project_id" label="专题">
              <Select
                options={[
                  { value: NO_PROJECT_VALUE, label: '未归入专题' },
                  ...projects.map((project) => ({ value: project.id, label: project.name })),
                ]}
              />
            </Form.Item>
            <Form.Item name="page_num" label="页码">
              <InputNumber min={1} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <Form.Item name="tags" label="标签">
            <Input placeholder="多个标签用空格或逗号分隔" />
          </Form.Item>
          <Form.Item name="citation_text" label="引用文本">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
