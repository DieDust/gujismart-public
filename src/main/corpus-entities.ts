import { randomUUID } from 'crypto'
import type { CorpusEntityPage, CorpusEntityQuery, CorpusEntityReview, CorpusResearchFinding } from '../shared/types'
import { resolveCorpusEntities, type CorpusEntityDecision } from '../shared/corpus-entities'
import { queryAll, queryOne, transaction } from './database'
import { getTaskJob, addTaskArtifact } from './task-scheduler'
import { getActiveLibraryProjectId, assertDocumentIdsInLibraryProject } from './library-projects'
import { resolveCanonicalPageContent } from './canonical-content'
import { corpusTextHash } from './corpus-research-text'

function state(id: string) {
  const job = getTaskJob(id)
  if (job.kind !== 'research.corpus.v1' || job.settingsSnapshot.libraryProjectId !== getActiveLibraryProjectId()) throw new Error('研究任务不属于当前文献库')
  const findings = queryAll<{ id: string; metadata_json: string }>("SELECT id,metadata_json FROM task_artifacts WHERE job_id = ? AND kind = 'corpus.finding' ORDER BY seq", [id])
    .map((row) => ({ ...JSON.parse(row.metadata_json) as CorpusResearchFinding, id: row.id }))
  const decisions = queryAll<{ id: string; metadata_json: string }>("SELECT id,metadata_json FROM task_artifacts WHERE job_id = ? AND kind = 'corpus.entity-review' ORDER BY seq", [id])
    .map((row) => ({ ...JSON.parse(row.metadata_json) as CorpusEntityDecision, id: row.id }))
  const revision = queryOne<{ revision: number }>("SELECT COALESCE(MAX(seq),0) revision FROM task_artifacts WHERE job_id = ? AND kind IN ('corpus.finding','corpus.entity-review')", [id])!.revision
  return { ...resolveCorpusEntities(findings, decisions), revision, history: decisions.slice(-10).reverse().map(({ id, action, reason }) => ({ id, action, reason })) }
}

function sourceState(source: CorpusResearchFinding): CorpusResearchFinding['sourceStatus'] {
  try {
    assertDocumentIdsInLibraryProject([source.docId], getActiveLibraryProjectId())
    const current = resolveCanonicalPageContent(source.pageId)
    return current.docId === source.docId && corpusTextHash(current.text) === source.sourceHash ? 'current' : 'stale'
  } catch { return 'missing' }
}

export function listCorpusEntities(id: string, options: CorpusEntityQuery = {}): CorpusEntityPage {
  const result = state(id)
  const offset = options.offset ?? 0
  const limit = options.limit ?? 20
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('实体分页参数无效')
  const search = String(options.search || '').trim().toLocaleLowerCase()
  const candidate = options.candidateOfId ? result.items.find((item) => item.id === options.candidateOfId) : undefined
  if (options.candidateOfId && !candidate) throw new Error('候选实体已变化，请刷新后重试')
  const names = (item: typeof result.items[number]) => [item.name, ...item.aliases, ...item.suggestedAliases].map((name) => name.normalize('NFC').trim().toLocaleLowerCase())
  const candidateNames = new Set(candidate ? names(candidate) : [])
  const filtered = result.items.filter((item) => (!options.candidatesOnly || item.candidateCount > 0)
    && (!candidate || item.kind === candidate.kind && names(item).some((name) => candidateNames.has(name)))
    && (!options.groupId || item.groupId === options.groupId)
    && (!search || [item.name, ...item.aliases, ...item.suggestedAliases, item.source.title].some((value) => value.toLocaleLowerCase().includes(search))))
  filtered.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id))
  const items = filtered.slice(offset, offset + limit).map((item) => ({ ...item, source: { ...item.source, sourceStatus: sourceState(item.source) } }))
  return { items, total: filtered.length, revision: result.revision, canUndo: result.canUndo, unprocessedFindings: result.unprocessedFindings, history: result.history }
}

export function reviewCorpusEntities(id: string, payload: CorpusEntityReview): void {
  transaction(() => {
    const current = state(id)
    if (payload.revision !== current.revision) throw new Error('实体结果已更新，请刷新后再核对')
    if (!['merge', 'split', 'undo'].includes(payload.action) || !Array.isArray(payload.mentionIds)
      || payload.mentionIds.length > 100 || payload.mentionIds.some((key) => typeof key !== 'string')
      || typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 1000) throw new Error('请填写核对依据，单次最多选择 100 条记录')
    const selectedIds = new Set(payload.mentionIds)
    const selected = current.items.filter((item) => selectedIds.has(item.id))
    if (selected.length !== selectedIds.size) throw new Error('所选实体不存在于本次研究')
    if (payload.action === 'undo') {
      if (!current.canUndo || selected.length) throw new Error('没有可撤销的核对')
    } else {
      if (!selected.length) throw new Error('请先选择实体')
      if (payload.action === 'merge') {
        if (new Set(selected.map((item) => item.kind)).size !== 1 || new Set(selected.map((item) => item.groupId)).size < 2) throw new Error('请选择至少两个相同类型、尚未归并的对象')
        const groups = new Set(selected.map((item) => item.groupId))
        const affected = current.items.filter((item) => groups.has(item.groupId))
        if (affected.some((item) => sourceState(item.source) !== 'current')) throw new Error('归并组中存在已修改或缺失的原文，请先重新研究核对')
      }
    }
    addTaskArtifact({ jobId: id, kind: 'corpus.entity-review', ref: id, idempotencyKey: `entity-review:${randomUUID()}`,
      metadata: { ...payload, reason: payload.reason.trim() } })
  })
}
