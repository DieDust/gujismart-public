import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Popconfirm, Space, Tag } from 'antd'
import { RedoOutlined, RollbackOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons'
import { getOcrBlockText, getOrderedOcrBlocks, getRawOcrBlockText } from '../utils/ocrText'
import { renderOcrInlineHighlighted, renderOcrInlineText } from '../utils/ocrInlineRender'
import type { PageUpdatePayload } from '@shared/types'

const LABEL_COLORS: Record<string, string> = {
  doc_title: '#722ed1',
  paragraph_title: '#13c2c2',
  text: '#1890ff',
  abstract: '#fa8c16',
  reference: '#52c41a',
  table: '#eb2f96',
  figure: '#2f54eb',
  header: '#8c8c8c',
  footer: '#8c8c8c',
  number: '#8c8c8c',
  seal: '#f5222d',
}

const LABEL_NAMES: Record<string, string> = {
  doc_title: '标题',
  paragraph_title: '段题',
  text: '正文',
  abstract: '摘要',
  reference: '参考',
  table: '表格',
  figure: '图像',
  header: '页眉',
  footer: '页脚',
  number: '页码',
  seal: '印章',
}

interface TextEditorProps {
  ocrResult: TextEditorOcrResult | null | undefined
  pageId: string
  onSave: (pageId: string, data: PageUpdatePayload) => void
  onReset: (pageId: string) => void
  onModeChange?: (mode: 'markdown' | 'translation' | 'region') => void
  onTextSelectionChange?: (text: string) => void
  activeBoxIndex?: number
  onLineFocus?: (index: number) => void
  switchToRegion?: boolean
  onSwitchToRegionConsumed?: () => void
  searchKeyword?: string
}

interface TextEditorOcrWord {
  words?: string
}

interface TextEditorOcrResult extends Record<string, unknown> {
  layout_result?: TextEditorOcrBlock[]
  words_result?: TextEditorOcrWord[]
}

interface TextEditorOcrBlock extends Record<string, unknown> {
  label?: string
  raw_words?: string
  words?: string
}

function renderSearchHighlight(text: string, keyword: string, active = false): React.ReactNode {
  if (!keyword.trim()) return <>{renderOcrInlineText(text, 'text-editor')}</>

  try {
    return <>{renderOcrInlineHighlighted(text, keyword, 'text-editor-hit', active)}</>
  } catch {
    return <>{renderOcrInlineText(text, 'text-editor-fallback')}</>
  }
}

export default function TextEditor({
  ocrResult,
  pageId,
  onSave,
  onReset,
  onModeChange,
  onTextSelectionChange,
  activeBoxIndex = -1,
  onLineFocus,
  switchToRegion,
  onSwitchToRegionConsumed,
  searchKeyword = '',
}: TextEditorProps) {
  const [viewMode, setViewMode] = useState<'markdown' | 'translation' | 'region'>('region')
  const [editingIndex, setEditingIndex] = useState(-1)
  const [editValue, setEditValue] = useState('')
  const [layoutData, setLayoutData] = useState<TextEditorOcrBlock[]>([])
  const [originalLayout, setOriginalLayout] = useState<TextEditorOcrBlock[]>([])
  const [history, setHistory] = useState<TextEditorOcrBlock[][]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const editorRootRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])

  const layoutResult = useMemo<TextEditorOcrBlock[]>(() => getOrderedOcrBlocks({ ocr_result: ocrResult }) as TextEditorOcrBlock[], [ocrResult])
  const wordsResult = ocrResult?.words_result || []
  const hasLayout = layoutResult.length > 0

  useEffect(() => {
    if (hasLayout) {
      const nextLayout = layoutResult.map((box) => {
        const rawWords = getRawOcrBlockText(box)
        return { ...box, raw_words: box?.raw_words || rawWords, words: rawWords || getOcrBlockText(box) }
      })
      setLayoutData(nextLayout)
      setOriginalLayout(nextLayout.map((box) => ({ ...box })))
      setHistory([nextLayout.map((box) => ({ ...box }))])
      setHistoryIndex(0)
    } else {
      setLayoutData([])
      setOriginalLayout([])
      setHistory([])
      setHistoryIndex(-1)
    }
    setEditingIndex(-1)
    setEditValue('')
  }, [hasLayout, layoutResult, wordsResult])

  useEffect(() => {
    if (activeBoxIndex >= 0 && lineRefs.current[activeBoxIndex]) {
      lineRefs.current[activeBoxIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeBoxIndex])

  useEffect(() => {
    if (viewMode !== 'region') {
      setViewMode('region')
      onModeChange?.('region')
      return
    }
    if (switchToRegion) onSwitchToRegionConsumed?.()
  }, [switchToRegion, viewMode, onModeChange, onSwitchToRegionConsumed])

  const pushHistory = useCallback((nextData: TextEditorOcrBlock[]) => {
    setHistory((previous) => {
      const sliced = previous.slice(0, historyIndex + 1)
      sliced.push(nextData.map((item) => ({ ...item })))
      if (sliced.length > 50) sliced.shift()
      return sliced
    })
    setHistoryIndex((previous) => Math.min(previous + 1, 49))
  }, [historyIndex])

  const saveToDb = useCallback((nextData: TextEditorOcrBlock[]) => {
    const nextOcrResult = {
      ...(ocrResult || {}),
      layout_result: nextData,
      words_result: nextData.map((box) => ({ words: getOcrBlockText(box) || '' })),
    }
    const nextText = nextData.map((box) => getOcrBlockText(box) || '').join('\n')
    onSave(pageId, { ocr_result: nextOcrResult, ocr_text: nextText })
  }, [ocrResult, onSave, pageId])

  const handleUndo = useCallback(() => {
    if (historyIndex <= 0) return
    const nextIndex = historyIndex - 1
    setHistoryIndex(nextIndex)
    setLayoutData(history[nextIndex].map((item) => ({ ...item })))
    setEditingIndex(-1)
  }, [history, historyIndex])

  const handleRedo = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    const nextIndex = historyIndex + 1
    setHistoryIndex(nextIndex)
    setLayoutData(history[nextIndex].map((item) => ({ ...item })))
    setEditingIndex(-1)
  }, [history, historyIndex])

  const handleSaveRegion = (index: number) => {
    const nextData = [...layoutData]
    nextData[index] = { ...nextData[index], words: editValue, raw_words: editValue }
    setLayoutData(nextData)
    pushHistory(nextData)
    setEditingIndex(-1)
    setEditValue('')
    saveToDb(nextData)
  }

  const handleReset = () => {
    const nextData = originalLayout.map((box) => ({ ...box }))
    setLayoutData(nextData)
    pushHistory(nextData)
    setEditingIndex(-1)
    setEditValue('')
    saveToDb(nextData)
    onReset?.(pageId)
  }

  const captureSelection = useCallback(() => {
    const selectedText = window.getSelection()?.toString().trim() || ''
    if (selectedText) {
      onTextSelectionChange?.(selectedText)
    }
  }, [onTextSelectionChange])

  const canUndo = historyIndex > 0
  const canRedo = historyIndex >= 0 && historyIndex < history.length - 1

  useEffect(() => {
    const activeMark = editorRootRef.current?.querySelector<HTMLElement>('mark[data-search-active="true"]')
    if (activeMark) {
      activeMark.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    }
  }, [activeBoxIndex, searchKeyword, viewMode])

  return (
    <div ref={editorRootRef} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '0 0 8px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Tag color="blue">区域编辑</Tag>

          {viewMode === 'region' ? (
            <Space size={2}>
              <Button size="small" icon={<UndoOutlined />} onClick={handleUndo} disabled={!canUndo} type="text" title="撤销" />
              <Button size="small" icon={<RedoOutlined />} onClick={handleRedo} disabled={!canRedo} type="text" title="重做" />
              <Popconfirm
                title="确定还原到原始 OCR 结果吗？当前页修改会丢失。"
                onConfirm={handleReset}
                okText="确定"
                cancelText="取消"
              >
                <Button size="small" icon={<RollbackOutlined />} type="text" title="还原原始 OCR 结果" />
              </Popconfirm>
            </Space>
          ) : null}
        </Space>
      </div>

      <div
        style={{ flex: 1, overflowY: 'auto', background: 'var(--gs-bg-base)', borderRadius: 4, padding: 8 }}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
      >
        {hasLayout ? (
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 15, lineHeight: 1.8 }}>
            {layoutData.map((box, index) => {
              const isActive = activeBoxIndex === index
              const isEditingThis = editingIndex === index
              const label = box.label || 'text'
              const labelName = LABEL_NAMES[label] || label
              const labelColor = LABEL_COLORS[label] || '#1890ff'
              const content = getRawOcrBlockText(box) || box.words || ''

              return (
                <div
                  key={index}
                  ref={(element) => {
                    lineRefs.current[index] = element
                  }}
                  onClick={() => onLineFocus?.(index)}
                  onDoubleClick={() => {
                    if (editingIndex < 0 && !isEditingThis) {
                      setEditingIndex(index)
                      setEditValue(content)
                    }
                  }}
                  style={{
                    padding: '6px 8px',
                    marginBottom: 4,
                    backgroundColor: isActive ? 'rgba(24, 144, 255, 0.12)' : isEditingThis ? 'rgba(255,255,255,0.04)' : 'transparent',
                    borderLeft: isActive ? '3px solid #1890ff' : `3px solid ${labelColor}40`,
                    borderRadius: 2,
                    cursor: isEditingThis ? 'text' : 'pointer',
                    transition: 'all 0.2s',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isEditingThis ? 4 : 0 }}>
                    <Tag color={labelColor} style={{ fontSize: 10, lineHeight: '16px', marginRight: 6, padding: '0 4px' }}>
                      {labelName}
                    </Tag>
                    {isEditingThis ? (
                      <Space size={4}>
                        <Button size="small" type="link" onClick={(event) => { event.stopPropagation(); setEditingIndex(-1) }}>
                          取消
                        </Button>
                        <Button size="small" type="primary" icon={<SaveOutlined />} onClick={(event) => { event.stopPropagation(); handleSaveRegion(index) }}>
                          保存
                        </Button>
                      </Space>
                    ) : null}
                  </div>

                  {isEditingThis ? (
                    <Input.TextArea
                      value={editValue}
                      onChange={(event) => setEditValue(event.target.value)}
                      autoSize={{ minRows: 2, maxRows: 10 }}
                      style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 15, lineHeight: 1.8 }}
                      onClick={(event) => event.stopPropagation()}
                    />
                  ) : (
                    renderSearchHighlight(content, searchKeyword, isActive && !!searchKeyword.trim())
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, lineHeight: 1.8 }}>
            {wordsResult.map((item, index) => {
              const isActive = activeBoxIndex === index
              return (
                <div
                  key={index}
                  ref={(element) => {
                    lineRefs.current[index] = element
                  }}
                  onClick={() => onLineFocus?.(index)}
                  style={{
                    padding: '0 8px',
                    backgroundColor: isActive ? 'rgba(24, 144, 255, 0.15)' : 'transparent',
                    borderLeft: isActive ? '3px solid #1890ff' : '3px solid transparent',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {renderSearchHighlight(item.words || '', searchKeyword, isActive && !!searchKeyword.trim())}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
