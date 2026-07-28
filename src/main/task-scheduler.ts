import { nanoid } from 'nanoid'
import type {
  CursorPage,
  ErrorEnvelope,
  TaskArtifactRecord,
  TaskClaim,
  TaskCompletionKind,
  TaskEventRecord,
  TaskItemRecord,
  TaskJobRecord,
  TaskStatus,
} from '../shared/types'
import { validateErrorEnvelope } from '../shared/error-envelope'
import { isTaskStatus } from '../shared/task-contract'
import { queryAll, queryOne, run, scheduleDatabaseSave, transaction, transactionAsync } from './database'

const MAX_PAGE_SIZE = 200
const MAX_JSON_BYTES = 256 * 1024
const MAX_CURSOR_BYTES = 64 * 1024
const MAX_LEASE_MS = 24 * 60 * 60 * 1000

interface TaskJobRow {
  id: string
  kind: string
  status: string
  phase: string | null
  priority: number
  idempotency_key: string | null
  settings_snapshot_json: string
  total_count: number
  queued_count: number
  running_count: number
  completed_count: number
  error_count: number
  canceled_count: number
  completion_kind: string | null
  error_json: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
}

interface TaskItemRow {
  id: string
  job_id: string
  ordinal: number
  status: string
  phase: string | null
  idempotency_key: string | null
  domain_type: string | null
  domain_ref: string | null
  input_json: string
  cursor_json: string | null
  attempt_count: number
  active_attempt_id: string | null
  lease_owner: string | null
  lease_token: string | null
  lease_expires_at: number | null
  completion_kind: string | null
  error_json: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
}

interface TaskEventRow {
  id: number
  job_id: string
  item_id: string | null
  attempt_id: string | null
  event_type: string
  status: string | null
  phase: string | null
  payload_json: string
  created_at: number
}

interface TaskArtifactRow {
  seq: number
  id: string
  job_id: string
  item_id: string | null
  attempt_id: string | null
  kind: string
  ref: string
  version: number
  sha256: string | null
  idempotency_key: string | null
  metadata_json: string
  created_at: number
}

export interface CreateTaskJobInput {
  id?: string
  kind: string
  idempotencyKey?: string
  settingsSnapshot?: Record<string, unknown>
  priority?: number
  phase?: string
  nowMs?: number
}

export interface AppendTaskItemInput {
  id?: string
  idempotencyKey?: string
  domainType?: string
  domainRef?: string
  phase?: string
  input?: Record<string, unknown>
}

export interface TaskArtifactInput {
  id?: string
  jobId: string
  itemId?: string | null
  attemptId?: string | null
  kind: string
  ref: string
  version?: number
  sha256?: string | null
  idempotencyKey?: string | null
  metadata?: Record<string, unknown>
  nowMs?: number
}

function nowValue(value?: number): number {
  const now = value === undefined ? Date.now() : Number(value)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('task_time_invalid')
  return now
}

function requiredText(value: unknown, code: string, maxLength = 240): string {
  const text = String(value || '').trim()
  if (!text || text.length > maxLength) throw new Error(code)
  return text
}

function optionalText(value: unknown, code: string, maxLength = 500): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, code, maxLength)
}

function jsonRecord(value: Record<string, unknown> | undefined, code: string, maxBytes = MAX_JSON_BYTES): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value || {})
  } catch {
    throw new Error(code)
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(code)
  return serialized
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseNullableRecord(value: string | null | undefined): Record<string, unknown> | null {
  return value ? parseRecord(value) : null
}

function parseError(value: string | null | undefined): ErrorEnvelope | null {
  const parsed = parseNullableRecord(value)
  if (!parsed) return null
  try {
    return validateErrorEnvelope(parsed)
  } catch {
    return null
  }
}

function taskStatus(value: string): TaskStatus {
  if (!isTaskStatus(value)) throw new Error('task_status_invalid')
  return value
}

function completionKind(value: string | null): TaskCompletionKind | null {
  return value === 'full' || value === 'partial' ? value : null
}

function toTaskJob(row: TaskJobRow): TaskJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: taskStatus(row.status),
    phase: row.phase,
    priority: Number(row.priority || 0),
    idempotencyKey: row.idempotency_key,
    settingsSnapshot: parseRecord(row.settings_snapshot_json),
    totalCount: Number(row.total_count || 0),
    queuedCount: Number(row.queued_count || 0),
    runningCount: Number(row.running_count || 0),
    completedCount: Number(row.completed_count || 0),
    errorCount: Number(row.error_count || 0),
    canceledCount: Number(row.canceled_count || 0),
    completionKind: completionKind(row.completion_kind),
    error: parseError(row.error_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  }
}

