import Database from 'better-sqlite3'
import { parentPort } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import type {
  DocumentDeleteWorkerResult,
  DocumentDeleteWorkerTask,
} from './document-delete-worker-client'

if (!parentPort) {
  throw new Error('Document delete worker requires a parent port')
}

const ID_CHUNK_SIZE = 100
const ROW_CHUNK_SIZE = 80
const DOCUMENT_BATCH_SIZE = 4
const DATABASE_BUSY_TIMEOUT_MS = 5_000

type NativeDatabase = Database.Database

type WorkerMessage = {
  type: 'deleteDocuments'
  task: DocumentDeleteWorkerTask
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))]
}

function isDatabaseMalformedError(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : {}
  const code = String(record.code || '')
  const message = String(record.message || error || '')
  return code === 'SQLITE_CORRUPT'
    || /database disk image is malformed|database malformed|malformed database/i.test(message)
}

function tableExists(sqlite: NativeDatabase, tableName: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
}

function runForIdChunks(
  ids: string[],
  callback: (chunkIds: string[], placeholders: string) => void,
): void {
  for (let index = 0; index < ids.length; index += ID_CHUNK_SIZE) {
    const chunkIds = ids.slice(index, index + ID_CHUNK_SIZE)
    if (chunkIds.length === 0) continue
    callback(chunkIds, chunkIds.map(() => '?').join(', '))
  }
}

function deleteRowsByColumn(
  sqlite: NativeDatabase,
  tableName: string,
  columnName: string,
  documentIds: string[],
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)) {
    throw new Error(`Unsafe delete relation identifier: ${tableName}.${columnName}`)
  }
  if (!tableExists(sqlite, tableName)) return

  runForIdChunks(documentIds, (chunkIds, placeholders) => {
    const selectRows = sqlite.prepare(
      `SELECT rowid AS delete_rowid
       FROM "${tableName}"
       WHERE "${columnName}" IN (${placeholders})
       LIMIT ?`,
    )
    while (true) {
      const rows = selectRows.all(...chunkIds, ROW_CHUNK_SIZE) as Array<{ delete_rowid: number }>
      if (rows.length === 0) break
      const rowPlaceholders = rows.map(() => '?').join(', ')
      sqlite.prepare(`DELETE FROM "${tableName}" WHERE rowid IN (${rowPlaceholders})`)
        .run(...rows.map((row) => row.delete_rowid))
    }
  })
}

function deleteRowsByDocIds(sqlite: NativeDatabase, tableName: string, documentIds: string[]): void {
  deleteRowsByColumn(sqlite, tableName, 'doc_id', documentIds)
}

function deleteOcrPageAttempts(sqlite: NativeDatabase, documentIds: string[]): void {
  if (!tableExists(sqlite, 'ocr_page_attempts') || !tableExists(sqlite, 'ocr_runs')) return
  runForIdChunks(documentIds, (chunkIds, placeholders) => {
    const selectRows = sqlite.prepare(
      `SELECT attempt.rowid AS delete_rowid
       FROM ocr_page_attempts attempt
       INNER JOIN ocr_runs run ON run.id = attempt.run_id
       WHERE run.doc_id IN (${placeholders})
       LIMIT ?`,
    )
    while (true) {
      const rows = selectRows.all(...chunkIds, ROW_CHUNK_SIZE) as Array<{ delete_rowid: number }>
      if (rows.length === 0) break
      const rowPlaceholders = rows.map(() => '?').join(', ')
      sqlite.prepare(`DELETE FROM ocr_page_attempts WHERE rowid IN (${rowPlaceholders})`)
        .run(...rows.map((row) => row.delete_rowid))
    }
  })
}

function deleteAiChatTurns(sqlite: NativeDatabase, documentIds: string[]): void {
  if (!tableExists(sqlite, 'ai_chat_turns') || !tableExists(sqlite, 'ai_chat_sessions')) return
  runForIdChunks(documentIds, (chunkIds, placeholders) => {
    const selectRows = sqlite.prepare(
      `SELECT turn.rowid AS delete_rowid
       FROM ai_chat_turns turn
       INNER JOIN ai_chat_sessions session ON session.id = turn.session_id
       WHERE session.doc_id IN (${placeholders})
       LIMIT ?`,
    )
    while (true) {
      const rows = selectRows.all(...chunkIds, ROW_CHUNK_SIZE) as Array<{ delete_rowid: number }>
      if (rows.length === 0) break
      const rowPlaceholders = rows.map(() => '?').join(', ')
      sqlite.prepare(`DELETE FROM ai_chat_turns WHERE rowid IN (${rowPlaceholders})`)
        .run(...rows.map((row) => row.delete_rowid))
    }
  })
}

