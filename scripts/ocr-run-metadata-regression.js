const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-run-metadata-'))
const bundlePath = path.join(tempRoot, 'ocr-run-metadata.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'ocr-run-metadata.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const ocrRun = require(bundlePath)
  const processing = ocrRun.ocrRunMetadataFromProgress({
    docId: 'doc_ocr',
    status: 'processing',
    phase: 'ocr',
    progress: 0.42,
    completedPages: 4,
    totalPages: 10,
    pageNum: 5,
  })
  assert.strictEqual(processing.doc_id, 'doc_ocr')
  assert.strictEqual(processing.status, 'processing')
  assert.strictEqual(processing.phase, 'ocr')
  assert.strictEqual(processing.page_num, 5)
  assert.deepStrictEqual(processing.page_summary, {
    completed: 4,
    total: 10,
    pending: 6,
    progress: 0.42,
  })
  assert.deepStrictEqual(processing.quality.issue_codes, [])
  assert.strictEqual(processing.quality.status, 'unknown')

  const quality = ocrRun.ocrRunMetadataFromProgress({
    docId: 'doc_ocr',
    status: 'error',
    phase: 'error',
    progress: 2,
    completedPages: 2,
    totalPages: 3,
    errorMessage: '[layout_quality_rejected] repeated text',
  })
  assert.strictEqual(quality.page_summary.progress, 1)
  assert.strictEqual(quality.page_summary.failed, 1)
  assert.strictEqual(quality.page_summary.pending, 0)
  assert.strictEqual(quality.quality.status, 'failed')
  assert.deepStrictEqual(quality.quality.issue_codes, ['layout_quality_rejected', 'ocr_error', 'repeated_text'])
  assert.strictEqual(quality.quality.action_hint, 'review_ocr_pages_or_retry')

  const ocrSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  assert.ok(typesSource.includes('runMetadata?: OcrRunMetadata'), 'OCR progress events should expose optional run metadata')
  assert.ok(typesSource.includes("from './ocr-run-metadata'"), 'shared types should re-export OCR run metadata contracts')
  assert.ok(ocrSource.includes('ocrRunMetadataFromProgress'), 'OCR IPC should use the shared OCR run metadata helper')
  assert.ok(ocrSource.includes('runMetadata: ocrRunMetadataFromProgress(payload)'), 'OCR status events should include run metadata at the centralized sender')

  console.log('OCR run metadata regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
