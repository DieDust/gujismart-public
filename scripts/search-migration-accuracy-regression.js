const assert = require('assert')
const { app } = require('electron')
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-search-migration-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'search-migration-bundle.cjs')
const entryPath = join(tempRoot, 'search-migration-entry.js')

process.env.GUJISMART_DATA_DIR = tempDataDir
process.env.GUJISMART_AUTO_REINDEX = '0'

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const search = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'semantic-search.ts'))})
  const maintenance = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database-maintenance.ts'))})
  const payloadStore = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'page-payload-store.ts'))})
  module.exports = { database, search, maintenance, payloadStore }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3', 'flexsearch'],
  alias: {
    electron: join(__dirname, 'stubs', 'electron.js'),
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

function insertDocument(database, doc, now) {
  database.run(
    `INSERT INTO documents (
      id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
      ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [doc.id, doc.title, 'GujiSmart QA', null, null, 'migration-fixture', null, null, doc.pages.length, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
  )
  for (const page of doc.pages) {
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [page.id, doc.id, page.pageNum, null, page.text, null, 'completed', 'pending', now],
    )
  }
}

function groupHitsByDoc(response) {
  return Object.fromEntries(
    response.groups
      .map((group) => [group.docId, group.totalHits])
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function assertQuery(search, query, docIds, expectedHitsByDoc, phase) {
  const expectedTotalHits = Object.values(expectedHitsByDoc).reduce((sum, count) => sum + count, 0)
  const expectedTotalDocuments = Object.values(expectedHitsByDoc).filter((count) => count > 0).length
  const response = search.querySearchV2(query, {
    docIds,
    limit: 1000,
    exhaustive: true,
    resultMode: 'all',
    sort: 'title',
  })
  assert.strictEqual(response.totalDocuments, expectedTotalDocuments, `[${phase}] ${query} document count`)
  assert.strictEqual(response.totalHits, expectedTotalHits, `[${phase}] ${query} total hit count`)
  assert.deepStrictEqual(groupHitsByDoc(response), expectedHitsByDoc, `[${phase}] ${query} hits by doc`)
  for (const group of response.groups) {
    assert.strictEqual(group.hits.length, group.totalHits, `[${phase}] ${query} materialized hits for ${group.docId}`)
    for (const hit of group.hits) {
      assert.strictEqual(hit.locator.queryTerm, query, `[${phase}] locator query should match`)
      assert.ok(hit.snippet.includes('<<') && hit.snippet.includes('>>'), `[${phase}] snippet should mark query`)
    }
  }
}

function makeLargeText(seed, targetChar, targetCount) {
  const parts = []
  for (let index = 0; index < targetCount; index += 1) {
    parts.push(`${seed}段${index + 1}${targetChar}。迁移后仍须命中。`)
  }
  parts.push(`${seed} 长词 alpha-migration-token 出现一次。`)
  return `${parts.join('\n')}\n${'填充文本。'.repeat(1200)}`
}

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    const search = modules.search
    const maintenance = modules.maintenance
    const payloadStore = modules.payloadStore
    await database.initDatabase()

    const now = new Date().toISOString()
    const docs = [
      {
        id: 'migration_doc_a',
        title: 'Migration A',
        pages: [
          { id: 'migration_page_a1', pageNum: 1, text: makeLargeText('甲', '鼎', 3) },
          { id: 'migration_page_a2', pageNum: 2, text: '短词儿童出现一次。儿童再出现一次。' },
        ],
      },
      {
        id: 'migration_doc_b',
        title: 'Migration B',
        pages: [
          { id: 'migration_page_b1', pageNum: 1, text: makeLargeText('乙', '鼎', 5) },
          { id: 'migration_page_b2', pageNum: 2, text: '这里没有目标单字，但是有 alpha-migration-token。' },
        ],
      },
      {
        id: 'migration_doc_c',
        title: 'Migration C',
        pages: [
          { id: 'migration_page_c1', pageNum: 1, text: '空白对照页。' },
        ],
      },
    ]
    for (const doc of docs) insertDocument(database, doc, now)
    const docIds = docs.map((doc) => doc.id)

    for (const docId of docIds) {
      const result = search.reindexDocument(docId)
      assert.strictEqual(result.status, 'ready', `Expected ${docId} to be indexed before migration`)
    }

    const legacySegmentA = database.queryOne('SELECT segment_id FROM search_index_segments WHERE doc_id = ? ORDER BY ordinal LIMIT 1', ['migration_doc_a'])?.segment_id
    const legacySegmentB = database.queryOne('SELECT segment_id FROM search_index_segments WHERE doc_id = ? ORDER BY ordinal LIMIT 1', ['migration_doc_b'])?.segment_id
    assert.ok(legacySegmentA, 'fixture should have a live segment for legacy doc A')
    assert.ok(legacySegmentB, 'fixture should have a live segment for legacy doc B')
    database.run(
      'INSERT INTO search_ngram_index (gram, segment_id, doc_id, positions, hit_count) VALUES (?, ?, ?, ?, ?)',
      ['鼎', legacySegmentA, 'migration_doc_a', '[1,2,3]', 3],
    )
    database.run(
      'INSERT INTO search_ngram_index (gram, segment_id, doc_id, positions, hit_count) VALUES (?, ?, ?, ?, ?)',
      ['儿童', legacySegmentA, 'migration_doc_a', '[4,8]', 2],
    )
    database.run(
      'INSERT INTO search_ngram_index (gram, segment_id, doc_id, positions, hit_count) VALUES (?, ?, ?, ?, ?)',
      ['鼎', legacySegmentB, 'migration_doc_b', '[1,2,3,4,5]', 5],
    )
    assert.ok(Number(database.queryOne('SELECT COUNT(*) as count FROM search_ngram_index')?.count || 0) > 0, 'fixture should contain legacy ngram rows')

    assertQuery(search, '鼎', docIds, { migration_doc_a: 3, migration_doc_b: 5 }, 'before-migration')
    assertQuery(search, '儿童', docIds, { migration_doc_a: 2 }, 'before-migration')
    assertQuery(search, 'alpha-migration-token', docIds, { migration_doc_a: 1, migration_doc_b: 2 }, 'before-migration')

    const externalized = await maintenance.externalizePagePayloadStorage()
    assert.strictEqual(externalized.success, true, 'payload externalization should succeed')
    assert.ok(Number(externalized.updatedRows || 0) > 0, 'payload externalization should move large inline rows')
    const payloadStats = maintenance.getDatabaseStorageDiagnostics().externalPayloads
    assert.ok(payloadStats.fileCount > 0, 'payload migration should create external payload files')
    const migratedPage = database.queryOne('SELECT ocr_text, ocr_text_ref FROM pages WHERE id = ?', ['migration_page_a1'])
    assert.ok(migratedPage?.ocr_text_ref, 'migrated page should have an external ocr_text_ref')
    assert.notStrictEqual(migratedPage.ocr_text, docs[0].pages[0].text, 'migrated page should no longer keep full OCR text inline')
    assert.strictEqual(payloadStore.readPagePayload(migratedPage.ocr_text_ref), docs[0].pages[0].text, 'external payload ref should read back the original OCR text')

    const cleaned = await maintenance.clearLegacySearchNgramIndex()
    assert.strictEqual(cleaned.success, true, 'legacy index cleanup should succeed')
    assert.strictEqual(Number(database.queryOne('SELECT COUNT(*) as count FROM search_ngram_index')?.count || 0), 0, 'legacy ngram rows should be removed')

    for (const docId of docIds) {
      const result = search.reindexDocument(docId)
      assert.strictEqual(result.status, 'ready', `Expected ${docId} to be indexed after migration`)
    }
    const segmentSummary = database.queryAll(
      `SELECT doc_id,
              COUNT(*) as segments,
              SUM(length(text)) as textBytes,
              SUM(CASE WHEN normalized_text LIKE '%鼎%' THEN 1 ELSE 0 END) as dingSegments,
              SUM(CASE WHEN text LIKE '%鼎%' THEN 1 ELSE 0 END) as rawDingSegments
       FROM search_index_segments
       GROUP BY doc_id
       ORDER BY doc_id`,
    )
    assert.ok(segmentSummary.every((row) => Number(row.textBytes || 0) > 0), `reindexed migrated payloads should produce non-empty segments: ${JSON.stringify(segmentSummary)}`)
    assert.ok(segmentSummary.some((row) => Number(row.dingSegments || 0) > 0 || Number(row.rawDingSegments || 0) > 0), `reindexed migrated payloads should contain the single-character target: ${JSON.stringify(segmentSummary)}`)

    const afterDiagnostics = maintenance.getDatabaseStorageDiagnostics()
    assert.strictEqual(afterDiagnostics.searchIndex.ngramRows, 0, 'diagnostics should report no legacy ngram rows after cleanup')
    assert.strictEqual(afterDiagnostics.requiredMaintenance.reasons.includes('legacy-ngram-index'), false, 'legacy ngram maintenance should be resolved')
    assert.strictEqual(afterDiagnostics.requiredMaintenance.required, false, 'startup upgrade modal should not be forced after legacy search indexes are gone')

    assertQuery(search, '鼎', docIds, { migration_doc_a: 3, migration_doc_b: 5 }, 'after-migration')
    assertQuery(search, '儿童', docIds, { migration_doc_a: 2 }, 'after-migration')
    assertQuery(search, 'alpha-migration-token', docIds, { migration_doc_a: 1, migration_doc_b: 2 }, 'after-migration')

    const payloadRef = database.queryOne('SELECT ocr_text_ref as ref, ocr_text FROM pages WHERE id = ?', ['migration_page_a1'])
    assert.ok(payloadRef?.ref, 'large migrated page should keep an external payload ref')
    assert.notStrictEqual(payloadRef.ocr_text, docs[0].pages[0].text, 'large migrated page should not keep the full inline text')

    const cleanup = await maintenance.cleanupExternalPagePayloadStorage()
    assert.strictEqual(cleanup.success, true, 'external payload cleanup should succeed')

    const finalPayloadRef = database.queryOne('SELECT ocr_text_ref as ref FROM pages WHERE id = ?', ['migration_page_a1'])?.ref
    assert.ok(finalPayloadRef, 'external payload ref should still exist after orphan cleanup')
    const payloadPathExists = maintenance.getDatabaseStorageDiagnostics().externalPayloads.referencedFileCount > 0
    assert.ok(payloadPathExists, 'referenced payload file should survive orphan cleanup')

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
    console.log('Search migration accuracy regression passed.')
    app.quit()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.quit()
    process.exit(1)
  })
