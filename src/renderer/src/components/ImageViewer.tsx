import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Button, Space, Tooltip } from 'antd'
import {
  ZoomInOutlined,
  ZoomOutOutlined,
  ExpandOutlined,
  UndoOutlined,
  RotateRightOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons'
import {
  getInkAdjustedOcrRect,
  getOcrBlockRect,
  getOcrBoxSourceDimension,
  getOcrCoordinateExtent,
  getOcrCoordinateScale,
  resolveOcrCoordinateSourceSizeForImage,
  scaleOcrBlockRect,
  type OcrCoordinateScale,
} from '../utils/ocrCoordinates'

export interface ViewerViewport {
  scale: number
  centerX: number
  centerY: number
  rotation: number
}

interface ImageViewerProps {
  src: string
  ocrBoxes?: ImageViewerOcrBox[]
  coordinateSourceSize?: { width?: number | null; height?: number | null; preserveServiceCoordinates?: boolean }
  activeBoxIndex?: number
  searchKeyword?: string
  onBoxClick?: (index: number) => void
  hasPrevPage?: boolean
  hasNextPage?: boolean
  onPrevPage?: () => void
  onNextPage?: () => void
  viewport?: ViewerViewport
  onViewportChange?: (viewport: ViewerViewport) => void
}

type BoxCoordinateScale = OcrCoordinateScale

type JsonRecord = Record<string, unknown>
type ImageViewerOcrBox = JsonRecord

interface BoxRect {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_VIEWPORT: ViewerViewport = {
  scale: 1,
  centerX: 0,
  centerY: 0,
  rotation: 0,
}

function getBoxRect(box: ImageViewerOcrBox, coordinateScale: BoxCoordinateScale = { scaleX: 1, scaleY: 1 }): BoxRect | null {
  const rect = getOcrBlockRect(box)
  if (!rect) return null
  const scaled = scaleOcrBlockRect(rect, coordinateScale)
  return { x: scaled.left, y: scaled.top, width: scaled.width, height: scaled.height }
}

export default function ImageViewer({
  src,
  ocrBoxes = [],
  coordinateSourceSize,
  activeBoxIndex = -1,
  searchKeyword = '',
  onBoxClick,
  hasPrevPage,
  hasNextPage,
  onPrevPage,
  onNextPage,
  viewport,
  onViewportChange,
}: ImageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewportState, setViewportState] = useState<ViewerViewport>(DEFAULT_VIEWPORT)
  const [isDragging, setIsDragging] = useState(false)
  const [renderedImageSize, setRenderedImageSize] = useState({ width: 0, height: 0 })
  const [inkAdjustedBoxRects, setInkAdjustedBoxRects] = useState<Record<number, BoxRect>>({})
  const dragStart = useRef({ x: 0, y: 0, centerX: 0, centerY: 0 })
  const mouseDownPos = useRef({ x: 0, y: 0 })
  const imageSize = useRef({ width: 0, height: 0 })
  const latestViewportRef = useRef(DEFAULT_VIEWPORT)
  const lastFocusedBoxRef = useRef(-1)

  const controlledViewport = viewport !== undefined
  const currentViewport = controlledViewport ? viewport : viewportState
  const hasCoordinates = ocrBoxes.some((box) => getBoxRect(box))
  const boxCoordinateScale = useMemo<BoxCoordinateScale>(() => {
    const imageWidth = renderedImageSize.width
    const imageHeight = renderedImageSize.height
    if (!imageWidth || !imageHeight || ocrBoxes.length === 0) return { scaleX: 1, scaleY: 1 }

    const explicitWidth = Number(
      coordinateSourceSize?.width
      || getOcrBoxSourceDimension(ocrBoxes, ['source_image_width', 'image_width', 'page_width'])
      || 0
    )
    const explicitHeight = Number(
      coordinateSourceSize?.height
      || getOcrBoxSourceDimension(ocrBoxes, ['source_image_height', 'image_height', 'page_height'])
      || 0
    )
    const resolvedSourceSize = resolveOcrCoordinateSourceSizeForImage(
      {
        width: explicitWidth,
        height: explicitHeight,
        preserveServiceCoordinates: coordinateSourceSize?.preserveServiceCoordinates,
      },
      { width: imageWidth, height: imageHeight },
      getOcrCoordinateExtent(ocrBoxes),
    )

    return getOcrCoordinateScale(
      { width: imageWidth, height: imageHeight },
      resolvedSourceSize,
    )
  }, [coordinateSourceSize?.height, coordinateSourceSize?.preserveServiceCoordinates, coordinateSourceSize?.width, ocrBoxes, renderedImageSize.height, renderedImageSize.width, src])

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
    if (!src) return
    const img = new Image()
    img.onload = () => {
      imageSize.current = { width: img.width, height: img.height }
      setRenderedImageSize({ width: img.width, height: img.height })
      fitToScreen()
    }
    img.src = src
  }, [fitToScreen, src])

  useEffect(() => {
    let canceled = false
    setInkAdjustedBoxRects({})
    if (!src || !hasCoordinates || !renderedImageSize.width || !renderedImageSize.height || ocrBoxes.length === 0) return undefined
    if (renderedImageSize.width * renderedImageSize.height > 16_000_000) return undefined

    const img = new Image()
    img.onload = () => {
      if (canceled) return
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return
      context.drawImage(img, 0, 0)
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
      const nextRects: Record<number, BoxRect> = {}
      ocrBoxes.forEach((box, index) => {
        const rect = getBoxRect(box, boxCoordinateScale)
        if (!rect) return
        const adjusted = getInkAdjustedOcrRect(
          { data: imageData.data, width: imageData.width, height: imageData.height },
          { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
          {
            label: box.label || box.block_label || box.type,
            text: box.words || box.word || box.text,
          },
        )
        if (!adjusted) return
        nextRects[index] = { x: adjusted.left, y: adjusted.top, width: adjusted.width, height: adjusted.height }
      })
      if (!canceled) setInkAdjustedBoxRects(nextRects)
      canvas.width = 1
      canvas.height = 1
    }
    img.src = src
    return () => {
      canceled = true
    }
  }, [boxCoordinateScale.scaleX, boxCoordinateScale.scaleY, hasCoordinates, ocrBoxes, renderedImageSize.height, renderedImageSize.width, src])

  useEffect(() => {
    if (activeBoxIndex === lastFocusedBoxRef.current) return
    lastFocusedBoxRef.current = activeBoxIndex
    if (activeBoxIndex < 0 || !imageSize.current.width || !ocrBoxes[activeBoxIndex]) return
    const box = ocrBoxes[activeBoxIndex]
    const rect = inkAdjustedBoxRects[activeBoxIndex] || getBoxRect(box, boxCoordinateScale)
    if (!rect) return
    updateViewport({
      ...latestViewportRef.current,
      centerX: rect.x + rect.width / 2,
      centerY: rect.y + rect.height / 2,
    })
  }, [activeBoxIndex, boxCoordinateScale, inkAdjustedBoxRects, ocrBoxes, updateViewport])

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

  const handleWheel = (event: React.WheelEvent) => {
    event.preventDefault()
    const zoomFactor = 0.1
    const direction = event.deltaY > 0 ? -1 : 1
    updateViewport({
      ...currentViewport,
      scale: Math.max(0.1, Math.min(5, currentViewport.scale + direction * zoomFactor)),
    })
  }

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

  const handleRotate = () => {
    updateViewport({
      ...currentViewport,
      rotation: (currentViewport.rotation + 90) % 360,
    })
  }

  const isClick = (event: React.MouseEvent): boolean => {
    const dx = event.clientX - mouseDownPos.current.x
    const dy = event.clientY - mouseDownPos.current.y
    return Math.sqrt(dx * dx + dy * dy) < 5
  }

  const isKeywordMatch = (box: ImageViewerOcrBox): boolean => {
    if (!searchKeyword || !searchKeyword.trim()) return false
    const text = String(box.words || box.word || '')
    return text.toLowerCase().includes(searchKeyword.toLowerCase())
  }

  const imageTransform = useMemo(() => {
    const container = containerRef.current
    const offsetX = container ? container.clientWidth / 2 - currentViewport.centerX * currentViewport.scale : 0
    const offsetY = container ? container.clientHeight / 2 - currentViewport.centerY * currentViewport.scale : 0
    return `translate(${offsetX}px, ${offsetY}px) scale(${currentViewport.scale}) rotate(${currentViewport.rotation}deg)`
  }, [currentViewport])

  const renderBoxes = () => {
    if (!ocrBoxes || ocrBoxes.length === 0) return null

    if (hasCoordinates) {
      return ocrBoxes.map((box, index) => {
        const rect = inkAdjustedBoxRects[index] || getBoxRect(box, boxCoordinateScale)
        if (!rect) return null

        const isActive = activeBoxIndex === index
        const keywordMatch = isKeywordMatch(box)
        const label = String(box.label || '')

        return (
          <div
            key={index}
            onClick={(event) => {
              event.stopPropagation()
              if (isClick(event) && onBoxClick) onBoxClick(index)
            }}
            style={{
              position: 'absolute',
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              border: isActive
                ? '2px solid #1890ff'
                : keywordMatch
                  ? '2px solid #ffc069'
                  : '1px solid rgba(250, 173, 20, 0.6)',
              backgroundColor: isActive
                ? 'rgba(24, 144, 255, 0.2)'
                : keywordMatch
                  ? 'rgba(255, 192, 105, 0.25)'
                  : 'transparent',
              cursor: 'pointer',
              transition: 'all 0.2s',
              zIndex: isActive ? 10 : keywordMatch ? 5 : 1,
            }}
          >
            {label ? (
              <span
                style={{
                  position: 'absolute',
                  top: -20,
                  left: 0,
                  fontSize: 11,
                  lineHeight: '18px',
                  padding: '0 4px',
                  backgroundColor: isActive ? '#1890ff' : keywordMatch ? '#ffc069' : 'rgba(250, 173, 20, 0.85)',
                  color: isActive || keywordMatch ? '#000' : '#fff',
                  borderRadius: 2,
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                }}
              >
                {label}
              </span>
            ) : null}
          </div>
        )
      })
    }

    const imgH = imageSize.current.height
    const imgW = imageSize.current.width
    if (!imgH || !imgW) return null
    const lineH = imgH / ocrBoxes.length

    return ocrBoxes.map((box, index) => {
      const isActive = activeBoxIndex === index
      const keywordMatch = isKeywordMatch(box)
      return (
        <div
          key={index}
          onClick={(event) => {
            event.stopPropagation()
            if (isClick(event) && onBoxClick) onBoxClick(index)
          }}
          style={{
            position: 'absolute',
            left: 0,
            top: index * lineH,
            width: imgW,
            height: lineH,
            border: isActive
              ? '2px solid #1890ff'
              : keywordMatch
                ? '2px solid #ffc069'
                : '1px dashed rgba(250, 173, 20, 0.3)',
            backgroundColor: isActive
              ? 'rgba(24, 144, 255, 0.15)'
              : keywordMatch
                ? 'rgba(255, 192, 105, 0.2)'
                : 'transparent',
            cursor: 'pointer',
            transition: 'all 0.2s',
            zIndex: isActive ? 10 : keywordMatch ? 5 : 1,
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: 4,
              fontSize: 10,
              lineHeight: '14px',
              padding: '0 3px',
              backgroundColor: isActive ? '#1890ff' : keywordMatch ? '#ffc069' : 'rgba(250, 173, 20, 0.7)',
              color: isActive || keywordMatch ? '#000' : '#fff',
              borderRadius: 2,
              pointerEvents: 'none',
            }}
          >
            {index + 1}
          </span>
        </div>
      )
    })
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {hasPrevPage ? (
        <div
          onClick={onPrevPage}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            cursor: 'pointer',
            background: 'linear-gradient(to right, rgba(0,0,0,0.3), transparent)',
            opacity: 0.6,
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.opacity = '1'
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.opacity = '0.6'
          }}
        >
          <LeftOutlined style={{ color: '#fff', fontSize: 20 }} />
        </div>
      ) : null}

      {hasNextPage ? (
        <div
          onClick={onNextPage}
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            cursor: 'pointer',
            background: 'linear-gradient(to left, rgba(0,0,0,0.3), transparent)',
            opacity: 0.6,
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.opacity = '1'
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.opacity = '0.6'
          }}
        >
          <RightOutlined style={{ color: '#fff', fontSize: 20 }} />
        </div>
      ) : null}

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
            <Button type="text" style={{ color: 'white' }} icon={<RotateRightOutlined />} onClick={handleRotate} />
          </Tooltip>
          <Tooltip title="重置">
            <Button type="text" style={{ color: 'white' }} icon={<UndoOutlined />} onClick={fitToScreen} />
          </Tooltip>
        </Space>
      </div>

      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', cursor: isDragging ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
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
          <img src={src} alt="viewer" draggable={false} style={{ display: 'block', pointerEvents: 'none', userSelect: 'none' }} />
          {renderBoxes()}
        </div>
      </div>
    </div>
  )
}
