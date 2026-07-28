import Database from 'better-sqlite3'
import { parentPort } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import { setPayloadDataDir } from './page-payload-files'
import { getPagePayloadStorageStatsForDatabase } from './page-payload-statistics'
import type {
  DatabaseCheckpointWorkerResult,
  DatabaseCheckpointWorkerTask,
  DatabaseDiagnosticsWorkerTask,
} from './database-diagnostics-worker-client'

if (!parentPort) {
  throw new Error('Database diagnostics worker requires a parent port')
}

type DatabaseDiagnosticsWorkerMessage =
  | { type: 'scanPagePayloadStorage'; task: DatabaseDiagnosticsWorkerTask }
  | { type: 'checkpointDatabase'; task: DatabaseCheckpointWorkerTask }

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
    }
  } catch (error) {
    parentPort?.postMessage({ type: 'error', error: getErrorMessage(error) })
  } finally {
    sqlite?.close()
  }
})
