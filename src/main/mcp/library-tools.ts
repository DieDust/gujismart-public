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

const MAX_SEARCH_LIMIT = 50
const MAX_LIST_LIMIT = 50
const MAX_PAGE_RANGE = 20
const MAX_TEXT_CHARS = 12_000
/** Default excerpt length for dialogue-oriented search hits. */
const DEFAULT_EXCERPT_CHARS = 240
const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_HITS_PER_DOC = 3
const MAX_HITS_PER_DOC = 8

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
      const doc = queryOne<Record<string, unknown>>('SELECT * FROM documents WHERE id = ?', [docId])
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
      const tags = queryAll<{ id: string; name: string }>(
        'SELECT t.id, t.name FROM tags t INNER JOIN document_tags dt ON t.id = dt.tag_id WHERE dt.doc_id = ? ORDER BY t.name',
        [docId],
      )
      const folders = queryAll<{ id: string; name: string }>(
        'SELECT f.id, f.name FROM folders f INNER JOIN document_folders df ON f.id = df.folder_id WHERE df.doc_id = ? ORDER BY f.name',
        [docId],
      )
      const sanitized = sanitizeDocListItem(doc)
      const document: Record<string, unknown> = {
        ...sanitized,
        pageCount,
        pagesWithText,
        tags,
        folders,
      }
      if (includePages) {
        const pages = queryAll<{
          id: string
          page_num: number
          ocr_status: string | null
          has_text: number
        }>(
          `SELECT
             id,
             page_num,
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

      let pageRows: Array<{ id: string; page_num: number }>
      if (pageId) {
        const row = queryOne<{ id: string; page_num: number; doc_id: string }>(
          'SELECT id, page_num, doc_id FROM pages WHERE id = ?',
          [pageId],
        )
        if (!row || row.doc_id !== docId) return toolError('not_found', 'Page not found for document')
        pageRows = [{ id: row.id, page_num: row.page_num }]
      } else {
        if (!startPage) return toolError('invalid_args', 'pageNum or pageId is required')
        if (endPage - startPage + 1 > MAX_PAGE_RANGE) {
          return toolError('invalid_args', `page range cannot exceed ${MAX_PAGE_RANGE} pages`)
        }
        pageRows = queryAll<{ id: string; page_num: number }>(
          `SELECT id, page_num FROM pages
           WHERE doc_id = ? AND page_num >= ? AND page_num <= ?
           ORDER BY page_num`,
          [docId, startPage, endPage],
        )
        if (pageRows.length === 0) return toolError('not_found', 'No pages in the requested range')
      }

      const pages = []
      for (const row of pageRows) {
        try {
          const canonical = resolveCanonicalPageContent(row.id)
          const entry: Record<string, unknown> = {
            pageId: row.id,
            pageNum: row.page_num,
            source: canonical.source,
            text: clipText(canonical.text),
          }
          if (full) entry.sourceHash = canonical.sourceHash
          pages.push(entry)
        } catch {
          pages.push({
            pageId: row.id,
            pageNum: row.page_num,
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

    case 'list_folders': {
      const folders = queryAll<{ id: string; name: string; parent_id: string | null; sort_order: number }>(
        'SELECT id, name, parent_id, sort_order FROM folders ORDER BY sort_order ASC, name ASC',
      )
      return { ok: true, folders }
    }

    case 'list_tags': {
      const search = String(input.search || '').trim()
      const tags = search
        ? queryAll<{ id: string; name: string; usage_count: number }>(
          'SELECT id, name, usage_count FROM tags WHERE name LIKE ? ORDER BY usage_count DESC, name ASC LIMIT 200',
          [`%${search}%`],
        )
        : queryAll<{ id: string; name: string; usage_count: number }>(
          'SELECT id, name, usage_count FROM tags ORDER BY usage_count DESC, name ASC LIMIT 500',
        )
      return { ok: true, tags }
    }

    case 'library_stats': {
      const documents = Number(queryOne<{ c: number }>('SELECT COUNT(*) as c FROM documents')?.c || 0)
      const pages = Number(queryOne<{ c: number }>('SELECT COUNT(*) as c FROM pages')?.c || 0)
      const folders = Number(queryOne<{ c: number }>('SELECT COUNT(*) as c FROM folders')?.c || 0)
      const tags = Number(queryOne<{ c: number }>('SELECT COUNT(*) as c FROM tags')?.c || 0)
      const ocrCompleted = Number(
        queryOne<{ c: number }>("SELECT COUNT(*) as c FROM documents WHERE ocr_status = 'completed'")?.c || 0,
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

    default:
      return toolError('unknown_tool', `Unknown tool: ${name}`)
  }
}
