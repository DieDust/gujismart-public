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
  databaseSource.includes('function checkpointDatabase(options?: { retryBusy?: boolean; mode?: \'PASSIVE\' | \'TRUNCATE\' }): boolean')
    && databaseSource.includes('wal_checkpoint(${mode})')
    && databaseSource.includes('if (!checkpointDatabase())')
    && databaseSource.includes('scheduleDatabaseSave()'),
  'Deferred database checkpoints should skip busy locks and reschedule instead of blocking the main process',
)
assert(
  databaseSource.includes("checkpointDatabase({ retryBusy: true, mode: 'TRUNCATE' })")
    && databaseSource.includes("checkpointDatabase({ retryBusy: true, mode: 'PASSIVE' })"),
  'Clean shutdown should try TRUNCATE then fall back to PASSIVE checkpoint so large WAL does not block the next cold start',
)
assert(
  /export async function initDatabase\(\): Promise<void> \{[\s\S]*?Initialization complete/.test(databaseSource)
    && !/export async function initDatabase\(\): Promise<void> \{[\s\S]*?scheduleDatabaseSave\([\s\S]*?Initialization complete/.test(databaseSource)
    && !/export async function initDatabase\(\): Promise<void> \{[\s\S]*?saveDatabase\(\)[\s\S]*?Initialization complete/.test(databaseSource),
  'Database init must not checkpoint WAL during open; large WAL rewrite freezes the UI with high disk and near-zero CPU',
)
assert(
  databaseSource.includes('export function scheduleDatabaseSave(options?: { minDelayMs?: number }): void'),
  'Deferred database saves should accept an interactive-grace minDelay so open-path work can stay responsive',
)
assert(
  searchWorkerSource.includes('const WORKER_DATABASE_BUSY_TIMEOUT_MS = 10000'),
  'Search index worker should use a bounded busy timeout so background reindexing does not stall for too long',
)
assert(
  searchWorkerSource.includes('const WORKER_DATABASE_BUSY_RETRY_DELAYS_MS = [50, 100, 250, 500, 1000]'),
  'Search index worker busy retries should fail quickly and leave reindexing recoverable',
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
