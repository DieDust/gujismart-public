import { createHash } from 'crypto'
import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { callLLM } from '../ai'
import { queryAll, queryOne, run, saveDatabase } from '../database'
import { fullTextSearch } from '../semantic-search'
import { getErrorMessage } from '../../shared/errors'
import { resolveFolderAndDescendantIds } from '../folder-scope'
import {
  captureActiveLibraryProjectId,
  getActiveLibraryProjectId,
  withLibraryProjectContext,
} from '../library-projects'
import {
  buildResearchSeedQueries,
  evidenceItemToSearchResult,
  expandRelatedResearchQueries,
  extractExplicitCoreResearchQueries,
  getLatestResearchEvidencePack,
  getLatestResearchRetrievalStats,
  normalizeAiResearchTaskKind,
  previewResearchRetrieval,
  runResearchRetrievalForTask,
} from '../ai-research-retrieval'
import {
  createResearchOutputInputSnapshot,
  stringifyResearchOutputInputSnapshot,
} from '../../shared/research-output-snapshot'
import { commitExistingResearchRecordUpdate, createResearchOutputVersion } from '../research-repository'
import type {
  AiResearchCreateTaskPayload,
  AiResearchDataset,
  AiResearchEvidencePack,
  AiResearchExportResult,
  AiResearchFieldSchema,
  AiResearchPlan,
  AiResearchPlanPayload,
  AiResearchRecord,
  AiResearchRecordListOptions,
  AiResearchRecordStatus,
  AiResearchRecordUpdatePayload,
  AiResearchReportPayload,
  AiResearchRetrievalPreviewPayload,
  AiResearchRetrievalRunResult,
  AiResearchRetrievalStats,
  AiResearchRunResult,
  AiResearchTask,
  AiResearchTaskStep,
  AiSynthesisTemplate,
  LibraryAiScope,
  SearchResult,
} from '../../shared/types'

type JsonRecord = Record<string, unknown>

const DEFAULT_FIELDS: AiResearchFieldSchema[] = [
  { key: 'time', label: '时间', type: 'date', description: '材料中出现的时间、年代或阶段' },
  { key: 'place', label: '地点', type: 'place', description: '材料涉及的地点、区域或空间范围' },
  { key: 'subject', label: '对象', type: 'text', description: '人物、机构、事项或研究对象' },
  { key: 'event', label: '事件/数据', type: 'text', description: '需要抽取的事实、数据、现象或论点' },
  { key: 'theme', label: '主题分类', type: 'category', description: '归纳后的主题或类型' },
]
const MAX_PLAN_FIELDS = 10
const MAX_QUERIES = 16
const MAX_RECORDS_PER_RUN = 80
const FALLBACK_QUERY_LIMIT = 16
const MAX_SEARCH_ROUNDS = 10
const QUERIES_PER_ROUND = 8

interface CandidateHitCollection {
  hits: SearchResult[]
  strategy: 'keyword' | 'expanded-keyword' | 'iterative-keyword'
  searchedQueryCount: number
  rounds: number
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed as T
  } catch {
    return fallback
  }
}

function parseJsonObject(raw: string): JsonRecord {
  const cleaned = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const candidate = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned
  const parsed = JSON.parse(candidate) as unknown
  if (!isRecord(parsed)) throw new Error('AI 返回内容不是 JSON 对象')
  return parsed
}

function uniqueStrings(values: Array<string | null | undefined>, limit = Number.MAX_SAFE_INTEGER): string[] {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, limit)
}

function normalizeKey(value: unknown, fallback: string): string {
  const key = String(value || '')
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (key || fallback).slice(0, 40)
}

function normalizeFields(value: unknown): AiResearchFieldSchema[] {
  const rawFields = Array.isArray(value) ? value : []
  const fields = rawFields
    .filter(isRecord)
    .map((field, index) => ({
      key: normalizeKey(field.key || field.label, `field_${index + 1}`),
      label: String(field.label || field.key || `字段 ${index + 1}`).trim().slice(0, 30),
      type: String(field.type || 'text') as AiResearchFieldSchema['type'],
      description: String(field.description || '').trim().slice(0, 160) || undefined,
      required: Boolean(field.required),
    }))
    .filter((field) => field.key && field.label)
  return fields.length > 0 ? fields.slice(0, MAX_PLAN_FIELDS) : DEFAULT_FIELDS
}

function normalizePlan(value: unknown, payload: AiResearchPlanPayload): AiResearchPlan {
  const record = isRecord(value) ? value : {}
  const aiQueries = buildResearchSeedQueries(Array.isArray(record.suggestedQueries) ? record.suggestedQueries.map(String) : [], MAX_QUERIES)
  const explicitGoalQueries = buildResearchSeedQueries([payload.goal], MAX_QUERIES)
  const coreQueries = extractExplicitCoreResearchQueries([payload.goal, ...aiQueries], 8)
  const expandedQueries = expandRelatedResearchQueries([...coreQueries, ...explicitGoalQueries, ...aiQueries, payload.goal], MAX_QUERIES)
  return {
    title: String(record.title || payload.goal || 'AI 研究任务').trim().slice(0, 80) || 'AI 研究任务',
    goal: String(record.goal || payload.goal || '').trim(),
    kind: normalizeAiResearchTaskKind(record.kind, payload.goal),
    fields: normalizeFields(record.fields),
    suggestedQueries: expandedQueries.length > 0 ? expandedQueries : uniqueStrings([...coreQueries, ...explicitGoalQueries], MAX_QUERIES),
    notes: String(record.notes || '').trim() || undefined,
  }
}

function rowToTask(row: AiResearchTask | null): AiResearchTask {
  if (!row) throw new Error('未找到 AI 研究任务')
  return {
    ...row,
    kind: normalizeAiResearchTaskKind(row.kind, row.goal),
    fieldSchema: normalizeFields(safeJsonParse<unknown>(row.field_schema_json, [])),
    suggestedQueries: uniqueStrings(safeJsonParse<string[]>(row.suggested_queries_json, []), MAX_QUERIES),
  }
}

function rowToDataset(row: AiResearchDataset | null): AiResearchDataset {
  if (!row) throw new Error('未找到 AI 数据集')
  return {
    ...row,
    fieldSchema: normalizeFields(safeJsonParse<unknown>(row.field_schema_json, [])),
  }
}