function toTaskItem(row: TaskItemRow): TaskItemRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    ordinal: Number(row.ordinal),
    status: taskStatus(row.status),
    phase: row.phase,
    idempotencyKey: row.idempotency_key,
    domainType: row.domain_type,
    domainRef: row.domain_ref,
    input: parseRecord(row.input_json),
    cursor: parseNullableRecord(row.cursor_json),
    attemptCount: Number(row.attempt_count || 0),
    activeAttemptId: row.active_attempt_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    completionKind: completionKind(row.completion_kind),
    error: parseError(row.error_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  }
}

function addEvent(input: {
  jobId: string
  itemId?: string | null
  attemptId?: string | null
  eventType: string
  status?: TaskStatus | null
  phase?: string | null
  payload?: Record<string, unknown>
  nowMs: number
}): void {
  run(
    `INSERT INTO task_events (job_id, item_id, attempt_id, event_type, status, phase, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.jobId,
      input.itemId || null,
      input.attemptId || null,
      requiredText(input.eventType, 'task_event_type_invalid'),
      input.status || null,
      input.phase || null,
      jsonRecord(input.payload, 'task_event_payload_invalid'),
      input.nowMs,
    ],
  )
}

function refreshJobCounts(jobId: string, nowMs: number, settle = false): void {
  const counts = queryOne<{
    total_count: number
    queued_count: number
    running_count: number
    completed_count: number
    error_count: number
    canceled_count: number
  }>(
    `SELECT COUNT(*) AS total_count,
            SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
            SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled_count
       FROM task_items WHERE job_id = ?`,
    [jobId],
  )
  if (!counts) throw new Error('task_job_not_found')
  const values = {
    total: Number(counts.total_count || 0),
    queued: Number(counts.queued_count || 0),
    running: Number(counts.running_count || 0),
    completed: Number(counts.completed_count || 0),
    error: Number(counts.error_count || 0),
    canceled: Number(counts.canceled_count || 0),
  }
  run(
    `UPDATE task_jobs SET total_count = ?, queued_count = ?, running_count = ?, completed_count = ?,
       error_count = ?, canceled_count = ?, updated_at = ? WHERE id = ?`,
    [values.total, values.queued, values.running, values.completed, values.error, values.canceled, nowMs, jobId],
  )
  if (!settle || values.queued > 0 || values.running > 0) return
  if (values.error > 0) {
    run("UPDATE task_jobs SET status = 'error', completion_kind = NULL, completed_at = ? WHERE id = ?", [nowMs, jobId])
    return
  }
  if (values.total > 0 && values.completed === 0 && values.canceled > 0) {
    run("UPDATE task_jobs SET status = 'canceled', completion_kind = NULL, completed_at = ? WHERE id = ?", [nowMs, jobId])
    return
  }
  if (values.total > 0) {
    const kind: TaskCompletionKind = values.canceled > 0 ? 'partial' : 'full'
    run("UPDATE task_jobs SET status = 'completed', completion_kind = ?, completed_at = ? WHERE id = ?", [kind, nowMs, jobId])
  }
}

export function getTaskJob(jobId: string): TaskJobRecord {
  const row = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE id = ?', [requiredText(jobId, 'task_job_id_invalid')])
  if (!row) throw new Error('task_job_not_found')
  return toTaskJob(row)
}

export function getTaskItem(itemId: string): TaskItemRecord {
  const row = queryOne<TaskItemRow>('SELECT * FROM task_items WHERE id = ?', [requiredText(itemId, 'task_item_id_invalid')])
  if (!row) throw new Error('task_item_not_found')
  return toTaskItem(row)
}

export function createTaskJob(input: CreateTaskJobInput): TaskJobRecord {
  const kind = requiredText(input.kind, 'task_kind_invalid')
  const idempotencyKey = optionalText(input.idempotencyKey, 'task_idempotency_key_invalid')
  if (idempotencyKey) {
    const existing = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE kind = ? AND idempotency_key = ?', [kind, idempotencyKey])
    if (existing) return toTaskJob(existing)
  }
  const nowMs = nowValue(input.nowMs)
  const id = optionalText(input.id, 'task_job_id_invalid') || `task_${nanoid(20)}`
  const priority = Number(input.priority || 0)
  if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) throw new Error('task_priority_invalid')
  transaction(() => {
    run(
      `INSERT INTO task_jobs (id, kind, status, phase, priority, idempotency_key, settings_snapshot_json, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        kind,
        optionalText(input.phase, 'task_phase_invalid'),
        priority,
        idempotencyKey,
        jsonRecord(input.settingsSnapshot, 'task_settings_snapshot_invalid'),
        nowMs,
        nowMs,
      ],
    )
    addEvent({ jobId: id, eventType: 'job_created', status: 'queued', nowMs })
  })
  scheduleDatabaseSave()
  return getTaskJob(id)
}

