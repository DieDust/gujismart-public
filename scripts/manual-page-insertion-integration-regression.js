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
const deletionHandlerStart = documentViewSource.indexOf('const handleDeleteManualPage = useCallback')
assert.ok(deletionHandlerStart >= 0, 'DocumentView must expose the manual page deletion handler')
const deletionHandlerEnd = documentViewSource.indexOf('const getReaderSearchInput', deletionHandlerStart)
assert.ok(deletionHandlerEnd > deletionHandlerStart, 'manual page deletion handler must be placed before reader search helpers')
const deletionHandlerSource = documentViewSource.slice(deletionHandlerStart, deletionHandlerEnd)
assert.ok(deletionHandlerSource.includes('window.api.deleteManualPage'), 'manual page deletion must call the preload API')
assert.ok(deletionHandlerSource.includes('result.nextPageId'), 'manual page deletion must navigate to an adjacent page')
assert.ok(documentViewSource.includes('删除当前页'), 'DocumentView must expose a delete current page button')
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
  const research = require(${JSON.stringify(path.join(root, 'src', 'main', 'ipc', 'research.ts'))})
  const citation = require(${JSON.stringify(path.join(root, 'src', 'main', 'ipc', 'citation.ts'))})
  const library = require(${JSON.stringify(path.join(root, 'src', 'main', 'library-projects.ts'))})
  const electron = require('electron')
  module.exports = { database, documents, research, citation, library, handlers: electron.__handlers }
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
    modules.research.registerResearchIpc()
    modules.citation.registerCitationIpc()

    const invoke = async (channel, ...args) => {
      const handler = modules.handlers.get(channel)
      if (!handler) throw new Error(`Missing document IPC handler: ${channel}`)
      return handler({}, ...args)
    }

    const beforeDocId = 'manual_insert_before'
    const pageMapDocId = 'page_map_calibration_fixture'
    insertFixtureDocument(database, pageMapDocId, 6)
    database.run("UPDATE pages SET literature_page_num = page_num + 100, literature_page_source = 'ocr' WHERE doc_id = ?", [pageMapDocId])
    const calibration = await invoke('documents:applyLiteraturePageAnchor', pageMapDocId, 4, 201)
    assert.strictEqual(calibration.updated, 3, 'calibration must write only the anchor and later pages')
    assert.deepStrictEqual(calibration.pages.map(page => page.literature_page_num), [101, 102, 103, 201, 202, 203])
    assert.deepStrictEqual(calibration.pages.map(page => page.literature_page_source), ['ocr', 'ocr', 'ocr', 'manual', 'inferred', 'inferred'], 'earlier page number provenance must survive calibration')
    const persistedMap = database.queryAll('SELECT page_num, literature_page_num, literature_page_source FROM pages WHERE doc_id = ? ORDER BY page_num', [pageMapDocId])
    assert.deepStrictEqual(persistedMap.map(page => page.literature_page_source), ['ocr', 'ocr', 'ocr', 'manual', 'inferred', 'inferred'])
    await invoke('documents:recomputeLiteraturePages', pageMapDocId)
    const recomputed = database.queryAll('SELECT literature_page_num FROM pages WHERE doc_id = ? AND page_num >= 4 ORDER BY page_num', [pageMapDocId])
    assert.deepStrictEqual(recomputed.map(page => page.literature_page_num), [201, 202, 203], 'manual anchor must survive the reopen/OCR recomputation path')

    const libraryId = modules.library.getActiveLibraryProjectId()
    database.run('INSERT OR IGNORE INTO library_project_documents (project_id, document_id, created_at, updated_at) VALUES (?, ?, ?, ?)', [libraryId, pageMapDocId, '2026-01-01', '2026-01-01'])
    const project = await invoke('research:createProject', { name: 'Page citation fixture' })
    const style = await invoke('citation:createStyle', { name: 'Page citation fixture', is_default: 1 })
    await invoke('citation:createTemplate', { style_id: style.id, name: 'Page fixture', format_type: 'Custom', template_text: '{{title}} | {{cite_pages}}' })
    const provenance = { pageId: `${pageMapDocId}_page_4`, pageNum: 4, citationPageNum: 201 }
    const note = await invoke('research:createNote', { project_id: project.id, doc_id: pageMapDocId, page_num: 201, excerpt: 'Immutable evidence', source_id: JSON.stringify(provenance) })
    const listed = await invoke('research:listNotes', project.id)
    assert.strictEqual(listed.find(item => item.id === note.id).source_available, 1, 'printed page 201 must not be looked up as physical page 201')
    const paginated = await invoke('research:listNotesPage', { projectId: project.id })
    assert.strictEqual(paginated.items.find(item => item.id === note.id).source_available, 1)
    const citationOptions = { sourcePageId: provenance.pageId, sourcePageNum: 4, pageNum: 201 }
    assert.match(await invoke('citation:generateByStyle', pageMapDocId, style.id, '', citationOptions), /\| 201$/)
    await invoke('documents:applyLiteraturePageAnchor', pageMapDocId, 4, 301)
    assert.match(await invoke('citation:generateByStyle', pageMapDocId, style.id, '', citationOptions), /\| 301$/, 'new citations follow recalibration')
    const exported = await invoke('research:exportProject', project.id, { format: 'markdown', citationStyleId: style.id, includeReferences: false })
    assert.match(exported.content, /\| 301/, 'project exports use the same live citation page as copying')
    const defaultExport = await invoke('research:exportProject', project.id, { format: 'markdown', includeReferences: false })
    assert.match(defaultExport.content, /\| 301/, 'export without an explicit style follows the active default style')
    const persistedNote = database.queryOne('SELECT page_num, excerpt, source_id FROM research_notes WHERE id = ?', [note.id])
    assert.strictEqual(persistedNote.page_num, 201, 'original excerpt page snapshot is not rewritten')
    assert.strictEqual(persistedNote.excerpt, 'Immutable evidence')
    assert.strictEqual(persistedNote.source_id, JSON.stringify(provenance))
    assert.match(await invoke('citation:generateByStyle', pageMapDocId, style.id, '', { pageNum: '12-14' }), /\| 12-14$/, 'explicit page ranges and legacy callers remain compatible')
    await invoke('pages:insertManual', { documentId: pageMapDocId, anchorPageId: `${pageMapDocId}_page_1`, position: 'before' })
    const moved = database.queryOne('SELECT page_num, literature_page_num FROM pages WHERE id = ?', [provenance.pageId])
    assert.strictEqual(moved.page_num, 5)
    assert.match(await invoke('citation:generateByStyle', pageMapDocId, style.id, '', citationOptions), new RegExp(`\\| ${moved.literature_page_num}$`), 'stable ID wins over the stale physical ordinal after insertion')
    const missingOptions = { ...citationOptions, sourcePageId: 'missing-fixture-page', pageNum: 901 }
    assert.match(await invoke('citation:generateByStyle', pageMapDocId, style.id, '', missingOptions), /\| 901$/, 'missing stable IDs must not retarget other pages')

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

    const deleteDocId = 'manual_delete_page'
    insertFixtureDocument(database, deleteDocId, 4)
    insertPageStateFixtures(database, deleteDocId, `${deleteDocId}_page_2`, 2)
    const deleteResult = await invoke('pages:deleteManual', {
      documentId: deleteDocId,
      pageId: `${deleteDocId}_page_2`,
    })
    assert.strictEqual(deleteResult.deletedPageId, `${deleteDocId}_page_2`)
    assert.strictEqual(deleteResult.deletedPageNum, 2)
    assert.strictEqual(deleteResult.nextPageId, `${deleteDocId}_page_3`)
    assert.strictEqual(deleteResult.pageCount, 3)
    assert.deepStrictEqual(
      getPageRows(database, deleteDocId).map((page) => ({ id: page.id, page_num: page.page_num })),
      [
        { id: `${deleteDocId}_page_1`, page_num: 1 },
        { id: `${deleteDocId}_page_3`, page_num: 2 },
        { id: `${deleteDocId}_page_4`, page_num: 3 },
      ],
    )
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM page_ocr_versions WHERE page_id = ?', [`${deleteDocId}_page_2`]).count, 0)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM page_ai_layout_cache WHERE page_id = ?', [`${deleteDocId}_page_2`]).count, 0)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM page_translation_cache WHERE page_id = ?', [`${deleteDocId}_page_2`]).count, 0)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM page_translation_units WHERE page_id = ?', [`${deleteDocId}_page_2`]).count, 0)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM embedding_chunks WHERE page_id = ?', [`${deleteDocId}_page_2`]).count, 0)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM search_index_segments WHERE page_id = ?', [`${deleteDocId}_page_2`]).count, 0)
    assert.strictEqual(
      database.queryOne('SELECT verification_status FROM research_evidence WHERE doc_id = ? AND page_id IS NULL', [deleteDocId]).verification_status,
      'stale',
    )
    assert.strictEqual(database.queryOne('SELECT page_count FROM documents WHERE id = ?', [deleteDocId]).page_count, 3)

    const lastPageDocId = 'manual_delete_last_page'
    insertFixtureDocument(database, lastPageDocId, 1)
    await assert.rejects(
      () => invoke('pages:deleteManual', {
        documentId: lastPageDocId,
        pageId: `${lastPageDocId}_page_1`,
      }),
      /至少需要保留一页/,
    )
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM pages WHERE doc_id = ?', [lastPageDocId]).count, 1)

    const ocrBusyDocId = 'manual_delete_ocr_busy'
    insertFixtureDocument(database, ocrBusyDocId, 3)
    database.run("UPDATE documents SET ocr_status = 'processing' WHERE id = ?", [ocrBusyDocId])
    await assert.rejects(
      () => invoke('pages:deleteManual', {
        documentId: ocrBusyDocId,
        pageId: `${ocrBusyDocId}_page_1`,
      }),
      /OCR 正在运行/,
    )

    const deferredDocId = 'manual_delete_deferred_pages'
    insertFixtureDocument(database, deferredDocId, 3)
    database.run('UPDATE documents SET page_count = 5 WHERE id = ?', [deferredDocId])
    await assert.rejects(
      () => invoke('pages:deleteManual', {
        documentId: deferredDocId,
        pageId: `${deferredDocId}_page_1`,
      }),
      /页面记录仍在初始化/,
    )

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
