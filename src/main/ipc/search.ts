import { dialog, ipcMain } from 'electron'
import { createWriteStream, writeFileSync } from 'fs'
import { rename, unlink, writeFile } from 'fs/promises'
import { once } from 'events'
import { nanoid } from 'nanoid'
import { queryAll, queryOne, run, saveDatabase } from '../database'
import { createHash } from 'crypto'
import { resolveCanonicalPageContent } from '../canonical-content'
import { validateSearchSnapshot } from '../search-snapshots'
import { resolveSearchEvidence } from '../search-evidence-resolver'
import {
  listResearchAggregateRelations,
  promoteSearchSnapshotAggregate,
  validateResearchAggregateArtifact,
} from '../research-aggregates'
import {
  aiPlannedSearch,
  deleteSavedSearch,
  fullTextSearch,
  getDocumentSearchHitPage,
  getDocumentSearchHits,
  getSearchIndexStatus,
  listSavedSearches,
  queueAllDocumentsReindex,
  queueDocumentReindex,
  querySearchV2,
  runLibraryAiSearch,
  runSavedSearch,
  saveSearch,
  semanticSearch
} from '../semantic-search'
import { vectorSearch } from '../embedding-index'
import {
  DEFAULT_SEARCH_EXPORT_COUNT,
  normalizeSearchExportCount,
  searchExportCountToLimit,
  type SearchExportCount,
} from '../../shared/search-export'
import type {
  AiPlannedSearchResponse,
  CursorPage,
  ExportPageNumberMode,
  SaveSearchExcerptsOptions,
  SaveSearchExcerptsResult,
  SavedSearch,
  SavedSearchPayload,
  SavedSearchRunResult,
  LibraryAiSearchResponse,
  SearchDocumentGroup,
  SearchDocumentHitPage,
  SearchExportOptions,
  SearchExportPreviewItem,
  SearchExportPreviewResult,
  SearchExportResult,
  SearchExportTaskStartResult,
  SearchGroupedResponse,
  SearchHit,
  SearchIndexStatus,
  SearchOptions,
  SearchReindexAllResult,
  SearchReindexDocumentResult,
  SearchResult,
  SearchSessionState,
  SearchSnapshotValidationResult,
  ResolvedSearchEvidence,
  ResearchAggregateArtifact,
  ResearchAggregateRelation,
  StableReaderLocator,
} from '../../shared/types'
import { buildSearchExcerptSourceHashInput } from '../../shared/search-evidence'
import { getLiteraturePageNumForPhysical } from '../literature-page-map'
import { buildCitation, buildCitationByStyle, mapDocTypeToCitationFormat } from './citation'
import {
  assertDocumentIdsInLibraryProject,
  assertDocumentInLibraryProject,
  captureActiveLibraryProjectId,
  getActiveLibraryProjectId,
  withLibraryProjectContext,
} from '../library-projects'
import { emitBackgroundTaskStatus } from '../background-tasks'

function resolveExportPageNumberMode(options?: { pageNumberMode?: ExportPageNumberMode } | null): ExportPageNumberMode {
  return options?.pageNumberMode === 'natural' ? 'natural' : 'literature'
}

/** Resolve the page number shown in search exports / citations for a hit. */
function resolveExportHitPageNum(
  hit: SearchHit,
  group: SearchDocumentGroup,
  mode: ExportPageNumberMode,
  literaturePageCache?: ReadonlyMap<string, number | null>,
): number | null {
  const physical = Number(hit.locator.pageNum || 0)
  if (!Number.isFinite(physical) || physical <= 0) return null
  if (mode === 'natural') return Math.floor(physical)
  const cacheKey = `${group.docId}\u0000${Math.floor(physical)}`
  if (literaturePageCache?.has(cacheKey)) {
    return literaturePageCache.get(cacheKey) || Math.floor(physical)
  }
  const literature = getLiteraturePageNumForPhysical(group.docId, physical)
  if (literature != null && literature > 0) return literature
  return Math.floor(physical)
}

function buildLiteraturePageCache(
  items: Array<{ group: SearchDocumentGroup; hit: SearchHit }>,
): Map<string, number | null> {
  const physicalPagesByDocument = new Map<string, Set<number>>()
  for (const { group, hit } of items) {
    const physical = Math.floor(Number(hit.locator.pageNum || 0))
    if (!group.docId || physical <= 0) continue
    const pages = physicalPagesByDocument.get(group.docId) || new Set<number>()
    pages.add(physical)
    physicalPagesByDocument.set(group.docId, pages)
  }

  const cache = new Map<string, number | null>()
  for (const [docId, pageSet] of physicalPagesByDocument) {
    const pages = [...pageSet]
    pages.forEach((pageNum) => cache.set(`${docId}\u0000${pageNum}`, null))
    for (let index = 0; index < pages.length; index += 400) {
      const batch = pages.slice(index, index + 400)
      const rows = queryAll<{ page_num: number | null; literature_page_num: number | null }>(
        `SELECT page_num, literature_page_num
         FROM pages
         WHERE doc_id = ? AND page_num IN (${batch.map(() => '?').join(', ')})`,
        [docId, ...batch],
      )
      rows.forEach((row) => {
        const physical = Math.floor(Number(row.page_num || 0))
        const literature = Math.floor(Number(row.literature_page_num || 0))
        if (physical > 0) {
          cache.set(`${docId}\u0000${physical}`, literature > 0 ? literature : null)
        }
      })
    }
  }
  return cache
}

interface SearchIndexSegmentRow {
  segment_id: string
  doc_id: string
  page_id?: string | null
  page_num?: number | null
  source_kind?: string | null
  href?: string | null
  title?: string | null
  ordinal?: number | null
  source_start?: number | null
  text?: string | null
  normalized_text?: string | null
}

interface HitSourceResolution {
  text: string
  sourceKey: string
  sourceType: 'page' | 'segment' | 'normalized-segment'
  sourceStart: number
  pageTextLength: number
  segmentTextLength: number
  normalizedTextLength: number
  pageHasText: boolean
  segmentHasText: boolean
  normalizedHasText: boolean
}

interface HitParagraphResolution {
  key: string
  text: string
  source: HitSourceResolution
  paragraphStart: number
  paragraphEnd: number
  hitIndex: number
  hitIndexStrategy: 'match-occurrence' | 'match-first' | 'query-occurrence' | 'query-first' | 'char-start' | 'not-found'
}

interface ExportParagraph {
  key: string
  text: string
  firstHit: SearchHit
  hitCount: number
  hitKeys: Set<string>
  terms: Set<string>
  sourceType: HitSourceResolution['sourceType']
  sourceKey: string
}

interface ExportParagraphBuildResult {
  paragraphs: ExportParagraph[]
  missingHits: number
}

interface CitationTemplateRow {
  id: string
}

interface SearchExportRecord {
  title: string
  author: string | null
  docType: string
  pageNum: number | null
  chapter: string | null
  paragraph: string
  hitTerms: string[]
  hitCount: number
  citation: string
  locator: SearchHit['locator']
  stableLocator?: SearchHit['stableLocator']
  searchKeyword: string
  exportedAt: string
  sourceType: HitSourceResolution['sourceType']
  sourceKey: string
  /** Cosine similarity for vector hits. */
  score?: number | null
  segmentId?: string | null
}

const SEARCH_EXCERPT_EXPORTER_VERSION = 'full-paragraph-v2'
const VECTOR_EXCERPT_EXPORTER_VERSION = 'vector-evidence-v1'

interface SearchExportTaskControl {
  canceled: boolean
  outputFilePath: string
  tempFilePath: string
  projectId: string
}

const activeSearchExportTasks = new Map<string, SearchExportTaskControl>()

function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function writeExportChunk(stream: ReturnType<typeof createWriteStream>, chunk: string): Promise<void> {
  if (stream.write(chunk, 'utf8')) return
  await once(stream, 'drain')
}

function buildSearchExportTaskConfig(options: SearchOptions | undefined): SearchExportOptions {
  const requestedCitationMode = options?.citationMode
  const isVector = options?.searchEngine === 'vector'
  return {
    format: ['txt', 'markdown', 'csv', 'json'].includes(String(options?.format))
      ? String(options?.format) as SearchExportOptions['format']
      : 'txt',
    citationMode: ['auto', 'simple', 'template'].includes(String(requestedCitationMode))
      ? requestedCitationMode
      : 'auto',
    citationStyleId: typeof options?.citationStyleId === 'string' && options.citationStyleId.trim()
      ? options.citationStyleId.trim()
      : undefined,
    citationTemplateId: typeof options?.citationTemplateId === 'string' && options.citationTemplateId.trim()
      ? options.citationTemplateId.trim()
      : undefined,
    searchEngine: isVector ? 'vector' : 'fulltext',
    pageNumberMode: resolveExportPageNumberMode(options),
    minVectorScore: normalizeMinVectorScore(options?.minVectorScore),
    maxExportRecords: normalizeMaxExportRecords(options?.maxExportRecords, isVector),
  }
}

