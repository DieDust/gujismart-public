// Run with Electron: real temporary SQLite, synthetic pages, and no network/model calls.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Module } = require('node:module')
const { build } = require('esbuild')

assert(process.versions.electron, 'Run: node node_modules/electron/cli.js scripts/corpus-research-integration-regression.js')
const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-corpus-integration-'))
process.env.GUJISMART_DATA_DIR = path.join(tempRoot, 'data')
process.env.GUJISMART_AUTO_REINDEX = '0'
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

const tick = () => new Promise((resolve) => setImmediate(resolve))
const identity = { provider: 'synthetic', baseUrl: 'https://fixture.invalid', model: 'corpus-regression' }
const state = { calls: [], invocations: 0, active: 0, peak: 0, behaviors: new Map(), contractErrors: [], blockedNetwork: 0 }
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { state.blockedNetwork++; throw new Error('Network is forbidden in the corpus regression') }
let database
let corpus
let entities
let library
let libraryA
let libraryB
let sequence = 0
const jobs = new Map()
const failures = []

function checkContract(operation) {
  try { return operation() } catch (error) { state.contractErrors.push(error); throw error }
}

class LlmRequestError extends Error {
  constructor(message, retryable, code) {
    super(message)
    this.retryable = retryable
    this.code = code
  }
}

const aiStub = {
  LlmRequestError,
  getLlmConfigIdentity: () => ({ ...identity }),
  async callLLM(messages, options) {
    state.invocations++
    checkContract(() => {
      assert.equal(typeof options.onRequest, 'function', 'Reserve before a simulated paid call')
      assert.equal(typeof options.onUsage, 'function', 'Persist measured usage')
      assert(Number.isSafeInteger(options.maxOutputTokens) && options.maxOutputTokens > 0 && options.maxOutputTokens <= 4096)
      assert.equal(options.rejectTruncated, true)
      assert.deepEqual(options.expectedConfig, identity)
      assert(Buffer.byteLength(JSON.stringify(messages), 'utf8') <= 24000)
    })
    // A throwing budget callback is not a charged request and produces no usage.
    options.onRequest()
    const event = database.queryOne("SELECT * FROM task_events WHERE event_type = 'corpus_request' ORDER BY id DESC LIMIT 1")
    const item = database.queryOne('SELECT * FROM task_items WHERE id = ?', [event.item_id])
    const call = { jobId: event.job_id, itemId: item.id, type: item.domain_type, input: JSON.parse(item.input_json),
      prompt: messages.map((message) => message.content).join('\n'), reservation: JSON.parse(event.payload_json), success: false }
    state.calls.push(call)
    state.peak = Math.max(state.peak, ++state.active)
    try {
      // Yield with a request in flight so two jobs expose a missing shared lane.
      await tick()
      if (call.type === 'corpus.report') {
        const serialized = call.prompt.split('\n').at(-1)
        const inputs = checkContract(() => JSON.parse(serialized))
        checkContract(() => {
          assert(inputs.length > 0 && inputs.length <= 8 && inputs.every((input) => typeof input.id === 'string'))
          assert(Buffer.byteLength(serialized, 'utf8') <= 14000, 'Dynamic summary batches must obey their byte budget')
        })
        call.summaryInputs = inputs.map((input) => input.id)
      }
      let raw = await state.behaviors.get(call.jobId)?.(call)
      if (raw === undefined && call.type === 'corpus.unit') {
        const quote = call.input.text.split(/\r?\n/).filter((line) => line.trim()).at(-1)
        checkContract(() => assert(call.prompt.includes(call.input.text), 'Send the whole frozen unit, including its tail'))
        raw = JSON.stringify({ reviewed: true, findings: [{ claim: 'The fixture author did not confirm the attribution.',
          quote, stance: 'challenge', dimension: 'attribution', uncertainty: 'Synthetic account, not independent confirmation.' }] })
      } else if (raw === undefined) {
        raw = JSON.stringify({ points: [{ text: 'Synthetic sources retain the attributed denial and uncertainty.', sourceIds: call.summaryInputs }] })
      }
      // Existing fixtures model no entities; specific entity tests supply their own schema.
      if (call.type === 'corpus.unit' && !call.omitEntities) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed.findings)) for (const finding of parsed.findings) if (finding && typeof finding === 'object' && finding.entities === undefined) finding.entities = []
        raw = JSON.stringify(parsed)
      }
      if (call.type === 'corpus.report') checkContract(() => {
        assert(JSON.parse(raw).points.every((point) => Buffer.byteLength(point.text, 'utf8') <= 600), 'Keep each summary point within 600 UTF-8 bytes')
      })
      // ASCII fixture output fits even when one UTF-8 byte is reserved per token.
      const outputTokens = Buffer.byteLength(raw, 'utf8')
      checkContract(() => assert(outputTokens <= options.maxOutputTokens, 'Stub must honor maxOutputTokens'))
      const usage = { inputTokens: 17, outputTokens, cachedInputTokens: 0, totalTokens: 17 + outputTokens }
      options.onUsage(usage)
      call.usage = usage
      call.success = true
      return raw
    } finally { state.active-- }
  },
}

