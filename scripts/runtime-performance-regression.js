// Synthetic, offline fixture only. Timings are observations, not machine-dependent pass thresholds.
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')
const { buildSync } = require('esbuild')
process.on('uncaughtException', (error) => { console.error(error); process.exit(1) })
process.on('unhandledRejection', (error) => { console.error(error); process.exit(1) })
const root = join(__dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'gujismart-runtime-performance-'))
process.env.GUJISMART_DATA_DIR = join(temp, 'data')
process.env.GUJISMART_HEADLESS = '1'
const built = buildSync({
  stdin: { contents: "module.exports = { ...require('./src/main/database.ts'), assets: require('./src/main/pdf-assets.ts') }", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'silent',
  alias: { electron: join(__dirname, 'stubs/electron-app-shim.js'), '@electron-toolkit/utils': join(__dirname, 'stubs/electron-toolkit-utils.js') },
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', '__dirname', '__filename', built.outputFiles[0].text)(require, mod, mod.exports, temp, __filename)
const db = mod.exports
const measure = (fn) => { const start = performance.now(); fn(); return Math.round((performance.now() - start) * 10) / 10 }
async function run() {
  try {
    await db.initDatabase()
    const documents = 5000
    const importMs = measure(() => db.transaction(() => {
      for (let i = 0; i < documents; i++) db.run('INSERT INTO documents (id, title) VALUES (?, ?)', [`fixture-${i}`, `Source ${i}`])
    }))
    const pageInsertMs = measure(() => db.transaction(() => {
      for (let i = 0; i < documents; i++) db.run('INSERT INTO pages (id, doc_id, page_num, ocr_text) VALUES (?, ?, ?, ?)', [`page-${i}`, `fixture-${i}`, 1, `Complete fixture text ${i}`])
    }))
    let count = 0
    const lookupMs = measure(() => {
      for (let i = 0; i < 20000; i++) {
        const id = i % documents
        const row = db.queryOne('SELECT p.ocr_text, d.title FROM pages p JOIN documents d ON d.id = p.doc_id WHERE p.id = ?', [`page-${id}`])
        assert.equal(row.ocr_text, `Complete fixture text ${id}`)
        count++
      }
    })
    assert.equal(count, 20000)
    const writeMs = measure(() => db.transaction(() => {
      for (let i = 0; i < 20000; i++) db.run('UPDATE pages SET ocr_status = ? WHERE id = ?', [i % 2 ? 'pending' : 'completed', `page-${i % documents}`])
    }))
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM pages').n, documents)
    db.closeDatabase()
    const start = performance.now()
    await db.initDatabase()
    const reopenMs = Math.round((performance.now() - start) * 10) / 10
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM documents').n, documents)
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM library_project_documents').n, documents)
    const source = join(temp, 'synthetic-copy.pdf')
    const content = Buffer.alloc(32 * 1024 * 1024, 65)
    content.write('%PDF-1.4\n')
    content.write('final-byte-marker', content.length - 17)
    writeFileSync(source, content)
    const expectedHash = createHash('sha256').update(content).digest('hex')
    let lastProgress = 0
    const copyStart = performance.now()
    const copy = await db.assets.copyFileWithFingerprintAsync(source, join(temp, 'copied.pdf'), undefined, ({ bytesDone }) => {
      assert(bytesDone >= lastProgress)
      lastProgress = bytesDone
    })
    assert.equal(copy.sourceFingerprint.sha256, expectedHash)
    assert.equal(lastProgress, content.length)
    const copy32MiBMs = Math.round(performance.now() - copyStart)
    assert.equal((await db.assets.getPdfFingerprintAsync(join(temp, 'copied.pdf'))).sha256, expectedHash, 'stored copy must preserve every byte')
    console.log(JSON.stringify({ documents, importMs, pageInsertMs, lookup20000Ms: lookupMs, queueWrites20000Ms: writeMs, reopenMs, copy32MiBMs }))
  } finally { db.closeDatabase() }
}
run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
