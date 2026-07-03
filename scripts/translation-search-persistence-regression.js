const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-translation-search-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'translation-search-bundle.cjs')
const entryPath = join(tempRoot, 'translation-search-entry.js')

process.env.GUJISMART_DATA_DIR = tempDataDir

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const search = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'semantic-search.ts'))})
  module.exports = { database, search }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3', 'flexsearch', '@napi-rs/canvas'],
  alias: {
    electron: join(__dirname, 'stubs', 'electron.js'),
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

function insertDocument(database, docId, pageId, now) {
  database.run(
    `INSERT INTO documents (
      id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
      ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [docId, 'Translation persistence fixture', null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
  )
  database.run(
    'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [pageId, docId, 1, null, 'source-only-token original text', null, 'completed', 'pending', now],
  )
}

function insertTranslationUnit(database, values) {
  database.run(
    `INSERT INTO page_translation_units (
      id, doc_id, page_id, page_num, unit_id, block_id, block_index, unit_order,
      block_type, source_text, source_hash, translation_text, target_language,
      mode, model_signature, glossary_signature, status, manual_override, stale,
      skipped, quality_json, source_rect_json, source_index, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'zh-CN', 'balanced', 'test-model', 'none', ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
    [
      values.id,
      values.docId,
      values.pageId,
      1,
      values.unitId,
      values.blockId,
      values.blockIndex,
      values.order,
      'text',
      values.sourceText,
      values.sourceHash,
      values.translationText,
      values.status,
      values.manualOverride ? 1 : 0,
      values.stale ? 1 : 0,
      values.skipped ? 1 : 0,
      JSON.stringify(values.rect || { left: 10, top: 10 + values.order * 20, width: 120, height: 18 }),
      values.blockIndex,
      values.now,
      values.now,
    ],
  )
}

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    const search = modules.search

    await database.initDatabase()
    const now = new Date().toISOString()
    const docId = 'tr_doc'
    const pageId = 'translation_page'
    insertDocument(database, docId, pageId, now)

    insertTranslationUnit(database, {
      id: 'row_ready',
      docId,
      pageId,
      unitId: 'tu_ready',
      blockId: 'block_ready',
      blockIndex: 0,
      order: 0,
      sourceText: 'original ready source',
      sourceHash: 'source-ready',
      translationText: 'persisted-translation-token translated content',
      status: 'ready',
      stale: false,
      skipped: false,
      now,
    })
    insertTranslationUnit(database, {
      id: 'row_stale',
      docId,
      pageId,
      unitId: 'tu_stale',
      blockId: 'block_stale',
      blockIndex: 1,
      order: 1,
      sourceText: 'original stale source',
      sourceHash: 'source-stale',
      translationText: 'stale-translation-token should not be searchable',
      status: 'ready',
      stale: true,
      skipped: false,
      now,
    })
    insertTranslationUnit(database, {
      id: 'row_skipped',
      docId,
      pageId,
      unitId: 'tu_skipped',
      blockId: 'block_skipped',
      blockIndex: 2,
      order: 2,
      sourceText: 'skipped-source-token should remain source text',
      sourceHash: 'source-skipped',
      translationText: 'skipped-source-token should remain source text',
      status: 'skipped',
      stale: false,
      skipped: true,
      now,
    })

    const indexed = search.reindexDocument(docId)
    assert.strictEqual(indexed.status, 'ready')

    const translationSegments = database.queryAll(
      "SELECT segment_id, source_kind, text FROM search_index_segments WHERE doc_id = ? AND source_kind = 'translation' ORDER BY ordinal",
      [docId],
    )
    assert.strictEqual(translationSegments.length, 1)
    assert.ok(translationSegments[0].text.includes('persisted-translation-token'))
    assert.ok(!translationSegments.some((row) => row.text.includes('stale-translation-token')))
    assert.ok(!translationSegments.some((row) => row.text.includes('skipped-source-token')))

    const allScope = search.querySearchV2('persisted-translation-token', { docIds: [docId], limit: 20 })
    assert.strictEqual(allScope.totalDocuments, 1)
    assert.strictEqual(allScope.totalHits, 1)
    assert.strictEqual(allScope.groups[0].hits[0].locator.translationSource, true)
    assert.strictEqual(allScope.groups[0].hits[0].locator.translationUnitId, 'tu_ready')

    const translationOnly = search.querySearchV2('persisted-translation-token', {
      docIds: [docId],
      translationScope: 'translation',
      limit: 20,
    })
    assert.strictEqual(translationOnly.totalDocuments, 1)
    assert.strictEqual(translationOnly.groups[0].hits[0].locator.translationSource, true)

    const sourceOnly = search.querySearchV2('persisted-translation-token', {
      docIds: [docId],
      translationScope: 'source',
      limit: 20,
    })
    assert.strictEqual(sourceOnly.totalDocuments, 0)

    const staleOnly = search.querySearchV2('stale-translation-token', {
      docIds: [docId],
      translationScope: 'translation',
      limit: 20,
    })
    assert.strictEqual(staleOnly.totalDocuments, 0)

    const skippedOnly = search.querySearchV2('skipped-source-token', {
      docIds: [docId],
      translationScope: 'translation',
      limit: 20,
    })
    assert.strictEqual(skippedOnly.totalDocuments, 0)

    database.closeDatabase()
  } finally {
    try {
      database?.closeDatabase?.()
    } catch {}
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(tempRoot, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}

run()
  .then(() => {
    console.log('Translation search persistence regression checks passed')
    app.quit()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.quit()
    process.exit(1)
  })