function formatSimilarityScore(score: unknown): string {
  const value = Number(score)
  if (!Number.isFinite(value)) return ''
  // Keep 3–4 decimals so “0.520” style stays readable for humans and models.
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

function isVectorExportResponse(response: SearchGroupedResponse): boolean {
  return (response.warnings || []).some((item) => /向量库语义检索|vector/i.test(String(item || '')))
}

function stripSnippetMarkers(value: string): string {
  return String(value || '').replace(/<</g, '').replace(/>>/g, '').replace(/\s+/g, ' ').trim()
}

function isEllipsisSnippetText(value: string): boolean {
  const text = String(value || '').trim()
  return /^\s*(\.\.\.|…)/.test(text) || /(\.\.\.|…)\s*$/.test(text)
}

function cleanExcerptText(value: string): string {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|table|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeParagraphText(value: string): string {
  return String(value || '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isLikelyMetadataLine(line: string): boolean {
  const text = line.trim()
  return /^(摘要|关键词|关键字|中图分类号|文献标识码|文章编号|作者简介|基金项目|收稿日期|参考文献|注释|目录|第\s*\d+\s*[页卷章节])[:：\s\[]/.test(text)
    || /^\[(摘要|关键词|关键字|中图分类号|文献标识码|文章编号)\]/.test(text)
}

function isLikelyHeadingLine(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (/^#{1,6}\s+/.test(text)) return true
  if (/^([一二三四五六七八九十]+|[0-9]+)[、．.]\s*\S{1,40}$/.test(text)) return true
  if (/^（[一二三四五六七八九十0-9]+）\s*\S{1,40}$/.test(text)) return true
  return text.length <= 24 && /[章节篇目]$/.test(text)
}

function isParagraphStartAfterSentence(text: string): boolean {
  return /^(一|二|三|四|五|六|七|八|九|十|关于|因此|但是|然而|同时|另外|其次|再次|最后|总之|综上|可见|实际|于是|此后|随后|19\d{2}年|20\d{2}年|[一二三四五六七八九十]+[、．.]|[0-9]+[、．.]|（[一二三四五六七八九十0-9]+）)/.test(text.trim())
}

function splitParagraphCandidates(text: string): Array<{ text: string; start: number; end: number }> {
  const source = String(text || '').replace(/\r\n/g, '\n')
  if (!source.trim()) return []
  const candidates: Array<{ text: string; start: number; end: number }> = []

  const pushCandidate = (start: number, end: number) => {
    const raw = source.slice(start, end)
    const normalized = normalizeParagraphText(raw)
    if (normalized) candidates.push({ text: normalized, start, end })
  }

  let blockStart = 0
  const blankLine = /\n\s*\n/g
  let match: RegExpExecArray | null
  while ((match = blankLine.exec(source))) {
    pushCandidate(blockStart, match.index)
    blockStart = match.index + match[0].length
  }
  pushCandidate(blockStart, source.length)

  if (candidates.length > 1) return candidates

  const lines: Array<{ text: string; start: number; end: number }> = []
  const linePattern = /[^\n]*(?:\n|$)/g
  while ((match = linePattern.exec(source))) {
    if (!match[0]) break
    const start = match.index
    const end = start + match[0].length
    const line = match[0].replace(/\n$/, '')
    if (line.trim()) lines.push({ text: line, start, end })
  }
  if (lines.length <= 1) return candidates

  const merged: Array<{ start: number; end: number }> = []
  let currentStart = lines[0].start
  let previousLine = lines[0].text.trim()
  for (let index = 1; index < lines.length; index += 1) {
    const currentLine = lines[index].text.trim()
    const previousEndsSentence = /[。！？；]$/.test(previousLine)
    const shouldSplit = isLikelyMetadataLine(currentLine)
      || isLikelyHeadingLine(currentLine)
      || (previousEndsSentence && isParagraphStartAfterSentence(currentLine))
    if (shouldSplit) {
      merged.push({ start: currentStart, end: lines[index - 1].end })
      currentStart = lines[index].start
    }
    previousLine = currentLine
  }
  merged.push({ start: currentStart, end: lines[lines.length - 1].end })

  const lineCandidates = merged
    .map((item) => ({ ...item, text: normalizeParagraphText(source.slice(item.start, item.end)) }))
    .filter((item) => item.text && !isLikelyMetadataLine(item.text))
  return lineCandidates.length > 0 ? lineCandidates : candidates
}

function sanitizeFileName(value: string): string {
  return String(value || '检索摘录')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '检索摘录'
}
function loadHitSegment(hit: SearchHit): SearchIndexSegmentRow | null {
  const locator = hit.locator
  const selectSql = `SELECT segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start, text, normalized_text
    FROM search_index_segments`
  const attempts: Array<{ where: string; params: unknown[] }> = []

  if (locator.segmentId) attempts.push({ where: 'segment_id = ?', params: [locator.segmentId] })
  attempts.push({
    where: 'doc_id = ? AND COALESCE(page_num, -1) = ? AND COALESCE(ordinal, -1) = ?',
    params: [locator.docId, locator.pageNum ?? -1, locator.segmentOrdinal ?? -1],
  })
  attempts.push({
    where: 'doc_id = ? AND COALESCE(ordinal, -1) = ?',
    params: [locator.docId, locator.segmentOrdinal ?? -1],
  })
  if (locator.href) {
    attempts.push({
      where: 'doc_id = ? AND href = ?',
      params: [locator.docId, locator.href],
    })
  }
  attempts.push({
    where: 'doc_id = ? AND COALESCE(page_num, -1) = ?',
    params: [locator.docId, locator.pageNum ?? -1],
  })

  for (const attempt of attempts) {
    const row = queryOne<SearchIndexSegmentRow>(
      `${selectSql} WHERE ${attempt.where} ORDER BY ordinal ASC LIMIT 1`,
      attempt.params,
    )
    if (row) return row
  }

  return null
}

function loadHitPageText(hit: SearchHit): string {
  const pageNum = hit.locator.pageNum
  if (!pageNum) return ''
  const row = queryOne<{ id: string }>(
    `SELECT id
     FROM pages
     WHERE doc_id = ? AND page_num = ?
     ORDER BY page_num ASC
     LIMIT 1`,
    [hit.locator.docId, pageNum],
  )
  return row?.id ? resolveCanonicalPageContent(row.id).text : ''
}

function findNthOccurrence(text: string, term: string, occurrenceIndex: number): number {
  const needle = String(term || '').trim()
  if (!text || !needle) return -1
  const haystack = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  let found = -1
  let cursor = 0
  for (let index = 0; index <= Math.max(0, occurrenceIndex); index += 1) {
    found = haystack.indexOf(lowerNeedle, cursor)
    if (found < 0) return -1
    cursor = found + Math.max(1, lowerNeedle.length)
  }
  return found
}

function stableHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function expandToParagraphWithRange(text: string, hitIndex: number): { text: string; start: number; end: number } {
  if (!text) return { text: '', start: 0, end: 0 }
  const candidates = splitParagraphCandidates(text)
  if (hitIndex >= 0 && hitIndex < text.length) {
    const matched = candidates.find((candidate) => hitIndex >= candidate.start && hitIndex <= candidate.end)
    if (matched) return matched
  }
  if (candidates.length > 0) {
    return candidates[Math.max(0, Math.min(candidates.length - 1, candidates.findIndex((candidate) => !isLikelyMetadataLine(candidate.text))))]
  }
  return { text: normalizeParagraphText(text), start: 0, end: text.length }
}

function getHitSourceText(hit: SearchHit, allowQueueReindex = true): HitSourceResolution | null {
  const segment = loadHitSegment(hit)
  const pageText = cleanExcerptText(loadHitPageText(hit))
  const rawSegmentText = segment?.text ? cleanExcerptText(segment.text) : ''
  const normalizedSegmentText = segment?.normalized_text ? cleanExcerptText(segment.normalized_text) : ''
  const sourceStart = Math.max(0, Number(segment?.source_start || 0))
  const base = {
    sourceStart,
    pageTextLength: pageText.length,
    segmentTextLength: rawSegmentText.length,
    normalizedTextLength: normalizedSegmentText.length,
    pageHasText: pageText.length > 0,
    segmentHasText: rawSegmentText.length > 0,
    normalizedHasText: normalizedSegmentText.length > 0,
  }

  if (pageText) {
    return {
      ...base,
      text: pageText,
      sourceKey: `${hit.locator.docId}:page:${hit.locator.pageNum || 'unknown'}`,
      sourceType: 'page',
      sourceStart: 0,
    }
  }

  if (rawSegmentText) {
    return {
      ...base,
      text: rawSegmentText,
      sourceKey: segment?.segment_id || hit.locator.segmentId || `${hit.locator.docId}:segment:${hit.locator.segmentOrdinal}`,
      sourceType: 'segment',
    }
  }

  if (normalizedSegmentText) {
    return {
      ...base,
      text: normalizedSegmentText,
      sourceKey: segment?.segment_id || hit.locator.segmentId || `${hit.locator.docId}:normalized:${hit.locator.segmentOrdinal}`,
      sourceType: 'normalized-segment',
    }
  }

  if (allowQueueReindex) {
    queueDocumentReindex(hit.locator.docId)
  }

  return null
}

function getHitParagraphFromSnippet(hit: SearchHit): HitParagraphResolution | null {
  const snippet = stripSnippetMarkers(String(hit.snippet || '')).replace(/\s+/g, ' ').trim()
  if (!snippet || isEllipsisSnippetText(snippet)) return null
  const sourceKey = `snippet:${hit.locator.docId}:${hit.locator.pageNum || 'p'}:${hit.locator.segmentId || hit.id || 'hit'}`
  return {
    key: `${sourceKey}:${stableHash(snippet)}`,
    text: snippet,
    source: {
      text: snippet,
      sourceKey,
      sourceType: 'segment',
      sourceStart: 0,
      pageTextLength: 0,
      segmentTextLength: snippet.length,
      normalizedTextLength: snippet.length,
      pageHasText: false,
      segmentHasText: true,
      normalizedHasText: true,
    },
    paragraphStart: 0,
    paragraphEnd: snippet.length,
    hitIndex: 0,
    hitIndexStrategy: 'query-first',
  }
}

function resolveParagraphFromSource(hit: SearchHit, source: HitSourceResolution): HitParagraphResolution | null {
  if (!source.text) return null
  if (source.sourceType !== 'page' && isEllipsisSnippetText(source.text)) {
    return getHitParagraphFromSnippet(hit)
  }
  const occurrenceIndex = Math.max(0, Number(hit.locator.occurrenceIndex || 0))
  const byMatch = findNthOccurrence(source.text, hit.locator.matchText || hit.locator.queryTerm, occurrenceIndex)
  const byMatchFirst = byMatch >= 0 ? byMatch : findNthOccurrence(source.text, hit.locator.matchText || hit.locator.queryTerm, 0)
  const byQuery = byMatchFirst >= 0 ? byMatchFirst : findNthOccurrence(source.text, hit.locator.queryTerm, occurrenceIndex)
  const byQueryFirst = byQuery >= 0 ? byQuery : findNthOccurrence(source.text, hit.locator.queryTerm, 0)
  const absoluteCharStart = Number(hit.locator.charStart)
  const charStart = source.sourceType === 'page'
    ? absoluteCharStart
    : absoluteCharStart - Math.max(0, source.sourceStart || 0)
  const byCharStart = byQueryFirst >= 0 ? byQueryFirst : charStart
  const hitIndex = Number.isFinite(byCharStart) ? byCharStart : -1
  const hitIndexStrategy: HitParagraphResolution['hitIndexStrategy'] =
    byMatch >= 0 ? 'match-occurrence'
      : byMatchFirst >= 0 ? 'match-first'
        : byQuery >= 0 ? 'query-occurrence'
          : byQueryFirst >= 0 ? 'query-first'
            : Number.isFinite(charStart) ? 'char-start'
              : 'not-found'
  const paragraph = expandToParagraphWithRange(source.text, hitIndex)
  const text = paragraph.text || source.text
  if (source.sourceType !== 'page' && isEllipsisSnippetText(text)) return null
  return {
    key: `${source.sourceKey}:${paragraph.start}:${paragraph.end}:${stableHash(text)}`,
    text,
    source,
    paragraphStart: paragraph.start,
    paragraphEnd: paragraph.end,
    hitIndex,
    hitIndexStrategy,
  }
}

function getHitParagraph(hit: SearchHit): HitParagraphResolution | null {
  const source = getHitSourceText(hit)
  if (!source?.text) {
    // Vector hits often carry a usable excerpt even when locator expand fails.
    return getHitParagraphFromSnippet(hit)
  }
  return resolveParagraphFromSource(hit, source)
}

/**
 * Vector export path: prefer segment/snippet over full-page OCR so export does not
 * block the main process loading large page payloads for every hit.
 */
function getHitParagraphForVectorExport(hit: SearchHit): HitParagraphResolution | null {
  const segment = loadHitSegment(hit)
  const rawSegmentText = segment?.text ? cleanExcerptText(segment.text) : ''
  const normalizedSegmentText = segment?.normalized_text ? cleanExcerptText(segment.normalized_text) : ''
  const sourceStart = Math.max(0, Number(segment?.source_start || 0))
  const baseMeta = {
    sourceStart,
    pageTextLength: 0,
    segmentTextLength: rawSegmentText.length,
    normalizedTextLength: normalizedSegmentText.length,
    pageHasText: false,
    segmentHasText: rawSegmentText.length > 0,
    normalizedHasText: normalizedSegmentText.length > 0,
  }

  if (rawSegmentText && !isEllipsisSnippetText(rawSegmentText)) {
    const source: HitSourceResolution = {
      ...baseMeta,
      text: rawSegmentText,
      sourceKey: segment?.segment_id || hit.locator.segmentId || `${hit.locator.docId}:segment:${hit.locator.segmentOrdinal}`,
      sourceType: 'segment',
    }
    const resolved = resolveParagraphFromSource(hit, source)
    if (resolved?.text) return resolved
  }

  if (normalizedSegmentText && !isEllipsisSnippetText(normalizedSegmentText)) {
    const source: HitSourceResolution = {
      ...baseMeta,
      text: normalizedSegmentText,
      sourceKey: segment?.segment_id || hit.locator.segmentId || `${hit.locator.docId}:normalized:${hit.locator.segmentOrdinal}`,
      sourceType: 'normalized-segment',
    }
    const resolved = resolveParagraphFromSource(hit, source)
    if (resolved?.text) return resolved
  }

  const fromSnippet = getHitParagraphFromSnippet(hit)
  if (fromSnippet?.text) return fromSnippet

  // Last resort: full page OCR (may be slow on large pages).
  return getHitParagraph(hit)
}

function getExportParagraphHitKey(hit: SearchHit, paragraph: HitParagraphResolution): string {
  const term = String(hit.locator.queryTerm || hit.locator.matchText || '').trim().toLowerCase()
  const matchText = String(hit.locator.matchText || hit.locator.queryTerm || '').trim().toLowerCase()
  const hitIndex = Number.isFinite(paragraph.hitIndex)
    ? paragraph.hitIndex
    : Number(hit.locator.charStart)
  const hitEnd = Number.isFinite(hitIndex)
    ? hitIndex + Math.max(1, matchText.length || term.length)
    : Number(hit.locator.charEnd)
  return [
    paragraph.source.sourceKey,
    paragraph.paragraphStart,
    paragraph.paragraphEnd,
    Number.isFinite(hitIndex) ? Math.floor(hitIndex) : 'unknown',
    Number.isFinite(hitEnd) ? Math.floor(hitEnd) : 'unknown',
    term || matchText,
  ].join(':')
}

function countTermOccurrences(text: string, terms: Iterable<string>): number {
  const haystack = String(text || '').toLowerCase()
  if (!haystack) return 0
  let total = 0
  for (const rawTerm of terms) {
    const term = String(rawTerm || '').trim().toLowerCase()
    if (!term) continue
    let cursor = 0
    while (cursor < haystack.length) {
      const index = haystack.indexOf(term, cursor)
      if (index < 0) break
      total += 1
      cursor = index + Math.max(1, term.length)
    }
  }
  return total
}

function normalizeExportParagraphHitCount(paragraph: ExportParagraph): ExportParagraph {
  const actualTermCount = countTermOccurrences(paragraph.text, paragraph.terms)
  if (actualTermCount <= 0) return paragraph
  return {
    ...paragraph,
    hitCount: Math.min(paragraph.hitCount, actualTermCount),
  }
}

function buildExportParagraphs(group: SearchDocumentGroup): ExportParagraphBuildResult {
  const paragraphs = new Map<string, ExportParagraph>()
  let missingHits = 0
  for (const hit of group.hits) {
    const paragraph = getHitParagraph(hit)
    if (!paragraph?.text) {
      missingHits += 1
      continue
    }
    const hitKey = getExportParagraphHitKey(hit, paragraph)
    const existing = paragraphs.get(paragraph.key)
    if (existing) {
      if (!existing.hitKeys.has(hitKey)) {
        existing.hitKeys.add(hitKey)
        existing.hitCount += 1
      }
      if (hit.locator.queryTerm) existing.terms.add(hit.locator.queryTerm)
      continue
    }
    paragraphs.set(paragraph.key, {
      key: paragraph.key,
      text: paragraph.text,
      firstHit: hit,
      hitCount: 1,
      hitKeys: new Set([hitKey]),
      terms: new Set(hit.locator.queryTerm ? [hit.locator.queryTerm] : []),
      sourceType: paragraph.source.sourceType,
      sourceKey: paragraph.source.sourceKey,
    })
  }
  const normalizedParagraphs = [...paragraphs.values()].map(normalizeExportParagraphHitCount)
  return {
    paragraphs: normalizedParagraphs.sort((left, right) => (
      (left.firstHit.locator.pageNum || 0) - (right.firstHit.locator.pageNum || 0)
      || left.firstHit.locator.segmentOrdinal - right.firstHit.locator.segmentOrdinal
      || left.firstHit.locator.charStart - right.firstHit.locator.charStart
    )),
    missingHits,
  }
}

function getLocationSuffix(hit: SearchHit, displayPageNum?: number | null): string {
  const pageNum = displayPageNum != null && displayPageNum > 0
    ? displayPageNum
    : (hit.locator.pageNum || null)
  const parts = [
    pageNum ? `第 ${pageNum} 页` : '',
    hit.locator.href ? `章节：${hit.locator.href}` : '',
  ].filter(Boolean)
  return parts.join('，')
}

function normalizeGeneratedCitation(value: string): string {
  return String(value || '')
    .replace(/\(\s*\)/g, '')
    .replace(/（\s*）/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/，\s*，/g, '，')
    .replace(/\.\s*,/g, '.')
    .replace(/,\s*\./g, '.')
    .replace(/，\s*。/g, '。')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,，。；;：:]+|[\s,，；;：:]+$/g, '')
    .trim()
}

function hasEnoughCitationContent(citation: string, group: SearchDocumentGroup): boolean {
  const text = normalizeGeneratedCitation(citation)
  const title = String(group.title || '').trim()
  const author = String(group.author || '').trim()
  if (!text) return false
  if (title && !text.includes(title)) return false
  if (!author && /^[().,，、；;\s]+/.test(citation)) return false
  const meaningful = text.replace(/[^\p{L}\p{N}\u4e00-\u9fff]/gu, '')
  return meaningful.length >= Math.min(8, Math.max(2, title.length))
}
function resolveCitationTemplateId(group: SearchDocumentGroup, options: SearchExportOptions): string | undefined {
  if (options.citationMode === 'simple') return undefined
  if (options.citationMode === 'template' && options.citationTemplateId) return options.citationTemplateId
  if (options.citationTemplateId && !options.citationMode) return options.citationTemplateId

  const targetFormat = mapDocTypeToCitationFormat(group.docType)
  const styleId = options.citationStyleId?.trim()
  if (targetFormat) {
    const byType = queryOne<CitationTemplateRow>(
      `SELECT id, name, format_type, is_default
       FROM citation_templates
       WHERE format_type = ?
         AND (? IS NULL OR style_id = ?)
       ORDER BY is_default DESC, name ASC
       LIMIT 1`,
      [targetFormat, styleId || null, styleId || null],
    )
    if (byType?.id) return byType.id
  }

  const defaultTemplate = queryOne<CitationTemplateRow>(
    `SELECT id, name, format_type, is_default
     FROM citation_templates
     WHERE (? IS NULL OR style_id = ?)
     ORDER BY is_default DESC, name ASC
     LIMIT 1`,
    [styleId || null, styleId || null],
  )
  return defaultTemplate?.id
}

function formatHitCitation(
  group: SearchDocumentGroup,
  hit: SearchHit,
  options: SearchExportOptions,
  displayPageNum?: number | null,
): string {
  const templateId = resolveCitationTemplateId(group, options)
  const pageNum = displayPageNum != null && displayPageNum > 0
    ? displayPageNum
    : (hit.locator.pageNum || null)
  const generatedCitation = options.citationMode !== 'simple' && options.citationStyleId
    ? buildCitationByStyle(group.docId, options.citationStyleId, group.docType, { pageNum })
    : templateId ? buildCitation(group.docId, templateId, { pageNum }) : null
  const templateCitation = generatedCitation && hasEnoughCitationContent(generatedCitation, group)
    ? normalizeGeneratedCitation(generatedCitation)
    : null
  if (templateCitation) return templateCitation
  const baseCitation = templateCitation || [
    group.author ? `${group.author}` : '',
    group.title || '未命名文献',
  ].filter(Boolean).join('，')
  const location = getLocationSuffix(hit, pageNum)
  return [baseCitation, location].filter(Boolean).join('，')
}

function buildExportRecords(
  response: SearchGroupedResponse,
  keyword: string,
  options: SearchExportOptions = {},
  maxRecords = Number.POSITIVE_INFINITY,
  recordBuildLimit = Number.POSITIVE_INFINITY,
): { records: SearchExportRecord[]; missingHitCount: number } {
  const records: SearchExportRecord[] = []
  let missingHitCount = 0
  const exportedAt = new Date().toISOString()
  const pageNumberMode = resolveExportPageNumberMode(options)
  response.groups.forEach((group) => {
    if (records.length >= maxRecords || records.length >= recordBuildLimit) return
    const { paragraphs, missingHits } = buildExportParagraphs(group)
    missingHitCount += missingHits
    paragraphs.forEach((paragraph) => {
      if (records.length >= maxRecords || records.length >= recordBuildLimit) return
      const hit = paragraph.firstHit
      const score = Number(hit.score)
      const pageNum = resolveExportHitPageNum(hit, group, pageNumberMode)
      records.push({
        title: group.title || 'Untitled',
        author: group.author || null,
        docType: group.docType || '',
        pageNum,
        chapter: hit.locator.href || null,
        paragraph: paragraph.text,
        hitTerms: [...paragraph.terms],
        hitCount: paragraph.hitCount,
        citation: formatHitCitation(group, hit, options, pageNum),
        locator: hit.locator,
        stableLocator: hit.stableLocator,
        searchKeyword: keyword,
        exportedAt,
        sourceType: paragraph.sourceType,
        sourceKey: paragraph.sourceKey,
        score: Number.isFinite(score) ? score : null,
        segmentId: hit.locator.segmentId || null,
      })
    })
  })
  // Vector exports: keep similarity ranking (high → low).
  if (isVectorExportResponse(response) || options.searchEngine === 'vector') {
    records.sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))
  }
  return { records, missingHitCount }
}

/**
 * Export one evidence item per vector hit (do not collapse by paragraph), for AI re-use.
 */
/** Clamp vector export score floor to [0, 1]. Values ≤ 0 mean “no filter”. */
function normalizeMinVectorScore(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(1, Math.max(0, Math.round(raw * 1000) / 1000))
}

/** Normalize the user-selected export size; `all` intentionally has no record cap. */
function normalizeMaxExportRecords(value: unknown, _vectorMode: boolean): SearchExportCount {
  return normalizeSearchExportCount(value, DEFAULT_SEARCH_EXPORT_COUNT)
}

/**
 * Vector export body: prefer the already-returned snippet first.
 * Avoids synchronous page/segment DB work that freezes the main process on bulk export/preview.
 */
function getHitParagraphForVectorExportFast(hit: SearchHit): HitParagraphResolution | null {
  const fromSnippet = getHitParagraphFromSnippet(hit)
  if (fromSnippet?.text) return fromSnippet
  return getHitParagraphForVectorExport(hit)
}

function buildVectorExportRecords(
  response: SearchGroupedResponse,
  keyword: string,
  options: SearchExportOptions = {},
  maxRecords = Number.POSITIVE_INFINITY,
  recordBuildLimit = maxRecords,
): {
  records: SearchExportRecord[]
  missingHitCount: number
  filteredByMinScore: number
  selectedHitCount: number
} {
  const records: SearchExportRecord[] = []
  let missingHitCount = 0
  let filteredByMinScore = 0
  const minScore = normalizeMinVectorScore(options.minVectorScore)
  const cap = Number.isFinite(maxRecords) && maxRecords > 0
    ? maxRecords
    : searchExportCountToLimit(normalizeMaxExportRecords(options.maxExportRecords, true))
  const exportedAt = new Date().toISOString()
  const pageNumberMode = resolveExportPageNumberMode(options)
  // Bulk vector export uses lightweight citations (no per-hit template DB) to avoid freezes.
  const flatHits: Array<{ group: SearchDocumentGroup; hit: SearchHit }> = []
  response.groups.forEach((group) => {
    group.hits.forEach((hit) => flatHits.push({ group, hit }))
  })
  flatHits.sort((a, b) => (Number(b.hit.score) || 0) - (Number(a.hit.score) || 0))

  const matchingHits = flatHits.filter(({ hit }) => {
    const score = Number(hit.score)
    if (minScore > 0 && !(Number.isFinite(score) && score >= minScore)) {
      filteredByMinScore += 1
      return false
    }
    return true
  })
  const selectedHits = matchingHits.slice(0, cap)
  const buildLimit = Number.isFinite(recordBuildLimit)
    ? Math.max(0, Math.floor(recordBuildLimit))
    : selectedHits.length
  const hitsToBuild = selectedHits.slice(0, buildLimit)
  const literaturePageCache = pageNumberMode === 'literature'
    ? buildLiteraturePageCache(hitsToBuild)
    : undefined

  for (const { group, hit } of hitsToBuild) {
    const score = Number(hit.score)
    const paragraph = getHitParagraphForVectorExportFast(hit)
    if (!paragraph?.text) {
      missingHitCount += 1
      continue
    }
    const pageNum = resolveExportHitPageNum(hit, group, pageNumberMode, literaturePageCache)
    const citation = [
      group.author ? String(group.author) : '',
      group.title || '未命名文献',
      pageNum ? `第 ${pageNum} 页` : '',
    ].filter(Boolean).join('，')
    records.push({
      title: group.title || 'Untitled',
      author: group.author || null,
      docType: group.docType || '',
      pageNum,
      chapter: hit.locator.href || null,
      paragraph: paragraph.text,
      hitTerms: hit.locator.queryTerm ? [hit.locator.queryTerm] : [],
      hitCount: 1,
      citation,
      locator: hit.locator,
      stableLocator: hit.stableLocator,
      searchKeyword: keyword,
      exportedAt,
      sourceType: paragraph.source.sourceType,
      sourceKey: paragraph.source.sourceKey,
      score: Number.isFinite(score) ? score : null,
      segmentId: hit.locator.segmentId || null,
    })
  }
  return {
    records,
    missingHitCount,
    filteredByMinScore,
    selectedHitCount: selectedHits.length,
  }
}

const EXPORT_PREVIEW_ITEM_LIMIT = 3

function collectExportRecords(
  response: SearchGroupedResponse,
  keyword: string,
  options: SearchExportOptions = {},
  maxRecords?: number,
  recordBuildLimit?: number,
): {
  records: SearchExportRecord[]
  missingHitCount: number
  filteredByMinScore: number
  vectorMode: boolean
  minVectorScore: number
  maxExportRecords: SearchExportCount
  selectedHitCount: number
} {
  const vectorMode = isVectorExportResponse(response) || options.searchEngine === 'vector'
  const minVectorScore = normalizeMinVectorScore(options.minVectorScore)
  const requestedMax = normalizeMaxExportRecords(
    maxRecords ?? options.maxExportRecords,
    vectorMode,
  )
  const resolvedMax = searchExportCountToLimit(requestedMax)
  if (vectorMode) {
    const built = buildVectorExportRecords(
      response,
      keyword,
      { ...options, minVectorScore, maxExportRecords: resolvedMax },
      resolvedMax,
      recordBuildLimit,
    )
    return { ...built, vectorMode, minVectorScore, maxExportRecords: requestedMax }
  }
  const built = buildExportRecords(response, keyword, options, resolvedMax, recordBuildLimit)
  return {
    ...built,
    filteredByMinScore: 0,
    vectorMode,
    minVectorScore: 0,
    maxExportRecords: requestedMax,
    selectedHitCount: built.records.length,
  }
}

function buildSearchExportPreview(response: SearchGroupedResponse, keyword: string, options: SearchExportOptions = {}): SearchExportPreviewResult {
  // Cap + score filter applied; only first few items are expanded for the UI list.
  const previewOptions: SearchExportOptions = { ...options, previewOnly: true, citationMode: 'simple' }
  const {
    records,
    missingHitCount,
    filteredByMinScore,
    vectorMode,
    minVectorScore,
    maxExportRecords,
    selectedHitCount,
  } = collectExportRecords(
    response,
    keyword,
    previewOptions,
    undefined,
    EXPORT_PREVIEW_ITEM_LIMIT,
  )
  const previewItems: SearchExportPreviewItem[] = records.slice(0, EXPORT_PREVIEW_ITEM_LIMIT).map((record) => ({
    title: record.title,
    author: record.author,
    docType: record.docType,
    pageNum: record.pageNum,
    paragraph: record.paragraph,
    hitTerms: record.hitTerms,
    hitCount: record.hitCount,
    citation: record.citation,
    locatorText: locatorToText(record.locator, record.pageNum),
    sourceType: record.sourceType,
    sourceKey: record.sourceKey,
    score: record.score ?? null,
  }))
  return {
    exporterVersion: vectorMode ? VECTOR_EXCERPT_EXPORTER_VERSION : SEARCH_EXCERPT_EXPORTER_VERSION,
    keyword,
    totalDocuments: response.totalDocuments,
    totalHits: response.totalHits,
    exportableParagraphs: options.previewOnly
      ? Math.max(0, Math.min(
        maxExportRecords === 'all' ? response.totalHits : Number(maxExportRecords || response.totalHits),
        response.totalHits,
      ))
      : vectorMode
        ? Math.max(0, selectedHitCount - missingHitCount)
        : records.length,
    skippedHits: missingHitCount,
    filteredByMinScore,
    minVectorScore: vectorMode ? minVectorScore : 0,
    maxExportRecords,
    previewItems,
  }
}

function locatorToText(locator: SearchHit['locator'], displayPageNum?: number | null): string {
  const pageNum = displayPageNum != null && displayPageNum > 0
    ? displayPageNum
    : locator.pageNum
  return [
    pageNum ? `页码=${pageNum}` : '',
    locator.segmentOrdinal !== undefined ? `段序=${locator.segmentOrdinal}` : '',
    Number.isFinite(locator.charStart) ? `字符=${locator.charStart}-${locator.charEnd}` : '',
    locator.queryTerm ? `检索词=${locator.queryTerm}` : '',
    locator.segmentId ? `分段=${String(locator.segmentId).slice(0, 24)}` : '',
  ].filter(Boolean).join('；')
}

function escapeCsvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function buildSearchExcerptMarkdown(
  records: SearchExportRecord[],
  response: SearchGroupedResponse,
  keyword: string,
  missingHitCount: number,
  options: SearchExportOptions = {},
  filteredByMinScore = 0,
): string {
  const vectorMode = isVectorExportResponse(response) || options.searchEngine === 'vector'
  if (vectorMode) {
    return buildVectorSearchExcerptMarkdown(
      records,
      response,
      keyword,
      missingHitCount,
      options,
      filteredByMinScore,
    )
  }
  const lines = [
    '# Search Excerpts',
    '',
    `- Keyword: ${keyword}`,
    `- Documents: ${response.totalDocuments}`,
    `- Hits: ${response.totalHits}`,
    `- Exported At: ${new Date().toLocaleString('zh-CN')}`,
    ...(missingHitCount > 0 ? [`- Missing Hits: ${missingHitCount}`] : []),
    '',
  ]
  let currentTitle = ''
  records.forEach((record, index) => {
    if (record.title !== currentTitle) {
      currentTitle = record.title
      lines.push(`## ${record.title}`, '')
      if (record.author) lines.push(`- Author: ${record.author}`)
      if (record.docType) lines.push(`- Type: ${record.docType}`)
      if (record.author || record.docType) lines.push('')
    }
    lines.push(`> ${record.paragraph.replace(/\n/g, '\n> ')}`)
    lines.push('')
    lines.push(`- No.: ${index + 1}`)
    lines.push(`- Citation: ${record.citation}`)
    lines.push(`- Hits: ${record.hitCount}${record.hitTerms.length ? ` (${record.hitTerms.join(', ')})` : ''}`)
    lines.push(`- Locator: ${locatorToText(record.locator)}`)
    lines.push('')
  })
  return `\ufeff${lines.join('\n')}`
}

function buildSearchExcerptCsv(records: SearchExportRecord[], vectorMode = false): string {
  const headers = vectorMode
    ? ['rank', 'score', 'title', 'author', 'pageNum', 'paragraph', 'citation', 'segmentId', 'locator', 'searchKeyword', 'exportedAt']
    : ['title', 'author', 'docType', 'pageNum', 'chapter', 'paragraph', 'hitTerms', 'hitCount', 'citation', 'locator', 'searchKeyword', 'exportedAt']
  const rows = records.map((record, index) => (
    vectorMode
      ? [
          index + 1,
          formatSimilarityScore(record.score) || '',
          record.title,
          record.author || '',
          record.pageNum || '',
          record.paragraph,
          record.citation,
          record.segmentId || '',
          JSON.stringify(record.locator),
          record.searchKeyword,
          record.exportedAt,
        ]
      : [
          record.title,
          record.author || '',
          record.docType,
          record.pageNum || '',
          record.chapter || '',
          record.paragraph,
          record.hitTerms.join('|'),
          record.hitCount,
          record.citation,
          JSON.stringify(record.locator),
          record.searchKeyword,
          record.exportedAt,
        ]
  ).map(escapeCsvCell).join(','))
  return `\ufeff${headers.join(',')}\n${rows.join('\n')}`
}

function buildSearchExcerptCsvRow(record: SearchExportRecord, index: number, vectorMode: boolean): string {
  const values = vectorMode
    ? [
        index + 1,
        formatSimilarityScore(record.score) || '',
        record.title,
        record.author || '',
        record.pageNum || '',
        record.paragraph,
        record.citation,
        record.segmentId || '',
        JSON.stringify(record.locator),
        record.searchKeyword,
        record.exportedAt,
      ]
    : [
        record.title,
        record.author || '',
        record.docType,
        record.pageNum || '',
        record.chapter || '',
        record.paragraph,
        record.hitTerms.join('|'),
        record.hitCount,
        record.citation,
        JSON.stringify(record.locator),
        record.searchKeyword,
        record.exportedAt,
      ]
  return values.map(escapeCsvCell).join(',')
}

function buildSearchExportTaskJsonRecord(record: SearchExportRecord, index: number, vectorMode: boolean): Record<string, unknown> {
  if (!vectorMode) return { ...record }
  return {
    rank: index + 1,
    score: record.score ?? null,
    similarity: formatSimilarityScore(record.score) || null,
    title: record.title,
    author: record.author,
    pageNum: record.pageNum,
    text: record.paragraph,
    citation: record.citation,
    ref: {
      docId: record.locator.docId,
      pageNum: record.pageNum,
      segmentId: record.segmentId || record.locator.segmentId || null,
    },
    locator: record.locator,
  }
}

function buildSearchExportTaskHeader(
  response: SearchGroupedResponse,
  keyword: string,
  options: SearchExportOptions,
  vectorMode: boolean,
): string {
  const format = options.format || 'txt'
  if (format === 'csv') {
    const headers = vectorMode
      ? ['rank', 'score', 'title', 'author', 'pageNum', 'paragraph', 'citation', 'segmentId', 'locator', 'searchKeyword', 'exportedAt']
      : ['title', 'author', 'docType', 'pageNum', 'chapter', 'paragraph', 'hitTerms', 'hitCount', 'citation', 'locator', 'searchKeyword', 'exportedAt']
    return `\ufeff${headers.join(',')}\n`
  }
  if (format === 'json') {
    const kind = vectorMode ? 'vector_semantic_evidence' : 'fulltext_search_excerpts'
    const key = vectorMode ? 'evidence' : 'records'
    return `{"kind":${JSON.stringify(kind)},"keyword":${JSON.stringify(keyword)},"searchEngine":${JSON.stringify(vectorMode ? 'vector' : 'fulltext')},"exporterVersion":${JSON.stringify(vectorMode ? VECTOR_EXCERPT_EXPORTER_VERSION : SEARCH_EXCERPT_EXPORTER_VERSION)},"totalDocuments":${response.totalDocuments},"totalHits":${response.totalHits},"exportedAt":${JSON.stringify(new Date().toISOString())},"${key}":[`
  }
  if (format === 'markdown') {
    return vectorMode
      ? `\ufeff# 向量库语义证据导出\n\n- 查询：${keyword}\n- 引擎：向量库语义检索（非关键词全文）\n- 文献数：${response.totalDocuments}\n- 命中数：${response.totalHits}\n\n---\n\n`
      : `\ufeff# Search Excerpts\n\n- Keyword: ${keyword}\n- Documents: ${response.totalDocuments}\n- Hits: ${response.totalHits}\n- Exported At: ${new Date().toLocaleString('zh-CN')}\n\n`
  }
  return vectorMode
    ? `\ufeff向量库语义证据导出（${VECTOR_EXCERPT_EXPORTER_VERSION}）\n查询：${keyword}\n引擎：向量库语义检索（不是关键词全文检索）\n文献数：${response.totalDocuments}\n命中数：${response.totalHits}\n\n==============================\n\n`
    : `\ufeff检索摘录导出（${SEARCH_EXCERPT_EXPORTER_VERSION}）\n关键词：${keyword}\n文献数：${response.totalDocuments}\n命中数：${response.totalHits}\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n==============================\n\n`
}

function buildSearchExportTaskRecordText(record: SearchExportRecord, index: number, vectorMode: boolean, format: SearchExportOptions['format']): string {
  const scoreText = formatSimilarityScore(record.score)
  if (format === 'csv') return `${buildSearchExcerptCsvRow(record, index, vectorMode)}\n`
  if (format === 'json') return JSON.stringify(buildSearchExportTaskJsonRecord(record, index, vectorMode))
  if (format === 'markdown') {
    if (vectorMode) {
      return `## 证据 ${index + 1}${scoreText ? ` · 相似度 ${scoreText}` : ''}\n\n- 文献：${record.title}\n${record.author ? `- 作者：${record.author}\n` : ''}${record.pageNum ? `- 页码：第 ${record.pageNum} 页\n` : ''}${scoreText ? `- 相似度：${scoreText}\n` : ''}- 引用：${record.citation}\n\n### 正文\n\n${record.paragraph}\n\n---\n\n`
    }
    return `## ${record.title}\n\n${record.author ? `- Author: ${record.author}\n` : ''}${record.pageNum ? `- Page: ${record.pageNum}\n` : ''}\n> ${record.paragraph.replace(/\n/g, '\n> ')}\n\n- No.: ${index + 1}\n- Citation: ${record.citation}\n- Hits: ${record.hitCount}${record.hitTerms.length ? ` (${record.hitTerms.join(', ')})` : ''}\n\n`
  }
  if (vectorMode) {
    return `[证据 ${index + 1}]\n${scoreText ? `相似度：${scoreText}\n` : ''}文献：${record.title}\n${record.author ? `作者：${record.author}\n` : ''}${record.pageNum ? `页码：第 ${record.pageNum} 页\n` : ''}引用：${record.citation}\n正文：\n${record.paragraph}\n\n------------------------------\n\n`
  }
  return `[${index + 1}]\n${record.paragraph}\n\n引用：${record.citation}\n段落命中：${record.hitCount}${record.hitTerms.length ? `（${record.hitTerms.join('、')}）` : ''}\n定位：${locatorToText(record.locator, record.pageNum)}\n\n------------------------------\n\n`
}

async function runSearchExportTask(
  taskId: string,
  keyword: string,
  options: SearchOptions,
  control: SearchExportTaskControl,
): Promise<void> {
  const taskOptions = buildSearchExportTaskConfig(options)
  const vectorMode = taskOptions.searchEngine === 'vector'
  try {
    emitBackgroundTaskStatus({
      taskId,
      kind: 'search-export',
      status: 'processing',
      progress: 0,
      totalCount: 0,
      completedCount: 0,
      message: '正在准备检索结果和导出文件。',
    })
    await waitForNextTick()
    const response = await withLibraryProjectContext(control.projectId, () => resolveExportSearchResponse(keyword, options))
    if (!response.totalHits) throw new Error('当前检索没有可导出的命中。')

    const maxRecords = searchExportCountToLimit(taskOptions.maxExportRecords || DEFAULT_SEARCH_EXPORT_COUNT)
    const totalWork = vectorMode
      ? response.groups.reduce((sum, group) => sum + group.hits.length, 0)
      : response.groups.length
    const stream = createWriteStream(control.tempFilePath, { encoding: 'utf8' })
    let streamError: Error | null = null
    stream.on('error', (error) => { streamError = error instanceof Error ? error : new Error(String(error)) })
    const writeChunk = async (chunk: string) => {
      if (streamError) throw streamError
      await writeExportChunk(stream, chunk)
      if (streamError) throw streamError
    }
    await writeChunk(buildSearchExportTaskHeader(response, keyword, taskOptions, vectorMode))

    let processed = 0
    let exported = 0
    let missing = 0
    let filtered = 0
    let selected = 0
    let jsonFirstRecord = true
    const emitProgress = (message: string, status: 'processing' = 'processing') => {
      emitBackgroundTaskStatus({
        taskId,
        kind: 'search-export',
        status,
        progress: totalWork > 0 ? Math.min(0.99, processed / totalWork) : 0,
        totalCount: totalWork,
        completedCount: processed,
        message,
      })
    }
    const writeRecord = async (record: SearchExportRecord) => {
      const serialized = buildSearchExportTaskRecordText(record, exported, vectorMode, taskOptions.format)
      await writeChunk(taskOptions.format === 'json' ? `${jsonFirstRecord ? '' : ','}${serialized}` : serialized)
      jsonFirstRecord = false
      exported += 1
    }

    const flatHits = vectorMode
      ? response.groups.flatMap((group) => group.hits.map((hit) => ({ group, hit }))).sort((a, b) => (Number(b.hit.score) || 0) - (Number(a.hit.score) || 0))
      : []
    if (vectorMode) {
      for (const { group, hit } of flatHits) {
        if (control.canceled) throw new Error('__search_export_canceled__')
        processed += 1
        const score = Number(hit.score)
        const minScore = normalizeMinVectorScore(taskOptions.minVectorScore)
        if (minScore > 0 && !(Number.isFinite(score) && score >= minScore)) {
          filtered += 1
          continue
        }
        if (selected >= maxRecords) break
        selected += 1
        const paragraph = getHitParagraphForVectorExportFast(hit)
        if (!paragraph?.text) {
          missing += 1
          continue
        }
        const pageNum = resolveExportHitPageNum(hit, group, taskOptions.pageNumberMode || 'literature')
        await writeRecord({
          title: group.title || 'Untitled',
          author: group.author || null,
          docType: group.docType || '',
          pageNum,
          chapter: hit.locator.href || null,
          paragraph: paragraph.text,
          hitTerms: hit.locator.queryTerm ? [hit.locator.queryTerm] : [],
          hitCount: 1,
          citation: [group.author ? String(group.author) : '', group.title || '未命名文献', pageNum ? `第 ${pageNum} 页` : ''].filter(Boolean).join('，'),
          locator: hit.locator,
          stableLocator: hit.stableLocator,
          searchKeyword: keyword,
          exportedAt: new Date().toISOString(),
          sourceType: paragraph.source.sourceType,
          sourceKey: paragraph.source.sourceKey,
          score: Number.isFinite(score) ? score : null,
          segmentId: hit.locator.segmentId || null,
        })
        if (processed % 20 === 0) {
          emitProgress(`正在写入第 ${exported.toLocaleString()} 条向量证据。`)
          await waitForNextTick()
        }
      }
    } else {
      for (const group of response.groups) {
        if (control.canceled) throw new Error('__search_export_canceled__')
        const built = buildExportParagraphs(group)
        missing += built.missingHits
        processed += 1
        for (const paragraph of built.paragraphs) {
          if (control.canceled) throw new Error('__search_export_canceled__')
          if (selected >= maxRecords) break
          selected += 1
          const hit = paragraph.firstHit
          const pageNum = resolveExportHitPageNum(hit, group, taskOptions.pageNumberMode || 'literature')
          await writeRecord({
            title: group.title || 'Untitled',
            author: group.author || null,
            docType: group.docType || '',
            pageNum,
            chapter: hit.locator.href || null,
            paragraph: paragraph.text,
            hitTerms: [...paragraph.terms],
            hitCount: paragraph.hitCount,
            citation: formatHitCitation(group, hit, taskOptions, pageNum),
            locator: hit.locator,
            stableLocator: hit.stableLocator,
            searchKeyword: keyword,
            exportedAt: new Date().toISOString(),
            sourceType: paragraph.sourceType,
            sourceKey: paragraph.sourceKey,
            score: Number.isFinite(Number(hit.score)) ? Number(hit.score) : null,
            segmentId: hit.locator.segmentId || null,
          })
          if (exported % 20 === 0) await waitForNextTick()
        }
        if (processed % 5 === 0) emitProgress(`正在处理文献 ${processed.toLocaleString()} / ${totalWork.toLocaleString()}。`)
        if (selected >= maxRecords) break
      }
    }

    if (exported === 0) throw new Error(vectorMode ? '没有可导出的向量证据。' : '没有取得可导出的完整段落。')
    if (taskOptions.format === 'json') {
      await writeChunk(`],"missingHitCount":${missing},"filteredByMinScore":${filtered},"exportedCount":${exported}}`)
    } else if (missing > 0 || filtered > 0) {
      const summary = `\n${missing > 0 ? `跳过无法还原：${missing}\n` : ''}${filtered > 0 ? `因相似度不足跳过：${filtered}\n` : ''}`
      await writeChunk(summary)
    }
    await new Promise<void>((resolve, reject) => {
      const onFinish = () => { stream.removeListener('error', onError); resolve() }
      const onError = (error: Error) => { stream.removeListener('finish', onFinish); reject(error) }
      stream.once('finish', onFinish)
      stream.once('error', onError)
      stream.end()
    })
    if (control.canceled) throw new Error('__search_export_canceled__')
    // Preserve the existing export behavior: selecting an existing destination
    // replaces that file only after the temporary export completed successfully.
    try { await unlink(control.outputFilePath) } catch { /* destination may not exist */ }
    await rename(control.tempFilePath, control.outputFilePath)
    emitBackgroundTaskStatus({
      taskId,
      kind: 'search-export',
      status: 'completed',
      progress: 1,
      totalCount: totalWork,
      completedCount: processed,
      message: `导出完成：${exported.toLocaleString()} 条，已写入文件。`,
    })
  } catch (error) {
    const canceled = control.canceled || (error instanceof Error && error.message === '__search_export_canceled__')
    try { await unlink(control.tempFilePath) } catch { /* best effort */ }
    emitBackgroundTaskStatus({
      taskId,
      kind: 'search-export',
      status: canceled ? 'canceled' : 'error',
      progress: canceled ? 0 : 1,
      message: canceled ? '导出已取消，临时文件已清理。' : '导出失败。',
      errorMessage: canceled ? undefined : (error instanceof Error ? error.message : String(error)),
    })
  } finally {
    activeSearchExportTasks.delete(taskId)
  }
}

async function startSearchExportTask(keyword: string, options?: SearchOptions): Promise<SearchExportTaskStartResult> {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('请先输入检索词')
  const taskOptions = buildSearchExportTaskConfig(options)
  const extension = taskOptions.format === 'markdown' ? 'md' : taskOptions.format || 'txt'
  const selection = await dialog.showSaveDialog({
    title: '导出检索摘录（后台任务）',
    defaultPath: `${sanitizeFileName(`检索摘录-${query}`)}.${extension}`,
    filters: [{ name: taskOptions.format === 'markdown' ? 'Markdown' : String(taskOptions.format || 'txt').toUpperCase(), extensions: [extension] }],
  })
  if (selection.canceled || !selection.filePath) return { taskId: null, canceled: true, filePath: null }

  const taskId = `search-export:${nanoid(16)}`
  const control: SearchExportTaskControl = {
    canceled: false,
    outputFilePath: selection.filePath,
    tempFilePath: `${selection.filePath}.part-${taskId.replace(/[^a-z0-9_-]/gi, '')}`,
    projectId: captureActiveLibraryProjectId(),
  }
  activeSearchExportTasks.set(taskId, control)
  emitBackgroundTaskStatus({ taskId, kind: 'search-export', status: 'queued', progress: 0, message: '导出任务已加入后台队列。' })
  void runSearchExportTask(taskId, query, options || {}, control)
  return { taskId, canceled: false, filePath: null }
}

function cancelSearchExportTask(taskId: string): boolean {
  const control = activeSearchExportTasks.get(String(taskId || '').trim())
  if (!control) return false
  control.canceled = true
  return true
}

function buildSearchExcerptJson(
  records: SearchExportRecord[],
  response: SearchGroupedResponse,
  keyword: string,
  missingHitCount: number,
  options: SearchExportOptions = {},
): string {
  const vectorMode = isVectorExportResponse(response) || options.searchEngine === 'vector'
  return JSON.stringify({
    kind: vectorMode ? 'vector_semantic_evidence' : 'fulltext_search_excerpts',
    keyword,
    searchEngine: vectorMode ? 'vector' : 'fulltext',
    exporterVersion: vectorMode ? VECTOR_EXCERPT_EXPORTER_VERSION : SEARCH_EXCERPT_EXPORTER_VERSION,
    totalDocuments: response.totalDocuments,
    totalHits: response.totalHits,
    missingHitCount,
    exportedAt: new Date().toISOString(),
    // AI-oriented field name for vector mode
    evidence: vectorMode
      ? records.map((record, index) => ({
          rank: index + 1,
          score: record.score ?? null,
          similarity: formatSimilarityScore(record.score) || null,
          title: record.title,
          author: record.author,
          pageNum: record.pageNum,
          text: record.paragraph,
          citation: record.citation,
          ref: {
            docId: record.locator.docId,
            pageNum: record.pageNum,
            segmentId: record.segmentId || record.locator.segmentId || null,
          },
          locator: record.locator,
        }))
      : undefined,
    records: vectorMode ? undefined : records,
  }, null, 2)
}

function buildVectorSearchExcerptMarkdown(
  records: SearchExportRecord[],
  response: SearchGroupedResponse,
  keyword: string,
  missingHitCount: number,
  options: SearchExportOptions = {},
  filteredByMinScore = 0,
): string {
  const modelHint = (response.warnings || []).find((item) => /模型/.test(String(item || ''))) || ''
  const minScore = normalizeMinVectorScore(options.minVectorScore)
  const lines = [
    '# 向量库语义证据导出',
    '',
    '面向粘贴给 AI 的结构化证据清单（按相似度从高到低）。',
    '',
    `- 查询：${keyword}`,
    `- 引擎：向量库语义检索（非关键词全文）`,
    `- 文献数：${response.totalDocuments}`,
    `- 证据条数：${records.length}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    ...(minScore > 0 ? [`- 最低相似度：≥ ${minScore}`] : []),
    ...(modelHint ? [`- ${modelHint}`] : []),
    ...(filteredByMinScore > 0 ? [`- 因相似度不足跳过：${filteredByMinScore}`] : []),
    ...(missingHitCount > 0 ? [`- 跳过无法还原：${missingHitCount}`] : []),
    '',
    '---',
    '',
  ]
  records.forEach((record, index) => {
    const scoreText = formatSimilarityScore(record.score)
    lines.push(`## 证据 ${index + 1}${scoreText ? ` · 相似度 ${scoreText}` : ''}`)
    lines.push('')
    lines.push(`- 文献：${record.title}`)
    if (record.author) lines.push(`- 作者：${record.author}`)
    if (record.pageNum) lines.push(`- 页码：第 ${record.pageNum} 页`)
    if (scoreText) lines.push(`- 相似度 score：${scoreText}（余弦相似度，越高越相关）`)
    lines.push(`- 引用：${record.citation}`)
    lines.push(`- ref：docId=${record.locator.docId}; pageNum=${record.pageNum ?? ''}; segmentId=${record.segmentId || record.locator.segmentId || ''}`)
    lines.push('')
    lines.push('### 正文')
    lines.push('')
    lines.push(record.paragraph)
    lines.push('')
    lines.push('---')
    lines.push('')
  })
  return `\ufeff${lines.join('\n')}`
}

