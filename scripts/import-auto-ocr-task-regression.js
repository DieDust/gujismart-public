const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-import-auto-ocr-'))
const dataDir = path.join(tempRoot, 'data')
const bundlePath = path.join(tempRoot, 'import-auto-ocr.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')

process.env.GUJISMART_DATA_DIR = dataDir
process.env.GUJISMART_AUTO_REINDEX = '0'
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `
  exports.app = {
    getPath: () => ${JSON.stringify(tempRoot)},
    getAppPath: () => ${JSON.stringify(root)},
    getName: () => 'GujiSmart',
    isPackaged: false,
  }
`)

fs.writeFileSync(entryPath, `
  const database = require(${JSON.stringify(path.join(root, 'src', 'main', 'database.ts'))})
  const importAutoOcr = require(${JSON.stringify(path.join(root, 'src', 'main', 'import-auto-ocr-task.ts'))})
  const scheduler = require(${JSON.stringify(path.join(root, 'src', 'main', 'task-scheduler.ts'))})
  module.exports = { database, importAutoOcr, scheduler }
`)

async function run() {
  let database
  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundlePath,
      external: ['better-sqlite3'],
      alias: {
        electron: electronStubPath,
        '@electron-toolkit/utils': path.join(root, 'scripts', 'stubs', 'electron-toolkit-utils.js'),
      },
      logLevel: 'silent',
    })

    const modules = require(bundlePath)
    database = modules.database
    const importAutoOcr = modules.importAutoOcr
    const scheduler = modules.scheduler
    await database.initDatabase()

    const task = importAutoOcr.createImportAutoOcrTask({
      engine: 'paddle',
      batchSize: 7,
      sourceImportJobId: 'import-fixture',
      nowMs: 1_000,
    })
    assert.strictEqual(task.totalCount, 0)
    assert.strictEqual(task.settingsSnapshot.engine, 'paddle')
    assert.strictEqual(task.settingsSnapshot.batchSize, 7)
    assert.strictEqual(task.settingsSnapshot.libraryProjectId, 'library_project_default')

    const documents = Array.from({ length: 450 }, (_, index) => ({
      docId: `doc-${String(index).padStart(3, '0')}`,
      sourceOrder: index,
      sourceType: index % 2 === 0 ? 'pdf-file' : 'image-file',
    }))
    database.transaction(() => {
      documents.forEach((item) => {
        database.run(
          `INSERT INTO documents (id, title, import_status, metadata, created_at, updated_at)
           VALUES (?, ?, 'processed', '{}', ?, ?)`,
          [item.docId, item.docId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
        )
      })
    })
    importAutoOcr.appendImportAutoOcrItems(task.id, documents.slice(0, 200), { nowMs: 1_010 })
    importAutoOcr.appendImportAutoOcrItems(task.id, documents.slice(200, 400), { nowMs: 1_011 })
    importAutoOcr.appendImportAutoOcrItems(task.id, documents.slice(400), { nowMs: 1_012 })
    importAutoOcr.appendImportAutoOcrItems(task.id, documents.slice(0, 25), { nowMs: 1_013 })

    const persisted = importAutoOcr.getImportAutoOcrTask(task.id)
    assert.strictEqual(persisted.totalCount, 450, 'all OCR items must be durable before execution starts')
    const ordered = importAutoOcr.listImportAutoOcrItems(task.id)
    assert.strictEqual(ordered.length, 450)
    assert.deepStrictEqual(ordered.map((item) => item.docId), documents.map((item) => item.docId))
    assert.deepStrictEqual(ordered.map((item) => item.sourceOrder), documents.map((item) => item.sourceOrder))
    assert.throws(
      () => importAutoOcr.appendImportAutoOcrItems(task.id, Array.from({ length: 201 }, (_, index) => ({ docId: `overflow-${index}`, sourceOrder: index }))),
      /import_auto_ocr_append_too_large/,
    )

    const resumable = importAutoOcr.listResumableImportAutoOcrTasks()
    assert.deepStrictEqual(resumable.map((item) => item.id), [task.id])
    const interruptedClaim = scheduler.claimTaskItems({ jobId: task.id, workerId: 'fixture-worker', limit: 1, leaseMs: 60_000, nowMs: 2_000 })[0]
    assert.strictEqual(scheduler.getTaskItem(interruptedClaim.itemId).status, 'running')
    assert.strictEqual(importAutoOcr.recoverInterruptedImportAutoOcrTasks(2_100), 1)
    assert.strictEqual(scheduler.getTaskItem(interruptedClaim.itemId).status, 'queued')
    assert.strictEqual(importAutoOcr.listImportAutoOcrItems(task.id)[0].docId, documents[0].docId)

    const strandedTask = importAutoOcr.createImportAutoOcrTask({
      engine: 'paddle',
      batchSize: 2,
      sourceImportJobId: 'stranded-import-fixture',
      nowMs: 3_000,
    })
    importAutoOcr.appendImportAutoOcrItems(strandedTask.id, [documents[0]], { nowMs: 3_010 })
    const failedClaim = scheduler.claimTaskItems({
      jobId: strandedTask.id,
      workerId: 'stranded-worker',
      limit: 1,
      leaseMs: 60_000,
      nowMs: 3_020,
    })[0]
    scheduler.failTaskItem({
      itemId: failedClaim.itemId,
      leaseToken: failedClaim.leaseToken,
      error: { code: 'fixture_failure', message: 'fixture failure', recoverable: true },
      nowMs: 3_030,
    })
    assert.strictEqual(importAutoOcr.getImportAutoOcrTask(strandedTask.id).status, 'error')
    importAutoOcr.appendImportAutoOcrItems(strandedTask.id, [documents[1]], { nowMs: 3_040 })
    assert.strictEqual(
      importAutoOcr.getImportAutoOcrTask(strandedTask.id).status,
      'error',
      'legacy append race should be reproduced before recovery',
    )
    assert.strictEqual(importAutoOcr.recoverInterruptedImportAutoOcrTasks(3_050), 1)
    assert.strictEqual(importAutoOcr.getImportAutoOcrTask(strandedTask.id).status, 'queued')
    assert.strictEqual(
      database.queryOne('SELECT ocr_status FROM documents WHERE id = ?', [documents[1].docId]).ocr_status,
      'queued',
      'stranded import-auto OCR documents should become visibly queued during recovery',
    )

    const librarySource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8').replace(/\r\n/g, '\n')
    assert.ok(!librarySource.includes('const autoOcrQueue:'), 'renderer must not own an unsubmitted Paddle auto-OCR queue')
    assert.ok(librarySource.includes('createImportAutoOcrTask('))
    assert.ok(librarySource.includes('appendImportAutoOcrItems('))
    assert.ok(librarySource.includes('startImportAutoOcrTask('))

    const ocrSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8').replace(/\r\n/g, '\n')
    assert.ok(
      ocrSource.includes('async function acquireDocumentOcrSlot(docId: string)')
        && ocrSource.includes('queuedOcrDocIds.add(docId)')
        && !ocrSource.includes('claims.forEach((claim) => {\n        const docId = String(claim.input.docId'),
      'persistent OCR claims must acquire their own document slot instead of pre-queuing the whole claimed batch',
    )

    console.log('Import auto OCR task regression passed.')
  } finally {
    database?.closeDatabase?.()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
