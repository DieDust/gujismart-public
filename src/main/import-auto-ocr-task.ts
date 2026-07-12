import type { OcrEngine, TaskJobRecord } from '../shared/types'
import { queryAll, run, scheduleDatabaseSave, transaction } from './database'
import { appendTaskItems, createTaskJob, getTaskJob } from './task-scheduler'

const IMPORT_AUTO_OCR_TASK_KIND = 'ocr.import-auto'
const MAX_APPEND_ITEMS = 200

export interface CreateImportAutoOcrTaskInput {
  engine: OcrEngine
  batchSize: number
  sourceImportJobId?: string | null
  nowMs?: number
}

export interface ImportAutoOcrItemInput {
  docId: string
  sourceOrder: number
  sourceType?: string | null
}

export interface ImportAutoOcrItem extends ImportAutoOcrItemInput {
  itemId: string
  ordinal: number
  status: string
}

function safeBatchSize(value: number): number {
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 1 || size > 200) throw new Error('import_auto_ocr_batch_size_invalid')
  return size
}

function safeEngine(value: OcrEngine): OcrEngine {
  if (value !== 'paddle' && value !== 'local_paddle' && value !== 'vision_model' && value !== 'hybrid') {
    throw new Error('import_auto_ocr_engine_invalid')
  }
  return value
}

function requireImportAutoOcrTask(jobId: string): TaskJobRecord {
  const job = getTaskJob(jobId)
  if (job.kind !== IMPORT_AUTO_OCR_TASK_KIND) throw new Error('import_auto_ocr_task_invalid')
  return job
}

export function createImportAutoOcrTask(input: CreateImportAutoOcrTaskInput): TaskJobRecord {
  const engine = safeEngine(input.engine)
  const batchSize = safeBatchSize(input.batchSize)
  const sourceImportJobId = String(input.sourceImportJobId || '').trim() || null
  return createTaskJob({
    kind: IMPORT_AUTO_OCR_TASK_KIND,
    settingsSnapshot: { engine, batchSize, sourceImportJobId },
    phase: 'staging',
    nowMs: input.nowMs,
  })
}

export function appendImportAutoOcrItems(
  jobId: string,
  items: ImportAutoOcrItemInput[],
  options?: { nowMs?: number },
): TaskJobRecord {
  requireImportAutoOcrTask(jobId)
  if (!Array.isArray(items)) throw new Error('import_auto_ocr_items_invalid')
  if (items.length > MAX_APPEND_ITEMS) throw new Error('import_auto_ocr_append_too_large')
  appendTaskItems(
    jobId,
    items.map((item) => {
      const docId = String(item.docId || '').trim()
      const sourceOrder = Number(item.sourceOrder)
      if (!docId) throw new Error('import_auto_ocr_doc_id_invalid')
      if (!Number.isSafeInteger(sourceOrder) || sourceOrder < 0) throw new Error('import_auto_ocr_source_order_invalid')
      return {
        idempotencyKey: `document:${docId}`,
        domainType: 'document',
        domainRef: docId,
        phase: 'queued',
        input: {
          docId,
          sourceOrder,
          sourceType: String(item.sourceType || '').trim() || null,
        },
      }
    }),
    options,
  )
  return getTaskJob(jobId)
}

export function getImportAutoOcrTask(jobId: string): TaskJobRecord {
  return requireImportAutoOcrTask(jobId)
}

export function listImportAutoOcrItems(jobId: string): ImportAutoOcrItem[] {
  requireImportAutoOcrTask(jobId)
  return queryAll<{
    id: string
    ordinal: number
    status: string
    domain_ref: string | null
    input_json: string
  }>(
    'SELECT id, ordinal, status, domain_ref, input_json FROM task_items WHERE job_id = ? ORDER BY ordinal, id',
    [jobId],
  ).map((row) => {
    let input: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(row.input_json || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
    } catch {
      input = {}
    }
    return {
      itemId: row.id,
      ordinal: Number(row.ordinal),
      status: row.status,
      docId: String(input.docId || row.domain_ref || ''),
      sourceOrder: Number(input.sourceOrder || 0),
      sourceType: String(input.sourceType || '').trim() || null,
    }
  })
}

export function listResumableImportAutoOcrTasks(): TaskJobRecord[] {
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM task_jobs
     WHERE kind = ? AND status IN ('queued', 'running')
     ORDER BY created_at, id`,
    [IMPORT_AUTO_OCR_TASK_KIND],
  )
  return rows.map((row) => getTaskJob(row.id))
}

export function recoverInterruptedImportAutoOcrTasks(nowMs = Date.now()): number {
  const interrupted = queryAll<{ item_id: string; attempt_id: string | null; job_id: string }>(
    `SELECT ti.id AS item_id, ti.active_attempt_id AS attempt_id, ti.job_id
     FROM task_items ti
     INNER JOIN task_jobs tj ON tj.id = ti.job_id
     WHERE tj.kind = ? AND ti.status = 'running'`,
    [IMPORT_AUTO_OCR_TASK_KIND],
  )
  if (interrupted.length === 0) return 0
  transaction(() => {
    interrupted.forEach((item) => {
      if (item.attempt_id) {
        run(
          "UPDATE task_attempts SET status = 'error', error_json = ?, finished_at = ? WHERE id = ? AND status = 'running'",
          [JSON.stringify({ code: 'app_restarted', message: '应用重启，任务等待续跑。', recoverable: true, recoveryAction: 'retry_task' }), nowMs, item.attempt_id],
        )
      }
      run(
        `UPDATE task_items SET status = 'queued', active_attempt_id = NULL, lease_owner = NULL, lease_token = NULL,
         leased_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_json = NULL, updated_at = ? WHERE id = ?`,
        [nowMs, item.item_id],
      )
      run(
        "UPDATE task_jobs SET status = 'queued', started_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'",
        [nowMs, item.job_id],
      )
    })
  })
  scheduleDatabaseSave()
  return interrupted.length
}
