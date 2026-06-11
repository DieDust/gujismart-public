import { useState } from 'react'
import { Modal, Steps, Select, Radio, Button, Space, Spin, message, Input, Tag, Tooltip } from 'antd'
import { CopyOutlined, FileSearchOutlined } from '@ant-design/icons'
import type { AiSynthesisResult, AiSynthesisTemplate, EvidenceQaSource, Folder, OpenDocumentTarget, Tag as SharedTag } from '@shared/types'
import AiMarkdown, { sourceToTarget, stripSnippetMarkers } from './AiMarkdown'
import { getErrorMessage } from '@shared/errors'

const { TextArea } = Input

interface AiSynthesisModalProps {
  visible: boolean
  preSelectedIds?: string[]
  tags?: Array<Pick<SharedTag, 'id' | 'name'>>
  folders?: Array<Pick<Folder, 'id' | 'name'>>
  onOpenDocument?: (target: OpenDocumentTarget) => void
  onClose: () => void
}

const TEMPLATES = [
  { value: 'literature_review', label: '文献综述', desc: '综合归纳研究脉络、趋势、分歧与空白。' },
  { value: 'summary', label: '内容摘要', desc: '生成跨文献综合摘要，避免逐篇复述。' },
  { value: 'theme_analysis', label: '主题分析', desc: '按主题提炼共同问题、争议点与证据关系。' },
  { value: 'timeline', label: '时间线综述', desc: '按阶段组织材料，解释观点与问题的变化逻辑。' },
  { value: 'custom', label: '自定义', desc: '按你的提示词生成定制化综合分析。' },
]

