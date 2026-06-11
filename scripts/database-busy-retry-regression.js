const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, '..')
const databaseSource = fs.readFileSync(path.join(root, 'src', 'main', 'database.ts'), 'utf8')
const searchWorkerSource = fs.readFileSync(path.join(root, 'src', 'main', 'search-index-worker.ts'), 'utf8')

assert(
  databaseSource.includes('const DATABASE_BUSY_TIMEOUT_MS = 250'),
  'Main database connection should use a short busy timeout so SQLite locks do not freeze the Electron main process',
)
assert(
  databaseSource.includes('const DATABASE_BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1200]'),
  'Main database busy retries should be bounded to a short UI-safe window',
)
assert(
  databaseSource.includes('BEGIN IMMEDIATE TRANSACTION'),
  'Main database write transactions should acquire the writer lock before doing read-then-write OCR work',
)
assert(
  databaseSource.includes('function checkpointDatabase(options?: { retryBusy?: boolean }): boolean')
    && databaseSource.includes("db.pragma('wal_checkpoint(PASSIVE)')")
    && databaseSource.includes('if (!checkpointDatabase())')
    && databaseSource.includes('scheduleDatabaseSave()'),
  'Deferred database checkpoints should skip busy locks and reschedule instead of blocking the main process',
)
assert(
  databaseSource.includes('checkpointDatabase({ retryBusy: true })'),
  'Explicit database saves should still retry busy checkpoints briefly before shutdown or manual save',
)
assert(
  searchWorkerSource.includes('const WORKER_DATABASE_BUSY_TIMEOUT_MS = 30000'),
  'Search index worker should use a long busy timeout while OCR is saving pages',
)
assert(
  searchWorkerSource.includes('function runWithBusyRetry'),
  'Search index worker should retry busy SQLite operations instead of failing background reindexing',
)
assert(
  searchWorkerSource.includes('BEGIN IMMEDIATE TRANSACTION'),
  'Search index worker write transactions should not start as deferred read transactions',
)

console.log('Database busy retry regression passed.')
