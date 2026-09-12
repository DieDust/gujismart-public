import { useEffect, useRef, useState } from 'react'
import { Alert, Form, Input, Modal, Select, Typography, message } from 'antd'
import type { AiResearchDataset, AiResearchRecord, ResearchProject } from '@shared/types'
import { getErrorMessage } from '@shared/errors'
import { researchRecordValues } from '@shared/research-graph'
import { evidenceFieldText } from './KnowledgeEvidenceTable'

interface Props {
  record?: AiResearchRecord
  datasets: AiResearchDataset[]
  projects: ResearchProject[]
  projectId?: string
  question: string
  onClose: () => void
}

export default function CollectResearchEvidence({ record, datasets, projects, projectId, question, onClose }: Props) {
  const [form] = Form.useForm<{ projectId: string; relevance: string; interpretation: string }>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  useEffect(() => {
    if (!record) return
    setError('')
    form.resetFields()
    form.setFieldsValue({ projectId, relevance: '待判断', interpretation: record.note || '' })
  }, [record, projectId, form])
  const save = async () => {
    if (!record || locked.current) return
    const values = await form.validateFields().catch(() => null)
    if (!values || locked.current) return
    locked.current = true
    setSaving(true)
    setError('')
    try {
      await window.api.createResearchNote({
        project_id: values.projectId, doc_id: record.doc_id, page_num: record.page_num,
        excerpt: record.excerpt, locator_json: record.locator_json, source_hash: record.source_hash,
        source_type: 'ai_research', kind: 'quote',
        source_id: JSON.stringify({ sourceType: 'ai_research', datasetId: record.dataset_id, recordId: record.id, values: researchRecordValues(record) }),
        note: [question.trim() ? `研究问题：${question.trim()}` : '', `证据用途：${values.relevance}`,
          `保存时核验状态：${record.status === 'confirmed' ? '已确认' : '待核验'}`,
          values.interpretation.trim() ? `研究者按语：${values.interpretation.trim()}` : '',
          `抽取内容（保留供复核）：\n${evidenceFieldText(record, datasets)}`].filter(Boolean).join('\n\n'),
        tags: ['知识图谱', values.relevance],
      })
      window.dispatchEvent(new CustomEvent('gujismart:research-workspace-updated', { detail: { projectId: values.projectId } }))
      message.success('已存入研究专题的摘录，原文与研究者按语分别保留')
      onClose()
    } catch (reason: unknown) { setError(getErrorMessage(reason, '保存专题证据失败')) }
    finally { locked.current = false; setSaving(false) }
  }
  return <Modal title="存入研究专题" open={!!record} onCancel={() => { if (!saving) onClose() }} onOk={() => void save()} okText="保存摘录" confirmLoading={saving} cancelButtonProps={{ disabled: saving }}>
    {error && <Alert type="error" showIcon message={error} />}
    <Typography.Paragraph strong>{record?.doc_title || '原文'} · {record?.page_num ? `第 ${record.page_num} 页` : '页码未知'}</Typography.Paragraph>
    <Typography.Paragraph ellipsis={{ rows: 5, expandable: true, symbol: '展开原文' }}>{record?.excerpt}</Typography.Paragraph>
    <Form form={form} layout="vertical">
      <Form.Item name="projectId" label="研究专题" rules={[{ required: true, message: '请选择研究专题' }]}><Select showSearch optionFilterProp="label" options={projects.filter((project) => project.status !== 'archived').map((project) => ({ value: project.id, label: project.name }))} /></Form.Item>
      <Form.Item name="relevance" label="与研究问题的关系"><Select options={['待判断', '支持材料', '反证材料', '背景材料', '相互矛盾的记载'].map((value) => ({ value, label: value }))} /></Form.Item>
      <Form.Item name="interpretation" label="研究者按语"><Input.TextArea rows={4} maxLength={20000} /></Form.Item>
    </Form>
  </Modal>
}
