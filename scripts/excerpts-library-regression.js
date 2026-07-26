const assert = require('assert')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const root = join(__dirname, '..')
const excerptsView = readFileSync(join(root, 'src', 'renderer', 'src', 'views', 'ExcerptsView.tsx'), 'utf8')
const preload = readFileSync(join(root, 'src', 'preload', 'index.ts'), 'utf8')
const researchIpc = readFileSync(join(root, 'src', 'main', 'ipc', 'research.ts'), 'utf8')

assert(
  excerptsView.includes('const EXCERPTS_PAGE_SIZE = 200')
    && excerptsView.includes('window.api.listResearchNotesPage')
    && excerptsView.includes('继续向下滚动加载更多')
    && excerptsView.includes('pagination={false}'),
  'Excerpts view must load 200 notes first and append additional database pages while scrolling.',
)
assert(
  excerptsView.includes('批量删除')
    && excerptsView.includes('全选已加载')
    && excerptsView.includes('window.api.deleteResearchNotes(ids)'),
  'Excerpts view must expose multi-selection and one-shot batch deletion in every view mode.',
)
assert(
  preload.includes("ipcRenderer.invoke('research:listNotesPage', options)")
    && preload.includes("ipcRenderer.invoke('research:deleteNotes', ids)")
    && researchIpc.includes('transaction(() => {'),
  'Paginated listing and atomic batch deletion must stay explicit across preload and main-process contracts.',
)

const tempRoot = mkdtempSync(join(__dirname, '.tmp-excerpts-library-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'excerpts-library-regression-bundle.cjs')
const entryPath = join(tempRoot, 'excerpts-library-regression-entry.js')
const electronStubPath = join(tempRoot, 'electron-stub.js')

process.env.GUJISMART_DATA_DIR = tempDataDir

writeFileSync(electronStubPath, `
  const handlers = new Map()
  exports.__handlers = handlers
  exports.ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    }
  }
  exports.app = {
    getName: () => 'gujismart-test',
    getPath: () => ${JSON.stringify(tempRoot)}
  }
`)

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(root, 'src', 'main', 'database.ts'))})
  const research = require(${JSON.stringify(join(root, 'src', 'main', 'ipc', 'research.ts'))})
  const electron = require('electron')
  module.exports = { database, research, handlers: electron.__handlers }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3'],
  alias: {
    electron: electronStubPath,
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    modules.research.registerResearchIpc()

    const invoke = async (channel, ...args) => {
      const handler = modules.handlers.get(channel)
      if (!handler) throw new Error(`Missing excerpts IPC handler: ${channel}`)
      return handler({}, ...args)
    }

    const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString()
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'doc_excerpts_page',
        '分页摘录测试文献',
        '测试作者',
        null,
        '测试集',
        '古籍',
        null,
        null,
        1,
        'completed',
        'pending',
        'processed',
        'confirmed',
        '{}',
        createdAt,
        createdAt,
      ],
    )

    database.transaction(() => {
      for (let index = 0; index < 205; index += 1) {
        const timestamp = new Date(Date.parse(createdAt) + index * 1000).toISOString()
        database.run(
          `INSERT INTO research_notes (
            id, project_id, doc_id, page_num, excerpt, note, tags, source_type, source_id,
            kind, outline_id, color, locator_json, citation_text, source_hash, sort_order,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `excerpt_page_${String(index).padStart(3, '0')}`,
            null,
            'doc_excerpts_page',
            1,
            `分页摘录 ${index}`,
            index % 3 === 0 ? '分页备注' : '',
            index % 10 === 0 ? '批量 重点' : '批量',
            index % 7 === 0 ? 'manual' : 'search',
            index % 7 === 0 ? JSON.stringify({ sourceType: 'reader' }) : null,
            index % 2 === 0 ? 'quote' : 'comment',
            null,
            index % 2 === 0 ? '#ffe066' : '#74c0fc',
            '',
            '',
            `source_${index}`,
            0,
            timestamp,
            timestamp,
          ],
        )
      }
    })
    database.saveDatabase()

    const firstPage = await invoke('research:listNotesPage')
    assert.strictEqual(firstPage.limit, 200)
    assert.strictEqual(firstPage.offset, 0)
    assert.strictEqual(firstPage.items.length, 200)
    assert.strictEqual(firstPage.total, 205)
    assert.strictEqual(firstPage.stats.total, 205)
    assert.strictEqual(firstPage.stats.documentCount, 1)
    assert.ok(firstPage.stats.tags.includes('重点'))
    assert.deepStrictEqual(firstPage.scopeDocIds, ['doc_excerpts_page'])

    const secondPage = await invoke('research:listNotesPage', { limit: 200, offset: 200 })
    assert.strictEqual(secondPage.items.length, 5)
    assert.strictEqual(new Set([...firstPage.items, ...secondPage.items].map((note) => note.id)).size, 205)

    const searched = await invoke('research:listNotesPage', { search: '分页摘录 204' })
    assert.strictEqual(searched.total, 1)
    assert.strictEqual(searched.items[0]?.excerpt, '分页摘录 204')

    const tagged = await invoke('research:listNotesPage', { tag: '重点' })
    assert.strictEqual(tagged.total, 21)
    assert.ok(tagged.items.every((note) => String(note.tags).includes('重点')))

    const readerNotes = await invoke('research:listNotesPage', { source: 'reader' })
    assert.strictEqual(readerNotes.total, 30)

    const blueNotes = await invoke('research:listNotesPage', {
      search: '蓝色',
      searchColors: ['#74c0fc'],
    })
    assert.strictEqual(blueNotes.total, 102)

    const deleted = await invoke('research:deleteNotes', [
      'excerpt_page_000',
      'excerpt_page_001',
      'missing_excerpt',
      'excerpt_page_001',
    ])
    assert.deepStrictEqual(deleted, { requested: 3, deleted: 2 })
    assert.strictEqual((await invoke('research:listNotesPage')).total, 203)

    assert.strictEqual(await invoke('research:deleteNote', 'excerpt_page_002'), true)
    assert.strictEqual((await invoke('research:listNotes', null)).length, 202)

    console.log('Excerpts pagination and batch deletion regression passed.')
    process.exit(0)
  } finally {
    try {
      database?.closeDatabase?.()
    } catch {
      // ignore cleanup errors
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error('Excerpts pagination and batch deletion regression failed.')
  console.error(error)
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
  process.exit(1)
})
