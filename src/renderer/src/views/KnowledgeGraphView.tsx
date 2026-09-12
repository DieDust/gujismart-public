import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Drawer, Empty, Form, Input, InputNumber, List, Modal, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import { ApartmentOutlined, CheckOutlined, CloseOutlined, CopyOutlined, EditOutlined, FileSearchOutlined, FilterOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SaveOutlined, TableOutlined, UnorderedListOutlined, ClockCircleOutlined } from '@ant-design/icons'
import type { AiResearchDataset, AiResearchRecord, DocumentListItem, Folder, KnowledgeGraphData, KnowledgeGraphDatasetConfig, LibraryAiOpenPayload, LibraryAiScope, LibraryAiScopePreview, OpenDocumentTarget, ResearchProject, Tag as SharedTag } from '@shared/types'
import {
  buildKnowledgeGraph, defaultGraphMapping, filterResearchGraph, getResearchDatasetFields,
  normalizeKnowledgeGraphConfigs, researchRecordValues, type ResearchEntityKind, type ResearchGraphEdge,
} from '@shared/research-graph'
import { findResearchGraphPath } from '@shared/research-graph-path'
import { getErrorMessage } from '@shared/errors'
import { legacySearchLocatorFromUnknown } from '@shared/stable-reader-locator'
import KnowledgeGraphCanvas, { GRAPH_KIND_COLORS } from '../components/KnowledgeGraphCanvas'
import KnowledgeGraphTables from '../components/KnowledgeGraphTables'
import ResearchTaskHistory from '../components/ResearchTaskHistory'
import KnowledgeEvidenceTable, { evidenceFieldText } from '../components/KnowledgeEvidenceTable'
import CollectResearchEvidence from '../components/CollectResearchEvidence'
import KnowledgeQuestionView from '../components/KnowledgeQuestionView'
import type { GraphStudyView } from '../utils/graphStudyRows'
import { useDragMultiSelect } from '../utils/dragMultiSelect'
import { buildFolderTree, collectFolderDescendantIds, type FolderTreeNode } from '../utils/folders'
import './KnowledgeGraphView.css'

const ResearchView = lazy(() => import('./ResearchView'))
type WorkspaceMode = 'question' | 'browse' | 'research'

const KINDS: Array<{ value: ResearchEntityKind; label: string }> = [
  { value: 'person', label: '人物' }, { value: 'place', label: '地点' }, { value: 'time', label: '时间' }, { value: 'event', label: '事件' },
]
const ALL_KINDS = KINDS.map((kind) => kind.value)
const KIND_LABELS = Object.fromEntries(KINDS.map((kind) => [kind.value, kind.label]))
const EMPTY_DATA: KnowledgeGraphData = { libraryProjectId: '', datasets: [], records: [], totalRecords: 0, truncated: false }
type View = 'network' | 'evidence' | GraphStudyView
interface Props {
  libraryProjectId: string
  onOpenDocument?: (target: OpenDocumentTarget) => void
  onOpenLibraryAi?: (payload?: string | LibraryAiOpenPayload) => void
  initialMode?: WorkspaceMode
  onActiveProjectChange?: (projectId: string | null) => void
}

function readWorkspace(key: string): { datasetIds: string[]; configs: Record<string, KnowledgeGraphDatasetConfig>; topicId?: string; topicQuestion: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}')
    return {
      datasetIds: Array.isArray(saved.datasetIds) ? saved.datasetIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, 20) : [],
      // v1 configs were created before generic keyword/entity fields were
      // mapped and could silently keep every useful field ignored.
      configs: normalizeKnowledgeGraphConfigs(saved.configs),
      topicId: typeof saved.topicId === 'string' ? saved.topicId : undefined,
      topicQuestion: typeof saved.topicQuestion === 'string' ? saved.topicQuestion : '',
    }
  } catch { return { datasetIds: [], configs: {}, topicQuestion: '' } }
}

function guessRelationFields(fields: ReturnType<typeof getResearchDatasetFields>): Pick<KnowledgeGraphDatasetConfig, 'sourceField' | 'targetField' | 'relationField'> {
  const keys = new Set(fields.map((field) => field.key))
  const first = ['relation_subject', 'subject', 'source', '主体', '人物'].find((key) => keys.has(key))
  const second = ['relation_object', 'object', 'target', '客体', '对象'].find((key) => keys.has(key))
  const relation = ['relation_type', 'relation', 'predicate', '关系类型', '关系'].find((key) => keys.has(key))
  return first && second && relation ? { sourceField: first, targetField: second, relationField: relation } : {}
}

function applyRelationMapping(mapping: ReturnType<typeof defaultGraphMapping>, fields: ReturnType<typeof getResearchDatasetFields>, relation: Pick<KnowledgeGraphDatasetConfig, 'sourceField' | 'targetField'>) {
  const result = { ...mapping }
  const source = fields.find((field) => field.key === relation.sourceField)
  const target = fields.find((field) => field.key === relation.targetField)
  if (source && result[source.key] === 'ignore' && /subject|source|主体|人物|人名/i.test(`${source.key} ${source.label || ''}`)) result[source.key] = 'person'
  if (target && result[target.key] === 'ignore' && /object|target|客体|对象|人物|人名/i.test(`${target.key} ${target.label || ''}`)) result[target.key] = 'person'
  return result
}

