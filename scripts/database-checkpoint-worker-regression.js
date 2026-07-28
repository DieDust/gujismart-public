const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const Database = require('better-sqlite3')
const { buildSync } = require('esbuild')

const root = join(__dirname, '..')
const tempRoot = mkdtempSync(join(__dirname, '.tmp-checkpoint-worker-'))
const databasePath = join(tempRoot, 'checkpoint.db')
const clientEntryPath = join(tempRoot, 'checkpoint-client-entry.js')
const clientBundlePath = join(tempRoot, 'checkpoint-client.cjs')
const workerBundlePath = join(tempRoot, 'database-diagnostics-worker.js')

writeFileSync(
  clientEntryPath,
  `module.exports = require(${JSON.stringify(join(root, 'src', 'main', 'database-diagnostics-worker-client.ts'))})`,
)

buildSync({
  entryPoints: [clientEntryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: clientBundlePath,
  logLevel: 'silent',
})

buildSync({
  entryPoints: [join(root, 'src', 'main', 'database-diagnostics-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: workerBundlePath,
  external: ['better-sqlite3'],
  logLevel: 'silent',
})

async function run() {
  let sqlite
  let client
  try {
    await app.whenReady()
    sqlite = new Database(databasePath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('wal_autocheckpoint = 0')
    sqlite.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
    const insert = sqlite.prepare('INSERT INTO fixture (payload) VALUES (?)')
    sqlite.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(`checkpoint-worker-${index}-${'x'.repeat(256)}`)
      }
    })()

    client = require(clientBundlePath)
    assert.strictEqual(client.isDatabaseDiagnosticsWorkerAvailable(), true)
    const result = await client.runDatabaseCheckpointWorkerTask({
      dbFilePath: databasePath,
      mode: 'PASSIVE',
    })
    assert.strictEqual(result.busy, 0)
    assert(result.logFrames > 0, `expected WAL frames, saw ${JSON.stringify(result)}`)
    assert(result.checkpointedFrames > 0, `expected checkpoint progress, saw ${JSON.stringify(result)}`)
    console.log(
      `Database checkpoint worker regression passed (frames ${result.checkpointedFrames}/${result.logFrames}).`,
    )
  } finally {
    if (client) await client.shutdownDatabaseDiagnosticsWorkers()
    sqlite?.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
  app.quit()
}

run().catch((error) => {
  console.error(error)
  app.exit(1)
})