function rowToRecord(row: AiResearchRecord | null): AiResearchRecord {
  if (!row) throw new Error('未找到 AI 研究记录')
  return {
    ...row,
    values: safeJsonParse<Record<string, string>>(row.values_json, {}),
  }
}

function makeSourceHash(parts: Array<string | number | null | undefined>): string {
  const hash = createHash('sha1')
  parts.forEach((part) => {
    hash.update(String(part ?? ''))
    hash.update('\u0000')
  })
  return hash.digest('hex').slice(0, 24)
}

function getDocumentIdsForScope(scope: LibraryAiScope): string[] | undefined {
  const activeProjectId = getActiveLibraryProjectId()
  if (scope.type === 'documents') {
    const docIds = uniqueStrings(scope.docIds || [])
    if (docIds.length === 0) return []
    return queryAll<{ id: string }>(
      `SELECT id
       FROM documents
       WHERE id IN (${docIds.map(() => '?').join(', ')})
         AND EXISTS (
           SELECT 1 FROM library_project_documents project_scope
           WHERE project_scope.document_id = documents.id
             AND project_scope.project_id = ?
         )`,
      [...docIds, activeProjectId],
    ).map((item) => item.id)
  }
  if (scope.type === 'tags') {
    const tagIds = uniqueStrings(scope.tagIds || [])
    if (tagIds.length === 0) return []
    let sql = 'SELECT d.id FROM documents d'
    const params: string[] = []
    tagIds.forEach((tagId, index) => {
      const alias = `dt_ai_research_${index}`
      sql += ` INNER JOIN document_tags ${alias} ON d.id = ${alias}.doc_id AND ${alias}.tag_id = ?`
      params.push(tagId)
    })
    sql += ' WHERE EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?) GROUP BY d.id ORDER BY d.updated_at DESC'
    params.push(activeProjectId)
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
         AND EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)
       ORDER BY d.updated_at DESC`,
      [...folderIds, activeProjectId],
    ).map((item) => item.id)
  }
  return undefined
}

async function planTask(payload: AiResearchPlanPayload): Promise<AiResearchPlan> {
  const goal = String(payload.goal || '').trim()
  if (!goal) throw new Error('请输入研究目标')
  const prompt = [
    '你是 GujiSmart 的文献研究助手。请把用户目标转成“本地文库结构化抽取任务”的字段方案。',
    '只返回 JSON，不要 Markdown。',
    'JSON 格式：{"title":"","goal":"","kind":"statistical|extraction|synthesis|mixed","fields":[{"key":"","label":"","type":"text|number|date|place|person|category|quote","description":"","required":false}],"suggestedQueries":[""],"notes":""}',
    'suggestedQueries 必须是可直接用于本地全文检索的关键词数组：一个实体、概念、人名、地名、机构名、主题词或相关同义词占一项。',
    '先保留用户明确写出的核心实体，再基于研究意图补充少量同义词、历史称谓、简称、相关机构或主题词；总数控制在 4 到 16 个。',
    '不要把完整问题、统计口令、句子、带“的”的短语、多个实体粘在同一项里；如果用户连续写了多个实体，必须拆成多项独立关键词。',
    '不要输出“有多少、出现次数、出现频率、篇幅、统计、分布、趋势、相关”等任务说明词作为检索词。',
    '如果用户目标包含“多少、数量、篇幅、频率、分布”等问题，kind 应为 statistical 或 mixed；如果既要统计又要解释证据，kind 用 mixed。',
    '字段必须适合后续做时空归类、证据表格和规律总结。',
    '必须包含原文证据相关字段以外的分析字段；来源文献、页码、原文片段由系统自动保存，不要作为 fields 重复输出。',
    `用户目标：${goal}`,
  ].join('\n')
  try {
    return normalizePlan(parseJsonObject(await callLLM([{ role: 'user', content: prompt }])), payload)
  } catch (error) {
    console.warn('[AI Research] Failed to plan with AI, using fallback plan:', error)
    return normalizePlan({ title: goal.slice(0, 40), goal, fields: DEFAULT_FIELDS, suggestedQueries: [goal] }, payload)
  }
}

function createTask(payload: AiResearchCreateTaskPayload): AiResearchTask {
  const libraryProjectId = getActiveLibraryProjectId()
  const goal = String(payload.goal || '').trim()
  if (!goal) throw new Error('请输入研究目标')
  const fields = normalizeFields(payload.fields)
  const explicitQueries = buildResearchSeedQueries(payload.suggestedQueries || [], MAX_QUERIES)
  const goalQueries = buildResearchSeedQueries([goal], MAX_QUERIES)
  const coreQueries = extractExplicitCoreResearchQueries([goal, ...explicitQueries], 8)
  const queries = expandRelatedResearchQueries([...coreQueries, ...goalQueries, ...explicitQueries, goal], MAX_QUERIES)
  const kind = normalizeAiResearchTaskKind(payload.kind, goal)
  const id = nanoid()
  const now = new Date().toISOString()
  if (payload.projectId && !queryOne(
    'SELECT 1 FROM research_projects WHERE id = ? AND library_project_id = ?',
    [payload.projectId, libraryProjectId],
  )) {
    throw new Error('Research project does not belong to the active library project')
  }
  run(
    `INSERT INTO ai_research_tasks (
      id, library_project_id, project_id, title, goal, kind, scope_json, field_schema_json, suggested_queries_json, status, error_message, dataset_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '', NULL, ?, ?)`,
    [
      id,
      libraryProjectId,
      payload.projectId || null,
      String(payload.title || goal).trim().slice(0, 80) || 'AI 研究任务',
      goal,
      kind,
      JSON.stringify(payload.scope || { type: 'all' }),
      JSON.stringify(fields),
      JSON.stringify(queries),
      now,
      now,
    ],
  )
  saveDatabase()
  return getTask(id)
}

function getTask(taskId: string): AiResearchTask {
  const libraryProjectId = getActiveLibraryProjectId()
  const task = rowToTask(queryOne<AiResearchTask>(
    'SELECT * FROM ai_research_tasks WHERE id = ? AND library_project_id = ?',
    [taskId, libraryProjectId],
  ))
  task.record_count = Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM ai_research_records WHERE task_id = ?', [taskId])?.count || 0)
  return task
}

function listTasks(projectId?: string | null): AiResearchTask[] {
  const libraryProjectId = getActiveLibraryProjectId()
  const rows = projectId
    ? queryAll<AiResearchTask>(
        'SELECT * FROM ai_research_tasks WHERE library_project_id = ? AND project_id = ? ORDER BY updated_at DESC',
        [libraryProjectId, projectId],
      )
    : queryAll<AiResearchTask>(
        'SELECT * FROM ai_research_tasks WHERE library_project_id = ? ORDER BY updated_at DESC',
        [libraryProjectId],
      )
  return rows.map((row) => {
    const task = rowToTask(row)
    task.record_count = Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM ai_research_records WHERE task_id = ?', [task.id])?.count || 0)
    return task
  })
}

function upsertStep(taskId: string, stepKey: string, title: string, status: AiResearchTaskStep['status'], message: string, progress: number): void {
  const now = new Date().toISOString()
  const existing = queryOne<{ id: string }>('SELECT id FROM ai_research_task_steps WHERE task_id = ? AND step_key = ?', [taskId, stepKey])
  if (existing) {
    run('UPDATE ai_research_task_steps SET title = ?, status = ?, message = ?, progress = ?, updated_at = ? WHERE id = ?', [title, status, message, progress, now, existing.id])
    return
  }
  run(
    'INSERT INTO ai_research_task_steps (id, task_id, step_key, title, status, message, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [nanoid(), taskId, stepKey, title, status, message, progress, now, now],
  )
}

function listSteps(taskId: string): AiResearchTaskStep[] {
  getTask(taskId)
  return queryAll<AiResearchTaskStep>('SELECT * FROM ai_research_task_steps WHERE task_id = ? ORDER BY created_at', [taskId])
}

function extractFallbackSearchQueries(values: string[]): string[] {
  const stopWords = new Set([
    '里面', '多少', '谈到', '提到', '涉及', '相关', '篇幅', '段落', '数量', '条目', '所有', '列出',
    '统计', '按照', '时间', '排序', '查找', '同时', '出现', '频率', '筛选', '重要', '评分', '分析',
    '摘要', '主题', '国家', '具体', '类型', '情感', '倾向', '研究', '文献', '材料', '数据', '抽取',
  ])
  const queries: string[] = []
  const add = (value: string) => {
    const query = value.trim()
    if (query.length < 2 || stopWords.has(query)) return
    if (!queries.includes(query)) queries.push(query)
  }

  values.forEach((value) => {
    const normalized = String(value || '')
      .replace(/[，。；、,.!?！？;:：()[\]{}"'“”‘’<>《》|/\\_-]+/g, ' ')
      .replace(/(里面|多少|谈到|提到|涉及|相关|篇幅|段落|数量|条目|所有|列出|统计|按照|排序|查找|同时|出现频率|筛选|重要性评分|分析摘要|具体地点|情感倾向|提及类型|提及主题|相关人物)/g, ' ')
    normalized
      .split(/\s+|和|与|及|或/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        if (/^[\u4e00-\u9fff]{2,8}$/.test(item) || /^[A-Za-z0-9][A-Za-z0-9_-]{1,}$/.test(item)) add(item)
      })

    const cjkBlocks = normalized.match(/[\u4e00-\u9fff]{4,}/g) || []
    cjkBlocks.forEach((block) => {
      for (let size = 2; size <= 3; size += 1) {
        for (let index = 0; index <= block.length - size && queries.length < FALLBACK_QUERY_LIMIT; index += 1) {
          add(block.slice(index, index + size))
        }
      }
    })
  })

  return queries.slice(0, FALLBACK_QUERY_LIMIT)
}

function makeCandidateKey(hit: SearchResult): string {
  return `${hit.doc_id}:${hit.page_num}:${hit.locator?.segmentId || ''}:${String(hit.snippet || '').slice(0, 80)}`
}

function searchCandidateHits(queries: string[], docIds: string[] | undefined, seen: Set<string>): SearchResult[] {
  const hits: SearchResult[] = []
  queries.forEach((query) => {
    fullTextSearch(query, {
      docIds,
      limit: 24,
      contextMode: 'long',
      exhaustive: query.length <= 3,
      autoReindex: false,
    }).forEach((hit) => {
      const key = makeCandidateKey(hit)
      if (seen.has(key)) return
      seen.add(key)
      hits.push({ ...hit, matched_query: hit.matched_query || query })
    })
  })
  return hits
}

function parseQueryList(raw: string): string[] {
  const cleaned = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim()
  try {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    const candidate = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned
    const parsed = JSON.parse(candidate) as unknown
    if (isRecord(parsed) && Array.isArray(parsed.queries)) {
      return uniqueStrings(parsed.queries.map(String), FALLBACK_QUERY_LIMIT)
    }
  } catch {
    // Fall through to text parsing.
  }
  return extractFallbackSearchQueries([cleaned])
}

async function suggestNextRoundQueries(task: AiResearchTask, hits: SearchResult[], usedQueries: string[]): Promise<string[]> {
  const evidence = hits.slice(0, 8).map((hit, index) => [
    `#${index + 1} 文献：${hit.doc_title || '未命名文献'}，第 ${hit.page_num || '?'} 页`,
    `命中词：${hit.matched_query || ''}`,
    String(hit.snippet || '').replace(/<<|>>/g, '').slice(0, 420),
  ].join('\n')).join('\n\n')
  if (!evidence.trim()) return []

  const prompt = [
    '你是 GujiSmart 的本地文库检索助手。请根据研究目标和已命中的原文片段，生成下一轮检索关键词。',
    '要求：只给适合全文检索的短词或短语，不要给完整句子；优先给人名、地名、机构、主题词、同义词、历史异名。',
    '不要重复已经检索过的词。最多返回 8 个。',
    '只返回 JSON：{"queries":[""]}',
    `研究目标：${task.goal}`,
    `字段方案：${JSON.stringify(task.fieldSchema || DEFAULT_FIELDS)}`,
    `已检索：${usedQueries.join('、')}`,
    `已命中片段：\n${evidence}`,
  ].join('\n')

  try {
    return parseQueryList(await callLLM([{ role: 'user', content: prompt }]))
      .filter((query) => !usedQueries.includes(query))
      .slice(0, QUERIES_PER_ROUND)
  } catch (error) {
    console.warn('[AI Research] Failed to suggest next-round queries, using local fallback:', error)
    return extractFallbackSearchQueries(hits.map((hit) => `${hit.doc_title || ''} ${hit.snippet || ''}`))
      .filter((query) => !usedQueries.includes(query))
      .slice(0, QUERIES_PER_ROUND)
  }
}

