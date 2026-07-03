import type { EvidenceQaSource } from './types'

export type AiResponseEnvelopeStatus = 'completed' | 'error'

export interface AiResponseSourceSummary {
  total: number
  with_locator: number
  with_source_hash: number
  missing_locator: number
  missing_source_hash: number
  doc_ids: string[]
  page_refs: Array<{ doc_id: string; page_num: number | null }>
}

export interface AiResponseEnvelope {
  status: AiResponseEnvelopeStatus
  task_type: string
  prompt_hash?: string
  result_hash?: string
  provider?: string
  model?: string
  source_summary: AiResponseSourceSummary
  confidence: number
  warning_count: number
  warnings: string[]
  error_code?: string
  error_message?: string
  started_at?: string
  completed_at: string
  elapsed_ms?: number
}

export interface BuildAiResponseEnvelopeInput {
  taskType: string
  status?: AiResponseEnvelopeStatus
  promptHash?: string
  resultText?: unknown
  provider?: unknown
  model?: unknown
  sources?: EvidenceQaSource[] | null
  warnings?: unknown[] | null
  errorCode?: unknown
  errorMessage?: unknown
  startedAt?: string | null
  completedAt?: string | null
  elapsedMs?: number | null
}

function toTrimmedString(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeCode(value: unknown): string {
  return toTrimmedString(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function hashAiEnvelopeText(value: unknown): string {
  const text = toTrimmedString(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function summarizeAiResponseSources(sources?: EvidenceQaSource[] | null): AiResponseSourceSummary {
  const list = Array.isArray(sources) ? sources : []
  const docIds = new Set<string>()
  const pageRefs: AiResponseSourceSummary['page_refs'] = []
  let withLocator = 0
  let withSourceHash = 0

  for (const source of list) {
    const docId = toTrimmedString(source?.doc_id)
    if (docId) docIds.add(docId)
    pageRefs.push({ doc_id: docId, page_num: source?.page_num ?? null })
    if (source?.locator) withLocator += 1
    if (toTrimmedString(source?.source_hash)) withSourceHash += 1
  }

  return {
    total: list.length,
    with_locator: withLocator,
    with_source_hash: withSourceHash,
    missing_locator: Math.max(0, list.length - withLocator),
    missing_source_hash: Math.max(0, list.length - withSourceHash),
    doc_ids: [...docIds].sort(),
    page_refs: pageRefs,
  }
}

function estimateConfidence(summary: AiResponseSourceSummary, warningCount: number, hasError: boolean): number {
  if (hasError) return 0
  if (summary.total === 0) return warningCount > 0 ? 0.55 : 0.62
  const locatorRatio = summary.with_locator / summary.total
  const hashRatio = summary.with_source_hash / summary.total
  const evidenceScore = 0.55 + Math.min(0.3, summary.total * 0.03)
  const traceScore = (locatorRatio + hashRatio) * 0.15
  const warningPenalty = Math.min(0.25, warningCount * 0.05)
  return Math.max(0.1, Math.min(0.98, Number((evidenceScore + traceScore - warningPenalty).toFixed(2))))
}

export function buildAiResponseEnvelope(input: BuildAiResponseEnvelopeInput): AiResponseEnvelope {
  const status = input.status || (input.errorMessage ? 'error' : 'completed')
  const warnings = (Array.isArray(input.warnings) ? input.warnings : [])
    .map(toTrimmedString)
    .filter(Boolean)
  const sourceSummary = summarizeAiResponseSources(input.sources)
  const completedAt = input.completedAt || new Date().toISOString()
  const elapsedMs = Number(input.elapsedMs)
  return {
    status,
    task_type: toTrimmedString(input.taskType) || 'ai_task',
    ...(input.promptHash ? { prompt_hash: toTrimmedString(input.promptHash) } : {}),
    ...(input.resultText !== undefined ? { result_hash: hashAiEnvelopeText(input.resultText) } : {}),
    ...(toTrimmedString(input.provider) ? { provider: toTrimmedString(input.provider) } : {}),
    ...(toTrimmedString(input.model) ? { model: toTrimmedString(input.model) } : {}),
    source_summary: sourceSummary,
    confidence: estimateConfidence(sourceSummary, warnings.length, status === 'error'),
    warning_count: warnings.length,
    warnings,
    ...(input.errorCode ? { error_code: normalizeCode(input.errorCode) || 'ai_error' } : {}),
    ...(input.errorMessage ? { error_message: toTrimmedString(input.errorMessage) } : {}),
    ...(input.startedAt ? { started_at: input.startedAt } : {}),
    completed_at: completedAt,
    ...(Number.isFinite(elapsedMs) ? { elapsed_ms: Math.max(0, Math.round(elapsedMs)) } : {}),
  }
}
