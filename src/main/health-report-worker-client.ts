import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import type { DocumentHealthReport } from '../shared/types'

export interface HealthReportWorkerTask {
  dbFilePath: string
  libraryProjectId: string
}

type WorkerMessage =
  | { type: 'result'; report: DocumentHealthReport }
  | { type: 'error'; error: string }

const activeWorkers = new Set<Worker>()

function getWorkerScriptPath(): string | null {
  const workerPath = join(__dirname, 'health-report-worker.js')
  return existsSync(workerPath) ? workerPath : null
}

export function isHealthReportWorkerAvailable(): boolean {
  return !!getWorkerScriptPath()
}

export function runHealthReportWorkerTask(task: HealthReportWorkerTask): Promise<DocumentHealthReport> {
  const workerPath = getWorkerScriptPath()
  if (!workerPath) {
    return Promise.reject(new Error('Health report worker script not found'))
  }

  return new Promise<DocumentHealthReport>((resolve, reject) => {
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
        finish(() => resolve(message.report))
        return
      }
      if (message.type === 'error') {
        finish(() => reject(new Error(message.error || 'Health report worker failed')))
      }
    })

    worker.on('error', (error) => {
      finish(() => reject(error))
    })

    worker.on('exit', (code) => {
      if (settled || code === 0) return
      finish(() => reject(new Error(`Health report worker exited with code ${code}`)))
    })

    worker.postMessage({ type: 'buildHealthReport', task })
  }).catch((error: unknown) => {
    throw new Error(getErrorMessage(error))
  })
}

export async function shutdownHealthReportWorkers(): Promise<void> {
  const workers = [...activeWorkers]
  activeWorkers.clear()
  await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)))
}
