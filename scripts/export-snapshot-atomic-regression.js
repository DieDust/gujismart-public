const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-export-atomic-'))
const bundlePath = path.join(tempRoot, 'export-atomic.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')
process.env.GUJISMART_DATA_DIR = path.join(tempRoot, 'data')
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `exports.app={getPath:()=>${JSON.stringify(tempRoot)},getAppPath:()=>${JSON.stringify(root)},getName:()=>'GujiSmart',isPackaged:false}`)
fs.writeFileSync(entryPath, `
  const database=require(${JSON.stringify(path.join(root, 'src/main/database.ts'))})
  const atomic=require(${JSON.stringify(path.join(root, 'src/main/atomic-export-writer.ts'))})
  const snapshots=require(${JSON.stringify(path.join(root, 'src/main/export-snapshots.ts'))})
  module.exports={database,atomic,snapshots}
`)

async function run() {
  let database
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
      external: ['better-sqlite3'], alias: { electron: electronStubPath, '@electron-toolkit/utils': path.join(root, 'scripts/stubs/electron-toolkit-utils.js') }, logLevel: 'silent' })
    const modules = require(bundlePath)
    const outputDir = path.join(tempRoot, 'exports')
    fs.mkdirSync(outputDir, { recursive: true })
    const target = path.join(outputDir, 'document.txt')
    fs.writeFileSync(target, 'old-content')

    await assert.rejects(
      modules.atomic.writeAtomicExport(target, async (stagingPath) => fs.writeFileSync(stagingPath, 'bad-content'), () => { throw new Error('invalid') }),
      /invalid/,
    )
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old-content')
    assert.deepStrictEqual(fs.readdirSync(outputDir).filter((name) => name.includes('.gujismart-export-')), [])

    const result = await modules.atomic.writeAtomicExport(
      target,
      async (stagingPath) => fs.writeFileSync(stagingPath, 'new-content'),
      (stagingPath) => assert.strictEqual(fs.readFileSync(stagingPath, 'utf8'), 'new-content'),
    )
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new-content')
    assert.strictEqual(result.byteSize, Buffer.byteLength('new-content'))
    assert.match(result.contentHash, /^[a-f0-9]{64}$/)

    const concurrentTargets = Array.from({ length: 12 }, (_, index) => path.join(outputDir, `parallel-${index}.txt`))
    const stagingNames = new Set()
    await Promise.all(concurrentTargets.map((item, index) => modules.atomic.writeAtomicExport(item, async (stagingPath) => {
      assert.strictEqual(path.dirname(stagingPath), outputDir)
      assert.ok(!stagingNames.has(stagingPath))
      stagingNames.add(stagingPath)
      fs.writeFileSync(stagingPath, String(index))
    })))
    assert.strictEqual(stagingNames.size, concurrentTargets.length)

    database = modules.database
    await database.initDatabase()
    database.run("INSERT INTO documents (id,title,doc_type,metadata,import_status,created_at,updated_at) VALUES ('doc-export','Export','古籍','{}','stored','2026-01-01','2026-01-01')")
    database.run("INSERT INTO pages (id,doc_id,page_num,ocr_text,ocr_result,proof_status,created_at) VALUES ('page-1','doc-export',1,'正文','{}','pending','2026-01-01')")
    const snapshot = modules.snapshots.persistExportSnapshot({ documentId: 'doc-export', format: 'txt', options: {}, pages: [{ id: 'page-1', page_num: 1, canonical_content_version: 'v1', canonical_source_hash: 'source-1', active_ocr_version_id: null }] })
    const same = modules.snapshots.persistExportSnapshot({ documentId: 'doc-export', format: 'txt', options: {}, pages: [{ id: 'page-1', page_num: 1, canonical_content_version: 'v1', canonical_source_hash: 'source-1', active_ocr_version_id: null }] })
    assert.strictEqual(snapshot.id, same.id)
    assert.strictEqual(modules.snapshots.validateExportSnapshot(snapshot.id).validation, 'verified')
    const artifact = modules.snapshots.persistExportArtifact({ snapshotId: snapshot.id, exportPath: target, contentHash: result.contentHash, byteSize: result.byteSize })
    assert.strictEqual(modules.snapshots.validateExportArtifact(artifact.id).validation, 'verified')
    fs.writeFileSync(target, 'tampered')
    assert.strictEqual(modules.snapshots.validateExportArtifact(artifact.id).validation, 'corrupt')
    database.run("UPDATE documents SET updated_at='2026-01-02' WHERE id='doc-export'")
    assert.strictEqual(modules.snapshots.validateExportSnapshot(snapshot.id).validation, 'stale')
    assert.strictEqual(modules.snapshots.listExportSnapshots('doc-export', { limit: 1 }).items.length, 1)
    assert.throws(() => modules.snapshots.listExportSnapshots('doc-export', { limit: 201 }), /export_snapshot_limit_invalid/)
    database.closeDatabase()
    await database.initDatabase()
    assert.ok(database.queryOne('SELECT id FROM export_snapshots WHERE id = ?', [snapshot.id]))
    database.closeDatabase()
    database = null
    console.log('Export snapshot and atomic writer regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
