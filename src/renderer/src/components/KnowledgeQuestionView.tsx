import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Drawer, Empty, Input, List, Select, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import { ClockCircleOutlined, CopyOutlined, FileSearchOutlined, PlusOutlined, SaveOutlined, SendOutlined, StarOutlined } from '@ant-design/icons'
import type { AiChatSession, AiChatTurn, EvidenceQaSource, LibraryAiScope, LibraryAiScopePreview, OpenDocumentTarget } from '@shared/types'
import { getErrorMessage } from '@shared/errors'
import AiMarkdown from './AiMarkdown'
import LlmProfileSelector from './LlmProfileSelector'
import CorpusResearchPanel from './CorpusResearchPanel'
import './KnowledgeQuestionView.css'

const EMPTY_SCOPE: LibraryAiScope = { type: 'documents', docIds: [] }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function parseScope(value: unknown): LibraryAiScope | null {
  if (!object(value)) return null
  if (value.type === 'all') return { type: 'all' }
  for (const [type, key] of [['documents', 'docIds'], ['folders', 'folderIds'], ['tags', 'tagIds']] as const) {
    if (value.type === type && Array.isArray(value[key]) && value[key].every((id) => typeof id === 'string')) {
      return { type, [key]: value[key] } as LibraryAiScope
    }
  }
  return null
}
function json(value: string | null | undefined): unknown {
  try { return JSON.parse(value || '{}') } catch { return {} }
}
function metadata(value: unknown): { sources: EvidenceQaSource[]; warnings: string[] } {
  if (!object(value)) return { sources: [], warnings: [] }
  return {
    sources: Array.isArray(value.sources) ? value.sources.filter((source): source is EvidenceQaSource => object(source)
      && typeof source.doc_id === 'string' && typeof source.doc_title === 'string' && typeof source.snippet === 'string') : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
  }
}
interface Answer {
  id: string
  createdAt?: string
  question: string
  text: string
  sources: EvidenceQaSource[]
  warnings: string[]
}
function turnAnswer(turn: AiChatTurn): Answer {
  return { id: turn.id, createdAt: turn.created_at, question: turn.prompt, text: turn.result, ...metadata(turn.sources ? turn : json(turn.metadata_json)) }
}
function objectMetadata(value: string | null | undefined): Record<string, unknown> {
  const parsed = json(value)
  return object(parsed) ? parsed : {}
}
interface Props {
  libraryProjectId: string
  projectId?: string
  selectedDocuments?: string[]
  onScopeState: (scope: LibraryAiScope, preview: LibraryAiScopePreview | undefined, busy: boolean) => void
  onOpenResearch: (view: 'evidence' | 'ai') => void
  onOpenDocument?: (target: OpenDocumentTarget) => void
}

