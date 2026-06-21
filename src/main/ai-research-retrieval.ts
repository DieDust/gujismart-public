import { nanoid } from 'nanoid'
import { queryAll, queryOne, run, saveDatabase } from './database'
import { resolveFolderAndDescendantIds } from './folder-scope'
import type {
  AiResearchEvidenceItem,
  AiResearchEvidencePack,
  AiResearchFacetBucket,
  AiResearchQueryFacets,
  AiResearchQueryStat,
  AiResearchRetrievalPlan,
  AiResearchRetrievalPreviewPayload,
  AiResearchRetrievalRound,
  AiResearchRetrievalRunResult,
  AiResearchRetrievalStats,
  AiResearchTask,
  AiResearchTaskKind,
  LibraryAiScope,
  SearchHitLocator,
  SearchResult,
} from '../shared/types'

export const HIGH_FREQUENCY_HIT_THRESHOLD = 500
export const HIGH_FREQUENCY_DOC_THRESHOLD = 80
export const MAX_RETRIEVAL_ROUNDS = 10
export const RETRIEVAL_QUERIES_PER_ROUND = 8
export const EVIDENCE_PACK_LIMIT = 80
export const PER_QUERY_EVIDENCE_LIMIT = 20
export const PER_DOCUMENT_PAGE_LIMIT = 3
export const PER_PAGE_SNIPPET_LIMIT = 2

const MAX_QUERY_SEEDS = 16
const SAMPLE_ROW_LIMIT = 1000
const SQL_DOC_CHUNK_SIZE = 400
const SEARCH_TEXT_EXPR = "LOWER(COALESCE(NULLIF(s.normalized_text, ''), s.text, ''))"
const RESEARCH_QUERY_STOP_WORDS = new Set([
  '里面', '多少', '谈到', '提到', '涉及', '相关', '篇幅', '段落', '数量', '条目', '所有', '列出',
  '统计', '按照', '时间', '排序', '查找', '同时', '出现', '频率', '筛选', '重要', '评分', '分析',
  '摘要', '主题', '国家', '具体', '类型', '情感', '倾向', '研究', '文献', '材料', '数据', '抽取',
  '进行', '其中', '这些', '那些', '一个', '一种', '如何', '什么', '为什么', '以及', '或者', '可以',
  '次数', '频次', '章节', '页面', '正文', '原文', '检索', '线索', '方案', '字段', '文章', '资料',
  '比较', '提及', '列举', '寻找', '查找', '所有', '同时', '关联', '相关', '频率', '段落', '出现',
  '关键词', '不同', '分布', '趋势', '变化', '篇幅', '命中', '统计型', '抽取型', '综述型', '混合型',
  '的', '了', '和', '与', '及', '或', '在', '对', '中', '内', '为', '是', '有', '把', '将',
])
const RESEARCH_QUERY_TASK_PHRASES = [
  '同时出现', '出现次数', '出现频率', '出现篇幅', '提及次数', '提及频率', '关键词', '不同文献',
  '出现分布', '时间变化', '变化趋势', '相关篇幅', '相关时间', '相关地点', '有多少', '分别有多少',
  '统计', '比较', '提及', '谈到', '提到', '涉及', '查找', '寻找', '列举', '出现', '分布',
  '趋势', '变化', '篇幅', '频率', '次数', '数量', '段落', '章节', '页面', '如何', '多少',
  '这些', '所有', '其中', '不同', '相关', '关键词',
]
const HTML_CSS_NOISE_WORDS = new Set([
  'td', 'tr', 'th', 'div', 'span', 'table', 'tbody', 'thead', 'style', 'class', 'border', 'center',
  'align', 'valign', 'width', 'height', 'word', 'wrap', 'break', 'word-wrap', 'text-align', 'left',
  'right', 'font', 'size', 'color', 'margin', 'padding', 'nbsp', 'html', 'body', 'cellspacing',
  'cellpadding', 'colspan', 'rowspan', 'solid', 'none', 'block', 'inline', 'auto', 'breakword',
  'wordwrap', 'textalign',
])
const SPURIOUS_CJK_QUERY_FRAGMENTS = new Set(['本满', '洲中', '国朝'])
const CJK_QUERY_PARTICLES = /[的了着过和与及或在对中内为是有把将]+$/g
const COMPACT_HISTORICAL_QUERY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/日满中朝/g, '日本 满洲 中国 朝鲜'],
  [/日满/g, '日本 满洲'],
  [/中朝/g, '中国 朝鲜'],
]
const RESEARCH_RELATED_QUERY_EXPANSIONS: Array<[string, string[]]> = [
  ['日本', ['日方', '日本人', '日本政府', '日语', '日本语']],
  ['满洲', ['满州', '满洲国', '伪满', '伪满洲国', '满铁', '关东军']],
  ['中国', ['中方', '中国人', '中华', '国民政府', '国府']],
  ['朝鲜', ['朝鲜人', '韩人', '朝鲜半岛']],
]
const EXPLICIT_CORE_QUERY_GROUPS: Array<[string, string[]]> = [
  ['日本', ['日本', '日方', '日人', '日本国']],
  ['满洲', ['满洲', '满州', '满洲国', '伪满', '伪满洲国']],
  ['中国', ['中国', '中方', '中华', '民国', '国民政府']],
  ['朝鲜', ['朝鲜', '韩人', '朝鲜半岛']],
]
const GENERIC_RESEARCH_QUERY_TERMS = new Set(['问题', '关系', '政府', '内容', '材料', '文献', '研究', '相关'])
const cjkWordSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
    : null