function inLibrary(id, operation) { return library.withLibraryProjectContext(id, operation) }
function status(id) { return inLibrary(jobs.get(id), () => corpus.getCorpusResearch(id)) }
function calls(id, type) { return state.calls.filter((call) => call.jobId === id && (!type || call.type === type)) }
function items(id, type = 'corpus.unit') {
  return database.queryAll('SELECT * FROM task_items WHERE job_id = ? AND domain_type = ? ORDER BY ordinal', [id, type])
}
function artifacts(id, kind) {
  return database.queryAll('SELECT * FROM task_artifacts WHERE job_id = ? AND kind = ? ORDER BY seq', [id, kind])
}
function assertEvidence(finding) {
  const evidence = database.queryOne('SELECT * FROM research_evidence WHERE id = ?', [finding.evidenceId])
  assert(evidence, 'Extraction must call the real research evidence repository')
  assert.equal(evidence.doc_id, finding.docId)
  assert.equal(evidence.page_id, finding.pageId)
  assert.equal(evidence.quote, finding.quote)
  assert.equal(evidence.source_hash, finding.sourceHash)
  assert.equal(evidence.verification_status, 'verified')
  assert.deepEqual(finding.stableLocator, JSON.parse(evidence.locator_json))
  assert.equal(finding.stableLocator.offsetUnit, 'utf16-code-unit')
  assert.deepEqual(finding.stableLocator.sourceRanges, [{ start: finding.start, end: finding.end }])
}
function assertReportSources(id) {
  const value = status(id)
  assert(value.reportSources.length > 0)
  const findings = artifacts(id, 'corpus.finding').map((row) => JSON.parse(row.metadata_json))
  for (const [index, source] of value.reportSources.entries()) {
    const finding = findings.find((row) => row.docId === source.doc_id && row.pageId === source.locator.pageId && row.quote === source.snippet)
    assert(finding, 'Report sources must resolve to this job\'s actual findings')
    assert.deepEqual(source.stableLocator, finding.stableLocator)
    assert.equal(source.source_hash, finding.sourceHash)
    assert.equal(source.locator.charStart, finding.start)
    assert.equal(source.locator.charEnd, finding.end)
    assert(value.report.includes(`[${index + 1}]`))
  }
}
function assertAccounting(id) {
  const value = status(id)
  const sent = calls(id)
  const measured = sent.filter((call) => call.usage)
  assert.equal(value.requests, sent.length)
  assert.equal(value.measuredRequests, measured.length)
  assert.equal(value.inputTokens, measured.reduce((sum, call) => sum + call.usage.inputTokens, 0))
  assert.equal(value.outputTokens, measured.reduce((sum, call) => sum + call.usage.outputTokens, 0))
  assert.equal(value.reservedInputBytes, sent.reduce((sum, call) => sum + call.reservation.inputBytes, 0))
  assert(sent.every((call) => call.reservation.maxOutputTokens > 0))
  assert.equal(value.active, false, 'waitForCorpusResearch must settle the job')
}

function seedDocuments(prefix, count, project = libraryA, options = {}) {
  const result = []
  database.transaction(() => {
    for (let index = 0; index < count; index++) {
      const id = `${prefix}-${String(index).padStart(4, '0')}`
      const text = options.text ?? `Synthetic page ${id}.\n\nTAIL_${id}: the author did not confirm the attribution.`
      database.run(`INSERT INTO documents (id,library_project_id,title,page_count,ocr_status,import_status,created_at,updated_at)
        VALUES (?,?,?,?,'completed','stored','2026-01-01','2026-01-01')`, [id, project, id, options.noPage ? 0 : 1])
      database.run(`INSERT OR IGNORE INTO library_project_documents (project_id,document_id,created_at,updated_at)
        VALUES (?,?,'2026-01-01','2026-01-01')`, [project, id])
      if (!options.noPage) database.run(`INSERT INTO pages (id,doc_id,page_num,ocr_text,ocr_status,proof_status,created_at)
        VALUES (?,?,1,?,?,'pending','2026-01-01')`, [`page-${id}`, id, text, text ? 'completed' : 'pending'])
      result.push(id)
    }
  })
  return result
}

async function create(docIds, options = {}) {
  const { libraryId = libraryA, ...overrides } = options
  const before = state.calls.length
  const beforeInvocations = state.invocations
  const result = await inLibrary(libraryId, () => corpus.createCorpusResearch({
    requestKey: `fixture-${++sequence}`, question: 'What does the source actually attribute, deny, or leave uncertain?',
    scope: { type: 'documents', docIds }, maxRequests: 100, reuseCompleted: false, ...overrides,
  }))
  jobs.set(result.id, libraryId)
  assert.equal(state.invocations, beforeInvocations, 'Snapshot setup must not invoke callLLM')
  assert.equal(state.calls.length, before, 'Snapshot setup must not call the model')
  assert.equal(result.requests, 0, 'Snapshot setup has no charged requests')
  assert.equal(result.measuredRequests, 0)
  assert.equal(result.active, false)
  assert.equal(result.phase, 'ready')
  return result.id
}

function start(id, options) { return inLibrary(jobs.get(id), () => corpus.startCorpusResearch(id, options)) }
async function wait(id) {
  await corpus.waitForCorpusResearch(id)
  assertAccounting(id)
  return status(id)
}
async function execute(id, options) { start(id, options); return wait(id) }

