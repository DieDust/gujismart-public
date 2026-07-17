const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-ocr-recovery-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'ocr-recovery-bundle.cjs')
const entryPath = join(tempRoot, 'ocr-recovery-entry.js')

process.env.GUJISMART_DATA_DIR = tempDataDir

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const recovery = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'ocr-recovery.ts'))})
  module.exports = { database, recovery }
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

function insertDocument(database, id, status) {
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
      null,
      null,
      status.pageCount,
      status.ocrStatus,
      'pending',
      status.importStatus,
      status.errorMessage || null,
      'pending',
      status.metadata || '{}',
      now,
      now,
    ],
  )
}

function insertPage(database, id, docId, pageNum, status) {
  database.run(
    'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, docId, pageNum, null, status === 'completed' ? `text ${pageNum}` : null, null, null, status, 'pending', new Date().toISOString()],
  )
}

function getDoc(database, id) {
  return database.queryOne('SELECT ocr_status, import_status, error_message FROM documents WHERE id = ?', [id])
}

function getPageStatuses(database, docId) {
  return database.queryAll('SELECT ocr_status FROM pages WHERE doc_id = ? ORDER BY page_num', [docId])
    .map((row) => row.ocr_status)
}

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    const { recovery } = modules

    await database.initDatabase()

    // Interrupted mid-OCR: in-flight page statuses must reset to pending.
    insertDocument(database, 'doc_interrupted', {
      pageCount: 3,
      ocrStatus: 'processing',
      importStatus: 'processing',
      errorMessage: 'stale in-flight upload',
    })
    insertPage(database, 'page_interrupted_1', 'doc_interrupted', 1, 'completed')
    insertPage(database, 'page_interrupted_2', 'doc_interrupted', 2, 'processing')
    insertPage(database, 'page_interrupted_3', 'doc_interrupted', 3, 'queued')

    // Document status wrong while every page is already completed — light recovery
    // only resets status rows; it does NOT promote to completed via content scans.
    insertDocument(database, 'doc_finished_but_stale', {
      pageCount: 2,
      ocrStatus: 'processing',
      importStatus: 'processing',
      errorMessage: 'final status was not saved',
    })
    insertPage(database, 'page_finished_1', 'doc_finished_but_stale', 1, 'completed')
    insertPage(database, 'page_finished_2', 'doc_finished_but_stale', 2, 'completed')

    insertDocument(database, 'doc_queued_no_pages', {
      pageCount: 4,
      ocrStatus: 'queued',
      importStatus: 'processing',
    })

    // Content exists but statuses are pending: light recovery must leave these alone
    // (no full-table content rewrite on open).
    insertDocument(database, 'doc_content_but_pending', {
      pageCount: 2,
      ocrStatus: 'pending',
      importStatus: 'stored',
      errorMessage: 'page status was not finalized',
    })
    insertPage(database, 'page_content_pending_1', 'doc_content_but_pending', 1, 'pending')
    insertPage(database, 'page_content_pending_2', 'doc_content_but_pending', 2, 'pending')
    database.run('UPDATE pages SET ocr_text = ? WHERE id = ?', ['recovered text 1', 'page_content_pending_1'])
    database.run('UPDATE pages SET proofed_text = ? WHERE id = ?', ['recovered proof 2', 'page_content_pending_2'])

    // Pages in-flight while document status already drifted to pending.
    insertDocument(database, 'doc_orphan_inflight_pages', {
      pageCount: 2,
      ocrStatus: 'pending',
      importStatus: 'stored',
    })
    insertPage(database, 'page_orphan_1', 'doc_orphan_inflight_pages', 1, 'processing')
    insertPage(database, 'page_orphan_2', 'doc_orphan_inflight_pages', 2, 'queued')

    insertDocument(database, 'doc_partial_large_pdf', {
      pageCount: 1200,
      ocrStatus: 'processing',
      importStatus: 'processing',
      errorMessage: 'large PDF was interrupted after the first chunk',
      metadata: JSON.stringify({ pdf_page_count: 1200, pdf_page_records_deferred: true }),
    })
    insertPage(database, 'page_partial_large_pdf_1', 'doc_partial_large_pdf', 1, 'completed')

    // Deleting docs must be skipped.
    insertDocument(database, 'doc_deleting', {
      pageCount: 1,
      ocrStatus: 'processing',
      importStatus: 'deleting',
    })
    insertPage(database, 'page_deleting_1', 'doc_deleting', 1, 'processing')

    database.run(
      'INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, error_message, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['batch_item_processing', 'batch_stale', 'doc_interrupted', 'processing', 5, 42, 'uploading', new Date().toISOString(), new Date().toISOString()],
    )
    database.run(
      'INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, error_message, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['batch_item_queued', 'batch_stale', 'doc_queued_no_pages', 'queued', 5, 17, 'waiting for worker', new Date().toISOString(), new Date().toISOString()],
    )
    database.run('PRAGMA foreign_keys = OFF')
    database.run(
      'INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['batch_item_orphaned', 'batch_stale', 'missing_doc', 'pending', 5, 0, null, new Date().toISOString()],
    )
    database.run('PRAGMA foreign_keys = ON')

    const summary = recovery.recoverInterruptedOcrJobs()
    // Interrupted by document status: interrupted, finished_but_stale, queued_no_pages, partial_large_pdf
    // Plus orphan_inflight_pages (page statuses only).
    assert.strictEqual(summary.recoveredDocuments, 5)
    // processing/queued pages: interrupted(2) + orphan(2); deleting docs are skipped.
    assert.strictEqual(summary.recoveredPages, 4)
    assert.strictEqual(summary.recoveredCompletedPages, 0)
    assert.strictEqual(summary.recoveredBatchItems, 2)
    assert.strictEqual(summary.removedOrphanedBatchItems, 1)
    // Light recovery never promotes to completed via content scans.
    assert.strictEqual(summary.completedDocuments, 0)
    assert.strictEqual(summary.pendingDocuments, 5)

    assert.deepStrictEqual(getDoc(database, 'doc_interrupted'), {
      ocr_status: 'pending',
      import_status: 'stored',
      error_message: 'stale in-flight upload',
    })
    assert.deepStrictEqual(getPageStatuses(database, 'doc_interrupted'), ['completed', 'pending', 'pending'])

    // Light recovery resets status only; does not complete fully-done docs.
    assert.deepStrictEqual(getDoc(database, 'doc_finished_but_stale'), {
      ocr_status: 'pending',
      import_status: 'stored',
      error_message: 'final status was not saved',
    })
    assert.deepStrictEqual(getPageStatuses(database, 'doc_finished_but_stale'), ['completed', 'completed'])

    assert.deepStrictEqual(getDoc(database, 'doc_queued_no_pages'), {
      ocr_status: 'pending',
      import_status: 'stored',
      error_message: '应用上次退出时 OCR 未完成，可继续识别',
    })

    // Content-only cases untouched.
    assert.deepStrictEqual(getDoc(database, 'doc_content_but_pending'), {
      ocr_status: 'pending',
      import_status: 'stored',
      error_message: 'page status was not finalized',
    })
    assert.deepStrictEqual(getPageStatuses(database, 'doc_content_but_pending'), ['pending', 'pending'])

    assert.deepStrictEqual(getDoc(database, 'doc_orphan_inflight_pages'), {
      ocr_status: 'pending',
      import_status: 'stored',
      error_message: '应用上次退出时 OCR 未完成，可继续识别',
    })
    assert.deepStrictEqual(getPageStatuses(database, 'doc_orphan_inflight_pages'), ['pending', 'pending'])

    assert.deepStrictEqual(getDoc(database, 'doc_partial_large_pdf'), {
      ocr_status: 'pending',
      import_status: 'stored',
      error_message: 'large PDF was interrupted after the first chunk',
    })
    assert.deepStrictEqual(getPageStatuses(database, 'doc_partial_large_pdf'), ['completed'])

    // Deleting docs and their pages must be left alone.
    assert.deepStrictEqual(getDoc(database, 'doc_deleting'), {
      ocr_status: 'processing',
      import_status: 'deleting',
      error_message: null,
    })
    assert.deepStrictEqual(getPageStatuses(database, 'doc_deleting'), ['processing'])

    const batchItem = database.queryOne(
      'SELECT status, progress, error_message, started_at, completed_at FROM batch_queue WHERE id = ?',
      ['batch_item_processing'],
    )
    assert.deepStrictEqual(batchItem, {
      status: 'pending',
      progress: 0,
      error_message: null,
      started_at: null,
      completed_at: null,
    })
    const queuedBatchItem = database.queryOne(
      'SELECT status, progress, error_message, started_at, completed_at FROM batch_queue WHERE id = ?',
      ['batch_item_queued'],
    )
    assert.deepStrictEqual(queuedBatchItem, {
      status: 'pending',
      progress: 0,
      error_message: null,
      started_at: null,
      completed_at: null,
    })
    assert.strictEqual(
      database.queryOne('SELECT id FROM batch_queue WHERE id = ?', ['batch_item_orphaned']),
      null,
    )

    const secondSummary = recovery.recoverInterruptedOcrJobs()
    assert.strictEqual(secondSummary.recoveredDocuments, 0)
    assert.strictEqual(secondSummary.recoveredPages, 0)
    assert.strictEqual(secondSummary.recoveredCompletedPages, 0)
    assert.strictEqual(secondSummary.recoveredBatchItems, 0)
    assert.strictEqual(secondSummary.removedOrphanedBatchItems, 0)

    console.log('OCR recovery regression passed')
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