interface CountRow {
  segmentCount: number
  documentCount: number
  pageCount: number
  hitCount: number
}

interface ReadableRow {
  count: number
}

interface SampleRow {
  segment_id: string
  doc_id: string
  page_id: string | null
  page_num: number | null
  ordinal: number | null
  text: string | null
  normalized_text: string | null
  doc_title: string | null
  doc_type: string | null
  dynasty: string | null
  metadata: string | null
  folder_names: string | null
  tag_names: string | null
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function uniqueStrings(values: Array<string | null | undefined>, limit = Number.MAX_SAFE_INTEGER): string[] {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, limit)
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

export function normalizeAiResearchTaskKind(value: unknown, goal = ''): AiResearchTaskKind {
  const raw = String(value || '').trim()
  if (raw === 'statistical' || raw === 'extraction' || raw === 'synthesis' || raw === 'mixed') return raw
  const text = `${goal} ${raw}`
  const statistical = /多少|数量|统计|频率|占比|篇幅|分布|命中|有多少/.test(text)
  const extraction = /抽取|抓取|提取|整理|字段|数据集|表格/.test(text)
  const synthesis = /综述|总结|规律|特点|脉络|趋势|比较|阶段/.test(text)
  if (statistical && (extraction || synthesis)) return 'mixed'
  if (statistical) return 'statistical'
  if (extraction) return 'extraction'
  if (synthesis) return 'synthesis'
  return 'mixed'
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function normalizeSearchTerm(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function splitQueryTerms(query: string): string[] {
  const normalized = normalizeSearchTerm(query.replace(/[+，,、;；]/g, ' '))
  return uniqueStrings(normalized.split(/\s+/), 6)
}

function normalizeCjkBlock(value: string): string {
  let normalized = value
  ;[...RESEARCH_QUERY_TASK_PHRASES, ...RESEARCH_QUERY_STOP_WORDS]
    .filter((word) => /^[\u4e00-\u9fff]{2,}$/.test(word))
    .sort((left, right) => right.length - left.length)
    .forEach((word) => {
      normalized = normalized.replaceAll(word, ' ')
    })
  return normalized.replace(/[的了和与及或在对中内为是有把将]/g, ' ').replace(/\s+/g, ' ').trim()
}

function trimResearchQueryParticles(value: string): string {
  return value.trim().replace(CJK_QUERY_PARTICLES, '').trim()
}

function isHtmlCssNoiseWord(value: string): boolean {
  const lower = value.trim().toLowerCase()
  const compact = lower.replace(/[^a-z0-9]/g, '')
  return HTML_CSS_NOISE_WORDS.has(lower) || HTML_CSS_NOISE_WORDS.has(compact)
}

function isReadableResearchQuery(value: string): boolean {
  const query = trimResearchQueryParticles(value)
  const lower = query.toLowerCase()
  if (
    !query ||
    RESEARCH_QUERY_STOP_WORDS.has(query) ||
    GENERIC_RESEARCH_QUERY_TERMS.has(query) ||
    isHtmlCssNoiseWord(lower) ||
    SPURIOUS_CJK_QUERY_FRAGMENTS.has(query)
  ) return false
  if (/[?？!！。；;:：()[\]{}"'“”‘’《》<>/\\]/.test(query)) return false
  if (/^\d+$/.test(query)) return false
  if (/^[\u4e00-\u9fff]$/.test(query)) return false
  if (/^[\u4e00-\u9fff]{2,6}$/.test(query)) {
    return ![...RESEARCH_QUERY_TASK_PHRASES].some((phrase) => query.includes(phrase))
  }
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{1,40}$/.test(query)) return !isHtmlCssNoiseWord(lower)
  return false
}

function segmentCjkQueryBlock(value: string): string[] {
  const block = trimResearchQueryParticles(value)
  if (!block) return []
  if (!cjkWordSegmenter) return [block]
  const segments = Array.from(cjkWordSegmenter.segment(block))
    .filter((segment) => segment.isWordLike)
    .map((segment) => trimResearchQueryParticles(segment.segment))
    .filter(Boolean)
  return segments.length > 0 ? segments : [block]
}

function addCjkBlockTerms(block: string, add: (value: string) => void): void {
  const normalized = normalizeCjkBlock(block)
  if (normalized.length < 2) return
  normalized
    .split(/\s+|和|与|及|或/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      segmentCjkQueryBlock(item).forEach((term) => {
        if (isReadableResearchQuery(term)) add(term)
      })
    })
}

function normalizeResearchQueryInput(value: string): string {
  let normalized = value
  COMPACT_HISTORICAL_QUERY_REPLACEMENTS.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, ` ${replacement} `)
  })
  RESEARCH_QUERY_TASK_PHRASES
    .sort((left, right) => right.length - left.length)
    .forEach((phrase) => {
      normalized = normalized.replaceAll(phrase, ' ')
    })
  return normalized
    .replace(/[，。；、,.!?！？;:：()[\]{}"'“”‘’《》<>/\\_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractResearchSearchQueries(values: string[], limit = MAX_QUERY_SEEDS): string[] {
  const queries: string[] = []
  const add = (value: string) => {
    const query = trimResearchQueryParticles(value)
    if (!isReadableResearchQuery(query)) return
    if (!queries.includes(query)) queries.push(query)
  }

  values.forEach((value) => {
    const normalized = normalizeResearchQueryInput(String(value || ''))
    normalized
      .split(/\s+|和|与|及|或/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        if (/^[\u4e00-\u9fff]{2,}$/.test(item)) {
          addCjkBlockTerms(item, add)
        } else {
          add(item)
        }
      })
  })

  return queries.slice(0, limit)
}

export function buildResearchSeedQueries(values: string[], limit = MAX_QUERY_SEEDS): string[] {
  return extractResearchSearchQueries(values, limit)
}

export function extractExplicitCoreResearchQueries(values: string[], limit = 8): string[] {
  const sourceText = values.join(' ')
  const normalized = normalizeResearchQueryInput(sourceText)
  const compact = normalized.replace(/\s+/g, '')
  const coreQueries: string[] = []
  const add = (query: string) => {
    if (coreQueries.length >= limit) return
    if (isReadableResearchQuery(query) && !coreQueries.includes(query)) coreQueries.push(query)
  }

  if (/日满中朝|日本满洲中国朝鲜|日本满州中国朝鲜/.test(sourceText.replace(/\s+/g, ''))) {
    ;['日本', '满洲', '中国', '朝鲜'].forEach(add)
  }

  EXPLICIT_CORE_QUERY_GROUPS.forEach(([core, aliases]) => {
    if (aliases.some((alias) => sourceText.includes(alias) || compact.includes(alias))) add(core)
  })

  return coreQueries.slice(0, limit)
}

export function expandRelatedResearchQueries(values: string[], limit = MAX_QUERY_SEEDS): string[] {
  const coreQueries = extractExplicitCoreResearchQueries(values, Math.min(8, limit))
  const seeds = uniqueStrings([...coreQueries, ...buildResearchSeedQueries(values, limit)], limit)
  const sourceText = values.join(' ')
  const expanded: string[] = [...seeds]
  RESEARCH_RELATED_QUERY_EXPANSIONS.forEach(([trigger, related]) => {
    if (!sourceText.includes(trigger) && !seeds.includes(trigger)) return
    related.forEach((term) => {
      if (expanded.length < limit && isReadableResearchQuery(term) && !expanded.includes(term)) {
        expanded.push(term)
      }
    })
  })
  return expanded.slice(0, limit)
}

function getDocumentIdsForScope(scope: LibraryAiScope): string[] | undefined {
  if (scope.type === 'documents') return uniqueStrings(scope.docIds || [])
  if (scope.type === 'tags') {
    const tagIds = uniqueStrings(scope.tagIds || [])
    if (tagIds.length === 0) return []
    let sql = 'SELECT d.id FROM documents d'
    const params: string[] = []
    tagIds.forEach((tagId, index) => {
      const alias = `dt_ai_retrieval_${index}`
      sql += ` INNER JOIN document_tags ${alias} ON d.id = ${alias}.doc_id AND ${alias}.tag_id = ?`
      params.push(tagId)
    })
    sql += ' GROUP BY d.id ORDER BY d.updated_at DESC'
    return queryAll<{ id: string }>(sql, params).map((item) => item.id)
  }
  if (scope.type === 'folders') {
    const folderIds = resolveFolderAndDescendantIds(uniqueStrings(scope.folderIds || []))
    if (folderIds.length === 0) return []
    return queryAll<{ id: string }>(
      `SELECT DISTINCT d.id
       FROM documents d
       INNER JOIN document_folders df ON d.id = df.doc_id
       WHERE df.folder_id IN (${folderIds.map(() => '?').join(', ')})
       ORDER BY d.updated_at DESC`,
      folderIds,
    ).map((item) => item.id)
  }
  return undefined
}

function chunkDocIds(docIds: string[] | undefined): Array<string[] | undefined> {
  if (!docIds) return [undefined]
  if (docIds.length === 0) return []
  const chunks: string[][] = []
  for (let index = 0; index < docIds.length; index += SQL_DOC_CHUNK_SIZE) {
    chunks.push(docIds.slice(index, index + SQL_DOC_CHUNK_SIZE))
  }
  return chunks
}

function buildQueryWhere(terms: string[], chunk?: string[]): { where: string; params: unknown[] } {
  const clauses = terms.map(() => `${SEARCH_TEXT_EXPR} LIKE ? ESCAPE '\\'`)
  const params: unknown[] = terms.map((term) => `%${escapeLike(term)}%`)
  clauses.push(`TRIM(COALESCE(NULLIF(s.normalized_text, ''), s.text, '')) != ''`)
  if (chunk) {
    clauses.push(`s.doc_id IN (${chunk.map(() => '?').join(', ')})`)
    params.push(...chunk)
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, params }
}

function mergeFacetCounts(target: Map<string, AiResearchFacetBucket>, source: AiResearchFacetBucket[]): void {
  source.forEach((bucket) => {
    const key = bucket.key || bucket.label
    const existing = target.get(key)
    if (existing) {
      existing.count += bucket.count
    } else {
      target.set(key, { ...bucket })
    }
  })
}

function topBuckets(map: Map<string, AiResearchFacetBucket>, limit = 12): AiResearchFacetBucket[] {
  return [...map.values()]
    .filter((bucket) => bucket.count > 0)
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-Hans-CN'))
    .slice(0, limit)
}

function addBucket(map: Map<string, AiResearchFacetBucket>, value: string | null | undefined, count = 1): void {
  const label = String(value || '').trim()
  if (!label) return
  const existing = map.get(label)
  if (existing) {
    existing.count += count
  } else {
    map.set(label, { key: label, label, count })
  }
}

function parseMetadataYear(metadata: string | null | undefined): string | null {
  const parsed = safeJsonParse<Record<string, unknown>>(metadata, {})
  const candidates = [
    parsed.publicationYear,
    parsed.publication_year,
    parsed.year,
    parsed.date,
    parsed.publication_time,
  ]
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/(1[5-9]\d{2}|20\d{2})/)
    if (match) return match[1]
  }
  return null
}

