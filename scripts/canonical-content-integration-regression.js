const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-canonical-content-'))
const dataDir = path.join(tempRoot, 'data')
const bundlePath = path.join(tempRoot, 'canonical-content.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')

process.env.GUJISMART_DATA_DIR = dataDir
process.env.GUJISMART_AUTO_REINDEX = '0'
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

function assertSourceContract(relativePath, pattern, message) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
  assert.match(source, pattern, message)
}

assertSourceContract('src/main/ipc/documents.ts', /attachCanonicalPageContent\(/, 'document page DTOs must include canonical content')
assertSourceContract('src/renderer/src/utils/ocrText.ts', /canonical_content\?\.text/, 'reader text extraction must prefer canonical content')
assertSourceContract('src/main/ai.ts', /listCanonicalPageContents\(/, 'AI document reads must use canonical content')
assertSourceContract('src/main/translation-service.ts', /resolveCanonicalPageContent\(/, 'translation must use canonical content')
assertSourceContract('src/main/export.ts', /attachCanonicalPageContent\(/, 'export must use canonical content')
assertSourceContract('src/main/ipc/search.ts', /resolveCanonicalPageContent\(/, 'search hit hydration must use canonical content')
assertSourceContract('src/main/ipc/ocr.ts', /recordCompatibilityOcrArtifacts\(/, 'legacy OCR writes must also produce immutable artifacts')

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
  const canonical = require(${JSON.stringify(path.join(root, 'src', 'main', 'canonical-content.ts'))})
  const artifacts = require(${JSON.stringify(path.join(root, 'src', 'main', 'ocr-artifacts.ts'))})
  module.exports = { database, canonical, artifacts }
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

    const tables = database.queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ocr_%' ORDER BY name").map((row) => row.name)
    assert.deepStrictEqual(tables, ['ocr_artifact_versions', 'ocr_page_active_artifacts', 'ocr_page_attempts', 'ocr_runs'])
    database.run("INSERT INTO documents (id, title, import_status, created_at, updated_at) VALUES ('doc-1', 'Fixture', 'stored', '2026-01-01', '2026-01-01')")
    database.run(`INSERT INTO pages (id, doc_id, page_num, ocr_text, proofed_text, ocr_status, proof_status, created_at)
      VALUES ('page-1', 'doc-1', 1, 'legacy projection', 'pending draft', 'completed', 'pending', '2026-01-01')`)
    database.run(`INSERT INTO page_ocr_versions
      (id, doc_id, page_id, page_num, engine, label, ocr_text, status, is_active, created_at, updated_at)
      VALUES ('legacy-version', 'doc-1', 'page-1', 1, 'paddle', 'Paddle', 'active legacy version', 'completed', 1, '2026-01-01', '2026-01-01')`)

    const activeLegacy = modules.canonical.resolveCanonicalPageContent('page-1')
    assert.strictEqual(activeLegacy.text, 'active legacy version')
    assert.strictEqual(activeLegacy.source, 'ocr-artifact')
    assert.strictEqual(activeLegacy.artifactId, 'legacy-page-version:legacy-version')
    database.run("UPDATE pages SET proof_status = 'completed' WHERE id = 'page-1'")
    const proof = modules.canonical.resolveCanonicalPageContent('page-1')
    assert.strictEqual(proof.text, 'pending draft')
    assert.strictEqual(proof.source, 'human-proof')
    assert.strictEqual(proof.verificationStatus, 'confirmed')
    database.run("UPDATE pages SET proof_status = 'pending', proofed_text = NULL WHERE id = 'page-1'")
    database.run("UPDATE page_ocr_versions SET is_active = 0 WHERE page_id = 'page-1'")
    const fallback = modules.canonical.resolveCanonicalPageContent('page-1')
    assert.strictEqual(fallback.text, 'legacy projection')
    assert.strictEqual(fallback.source, 'legacy-projection')

    const runRecord = modules.artifacts.createOcrRun({
      docId: 'doc-1',
      engine: 'paddle',
      settingsSnapshot: { profile: 'general' },
      idempotencyKey: 'run-fixture',
      nowMs: 1_000,
    })
    const sameRun = modules.artifacts.createOcrRun({ docId: 'doc-1', engine: 'paddle', idempotencyKey: 'run-fixture', nowMs: 1_001 })
    assert.strictEqual(sameRun.id, runRecord.id)
    const attempt = modules.artifacts.startOcrPageAttempt({ runId: runRecord.id, pageId: 'page-1', nowMs: 1_010 })
    database.run("UPDATE pages SET proofed_text = 'confirmed human text', proof_status = 'completed' WHERE id = 'page-1'")
    const artifact = modules.artifacts.commitOcrArtifact({
      runId: runRecord.id,
      attemptId: attempt.id,
      pageId: 'page-1',
      text: 'new machine text',
      result: { text: 'new machine text', words_result: [{ words: 'new machine text' }] },
      sourceHash: 'b'.repeat(64),
      idempotencyKey: 'artifact-fixture',
      nowMs: 1_020,
    })
    const pageAfterCommit = database.queryOne("SELECT * FROM pages WHERE id = 'page-1'")
    assert.strictEqual(pageAfterCommit.ocr_text, 'new machine text')
    assert.strictEqual(pageAfterCommit.proofed_text, 'confirmed human text', 'OCR activation must preserve human proof')
    assert.strictEqual(pageAfterCommit.proof_status, 'completed')
    assert.strictEqual(pageAfterCommit.active_ocr_artifact_id, artifact.id)
    assert.strictEqual(pageAfterCommit.proof_base_stale, 1)
    const canonicalProof = modules.canonical.resolveCanonicalPageContent('page-1')
    assert.strictEqual(canonicalProof.text, 'confirmed human text')
    assert.strictEqual(canonicalProof.artifactId, null)
    assert.strictEqual(canonicalProof.activeArtifactId, artifact.id)
    assert.strictEqual(canonicalProof.baseArtifactId, null)
    assert.strictEqual(canonicalProof.proofBaseStale, true)
    database.run("UPDATE pages SET proof_status = 'pending' WHERE id = 'page-1'")
    const canonicalArtifact = modules.canonical.resolveCanonicalPageContent('page-1')
    assert.strictEqual(canonicalArtifact.text, 'new machine text')
    assert.strictEqual(canonicalArtifact.artifactId, artifact.id)
    assert.strictEqual(canonicalArtifact.sourceHash, 'b'.repeat(64))

    assert.throws(
      () => modules.artifacts.commitOcrArtifact({
        runId: runRecord.id,
        attemptId: attempt.id,
        pageId: 'page-1',
        text: 'changed',
        result: { text: 'changed' },
        sourceHash: 'c'.repeat(64),
        idempotencyKey: 'artifact-fixture',
        nowMs: 1_030,
      }),
      /ocr_artifact_immutable|ocr_attempt_not_running/,
    )

    database.run("INSERT INTO pages (id, doc_id, page_num, ocr_status, proof_status, created_at) VALUES ('page-2', 'doc-1', 2, 'pending', 'pending', '2026-01-01')")
    const unavailable = modules.canonical.resolveCanonicalPageContent('page-2')
    assert.strictEqual(unavailable.source, 'unavailable')
    assert.strictEqual(unavailable.text, '')
    const pageList = modules.canonical.listCanonicalPageContents('doc-1', { limit: 1 })
    assert.strictEqual(pageList.items.length, 1)
    assert.ok(pageList.nextCursor)

    database.run("INSERT INTO pages (id, doc_id, page_num, ocr_status, proof_status, created_at) VALUES ('page-3', 'doc-1', 3, 'pending', 'pending', '2026-01-01')")
    const firstCompatibility = modules.artifacts.recordCompatibilityOcrArtifacts([
      { pageId: 'page-3', engine: 'paddle', text: 'alpha', result: { text: 'alpha' } },
    ], { nowMs: 2_000 })[0]
    modules.artifacts.recordCompatibilityOcrArtifacts([
      { pageId: 'page-3', engine: 'paddle', text: 'beta', result: { text: 'beta' } },
    ], { nowMs: 2_010 })
    const reactivated = modules.artifacts.recordCompatibilityOcrArtifacts([
      { pageId: 'page-3', engine: 'paddle', text: 'alpha', result: { text: 'alpha' } },
    ], { nowMs: 2_020 })[0]
    assert.strictEqual(reactivated.id, firstCompatibility.id, 'repeating old content should reactivate the immutable artifact instead of overwriting it')
    assert.strictEqual(modules.canonical.resolveCanonicalPageContent('page-3').text, 'alpha')

    database.closeDatabase()
    database = null
    await modules.database.initDatabase()
    assert.strictEqual(modules.database.queryOne("SELECT COUNT(*) AS count FROM ocr_artifact_versions WHERE id = ?", [artifact.id]).count, 1)
    modules.database.closeDatabase()
    database = null
    console.log('Canonical content and OCR artifact integration regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
