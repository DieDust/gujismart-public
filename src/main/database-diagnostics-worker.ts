import Database from 'better-sqlite3'
import { parentPort } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import { setPayloadDataDir } from './page-payload-files'
import { getPagePayloadStorageStatsForDatabase } from './page-payload-statistics'
import type {
  DatabaseCheckpointWorkerResult,
  DatabaseCheckpointWorkerTask,
  DatabaseDiagnosticsWorkerTask,
  DatabaseLockProbeWorkerResult,
  DatabaseLockProbeWorkerTask,
} from './database-diagnostics-worker-client'

if (!parentPort) {
  throw new Error('Database diagnostics worker requires a parent port')
}

type DatabaseDiagnosticsWorkerMessage =
  | { type: 'scanPagePayloadStorage'; task: DatabaseDiagnosticsWorkerTask }
  | { type: 'checkpointDatabase'; task: DatabaseCheckpointWorkerTask }
  | { type: 'probeDatabaseLock'; task: DatabaseLockProbeWorkerTask }

function isDatabaseBusyError(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : {}
  const code = String(record.code || '')
  const message = String(record.message || error || '')
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|database table is locked/i.test(message)
}

parentPort.on('message', (message: DatabaseDiagnosticsWorkerMessage) => {
  if (!message?.task) return
  let sqlite: Database.Database | null = null
  try {
    if (message.type === 'scanPagePayloadStorage') {
      setPayloadDataDir(message.task.dataDir)
      sqlite = new Database(message.task.dbFilePath, { readonly: true, fileMustExist: true })
      sqlite.pragma('query_only = ON')
      sqlite.pragma('busy_timeout = 10000')
      const stats = getPagePayloadStorageStatsForDatabase(sqlite)
      parentPort?.postMessage({ type: 'result', stats })
      return
    }
    if (message.type === 'checkpointDatabase') {
      sqlite = new Database(message.task.dbFilePath, { fileMustExist: true })
      sqlite.pragma('busy_timeout = 0')
      const rows = sqlite.pragma(`wal_checkpoint(${message.task.mode})`) as Array<{
        busy?: number
        log?: number
        checkpointed?: number
      }>
      const row = rows[0] || {}
      const result: DatabaseCheckpointWorkerResult = {
        busy: Number(row.busy || 0),
        logFrames: Number(row.log || 0),
        checkpointedFrames: Number(row.checkpointed || 0),
      }
      parentPort?.postMessage({ type: 'checkpointResult', result })
      return
    }
    if (message.type === 'probeDatabaseLock') {
      const startedAt = Date.now()
      sqlite = new Database(message.task.dbFilePath, { fileMustExist: true })
      sqlite.pragma('busy_timeout = 0')
      try {
        sqlite.exec('BEGIN IMMEDIATE TRANSACTION')
        sqlite.exec('ROLLBACK')
        const result: DatabaseLockProbeWorkerResult = {
          writerAvailable: true,
          busy: false,
          elapsedMs: Date.now() - startedAt,
        }
        parentPort?.postMessage({ type: 'lockProbeResult', result })
      } catch (error) {
        if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
        const result: DatabaseLockProbeWorkerResult = {
          writerAvailable: false,
          busy: isDatabaseBusyError(error),
          elapsedMs: Date.now() - startedAt,
          error: getErrorMessage(error),
        }
        parentPort?.postMessage({ type: 'lockProbeResult', result })
      }
    }
  } catch (error) {
    parentPort?.postMessage({ type: 'error', error: getErrorMessage(error) })
  } finally {
    sqlite?.close()
  }
})
