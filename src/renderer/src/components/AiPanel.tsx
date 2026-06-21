import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Collapse,
  Dropdown,
  Empty,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Tabs,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  BookOutlined,
  BulbOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  HistoryOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  SendOutlined,
  TagOutlined,
} from '@ant-design/icons'
import type { AiChatSession, AiChatTurn, AiQuestionResponse, AiResearchDataset, AiResearchEvidencePack, AiResearchPlan, AiResearchRecord, AiResearchRetrievalStats, AiResearchTask, AiStreamEvent, AiSynthesisResult, AiSynthesisTemplate, AiTaskType, LibraryAiScope, LibraryAiScopePreview, LibraryAiTab, OpenDocumentTarget, ResearchProject, SearchHit, SearchHitLocator } from '@shared/types'
import type { EvidenceQaCluster, EvidenceQaPlan, EvidenceQaSource } from '@shared/types'
import AiMarkdown, { sourceToTarget } from './AiMarkdown'
import LlmProfileSelector from './LlmProfileSelector'
import { getErrorMessage } from '@shared/errors'
import { resolveDocumentCitation } from '../utils/citations'

const { Paragraph, Text } = Typography
const { TextArea } = Input

type AiPanelMode = 'document' | 'library'
type DocumentTaskType = Extract<AiTaskType, 'summary' | 'keywords' | 'qa'>
type ScopeType = 'all' | 'tags' | 'folders' | 'documents'
type ResearchRunOptions = {
  goalOverride?: string
  planOverride?: AiResearchPlan | null
  autoGenerateReport?: boolean
  quiet?: boolean
}

interface AiHistoryItem {
  id: string
  prompt: string
  result: string
  created_at: string
  task_type: AiTaskType
  sources?: EvidenceQaSource[]
  plan?: EvidenceQaPlan
  expandedQueries?: string[]
  evidenceClusters?: EvidenceQaCluster[]
  warnings?: string[]
  streaming?: boolean
  phase?: string
}

interface AiPanelProps {
  mode: AiPanelMode
  documentId?: string
  documentTitle?: string
  documentText?: string
  initialQuestion?: string
  initialScope?: LibraryAiScope
  initialScopeLabel?: string
  initialTab?: LibraryAiTab
  initialResearchProjectId?: string | null
  selectedText?: string
  onOpenDocument?: (target: OpenDocumentTarget) => void
}

const SUMMARY_OPTIONS = [
  { value: '100字以内', label: '简短' },
  { value: '200字左右', label: '适中' },
  { value: '500字左右', label: '详细' }
]

const ANALYSIS_TEMPLATES = [
  { value: 'literature_review', label: '研究脉络', desc: '综合归纳当前范围内的研究脉络、主要趋势、分歧与研究空白。' },
  { value: 'theme_analysis', label: '比较观点', desc: '比较主要观点的共识、分歧、证据强弱与代表性来源。' },
  { value: 'timeline', label: '阶段梳理', desc: '按时间、阶段或制度变化整理材料，并说明变化逻辑。' },
  { value: 'evidence_table', label: '证据表格', desc: '按观点、时间、机构、政策、教育内容整理证据，每格带页码来源。' },
  { value: 'summary', label: '综合摘要', desc: '生成跨文献综合摘要，避免逐篇复述。' },
  { value: 'custom', label: '自定义分析', desc: '按你的提示词生成定制化分析。' }
] as const

const AI_RESEARCH_UI_NOISE_TERMS = new Set([
  'td', 'tr', 'th', 'div', 'span', 'table', 'tbody', 'thead', 'style', 'class', 'border', 'center',
  'align', 'valign', 'width', 'height', 'word', 'wrap', 'break', 'word-wrap', 'text-align', 'left',
  'right', 'font', 'size', 'color', 'margin', 'padding', 'nbsp', 'html', 'body', 'cellspacing',
  'cellpadding', 'colspan', 'rowspan', 'solid', 'none', 'block', 'inline', 'auto', 'breakword',
  'wordwrap', 'textalign', '本满', '洲中', '国朝',
])

const AI_RESEARCH_UI_TASK_WORDS = [
  '同时出现', '出现次数', '出现频率', '出现篇幅', '提及次数', '提及频率', '关键词', '不同文献',
  '出现分布', '时间变化', '变化趋势', '相关篇幅', '相关时间', '相关地点', '有多少', '分别有多少',
  '统计', '比较', '提及', '谈到', '提到', '涉及', '查找', '寻找', '列举', '出现', '分布',
  '趋势', '变化', '篇幅', '频率', '次数', '数量', '段落', '章节', '页面', '如何', '多少',
]

function trimAiResearchQueryParticles(value: string): string {
  return value.trim().replace(/[的了着过和与及或在对中内为是有把将]+$/g, '').trim()
}

function isAiResearchNoiseTerm(value: string): boolean {
  const lower = value.trim().toLowerCase()
  const compact = lower.replace(/[^a-z0-9]/g, '')
  return AI_RESEARCH_UI_NOISE_TERMS.has(lower) || AI_RESEARCH_UI_NOISE_TERMS.has(compact)
}