function buildVectorSearchExcerptTxt(
  records: SearchExportRecord[],
  response: SearchGroupedResponse,
  keyword: string,
  missingHitCount: number,
  options: SearchExportOptions = {},
  filteredByMinScore = 0,
): string {
  const modelHint = (response.warnings || []).find((item) => /模型/.test(String(item || ''))) || ''
  const minScore = normalizeMinVectorScore(options.minVectorScore)
  const lines: string[] = [
    `向量库语义证据导出（${VECTOR_EXCERPT_EXPORTER_VERSION}）`,
    '说明：当前仅导出文本语义命中，供复制给外部 AI 使用；按相似度从高到低排列。',
    `查询：${keyword}`,
    `引擎：向量库语义检索（不是关键词全文检索）`,
    `文献数：${response.totalDocuments}`,
    `证据条数：${records.length}`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
  ]
  if (minScore > 0) lines.push(`最低相似度：≥ ${minScore}（余弦相似度）`)
  if (modelHint) lines.push(modelHint)
  if (filteredByMinScore > 0) lines.push(`因相似度不足跳过：${filteredByMinScore}`)
  if (missingHitCount > 0) lines.push(`跳过无法还原：${missingHitCount}`)
  lines.push('', '==============================', '')

  records.forEach((record, index) => {
    const scoreText = formatSimilarityScore(record.score)
    lines.push(`[证据 ${index + 1}]`)
    if (scoreText) lines.push(`相似度：${scoreText}`)
    lines.push(`文献：${record.title}`)
    if (record.author) lines.push(`作者：${record.author}`)
    if (record.pageNum) lines.push(`页码：第 ${record.pageNum} 页`)
    lines.push(`引用：${record.citation}`)
    lines.push(`ref：docId=${record.locator.docId}; pageNum=${record.pageNum ?? ''}; segmentId=${record.segmentId || record.locator.segmentId || ''}`)
    lines.push('正文：')
    lines.push(record.paragraph)
    lines.push('')
    lines.push('------------------------------')
    lines.push('')
  })
  return `\ufeff${lines.join('\n')}`
}

