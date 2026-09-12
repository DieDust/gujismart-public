import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Empty, Input, InputNumber, List, Modal, Progress, Select, Space, Spin, Table, Tag, Typography, message } from 'antd'
import { FileSearchOutlined, PauseOutlined, PlayCircleOutlined, ReloadOutlined, StarOutlined } from '@ant-design/icons'
import type { CorpusResearchCreatePayload, CorpusResearchDocumentRow, CorpusResearchFinding, CorpusResearchPageOptions, CorpusResearchStatus, LibraryAiScope, LibraryAiScopePreview, OpenDocumentTarget, StableReaderLocator } from '@shared/types'
import { getErrorMessage } from '@shared/errors'
import AiMarkdown from './AiMarkdown'
import CorpusEntities from './CorpusEntities'
import './CorpusResearchPanel.css'

interface Props {
  libraryProjectId: string
  projectId?: string
  scope: LibraryAiScope
  question: string
  preview?: LibraryAiScopePreview
  open: boolean
  onClose: () => void
  onBusyChange: (busy: boolean) => void
  onOpenDocument?: (target: OpenDocumentTarget) => void
}

const PHASES: Record<string, string> = { preparing: '准备正文', ready: '等待启动', extract: '逐块研究', report: '生成报告', budget: '请求预算已用尽', interrupted: '执行已中断', paused: '已暂停' }
const STANCES = { support: '支持', challenge: '反证 / 分歧', context: '背景' }
const validLimit = (value: number | null, min = 1) => value !== null && Number.isInteger(value) && value >= min && value <= 10000
const findingLocator = (finding: CorpusResearchFinding): StableReaderLocator => finding.stableLocator || ({
  schemaVersion: 'stable-reader-locator/v2', precision: 'page', documentId: finding.docId,
  sourcePageId: finding.pageId, pageNum: finding.pageNum, sourceHash: finding.sourceHash,
  verificationStatus: 'legacy-unverified',
})

