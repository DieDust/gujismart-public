import { createHash } from 'crypto'

export interface ResearchClaimBindingInput {
  start: number
  end: number
  evidenceIds?: string[]
  aggregateIds?: string[]
}

export interface ResearchClaimDraft {
  ordinal: number
  kind: 'statement' | 'numeric'
  start: number
  end: number
  text: string
  claimHash: string
  occurrenceIndex: number
}

export interface ResearchClaimManifestEntryDraft extends ResearchClaimDraft {
  supportStatus: 'supported' | 'unsupported'
  evidenceIds: string[]
  aggregateIds: string[]
}

export interface ResearchClaimManifestDraft {
  schemaVersion: 'research-claim-manifest/v1'
  outputVersionId: string
  parserVersion: 'claim-segmenter/v1'
  normalizationVersion: 'unicode-nfc-crlf/v1'
  contentHash: string
  entries: ResearchClaimManifestEntryDraft[]
  coverage: { total: number; supported: number; unsupported: number }
  manifestHash: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function normalized(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function uniqueIds(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))].sort()
}

export function enumerateResearchClaims(contentValue: string): ResearchClaimDraft[] {
  const content = String(contentValue || '')
  if (!content.trim()) throw new Error('research_claim_content_required')
  const drafts: ResearchClaimDraft[] = []
  const occurrences = new Map<string, number>()
  const matcher = /[^。！？!?；;\r\n]+[。！？!?；;]?/gu
  for (const match of content.matchAll(matcher)) {
    const raw = match[0]
    const leading = raw.length - raw.trimStart().length
    const trailing = raw.length - raw.trimEnd().length
    const start = Number(match.index || 0) + leading
    const end = Number(match.index || 0) + raw.length - trailing
    if (end <= start) continue
    const text = content.slice(start, end)
    const normalizedText = normalized(text)
    const claimHash = sha256(normalizedText)
    const occurrenceIndex = occurrences.get(normalizedText) || 0
    occurrences.set(normalizedText, occurrenceIndex + 1)
    drafts.push({
      ordinal: drafts.length,
      kind: /\p{Number}/u.test(normalizedText) ? 'numeric' : 'statement',
      start,
      end,
      text,
      claimHash,
      occurrenceIndex,
    })
  }
  if (drafts.length === 0) throw new Error('research_claim_content_required')
  return drafts
}

export function buildResearchClaimManifest(input: {
  outputVersionId: string
  content: string
  status: 'draft' | 'formal' | 'archived'
  bindings?: ResearchClaimBindingInput[]
  allowedEvidenceIds: string[]
  allowedAggregateIds: string[]
}): ResearchClaimManifestDraft {
  const outputVersionId = String(input.outputVersionId || '').trim()
  if (!outputVersionId) throw new Error('research_claim_output_required')
  const claims = enumerateResearchClaims(input.content)
  const claimByRange = new Map(claims.map((claim) => [`${claim.start}:${claim.end}`, claim]))
  const allowedEvidence = new Set(uniqueIds(input.allowedEvidenceIds))
  const allowedAggregates = new Set(uniqueIds(input.allowedAggregateIds))
  const bindings = new Map<string, { evidenceIds: string[]; aggregateIds: string[] }>()
  for (const binding of input.bindings || []) {
    const start = Number(binding.start)
    const end = Number(binding.end)
    const key = `${start}:${end}`
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !claimByRange.has(key) || bindings.has(key)) {
      throw new Error('research_claim_range_invalid')
    }
    const evidenceIds = uniqueIds(binding.evidenceIds)
    const aggregateIds = uniqueIds(binding.aggregateIds)
    if (evidenceIds.some((id) => !allowedEvidence.has(id)) || aggregateIds.some((id) => !allowedAggregates.has(id))) {
      throw new Error('research_claim_provenance_invalid')
    }
    bindings.set(key, { evidenceIds, aggregateIds })
  }
  const entries = claims.map((claim): ResearchClaimManifestEntryDraft => {
    const provenance = bindings.get(`${claim.start}:${claim.end}`) || { evidenceIds: [], aggregateIds: [] }
    return {
      ...claim,
      supportStatus: provenance.evidenceIds.length + provenance.aggregateIds.length > 0 ? 'supported' : 'unsupported',
      evidenceIds: provenance.evidenceIds,
      aggregateIds: provenance.aggregateIds,
    }
  })
  const coverage = {
    total: entries.length,
    supported: entries.filter((entry) => entry.supportStatus === 'supported').length,
    unsupported: entries.filter((entry) => entry.supportStatus === 'unsupported').length,
  }
  if (input.status === 'formal' && coverage.unsupported > 0) throw new Error('research_claim_coverage_incomplete')
  const core = {
    schemaVersion: 'research-claim-manifest/v1' as const,
    outputVersionId,
    parserVersion: 'claim-segmenter/v1' as const,
    normalizationVersion: 'unicode-nfc-crlf/v1' as const,
    contentHash: sha256(normalized(input.content)),
    entries: entries.map(({ text: _text, ...entry }) => entry),
    coverage,
  }
  return { ...core, entries, manifestHash: sha256(stableJson(core)) }
}
