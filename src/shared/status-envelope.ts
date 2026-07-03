import type {
  AiResearchRunProgressEvent,
  ImportProgressEvent,
  OcrProgressEvent,
  SearchIndexStatus,
  StatusEnvelope,
} from './types'

export function clampStatusProgress(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const progress = Number(value)
  if (!Number.isFinite(progress)) return undefined
  return Math.max(0, Math.min(1, progress))
}

function normalizeErrorCode(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function buildStatusEnvelope(payload: {
  status: string
  phase?: string | null
  progress?: unknown
  errorMessage?: string | null
  errorCode?: string | null
  message?: string | null
  recoverable?: boolean
  actionHint?: string | null
  updatedAt?: string | null
}): StatusEnvelope {
  const status = String(payload.status || '').trim() || 'unknown'
  const phase = String(payload.phase || '').trim()
  const message = String(payload.message || payload.errorMessage || '').trim()
  const errorMessage = String(payload.errorMessage || '').trim()
  const explicitErrorCode = String(payload.errorCode || '').trim()
  const isError = status === 'error' || status === 'failed' || Boolean(errorMessage)
  return {
    status,
    ...(phase ? { phase } : {}),
    ...(payload.progress !== undefined ? { progress: clampStatusProgress(payload.progress) } : {}),
    ...(isError ? { error_code: explicitErrorCode || normalizeErrorCode(phase || status || 'error') || 'error' } : {}),
    ...(message ? { message } : {}),
    recoverable: payload.recoverable ?? !isError,
    ...(payload.actionHint ? { action_hint: String(payload.actionHint).trim() } : {}),
    ...(payload.updatedAt ? { updated_at: String(payload.updatedAt) } : {}),
  }
}

export function statusEnvelopeFromOcrProgress(payload: OcrProgressEvent): StatusEnvelope {
  const status = payload.canceled ? 'canceled' : String(payload.status || payload.phase || 'unknown')
  const errorMessage = payload.errorMessage || (status === 'error' ? payload.message || null : null)
  return buildStatusEnvelope({
    status,
    phase: payload.phase || payload.aiStatus || null,
    progress: payload.progress,
    message: payload.message || null,
    errorMessage,
    recoverable: status !== 'error' && !payload.canceled,
    actionHint: status === 'error' ? 'review_ocr_settings_or_retry' : null,
  })
}

export function statusEnvelopeFromImportProgress(payload: ImportProgressEvent): StatusEnvelope {
  return buildStatusEnvelope({
    status: payload.phase === 'stored' ? 'completed' : 'processing',
    phase: payload.phase,
    progress: payload.progress,
    message: payload.fileName,
    recoverable: true,
  })
}

export function statusEnvelopeFromSearchIndexStatus(payload: SearchIndexStatus): StatusEnvelope {
  return buildStatusEnvelope({
    status: payload.status,
    phase: 'search_index',
    progress: payload.status === 'ready' ? 1 : payload.status === 'queued' ? 0 : undefined,
    message: payload.error_message || null,
    errorMessage: payload.error_message || null,
    recoverable: payload.status !== 'error',
    actionHint: payload.status === 'error' ? 'rebuild_search_index' : null,
    updatedAt: payload.updated_at || null,
  })
}

export function statusEnvelopeFromAiResearchProgress(payload: AiResearchRunProgressEvent): StatusEnvelope {
  return buildStatusEnvelope({
    status: payload.phase === 'reporting' && payload.progress >= 1 ? 'completed' : 'processing',
    phase: payload.phase,
    progress: payload.progress,
    message: payload.message,
    recoverable: true,
  })
}