function Findings({ taskId, docId, revision, onOpenDocument, onCollect, savingId, collected }: {
  taskId: string; docId: string; revision: string; onOpenDocument?: Props['onOpenDocument']
  onCollect: (finding: CorpusResearchFinding) => void; savingId?: string; collected: Set<string>
}) {
  const [items, setItems] = useState<CorpusResearchFinding[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true)
    void window.api.listCorpusResearchFindings(taskId, { docId, offset: (page - 1) * 10, limit: 10 })
      .then((result) => { if (active) { setItems(result.items); setTotal(result.total); setError('') } })
      .catch((reason: unknown) => { if (active) setError(getErrorMessage(reason, '读取研究发现失败')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [taskId, docId, page, revision])
  const openSource = (finding: CorpusResearchFinding) => {
    if (finding.sourceStatus === 'stale') message.warning('正文已修改，以下引句保留自研究快照，请重新核对当前原文。')
    if (finding.sourceStatus === 'missing') message.warning('来源不可用，当前仅保留研究快照；原文可能无法打开。')
    onOpenDocument?.({
    docId: finding.docId, pageIndex: Math.max(0, finding.pageNum - 1),
    stableLocator: findingLocator(finding),
    excerpt: finding.quote, highlightExcerpt: finding.quote, sourceId: finding.id,
    sourceLabel: finding.title, revealToc: true,
    })
  }
  return <div className="corpus-findings">
    {error && <Alert showIcon type="error" message={error} />}
    <List loading={loading} dataSource={items} locale={{ emptyText: '本次处理尚未识别到相关发现' }}
      pagination={total > 10 ? { current: page, total, pageSize: 10, onChange: setPage, size: 'small', showSizeChanger: false } : false}
      renderItem={(finding) => <List.Item key={finding.id}><article>
        <Space wrap><Tag>{STANCES[finding.stance]}</Tag><Typography.Text type="secondary">{finding.dimension}</Typography.Text><Tag>待核验</Tag></Space>
        {finding.sourceStatus === 'stale' && <Tag color="warning">正文已修改</Tag>}
        {finding.sourceStatus === 'missing' && <Tag color="error">来源不可用</Tag>}
        <Typography.Paragraph strong>{finding.claim}</Typography.Paragraph>
        <blockquote>{finding.quote}</blockquote>
        {finding.uncertainty && <Typography.Paragraph type="warning">{finding.uncertainty}</Typography.Paragraph>}
        <Space wrap><Button size="small" icon={<FileSearchOutlined />} disabled={!onOpenDocument} onClick={() => openSource(finding)}>{finding.title} · 文件第 {finding.pageNum} 页</Button>
          <Button size="small" icon={<StarOutlined />} loading={savingId === finding.id} disabled={!!savingId || collected.has(finding.id) || !finding.quote.trim() || finding.sourceStatus === 'stale' || finding.sourceStatus === 'missing'} onClick={() => onCollect(finding)}>{collected.has(finding.id) ? '已收藏' : '收藏摘录'}</Button></Space>
      </article></List.Item>} />
  </div>
}

export default function CorpusResearchPanel(props: Props) {
  const [task, setTask] = useState<CorpusResearchStatus>()
  const [recent, setRecent] = useState<CorpusResearchStatus[]>([])
  const [recovering, setRecovering] = useState(true)
  const [pollError, setPollError] = useState('')
  const [actionError, setActionError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [reload, setReload] = useState(0)
  const [draft, setDraft] = useState<CorpusResearchCreatePayload>()
  const [draftCount, setDraftCount] = useState({ total: 0, readable: 0 })
  const [maxRequests, setMaxRequests] = useState<number | null>(20)
  const [reuseCompleted, setReuseCompleted] = useState(true)
  const [modalError, setModalError] = useState('')
  const [resumeMode, setResumeMode] = useState<'resume' | 'retry'>()
  const [additionalRequests, setAdditionalRequests] = useState<number | null>(0)
  const [documents, setDocuments] = useState<CorpusResearchDocumentRow[]>([])
  const [documentTotal, setDocumentTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [documentLoading, setDocumentLoading] = useState(false)
  const [documentError, setDocumentError] = useState('')
  const [expanded, setExpanded] = useState<React.Key[]>([])
  const [sort, setSort] = useState<NonNullable<CorpusResearchPageOptions['sort']>>('title')
  const [descending, setDescending] = useState(false)
  const [savingFinding, setSavingFinding] = useState<string>()
  const [collected, setCollected] = useState<Set<string>>(new Set())
  const sourceLock = useRef(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  const createdId = useRef<string>()
  const taskId = task?.id
  const taskIdRef = useRef(taskId)
  taskIdRef.current = taskId

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    // Background work must not lock the workspace after the request is accepted.
    props.onBusyChange(props.open || !!resumeMode || submitting || recovering || !!savingFinding)
  }, [props.open, resumeMode, submitting, recovering, savingFinding, props.onBusyChange])
  useEffect(() => {
    if (!props.open) return
    setDraft({ scope: props.scope, question: props.question.trim(), projectId: props.projectId, requestKey: crypto.randomUUID(), maxRequests: 20 })
    setDraftCount({ total: props.preview?.count || 0, readable: props.preview?.ocrReadyCount || 0 })
    setMaxRequests(20); setReuseCompleted(true); setModalError(''); createdId.current = undefined
  }, [props.open])
  useEffect(() => {
    let active = true
    setRecovering(true)
    void window.api.listCorpusResearch(props.projectId).then((items) => {
      if (!active) return
      const scoped = items.filter((item) => item.projectId === (props.projectId || null))
      setRecent(scoped)
      setTask((current) => current || scoped.find((item) => item.active) || scoped[0])
      setPollError('')
    }).catch((reason: unknown) => { if (active) setPollError(getErrorMessage(reason, '恢复专题研究任务失败')) })
      .finally(() => { if (active) setRecovering(false) })
    return () => { active = false }
  }, [props.libraryProjectId, props.projectId, reload])
  useEffect(() => {
    if (!taskId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const result = await window.api.getCorpusResearch(taskId)
        if (!active) return
        setTask(result); setPollError('')
        setRecent((items) => items.map((item) => item.id === result.id ? result : item))
      } catch (reason: unknown) {
        if (active) setPollError(getErrorMessage(reason, '读取研究进度失败'))
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 2500)
      }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [taskId, reload])
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1) }, 300)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => { setPage(1); setSearch(''); setQuery(''); setExpanded([]); setDocuments([]) }, [taskId])
  useEffect(() => {
    if (!taskId) return
    let active = true
    setDocumentLoading(true)
    void window.api.listCorpusResearchDocuments(taskId, { offset: (page - 1) * pageSize, limit: pageSize, search: query, sort, descending })
      .then((result) => {
        if (!active) return
        setDocuments(result.items); setDocumentTotal(result.total); setDocumentError('')
        if (page > 1 && (page - 1) * pageSize >= result.total) setPage(Math.max(1, Math.ceil(result.total / pageSize)))
      }).catch((reason: unknown) => { if (active) setDocumentError(getErrorMessage(reason, '读取文献研究表失败')) })
      .finally(() => { if (active) setDocumentLoading(false) })
    return () => { active = false }
  }, [taskId, task?.updatedAt, page, pageSize, query, sort, descending, reload])

  const collectFinding = async (finding: CorpusResearchFinding) => {
    if (!task || sourceLock.current || collected.has(finding.id) || finding.sourceStatus === 'stale' || finding.sourceStatus === 'missing') return
    sourceLock.current = true; setSavingFinding(finding.id); setActionError('')
    try {
      await window.api.createResearchNote({
        project_id: task.projectId, doc_id: finding.docId, page_num: finding.pageNum,
        excerpt: finding.quote, locator: findingLocator(finding), source_hash: finding.sourceHash,
        source_type: 'ai_research', kind: 'quote',
        source_id: JSON.stringify({ sourceType: 'corpus_research', taskId: task.id, findingId: finding.id }),
        note: `研究问题：${task.question}\n核验状态：待核验\n研究维度：${finding.dimension}\n证据用途：${STANCES[finding.stance]}\nAI 主张（待核验）：${finding.claim}${finding.uncertainty ? `\n不确定性：${finding.uncertainty}` : ''}`,
      })
      if (!mounted.current) return
      setCollected((items) => new Set([...items, finding.id])); message.success('原文引句已收藏为摘录，待核验')
      if (task.projectId) window.dispatchEvent(new CustomEvent('gujismart:research-workspace-updated', { detail: { projectId: task.projectId } }))
    } catch (reason: unknown) { if (mounted.current) setActionError(getErrorMessage(reason, '收藏原文摘录失败')) }
    finally { sourceLock.current = false; if (mounted.current) setSavingFinding(undefined) }
  }

  const acceptTask = (value: CorpusResearchStatus) => {
    setTask(value)
    setRecent((items) => [value, ...items.filter((item) => item.id !== value.id)].slice(0, 50))
  }
  const createAndStart = async () => {
    if (lock.current || !draft || !validLimit(maxRequests)) return
    lock.current = true; setSubmitting(true); setModalError('')
    try {
      // Reuse the snapshot after a failed start; never create another task to retry it.
      const snapshot = createdId.current ? await window.api.getCorpusResearch(createdId.current)
        : await window.api.createCorpusResearch({ ...draft, maxRequests: maxRequests as number, reuseCompleted })
      createdId.current = snapshot.id
      if (!mounted.current) return
      acceptTask(snapshot)
      const started = snapshot.active || snapshot.status === 'completed' ? snapshot : await window.api.startCorpusResearch(snapshot.id)
      if (!mounted.current) return
      acceptTask(started); props.onClose()
    } catch (reason: unknown) {
      if (mounted.current) setModalError(getErrorMessage(reason, '创建或启动研究失败；可重试，已创建的任务会保留'))
    } finally {
      lock.current = false
      if (mounted.current) setSubmitting(false)
    }
  }
  const pause = async () => {
    if (!task || lock.current) return
    lock.current = true; setSubmitting(true); setActionError('')
    try {
      const result = await window.api.pauseCorpusResearch(task.id)
      if (mounted.current && taskIdRef.current === result.id) acceptTask(result)
    } catch (reason: unknown) { if (mounted.current) setActionError(getErrorMessage(reason, '暂停研究失败')) }
    finally { lock.current = false; if (mounted.current) setSubmitting(false) }
  }
  const resume = async () => {
    if (!task || lock.current || !resumeMode || !validLimit(additionalRequests, 0)) return
    lock.current = true; setSubmitting(true); setModalError('')
    try {
      const result = await window.api.startCorpusResearch(task.id, {
        retryFailed: resumeMode === 'retry',
        ...(additionalRequests ? { additionalRequests } : {}),
      })
      if (!mounted.current) return
      acceptTask(result); setResumeMode(undefined); setActionError('')
    } catch (reason: unknown) {
      if (mounted.current) setModalError(getErrorMessage(reason, '继续研究失败；请先刷新任务状态再重试'))
    } finally { lock.current = false; if (mounted.current) setSubmitting(false) }
  }
  const openResume = (mode: 'resume' | 'retry') => {
    setResumeMode(mode); setAdditionalRequests(0); setModalError('')
  }
  const hasGaps = !!task && (task.failedUnits > 0 || task.pendingUnits > 0 || task.completedUnits < task.totalUnits)
  const complete = !!task && task.status === 'completed' && !hasGaps && !task.error && !!task.report
  const statusLabel = !task ? '' : task.active ? task.status === 'paused' ? '正在暂停' : PHASES[task.phase] || '研究中'
    : complete ? '全文处理与报告已结束' : task.status === 'paused' ? PHASES[task.phase] || '已暂停'
      : task.status === 'error' ? task.phase === 'report' ? '报告失败' : '研究失败'
        : task.status === 'completed' ? '部分完成' : PHASES[task.phase] || '等待继续'

  return <>
    {(task || recovering || pollError) && <section className="corpus-research" aria-label="全范围专题研究">
      <div className="corpus-research-heading"><Typography.Title level={5}>全范围专题研究</Typography.Title>
        <Space wrap><Select aria-label="专题研究任务" value={taskId} disabled={submitting || props.open || !!resumeMode || !!savingFinding} className="corpus-task-select"
          options={recent.map((item) => ({ value: item.id, label: item.question }))}
          onChange={(id) => { setTask(recent.find((item) => item.id === id)); setActionError('') }} />
          <Button aria-label="刷新专题研究" icon={<ReloadOutlined />} disabled={submitting} onClick={() => setReload((value) => value + 1)} />
        </Space></div>
      {recovering && <Spin size="small" />}
      {pollError && <Alert type="warning" showIcon message={pollError} />}
      {actionError && <Alert type="error" showIcon message={actionError} />}
      {task && <>
        <Typography.Paragraph strong>{task.question}</Typography.Paragraph>
        <div className="corpus-research-status" role="status" aria-live="polite">
          <Space wrap><Tag color={complete ? 'success' : task.error ? 'error' : 'processing'}>{statusLabel}</Tag>
            <span>{task.totalDocuments} 篇文献</span><span>已处理 {task.completedUnits}/{task.totalUnits} 块</span>
            <span>失败 {task.failedUnits} 块</span><span>待处理 {task.pendingUnits} 块</span><span>{task.findings} 条发现</span></Space>
          {task.totalUnits > 0 && <Progress percent={Math.min(complete ? 100 : 99, Math.floor(task.completedUnits / task.totalUnits * 100))}
            status={task.active ? 'active' : complete ? 'success' : 'normal'} showInfo={false} aria-label="正文块处理进度" />}
          <Typography.Text type="secondary">请求 {task.requests}/{task.maxRequests} 次；已回报输入 {task.inputTokens} / 输出 {task.outputTokens} Token（{task.measuredRequests} 次请求有用量回报）</Typography.Text>
        </div>
        {!complete && <Alert type="warning" showIcon message="阶段结果，不代表完整覆盖" description="未处理、缺文或失败的材料不等于不相关。已保存的发现仍需核验。" />}
        {task.error && <Alert type="error" showIcon message={task.phase === 'report' ? '报告失败，已保存材料保留' : '处理异常'} description={task.error} />}
        <Space wrap className="corpus-research-actions">
          {task.active ? <Button icon={<PauseOutlined />} loading={submitting} disabled={task.status === 'paused'} onClick={() => void pause()}>暂停</Button>
            : <><Button icon={<PlayCircleOutlined />} disabled={submitting || complete || props.open} onClick={() => openResume('resume')}>继续研究</Button>
              {(task.failedUnits > 0 || task.error || task.status === 'error') && <Button icon={<ReloadOutlined />} disabled={submitting || props.open} onClick={() => openResume('retry')}>{task.phase === 'report' && !task.failedUnits ? '重试报告' : '重试失败项'}</Button>}</>}
          {task.active && <Typography.Text type="secondary">暂停停止后续调度，在途请求仍可能计费。</Typography.Text>}
        </Space>
        {task.report && <div className="corpus-research-report"><Typography.Title level={5}>综合概览 · 待核验，完整发现见研究表</Typography.Title>
          <AiMarkdown content={task.report} sources={task.reportSources} prompt={task.question} onOpenDocument={props.onOpenDocument} /></div>}
        <Collapse ghost items={[{ key: 'entities', label: '实体核对 · 人物、地点、机构与别名', children: <CorpusEntities key={task.id} taskId={task.id} onOpenDocument={props.onOpenDocument} /> }]} />
        <div className="corpus-research-table-heading"><Typography.Title level={5}>文献研究表</Typography.Title>
          <Input.Search aria-label="搜索研究文献" placeholder="搜索文献" allowClear value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        {documentError && <Alert type="error" showIcon message={documentError} />}
        <Table<CorpusResearchDocumentRow> rowKey="docId" size="small" tableLayout="fixed" loading={documentLoading} dataSource={documents} scroll={{ x: 660 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无匹配文献" /> }}
          pagination={{ current: page, pageSize, total: documentTotal, showSizeChanger: true, pageSizeOptions: [20, 50, 100], onChange: (next, size) => { setPage(size !== pageSize ? 1 : next); setPageSize(size); setExpanded([]) } }}
          onChange={(_pagination, _filters, sorter, extra) => {
            if (extra.action !== 'sort') return
            const selected = Array.isArray(sorter) ? sorter[0] : sorter
            const key = selected.columnKey
            if (key === 'title' || key === 'completed' || key === 'findings' || key === 'failed') {
              setSort(selected.order ? key : 'title'); setDescending(selected.order === 'descend'); setPage(1); setExpanded([])
            }
          }}
          expandable={{ expandedRowKeys: expanded, onExpandedRowsChange: (keys) => setExpanded([...keys]),
            expandedRowRender: (row) => <Findings key={`${task.id}:${row.docId}`} taskId={task.id} docId={row.docId} revision={`${task.updatedAt}:${reload}`} onOpenDocument={props.onOpenDocument}
              onCollect={(finding) => void collectFinding(finding)} savingId={savingFinding} collected={collected} /> }}
          columns={[
            { title: '文献', key: 'title', dataIndex: 'title', width: 240, sorter: true, sortOrder: sort === 'title' ? descending ? 'descend' : 'ascend' : null },
            { title: '已处理 / 总块数', key: 'completed', width: 135, sorter: true, sortOrder: sort === 'completed' ? descending ? 'descend' : 'ascend' : null, render: (_, row) => `${row.completedUnits} / ${row.totalUnits}` },
            { title: '发现', key: 'findings', dataIndex: 'findings', width: 80, sorter: true, sortOrder: sort === 'findings' ? descending ? 'descend' : 'ascend' : null },
            { title: '状态', key: 'failed', width: 190, sorter: true, sortOrder: sort === 'failed' ? descending ? 'descend' : 'ascend' : null, render: (_, row) => <><Tag color={row.error || row.failedUnits ? 'error' : row.completedUnits === row.totalUnits && row.totalUnits > 0 ? 'success' : 'default'}>
              {row.error || row.failedUnits ? `处理异常${row.failedUnits ? `（${row.failedUnits} 块）` : ''}` : !row.totalUnits ? '无可用正文' : row.completedUnits === row.totalUnits ? '处理结束 · 待核验' : '待处理 / 处理中'}</Tag>{row.error && <div>{row.error}</div>}</> },
          ]} />
      </>}
    </section>}
    <Modal title="确认全范围专题研究" open={props.open} onCancel={() => { if (!lock.current) props.onClose() }} onOk={() => void createAndStart()}
      confirmLoading={submitting} okText={createdId.current ? '重试启动' : '确认并开始'} okButtonProps={{ disabled: !draft?.question || !draftCount.total || !validLimit(maxRequests) }} cancelButtonProps={{ disabled: submitting }} closable={!submitting} maskClosable={!submitting}>
      <Typography.Paragraph>{draft?.question}</Typography.Paragraph>
      <Typography.Paragraph>本次范围：{draftCount.total} 篇文献，{draftCount.readable} 篇检测到可用文本。</Typography.Paragraph>
      <Alert type="warning" showIcon message="将调用付费 AI 服务" description="按当前模型的服务商价格计费。请求数上限不是金额上限；预算用尽后暂停，结果可能不完整。" />
      <Alert type="warning" showIcon message={draftCount.readable < draftCount.total ? `${draftCount.total - draftCount.readable} 篇未检测到可用文本` : 'OCR 完整性仍需核对'} description="有文本不代表所有页面均已识别。缺失正文不会作为无关材料排除；全文处理状态以后台台账为准。" />
      <label className="corpus-budget">最多模型请求次数<InputNumber aria-label="最多模型请求次数" min={1} max={10000} precision={0} value={maxRequests} disabled={submitting || !!createdId.current} onChange={setMaxRequests} /></label>
      <Checkbox checked={reuseCompleted} disabled={submitting || !!createdId.current} onChange={(event) => setReuseCompleted(event.target.checked)}>复用相同问题、正文和模型的成功结果</Checkbox>
      {modalError && <Alert type="error" showIcon message={modalError} />}
    </Modal>
    <Modal title={resumeMode === 'retry' ? '确认重试失败阶段' : '确认继续研究'} open={!!resumeMode} onCancel={() => { if (!lock.current) setResumeMode(undefined) }} onOk={() => void resume()}
      confirmLoading={submitting} okText="确认继续" okButtonProps={{ disabled: !validLimit(additionalRequests, 0) || !!task?.active }} cancelButtonProps={{ disabled: submitting }} closable={!submitting} maskClosable={!submitting}>
      <Typography.Paragraph>{task?.question}</Typography.Paragraph>
      <Alert type="warning" showIcon message="继续执行可能产生模型费用" description={`当前已请求 ${task?.requests || 0}/${task?.maxRequests || 0} 次。增加额度只在本次确认后生效；0 表示不增加额度。`} />
      <label className="corpus-budget">追加请求额度<InputNumber aria-label="追加请求额度" min={0} max={10000} precision={0} value={additionalRequests} onChange={setAdditionalRequests} disabled={submitting} /></label>
      {modalError && <Alert type="error" showIcon message={modalError} />}
    </Modal>
  </>
}
