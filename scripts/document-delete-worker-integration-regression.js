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
    CREATE TABLE document_tags (
      doc_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE TABLE library_project_documents (
      document_id TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    -- This deliberately turns the final DELETE into one long synchronous
    -- SQLite statement. Running the same statement in Electron's main thread
    -- would stop every timer and make the window report "not responding".
    CREATE TABLE delete_cpu_fixture(value INTEGER NOT NULL);
    WITH RECURSIVE fixture(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM fixture WHERE value < 250000
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
  const documentIds = Array.from({ length: 8 }, (_, index) => `delete-${index}`)
  sqlite.transaction(() => {
    documentIds.forEach((documentId, index) => {
      insertDocument.run(documentId)
      insertTag.run(documentId, `tag-${index % 3}`)
      insertProject.run(documentId)
      for (let chunk = 0; chunk < 40; chunk += 1) {
        insertEmbedding.run(documentId, Buffer.alloc(512, chunk % 255))
      }
    })
  })()
  return { sqlite, documentIds }
}

function runWorkerTask(documentIds) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath)
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      worker.removeAllListeners()
      void worker.terminate().finally(callback)
    }
    worker.on('message', (message) => {
      if (message?.type === 'result') finish(() => resolve(message.result))
      if (message?.type === 'error') finish(() => reject(new Error(message.error)))
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`delete worker exited with code ${code}`)))
    })
    worker.postMessage({
      type: 'deleteDocuments',
      task: { dbFilePath: databasePath, documentIds },
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
    const result = await runWorkerTask(fixture.documentIds)
    const elapsedMs = Date.now() - startedAt
    clearInterval(heartbeat)

    assert.deepStrictEqual(result.deletedIds, fixture.documentIds)
    assert.deepStrictEqual([...result.affectedTagIds].sort(), ['tag-0', 'tag-1', 'tag-2'])
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get().count,
      0,
    )
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM embedding_chunks').get().count,
      0,
    )
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
    const bulkStartedAt = Date.now()
    const bulkResult = await runWorkerTask(bulkDocumentIds)
    const bulkElapsedMs = Date.now() - bulkStartedAt
    assert.strictEqual(bulkResult.deletedIds.length, bulkDocumentCount)
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get().count,
      0,
    )
    assert.strictEqual(
      sqlite.prepare('SELECT COUNT(*) AS count FROM embedding_chunks').get().count,
      0,
    )
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