async function collectCandidateHits(task: AiResearchTask): Promise<CandidateHitCollection> {
  const scope = safeJsonParse<LibraryAiScope>(task.scope_json, { type: 'all' })
  const docIds = getDocumentIdsForScope(scope)
  if (docIds && docIds.length === 0) return { hits: [], strategy: 'keyword', searchedQueryCount: 0, rounds: 0 }
  const queries = uniqueStrings([...(task.suggestedQueries || []), task.goal], MAX_QUERIES)
  const seen = new Set<string>()
  const hits = searchCandidateHits(queries, docIds, seen)
  if (hits.length > 0) {
    const usedQueries = [...queries]
    let allHits = [...hits]
    let nextQueries = await suggestNextRoundQueries(task, allHits, usedQueries)
    let rounds = 1
    while (rounds < MAX_SEARCH_ROUNDS && nextQueries.length > 0 && allHits.length < MAX_RECORDS_PER_RUN * 2) {
      usedQueries.push(...nextQueries)
      allHits.push(...searchCandidateHits(nextQueries, docIds, seen))
      rounds += 1
      nextQueries = await suggestNextRoundQueries(task, allHits, usedQueries)
    }
    return { hits: allHits, strategy: rounds > 1 ? 'iterative-keyword' : 'keyword', searchedQueryCount: usedQueries.length, rounds }
  }

  const fallbackQueries = extractFallbackSearchQueries(queries)
  const usedQueries = [...queries, ...fallbackQueries]
  let expandedHits = searchCandidateHits(fallbackQueries, docIds, seen)
  let rounds = fallbackQueries.length > 0 ? 1 : 0
  while (rounds < MAX_SEARCH_ROUNDS && expandedHits.length > 0 && expandedHits.length < MAX_RECORDS_PER_RUN * 2) {
    const nextQueries = await suggestNextRoundQueries(task, expandedHits, usedQueries)
    if (nextQueries.length === 0) break
    usedQueries.push(...nextQueries)
    expandedHits.push(...searchCandidateHits(nextQueries, docIds, seen))
    rounds += 1
  }
  return {
    hits: expandedHits,
    strategy: expandedHits.length > 0 && rounds > 1 ? 'iterative-keyword' : 'expanded-keyword',
    searchedQueryCount: usedQueries.length,
    rounds,
  }
}

