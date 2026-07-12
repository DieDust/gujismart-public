const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-task-scheduler-'))
const dataDir = path.join(tempRoot, 'data')
const bundlePath = path.join(tempRoot, 'task-scheduler.cjs')
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
  const scheduler = require(${JSON.stringify(path.join(root, 'src', 'main', 'task-scheduler.ts'))})
  const batchCompatibility = require(${JSON.stringify(path.join(root, 'src', 'main', 'task-batch-compat.ts'))})
  const importCompatibility = require(${JSON.stringify(path.join(root, 'src', 'main', 'task-import-compat.ts'))})
  module.exports = { database, scheduler, batchCompatibility, importCompatibility }
`)

function expectCode(fn, code) {
  assert.throws(fn, (error) => error && error.message === code, code)
}

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
    const scheduler = modules.scheduler
    const batchCompatibility = modules.batchCompatibility
    const importCompatibility = modules.importCompatibility
    await database.initDatabase()

    const tableNames = database.queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'task_%' ORDER BY name").map((row) => row.name)
    assert.deepStrictEqual(tableNames, ['task_artifacts', 'task_attempts', 'task_events', 'task_items', 'task_jobs'])
    expectCode(
      () => database.run("INSERT INTO task_jobs (id, kind, status, settings_snapshot_json, created_at, updated_at) VALUES ('bad', 'test', 'failed', '{}', 1, 1)"),
      'CHECK constraint failed: status IN (\'queued\', \'running\', \'paused\', \'completed\', \'error\', \'canceled\')',
    )

    const job = scheduler.createTaskJob({
      kind: 'ocr.batch',
      idempotencyKey: 'ocr-fixture',
      settingsSnapshot: { engine: 'paddle' },
      nowMs: 1_000,
    })
    const sameJob = scheduler.createTaskJob({ kind: 'ocr.batch', idempotencyKey: 'ocr-fixture', nowMs: 1_001 })
    assert.strictEqual(sameJob.id, job.id, 'job idempotency key must return the existing job')

    const items = Array.from({ length: 205 }, (_, index) => ({
      idempotencyKey: `doc-${index}`,
      domainType: 'document',
      domainRef: `doc-${index}`,
      input: { docId: `doc-${index}` },
    }))
    expectCode(() => scheduler.appendTaskItems(job.id, items, { nowMs: 1_010 }), 'task_item_batch_too_large')
    scheduler.appendTaskItems(job.id, items.slice(0, 200), { nowMs: 1_010 })
    scheduler.appendTaskItems(job.id, items.slice(200), { nowMs: 1_011 })
    scheduler.appendTaskItems(job.id, items.slice(0, 5), { nowMs: 1_012 })
    assert.strictEqual(scheduler.getTaskJob(job.id).totalCount, 205, 'item idempotency must prevent duplicates')
    const rollbackJob = scheduler.createTaskJob({ kind: 'fault-injection', idempotencyKey: 'rollback-fixture', nowMs: 1_020 })
    assert.throws(
      () => scheduler.appendTaskItems(rollbackJob.id, [
        { id: 'duplicate-fixture-id', idempotencyKey: 'rollback-a' },
        { id: 'duplicate-fixture-id', idempotencyKey: 'rollback-b' },
      ], { nowMs: 1_021 }),
      /UNIQUE constraint failed/,
    )
    assert.strictEqual(scheduler.getTaskJob(rollbackJob.id).totalCount, 0, 'failed append transaction must not leave a partial item')
    expectCode(() => scheduler.claimTaskItems({ jobId: job.id, workerId: 'worker-a', limit: 201, leaseMs: 5_000, nowMs: 2_000 }), 'task_claim_limit_invalid')

    const firstClaims = scheduler.claimTaskItems({ jobId: job.id, workerId: 'worker-a', limit: 2, leaseMs: 100, nowMs: 2_000 })
    assert.strictEqual(firstClaims.length, 2)
    assert.strictEqual(firstClaims[0].attemptNo, 1)
    expectCode(
      () => scheduler.heartbeatTaskLease({ itemId: firstClaims[0].itemId, leaseToken: 'wrong', leaseMs: 100, nowMs: 2_010 }),
      'task_lease_conflict',
    )
    scheduler.updateTaskItemCursor({
      itemId: firstClaims[0].itemId,
      leaseToken: firstClaims[0].leaseToken,
      cursor: { page: 12 },
      nowMs: 2_020,
    })
    scheduler.addTaskArtifact({
      jobId: job.id,
      itemId: firstClaims[0].itemId,
      attemptId: firstClaims[0].attemptId,
      kind: 'ocr-run',
      ref: 'ocr://fixture/doc-0/v1',
      version: 1,
      sha256: 'a'.repeat(64),
      idempotencyKey: 'doc-0-run-v1',
      metadata: { pages: 12 },
      nowMs: 2_030,
    })
    const sameArtifact = scheduler.addTaskArtifact({
      jobId: job.id,
      itemId: firstClaims[0].itemId,
      attemptId: firstClaims[0].attemptId,
      kind: 'ocr-run',
      ref: 'ocr://fixture/doc-0/v1',
      version: 1,
      sha256: 'a'.repeat(64),
      idempotencyKey: 'doc-0-run-v1',
      nowMs: 2_031,
    })
    expectCode(
      () => scheduler.addTaskArtifact({ ...sameArtifact, ref: 'ocr://changed', nowMs: 2_032 }),
      'task_artifact_immutable',
    )
    scheduler.completeTaskItem({
      itemId: firstClaims[0].itemId,
      leaseToken: firstClaims[0].leaseToken,
      completionKind: 'full',
      nowMs: 2_040,
    })

    const reclaimed = scheduler.claimTaskItems({ jobId: job.id, workerId: 'worker-b', limit: 1, leaseMs: 100, nowMs: 2_101 })[0]
    assert.strictEqual(reclaimed.itemId, firstClaims[1].itemId, 'expired running work must be reclaimed first')
    assert.strictEqual(reclaimed.attemptNo, 2)
    expectCode(
      () => scheduler.completeTaskItem({ itemId: firstClaims[1].itemId, leaseToken: firstClaims[1].leaseToken, nowMs: 2_102 }),
      'task_lease_conflict',
    )
    scheduler.failTaskItem({
      itemId: reclaimed.itemId,
      leaseToken: reclaimed.leaseToken,
      error: {
        code: 'ocr_provider_error',
        message: 'token-secret-value at C:\\Users\\fixture\\private.pdf',
        recoverable: true,
        recoveryAction: 'retry_task',
      },
      nowMs: 2_110,
    })
    const failedRow = database.queryOne('SELECT error_json FROM task_items WHERE id = ?', [reclaimed.itemId])
    assert.ok(!failedRow.error_json.includes('token-secret-value'))
    assert.ok(!failedRow.error_json.includes('C:\\Users'))
    scheduler.retryTaskItem(reclaimed.itemId, { nowMs: 2_120 })

    scheduler.pauseTaskJob(job.id, { nowMs: 2_130 })
    assert.deepStrictEqual(
      scheduler.claimTaskItems({ jobId: job.id, workerId: 'worker-c', limit: 1, leaseMs: 100, nowMs: 2_131 }),
      [],
      'paused jobs must not issue new leases',
    )
    scheduler.resumeTaskJob(job.id, { nowMs: 2_140 })
    const retried = scheduler.claimTaskItems({ jobId: job.id, workerId: 'worker-c', limit: 1, leaseMs: 100, nowMs: 2_141 })[0]
    assert.strictEqual(retried.itemId, reclaimed.itemId)
    assert.strictEqual(retried.attemptNo, 3)

    const eventPage1 = scheduler.listTaskEvents({ jobId: job.id, limit: 3 })
    const eventPage2 = scheduler.listTaskEvents({ jobId: job.id, limit: 3, cursor: eventPage1.nextCursor })
    assert.strictEqual(eventPage1.items.length, 3)
    assert.ok(eventPage2.items.length > 0)
    assert.notStrictEqual(eventPage1.items[2].id, eventPage2.items[0].id)
    const artifacts = scheduler.listTaskArtifacts({ jobId: job.id, limit: 10 })
    assert.strictEqual(artifacts.items.length, 1)
    assert.strictEqual(artifacts.items[0].id, sameArtifact.id)

    scheduler.cancelTaskJob(job.id, { nowMs: 2_150 })
    assert.strictEqual(scheduler.getTaskJob(job.id).status, 'canceled')
    assert.strictEqual(scheduler.getTaskItem(retried.itemId).status, 'canceled')

    database.run("INSERT INTO documents (id, title, import_status, created_at, updated_at) VALUES ('legacy-doc-1', 'Legacy 1', 'stored', '2026-01-01', '2026-01-01')")
    database.run("INSERT INTO documents (id, title, import_status, created_at, updated_at) VALUES ('legacy-doc-2', 'Legacy 2', 'stored', '2026-01-01', '2026-01-01')")
    database.run("INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, created_at) VALUES ('legacy-item-1', 'legacy-batch', 'legacy-doc-1', 'pending', 5, 0, '2026-01-01')")
    database.run("INSERT INTO batch_queue (id, batch_id, doc_id, status, batch_size, progress, created_at) VALUES ('legacy-item-2', 'legacy-batch', 'legacy-doc-2', 'processing', 5, 25, '2026-01-01')")
    const bridge1 = scheduler.bridgeLegacyBatchQueue({ nowMs: 3_000 })
    const bridge2 = scheduler.bridgeLegacyBatchQueue({ nowMs: 3_100 })
    assert.deepStrictEqual(bridge1, { jobsCreated: 1, itemsCreated: 2, itemsReused: 0 })
    assert.deepStrictEqual(bridge2, { jobsCreated: 0, itemsCreated: 0, itemsReused: 2 })
    const bridgedJob = database.queryOne("SELECT * FROM task_jobs WHERE idempotency_key = 'legacy:batch_queue:legacy-batch'")
    assert.strictEqual(bridgedJob.total_count, 2)
    assert.strictEqual(bridgedJob.status, 'queued')

    database.run("INSERT INTO documents (id, title, import_status, created_at, updated_at) VALUES ('compat-doc-1', 'Compat 1', 'stored', '2026-01-01', '2026-01-01')")
    database.run("INSERT INTO documents (id, title, import_status, created_at, updated_at) VALUES ('compat-doc-2', 'Compat 2', 'stored', '2026-01-01', '2026-01-01')")
    const compatibleBatch = batchCompatibility.createLegacyBatchTask(['compat-doc-1', 'compat-doc-2'], 3, {
      batchId: 'compat-batch',
      nowMs: 4_000,
    })
    assert.strictEqual(compatibleBatch.count, 2)
    assert.strictEqual(database.queryOne("SELECT COUNT(*) AS count FROM batch_queue WHERE batch_id = 'compat-batch'").count, 2)
    assert.strictEqual(scheduler.getTaskJob(compatibleBatch.jobId).totalCount, 2)
    const firstCompatibleItem = compatibleBatch.items[0]
    const started = batchCompatibility.startLegacyBatchItem(firstCompatibleItem.legacyItemId, 'compat-worker', {
      leaseMs: 1_000,
      nowMs: 4_010,
    })
    assert.strictEqual(started.itemId, firstCompatibleItem.taskItemId)
    assert.strictEqual(scheduler.getTaskItem(firstCompatibleItem.taskItemId).status, 'running')
    assert.strictEqual(database.queryOne('SELECT status FROM batch_queue WHERE id = ?', [firstCompatibleItem.legacyItemId]).status, 'processing')
    batchCompatibility.completeLegacyBatchItem(firstCompatibleItem.legacyItemId, { nowMs: 4_020 })
    assert.strictEqual(scheduler.getTaskItem(firstCompatibleItem.taskItemId).status, 'completed')
    assert.strictEqual(database.queryOne('SELECT status FROM batch_queue WHERE id = ?', [firstCompatibleItem.legacyItemId]).status, 'completed')

    const secondCompatibleItem = compatibleBatch.items[1]
    batchCompatibility.startLegacyBatchItem(secondCompatibleItem.legacyItemId, 'compat-worker', { leaseMs: 1_000, nowMs: 4_030 })
    batchCompatibility.releaseLegacyBatchItem(secondCompatibleItem.legacyItemId, { nowMs: 4_040 })
    assert.strictEqual(scheduler.getTaskItem(secondCompatibleItem.taskItemId).status, 'queued')
    assert.strictEqual(database.queryOne('SELECT status FROM batch_queue WHERE id = ?', [secondCompatibleItem.legacyItemId]).status, 'pending')
    const restarted = batchCompatibility.startLegacyBatchItem(secondCompatibleItem.legacyItemId, 'compat-worker', { leaseMs: 1_000, nowMs: 4_050 })
    assert.strictEqual(restarted.attemptNo, 2)
    batchCompatibility.failLegacyBatchItem(secondCompatibleItem.legacyItemId, {
      errorMessage: 'provider failed',
      recoverable: true,
      nowMs: 4_060,
    })
    assert.strictEqual(scheduler.getTaskItem(secondCompatibleItem.taskItemId).status, 'error')
    assert.strictEqual(database.queryOne('SELECT status FROM batch_queue WHERE id = ?', [secondCompatibleItem.legacyItemId]).status, 'failed')

    const importBridge1 = importCompatibility.registerLegacyImportQueueState({
      version: 2,
      savedAt: '2026-01-01T00:00:00.000Z',
      jobs: [{
        id: 77,
        selectionId: 'selection-fixture',
        sourceLabels: ['first.pdf', 'second.pdf'],
        pendingCount: 2,
        engine: 'paddle',
        authorizationStatus: 'authorized',
      }],
    }, { nowMs: 5_000 })
    const importBridge2 = importCompatibility.registerLegacyImportQueueState({
      version: 2,
      savedAt: '2026-01-01T00:00:01.000Z',
      jobs: [{
        id: 77,
        selectionId: 'selection-fixture',
        sourceLabels: ['first.pdf', 'second.pdf'],
        pendingCount: 2,
        engine: 'paddle',
        authorizationStatus: 'authorized',
      }],
    }, { nowMs: 5_001 })
    assert.deepStrictEqual(importBridge1, { jobsCreated: 1, jobsReused: 0, itemsCreated: 1 })
    assert.deepStrictEqual(importBridge2, { jobsCreated: 0, jobsReused: 1, itemsCreated: 0 })
    const importTask = database.queryOne("SELECT * FROM task_jobs WHERE idempotency_key = 'legacy:library_import_queue:77'")
    assert.strictEqual(importTask.kind, 'import.compatibility')
    assert.strictEqual(importTask.total_count, 1)
    assert.strictEqual(importCompatibility.cancelLegacyImportQueueTasks([77], { nowMs: 5_010 }), 1)
    assert.strictEqual(scheduler.getTaskJob(importTask.id).status, 'canceled')

    database.closeDatabase()
    database = null
    await modules.database.initDatabase()
    assert.strictEqual(modules.database.queryOne("SELECT COUNT(*) AS count FROM task_jobs WHERE idempotency_key = 'legacy:batch_queue:legacy-batch'").count, 1)
    assert.strictEqual(modules.database.queryOne("SELECT COUNT(*) AS count FROM batch_queue WHERE batch_id = 'legacy-batch'").count, 2)
    modules.database.closeDatabase()
    database = null

    console.log('Task scheduler SQLite integration regression checks passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
