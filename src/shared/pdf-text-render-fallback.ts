type PdfTextItemLike = {
  str?: unknown
  transform?: unknown
  width?: unknown
  height?: unknown
}

type PdfTextPageLike = {
  getTextContent?: (options?: Record<string, unknown>) => Promise<{ items?: unknown[] }>
}

type PdfViewportLike = {
  width?: number
  height?: number
  transform?: number[]
}

type CanvasContextLike = {
  getImageData?: (sx: number, sy: number, sw: number, sh: number) => { data: Uint8ClampedArray | Uint8Array }
  fillText?: (text: string, x: number, y: number, maxWidth?: number) => void
  save?: () => void
  restore?: () => void
  font?: string
  fillStyle?: unknown
  textBaseline?: CanvasTextBaseline
}

const CJK_TEXT_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const PDF_FALLBACK_FONT_FAMILY = 'SimSun, "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
const BLANK_TEXT_REGION_DARK_RATIO = 0.012

function isPdfTextItem(value: unknown): value is PdfTextItemLike {
  if (typeof value !== 'object' || value === null) return false
  const item = value as PdfTextItemLike
  return typeof item.str === 'string' && Array.isArray(item.transform) && item.transform.length >= 6
}

function multiplyTransform(left: number[], right: number[]): number[] {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getRegionDarkRatio(
  context: CanvasContextLike,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  if (!context.getImageData || canvasWidth <= 0 || canvasHeight <= 0) return 0
  const left = clampNumber(Math.floor(x), 0, Math.max(0, canvasWidth - 1))
  const top = clampNumber(Math.floor(y), 0, Math.max(0, canvasHeight - 1))
  const sampleWidth = clampNumber(Math.ceil(width), 1, canvasWidth - left)
  const sampleHeight = clampNumber(Math.ceil(height), 1, canvasHeight - top)
  try {
    const data = context.getImageData(left, top, sampleWidth, sampleHeight).data
    let darkPixels = 0
    let totalPixels = 0
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] ?? 255
      if (alpha <= 32) continue
      totalPixels += 1
      if ((data[index] ?? 255) < 220 || (data[index + 1] ?? 255) < 220 || (data[index + 2] ?? 255) < 220) {
        darkPixels += 1
      }
    }
    return darkPixels / Math.max(1, totalPixels)
  } catch {
    return 0
  }
}

export async function applyCjkTextRenderFallback(
  page: PdfTextPageLike,
  viewport: PdfViewportLike,
  context: CanvasContextLike,
  canvasWidth: number,
  canvasHeight: number,
): Promise<number> {
  if (!page.getTextContent || !context.fillText) return 0
  const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
  const items = Array.isArray(content.items) ? content.items.filter(isPdfTextItem) : []
  if (!items.some((item) => CJK_TEXT_RE.test(String(item.str || '')))) return 0

  const viewportTransform = Array.isArray(viewport.transform) && viewport.transform.length >= 6
    ? viewport.transform
    : [1, 0, 0, 1, 0, 0]
  let drawnCount = 0

  context.save?.()
  context.fillStyle = 'rgb(20,20,20)'
  context.textBaseline = 'alphabetic'

  for (const item of items) {
    const text = String(item.str || '')
    if (!CJK_TEXT_RE.test(text)) continue
    const transform = (item.transform as number[]).map(Number)
    if (transform.length < 6 || transform.some((value) => !Number.isFinite(value))) continue

    const mapped = multiplyTransform(viewportTransform, transform)
    const fontSize = Math.max(
      Math.abs(mapped[3] || 0),
      Math.hypot(mapped[2] || 0, mapped[3] || 0),
      Math.hypot(mapped[0] || 0, mapped[1] || 0),
      1,
    )
    const width = Math.max(
      Number(item.width || 0) * Math.max(1, fontSize / Math.max(1, Number(item.height || fontSize))),
      fontSize * text.length * 0.45,
    )
    const baselineX = mapped[4]
    const baselineY = mapped[5]
    const regionTop = baselineY - fontSize * 1.08
    const regionHeight = fontSize * 1.35
    const darkRatio = getRegionDarkRatio(
      context,
      canvasWidth,
      canvasHeight,
      baselineX - 1,
      regionTop - 1,
      width + 2,
      regionHeight + 2,
    )
    if (darkRatio > BLANK_TEXT_REGION_DARK_RATIO) continue

    context.font = `${fontSize}px ${PDF_FALLBACK_FONT_FAMILY}`
    context.fillText(text, baselineX, baselineY, width * 1.08)
    drawnCount += 1
  }

  context.restore?.()
  return drawnCount
}
