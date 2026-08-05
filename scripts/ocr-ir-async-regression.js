const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-ir-async-'))
const entryPath = path.join(tempRoot, 'entry.js')
const bundlePath = path.join(tempRoot, 'bundle.cjs')

fs.writeFileSync(entryPath, `module.exports = require(${JSON.stringify(path.join(root, 'src', 'shared', 'ocr-ir.ts'))})`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  logLevel: 'silent',
})

function textBlock(words, top) {
  return {
    words,
    label: 'text',
    reading_order: top,
    location: { left: 80, top, width: 840, height: 45 },
    confidence: 0.93,
  }
}

async function main() {
  const ocrIr = require(bundlePath)
  const pageCount = 900
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    page_num: index + 1,
    page_width: 1000,
    page_height: 1000,
    layout_result: [
      textBlock('Repeated running title', 20),
      ...Array.from({ length: 10 }, (__, blockIndex) => (
        textBlock(`Page ${index + 1} paragraph ${blockIndex + 1} continues`, 150 + (blockIndex * 55))
      )),
    ],
  }))
  const buildOptions = {
    generatedAt: '2026-08-03T00:00:00.000Z',
    forceRebuild: true,
  }
  const expected = ocrIr.buildOcrDocumentV1(pages, buildOptions)
  let yieldCount = 0
  let heartbeatCount = 0
  const phases = new Set()
  const heartbeat = setInterval(() => {
    heartbeatCount += 1
  }, 0)
  const actual = await ocrIr.buildOcrDocumentV1Async(pages, buildOptions, {
    chunkSize: 2,
    yieldControl: () => new Promise((resolve) => setImmediate(() => {
      yieldCount += 1
      resolve()
    })),
    onProgress: ({ phase }) => phases.add(phase),
  })
  clearInterval(heartbeat)

  assert.deepStrictEqual(actual, expected)
  assert.ok(yieldCount >= pageCount / 2, 'large document build should yield repeatedly')
  assert.ok(heartbeatCount > 0, 'event loop heartbeat should run during large document build')
  assert.deepStrictEqual([...phases].sort(), ['continuity', 'margins', 'orientation', 'pages', 'tables'])
  console.log(`Async OCR IR regression passed (${pageCount} pages, ${yieldCount} yields, ${heartbeatCount} heartbeats).`)
}

main()
  .finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
