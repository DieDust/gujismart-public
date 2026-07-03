const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-backup-integrity-'))
const bundlePath = path.join(tempRoot, 'backup-integrity.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'backup-integrity.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const integrity = require(bundlePath)
  const ok = integrity.buildBackupIntegrityReport(
    {
      db_present: true,
      storage_present: true,
      includes_storage: true,
      includes_page_payloads: true,
      db_file_count: 2,
      db_total_bytes: 2048,
      storage_file_count: 4,
      storage_total_bytes: 4096,
      page_payload_file_count: 2,
      page_payload_total_bytes: 1024,
      page_payload_ref_count: 2,
      missing_page_payload_ref_count: 0,
    },
    '2026-01-01T00:00:00.000Z',
  )
  assert.strictEqual(ok.status, 'ok')
  assert.strictEqual(ok.error_count, 0)

  const missingPayloads = integrity.buildBackupIntegrityReport(
    {
      db_present: true,
      storage_present: true,
      includes_storage: true,
      includes_page_payloads: false,
      db_file_count: 1,
      db_total_bytes: 1024,
      storage_file_count: 0,
      storage_total_bytes: 0,
      page_payload_file_count: 0,
      page_payload_total_bytes: 0,
      page_payload_ref_count: 3,
      missing_page_payload_ref_count: 3,
    },
    '2026-01-01T00:00:00.000Z',
  )
  assert.strictEqual(missingPayloads.status, 'error')
  assert.ok(missingPayloads.issues.some((issue) => issue.code === 'backup_page_payloads_missing'))
  assert.ok(missingPayloads.issues.some((issue) => issue.code === 'backup_page_payload_refs_missing'))

  const restoredMismatch = integrity.compareBackupIntegrityReports(
    ok,
    integrity.buildBackupIntegrityReport(
      {
        ...ok.metrics,
        storage_file_count: ok.metrics.storage_file_count - 1,
      },
      '2026-01-01T00:00:00.000Z',
    ),
    '2026-01-01T00:00:00.000Z',
  )
  assert.strictEqual(restoredMismatch.status, 'error')
  assert.ok(restoredMismatch.issues.some((issue) => issue.code === 'restored_storage_size_mismatch'))

  const backupSource = fs.readFileSync(path.join(root, 'src', 'main', 'backup.ts'), 'utf8')
  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  assert.ok(typesSource.includes('integrityReport?: BackupIntegrityReport'), 'backup result and slots should expose optional integrity reports')
  assert.ok(typesSource.includes('restoredIntegrityReport?: BackupIntegrityReport'), 'backup import results should expose restored integrity reports')
  assert.ok(typesSource.includes("from './backup-integrity'"), 'shared types should re-export backup integrity contracts')
  assert.ok(backupSource.includes('integrityReport: collectBackupIntegrityReport(backupDir, { includesStorage })'), 'backup manifest should include an integrity report')
  assert.ok(backupSource.includes('function validateBackupManifestIntegrity'), 'backup imports should validate manifest integrity')
  assert.ok(backupSource.includes('compareBackupIntegrityReports(integrityReport, collectBackupIntegrityReport(dataDir))'), 'backup imports should verify restored data integrity')
  assert.ok(backupSource.includes('restoredIntegrityReport'), 'backup import result should include restored integrity diagnostics')
  assert.ok(backupSource.includes('integrityReport = manifest.integrityReport'), 'backup status slots should surface manifest integrity reports')

  console.log('Backup integrity regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
