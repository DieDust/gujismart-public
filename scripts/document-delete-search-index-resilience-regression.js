const fs = require('fs')
const path = require('path')
const assert = require('assert')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label}: unexpected ${needle}`)
  }
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle)
  if (start < 0) throw new Error(`${label}: missing start ${startNeedle}`)
  const end = source.indexOf(endNeedle, start + startNeedle.length)
  if (end < 0) throw new Error(`${label}: missing end ${endNeedle}`)
  return source.slice(start, end)
}

const packageJson = JSON.parse(read('package.json'))
const documentsIpc = read('src/main/ipc/documents.ts')
const database = read('src/main/database.ts')
const libraryStateCache = read('src/main/library-state-cache.ts')
const workerClient = read('src/main/document-delete-worker-client.ts')
const worker = read('src/main/document-delete-worker.ts')
const electronViteConfig = read('electron.vite.config.ts')
const mainIndex = read('src/main/index.ts')
const sharedTypes = read('src/shared/types.ts')
const libraryView = read('src/renderer/src/views/LibraryView.tsx')

const deleteFtsBody = sliceBetween(
  documentsIpc,
  'async function deleteFtsRowsByDocIdsAsync',
  'async function deleteAiChatTurnsByDocIdsAsync',
  'document delete FTS cleanup body',
)
const deleteDataBody = sliceBetween(
  documentsIpc,
  'async function deleteDocumentData',
  'function refreshDeletedDocumentTags',
  'document delete data body',
)
const deleteJobBody = sliceBetween(
  documentsIpc,
  'function scheduleDocumentDeleteJob',
  'function waitForDocumentDeleteShutdown',
  'document delete job body',
)
const markDeletingBody = sliceBetween(
  documentsIpc,
  'function markDocumentsDeleting',
  'function markDocumentsDeleteFailed',
  'document delete marker body',
)
const deleteByIdsBody = sliceBetween(
  documentsIpc,
  'async function deleteDocumentsByIds',
  "ipcMain.handle('documents:savePages'",
  'document delete submission body',
)
const resumeDeleteBody = sliceBetween(
  documentsIpc,
  'export function resumeInterruptedDocumentDeletes',
  'function resolveImportOcrEngine',
  'interrupted document delete recovery body',
)
const fileCleanupBody = sliceBetween(
  documentsIpc,
  'async function cleanupDeletedDocumentFilesInBackground',
  'function scheduleDocumentDeleteJob',
  'document file cleanup body',
)
const resetSearchTablesBody = sliceBetween(
  database,
  'export function resetRebuildableSearchTables',
  'export function refreshSearchSegmentsFtsForDocument',
  'database rebuildable search reset body',
)
const shutdownDeleteBody = sliceBetween(
  documentsIpc,
  'export async function shutdownDocumentDeleteRuntime',
  'class BookTranslationShutdownError',
  'document delete shutdown body',
)

assertIncludes(documentsIpc, 'function isDatabaseMalformedError', 'document deletion should detect SQLite malformed errors')
assertIncludes(documentsIpc, 'formatDocumentDeleteFailureMessage', 'document deletion should explain unrecovered database failures in user-facing text')
assertIncludes(documentsIpc, 'recoverableSearchIndexMalformed', 'delete steps should distinguish recoverable search index corruption from core table failures')
assertIncludes(documentsIpc, 'resetRebuildableSearchTables', 'document deletion should reset rebuildable search tables after a malformed search-index failure')
assertIncludes(documentsIpc, 'queueAllDocumentsReindex', 'document deletion should requeue search indexing after resetting rebuildable indexes')
assertIncludes(deleteDataBody, "runSearchIndexStep('search_ngram_index'", 'legacy ngram cleanup should be treated as rebuildable during delete')
assertIncludes(deleteDataBody, "runSearchIndexStep('fts'", 'FTS cleanup should be treated as rebuildable during delete')
assertIncludes(deleteDataBody, "runSearchIndexStep('search_index_segments'", 'segment index cleanup should be treated as rebuildable during delete')
assertIncludes(deleteDataBody, "runSearchIndexStep('search_index_status'", 'search status cleanup should be treated as rebuildable during delete')
assertIncludes(deleteDataBody, "timeDeleteStepAsync('pages'", 'page rows should remain a core delete step')
assertIncludes(deleteDataBody, "timeDeleteStepAsync('documents'", 'document rows should remain a core delete step')
assertNotIncludes(deleteDataBody, "runSearchIndexStep('pages'", 'page table corruption must not be ignored as a rebuildable index issue')
assertNotIncludes(deleteDataBody, "runSearchIndexStep('documents'", 'document table corruption must not be ignored as a rebuildable index issue')
assertIncludes(deleteFtsBody, "INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)", 'external-content FTS cleanup should use the FTS5 delete command')
assertIncludes(deleteFtsBody, "VALUES ('delete', ?, ?, ?)", 'segment FTS delete should batch by rowid instead of one full-document SELECT')
assertIncludes(deleteFtsBody, "INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)", 'trigram FTS cleanup should use the FTS5 delete command')
assertIncludes(deleteFtsBody, 'DELETE_ROW_CHUNK_SIZE', 'segment FTS cleanup should use the same bounded row chunk size')
assertNotIncludes(deleteFtsBody, 'DELETE FROM search_segments_fts WHERE rowid IN', 'external-content segment FTS should not be cleaned with raw DELETE')
assertNotIncludes(deleteFtsBody, 'DELETE FROM search_segments_trigram WHERE rowid IN', 'external-content trigram FTS should not be cleaned with raw DELETE')
assertIncludes(deleteJobBody, 'if (recoveredSearchIndexIssue)', 'delete job should branch after recovering a rebuildable search-index issue')
assertIncludes(deleteJobBody, 'queueAllDocumentsReindex()', 'delete job should rebuild search indexes for remaining documents after reset')
assertIncludes(deleteJobBody, 'DELETE_DOC_BATCH_SIZE', 'delete job should process documents in small batches so UI IPC can run between them')
assertIncludes(deleteDataBody, "timeDeleteStepAsync('embedding_chunks'", 'vector BLOB rows should be drained in bounded batches before the document cascade')
assertIncludes(deleteDataBody, "timeDeleteStepAsync('embedding_index_status'", 'vector index status should be removed before the document cascade')
assertIncludes(deleteDataBody, "timeDeleteStepAsync('ocr_page_attempts'", 'OCR attempt cascades should be flattened before deleting document rows')
assertIncludes(deleteDataBody, "timeDeleteStepAsync('library_project_documents'", 'project membership cascades should be flattened before deleting document rows')
assertIncludes(deleteJobBody, 'beginDatabaseCheckpointDeferral()', 'delete jobs should suppress automatic checkpoints while bulk writes are active')
assertIncludes(deleteJobBody, 'releaseCheckpointDeferral()', 'delete jobs should release checkpoint suppression after all cleanup finishes')
assertIncludes(markDeletingBody, 'scheduleDatabaseSave()', 'delete marker should defer WAL checkpoint work off the IPC response path')
assertNotIncludes(markDeletingBody, 'saveDatabase()', 'delete marker should not synchronously checkpoint the database')
assertNotIncludes(deleteByIdsBody, 'getDeleteCleanupTasks(', 'delete submission should not inspect every document directory synchronously')
assertNotIncludes(deleteByIdsBody, 'getAffectedTagIdsForDelete(', 'delete submission should not scan tag relations synchronously')
assertIncludes(deleteJobBody, 'getDeleteCleanupTasks', 'background delete job should prepare safe cleanup targets')
assertIncludes(deleteJobBody, 'getAffectedTagIdsForDelete(batch)', 'background delete job should capture affected tags before deleting relations')
assertNotIncludes(documentsIpc, 'scheduleDocumentDeleteJob(existingIds, tagIds)', 'interrupted delete recovery should use the same nonblocking scheduler contract')
assertIncludes(resumeDeleteBody, 'getDocumentsForDeleteRecovery(docIds)', 'interrupted permanent deletion should resume across projects')
assertNotIncludes(resumeDeleteBody, 'getDocumentsForDelete(docIds)', 'interrupted permanent deletion must not depend on the currently selected project')
assertIncludes(fileCleanupBody, 'DELETE_FILE_CLEANUP_CONCURRENCY', 'document file cleanup should use bounded concurrency')
assertIncludes(fileCleanupBody, 'await Promise.all(workers)', 'document file cleanup should wait for its bounded workers')
assertIncludes(electronViteConfig, "'document-delete-worker'", 'production build should emit the document delete worker entry')
assertIncludes(workerClient, "new Worker(workerPath)", 'document deletion should run in a worker thread')
assertIncludes(workerClient, "join(__dirname, 'document-delete-worker.js')", 'worker client should resolve the packaged worker entry')
assertIncludes(deleteJobBody, 'isDocumentDeleteWorkerAvailable()', 'production delete scheduler should select the worker path')
assertIncludes(deleteJobBody, 'runDocumentDeleteWorkerTask({', 'production delete scheduler should submit the complete database task')
assertIncludes(deleteJobBody, 'dbFilePath: getDatabaseFilePath()', 'delete worker should use the active library database')
assertIncludes(worker, "sqlite.prepare(`DELETE FROM documents", 'final document deletion should execute inside the worker')
assertIncludes(worker, "deleteRowsByDocIds(sqlite, 'embedding_chunks'", 'vector cleanup should execute inside the worker')
assertIncludes(worker, 'parentPort?.postMessage({', 'worker should report progress without blocking the main process')
assertIncludes(worker, 'rowid AS delete_rowid', 'worker row drains should use an explicit rowid alias')
assertIncludes(documentsIpc, 'rowid AS delete_rowid', 'compatibility row drains should use an explicit rowid alias')
assertNotIncludes(worker, 'row.rowid', 'worker must not rely on SQLite preserving the rowid result-column name')
assertIncludes(worker, 'const ROW_CHUNK_SIZE = 500', 'worker row drains should bound individual SQLite writer occupancy')
assertIncludes(worker, 'const LARGE_PAYLOAD_ROW_CHUNK_SIZE = 100', 'large vector/OCR payload deletes should use short writer transactions')
assertIncludes(worker, 'const DOCUMENT_BATCH_SIZE = 25', 'worker should amortize relation cleanup across multiple documents')
assertIncludes(worker, "SELECT 'delete', rowid", 'worker should batch FTS delete commands with INSERT-SELECT')
assertNotIncludes(worker, 'function ensureDeleteIndexes', 'normal deletion must not build global indexes while the user is waiting')
assertNotIncludes(worker, 'idx_ocr_artifacts_doc', 'normal deletion must not scan the entire OCR history to add a redundant index')
assertIncludes(worker, 'function deleteOcrData', 'OCR cleanup should follow the indexed OCR run relation')
assertIncludes(worker, "deleteRowsByColumn(sqlite, 'ocr_artifact_versions', 'run_id', runIds)", 'OCR artifacts should drain through the indexed run relation before parent rows')
assertIncludes(worker, "deleteRowsByColumn(sqlite, 'ocr_page_attempts', 'run_id', runIds)", 'OCR attempts should be removed explicitly instead of using unindexed cascades')
assertIncludes(worker, 'function deletePageRowsAfterExplicitCleanup', 'page removal should skip redundant unindexed FK rescans after explicit cleanup')
assertIncludes(worker, "sqlite.pragma('wal_autocheckpoint = 0')", 'the delete worker connection should not run checkpoints on its commit path')
assertIncludes(worker, 'function deleteDocumentRowsAfterExplicitCleanup', 'final document removal should avoid redundant legacy child-table scans')
assertIncludes(worker, "sqlite.pragma('foreign_keys = OFF')", 'final document removal should disable only redundant cascade checks')
assertIncludes(worker, "sqlite.pragma('foreign_keys = ON')", 'foreign-key enforcement must be restored immediately after final document removal')
assertIncludes(worker, 'const INTER_BATCH_WRITER_GRACE_MS = 150', 'bulk deletion should leave a foreground-visible SQLite writer window between document batches')
assertIncludes(worker, 'function waitForForegroundWriter()', 'delete workers should observe foreground writer priority')
assertIncludes(worker, 'foregroundWriterBuffer', 'delete workers should receive shared foreground writer state')
assertIncludes(workerClient, 'getForegroundDatabaseWriterBuffer()', 'delete worker clients should forward foreground writer priority state')
assertIncludes(workerClient, 'options?.onProgress?.({', 'delete worker progress should be forwarded to the main process')
assertIncludes(deleteJobBody, "kind: 'document-delete'", 'delete jobs should publish visible background task progress')
assertIncludes(deleteJobBody, 'onProgress: (progress)', 'worker progress should reach the renderer task stream')
assertIncludes(sharedTypes, "'document-delete'", 'background task types should include document deletion')
assertIncludes(libraryView, "event.kind === 'document-delete'", 'library view should display document delete progress')
assertIncludes(documentsIpc, 'function recordDocumentOpenedInBackground', 'opening a document should defer optional recent-item bookkeeping')
assertIncludes(documentsIpc, 'recordDocumentOpenedInBackground(id)', 'document detail reads should not synchronously acquire a writer lock')
assertNotIncludes(documentsIpc, "run('UPDATE documents SET last_opened_at = ?, updated_at = updated_at WHERE id = ?'", 'document reads must not fail when recent-item bookkeeping cannot acquire the writer')
assert(
  shutdownDeleteBody.indexOf('await shutdownDocumentDeleteWorkers()')
    < shutdownDeleteBody.indexOf('await waitForDocumentDeleteShutdown'),
  'shutdown should terminate delete workers before waiting for queued cleanup',
)
assert(
  mainIndex.indexOf('await shutdownDocumentDeleteRuntime()')
    < mainIndex.indexOf('await shutdownOcrRuntime()'),
  'application shutdown should release delete locks before OCR persists its state',
)
assertIncludes(documentsIpc, 'let documentDeleteJobQueueTail: Promise<void> = Promise.resolve()', 'delete submissions should share one SQLite writer queue')
assertIncludes(deleteJobBody, 'documentDeleteJobQueueTail.then(runQueuedJob, runQueuedJob)', 'delete jobs should run serially')
assertIncludes(deleteJobBody, 'await markDocumentsDeleting(docIds)', 'delete markers should wait inside the serial writer queue')
assertIncludes(deleteJobBody, 'await markLibraryStateCacheDirtyAsync', 'project cache invalidation must wait inside the serial writer queue')
assertNotIncludes(deleteByIdsBody, 'markDocumentsDeleting(submittedIds)', 'delete IPC should not compete with an active worker for SQLite write lock')
assertNotIncludes(deleteByIdsBody, 'markLibraryStateCacheDirty()', 'delete IPC must not write project caches before entering the serial queue')
assertIncludes(deleteByIdsBody, 'await getDocumentsForDelete(docIds, libraryProjectId)', 'delete submission reads should use the captured project and nonblocking path')
assertIncludes(documentsIpc, 'queryAllAsync<DocumentFileRow>', 'delete submission reads should retry SQLite busy errors asynchronously')
assertIncludes(documentsIpc, 'runAsync(', 'delete markers should use nonblocking SQLite busy retries')
assertIncludes(libraryStateCache, 'export async function markLibraryStateCacheDirtyAsync', 'library cache should expose a nonblocking invalidation helper')
assertIncludes(libraryStateCache, 'await runAsync(', 'async cache invalidation should retry SQLite busy errors without blocking Electron')
assertNotIncludes(deleteJobBody, 'await deleteDocumentData(batch)\n            await yieldToEventLoop()', 'production path must not rely only on yielding between synchronous SQL calls')

assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_segments_trigram', 'reset should drop trigram FTS')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_segments_fts', 'reset should drop segment FTS')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS pages_fts', 'reset should drop page FTS')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_ngram_index', 'reset should drop legacy ngram index')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_index_segments', 'reset should drop segment index')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_index_status', 'reset should drop index status')
assertIncludes(resetSearchTablesBody, 'CREATE TABLE IF NOT EXISTS search_index_segments', 'reset should recreate segment index schema')
assertIncludes(resetSearchTablesBody, 'CREATE TABLE IF NOT EXISTS search_index_status', 'reset should recreate status schema')
assertIncludes(resetSearchTablesBody, 'ensureIndexes(database)', 'reset should recreate normal indexes')
assertIncludes(resetSearchTablesBody, 'ensureFts(database)', 'reset should recreate FTS tables')
assertIncludes(resetSearchTablesBody, 'rebuildFts(database)', 'reset should repopulate page FTS before background segment rebuild catches up')

if (packageJson.scripts['check:document-delete-resilience'] !== 'node scripts/document-delete-search-index-resilience-regression.js && electron scripts/document-delete-worker-integration-regression.js') {
  throw new Error('package.json is missing check:document-delete-resilience')
}
if (!String(packageJson.scripts.check || '').includes('check:document-delete-resilience')) {
  throw new Error('npm run check does not include check:document-delete-resilience')
}

console.log('Document delete search-index resilience regression checks passed')
