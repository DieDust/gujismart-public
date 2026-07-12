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
  Tabs,
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
  AiResearchDataset,
  AiResearchRecord,
  AiSynthesisTemplate,
  Document,
  DocumentListItem,
  LibraryAiOpenPayload,
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
import { legacySearchLocatorFromUnknown } from '@shared/stable-reader-locator'
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
  onOpenLibraryAi?: (payload?: string | LibraryAiOpenPayload) => void
  onActiveProjectChange?: (projectId: string | null) => void
}

type NoteScope = 'current' | 'all'
type ResearchTabKey = 'overview' | 'evidence' | 'outline' | 'ai' | 'writing'
type JsonRecord = Record<string, unknown>
const AI_RECORD_PREVIEW_LIMIT = 20
const AI_OUTPUT_PREVIEW_LIMIT = 5

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

function cleanResearchPreviewText(value: string, maxLength = 240): string {
  const normalized = value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b[a-z-]+\s*:\s*[^;。；]{1,80};/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function getSourceNumber(source: JsonRecord | null | undefined, key: string): number | undefined {
  const value = source?.[key]
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function asSearchHitLocator(value: unknown): SearchHitLocator | undefined {
  return legacySearchLocatorFromUnknown(value) || undefined
}

function getResearchWorkspaceUpdatedProjectId(event: Event): string | null {
  if (!(event instanceof CustomEvent) || !isRecord(event.detail)) return null
  const projectId = event.detail.projectId
  return typeof projectId === 'string' ? projectId : null
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
  if (type === 'ai_research') return 'AI研究'
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

export default function ResearchView({ onOpenDocument, onOpenLibraryAi, onActiveProjectChange }: ResearchViewProps) {
  const [projects, setProjects] = useState<ResearchProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [outline, setOutline] = useState<ResearchOutlineItem[]>([])
  const [selectedOutlineId, setSelectedOutlineId] = useState<string | null>(null)
  const [notes, setNotes] = useState<ResearchNote[]>([])
  const [documents, setDocuments] = useState<Document[]>([])
  const [outputs, setOutputs] = useState<ResearchOutput[]>([])
  const [aiDatasets, setAiDatasets] = useState<AiResearchDataset[]>([])
  const [selectedDatasetId, setSelectedDatasetId] = useState('')
  const [aiRecords, setAiRecords] = useState<AiResearchRecord[]>([])
  const [aiReportLoading, setAiReportLoading] = useState(false)
  const [activeTabKey, setActiveTabKey] = useState<ResearchTabKey>('overview')
  const [loadedProjectData, setLoadedProjectData] = useState<{
    evidenceProjectId: string
    evidenceScope: NoteScope
    documentsProjectId: string
    aiDatasetsProjectId: string
    aiOutputsProjectId: string
  }>({
    evidenceProjectId: '',
    evidenceScope: 'current',
    documentsProjectId: '',
    aiDatasetsProjectId: '',
    aiOutputsProjectId: '',
  })
  const [aiResultMode, setAiResultMode] = useState<'summary' | 'datasets' | 'reports'>('summary')
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
  const [referencesLoadedProjectId, setReferencesLoadedProjectId] = useState('')
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
        if (noteSourceFilter === 'reader') {
          if (!['reader', 'manual'].includes(sourceType)) return false
        } else if (noteSourceFilter === 'ai') {
          if (!['ai', 'ai_research'].includes(sourceType)) return false
        } else if (sourceType !== noteSourceFilter) {
          return false
        }
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
    if (projectNotes.length === 0) {
      return {
        assigned: 0,
        unassigned: selectedProject?.note_count || 0,
        reader: 0,
        search: 0,
        ai: 0,
        unavailable: 0,
      }
    }
    const assigned = projectNotes.filter((note) => note.outline_id).length
    const reader = projectNotes.filter((note) => {
      const source = parseJson(note.source_id)
      const sourceType = getSourceString(source, 'sourceType') || note.source_type || 'manual'
      return sourceType === 'reader' || sourceType === 'manual'
    }).length
    const search = projectNotes.filter((note) => note.source_type === 'search').length
    const ai = projectNotes.filter((note) => note.source_type === 'ai' || note.source_type === 'ai_research').length
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
    () => activeTabKey === 'writing' ? renderPreview(selectedProject, outline, projectNotes, references, citationByNoteId) : '',
    [activeTabKey, citationByNoteId, outline, projectNotes, references, selectedProject],
  )
  const selectedDataset = useMemo(
    () => aiDatasets.find((dataset) => dataset.id === selectedDatasetId) || null,
    [aiDatasets, selectedDatasetId],
  )
  const selectedDatasetRecordCount = Number(selectedDataset?.record_count || 0)
  const visibleOutputs = useMemo(() => outputs.slice(0, AI_OUTPUT_PREVIEW_LIMIT), [outputs])
  const selectedProjectDocumentCount = Number(selectedProject?.document_count || 0)
  const selectedProjectNoteCount = Number(selectedProject?.note_count || 0)
  const selectedProjectOutputCount = Number(selectedProject?.output_count || 0)
  const selectedProjectAiDatasetCount = Number(selectedProject?.ai_dataset_count || 0)
  const selectedProjectOutlineCount = Number(selectedProject?.outline_count || outline.length || 0)

  const loadProjects = async () => {
    const items = await window.api.listResearchProjects()
    setProjects(items)
    if (!selectedProjectId && items.length > 0) setSelectedProjectId(items[0].id)
  }

  const loadDashboard = async () => {
    setDashboard(await window.api.getResearchDashboard())
  }

  const resetProjectScopedData = () => {
    setNotes([])
    setDocuments([])
    setOutputs([])
    setAiDatasets([])
    setAiRecords([])
    setSelectedDatasetId('')
    setReferences('')
    setReferencesLoadedProjectId('')
    setCitationByNoteId({})
    setLoadedProjectData({
      evidenceProjectId: '',
      evidenceScope: 'current',
      documentsProjectId: '',
      aiDatasetsProjectId: '',
      aiOutputsProjectId: '',
    })
    setAiResultMode('summary')
  }

  const loadProjectData = async (projectId: string) => {
    if (!projectId) {
      setOutline([])
      resetProjectScopedData()
      return
    }
    const nextOutline = await window.api.listResearchOutline(projectId)
    setOutline(nextOutline)
    resetProjectScopedData()
  }

  const loadDocumentsData = async (projectId: string) => {
    if (!projectId || loadedProjectData.documentsProjectId === projectId) return
    const nextDocs = await window.api.listResearchProjectDocuments(projectId)
    setDocuments(nextDocs)
    setLoadedProjectData((state) => ({ ...state, documentsProjectId: projectId }))
  }

  const loadEvidenceData = async (projectId: string, scope: NoteScope = noteScope) => {
    if (!projectId) return
    if (loadedProjectData.evidenceProjectId === projectId && loadedProjectData.evidenceScope === scope) return
    const nextNotes = await window.api.listResearchNotes(scope === 'all' ? null : projectId)
    setNotes(nextNotes)
    setLoadedProjectData((state) => ({ ...state, evidenceProjectId: projectId, evidenceScope: scope }))
  }

  const loadAiDatasetsData = async (projectId: string) => {
    if (!projectId || loadedProjectData.aiDatasetsProjectId === projectId) return
    const nextDatasets = await window.api.listAiResearchDatasets(projectId)
    setAiDatasets(nextDatasets)
    const nextDatasetId = selectedDatasetId && nextDatasets.some((dataset) => dataset.id === selectedDatasetId)
      ? selectedDatasetId
      : nextDatasets[0]?.id || ''
    setSelectedDatasetId(nextDatasetId)
    setAiRecords(nextDatasetId ? await window.api.listAiResearchRecords(nextDatasetId, { limit: AI_RECORD_PREVIEW_LIMIT }) : [])
    setLoadedProjectData((state) => ({ ...state, aiDatasetsProjectId: projectId }))
  }

  const loadAiOutputsData = async (projectId: string) => {
    if (!projectId || loadedProjectData.aiOutputsProjectId === projectId) return
    const nextOutputs = await window.api.listResearchOutputs(projectId)
    setOutputs(nextOutputs)
    setLoadedProjectData((state) => ({ ...state, aiOutputsProjectId: projectId }))
  }

  const openAiDatasetsMode = (force = false) => {
    setAiResultMode('datasets')
    if (selectedProjectId && (force || loadedProjectData.aiDatasetsProjectId !== selectedProjectId)) {
      setAiDatasets([])
      setAiRecords([])
      setSelectedDatasetId('')
      void loadAiDatasetsData(selectedProjectId)
    }
  }

  const openAiReportsMode = (force = false) => {
    setAiResultMode('reports')
    if (selectedProjectId && (force || loadedProjectData.aiOutputsProjectId !== selectedProjectId)) {
      setOutputs([])
      void loadAiOutputsData(selectedProjectId)
    }
  }

  useEffect(() => {
    void loadProjects()
    void loadDashboard()
  }, [])

  useEffect(() => {
    void loadProjectData(selectedProjectId)
  }, [selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId) return
    if (activeTabKey === 'overview') return
    if (activeTabKey === 'evidence') {
      void loadDocumentsData(selectedProjectId)
      void loadEvidenceData(selectedProjectId, noteScope)
    }
    if (activeTabKey === 'outline') {
      void loadEvidenceData(selectedProjectId, 'current')
    }
    if (activeTabKey === 'writing') {
      void loadEvidenceData(selectedProjectId, 'current')
    }
  }, [activeTabKey, selectedProjectId, noteScope])

  const loadWritingReferences = async () => {
    if (!selectedProjectId || referencesLoadedProjectId === selectedProjectId) return
    const citationStyleId = await resolveDefaultCitationStyleId()
    const nextReferences = await window.api.exportResearchReferences(selectedProjectId, 'gbt7714', citationStyleId)
    setReferences(nextReferences)
    setReferencesLoadedProjectId(selectedProjectId)
  }

  useEffect(() => {
    if (activeTabKey === 'writing') void loadWritingReferences()
  }, [activeTabKey, selectedProjectId])

  useEffect(() => {
    onActiveProjectChange?.(selectedProjectId || null)
    return () => onActiveProjectChange?.(null)
  }, [onActiveProjectChange, selectedProjectId])

  useEffect(() => {
    const handleResearchWorkspaceUpdated = (event: Event) => {
      const projectId = getResearchWorkspaceUpdatedProjectId(event)
      if (!projectId || projectId !== selectedProjectId) return
      void loadProjects()
      if (activeTabKey === 'ai') {
        if (aiResultMode === 'datasets') {
          openAiDatasetsMode(true)
        }
        if (aiResultMode === 'reports') {
          openAiReportsMode(true)
        }
      }
      if (activeTabKey === 'evidence') {
        setLoadedProjectData((state) => ({ ...state, evidenceProjectId: '', documentsProjectId: '' }))
        void loadDocumentsData(selectedProjectId)
        void loadEvidenceData(selectedProjectId, noteScope)
      }
    }
    window.addEventListener('gujismart:research-workspace-updated', handleResearchWorkspaceUpdated)
    return () => window.removeEventListener('gujismart:research-workspace-updated', handleResearchWorkspaceUpdated)
  }, [activeTabKey, aiResultMode, selectedProjectId, noteScope])

  useEffect(() => {
    let active = true
    if (activeTabKey !== 'writing' || !projectNotes.length) {
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
  }, [activeTabKey, projectNotes])

  const refreshAll = async () => {
    await Promise.all([loadProjects(), loadDashboard()])
    if (!selectedProjectId) return
    if (activeTabKey === 'evidence') {
      setLoadedProjectData((state) => ({ ...state, evidenceProjectId: '', documentsProjectId: '' }))
      await Promise.all([loadDocumentsData(selectedProjectId), loadEvidenceData(selectedProjectId, noteScope)])
    } else if (activeTabKey === 'outline') {
      await loadProjectData(selectedProjectId)
      setLoadedProjectData((state) => ({ ...state, evidenceProjectId: '' }))
      await loadEvidenceData(selectedProjectId, 'current')
    } else if (activeTabKey === 'ai') {
      if (aiResultMode === 'datasets') {
        setLoadedProjectData((state) => ({ ...state, aiDatasetsProjectId: '' }))
        await loadAiDatasetsData(selectedProjectId)
      }
      if (aiResultMode === 'reports') {
        setLoadedProjectData((state) => ({ ...state, aiOutputsProjectId: '' }))
        await loadAiOutputsData(selectedProjectId)
      }
    } else if (activeTabKey === 'writing') {
      setLoadedProjectData((state) => ({ ...state, evidenceProjectId: '' }))
      await loadEvidenceData(selectedProjectId, 'current')
    } else {
      await loadProjectData(selectedProjectId)
    }
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
      openAiReportsMode(true)
      message.success('已生成带来源的研究分析')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '生成失败'))
    } finally {
      setSynthesizing(false)
    }
  }

  const openCurrentProjectAi = async (initialTab: 'qa' | 'analysis' | 'research' = 'research') => {
    if (!onOpenLibraryAi || !selectedProjectId) return
    const projectDocs = loadedProjectData.documentsProjectId === selectedProjectId
      ? documents
      : await window.api.listResearchProjectDocuments(selectedProjectId)
    if (loadedProjectData.documentsProjectId !== selectedProjectId) {
      setDocuments(projectDocs)
      setLoadedProjectData((state) => ({ ...state, documentsProjectId: selectedProjectId }))
    }
    const docIds = projectDocs.map((doc) => doc.id).filter(Boolean)
    onOpenLibraryAi({
      initialTab,
      researchProjectId: selectedProjectId,
      scope: { type: 'documents', docIds },
      scopeLabel: selectedProject ? `研究专题 / ${selectedProject.name}` : '当前研究专题',
    })
  }

  const loadAiRecords = async (datasetId: string) => {
    setSelectedDatasetId(datasetId)
    setAiRecords(datasetId ? await window.api.listAiResearchRecords(datasetId, { limit: AI_RECORD_PREVIEW_LIMIT }) : [])
  }

  const handleExcludeAiRecord = async (recordId: string) => {
    await window.api.excludeAiResearchRecord(recordId)
    if (selectedDatasetId) setAiRecords(await window.api.listAiResearchRecords(selectedDatasetId, { limit: AI_RECORD_PREVIEW_LIMIT }))
    message.success('已从数据集中排除这条记录')
  }

  const handleSaveAiRecordAsNote = async (record: AiResearchRecord) => {
    if (!selectedProjectId) return
    const sourcePayload = {
      sourceType: 'ai_research',
      datasetId: record.dataset_id,
      recordId: record.id,
      values: record.values || {},
    }
    const saved = await window.api.createResearchNote({
      project_id: selectedProjectId,
      doc_id: record.doc_id,
      page_num: record.page_num,
      excerpt: record.excerpt,
      note: record.note || '来自 AI 研究数据集',
      tags: 'AI研究',
      source_type: 'ai_research',
      source_id: JSON.stringify(sourcePayload),
      kind: 'quote',
      locator_json: record.locator_json,
      source_hash: record.source_hash,
    })
    await refreshAll()
    message.success(`已保存为研究摘录：${saved.doc_title || '原文'}`)
  }

  const handleGenerateDatasetReport = async () => {
    if (!selectedDatasetId) return
    setAiReportLoading(true)
    try {
      await window.api.generateAiResearchReport({
        datasetId: selectedDatasetId,
        templateType: templateType === 'custom' ? 'custom' : templateType,
        customPrompt: templateType === 'custom' ? customPrompt : undefined,
      })
      openAiReportsMode(true)
      message.success('已根据数据集生成报告')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '生成数据集报告失败'))
    } finally {
      setAiReportLoading(false)
    }
  }

  const handleCopyDataset = async (format: 'markdown' | 'csv' | 'json') => {
    if (!selectedDatasetId) return
    const result = await window.api.exportAiResearchDataset(selectedDatasetId, format)
    await navigator.clipboard.writeText(result.content)
    message.success(`已复制 ${result.recordCount} 条数据记录`)
  }

  const handleCopyResearchOutput = async (output: ResearchOutput) => {
    const content = await window.api.getResearchOutputContent(output.id)
    await navigator.clipboard.writeText(content || output.content)
    message.success('已复制完整报告')
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
    <div className="research-workbench gs-view-container">
      <div className="research-header">
        <div>
          <Title level={3} className="gs-view-title">研究工作台</Title>
          <Text type="secondary">把摘录整理成专题证据、论点结构和可导出的写作草稿。</Text>
        </div>
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setProjectModalOpen(true)}>
            新建专题
          </Button>
        </Space>
      </div>

      <Card className="research-overview-card" size="small">
        <div className="research-overview">
          <div className="research-overview-main">
            <Text type="secondary">当前专题</Text>
            {projects.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无专题" />
            ) : (
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
            )}
            {selectedProject ? (
              <div className="research-project-summary">
                <Text strong>{selectedProject.name}</Text>
                <Text type="secondary">{selectedProject.description || '这个专题还没有说明。'}</Text>
                <Space wrap>
                  <Tag>{selectedProjectDocumentCount} 篇文献</Tag>
                  <Tag>{selectedProjectNoteCount} 条摘录</Tag>
                  <Tag>{selectedProjectOutlineCount} 个大纲</Tag>
                  <Tag>{selectedProjectAiDatasetCount} 个提取结果</Tag>
                </Space>
              </div>
            ) : null}
          </div>
          <div className="research-next-actions">
            <Tooltip title={selectedProjectId && selectedProjectDocumentCount === 0 ? '先给当前专题加入文献，再进行 AI 分析' : ''}>
              <span>
                <Button type="primary" icon={<RobotOutlined />} disabled={!selectedProjectId || !onOpenLibraryAi || selectedProjectDocumentCount === 0} onClick={() => void openCurrentProjectAi('research')}>
                  AI 分析当前专题
                </Button>
              </span>
            </Tooltip>
            <Button icon={<BookOutlined />} disabled={!selectedProjectId} onClick={openAddDocs}>
              加入文献
            </Button>
            <Button icon={<PlusOutlined />} disabled={!selectedProjectId} onClick={() => openOutlineModal()}>
              添加大纲
            </Button>
            <Button icon={<ExportOutlined />} disabled={!selectedProjectId} onClick={() => void handleExportProject('markdown')}>
              导出草稿
            </Button>
          </div>
        </div>

        {selectedProject ? (
          <div className="research-focus-strip compact">
            <div className="research-focus-item">
              <span>专题文献</span>
              <strong>{selectedProjectDocumentCount}</strong>
            </div>
            <div className="research-focus-item">
              <span>研究摘录</span>
              <strong>{selectedProjectNoteCount}</strong>
            </div>
            <div className="research-focus-item">
              <span>大纲节点</span>
              <strong>{selectedProjectOutlineCount}</strong>
            </div>
            <div className="research-focus-item">
              <span>AI 结果</span>
              <strong>{selectedProjectAiDatasetCount + selectedProjectOutputCount}</strong>
            </div>
          </div>
        ) : null}

        {dashboard ? (
          <div className="research-metrics compact">
            <Statistic title="研究专题" value={dashboard.projectCount} />
            <Statistic title="研究摘录" value={dashboard.noteCount} />
            <Statistic title="AI 可分析文献" value={dashboard.aiReadyCount} />
            <Statistic title="引用信息待补" value={dashboard.citationMissingCount} />
          </div>
        ) : null}
      </Card>

      <Tabs
        className="research-workbench-tabs"
        activeKey={activeTabKey}
        onChange={(key) => {
          const nextKey = key as ResearchTabKey
          setActiveTabKey(nextKey)
          if (nextKey === 'ai') setAiResultMode('summary')
        }}
        items={[
          {
            key: 'overview',
            label: '专题概览',
            children: (
              <div className="research-home-grid">
                <Card size="small" title="这个页面是用来做什么的" className="research-panel">
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Text>研究工作台用来把一个专题下的文献、摘录、AI 提取结果和写作草稿放在一起管理。</Text>
                    <Text type="secondary">建议流程：先加入文献，再用检索或阅读保存摘录，随后让 AI 做数据提取或报告，最后进入写作导出。</Text>
                  </Space>
                </Card>
                <Card size="small" title="下一步" className="research-panel">
                  <div className="research-home-actions">
                    <Button icon={<BookOutlined />} disabled={!selectedProjectId} onClick={openAddDocs}>加入专题文献</Button>
                    <Button icon={<ReadOutlined />} disabled={!selectedProjectId} onClick={() => setActiveTabKey('evidence')}>查看证据摘录</Button>
                    <Button icon={<RobotOutlined />} disabled={!selectedProjectId} onClick={() => setActiveTabKey('ai')}>查看研究结果</Button>
                    <Button icon={<ExportOutlined />} disabled={!selectedProjectId || selectedProjectNoteCount === 0} onClick={() => setActiveTabKey('writing')}>整理写作草稿</Button>
                  </div>
                </Card>
                <Card size="small" title="当前专题状态" className="research-panel">
                  <div className="research-focus-strip single-column">
                    <div className="research-focus-item">
                      <span>专题文献</span>
                      <strong>{selectedProjectDocumentCount}</strong>
                    </div>
                    <div className="research-focus-item">
                      <span>证据摘录</span>
                      <strong>{selectedProjectNoteCount}</strong>
                    </div>
                    <div className="research-focus-item">
                      <span>大纲节点</span>
                      <strong>{selectedProjectOutlineCount}</strong>
                    </div>
                    <div className="research-focus-item">
                      <span>AI 提取/报告</span>
                      <strong>{selectedProjectAiDatasetCount + selectedProjectOutputCount}</strong>
                    </div>
                  </div>
                </Card>
              </div>
            ),
          },
          {
            key: 'evidence',
            label: `证据摘录 ${selectedProjectNoteCount}`,
            children: (
              <div className="research-tab-layout">
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
                                  <Tag color={note.source_type === 'search' ? 'gold' : ['ai', 'ai_research'].includes(note.source_type) ? 'purple' : 'blue'}>{getNoteSourceLabel(note)}</Tag>
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

                <Card size="small" title="专题文献" extra={selectedProject ? <Button size="small" icon={<BookOutlined />} onClick={openAddDocs}>加入文献</Button> : null} className="research-panel">
                  {documents.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有加入文献" />
                  ) : (
                    <div className="research-project-doc-list">
                      {documents.map((doc) => {
                        const title = doc.title || '未命名文献'
                        return (
                          <Tooltip key={doc.id} title={title} placement="left">
                            <button
                              type="button"
                              className="research-project-doc-item"
                              onClick={() => onOpenDocument?.({ docId: doc.id })}
                            >
                              <span>{title}</span>
                            </button>
                          </Tooltip>
                        )
                      })}
                    </div>
                  )}
                </Card>
              </div>
            ),
          },
          {
            key: 'outline',
            label: '大纲整理',
            children: (
              <div className="research-tab-layout">
                <Card size="small" title="写作大纲" className="research-panel" extra={(
                  <Space>
                    <Button size="small" icon={<PlusOutlined />} disabled={!selectedProjectId} onClick={() => openOutlineModal()}>
                      添加
                    </Button>
                    <Button size="small" onClick={() => setSelectedOutlineId(null)}>全部</Button>
                  </Space>
                )}>
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
                            className={`research-outline-item research-outline-tree-item ${active ? 'active' : ''}`}
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

                <Card size="small" title="入纲状态" className="research-panel">
                  <div className="research-focus-strip single-column">
                    <div className="research-focus-item">
                      <span>已归入大纲</span>
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
                  </div>
                </Card>
              </div>
            ),
          },
          {
            key: 'ai',
            label: `研究结果 ${selectedProjectAiDatasetCount + selectedProjectOutputCount}`,
            children: (
              aiResultMode === 'summary' ? (
                <div className="research-result-summary">
                  <Card size="small" title="提取结果" className="research-panel">
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Text type="secondary">AI 从专题文献里提取出的结构化证据，例如人物、时间、地点、事件和原文出处。</Text>
                      <Statistic value={selectedProjectAiDatasetCount} suffix="组" />
                      <Button disabled={!selectedProjectId || selectedProjectAiDatasetCount === 0} onClick={() => openAiDatasetsMode()}>
                        查看提取结果
                      </Button>
                    </Space>
                  </Card>
                  <Card size="small" title="分析报告" className="research-panel">
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Text type="secondary">基于摘录或提取结果生成的专题综述、阶段梳理、观点比较等报告。</Text>
                      <Statistic value={selectedProjectOutputCount} suffix="份" />
                      <Space>
                        <Button disabled={!selectedProjectId || selectedProjectOutputCount === 0} onClick={() => openAiReportsMode()}>
                          查看分析报告
                        </Button>
                        <Button type="primary" icon={<FileSearchOutlined />} loading={synthesizing} disabled={!selectedProjectId} onClick={() => void handleSynthesize()}>
                          生成报告
                        </Button>
                      </Space>
                    </Space>
                  </Card>
                </div>
              ) : (
              <div className="research-tab-layout">
                {aiResultMode === 'datasets' ? (
                <Card
                  size="small"
                  title={<Space><RobotOutlined />提取结果</Space>}
                  className="research-panel"
                  extra={selectedDatasetId ? (
                    <Space size={4}>
                      <Button size="small" onClick={() => setAiResultMode('summary')}>返回</Button>
                      <Button size="small" onClick={() => void handleCopyDataset('markdown')}>复制</Button>
                      <Button size="small" loading={aiReportLoading} onClick={() => void handleGenerateDatasetReport()}>报告</Button>
                    </Space>
                  ) : null}
                >
                  {aiDatasets.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 AI 研究数据，可从 AI 助手点击“开始完整分析”生成" />
                  ) : (
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Text type="secondary">
                        这里保存的是 AI 从专题文献里提取出的证据记录。页面只显示前 {AI_RECORD_PREVIEW_LIMIT} 条预览，完整数据可复制 CSV 或 JSON。
                      </Text>
                      <Select
                        value={selectedDatasetId || undefined}
                        style={{ width: '100%' }}
                        onChange={(value) => void loadAiRecords(value)}
                        options={aiDatasets.map((dataset) => ({
                          value: dataset.id,
                          label: `${dataset.name} · ${dataset.record_count || 0} 条`,
                        }))}
                      />
                      <Space wrap>
                        <Button size="small" onClick={() => void handleCopyDataset('csv')}>复制 CSV</Button>
                        <Button size="small" onClick={() => void handleCopyDataset('json')}>复制 JSON</Button>
                        <Text type="secondary">{selectedDatasetRecordCount} 条记录</Text>
                      </Space>
                      {aiRecords.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个数据集还没有记录" />
                      ) : (
                        <>
                          <List
                            size="small"
                            className="research-ai-record-list"
                            dataSource={aiRecords}
                            renderItem={(record) => (
                            <List.Item
                              className="research-ai-record-item"
                              actions={[
                                <Button key="note" type="link" size="small" disabled={record.status === 'excluded'} onClick={() => void handleSaveAiRecordAsNote(record)}>转摘录</Button>,
                                <Button key="exclude" type="text" size="small" danger disabled={record.status === 'excluded'} onClick={() => void handleExcludeAiRecord(record.id)}>排除</Button>,
                              ]}
                            >
                              <List.Item.Meta
                                title={(
                                  <Space wrap size={6}>
                                    <Text strong>{record.doc_title || record.doc_id}</Text>
                                    <Tag color="blue">第 {record.page_num || '?'} 页</Tag>
                                    <Tag color={record.status === 'excluded' ? 'red' : 'gold'}>{record.status === 'excluded' ? '已排除' : `置信度 ${Math.round(Number(record.confidence || 0) * 100)}%`}</Tag>
                                  </Space>
                                )}
                                description={(
                                  <div>
                                    <Paragraph className="research-note-excerpt">{cleanResearchPreviewText(record.excerpt)}</Paragraph>
                                    {record.values ? (
                                      <div className="research-note-tags">
                                        {Object.entries(record.values).filter(([, value]) => value).slice(0, 6).map(([key, value]) => (
                                          <Tooltip key={key} title={`${key}: ${String(value)}`}>
                                            <Tag>{key}: {cleanResearchPreviewText(String(value), 40)}</Tag>
                                          </Tooltip>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                )}
                              />
                            </List.Item>
                            )}
                          />
                          {selectedDatasetRecordCount > aiRecords.length ? (
                            <Text type="secondary">还有 {selectedDatasetRecordCount - aiRecords.length} 条未在页面展开，可通过复制 CSV/JSON 查看完整结果。</Text>
                          ) : null}
                        </>
                      )}
                    </Space>
                  )}
                </Card>
                ) : null}

                {aiResultMode === 'reports' ? (
                <Card size="small" title={<Space><RobotOutlined />分析报告</Space>} className="research-panel">
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Button size="small" onClick={() => setAiResultMode('summary')}>返回研究结果</Button>
                    <Space.Compact style={{ width: '100%' }}>
                      <Select value={templateType} options={ANALYSIS_TEMPLATES} onChange={setTemplateType} style={{ flex: 1 }} />
                      <Button type="primary" icon={<FileSearchOutlined />} loading={synthesizing} disabled={!selectedProjectId} onClick={() => void handleSynthesize()}>
                        生成
                      </Button>
                    </Space.Compact>
                    {templateType === 'custom' ? (
                      <TextArea rows={4} placeholder="输入研究分析要求" value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} />
                    ) : null}
                    {outputs.length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无专题分析" />
                    ) : (
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Text type="secondary">这里是基于提取结果生成的报告预览，页面只显示最近 {AI_OUTPUT_PREVIEW_LIMIT} 份。</Text>
                        {visibleOutputs.map((output) => (
                          <div key={output.id} className="research-output-item">
                            <div className="research-output-title">
                              <Text strong>{output.title}</Text>
                              <Button size="small" icon={<CopyOutlined />} onClick={() => void handleCopyResearchOutput(output)}>复制</Button>
                            </div>
                            <Paragraph className="research-output-preview">{cleanResearchPreviewText(output.content, 520)}</Paragraph>
                          </div>
                        ))}
                        {outputs.length > visibleOutputs.length ? (
                          <Text type="secondary">还有 {outputs.length - visibleOutputs.length} 份较早报告未展开显示。</Text>
                        ) : null}
                      </Space>
                    )}
                  </Space>
                </Card>
                ) : null}
              </div>
              )
            ),
          },
          {
            key: 'writing',
            label: '写作导出',
            children: (
              <div className="research-tab-layout">
                <Card size="small" title={<Space><ReadOutlined />写作预览</Space>} className="research-panel" extra={<Button size="small" icon={<CopyOutlined />} disabled={!previewMarkdown} onClick={() => navigator.clipboard.writeText(previewMarkdown).then(() => message.success('已复制写作预览'))}>复制</Button>}>
                  {previewMarkdown ? (
                    <pre className="research-writing-preview">{previewMarkdown}</pre>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择专题并保存摘录后生成预览" />
                  )}
                </Card>

                <Card size="small" title="参考文献与导出" className="research-panel">
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Button icon={<CopyOutlined />} onClick={() => void handleExportReferences('gbt7714')} block>复制 GB/T 7714</Button>
                    <Button icon={<CopyOutlined />} onClick={() => void handleExportReferences('bibtex')} block>复制 BibTeX</Button>
                    <Button icon={<CopyOutlined />} onClick={() => void handleExportReferences('ris')} block>复制 RIS</Button>
                    <Button icon={<ExportOutlined />} onClick={() => void handleExportProject('json')} block>复制 JSON</Button>
                  </Space>
                </Card>
              </div>
            ),
          },
        ]}
      />

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
