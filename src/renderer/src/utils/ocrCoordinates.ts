export interface OcrCoordinateSourceSize {
  width?: number | null
  height?: number | null
  preserveServiceCoordinates?: boolean
}

export interface OcrSize {
  width: number
  height: number
}

export interface OcrBlockRect {
  left: number
  top: number
  width: number
  height: number
}

export interface OcrCoordinateExtent {
  minLeft: number
  minTop: number
  maxRight: number
  maxBottom: number
}

export interface OcrLayoutBounds {
  width: number
  height: number
  offsetLeft: number
  offsetTop: number
}

export interface OcrCoordinateScale {
  scaleX: number
  scaleY: number
}

export interface OcrInkBitmap {
  data: ArrayLike<number>
  width: number
  height: number
}

interface ActiveRun {
  start: number
  end: number
  total: number
  max: number
}

type JsonRecord = Record<string, unknown>

const OCR_RECT_KEYS = [
  '__rect',
  'location',
  'rect',
  'points',
  'block_bbox',
  'bbox',
  'box',
  'coordinate',
  'coordinate_box',
  'poly',
  'polygon',
]

export function isOcrCoordinateRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecordValue(source: unknown, key: string): unknown {
  return isOcrCoordinateRecord(source) ? source[key] : undefined
}