function deleteFtsRows(sqlite: NativeDatabase, documentIds: string[]): void {
  if (tableExists(sqlite, 'pages_fts')) {
    runForIdChunks(documentIds, (chunkIds, placeholders) => {
      const selectRows = sqlite.prepare(
        `SELECT rowid AS delete_rowid FROM pages_fts WHERE doc_id IN (${placeholders}) LIMIT ?`,
      )
      while (true) {
        const rows = selectRows.all(...chunkIds, ROW_CHUNK_SIZE) as Array<{ delete_rowid: number }>
        if (rows.length === 0) break
        const rowPlaceholders = rows.map(() => '?').join(', ')
        sqlite.prepare(`DELETE FROM pages_fts WHERE rowid IN (${rowPlaceholders})`)
          .run(...rows.map((row) => row.delete_rowid))
      }
    })
  }

  if (!tableExists(sqlite, 'search_index_segments') || !tableExists(sqlite, 'search_segments_fts')) return
  const hasTrigram = tableExists(sqlite, 'search_segments_trigram')
  runForIdChunks(documentIds, (chunkIds, placeholders) => {
    const selectSegments = sqlite.prepare(
      `SELECT rowid AS delete_rowid, title, normalized_text, text
       FROM search_index_segments
       WHERE doc_id IN (${placeholders})
         AND TRIM(COALESCE(normalized_text, text, '')) != ''
       LIMIT ?`,
    )
    const deleteFts = sqlite.prepare(
      `INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
       VALUES ('delete', ?, ?, ?)`,
    )
    const deleteTrigram = hasTrigram
      ? sqlite.prepare(
        `INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)
         VALUES ('delete', ?, ?)`,
      )
      : null
    while (true) {
      const rows = selectSegments.all(...chunkIds, ROW_CHUNK_SIZE) as Array<{
        delete_rowid: number
        title: string | null
        normalized_text: string | null
        text: string | null
      }>
      if (rows.length === 0) break
      sqlite.transaction(() => {
        for (const row of rows) {
          const normalizedText = String(row.normalized_text || row.text || '')
          deleteFts.run(row.delete_rowid, String(row.title || ''), normalizedText)
          deleteTrigram?.run(row.delete_rowid, normalizedText)
        }
      })()
      const rowPlaceholders = rows.map(() => '?').join(', ')
      sqlite.prepare(`DELETE FROM search_index_segments WHERE rowid IN (${rowPlaceholders})`)
        .run(...rows.map((row) => row.delete_rowid))
    }
  })
}

