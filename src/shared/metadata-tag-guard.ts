export type MetadataTagCleanupAction = 'keep' | 'delete'

export interface MetadataTagRelationGuardInput {
  tagName?: string | null
  nextName?: string | null
  tagSource?: string | null
  relationSourceField?: string | null
  isManual?: number | boolean | null
  isMetadata?: number | boolean | null
  isCandidateRelation?: boolean
}

export interface MetadataTagCleanupDecision {
  action: MetadataTagCleanupAction
  reason: string
  protected_manual: boolean
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

export function normalizeMetadataTagName(name: unknown): string {
  return String(name ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function normalizeMetadataTagComparableName(name: unknown): string {
  return normalizeMetadataTagName(name).replace(/\s+/g, '')
}

export function shouldProtectManualTagRelation(input: MetadataTagRelationGuardInput): boolean {
  return truthyFlag(input.isManual)
}

export function decideMetadataTagRelationCleanup(input: MetadataTagRelationGuardInput): MetadataTagCleanupDecision {
  const tagName = normalizeMetadataTagComparableName(input.tagName)
  if (!tagName) {
    return { action: 'keep', reason: 'empty_tag_name', protected_manual: shouldProtectManualTagRelation(input) }
  }
  if (!input.isCandidateRelation) {
    return { action: 'keep', reason: 'not_metadata_candidate', protected_manual: shouldProtectManualTagRelation(input) }
  }
  const nextName = normalizeMetadataTagComparableName(input.nextName)
  if (nextName && tagName === nextName) {
    return { action: 'keep', reason: 'matches_next_value', protected_manual: shouldProtectManualTagRelation(input) }
  }
  if (shouldProtectManualTagRelation(input)) {
    return { action: 'keep', reason: 'manual_relation_protected', protected_manual: true }
  }
  return { action: 'delete', reason: 'stale_metadata_relation', protected_manual: false }
}
