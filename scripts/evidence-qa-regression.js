const assert = require('assert')
const { app } = require('electron')
const { createServer } = require('http')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-evidence-qa-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'evidence-qa-regression-bundle.cjs')
const entryPath = join(tempRoot, 'evidence-qa-regression-entry.js')

process.env.GUJISMART_DATA_DIR = tempDataDir
process.env.GUJISMART_PROFILE_DIR = join(tempRoot, 'profile')

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const search = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'semantic-search.ts'))})
  const evidenceQa = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'evidence-qa.ts'))})
  const embedding = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'embedding-index.ts'))})
  const selection = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'evidence-selection.ts'))})
  module.exports = { database, search, evidenceQa, embedding, selection }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3', 'flexsearch', '@napi-rs/canvas'],
  alias: {
    electron: join(__dirname, 'stubs', 'electron.js'),
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

function createMockLlmServer() {
  const requests = []
  const embeddingRequests = []
  let failEmbeddings = false
  let hangEmbeddings = false
  const server = createServer(async (req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      if (req.url.endsWith('/embeddings')) {
        embeddingRequests.push(parsed.input)
        if (hangEmbeddings) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.flushHeaders()
          return
        }
        res.writeHead(failEmbeddings ? 503 : 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(failEmbeddings ? { error: 'fixture unavailable' } : { data: [{ index: 0, embedding: [1, 0] }] }))
        return
      }
      const content = parsed.messages?.map((item) => item.content).join('\n') || ''
      requests.push(content)
      let answer = '证据不足。'
      if (content.includes('JSON 格式必须为')) {
        const missing = content.includes('完全不存在的火星术语')
        answer = JSON.stringify({
          intent: missing ? '查找不存在术语' : '查找制度证据',
          keywords: missing ? ['完全不存在的火星术语'] : ['核心证据词', '邻页线索'],
          expandedKeywords: missing ? [] : ['制度证据'],
          excludeKeywords: [],
          inferredFilters: {},
          notes: 'mock plan',
        })
      } else if (content.includes('核心证据词')) {
        answer = '核心证据词的说明见原文证据。（《证据问答测试书》，第 5 页）'
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        embeddingRequests,
        failEmbeddings: () => { failEmbeddings = true },
        hangEmbeddings: () => { hangEmbeddings = true },
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function insertDocument(database, id, title, pages, tagId) {
  const now = new Date().toISOString()
  database.run(
    `INSERT INTO documents (
      id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
      ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, null, null, null, 'test', null, null, pages.length, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
  )
  pages.forEach((text, index) => {
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [`${id}_page_${index + 1}`, id, index + 1, null, text, null, 'completed', 'pending', now],
    )
  })
  if (tagId) {
    database.run('INSERT OR IGNORE INTO tags (id, name, color, source, normalized_name) VALUES (?, ?, ?, ?, ?)', [tagId, tagId, '#999999', 'manual', tagId])
    database.run('INSERT OR IGNORE INTO document_tags (doc_id, tag_id) VALUES (?, ?)', [id, tagId])
  }
}

async function run() {
  let database
  let mock
  try {
    mock = await createMockLlmServer()
    const modules = require(bundlePath)
    database = modules.database
    const search = modules.search
    const evidenceQa = modules.evidenceQa

    await database.initDatabase()
    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['llm_api_key', 'test-key'])
    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['llm_base_url', mock.baseUrl])
    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['llm_model', 'mock-model'])
    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['llm_provider', 'Mock'])

    insertDocument(database, 'doc_ai_a', '证据问答测试书', [
      '第一页普通背景。',
      '第二页仍然没有答案。',
      '第三页写着前文铺垫。',
      '第四页说明邻页线索，为第五页提供上下文。',
      '第五页出现核心证据词，并说明制度证据的关键内容。',
      '第六页继续解释核心证据词之后的影响。',
      '第七页无关内容。',
    ], 'tag_ai')
    insertDocument(database, 'doc_ai_b', '范围外测试书', [
      '范围外文献也有核心证据词，但不应该在标签范围内返回。',
    ], 'tag_other')

    search.reindexDocument('doc_ai_a')
    search.reindexDocument('doc_ai_b')

    const docAnswer = await evidenceQa.askDocumentWithEvidence('doc_ai_a', '核心证据词说明了什么？', { limit: 8 })
    assert.ok(docAnswer.answer.includes('第 5 页'))
    const answerPrompt = mock.requests.find((content) => content.includes('严格证据型研究助手'))
    assert.ok(answerPrompt.includes('不等于整篇文献没有记载'), 'absence claims must stay bounded to retrieved evidence')
    assert.ok(answerPrompt.includes('优先遵守用户指定的篇幅和文体'), 'user format overrides the default outline')
    assert.ok(answerPrompt.includes('明确区分原文记载与据此提出的建议'), 'research recommendations must not masquerade as source facts')
    assert.ok(answerPrompt.includes('不能只列一串页码'), 'multi-document citations must identify their source')
    assert.ok(docAnswer.sources.some((source) => source.doc_id === 'doc_ai_a' && source.page_num === 5))
    const cluster = docAnswer.evidenceClusters.find((item) => item.doc_id === 'doc_ai_a' && item.anchor_page_num === 5)
    assert.ok(cluster, 'Expected page 5 evidence cluster')
    const suppliedPages = docAnswer.evidenceClusters.filter((item) => item.doc_id === 'doc_ai_a').flatMap((item) => item.pages)
    assert.ok(suppliedPages.some((page) => page.page_num === 4), 'Previous page must be supplied, including when it is itself a hit')
    assert.ok(suppliedPages.some((page) => page.page_num === 6), 'Next page must be supplied, including when it is itself a hit')
    assert.strictEqual(new Set(suppliedPages.map((page) => page.page_num)).size, suppliedPages.length, 'Do not attach the same document page twice')
    const planPrompt = mock.requests.find((content) => content.includes('JSON 格式必须为'))
    assert.ok(planPrompt.includes('证据问答测试书'), 'Planning must know the selected document titles')
    assert.ok(!planPrompt.includes('范围外测试书'), 'Planning must not disclose out-of-scope titles')
    assert.ok(planPrompt.includes('研究方法或偏见'), 'Planning must cover research aspects, not only proper nouns')
    assert.ok(!mock.requests.some((content) => content.includes('第一页普通背景') && content.includes('第七页无关内容')), 'Expected prompt not to include whole book')

    const scopedAnswer = await evidenceQa.askWithEvidence('核心证据词在哪里？', { type: 'tags', tagIds: ['tag_ai'] }, { limit: 8 })
    assert.ok(scopedAnswer.sources.length > 0)
    assert.ok(scopedAnswer.sources.every((source) => source.doc_id === 'doc_ai_a'), 'Expected tag scope not to leak other docs')

    const emptyAnswer = await evidenceQa.askDocumentWithEvidence('doc_ai_a', '完全不存在的火星术语', { limit: 8 })
    assert.ok(emptyAnswer.answer.includes('证据不足'))
    assert.strictEqual(emptyAnswer.sources.length, 0)

    assert.strictEqual(mock.embeddingRequests.length, 0, 'legacy documents without vectors must not request embeddings')
    insertDocument(database, 'doc_method', '地方教育研究（虚构）', ['背景介绍。', '研究采用深度访谈，核查不同群体的记忆。'], 'tag_method')
    search.reindexDocument('doc_method')
    const methodAnswer = await evidenceQa.askDocumentWithEvidence('doc_method', '研究方法是什么？')
    assert.ok(methodAnswer.sources.some((source) => source.page_num === 2 && source.snippet.includes('深度访谈')), 'local aspect retrieval must recover methods omitted by the model query plan')
    for (const [key, value] of Object.entries({ embedding_base_url: mock.baseUrl, embedding_model: 'mock-embedding', embedding_use_llm_credentials: 'true' })) {
      database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
    }
    database.run('INSERT OR REPLACE INTO embedding_index_meta (key, value) VALUES (?, ?)', ['dim', '2'])
    insertDocument(database, 'doc_semantic', '异词同义材料（虚构）', ['这里用不同措辞说明学术交往，不含规划检索词。'], 'tag_ai')
    search.reindexDocument('doc_semantic')
    const vector = Buffer.alloc(8)
    vector.writeFloatLE(1, 0)
    for (const id of ['doc_semantic', 'doc_ai_b']) {
      const segment = database.queryOne('SELECT * FROM search_index_segments WHERE doc_id = ? LIMIT 1', [id])
      database.run('INSERT INTO embedding_chunks (segment_id, doc_id, page_id, page_num, model_id, dim, content_hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [segment.segment_id, id, segment.page_id, segment.page_num, 'mock-embedding@2', 2, segment.text_hash, vector])
    }
    const noVectors = await modules.embedding.vectorSearch('空范围测试', { docIds: [] })
    assert.strictEqual(noVectors.ok, false)
    await modules.embedding.vectorSearch('所选文献尚未向量化', { docIds: ['doc_ai_a'] })
    assert.strictEqual(mock.embeddingRequests.length, 0, 'vectors outside the selected scope must not trigger a paid query')

    const hybrid = await evidenceQa.askWithEvidence('核心证据词说明了什么？', { type: 'tags', tagIds: ['tag_ai'] })
    assert.strictEqual(mock.embeddingRequests.length, 1, 'use one query embedding, not one per document or keyword')
    assert.ok(hybrid.sources.some((source) => source.doc_id === 'doc_semantic'), 'semantic-only evidence must join the keyword evidence')
    assert.ok(hybrid.sources.some((source) => source.doc_id === 'doc_ai_a'), 'unvectorized documents must remain in keyword results')
    assert.ok(hybrid.sources.every((source) => source.doc_id !== 'doc_ai_b'), 'hybrid retrieval must enforce the selected tag scope')
    assert.ok(hybrid.sources.length <= modules.selection.EVIDENCE_SOURCE_LIMIT)
    const evidenceText = hybrid.evidenceClusters.map(modules.selection.renderEvidenceCluster).join('\n\n---\n\n')
    assert.ok(Buffer.byteLength(evidenceText, 'utf8') <= modules.selection.EVIDENCE_CONTEXT_BYTES)
    assert.ok(mock.requests.at(-1).includes(evidenceText), 'visible sources must come from exactly the evidence delivered to the model')

    mock.failEmbeddings()
    const fallback = await evidenceQa.askWithEvidence('核心证据词说明了什么？', { type: 'tags', tagIds: ['tag_ai'] })
    assert.ok(fallback.sources.some((source) => source.doc_id === 'doc_ai_a'))
    assert.ok(fallback.warnings.some((warning) => warning.includes('向量检索暂不可用')))
    assert.ok(fallback.answer.includes('第 5 页'), 'embedding failures must not block available keyword answers')
    mock.hangEmbeddings()
    const hangStart = Date.now()
    const timedOut = await modules.embedding.vectorSearch('响应正文超时测试', { docIds: ['doc_semantic'], timeoutMs: 1000 })
    assert.strictEqual(timedOut.ok, false)
    assert.ok(timedOut.message.includes('超时'))
    assert.ok(Date.now() - hangStart < 10000, 'timeout must also abort a response body stalled after HTTP headers')

    console.log('Evidence QA regression test passed.')
    app.quit()
    process.exit(0)
  } finally {
    try {
      database?.closeDatabase?.()
    } catch {}
    try {
      await mock?.close?.()
    } catch {}
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error('Evidence QA regression test failed.')
  console.error(error)
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {}
  app.quit()
  process.exit(1)
})
