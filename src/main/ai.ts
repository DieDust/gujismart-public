import { createHash } from 'crypto'
import { basename, extname } from 'path'
import { nanoid } from 'nanoid'
import { queryAll, queryOne, run, saveDatabase, transaction } from './database'
import { getActiveTranslationGlossary } from './glossary-service'
import {
  collectMetadataTagValues,
  FIELD_TAG_COLORS,
  syncDocumentMetadataTags,
} from './metadata-tags'
import {
  CITATION_FORMAT_LABELS,
  CITATION_FORMAT_ORDER,
  CITATION_PLACEHOLDER_LABELS,
  HISTORY_DOC_TYPE_CONFIGS,
  HISTORY_DOC_TYPE_OPTIONS,
  mapDocTypeToHistoryCitationFormat,
  normalizeHistoryDocType,
} from '../shared/history-citation'
import { DEFAULT_TRANSLATION_STYLE } from '../shared/translation-cache'
import { getResponseErrorMessage, isAbortError } from '../shared/errors'
import type {
  AiSynthesisResult,
  AiSynthesisTemplate,
  AiTaskOptions,
  AiTaskType,
  AiTagSuggestion,
  Document,
  DocumentMetadataResult,
  EvidenceQaSource,
  MetadataCandidate,
} from '../shared/types'

type AiDocumentBriefRow = Pick<Document, 'id' | 'title' | 'author' | 'metadata'>
type JsonRecord = Record<string, unknown>

interface LlmResponse extends JsonRecord {
  error?: unknown
  choices?: Array<{
    message?: { content?: unknown }
    delta?: { content?: unknown }
  }>
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface IdentifierSet {
  doi?: string
  isbn?: string
  issn?: string
  arxiv?: string
  pmid?: string
}

export interface MetadataCandidateDraft {
  field_name: string
  candidate_value: string
  source: string
  confidence: number
  evidence_page?: number | null
  evidence_text?: string | null
}

interface LookupMetadata {
  title?: string
  author?: string
  journal?: string
  publisher?: string
  publication_year?: string
  doi?: string
  isbn?: string
  issn?: string
  abstract?: string
  pages?: string
  volume?: string
  issue?: string
  publish_place?: string
  keywords?: string[]
}

const CLASSIFIABLE_TYPES = HISTORY_DOC_TYPE_OPTIONS

const CORE_METADATA_FIELDS = ['title', 'author', 'dynasty', 'source']
const TYPE_FIELD_SCHEMAS: Record<string, string[]> = Object.fromEntries(
  HISTORY_DOC_TYPE_CONFIGS.map((config) => [
    config.value,
    Array.from(new Set([
      ...CORE_METADATA_FIELDS,
      ...config.fields.map((field) => field.key),
      'publication_time',
      'page_reference',
    ])),
  ]),
)

export function hashPrompt(...parts: Array<string | undefined>): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part || '')
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

function sanitizeJson(raw: string): string {
  return raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecordValue(source: unknown, key: string): unknown {
  return isJsonRecord(source) ? source[key] : undefined
}

function getPathValue(source: unknown, path: string[]): unknown {
  let current = source
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (!isJsonRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isJsonRecord) : []
}

function parseJsonObject(raw: string): JsonRecord {
  const cleaned = sanitizeJson(raw)
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  const candidate = firstBrace >= 0 && lastBrace >= 0 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned
  const parsed = JSON.parse(candidate) as unknown
  if (isJsonRecord(parsed)) return parsed
  throw new Error('AI response is not a JSON object')
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\n，；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return []
}

function normalizeScalarValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = repairKnownMetadataNoise(typeof value === 'string' ? value.trim() : String(value).trim())
  if (/^(unknown|null|undefined|none|n\/a|-)+$/i.test(text)) return null
  if (looksLikeMetadataMojibake(text)) return null
  return text || null
}

function repairKnownMetadataNoise(value: string): string {
  return String(value || '')
    .replace(/^獲拳(?=[\u3400-\u9fff])/u, '')
    .trim()
}

function looksLikeMetadataMojibake(value: string): boolean {
  const text = String(value || '').trim()
  if (!text) return false
  if (/[�锟]/.test(text)) return true
  const rareNoiseMatches = text.match(/[鑾闔囚峴閲皆閭闢闗]/g) || []
  if (rareNoiseMatches.length >= 2) return true
  return /(?:鑾|闔|峴).*(?:囚|皆|閲)|(?:囚|皆|閲).*(?:鑾|闔|峴)/.test(text)
}

function extractFourDigitYear(value: unknown): string | null {
  const match = String(value || '').match(/(?:18|19|20)\d{2}/)
  return match ? match[0] : null
}

function isDateLikeKeyword(value: unknown): boolean {
  const text = String(value || '').trim()
  return /^(?:18|19|20)\d{2}\s*年?(?:\s*第\s*\d+\s*期)?$/.test(text)
    || /^(?:第\s*)?\d+\s*(?:卷|期)$/.test(text)
}

function sanitizeExtractedMetadata(metadata: JsonRecord): JsonRecord {
  const next = { ...metadata }
  for (const key of ['title', 'author', 'dynasty', 'source', 'publisher', 'journal', 'publish_place', '_doc_type']) {
    if (key in next) next[key] = normalizeScalarValue(next[key])
  }
  const issueYear = extractFourDigitYear(next.issue_date)
  const publicationTimeYear = extractFourDigitYear(next.publication_time)
  const publicationYear = extractFourDigitYear(next.publication_year)

  if (issueYear) {
    next.publication_year = issueYear
  } else if (publicationTimeYear) {
    next.publication_year = publicationTimeYear
  } else if (publicationYear) {
    next.publication_year = publicationYear
  } else if (next.publication_year) {
    next.publication_year = null
  }

  if (Array.isArray(next.keywords)) {
    next.keywords = next.keywords
      .map((item) => String(item || '').trim())
      .filter((item) => item && !isDateLikeKeyword(item))
      .slice(0, 8)
  }

  return next
}

function getMetadataObject(doc: { metadata?: string | null }): JsonRecord {
  return safeJsonParse(doc.metadata, {})
}

function getPageTexts(docId: string): Array<{ pageNum: number; text: string }> {
  const pages = queryAll<{ page_num: number; ocr_text: string }>(
    "SELECT page_num, COALESCE(proofed_text, ocr_text, '') as ocr_text FROM pages WHERE doc_id = ? ORDER BY page_num",
    [docId]
  )

  return pages
    .map((page) => ({ pageNum: page.page_num, text: page.ocr_text || '' }))
    .filter((page) => page.text.trim().length > 0)
}

interface AiSourcePage {
  pageNum: number
  text: string
  title?: string
}

export interface AiDocumentBrief {
  docId: string
  title: string
  author?: string | null
  summary: string
  key_points: string[]
  keywords: string[]
  toc: Array<{ title: string; page_num: number }>
  evidence: Array<{ page_num: number; snippet: string }>
}

export interface AiEvidenceSource {
  doc_id: string
  doc_title: string
  page_num: number
  snippet: string
  score: number
}

export interface AiContextPackage {
  briefs: AiDocumentBrief[]
  evidence: AiEvidenceSource[]
  prompt: string
}

function truncateText(text: string, maxLength: number): string {
  const normalized = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (normalized.length <= maxLength) return normalized
  const slice = normalized.slice(0, maxLength)
  const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('。'), slice.lastIndexOf('；'))
  return `${slice.slice(0, breakAt > maxLength * 0.55 ? breakAt + 1 : maxLength).trim()}……`
}

function parseMaybeJsonValue<T>(value: unknown, fallback: T): T {
  if (!value) return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function getDetailedPageTexts(docId: string): AiSourcePage[] {
  const rows = queryAll<{ page_num: number; text: string; ocr_result: string | null }>(
    "SELECT page_num, COALESCE(proofed_text, ocr_text, '') as text, ocr_result FROM pages WHERE doc_id = ? ORDER BY page_num",
    [docId],
  )

  return rows
    .map((row) => {
      const parsed = parseMaybeJsonValue<any>(row.ocr_result, {})
      return {
        pageNum: row.page_num,
        text: String(row.text || '').trim(),
        title: parsed?.ebook?.title ? String(parsed.ebook.title).trim() : undefined,
      }
    })
    .filter((page) => page.text.length > 0)
}

function getPagesSourceHash(docId: string, pages: AiSourcePage[]): string {
  const signature = pages
    .map((page) => `${page.pageNum}:${page.text.length}:${page.text.slice(0, 160)}:${page.text.slice(-160)}`)
    .join('\n')
  return hashPrompt(docId, signature)
}

function looksLikeSectionTitle(line: string): boolean {
  const text = line.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 80 || /^\d+$/.test(text)) return false
  return /^(目录|CONTENTS|自序|序言|前言|绪论|导论|引言|结语|后记|附录|参考文献)$/i.test(text)
    || /^第[一二三四五六七八九十百千万\d]+[章节卷篇部编回]/.test(text)
    || /^[一二三四五六七八九十百千万\d]+[、.．]\s*.{2,60}$/.test(text)
}

function inferPageHeading(page: AiSourcePage): string | undefined {
  if (page.title && !/^第\s*\d+\s*[章节页]$/.test(page.title)) return page.title
  return page.text
    .split(/\n+/)
    .slice(0, 8)
    .map((line) => line.trim())
    .find(looksLikeSectionTitle)
}