function extractCooccurringTermsFromRows(rows: SampleRow[], queryTerms: string[]): AiResearchFacetBucket[] {
  const stopWords = new Set([
    ...RESEARCH_QUERY_STOP_WORDS,
    ...queryTerms,
    '中国', '日本', '满洲', '朝鲜', '相关', '研究', '文献', '材料', '问题', '进行', '一种', '一个', '其中', '以及', '或者',
  ])
  const counts = new Map<string, AiResearchFacetBucket>()
  rows.forEach((row) => {
    const text = String(row.text || row.normalized_text || '')
    const lower = text.toLowerCase()
    const firstIndex = queryTerms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0
    const windowText = text.slice(Math.max(0, firstIndex - 180), firstIndex + 260)
    const latinTerms = windowText.match(/[A-Za-z][A-Za-z0-9_-]{1,30}/g) || []
    latinTerms.forEach((term) => {
      const normalized = term.toLowerCase()
      if (isHtmlCssNoiseWord(normalized)) return
      addBucket(counts, normalized)
    })
    const cjkBlocks = windowText.match(/[\u4e00-\u9fff]{2,}/g) || []
    cjkBlocks.forEach((block) => {
      const candidates: string[] = []
      addCjkBlockTerms(block, (term) => candidates.push(term))
      candidates.forEach((term) => {
        if (!stopWords.has(term)) addBucket(counts, term)
      })
    })
  })
  return topBuckets(counts, 18)
}

