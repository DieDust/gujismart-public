const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const Database = require('better-sqlite3')
const { buildSync } = require('esbuild')

const root = join(__dirname, '..')
const tempRoot = mkdtempSync(join(__dirname, '.tmp-lock-diagnostics-'))
const databasePath = join(tempRoot, 'lock-diagnostics.db')
const clientEntryPath = join(tempRoot, 'lock-client-entry.js')
const clientBundlePath = join(tempRoot, 'lock-client.cjs')
const workerBundlePath = join(tempRoot, 'database-diagnostics-worker.js')

writeFileSync(
  clientEntryPath,
  `module.exports = {
    client: require(${JSON.stringify(join(root, 'src', 'main', 'database-diagnostics-worker-client.ts'))}),
    monitor: require(${JSON.stringify(join(root, 'src', 'main', 'database-lock-monitor.ts'))}),
  }`,
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
  let competingWriter
  let client
  try {
    await app.whenReady()
    sqlite = new Database(databasePath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)')

    const bundled = require(clientBundlePath)
    client = bundled.client
    const monitor = bundled.monitor

    const available = await client.runDatabaseLockProbeWorkerTask({ dbFilePath: databasePath })
    assert.strictEqual(available.writerAvailable, true)
    assert.strictEqual(available.busy, false)

    competingWriter = new Database(databasePath)
    competingWriter.pragma('busy_timeout = 0')
    competingWriter.exec('BEGIN IMMEDIATE TRANSACTION')
    const occupied = await client.runDatabaseLockProbeWorkerTask({ dbFilePath: databasePath })
    assert.strictEqual(occupied.writerAvailable, false)
    assert.strictEqual(occupied.busy, true)
    assert.match(String(occupied.error || ''), /locked|busy/i)
    competingWriter.exec('ROLLBACK')

    const released = await client.runDatabaseLockProbeWorkerTask({ dbFilePath: databasePath })
    assert.strictEqual(released.writerAvailable, true)

    monitor.resetDatabaseLockMonitorForTests()
    const activityId = monitor.beginDatabaseActivity({
      category: 'document-delete',
      label: '后台永久删除',
      state: 'queued',
      detail: '249 篇文献',
    })
    monitor.updateDatabaseActivity(activityId, { state: 'waiting' })
    monitor.recordDatabaseBusyIncident(activityId, new Error('database is locked'), 30_000, 'failed')
    let snapshot = monitor.getDatabaseActivitySnapshot()
    assert.strictEqual(snapshot.activeActivities.length, 1)
    assert.strictEqual(snapshot.activeActivities[0].state, 'waiting')
    assert.strictEqual(snapshot.recentBusyIncidents[0].operationLabel, '后台永久删除')
    assert.strictEqual(snapshot.recentBusyIncidents[0].waitedMs, 30_000)
    monitor.finishDatabaseActivity(activityId)
    snapshot = monitor.getDatabaseActivitySnapshot()
    assert.strictEqual(snapshot.activeActivities.length, 0)

    const settingsSource = readFileSync(join(root, 'src', 'renderer', 'src', 'views', 'SettingsView.tsx'), 'utf8')
    const diagnosticsSource = readFileSync(join(root, 'src', 'main', 'database-lock-diagnostics.ts'), 'utf8')
    assert(settingsSource.includes('数据库占用监视'))
    assert(settingsSource.includes('未归属写锁'))
    assert(diagnosticsSource.includes("status: 'busy-unattributed'"))
    assert(diagnosticsSource.includes("status: 'busy-confirmed-internal'"))

    console.log('Database lock diagnostics regression passed (available -> occupied -> released).')
  } finally {
    if (client) await client.shutdownDatabaseDiagnosticsWorkers()
    if (competingWriter?.inTransaction) competingWriter.exec('ROLLBACK')
    competingWriter?.close()
    sqlite?.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
  app.quit()
}

run().catch((error) => {
  console.error(error)
  app.exit(1)
})
