const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const documentViewSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'DocumentView.tsx'), 'utf8')
const insertionHandlerStart = documentViewSource.indexOf('const handleInsertManualPage = useCallback')
const insertionHandlerEnd = documentViewSource.indexOf('const getReaderSearchInput', insertionHandlerStart)
assert.ok(insertionHandlerStart >= 0 && insertionHandlerEnd > insertionHandlerStart, 'DocumentView must expose the manual page insertion handler')
const insertionHandlerSource = documentViewSource.slice(insertionHandlerStart, insertionHandlerEnd)
assert.ok(insertionHandlerSource.includes('pageRangeInFlightRef.current.clear()'), 'manual page insertion must clear in-flight page windows')
assert.ok(insertionHandlerSource.includes('pageRangeRequestRef.current += 1'), 'manual page insertion must invalidate stale page windows')
assert.ok(insertionHandlerSource.includes('searchPagesRequestIdRef.current += 1'), 'manual page insertion must invalidate stale search page windows')
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

function buildStoredOcrResult(pageWidth, pageHeight, orientation, nestedDimensions = false) {
  if (nestedDimensions) {
    return JSON.stringify({
      source_type: 'fixture',
      guji_processing: {
        source_image_width: pageWidth,
        source_image_height: pageHeight,
        orientation,
      },
      layout_result: [],
    })
  }
  return JSON.stringify({
    source_type: 'fixture',
    page_width: pageWidth,
    page_height: pageHeight,
    orientation,
    layout_result: [],
  })
}

function insertFixtureDocument(database, docId, pageCount = 3, options = {}) {
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
        buildStoredOcrResult(
          1200 + pageNum * 100,
          1800 + pageNum * 100,
          pageNum === 2 ? 'vertical' : 'horizontal',
          options.nestedDimensions === true,
        ),
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

function insertPageStateFixtures(database, docId, pageId, pageNum) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  database.run(
    `INSERT INTO page_ocr_versions (id, doc_id, page_id, page_num, engine, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'paddle', ?, ?)`,
    [`${docId}_ocr_version`, docId, pageId, pageNum, timestamp, timestamp],
  )
  database.run(
    `INSERT INTO page_ai_layout_cache (id, doc_id, page_id, page_num, mode, source_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'fixture', 'fixture-layout-hash', ?, ?)`,
    [`${docId}_layout_cache`, docId, pageId, pageNum, timestamp, timestamp],
  )
  database.run(
    `INSERT INTO page_translation_cache (id, doc_id, page_id, page_num, source_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'fixture-translation-hash', ?, ?)`,
    [`${docId}_translation_cache`, docId, pageId, pageNum, timestamp, timestamp],
  )
  database.run(
    `INSERT INTO page_translation_units (id, doc_id, page_id, page_num, unit_id, block_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [`${docId}_translation_unit`, docId, pageId, pageNum, `${docId}_unit`, `${docId}_block`, timestamp, timestamp],
  )
  database.run(
    `INSERT INTO embedding_chunks (segment_id, doc_id, page_id, page_num, model_id, dim, content_hash, embedding, updated_at)
     VALUES (?, ?, ?, ?, 'fixture-model', 1, 'fixture-embedding-hash', ?, ?)`,
    [`${docId}_embedding_segment`, docId, pageId, pageNum, Buffer.from([0]), timestamp],
  )
  database.run(
    `INSERT INTO search_index_segments (segment_id, doc_id, page_id, page_num, text, normalized_text, updated_at)
     VALUES (?, ?, ?, ?, 'fixture search text', 'fixture search text', ?)`,
    [`${docId}_search_segment`, docId, pageId, pageNum, timestamp],
  )
  database.run(
    `INSERT INTO research_evidence (
      id, identity_hash, doc_id, page_id, page_num, locator_json, quote, source_hash,
      content_version, verification_status, created_at
    ) VALUES (?, ?, ?, ?, ?, '{}', 'fixture evidence', 'fixture-evidence-hash', 'fixture-v1', 'verified', ?)`,
    [`${docId}_evidence`, `${docId}_evidence_identity`, docId, pageId, pageNum, timestamp],
  )
  database.run(
    `INSERT INTO research_evidence (
      id, identity_hash, doc_id, page_id, page_num, locator_json, quote, source_hash,
      content_version, verification_status, created_at
    ) VALUES (?, ?, ?, NULL, ?, '{}', 'legacy fixture evidence', 'legacy-evidence-hash', 'fixture-v1', 'verified', ?)`,
    [`${docId}_legacy_evidence`, `${docId}_legacy_evidence_identity`, docId, pageNum, timestamp],
  )
}

function assertPageStateFixturePageNums(database, docId, expectedPageNum) {
  const tables = [
    'page_ocr_versions',
    'page_ai_layout_cache',
    'page_translation_cache',
    'page_translation_units',
    'embedding_chunks',
    'search_index_segments',
    'research_evidence',
  ]
  for (const table of tables) {
    const row = database.queryOne(
      `SELECT page_num FROM ${table} WHERE doc_id = ?${table === 'research_evidence' ? ' AND page_id IS NOT NULL' : ''}`,
      [docId],
    )
    assert.strictEqual(row?.page_num, expectedPageNum, `${table} page_num must follow pages.page_num`)
  }
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

    const nestedDocId = 'manual_insert_nested_dimensions'
    insertFixtureDocument(database, nestedDocId, 3, { nestedDimensions: true })
    const nestedResult = await invoke('pages:insertManual', {
      documentId: nestedDocId,
      anchorPageId: `${nestedDocId}_page_2`,
      position: 'before',
    })
    const nestedOcrResult = JSON.parse(nestedResult.inserted.ocr_result)
    assert.strictEqual(nestedOcrResult.page_width, 1400)
    assert.strictEqual(nestedOcrResult.page_height, 2000)
    assert.strictEqual(nestedOcrResult.orientation, 'vertical')
    assert.notStrictEqual(nestedOcrResult.page_width, 1000)
    assert.notStrictEqual(nestedOcrResult.page_height, 1400)

    const stateDocId = 'manual_insert_page_state'
    insertFixtureDocument(database, stateDocId)
    insertPageStateFixtures(database, stateDocId, `${stateDocId}_page_2`, 2)
    const stateResult = await invoke('pages:insertManual', {
      documentId: stateDocId,
      anchorPageId: `${stateDocId}_page_1`,
      position: 'after',
    })
    assert.strictEqual(stateResult.inserted.page_num, 2)
    assertPageStateFixturePageNums(database, stateDocId, 3)
    assert.strictEqual(
      database.queryOne('SELECT verification_status FROM research_evidence WHERE doc_id = ? AND page_id IS NULL', [stateDocId]).verification_status,
      'stale',
    )

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
