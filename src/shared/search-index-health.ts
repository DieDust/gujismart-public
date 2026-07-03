import type { SearchIndexStatus } from './types'

export type SearchIndexHealthStatus = 'ready' | 'queued' | 'processing' | 'stale' | 'error' | 'unknown'
export type SearchIndexHealthSeverity = 'info' | 'warning' | 'error'

export interface SearchIndexHealthIssue {
  code: string
  severity: SearchIndexHealthSeverity
  message: string
  recoverable: boolean
  action_hint?: string
}

export interface SearchIndexHealthDiagnostics {
  status: SearchIndexHealthStatus
  is_usable: boolean
  is_stale: boolean
  source_hash_present: boolean
  segment_count: number
  issue_count: number
  error_count: number
  warning_count: number
  issues: SearchIndexHealthIssue[]
  indexed_at?: string
  updated_at?: string
}

function normalizeStatus(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim()
}

function finiteCount(value: unknown): number {
  const count = Number(value)
  if (!Number.isFinite(count)) return 0
  return Math.max(0, Math.floor(count))
}

function makeIssue(
  code: string,
  severity: SearchIndexHealthSeverity,
  message: string,
  recoverable = true,
  actionHint?: string,
): SearchIndexHealthIssue {
  return {
    code,
    severity,
    message,
    recoverable,
    ...(actionHint ? { action_hint: actionHint } : {}),
  }
}

export function buildSearchIndexHealthDiagnostics(
  payload?: Partial<SearchIndexStatus> | null,
): SearchIndexHealthDiagnostics {
  const rawStatus = normalizeStatus(payload?.status)
  const sourceHash = normalizeText(payload?.source_hash)
  const errorMessage = normalizeText(payload?.error_message)
  const segmentCount = finiteCount(payload?.segment_count)
  const issues: SearchIndexHealthIssue[] = []

  if (!payload) {
    issues.push(makeIssue('search_index_status_missing', 'warning', 'Search index status row is missing.', true, 'queue_document_reindex'))
  }
  if (errorMessage || rawStatus === 'error') {
    issues.push(makeIssue('search_index_error', 'error', errorMessage || 'Search index is in an error state.', true, 'queue_document_reindex'))
  }
  if (rawStatus === 'ready' && segmentCount <= 0) {
    issues.push(makeIssue('search_index_ready_without_segments', 'error', 'Search index is marked ready but has no stored segments.', true, 'queue_document_reindex'))
  }
  if (rawStatus === 'ready' && !sourceHash) {
    issues.push(makeIssue('search_index_source_hash_missing', 'warning', 'Search index is ready but has no source hash.', true, 'queue_document_reindex'))
  }
  if (rawStatus === 'ready' && !normalizeText(payload?.indexed_at)) {
    issues.push(makeIssue('search_index_indexed_at_missing', 'warning', 'Search index is ready but has no indexed timestamp.'))
  }
  if ((rawStatus === 'queued' || rawStatus === 'processing') && segmentCount > 0) {
    issues.push(makeIssue('search_index_refresh_pending', 'info', 'Search index has existing segments and a refresh is pending.'))
  }
  if (rawStatus && !['ready', 'queued', 'processing', 'pending', 'error'].includes(rawStatus)) {
    issues.push(makeIssue('search_index_status_unknown', 'warning', 'Search index status is not recognized.'))
  }

  const staleByArtifacts = rawStatus !== 'ready' && (sourceHash !== '' || segmentCount > 0)
  const staleByReadyGap = rawStatus === 'ready' && segmentCount <= 0
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const status: SearchIndexHealthStatus = errorCount > 0
    ? 'error'
    : staleByArtifacts || staleByReadyGap
      ? 'stale'
      : rawStatus === 'ready'
        ? 'ready'
        : rawStatus === 'queued'
          ? 'queued'
          : rawStatus === 'processing'
            ? 'processing'
            : 'unknown'

  return {
    status,
    is_usable: status === 'ready',
    is_stale: staleByArtifacts || staleByReadyGap,
    source_hash_present: sourceHash !== '',
    segment_count: segmentCount,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues,
    ...(normalizeText(payload?.indexed_at) ? { indexed_at: normalizeText(payload?.indexed_at) } : {}),
    ...(normalizeText(payload?.updated_at) ? { updated_at: normalizeText(payload?.updated_at) } : {}),
  }
}