function buildFacets(rows: SampleRow[], terms: string[]): AiResearchQueryFacets {
  const docTypes = new Map<string, AiResearchFacetBucket>()
  const years = new Map<string, AiResearchFacetBucket>()
  const folders = new Map<string, AiResearchFacetBucket>()
  const tags = new Map<string, AiResearchFacetBucket>()
  rows.forEach((row) => {
    addBucket(docTypes, row.doc_type || 'unknown')
    addBucket(years, parseMetadataYear(row.metadata) || null)
    String(row.folder_names || '').split('|').filter(Boolean).forEach((name) => addBucket(folders, name))
    String(row.tag_names || '').split('|').filter(Boolean).forEach((name) => addBucket(tags, name))
  })
  return {
    docTypes: topBuckets(docTypes, 8),
    years: topBuckets(years, 12),
    folders: topBuckets(folders, 12),
    tags: topBuckets(tags, 12),
    cooccurringTerms: extractCooccurringTermsFromRows(rows, terms),
  }
}

function countReadableSegments(docIds: string[] | undefined): number {
  return chunkDocIds(docIds).reduce((total, chunk) => {
    const docClause = chunk ? ` AND s.doc_id IN (${chunk.map(() => '?').join(', ')})` : ''
    const row = queryOne<ReadableRow>(
      `SELECT COUNT(*) as count
       FROM search_index_segments s
       WHERE TRIM(COALESCE(NULLIF(s.normalized_text, ''), s.text, '')) != ''${docClause}`,
      chunk || [],
    )
    return total + Number(row?.count || 0)
  }, 0)
}

