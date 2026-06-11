import { useEffect, useMemo, useRef, useState, type ElementRef } from 'react'
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd'
import { CopyOutlined, DeleteOutlined, EditOutlined, FileSearchOutlined, PlusOutlined, RobotOutlined, UploadOutlined } from '@ant-design/icons'
import {
  CITATION_FORMAT_COLORS,
  CITATION_FORMAT_LABELS,
  CITATION_FORMAT_ORDER,
  CITATION_PLACEHOLDER_LABELS,
  CITATION_SAMPLE_DOC,
  DEFAULT_HISTORY_CITATION_TEMPLATES,
  HISTORY_CITATION_TEMPLATE_DEFAULTS,
} from '@shared/history-citation'
import type { CitationStyle, CitationStyleDraft, CitationTemplate, CitationTemplateInference } from '@shared/types'
import { getErrorMessage } from '@shared/errors'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input
type CitationTextAreaRef = ElementRef<typeof TextArea>

const PLACEHOLDER_LABELS: Record<string, string> = CITATION_PLACEHOLDER_LABELS
const SAMPLE_DOC: Record<string, string> = CITATION_SAMPLE_DOC
const FORMAT_TYPES: Record<string, string> = CITATION_FORMAT_LABELS
const DOCUMENT_TYPE_ORDER = CITATION_FORMAT_ORDER
const PRESET_TEMPLATES = DEFAULT_HISTORY_CITATION_TEMPLATES.map((template) => ({
  name: template.name,
  format_type: template.format_type,
  template_text: template.template_text,
  is_default: template.is_default,
}))
const FORMAT_TYPE_DEFAULTS: Record<string, string> = HISTORY_CITATION_TEMPLATE_DEFAULTS
const FORMAT_TYPE_COLORS: Record<string, string> = CITATION_FORMAT_COLORS

function normalizeTemplateText(templateText: string): string {
  if (!templateText) return ''
  return templateText
    .trim()
    .replace(/｛｛/g, '{{')
    .replace(/｝｝/g, '}}')
    .replace(/(^|[^{])\{([a-z_][a-z0-9_]*)\}(?!})/gi, (_match, prefix: string, key: string) => `${prefix}{{${key}}}`)
}

function toDisplayText(templateText: string): string {
  if (!templateText) return ''
  return normalizeTemplateText(templateText).replace(/\{\{(\w+)\}\}/g, (_, key: string) => `【${PLACEHOLDER_LABELS[key] || key}】`)
}

function toStorageText(displayText: string): string {
  if (!displayText) return ''
  const reverseMap: Record<string, string> = {}
  Object.entries(PLACEHOLDER_LABELS).forEach(([key, label]) => {
    reverseMap[label] = key
  })
  const storageText = displayText.replace(/【([^】]+)】/g, (_, label: string) => {
    const key = reverseMap[label]
    return key ? `{{${key}}}` : `【${label}】`
  })
  return normalizeTemplateText(storageText)
}

