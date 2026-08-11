import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import type { SearchGroupedResponse, SearchOptions } from '../shared/types'

export interface SearchExportQueryWorkerTask {
  databasePath: string
  dataDir: string
  projectId: string
  keyword: string
  options: SearchOptions
}

export type SearchExportQueryWorkerStage = 'initializing' | 'searching' | 'finalizing'

export interface SearchExportQueryWorkerProgress {
  stage: SearchExportQueryWorkerStage
  message: string
}

export interface SearchExportQueryWorkerHandle {
  result: Promise<SearchGroupedResponse>
  cancel: () => void
}

type WorkerMessage =
  | { type: 'progress'; progress: SearchExportQueryWorkerProgress }
  | { type: 'result'; result: SearchGroupedResponse }
  | { type: 'error'; error: string }

const activeWorkers = new Set<Worker>()

function getWorkerScriptPath(): string | null {
  const workerPath = join(__dirname, 'search-export-query-worker.js')
  return existsSync(workerPath) ? workerPath : null
}

export function isSearchExportQueryWorkerAvailable(): boolean {
  return !!getWorkerScriptPath()
}

export function startSearchExportQueryWorkerTask(
  task: SearchExportQueryWorkerTask,
  onProgress?: (progress: SearchExportQueryWorkerProgress) => void,
): SearchExportQueryWorkerHandle {
  const workerPath = getWorkerScriptPath()
  if (!workerPath) throw new Error('Search export query worker script not found')

  const worker = new Worker(workerPath)
  activeWorkers.add(worker)
  let settled = false
  let rejectResult: ((error: Error) => void) | null = null

  const result = new Promise<SearchGroupedResponse>((resolve, reject) => {
    rejectResult = reject
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
        onProgress?.(message.progress)
        return
      }
      if (message.type === 'result') {
        finish(() => resolve(message.result))
        return
      }
      if (message.type === 'error') {
        finish(() => reject(new Error(message.error || 'Search export query worker failed')))
      }
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      if (settled || code === 0) return
      finish(() => reject(new Error(`Search export query worker exited with code ${code}`)))
    })
    worker.postMessage({ type: 'query', task })
  }).catch((error: unknown) => {
    throw new Error(getErrorMessage(error))
  })

  return {
    result,
    cancel: () => {
      if (settled) return
      settled = true
      activeWorkers.delete(worker)
      worker.removeAllListeners()
      void worker.terminate().finally(() => rejectResult?.(new Error('__search_export_canceled__')))
    },
  }
}

export async function shutdownSearchExportQueryWorkers(): Promise<void> {
  const workers = [...activeWorkers]
  activeWorkers.clear()
  await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)))
}