function countQueryStat(query: string, round: number, docIds: string[] | undefined): AiResearchQueryStat {
  const terms = splitQueryTerms(query)
  if (terms.length === 0) {
    return {
      query,
      terms: [],
      round,
      hitCount: 0,
      documentCount: 0,
      pageCount: 0,
      segmentCount: 0,
      highFrequency: false,
      facets: { docTypes: [], years: [], folders: [], tags: [], cooccurringTerms: [] },
    }
  }

  let segmentCount = 0
  let documentCount = 0
  let pageCount = 0
  let hitCount = 0

  chunkDocIds(docIds).forEach((chunk) => {
    const { where, params } = buildQueryWhere(terms, chunk)
    const firstTerm = terms[0]
    const row = queryOne<CountRow>(
      `SELECT
         COUNT(*) as segmentCount,
         COUNT(DISTINCT s.doc_id) as documentCount,
         COUNT(DISTINCT COALESCE(s.page_id, s.doc_id || ':' || COALESCE(s.page_num, ''))) as pageCount,
         COALESCE(SUM(
           CASE
             WHEN LENGTH(?) > 0 THEN (LENGTH(${SEARCH_TEXT_EXPR}) - LENGTH(REPLACE(${SEARCH_TEXT_EXPR}, ?, ''))) / LENGTH(?)
             ELSE 0
           END
         ), 0) as hitCount
       FROM search_index_segments s
       ${where}`,
      [firstTerm, firstTerm, firstTerm, ...params],
    )
    segmentCount += Number(row?.segmentCount || 0)
    documentCount += Number(row?.documentCount || 0)
    pageCount += Number(row?.pageCount || 0)
    hitCount += Number(row?.hitCount || 0)
  })

  const rows = sampleRows(query, docIds, SAMPLE_ROW_LIMIT)
  return {
    query,
    terms,
    round,
    hitCount,
    documentCount,
    pageCount,
    segmentCount,
    highFrequency: hitCount > HIGH_FREQUENCY_HIT_THRESHOLD || documentCount > HIGH_FREQUENCY_DOC_THRESHOLD,
    facets: buildFacets(rows, terms),
  }
}

function sampleRows(query: string, docIds: string[] | undefined, limit: number): SampleRow[] {
  const terms = splitQueryTerms(query)
  if (terms.length === 0 || limit <= 0) return []
  const rows: SampleRow[] = []
  for (const chunk of chunkDocIds(docIds)) {
    if (rows.length >= limit) break
    const { where, params } = buildQueryWhere(terms, chunk)
    const nextRows = queryAll<SampleRow>(
      `SELECT
         s.segment_id,
         s.doc_id,
         s.page_id,
         s.page_num,
         s.ordinal,
         s.text,
         s.normalized_text,
         COALESCE(d.title, s.title, '未命名文献') as doc_title,
         COALESCE(d.doc_type, 'unknown') as doc_type,
         d.dynasty,
         d.metadata,
         (SELECT GROUP_CONCAT(f.name, '|') FROM document_folders df INNER JOIN folders f ON f.id = df.folder_id WHERE df.doc_id = s.doc_id) as folder_names,
         (SELECT GROUP_CONCAT(t.name, '|') FROM document_tags dt INNER JOIN tags t ON t.id = dt.tag_id WHERE dt.doc_id = s.doc_id) as tag_names
       FROM search_index_segments s
       LEFT JOIN documents d ON d.id = s.doc_id
       ${where}
       ORDER BY s.updated_at DESC, s.ordinal ASC
       LIMIT ?`,
      [...params, limit - rows.length],
    )
    rows.push(...nextRows)
  }
  return rows
}

function combineQuery(query: string, term: string): string {
  const terms = splitQueryTerms(query)
  if (terms.includes(term.toLowerCase()) || query.includes(term)) return query
  return `${query} ${term}`
}

function generateNextQueries(stats: AiResearchQueryStat[], usedQueries: Set<string>, plan: AiResearchRetrievalPlan): string[] {
  const generated: string[] = []
  const generatedKeys = new Set<string>()
  const coreTerms = uniqueStrings([...(plan.coreQueries || []), ...extractExplicitCoreResearchQueries([plan.goal], 8)], 8)
  const goalTerms = extractResearchSearchQueries([plan.goal], 8)
  const queryKey = (query: string) => {
    const terms = splitQueryTerms(query)
    return terms.length > 1 ? [...terms].sort().join('\u0001') : normalizeSearchTerm(query)
  }
  const add = (query: string) => {
    const normalized = normalizeSearchTerm(query)
    const key = queryKey(query)
    if (!normalized || usedQueries.has(normalized) || generatedKeys.has(key)) return
    generatedKeys.add(key)
    generated.push(query)
  }

  if (plan.kind === 'statistical' && coreTerms.length > 1) {
    stats
      .filter((stat) => stat.highFrequency && stat.terms.length === 1 && coreTerms.includes(stat.terms[0]))
      .forEach((stat) => {
        coreTerms
          .filter((term) => term !== stat.terms[0])
          .forEach((term) => add(combineQuery(stat.query, term)))
      })
    return generated.slice(0, plan.queriesPerRound)
  }

  stats
    .filter((stat) => stat.highFrequency)
    .forEach((stat) => {
      if (stat.terms.length >= 3) return
      stat.facets.cooccurringTerms.slice(0, 8).forEach((bucket) => add(combineQuery(stat.query, bucket.label)))
      stat.facets.tags.slice(0, 4).forEach((bucket) => add(combineQuery(stat.query, bucket.label)))
      goalTerms.slice(0, 4).forEach((term) => add(combineQuery(stat.query, term)))
    })

  return generated.slice(0, plan.queriesPerRound)
}

