import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import type { AiSynthesisTemplate, CursorPage, ResearchClaimBinding, ResearchClaimEntry, ResearchClaimManifest, ResearchClaimManifestPage, ResearchClaimManifestValidationResult, ResearchEvidence, ResearchEvidenceRelation, ResearchOutputVersion, ResearchRecordVersion } from '../shared/types'
import { resolveCanonicalPageContent } from './canonical-content'
import { queryAll, queryOne, run, scheduleDatabaseSave, transaction } from './database'
import { tryParseStableReaderLocator } from '../shared/stable-reader-locator'
import { resolveSearchEvidence } from './search-evidence-resolver'
import { validateResearchAggregateArtifact } from './research-aggregates'
import { buildResearchClaimManifest } from './research-claim-manifest'

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

export function upsertResearchEvidence(input: {
  documentId: string
  sourcePageId: string
  pageNum?: number
  start: number
  end: number
  quote: string
  projectId?: string | null
  relationKind?: string
  note?: string
  tags?: string[]
}): { evidence: ResearchEvidence; relation: ResearchEvidenceRelation | null } {
  const documentId = required(input.documentId, 'research_evidence_document_required')
  const pageId = required(input.sourcePageId, 'research_evidence_page_required')
  const start = Number(input.start)
  const end = Number(input.end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error('research_evidence_range_invalid')
  const canonical = resolveCanonicalPageContent(pageId)
  if (canonical.docId !== documentId) throw new Error('research_evidence_document_mismatch')
  const quote = canonical.text.slice(start, end)
  if (!quote || quote !== String(input.quote || '')) throw new Error('research_evidence_quote_mismatch')
  const contentVersion = canonical.artifactId || canonical.baseArtifactId || `${canonical.source}:${canonical.sourceHash}`
  const locator = {
    schemaVersion: 'stable-reader-locator/v2', precision: 'exact', documentId, sourcePageId: pageId,
    pageNum: input.pageNum || canonical.pageNum, contentVersion, sourceHash: canonical.sourceHash,
    offsetUnit: 'utf16-code-unit', sourceRanges: [{ start, end }], quote,
    prefix: canonical.text.slice(Math.max(0, start - 48), start), suffix: canonical.text.slice(end, end + 48),
    occurrenceIndex: 0, verificationStatus: 'verified', sourceKind: canonical.source,
  }
  const identityHash = sha256(stableJson({ documentId, pageId, sourceHash: canonical.sourceHash, start, end, quote }))
  const now = Date.now()
  let evidence = queryOne<ResearchEvidence>('SELECT * FROM research_evidence WHERE identity_hash = ?', [identityHash])
  let relation: ResearchEvidenceRelation | null = null
  transaction(() => {
    if (!evidence) {
      const id = `research_evidence_${nanoid(20)}`
      run(
        `INSERT INTO research_evidence
         (id, identity_hash, doc_id, page_id, page_num, locator_json, quote, source_hash, content_version, verification_status, created_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
        [id, identityHash, documentId, pageId, input.pageNum || canonical.pageNum, JSON.stringify(locator), quote, canonical.sourceHash, contentVersion, now, now],
      )
      evidence = queryOne<ResearchEvidence>('SELECT * FROM research_evidence WHERE id = ?', [id])
    }
    if (input.projectId) {
      const kind = required(input.relationKind || 'note', 'research_evidence_relation_kind_required')
      const relationId = `research_evidence_relation_${nanoid(20)}`
      run(
        `INSERT INTO research_evidence_relations (id, evidence_id, project_id, relation_kind, note, tags_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(evidence_id, project_id, relation_kind) DO UPDATE SET note = excluded.note, tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
        [relationId, evidence!.id, input.projectId, kind, String(input.note || ''), JSON.stringify(input.tags || []), now, now],
      )
      relation = queryOne<ResearchEvidenceRelation>(
        'SELECT * FROM research_evidence_relations WHERE evidence_id = ? AND project_id = ? AND relation_kind = ?',
        [evidence!.id, input.projectId, kind],
      )
    }
  })
  scheduleDatabaseSave()
  if (!evidence) throw new Error('research_evidence_not_found')
  return { evidence, relation }
}

export function listResearchEvidenceRelations(
  projectIdValue: string,
  options?: { limit?: number; cursor?: string | null },
): CursorPage<ResearchEvidenceRelation & { evidence: ResearchEvidence }> {
  const projectId = required(projectIdValue, 'research_project_required')
  const limit = options?.limit === undefined ? 50 : Number(options.limit)
  const cursor = options?.cursor ? Number(options.cursor) : 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('research_relation_limit_invalid')
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('research_relation_cursor_invalid')
  const rows = queryAll<ResearchEvidenceRelation & ResearchEvidence & { relation_rowid: number; evidence_created_at: number; evidence_verified_at: number | null }>(
    `SELECT r.rowid AS relation_rowid, r.*,
            e.id AS evidence_row_id, e.identity_hash, e.doc_id, e.page_id, e.page_num, e.locator_json, e.quote,
            e.source_hash, e.content_version, e.verification_status, e.created_at AS evidence_created_at, e.verified_at AS evidence_verified_at
       FROM research_evidence_relations r
       INNER JOIN research_evidence e ON e.id = r.evidence_id
      WHERE r.project_id = ? AND r.rowid > ?
      ORDER BY r.rowid LIMIT ?`,
    [projectId, cursor, limit + 1],
  )
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => ({
      id: row.id,
      evidence_id: row.evidence_id,
      project_id: row.project_id,
      relation_kind: row.relation_kind,
      note: row.note,
      tags_json: row.tags_json,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      evidence: {
        id: String((row as unknown as Record<string, unknown>).evidence_row_id || row.evidence_id),
        identity_hash: row.identity_hash,
        doc_id: row.doc_id,
        page_id: row.page_id,
        page_num: row.page_num,
        locator_json: row.locator_json,
        quote: row.quote,
        source_hash: row.source_hash,
        content_version: row.content_version,
        verification_status: row.verification_status,
        created_at: row.evidence_created_at,
        verified_at: row.evidence_verified_at,
      },
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1].relation_rowid) : null,
  }
}

export function promoteResearchNoteToEvidence(noteIdValue: string): { evidence: ResearchEvidence; relation: ResearchEvidenceRelation | null } {
  const noteId = required(noteIdValue, 'research_note_required')
  const note = queryOne<{
    id: string; project_id: string | null; doc_id: string; page_num: number | null; excerpt: string
    note: string; tags: string; kind: string; locator_json: string
  }>('SELECT id, project_id, doc_id, page_num, excerpt, note, tags, kind, locator_json FROM research_notes WHERE id = ?', [noteId])
  if (!note) throw new Error('research_note_not_found')
  let rawLocator: unknown = null
  try { rawLocator = JSON.parse(String(note.locator_json || '')) } catch { rawLocator = null }
  const locator = tryParseStableReaderLocator(rawLocator)
  let pageId = locator?.sourcePageId || ''
  if (!pageId && note.page_num) {
    pageId = queryOne<{ id: string }>('SELECT id FROM pages WHERE doc_id = ? AND page_num = ? LIMIT 1', [note.doc_id, note.page_num])?.id || ''
  }
  if (!pageId) throw new Error('research_note_evidence_unresolved')
  const canonical = resolveCanonicalPageContent(pageId)
  const excerpt = String(note.excerpt || '').trim()
  let start = locator?.precision === 'exact' && locator.sourceRanges.length === 1 ? locator.sourceRanges[0].start : -1
  let end = locator?.precision === 'exact' && locator.sourceRanges.length === 1 ? locator.sourceRanges[0].end : -1
  if (start < 0 || end <= start || canonical.text.slice(start, end) !== excerpt) {
    start = excerpt ? canonical.text.indexOf(excerpt) : -1
    const second = start >= 0 ? canonical.text.indexOf(excerpt, start + excerpt.length) : -1
    if (start < 0 || second >= 0) throw new Error('research_note_evidence_unresolved')
    end = start + excerpt.length
  }
  return upsertResearchEvidence({
    documentId: note.doc_id,
    sourcePageId: pageId,
    pageNum: note.page_num || canonical.pageNum,
    start,
    end,
    quote: excerpt,
    projectId: note.project_id,
    relationKind: note.kind || 'note',
    note: note.note,
    tags: String(note.tags || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean),
  })
}

export function commitResearchRecordVersion(input: {
  recordId: string
  evidenceId?: string | null
  values: Record<string, string>
  status: 'pending' | 'confirmed' | 'excluded' | 'needs-review'
  note?: string
  expectedVersion: number
}): ResearchRecordVersion {
  const recordId = required(input.recordId, 'research_record_required')
  const record = queryOne<{ id: string; status: string }>('SELECT id, status FROM ai_research_records WHERE id = ?', [recordId])
  if (!record) throw new Error('research_record_not_found')
  const latest = queryOne<ResearchRecordVersion>('SELECT * FROM research_record_versions WHERE record_id = ? ORDER BY version DESC LIMIT 1', [recordId])
  const currentVersion = Number(latest?.version || 0)
  if (currentVersion !== Number(input.expectedVersion)) throw new Error('research_record_version_conflict')
  if (input.status === 'confirmed') {
    const evidence = queryOne<ResearchEvidence>('SELECT * FROM research_evidence WHERE id = ?', [input.evidenceId || ''])
    if (!evidence || evidence.verification_status !== 'verified') throw new Error('research_record_evidence_unverified')
  }
  const version = currentVersion + 1
  const id = `research_record_version_${nanoid(20)}`
  const now = Date.now()
  const valuesJson = stableJson(input.values || {})
  const contentHash = sha256(stableJson({ recordId, version, evidenceId: input.evidenceId || null, values: input.values || {}, status: input.status, note: input.note || '' }))
  transaction(() => {
    run(
      `INSERT INTO research_record_versions
       (id, record_id, version, evidence_id, values_json, status, note, content_hash, parent_version_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, recordId, version, input.evidenceId || null, valuesJson, input.status, String(input.note || ''), contentHash, latest?.id || null, now],
    )
    run(
      'INSERT INTO research_record_review_events (record_id, version_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [recordId, id, record.status || null, input.status, String(input.note || ''), now],
    )
    run('UPDATE ai_research_records SET values_json = ?, status = ?, note = ?, updated_at = ? WHERE id = ?', [valuesJson, input.status, String(input.note || ''), new Date(now).toISOString(), recordId])
  })
  scheduleDatabaseSave()
  const created = queryOne<ResearchRecordVersion>('SELECT * FROM research_record_versions WHERE id = ?', [id])
  if (!created) throw new Error('research_record_version_not_found')
  return created
}

export function commitExistingResearchRecordUpdate(input: {
  recordId: string
  values: Record<string, string>
  status: 'pending' | 'confirmed' | 'excluded' | 'needs-review'
  note?: string
}): ResearchRecordVersion {
  const record = queryOne<{ id: string; project_id: string | null; doc_id: string; page_num: number | null; excerpt: string; locator_json: string }>(
    'SELECT id, project_id, doc_id, page_num, excerpt, locator_json FROM ai_research_records WHERE id = ?',
    [input.recordId],
  )
  if (!record) throw new Error('research_record_not_found')
  let evidenceId: string | null = null
  if (input.status === 'confirmed') {
    let rawLocator: unknown = null
    try { rawLocator = JSON.parse(String(record.locator_json || '')) } catch { rawLocator = null }
    const locator = tryParseStableReaderLocator(rawLocator)
    let documentId = locator?.documentId || record.doc_id
    let pageId = locator?.sourcePageId || ''
    let pageNum = locator?.pageNum || record.page_num || undefined
    let start = locator?.precision === 'exact' && locator.sourceRanges.length === 1 ? locator.sourceRanges[0].start : -1
    let end = locator?.precision === 'exact' && locator.sourceRanges.length === 1 ? locator.sourceRanges[0].end : -1
    let quote = locator?.precision === 'exact' ? locator.quote : ''
    if (!pageId && pageNum) {
      pageId = queryOne<{ id: string }>('SELECT id FROM pages WHERE doc_id = ? AND page_num = ? LIMIT 1', [record.doc_id, pageNum])?.id || ''
    }
    if (pageId && (start < 0 || end <= start || !quote)) {
      const canonical = resolveCanonicalPageContent(pageId)
      const excerpt = String(record.excerpt || '').trim()
      const first = excerpt ? canonical.text.indexOf(excerpt) : -1
      const second = first >= 0 ? canonical.text.indexOf(excerpt, first + excerpt.length) : -1
      if (first >= 0 && second < 0) {
        documentId = canonical.docId
        pageNum = canonical.pageNum
        start = first
        end = first + excerpt.length
        quote = excerpt
      }
    }
    if (!pageId || start < 0 || end <= start || !quote) throw new Error('research_record_evidence_unverified')
    evidenceId = upsertResearchEvidence({
      documentId,
      sourcePageId: pageId,
      pageNum,
      start,
      end,
      quote,
      projectId: record.project_id,
      relationKind: 'record',
    }).evidence.id
  }
  const expectedVersion = Number(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM research_record_versions WHERE record_id = ?', [input.recordId])?.version || 0)
  return commitResearchRecordVersion({ ...input, evidenceId, expectedVersion })
}

export function createResearchOutputVersion(input: {
  projectId: string
  outputId?: string | null
  outputType: AiSynthesisTemplate
  title: string
  content: string
  recordIds: string[]
  aggregateIds?: string[]
  claimBindings?: ResearchClaimBinding[]
  parentVersionId?: string | null
  status?: 'draft' | 'formal' | 'archived'
}): ResearchOutputVersion {
  const projectId = required(input.projectId, 'research_output_project_required')
  const title = required(input.title, 'research_output_title_required')
  const content = required(input.content, 'research_output_content_required')
  const recordIds = [...new Set((input.recordIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  const aggregateIds = [...new Set((input.aggregateIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  const records = recordIds.length === 0 ? [] : queryAll<ResearchRecordVersion>(
    `SELECT rv.* FROM research_record_versions rv
     INNER JOIN (SELECT record_id, MAX(version) AS version FROM research_record_versions WHERE record_id IN (${recordIds.map(() => '?').join(',')}) GROUP BY record_id) latest
       ON latest.record_id = rv.record_id AND latest.version = rv.version`,
    recordIds,
  )
  const status = input.status || 'formal'
  if (status === 'formal' && recordIds.length === 0) throw new Error('research_output_records_required')
  if (status === 'formal' && (records.length !== recordIds.length || records.some((record) => record.status !== 'confirmed' || !record.evidence_id))) {
    throw new Error('research_output_record_invalid')
  }
  if (status === 'formal') {
    for (const record of records) {
      const evidence = queryOne<ResearchEvidence>('SELECT * FROM research_evidence WHERE id = ?', [record.evidence_id || ''])
      if (!evidence) throw new Error('research_output_evidence_invalid')
      let locatorValue: unknown = null
      try { locatorValue = JSON.parse(evidence.locator_json) } catch { locatorValue = null }
      const locator = tryParseStableReaderLocator(locatorValue)
      if (!locator) throw new Error('research_output_evidence_invalid')
      const resolved = resolveSearchEvidence(locator)
      if (resolved.verificationStatus !== 'verified' || resolved.resolution === 'unresolved') {
        run("UPDATE research_evidence SET verification_status = 'stale' WHERE id = ?", [evidence.id])
        scheduleDatabaseSave()
        throw new Error('research_output_evidence_stale')
      }
    }
  }
  const aggregateArtifacts = aggregateIds.map((aggregateId) => {
    const relation = queryOne<{ id: string }>(
      'SELECT id FROM research_aggregate_relations WHERE aggregate_id = ? AND project_id = ? LIMIT 1',
      [aggregateId, projectId],
    )
    const validation = validateResearchAggregateArtifact(aggregateId)
    return { aggregateId, relationFound: !!relation, validation: validation.validation, artifact: validation.artifact }
  })
  if (status === 'formal' && aggregateArtifacts.some((item) => (
    !item.relationFound || item.validation !== 'verified' || item.artifact?.exactness !== 'exact'
  ))) {
    throw new Error('research_output_aggregate_invalid')
  }
  const parent = input.parentVersionId
    ? queryOne<ResearchOutputVersion>('SELECT * FROM research_output_versions WHERE id = ? AND project_id = ?', [input.parentVersionId, projectId])
    : null
  if (input.parentVersionId && !parent) throw new Error('research_output_parent_invalid')
  const latestVersion = Number(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM research_output_versions WHERE project_id = ?', [projectId])?.version || 0)
  const version = latestVersion + 1
  const manifest = {
    schemaVersion: 'research-input-manifest/v2', projectId, recordVersions: records.map((record) => ({
      recordId: record.record_id, versionId: record.id, version: record.version, evidenceId: record.evidence_id, contentHash: record.content_hash,
    })).sort((a, b) => a.recordId.localeCompare(b.recordId)),
    aggregateArtifacts: aggregateArtifacts.filter((item) => item.relationFound && item.artifact).map((item) => ({
      aggregateId: item.aggregateId,
      resultHash: item.artifact!.result_hash,
      criteriaHash: item.artifact!.criteria_hash,
      exactness: item.artifact!.exactness,
      validation: item.validation,
    })).sort((a, b) => a.aggregateId.localeCompare(b.aggregateId)),
    coverage: {
      expected: recordIds.length,
      processed: records.length,
      failed: 0,
      omitted: Math.max(0, recordIds.length - records.length),
      aggregatesExpected: aggregateIds.length,
      aggregatesProcessed: aggregateArtifacts.filter((item) => item.relationFound && item.validation === 'verified').length,
      aggregatesOmitted: aggregateArtifacts.filter((item) => !item.relationFound || item.validation !== 'verified').length,
    },
  }
  const manifestJson = stableJson(manifest)
  const id = `research_output_version_${nanoid(20)}`
  const contentHash = sha256(content)
  const claimManifest = buildResearchClaimManifest({
    outputVersionId: id,
    content,
    status,
    bindings: input.claimBindings || [],
    allowedEvidenceIds: records.map((record) => record.evidence_id || '').filter(Boolean),
    allowedAggregateIds: aggregateArtifacts.filter((item) => item.relationFound && item.artifact).map((item) => item.aggregateId),
  })
  const claimManifestId = `research_claim_manifest_${nanoid(20)}`
  const createdAt = Date.now()
  transaction(() => {
    run(
      `INSERT INTO research_output_versions
       (id, output_id, project_id, version, parent_version_id, output_type, title, content, content_hash, status, input_manifest_json, input_manifest_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.outputId || null, projectId, version, parent?.id || null, input.outputType, title, content, contentHash, status, manifestJson, sha256(manifestJson), createdAt],
    )
    run(
      `INSERT INTO research_claim_manifests
       (id, output_version_id, schema_version, content_hash, parser_version, normalization_version, coverage_json, manifest_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [claimManifestId, id, claimManifest.schemaVersion, claimManifest.contentHash, claimManifest.parserVersion,
        claimManifest.normalizationVersion, stableJson(claimManifest.coverage), claimManifest.manifestHash, createdAt],
    )
    for (const entry of claimManifest.entries) {
      run(
        `INSERT INTO research_claim_entries
         (id, manifest_id, ordinal, claim_kind, char_start, char_end, text_hash, occurrence_index, support_status, evidence_ids_json, aggregate_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`research_claim_entry_${nanoid(20)}`, claimManifestId, entry.ordinal, entry.kind, entry.start, entry.end,
          entry.claimHash, entry.occurrenceIndex, entry.supportStatus, stableJson(entry.evidenceIds), stableJson(entry.aggregateIds), createdAt],
      )
    }
  })
  scheduleDatabaseSave()
  const created = queryOne<ResearchOutputVersion>('SELECT * FROM research_output_versions WHERE id = ?', [id])
  if (!created) throw new Error('research_output_version_not_found')
  return created
}

