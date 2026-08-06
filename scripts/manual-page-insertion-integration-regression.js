const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(__dirname, '.tmp-manual-page-insertion-'))
const tempDataDir = path.join(tempRoot, 'data')
const bundlePath = path.join(tempRoot, 'manual-page-insertion-bundle.cjs')
const entryPath = path.join(tempRoot, 'manual-page-insertion-entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')

process.env.GUJISMART_DATA_DIR = tempDataDir
process.env.GUJISMART_AUTO_REINDEX = '0'

fs.writeFileSync(electronStubPath, `
  const handlers = new Map()
  const emptyImage = {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toBitmap: () => Buffer.alloc(0),
    toJPEG: () => Buffer.alloc(0),
    resize: () => emptyImage,
    crop: () => emptyImage,
  }
  exports.__handlers = handlers
  exports.ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }
  exports.app = {
    getName: () => 'gujismart-test',
    getPath: () => ${JSON.stringify(tempRoot)},
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  }
  exports.dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  }
  exports.BrowserWindow = class BrowserWindow {
    static getAllWindows() { return [] }
  }
  exports.nativeImage = {
    createFromPath: () => emptyImage,
    createFromBuffer: () => emptyImage,
  }
`)

fs.writeFileSync(entryPath, `
  const database = require(${JSON.stringify(path.join(root, 'src', 'main', 'database.ts'))})
  const documents = require(${JSON.stringify(path.join(root, 'src', 'main', 'ipc', 'documents.ts'))})
  const electron = require('electron')
  module.exports = { database, documents, handlers: electron.__handlers }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3', '@napi-rs/canvas'],
  alias: {
    electron: electronStubPath,
    '@electron-toolkit/utils': path.join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

function buildStoredOcrResult(pageWidth, pageHeight, orientation) {
  return JSON.stringify({
    source_type: 'fixture',
    page_width: pageWidth,
    page_height: pageHeight,
    orientation,
    layout_result: [],
  })
}

function insertFixtureDocument(database, docId, pageCount = 3) {
  const createdAt = '2026-01-01T00:00:00.000Z'
  database.run(
    `INSERT INTO documents (
      id, title, page_count, ocr_status, proof_status, import_status,
      metadata_status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, 'completed', 'pending', 'processed', 'confirmed', '{}', ?, ?)`,
    [docId, `Fixture ${docId}`, pageCount, createdAt, createdAt],
  )
  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    database.run(
      `INSERT INTO pages (
        id, doc_id, page_num, image_path, ocr_text, ocr_result,
        proofed_text, ocr_status, proof_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'pending', ?)`,
      [
        `${docId}_page_${pageNum}`,
        docId,
        pageNum,
        null,
        `Fixture page ${pageNum}`,
        buildStoredOcrResult(1200 + pageNum * 100, 1800 + pageNum * 100, pageNum === 2 ? 'vertical' : 'horizontal'),
        null,
        createdAt,
      ],
    )
  }
}

function getPageRows(database, docId) {
  return database.queryAll(
    'SELECT id, page_num, image_path, ocr_status, proof_status, ocr_result FROM pages WHERE doc_id = ? ORDER BY page_num',
    [docId],
  )
}

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    modules.documents.registerDocumentIpc()

    const invoke = async (channel, ...args) => {
      const handler = modules.handlers.get(channel)
      if (!handler) throw new Error(`Missing document IPC handler: ${channel}`)
      return handler({}, ...args)
    }

    const beforeDocId = 'manual_insert_before'
    insertFixtureDocument(database, beforeDocId)
    const beforeResult = await invoke('pages:insertManual', {
      documentId: beforeDocId,
      anchorPageId: `${beforeDocId}_page_2`,
      position: 'before',
    })
    const beforeRows = getPageRows(database, beforeDocId)
    assert.deepStrictEqual(beforeRows.map((page) => page.page_num), [1, 2, 3, 4])
    assert.strictEqual(beforeResult.pageCount, 4)
    assert.strictEqual(beforeResult.inserted.id, beforeRows[1].id)
    assert.strictEqual(beforeResult.inserted.image_path, null)
    assert.strictEqual(beforeResult.inserted.ocr_status, 'completed')
    assert.strictEqual(beforeResult.inserted.proof_status, 'pending')
    const beforeOcrResult = JSON.parse(beforeResult.inserted.ocr_result)
    assert.strictEqual(beforeOcrResult.source_type, 'manual_blank_page')
    assert.deepStrictEqual(beforeOcrResult.layout_result, [])
    assert.strictEqual(beforeOcrResult.page_width, 1400)
    assert.strictEqual(beforeOcrResult.page_height, 2000)
    assert.strictEqual(beforeOcrResult.orientation, 'vertical')

    const afterDocId = 'manual_insert_after'
    insertFixtureDocument(database, afterDocId)
    const afterResult = await invoke('pages:insertManual', {
      documentId: afterDocId,
      anchorPageId: `${afterDocId}_page_2`,
      position: 'after',
    })
    const afterRows = getPageRows(database, afterDocId)
    assert.deepStrictEqual(afterRows.map((page) => page.page_num), [1, 2, 3, 4])
    assert.strictEqual(afterResult.pageCount, 4)
    assert.strictEqual(afterResult.inserted.page_num, 3)
    assert.strictEqual(afterRows[2].id, afterResult.inserted.id)

    const noAnchorDocId = 'manual_insert_without_anchor'
    insertFixtureDocument(database, noAnchorDocId)
    const noAnchorResult = await invoke('pages:insertManual', {
      documentId: noAnchorDocId,
      position: 'after',
    })
    assert.strictEqual(noAnchorResult.inserted.page_num, 4)
    assert.deepStrictEqual(getPageRows(database, noAnchorDocId).map((page) => page.page_num), [1, 2, 3, 4])

    const rollbackDocId = 'manual_insert_rollback'
    insertFixtureDocument(database, rollbackDocId)
    const rollbackPagesBefore = getPageRows(database, rollbackDocId).map(({ id, page_num }) => ({ id, page_num }))
    const rollbackCountBefore = database.queryOne('SELECT page_count FROM documents WHERE id = ?', [rollbackDocId]).page_count
    database.run(`
      CREATE TRIGGER fail_manual_page_document_update
      BEFORE UPDATE OF page_count ON documents
      WHEN OLD.id = '${rollbackDocId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected manual page insertion failure');
      END
    `)
    await assert.rejects(
      () => invoke('pages:insertManual', {
        documentId: rollbackDocId,
        anchorPageId: `${rollbackDocId}_page_2`,
        position: 'before',
      }),
      /injected manual page insertion failure/,
    )
    database.run('DROP TRIGGER fail_manual_page_document_update')
    const rollbackPagesAfter = getPageRows(database, rollbackDocId).map(({ id, page_num }) => ({ id, page_num }))
    const rollbackCountAfter = database.queryOne('SELECT page_count FROM documents WHERE id = ?', [rollbackDocId]).page_count
    assert.deepStrictEqual(rollbackPagesAfter, rollbackPagesBefore)
    assert.strictEqual(rollbackCountAfter, rollbackCountBefore)
    assert.strictEqual(
      database.queryOne("SELECT COUNT(*) AS count FROM pages WHERE doc_id = ? AND ocr_result LIKE '%manual_blank_page%'", [rollbackDocId]).count,
      0,
    )

    console.log('Manual blank page insertion integration regression passed.')
  } finally {
    try {
      database?.closeDatabase?.()
    } catch {
      // Ignore cleanup errors.
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error('Manual blank page insertion integration regression failed.')
  console.error(error)
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors.
  }
  process.exit(1)
})
