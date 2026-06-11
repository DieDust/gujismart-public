const assert = require('assert')
const { app } = require('electron')
const { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-startup-recovery-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'startup-recovery-bundle.cjs')
const entryPath = join(tempRoot, 'startup-recovery-entry.js')

process.env.GUJISMART_DATA_DIR = tempDataDir
process.env.GUJISMART_AUTO_REINDEX = '0'

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const search = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'semantic-search.ts'))})
  const startupRecovery = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'startup-recovery.ts'))})
  module.exports = { database, search, startupRecovery }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3', '@napi-rs/canvas'],
  alias: {
    electron: join(__dirname, 'stubs', 'electron.js'),
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

function insertDocument(database, id, status = {}) {
  const now = new Date().toISOString()
  database.run(
    `INSERT INTO documents (
      id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
      ocr_status, proof_status, import_status, error_message, metadata_status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      id,
      null,
      null,
      null,
      'unknown',
      status.filePath || null,
      status.thumbPath || null,
      status.pageCount ?? 1,
      status.ocrStatus || 'pending',
      'pending',
      status.importStatus || 'stored',
      status.errorMessage || null,
      'pending',
      status.metadata || '{}',
      now,
      now,
    ],
  )
}

function insertPage(database, id, docId, pageNum, status = 'pending') {
  database.run(
    'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, docId, pageNum, null, status === 'completed' ? `text ${pageNum}` : null, null, null, status, 'pending', new Date().toISOString()],
  )
}

function insertStructuredResultOnlyPage(database, id, docId, pageNum) {
  database.run(
    'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      docId,
      pageNum,
      null,
      null,
      JSON.stringify({ words_result: [{ words: `startup structured result ${pageNum}` }] }),
      null,
      'pending',
      'pending',
      new Date().toISOString(),
    ],
  )
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, label) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    if (predicate()) return
    await wait(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    const { search, startupRecovery } = modules

    await database.initDatabase()

    insertDocument(database, 'doc_index_queued', { pageCount: 0 })
    insertDocument(database, 'doc_index_processing', { pageCount: 0 })
    insertDocument(database, 'doc_index_searchable_processing', { pageCount: 1 })
    insertPage(database, 'page_index_searchable_1', 'doc_index_searchable_processing', 1, 'completed')
    insertDocument(database, 'doc_index_legacy_recover', { pageCount: 1, importStatus: 'processed', ocrStatus: 'completed' })
    insertPage(database, 'page_index_legacy_recover_1', 'doc_index_legacy_recover', 1, 'completed')
    insertDocument(database, 'doc_index_ready', { pageCount: 0 })
    insertDocument(database, 'doc_translate', { pageCount: 2 })
    insertPage(database, 'page_translate_1', 'doc_translate', 1, 'completed')
    insertPage(database, 'page_translate_2', 'doc_translate', 2, 'completed')
    insertDocument(database, 'doc_completed_text_without_file', {
      pageCount: 2,
      importStatus: 'unstored',
      ocrStatus: 'completed',
      errorMessage: 'final document status was not saved before shutdown',
    })
    insertPage(database, 'page_completed_text_without_file_1', 'doc_completed_text_without_file', 1, 'completed')
    insertPage(database, 'page_completed_text_without_file_2', 'doc_completed_text_without_file', 2, 'completed')
    insertDocument(database, 'doc_completed_result_only', {
      pageCount: 2,
      importStatus: 'stored',
      ocrStatus: 'pending',
      errorMessage: 'structured OCR result was saved before document status',
    })
    insertStructuredResultOnlyPage(database, 'page_completed_result_only_1', 'doc_completed_result_only', 1)
    insertStructuredResultOnlyPage(database, 'page_completed_result_only_2', 'doc_completed_result_only', 2)

    database.run(
      'INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['doc_index_queued', 'queued', '', 0, null, null, new Date().toISOString()],
    )
    database.run(
      'INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['doc_index_processing', 'processing', '', 0, 'building', null, new Date().toISOString()],
    )
    database.run(
      'INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['doc_index_searchable_processing', 'processing', '', 0, 'building searchable', null, new Date().toISOString()],
    )
    search.reindexDocument('doc_index_legacy_recover')
    database.run(
      "UPDATE search_index_status SET status = 'queued', source_hash = '', segment_count = 0, indexed_at = NULL, error_message = ? WHERE doc_id = ?",
      ['legacy metadata was cleared during upgrade', 'doc_index_legacy_recover'],
    )
    database.run(
      'INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['doc_index_ready', 'ready', 'hash', 3, null, new Date().toISOString(), new Date().toISOString()],
    )

    database.run(
      `INSERT INTO page_translation_cache (
        id, doc_id, page_id, page_num, source_hash, source_text, translation_text,
        skipped, status, error_message, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['translation_processing', 'doc_translate', 'page_translate_1', 1, 'hash-1', 'source', '', 0, 'processing', 'running', 'test-model', new Date().toISOString(), new Date().toISOString()],
    )
    database.run(
      `INSERT INTO page_translation_cache (
        id, doc_id, page_id, page_num, source_hash, source_text, translation_text,
        skipped, status, error_message, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['translation_ready', 'doc_translate', 'page_translate_2', 2, 'hash-2', 'source', 'translation', 0, 'ready', null, 'test-model', new Date().toISOString(), new Date().toISOString()],
    )
    database.run(
      `INSERT INTO page_ai_layout_cache (
        id, doc_id, page_id, page_num, mode, source_hash, result_text,
        status, error_message, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['ai_layout_processing', 'doc_translate', 'page_translate_1', 1, 'read', 'layout-hash-1', '', 'processing', 'running', 'test-model', new Date().toISOString(), new Date().toISOString()],
    )
    database.run(
      `INSERT INTO page_ai_layout_cache (
        id, doc_id, page_id, page_num, mode, source_hash, result_text,
        status, error_message, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['ai_layout_ready', 'doc_translate', 'page_translate_2', 2, 'read', 'layout-hash-2', 'layout', 'ready', null, 'test-model', new Date().toISOString(), new Date().toISOString()],
    )

    const storageRoot = join(tempDataDir, 'storage')
    const knownStorageDir = join(storageRoot, 'doc_index_ready')
    const orphanStorageDir = join(storageRoot, 'orphan_doc')
    const deletingStorageDir = join(storageRoot, 'doc_deleting')
    const interruptedCompressionStorageDir = join(storageRoot, 'doc_interrupted_compression')
    const interruptedCompressionPdfPath = join(interruptedCompressionStorageDir, 'stored.pdf')
    const interruptedCompressionOriginalPath = join(interruptedCompressionStorageDir, '.original-123456-abcdef.pdf')
    const ocrTempDir = join(tmpdir(), `gujismart-ocr-startup-recovery-${Date.now()}`)
    const activeOcrTempDir = join(tmpdir(), `gujismart-ocr-active-${Date.now()}`)
    const compressionTempDir = join(tempDataDir, 'temp', 'pdf-compression')
    mkdirSync(knownStorageDir, { recursive: true })
    mkdirSync(orphanStorageDir, { recursive: true })
    mkdirSync(deletingStorageDir, { recursive: true })
    mkdirSync(interruptedCompressionStorageDir, { recursive: true })
    mkdirSync(ocrTempDir, { recursive: true })
    mkdirSync(activeOcrTempDir, { recursive: true })
    mkdirSync(compressionTempDir, { recursive: true })
    writeFileSync(join(orphanStorageDir, 'leftover.txt'), 'orphan')
    writeFileSync(join(deletingStorageDir, 'source.txt'), 'deleting')
    writeFileSync(interruptedCompressionOriginalPath, '%PDF-1.4\n% interrupted compression original\n')
    writeFileSync(join(ocrTempDir, 'chunk_0001.pdf'), 'temporary ocr chunk')
    writeFileSync(join(activeOcrTempDir, 'chunk_0001.pdf'), 'active temporary ocr chunk')
    writeFileSync(join(compressionTempDir, 'qpdf-temp.pdf'), 'temporary compression output')
    const staleTempTime = new Date(Date.now() - 120_000)
    const activeTempTime = new Date(Date.now() + 120_000)
    utimesSync(ocrTempDir, staleTempTime, staleTempTime)
    utimesSync(activeOcrTempDir, activeTempTime, activeTempTime)
    utimesSync(compressionTempDir, staleTempTime, staleTempTime)

    const interruptedPdfDir = join(storageRoot, 'doc_interrupted_pdf')
    const interruptedPdfPath = join(interruptedPdfDir, 'interrupted.pdf')
    const completedMissingPagesDir = join(storageRoot, 'doc_completed_missing_pages')
    const completedMissingPagesPath = join(completedMissingPagesDir, 'completed-missing-pages.pdf')
    const interruptedLargePdfDir = join(storageRoot, 'doc_interrupted_large_pdf')
    const interruptedLargePdfPath = join(interruptedLargePdfDir, 'interrupted-large.pdf')
    mkdirSync(interruptedPdfDir, { recursive: true })
    mkdirSync(completedMissingPagesDir, { recursive: true })
    mkdirSync(interruptedLargePdfDir, { recursive: true })
    writeFileSync(interruptedPdfPath, '%PDF-1.4\n% interrupted import regression\n')
    writeFileSync(completedMissingPagesPath, '%PDF-1.4\n% completed but missing page rows regression\n')
    writeFileSync(interruptedLargePdfPath, '%PDF-1.4\n% interrupted large PDF import regression\n')
    insertDocument(database, 'doc_interrupted_pdf', {
      filePath: interruptedPdfPath,
      pageCount: 4,
      importStatus: 'processing',
      ocrStatus: 'processing',
      errorMessage: 'simulated interrupted import',
      metadata: JSON.stringify({ pdf_page_count: 4 }),
    })
    insertPage(database, 'page_interrupted_pdf_1', 'doc_interrupted_pdf', 1, 'pending')
    insertDocument(database, 'doc_completed_missing_pages', {
      filePath: completedMissingPagesPath,
      pageCount: 3,
      importStatus: 'processed',
      ocrStatus: 'completed',
      errorMessage: 'simulated stale completed status',
      metadata: JSON.stringify({ pdf_page_count: 3 }),
    })
    insertPage(database, 'page_completed_missing_pages_1', 'doc_completed_missing_pages', 1, 'completed')
    insertDocument(database, 'doc_interrupted_large_pdf', {
      filePath: interruptedLargePdfPath,
      pageCount: 1200,
      importStatus: 'processing',
      ocrStatus: 'processing',
      errorMessage: 'simulated interrupted large PDF import',
      metadata: JSON.stringify({ pdf_page_count: 1200 }),
    })
    insertPage(database, 'page_interrupted_large_pdf_1', 'doc_interrupted_large_pdf', 1, 'pending')

    const interruptedTextDir = join(storageRoot, 'doc_interrupted_text')
    const interruptedTextPath = join(interruptedTextDir, 'interrupted.txt')
    mkdirSync(interruptedTextDir, { recursive: true })
    writeFileSync(interruptedTextPath, 'interrupted text import regression')
    insertDocument(database, 'doc_interrupted_text', {
      filePath: interruptedTextPath,
      pageCount: 1,
      importStatus: 'unstored',
      ocrStatus: 'pending',
      errorMessage: 'simulated interrupted text import',
    })

    insertDocument(database, 'doc_interrupted_compression', {
      filePath: interruptedCompressionPdfPath,
      pageCount: 1,
      importStatus: 'stored',
      ocrStatus: 'pending',
      errorMessage: 'simulated interrupted compression',
    })
    insertPage(database, 'page_interrupted_compression_1', 'doc_interrupted_compression', 1, 'pending')

    insertDocument(database, 'doc_deleting', {
      importStatus: 'deleting',
      ocrStatus: 'processing',
      filePath: join(deletingStorageDir, 'source.txt'),
    })
    insertPage(database, 'page_deleting_1', 'doc_deleting', 1, 'processing')
    database.run(
      'INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['batch_completed_stale', 'startup_resume_batch', 'doc_translate', 'pending', 5, 0, null, new Date().toISOString()],
    )
    database.run(
      'INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['batch_deleting_stale', 'startup_resume_batch', 'doc_deleting', 'pending', 5, 0, null, new Date().toISOString()],
    )

    const summary = await startupRecovery.runStartupRecovery()
    assert.strictEqual(summary.resetSearchIndexJobs, 3)
    assert.strictEqual(summary.resetAiLayoutCacheRows, 1)
    assert.strictEqual(summary.resetTranslationCacheRows, 1)
    assert.strictEqual(summary.orphanStorageDirs, 1)
    assert.strictEqual(summary.deletingDocuments.queuedDocuments, 2)
    assert.strictEqual(summary.ocr.recoveredDocuments, 3)
    assert.strictEqual(summary.completedOcrDocuments, 2)
    assert.strictEqual(summary.repairedInterruptedImports, 5)
    assert.strictEqual(summary.initializedPdfPageRecords, 5)
    assert.strictEqual(summary.recoveredPdfCompressionSources, 1)
    assert.strictEqual(summary.reindexedRecoveredOcrDocuments, 5)
    assert.deepStrictEqual(summary.resumedBatchQueue, {
      resumedJobs: 0,
      resumedItems: 0,
      completedItems: 1,
      skippedItems: 1,
    })
    assert(summary.removedTempDirs >= 2, `expected at least 2 temp dirs to be removed, saw ${summary.removedTempDirs}`)

    assert.deepStrictEqual(
      database.queryAll('SELECT doc_id, status, error_message FROM search_index_status ORDER BY doc_id'),
      [
        { doc_id: 'doc_completed_missing_pages', status: 'queued', error_message: null },
        { doc_id: 'doc_completed_result_only', status: 'queued', error_message: null },
        { doc_id: 'doc_completed_text_without_file', status: 'queued', error_message: null },
        { doc_id: 'doc_index_legacy_recover', status: 'ready', error_message: null },
        { doc_id: 'doc_index_processing', status: 'queued', error_message: null },
        { doc_id: 'doc_index_queued', status: 'queued', error_message: null },
        { doc_id: 'doc_index_ready', status: 'ready', error_message: null },
        { doc_id: 'doc_index_searchable_processing', status: 'queued', error_message: null },
        { doc_id: 'doc_translate', status: 'queued', error_message: null },
      ],
    )
    assert.ok(
      String(database.queryOne('SELECT source_hash FROM search_index_status WHERE doc_id = ?', ['doc_index_legacy_recover'])?.source_hash || '').startsWith('legacy-existing-index:'),
      'Expected startup recovery to preserve usable legacy search segments instead of requeueing them',
    )
    assert.deepStrictEqual(
      database.queryOne('SELECT ocr_status, import_status, error_message, page_count FROM documents WHERE id = ?', ['doc_translate']),
      { ocr_status: 'completed', import_status: 'processed', error_message: null, page_count: 2 },
    )
    assert.deepStrictEqual(
      database.queryOne('SELECT ocr_status, import_status, error_message, page_count FROM documents WHERE id = ?', ['doc_completed_text_without_file']),
      { ocr_status: 'completed', import_status: 'processed', error_message: null, page_count: 2 },
    )
    assert.deepStrictEqual(
      database.queryOne('SELECT ocr_status, import_status, error_message, page_count FROM documents WHERE id = ?', ['doc_completed_result_only']),
      { ocr_status: 'completed', import_status: 'processed', error_message: null, page_count: 2 },
    )
    assert.deepStrictEqual(
      database.queryOne('SELECT ocr_status, import_status, error_message, page_count FROM documents WHERE id = ?', ['doc_index_searchable_processing']),
      { ocr_status: 'completed', import_status: 'processed', error_message: null, page_count: 1 },
    )
    assert.deepStrictEqual(
      database.queryOne('SELECT ocr_status, import_status, error_message, page_count FROM documents WHERE id = ?', ['doc_interrupted_pdf']),
      { ocr_status: 'pending', import_status: 'stored', error_message: null, page_count: 4 },
    )
    assert.deepStrictEqual(
      database.queryOne('SELECT ocr_status, import_status, error_message, page_count FROM documents WHERE id = ?', ['doc_completed_missing_pages']),
      { ocr_status: 'pending', import_status: 'stored', error_message: null, page_count: 3 },
    )
    assert.deepStrictEqual(
      database.queryOne('SELECT ocr_status, import_status, error_message, page_count FROM documents WHERE id = ?', ['doc_interrupted_large_pdf']),
      { ocr_status: 'pending', import_status: 'stored', error_message: null, page_count: 1200 },
    )
    assert.strictEqual(
      database.queryOne('SELECT COUNT(*) as count FROM pages WHERE doc_id = ?', ['doc_interrupted_pdf']).count,
      4,
    )
    assert.strictEqual(
      database.queryOne('SELECT COUNT(*) as count FROM pages WHERE doc_id = ?', ['doc_completed_missing_pages']).count,
      3,
    )
    assert.strictEqual(
      database.queryOne('SELECT COUNT(*) as count FROM pages WHERE doc_id = ?', ['doc_interrupted_large_pdf']).count,
      1,
    )
    assert.strictEqual(
      JSON.parse(database.queryOne('SELECT metadata FROM documents WHERE id = ?', ['doc_interrupted_large_pdf']).metadata).pdf_page_records_deferred,
      true,
    )
    assert.deepStrictEqual(
      database.queryAll('SELECT id, status FROM page_translation_cache ORDER BY id'),
      [
        { id: 'translation_processing', status: 'error' },
        { id: 'translation_ready', status: 'ready' },
      ],
    )
    assert.deepStrictEqual(
      database.queryAll('SELECT id, status FROM page_ai_layout_cache ORDER BY id'),
      [
        { id: 'ai_layout_processing', status: 'error' },
        { id: 'ai_layout_ready', status: 'ready' },
      ],
    )
    assert.deepStrictEqual(
      database.queryOne('SELECT status, progress, error_message FROM batch_queue WHERE id = ?', ['batch_completed_stale']),
      { status: 'completed', progress: 100, error_message: null },
    )
    assert.strictEqual(existsSync(orphanStorageDir), false)
    assert.strictEqual(existsSync(knownStorageDir), true)
    assert.strictEqual(existsSync(interruptedCompressionPdfPath), true)
    assert.strictEqual(existsSync(interruptedCompressionOriginalPath), false)
    assert.strictEqual(existsSync(ocrTempDir), false)
    assert.strictEqual(existsSync(activeOcrTempDir), true)
    assert.strictEqual(existsSync(compressionTempDir), false)
    rmSync(activeOcrTempDir, { recursive: true, force: true })

    await waitFor(
      () => database.queryOne('SELECT id FROM documents WHERE id = ?', ['doc_deleting']) === null,
      'interrupted document delete to finish',
    )
    await waitFor(
      () => database.queryOne('SELECT id FROM documents WHERE id = ?', ['doc_interrupted_text']) === null,
      'unrecoverable interrupted text import cleanup',
    )
    await waitFor(() => !existsSync(deletingStorageDir), 'interrupted document storage cleanup')

    const secondSummary = await startupRecovery.runStartupRecovery()
    assert.strictEqual(secondSummary.resetSearchIndexJobs, 0)
    assert.strictEqual(secondSummary.resetAiLayoutCacheRows, 0)
    assert.strictEqual(secondSummary.resetTranslationCacheRows, 0)
    assert.strictEqual(secondSummary.orphanStorageDirs, 0)
    assert.strictEqual(secondSummary.deletingDocuments.queuedDocuments, 0)
    assert.strictEqual(secondSummary.completedOcrDocuments, 0)
    assert.strictEqual(secondSummary.repairedInterruptedImports, 0)
    assert.strictEqual(secondSummary.initializedPdfPageRecords, 0)
    assert.strictEqual(secondSummary.recoveredPdfCompressionSources, 0)
    assert.strictEqual(secondSummary.reindexedRecoveredOcrDocuments, 0)
    assert.deepStrictEqual(secondSummary.resumedBatchQueue, {
      resumedJobs: 0,
      resumedItems: 0,
      completedItems: 0,
      skippedItems: 0,
    })
    assert.strictEqual(secondSummary.removedTempDirs, 0)

    console.log('Startup recovery regression passed')
  } finally {
    if (database) database.closeDatabase()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

run()
  .then(() => {
    app.quit()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    rmSync(tempRoot, { recursive: true, force: true })
    app.quit()
    process.exit(1)
  })
