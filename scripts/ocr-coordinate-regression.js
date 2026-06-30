const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-coordinates-'))
const entryPath = path.join(tempRoot, 'entry.js')
const bundlePath = path.join(tempRoot, 'bundle.cjs')

fs.writeFileSync(entryPath, `
  module.exports = require(${JSON.stringify(path.join(root, 'src', 'renderer', 'src', 'utils', 'ocrCoordinates.ts'))})
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  logLevel: 'silent',
})

try {
  const coordinates = require(bundlePath)
  const imageViewerSource = fs.readFileSync(path.join(root, 'src/renderer/src/components/ImageViewer.tsx'), 'utf8')
  const facsimileSource = fs.readFileSync(path.join(root, 'src/renderer/src/components/GujiFacsimileProofreader.tsx'), 'utf8')

  assert.deepStrictEqual(
    coordinates.getOcrBlockRect({ location: { x: 10, y: 20, width: 30, height: 40 } }),
    { left: 10, top: 20, width: 30, height: 40 },
    'x/y OCR rectangles should not be dropped by facsimile coordinate parsing',
  )
  assert.deepStrictEqual(
    coordinates.getOcrBlockRect({ bbox: [10, 20, 70, 90] }),
    { left: 10, top: 20, width: 60, height: 70 },
    'four-number xyxy OCR boxes should map to width/height correctly',
  )
  assert.deepStrictEqual(
    coordinates.getOcrBlockRect({ bbox: [80, 120, 30, 40] }),
    { left: 80, top: 120, width: 30, height: 40 },
    'four-number xywh OCR boxes should stay anchored when width/height are smaller than the origin',
  )
  assert.deepStrictEqual(
    coordinates.getOcrBlockRect({
      polygon: [
        { x: 15, y: 25 },
        { x: 85, y: 20 },
        { x: 90, y: 95 },
        { x: 12, y: 100 },
      ],
    }),
    { left: 12, top: 20, width: 78, height: 80 },
    'polygon OCR boxes should use the union of all returned points',
  )

  const extent = coordinates.getOcrCoordinateExtent([
    { location: { left: 100, top: 200, width: 300, height: 400 } },
    { location: { left: 450, top: 650, width: 120, height: 90 } },
  ])
  assert.deepStrictEqual(extent, { minLeft: 100, minTop: 200, maxRight: 570, maxBottom: 740 })

  const imageSized = coordinates.resolveOcrCoordinateSourceSizeForImage(
    { width: 595, height: 842 },
    { width: 1190, height: 1684 },
    { minLeft: 0, minTop: 0, maxRight: 1120, maxBottom: 1600 },
  )
  assert.deepStrictEqual(imageSized, { width: 1190, height: 1684 }, 'coordinates that exceed PDF points should use the page image basis')

  const preservedPdfSized = coordinates.resolveOcrCoordinateSourceSizeForImage(
    { width: 595, height: 842, preserveServiceCoordinates: true },
    { width: 1190, height: 1684 },
    { minLeft: 0, minTop: 0, maxRight: 560, maxBottom: 820 },
  )
  assert.deepStrictEqual(preservedPdfSized, { width: 595, height: 842 }, 'preserved service coordinates should keep explicit PDF point sizes')

  const preservedMissingSized = coordinates.resolveOcrCoordinateSourceSizeForImage(
    { width: 0, height: 0, preserveServiceCoordinates: true },
    { width: 1191, height: 1616 },
    { minLeft: 128, minTop: 18, maxRight: 1109, maxBottom: 1568 },
  )
  assert.deepStrictEqual(
    preservedMissingSized,
    { width: 1191, height: 1616 },
    'legacy async PDF OCR pages with missing service size should fall back to the rendered page image size',
  )

  const scale = coordinates.getOcrCoordinateScale(
    { width: 1190, height: 1684 },
    { width: 595, height: 842 },
  )
  assert.deepStrictEqual(scale, { scaleX: 2, scaleY: 2 })
  assert.deepStrictEqual(
    coordinates.scaleOcrBlockRect({ left: 20, top: 40, width: 80, height: 100 }, scale),
    { left: 40, top: 80, width: 160, height: 200 },
    'scaled OCR rectangles should preserve both x and y offsets',
  )

  const bounds = coordinates.getOcrLayoutBounds([{ __rect: { left: 100, top: 200, width: 300, height: 400 } }])
  assert.deepStrictEqual(bounds, { width: 348, height: 448, offsetLeft: 76, offsetTop: 176 })
  assert.deepStrictEqual(
    coordinates.scaleOcrRectToWidth({ left: 100, top: 200, width: 300, height: 400 }, bounds, 696),
    { left: 48, top: 48, width: 600, height: 800 },
    'facsimile scaled rectangles should subtract layout offsets before applying page width scale',
  )

  const bitmapWidth = 100
  const bitmapHeight = 90
  const bitmap = new Uint8ClampedArray(bitmapWidth * bitmapHeight * 4).fill(255)
  for (let y = 32; y < 48; y += 1) {
    for (let x = 24; x < 72; x += 1) {
      const offset = (y * bitmapWidth + x) * 4
      bitmap[offset] = 20
      bitmap[offset + 1] = 20
      bitmap[offset + 2] = 20
      bitmap[offset + 3] = 255
    }
  }
  const adjusted = coordinates.getInkAdjustedOcrRect(
    { data: bitmap, width: bitmapWidth, height: bitmapHeight },
    { left: 14, top: 12, width: 74, height: 58 },
    { label: 'text', text: 'display coordinate correction' },
  )
  assert.ok(adjusted, 'ink adjustment should find text ink inside a loose OCR region')
  assert.ok(adjusted.left >= 20 && adjusted.left <= 26, `ink-adjusted left should follow ink, got ${adjusted.left}`)
  assert.ok(adjusted.top >= 28 && adjusted.top <= 34, `ink-adjusted top should follow ink, got ${adjusted.top}`)
  assert.ok(adjusted.width >= 46 && adjusted.width <= 56, `ink-adjusted width should follow ink, got ${adjusted.width}`)
  assert.ok(adjusted.height >= 14 && adjusted.height <= 22, `ink-adjusted height should follow ink, got ${adjusted.height}`)

  assert.ok(imageViewerSource.includes("from '../utils/ocrCoordinates'"), 'ImageViewer should use the shared OCR coordinate mapper')
  assert.ok(imageViewerSource.includes('resolveOcrCoordinateSourceSizeForImage'), 'ImageViewer should resolve legacy async PDF coordinate sizes against the rendered page image')
  assert.ok(!imageViewerSource.includes('getInkAdjustedOcrRect'), 'ImageViewer should render persisted OCR coordinates directly instead of applying display-only ink adjustment')
  assert.ok(!imageViewerSource.includes("getContext('2d', { willReadFrequently: true })"), 'ImageViewer should not read page pixels to move OCR boxes at display time')
  assert.ok(facsimileSource.includes("from '../utils/ocrCoordinates'"), 'Guji facsimile proofreader should use the shared OCR coordinate mapper')

  console.log('OCR coordinate regression passed')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