export default function KnowledgeGraphView({ libraryProjectId, onOpenDocument, onOpenLibraryAi, initialMode = 'question', onActiveProjectChange }: Props) {
  const storageKey = `gujismart.knowledge-workspace.v1.${libraryProjectId}`
  const [saved] = useState(() => readWorkspace(storageKey))
  const [mode, setMode] = useState<WorkspaceMode>(initialMode)
  const [researchVisited, setResearchVisited] = useState(initialMode === 'research')
  const [researchTarget, setResearchTarget] = useState<{ key: 'evidence' | 'ai'; revision: number }>()
  const advanced = mode === 'browse'
  const [questionDocuments, setQuestionDocuments] = useState<string[]>()
  const [analysisPurpose, setAnalysisPurpose] = useState<'extract' | 'question'>('extract')
  const sourceSelectionInitialized = useRef(false)
  const [sources, setSources] = useState<AiResearchDataset[]>([])
  const [datasetIds, setDatasetIds] = useState<string[]>(saved.datasetIds)
  const [configs, setConfigs] = useState(saved.configs)
  const [data, setData] = useState<KnowledgeGraphData>(EMPTY_DATA)
  const [loading, setLoading] = useState(false)
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [error, setError] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<View>('evidence')
  const [projects, setProjects] = useState<ResearchProject[]>([])
  const [topicId, setTopicId] = useState<string | undefined>(saved.topicId)
  const [topicQuestion, setTopicQuestion] = useState(saved.topicQuestion)
  const [scopeState, setScopeState] = useState<{ projectId?: string; scope: LibraryAiScope; preview?: LibraryAiScopePreview; busy: boolean }>({ scope: { type: 'documents', docIds: [] }, busy: true })
  const scopeBusy = scopeState.projectId !== topicId || scopeState.busy
  const scopePreview = scopeState.projectId === topicId ? scopeState.preview : undefined
  const onScopeState = useCallback((scope: LibraryAiScope, preview: LibraryAiScopePreview | undefined, busy: boolean) => {
    setScopeState({ projectId: topicId, scope, preview, busy })
  }, [topicId])
  const [topicError, setTopicError] = useState('')
  const [topicModal, setTopicModal] = useState(false)
  const [editingTopicId, setEditingTopicId] = useState<string>()
  const [topicSaving, setTopicSaving] = useState(false)
  const topicLock = useRef(false)
  const [topicForm] = Form.useForm<{ name: string; description: string }>()
  const [selectedRecordId, setSelectedRecordId] = useState<string>()
  const [collectingRecord, setCollectingRecord] = useState<AiResearchRecord>()
  const [edgeKind, setEdgeKind] = useState<ResearchGraphEdge['kind'] | 'auto'>('auto')
  const [kinds, setKinds] = useState<ResearchEntityKind[]>(ALL_KINDS)
  const [confirmedOnly, setConfirmedOnly] = useState(false)
  const [minEvidence, setMinEvidence] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [focusId, setFocusId] = useState<string>()
  const [pathTarget, setPathTarget] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [editingRecord, setEditingRecord] = useState<AiResearchRecord>()
  const [saving, setSaving] = useState(false)
  const [analysisPickerOpen, setAnalysisPickerOpen] = useState(false)
  const [analysisDocuments, setAnalysisDocuments] = useState<DocumentListItem[]>([])
  const [analysisFolders, setAnalysisFolders] = useState<Folder[]>([])
  const [analysisTags, setAnalysisTags] = useState<SharedTag[]>([])
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisSearch, setAnalysisSearch] = useState('')
  const [analysisType, setAnalysisType] = useState<string>()
  const [analysisTagId, setAnalysisTagId] = useState<string>()
  const [analysisFolderId, setAnalysisFolderId] = useState<string>()
  const [analysisSelectedIds, setAnalysisSelectedIds] = useState<string[]>([])
  const [addSelectionToTopic, setAddSelectionToTopic] = useState(true)
  const analysisSubmitLock = useRef(false)
  const analysisListRef = useRef<HTMLDivElement>(null)
  const [form] = Form.useForm()

  const pendingResearchTopic = useRef<string>()
  useEffect(() => {
    onActiveProjectChange?.(topicId || null)
    return () => onActiveProjectChange?.(null)
  }, [mode, topicId, onActiveProjectChange])

  useEffect(() => {
    let active = true
    void window.api.listResearchProjects().then((items) => {
      if (active) {
        setProjects(items); setTopicError('')
        setTopicId((id) => items.some((item) => item.id === id) ? id : undefined)
      }
    }).catch((reason: unknown) => { if (active) setTopicError(getErrorMessage(reason, '读取研究专题失败')) })
    return () => { active = false }
  }, [libraryProjectId, revision])
  const chooseTopic = (id?: string) => {
    if (scopeBusy) return
    setQuestionDocuments(undefined)
    setTopicId(id)
    setTopicQuestion(projects.find((project) => project.id === id)?.description || '')
    // Only an explicit topic choice changes the material selection; refreshes preserve it.
    if (id) setDatasetIds(sources.filter((source) => source.project_id === id).slice(0, 20).map((source) => source.id))
    setSelectedRecordId(undefined)
    setView('evidence')
    pendingResearchTopic.current = id
  }
  const saveTopic = async () => {
    if (topicLock.current) return
    const values = await topicForm.validateFields().catch(() => null)
    if (!values || topicLock.current) return
    topicLock.current = true
    setTopicSaving(true)
    try {
      if (editingTopicId) {
        await window.api.updateResearchProject(editingTopicId, values)
        setProjects((items) => items.map((item) => item.id === editingTopicId ? { ...item, ...values } : item))
        window.dispatchEvent(new CustomEvent('gujismart:research-workspace-updated', { detail: { projectId: editingTopicId } }))
      } else {
        const project = await window.api.createResearchProject(values)
        setProjects((items) => [...items, project]); setTopicId(project.id)
        setQuestionDocuments(undefined); setDatasetIds([]); pendingResearchTopic.current = project.id
      }
      setTopicQuestion(values.description || '')
      setTopicModal(false)
      setTopicError('')
    } catch (reason: unknown) { setTopicError(getErrorMessage(reason, '保存研究专题失败')) }
    finally { topicLock.current = false; setTopicSaving(false) }
  }

  const analysisFolderTree = useMemo(() => buildFolderTree(analysisFolders), [analysisFolders])
  const flatAnalysisFolders = useMemo(() => {
    const result: FolderTreeNode[] = []
    const visit = (node: FolderTreeNode) => { result.push(node); node.children.forEach(visit) }
    analysisFolderTree.forEach(visit)
    return result
  }, [analysisFolderTree])
  const filteredAnalysisDocuments = useMemo(() => {
    const query = analysisSearch.trim().toLocaleLowerCase()
    const folderIds = new Set(analysisFolderId ? collectFolderDescendantIds(analysisFolders, analysisFolderId) : [])
    return analysisDocuments.filter((doc) => {
      if (analysisType && doc.doc_type !== analysisType) return false
      if (analysisTagId && !String(doc.tag_ids || '').split('|').includes(analysisTagId)) return false
      if (analysisFolderId && !String(doc.folder_ids || '').split('|').some((id) => folderIds.has(id))) return false
      return !query || `${doc.title || ''} ${doc.author || ''}`.toLocaleLowerCase().includes(query)
    })
  }, [analysisDocuments, analysisFolderId, analysisSearch, analysisTagId, analysisType, analysisFolders])
  const analysisDrag = useDragMultiSelect({
    rootRef: analysisListRef,
    itemSelector: '[data-analysis-select-id]',
    getItemId: (element) => element.dataset.analysisSelectId,
    reactPreview: false,
    selectedIds: analysisSelectedIds,
    orderedIds: filteredAnalysisDocuments.map((doc) => doc.id),
    includeOrderedRangeBetweenHits: true,
    activeClassName: 'knowledge-analysis-selecting',
    overlayClassName: 'knowledge-analysis-marquee',
    overlayLabel: (count) => `已选 ${count} 篇`,
    onCommit: setAnalysisSelectedIds,
  })

  useEffect(() => {
    if (!advanced) { setSourcesLoading(false); return }
    let active = true
    setSourcesLoading(true)
    setSourceError('')
    void window.api.listAiResearchDatasets().then((items) => {
      if (!active) return
      setSources(items)
      const researchTopic = pendingResearchTopic.current
      pendingResearchTopic.current = undefined
      setDatasetIds((previous) => {
        if (researchTopic) {
          sourceSelectionInitialized.current = true
          return items.filter((item) => item.project_id === researchTopic).slice(0, 20).map((item) => item.id)
        }
        const available = items.filter((item) => !topicId || item.project_id === topicId)
        const valid = previous.filter((id) => available.some((item) => item.id === id))
        if (!sourceSelectionInitialized.current) {
          sourceSelectionInitialized.current = true
          return valid.length ? valid : available.slice(0, topicId ? 20 : 1).map((item) => item.id)
        }
        return valid
      })
    }).catch((reason: unknown) => { if (active) setSourceError(getErrorMessage(reason, '读取图谱数据源失败')) })
      .finally(() => { if (active) setSourcesLoading(false) })
    return () => { active = false }
  }, [libraryProjectId, revision, advanced, topicId])

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ datasetId?: string | null; projectId?: string | null }>).detail
      if (detail?.datasetId && (!topicId || detail.projectId === topicId)) setDatasetIds((previous) => previous.includes(detail.datasetId as string) ? previous : [detail.datasetId as string, ...previous].slice(0, 20))
      setRevision((value) => value + 1)
    }
    window.addEventListener('gujismart:research-workspace-updated', refresh)
    return () => window.removeEventListener('gujismart:research-workspace-updated', refresh)
  }, [topicId])

  useEffect(() => {
    if (!advanced || sourcesLoading || sourceError) { setLoading(false); return }
    let active = true
    setLoading(true)
    setError('')
    setData(EMPTY_DATA)
    setSelectedId(undefined)
    setSelectedRecordId(undefined)
    setFocusId(undefined)
    setPathTarget(undefined)
    void window.api.getKnowledgeGraphData({ datasetIds }).then((result) => {
      if (active) setData(result)
    }).catch((reason: unknown) => { if (active) setError(getErrorMessage(reason, '读取图谱材料失败')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [datasetIds, sourcesLoading, sourceError, advanced])

  useEffect(() => {
    if (topicError) return
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 2, datasetIds, configs, topicId, topicQuestion })) }
    catch (reason: unknown) { console.warn('Could not persist knowledge workspace preferences', reason) }
  }, [storageKey, datasetIds, configs, topicId, topicQuestion, topicError])

  const effectiveConfigs = useMemo(() => Object.fromEntries(data.datasets.map((dataset) => [
    dataset.id, (() => {
      const fields = getResearchDatasetFields(dataset, data.records.filter((record) => record.dataset_id === dataset.id))
      const savedConfig = configs[dataset.id]
      if (savedConfig) return savedConfig
      const relation = guessRelationFields(fields)
      return { mapping: applyRelationMapping(defaultGraphMapping(fields), fields, relation), ...relation }
    })(),
  ])), [data, configs])
  const eligibleRecords = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase()
    return data.records.filter((record) => !query || [record.excerpt, record.doc_title, ...Object.values(researchRecordValues(record))]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query)))
  }, [data.records, keyword])
  const graph = useMemo(() => buildKnowledgeGraph({ ...data, records: eligibleRecords }, effectiveConfigs, confirmedOnly), [data, eligibleRecords, effectiveConfigs, confirmedOnly])
  const resolvedEdgeKind = useMemo<ResearchGraphEdge['kind']>(() => {
    if (edgeKind !== 'auto') return edgeKind
    if (graph.edges.some((edge) => edge.kind === 'event')) return 'event'
    return 'cooccurrence'
  }, [graph.edges, edgeKind])
  const kindGraph = useMemo(() => ({ ...graph, edges: graph.edges.filter((edge) => edge.kind === resolvedEdgeKind) }), [graph, resolvedEdgeKind])
  const unbounded = useMemo(() => {
    const ids = new Set(graph.nodes.filter((node) => kinds.includes(node.kind)).map((node) => node.id))
    return { ...graph, nodes: graph.nodes.filter((node) => ids.has(node.id)), edges: kindGraph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.recordIds.length >= minEvidence) }
  }, [graph, kindGraph, kinds, minEvidence])
  const path = useMemo(() => focusId && pathTarget ? findResearchGraphPath(unbounded, focusId, pathTarget) : undefined, [unbounded, focusId, pathTarget])
  const pathGraph = useMemo(() => path ? {
    ...unbounded, nodes: unbounded.nodes.filter((node) => path.includes(node.id)), edges: unbounded.edges.filter((edge) => path.includes(edge.id)),
  } : unbounded, [unbounded, path])
  const visible = useMemo(() => filterResearchGraph(pathGraph, { kinds, minEvidence, focusId: pathTarget ? undefined : focusId, bounded: view === 'network' }), [pathGraph, kinds, minEvidence, focusId, pathTarget, view])
  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  const selected = visible.nodes.find((node) => node.id === selectedId) || visible.edges.find((edge) => edge.id === selectedId)
  const selectedRecordIds = useMemo(() => new Set(selected?.recordIds || []), [selected])
  const selectedRecords = useMemo(() => data.records.filter((record) => view === 'evidence' ? record.id === selectedRecordId : selectedRecordIds.has(record.id)), [data.records, selectedRecordIds, selectedRecordId, view])
  const entityOptions = useMemo(() => unbounded.nodes.map((node) => ({ value: node.id, label: `${node.label} · ${KIND_LABELS[node.kind]}` })), [unbounded.nodes])
  const recordsById = useMemo(() => new Map(data.records.map((record) => [record.id, record])), [data.records])
  const independentDocuments = (ids: string[]) => new Set(ids.map((id) => recordsById.get(id)?.doc_id).filter(Boolean)).size

  const openSource = (record: AiResearchRecord) => {
    let locator: ReturnType<typeof legacySearchLocatorFromUnknown> = null
    try { locator = legacySearchLocatorFromUnknown(JSON.parse(record.locator_json || '{}')) } catch { /* Use the saved page. */ }
    onOpenDocument?.({
      docId: record.doc_id, pageIndex: locator?.pageIndex ?? Math.max(0, (record.page_num || 1) - 1),
      excerpt: record.excerpt, highlightExcerpt: record.excerpt.slice(0, 180), sourceId: record.id,
      sourceLabel: '图谱证据', locator: locator || undefined,
    })
  }
  const updateRecord = async (record: AiResearchRecord, status: 'confirmed' | 'excluded' | 'pending') => {
    setSaving(true)
    try {
      const updated = await window.api.updateAiResearchRecord(record.id, { status })
      setData((previous) => ({ ...previous, records: previous.records.map((item) => item.id === updated.id ? updated : item) }))
      if (status === 'excluded') {
        message.open({ type: 'success', duration: 8, content: <Space>已排除记录，原始材料保留
          <Button size="small" type="link" onClick={() => void updateRecord(record, record.status === 'confirmed' ? 'confirmed' : 'pending')}>撤销</Button>
        </Space> })
      } else message.success('记录状态已更新')
    } catch (reason: unknown) { message.error(getErrorMessage(reason, '更新记录失败')) }
    finally { setSaving(false) }
  }
  const saveEdit = async () => {
    if (!editingRecord) return
    const fields = await form.validateFields()
    setSaving(true)
    try {
      const updated = await window.api.updateAiResearchRecord(editingRecord.id, { values: fields.values, note: fields.note, status: 'pending' })
      setData((previous) => ({ ...previous, records: previous.records.map((item) => item.id === updated.id ? updated : item) }))
      setEditingRecord(undefined)
      message.success('已保存修订，记录待重新核验')
    } catch (reason: unknown) { message.error(getErrorMessage(reason, '保存修订失败')) }
    finally { setSaving(false) }
  }
  const copy = async (format: 'json' | 'csv') => {
    const evidenceIds = new Set(visible.nodes.flatMap((node) => node.recordIds))
    const cell = (text: string) => `"${(/^[=+\-@\t\r]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`
    const content = format === 'json' ? JSON.stringify({
      version: 2, scope: { libraryProjectId, datasetIds }, configs: effectiveConfigs,
      semantics: { identity: 'same-type-and-name candidates, not verified identity', edgeKind: resolvedEdgeKind, pathDirected: false },
      coverage: { totalRecords: data.totalRecords, loadedRecords: data.records.length, truncated: data.truncated, hiddenNodes: visible.hiddenNodes, hiddenEdges: visible.hiddenEdges, omittedValues: graph.omittedValues },
      filters: { kinds, minEvidence, keyword, confirmedOnly, focusId, pathTarget },
      nodes: visible.nodes, edges: visible.edges, evidence: data.records.filter((record) => evidenceIds.has(record.id)),
    }, null, 2) : [
      ['Source', 'Target', 'Type', 'Label', 'Records', 'Documents', 'EvidenceIds'],
      ...visible.edges.map((edge) => [nodesById.get(edge.source)?.label || '', nodesById.get(edge.target)?.label || '',
        edge.directed ? 'Directed' : 'Undirected', edge.label, String(edge.recordIds.length), String(independentDocuments(edge.recordIds)), JSON.stringify(edge.recordIds)]),
    ].map((row) => row.map(cell).join(',')).join('\r\n')
    try { await navigator.clipboard.writeText(content); message.success(`已复制当前图谱 ${format.toUpperCase()}`) }
    catch (reason: unknown) { message.error(getErrorMessage(reason, '复制失败')) }
  }
  const changeConfig = (datasetId: string, patch: Partial<KnowledgeGraphDatasetConfig>) => {
    setConfigs((previous) => ({ ...previous, [datasetId]: { ...effectiveConfigs[datasetId], ...patch } }))
  }
  const openAnalysisPicker = async (purpose: 'extract' | 'question' = 'extract', selectedDocuments?: string[]) => {
    setAnalysisPurpose(purpose)
    setAddSelectionToTopic(true)
    if (selectedDocuments) setAnalysisSelectedIds(selectedDocuments)
    setAnalysisPickerOpen(true)
    setAnalysisLoading(true)
    try {
      const documents: DocumentListItem[] = []
      for (let offset = 0; ; offset += 500) {
        const page = await window.api.listDocuments({ limit: 500, offset, sortKey: 'title', sortDirection: 'asc' })
        documents.push(...page)
        if (page.length < 500) break
      }
      const folders = await window.api.listFolders()
      const tags = await window.api.listTags()
      setAnalysisDocuments(documents)
      setAnalysisFolders(folders)
      setAnalysisTags(tags)
      setAnalysisSelectedIds((current) => current.filter((id) => documents.some((doc) => doc.id === id)))
    } catch (reason: unknown) {
      message.error(getErrorMessage(reason, '读取文献选择范围失败'))
    } finally {
      setAnalysisLoading(false)
    }
  }
  const startAi = (selectionOnly = false, documentIds?: string[], scopeOverride?: LibraryAiScope) => {
    const materials = selectionOnly ? selectedRecords : data.records
    const explicitDocumentIds = documentIds?.length ? [...new Set(documentIds)] : undefined
    onOpenLibraryAi?.({
    initialTab: 'research',
    researchProjectId: topicId || null,
    scope: scopeOverride || (explicitDocumentIds?.length
      ? { type: 'documents', docIds: explicitDocumentIds }
      : materials.length ? { type: 'documents', docIds: [...new Set(materials.map((record) => record.doc_id).filter(Boolean))] } : undefined),
    scopeLabel: explicitDocumentIds?.length
      ? `知识结构化：已选 ${explicitDocumentIds.length} 篇文献`
      : scopeOverride ? '当前选读范围' : selectionOnly ? `考察：${selected?.label || ''}` : data.records.length ? '图谱当前已载入材料' : '当前文献项目',
    question: (topicQuestion.trim() ? `研究专题：${projects.find((project) => project.id === topicId)?.name || ''}\n研究问题：${topicQuestion.trim()}\n\n` : '') + (selectionOnly
      ? `围绕“${selected?.label || ''}”核查相关文献：逐条列出原文、出处页码、时间表述、涉及人物与地点，区分明确陈述与共现线索，指出同名歧义、相互矛盾的记载和仍缺少的证据。不得把未记载写成不存在。`
      : '围绕研究问题提取有原文依据的人物、地点、时间和事件。关系须分别记录主体、客体、关系类型及原文出处；分别保留支持材料、反证与相互矛盾的记载，保留歧义与不确定性，不把共现当成事实关系。不用整段议论或试题充当事件名称。'),
  })
  }
  const submitAnalysisSelection = async () => {
    if (analysisLoading || analysisSubmitLock.current) return
    if (!analysisSelectedIds.length) {
      message.info('请先选择至少一篇文献')
      return
    }
    analysisSubmitLock.current = true; setAnalysisLoading(true)
    try {
      if (analysisPurpose === 'question' && topicId && addSelectionToTopic) {
        await window.api.addResearchProjectDocuments(topicId, analysisSelectedIds)
        window.dispatchEvent(new CustomEvent('gujismart:research-workspace-updated', { detail: { projectId: topicId } }))
      }
      setAnalysisPickerOpen(false)
      if (analysisPurpose === 'question') setQuestionDocuments([...analysisSelectedIds])
      else startAi(false, analysisSelectedIds)
    } catch (reason: unknown) { message.error(getErrorMessage(reason, '保存选读文献失败，请重试')) }
    finally { analysisSubmitLock.current = false; setAnalysisLoading(false) }
  }
  const deleteSelectedDatasets = () => {
    if (!datasetIds.length) return
    const documentIds = [...new Set(data.records
      .filter((record) => datasetIds.includes(record.dataset_id))
      .map((record) => record.doc_id)
      .filter(Boolean))]
    Modal.confirm({
      title: '删除当前知识数据集？',
      content: '只删除抽取结果、实体和关系数据，不会删除原文、OCR、向量或文献库内容。删除后可以重新选择文献再次分析。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          for (const datasetId of datasetIds) await window.api.deleteAiResearchDataset(datasetId)
          setDatasetIds([])
          setData(EMPTY_DATA)
          setRevision((value) => value + 1)
          await openAnalysisPicker()
          setAnalysisSelectedIds(documentIds)
          message.success('旧知识数据已清除，请确认文献后重新执行 AI 分析')
        } catch (reason: unknown) {
          message.error(getErrorMessage(reason, '清除知识数据失败'))
        }
      },
    })
  }

  return <div className="knowledge-workspace">
    <header className="knowledge-workspace-header">
      <Typography.Title level={4}><ApartmentOutlined /> 知识图谱</Typography.Title>
      <Segmented aria-label="知识工作区" value={mode} options={[
        { value: 'question', label: '向文献提问' }, { value: 'browse', label: '资料浏览' }, { value: 'research', label: '专题研究' },
      ]} onChange={(value) => { setMode(value as WorkspaceMode); if (value === 'research') setResearchVisited(true) }} />
    </header>
    <div className="knowledge-context-bar">
      <Select aria-label="研究专题" allowClear showSearch optionFilterProp="label" placeholder="临时研究（未归入专题）" value={topicId} onChange={chooseTopic} disabled={scopeBusy}
        options={projects.map((project) => ({ value: project.id, label: `${project.name}${project.status === 'archived' ? '（已归档）' : ''}` }))} />
      <Tooltip title="新建研究专题"><Button aria-label="新建研究专题" icon={<PlusOutlined />} disabled={scopeBusy} onClick={() => {
        setEditingTopicId(undefined); topicForm.resetFields(); topicForm.setFieldsValue({ name: '', description: '' }); setTopicModal(true)
      }} /></Tooltip>
      {topicId && <Tooltip title="编辑专题与研究问题"><Button aria-label="编辑专题与研究问题" icon={<EditOutlined />} disabled={scopeBusy} onClick={() => {
        setEditingTopicId(topicId); topicForm.resetFields(); topicForm.setFieldsValue({ name: projects.find((project) => project.id === topicId)?.name || '', description: topicQuestion }); setTopicModal(true)
      }} /></Tooltip>}
      <Button icon={<FileSearchOutlined />} disabled={scopeBusy} onClick={() => void openAnalysisPicker('question', scopeState.scope.type === 'documents' ? scopeState.scope.docIds : scopePreview?.documents.map((doc) => doc.id))}>选择文献</Button>
      <Typography.Text type="secondary">{scopePreview ? `${scopePreview.count} 篇选读 · ${scopePreview.ocrReadyCount} 篇有可用文本` : '读取选读范围…'}</Typography.Text>
      {scopePreview && scopePreview.count > scopePreview.ocrReadyCount && <Tag color="gold">{scopePreview.count - scopePreview.ocrReadyCount} 篇暂无可用文本</Tag>}
      <div className="knowledge-context-actions">
        <Button icon={<RobotOutlined />} disabled={scopeBusy || !scopePreview?.ocrReadyCount || !onOpenLibraryAi} onClick={() => {
          startAi(false, undefined, scopeState.scope)
        }}>提取人物与关系</Button>
        <Tooltip title="分析记录"><Button aria-label="分析记录" icon={<ClockCircleOutlined />} onClick={() => setHistoryOpen(true)} /></Tooltip>
      </div>
    </div>
    {topicError && !topicModal && <Alert type="error" showIcon message={topicError} />}
    <div className="knowledge-question-host" hidden={mode !== 'question'}><KnowledgeQuestionView key={topicId || 'temporary'} projectId={topicId} libraryProjectId={libraryProjectId} selectedDocuments={questionDocuments}
      onScopeState={onScopeState} onOpenResearch={(key) => { setResearchTarget((previous) => ({ key, revision: (previous?.revision || 0) + 1 })); setMode('research'); setResearchVisited(true) }} onOpenDocument={onOpenDocument} /></div>
    {researchVisited && <div className="knowledge-research-host" hidden={mode !== 'research'}><Suspense fallback={<Spin />}>
      <ResearchView embedded projectId={topicId} requestedTab={researchTarget} onBrowseMaterials={() => setMode('browse')} onOpenDocument={onOpenDocument} onOpenLibraryAi={onOpenLibraryAi} />
    </Suspense></div>}
    <div className="knowledge-workbench gs-view-container" style={advanced ? undefined : { display: 'none' }}>
    <header className="knowledge-header">
      <Typography.Text type="secondary">{data.records.length} / {data.totalRecords} 条材料 · {graph.nodes.length} 个同名实体组</Typography.Text>
      <Space wrap>
        <Tooltip title="删除当前数据集后重新生成"><Button aria-label="清除当前知识数据" danger icon={<CloseOutlined />} disabled={!datasetIds.length} onClick={deleteSelectedDatasets} /></Tooltip>
        <Tooltip title="字段与关系定义"><Button aria-label="字段与关系定义" icon={<FilterOutlined />} onClick={() => setSettingsOpen(true)} /></Tooltip>
        <Tooltip title="刷新材料"><Button aria-label="刷新图谱" icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)} /></Tooltip>
        <Button icon={<CopyOutlined />} disabled={!visible.nodes.length} onClick={() => void copy('json')}>JSON</Button>
        <Button icon={<CopyOutlined />} disabled={!visible.edges.length} onClick={() => void copy('csv')}>CSV</Button>
      </Space>
    </header>
    <div className="knowledge-source-bar">
      <Select mode="multiple" aria-label="图谱材料集" placeholder="选择材料集" maxTagCount="responsive"
        value={datasetIds} loading={sourcesLoading} className="knowledge-source-select"
        options={sources.filter((source) => !topicId || source.project_id === topicId).map((source) => ({ value: source.id, label: `${source.name} (${source.record_count || 0})` }))}
        onChange={(ids: string[]) => { setData(EMPTY_DATA); setFocusId(undefined); setPathTarget(undefined); setDatasetIds(ids.slice(0, 20)) }} />
      <Input.Search aria-label="筛选图谱材料" placeholder="材料全文、人物或地名" allowClear onSearch={setKeyword} className="knowledge-text-search" />
      <Checkbox checked={confirmedOnly} onChange={(event) => setConfirmedOnly(event.target.checked)}>仅已确认记录</Checkbox>
    </div>
    {(error || sourceError) && <Alert type="error" showIcon message={sourceError || error} />}
    {(data.truncated || visible.hiddenNodes > 0 || visible.hiddenEdges > 0 || graph.omittedValues > 0) && <Alert type="warning" showIcon
      message={`局部视图：已载入 ${data.records.length}/${data.totalRecords} 条材料；未展示 ${visible.hiddenNodes} 个实体、${visible.hiddenEdges} 条连线；${graph.omittedValues} 个超长或超量值未纳入`} />}
    <div className="knowledge-view-bar">
      <Segmented value={view} onChange={(value) => {
        setView(value as View); setKinds(ALL_KINDS); setFocusId(undefined); setPathTarget(undefined); setSelectedId(undefined)
      }} options={[
        { value: 'evidence', label: '材料核验', icon: <FileSearchOutlined /> },
        { value: 'network', label: '关系网络', icon: <ApartmentOutlined /> }, { value: 'people', label: '人物考察', icon: <UnorderedListOutlined /> },
        { value: 'places', label: '地点考察' }, { value: 'events', label: '事件考察' },
        { value: 'relations', label: '关系考证', icon: <TableOutlined /> }, { value: 'timeline', label: '时间线索', icon: <ClockCircleOutlined /> },
      ]} />
      {(view === 'network' || view === 'relations') && <Select aria-label="关联类型" value={edgeKind} onChange={(kind) => { setEdgeKind(kind); setSelectedId(undefined) }} options={[
        { value: 'auto', label: '自动选择' }, { value: 'event', label: '事件关联' }, { value: 'relation', label: '明确关系' }, { value: 'cooccurrence', label: '共现候选' },
      ]} />}
      {view === 'network' && <Checkbox.Group value={kinds} onChange={(values) => setKinds(values as ResearchEntityKind[])}
        options={KINDS.map((kind) => ({ value: kind.value, label: <span><i className="knowledge-swatch" style={{ background: GRAPH_KIND_COLORS[kind.value] }} />{kind.label}</span> }))} />
      }
      {(view === 'network' || view === 'relations') && <label className="knowledge-min">最少关联材料 <InputNumber aria-label="最少共现记录" min={1} max={2000} precision={0} value={minEvidence} onChange={(value) => setMinEvidence(value || 1)} /></label>}
    </div>
    {view === 'network' && <div className="knowledge-path-bar">
      <Select aria-label="中心实体" showSearch allowClear optionFilterProp="label" placeholder="考察对象"
        value={focusId} options={entityOptions} onChange={(value) => { setFocusId(value); setPathTarget(undefined); setSelectedId(value) }} />
      <Select aria-label="路径终点" showSearch allowClear optionFilterProp="label" placeholder="路径终点（可选）"
        value={pathTarget} options={entityOptions} disabled={!focusId} onChange={setPathTarget} />
      <Typography.Text type="secondary">{path === null ? '当前材料与筛选条件下无关联路径' : path ? `${Math.floor(path.length / 2)} 步关联路径（不区分方向）` : `${visible.nodes.length} 实体 · ${visible.edges.length} 关联`}</Typography.Text>
      {(focusId || pathTarget) && <Button type="text" icon={<CloseOutlined />} onClick={() => { setFocusId(undefined); setPathTarget(undefined); setSelectedId(undefined) }}>清除定位</Button>}
    </div>}
    <Spin wrapperClassName="knowledge-content" spinning={loading || sourcesLoading}>
      <div className="knowledge-body">
        <main className={`knowledge-main${view === 'network' ? ' knowledge-main-network' : ''}`}>
          {view === 'evidence' ? <KnowledgeEvidenceTable records={eligibleRecords} datasets={data.datasets} confirmedOnly={confirmedOnly}
            selectedId={selectedRecordId} onSelect={setSelectedRecordId} onOpen={openSource} onCollect={setCollectingRecord} canOpen={!!onOpenDocument} />
          : !visible.nodes.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={datasetIds.length ? '当前字段与筛选条件下没有实体' : '尚未选择材料集'} /> : view === 'network' ? (
            <KnowledgeGraphCanvas graph={visible} selectedId={selectedId} pathIds={path} onSelect={setSelectedId}
              onFocus={(id) => { setFocusId(id); setPathTarget(undefined); setSelectedId(id) }}
              onPathTarget={setPathTarget} canSetPathTarget={!!focusId} />
          ) : <KnowledgeGraphTables key={view} graph={visible} records={data.records} view={view}
            selectedId={selectedId} onSelect={setSelectedId} onExplore={(id) => {
              setFocusId(id); setPathTarget(undefined); setSelectedId(id); setView('network')
            }} />}
          {edgeKind === 'relation' && visible.nodes.length > 0 && visible.edges.length === 0 && <Alert type="info" showIcon message="尚无符合关系定义的记录"
            action={<Button size="small" onClick={() => setSettingsOpen(true)}>关系定义</Button>} />}
        </main>
        <aside className="knowledge-evidence">
          <div className="knowledge-evidence-heading"><Typography.Text strong>
            {view === 'evidence' ? '原文与考证' : selected && 'label' in selected ? selected.label : '考察对象与出处'}
          </Typography.Text><Tag>{view === 'evidence' || resolvedEdgeKind === 'relation' ? '材料陈述 · 待考证' : '关联候选 · 非事实判定'}</Tag></div>
          {selected && <Space wrap className="knowledge-evidence-actions">
            <Typography.Text type="secondary">{selectedRecords.length} 条材料 · {independentDocuments(selected.recordIds)} 部文献</Typography.Text>
            <Button size="small" icon={<RobotOutlined />} disabled={!onOpenLibraryAi || !selectedRecords.some((record) => record.doc_id)}
              onClick={() => startAi(true)}>考证此对象</Button>
          </Space>}
          {(view === 'evidence' ? selectedRecords.length > 0 : selected) ? <List size="small" dataSource={selectedRecords} pagination={{ pageSize: 5, size: 'small', simple: true }}
            renderItem={(record) => <List.Item key={record.id}><div className="knowledge-evidence-record">
              <Space wrap size={4}><Typography.Text strong>{record.doc_title || '原文'}</Typography.Text>
                <Tag>{record.page_num ? `第 ${record.page_num} 页` : '页码未知'}</Tag><Tag color={record.status === 'confirmed' ? 'green' : record.status === 'excluded' ? undefined : 'gold'}>{record.status === 'confirmed' ? '记录已确认' : record.status === 'excluded' ? '已排除' : '待核验'}</Tag></Space>
              <Typography.Paragraph ellipsis={{ rows: 6, expandable: true, symbol: '展开' }}>{record.excerpt || '无原文摘录'}</Typography.Paragraph>
              <Typography.Paragraph type="secondary">{evidenceFieldText(record, data.datasets)}</Typography.Paragraph>
              {record.note && <Typography.Paragraph type="secondary">{record.note}</Typography.Paragraph>}
              <Space wrap size={4}>
                <Button size="small" icon={<FileSearchOutlined />} disabled={!onOpenDocument || !record.doc_id} onClick={() => openSource(record)}>原文</Button>
                <Button size="small" icon={<SaveOutlined />} disabled={record.status === 'excluded' || !record.doc_id || !record.excerpt} onClick={() => setCollectingRecord(record)}>存入专题</Button>
                <Tooltip title="考证修订"><Button size="small" aria-label="考证修订" icon={<EditOutlined />} onClick={() => {
                  setEditingRecord(record); form.resetFields(); form.setFieldsValue({ values: researchRecordValues(record), note: record.note })
                }} /></Tooltip>
                <Tooltip title={record.status === 'confirmed' ? '退回待核验' : '确认记录'}>
                  <Button size="small" aria-label={record.status === 'confirmed' ? '退回待核验' : '确认记录'} loading={saving} icon={<CheckOutlined />}
                    onClick={() => void updateRecord(record, record.status === 'confirmed' ? 'pending' : 'confirmed')} /></Tooltip>
                <Tooltip title="排除记录"><Button size="small" aria-label="排除记录" danger disabled={saving} icon={<CloseOutlined />}
                  onClick={() => Modal.confirm({ title: '排除这条图谱材料？', content: '原始材料保留，记录不再参与图谱计算。', onOk: () => updateRecord(record, 'excluded') })} /></Tooltip>
              </Space>
            </div></List.Item>} /> : view === 'evidence' ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未选择核验材料" /> : <List size="small" dataSource={visible.nodes} pagination={{ pageSize: 12, size: 'small', simple: true }}
              renderItem={(node) => <List.Item key={node.id}><button className="knowledge-node-button" type="button" onClick={() => setSelectedId(node.id)}>
                <i className="knowledge-swatch" style={{ background: GRAPH_KIND_COLORS[node.kind] }} /><span>{node.label}</span><small>{node.recordIds.length}</small>
              </button></List.Item>} />}
        </aside>
      </div>
    </Spin>
    <CollectResearchEvidence record={collectingRecord} datasets={data.datasets} projects={projects} projectId={topicId} question={topicQuestion} onClose={() => setCollectingRecord(undefined)} />
    <Modal title={editingTopicId ? '编辑研究专题' : '新建研究专题'} open={topicModal} onCancel={() => { if (!topicSaving) setTopicModal(false) }} onOk={() => void saveTopic()} confirmLoading={topicSaving}>
      {topicError && <Alert type="error" showIcon message={topicError} />}
      <Form form={topicForm} layout="vertical">
        <Form.Item name="name" label="专题名称" rules={[{ required: true, whitespace: true, message: '请输入专题名称' }]}><Input maxLength={200} /></Form.Item>
        <Form.Item name="description" label="研究问题 / 专题说明"><Input.TextArea rows={4} maxLength={20000} /></Form.Item>
      </Form>
    </Modal>
    <ResearchTaskHistory open={historyOpen} onClose={() => setHistoryOpen(false)} onResult={async (id) => {
      if (scopeBusy) { message.info('请等待当前操作完成后再切换分析结果'); return }
      try {
        const items = await window.api.listAiResearchDatasets()
        const source = items.find((item) => item.id === id)
        if (!source) { message.error('这份分析结果已不存在'); return }
        const projectId = source.project_id || undefined
        if (projectId !== topicId) setQuestionDocuments(undefined)
        setTopicId(projectId); setTopicQuestion(projects.find((project) => project.id === projectId)?.description || '')
        pendingResearchTopic.current = undefined
        setDatasetIds([id]); setMode('browse'); setRevision((value) => value + 1)
      } catch (reason: unknown) { message.error(getErrorMessage(reason, '打开分析结果失败')) }
    }} />
    <Drawer title="字段与关系定义" width={520} open={settingsOpen} onClose={() => setSettingsOpen(false)}>
      {data.datasets.map((dataset) => {
        const fields = getResearchDatasetFields(dataset, data.records.filter((record) => record.dataset_id === dataset.id))
        const config = effectiveConfigs[dataset.id]
        const options = fields.map((field) => ({ value: field.key, label: field.label || field.key }))
        return <section className="knowledge-schema" key={dataset.id}>
          <Typography.Title level={5}>{dataset.name}</Typography.Title>
          {fields.map((field) => <label key={field.key}><span>{field.label || field.key}</span>
            <Select aria-label={`字段 ${field.label || field.key}`} value={config.mapping[field.key] || 'ignore'}
              options={[{ value: 'ignore', label: '不纳入实体' }, ...KINDS]}
              onChange={(value) => changeConfig(dataset.id, { mapping: { ...config.mapping, [field.key]: value } })} /></label>)}
          <Typography.Title level={5}>有向关系</Typography.Title>
          <label>主体字段<Select allowClear aria-label="主体字段" value={config.sourceField} options={options} onChange={(sourceField) => changeConfig(dataset.id, { sourceField })} /></label>
          <label>关系字段<Select allowClear aria-label="关系字段" value={config.relationField} options={options} onChange={(relationField) => changeConfig(dataset.id, { relationField })} /></label>
          <label>客体字段<Select allowClear aria-label="客体字段" value={config.targetField} options={options} onChange={(targetField) => changeConfig(dataset.id, { targetField })} /></label>
        </section>
      })}
    </Drawer>
    <Modal title="考证修订" open={!!editingRecord} onCancel={() => setEditingRecord(undefined)} onOk={() => void saveEdit()} confirmLoading={saving}>
      <Form form={form} layout="vertical">
        {editingRecord && Object.keys(researchRecordValues(editingRecord)).map((key) => <Form.Item key={key} name={['values', key]} label={key}><Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} /></Form.Item>)}
        <Form.Item name="note" label="考证备注"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>
    <Modal
      title="选择要分析的文献"
      open={analysisPickerOpen}
      width={760}
      onCancel={() => { if (!analysisSubmitLock.current) setAnalysisPickerOpen(false) }}
      onOk={submitAnalysisSelection}
      okText={`${analysisPurpose === 'question' ? '使用所选文献' : '开始分析'}${analysisSelectedIds.length ? `（${analysisSelectedIds.length} 篇）` : ''}`}
      cancelText="取消"
      confirmLoading={analysisLoading}
      destroyOnClose={false}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div className="knowledge-analysis-filters">
          <Input.Search
            allowClear
            placeholder="搜索题名或作者"
            value={analysisSearch}
            onChange={(event) => setAnalysisSearch(event.target.value)}
          />
          <Select allowClear placeholder="文献类型" value={analysisType} onChange={setAnalysisType}
            options={[...new Set(analysisDocuments.map((doc) => doc.doc_type).filter(Boolean))].map((value) => ({ value, label: value }))} />
          <Select aria-label="筛选文献标签" allowClear showSearch optionFilterProp="label" placeholder="标签" value={analysisTagId} onChange={setAnalysisTagId}
            popupMatchSelectWidth={420} popupClassName="knowledge-analysis-tag-popup" virtual={false}
            labelRender={({ label }) => <Tooltip title={label}><span>{label}</span></Tooltip>}
            options={analysisTags.map((tag) => ({ value: tag.id, label: tag.name }))} />
          <Select allowClear showSearch optionFilterProp="label" placeholder="文件夹（含子文件夹）" value={analysisFolderId} onChange={setAnalysisFolderId}
            options={flatAnalysisFolders.map((folder) => ({ value: folder.id, label: `${'　'.repeat(folder.depth)}${folder.name}` }))} />
        </div>
        {topicId && analysisPurpose === 'question' && <Checkbox checked={addSelectionToTopic} disabled={analysisLoading} onChange={(event) => setAddSelectionToTopic(event.target.checked)}>将所选文献加入当前专题</Checkbox>}
        <Space wrap>
          <Button size="small" onClick={() => setAnalysisSelectedIds(filteredAnalysisDocuments.map((doc) => doc.id))}>全选当前筛选</Button>
          <Button size="small" onClick={() => setAnalysisSelectedIds([])}>清空选择</Button>
          <Typography.Text type="secondary">
            当前显示 {filteredAnalysisDocuments.length} 篇，已选 {analysisSelectedIds.length} 篇。可在下方列表拖拽框选。
          </Typography.Text>
        </Space>
        <div ref={analysisListRef} className="knowledge-analysis-document-list" onMouseDown={analysisDrag.startDragSelect}>
          {analysisLoading ? <Spin /> : filteredAnalysisDocuments.length ? filteredAnalysisDocuments.map((doc) => (
            <label
              key={doc.id}
              data-analysis-select-id={doc.id}
              className={`knowledge-analysis-document ${analysisSelectedIds.includes(doc.id) ? 'is-selected' : ''}`}
            >
              <Checkbox
                checked={analysisSelectedIds.includes(doc.id)}
                onChange={() => setAnalysisSelectedIds((current) => current.includes(doc.id)
                  ? current.filter((id) => id !== doc.id)
                  : [...current, doc.id])}
              />
              <span className="knowledge-analysis-document-main">
                <Typography.Text strong ellipsis={{ tooltip: doc.title || '未命名文献' }}>{doc.title || '未命名文献'}</Typography.Text>
                <Typography.Text type="secondary">{[doc.author, doc.doc_type].filter(Boolean).join(' · ') || '未填写元数据'}</Typography.Text>
              </span>
              <Tag>{doc.embedding_status === 'ready' ? '已向量化' : '未向量化'}</Tag>
            </label>
          )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合当前筛选条件的文献" />}
        </div>
      </Space>
    </Modal>
  </div>
  </div>
}
