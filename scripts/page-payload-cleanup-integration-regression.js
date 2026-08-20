const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-page-payload-cleanup-'))
const dataDir = path.join(tempRoot, 'data')
const bundlePath = path.join(tempRoot, 'page-payload-cleanup.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')

process.env.GUJISMART_DATA_DIR = dataDir
process.env.GUJISMART_AUTO_REINDEX = '0'
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `
  exports.app = {
    getPath: () => ${JSON.stringify(tempRoot)},
    getAppPath: () => ${JSON.stringify(root)},
    getName: () => 'GujiSmart',
    isPackaged: false,
  }
`)
fs.writeFileSync(entryPath, `
  const database = require(${JSON.stringify(path.join(root, 'src', 'main', 'database.ts'))})
  const payloadStore = require(${JSON.stringify(path.join(root, 'src', 'main', 'page-payload-store.ts'))})
  const maintenance = require(${JSON.stringify(path.join(root, 'src', 'main', 'database-maintenance.ts'))})
  module.exports = { database, payloadStore, maintenance }
`)

async function run() {
  let database
  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundlePath,
      external: ['better-sqlite3'],
      alias: {
        electron: electronStubPath,
        '@electron-toolkit/utils': path.join(root, 'scripts', 'stubs', 'electron-toolkit-utils.js'),
      },
      logLevel: 'silent',
    })
    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()

    database.run("INSERT INTO documents (id, title, import_status, created_at, updated_at) VALUES ('doc-1', 'Fixture', 'stored', '2026-01-01', '2026-01-01')")
    database.run("INSERT INTO pages (id, doc_id, page_num, ocr_status, proof_status, created_at) VALUES ('page-1', 'doc-1', 1, 'completed', 'pending', '2026-01-01')")

    const payloads = {
      page: 'page payload reference',
      legacyVersion: 'legacy OCR version reference',
      immutableArtifact: 'immutable OCR artifact reference',
      aiLayout: 'AI layout cache reference',
      translationSource: 'translation source reference',
      translationResult: 'translation result reference',
      orphan: 'genuinely orphaned payload',
    }
    const refs = Object.fromEntries(Object.entries(payloads).map(([key, value]) => [
      key,
      modules.payloadStore.writePagePayload('doc-1', `page-${key}`, 'ocr_text', value),
    ]))

    database.run("UPDATE pages SET ocr_text = '', ocr_text_ref = ? WHERE id = 'page-1'", [refs.page])
    database.run(`INSERT INTO page_ocr_versions
      (id, doc_id, page_id, page_num, engine, ocr_result, ocr_result_ref, status, is_active, created_at, updated_at)
      VALUES ('version-1', 'doc-1', 'page-1', 1, 'paddle', '{"externalized":true}', ?, 'completed', 0, '2026-01-01', '2026-01-01')`, [refs.legacyVersion])
    database.run(`INSERT INTO ocr_runs
      (id, doc_id, engine, status, settings_snapshot_json, manifest_json, created_at, updated_at, completed_at)
      VALUES ('run-1', 'doc-1', 'paddle', 'completed', '{}', '{}', 1, 1, 1)`)
    database.run(`INSERT INTO ocr_page_attempts
      (id, run_id, page_id, attempt_no, status, started_at, finished_at)
      VALUES ('attempt-1', 'run-1', 'page-1', 1, 'completed', 1, 1)`)
    database.run(`INSERT INTO ocr_artifact_versions
      (id, run_id, attempt_id, doc_id, page_id, page_num, engine, ocr_text, ocr_text_ref, source_hash, status, created_at)
      VALUES ('artifact-1', 'run-1', 'attempt-1', 'doc-1', 'page-1', 1, 'paddle', '', ?, ?, 'superseded', 1)`, [refs.immutableArtifact, 'a'.repeat(64)])
    database.run(`INSERT INTO page_ai_layout_cache
      (id, doc_id, page_id, page_num, mode, source_hash, result_text, result_text_ref, status, created_at, updated_at)
      VALUES ('ai-1', 'doc-1', 'page-1', 1, 'layout', ?, '', ?, 'ready', '2026-01-01', '2026-01-01')`, ['b'.repeat(64), refs.aiLayout])
    database.run(`INSERT INTO page_translation_cache
      (id, doc_id, page_id, page_num, source_hash, source_text, translation_text, source_text_ref, translation_text_ref, status, created_at, updated_at)
      VALUES ('translation-1', 'doc-1', 'page-1', 1, ?, '', '', ?, ?, 'ready', '2026-01-01', '2026-01-01')`, ['c'.repeat(64), refs.translationSource, refs.translationResult])

    const before = modules.payloadStore.getPagePayloadStorageStats()
    assert.strictEqual(before.externalFileCount, 7)
    assert.strictEqual(before.referencedFileCount, 6)
    assert.strictEqual(before.orphanedFileCount, 1)
    assert.strictEqual(before.missingReferencedFileCount, 0)

    const cleaned = modules.payloadStore.cleanupUnreferencedPagePayloads()
    assert.strictEqual(cleaned.scannedFiles, 7)
    assert.strictEqual(cleaned.deletedFiles, 1)
    assert.strictEqual(modules.payloadStore.readPagePayload(refs.orphan), null)
    for (const key of ['page', 'legacyVersion', 'immutableArtifact', 'aiLayout', 'translationSource', 'translationResult']) {
      assert.strictEqual(modules.payloadStore.readPagePayload(refs[key]), payloads[key], `${key} reference must survive cleanup`)
    }

    const after = modules.payloadStore.getPagePayloadStorageStats()
    assert.strictEqual(after.externalFileCount, 6)
    assert.strictEqual(after.referencedFileCount, 6)
    assert.strictEqual(after.orphanedFileCount, 0)
    assert.strictEqual(after.missingReferencedFileCount, 0)

    // --- OCR artifact history pruning ---
    // artifact-1 (superseded, unreferenced) from the scenario above becomes
    // prunable; the active artifact and the proofreading base must survive.
    database.run("INSERT INTO pages (id, doc_id, page_num, ocr_status, proof_status, created_at) VALUES ('page-2', 'doc-1', 2, 'completed', 'pending', '2026-01-01')")
    database.run(`INSERT INTO ocr_runs
      (id, doc_id, engine, status, settings_snapshot_json, manifest_json, created_at, updated_at, completed_at)
      VALUES ('run-2', 'doc-1', 'paddle', 'completed', '{}', '{}', 2, 2, 2)`)
    database.run(`INSERT INTO ocr_page_attempts
      (id, run_id, page_id, attempt_no, status, started_at, finished_at)
      VALUES ('attempt-2', 'run-2', 'page-2', 1, 'completed', 2, 2)`)
    const prunePayloads = {
      activeArtifact: 'active OCR artifact reference',
      proofBaseArtifact: 'proof base OCR artifact reference',
      oldArtifact: 'prunable superseded OCR artifact reference',
    }
    const pruneRefs = Object.fromEntries(Object.entries(prunePayloads).map(([key, value]) => [
      key,
      modules.payloadStore.writePagePayload('doc-1', `page-prune-${key}`, 'ocr_text', value),
    ]))
    database.run(`INSERT INTO ocr_artifact_versions
      (id, run_id, attempt_id, doc_id, page_id, page_num, engine, ocr_text, ocr_text_ref, source_hash, status, created_at)
      VALUES ('artifact-active', 'run-2', 'attempt-2', 'doc-1', 'page-2', 2, 'paddle', '', ?, ?, 'active', 2)`, [pruneRefs.activeArtifact, 'd'.repeat(64)])
    database.run(`INSERT INTO ocr_artifact_versions
      (id, run_id, attempt_id, doc_id, page_id, page_num, engine, ocr_text, ocr_text_ref, source_hash, status, created_at)
      VALUES ('artifact-proof-base', 'run-2', 'attempt-2', 'doc-1', 'page-2', 2, 'paddle', '', ?, ?, 'superseded', 2)`, [pruneRefs.proofBaseArtifact, 'e'.repeat(64)])
    database.run(`INSERT INTO ocr_artifact_versions
      (id, run_id, attempt_id, doc_id, page_id, page_num, engine, ocr_text, ocr_text_ref, source_hash, status, created_at)
      VALUES ('artifact-old', 'run-2', 'attempt-2', 'doc-1', 'page-2', 2, 'paddle', '', ?, ?, 'superseded', 2)`, [pruneRefs.oldArtifact, 'f'.repeat(64)])
    database.run("UPDATE pages SET active_ocr_artifact_id = 'artifact-active', proof_base_artifact_id = 'artifact-proof-base' WHERE id = 'page-2'")
    database.run("INSERT INTO ocr_page_active_artifacts (page_id, artifact_id, activated_at) VALUES ('page-2', 'artifact-active', 2)")

    const pruneResult = await modules.maintenance.pruneOcrArtifactHistory()
    assert.strictEqual(pruneResult.success, true, `prune must succeed: ${pruneResult.error || ''}`)
    const remainingArtifacts = database.queryAll('SELECT id FROM ocr_artifact_versions ORDER BY id').map((row) => row.id)
    assert.deepStrictEqual(remainingArtifacts, ['artifact-active', 'artifact-proof-base'], 'prune must keep the active artifact and the proofreading base, and delete unreferenced superseded artifacts')
    const remainingAttempts = database.queryAll('SELECT id FROM ocr_page_attempts ORDER BY id').map((row) => row.id)
    assert.deepStrictEqual(remainingAttempts, ['attempt-2'], 'prune must keep attempts that still own artifacts and delete artifact-less finished attempts')
    const remainingRuns = database.queryAll('SELECT id FROM ocr_runs ORDER BY id').map((row) => row.id)
    assert.deepStrictEqual(remainingRuns, ['run-2'], 'prune must keep runs that still own artifacts and delete empty finished runs')
    assert.strictEqual(pruneResult.deletedRows, 4, 'prune should report artifact-1, artifact-old, attempt-1, and run-1 as deleted')
    assert.strictEqual(modules.payloadStore.readPagePayload(refs.immutableArtifact), null, 'payload of a pruned artifact must be swept')
    assert.strictEqual(modules.payloadStore.readPagePayload(pruneRefs.oldArtifact), null, 'payload of a pruned superseded artifact must be swept')
    assert.strictEqual(modules.payloadStore.readPagePayload(pruneRefs.activeArtifact), prunePayloads.activeArtifact, 'active artifact payload must survive pruning')
    assert.strictEqual(modules.payloadStore.readPagePayload(pruneRefs.proofBaseArtifact), prunePayloads.proofBaseArtifact, 'proof base artifact payload must survive pruning')
    for (const key of ['page', 'legacyVersion', 'aiLayout', 'translationSource', 'translationResult']) {
      assert.strictEqual(modules.payloadStore.readPagePayload(refs[key]), payloads[key], `${key} reference must survive pruning`)
    }

    database.closeDatabase()
    database = null
    console.log('Page payload cleanup integration regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
