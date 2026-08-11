const assert = require('assert')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { Worker } = require('worker_threads')
const { buildSync } = require('esbuild')

const root = join(__dirname, '..')
const tempRoot = mkdtempSync(join(__dirname, '.tmp-search-export-worker-'))
const tempDataDir = join(tempRoot, 'data')
const moduleEntryPath = join(tempRoot, 'modules-entry.js')
const moduleBundlePath = join(tempRoot, 'modules.cjs')
const workerBundlePath = join(tempRoot, 'search-export-query-worker.cjs')

process.env.GUJISMART_DATA_DIR = tempDataDir
process.env.GUJISMART_AUTO_REINDEX = '0'

writeFileSync(moduleEntryPath, `
  const database = require(${JSON.stringify(join(root, 'src', 'main', 'database.ts'))})
  const search = require(${JSON.stringify(join(root, 'src', 'main', 'semantic-search.ts'))})
  const projects = require(${JSON.stringify(join(root, 'src', 'main', 'library-projects.ts'))})
  module.exports = { database, search, projects }
`)

const buildOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['better-sqlite3', 'flexsearch', '@napi-rs/canvas'],
  logLevel: 'silent',
}

const mainModuleBuildOptions = {
  ...buildOptions,
  alias: {
    electron: join(__dirname, 'stubs', 'electron.js'),
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
}

const workerBuildOptions = {
  ...buildOptions,
  alias: {
    electron: join(__dirname, 'stubs', 'electron-worker.js'),
  },
}

buildSync({ ...mainModuleBuildOptions, entryPoints: [moduleEntryPath], outfile: moduleBundlePath })
buildSync({
  ...workerBuildOptions,
  entryPoints: [join(root, 'src', 'main', 'search-export-query-worker.ts')],
  outfile: workerBundlePath,
})

async function runWorker(task) {
  const worker = new Worker(workerBundlePath)
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('search export worker timed out')), 20_000)
      const progressMessages = []
      worker.on('message', (message) => {
        if (message?.type === 'progress') {
          progressMessages.push(message)
        } else if (message?.type === 'result') {
          clearTimeout(timeout)
          resolve({ response: message.result, progressMessages })
        } else if (message?.type === 'error') {
          clearTimeout(timeout)
          reject(new Error(message.error || 'search export worker failed'))
        }
      })
      worker.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      worker.postMessage({ type: 'query', task })
    })
  } finally {
    await worker.terminate()
  }
}

async function main() {
  let database
  try {
    const modules = require(moduleBundlePath)
    database = modules.database
    const search = modules.search
    const projects = modules.projects
    await database.initDatabase()

    const projectId = projects.getActiveLibraryProjectId()
    const now = new Date().toISOString()
    const fixtureDocumentId = 'doc-fixture'
    const fixturePageId = 'page-fixture'
    const hitCount = 500
    const pageText = '甲渡。'.repeat(hitCount)
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fixtureDocumentId, 'Worker export fixture', null, null, null, 'test', null, null, 1, 'completed', 'pending', 'processed', 'pending', '{}', now, now],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [fixturePageId, fixtureDocumentId, 1, null, pageText, null, 'completed', 'pending', now],
    )
    projects.ensureDocumentLibraryProjectMembership(fixtureDocumentId, projectId)
    search.reindexDocument(fixtureDocumentId)

    let eventLoopTicks = 0
    const ticker = setInterval(() => { eventLoopTicks += 1 }, 1)
    const { response, progressMessages } = await runWorker({
      databasePath: database.getDatabaseFilePath(),
      dataDir: tempDataDir,
      projectId,
      keyword: '渡',
      options: {
        docIds: [fixtureDocumentId],
        limit: 10_000,
        exhaustive: true,
        resultMode: 'all',
        autoReindex: false,
      },
    })
    clearInterval(ticker)

    assert.ok(eventLoopTicks > 0, 'main event loop must stay responsive while the export query runs')
    assert.ok(progressMessages.length >= 2, 'worker must report preparation progress before returning results')
    assert.ok(progressMessages.some((item) => item.progress?.stage === 'searching'), 'worker must report the long-running search stage')
    assert.strictEqual(response.totalDocuments, 1)
    assert.strictEqual(response.totalHits, hitCount)
    assert.strictEqual(response.groups[0]?.hits.length, hitCount)
    console.log('Search export worker regression checks passed.')
  } finally {
    try { database?.closeDatabase() } catch { /* best effort */ }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
