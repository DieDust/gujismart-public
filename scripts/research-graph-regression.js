const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const result = buildSync({
  stdin: { contents: "module.exports = { ...require('./src/shared/research-graph.ts'), ...require('./src/shared/research-graph-path.ts'), ...require('./src/renderer/src/utils/graphZoom.ts'), ...require('./src/renderer/src/utils/graphStudyRows.ts') }", resolveDir: path.join(__dirname, '..') },
  bundle: true, platform: 'node', format: 'cjs', write: false,
})
const mod = { exports: {} }
new Function('module', 'exports', result.outputFiles[0].text)(mod, mod.exports)
const { buildResearchGraph, buildKnowledgeGraph, findResearchGraphPath, normalizeKnowledgeGraphConfigs, defaultGraphMapping, filterResearchGraph, RESEARCH_GRAPH_NODE_LIMIT, RESEARCH_GRAPH_EDGE_LIMIT } = mod.exports
const { graphWheelZoomFactor, clampGraphZoom } = mod.exports
const { buildGraphStudyRows, filterGraphStudyRows, compareGraphStudyText } = mod.exports
assert.equal(graphWheelZoomFactor(0, 0, 600), 1)
assert(graphWheelZoomFactor(-100, 0, 600) > 1.3, 'wheel notch must respond visibly')
assert.equal(graphWheelZoomFactor(3, 1, 600), graphWheelZoomFactor(48, 0, 600))
assert.equal(graphWheelZoomFactor(1, 2, 600), graphWheelZoomFactor(600, 0, 600))
assert(Math.abs(graphWheelZoomFactor(100, 0, 600) * graphWheelZoomFactor(-100, 0, 600) - 1) < 1e-10)
assert.equal(clampGraphZoom(0), 0.08)
assert.equal(clampGraphZoom(50), 4)
const mapping = defaultGraphMapping([
  { key: 'person', type: 'person' }, { key: 'place', type: 'place' },
  { key: 'date', type: 'date' }, { key: 'event', type: 'text' }, { key: 'quote', type: 'quote' },
])
assert.equal(mapping.quote, 'ignore')
assert.equal(mapping.event, 'event')
function record(id, values, status = 'pending') {
  return { id, dataset_id: 'fixture-dataset', status, values_json: JSON.stringify(values), excerpt: 'Synthetic evidence' }
}
const records = [
  record('a', { person: 'Alpha;Beta;Alpha', place: 'North;South', date: '1900-1902', event: 'A meeting; a journey' }),
  record('b', { person: 'Alpha;Beta', place: 'North' }, 'confirmed'),
  record('excluded', { person: 'Excluded' }, 'excluded'),
  record('empty', { person: 'N/A', place: '-' }),
]
const graph = buildResearchGraph(records, mapping)
assert.equal(graph.nodes.length, 6)
assert.equal(graph.edges.length, 15)
assert.equal(graph.recordCount, 2)
assert.equal(graph.nodes.find((node) => node.label === 'Alpha').recordIds.length, 2)
const studyRecords = records.map((item) => ({ ...item, doc_id: 'one-document', doc_title: 'Source book', note: 'Review note' }))
const people = buildGraphStudyRows(graph, studyRecords, 'people')
assert.equal(people.length, 2)
const alphaStudy = people.find((row) => row.name === 'Alpha')
assert.equal(alphaStudy.people, 'Beta', 'same-record associates exclude the subject')
assert.equal(alphaStudy.recordCount, 2)
assert.equal(alphaStudy.documentCount, 1, 'document count must deduplicate source IDs')
assert.equal(alphaStudy.pendingCount, 1)
assert.equal(alphaStudy.confirmedCount, 1)
assert.equal(filterGraphStudyRows(people, 'alpha north', 'pending').length, 2)
assert.equal(filterGraphStudyRows(people, 'source book', 'confirmed').length, 0)
assert.equal(filterGraphStudyRows(people, 'unmatched', 'all').length, 0)
assert(compareGraphStudyText('2', '10') < 0)
assert.equal(buildGraphStudyRows(graph, studyRecords, 'timeline')[0].name, '1900-1902')
assert(graph.nodes.some((node) => node.label === 'A meeting; a journey'))
assert(!graph.nodes.some((node) => node.label === 'Excluded'))
assert(graph.edges.every((edge) => edge.source !== edge.target && edge.kind === 'cooccurrence'))
assert.equal(buildResearchGraph([...records, records[0]], mapping).edges.length, graph.edges.length)
assert.equal(buildResearchGraph(records, mapping, true).nodes.length, 3)
assert.equal(buildResearchGraph([{ ...records[0], values_json: '{broken' }], mapping).nodes.length, 0)
assert.equal(buildResearchGraph([record('same-name', { person: 'North', place: 'North' })], mapping).nodes.length, 2)
assert.equal(buildResearchGraph([record('invalid', { person: 'x'.repeat(161) })], mapping).omittedValues, 1)
assert.equal(buildResearchGraph([record('too-many', { person: Array.from({ length: 100 }, (_, i) => `N${i}`).join(';') })], mapping).nodes.length, 16)
const filtered = filterResearchGraph(graph, { kinds: ['person', 'place'], minEvidence: 2 })
assert.equal(filtered.edges.length, 3)
const alphaId = graph.nodes.find((node) => node.label === 'Alpha').id
assert.equal(filterResearchGraph(graph, { kinds: ['person'], minEvidence: 1, focusId: alphaId }).nodes.length, 2)
assert.equal(filterResearchGraph(graph, { kinds: [], minEvidence: 1 }).edges.length, 0)
const large = buildResearchGraph(Array.from({ length: 2000 }, (_, i) =>
  record(`r${i}`, { person: `Person${i};Common`, place: `Place${i}` })), mapping)
