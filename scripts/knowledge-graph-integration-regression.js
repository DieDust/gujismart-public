const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { buildSync } = require('esbuild')
process.on('uncaughtException', (error) => { console.error(error); process.exit(1) })
process.on('unhandledRejection', (error) => { console.error(error); process.exit(1) })
const root = join(__dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'gujismart-knowledge-integration-'))
process.env.GUJISMART_DATA_DIR = join(temp, 'data')
process.env.GUJISMART_HEADLESS = '1'
const built = buildSync({
  stdin: {
    contents: `module.exports = {
      db: require('./src/main/database.ts'),
      projects: require('./src/main/library-projects.ts'),
      graph: require('./src/main/knowledge-graph.ts'),
      tools: require('./src/main/mcp/library-tools.ts')
    }`, resolveDir: root,
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'silent',
  alias: { electron: join(__dirname, 'stubs/electron-app-shim.js'), '@electron-toolkit/utils': join(__dirname, 'stubs/electron-toolkit-utils.js') },
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', '__dirname', '__filename', built.outputFiles[0].text)(require, mod, mod.exports, temp, __filename)
const { db, projects, graph, tools } = mod.exports

async function run() {
  try {
    await db.initDatabase()
    const projectId = projects.getActiveLibraryProjectId()
    db.run("INSERT INTO library_projects (id, name, created_at, updated_at) VALUES ('foreign-project', 'Other', '', '')")
    for (const [suffix, libraryProjectId] of [['a', projectId], ['b', projectId], ['foreign', 'foreign-project']]) {
      db.run('INSERT INTO documents (id, title, library_project_id) VALUES (?, ?, ?)', [`doc-${suffix}`, `Document ${suffix}`, libraryProjectId])
      db.run('INSERT INTO ai_research_tasks (id, title, goal, library_project_id) VALUES (?, ?, ?, ?)', [`task-${suffix}`, 'Fixture', 'Fixture', libraryProjectId])
      db.run('INSERT INTO ai_research_datasets (id, task_id, name, library_project_id, field_schema_json) VALUES (?, ?, ?, ?, ?)', [
        `dataset-${suffix}`, `task-${suffix}`, 'Fixture', libraryProjectId,
        JSON.stringify([{ key: 'person', type: 'person' }, { key: 'event', type: 'text' }]),
      ])
      for (let i = 0; i < 140; i += 1) db.run(
        'INSERT INTO ai_research_records (id, task_id, dataset_id, doc_id, library_project_id, excerpt, values_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [`record-${suffix}-${i}`, `task-${suffix}`, `dataset-${suffix}`, `doc-${suffix}`, libraryProjectId, 'Fixture evidence', JSON.stringify({ person: `Person ${i}`, event: 'Meeting' })],
      )
    }
    assert.equal(graph.listKnowledgeGraphSources().length, 2)
    const data = await graph.getKnowledgeGraphData({ datasetIds: ['dataset-a', 'dataset-b'], limit: 200 })
    assert.equal(data.records.length, 200)
    assert.equal(data.totalRecords, 280)
    assert.equal(data.truncated, true)
    assert.equal(new Set(data.records.map((record) => record.dataset_id)).size, 2)
    assert.equal((await graph.getKnowledgeGraphData({ datasetIds: [] })).records.length, 0)
    await assert.rejects(graph.getKnowledgeGraphData({ datasetIds: ['dataset-foreign'] }), /active library project/)
    await assert.rejects(graph.getKnowledgeGraphData({ datasetIds: ['dataset-a'], limit: 5000 }), /limit/)
    assert.equal(graph.getKnowledgeGraphEvidence(['record-a-0', 'record-foreign-0']).length, 1)
    const query = await tools.callLibraryTool('knowledge_graph_query', { datasetIds: ['dataset-a'], kind: 'event' })
    assert.equal(query.ok, true)
    assert(query.nodes.length && query.edges.length)
    assert(query.edges.every((edge) => edge.kind === 'event'))
    const evidence = await tools.callLibraryTool('knowledge_graph_evidence', { recordIds: ['record-a-0', 'record-foreign-0'] })
    assert.equal(evidence.records.length, 1)
    assert.equal(evidence.records[0].ref.docId, 'doc-a')
    console.log('Knowledge graph SQLite/MCP isolation, paging, evidence and query regression passed.')
  } finally { db.closeDatabase() }
}
run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
