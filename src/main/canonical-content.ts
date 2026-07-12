import { createHash } from 'crypto'
import type { CanonicalPageContent, CursorPage, DocumentPage, OcrStatus, ProofStatus } from '../shared/types'
import { queryAll, queryOne } from './database'
import { hydratePagePayloadRow } from './page-payload-store'

interface CanonicalPageRow extends DocumentPage {
  active_ocr_artifact_id?: string | null
  proof_base_artifact_id?: string | null
  proof_base_stale?: number | null
}

interface ActiveArtifactRow {
  id: string
  page_id: string
  ocr_text: string | null
  ocr_text_ref: string | null
  source_hash: string
}

interface LegacyVersionRow {
  id: string
  page_id: string
  ocr_text: string | null
  ocr_text_ref: string | null
}

function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizedText(value: unknown): string {
  const text = String(value || '')
  return text === '{"externalized":true}' ? '' : text.trim()
}

function makeContent(input: {
  page: CanonicalPageRow
  text: string
  source: CanonicalPageContent['source']
  verificationStatus: CanonicalPageContent['verificationStatus']
  sourceHash?: string
  artifactId?: string | null
  activeArtifactId?: string | null
}): CanonicalPageContent {
  return {
    pageId: input.page.id,
    docId: input.page.doc_id,
    pageNum: Number(input.page.page_num || 0),
    text: input.text,
    source: input.source,
    verificationStatus: input.verificationStatus,
    sourceHash: input.sourceHash || textHash(input.text),
    artifactId: input.artifactId || null,
    activeArtifactId: input.activeArtifactId || null,
    baseArtifactId: input.page.proof_base_artifact_id || null,
    proofStatus: input.page.proof_status as ProofStatus,
    ocrStatus: input.page.ocr_status as OcrStatus,
    proofBaseStale: Boolean(input.page.proof_base_stale),
  }
}

function resolveHydratedPage(
  page: CanonicalPageRow,
  activeArtifact: ActiveArtifactRow | null,
  legacyVersion: LegacyVersionRow | null,
): CanonicalPageContent {
  const activeArtifactId = activeArtifact?.id
    || (legacyVersion?.id ? `legacy-page-version:${legacyVersion.id}` : page.active_ocr_artifact_id || null)
  const proofText = normalizedText(page.proofed_text)
  if (page.proof_status === 'completed' && proofText) {
    return makeContent({ page, text: proofText, source: 'human-proof', verificationStatus: 'confirmed', activeArtifactId })
  }
  const artifactText = normalizedText(activeArtifact?.ocr_text)
  if (activeArtifact && artifactText) {
    return makeContent({
      page,
      text: artifactText,
      source: 'ocr-artifact',
      verificationStatus: 'machine',
      sourceHash: activeArtifact.source_hash,
      artifactId: activeArtifact.id,
      activeArtifactId: activeArtifact.id,
    })
  }
  const legacyVersionText = normalizedText(legacyVersion?.ocr_text)
  if (legacyVersion && legacyVersionText) {
    const artifactId = `legacy-page-version:${legacyVersion.id}`
    return makeContent({ page, text: legacyVersionText, source: 'ocr-artifact', verificationStatus: 'machine', artifactId, activeArtifactId: artifactId })
  }
  const projectionText = normalizedText(page.ocr_text)
  if (projectionText) {
    return makeContent({ page, text: projectionText, source: 'legacy-projection', verificationStatus: 'machine', activeArtifactId })
  }
  return makeContent({ page, text: '', source: 'unavailable', verificationStatus: 'unavailable', activeArtifactId })
}

export function resolveCanonicalPageContent(pageIdValue: string): CanonicalPageContent {
  const pageId = String(pageIdValue || '').trim()
  if (!pageId) throw new Error('canonical_page_id_required')
  const rawPage = queryOne<CanonicalPageRow>('SELECT * FROM pages WHERE id = ?', [pageId])
  if (!rawPage) throw new Error('canonical_page_not_found')
  const page = hydratePagePayloadRow(rawPage)
  const activeArtifactRaw = queryOne<ActiveArtifactRow>(
    `SELECT a.id, a.page_id, a.ocr_text, a.ocr_text_ref, a.source_hash
       FROM ocr_page_active_artifacts active
       INNER JOIN ocr_artifact_versions a ON a.id = active.artifact_id
      WHERE active.page_id = ? AND a.status = 'active'`,
    [pageId],
  )
  const activeArtifact = activeArtifactRaw ? hydratePagePayloadRow(activeArtifactRaw) : null
  const legacyVersionRaw = activeArtifact ? null : queryOne<LegacyVersionRow>(
    `SELECT id, page_id, ocr_text, ocr_text_ref FROM page_ocr_versions
      WHERE page_id = ? AND is_active = 1 AND status = 'completed'
      ORDER BY updated_at DESC LIMIT 1`,
    [pageId],
  )
  const legacyVersion = legacyVersionRaw ? hydratePagePayloadRow(legacyVersionRaw) : null
  return resolveHydratedPage(page, activeArtifact, legacyVersion)
}

export function listCanonicalPageContents(
  docIdValue: string,
  options?: { limit?: number; cursor?: string | null },
): CursorPage<CanonicalPageContent> {
  const docId = String(docIdValue || '').trim()
  if (!docId) throw new Error('canonical_doc_id_required')
  const limit = options?.limit === undefined ? 50 : Number(options.limit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('canonical_page_limit_invalid')
  const cursor = options?.cursor ? Number(options.cursor) : 0
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('canonical_cursor_invalid')
  const rows = queryAll<CanonicalPageRow & { rowid: number }>(
    'SELECT rowid, * FROM pages WHERE doc_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
    [docId, cursor, limit + 1],
  )
  const page = rows.slice(0, limit).map(hydratePagePayloadRow)
  return {
    items: attachCanonicalPageContent(page).map((row) => row.canonical_content as CanonicalPageContent),
    nextCursor: rows.length > limit ? String(page[page.length - 1].rowid) : null,
  }
}

export function attachCanonicalPageContent<T extends DocumentPage>(pages: T[]): T[] {
  const activeByPage = new Map<string, ActiveArtifactRow>()
  const legacyByPage = new Map<string, LegacyVersionRow>()
  for (let offset = 0; offset < pages.length; offset += 200) {
    const ids = pages.slice(offset, offset + 200).map((page) => page.id)
    if (ids.length === 0) continue
    const placeholders = ids.map(() => '?').join(', ')
    queryAll<ActiveArtifactRow>(
      `SELECT a.id, a.page_id, a.ocr_text, a.ocr_text_ref, a.source_hash
         FROM ocr_page_active_artifacts active
         INNER JOIN ocr_artifact_versions a ON a.id = active.artifact_id
        WHERE active.page_id IN (${placeholders}) AND a.status = 'active'`,
      ids,
    ).map(hydratePagePayloadRow).forEach((artifact) => activeByPage.set(artifact.page_id, artifact))
    queryAll<LegacyVersionRow>(
      `SELECT id, page_id, ocr_text, ocr_text_ref FROM page_ocr_versions
        WHERE page_id IN (${placeholders}) AND is_active = 1 AND status = 'completed'
        ORDER BY updated_at DESC`,
      ids,
    ).map(hydratePagePayloadRow).forEach((version) => {
      if (!legacyByPage.has(version.page_id)) legacyByPage.set(version.page_id, version)
    })
  }
  return pages.map((page) => ({
    ...page,
    canonical_content: resolveHydratedPage(page as T & CanonicalPageRow, activeByPage.get(page.id) || null, legacyByPage.get(page.id) || null),
  }))
}
