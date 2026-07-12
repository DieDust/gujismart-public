import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import type {
  CursorPage,
  ResearchAggregateArtifact,
  ResearchAggregateRelation,
} from '../shared/types'
import { queryAll, queryOne, run, scheduleDatabaseSave, transaction } from './database'
import { getLibrarySearchGeneration, getSearchSnapshotAggregate, validateSearchSnapshot } from './search-snapshots'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function required(value: unknown, code: string): string {
  const text = String(value || '').trim()
  if (!text) throw new Error(code)
  return text
}

export function promoteSearchSnapshotAggregate(input: {
  snapshotId: string
  projectId: string
  relationKind?: string
  label?: string
}): { artifact: ResearchAggregateArtifact; relation: ResearchAggregateRelation } {
  const snapshotId = required(input.snapshotId, 'research_aggregate_snapshot_required')
  const projectId = required(input.projectId, 'research_aggregate_project_required')
  const validation = validateSearchSnapshot(snapshotId)
  if (validation.validation !== 'active' || !validation.snapshot) {
    throw new Error(`research_aggregate_snapshot_${validation.validation.replace('-', '_')}`)
  }
  const summary = getSearchSnapshotAggregate(snapshotId)
  if (!summary) throw new Error('research_aggregate_summary_missing')
  if (summary.status !== 'complete') throw new Error('research_aggregate_incomplete')
  const resultJson = stableJson({
    query: summary.query,
    totalDocuments: summary.totalDocuments,
    totalHits: summary.totalHits,
    warnings: summary.warnings,
  })
  const coverageJson = stableJson(summary.coverage)
  const resultHash = sha256(resultJson)
  const identityHash = sha256(stableJson({
    criteriaHash: validation.snapshot.criteriaHash,
    libraryGeneration: validation.snapshot.librarySearchGeneration,
    indexGenerationVectorHash: validation.snapshot.indexGenerationVectorHash,
    exactness: summary.exactness,
    resultHash,
    coverageHash: sha256(coverageJson),
  }))
  const now = Date.now()
  let artifact = queryOne<ResearchAggregateArtifact>('SELECT * FROM research_aggregate_artifacts WHERE identity_hash = ?', [identityHash])
  let relation: ResearchAggregateRelation | null = null
  transaction(() => {
    if (!artifact) {
      const id = `research_aggregate_${nanoid(20)}`
      run(
        `INSERT INTO research_aggregate_artifacts
         (id, identity_hash, criteria_hash, library_generation, index_generation_vector_hash, exactness, result_json, result_hash, coverage_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, identityHash, validation.snapshot!.criteriaHash, validation.snapshot!.librarySearchGeneration,
          validation.snapshot!.indexGenerationVectorHash, summary.exactness, resultJson, resultHash, coverageJson, now],
      )
      artifact = queryOne<ResearchAggregateArtifact>('SELECT * FROM research_aggregate_artifacts WHERE id = ?', [id])
    }
    const relationKind = required(input.relationKind || 'research-statistic', 'research_aggregate_relation_kind_required')
    run(
      `INSERT INTO research_aggregate_relations (id, aggregate_id, project_id, relation_kind, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(aggregate_id, project_id, relation_kind) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
      [`research_aggregate_relation_${nanoid(20)}`, artifact!.id, projectId, relationKind, String(input.label || ''), now, now],
    )
    relation = queryOne<ResearchAggregateRelation>(
      'SELECT * FROM research_aggregate_relations WHERE aggregate_id = ? AND project_id = ? AND relation_kind = ?',
      [artifact!.id, projectId, relationKind],
    )
  })
  scheduleDatabaseSave()
  if (!artifact || !relation) throw new Error('research_aggregate_create_failed')
  return { artifact, relation }
}

export function validateResearchAggregateArtifact(idValue: string): {
  validation: 'verified' | 'stale-generation' | 'corrupt' | 'not-found'
  artifact: ResearchAggregateArtifact | null
  currentGeneration: number
} {
  const id = required(idValue, 'research_aggregate_required')
  const currentGeneration = getLibrarySearchGeneration()
  const artifact = queryOne<ResearchAggregateArtifact>('SELECT * FROM research_aggregate_artifacts WHERE id = ?', [id])
  if (!artifact) return { validation: 'not-found', artifact: null, currentGeneration }
  if (sha256(artifact.result_json) !== artifact.result_hash) return { validation: 'corrupt', artifact, currentGeneration }
  if (artifact.library_generation !== currentGeneration) return { validation: 'stale-generation', artifact, currentGeneration }
  return { validation: 'verified', artifact, currentGeneration }
}

export function listResearchAggregateRelations(
  projectIdValue: string,
  options?: { limit?: number; cursor?: string | null },
): CursorPage<ResearchAggregateRelation & { artifact: ResearchAggregateArtifact }> {
  const projectId = required(projectIdValue, 'research_aggregate_project_required')
  const limit = options?.limit === undefined ? 50 : Number(options.limit)
  const cursor = options?.cursor ? Number(options.cursor) : 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('research_aggregate_limit_invalid')
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('research_aggregate_cursor_invalid')
  const rows = queryAll<ResearchAggregateRelation & ResearchAggregateArtifact & { relation_rowid: number; artifact_id: string; artifact_created_at: number }>(
    `SELECT r.rowid AS relation_rowid, r.*, a.id AS artifact_id, a.identity_hash, a.criteria_hash,
            a.library_generation, a.index_generation_vector_hash, a.exactness, a.result_json, a.result_hash,
            a.coverage_json, a.created_at AS artifact_created_at
       FROM research_aggregate_relations r
       INNER JOIN research_aggregate_artifacts a ON a.id = r.aggregate_id
      WHERE r.project_id = ? AND r.rowid > ? ORDER BY r.rowid LIMIT ?`,
    [projectId, cursor, limit + 1],
  )
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => ({
      id: row.id,
      aggregate_id: row.aggregate_id,
      project_id: row.project_id,
      relation_kind: row.relation_kind,
      label: row.label,
      created_at: row.created_at,
      updated_at: row.updated_at,
      artifact: {
        id: row.artifact_id,
        identity_hash: row.identity_hash,
        criteria_hash: row.criteria_hash,
        library_generation: row.library_generation,
        index_generation_vector_hash: row.index_generation_vector_hash,
        exactness: row.exactness,
        result_json: row.result_json,
        result_hash: row.result_hash,
        coverage_json: row.coverage_json,
        created_at: row.artifact_created_at,
      },
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1].relation_rowid) : null,
  }
}
