import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { nanoid } from 'nanoid'
import type { CursorPage, ExportArtifact, ExportSnapshot } from '../shared/types'
import { queryAll, queryOne, run, scheduleDatabaseSave } from './database'
import { resolveCanonicalPageContent } from './canonical-content'

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function documentVersion(documentId: string): string | null {
  const row = queryOne<Record<string, unknown>>('SELECT id, title, author, dynasty, source, doc_type, metadata, updated_at FROM documents WHERE id = ?', [documentId])
  return row ? sha256(stableJson(row)) : null
}

export interface ExportSnapshotPageInput {
  id: string
  page_num: number
  canonical_content_version?: string | null
  canonical_source_hash?: string | null
  active_ocr_version_id?: string | null
}

function currentPageManifest(documentId: string): string {
  const pages = queryAll<{ id: string; page_num: number }>('SELECT id, page_num FROM pages WHERE doc_id = ? ORDER BY page_num, id', [documentId])
  return stableJson(pages.map((page) => {
    const content = resolveCanonicalPageContent(page.id)
    return {
      id: page.id,
      pageNum: page.page_num,
      canonicalContentVersion: `${content.source}:${content.artifactId || content.activeArtifactId || content.baseArtifactId || 'projection'}`,
      canonicalSourceHash: content.sourceHash,
      activeOcrVersionId: content.activeArtifactId,
    }
  }))
}

export function persistExportSnapshot(input: {
  documentId: string
  format: string
  options?: unknown
  pages?: ExportSnapshotPageInput[]
}): ExportSnapshot {
  const documentId = String(input.documentId || '').trim()
  const format = String(input.format || '').trim()
  if (!documentId) throw new Error('export_snapshot_document_required')
  if (!format) throw new Error('export_snapshot_format_required')
  const sourceVersion = documentVersion(documentId)
  if (!sourceVersion) throw new Error('export_snapshot_document_not_found')
  const pageManifestJson = currentPageManifest(documentId)
  const optionsJson = stableJson(input.options || {})
  const snapshotHash = sha256(stableJson({ documentId, format, optionsJson, sourceVersion, pageManifestJson }))
  const existing = queryOne<ExportSnapshot>('SELECT * FROM export_snapshots WHERE identity_hash = ?', [snapshotHash])
  if (existing) return existing
  const id = `export_snapshot_${nanoid(20)}`
  run(`INSERT INTO export_snapshots (id, identity_hash, document_id, format, options_json, source_version, page_manifest_json, snapshot_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, snapshotHash, documentId, format, optionsJson, sourceVersion, pageManifestJson, snapshotHash, Date.now()])
  scheduleDatabaseSave()
  return queryOne<ExportSnapshot>('SELECT * FROM export_snapshots WHERE id = ?', [id])!
}

export function validateExportSnapshot(id: string): { validation: 'verified' | 'stale' | 'corrupt' | 'not-found'; snapshot: ExportSnapshot | null } {
  const snapshot = queryOne<ExportSnapshot>('SELECT * FROM export_snapshots WHERE id = ?', [id])
  if (!snapshot) return { validation: 'not-found', snapshot: null }
  try { JSON.parse(snapshot.options_json); JSON.parse(snapshot.page_manifest_json) } catch { return { validation: 'corrupt', snapshot } }
  const expected = sha256(stableJson({ documentId: snapshot.document_id, format: snapshot.format, optionsJson: snapshot.options_json, sourceVersion: snapshot.source_version, pageManifestJson: snapshot.page_manifest_json }))
  if (expected !== snapshot.snapshot_hash || snapshot.identity_hash !== snapshot.snapshot_hash) return { validation: 'corrupt', snapshot }
  const sourceCurrent = documentVersion(snapshot.document_id) === snapshot.source_version
  let pagesCurrent = false
  try { pagesCurrent = currentPageManifest(snapshot.document_id) === snapshot.page_manifest_json } catch { pagesCurrent = false }
  return { validation: sourceCurrent && pagesCurrent ? 'verified' : 'stale', snapshot }
}

export function persistExportArtifact(input: { snapshotId: string; exportPath: string; contentHash: string; byteSize: number }): ExportArtifact {
  if (!queryOne('SELECT id FROM export_snapshots WHERE id = ?', [input.snapshotId])) throw new Error('export_artifact_snapshot_not_found')
  if (!/^[a-f0-9]{64}$/.test(input.contentHash) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1) throw new Error('export_artifact_integrity_invalid')
  const id = `export_artifact_${nanoid(20)}`
  run(`INSERT INTO export_artifacts (id, snapshot_id, export_path, content_hash, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.snapshotId, input.exportPath, input.contentHash, input.byteSize, Date.now()])
  scheduleDatabaseSave()
  return queryOne<ExportArtifact>('SELECT * FROM export_artifacts WHERE id = ?', [id])!
}

export function validateExportArtifact(id: string): { validation: 'verified' | 'missing' | 'corrupt' | 'not-found'; artifact: ExportArtifact | null } {
  const artifact = queryOne<ExportArtifact>('SELECT * FROM export_artifacts WHERE id = ?', [id])
  if (!artifact) return { validation: 'not-found', artifact: null }
  if (!existsSync(artifact.export_path)) return { validation: 'missing', artifact }
  const stat = statSync(artifact.export_path)
  if (!stat.isFile() || stat.size !== artifact.byte_size) return { validation: 'corrupt', artifact }
  const hash = createHash('sha256').update(readFileSync(artifact.export_path)).digest('hex')
  return { validation: hash === artifact.content_hash ? 'verified' : 'corrupt', artifact }
}

export function listExportSnapshots(documentId: string, options?: { limit?: number; cursor?: string | null }): CursorPage<ExportSnapshot> {
  const limit = options?.limit === undefined ? 50 : Number(options.limit)
  const cursor = options?.cursor ? Number(options.cursor) : 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('export_snapshot_limit_invalid')
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('export_snapshot_cursor_invalid')
  const rows = queryAll<ExportSnapshot & { snapshot_rowid: number }>('SELECT rowid AS snapshot_rowid, * FROM export_snapshots WHERE document_id = ? AND rowid > ? ORDER BY rowid LIMIT ?', [documentId, cursor, limit + 1])
  const page = rows.slice(0, limit)
  return { items: page, nextCursor: rows.length > limit ? String(page[page.length - 1].snapshot_rowid) : null }
}