export function appendTaskItems(jobIdValue: string, items: AppendTaskItemInput[], options?: { nowMs?: number }): TaskItemRecord[] {
  const jobId = requiredText(jobIdValue, 'task_job_id_invalid')
  if (!Array.isArray(items) || items.length === 0) return []
  if (items.length > MAX_PAGE_SIZE) throw new Error('task_item_batch_too_large')
  const nowMs = nowValue(options?.nowMs)
  const insertedIds: string[] = []
  transaction(() => {
    const job = queryOne<{ id: string; status: string }>('SELECT id, status FROM task_jobs WHERE id = ?', [jobId])
    if (!job) throw new Error('task_job_not_found')
    if (job.status === 'completed' || job.status === 'canceled') throw new Error('task_job_terminal')
    let ordinal = Number(queryOne<{ value: number }>('SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM task_items WHERE job_id = ?', [jobId])?.value || 0)
    items.forEach((item) => {
      const idempotencyKey = optionalText(item.idempotencyKey, 'task_idempotency_key_invalid')
      if (idempotencyKey) {
        const existing = queryOne<{ id: string }>('SELECT id FROM task_items WHERE job_id = ? AND idempotency_key = ?', [jobId, idempotencyKey])
        if (existing) return
      }
      const id = optionalText(item.id, 'task_item_id_invalid') || `item_${nanoid(20)}`
      run(
        `INSERT INTO task_items (id, job_id, ordinal, status, phase, idempotency_key, domain_type, domain_ref, input_json, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          jobId,
          ordinal,
          optionalText(item.phase, 'task_phase_invalid'),
          idempotencyKey,
          optionalText(item.domainType, 'task_domain_type_invalid'),
          optionalText(item.domainRef, 'task_domain_ref_invalid', 2000),
          jsonRecord(item.input, 'task_item_input_invalid'),
          nowMs,
          nowMs,
        ],
      )
      addEvent({ jobId, itemId: id, eventType: 'item_queued', status: 'queued', phase: item.phase, nowMs })
      insertedIds.push(id)
      ordinal += 1
    })
    refreshJobCounts(jobId, nowMs)
  })
  scheduleDatabaseSave()
  return insertedIds.map((id) => getTaskItem(id))
}

function recoverExpiredItems(jobId: string, nowMs: number): void {
  const expired = queryAll<TaskItemRow>(
    `SELECT * FROM task_items
     WHERE job_id = ? AND status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
     ORDER BY lease_expires_at, ordinal LIMIT ?`,
    [jobId, nowMs, MAX_PAGE_SIZE],
  )
  const error = JSON.stringify(validateErrorEnvelope({ code: 'task_lease_expired', message: '任务租约已过期，等待重新领取。', recoverable: true, recoveryAction: 'retry_task' }))
  expired.forEach((item) => {
    if (item.active_attempt_id) {
      run(
        "UPDATE task_attempts SET status = 'error', error_json = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        [error, nowMs, item.active_attempt_id],
      )
    }
    run(
      `UPDATE task_items SET status = 'queued', active_attempt_id = NULL, lease_owner = NULL, lease_token = NULL,
       leased_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_json = NULL, updated_at = ? WHERE id = ?`,
      [nowMs, item.id],
    )
    addEvent({ jobId, itemId: item.id, attemptId: item.active_attempt_id, eventType: 'lease_expired', status: 'queued', nowMs })
  })
}

export function claimTaskItems(input: {
  jobId: string
  workerId: string
  limit: number
  leaseMs: number
  nowMs?: number
}): TaskClaim[] {
  const jobId = requiredText(input.jobId, 'task_job_id_invalid')
  const workerId = requiredText(input.workerId, 'task_worker_id_invalid')
  const limit = Number(input.limit)
  const leaseMs = Number(input.leaseMs)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error('task_claim_limit_invalid')
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 50 || leaseMs > MAX_LEASE_MS) throw new Error('task_lease_duration_invalid')
  const nowMs = nowValue(input.nowMs)
  const claims: TaskClaim[] = []
  transaction(() => {
    const job = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE id = ?', [jobId])
    if (!job) throw new Error('task_job_not_found')
    if (job.status === 'paused' || job.status === 'completed' || job.status === 'error' || job.status === 'canceled') return
    recoverExpiredItems(jobId, nowMs)
    const rows = queryAll<TaskItemRow>(
      "SELECT * FROM task_items WHERE job_id = ? AND status = 'queued' ORDER BY ordinal, id LIMIT ?",
      [jobId, limit],
    )
    rows.forEach((row) => {
      const attemptNo = Number(row.attempt_count || 0) + 1
      const attemptId = `attempt_${nanoid(20)}`
      const leaseToken = `lease_${nanoid(28)}`
      const expiresAt = nowMs + leaseMs
      run(
        `INSERT INTO task_attempts (id, job_id, item_id, attempt_no, status, lease_owner, lease_token, cursor_json, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        [attemptId, jobId, row.id, attemptNo, workerId, leaseToken, row.cursor_json, nowMs, nowMs],
      )
      run(
        `UPDATE task_items SET status = 'running', attempt_count = ?, active_attempt_id = ?, lease_owner = ?, lease_token = ?,
         leased_at = ?, lease_expires_at = ?, heartbeat_at = ?, error_json = NULL, completion_kind = NULL,
         started_at = COALESCE(started_at, ?), completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`,
        [attemptNo, attemptId, workerId, leaseToken, nowMs, expiresAt, nowMs, nowMs, nowMs, row.id],
      )
      addEvent({ jobId, itemId: row.id, attemptId, eventType: 'item_claimed', status: 'running', phase: row.phase, payload: { workerId, attemptNo }, nowMs })
      claims.push({
        jobId,
        itemId: row.id,
        attemptId,
        attemptNo,
        leaseToken,
        leaseExpiresAt: expiresAt,
        domainType: row.domain_type,
        domainRef: row.domain_ref,
        input: parseRecord(row.input_json),
        cursor: parseNullableRecord(row.cursor_json),
      })
    })
    if (claims.length > 0) {
      run("UPDATE task_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?", [nowMs, nowMs, jobId])
    }
    refreshJobCounts(jobId, nowMs)
  })
  if (claims.length > 0) scheduleDatabaseSave()
  return claims
}

export function claimTaskItem(input: {
  itemId: string
  workerId: string
  leaseMs: number
  nowMs?: number
}): TaskClaim {
  const itemId = requiredText(input.itemId, 'task_item_id_invalid')
  const workerId = requiredText(input.workerId, 'task_worker_id_invalid')
  const leaseMs = Number(input.leaseMs)
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 50 || leaseMs > MAX_LEASE_MS) throw new Error('task_lease_duration_invalid')
  const nowMs = nowValue(input.nowMs)
  let claim: TaskClaim | null = null
  transaction(() => {
    let item = queryOne<TaskItemRow>('SELECT * FROM task_items WHERE id = ?', [itemId])
    if (!item) throw new Error('task_item_not_found')
    const job = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE id = ?', [item.job_id])
    if (!job) throw new Error('task_job_not_found')
    if (job.status === 'paused' || job.status === 'completed' || job.status === 'error' || job.status === 'canceled') {
      throw new Error('task_job_not_claimable')
    }
    if (item.status === 'running' && Number(item.lease_expires_at || -1) < nowMs) {
      recoverExpiredItems(item.job_id, nowMs)
      item = queryOne<TaskItemRow>('SELECT * FROM task_items WHERE id = ?', [itemId])
      if (!item) throw new Error('task_item_not_found')
    }
    if (item.status !== 'queued') throw new Error('task_item_not_claimable')
    const attemptNo = Number(item.attempt_count || 0) + 1
    const attemptId = `attempt_${nanoid(20)}`
    const leaseToken = `lease_${nanoid(28)}`
    const expiresAt = nowMs + leaseMs
    run(
      `INSERT INTO task_attempts (id, job_id, item_id, attempt_no, status, lease_owner, lease_token, cursor_json, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      [attemptId, item.job_id, item.id, attemptNo, workerId, leaseToken, item.cursor_json, nowMs, nowMs],
    )
    run(
      `UPDATE task_items SET status = 'running', attempt_count = ?, active_attempt_id = ?, lease_owner = ?, lease_token = ?,
       leased_at = ?, lease_expires_at = ?, heartbeat_at = ?, error_json = NULL, completion_kind = NULL,
       started_at = COALESCE(started_at, ?), completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`,
      [attemptNo, attemptId, workerId, leaseToken, nowMs, expiresAt, nowMs, nowMs, nowMs, item.id],
    )
    run("UPDATE task_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?", [nowMs, nowMs, item.job_id])
    addEvent({ jobId: item.job_id, itemId: item.id, attemptId, eventType: 'item_claimed', status: 'running', phase: item.phase, payload: { workerId, attemptNo }, nowMs })
    refreshJobCounts(item.job_id, nowMs)
    claim = {
      jobId: item.job_id,
      itemId: item.id,
      attemptId,
      attemptNo,
      leaseToken,
      leaseExpiresAt: expiresAt,
      domainType: item.domain_type,
      domainRef: item.domain_ref,
      input: parseRecord(item.input_json),
      cursor: parseNullableRecord(item.cursor_json),
    }
  })
  scheduleDatabaseSave()
  if (!claim) throw new Error('task_item_not_claimable')
  return claim
}

function requireActiveLease(itemId: string, leaseToken: string, nowMs: number): TaskItemRow {
  const item = queryOne<TaskItemRow>('SELECT * FROM task_items WHERE id = ?', [requiredText(itemId, 'task_item_id_invalid')])
  if (!item) throw new Error('task_item_not_found')
  if (item.status !== 'running' || item.lease_token !== requiredText(leaseToken, 'task_lease_token_invalid') || Number(item.lease_expires_at || -1) < nowMs) {
    throw new Error('task_lease_conflict')
  }
  return item
}

export function heartbeatTaskLease(input: { itemId: string; leaseToken: string; leaseMs: number; nowMs?: number }): number {
  const nowMs = nowValue(input.nowMs)
  const leaseMs = Number(input.leaseMs)
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 50 || leaseMs > MAX_LEASE_MS) throw new Error('task_lease_duration_invalid')
  const expiresAt = nowMs + leaseMs
  transaction(() => {
    const item = requireActiveLease(input.itemId, input.leaseToken, nowMs)
    run('UPDATE task_items SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?', [nowMs, expiresAt, nowMs, item.id])
    run("UPDATE task_attempts SET heartbeat_at = ? WHERE id = ? AND status = 'running'", [nowMs, item.active_attempt_id])
  })
  scheduleDatabaseSave()
  return expiresAt
}

export function updateTaskItemCursor(input: { itemId: string; leaseToken: string; cursor: Record<string, unknown>; nowMs?: number }): TaskItemRecord {
  const nowMs = nowValue(input.nowMs)
  const cursorJson = jsonRecord(input.cursor, 'task_cursor_invalid', MAX_CURSOR_BYTES)
  transaction(() => {
    const item = requireActiveLease(input.itemId, input.leaseToken, nowMs)
    run('UPDATE task_items SET cursor_json = ?, updated_at = ? WHERE id = ?', [cursorJson, nowMs, item.id])
    run("UPDATE task_attempts SET cursor_json = ?, heartbeat_at = ? WHERE id = ? AND status = 'running'", [cursorJson, nowMs, item.active_attempt_id])
    addEvent({ jobId: item.job_id, itemId: item.id, attemptId: item.active_attempt_id, eventType: 'cursor_committed', status: 'running', nowMs })
  })
  scheduleDatabaseSave()
  return getTaskItem(input.itemId)
}

export function releaseTaskItemLease(input: { itemId: string; leaseToken: string; nowMs?: number }): TaskItemRecord {
  const nowMs = nowValue(input.nowMs)
  let jobId = ''
  transaction(() => {
    const item = requireActiveLease(input.itemId, input.leaseToken, nowMs)
    jobId = item.job_id
    run("UPDATE task_attempts SET status = 'paused', finished_at = ? WHERE id = ? AND status = 'running'", [nowMs, item.active_attempt_id])
    run(
      `UPDATE task_items SET status = 'queued', active_attempt_id = NULL, lease_owner = NULL, lease_token = NULL,
       leased_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?`,
      [nowMs, item.id],
    )
    const job = queryOne<{ status: string }>('SELECT status FROM task_jobs WHERE id = ?', [jobId])
    if (job?.status === 'running') run("UPDATE task_jobs SET status = 'queued', updated_at = ? WHERE id = ?", [nowMs, jobId])
    addEvent({ jobId, itemId: item.id, attemptId: item.active_attempt_id, eventType: 'lease_released', status: 'queued', nowMs })
    refreshJobCounts(jobId, nowMs)
  })
  scheduleDatabaseSave()
  return getTaskItem(input.itemId)
}

export function completeTaskItem(input: { itemId: string; leaseToken: string; completionKind?: TaskCompletionKind; nowMs?: number }): TaskItemRecord {
  const nowMs = nowValue(input.nowMs)
  const kind = input.completionKind || 'full'
  if (kind !== 'full' && kind !== 'partial') throw new Error('completion_kind_invalid')
  let jobId = ''
  transaction(() => {
    const item = requireActiveLease(input.itemId, input.leaseToken, nowMs)
    jobId = item.job_id
    run("UPDATE task_attempts SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'", [nowMs, item.active_attempt_id])
    run(
      `UPDATE task_items SET status = 'completed', completion_kind = ?, error_json = NULL, active_attempt_id = NULL,
       lease_owner = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
       completed_at = ?, updated_at = ? WHERE id = ?`,
      [kind, nowMs, nowMs, item.id],
    )
    addEvent({ jobId, itemId: item.id, attemptId: item.active_attempt_id, eventType: 'item_completed', status: 'completed', nowMs })
    refreshJobCounts(jobId, nowMs, true)
  })
  scheduleDatabaseSave()
  return getTaskItem(input.itemId)
}

export function failTaskItem(input: { itemId: string; leaseToken: string; error: ErrorEnvelope; nowMs?: number }): TaskItemRecord {
  const nowMs = nowValue(input.nowMs)
  const error = validateErrorEnvelope(input.error)
  const errorJson = JSON.stringify(error)
  let jobId = ''
  transaction(() => {
    const item = requireActiveLease(input.itemId, input.leaseToken, nowMs)
    jobId = item.job_id
    run("UPDATE task_attempts SET status = 'error', error_json = ?, finished_at = ? WHERE id = ? AND status = 'running'", [errorJson, nowMs, item.active_attempt_id])
    run(
      `UPDATE task_items SET status = 'error', completion_kind = NULL, error_json = ?, active_attempt_id = NULL,
       lease_owner = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
       completed_at = ?, updated_at = ? WHERE id = ?`,
      [errorJson, nowMs, nowMs, item.id],
    )
    addEvent({ jobId, itemId: item.id, attemptId: item.active_attempt_id, eventType: 'item_failed', status: 'error', payload: { error }, nowMs })
    refreshJobCounts(jobId, nowMs, true)
  })
  scheduleDatabaseSave()
  return getTaskItem(input.itemId)
}

export function retryTaskItem(itemIdValue: string, options?: { nowMs?: number }): TaskItemRecord {
  const itemId = requiredText(itemIdValue, 'task_item_id_invalid')
  const nowMs = nowValue(options?.nowMs)
  let jobId = ''
  transaction(() => {
    const item = queryOne<TaskItemRow>('SELECT * FROM task_items WHERE id = ?', [itemId])
    if (!item) throw new Error('task_item_not_found')
    if (item.status !== 'error') throw new Error('task_item_not_retryable')
    jobId = item.job_id
    run("UPDATE task_items SET status = 'queued', error_json = NULL, completed_at = NULL, updated_at = ? WHERE id = ?", [nowMs, itemId])
    run("UPDATE task_jobs SET status = 'queued', completion_kind = NULL, error_json = NULL, completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'error'", [nowMs, jobId])
    addEvent({ jobId, itemId, eventType: 'item_retried', status: 'queued', nowMs })
    refreshJobCounts(jobId, nowMs)
  })
  scheduleDatabaseSave()
  return getTaskItem(itemId)
}

export function pauseTaskJob(jobIdValue: string, options?: { nowMs?: number }): TaskJobRecord {
  const jobId = requiredText(jobIdValue, 'task_job_id_invalid')
  const nowMs = nowValue(options?.nowMs)
  transaction(() => {
    const job = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE id = ?', [jobId])
    if (!job) throw new Error('task_job_not_found')
    if (job.status === 'completed' || job.status === 'canceled') throw new Error('task_job_terminal')
    run("UPDATE task_jobs SET status = 'paused', updated_at = ? WHERE id = ?", [nowMs, jobId])
    addEvent({ jobId, eventType: 'job_paused', status: 'paused', nowMs })
  })
  scheduleDatabaseSave()
  return getTaskJob(jobId)
}

export function resumeTaskJob(jobIdValue: string, options?: { nowMs?: number }): TaskJobRecord {
  const jobId = requiredText(jobIdValue, 'task_job_id_invalid')
  const nowMs = nowValue(options?.nowMs)
  transaction(() => {
    const job = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE id = ?', [jobId])
    if (!job) throw new Error('task_job_not_found')
    if (job.status !== 'paused') throw new Error('task_job_not_paused')
    const running = Number(job.running_count || 0) > 0
    run('UPDATE task_jobs SET status = ?, updated_at = ? WHERE id = ?', [running ? 'running' : 'queued', nowMs, jobId])
    addEvent({ jobId, eventType: 'job_resumed', status: running ? 'running' : 'queued', nowMs })
  })
  scheduleDatabaseSave()
  return getTaskJob(jobId)
}

function cancelTaskJobInCurrentTransaction(jobId: string, nowMs: number): void {
  const job = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE id = ?', [jobId])
  if (!job) throw new Error('task_job_not_found')
  if (job.status === 'completed') throw new Error('task_job_terminal')
  run(
    `UPDATE task_attempts SET status = 'canceled', finished_at = ?
     WHERE job_id = ? AND status = 'running'`,
    [nowMs, jobId],
  )
  run(
    `UPDATE task_items SET status = 'canceled', completion_kind = NULL, active_attempt_id = NULL,
     lease_owner = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
     completed_at = ?, updated_at = ?
     WHERE job_id = ? AND status IN ('queued', 'running', 'paused', 'error')`,
    [nowMs, nowMs, jobId],
  )
  run("UPDATE task_jobs SET status = 'canceled', completion_kind = NULL, completed_at = ?, updated_at = ? WHERE id = ?", [nowMs, nowMs, jobId])
  addEvent({ jobId, eventType: 'job_canceled', status: 'canceled', nowMs })
  refreshJobCounts(jobId, nowMs)
}

export function cancelTaskJob(jobIdValue: string, options?: { nowMs?: number }): TaskJobRecord {
  const jobId = requiredText(jobIdValue, 'task_job_id_invalid')
  const nowMs = nowValue(options?.nowMs)
  transaction(() => cancelTaskJobInCurrentTransaction(jobId, nowMs))
  scheduleDatabaseSave()
  return getTaskJob(jobId)
}

export async function cancelTaskJobAsync(jobIdValue: string, options?: { nowMs?: number }): Promise<TaskJobRecord> {
  const jobId = requiredText(jobIdValue, 'task_job_id_invalid')
  const nowMs = nowValue(options?.nowMs)
  await transactionAsync(() => cancelTaskJobInCurrentTransaction(jobId, nowMs))
  scheduleDatabaseSave()
  return getTaskJob(jobId)
}

function pageLimit(value: number | undefined): number {
  const limit = value === undefined ? 50 : Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error('task_page_limit_invalid')
  return limit
}

function numericCursor(value: string | null | undefined): number {
  if (!value) return 0
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('task_cursor_invalid')
  return cursor
}

export function listTaskEvents(input: { jobId: string; limit?: number; cursor?: string | null }): CursorPage<TaskEventRecord> {
  const jobId = requiredText(input.jobId, 'task_job_id_invalid')
  const limit = pageLimit(input.limit)
  const cursor = numericCursor(input.cursor)
  const rows = queryAll<TaskEventRow>('SELECT * FROM task_events WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?', [jobId, cursor, limit + 1])
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => ({
      id: Number(row.id),
      jobId: row.job_id,
      itemId: row.item_id,
      attemptId: row.attempt_id,
      eventType: row.event_type,
      status: row.status ? taskStatus(row.status) : null,
      phase: row.phase,
      payload: parseRecord(row.payload_json),
      createdAt: Number(row.created_at),
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  }
}

function toTaskArtifact(row: TaskArtifactRow): TaskArtifactRecord {
  return {
    id: row.id,
    sequence: Number(row.seq),
    jobId: row.job_id,
    itemId: row.item_id,
    attemptId: row.attempt_id,
    kind: row.kind,
    ref: row.ref,
    version: Number(row.version),
    sha256: row.sha256,
    idempotencyKey: row.idempotency_key,
    metadata: parseRecord(row.metadata_json),
    createdAt: Number(row.created_at),
  }
}

export function addTaskArtifact(input: TaskArtifactInput): TaskArtifactRecord {
  const jobId = requiredText(input.jobId, 'task_job_id_invalid')
  const key = optionalText(input.idempotencyKey, 'task_idempotency_key_invalid')
  const kind = requiredText(input.kind, 'task_artifact_kind_invalid')
  const ref = requiredText(input.ref, 'task_artifact_ref_invalid', 4000)
  const version = input.version === undefined ? 1 : Number(input.version)
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('task_artifact_version_invalid')
  const sha256 = optionalText(input.sha256, 'task_artifact_hash_invalid', 128)
  if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('task_artifact_hash_invalid')
  if (key) {
    const existing = queryOne<TaskArtifactRow>('SELECT * FROM task_artifacts WHERE job_id = ? AND idempotency_key = ?', [jobId, key])
    if (existing) {
      if (existing.kind !== kind || existing.ref !== ref || Number(existing.version) !== version || (existing.sha256 || null) !== sha256) {
        throw new Error('task_artifact_immutable')
      }
      return toTaskArtifact(existing)
    }
  }
  const nowMs = nowValue(input.nowMs)
  const id = optionalText(input.id, 'task_artifact_id_invalid') || `artifact_${nanoid(20)}`
  transaction(() => {
    if (!queryOne('SELECT id FROM task_jobs WHERE id = ?', [jobId])) throw new Error('task_job_not_found')
    if (input.itemId && !queryOne('SELECT id FROM task_items WHERE id = ? AND job_id = ?', [input.itemId, jobId])) throw new Error('task_artifact_item_invalid')
    if (input.attemptId && !queryOne('SELECT id FROM task_attempts WHERE id = ? AND job_id = ?', [input.attemptId, jobId])) throw new Error('task_artifact_attempt_invalid')
    run(
      `INSERT INTO task_artifacts (id, job_id, item_id, attempt_id, kind, ref, version, sha256, idempotency_key, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, jobId, input.itemId || null, input.attemptId || null, kind, ref, version, sha256, key, jsonRecord(input.metadata, 'task_artifact_metadata_invalid'), nowMs],
    )
    addEvent({ jobId, itemId: input.itemId, attemptId: input.attemptId, eventType: 'artifact_created', payload: { artifactId: id, kind, version }, nowMs })
  })
  scheduleDatabaseSave()
  const created = queryOne<TaskArtifactRow>('SELECT * FROM task_artifacts WHERE id = ?', [id])
  if (!created) throw new Error('task_artifact_not_found')
  return toTaskArtifact(created)
}