function resetRebuildableSearchTables(sqlite: NativeDatabase): void {
  sqlite.exec(`
    DROP TABLE IF EXISTS search_segments_trigram;
    DROP TABLE IF EXISTS search_segments_fts;
    DROP TABLE IF EXISTS pages_fts;
    DROP TABLE IF EXISTS search_ngram_index_staging;
    DROP TABLE IF EXISTS search_index_segments_staging;
    DROP TABLE IF EXISTS search_ngram_index;
    DROP TABLE IF EXISTS search_index_segments;
    DROP TABLE IF EXISTS search_index_status;

    CREATE TABLE IF NOT EXISTS search_index_segments (
      segment_id TEXT PRIMARY KEY,
      library_project_id TEXT,
      doc_id TEXT NOT NULL,
      page_id TEXT,
      page_num INTEGER,
      source_kind TEXT DEFAULT 'page',
      href TEXT,
      title TEXT,
      ordinal INTEGER DEFAULT 0,
      source_start INTEGER DEFAULT 0,
      text TEXT DEFAULT '',
      normalized_text TEXT DEFAULT '',
      offset_map TEXT DEFAULT '',
      text_hash TEXT DEFAULT '',
      updated_at TEXT,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS search_ngram_index (
      gram TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      positions TEXT NOT NULL,
      hit_count INTEGER DEFAULT 0,
      PRIMARY KEY (gram, segment_id),
      FOREIGN KEY (segment_id) REFERENCES search_index_segments(segment_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS search_index_segments_staging (
      job_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      library_project_id TEXT,
      doc_id TEXT NOT NULL,
      page_id TEXT,
      page_num INTEGER,
      source_kind TEXT DEFAULT 'page',
      href TEXT,
      title TEXT,
      ordinal INTEGER DEFAULT 0,
      source_start INTEGER DEFAULT 0,
      text TEXT DEFAULT '',
      normalized_text TEXT DEFAULT '',
      offset_map TEXT DEFAULT '',
      text_hash TEXT DEFAULT '',
      updated_at TEXT,
      PRIMARY KEY (job_id, segment_id)
    );

    CREATE TABLE IF NOT EXISTS search_ngram_index_staging (
      job_id TEXT NOT NULL,
      gram TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      positions TEXT NOT NULL,
      hit_count INTEGER DEFAULT 0,
      PRIMARY KEY (job_id, gram, segment_id)
    );

    CREATE TABLE IF NOT EXISTS search_index_status (
      doc_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'pending',
      source_hash TEXT DEFAULT '',
      segment_count INTEGER DEFAULT 0,
      error_message TEXT,
      indexed_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_search_segments_doc_id ON search_index_segments(doc_id);
    CREATE INDEX IF NOT EXISTS idx_search_segments_page_num ON search_index_segments(doc_id, page_num, ordinal);
    CREATE INDEX IF NOT EXISTS idx_search_ngram_doc_id ON search_ngram_index(doc_id);
    CREATE INDEX IF NOT EXISTS idx_search_ngram_segment ON search_ngram_index(segment_id);
    CREATE INDEX IF NOT EXISTS idx_search_ngram_hit_count ON search_ngram_index(gram, hit_count);
    CREATE INDEX IF NOT EXISTS idx_search_segments_staging_doc ON search_index_segments_staging(job_id, doc_id);
    CREATE INDEX IF NOT EXISTS idx_search_ngram_staging_doc ON search_ngram_index_staging(job_id, doc_id);
    CREATE INDEX IF NOT EXISTS idx_search_index_status_updated_at ON search_index_status(updated_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      page_id UNINDEXED,
      doc_id UNINDEXED,
      page_num UNINDEXED,
      content
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_segments_fts USING fts5(
      title,
      normalized_text,
      content='search_index_segments',
      content_rowid='rowid'
    );
  `)
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_segments_trigram USING fts5(
        normalized_text,
        content='search_index_segments',
        content_rowid='rowid',
        tokenize='trigram'
      );
    `)
  } catch {
    // Trigram tokenization is optional on SQLite builds that do not provide it.
  }
  sqlite.exec(`
    INSERT INTO pages_fts (rowid, page_id, doc_id, page_num, content)
    SELECT rowid, id, doc_id, page_num,
           TRIM(COALESCE(proofed_text, '') || ' ' || COALESCE(ocr_text, ''))
    FROM pages;
  `)
}

function getAffectedTagIds(sqlite: NativeDatabase, documentIds: string[]): string[] {
  if (!tableExists(sqlite, 'document_tags')) return []
  const tagIds = new Set<string>()
  runForIdChunks(documentIds, (chunkIds, placeholders) => {
    const rows = sqlite.prepare(
      `SELECT DISTINCT tag_id FROM document_tags WHERE doc_id IN (${placeholders})`,
    ).all(...chunkIds) as Array<{ tag_id: string }>
    rows.forEach((row) => {
      if (row.tag_id) tagIds.add(row.tag_id)
    })
  })
  return [...tagIds]
}

function deleteDocumentBatch(
  sqlite: NativeDatabase,
  documentIds: string[],
): { recoveredSearchIndexIssue: boolean } {
  let recoveredSearchIndexIssue = false

  deleteRowsByDocIds(sqlite, 'embedding_chunks', documentIds)
  deleteRowsByDocIds(sqlite, 'embedding_index_status', documentIds)
  try {
    deleteRowsByDocIds(sqlite, 'search_ngram_index', documentIds)
  } catch (error) {
    if (!isDatabaseMalformedError(error)) throw error
    recoveredSearchIndexIssue = true
    resetRebuildableSearchTables(sqlite)
  }
  deleteRowsByDocIds(sqlite, 'metadata_candidates', documentIds)
  deleteRowsByDocIds(sqlite, 'page_ocr_versions', documentIds)
  deleteRowsByDocIds(sqlite, 'ocr_artifact_versions', documentIds)
  deleteOcrPageAttempts(sqlite, documentIds)
  deleteRowsByDocIds(sqlite, 'ocr_runs', documentIds)
  deleteRowsByDocIds(sqlite, 'page_ai_layout_cache', documentIds)
  deleteRowsByDocIds(sqlite, 'page_translation_cache', documentIds)
  deleteRowsByDocIds(sqlite, 'page_translation_units', documentIds)
  deleteRowsByDocIds(sqlite, 'document_toc_items', documentIds)
  deleteRowsByDocIds(sqlite, 'reader_state', documentIds)
  deleteRowsByDocIds(sqlite, 'ai_document_summaries', documentIds)
  deleteRowsByDocIds(sqlite, 'research_notes', documentIds)
  deleteRowsByDocIds(sqlite, 'research_project_documents', documentIds)
  deleteRowsByDocIds(sqlite, 'research_evidence', documentIds)
  deleteRowsByDocIds(sqlite, 'ai_research_records', documentIds)
  deleteRowsByDocIds(sqlite, 'ai_results', documentIds)
  deleteAiChatTurns(sqlite, documentIds)
  deleteRowsByDocIds(sqlite, 'ai_chat_sessions', documentIds)
  deleteRowsByDocIds(sqlite, 'batch_queue', documentIds)
  deleteRowsByColumn(sqlite, 'citation_snapshots', 'document_id', documentIds)
  deleteRowsByColumn(sqlite, 'export_snapshots', 'document_id', documentIds)
  deleteRowsByDocIds(sqlite, 'translation_context_snapshots', documentIds)

  try {
    deleteFtsRows(sqlite, documentIds)
    deleteRowsByDocIds(sqlite, 'search_index_segments', documentIds)
    deleteRowsByDocIds(sqlite, 'search_index_status', documentIds)
  } catch (error) {
    if (!isDatabaseMalformedError(error)) throw error
    recoveredSearchIndexIssue = true
    resetRebuildableSearchTables(sqlite)
  }

  deleteRowsByDocIds(sqlite, 'pages', documentIds)
  deleteRowsByDocIds(sqlite, 'document_folders', documentIds)
  deleteRowsByDocIds(sqlite, 'document_tags', documentIds)
  deleteRowsByColumn(sqlite, 'library_project_documents', 'document_id', documentIds)
  runForIdChunks(documentIds, (chunkIds, placeholders) => {
    sqlite.prepare(`DELETE FROM documents WHERE id IN (${placeholders})`).run(...chunkIds)
  })
  return { recoveredSearchIndexIssue }
}

function deleteDocuments(task: DocumentDeleteWorkerTask): DocumentDeleteWorkerResult {
  const documentIds = uniqueIds(task.documentIds)
  if (documentIds.length === 0) {
    return { deletedIds: [], affectedTagIds: [], recoveredSearchIndexIssue: false }
  }

  const sqlite = new Database(task.dbFilePath, { fileMustExist: true })
  try {
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`)

    const affectedTagIds = getAffectedTagIds(sqlite, documentIds)
    const deletedIds: string[] = []
    let recoveredSearchIndexIssue = false
    for (let offset = 0; offset < documentIds.length; offset += DOCUMENT_BATCH_SIZE) {
      const batch = documentIds.slice(offset, offset + DOCUMENT_BATCH_SIZE)
      const result = deleteDocumentBatch(sqlite, batch)
      if (result.recoveredSearchIndexIssue) recoveredSearchIndexIssue = true
      deletedIds.push(...batch)
      parentPort?.postMessage({
        type: 'progress',
        completed: deletedIds.length,
        total: documentIds.length,
      })
    }
    return { deletedIds, affectedTagIds, recoveredSearchIndexIssue }
  } finally {
    sqlite.close()
  }
}

parentPort.on('message', (message: WorkerMessage) => {
  if (message?.type !== 'deleteDocuments' || !message.task) return
  try {
    const result = deleteDocuments(message.task)
    parentPort?.postMessage({ type: 'result', result })
  } catch (error) {
    parentPort?.postMessage({ type: 'error', error: getErrorMessage(error) })
  }
})
