import { useState, useEffect } from 'react'
import { Select, Button, Space, Tooltip, Tag, message, Input, Drawer, Alert } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CopyOutlined,
  FileTextOutlined,
  EyeOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DownloadOutlined
} from '@ant-design/icons'
import { getErrorMessage } from '@shared/errors'
import type {
  TypesetAnnotationItem,
  TypesetAnnotationType,
  TypesetCompileResult,
  TypesetEnvironmentStatus,
  TypesetTemplate,
} from '@shared/types'

interface TypesetOcrBlock {
  label?: string | null
  words?: string | null
  text?: string | null
}

interface TypesetOcrResult {
  layout_result?: TypesetOcrBlock[] | null
  words_result?: TypesetOcrBlock[] | null
}

interface TypesetTypeConfig {
  label: string
  color: string
  texCmd: string
  desc: string
}

const TYPE_CONFIG: Record<TypesetAnnotationType, TypesetTypeConfig> = {
  body: { label: '正文', color: '#1890ff', texCmd: '', desc: '普通正文内容' },
  jiaZhu: { label: '夹注', color: '#fa8c16', texCmd: '\\夹注', desc: '双行小字注释，自动平衡' },
  cePi: { label: '侧批', color: '#f5222d', texCmd: '\\侧批', desc: '行间红色批注' },
  meiPi: { label: '眉批', color: '#722ed1', texCmd: '\\眉批', desc: '页面顶部批注' },
  jiaoZhu: { label: '脚注', color: '#13c2c2', texCmd: '\\脚注', desc: '页下注释' },
  title: { label: '标题', color: '#52c41a', texCmd: '\\title', desc: '文档标题' },
  chapter: { label: '章节', color: '#2f54eb', texCmd: '\\chapter', desc: '章节标题' },
  seal: { label: '印章', color: '#eb2f96', texCmd: '\\印章', desc: '电子印章' },
}

const TYPE_OPTIONS = Object.entries(TYPE_CONFIG).map(([value, config]) => ({
  value: value as TypesetAnnotationType,
  label: config.label,
}))

const TEMPLATES: Array<{ value: TypesetTemplate; label: string }> = [
  { value: '四库全书', label: '四库全书（版心鱼尾）' },
  { value: '四库全书彩色', label: '四库全书彩色' },
  { value: '红楼梦甲戌本', label: '红楼梦甲戌本（手抄本）' },
]

let _idCounter = 0
const nextId = () => `ann_${++_idCounter}_${Date.now()}`

interface TypesetEditorProps {
  ocrResult: TypesetOcrResult | null | undefined
  docId: string
  docTitle: string
  docAuthor?: string
  docDynasty?: string
}

