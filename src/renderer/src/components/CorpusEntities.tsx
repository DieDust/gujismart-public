import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Input, Modal, Space, Table, Tag, Tooltip } from 'antd'
import { FileSearchOutlined, MergeCellsOutlined, SplitCellsOutlined, UndoOutlined, ReloadOutlined } from '@ant-design/icons'
import type { CorpusEntityMention, CorpusEntityPage, CorpusEntityReview, OpenDocumentTarget } from '@shared/types'
import { getErrorMessage } from '@shared/errors'

const KINDS = { person: '人物', place: '地点', organization: '机构', time: '时间', event: '事件' }
export default function CorpusEntities({ taskId, onOpenDocument }: { taskId: string; onOpenDocument?: (target: OpenDocumentTarget) => void }) {
  const [result, setResult] = useState<CorpusEntityPage>()
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [candidatesOnly, setCandidatesOnly] = useState(false)
  const [groupId, setGroupId] = useState<string>()
  const [candidateOfId, setCandidateOfId] = useState<string>()
  const [selected, setSelected] = useState<string[]>([])
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<CorpusEntityReview['action']>()
  const [reason, setReason] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1) }, 300)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    setSelected([])
  }, [taskId, query, candidatesOnly, groupId, candidateOfId, reload])
  useEffect(() => {
    let active = true
    setLoading(true)
    void window.api.listCorpusEntities(taskId, { search: query, offset: (page - 1) * 20, limit: 20, candidatesOnly, groupId, candidateOfId })
      .then((value) => { if (active) { setResult(value); setError(''); if (page > 1 && (page - 1) * 20 >= value.total) setPage(1) } })
      .catch((cause: unknown) => { if (active) setError(getErrorMessage(cause, '读取实体失败')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [taskId, query, page, candidatesOnly, groupId, candidateOfId, reload])
  const review = async () => {
    if (!result || !action || saving || !reason.trim()) return
    setSaving(true)
    try {
      await window.api.reviewCorpusEntities(taskId, { revision: result.revision, action, mentionIds: action === 'undo' ? [] : selected, reason })
      setAction(undefined); setReason(''); setSelected([]); setReload((value) => value + 1)
    } catch (cause: unknown) { setError(getErrorMessage(cause, '核对保存失败')) }
    finally { setSaving(false) }
  }
  const begin = (value: CorpusEntityReview['action']) => { setAction(value); setReason(''); setError('') }
  return <section aria-label="实体核对">
    <Space wrap style={{ marginBottom: 12 }}>
      <Input.Search aria-label="搜索实体名称或文献" placeholder="名称、别名或文献" value={search} allowClear onChange={(event) => setSearch(event.target.value)} style={{ width: 240, maxWidth: '100%' }} />
      <Checkbox checked={candidatesOnly} onChange={(event) => { setCandidatesOnly(event.target.checked); setPage(1) }}>仅同名与别名候选</Checkbox>
      <Button icon={<MergeCellsOutlined />} disabled={loading || selected.length < 2} onClick={() => begin('merge')}>确认为同一对象</Button>
      <Button icon={<SplitCellsOutlined />} disabled={loading || !selected.length} onClick={() => begin('split')}>独立保留</Button>
      <Tooltip title="撤销上次实体核对"><Button aria-label="撤销实体核对" icon={<UndoOutlined />} disabled={!result?.canUndo || loading} onClick={() => begin('undo')} /></Tooltip>
      <Tooltip title="刷新实体"><Button aria-label="刷新实体" icon={<ReloadOutlined />} disabled={loading} onClick={() => setReload((value) => value + 1)} /></Tooltip>
      {(groupId || candidateOfId) && <Button onClick={() => { setGroupId(undefined); setCandidateOfId(undefined); setPage(1) }}>全部对象</Button>}
    </Space>
    {error && !action && <Alert type="error" showIcon message={error} />}
    {!!result?.unprocessedFindings && <Alert type="warning" showIcon message={`${result.unprocessedFindings} 条旧发现未提取实体；原结果保留，新建全范围研究可使用新版流程。`} />}
    <Table<CorpusEntityMention> rowKey="id" size="small" tableLayout="fixed" loading={loading} dataSource={result?.items || []} scroll={{ x: 780 }}
      rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: (keys) => setSelected(keys.map(String)), getCheckboxProps: (item) => ({ disabled: selected.length >= 100 && !selected.includes(item.id) }) }}
      pagination={{ current: page, total: result?.total || 0, pageSize: 20, showSizeChanger: false, onChange: setPage }}
      expandable={{ expandedRowRender: (item) => <article>
        <p>{item.source.claim}</p><blockquote style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.source.quote}</blockquote>
        {item.source.uncertainty && <p>{item.source.uncertainty}</p>}
        <Button icon={<FileSearchOutlined />} disabled={!onOpenDocument || item.source.sourceStatus === 'missing'} onClick={() => onOpenDocument?.({ docId: item.source.docId,
          pageIndex: Math.max(0, item.source.pageNum - 1), stableLocator: item.source.stableLocator, excerpt: item.source.quote, highlightExcerpt: item.source.quote })}>查看原文 · 文件第 {item.source.pageNum} 页</Button>
      </article> }}
      columns={[
        { title: '原文名称', dataIndex: 'name', width: 160, render: (name: string, item) => <><strong>{name}</strong><div><Tag>{KINDS[item.kind]}</Tag></div></> },
        { title: '称谓与核对', width: 230, render: (_, item) => <>
          <div>{item.reviewed ? '人工核对' : '自动整理 · 待核验'}</div>
          {item.aliases.length > 0 && <div>原文别名：{item.aliases.join('、')}</div>}
          {item.suggestedAliases.length > 0 && <div>待核别名：{item.suggestedAliases.join('、')}</div>}
          {item.candidateCount > 0 && <Button type="link" size="small" onClick={() => { setSearch(''); setGroupId(undefined); setCandidateOfId(item.id); setPage(1) }}>核对同名与别名</Button>}
        </> },
        { title: '出处', width: 230, render: (_, item) => <>{item.source.title}<div>文件第 {item.source.pageNum} 页</div>{item.source.sourceStatus !== 'current' && <Tag color="warning">{item.source.sourceStatus === 'missing' ? '来源缺失' : '正文已修改'}</Tag>}</> },
        { title: '对象组', width: 130, render: (_, item) => <Button type="link" onClick={() => { setGroupId(item.groupId); setCandidateOfId(undefined); setCandidatesOnly(false); setSearch(''); setPage(1) }}>{item.groupSize} 条记录</Button> },
      ]} />
    {!!result?.history.length && <details><summary>最近核对记录</summary><ul>{result.history.map((item) => <li key={item.id}>{({ merge: '归并', split: '独立保留', undo: '撤销' })[item.action]}：{item.reason}</li>)}</ul></details>}
    <Modal title={action === 'merge' ? '确认对象归并' : action === 'split' ? '独立保留所选记录' : '撤销上次核对'} open={!!action} onCancel={() => { if (!saving) setAction(undefined) }}
      confirmLoading={saving} okButtonProps={{ disabled: !reason.trim() }} onOk={() => void review()} maskClosable={!saving} closable={!saving} cancelButtonProps={{ disabled: saving }}>
      <p>{action === 'merge' ? '所选记录所属的整个对象组将归并。原文与引注不改动，核对操作可撤销。' : action === 'split' ? '所选记录各自独立，原文别名退回待核候选；其他记录保留，操作可撤销。' : '恢复上次核对之前的对象分组，保留操作记录。'}</p>
      <Input.TextArea aria-label="实体核对依据" placeholder="填写年代、地点、字号等核对依据" maxLength={1000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      {error && <Alert type="error" showIcon message={error} />}
    </Modal>
  </section>
}