function mergeCooccurringTerms(queryStats: AiResearchQueryStat[]): AiResearchFacetBucket[] {
  const merged = new Map<string, AiResearchFacetBucket>()
  queryStats.forEach((stat) => mergeFacetCounts(merged, stat.facets.cooccurringTerms))
  return topBuckets(merged, 24)
}

function ensurePlannedQueryStats(
  queryStats: AiResearchQueryStat[],
  planQueries: string[],
  docIds: string[] | undefined,
): AiResearchQueryStat[] {
  const existing = new Set(queryStats.map((stat) => normalizeSearchTerm(stat.query)))
  const missing = planQueries
    .map((query) => query.trim())
    .filter((query) => query && !existing.has(normalizeSearchTerm(query)))
  if (missing.length === 0) return queryStats
  return [...queryStats, ...missing.map((query) => countQueryStat(query, 1, docIds))]
}

export function planResearchRetrieval(payload: AiResearchRetrievalPreviewPayload): AiResearchRetrievalPlan {
  const goal = String(payload.goal || '').trim()
  const explicitQueries = buildResearchSeedQueries(payload.suggestedQueries || [], MAX_QUERY_SEEDS)
  const goalQueries = buildResearchSeedQueries([goal], MAX_QUERY_SEEDS)
  const coreQueries = extractExplicitCoreResearchQueries([goal, ...(payload.suggestedQueries || [])], 8)
  const seedQueries = expandRelatedResearchQueries([...coreQueries, ...goalQueries, ...explicitQueries, goal], MAX_QUERY_SEEDS)
  return {
    taskId: null,
    projectId: payload.projectId || null,
    goal,
    scope: payload.scope || { type: 'all' },
    kind: normalizeAiResearchTaskKind(payload.kind, goal),
    queries: seedQueries.length > 0 ? seedQueries : uniqueStrings([goal], 1),
    coreQueries,
    excludeQueries: [],
    maxRounds: MAX_RETRIEVAL_ROUNDS,
    queriesPerRound: RETRIEVAL_QUERIES_PER_ROUND,
    highFrequencyHitThreshold: HIGH_FREQUENCY_HIT_THRESHOLD,
    highFrequencyDocThreshold: HIGH_FREQUENCY_DOC_THRESHOLD,
    evidenceBudget: EVIDENCE_PACK_LIMIT,
    perQueryEvidenceLimit: PER_QUERY_EVIDENCE_LIMIT,
    perDocumentPageLimit: PER_DOCUMENT_PAGE_LIMIT,
    perPageSnippetLimit: PER_PAGE_SNIPPET_LIMIT,
  }
}

function runRetrievalStats(plan: AiResearchRetrievalPlan): AiResearchRetrievalStats {
  const docIds = getDocumentIdsForScope(plan.scope)
  const readableSegmentCount = docIds && docIds.length === 0 ? 0 : countReadableSegments(docIds)
  const usedQueries = new Set<string>()
  const queryStats: AiResearchQueryStat[] = []
  const rounds: AiResearchRetrievalRound[] = []
  let pending = uniqueStrings(plan.queries, plan.maxRounds * plan.queriesPerRound)

  for (let round = 1; round <= plan.maxRounds && pending.length > 0; round += 1) {
    const current = pending
      .splice(0, plan.queriesPerRound)
      .map((query) => query.trim())
      .filter((query) => query && !usedQueries.has(normalizeSearchTerm(query)))
    if (current.length === 0) break
    current.forEach((query) => usedQueries.add(normalizeSearchTerm(query)))
    const roundStats = current.map((query) => countQueryStat(query, round, docIds))
    queryStats.push(...roundStats)
    const generated = generateNextQueries(roundStats, usedQueries, plan)
    pending = uniqueStrings([...pending, ...generated], plan.maxRounds * plan.queriesPerRound)
    const highFrequencyQueries = roundStats.filter((stat) => stat.highFrequency).map((stat) => stat.query)
    rounds.push({
      round,
      queries: current,
      generatedQueries: generated,
      highFrequencyQueries,
      message: highFrequencyQueries.length > 0
        ? `第 ${round} 轮发现高频词，已按共现词、标签和研究目标继续收缩。`
        : `第 ${round} 轮关键词统计完成。`,
    })
    if (generated.length === 0 && pending.length === 0) break
  }

  const completeQueryStats = ensurePlannedQueryStats(queryStats, plan.queries, docIds)
  const createdAt = new Date().toISOString()
  return {
    taskId: plan.taskId || null,
    runId: null,
    plan,
    queryStats: completeQueryStats,
    rounds,
    totalHitCount: completeQueryStats.reduce((sum, stat) => sum + stat.hitCount, 0),
    totalDocumentCount: completeQueryStats.reduce((sum, stat) => sum + stat.documentCount, 0),
    totalPageCount: completeQueryStats.reduce((sum, stat) => sum + stat.pageCount, 0),
    readableSegmentCount,
    highFrequencyTriggered: completeQueryStats.some((stat) => stat.highFrequency),
    cooccurringTerms: mergeCooccurringTerms(completeQueryStats),
    createdAt,
  }
}

