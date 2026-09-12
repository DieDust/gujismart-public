const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { Module } = require('node:module')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const compiled = buildSync({ stdin: { contents: `export * from './src/shared/corpus-entities'; export * from './src/main/corpus-research-text'`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = new Module(__filename, module)
loaded._compile(compiled.outputFiles[0].text, __filename)
const { resolveCorpusEntities, explicitAlias, parseCorpusFindings } = loaded.exports
const quote = '甲某，字乙某。'
function finding(id, docId = id, text = quote, uncertainty = '') {
  return { id, docId, pageId: `${docId}-page`, sourceHash: 'same-text-version', start: 0, end: text.length,
    quote: text, uncertainty, claim: 'Synthetic claim', title: docId, pageNum: 1, dimension: 'name', stance: 'context',
    entities: [{ name: '甲某', kind: 'person', aliases: [{ name: '乙某', quote: text }] }] }
}
assert(explicitAlias('甲某', '乙某', quote, ''))
for (const text of ['甲某，不字乙某。', '疑甲某，字乙某。', '甲某与乙某同行。', '甲某，字乙某或丙某。']) assert(!explicitAlias('甲某', '乙某', text, ''))
assert(!explicitAlias('甲某', '乙某', quote, 'The attribution is uncertain.'))
const first = finding('first')
const second = finding('second')
let result = resolveCorpusEntities([first, second], [])
assert.notEqual(result.items[0].groupId, result.items[1].groupId, 'Same name across documents never proves identity')
assert.equal(result.items[0].candidateCount, 1)
assert.deepEqual(result.items[0].aliases, ['乙某'])
const same = { ...first, id: 'repeated-citation' }
result = resolveCorpusEntities([first, same], [])
assert.equal(result.items[0].groupId, result.items[1].groupId, 'Same exact source occurrence can deduplicate')
const alias = { ...first, id: 'alias-citation', entities: [{ name: '乙某', kind: 'person', aliases: [] }] }
result = resolveCorpusEntities([first, alias], [])
assert.equal(result.items[0].groupId, result.items[1].groupId, 'Explicit local alias shares an identity with that precise source occurrence')
const merge = { id: 'merge', action: 'merge', mentionIds: ['first:0', 'second:0'], reason: 'Checked dates and office', revision: 1 }
const split = { id: 'split', action: 'split', mentionIds: ['second:0'], reason: 'Conflicting dates', revision: 2 }
const undo = { id: 'undo', action: 'undo', mentionIds: [], reason: 'Correction', revision: 3 }
result = resolveCorpusEntities([first, second], [merge])
assert.equal(result.items[0].groupId, result.items[1].groupId)
assert.equal(result.items[0].groupSize, 2)
assert.equal(result.items[0].candidateCount, 0)
result = resolveCorpusEntities([first, second], [merge, split])
assert.notEqual(result.items[0].groupId, result.items[1].groupId)
assert.deepEqual(result.items[1].aliases, [])
result = resolveCorpusEntities([first, second], [merge, split, undo])
assert.equal(result.items[0].groupId, result.items[1].groupId)
assert.deepEqual(result.items[1].aliases, ['乙某'])
result = resolveCorpusEntities([first, second], [merge, split, undo, { ...undo, id: 'undo2' }])
assert.notEqual(result.items[0].groupId, result.items[1].groupId)
assert.equal(result.canUndo, false)
assert.equal(resolveCorpusEntities([{ ...first, entities: undefined }], []).unprocessedFindings, 1)
result = resolveCorpusEntities([first, { ...same, sourceHash: 'edited' }], [])
assert.notEqual(result.items[0].groupId, result.items[1].groupId, 'Never deduplicate across source versions')
result = resolveCorpusEntities([first, { ...alias, entities: [{ name: '甲某', kind: 'place', aliases: [] }] }], [])
assert.notEqual(result.items[0].groupId, result.items[1].groupId, 'Different types remain separate')
const response = (entities) => JSON.stringify({ reviewed: true, findings: [{ ...first, entities }] })
assert.equal(parseCorpusFindings(response(first.entities), quote)[0].entities.length, 1)
assert.throws(() => parseCorpusFindings(response([{ ...first.entities[0], name: '不存在' }]), quote), /verbatim/)
assert.throws(() => parseCorpusFindings(response([{ ...first.entities[0], aliases: [{ name: '乙某', quote: '拼接引文' }] }]), quote), /contiguous/)
assert.throws(() => parseCorpusFindings(response(Array(25).fill(first.entities[0])), quote), /at most 24/)
const start = performance.now()
result = resolveCorpusEntities(Array.from({ length: 10000 }, (_, index) => finding(`synthetic-${index}`)), [])
assert.equal(result.items.length, 10000)
assert.equal(new Set(result.items.map((item) => item.groupId)).size, 10000)
assert.equal(result.items[9999].candidateCount, 9999)
console.log(`Entity regression passed: explicit local aliases, homonyms, provenance, merge/split/undo, legacy compatibility, strict extraction; 10000 mentions in ${Math.round(performance.now() - start)}ms.`)
