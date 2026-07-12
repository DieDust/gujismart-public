import { nanoid } from 'nanoid'
import type { TaskClaim } from '../shared/types'
import { queryAll, queryOne, run, scheduleDatabaseSave, transaction } from './database'
import {
  appendTaskItems,
  bridgeLegacyBatchQueue,
  claimTaskItem,
  completeTaskItem,
  createTaskJob,
  failTaskItem,
  cancelTaskJob,
  pauseTaskJob,
  releaseTaskItemLease,
  retryTaskItem,
  resumeTaskJob,
} from './task-scheduler'

const DEFAULT_LEASE_MS = 10 * 60 * 1000
const APPEND_BATCH_SIZE = 200
const activeClaims = new Map<string, TaskClaim>()

export interface LegacyBatchTaskItemRef {
  legacyItemId: string
  taskItemId: string
  docId: string
}

export interface LegacyBatchTaskResult {
  batchId: string
  jobId: string
  count: number
  batchSize: number
  items: LegacyBatchTaskItemRef[]
}

function safeBatchSize(value: number): number {
  const size = Number(value || 5)
  if (!Number.isSafeInteger(size) || size < 1 || size > 200) throw new Error('batch_size_invalid')
  return size
}

function resolveTaskItemId(legacyItemId: string): string {
  const row = queryOne<{ task_item_id: string }>(
    `SELECT ti.id AS task_item_id
       FROM task_items ti
      WHERE ti.idempotency_key = ?
      ORDER BY ti.created_at DESC LIMIT 1`,
    [`legacy:batch_queue:${legacyItemId}`],
  )
  if (row?.task_item_id) return row.task_item_id
  bridgeLegacyBatchQueue()
  const bridged = queryOne<{ task_item_id: string }>(
    `SELECT ti.id AS task_item_id
       FROM task_items ti
      WHERE ti.idempotency_key = ?
      ORDER BY ti.created_at DESC LIMIT 1`,
    [`legacy:batch_queue:${legacyItemId}`],
  )
  if (!bridged?.task_item_id) throw new Error('legacy_batch_item_not_found')
  return bridged.task_item_id
}

export function createLegacyBatchTask(
  docIds: string[],
  batchSizeValue = 5,
  options?: { batchId?: string; nowMs?: number },
): LegacyBatchTaskResult {
  const uniqueDocIds = [...new Set((docIds || []).map((docId) => String(docId || '').trim()).filter(Boolean))]
  const batchSize = safeBatchSize(batchSizeValue)
  const batchId = String(options?.batchId || nanoid()).trim()
  if (!batchId || batchId.length > 240) throw new Error('legacy_batch_id_invalid')
  const nowMs = options?.nowMs === undefined ? Date.now() : Number(options.nowMs)
  const job = createTaskJob({
    kind: 'ocr.batch',
    idempotencyKey: `legacy:batch_queue:${batchId}`,
    settingsSnapshot: { batchSize, legacyBatchId: batchId },
    nowMs,
  })

  const existingRows = queryAll<{ id: string; doc_id: string }>(
    'SELECT id, doc_id FROM batch_queue WHERE batch_id = ? ORDER BY created_at, rowid',
    [batchId],
  )
  const existingByDocId = new Map(existingRows.map((row) => [row.doc_id, row.id]))
  const refs = uniqueDocIds.map((docId) => ({
    docId,
    legacyItemId: existingByDocId.get(docId) || nanoid(),
  }))

  for (let offset = 0; offset < refs.length; offset += APPEND_BATCH_SIZE) {
    appendTaskItems(
      job.id,
      refs.slice(offset, offset + APPEND_BATCH_SIZE).map((item) => ({
        idempotencyKey: `legacy:batch_queue:${item.legacyItemId}`,
        domainType: 'document',
        domainRef: item.docId,
        phase: 'queued',
        input: { docId: item.docId, legacyQueueItemId: item.legacyItemId },
      })),
      { nowMs },
    )
  }

  for (let offset = 0; offset < refs.length; offset += APPEND_BATCH_SIZE) {
    transaction(() => {
      refs.slice(offset, offset + APPEND_BATCH_SIZE).forEach((item) => {
        if (existingByDocId.has(item.docId)) return
        run(
          `INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, error_message, created_at)
           VALUES (?, ?, ?, 'pending', ?, 0, NULL, ?)`,
          [item.legacyItemId, batchId, item.docId, batchSize, new Date(nowMs).toISOString()],
        )
      })
    })
  }
  scheduleDatabaseSave()

  return {
    batchId,
    jobId: job.id,
    count: refs.length,
    batchSize,
    items: refs.map((item) => ({
      ...item,
      taskItemId: resolveTaskItemId(item.legacyItemId),
    })),
  }
}

export function startLegacyBatchItem(
  legacyItemId: string,
  workerId: string,
  options?: { leaseMs?: number; nowMs?: number },
): TaskClaim {
  const itemId = resolveTaskItemId(legacyItemId)
  const claim = claimTaskItem({
    itemId,
    workerId,
    leaseMs: options?.leaseMs || DEFAULT_LEASE_MS,
    nowMs: options?.nowMs,
  })
  try {
    run(
      `UPDATE batch_queue SET status = 'processing', progress = 0, error_message = NULL,
       started_at = COALESCE(started_at, ?), completed_at = NULL WHERE id = ?`,
      [new Date(options?.nowMs ?? Date.now()).toISOString(), legacyItemId],
    )
  } catch (error) {
    releaseTaskItemLease({ itemId, leaseToken: claim.leaseToken, nowMs: options?.nowMs })
    throw error
  }
  activeClaims.set(legacyItemId, claim)
  scheduleDatabaseSave()
  return claim
}

