const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, '..')
const databaseSource = fs.readFileSync(path.join(root, 'src', 'main', 'database.ts'), 'utf8')
const searchWorkerSource = fs.readFileSync(path.join(root, 'src', 'main', 'search-index-worker.ts'), 'utf8')
const diagnosticsWorkerSource = fs.readFileSync(path.join(root, 'src', 'main', 'database-diagnostics-worker.ts'), 'utf8')
const diagnosticsWorkerClientSource = fs.readFileSync(path.join(root, 'src', 'main', 'database-diagnostics-worker-client.ts'), 'utf8')
const scheduledSaveBody = databaseSource.slice(
  databaseSource.indexOf('export function scheduleDatabaseSave'),
  databaseSource.indexOf('export function closeDatabase'),
)

assert(
  databaseSource.includes('const DATABASE_BUSY_TIMEOUT_MS = 250'),
  'Main database connection should use a short busy timeout so SQLite locks do not freeze the Electron main process',
)
assert(
  databaseSource.includes('const DATABASE_BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1200]'),
  'Main database busy retries should be bounded to a short UI-safe window',
)
assert(
  databaseSource.includes('export async function runAsync(')
    && databaseSource.includes('DATABASE_ASYNC_BUSY_RETRY_MAX_WAIT_MS = 30_000')
    && databaseSource.includes('DATABASE_ASYNC_BUSY_RETRY_DELAY_MS = 25')
    && databaseSource.includes('await sleepAsync('),
  'Queued background writes should retry SQLite locks asynchronously and frequently enough to claim short writer windows',
)
assert(
  databaseSource.includes("database.pragma('wal_autocheckpoint = 0')"),
  'SQLite automatic checkpoints must be disabled because they run on the committing main-process write',
)
assert(
  databaseSource.includes('BEGIN IMMEDIATE TRANSACTION'),
  'Main database write transactions should acquire the writer lock before doing read-then-write OCR work',
)
assert(
  databaseSource.includes('if (database.inTransaction)')
    && databaseSource.includes('Helpers such as the task scheduler use transaction() internally'),
  'Synchronous task helpers must join an already acquired async writer transaction instead of issuing a second BEGIN',
)
assert(
  databaseSource.includes('export function getForegroundDatabaseWriterBuffer()')
    && databaseSource.includes('beginForegroundDatabaseWrite()')
    && databaseSource.includes('endForegroundDatabaseWrite()'),
  'foreground writes should expose shared priority state so delete workers cannot starve OCR',
)
assert(
  databaseSource.includes('function checkpointDatabase(options?: { retryBusy?: boolean; mode?: \'PASSIVE\' | \'TRUNCATE\' }): boolean')
    && databaseSource.includes('wal_checkpoint(${mode})')
    && databaseSource.includes('runDatabaseCheckpointWorkerTask')
    && diagnosticsWorkerClientSource.includes('runDatabaseCheckpointWorkerTask')
    && diagnosticsWorkerSource.includes("message.type === 'checkpointDatabase'")
    && diagnosticsWorkerSource.includes('wal_checkpoint(${message.task.mode})'),
  'Deferred database checkpoints should run on the database worker instead of blocking the Electron main process',
)
assert(
  databaseSource.includes('export function beginDatabaseCheckpointDeferral')
    && databaseSource.includes('databaseCheckpointDeferralCount > 0')
    && databaseSource.includes('Never fall back to a synchronous')
    && !scheduledSaveBody.includes('checkpointDatabase('),
  'Bulk write jobs should be able to suppress automatic checkpoints and the scheduler must not fall back to a synchronous main-thread checkpoint',
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