function buildSearchExcerptContentFromRecords(
  records: SearchExportRecord[],
  missingHitCount: number,
  response: SearchGroupedResponse,
  keyword: string,
  options: SearchExportOptions = {},
  vectorMode = false,
  filteredByMinScore = 0,
): string {
  const format = options.format || 'txt'
  const minScore = normalizeMinVectorScore(options.minVectorScore)
  if (records.length === 0) {
    if (vectorMode && filteredByMinScore > 0) {
      throw new Error(
        `没有达到最低相似度（≥ ${minScore}）的向量证据。可调低阈值后重试。`,
      )
    }
    throw new Error(vectorMode
      ? '没有可导出的向量证据。请确认已建立向量索引且本次检索有命中。'
      : 'No complete paragraphs were available for export. Please rebuild the search index or confirm OCR/proofed text exists.')
  }
  if (format === 'txt') {
    return vectorMode
      ? buildVectorSearchExcerptTxt(records, response, keyword, missingHitCount, options, filteredByMinScore)
      : buildSearchExcerptTxt(response, keyword, options)
  }
  if (format === 'markdown') {
    return buildSearchExcerptMarkdown(
      records,
      response,
      keyword,
      missingHitCount,
      options,
      filteredByMinScore,
    )
  }
  if (format === 'csv') return buildSearchExcerptCsv(records, vectorMode)
  return buildSearchExcerptJson(records, response, keyword, missingHitCount, options)
}

