const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const ipcSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
const ocrSource = fs.readFileSync(path.join(root, 'src', 'main', 'ocr.ts'), 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'utf8')
const viewSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'DocumentView.tsx'), 'utf8')

const functionStart = ipcSource.indexOf('async function rerecognizeLowQualityPageRegions')
const functionEnd = ipcSource.indexOf('function reprocessDocumentOcrStructure', functionStart)
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'Expected low-quality region OCR implementation')
const implementation = ipcSource.slice(functionStart, functionEnd)

assert.ok(implementation.includes('getOcrRegionRerecognitionCandidates'))
assert.ok(implementation.includes('recognizeImageRegion'))
assert.ok(implementation.includes('applyOcrRegionTextReplacement'))
assert.ok(implementation.includes('markSearchIndexStaleForPages'))
assert.ok(implementation.includes('UPDATE page_ocr_versions'))
assert.ok(!implementation.includes('proofed_text'), 'Region OCR must preserve human proofed text')
assert.ok(ocrSource.includes('export async function recognizeImageRegion'))
assert.ok(ocrSource.includes('cropImageToDataUrl(filePath, location)'))
assert.ok(preloadSource.includes('rerecognizeLowQualityOcrBlocks'))
assert.ok(preloadSource.includes("ipcRenderer.invoke('pages:rerecognizeLowQualityBlocks'"))
assert.ok(viewSource.includes('局部重识别异常块'))
assert.ok(viewSource.includes('人工校对文本未改动'))

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-region-'))
const bundlePath = path.join(tempRoot, 'ocr-ir.cjs')
try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'ocr-ir.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })
  const ocrIr = require(bundlePath)
  const original = {
    layout_result: [
      {
        words: 'bad text',
        confidence: 0.2,
        needs_enhancement: true,
        location: { left: 10, top: 20, width: 100, height: 30 },
      },
      {
        words: 'neighbor text',
        confidence: 0.9,
        location: { left: 10, top: 60, width: 100, height: 30 },
      },
    ],
  }
  const replacement = ocrIr.applyOcrRegionTextReplacement(original, {
    sourceIndex: 0,
    text: 'improved text',
    confidence: 0.95,
    reasons: ['low_confidence', 'needs_enhancement'],
    recognizedAt: '2026-01-01T00:00:00.000Z',
  })
  assert.strictEqual(replacement.updated, true)
  assert.strictEqual(replacement.result.layout_result[0].words, 'improved text')
  assert.strictEqual(replacement.result.layout_result[0].raw_words, 'bad text')
  assert.deepStrictEqual(replacement.result.layout_result[0].location, original.layout_result[0].location)
  assert.strictEqual(replacement.result.layout_result[1].words, 'neighbor text')
  assert.strictEqual(original.layout_result[0].words, 'bad text')
  assert.strictEqual(
    ocrIr.applyOcrRegionTextReplacement(original, { sourceIndex: 0, text: 'bad text' }).updated,
    false,
  )
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('OCR region rerecognition regression passed')
