import type { OcrProgressEvent, OcrProgressPhase } from './types'

export type OcrRunQualityStatus = 'ok' | 'needs_review' | 'failed' | 'unknown'

export interface OcrRunPageSummary {
  completed: number
  total?: number
  failed?: number
  pending?: number
  progress: number
}

export interface OcrRunQualitySummary {
  status: OcrRunQualityStatus
  issue_codes: string[]
  message?: string
  action_hint?: string
}

export interface OcrRunMetadata {
  doc_id: string
  status: string
  phase?: OcrProgressPhase
  page_num?: number
  page_summary: OcrRunPageSummary
  quality: OcrRunQualitySummary
  updated_at: string
}

function clampProgress(value: unknown): number {
  const progress = Number(value)
  if (!Number.isFinite(progress)) return 0
  return Math.max(0, Math.min(1, progress))
}

function finiteCount(value: unknown): number | undefined {
  const count = Number(value)
  if (!Number.isFinite(count)) return undefined
  return Math.max(0, Math.floor(count))
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim()
}

function collectQualityIssueCodes(payload: OcrProgressEvent): string[] {
  const text = `${normalizeText(payload.errorMessage)}\n${normalizeText(payload.message)}`.toLowerCase()
  const codes = new Set<string>()
  if (text.includes('[layout_quality_rejected]')) codes.add('layout_quality_rejected')
  if (text.includes('[async_pdf_quality_retryable]')) codes.add('async_pdf_quality_retryable')
  if (text.includes('[async_job_stalled]')) codes.add('async_job_stalled')
  if (text.includes('repeated') || text.includes('duplicate')) codes.add('repeated_text')
  if (payload.status === 'error' || payload.phase === 'error') codes.add('ocr_error')
  if (payload.canceled) codes.add('canceled')
  return [...codes].sort()
}

export function summarizeOcrRunQuality(payload: OcrProgressEvent): OcrRunQualitySummary {
  const issueCodes = collectQualityIssueCodes(payload)
  const message = normalizeText(payload.errorMessage || payload.message)
  const failed = payload.status === 'error' || payload.phase === 'error'
  const needsReview = issueCodes.length > 0 || Boolean(payload.errorMessage)
  return {
    status: failed ? 'failed' : needsReview ? 'needs_review' : payload.status === 'completed' || payload.phase === 'completed' ? 'ok' : 'unknown',
    issue_codes: issueCodes,
    ...(message ? { message } : {}),
    ...(failed || needsReview ? { action_hint: 'review_ocr_pages_or_retry' } : {}),
  }
}

export function ocrRunMetadataFromProgress(payload: OcrProgressEvent): OcrRunMetadata {
  const completed = finiteCount(payload.completedPages) ?? 0
  const total = finiteCount(payload.totalPages)
  const failed = payload.status === 'error' || payload.phase === 'error' ? 1 : undefined
  const progress = clampProgress(payload.progress)
  const pending = total === undefined ? undefined : Math.max(0, total - completed - (failed || 0))
  const pageNum = finiteCount(payload.pageNum)
  return {
    doc_id: normalizeText(payload.docId),
    status: normalizeText(payload.status) || 'unknown',
    ...(payload.phase ? { phase: payload.phase } : {}),
    ...(pageNum !== undefined ? { page_num: pageNum } : {}),
    page_summary: {
      completed,
      ...(total !== undefined ? { total } : {}),
      ...(failed !== undefined ? { failed } : {}),
      ...(pending !== undefined ? { pending } : {}),
      progress,
    },
    quality: summarizeOcrRunQuality(payload),
    updated_at: new Date().toISOString(),
  }
}