function isReadableAiResearchQuery(value: string): boolean {
  const query = trimAiResearchQueryParticles(value)
  const lower = query.toLowerCase()
  if (!query || isAiResearchNoiseTerm(lower)) return false
  if (/[?？!！。；;:：()[\]{}"'“”‘’《》<>/\\]/.test(query)) return false
  if (/^\d+$/.test(query) || /^[\u4e00-\u9fff]$/.test(query)) return false
  const parts = query.split(/\s+/).filter(Boolean)
  if (parts.length > 1) return parts.length <= 4 && parts.every((part) => isReadableAiResearchQuery(part))
  if (/^[\u4e00-\u9fff]{2,6}$/.test(query)) {
    return !AI_RESEARCH_UI_TASK_WORDS.some((word) => query.includes(word))
  }
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{1,40}$/.test(query)) return !isAiResearchNoiseTerm(lower)
  return false
}

function isResearchExtractionPrompt(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  return /(?:数据抽取|抽取|提取|抓取|统计|有多少|多少(?:篇|页|次|段|条|份)|出现(?:次数|频率|分布)|提及(?:次数|频率|分布)|篇幅|归类|分类|时空|时间线|证据表|数据集|字段|表格|规律总结)/.test(text)
}

function emitResearchWorkspaceUpdated(projectId?: string | null) {
  if (!projectId) return
  window.dispatchEvent(new CustomEvent('gujismart:research-workspace-updated', { detail: { projectId } }))
}

function normalizeScope(scope?: LibraryAiScope): LibraryAiScope {
  if (!scope || scope.type === 'all') return { type: 'all' }
  if (scope.type === 'tags') return { type: 'tags', tagIds: [...new Set(scope.tagIds.filter(Boolean))] }
  if (scope.type === 'folders') return { type: 'folders', folderIds: [...new Set(scope.folderIds.filter(Boolean))] }
  return { type: 'documents', docIds: [...new Set(scope.docIds.filter(Boolean))] }
}

function getTaskLabel(taskType: AiTaskType): string {
  switch (taskType) {
    case 'summary':
      return '内容摘要'
    case 'translate':
      return '翻译'
    case 'keywords':
      return '关键词提取'
    case 'qa':
      return '文献问答'
    default:
      return 'AI 分析'
  }
}

function getScopeType(scope: LibraryAiScope): ScopeType {
  return scope.type
}

function buildScopeLabel(
  scope: LibraryAiScope,
  tagOptions: Array<{ value: string; label: string }>,
  folderOptions: Array<{ value: string; label: string }>,
  documentOptions: Array<{ value: string; label: string }>
): string {
  if (scope.type === 'all') return '全库'

  const lookup = (values: string[], options: Array<{ value: string; label: string }>, prefix: string) => {
    const names = values
      .map((value) => options.find((item) => item.value === value)?.label)
      .filter(Boolean)
    return names.length > 0 ? `${prefix} / ${names.join('、')}` : prefix
  }

  if (scope.type === 'tags') return lookup(scope.tagIds, tagOptions, '标签')
  if (scope.type === 'folders') return lookup(scope.folderIds, folderOptions, '文件夹')
  return lookup(scope.docIds, documentOptions, '论文')
}

function uniqueStringIds(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isChatAskResponse(value: unknown): value is AiQuestionResponse {
  return isRecord(value) && typeof value.answer === 'string'
}

function isEvidenceQaPlan(value: unknown): value is EvidenceQaPlan {
  return isRecord(value)
    && typeof value.intent === 'string'
    && Array.isArray(value.keywords)
    && Array.isArray(value.expandedKeywords)
    && Array.isArray(value.excludeKeywords)
}

function buildSourceSearchSession(sources: AiHistoryItem['sources'], clickedIndex: number, prompt: string) {
  const clicked = sources?.[clickedIndex]
  if (!clicked) return undefined
  const sameDocSources = (sources || []).filter((source) => source.doc_id === clicked.doc_id)
  const hits: SearchHit[] = sameDocSources.map((source, index) => {
    const pageNum = Number(source.page_num || source.locator?.pageNum || 1)
    const locator: SearchHitLocator = source.locator || {
      docId: source.doc_id,
      segmentId: `${source.doc_id}:ai:${pageNum}:${index}`,
      pageId: null,
      pageNum,
      pageIndex: Math.max(0, pageNum - 1),
      href: null,
      segmentOrdinal: pageNum - 1,
      charStart: 0,
      charEnd: 0,
      matchText: source.matched_query || prompt,
      queryTerm: source.matched_query || prompt,
      occurrenceIndex: index,
    }
    return {
      id: `${locator.segmentId}:${locator.occurrenceIndex}:${index}`,
      locator,
      snippet: source.snippet || '',
      score: Number(source.rank || index),
    }
  })
  const activeHitIndex = Math.max(0, sameDocSources.findIndex((source) => source === clicked))
  return {
    query: prompt,
    hits,
    activeHitIndex,
    status: hits.length > 0 ? 'ready' as const : 'empty' as const,
  }
}

function stripSnippetMarkers(value: string): string {
  return String(value || '').replace(/<<|>>/g, '').replace(/\s+/g, ' ').trim()
}

function turnToHistoryItem(turn: AiChatTurn): AiHistoryItem {
  return {
    id: turn.id,
    prompt: turn.prompt,
    result: turn.result,
    created_at: turn.created_at,
    task_type: turn.task_type,
    sources: turn.sources || [],
    plan: turn.plan,
    expandedQueries: turn.expandedQueries || [],
    evidenceClusters: turn.evidenceClusters || [],
    warnings: turn.warnings || [],
  }
}

function responseToHistoryItem(prompt: string, payload: AiQuestionResponse, taskType: AiTaskType): AiHistoryItem {
  if (payload.turn) return turnToHistoryItem(payload.turn)
  return {
    id: `${Date.now()}`,
    prompt,
    result: payload.answer,
    created_at: new Date().toISOString(),
    task_type: taskType,
    sources: payload.sources || [],
    plan: payload.plan,
    expandedQueries: payload.expandedQueries || [],
    evidenceClusters: payload.evidenceClusters || [],
    warnings: payload.warnings || [],
  }
}

function mergeStreamMetadata(item: AiHistoryItem, payload: unknown): AiHistoryItem {
  if (!isRecord(payload)) return item
  return {
    ...item,
    sources: Array.isArray(payload.sources) ? payload.sources as EvidenceQaSource[] : item.sources || [],
    plan: isEvidenceQaPlan(payload.plan) ? payload.plan : item.plan,
    expandedQueries: Array.isArray(payload.expandedQueries) ? payload.expandedQueries.map(String).filter(Boolean) : item.expandedQueries || [],
    evidenceClusters: Array.isArray(payload.evidenceClusters) ? payload.evidenceClusters as EvidenceQaCluster[] : item.evidenceClusters || [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String).filter(Boolean) : item.warnings || [],
  }
}

function getChatTurnCount(session?: AiChatSession, history: AiHistoryItem[] = []): number {
  return Math.max(
    Number(session?.message_count || 0),
    history.filter((item) => !item.streaming).length,
  )
}

function getVisibleChatSessions(sessions: AiChatSession[], keepSessionId = ''): AiChatSession[] {
  return sessions.filter((session) => Number(session.message_count || 0) > 0 || (!!keepSessionId && session.id === keepSessionId))
}

interface AiTurnProps {
  item: AiHistoryItem
  onOpenDocument?: (target: OpenDocumentTarget) => void
  onSaveAiSourceAsNote: (item: AiHistoryItem, source: EvidenceQaSource) => void
  renderEvidenceProcess: (item: AiHistoryItem) => JSX.Element | null
}

const AiTurn = memo(function AiTurn({ item, onOpenDocument, onSaveAiSourceAsNote, renderEvidenceProcess }: AiTurnProps) {
  return (
    <div className="ai-turn" style={{ marginBottom: 18 }}>
      <div className="chat-bubble-container user">
        <div className="chat-bubble">{item.prompt}</div>
      </div>

      <div className="chat-bubble-container ai">
        <div className="chat-avatar">
          <RobotOutlined />
        </div>
        <div className="chat-bubble" style={{ width: '100%' }}>
          {item.phase && item.streaming ? <div className="ai-stream-phase">{item.phase}</div> : null}
          <AiMarkdown content={item.result} sources={item.sources || []} prompt={item.prompt} onOpenDocument={onOpenDocument} />
          {Array.isArray(item.sources) && item.sources.length > 0 ? (
            <div className="ai-source-list">
              {item.sources.slice(0, 8).map((source, index) => (
                <Tooltip
                  key={`${item.id}-cite-${source.doc_id}-${source.page_num}-${index}`}
                  title={stripSnippetMarkers(source.snippet || '') || source.doc_title}
                >
                  <Button
                    className="ai-source-chip"
                    size="small"
                    onClick={() => onOpenDocument?.(sourceToTarget(source, item.sources, index, item.prompt))}
                  >
                    [{index + 1}] {source.doc_title || '原文'} · {source.page_num || '?'}页
                  </Button>
                </Tooltip>
              ))}
            </div>
          ) : null}
          {renderEvidenceProcess(item)}

          {Array.isArray(item.sources) && item.sources.length > 0 ? (
            <Collapse
              ghost
              size="small"
              style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}
              items={[
                {
                  key: 'sources',
                  label: `来源（${item.sources.length} 条）`,
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {item.sources.slice(0, 6).map((source, index) => (
                        <div
                          key={`${item.id}-${source.doc_id}-${source.page_num}-${index}`}
                          style={{
                            textAlign: 'left',
                            border: '1px solid rgba(255,255,255,0.08)',
                            background: 'rgba(255,255,255,0.03)',
                            color: 'inherit',
                            padding: 10,
                            borderRadius: 8,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              onClick={() => onOpenDocument?.(sourceToTarget(source, item.sources, index, item.prompt))}
                              style={{
                                border: 0,
                                background: 'transparent',
                                color: 'var(--gs-text-primary)',
                                cursor: onOpenDocument ? 'pointer' : 'default',
                                padding: 0,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 8,
                                fontWeight: 600,
                              }}
                            >
                              <BookOutlined style={{ color: 'var(--gs-gold)' }} />
                              <span>{source.doc_title}</span>
                            </button>
                            <Tag color="blue" style={{ margin: 0 }}>第 {source.page_num || '?'} 页</Tag>
                            {source.matched_query ? <Tag style={{ margin: 0 }}>{source.matched_query}</Tag> : null}
                            <Button size="small" type="link" onClick={() => onSaveAiSourceAsNote(item, source)}>
                              保存摘录
                            </Button>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)', lineHeight: 1.6 }}>
                            {source.snippet}
                          </div>
                        </div>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          ) : null}

          <div className="chat-timestamp">
            {new Date(item.created_at).toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  )
})

export default function AiPanel({
  mode,
  documentId,
  documentTitle,
  documentText = '',
  initialQuestion = '',
  initialScope,
  initialScopeLabel,
  initialTab = 'qa',
  initialResearchProjectId = null,
  selectedText = '',
  onOpenDocument
}: AiPanelProps) {
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<AiHistoryItem[]>([])
  const [question, setQuestion] = useState(initialQuestion)
  const [summaryLength, setSummaryLength] = useState('200字左右')
  const [scope, setScope] = useState<LibraryAiScope>(normalizeScope(initialScope))
  const [scopeLabelOverride, setScopeLabelOverride] = useState(initialScopeLabel || '')
  const [scopePreview, setScopePreview] = useState<LibraryAiScopePreview | null>(null)
  const [scopeListOpen, setScopeListOpen] = useState(false)
  const [scopePopoverOpen, setScopePopoverOpen] = useState(false)
  const [scopeListLoading, setScopeListLoading] = useState(false)
  const [scopeListDocuments, setScopeListDocuments] = useState<Array<{ id: string; title: string }>>([])
  const [tagOptions, setTagOptions] = useState<Array<{ value: string; label: string }>>([])
  const [folderOptions, setFolderOptions] = useState<Array<{ value: string; label: string }>>([])
  const [documentOptions, setDocumentOptions] = useState<Array<{ value: string; label: string }>>([])
  const [activeTab, setActiveTab] = useState<LibraryAiTab>(initialTab)
  const [analysisTemplate, setAnalysisTemplate] = useState<AiSynthesisTemplate>('literature_review')
  const [analysisPrompt, setAnalysisPrompt] = useState('')
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisResult, setAnalysisResult] = useState('')
  const [analysisSources, setAnalysisSources] = useState<EvidenceQaSource[]>([])
  const [researchGoal, setResearchGoal] = useState('')
  const [researchPlan, setResearchPlan] = useState<AiResearchPlan | null>(null)
  const [researchTask, setResearchTask] = useState<AiResearchTask | null>(null)
  const [researchDataset, setResearchDataset] = useState<AiResearchDataset | null>(null)
  const [researchRecords, setResearchRecords] = useState<AiResearchRecord[]>([])
  const [researchRetrievalStats, setResearchRetrievalStats] = useState<AiResearchRetrievalStats | null>(null)
  const [researchEvidencePack, setResearchEvidencePack] = useState<AiResearchEvidencePack | null>(null)
  const [researchReport, setResearchReport] = useState('')
  const [researchPlanning, setResearchPlanning] = useState(false)
  const [researchPreviewLoading, setResearchPreviewLoading] = useState(false)
  const [researchRunning, setResearchRunning] = useState(false)
  const [researchReportLoading, setResearchReportLoading] = useState(false)
  const [researchProjects, setResearchProjects] = useState<ResearchProject[]>([])
  const [researchProjectId, setResearchProjectId] = useState<string | null>(initialResearchProjectId)
  const [chatSessions, setChatSessions] = useState<AiChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [sessionLoading, setSessionLoading] = useState(false)
  const [hasOlderTurns, setHasOlderTurns] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeStreamsRef = useRef<Record<string, string>>({})

  useEffect(() => {
    setQuestion(initialQuestion)
  }, [initialQuestion])

  useEffect(() => {
    setScope(normalizeScope(initialScope))
  }, [initialScope])

  useEffect(() => {
    setScopeLabelOverride(initialScopeLabel || '')
  }, [initialScopeLabel])

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    setResearchProjectId(initialResearchProjectId || null)
  }, [initialResearchProjectId])

  useEffect(() => {
    const loadSessions = async () => {
      setSessionLoading(true)
      try {
        const rawSessions = await window.api.listAiChatSessions({ mode, docId: mode === 'document' ? documentId || null : null })
        const sessions = getVisibleChatSessions(rawSessions)
        const nextSessionId = sessions[0]?.id || ''
        setChatSessions(sessions)
        setActiveSessionId(nextSessionId)
        if (nextSessionId) {
          const turns = await window.api.getAiChatTurns(nextSessionId)
          setHistory(turns.map(turnToHistoryItem))
          setHasOlderTurns(turns.length >= 30)
        } else if (mode === 'document' && documentId) {
          const legacyResults = await window.api.getAiResults(documentId)
          setHistory(legacyResults)
          setHasOlderTurns(false)
        } else {
          setHistory([])
          setHasOlderTurns(false)
        }
      } catch (error) {
        console.error(error)
        if (mode === 'document' && documentId) {
          try {
            const legacyResults = await window.api.getAiResults(documentId)
            setHistory(legacyResults)
            setChatSessions([])
            setActiveSessionId('')
            return
          } catch (legacyError) {
            console.error(legacyError)
          }
        }
        message.error(`加载 AI 对话历史失败：${(error as Error)?.message || '请重启软件后重试'}`)
        setChatSessions([])
        setActiveSessionId('')
        setHistory([])
        setHasOlderTurns(false)
      } finally {
        setSessionLoading(false)
      }
    }

    if (mode === 'document' && !documentId) {
      setChatSessions([])
      setActiveSessionId('')
      setHistory([])
      return
    }

    void loadSessions()
  }, [documentId, mode])

  useEffect(() => {
    if (mode !== 'library') return

    const loadScopeOptions = async () => {
      try {
        const [tags, folders, documents, projects] = await Promise.all([
          window.api.listTags(),
          window.api.listFolders(),
          window.api.listDocuments({ limit: 1000 }),
          window.api.listResearchProjects()
        ])

        setTagOptions(tags.map((item) => ({ value: item.id, label: item.name })))
        setFolderOptions(folders.map((item) => ({ value: item.id, label: item.name })))
        setDocumentOptions(documents.map((item) => ({ value: item.id, label: item.title || '未命名文献' })))
        setResearchProjects(projects)
      } catch (error) {
        console.error(error)
        message.error('加载范围选项失败')
      }
    }

    void loadScopeOptions()
  }, [mode])

  useEffect(() => {
    if (mode !== 'document') return
    window.api.listResearchProjects()
      .then(setResearchProjects)
      .catch((error) => console.warn('Failed to load research projects for AI research task', error))
  }, [mode])

  useEffect(() => {
    if (mode !== 'library') return

    const loadPreview = async () => {
      try {
        const preview = await window.api.previewAiScope(scope)
        setScopePreview(preview)
      } catch (error) {
        console.error(error)
        setScopePreview(null)
      }
    }

    void loadPreview()
  }, [mode, scope])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [history, loading])

  useEffect(() => {
    return window.api.onAiStreamEvent((event: AiStreamEvent) => {
      const itemId = activeStreamsRef.current[event.requestId]
      if (!itemId) return
      if (event.type === 'phase') {
        setHistory((items) => items.map((item) => item.id === itemId ? { ...item, phase: String(event.payload || '') } : item))
        return
      }
      if (event.type === 'sources') {
        setHistory((items) => items.map((item) => item.id === itemId ? mergeStreamMetadata(item, event.payload) : item))
        return
      }
      if (event.type === 'delta') {
        setHistory((items) => items.map((item) => item.id === itemId ? { ...item, result: `${item.result || ''}${String(event.payload || '')}` } : item))
        return
      }
      if (event.type === 'done') {
        delete activeStreamsRef.current[event.requestId]
        if (!isChatAskResponse(event.payload)) {
          const errorText = 'AI 生成失败'
          setHistory((items) => items.map((item) => item.id === itemId ? {
            ...item,
            result: item.result || `生成失败：${errorText}`,
            streaming: false,
            phase: '生成失败',
          } : item))
          message.error(errorText)
          setLoading(false)
          return
        }
        const payload = event.payload
        setHistory((items) => items.map((item) => item.id === itemId ? {
          ...mergeStreamMetadata(item, payload),
          id: payload.turn?.id || item.id,
          result: payload.answer || item.result,
          created_at: payload.turn?.created_at || item.created_at,
          task_type: payload.turn?.task_type || item.task_type,
          streaming: false,
          phase: '',
        } : item))
        if (payload.session?.id) {
          setActiveSessionId(payload.session.id)
          void reloadChatSessions(payload.session.id)
        }
        setLoading(false)
        return
      }
      if (event.type === 'error') {
        delete activeStreamsRef.current[event.requestId]
        const errorText = String(event.payload || 'AI 生成失败')
        setHistory((items) => items.map((item) => item.id === itemId ? {
          ...item,
          result: item.result || `生成失败：${errorText}`,
          streaming: false,
          phase: '生成失败',
        } : item))
        message.error(errorText)
        setLoading(false)
      }
    })
  }, [])

  const hasDocumentText = mode === 'document' ? Boolean(documentId) : documentText.trim().length > 0
  const scopeType = getScopeType(scope)
  const computedScopeLabel = useMemo(
    () => buildScopeLabel(scope, tagOptions, folderOptions, documentOptions),
    [scope, tagOptions, folderOptions, documentOptions]
  )
  const scopeLabel = scopeLabelOverride || computedScopeLabel

  const reloadChatSessions = async (preferredSessionId?: string) => {
    const rawSessions = await window.api.listAiChatSessions({ mode, docId: mode === 'document' ? documentId || null : null })
    const sessions = getVisibleChatSessions(rawSessions, preferredSessionId || activeSessionId)
    setChatSessions(sessions)
    const candidateSessionId = preferredSessionId || activeSessionId
    const nextSessionId = candidateSessionId && sessions.some((session) => session.id === candidateSessionId)
      ? candidateSessionId
      : sessions[0]?.id || ''
    if (!nextSessionId) {
      setActiveSessionId('')
      setHistory([])
      setHasOlderTurns(false)
      return
    }
    setActiveSessionId(nextSessionId)
    const turns = await window.api.getAiChatTurns(nextSessionId)
    setHistory(turns.map(turnToHistoryItem))
    setHasOlderTurns(turns.length >= 30)
  }

  const loadOlderTurns = async () => {
    if (!activeSessionId || !history[0]) return
    try {
      setSessionLoading(true)
      const older = await window.api.getAiChatTurnsPage(activeSessionId, history[0].created_at, 30)
      setHistory((current) => [...older.map(turnToHistoryItem), ...current])
      setHasOlderTurns(older.length >= 30)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '加载更早对话失败'))
    } finally {
      setSessionLoading(false)
    }
  }

  const createNewChatSession = async () => {
    try {
      setSessionLoading(true)
      const session = await window.api.createAiChatSession({
        mode,
        docId: mode === 'document' ? documentId || null : null,
        title: mode === 'document' ? '文献对话' : '全库对话',
        scope: mode === 'library' ? scope : undefined,
      })
      await reloadChatSessions(session.id)
      setQuestion('')
      message.success('已新建 AI 对话')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '新建 AI 对话失败'))
    } finally {
      setSessionLoading(false)
    }
  }

  const switchChatSession = async (sessionId: string) => {
    try {
      setSessionLoading(true)
      setActiveSessionId(sessionId)
      const turns = await window.api.getAiChatTurns(sessionId)
      setHistory(turns.map(turnToHistoryItem))
      setHasOlderTurns(turns.length >= 30)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '切换 AI 对话失败'))
    } finally {
      setSessionLoading(false)
    }
  }

  const deleteCurrentChatSession = async () => {
    if (!activeSessionId) return
    try {
      setSessionLoading(true)
      await window.api.deleteAiChatSession(activeSessionId)
      const rawSessions = await window.api.listAiChatSessions({ mode, docId: mode === 'document' ? documentId || null : null })
      const sessions = getVisibleChatSessions(rawSessions)
      setChatSessions(sessions)
      const nextSessionId = sessions[0]?.id || ''
      setActiveSessionId(nextSessionId)
      if (nextSessionId) {
        const turns = await window.api.getAiChatTurns(nextSessionId)
        setHistory(turns.map(turnToHistoryItem))
        setHasOlderTurns(turns.length >= 30)
      } else {
        setHistory([])
        setHasOlderTurns(false)
      }
      message.success('已删除当前 AI 对话')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '删除 AI 对话失败'))
    } finally {
      setSessionLoading(false)
    }
  }

  const runDocumentTask = async (taskType: DocumentTaskType, options?: Record<string, unknown>) => {
    if (!documentId || !hasDocumentText) {
      message.info('当前文献还没有可用文本，请先完成 OCR。')
      return
    }

    setLoading(true)
    try {
      const askedQuestion = String(options?.question || question).trim()
      if (taskType === 'qa') {
        const localId = `pending-${Date.now()}`
        const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`
        activeStreamsRef.current[requestId] = localId
        setHistory((previous) => [...previous, {
          id: localId,
          prompt: askedQuestion,
          result: '',
          created_at: new Date().toISOString(),
          task_type: taskType,
          sources: [],
          streaming: true,
          phase: '检索证据中',
        }])
        setQuestion('')
        await window.api.askDocumentAiStream(documentId, askedQuestion, { limit: 12, sessionId: activeSessionId, requestId })
        return
      }

      const result = await window.api.runAiTask(documentId, taskType, documentText, options)
      setHistory((previous) => [
        ...previous,
        {
          id: `${Date.now()}`,
          prompt: `请帮我生成${getTaskLabel(taskType)}`,
          result,
          created_at: new Date().toISOString(),
          task_type: taskType
        }
      ])
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'AI 处理失败')
      console.error(error)
      setHistory((items) => items.map((item) => item.streaming ? {
        ...item,
        result: item.result || `生成失败：${errorMessage}`,
        streaming: false,
        phase: '生成失败',
      } : item))
      message.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const runLibraryQuestion = async (prompt?: string) => {
    const nextQuestion = (prompt ?? question).trim()
    if (!nextQuestion) {
      message.info('请输入问题')
      return
    }

    setLoading(true)
    try {
      const localId = `pending-${Date.now()}`
      const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`
      activeStreamsRef.current[requestId] = localId
      setHistory((previous) => [...previous, {
        id: localId,
        prompt: nextQuestion,
        result: '',
        created_at: new Date().toISOString(),
        task_type: 'library_qa',
        sources: [],
        streaming: true,
        phase: '检索证据中',
      }])
      setQuestion('')
      await window.api.runScopedLibraryAiStream(nextQuestion, scope, { limit: 12, sessionId: activeSessionId, requestId })
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, '全库 AI 问答失败')
      console.error(error)
      setHistory((items) => items.map((item) => item.streaming ? {
        ...item,
        result: item.result || `生成失败：${errorMessage}`,
        streaming: false,
        phase: '生成失败',
      } : item))
      message.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const saveAiSourceAsNote = async (item: AiHistoryItem, source: EvidenceQaSource) => {
    const excerpt = stripSnippetMarkers(source.snippet)
    if (!source.doc_id || !excerpt) {
      message.info('这条来源没有可保存的摘录')
      return
    }

    const fallbackCitationText = source.doc_title ? `${source.doc_title}${source.page_num ? `，第 ${source.page_num} 页` : ''}` : ''
    let citationText = fallbackCitationText
    try {
      citationText = await resolveDocumentCitation(source.doc_id, { pageNum: source.page_num }) || fallbackCitationText
    } catch (error) {
      console.warn('Failed to generate AI source citation from active style, falling back to simple citation.', error)
    }

    try {
      await window.api.createResearchNote({
        doc_id: source.doc_id,
        page_num: source.page_num || null,
        excerpt,
        note: item.prompt ? `来自 AI 查证：${item.prompt}` : '来自 AI 查证',
        source_type: 'ai',
        kind: 'quote',
        locator: source.locator || null,
        citation_text: citationText,
        source_hash: source.source_hash,
        source_id: JSON.stringify({
          sourceType: 'ai_evidence_qa',
          question: item.prompt,
          matchedQuery: source.matched_query || null,
          locator: source.locator || null,
          citation: citationText || null,
          pageNum: source.page_num || null,
        }),
      })
      message.success('已保存为研究摘录')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存摘录失败'))
    }
  }

  const updateScopeType = (nextType: ScopeType) => {
    setScopeLabelOverride('')
    if (nextType === 'all') {
      setScope({ type: 'all' })
      return
    }
    if (nextType === 'tags') {
      setScope({ type: 'tags', tagIds: [] })
      return
    }
    if (nextType === 'folders') {
      setScope({ type: 'folders', folderIds: [] })
      return
    }
    setScope({ type: 'documents', docIds: [] })
  }

  const resolveScopeDocumentIds = async (): Promise<string[]> => {
    if (scope.type === 'documents') {
      return scope.docIds
    }

    if (scope.type === 'tags') {
      if (scope.tagIds.length === 0) return []
      const docs = await window.api.listDocuments({ tagIds: scope.tagIds, limit: 1000 })
      return uniqueStringIds(docs.map((item) => item.id))
    }

    if (scope.type === 'folders') {
      if (scope.folderIds.length === 0) return []
      const groups = await Promise.all(scope.folderIds.map((folderId) => window.api.listDocuments({ folderId, limit: 1000 })))
      return uniqueStringIds(groups.flat().map((item) => item.id))
    }

    const docs = await window.api.listDocuments({ limit: 1000 })
    return uniqueStringIds(docs.map((item) => item.id))
  }

  const loadScopeListDocuments = async (): Promise<Array<{ id: string; title: string }>> => {
    if (scope.type === 'documents') {
      const previewById = new Map((scopePreview?.documents || []).map((item) => [item.id, item.title]))
      const optionById = new Map(documentOptions.map((item) => [item.value, item.label]))
      const docs = scope.docIds.map((id) => ({
        id,
        title: optionById.get(id) || previewById.get(id) || '未命名文献',
      }))
      if (docs.length > 0) return docs
      return []
    }

    if (scope.type === 'tags') {
      if (scope.tagIds.length === 0) return []
      const docs = await window.api.listDocuments({ tagIds: scope.tagIds, limit: 1000 })
      return docs.map((item) => ({ id: item.id, title: item.title || '未命名文献' }))
    }

    if (scope.type === 'folders') {
      if (scope.folderIds.length === 0) return []
      const groups = await Promise.all(scope.folderIds.map((folderId) => window.api.listDocuments({ folderId, limit: 1000 })))
      const byId = new Map<string, { id: string; title: string }>()
      groups.flat().forEach((item) => {
        if (item.id && !byId.has(item.id)) byId.set(item.id, { id: item.id, title: item.title || '未命名文献' })
      })
      return [...byId.values()]
    }

    const docs = await window.api.listDocuments({ limit: 1000 })
    return docs.map((item) => ({ id: item.id, title: item.title || '未命名文献' }))
  }

  const openScopeList = async () => {
    setScopePopoverOpen(false)
    setScopeListOpen(true)
    setScopeListLoading(true)
    try {
      setScopeListDocuments(await loadScopeListDocuments())
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '加载文献列表失败'))
    } finally {
      setScopeListLoading(false)
    }
  }

  const runScopeAnalysis = async () => {
    if (analysisTemplate === 'custom' && !analysisPrompt.trim()) {
      message.info('请输入自定义分析要求')
      return
    }

    setAnalysisLoading(true)
    try {
      const docIds = await resolveScopeDocumentIds()
      if (docIds.length === 0) {
        message.info('当前范围内没有可分析的文献')
        return
      }

      const result = await window.api.synthesizeDocuments(
        docIds,
        analysisTemplate,
        analysisTemplate === 'custom' ? analysisPrompt.trim() : undefined
      ) as AiSynthesisResult | string
      const markdown = typeof result === 'string' ? result : result.markdown
      setAnalysisResult(markdown)
      setAnalysisSources(typeof result === 'string' ? [] : result.sources || [])
      if (researchProjectId && markdown.trim()) {
        const templateLabel = ANALYSIS_TEMPLATES.find((item) => item.value === analysisTemplate)?.label || 'AI 分析'
        await window.api.createResearchOutput({
          project_id: researchProjectId,
          output_type: analysisTemplate,
          title: `${templateLabel} - ${scopeLabel}`,
          content: markdown,
        })
        emitResearchWorkspaceUpdated(researchProjectId)
        message.success('分析结果已保存到研究工作台')
      }
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '专题分析失败'))
    } finally {
      setAnalysisLoading(false)
    }
  }

  const getResearchScope = (): LibraryAiScope => {
    if (mode === 'document' && documentId) return { type: 'documents', docIds: [documentId] }
    return scope
  }

  const planResearchTask = async (goalOverride?: string, options: { quiet?: boolean } = {}): Promise<AiResearchPlan | null> => {
    const goal = (goalOverride || researchGoal || question).trim()
    if (!goal) {
      message.info('请输入研究任务目标')
      return null
    }
    setResearchPlanning(true)
    setResearchReport('')
    try {
      const plan = await window.api.planAiResearchTask({
        goal,
        scope: getResearchScope(),
        projectId: researchProjectId,
      })
      setResearchGoal(goal)
      setResearchPlan(plan)
      setResearchTask(null)
      setResearchDataset(null)
      setResearchRecords([])
      setResearchRetrievalStats(null)
      setResearchEvidencePack(null)
      if (!options.quiet) message.success('已生成结构化抽取方案')
      return plan
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '生成研究任务方案失败'))
      return null
    } finally {
      setResearchPlanning(false)
    }
  }

  const previewResearchRetrieval = async (
    goalOverride?: string,
    planOverride?: AiResearchPlan | null,
    options: { quiet?: boolean } = {},
  ): Promise<AiResearchRetrievalStats | null> => {
    const activePlan = planOverride || researchPlan
    const goal = (goalOverride || researchGoal || activePlan?.goal || question).trim()
    if (!goal) {
      message.info('请输入研究任务目标')
      return null
    }
    setResearchPreviewLoading(true)
    try {
      const stats = await window.api.previewAiResearchRetrieval({
        goal,
        scope: getResearchScope(),
        projectId: researchProjectId,
        fields: activePlan?.fields || [],
        suggestedQueries: activePlan?.suggestedQueries || [goal],
        kind: activePlan?.kind,
      })
      setResearchRetrievalStats(stats)
      setResearchEvidencePack(null)
      if (stats.readableSegmentCount === 0) {
        message.warning('当前范围没有可读取 OCR 正文')
      } else if (stats.totalHitCount === 0) {
        message.warning('当前范围有 OCR 正文，但关键词未命中')
      } else if (!options.quiet) {
        message.success(`已完成本地统计：累计命中 ${stats.totalHitCount} 次，涉及 ${stats.totalDocumentCount} 篇文献`)
      }
      return stats
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '预览检索统计失败'))
      return null
    } finally {
      setResearchPreviewLoading(false)
    }
  }

  const runResearchEndToEnd = async (goalOverride?: string) => {
    const goal = (goalOverride || question || researchGoal).trim()
    if (!goal) {
      message.info('请输入研究任务目标')
      return
    }
    setActiveTab('research')
    setResearchGoal(goal)
    setResearchTask(null)
    setResearchDataset(null)
    setResearchRecords([])
    setResearchReport('')
    setResearchRetrievalStats(null)
    setResearchEvidencePack(null)

    const plan = await planResearchTask(goal, { quiet: true })
    if (!plan) return

    const stats = await previewResearchRetrieval(goal, plan, { quiet: true })
    if (!stats || stats.readableSegmentCount === 0 || stats.totalHitCount === 0) return

    await runResearchTask({
      goalOverride: goal,
      planOverride: plan,
      autoGenerateReport: true,
      quiet: true,
    })
    setQuestion('')
  }

  const prepareResearchFromUnifiedPrompt = async (goalOverride?: string) => {
    const goal = (goalOverride || question || researchGoal).trim()
    if (!goal) {
      message.info('请输入研究任务目标')
      return
    }
    setActiveTab('research')
    setResearchGoal(goal)
    setResearchTask(null)
    setResearchDataset(null)
    setResearchRecords([])
    setResearchReport('')
    setResearchRetrievalStats(null)
    setResearchEvidencePack(null)
    const plan = await planResearchTask(goal)
    if (!plan) return
    await previewResearchRetrieval(goal, plan)
    setQuestion('')
  }

  const handleUnifiedPromptSubmit = async () => {
    const nextQuestion = question.trim()
    if (!nextQuestion) {
      message.info('请输入问题或研究任务')
      return
    }
    if (activeTab === 'research' || isResearchExtractionPrompt(nextQuestion)) {
      await runResearchEndToEnd(nextQuestion)
      return
    }
    if (mode === 'document') {
      await runDocumentTask('qa', { question: nextQuestion })
      return
    }
    await runLibraryQuestion(nextQuestion)
  }

  const runResearchTask = async (options: ResearchRunOptions = {}) => {
    const activePlan = options.planOverride || researchPlan
    const goal = (options.goalOverride || researchGoal || activePlan?.goal || question).trim()
    if (!goal) {
      message.info('请输入研究任务目标')
      return
    }
    const fields = activePlan?.fields || []
    if (fields.length === 0) {
      message.info('请先生成字段方案')
      return
    }
    setResearchRunning(true)
    setResearchReport('')
    try {
      const task = await window.api.createAiResearchTask({
        title: activePlan?.title || goal.slice(0, 40),
        goal,
        scope: getResearchScope(),
        projectId: researchProjectId,
        kind: activePlan?.kind,
        fields,
        suggestedQueries: activePlan?.suggestedQueries || [goal],
      })
      setResearchTask(task)
      const result = await window.api.runAiResearchTask(task.id)
      setResearchTask(result.task)
      setResearchDataset(result.dataset)
      setResearchRecords(result.records)
      setResearchRetrievalStats(result.retrievalStats || null)
      setResearchEvidencePack(result.evidencePack || null)
      emitResearchWorkspaceUpdated(result.dataset?.project_id || researchProjectId)
      if (options.autoGenerateReport && result.dataset?.id && result.records.length > 0) {
        await generateResearchReportForDataset(result.dataset.id, goal, { quiet: true })
      }
      message.success(options.autoGenerateReport
        ? `已完成研究分析：生成 ${result.records.length} 条记录和一份报告`
        : `已生成 ${result.records.length} 条结构化研究记录`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '运行研究任务失败'))
    } finally {
      setResearchRunning(false)
    }
  }

  const generateResearchReportForDataset = async (datasetId: string, goal: string, options: { quiet?: boolean } = {}) => {
    setResearchReportLoading(true)
    try {
      const result = await window.api.generateAiResearchReport({
        datasetId,
        templateType: 'theme_analysis',
        customPrompt: goal,
      })
      setResearchReport(result.content)
      emitResearchWorkspaceUpdated(researchProjectId)
      if (!options.quiet) message.success(result.outputId ? '报告已生成并保存到研究专题' : '报告已生成')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '生成数据报告失败'))
    } finally {
      setResearchReportLoading(false)
    }
  }

  const generateResearchReport = async () => {
    if (!researchDataset?.id) return
    await generateResearchReportForDataset(researchDataset.id, researchGoal)
  }

  const copyResearchDataset = async () => {
    if (!researchDataset?.id) return
    const result = await window.api.exportAiResearchDataset(researchDataset.id, 'markdown')
    await navigator.clipboard.writeText(result.content)
    message.success(`已复制 ${result.recordCount} 条数据记录`)
  }

  const getResearchKindLabel = (kind?: string) => {
    if (kind === 'statistical') return '统计型'
    if (kind === 'extraction') return '抽取型'
    if (kind === 'synthesis') return '综述型'
    return '混合型'
  }

  const renderResearchRetrievalSummary = () => {
    if (!researchRetrievalStats) return null
    const topStats = researchRetrievalStats.queryStats
      .filter((stat) => isReadableAiResearchQuery(stat.query))
      .slice(0, 16)
    const visibleCooccurringTerms = researchRetrievalStats.cooccurringTerms
      .filter((bucket) => isReadableAiResearchQuery(bucket.label))
      .slice(0, 12)
    const packedEvidenceCount = researchEvidencePack?.totalEvidenceCount || 0
    const completedRecordCount = researchRecords.length
    const pipelineItems: Array<{ title: string; description: string; status: 'finish' | 'process' | 'wait' }> = [
      {
        title: '全库统计完成',
        description: `本地已统计 ${researchRetrievalStats.readableSegmentCount} 个可读文本段，累计 ${researchRetrievalStats.totalDocumentCount} 篇、${researchRetrievalStats.totalPageCount} 页、${researchRetrievalStats.totalHitCount} 次命中。`,
        status: 'finish',
      },
      {
        title: '已压缩代表证据',
        description: researchEvidencePack
          ? `已从全库命中中压缩出 ${packedEvidenceCount} 条代表证据，控制每篇文献和每页占比，避免少数文献占满上下文。`
          : '下一步会把海量命中压缩成小证据包，再交给 AI 阅读。',
        status: researchEvidencePack ? 'finish' : 'process',
      },
      {
        title: 'AI 基于代表证据分析',
        description: researchTask?.status === 'completed'
          ? `AI 已基于代表证据生成 ${completedRecordCount} 条可复核记录。`
          : researchEvidencePack
            ? 'AI 只读取压缩后的代表证据和本地统计数字，不会通篇读取全部页面。'
            : '证据包生成后，AI 再负责归纳、解释和抽取。',
        status: researchTask?.status === 'completed' ? 'finish' : researchEvidencePack ? 'process' : 'wait',
      },
    ]
    return (
      <div
        style={{
          padding: 12,
          borderRadius: 8,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <Text strong>检索统计预览</Text>
          <Tag color={researchRetrievalStats.highFrequencyTriggered ? 'orange' : 'green'}>
            {researchRetrievalStats.highFrequencyTriggered ? '已触发高频词收缩' : '无需收缩'}
          </Tag>
        </div>
        <Alert
          type="info"
          showIcon
          message="全库参与统计，AI 只读代表证据"
          description="精确数量由本地检索计算；AI 只根据压缩后的代表证据做解释、归纳和抽取，不会把上万页全文全部塞进模型。"
          style={{ marginBottom: 12 }}
        />
        <Steps
          size="small"
          items={pipelineItems}
          style={{ marginBottom: 14 }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          <div><Text type="secondary">可读文本段</Text><div>{researchRetrievalStats.readableSegmentCount}</div></div>
          <div><Text type="secondary">累计文献</Text><div>{researchRetrievalStats.totalDocumentCount}</div></div>
          <div><Text type="secondary">累计页面</Text><div>{researchRetrievalStats.totalPageCount}</div></div>
          <div><Text type="secondary">累计命中</Text><div>{researchRetrievalStats.totalHitCount}</div></div>
        </div>
        {topStats.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 6 }}>
              <Text strong style={{ fontSize: 13 }}>实际统计词</Text>
              <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                下面每一行都会参与本地全文统计，右侧数字分别是文献数、页数和出现次数。
              </Text>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {topStats.map((stat) => (
                <div
                  key={`${stat.round}-${stat.query}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(120px, 1fr) auto auto auto auto',
                    gap: 8,
                    alignItems: 'center',
                    fontSize: 12,
                    color: 'var(--gs-text-secondary)',
                  }}
                >
                  <Text ellipsis title={stat.query}>{stat.query}</Text>
                  <span>{stat.documentCount} 篇</span>
                  <span>{stat.pageCount} 页</span>
                  <span>{stat.hitCount} 次</span>
                  {stat.highFrequency ? <Tag color="orange" style={{ margin: 0 }}>高频</Tag> : null}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
            {researchRetrievalStats.readableSegmentCount === 0
              ? '当前范围没有可读取 OCR 正文。'
              : researchRetrievalStats.queryStats.length > 0
                ? '已过滤掉无效检索词，请输入更明确的人名、地名、机构名或主题词。'
                : '关键词未命中，请换成更明确的检索词。'}
          </Text>
        )}
        {visibleCooccurringTerms.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 6 }}>
              <Text strong style={{ fontSize: 13 }}>命中片段中的常见相关词</Text>
              <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                这些蓝色词来自命中片段，只用于理解语境和后续收缩，不代表本轮统计对象。
              </Text>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {visibleCooccurringTerms.map((bucket) => (
                <Tag key={bucket.key} color="blue" style={{ margin: 0 }}>{bucket.label}</Tag>
              ))}
            </div>
          </div>
        ) : null}
        {researchEvidencePack ? (
          <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
            <div style={{ color: 'var(--gs-text-secondary)', fontSize: 12, lineHeight: 1.7 }}>
              <div>
                全库命中 {researchEvidencePack.statsSummary.totalHitCount} 次，覆盖 {researchEvidencePack.statsSummary.totalDocumentCount} 篇、{researchEvidencePack.statsSummary.totalPageCount} 页。
              </div>
              <div>
                进入 AI 的代表证据：{researchEvidencePack.totalEvidenceCount} 条
                {researchEvidencePack.truncated ? '，已按文献和页面预算压缩' : ''}
              </div>
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {researchEvidencePack.evidence.slice(0, 5).map((item) => (
                <div key={item.id} style={{ fontSize: 12, color: 'var(--gs-text-tertiary)', lineHeight: 1.6 }}>
                  <BookOutlined style={{ color: 'var(--gs-gold)', marginRight: 6 }} />
                  {item.doc_title} · 第 {item.page_num || '?'} 页 · {item.query}
                  {item.localStats ? (
                    <span style={{ marginLeft: 8 }}>
                      本词统计：{item.localStats.documentCount} 篇 · {item.localStats.pageCount} 页 · {item.localStats.hitCount} 次
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  const renderEmptyState = () => {
    if (mode === 'document') {
      return (
        <div style={{ textAlign: 'center', marginTop: 56, color: 'var(--gs-text-tertiary)' }}>
          <div
            style={{
              width: 72,
              height: 72,
              margin: '0 auto 16px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(102,126,234,0.1), rgba(118,75,162,0.12))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <RobotOutlined style={{ fontSize: 34, color: 'rgba(118,75,162,0.72)' }} />
          </div>
          <p style={{ marginBottom: 6, color: 'var(--gs-text-secondary)' }}>这是当前文献的 AI 助手</p>
          <p style={{ fontSize: 13 }}>你可以让它生成摘要、翻译文本、提取关键词，或者直接提问。</p>
        </div>
      )
    }

    return (
      <div style={{ textAlign: 'center', marginTop: 48 }}>
        <RobotOutlined style={{ fontSize: 40, color: 'rgba(196,149,106,0.8)' }} />
        <div style={{ marginTop: 12, color: 'var(--gs-text-secondary)' }}>这是全库 AI 助手</div>
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--gs-text-tertiary)' }}>
          默认面向整个资料库，也可以切换到标签、文件夹或具体论文范围。
        </div>
      </div>
    )
  }

  const renderEvidenceProcess = (item: AiHistoryItem) => {
    const queries = item.expandedQueries || []
    const clusters = item.evidenceClusters || []
    const warnings = item.warnings || []
    if (!item.plan && queries.length === 0 && clusters.length === 0 && warnings.length === 0) return null

    return (
      <Collapse
        ghost
        size="small"
        style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}
        items={[
          {
            key: 'process',
            label: '查证过程',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {item.plan ? (
                  <div style={{ color: 'var(--gs-text-secondary)', fontSize: 12, lineHeight: 1.7 }}>
                    <div>检索意图：{item.plan.intent || item.prompt}</div>
                    {item.plan.notes ? <div>备注：{item.plan.notes}</div> : null}
                  </div>
                ) : null}

                {queries.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {queries.slice(0, 18).map((query) => (
                      <Tag key={query} color="gold" style={{ margin: 0 }}>{query}</Tag>
                    ))}
                  </div>
                ) : null}

                {clusters.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {clusters.slice(0, 6).map((cluster) => (
                      <div
                        key={cluster.id}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid rgba(255,255,255,0.08)',
                          background: 'rgba(255,255,255,0.03)',
                          color: 'var(--gs-text-secondary)',
                          fontSize: 12,
                        }}
                      >
                        <BookOutlined style={{ color: 'var(--gs-gold)', marginRight: 6 }} />
                        {cluster.doc_title}：第 {cluster.page_range[0]}-{cluster.page_range[1]} 页，命中 {cluster.hit_count} 处
                      </div>
                    ))}
                  </div>
                ) : null}

                {warnings.length > 0 ? (
                  <Alert type="warning" showIcon message={warnings.join('；')} />
                ) : null}
              </div>
            ),
          },
        ]}
      />
    )
  }

  const renderResearchPanel = () => (
    <div style={{ paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Alert
        type="info"
        showIcon
        message="输入研究目标后，点击一次就会完成统计、抽取和报告。"
        description="软件会先做本地全库统计检索，再压缩代表证据交给 AI。数量、页数和命中文献数由本地数据库计算；AI 负责归纳解释，结果会在下方直接展示。"
      />

      {researchGoal.trim() ? (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: 'var(--gs-text-secondary)',
            lineHeight: 1.7,
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>当前研究目标</Text>
          <div style={{ marginTop: 4, color: 'var(--gs-text-primary)' }}>{researchGoal}</div>
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="请在底部输入框写下你要统计、抽取或归类的目标，例如“统计这些文献里关于地方教育经费的时间、地区和变化规律”。"
        />
      )}

      {(() => {
        const researchBusy = researchPlanning || researchPreviewLoading || researchRunning || researchReportLoading
        const effectiveResearchGoal = researchGoal.trim() || question.trim()
        return (
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <Text style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
            当前范围：{mode === 'document' ? documentTitle || '当前文献' : scopeLabel}
          </Text>
          <Select
            allowClear
            size="small"
            placeholder="归入研究专题"
            value={researchProjectId || undefined}
            style={{ minWidth: 180 }}
            onChange={(value) => setResearchProjectId(value || null)}
            options={researchProjects.map((project) => ({ value: project.id, label: project.name }))}
          />
        </div>
        <Space wrap>
          <Button
            type="primary"
            icon={<RobotOutlined />}
            loading={researchBusy}
            disabled={!effectiveResearchGoal}
            onClick={() => void runResearchEndToEnd(effectiveResearchGoal)}
          >
            开始完整分析
          </Button>
          <Button icon={<CopyOutlined />} disabled={!researchDataset} onClick={() => void copyResearchDataset()}>
            复制完整结果
          </Button>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'prepare',
                  label: '只生成方案和统计预览',
                  icon: <SearchOutlined />,
                  disabled: !effectiveResearchGoal,
                  onClick: () => void prepareResearchFromUnifiedPrompt(effectiveResearchGoal),
                },
                {
                  key: 'rerun-extraction',
                  label: '只重新抽取数据',
                  icon: <RobotOutlined />,
                  disabled: !researchPlan,
                  onClick: () => void runResearchTask(),
                },
                {
                  key: 'report',
                  label: '只重新生成报告',
                  icon: <BulbOutlined />,
                  disabled: !researchDataset,
                  onClick: () => void generateResearchReport(),
                },
              ],
            }}
          >
            <Button icon={<DownOutlined />}>更多</Button>
          </Dropdown>
        </Space>
      </Space>
        )
      })()}

      {researchPlan ? (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <Space size={6} wrap>
            <Text strong>{researchPlan.title}</Text>
            <Tag color="geekblue">{getResearchKindLabel(researchPlan.kind)}</Tag>
          </Space>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {researchPlan.fields.map((field) => (
              <Tooltip key={field.key} title={field.description || field.key}>
                <Tag color={field.type === 'date' ? 'blue' : field.type === 'place' ? 'green' : field.type === 'category' ? 'purple' : 'gold'} style={{ margin: 0 }}>
                  {field.label}
                </Tag>
              </Tooltip>
            ))}
          </div>
          {(() => {
            const sourceQueries = researchRetrievalStats?.plan.queries.length
              ? researchRetrievalStats.plan.queries
              : researchPlan.suggestedQueries
            const visibleQueries = sourceQueries.filter(isReadableAiResearchQuery).slice(0, 16)
            if (visibleQueries.length === 0) return null
            return (
              <div style={{ marginTop: 10, color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
                {researchRetrievalStats ? '实际统计词' : '候选统计词'}：{visibleQueries.join('、')}
              </div>
            )
          })()}
        </div>
      ) : null}

      {renderResearchRetrievalSummary()}

      {researchTask ? (
        <div style={{ color: 'var(--gs-text-secondary)', fontSize: 13 }}>
          任务状态：<Tag color={researchTask.status === 'completed' ? 'green' : researchTask.status === 'error' ? 'red' : 'blue'}>{researchTask.status}</Tag>
          {researchTask.error_message ? <Text type="danger">{researchTask.error_message}</Text> : null}
        </div>
      ) : null}

      {researchRecords.length > 0 ? (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <Text strong>已抽取 {researchRecords.length} 条记录</Text>
            <Button size="small" type="primary" loading={researchReportLoading} onClick={() => void generateResearchReport()}>
              重新生成报告
            </Button>
          </div>
          <Space direction="vertical" style={{ width: '100%' }}>
            {researchRecords.slice(0, 6).map((record) => (
              <div
                key={record.id}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.06)',
                  background: 'rgba(255,255,255,0.025)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Text strong style={{ color: 'var(--gs-text-primary)' }}>{record.doc_title || record.doc_id}</Text>
                  <Tag color="blue">第 {record.page_num || '?'} 页</Tag>
                </div>
                <div style={{ marginTop: 6, color: 'var(--gs-text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
                  {record.excerpt.slice(0, 180)}
                </div>
              </div>
            ))}
          </Space>
          {researchRecords.length > 6 ? (
            <Text style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>这里只显示前 6 条，点击“复制完整结果”可查看全部记录。</Text>
          ) : null}
        </div>
      ) : null}

      {researchReport ? (
        <div
          style={{
            padding: 14,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <AiMarkdown content={researchReport} sources={[]} prompt={researchGoal} onOpenDocument={onOpenDocument} />
        </div>
      ) : null}
    </div>
  )

  const activeSession = chatSessions.find((session) => session.id === activeSessionId)
  const activeTurnCount = getChatTurnCount(activeSession, history)
  const shouldSuggestNewSession = activeTurnCount >= 20
  const scopePreviewSummary = scopePreview
    ? `${scopePreview.count} 篇文献，${scopePreview.ocrReadyCount} 篇已有可用文本`
    : '正在读取范围'
  const scopePreviewContent = (
    <div className="ai-scope-popover" onWheel={(event) => event.stopPropagation()}>
      <div className="ai-scope-popover-header">
        <Text strong>{scopeLabel}</Text>
        <Text type="secondary">{scopePreviewSummary}</Text>
      </div>
      {scopePreview && scopePreview.documents.length > 0 ? (
        <div className="ai-scope-popover-list">
          {scopePreview.documents.map((item, index) => (
            <div className="ai-scope-popover-item" key={item.id}>
              <span>{index + 1}</span>
              <Text ellipsis title={item.title}>{item.title || '未命名文献'}</Text>
            </div>
          ))}
          {scopePreview.count > scopePreview.documents.length ? (
            <div className="ai-scope-popover-more">
              已预览前 {scopePreview.documents.length} 篇，还有 {scopePreview.count - scopePreview.documents.length} 篇可在完整列表查看。
            </div>
          ) : null}
          <Button block size="small" style={{ marginTop: 8 }} onClick={() => void openScopeList()}>
            展开完整列表
          </Button>
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={scopePreview ? '当前范围内暂无文献' : '正在读取文献范围'} />
      )}
    </div>
  )
  const sessionMenuItems = chatSessions.length
    ? chatSessions.map((session) => ({
      key: session.id,
      label: (
        <div style={{ maxWidth: 260 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.title || 'AI 对话'}</div>
          <div style={{ fontSize: 12, color: 'var(--gs-text-tertiary)' }}>
            {session.message_count || 0} 轮 · {session.updated_at ? new Date(session.updated_at).toLocaleString() : ''}
          </div>
        </div>
      ),
    }))
    : [{ key: 'empty', disabled: true, label: '暂无历史对话' }]
  const unifiedPromptIsResearch = activeTab === 'research' || isResearchExtractionPrompt(question)

  return (
    <div
      className="ai-panel"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', margin: '-8px -16px', background: 'transparent' }}
    >
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <Space size={6} wrap>
            <Dropdown
              trigger={['click']}
              menu={{
                items: sessionMenuItems,
                selectable: true,
                selectedKeys: activeSessionId ? [activeSessionId] : [],
                onClick: ({ key }) => {
                  if (key !== 'empty') void switchChatSession(String(key))
                },
              }}
            >
              <Button size="small" icon={<HistoryOutlined />} loading={sessionLoading}>
                {activeSession?.title || '新对话'} <DownOutlined />
              </Button>
            </Dropdown>
            <LlmProfileSelector width={170} />
          </Space>
          <Space size={6}>
            <Tooltip title="新开一个不带旧上下文的对话">
              <Button size="small" icon={<PlusOutlined />} onClick={() => void createNewChatSession()} />
            </Tooltip>
            <Tooltip title="删除当前对话">
              <Button size="small" danger icon={<DeleteOutlined />} disabled={!activeSessionId} onClick={() => void deleteCurrentChatSession()} />
            </Tooltip>
          </Space>
        </div>
        {shouldSuggestNewSession ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 10 }}
            message={`当前对话已有 ${activeTurnCount} 轮，可以继续使用；为保持上下文清晰，建议在合适的时候点击“+”开启新对话。`}
          />
        ) : null}
        {mode === 'document' ? (
          <div>
            <Text style={{ color: 'var(--gs-text-secondary)' }}>当前文献</Text>
            <Paragraph
              ellipsis={{ rows: 2, tooltip: documentTitle || '未命名文献' }}
              style={{ margin: '4px 0 0', color: 'var(--gs-text-primary)' }}
            >
              {documentTitle || '未命名文献'}
            </Paragraph>
            {!hasDocumentText ? (
              <Alert
                style={{ marginTop: 10 }}
                type="info"
                showIcon
                message="当前文献还没有可用文本，请先完成 OCR。"
              />
            ) : null}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>AI 读取范围</Text>
                <div style={{ marginTop: 4, color: 'var(--gs-text-secondary)', fontSize: 12 }}>
                  {scopePreviewSummary}
                </div>
              </div>
              <Popover
                content={scopePreviewContent}
                trigger="hover"
                placement="bottomRight"
                overlayClassName="ai-scope-popover-overlay"
                open={scopePopoverOpen}
                onOpenChange={setScopePopoverOpen}
              >
                <Button size="small" icon={<BookOutlined />}>查看文献</Button>
              </Popover>
            </div>

            <Select
              size="small"
              value={scopeType}
              onChange={(value) => updateScopeType(value as ScopeType)}
              options={[
                { value: 'all', label: '整个数据库' },
                { value: 'tags', label: '按标签' },
                { value: 'folders', label: '按文件夹' },
                { value: 'documents', label: '按论文' }
              ]}
            />

            {scope.type === 'tags' ? (
              <Select
                mode="multiple"
                size="small"
                placeholder="选择一个或多个标签"
                value={scope.tagIds}
                onChange={(tagIds) => setScope({ type: 'tags', tagIds })}
                options={tagOptions}
                maxTagCount="responsive"
              />
            ) : null}

            {scope.type === 'folders' ? (
              <Select
                mode="multiple"
                size="small"
                placeholder="选择一个或多个文件夹"
                value={scope.folderIds}
                onChange={(folderIds) => setScope({ type: 'folders', folderIds })}
                options={folderOptions}
                maxTagCount="responsive"
              />
            ) : null}

            {scope.type === 'documents' ? (
              <Select
                mode="multiple"
                size="small"
                showSearch
                placeholder="选择具体论文"
                value={scope.docIds}
                onChange={(docIds) => setScope({ type: 'documents', docIds })}
                options={documentOptions}
                optionFilterProp="label"
                maxTagCount="responsive"
              />
            ) : null}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: mode === 'library' ? '0 16px 16px' : '20px 16px' }} ref={scrollRef}>
        {mode === 'library' || mode === 'document' ? (
          <div className="ai-panel-tabs-sticky">
            <Tabs
              activeKey={activeTab}
              onChange={(key) => setActiveTab(key as LibraryAiTab)}
              items={mode === 'library'
                ? [
                  { key: 'qa', label: '提问' },
                  { key: 'analysis', label: '一键分析' },
                  { key: 'research', label: '数据抽取' },
                ]
                : [
                  { key: 'qa', label: '提问' },
                  { key: 'research', label: '数据抽取' },
                ]}
            />
          </div>
        ) : null}

        {mode === 'library' && activeTab === 'analysis' ? (
          <div style={{ paddingTop: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Select
                value={analysisTemplate}
                onChange={(value) => setAnalysisTemplate(value)}
                options={ANALYSIS_TEMPLATES.map((item) => ({ value: item.value, label: item.label }))}
              />

              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  color: 'var(--gs-text-secondary)',
                  fontSize: 13
                }}
              >
                {ANALYSIS_TEMPLATES.find((item) => item.value === analysisTemplate)?.desc}
              </div>

              {analysisTemplate === 'custom' ? (
                <TextArea
                  rows={4}
                  placeholder="请输入你的分析要求，例如：比较这个范围内关于某一问题的不同解释，并按证据强弱排序。"
                  value={analysisPrompt}
                  onChange={(event) => setAnalysisPrompt(event.target.value)}
                />
              ) : null}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <Text style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
                  当前范围：{scopeLabel}
                </Text>
                <Button type="primary" icon={<BulbOutlined />} loading={analysisLoading} onClick={() => void runScopeAnalysis()}>
                  开始分析
                </Button>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              {analysisLoading ? (
                <div style={{ padding: '48px 0', textAlign: 'center' }}>
                  <Spin size="large" tip="正在生成专题分析..." />
                </div>
              ) : analysisResult ? (
                <div
                  style={{
                    lineHeight: 1.75,
                    color: 'var(--gs-text-primary)',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 8,
                    padding: 14
                  }}
                >
                  <AiMarkdown content={analysisResult} sources={analysisSources} prompt={analysisPrompt || analysisTemplate} onOpenDocument={onOpenDocument} />
                  {analysisSources.length > 0 ? (
                    <div className="ai-source-list">
                      {analysisSources.slice(0, 8).map((source, index) => (
                        <Tooltip
                          key={`analysis-source-${source.doc_id}-${source.page_num}-${index}`}
                          title={stripSnippetMarkers(source.snippet || '') || source.doc_title}
                        >
                          <Button
                            className="ai-source-chip"
                            size="small"
                            onClick={() => onOpenDocument?.(sourceToTarget(source, analysisSources, index, analysisPrompt || analysisTemplate))}
                          >
                            [{index + 1}] {source.doc_title || '原文'} · {source.page_num || '?'}页
                          </Button>
                        </Tooltip>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <Empty
                  description="选择一个模板后开始生成分析结果"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  style={{ marginTop: 48 }}
                />
              )}
            </div>
          </div>
        ) : null}

        {activeTab === 'research' ? renderResearchPanel() : null}

        {activeTab === 'qa' ? (
          <>
        {history.length === 0 && !loading ? renderEmptyState() : null}

        {hasOlderTurns ? (
          <div style={{ textAlign: 'center', margin: '8px 0 16px' }}>
            <Button size="small" loading={sessionLoading} onClick={() => void loadOlderTurns()}>加载更早对话</Button>
          </div>
        ) : null}

        {history.map((item) => (
          <AiTurn
            key={item.id}
            item={item}
            onOpenDocument={onOpenDocument}
            onSaveAiSourceAsNote={(historyItem, source) => void saveAiSourceAsNote(historyItem, source)}
            renderEvidenceProcess={renderEvidenceProcess}
          />
        ))}

        {loading ? (
          <div className="chat-bubble-container ai">
            <div className="chat-avatar">
              <RobotOutlined />
            </div>
            <div className="chat-bubble" style={{ minWidth: 92, display: 'flex', alignItems: 'center' }}>
              <Spin size="small" />
              <span style={{ marginLeft: 12, fontSize: 14, color: 'var(--gs-text-secondary)' }}>思考中...</span>
            </div>
          </div>
        ) : null}
          </>
        ) : null}
      </div>

      <div className="ai-chat-input-wrapper">
        {mode === 'document' && activeTab !== 'research' ? (
          <div className="ai-quick-actions">
            <Space.Compact style={{ flexShrink: 0 }}>
              <Select
                value={summaryLength}
                onChange={setSummaryLength}
                style={{ width: 92 }}
                size="small"
                options={SUMMARY_OPTIONS}
                popupMatchSelectWidth={false}
              />
              <Button size="small" icon={<BulbOutlined />} onClick={() => void runDocumentTask('summary', { length: summaryLength })}>
                摘要
              </Button>
            </Space.Compact>

            <Button size="small" icon={<TagOutlined />} onClick={() => void runDocumentTask('keywords')}>
              关键词
            </Button>
          </div>
        ) : null}

        {mode === 'document' ? (
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            {selectedText.trim() ? (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'rgba(24,144,255,0.08)',
                  border: '1px solid rgba(24,144,255,0.18)',
                  color: 'var(--gs-text-secondary)',
                  fontSize: 12,
                  lineHeight: 1.6,
                  maxHeight: 88,
                  overflow: 'auto'
              }}
            >
                已选中：{selectedText.trim().slice(0, 260)}{selectedText.trim().length > 260 ? '...' : ''}
              </div>
            ) : null}
            <Input.Search
              placeholder={selectedText.trim() ? '围绕选中文字提问，或输入要抽取的数据...' : '基于当前文献提问，或输入要抽取/统计的目标...'}
              enterButton={<Button icon={unifiedPromptIsResearch ? <RobotOutlined /> : <SendOutlined />} type="primary">{unifiedPromptIsResearch ? '开始完整分析' : undefined}</Button>}
              size="large"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onSearch={() => {
                if (question.trim()) {
                  void handleUnifiedPromptSubmit()
                }
              }}
              loading={loading || researchPlanning || researchPreviewLoading}
              style={{ borderRadius: 8 }}
            />
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <TextArea
              rows={3}
              placeholder="面向当前范围提问，或直接写研究任务，例如：统计这些文献里某类问题的时间、地点、人物和变化规律。"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onPressEnter={(event) => {
                if (event.shiftKey) return
                event.preventDefault()
                if (question.trim()) {
                  void handleUnifiedPromptSubmit()
                }
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <Text style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
                  当前范围：{scopeLabel}
                </Text>
                <div style={{ color: 'var(--gs-text-tertiary)', fontSize: 12, marginTop: 2 }}>
                  优先读取关键词命中的原文页及前后文本，不会通篇阅读。
                </div>
              </div>
              <Button
                type="primary"
                icon={unifiedPromptIsResearch ? <RobotOutlined /> : <SendOutlined />}
                loading={loading || researchPlanning || researchPreviewLoading || researchRunning || researchReportLoading}
                onClick={() => void handleUnifiedPromptSubmit()}
              >
                {unifiedPromptIsResearch ? '开始完整分析' : '开始提问'}
              </Button>
            </div>
          </Space>
        )}
      </div>
      <Modal
        title={`${scopeLabel} · 文献列表`}
        open={scopeListOpen}
        onCancel={() => setScopeListOpen(false)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <div className="ai-scope-modal-summary">
          {scopePreviewSummary}
          {scopeListDocuments.length > 0 ? `，当前列表显示 ${scopeListDocuments.length} 篇` : ''}
        </div>
        <div className="ai-scope-modal-list">
          <Spin spinning={scopeListLoading}>
          {scopeListDocuments.length ? scopeListDocuments.map((item, index) => (
            <div className="ai-scope-popover-item" key={item.id}>
              <span>{index + 1}</span>
              <Text title={item.title}>{item.title || '未命名文献'}</Text>
            </div>
          )) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围内暂无文献" />
          )}
          </Spin>
        </div>
      </Modal>
    </div>
  )
}
