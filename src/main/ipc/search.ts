import { dialog, ipcMain } from 'electron'
import { writeFileSync } from 'fs'
import { nanoid } from 'nanoid'
import { queryOne, run, saveDatabase } from '../database'
import { createHash } from 'crypto'
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
import type {
  AiPlannedSearchResponse,
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
  SearchGroupedResponse,
  SearchHit,
  SearchIndexStatus,
  SearchOptions,
  SearchReindexAllResult,
  SearchReindexDocumentResult,
  SearchResult,
  SearchSessionState,
} from '../../shared/types'
import { buildCitation, buildCitationByStyle, mapDocTypeToCitationFormat } from './citation'

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
  searchKeyword: string
  exportedAt: string
  sourceType: HitSourceResolution['sourceType']
  sourceKey: string
}

const SEARCH_EXCERPT_EXPORTER_VERSION = 'full-paragraph-v2'

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
  const row = queryOne<{ proofed_text?: string | null; ocr_text?: string | null }>(
    `SELECT proofed_text, ocr_text
     FROM pages
     WHERE doc_id = ? AND page_num = ?
     ORDER BY page_num ASC
     LIMIT 1`,
    [hit.locator.docId, pageNum],
  )
  return row?.proofed_text || row?.ocr_text || ''
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

function getHitParagraph(hit: SearchHit): HitParagraphResolution | null {
  const source = getHitSourceText(hit)
  if (!source?.text) return null
  if (source.sourceType !== 'page' && isEllipsisSnippetText(source.text)) return null
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

function getLocationSuffix(hit: SearchHit): string {
  const parts = [
    hit.locator.pageNum ? `第 ${hit.locator.pageNum} 页` : '',
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

function formatHitCitation(group: SearchDocumentGroup, hit: SearchHit, options: SearchExportOptions): string {
  const templateId = resolveCitationTemplateId(group, options)
  const pageNum = hit.locator.pageNum || null
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
  const location = getLocationSuffix(hit)
  return [baseCitation, location].filter(Boolean).join('，')
}

function buildExportRecords(
  response: SearchGroupedResponse,
  keyword: string,
  options: SearchExportOptions = {},
  maxRecords = Number.POSITIVE_INFINITY,
): { records: SearchExportRecord[]; missingHitCount: number } {
  const records: SearchExportRecord[] = []
  let missingHitCount = 0
  const exportedAt = new Date().toISOString()
  response.groups.forEach((group) => {
    if (records.length >= maxRecords) return
    const { paragraphs, missingHits } = buildExportParagraphs(group)
    missingHitCount += missingHits
    paragraphs.forEach((paragraph) => {
      if (records.length >= maxRecords) return
      const hit = paragraph.firstHit
      records.push({
        title: group.title || 'Untitled',
        author: group.author || null,
        docType: group.docType || '',
        pageNum: hit.locator.pageNum || null,
        chapter: hit.locator.href || null,
        paragraph: paragraph.text,
        hitTerms: [...paragraph.terms],
        hitCount: paragraph.hitCount,
        citation: formatHitCitation(group, hit, options),
        locator: hit.locator,
        searchKeyword: keyword,
        exportedAt,
        sourceType: paragraph.sourceType,
        sourceKey: paragraph.sourceKey,
      })
    })
  })
  return { records, missingHitCount }
}

function buildSearchExportPreview(response: SearchGroupedResponse, keyword: string, options: SearchExportOptions = {}): SearchExportPreviewResult {
  const { records, missingHitCount } = buildExportRecords(response, keyword, options, 3)
  const previewItems: SearchExportPreviewItem[] = records.slice(0, 3).map((record) => ({
    title: record.title,
    author: record.author,
    docType: record.docType,
    pageNum: record.pageNum,
    paragraph: record.paragraph,
    hitTerms: record.hitTerms,
    hitCount: record.hitCount,
    citation: record.citation,
    locatorText: locatorToText(record.locator),
    sourceType: record.sourceType,
    sourceKey: record.sourceKey,
  }))
  return {
    exporterVersion: SEARCH_EXCERPT_EXPORTER_VERSION,
    keyword,
    totalDocuments: response.totalDocuments,
    totalHits: response.totalHits,
    exportableParagraphs: records.length,
    skippedHits: missingHitCount,
    previewItems,
  }
}

function locatorToText(locator: SearchHit['locator']): string {
  return [
    locator.pageNum ? `page=${locator.pageNum}` : '',
    locator.segmentOrdinal !== undefined ? `segment=${locator.segmentOrdinal}` : '',
    Number.isFinite(locator.charStart) ? `char=${locator.charStart}-${locator.charEnd}` : '',
    locator.queryTerm ? `term=${locator.queryTerm}` : '',
  ].filter(Boolean).join('; ')
}

function escapeCsvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function buildSearchExcerptMarkdown(records: SearchExportRecord[], response: SearchGroupedResponse, keyword: string, missingHitCount: number): string {
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

function buildSearchExcerptCsv(records: SearchExportRecord[]): string {
  const headers = ['title', 'author', 'docType', 'pageNum', 'chapter', 'paragraph', 'hitTerms', 'hitCount', 'citation', 'locator', 'searchKeyword', 'exportedAt']
  const rows = records.map((record) => [
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
  ].map(escapeCsvCell).join(','))
  return `\ufeff${headers.join(',')}\n${rows.join('\n')}`
}

function buildSearchExcerptJson(records: SearchExportRecord[], response: SearchGroupedResponse, keyword: string, missingHitCount: number): string {
  return JSON.stringify({
    keyword,
    totalDocuments: response.totalDocuments,
    totalHits: response.totalHits,
    missingHitCount,
    exportedAt: new Date().toISOString(),
    records,
  }, null, 2)
}

function buildSearchExcerptContent(response: SearchGroupedResponse, keyword: string, options: SearchExportOptions = {}): string {
  const format = options.format || 'txt'
  if (format === 'txt') return buildSearchExcerptTxt(response, keyword, options)
  const { records, missingHitCount } = buildExportRecords(response, keyword, options)
  if (records.length === 0) {
    throw new Error('No complete paragraphs were available for export. Please rebuild the search index or confirm OCR/proofed text exists.')
  }
  if (format === 'markdown') return buildSearchExcerptMarkdown(records, response, keyword, missingHitCount)
  if (format === 'csv') return buildSearchExcerptCsv(records)
  return buildSearchExcerptJson(records, response, keyword, missingHitCount)
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
async function exportSearchExcerpts(keyword: string, options?: SearchOptions): Promise<SearchExportResult> {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('请先输入检索词')
  const allowedFormats = new Set(['txt', 'markdown', 'csv', 'json'])
  const format = allowedFormats.has(String(options?.format)) ? String(options?.format) as SearchExportOptions['format'] : 'txt'
  const requestedCitationMode = options?.citationMode
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
  }
  const {
    citationMode: _citationMode,
    citationStyleId: _citationStyleId,
    citationTemplateId: _citationTemplateId,
    previewOnly: _previewOnly,
    format: _format,
    ...searchOptions
  } = options || {}
  const response = querySearchV2(query, {
    ...searchOptions,
    limit: Math.max(Number(searchOptions?.limit || 0), 1000),
    exhaustive: true,
    resultMode: 'all',
  })
  if (!response.totalHits) throw new Error('No search hits are available to export.')
  const content = buildSearchExcerptContent(response, query, exportConfig)

  if (exportConfig.previewOnly) {
    return {
      canceled: false,
      filePath: null,
      totalHits: response.totalHits,
      totalDocuments: response.totalDocuments,
      content,
    }
  }

  const extension = format === 'markdown' ? 'md' : format || 'txt'
  const filterName = format === 'markdown' ? 'Markdown' : String(format || 'txt').toUpperCase()
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出检索摘录',
    defaultPath: `${sanitizeFileName(`检索摘录-${query}`)}.${extension}`,
    filters: [{ name: filterName, extensions: [extension] }],
  })
  if (canceled || !filePath) return { canceled: true, filePath: null, totalHits: response.totalHits, totalDocuments: response.totalDocuments }

  writeFileSync(filePath, content, 'utf-8')
  const exportStats = buildSearchExportPreview(response, query, exportConfig)
  return {
    canceled: false,
    filePath,
    totalHits: response.totalHits,
    totalDocuments: response.totalDocuments,
    exportableParagraphs: exportStats.exportableParagraphs,
    skippedHits: exportStats.skippedHits,
  }
}

function previewSearchExcerpts(keyword: string, options?: SearchOptions): SearchExportPreviewResult {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('请先输入检索词')
  const requestedCitationMode = options?.citationMode
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
  }
  const {
    citationMode: _citationMode,
    citationStyleId: _citationStyleId,
    citationTemplateId: _citationTemplateId,
    previewOnly: _previewOnly,
    format: _format,
    ...searchOptions
  } = options || {}
  const response = querySearchV2(query, {
    ...searchOptions,
    limit: Math.max(Number(searchOptions?.limit || 0), 1000),
    exhaustive: true,
    resultMode: 'all',
  })
  return buildSearchExportPreview(response, query, exportConfig)
}

async function exportSearchDiagnostics(keyword: string, options?: SearchOptions): Promise<SearchExportResult> {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('请先输入检索词')
  const response = querySearchV2(query, {
    ...(options || {}),
    limit: Math.max(Number(options?.limit || 0), 1000),
    exhaustive: true,
    resultMode: 'all',
  })
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

function saveSearchExcerptRecords(keyword: string, options?: SaveSearchExcerptsOptions): SaveSearchExcerptsResult {
  const query = String(keyword || '').trim()
  if (!query) throw new Error('Please enter a search keyword first.')
  const {
    citationMode: _citationMode,
    citationStyleId: _citationStyleId,
    citationTemplateId: _citationTemplateId,
    previewOnly: _previewOnly,
    format: _format,
    projectId,
    ...searchOptions
  } = options || {}
  const response = querySearchV2(query, {
    ...searchOptions,
    limit: Math.max(Number(searchOptions?.limit || 0), 1000),
    exhaustive: true,
    resultMode: 'all',
  })
  const { records } = buildExportRecords(response, query, {
    citationMode: 'simple',
  })
  const now = new Date().toISOString()
  let savedCount = 0
  let skippedCount = 0

  for (const record of records) {
    const paragraphHash = stableHash(`${record.locator.docId}:${record.pageNum || ''}:${record.paragraph}`)
    const sourceId = JSON.stringify({
      sourceType: 'search',
      locator: record.locator,
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
        JSON.stringify(record.locator),
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
  ipcMain.handle('search:fulltext', async (_event, keyword: string, options?: SearchOptions): Promise<SearchResult[]> => {
    return fullTextSearch(keyword, options)
  })

  ipcMain.handle('search:queryV2', async (_event, keyword: string, options?: SearchOptions): Promise<SearchGroupedResponse> => {
    return querySearchV2(keyword, options)
  })

  ipcMain.handle('search:exportExcerpts', async (_event, keyword: string, options?: SearchOptions): Promise<SearchExportResult> => {
    return exportSearchExcerpts(keyword, options)
  })

  ipcMain.handle('search:previewExportExcerpts', async (_event, keyword: string, options?: SearchOptions): Promise<SearchExportPreviewResult> => {
    return previewSearchExcerpts(keyword, options)
  })

  ipcMain.handle('search:exportDiagnostics', async (_event, keyword: string, options?: SearchOptions): Promise<SearchExportResult> => {
    return exportSearchDiagnostics(keyword, options)
  })

  ipcMain.handle('search:saveExcerpts', async (_event, keyword: string, options?: SaveSearchExcerptsOptions): Promise<SaveSearchExcerptsResult> => {
    return saveSearchExcerptRecords(keyword, options)
  })

  ipcMain.handle('search:getDocumentHits', async (_event, docId: string, keyword: string, options?: SearchOptions): Promise<SearchSessionState> => {
    return getDocumentSearchHits(docId, keyword, options)
  })

  ipcMain.handle('search:getDocumentHitPage', async (_event, docId: string, keyword: string, options?: SearchOptions): Promise<SearchDocumentHitPage> => {
    return getDocumentSearchHitPage(docId, keyword, options)
  })

  ipcMain.handle('search:reindexDocument', async (_event, docId: string): Promise<SearchReindexDocumentResult> => {
    return queueDocumentReindex(docId)
  })

  ipcMain.handle('search:reindexAll', async (): Promise<SearchReindexAllResult> => {
    return queueAllDocumentsReindex()
  })

  ipcMain.handle('search:getIndexStatus', async (_event, docId?: string): Promise<SearchIndexStatus[]> => {
    return getSearchIndexStatus(docId)
  })

  ipcMain.handle('search:semantic', async (_event, keyword: string, options?: SearchOptions): Promise<SearchResult[]> => {
    try {
      return await semanticSearch(keyword, options)
    } catch (error) {
      console.error('[Search] Semantic search failed:', error)
      return []
    }
  })

  ipcMain.handle('search:aiPlanned', async (_event, prompt: string, options?: SearchOptions): Promise<AiPlannedSearchResponse> => {
    try {
      return await aiPlannedSearch(prompt, options)
    } catch (error) {
      console.error('[Search] AI planned search failed:', error)
      throw error
    }
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
    return runSavedSearch(id)
  })

  ipcMain.handle('search:aiLibrary', async (_event, question: string, options?: SearchOptions): Promise<LibraryAiSearchResponse> => {
    return runLibraryAiSearch(question, options)
  })
}
