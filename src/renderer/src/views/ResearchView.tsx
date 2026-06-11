import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  BookOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FileSearchOutlined,
  FolderAddOutlined,
  PlusOutlined,
  ReadOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import type {
  AiSynthesisTemplate,
  Document,
  DocumentListItem,
  OpenDocumentTarget,
  ResearchDashboardStats,
  ResearchKnowledgeKind,
  ResearchNote,
  ResearchOutlineItem,
  ResearchOutput,
  ResearchProject,
  ResearchReferenceExportFormat,
  SearchHitLocator,
} from '@shared/types'
import { getErrorMessage } from '@shared/errors'
import { DEFAULT_HIGHLIGHT_COLOR, normalizeHighlightColor } from '../utils/highlightColors'
import {
  buildResearchNoteFallbackCitation,
  buildResearchNoteMarkdown,
  formatResearchNoteMarkdown,
  resolveDefaultCitationStyleId,
  resolveResearchNoteCitationMap,
} from '../utils/citations'

const { Text, Title, Paragraph } = Typography
const { TextArea } = Input

interface ResearchViewProps {
  onOpenDocument?: (target: OpenDocumentTarget) => void
}

type NoteScope = 'current' | 'all'
type JsonRecord = Record<string, unknown>

const ANALYSIS_TEMPLATES = [
  { value: 'literature_review', label: '研究综述' },
  { value: 'theme_analysis', label: '主题分析' },
  { value: 'timeline', label: '时间线' },
  { value: 'debate', label: '争议点' },
  { value: 'reading_list', label: '待读清单' },
  { value: 'custom', label: '自定义' },
]

const KNOWLEDGE_KIND_OPTIONS: Array<{ value: ResearchKnowledgeKind; label: string; color: string }> = [
  { value: 'quote', label: '摘录', color: 'blue' },
  { value: 'summary', label: '概述', color: 'green' },
  { value: 'comment', label: '评论', color: 'purple' },
  { value: 'idea', label: '想法', color: 'gold' },
]

function splitTags(value: string): string[] {
  return value.split(/[,，;\s]+/).map((item) => item.trim()).filter(Boolean)
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
  return isRecord(value) ? value as unknown as SearchHitLocator : undefined
}

