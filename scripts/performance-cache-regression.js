const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const { gzipSync } = require('node:zlib')
const { buildSync } = require('esbuild')
const Database = require('better-sqlite3')
process.on('uncaughtException', (error) => { console.error(error); process.exit(1) })
const built = buildSync({
  stdin: { contents: "module.exports = { ...require('./src/main/database-statements.ts'), ...require('./src/main/page-payload-files.ts') }", resolveDir: join(__dirname, '..') },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, mod, mod.exports)
const api = mod.exports
const first = new Database(':memory:')
const second = new Database(':memory:')
const prepare = (sql) => api.prepareCachedStatement(first, sql)
try {
  first.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT)')
  const insert = prepare('INSERT INTO items VALUES (?, ?)')
  insert.run(1, 'old content')
  const query = 'SELECT * FROM items WHERE id = ?'
  assert.equal(prepare(query), prepare(query))
  assert.equal(prepare(query).get(1).text, 'old content')
  prepare('UPDATE items SET text = ? WHERE id = ?').run('complete new content', 1)
  assert.equal(prepare(query).get(1).text, 'complete new content', 'never cache rows')
  assert.throws(() => first.transaction(() => { insert.run(2, 'rollback'); throw new Error('rollback') })(), /rollback/)
  assert.equal(prepare(query).get(2), undefined)
  assert.throws(() => insert.run(1, 'conflict'), /UNIQUE/)
  insert.run(3, 'after conflict')
  assert.equal(prepare(query).get(3).text, 'after conflict')
  first.exec('ALTER TABLE items ADD COLUMN note TEXT')
  assert.equal(prepare(query).get(1).note, null, 'SQLite recompiles cached statements after schema change')
  first.exec('DROP TABLE items; CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT, note TEXT)')
  prepare('INSERT INTO items VALUES (?, ?, ?)').run(1, 'rebuilt', 'new schema')
  assert.equal(prepare(query).get(1).text, 'rebuilt')
  second.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO items VALUES (1, 'other library')")
  assert.equal(api.prepareCachedStatement(second, query).get(1).text, 'other library')
  const select = prepare('SELECT id FROM items')
  for (const row of select.iterate()) {
    assert.notEqual(prepare('SELECT id FROM items'), select, 'do not reuse busy statements')
    assert.equal(row.id, 1)
  }
  const original = prepare(query)
  for (let i = 0; i < 300; i++) prepare(`SELECT ${i}`).get()
  assert.notEqual(prepare(query), original, 'cache eviction is bounded')
  api.clearPreparedStatements(first)
  assert.notEqual(prepare(query), original)
} finally { first.close(); second.close() }

const root = fs.mkdtempSync(join(tmpdir(), 'gujismart-payload-cache-'))
api.setPayloadDataDir(root)
const pathFor = (ref) => join(api.getPayloadRootDir(), ref.replace(/^page-payload:v[12]:/, ''))
const put = (ref, value) => {
  const file = pathFor(ref)
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, gzipSync(JSON.stringify({ version: 1, value })))
}
const legacy = 'page-payload:v1:legacy/page.json.gz'
assert.equal(api.readPagePayloadValue(legacy), null)
put(legacy, 'restored full original text')
assert.equal(api.readPagePayloadValue(legacy), 'restored full original text', 'missing legacy files must be retried after restoration')
const corrupt = 'page-payload:v1:legacy/broken.json.gz'
fs.writeFileSync(pathFor(corrupt), 'invalid gzip')
assert.equal(api.readPagePayloadValue(corrupt), null)
put(corrupt, 'repaired original text')
assert.equal(api.readPagePayloadValue(corrupt), 'repaired original text')
const readFile = fs.readFileSync
let reads = 0
fs.readFileSync = function (file, ...args) { if (String(file).startsWith(root)) reads++; return readFile.call(this, file, ...args) }
try {
  api.invalidatePagePayloadReadCache()
  const large = 'A'.repeat(9 * 1024 * 1024) + 'tail-one'
  const other = 'B'.repeat(9 * 1024 * 1024) + 'tail-two'
  const a = api.buildPagePayloadRef('doc', 'a', 'ocr_text', large)
  const b = api.buildPagePayloadRef('doc', 'b', 'ocr_text', other)
  put(a, large); put(b, other)
  assert.equal(api.readPagePayloadValue(a), large)
  assert.equal(api.readPagePayloadValue(a), large)
  assert.equal(reads, 1)
  assert.equal(api.readPagePayloadValue(b), other)
  assert.equal(api.readPagePayloadValue(a), large)
  assert.equal(reads, 3, 'byte limit must evict before the entry limit')
  const oversized = 'C'.repeat(17 * 1024 * 1024) + 'complete-tail'
  const c = api.buildPagePayloadRef('doc', 'c', 'ocr_text', oversized)
  put(c, oversized)
  assert.equal(api.readPagePayloadValue(c), oversized)
  assert.equal(api.readPagePayloadValue(c), oversized)
  assert.equal(reads, 5, 'oversized payloads remain complete but are not retained')
  api.setPayloadDataDir(join(root, 'other-library'))
  put(legacy, 'other library legacy content')
  assert.equal(api.readPagePayloadValue(legacy), 'other library legacy content')
} finally { fs.readFileSync = readFile }
console.log('Prepared SQL isolation, live results, rollback, schema upgrade, eviction and complete legacy payload recovery passed.')
process.exit(0)