function buildSearchExcerptContent(response: SearchGroupedResponse, keyword: string, options: SearchExportOptions = {}): string {
  const { records, missingHitCount, vectorMode, filteredByMinScore } = collectExportRecords(response, keyword, options)
  return buildSearchExcerptContentFromRecords(
    records,
    missingHitCount,
    response,
    keyword,
    options,
    vectorMode,
    filteredByMinScore,
  )
}

function buildSearchExcerptTxt(response: SearchGroupedResponse, keyword: string, options: SearchExportOptions = {}): string {
  const citationLabel = options.citationMode === 'simple'
    ? '简明引用'
    : options.citationMode === 'template'
      ? '手动选择模板'
      : '按引用标准和文献类型自动匹配'
  const lines: string[] = [
    `检索摘录导出（${SEARCH_EXCERPT_EXPORTER_VERSION}）`,
    `关键词：${keyword}`,
    `文献数：${response.totalDocuments}`,
    `命中数：${response.totalHits}`,
    `引用格式：${citationLabel}`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '==============================',
    '',
  ]

  let ordinal = 1
  let exportedParagraphCount = 0
  let missingHitCount = 0
  response.groups.forEach((group) => {
    const { paragraphs, missingHits } = buildExportParagraphs(group)
    exportedParagraphCount += paragraphs.length
    missingHitCount += missingHits
    lines.push(`## ${group.title || '未命名文献'}`)
    if (group.author) lines.push(`作者：${group.author}`)
    if (group.docType) lines.push(`类型：${group.docType}`)
    lines.push(`命中数：${group.totalHits}`)
    lines.push(`段落数：${paragraphs.length}`)
    if (missingHits > 0) {
      lines.push(`未导出命中：${missingHits}（这些命中无法回到索引原文或页原文，已跳过，避免导出省略号片段。）`)
    }
    lines.push('')

    paragraphs.forEach((paragraph) => {
      const hit = paragraph.firstHit
      const terms = [...paragraph.terms]
      lines.push(`[${ordinal}]`)
      lines.push(paragraph.text)
      lines.push('')
      lines.push(`引用：${formatHitCitation(group, hit, options)}`)
      lines.push(`段落命中：${paragraph.hitCount}${terms.length ? `（${terms.join('、')}）` : ''}`)
      lines.push(`定位：${locatorToText(hit.locator)}`)
      lines.push('')
      ordinal += 1
    })

    lines.push('------------------------------')
    lines.push('')
  })

  if (exportedParagraphCount === 0) {
    throw new Error('没有取得可导出的完整段落。请确认这些文献已有 OCR/校对文本，或先重建检索索引。')
  }
  if (missingHitCount > 0) {
    lines.splice(5, 0, `未导出命中：${missingHitCount}`)
  }

  return `\ufeff${lines.join('\n')}`
}

