const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-search-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'search-regression-bundle.cjs')
const entryPath = join(tempRoot, 'search-regression-entry.js')

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

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    const search = modules.search

    await database.initDatabase()
    const now = new Date().toISOString()
    const docs = [
      ['doc_a', '甲馆登记目录'],
      ['doc_b', '乙馆登记目录'],
      ['doc_c', '丙馆登记目录'],
    ]

    for (const [id, title] of docs) {
      database.run(
        `INSERT INTO documents (
          id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
          ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, null, null, null, '古籍善本', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
      )
    }

    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['page_a', 'doc_a', 1, null, '圖書館登記簿。渡口记渡船。又载东渡西渡，渡者三。', null, 'completed', 'pending', now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['page_b', 'doc_b', 1, null, '图书馆登记册。本页有一渡，续文又渡，末尾再渡。', null, 'completed', 'pending', now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['page_c', 'doc_c', 1, null, '此页没有目标字。', null, 'completed', 'pending', now],
    )

    for (const [id] of docs) {
      search.reindexDocument(id)
    }

    const response = search.querySearchV2('渡', { limit: 80 })
    const pagedSnapshot = search.querySearchV2('渡', { limit: 80, page: 1, pageSize: 1 })
    assert.ok(pagedSnapshot.snapshotId, 'Expected querySearchV2 to issue a SearchSnapshot')
    assert.ok(Number.isSafeInteger(pagedSnapshot.librarySearchGeneration))
    assert.match(String(pagedSnapshot.indexGenerationVectorHash || ''), /^[a-f0-9]{64}$/)
    const sameSnapshot = search.querySearchV2('渡', { limit: 80, page: 2, pageSize: 1, snapshotId: pagedSnapshot.snapshotId })
    assert.strictEqual(sameSnapshot.snapshotId, pagedSnapshot.snapshotId, 'Expected pagination to reuse the validated snapshot')
    database.run("UPDATE documents SET title = title || ' changed' WHERE id = 'doc_a'")
    assert.throws(
      () => search.querySearchV2('渡', { limit: 80, page: 2, pageSize: 1, snapshotId: pagedSnapshot.snapshotId }),
      /search_snapshot_stale/,
    )
    const stableHit = response.groups.flatMap((group) => group.hits).find((hit) => hit.stableLocator?.precision === 'exact')
    assert.ok(stableHit, 'Expected verified search hits to include an exact StableReaderLocator v2')
    assert.strictEqual(stableHit.stableLocator.schemaVersion, 'stable-reader-locator/v2')
    assert.ok(stableHit.stableLocator.quote.includes('渡'))
    assert.strictEqual(response.totalDocuments, 2)
    assert.strictEqual(response.totalHits, 8)
    assert.deepStrictEqual(
      response.groups.map((group) => [group.docId, group.totalHits]).sort(),
      [['doc_a', 5], ['doc_b', 3]],
    )

    database.run('UPDATE pages SET ocr_text = ? WHERE id = ?', ['更新后新增渡。渡。渡。渡。', 'page_c'])
    database.refreshSearchIndexForPages(['page_c'])
    search.markSearchIndexStaleForPages(['page_c'])

    const staleStatus = search.getSearchIndexStatus('doc_c')[0]
    assert.strictEqual(staleStatus?.status, 'queued')
    const refreshed = search.querySearchV2('渡', { limit: 80 })
    const refreshedCGroup = refreshed.groups.find((group) => group.docId === 'doc_c')
    assert.strictEqual(refreshedCGroup?.totalHits, 4)
    assert.ok(['queued', 'processing', 'ready'].includes(search.getSearchIndexStatus('doc_c')[0]?.status))
    search.reindexDocument('doc_c')
    const repaired = search.querySearchV2('渡', { limit: 80 })
    const cGroup = repaired.groups.find((group) => group.docId === 'doc_c')
    assert.strictEqual(cGroup?.totalHits, 4)
    assert.strictEqual(search.getSearchIndexStatus('doc_c')[0]?.status, 'ready')

    const traditionalResponse = search.querySearchV2('图书馆登记', { limit: 80 })
    assert.strictEqual(traditionalResponse.totalDocuments, 2)
    assert.ok(traditionalResponse.groups.some((group) => group.docId === 'doc_a'))
    assert.ok(traditionalResponse.groups.some((group) => group.docId === 'doc_b'))

    const simplifiedResponse = search.querySearchV2('圖書館登記', { limit: 80 })
    assert.strictEqual(simplifiedResponse.totalDocuments, 2)

    const ngramCount = database.queryOne('SELECT COUNT(*) as count FROM search_ngram_index')?.count || 0
    assert.strictEqual(ngramCount, 0, 'Expected FTS verified search mode to avoid persistent n-gram rows')
    const trigramCount = database.queryOne('SELECT COUNT(*) as count FROM search_segments_trigram')?.count || 0
    assert.ok(trigramCount > 0, 'Expected compact trigram FTS rows to be populated for long-query search speed')

    const legacyReadyDocId = 'legacy_ready_doc'
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [legacyReadyDocId, 'Legacy ready index', null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['legacy_ready_page', legacyReadyDocId, 1, null, 'legacy-ready-token appears once', null, 'completed', 'pending', now],
    )
    search.reindexDocument(legacyReadyDocId)
    database.run(
      'UPDATE search_index_status SET source_hash = ? WHERE doc_id = ?',
      ['segments-v7-reader-source:legacy-ready', legacyReadyDocId],
    )
    const legacyReadyResponse = search.querySearchV2('legacy-ready-token', { docIds: [legacyReadyDocId], limit: 80 })
    assert.strictEqual(legacyReadyResponse.totalDocuments, 1)
    assert.strictEqual(search.getSearchIndexStatus(legacyReadyDocId)[0]?.status, 'ready')
    assert.strictEqual(search.getSearchIndexStatus(legacyReadyDocId)[0]?.source_hash, 'segments-v7-reader-source:legacy-ready')

    const legacyRecoverDocId = 'legacy_recover_doc'
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [legacyRecoverDocId, 'Legacy recover index', null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['legacy_recover_page', legacyRecoverDocId, 1, null, 'legacy-recovered-token legacy-recovered-token', null, 'completed', 'pending', now],
    )
    search.reindexDocument(legacyRecoverDocId)
    database.run(
      "UPDATE search_index_status SET status = 'queued', source_hash = '', segment_count = 0, indexed_at = NULL WHERE doc_id = ?",
      [legacyRecoverDocId],
    )
    const legacyRecoveredResponse = search.querySearchV2('legacy-recovered-token', { docIds: [legacyRecoverDocId], limit: 80, exhaustive: true })
    const legacyRecoveredStatus = search.getSearchIndexStatus(legacyRecoverDocId)[0]
    assert.strictEqual(legacyRecoveredResponse.totalDocuments, 1)
    assert.strictEqual(legacyRecoveredStatus?.status, 'ready')
    assert.ok(String(legacyRecoveredStatus?.source_hash || '').startsWith('legacy-existing-index:'))
    assert.ok(Number(legacyRecoveredStatus?.segment_count || 0) > 0)

    const realStaleDocId = 'real_stale_doc'
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [realStaleDocId, 'Real stale index', null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['real_stale_page', realStaleDocId, 1, null, 'real-stale-old-token', null, 'completed', 'pending', now],
    )
    search.reindexDocument(realStaleDocId)
    database.run('UPDATE pages SET ocr_text = ? WHERE id = ?', ['real-stale-new-token', 'real_stale_page'])
    database.run(
      "UPDATE search_index_status SET status = 'queued', source_hash = '', segment_count = 0, indexed_at = NULL WHERE doc_id = ?",
      [realStaleDocId],
    )
    search.querySearchV2('real-stale-old-token', { docIds: [realStaleDocId], limit: 80 })
    assert.strictEqual(search.getSearchIndexStatus(realStaleDocId)[0]?.status, 'queued')

    const legacySegmentDocId = 'legacy_segment_only_doc'
    const modernSegmentDocId = 'modern_segment_doc'
    for (const [docId, title] of [[legacySegmentDocId, 'Legacy segment-only index'], [modernSegmentDocId, 'Modern segment index']]) {
      database.run(
        `INSERT INTO documents (
          id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
          ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [docId, title, null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
      )
      database.run(
        'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`${docId}_page`, docId, 1, null, 'zz appears once', null, 'completed', 'pending', now],
      )
      search.reindexDocument(docId)
    }
    database.run('DELETE FROM search_ngram_index WHERE doc_id = ?', [legacySegmentDocId])
    database.run(
      `INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
       SELECT 'delete', rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
       FROM search_index_segments
       WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
      [legacySegmentDocId],
    )
    const mixedLegacyResponse = search.querySearchV2('zz', { docIds: [legacySegmentDocId, modernSegmentDocId], limit: 80 })
    assert.strictEqual(mixedLegacyResponse.totalDocuments, 2)
    assert.deepStrictEqual(
      mixedLegacyResponse.groups.map((group) => group.docId).sort(),
      [legacySegmentDocId, modernSegmentDocId].sort(),
    )

    const missingTrigramDocId = 'missing_trigram_doc'
    const presentTrigramDocId = 'present_trigram_doc'
    for (const [docId, title] of [[missingTrigramDocId, 'Missing trigram coverage'], [presentTrigramDocId, 'Present trigram coverage']]) {
      database.run(
        `INSERT INTO documents (
          id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
          ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [docId, title, null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
      )
      database.run(
        'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`${docId}_page`, docId, 1, null, 'partial-trigram-token appears once', null, 'completed', 'pending', now],
      )
      search.reindexDocument(docId)
    }
    database.run(
      `INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)
       SELECT 'delete', rowid, COALESCE(normalized_text, text, '')
       FROM search_index_segments
       WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
      [missingTrigramDocId],
    )
    const partialTrigramResponse = search.querySearchV2('partial-trigram-token', { docIds: [missingTrigramDocId, presentTrigramDocId], limit: 80 })
    assert.deepStrictEqual(
      partialTrigramResponse.groups.map((group) => group.docId).sort(),
      [missingTrigramDocId, presentTrigramDocId].sort(),
      'Expected missing trigram coverage to fall back to verified text scan without dropping hits',
    )

    const singleCharDocId = 'single_char_doc'
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [singleCharDocId, 'Single char search', null, null, null, 'test', null, null, 2, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['single_char_page_1', singleCharDocId, 1, null, '\u77f3\u77f3\u5c71\u77f3 \u6c34\u571f\u6728', null, 'completed', 'pending', now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['single_char_page_2', singleCharDocId, 2, null, '\u6ca1\u6709\u76ee\u6807\u5b57', null, 'completed', 'pending', now],
    )
    const singleReindex = search.reindexDocument(singleCharDocId)
    assert.strictEqual(singleReindex.status, 'ready')
    const singlePosting = database.queryOne('SELECT COUNT(*) as count, SUM(hit_count) as hits FROM search_ngram_index WHERE doc_id = ? AND gram = ?', [singleCharDocId, '\u77f3'])
    assert.strictEqual(singlePosting?.count, 0)
    assert.strictEqual(singlePosting?.hits, null)
    const singleResponse = search.querySearchV2('\u77f3', { docIds: [singleCharDocId], limit: 80, exhaustive: true })
    assert.strictEqual(singleResponse.totalDocuments, 1)
    assert.strictEqual(singleResponse.totalHits, 3)

    const duplicateSourceDocId = 'duplicate_source_doc'
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [duplicateSourceDocId, 'Duplicate OCR sources', null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'duplicate_source_page',
        duplicateSourceDocId,
        1,
        null,
        '\u9875\u7801\u4e00\n\u660e\u592a\u7956\u521b\u5efa\u5236\u5ea6\n\u7fa4\u81e3\u8bba\u660e\u592a\u7956\u529f\u4e1a\n\u540e\u4e16\u79f0\u8ff0\u660e\u592a\u7956',
        JSON.stringify({
          source_type: 'ocr_layout',
          layout_result: [
            { text: '\u660e\u592a\u7956\u521b\u5efa\u5236\u5ea6', reading_order: 1 },
            { text: '\u7fa4\u81e3\u8bba\u660e\u592a\u7956\u529f\u4e1a', reading_order: 2 },
            { text: '\u540e\u4e16\u79f0\u8ff0\u660e\u592a\u7956', reading_order: 3 },
          ],
        }),
        null,
        'completed',
        'pending',
        now,
      ],
    )
    search.reindexDocument(duplicateSourceDocId)
    const duplicateSourceResponse = search.querySearchV2('\u660e\u592a\u7956', { docIds: [duplicateSourceDocId], limit: 80, exhaustive: true, resultMode: 'all' })
    assert.strictEqual(duplicateSourceResponse.totalDocuments, 1)
    assert.strictEqual(duplicateSourceResponse.totalHits, 3)
    assert.strictEqual(duplicateSourceResponse.groups[0].hits.length, 3)

    for (let index = 0; index < 60; index += 1) {
      const docId = `bulk_doc_${index}`
      const pageId = `bulk_page_${index}`
      database.run(
        `INSERT INTO documents (
          id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
          ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [docId, `Bulk ${index}`, null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
      )
      const repeatedText = Array.from({ length: 80 }, (_, itemIndex) => (
        itemIndex % 17 === 0 ? `bulk-cache-keyword ${index}-${itemIndex}` : `ordinary text ${index}-${itemIndex}`
      )).join(' ')
      database.run(
        'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [pageId, docId, 1, null, repeatedText, null, 'completed', 'pending', now],
      )
      search.reindexDocument(docId)
    }

    const uncachedStartedAt = Date.now()
    const uncachedBulkResponse = search.querySearchV2('bulk-cache-keyword', { limit: 80 })
    const uncachedDuration = Date.now() - uncachedStartedAt
    const cachedStartedAt = Date.now()
    const cachedBulkResponse = search.querySearchV2('bulk-cache-keyword', { limit: 80 })
    const cachedDuration = Date.now() - cachedStartedAt
    assert.strictEqual(cachedBulkResponse.totalHits, uncachedBulkResponse.totalHits)
    assert.ok(cachedDuration <= Math.max(uncachedDuration, 15), `Expected cached search to stay fast, uncached=${uncachedDuration}ms cached=${cachedDuration}ms`)

    const heavyDocId = 'heavy_doc'
    const heavyPageId = 'heavy_page'
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [heavyDocId, 'Heavy hits', null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [heavyPageId, heavyDocId, 1, null, Array.from({ length: 180 }, (_, index) => `dense-hit-${index}`).join(' '), null, 'completed', 'pending', now],
    )
    search.reindexDocument(heavyDocId)
    const previewHeavy = search.querySearchV2('dense-hit', { docIds: [heavyDocId], limit: 80, exhaustive: true })
    const allHeavy = search.querySearchV2('dense-hit', { docIds: [heavyDocId], limit: 80, exhaustive: true, resultMode: 'all' })
    assert.strictEqual(previewHeavy.totalHits, 180)
    assert.strictEqual(previewHeavy.groups[0].totalHits, 180)
    assert.ok(previewHeavy.groups[0].hits.length < previewHeavy.groups[0].totalHits, 'Expected preview search to avoid materializing all hits')
    assert.ok(previewHeavy.groups[0].topHits.length <= 3)
    assert.strictEqual(
      new Set(previewHeavy.groups[0].topHits.map((hit) => String(hit.snippet || '').replace(/<</g, '').replace(/>>/g, '').replace(/\s+/g, ''))).size,
      previewHeavy.groups[0].topHits.length,
      'Expected preview top hits to avoid repeated identical snippets',
    )
    assert.strictEqual(
      new Set(previewHeavy.groups[0].hits.map((hit) => hit.locator.segmentId)).size,
      previewHeavy.groups[0].hits.length,
      'Expected preview hits to show at most one snippet per source segment',
    )
    assert.strictEqual(allHeavy.groups[0].hits.length, 180)

    search.markSearchIndexStaleForDocuments([heavyDocId])
    const fallbackSession = search.getDocumentSearchHits(heavyDocId, 'dense-hit', { limit: 5000 })
    assert.strictEqual(fallbackSession.status, 'ready')
    assert.strictEqual(fallbackSession.hits.length, 180)
    const hitPage1 = search.getDocumentSearchHitPage(heavyDocId, 'dense-hit', { page: 1, pageSize: 10 })
    const hitPage2 = search.getDocumentSearchHitPage(heavyDocId, 'dense-hit', { page: 2, pageSize: 10 })
    assert.strictEqual(hitPage1.docId, heavyDocId)
    assert.strictEqual(hitPage1.query, 'dense-hit')
    assert.strictEqual(hitPage1.status, 'ready')
    assert.strictEqual(hitPage1.totalHits, 180)
    assert.strictEqual(hitPage1.page, 1)
    assert.strictEqual(hitPage1.pageSize, 10)
    assert.strictEqual(hitPage1.totalPages, 18)
    assert.strictEqual(hitPage1.hits.length, 10)
    assert.strictEqual(hitPage2.totalHits, 180)
    assert.strictEqual(hitPage2.page, 2)
    assert.strictEqual(hitPage2.hits.length, 10)
    assert.ok(hitPage1.hits[0].locator)
    assert.ok(hitPage2.hits[0].locator)
    assert.notStrictEqual(hitPage1.hits[0].id, hitPage2.hits[0].id)
    assert.ok(hitPage2.hits[0].locator.charStart > hitPage1.hits[hitPage1.hits.length - 1].locator.charStart)
    const oversizedHitPage = search.getDocumentSearchHitPage(heavyDocId, 'dense-hit', { page: 99, pageSize: 500 })
    assert.strictEqual(oversizedHitPage.pageSize, 100)
    assert.strictEqual(oversizedHitPage.page, 2)
    assert.strictEqual(oversizedHitPage.totalPages, 2)
    assert.strictEqual(oversizedHitPage.hits.length, 80)

    const shortDocIds = ['short_doc_a', 'short_doc_b', 'short_doc_c']
    shortDocIds.forEach((docId, index) => {
      database.run(
        `INSERT INTO documents (
          id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
          ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [docId, `Short keyword ${index}`, null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
      )
      database.run(
        'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`short_page_${index}`, docId, 1, null, index === 0 ? '儿童 儿童 儿童' : index === 1 ? '这里有儿童教育，也有普通儿字。' : '只有儿字，没有完整目标词。', null, 'completed', 'pending', now],
      )
      search.reindexDocument(docId)
    })
    database.run('UPDATE pages SET ocr_text = ? WHERE id = ?', ['鍎跨 鍎跨 changed after index', 'short_page_0'])
    search.markSearchIndexStaleForDocuments(['short_doc_a'])
    const shortPreview = search.querySearchV2('儿童', { docIds: shortDocIds, limit: 80 })
    assert.strictEqual(shortPreview.totalDocuments, 2)
    assert.deepStrictEqual(
      shortPreview.groups.map((group) => [group.docId, group.totalHits]).sort(),
      [['short_doc_a', 3], ['short_doc_b', 1]],
    )
    assert.ok(shortPreview.warnings.some((item) => item.includes('已有索引')), 'Expected stale indexed result warning')

    const recallFolderId = 'recall_folder'
    const recallTagId = 'recall_tag'
    database.run(
      'INSERT INTO folders (id, name, parent_id, external_path, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [recallFolderId, 'Recall folder', null, null, 'folder', null, 1, now, now],
    )
    database.run(
      'INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [recallTagId, 'Recall tag', '#1890ff', now, now],
    )

    const staleRecallDocId = 'stale_recall_doc'
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [staleRecallDocId, 'Stale recall target', null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['stale_recall_page', staleRecallDocId, 1, null, 'stale-global-token appears only after stale fallback', null, 'completed', 'pending', now],
    )
    database.run('INSERT INTO document_folders (doc_id, folder_id) VALUES (?, ?)', [staleRecallDocId, recallFolderId])
    search.markSearchIndexStaleForDocuments([staleRecallDocId])
    const staleGlobalResponse = search.querySearchV2('stale-global-token', { limit: 80 })
    assert.ok(staleGlobalResponse.groups.some((group) => group.docId === staleRecallDocId), 'Expected unfiltered search to use page fallback for stale documents')
    const staleFolderResponse = search.querySearchV2('stale-global-token', { folderIds: [recallFolderId], limit: 80 })
    assert.deepStrictEqual(staleFolderResponse.groups.map((group) => group.docId), [staleRecallDocId])

    const shortRecallDocIds = []
    for (let index = 0; index < 260; index += 1) {
      const docId = `short_recall_doc_${index}`
      shortRecallDocIds.push(docId)
      database.run(
        `INSERT INTO documents (
          id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
          ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [docId, `Short recall ${index}`, null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
      )
      database.run(
        'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`short_recall_page_${index}`, docId, 1, null, index === 259 ? 'low-hit book also has 火' : `火 ${Array.from({ length: 8 }, (_, n) => `hot_${index}_${n}`).join(' 火 ')}`, null, 'completed', 'pending', now],
      )
      search.reindexDocument(docId)
    }
    const shortRecallResponse = search.querySearchV2('火', { docIds: shortRecallDocIds, limit: 300, resultMode: 'all' })
    assert.ok(shortRecallResponse.groups.some((group) => group.docId === 'short_recall_doc_259'), 'Expected short keyword recall not to drop low-hit matching documents')

    const longRecallDocIds = []
    for (let index = 0; index < 1300; index += 1) {
      const paddedIndex = String(index).padStart(4, '0')
      const docId = `long_recall_doc_${paddedIndex}`
      longRecallDocIds.push(docId)
      database.run(
        `INSERT INTO documents (
          id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
          ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [docId, `Long recall ${index}`, null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
      )
      const text = index === 1299
        ? 'abcxyz phrase appears here'
        : `abc bcx cxy xyz filler ${index}`
      database.run(
        'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`long_recall_page_${index}`, docId, 1, null, text, null, 'completed', 'pending', now],
      )
      search.reindexDocument(docId)
    }
    const longRecallResponse = search.querySearchV2('abcxyz', { limit: 80, resultMode: 'all' })
    assert.ok(longRecallResponse.groups.some((group) => group.docId === 'long_recall_doc_1299'), 'Expected exact phrase supplement to recover long queries beyond ngram candidate limits')

    database.run('INSERT INTO document_tags (doc_id, tag_id, created_at, updated_at) VALUES (?, ?, ?, ?)', ['long_recall_doc_1299', recallTagId, now, now])
    database.run('INSERT INTO document_folders (doc_id, folder_id) VALUES (?, ?)', ['long_recall_doc_1299', recallFolderId])
    const scopedDocResponse = search.querySearchV2('abcxyz', { docIds: ['long_recall_doc_0000'], limit: 80 })
    assert.strictEqual(scopedDocResponse.totalDocuments, 0)
    const scopedFolderResponse = search.querySearchV2('abcxyz', { folderIds: [recallFolderId], limit: 80 })
    assert.deepStrictEqual(scopedFolderResponse.groups.map((group) => group.docId), ['long_recall_doc_1299'])
    const scopedTagResponse = search.querySearchV2('abcxyz', { tagIds: [recallTagId], limit: 80 })
    assert.deepStrictEqual(scopedTagResponse.groups.map((group) => group.docId), ['long_recall_doc_1299'])

    const paginationDocIds = []
    for (let index = 0; index < 27; index += 1) {
      const paddedIndex = String(index).padStart(2, '0')
      const docId = `pagination_doc_${paddedIndex}`
      paginationDocIds.push(docId)
      database.run(
        `INSERT INTO documents (
          id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
          ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [docId, `Pagination ${paddedIndex}`, null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
      )
      database.run(
        'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`pagination_page_${paddedIndex}`, docId, 1, null, `pagination-token appears once in document ${paddedIndex}`, null, 'completed', 'pending', now],
      )
      if (index < 12) {
        database.run('INSERT INTO document_folders (doc_id, folder_id) VALUES (?, ?)', [docId, recallFolderId])
      }
      if (index < 7) {
        database.run('INSERT INTO document_tags (doc_id, tag_id, created_at, updated_at) VALUES (?, ?, ?, ?)', [docId, recallTagId, now, now])
      }
      search.reindexDocument(docId)
    }

    const paginationPage1 = search.querySearchV2('pagination-token', { limit: 200, page: 1, pageSize: 10 })
    const paginationPage2 = search.querySearchV2('pagination-token', { limit: 200, page: 2, pageSize: 10 })
    const paginationPage3 = search.querySearchV2('pagination-token', { limit: 200, page: 3, pageSize: 10 })
    for (const pageResponse of [paginationPage1, paginationPage2, paginationPage3]) {
      assert.strictEqual(pageResponse.totalDocuments, 27)
      assert.strictEqual(pageResponse.totalHits, 27)
      assert.strictEqual(pageResponse.pageSize, 10)
      assert.strictEqual(pageResponse.totalPages, 3)
    }
    assert.strictEqual(paginationPage1.page, 1)
    assert.strictEqual(paginationPage2.page, 2)
    assert.strictEqual(paginationPage3.page, 3)
    assert.strictEqual(paginationPage1.groups.length, 10)
    assert.strictEqual(paginationPage2.groups.length, 10)
    assert.strictEqual(paginationPage3.groups.length, 7)
    const pagedDocIds = [paginationPage1, paginationPage2, paginationPage3]
      .flatMap((pageResponse) => pageResponse.groups.map((group) => group.docId))
    assert.strictEqual(new Set(pagedDocIds).size, 27)
    assert.deepStrictEqual([...new Set(pagedDocIds)].sort(), paginationDocIds.sort())

    const folderPage1 = search.querySearchV2('pagination-token', { folderIds: [recallFolderId], limit: 200, page: 1, pageSize: 10 })
    const folderPage2 = search.querySearchV2('pagination-token', { folderIds: [recallFolderId], limit: 200, page: 2, pageSize: 10 })
    assert.strictEqual(folderPage1.totalDocuments, 12)
    assert.strictEqual(folderPage1.totalHits, 12)
    assert.strictEqual(folderPage1.totalPages, 2)
    assert.strictEqual(folderPage1.groups.length, 10)
    assert.strictEqual(folderPage2.totalDocuments, 12)
    assert.strictEqual(folderPage2.totalHits, 12)
    assert.strictEqual(folderPage2.page, 2)
    assert.strictEqual(folderPage2.groups.length, 2)
    assert.ok([...folderPage1.groups, ...folderPage2.groups].every((group) => paginationDocIds.slice(0, 12).includes(group.docId)))

    const tagPage = search.querySearchV2('pagination-token', { tagIds: [recallTagId], limit: 200, page: 1, pageSize: 10 })
    assert.strictEqual(tagPage.totalDocuments, 7)
    assert.strictEqual(tagPage.totalHits, 7)
    assert.strictEqual(tagPage.totalPages, 1)
    assert.strictEqual(tagPage.groups.length, 7)
    assert.ok(tagPage.groups.every((group) => paginationDocIds.slice(0, 7).includes(group.docId)))

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
    app.quit()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.quit()
    process.exit(1)
  })
