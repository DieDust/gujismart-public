import type { AiResearchDataset, AiResearchFieldSchema, AiResearchRecord } from './types'

export type ResearchEntityKind = 'person' | 'place' | 'time' | 'event'
export type ResearchGraphFieldMapping = Record<string, ResearchEntityKind | 'ignore'>

export interface ResearchGraphNode {
  id: string
  label: string
  kind: ResearchEntityKind
  recordIds: string[]
}

export interface ResearchGraphEdge {
  id: string
  source: string
  target: string
  kind: 'cooccurrence' | 'event' | 'relation'
  label: string
  directed: boolean
  recordIds: string[]
}

export interface ResearchGraph {
  nodes: ResearchGraphNode[]
  edges: ResearchGraphEdge[]
  recordCount: number
  omittedValues: number
}

export const RESEARCH_GRAPH_RECORD_LIMIT = 2000
export const RESEARCH_GRAPH_NODE_LIMIT = 160
export const RESEARCH_GRAPH_EDGE_LIMIT = 500
const MAX_ENTITIES_PER_RECORD = 16
const EMPTY_VALUES = new Set(['-', '--', '无', '未知', '不详', '未提及', '未明确', 'null', 'undefined', 'n/a'])

export function defaultGraphMapping(fields: AiResearchFieldSchema[]): ResearchGraphFieldMapping {
  return Object.fromEntries(fields.map((field) => {
    const type = field.type.toLowerCase()
    const key = field.key.toLowerCase()
    let kind: ResearchEntityKind | 'ignore' = 'ignore'
    if (type === 'person' || /^(person|people|人物|人名)$/.test(key)) kind = 'person'
    if (type === 'place' || /^(place|location|地点|地名)$/.test(key)) kind = 'place'
    if (type === 'date' || /^(time|date|year|时间|年代)$/.test(key)) kind = 'time'
    if (type === 'event' || /^(event|事件)$/.test(key)) kind = 'event'
    // Research datasets often use domain-neutral fields for extracted concepts.
    // Treat descriptive labels as event/concept nodes, while leaving numeric
    // measurements and free-form explanations out of the graph by default.
    if (kind === 'ignore' && type !== 'number' && type !== 'boolean' && (
      /^(keyword|keywords|category|关键词|关键字|类别)$/.test(key)
      || /关键词|关键字|类别/.test(field.label || '')
    )) kind = 'event'
    return [field.key, kind]
  }))
}

