import { useEffect, useMemo } from 'react'
import { Alert, Divider, Form, Input, Modal, Select, message } from 'antd'
import {
  HISTORY_DOC_TYPE_CONFIGS,
  getHistoryDocTypeConfig,
  getHistoryMetadataFields,
  normalizeHistoryDocType,
} from '@shared/history-citation'
import type { Document, DocumentUpdatePayload } from '@shared/types'

const { TextArea } = Input

type MetadataEditorDocument = Pick<Document, 'id' | 'title' | 'author' | 'doc_type'> & {
  metadata?: string | null
}
type MetadataEditorMetadata = Record<string, unknown>
type MetadataEditorBaseInfo = Pick<DocumentUpdatePayload, 'title' | 'author' | 'doc_type' | 'metadata_status'>

interface MetadataEditorProps {
  visible: boolean
  document: MetadataEditorDocument | null
  onCancel: () => void
  onSave: (newMetadata: MetadataEditorMetadata, newBaseInfo: MetadataEditorBaseInfo) => Promise<void>
}

function ensureChineseYear(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  if (/\d{4}\s*年|不详|月|日/.test(text)) return text
  return /^\d{4}$/.test(text) ? `${text} 年` : text
}

function ensurePageReference(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  if (/第|页|版|栏|a$|b$/i.test(text)) return text
  return /^\d+([—-]\d+)?$/.test(text) ? `第 ${text} 页` : text
}

function parseMetadata(rawMetadata?: string | null): MetadataEditorMetadata {
  if (!rawMetadata) return {}
  try {
    const parsed = JSON.parse(rawMetadata) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as MetadataEditorMetadata
      : {}
  } catch {
    return {}
  }
}

function omitBaseMetadataFields(metadata: MetadataEditorMetadata): MetadataEditorMetadata {
  const {
    title: _title,
    author: _author,
    doc_type: _docType,
    metadata_status: _metadataStatus,
    ...metadataFields
  } = metadata
  return metadataFields
}

export default function MetadataEditor({ visible, document, onCancel, onSave }: MetadataEditorProps) {
  const [form] = Form.useForm()

  useEffect(() => {
    if (!visible || !document) return

    const metadata = parseMetadata(document.metadata)
    const metadataFields = omitBaseMetadataFields(metadata)
    form.setFieldsValue({
      ...metadataFields,
      title: document.title,
      author: document.author,
      doc_type: normalizeHistoryDocType(document.doc_type),
      keywords: Array.isArray(metadata.keywords) ? metadata.keywords.join('，') : metadata.keywords,
    })
  }, [document, form, visible])

  const docType = Form.useWatch('doc_type', form) || '其他'
  const activeDocType = normalizeHistoryDocType(docType)
  const activeConfig = useMemo(() => getHistoryDocTypeConfig(activeDocType), [activeDocType])
  const extraFields = useMemo(() => getHistoryMetadataFields(activeDocType), [activeDocType])

  const handleOk = async () => {
    const values = await form.validateFields()
    const { title, author, doc_type, ...metadataValues } = values

    const cleanMetadata: MetadataEditorMetadata = {}
    for (const [key, value] of Object.entries(metadataValues as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      const normalized = typeof value === 'string' ? value.trim() : value
      if (normalized === '') continue
      cleanMetadata[key] = key === 'keywords'
        ? String(value).split(/[，,;；\n]/).map((item) => item.trim()).filter(Boolean)
        : normalized
    }
    if (cleanMetadata.publication_year && !cleanMetadata.publication_time) {
      cleanMetadata.publication_time = ensureChineseYear(cleanMetadata.publication_year)
    }
    if (cleanMetadata.pages && !cleanMetadata.page_reference) {
      cleanMetadata.page_reference = ensurePageReference(cleanMetadata.pages)
    }
    if (typeof title === 'string' && title.trim()) {
      cleanMetadata.title = title.trim()
    }
    if (typeof author === 'string' && author.trim()) {
      cleanMetadata.author = author.trim()
    }
    cleanMetadata._doc_type = normalizeHistoryDocType(doc_type)

    await onSave(cleanMetadata, {
      title,
      author,
      doc_type: normalizeHistoryDocType(doc_type),
      metadata_status: 'confirmed',
    })
    message.success('元数据已保存')
    onCancel()
  }

  return (
    <Modal
      title="编辑文献元数据"
      open={visible}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      width={760}
      okText="保存"
      cancelText="取消"
    >
      <Form form={form} layout="vertical" initialValues={{ doc_type: '其他' }}>
        <Divider orientation="left">基本信息</Divider>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: '0 16px' }}>
          <Form.Item name="title" label="文献标题" rules={[{ required: true, message: '请输入文献标题' }]}>
            <Input />
          </Form.Item>

          <Form.Item name="doc_type" label="文献类型">
            <Select
              showSearch
              optionFilterProp="label"
              options={HISTORY_DOC_TYPE_CONFIGS.map((item) => ({
                value: item.value,
                label: item.label,
              }))}
            />
          </Form.Item>

          <Form.Item name="author" label="作者">
            <Input />
          </Form.Item>
        </div>

        <Divider orientation="left">详细字段</Divider>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={activeConfig.label}
          description={activeConfig.description}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          {extraFields.map((field) => (
            <Form.Item
              key={field.key}
              name={field.key}
              label={field.label}
              extra={field.placeholder}
              style={{ gridColumn: field.type === 'textarea' ? '1 / span 2' : undefined }}
            >
              {field.type === 'textarea' ? <TextArea rows={3} /> : <Input />}
            </Form.Item>
          ))}
        </div>
      </Form>

    </Modal>
  )
}