function renderPreview(templateText: string): string {
  if (!templateText) return ''
  return normalizeTemplateText(templateText)
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => SAMPLE_DOC[key] || '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export default function CitationView() {
  const [templates, setTemplates] = useState<CitationTemplate[]>([])
  const [styles, setStyles] = useState<CitationStyle[]>([])
  const [selectedStyleId, setSelectedStyleId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [initialized, setInitialized] = useState(false)
  const [styleModalVisible, setStyleModalVisible] = useState(false)
  const [editingStyle, setEditingStyle] = useState<CitationStyle | null>(null)
  const [editModalVisible, setEditModalVisible] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<CitationTemplate | null>(null)
  const [editingFormatType, setEditingFormatType] = useState<string>('monograph')
  const [templateText, setTemplateText] = useState('')
  const [previewResult, setPreviewResult] = useState('')
  const [previewModalVisible, setPreviewModalVisible] = useState(false)
  const [previewTitle, setPreviewTitle] = useState('预览结果')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [aiModalVisible, setAiModalVisible] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState<CitationTemplateInference | null>(null)
  const [ruleModalVisible, setRuleModalVisible] = useState(false)
  const [ruleFilePath, setRuleFilePath] = useState('')
  const [ruleLoading, setRuleLoading] = useState(false)
  const [ruleSaving, setRuleSaving] = useState(false)
  const [ruleDraft, setRuleDraft] = useState<CitationStyleDraft | null>(null)

  const [form] = Form.useForm()
  const [styleForm] = Form.useForm()
  const [aiForm] = Form.useForm()
  const textAreaRef = useRef<CitationTextAreaRef>(null)

  useEffect(() => {
    void loadTemplates()
  }, [])

  const templatesByType = useMemo(() => {
    const grouped: Record<string, CitationTemplate> = {}
    const scopedTemplates = selectedStyleId
      ? templates.filter((template) => template.style_id === selectedStyleId)
      : templates
    scopedTemplates.forEach((template) => {
      const type = template.format_type || 'Custom'
      if (!DOCUMENT_TYPE_ORDER.includes(type)) return
      if (!grouped[type] || template.is_default || grouped[type].name.localeCompare(template.name, 'zh-Hans-CN') > 0) {
        grouped[type] = template
      }
    })
    return grouped
  }, [selectedStyleId, templates])

  const configuredTypeCount = useMemo(
    () => DOCUMENT_TYPE_ORDER.filter((type) => templatesByType[type]).length,
    [templatesByType],
  )

  const selectedStyle = useMemo(
    () => styles.find((style) => style.id === selectedStyleId) || styles[0] || null,
    [selectedStyleId, styles],
  )

  async function loadTemplates() {
    setLoading(true)
    try {
      const [styleData, templateData] = await Promise.all([
        window.api.listCitationStyles(),
        window.api.listCitationTemplates(),
      ])
      const nextStyles = Array.isArray(styleData) ? styleData : []
      const fallbackStyleId = nextStyles.find((style) => style.is_default)?.id || nextStyles[0]?.id || 'style_default_academic'
      const nextTemplates = (Array.isArray(templateData) ? templateData : []).map((template) => ({
        ...template,
        style_id: template.style_id || fallbackStyleId,
      }))
      setStyles(nextStyles)
      setTemplates(nextTemplates)
      setSelectedStyleId((current) => current || fallbackStyleId)
      if (!initialized && nextTemplates.length === 0) {
        await initPresetTemplates()
        setInitialized(true)
      }
    } catch (error) {
      console.error(error)
      message.error('加载引用模板失败')
    } finally {
      setLoading(false)
    }
  }

  async function initPresetTemplates() {
    try {
      for (const template of PRESET_TEMPLATES) {
        await window.api.createCitationTemplate({ ...template, style_id: selectedStyleId || undefined })
      }
      await loadTemplates()
    } catch (error) {
      console.error(error)
      message.error('初始化预设模板失败')
    }
  }

  function openSlotModal(formatType = 'monograph') {
    const existing = templatesByType[formatType] || null
    setEditingTemplate(existing)
    setEditingFormatType(formatType)
    const selectedStyleName = selectedStyle?.name || '引用标准'
    const defaultType = formatType
    const defaultText = toDisplayText(FORMAT_TYPE_DEFAULTS[defaultType] || '')
    const displayText = existing ? toDisplayText(existing.template_text || '') : defaultText
    form.resetFields()
    form.setFieldsValue({
      name: existing?.name || `${selectedStyleName} / ${FORMAT_TYPES[formatType] || formatType}`,
      style_id: selectedStyleId,
      format_type: defaultType,
      template_text: displayText,
    })
    setTemplateText(displayText)
    setEditModalVisible(true)
  }

  function openCreateModal() {
    openSlotModal('monograph')
  }

  function openEditModal(template: CitationTemplate) {
    setEditingTemplate(template)
    setEditingFormatType(template.format_type || 'monograph')
    const displayText = toDisplayText(template.template_text || '')
    form.setFieldsValue({
      name: template.name,
      style_id: template.style_id || selectedStyleId,
      format_type: template.format_type,
      template_text: displayText,
    })
    setTemplateText(displayText)
    setEditModalVisible(true)
  }

  async function handleSave() {
    try {
      const values = await form.validateFields()
      const payload = {
        ...values,
        style_id: values.style_id || selectedStyleId,
        template_text: toStorageText(values.template_text),
      }
      const duplicateSlot = templates.find((template) => (
        template.style_id === payload.style_id
        && template.format_type === payload.format_type
        && template.id !== editingTemplate?.id
      ))

      if (editingTemplate) {
        await window.api.updateCitationTemplate(editingTemplate.id, payload)
        message.success('类型格式已更新')
      } else if (duplicateSlot) {
        await window.api.updateCitationTemplate(duplicateSlot.id, payload)
        message.success('已更新该文献类型的原有格式')
      } else {
        await window.api.createCitationTemplate(payload)
        message.success('类型格式已创建')
      }

      setEditModalVisible(false)
      setEditingTemplate(null)
      setEditingFormatType('monograph')
      void loadTemplates()
    } catch (error) {
      console.error(error)
    }
  }

  function handleDelete(id: string) {
    Modal.confirm({
      title: '删除确认',
      content: '确定要清空这个文献类型的引用格式吗？',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.api.deleteCitationTemplate(id)
        message.success('类型格式已清空')
        void loadTemplates()
      },
    })
  }

  function openCreateStyleModal() {
    setEditingStyle(null)
    styleForm.resetFields()
    styleForm.setFieldsValue({ name: '', description: '', is_default: styles.length === 0 })
    setStyleModalVisible(true)
  }

  function openRuleModal() {
    setRuleFilePath('')
    setRuleDraft(null)
    setRuleLoading(false)
    setRuleSaving(false)
    setRuleModalVisible(true)
  }

  async function handleSelectRuleFile() {
    try {
      const filePath = await window.api.selectCitationRuleFile()
      if (filePath) {
        setRuleFilePath(filePath)
        setRuleDraft(null)
      }
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '选择规范文件失败'))
    }
  }

  async function handleInferRuleStyle() {
    if (!ruleFilePath) {
      message.warning('请先选择一份引用规范文件')
      return
    }

    try {
      setRuleLoading(true)
      const draft = await window.api.inferCitationStyleFromRuleFile(ruleFilePath)
      setRuleDraft({
        styleName: draft.styleName,
        description: draft.description,
        templates: Array.isArray(draft.templates) ? draft.templates : [],
        notes: draft.notes,
      })
      message.success(`已生成 ${draft.templates?.length || 0} 个类型模板`)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '规范解析失败'))
    } finally {
      setRuleLoading(false)
    }
  }

  async function handleCreateStyleFromRule() {
    if (!ruleDraft) return

    try {
      setRuleSaving(true)
      const style = await window.api.createCitationStyleFromDraft(ruleDraft)
      setSelectedStyleId(style.id)
      setRuleModalVisible(false)
      setRuleDraft(null)
      await loadTemplates()
      setSelectedStyleId(style.id)
      message.success(`已创建“${style.name || ruleDraft.styleName}”`)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '保存引用标准失败'))
    } finally {
      setRuleSaving(false)
    }
  }

  function openEditStyleModal(style: CitationStyle) {
    setEditingStyle(style)
    styleForm.setFieldsValue({
      name: style.name,
      description: style.description || '',
      is_default: !!style.is_default,
    })
    setStyleModalVisible(true)
  }

  async function handleSaveStyle() {
    try {
      const values = await styleForm.validateFields()
      if (editingStyle) {
        await window.api.updateCitationStyle(editingStyle.id, {
          name: values.name,
          description: values.description || '',
          is_default: values.is_default ? 1 : 0,
        })
        message.success('引用标准已更新')
      } else {
        const style = await window.api.createCitationStyle({
          name: values.name,
          description: values.description || '',
          is_default: values.is_default ? 1 : 0,
        })
        setSelectedStyleId(style.id)
        message.success('引用标准已创建')
      }
      setStyleModalVisible(false)
      setEditingStyle(null)
      void loadTemplates()
    } catch (error) {
      console.error(error)
    }
  }

  function handleDeleteStyle(style: CitationStyle) {
    Modal.confirm({
      title: '删除引用标准',
      content: `确定要删除“${style.name}”吗？该标准下的类型模板也会一起删除。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.api.deleteCitationStyle(style.id)
        message.success('引用标准已删除')
        setSelectedStyleId('')
        void loadTemplates()
      },
    })
  }

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text)
    message.success('已复制到剪贴板')
  }

  function handleSamplePreview(title: string, templateText: string) {
    setPreviewModalVisible(true)
    setPreviewTitle(`${title} / 示例预览`)
    setPreviewResult(renderPreview(templateText))
    setPreviewLoading(false)
  }

  async function handlePreview(template: CitationTemplate) {
    setPreviewModalVisible(true)
    setPreviewTitle(`${template.name} / 实际文献预览`)
    setPreviewResult('')
    setPreviewLoading(true)
    try {
      const docs = await window.api.listDocuments({ limit: 1 })
      if (docs.length === 0) {
        setPreviewTitle(`${template.name} / 示例预览`)
        setPreviewResult(renderPreview(template.template_text))
        message.info('暂无文献，已显示示例预览')
        return
      }

      const result = await window.api.generateCitation(docs[0].id, template.id)
      setPreviewTitle(`${template.name} / ${docs[0].title || '实际文献'}`)
      setPreviewResult(result || renderPreview(template.template_text))
    } catch (error: unknown) {
      console.error(error)
      setPreviewTitle(`${template.name} / 示例预览`)
      setPreviewResult(renderPreview(template.template_text))
      message.warning(getErrorMessage(error, '实际文献预览失败，已显示示例预览'))
    } finally {
      setPreviewLoading(false)
    }
  }

  function insertPlaceholder(key: string) {
    const textarea = textAreaRef.current?.resizableTextArea?.textArea as HTMLTextAreaElement | undefined
    const current = (form.getFieldValue('template_text') as string) || ''
    const insertion = `【${PLACEHOLDER_LABELS[key] || key}】`

    let nextText: string
    if (textarea) {
      const start = textarea.selectionStart ?? current.length
      const end = textarea.selectionEnd ?? current.length
      nextText = current.slice(0, start) + insertion + current.slice(end)
      form.setFieldValue('template_text', nextText)
      setTemplateText(nextText)
      setTimeout(() => {
        textarea.focus()
        textarea.setSelectionRange(start + insertion.length, start + insertion.length)
      }, 0)
      return
    }

    nextText = current + insertion
    form.setFieldValue('template_text', nextText)
    setTemplateText(nextText)
  }

  function openAiModal(formatType?: string) {
    aiForm.resetFields()
    if (formatType) {
      aiForm.setFieldsValue({ formatType })
    }
    setAiSuggestion(null)
    setAiModalVisible(true)
  }

  async function handleInferTemplate() {
    try {
      const values = await aiForm.validateFields()
      setAiLoading(true)
      const result = await window.api.inferCitationTemplateFromSample(values.sampleText, values.formatType || undefined)

      setAiSuggestion({
        nameSuggestion: result.nameSuggestion,
        formatType: result.formatType,
        templateText: result.templateText,
        notes: result.notes,
      })
      message.success('AI 已生成模板草稿')
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, 'AI 识别失败'))
    } finally {
      setAiLoading(false)
    }
  }

  function applyAiSuggestion() {
    if (!aiSuggestion) return
    const displayText = toDisplayText(aiSuggestion.templateText)
    const formatType = DOCUMENT_TYPE_ORDER.includes(aiSuggestion.formatType) ? aiSuggestion.formatType : 'monograph'
    setEditingTemplate(templatesByType[formatType] || null)
    setEditingFormatType(formatType)
    form.resetFields()
    form.setFieldsValue({
      name: aiSuggestion.nameSuggestion || `${selectedStyle?.name || '引用标准'} / ${FORMAT_TYPES[formatType] || formatType}`,
      style_id: selectedStyleId,
      format_type: formatType,
      template_text: displayText,
    })
    setTemplateText(displayText)
    setAiModalVisible(false)
    setEditModalVisible(true)
  }

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Title level={3} style={{ color: 'var(--gs-gold)', margin: 0 }}>
          引用格式管理
        </Title>
        <Space>
          <Button icon={<UploadOutlined />} onClick={openRuleModal}>
            上传规范生成标准
          </Button>
          <Button icon={<PlusOutlined />} onClick={openCreateStyleModal}>
            新建标准
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openSlotModal('monograph')}>
            设置类型格式
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="默认使用《历史研究》脚注注释体例"
        description="每个槽位对应规范中的一种文献类型。导出时选择这套标准后，系统会按元数据里的文献类型自动匹配专著、古籍、期刊、报纸、档案、电子文献等格式。"
      />

      <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
        <Card size="small" title="引用标准" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {styles.map((style) => (
              <button
                key={style.id}
                type="button"
                onClick={() => setSelectedStyleId(style.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: selectedStyleId === style.id ? '1px solid var(--gs-gold)' : '1px solid rgba(255,255,255,0.08)',
                  background: selectedStyleId === style.id ? 'rgba(191, 145, 91, 0.18)' : 'rgba(255,255,255,0.025)',
                  color: 'var(--gs-text-primary)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Text strong>{style.name}</Text>
                  {style.is_default ? <Tag color="gold">默认</Tag> : null}
                </div>
                {style.description ? <Text type="secondary" style={{ fontSize: 12 }}>{style.description}</Text> : null}
              </button>
            ))}
            {selectedStyle ? (
              <Space>
                <Button size="small" onClick={() => openEditStyleModal(selectedStyle)}>编辑标准</Button>
                <Button size="small" danger onClick={() => handleDeleteStyle(selectedStyle)}>删除</Button>
              </Space>
            ) : null}
          </Space>
        </Card>

        <div>
          {selectedStyle ? (
            <div style={{ marginBottom: 14 }}>
              <Title level={4} style={{ margin: 0, color: 'var(--gs-text-primary)' }}>{selectedStyle.name}</Title>
              <Text type="secondary">这是一整套脚注标准。下面每一行是一个规范类型槽位，每种类型最多使用一个格式；未设置的类型会在导出时回退到标准内已有格式或简明引用。</Text>
              <div style={{ marginTop: 8 }}>
                <Tag color="blue">{configuredTypeCount} / {DOCUMENT_TYPE_ORDER.length} 个类型已设置</Tag>
              </div>
            </div>
          ) : null}

          {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      ) : !selectedStyle ? (
        <Empty description="请先创建一套引用标准" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14 }}>
          {DOCUMENT_TYPE_ORDER.map((type) => {
            const template = templatesByType[type]
            const rawTemplateText = template?.template_text || FORMAT_TYPE_DEFAULTS[type] || ''
            const displayText = toDisplayText(rawTemplateText)
            return (
              <Card
                key={type}
                size="small"
                title={
                  <Space size={8}>
                    <Tag color={FORMAT_TYPE_COLORS[type] || 'default'} style={{ margin: 0 }}>{FORMAT_TYPES[type] || type}</Tag>
                    {template ? <Tag color="green">已设置</Tag> : <Tag>未设置</Tag>}
                  </Space>
                }
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {template ? template.name : '导出此类型文献时将使用这里设置的格式。'}
                  </Text>
                  <Paragraph ellipsis={{ rows: 2, expandable: true, symbol: '展开' }} style={{ color: 'var(--gs-text-secondary)', fontSize: 13, marginBottom: 0 }}>
                    <code style={{ background: 'rgba(255,255,255,0.04)', padding: '2px 6px', borderRadius: 3 }}>
                      {displayText || '尚未设置格式'}
                    </code>
                  </Paragraph>
                  <div style={{ fontSize: 12, color: 'var(--gs-text-tertiary)' }}>
                    示例预览：{rawTemplateText ? renderPreview(rawTemplateText) : '尚未设置格式'}
                  </div>
                  <Space wrap>
                    <Button size="small" type="primary" icon={<EditOutlined />} onClick={() => openSlotModal(type)}>
                      {template ? '编辑此类型' : '设置此类型'}
                    </Button>
                    <Button size="small" icon={<RobotOutlined />} onClick={() => openAiModal(type)}>
                      AI 识别
                    </Button>
                    <Button size="small" icon={<CopyOutlined />} disabled={!rawTemplateText} onClick={() => void handleCopy(rawTemplateText)}>
                      复制
                    </Button>
                    <Button size="small" disabled={!rawTemplateText} onClick={() => handleSamplePreview(FORMAT_TYPES[type] || type, rawTemplateText)}>
                      示例预览
                    </Button>
                    {template ? (
                      <>
                        <Button size="small" onClick={() => void handlePreview(template)}>
                          用实际文献预览
                        </Button>
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(template.id)}>
                          清空
                        </Button>
                      </>
                    ) : null}
                  </Space>
                </Space>
              </Card>
            )
          })}
        </div>
      )}
        </div>
      </div>

      <Modal
        title={previewTitle}
        open={previewModalVisible}
        onCancel={() => setPreviewModalVisible(false)}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} disabled={!previewResult} onClick={() => void handleCopy(previewResult)}>
            复制
          </Button>,
          <Button key="close" type="primary" onClick={() => setPreviewModalVisible(false)}>
            关闭
          </Button>,
        ]}
      >
        {previewLoading ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
        ) : (
          <Text style={{ color: 'var(--gs-text-primary)', fontSize: 14, lineHeight: 1.8 }}>{previewResult || '暂无可预览内容'}</Text>
        )}
      </Modal>

      <Modal
        title={editingStyle ? '编辑引用标准' : '新建引用标准'}
        open={styleModalVisible}
        onOk={() => void handleSaveStyle()}
        onCancel={() => setStyleModalVisible(false)}
        okText="保存"
        cancelText="取消"
      >
        <Form form={styleForm} layout="vertical">
          <Form.Item name="name" label="标准名称" rules={[{ required: true, message: '请输入标准名称' }]}>
            <Input placeholder="例如：《历史研究》脚注注释体例" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input placeholder="例如：用于论文脚注，按文献类型自动套用《历史研究》模板" />
          </Form.Item>
          <Form.Item name="is_default" label="是否默认">
            <Select
              options={[
                { value: false, label: '不是默认' },
                { value: true, label: '设为默认标准' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`${editingTemplate ? '编辑' : '设置'}「${selectedStyle?.name || '引用标准'} / ${FORMAT_TYPES[editingFormatType] || editingFormatType}」格式`}
        open={editModalVisible}
        onOk={() => void handleSave()}
        onCancel={() => setEditModalVisible(false)}
        width={720}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="style_id" label="所属引用标准" rules={[{ required: true, message: '请选择引用标准' }]}>
            <Select options={styles.map((style) => ({ value: style.id, label: style.name }))} />
          </Form.Item>

          <Form.Item name="name" label="类型格式名称" rules={[{ required: true, message: '请输入类型格式名称' }]}>
            <Input placeholder="例如：《历史研究》 / 专著" />
          </Form.Item>

          <Form.Item name="format_type" label="文献类型" rules={[{ required: true, message: '请选择文献类型' }]}>
            <Select
              options={DOCUMENT_TYPE_ORDER.map((value) => ({ value, label: FORMAT_TYPES[value] || value }))}
              onChange={(value) => {
                setEditingFormatType(value)
                const defaultText = FORMAT_TYPE_DEFAULTS[value] || ''
                if (!defaultText) return
                const displayText = toDisplayText(defaultText)
                form.setFieldValue('template_text', displayText)
                setTemplateText(displayText)
              }}
            />
          </Form.Item>

          <Form.Item
            name="template_text"
            label="模板文本"
            rules={[{ required: true, message: '请输入模板内容' }]}
            extra="点击下方字段按钮，可以把占位符插入到当前光标位置。"
          >
            <TextArea
              ref={textAreaRef}
              rows={5}
              placeholder="例如：责任者：《文献题名》，出版地点：出版者，出版时间，第 43 页。"
              onChange={(event) => setTemplateText(event.target.value)}
            />
          </Form.Item>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)', marginBottom: 6 }}>可用字段（点击插入）</div>
            <Space wrap size={[6, 6]}>
              {Object.entries(PLACEHOLDER_LABELS).map(([key, label]) => (
                <Button key={key} size="small" onClick={() => insertPlaceholder(key)} style={{ fontSize: 12 }}>
                  {label}
                </Button>
              ))}
            </Space>
          </div>

          {templateText ? (
            <div
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 13,
                color: 'var(--gs-text-secondary)',
              }}
            >
              <span style={{ color: 'var(--gs-text-tertiary)', fontSize: 11, marginRight: 8 }}>示例预览：</span>
              {renderPreview(toStorageText(templateText))}
            </div>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title="AI 识别引用模板"
        open={aiModalVisible}
        onCancel={() => setAiModalVisible(false)}
        width={760}
        footer={[
          <Button key="cancel" onClick={() => setAiModalVisible(false)}>
            取消
          </Button>,
          aiSuggestion ? (
            <Button key="apply" type="primary" onClick={applyAiSuggestion}>
              应用到新模板
            </Button>
          ) : null,
          <Button key="infer" type="primary" loading={aiLoading} onClick={() => void handleInferTemplate()}>
            开始识别
          </Button>,
        ]}
      >
        <Form form={aiForm} layout="vertical">
          <Form.Item
            name="sampleText"
            label="示例引用"
            rules={[{ required: true, message: '请粘贴一条已经确认正确的引用示例' }]}
            extra="示例越完整，AI 识别出的模板越稳定。建议直接粘贴一整条最终引用，而不是片段。"
          >
            <TextArea
              rows={5}
              placeholder="例如：赵景深：《文坛忆旧》，上海：北新书局，1948 年，第 43 页。"
            />
          </Form.Item>

          <Form.Item name="formatType" label="目标类型（可选）">
            <Select
              allowClear
              placeholder="不指定时由 AI 自动判断"
              options={DOCUMENT_TYPE_ORDER.map((value) => ({ value, label: FORMAT_TYPES[value] || value }))}
            />
          </Form.Item>
        </Form>

        {aiSuggestion ? (
          <Card
            size="small"
            title="AI 建议结果"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <div>
                <Text type="secondary">建议名称：</Text>
                <Text style={{ color: 'var(--gs-text-primary)' }}>{aiSuggestion.nameSuggestion}</Text>
              </div>
              <div>
                <Text type="secondary">识别类型：</Text>
                <Tag color={FORMAT_TYPE_COLORS[aiSuggestion.formatType] || 'default'}>
                  {FORMAT_TYPES[aiSuggestion.formatType] || aiSuggestion.formatType}
                </Tag>
              </div>
              <div>
                <Text type="secondary">模板草稿：</Text>
                <div style={{ marginTop: 6 }}>
                  <code style={{ background: 'rgba(255,255,255,0.04)', padding: '6px 8px', borderRadius: 4, display: 'inline-block' }}>
                    {toDisplayText(aiSuggestion.templateText)}
                  </code>
                </div>
              </div>
              <div>
                <Text type="secondary">示例预览：</Text>
                <div style={{ marginTop: 6, color: 'var(--gs-text-secondary)' }}>
                  {renderPreview(aiSuggestion.templateText)}
                </div>
              </div>
              {aiSuggestion.notes ? (
                <Alert type="warning" showIcon message="AI 备注" description={aiSuggestion.notes} />
              ) : null}
            </Space>
          </Card>
        ) : null}
      </Modal>

      <Modal
        title="上传引用规范生成标准"
        open={ruleModalVisible}
        onCancel={() => setRuleModalVisible(false)}
        width={860}
        footer={[
          <Button key="cancel" onClick={() => setRuleModalVisible(false)}>
            取消
          </Button>,
          <Button key="infer" icon={<FileSearchOutlined />} loading={ruleLoading} disabled={!ruleFilePath} onClick={() => void handleInferRuleStyle()}>
            解析规范
          </Button>,
          <Button key="save" type="primary" loading={ruleSaving} disabled={!ruleDraft || ruleDraft.templates.length === 0} onClick={() => void handleCreateStyleFromRule()}>
            创建引用标准
          </Button>,
        ]}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="从规范文件自动生成一整套引用标准"
            description="支持 PDF、DOCX、TXT、Markdown。AI 会读取规范中的示例和规则，生成标准名称以及专著、期刊、报纸、学位论文、电子文献等类型模板；保存前可以先预览。"
          />

          <div
            style={{
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.025)',
              borderRadius: 6,
              padding: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <Text strong style={{ color: 'var(--gs-text-primary)' }}>规范文件</Text>
              <div style={{ marginTop: 4 }}>
                <Text ellipsis title={ruleFilePath} style={{ color: ruleFilePath ? 'var(--gs-text-secondary)' : 'var(--gs-text-tertiary)' }}>
                  {ruleFilePath || '尚未选择文件'}
                </Text>
              </div>
            </div>
            <Button icon={<UploadOutlined />} onClick={() => void handleSelectRuleFile()}>
              选择文件
            </Button>
          </div>

          {ruleLoading ? (
            <div style={{ textAlign: 'center', padding: 36 }}>
              <Spin />
              <div style={{ marginTop: 12, color: 'var(--gs-text-secondary)' }}>正在分析规范并生成模板…</div>
            </div>
          ) : null}

          {ruleDraft ? (
            <Card
              size="small"
              title={ruleDraft.styleName}
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {ruleDraft.description ? (
                  <Text type="secondary">{ruleDraft.description}</Text>
                ) : null}
                <div>
                  <Tag color="blue">{ruleDraft.templates.length} 个类型模板</Tag>
                  {ruleDraft.notes ? <Tag color="gold">含 AI 备注</Tag> : null}
                </div>
                {ruleDraft.notes ? (
                  <Alert type="warning" showIcon message="AI 备注" description={ruleDraft.notes} />
                ) : null}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
                  {ruleDraft.templates.map((template) => (
                    <div
                      key={template.format_type}
                      style={{
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: 'rgba(255,255,255,0.025)',
                        borderRadius: 6,
                        padding: 10,
                        minWidth: 0,
                      }}
                    >
                      <Space size={6} wrap>
                        <Tag color={FORMAT_TYPE_COLORS[template.format_type] || 'default'} style={{ margin: 0 }}>
                          {FORMAT_TYPES[template.format_type] || template.format_type}
                        </Tag>
                        <Text strong style={{ color: 'var(--gs-text-primary)' }}>{template.name}</Text>
                      </Space>
                      <Paragraph ellipsis={{ rows: 2, expandable: true, symbol: '展开' }} style={{ color: 'var(--gs-text-secondary)', fontSize: 13, margin: '8px 0 0' }}>
                        <code style={{ background: 'rgba(255,255,255,0.04)', padding: '2px 6px', borderRadius: 3 }}>
                          {toDisplayText(template.template_text)}
                        </code>
                      </Paragraph>
                      <div style={{ marginTop: 8, color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
                        示例预览：{renderPreview(template.template_text)}
                      </div>
                    </div>
                  ))}
                </div>
              </Space>
            </Card>
          ) : null}
        </Space>
      </Modal>
    </div>
  )
}
