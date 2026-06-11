import { createHash } from 'crypto'
import { callLLM, callLLMStream, getDocumentBrief, runAiTask, type AiDocumentBrief } from './ai'
import { fullTextSearch, previewLibraryAiScope } from './semantic-search'
import { queryAll, queryOne } from './database'
import type {
  AiSearchPlan,
  EvidenceQaCluster,
  EvidenceQaClusterPage,
  EvidenceQaPlan,
  EvidenceQaResponse,
  EvidenceQaSource,
  Document,
  DocumentMetadataResult,
  LibraryAiScope,
  SearchHitLocator,
} from '../shared/types'

const DEFAULT_RESULT_LIMIT = 12
const MAX_QUERIES = 18
const MAX_CLUSTERS = 8
const MAX_CONTEXT_CHARS = 26000
const MAX_PAGE_TEXT_CHARS = 1800
const MAX_OVERVIEW_PAGE_TEXT_CHARS = 700
const MAX_OVERVIEW_PAGES_PER_CLUSTER = 3
const MIN_TEXT_FOR_WIDE_RADIUS = 360
const OVERVIEW_QUERY_LABEL = '全文概览'
const MAX_REFINEMENT_ROUNDS = 3
const MAX_REFINEMENT_DOCS = 6
const MAX_REFINEMENT_CONTEXT_CHARS = 14000

type EvidenceQaScope =
  | { type: 'documents'; docIds: string[] }
  | LibraryAiScope

type EvidenceSearchResult = ReturnType<typeof fullTextSearch>[number]

type EvidenceSearchOutcome = {
  results: EvidenceSearchResult[]
  expandedQueries: string[]
  warnings: string[]
}

type QueryRefinementRound = {
  reason: string
  queries: string[]
}

type JsonRecord = Record<string, unknown>

interface AiRefinementRoundDraft {
  reason?: unknown
  queries?: unknown
}

type EvidenceRefinementDocumentRow = Pick<Document, 'id' | 'title' | 'author' | 'doc_type' | 'dynasty' | 'metadata'>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniqueStrings(values: Array<string | undefined | null>, limit = Number.MAX_SAFE_INTEGER): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, limit)
}

function stripSnippetMarkers(value: string): string {
  return String(value || '').replace(/<<|>>/g, '').replace(/\s+/g, ' ').trim()
}

function truncateText(value: string, maxLength: number): string {
  const text = String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length <= maxLength) return text
  const slice = text.slice(0, maxLength)
  const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('。'), slice.lastIndexOf('；'), slice.lastIndexOf('！'), slice.lastIndexOf('？'))
  return `${slice.slice(0, breakAt > maxLength * 0.55 ? breakAt + 1 : maxLength).trim()}...`
}