export function listTaskArtifacts(input: { jobId: string; limit?: number; cursor?: string | null }): CursorPage<TaskArtifactRecord> {
  const jobId = requiredText(input.jobId, 'task_job_id_invalid')
  const limit = pageLimit(input.limit)
  const cursor = numericCursor(input.cursor)
  const rows = queryAll<TaskArtifactRow>('SELECT * FROM task_artifacts WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?', [jobId, cursor, limit + 1])
  const page = rows.slice(0, limit)
  return {
    items: page.map(toTaskArtifact),
    nextCursor: rows.length > limit ? String(page[page.length - 1].seq) : null,
  }
}

function legacyStatus(value: string): TaskStatus {
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'error'
  return 'queued'
}

export function bridgeLegacyBatchQueue(options?: { nowMs?: number }): { jobsCreated: number; itemsCreated: number; itemsReused: number } {
  const nowMs = nowValue(options?.nowMs)
  const summary = { jobsCreated: 0, itemsCreated: 0, itemsReused: 0 }
  let cursor = 0
  while (true) {
    const rows = queryAll<{
      rowid: number
      id: string
      batch_id: string
      doc_id: string
      status: string
      batch_size: number | null
      error_message: string | null
    }>(
      `SELECT rowid, id, batch_id, doc_id, status, batch_size, error_message FROM batch_queue
       WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [cursor, MAX_PAGE_SIZE],
    )
    if (rows.length === 0) break
    transaction(() => {
      const touchedJobs = new Set<string>()
      rows.forEach((row) => {
        const batchId = requiredText(row.batch_id || 'default', 'legacy_batch_id_invalid')
        const jobKey = `legacy:batch_queue:${batchId}`
        let job = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE kind = ? AND idempotency_key = ?', ['ocr.batch', jobKey])
        if (!job) {
          const jobId = `task_${nanoid(20)}`
          run(
            `INSERT INTO task_jobs (id, kind, status, idempotency_key, settings_snapshot_json, created_at, updated_at)
             VALUES (?, 'ocr.batch', 'queued', ?, ?, ?, ?)`,
            [jobId, jobKey, jsonRecord({ legacyBatchId: batchId, batchSize: Number(row.batch_size || 5) || 5 }, 'task_settings_snapshot_invalid'), nowMs, nowMs],
          )
          addEvent({ jobId, eventType: 'legacy_job_bridged', status: 'queued', payload: { source: 'batch_queue' }, nowMs })
          job = queryOne<TaskJobRow>('SELECT * FROM task_jobs WHERE id = ?', [jobId])
          summary.jobsCreated += 1
        }
        if (!job) throw new Error('task_job_not_found')
        touchedJobs.add(job.id)
        const itemKey = `legacy:batch_queue:${row.id}`
        const existing = queryOne<{ id: string }>('SELECT id FROM task_items WHERE job_id = ? AND idempotency_key = ?', [job.id, itemKey])
        if (existing) {
          summary.itemsReused += 1
          return
        }
        const ordinal = Number(queryOne<{ value: number }>('SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM task_items WHERE job_id = ?', [job.id])?.value || 0)
        const status = legacyStatus(String(row.status || 'pending'))
        const error = status === 'error'
          ? validateErrorEnvelope({ code: 'legacy_batch_failed', message: row.error_message || '旧批处理任务失败。', recoverable: true, recoveryAction: 'retry_task' })
          : null
        const itemId = `item_${nanoid(20)}`
        run(
          `INSERT INTO task_items (id, job_id, ordinal, status, idempotency_key, domain_type, domain_ref, input_json,
           completion_kind, error_json, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, 'document', ?, ?, ?, ?, ?, ?, ?)`,
          [
            itemId,
            job.id,
            ordinal,
            status,
            itemKey,
            row.doc_id,
            jsonRecord({ docId: row.doc_id, legacyQueueItemId: row.id }, 'task_item_input_invalid'),
            status === 'completed' ? 'full' : null,
            error ? JSON.stringify(error) : null,
            nowMs,
            nowMs,
            status === 'completed' || status === 'error' ? nowMs : null,
          ],
        )
        addEvent({ jobId: job.id, itemId, eventType: 'legacy_item_bridged', status, payload: { source: 'batch_queue' }, nowMs })
        summary.itemsCreated += 1
      })
      touchedJobs.forEach((jobId) => refreshJobCounts(jobId, nowMs, true))
    })
    cursor = Number(rows[rows.length - 1].rowid)
  }
  if (summary.jobsCreated > 0 || summary.itemsCreated > 0) scheduleDatabaseSave()
  return summary
}