export function researchRecordValues(record: AiResearchRecord): Record<string, string> {
  try {
    const value: unknown = record.values || JSON.parse(record.values_json || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

export function buildResearchGraph(
  records: AiResearchRecord[],
  mapping: ResearchGraphFieldMapping,
  confirmedOnly = false,
): ResearchGraph {
  const nodes = new Map<string, ResearchGraphNode>()
  const edges = new Map<string, ResearchGraphEdge>()
  const seenRecords = new Set<string>()
  let recordCount = 0
  let omittedValues = 0
  const fields = Object.entries(mapping).filter((entry): entry is [string, ResearchEntityKind] => entry[1] !== 'ignore')
  for (const record of records.slice(0, RESEARCH_GRAPH_RECORD_LIMIT)) {
    if (record.status === 'excluded' || (confirmedOnly && record.status !== 'confirmed') || seenRecords.has(record.id)) continue
    seenRecords.add(record.id)
    const values = researchRecordValues(record)
    const entities = new Map<string, { label: string; kind: ResearchEntityKind }>()
    for (const [key, kind] of fields) {
      const raw = values[key] || ''
      // Keep time expressions and event descriptions intact; do not infer aliases.
      const labels = kind === 'person' || kind === 'place' ? raw.split(/[、;；\n]+/) : [raw]
      for (const value of labels) {
        const label = value.normalize('NFC').replace(/\s+/g, ' ').trim()
        if (!label || EMPTY_VALUES.has(label.toLowerCase())) continue
        const id = JSON.stringify([kind, label])
        if (entities.has(id)) continue
        if (label.length > 160 || entities.size >= MAX_ENTITIES_PER_RECORD) {
          omittedValues += 1
          continue
        }
        entities.set(id, { label, kind })
      }
    }
    if (!entities.size) continue
    recordCount += 1
    for (const [id, entity] of entities) {
      const node = nodes.get(id) || { id, ...entity, recordIds: [] }
      node.recordIds.push(record.id)
      nodes.set(id, node)
    }
    const ids = [...entities.keys()].sort()
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const id = JSON.stringify([ids[i], ids[j]])
        const edge = edges.get(id) || { id, source: ids[i], target: ids[j], kind: 'cooccurrence', label: '共现', directed: false, recordIds: [] }
        edge.recordIds.push(record.id)
        edges.set(id, edge)
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], recordCount, omittedValues }
}

export interface KnowledgeGraphDatasetConfig {
  mapping: ResearchGraphFieldMapping
  sourceField?: string
  targetField?: string
  relationField?: string
}

export interface KnowledgeGraphDataQuery {
  datasetIds: string[]
  limit?: number
}

export interface KnowledgeGraphData {
  libraryProjectId: string
  datasets: AiResearchDataset[]
  records: AiResearchRecord[]
  totalRecords: number
  truncated: boolean
}

export function normalizeKnowledgeGraphConfigs(value: unknown): Record<string, KnowledgeGraphDatasetConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const configs: Record<string, KnowledgeGraphDatasetConfig> = Object.create(null)
  for (const [id, raw] of Object.entries(value).slice(0, 20)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const config = raw as Record<string, unknown>
    if (!config.mapping || typeof config.mapping !== 'object' || Array.isArray(config.mapping)) continue
    const mapping = Object.fromEntries(Object.entries(config.mapping).slice(0, 80).filter(([key, kind]) =>
      key.length <= 320 && ['person', 'place', 'time', 'event', 'ignore'].includes(String(kind)),
    )) as ResearchGraphFieldMapping
    const field = (key: string) => typeof config[key] === 'string' && config[key].length <= 320 ? config[key] : undefined
    configs[id] = { mapping, sourceField: field('sourceField'), targetField: field('targetField'), relationField: field('relationField') }
  }
  return configs
}

export function getResearchDatasetFields(dataset: AiResearchDataset, records: AiResearchRecord[] = []): AiResearchFieldSchema[] {
  let raw: unknown = dataset.fieldSchema
  if (!raw) {
    try { raw = JSON.parse(dataset.field_schema_json || '[]') } catch { raw = [] }
  }
  const fields = Array.isArray(raw) ? raw.filter((field): field is AiResearchFieldSchema =>
    !!field && typeof field === 'object' && typeof field.key === 'string' && typeof field.type === 'string',
  ) : []
  const byKey = new Map(fields.map((field) => [field.key, field]))
  records.forEach((record) => Object.keys(researchRecordValues(record)).forEach((key) => {
    if (!byKey.has(key)) byKey.set(key, { key, label: key, type: 'text' })
  }))
  return [...byKey.values()]
}

export function buildKnowledgeGraph(
  data: KnowledgeGraphData,
  configs: Record<string, KnowledgeGraphDatasetConfig> = {},
  confirmedOnly = false,
): ResearchGraph {
  const nodes = new Map<string, ResearchGraphNode>()
  const edges = new Map<string, ResearchGraphEdge>()
  let recordCount = 0
  let omittedValues = 0
  for (const dataset of data.datasets) {
    const records = data.records.filter((record) => record.dataset_id === dataset.id)
    const config = configs[dataset.id] || { mapping: defaultGraphMapping(getResearchDatasetFields(dataset, records)) }
    const graph = buildResearchGraph(records, config.mapping, confirmedOnly)
    recordCount += graph.recordCount
    omittedValues += graph.omittedValues
    const mergeEdge = (edge: ResearchGraphEdge) => {
      const existing = edges.get(edge.id)
      if (existing) existing.recordIds.push(...edge.recordIds)
      else edges.set(edge.id, { ...edge, recordIds: [...edge.recordIds] })
    }
    graph.nodes.forEach((node) => {
      const existing = nodes.get(node.id)
      if (existing) existing.recordIds.push(...node.recordIds)
      else nodes.set(node.id, node)
    })
    graph.edges.forEach((edge) => {
      mergeEdge(edge)
      const source = nodes.get(edge.source)
      const target = nodes.get(edge.target)
      if ((source?.kind === 'event') !== (target?.kind === 'event')) {
        mergeEdge({ ...edge, id: `event:${edge.id}`, kind: 'event', label: '记录关联' })
      }
    })
    if (config.sourceField && config.targetField && config.relationField) {
      const sourceKind = config.mapping[config.sourceField]
      const targetKind = config.mapping[config.targetField]
      if (!sourceKind || !targetKind || sourceKind === 'ignore' || targetKind === 'ignore') continue
      for (const record of records) {
        if (record.status === 'excluded' || (confirmedOnly && record.status !== 'confirmed')) continue
        const values = researchRecordValues(record)
        const label = String(values[config.relationField] || '').trim()
        // An explicit relation requires one unambiguous source and target.
        const sourceLabel = String(values[config.sourceField] || '').normalize('NFC').replace(/\s+/g, ' ').trim()
        const targetLabel = String(values[config.targetField] || '').normalize('NFC').replace(/\s+/g, ' ').trim()
        if (!label || label.length > 100 || /[、;；\n]/.test(values[config.sourceField] || '') || /[、;；\n]/.test(values[config.targetField] || '')) continue
        const source = JSON.stringify([sourceKind, sourceLabel])
        const target = JSON.stringify([targetKind, targetLabel])
        if (source === target || !nodes.get(source)?.recordIds.includes(record.id) || !nodes.get(target)?.recordIds.includes(record.id)) continue
        mergeEdge({
          id: JSON.stringify(['relation', source, target, label]), source, target, kind: 'relation',
          label, directed: true, recordIds: [record.id],
        })
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], recordCount, omittedValues }
}


export function filterResearchGraph(
  graph: ResearchGraph,
  options: { kinds: ResearchEntityKind[]; minEvidence: number; focusId?: string; bounded?: boolean },
): ResearchGraph & { hiddenNodes: number; hiddenEdges: number } {
  const kinds = new Set(options.kinds)
  let nodes = graph.nodes.filter((node) => kinds.has(node.kind))
  let nodeIds = new Set(nodes.map((node) => node.id))
  let edges = graph.edges.filter((edge) =>
    nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.recordIds.length >= options.minEvidence,
  )
  if (options.focusId) {
    const neighbors = new Set([options.focusId])
    edges.forEach((edge) => {
      if (edge.source === options.focusId) neighbors.add(edge.target)
      if (edge.target === options.focusId) neighbors.add(edge.source)
    })
    nodes = nodes.filter((node) => neighbors.has(node.id))
    edges = edges.filter((edge) => neighbors.has(edge.source) && neighbors.has(edge.target))
  }
  const totalNodes = nodes.length
  const totalEdges = edges.length
  nodes.sort((a, b) =>
    Number(b.id === options.focusId) - Number(a.id === options.focusId)
    || b.recordIds.length - a.recordIds.length || a.id.localeCompare(b.id),
  )
  nodes = nodes.slice(0, options.bounded === false ? nodes.length : RESEARCH_GRAPH_NODE_LIMIT)
  nodeIds = new Set(nodes.map((node) => node.id))
  edges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .sort((a, b) => b.recordIds.length - a.recordIds.length || a.id.localeCompare(b.id))
    .slice(0, options.bounded === false ? edges.length : RESEARCH_GRAPH_EDGE_LIMIT)
  return { ...graph, nodes, edges, hiddenNodes: totalNodes - nodes.length, hiddenEdges: totalEdges - edges.length }
}