function buildSearchExportDiagnostics(response: SearchGroupedResponse, keyword: string): string {
  const documents = response.groups.map((group) => {
    const hits = group.hits.map((hit) => {
      const paragraph = getHitParagraph(hit)
      const source = paragraph?.source || getHitSourceText(hit, false)
      const paragraphText = paragraph?.text || ''
      const snippet = stripSnippetMarkers(hit.snippet || '')
      return {
        hitId: hit.id,
        pageNum: hit.locator.pageNum || null,
        segmentOrdinal: hit.locator.segmentOrdinal,
        segmentId: hit.locator.segmentId || null,
        charStart: hit.locator.charStart,
        charEnd: hit.locator.charEnd,
        occurrenceIndex: hit.locator.occurrenceIndex,
        queryTerm: hit.locator.queryTerm,
        matchText: hit.locator.matchText,
        snippetLength: snippet.length,
        snippetPreview: snippet.slice(0, 180),
        selectedSourceType: source?.sourceType || null,
        selectedSourceKey: source?.sourceKey || null,
        sourceLength: source?.text.length || 0,
        pageTextLength: source?.pageTextLength || 0,
        segmentTextLength: source?.segmentTextLength || 0,
        normalizedTextLength: source?.normalizedTextLength || 0,
        hitIndex: paragraph?.hitIndex ?? -1,
        hitIndexStrategy: paragraph?.hitIndexStrategy || 'not-found',
        paragraphStart: paragraph?.paragraphStart ?? null,
        paragraphEnd: paragraph?.paragraphEnd ?? null,
        paragraphLength: paragraphText.length,
        paragraphStartsWithEllipsis: /^\s*(\.\.\.|…)/.test(paragraphText),
        paragraphEndsWithEllipsis: /(\.\.\.|…)\s*$/.test(paragraphText),
        paragraphPreview: paragraphText.slice(0, 240),
        canExportFullParagraph: !!paragraphText && !/^\s*(\.\.\.|…)/.test(paragraphText) && !/(\.\.\.|…)\s*$/.test(paragraphText),
      }
    })
    return {
      docId: group.docId,
      title: group.title,
      author: group.author || null,
      docType: group.docType || null,
      totalHits: group.totalHits,
      exportableHits: hits.filter((hit) => hit.paragraphLength > 0).length,
      hits,
    }
  })
  return JSON.stringify({
    keyword,
    exporterVersion: SEARCH_EXCERPT_EXPORTER_VERSION,
    generatedAt: new Date().toISOString(),
    totalDocuments: response.totalDocuments,
    totalHits: response.totalHits,
    documents,
  }, null, 2)
}
function normalizeExportGroups(groups: SearchDocumentGroup[] | undefined | null): SearchDocumentGroup[] {
  if (!Array.isArray(groups) || groups.length === 0) return []
  return groups
    .map((group) => {
      const docId = String(group?.docId || '').trim()
      if (!docId) return null
      const hits = Array.isArray(group.hits) ? group.hits.filter((hit) => hit && hit.locator) : []
      if (hits.length === 0) return null
      const sortedHits = [...hits].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      return {
        docId,
        title: String(group.title || '未命名文献'),
        author: group.author ?? null,
        docType: String(group.docType || ''),
        totalHits: Number(group.totalHits) || sortedHits.length,
        hits: sortedHits,
        topHits: sortedHits.slice(0, 3),
        score: Math.max(0, ...sortedHits.map((hit) => Number(hit.score) || 0), Number(group.score) || 0),
      } satisfies SearchDocumentGroup
    })
    .filter((group): group is SearchDocumentGroup => !!group)
}