function activeClaim(legacyItemId: string): TaskClaim {
  const claim = activeClaims.get(legacyItemId)
  if (!claim) throw new Error('legacy_batch_lease_missing')
  return claim
}

export function completeLegacyBatchItem(legacyItemId: string, options?: { message?: string; nowMs?: number }): void {
  const claim = activeClaim(legacyItemId)
  completeTaskItem({ itemId: claim.itemId, leaseToken: claim.leaseToken, completionKind: options?.message ? 'partial' : 'full', nowMs: options?.nowMs })
  activeClaims.delete(legacyItemId)
  run(
    "UPDATE batch_queue SET status = 'completed', progress = 100, error_message = ?, completed_at = ? WHERE id = ?",
    [options?.message?.slice(0, 1000) || null, new Date(options?.nowMs ?? Date.now()).toISOString(), legacyItemId],
  )
  scheduleDatabaseSave()
}

export function failLegacyBatchItem(
  legacyItemId: string,
  options: { errorMessage: string; recoverable?: boolean; nowMs?: number },
): void {
  const claim = activeClaim(legacyItemId)
  failTaskItem({
    itemId: claim.itemId,
    leaseToken: claim.leaseToken,
    error: {
      code: 'ocr_batch_item_error',
      message: options.errorMessage,
      recoverable: options.recoverable !== false,
      recoveryAction: options.recoverable === false ? undefined : 'retry_task',
    },
    nowMs: options.nowMs,
  })
  activeClaims.delete(legacyItemId)
  run(
    "UPDATE batch_queue SET status = 'failed', progress = 100, error_message = ?, completed_at = ? WHERE id = ?",
    [options.errorMessage.slice(0, 1000), new Date(options.nowMs ?? Date.now()).toISOString(), legacyItemId],
  )
  scheduleDatabaseSave()
}

export function releaseLegacyBatchItem(legacyItemId: string, options?: { nowMs?: number }): void {
  const claim = activeClaim(legacyItemId)
  releaseTaskItemLease({ itemId: claim.itemId, leaseToken: claim.leaseToken, nowMs: options?.nowMs })
  activeClaims.delete(legacyItemId)
  run(
    `UPDATE batch_queue SET status = 'pending', progress = 0, error_message = NULL,
     started_at = NULL, completed_at = NULL WHERE id = ?`,
    [legacyItemId],
  )
  scheduleDatabaseSave()
}

export function hasActiveLegacyBatchClaim(legacyItemId: string): boolean {
  return activeClaims.has(legacyItemId)
}

export function pauseLegacyBatchTask(jobId: string, options?: { nowMs?: number }): void {
  pauseTaskJob(jobId, options)
}

export function resumeLegacyBatchTask(jobId: string, options?: { nowMs?: number }): void {
  resumeTaskJob(jobId, options)
}

export function cancelLegacyBatchTask(jobId: string, options?: { nowMs?: number }): void {
  cancelTaskJob(jobId, options)
  let ordinal = -1
  while (true) {
    const rows = queryAll<{ ordinal: number; legacy_item_id: string }>(
      `SELECT ordinal, json_extract(input_json, '$.legacyQueueItemId') AS legacy_item_id
         FROM task_items WHERE job_id = ? AND ordinal > ?
         ORDER BY ordinal LIMIT ?`,
      [jobId, ordinal, APPEND_BATCH_SIZE],
    )
    if (rows.length === 0) break
    const chunk = rows.map((row) => String(row.legacy_item_id || '')).filter(Boolean)
    chunk.forEach((legacyItemId) => activeClaims.delete(legacyItemId))
    const placeholders = chunk.map(() => '?').join(', ')
    if (chunk.length > 0) {
      run(
        `UPDATE batch_queue SET status = 'failed', error_message = '任务已取消', completed_at = ? WHERE id IN (${placeholders})`,
        [new Date(options?.nowMs ?? Date.now()).toISOString(), ...chunk],
      )
    }
    ordinal = Number(rows[rows.length - 1].ordinal)
  }
  scheduleDatabaseSave()
}

export function resetLegacyBatchItem(legacyItemId: string, options?: { nowMs?: number }): void {
  if (activeClaims.has(legacyItemId)) {
    releaseLegacyBatchItem(legacyItemId, options)
    return
  }
  const taskItemId = resolveTaskItemId(legacyItemId)
  const item = queryOne<{ status: string }>('SELECT status FROM task_items WHERE id = ?', [taskItemId])
  if (item?.status === 'error') retryTaskItem(taskItemId, options)
  run(
    `UPDATE batch_queue SET status = 'pending', progress = 0, error_message = NULL,
     started_at = NULL, completed_at = NULL WHERE id = ?`,
    [legacyItemId],
  )
  scheduleDatabaseSave()
}

export function releaseAllLegacyBatchClaims(options?: { nowMs?: number }): number {
  const entries = [...activeClaims.entries()]
  entries.forEach(([legacyItemId, claim]) => {
    try {
      releaseTaskItemLease({ itemId: claim.itemId, leaseToken: claim.leaseToken, nowMs: options?.nowMs })
      run(
        `UPDATE batch_queue SET status = 'pending', progress = 0, error_message = NULL,
         started_at = NULL, completed_at = NULL WHERE id = ?`,
        [legacyItemId],
      )
    } finally {
      activeClaims.delete(legacyItemId)
    }
  })
  if (entries.length > 0) scheduleDatabaseSave()
  return entries.length
}
