const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-status-envelope-'))
const bundlePath = path.join(tempRoot, 'status-envelope.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'status-envelope.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const statusEnvelope = require(bundlePath)
  assert.deepStrictEqual(
    statusEnvelope.statusEnvelopeFromOcrProgress({
      docId: 'doc_status',
      status: 'processing',
      phase: 'ocr',
      progress: 0.42,
      message: 'OCR running',
    }),
    {
      status: 'processing',
      phase: 'ocr',
      progress: 0.42,
      message: 'OCR running',
      recoverable: true,
    },
  )

  assert.deepStrictEqual(
    statusEnvelope.statusEnvelopeFromOcrProgress({
      docId: 'doc_status',
      status: 'error',
      progress: 2,
      errorMessage: 'OCR failed',
    }),
    {
      status: 'error',
      progress: 1,
      error_code: 'error',
      message: 'OCR failed',
      recoverable: false,
      action_hint: 'review_ocr_settings_or_retry',
    },
  )

  assert.deepStrictEqual(
    statusEnvelope.statusEnvelopeFromImportProgress({
      phase: 'hashing',
      filePath: 'fixture.pdf',
      fileName: 'fixture.pdf',
      fileIndex: 0,
      totalFiles: 1,
      progress: -1,
    }),
    {
      status: 'processing',
      phase: 'hashing',
      progress: 0,
      message: 'fixture.pdf',
      recoverable: true,
    },
  )

  assert.strictEqual(
    statusEnvelope.statusEnvelopeFromSearchIndexStatus({
      doc_id: 'doc_status',
      status: 'ready',
      source_hash: 'hash',
      segment_count: 1,
      error_message: null,
      indexed_at: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    }).progress,
    1,
  )

  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  const ocrSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
  assert.ok(typesSource.includes('export interface StatusEnvelope'), 'shared types should expose StatusEnvelope')
  assert.ok(typesSource.includes('statusEnvelope?: StatusEnvelope'), 'progress/status objects should allow status envelopes')
  assert.ok(ocrSource.includes('statusEnvelopeFromOcrProgress'), 'OCR IPC should use the shared status envelope helper')
  assert.ok(ocrSource.includes('statusEnvelope: statusEnvelopeFromOcrProgress(payload)'), 'OCR status events should include the envelope')

  console.log('Status envelope regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
