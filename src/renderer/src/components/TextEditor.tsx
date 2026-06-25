import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Popconfirm, Space, Tag } from 'antd'
import { HolderOutlined, RedoOutlined, RollbackOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons'
import { getOcrBlockText, getRawOcrBlockText, getTextFlowOcrBlocks } from '../utils/ocrText'
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
  onLineFocus?: (index: number, box?: TextEditorOcrBlock) => void
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
  manual_reading_order?: number
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

function normalizeManualReadingOrder(data: TextEditorOcrBlock[]): TextEditorOcrBlock[] {
  return data.map((box, index) => ({ ...box, manual_reading_order: index }))
}

function moveLayoutBlock(data: TextEditorOcrBlock[], sourceIndex: number, targetIndex: number): TextEditorOcrBlock[] {
  const nextData = [...data]
  const [source] = nextData.splice(sourceIndex, 1)
  nextData.splice(targetIndex, 0, source)
  return nextData
}

function getMoveTargetIndex(sourceIndex: number, insertIndex: number, itemCount: number): number {
  const boundedIndex = Math.max(0, Math.min(itemCount, insertIndex))
  return boundedIndex > sourceIndex ? boundedIndex - 1 : boundedIndex
}

function shouldShiftForDrag(index: number, sourceIndex: number, insertIndex: number, itemCount: number): boolean {
  if (sourceIndex < 0 || insertIndex < 0 || index === sourceIndex) return false
  const targetIndex = getMoveTargetIndex(sourceIndex, insertIndex, itemCount)
  if (targetIndex === sourceIndex) return false
  if (targetIndex < sourceIndex) return index >= targetIndex && index < sourceIndex
  return index > sourceIndex && index <= targetIndex
}

type DragPreviewState = {
  sourceIndex: number
  clientX: number
  clientY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
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
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null)
  const [dragInsertIndex, setDragInsertIndex] = useState(-1)
  const [localActiveBoxIndex, setLocalActiveBoxIndex] = useState<number | null>(null)
  const editorRootRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])

  const layoutResult = useMemo<TextEditorOcrBlock[]>(() => getTextFlowOcrBlocks({ ocr_result: ocrResult }) as TextEditorOcrBlock[], [ocrResult])
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
    setDragPreview(null)
    setDragInsertIndex(-1)
    setLocalActiveBoxIndex(null)
  }, [hasLayout, layoutResult, wordsResult])

  const effectiveActiveBoxIndex = localActiveBoxIndex ?? activeBoxIndex

  useEffect(() => {
    if (effectiveActiveBoxIndex >= 0 && lineRefs.current[effectiveActiveBoxIndex]) {
      lineRefs.current[effectiveActiveBoxIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [effectiveActiveBoxIndex])

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
    const normalizedData = normalizeManualReadingOrder(nextData)
    const nextOcrResult = {
      ...(ocrResult || {}),
      layout_result: normalizedData,
      words_result: normalizedData.map((box) => ({ words: getOcrBlockText(box) || '' })),
    }
    const nextText = normalizedData.map((box) => getOcrBlockText(box) || '').join('\n')
    onSave(pageId, { ocr_result: nextOcrResult, ocr_text: nextText, proofed_text: nextText })
  }, [ocrResult, onSave, pageId])

  const handleUndo = useCallback(() => {
    if (historyIndex <= 0) return
    const nextIndex = historyIndex - 1
    setHistoryIndex(nextIndex)
    setLayoutData(history[nextIndex].map((item) => ({ ...item })))
    setEditingIndex(-1)
    setLocalActiveBoxIndex(null)
  }, [history, historyIndex])

  const handleRedo = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    const nextIndex = historyIndex + 1
    setHistoryIndex(nextIndex)
    setLayoutData(history[nextIndex].map((item) => ({ ...item })))
    setEditingIndex(-1)
    setLocalActiveBoxIndex(null)
  }, [history, historyIndex])

  const handleSaveRegion = (index: number) => {
    const nextData = [...layoutData]
    nextData[index] = { ...nextData[index], words: editValue, raw_words: editValue }
    const normalizedData = normalizeManualReadingOrder(nextData)
    setLayoutData(normalizedData)
    pushHistory(normalizedData)
    setEditingIndex(-1)
    setEditValue('')
    saveToDb(normalizedData)
  }

  const handleReset = () => {
    const nextData = normalizeManualReadingOrder(originalLayout.map((box) => ({ ...box })))
    setLayoutData(nextData)
    pushHistory(nextData)
    setEditingIndex(-1)
    setEditValue('')
    saveToDb(nextData)
    onReset?.(pageId)
  }

  const handleDragPointerDown = useCallback((event: React.PointerEvent<HTMLElement>, index: number) => {
    if (editingIndex >= 0 || event.button !== 0) return
    const rowElement = lineRefs.current[index]
    if (!rowElement) return
    event.preventDefault()
    event.stopPropagation()

    const rect = rowElement.getBoundingClientRect()
    let nextInsertIndex = index
    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'

    const getInsertIndexFromPoint = (clientY: number) => {
      for (let rowIndex = 0; rowIndex < layoutData.length; rowIndex += 1) {
        const row = lineRefs.current[rowIndex]
        if (!row) continue
        const rowRect = row.getBoundingClientRect()
        if (clientY < rowRect.top + rowRect.height / 2) return rowIndex
      }
      return layoutData.length
    }

    const autoScroll = (clientY: number) => {
      const container = scrollContainerRef.current
      if (!container) return
      const containerRect = container.getBoundingClientRect()
      const edgeSize = 96
      const maxStep = 24
      if (clientY < containerRect.top + edgeSize) {
        const strength = Math.min(1, Math.max(0, (containerRect.top + edgeSize - clientY) / edgeSize))
        container.scrollTop -= Math.ceil(strength * maxStep)
      } else if (clientY > containerRect.bottom - edgeSize) {
        const strength = Math.min(1, Math.max(0, (clientY - (containerRect.bottom - edgeSize)) / edgeSize))
        container.scrollTop += Math.ceil(strength * maxStep)
      }
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      setDragPreview(null)
      setDragInsertIndex(-1)
    }

    const finishDrag = () => {
      cleanup()
      const nextTargetIndex = getMoveTargetIndex(index, nextInsertIndex, layoutData.length)
      if (nextTargetIndex < 0 || nextTargetIndex >= layoutData.length || index === nextTargetIndex) return
      const nextData = normalizeManualReadingOrder(moveLayoutBlock(layoutData, index, nextTargetIndex))
      setLayoutData(nextData)
      pushHistory(nextData)
      setEditingIndex(-1)
      setEditValue('')
      setLocalActiveBoxIndex(nextTargetIndex)
      onLineFocus?.(nextTargetIndex, nextData[nextTargetIndex])
      saveToDb(nextData)
    }

    function handlePointerMove(pointerEvent: PointerEvent) {
      pointerEvent.preventDefault()
      nextInsertIndex = getInsertIndexFromPoint(pointerEvent.clientY)
      autoScroll(pointerEvent.clientY)
      setDragInsertIndex(nextInsertIndex)
      setDragPreview((current) => current
        ? { ...current, clientX: pointerEvent.clientX, clientY: pointerEvent.clientY }
        : current)
    }

    function handlePointerUp(pointerEvent: PointerEvent) {
      pointerEvent.preventDefault()
      finishDrag()
    }

    function handlePointerCancel() {
      cleanup()
    }

    setDragPreview({
      sourceIndex: index,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    })
    setDragInsertIndex(index)
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp, { passive: false })
    window.addEventListener('pointercancel', handlePointerCancel)
  }, [editingIndex, layoutData, onLineFocus, pushHistory, saveToDb])

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
  }, [effectiveActiveBoxIndex, searchKeyword, viewMode])

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
        ref={scrollContainerRef}
        style={{ flex: 1, overflowY: 'auto', background: 'var(--gs-bg-base)', borderRadius: 4, padding: 8 }}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
      >
        {hasLayout ? (
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 15, lineHeight: 1.8 }}>
            {layoutData.map((box, index) => {
              const isActive = effectiveActiveBoxIndex === index
              const isEditingThis = editingIndex === index
              const label = box.label || 'text'
              const labelName = LABEL_NAMES[label] || label
              const labelColor = LABEL_COLORS[label] || '#1890ff'
              const content = getRawOcrBlockText(box) || box.words || ''
              const draggingIndex = dragPreview?.sourceIndex ?? -1
              const isDraggingThis = draggingIndex === index
              const isDragging = draggingIndex >= 0
              const showInsertBefore = dragInsertIndex === index && isDragging && !isDraggingThis
              const showInsertAfter = dragInsertIndex === layoutData.length && index === layoutData.length - 1 && isDragging && !isDraggingThis
              const shouldShift = shouldShiftForDrag(index, draggingIndex, dragInsertIndex, layoutData.length)
              const dragShift = (dragPreview?.height || 0) + 6

              return (
                <div
                  key={index}
                  ref={(element) => {
                    lineRefs.current[index] = element
                  }}
                  onClick={() => {
                    setLocalActiveBoxIndex(index)
                    onLineFocus?.(index, box)
                  }}
                  onDoubleClick={() => {
                    if (editingIndex < 0 && !isEditingThis) {
                      setEditingIndex(index)
                      setEditValue(content)
                    }
                  }}
                  style={{
                    position: 'relative',
                    display: 'grid',
                    gridTemplateColumns: '42px minmax(0, 1fr)',
                    gap: 8,
                    padding: '5px 10px 5px 0',
                    marginBottom: 6,
                    backgroundColor: isDraggingThis ? 'rgba(255, 255, 255, 0.025)' : isActive ? 'rgba(196, 149, 106, 0.1)' : isEditingThis ? 'rgba(255,255,255,0.04)' : showInsertBefore || showInsertAfter ? 'rgba(196, 149, 106, 0.08)' : 'transparent',
                    border: isActive ? '1px solid rgba(196, 149, 106, 0.18)' : '1px solid transparent',
                    borderLeft: isActive ? '3px solid var(--gs-gold)' : '3px solid transparent',
                    borderRadius: 4,
                    cursor: isEditingThis ? 'text' : 'pointer',
                    opacity: isDraggingThis ? 0.16 : 1,
                    transform: shouldShift ? `translateY(${draggingIndex < index ? -dragShift : dragShift}px)` : 'translateY(0)',
                    transition: isDragging ? 'transform 180ms cubic-bezier(0.2, 0, 0, 1), background-color 140ms ease, opacity 140ms ease' : 'background-color 160ms ease, border-color 160ms ease, opacity 160ms ease',
                    willChange: isDragging ? 'transform' : 'auto',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {showInsertBefore ? (
                    <div
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        top: -4,
                        left: 8,
                        right: 10,
                        height: 3,
                        borderRadius: 999,
                        background: 'var(--gs-gold)',
                        boxShadow: '0 0 0 3px rgba(196, 149, 106, 0.14), 0 8px 18px rgba(0, 0, 0, 0.28)',
                      }}
                    />
                  ) : null}
                  {showInsertAfter ? (
                    <div
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        bottom: -5,
                        left: 8,
                        right: 10,
                        height: 3,
                        borderRadius: 999,
                        background: 'var(--gs-gold)',
                        boxShadow: '0 0 0 3px rgba(196, 149, 106, 0.14), 0 8px 18px rgba(0, 0, 0, 0.28)',
                      }}
                    />
                  ) : null}
                  <div
                    aria-label="拖拽调整阅读顺序"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => handleDragPointerDown(event, index)}
                    title="拖拽调整阅读顺序"
                    style={{
                      alignSelf: 'stretch',
                      minHeight: 36,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 4,
                      background: 'transparent',
                      color: isDraggingThis ? 'var(--gs-gold-light)' : 'var(--gs-text-tertiary)',
                      cursor: editingIndex < 0 ? 'grab' : 'not-allowed',
                      opacity: isEditingThis ? 0.42 : 1,
                      userSelect: 'none',
                      touchAction: 'none',
                      transition: 'color 160ms ease, opacity 160ms ease',
                    }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 34,
                        display: 'grid',
                        placeItems: 'center',
                        borderRadius: 6,
                        background: isDraggingThis ? 'rgba(196, 149, 106, 0.13)' : 'rgba(255, 255, 255, 0.028)',
                        border: `1px solid ${isActive ? 'rgba(196, 149, 106, 0.18)' : 'rgba(255, 255, 255, 0.045)'}`,
                        boxShadow: isDraggingThis ? '0 0 0 3px rgba(196, 149, 106, 0.08)' : 'none',
                      }}
                    >
                      <HolderOutlined style={{ fontSize: 14 }} />
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isEditingThis ? 4 : 0 }}>
                      <Space size={4}>
                        <Tag color={labelColor} style={{ fontSize: 10, lineHeight: '16px', marginRight: 6, padding: '0 4px' }}>
                          {labelName}
                        </Tag>
                      </Space>
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
                </div>
              )
            })}
          </div>
        ) : (
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, lineHeight: 1.8 }}>
            {wordsResult.map((item, index) => {
              const isActive = effectiveActiveBoxIndex === index
              return (
                <div
                  key={index}
                  ref={(element) => {
                    lineRefs.current[index] = element
                  }}
                  onClick={() => {
                    setLocalActiveBoxIndex(null)
                    onLineFocus?.(index)
                  }}
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
        {dragPreview ? (() => {
          const previewBox = layoutData[dragPreview.sourceIndex]
          const previewLabel = String(previewBox?.label || 'text')
          const previewLabelName = LABEL_NAMES[previewLabel] || previewLabel
          const previewLabelColor = LABEL_COLORS[previewLabel] || '#1890ff'
          const previewContent = getRawOcrBlockText(previewBox) || previewBox?.words || ''
          return (
            <div
              aria-hidden="true"
              style={{
                position: 'fixed',
                zIndex: 9999,
                left: 0,
                top: 0,
                width: dragPreview.width,
                minHeight: dragPreview.height,
                pointerEvents: 'none',
                display: 'grid',
                gridTemplateColumns: '42px minmax(0, 1fr)',
                gap: 8,
                padding: '5px 10px 5px 0',
                borderRadius: 6,
                background: 'rgba(24, 22, 19, 0.98)',
                border: '1px solid rgba(196, 149, 106, 0.38)',
                boxShadow: '0 20px 52px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.035) inset',
                color: 'var(--gs-text-primary)',
                fontFamily: "'Noto Serif SC', serif",
                fontSize: 15,
                lineHeight: 1.8,
                whiteSpace: 'pre-wrap',
                transform: `translate3d(${dragPreview.clientX - dragPreview.offsetX}px, ${dragPreview.clientY - dragPreview.offsetY}px, 0) scale(1.012)`,
                willChange: 'transform',
              }}
            >
              <div
                style={{
                  alignSelf: 'stretch',
                  minHeight: 36,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 4,
                  background: 'transparent',
                  color: 'var(--gs-gold-light)',
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 34,
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: 6,
                    background: 'rgba(196, 149, 106, 0.14)',
                    border: '1px solid rgba(196, 149, 106, 0.25)',
                    boxShadow: '0 0 0 3px rgba(196, 149, 106, 0.08)',
                  }}
                >
                  <HolderOutlined style={{ fontSize: 14 }} />
                </div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ marginBottom: 2 }}>
                  <Tag color={previewLabelColor} style={{ fontSize: 10, lineHeight: '16px', marginRight: 6, padding: '0 4px' }}>
                    {previewLabelName}
                  </Tag>
                </div>
                <div style={{ maxHeight: 170, overflow: 'hidden' }}>
                  {renderOcrInlineText(String(previewContent || ''), 'text-editor-drag-preview')}
                </div>
              </div>
            </div>
          )
        })() : null}
      </div>
    </div>
  )
}
