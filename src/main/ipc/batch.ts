import { ipcMain, BrowserWindow } from 'electron'
import { queryAll, run, saveDatabase } from '../database'
import { batchProcessor } from '../batch-processor'
import {
  completeLegacyBatchItem,
  createLegacyBatchTask,
  failLegacyBatchItem,
  hasActiveLegacyBatchClaim,
  resetLegacyBatchItem,
  startLegacyBatchItem,
} from '../task-batch-compat'
import type { BatchCreateResult, BatchItemStatus, BatchJob, BatchQueueItem, BatchStartResult } from '../../shared/types'

export function registerBatchIpc(): void {
  ipcMain.handle('batch:start', async (_event, docIds: string[], batchSize?: number): Promise<BatchStartResult> => {
    const size = batchSize || 5
    const persisted = createLegacyBatchTask(docIds, size)
    const queueItemIdsByDocId = new Map(persisted.items.map((item) => [item.docId, item.legacyItemId]))
    const job = batchProcessor.createJob(docIds, size, { id: persisted.jobId, queueItemIdsByDocId })

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
    const size = batchSize || 5
    const persisted = createLegacyBatchTask(docIds, size)
    return { batchId: persisted.batchId, count: persisted.count }
  })

  ipcMain.handle('batch:list', async (): Promise<BatchQueueItem[]> => {
    return queryAll<BatchQueueItem>('SELECT * FROM batch_queue ORDER BY created_at DESC')
  })

  ipcMain.handle('batch:getByBatchId', async (_event, batchId: string): Promise<BatchQueueItem[]> => {
    return queryAll<BatchQueueItem>('SELECT * FROM batch_queue WHERE batch_id = ? ORDER BY created_at', [batchId])
  })

  ipcMain.handle('batch:updateStatus', async (_event, id: string, status: BatchItemStatus, errorMessage?: string): Promise<boolean> => {
    if (status === 'processing') {
      if (!hasActiveLegacyBatchClaim(id)) startLegacyBatchItem(id, 'legacy-batch-ipc')
    } else if (status === 'completed') {
      if (!hasActiveLegacyBatchClaim(id)) startLegacyBatchItem(id, 'legacy-batch-ipc')
      completeLegacyBatchItem(id, { message: errorMessage })
    } else if (status === 'failed') {
      if (!hasActiveLegacyBatchClaim(id)) startLegacyBatchItem(id, 'legacy-batch-ipc')
      failLegacyBatchItem(id, { errorMessage: errorMessage || '批处理失败', recoverable: true })
    } else {
      resetLegacyBatchItem(id)
    }
    saveDatabase()
    return true
  })

  ipcMain.handle('batch:clearCompleted', async (): Promise<boolean> => {
    run("DELETE FROM batch_queue WHERE status IN ('completed', 'failed')")
    saveDatabase()
    return true
  })
}