export default function TypesetEditor({ ocrResult, docId, docTitle, docAuthor, docDynasty }: TypesetEditorProps) {
  const [annotations, setAnnotations] = useState<TypesetAnnotationItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [template, setTemplate] = useState<TypesetTemplate>('四库全书')
  const [texSource, setTexSource] = useState('')
  const [showTex, setShowTex] = useState(false)
  const [envStatus, setEnvStatus] = useState<TypesetEnvironmentStatus | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [compileResult, setCompileResult] = useState<TypesetCompileResult | null>(null)
  const [pdfDataUrl, setPdfDataUrl] = useState<string>('')

  useEffect(() => {
    checkEnv()
  }, [])

  useEffect(() => {
    if (ocrResult) {
      const items: TypesetAnnotationItem[] = []
      const layoutResult = Array.isArray(ocrResult.layout_result) ? ocrResult.layout_result : []
      const wordsResult = Array.isArray(ocrResult.words_result) ? ocrResult.words_result : []

      if (layoutResult.length > 0) {
        for (const box of layoutResult) {
          const label = box.label || 'text'
          let type: TypesetAnnotationType = 'body'
          if (label === 'doc_title' || label === 'paragraph_title') type = 'title'
          else if (label === 'abstract') type = 'jiaZhu'
          else if (label === 'reference') type = 'jiaoZhu'
          else if (label === 'table') type = 'body'
          else if (label === 'figure') type = 'body'
          else if (label === 'header' || label === 'footer') type = 'body'
          else if (label === 'seal') type = 'seal'

          items.push({
            id: nextId(),
            type,
            content: String(box.words || box.text || '')
          })
        }
      } else if (wordsResult.length > 0) {
        for (const w of wordsResult) {
          items.push({
            id: nextId(),
            type: 'body',
            content: String(w.words || w.text || '')
          })
        }
      }

      if (items.length > 0 && items[0].type !== 'title') {
        items.unshift({
          id: nextId(),
          type: 'title',
          content: docTitle || '文献标题'
        })
      }

      setAnnotations(items)
    }
  }, [ocrResult, docTitle])

  const checkEnv = async () => {
    try {
      const result = await window.api.typesetCheckEnv()
      setEnvStatus(result)
    } catch (e) {
      console.error('环境检查失败:', e)
    }
  }

  const handleAddItem = (type: TypesetAnnotationType) => {
    const newItem: TypesetAnnotationItem = {
      id: nextId(),
      type,
      content: type === 'title' ? docTitle || '' : ''
    }
    setAnnotations(prev => [...prev, newItem])
    setSelectedId(newItem.id)
    setEditingId(newItem.id)
    setEditValue(newItem.content)
  }

  const handleDeleteItem = (id: string) => {
    setAnnotations(prev => prev.filter(a => a.id !== id))
    if (selectedId === id) setSelectedId(null)
    if (editingId === id) setEditingId(null)
  }

  const handleSaveEdit = () => {
    if (editingId) {
      setAnnotations(prev => prev.map(a => a.id === editingId ? { ...a, content: editValue } : a))
      setEditingId(null)
      setEditValue('')
    }
  }

  const handleChangeType = (id: string, newType: TypesetAnnotationType) => {
    setAnnotations(prev => prev.map(a => a.id === id ? { ...a, type: newType } : a))
  }

  const handleGenerateTeX = async () => {
    try {
      const tex = await window.api.typesetGenerateTeX(annotations, template, {
        title: docTitle,
        author: docAuthor,
        dynasty: docDynasty
      })
      setTexSource(tex)
      setShowTex(true)
    } catch (error: unknown) {
      message.error(`生成 TeX 失败: ${getErrorMessage(error, '未知错误')}`)
    }
  }

  const handleCompile = async () => {
    if (!envStatus?.luatex?.available) {
      message.error('未检测到 LuaTeX，请先安装 TeX Live')
      return
    }
    if (!envStatus?.luatexCn?.installed) {
      message.warning('未检测到 luatex-cn 宏包，编译可能失败。请安装 luatex-cn：https://github.com/open-guji/luatex-cn')
    }

    setCompiling(true)
    setCompileResult(null)
    setPdfDataUrl('')

    try {
      const tex = await window.api.typesetGenerateTeX(annotations, template, {
        title: docTitle,
        author: docAuthor,
        dynasty: docDynasty
      })
      setTexSource(tex)

      const result = await window.api.typesetCompile(docId, tex)
      setCompileResult(result)

      if (result.success) {
        message.success('编译成功！')
        const pdfBuffer = await window.api.typesetReadPdf(result.pdfPath)
        if (pdfBuffer) {
          const blob = new Blob([pdfBuffer], { type: 'application/pdf' })
          setPdfDataUrl(URL.createObjectURL(blob))
        }
      } else {
        message.error(`编译失败: ${result.error}`)
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, '未知错误')
      message.error(`编译出错: ${errorMessage}`)
      setCompileResult({ success: false, pdfPath: '', error: errorMessage, log: '' })
    } finally {
      setCompiling(false)
    }
  }

  const handleExportTex = () => {
    if (!texSource) return
    const blob = new Blob([texSource], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${docTitle || 'document'}.tex`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '0 0 8px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Space size={4} wrap>
          <Select size="small" value={template} onChange={(value: TypesetTemplate) => setTemplate(value)} style={{ width: 180 }} options={TEMPLATES} />
          <Button size="small" icon={<EyeOutlined />} onClick={handleGenerateTeX}>预览 TeX</Button>
          <Button size="small" type="primary" icon={<ThunderboltOutlined />} loading={compiling} onClick={handleCompile}>编译 PDF</Button>
          {texSource && <Button size="small" icon={<DownloadOutlined />} onClick={handleExportTex}>导出 .tex</Button>}
        </Space>
        <Space size={2}>
          {envStatus && (
            envStatus.luatex?.available ? (
              <Tag color="success" icon={<CheckCircleOutlined />}>LuaTeX {envStatus.luatex.version}</Tag>
            ) : (
              <Tooltip title="请安装 TeX Live: https://tug.org/texlive/">
                <Tag color="error" icon={<CloseCircleOutlined />}>未安装 LuaTeX</Tag>
              </Tooltip>
            )
          )}
          {envStatus?.luatexCn?.installed && <Tag color="success">luatex-cn</Tag>}
        </Space>
      </div>

      {envStatus && !envStatus.luatex?.available && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8, fontSize: 12 }}
          message="未检测到 LuaTeX 环境"
          description="排版功能需要安装 TeX Live（推荐 2024+）。下载地址：https://tug.org/texlive/acquire-netinstall.html"
        />
      )}

      <div style={{ padding: '0 0 8px 0', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
          <Button
            key={key}
            size="small"
            onClick={() => handleAddItem(key as TypesetAnnotationType)}
            style={{ borderColor: cfg.color, color: cfg.color }}
          >
            <PlusOutlined /> {cfg.label}
          </Button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--gs-bg-base)', borderRadius: 4, padding: 8 }}>
        {annotations.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--gs-text-secondary)' }}>
            <FileTextOutlined style={{ fontSize: 32, opacity: 0.3 }} />
            <div style={{ marginTop: 8 }}>请先进行 OCR 识别，或手动添加标注项</div>
          </div>
        ) : (
          annotations.map((item) => {
            const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.body
            const isSelected = selectedId === item.id
            const isEditing = editingId === item.id

            return (
              <div
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                onDoubleClick={() => {
                  setEditingId(item.id)
                  setEditValue(item.content)
                }}
                style={{
                  padding: '6px 8px',
                  marginBottom: 4,
                  backgroundColor: isSelected ? 'rgba(24, 144, 255, 0.12)' : isEditing ? 'rgba(255,255,255,0.04)' : 'transparent',
                  borderLeft: `3px solid ${isSelected ? '#1890ff' : cfg.color}40`,
                  borderRadius: 2,
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isEditing ? 4 : 0 }}>
                  <Space size={4}>
                    <Tag color={cfg.color} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                      {cfg.label}
                    </Tag>
                    <Select
                      size="small"
                      value={item.type}
                      onChange={(value: TypesetAnnotationType) => handleChangeType(item.id, value)}
                      style={{ width: 80, fontSize: 11 }}
                      variant="borderless"
                      options={TYPE_OPTIONS}
                    />
                    <span style={{ fontSize: 10, color: 'var(--gs-text-secondary)' }}>{cfg.texCmd}</span>
                  </Space>
                  <Space size={2}>
                    <Tooltip title="编辑">
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); setEditingId(item.id); setEditValue(item.content) }} />
                    </Tooltip>
                    <Tooltip title="删除">
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); handleDeleteItem(item.id) }} />
                    </Tooltip>
                  </Space>
                </div>
                {isEditing ? (
                  <Space.Compact style={{ width: '100%' }}>
                    <Input.TextArea
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      autoSize={{ minRows: 1, maxRows: 6 }}
                      style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 14 }}
                      onClick={e => e.stopPropagation()}
                    />
                    <Button size="small" type="primary" onClick={(e) => { e.stopPropagation(); handleSaveEdit() }}>保存</Button>
                    <Button size="small" onClick={(e) => { e.stopPropagation(); setEditingId(null) }}>取消</Button>
                  </Space.Compact>
                ) : (
                  <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: 'var(--gs-text-primary)' }}>
                    {item.content || <span style={{ color: 'var(--gs-text-secondary)', fontStyle: 'italic' }}>（空内容，双击编辑）</span>}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {pdfDataUrl && (
        <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontWeight: 500, color: 'var(--gs-text-primary)' }}>PDF 预览</span>
            <Button size="small" onClick={() => setPdfDataUrl('')}>关闭预览</Button>
          </div>
          <iframe src={pdfDataUrl} style={{ width: '100%', height: 400, border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4 }} />
        </div>
      )}

      {compileResult && !compileResult.success && compileResult.log && (
        <div style={{ marginTop: 8 }}>
          <Alert
            type="error"
            showIcon
            message="编译日志"
            description={
              <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>
                {compileResult.log.slice(-2000)}
              </pre>
            }
          />
        </div>
      )}

      <Drawer
        title="TeX 源码"
        placement="right"
        width={600}
        open={showTex}
        onClose={() => setShowTex(false)}
        extra={<Button size="small" icon={<CopyOutlined />} onClick={() => { navigator.clipboard.writeText(texSource); message.success('已复制') }}>复制</Button>}
      >
        <pre style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', background: '#1a1a2e', color: '#e0e0e0', padding: 16, borderRadius: 8, overflow: 'auto' }}>
          {texSource}
        </pre>
      </Drawer>
    </div>
  )
}
