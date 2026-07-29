const assert = require('assert')
const { app } = require('electron')
const Database = require('better-sqlite3')
const { mkdtempSync, rmSync } = require('fs')
const { join } = require('path')
const { Worker } = require('worker_threads')
const { buildSync } = require('esbuild')

const root = join(__dirname, '..')
const tempRoot = mkdtempSync(join(__dirname, '.tmp-document-delete-worker-'))
const databasePath = join(tempRoot, 'library.db')
const workerPath = join(tempRoot, 'document-delete-worker.cjs')

function buildWorker() {
  buildSync({
    entryPoints: [join(root, 'src', 'main', 'document-delete-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerPath,
    external: ['better-sqlite3'],
    logLevel: 'silent',
  })
}

function createFixture() {
  const sqlite = new Database(databasePath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      import_status TEXT
    );
    CREATE TABLE embedding_chunks (
      id INTEGER PRIMARY KEY,
      doc_id TEXT NOT NULL,
      embedding BLOB,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_embedding_chunks_doc ON embedding_chunks(doc_id);
    CREATE TABLE ocr_runs (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_ocr_runs_doc ON ocr_runs(doc_id);
    CREATE TABLE ocr_page_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES ocr_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_ocr_page_attempts_run ON ocr_page_attempts(run_id);
    CREATE TABLE ocr_artifact_versions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES ocr_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES ocr_page_attempts(id) ON DELETE CASCADE,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_ocr_artifacts_run ON ocr_artifact_versions(run_id);
    CREATE TABLE document_tags (
      doc_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE TABLE library_project_documents (
      document_id TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE TABLE writer_probe (
      value INTEGER NOT NULL
    );

    -- This deliberately turns the final DELETE into one long synchronous
    -- SQLite statement. Running the same statement in Electron's main thread
    -- would stop every timer and make the window report "not responding".
    CREATE TABLE delete_cpu_fixture(value INTEGER NOT NULL);
    WITH RECURSIVE fixture(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM fixture WHERE value < 500000
    )
    INSERT INTO delete_cpu_fixture(value) SELECT value FROM fixture;
    CREATE TRIGGER slow_document_delete
    BEFORE DELETE ON documents
    BEGIN
      SELECT CASE
        WHEN (SELECT SUM(value) FROM delete_cpu_fixture) < 0
        THEN RAISE(ABORT, 'unreachable')
      END;
    END;
  `)
  const insertDocument = sqlite.prepare(
    "INSERT INTO documents (id, import_status) VALUES (?, 'deleting')",
  )
  const insertEmbedding = sqlite.prepare(
    'INSERT INTO embedding_chunks (doc_id, embedding) VALUES (?, ?)',
  )
  const insertTag = sqlite.prepare(
    'INSERT INTO document_tags (doc_id, tag_id) VALUES (?, ?)',
  )
  const insertProject = sqlite.prepare(
    'INSERT INTO library_project_documents (document_id) VALUES (?)',
  )
  const insertOcrRun = sqlite.prepare(
    'INSERT INTO ocr_runs (id, doc_id) VALUES (?, ?)',
  )
  const insertOcrAttempt = sqlite.prepare(
    'INSERT INTO ocr_page_attempts (id, run_id, page_id, attempt_no) VALUES (?, ?, ?, 1)',
  )
  const insertOcrArtifact = sqlite.prepare(
    'INSERT INTO ocr_artifact_versions (id, run_id, attempt_id, doc_id, page_id) VALUES (?, ?, ?, ?, ?)',
  )
  const documentIds = Array.from({ length: 8 }, (_, index) => `delete-${index}`)
  const preservedDocumentId = 'preserved-document'
  const preservedArtifactCount = 5_000
  sqlite.transaction(() => {
    documentIds.forEach((documentId, index) => {
      insertDocument.run(documentId)
      insertTag.run(documentId, `tag-${index % 3}`)
      insertProject.run(documentId)
      for (let chunk = 0; chunk < 40; chunk += 1) {
        insertEmbedding.run(documentId, Buffer.alloc(512, chunk % 255))
      }
      const runId = `ocr-run-${index}`
      const attemptId = `ocr-attempt-${index}`
      const pageId = `ocr-page-${index}`
      insertOcrRun.run(runId, documentId)
      insertOcrAttempt.run(attemptId, runId, pageId)
      for (let artifact = 0; artifact < 40; artifact += 1) {
        insertOcrArtifact.run(
          `ocr-artifact-${index}-${artifact}`,
          runId,
          attemptId,
          documentId,
          pageId,
        )
      }
    })
    insertDocument.run(preservedDocumentId)
    insertOcrRun.run('preserved-ocr-run', preservedDocumentId)
    insertOcrAttempt.run('preserved-ocr-attempt', 'preserved-ocr-run', 'preserved-page')
    for (let artifact = 0; artifact < preservedArtifactCount; artifact += 1) {
      insertOcrArtifact.run(
        `preserved-ocr-artifact-${artifact}`,
        'preserved-ocr-run',
        'preserved-ocr-attempt',
        preservedDocumentId,
        'preserved-page',
      )
    }
  })()
  return { sqlite, documentIds, preservedArtifactCount }
}

function runWorkerTask(documentIds, onProgress, foregroundWriterBuffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath)
    const progress = []
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      worker.removeAllListeners()
      void worker.terminate().finally(callback)
    }
    worker.on('message', (message) => {
      if (message?.type === 'progress') {
        progress.push(message)
        onProgress?.(message)
      }
      if (message?.type === 'result') finish(() => resolve({ result: message.result, progress }))
      if (message?.type === 'error') finish(() => reject(new Error(message.error)))
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`delete worker exited with code ${code}`)))
    })
    worker.postMessage({
      type: 'deleteDocuments',
      task: { dbFilePath: databasePath, documentIds, foregroundWriterBuffer },
    })
  })
}

async function run() {
  let sqlite
  try {
    buildWorker()
    const fixture = createFixture()
    sqlite = fixture.sqlite

    let heartbeatCount = 0
    let maximumHeartbeatLagMs = 0
    let lastHeartbeatAt = Date.now()
    const heartbeat = setInterval(() => {
      const now = Date.now()
      maximumHeartbeatLagMs = Math.max(maximumHeartbeatLagMs, now - lastHeartbeatAt)
      lastHeartbeatAt = now
      heartbeatCount += 1
    }, 10)

    const startedAt = Date.now()
    const { result, progress } = await runWorkerTask(fixture.documentIds)
    const elapsedMs = Date.now() - startedAt
    clearInterval(heartbeat)

    assert.deepStrictEqual(result.deletedIds, fixture.documentIds)
    assert.deepStrictEqual([...result.affectedTagIds].sort(), ['tag-0', 'tag-1', 'tag-2'])
    assert.strictEqual(progress[0]?.phase, 'preparing')
    assert.strictEqual(progress[0]?.completed, 0)
    assert.strictEqual(progress.at(-1)?.phase, 'deleting')
    assert.strictEqual(progress.at(-1)?.completed, fixture.documentIds.length)
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get().count,
      1,
    )
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM embedding_chunks').get().count,
      0,
    )
    assert.strictEqual(sqlite.prepare('SELECT COUNT(*) AS count FROM ocr_runs').get().count, 1)
    assert.strictEqual(sqlite.prepare('SELECT COUNT(*) AS count FROM ocr_page_attempts').get().count, 1)
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM ocr_artifact_versions').get().count,
      fixture.preservedArtifactCount,
    )
    assert.deepStrictEqual(sqlite.pragma('foreign_key_check'), [])
    assert(
      elapsedMs >= 100,
      `slow-delete fixture did not exercise a meaningful blocking statement (${elapsedMs}ms)`,
    )
    assert(
      heartbeatCount >= 3,
      `Electron main-thread heartbeat stopped during worker deletion (${heartbeatCount} ticks)`,
    )
    assert(
      maximumHeartbeatLagMs < 250,
      `Electron main-thread heartbeat lagged ${maximumHeartbeatLagMs}ms during worker deletion`,
    )

    const priorityDocumentId = 'foreground-priority-delete'
    sqlite.prepare("INSERT INTO documents (id, import_status) VALUES (?, 'deleting')").run(priorityDocumentId)
    sqlite.prepare('INSERT INTO embedding_chunks (doc_id, embedding) VALUES (?, ?)').run(priorityDocumentId, Buffer.alloc(512))
    const priorityState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    Atomics.store(priorityState, 0, 1)
    const priorityDelete = runWorkerTask([priorityDocumentId], undefined, priorityState.buffer)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM documents WHERE id = ?').get(priorityDocumentId).count,
      1,
      'delete worker must pause while a foreground OCR/database writer is requesting priority',
    )
    Atomics.store(priorityState, 0, 0)
    Atomics.notify(priorityState, 0)
    await priorityDelete
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM documents WHERE id = ?').get(priorityDocumentId).count,
      0,
    )

    sqlite.exec('DROP TRIGGER slow_document_delete; DROP TABLE delete_cpu_fixture;')
    const bulkDocumentCount = 320
    const bulkDocumentIds = Array.from({ length: bulkDocumentCount }, (_, index) => `bulk-delete-${index}`)
    const insertDocument = sqlite.prepare(
      "INSERT INTO documents (id, import_status) VALUES (?, 'deleting')",
    )
    const insertEmbedding = sqlite.prepare(
      'INSERT INTO embedding_chunks (doc_id, embedding) VALUES (?, ?)',
    )
    const insertTag = sqlite.prepare(
      'INSERT INTO document_tags (doc_id, tag_id) VALUES (?, ?)',
    )
    const insertProject = sqlite.prepare(
      'INSERT INTO library_project_documents (document_id) VALUES (?)',
    )
    sqlite.transaction(() => {
      bulkDocumentIds.forEach((documentId, index) => {
        insertDocument.run(documentId)
        insertTag.run(documentId, `bulk-tag-${index % 5}`)
        insertProject.run(documentId)
        for (let chunk = 0; chunk < 100; chunk += 1) {
          insertEmbedding.run(documentId, Buffer.alloc(512, chunk % 255))
        }
      })
    })()
    let concurrentWriteCompleted = false
    let concurrentWriteError = null
    const bulkStartedAt = Date.now()
    const { result: bulkResult, progress: bulkProgress } = await runWorkerTask(
      bulkDocumentIds,
      (progressEvent) => {
        if (concurrentWriteCompleted || progressEvent.phase !== 'deleting' || progressEvent.completed >= bulkDocumentCount) return
        try {
          sqlite.prepare('INSERT INTO writer_probe (value) VALUES (?)').run(progressEvent.completed)
          concurrentWriteCompleted = true
        } catch (error) {
          concurrentWriteError = error
        }
      },
    )
    const bulkElapsedMs = Date.now() - bulkStartedAt
    assert.strictEqual(bulkResult.deletedIds.length, bulkDocumentCount)
    assert.strictEqual(bulkProgress[0]?.phase, 'preparing')
    assert.strictEqual(bulkProgress.at(-1)?.completed, bulkDocumentCount)
    assert.ifError(concurrentWriteError)
    assert(concurrentWriteCompleted, 'a foreground/OCR-style writer should run between delete batches')
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get().count,
      1,
    )
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM embedding_chunks').get().count,
      0,
    )
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM ocr_artifact_versions').get().count,
      fixture.preservedArtifactCount,
    )
    assert.deepStrictEqual(sqlite.pragma('foreign_key_check'), [])
    assert(
      bulkElapsedMs < 10_000,
      `320-document vector cleanup exceeded the regression budget (${bulkElapsedMs}ms)`,
    )

    console.log(
      `Document delete worker integration regression passed (${elapsedMs}ms, `
      + `${heartbeatCount} heartbeats, max lag ${maximumHeartbeatLagMs}ms; `
      + `${bulkDocumentCount} documents with 32,000 vectors in ${bulkElapsedMs}ms)`,
    )
  } finally {
    sqlite?.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

run()
  .then(() => {
    app.quit()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.quit()
    process.exit(1)
  })