const largeView = filterResearchGraph(large, { kinds: ['person', 'place'], minEvidence: 1 })
assert(largeView.nodes.length <= RESEARCH_GRAPH_NODE_LIMIT)
assert(largeView.edges.length <= RESEARCH_GRAPH_EDGE_LIMIT)
assert(largeView.hiddenNodes > 0)
const tableScope = filterResearchGraph(large, { kinds: ['person', 'place'], minEvidence: 1, bounded: false })
assert(tableScope.nodes.length > RESEARCH_GRAPH_NODE_LIMIT, 'study tables must search beyond canvas limits')
assert.equal(tableScope.hiddenNodes, 0)
const visibleIds = new Set(largeView.nodes.map((node) => node.id))
assert(largeView.edges.every((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)))
const dataset = { id: 'fixture-dataset', field_schema_json: '[]' }
const explicit = record('relation-one', { source: 'Alpha', target: 'Beta', relation: 'corresponded with', event: 'Meeting' }, 'confirmed')
const config = { mapping: { source: 'person', target: 'person', event: 'event' }, sourceField: 'source', targetField: 'target', relationField: 'relation' }
const knowledge = buildKnowledgeGraph({ datasets: [dataset], records: [explicit] }, { [dataset.id]: config })
assert.equal(knowledge.edges.filter((edge) => edge.kind === 'relation').length, 1)
assert.equal(knowledge.edges.filter((edge) => edge.kind === 'event').length, 2)
const relation = knowledge.edges.find((edge) => edge.kind === 'relation')
assert.equal(relation.label, 'corresponded with')
assert.equal(relation.directed, true)
const crossDataset = buildKnowledgeGraph({
  datasets: [dataset, { ...dataset, id: 'dataset-two' }],
  records: [explicit, { ...explicit, id: 'relation-two', dataset_id: 'dataset-two' }],
}, { [dataset.id]: config, 'dataset-two': config })
assert(crossDataset.edges.every((edge) => edge.recordIds.length === 2), 'cross-dataset evidence must not be double-counted between edge kinds')
assert.equal(findResearchGraphPath(knowledge, relation.source, relation.target).length, 3)
assert.equal(findResearchGraphPath(knowledge, 'missing', relation.target), null)
assert.equal(buildKnowledgeGraph({ datasets: [dataset], records: [record('ambiguous', { source: 'Alpha;Other', target: 'Beta', relation: 'kinship' })] }, { [dataset.id]: config }).edges.filter((edge) => edge.kind === 'relation').length, 0)
assert.deepEqual(Object.keys(normalizeKnowledgeGraphConfigs(null)), [])
console.log('Research graph behavioral regression passed.')