function firstRecordValue(source: unknown, keys: string[]): unknown {
  for (const key of keys) {
    const value = readRecordValue(source, key)
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function pointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number | null {
  if (isOcrCoordinateRecord(point)) return finiteNumber(point[key])
  if (Array.isArray(point)) return finiteNumber(point[tupleIndex])
  return null
}

function normalizeRect(left: number, top: number, width: number, height: number): OcrBlockRect | null {
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { left, top, width, height }
}

function rectFromRecord(loc: JsonRecord): OcrBlockRect | null {
  const left = finiteNumber(loc.left ?? loc.x)
  const top = finiteNumber(loc.top ?? loc.y)
  const width = finiteNumber(loc.width ?? loc.w)
  const height = finiteNumber(loc.height ?? loc.h)
  if (left !== null && top !== null && width !== null && height !== null) {
    return normalizeRect(left, top, width, height)
  }

  const x1 = finiteNumber(loc.left ?? loc.x ?? loc.x1 ?? loc.x0)
  const y1 = finiteNumber(loc.top ?? loc.y ?? loc.y1 ?? loc.y0)
  const x2 = finiteNumber(loc.right ?? loc.x2)
  const y2 = finiteNumber(loc.bottom ?? loc.y2)
  if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
    const rectLeft = Math.min(x1, x2)
    const rectTop = Math.min(y1, y2)
    return normalizeRect(rectLeft, rectTop, Math.abs(x2 - x1), Math.abs(y2 - y1))
  }

  return null
}

function rectFromNumericArray(numbers: number[]): OcrBlockRect | null {
  if (numbers.length < 4 || numbers.some((value) => !Number.isFinite(value))) return null
  if (numbers.length >= 8) {
    const xs = [numbers[0], numbers[2], numbers[4], numbers[6]]
    const ys = [numbers[1], numbers[3], numbers[5], numbers[7]]
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    return normalizeRect(left, top, Math.max(...xs) - left, Math.max(...ys) - top)
  }

  const [left, top, third, fourth] = numbers
  if (third > left && fourth > top) {
    return normalizeRect(left, top, third - left, fourth - top)
  }
  return normalizeRect(left, top, third, fourth)
}

export function getOcrBlockRectFromValue(loc: unknown): OcrBlockRect | null {
  if (!loc) return null
  if (isOcrCoordinateRecord(loc)) return rectFromRecord(loc)

  if (Array.isArray(loc) && loc.length >= 4) {
    if (typeof loc[0] === 'number') {
      return rectFromNumericArray(loc.map(Number))
    }
    const xs = loc.map((point) => pointCoordinate(point, 'x', 0)).filter((value): value is number => value !== null)
    const ys = loc.map((point) => pointCoordinate(point, 'y', 1)).filter((value): value is number => value !== null)
    if (xs.length === 0 || ys.length === 0) return null
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    return normalizeRect(left, top, Math.max(...xs) - left, Math.max(...ys) - top)
  }

  return null
}

export function getOcrBlockRect(block: unknown): OcrBlockRect | null {
  return getOcrBlockRectFromValue(firstRecordValue(block, OCR_RECT_KEYS))
}

export function getOcrCoordinateExtent(blocks: unknown[]): OcrCoordinateExtent | null {
  const rects = blocks.map(getOcrBlockRect).filter((rect): rect is OcrBlockRect => rect !== null)
  if (rects.length === 0) return null
  return {
    minLeft: Math.min(...rects.map((rect) => rect.left)),
    minTop: Math.min(...rects.map((rect) => rect.top)),
    maxRight: Math.max(...rects.map((rect) => rect.left + rect.width)),
    maxBottom: Math.max(...rects.map((rect) => rect.top + rect.height)),
  }
}

export function getOcrLayoutBounds(
  blocks: unknown[],
  coordinateSourceSize?: OcrCoordinateSourceSize | null,
  fallback: OcrSize = { width: 900, height: 1280 },
): OcrLayoutBounds {
  const explicitWidth = Number(coordinateSourceSize?.width || 0)
  const explicitHeight = Number(coordinateSourceSize?.height || 0)
  if (explicitWidth > 0 && explicitHeight > 0) {
    return { width: explicitWidth, height: explicitHeight, offsetLeft: 0, offsetTop: 0 }
  }

  const rects = blocks.map(getOcrBlockRect).filter((rect): rect is OcrBlockRect => rect !== null)
  if (rects.length === 0) return { ...fallback, offsetLeft: 0, offsetTop: 0 }
  const minLeft = Math.min(...rects.map((rect) => rect.left))
  const minTop = Math.min(...rects.map((rect) => rect.top))
  const maxRight = Math.max(...rects.map((rect) => rect.left + rect.width))
  const maxBottom = Math.max(...rects.map((rect) => rect.top + rect.height))
  const padX = Math.max(24, (maxRight - minLeft) * 0.06)
  const padY = Math.max(24, (maxBottom - minTop) * 0.05)
  return {
    width: maxRight - minLeft + padX * 2,
    height: maxBottom - minTop + padY * 2,
    offsetLeft: minLeft - padX,
    offsetTop: minTop - padY,
  }
}

export function isPositiveOcrSize(value?: OcrCoordinateSourceSize | OcrSize | null): value is OcrSize {
  return Number(value?.width || 0) > 0 && Number(value?.height || 0) > 0
}

export function ocrSizeDeltaRatio(left: OcrSize, right: OcrSize): number {
  return Math.max(
    Math.abs(left.width - right.width) / Math.max(1, right.width),
    Math.abs(left.height - right.height) / Math.max(1, right.height),
  )
}

export function coordinateExtentFitsSize(extent: OcrCoordinateExtent | null, size: OcrSize): boolean {
  if (!extent) return false
  return extent.minLeft >= -size.width * 0.04
    && extent.minTop >= -size.height * 0.04
    && extent.maxRight <= size.width * 1.08
    && extent.maxBottom <= size.height * 1.08
}

export function resolveOcrCoordinateSourceSizeForImage(
  coordinateSourceSize: OcrCoordinateSourceSize | undefined,
  pageImageNaturalSize: OcrSize | null,
  coordinateExtent: OcrCoordinateExtent | null,
): OcrCoordinateSourceSize | undefined {
  const explicitSize = isPositiveOcrSize(coordinateSourceSize)
    ? { width: Number(coordinateSourceSize.width), height: Number(coordinateSourceSize.height) }
    : null
  if (coordinateSourceSize?.preserveServiceCoordinates) {
    return explicitSize || pageImageNaturalSize || coordinateSourceSize
  }
  if (!pageImageNaturalSize) return explicitSize || coordinateSourceSize
  if (!explicitSize) return pageImageNaturalSize
  if (ocrSizeDeltaRatio(explicitSize, pageImageNaturalSize) <= 0.02) return pageImageNaturalSize

  const fitsImage = coordinateExtentFitsSize(coordinateExtent, pageImageNaturalSize)
  const fitsExplicit = coordinateExtentFitsSize(coordinateExtent, explicitSize)
  if (fitsImage && !fitsExplicit) return pageImageNaturalSize
  if (!fitsImage && fitsExplicit) return explicitSize
  if (fitsImage && fitsExplicit) return explicitSize
  return explicitSize
}

export function getOcrBoxSourceDimension(blocks: unknown[], keys: string[]): number {
  for (const block of blocks) {
    for (const key of keys) {
      const value = finiteNumber(readRecordValue(block, key))
      if (value !== null && value > 0) return value
    }
  }
  return 0
}

export function getOcrCoordinateScale(targetSize: OcrSize, sourceSize?: OcrCoordinateSourceSize | OcrSize | null): OcrCoordinateScale {
  const imageWidth = Number(targetSize.width || 0)
  const imageHeight = Number(targetSize.height || 0)
  const sourceWidth = Number(sourceSize?.width || 0)
  const sourceHeight = Number(sourceSize?.height || 0)
  if (!imageWidth || !imageHeight || !sourceWidth || !sourceHeight) return { scaleX: 1, scaleY: 1 }

  const widthRatio = sourceWidth / imageWidth
  const heightRatio = sourceHeight / imageHeight
  const shouldScale = widthRatio > 1.08 || heightRatio > 1.08 || widthRatio < 0.92 || heightRatio < 0.92
  if (!shouldScale) return { scaleX: 1, scaleY: 1 }

  return {
    scaleX: imageWidth / sourceWidth,
    scaleY: imageHeight / sourceHeight,
  }
}

export function scaleOcrBlockRect(rect: OcrBlockRect, coordinateScale: OcrCoordinateScale): OcrBlockRect {
  return {
    left: rect.left * coordinateScale.scaleX,
    top: rect.top * coordinateScale.scaleY,
    width: rect.width * coordinateScale.scaleX,
    height: rect.height * coordinateScale.scaleY,
  }
}

export function scaleOcrRectToWidth(rect: OcrBlockRect, bounds: OcrLayoutBounds, pagePixelWidth: number): OcrBlockRect {
  const scale = pagePixelWidth / Math.max(1, bounds.width)
  return {
    left: (rect.left - bounds.offsetLeft) * scale,
    top: (rect.top - bounds.offsetTop) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function smoothSeries(values: number[], radius: number): number[] {
  if (radius <= 0 || values.length <= 2) return values
  return values.map((_, index) => {
    const start = Math.max(0, index - radius)
    const end = Math.min(values.length, index + radius + 1)
    let sum = 0
    for (let cursor = start; cursor < end; cursor += 1) sum += values[cursor]
    return sum / Math.max(1, end - start)
  })
}

function findActiveRuns(values: number[], threshold: number, minLength = 2, maxGap = 2): ActiveRun[] {
  const runs: ActiveRun[] = []
  let start = -1
  let end = -1
  let gap = 0
  const pushRun = () => {
    if (start >= 0 && end > start && end - start >= minLength) {
      const slice = values.slice(start, end)
      runs.push({
        start,
        end,
        total: slice.reduce((sum, value) => sum + value, 0),
        max: Math.max(...slice, 0),
      })
    }
  }

  values.forEach((value, index) => {
    if (value >= threshold) {
      if (start < 0) start = index
      end = index + 1
      gap = 0
      return
    }
    if (start < 0) return
    gap += 1
    if (gap > maxGap) {
      end -= gap - 1
      pushRun()
      start = -1
      end = -1
      gap = 0
    }
  })
  if (start >= 0) {
    end -= gap
    pushRun()
  }
  return runs
}

function getInkLuminance(bitmap: OcrInkBitmap, x: number, y: number): number {
  const index = (y * bitmap.width + x) * 4
  const alpha = Number(bitmap.data[index + 3] ?? 255)
  if (alpha <= 8) return 255
  const red = Number(bitmap.data[index] ?? 255)
  const green = Number(bitmap.data[index + 1] ?? 255)
  const blue = Number(bitmap.data[index + 2] ?? 255)
  return red * 0.2126 + green * 0.7152 + blue * 0.0722
}

function getOcrInkSearchRect(rect: OcrBlockRect, bitmap: OcrInkBitmap, label: string): OcrBlockRect {
  const decorative = /header|footer|number|page/.test(label)
  const isFooter = /footer/.test(label)
  const padX = decorative
    ? Math.max(24, Math.round(rect.width * (isFooter ? 0.35 : 0.8)))
    : Math.max(6, Math.min(36, Math.round(rect.width * 0.035)))
  const padTop = decorative
    ? Math.max(isFooter ? 48 : 36, Math.round(rect.height * (isFooter ? 2.6 : 1.15)))
    : Math.max(8, Math.min(28, Math.round(rect.height * 0.32)))
  const padBottom = decorative
    ? Math.max(isFooter ? 24 : 56, Math.round(rect.height * (isFooter ? 1.4 : 2.2)))
    : Math.max(8, Math.min(24, Math.round(rect.height * 0.22)))
  const left = clampNumber(Math.floor(rect.left - padX), 0, Math.max(0, bitmap.width - 1))
  const top = clampNumber(Math.floor(rect.top - padTop), 0, Math.max(0, bitmap.height - 1))
  const right = clampNumber(Math.ceil(rect.left + rect.width + padX), left + 1, bitmap.width)
  const bottom = clampNumber(Math.ceil(rect.top + rect.height + padBottom), top + 1, bitmap.height)
  return { left, top, width: right - left, height: bottom - top }
}

function shouldUseInkAdjustedRect(original: OcrBlockRect, adjusted: OcrBlockRect, label: string, compactTextLength: number): boolean {
  const originalArea = Math.max(1, original.width * original.height)
  const adjustedArea = Math.max(1, adjusted.width * adjusted.height)
  if (adjustedArea / originalArea < (compactTextLength >= 80 ? 0.08 : 0.035)) return false
  const centerDx = Math.abs((adjusted.left + adjusted.width / 2) - (original.left + original.width / 2))
  const centerDy = Math.abs((adjusted.top + adjusted.height / 2) - (original.top + original.height / 2))
  const decorative = /header|footer|number|page/.test(label)
  const maxDx = decorative ? Math.max(42, original.width * 1.1) : Math.max(36, original.width * 0.2)
  const maxDy = decorative ? Math.max(72, original.height * 2.8) : Math.max(30, original.height * 0.95)
  if (centerDx > maxDx || centerDy > maxDy) return false
  if (adjusted.width < Math.max(8, original.width * (compactTextLength >= 80 ? 0.22 : 0.08))) return false
  if (adjusted.height < Math.max(6, original.height * (compactTextLength >= 80 ? 0.18 : 0.08))) return false
  return true
}

export function getInkAdjustedOcrRect(
  bitmap: OcrInkBitmap,
  rect: OcrBlockRect,
  options: { label?: unknown; text?: unknown } = {},
): OcrBlockRect | null {
  if (bitmap.width <= 1 || bitmap.height <= 1 || rect.width <= 1 || rect.height <= 1) return null
  const label = String(options.label || '').toLowerCase()
  if (/^(?:image|figure|picture|chart|diagram|photo|illustration|table)$/.test(label)) return null

  const search = getOcrInkSearchRect(rect, bitmap, label)
  const left = Math.floor(search.left)
  const top = Math.floor(search.top)
  const width = Math.max(1, Math.floor(search.width))
  const height = Math.max(1, Math.floor(search.height))
  const rowInk = new Array<number>(height).fill(0)
  const columnInk = new Array<number>(width).fill(0)
  let inkPixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (getInkLuminance(bitmap, left + x, top + y) < 214) {
        rowInk[y] += 1
        columnInk[x] += 1
        inkPixels += 1
      }
    }
  }
  if (inkPixels < Math.max(8, Math.min(width, height) * 0.45)) return null

  const smoothedRows = smoothSeries(rowInk, 1)
  const rowMax = Math.max(...smoothedRows, 0)
  if (rowMax <= 0) return null
  const rowRuns = findActiveRuns(smoothedRows, Math.max(2, rowMax * 0.08), 2, 2)
  if (rowRuns.length === 0) return null

  const originalTop = rect.top
  const originalBottom = rect.top + rect.height
  const decorative = /header|footer|number|page/.test(label)
  const verticalSlack = decorative ? Math.max(72, rect.height * 2.8) : Math.max(12, Math.min(30, rect.height * 0.35))
  const selectedRows = rowRuns.filter((run) => {
    const runTop = top + run.start
    const runBottom = top + run.end
    const runCenter = (runTop + runBottom) / 2
    return runBottom >= originalTop - verticalSlack
      && runTop <= originalBottom + verticalSlack
      && (decorative || (runCenter >= originalTop - verticalSlack && runCenter <= originalBottom + verticalSlack))
  })
  if (selectedRows.length === 0) return null
  const rowStart = Math.max(0, Math.min(...selectedRows.map((run) => run.start)) - 2)
  const rowEnd = Math.min(height, Math.max(...selectedRows.map((run) => run.end)) + 2)

  const selectedColumnInk = new Array<number>(width).fill(0)
  for (let y = rowStart; y < rowEnd; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (getInkLuminance(bitmap, left + x, top + y) < 214) {
        selectedColumnInk[x] += 1
      }
    }
  }
  const smoothedColumns = smoothSeries(selectedColumnInk, 1)
  const columnMax = Math.max(...smoothedColumns, 0)
  if (columnMax <= 0) return null
  const columnRuns = findActiveRuns(smoothedColumns, Math.max(1, columnMax * 0.08), 2, decorative ? 10 : 6)
  if (columnRuns.length === 0) return null
  const columnStart = Math.max(0, Math.min(...columnRuns.map((run) => run.start)) - 2)
  const columnEnd = Math.min(width, Math.max(...columnRuns.map((run) => run.end)) + 2)

  const adjusted = {
    left: left + columnStart,
    top: top + rowStart,
    width: Math.max(1, columnEnd - columnStart),
    height: Math.max(1, rowEnd - rowStart),
  }
  const compactTextLength = String(options.text || '').replace(/\s+/g, '').length
  return shouldUseInkAdjustedRect(rect, adjusted, label, compactTextLength) ? adjusted : null
}
