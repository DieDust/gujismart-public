import { ipcMain, BrowserWindow } from 'electron'
import { queryAll, run, saveDatabase } from '../database'
import { batchProcessor } from '../batch-processor'
import { nanoid } from 'nanoid'
import type { BatchCreateResult, BatchItemStatus, BatchJob, BatchQueueItem, BatchStartResult } from '../../shared/types'

export function registerBatchIpc(): void {
  ipcMain.handle('batch:start', async (_event, docIds: string[], batchSize?: number): Promise<BatchStartResult> => {
    const size = batchSize || 5
    const job = batchProcessor.createJob(docIds, size)

    const win = BrowserWindow.getFocusedWindow()
    if (win) batchProcessor.setMainWindow(win)

    batchProcessor.startJob(job.id)
    return { jobId: job.id, count: docIds.length, batchSize: size }
  })

  ipcMain.handle('batch:pause', async (_event, jobId: string): Promise<boolean> => {
    batchProcessor.pauseJob(jobId)
    return true
  })

  ipcMain.handle('batch:resume', async (_event, jobId: string): Promise<boolean> => {
    batchProcessor.resumeJob(jobId)
    return true
  })

  ipcMain.handle('batch:cancel', async (_event, jobId: string): Promise<boolean> => {
    batchProcessor.cancelJob(jobId)
    return true
  })

  ipcMain.handle('batch:getJob', async (_event, jobId: string): Promise<BatchJob | null> => {
    return batchProcessor.getJob(jobId) || null
  })

  ipcMain.handle('batch:isProcessing', async (): Promise<boolean> => {
    return batchProcessor.isProcessing()
  })

  ipcMain.handle('batch:create', async (_event, docIds: string[], batchSize?: number): Promise<BatchCreateResult> => {
    const batchId = nanoid()
    const size = batchSize || 5
    const now = new Date().toISOString()

    for (const docId of docIds) {
      const id = nanoid()
      run(
        'INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, batchId, docId, 'pending', size, 0, now]
      )
    }
    saveDatabase()

    return { batchId, count: docIds.length }
  })

  ipcMain.handle('batch:list', async (): Promise<BatchQueueItem[]> => {
    return queryAll<BatchQueueItem>('SELECT * FROM batch_queue ORDER BY created_at DESC')
  })

  ipcMain.handle('batch:getByBatchId', async (_event, batchId: string): Promise<BatchQueueItem[]> => {
    return queryAll<BatchQueueItem>('SELECT * FROM batch_queue WHERE batch_id = ? ORDER BY created_at', [batchId])
  })

  ipcMain.handle('batch:updateStatus', async (_event, id: string, status: BatchItemStatus, errorMessage?: string): Promise<boolean> => {
    const now = new Date().toISOString()
    const updates: string[] = ['status = ?']
    const params: unknown[] = [status]

    if (status === 'processing') {
      updates.push('started_at = ?')
      params.push(now)
    }
    if (status === 'completed' || status === 'failed') {
      updates.push('completed_at = ?')
      params.push(now)
    }
    if (errorMessage) {
      updates.push('error_message = ?')
      params.push(errorMessage)
    }

    params.push(id)
    run(`UPDATE batch_queue SET ${updates.join(', ')} WHERE id = ?`, params)
    saveDatabase()
    return true
  })

  ipcMain.handle('batch:clearCompleted', async (): Promise<boolean> => {
    run("DELETE FROM batch_queue WHERE status IN ('completed', 'failed')")
    saveDatabase()
    return true
  })
}