export default function KnowledgeQuestionView({ libraryProjectId, projectId, selectedDocuments, onScopeState, onOpenResearch, onOpenDocument }: Props) {
  const key = `gujismart.knowledge-question.v1.${libraryProjectId}${projectId ? `.topic.${projectId}` : ''}`
  const [saved] = useState(() => {
    try { return objectMetadata(localStorage.getItem(key)) } catch { return {} }
  })
  const [scope, setScope] = useState<LibraryAiScope>(() => parseScope(saved.scope) || EMPTY_SCOPE)
  const [sessionId, setSessionId] = useState(typeof saved.sessionId === 'string' ? saved.sessionId : '')
  const [question, setQuestion] = useState(typeof saved.question === 'string' ? saved.question : '')
  const [preview, setPreview] = useState<LibraryAiScopePreview>()
  const [previewLoading, setPreviewLoading] = useState(true)
  const [previewError, setPreviewError] = useState('')
  const [sessions, setSessions] = useState<AiChatSession[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [answerIndex, setAnswerIndex] = useState(0)
  const [error, setError] = useState('')
  const [storageError, setStorageError] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [running, setRunning] = useState(false)
  const [corpusOpen, setCorpusOpen] = useState(false)
  const [corpusBusy, setCorpusBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [savingSource, setSavingSource] = useState<string>()
  const [savingAnswer, setSavingAnswer] = useState(false)
  const [savedAnswers, setSavedAnswers] = useState<Set<string>>(new Set())
  const [loadingProjectScope, setLoadingProjectScope] = useState(!!projectId && !parseScope(saved.scope))
  const [collected, setCollected] = useState<Set<string>>(new Set())
  const lock = useRef(false)
  const sourceLock = useRef(false)
  const answerLock = useRef(false)
  const generation = useRef(0)
  const activeRequest = useRef('')
  const answer = answers[answerIndex]

  const loadSession = async (id: string, nextScope?: LibraryAiScope) => {
    const current = ++generation.current
    setLoadingHistory(true); setError('')
    try {
      const turns = await window.api.getAiChatTurns(id)
      if (current !== generation.current) return
      setAnswers(turns.map(turnAnswer)); setAnswerIndex(Math.max(0, turns.length - 1)); setSessionId(id); setPhase(''); setHasEarlier(turns.length >= 30)
      if (nextScope) { setScope(nextScope); setQuestion('') }
    } catch (reason: unknown) {
      if (current === generation.current) setError(getErrorMessage(reason, '读取历史回答失败'))
    } finally { if (current === generation.current) setLoadingHistory(false) }
  }
  useEffect(() => {
    if (sessionId) void loadSession(sessionId)
    return () => { generation.current += 1 }
  }, [])
  useEffect(() => {
    if (!projectId || parseScope(saved.scope)) return
    let active = true
    void window.api.listResearchProjectDocuments(projectId).then((docs) => {
      if (active) setScope({ type: 'documents', docIds: docs.map((doc) => doc.id) })
    }).catch((reason: unknown) => { if (active) setError(getErrorMessage(reason, '读取专题文献失败')) })
      .finally(() => { if (active) setLoadingProjectScope(false) })
    return () => { active = false }
  }, [projectId])
  useEffect(() => {
    if (!selectedDocuments || lock.current) return
    generation.current += 1
    setScope({ type: 'documents', docIds: selectedDocuments })
    setSessionId(''); setAnswers([]); setAnswerIndex(0); setError(''); setPhase(''); setLoadingHistory(false); setHasEarlier(false)
  }, [selectedDocuments])
  useEffect(() => {
    let active = true
    setPreviewLoading(true); setPreviewError(''); setPreview(undefined)
    void window.api.previewAiScope(scope).then((result) => { if (active) setPreview(result) })
      .catch((reason: unknown) => { if (active) setPreviewError(getErrorMessage(reason, '读取材料范围失败')) })
      .finally(() => { if (active) setPreviewLoading(false) })
    return () => { active = false }
  }, [scope])
  useEffect(() => {
    if (loadingProjectScope) return
    try { localStorage.setItem(key, JSON.stringify({ scope, sessionId, question })); setStorageError('') }
    catch { setStorageError('当前输入未能保存在本机；已完成的回答仍保存在对话历史中。') }
  }, [key, scope, sessionId, question, loadingProjectScope])
  useEffect(() => {
    onScopeState(scope, preview, running || loadingHistory || previewLoading || loadingProjectScope || savingAnswer || !!savingSource || corpusBusy)
  }, [scope, preview, running, loadingHistory, previewLoading, loadingProjectScope, savingAnswer, savingSource, corpusBusy, onScopeState])
  useEffect(() => {
    if (!running) return
    const start = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const completeAnswer = (requestId: string, payload: unknown) => {
    if (activeRequest.current !== requestId) return
    if (!object(payload) || typeof payload.answer !== 'string') throw new Error('回答返回格式不完整，请查看历史或重试')
    const text = payload.answer
    const turnId = object(payload.turn) && typeof payload.turn.id === 'string' ? payload.turn.id : requestId
    setAnswers((items) => items.map((item) => item.id === requestId ? { ...item, text, ...metadata(payload), id: turnId } : item))
    activeRequest.current = ''
    setPhase('已保存'); setQuestion('')
  }
  useEffect(() => window.api.onAiStreamEvent((event) => {
    if (event.requestId !== activeRequest.current) return
    const update = (change: (item: Answer) => Answer) => setAnswers((items) => items.map((item) => item.id === event.requestId ? change(item) : item))
    if (event.type === 'phase') setPhase(String(event.payload || '正在处理'))
    if (event.type === 'sources') update((item) => ({ ...item, ...metadata(event.payload) }))
    if (event.type === 'delta') update((item) => ({ ...item, text: item.text + String(event.payload || '') }))
    if (event.type === 'error') { setError(String(event.payload || '回答失败')); setPhase('未完成') }
    if (event.type === 'done') {
      try { completeAnswer(event.requestId, event.payload) }
      catch (reason: unknown) { setError(getErrorMessage(reason, '回答返回格式不完整')); setPhase('未完成') }
    }
  }), [])

  const ask = async () => {
    const prompt = question.trim()
    if (!prompt || lock.current || loadingHistory || previewLoading || loadingProjectScope || !preview?.ocrReadyCount || previewError) return
    lock.current = true
    setRunning(true); setError(''); setPhase('准备材料')
    const requestId = `knowledge-${crypto.randomUUID()}`
    activeRequest.current = requestId
    setAnswers((items) => [...items, { id: requestId, question: prompt, text: '', sources: [], warnings: [] }])
    setAnswerIndex(answers.length)
    try {
      let id = sessionId
      if (!id) {
        const session = await window.api.createAiChatSession({ mode: 'library', title: prompt.slice(0, 36), scope })
        id = session.id; setSessionId(id)
      }
      await window.api.runScopedLibraryAiStream(prompt, scope, { sessionId: id, requestId, limit: 12 })
      // IPC replies and stream events may arrive in either order; recover the committed turn without another model call.
      if (activeRequest.current === requestId) {
        const turns = await window.api.getAiChatTurns(id)
        if (activeRequest.current === requestId) {
          const turn = turns[turns.length - 1]
          if (!turn || turn.prompt !== prompt) throw new Error('未能确认回答已保存，请查看研究历史')
          completeAnswer(requestId, { answer: turn.result, ...turnAnswer(turn), turn })
        }
      }
    } catch (reason: unknown) { setError(getErrorMessage(reason, '回答失败')); setPhase('未完成') }
    finally { activeRequest.current = ''; lock.current = false; setRunning(false) }
  }
  const showHistory = async () => {
    setHistoryOpen(true); setLoadingHistory(true); setError('')
    try { setSessions(await window.api.listAiChatSessions({ mode: 'library' })) }
    catch (reason: unknown) { setError(getErrorMessage(reason, '读取研究历史失败')) }
    finally { setLoadingHistory(false) }
  }
  const loadEarlier = async () => {
    if (!sessionId || !answers[0]?.createdAt || running || loadingHistory) return
    const current = ++generation.current
    setLoadingHistory(true)
    try {
      const older = await window.api.getAiChatTurnsPage(sessionId, answers[0].createdAt, 30)
      if (current !== generation.current) return
      const existing = new Set(answers.map((item) => item.id))
      const added = older.filter((turn) => !existing.has(turn.id)).map(turnAnswer)
      setAnswers((items) => [...added, ...items]); setAnswerIndex((index) => index + added.length); setHasEarlier(older.length >= 30)
    } catch (reason: unknown) { if (current === generation.current) setError(getErrorMessage(reason, '读取更早的提问失败')) }
    finally { if (current === generation.current) setLoadingHistory(false) }
  }
  const saveSource = async (source: EvidenceQaSource, index: number) => {
    if (!answer || sourceLock.current) return
    const id = `${answer.id}:${index}`
    sourceLock.current = true; setSavingSource(id)
    try {
      await window.api.createResearchNote({ project_id: projectId, doc_id: source.doc_id, page_num: source.page_num, excerpt: source.snippet.replace(/<<|>>/g, ''),
        note: `研究问题：${answer.question}\n核验状态：待核验`, source_type: 'ai', kind: 'quote',
        locator: source.locator || null, source_hash: source.source_hash,
        source_id: JSON.stringify({ sourceType: 'ai_evidence_qa', question: answer.question, sessionId, turnId: answer.id, locator: source.locator || null }),
      })
      setCollected((items) => new Set([...items, id])); message.success(projectId ? '证据已存入当前专题' : '已收藏到摘录')
      if (projectId) window.dispatchEvent(new CustomEvent('gujismart:research-workspace-updated', { detail: { projectId } }))
    } catch (reason: unknown) { message.error(getErrorMessage(reason, '收藏证据失败')) }
    finally { sourceLock.current = false; setSavingSource(undefined) }
  }
  const saveAnswer = async () => {
    if (!projectId || !answer?.text || running || answerLock.current || savedAnswers.has(answer.id)) return
    answerLock.current = true; setSavingAnswer(true)
    try {
      const sources = answer.sources.map((source, index) => `### [${index + 1}] ${source.doc_title}${source.page_num ? ` · 第 ${source.page_num} 页` : ''}\n\n${source.snippet.replace(/<<|>>/g, '')}`).join('\n\n')
      await window.api.createResearchOutput({ project_id: projectId, output_type: 'custom', title: answer.question.slice(0, 120),
        content: `> AI 回答，尚未经研究者核验。\n\n${answer.text}\n\n${answer.warnings.length ? `## 核验提醒\n\n${answer.warnings.join('\n\n')}\n\n` : ''}## 原文依据\n\n${sources || '未返回可核验的原文出处'}\n\n对话记录：${sessionId} / ${answer.id}` })
      setSavedAnswers((items) => new Set([...items, answer.id])); message.success('回答与原文依据已保存到专题研究结果')
      window.dispatchEvent(new CustomEvent('gujismart:research-workspace-updated', { detail: { projectId } }))
    } catch (reason: unknown) { message.error(getErrorMessage(reason, '保存回答失败')) }
    finally { answerLock.current = false; setSavingAnswer(false) }
  }
  const openSource = (source: EvidenceQaSource) => onOpenDocument?.({ docId: source.doc_id,
    pageIndex: source.locator?.pageIndex ?? Math.max(0, (source.page_num || 1) - 1), locator: source.locator,
    excerpt: source.snippet, highlightExcerpt: source.snippet.replace(/<<|>>/g, ''), sourceLabel: source.doc_title, revealToc: true,
  })

  return <div className="knowledge-question gs-view-container">
    <header className="knowledge-question-header"><Space>
      <Button icon={<ClockCircleOutlined />} disabled={running || loadingHistory} onClick={() => void showHistory()}>研究历史</Button>
      <Tooltip title="新问题，不携带之前的对话"><Button aria-label="新问题" icon={<PlusOutlined />} disabled={running || loadingHistory} onClick={() => { setSessionId(''); setAnswers([]); setAnswerIndex(0); setQuestion(''); setError(''); setPhase(''); setHasEarlier(false) }} /></Tooltip>
    </Space></header>
    <section className="knowledge-question-compose" aria-label="向文献提问">
      <Input.TextArea aria-label="想研究的问题" placeholder="你想从这些文献中了解什么？" value={question} onChange={(event) => setQuestion(event.target.value)} autoSize={{ minRows: 3, maxRows: 6 }} maxLength={12000} disabled={running} />
      <div className="knowledge-question-submit"><Space wrap><LlmProfileSelector disabled={running} /><Typography.Text type="secondary">聊天与向量请求按服务商计费</Typography.Text></Space>
        <Space wrap><Button icon={<FileSearchOutlined />} disabled={!question.trim() || !preview?.ocrReadyCount || !!previewError || loadingHistory || previewLoading || loadingProjectScope || running || corpusBusy} onClick={() => setCorpusOpen(true)}>全范围专题研究</Button>
          <Button type="primary" icon={<SendOutlined />} disabled={!question.trim() || !preview?.ocrReadyCount || !!previewError || loadingHistory || previewLoading || loadingProjectScope} loading={running} onClick={() => void ask()}>{answers.length ? '继续追问' : '查找并回答'}</Button></Space></div>
    </section>
    <CorpusResearchPanel key={`${libraryProjectId}:${projectId || 'temporary'}`} libraryProjectId={libraryProjectId} projectId={projectId} scope={scope} question={question} preview={preview}
      open={corpusOpen} onClose={() => setCorpusOpen(false)} onBusyChange={setCorpusBusy} onOpenDocument={onOpenDocument} />
    {previewError && <Alert type="error" showIcon message={previewError} />}
    {storageError && <Alert type="warning" showIcon message={storageError} />}
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" disabled={running} icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(error).catch(() => message.error('复制错误失败'))}>复制错误</Button>} />}
    {(running || phase) && <div className="knowledge-question-progress" role="status" aria-live="polite">{running && <Spin size="small" />}<span>{phase}{running ? ` · 已用时 ${elapsed} 秒` : ''}</span>{running && <Typography.Text type="secondary">按所选范围检索相关片段</Typography.Text>}</div>}
    <div className="knowledge-question-results">
      <main className="knowledge-question-answer">
        {hasEarlier && <Button type="text" disabled={running} loading={loadingHistory} onClick={() => void loadEarlier()}>更早的提问</Button>}
        {loadingHistory ? <Spin /> : answer ? <>
          <div className="knowledge-question-result-heading"><Typography.Title level={5}>{answer.question}</Typography.Title>
            <Space><Select aria-label="查看回答" value={answerIndex} disabled={running} onChange={setAnswerIndex} options={answers.map((item, index) => ({ value: index, label: `第 ${index + 1} 问：${item.question}` }))} />
              {projectId && <Button icon={<SaveOutlined />} loading={savingAnswer} disabled={!answer.text || running} onClick={() => savedAnswers.has(answer.id) ? onOpenResearch('ai') : void saveAnswer()}>{savedAnswers.has(answer.id) ? '查看专题成果' : '保存回答'}</Button>}
              <Tooltip title="复制回答"><Button aria-label="复制回答" icon={<CopyOutlined />} disabled={!answer.text || running} onClick={() => void navigator.clipboard.writeText(answer.text).then(() => message.success('已复制回答')).catch(() => message.error('复制回答失败'))} /></Tooltip></Space></div>
          {answer.warnings.map((warning, index) => <Alert key={index} type="warning" showIcon message={warning} />)}
          <AiMarkdown content={answer.text} sources={answer.sources} prompt={answer.question} onOpenDocument={onOpenDocument} />
          {!answer.text && !running && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无完整回答" />}
        </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={preview?.count ? '等待你的问题' : '尚未选择文献'} />}
      </main>
      {answer && <aside className="knowledge-question-sources" aria-label="回答依据"><Typography.Title level={5}>原文依据 <Tag>{answer.sources.length}</Tag></Typography.Title>
        <List dataSource={answer.sources} pagination={answer.sources.length > 6 ? { pageSize: 6, size: 'small', simple: true } : false} locale={{ emptyText: running ? '正在查找出处' : '没有可供核对的原文出处' }} renderItem={(source) => {
          const index = answer.sources.indexOf(source)
          const id = `${answer.id}:${index}`
          return <List.Item><div><Typography.Text strong>[{index + 1}] {source.doc_title}</Typography.Text><Typography.Paragraph type="secondary">{source.page_num ? `第 ${source.page_num} 页` : '页码未知'}</Typography.Paragraph>
            <Typography.Paragraph ellipsis={{ rows: 5, expandable: true, symbol: '展开' }}>{source.snippet.replace(/<<|>>/g, '')}</Typography.Paragraph>
            <Space wrap><Button size="small" icon={<FileSearchOutlined />} disabled={!onOpenDocument} onClick={() => openSource(source)}>看原文</Button>
              <Button size="small" icon={<StarOutlined />} disabled={running || (collected.has(id) && !projectId) || !source.snippet.trim()} loading={savingSource === id} onClick={() => collected.has(id) && projectId ? onOpenResearch('evidence') : void saveSource(source, index)}>{collected.has(id) ? (projectId ? '查看专题证据' : '已收藏') : (projectId ? '存入专题' : '收藏证据')}</Button></Space>
          </div></List.Item>
        }} />
      </aside>}
    </div>
    <Drawer title="研究历史" open={historyOpen} onClose={() => setHistoryOpen(false)} width={440}>
      {error && <Alert type="error" showIcon message={error} />}
      <List loading={loadingHistory} dataSource={sessions} locale={{ emptyText: '暂无已保存的研究对话' }} renderItem={(session) => <List.Item>
        <Button type="link" className="knowledge-question-history-item" onClick={async () => {
          const selectedScope = parseScope(json(session.scope_json))
          if (!selectedScope) { setError('这条历史缺少有效的文献范围，请从原 AI 对话查看'); return }
          await loadSession(session.id, selectedScope); setHistoryOpen(false)
        }}>{session.title}<Typography.Text type="secondary">{session.updated_at?.slice(0, 10)} · {session.message_count || 0} 次提问</Typography.Text></Button>
      </List.Item>} />
    </Drawer>
  </div>
}
