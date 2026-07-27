import Database from 'better-sqlite3'
import { parentPort } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import { setPayloadDataDir } from './page-payload-files'
import { getPagePayloadStorageStatsForDatabase } from './page-payload-statistics'
import type { DatabaseDiagnosticsWorkerTask } from './database-diagnostics-worker-client'

if (!parentPort) {
  throw new Error('Database diagnostics worker requires a parent port')
}

parentPort.on('message', (message: { type?: string; task?: DatabaseDiagnosticsWorkerTask }) => {
  if (message?.type !== 'scanPagePayloadStorage' || !message.task) return
  let sqlite: Database.Database | null = null
  try {
    setPayloadDataDir(message.task.dataDir)
    sqlite = new Database(message.task.dbFilePath, { readonly: true, fileMustExist: true })
    sqlite.pragma('query_only = ON')
    sqlite.pragma('busy_timeout = 10000')
    const stats = getPagePayloadStorageStatsForDatabase(sqlite)
    parentPort?.postMessage({ type: 'result', stats })
  } catch (error) {
    parentPort?.postMessage({ type: 'error', error: getErrorMessage(error) })
  } finally {
    sqlite?.close()
  }
})
