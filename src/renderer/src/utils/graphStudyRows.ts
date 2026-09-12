import type { AiResearchRecord } from '@shared/types'
import type { ResearchGraph, ResearchEntityKind } from '@shared/research-graph'

export type GraphStudyView = 'people' | 'places' | 'events' | 'relations' | 'timeline'
export interface GraphStudyRow {
  id: string
  name: string
  kind: ResearchEntityKind | 'relation'
  source: string
  target: string
  direction: string
  people: string
  places: string
  times: string
  events: string
  documents: string
  recordCount: number
  documentCount: number
  confirmedCount: number
  pendingCount: number
  searchText: string
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
export const compareGraphStudyText = (a: string, b: string) => collator.compare(a, b)

export function buildGraphStudyRows(graph: ResearchGraph, records: AiResearchRecord[], view: GraphStudyView): GraphStudyRow[] {
  const recordsById = new Map(records.map((record) => [record.id, record]))
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const nodesByRecord = new Map<string, ResearchGraph['nodes']>()
  for (const node of graph.nodes) {
    for (const id of node.recordIds) {
      const bucket = nodesByRecord.get(id) || []
      bucket.push(node)
      nodesByRecord.set(id, bucket)
    }
  }
  const kinds: Record<Exclude<GraphStudyView, 'relations'>, ResearchEntityKind> = {
    people: 'person', places: 'place', events: 'event', timeline: 'time',
  }
  const items = view === 'relations' ? graph.edges : graph.nodes.filter((node) => node.kind === kinds[view])
  return items.map((item) => {
    const associated = { person: new Set<string>(), place: new Set<string>(), time: new Set<string>(), event: new Set<string>() }
    const documentIds = new Set<string>()
    const titles = new Set<string>()
    const excerpts: string[] = []
    let confirmedCount = 0
    let pendingCount = 0
    const ids = [...new Set(item.recordIds)]
    for (const id of ids) {
      for (const node of nodesByRecord.get(id) || []) {
        if (node.id !== item.id) associated[node.kind].add(node.label)
      }
      const record = recordsById.get(id)
      if (!record) continue
      if (record.doc_id) documentIds.add(record.doc_id)
      if (record.doc_title) titles.add(record.doc_title)
      if (record.status === 'confirmed') confirmedCount += 1
      else pendingCount += 1
      excerpts.push(record.excerpt || '', record.note || '')
    }
    const join = (values: Set<string>) => [...values].sort(compareGraphStudyText).join('、')
    const row: GraphStudyRow = {
      id: item.id, name: item.label, kind: 'source' in item ? 'relation' : item.kind,
      source: 'source' in item ? nodesById.get(item.source)?.label || '' : '',
      target: 'target' in item ? nodesById.get(item.target)?.label || '' : '',
      direction: 'directed' in item && item.directed ? '有向陈述' : '无向线索',
      people: join(associated.person), places: join(associated.place), times: join(associated.time), events: join(associated.event),
      documents: join(titles), recordCount: ids.length, documentCount: documentIds.size, confirmedCount, pendingCount, searchText: '',
    }
    row.searchText = [row.name, row.source, row.target, row.people, row.places, row.times, row.events, row.documents, ...excerpts].join('\n').toLocaleLowerCase()
    return row
  })
}

export function filterGraphStudyRows(rows: GraphStudyRow[], query: string, review: 'all' | 'pending' | 'confirmed'): GraphStudyRow[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((row) => terms.every((term) => row.searchText.includes(term))
    && (review === 'all' || (review === 'pending' ? row.pendingCount > 0 : row.pendingCount === 0 && row.confirmedCount > 0)))
}
