const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-mcp-tools-'))
const dataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'mcp-tools-bundle.cjs')
const entryPath = join(tempRoot, 'entry.js')

process.env.GUJISMART_DATA_DIR = dataDir

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const tools = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'mcp', 'library-tools.ts'))})
  module.exports = { database, tools }
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

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    const { tools } = modules
    await database.initDatabase()

    const stats = await tools.callLibraryTool('library_stats', {})
    assert.strictEqual(stats.ok, true)
    assert.ok(typeof stats.documents === 'number')

    const list = await tools.callLibraryTool('list_documents', { limit: 5 })
    assert.strictEqual(list.ok, true)
    assert.ok(Array.isArray(list.items))

    const search = await tools.callLibraryTool('library_search', { query: 'test', limit: 5 })
    assert.strictEqual(search.ok, true)
    assert.ok(Array.isArray(search.groups))
    assert.strictEqual(search.detail, 'compact')
    // Compact mode must not dump full locator/hash blobs into default hits.
    for (const group of search.groups) {
      for (const hit of group.hits || []) {
        assert.ok(hit.ref && hit.ref.docId, 'compact hit should include ref.docId')
        assert.strictEqual(hit.locator, undefined)
        assert.strictEqual(hit.stableLocator, undefined)
        assert.ok(!('sourceHash' in hit), 'compact hit should omit sourceHash')
      }
    }

    const searchFull = await tools.callLibraryTool('library_search', { query: 'test', limit: 3, detail: 'full' })
    assert.strictEqual(searchFull.ok, true)
    assert.strictEqual(searchFull.detail, 'full')

    const folders = await tools.callLibraryTool('list_folders', {})
    assert.strictEqual(folders.ok, true)

    // Seed one document with TOC, tags and an excerpt to exercise the AI-facing tools.
    const projectId = String(
      database.queryOne("SELECT value FROM settings WHERE key = 'active_library_project_id'")?.value
      || database.queryOne('SELECT id FROM library_projects ORDER BY is_default DESC, created_at ASC LIMIT 1')?.id,
    )
    assert.ok(projectId, 'active library project must exist after initDatabase')
    const now = new Date().toISOString()
    const docId = 'doc-mcp-1'
    database.run(
      `INSERT INTO documents (id, library_project_id, title, author, dynasty, source, doc_type, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docId,
        projectId,
        '测试文献',
        '测试作者',
        '清',
        '测试丛书',
        'ancient_book',
        JSON.stringify({
          publisher: '测试出版社',
          keywords: ['货币', '物价'],
          pdf_sha256: 'internal-fingerprint',
          ebook_manifest: { spine: [] },
        }),
        now,
        now,
      ],
    )
    database.run(
      'INSERT OR IGNORE INTO library_project_documents (project_id, document_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [projectId, docId, now, now],
    )
    database.run(
      'INSERT INTO tags (id, library_project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['tag-mcp-meta', projectId, '测试作者', now, now],
    )
    database.run(
      'INSERT INTO document_tags (doc_id, tag_id, is_manual, is_metadata, source_field, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?, ?)',
      [docId, 'tag-mcp-meta', 'author', now, now],
    )
    database.run(
      `INSERT INTO document_toc_items (id, doc_id, title, level, order_index, source_page_num, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['toc-mcp-1', docId, '卷一', 1, 0, 3, 'active', now, now],
    )
    database.run(
      `INSERT INTO document_toc_items (id, doc_id, title, level, order_index, source_page_num, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['toc-mcp-2', docId, '废弃条目', 1, 1, 9, 'rejected', now, now],
    )
    database.run(
      `INSERT INTO research_notes (id, library_project_id, doc_id, page_num, excerpt, note, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['note-mcp-1', projectId, docId, 3, '这是一段用户摘录的正文', '这是用户批注', 'quote', now, now],
    )

    const documentResult = await tools.callLibraryTool('get_document', { docId })
    assert.strictEqual(documentResult.ok, true)
    assert.strictEqual(documentResult.document.metadata.publisher, '测试出版社')
    assert.deepStrictEqual(documentResult.document.metadata.keywords, ['货币', '物价'])
    assert.ok(!('pdf_sha256' in documentResult.document.metadata), 'internal fingerprint must not leak through metadata')
    assert.ok(!('ebook_manifest' in documentResult.document.metadata), 'internal manifest must not leak through metadata')
    assert.strictEqual(documentResult.document.source, '测试丛书')
    assert.strictEqual(documentResult.document.docType, 'ancient_book')
    const metadataTag = documentResult.document.tags.find((tag) => tag.id === 'tag-mcp-meta')
    assert.ok(metadataTag, 'seeded metadata tag should be returned')
    assert.strictEqual(metadataTag.isMetadata, true)

    const toc = await tools.callLibraryTool('get_document_toc', { docId })
    assert.strictEqual(toc.ok, true)
    assert.strictEqual(toc.totalItems, 1, 'rejected TOC items must be filtered out')
    assert.strictEqual(toc.items[0].title, '卷一')
    assert.strictEqual(toc.items[0].pageNum, 3)

    const tocMissing = await tools.callLibraryTool('get_document_toc', { docId: 'missing-doc' })
    assert.strictEqual(tocMissing.ok, false)
    assert.strictEqual(tocMissing.code, 'not_found')

    const excerpts = await tools.callLibraryTool('list_excerpts', { docId })
    assert.strictEqual(excerpts.ok, true)
    assert.strictEqual(excerpts.total, 1)
    assert.strictEqual(excerpts.items[0].excerpt, '这是一段用户摘录的正文')
    assert.strictEqual(excerpts.items[0].note, '这是用户批注')
    assert.strictEqual(excerpts.items[0].ref.docId, docId)
    assert.strictEqual(excerpts.items[0].ref.pageNum, 3)

    const excerptsFiltered = await tools.callLibraryTool('list_excerpts', { search: '不存在的关键词' })
    assert.strictEqual(excerptsFiltered.ok, true)
    assert.strictEqual(excerptsFiltered.total, 0)

    const unknown = await tools.callLibraryTool('delete_everything', {})
    assert.strictEqual(unknown.ok, false)
    assert.strictEqual(unknown.code, 'unknown_tool')

    console.log('MCP library tools integration regression passed')
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
