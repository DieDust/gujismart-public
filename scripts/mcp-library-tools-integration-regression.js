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