function hashSource(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function fallbackPlan(question: string): EvidenceQaPlan {
  const trimmed = question.trim()
  const terms = uniqueStrings([
    trimmed,
    ...trimmed.split(/[\s,，。；;、|/\\()[\]{}"'“”‘’<>《》]+/),
  ], 8)
  return {
    intent: trimmed || '证据问答',
    keywords: terms.length > 0 ? terms : [trimmed],
    expandedKeywords: [],
    excludeKeywords: [],
    inferredFilters: {},
    notes: '本地 fallback 检索计划',
  }
}

function overviewPlan(question: string): EvidenceQaPlan {
  return {
    ...fallbackPlan(question),
    intent: '概括当前文献内容',
    keywords: [OVERVIEW_QUERY_LABEL],
    expandedKeywords: [],
    excludeKeywords: [],
    inferredFilters: {},
    notes: '识别为全文概览问题，已读取当前范围内的 OCR 正文，而不是按问题原句做关键词检索。',
  }
}

function extractCurrentQuestion(question: string): string {
  const match = String(question || '').match(/当前问题：([\s\S]+)$/)
  return (match?.[1] || question).trim()
}

function isOverviewQuestion(question: string): boolean {
  const normalized = extractCurrentQuestion(question).replace(/\s+/g, '')
  if (!normalized) return false
  return /(?:这篇|本文|文章|论文|文献|全[文章]|整篇|这本|本书|材料).{0,12}(?:讲了?什么|主要内容|内容|大意|主旨|主题|观点|结论|摘要|概括|总结|综述)/.test(normalized)
    || /(?:总结|概括|摘要|综述|介绍).{0,12}(?:这篇|本文|文章|论文|文献|全[文章]|整篇|这本|本书|材料)/.test(normalized)
}

function isQuestionLike(value: string): boolean {
  return /[？?]|(?:什么|为何|为什么|如何|怎样|哪些|是否|能否|讲了?什么|谈了?什么|说明什么|内容是什么)/.test(value)
}

function isLikelyDirectSearchPhrase(value: string): boolean {
  const text = String(value || '').trim()
  if (!text || text.length > 24) return false
  if (isQuestionLike(text)) return false
  if (/(?:这篇|本文|文章|论文|文献|全[文章]|整篇|材料)/.test(text) && /(?:讲|谈|内容|总结|概括|摘要|介绍)/.test(text)) return false
  return true
}

function normalizePlan(raw: Partial<AiSearchPlan> | null | undefined, question: string): EvidenceQaPlan {
  const fallback = fallbackPlan(question)
  if (!raw) return fallback
  return {
    intent: String(raw.intent || fallback.intent || question).trim(),
    keywords: uniqueStrings(raw.keywords || [], 8),
    expandedKeywords: uniqueStrings(raw.expandedKeywords || [], 18),
    excludeKeywords: uniqueStrings(raw.excludeKeywords || [], 8),
    inferredFilters: raw.inferredFilters || {},
    notes: raw.notes || '',
  }
}

async function buildEvidencePlan(question: string): Promise<{ plan: EvidenceQaPlan; warnings: string[] }> {
  const warnings: string[] = []
  try {
    const raw = await runAiTask('ai_search_plan', question)
    const parsed = JSON.parse(String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim())
    const plan = normalizePlan(parsed, question)
    if (plan.keywords.length === 0) plan.keywords = fallbackPlan(question).keywords
    return { plan, warnings }
  } catch (error) {
    warnings.push('AI 检索计划解析失败，已使用原问题和关键词 fallback。')
    return { plan: fallbackPlan(question), warnings }
  }
}

function normalizeScopeDocumentIds(scope?: EvidenceQaScope): string[] | undefined {
  if (!scope) return undefined
  if (scope.type === 'documents') return uniqueStrings(scope.docIds || [])
  if (scope.type === 'tags') {
    const tagIds = uniqueStrings(scope.tagIds || [])
    if (tagIds.length === 0) return []
    let sql = 'SELECT d.id FROM documents d'
    const params: string[] = []
    tagIds.forEach((tagId, index) => {
      const alias = `dt_evidence_${index}`
      sql += ` INNER JOIN document_tags ${alias} ON d.id = ${alias}.doc_id AND ${alias}.tag_id = ?`
      params.push(tagId)
    })
    sql += ' GROUP BY d.id ORDER BY d.is_favorite DESC, d.updated_at DESC'
    return queryAll<{ id: string }>(sql, params).map((item) => item.id)
  }
  if (scope.type === 'folders') {
    const folderIds = uniqueStrings(scope.folderIds || [])
    if (folderIds.length === 0) return []
    return queryAll<{ id: string }>(
      `SELECT DISTINCT d.id
       FROM documents d
       INNER JOIN document_folders df ON d.id = df.doc_id
       WHERE df.folder_id IN (${folderIds.map(() => '?').join(', ')})
       ORDER BY d.is_favorite DESC, d.updated_at DESC`,
      folderIds,
    ).map((item) => item.id)
  }
  return undefined
}

function buildQueries(question: string, plan: EvidenceQaPlan): string[] {
  const priority: string[] = []
  const quoted = [...question.matchAll(/[“"《]([^”"》]{2,40})[”"》]/g)].map((match) => match[1])
  priority.push(...quoted)
  const direct = extractCurrentQuestion(question)
  if (isLikelyDirectSearchPhrase(direct)) priority.push(direct)
  return uniqueStrings([
    ...priority,
    ...plan.keywords,
    ...plan.expandedKeywords,
  ], MAX_QUERIES).filter((query) => query.length > 1 || direct.length === 1)
}

function searchEvidence(
  question: string,
  plan: EvidenceQaPlan,
  docIds: string[] | undefined,
  options?: { limit?: number },
): EvidenceSearchOutcome {
  const warnings: string[] = []
  const expandedQueries = buildQueries(question, plan)
  const resultPool: EvidenceSearchResult[] = []
  const limit = Math.max(options?.limit || DEFAULT_RESULT_LIMIT, DEFAULT_RESULT_LIMIT)

  expandedQueries.forEach((query, index) => {
    try {
      const hits = fullTextSearch(query, {
        docIds,
        limit: Math.max(24, Math.min(limit * 2, 60)),
        contextMode: 'long',
        exhaustive: query.length <= 3,
      }).map((item) => ({
        ...item,
        matched_query: item.matched_query || query,
        relevance_score: Number(item.relevance_score || 0) + Math.max(0, 20 - index) * 0.15,
      }))
      resultPool.push(...hits)
    } catch (error) {
      warnings.push(`关键词“${query}”检索失败，已跳过。`)
    }
  })

  const excludeTerms = new Set(plan.excludeKeywords.map((item) => item.toLowerCase()))
  const deduped = new Map<string, EvidenceSearchResult>()
  resultPool
    .filter((item) => {
      if (excludeTerms.size === 0) return true
      const text = `${item.doc_title || ''} ${item.snippet || ''}`.toLowerCase()
      return ![...excludeTerms].some((term) => term && text.includes(term))
    })
    .forEach((item) => {
      const key = `${item.doc_id}:${item.page_num || 0}:${item.locator?.segmentId || ''}:${stripSnippetMarkers(item.snippet).slice(0, 80)}`
      const existing = deduped.get(key)
      if (!existing || Number(item.relevance_score || 0) > Number(existing.relevance_score || 0)) deduped.set(key, item)
    })

  const results = [...deduped.values()]
    .sort((left, right) => Number(right.relevance_score || 0) - Number(left.relevance_score || 0))
    .slice(0, limit)

  return { results, expandedQueries, warnings }
}

function getRefinementDocumentIds(scope: EvidenceQaScope | undefined, docIds: string[] | undefined): string[] {
  if (docIds) return uniqueStrings(docIds, MAX_REFINEMENT_DOCS)
  if (scope && scope.type !== 'all') return []
  return queryAll<{ id: string }>(
    `SELECT d.id
     FROM documents d
     WHERE EXISTS (
       SELECT 1
       FROM pages p
       WHERE p.doc_id = d.id
         AND COALESCE(NULLIF(p.proofed_text, ''), NULLIF(p.ocr_text, ''), '') <> ''
     )
     ORDER BY d.is_favorite DESC, COALESCE(d.last_opened_at, d.updated_at) DESC, d.updated_at DESC
     LIMIT ?`,
    [MAX_REFINEMENT_DOCS],
  ).map((item) => item.id)
}

function parseMetadata(value: unknown): DocumentMetadataResult {
  if (!value) return {}
  if (typeof value !== 'string') return isRecord(value) ? value : {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeKeywordCandidate(value: string): string {
  return String(value || '')
    .replace(/[，。；、,.!?！？;:：()[\]{}"'“”‘’<>《》]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractCandidateTerms(text: string, limit = 10): string[] {
  const source = String(text || '')
  const quoted = [...source.matchAll(/[“"《]([^”"》]{2,30})[”"》]/g)].map((match) => match[1])
  const chinese = source.match(/[\u4e00-\u9fa5]{2,12}/g) || []
  const latin = source.match(/[A-Za-z][A-Za-z0-9_-]{2,}(?:\s+[A-Za-z][A-Za-z0-9_-]{2,}){0,2}/g) || []
  return uniqueStrings([...quoted, ...chinese, ...latin].map(normalizeKeywordCandidate), limit)
    .filter((term) => term.length >= 2 && !isQuestionLike(term))
}

function selectRepresentativePagesForRefinement(pages: EvidenceQaClusterPage[], maxPages = 5): EvidenceQaClusterPage[] {
  if (pages.length <= maxPages) return pages
  const selected = new Map<number, EvidenceQaClusterPage>()
  const add = (page?: EvidenceQaClusterPage) => {
    if (page) selected.set(page.page_num, page)
  }
  pages.slice(0, 2).forEach(add)
  add(pages[Math.floor(pages.length / 2)])
  pages.slice(-2).forEach(add)
  return [...selected.values()].sort((left, right) => left.page_num - right.page_num).slice(0, maxPages)
}

async function buildRefinementContext(docIds: string[], question: string): Promise<{
  briefs: AiDocumentBrief[]
  context: string
}> {
  const briefs: AiDocumentBrief[] = []
  const blocks: string[] = []
  let usedChars = 0

  for (const docId of docIds.slice(0, MAX_REFINEMENT_DOCS)) {
    const doc = queryOne<EvidenceRefinementDocumentRow>('SELECT id, title, author, doc_type, dynasty, metadata FROM documents WHERE id = ?', [docId])
    if (!doc) continue

    let brief: AiDocumentBrief | null = null
    try {
      brief = await getDocumentBrief(docId)
      if (brief) briefs.push(brief)
    } catch (error) {
      console.warn('[EvidenceQA] Failed to load document brief for query refinement', error)
    }

    const metadata = parseMetadata(doc.metadata)
    const metadataText = [
      metadata.abstract,
      metadata.summary,
      metadata.keywords,
      metadata.keyword,
      metadata.subject,
      metadata.description,
    ].filter(Boolean).join('；')
    const pages = selectRepresentativePagesForRefinement(getDocumentTextPages(docId), 5)
    const pageText = pages
      .map((page) => `第 ${page.page_num} 页：${truncateText(page.text, 420)}`)
      .join('\n')
    const block = [
      `【文献】${doc.title || brief?.title || '未命名文献'}${doc.author || brief?.author ? ` / ${doc.author || brief?.author}` : ''}`,
      doc.doc_type || doc.dynasty ? `类型/年代：${[doc.doc_type, doc.dynasty].filter(Boolean).join(' / ')}` : '',
      metadataText ? `元数据摘要：${truncateText(metadataText, 700)}` : '',
      brief?.summary ? `AI 摘要：${truncateText(brief.summary, 800)}` : '',
      brief?.keywords?.length ? `AI 关键词：${brief.keywords.slice(0, 12).join('、')}` : '',
      brief?.toc?.length ? `目录线索：${brief.toc.slice(0, 10).map((item) => item.title).join('、')}` : '',
      pageText ? `正文样本：\n${pageText}` : '',
    ].filter(Boolean).join('\n')

    if (!block.trim()) continue
    if (usedChars + block.length > MAX_REFINEMENT_CONTEXT_CHARS) break
    usedChars += block.length
    blocks.push(block)
  }

  return {
    briefs,
    context: [
      `用户问题：${question}`,
      '',
      blocks.join('\n\n---\n\n'),
    ].join('\n').trim(),
  }
}

function buildLocalRefinementRounds(question: string, plan: EvidenceQaPlan, briefs: AiDocumentBrief[]): QueryRefinementRound[] {
  const currentQuestion = extractCurrentQuestion(question)
  const allowBriefTerms = isQuestionLike(currentQuestion) && !isLikelyDirectSearchPhrase(currentQuestion)
  const titleTerms = allowBriefTerms ? briefs.flatMap((brief) => extractCandidateTerms(brief.title, 4)) : []
  const briefTerms = allowBriefTerms
    ? briefs.flatMap((brief) => [
      ...brief.keywords,
      ...brief.toc.map((item) => item.title),
      ...brief.key_points.flatMap((item) => extractCandidateTerms(item, 3)),
    ])
    : []
  const questionTerms = extractCandidateTerms(`${question} ${plan.intent}`, 12)
  const semanticTerms = uniqueStrings([
    ...plan.keywords,
    ...plan.expandedKeywords,
    ...questionTerms,
    ...briefTerms.flatMap((item) => extractCandidateTerms(String(item), 3)),
  ], 36)

  return [
    {
      reason: '根据文献标题和目录线索改用更贴近原文的词',
      queries: uniqueStrings([...titleTerms, ...semanticTerms], 10),
    },
    {
      reason: '根据摘要/正文样本改用主题词和同义表达',
      queries: uniqueStrings([...semanticTerms, ...briefs.flatMap((brief) => brief.keywords)], 12),
    },
  ].filter((round) => round.queries.length > 0)
}

async function buildAiRefinementRounds(
  question: string,
  plan: EvidenceQaPlan,
  failedQueries: string[],
  context: string,
): Promise<QueryRefinementRound[]> {
  if (!context.trim()) return []
  try {
    const prompt = [
      '你是文献库检索调优助手。首轮关键词没有命中，现在请根据文献标题、摘要、目录和正文样本，重写多轮本地全文检索词。',
      '只输出 JSON，不要解释。格式：{"rounds":[{"reason":"","queries":[]}]}',
      '要求：',
      '1. 给出 2-3 轮，每轮 4-8 个查询词。',
      '2. 查询词要短而准，优先使用正文中可能出现的人名、地名、制度名、章节词、同义词或历史称谓。',
      '3. 不要重复已经失败的词，不要输出完整问题句。',
      '4. 如果用户问“区别/比较/有什么差异”，要搜索可承载比较的对象词，而不是只搜“差异”。',
      '',
      `检索意图：${plan.intent}`,
      `首轮失败关键词：${failedQueries.join('、')}`,
      '',
      context,
    ].join('\n')
    const raw = await callLLM([{ role: 'user', content: prompt }])
    const parsed: unknown = JSON.parse(String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim())
    const rounds: AiRefinementRoundDraft[] = isRecord(parsed) && Array.isArray(parsed.rounds)
      ? parsed.rounds.filter(isRecord)
      : []
    return rounds
      .map((round) => ({
        reason: String(round?.reason || '根据文献内容重写检索词').trim(),
        queries: uniqueStrings((Array.isArray(round?.queries) ? round.queries : [])
          .map((item: unknown) => normalizeKeywordCandidate(String(item || ''))), 8)
          .filter((query) => query.length >= 2 && !isQuestionLike(query)),
      }))
      .filter((round: QueryRefinementRound) => round.queries.length > 0)
      .slice(0, MAX_REFINEMENT_ROUNDS)
  } catch (error) {
    console.warn('[EvidenceQA] Query refinement failed, using local fallback', error)
    return []
  }
}

function mergeSearchOutcomes(base: EvidenceSearchOutcome, next: EvidenceSearchOutcome): EvidenceSearchOutcome {
  return {
    results: [...base.results, ...next.results],
    expandedQueries: uniqueStrings([...base.expandedQueries, ...next.expandedQueries], MAX_QUERIES * MAX_REFINEMENT_ROUNDS),
    warnings: [...base.warnings, ...next.warnings],
  }
}

async function refineSearchEvidence(
  question: string,
  plan: EvidenceQaPlan,
  docIds: string[] | undefined,
  scope: EvidenceQaScope | undefined,
  firstSearch: EvidenceSearchOutcome,
  options?: { limit?: number },
): Promise<EvidenceSearchOutcome> {
  const refinementDocIds = getRefinementDocumentIds(scope, docIds)
  if (refinementDocIds.length === 0) return firstSearch
  if (isLikelyDirectSearchPhrase(extractCurrentQuestion(question))) {
    return {
      ...firstSearch,
      warnings: [...firstSearch.warnings, '首轮未命中；问题被识别为具体词条/片段查找，未扩展为无关文献主题。'],
    }
  }

  const { briefs, context } = await buildRefinementContext(refinementDocIds, question)
  const aiRounds = await buildAiRefinementRounds(question, plan, firstSearch.expandedQueries, context)
  const localRounds = buildLocalRefinementRounds(question, plan, briefs)
  const rounds = [...aiRounds, ...localRounds].slice(0, MAX_REFINEMENT_ROUNDS)
  if (rounds.length === 0) return {
    ...firstSearch,
    warnings: [...firstSearch.warnings, '首轮未命中；已读取文献摘要/正文样本，但没有生成可用的改写检索词。'],
  }

  let combined = {
    ...firstSearch,
    warnings: [...firstSearch.warnings, `首轮未命中；已读取 ${refinementDocIds.length} 篇文献的摘要/正文样本并启动多轮检索。`],
  }
  const usedQueries = new Set(firstSearch.expandedQueries.map((query) => query.toLowerCase()))

  rounds.forEach((round, index) => {
    if (combined.results.length > 0) return
    const queries = round.queries.filter((query) => {
      const key = query.toLowerCase()
      if (usedQueries.has(key)) return false
      usedQueries.add(key)
      return true
    })
    if (queries.length === 0) return
    const roundPlan: EvidenceQaPlan = {
      ...plan,
      keywords: queries,
      expandedKeywords: [],
      notes: [plan.notes, `第 ${index + 2} 轮检索：${round.reason}`].filter(Boolean).join('；'),
    }
    const roundSearch = searchEvidence(question, roundPlan, docIds, options)
    combined = mergeSearchOutcomes(combined, {
      ...roundSearch,
      warnings: [...roundSearch.warnings, `第 ${index + 2} 轮检索词：${queries.join('、')}`],
    })
  })

  return combined
}

function getDocTitle(docId: string): string {
  return queryOne<{ title: string }>('SELECT title FROM documents WHERE id = ?', [docId])?.title || '未命名文献'
}

function getPageText(docId: string, pageNum: number): string {
  const page = queryOne<{ text: string }>(
    "SELECT COALESCE(NULLIF(proofed_text, ''), NULLIF(ocr_text, ''), '') as text FROM pages WHERE doc_id = ? AND page_num = ?",
    [docId, pageNum],
  )
  return String(page?.text || '').trim()
}

function getPageWindow(docId: string, pageNum: number, radius: number): EvidenceQaClusterPage[] {
  const start = Math.max(1, pageNum - radius)
  const end = pageNum + radius
  return queryAll<{ page_num: number; text: string }>(
    "SELECT page_num, COALESCE(NULLIF(proofed_text, ''), NULLIF(ocr_text, ''), '') as text FROM pages WHERE doc_id = ? AND page_num BETWEEN ? AND ? ORDER BY page_num",
    [docId, start, end],
  )
    .map((page) => ({
      page_num: Number(page.page_num),
      text: truncateText(page.text || '', MAX_PAGE_TEXT_CHARS),
      role: page.page_num === pageNum ? 'hit' as const : page.page_num < pageNum ? 'before' as const : 'after' as const,
    }))
    .filter((page) => page.text)
}

function getDocumentTextPages(docId: string): EvidenceQaClusterPage[] {
  return queryAll<{ page_num: number; text: string }>(
    "SELECT page_num, COALESCE(NULLIF(proofed_text, ''), NULLIF(ocr_text, ''), '') as text FROM pages WHERE doc_id = ? ORDER BY page_num",
    [docId],
  )
    .map((page) => ({
      page_num: Number(page.page_num),
      text: truncateText(page.text || '', MAX_PAGE_TEXT_CHARS),
      role: 'hit' as const,
    }))
    .filter((page) => page.text)
}

function selectOverviewPages(pages: EvidenceQaClusterPage[]): EvidenceQaClusterPage[] {
  if (pages.length <= MAX_OVERVIEW_PAGES_PER_CLUSTER) return pages
  const lastIndex = pages.length - 1
  const indexes = new Set<number>()
  for (let index = 0; index < MAX_OVERVIEW_PAGES_PER_CLUSTER; index += 1) {
    const ratio = index / (MAX_OVERVIEW_PAGES_PER_CLUSTER - 1)
    indexes.add(Math.round(lastIndex * ratio))
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => pages[index])
    .filter(Boolean)
}

function resolveOverviewDocumentIds(scope: EvidenceQaScope | undefined, docIds: string[] | undefined): string[] {
  if (docIds) return uniqueStrings(docIds, MAX_CLUSTERS)
  if (scope && scope.type !== 'all') return []
  return queryAll<{ id: string }>(
    `SELECT d.id
     FROM documents d
     WHERE EXISTS (
       SELECT 1
       FROM pages p
       WHERE p.doc_id = d.id
         AND COALESCE(NULLIF(p.proofed_text, ''), NULLIF(p.ocr_text, ''), '') <> ''
     )
     ORDER BY d.is_favorite DESC, COALESCE(d.last_opened_at, d.updated_at) DESC, d.updated_at DESC
     LIMIT ?`,
    [MAX_CLUSTERS],
  ).map((item) => item.id)
}

function makeSourceFromResult(result: EvidenceSearchResult): EvidenceQaSource {
  const snippet = stripSnippetMarkers(result.snippet || '')
  return {
    doc_id: result.doc_id,
    doc_title: result.doc_title || getDocTitle(result.doc_id),
    page_num: result.page_num || result.locator?.pageNum || null,
    snippet,
    locator: result.locator,
    rank: result.rank,
    matched_query: result.matched_query || result.locator?.queryTerm || '',
    source_hash: hashSource(`${result.doc_id}:${result.page_num || ''}:${snippet}`),
  }
}

function buildEvidenceClusters(results: EvidenceSearchResult[]): EvidenceQaCluster[] {
  const grouped = new Map<string, EvidenceSearchResult[]>()
  results.forEach((result) => {
    const pageNum = Number(result.page_num || result.locator?.pageNum || 0)
    if (!result.doc_id || !pageNum) return
    const key = `${result.doc_id}:${pageNum}`
    const bucket = grouped.get(key) || []
    bucket.push(result)
    grouped.set(key, bucket)
  })

  return [...grouped.entries()]
    .map(([key, items]) => {
      const [docId, pageText] = key.split(':')
      const pageNum = Number(pageText)
      const docTitle = items[0]?.doc_title || getDocTitle(docId)
      const anchorText = getPageText(docId, pageNum)
      const radius = anchorText.length < MIN_TEXT_FOR_WIDE_RADIUS || items.length >= 3 ? 2 : 1
      const pages = getPageWindow(docId, pageNum, radius)
      const sources = items.slice(0, 4).map(makeSourceFromResult)
      const pageNums = pages.map((page) => page.page_num)
      return {
        id: hashSource(key),
        doc_id: docId,
        doc_title: docTitle,
        anchor_page_num: pageNum,
        page_range: [Math.min(...pageNums, pageNum), Math.max(...pageNums, pageNum)] as [number, number],
        score: items.reduce((sum, item) => sum + Number(item.relevance_score || 1), 0),
        queries: uniqueStrings(items.map((item) => item.matched_query || item.locator?.queryTerm)),
        hit_count: items.length,
        pages,
        sources,
      } satisfies EvidenceQaCluster
    })
    .filter((cluster) => cluster.pages.length > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_CLUSTERS)
}

function buildDocumentOverviewClusters(docIds: string[]): EvidenceQaCluster[] {
  const documentIds = uniqueStrings(docIds, MAX_CLUSTERS)
  const clusters: EvidenceQaCluster[] = []
  const perDocLimit = Math.max(1, Math.floor(MAX_CLUSTERS / Math.max(1, documentIds.length)))

  for (const docId of documentIds) {
    const pages = getDocumentTextPages(docId)
    if (pages.length === 0) continue
    const docTitle = getDocTitle(docId)
    const chunkSize = Math.max(1, Math.ceil(pages.length / perDocLimit))
    for (let index = 0; index < pages.length && clusters.length < MAX_CLUSTERS; index += chunkSize) {
      const chunk = pages.slice(index, index + chunkSize)
      const pageNums = chunk.map((page) => page.page_num)
      const overviewPages = selectOverviewPages(chunk).map((page) => ({
        ...page,
        text: truncateText(page.text, MAX_OVERVIEW_PAGE_TEXT_CHARS),
      }))
      const snippet = stripSnippetMarkers(overviewPages.map((page) => `第 ${page.page_num} 页：${page.text}`).join(' ').slice(0, 420))
      const source: EvidenceQaSource = {
        doc_id: docId,
        doc_title: docTitle,
        page_num: overviewPages[0]?.page_num || pageNums[0] || null,
        snippet,
        rank: clusters.length,
        matched_query: OVERVIEW_QUERY_LABEL,
        source_hash: hashSource(`${docId}:overview:${pageNums.join('-')}:${snippet}`),
      }
      clusters.push({
        id: hashSource(`${docId}:overview:${pageNums.join('-')}`),
        doc_id: docId,
        doc_title: docTitle,
        anchor_page_num: pageNums[0] || null,
        page_range: [Math.min(...pageNums), Math.max(...pageNums)] as [number, number],
        score: Math.max(1, pages.length - index),
        queries: [OVERVIEW_QUERY_LABEL],
        hit_count: chunk.length,
        pages: overviewPages,
        sources: [source],
      })
    }
  }

  return clusters
}

function isOverviewEvidence(plan: EvidenceQaPlan, expandedQueries: string[]): boolean {
  return plan.keywords.includes(OVERVIEW_QUERY_LABEL) || expandedQueries.includes(OVERVIEW_QUERY_LABEL)
}

function buildPrompt(question: string, clusters: EvidenceQaCluster[], plan: EvidenceQaPlan, expandedQueries: string[]): string {
  const overviewEvidence = isOverviewEvidence(plan, expandedQueries)
  let usedChars = 0
  const clusterText: string[] = []
  for (let index = 0; index < clusters.length; index += 1) {
    const cluster = clusters[index]
    const sources = cluster.sources
      .slice(0, 4)
      .map((source, sourceIndex) => `S${index + 1}.${sourceIndex + 1} ${source.doc_title} 第 ${source.page_num || '?'} 页：${source.snippet}`)
      .join('\n')
    const pages = cluster.pages
      .map((page) => `[${overviewEvidence ? '正文页' : page.role === 'hit' ? '命中页' : page.role === 'before' ? '前页' : '后页'} 第 ${page.page_num} 页]\n${page.text}`)
      .join('\n\n')
    const block = [
      overviewEvidence
        ? `【正文摘读 ${index + 1}】${cluster.doc_title}，取自第 ${cluster.page_range[0]}-${cluster.page_range[1]} 页，共 ${cluster.hit_count} 页可读 OCR，下面列出代表性页段`
        : `【证据组 ${index + 1}】${cluster.doc_title}，第 ${cluster.page_range[0]}-${cluster.page_range[1]} 页，关键词：${cluster.queries.join('、')}`,
      sources,
      pages,
    ].join('\n')
    if (usedChars + block.length > MAX_CONTEXT_CHARS) break
    usedChars += block.length
    clusterText.push(block)
  }

  return [
    '你是文献管理（GujiSmart）的严格证据型研究助手。',
    '只允许根据下面提供的“证据组/正文摘读”回答问题；不得使用书外知识，不得编造页码、章节、作者观点。',
    ...(overviewEvidence ? [
      '当前任务是“全文概览”：下方“正文摘读”来自当前文献 OCR 正文的页段抽样，不是关键词检索结果。',
      '只要正文摘读中有可读文本，就应基于这些材料概括这篇文献讲了什么；不要回答“关键词全文概览未命中”。',
      '如果 OCR 存在缺页、乱码或图片标签，请说明概括受限，但仍要先概括可读内容；只有完全没有正文摘读时才写“证据不足”。',
    ] : []),
    '如果问题要求“综述、总结、趋势、脉络、空白、难点、方向”，请先综合证据给出总体判断，再按主题或阶段归纳，不要按证据组、检索结果或文献顺序逐条复述。',
    '请把回答限定为“当前检索范围内的文献显示/提示”，不要把有限命中直接说成整个领域的完整结论。',
    '优先输出可用于研究写作的结构：总体判断、主要主题/趋势、证据支撑、研究空白或下一步问题。',
    '每个具体结论都必须标注来源，格式为（《文献标题》，第 X 页）。',
    '如果证据不足以回答，请先写“证据不足”，再说明已经检索的关键词和缺口。',
    '',
    `问题：${question}`,
    `检索意图：${plan.intent}`,
    overviewEvidence
      ? '取证方式：全文概览（按当前范围 OCR 正文页段读取）'
      : `检索关键词：${expandedQueries.join('、')}`,
    '',
    clusterText.length ? clusterText.join('\n\n---\n\n') : '没有可用证据组。',
  ].join('\n')
}

async function answerFromEvidence(
  question: string,
  clusters: EvidenceQaCluster[],
  plan: EvidenceQaPlan,
  expandedQueries: string[],
): Promise<string> {
  if (clusters.length === 0) {
    return [
      '证据不足。',
      `已检索关键词：${expandedQueries.join('、') || question}`,
      '当前范围内没有命中足够的 OCR 文本证据。请换用更具体的人名、地名、术语或先完成 OCR/校对。',
    ].join('\n')
  }
  return callLLM([{ role: 'user', content: buildPrompt(question, clusters, plan, expandedQueries) }])
}

function flattenSources(clusters: EvidenceQaCluster[]): EvidenceQaSource[] {
  const seen = new Set<string>()
  const sources: EvidenceQaSource[] = []
  clusters.forEach((cluster) => {
    cluster.sources.forEach((source) => {
      const key = `${source.doc_id}:${source.page_num || ''}:${source.source_hash || source.snippet.slice(0, 80)}`
      if (seen.has(key)) return
      seen.add(key)
      sources.push(source)
    })
  })
  return sources.slice(0, 16)
}

export async function buildEvidenceForQuestion(
  question: string,
  scope?: EvidenceQaScope,
  options?: { limit?: number },
): Promise<{
  trimmed: string
  plan: EvidenceQaPlan
  expandedQueries: string[]
  clusters: EvidenceQaCluster[]
  sources: EvidenceQaSource[]
  warnings: string[]
  emptyAnswer?: string
}> {
  const trimmed = String(question || '').trim()
  if (!trimmed) throw new Error('问题不能为空')

  const docIds = normalizeScopeDocumentIds(scope)
  if (docIds && docIds.length === 0) {
    return {
      trimmed,
      plan: fallbackPlan(trimmed),
      expandedQueries: [],
      clusters: [],
      sources: [],
      warnings: ['当前范围内没有可用文献。'],
      emptyAnswer: '证据不足。\n当前范围内没有可用文献。',
    }
  }

  if (scope && scope.type !== 'documents') {
    const preview = previewLibraryAiScope(scope)
    if (preview.count === 0 || preview.ocrReadyCount === 0) {
      return {
        trimmed,
        plan: fallbackPlan(trimmed),
        expandedQueries: [],
        clusters: [],
        sources: [],
        warnings: ['当前范围内没有可用的 OCR 文本。'],
        emptyAnswer: '证据不足。\n当前范围内没有可用的 OCR 文本，请先完成 OCR 或调整范围。',
      }
    }
  }

  if (isOverviewQuestion(trimmed)) {
    const overviewDocIds = resolveOverviewDocumentIds(scope, docIds)
    const clusters = buildDocumentOverviewClusters(overviewDocIds)
    const plan = overviewPlan(trimmed)
    if (clusters.length === 0) {
      return {
        trimmed,
        plan,
        expandedQueries: [OVERVIEW_QUERY_LABEL],
        clusters: [],
        sources: [],
        warnings: ['当前范围内没有可用于全文概览的 OCR 文本。'],
        emptyAnswer: '证据不足。\n当前范围内没有可用于全文概览的 OCR 文本，请先完成 OCR 或调整范围。',
      }
    }
    return {
      trimmed,
      plan,
      expandedQueries: [OVERVIEW_QUERY_LABEL],
      clusters,
      sources: flattenSources(clusters),
      warnings: [],
    }
  }

  const { plan, warnings: planWarnings } = await buildEvidencePlan(trimmed)
  const firstSearch = searchEvidence(trimmed, plan, docIds, options)
  const search = firstSearch.results.length > 0
    ? firstSearch
    : await refineSearchEvidence(trimmed, plan, docIds, scope, firstSearch, options)
  if (search.results.length === 0) {
    return {
      trimmed,
      plan,
      expandedQueries: search.expandedQueries,
      clusters: [],
      sources: [],
      warnings: [...planWarnings, ...search.warnings],
      emptyAnswer: [
        '证据不足。',
        `已检索关键词：${search.expandedQueries.join('、') || trimmed}`,
        '当前范围内没有命中足够的 OCR 文本证据。',
      ].join('\n'),
    }
  }

  const clusters = buildEvidenceClusters(search.results)
  return {
    trimmed,
    plan,
    expandedQueries: search.expandedQueries,
    clusters,
    sources: flattenSources(clusters),
    warnings: [...planWarnings, ...search.warnings],
  }
}

export async function answerEvidenceStream(
  question: string,
  clusters: EvidenceQaCluster[],
  plan: EvidenceQaPlan,
  expandedQueries: string[],
  onDelta: (delta: string) => void,
): Promise<string> {
  if (clusters.length === 0) return answerFromEvidence(question, clusters, plan, expandedQueries)
  return callLLMStream([{ role: 'user', content: buildPrompt(question, clusters, plan, expandedQueries) }], onDelta)
}

export async function askWithEvidence(
  question: string,
  scope?: EvidenceQaScope,
  options?: { limit?: number },
): Promise<EvidenceQaResponse> {
  const evidence = await buildEvidenceForQuestion(question, scope, options)
  const answer = evidence.emptyAnswer
    || await answerFromEvidence(evidence.trimmed, evidence.clusters, evidence.plan, evidence.expandedQueries)

  return {
    answer,
    sources: evidence.sources,
    plan: evidence.plan,
    expandedQueries: evidence.expandedQueries,
    evidenceClusters: evidence.clusters,
    warnings: evidence.warnings,
  }
}

export async function askDocumentWithEvidence(
  docId: string,
  question: string,
  options?: { limit?: number },
): Promise<EvidenceQaResponse> {
  const documentId = String(docId || '').trim()
  if (!documentId) throw new Error('文献 ID 不能为空')
  return askWithEvidence(question, { type: 'documents', docIds: [documentId] }, options)
}
