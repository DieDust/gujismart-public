/**
 * Read-only library tools for headless MCP / AI agents.
 * Reuses the same search and list services as the desktop UI.
 * Never returns API keys or arbitrary filesystem contents.
 *
 * Response shape is intentionally compact by default so AI clients spend tokens on
 * titles/excerpts/text rather than internal locator hashes. Pass detail:"full" when
 * machine-readable StableReaderLocator fields are required for citation tooling.
 * Desktop UI and non-MCP IPC paths are unaffected.
 */
import type {
  ListDocumentOptions,
  SearchOptions,
  StableReaderLocator,
} from '../../shared/types'
import { resolveCanonicalPageContent } from '../canonical-content'
import { queryAll, queryOne } from '../database'
import { listDocumentsPage } from '../ipc/documents'
import { resolveSearchEvidence } from '../search-evidence-resolver'
import { querySearchV2 } from '../semantic-search'
import { getEmbeddingIndexStats, vectorSearch } from '../embedding-index'
import { getActiveLibraryProjectId } from '../library-projects'
import { VECTOR_SEARCH_MAX_LIMIT } from '../../shared/vector-search'

const MAX_SEARCH_LIMIT = VECTOR_SEARCH_MAX_LIMIT
const MAX_LIST_LIMIT = 50
const MAX_PAGE_RANGE = 20
const MAX_TEXT_CHARS = 12_000
/** Default excerpt length for dialogue-oriented search hits. */
const DEFAULT_EXCERPT_CHARS = 240
const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_HITS_PER_DOC = 3
const MAX_HITS_PER_DOC = 8
const MAX_TOC_ITEMS = 500
const MAX_EXCERPT_LIST_LIMIT = 50
const MAX_EXCERPT_TEXT_CHARS = 2_000

/**
 * User-facing bibliographic metadata keys inside documents.metadata JSON.
 * Everything else in that JSON (file fingerprints, manifests, analysis caches,
 * absolute paths) is internal and must never reach MCP clients, so exposure is
 * whitelist-only: unknown keys are dropped by construction.
 */
const PUBLIC_METADATA_FIELDS = [
  'author',
  'book_author',
  'editor',
  'translator',
  'journal',
  'newspaper',
  'publisher',
  'publish_place',
  'publication_time',
  'publication_year',
  'issue_date',
  'engraving_style',
  'dynasty',
  'version',
  'volume_info',
  'collection',
  'series',
  'university',
  'meeting_name',
  'book_title',
  'keywords',
] as const