async function resolveExportSearchResponse(keyword: string, options?: SearchOptions): Promise<SearchGroupedResponse> {
  const query = String(keyword || '').trim()
  const {
    citationMode: _citationMode,
    citationStyleId: _citationStyleId,
    citationTemplateId: _citationTemplateId,
    previewOnly: _previewOnly,
    format: _format,
    searchEngine,
    exportGroups,
    exportWarnings,
    minVectorScore: _minVectorScore,
    maxExportRecords: _maxExportRecords,
    ...searchOptions
  } = options || {}
  const requestedExportCount = normalizeMaxExportRecords(_maxExportRecords, searchEngine === 'vector')
  const requestedExportLimit = searchExportCountToLimit(requestedExportCount)

  // Reuse on-screen results: no second full-corpus vector/FTS pass (avoids "Not Responding").
  const reusedGroups = normalizeExportGroups(exportGroups)
  if (reusedGroups.length > 0) {
    assertDocumentIdsInLibraryProject(
      reusedGroups.map((group) => group.docId),
      getActiveLibraryProjectId(),
    )
    const totalHits = reusedGroups.reduce((sum, group) => sum + (group.hits?.length || group.totalHits || 0), 0)
    const warnings = [
      ...(Array.isArray(exportWarnings) ? exportWarnings.map((item) => String(item || '').trim()).filter(Boolean) : []),
      searchEngine === 'vector'
        ? '使用当前向量检索结果导出（未重新扫描向量库）'
        : '使用当前检索结果导出（未重新执行全文检索）',
    ]
    return {
      query,
      totalDocuments: reusedGroups.length,
      totalHits,
      groups: reusedGroups,
      warnings,
      status: 'complete',
    }
  }

  if (searchEngine === 'vector') {
    const folderId = searchOptions.folderId
      || (Array.isArray(searchOptions.folderIds) ? searchOptions.folderIds[0] : undefined)
    const tagId = searchOptions.tagId
      || (Array.isArray(searchOptions.tagIds) ? searchOptions.tagIds[0] : undefined)
    const requestedLimit = Math.max(
      1,
      Math.round(Number(searchOptions?.limit || 40)) || 40,
      requestedExportLimit,
    )
    const vectorRes = await vectorSearch(query, {
      limit: requestedLimit,
      limitIsAll: requestedExportCount === 'all',
      allowLargeLimit: true,
      folderId: folderId ? String(folderId) : undefined,
      tagId: tagId ? String(tagId) : undefined,
    })
    if (!vectorRes.ok) {
      throw new Error(vectorRes.message || '向量检索失败，无法导出')
    }
    return buildGroupedResponseFromVectorHits(query, vectorRes.hits || [], vectorRes.modelId || '')
  }

  return querySearchV2(query, {
    ...searchOptions,
    limit: Math.max(Number(searchOptions?.limit || 0), requestedExportLimit),
    exhaustive: true,
    resultMode: 'all',
  })
}

function buildGroupedResponseFromVectorHits(
  keyword: string,
  hits: Array<{
    documentId: string
    title: string | null
    author: string | null
    pageNum: number | null
    excerpt: string
    score: number
    ref?: { docId?: string; pageNum?: number | null; segmentId?: string }
  }>,
  modelId: string,
): SearchGroupedResponse {
  const groups = new Map<string, SearchDocumentGroup>()
  hits.forEach((hit, index) => {
    const docId = String(hit.documentId || hit.ref?.docId || '').trim()
    if (!docId) return
    const pageNum = Number(hit.pageNum || hit.ref?.pageNum || 0) || null
    const segmentId = String(hit.ref?.segmentId || `${docId}:${pageNum || 0}:${index}`)
    const score = Number(hit.score) || 0
    const searchHit: SearchHit = {
      id: `vector:${segmentId}`,
      snippet: String(hit.excerpt || ''),
      score,
      locator: {
        docId,
        segmentId,
        pageId: null,
        pageNum,
        pageIndex: pageNum && pageNum > 0 ? pageNum - 1 : 0,
        href: null,
        segmentOrdinal: 0,
        charStart: 0,
        charEnd: Math.min(120, String(hit.excerpt || '').length),
        matchText: keyword,
        queryTerm: keyword,
        occurrenceIndex: index,
      },
    }
    const existing = groups.get(docId)
    if (existing) {
      existing.hits.push(searchHit)
      existing.totalHits = existing.hits.length
      existing.score = Math.max(existing.score, score)
      existing.topHits = [...existing.hits]
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
        .slice(0, 3)
      return
    }
    groups.set(docId, {
      docId,
      title: String(hit.title || '未命名文献'),
      author: hit.author ?? null,
      docType: '',
      totalHits: 1,
      hits: [searchHit],
      topHits: [searchHit],
      score,
    })
  })

  const groupList = [...groups.values()]
    .map((group) => ({
      ...group,
      hits: [...group.hits].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)),
      topHits: [...group.hits].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)).slice(0, 3),
      totalHits: group.hits.length,
    }))
    .sort((a, b) => b.score - a.score || b.totalHits - a.totalHits)

  const totalHits = groupList.reduce((sum, group) => sum + group.totalHits, 0)
  return {
    query: keyword,
    totalDocuments: groupList.length,
    totalHits,
    groups: groupList,
    warnings: [
      `向量库语义检索导出 · 模型 ${modelId || 'embeddings'}`,
      '导出优先使用页原文/检索段；无法还原时回退向量摘录片段。',
    ],
    status: 'complete',
  }
}

async function exportSearchExcerpts(keyword: string, options?: SearchOptions): Promise<SearchExportResult> {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('请先输入检索词')
  const allowedFormats = new Set(['txt', 'markdown', 'csv', 'json'])
  const format = allowedFormats.has(String(options?.format)) ? String(options?.format) as SearchExportOptions['format'] : 'txt'
  const requestedCitationMode = options?.citationMode
  const isVector = options?.searchEngine === 'vector'
  const minVectorScore = normalizeMinVectorScore(options?.minVectorScore)
  const maxExportRecords = normalizeMaxExportRecords(options?.maxExportRecords, !!isVector)
  const exportConfig: SearchExportOptions = {
    format,
    citationMode: ['auto', 'simple', 'template'].includes(String(requestedCitationMode))
      ? requestedCitationMode
      : 'auto',
    citationStyleId: typeof options?.citationStyleId === 'string' && options.citationStyleId.trim()
      ? options.citationStyleId.trim()
      : undefined,
    citationTemplateId: typeof options?.citationTemplateId === 'string' && options.citationTemplateId.trim()
      ? options.citationTemplateId.trim()
      : undefined,
    previewOnly: !!options?.previewOnly,
    searchEngine: isVector ? 'vector' : 'fulltext',
    pageNumberMode: resolveExportPageNumberMode(options),
    minVectorScore,
    maxExportRecords,
  }

  let outputFilePath: string | null = null
  if (!exportConfig.previewOnly) {
    // Ask for the destination before any bulk paragraph work so the app responds
    // immediately to the Export button even for a large evidence set.
    const extension = format === 'markdown' ? 'md' : format || 'txt'
    const filterName = format === 'markdown' ? 'Markdown' : String(format || 'txt').toUpperCase()
    const selection = await dialog.showSaveDialog({
      title: '导出检索摘录',
      defaultPath: `${sanitizeFileName(`检索摘录-${query}`)}.${extension}`,
      filters: [{ name: filterName, extensions: [extension] }],
    })
    if (selection.canceled || !selection.filePath) {
      const currentGroups = Array.isArray(options?.exportGroups) ? options.exportGroups : []
      return {
        canceled: true,
        filePath: null,
        totalHits: currentGroups.reduce((sum, group) => sum + (group.hits?.length || 0), 0),
        totalDocuments: currentGroups.length,
        exportableParagraphs: 0,
        skippedHits: 0,
        filteredByMinScore: 0,
        minVectorScore,
        maxExportRecords,
      }
    }
    outputFilePath = selection.filePath
  }

  const response = await resolveExportSearchResponse(query, options)
  if (!response.totalHits) throw new Error('No search hits are available to export.')
  // Build records once: content + stats share the same work (no second paragraph pass).
  const {
    records,
    missingHitCount,
    vectorMode,
    filteredByMinScore,
    minVectorScore: appliedMinScore,
    maxExportRecords: appliedMax,
  } = collectExportRecords(response, query, exportConfig)
  const content = buildSearchExcerptContentFromRecords(
    records,
    missingHitCount,
    response,
    query,
    exportConfig,
    vectorMode,
    filteredByMinScore,
  )

  if (exportConfig.previewOnly) {
    return {
      canceled: false,
      filePath: null,
      totalHits: response.totalHits,
      totalDocuments: response.totalDocuments,
      content,
      exportableParagraphs: records.length,
      skippedHits: missingHitCount,
      filteredByMinScore,
      minVectorScore: appliedMinScore,
      maxExportRecords: appliedMax,
    }
  }

  if (!outputFilePath) throw new Error('未选择导出文件路径')
  await writeFile(outputFilePath, content, 'utf-8')
  return {
    canceled: false,
    filePath: outputFilePath,
    totalHits: response.totalHits,
    totalDocuments: response.totalDocuments,
    exportableParagraphs: records.length,
    skippedHits: missingHitCount,
    filteredByMinScore,
    minVectorScore: appliedMinScore,
    maxExportRecords: appliedMax,
  }
}

