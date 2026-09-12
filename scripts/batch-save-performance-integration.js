const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { buildSync } = require('esbuild')
const zlib = require('node:zlib')
process.on('uncaughtException', (error) => { console.error(error); process.exit(1) })
process.on('unhandledRejection', (error) => { console.error(error); process.exit(1) })
const root = join(__dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'gujismart-batch-save-performance-'))
process.env.GUJISMART_DATA_DIR = join(temp, 'data')
process.env.GUJISMART_HEADLESS = '1'
let db
let compressions = 0
let deletedDuringPreparation = false
const originalGzip = zlib.gzip
zlib.gzip = function (...args) {
  if (db) {
    assert.equal(db.getDatabase().inTransaction, false, 'compression must not hold the database write lock')
    compressions++
    if (!deletedDuringPreparation) {
      deletedDuringPreparation = true
      db.run("DELETE FROM pages WHERE id = 'deleted-during-save'")
    }
  }
  return originalGzip.apply(this, args)
}
const built = buildSync({
  stdin: { contents: `module.exports = {
    db: require('./src/main/database.ts'),
    processor: require('./src/main/batch-processor.ts').batchProcessor,
    payload: require('./src/main/page-payload-store.ts')
  }`, resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'silent',
  alias: { electron: join(__dirname, 'stubs/electron-app-shim.js'), '@electron-toolkit/utils': join(__dirname, 'stubs/electron-toolkit-utils.js') },
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', '__dirname', '__filename', built.outputFiles[0].text)(require, mod, mod.exports, temp, __filename)
db = mod.exports.db
async function run() {
  try {
    await db.initDatabase()
    db.run('INSERT INTO documents (id, title) VALUES (?, ?)', ['fixture-doc', 'Synthetic batch fixture'])
    const body = Array.from({ length: 12000 }, (_, i) => `Complete original line ${i}.`).join('\n')
    const results = Array.from({ length: 14 }, (_, i) => ({
      pageId: i === 0 ? 'deleted-during-save' : `fixture-page-${i}`,
      text: `${body}\nFinal marker ${i}`,
      result: { source_type: 'fixture', text: `${body}\nLayout marker ${i}` },
      status: 'completed',
    }))
    for (const [i, result] of results.entries()) {
      db.run('INSERT INTO pages (id, doc_id, page_num, proofed_text) VALUES (?, ?, ?, ?)', [result.pageId, 'fixture-doc', i + 1, 'User proof remains intact'])
    }
    const changed = await mod.exports.processor.savePageResults(results, { deferSearchRefresh: true, deferDatabaseSave: true })
    assert(compressions > 0)
    assert.equal(changed.length, 13)
    assert.equal(db.queryOne("SELECT id FROM pages WHERE id = 'deleted-during-save'"), null)
    for (const result of results.slice(1)) {
      const row = mod.exports.payload.hydratePagePayloadRow(db.queryOne('SELECT * FROM pages WHERE id = ?', [result.pageId]))
      assert.equal(row.ocr_text, result.text)
      assert.deepEqual(JSON.parse(row.ocr_result), result.result)
      assert.equal(row.proofed_text, 'User proof remains intact')
      assert.equal(row.ocr_status, 'completed')
      assert.equal(row.proof_base_stale, 1)
    }
    console.log(`Batch async preparation regression passed: ${compressions} compressions outside transactions; complete OCR retained, proofreading preserved, concurrent deletion not resurrected.`)
  } finally { zlib.gzip = originalGzip; db.closeDatabase() }
}
run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
