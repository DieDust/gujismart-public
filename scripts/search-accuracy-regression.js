const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const fixture = require('./fixtures/search-accuracy-cases.json')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-search-accuracy-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'search-accuracy-bundle.cjs')
const entryPath = join(tempRoot, 'search-accuracy-entry.js')

process.env.GUJISMART_DATA_DIR = tempDataDir
process.env.GUJISMART_AUTO_REINDEX = '0'

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
    [
      doc.id,
      doc.title,
      doc.author || null,
      null,
      null,
      doc.docType || 'test-fixture',
      null,
      null,
      doc.pages.length,
      'completed',
      'pending',
      'processed',
      'pending',
      '{}',
      now,
      now,
    ],
  )

  for (const page of doc.pages) {
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        page.id,
        doc.id,
        page.pageNum,
        null,
        page.text,
        null,
        'completed',
        'pending',
        now,
      ],
    )
  }
}

function createRepeatedTargetText(targetChar, count, seed) {
  const chunks = []
  for (let index = 0; index < count; index += 1) {
    chunks.push(`${seed}段${index + 1}${targetChar}。`)
  }
  return chunks.length > 0
    ? chunks.join(indexedSeparator(seed))
    : `${seed}段没有目标字，只用于确认单字检索不会误报。`
}

function indexedSeparator(seed) {
  return `\n${seed}分隔。`
}

function createSingleCharacterCountDocuments() {
  const targetChar = '鼎'
  const counts = [0, 1, 2, 5, 12, 31, 80, 137]
  const documents = counts.map((count, index) => {
    const docId = `accuracy_single_count_doc_${index}`
    const firstPageCount = Math.floor(count / 2)
    const secondPageCount = count - firstPageCount
    return {
      id: docId,
      title: `Single count ${index}`,
      author: 'GujiSmart QA',
      docType: 'test-fixture',
      expectedTargetCount: count,
      pages: [
        {
          id: `${docId}_page_1`,
          pageNum: 1,
          text: createRepeatedTargetText(targetChar, firstPageCount, `甲${index}`),
        },
        {
          id: `${docId}_page_2`,
          pageNum: 2,
          text: createRepeatedTargetText(targetChar, secondPageCount, `乙${index}`),
        },
      ],
    }
  })
  return { targetChar, documents }
}

