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

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const search = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'semantic-search.ts'))})
  const evidenceQa = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'evidence-qa.ts'))})
  module.exports = { database, search, evidenceQa }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3', 'flexsearch'],
  alias: {
    electron: join(__dirname, 'stubs', 'electron.js'),
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

function createMockLlmServer() {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
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
    assert.ok(docAnswer.sources.some((source) => source.doc_id === 'doc_ai_a' && source.page_num === 5))
    const cluster = docAnswer.evidenceClusters.find((item) => item.doc_id === 'doc_ai_a' && item.anchor_page_num === 5)
    assert.ok(cluster, 'Expected page 5 evidence cluster')
    assert.ok(cluster.pages.some((page) => page.page_num === 4), 'Expected previous page expansion')
    assert.ok(cluster.pages.some((page) => page.page_num === 6), 'Expected next page expansion')
    assert.ok(!mock.requests.some((content) => content.includes('第一页普通背景') && content.includes('第七页无关内容')), 'Expected prompt not to include whole book')

    const scopedAnswer = await evidenceQa.askWithEvidence('核心证据词在哪里？', { type: 'tags', tagIds: ['tag_ai'] }, { limit: 8 })
    assert.ok(scopedAnswer.sources.length > 0)
    assert.ok(scopedAnswer.sources.every((source) => source.doc_id === 'doc_ai_a'), 'Expected tag scope not to leak other docs')

    const emptyAnswer = await evidenceQa.askDocumentWithEvidence('doc_ai_a', '完全不存在的火星术语', { limit: 8 })
    assert.ok(emptyAnswer.answer.includes('证据不足'))
    assert.strictEqual(emptyAnswer.sources.length, 0)

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
