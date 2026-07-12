import type { LibraryImportQueueJobSnapshot, LibraryImportQueueState } from '../shared/types'
import { queryAll, queryOne } from './database'
import { appendTaskItems, cancelTaskJob, createTaskJob, getTaskJob } from './task-scheduler'

function pendingCount(job: LibraryImportQueueJobSnapshot): number {
  return 'pendingCount' in job
    ? Math.max(0, Number(job.pendingCount || 0) || 0)
    : Math.max(0, job.filePaths.length)
}

function authorizationStatus(job: LibraryImportQueueJobSnapshot): 'authorized' | 'authorization-required' {
  return 'authorizationStatus' in job ? job.authorizationStatus : 'authorization-required'
}

export function registerLegacyImportQueueState(
  state: LibraryImportQueueState,
  options?: { nowMs?: number },
): { jobsCreated: number; jobsReused: number; itemsCreated: number } {
  const summary = { jobsCreated: 0, jobsReused: 0, itemsCreated: 0 }
  state.jobs.forEach((legacyJob) => {
    const legacyId = Number(legacyJob.id)
    if (!Number.isSafeInteger(legacyId) || legacyId < 0) throw new Error('legacy_import_job_id_invalid')
    const idempotencyKey = `legacy:library_import_queue:${legacyId}`
    const existing = queryOne<{ id: string }>(
      'SELECT id FROM task_jobs WHERE kind = ? AND idempotency_key = ?',
      ['import.compatibility', idempotencyKey],
    )
    const status = authorizationStatus(legacyJob)
    const job = createTaskJob({
      kind: 'import.compatibility',
      idempotencyKey,
      phase: status,
      settingsSnapshot: {
        engine: legacyJob.engine,
        authorizationStatus: status,
        pendingCount: pendingCount(legacyJob),
        hasSelection: 'selectionId' in legacyJob && Boolean(legacyJob.selectionId),
        legacySnapshotVersion: state.version,
      },
      nowMs: options?.nowMs,
    })
    if (existing) summary.jobsReused += 1
    else summary.jobsCreated += 1
    if (getTaskJob(job.id).totalCount > 0) return
    const inserted = appendTaskItems(job.id, [{
      idempotencyKey: `${idempotencyKey}:compatibility-item`,
      domainType: 'legacy-import-queue',
      domainRef: String(legacyId),
      phase: status,
      input: {
        pendingCount: pendingCount(legacyJob),
        authorizationStatus: status,
      },
    }], { nowMs: options?.nowMs })
    summary.itemsCreated += inserted.length
  })
  return summary
}

export function cancelLegacyImportQueueTasks(legacyIds?: number[], options?: { nowMs?: number }): number {
  const ids = legacyIds && legacyIds.length > 0
    ? legacyIds.map((id) => `legacy:library_import_queue:${id}`)
    : null
  const rows = ids
    ? queryAll<{ id: string; status: string }>(
      `SELECT id, status FROM task_jobs WHERE kind = 'import.compatibility'
       AND idempotency_key IN (${ids.map(() => '?').join(', ')})`,
      ids,
    )
    : queryAll<{ id: string; status: string }>(
      "SELECT id, status FROM task_jobs WHERE kind = 'import.compatibility'",
    )
  let canceled = 0
  rows.forEach((row) => {
    if (row.status === 'completed' || row.status === 'canceled') return
    cancelTaskJob(row.id, options)
    canceled += 1
  })
  return canceled
}
