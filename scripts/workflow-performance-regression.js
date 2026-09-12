// Synthetic fixtures only; no database, user documents or model requests.
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

function load(relativePath) {
  const result = buildSync({ entryPoints: [path.join(__dirname, '..', relativePath)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require)
  return module.exports
}

async function checkPageSaves() {
  const { createDebouncedPageSaver } = load('src/renderer/src/utils/textEditorSaving.ts')
  const saver = createDebouncedPageSaver(10000)
  const writes = []
  let release
  const slowWrite = new Promise((resolve) => { release = resolve })
  const first = saver.schedule(async () => { writes.push('page-a:1'); await slowWrite; return true })
  const firstFlush = saver.flush()
  const second = saver.schedule(() => { writes.push('page-a:2'); return true })
  const pageSwitch = saver.flush()
  const third = saver.schedule(() => { writes.push('page-b:1'); return true })
  release()
  await Promise.all([firstFlush, pageSwitch])
  await saver.flush()
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true])
  assert.deepEqual(writes, ['page-a:1', 'page-a:2', 'page-b:1'], 'page switch must seal the old page before the next page schedules edits')
  const burst = Array.from({ length: 60 }, (_, index) => saver.schedule(() => { writes.push(`burst:${index}`); return true }))
  await saver.flush()
  assert((await Promise.all(burst)).every(Boolean))
  assert.deepEqual(writes.filter((entry) => entry.startsWith('burst:')), ['burst:59'], 'same-page bursts still coalesce')
  let rejectWrite
  const failed = saver.schedule(() => new Promise((resolve) => { rejectWrite = () => resolve(false) }))
  const failureFlush = saver.flush()
  const joiningFlush = saver.flush()
  await Promise.resolve()
  rejectWrite()
  assert.deepEqual(await Promise.all([failed, failureFlush, joiningFlush]), [false, false, false], 'flush must not report success while an active write fails')
}

async function checkCitations() {
  const { resolveResearchNoteCitationMap, resolveResearchNoteCitation, buildResearchNoteFallbackCitation } = load('src/renderer/src/utils/citations.ts')
  const { getResearchNotePageSource } = load('src/shared/research-note-pages.ts')
  let calls = 0
  let active = 0
  let peak = 0
  let styleReads = 0
  global.window = { api: {
    listCitationStyles: async () => { styleReads++; return [{ id: 'test-style', is_default: 1 }] },
    generateCitationByStyle: async (docId, styleId, docType, options) => {
      calls++; active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return `${docId}:${styleId}:${docType}:${options.pageNum}`
    },
  } }
  const notes = Array.from({ length: 1000 }, (_, index) => ({ id: `note-${index}`, doc_id: `doc-${index % 20}`, page_num: index % 20 + 1, doc_type: 'book', excerpt: `Evidence ${index}`, source_id: '', citation_text: '' }))
  const result = await resolveResearchNoteCitationMap(notes)
  assert.equal(Object.keys(result).length, 1000, 'all excerpts retain their citations')
  for (const note of notes) assert.equal(result[note.id], `${note.doc_id}:test-style:book:${note.page_num}`)
  console.log(`Citation fixture: notes=${notes.length}, IPC calls=${calls}, peak=${peak}`)
  assert.equal(calls, 20, 'identical citation requests coalesce within one operation')
  assert(peak <= 4, 'citation IPC concurrency is bounded')
  assert.equal(styleReads, 1)
  const sourceNote = { ...notes[0], page_num: 101, source_id: JSON.stringify({ sourcePageNum: 1 }) }
  assert.match(buildResearchNoteFallbackCitation(sourceNote), /101/, 'physical provenance must not override a printed citation label')
  assert.deepEqual(getResearchNotePageSource(sourceNote), { sourcePageId: undefined, sourcePageNum: 1 })
  assert.deepEqual(getResearchNotePageSource({ ...sourceNote, source_id: '{broken' }), { sourcePageId: undefined, sourcePageNum: undefined }, 'legacy malformed sources remain readable without inventing physical page 101')
  assert.equal(getResearchNotePageSource({ ...sourceNote, source_id: JSON.stringify({ docId: 'doc-other', pageNum: 3 }) }).sourcePageNum, undefined)
  const requests = []
  window.api.generateCitationByStyle = async (docId, styleId, docType, options) => { requests.push(options); return `Page ${options.sourcePageId || options.sourcePageNum || options.pageNum}` }
  const stableNotes = [1, 2].map(index => ({ ...sourceNote, id: `stable-${index}`, locator_json: JSON.stringify({ docId: sourceNote.doc_id, pageId: `page-${index}`, pageNum: index }) }))
  const stableCitations = await resolveResearchNoteCitationMap(stableNotes, { styleId: 'test-style' })
  assert.notEqual(stableCitations['stable-1'], stableCitations['stable-2'], 'equal printed labels must not merge different physical sources')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].sourcePageId, 'page-1')
  await resolveResearchNoteCitation(stableNotes[0], { styleId: 'test-style', pageNum: '12-14' })
  assert.equal(requests[2].sourcePageId, undefined, 'explicit user page ranges take precedence')
  assert.equal(requests[2].pageNum, '12-14')
  window.api.generateCitationByStyle = async () => null
  const fallback = await resolveResearchNoteCitationMap(notes.slice(0, 2).map((note, index) => ({ ...note, doc_id: 'same-doc', page_num: 1, citation_text: `Stored ${index}` })))
  assert(fallback['note-0'].includes('Stored 0') && fallback['note-1'].includes('Stored 1'), 'fallback remains specific to each excerpt')
  window.api.listCitationStyles = async () => { styleReads++; return [] }
  const before = styleReads
  await resolveResearchNoteCitationMap(notes)
  assert.equal(styleReads - before, 1, 'missing default style does not trigger one settings read per note')
  delete global.window
}

async function run() {
  await checkPageSaves()
  await checkCitations()
  console.log('Workflow save and citation performance regressions passed.')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