function extractPublicMetadata(metadataJson: unknown): Record<string, unknown> {
  let parsed: unknown = metadataJson
  if (typeof metadataJson === 'string') {
    try {
      parsed = JSON.parse(metadataJson)
    } catch {
      return {}
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of PUBLIC_METADATA_FIELDS) {
    const value = record[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && !value.trim()) continue
    if (Array.isArray(value)) {
      const items = value.filter((item) => typeof item === 'string' && item.trim())
      if (items.length > 0) out[key] = items
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const DETAIL_PROP = {
  detail: {
    type: 'string',
    enum: ['compact', 'full'],
    description:
      'Response verbosity. compact (default): dialogue-friendly fields only. full: include internal locator/hash metadata for citation tooling.',
  },
} as const

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'library_search',
    description:
      'Full-text search across the GujiSmart literature library (same engine as the app Search view). Default compact results: title, page, short excerpt, and a small ref {docId,pageNum}. Use detail:"full" only when you need full StableReaderLocator objects for resolve_evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword or phrase' },
        limit: { type: 'number', description: `Max documents to return (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})` },
        folderId: { type: 'string', description: 'Optional folder id scope' },
        tagId: { type: 'string', description: 'Optional tag id scope' },
        docIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional document id allow-list',
        },
        ...DETAIL_PROP,
      },
      required: ['query'],
    },
  },
  {
    name: 'list_documents',
    description:
      'Paginated document list with optional filters (title search, folder, tag, OCR status). Returns compact metadata only (no file paths).',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Title/metadata keyword filter' },
        folderId: { type: 'string' },
        tagId: { type: 'string' },
        ocrStatus: { type: 'string', description: 'e.g. completed, pending' },
        limit: { type: 'number', description: `Page size (1-${MAX_LIST_LIMIT})` },
        offset: { type: 'number', description: 'Pagination offset' },
      },
    },
  },
  {
    name: 'get_document',
    description:
      'Get document metadata (title, author, tags, folders, page counts). By default does not dump every page row; set includePages:true for the page inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document id' },
        includePages: {
          type: 'boolean',
          description: 'If true, include per-page id/ocrStatus/hasText list (can be large). Default false.',
        },
      },
      required: ['docId'],
    },
  },
  {
    name: 'get_page_text',
    description:
      'Read canonical OCR/proof text for one page or a small page range. Default omits content hashes; use detail:"full" to include sourceHash.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        pageNum: { type: 'number', description: '1-based page number (required if pageId omitted)' },
        pageId: { type: 'string', description: 'Page row id (optional alternative to pageNum)' },
        endPageNum: { type: 'number', description: 'Inclusive end page for a range (optional)' },
        ...DETAIL_PROP,
      },
      required: ['docId'],
    },
  },
  {
    name: 'resolve_evidence',
    description:
      'Resolve a StableReaderLocator (from library_search with detail:"full") into verified source text for citation. Prefer get_page_text(docId,pageNum) for ordinary reading.',
    inputSchema: {
      type: 'object',
      properties: {
        locator: {
          type: 'object',
          description: 'StableReaderLocator object from library_search hits when detail is full',
        },
        ...DETAIL_PROP,
      },
      required: ['locator'],
    },
  },
  {
    name: 'get_document_toc',
    description:
      'Table of contents for a document: chapter/section titles with page numbers. Use hits to jump into get_page_text ranges. Returns an empty list when no TOC has been recognized for the document.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document id' },
      },
      required: ['docId'],
    },
  },
  {
    name: 'list_excerpts',
    description:
      'User-curated excerpts and notes (摘录) saved in the library, newest first. Optional filters: docId, keyword. These are human-selected passages, often the most important material in a document.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Optional document id filter' },
        search: { type: 'string', description: 'Keyword filter over excerpt and note text' },
        limit: { type: 'number', description: `Page size (1-${MAX_EXCERPT_LIST_LIMIT})` },
        offset: { type: 'number', description: 'Pagination offset' },
      },
    },
  },
  {
    name: 'list_folders',
    description: 'List library folders (id, name, parent).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tags',
    description: 'List library tags, optionally filtered by name keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
      },
    },
  },
  {
    name: 'library_stats',
    description: 'High-level counts: documents, pages, folders, tags (read-only).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vector_search',
    description:
      'Semantic / embedding search over the vector index (natural-language or topical queries). Prefer this for fuzzy themes; use library_search for exact keywords. Returns compact hits with score and ref; follow up with get_page_text. Requires the user to have built a vector index in Settings.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or topical query' },
        limit: { type: 'number', description: `Max hits (1-${MAX_SEARCH_LIMIT})` },
        folderId: { type: 'string' },
        tagId: { type: 'string' },
        docId: { type: 'string', description: 'Optional: restrict semantic search to one document (fast indexed path)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vector_index_stats',
    description:
      'Vector index status: model, chunk counts, queued/ready docs, whether auto-on-ingest is enabled. Does not expose API keys.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function clampLimit(value: unknown, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, n)
}

