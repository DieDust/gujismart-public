import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import type { CitationResolutionV2 } from '../shared/citation-resolution-v2'
import type { CitationSnapshot, CursorPage } from '../shared/types'
import { queryAll, queryOne, run, scheduleDatabaseSave } from './database'

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

export function getCitationSourceVersionHashes(documentId: string, styleId: string, templateId: string): {
  metadataVersion: string
  styleVersion: string
  templateVersion: string
  formatId: string
} | null {
  const document = queryOne<Record<string, unknown>>(
    'SELECT id, title, author, dynasty, source, doc_type, metadata, updated_at FROM documents WHERE id = ?',
    [documentId],
  )
  const style = queryOne<Record<string, unknown>>(
    'SELECT id, name, description, is_default, created_at, updated_at FROM citation_styles WHERE id = ?',
    [styleId],
  )
  const template = queryOne<Record<string, unknown>>(
    'SELECT id, style_id, name, format_type, template_text, field_mappings, is_default, created_at, updated_at FROM citation_templates WHERE id = ? AND style_id = ?',
    [templateId, styleId],
  )
  if (!document || !style || !template) return null
  return {
    metadataVersion: sha256(stableJson(document)),
    styleVersion: sha256(stableJson(style)),
    templateVersion: sha256(stableJson(template)),
    formatId: String(template.format_type || 'Custom'),
  }
}

function snapshotCore(row: Omit<CitationSnapshot, 'id' | 'identity_hash' | 'created_at'>): Record<string, unknown> {
  return {
    documentId: row.document_id,
    styleId: row.style_id,
    templateId: row.template_id,
    citationType: row.citation_type,
    formatId: row.format_id,
    metadataVersion: row.metadata_version,
    styleVersion: row.style_version,
    templateVersion: row.template_version,
    resolutionJson: row.resolution_json,
    renderedText: row.rendered_text,
    verificationStatus: row.verification_status,
  }
}

export function persistCitationSnapshot(input: {
  documentId: string
  styleId: string
  templateId: string
  resolution: CitationResolutionV2
}): CitationSnapshot {
  const documentId = required(input.documentId, 'citation_snapshot_document_required')
  const styleId = required(input.styleId, 'citation_snapshot_style_required')
  const templateId = required(input.templateId, 'citation_snapshot_template_required')
  const versions = getCitationSourceVersionHashes(documentId, styleId, templateId)
  if (!versions) throw new Error('citation_snapshot_source_not_found')
  if (input.resolution.documentId !== documentId) throw new Error('citation_snapshot_document_mismatch')
  const resolution: CitationResolutionV2 = {
    ...input.resolution,
    formatId: versions.formatId,
    styleVersion: versions.styleVersion,
    templateVersion: versions.templateVersion,
  }
  const rowCore = {
    document_id: documentId,
    style_id: styleId,
    template_id: templateId,
    citation_type: resolution.citationType,
    format_id: resolution.formatId,
    metadata_version: versions.metadataVersion,
    style_version: versions.styleVersion,
    template_version: versions.templateVersion,
    resolution_json: stableJson(resolution),
    rendered_text: String(resolution.rendered || ''),
    verification_status: resolution.verificationStatus,
    snapshot_hash: '',
  } satisfies Omit<CitationSnapshot, 'id' | 'identity_hash' | 'created_at'>
  rowCore.snapshot_hash = sha256(stableJson(snapshotCore(rowCore)))
  const identityHash = sha256(stableJson({ ...snapshotCore(rowCore), snapshotHash: rowCore.snapshot_hash }))
  const existing = queryOne<CitationSnapshot>('SELECT * FROM citation_snapshots WHERE identity_hash = ?', [identityHash])
  if (existing) return existing
  const id = `citation_snapshot_${nanoid(20)}`
  run(
    `INSERT INTO citation_snapshots
     (id, identity_hash, document_id, style_id, template_id, citation_type, format_id, metadata_version, style_version,
      template_version, resolution_json, rendered_text, verification_status, snapshot_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, identityHash, documentId, styleId, templateId, rowCore.citation_type, rowCore.format_id, rowCore.metadata_version,
      rowCore.style_version, rowCore.template_version, rowCore.resolution_json, rowCore.rendered_text,
      rowCore.verification_status, rowCore.snapshot_hash, Date.now()],
  )
  scheduleDatabaseSave()
  return queryOne<CitationSnapshot>('SELECT * FROM citation_snapshots WHERE id = ?', [id])!
}

export function validateCitationSnapshot(idValue: string): {
  validation: 'verified' | 'stale' | 'corrupt' | 'not-found'
  snapshot: CitationSnapshot | null
} {
  const id = required(idValue, 'citation_snapshot_required')
  const snapshot = queryOne<CitationSnapshot>('SELECT * FROM citation_snapshots WHERE id = ?', [id])
  if (!snapshot) return { validation: 'not-found', snapshot: null }
  let resolution: CitationResolutionV2
  try { resolution = JSON.parse(snapshot.resolution_json) } catch { return { validation: 'corrupt', snapshot } }
  if (resolution.schemaVersion !== 'citation-resolution/v2' || resolution.documentId !== snapshot.document_id
    || resolution.styleVersion !== snapshot.style_version || resolution.templateVersion !== snapshot.template_version
    || sha256(stableJson(snapshotCore(snapshot))) !== snapshot.snapshot_hash) {
    return { validation: 'corrupt', snapshot }
  }
  const versions = getCitationSourceVersionHashes(snapshot.document_id, snapshot.style_id, snapshot.template_id)
  if (!versions || versions.metadataVersion !== snapshot.metadata_version || versions.styleVersion !== snapshot.style_version
    || versions.templateVersion !== snapshot.template_version || versions.formatId !== snapshot.format_id) {
    return { validation: 'stale', snapshot }
  }
  return { validation: 'verified', snapshot }
}

export function listCitationSnapshots(
  documentIdValue: string,
  options?: { limit?: number; cursor?: string | null },
): CursorPage<CitationSnapshot> {
  const documentId = required(documentIdValue, 'citation_snapshot_document_required')
  const limit = options?.limit === undefined ? 50 : Number(options.limit)
  const cursor = options?.cursor ? Number(options.cursor) : 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('citation_snapshot_limit_invalid')
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('citation_snapshot_cursor_invalid')
  const rows = queryAll<CitationSnapshot & { snapshot_rowid: number }>(
    'SELECT rowid AS snapshot_rowid, * FROM citation_snapshots WHERE document_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
    [documentId, cursor, limit + 1],
  )
  const page = rows.slice(0, limit)
  return { items: page, nextCursor: rows.length > limit ? String(page[page.length - 1].snapshot_rowid) : null }
}