function getCandidateSearchMessage(collection: CandidateHitCollection): string {
  if (collection.strategy === 'iterative-keyword') {
    return `已在当前范围完成 ${collection.rounds} 轮关键词检索，共检索 ${collection.searchedQueryCount} 个词条，命中 ${collection.hits.length} 条候选证据`
  }
  if (collection.strategy === 'expanded-keyword') {
    return `原检索线索未命中，已拆分关键词重试，命中 ${collection.hits.length} 条候选证据`
  }
  return `命中 ${collection.hits.length} 条候选证据`
}

function sortCandidateHits(hits: SearchResult[]): SearchResult[] {
  return hits
    .sort((left, right) => Number(right.relevance_score || right.rank || 0) - Number(left.relevance_score || left.rank || 0))
    .slice(0, MAX_RECORDS_PER_RUN)
}

function buildStatisticalValues(fields: AiResearchFieldSchema[], stat: AiResearchRetrievalStats['queryStats'][number]): Record<string, string> {
  const cooccurring = stat.facets.cooccurringTerms.slice(0, 8).map((item) => item.label).join('、')
  const values: Record<string, string> = {}
  fields.forEach((field) => {
    const key = field.key.toLowerCase()
    const label = field.label.toLowerCase()
    if (/entity|subject|keyword|term|name/.test(key) || /实体|对象|关键词|名称|国家|地区/.test(label)) {
      values[field.key] = stat.query
    } else if (/document/.test(key) || /文献/.test(label)) {
      values[field.key] = String(stat.documentCount)
    } else if (/page|篇幅/.test(key) || /页面|页数|篇幅/.test(label)) {
      values[field.key] = String(stat.pageCount)
    } else if (/hit|mention|count|frequency|number/.test(key) || /次数|频率|数量|命中|提及|出现/.test(label)) {
      values[field.key] = String(stat.hitCount)
    } else if (/theme|summary|context|note/.test(key) || /主题|摘要|语境|说明|分析/.test(label)) {
      values[field.key] = cooccurring ? `高频共现：${cooccurring}` : '本地全文统计'
    } else {
      values[field.key] = ''
    }
  })
  return values
}