function clipText(text: string, max = MAX_TEXT_CHARS): string {
  const value = String(text || '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}

function isFullDetail(input: Record<string, unknown>): boolean {
  const raw = String(input.detail || input.verbosity || 'compact').trim().toLowerCase()
  return raw === 'full' || raw === 'verbose' || raw === 'debug'
}

/** Compact public document fields for AI (no filesystem paths, no DB dump). */
function sanitizeDocListItem(item: Record<string, unknown>): Record<string, unknown> {
  const id = String(item.id || item.documentId || '')
  const out: Record<string, unknown> = {
    id,
    title: item.title ?? null,
    author: item.author ?? null,
    ocrStatus: item.ocr_status ?? item.ocrStatus ?? null,
    pageCount: Number(item.page_count ?? item.pageCount ?? 0) || 0,
    hasLocalFile: Boolean(item.file_path || item.has_local_file || item.hasLocalFile),
  }
  if (item.year != null && String(item.year).trim()) out.year = item.year
  if (item.publisher != null && String(item.publisher).trim()) out.publisher = item.publisher
  if (item.dynasty != null && String(item.dynasty).trim()) out.dynasty = item.dynasty
  return out
}

function toolError(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message }
}

function compactHitRef(docId: string, pageNum: number | null | undefined): { docId: string; pageNum: number | null } {
  return {
    docId,
    pageNum: pageNum == null || !Number.isFinite(Number(pageNum)) ? null : Number(pageNum),
  }
}

export async function callLibraryTool(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<unknown> {
  const input = args && typeof args === 'object' ? args : {}

  switch (name) {
    case 'library_search': {
      const query = String(input.query || '').trim()
      if (!query) return toolError('invalid_args', 'query is required')
      const full = isFullDetail(input)
      const limit = clampLimit(input.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT)
      const hitsPerDoc = clampLimit(input.hitsPerDoc, MAX_HITS_PER_DOC, DEFAULT_HITS_PER_DOC)
      const options: SearchOptions = {
        limit,
        pageSize: Math.min(20, limit),
        autoReindex: false,
        resultMode: 'preview',
      }
      if (input.folderId) options.folderId = String(input.folderId)
      if (input.tagId) options.tagId = String(input.tagId)
      if (Array.isArray(input.docIds)) {
        options.docIds = input.docIds.map((id) => String(id || '').trim()).filter(Boolean)
      }
      const response = querySearchV2(query, options)
      return {
        ok: true,
        query: response.query,
        totalDocuments: response.totalDocuments,
        totalHits: response.totalHits,
        detail: full ? 'full' : 'compact',
        // Omit noisy status/warnings unless full or non-empty useful warnings
        ...(full || (response.warnings && response.warnings.length)
          ? { status: response.status, warnings: response.warnings || [] }
          : {}),
        groups: (response.groups || []).slice(0, limit).map((group) => {
          const documentId = String(group.docId || '')
          const hits = (group.hits || group.topHits || []).slice(0, hitsPerDoc).map((hit) => {
            const pageNum = hit.locator?.pageNum ?? null
            const excerpt = clipText(String(hit.snippet || hit.locator?.matchText || ''), DEFAULT_EXCERPT_CHARS)
            if (full) {
              return {
                pageNum,
                excerpt,
                ref: compactHitRef(documentId, pageNum),
                stableLocator: hit.stableLocator || null,
                locator: hit.locator || null,
              }
            }
            return {
              pageNum,
              excerpt,
              ref: compactHitRef(documentId, pageNum),
            }
          })
          return {
            documentId,
            title: group.title,
            author: group.author,
            hitCount: group.totalHits,
            hits,
          }
        }),
        hint: full
          ? undefined
          : 'Use get_page_text with ref.docId + ref.pageNum to read more. Pass detail:"full" only if you need locator objects for resolve_evidence.',
      }
    }

    case 'list_documents': {
      const options: ListDocumentOptions = {
        limit: clampLimit(input.limit, MAX_LIST_LIMIT, 20),
        offset: Math.max(0, Math.round(Number(input.offset || 0)) || 0),
      }
      if (input.search) options.search = String(input.search)
      if (input.folderId) options.folderId = String(input.folderId)
      if (input.tagId) options.tagId = String(input.tagId)
      if (input.ocrStatus) options.ocrStatus = String(input.ocrStatus)
      const page = listDocumentsPage(options)
      return {
        ok: true,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        items: page.items.map((item) => sanitizeDocListItem(item as unknown as Record<string, unknown>)),
      }
    }

    case 'get_document': {
      const docId = String(input.docId || '').trim()
      if (!docId) return toolError('invalid_args', 'docId is required')
      const libraryProjectId = getActiveLibraryProjectId()
      const doc = queryOne<Record<string, unknown>>(
        `SELECT * FROM documents
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM library_project_documents project_scope
             WHERE project_scope.document_id = documents.id
               AND project_scope.project_id = ?
           )`,
        [docId, libraryProjectId],
      )
      if (!doc) return toolError('not_found', `Document not found: ${docId}`)
      const includePages = Boolean(input.includePages)
      const pageCount = Number(
        queryOne<{ c: number }>('SELECT COUNT(*) as c FROM pages WHERE doc_id = ?', [docId])?.c
        || doc.page_count
        || 0,
      )
      const pagesWithText = Number(
        queryOne<{ c: number }>(
          `SELECT COUNT(*) as c FROM pages
           WHERE doc_id = ?
             AND (
               TRIM(COALESCE(NULLIF(proofed_text, ''), NULLIF(ocr_text, ''), '')) <> ''
               OR COALESCE(proofed_text_ref, ocr_text_ref, '') <> ''
             )`,
          [docId],
        )?.c || 0,
      )
      const tags = queryAll<{ id: string; name: string; is_metadata: number }>(
        'SELECT t.id, t.name, COALESCE(dt.is_metadata, 0) as is_metadata FROM tags t INNER JOIN document_tags dt ON t.id = dt.tag_id WHERE dt.doc_id = ? AND t.library_project_id = ? ORDER BY t.name',
        [docId, libraryProjectId],
      )
      const folders = queryAll<{ id: string; name: string }>(
        'SELECT f.id, f.name FROM folders f INNER JOIN document_folders df ON f.id = df.folder_id WHERE df.doc_id = ? AND f.library_project_id = ? ORDER BY f.name',
        [docId, libraryProjectId],
      )
      const sanitized = sanitizeDocListItem(doc)
      const document: Record<string, unknown> = {
        ...sanitized,
        pageCount,
        pagesWithText,
        tags: tags.map((tag) => ({
          id: tag.id,
          name: tag.name,
          /** true when the tag was derived from bibliographic metadata (author/dynasty/publisher/...). */
          isMetadata: Number(tag.is_metadata || 0) > 0,
        })),
        folders,
        // Whitelisted bibliographic fields only; internal pdf_* / manifest keys are never exposed.
        metadata: extractPublicMetadata(doc.metadata),
      }
      if (doc.source != null && String(doc.source).trim()) document.source = doc.source
      if (doc.doc_type != null && String(doc.doc_type).trim() && doc.doc_type !== 'unknown') {
        document.docType = doc.doc_type
      }
      if (includePages) {
        const pages = queryAll<{
          id: string
          page_num: number
          literature_page_num?: number | null
          ocr_status: string | null
          has_text: number
        }>(
          `SELECT
             id,
             page_num,
             literature_page_num,
             ocr_status,
             CASE WHEN TRIM(COALESCE(NULLIF(proofed_text, ''), NULLIF(ocr_text, ''), '')) <> ''
                    OR COALESCE(proofed_text_ref, ocr_text_ref, '') <> '' THEN 1 ELSE 0 END as has_text
           FROM pages
           WHERE doc_id = ?
           ORDER BY page_num`,
          [docId],
        )
        document.pages = pages.map((page) => ({
          id: page.id,
          pageNum: page.page_num,
          literaturePageNum: page.literature_page_num ?? null,
          ocrStatus: page.ocr_status,
          hasText: Number(page.has_text || 0) > 0,
        }))
      }
      return { ok: true, document }
    }

    case 'get_page_text': {
      const docId = String(input.docId || '').trim()
      if (!docId) return toolError('invalid_args', 'docId is required')
      const full = isFullDetail(input)
      const pageId = String(input.pageId || '').trim()
      const startPage = Math.max(1, Math.round(Number(input.pageNum || 0)) || 0)
      const endPage = Math.max(startPage, Math.round(Number(input.endPageNum || startPage)) || startPage)

      let pageRows: Array<{ id: string; page_num: number; literature_page_num?: number | null }>
      if (pageId) {
        const row = queryOne<{ id: string; page_num: number; literature_page_num?: number | null; doc_id: string }>(
          'SELECT id, page_num, literature_page_num, doc_id FROM pages WHERE id = ?',
          [pageId],
        )
        if (!row || row.doc_id !== docId) return toolError('not_found', 'Page not found for document')
        pageRows = [{ id: row.id, page_num: row.page_num, literature_page_num: row.literature_page_num }]
      } else {
        if (!startPage) return toolError('invalid_args', 'pageNum or pageId is required')
        if (endPage - startPage + 1 > MAX_PAGE_RANGE) {
          return toolError('invalid_args', `page range cannot exceed ${MAX_PAGE_RANGE} pages`)
        }
        // pageNum accepts physical index (default) for navigation compatibility.
        pageRows = queryAll<{ id: string; page_num: number; literature_page_num?: number | null }>(
          `SELECT id, page_num, literature_page_num FROM pages
           WHERE doc_id = ? AND page_num >= ? AND page_num <= ?
           ORDER BY page_num`,
          [docId, startPage, endPage],
        )
        if (pageRows.length === 0) return toolError('not_found', 'No pages in the requested range')
      }

      const pages = []
      for (const row of pageRows) {
        const literaturePageNum = Number(row.literature_page_num || 0) > 0
          ? Number(row.literature_page_num)
          : null
        try {
          const canonical = resolveCanonicalPageContent(row.id)
          const entry: Record<string, unknown> = {
            pageId: row.id,
            /** Physical / PDF order (for navigation). */
            pageNum: row.page_num,
            /** Continuity-resolved printed literature page (prefer for citations). */
            literaturePageNum,
            source: canonical.source,
            text: clipText(canonical.text),
          }
          if (full) entry.sourceHash = canonical.sourceHash
          pages.push(entry)
        } catch {
          pages.push({
            pageId: row.id,
            pageNum: row.page_num,
            literaturePageNum,
            source: 'missing',
            text: '',
            error: 'canonical_content_unavailable',
          })
        }
      }
      return { ok: true, docId, pages }
    }

    case 'resolve_evidence': {
      const locator = input.locator as StableReaderLocator | undefined
      if (!locator || typeof locator !== 'object') {
        return toolError('invalid_args', 'locator object is required')
      }
      const full = isFullDetail(input)
      try {
        const resolved = resolveSearchEvidence(locator)
        const base: Record<string, unknown> = {
          ok: true,
          verificationStatus: resolved.verificationStatus,
          precision: resolved.precision,
          text: clipText(resolved.text || ''),
          reason: resolved.reason,
          sourceKind: resolved.sourceKind,
          ref: compactHitRef(
            String(
              (locator as { documentId?: string; docId?: string }).documentId
              || (locator as { docId?: string }).docId
              || resolved.stableLocator?.documentId
              || '',
            ),
            (locator as { pageNum?: number }).pageNum ?? resolved.stableLocator?.pageNum ?? null,
          ),
        }
        if (full) {
          base.resolution = resolved.resolution
          base.stableLocator = resolved.stableLocator
          base.contentVersion = resolved.contentVersion
          base.sourceHash = resolved.sourceHash
        }
        return base
      } catch (error) {
        return toolError('resolve_failed', error instanceof Error ? error.message : String(error))
      }
    }

    case 'get_document_toc': {
      const docId = String(input.docId || '').trim()
      if (!docId) return toolError('invalid_args', 'docId is required')
      const libraryProjectId = getActiveLibraryProjectId()
      const doc = queryOne<{ id: string; title: string | null }>(
        `SELECT id, title FROM documents
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM library_project_documents project_scope
             WHERE project_scope.document_id = documents.id
               AND project_scope.project_id = ?
           )`,
        [docId, libraryProjectId],
      )
      if (!doc) return toolError('not_found', `Document not found: ${docId}`)
      const rows = queryAll<{
        id: string
        title: string
        level: number | null
        order_index: number | null
        parent_id: string | null
        source_page_num: number | null
      }>(
        `SELECT id, title, level, order_index, parent_id, source_page_num
         FROM document_toc_items
         WHERE doc_id = ? AND COALESCE(status, 'active') = 'active'
         ORDER BY order_index ASC
         LIMIT ?`,
        [docId, MAX_TOC_ITEMS],
      )
      return {
        ok: true,
        docId,
        title: doc.title,
        totalItems: rows.length,
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          level: Number(row.level || 1),
          parentId: row.parent_id || null,
          /** Physical page number; feed into get_page_text pageNum. */
          pageNum: Number(row.source_page_num || 0) > 0 ? Number(row.source_page_num) : null,
        })),
        hint: rows.length > 0
          ? 'Use get_page_text with docId + pageNum (until the next item pageNum) to read a chapter.'
          : 'No TOC recognized for this document; use get_page_text page ranges instead.',
      }
    }

    case 'list_excerpts': {
      const libraryProjectId = getActiveLibraryProjectId()
      const limit = clampLimit(input.limit, MAX_EXCERPT_LIST_LIMIT, 20)
      const offset = Math.max(0, Math.round(Number(input.offset || 0)) || 0)
      const docId = String(input.docId || '').trim()
      const search = String(input.search || '').trim()
      const conditions = ['rn.library_project_id = ?']
      const params: unknown[] = [libraryProjectId]
      if (docId) {
        conditions.push('rn.doc_id = ?')
        params.push(docId)
      }
      if (search) {
        conditions.push('(rn.excerpt LIKE ? OR rn.note LIKE ?)')
        params.push(`%${search}%`, `%${search}%`)
      }
      const whereSql = `WHERE ${conditions.join(' AND ')}`
      const total = Number(
        queryOne<{ c: number }>(
          `SELECT COUNT(*) as c FROM research_notes rn ${whereSql}`,
          params,
        )?.c || 0,
      )
      const rows = queryAll<{
        id: string
        doc_id: string
        page_num: number | null
        kind: string | null
        excerpt: string
        note: string | null
        tags: string | null
        citation_text: string | null
        updated_at: string | null
        doc_title: string | null
      }>(
        `SELECT rn.id, rn.doc_id, rn.page_num, rn.kind, rn.excerpt, rn.note, rn.tags,
                rn.citation_text, rn.updated_at, d.title as doc_title
         FROM research_notes rn
         INNER JOIN documents d ON rn.doc_id = d.id
         ${whereSql}
         ORDER BY rn.updated_at DESC, rn.id ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )
      return {
        ok: true,
        total,
        limit,
        offset,
        items: rows.map((row) => {
          const pageNum = Number(row.page_num || 0) > 0 ? Number(row.page_num) : null
          const item: Record<string, unknown> = {
            id: row.id,
            docId: row.doc_id,
            docTitle: row.doc_title,
            pageNum,
            kind: row.kind || 'quote',
            excerpt: clipText(String(row.excerpt || ''), MAX_EXCERPT_TEXT_CHARS),
            ref: compactHitRef(row.doc_id, pageNum),
          }
          if (row.note && row.note.trim()) item.note = clipText(row.note, MAX_EXCERPT_TEXT_CHARS)
          if (row.tags && row.tags.trim()) item.tags = row.tags
          if (row.citation_text && row.citation_text.trim()) item.citation = row.citation_text
          if (row.updated_at) item.updatedAt = row.updated_at
          return item
        }),
      }
    }

    case 'list_folders': {
      const libraryProjectId = getActiveLibraryProjectId()
      const folders = queryAll<{ id: string; name: string; parent_id: string | null; sort_order: number }>(
        'SELECT id, name, parent_id, sort_order FROM folders WHERE library_project_id = ? ORDER BY sort_order ASC, name ASC',
        [libraryProjectId],
      )
      return { ok: true, folders }
    }

    case 'list_tags': {
      const libraryProjectId = getActiveLibraryProjectId()
      const search = String(input.search || '').trim()
      const tags = search
        ? queryAll<{ id: string; name: string; usage_count: number }>(
          'SELECT id, name, usage_count FROM tags WHERE library_project_id = ? AND name LIKE ? ORDER BY usage_count DESC, name ASC LIMIT 200',
          [libraryProjectId, `%${search}%`],
        )
        : queryAll<{ id: string; name: string; usage_count: number }>(
          'SELECT id, name, usage_count FROM tags WHERE library_project_id = ? ORDER BY usage_count DESC, name ASC LIMIT 500',
          [libraryProjectId],
        )
      return { ok: true, tags }
    }

    case 'library_stats': {
      const libraryProjectId = getActiveLibraryProjectId()
      const documentScopeSql = 'SELECT document_id FROM library_project_documents WHERE project_id = ?'
      const documents = Number(queryOne<{ c: number }>(
        `SELECT COUNT(*) as c FROM documents WHERE id IN (${documentScopeSql})`,
        [libraryProjectId],
      )?.c || 0)
      const pages = Number(queryOne<{ c: number }>(
        `SELECT COUNT(*) as c FROM pages WHERE doc_id IN (${documentScopeSql})`,
        [libraryProjectId],
      )?.c || 0)
      const folders = Number(queryOne<{ c: number }>('SELECT COUNT(*) as c FROM folders WHERE library_project_id = ?', [libraryProjectId])?.c || 0)
      const tags = Number(queryOne<{ c: number }>('SELECT COUNT(*) as c FROM tags WHERE library_project_id = ?', [libraryProjectId])?.c || 0)
      const ocrCompleted = Number(
        queryOne<{ c: number }>(
          `SELECT COUNT(*) as c FROM documents
           WHERE ocr_status = 'completed' AND id IN (${documentScopeSql})`,
          [libraryProjectId],
        )?.c || 0,
      )
      return {
        ok: true,
        documents,
        pages,
        folders,
        tags,
        ocrCompletedDocuments: ocrCompleted,
      }
    }

    case 'vector_search': {
      const query = String(input.query || '').trim()
      if (!query) return toolError('invalid_args', 'query is required')
      const result = await vectorSearch(query, {
        limit: clampLimit(input.limit, MAX_SEARCH_LIMIT, 15),
        folderId: input.folderId ? String(input.folderId) : undefined,
        tagId: input.tagId ? String(input.tagId) : undefined,
        docId: input.docId ? String(input.docId) : undefined,
      })
      return result
    }

    case 'vector_index_stats': {
      const stats = getEmbeddingIndexStats()
      return {
        ok: true,
        modelId: stats.modelId,
        dim: stats.dim,
        autoOnIngest: stats.autoOnIngest,
        apiKeyConfigured: stats.apiKeyConfigured,
        chunks: stats.chunks,
        docsReady: stats.docsReady,
        docsQueued: stats.docsQueued,
        docsProcessing: stats.docsProcessing,
        docsError: stats.docsError,
        docsPending: stats.docsPending,
        queuePaused: stats.queuePaused,
        message: stats.message,
      }
    }

    default:
      return toolError('unknown_tool', `Unknown tool: ${name}`)
  }
}