function findFirstTerm(text: string, terms: string[]): { index: number; term: string } {
  const lower = text.toLowerCase()
  for (const term of terms) {
    const index = lower.indexOf(term)
    if (index >= 0) return { index, term }
  }
  return { index: 0, term: terms[0] || '' }
}

function buildSnippet(text: string, terms: string[]): { snippet: string; charStart: number; charEnd: number; matchText: string } {
  const clean = text.replace(/\s+/g, ' ').trim()
  const found = findFirstTerm(clean, terms)
  const start = Math.max(0, found.index - 120)
  const end = Math.min(clean.length, found.index + Math.max(found.term.length, 1) + 180)
  const before = clean.slice(start, found.index)
  const match = clean.slice(found.index, found.index + found.term.length)
  const after = clean.slice(found.index + found.term.length, end)
  return {
    snippet: `${start > 0 ? '...' : ''}${before}${match ? `<<${match}>>` : ''}${after}${end < clean.length ? '...' : ''}`,
    charStart: found.index,
    charEnd: found.index + found.term.length,
    matchText: match || found.term,
  }
}

function rowToEvidenceItem(row: SampleRow, stat: AiResearchQueryStat, index: number): AiResearchEvidenceItem {
  const sourceText = String(row.text || row.normalized_text || '')
  const snippet = buildSnippet(sourceText, stat.terms)
  const pageNum = Number(row.page_num || 0)
  const locator: SearchHitLocator = {
    docId: row.doc_id,
    segmentId: row.segment_id,
    sourceType: 'search_segment',
    pageId: row.page_id,
    pageNum,
    segmentOrdinal: Number(row.ordinal || 0),
    charStart: snippet.charStart,
    charEnd: snippet.charEnd,
    matchText: snippet.matchText,
    queryTerm: stat.query,
    occurrenceIndex: 0,
  }
  return {
    id: `${row.segment_id}:${index}`,
    query: stat.query,
    doc_id: row.doc_id,
    doc_title: row.doc_title || '未命名文献',
    doc_type: row.doc_type || 'unknown',
    page_num: pageNum,
    snippet: snippet.snippet,
    score: Number((1000 / Math.max(stat.hitCount, 1) + stat.terms.length * 10 + index / 1000).toFixed(4)),
    matched_query: stat.query,
    localStats: {
      documentCount: stat.documentCount,
      pageCount: stat.pageCount,
      hitCount: stat.hitCount,
      highFrequency: stat.highFrequency,
      cooccurringTerms: stat.facets.cooccurringTerms.slice(0, 8).map((bucket) => bucket.label),
    },
    locator,
  }
}

function buildEvidencePack(stats: AiResearchRetrievalStats): AiResearchEvidencePack {
  const docIds = getDocumentIdsForScope(stats.plan.scope)
  const evidence: AiResearchEvidenceItem[] = []
  const seen = new Set<string>()
  const pagesByDoc = new Map<string, Set<number>>()
  const snippetsByPage = new Map<string, number>()
  const perQueryCount = new Map<string, number>()
  const coreQueries = new Set(stats.plan.coreQueries || [])
  const statisticalPriority = (stat: AiResearchQueryStat): number => {
    if (coreQueries.has(stat.query)) return 0
    if (stat.terms.length === 2 && stat.terms.every((term) => coreQueries.has(term))) return 1
    if (stat.terms.some((term) => coreQueries.has(term))) return 2
    return 3
  }
  const preferredStats = [...stats.queryStats]
    .filter((stat) => stat.hitCount > 0)
    .sort((left, right) => {
      if (stats.plan.kind === 'statistical') {
        const priorityDiff = statisticalPriority(left) - statisticalPriority(right)
        if (priorityDiff !== 0) return priorityDiff
        const termDiff = left.terms.length - right.terms.length
        if (termDiff !== 0) return termDiff
        return Math.min(right.hitCount, 10000) - Math.min(left.hitCount, 10000)
      }
      const highFrequency = Number(left.highFrequency) - Number(right.highFrequency)
      if (highFrequency !== 0) return highFrequency
      const termDiff = right.terms.length - left.terms.length
      if (termDiff !== 0) return termDiff
      return Math.min(left.hitCount, 10000) - Math.min(right.hitCount, 10000)
    })

  preferredStats.forEach((stat) => {
    if (evidence.length >= stats.plan.evidenceBudget) return
    const rows = sampleRows(stat.query, docIds, stats.plan.perQueryEvidenceLimit * 4)
    rows.forEach((row, index) => {
      if (evidence.length >= stats.plan.evidenceBudget) return
      const currentQueryCount = perQueryCount.get(stat.query) || 0
      if (currentQueryCount >= stats.plan.perQueryEvidenceLimit) return
      const pageNum = Number(row.page_num || 0)
      const pageKey = `${row.doc_id}:${pageNum}`
      const pages = pagesByDoc.get(row.doc_id) || new Set<number>()
      if (!pages.has(pageNum) && pages.size >= stats.plan.perDocumentPageLimit) return
      if ((snippetsByPage.get(pageKey) || 0) >= stats.plan.perPageSnippetLimit) return
      const key = `${row.segment_id}:${stat.query}`
      if (seen.has(key)) return
      seen.add(key)
      pages.add(pageNum)
      pagesByDoc.set(row.doc_id, pages)
      snippetsByPage.set(pageKey, (snippetsByPage.get(pageKey) || 0) + 1)
      perQueryCount.set(stat.query, currentQueryCount + 1)
      evidence.push(rowToEvidenceItem(row, stat, index))
    })
  })

  const createdAt = new Date().toISOString()
  return {
    taskId: stats.taskId || null,
    runId: stats.runId || null,
    evidence: evidence.sort((left, right) => right.score - left.score),
    totalEvidenceCount: evidence.length,
    truncated: preferredStats.some((stat) => stat.hitCount > stats.plan.perQueryEvidenceLimit) || evidence.length >= stats.plan.evidenceBudget,
    createdAt,
    statsSummary: {
      totalHitCount: stats.totalHitCount,
      totalDocumentCount: stats.totalDocumentCount,
      totalPageCount: stats.totalPageCount,
    },
  }
}