function selectRepresentativePages(pages: AiSourcePage[], maxPages = 12): AiSourcePage[] {
  if (pages.length <= maxPages) return pages
  const selected = new Map<number, AiSourcePage>()
  const add = (page?: AiSourcePage) => {
    if (page) selected.set(page.pageNum, page)
  }

  pages.slice(0, 3).forEach(add)
  pages.slice(-2).forEach(add)
  pages.filter(inferPageHeading).slice(0, 5).forEach(add)

  const sampleCount = Math.max(0, maxPages - selected.size)
  if (sampleCount > 0) {
    const step = Math.max(1, Math.floor(pages.length / (sampleCount + 1)))
    for (let i = step; selected.size < maxPages && i < pages.length; i += step) {
      add(pages[i])
    }
  }

  return [...selected.values()]
    .sort((left, right) => left.pageNum - right.pageNum)
    .slice(0, maxPages)
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  return normalizeListValue(value).slice(0, limit)
}

function buildFallbackBrief(docId: string, doc: Pick<Document, 'title' | 'author'>, pages: AiSourcePage[]): AiDocumentBrief {
  const title = String(doc?.title || 'Untitled')
  const toc = pages
    .map((page) => ({ page, heading: inferPageHeading(page) }))
    .filter((item) => !!item.heading)
    .slice(0, 12)
    .map((item) => ({ title: item.heading || '', page_num: item.page.pageNum }))
  const evidence = selectRepresentativePages(pages, 5).map((page) => ({
    page_num: page.pageNum,
    snippet: truncateText(page.text, 220),
  }))

  return {
    docId,
    title,
    author: doc?.author || null,
    summary: truncateText(pages.slice(0, 3).map((page) => page.text).join('\n\n'), 900),
    key_points: evidence.map((item) => item.snippet).filter(Boolean).slice(0, 5),
    keywords: [],
    toc,
    evidence,
  }
}

async function summarizeDocumentForCache(docId: string, doc: Pick<Document, 'title' | 'author'>, pages: AiSourcePage[]): Promise<AiDocumentBrief> {
  const representative = selectRepresentativePages(pages, 12)
  const sourceText = representative
    .map((page) => {
      const heading = inferPageHeading(page)
      return [`[Page ${page.pageNum}${heading ? ` / ${heading}` : ''}]`, truncateText(page.text, 900)].join('\n')
    })
    .join('\n\n---\n\n')

  const prompt = [
    '你是文献研究助手。请把下面文献材料压缩成可复用的“文献卡片”，只输出 JSON，不要输出解释。',
    'JSON 格式：{"summary":"","key_points":[],"keywords":[],"toc":[],"evidence":[]}',
    '要求：',
    '1. summary 用中文概括全书/全文主题、材料范围、核心论点，400-700字。',
    '2. key_points 列 5-8 条关键观点或信息。',
    '3. keywords 列 6-12 个检索关键词。',
    '4. toc 从材料中识别章节/小节名，格式为 {"title":"","page_num":1}，最多 16 条。',
    '5. evidence 选 4-8 条最适合作为后续引用的短摘录，格式为 {"page_num":1,"snippet":""}。',
    '6. 不要编造材料中没有的信息；证据不足时保持保守。',
    '',
    `文献标题：${doc?.title || ''}`,
    `作者：${doc?.author || ''}`,
    '',
    sourceText,
  ].join('\n')

  try {
    const raw = await callLLM([{ role: 'user', content: prompt }])
    const parsed = parseJsonObject(raw)
    return {
      docId,
      title: String(doc?.title || 'Untitled'),
      author: doc?.author || null,
      summary: truncateText(String(parsed.summary || ''), 1400) || buildFallbackBrief(docId, doc, pages).summary,
      key_points: normalizeStringArray(parsed.key_points, 10),
      keywords: normalizeStringArray(parsed.keywords, 14),
      toc: Array.isArray(parsed.toc)
        ? asRecordArray(parsed.toc)
            .map((item) => ({
              title: String(item.title || '').trim(),
              page_num: Number(item.page_num || item.page || 0) || 0,
            }))
            .filter((item) => item.title)
            .slice(0, 18)
        : [],
      evidence: Array.isArray(parsed.evidence)
        ? asRecordArray(parsed.evidence)
            .map((item) => ({
              page_num: Number(item.page_num || item.page || 0) || 0,
              snippet: truncateText(String(item.snippet || ''), 260),
            }))
            .filter((item) => item.snippet)
            .slice(0, 10)
        : [],
    }
  } catch (error) {
    console.warn('[AI] Document summary cache generation failed, using fallback', error)
    return buildFallbackBrief(docId, doc, pages)
  }
}

export async function getDocumentBrief(docId: string, options?: { forceRefresh?: boolean }): Promise<AiDocumentBrief | null> {
  const doc = queryOne<AiDocumentBriefRow>('SELECT id, title, author, metadata FROM documents WHERE id = ?', [docId])
  if (!doc) return null
  const pages = getDetailedPageTexts(docId)
  if (pages.length === 0) return null

  const sourceHash = getPagesSourceHash(docId, pages)
  const cached = options?.forceRefresh
    ? null
    : queryOne<{ source_hash: string; summary_json: string }>('SELECT source_hash, summary_json FROM ai_document_summaries WHERE doc_id = ?', [docId])
  if (cached?.source_hash === sourceHash && cached.summary_json) {
    const parsed = safeJsonParse<AiDocumentBrief | null>(cached.summary_json, null)
    if (parsed?.summary) return parsed
  }

  const brief = await summarizeDocumentForCache(docId, doc, pages)
  const now = new Date().toISOString()
  run(
    `INSERT INTO ai_document_summaries (doc_id, source_hash, summary_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET
       source_hash = excluded.source_hash,
       summary_json = excluded.summary_json,
       updated_at = excluded.updated_at`,
    [docId, sourceHash, JSON.stringify(brief), now, now],
  )
  saveDatabase()
  return brief
}

function tokenizeForEvidence(text: string): string[] {
  const normalized = String(text || '').toLowerCase()
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) || []
  const chinese = normalized.match(/[\u4e00-\u9fa5]{2,8}/g) || []
  return [...new Set([...latin, ...chinese])].slice(0, 24)
}

function scorePageForTerms(page: AiSourcePage, terms: string[]): number {
  if (terms.length === 0) return 0
  const text = page.text.toLowerCase()
  let score = 0
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const count = (text.match(new RegExp(escaped, 'g')) || []).length
    score += Math.min(count, 4) * (term.length >= 4 ? 2 : 1)
  }
  if (inferPageHeading(page)) score += 0.5
  return score
}