export default function AiSynthesisModal({
  visible,
  preSelectedIds = [],
  tags = [],
  folders = [],
  onOpenDocument,
  onClose,
}: AiSynthesisModalProps) {
  const [step, setStep] = useState(0)
  const [scopeMode, setScopeMode] = useState<'selected' | 'tag' | 'folder'>('selected')
  const [selectedTagId, setSelectedTagId] = useState<string | undefined>()
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>()
  const [templateType, setTemplateType] = useState<AiSynthesisTemplate>('literature_review')
  const [customPrompt, setCustomPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState('')
  const [sources, setSources] = useState<EvidenceQaSource[]>([])

  const getTargetIds = async (): Promise<string[]> => {
    if (scopeMode === 'selected') return preSelectedIds
    if (scopeMode === 'tag' && selectedTagId) {
      const docs = await window.api.listDocuments({ tagId: selectedTagId })
      return docs.map((item) => item.id)
    }
    if (scopeMode === 'folder' && selectedFolderId) {
      const docs = await window.api.listDocuments({ folderId: selectedFolderId })
      return docs.map((item) => item.id)
    }
    return []
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setResult('')
    try {
      const ids = await getTargetIds()
      if (ids.length === 0) {
        message.warning('没有可用于综合分析的文献')
        setGenerating(false)
        return
      }

      const payload = await window.api.synthesizeDocuments(
        ids,
        templateType,
        templateType === 'custom' ? customPrompt : undefined,
      ) as AiSynthesisResult | string
      setResult(typeof payload === 'string' ? payload : payload.markdown)
      setSources(typeof payload === 'string' ? [] : payload.sources || [])
      setStep(2)
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '生成失败，请检查 AI 配置'))
    } finally {
      setGenerating(false)
    }
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(result)
    message.success('已复制到剪贴板')
  }

  const handleClose = () => {
    setStep(0)
    setScopeMode('selected')
    setSelectedTagId(undefined)
    setSelectedFolderId(undefined)
    setTemplateType('literature_review')
    setCustomPrompt('')
    setResult('')
    setSources([])
    onClose()
  }

  return (
    <Modal
      title={<Space><FileSearchOutlined />AI 跨文献综合分析</Space>}
      open={visible}
      onCancel={handleClose}
      width={700}
      footer={null}
      styles={{ body: { paddingTop: 8 } }}
    >
      <Steps
        current={step}
        items={[
          { title: '选择范围' },
          { title: '选择模板' },
          { title: '查看结果' },
        ]}
        size="small"
        style={{ marginBottom: 24 }}
      />

      {step === 0 ? (
        <div>
          <div style={{ marginBottom: 16 }}>
            <Radio.Group
              value={scopeMode}
              onChange={(event) => setScopeMode(event.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="selected">
                已选文献 {preSelectedIds.length > 0 ? <Tag style={{ marginLeft: 4 }}>{preSelectedIds.length}</Tag> : null}
              </Radio.Button>
              <Radio.Button value="tag">按标签</Radio.Button>
              <Radio.Button value="folder">按文件夹</Radio.Button>
            </Radio.Group>
          </div>

          {scopeMode === 'selected' ? (
            <div style={{ color: 'var(--gs-text-secondary)', fontSize: 13 }}>
              {preSelectedIds.length > 0
                ? `将对已勾选的 ${preSelectedIds.length} 篇文献进行综合分析。`
                : '请先在文献列表中批量选择文献，再打开这个功能。'}
            </div>
          ) : null}

          {scopeMode === 'tag' ? (
            <Select
              placeholder="选择标签"
              style={{ width: '100%' }}
              value={selectedTagId}
              onChange={setSelectedTagId}
              options={tags.map((item) => ({ value: item.id, label: item.name }))}
            />
          ) : null}

          {scopeMode === 'folder' ? (
            <Select
              placeholder="选择文件夹"
              style={{ width: '100%' }}
              value={selectedFolderId}
              onChange={setSelectedFolderId}
              options={folders.map((item) => ({ value: item.id, label: item.name }))}
            />
          ) : null}

          {scopeMode === 'selected' && preSelectedIds.length > 0 ? (
            <div style={{ marginTop: 12, color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
              提示：每篇文献会截取部分文本用于综合分析，建议控制在 10 篇以内以获得更稳定的输出。
            </div>
          ) : null}

          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              type="primary"
              onClick={() => setStep(1)}
              disabled={
                (scopeMode === 'selected' && preSelectedIds.length === 0) ||
                (scopeMode === 'tag' && !selectedTagId) ||
                (scopeMode === 'folder' && !selectedFolderId)
              }
            >
              下一步
            </Button>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div>
          <Radio.Group
            value={templateType}
            onChange={(event) => setTemplateType(event.target.value)}
            style={{ width: '100%' }}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {TEMPLATES.map((template) => (
                <Radio key={template.value} value={template.value} style={{ width: '100%' }}>
                  <span style={{ fontWeight: 500 }}>{template.label}</span>
                  <span style={{ color: 'var(--gs-text-tertiary)', fontSize: 12, marginLeft: 8 }}>{template.desc}</span>
                </Radio>
              ))}
            </Space>
          </Radio.Group>

          {templateType === 'custom' ? (
            <TextArea
              rows={4}
              placeholder="输入你的分析要求，例如：请重点比较这些文献对某一问题的不同解释，并按证据强弱排序。"
              value={customPrompt}
              onChange={(event) => setCustomPrompt(event.target.value)}
              style={{ marginTop: 12 }}
            />
          ) : null}

          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Button
              type="primary"
              icon={generating ? <Spin size="small" /> : undefined}
              onClick={() => void handleGenerate()}
              disabled={generating || (templateType === 'custom' && !customPrompt.trim())}
            >
              {generating ? '生成中...' : '开始生成'}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button icon={<CopyOutlined />} size="small" onClick={() => void handleCopy()}>
              复制全文
            </Button>
          </div>
          <div
            style={{
              maxHeight: 420,
              overflow: 'auto',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
              padding: '12px 16px',
              fontSize: 14,
              lineHeight: 1.8,
              color: 'var(--gs-text-primary)',
            }}
          >
            <AiMarkdown content={result} sources={sources} prompt={customPrompt || templateType} onOpenDocument={onOpenDocument} />
            {sources.length > 0 ? (
              <div className="ai-source-list">
                {sources.slice(0, 8).map((source, index) => (
                  <Tooltip
                    key={`synthesis-source-${source.doc_id}-${source.page_num}-${index}`}
                    title={stripSnippetMarkers(source.snippet || '') || source.doc_title}
                  >
                    <Button
                      className="ai-source-chip"
                      size="small"
                      onClick={() => onOpenDocument?.(sourceToTarget(source, sources, index, customPrompt || templateType))}
                    >
                      [{index + 1}] {source.doc_title || '原文'} · {source.page_num || '?'}页
                    </Button>
                  </Tooltip>
                ))}
              </div>
            ) : null}
          </div>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => { setStep(1); setResult(''); setSources([]) }}>重新生成</Button>
            <Button type="primary" onClick={handleClose}>完成</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
