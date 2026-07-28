const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const Database = require('better-sqlite3')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-database-async-busy-'))
const tempDataDir = join(tempRoot, 'data')
const entryPath = join(tempRoot, 'database-entry.js')
const bundlePath = join(tempRoot, 'database-bundle.cjs')

process.env.GUJISMART_DATA_DIR = tempDataDir

writeFileSync(
  entryPath,
  `module.exports = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})`,
)

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function run() {
  let database
  let writer
  let heartbeat = null
  try {
    await app.whenReady()
    database = require(bundlePath)
    await database.initDatabase()

    writer = new Database(database.getDatabaseFilePath())
    writer.pragma('journal_mode = WAL')
    writer.pragma('busy_timeout = 0')
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'async_busy_writer',
      'holding',
    )

    let heartbeatCount = 0
    heartbeat = setInterval(() => {
      heartbeatCount += 1
    }, 25)

    const releaseWriter = wait(450).then(() => {
      writer.exec('COMMIT')
    })
    const startedAt = Date.now()
    await database.runAsync(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['async_busy_retry', 'completed'],
      { maxWaitMs: 5_000 },
    )
    await releaseWriter

    const stored = database.queryOne(
      "SELECT value FROM settings WHERE key = 'async_busy_retry'",
    )
    assert.strictEqual(stored?.value, 'completed')
    assert(
      heartbeatCount >= 2,
      `expected the event loop to make progress during lock retry, saw ${heartbeatCount} heartbeats`,
    )
    assert(
      Date.now() - startedAt < 3_000,
      `expected lock recovery within 3 seconds, took ${Date.now() - startedAt}ms`,
    )
    console.log(
      `Database async busy retry integration regression passed (${heartbeatCount} heartbeats, ${Date.now() - startedAt}ms).`,
    )
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    try {
      if (writer?.inTransaction) writer.exec('ROLLBACK')
    } catch {
      // Best-effort fixture cleanup.
    }
    writer?.close()
    database?.closeDatabase()
    rmSync(tempRoot, { recursive: true, force: true })
  }
  app.quit()
}

run().catch((error) => {
  console.error(error)
  app.exit(1)
})