function selectEvidenceForDoc(docId: string, title: string, intent: string, brief: AiDocumentBrief): AiEvidenceSource[] {
  const pages = getDetailedPageTexts(docId)
  const terms = tokenizeForEvidence([intent, brief.keywords.join(' '), brief.key_points.join(' ')].join(' '))
  const scored = pages
    .map((page) => ({ page, score: scorePageForTerms(page, terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.page.pageNum - right.page.pageNum)
    .slice(0, 4)
    .map((item) => ({
      doc_id: docId,
      doc_title: title,
      page_num: item.page.pageNum,
      snippet: truncateText(item.page.text, 320),
      score: item.score,
    }))

  if (scored.length > 0) return scored
  return brief.evidence.slice(0, 3).map((item) => ({
    doc_id: docId,
    doc_title: title,
    page_num: item.page_num,
    snippet: item.snippet,
    score: 0.5,
  }))
}

function formatAiContextPackage(briefs: AiDocumentBrief[], evidence: AiEvidenceSource[], intent: string): string {
  const briefText = briefs.map((brief, index) => {
    const toc = brief.toc.slice(0, 10).map((item) => `${item.title}${item.page_num ? `(${item.page_num})` : ''}`).join('；')
    return [
      `【文献${index + 1}】${brief.title}${brief.author ? ` / ${brief.author}` : ''}`,
      `摘要：${truncateText(brief.summary, 900)}`,
      brief.key_points.length ? `要点：${brief.key_points.slice(0, 8).map((item) => `- ${item}`).join('\n')}` : '',
      brief.keywords.length ? `关键词：${brief.keywords.slice(0, 12).join('，')}` : '',
      toc ? `目录线索：${toc}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n\n---\n\n')

  const evidenceText = evidence
    .slice(0, Math.max(12, Math.min(40, briefs.length * 4)))
    .map((item, index) => `${index + 1}. ${item.doc_title}，第 ${item.page_num || '?'} 页：${item.snippet}`)
    .join('\n')

  return [
    `研究问题/任务：${intent || '综合分析'}`,
    '',
    '一、文献卡片（缓存摘要，优先用于全局理解）',
    briefText,
    '',
    '二、可引用证据（优先用于具体结论）',
    evidenceText || '暂无额外证据。',
  ].join('\n')
}

export async function buildAiContextForDocuments(docIds: string[], intent: string): Promise<AiContextPackage> {
  const uniqueDocIds = [...new Set(docIds.filter(Boolean))]
  const briefs: AiDocumentBrief[] = []
  const evidence: AiEvidenceSource[] = []

  for (const docId of uniqueDocIds) {
    const brief = await getDocumentBrief(docId)
    if (!brief) continue
    briefs.push(brief)
    evidence.push(...selectEvidenceForDoc(docId, brief.title, intent, brief))
  }

  evidence.sort((left, right) => right.score - left.score)
  return {
    briefs,
    evidence,
    prompt: formatAiContextPackage(briefs, evidence, intent),
  }
}

function selectPagesByStage(
  pages: Array<{ pageNum: number; text: string }>,
  stage: number
): Array<{ pageNum: number; text: string }> {
  const selected = new Set<number>()
  if (stage >= 1) {
    pages.slice(0, 2).forEach((page) => selected.add(page.pageNum))
    pages.slice(-1).forEach((page) => selected.add(page.pageNum))
  }
  if (stage >= 2) {
    pages.slice(0, 5).forEach((page) => selected.add(page.pageNum))
    pages.slice(-2).forEach((page) => selected.add(page.pageNum))
  }
  if (stage >= 3) {
    pages.slice(0, 8).forEach((page) => selected.add(page.pageNum))
    pages.slice(-4).forEach((page) => selected.add(page.pageNum))
  }

  return pages.filter((page) => selected.has(page.pageNum))
}

function extractIdentifiers(text: string): IdentifierSet {
  const source = text || ''
  const doi = source.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i)?.[0]
  const isbn = source.match(/\b(?:97[89][- ]?)?\d[-\d ]{8,16}[\dXx]\b/)?.[0]?.replace(/[- ]/g, '')
  const issn = source.match(/\b\d{4}-\d{3}[\dXx]\b/)?.[0]
  const arxiv = source.match(/\b(?:arXiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?)\b/i)?.[1]
  const pmid = source.match(/\bPMID[:\s]*([0-9]{5,9})\b/i)?.[1]

  return {
    doi,
    isbn,
    issn,
    arxiv,
    pmid
  }
}

async function lookupByDoi(doi: string): Promise<LookupMetadata | null> {
  const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { 'User-Agent': 'WenxianManager/0.1' }
  })
  if (!response.ok) return null
  const data = await response.json() as JsonRecord
  const item = readRecordValue(data, 'message')
  if (!isJsonRecord(item)) return null

  const authors = Array.isArray(item.author)
    ? asRecordArray(item.author)
        .map((author) => [author.family, author.given].filter(Boolean).join(' '))
        .filter(Boolean)
        .join(', ')
    : undefined

  const year = getPathValue(item, ['issued', 'date-parts', '0', '0'])
  return {
    title: Array.isArray(item.title) ? String(item.title[0] || '') : undefined,
    author: authors,
    journal: Array.isArray(item['container-title']) ? String(item['container-title'][0] || '') : undefined,
    publisher: String(item.publisher || '') || undefined,
    publication_year: year ? String(year) : undefined,
    doi: String(item.DOI || '') || undefined,
    issn: Array.isArray(item.ISSN) ? String(item.ISSN[0] || '') : undefined,
    pages: String(item.page || '') || undefined,
    volume: String(item.volume || '') || undefined,
    issue: String(item.issue || '') || undefined,
    abstract: String(item.abstract || '') || undefined,
  }
}

async function lookupByIsbn(isbn: string): Promise<LookupMetadata | null> {
  const response = await fetch(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`)
  if (!response.ok) return null
  const data = await response.json() as JsonRecord

  let author = ''
  if (Array.isArray(data.authors) && data.authors.length > 0) {
    const names = await Promise.all(
      asRecordArray(data.authors).slice(0, 3).map(async (entry) => {
        const authorResponse = await fetch(`https://openlibrary.org${entry.key || ''}.json`)
        if (!authorResponse.ok) return ''
        const authorData = await authorResponse.json() as JsonRecord
        return String(authorData.name || '')
      })
    )
    author = names.filter(Boolean).join(', ')
  }

  return {
    title: String(data.title || '') || undefined,
    author: author || undefined,
    publisher: Array.isArray(data.publishers) ? String(data.publishers[0] || '') : undefined,
    publication_year: String(data.publish_date || '').match(/\d{4}/)?.[0],
    isbn
  }
}

async function lookupByArxiv(arxivId: string): Promise<LookupMetadata | null> {
  const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`)
  if (!response.ok) return null
  const xml = await response.text()
  const title = xml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ').trim()
  const authors = [...xml.matchAll(/<name>([\s\S]*?)<\/name>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
  const summary = xml.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, ' ').trim()
  const published = xml.match(/<published>(\d{4})-/)?.[1]

  return {
    title,
    author: authors.join(', ') || undefined,
    publication_year: published,
    abstract: summary
  }
}

async function lookupIdentifiers(identifiers: IdentifierSet): Promise<MetadataCandidateDraft[]> {
  const candidates: MetadataCandidateDraft[] = []

  try {
    if (identifiers.doi) {
      const result = await lookupByDoi(identifiers.doi)
      if (result) {
        for (const [field, value] of Object.entries(result)) {
          const normalized = normalizeScalarValue(value)
          if (!normalized) continue
          candidates.push({
            field_name: field,
            candidate_value: normalized,
            source: 'crossref:doi',
            confidence: field === 'doi' ? 0.99 : 0.93
          })
        }
      }
    }
  } catch (error) {
    console.warn('[AI] DOI lookup failed', error)
  }

  try {
    if (identifiers.isbn) {
      const result = await lookupByIsbn(identifiers.isbn)
      if (result) {
        for (const [field, value] of Object.entries(result)) {
          const normalized = normalizeScalarValue(value)
          if (!normalized) continue
          candidates.push({
            field_name: field,
            candidate_value: normalized,
            source: 'openlibrary:isbn',
            confidence: field === 'isbn' ? 0.99 : 0.88
          })
        }
      }
    }
  } catch (error) {
    console.warn('[AI] ISBN lookup failed', error)
  }

  try {
    if (identifiers.arxiv) {
      const result = await lookupByArxiv(identifiers.arxiv)
      if (result) {
        for (const [field, value] of Object.entries(result)) {
          const normalized = normalizeScalarValue(value)
          if (!normalized) continue
          candidates.push({
            field_name: field,
            candidate_value: normalized,
            source: 'arxiv',
            confidence: field === 'title' || field === 'author' ? 0.9 : 0.82
          })
        }
      }
    }
  } catch (error) {
    console.warn('[AI] arXiv lookup failed', error)
  }

  for (const [field, value] of Object.entries(identifiers)) {
    const normalized = normalizeScalarValue(value)
    if (!normalized) continue
    candidates.push({
      field_name: field,
      candidate_value: normalized,
      source: 'identifier',
      confidence: 0.98
    })
  }

  return dedupeCandidates(candidates)
}

function getSchemaForDocType(docType: string): string[] {
  const direct = TYPE_FIELD_SCHEMAS[docType]
  if (direct) return direct

  const formatType = mapDocTypeToHistoryCitationFormat(docType)
  const byFormat = HISTORY_DOC_TYPE_CONFIGS.find((config) => config.formatType === formatType)
  return TYPE_FIELD_SCHEMAS[byFormat?.value || '其他'] || TYPE_FIELD_SCHEMAS['其他']
}

function buildMetadataPrompt(docType: string, combinedText: string): string {
  const fields = getSchemaForDocType(docType)
  return [
    '你是一个谨慎的文献元数据提取助手。',
    `文献类型：${docType}`,
    '请只返回 JSON，不要附加解释。',
    '请尽量提取以下字段，没有证据的字段返回 null：',
    fields.map((field) => `- ${field}`).join('\n'),
    'Strict publication-date rules:',
    '- publication_year must be the publication year of this document itself. Do not use historical years mentioned in the body, research object, narrative, citations, or references.',
    '- For journal articles, prefer issue_date from the journal header/footer/citation, then derive publication_year from issue_date. If no bibliographic evidence is visible, return null.',
    '- Do not put years, issue numbers, volume numbers, or dates into keywords.',
    '规则：',
    '- title、author、journal、publisher 优先使用原文正式名称。',
    '- publication_year 只输出四位数字年份，无法确定时返回 null。',
    '- publication_time 保留出版时间文本，例如“1983 年”“[出版时间不详]”；“影印本”“标点本”“整理本”等放入 version。',
    '- pages 只填页码数字或范围；page_reference 可填完整页码标注，例如“第 43 页”“第 9 页 a”“第 367 页”。',
    '- 期刊论文优先填写 issue_date，例如“1998 年第 3 期”“第 28 卷第 1 期，1976 年 1 月”。',
    '- 档案和手稿优先填写 date、archive_id、collection。',
    '- 古籍尽量提取 volume_info、chapter、version、page_side、column、series、series_volume。',
    '- keywords 返回数组，3 到 8 个。',
    '- 如果识别到 DOI、ISBN、ISSN、arXiv、PMID，也请一并返回。',
    '',
    '文献文本：',
    '"""',
    combinedText.slice(0, 6000),
    '"""'
  ].join('\n')
}

function buildClassificationPrompt(sampleText: string): string {
  return [
    '你是一个文献分类助手。',
    `请从以下类型中只选择一个：${CLASSIFIABLE_TYPES.join('、')}`,
    '输出时只返回类型名称，不要附加解释。',
    '',
    '文本：',
    '"""',
    sampleText.slice(0, 1200),
    '"""'
  ].join('\n')
}

function buildCitationPrompt(sampleText: string): string {
  return [
    '你是一个引文格式识别助手。',
    '请只输出以下一种：GB-T7714、APA、MLA、Chicago、其他。',
    '',
    '文本：',
    '"""',
    sampleText.slice(0, 1500),
    '"""'
  ].join('\n')
}

function buildSemanticPrompt(keyword: string): string {
  return [
    '你是一个学术检索扩展助手。',
    '请将用户检索词扩展成 JSON，格式必须为：{"keywords":[],"synonyms":[],"related":[]}',
    '每个数组最多返回 6 个短语，避免太泛。',
    '',
    `检索词：${keyword}`
  ].join('\n')
}

function buildAiSearchPlanPrompt(prompt: string): string {
  return [
    '你是 GujiSmart 文献库的 AI 检索规划器。',
    '请把用户的自然语言研究需求拆解成可执行的本地文献检索计划，只输出 JSON，不要输出解释。',
    'JSON 格式必须为：',
    '{"intent":"","keywords":[],"expandedKeywords":[],"excludeKeywords":[],"inferredFilters":{"docType":"","author":"","dynasty":"","yearFrom":null,"yearTo":null},"notes":""}',
    '要求：',
    '1. keywords 是最核心、最可能直接命中的短词，最多 8 个。',
    '2. expandedKeywords 是同义词、相关概念、历史称谓、常见后缀模式词，最多 18 个。',
    '3. 如果用户限定朝代、年份、作者、文献类型，请填入 inferredFilters；没有明确限定则留空或 null。',
    '4. 不要编造不存在的文献标题或页码，只规划检索词。',
    '5. 对“渡口”这类主题，要补充“渡”“津”“津渡”“渡船”“关津”“某某渡”“某某津”等相关检索词。',
    '6. 如果用户是在要求综述、总结、趋势、脉络、空白、难点或研究方向，这些是分析任务词，不要放入 keywords 或 expandedKeywords；应提取真正的研究对象、时期、地域、制度、人物、机构和材料类型作为检索词。',
    '7. 不要因为用户说“综述”就优先查找标题含“综述/述评/研究进展”的文章；除非用户明确说只要综述类文献。',
    '',
    `用户需求：${prompt}`
  ].join('\n')
}

function buildLibraryQaPrompt(question: string, snippets: string): string {
  return [
    '你是一个文献库问答助手。',
    '请仅根据提供的文献片段回答问题；如果证据不足，请明确说明。',
    '回答时尽量引用文献标题作为依据来源。',
    '',
    `问题：${question}`,
    '',
    '文献片段：',
    snippets
  ].join('\n')
}

function buildSemanticPromptClean(keyword: string): string {
  return [
    '你是一个学术文献检索词扩展助手。',
    '请把用户检索词扩展成严格 JSON，格式必须为：{"keywords":[],"synonyms":[],"related":[]}',
    '每个数组最多返回 6 个短词，避免过泛、避免编造专名。',
    '扩展词必须能直接帮助全文检索；不要返回单字词，除非用户原词就是单字。',
    '如果用户输入是明确关键词，keywords 只保留原词和最直接的同义表达。',
    '',
    `检索词：${keyword}`,
  ].join('\n')
}

function buildAiSearchPlanPromptClean(prompt: string): string {
  return [
    '你是 GujiSmart 文献库的 AI 检索规划器。',
    '请把用户的自然语言研究需求拆解成可执行的本地文献检索计划。只输出 JSON，不要输出解释。',
    'JSON 格式必须为：',
    '{"intent":"","keywords":[],"expandedKeywords":[],"excludeKeywords":[],"inferredFilters":{"docType":"","author":"","dynasty":"","yearFrom":null,"yearTo":null},"notes":""}',
    '要求：',
    '1. keywords 是最核心、最可能直接命中的短语，最多 6 个。',
    '2. expandedKeywords 是同义词、近义词、历史称谓或常见相关表达，最多 10 个。',
    '3. 不要返回单字词，除非用户原词就是单字；不要把泛泛主题词当作扩展词。',
    '4. 如果用户限定朝代、年份、作者、文献类型，请填入 inferredFilters；没有明确限定则留空或 null。',
    '5. 不要编造不存在的文献标题或页码，只规划检索词。',
    '6. 例如“偷窃”可扩展为“盗窃”“窃盗”“偷盗”“盗取”；不要扩展到“殖民”“交通”这类上下文噪声。',
    '7. 如果用户是在要求综述、总结、趋势、脉络、空白、难点或研究方向，这些是分析任务词，不要放入 keywords 或 expandedKeywords；应提取真正的研究对象、时期、地域、制度、人物、机构和材料类型作为检索词。',
    '8. 不要因为用户说“综述”就优先查找标题含“综述/述评/研究进展”的文章；除非用户明确说只要综述类文献。',
    '',
    `用户需求：${prompt}`,
  ].join('\n')
}

function buildLibraryQaPromptClean(question: string, snippets: string): string {
  return [
    '你是一个文献库问答助手。',
    '请只根据提供的文献片段回答问题；如果证据不足，请明确说明“证据不足”。',
    '回答时尽量引用文献标题、页码或片段编号作为依据，不要编造来源。',
    '',
    `问题：${question}`,
    '',
    '文献片段：',
    snippets,
  ].join('\n')
}

function buildLayoutReadingPagePrompt(text: string, options?: AiTaskOptions & { punctuationDensity?: number; likelyClassical?: boolean; pageNum?: number | string }): string {
  const punctuationDensity = Number(options?.punctuationDensity || 0)
  const likelyClassical = Boolean(options?.likelyClassical)
  const punctuationMode = likelyClassical || punctuationDensity < 0.018
    ? '当前文本疑似未句读或句读很少，请把断句与标点作为一个整体任务处理。'
    : '当前文本已有一定句读，请以清理版式、合并断行和保留原有句读为主，只做必要补充。'
  return [
    '你是古籍、地方志、历史文献和 OCR 文本的句读排版助手。',
    '任务边界：只做阅读排版、断句、补点号和自然段整理；不翻译，不概括，不增删事实，不改写人名、地名、官职、书名、年代、数量和专有名词。',
    punctuationMode,
    '处理流程（只在内部执行，不要输出流程说明）：',
    '1. 先识别结构：标题、卷次、章节名、正文、注文、脚注、表格、页眉页脚。',
    '2. 再一体化处理断句和点号：根据语义、虚词、并列结构、转折承接、时间地点人物关系，决定句读位置。',
    '3. 最后检查：不改变原字序，不丢字，不新增材料；只删除明显重复的页眉页脚或 OCR 噪声。',
    '标点规则：',
    '1. 古籍句读以点号为主，只使用：。 ， 、 ； ： ？ ！',
    '2. 不要主动添加书名号、引号、括号、破折号、省略号；原文已有则保留。',
    '3. 逗号用于句中停顿，顿号用于并列词组，分号用于并列分句，冒号用于“曰/云/谓/按/注”等引出语。',
    '4. 无把握处宁可少标点，不要密集加逗号；每个自然段通常 2 到 6 句。',
    '版式规则：',
    '1. 合并被 OCR 或页面宽度硬切开的短行，按语义整理为自然段。',
    '2. 标题、卷次、章节名独立成行；正文另起自然段，正文不要整段加粗标记。',
    '3. 表格能确定行列时用 Markdown 表格；不能确定表格结构时保留逐行文本。',
    '4. 脚注以独立段落保留，形如“[1] ...”或“注：...”，不要混入正文。',
    '5. 页眉、页脚、重复书名、重复卷名如果只是版心信息，请单独成行或去重，不要插入正文句子中。',
    '6. 不要把普通正文强行改成表格；只有原文确有横纵对应关系、课程/数值/栏目等单元格时才输出 Markdown 表格。',
    '7. 表格前后各保留一个空行，表头和分隔行必须完整，避免阅读器无法识别。',
    '输出限制：只输出重排后的正文，不输出解释、前言、说明、JSON 或 Markdown 代码块。',
    '',
    `页码：${options?.pageNum || ''}`,
    '原文：',
    `"""${text.slice(0, 1600)}"""`,
  ].join('\n')
}

function buildCitationTemplateInferencePrompt(sampleText: string, preferredFormatType?: string): string {
  const placeholders = Object.entries(CITATION_PLACEHOLDER_LABELS)
    .map(([key, label]) => `- ${key}: ${label}`)
    .join('\n')

  const formatTypes = [...CITATION_FORMAT_ORDER, 'GB-T7714', 'APA', 'MLA', 'Chicago', 'Custom']
    .map((key) => `- ${key}: ${CITATION_FORMAT_LABELS[key] || key}`)
    .join('\n')

  return [
    '你是一个学术引用格式模板提取助手。',
    '请根据用户提供的一条“已经确认正确”的引用示例，反推出可复用的模板。',
    '保留示例中的标点、顺序、连接词和版式，仅将可变信息替换为占位符。',
    '',
    '只允许使用以下占位符，格式必须是 {{field}}：',
    placeholders,
    '',
    '可选的格式类型如下：',
    formatTypes,
    '',
    `用户偏好的格式类型：${preferredFormatType || '未指定'}`,
    '',
    '请返回严格 JSON，字段如下：',
    '{"nameSuggestion":"","formatType":"","templateText":"","notes":""}',
    '',
    '要求：',
    '1. templateText 必须可直接用于系统模板。',
    '2. 不要发明列表之外的占位符。',
    '3. 无法确定的固定文本保持原样。',
    '4. 如果判断不准，notes 里简短说明。',
    '',
    `示例引用：${sampleText.trim()}`,
  ].join('\n')
}

function getLlmTemperature(provider: string, model: string, baseUrl: string): number {
  const signature = `${provider} ${model} ${baseUrl}`.toLowerCase()
  if (signature.includes('moonshot') || signature.includes('kimi')) {
    return 1
  }
  return 0.1
}

function getLlmErrorMessage(data: unknown, response: Response): string {
  return getResponseErrorMessage(data, response.statusText || 'Unknown error')
}

function getCompatibleRetryBody(body: JsonRecord, errorMessage: string): JsonRecord | null {
  const message = errorMessage.toLowerCase()
  const next = { ...body }
  let changed = false

  if (message.includes('temperature')) {
    if (next.temperature !== 1) {
      next.temperature = 1
    } else {
      delete next.temperature
    }
    changed = true
  }

  if (
    message.includes('unsupported parameter') ||
    message.includes('unknown parameter') ||
    message.includes('unrecognized parameter') ||
    message.includes('invalid parameter')
  ) {
    for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) {
      if (key in next) {
        delete next[key]
        changed = true
      }
    }
  }

  return changed ? next : null
}

export async function callLLM(messages: ChatMessage[]): Promise<string> {
  const apiKey = String(queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_api_key'")?.value || '').trim()
  const baseUrl = String(queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_base_url'")?.value || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const model = String(queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_model'")?.value || 'deepseek-chat').trim()
  const provider = String(queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_provider'")?.value || 'AI').trim()

  if (!apiKey) {
    throw new Error(`未配置 ${provider} API Key，请在设置中填写或切换 AI 服务商。`)
  }

  const requestBody: JsonRecord = {
    model,
    messages,
    temperature: getLlmTemperature(provider, model, baseUrl),
  }

  const requestOnce = async (body: JsonRecord): Promise<{ response: Response; data: LlmResponse }> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let data: LlmResponse = {}
      try {
        const parsed = text ? JSON.parse(text) as unknown : {}
        data = isJsonRecord(parsed) ? parsed as LlmResponse : {}
      } catch {
        data = { error: { message: text || response.statusText } }
      }
      return { response, data }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new Error(`${provider} AI 请求超时，请稍后重试或切换到更快的 AI 服务商。`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  let { response, data } = await requestOnce(requestBody)
  if (!response.ok || data.error) {
    const retryBody = getCompatibleRetryBody(requestBody, getLlmErrorMessage(data, response))
    if (retryBody) {
      const retry = await requestOnce(retryBody)
      response = retry.response
      data = retry.data
    }
  }

  if (!response.ok || data.error) {
    throw new Error(`${provider} LLM 请求失败: ${getLlmErrorMessage(data, response)}`)
  }

  return String(data.choices?.[0]?.message?.content || '')
}

export async function callLLMStream(
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
): Promise<string> {
  const apiKey = String(queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_api_key'")?.value || '').trim()
  const baseUrl = String(queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_base_url'")?.value || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const model = String(queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_model'")?.value || 'deepseek-chat').trim()
  const provider = String(queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'llm_provider'")?.value || 'AI').trim()

  if (!apiKey) {
    throw new Error(`未配置 ${provider} API Key，请在设置中填写或切换 AI 服务商。`)
  }

  const requestBody: JsonRecord = {
    model,
    messages,
    temperature: getLlmTemperature(provider, model, baseUrl),
    stream: true,
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(`${provider} LLM 流式请求失败: ${text || response.statusText}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || !line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content ?? ''
          if (!delta) continue
          fullText += delta
          onDelta(delta)
        } catch {
          // Ignore malformed SSE keepalive chunks.
        }
      }
    }

    return fullText
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new Error(`${provider} AI 请求超时，请稍后重试或切换到更快的 AI 服务商。`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function classifyDocument(ocrText: string): Promise<string> {
  const result = (await callLLM([{ role: 'user', content: buildClassificationPrompt(ocrText) }])).trim()
  return CLASSIFIABLE_TYPES.includes(result) ? result : '其他'
}

export async function detectCitationFormat(ocrText: string): Promise<string> {
  const result = (await callLLM([{ role: 'user', content: buildCitationPrompt(ocrText) }])).trim()
  return ['GB-T7714', 'APA', 'MLA', 'Chicago'].includes(result) ? result : '其他'
}

export async function extractMetadata(ocrText: string, docType: string): Promise<DocumentMetadataResult> {
  const prompt = buildMetadataPrompt(docType, ocrText)
  const result = await callLLM([{ role: 'user', content: prompt }])
  try {
    return sanitizeExtractedMetadata(parseJsonObject(result))
  } catch (error) {
    console.error('[AI] Failed to parse metadata JSON', error)
    return {}
  }
}

function metadataToCandidates(
  metadata: JsonRecord,
  source: string,
  evidencePage?: number | null
): MetadataCandidateDraft[] {
  const candidates: MetadataCandidateDraft[] = []
  for (const [field, value] of Object.entries(metadata)) {
    if (field.startsWith('_')) continue
    if (Array.isArray(value)) {
      const normalized = normalizeListValue(value)
      if (normalized.length === 0) continue
      candidates.push({
        field_name: field,
        candidate_value: JSON.stringify(normalized),
        source,
        confidence: field === 'keywords' ? 0.78 : 0.72,
        evidence_page: evidencePage,
        evidence_text: null
      })
      continue
    }

    const normalized = normalizeScalarValue(value)
    if (!normalized) continue
    let confidence = 0.72
    if (field === 'title' || field === 'author') confidence = 0.82
    if (field === 'doi' || field === 'isbn' || field === 'issn') confidence = 0.95
    candidates.push({
      field_name: field,
      candidate_value: normalized,
      source,
      confidence,
      evidence_page: evidencePage,
      evidence_text: null
    })
  }

  return candidates
}

function dedupeCandidates(candidates: MetadataCandidateDraft[]): MetadataCandidateDraft[] {
  const map = new Map<string, MetadataCandidateDraft>()
  for (const candidate of candidates) {
    const key = `${candidate.field_name}::${candidate.candidate_value}`
    const existing = map.get(key)
    if (!existing || existing.confidence < candidate.confidence) {
      map.set(key, candidate)
    }
  }
  return [...map.values()]
}

function getBestCandidateByField(candidates: MetadataCandidateDraft[]): Map<string, MetadataCandidateDraft> {
  const best = new Map<string, MetadataCandidateDraft>()
  for (const candidate of candidates) {
    const current = best.get(candidate.field_name)
    if (!current || current.confidence < candidate.confidence) {
      best.set(candidate.field_name, candidate)
    }
  }
  return best
}

function parseCandidateValue(fieldName: string, candidateValue: string): unknown {
  if (fieldName === 'keywords') {
    const list = safeJsonParse<string[] | null>(candidateValue, null)
    return Array.isArray(list) ? list : normalizeListValue(candidateValue)
  }
  return candidateValue
}

export async function suggestTags(docId: string): Promise<AiTagSuggestion[]> {
  const doc = queryOne<{ doc_type: string; metadata: string }>('SELECT doc_type, metadata FROM documents WHERE id = ?', [docId])
  if (!doc) return []
  const metadata = getMetadataObject(doc)
  return collectMetadataTagValues(metadata, doc.doc_type).map((item) => ({
    name: item.name,
    color: FIELD_TAG_COLORS[item.sourceField] || '#52c41a',
    confidence: item.confidence
  }))
}

export async function autoTagFromMetadata(docId: string, metadata: JsonRecord, docType: string): Promise<void> {
  syncDocumentMetadataTags(docId, metadata, docType)
}

function saveMetadataCandidates(docId: string, candidates: MetadataCandidateDraft[]): void {
  transaction(() => {
    run('DELETE FROM metadata_candidates WHERE doc_id = ? AND accepted = 0', [docId])
    const now = new Date().toISOString()
    for (const candidate of dedupeCandidates(candidates)) {
      run(
        `INSERT INTO metadata_candidates (
          id, doc_id, field_name, candidate_value, source, confidence, evidence_page, evidence_text,
          accepted, rejected, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        [
          nanoid(),
          docId,
          candidate.field_name,
          candidate.candidate_value,
          candidate.source,
          candidate.confidence,
          candidate.evidence_page ?? null,
          candidate.evidence_text ?? null,
          now,
          now
        ]
      )
    }
  })
  saveDatabase()
}

export function getMetadataCandidates(docId: string): MetadataCandidate[] {
  return queryAll<MetadataCandidate>(
    'SELECT * FROM metadata_candidates WHERE doc_id = ? ORDER BY accepted ASC, rejected ASC, confidence DESC, created_at DESC',
    [docId]
  )
}

function recomputeMetadataStatus(docId: string): void {
  const unresolved = queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM metadata_candidates WHERE doc_id = ? AND accepted = 0 AND rejected = 0',
    [docId]
  )
  const accepted = queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM metadata_candidates WHERE doc_id = ? AND accepted = 1',
    [docId]
  )

  const nextStatus = (unresolved?.count || 0) > 0
    ? 'review'
    : (accepted?.count || 0) > 0
      ? 'confirmed'
      : 'pending'

  run('UPDATE documents SET metadata_status = ?, updated_at = ? WHERE id = ?', [nextStatus, new Date().toISOString(), docId])
}

function isFallbackImportedTitle(title: string | null | undefined, filePath?: string | null): boolean {
  const normalizedTitle = normalizeScalarValue(title)
  if (!normalizedTitle || normalizedTitle === '未命名文献') {
    return true
  }

  if (!filePath) {
    return false
  }

  const fileTitle = basename(filePath, extname(filePath)).trim()
  return fileTitle.length > 0 && normalizedTitle === fileTitle
}

function applyCandidateToDocument(docId: string, fieldName: string, candidateValue: string): void {
  const doc = queryOne<{ title: string; file_path: string | null; author: string | null; dynasty: string | null; source: string | null; doc_type: string; metadata: string }>(
    'SELECT title, file_path, author, dynasty, source, doc_type, metadata FROM documents WHERE id = ?',
    [docId]
  )
  if (!doc) return

  const metadata = getMetadataObject(doc)
  const parsedValue = parseCandidateValue(fieldName, candidateValue)

  switch (fieldName) {
    case 'title':
      if (isFallbackImportedTitle(doc.title, doc.file_path)) {
        run('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?', [parsedValue, new Date().toISOString(), docId])
      }
      return
    case 'author':
      if (!doc.author || !doc.author.trim()) {
        run('UPDATE documents SET author = ?, updated_at = ? WHERE id = ?', [parsedValue, new Date().toISOString(), docId])
      }
      return
    case 'dynasty':
      if (!doc.dynasty || !doc.dynasty.trim()) {
        run('UPDATE documents SET dynasty = ?, updated_at = ? WHERE id = ?', [parsedValue, new Date().toISOString(), docId])
      }
      return
    case 'source':
      if (!doc.source || !doc.source.trim()) {
        run('UPDATE documents SET source = ?, updated_at = ? WHERE id = ?', [parsedValue, new Date().toISOString(), docId])
      }
      return
    case 'doc_type':
    case '_doc_type':
      {
        const nextDocType = normalizeHistoryDocType(String(parsedValue || '其他'))
        if (!doc.doc_type || doc.doc_type === 'unknown' || doc.doc_type === '其他' || normalizeHistoryDocType(doc.doc_type) !== nextDocType) {
          run('UPDATE documents SET doc_type = ?, updated_at = ? WHERE id = ?', [nextDocType, new Date().toISOString(), docId])
        }
      }
      return
    default:
      if (metadata[fieldName] === undefined || metadata[fieldName] === null || metadata[fieldName] === '') {
        metadata[fieldName] = parsedValue
        run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(metadata), new Date().toISOString(), docId])
      }
  }
}

function syncCurrentDocumentMetadataTags(docId: string): void {
  const doc = queryOne<{ author: string | null; dynasty: string | null; source: string | null; doc_type: string; metadata: string }>(
    'SELECT author, dynasty, source, doc_type, metadata FROM documents WHERE id = ?',
    [docId],
  )
  if (!doc) return
  syncDocumentMetadataTags(docId, getMetadataObject(doc), normalizeHistoryDocType(doc.doc_type), {
    author: doc.author,
    dynasty: doc.dynasty,
    source: doc.source,
  })
}

export function acceptMetadataCandidate(candidateId: string): boolean {
  const candidate = queryOne<MetadataCandidate>('SELECT * FROM metadata_candidates WHERE id = ?', [candidateId])
  if (!candidate) return false

  transaction(() => {
    applyCandidateToDocument(candidate.doc_id, candidate.field_name, candidate.candidate_value)
    run('UPDATE metadata_candidates SET accepted = 1, rejected = 0, updated_at = ? WHERE id = ?', [new Date().toISOString(), candidateId])
    recomputeMetadataStatus(candidate.doc_id)
  })

  syncCurrentDocumentMetadataTags(candidate.doc_id)
  saveDatabase()
  return true
}

export function rejectMetadataCandidate(candidateId: string): boolean {
  const candidate = queryOne<MetadataCandidate>('SELECT * FROM metadata_candidates WHERE id = ?', [candidateId])
  if (!candidate) return false

  transaction(() => {
    run('UPDATE metadata_candidates SET rejected = 1, accepted = 0, updated_at = ? WHERE id = ?', [new Date().toISOString(), candidateId])
    recomputeMetadataStatus(candidate.doc_id)
  })

  saveDatabase()
  return true
}

function mergeMetadataResults(target: JsonRecord, next: JsonRecord): JsonRecord {
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length > 0 && (!Array.isArray(target[key]) || target[key].length === 0)) {
      target[key] = value
      continue
    }
    if (!Array.isArray(value)) {
      const normalized = normalizeScalarValue(value)
      if (normalized && !target[key]) {
        target[key] = normalized
      }
    }
  }
  return target
}

export async function extractMetadataStaged(docId: string): Promise<DocumentMetadataResult> {
  const pages = getPageTexts(docId)
  if (pages.length === 0) return {}

  const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [docId])
  const currentMetadata = doc ? getMetadataObject(doc) : {}
  const firstPagesText = pages.slice(0, 3).map((page) => page.text).join('\n')
  const lastPagesText = pages.slice(-2).map((page) => page.text).join('\n')
  const identifierText = [doc?.title || '', firstPagesText, lastPagesText].join('\n')
  const identifiers = extractIdentifiers(identifierText)

  let docType = normalizeHistoryDocType(doc?.doc_type || '其他')
  if (!docType || docType === 'unknown' || docType === '其他') {
    try {
      docType = normalizeHistoryDocType(await classifyDocument(firstPagesText))
    } catch {
      docType = '其他'
    }
  }

  let citationFormat = '其他'
  try {
    citationFormat = await detectCitationFormat(firstPagesText)
  } catch {
    citationFormat = '其他'
  }

  const lookupCandidates = await lookupIdentifiers(identifiers)
  const mergedMetadata: JsonRecord = { ...currentMetadata }
  for (const candidate of lookupCandidates) {
    const parsed = parseCandidateValue(candidate.field_name, candidate.candidate_value)
    if (!mergedMetadata[candidate.field_name]) {
      mergedMetadata[candidate.field_name] = parsed
    }
  }

  for (const stage of [1, 2, 3]) {
    const selectedPages = selectPagesByStage(pages, stage)
    if (selectedPages.length === 0) continue

    const combinedText = selectedPages.map((page) => page.text).join('\n')
    try {
      const metadata = await extractMetadata(combinedText, docType)
      mergeMetadataResults(mergedMetadata, metadata)
      const filledCoreFields = ['title', 'author', 'abstract', 'publication_year', 'journal', 'doi']
        .filter((field) => mergedMetadata[field])
        .length
      if (filledCoreFields >= 4) break
    } catch (error) {
      console.error('[AI] Staged metadata extraction failed', error)
    }
  }

  mergedMetadata._doc_type = docType
  mergedMetadata._citation_format = citationFormat
  for (const [field, value] of Object.entries(identifiers)) {
    if (value && !mergedMetadata[field]) {
      mergedMetadata[field] = value
    }
  }

  return sanitizeExtractedMetadata(mergedMetadata)
}

export async function autoExtractAndApply(docId: string): Promise<DocumentMetadataResult> {
  const metadata = await extractMetadataStaged(docId)
  if (!metadata || Object.keys(metadata).length === 0) {
    throw new Error('未能提取到有效元数据，请先完成 OCR 识别')
  }

  const docType = normalizeHistoryDocType(normalizeScalarValue(metadata._doc_type) || '其他')
  const llmCandidates = metadataToCandidates(metadata, 'llm', 1)
  const identifierCandidates = await lookupIdentifiers(extractIdentifiers(JSON.stringify(metadata)))
  const allCandidates = dedupeCandidates([
    ...identifierCandidates,
    ...llmCandidates,
    {
      field_name: '_doc_type',
      candidate_value: docType,
      source: 'llm',
      confidence: 0.86
    }
  ])

  const bestByField = getBestCandidateByField(allCandidates)
  const resolvedCandidates = [...bestByField.values()]
  const now = new Date().toISOString()

  transaction(() => {
    run('DELETE FROM metadata_candidates WHERE doc_id = ?', [docId])
    for (const candidate of resolvedCandidates) {
      if (candidate.field_name === 'title') continue
      applyCandidateToDocument(docId, candidate.field_name, candidate.candidate_value)
    }

    run(
      "UPDATE documents SET doc_type = CASE WHEN doc_type = 'unknown' OR doc_type = '其他' OR doc_type = '论文' OR doc_type = '期刊' OR doc_type = '学术论文' OR doc_type = '古籍' THEN ? ELSE doc_type END, metadata_status = ?, updated_at = ? WHERE id = ?",
      [docType, 'auto', now, docId]
    )
  })

  await autoTagFromMetadata(docId, metadata, docType)
  saveDatabase()

  return metadata
}

export async function reclassifyAndApplyDocument(docId: string): Promise<DocumentMetadataResult> {
  const pages = getPageTexts(docId)
  if (pages.length === 0) {
    throw new Error('没有可用于复核的 OCR/文本内容')
  }

  const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [docId])
  if (!doc) {
    throw new Error('文献不存在')
  }

  const sampleText = [
    pages.slice(0, 4).map((page) => page.text).join('\n'),
    pages.slice(-2).map((page) => page.text).join('\n'),
  ].join('\n')
  const docType = normalizeHistoryDocType(await classifyDocument(sampleText))
  const metadata = await extractMetadata(sampleText, docType)
  const currentMetadata = getMetadataObject(doc)
  const mergedMetadata = mergeMetadataResults({ ...currentMetadata }, metadata)
  mergedMetadata._doc_type = docType

  const now = new Date().toISOString()
  transaction(() => {
    run('DELETE FROM metadata_candidates WHERE doc_id = ?', [docId])
    run(
      'UPDATE documents SET doc_type = ?, metadata = ?, metadata_status = CASE WHEN metadata_status = ? THEN metadata_status ELSE ? END, updated_at = ? WHERE id = ?',
      [docType, JSON.stringify(mergedMetadata), 'confirmed', 'auto', now, docId],
    )
  })

  await autoTagFromMetadata(docId, mergedMetadata, docType)
  saveDatabase()
  return mergedMetadata
}

export async function synthesizeDocuments(
  texts: Array<{ title: string; text: string; docId?: string }>,
  templateType: AiSynthesisTemplate,
  customPrompt?: string
): Promise<string> {
  const docIds = texts.map((item) => item.docId).filter((id): id is string => !!id)
  if (docIds.length > 0) {
    return synthesizeDocumentIds(docIds, templateType, customPrompt)
  }

  const docList = texts
    .map((item, index) => `【文献 ${index + 1}】${item.title}\n${item.text.slice(0, 2000)}`)
    .join('\n\n---\n\n')

  let systemPrompt = '请对以下文献进行综合分析。先形成总体判断，再分主题归纳，不要按文献顺序逐篇复述。'
  switch (templateType) {
    case 'literature_review':
      systemPrompt = '你是一位专业的文献综述作者。请先综合这些文献共同呈现的研究格局，再梳理研究脉络、关键议题、方法差异、争议点与可突破的研究空白。不要把输出写成“第1篇、第2篇”的逐篇摘要。'
      break
    case 'summary':
      systemPrompt = '请生成一份跨文献综合摘要。重点提炼这些文献共同说明了什么、彼此如何补充或冲突，以及当前材料仍缺什么；只在必要时点名代表性文献。'
      break
    case 'theme_analysis':
      systemPrompt = '请按主题组织分析，提炼共同主题、关键争议、观点分歧和相互关系。每个主题下综合多篇材料，不要机械罗列文献清单。'
      break
    case 'timeline':
      systemPrompt = '请将这些文献涉及的观点、事件、制度或研究问题整理成时间线式综述。按阶段解释变化逻辑，并指出每个阶段的证据强弱。'
      break
    case 'custom':
      systemPrompt = customPrompt || systemPrompt
      break
  }

  return callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `以下是需要综合分析的文献内容：\n\n${docList}` }
  ])
}

export async function synthesizeDocumentIds(
  docIds: string[],
  templateType: AiSynthesisTemplate,
  customPrompt?: string
): Promise<string> {
  return (await synthesizeDocumentIdsWithSources(docIds, templateType, customPrompt)).markdown
}

export async function synthesizeDocumentIdsWithSources(
  docIds: string[],
  templateType: AiSynthesisTemplate,
  customPrompt?: string
): Promise<AiSynthesisResult> {
  const templatePrompts: Partial<Record<AiSynthesisTemplate, string>> = {
    literature_review: '你是专业文献综述助手。请基于文献卡片和可引用证据，写一份真正的跨文献综述：先给总体判断，再分主题/阶段梳理研究脉络、核心观点、分歧、材料互证关系、方法特点和研究空白。',
    summary: '请生成跨文献综合摘要。重点说明这些文献合在一起揭示了什么问题、形成了哪些共识或分歧、哪些材料最能支撑判断，以及后续阅读应优先补哪些证据；不要逐篇概括。',
    theme_analysis: '请提炼共同主题、关键争议、观点异同和文献之间的互证/冲突关系。按主题组织段落，每段综合多篇文献。',
    evidence_table: '请生成 Markdown 证据表格，列包括：问题/主题、文献、页码或章节、观点、时间、机构/人物、政策/教育内容、原文证据、可信度、待补证据。每个结论都必须带页码或章节；没有证据的格子写“证据不足”。',
    timeline: '请按时间线或发展阶段组织材料，说明观点、事件、制度或材料变化。每个阶段都要解释变化逻辑和证据来源。',
    custom: customPrompt || '请根据材料生成综合分析。',
  }
  const intent = templatePrompts[templateType] || templatePrompts.literature_review || '请根据材料生成综合分析。'
  const context = await buildAiContextForDocuments(docIds, customPrompt ? `${intent}\n${customPrompt}` : intent)
  if (context.briefs.length === 0) {
    throw new Error('选中的文献中没有可用文本，请先完成 OCR、导入 TXT/EPUB，或检查文献内容。')
  }

  const systemPrompt = [
    intent,
    '必须使用中文输出。',
    '先回答“这些材料总体说明了什么”，再展开论证。除非用户明确要求，不要按检索命中或文献顺序逐篇复述。',
    '请把当前材料称为“当前收集/选中范围内的文献”，不要直接宣称它们代表整个学界或全部研究现状。',
    '输出建议包含：总体判断、研究脉络或阶段、主题/方法分布、关键分歧、研究空白与可突破方向。',
    '优先使用“可引用证据”支持具体结论；涉及具体观点、事实、比较或判断时，标注来源，格式为“（文献标题，第 X 页/节）”。',
    '文献卡片用于全局理解，不要把文献卡片当作原文逐字引用。',
    '如果证据不足，请明确写出“证据不足”，不要编造。',
  ].join('\n')

  const markdown = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: context.prompt },
  ])
  const sources: EvidenceQaSource[] = context.evidence.slice(0, 16).map((item, index) => ({
    doc_id: item.doc_id,
    doc_title: item.doc_title,
    page_num: item.page_num || null,
    snippet: item.snippet,
    rank: index,
    matched_query: 'AI 综合分析',
    source_hash: hashPrompt(item.doc_id, String(item.page_num || ''), item.snippet),
  }))

  return { markdown, sources }
}

export async function runAiTask(taskType: AiTaskType, text: string, options?: AiTaskOptions): Promise<string> {
  const normalizedTaskType = String(taskType || '').trim() as AiTaskType
  let prompt = ''
  const compactText = text.replace(/\r/g, '').trim()
  const glossaryPrompt = normalizedTaskType === 'translate'
    ? getActiveTranslationGlossary({ text: compactText, projectId: options?.glossaryProjectId }).promptBlock
    : ''

  switch (normalizedTaskType) {
    case 'summary': {
      const length = options?.length || '200 字左右'
      prompt = `请为以下文献内容生成一份中文摘要，长度约 ${length}。只输出摘要本身，不要解释。\n\n"""${compactText.slice(0, 4000)}"""`
      break
    }
    case 'translate': {
      const translationStyle = String(options?.translationStyle || DEFAULT_TRANSLATION_STYLE)
      const translationMode = String(options?.translationMode || 'balanced')
      const contextLines = [
        options?.documentTitle ? `Document title: ${String(options.documentTitle).slice(0, 120)}` : '',
        options?.pageNum ? `Page: ${options.pageNum}` : '',
        options?.pageContextBefore ? `Previous page context for consistency only:\n"""${String(options.pageContextBefore).slice(0, 500)}"""` : '',
        options?.pageContextAfter ? `Next page context for consistency only:\n"""${String(options.pageContextAfter).slice(0, 500)}"""` : '',
      ].filter(Boolean)
      const stylePrompt = [
        `Translation style: ${translationStyle}.`,
        'Translate into accurate, natural, readable modern Chinese suitable for scholarly reading.',
        'Keep terminology consistent across the document, especially names, offices, titles, places, dates, editions, and cited works.',
        'Preserve names, dates, titles, citations, note markers, lists, and table structure where meaningful.',
        'Do not add explanation, commentary, summaries, markdown fences, or unsupported details. Do not omit source meaning.',
      ]
      const sharedPromptParts = [
        ...stylePrompt,
        ...(contextLines.length ? ['', 'Document context:', ...contextLines] : []),
        ...(glossaryPrompt ? ['', glossaryPrompt] : []),
      ]
      if (options?.translationUnits) {
        const reviewDraft = String(options?.previousTranslation || '').trim()
        prompt = [
          ...sharedPromptParts,
          '',
          options?.translationReview
            ? 'Review and correct the following page translation into accurate, fluent modern Chinese.'
            : 'Translate the following page units into accurate, fluent modern Chinese.',
          'Read all units together for page-level context, but return every unit separately using its exact ID.',
          'The unit IDs are application data. They must be copied exactly and must never be translated or renumbered.',
          'Rules:',
          '1. Output exactly one line for every input unit, in the same order.',
          '2. Every line must begin with the exact marker, for example [tu_ab12cd34].',
          '3. Do not merge, split, omit, invent, explain, summarize, or add markdown fences.',
          '4. Preserve placeholders such as __GS_PH_0000__ exactly. Never translate or delete them.',
          '5. Keep names, dates, numbers, citations, note markers, and terminology accurate and consistent.',
          '6. Translate foreign language, classical Chinese, old-style Chinese, and mixed-language prose into readable modern Chinese.',
          '7. Put only the current unit translation after its marker, even when context comes from adjacent units.',
          `Mode: ${translationMode}.`,
          '',
          `Unit count: ${options?.segmentCount || ''}`,
          'Source units:',
          `"""${compactText.slice(0, 12000)}"""`,
          ...(options?.translationReview
            ? ['', 'Current translation draft:', `"""${reviewDraft.slice(0, 12000)}"""`]
            : []),
        ].join('\n')
        break
      }
      if (options?.parallelSegments) {
        const repairDraft = String(options?.previousTranslation || options?.alignmentRepairText || '').trim()
        if (options?.parallelAlignmentRepair) {
          prompt = [
            ...sharedPromptParts,
            '',
            'Repair the following malformed side-by-side translation into strict sentence-level alignment.',
            'The source input already contains the exact numbered units. The draft translation may be merged, unnumbered, incomplete, or grouped incorrectly.',
            'Your job is to redistribute the draft meaning back onto the source units. If the draft does not cover a unit, translate that source unit directly.',
            'Rules:',
            '1. Output exactly one line for each source unit.',
            '2. Every output line must begin with its exact marker, such as [S001], [S002], in the same order.',
            '3. Do not merge, split, skip, renumber, explain, summarize, or add markdown fences.',
            '4. The first non-empty output line must start with [S001]. No prose before or after the numbered lines.',
            '5. Keep only the current unit\'s translation after each marker, even when the draft translation merges several units.',
            '',
            `Unit count: ${options?.segmentCount || ''}`,
            'Source units:',
            `"""${compactText.slice(0, 7200)}"""`,
            '',
            'Draft translation to realign:',
            `"""${repairDraft.slice(0, 7200)}"""`,
          ].join('\n')
          break
        }
        prompt = [
          ...sharedPromptParts,
          '',
          'Translate the following numbered sentence-level units into accurate, coherent modern Chinese.',
          'First read the whole page input for context and consistency. Then translate strictly one unit by one unit.',
          'Each numbered unit is one source sentence whenever possible; short headings, notes, list items, table rows, and vocabulary/commentary items also stay as independent units for the side-by-side reader.',
          'Rules:',
          '1. Output exactly one translated unit for each input unit.',
          '2. Preserve each unit marker exactly, such as [S001], [S002], and output them in the same order.',
          '3. Do not merge, split, skip, renumber, explain, summarize, or add markdown fences.',
          '4. Use adjacent units for context, but put only the current unit\'s translation after its own marker.',
          '5. If a unit is a partial sentence, fragment, vocabulary item, pronunciation note, or quoted example, translate or gloss that unit naturally without pulling content from another unit.',
          '6. Translate Japanese kana, romanized text, classical Chinese, old-style Chinese, dialectal wording, and mixed-language fragments into modern Chinese whenever the unit is part of the passage meaning.',
          '7. Do not copy a source unit unchanged. Only proper nouns, book titles, dates, citation markers, code, or intentionally quoted phrases may remain unchanged.',
          '8. If a unit is already mostly modern Chinese, still provide a clean modern-Chinese rendering; keep the meaning, but remove OCR noise and old/foreign wording where possible.',
          '9. Preserve names, dates, citations, note markers, and table/list structure inside the same numbered unit.',
          '10. Keep terminology consistent across adjacent units without changing the one-unit-to-one-unit alignment.',
          '11. The first non-empty output line must start with [S001]. Every following non-empty line must start with the next [S###] marker. Output is invalid without these markers.',
          '',
          `Unit count: ${options?.segmentCount || ''}`,
          'Input:',
          `"""${compactText.slice(0, 7200)}"""`,
        ].join('\n')
        break
      }
      prompt = [
        ...sharedPromptParts,
        '',
        options?.onlyNonChinese
          ? 'Process the following mixed Chinese/non-Chinese text. Keep already-modern Chinese content unchanged except for necessary layout cleanup, and translate only non-Chinese fragments into natural, accurate Chinese.'
          : 'Translate the following foreign-language, classical, literary, or scholarly text into modern Chinese.',
        'After translation, format the output as readable Chinese prose: merge lines broken only by page width, break paragraphs by meaning, and keep headings, lists, notes, and tables when present.',
        'Output only the translated or processed main text.',
        '',
        'Source:',
        `"""${compactText.slice(0, options?.onlyNonChinese ? 2800 : 3200)}"""`,
      ].join('\n')
      break
    }
    case 'layout_reading_page':
      prompt = [
        '你是古籍和历史文献阅读器的排版助手。请只做阅读排版，不要翻译，不要概括，不要增删事实，不要改写人名、地名、书名、年代和专有名词。',
        '任务：把输入文本整理成适合阅读器显示的正文。',
        '要求：',
        '1. 合并被 OCR 或书页宽度硬切开的短行，按语义分成自然段。',
        '2. 如果原文缺少句读，请补上现代阅读所需的句读；如果已有句读，只做必要清理。',
        '3. 保留标题、卷次、章节名、列表、表格、注文、脚注等明显结构。',
        '4. 表格可用 Markdown 表格输出；不能确定表格结构时保留逐行文本。',
        '5. 不输出解释、前言、说明或 Markdown 代码块，只输出重排后的正文。',
        '6. 原文中疑似 OCR 错字不要擅自校改，除非只是明显重复噪声或空白问题。',
        '',
        `页码：${options?.pageNum || ''}`,
        '原文：',
        `"""${compactText.slice(0, 5200)}"""`,
      ].join('\n')
      break
    case 'keywords':
      prompt = `请从以下内容提取 5 到 8 个核心关键词，只返回逗号分隔的关键词，不要解释。\n\n"""${compactText.slice(0, 3500)}"""`
      break
    case 'qa': {
      const question = String(options?.question || '')
      const selectedText = String(options?.selectedText || '').trim()
      const strictArticleOnly = Boolean(options?.strictArticleOnly)
        || /只|仅|按照|根据|依据|文章里|文中|原文|本文|不要发挥|不要扩展/.test(question)
      prompt = strictArticleOnly
        ? `请只根据给定文章内容回答问题；如果文章中没有足够信息，请明确说“文中没有足够依据”。不要使用文章之外的知识。\n\n${selectedText ? `用户选中的文字：\n"""${selectedText.slice(0, 2000)}"""\n\n` : ''}文章全文：\n"""${text.slice(0, 8000)}"""\n\n问题：${question}`
        : `请结合用户选中的文字、整篇文章内容，并在必要时结合你已有的知识回答问题。回答时先解释与选中文字的关系，再给出清晰结论；如果文章本身能提供证据，请指出依据来自文章内容。\n\n${selectedText ? `用户选中的文字：\n"""${selectedText.slice(0, 2000)}"""\n\n` : ''}文章全文：\n"""${text.slice(0, 8000)}"""\n\n问题：${question}`
      break
    }
    case 'semantic_expansion':
      prompt = buildSemanticPrompt(text)
      break
    case 'ai_search_plan':
      prompt = buildAiSearchPlanPrompt(text)
      break
    case 'library_qa':
      prompt = buildLibraryQaPrompt(options?.question || text, options?.snippets || text)
      break
    case 'toc_extract':
      prompt = [
        'You are extracting a reader table of contents from a compact candidate package, not from the full book.',
        'Use only candidatePages, ruleToc, structureHints, headingHints, and explicit page/char anchors in the input.',
        'Do not invent a full-book TOC when evidence is missing. Return fewer high-confidence items instead of guessing.',
        'Prefer ruleToc entries when their titles and anchors look consistent. Use AI only to clean, merge, rank, and fill obvious missing hierarchy.',
        '你是文献目录整理助手。请根据候选目录页 OCR、规则识别目录和少量前置页面文本，整理出可用于阅读器导航的目录。',
        '只返回严格 JSON，不要解释，不要 Markdown 代码块。',
        'JSON 格式：{"items":[{"title":"章节标题","pageNum":123,"level":1,"confidence":0.0,"notes":""}]}',
        '要求：',
        '1. 优先保留目录页中真实出现的标题，不要发明不存在的章节。',
        '2. 如果标题被 OCR 截断或缺字，可根据上下文补全，但 confidence 不要高于 0.8。',
        '3. pageNum 必须是目录页中出现的页码或能从正文标题位置推断的页码；不能确定时填 null。',
        '4. level 用 1/2/3 表示卷、章、节等层级；不能判断时填 2。',
        '5. 最多返回 120 条，按阅读顺序排列。',
        '6. 如果输入 mode 是 no_toc_pages_use_structure_hints，说明没有找到可靠目录页；请把 structureHints 当作“智能结构导航”来整理，不要编造原书目录页。',
        '7. 古籍可以用卷、上下卷、序、跋、凡例、提要、题辞、篇章回等正文结构作为目录节点。',
        '同页锚点规则：返回项可以包含 anchorText、charIndex、anchorKey。若 candidatePages.headingHints 中有对应标题，必须复用 headingHints.charIndex；同一页报纸、古籍、长页必须依靠 charIndex 做页内跳转。',
        '不要编造 charIndex；只有从 headingHints 或正文标题位置能确定时才填写。只知道页码时可以只填 pageNum。',
        '',
        compactText.slice(0, 14000),
      ].join('\n')
      break
    case 'toc_bind':
      prompt = [
        '你是文献阅读器的目录定位助手。现在每个目录标题可能在正文中匹配到多个候选标题行，请判断哪一个才是真正的章节入口。',
        '只返回严格 JSON，不要解释，不要 Markdown 代码块。',
        'JSON 格式：{"bindings":[{"order":0,"candidateIndex":1,"confidence":0.0,"reason":""}]}',
        '判断规则：',
        '1. 一个目录标题在正文中通常只对应一个真正章节入口；如果同名标题出现多次，优先选择标题行后面紧接正文展开的位置。',
        '2. 不要选择摘要、目录页、引言综述中提到该标题的普通句子，除非该候选本身就是摘要/Abstract/关键词等前置章节标题。',
        '3. 尊重阅读顺序：相邻目录项的候选位置应大体从前到后排列。',
        '4. 如果无法判断，选择最可能的候选，并把 confidence 设低。',
        '5. 对输入中的每个 item 都必须返回一个 bindings 条目。',
        '6. 如果输入提供 candidates 的 source=occurrence，说明这是通过全文关键词命中找到的正文候选；请判断它是否是真正章节开头。',
        '7. 可在 reason 中写 previous/next/none，表示如果不是开头应向前、向后还是不继续找。',
        '',
        compactText.slice(0, 18000),
      ].join('\n')
      break
    case 'citation_template_infer':
      prompt = buildCitationTemplateInferencePrompt(text, typeof options?.formatType === 'string' ? options.formatType : undefined)
      break
    default:
      throw new Error(`不支持的 AI 任务类型: ${normalizedTaskType || taskType}`)
  }

  if (normalizedTaskType === 'layout_reading_page') {
    prompt = buildLayoutReadingPagePrompt(compactText, options)
  } else if (normalizedTaskType === 'semantic_expansion') {
    prompt = buildSemanticPromptClean(text)
  } else if (normalizedTaskType === 'ai_search_plan') {
    prompt = buildAiSearchPlanPromptClean(text)
  } else if (normalizedTaskType === 'library_qa') {
    prompt = buildLibraryQaPromptClean(options?.question || text, options?.snippets || text)
  }

  return callLLM([{ role: 'user', content: prompt }])
}