function getKindLabel(kind?: string): string {
  return KNOWLEDGE_KIND_OPTIONS.find((item) => item.value === kind)?.label || KNOWLEDGE_KIND_OPTIONS[0].label
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

function getKindMeta(kind?: string) {
  return KNOWLEDGE_KIND_OPTIONS.find((item) => item.value === kind) || KNOWLEDGE_KIND_OPTIONS[0]
}

function getNoteSourceLabel(note: ResearchNote): string {
  const source = parseJson(note.source_id)
  const type = getSourceString(source, 'sourceType') || note.source_type
  if (type === 'search') return '检索'
  if (type === 'ai') return 'AI'
  if (type === 'reader' || type === 'manual') return '阅读器'
  return '摘录'
}

function buildNoteCitation(note: ResearchNote, citationByNoteId: Record<string, string> = {}): string {
  return citationByNoteId[note.id] || buildResearchNoteFallbackCitation(note)
}

function buildNoteMarkdown(note: ResearchNote, citationByNoteId: Record<string, string> = {}): string {
  const sourceState = note.source_available ? '' : '\n> 原文待恢复'
  return formatResearchNoteMarkdown(note, buildNoteCitation(note, citationByNoteId), {
    kindLabel: getKindMeta(note.kind).label,
    sourceLabel: getNoteSourceLabel(note),
    sourceState,
  })
}

function outlineDepth(item: ResearchOutlineItem, outlineById: Map<string, ResearchOutlineItem>): number {
  let depth = 0
  let current = item
  const seen = new Set<string>()
  while (current.parent_id && !seen.has(current.parent_id)) {
    seen.add(current.parent_id)
    const parent = outlineById.get(current.parent_id)
    if (!parent) break
    depth += 1
    current = parent
  }
  return depth
}

function renderPreview(
  project: ResearchProject | null,
  outline: ResearchOutlineItem[],
  notes: ResearchNote[],
  references: string,
  citationByNoteId: Record<string, string>,
): string {
  if (!project) return ''
  const byOutline = new Map<string | null, ResearchNote[]>()
  notes.forEach((note) => {
    const key = note.outline_id || null
    byOutline.set(key, [...(byOutline.get(key) || []), note])
  })
  const children = new Map<string, ResearchOutlineItem[]>()
  outline.forEach((item) => {
    if (!item.parent_id) return
    children.set(item.parent_id, [...(children.get(item.parent_id) || []), item])
  })
  const lines = [`# ${project.name}`, '', project.description ? `> ${project.description}` : '', ''].filter(Boolean)
  const renderSection = (item: ResearchOutlineItem, depth = 2) => {
    lines.push(`${'#'.repeat(Math.min(depth, 5))} ${item.title}`, '')
    if (item.description) lines.push(item.description, '')
    ;(byOutline.get(item.id) || []).forEach((note) => lines.push(buildNoteMarkdown(note, citationByNoteId), ''))
    ;(children.get(item.id) || []).forEach((child) => renderSection(child, depth + 1))
  }
  outline.filter((item) => !item.parent_id).forEach((item) => renderSection(item))
  const unassigned = byOutline.get(null) || []
  if (unassigned.length > 0) {
    lines.push('## 未归入大纲的摘录', '')
    unassigned.forEach((note) => lines.push(buildNoteMarkdown(note, citationByNoteId), ''))
  }
  if (references.trim()) lines.push('## 参考文献', '', references.trim())
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export default function ResearchView({ onOpenDocument }: ResearchViewProps) {
  const [projects, setProjects] = useState<ResearchProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [outline, setOutline] = useState<ResearchOutlineItem[]>([])
  const [selectedOutlineId, setSelectedOutlineId] = useState<string | null>(null)
  const [notes, setNotes] = useState<ResearchNote[]>([])
  const [documents, setDocuments] = useState<Document[]>([])
  const [outputs, setOutputs] = useState<ResearchOutput[]>([])
  const [dashboard, setDashboard] = useState<ResearchDashboardStats | null>(null)
  const [citationByNoteId, setCitationByNoteId] = useState<Record<string, string>>({})
  const [projectModalOpen, setProjectModalOpen] = useState(false)
  const [outlineModalOpen, setOutlineModalOpen] = useState(false)
  const [editingOutline, setEditingOutline] = useState<ResearchOutlineItem | null>(null)
  const [noteModalOpen, setNoteModalOpen] = useState(false)
  const [editingNote, setEditingNote] = useState<ResearchNote | null>(null)
  const [addDocsModalOpen, setAddDocsModalOpen] = useState(false)
  const [availableDocs, setAvailableDocs] = useState<DocumentListItem[]>([])
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([])
  const [templateType, setTemplateType] = useState<AiSynthesisTemplate>('literature_review')
  const [customPrompt, setCustomPrompt] = useState('')
  const [synthesizing, setSynthesizing] = useState(false)
  const [references, setReferences] = useState('')
  const [noteScope, setNoteScope] = useState<NoteScope>('current')
  const [noteSourceFilter, setNoteSourceFilter] = useState('all')
  const [noteKindFilter, setNoteKindFilter] = useState('all')
  const [noteTagFilter, setNoteTagFilter] = useState('all')
  const [projectForm] = Form.useForm()
  const [outlineForm] = Form.useForm()
  const [noteForm] = Form.useForm()

  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  )

  const outlineById = useMemo(() => new Map(outline.map((item) => [item.id, item])), [outline])
  const outlineOptions = useMemo(
    () => outline.map((item) => ({
      value: item.id,
      label: `${'  '.repeat(outlineDepth(item, outlineById))}${item.title}`,
    })),
    [outline, outlineById],
  )
  const noteTags = useMemo(() => Array.from(new Set(notes.flatMap((note) => splitTags(note.tags)))).sort(), [notes])
  const filteredNotes = useMemo(() => {
    return notes.filter((note) => {
      const source = parseJson(note.source_id)
      const sourceType = getSourceString(source, 'sourceType') || note.source_type || 'manual'
      if (selectedOutlineId && note.outline_id !== selectedOutlineId) return false
      if (noteSourceFilter !== 'all') {
        if (noteSourceFilter === 'reader' && !['reader', 'manual'].includes(sourceType)) return false
        if (noteSourceFilter !== 'reader' && sourceType !== noteSourceFilter) return false
      }
      if (noteKindFilter !== 'all' && note.kind !== noteKindFilter) return false
      if (noteTagFilter !== 'all' && !splitTags(note.tags).includes(noteTagFilter)) return false
      return true
    })
  }, [noteKindFilter, noteSourceFilter, noteTagFilter, notes, selectedOutlineId])
  const projectNotes = useMemo(
    () => notes.filter((note) => note.project_id === selectedProjectId),
    [notes, selectedProjectId],
  )
  const projectEvidenceStats = useMemo(() => {
    const assigned = projectNotes.filter((note) => note.outline_id).length
    const reader = projectNotes.filter((note) => {
      const source = parseJson(note.source_id)
      const sourceType = getSourceString(source, 'sourceType') || note.source_type || 'manual'
      return sourceType === 'reader' || sourceType === 'manual'
    }).length
    const search = projectNotes.filter((note) => note.source_type === 'search').length
    const ai = projectNotes.filter((note) => note.source_type === 'ai').length
    const unavailable = projectNotes.filter((note) => note.source_available === 0).length
    return {
      assigned,
      unassigned: Math.max(0, projectNotes.length - assigned),
      reader,
      search,
      ai,
      unavailable,
    }
  }, [projectNotes])

  const previewMarkdown = useMemo(
    () => renderPreview(selectedProject, outline, projectNotes, references, citationByNoteId),
    [citationByNoteId, outline, projectNotes, references, selectedProject],
  )

  const loadProjects = async () => {
    const items = await window.api.listResearchProjects()
    setProjects(items)
    if (!selectedProjectId && items.length > 0) setSelectedProjectId(items[0].id)
  }

  const loadDashboard = async () => {
    setDashboard(await window.api.getResearchDashboard())
  }

  const loadProjectData = async (projectId: string, scope: NoteScope = noteScope) => {
    if (!projectId) {
      setOutline([])
      setNotes([])
      setDocuments([])
      setOutputs([])
      setReferences('')
      return
    }
    const citationStyleId = await resolveDefaultCitationStyleId()
    const [nextOutline, nextNotes, nextDocs, nextOutputs, nextReferences] = await Promise.all([
      window.api.listResearchOutline(projectId),
      window.api.listResearchNotes(scope === 'all' ? null : projectId),
      window.api.listResearchProjectDocuments(projectId),
      window.api.listResearchOutputs(projectId),
      window.api.exportResearchReferences(projectId, 'gbt7714', citationStyleId),
    ])
    setOutline(nextOutline)
    setNotes(nextNotes)
    setDocuments(nextDocs)
    setOutputs(nextOutputs)
    setReferences(nextReferences)
  }

  useEffect(() => {
    void loadProjects()
    void loadDashboard()
  }, [])

  useEffect(() => {
    void loadProjectData(selectedProjectId, noteScope)
  }, [selectedProjectId, noteScope])

  useEffect(() => {
    let active = true
    if (!projectNotes.length) {
      setCitationByNoteId({})
      return () => {
        active = false
      }
    }
    void resolveResearchNoteCitationMap(projectNotes)
      .then((nextCitations) => {
        if (active) setCitationByNoteId(nextCitations)
      })
      .catch((error) => {
        console.warn('Failed to prepare citation preview for research notes.', error)
      })
    return () => {
      active = false
    }
  }, [projectNotes])

  const refreshAll = async () => {
    await Promise.all([loadProjects(), loadDashboard(), loadProjectData(selectedProjectId, noteScope)])
  }

  const handleCreateProject = async () => {
    const values = await projectForm.validateFields()
    const project = await window.api.createResearchProject(values)
    setProjectModalOpen(false)
    projectForm.resetFields()
    await loadProjects()
    setSelectedProjectId(project.id)
    message.success('已创建研究专题')
  }

  const openOutlineModal = (item?: ResearchOutlineItem | null) => {
    setEditingOutline(item || null)
    outlineForm.setFieldsValue(item ? {
      title: item.title,
      description: item.description,
      parent_id: item.parent_id || undefined,
      sort_order: item.sort_order,
    } : {
      title: '',
      description: '',
      parent_id: selectedOutlineId || undefined,
      sort_order: outline.length ? Math.max(...outline.map((node) => node.sort_order || 0)) + 10 : 10,
    })
    setOutlineModalOpen(true)
  }

  const handleSaveOutline = async () => {
    if (!selectedProjectId) return
    const values = await outlineForm.validateFields()
    if (editingOutline) {
      await window.api.updateResearchOutlineItem(editingOutline.id, values)
      message.success('已更新大纲')
    } else {
      await window.api.createResearchOutlineItem({ ...values, project_id: selectedProjectId })
      message.success('已添加大纲节点')
    }
    setOutlineModalOpen(false)
    setEditingOutline(null)
    await refreshAll()
  }

  const handleDeleteOutline = async (id: string) => {
    await window.api.deleteResearchOutlineItem(id)
    if (selectedOutlineId === id) setSelectedOutlineId(null)
    await refreshAll()
    message.success('已删除大纲节点，相关摘录已移到未归类')
  }

  const openAddDocs = async () => {
    const docs = await window.api.listDocuments({ limit: 1000 })
    setAvailableDocs(docs)
    setSelectedDocIds([])
    setAddDocsModalOpen(true)
  }

  const handleAddDocs = async () => {
    if (!selectedProjectId || selectedDocIds.length === 0) return
    await window.api.addResearchProjectDocuments(selectedProjectId, selectedDocIds)
    setAddDocsModalOpen(false)
    await refreshAll()
    message.success('已加入专题')
  }

  const openEditNote = (note: ResearchNote) => {
    setEditingNote(note)
    noteForm.setFieldsValue({
      kind: note.kind || 'quote',
      outline_id: note.outline_id || undefined,
      note: note.note,
      tags: note.tags,
      color: note.color,
      citation_text: citationByNoteId[note.id] || note.citation_text || buildNoteCitation(note),
    })
    setNoteModalOpen(true)
  }

  const handleSaveNote = async () => {
    if (!editingNote) return
    const values = await noteForm.validateFields()
    await window.api.updateResearchNote(editingNote.id, {
      ...values,
      outline_id: values.outline_id || null,
    })
    setNoteModalOpen(false)
    setEditingNote(null)
    await refreshAll()
    message.success('已更新摘录')
  }

  const handleDeleteNote = async (id: string) => {
    await window.api.deleteResearchNote(id)
    await refreshAll()
    message.success('已删除摘录')
  }

  const handleSynthesize = async () => {
    if (!selectedProjectId) return
    if (templateType === 'custom' && !customPrompt.trim()) {
      message.info('请输入自定义分析要求')
      return
    }
    setSynthesizing(true)
    try {
      const citationStyleId = await resolveDefaultCitationStyleId()
      await window.api.synthesizeResearchProject(
        selectedProjectId,
        templateType,
        templateType === 'custom' ? customPrompt.trim() : undefined,
        citationStyleId,
      )
      await loadProjectData(selectedProjectId, noteScope)
      message.success('已生成带来源的研究分析')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '生成失败'))
    } finally {
      setSynthesizing(false)
    }
  }

  const handleExportReferences = async (format: ResearchReferenceExportFormat) => {
    if (!selectedProjectId) return
    const citationStyleId = await resolveDefaultCitationStyleId()
    const text = await window.api.exportResearchReferences(selectedProjectId, format, citationStyleId)
    if (!text.trim()) {
      message.info('当前专题还没有可导出的参考文献')
      return
    }
    await navigator.clipboard.writeText(text)
    message.success(`已复制 ${format.toUpperCase()} 参考文献`)
  }

  const handleExportProject = async (format: 'markdown' | 'json') => {
    if (!selectedProjectId) return
    const citationStyleId = await resolveDefaultCitationStyleId()
    const payload = await window.api.exportResearchProject(selectedProjectId, { format, includeReferences: true, citationStyleId })
    await navigator.clipboard.writeText(payload.content)
    message.success(`已复制专题 ${format === 'markdown' ? 'Markdown' : 'JSON'}，包含 ${payload.noteCount} 条摘录`)
  }

  const openNoteSource = (note: ResearchNote) => {
    const legacySource = parseJson(note.source_id)
    const locator = asSearchHitLocator(parseJson(note.locator_json)) || asSearchHitLocator(legacySource?.['locator'])
    const legacyPageNum = getSourceNumber(legacySource, 'pageNum')
    const sourceKeyword = getSourceString(legacySource, 'searchKeyword') || getSourceString(legacySource, 'matchedQuery')
    const highlightText = getNoteHighlightText(note, locator, legacySource)
    const keyword = highlightText || normalizeHighlightCandidate(sourceKeyword || locator?.queryTerm || note.excerpt, 120)
    const highlightColor = normalizeHighlightColor(note.color || DEFAULT_HIGHLIGHT_COLOR)
    onOpenDocument?.({
      docId: note.doc_id,
      pageIndex: locator?.pageIndex ?? (legacyPageNum ? legacyPageNum - 1 : note.page_num ? note.page_num - 1 : 0),
      keyword,
      excerpt: note.excerpt,
      highlightExcerpt: keyword,
      highlightColor,
      sourceLabel: getKindLabel(note.kind),
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
  }

  const copyNoteMarkdown = async (note: ResearchNote) => {
    await navigator.clipboard.writeText(await buildResearchNoteMarkdown(note, {
      kindLabel: getKindMeta(note.kind).label,
      sourceLabel: getNoteSourceLabel(note),
      sourceState: note.source_available ? '' : '\n> 原文待恢复',
    }))
    message.success('已复制 Markdown')
  }

  return (
    <div className="research-workbench">
      <div className="research-header">
        <div>
          <Title level={3} style={{ color: 'var(--gs-gold)', margin: 0 }}>研究工作台</Title>
          <Text type="secondary">把摘录整理成专题证据、论点结构和可导出的写作草稿。</Text>
        </div>
        <Space wrap>
          <Button icon={<ExportOutlined />} disabled={!selectedProjectId} onClick={() => void handleExportProject('markdown')}>
            复制 Markdown
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setProjectModalOpen(true)}>
            新建专题
          </Button>
        </Space>
      </div>

      {dashboard ? (
        <div className="research-metrics">
          <Card size="small"><Statistic title="研究专题" value={dashboard.projectCount} /></Card>
          <Card size="small"><Statistic title="研究摘录" value={dashboard.noteCount} /></Card>
          <Card size="small"><Statistic title="AI 可分析文献" value={dashboard.aiReadyCount} /></Card>
          <Card size="small"><Statistic title="引用信息待补" value={dashboard.citationMissingCount} /></Card>
        </div>
      ) : null}

      {selectedProject ? (
        <div className="research-focus-strip">
          <div className="research-focus-item">
            <span>证据入纲</span>
            <strong>{projectEvidenceStats.assigned}/{projectNotes.length}</strong>
          </div>
          <div className="research-focus-item">
            <span>未归入大纲</span>
            <strong>{projectEvidenceStats.unassigned}</strong>
          </div>
          <div className="research-focus-item">
            <span>待补原文</span>
            <strong>{projectEvidenceStats.unavailable}</strong>
          </div>
          <div className="research-focus-item">
            <span>来源构成</span>
            <strong>{projectEvidenceStats.reader} 阅 / {projectEvidenceStats.search} 检 / {projectEvidenceStats.ai} AI</strong>
          </div>
        </div>
      ) : null}

      <div className="research-grid">
        <Card size="small" title="专题与大纲" className="research-panel">
          {projects.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无专题" />
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select
                value={selectedProjectId || undefined}
                onChange={(value) => {
                  setSelectedProjectId(value)
                  setSelectedOutlineId(null)
                }}
                style={{ width: '100%' }}
                options={projects.map((project) => ({
                  value: project.id,
                  label: `${project.name} · ${project.note_count || 0} 条摘录`,
                }))}
              />
              {selectedProject ? (
                <div className="research-project-card">
                  <Text strong>{selectedProject.name}</Text>
                  <Text type="secondary">{selectedProject.description || '这个专题还没有说明。'}</Text>
                  <Space wrap>
                    <Tag>{selectedProject.document_count || 0} 篇文献</Tag>
                    <Tag>{selectedProject.note_count || 0} 条摘录</Tag>
                  </Space>
                </div>
              ) : null}
            </Space>
          )}

          <div className="research-panel-toolbar">
            <Text strong>写作大纲</Text>
            <Space>
              <Button size="small" icon={<PlusOutlined />} disabled={!selectedProjectId} onClick={() => openOutlineModal()}>
                添加
              </Button>
              <Button size="small" onClick={() => setSelectedOutlineId(null)}>全部</Button>
            </Space>
          </div>
          {outline.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有大纲节点" />
          ) : (
            <div className="research-outline-list">
              {outline.map((item) => {
                const active = selectedOutlineId === item.id
                const depth = outlineDepth(item, outlineById)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`research-outline-item ${active ? 'active' : ''}`}
                    style={{ paddingLeft: 12 + depth * 18 }}
                    onClick={() => setSelectedOutlineId(active ? null : item.id)}
                  >
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.note_count || 0} 条摘录</small>
                    </span>
                    <Space size={4}>
                      <Tooltip title="编辑">
                        <EditOutlined onClick={(event) => { event.stopPropagation(); openOutlineModal(item) }} />
                      </Tooltip>
                      <Tooltip title="删除">
                        <DeleteOutlined onClick={(event) => { event.stopPropagation(); void handleDeleteOutline(item.id) }} />
                      </Tooltip>
                    </Space>
                  </button>
                )
              })}
            </div>
          )}
        </Card>

        <Card
          size="small"
          title="专题证据"
          extra={<Text type="secondary">{filteredNotes.length}/{notes.length}</Text>}
          className="research-panel"
        >
          <Space wrap className="research-filter-row">
            <Select value={noteScope} onChange={setNoteScope} style={{ width: 116 }} options={[{ value: 'current', label: '当前专题' }, { value: 'all', label: '素材池' }]} />
            <Select value={noteKindFilter} onChange={setNoteKindFilter} style={{ width: 112 }} options={[{ value: 'all', label: '全部类型' }, ...KNOWLEDGE_KIND_OPTIONS.map(({ value, label }) => ({ value, label }))]} />
            <Select value={noteSourceFilter} onChange={setNoteSourceFilter} style={{ width: 112 }} options={[{ value: 'all', label: '全部来源' }, { value: 'reader', label: '阅读器' }, { value: 'search', label: '检索' }, { value: 'ai', label: 'AI' }]} />
            <Select value={noteTagFilter} onChange={setNoteTagFilter} style={{ width: 130 }} options={[{ value: 'all', label: '全部标签' }, ...noteTags.map((tag) => ({ value: tag, label: tag }))]} />
          </Space>

          {filteredNotes.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有符合条件的摘录" />
          ) : (
            <List
              dataSource={filteredNotes}
              renderItem={(note) => {
                const kind = getKindMeta(note.kind)
                return (
                  <List.Item
                    className="research-note-item"
                    actions={[
                      <Button key="open" type="link" size="small" onClick={() => openNoteSource(note)}>原文</Button>,
                      <Button key="edit" type="text" size="small" icon={<EditOutlined />} onClick={() => openEditNote(note)} />,
                      <Button key="markdown" type="text" size="small" icon={<CopyOutlined />} onClick={() => void copyNoteMarkdown(note)} />,
                      <Button key="delete" type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => void handleDeleteNote(note.id)} />,
                    ]}
                  >
                    <List.Item.Meta
                      title={(
                        <Space wrap size={6}>
                          <Text strong>{note.doc_title || 'Untitled'}</Text>
                          <Tag color={kind.color}>{kind.label}</Tag>
                          <Tag color={note.source_type === 'search' ? 'gold' : note.source_type === 'ai' ? 'purple' : 'blue'}>{getNoteSourceLabel(note)}</Tag>
                          {note.page_num ? <Tag color="blue">第 {note.page_num} 页</Tag> : null}
                          {!note.source_available ? <Tag color="orange">原文待恢复</Tag> : null}
                          {note.outline_id ? <Tag>{outlineById.get(note.outline_id)?.title || '大纲'}</Tag> : null}
                        </Space>
                      )}
                      description={(
                        <div>
                          <Paragraph className="research-note-excerpt">{note.excerpt}</Paragraph>
                          {note.note ? <Text type="secondary">{note.note}</Text> : null}
                          <div className="research-note-tags">
                            {splitTags(note.tags).map((tag) => <Tag key={tag}>{tag}</Tag>)}
                          </div>
                        </div>
                      )}
                    />
                  </List.Item>
                )
              }}
            />
          )}
        </Card>

        <div className="research-side-stack">
          <Card size="small" title="专题文献" extra={selectedProject ? <Button size="small" icon={<BookOutlined />} onClick={openAddDocs}>加入文献</Button> : null}>
            {documents.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有加入文献" />
            ) : (
              <Space wrap>
                {documents.map((doc) => (
                  <Tag key={doc.id} color="blue" style={{ cursor: 'pointer' }} onClick={() => onOpenDocument?.({ docId: doc.id })}>
                    {doc.title || '未命名文献'}
                  </Tag>
                ))}
              </Space>
            )}
          </Card>

          <Card size="small" title={<Space><ReadOutlined />写作预览</Space>} extra={<Button size="small" icon={<CopyOutlined />} disabled={!previewMarkdown} onClick={() => navigator.clipboard.writeText(previewMarkdown).then(() => message.success('已复制写作预览'))}>复制</Button>}>
            {previewMarkdown ? (
              <pre className="research-writing-preview">{previewMarkdown}</pre>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择专题并保存摘录后生成预览" />
            )}
          </Card>

          <Card size="small" title={<Space><RobotOutlined />带来源综述</Space>}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select value={templateType} options={ANALYSIS_TEMPLATES} onChange={setTemplateType} />
              {templateType === 'custom' ? (
                <TextArea rows={4} placeholder="输入研究分析要求" value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} />
              ) : null}
              <Button type="primary" icon={<FileSearchOutlined />} loading={synthesizing} disabled={!selectedProjectId} onClick={() => void handleSynthesize()} block>
                生成专题分析
              </Button>
            </Space>
          </Card>

          <Card size="small" title="参考文献">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button icon={<CopyOutlined />} onClick={() => void handleExportReferences('gbt7714')} block>复制 GB/T 7714</Button>
              <Button icon={<CopyOutlined />} onClick={() => void handleExportReferences('bibtex')} block>复制 BibTeX</Button>
              <Button icon={<CopyOutlined />} onClick={() => void handleExportReferences('ris')} block>复制 RIS</Button>
              <Button icon={<ExportOutlined />} onClick={() => void handleExportProject('json')} block>复制 JSON</Button>
            </Space>
          </Card>

          <Card size="small" title="AI 产出">
            {outputs.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无专题分析" />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }}>
                {outputs.map((output) => (
                  <Card key={output.id} size="small" type="inner" title={output.title}>
                    <Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{output.content}</Paragraph>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText(output.content)}>复制</Button>
                  </Card>
                ))}
              </Space>
            )}
          </Card>
        </div>
      </div>

      <Modal title="新建研究专题" open={projectModalOpen} onCancel={() => setProjectModalOpen(false)} onOk={() => void handleCreateProject()} okText="创建" cancelText="取消">
        <Form form={projectForm} layout="vertical">
          <Form.Item name="name" label="专题名称" rules={[{ required: true, message: '请输入专题名称' }]}>
            <Input placeholder="例如：明清地方志与区域社会" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <TextArea rows={3} placeholder="这个专题关注的问题、材料范围或写作目标" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={editingOutline ? '编辑大纲节点' : '添加大纲节点'} open={outlineModalOpen} onCancel={() => setOutlineModalOpen(false)} onOk={() => void handleSaveOutline()} okText="保存" cancelText="取消">
        <Form form={outlineForm} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="例如：材料来源与版本差异" />
          </Form.Item>
          <Form.Item name="parent_id" label="上级节点">
            <Select allowClear options={outlineOptions.filter((item) => item.value !== editingOutline?.id)} />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item name="sort_order" label="排序">
            <Input type="number" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="编辑摘录" open={noteModalOpen} onCancel={() => setNoteModalOpen(false)} onOk={() => void handleSaveNote()} okText="保存" cancelText="取消">
        <Form form={noteForm} layout="vertical">
          <Form.Item name="kind" label="类型">
            <Select options={KNOWLEDGE_KIND_OPTIONS.map(({ value, label }) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="outline_id" label="归入大纲">
            <Select allowClear options={outlineOptions} />
          </Form.Item>
          <Form.Item name="citation_text" label="引用文本">
            <Input />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Input placeholder="多个标签用逗号分隔" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="加入文献到专题" open={addDocsModalOpen} onCancel={() => setAddDocsModalOpen(false)} onOk={() => void handleAddDocs()} okText="加入" cancelText="取消">
        <Select
          mode="multiple"
          showSearch
          style={{ width: '100%' }}
          placeholder="选择文献"
          value={selectedDocIds}
          onChange={setSelectedDocIds}
          optionFilterProp="label"
          options={availableDocs.map((doc) => ({ value: doc.id, label: doc.title || '未命名文献' }))}
          maxTagCount="responsive"
        />
      </Modal>
    </div>
  )
}
