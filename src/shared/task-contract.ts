import type { ErrorEnvelope, TaskCompletionKind, TaskStateEnvelope, TaskStatus } from './types'
import { createErrorEnvelope } from './error-envelope'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'paused',
  'completed',
  'error',
  'canceled',
]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus)
}

export function normalizeLegacyTaskStatus(value: unknown): TaskStatus {
  const status = String(value || '').trim().toLowerCase()
  if (isTaskStatus(status)) return status
  if (status === 'pending') return 'queued'
  if (status === 'processing' || status === 'in_progress') return 'running'
  if (status === 'failed') return 'error'
  if (status === 'cancelled') return 'canceled'
  throw new Error('task_status_invalid')
}

function nonNegativeInteger(value: unknown, code: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(code)
  return parsed
}

export function validateTaskStateEnvelope(value: TaskStateEnvelope | Record<string, unknown>): TaskStateEnvelope {
  const taskId = String(value.taskId || '').trim()
  const kind = String(value.kind || '').trim()
  if (!taskId) throw new Error('task_id_required')
  if (!kind) throw new Error('task_kind_required')
  if (!isTaskStatus(value.status)) throw new Error('task_status_invalid')

  const progress = value.progress === undefined ? undefined : Number(value.progress)
  if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 1)) {
    throw new Error('task_progress_invalid')
  }
  const committedCount = nonNegativeInteger(value.committedCount, 'task_committed_count_invalid')
  const totalCount = nonNegativeInteger(value.totalCount, 'task_total_count_invalid')
  if (committedCount !== undefined && totalCount !== undefined && committedCount > totalCount) {
    throw new Error('task_committed_count_exceeds_total')
  }
  const completionKind = value.completionKind === undefined ? undefined : String(value.completionKind)
  if (completionKind !== undefined && value.status !== 'completed') {
    throw new Error('completion_kind_requires_completed')
  }
  if (completionKind !== undefined && !['full', 'partial'].includes(completionKind)) {
    throw new Error('completion_kind_invalid')
  }

  return {
    taskId,
    kind,
    status: value.status,
    ...(value.phase ? { phase: String(value.phase) } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(committedCount !== undefined ? { committedCount } : {}),
    ...(totalCount !== undefined ? { totalCount } : {}),
    ...(completionKind ? { completionKind: completionKind as TaskCompletionKind } : {}),
    ...(value.blockedReason ? { blockedReason: String(value.blockedReason) } : {}),
    ...(value.recoveryAction ? { recoveryAction: String(value.recoveryAction) } : {}),
    ...(value.error ? { error: value.error as ErrorEnvelope } : {}),
    ...(value.updatedAt ? { updatedAt: String(value.updatedAt) } : {}),
  }
}

export function taskStateFromLegacyBackgroundEvent(value: {
  taskId: string
  kind: string
  status: string
  progress?: number
  message?: string
  totalCount?: number
  completedCount?: number
  errorMessage?: string
  updatedAt?: string
}): TaskStateEnvelope {
  const status = normalizeLegacyTaskStatus(value.status)
  return validateTaskStateEnvelope({
    taskId: value.taskId,
    kind: value.kind,
    status,
    ...(value.progress !== undefined ? { progress: Math.max(0, Math.min(1, Number(value.progress))) } : {}),
    ...(value.completedCount !== undefined ? { committedCount: value.completedCount } : {}),
    ...(value.totalCount !== undefined ? { totalCount: value.totalCount } : {}),
    ...(status === 'completed' ? { completionKind: 'full' as const } : {}),
    ...(status === 'error' && value.errorMessage ? {
      error: createErrorEnvelope({ code: 'background_task_error', message: value.errorMessage, recoverable: true }),
      recoveryAction: 'retry_task',
    } : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  })
}
