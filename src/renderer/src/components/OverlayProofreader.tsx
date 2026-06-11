import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Empty, Input, Space, Tag, Tooltip } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import {
  ExpandOutlined,
  RedoOutlined,
  RotateRightOutlined,
  SaveOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons'
import type { ViewerViewport } from './ImageViewer'
import type { OcrRecognizeLayoutBlock, OcrRecognizeResult, PageUpdatePayload } from '@shared/types'

type JsonRecord = Record<string, unknown>
type OverlayOrientation = 'vertical' | 'horizontal'
type Rect = { left: number; top: number; width: number; height: number }

type OverlayBlock = OcrRecognizeLayoutBlock & {
  location?: unknown
  points?: unknown
  orientation?: OverlayOrientation
  reading_order?: number
  column_index?: number
  line_index?: number
  slot_count?: number
  segmentation_source?: string
  needs_enhancement?: boolean
}

type OverlayOcrResult = OcrRecognizeResult & {
  layout_result?: OverlayBlock[]
}

type EnrichedOverlayBlock = OverlayBlock & {
  __index: number
  __rect: Rect
  __centerX: number
}

interface OverlayProofreaderProps {
  src: string
  pageId: string
  ocrResult: OverlayOcrResult | null | undefined
  pageProofStatus?: 'completed' | 'pending'
  activeBoxIndex?: number
  searchKeyword?: string
  viewport?: ViewerViewport
  onViewportChange?: (viewport: ViewerViewport) => void
  onSelectBox?: (index: number) => void
  onSave: (pageId: string, data: PageUpdatePayload) => void
}

interface VerticalColumnSlice {
  left: number
  width: number
  top: number
  height: number
  capacity: number
  detectedSlots: number
}

interface VerticalColumnLayout {
  columns: VerticalColumnSlice[]
  fontSize: number
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function isOverlayOrientation(value: unknown): value is OverlayOrientation {
  return value === 'vertical' || value === 'horizontal'
}

function getPointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number | null {
  if (isRecord(point)) return finiteNumber(point[key])
  if (Array.isArray(point)) return finiteNumber(point[tupleIndex])
  return null
}

function writingModeFor(orientation: OverlayOrientation): CSSProperties['writingMode'] {
  return orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb'
}

function textOrientationFor(orientation: OverlayOrientation): CSSProperties['textOrientation'] | undefined {
  return orientation === 'vertical' ? 'mixed' : undefined
}

const DEFAULT_VIEWPORT: ViewerViewport = {
  scale: 1,
  centerX: 0,
  centerY: 0,
  rotation: 0,
}

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
  paragraph_title: '段落标题',
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

const MASK_OPACITY = 0.78

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getRect(box: OverlayBlock | null | undefined): Rect | null {
  const loc = box?.location || box?.points
  if (!loc) return null
  if (isRecord(loc) && loc.left !== undefined) {
    const left = finiteNumber(loc.left)
    const top = finiteNumber(loc.top)
    const width = finiteNumber(loc.width)
    const height = finiteNumber(loc.height)
    if (left === null || top === null || width === null || height === null) return null
    return {
      left,
      top,
      width,
      height,
    }
  }
  if (Array.isArray(loc) && loc.length === 4) {
    const xs = loc.map((point) => getPointCoordinate(point, 'x', 0)).filter((value): value is number => value !== null)
    const ys = loc.map((point) => getPointCoordinate(point, 'y', 1)).filter((value): value is number => value !== null)
    if (xs.length === 0 || ys.length === 0) return null
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    return {
      left,
      top,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top,
    }
  }
  return null
}

function inferOrientation(box: OverlayBlock | null | undefined): OverlayOrientation {
  if (isOverlayOrientation(box?.orientation)) {
    return box.orientation
  }
  const rect = getRect(box)
  if (!rect) return 'horizontal'
  return rect.height >= rect.width * 1.2 ? 'vertical' : 'horizontal'
}

function getVerticalColumns(text: string): string[] {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const hardLines = source.includes('\n')
    ? source.split(/\n+/)
    : source.split(/[ \t]+/)
  return hardLines
    .map((line) => line.replace(/[ \t]+/g, '').trim())
    .filter(Boolean)
}

function getVerticalFlowText(text: string): string {
  return getVerticalColumns(text).join('')
}

function getDisplayText(text: string, orientation: 'vertical' | 'horizontal'): string {
  const rawText = String(text || '')
  if (orientation === 'vertical') {
    return getVerticalColumns(rawText).join('\n')
  }
  return rawText.replace(/\r\n/g, '\n')
}

function renderOverlaySearchHighlight(text: string, keyword: string, active = false): ReactNode {
  const trimmed = keyword.trim()
  if (!trimmed) return text
  try {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escaped})`, 'gi')
    const nodes: ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null
    let nodeIndex = 0
    while ((match = regex.exec(text))) {
      if (match.index > lastIndex) {
        nodes.push(text.slice(lastIndex, match.index))
      }
      const markStyle: CSSProperties & {
        boxDecorationBreak?: 'clone'
        WebkitBoxDecorationBreak?: 'clone'
      } = {
        backgroundColor: active ? '#ff9f1a' : '#ffc069',
        color: '#111111',
        padding: '0 2px',
        borderRadius: 2,
        fontWeight: active ? 800 : 700,
        outline: active ? '2px solid rgba(255,242,184,0.9)' : 'none',
        boxDecorationBreak: 'clone',
        WebkitBoxDecorationBreak: 'clone',
      }
      nodes.push(
        <mark
          key={`overlay-hit-${nodeIndex++}`}
          data-search-hit="true"
          data-search-active={active ? 'true' : undefined}
          style={markStyle}
        >
          {match[0]}
        </mark>,
      )
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < text.length) {
      nodes.push(text.slice(lastIndex))
    }
    return nodes
  } catch {
    return text
  }
}

function smoothSeries(values: number[], radius = 2): number[] {
  return values.map((_, index) => {
    let total = 0
    let count = 0
    for (let offset = -radius; offset <= radius; offset += 1) {
      const next = index + offset
      if (next >= 0 && next < values.length) {
        total += values[next]
        count += 1
      }
    }
    return count > 0 ? total / count : values[index]
  })
}

function mergeRuns(runs: Array<{ start: number; end: number }>, gap = 3): Array<{ start: number; end: number }> {
  if (runs.length === 0) return []
  const merged = [runs[0]]
  for (let index = 1; index < runs.length; index += 1) {
    const current = runs[index]
    const last = merged[merged.length - 1]
    if (current.start - last.end <= gap) {
      last.end = current.end
    } else {
      merged.push({ ...current })
    }
  }
  return merged
}

function findInkRuns(series: number[], threshold: number, minSize: number): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = []
  let start = -1

  for (let index = 0; index < series.length; index += 1) {
    if (series[index] >= threshold) {
      if (start === -1) start = index
    } else if (start !== -1) {
      if (index - start >= minSize) {
        runs.push({ start, end: index })
      }
      start = -1
    }
  }

  if (start !== -1 && series.length - start >= minSize) {
    runs.push({ start, end: series.length })
  }

  return mergeRuns(runs)
}

function analyzeVerticalColumnLayout(
  imageElement: HTMLImageElement,
  rect: { left: number; top: number; width: number; height: number },
  text: string,
): VerticalColumnLayout | null {
  const cleanText = getVerticalFlowText(text)
  if (!cleanText || rect.width < 18 || rect.height < 40) return null

  const cropWidth = Math.max(1, Math.round(rect.width))
  const cropHeight = Math.max(1, Math.round(rect.height))
  const canvas = document.createElement('canvas')
  canvas.width = cropWidth
  canvas.height = cropHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  context.drawImage(
    imageElement,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    0,
    0,
    cropWidth,
    cropHeight,
  )

  const imageData = context.getImageData(0, 0, cropWidth, cropHeight).data
  const xInk = new Array<number>(cropWidth).fill(0)

  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const index = (y * cropWidth + x) * 4
      const alpha = imageData[index + 3]
      if (alpha < 8) continue
      const luminance = imageData[index] * 0.299 + imageData[index + 1] * 0.587 + imageData[index + 2] * 0.114
      if (luminance < 214) {
        xInk[x] += 1
      }
    }
  }

  const smoothedX = smoothSeries(xInk, 2)
  const maxX = Math.max(...smoothedX, 0)
  if (maxX <= 0) return null

  const xThreshold = Math.max(3, maxX * 0.2)
  const rawRuns = findInkRuns(smoothedX, xThreshold, Math.max(4, Math.round(cropWidth * 0.035)))
    .filter((run) => run.end - run.start >= Math.max(6, Math.round(cropWidth * 0.04)))

  if (rawRuns.length === 0) return null

  const estimatedCharWidth = rawRuns.reduce((sum, run) => sum + (run.end - run.start), 0) / rawRuns.length
  const charSize = clamp(estimatedCharWidth * 0.92, 10, 160)

  const columns = rawRuns.map((run) => {
    const yInk = new Array<number>(cropHeight).fill(0)
    for (let y = 0; y < cropHeight; y += 1) {
      let count = 0
      for (let x = run.start; x < run.end; x += 1) {
        const index = (y * cropWidth + x) * 4
        const alpha = imageData[index + 3]
        if (alpha < 8) continue
        const luminance = imageData[index] * 0.299 + imageData[index + 1] * 0.587 + imageData[index + 2] * 0.114
        if (luminance < 214) {
          count += 1
        }
      }
      yInk[y] = count
    }

    const smoothedY = smoothSeries(yInk, 2)
    const maxY = Math.max(...smoothedY, 0)
    const yThreshold = Math.max(1, maxY * 0.16)
    const yRuns = findInkRuns(smoothedY, yThreshold, Math.max(6, Math.round(cropHeight * 0.03)))
    const first = yRuns[0]
    const last = yRuns[yRuns.length - 1]
    const top = first ? first.start : 0
    const bottom = last ? last.end : cropHeight
    const activeHeight = Math.max(24, bottom - top)
    const detectedSlots = Math.max(1, yRuns.length)
    const estimatedSlots = Math.max(1, Math.round(activeHeight / (charSize * 1.02)))
    const capacity = Math.max(detectedSlots, Math.min(estimatedSlots, detectedSlots + 2))

    return {
      left: run.start,
      width: run.end - run.start,
      top,
      height: activeHeight,
      capacity,
      detectedSlots,
    }
  })

  columns.sort((left, right) => right.left - left.left)

  const totalCapacity = columns.reduce((sum, column) => sum + column.capacity, 0)
  if (totalCapacity < cleanText.length) {
    let remaining = cleanText.length - totalCapacity
    for (const column of columns) {
      if (remaining <= 0) break
      const bonus = Math.max(1, Math.min(2, remaining))
      column.capacity += bonus
      remaining -= bonus
    }
    while (remaining > 0 && columns.length > 0) {
      columns[columns.length - 1].capacity += 1
      remaining -= 1
    }
  }

  return {
    columns,
    fontSize: charSize,
  }
}

function getOverlayTypography(rect: { width: number; height: number }, text: string, orientation: 'vertical' | 'horizontal') {
  const cleanText = getDisplayText(text, orientation)
  const charCount = Math.max(1, cleanText.length)

  if (orientation === 'vertical') {
    const padding = clamp(Math.min(rect.width, rect.height) * 0.03, 1, 4)
    const usableWidth = Math.max(24, rect.width - padding * 2)
    const usableHeight = Math.max(24, rect.height - padding * 2)
    let low = 10
    let high = Math.min(usableWidth, usableHeight, 160)
    let best = 10

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const mid = (low + high) / 2
      const charsPerColumn = Math.max(1, Math.floor(usableHeight / (mid * 1.08)))
      const columnCount = Math.max(1, Math.ceil(charCount / charsPerColumn))
      const requiredWidth = columnCount * mid * 1.06

      if (requiredWidth <= usableWidth) {
        best = mid
        low = mid
      } else {
        high = mid
      }
    }

    const fontSize = clamp(best, 10, 160)
    return {
      fontSize,
      lineHeight: 1,
      paddingInline: padding,
      paddingBlock: clamp(padding * 0.6, 1, 3),
    }
  }

  const padding = clamp(Math.min(rect.width, rect.height) * 0.05, 1, 6)
  const usableWidth = Math.max(12, rect.width - padding * 2)
  const usableHeight = Math.max(12, rect.height - padding * 2)
  const estimatedCharsPerLine = clamp(Math.floor(usableWidth / 14), 1, charCount)
  const estimatedLines = Math.max(1, Math.ceil(charCount / estimatedCharsPerLine))
  const fontSize = clamp(Math.min(usableHeight / estimatedLines * 0.9, usableWidth / estimatedCharsPerLine * 1.4), 10, 84)
  return {
    fontSize,
    lineHeight: 1.12,
    paddingInline: padding,
    paddingBlock: padding,
  }
}

function sortGujiBlocks(blocks: OverlayBlock[]): OverlayBlock[] {
  if (blocks.some((block) => Number.isFinite(block?.reading_order))) {
    return [...blocks].sort((left, right) => (left.reading_order ?? 0) - (right.reading_order ?? 0))
  }

  const enriched = blocks
    .map((block, index) => {
      const rect = getRect(block)
      if (!rect) return null
      return {
        ...block,
        __index: index,
        __rect: rect,
        __centerX: rect.left + rect.width / 2,
      }
    })
    .filter((block): block is EnrichedOverlayBlock => block !== null)

  if (enriched.length === 0) return blocks

  const widths = enriched.map((block) => block.__rect.width)
  const avgWidth = widths.reduce((sum, width) => sum + width, 0) / widths.length
  const threshold = Math.max(20, avgWidth * 0.65)

  enriched.sort((left, right) => right.__centerX - left.__centerX)

  const columns: Array<{ centerX: number; items: EnrichedOverlayBlock[] }> = []
  enriched.forEach((block) => {
    const column = columns.find((item) => Math.abs(item.centerX - block.__centerX) <= threshold)
    if (column) {
      column.items.push(block)
      column.centerX = (column.centerX * (column.items.length - 1) + block.__centerX) / column.items.length
    } else {
      columns.push({ centerX: block.__centerX, items: [block] })
    }
  })

  columns.sort((left, right) => right.centerX - left.centerX)
  const ordered: EnrichedOverlayBlock[] = []
  columns.forEach((column, columnIndex) => {
    column.items
      .sort((left, right) => left.__rect.top - right.__rect.top || right.__rect.left - left.__rect.left)
      .forEach((block) => {
        ordered.push({
          ...block,
          column_index: columnIndex,
          orientation: inferOrientation(block),
        })
      })
  })

  return ordered.map(({ __index, __rect, __centerX, ...block }, index) => ({
    ...block,
    reading_order: index,
    column_index: block.column_index ?? 0,
    orientation: block.orientation ?? inferOrientation(block),
  }))
}

function normalizeBlockOrder(blocks: OverlayBlock[]): OverlayBlock[] {
  return blocks.map((block, index) => ({
    ...block,
    reading_order: index,
    line_index: Number.isFinite(block.line_index) ? block.line_index : index,
    orientation: block.orientation || inferOrientation(block),
    segmentation_source: block.segmentation_source || 'manual',
    needs_enhancement: !!block.needs_enhancement,
  }))
}

function buildOcrPayload(baseOcrResult: OverlayOcrResult | null | undefined, blocks: OverlayBlock[], proofStatus: 'completed' | 'pending' = 'pending'): PageUpdatePayload {
  const normalizedBlocks = blocks.map((block, index) => ({
    ...block,
    reading_order: Number.isFinite(block.reading_order) ? block.reading_order : index,
    orientation: block.orientation || inferOrientation(block),
  }))
  const fullText = normalizedBlocks.map((block) => String(block.words || '').trim()).filter(Boolean).join('\n')
  return {
    ocr_result: {
      ...(baseOcrResult || {}),
      layout_result: normalizedBlocks,
      words_result: normalizedBlocks.map((block) => ({ words: block.words || '' })),
    },
    ocr_text: fullText,
    proofed_text: fullText,
    proof_status: proofStatus,
  }
}

export default function OverlayProofreader({
  src,
  pageId,
  ocrResult,
  pageProofStatus = 'pending',
  activeBoxIndex = -1,
  searchKeyword = '',
  viewport,
  onViewportChange,
  onSelectBox,
  onSave,
}: OverlayProofreaderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewportState, setViewportState] = useState<ViewerViewport>(DEFAULT_VIEWPORT)
  const [blocks, setBlocks] = useState<OverlayBlock[]>([])
  const [history, setHistory] = useState<OverlayBlock[][]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [isDragging, setIsDragging] = useState(false)
  const [editingIndex, setEditingIndex] = useState(-1)
  const [editValue, setEditValue] = useState('')
  const [imageReadyKey, setImageReadyKey] = useState(0)
  const imageSize = useRef({ width: 0, height: 0 })
  const imageElementRef = useRef<HTMLImageElement | null>(null)
  const dragStart = useRef({ x: 0, y: 0, centerX: 0, centerY: 0 })
  const mouseDownPos = useRef({ x: 0, y: 0 })
  const latestViewportRef = useRef(DEFAULT_VIEWPORT)
  const lastFocusedBoxRef = useRef(-1)
  const controlledViewport = viewport !== undefined
  const currentViewport = controlledViewport ? viewport : viewportState

  useEffect(() => {
    latestViewportRef.current = currentViewport
  }, [currentViewport])

  const updateViewport = useCallback((nextViewport: ViewerViewport) => {
    if (!controlledViewport) {
      setViewportState(nextViewport)
    }
    onViewportChange?.(nextViewport)
  }, [controlledViewport, onViewportChange])

  const fitToScreen = useCallback(() => {
    if (!containerRef.current || !imageSize.current.width || !imageSize.current.height) return
    const container = containerRef.current
    const scaleX = container.clientWidth / imageSize.current.width
    const scaleY = container.clientHeight / imageSize.current.height
    updateViewport({
      scale: Math.min(scaleX, scaleY) * 0.95,
      centerX: imageSize.current.width / 2,
      centerY: imageSize.current.height / 2,
      rotation: 0,
    })
  }, [updateViewport])

  useEffect(() => {
    const nextBlocks = sortGujiBlocks(ocrResult?.layout_result || [])
    setBlocks(nextBlocks)
    setHistory([nextBlocks.map((block) => ({ ...block }))])
    setHistoryIndex(0)
    setEditingIndex(-1)
    setEditValue('')
  }, [ocrResult])

  useEffect(() => {
    if (!src) return
    const img = new Image()
    img.onload = () => {
      imageSize.current = { width: img.width, height: img.height }
      fitToScreen()
    }
    img.src = src
  }, [fitToScreen, src])

  useEffect(() => {
    if (activeBoxIndex === lastFocusedBoxRef.current) return
    lastFocusedBoxRef.current = activeBoxIndex
    if (activeBoxIndex < 0 || !blocks[activeBoxIndex]) return
    const rect = getRect(blocks[activeBoxIndex])
    if (!rect) return
    updateViewport({
      ...latestViewportRef.current,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    })
  }, [activeBoxIndex, blocks, updateViewport])

  useEffect(() => {
    if (!isDragging) return undefined

    const handleDocumentMouseMove = (event: globalThis.MouseEvent) => {
      const viewportAtMove = latestViewportRef.current
      const dx = event.clientX - dragStart.current.x
      const dy = event.clientY - dragStart.current.y
      updateViewport({
        ...viewportAtMove,
        centerX: dragStart.current.centerX - dx / viewportAtMove.scale,
        centerY: dragStart.current.centerY - dy / viewportAtMove.scale,
      })
    }

    const handleDocumentMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleDocumentMouseMove)
    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleDocumentMouseMove)
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [isDragging, updateViewport])

  const verticalLayouts = useMemo(() => {
    if (!imageElementRef.current) return new Map<number, VerticalColumnLayout>()
    const nextMap = new Map<number, VerticalColumnLayout>()
    blocks.forEach((block, index) => {
      const rect = getRect(block)
      if (!rect) return
      const orientation = block.orientation || inferOrientation(block)
      if (orientation !== 'vertical') return
      const text = getDisplayText(block.words || '', orientation)
      if (text.length < 8) return
      const layout = analyzeVerticalColumnLayout(imageElementRef.current!, rect, text)
      if (layout && layout.columns.length > 0) {
        nextMap.set(index, layout)
      }
    })
    return nextMap
  }, [blocks, imageReadyKey, src])

  const imageTransform = useMemo(() => {
    const container = containerRef.current
    const offsetX = container ? container.clientWidth / 2 - currentViewport.centerX * currentViewport.scale : 0
    const offsetY = container ? container.clientHeight / 2 - currentViewport.centerY * currentViewport.scale : 0
    return `translate(${offsetX}px, ${offsetY}px) scale(${currentViewport.scale}) rotate(${currentViewport.rotation}deg)`
  }, [currentViewport])

  const pushHistory = useCallback((nextBlocks: OverlayBlock[]) => {
    setHistory((prev) => {
      const base = prev.slice(0, historyIndex + 1)
      base.push(nextBlocks.map((block) => ({ ...block })))
      return base.slice(-50)
    })
    setHistoryIndex((prev) => Math.min(prev + 1, 49))
  }, [historyIndex])

  const persistBlocks = useCallback((nextBlocks: OverlayBlock[]) => {
    onSave(pageId, buildOcrPayload(ocrResult, nextBlocks, pageProofStatus))
  }, [ocrResult, onSave, pageId, pageProofStatus])

  const commitBlocks = useCallback((nextBlocks: OverlayBlock[], nextActiveIndex?: number) => {
    const normalizedBlocks = normalizeBlockOrder(nextBlocks)
    setBlocks(normalizedBlocks)
    pushHistory(normalizedBlocks)
    persistBlocks(normalizedBlocks)
    setEditingIndex(-1)
    setEditValue('')
    if (typeof nextActiveIndex === 'number') {
      onSelectBox?.(Math.max(0, Math.min(normalizedBlocks.length - 1, nextActiveIndex)))
    }
  }, [onSelectBox, persistBlocks, pushHistory])

  const handleUndo = useCallback(() => {
    if (historyIndex <= 0) return
    const nextIndex = historyIndex - 1
    setHistoryIndex(nextIndex)
    setBlocks(history[nextIndex].map((block) => ({ ...block })))
    setEditingIndex(-1)
  }, [history, historyIndex])

  const handleRedo = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    const nextIndex = historyIndex + 1
    setHistoryIndex(nextIndex)
    setBlocks(history[nextIndex].map((block) => ({ ...block })))
    setEditingIndex(-1)
  }, [history, historyIndex])

  const handleSaveBlock = (index: number) => {
    const nextBlocks = blocks.map((block, blockIndex) => (
      blockIndex === index
        ? { ...block, words: editValue }
        : block
    ))
    commitBlocks(nextBlocks, index)
  }

  const handleSplitBlock = useCallback((index: number) => {
    const block = blocks[index]
    const rect = getRect(block)
    const verticalLayout = verticalLayouts.get(index)
    if (!block || !rect || !verticalLayout || verticalLayout.columns.length < 2) return

    const text = getDisplayText(block.words || '', 'vertical')
    if (!text) return

    let offset = 0
    const nextParts = verticalLayout.columns.map((column, columnIndex): OverlayBlock | null => {
      const isLast = columnIndex === verticalLayout.columns.length - 1
      const segment = isLast ? text.slice(offset) : text.slice(offset, offset + column.capacity)
      offset += column.capacity
      if (!segment) return null

      return {
        ...block,
        words: segment,
        location: {
          left: rect.left + column.left,
          top: rect.top + column.top,
          width: column.width,
          height: column.height,
        },
        orientation: 'vertical',
        column_index: columnIndex,
        line_index: 0,
        slot_count: column.detectedSlots || segment.length,
        segmentation_source: 'manual',
      }
    }).filter((part): part is OverlayBlock => part !== null)

    if (nextParts.length <= 1) return

    const nextBlocks = [
      ...blocks.slice(0, index),
      ...nextParts,
      ...blocks.slice(index + 1),
    ]
    commitBlocks(nextBlocks, index)
  }, [blocks, commitBlocks, verticalLayouts])

  const handleMergeWithNext = useCallback((index: number) => {
    const current = blocks[index]
    const next = blocks[index + 1]
    const currentRect = getRect(current)
    const nextRect = getRect(next)
    if (!current || !next || !currentRect || !nextRect) return

    const mergedRect = {
      left: Math.min(currentRect.left, nextRect.left),
      top: Math.min(currentRect.top, nextRect.top),
      width: Math.max(currentRect.left + currentRect.width, nextRect.left + nextRect.width) - Math.min(currentRect.left, nextRect.left),
      height: Math.max(currentRect.top + currentRect.height, nextRect.top + nextRect.height) - Math.min(currentRect.top, nextRect.top),
    }

    const orientation = current.orientation || inferOrientation(current)
    const mergedWords = orientation === 'vertical'
      ? [getDisplayText(current.words || '', 'vertical'), getDisplayText(next.words || '', 'vertical')].filter(Boolean).join('\n')
      : [String(current.words || '').trim(), String(next.words || '').trim()].filter(Boolean).join('\n')
    const mergedBlock = {
      ...current,
      words: mergedWords,
      location: mergedRect,
      orientation,
      slot_count: Number(current.slot_count || 0) + Number(next.slot_count || 0),
      segmentation_source: 'manual',
      needs_enhancement: !!current.needs_enhancement || !!next.needs_enhancement,
    }

    const nextBlocks = [
      ...blocks.slice(0, index),
      mergedBlock,
      ...blocks.slice(index + 2),
    ]
    commitBlocks(nextBlocks, index)
  }, [blocks, commitBlocks])

  const handleMoveBlock = useCallback((index: number, direction: -1 | 1) => {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= blocks.length) return
    const nextBlocks = [...blocks]
    ;[nextBlocks[index], nextBlocks[targetIndex]] = [nextBlocks[targetIndex], nextBlocks[index]]
    commitBlocks(nextBlocks, targetIndex)
  }, [blocks, commitBlocks])

  const handleToggleEnhancement = useCallback((index: number) => {
    const nextBlocks = blocks.map((block, blockIndex) => (
      blockIndex === index
        ? { ...block, needs_enhancement: !block.needs_enhancement, segmentation_source: 'manual' }
        : block
    ))
    commitBlocks(nextBlocks, index)
  }, [blocks, commitBlocks])

  const handleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(true)
    dragStart.current = {
      x: event.clientX,
      y: event.clientY,
      centerX: currentViewport.centerX,
      centerY: currentViewport.centerY,
    }
    mouseDownPos.current = { x: event.clientX, y: event.clientY }
  }

  const isClick = (event: React.MouseEvent): boolean => {
    const dx = event.clientX - mouseDownPos.current.x
    const dy = event.clientY - mouseDownPos.current.y
    return Math.sqrt(dx * dx + dy * dy) < 5
  }

  const isKeywordMatch = useCallback((text: string) => {
    if (!searchKeyword.trim()) return false
    return text.toLowerCase().includes(searchKeyword.toLowerCase())
  }, [searchKeyword])

  if (!src) {
    return <Empty description="当前页面没有图像" />
  }

  if (blocks.length === 0) {
    return <Empty description="当前页面还没有可用于原图比对的 OCR 区块" />
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 100,
          background: 'rgba(0,0,0,0.6)',
          padding: 4,
          borderRadius: 8,
          backdropFilter: 'blur(4px)',
        }}
      >
        <Space size={4}>
          <Tooltip title="放大">
            <Button
              type="text"
              style={{ color: 'white' }}
              icon={<ZoomInOutlined />}
              onClick={() => updateViewport({ ...currentViewport, scale: Math.min(5, currentViewport.scale + 0.2) })}
            />
          </Tooltip>
          <Tooltip title="缩小">
            <Button
              type="text"
              style={{ color: 'white' }}
              icon={<ZoomOutOutlined />}
              onClick={() => updateViewport({ ...currentViewport, scale: Math.max(0.1, currentViewport.scale - 0.2) })}
            />
          </Tooltip>
          <Tooltip title="适应窗口">
            <Button type="text" style={{ color: 'white' }} icon={<ExpandOutlined />} onClick={fitToScreen} />
          </Tooltip>
          <Tooltip title="旋转">
            <Button
              type="text"
              style={{ color: 'white' }}
              icon={<RotateRightOutlined />}
              onClick={() => updateViewport({ ...currentViewport, rotation: (currentViewport.rotation + 90) % 360 })}
            />
          </Tooltip>
          <Tooltip title="撤销">
            <Button type="text" style={{ color: 'white' }} icon={<UndoOutlined />} disabled={historyIndex <= 0} onClick={handleUndo} />
          </Tooltip>
          <Tooltip title="重做">
            <Button
              type="text"
              style={{ color: 'white' }}
              icon={<RedoOutlined />}
              disabled={historyIndex >= history.length - 1}
              onClick={handleRedo}
            />
          </Tooltip>
        </Space>
      </div>

      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', cursor: isDragging ? 'grabbing' : 'grab' }}
        onWheel={(event) => {
          event.preventDefault()
          const direction = event.deltaY > 0 ? -1 : 1
          updateViewport({
            ...currentViewport,
            scale: Math.max(0.1, Math.min(5, currentViewport.scale + direction * 0.1)),
          })
        }}
        onMouseDown={handleMouseDown}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: imageTransform,
            transformOrigin: 'top left',
            transition: isDragging ? 'none' : 'transform 0.15s ease-out',
          }}
        >
          <img
            src={src}
            alt="proofreader"
            draggable={false}
            style={{ display: 'block', pointerEvents: 'none', userSelect: 'none' }}
            onLoad={(event) => {
              imageSize.current = {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              }
              imageElementRef.current = event.currentTarget
              setImageReadyKey((value) => value + 1)
            }}
          />

          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: `rgba(248,246,240,${MASK_OPACITY})`,
              pointerEvents: 'none',
            }}
          />

          {blocks.map((block, index) => {
            const rect = getRect(block)
            if (!rect) return null

            const isActive = index === activeBoxIndex
            const keywordMatch = isKeywordMatch(block.words || '')
            const label = block.label || 'text'
            const isEditing = index === editingIndex
            const orientation = block.orientation || inferOrientation(block)
            const displayText = getDisplayText(block.words || '', orientation)
            const verticalFlowText = orientation === 'vertical' ? getVerticalFlowText(displayText) : displayText
            const metrics = getOverlayTypography(rect, displayText, orientation)
            const verticalLayout = orientation === 'vertical' ? verticalLayouts.get(index) : null
            const showMeta = isActive || keywordMatch || isEditing

            return (
              <div
                key={`${index}-${block.reading_order ?? index}`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (isClick(event)) {
                    onSelectBox?.(index)
                  }
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  setEditingIndex(index)
                  setEditValue(block.words || '')
                }}
                style={{
                  position: 'absolute',
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  boxSizing: 'border-box',
                  border: isActive
                    ? '2px solid #1890ff'
                    : keywordMatch
                      ? '2px solid #ffc069'
                      : `1px solid ${LABEL_COLORS[label] || 'rgba(82,196,26,0.42)'}`,
                  background: isActive
                    ? 'rgba(24, 144, 255, 0.08)'
                    : keywordMatch
                      ? 'rgba(255, 192, 105, 0.1)'
                      : 'rgba(255,255,255,0.02)',
                  color: '#111111',
                  borderRadius: 2,
                  cursor: 'pointer',
                  backdropFilter: isActive || keywordMatch ? 'blur(0.4px)' : 'none',
                  zIndex: isActive ? 12 : keywordMatch ? 8 : 3,
                  overflow: 'hidden',
                }}
              >
                {showMeta ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                      <Space size={4} wrap>
                        <Tag color={LABEL_COLORS[label] || '#52c41a'} style={{ marginInlineEnd: 0 }}>
                          {LABEL_NAMES[label] || label}
                        </Tag>
                        <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                          #{(block.reading_order ?? index) + 1}
                        </Tag>
                        <Tag color={orientation === 'vertical' ? 'purple' : 'blue'} style={{ marginInlineEnd: 0 }}>
                          {orientation === 'vertical' ? '竖排' : '横排'}
                        </Tag>
                        {block.needs_enhancement ? (
                          <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                            待增强
                          </Tag>
                        ) : null}
                      </Space>
                      {isEditing ? (
                        <Space size={2}>
                          <Button size="small" type="link" onClick={() => setEditingIndex(-1)}>
                            取消
                          </Button>
                          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={() => handleSaveBlock(index)}>
                            保存
                          </Button>
                        </Space>
                      ) : null}
                    </div>

                    {!isEditing ? (
                      <Space size={0} wrap>
                        {verticalLayout && verticalLayout.columns.length > 1 ? (
                          <Button size="small" type="link" onClick={(event) => { event.stopPropagation(); handleSplitBlock(index) }}>
                            拆列
                          </Button>
                        ) : null}
                        {index < blocks.length - 1 ? (
                          <Button size="small" type="link" onClick={(event) => { event.stopPropagation(); handleMergeWithNext(index) }}>
                            合列
                          </Button>
                        ) : null}
                        <Button size="small" type="link" disabled={index <= 0} onClick={(event) => { event.stopPropagation(); handleMoveBlock(index, -1) }}>
                          前移
                        </Button>
                        <Button size="small" type="link" disabled={index >= blocks.length - 1} onClick={(event) => { event.stopPropagation(); handleMoveBlock(index, 1) }}>
                          后移
                        </Button>
                        <Button size="small" type="link" onClick={(event) => { event.stopPropagation(); handleToggleEnhancement(index) }}>
                          {block.needs_enhancement ? '取消待增强' : '标记待增强'}
                        </Button>
                      </Space>
                    ) : null}
                  </div>
                ) : null}

                {isEditing ? (
                  <Input.TextArea
                    value={editValue}
                    autoSize={{ minRows: 2, maxRows: 10 }}
                    onChange={(event) => setEditValue(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      fontFamily: '"Noto Serif SC", serif',
                      writingMode: writingModeFor(orientation),
                      fontSize: metrics.fontSize,
                      lineHeight: metrics.lineHeight,
                      color: '#111111',
                      background: 'rgba(255,255,255,0.92)',
                    }}
                  />
                ) : (
                  verticalLayout ? (
                    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                      {(() => {
                        let offset = 0
                        return verticalLayout.columns.map((column, columnIndex) => {
                          const segment = verticalFlowText.slice(offset, offset + column.capacity)
                          offset += column.capacity
                          if (!segment) return null
                          const columnFontSize = clamp(
                            Math.min(
                              verticalLayout.fontSize,
                              column.width * 0.92,
                              column.height / Math.max(segment.length, 1) * 0.98,
                            ),
                            10,
                            160,
                          )
                          return (
                            <div
                              key={`${index}-column-${columnIndex}`}
                              style={{
                                position: 'absolute',
                                left: column.left,
                                top: column.top,
                                width: column.width,
                                height: column.height,
                                writingMode: 'vertical-rl',
                                textOrientation: 'mixed',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                overflowWrap: 'anywhere',
                                lineHeight: 1,
                                fontSize: columnFontSize,
                                fontFamily: '"Noto Serif SC", serif',
                                fontWeight: 600,
                                color: '#111111',
                                textShadow: '0 0 1px rgba(255,255,255,0.75)',
                                WebkitTextStroke: '0.15px rgba(255,255,255,0.42)',
                                overflow: 'hidden',
                              }}
                            >
                              {renderOverlaySearchHighlight(segment, searchKeyword, isActive && keywordMatch)}
                            </div>
                          )
                        })
                      })()}
                    </div>
                  ) : (
                    <div
                      style={{
                        fontFamily: '"Noto Serif SC", serif',
                        lineHeight: metrics.lineHeight,
                        fontSize: metrics.fontSize,
                        whiteSpace: orientation === 'vertical' ? 'pre-wrap' : 'pre-wrap',
                        wordBreak: orientation === 'vertical' ? 'break-all' : 'break-word',
                        overflowWrap: 'anywhere',
                        writingMode: writingModeFor(orientation),
                        textOrientation: textOrientationFor(orientation),
                        paddingInline: metrics.paddingInline,
                        paddingBlock: metrics.paddingBlock,
                        width: '100%',
                        height: '100%',
                        overflow: 'hidden',
                        letterSpacing: 0,
                        fontWeight: 600,
                        color: '#111111',
                        textShadow: '0 0 1px rgba(255,255,255,0.75)',
                        WebkitTextStroke: '0.15px rgba(255,255,255,0.42)',
                      }}
                    >
                      {renderOverlaySearchHighlight(displayText, searchKeyword, isActive && keywordMatch)}
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

