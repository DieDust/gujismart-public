import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Collapse,
  Dropdown,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Tag,
  Tabs,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  BookOutlined,
  BulbOutlined,
  DeleteOutlined,
  DownOutlined,
  HistoryOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  TagOutlined,
} from '@ant-design/icons'
import type { AiChatSession, AiChatTurn, AiQuestionResponse, AiStreamEvent, AiSynthesisResult, AiSynthesisTemplate, AiTaskType, LibraryAiScope, LibraryAiScopePreview, LibraryAiTab, OpenDocumentTarget, SearchHit, SearchHitLocator } from '@shared/types'
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
  selectedText?: string
  onOpenDocument?: (target: OpenDocumentTarget) => void
}

const SUMMARY_OPTIONS = [
  { value: '100字以内', label: '简短' },
  { value: '200字左右', label: '适中' },
  { value: '500字左右', label: '详细' }
]

const LIBRARY_PROMPTS = [
  '请基于当前范围内的文献综合归纳研究脉络、主要趋势和可突破的研究空白，不要逐篇复述检索结果。',
  '请综合比较当前范围内主要观点的共识、分歧和证据强弱，并指出来源。',
  '请按阶段梳理当前范围内的重要变化，说明变化逻辑、代表性证据和仍缺的材料。'
]

const ANALYSIS_TEMPLATES = [
  { value: 'literature_review', label: '文献综述', desc: '综合归纳研究脉络、趋势、分歧与空白。' },
  { value: 'summary', label: '内容摘要', desc: '生成跨文献综合摘要，避免逐篇复述。' },
  { value: 'theme_analysis', label: '主题分析', desc: '提炼共同主题、分歧与代表性证据。' },
  { value: 'evidence_table', label: '证据表格', desc: '按观点、时间、机构、政策、教育内容整理证据，每格带页码来源。' },
  { value: 'timeline', label: '时间线', desc: '按时间顺序整理观点、事件与变化。' },
  { value: 'custom', label: '自定义分析', desc: '按你的提示词生成定制化分析。' }
] as const

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
  const [tagOptions, setTagOptions] = useState<Array<{ value: string; label: string }>>([])
  const [folderOptions, setFolderOptions] = useState<Array<{ value: string; label: string }>>([])
  const [documentOptions, setDocumentOptions] = useState<Array<{ value: string; label: string }>>([])
  const [activeTab, setActiveTab] = useState<LibraryAiTab>(initialTab)
  const [analysisTemplate, setAnalysisTemplate] = useState<AiSynthesisTemplate>('literature_review')
  const [analysisPrompt, setAnalysisPrompt] = useState('')
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisResult, setAnalysisResult] = useState('')
  const [analysisSources, setAnalysisSources] = useState<EvidenceQaSource[]>([])
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
        const [tags, folders, documents] = await Promise.all([
          window.api.listTags(),
          window.api.listFolders(),
          window.api.listDocuments({ limit: 1000 })
        ])

        setTagOptions(tags.map((item) => ({ value: item.id, label: item.name })))
        setFolderOptions(folders.map((item) => ({ value: item.id, label: item.name })))
        setDocumentOptions(documents.map((item) => ({ value: item.id, label: item.title || '未命名文献' })))
      } catch (error) {
        console.error(error)
        message.error('加载范围选项失败')
      }
    }

    void loadScopeOptions()
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
      setAnalysisResult(typeof result === 'string' ? result : result.markdown)
      setAnalysisSources(typeof result === 'string' ? [] : result.sources || [])
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '专题分析失败'))
    } finally {
      setAnalysisLoading(false)
    }
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

  const activeSession = chatSessions.find((session) => session.id === activeSessionId)
  const activeTurnCount = getChatTurnCount(activeSession, history)
  const shouldSuggestNewSession = activeTurnCount >= 20
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
              <Text strong style={{ color: 'var(--gs-text-primary)' }}>全库问答范围</Text>
              <Tag color="gold" style={{ margin: 0 }}>{scopeLabel}</Tag>
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

            <div
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)'
              }}
            >
              <div style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>
                {scopePreview
                  ? `当前范围包含 ${scopePreview.count} 篇文献，其中 ${scopePreview.ocrReadyCount} 篇已有可用文本。`
                  : '正在预览当前范围...'}
              </div>
              {scopePreview && scopePreview.documents.length > 0 ? (
                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {scopePreview.documents.map((item) => (
                    <Tooltip key={item.id} title={item.title}>
                      <Tag style={{ margin: 0, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.title}
                      </Tag>
                    </Tooltip>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: mode === 'library' ? '0 16px 16px' : '20px 16px' }} ref={scrollRef}>
        {mode === 'library' ? (
          <Tabs
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as 'qa' | 'analysis')}
            items={[
              { key: 'qa', label: '问答' },
              { key: 'analysis', label: '模板分析' }
            ]}
          />
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
        {mode === 'library' && activeTab === 'analysis' ? null : mode === 'document' ? (
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
        ) : (
          <div className="ai-quick-actions">
            {LIBRARY_PROMPTS.map((prompt) => (
              <Button key={prompt} size="small" icon={<RobotOutlined />} onClick={() => void runLibraryQuestion(prompt)}>
                {prompt.includes('时间') ? '时间线' : prompt.includes('比较') ? '比较观点' : '研究脉络'}
              </Button>
            ))}
          </div>
        )}

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
              placeholder={selectedText.trim() ? '围绕选中文字提问...' : '基于当前文献提问...'}
              enterButton={<Button icon={<SendOutlined />} type="primary" />}
              size="large"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onSearch={() => {
                if (question.trim()) {
                  void runDocumentTask('qa', { question })
                }
              }}
              loading={loading}
              style={{ borderRadius: 8 }}
            />
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <TextArea
              rows={3}
              placeholder="面向当前范围提问，例如：这个主题有哪些主要研究观点？哪些论文证据最强？"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onPressEnter={(event) => {
                if (event.shiftKey) return
                event.preventDefault()
                if (question.trim()) {
                  void runLibraryQuestion()
                }
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <Text style={{ color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
                当前范围：{scopeLabel}
              </Text>
              <Button type="primary" icon={<SendOutlined />} loading={loading} onClick={() => void runLibraryQuestion()}>
                开始提问
              </Button>
            </div>
          </Space>
        )}
      </div>
    </div>
  )
}
