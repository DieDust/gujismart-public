import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import type { SearchReindexDocumentResult } from '../shared/types'

export interface SearchIndexWorkerTask {
  dbFilePath: string
  docId: string
  totalCount: number
  completedCount: number
}

export interface SearchIndexWorkerProgress {
  status: 'queued' | 'processing' | 'completed' | 'error'
  progress?: number
  message?: string
  docId?: string
  totalCount?: number
  completedCount?: number
  errorMessage?: string
}

type WorkerMessage =
  | { type: 'progress'; payload: SearchIndexWorkerProgress }
  | { type: 'result'; result: SearchReindexDocumentResult }
  | { type: 'error'; error: string }

const activeWorkers = new Set<Worker>()

function getWorkerScriptPath(): string | null {
  const workerPath = join(__dirname, 'search-index-worker.js')
  return existsSync(workerPath) ? workerPath : null
}

export function isSearchIndexWorkerAvailable(): boolean {
  return !!getWorkerScriptPath()
}

export function runSearchIndexWorkerTask(
  task: SearchIndexWorkerTask,
  onProgress: (progress: SearchIndexWorkerProgress) => void,
): Promise<SearchReindexDocumentResult> {
  const workerPath = getWorkerScriptPath()
  if (!workerPath) {
    return Promise.reject(new Error('Search index worker script not found'))
  }

  return new Promise<SearchReindexDocumentResult>((resolve, reject) => {
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
      if (message.type === 'progress') {
        onProgress(message.payload)
        return
      }
      if (message.type === 'result') {
        finish(() => resolve(message.result))
        return
      }
      if (message.type === 'error') {
        finish(() => reject(new Error(message.error || 'Search index worker failed')))
      }
    })

    worker.on('error', (error) => {
      finish(() => reject(error))
    })

    worker.on('exit', (code) => {
      if (settled || code === 0) return
      finish(() => reject(new Error(`Search index worker exited with code ${code}`)))
    })

    worker.postMessage({ type: 'indexDocument', task })
  }).catch((error: unknown) => {
    throw new Error(getErrorMessage(error))
  })
}

export async function shutdownSearchIndexWorkers(): Promise<void> {
  const workers = [...activeWorkers]
  activeWorkers.clear()
  await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)))
}