function groupHitsByDoc(response) {
  return Object.fromEntries(
    response.groups
      .map((group) => [group.docId, group.totalHits])
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function assertCase(search, docIds, testCase) {
  const allResponse = search.querySearchV2(testCase.query, {
    docIds,
    limit: 1000,
    exhaustive: true,
    resultMode: 'all',
    sort: 'title',
  })
  const label = `[search accuracy: ${testCase.name}] ${testCase.query}`

  assert.strictEqual(allResponse.totalDocuments, testCase.expectedTotalDocuments, `${label} all-mode document count`)
  assert.strictEqual(allResponse.totalHits, testCase.expectedTotalHits, `${label} all-mode hit count`)
  assert.deepStrictEqual(groupHitsByDoc(allResponse), testCase.expectedHitsByDoc, `${label} all-mode hits by document`)

  for (const group of allResponse.groups) {
    assert.strictEqual(group.hits.length, group.totalHits, `${label} should materialize every hit in all mode for ${group.docId}`)
    for (const hit of group.hits) {
      assert.ok(hit.snippet.includes('<<') && hit.snippet.includes('>>'), `${label} hit snippet should mark the matched text`)
      assert.strictEqual(hit.locator.queryTerm, testCase.query, `${label} locator should preserve the active query`)
    }
  }

  const previewResponse = search.querySearchV2(testCase.query, {
    docIds,
    limit: 1000,
    page: 1,
    pageSize: 20,
    sort: 'title',
  })
  assert.strictEqual(previewResponse.totalDocuments, testCase.expectedTotalDocuments, `${label} preview document count`)
  assert.strictEqual(previewResponse.totalHits, testCase.expectedTotalHits, `${label} preview hit count`)
  assert.deepStrictEqual(groupHitsByDoc(previewResponse), testCase.expectedHitsByDoc, `${label} preview hits by document`)
}

function clearSearchIndexForDocuments(database, search, docIds) {
  for (const docId of docIds) {
    database.run(
      `INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
       SELECT 'delete', rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
       FROM search_index_segments
       WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
      [docId],
    )
    database.run(
      `INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)
       SELECT 'delete', rowid, COALESCE(normalized_text, text, '')
       FROM search_index_segments
       WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
      [docId],
    )
    database.run('DELETE FROM search_ngram_index WHERE doc_id = ?', [docId])
    database.run('DELETE FROM search_index_segments WHERE doc_id = ?', [docId])
    database.run(
      "UPDATE search_index_status SET status = 'queued', source_hash = '', segment_count = 0, indexed_at = NULL WHERE doc_id = ?",
      [docId],
    )
  }
  search.notifySearchContentChanged()
}

function assertSingleCharacterFallback(search, docIds) {
  for (const testCase of fixture.cases.filter((item) => item.name.startsWith('single-character'))) {
    assertCase(search, docIds, {
      ...testCase,
      name: `${testCase.name}-no-index-fallback`,
    })
  }
}

function assertSingleCharacterCountMatrix(search, countDocIds, targetChar, expectedHitsByDoc, phase) {
  const expectedTotalHits = Object.values(expectedHitsByDoc).reduce((sum, count) => sum + count, 0)
  const expectedDocumentHits = Object.fromEntries(
    Object.entries(expectedHitsByDoc).filter(([, count]) => count > 0),
  )
  const response = search.querySearchV2(targetChar, {
    docIds: countDocIds,
    limit: 1000,
    exhaustive: true,
    resultMode: 'all',
    sort: 'title',
  })
  assert.strictEqual(response.totalDocuments, Object.keys(expectedDocumentHits).length, `[single-char count matrix:${phase}] document count`)
  assert.strictEqual(response.totalHits, expectedTotalHits, `[single-char count matrix:${phase}] total hit count`)
  assert.deepStrictEqual(groupHitsByDoc(response), expectedDocumentHits, `[single-char count matrix:${phase}] hits by document`)

  const previewResponse = search.querySearchV2(targetChar, {
    docIds: countDocIds,
    limit: 1000,
    page: 1,
    pageSize: 20,
    sort: 'title',
  })
  assert.strictEqual(previewResponse.totalDocuments, Object.keys(expectedDocumentHits).length, `[single-char count matrix:${phase}] preview document count`)
  assert.strictEqual(previewResponse.totalHits, expectedTotalHits, `[single-char count matrix:${phase}] preview total hit count`)
  assert.deepStrictEqual(groupHitsByDoc(previewResponse), expectedDocumentHits, `[single-char count matrix:${phase}] preview hits by document`)

  for (const group of response.groups) {
    assert.strictEqual(group.hits.length, group.totalHits, `[single-char count matrix:${phase}] materialized hit count for ${group.docId}`)
    for (const hit of group.hits) {
      assert.strictEqual(hit.locator.queryTerm, targetChar, `[single-char count matrix:${phase}] locator query for ${group.docId}`)
      assert.ok(hit.snippet.includes(`<<${targetChar}>>`), `[single-char count matrix:${phase}] snippet should mark ${targetChar}`)
    }
  }

  return {
    targetChar,
    expectedTotalHits,
    actualTotalHits: response.totalHits,
    expectedHitsByDoc,
    actualHitsByDoc: groupHitsByDoc(response),
  }
}

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    const search = modules.search
    await database.initDatabase()

    const now = new Date().toISOString()
    for (const doc of fixture.documents) {
      insertDocument(database, doc, now)
    }
    const countMatrix = createSingleCharacterCountDocuments()
    for (const doc of countMatrix.documents) {
      insertDocument(database, doc, now)
    }

    const docIds = fixture.documents.map((doc) => doc.id)
    const countDocIds = countMatrix.documents.map((doc) => doc.id)
    const expectedCountHitsByDoc = Object.fromEntries(
      countMatrix.documents.map((doc) => [doc.id, doc.expectedTargetCount]),
    )
    for (const docId of docIds) {
      const result = search.reindexDocument(docId)
      assert.strictEqual(result.status, 'ready', `Expected ${docId} to be indexed`)
      assert.ok(result.segmentCount > 0, `Expected ${docId} to create search segments`)
    }
    for (const docId of countDocIds) {
      const result = search.reindexDocument(docId)
      assert.strictEqual(result.status, 'ready', `Expected ${docId} to be indexed`)
      assert.ok(result.segmentCount > 0, `Expected ${docId} to create search segments`)
    }

    for (const testCase of fixture.cases) {
      assertCase(search, docIds, testCase)
    }
    const matrixReports = [
      assertSingleCharacterCountMatrix(search, countDocIds, countMatrix.targetChar, expectedCountHitsByDoc, 'indexed'),
    ]

    clearSearchIndexForDocuments(database, search, docIds)
    clearSearchIndexForDocuments(database, search, countDocIds)
    assertSingleCharacterFallback(search, docIds)
    matrixReports.push(assertSingleCharacterCountMatrix(search, countDocIds, countMatrix.targetChar, expectedCountHitsByDoc, 'no-index-fallback'))

    for (const docId of [...docIds, ...countDocIds]) {
      const result = search.reindexDocument(docId)
      assert.strictEqual(result.status, 'ready', `Expected ${docId} to be reindexed`)
      assert.ok(result.segmentCount > 0, `Expected ${docId} to recreate search segments`)
    }

    for (const testCase of fixture.cases) {
      assertCase(search, docIds, {
        ...testCase,
        name: `${testCase.name}-after-reindex`,
      })
    }
    matrixReports.push(assertSingleCharacterCountMatrix(search, countDocIds, countMatrix.targetChar, expectedCountHitsByDoc, 'after-reindex'))

    console.log(`Single-character count matrix (${countMatrix.targetChar})`)
    for (const report of matrixReports) {
      console.log(`- ${report.actualTotalHits}/${report.expectedTotalHits} hits matched: ${JSON.stringify(report.actualHitsByDoc)}`)
    }

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
    console.log('Search accuracy regression passed.')
    app.quit()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.quit()
    process.exit(1)
  })
