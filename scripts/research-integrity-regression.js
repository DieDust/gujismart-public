const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-research-integrity-'))
const bundlePath = path.join(tempRoot, 'research-integrity.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'research-integrity.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const { buildResearchProjectIntegrityReport } = require(bundlePath)
  const report = buildResearchProjectIntegrityReport({
    projectId: 'project_fixture',
    checkedAt: '2026-01-01T00:00:00.000Z',
    documentCount: 1,
    missingDocumentCount: 1,
    outputCount: 0,
    aiDatasetCount: 1,
    aiRecordCount: 3,
    unconfirmedAiRecordCount: 2,
    evidenceCount: 4,
    staleEvidenceCount: 1,
    formalOutputVersionCount: 2,
    draftOutputVersionCount: 1,
    notes: [
      { id: 'note_complete', locatorJson: '{"docId":"doc"}', sourceHash: 'hash', sourceAvailable: 1 },
      { id: 'note_missing_locator', locatorJson: '', sourceHash: 'hash2', sourceAvailable: 1 },
      { id: 'note_missing_hash', locatorJson: '{"docId":"doc"}', sourceHash: '', sourceAvailable: 1 },
      { id: 'note_unavailable', locatorJson: '{"docId":"doc"}', sourceHash: 'hash3', sourceAvailable: 0 },
    ],
  })

  assert.strictEqual(report.projectId, 'project_fixture')
  assert.strictEqual(report.checkedAt, '2026-01-01T00:00:00.000Z')
  assert.strictEqual(report.metrics.documentCount, 1)
  assert.strictEqual(report.metrics.missingDocumentCount, 1)
  assert.strictEqual(report.metrics.noteCount, 4)
  assert.strictEqual(report.metrics.missingLocatorNoteCount, 1)
  assert.strictEqual(report.metrics.missingSourceHashNoteCount, 1)
  assert.strictEqual(report.metrics.unavailableSourceNoteCount, 1)
  assert.strictEqual(report.metrics.outputCount, 0)
  assert.strictEqual(report.metrics.aiDatasetCount, 1)
  assert.strictEqual(report.metrics.aiRecordCount, 3)
  assert.strictEqual(report.metrics.unconfirmedAiRecordCount, 2)
  assert.strictEqual(report.metrics.evidenceCount, 4)
  assert.strictEqual(report.metrics.staleEvidenceCount, 1)
  assert.strictEqual(report.metrics.formalOutputVersionCount, 2)
  assert.strictEqual(report.metrics.draftOutputVersionCount, 1)
  assert.ok(report.issues.some((issue) => issue.code === 'project.missing_documents' && issue.severity === 'error'))
  assert.ok(report.issues.some((issue) => issue.code === 'notes.missing_locator' && issue.entityIds.includes('note_missing_locator')))
  assert.ok(report.issues.some((issue) => issue.code === 'notes.missing_source_hash' && issue.entityIds.includes('note_missing_hash')))
  assert.ok(report.issues.some((issue) => issue.code === 'notes.unavailable_source' && issue.entityIds.includes('note_unavailable')))
  assert.ok(report.issues.some((issue) => issue.code === 'outputs.empty'))
  assert.ok(report.issues.some((issue) => issue.code === 'ai_records.unconfirmed'))
  assert.ok(report.issues.some((issue) => issue.code === 'evidence.stale' && issue.severity === 'error'))
  assert.ok(report.issues.some((issue) => issue.code === 'outputs.draft_versions' && issue.severity === 'info'))
  assert.strictEqual(report.errorCount, 3)
  assert.strictEqual(report.warningCount, 3)

  console.log('Research integrity regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
