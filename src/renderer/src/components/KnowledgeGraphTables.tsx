import { useDeferredValue, useMemo, useState } from 'react'
import { Button, Input, Select, Table, Tooltip, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { ApartmentOutlined, SearchOutlined } from '@ant-design/icons'
import type { AiResearchRecord } from '@shared/types'
import type { ResearchGraph } from '@shared/research-graph'
import { buildGraphStudyRows, compareGraphStudyText, filterGraphStudyRows, type GraphStudyRow, type GraphStudyView } from '../utils/graphStudyRows'

interface Props {
  graph: ResearchGraph
  records: AiResearchRecord[]
  view: GraphStudyView
  selectedId?: string
  onSelect: (id: string) => void
  onExplore: (id: string) => void
}

export default function KnowledgeGraphTables({ graph, records, view, selectedId, onSelect, onExplore }: Props) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [review, setReview] = useState<'all' | 'pending' | 'confirmed'>('all')
  const rows = useMemo(() => buildGraphStudyRows(graph, records, view), [graph, records, view])
  const filtered = useMemo(() => filterGraphStudyRows(rows, deferredQuery, review), [rows, deferredQuery, review])
  const text = (title: string, key: keyof GraphStudyRow, width = 150): TableColumnsType<GraphStudyRow>[number] => ({
    title, dataIndex: key, key, width,
    sorter: (a, b) => compareGraphStudyText(String(a[key]), String(b[key])),
    render: (value: string) => value ? <Tooltip title={value}><span className="knowledge-cell-text">{value}</span></Tooltip> : <Typography.Text type="secondary">未记载</Typography.Text>,
  })
  const numeric = (title: string, key: 'recordCount' | 'documentCount' | 'pendingCount'): TableColumnsType<GraphStudyRow>[number] => ({
    title, dataIndex: key, key, width: 110, sorter: (a, b) => a[key] - b[key],
    render: (value: number, row) => <Button type="link" onClick={() => onSelect(row.id)}>{value}</Button>,
  })
  const names = { people: '人物姓名', places: '地名原称', events: '事件原称', relations: '关系陈述 / 线索', timeline: '原文时间表述' }
  const name: TableColumnsType<GraphStudyRow>[number] = {
    ...text(names[view], 'name', 170), fixed: 'left',
    render: (value: string, row) => <Button type="link" onClick={() => onSelect(row.id)}>{value}</Button>,
  }
  const specific: TableColumnsType<GraphStudyRow> = view === 'people'
    ? [name, text('同条材料人物', 'people'), text('涉及地点', 'places'), text('原文时间', 'times'), text('相关事件', 'events')]
    : view === 'places'
      ? [name, text('涉及人物', 'people'), text('相关事件', 'events'), text('原文时间', 'times'), text('同条材料地名', 'places')]
      : view === 'events'
        ? [name, text('涉及人物', 'people'), text('涉及地点', 'places'), text('原文时间', 'times')]
        : view === 'timeline'
          ? [name, text('涉及人物', 'people'), text('涉及地点', 'places'), text('相关事件', 'events')]
          : [text('主体', 'source'), name, text('客体', 'target'), text('方向性质', 'direction', 120), text('原文时间', 'times')]
  const columns: TableColumnsType<GraphStudyRow> = [
    ...specific, numeric('材料条数', 'recordCount'), numeric('文献数', 'documentCount'), numeric('待核验材料', 'pendingCount'), text('文献出处', 'documents', 200),
    ...(view === 'relations' ? [] : [{
      title: '关联', key: 'explore', width: 64, render: (_: unknown, row: GraphStudyRow) =>
        <Tooltip title="查看关联网络"><Button aria-label={`查看${row.name}的关联网络`} icon={<ApartmentOutlined />} onClick={() => onExplore(row.id)} /></Tooltip>,
    }]),
  ]
  return <section className="knowledge-study-table">
    <div className="knowledge-table-bar">
      <Input aria-label="搜索考察表" prefix={<SearchOutlined />} placeholder="姓名、地名、事件、出处、原文" allowClear value={query}
        onChange={(event) => setQuery(event.target.value)} />
      <Select aria-label="材料核验筛选" value={review} onChange={setReview} options={[
        { value: 'all', label: '全部核验状态' }, { value: 'pending', label: '含待核验材料' }, { value: 'confirmed', label: '材料全部已确认' },
      ]} />
      <Typography.Text type="secondary">{filtered.length} / {rows.length} 项</Typography.Text>
    </div>
    <Table<GraphStudyRow> size="small" rowKey="id" dataSource={filtered} columns={columns}
      rowClassName={(row) => row.id === selectedId ? 'knowledge-row-selected' : ''}
      pagination={{ defaultPageSize: 12, showSizeChanger: true, pageSizeOptions: [12, 25, 50], showTotal: (total) => `${total} 项` }}
      scroll={{ x: 'max-content' }} onRow={(row) => ({ onClick: () => onSelect(row.id) })} />
  </section>
}
