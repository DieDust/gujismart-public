import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import type { SearchSnapshotAggregateSummary, SearchSnapshotMetadata, SearchSnapshotValidationResult } from '../shared/types'
import { queryOne } from './database'

const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 10 * 60_000
const MAX_SNAPSHOTS = 128
const snapshots = new Map<string, SearchSnapshotMetadata>()
const aggregateSummaries = new Map<string, SearchSnapshotAggregateSummary>()

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function getLibrarySearchGeneration(): number {
  const row = queryOne<{ generation: number }>("SELECT generation FROM search_generation_state WHERE scope = 'library'")
  return Math.max(0, Number(row?.generation || 0))
}

function vectorHash(generation: number): string {
  return hash(`search-generation/v1:${generation}`)
}

function boundedTtl(value: unknown): number {
  const ttl = Number(value ?? DEFAULT_TTL_MS)
  if (!Number.isFinite(ttl) || ttl < 1) throw new Error('search_snapshot_ttl_invalid')
  return Math.min(MAX_TTL_MS, Math.floor(ttl))
}

function purgeExpired(now: number): void {
  snapshots.forEach((snapshot, id) => {
    if (snapshot.expiresAt <= now) {
      snapshots.delete(id)
      aggregateSummaries.delete(id)
    }
  })
}

export function createSearchSnapshot(input: { criteriaKey: string; nowMs?: number; ttlMs?: number }): SearchSnapshotMetadata {
  const criteriaKey = String(input.criteriaKey || '').trim()
  if (!criteriaKey) throw new Error('search_snapshot_criteria_required')
  const now = input.nowMs === undefined ? Date.now() : Number(input.nowMs)
  if (!Number.isFinite(now) || now < 0) throw new Error('search_snapshot_time_invalid')
  purgeExpired(now)
  const generation = getLibrarySearchGeneration()
  const snapshot: SearchSnapshotMetadata = {
    snapshotId: `search_snapshot_${nanoid(20)}`,
    criteriaHash: hash(criteriaKey),
    librarySearchGeneration: generation,
    indexGenerationVectorHash: vectorHash(generation),
    createdAt: now,
    expiresAt: now + boundedTtl(input.ttlMs),
  }
  snapshots.set(snapshot.snapshotId, snapshot)
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value
    if (!oldest) break
    snapshots.delete(oldest)
    aggregateSummaries.delete(oldest)
  }
  return snapshot
}

export function validateSearchSnapshot(
  snapshotIdValue: string,
  options?: { criteriaKey?: string; nowMs?: number },
): SearchSnapshotValidationResult {
  const snapshotId = String(snapshotIdValue || '').trim()
  const currentGeneration = getLibrarySearchGeneration()
  const snapshot = snapshots.get(snapshotId) || null
  if (!snapshot) return { validation: 'not-found', snapshot: null, currentGeneration }
  const now = options?.nowMs === undefined ? Date.now() : Number(options.nowMs)
  if (!Number.isFinite(now) || now < 0) throw new Error('search_snapshot_time_invalid')
  if (now >= snapshot.expiresAt) {
    snapshots.delete(snapshotId)
    aggregateSummaries.delete(snapshotId)
    return { validation: 'expired', snapshot, currentGeneration }
  }
  if (options?.criteriaKey !== undefined && hash(String(options.criteriaKey)) !== snapshot.criteriaHash) {
    return { validation: 'criteria-mismatch', snapshot, currentGeneration }
  }
  if (snapshot.librarySearchGeneration !== currentGeneration || snapshot.indexGenerationVectorHash !== vectorHash(currentGeneration)) {
    return { validation: 'stale', snapshot, currentGeneration }
  }
  return { validation: 'active', snapshot, currentGeneration }
}

export function recordSearchSnapshotAggregate(snapshotIdValue: string, summary: SearchSnapshotAggregateSummary): void {
  const snapshotId = String(snapshotIdValue || '').trim()
  if (!snapshots.has(snapshotId)) throw new Error('search_snapshot_not_found')
  const normalized: SearchSnapshotAggregateSummary = {
    query: String(summary.query || ''),
    totalDocuments: Math.max(0, Number(summary.totalDocuments || 0)),
    totalHits: Math.max(0, Number(summary.totalHits || 0)),
    status: summary.status,
    warnings: [...new Set((summary.warnings || []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100),
    exactness: summary.exactness,
    coverage: {
      returnedDocuments: Math.max(0, Number(summary.coverage?.returnedDocuments || 0)),
      returnedHits: Math.max(0, Number(summary.coverage?.returnedHits || 0)),
      totalsExact: !!summary.coverage?.totalsExact,
    },
  }
  const existing = aggregateSummaries.get(snapshotId)
  if (existing && (existing.totalDocuments !== normalized.totalDocuments || existing.totalHits !== normalized.totalHits)) {
    throw new Error('search_snapshot_aggregate_conflict')
  }
  aggregateSummaries.set(snapshotId, normalized)
}

export function getSearchSnapshotAggregate(snapshotIdValue: string): SearchSnapshotAggregateSummary | null {
  const snapshotId = String(snapshotIdValue || '').trim()
  const summary = aggregateSummaries.get(snapshotId)
  return summary ? { ...summary, warnings: [...summary.warnings], coverage: { ...summary.coverage } } : null
}

export function attachSearchSnapshot<T extends object>(response: T, criteriaKey: string): T & {
  snapshotId: string
  librarySearchGeneration: number
  indexGenerationVectorHash: string
  snapshotExpiresAt: number
} {
  const snapshot = createSearchSnapshot({ criteriaKey })
  return {
    ...response,
    snapshotId: snapshot.snapshotId,
    librarySearchGeneration: snapshot.librarySearchGeneration,
    indexGenerationVectorHash: snapshot.indexGenerationVectorHash,
    snapshotExpiresAt: snapshot.expiresAt,
  }
}