function insertStatisticalRecords(
  task: AiResearchTask,
  datasetId: string,
  stats: AiResearchRetrievalStats,
  evidencePack: AiResearchEvidencePack,
): number {
  const fields = task.fieldSchema || DEFAULT_FIELDS
  const preferredStats = stats.queryStats
    .filter((stat) => stat.hitCount > 0)
    .sort((left, right) => {
      const leftCore = stats.plan.coreQueries?.includes(left.query) ? 0 : 1
      const rightCore = stats.plan.coreQueries?.includes(right.query) ? 0 : 1
      if (leftCore !== rightCore) return leftCore - rightCore
      return right.hitCount - left.hitCount
    })
    .slice(0, MAX_RECORDS_PER_RUN)
  let inserted = 0
  preferredStats.forEach((stat) => {
    const evidence = evidencePack.evidence.find((item) => item.query === stat.query) || evidencePack.evidence[0]
    const sourceHash = makeSourceHash(['statistical', task.id, stat.query, stat.documentCount, stat.pageCount, stat.hitCount])
    const duplicate = queryOne<{ id: string }>('SELECT id FROM ai_research_records WHERE dataset_id = ? AND source_hash = ?', [datasetId, sourceHash])
    if (duplicate) return
    const summary = `本地统计：${stat.query} 命中文献 ${stat.documentCount} 篇、页面 ${stat.pageCount} 页、出现 ${stat.hitCount} 次。`
    run(
      `INSERT INTO ai_research_records (
        id, library_project_id, dataset_id, task_id, project_id, doc_id, page_num, excerpt, locator_json, source_hash, values_json, confidence, status, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        nanoid(),
        task.library_project_id,
        datasetId,
        task.id,
        task.project_id,
        evidence?.doc_id || '',
        evidence?.page_num || null,
        evidence?.snippet ? String(evidence.snippet).replace(/<<|>>/g, '').trim() : summary,
        JSON.stringify(evidence?.stableLocator || evidence?.locator || {}),
        sourceHash,
        JSON.stringify(buildStatisticalValues(fields, stat)),
        1,
        evidence ? '数量来自本地全文统计；原文片段为代表证据。' : '数量来自本地全文统计；未找到可展示的代表证据。',
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    )
    inserted += 1
  })
  return inserted
}

async function extractValuesFromHit(task: AiResearchTask, hit: SearchResult): Promise<{ values: Record<string, string>; confidence: number; note: string }> {
  const fields = task.fieldSchema || DEFAULT_FIELDS
  const fallbackValues = Object.fromEntries(fields.map((field) => [field.key, field.key === 'event' ? String(hit.snippet || '').replace(/<<|>>/g, '').trim().slice(0, 220) : '']))
  const prompt = [
    '你是 GujiSmart 的文献数据抽取助手。请只根据给定原文片段抽取结构化字段。',
    '只返回 JSON，不要 Markdown。',
    'JSON 格式：{"values":{"字段key":"值"},"confidence":0.0,"note":""}',
    '如果片段中没有某字段的信息，该字段填空字符串。不要编造。',
    `研究目标：${task.goal}`,
    `字段：${JSON.stringify(fields)}`,
    `文献：${hit.doc_title || ''}`,
    `页码：${hit.page_num || ''}`,
    `原文片段：${String(hit.snippet || '').replace(/<<|>>/g, '').slice(0, 1800)}`,
  ].join('\n')
  try {
    const parsed = parseJsonObject(await callLLM([{ role: 'user', content: prompt }]))
    const rawValues = isRecord(parsed.values) ? parsed.values : {}
    const values = Object.fromEntries(fields.map((field) => [field.key, String(rawValues[field.key] || '').trim()]))
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0.65)))
    return { values, confidence, note: String(parsed.note || '').trim() }
  } catch (error) {
    console.warn('[AI Research] Failed to extract values, using source-only record:', error)
    return { values: fallbackValues, confidence: 0.45, note: 'AI 抽取失败，已保留候选原文，建议人工复核。' }
  }
}

async function runTask(taskId: string): Promise<AiResearchRunResult> {
  const task = getTask(taskId)
  const now = new Date().toISOString()
  run('UPDATE ai_research_tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?', ['running', '', now, taskId])
  upsertStep(taskId, 'counting', '全库统计检索', 'running', '正在对当前范围做本地全文统计，不会把全部命中交给 AI', 0.12)
  saveDatabase()
  try {
    const retrieval = runResearchRetrievalForTask(task)
    const { stats, evidencePack } = retrieval
    const firstHighFrequency = stats.queryStats.find((stat) => stat.highFrequency)
    upsertStep(
      taskId,
      'counting',
      '全库统计检索',
      'completed',
      `已完成 ${stats.queryStats.length} 个查询的本地统计，累计命中文献 ${stats.totalDocumentCount} 篇、页面 ${stats.totalPageCount} 页、命中 ${stats.totalHitCount} 次。`,
      1,
    )
    upsertStep(
      taskId,
      'packing',
      '证据包压缩',
      'completed',
      firstHighFrequency
        ? `“${firstHighFrequency.query}”命中 ${firstHighFrequency.hitCount} 次，已自动按共现词、文献类型和时间分布收缩。AI 将只读取压缩后的 ${evidencePack.totalEvidenceCount} 条代表证据，完整数量统计由本地检索计算。`
        : `已压缩为 ${evidencePack.totalEvidenceCount} 条代表证据，完整数量统计由本地检索计算。`,
      1,
    )
    if (stats.readableSegmentCount === 0) {
      throw new Error('当前范围没有可读取 OCR 正文。请先完成 OCR，或切换到包含 OCR 文本的文献范围。')
    }
    if (stats.totalHitCount === 0) {
      throw new Error('关键词未命中。当前范围有 OCR 正文，但这些关键词没有命中，请换成更明确的人名、地名、机构名、主题词或时间词。')
    }
    const hits = evidencePack.evidence.slice(0, MAX_RECORDS_PER_RUN).map(evidenceItemToSearchResult)
    if (hits.length === 0) {
      throw new Error('检索已有命中，但证据包为空。请缩小范围或换一组更具体的关键词后重试。')
    }

    const datasetId = task.dataset_id || nanoid()
    const datasetExists = queryOne<{ id: string }>(
      'SELECT id FROM ai_research_datasets WHERE id = ? AND library_project_id = ?',
      [datasetId, task.library_project_id],
    )
    if (!datasetExists) {
      run(
        'INSERT INTO ai_research_datasets (id, library_project_id, task_id, project_id, name, description, field_schema_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [datasetId, task.library_project_id, task.id, task.project_id, `${task.title} 数据集`, task.goal, task.field_schema_json, now, now],
      )
      run('UPDATE ai_research_tasks SET dataset_id = ? WHERE id = ?', [datasetId, task.id])
    }

    upsertStep(taskId, 'extract', '结构化抽取', 'running', '正在把候选证据抽取为数据记录', 0.2)
    if (task.kind === 'statistical') {
      const inserted = insertStatisticalRecords(task, datasetId, stats, evidencePack)
      upsertStep(
        taskId,
        'extract',
        '结构化抽取',
        'completed',
        `已根据本地统计生成 ${inserted} 条数据记录，数量不由 AI 编写`,
        1,
      )
      const completedAt = new Date().toISOString()
      run('UPDATE ai_research_tasks SET status = ?, updated_at = ? WHERE id = ?', ['completed', completedAt, taskId])
      run('UPDATE ai_research_datasets SET updated_at = ? WHERE id = ?', [completedAt, datasetId])
      saveDatabase()
      return {
        task: getTask(taskId),
        dataset: getDataset(datasetId),
        records: listRecords(datasetId),
        retrievalStats: stats,
        evidencePack,
      }
    }

    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index]
      const sourceHash = makeSourceHash([hit.doc_id, hit.page_num, hit.locator?.segmentId, hit.snippet])
      const duplicate = queryOne<{ id: string }>('SELECT id FROM ai_research_records WHERE dataset_id = ? AND source_hash = ?', [datasetId, sourceHash])
      if (!duplicate) {
        const extracted = await extractValuesFromHit(task, hit)
        run(
          `INSERT INTO ai_research_records (
            id, library_project_id, dataset_id, task_id, project_id, doc_id, page_num, excerpt, locator_json, source_hash, values_json, confidence, status, note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            nanoid(),
            task.library_project_id,
            datasetId,
            task.id,
            task.project_id,
            hit.doc_id,
            hit.page_num || null,
            String(hit.snippet || '').replace(/<<|>>/g, '').trim(),
            JSON.stringify(hit.stableLocator || hit.locator || {}),
            sourceHash,
            JSON.stringify(extracted.values),
            extracted.confidence,
            extracted.note,
            new Date().toISOString(),
            new Date().toISOString(),
          ],
        )
      }
      upsertStep(taskId, 'extract', '结构化抽取', 'running', `已处理 ${index + 1}/${hits.length} 条候选证据`, (index + 1) / hits.length)
      saveDatabase()
    }
    upsertStep(taskId, 'extract', '结构化抽取', 'completed', '结构化数据集已生成，可在研究专题中复核', 1)
    const completedAt = new Date().toISOString()
    run('UPDATE ai_research_tasks SET status = ?, updated_at = ? WHERE id = ?', ['completed', completedAt, taskId])
    run('UPDATE ai_research_datasets SET updated_at = ? WHERE id = ?', [completedAt, datasetId])
    saveDatabase()
    return {
      task: getTask(taskId),
      dataset: getDataset(datasetId),
      records: listRecords(datasetId),
      retrievalStats: stats,
      evidencePack,
    }
  } catch (error) {
    const message = getErrorMessage(error, 'AI 研究任务运行失败')
    run('UPDATE ai_research_tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?', ['error', message, new Date().toISOString(), taskId])
    upsertStep(taskId, 'error', '运行失败', 'error', message, 1)
    saveDatabase()
    throw new Error(message)
  }
}

