import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import { getForegroundDatabaseWriterBuffer } from './database'

export interface DocumentDeleteWorkerTask {
  dbFilePath: string
  documentIds: string[]
  foregroundWriterBuffer?: SharedArrayBuffer
}

export interface DocumentDeleteWorkerResult {
  deletedIds: string[]
  affectedTagIds: string[]
  recoveredSearchIndexIssue: boolean
}

export interface DocumentDeleteWorkerProgress {
  completed: number
  total: number
  phase: 'preparing' | 'deleting'
  message: string
}

type DocumentDeleteWorkerMessage =
  | ({ type: 'progress' } & DocumentDeleteWorkerProgress)
  | { type: 'result'; result: DocumentDeleteWorkerResult }
  | { type: 'error'; error: string }

const activeWorkers = new Set<Worker>()

function getWorkerScriptPath(): string | null {
  const workerPath = join(__dirname, 'document-delete-worker.js')
  return existsSync(workerPath) ? workerPath : null
}

export function isDocumentDeleteWorkerAvailable(): boolean {
  return !!getWorkerScriptPath()
}

export function runDocumentDeleteWorkerTask(
  task: DocumentDeleteWorkerTask,
  options?: { onProgress?: (progress: DocumentDeleteWorkerProgress) => void },
): Promise<DocumentDeleteWorkerResult> {
  const workerPath = getWorkerScriptPath()
  if (!workerPath) return Promise.reject(new Error('Document delete worker script not found'))

  return new Promise<DocumentDeleteWorkerResult>((resolve, reject) => {
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

    worker.on('message', (message: DocumentDeleteWorkerMessage) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'progress') {
        options?.onProgress?.({
          completed: message.completed,
          total: message.total,
          phase: message.phase,
          message: message.message,
        })
        if (message.completed === message.total
          || (message.message === '正在后台删除文献' && message.completed % 25 === 0)) {
          console.log(`[Documents] Background delete progress: ${message.completed}/${message.total}`)
        }
        return
      }
      if (message.type === 'result') {
        finish(() => resolve(message.result))
        return
      }
      if (message.type === 'error') finish(() => reject(new Error(message.error)))
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      if (settled) return
      finish(() => reject(new Error(`Document delete worker exited before returning a result (code ${code})`)))
    })
    worker.postMessage({
      type: 'deleteDocuments',
      task: {
        ...task,
        foregroundWriterBuffer: getForegroundDatabaseWriterBuffer(),
      },
    })
  }).catch((error: unknown) => {
    throw new Error(getErrorMessage(error))
  })
}

export async function shutdownDocumentDeleteWorkers(): Promise<void> {
  const workers = [...activeWorkers]
  activeWorkers.clear()
  await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)))
}