export function getResearchClaimManifestPage(
  outputVersionIdValue: string,
  options?: { limit?: number; cursor?: string | null },
): ResearchClaimManifestPage | null {
  const outputVersionId = required(outputVersionIdValue, 'research_claim_output_required')
  const limit = options?.limit === undefined ? 50 : Number(options.limit)
  const cursor = options?.cursor ? Number(options.cursor) : 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('research_claim_limit_invalid')
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('research_claim_cursor_invalid')
  const manifest = queryOne<ResearchClaimManifest>('SELECT * FROM research_claim_manifests WHERE output_version_id = ?', [outputVersionId])
  if (!manifest) return null
  const rows = queryAll<ResearchClaimEntry>(
    'SELECT * FROM research_claim_entries WHERE manifest_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?',
    [manifest.id, cursor, limit + 1],
  )
  const page = rows.slice(0, limit)
  return {
    manifest,
    entries: {
      items: page,
      nextCursor: rows.length > limit ? String(page[page.length - 1].ordinal + 1) : null,
    },
  }
}

export function validateResearchClaimManifest(outputVersionIdValue: string): ResearchClaimManifestValidationResult {
  const outputVersionId = required(outputVersionIdValue, 'research_claim_output_required')
  const output = queryOne<ResearchOutputVersion>('SELECT * FROM research_output_versions WHERE id = ?', [outputVersionId])
  const manifest = queryOne<ResearchClaimManifest>('SELECT * FROM research_claim_manifests WHERE output_version_id = ?', [outputVersionId])
  const emptyCoverage = { total: 0, supported: 0, unsupported: 0, stale: 0 }
  if (!output || !manifest) return { validation: 'not-found', manifest: null, coverage: emptyCoverage }
  const entries = queryAll<ResearchClaimEntry>('SELECT * FROM research_claim_entries WHERE manifest_id = ? ORDER BY ordinal', [manifest.id])
  let inputManifest: {
    recordVersions?: Array<{ evidenceId?: string | null }>
    aggregateArtifacts?: Array<{ aggregateId?: string }>
  } = {}
  try { inputManifest = JSON.parse(output.input_manifest_json) } catch { return { validation: 'corrupt', manifest, coverage: emptyCoverage, reason: 'input-manifest-invalid' } }
  const allowedEvidenceIds = (inputManifest.recordVersions || []).map((item) => String(item.evidenceId || '')).filter(Boolean)
  const allowedAggregateIds = (inputManifest.aggregateArtifacts || []).map((item) => String(item.aggregateId || '')).filter(Boolean)
  let rebuilt
  try {
    rebuilt = buildResearchClaimManifest({
      outputVersionId,
      content: output.content,
      status: 'draft',
      allowedEvidenceIds,
      allowedAggregateIds,
      bindings: entries.filter((entry) => entry.support_status !== 'unsupported').map((entry) => ({
        start: entry.char_start,
        end: entry.char_end,
        evidenceIds: JSON.parse(entry.evidence_ids_json),
        aggregateIds: JSON.parse(entry.aggregate_ids_json),
      })),
    })
  } catch {
    return { validation: 'corrupt', manifest, coverage: emptyCoverage, reason: 'claim-entry-invalid' }
  }
  const rowsMatch = rebuilt.entries.length === entries.length && rebuilt.entries.every((entry, index) => {
    const row = entries[index]
    return row.ordinal === entry.ordinal && row.claim_kind === entry.kind && row.char_start === entry.start && row.char_end === entry.end
      && row.text_hash === entry.claimHash && row.occurrence_index === entry.occurrenceIndex
      && row.support_status === entry.supportStatus && row.evidence_ids_json === stableJson(entry.evidenceIds)
      && row.aggregate_ids_json === stableJson(entry.aggregateIds)
  })
  if (!rowsMatch || manifest.content_hash !== rebuilt.contentHash || manifest.manifest_hash !== rebuilt.manifestHash
    || manifest.coverage_json !== stableJson(rebuilt.coverage)) {
    return { validation: 'corrupt', manifest, coverage: { ...rebuilt.coverage, stale: 0 }, reason: 'claim-manifest-hash-mismatch' }
  }
  let stale = 0
  for (const entry of rebuilt.entries) {
    if (entry.supportStatus !== 'supported') continue
    const evidenceStale = entry.evidenceIds.some((evidenceId) => {
      const evidence = queryOne<ResearchEvidence>('SELECT * FROM research_evidence WHERE id = ?', [evidenceId])
      if (!evidence) return true
      let raw: unknown = null
      try { raw = JSON.parse(evidence.locator_json) } catch { return true }
      const locator = tryParseStableReaderLocator(raw)
      if (!locator) return true
      const resolved = resolveSearchEvidence(locator)
      return resolved.verificationStatus !== 'verified' || resolved.resolution === 'unresolved'
    })
    const aggregateStale = entry.aggregateIds.some((aggregateId) => validateResearchAggregateArtifact(aggregateId).validation !== 'verified')
    if (evidenceStale || aggregateStale) stale += 1
  }
  const coverage = { ...rebuilt.coverage, stale }
  if (stale > 0) return { validation: 'stale', manifest, coverage }
  if (rebuilt.coverage.unsupported > 0) return { validation: 'incomplete', manifest, coverage }
  return { validation: 'verified', manifest, coverage }
}