function getDataset(datasetId: string): AiResearchDataset {
  const libraryProjectId = getActiveLibraryProjectId()
  const dataset = rowToDataset(queryOne<AiResearchDataset>(
    'SELECT * FROM ai_research_datasets WHERE id = ? AND library_project_id = ?',
    [datasetId, libraryProjectId],
  ))
  dataset.record_count = Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM ai_research_records WHERE dataset_id = ?', [datasetId])?.count || 0)
  return dataset
}

function listDatasets(projectId?: string | null): AiResearchDataset[] {
  const libraryProjectId = getActiveLibraryProjectId()
  const rows = projectId
    ? queryAll<AiResearchDataset>(
        'SELECT * FROM ai_research_datasets WHERE library_project_id = ? AND project_id = ? ORDER BY updated_at DESC',
        [libraryProjectId, projectId],
      )
    : queryAll<AiResearchDataset>(
        'SELECT * FROM ai_research_datasets WHERE library_project_id = ? ORDER BY updated_at DESC',
        [libraryProjectId],
      )
  return rows.map((row) => getDataset(row.id))
}

function normalizeRecordListOptions(options?: AiResearchRecordListOptions): { limit: number; offset: number } | null {
  if (!options) return null
  const limit = Number(options.limit)
  const offset = Number(options.offset)
  if (!Number.isFinite(limit) || limit <= 0) return null
  return {
    limit: Math.min(200, Math.max(1, Math.floor(limit))),
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
  }
}

function listRecords(datasetId: string, options?: AiResearchRecordListOptions): AiResearchRecord[] {
  const dataset = getDataset(datasetId)
  const paging = normalizeRecordListOptions(options)
  return queryAll<AiResearchRecord & { doc_title?: string }>(
    `SELECT r.*, d.title as doc_title
     FROM ai_research_records r
     LEFT JOIN documents d ON d.id = r.doc_id
     WHERE r.dataset_id = ? AND r.library_project_id = ?
     ORDER BY r.created_at ASC
     ${paging ? 'LIMIT ? OFFSET ?' : ''}`,
    paging
      ? [datasetId, dataset.library_project_id, paging.limit, paging.offset]
      : [datasetId, dataset.library_project_id],
  ).map(rowToRecord)
}

function updateRecord(recordId: string, payload: AiResearchRecordUpdatePayload): AiResearchRecord {
  const libraryProjectId = getActiveLibraryProjectId()
  const existing = rowToRecord(queryOne<AiResearchRecord>(
    'SELECT * FROM ai_research_records WHERE id = ? AND library_project_id = ?',
    [recordId, libraryProjectId],
  ))
  const nextValues = payload.values ? payload.values : existing.values || {}
  const nextStatus = payload.status || existing.status
  let versionStatus: 'pending' | 'confirmed' | 'excluded' = 'pending'
  if (nextStatus === 'confirmed') versionStatus = 'confirmed'
  if (nextStatus === 'excluded') versionStatus = 'excluded'
  const nextNote = payload.note ?? existing.note
  commitExistingResearchRecordUpdate({
    recordId,
    values: nextValues,
    status: versionStatus,
    note: nextNote,
  })
  saveDatabase()
  return rowToRecord(queryOne<AiResearchRecord>(
    'SELECT * FROM ai_research_records WHERE id = ? AND library_project_id = ?',
    [recordId, libraryProjectId],
  ))
}

function excludeRecord(recordId: string): AiResearchRecord {
  return updateRecord(recordId, { status: 'excluded' })
}

function recordsToMarkdown(dataset: AiResearchDataset, records: AiResearchRecord[]): string {
  const fields = dataset.fieldSchema || DEFAULT_FIELDS
  const header = ['来源', '页码', ...fields.map((field) => field.label), '原文证据', '置信度']
  const rows = records.map((record) => {
    const values = record.values || {}
    return [
      record.doc_title || record.doc_id,
      String(record.page_num || ''),
      ...fields.map((field) => values[field.key] || ''),
      record.excerpt.replace(/\s+/g, ' ').slice(0, 180),
      String(record.confidence || ''),
    ]
  })
  return [
    `# ${dataset.name}`,
    '',
    `> ${dataset.description}`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ')} |`),
  ].join('\n')
}

