import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import type { PagePayloadStorageStats } from './page-payload-statistics'

export interface DatabaseDiagnosticsWorkerTask {
  dbFilePath: string
  dataDir: string
}

export interface DatabaseCheckpointWorkerTask {
  dbFilePath: string
  mode: 'PASSIVE' | 'TRUNCATE'
}

export interface DatabaseCheckpointWorkerResult {
  busy: number
  logFrames: number
  checkpointedFrames: number
}

type WorkerMessage =
  | { type: 'result'; stats: PagePayloadStorageStats }
  | { type: 'checkpointResult'; result: DatabaseCheckpointWorkerResult }
  | { type: 'error'; error: string }

const activeWorkers = new Set<Worker>()

function getWorkerScriptPath(): string | null {
  const workerPath = join(__dirname, 'database-diagnostics-worker.js')
  return existsSync(workerPath) ? workerPath : null
}

export function isDatabaseDiagnosticsWorkerAvailable(): boolean {
  return !!getWorkerScriptPath()
}

export function runDatabaseDiagnosticsWorkerTask(
  task: DatabaseDiagnosticsWorkerTask,
): Promise<PagePayloadStorageStats> {
  const workerPath = getWorkerScriptPath()
  if (!workerPath) return Promise.reject(new Error('Database diagnostics worker script not found'))

  return new Promise<PagePayloadStorageStats>((resolve, reject) => {
    const worker = new Worker(workerPath)
    let settled = false
    activeWorkers.add(worker)

    const cleanup = (): void => {
      activeWorkers.delete(worker)
      worker.removeAllListeners()
    }

    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate().finally(callback)
    }

    worker.on('message', (message: WorkerMessage) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'result') {
        finish(() => resolve(message.stats))
        return
      }
      if (message.type === 'error') finish(() => reject(new Error(message.error)))
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      if (settled || code === 0) return
      finish(() => reject(new Error(`Database diagnostics worker exited with code ${code}`)))
    })
    worker.postMessage({ type: 'scanPagePayloadStorage', task })
  }).catch((error: unknown) => {
    throw new Error(getErrorMessage(error))
  })
}

export function runDatabaseCheckpointWorkerTask(
  task: DatabaseCheckpointWorkerTask,
): Promise<DatabaseCheckpointWorkerResult> {
  const workerPath = getWorkerScriptPath()
  if (!workerPath) return Promise.reject(new Error('Database checkpoint worker script not found'))

  return new Promise<DatabaseCheckpointWorkerResult>((resolve, reject) => {
    const worker = new Worker(workerPath)
    let settled = false
    activeWorkers.add(worker)

    const cleanup = (): void => {
      activeWorkers.delete(worker)
      worker.removeAllListeners()
    }

    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate().finally(callback)
    }

    worker.on('message', (message: WorkerMessage) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'checkpointResult') {
        finish(() => resolve(message.result))
        return
      }
      if (message.type === 'error') finish(() => reject(new Error(message.error)))
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      if (settled) return
      finish(() => reject(new Error(`Database checkpoint worker exited before returning a result (code ${code})`)))
    })
    worker.postMessage({ type: 'checkpointDatabase', task })
  }).catch((error: unknown) => {
    throw new Error(getErrorMessage(error))
  })
}

export async function shutdownDatabaseDiagnosticsWorkers(): Promise<void> {
  const workers = [...activeWorkers]
  activeWorkers.clear()
  await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)))
}