export function finalizeResearchOutputVersion(input: {
  draftOutputVersionId: string
  expectedClaimManifestHash: string
  claimBindings: ResearchClaimBinding[]
}): ResearchOutputVersion {
  const draftOutputVersionId = required(input.draftOutputVersionId, 'research_claim_output_required')
  const expectedHash = required(input.expectedClaimManifestHash, 'research_claim_manifest_hash_required')
  const draft = queryOne<ResearchOutputVersion>('SELECT * FROM research_output_versions WHERE id = ?', [draftOutputVersionId])
  if (!draft || draft.status !== 'draft') throw new Error('research_output_draft_required')
  const claimManifest = queryOne<ResearchClaimManifest>('SELECT * FROM research_claim_manifests WHERE output_version_id = ?', [draft.id])
  if (!claimManifest || claimManifest.manifest_hash !== expectedHash) throw new Error('research_claim_manifest_conflict')
  let inputManifest: {
    recordVersions?: Array<{ recordId?: string; versionId?: string }>
    aggregateArtifacts?: Array<{ aggregateId?: string }>
  }
  try { inputManifest = JSON.parse(draft.input_manifest_json) } catch { throw new Error('research_output_input_manifest_invalid') }
  for (const recordRef of inputManifest.recordVersions || []) {
    const recordId = String(recordRef.recordId || '')
    const latest = queryOne<{ id: string }>('SELECT id FROM research_record_versions WHERE record_id = ? ORDER BY version DESC LIMIT 1', [recordId])
    if (!recordId || !latest || latest.id !== String(recordRef.versionId || '')) throw new Error('research_output_inputs_changed')
  }
  return createResearchOutputVersion({
    outputId: draft.output_id,
    projectId: draft.project_id,
    outputType: draft.output_type,
    title: draft.title,
    content: draft.content,
    recordIds: (inputManifest.recordVersions || []).map((item) => String(item.recordId || '')).filter(Boolean),
    aggregateIds: (inputManifest.aggregateArtifacts || []).map((item) => String(item.aggregateId || '')).filter(Boolean),
    parentVersionId: draft.id,
    status: 'formal',
    claimBindings: input.claimBindings,
  })
}
