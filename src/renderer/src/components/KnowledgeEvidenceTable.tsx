import { useMemo, useState } from 'react'
import { Button, Input, Select, Space, Table, Tag, Typography } from 'antd'
import { FileSearchOutlined, SaveOutlined } from '@ant-design/icons'
import type { AiResearchDataset, AiResearchRecord } from '@shared/types'
import { getResearchDatasetFields, researchRecordValues } from '@shared/research-graph'

export function evidenceFieldText(record: AiResearchRecord, datasets: AiResearchDataset[]): string {
  const dataset = datasets.find((item) => item.id === record.dataset_id)
  const fields = dataset ? getResearchDatasetFields(dataset, [record]) : []
  return Object.entries(researchRecordValues(record)).filter(([, value]) => value !== '' && value != null)
    .map(([key, value]) => `${fields.find((field) => field.key === key)?.label || key}：${String(value)}`).join('\n')
}

interface Props {
  records: AiResearchRecord[]
  datasets: AiResearchDataset[]
  selectedId?: string
  confirmedOnly: boolean
  onSelect: (id: string) => void
  onOpen: (record: AiResearchRecord) => void
  onCollect: (record: AiResearchRecord) => void
  canOpen: boolean
}

export default function KnowledgeEvidenceTable(props: Props) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('active')
  const rows = useMemo(() => props.records.map((record) => ({ ...record, fieldText: evidenceFieldText(record, props.datasets) }))
    .filter((record) => {
      if (props.confirmedOnly && record.status !== 'confirmed') return false
      if (status === 'active' ? record.status === 'excluded' : status !== 'all' && record.status !== status) return false
      return [record.doc_title, record.excerpt, record.note, record.fieldText].join('\n').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    }), [props.records, props.datasets, props.confirmedOnly, search, status])
  return <section className="knowledge-materials" aria-label="材料核验">
    <div className="knowledge-table-bar">
      <Input aria-label="搜索核验材料" allowClear placeholder="原文、抽取内容、考证备注" value={search} onChange={(event) => setSearch(event.target.value)} />
      <Select aria-label="材料核验状态" value={status} onChange={setStatus} options={[
        { value: 'active', label: '未排除材料' }, { value: 'pending', label: '待核验' },
        { value: 'confirmed', label: '已确认' }, { value: 'excluded', label: '已排除' }, { value: 'all', label: '全部状态' },
      ]} />
      <Typography.Text type="secondary">{rows.length} 条 · {new Set(rows.map((row) => row.doc_id)).size} 部文献</Typography.Text>
    </div>
    <Table rowKey="id" size="small" tableLayout="fixed" dataSource={rows} scroll={{ x: 740 }}
      pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }}
      rowClassName={(record) => record.id === props.selectedId ? 'knowledge-row-selected' : ''}
      columns={[
        { title: '文献 / 页码', key: 'source', width: 165, sorter: (a, b) => (a.doc_title || '').localeCompare(b.doc_title || '', 'zh-CN') || (a.page_num || 0) - (b.page_num || 0),
          render: (_, record) => <Button type="link" onClick={() => props.onSelect(record.id)}>{record.doc_title || '未命名文献'}<br />{record.page_num ? `第 ${record.page_num} 页` : '页码未知'}</Button> },
        { title: '原文摘录', key: 'excerpt', width: 260, render: (_, record) => <Typography.Paragraph ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}>{record.excerpt || '无原文摘录'}</Typography.Paragraph> },
        { title: '抽取内容（非研究结论）', key: 'fields', width: 260, render: (_, record) => <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }} ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}>{record.fieldText || '无结构化字段'}</Typography.Paragraph> },
        { title: '核验', key: 'status', width: 110, sorter: (a, b) => a.status.localeCompare(b.status), render: (_, record) => <Tag color={record.status === 'confirmed' ? 'green' : record.status === 'excluded' ? undefined : 'gold'}>{record.status === 'confirmed' ? '已确认' : record.status === 'excluded' ? '已排除' : '待核验'}</Tag> },
        { title: '处理', key: 'actions', width: 155, render: (_, record) => <Space wrap>
          <Button size="small" icon={<FileSearchOutlined />} disabled={!props.canOpen || !record.doc_id} onClick={() => props.onOpen(record)}>原文</Button>
          <Button size="small" icon={<SaveOutlined />} disabled={record.status === 'excluded' || !record.doc_id || !record.excerpt} onClick={() => props.onCollect(record)}>存入专题</Button>
          <Button size="small" type="link" onClick={() => props.onSelect(record.id)}>核验 / 修订</Button>
        </Space> },
      ]} />
  </section>
}