async function previewSearchExcerpts(keyword: string, options?: SearchOptions): Promise<SearchExportPreviewResult> {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('请先输入检索词')
  const requestedCitationMode = options?.citationMode
  const isVector = options?.searchEngine === 'vector'
  const exportConfig: SearchExportOptions = {
    citationMode: ['auto', 'simple', 'template'].includes(String(requestedCitationMode))
      ? requestedCitationMode
      : 'auto',
    citationStyleId: typeof options?.citationStyleId === 'string' && options.citationStyleId.trim()
      ? options.citationStyleId.trim()
      : undefined,
    citationTemplateId: typeof options?.citationTemplateId === 'string' && options.citationTemplateId.trim()
      ? options.citationTemplateId.trim()
      : undefined,
    searchEngine: isVector ? 'vector' : 'fulltext',
    pageNumberMode: resolveExportPageNumberMode(options),
    minVectorScore: normalizeMinVectorScore(options?.minVectorScore),
    maxExportRecords: normalizeMaxExportRecords(options?.maxExportRecords, !!isVector),
  }
  const response = await resolveExportSearchResponse(query, options)
  return buildSearchExportPreview(response, query, exportConfig)
}

async function exportSearchDiagnostics(keyword: string, options?: SearchOptions): Promise<SearchExportResult> {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('请先输入检索词')
  const response = await resolveExportSearchResponse(query, options)
  if (!response.totalHits) throw new Error('当前检索没有可诊断的命中')
  const content = buildSearchExportDiagnostics(response, query)

  if (options?.previewOnly) {
    return {
      canceled: false,
      filePath: null,
      totalHits: response.totalHits,
      totalDocuments: response.totalDocuments,
      content,
    }
  }

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出检索诊断',
    defaultPath: `${sanitizeFileName(`检索诊断-${query}`)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (canceled || !filePath) return { canceled: true, filePath: null, totalHits: response.totalHits, totalDocuments: response.totalDocuments }

  writeFileSync(filePath, `\ufeff${content}`, 'utf-8')
  return {
    canceled: false,
    filePath,
    totalHits: response.totalHits,
    totalDocuments: response.totalDocuments,
  }
}

async function saveSearchExcerptRecords(keyword: string, options?: SaveSearchExcerptsOptions): Promise<SaveSearchExcerptsResult> {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('Please enter a search keyword first.')
  const {
    citationMode: _citationMode,
    citationStyleId: _citationStyleId,
    citationTemplateId: _citationTemplateId,
    previewOnly: _previewOnly,
    format: _format,
    projectId,
    searchEngine,
    exportGroups: _exportGroups,
    exportWarnings: _exportWarnings,
    minVectorScore,
    maxExportRecords,
    ..._rest
  } = options || {}
  const response = await resolveExportSearchResponse(query, options)
  const isVector = searchEngine === 'vector'
  const { records } = collectExportRecords(response, query, {
    citationMode: 'simple',
    searchEngine: isVector ? 'vector' : 'fulltext',
    minVectorScore: normalizeMinVectorScore(minVectorScore),
    maxExportRecords: normalizeMaxExportRecords(maxExportRecords, isVector),
  })
  const now = new Date().toISOString()
  let savedCount = 0
  let skippedCount = 0

  for (const record of records) {
    const paragraphHash = stableHash(buildSearchExcerptSourceHashInput({
      docId: record.locator.docId,
      pageNum: record.pageNum || '',
      excerpt: record.paragraph,
    }))
    const sourceId = JSON.stringify({
      sourceType: 'search',
      locator: record.locator,
      stableLocator: record.stableLocator || null,
      citation: record.citation,
      searchKeyword: query,
      matchedQuery: record.hitTerms[0] || record.locator.queryTerm || query,
      pageNum: record.pageNum,
      href: record.locator.href || null,
      chapterTitle: record.chapter,
      paragraphHash,
    })
    const existing = queryOne<{ id: string }>(
      `SELECT id FROM research_notes
       WHERE doc_id = ?
         AND source_type = 'search'
         AND (source_id LIKE ? OR excerpt = ?)
       LIMIT 1`,
      [record.locator.docId, `%${paragraphHash}%`, record.paragraph],
    )
    if (existing) {
      skippedCount += 1
      continue
    }
    const id = nanoid()
    run(
      `INSERT INTO research_notes (
        id, project_id, doc_id, page_num, excerpt, note, tags, source_type, source_id,
        kind, locator_json, citation_text, source_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        projectId || null,
        record.locator.docId,
        record.pageNum || null,
        record.paragraph,
        `来自检索：${query}`,
        record.hitTerms.join(', '),
        'search',
        sourceId,
        'quote',
        JSON.stringify(record.stableLocator || record.locator),
        record.citation,
        paragraphHash,
        now,
        now,
      ],
    )
    if (projectId) {
      run(
        'INSERT OR IGNORE INTO research_project_documents (project_id, doc_id, created_at) VALUES (?, ?, ?)',
        [projectId, record.locator.docId, now],
      )
      run('UPDATE research_projects SET updated_at = ? WHERE id = ?', [now, projectId])
    }
    savedCount += 1
  }

  if (savedCount > 0) saveDatabase()
  return { savedCount, skippedCount, totalRecords: records.length }
}

export function registerSearchIpc(): void {
  const inCapturedLibraryProject = <T>(operation: () => T): T => {
    const projectId = captureActiveLibraryProjectId()
    return withLibraryProjectContext(projectId, operation)
  }

  ipcMain.handle('search:fulltext', async (_event, keyword: string, options?: SearchOptions): Promise<SearchResult[]> => {
    return inCapturedLibraryProject(() => fullTextSearch(keyword, options))
  })

  ipcMain.handle('search:queryV2', async (_event, keyword: string, options?: SearchOptions): Promise<SearchGroupedResponse> => {
    return inCapturedLibraryProject(() => querySearchV2(keyword, options))
  })

  ipcMain.handle('search:validateSnapshot', async (_event, snapshotId: string, criteriaKey?: string): Promise<SearchSnapshotValidationResult> => {
    return validateSearchSnapshot(snapshotId, { criteriaKey })
  })

  ipcMain.handle('search:resolveEvidence', async (_event, locator: StableReaderLocator): Promise<ResolvedSearchEvidence> => {
    return resolveSearchEvidence(locator)
  })

  ipcMain.handle('search:promoteAggregate', async (
    _event,
    snapshotId: string,
    projectId: string,
    options?: { relationKind?: string; label?: string },
  ): Promise<{ artifact: ResearchAggregateArtifact; relation: ResearchAggregateRelation }> => (
    promoteSearchSnapshotAggregate({ snapshotId, projectId, ...options })
  ))

  ipcMain.handle('search:validateAggregate', async (_event, artifactId: string) => (
    validateResearchAggregateArtifact(artifactId)
  ))

  ipcMain.handle('search:listAggregateRelations', async (
    _event,
    projectId: string,
    options?: { limit?: number; cursor?: string | null },
  ): Promise<CursorPage<ResearchAggregateRelation & { artifact: ResearchAggregateArtifact }>> => (
    listResearchAggregateRelations(projectId, options)
  ))

  ipcMain.handle('search:exportExcerpts', async (_event, keyword: string, options?: SearchOptions): Promise<SearchExportResult> => {
    return inCapturedLibraryProject(() => exportSearchExcerpts(keyword, options))
  })

  ipcMain.handle('search:startExportTask', async (_event, keyword: string, options?: SearchOptions): Promise<SearchExportTaskStartResult> => {
    const projectId = captureActiveLibraryProjectId()
    return withLibraryProjectContext(projectId, () => startSearchExportTask(keyword, options))
  })

  ipcMain.handle('search:cancelExportTask', async (_event, taskId: string): Promise<boolean> => cancelSearchExportTask(taskId))

  ipcMain.handle('search:previewExportExcerpts', async (_event, keyword: string, options?: SearchOptions): Promise<SearchExportPreviewResult> => {
    return inCapturedLibraryProject(() => previewSearchExcerpts(keyword, options))
  })

  ipcMain.handle('search:exportDiagnostics', async (_event, keyword: string, options?: SearchOptions): Promise<SearchExportResult> => {
    return inCapturedLibraryProject(() => exportSearchDiagnostics(keyword, options))
  })

  ipcMain.handle('search:saveExcerpts', async (_event, keyword: string, options?: SaveSearchExcerptsOptions): Promise<SaveSearchExcerptsResult> => {
    return inCapturedLibraryProject(() => saveSearchExcerptRecords(keyword, options))
  })

  ipcMain.handle('search:getDocumentHits', async (_event, docId: string, keyword: string, options?: SearchOptions): Promise<SearchSessionState> => {
    return inCapturedLibraryProject(() => {
      assertDocumentInLibraryProject(docId, getActiveLibraryProjectId())
      return getDocumentSearchHits(docId, keyword, options)
    })
  })

  ipcMain.handle('search:getDocumentHitPage', async (_event, docId: string, keyword: string, options?: SearchOptions): Promise<SearchDocumentHitPage> => {
    return inCapturedLibraryProject(() => {
      assertDocumentInLibraryProject(docId, getActiveLibraryProjectId())
      return getDocumentSearchHitPage(docId, keyword, options)
    })
  })

  ipcMain.handle('search:reindexDocument', async (_event, docId: string): Promise<SearchReindexDocumentResult> => {
    return inCapturedLibraryProject(() => {
      assertDocumentInLibraryProject(docId, getActiveLibraryProjectId())
      return queueDocumentReindex(docId)
    })
  })

  ipcMain.handle('search:reindexAll', async (): Promise<SearchReindexAllResult> => {
    return inCapturedLibraryProject(() => queueAllDocumentsReindex())
  })

  ipcMain.handle('search:getIndexStatus', async (_event, docId?: string): Promise<SearchIndexStatus[]> => {
    return inCapturedLibraryProject(() => {
      if (docId) assertDocumentInLibraryProject(docId, getActiveLibraryProjectId())
      return getSearchIndexStatus(docId)
    })
  })

  ipcMain.handle('search:semantic', async (_event, keyword: string, options?: SearchOptions): Promise<SearchResult[]> => {
    return inCapturedLibraryProject(async () => {
      try {
        return await semanticSearch(keyword, options)
      } catch (error) {
        console.error('[Search] Semantic search failed:', error)
        return []
      }
    })
  })

  ipcMain.handle('search:aiPlanned', async (_event, prompt: string, options?: SearchOptions): Promise<AiPlannedSearchResponse> => {
    return inCapturedLibraryProject(async () => {
      try {
        return await aiPlannedSearch(prompt, options)
      } catch (error) {
        console.error('[Search] AI planned search failed:', error)
        throw error
      }
    })
  })

  ipcMain.handle('search:save', async (_event, name: string, filters: SavedSearchPayload): Promise<SavedSearch | null> => {
    return saveSearch(name, filters)
  })

  ipcMain.handle('search:listSaved', async (): Promise<SavedSearch[]> => {
    return listSavedSearches()
  })

  ipcMain.handle('search:deleteSaved', async (_event, id: string): Promise<boolean> => {
    return deleteSavedSearch(id)
  })

  ipcMain.handle('search:runSaved', async (_event, id: string): Promise<SavedSearchRunResult> => {
    return inCapturedLibraryProject(() => runSavedSearch(id))
  })

  ipcMain.handle('search:aiLibrary', async (_event, question: string, options?: SearchOptions): Promise<LibraryAiSearchResponse> => {
    return inCapturedLibraryProject(() => runLibraryAiSearch(question, options))
  })
}
