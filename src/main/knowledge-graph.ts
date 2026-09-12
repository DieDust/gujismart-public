import { queryAll } from './database'
import { getActiveLibraryProjectId } from './library-projects'
import type { AiResearchDataset, AiResearchRecord, KnowledgeGraphData, KnowledgeGraphDataQuery } from '../shared/types'
import { getResearchDatasetFields, RESEARCH_GRAPH_RECORD_LIMIT, researchRecordValues } from '../shared/research-graph'

export function listKnowledgeGraphSources(): AiResearchDataset[] {
  return queryAll<AiResearchDataset>(
    `SELECT ds.*, (SELECT COUNT(*) FROM ai_research_records r WHERE r.dataset_id = ds.id) AS record_count
     FROM ai_research_datasets ds WHERE ds.library_project_id = ? ORDER BY ds.updated_at DESC, ds.id`,
    [getActiveLibraryProjectId()],
  ).map((dataset) => ({ ...dataset, fieldSchema: getResearchDatasetFields(dataset) }))
}

function validateIds(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((id) => typeof id !== 'string' || !id.trim() || id.length > 320)) {
    throw new Error('Invalid knowledge graph scope')
  }
  return [...new Set(value as string[])]
}

export async function getKnowledgeGraphData(query: KnowledgeGraphDataQuery): Promise<KnowledgeGraphData> {
  const datasetIds = validateIds(query?.datasetIds, 20)
  const libraryProjectId = getActiveLibraryProjectId()
  const requested = query?.limit ?? RESEARCH_GRAPH_RECORD_LIMIT
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > RESEARCH_GRAPH_RECORD_LIMIT) throw new Error('Invalid graph record limit')
  if (!datasetIds.length) return { libraryProjectId, datasets: [], records: [], totalRecords: 0, truncated: false }
  const allSources = listKnowledgeGraphSources()
  const selected = new Set(datasetIds)
  const datasets = allSources.filter((dataset) => selected.has(dataset.id))
  if (datasets.length !== selected.size) throw new Error('Graph source unavailable in the active library project')
  const records: AiResearchRecord[] = []
  // Round-robin windows prevent one large dataset from consuming every slot.
  const offsets = new Map(datasetIds.map((id) => [id, 0]))
  const exhausted = new Set<string>()
  while (records.length < requested && exhausted.size < datasets.length) {
    for (const dataset of datasets) {
      if (exhausted.has(dataset.id) || records.length >= requested) continue
      if (getActiveLibraryProjectId() !== libraryProjectId) throw new Error('Library project changed during graph loading')
      const limit = Math.min(100, requested - records.length)
      const rows = queryAll<AiResearchRecord>(
        `SELECT r.*, d.title AS doc_title FROM ai_research_records r
         LEFT JOIN documents d ON d.id = r.doc_id
         WHERE r.dataset_id = ? AND r.library_project_id = ? ORDER BY r.created_at, r.id LIMIT ? OFFSET ?`,
        [dataset.id, libraryProjectId, limit, offsets.get(dataset.id) || 0],
      )
      records.push(...rows.map((record) => ({ ...record, values: researchRecordValues(record) })))
      offsets.set(dataset.id, (offsets.get(dataset.id) || 0) + rows.length)
      if (rows.length < limit) exhausted.add(dataset.id)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  if (getActiveLibraryProjectId() !== libraryProjectId) throw new Error('Library project changed during graph loading')
  const totalRecords = datasets.reduce((sum, dataset) => sum + Number(dataset.record_count || 0), 0)
  return { libraryProjectId, datasets, records, totalRecords, truncated: records.length < totalRecords }
}

export function getKnowledgeGraphEvidence(recordIds: string[]): AiResearchRecord[] {
  const ids = validateIds(recordIds, 50)
  if (!ids.length) return []
  const libraryProjectId = getActiveLibraryProjectId()
  return queryAll<AiResearchRecord>(
    `SELECT r.*, d.title AS doc_title FROM ai_research_records r LEFT JOIN documents d ON d.id = r.doc_id
     WHERE r.library_project_id = ? AND r.id IN (${ids.map(() => '?').join(',')}) ORDER BY r.created_at, r.id`,
    [libraryProjectId, ...ids],
  ).map((record) => ({ ...record, values: researchRecordValues(record) }))
}
