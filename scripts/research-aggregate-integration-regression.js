const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-research-aggregate-'))
const bundlePath = path.join(tempRoot, 'research-aggregate.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')
process.env.GUJISMART_DATA_DIR = path.join(tempRoot, 'data')
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `exports.app={getPath:()=>${JSON.stringify(tempRoot)},getAppPath:()=>${JSON.stringify(root)},getName:()=>'GujiSmart',isPackaged:false}`)
fs.writeFileSync(entryPath, `
  const database=require(${JSON.stringify(path.join(root, 'src/main/database.ts'))})
  const snapshots=require(${JSON.stringify(path.join(root, 'src/main/search-snapshots.ts'))})
  const aggregates=require(${JSON.stringify(path.join(root, 'src/main/research-aggregates.ts'))})
  module.exports={database,snapshots,aggregates}
`)

async function run() {
  let database
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
      external: ['better-sqlite3'], alias: { electron: electronStubPath, '@electron-toolkit/utils': path.join(root, 'scripts/stubs/electron-toolkit-utils.js') }, logLevel: 'silent' })
    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    const searchSource = fs.readFileSync(path.join(root, 'src/main/semantic-search.ts'), 'utf8')
    const searchIpcSource = fs.readFileSync(path.join(root, 'src/main/ipc/search.ts'), 'utf8')
    const preloadSource = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
    assert.match(searchSource, /recordSearchSnapshotAggregate\(/)
    assert.match(searchIpcSource, /search:promoteAggregate/)
    assert.match(preloadSource, /promoteSearchAggregate/)
    database.run("INSERT INTO research_projects (id,name,status,created_at,updated_at) VALUES ('project-1','P','active','2026-01-01','2026-01-01')")
    const snapshot = modules.snapshots.createSearchSnapshot({ criteriaKey: '{"q":"beta"}' })
    modules.snapshots.recordSearchSnapshotAggregate(snapshot.snapshotId, {
      query: 'beta', totalDocuments: 3, totalHits: 8, status: 'complete', warnings: [], exactness: 'exact',
      coverage: { returnedDocuments: 3, returnedHits: 8, totalsExact: true },
    })
    const promoted = modules.aggregates.promoteSearchSnapshotAggregate({ snapshotId: snapshot.snapshotId, projectId: 'project-1', label: 'Beta totals' })
    assert.match(promoted.artifact.result_hash, /^[a-f0-9]{64}$/)
    assert.strictEqual(promoted.artifact.exactness, 'exact')
    assert.strictEqual(JSON.parse(promoted.artifact.result_json).totalHits, 8)
    const same = modules.aggregates.promoteSearchSnapshotAggregate({ snapshotId: snapshot.snapshotId, projectId: 'project-1', label: 'Updated label' })
    assert.strictEqual(same.artifact.id, promoted.artifact.id)
    assert.strictEqual(same.relation.label, 'Updated label')
    for (let index = 0; index < 204; index += 1) {
      modules.aggregates.promoteSearchSnapshotAggregate({ snapshotId: snapshot.snapshotId, projectId: 'project-1', relationKind: `kind-${index}` })
    }
    const page1 = modules.aggregates.listResearchAggregateRelations('project-1', { limit: 200 })
    const page2 = modules.aggregates.listResearchAggregateRelations('project-1', { limit: 200, cursor: page1.nextCursor })
    assert.strictEqual(page1.items.length, 200)
    assert.strictEqual(page2.items.length, 5)
    assert.strictEqual(page2.nextCursor, null)
    assert.throws(() => modules.aggregates.listResearchAggregateRelations('project-1', { limit: 201 }), /research_aggregate_limit_invalid/)
    assert.strictEqual(modules.aggregates.validateResearchAggregateArtifact(promoted.artifact.id).validation, 'verified')

    const incomplete = modules.snapshots.createSearchSnapshot({ criteriaKey: 'incomplete' })
    modules.snapshots.recordSearchSnapshotAggregate(incomplete.snapshotId, {
      query: 'x', totalDocuments: 1, totalHits: 1, status: 'scanning', warnings: [], exactness: 'bounded-preview',
      coverage: { returnedDocuments: 1, returnedHits: 1, totalsExact: false },
    })
    assert.throws(() => modules.aggregates.promoteSearchSnapshotAggregate({ snapshotId: incomplete.snapshotId, projectId: 'project-1' }), /research_aggregate_incomplete/)

    const stale = modules.snapshots.createSearchSnapshot({ criteriaKey: 'stale' })
    modules.snapshots.recordSearchSnapshotAggregate(stale.snapshotId, {
      query: 'x', totalDocuments: 0, totalHits: 0, status: 'complete', warnings: [], exactness: 'exact',
      coverage: { returnedDocuments: 0, returnedHits: 0, totalsExact: true },
    })
    database.run("INSERT INTO documents (id,title,import_status,created_at,updated_at) VALUES ('doc-change','Changed','stored','2026-01-01','2026-01-01')")
    assert.throws(() => modules.aggregates.promoteSearchSnapshotAggregate({ snapshotId: stale.snapshotId, projectId: 'project-1' }), /research_aggregate_snapshot_stale/)
    assert.strictEqual(modules.aggregates.validateResearchAggregateArtifact(promoted.artifact.id).validation, 'stale-generation')

    database.run('UPDATE research_aggregate_artifacts SET result_json = ? WHERE id = ?', ['{}', promoted.artifact.id])
    assert.strictEqual(modules.aggregates.validateResearchAggregateArtifact(promoted.artifact.id).validation, 'corrupt')
    database.closeDatabase()
    await database.initDatabase()
    assert.ok(database.queryOne('SELECT id FROM research_aggregate_artifacts WHERE id = ?', [promoted.artifact.id]))
    database.closeDatabase()
    database = null
    console.log('Research aggregate artifact integration regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