function getScopeDocumentSummary(scope: LibraryAiScope): { label: string; count: number; titles: string[] } {
  const docIds = getDocumentIdsForScope(scope)
  if (!docIds) {
    const count = Number(queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM documents
       WHERE EXISTS (
         SELECT 1 FROM library_project_documents project_scope
         WHERE project_scope.document_id = documents.id
           AND project_scope.project_id = ?
       )`,
      [getActiveLibraryProjectId()],
    )?.count || 0)
    return { label: '整个数据库', count, titles: [] }
  }
  if (docIds.length === 0) return { label: '空范围', count: 0, titles: [] }
  const sampleIds = docIds.slice(0, 30)
  const rows = queryAll<{ title: string | null }>(
    `SELECT title FROM documents WHERE id IN (${sampleIds.map(() => '?').join(', ')}) ORDER BY updated_at DESC`,
    sampleIds,
  )
  return {
    label: '选中文献范围',
    count: docIds.length,
    titles: rows.map((row) => String(row.title || '未命名文献')).filter(Boolean),
  }
}

function buildReportContext(dataset: AiResearchDataset, records: AiResearchRecord[]): string {
  const task = getTask(dataset.task_id)
  const scope = safeJsonParse<LibraryAiScope>(task.scope_json, { type: 'all' })
  const scopeSummary = getScopeDocumentSummary(scope)
  const stats = getLatestResearchRetrievalStats(task.id)
  const evidencePack = getLatestResearchEvidencePack(task.id)
  const recordDocCount = new Set(records.map((record) => record.doc_id).filter(Boolean)).size
  const queryLines = stats?.queryStats.slice(0, 20).map((stat) => (
    `- ${stat.query}: ${stat.documentCount} 篇 / ${stat.pageCount} 页 / ${stat.hitCount} 次${stat.highFrequency ? '（高频，已压缩代表证据）' : ''}`
  )) || []
  const evidenceDocCount = evidencePack ? new Set(evidencePack.evidence.map((item) => item.doc_id).filter(Boolean)).size : 0
  return [
    '## 本地统计与范围说明',
    `- 研究范围：${scopeSummary.label}，共 ${scopeSummary.count} 篇文献。`,
    scopeSummary.titles.length > 0 ? `- 纳入范围示例：${scopeSummary.titles.join('；')}${scopeSummary.count > scopeSummary.titles.length ? '；……' : ''}` : '',
    stats ? `- 本地检索统计：${stats.queryStats.length} 个查询，可读文本段 ${stats.readableSegmentCount} 段，累计命中 ${stats.totalHitCount} 次。` : '',
    stats ? '- 注意：各查询的“命中文献数/页数”是逐查询统计，可能重复计算同一文献；不要把它当成去重后的文献总数。' : '',
    evidencePack ? `- 代表证据包：${evidencePack.totalEvidenceCount} 条代表证据，覆盖 ${evidenceDocCount} 篇文献；这是压缩后交给 AI 阅读的材料，不等于全部研究范围。` : '',
    `- 当前结构化数据集记录：${records.length} 条，来源覆盖 ${recordDocCount} 篇文献；这些记录是代表证据或统计记录，不代表本次只分析了这些文献。`,
    queryLines.length > 0 ? ['- 关键词统计概览：', ...queryLines].join('\n') : '',
    '',
    '生成报告时必须区分“完整研究范围”“本地统计结果”和“代表证据记录”。不要把代表证据的来源数量写成本次研究范围。',
  ].filter(Boolean).join('\n')
}

function previewText(value: unknown, limit = 180): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function buildAiResearchOutputSnapshotJson(
  dataset: AiResearchDataset,
  records: AiResearchRecord[],
  templateType: AiSynthesisTemplate,
  customPrompt?: string,
): string {
  const task = getTask(dataset.task_id)
  const documentMap = new Map<string, { id: string; title?: string }>()
  for (const record of records) {
    if (!record.doc_id) continue
    documentMap.set(record.doc_id, {
      id: record.doc_id,
      title: record.doc_title || record.doc_id,
    })
  }
  const prompt = String(customPrompt || '')
  return stringifyResearchOutputInputSnapshot(createResearchOutputInputSnapshot({
    source: 'ai-research:generateReport',
    projectId: dataset.project_id || '',
    outputType: templateType,
    sourceDatasetId: dataset.id,
    customPromptPresent: Boolean(prompt.trim()),
    customPromptHash: prompt.trim() ? makeSourceHash([prompt]) : undefined,
    documents: [...documentMap.values()],
    aiRecords: records.map((record) => ({
      id: record.id,
      datasetId: record.dataset_id,
      taskId: record.task_id,
      docId: record.doc_id,
      pageNum: record.page_num,
      sourceHash: record.source_hash || '',
      locatorJson: record.locator_json || '',
      confidence: Number(record.confidence || 0),
      status: record.status,
      excerptHash: makeSourceHash([record.excerpt || '']),
      excerptPreview: previewText(record.excerpt),
    })),
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskStatus: task.status,
      datasetName: dataset.name,
      includedRecordCount: records.length,
      fieldCount: dataset.fieldSchema?.length || 0,
    },
  }))
}

async function generateReport(payload: AiResearchReportPayload): Promise<{ content: string; outputId: string | null }> {
  const dataset = getDataset(payload.datasetId)
  const records = listRecords(payload.datasetId).filter((record) => record.status !== 'excluded')
  if (records.length === 0) throw new Error('数据集中没有可用于生成报告的记录')
  const table = recordsToMarkdown(dataset, records)
  const reportContext = buildReportContext(dataset, records)
  const prompt = [
    '你是 GujiSmart 的研究写作助手。请只根据下方结构化数据集生成中文研究报告。',
    '必须包含：总体判断、时空归类、特点规律、证据表格解读、待核查问题。',
    '引用材料时使用数据表中的来源和页码，不要编造外部材料。',
    '本地统计结果中的数量优先于 AI 自行判断；如果代表证据数量少于研究范围，必须说明这是证据压缩结果。',
    payload.customPrompt ? `用户额外要求：${payload.customPrompt}` : '',
    `报告类型：${payload.templateType || 'theme_analysis'}`,
    reportContext,
    table.slice(0, 18000),
  ].filter(Boolean).join('\n\n')
  const content = await callLLM([{ role: 'user', content: prompt }])
  let outputId: string | null = null
  if (dataset.project_id) {
    outputId = nanoid()
    const outputType = payload.templateType || 'theme_analysis'
    const inputSnapshotJson = buildAiResearchOutputSnapshotJson(dataset, records, outputType, payload.customPrompt)
    run(
      'INSERT INTO research_outputs (id, project_id, output_type, title, content, source_dataset_id, input_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [outputId, dataset.project_id, outputType, `${dataset.name} - AI 数据报告`, content, dataset.id, inputSnapshotJson, new Date().toISOString()],
    )
    createResearchOutputVersion({
      outputId,
      projectId: dataset.project_id,
      outputType,
      title: `${dataset.name} - AI 数据报告`,
      content,
      recordIds: records.map((record) => record.id),
      status: 'draft',
    })
    saveDatabase()
  }
  return { content, outputId }
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function exportDataset(datasetId: string, format: 'csv' | 'markdown' | 'json' = 'csv'): AiResearchExportResult {
  const dataset = getDataset(datasetId)
  const records = listRecords(datasetId).filter((record) => record.status !== 'excluded')
  if (format === 'json') {
    return { format, content: JSON.stringify({ dataset, records }, null, 2), recordCount: records.length }
  }
  if (format === 'markdown') {
    return { format, content: recordsToMarkdown(dataset, records), recordCount: records.length }
  }
  const fields = dataset.fieldSchema || DEFAULT_FIELDS
  const header = ['doc_title', 'page_num', ...fields.map((field) => field.key), 'excerpt', 'confidence', 'status']
  const lines = [
    header.map(csvEscape).join(','),
    ...records.map((record) => {
      const values = record.values || {}
      return [
        record.doc_title || record.doc_id,
        record.page_num || '',
        ...fields.map((field) => values[field.key] || ''),
        record.excerpt,
        record.confidence,
        record.status,
      ].map(csvEscape).join(',')
    }),
  ]
  return { format, content: lines.join('\n'), recordCount: records.length }
}

export function registerAiResearchIpc(): void {
  const inCapturedLibraryProject = <T>(operation: () => T): T => {
    const projectId = captureActiveLibraryProjectId()
    return withLibraryProjectContext(projectId, operation)
  }

  ipcMain.handle('aiResearch:planTask', async (_event, payload: AiResearchPlanPayload): Promise<AiResearchPlan> => (
    inCapturedLibraryProject(() => planTask(payload))
  ))
  ipcMain.handle('aiResearch:createTask', async (_event, payload: AiResearchCreateTaskPayload): Promise<AiResearchTask> => (
    inCapturedLibraryProject(() => createTask(payload))
  ))
  ipcMain.handle('aiResearch:runTask', async (_event, taskId: string): Promise<AiResearchRunResult> => (
    inCapturedLibraryProject(() => runTask(taskId))
  ))
  ipcMain.handle('aiResearch:previewRetrieval', async (_event, payload: AiResearchRetrievalPreviewPayload): Promise<AiResearchRetrievalStats> => (
    inCapturedLibraryProject(() => previewResearchRetrieval(payload))
  ))
  ipcMain.handle('aiResearch:runRetrieval', async (_event, taskId: string): Promise<AiResearchRetrievalRunResult> => (
    inCapturedLibraryProject(() => runResearchRetrievalForTask(getTask(taskId)))
  ))
  ipcMain.handle('aiResearch:getRetrievalStats', async (_event, taskId: string): Promise<AiResearchRetrievalStats | null> => (
    inCapturedLibraryProject(() => {
      getTask(taskId)
      return getLatestResearchRetrievalStats(taskId)
    })
  ))
  ipcMain.handle('aiResearch:getEvidencePack', async (_event, taskId: string): Promise<AiResearchEvidencePack | null> => (
    inCapturedLibraryProject(() => {
      getTask(taskId)
      return getLatestResearchEvidencePack(taskId)
    })
  ))
  ipcMain.handle('aiResearch:listTasks', async (_event, projectId?: string | null): Promise<AiResearchTask[]> => (
    inCapturedLibraryProject(() => listTasks(projectId))
  ))
  ipcMain.handle('aiResearch:getTask', async (_event, taskId: string): Promise<AiResearchTask> => (
    inCapturedLibraryProject(() => getTask(taskId))
  ))
  ipcMain.handle('aiResearch:listTaskSteps', async (_event, taskId: string): Promise<AiResearchTaskStep[]> => (
    inCapturedLibraryProject(() => listSteps(taskId))
  ))
  ipcMain.handle('aiResearch:listDatasets', async (_event, projectId?: string | null): Promise<AiResearchDataset[]> => (
    inCapturedLibraryProject(() => listDatasets(projectId))
  ))
  ipcMain.handle('aiResearch:listRecords', async (_event, datasetId: string, options?: AiResearchRecordListOptions): Promise<AiResearchRecord[]> => (
    inCapturedLibraryProject(() => listRecords(datasetId, options))
  ))
  ipcMain.handle('aiResearch:updateRecord', async (_event, recordId: string, payload: AiResearchRecordUpdatePayload): Promise<AiResearchRecord> => (
    inCapturedLibraryProject(() => updateRecord(recordId, payload))
  ))
  ipcMain.handle('aiResearch:excludeRecord', async (_event, recordId: string): Promise<AiResearchRecord> => (
    inCapturedLibraryProject(() => excludeRecord(recordId))
  ))
  ipcMain.handle('aiResearch:generateReport', async (_event, payload: AiResearchReportPayload): Promise<{ content: string; outputId: string | null }> => (
    inCapturedLibraryProject(() => generateReport(payload))
  ))
  ipcMain.handle('aiResearch:exportDataset', async (_event, datasetId: string, format?: 'csv' | 'markdown' | 'json'): Promise<AiResearchExportResult> => (
    inCapturedLibraryProject(() => exportDataset(datasetId, format))
  ))
}
