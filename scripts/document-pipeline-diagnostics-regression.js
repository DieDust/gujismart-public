const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-document-pipeline-'))
const bundlePath = path.join(tempRoot, 'document-pipeline-diagnostics.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'document-pipeline-diagnostics.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const pipeline = require(bundlePath)
  const copying = pipeline.documentPipelineDiagnosticsFromImportProgress(
    {
      phase: 'copying',
      filePath: 'fixture.pdf',
      fileName: 'fixture.pdf',
      fileIndex: 0,
      totalFiles: 1,
      bytesDone: 512,
      totalBytes: 1024,
      progress: 0.5,
    },
    '2026-01-01T00:00:00.000Z',
  )
  assert.strictEqual(copying.status, 'processing')
  assert.strictEqual(copying.current_stage, 'import')
  assert.strictEqual(copying.issue_count, 0)
  assert.deepStrictEqual(copying.snapshot, { import_status: 'processing' })

  const stored = pipeline.documentPipelineDiagnosticsFromImportProgress(
    {
      phase: 'stored',
      filePath: 'fixture.pdf',
      fileName: 'fixture.pdf',
      fileIndex: 0,
      totalFiles: 1,
      progress: 1,
    },
    '2026-01-01T00:00:00.000Z',
  )
  assert.strictEqual(stored.status, 'ready')
  assert.strictEqual(stored.current_stage, 'storage')
  assert.deepStrictEqual(stored.snapshot, { import_status: 'stored' })

  const importError = pipeline.buildDocumentPipelineDiagnostics(
    {
      import_status: 'error',
      ocr_status: 'pending',
      metadata_status: 'pending',
    },
    '2026-01-01T00:00:00.000Z',
  )
  assert.strictEqual(importError.status, 'error')
  assert.ok(importError.issues.some((issue) => issue.code === 'import_error'))
  assert.ok(importError.issues.some((issue) => issue.code === 'ocr_incomplete'))

  const review = pipeline.buildDocumentPipelineDiagnostics(
    {
      import_status: 'processed',
      ocr_status: 'completed',
      proof_status: 'pending',
      metadata_status: 'review',
      page_count: 8,
      completed_page_count: 7,
      pending_page_count: 1,
    },
    '2026-01-01T00:00:00.000Z',
  )
  assert.strictEqual(review.status, 'needs_attention')
  assert.strictEqual(review.error_count, 0)
  assert.ok(review.issues.some((issue) => issue.code === 'metadata_needs_review'))
  assert.ok(review.issues.some((issue) => issue.code === 'ocr_pending_pages'))

  const documentsSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'documents.ts'), 'utf8')
  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  assert.ok(typesSource.includes('pipelineDiagnostics?: DocumentPipelineDiagnostics'), 'import progress events should expose optional pipeline diagnostics')
  assert.ok(typesSource.includes("from './document-pipeline-diagnostics'"), 'shared types should re-export document pipeline diagnostics contracts')
  assert.ok(documentsSource.includes('function sendImportProgress'), 'document import progress should use a centralized sender')
  assert.ok(documentsSource.includes('statusEnvelopeFromImportProgress(payload)'), 'centralized sender should attach status envelopes')
  assert.ok(documentsSource.includes('pipelineDiagnostics: documentPipelineDiagnosticsFromImportProgress(payload)'), 'centralized sender should attach pipeline diagnostics')
  assert.strictEqual(
    (documentsSource.match(/sender\.send\('documents:importProgress'/g) || []).length,
    1,
    'import progress events should be sent only through sendImportProgress',
  )

  console.log('Document pipeline diagnostics regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
