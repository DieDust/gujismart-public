const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-search-snapshot-'))
const bundlePath = path.join(tempRoot, 'search-snapshot.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')
process.env.GUJISMART_DATA_DIR = path.join(tempRoot, 'data')
process.env.GUJISMART_AUTO_REINDEX = '0'
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `exports.app={getPath:()=>${JSON.stringify(tempRoot)},getAppPath:()=>${JSON.stringify(root)},getName:()=>'GujiSmart',isPackaged:false}`)
fs.writeFileSync(entryPath, `
  const database=require(${JSON.stringify(path.join(root, 'src/main/database.ts'))})
  const snapshots=require(${JSON.stringify(path.join(root, 'src/main/search-snapshots.ts'))})
  const evidence=require(${JSON.stringify(path.join(root, 'src/main/search-evidence-resolver.ts'))})
  const canonical=require(${JSON.stringify(path.join(root, 'src/main/canonical-content.ts'))})
  module.exports={database,snapshots,evidence,canonical}
`)

async function run() {
  let database
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
      external: ['better-sqlite3'], alias: { electron: electronStubPath, '@electron-toolkit/utils': path.join(root, 'scripts/stubs/electron-toolkit-utils.js') }, logLevel: 'silent' })
    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc/search.ts'), 'utf8')
    const preloadSource = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
    assert.match(ipcSource, /ipcMain\.handle\('search:validateSnapshot'/)
    assert.match(ipcSource, /ipcMain\.handle\('search:resolveEvidence'/)
    assert.match(preloadSource, /validateSearchSnapshot:/)
    assert.match(preloadSource, /resolveSearchEvidence:/)
    assert.ok(database.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='search_generation_state'"))
    database.run("INSERT INTO documents (id,title,import_status,created_at,updated_at) VALUES ('doc-1','Fixture','stored','2026-01-01','2026-01-01')")
    database.run("INSERT INTO pages (id,doc_id,page_num,ocr_text,ocr_status,proof_status,created_at) VALUES ('page-1','doc-1',1,'alpha beta gamma','completed','pending','2026-01-01')")

    const first = modules.snapshots.createSearchSnapshot({ criteriaKey: 'beta', nowMs: 1_000, ttlMs: 100 })
    assert.strictEqual(modules.snapshots.validateSearchSnapshot(first.snapshotId, { criteriaKey: 'beta', nowMs: 1_050 }).validation, 'active')
    assert.strictEqual(modules.snapshots.validateSearchSnapshot(first.snapshotId, { criteriaKey: 'other', nowMs: 1_050 }).validation, 'criteria-mismatch')
    database.run("UPDATE documents SET title='Changed' WHERE id='doc-1'")
    assert.strictEqual(modules.snapshots.validateSearchSnapshot(first.snapshotId, { criteriaKey: 'beta', nowMs: 1_060 }).validation, 'stale')
    const second = modules.snapshots.createSearchSnapshot({ criteriaKey: 'beta', nowMs: 2_000, ttlMs: 100 })
    assert.strictEqual(modules.snapshots.validateSearchSnapshot(second.snapshotId, { criteriaKey: 'beta', nowMs: 2_101 }).validation, 'expired')
    const bounded = Array.from({ length: 129 }, (_, index) => modules.snapshots.createSearchSnapshot({
      criteriaKey: `bounded-${index}`,
      nowMs: 3_000 + index,
      ttlMs: 10_000,
    }))
    assert.strictEqual(modules.snapshots.validateSearchSnapshot(bounded[0].snapshotId, { nowMs: 3_200 }).validation, 'not-found')
    assert.strictEqual(modules.snapshots.validateSearchSnapshot(bounded[128].snapshotId, { nowMs: 3_200 }).validation, 'active')

    const canonical = modules.canonical.resolveCanonicalPageContent('page-1')
    const locator = {
      schemaVersion: 'stable-reader-locator/v2', precision: 'exact', documentId: 'doc-1', sourcePageId: 'page-1', pageNum: 1,
      contentVersion: `${canonical.source}:${canonical.sourceHash}`, sourceHash: canonical.sourceHash, offsetUnit: 'utf16-code-unit',
      sourceRanges: [{ start: 6, end: 10 }], quote: 'beta', prefix: 'alpha ', suffix: ' gamma', occurrenceIndex: 0,
      verificationStatus: 'verified',
    }
    const exact = modules.evidence.resolveSearchEvidence(locator)
    assert.strictEqual(exact.resolution, 'exact')
    assert.strictEqual(exact.verificationStatus, 'verified')
    assert.strictEqual(exact.text, 'beta')
    database.run("UPDATE pages SET ocr_text='new alpha beta gamma' WHERE id='page-1'")
    const relocated = modules.evidence.resolveSearchEvidence(locator)
    assert.strictEqual(relocated.resolution, 'relocated')
    assert.strictEqual(relocated.text, 'beta')
    database.run("DELETE FROM pages WHERE id='page-1'")
    const missing = modules.evidence.resolveSearchEvidence(locator)
    assert.strictEqual(missing.resolution, 'unresolved')
    assert.strictEqual(missing.verificationStatus, 'source-missing')

    database.closeDatabase()
    await database.initDatabase()
    database.closeDatabase()
    database = null
    console.log('Search snapshot and evidence resolver regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
