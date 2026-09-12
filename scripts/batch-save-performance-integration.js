const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { buildSync } = require('esbuild')
const zlib = require('node:zlib')
const ts = require('typescript')
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
    const cycle = Array.from({ length: 20 }, (_, i) => `entry${i};`).join('')
    const rejected = await mod.exports.processor.postProcessPdfResultsBatched([
      { page: { id: 'fixture-page-1', image_path: null }, sourcePageIndex: 1, resultIndex: 0 },
    ], [{ words_result: [{ words: cycle.repeat(45) }] }], {
      profile: 'guji_print_vertical', secondPass: 'none', imageRotation: 0,
    })
    assert.equal(rejected[0].status, 'error', 'legacy PDF batches must reject runaway repeated output')
    assert.equal(rejected[0].result, null)
    assert.equal(rejected[0].text, '')
    const beforeFailure = db.queryOne("SELECT * FROM pages WHERE id = 'fixture-page-1'")
    const beforePayload = mod.exports.payload.hydratePagePayloadRow({ ...beforeFailure })
    const compressionCount = compressions
    const failedChanges = await mod.exports.processor.savePageResults([{
      pageId: 'fixture-page-1', status: 'error', text: '', result: null, error: 'Synthetic failed retry',
    }], { deferSearchRefresh: true, deferDatabaseSave: true })
    const afterFailure = db.queryOne("SELECT * FROM pages WHERE id = 'fixture-page-1'")
    const afterPayload = mod.exports.payload.hydratePagePayloadRow({ ...afterFailure })
    assert.equal(afterFailure.ocr_status, 'error')
    for (const field of ['ocr_text', 'ocr_text_ref', 'ocr_result', 'ocr_result_ref', 'proofed_text', 'proof_base_stale']) {
      assert.equal(afterFailure[field], beforeFailure[field], `${field} must survive a failed retry`)
    }
    assert.equal(afterPayload.ocr_text, beforePayload.ocr_text)
    assert.equal(afterPayload.ocr_result, beforePayload.ocr_result)
    assert.equal(compressions, compressionCount, 'failed results must not overwrite external payload files')
    assert.deepEqual(failedChanges, [], 'unchanged text needs no search refresh')
    // Exercise the regular IPC save function against the same isolated SQLite payloads.
    const ipcSource = ts.createSourceFile('ocr.ts', require('node:fs').readFileSync(join(root, 'src/main/ipc/ocr.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    const saveNode = ipcSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'savePageOcrResults')
    assert(saveNode)
    const saveCode = ts.transpileModule(saveNode.getText(ipcSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    let preparedPayloads = 0
    const context = {
      guardRepeatedOcrPageResult: value => value,
      getPageSnapshotsForOcrSave: ids => new Map(ids.map(id => [id, mod.exports.payload.hydratePagePayloadRow(db.queryOne('SELECT * FROM pages WHERE id = ?', [id]))])),
      isOcrQualityFailureMessage: value => value === 'Synthetic quality rejection',
      preparePagePayloadUpdate: () => { preparedPayloads++; throw Error('Failed retry must not prepare replacement payloads') },
      transaction: db.transaction, run: db.run,
      markPageOcrVersionsInactive: ids => assert.equal(ids.length, 0, 'Previous OCR versions must survive rejected retries'),
      logSlowOcrStep: () => {},
    }
    const saveIpc = new Function(...Object.keys(context), `${saveCode}\nreturn savePageOcrResults`)(...Object.values(context))
    for (const [error, expectedStatus] of [['Synthetic quality rejection', 'error'], ['Synthetic transient failure', 'completed']]) {
      db.run("UPDATE pages SET ocr_status = 'processing' WHERE id = 'fixture-page-1'")
      saveIpc([{ pageId: 'fixture-page-1', result: null, text: '', status: 'error', error }], 'paddle', { deferFinalize: true, deferDatabaseSave: true, markTocDirty: false })
      const stored = db.queryOne("SELECT * FROM pages WHERE id = 'fixture-page-1'")
      assert.equal(stored.ocr_status, expectedStatus)
      for (const field of ['ocr_text', 'ocr_text_ref', 'ocr_result', 'ocr_result_ref', 'proofed_text', 'proof_base_stale']) {
        assert.equal(stored[field], beforeFailure[field], `Regular IPC: ${field} must survive ${error}`)
      }
      assert.equal(mod.exports.payload.hydratePagePayloadRow({ ...stored }).ocr_text, beforePayload.ocr_text)
    }
    assert.equal(preparedPayloads, 0)
    console.log(`Batch async preparation regression passed: ${compressions} compressions outside transactions; complete OCR retained, proofreading preserved, concurrent deletion not resurrected.`)
  } finally { zlib.gzip = originalGzip; db.closeDatabase() }
}
run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
