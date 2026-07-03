import type { ImportProgressEvent } from './types'

export type DocumentPipelineStage = 'import' | 'storage' | 'ocr' | 'proof' | 'metadata' | 'search'
export type DocumentPipelineDiagnosticSeverity = 'info' | 'warning' | 'error'
export type DocumentPipelineStatus = 'ready' | 'processing' | 'needs_attention' | 'error' | 'unknown'

export interface DocumentPipelineDiagnosticIssue {
  code: string
  severity: DocumentPipelineDiagnosticSeverity
  stage: DocumentPipelineStage
  message: string
  recoverable: boolean
  action_hint?: string
}

export interface DocumentPipelineStatusSnapshot {
  import_status?: string | null
  ocr_status?: string | null
  proof_status?: string | null
  metadata_status?: string | null
  page_count?: number | null
  completed_page_count?: number | null
  failed_page_count?: number | null
  pending_page_count?: number | null
}

export interface DocumentPipelineDiagnostics {
  status: DocumentPipelineStatus
  current_stage: DocumentPipelineStage
  issue_count: number
  error_count: number
  warning_count: number
  recoverable: boolean
  issues: DocumentPipelineDiagnosticIssue[]
  snapshot: DocumentPipelineStatusSnapshot
  updated_at: string
}

function normalizeStatus(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function finiteCount(value: unknown): number | undefined {
  const count = Number(value)
  if (!Number.isFinite(count)) return undefined
  return Math.max(0, Math.floor(count))
}

function clampProgress(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const progress = Number(value)
  if (!Number.isFinite(progress)) return undefined
  return Math.max(0, Math.min(1, progress))
}

function makeIssue(
  code: string,
  severity: DocumentPipelineDiagnosticSeverity,
  stage: DocumentPipelineStage,
  message: string,
  recoverable = true,
  actionHint?: string,
): DocumentPipelineDiagnosticIssue {
  return {
    code,
    severity,
    stage,
    message,
    recoverable,
    ...(actionHint ? { action_hint: actionHint } : {}),
  }
}

function summarizeIssues(
  currentStage: DocumentPipelineStage,
  snapshot: DocumentPipelineStatusSnapshot,
  issues: DocumentPipelineDiagnosticIssue[],
  updatedAt: string,
): DocumentPipelineDiagnostics {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const status: DocumentPipelineStatus = errorCount > 0
    ? 'error'
    : warningCount > 0
      ? 'needs_attention'
      : currentStage === 'storage' && normalizeStatus(snapshot.import_status) === 'processed'
        ? 'ready'
        : currentStage === 'storage' && normalizeStatus(snapshot.import_status) === 'stored'
          ? 'ready'
          : currentStage === 'import' || currentStage === 'ocr' || currentStage === 'metadata' || currentStage === 'proof'
            ? 'processing'
            : 'unknown'

  return {
    status,
    current_stage: currentStage,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    recoverable: issues.every((issue) => issue.recoverable),
    issues,
    snapshot,
    updated_at: updatedAt,
  }
}

function stageFromSnapshot(snapshot: DocumentPipelineStatusSnapshot): DocumentPipelineStage {
  const importStatus = normalizeStatus(snapshot.import_status)
  const ocrStatus = normalizeStatus(snapshot.ocr_status)
  const proofStatus = normalizeStatus(snapshot.proof_status)
  const metadataStatus = normalizeStatus(snapshot.metadata_status)

  if (importStatus && !['processed', 'stored'].includes(importStatus)) return 'import'
  if (ocrStatus && !['completed'].includes(ocrStatus)) return 'ocr'
  if (proofStatus && !['completed'].includes(proofStatus)) return 'proof'
  if (metadataStatus && !['confirmed', 'auto'].includes(metadataStatus)) return 'metadata'
  return 'storage'
}

export function buildDocumentPipelineDiagnostics(
  snapshot: DocumentPipelineStatusSnapshot,
  updatedAt = new Date().toISOString(),
): DocumentPipelineDiagnostics {
  const pageCount = finiteCount(snapshot.page_count)
  const completedPageCount = finiteCount(snapshot.completed_page_count)
  const failedPageCount = finiteCount(snapshot.failed_page_count)
  const pendingPageCount = finiteCount(snapshot.pending_page_count)
  const normalizedSnapshot: DocumentPipelineStatusSnapshot = {
    ...(snapshot.import_status !== undefined ? { import_status: normalizeStatus(snapshot.import_status) || null } : {}),
    ...(snapshot.ocr_status !== undefined ? { ocr_status: normalizeStatus(snapshot.ocr_status) || null } : {}),
    ...(snapshot.proof_status !== undefined ? { proof_status: normalizeStatus(snapshot.proof_status) || null } : {}),
    ...(snapshot.metadata_status !== undefined ? { metadata_status: normalizeStatus(snapshot.metadata_status) || null } : {}),
    ...(pageCount !== undefined ? { page_count: pageCount } : {}),
    ...(completedPageCount !== undefined ? { completed_page_count: completedPageCount } : {}),
    ...(failedPageCount !== undefined ? { failed_page_count: failedPageCount } : {}),
    ...(pendingPageCount !== undefined ? { pending_page_count: pendingPageCount } : {}),
  }
  const issues: DocumentPipelineDiagnosticIssue[] = []
  const importStatus = normalizeStatus(normalizedSnapshot.import_status)
  const ocrStatus = normalizeStatus(normalizedSnapshot.ocr_status)
  const proofStatus = normalizeStatus(normalizedSnapshot.proof_status)
  const metadataStatus = normalizeStatus(normalizedSnapshot.metadata_status)

  if (importStatus === 'error') {
    issues.push(makeIssue('import_error', 'error', 'import', 'Document import is in an error state.', true, 'retry_import_or_check_source_file'))
  } else if (importStatus && !['processed', 'stored'].includes(importStatus)) {
    issues.push(makeIssue('import_incomplete', 'warning', 'import', 'Document import has not reached the processed state yet.'))
  }

  if (ocrStatus === 'error') {
    issues.push(makeIssue('ocr_error', 'error', 'ocr', 'OCR is in an error state.', true, 'retry_ocr_or_review_engine_settings'))
  } else if (ocrStatus && !['completed'].includes(ocrStatus)) {
    issues.push(makeIssue('ocr_incomplete', 'warning', 'ocr', 'OCR has not completed yet.'))
  }

  if ((failedPageCount ?? 0) > 0) {
    issues.push(makeIssue('ocr_failed_pages', 'error', 'ocr', 'Some pages failed OCR.', true, 'retry_failed_pages'))
  }
  if ((pendingPageCount ?? 0) > 0) {
    issues.push(makeIssue('ocr_pending_pages', 'warning', 'ocr', 'Some pages are still pending OCR.'))
  }
  if (pageCount === 0 && importStatus === 'processed') {
    issues.push(makeIssue('page_count_empty', 'warning', 'storage', 'Processed document has no stored pages.', true, 'reimport_or_rebuild_pages'))
  }

  if (proofStatus && proofStatus !== 'completed') {
    issues.push(makeIssue('proof_incomplete', 'warning', 'proof', 'Proofreading has not completed yet.'))
  }
  if (metadataStatus === 'review') {
    issues.push(makeIssue('metadata_needs_review', 'warning', 'metadata', 'Metadata is waiting for review.'))
  } else if (metadataStatus && !['confirmed', 'auto'].includes(metadataStatus)) {
    issues.push(makeIssue('metadata_incomplete', 'warning', 'metadata', 'Metadata has not been confirmed yet.'))
  }

  return summarizeIssues(stageFromSnapshot(normalizedSnapshot), normalizedSnapshot, issues, updatedAt)
}

export function documentPipelineDiagnosticsFromImportProgress(
  payload: ImportProgressEvent,
  updatedAt = new Date().toISOString(),
): DocumentPipelineDiagnostics {
  const phase = normalizeStatus(payload.phase)
  const bytesDone = finiteCount(payload.bytesDone)
  const totalBytes = finiteCount(payload.totalBytes)
  const progress = clampProgress(payload.progress)
  const snapshot: DocumentPipelineStatusSnapshot = {
    import_status: phase === 'stored' ? 'stored' : 'processing',
  }
  const issues: DocumentPipelineDiagnosticIssue[] = []

  if (payload.totalFiles <= 0) {
    issues.push(makeIssue('import_total_files_empty', 'warning', 'import', 'Import progress reported no total files.'))
  }
  if (payload.fileIndex < 0 || (payload.totalFiles > 0 && payload.fileIndex >= payload.totalFiles)) {
    issues.push(makeIssue('import_file_index_out_of_range', 'warning', 'import', 'Import progress file index is outside the batch range.'))
  }
  if (bytesDone !== undefined && totalBytes !== undefined && totalBytes > 0 && bytesDone > totalBytes) {
    issues.push(makeIssue('import_bytes_over_total', 'warning', 'import', 'Import progress bytes exceed total bytes.'))
  }
  if (phase !== 'stored' && progress === undefined && totalBytes !== undefined && totalBytes > 0) {
    issues.push(makeIssue('import_progress_missing', 'info', 'import', 'Import progress is missing while byte totals are available.'))
  }

  return summarizeIssues(phase === 'stored' ? 'storage' : 'import', snapshot, issues, updatedAt)
}
