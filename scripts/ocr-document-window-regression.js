const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-document-window-'))

async function bundle(entry, outfile) {
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  return require(outfile)
}

async function main() {
  const schedulerBundle = path.join(tempRoot, 'scheduler.cjs')
  const summaryBundle = path.join(tempRoot, 'summary.cjs')
  const { SlidingWindowScheduler } = await bundle(
    path.join(root, 'src/main/ocr-document-window.ts'),
    schedulerBundle,
  )
  const { buildOcrActivitySummary } = await bundle(
    path.join(root, 'src/renderer/src/utils/ocrActivitySummary.ts'),
    summaryBundle,
  )

  const scheduler = new SlidingWindowScheduler()
  const releases = []
  const started = []
  let active = 0
  let peak = 0
  const tasks = Array.from({ length: 8 }, (_, index) => scheduler.run(5, async () => {
    started.push(index)
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => releases[index] = resolve)
    active -= 1
  }))

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(started, [0, 1, 2, 3, 4], 'only five documents may start initially')
  releases[2]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(started, [0, 1, 2, 3, 4, 5], 'the next document should fill the first released slot immediately')
  assert.strictEqual(peak, 5, 'global OCR document concurrency must never exceed the configured window')
  started.forEach((index) => releases[index]?.())
  await new Promise((resolve) => setImmediate(resolve))
  for (let index = 0; index < releases.length; index += 1) releases[index]?.()
  await Promise.all(tasks)

  assert.strictEqual(
    buildOcrActivitySummary([
      { status: 'processing' },
      { status: 'processing' },
      { status: 'queued' },
      { status: 'queued' },
      { status: 'completed' },
    ]),
    'OCR：2 篇处理中，2 篇等待',
  )

  const libraryView = fs.readFileSync(path.join(root, 'src/renderer/src/views/LibraryView.tsx'), 'utf8')
  const ocrIpc = fs.readFileSync(path.join(root, 'src/main/ipc/ocr.ts'), 'utf8')
  const batchProcessor = fs.readFileSync(path.join(root, 'src/main/batch-processor.ts'), 'utf8')
  assert.ok(libraryView.includes("const OCR_ACTIVITY_MESSAGE_KEY = 'ocr-activity'"), 'Library should use one aggregate OCR message key')
  assert.ok(libraryView.includes('buildOcrActivitySummary(Object.values(nextProgressByDoc))'), 'Library should aggregate document progress')
  assert.ok(!libraryView.includes('message.loading({\n          content: getOcrProgressText(nextInfo),\n          key: toastKey'), 'Library must not open one persistent toast per document')
  assert.ok(
    ocrIpc.includes('runBoundedDocumentWorkers')
      && (ocrIpc.match(/globalOcrDocumentWindow\.run\(/g) || []).length >= 2
      && ocrIpc.includes('getOcrDocumentConcurrency'),
    'automatic and manual OCR should share the global document window via the bounded worker pool',
  )
  assert.ok(
    batchProcessor.includes('globalOcrDocumentWindow.run(getOcrDocumentConcurrency()')
      || batchProcessor.includes('globalOcrDocumentWindow.run('),
    'legacy resumed OCR should share the global document window',
  )

  console.log('OCR document sliding-window regression passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