function taskToRetrievalPlan(task: AiResearchTask): AiResearchRetrievalPlan {
  const scope = safeJsonParse<LibraryAiScope>(task.scope_json, { type: 'all' })
  const queries = uniqueStrings(safeJsonParse<string[]>(task.suggested_queries_json, []), MAX_QUERY_SEEDS)
  const plan = planResearchRetrieval({
    goal: task.goal,
    scope,
    projectId: task.project_id,
    suggestedQueries: queries.length > 0 ? queries : task.suggestedQueries,
    fields: task.fieldSchema,
    kind: task.kind,
  })
  return { ...plan, taskId: task.id, projectId: task.project_id, kind: normalizeAiResearchTaskKind(task.kind, task.goal) }
}

function persistRun(task: AiResearchTask, plan: AiResearchRetrievalPlan): string {
  const id = nanoid()
  const now = new Date().toISOString()
  run(
    `INSERT INTO ai_research_retrieval_runs (
      id, task_id, project_id, plan_json, stats_json, status, message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', 'running', ?, ?, ?)`,
    [id, task.id, task.project_id, JSON.stringify(plan), '正在进行本地全库统计检索', now, now],
  )
  saveDatabase()
  return id
}

function persistRetrievalResult(task: AiResearchTask, runId: string, stats: AiResearchRetrievalStats, pack: AiResearchEvidencePack): void {
  const now = new Date().toISOString()
  run(
    'UPDATE ai_research_retrieval_runs SET stats_json = ?, status = ?, message = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(stats), 'completed', '完整数量统计由本地检索计算，AI 只读取压缩后的代表证据。', now, runId],
  )
  run(
    'INSERT INTO ai_research_retrieval_stats (id, task_id, run_id, stats_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [nanoid(), task.id, runId, JSON.stringify(stats), now, now],
  )
  run(
    'INSERT INTO ai_research_evidence_packs (id, task_id, run_id, evidence_json, evidence_count, truncated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [nanoid(), task.id, runId, JSON.stringify(pack), pack.totalEvidenceCount, pack.truncated ? 1 : 0, now, now],
  )
  saveDatabase()
}

export function previewResearchRetrieval(payload: AiResearchRetrievalPreviewPayload): AiResearchRetrievalStats {
  const plan = planResearchRetrieval(payload)
  return runRetrievalStats(plan)
}

export function runResearchRetrievalForTask(task: AiResearchTask): AiResearchRetrievalRunResult {
  const plan = taskToRetrievalPlan(task)
  const runId = persistRun(task, plan)
  const stats = runRetrievalStats({ ...plan, taskId: task.id })
  stats.runId = runId
  const pack = buildEvidencePack(stats)
  pack.runId = runId
  persistRetrievalResult(task, runId, stats, pack)
  return { stats, evidencePack: pack }
}

export function getLatestResearchRetrievalStats(taskId: string): AiResearchRetrievalStats | null {
  const row = queryOne<{ stats_json: string }>(
    'SELECT stats_json FROM ai_research_retrieval_stats WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
    [taskId],
  )
  return row ? safeJsonParse<AiResearchRetrievalStats | null>(row.stats_json, null) : null
}

export function getLatestResearchEvidencePack(taskId: string): AiResearchEvidencePack | null {
  const row = queryOne<{ evidence_json: string }>(
    'SELECT evidence_json FROM ai_research_evidence_packs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
    [taskId],
  )
  return row ? safeJsonParse<AiResearchEvidencePack | null>(row.evidence_json, null) : null
}

export function evidenceItemToSearchResult(item: AiResearchEvidenceItem): SearchResult {
  return {
    doc_id: item.doc_id,
    page_num: item.page_num,
    snippet: item.snippet,
    rank: item.score,
    doc_title: item.doc_title,
    doc_author: null,
    doc_type: item.doc_type,
    relevance_score: item.score,
    hit_field: 'fulltext',
    matched_query: item.matched_query,
    locator: item.locator,
  }
}