async function test(name, operation) {
  try { await operation(); console.log(`PASS ${name}`) } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ${name}:`, error.stack || error)
  }
}

async function run() {
  try {
    // In-memory aliases keep the real AI module out of the bundle entirely.
    const output = await build({
      stdin: { contents: `module.exports = { entities: require('./src/main/corpus-entities.ts'), database: require('./src/main/database.ts'), corpus: require('./src/main/corpus-research.ts'), library: require('./src/main/library-projects.ts') }`, resolveDir: root },
      bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true,
      external: ['better-sqlite3', 'corpus-regression-ai'], logLevel: 'silent',
      alias: { '@electron-toolkit/utils': path.join(root, 'scripts/stubs/electron-toolkit-utils.js') },
      plugins: [{ name: 'isolated-corpus-aliases', setup(builder) {
        builder.onResolve({ filter: /(^|[\\/])ai(?:\.ts)?$/ }, (args) => {
          const resolved = path.resolve(args.resolveDir, args.path).replace(/\.ts$/, '')
          assert.equal(resolved, path.join(root, 'src/main/ai'))
          return { path: 'corpus-regression-ai', external: true }
        })
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
          `exports.app={getPath:()=>${JSON.stringify(tempRoot)},getAppPath:()=>${JSON.stringify(root)},getName:()=>'GujiSmart',isPackaged:false}`, loader: 'js' }))
      } }],
    })
    assert(!Object.keys(output.metafile.inputs).some((file) => /src[\\/]main[\\/]ai\.ts$/.test(file)), 'Never bundle the real AI provider')
    const bundled = new Module(path.join(tempRoot, 'corpus-regression.cjs'), module)
    bundled.filename = path.join(tempRoot, 'corpus-regression.cjs')
    bundled.paths = Module._nodeModulePaths(root)
    const nativeRequire = bundled.require.bind(bundled)
    bundled.require = (name) => name === 'corpus-regression-ai' ? aiStub : nativeRequire(name)
    bundled._compile(output.outputFiles[0].text, bundled.filename)
    ;({ database, corpus, library, entities } = bundled.exports)
    await database.initDatabase()
    const dbPath = path.resolve(database.getDatabaseFilePath())
    assert(dbPath.startsWith(path.resolve(tempRoot) + path.sep), 'SQLite must be inside the synthetic temp directory')
    assert.equal(fs.readFileSync(dbPath).subarray(0, 16).toString(), 'SQLite format 3\u0000')
    libraryA = library.createLibraryProject({ name: 'Synthetic corpus A', activate: true }).id
    libraryB = library.createLibraryProject({ name: 'Synthetic corpus B' }).id
    for (const [id, project] of [['topic-a', libraryA], ['topic-b', libraryB]]) {
      database.run("INSERT INTO research_projects (id,library_project_id,name,status,created_at,updated_at) VALUES (?,?,?,'active','2026-01-01','2026-01-01')", [id, project, id])
    }

    // 1000 ordinary one-page documents plus one final sentinel crosses both old caps.
    const largeDocs = seedDocuments('corpus', 1000)
    largeDocs.push(...seedDocuments('zz-tail-sentinel', 1))
    const foreignDocs = seedDocuments('foreign', 1, libraryB)

    await test('1001-document snapshot, tail evidence, two-job default concurrency=1, and usage accounting', async () => {
      const large = await create([], { scope: { type: 'all' }, maxRequests: 10000, projectId: 'topic-a' })
      const peer = await create(foreignDocs, { libraryId: libraryB })
      assert.equal(status(large).totalDocuments, 1001)
      assert.equal(status(large).totalUnits, 1001)
      assert.equal(artifacts(large, 'corpus.document').length, 1001)
      assert.deepEqual(new Set(items(large).map((row) => row.domain_ref)), new Set(largeDocs))
      const seen = []
      for (let offset = 0; offset < 1001; offset += 100) {
        const page = inLibrary(libraryA, () => corpus.listCorpusResearchDocuments(large, { offset, limit: 100 }))
        assert.equal(page.total, 1001)
        seen.push(...page.items.map((row) => row.docId))
      }
      assert.equal(new Set(seen).size, 1001, 'UI paging must not hide later documents')
      state.peak = 0
      start(large)
      start(peer)
      library.setActiveLibraryProject(libraryB)
      const largeStatus = await wait(large)
      const peerStatus = await wait(peer)
      library.setActiveLibraryProject(libraryA)
      assert.equal(largeStatus.status, 'completed', largeStatus.error)
      assert.equal(peerStatus.status, 'completed', peerStatus.error)
      assert.equal(state.peak, 1, 'Shared request lane must serialize different jobs/libraries')
      assert.equal(largeStatus.completedUnits, 1001)
      assert.equal(largeStatus.findings, 1001)
      assert.equal(largeStatus.failedUnits, 0)
      assert(largeStatus.report)
      assert.equal(calls(large, 'corpus.unit').length, 1001)
      assert(calls(large, 'corpus.report').length > 100, 'Exercise hierarchical persisted summaries')
      assert(calls(large).length < 1300, 'Small fixtures should need about 1001 + 145 calls')
      const peerIndex = state.calls.findIndex((call) => call.jobId === peer)
      const lastLargeIndex = state.calls.findLastIndex((call) => call.jobId === large)
      assert(peerIndex >= 0 && peerIndex < lastLargeIndex, 'Both jobs must run, not merely start sequentially')
      const findings = artifacts(large, 'corpus.finding').map((row) => JSON.parse(row.metadata_json))
      assert.deepEqual(new Set(findings.map((row) => row.docId)), new Set(largeDocs))
      for (const finding of findings) {
        const page = database.queryOne('SELECT ocr_text FROM pages WHERE id = ?', [finding.pageId])
        assert.equal(page.ocr_text.slice(finding.start, finding.end), finding.quote)
        assert(finding.quote.includes(`TAIL_${finding.docId}`))
        assert.equal(finding.stance, 'challenge')
        assertEvidence(finding)
      }
      const tail = inLibrary(libraryA, () => corpus.listCorpusResearchFindings(large, { docId: largeDocs.at(-1) }))
      assert.equal(tail.total, 1)
      assert(tail.items[0].quote.includes('TAIL_zz-tail-sentinel'))
      assert.equal(tail.items[0].sourceStatus, 'current')
      assertEvidence(tail.items[0])
      assert.equal(database.queryOne("SELECT COUNT(*) count FROM research_evidence_relations WHERE project_id = 'topic-a' AND relation_kind = ?", [`corpus:${large}`]).count, 1001)
      assertReportSources(large)
      assertReportSources(peer)
      assert.equal(status(peer).totalDocuments, 1)
    })

    await test('budget pause and explicit additionalRequests resume without repeating success', async () => {
      const id = await create(seedDocuments('budget', 3), { maxRequests: 1 })
      let value = await execute(id)
      assert.equal(value.status, 'paused')
      assert.equal(value.phase, 'budget')
      assert.equal(value.requests, 1)
      assert.equal(value.completedUnits, 1)
      const preserved = artifacts(id, 'corpus.finding')
      value = await execute(id)
      assert.equal(value.status, 'paused')
      assert.equal(value.requests, 1, 'A plain resume cannot silently increase the paid budget')
      value = await execute(id, { additionalRequests: 20 })
      assert.equal(value.status, 'completed', value.error)
      assert.equal(value.maxRequests, 21)
      assert.equal(calls(id, 'corpus.unit').length, 3)
      assert.deepEqual(artifacts(id, 'corpus.finding').slice(0, 1), preserved)
      assert(calls(id, 'corpus.unit').every((call) => calls(id).filter((other) => other.itemId === call.itemId).length === 1))
      const count = calls(id).length
      await execute(id, { retryFailed: true, additionalRequests: 1 })
      assert.equal(calls(id).length, count, 'Completed jobs cannot be charged again')
    })

    await test('failed chunk retry only; completed extraction artifacts and attempts stay unchanged', async () => {
      const text = [0, 1, 2].map((index) => `\u{20000} ${'x'.repeat(9000)}\nTAIL_CHUNK_${index}: the author did not confirm the attribution.\n\n`).join('').trim()
      const docs = seedDocuments('retry', 1, libraryA, { text })
      const id = await create(docs)
      const chunks = items(id)
      assert.equal(chunks.length, 3, 'Exercise multiple UTF-8 chunks within one page')
      assert.equal(chunks.map((row) => JSON.parse(row.input_json).text).join(''), text)
      const failedItemId = chunks[1].id
      let fault = true
      state.behaviors.set(id, (call) => {
        if (fault && call.itemId === failedItemId) { fault = false; throw new LlmRequestError('Synthetic extraction failure', false) }
      })
      let value = await execute(id)
      assert.equal(value.failedUnits, 1)
      assert.equal(value.completedUnits, 2)
      assert.notEqual(value.status, 'completed')
      assert.equal(value.report, '')
      const preserved = artifacts(id, 'corpus.finding')
      const completed = items(id).filter((row) => row.status === 'completed')
      value = await execute(id, { retryFailed: true })
      assert.equal(value.status, 'completed', value.error)
      assert.equal(calls(id, 'corpus.unit').length, 4)
      for (const row of completed) assert.equal(items(id).find((item) => item.id === row.id).attempt_count, row.attempt_count)
      for (const row of preserved) assert.deepEqual(artifacts(id, 'corpus.finding').find((item) => item.id === row.id), row)
      assert.equal(calls(id, 'corpus.unit').filter((call) => call.itemId === failedItemId).length, 2)
      const findings = artifacts(id, 'corpus.finding').map((row) => JSON.parse(row.metadata_json))
      assert.equal(findings.length, 3)
      for (const finding of findings) assert.equal(text.slice(finding.start, finding.end), finding.quote, 'Persist page-global UTF-16 quote offsets')
      assert(findings.some((finding) => finding.start > 18000 && finding.quote.includes('TAIL_CHUNK_2')), 'Persist evidence from the final chunk')
    })

    await test('retryable request failures retry at most once and account for each actual request', async () => {
      for (const recovers of [true, false]) {
        const id = await create(seedDocuments(recovers ? 'transient-recovery' : 'transient-exhausted', 1))
        let attempts = 0
        state.behaviors.set(id, (call) => {
          if (call.type === 'corpus.unit' && (++attempts === 1 || !recovers)) {
            throw new LlmRequestError('Synthetic retryable provider failure', true)
          }
        })
        const value = await execute(id)
        const sent = calls(id, 'corpus.unit')
        assert.equal(sent.length, 2, 'One original request plus one retry, never a third')
        assert.equal(sent[0].itemId, sent[1].itemId)
        assert.notEqual(sent[0].reservation.requestId, sent[1].reservation.requestId)
        assert.equal(items(id)[0].attempt_count, 1, 'Provider retry stays within the scheduler attempt')
        if (recovers) {
          assert.equal(value.status, 'completed', value.error)
          assert.equal(value.failedUnits, 0)
          assert.equal(value.findings, 1)
          assert.equal(sent[1].success, true)
        } else {
          assert.notEqual(value.status, 'completed')
          assert.equal(value.failedUnits, 1)
          assert.equal(value.findings, 0)
          assert.equal(value.requests, 2)
          assert.equal(value.measuredRequests, 0)
          assert.match(items(id)[0].error_json, /Synthetic retryable provider failure/)
        }
      }
    })

    await test('three consecutive non-retryable failures stop the queue until explicit resume', async () => {
      const id = await create(seedDocuments('consecutive-failures', 5))
      state.behaviors.set(id, () => { throw new LlmRequestError('Synthetic non-retryable provider failure', false) })
      let value = await execute(id)
      assert.equal(value.status, 'paused')
      assert.equal(value.failedUnits, 3)
      assert.equal(value.pendingUnits, 2)
      assert.equal(value.requests, 3, 'Non-retryable errors must not issue compatibility or provider retries')
      assert.equal(value.completedUnits, 0)
      assert.equal(value.report, '')
      assert(items(id).slice(3).every((item) => item.status === 'queued' && item.attempt_count === 0))
      assert.equal(items(id, 'corpus.report')[0].status, 'queued')
      state.behaviors.delete(id)
      value = await execute(id, { retryFailed: true })
      assert.equal(value.status, 'completed', value.error)
      assert.equal(value.completedUnits, 5)
      assert.equal(value.failedUnits, 0)
      assert.equal(calls(id, 'corpus.unit').length, 8)
    })

    await test('unmatched quotes never complete a chunk or persist evidence', async () => {
      const id = await create(seedDocuments('bad-quote', 1))
      state.behaviors.set(id, () => JSON.stringify({ reviewed: true, findings: [{ claim: 'Unsupported fixture claim',
        quote: 'This quote is absent from the page.', stance: 'support', dimension: 'test', uncertainty: '' }] }))
      const value = await execute(id)
      assert.equal(value.failedUnits, 1)
      assert.equal(value.completedUnits, 0)
      assert.equal(value.findings, 0)
      assert.equal(value.requests, 1)
      assert.notEqual(value.status, 'completed')
      assert.equal(items(id)[0].status, 'error')
      assert.match(items(id)[0].error_json, /quote|substring/)
      assert.equal(value.report, '')
    })

    await test('report failure preserves extraction and persisted summaries across SQLite reopen', async () => {
      const id = await create(seedDocuments('report-retry', 17))
      let summaries = 0
      state.behaviors.set(id, (call) => {
        if (call.type === 'corpus.report' && ++summaries === 2) throw new LlmRequestError('Synthetic report failure', false)
      })
      let value = await execute(id)
      assert.equal(value.completedUnits, 17)
      assert.equal(value.failedUnits, 0)
      assert.notEqual(value.status, 'completed')
      assert.equal(value.report, '')
      const extraction = artifacts(id, 'corpus.finding')
      const savedSummaries = database.queryAll("SELECT * FROM task_artifacts WHERE job_id = ? AND kind LIKE 'corpus.summary.%' ORDER BY seq", [id])
      assert.equal(savedSummaries.length, 1, 'Save the first map, then fail the second map')
      assert.equal(savedSummaries[0].kind, 'corpus.summary.0')
      assert.equal(calls(id, 'corpus.report').length, 2)
      assert.equal(calls(id, 'corpus.report')[1].success, false)
      const successfulPrompt = calls(id, 'corpus.report').find((call) => call.success).prompt
      const failedPrompt = calls(id, 'corpus.report')[1].prompt
      assert.deepEqual(JSON.parse(savedSummaries[0].metadata_json).inputs, calls(id, 'corpus.report')[0].summaryInputs)
      const requestCount = calls(id).length
      database.closeDatabase()
      await database.initDatabase()
      assert.equal(calls(id).length, requestCount, 'Reopening SQLite must not resume paid work')
      assert.deepEqual(artifacts(id, 'corpus.finding'), extraction)
      for (const row of savedSummaries) assert.deepEqual(artifacts(id, row.kind).find((item) => item.id === row.id), row)
      assert.equal(status(id).requests, requestCount)
      value = await execute(id, { retryFailed: true })
      assert.equal(value.status, 'completed', value.error)
      assert(value.report)
      assert.equal(calls(id, 'corpus.unit').length, 17)
      assert.deepEqual(artifacts(id, 'corpus.finding'), extraction)
      assert.equal(calls(id, 'corpus.report').filter((call) => call.prompt === successfulPrompt).length, 1, 'Reuse successful persisted summaries')
      assert.equal(calls(id, 'corpus.report').filter((call) => call.prompt === failedPrompt).length, 2, 'Retry the failed map exactly once')
      for (const row of savedSummaries) assert.deepEqual(artifacts(id, row.kind).find((item) => item.id === row.id), row)
      assert(items(id).every((item) => item.attempt_count === 1))
      assertReportSources(id)
    })

    await test('missing OCR and missing pages are explicit failures, not reviewed-empty success', async () => {
      const docs = [...seedDocuments('missing-ocr', 1, libraryA, { text: '' }), ...seedDocuments('missing-page', 1, libraryA, { noPage: true })]
      const id = await create(docs)
      const value = await execute(id)
      assert.equal(value.totalDocuments, 2)
      assert.equal(value.totalUnits, 2)
      assert.equal(value.failedUnits, 2)
      assert.equal(value.completedUnits, 0)
      assert.equal(value.requests, 0)
      assert.notEqual(value.status, 'completed')
      const rows = inLibrary(libraryA, () => corpus.listCorpusResearchDocuments(id)).items
      assert(rows.every((row) => row.failedUnits === 1 && row.error))
      assert.equal(value.report, '')
    })

    await test('body changes before a request or while in flight fail without stale findings', async () => {
      for (const duringRequest of [false, true]) {
        const docs = seedDocuments(duringRequest ? 'changed-inflight' : 'changed-before', 1)
        const id = await create(docs)
        const change = () => database.run('UPDATE pages SET ocr_text = ? WHERE doc_id = ?', ['Changed synthetic body.', docs[0]])
        if (duringRequest) state.behaviors.set(id, change)
        else change()
        const value = await execute(id)
        assert.equal(value.failedUnits, 1)
        assert.equal(value.completedUnits, 0)
        assert.equal(value.findings, 0)
        assert.equal(value.requests, duringRequest ? 1 : 0)
        assert.notEqual(value.status, 'completed')
        assert(items(id)[0].error_json)
      }
    })

    await test('body changes after extraction block a complete report while preserving old evidence', async () => {
      const docs = seedDocuments('changed-after', 2)
      const id = await create(docs, { maxRequests: 1 })
      await execute(id)
      const preserved = artifacts(id, 'corpus.finding')
      assert.equal(preserved.length, 1)
      const pageId = JSON.parse(preserved[0].metadata_json).pageId
      database.run('UPDATE pages SET ocr_text = ? WHERE id = ?', ['Changed after extraction.', pageId])
      const value = await execute(id, { additionalRequests: 20 })
      assert.notEqual(value.status, 'completed')
      assert.equal(value.report, '')
      assert.deepEqual(artifacts(id, 'corpus.finding').find((row) => row.id === preserved[0].id), preserved[0])
      assert.equal(calls(id, 'corpus.report').length, 0, 'Validate source versions before paid synthesis')
      assert.equal(items(id, 'corpus.report')[0].status, 'error')
      const stale = inLibrary(libraryA, () => corpus.listCorpusResearchFindings(id)).items.find((row) => row.pageId === pageId)
      assert.equal(stale.sourceStatus, 'stale')
      assert.deepEqual(stale.stableLocator, JSON.parse(preserved[0].metadata_json).stableLocator)
    })

    await test('default extraction cache reuse, explicit opt-out, and question/model/library cache isolation', async () => {
      const docs = seedDocuments('cache', 1)
      const first = await create(docs)
      assert.equal((await execute(first)).status, 'completed')
      const original = JSON.parse(artifacts(first, 'corpus.finding')[0].metadata_json)
      const reused = await create(docs, { reuseCompleted: undefined })
      assert.equal((await execute(reused)).status, 'completed')
      assert.equal(calls(reused, 'corpus.unit').length, 0, 'The default cache must skip identical extraction requests')
      assert.equal(JSON.parse(artifacts(reused, 'corpus.extraction')[0].metadata_json).reused, true)
      const cachedFinding = JSON.parse(artifacts(reused, 'corpus.finding')[0].metadata_json)
      assert.equal(cachedFinding.evidenceId, original.evidenceId, 'Reuse real deduplicated evidence')
      assertEvidence(cachedFinding)
      assertReportSources(reused)
      const fresh = await create(docs, { reuseCompleted: false })
      assert.equal((await execute(fresh)).status, 'completed')
      assert.equal(calls(fresh, 'corpus.unit').length, 1)
      assert.equal(JSON.parse(artifacts(fresh, 'corpus.extraction')[0].metadata_json).reused, false)
      const otherQuestion = await create(docs, { reuseCompleted: undefined, question: 'Which synthetic attribution remains uncertain?' })
      assert.equal((await execute(otherQuestion)).status, 'completed')
      assert.equal(calls(otherQuestion, 'corpus.unit').length, 1, 'A different question cannot reuse extraction')
      const previousModel = identity.model
      try {
        identity.model = 'corpus-regression-alternate'
        const otherModel = await create(docs, { reuseCompleted: undefined })
        assert.equal((await execute(otherModel)).status, 'completed')
        assert.equal(calls(otherModel, 'corpus.unit').length, 1, 'A different model cannot reuse extraction')
      } finally { identity.model = previousModel }
      library.ensureDocumentLibraryProjectMembership(docs[0], libraryB)
      const otherLibrary = await create(docs, { libraryId: libraryB, reuseCompleted: undefined })
      assert.equal((await execute(otherLibrary)).status, 'completed')
      assert.equal(calls(otherLibrary, 'corpus.unit').length, 1, 'Identical prompts cannot share extraction caches across libraries')
      database.run('DELETE FROM pages WHERE id = ?', [original.pageId])
      const missing = inLibrary(libraryA, () => corpus.listCorpusResearchFindings(first)).items[0]
      assert.equal(missing.sourceStatus, 'missing')
      assert.deepEqual(missing.stableLocator, original.stableLocator, 'Keep the original locator when its page disappears')
    })

    await test('library ownership, cross-library documents/projects, and request-key isolation', async () => {
      const idA = await create([largeDocs[0]], { requestKey: 'shared-key', projectId: 'topic-a' })
      const idB = await create(foreignDocs, { libraryId: libraryB, requestKey: 'shared-key', projectId: 'topic-b' })
      assert.notEqual(idA, idB)
      const before = state.calls.length
      const beforeJobs = database.queryOne('SELECT COUNT(*) count FROM task_jobs').count
      for (const payload of [
        { requestKey: 'cross-doc', scope: { type: 'documents', docIds: foreignDocs } },
        { requestKey: 'mixed-docs', scope: { type: 'documents', docIds: [largeDocs[0], ...foreignDocs] } },
        { requestKey: 'cross-project', scope: { type: 'documents', docIds: [largeDocs[0]] }, projectId: 'topic-b' },
      ]) {
        await assert.rejects(inLibrary(libraryA, () => corpus.createCorpusResearch({ question: 'Synthetic question', maxRequests: 10, ...payload })))
      }
      assert.equal(database.queryOne('SELECT COUNT(*) count FROM task_jobs').count, beforeJobs, 'Reject invalid scope before creating work')
      for (const [owner, foreign] of [[libraryA, idB], [libraryB, idA]]) {
        inLibrary(owner, () => {
          for (const operation of [() => corpus.getCorpusResearch(foreign), () => corpus.listCorpusResearchDocuments(foreign),
            () => corpus.listCorpusResearchFindings(foreign), () => corpus.startCorpusResearch(foreign), () => corpus.pauseCorpusResearch(foreign)]) assert.throws(operation)
          assert(!corpus.listCorpusResearch().some((job) => job.id === foreign))
        })
      }
      assert(inLibrary(libraryA, () => corpus.listCorpusResearch('topic-a')).some((job) => job.id === idA))
      assert.deepEqual(inLibrary(libraryA, () => corpus.listCorpusResearch('topic-b')), [])
      assert.equal(state.calls.length, before)
    })

    await test('truncated unit resumes saved subparts after budget pause without losing quote offsets', async () => {
      const quotes = ['PART_A: the author did not confirm attribution.', 'PART_B: the author reported uncertainty.']
      const parts = quotes.map((quote) => {
        const prefix = `\u{20000} ${quote} `
        return prefix + 'x'.repeat(4000 - Buffer.byteLength(prefix, 'utf8'))
      })
      const text = parts.join('')
      const id = await create(seedDocuments('truncation-parts', 1, libraryA, { text }), { maxRequests: 2 })
      assert.equal(status(id).totalUnits, 1, 'One original unit, not separate scheduler units')
      state.behaviors.set(id, (call) => {
        if (call.type !== 'corpus.unit') return
        if (call.prompt.endsWith(text)) throw new LlmRequestError('Synthetic truncated extraction', false, 'truncated')
        const index = parts.findIndex((part) => call.prompt.endsWith(part))
        checkContract(() => assert(index >= 0, 'Recovery must send an intact half of the original unit'))
        return JSON.stringify({ reviewed: true, findings: [{ claim: 'The source qualifies its attribution.',
          quote: quotes[index], stance: 'challenge', dimension: 'attribution', uncertainty: 'Synthetic account.' }] })
      })
      let value = await execute(id)
      assert.equal(value.status, 'paused')
      assert.equal(value.phase, 'budget')
      assert.equal(value.requests, 2, 'Charge both the truncated parent and the successful first part')
      assert.equal(value.totalUnits, 1)
      assert.equal(value.completedUnits, 0, 'Partial extraction cannot complete the original unit')
      assert.equal(value.pendingUnits, 1)
      assert.equal(value.failedUnits, 0)
      assert.equal(value.findings, 0)
      assert.equal(value.report, '')
      assert.equal(calls(id, 'corpus.report').length, 0)
      const splitTree = artifacts(id, 'corpus.split')
      const savedParts = artifacts(id, 'corpus.extraction')
      assert.equal(splitTree.length, 1)
      assert.equal(savedParts.length, 1)
      assert.equal(JSON.parse(JSON.parse(savedParts[0].metadata_json).raw).findings[0].quote, quotes[0])
      const successfulPrompt = calls(id, 'corpus.unit').find((call) => call.success).prompt
      value = await execute(id, { additionalRequests: 2 })
      assert.equal(value.status, 'completed', value.error)
      assert.equal(value.totalUnits, 1)
      assert.equal(value.completedUnits, 1)
      assert.equal(value.pendingUnits, 0)
      assert.equal(value.failedUnits, 0)
      assert.equal(value.requests, 4)
      assert.equal(value.maxRequests, 4)
      const sent = calls(id, 'corpus.unit')
      assert.equal(sent.length, 3, 'Send the parent and each subpart exactly once')
      assert.equal(sent.filter((call) => call.prompt.endsWith(text)).length, 1)
      assert.equal(sent.filter((call) => call.prompt === successfulPrompt).length, 1)
      assert.equal(new Set(sent.map((call) => call.itemId)).size, 1)
      assert.deepEqual(artifacts(id, 'corpus.split'), splitTree)
      assert.deepEqual(artifacts(id, 'corpus.extraction').find((row) => row.id === savedParts[0].id), savedParts[0])
      const findings = artifacts(id, 'corpus.finding').map((row) => JSON.parse(row.metadata_json))
      assert.deepEqual(findings.map((finding) => finding.quote), quotes)
      for (const finding of findings) {
        assert.equal(finding.start, text.indexOf(finding.quote), 'Persist page-relative UTF-16 offsets, not subpart offsets')
        assert.equal(text.slice(finding.start, finding.end), finding.quote)
        assertEvidence(finding)
      }
      assertReportSources(id)
    })

    await test('rejected resume with additionalRequests leaves budget and scheduler state unchanged', async () => {
      const id = await create(seedDocuments('rejected-resume', 1), { maxRequests: 10 })
      state.behaviors.set(id, () => { throw new LlmRequestError('Synthetic resume rejection fixture', false) })
      assert.equal((await execute(id)).status, 'error')
      const jobBefore = database.queryOne('SELECT * FROM task_jobs WHERE id = ?', [id])
      const itemsBefore = database.queryAll('SELECT * FROM task_items WHERE job_id = ? ORDER BY ordinal', [id])
      const eventsBefore = database.queryAll('SELECT * FROM task_events WHERE job_id = ? ORDER BY id', [id])
      const invocationsBefore = state.invocations
      assert.throws(() => start(id, { additionalRequests: 20 }))
      await corpus.waitForCorpusResearch(id)
      assert.equal(status(id).maxRequests, 10, 'A rejected resume must not grant additional budget')
      assert.equal(status(id).active, false)
      assert.equal(state.invocations, invocationsBefore)
      assert.deepEqual(database.queryOne('SELECT * FROM task_jobs WHERE id = ?', [id]), jobBefore)
      assert.deepEqual(database.queryAll('SELECT * FROM task_items WHERE job_id = ? ORDER BY ordinal', [id]), itemsBefore)
      assert.deepEqual(database.queryAll('SELECT * FROM task_events WHERE job_id = ? ORDER BY id', [id]), eventsBefore)
      assertAccounting(id)
    })

    await test('final asynchronous validation rejects late page writes but permits read-only access', async () => {
      const SQLite = require('better-sqlite3')
      for (const mode of ['readonly', 'local', 'external']) {
        const docs = seedDocuments(`final-race-${mode}`, 2)
        const id = await create(docs)
        const pageId = `page-${docs[0]}`
        const observer = new SQLite(database.getDatabaseFilePath(), { readonly: true, fileMustExist: true })
        const writer = mode === 'external' ? new SQLite(database.getDatabaseFilePath(), { fileMustExist: true }) : null
        const originalImmediate = globalThis.setImmediate
        let injected = false
        let injectionError
        let preserved
        let requestCount
        let originalText
        try {
          // Only hook validateSnapshot's yield after the first page was checked and
          // summaries were saved. Earlier extraction/pre-summary validation stays untouched.
          globalThis.setImmediate = (callback, ...args) => {
            const finalValidation = !injected && new Error().stack.includes('validateSnapshot')
              && artifacts(id, 'corpus.summary.0').length > 0
            return originalImmediate((...callbackArgs) => {
              if (finalValidation && !injected) {
                injected = true
                try {
                  assert.equal(items(id, 'corpus.report')[0].status, 'running')
                  assert.equal(artifacts(id, 'corpus.report').length, 0)
                  preserved = [...artifacts(id, 'corpus.finding'), ...artifacts(id, 'corpus.summary.0')]
                  requestCount = calls(id).length
                  originalText = observer.prepare('SELECT ocr_text FROM pages WHERE id = ?').get(pageId).ocr_text
                  const localBefore = database.queryOne('SELECT total_changes() count').count
                  const externalBefore = database.queryOne('PRAGMA data_version').data_version
                  if (mode === 'external') writer.prepare('UPDATE pages SET ocr_text = ? WHERE id = ?').run(`${originalText}\nLate external change.`, pageId)
                  if (mode === 'local') database.run('UPDATE pages SET ocr_text = ? WHERE id = ?', [`${originalText}\nLate local change.`, pageId])
                  const localAfter = database.queryOne('SELECT total_changes() count').count
                  const externalAfter = database.queryOne('PRAGMA data_version').data_version
                  if (mode === 'local') assert(localAfter > localBefore)
                  else assert.equal(localAfter, localBefore, 'External writes and reads do not change local total_changes')
                  if (mode === 'external') assert.notEqual(externalAfter, externalBefore, 'Observe the other connection through data_version')
                  else assert.equal(externalAfter, externalBefore)
                } catch (error) { injectionError = error }
              }
              callback(...callbackArgs)
            }, ...args)
          }
          const value = await execute(id)
          assert.equal(injected, true, `Must reach the final validation race window: ${mode}`)
          if (injectionError) throw injectionError
          assert.equal(calls(id).length, requestCount, 'Final revalidation must not call the model again')
          assert.equal(value.completedUnits, 2)
          assert.equal(value.failedUnits, 0)
          for (const row of preserved) assert.deepEqual(artifacts(id, row.kind).find((item) => item.id === row.id), row)
          const persistedJob = observer.prepare('SELECT status FROM task_jobs WHERE id = ?').get(id)
          const reportCount = observer.prepare("SELECT COUNT(*) count FROM task_artifacts WHERE job_id = ? AND kind = 'corpus.report'").get(id).count
          const pageText = observer.prepare('SELECT ocr_text FROM pages WHERE id = ?').get(pageId).ocr_text
          const firstFinding = inLibrary(libraryA, () => corpus.listCorpusResearchFindings(id, { docId: docs[0] })).items[0]
          if (mode === 'readonly') {
            assert.equal(value.status, 'completed', value.error)
            assert.equal(persistedJob.status, 'completed')
            assert.equal(reportCount, 1)
            assert.equal(pageText, originalText)
            assert.equal(firstFinding.sourceStatus, 'current')
            assertReportSources(id)
          } else {
            assert.notEqual(pageText, originalText, 'The late page edit must be visible to a separate read-only connection')
            assert.notEqual(value.status, 'completed', 'Never commit full-coverage success for stale pages')
            assert.notEqual(persistedJob.status, 'completed')
            assert.equal(reportCount, 0, 'No stale final report artifact may be committed')
            assert.equal(value.report, '')
            assert.deepEqual(value.reportSources, [])
            assert.equal(items(id, 'corpus.report')[0].status, 'error')
            assert.equal(firstFinding.sourceStatus, 'stale')
          }
        } finally {
          globalThis.setImmediate = originalImmediate
          await corpus.waitForCorpusResearch(id)
          writer?.close()
          observer.close()
        }
      }
    })

    await test('entity extraction, provenance, optimistic reviews, undo, source edits and scope isolation', async () => {
      const quote = '甲某，字乙某。'
      const docs = seedDocuments('entity-sources', 2, libraryA, { text: quote })
      const id = await create(docs)
      state.behaviors.set(id, (call) => call.type === 'corpus.unit' ? JSON.stringify({ reviewed: true, findings: [{
        claim: 'A naming assertion', quote, stance: 'context', dimension: 'names', uncertainty: '',
        entities: call.input.docId === docs[1] ? [{ name: '乙某', kind: 'person', aliases: [] }] : [{ name: '甲某', kind: 'person', aliases: [{ name: '乙某', quote }] }],
      }] }) : undefined)
      assert.equal((await execute(id)).status, 'completed')
      const list = (options) => inLibrary(libraryA, () => entities.listCorpusEntities(id, options))
      const review = (payload) => inLibrary(libraryA, () => entities.reviewCorpusEntities(id, payload))
      let page = list()
      assert.equal(page.total, 2)
      assert.equal(page.items[0].candidateCount, 1)
      assert.deepEqual(page.items.find((item) => item.name === '甲某').aliases, ['乙某'])
      assert.equal(page.items[0].source.sourceStatus, 'current')
      const ids = page.items.map((item) => item.id)
      assert.equal(list({ candidateOfId: page.items.find((item) => item.name === '甲某').id }).total, 2, 'Alias candidate lookup includes different primary names')
      assert.equal(list({ offset: 1, limit: 1 }).items.length, 1)
      assert.throws(() => list({ candidateOfId: 'missing-mention' }), /实体已变化/)
      assert.throws(() => review({ revision: page.revision, action: 'merge', mentionIds: ids, reason: '' }), /核对依据/)
      assert.throws(() => review({ revision: page.revision, action: 'merge', mentionIds: [ids[0], 'foreign-id'], reason: 'invalid' }), /不存在/)
      const requestCount = state.calls.length
      const initialRevision = page.revision
      review({ revision: page.revision, action: 'merge', mentionIds: ids, reason: 'Synthetic identity check' })
      assert.throws(() => review({ revision: initialRevision, action: 'split', mentionIds: [ids[0]], reason: 'stale write' }), /已更新/)
      page = list()
      assert.equal(page.items[0].groupId, page.items[1].groupId)
      assert.equal(list({ search: '乙某' }).total, 2)
      assert.equal(list({ candidatesOnly: true }).total, 0)
      review({ revision: page.revision, action: 'split', mentionIds: [ids[0]], reason: 'Different dates' })
      page = list()
      assert.notEqual(page.items[0].groupId, page.items[1].groupId)
      review({ revision: page.revision, action: 'undo', mentionIds: [], reason: 'Undo split' })
      page = list()
      assert.equal(page.items[0].groupId, page.items[1].groupId)
      review({ revision: page.revision, action: 'undo', mentionIds: [], reason: 'Undo merge' })
      assert.equal(list().canUndo, false)
      assert.equal(state.calls.length, requestCount, 'Entity review must not call a model')
      database.closeDatabase(); await database.initDatabase()
      assert.equal(list().total, 2)
      assert.equal(list().canUndo, false, 'Review and undo history survive reopening')
      assert.throws(() => inLibrary(libraryB, () => entities.listCorpusEntities(id)), /不属于/)
      assert.throws(() => inLibrary(libraryB, () => entities.reviewCorpusEntities(id, { revision: 0, action: 'undo', mentionIds: [], reason: 'foreign' })), /不属于/)
      assert.throws(() => list({ limit: 101 }), /分页/)
      database.run('UPDATE pages SET ocr_text = ? WHERE doc_id = ?', ['Edited source', docs[0]])
      page = list()
      assert(page.items.some((item) => item.source.sourceStatus === 'stale'))
      assert.throws(() => review({ revision: page.revision, action: 'merge', mentionIds: ids, reason: 'stale source' }), /原文/)
      assert.equal(list().revision, page.revision)
    })
    await test('missing entity schema is not silently treated as successful new extraction', async () => {
      const id = await create(seedDocuments('entity-schema-missing', 1))
      state.behaviors.set(id, (call) => {
        if (call.type !== 'corpus.unit') return undefined
        call.omitEntities = true
        return JSON.stringify({ reviewed: true, findings: [{ claim: 'Synthetic', quote: call.input.text, stance: 'context', dimension: 'schema', uncertainty: '' }] })
      })
      const result = await execute(id)
      assert.equal(result.failedUnits, 1)
      assert.equal(result.findings, 0)
      assert(items(id)[0].error_json.includes('实体字段'))
    })
    await test('legacy jobs resume their old extraction schema; new jobs never reuse old-schema cache', async () => {
      const docs = seedDocuments('legacy-entity-schema', 1)
      const legacy = await create(docs)
      database.run("UPDATE task_jobs SET settings_snapshot_json = json_remove(settings_snapshot_json, '$.entitySchema') WHERE id = ?", [legacy])
      state.behaviors.set(legacy, (call) => {
        if (call.type !== 'corpus.unit') return undefined
        assert(!call.prompt.includes('每项 finding 必须另有 entities'))
        call.omitEntities = true
        return JSON.stringify({ reviewed: true, findings: [{ claim: 'Legacy claim', quote: call.input.text, stance: 'context', dimension: 'legacy', uncertainty: '' }] })
      })
      assert.equal((await execute(legacy)).status, 'completed')
      assert.equal(inLibrary(libraryA, () => entities.listCorpusEntities(legacy)).unprocessedFindings, 1)
      const upgraded = await create(docs, { reuseCompleted: true })
      assert.equal((await execute(upgraded)).status, 'completed')
      assert.equal(calls(upgraded, 'corpus.unit').length, 1, 'New schema requires a new extraction, not an old cached response')
      assert.equal(inLibrary(libraryA, () => entities.listCorpusEntities(upgraded)).unprocessedFindings, 0)
    })
    assert.equal(state.blockedNetwork, 0)
    assert.deepEqual(state.contractErrors, [], 'AI callback/budget contract assertions must not be swallowed as job errors')
    if (failures.length) throw new AggregateError(failures.map(({ name, error }) => new Error(`${name}: ${error.message}`, { cause: error })), `${failures.length} corpus integration regression(s) failed`)
    console.log(`Corpus research Electron/SQLite integration passed: ${jobs.size} jobs, ${state.calls.length} simulated charged requests, no network.`)
  } finally {
    // Drain even failed test cases before closing their database.
    if (corpus) for (const id of jobs.keys()) await corpus.waitForCorpusResearch(id)
    database?.closeDatabase()
    globalThis.fetch = originalFetch
    const target = path.resolve(tempRoot)
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
    assert(path.basename(target).startsWith('gujismart-corpus-integration-'))
    fs.rmSync(target, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
